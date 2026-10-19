import { type MessageKey } from '../i18n';
import { errorKey } from './errors';

/**
 * Stable API codes of the loan, statement, quotation, closure and reminder routes to message keys. The shared `errors.ts`
 * has no extension point, so this table is asked first and the shared one second. A code nobody listed becomes a generic
 * sentence: raw server text and raw codes never reach a screen.
 */
const MAP: Readonly<Record<string, MessageKey>> = {
  not_found: 'loans.err.notFound',
  http_404: 'loans.err.notFound',
  feature_disabled: 'loans.err.featureDisabled',
  loan_status_not_eligible: 'loans.err.statusNotEligible',
  loan_not_active: 'loans.err.loanNotActive',
  open_request_exists: 'loans.err.openRequestExists',
  idempotency_conflict: 'loans.err.conflict',
  period_invalid: 'loans.err.periodInvalid',
  request_not_open: 'loans.err.requestNotOpen',
  invalid_cursor: 'loans.err.cursor',
  document_store_unavailable: 'loans.err.documentsUnavailable',
  borrower_only: 'loans.err.noAccess',
  no_active_access: 'loans.err.noAccess',
  http_403: 'loans.err.noAccess',
  session_revoked: 'error.signedOut',
  validation_failed: 'error.invalidInput',
};

/** Message key for any failure code the loan screens can meet (including the client's own codes such as network_error). */
export function servicingErrorKey(code: string): MessageKey {
  const own = MAP[code];
  if (own) return own;
  if (code.startsWith('token_')) return 'error.signedOut';
  return errorKey(code);
}

/** The codes this file maps itself, for the tests that check every one has wording in both languages. */
export const SERVICING_ERROR_CODES: readonly string[] = Object.keys(MAP);
