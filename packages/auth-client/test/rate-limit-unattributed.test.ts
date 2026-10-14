// F-05: when the client address cannot be determined, requests must not share one address bucket
// (an attacker would lock everybody out for 15 minutes). Per-account limits and short global ceilings apply.
import { describe, expect, it } from 'vitest';
import { AuthFailure, type Factor, type GoTrueClient } from '../src/gotrue.js';
import { createAuthHandlers } from '../src/web/bff.js';
import { clientAddress, createPortalAuth } from '../src/web/portal-env.js';
import {
  createMemoryRateLimiter,
  isAttributedAddress,
  UNATTRIBUTED_ADDRESSES,
} from '../src/web/rate-limiter.js';
import { accessToken, fakeFetch, ok, sessionOf, USER_ID } from './helpers.js';

const ORIGIN = 'https://ops.udofin.example';

function setup(
  clientIp: (r: Request) => string,
  clock: { ms: number } = { ms: 1_800_000_000_000 },
) {
  let unattributedCalls = 0;
  const gotrue: GoTrueClient = {
    signInWithPassword: () => Promise.reject(new AuthFailure('invalid_credentials')),
    refresh: () => Promise.reject(new Error('unused')),
    signOut: () => Promise.resolve(),
    listFactors: () => Promise.resolve([] as Factor[]),
    enrolTotp: () => Promise.reject(new Error('unused')),
    verifyTotp: () => Promise.resolve(sessionOf({ aal: 'aal2' })),
    requestPhoneOtp: () => Promise.reject(new Error('unused')),
    verifyPhoneOtp: () => Promise.reject(new Error('unused')),
  };
  const api = fakeFetch({ 'GET /v1/me': () => ok({ code: 'x' }, 503) });
  const h = createAuthHandlers({
    gotrue,
    allowedOrigin: ORIGIN,
    secureCookies: true,
    audience: 'platform',
    apiBaseUrl: 'https://api.udofin.example',
    rateLimiter: createMemoryRateLimiter(() => clock.ms),
    clientIp,
    onUnattributedAddress: () => {
      unattributedCalls += 1;
    },
    fetch: api.fetch,
    now: () => Math.floor(clock.ms / 1000),
  });
  return { h, clock, unattributed: () => unattributedCalls };
}

const post = (path: string, body: unknown, cookie?: string) =>
  new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: {
      origin: ORIGIN,
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });

