import { AuthFailure, SessionManager, type GoTrueClient, type Session } from '@udofin/auth-client';
import { describe, expect, it } from 'vitest';
import { OtpFlow } from '../src/auth/otp-flow';

const session: Session = {
  accessToken: 'a'.repeat(30),
  refreshToken: 'r',
  expiresAt: 2_000_000_000,
  userId: '0f0f0f0f-0000-4000-8000-000000000001',
  aal: 'aal1',
};

function setup(over: Partial<GoTrueClient> = {}) {
  const unused = () => Promise.reject(new Error('unused'));
  const sent: string[] = [];
  let stored: string | null = null;
  const gotrue: GoTrueClient = {
    signInWithPassword: unused,
    refresh: unused,
    signOut: () => Promise.resolve(),
    listFactors: unused,
    enrolTotp: unused,
    verifyTotp: unused,
    requestPhoneOtp: (p) => (sent.push(p), Promise.resolve()),
    verifyPhoneOtp: () => Promise.resolve(session),
    ...over,
  };
  const manager = new SessionManager({
    storage: {
      load: () => Promise.resolve(stored),
      save: (v) => ((stored = v), Promise.resolve()),
      clear: () => ((stored = null), Promise.resolve()),
    },
    gotrue,
    now: () => 1_800_000_000,
  });
  let t = 1_000_000;
  const flow = new OtpFlow({ gotrue, session: manager, now: () => t });
  return { flow, manager, sent, advance: (ms: number) => (t += ms) };
}

describe('OtpFlow', () => {
  it('sends a code to the normalised number and signs in on the right code', async () => {
    const { flow, manager, sent } = setup();
    const requested = await flow.requestCode('98765 43210');
    expect(requested).toEqual({ ok: true, phone: '+919876543210' });
    expect(sent).toEqual(['+919876543210']);
    expect(await flow.verifyCode('123 456')).toEqual({ ok: true });
    expect(manager.getState().status).toBe('signed_in');
  });

  it('rejects invalid numbers and malformed codes before calling the server', async () => {
    const { flow, sent } = setup();
    expect(await flow.requestCode('12345')).toEqual({ ok: false, error: 'invalid_phone' });
    await flow.requestCode('9876543210');
    expect(await flow.verifyCode('12')).toEqual({ ok: false, error: 'invalid_code' });
    expect(sent).toEqual(['+919876543210']); // only the valid number was ever sent
  });

  it('cannot verify a code before one was requested, and forgets the number afterwards', async () => {
    const { flow } = setup();
    expect(await flow.verifyCode('123456')).toEqual({ ok: false, error: 'invalid_phone' });
    await flow.requestCode('9876543210');
    expect(flow.pendingPhone()).toBe('+919876543210');
    await flow.verifyCode('123456');
    expect(flow.pendingPhone()).toBeNull();
  });

  it('makes the user wait between resend requests', async () => {
    const { flow, sent, advance } = setup();
    await flow.requestCode('9876543210');
    const again = await flow.requestCode('9876543210');
    expect(again).toMatchObject({ ok: false, error: 'resend_wait' });
    expect(again.ok === false && again.retryAfterSeconds).toBeGreaterThan(0);
    advance(31_000);
    expect((await flow.requestCode('9876543210')).ok).toBe(true);
    expect(sent).toHaveLength(2);
  });

  it('locks after five wrong codes until a new code is requested', async () => {
    const { flow, advance } = setup({
      verifyPhoneOtp: () => Promise.reject(new AuthFailure('invalid_code')),
    });
    await flow.requestCode('9876543210');
    const results = [];
    for (let i = 0; i < 6; i += 1) results.push(await flow.verifyCode('000000'));
    expect(results.slice(0, 4).every((r) => !r.ok && r.error === 'invalid_code')).toBe(true);
    expect(results[4]).toEqual({ ok: false, error: 'too_many_attempts' });
    expect(results[5]).toEqual({ ok: false, error: 'too_many_attempts' });
    advance(31_000);
    await flow.requestCode('9876543210');
    expect(await flow.verifyCode('000000')).toMatchObject({
      error: 'invalid_code',
    });
  });

  it('maps upstream rate limiting and outages to safe messages', async () => {
    const limited = setup({
      requestPhoneOtp: () => Promise.reject(new AuthFailure('rate_limited')),
    });
    expect(await limited.flow.requestCode('9876543210')).toEqual({
      ok: false,
      error: 'rate_limited',
    });
    const down = setup({ requestPhoneOtp: () => Promise.reject(new TypeError('fetch failed')) });
    expect(await down.flow.requestCode('9876543210')).toEqual({ ok: false, error: 'unavailable' });
  });
});
