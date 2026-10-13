import { PROBLEM_CONTENT_TYPE, type ProblemDetails } from '@udofin/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { TokenError, type TokenVerifier, type VerifiedClaims } from './token-verifier.js';
import { type UserContext, type UserTx } from '../db/user-context.js';

export type ActorKind = 'borrower' | 'lender' | 'platform' | 'none' | 'system';

export interface Authenticated {
  claims: VerifiedClaims;
  actor: ActorKind;
}

export function sendProblem(
  reply: FastifyReply,
  request: FastifyRequest,
  status: number,
  title: string,
  code: string,
  detail?: string,
): FastifyReply {
  const body: ProblemDetails = {
    type: 'about:blank',
    title,
    status,
    code,
    instance: request.id,
    ...(detail ? { detail } : {}),
  };
  return reply.code(status).type(PROBLEM_CONTENT_TYPE).send(body);
}

export interface AuthOptions {
  /** `staff` routes require a lender or platform user who completed the second factor (aal2). */
  require: 'any_user' | 'staff';
}

/**
 * Verifies the bearer token, asks the DATABASE who the caller is (never the token), enforces MFA
 * for staff, and runs `handler` inside a user-context transaction. Sends the problem response and
 * returns undefined when the caller is not allowed.
 */
export async function withAuthenticatedUser<T>(
  deps: { verifier: TokenVerifier; context: UserContext },
  request: FastifyRequest,
  reply: FastifyReply,
  options: AuthOptions,
  handler: (tx: UserTx, auth: Authenticated) => Promise<T>,
): Promise<T | undefined> {
  let claims: VerifiedClaims;
  try {
    claims = await deps.verifier.verify(request.headers.authorization);
  } catch (error) {
    const reason = error instanceof TokenError ? error.reason : 'invalid';
    reply.header('www-authenticate', 'Bearer');
    sendProblem(reply, request, 401, 'Unauthorized', `token_${reason}`);
    return undefined;
  }

  let denied: { status: number; title: string; code: string } | undefined;
  const result = await deps.context.withUserContext(claims, async (tx) => {
    const row = await tx.query<{ actor: ActorKind }>('select private.current_actor() as actor');
    const actor = row.rows[0]?.actor ?? 'none';
    if (actor === 'none' || actor === 'system') {
      denied = { status: 403, title: 'Forbidden', code: 'no_active_access' };
      return undefined;
    }
    const staff = actor === 'lender' || actor === 'platform';
    if (staff && claims.aal !== 'aal2') {
      denied = { status: 401, title: 'Unauthorized', code: 'mfa_required' };
      return undefined;
    }
    if (options.require === 'staff' && !staff) {
      denied = { status: 403, title: 'Forbidden', code: 'staff_only' };
      return undefined;
    }
    return handler(tx, { claims, actor });
  });
  if (denied) {
    sendProblem(reply, request, denied.status, denied.title, denied.code);
    return undefined;
  }
  return result;
}
