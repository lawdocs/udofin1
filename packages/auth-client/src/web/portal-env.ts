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
    /** Trust X-Forwarded-For (only behind a reverse proxy you control). */
    TRUST_PROXY: bool.default(false),
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
    if (production && env.COOKIE_SECURE === false && !loopback(env.PORTAL_ORIGIN)) {
      ctx.addIssue({
        code: 'custom',
        path: ['COOKIE_SECURE'],
        message: 'must not be disabled in production',
      });
    }
  });

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
    clientIp: (request) => {
      if (!cfg.TRUST_PROXY) return 'direct';
      return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
    },
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
  return { handlers, apiBaseUrl: cfg.API_BASE_URL.replace(/\/$/, ''), portalOrigin };
}
