import { type UserContext } from '../db/user-context.js';
import { type TokenVerifier } from './token-verifier.js';

export interface AuthDeps {
  verifier: TokenVerifier;
  context: UserContext;
}
