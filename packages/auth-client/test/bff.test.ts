import { describe, expect, it } from 'vitest';
import { AuthFailure, type Factor, type GoTrueClient, type Session } from '../src/gotrue.js';
import { createAuthHandlers } from '../src/web/bff.js';
import { createMemoryRateLimiter } from '../src/web/rate-limiter.js';
import { accessToken, fakeFetch, ok, sessionOf, USER_ID } from './helpers.js';

const ORIGIN = 'https://ops.udofin.example';
const NOW = 1_800_000_000;

function gotrueFake(over: Partial<GoTrueClient> = {}): GoTrueClient & { calls: string[] } {
  const calls: string[] = [];
  const unused = () => Promise.reject(new Error('unused'));
  const wrap =
    <A extends unknown[], R>(name: string, fn: (...a: A) => Promise<R>) =>
    (...a: A) => (calls.push(name), fn(...a));
  return {
    calls,
    signInWithPassword: wrap('signIn', () => Promise.resolve(sessionOf({ aal: 'aal1' }))),
    refresh: wrap('refresh', unused),
    signOut: wrap('signOut', () => Promise.resolve()),
    listFactors: wrap('listFactors', () => Promise.resolve([] as Factor[])),
    enrolTotp: wrap('enrol', () =>
      Promise.resolve({
        factorId: 'f1',
        qrCode: 'data:image/svg+xml;base64,AAA',
        secret: 'JBSWY3DP',
        uri: 'otpauth://x',
      }),
    ),
    verifyTotp: wrap('verify', () => Promise.resolve(sessionOf({ aal: 'aal2' }))),
    requestPhoneOtp: unused,
    verifyPhoneOtp: unused,
    ...over,
  };
}

const me = (actor: 'platform' | 'lender' | 'borrower') => ({
  userId: USER_ID,
  actor,
  memberships: [
    {
      membershipId: USER_ID,
      organizationId: USER_ID,
      organizationKind: actor,
      organizationName: 'Org',
      permissions: ['platform.organizations.read'],
    },
  ],
});

