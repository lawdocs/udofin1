import { createHash } from 'node:crypto';
import { type MeResponse } from '@udofin/contracts';
import { z } from 'zod';
import { createApiClient } from '../api-client.js';
import { AuthFailure, readTokenClaims, type GoTrueClient, type Session } from '../gotrue.js';
import {
  clearSessionCookie,
  cookieNames,
  parseCookieHeader,
  serializeSessionCookie,
} from './cookies.js';
import { type RateLimiter } from './rate-limiter.js';

export type PortalAudience = 'platform' | 'lender';

export interface BffOptions {
  gotrue: GoTrueClient;
  /** The portal's own origin, e.g. https://ops.udofin.example. POSTs from any other origin are refused. */
  allowedOrigin: string;
  secureCookies: boolean;
  /** Which kind of staff this portal serves: the API's answer for /v1/me must match. */
  audience: PortalAudience;
  apiBaseUrl: string;
  rateLimiter: RateLimiter;
  /** Resolve the client address. Only trust forwarding headers behind a proxy you control. */
  clientIp?: (request: Request) => string;
  fetch?: typeof fetch;
  /** Epoch seconds. */
  now?: () => number;
}

export type PortalSessionState =
  | { state: 'unauthenticated' }
  | { state: 'mfa_required' }
  | { state: 'unavailable' }
  | { state: 'no_access' }
  | { state: 'wrong_portal' }
  | { state: 'ok'; me: MeResponse; accessToken: string };

const SignInBody = z.strictObject({
  email: z.email().max(254),
  password: z.string().min(1).max(256),
});
const VerifyBody = z.strictObject({
  factorId: z.string().min(1).max(100),
  code: z.string().regex(/^\d{6}$/),
});

const json = (
  status: number,
  body: unknown,
  setCookies: string[] = [],
  headers: Record<string, string> = {},
) => {
  const response = new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });
  for (const cookie of setCookies) response.headers.append('set-cookie', cookie);
  return response;
};

const sha = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32);

/**
 * Browser-facing sign-in for the staff portals (backend-for-frontend). Tokens live only in
 * HttpOnly, SameSite=Strict cookies set here; page scripts never see them. The API remains the
 * authority: these handlers decide nothing about permissions.
 */
