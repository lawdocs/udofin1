import { type UserContext } from '../db/user-context.js';
import { type TokenVerifier } from './token-verifier.js';

export interface AuthDeps {
  verifier: TokenVerifier;
  context: UserContext;
  /**
   * Refuse access tokens that carry no `session_id` claim (they cannot be checked for sign-out or
   * revocation). Set from `sessionIdRequired(config)`: true when deployed. Absent means false, which only
   * the fake verifiers of local and test setups rely on.
   */
  requireSessionId?: boolean;
}
