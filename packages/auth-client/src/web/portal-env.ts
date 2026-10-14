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
 * leftmost entries are whatever the client claimed). Returns `direct` (no trusted proxy configured) or
 * `unknown` (header missing or malformed) when there is no usable address; those placeholders are never
 * rate-limit keys (see UNATTRIBUTED_ADDRESSES).
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
  deps: { fetch?: typeof fetch; warn?: (message: string) => void } = {},
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
  // Start-up warnings (stderr as JSON; silent under test runners unless a sink is injected).
  const warn =
    deps.warn ??
    ((message: string) => {
      if (env.NODE_ENV !== 'test' && process.env.NODE_ENV !== 'test') {
        process.stderr.write(`${JSON.stringify({ level: 'warn', msg: message })}\n`);
      }
    });
  warn(
    'portal sign-in rate limits are in memory and per process: run exactly ONE portal instance until a shared store is approved (docs/auth/README.md)',
  );
  if (cfg.TRUSTED_PROXY_HOPS < 1) {
    warn(
      'TRUSTED_PROXY_HOPS=0: the client address cannot be determined, so per-address sign-in limits are off; only per-account and global ceilings apply',
    );
  }
  let warnedUnattributed = false;
  const handlers = createAuthHandlers({
    gotrue,
    allowedOrigin: portalOrigin,
    secureCookies: secure,
    audience,
    apiBaseUrl: cfg.API_BASE_URL,
    rateLimiter: createMemoryRateLimiter(),
    clientIp: (request) =>
      clientAddress(request.headers.get('x-forwarded-for'), cfg.TRUSTED_PROXY_HOPS),
    onUnattributedAddress: () => {
      // Behind a configured proxy a missing or malformed address means the proxy chain is not what
      // TRUSTED_PROXY_HOPS says. Say so once instead of silently degrading.
      if (cfg.TRUSTED_PROXY_HOPS >= 1 && !warnedUnattributed) {
        warnedUnattributed = true;
        warn(
          'a request had no usable client address behind the configured proxy; check TRUSTED_PROXY_HOPS and the proxy X-Forwarded-For handling. Per-address limits are skipped for such requests',
        );
      }
    },
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
  return { handlers, apiBaseUrl: cfg.API_BASE_URL.replace(/\/$/, ''), portalOrigin };
}
