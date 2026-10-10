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
    /** Supabase project URL; used to derive the JWKS endpoint for verifying access tokens. */
    SUPABASE_URL: z.url().optional(),
    /** Browser origins allowed to call the API (the two portals). Mobile apps do not use CORS. */
    CORS_ALLOWED_ORIGINS: csv,
    /** Number of trusted reverse-proxy hops in front of the API (for client IP resolution). */
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),
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
  const result = ConfigSchema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map(
      (issue) => `${issue.path.join('.')}: ${issue.message}`,
    );
    throw new ConfigError(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
  }
  return result.data;
}
