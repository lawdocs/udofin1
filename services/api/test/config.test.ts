import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('applies safe local defaults', () => {
    const config = loadConfig({});
    expect(config.APP_ENV).toBe('local');
    expect(config.PORT).toBe(8080);
    expect(config.CORS_ALLOWED_ORIGINS).toEqual([]);
  });

  it('requires database and auth settings when deployed', () => {
    expect(() => loadConfig({ APP_ENV: 'production' })).toThrow(
      /DATABASE_URL: required when deployed/,
    );
    expect(() => loadConfig({ APP_ENV: 'staging' })).toThrow(
      /SUPABASE_URL: required when deployed/,
    );
  });

  it('rejects wildcard and plain-http origins when deployed', () => {
    const base = {
      APP_ENV: 'production',
      DATABASE_URL: 'postgres://api@db.example.internal:5432/udofin?sslmode=require',
      SUPABASE_URL: 'https://example.supabase.co',
    };
    expect(() => loadConfig({ ...base, CORS_ALLOWED_ORIGINS: '*' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, CORS_ALLOWED_ORIGINS: 'http://ops.udofin.com' })).toThrow(
      ConfigError,
    );
    expect(
      loadConfig({
        ...base,
        CORS_ALLOWED_ORIGINS: 'https://ops.udofin.com, https://lenders.udofin.com',
      }).CORS_ALLOWED_ORIGINS,
    ).toEqual(['https://ops.udofin.com', 'https://lenders.udofin.com']);
  });

  it('never echoes configuration values in errors', () => {
    const secret = 'postgres://api:SuperSecretPassw0rd@db:5432/x';
    try {
      loadConfig({ APP_ENV: 'production', DATABASE_URL: secret, PORT: 'not-a-port' });
      expect.fail('should have thrown');
    } catch (error) {
      expect(String(error)).not.toContain('SuperSecretPassw0rd');
    }
  });

  it('fails closed when a production build does not say which environment it is', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/APP_ENV: required/);
    expect(loadConfig({ NODE_ENV: 'production', APP_ENV: 'test' }).APP_ENV).toBe('test');
  });

  it('requires TLS to Postgres and https to Supabase when deployed', () => {
    const ok = {
      APP_ENV: 'production',
      DATABASE_URL: 'postgres://api@db.example.internal:5432/udofin?sslmode=verify-full',
      SUPABASE_URL: 'https://example.supabase.co',
    };
    expect(loadConfig(ok).APP_ENV).toBe('production');
    expect(() =>
      loadConfig({ ...ok, DATABASE_URL: 'postgres://api@db.example.internal:5432/udofin' }),
    ).toThrow(/enforce TLS/);
    expect(() =>
      loadConfig({ ...ok, DATABASE_URL: 'postgres://api@db/x?sslmode=disable' }),
    ).toThrow(/enforce TLS/);
    expect(() => loadConfig({ ...ok, SUPABASE_URL: 'http://example.supabase.co' })).toThrow(
      /https/,
    );
  });

  it('trusts no proxy hop unless told to', () => {
    expect(loadConfig({}).TRUST_PROXY_HOPS).toBe(0);
  });
});
