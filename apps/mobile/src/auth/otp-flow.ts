import { AuthFailure, type GoTrueClient, type SessionManager } from '@udofin/auth-client';
import { normaliseIndianMobile } from './phone';

export type OtpError =
  | 'invalid_phone'
  | 'invalid_code'
  | 'rate_limited'
  | 'too_many_attempts'
  | 'resend_wait'
  | 'unavailable';

export type OtpResult = { ok: true } | { ok: false; error: OtpError; retryAfterSeconds?: number };

const MAX_WRONG_CODES = 5;
const RESEND_SECONDS = 30;

/**
 * Phone sign-in orchestration with local guard rails (the auth server enforces its own limits; these
 * only stop an unattended screen or a stuck finger from hammering it). OTP delivery needs the SMS
 * provider and DLT registration planned for Phase 05; until then the server cannot send real codes.
 */
export class OtpFlow {
  private wrongCodes = 0;
  private lastSent = 0;
  /** The number a code was sent to. Kept here (not in a route parameter or URL) so it never appears in navigation state. */
  private pending: string | null = null;

  constructor(
    private readonly deps: { gotrue: GoTrueClient; session: SessionManager; now?: () => number },
  ) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  async requestCode(rawPhone: string): Promise<OtpResult & { phone?: string }> {
    const phone = normaliseIndianMobile(rawPhone);
    if (!phone) return { ok: false, error: 'invalid_phone' };
    const wait = RESEND_SECONDS - Math.floor((this.now() - this.lastSent) / 1000);
    if (this.lastSent > 0 && wait > 0)
      return { ok: false, error: 'resend_wait', retryAfterSeconds: wait };
    try {
      await this.deps.gotrue.requestPhoneOtp(phone);
      this.lastSent = this.now();
      this.wrongCodes = 0;
      this.pending = phone;
      return { ok: true, phone };
    } catch (error) {
      return { ok: false, error: this.map(error) };
    }
  }

  /** Masked-for-display use only; the number itself stays inside this object. */
  pendingPhone(): string | null {
    return this.pending;
  }

  /** Forget the pending number (the user chose to go back). */
  reset(): void {
    this.pending = null;
  }

  async verifyCode(rawCode: string): Promise<OtpResult> {
    const phone = this.pending;
    if (!phone) return { ok: false, error: 'invalid_phone' };
    if (this.wrongCodes >= MAX_WRONG_CODES) return { ok: false, error: 'too_many_attempts' };
    const code = rawCode.replace(/\s/g, '');
    if (!/^\d{6}$/.test(code)) return { ok: false, error: 'invalid_code' };
    try {
      const session = await this.deps.gotrue.verifyPhoneOtp(phone, code);
      await this.deps.session.setSession(session);
      this.wrongCodes = 0;
      this.pending = null;
      return { ok: true };
    } catch (error) {
      const mapped = this.map(error);
      if (mapped === 'invalid_code') this.wrongCodes += 1;
      return {
        ok: false,
        error: this.wrongCodes >= MAX_WRONG_CODES ? 'too_many_attempts' : mapped,
      };
    }
  }

  private map(error: unknown): OtpError {
    if (error instanceof AuthFailure) {
      if (error.code === 'rate_limited') return 'rate_limited';
      if (error.code === 'invalid_code' || error.code === 'invalid_credentials')
        return 'invalid_code';
    }
    return 'unavailable';
  }
}

export const OTP_MESSAGES: Record<OtpError, string> = {
  invalid_phone: 'Enter a valid 10-digit Indian mobile number.',
  invalid_code: 'That code is not correct. Check the SMS and try again.',
  rate_limited: 'Too many attempts. Please wait a few minutes and try again.',
  too_many_attempts: 'Too many wrong codes. Go back and request a new code.',
  resend_wait: 'Please wait before requesting another code.',
  unavailable: 'We could not reach the service. Check your connection and try again.',
};
