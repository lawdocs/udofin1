import { describe, expect, it } from 'vitest';
import { ConfigError, parseMobileConfig } from '../src/config/env';

const good = {
  appEnv: 'staging',
  apiBaseUrl: 'https://api.staging.udofin.example',
  supabaseUrl: 'https://proj.supabase.co',
  supabasePublishableKey: 'sb_publishable_0123456789abcdef',
};
const jwt = (claims: object) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;

describe('mobile configuration', () => {
  it('accepts a complete public configuration', () => {
    expect(parseMobileConfig(good).appEnv).toBe('staging');
  });

  it('refuses missing values without echoing them', () => {
    expect(() => parseMobileConfig({ ...good, apiBaseUrl: undefined })).toThrow(ConfigError);
    try {
      parseMobileConfig({ ...good, supabaseUrl: 'not a url secret-ish' });
    } catch (error) {
      expect(String(error)).not.toContain('secret-ish');
    }
  });

  it('refuses privileged Supabase keys so they can never ship in a bundle', () => {
    expect(() =>
      parseMobileConfig({ ...good, supabasePublishableKey: 'sb_secret_0123456789abcdef' }),
    ).toThrow(ConfigError);
    expect(() =>
      parseMobileConfig({ ...good, supabasePublishableKey: jwt({ role: 'service_role' }) }),
    ).toThrow(ConfigError);
  });

  it('requires https outside local development, and forbids local addresses in production', () => {
    expect(() => parseMobileConfig({ ...good, apiBaseUrl: 'http://api.example.in' })).toThrow(
      /https/,
    );
    expect(
      parseMobileConfig({
        ...good,
        appEnv: 'local',
        apiBaseUrl: 'http://10.0.2.2:8080',
        supabaseUrl: 'http://10.0.2.2:54321',
      }).appEnv,
    ).toBe('local');
    expect(() =>
      parseMobileConfig({ ...good, appEnv: 'production', apiBaseUrl: 'http://localhost:8080' }),
    ).toThrow(ConfigError);
    expect(() =>
      parseMobileConfig({ ...good, appEnv: 'production', supabaseUrl: 'https://localhost' }),
    ).toThrow(/local address/);
  });
});
