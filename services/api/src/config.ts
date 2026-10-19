import { parseHandoffKeyring } from '@udofin/adapters';
import { z } from 'zod';

/**
 * All runtime configuration comes from environment variables, validated once at start-up.
 * The service refuses to start on invalid configuration rather than limping along with defaults
 * that are unsafe in production.
 */
const csv = z
  .string()
  .default('')
  .transform((value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );

const ConfigSchema = z
  .object({
    APP_ENV: z.enum(['local', 'test', 'staging', 'production']).default('local'),
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    /** Postgres connection string for the API's restricted database role. */
    DATABASE_URL: z.url().optional(),
    /** Postgres connection string for the system login (workers, change-request application). Optional until used. */
    SYSTEM_DATABASE_URL: z.url().optional(),
    /** Supabase project URL; used to derive the JWKS endpoint for verifying access tokens. */
    SUPABASE_URL: z.url().optional(),
    /** Browser origins allowed to call the API (the two portals). Mobile apps do not use CORS. */
    CORS_ALLOWED_ORIGINS: csv,
    /**
     * Number of trusted reverse-proxy hops in front of the API (client IP resolution). 0 trusts none.
     * REQUIRED when deployed (no silent default): behind a load balancer a wrong value makes every client
     * share one rate-limit bucket, or lets a client choose its own address. Defaults to 0 in local and test.
     */
    TRUST_PROXY_HOPS: z.preprocess(
      (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
      z.coerce.number().int().min(0).max(5).optional(),
    ),
    /** Requests per minute per client address, applied to every route before authentication. */
    RATE_LIMIT_MAX_PER_MINUTE: z.coerce.number().int().min(1).default(120),
    /** Requests per minute per VERIFIED principal (user id) across all authenticated routes. */
    RATE_LIMIT_PRINCIPAL_MAX_PER_MINUTE: z.coerce.number().int().min(1).default(600),
    /** Directory for the development-only document store (unencrypted files). Refused when deployed. */
    LOCAL_DOCUMENT_DIR: z.string().min(1).optional(),
    /** SMS provider adapter. `none` refuses to send; `mock` records messages in memory (local and tests only). */
    SMS_PROVIDER: z.enum(['none', 'mock']).default('none'),
    /** Electronic-signing provider. `none`: signing is unavailable (no provider is approved, D-13/D-58). `mock`: local and tests only. */
    SIGNING_PROVIDER: z.enum(['none', 'mock']).default('none'),
    /** Device-integrity verifier. `none` reports "unavailable"; `mock` is local and tests only. */
    INTEGRITY_PROVIDER: z.enum(['none', 'mock']).default('none'),
    /** Server secret that keys the hash of step-up codes. Required to start a step-up challenge. */
    STEPUP_OTP_PEPPER: z.string().min(32).optional(),
    /** Signing secret of the Supabase "Send SMS" auth hook (Standard Webhooks format, v1,whsec_...). */
    SEND_SMS_HOOK_SECRET: z.string().min(16).optional(),
    /**
     * Phase 08a: keys that seal provider hand-off links (payment checkout, mandate authorisation) before they rest in the database.
     * A JSON object of key version to base64 key (32 bytes), from a secrets manager. The worker seals with the active version; the
     * API opens any listed version. Without them no link can be created or shown (the routes answer 503 handoff_unavailable).
     */
    HANDOFF_ENCRYPTION_KEYS: z.string().min(1).optional(),
    /** The key version used to seal new links; must be a key in HANDOFF_ENCRYPTION_KEYS. */
    HANDOFF_ACTIVE_KEY_VERSION: z.string().min(1).optional(),
  })
  .superRefine((config, ctx) => {
    const deployed = config.APP_ENV === 'staging' || config.APP_ENV === 'production';
    if (
      deployed &&
      (config.SMS_PROVIDER === 'mock' ||
        config.INTEGRITY_PROVIDER === 'mock' ||
        config.SIGNING_PROVIDER === 'mock')
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['SMS_PROVIDER'],
        message: 'mock providers are for local development and tests only',
      });
    }
    try {
      parseHandoffKeyring(config.HANDOFF_ENCRYPTION_KEYS, config.HANDOFF_ACTIVE_KEY_VERSION);
    } catch {
      // The message never echoes a key.
      ctx.addIssue({
        code: 'custom',
        path: ['HANDOFF_ENCRYPTION_KEYS'],
        message:
          'must be a JSON object of key version to base64 32-byte key, with HANDOFF_ACTIVE_KEY_VERSION naming one of them',
      });
    }
    if (deployed && config.LOCAL_DOCUMENT_DIR) {
      ctx.addIssue({
        code: 'custom',
        path: ['LOCAL_DOCUMENT_DIR'],
        message: 'the local document store is for development only',
      });
    }
    if (deployed && config.TRUST_PROXY_HOPS === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['TRUST_PROXY_HOPS'],
        message:
          'required when deployed (set the number of trusted proxy hops in front of the API; 0 only if it is directly exposed)',
      });
    }
    if (deployed && !config.DATABASE_URL) {
      ctx.addIssue({ code: 'custom', path: ['DATABASE_URL'], message: 'required when deployed' });
    }
    if (deployed && !config.SUPABASE_URL) {
      ctx.addIssue({ code: 'custom', path: ['SUPABASE_URL'], message: 'required when deployed' });
    }
    if (config.APP_ENV === 'production' && config.LOG_LEVEL === 'trace') {
      ctx.addIssue({
        code: 'custom',
        path: ['LOG_LEVEL'],
        message: 'trace is not allowed in production',
      });
    }
    if (deployed && config.DATABASE_URL && !/^postgres(ql)?:\/\//.test(config.DATABASE_URL)) {
      ctx.addIssue({
        code: 'custom',
        path: ['DATABASE_URL'],
        message: 'must be a postgres:// URL',
      });
    }
    for (const key of ['DATABASE_URL', 'SYSTEM_DATABASE_URL'] as const) {
      const value = config[key];
      if (deployed && value && !/[?&]sslmode=(require|verify-ca|verify-full)(&|$)/.test(value)) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: 'must enforce TLS (sslmode=require, verify-ca or verify-full) when deployed',
        });
      }
    }
    if (config.SYSTEM_DATABASE_URL && config.SYSTEM_DATABASE_URL === config.DATABASE_URL) {
      ctx.addIssue({
        code: 'custom',
        path: ['SYSTEM_DATABASE_URL'],
        message: 'must differ from DATABASE_URL (separate logins for user and system work)',
      });
    }
    if (deployed && config.SUPABASE_URL && !config.SUPABASE_URL.startsWith('https://')) {
      ctx.addIssue({
        code: 'custom',
        path: ['SUPABASE_URL'],
        message: 'must be https when deployed',
      });
    }
    for (const origin of config.CORS_ALLOWED_ORIGINS) {
      if (origin === '*' || (deployed && !origin.startsWith('https://'))) {
        ctx.addIssue({
          code: 'custom',
          path: ['CORS_ALLOWED_ORIGINS'],
          message: `origin "${origin}" is not allowed (no wildcards; https only when deployed)`,
        });
      }
    }
  });