function handlers(
  opts: {
    gotrue?: GoTrueClient;
    apiActor?: 'platform' | 'lender' | 'borrower';
    apiStatus?: number;
    apiCode?: string;
    secure?: boolean;
  } = {},
) {
  const api = fakeFetch({
    'GET /v1/me': () =>
      opts.apiStatus && opts.apiStatus !== 200
        ? ok({ code: opts.apiCode ?? 'x' }, opts.apiStatus)
        : ok(me(opts.apiActor ?? 'platform')),
  });
  return {
    api,
    h: createAuthHandlers({
      gotrue: opts.gotrue ?? gotrueFake(),
      allowedOrigin: ORIGIN,
      secureCookies: opts.secure ?? true,
      audience: 'platform',
      apiBaseUrl: 'https://api.udofin.example',
      rateLimiter: createMemoryRateLimiter(() => NOW * 1000),
      clientIp: (r) => r.headers.get('x-test-ip') ?? '203.0.113.9',
      fetch: api.fetch,
      now: () => NOW,
    }),
  };
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
const cookiesOf = (res: Response) => res.headers.getSetCookie();

describe('sign-in', () => {
  it('sets HttpOnly, Secure, SameSite=Strict __Host- cookies and never returns tokens in the body', async () => {
    const { h } = handlers();
    const res = await h.signIn(
      post('/auth/sign-in', { email: 'staff@udofin.example', password: 'correct horse' }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ next: 'mfa_enrol' });
    const cookies = cookiesOf(res);
    expect(cookies).toHaveLength(2);
    for (const c of cookies) {
      expect(c).toMatch(/^__Host-udofin_(at|rt)=/);
      expect(c).toContain('HttpOnly');
      expect(c).toContain('Secure');
      expect(c).toContain('SameSite=Strict');
      expect(c).toContain('Path=/');
      expect(c).not.toContain('Domain');
      expect(c).not.toContain('Max-Age'); // session cookies
    }
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('asks an enrolled user to verify their existing factor', async () => {
    const { h } = handlers({
      gotrue: gotrueFake({
        listFactors: () => Promise.resolve([{ id: 'f9', type: 'totp', status: 'verified' }]),
      }),
    });
    const res = await h.signIn(
      post('/auth/sign-in', { email: 'staff@udofin.example', password: 'pw' }),
    );
    expect(await res.json()).toEqual({ next: 'mfa_verify', factorId: 'f9' });
  });

  it('gives the same generic answer for unknown users and wrong passwords, with no cookies', async () => {
    const { h } = handlers({
      gotrue: gotrueFake({
        signInWithPassword: () => Promise.reject(new AuthFailure('invalid_credentials')),
      }),
    });
    const res = await h.signIn(
      post('/auth/sign-in', { email: 'nobody@udofin.example', password: 'pw' }),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'invalid_credentials' });
    expect(cookiesOf(res)).toHaveLength(0);
  });

  it('refuses cross-origin and non-JSON posts before touching the auth server', async () => {
    const g = gotrueFake();
    const { h } = handlers({ gotrue: g });
    const evil = await h.signIn(
      post(
        '/auth/sign-in',
        { email: 'a@b.example', password: 'x' },
        { origin: 'https://evil.example' },
      ),
    );
    expect(evil.status).toBe(403);
    const form = await h.signIn(
      new Request(`${ORIGIN}/auth/sign-in`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
        body: 'email=a',
      }),
    );
    expect(form.status).toBe(415);
    const noOrigin = await h.signIn(
      new Request(`${ORIGIN}/auth/sign-in`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    expect(noOrigin.status).toBe(403);
    expect(g.calls).toEqual([]);
  });

  it('accepts a missing Origin only when the browser says it is same-origin', async () => {
    const { h } = handlers();
    const res = await h.signIn(
      new Request(`${ORIGIN}/auth/sign-in`, {
        method: 'POST',
        headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'a@b.example', password: 'x' }),
      }),
    );
    expect(res.status).toBe(200);
  });

  it('validates input strictly', async () => {
    const { h } = handlers();
    for (const body of [
      {},
      { email: 'not-an-email', password: 'x' },
      { email: 'a@b.example', password: '' },
      { email: 'a@b.example', password: 'x', extra: 1 },
    ]) {
      expect((await h.signIn(post('/auth/sign-in', body))).status).toBe(400);
    }
  });

  it('rate-limits repeated attempts per address and account, existing account or not, without letting a stranger lock the real user out', async () => {
    const { h } = handlers({
      gotrue: gotrueFake({
        signInWithPassword: () => Promise.reject(new AuthFailure('invalid_credentials')),
      }),
    });
    const attempt = (email: string, ip: string, password = 'x') =>
      h.signIn(post('/auth/sign-in', { email, password }, { 'x-test-ip': ip }));
    const statuses: number[] = [];
    for (let i = 0; i < 10; i += 1)
      statuses.push((await attempt('victim@udofin.example', '198.51.100.1', `try${i}`)).status);
    expect(statuses.slice(0, 8)).toEqual(Array(8).fill(401));
    expect(statuses.slice(8)).toEqual([429, 429]);
    // The real user, from their own address, is not locked out by that attacker.
    expect((await attempt('victim@udofin.example', '192.0.2.50')).status).toBe(401);
    // A different account from a fresh address is unaffected.
    expect((await attempt('other@udofin.example', '192.0.2.1')).status).toBe(401);
    // One address trying many accounts is throttled.
    const noisy: number[] = [];
    for (let i = 0; i < 22; i += 1)
      noisy.push((await attempt(`u${i}@udofin.example`, '192.0.2.77')).status);
    expect(noisy.at(-1)).toBe(429);
    // Distributed guessing against one account hits the account-wide ceiling.
    const spread: number[] = [];
    for (let i = 0; i < 70; i += 1)
      spread.push((await attempt('target@udofin.example', `203.0.113.${i + 1}`)).status);
    expect(spread.at(-1)).toBe(429);
  });

  it('maps upstream rate limiting and outages without leaking details', async () => {
    const limited = handlers({
      gotrue: gotrueFake({
        signInWithPassword: () => Promise.reject(new AuthFailure('rate_limited')),
      }),
    });
    const res = await limited.h.signIn(
      post('/auth/sign-in', { email: 'a@b.example', password: 'x' }),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('60');
    const down = handlers({
      gotrue: gotrueFake({
        signInWithPassword: () => Promise.reject(new Error('socket hang up to 10.0.0.5')),
      }),
    });
    const r2 = await down.h.signIn(post('/auth/sign-in', { email: 'a@b.example', password: 'x' }));
    expect(r2.status).toBe(503);
    expect(JSON.stringify(await r2.json())).not.toContain('10.0.0.5');
  });

  it('uses unprefixed, non-Secure cookies for plain-http local development only', async () => {
    const { h } = handlers({ secure: false });
    const res = await h.signIn(post('/auth/sign-in', { email: 'a@b.example', password: 'x' }));
    for (const c of cookiesOf(res)) {
      expect(c).toMatch(/^udofin_(at|rt)=/);
      expect(c).not.toContain('Secure');
      expect(c).toContain('HttpOnly');
    }
  });
});

describe('second factor', () => {
  const withCookie = (token = accessToken({ aal: 'aal1' })) => ({
    cookie: `__Host-udofin_at=${token}; __Host-udofin_rt=refresh-token-1`,
  });

  it('enrols TOTP only for a signed-in user and never when one is already verified', async () => {
    const { h } = handlers();
    expect((await h.enrolMfa(post('/auth/mfa/enrol', {}))).status).toBe(401);
    const res = await h.enrolMfa(post('/auth/mfa/enrol', {}, withCookie()));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ factorId: 'f1', secret: 'JBSWY3DP' });
    const enrolled = handlers({
      gotrue: gotrueFake({
        listFactors: () => Promise.resolve([{ id: 'f9', type: 'totp', status: 'verified' }]),
      }),
    });
    expect((await enrolled.h.enrolMfa(post('/auth/mfa/enrol', {}, withCookie()))).status).toBe(409);
  });

  it('verifies the code, upgrades the cookies and checks the API agrees this is a platform user', async () => {
    const { h, api } = handlers();
    const res = await h.verifyMfa(
      post('/auth/mfa/verify', { factorId: 'f1', code: '123456' }, withCookie()),
    );
    expect(res.status).toBe(200);
    expect(cookiesOf(res)).toHaveLength(2);
    expect(api.calls.filter((c) => c.url.endsWith('/v1/me'))).toHaveLength(1);
  });

  it('refuses a lender user in the platform portal and ends their session', async () => {
    const g = gotrueFake();
    const { h } = handlers({ gotrue: g, apiActor: 'lender' });
    const res = await h.verifyMfa(
      post('/auth/mfa/verify', { factorId: 'f1', code: '123456' }, withCookie()),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'wrong_portal' });
    expect(cookiesOf(res).every((c) => c.includes('Max-Age=0'))).toBe(true);
    expect(g.calls).toContain('signOut');
  });

  it('rejects a bad code, malformed codes, and brute force', async () => {
    const { h } = handlers({
      gotrue: gotrueFake({ verifyTotp: () => Promise.reject(new AuthFailure('invalid_code')) }),
    });
    expect(
      (
        await h.verifyMfa(
          post('/auth/mfa/verify', { factorId: 'f1', code: 'abcdef' }, withCookie()),
        )
      ).status,
    ).toBe(400);
    const statuses: number[] = [];
    for (let i = 0; i < 8; i += 1)
      statuses.push(
        (
          await h.verifyMfa(
            post('/auth/mfa/verify', { factorId: 'f1', code: '000000' }, withCookie()),
          )
        ).status,
      );
    expect(statuses.slice(0, 6)).toEqual(Array(6).fill(401));
    expect(statuses.slice(6)).toEqual([429, 429]);
  });
});

