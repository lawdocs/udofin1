import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { ConfigError, handoffKeyringOf, loadConfig, sessionIdRequired } from '../src/config.js';

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

  it('treats a blank or whitespace-only TRUST_PROXY_HOPS as missing when deployed (review SEC-3)', () => {
    const base = {
      APP_ENV: 'production',
      DATABASE_URL: 'postgres://api@db.example.internal:5432/udofin?sslmode=require',
      SUPABASE_URL: 'https://example.supabase.co',
      CORS_ALLOWED_ORIGINS: 'https://ops.udofin.com',
    };
    for (const blank of ['', ' ', '   ', '\t']) {
      expect(() => loadConfig({ ...base, TRUST_PROXY_HOPS: blank })).toThrow(/TRUST_PROXY_HOPS/);
    }
    expect(loadConfig({ ...base, TRUST_PROXY_HOPS: '1' }).TRUST_PROXY_HOPS).toBe(1);
  });

  it('rejects wildcard and plain-http origins when deployed', () => {
    const base = {
      APP_ENV: 'production',
      DATABASE_URL: 'postgres://api@db.example.internal:5432/udofin?sslmode=require',
      SUPABASE_URL: 'https://example.supabase.co',
      TRUST_PROXY_HOPS: '1',
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
      TRUST_PROXY_HOPS: '1',
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

  it('trusts no proxy hop unless told to (local and test only)', () => {
    expect(loadConfig({}).TRUST_PROXY_HOPS).toBe(0);
    expect(loadConfig({ APP_ENV: 'test' }).TRUST_PROXY_HOPS).toBe(0);
    expect(loadConfig({ TRUST_PROXY_HOPS: '2' }).TRUST_PROXY_HOPS).toBe(2);
  });

  describe('TRUST_PROXY_HOPS when deployed (audit R-02)', () => {
    const base = {
      DATABASE_URL: 'postgres://api@db.example.internal:5432/udofin?sslmode=require',
      SUPABASE_URL: 'https://example.supabase.co',
    };
    it.each(['staging', 'production'])('is required in %s, naming the variable', (APP_ENV) => {
      expect(() => loadConfig({ ...base, APP_ENV })).toThrow(
        /TRUST_PROXY_HOPS: required when deployed/,
      );
      // An empty value is "not set", never a silent zero.
      expect(() => loadConfig({ ...base, APP_ENV, TRUST_PROXY_HOPS: '' })).toThrow(
        /TRUST_PROXY_HOPS: required when deployed/,
      );
    });
    it('accepts an explicit value, including 0 for a directly exposed service', () => {
      expect(
        loadConfig({ ...base, APP_ENV: 'production', TRUST_PROXY_HOPS: '1' }).TRUST_PROXY_HOPS,
      ).toBe(1);
      expect(
        loadConfig({ ...base, APP_ENV: 'staging', TRUST_PROXY_HOPS: '0' }).TRUST_PROXY_HOPS,
      ).toBe(0);
    });
    it('rejects values that are not a small whole number', () => {
      for (const bad of ['-1', '9', 'two', '1.5']) {
        expect(() => loadConfig({ ...base, APP_ENV: 'production', TRUST_PROXY_HOPS: bad })).toThrow(
          /TRUST_PROXY_HOPS/,
        );
      }
    });
  });

  it('sets a per-principal rate limit separate from the per-address one', () => {
    const config = loadConfig({});
    expect(config.RATE_LIMIT_PRINCIPAL_MAX_PER_MINUTE).toBe(600);
    expect(
      loadConfig({ RATE_LIMIT_PRINCIPAL_MAX_PER_MINUTE: '50' }).RATE_LIMIT_PRINCIPAL_MAX_PER_MINUTE,
    ).toBe(50);
    expect(() => loadConfig({ RATE_LIMIT_PRINCIPAL_MAX_PER_MINUTE: '0' })).toThrow(
      /RATE_LIMIT_PRINCIPAL_MAX_PER_MINUTE/,
    );
  });

  it('requires a session id in access tokens when deployed, and tolerates its absence only in local and test (audit F-01)', () => {
    expect(sessionIdRequired({ APP_ENV: 'production' })).toBe(true);
    expect(sessionIdRequired({ APP_ENV: 'staging' })).toBe(true);
    expect(sessionIdRequired({ APP_ENV: 'local' })).toBe(false);
    expect(sessionIdRequired({ APP_ENV: 'test' })).toBe(false);
  });
});

describe('hand-off link keys (Phase 08a)', () => {
  const key = randomBytes(32).toString('base64');

  it('are optional: without them no link can be created or shown', () => {
    expect(handoffKeyringOf(loadConfig({}))).toBeUndefined();
  });

  it('accept a JSON object of key versions and an active version', () => {
    const config = loadConfig({
      HANDOFF_ENCRYPTION_KEYS: JSON.stringify({ v1: key }),
      HANDOFF_ACTIVE_KEY_VERSION: 'v1',
    });
    expect(handoffKeyringOf(config)?.activeVersion).toBe('v1');
  });

  it('refuse half a configuration, a short key and an unknown active version, without echoing the key', () => {
    const bad = [
      { HANDOFF_ENCRYPTION_KEYS: JSON.stringify({ v1: key }) },
      { HANDOFF_ACTIVE_KEY_VERSION: 'v1' },
      {
        HANDOFF_ENCRYPTION_KEYS: JSON.stringify({ v1: key.slice(0, 20) }),
        HANDOFF_ACTIVE_KEY_VERSION: 'v1',
      },
      { HANDOFF_ENCRYPTION_KEYS: JSON.stringify({ v1: key }), HANDOFF_ACTIVE_KEY_VERSION: 'v2' },
      { HANDOFF_ENCRYPTION_KEYS: 'not json', HANDOFF_ACTIVE_KEY_VERSION: 'v1' },
    ];
    for (const env of bad) {
      let message = '';
      try {
        loadConfig(env);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/HANDOFF_ENCRYPTION_KEYS/);
      expect(message).not.toContain(key.slice(0, 20));
    }
  });
});
