import { z } from 'zod';

/**
 * Minimal client for Supabase Auth (GoTrue) over fetch. It only ever uses the PUBLISHABLE key
 * (anon-equivalent). Service/secret keys must never reach this package or any bundle.
 *
 * Error handling: callers receive a small set of stable failure codes, never the server's
 * message, so nothing here can leak whether an account exists or why a login failed.
 */

export type AuthFailureCode =
  'invalid_credentials' | 'invalid_code' | 'invalid_session' | 'rate_limited' | 'unavailable';

export class AuthFailure extends Error {
  override readonly name = 'AuthFailure';
  constructor(readonly code: AuthFailureCode) {
    super(code);
  }
}

export interface Session {
  accessToken: string;
  refreshToken: string;
  /** Epoch seconds. */
  expiresAt: number;
  userId: string;
  /** Authenticator assurance level read from the token (display only; the API verifies). */
  aal: 'aal1' | 'aal2';
}

export interface Factor {
  id: string;
  type: string;
  status: 'verified' | 'unverified';
}

export interface TotpEnrolment {
  factorId: string;
  /** Data URI of the QR code as returned by the auth server. */
  qrCode: string;
  secret: string;
  uri: string;
}

const SessionResponse = z.object({
  access_token: z.string().min(20),
  refresh_token: z.string().min(1),
  expires_in: z.number().optional(),
  expires_at: z.number().optional(),
  user: z.object({ id: z.uuid() }).optional(),
});

const UserResponse = z.object({
  id: z.uuid(),
  factors: z
    .array(
      z.object({
        id: z.string(),
        factor_type: z.string(),
        status: z.enum(['verified', 'unverified']),
      }),
    )
    .nullish(),
});

const EnrolResponse = z.object({
  id: z.string(),
  totp: z.object({ qr_code: z.string(), secret: z.string(), uri: z.string() }),
});

const ChallengeResponse = z.object({ id: z.string() });

export interface GoTrueOptions {
  /** e.g. https://<ref>.supabase.co (no trailing slash needed). */
  baseUrl: string;
  /** The publishable key. */
  publishableKey: string;
  fetch?: typeof fetch;
  /** Seconds; injected for tests. */
  now?: () => number;
  timeoutMs?: number;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Portable base64url -> UTF-8 string (no Buffer/atob, so it also runs on Hermes). */
export function base64UrlToString(input: string): string {
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of input.replace(/=+$/, '')) {
    const index = B64.indexOf(ch);
    if (index < 0) throw new Error('invalid base64url');
    value = (value << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >> bits) & 0xff);
    }
  }
  return decodeURIComponent(bytes.map((b) => `%${b.toString(16).padStart(2, '0')}`).join(''));
}

/** Reads aal/sub/exp from an access token WITHOUT verifying it. For display and refresh timing only. */
export function readTokenClaims(
  accessToken: string,
): { sub: string; aal: 'aal1' | 'aal2'; exp: number } | undefined {
  const part = accessToken.split('.')[1];
  if (!part) return undefined;
  try {
    const json = JSON.parse(base64UrlToString(part)) as Record<string, unknown>;
    const sub = typeof json.sub === 'string' ? json.sub : undefined;
    const exp = typeof json.exp === 'number' ? json.exp : undefined;
    if (!sub || exp === undefined) return undefined;
    return { sub, aal: json.aal === 'aal2' ? 'aal2' : 'aal1', exp };
  } catch {
    return undefined;
  }
}

export interface GoTrueClient {
  signInWithPassword(email: string, password: string): Promise<Session>;
  refresh(refreshToken: string): Promise<Session>;
  signOut(accessToken: string): Promise<void>;
  listFactors(accessToken: string): Promise<Factor[]>;
  enrolTotp(accessToken: string, friendlyName: string): Promise<TotpEnrolment>;
  verifyTotp(accessToken: string, factorId: string, code: string): Promise<Session>;
  /** Borrower phone sign-in: sends an SMS OTP (delivery needs the SMS provider configured in Phase 05). */
  requestPhoneOtp(phoneE164: string): Promise<void>;
  verifyPhoneOtp(phoneE164: string, code: string): Promise<Session>;
}

/**
 * Refuses privileged keys. A service/secret key in a portal or mobile configuration would hand the
 * whole database to anyone who can read the bundle or the environment, so this fails at start-up.
 */