describe('sign-out and session', () => {
  it('revokes with a fresh token when the cookie token has expired', async () => {
    let revokedWith = '';
    const fresh = sessionOf({ accessToken: accessToken({ exp: NOW + 900 }) });
    const { h } = handlers({
      gotrue: gotrueFake({
        refresh: () => Promise.resolve(fresh),
        signOut: (token) => ((revokedWith = token), Promise.resolve()),
      }),
    });
    const expired = accessToken({ exp: NOW - 100 });
    const res = await h.signOut(
      post(
        '/auth/sign-out',
        {},
        { cookie: `__Host-udofin_at=${expired}; __Host-udofin_rt=refresh-token-1` },
      ),
    );
    expect(res.status).toBe(200);
    expect(revokedWith).toBe(fresh.accessToken);
    expect(cookiesOf(res).every((c) => c.includes('Max-Age=0'))).toBe(true);
  });

  it('still clears cookies when the session cannot be refreshed for revocation', async () => {
    const { h } = handlers({
      gotrue: gotrueFake({ refresh: () => Promise.reject(new AuthFailure('invalid_session')) }),
    });
    const res = await h.signOut(
      post(
        '/auth/sign-out',
        {},
        { cookie: `__Host-udofin_at=${accessToken({ exp: NOW - 100 })}; __Host-udofin_rt=r` },
      ),
    );
    expect(res.status).toBe(200);
    expect(cookiesOf(res)).toHaveLength(2);
  });

  it('gives every TOTP enrolment a unique name so a second attempt cannot collide', async () => {
    const names: string[] = [];
    const g = gotrueFake({
      enrolTotp: (_t, name) => (
        names.push(name),
        Promise.resolve({
          factorId: 'f1',
          qrCode: 'data:image/svg+xml;base64,AAA',
          secret: 'S',
          uri: 'u',
        })
      ),
    });
    const { h } = handlers({ gotrue: g });
    const c = {
      cookie: `__Host-udofin_at=${accessToken({ aal: 'aal1', exp: NOW + 900 })}; __Host-udofin_rt=r`,
    };
    await h.enrolMfa(post('/auth/mfa/enrol', {}, c));
    await h.enrolMfa(post('/auth/mfa/enrol', {}, { ...c, 'x-test-ip': '198.51.100.9' }));
    expect(new Set(names).size).toBe(2);
  });

  it('clears both cookies even if the auth server fails', async () => {
    const { h } = handlers({
      gotrue: gotrueFake({ signOut: () => Promise.reject(new AuthFailure('unavailable')) }),
    });
    const res = await h.signOut(
      post('/auth/sign-out', {}, { cookie: `__Host-udofin_at=${accessToken()}` }),
    );
    expect(res.status).toBe(200);
    expect(cookiesOf(res)).toHaveLength(2);
    expect(cookiesOf(res).every((c) => c.includes('Max-Age=0'))).toBe(true);
  });

  it('portalSession maps API answers to portal states', async () => {
    const cookie = {
      headers: new Headers({ cookie: `__Host-udofin_at=${accessToken({ aal: 'aal2' })}` }),
    };
    expect((await handlers().h.portalSession({ headers: new Headers() })).state).toBe(
      'unauthenticated',
    );
    expect((await handlers().h.portalSession(cookie)).state).toBe('ok');
    expect((await handlers({ apiActor: 'lender' }).h.portalSession(cookie)).state).toBe(
      'wrong_portal',
    );
    expect(
      (await handlers({ apiStatus: 401, apiCode: 'mfa_required' }).h.portalSession(cookie)).state,
    ).toBe('mfa_required');
    expect(
      (await handlers({ apiStatus: 401, apiCode: 'token_expired' }).h.portalSession(cookie)).state,
    ).toBe('unauthenticated');
    expect(
      (await handlers({ apiStatus: 403, apiCode: 'no_active_access' }).h.portalSession(cookie))
        .state,
    ).toBe('no_access');
    expect((await handlers({ apiStatus: 500 }).h.portalSession(cookie)).state).toBe('unavailable');
  });
});

