import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createApiClient } from '../src/api-client.js';
import {
  clearSessionCookie,
  cookieNames,
  parseCookieHeader,
  serializeSessionCookie,
} from '../src/web/cookies.js';
import { createMemoryRateLimiter } from '../src/web/rate-limiter.js';
import { fakeFetch, ok, USER_ID } from './helpers.js';

describe('cookies', () => {
  it('serialises with the security attributes and refuses odd values', () => {
    const c = serializeSessionCookie('__Host-udofin_at', 'abc.def_ghi-1', { secure: true });
    expect(c).toBe('__Host-udofin_at=abc.def_ghi-1; Path=/; HttpOnly; SameSite=Strict; Secure');
    expect(() => serializeSessionCookie('x', 'a; Domain=evil', { secure: true })).toThrow();
    expect(() => serializeSessionCookie('x', 'a\r\nSet-Cookie: y=1', { secure: true })).toThrow();
    expect(cookieNames(true).access).toBe('__Host-udofin_at');
    expect(cookieNames(false).access).toBe('udofin_at');
    expect(clearSessionCookie('x', { secure: true })).toContain('Max-Age=0');
  });

  it('parses a Cookie header, first value wins', () => {
    const m = parseCookieHeader('a=1; b=2; a=3; junk');
    expect(m.get('a')).toBe('1');
    expect(m.get('b')).toBe('2');
    expect(m.size).toBe(2);
  });
});

describe('rate limiter', () => {
  it('counts per key within a window and resets after it', () => {
    let t = 0;
    const rl = createMemoryRateLimiter(() => t);
    expect([1, 2, 3, 4].map(() => rl.hit('k', 3, 60))).toEqual([true, true, true, false]);
    expect(rl.hit('other', 3, 60)).toBe(true);
    t = 61_000;
    expect(rl.hit('k', 3, 60)).toBe(true);
  });

  it('stays bounded even when every key is new and none has expired (forged addresses)', () => {
    const rl = createMemoryRateLimiter(() => 0);
    for (let i = 0; i < 25_000; i += 1) rl.hit(`ip:${String(i)}`, 5, 900);
    // The earliest keys were evicted to keep memory bounded, so they start fresh; recent ones are tracked.
    expect(rl.hit('ip:24999', 1, 900)).toBe(false);
    expect(rl.hit('ip:0', 1, 900)).toBe(true);
  });
});

describe('API client', () => {
  const meBody = { userId: USER_ID, actor: 'platform', memberships: [] };
  it('sends the bearer token and validates the response against the shared contract', async () => {
    const f = fakeFetch({ 'GET /v1/me': () => ok(meBody) });
    const api = createApiClient({
      baseUrl: 'https://api.example/',
      getAccessToken: () => Promise.resolve('tok'),
      fetch: f.fetch,
    });
    const res = await api.me();
    expect(res).toMatchObject({ ok: true, data: { actor: 'platform' } });
    expect(f.calls[0]?.headers.authorization).toBe('Bearer tok');
  });

  it('reports contract drift as bad_response, never as data', async () => {
    const f = fakeFetch({ 'GET /v1/me': () => ok({ userId: 'nope' }) });
    const api = createApiClient({
      baseUrl: 'https://api.example',
      getAccessToken: () => Promise.resolve('tok'),
      fetch: f.fetch,
    });
    expect(await api.me()).toEqual({ ok: false, status: 200, code: 'bad_response' });
  });

  it('signed out, offline and server problems come back as codes', async () => {
    const signedOut = createApiClient({
      baseUrl: 'https://api.example',
      getAccessToken: () => Promise.resolve(null),
      fetch: fakeFetch({}).fetch,
    });
    expect(await signedOut.me()).toEqual({ ok: false, status: 401, code: 'signed_out' });
    const offline = createApiClient({
      baseUrl: 'https://api.example',
      getAccessToken: () => Promise.resolve('t'),
      fetch: () => Promise.reject(new TypeError('fetch failed')),
    });
    expect(await offline.me()).toEqual({ ok: false, status: 0, code: 'network_error' });
    const problem = createApiClient({
      baseUrl: 'https://api.example',
      getAccessToken: () => Promise.resolve('t'),
      fetch: fakeFetch({ 'GET /v1/me': () => ok({ code: 'no_active_access' }, 403) }).fetch,
    });
    expect(await problem.me()).toEqual({ ok: false, status: 403, code: 'no_active_access' });
  });

  it('retries once with a fresh token after a 401, but not for mfa_required', async () => {
    let n = 0;
    const f = fakeFetch({
      'GET /v1/me': (call) =>
        call.headers.authorization === 'Bearer new'
          ? ok(meBody)
          : ok({ code: 'token_expired' }, 401),
    });
    let token = 'old';
    const api = createApiClient({
      baseUrl: 'https://api.example',
      getAccessToken: () => Promise.resolve(token),
      onUnauthorised: () => ((n += 1), (token = 'new'), Promise.resolve(true)),
      fetch: f.fetch,
    });
    expect((await api.me()).ok).toBe(true);
    expect(n).toBe(1);
    const mfa = createApiClient({
      baseUrl: 'https://api.example',
      getAccessToken: () => Promise.resolve('t'),
      onUnauthorised: () => ((n += 1), Promise.resolve(true)),
      fetch: fakeFetch({ 'GET /v1/me': () => ok({ code: 'mfa_required' }, 401) }).fetch,
    });
    expect(await mfa.me()).toEqual({ ok: false, status: 401, code: 'mfa_required' });
    expect(n).toBe(1);
  });

  it('decisions carry the Idempotency-Key', async () => {
    const f = fakeFetch({
      [`POST /v1/admin/change-requests/${USER_ID}/approve`]: () =>
        ok({ id: USER_ID, status: 'approved' }),
    });
    const api = createApiClient({
      baseUrl: 'https://api.example',
      getAccessToken: () => Promise.resolve('t'),
      fetch: f.fetch,
    });
    const res = await api.decideChangeRequest(USER_ID, 'approve', 'key-0123456789abcdef');
    expect(res.ok).toBe(true);
    expect(f.calls[0]?.headers['idempotency-key']).toBe('key-0123456789abcdef');
  });
});

