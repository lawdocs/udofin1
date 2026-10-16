import { assertPublishableKey } from '@udofin/auth-client';
import { z } from 'zod';

/**
 * Public, build-time configuration. Everything in an Expo app bundle can be read by anyone who has the
 * app, so ONLY public values belong here: the API address, the Supabase URL and the PUBLISHABLE key.
 * A service/secret key is refused at start-up. (Rule: apps/mobile never holds privileged keys.)
 */
export interface MobileConfig {
  appEnv: 'local' | 'staging' | 'production';
  apiBaseUrl: string;
  supabaseUrl: string;
  supabasePublishableKey: string;
}

const Schema = z.object({
  appEnv: z.enum(['local', 'staging', 'production']),
  apiBaseUrl: z.url(),
  supabaseUrl: z.url(),
  supabasePublishableKey: z.string().min(20),
});

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

const LOOPBACK = ['localhost', '127.0.0.1', '10.0.2.2']; // 10.0.2.2 = host machine from the Android emulator

export function parseMobileConfig(raw: Record<string, string | undefined>): MobileConfig {
  const parsed = Schema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(
      `Invalid app configuration: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`,
    );
  }
  const config = parsed.data;
  try {
    assertPublishableKey(config.supabasePublishableKey);
  } catch (error) {
    throw new ConfigError(error instanceof Error ? error.message : 'invalid key');
  }
  if (config.appEnv !== 'local') {
    for (const [name, value] of [
      ['apiBaseUrl', config.apiBaseUrl],
      ['supabaseUrl', config.supabaseUrl],
    ] as const) {
      if (!value.startsWith('https://') && !LOOPBACK.includes(new URL(value).hostname)) {
        throw new ConfigError(`${name} must use https outside local development`);
      }
    }
  }
  if (
    config.appEnv === 'production' &&
    [config.apiBaseUrl, config.supabaseUrl].some((u) => LOOPBACK.includes(new URL(u).hostname))
  ) {
    throw new ConfigError('production builds cannot point at a local address');
  }
  return config;
}

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

/** Metro inlines `process.env.EXPO_PUBLIC_*` only when written literally, hence the explicit reads. */
export function loadMobileConfig(appEnv: string): MobileConfig {
  return parseMobileConfig({
    appEnv,
    apiBaseUrl: asString(process.env.EXPO_PUBLIC_API_BASE_URL),
    supabaseUrl: asString(process.env.EXPO_PUBLIC_SUPABASE_URL),
    supabasePublishableKey: asString(process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY),
  });
}