describe('requests without a usable client address', () => {
  it.each(UNATTRIBUTED_ADDRESSES)(
    'treats "%s" as no address: strangers do not share a bucket and cannot lock a victim out',
    async (placeholder) => {
      const { h } = setup(() => placeholder);
      const attempt = (email: string) =>
        h.signIn(post('/auth/sign-in', { email, password: 'wrong' }));
      // An attacker hammers accounts of their own choosing: 25 > the old shared per-address limit of 20.
      const noisy: number[] = [];
      for (let i = 0; i < 25; i += 1)
        noisy.push((await attempt(`probe${i}@udofin.example`)).status);
      expect(noisy.every((status) => status === 401)).toBe(true); // nobody was locked out
      // The legitimate user signs in (wrongly or rightly) as normal in the same window.
      expect((await attempt('real.user@udofin.example')).status).toBe(401);
    },
  );

  it('keeps the per-account ceiling, so distributed guessing against one account is still stopped', async () => {
    const { h } = setup(() => 'unknown');
    const statuses: number[] = [];
    for (let i = 0; i < 65; i += 1) {
      statuses.push(
        (
          await h.signIn(
            post('/auth/sign-in', { email: 'target@udofin.example', password: `p${i}` }),
          )
        ).status,
      );
    }
    expect(statuses.slice(0, 60).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(60)).toEqual([429, 429, 429, 429, 429]);
    // Another account is unaffected by the first one's ceiling.
    const other = await h.signIn(
      post('/auth/sign-in', { email: 'other@udofin.example', password: 'x' }),
    );
    expect(other.status).toBe(401);
  });

  it('has a short global ceiling that recovers after one minute, not fifteen', async () => {
    const { h, clock } = setup(() => 'unknown');
    const attempt = (i: number) =>
      h.signIn(post('/auth/sign-in', { email: `flood${i}@udofin.example`, password: 'x' }));
    let last: Response | undefined;
    for (let i = 0; i < 121; i += 1) last = await attempt(i);
    expect(last?.status).toBe(429);
    expect(last?.headers.get('retry-after')).toBe('60');
    clock.ms += 61_000;
    expect((await attempt(1000)).status).toBe(401); // the attack window passed; sign-in works again
  });

  it('still applies per-address limits when the address IS known', async () => {
    const { h } = setup(() => '198.51.100.7');
    const statuses: number[] = [];
    for (let i = 0; i < 22; i += 1)
      statuses.push(
        (await h.signIn(post('/auth/sign-in', { email: `u${i}@udofin.example`, password: 'x' })))
          .status,
      );
    expect(statuses.at(-1)).toBe(429);
    expect(statuses.slice(0, 20).every((s) => s === 401)).toBe(true);
  });

  it('tells the host when a request had no usable address (for a one-time warning)', async () => {
    const { h, unattributed } = setup(() => 'unknown');
    await h.signIn(post('/auth/sign-in', { email: 'a@udofin.example', password: 'x' }));
    expect(unattributed()).toBe(1);
    const known = setup(() => '203.0.113.5');
    await known.h.signIn(post('/auth/sign-in', { email: 'a@udofin.example', password: 'x' }));
    expect(known.unattributed()).toBe(0);
  });

  it('limits second-factor attempts per token, so a forged cookie cannot lock another user out', async () => {
    const { h } = setup(() => 'unknown');
    const verify = (token: string) =>
      h.verifyMfa(
        post('/auth/mfa/verify', { factorId: 'f1', code: '123456' }, `__Host-udofin_at=${token}`),
      );
    // An attacker forges cookies that name the victim's user id; each forged token has its own bucket.
    const forged = accessToken({ sub: USER_ID });
    const attacker: number[] = [];
    for (let i = 0; i < 8; i += 1) attacker.push((await verify(`${forged}`)).status);
    expect(attacker.slice(-1)[0]).toBe(429); // the attacker's own token is throttled
    // The victim's real session (a different token for the same user id) is not.
    const victimToken = accessToken({ sub: USER_ID, exp: Math.floor(Date.now() / 1000) + 1234 });
    expect((await verify(victimToken)).status).not.toBe(429);
  });
});

describe('address placeholders', () => {
  it('are recognised and never usable as keys', () => {
    expect(isAttributedAddress('direct')).toBe(false);
    expect(isAttributedAddress('unknown')).toBe(false);
    expect(isAttributedAddress('203.0.113.7')).toBe(true);
    expect(clientAddress(null, 1)).toBe('unknown');
    expect(clientAddress('1.1.1.1', 0)).toBe('direct');
  });
});

describe('start-up warnings', () => {
  const env = {
    SUPABASE_URL: 'https://proj.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_0123456789abcdef',
    API_BASE_URL: 'https://api.udofin.example',
    PORTAL_ORIGIN: 'https://ops.udofin.example',
  };
  it('states the single-instance requirement, and warns when no address can be determined', () => {
    const messages: string[] = [];
    createPortalAuth({ ...env, TRUSTED_PROXY_HOPS: '0' }, 'platform', {
      warn: (m) => messages.push(m),
    });
    expect(messages.some((m) => /ONE portal instance/.test(m))).toBe(true);
    expect(messages.some((m) => /TRUSTED_PROXY_HOPS=0/.test(m))).toBe(true);
  });
  it('does not repeat the proxy warning when a proxy is configured', () => {
    const messages: string[] = [];
    createPortalAuth({ ...env, TRUSTED_PROXY_HOPS: '1' }, 'platform', {
      warn: (m) => messages.push(m),
    });
    expect(messages.some((m) => /ONE portal instance/.test(m))).toBe(true);
    expect(messages.some((m) => /TRUSTED_PROXY_HOPS=0/.test(m))).toBe(false);
  });
});