describe('refreshIfNeeded', () => {
  const req = (access: string, refresh = 'refresh-token-1') =>
    new Request(`${ORIGIN}/`, {
      headers: { cookie: `__Host-udofin_at=${access}; __Host-udofin_rt=${refresh}; other=1` },
    });

  it('does nothing while the access token is comfortably valid, or when there is no refresh token', async () => {
    const { h } = handlers();
    expect(await h.refreshIfNeeded(req(accessToken({ exp: NOW + 600 })))).toEqual({
      setCookies: [],
    });
    expect(await h.refreshIfNeeded(new Request(`${ORIGIN}/`))).toEqual({ setCookies: [] });
  });

  it('refreshes a nearly expired token and hands back a merged Cookie header for the same request', async () => {
    const next: Session = sessionOf({
      accessToken: accessToken({ exp: NOW + 900 }),
      refreshToken: 'rotated-2',
    });
    const { h } = handlers({ gotrue: gotrueFake({ refresh: () => Promise.resolve(next) }) });
    const out = await h.refreshIfNeeded(req(accessToken({ exp: NOW + 10 })));
    expect(out.setCookies).toHaveLength(2);
    expect(out.cookieHeader).toContain(`__Host-udofin_at=${next.accessToken}`);
    expect(out.cookieHeader).toContain('__Host-udofin_rt=rotated-2');
    expect(out.cookieHeader).toContain('other=1');
  });

  it('clears cookies when the refresh token is rejected, and keeps them on a temporary failure', async () => {
    const rejected = handlers({
      gotrue: gotrueFake({ refresh: () => Promise.reject(new AuthFailure('invalid_session')) }),
    });
    const a = await rejected.h.refreshIfNeeded(req(accessToken({ exp: NOW - 5 })));
    expect(a.setCookies.every((c) => c.includes('Max-Age=0'))).toBe(true);
    expect(a.cookieHeader).toBe('other=1');
    const flaky = handlers({
      gotrue: gotrueFake({ refresh: () => Promise.reject(new AuthFailure('unavailable')) }),
    });
    expect(await flaky.h.refreshIfNeeded(req(accessToken({ exp: NOW - 5 })))).toEqual({
      setCookies: [],
    });
  });
});
