import { describe, expect, it } from 'vitest';
import { AuthFailure, type GoTrueClient, type Session } from '../src/gotrue.js';
import { SessionManager, type SessionStorage } from '../src/session-manager.js';
import { sessionOf } from './helpers.js';

function memoryStorage(initial: string | null = null) {
  let value = initial;
  const storage: SessionStorage = {
    load: () => Promise.resolve(value),
    save: (v) => ((value = v), Promise.resolve()),
    clear: () => ((value = null), Promise.resolve()),
  };
  return { storage, peek: () => value };
}

function gotrue(over: Partial<GoTrueClient> = {}): GoTrueClient {
  const unused = () => Promise.reject(new Error('unused'));
  return {
    signInWithPassword: unused,
    refresh: unused,
    signOut: () => Promise.resolve(),
    listFactors: unused,
    enrolTotp: unused,
    verifyTotp: unused,
    requestPhoneOtp: unused,
    verifyPhoneOtp: unused,
    ...over,
  };
}

const NOW = 1_800_000_000;
const fresh = (over: Partial<Session> = {}) => sessionOf({ expiresAt: NOW + 900, ...over });

describe('SessionManager', () => {
  it('starts signed out when nothing is stored, and treats corrupt storage as nothing', async () => {
    for (const stored of [null, 'not json', '{"accessToken":1}']) {
      const m = new SessionManager({
        storage: memoryStorage(stored).storage,
        gotrue: gotrue(),
        now: () => NOW,
      });
      expect(await m.initialise()).toEqual({ status: 'signed_out', reason: 'none' });
    }
  });

  it('restores a valid stored session without a network call', async () => {
    const s = fresh();
    const m = new SessionManager({
      storage: memoryStorage(JSON.stringify(s)).storage,
      gotrue: gotrue(),
      now: () => NOW,
    });
    expect(await m.initialise()).toEqual({ status: 'signed_in', session: s });
  });

  it('refreshes an expired stored session and persists the rotated tokens', async () => {
    const old = fresh({ expiresAt: NOW - 10 });
    const next = fresh({ refreshToken: 'rotated' });
    const store = memoryStorage(JSON.stringify(old));
    const m = new SessionManager({
      storage: store.storage,
      gotrue: gotrue({ refresh: () => Promise.resolve(next) }),
      now: () => NOW,
    });
    const state = await m.initialise();
    expect(state).toEqual({ status: 'signed_in', session: next });
    expect(JSON.parse(store.peek() ?? '{}')).toMatchObject({ refreshToken: 'rotated' });
  });

  it('ends the session as expired when the server rejects the refresh token', async () => {
    const store = memoryStorage(JSON.stringify(fresh({ expiresAt: NOW - 10 })));
    const m = new SessionManager({
      storage: store.storage,
      gotrue: gotrue({ refresh: () => Promise.reject(new AuthFailure('invalid_session')) }),
      now: () => NOW,
    });
    expect(await m.initialise()).toEqual({ status: 'signed_out', reason: 'expired' });
    expect(store.peek()).toBeNull();
  });

  it('keeps the session through a temporary refresh failure', async () => {
    const old = fresh({ expiresAt: NOW - 10 });
    const store = memoryStorage(JSON.stringify(old));
    const m = new SessionManager({
      storage: store.storage,
      gotrue: gotrue({ refresh: () => Promise.reject(new AuthFailure('unavailable')) }),
      now: () => NOW,
    });
    expect((await m.initialise()).status).toBe('signed_in');
    expect(store.peek()).not.toBeNull();
  });

  it('refreshes once for concurrent callers (refresh tokens rotate)', async () => {
    let calls = 0;
    const next = fresh({ refreshToken: 'rotated' });
    const m = new SessionManager({
      storage: memoryStorage().storage,
      gotrue: gotrue({
        refresh: async () => {
          calls += 1;
          await new Promise((r) => setTimeout(r, 10));
          return next;
        },
      }),
      now: () => NOW,
    });
    await m.setSession(fresh({ expiresAt: NOW + 5 }));
    const tokens = await Promise.all([m.getAccessToken(), m.getAccessToken(), m.getAccessToken()]);
    expect(calls).toBe(1);
    expect(new Set(tokens).size).toBe(1);
    expect(tokens[0]).toBe(next.accessToken);
  });

  it('does not refresh a token that is comfortably valid', async () => {
    let calls = 0;
    const s = fresh();
    const m = new SessionManager({
      storage: memoryStorage().storage,
      gotrue: gotrue({ refresh: () => ((calls += 1), Promise.reject(new Error('x'))) }),
      now: () => NOW,
    });
    await m.setSession(s);
    expect(await m.getAccessToken()).toBe(s.accessToken);
    expect(calls).toBe(0);
  });

  it('a 401 on a believed-valid token forces a refresh, and ends the session as revoked if that fails too', async () => {
    const m = new SessionManager({
      storage: memoryStorage().storage,
      gotrue: gotrue({ refresh: () => Promise.reject(new AuthFailure('invalid_session')) }),
      now: () => NOW,
    });
    await m.setSession(fresh());
    await m.handleUnauthorised();
    expect(m.getState()).toEqual({ status: 'signed_out', reason: 'expired' });
    expect(await m.getAccessToken()).toBeNull();
  });

  it('sign-out clears local state even when the server is unreachable', async () => {
    const store = memoryStorage();
    const m = new SessionManager({
      storage: store.storage,
      gotrue: gotrue({ signOut: () => Promise.reject(new AuthFailure('unavailable')) }),
      now: () => NOW,
    });
    await m.setSession(fresh());
    await m.signOut();
    expect(m.getState()).toEqual({ status: 'signed_out', reason: 'signed_out' });
    expect(store.peek()).toBeNull();
  });

  it('notifies subscribers of every change', async () => {
    const m = new SessionManager({
      storage: memoryStorage().storage,
      gotrue: gotrue(),
      now: () => NOW,
    });
    const seen: string[] = [];
    m.subscribe((s) => seen.push(s.status));
    await m.initialise();
    await m.setSession(fresh());
    await m.signOut();
    expect(seen).toEqual(['signed_out', 'signed_in', 'signed_out']);
  });

  it('a refresh that finishes after sign-out cannot bring the session back', async () => {
    let release: (s: Session) => void = () => undefined;
    const store = memoryStorage();
    const m = new SessionManager({
      storage: store.storage,
      gotrue: gotrue({ refresh: () => new Promise<Session>((resolve) => (release = resolve)) }),
      now: () => NOW,
    });
    await m.setSession(fresh({ expiresAt: NOW + 5 }));
    const pending = m.getAccessToken();
    await m.signOut();
    release(fresh({ refreshToken: 'late' }));
    expect(await pending).toBeNull();
    expect(m.getState()).toEqual({ status: 'signed_out', reason: 'signed_out' });
    expect(store.peek()).toBeNull();
  });

  it('keeps the new session in memory when the keystore write fails', async () => {
    const m = new SessionManager({
      storage: {
        load: () => Promise.resolve(null),
        save: () => Promise.reject(new Error('keystore locked')),
        clear: () => Promise.resolve(),
      },
      gotrue: gotrue(),
      now: () => NOW,
    });
    const s = fresh();
    await expect(m.setSession(s)).resolves.toBeUndefined();
    expect(m.getState()).toEqual({ status: 'signed_in', session: s });
  });
});