export type AppConfig = z.infer<typeof ConfigSchema> & { TRUST_PROXY_HOPS: number };

/**
 * Whether an access token WITHOUT a `session_id` claim is refused. Supabase Auth always issues the claim,
 * so a deployed API treats its absence as an invalid token (it could not be checked for sign-out or
 * revocation). Local and test environments accept it so fake verifiers in tests keep working. This is
 * an explicit, tested decision, not an accident of the default: see `docs/auth/README.md`.
 */
export function sessionIdRequired(config: Pick<AppConfig, 'APP_ENV'>): boolean {
  return config.APP_ENV === 'staging' || config.APP_ENV === 'production';
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/** Validates the environment. Error messages name the variables but never echo their values. */
export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  // Fail closed: a production-built process (NODE_ENV=production) must say which environment it is,
  // otherwise every deployed-only guard below would silently be skipped by the 'local' default.
  if (env.NODE_ENV === 'production' && !env.APP_ENV) {
    throw new ConfigError('Invalid configuration:\n  - APP_ENV: required when NODE_ENV=production');
  }
  const result = ConfigSchema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map(
      (issue) => `${issue.path.join('.')}: ${issue.message}`,
    );
    throw new ConfigError(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
  }
  return { ...result.data, TRUST_PROXY_HOPS: result.data.TRUST_PROXY_HOPS ?? 0 };
}

/** The hand-off keyring, or undefined when none is configured (validated by loadConfig). */
export function handoffKeyringOf(
  config: Pick<AppConfig, 'HANDOFF_ENCRYPTION_KEYS' | 'HANDOFF_ACTIVE_KEY_VERSION'>,
): ReturnType<typeof parseHandoffKeyring> {
  return parseHandoffKeyring(config.HANDOFF_ENCRYPTION_KEYS, config.HANDOFF_ACTIVE_KEY_VERSION);
}
