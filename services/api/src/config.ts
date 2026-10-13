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
    /** Number of trusted reverse-proxy hops in front of the API (client IP resolution). 0 trusts none. */
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
    RATE_LIMIT_MAX_PER_MINUTE: z.coerce.number().int().min(1).default(120),
  })
  .superRefine((config, ctx) => {
    const deployed = config.APP_ENV === 'staging' || config.APP_ENV === 'production';
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

export type AppConfig = z.infer<typeof ConfigSchema>;

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
  return result.data;
}