export function assertPublishableKey(key: string): void {
  if (key.startsWith('sb_secret_'))
    throw new Error(
      'a Supabase secret key was configured where only the publishable key is allowed',
    );
  if (key.split('.').length === 3) {
    const role = (() => {
      try {
        return (JSON.parse(base64UrlToString(key.split('.')[1] ?? '')) as { role?: unknown }).role;
      } catch {
        return undefined;
      }
    })();
    if (role === 'service_role')
      throw new Error(
        'a Supabase service_role key was configured where only the publishable key is allowed',
      );
  }
}

export function createGoTrueClient(options: GoTrueOptions): GoTrueClient {
  assertPublishableKey(options.publishableKey);
  const base = `${options.baseUrl.replace(/\/$/, '')}/auth/v1`;
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));

  async function call(
    path: string,
    init: { method: 'GET' | 'POST'; body?: unknown; accessToken?: string },
    failure: AuthFailureCode,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, {
        method: init.method,
        headers: {
          apikey: options.publishableKey,
          'content-type': 'application/json',
          ...(init.accessToken ? { authorization: `Bearer ${init.accessToken}` } : {}),
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        signal: AbortSignal.timeout(options.timeoutMs ?? 8_000),
      });
    } catch {
      throw new AuthFailure('unavailable');
    }
    if (response.status === 429) throw new AuthFailure('rate_limited');
    if (response.status >= 500) throw new AuthFailure('unavailable');
    if (!response.ok) throw new AuthFailure(failure);
    if (response.status === 204) return undefined;
    try {
      return await response.json();
    } catch {
      throw new AuthFailure('unavailable');
    }
  }

  function toSession(raw: unknown): Session {
    const parsed = SessionResponse.safeParse(raw);
    if (!parsed.success) throw new AuthFailure('unavailable');
    const claims = readTokenClaims(parsed.data.access_token);
    const expiresAt =
      parsed.data.expires_at ?? claims?.exp ?? now() + (parsed.data.expires_in ?? 900);
    const userId = parsed.data.user?.id ?? claims?.sub;
    if (!userId) throw new AuthFailure('unavailable');
    return {
      accessToken: parsed.data.access_token,
      refreshToken: parsed.data.refresh_token,
      expiresAt,
      userId,
      aal: claims?.aal ?? 'aal1',
    };
  }

  return {
    async signInWithPassword(email, password) {
      return toSession(
        await call(
          '/token?grant_type=password',
          { method: 'POST', body: { email, password } },
          'invalid_credentials',
        ),
      );
    },
    async refresh(refreshToken) {
      return toSession(
        await call(
          '/token?grant_type=refresh_token',
          { method: 'POST', body: { refresh_token: refreshToken } },
          'invalid_session',
        ),
      );
    },
    async signOut(accessToken) {
      await call('/logout?scope=local', { method: 'POST', accessToken }, 'invalid_session');
    },
    async listFactors(accessToken) {
      const raw = await call('/user', { method: 'GET', accessToken }, 'invalid_session');
      const parsed = UserResponse.safeParse(raw);
      if (!parsed.success) throw new AuthFailure('unavailable');
      return (parsed.data.factors ?? []).map((f) => ({
        id: f.id,
        type: f.factor_type,
        status: f.status,
      }));
    },
    async enrolTotp(accessToken, friendlyName) {
      const raw = await call(
        '/factors',
        {
          method: 'POST',
          accessToken,
          body: { factor_type: 'totp', friendly_name: friendlyName, issuer: 'Udofin' },
        },
        'invalid_session',
      );
      const parsed = EnrolResponse.safeParse(raw);
      if (!parsed.success) throw new AuthFailure('unavailable');
      return {
        factorId: parsed.data.id,
        qrCode: parsed.data.totp.qr_code,
        secret: parsed.data.totp.secret,
        uri: parsed.data.totp.uri,
      };
    },
    async verifyTotp(accessToken, factorId, code) {
      const challenge = ChallengeResponse.safeParse(
        await call(
          `/factors/${encodeURIComponent(factorId)}/challenge`,
          { method: 'POST', accessToken, body: {} },
          'invalid_session',
        ),
      );
      if (!challenge.success) throw new AuthFailure('unavailable');
      return toSession(
        await call(
          `/factors/${encodeURIComponent(factorId)}/verify`,
          { method: 'POST', accessToken, body: { challenge_id: challenge.data.id, code } },
          'invalid_code',
        ),
      );
    },
    async requestPhoneOtp(phone) {
      await call(
        '/otp',
        { method: 'POST', body: { phone, create_user: true, channel: 'sms' } },
        'invalid_credentials',
      );
    },
    async verifyPhoneOtp(phone, code) {
      return toSession(
        await call(
          '/verify',
          { method: 'POST', body: { type: 'sms', phone, token: code } },
          'invalid_code',
        ),
      );
    },
  };
}
