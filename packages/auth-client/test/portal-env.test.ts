import { describe, expect, it } from 'vitest';
import { PortalConfigError, createPortalAuth } from '../src/web/portal-env.js';
import { jwt } from './helpers.js';

const good = {
  SUPABASE_URL: 'https://proj.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_0123456789abcdef',
  API_BASE_URL: 'https://api.udofin.example',
  PORTAL_ORIGIN: 'https://ops.udofin.example',
};
const attempt = (over: Record<string, string | undefined>) => () =>
  createPortalAuth({ ...good, ...over }, 'platform');

describe('portal configuration', () => {
  it('accepts a complete configuration', () => {
    const auth = createPortalAuth({ ...good, NODE_ENV: 'production' }, 'platform');
    expect(auth.portalOrigin).toBe('https://ops.udofin.example');
    expect(auth.handlers.names.access).toBe('__Host-udofin_at');
  });

  it('fails closed on missing values, naming the variable but never its value', () => {
    expect(attempt({ SUPABASE_URL: undefined })).toThrow(PortalConfigError);
    try {
      attempt({ API_BASE_URL: 'not-a-url-secretvalue' })();
    } catch (error) {
      expect(String(error)).toContain('API_BASE_URL');
      expect(String(error)).not.toContain('secretvalue');
    }
  });

  it('refuses privileged Supabase keys', () => {
    expect(attempt({ SUPABASE_PUBLISHABLE_KEY: 'sb_secret_0123456789abcdef' })).toThrow(
      /secret key/,
    );
    expect(attempt({ SUPABASE_PUBLISHABLE_KEY: jwt({ role: 'service_role' }) })).toThrow(
      /service_role/,
    );
  });

  it('requires https and secure cookies in production', () => {
    expect(attempt({ NODE_ENV: 'production', PORTAL_ORIGIN: 'http://ops.udofin.example' })).toThrow(
      /https/,
    );
    expect(attempt({ NODE_ENV: 'production', COOKIE_SECURE: 'false' })).toThrow(/COOKIE_SECURE/);
    expect(
      attempt({
        NODE_ENV: 'development',
        PORTAL_ORIGIN: 'http://localhost:3001',
        SUPABASE_URL: 'http://127.0.0.1:54321',
      }),
    ).not.toThrow();
  });

  it('rejects an origin with a path', () => {
    expect(attempt({ PORTAL_ORIGIN: 'https://ops.udofin.example/app' })).toThrow(/path/);
  });
});
