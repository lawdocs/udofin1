import { describe, expect, it } from 'vitest';
import {
  AuthFailure,
  base64UrlToString,
  createGoTrueClient,
  readTokenClaims,
} from '../src/gotrue.js';
import { accessToken, fakeFetch, ok, USER_ID } from './helpers.js';

const BASE = 'https://proj.supabase.co';
const client = (routes: Parameters<typeof fakeFetch>[0]) => {
  const f = fakeFetch(routes);
  return {
    f,
    gotrue: createGoTrueClient({
      baseUrl: BASE,
      publishableKey: 'sb_publishable_test',
      fetch: f.fetch,
    }),
  };
};
const sessionJson = (aal: 'aal1' | 'aal2' = 'aal1') => ({
  access_token: accessToken({ aal }),
  refresh_token: 'r1',
  expires_at: 2_000_000_000,
  user: { id: USER_ID },
});
const code = async (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: unknown) => (e instanceof AuthFailure ? e.code : 'other'),
  );

describe('GoTrue client', () => {
  it('signs in with the publishable key only and returns a session with its assurance level', async () => {
    const { f, gotrue } = client({
      'POST /auth/v1/token?grant_type=password': () => ok(sessionJson('aal1')),
    });
    const session = await gotrue.signInWithPassword('a@b.example', 'pw');
    expect(session).toMatchObject({
      userId: USER_ID,
      aal: 'aal1',
      expiresAt: 2_000_000_000,
      refreshToken: 'r1',
    });
    expect(f.calls[0]?.headers.apikey).toBe('sb_publishable_test');
    expect(f.calls[0]?.headers.authorization).toBeUndefined();
    expect(f.calls[0]?.body).toEqual({ email: 'a@b.example', password: 'pw' });
  });

  it('maps failures to stable codes and never exposes server messages', async () => {
    const bad = client({
      'POST /auth/v1/token?grant_type=password': () =>
        ok({ error_code: 'invalid_credentials', msg: 'No user with email x@y.example' }, 400),
    });
    await expect(bad.gotrue.signInWithPassword('x@y.example', 'pw')).rejects.toMatchObject({
      code: 'invalid_credentials',
      message: 'invalid_credentials',
    });
    for (const [status, expected] of [
      [429, 'rate_limited'],
      [500, 'unavailable'],
      [503, 'unavailable'],
      [401, 'invalid_credentials'],
      [422, 'invalid_credentials'],
    ] as const) {
      const c = client({ 'POST /auth/v1/token?grant_type=password': () => ok({}, status) });
      expect(await code(c.gotrue.signInWithPassword('a@b.example', 'pw'))).toBe(expected);
    }
  });

  it('treats network failure and malformed success bodies as unavailable', async () => {
    const down = createGoTrueClient({
      baseUrl: BASE,
      publishableKey: 'k',
      fetch: () => Promise.reject(new Error('ECONNREFUSED')),
    });
    expect(await code(down.signInWithPassword('a@b.example', 'pw'))).toBe('unavailable');
    const junk = client({
      'POST /auth/v1/token?grant_type=password': () => ok({ access_token: 'x' }),
    });
    expect(await code(junk.gotrue.signInWithPassword('a@b.example', 'pw'))).toBe('unavailable');
  });

  it('refresh rejection means the session is invalid', async () => {
    const { gotrue } = client({
      'POST /auth/v1/token?grant_type=refresh_token': () => ok({ error: 'invalid_grant' }, 400),
    });
    expect(await code(gotrue.refresh('old'))).toBe('invalid_session');
  });

  it('verifies TOTP through challenge then verify and returns an aal2 session', async () => {
    const { f, gotrue } = client({
      'POST /auth/v1/factors/f1/challenge': () => ok({ id: 'c1', expires_at: 1 }),
      'POST /auth/v1/factors/f1/verify': () => ok(sessionJson('aal2')),
    });
    const session = await gotrue.verifyTotp(accessToken(), 'f1', '123456');
    expect(session.aal).toBe('aal2');
    expect(f.calls[1]?.body).toEqual({ challenge_id: 'c1', code: '123456' });
    expect(f.calls[1]?.headers.authorization).toMatch(/^Bearer /);
  });

  it('a wrong TOTP code is invalid_code', async () => {
    const { gotrue } = client({
      'POST /auth/v1/factors/f1/challenge': () => ok({ id: 'c1' }),
      'POST /auth/v1/factors/f1/verify': () => ok({ error_code: 'mfa_verification_failed' }, 400),
    });
    expect(await code(gotrue.verifyTotp(accessToken(), 'f1', '000000'))).toBe('invalid_code');
  });

  it('lists factors and enrols TOTP', async () => {
    const { gotrue } = client({
      'GET /auth/v1/user': () =>
        ok({ id: USER_ID, factors: [{ id: 'f1', factor_type: 'totp', status: 'verified' }] }),
      'POST /auth/v1/factors': () =>
        ok({
          id: 'f2',
          type: 'totp',
          totp: {
            qr_code: 'data:image/svg+xml;base64,AAA',
            secret: 'JBSWY3DP',
            uri: 'otpauth://totp/x',
          },
        }),
    });
    expect(await gotrue.listFactors(accessToken())).toEqual([
      { id: 'f1', type: 'totp', status: 'verified' },
    ]);
    expect(await gotrue.enrolTotp(accessToken(), 'device')).toMatchObject({
      factorId: 'f2',
      secret: 'JBSWY3DP',
    });
  });

  it('phone OTP requests and verification use the OTP endpoints', async () => {
    const { f, gotrue } = client({
      'POST /auth/v1/otp': () => ok({}),
      'POST /auth/v1/verify': () => ok(sessionJson('aal1')),
    });
    await gotrue.requestPhoneOtp('+919000000001');
    const session = await gotrue.verifyPhoneOtp('+919000000001', '123456');
    expect(session.userId).toBe(USER_ID);
    expect(f.calls[1]?.body).toEqual({ type: 'sms', phone: '+919000000001', token: '123456' });
  });

  it('reads token claims without a Buffer and ignores garbage', () => {
    const t = accessToken({ aal: 'aal2', exp: 1234 });
    expect(readTokenClaims(t)).toEqual({ sub: USER_ID, aal: 'aal2', exp: 1234 });
    expect(readTokenClaims('nonsense')).toBeUndefined();
    expect(readTokenClaims('a.b.c')).toBeUndefined();
    expect(base64UrlToString(Buffer.from('héllo ✓', 'utf8').toString('base64url'))).toBe('héllo ✓');
  });
});