export function createAuthHandlers(options: BffOptions) {
  const names = cookieNames(options.secureCookies);
  const cookieOpts = { secure: options.secureCookies };
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const ip = options.clientIp ?? (() => 'unknown');

  function sessionCookies(session: Session): string[] {
    return [
      serializeSessionCookie(names.access, session.accessToken, cookieOpts),
      serializeSessionCookie(names.refresh, session.refreshToken, cookieOpts),
    ];
  }
  const clearCookies = (): string[] => [
    clearSessionCookie(names.access, cookieOpts),
    clearSessionCookie(names.refresh, cookieOpts),
  ];

  function readTokens(request: Request): {
    access: string | undefined;
    refresh: string | undefined;
  } {
    const cookies = parseCookieHeader(request.headers.get('cookie'));
    return { access: cookies.get(names.access), refresh: cookies.get(names.refresh) };
  }

  /** CSRF defence in depth on top of SameSite=Strict: same-origin, JSON only. */
  function guard(request: Request): Response | undefined {
    const origin = request.headers.get('origin');
    const sameOrigin =
      origin !== null
        ? origin === options.allowedOrigin
        : request.headers.get('sec-fetch-site') === 'same-origin';
    if (!sameOrigin) return json(403, { error: 'forbidden_origin' });
    if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
      return json(415, { error: 'unsupported_media_type' });
    }
    return undefined;
  }

  async function body<T>(request: Request, schema: z.ZodType<T>): Promise<T | undefined> {
    try {
      const parsed = schema.safeParse(await request.json());
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  function failure(error: unknown): Response {
    if (error instanceof AuthFailure) {
      switch (error.code) {
        case 'rate_limited':
          return json(429, { error: 'rate_limited' }, [], { 'retry-after': '60' });
        case 'unavailable':
          return json(503, { error: 'unavailable' });
        case 'invalid_code':
          return json(401, { error: 'invalid_code' });
        case 'invalid_session':
          return json(401, { error: 'invalid_session' }, clearCookies());
        case 'invalid_credentials':
          return json(401, { error: 'invalid_credentials' });
      }
    }
    return json(503, { error: 'unavailable' });
  }

  const apiClientFor = (accessToken: string) =>
    createApiClient({
      baseUrl: options.apiBaseUrl,
      getAccessToken: () => Promise.resolve(accessToken),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });

  /** Asks the API who this session is (the API verifies the token and resolves permissions). */
  async function loadSession(accessToken: string | undefined): Promise<PortalSessionState> {
    if (!accessToken) return { state: 'unauthenticated' };
    const result = await apiClientFor(accessToken).me();
    if (result.ok) {
      const expected = options.audience;
      if (result.data.actor !== expected) return { state: 'wrong_portal' };
      return { state: 'ok', me: result.data, accessToken };
    }
    if (result.code === 'mfa_required') return { state: 'mfa_required' };
    if (result.status === 401) return { state: 'unauthenticated' };
    if (result.status === 403) return { state: 'no_access' };
    return { state: 'unavailable' };
  }

  return {
    names,

    /** POST { email, password } */
    async signIn(request: Request): Promise<Response> {
      const blocked = guard(request);
      if (blocked) return blocked;
      const input = await body(request, SignInBody);
      if (!input) return json(400, { error: 'invalid_request' });
      // Count attempts per address AND per account (hashed), whether or not the account exists.
      const account = sha(input.email.toLowerCase());
      if (
        !options.rateLimiter.hit(`signin:ip:${ip(request)}`, 20, 900) ||
        // Per address AND account: one attacker cannot lock a real user out of their own sign-in
        // from elsewhere. A looser account-wide ceiling backstops distributed guessing; Supabase's own
        // limits and the second factor are the authoritative protection.
        !options.rateLimiter.hit(`signin:acct-ip:${ip(request)}:${account}`, 8, 900) ||
        !options.rateLimiter.hit(`signin:acct:${account}`, 60, 900)
      ) {
        return json(429, { error: 'rate_limited' }, [], { 'retry-after': '900' });
      }
      try {
        const session = await options.gotrue.signInWithPassword(input.email, input.password);
        const factors = await options.gotrue.listFactors(session.accessToken);
        const verified = factors.find((f) => f.type === 'totp' && f.status === 'verified');
        const cookies = sessionCookies(session);
        if (session.aal === 'aal2') return json(200, { next: 'done' }, cookies);
        return json(
          200,
          verified ? { next: 'mfa_verify', factorId: verified.id } : { next: 'mfa_enrol' },
          cookies,
        );
      } catch (error) {
        return failure(error);
      }
    },

    /** POST {} — starts TOTP enrolment for the signed-in (aal1) user. */
    async enrolMfa(request: Request): Promise<Response> {
      const blocked = guard(request);
      if (blocked) return blocked;
      const { access } = readTokens(request);
      if (!access) return json(401, { error: 'invalid_session' });
      const userId = readTokenClaims(access)?.sub ?? 'unknown';
      if (!options.rateLimiter.hit(`mfa-enrol:${ip(request)}:${userId}`, 5, 900))
        return json(429, { error: 'rate_limited' });
      try {
        const factors = await options.gotrue.listFactors(access);
        if (factors.some((f) => f.type === 'totp' && f.status === 'verified')) {
          return json(409, { error: 'already_enrolled' }); // an existing factor must be verified, never replaced silently
        }
        const enrolment = await options.gotrue.enrolTotp(
          access,
          `Udofin ${new Date(now() * 1000).toISOString().slice(0, 10)}`,
        );
        return json(200, {
          factorId: enrolment.factorId,
          qrCode: enrolment.qrCode,
          secret: enrolment.secret,
        });
      } catch (error) {
        return failure(error);
      }
    },

    /** POST { factorId, code } — completes the second factor and upgrades the session to aal2. */
    async verifyMfa(request: Request): Promise<Response> {
      const blocked = guard(request);
      if (blocked) return blocked;
      const input = await body(request, VerifyBody);
      if (!input) return json(400, { error: 'invalid_request' });
      const { access } = readTokens(request);
      if (!access) return json(401, { error: 'invalid_session' });
      const userId = readTokenClaims(access)?.sub ?? 'unknown';
      if (!options.rateLimiter.hit(`mfa-verify:${ip(request)}:${userId}`, 6, 300)) {
        return json(429, { error: 'rate_limited' }, [], { 'retry-after': '300' });
      }
      try {
        const session = await options.gotrue.verifyTotp(access, input.factorId, input.code);
        const state = await loadSession(session.accessToken);
        if (state.state === 'wrong_portal' || state.state === 'no_access') {
          // The account is valid but is not staff for this portal: end the session, tell the user plainly.
          await options.gotrue.signOut(session.accessToken).catch(() => undefined);
          return json(403, { error: state.state }, clearCookies());
        }
        if (state.state !== 'ok') return json(503, { error: 'unavailable' });
        return json(200, { next: 'done' }, sessionCookies(session));
      } catch (error) {
        return failure(error);
      }
    },

    /** POST {} — ends the session. Cookies are cleared even if the auth server cannot be reached. */
    async signOut(request: Request): Promise<Response> {
      const blocked = guard(request);
      if (blocked) return blocked;
      const { access } = readTokens(request);
      if (access) await options.gotrue.signOut(access).catch(() => undefined);
      return json(200, { next: 'signed_out' }, clearCookies());
    },

    /**
     * For proxy.ts: refreshes the session when the access token is near expiry. Returns the cookies
     * to set on the response and the merged Cookie header the current request should continue with,
     * or cookies to clear when the refresh token is no longer accepted (expired / revoked session).
     */
    async refreshIfNeeded(
      request: Request,
    ): Promise<{ setCookies: string[]; cookieHeader?: string }> {
      const { access, refresh } = readTokens(request);
      if (!refresh) return { setCookies: [] };
      const claims = access ? readTokenClaims(access) : undefined;
      if (claims && claims.exp - now() > 60) return { setCookies: [] };
      try {
        const session = await options.gotrue.refresh(refresh);
        const header = parseCookieHeader(request.headers.get('cookie'));
        header.set(names.access, session.accessToken);
        header.set(names.refresh, session.refreshToken);
        return {
          setCookies: sessionCookies(session),
          cookieHeader: [...header].map(([k, v]) => `${k}=${v}`).join('; '),
        };
      } catch (error) {
        if (error instanceof AuthFailure && error.code === 'invalid_session') {
          // Forget the dead session for this request too, so the page renders the signed-out state.
          const header = parseCookieHeader(request.headers.get('cookie'));
          header.delete(names.access);
          header.delete(names.refresh);
          return {
            setCookies: clearCookies(),
            cookieHeader: [...header].map(([k, v]) => `${k}=${v}`).join('; '),
          };
        }
        return { setCookies: [] }; // temporary trouble: keep cookies, the page shows its error state
      }
    },

    /** For server components: who is this, as the API sees it? */
    async portalSession(request: Pick<Request, 'headers'>): Promise<PortalSessionState> {
      return loadSession(readTokens(request as Request).access);
    },
  };
}

export type AuthHandlers = ReturnType<typeof createAuthHandlers>;