describe('generic call allow-list', () => {
  const api = createApiClient({
    baseUrl: 'https://api.example',
    getAccessToken: () => Promise.resolve('t'),
    fetch: fakeFetch({}).fetch,
  });
  const any = z.unknown();
  it.each([
    '/v1/admin/change-requests',
    '/v1/me',
    '/v1/borrower/../admin/x',
    '/v1/borrower/%2e%2e/admin/x',
    '/v1/borrower/%2E%2E/admin/x',
    '/v1/loan-purposes-extra',
    '/v1/consentx',
    '/v2/borrower/me',
    '/v1/documentsx/1',
    '/v1/platform/document-rules',
    '/v1/applications/../admin/x',
    '/v1/loansx',
    '/v1/payments/../admin/x',
    '/v1/mandatesx/1',
    '/v1/me/remindersx',
    '/v1/me/reminders/../x',
    '/v1/loan',
  ])('refuses %s', async (path) => {
    expect(await api.get(path, any)).toEqual({ ok: false, status: 0, code: 'path_not_allowed' });
  });
  it.each([
    '/v1/borrower/me',
    '/v1/loan-purposes?language=hi',
    '/v1/loan-requests?limit=20',
    '/v1/consent/notices?language=en',
    '/v1/stepup/challenges',
    '/v1/selections/0f1e2d3c-4b5a-4c6d-8e7f-0a1b2c3d4e5f/route',
    '/v1/applications/0f1e2d3c-4b5a-4c6d-8e7f-0a1b2c3d4e5f/documents',
    '/v1/documents/0f1e2d3c-4b5a-4c6d-8e7f-0a1b2c3d4e5f/kfs?language=hi',
    '/v1/offers/0f1e2d3c-4b5a-4c6d-8e7f-0a1b2c3d4e5f/accept',
    '/v1/agreements/0f1e2d3c-4b5a-4c6d-8e7f-0a1b2c3d4e5f/signing',
    '/v1/loans',
    '/v1/loans/0f1e2d3c-4b5a-4c6d-8e7f-0a1b2c3d4e5f/schedule',
    '/v1/loans/0f1e2d3c-4b5a-4c6d-8e7f-0a1b2c3d4e5f/activity?limit=30&cursor=abc_DEF-123',
    '/v1/payments/0f1e2d3c-4b5a-4c6d-8e7f-0a1b2c3d4e5f/cancel',
    '/v1/mandates',
    '/v1/mandates/0f1e2d3c-4b5a-4c6d-8e7f-0a1b2c3d4e5f/debits',
    '/v1/me/reminders',
  ])('allows %s through to the network', async (path) => {
    const result = await api.get(path, any);
    expect(result.ok === false && result.code === 'path_not_allowed').toBe(false);
  });
});
