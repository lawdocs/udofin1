import { type FastifyRequest } from 'fastify';
import { ApiError, SESSION_ENDED_HEADERS } from '../http/api-error.js';
import { type UserTx } from '../db/user-context.js';
import { type AuthDeps } from './deps.js';
import { type PrincipalLimits, type RouteLimit } from './principal-limits.js';
import { TokenError, type VerifiedClaims } from './token-verifier.js';

export type ActorKind = 'borrower' | 'lender' | 'platform' | 'none' | 'system';

export interface Authenticated {
  claims: VerifiedClaims;
  actor: ActorKind;
}

export type AuthRequirement = 'user' | 'staff' | 'borrower';

/**
 * Verifies the bearer token, asks the DATABASE who the caller is (never the token), and enforces
 * the second factor for staff and the route's audience. Throws ApiError; never sends a response.
 */
async function authenticate(
  deps: Pick<AuthDeps, 'verifier'>,
  request: FastifyRequest,
): Promise<VerifiedClaims> {
  try {
    return await deps.verifier.verify(request.headers.authorization);
  } catch (error) {
    const reason = error instanceof TokenError ? error.reason : 'invalid';
    throw new ApiError(401, `token_${reason}`, 'Unauthorized', undefined, {
      'www-authenticate': 'Bearer',
    });
  }
}

/** What `runAsUser` needs to rate-limit by principal. Optional so unit tests can call it without a Fastify app. */
export interface PrincipalLimitOptions {
  limits: PrincipalLimits;
  route: { id: string; limit?: RouteLimit | false | undefined };
}

export async function runAsUser<T>(
  deps: Pick<AuthDeps, 'verifier' | 'context' | 'requireSessionId'>,
  request: FastifyRequest,
  requirement: AuthRequirement,
  handler: (tx: UserTx, auth: Authenticated) => Promise<T>,
  limits?: PrincipalLimitOptions,
): Promise<T> {
  const claims = await authenticate(deps, request);
  // A token without a session cannot be checked for sign-out or revocation. Deployed environments
  // refuse it (Supabase always issues the claim); local/test accept it for fake verifiers.
  if (!claims.sessionId && deps.requireSessionId) {
    throw new ApiError(401, 'token_invalid', 'Unauthorized', undefined, {
      'www-authenticate': 'Bearer',
    });
  }
  return deps.context.withUserContext(claims, async (tx) => {
    // ONE round trip for both questions: is the session behind this token still alive (F-01), and who
    // is the caller. The session lookup is by primary key, scoped to the caller inside the function;
    // nothing is cached, so a sign-out takes effect on the very next request.
    const row = await tx.query<{ actor: ActorKind; active: boolean }>(
      'select private.current_actor() as actor, private.session_is_active($1::uuid) as active',
      [claims.sessionId],
    );
    if (claims.sessionId && row.rows[0]?.active !== true) {
      throw new ApiError(401, 'session_revoked', 'Unauthorized', undefined, SESSION_ENDED_HEADERS);
    }
    // The per-principal limit counts only requests whose token is signed, unexpired AND whose session is alive.
    // Counting earlier would let a revoked or expired (but still correctly signed) token burn the real user's
    // allowance (review T1). The in-memory counter is cheap, so doing this inside the transaction costs nothing.
    if (limits) await limits.limits.enforce(request, claims.sub, limits.route);
    const actor = row.rows[0]?.actor ?? 'none';
    if (actor === 'none' || actor === 'system') {
      throw new ApiError(403, 'no_active_access', 'Forbidden');
    }
    const staff = actor === 'lender' || actor === 'platform';
    if (staff && claims.aal !== 'aal2') throw new ApiError(401, 'mfa_required', 'Unauthorized');
    if (requirement === 'staff' && !staff) throw new ApiError(403, 'staff_only', 'Forbidden');
    if (requirement === 'borrower' && actor !== 'borrower')
      throw new ApiError(403, 'borrower_only', 'Forbidden');
    return handler(tx, { claims, actor });
  });
}
