import { type MessageKey } from '../i18n';
import { errorKey } from './errors';
import { CLIENT_REFUSAL } from './payments';

/**
 * Stable API codes of the payment and mandate routes to message keys. Raw server text is never shown: a code this table does not
 * know falls back to the shared mapping and then to the generic sentence. Codes come from docs/specs/08a-notes/api-payments.md.
 */
const MAP: Readonly<Record<string, MessageKey>> = {
  // shape and keys
  not_found: 'error.notFound',
  [CLIENT_REFUSAL]: 'error.invalidInput',
  bad_request: 'error.invalidInput',
  invalid_request: 'error.invalidInput',
  validation_failed: 'error.invalidInput',
  idempotency_key_required: 'error.invalidInput',
  idempotency_conflict: 'pay.err.conflict',
  idempotency_key_reused: 'pay.err.conflict',
  // paying
  amount_not_allowed: 'pay.err.amountNotAllowed',
  feature_disabled: 'pay.err.featureOff',
  loan_not_active: 'pay.err.loanNotActive',
  collection_target_invalid: 'pay.err.targetInvalid',
  config_ambiguous: 'pay.err.targetInvalid',
  figures_unavailable: 'pay.err.figuresUnavailable',
  stale_data: 'pay.err.stale',
  nothing_due: 'pay.err.nothingDue',
  purpose_not_supported: 'pay.err.purposeOff',
  purpose_not_enabled: 'pay.err.purposeOff',
  quote_required: 'pay.err.quoteRequired',
  quote_not_current: 'pay.err.quoteNotCurrent',
  quote_flagged: 'pay.err.quoteFlagged',
  open_intent_exists: 'pay.err.openExists',
  mock_provider_blocked: 'pay.err.blocked',
  intent_not_cancellable: 'pay.err.notCancellable',
  handoff_unavailable: 'pay.err.handoffUnavailable',
  // mandates
  stepup_required: 'mandate.err.stepup',
  integrity_insufficient: 'mandate.err.integrity',
  provider_not_mandate_capable: 'mandate.err.providerNotCapable',
  creditor_not_lender: 'mandate.err.creditor',
  rail_not_configured: 'mandate.err.rail',
  mandate_exists: 'mandate.err.exists',
  dates_invalid: 'mandate.err.dates',
  account_ref_invalid: 'mandate.err.account',
  mandate_finished: 'mandate.err.finished',
};

export const payErrorKey = (code: string): MessageKey => MAP[code] ?? errorKey(code);

/** Codes after which the options or the payment on screen are out of date, so the screen reads them again. */
const REFRESH_AFTER = new Set([
  'figures_unavailable',
  'stale_data',
  'nothing_due',
  'purpose_not_supported',
  'purpose_not_enabled',
  'quote_required',
  'quote_not_current',
  'quote_flagged',
  'open_intent_exists',
  'loan_not_active',
  'collection_target_invalid',
  'config_ambiguous',
  'feature_disabled',
  'intent_not_cancellable',
  'mandate_exists',
  'mandate_finished',
]);
export const refreshAfterError = (code: string): boolean => REFRESH_AFTER.has(code);

/** After these the mandate id (and with it the step-up code) cannot be reused: the next attempt starts with a new id. */
export const needsNewMandateId = (code: string): boolean =>
  code === 'idempotency_conflict' || code === 'idempotency_key_reused';
