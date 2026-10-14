import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { z } from 'zod';

/** Verified identity taken from the access token. Permissions are NEVER read from the token. */
export interface VerifiedClaims {
  /** Supabase auth user id. */
  sub: string;
  /** Authenticator assurance level: aal2 means a second factor was completed in this session. */
  aal: 'aal1' | 'aal2';
  sessionId: string | null;
}

export type TokenFailure = 'missing' | 'invalid' | 'expired';

export class TokenError extends Error {
  override readonly name = 'TokenError';
  constructor(readonly reason: TokenFailure) {
    super(`token ${reason}`);
  }
}

export interface TokenVerifier {
  verify(authorizationHeader: string | undefined): Promise<VerifiedClaims>;
}

export interface TokenVerifierOptions {
  /** Expected `iss`, e.g. `https://<project>.supabase.co/auth/v1`. */
  issuer: string;
  /** Expected `aud`. Supabase uses `authenticated`. */
  audience: string;
  /** Key resolver (remote JWKS in production, a local key set in tests). */
  keys: JWTVerifyGetKey;
}

// Asymmetric algorithms only. `none` and shared-secret (HS*) tokens are never accepted, which
// closes algorithm-confusion attacks against a public JWKS.
const ALLOWED_ALGORITHMS = ['ES256', 'RS256', 'EdDSA'];
const BEARER = /^Bearer ([A-Za-z0-9._~+/=-]+)$/;

const ClaimsSchema = z.object({
  sub: z.uuid(),
  role: z.literal('authenticated'),
  aal: z.enum(['aal1', 'aal2']).default('aal1'),
  // Supabase Auth issues a uuid. Anything else is not a session we can look up, so the token is invalid.
  session_id: z.uuid().optional(),
  exp: z.number(),
});

export function createTokenVerifier(options: TokenVerifierOptions): TokenVerifier {
  return {
    async verify(header) {
      const match = header ? BEARER.exec(header) : null;
      if (!match?.[1]) throw new TokenError('missing');
      try {
        const { payload } = await jwtVerify(match[1], options.keys, {
          issuer: options.issuer,
          audience: options.audience,
          algorithms: ALLOWED_ALGORITHMS,
          requiredClaims: ['exp', 'sub', 'iss', 'aud'],
          clockTolerance: 5,
        });
        const parsed = ClaimsSchema.safeParse(payload);
        if (!parsed.success) throw new TokenError('invalid');
        return {
          sub: parsed.data.sub,
          aal: parsed.data.aal,
          sessionId: parsed.data.session_id ?? null,
        };
      } catch (error) {
        if (error instanceof TokenError) throw error;
        if (error instanceof errors.JWTExpired) throw new TokenError('expired');
        throw new TokenError('invalid');
      }
    },
  };
}

/** Remote JWKS for a Supabase project: cached, with a cool-down so unknown key ids cannot be used to hammer it. */
export function supabaseKeys(supabaseUrl: string): { issuer: string; keys: JWTVerifyGetKey } {
  const base = supabaseUrl.replace(/\/$/, '');
  return {
    issuer: `${base}/auth/v1`,
    keys: createRemoteJWKSet(new URL(`${base}/auth/v1/.well-known/jwks.json`), {
      cooldownDuration: 30_000,
      cacheMaxAge: 600_000,
      timeoutDuration: 3_000,
    }),
  };
}
