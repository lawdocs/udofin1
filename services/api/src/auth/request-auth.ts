import { type FastifyRequest } from 'fastify';
import { ApiError } from '../http/api-error.js';
import { type UserContext, type UserTx } from '../db/user-context.js';
import { type AuthDeps } from './deps.js';
import { TokenError, type VerifiedClaims } from './token-verifier.js';

export type ActorKind = 'borrower' | 'lender' | 'platform' | 'none' | 'system';

export interface Authenticated {
  claims: VerifiedClaims;
  actor: ActorKind;
}

export type AuthRequirement = 'user' | 'staff';

/**
 * Verifies the bearer token, asks the DATABASE who the caller is (never the token), and enforces
 * the second factor for staff and the route's audience. Throws ApiError; never sends a response.
 */
async function authenticate(deps: AuthDeps, request: FastifyRequest): Promise<VerifiedClaims> {
  try {
    return await deps.verifier.verify(request.headers.authorization);
  } catch (error) {
    const reason = error instanceof TokenError ? error.reason : 'invalid';
    throw new ApiError(401, `token_${reason}`, 'Unauthorized', undefined, {
      'www-authenticate': 'Bearer',
    });
  }
}

export async function runAsUser<T>(
  deps: { verifier: AuthDeps['verifier']; context: UserContext },
  request: FastifyRequest,
  requirement: AuthRequirement,
  handler: (tx: UserTx, auth: Authenticated) => Promise<T>,
): Promise<T> {
  const claims = await authenticate(deps, request);
  return deps.context.withUserContext(claims, async (tx) => {
    const row = await tx.query<{ actor: ActorKind }>('select private.current_actor() as actor');
    const actor = row.rows[0]?.actor ?? 'none';
    if (actor === 'none' || actor === 'system') {
      throw new ApiError(403, 'no_active_access', 'Forbidden');
    }
    const staff = actor === 'lender' || actor === 'platform';
    if (staff && claims.aal !== 'aal2') throw new ApiError(401, 'mfa_required', 'Unauthorized');
    if (requirement === 'staff' && !staff) throw new ApiError(403, 'staff_only', 'Forbidden');
    return handler(tx, { claims, actor });
  });
}
