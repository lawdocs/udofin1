import { z } from 'zod';
import { createGoTrueClient } from '../gotrue.js';
import { createAuthHandlers, type AuthHandlers, type PortalAudience } from './bff.js';
import { createMemoryRateLimiter } from './rate-limiter.js';

/**
 * Server-only configuration of a portal. Validated once at start-up so a missing or unsafe value
 * stops the server instead of failing on the first sign-in. Values are never echoed in errors.
 */
const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const PortalEnvSchema = z
  .object({
    NODE_ENV: z.string().optional(),
    SUPABASE_URL: z.url(),
    /** The PUBLISHABLE key. A service/secret key is refused. */
    SUPABASE_PUBLISHABLE_KEY: z.string().min(20),
    API_BASE_URL: z.url(),
    /** This portal's own public origin, e.g. https://ops.example.in (scheme and host, no path). */
    PORTAL_ORIGIN: z.url(),
    COOKIE_SECURE: bool.optional(),
    /**
     * Number of reverse proxies you control in front of the portal (0 = none). The client address is
     * taken from X-Forwarded-For counting from the RIGHT, so entries a client forges are ignored.
     */
    TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  })
  .superRefine((env, ctx) => {
    const production = env.NODE_ENV === 'production';
    // Plain http is tolerated only for loopback addresses (local development and browser tests):
    // traffic to those never leaves the machine.
    const loopback = (value: string) =>
      ['localhost', '127.0.0.1', '[::1]'].includes(new URL(value).hostname);
    for (const key of ['SUPABASE_URL', 'API_BASE_URL', 'PORTAL_ORIGIN'] as const) {
      if (production && !env[key].startsWith('https://') && !loopback(env[key])) {
        ctx.addIssue({ code: 'custom', path: [key], message: 'must be https in production' });
      }
    }
    if (new URL(env.PORTAL_ORIGIN).pathname !== '/') {
      ctx.addIssue({ code: 'custom', path: ['PORTAL_ORIGIN'], message: 'must not include a path' });
    }
    if (production && env.TRUSTED_PROXY_HOPS < 1 && !loopback(env.PORTAL_ORIGIN)) {
      ctx.addIssue({
        code: 'custom',
        path: ['TRUSTED_PROXY_HOPS'],
        message:
          'must be at least 1 in production (otherwise every visitor shares one rate-limit bucket)',
      });
    }
    if (production && env.COOKIE_SECURE === false && !loopback(env.PORTAL_ORIGIN)) {
      ctx.addIssue({
        code: 'custom',
        path: ['COOKIE_SECURE'],
        message: 'must not be disabled in production',
      });
    }
  });

/** Plausible IPv4/IPv6 text only; anything else is not used as a rate-limit key. */
const ADDRESS = /^[0-9a-fA-F:.]{2,45}$/;

/**
 * The client address as seen by the trusted proxy nearest the portal: the entry `hops` places from the
 * right of X-Forwarded-For (each proxy appends the address it received the request from, so the
 * leftmost entries are whatever the client claimed).
 */
export function clientAddress(forwardedFor: string | null, hops: number): string {
  if (hops < 1) return 'direct';
  const entries = (forwardedFor ?? '')
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);
  const candidate = entries[entries.length - hops];
  return candidate && ADDRESS.test(candidate) ? candidate : 'unknown';
}

export class PortalConfigError extends Error {
  override readonly name = 'PortalConfigError';
}

export interface PortalAuth {
  handlers: AuthHandlers;
  apiBaseUrl: string;
  portalOrigin: string;
}

export function createPortalAuth(
  env: Record<string, string | undefined>,
  audience: PortalAudience,
  deps: { fetch?: typeof fetch } = {},
): PortalAuth {
  const parsed = PortalEnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new PortalConfigError(`Invalid portal configuration:\n  - ${problems.join('\n  - ')}`);
  }
  const cfg = parsed.data;
  const portalOrigin = new URL(cfg.PORTAL_ORIGIN).origin;
  const secure = cfg.COOKIE_SECURE ?? portalOrigin.startsWith('https://');
  let gotrue;
  try {
    gotrue = createGoTrueClient({
      baseUrl: cfg.SUPABASE_URL,
      publishableKey: cfg.SUPABASE_PUBLISHABLE_KEY,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    });
  } catch (error) {
    throw new PortalConfigError(error instanceof Error ? error.message : 'invalid Supabase key');
  }
  const handlers = createAuthHandlers({
    gotrue,
    allowedOrigin: portalOrigin,
    secureCookies: secure,
    audience,
    apiBaseUrl: cfg.API_BASE_URL,
    rateLimiter: createMemoryRateLimiter(),
    clientIp: (request) =>
      clientAddress(request.headers.get('x-forwarded-for'), cfg.TRUSTED_PROXY_HOPS),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
  return { handlers, apiBaseUrl: cfg.API_BASE_URL.replace(/\/$/, ''), portalOrigin };
}
