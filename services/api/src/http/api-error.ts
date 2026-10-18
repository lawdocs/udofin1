import { z } from 'zod';

/** Thrown by handlers for expected failures; rendered as RFC 9457 problem+json. Rolls back the request transaction. */
export class ApiError extends Error {
  override readonly name = 'ApiError';
  constructor(
    readonly status: number,
    readonly code: string,
    readonly title: string,
    readonly detail?: string,
    readonly headers?: Record<string, string>,
  ) {
    super(`${status} ${code}`);
  }
}

export const ProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  code: z.string(),
  instance: z.string(),
  detail: z.string().optional(),
});

/** Sent with 401 `session_revoked`: the token was valid but its session has ended (sign-out, revocation, time-box). */
export const SESSION_ENDED_HEADERS: Readonly<Record<string, string>> = {
  'www-authenticate': 'Bearer error="invalid_token"',
};

interface PgLikeError {
  code?: string;
  hint?: string;
  message?: string;
}

/**
 * Hints raised by our own SQL functions that are stable, safe to show and useful to a client. The
 * hint becomes the problem `code`. Messages are shown only for hints whose text carries no data.
 */
const RULE_HINTS: Readonly<Record<string, { showMessage: boolean }>> = {
  self_approval: { showMessage: false },
  gate_not_met: { showMessage: true },
  gate_order: { showMessage: false },
  gate_stale: { showMessage: false },
  evidence_required: { showMessage: false },
  unconfirmed_not_verifiable: { showMessage: false },
  version_immutable: { showMessage: false },
  agreed_scope_required: { showMessage: false },
  dependency_open: { showMessage: false },
  unsafe_free_text: { showMessage: false },
  document_quarantined: { showMessage: false },
  waiver_not_allowed: { showMessage: false },
  draft_expired: { showMessage: false },
  version_conflict: { showMessage: false },
  consent_required: { showMessage: false },
  purpose_unknown: { showMessage: false },
  not_editable: { showMessage: false },
  marketing_disabled: { showMessage: false },
  wording_not_approved: { showMessage: false },
  notice_superseded: { showMessage: false },
  rate_limited: { showMessage: false },
  stepup_required: { showMessage: false },
  account_closed: { showMessage: false },
  account_closing: { showMessage: false },
  product_unavailable: { showMessage: false },
  too_many_drafts: { showMessage: false },
  tenure_out_of_range: { showMessage: false },
  category_unavailable: { showMessage: false },
  language_unsupported: { showMessage: false },
  purpose_unsupported: { showMessage: false },
  expiry_fixed: { showMessage: false },
  too_many_lenders: { showMessage: false },
  too_many_settlement_accounts: { showMessage: false },
  duplicate_lender: { showMessage: false },
  lender_not_available: { showMessage: false },
  already_routed: { showMessage: false },
  selection_empty: { showMessage: false },
  invalid_selection: { showMessage: false },
  product_required: { showMessage: false },
  request_not_submitted: { showMessage: false },
  selection_closed: { showMessage: false },
  not_selected: { showMessage: false },
  application_not_approved: { showMessage: false },
  invalid_transition: { showMessage: false },
  invalid_state: { showMessage: false },
  reference_conflict: { showMessage: false },
  status_unknown: { showMessage: false },
  decision_unknown: { showMessage: false },
  time_invalid: { showMessage: false },
  offer_invalid: { showMessage: false },
  offer_already_accepted: { showMessage: false },
  offer_not_found: { showMessage: false },
  ranking_rule_not_approved: { showMessage: false },
  sort_unsupported: { showMessage: false },
  segregation_of_duties: { showMessage: false },
  connector_kind_invalid: { showMessage: false },
  signing_secret_required: { showMessage: false },
  already_decided: { showMessage: false },
  mock_connector_blocked: { showMessage: false },
  calendar_missing: { showMessage: false },
  calendar_incomplete: { showMessage: false },
  kfs_input_missing: { showMessage: false },
  kfs_input_held: { showMessage: false },
  kfs_input_stale: { showMessage: false },
  lender_inactive: { showMessage: false },
  product_inactive: { showMessage: false },
  offer_withdrawn: { showMessage: false },
  offer_expired: { showMessage: false },
  offer_not_current: { showMessage: false },
  offer_not_accepted: { showMessage: false },
  offer_superseded: { showMessage: false },
  applicability_unresolved: { showMessage: false },
  applicability_ambiguous: { showMessage: false },
  template_not_ready: { showMessage: false },
  document_type_not_ready: { showMessage: false },
  kfs_not_issued: { showMessage: false },
  validity_rule_missing: { showMessage: false },
  offer_validity_shorter_than_kfs: { showMessage: false },
  hash_mismatch: { showMessage: false },
  approval_required: { showMessage: false },
  draft_stale: { showMessage: false },
  newer_version_exists: { showMessage: false },
  summary_box_mismatch: { showMessage: false },
  accepted_cannot_withdraw: { showMessage: false },
  reviewer_required: { showMessage: false },
  lender_confirmation_required: { showMessage: false },
  template_engine_unknown: { showMessage: false },
  kfs_data_invalid: { showMessage: false },
  document_not_opened: { showMessage: false },
  kfs_not_current: { showMessage: false },
  kfs_expired: { showMessage: false },
  consent_withdrawn: { showMessage: false },
  wording_not_found: { showMessage: false },
  sections_not_shown: { showMessage: false },
  explicit_action_required: { showMessage: false },
  acknowledgement_required: { showMessage: false },
  versions_inconsistent: { showMessage: false },
  kfs_missing: { showMessage: false },
  another_offer_accepted: { showMessage: false },
  already_accepted: { showMessage: false },
  mock_signing_blocked: { showMessage: false },
  signing_not_available: { showMessage: false },
  agreement_not_current: { showMessage: false },
  agreement_not_pending: { showMessage: false },
  job_not_running: { showMessage: false },
  proposal_no_taken: { showMessage: false },
  sample_blocked: { showMessage: false },
  document_immutable: { showMessage: false },
  // Phase 08a (servicing, payments, mandates, reconciliation, reminders). Stable codes from the SQL hints; none shows a message.
  account_already_registered: { showMessage: false },
  account_format_unvalidated: { showMessage: false },
  account_ref_invalid: { showMessage: false },
  account_registered_under_other_key: { showMessage: false },
  already_confirmed: { showMessage: false },
  already_linked: { showMessage: false },
  already_rekeyed: { showMessage: false },
  already_released: { showMessage: false },
  already_retired: { showMessage: false },
  already_submitted: { showMessage: false },
  already_superseded: { showMessage: false },
  already_verified: { showMessage: false },
  amount_not_allowed: { showMessage: false },
  as_of_invalid: { showMessage: false },
  assignee_invalid: { showMessage: false },
  attestation_missing: { showMessage: false },
  bad_request: { showMessage: false },
  bad_status: { showMessage: false },
  batch_failed: { showMessage: false },
  batch_invalid: { showMessage: false },
  batch_not_previewed: { showMessage: false },
  batch_not_rejectable: { showMessage: false },
  batch_rejected: { showMessage: false },
  capabilities_invalid: { showMessage: false },
  catalog_is_migration_only: { showMessage: false },
  channels_invalid: { showMessage: false },
  charge_invalid: { showMessage: false },
  closure_immutable: { showMessage: false },
  collateral_types_invalid: { showMessage: false },
  collection_target_invalid: { showMessage: false },
  config_ambiguous: { showMessage: false },
  config_state_invalid: { showMessage: false },
  confirmation_ref_invalid: { showMessage: false },
  conflict_not_acknowledged: { showMessage: false },
  conflict_not_open: { showMessage: false },
  conflict_resolved: { showMessage: false },
  connection_not_active: { showMessage: false },
  connector_unverified: { showMessage: false },
  creditor_not_lender: { showMessage: false },
  cutoff_invalid: { showMessage: false },
  dates_invalid: { showMessage: false },
  endpoint_token_hash_invalid: { showMessage: false },
  endpoint_token_in_use: { showMessage: false },
  errors_invalid: { showMessage: false },
  event_not_correlated: { showMessage: false },
  event_not_normalised: { showMessage: false },
  evidence_invalid: { showMessage: false },
  evidence_missing: { showMessage: false },
  evidence_ref_invalid: { showMessage: false },
  exception_state_invalid: { showMessage: false },
  feature_disabled: { showMessage: false },
  feature_not_enableable: { showMessage: false },
  feed_not_active: { showMessage: false },
  figures_unavailable: { showMessage: false },
  fingerprint_invalid: { showMessage: false },
  format_unsupported: { showMessage: false },
  free_text_settlement_ref: { showMessage: false },
  hold_active: { showMessage: false },
  hold_invalid: { showMessage: false },
  idempotency_conflict: { showMessage: false },
  idempotency_key_invalid: { showMessage: false },
  import_has_errors: { showMessage: false },
  integrity_insufficient: { showMessage: false },
  intent_state_invalid: { showMessage: false },
  issued_at_invalid: { showMessage: false },
  key_version_invalid: { showMessage: false },
  key_version_not_active: { showMessage: false },
  key_version_not_allowed: { showMessage: false },
  kind_invalid: { showMessage: false },
  legal_owner_name_invalid: { showMessage: false },
  lender_confirmation_only: { showMessage: false },
  lender_reference_reused: { showMessage: false },
  letter_invalid: { showMessage: false },
  link_expiry_invalid: { showMessage: false },
  loan_not_active: { showMessage: false },
  loan_not_closed: { showMessage: false },
  loan_status_not_eligible: { showMessage: false },
  mandate_exists: { showMessage: false },
  mandate_finished: { showMessage: false },
  masked_ref_invalid: { showMessage: false },
  masked_ref_mismatch: { showMessage: false },
  merchant_already_claimed: { showMessage: false },
  merchant_invalid: { showMessage: false },
  merchant_not_active: { showMessage: false },
  merchant_ref_invalid: { showMessage: false },
  mime_not_allowed: { showMessage: false },
  mock_provider_blocked: { showMessage: false },
  money_invalid: { showMessage: false },
  no_change: { showMessage: false },
  not_a_draft: { showMessage: false },
  not_a_lender: { showMessage: false },
  not_claimed: { showMessage: false },
  not_effective: { showMessage: false },
  not_proposed: { showMessage: false },
  not_revocable: { showMessage: false },
  not_sent: { showMessage: false },
  not_submitted: { showMessage: false },
  not_unverified: { showMessage: false },
  note_invalid: { showMessage: false },
  nothing_due: { showMessage: false },
  offsets_invalid: { showMessage: false },
  open_intent_exists: { showMessage: false },
  open_request_exists: { showMessage: false },
  order_ref_invalid: { showMessage: false },
  other_fingerprints_incomplete: { showMessage: false },
  other_fingerprints_invalid: { showMessage: false },
  owner_invalid: { showMessage: false },
  penal_text_variable_missing: { showMessage: false },
  pending_request_exists: { showMessage: false },
  period_does_not_cover_request: { showMessage: false },
  period_invalid: { showMessage: false },
  period_not_allowed: { showMessage: false },
  policy_invalid: { showMessage: false },
  prerequisites_unmet: { showMessage: false },
  proposal_open: { showMessage: false },
  provider_invalid: { showMessage: false },
  provider_mismatch: { showMessage: false },
  provider_mode_invalid: { showMessage: false },
  provider_not_mandate_capable: { showMessage: false },
  provider_ref_mismatch: { showMessage: false },
  purpose_invalid: { showMessage: false },
  purpose_not_enabled: { showMessage: false },
  purpose_not_supported: { showMessage: false },
  purposes_invalid: { showMessage: false },
  quote_already_expired: { showMessage: false },
  quote_flagged: { showMessage: false },
  quote_not_current: { showMessage: false },
  quote_ref_reused: { showMessage: false },
  quote_required: { showMessage: false },
  rail_limits_invalid: { showMessage: false },
  rail_not_configured: { showMessage: false },
  reason_invalid: { showMessage: false },
  reason_required: { showMessage: false },
  reference_invalid: { showMessage: false },
  registry_not_permitted: { showMessage: false },
  rekey_invalid: { showMessage: false },
  rekey_owner_mismatch: { showMessage: false },
  report_invalid: { showMessage: false },
  report_type_invalid: { showMessage: false },
  request_final: { showMessage: false },
  request_immutable: { showMessage: false },
  request_kind_mismatch: { showMessage: false },
  request_not_open: { showMessage: false },
  request_not_pending: { showMessage: false },
  requester_not_entitled: { showMessage: false },
  resubmission_invalid: { showMessage: false },
  return_code_invalid: { showMessage: false },
  reversal_target_invalid: { showMessage: false },
  rotation_incomplete: { showMessage: false },
  row_invalid: { showMessage: false },
  row_not_applicable: { showMessage: false },
  rows_invalid: { showMessage: false },
  rule_invalid: { showMessage: false },
  rule_not_draft: { showMessage: false },
  sandbox_provider_blocked: { showMessage: false },
  secret_ref_invalid: { showMessage: false },
  settings_invalid: { showMessage: false },
  intent_not_cancellable: { showMessage: false },
  settlement_account_exists: { showMessage: false },
  settlement_account_invalid: { showMessage: false },
  settlement_account_mismatch: { showMessage: false },
  settlement_account_revoked: { showMessage: false },
  settlement_account_unproven: { showMessage: false },
  severity_invalid: { showMessage: false },
  sha256_invalid: { showMessage: false },
  size_invalid: { showMessage: false },
  sms_not_configured: { showMessage: false },
  source_invalid: { showMessage: false },
  source_note_required: { showMessage: false },
  source_system_invalid: { showMessage: false },
  stale_data: { showMessage: false },
  storage_key_in_use: { showMessage: false },
  storage_key_invalid: { showMessage: false },
  subject_invalid: { showMessage: false },
  supersedes_invalid: { showMessage: false },
  task_final: { showMessage: false },
  task_immutable: { showMessage: false },
  template_invalid: { showMessage: false },
  threshold_invalid: { showMessage: false },
  two_person_required: { showMessage: false },
  unexpected_field: { showMessage: false },
  unknown_feature: { showMessage: false },
  utr_conflict: { showMessage: false },
  validity_order: { showMessage: false },
  window_invalid: { showMessage: false },
  wording_invalid: { showMessage: false },
  // Accounts and activation review fixes (SQL migration 20261018000924). The HTTP status follows the SQLSTATE the function
  // raises (55000 answers 409, 22023 answers 422): platform_hold, active_config_exists, own_account_list_not_attested and
  // own_account_list_incomplete are 55000 (409); too_many_claims is 22023 (422). None shows a message: a message could carry
  // a row, and the code says what the caller needs.
  platform_hold: { showMessage: false },
  active_config_exists: { showMessage: false },
  own_account_list_not_attested: { showMessage: false },
  own_account_list_incomplete: { showMessage: false },
  too_many_claims: { showMessage: false },
};

/**
 * Protect triggers refuse a change to a record that already reached its final state with P0001 and a hint. The functions catch
 * the same state earlier and answer 55000 with the code on the right; the trigger is what the LOSING side of a concurrent change
 * meets, when the winner commits between that check and its own UPDATE. It is a conflict (409) with the code the function would
 * have used. The other protect hints (`task_immutable`, `request_immutable`, `closure_immutable`, `document_immutable`) mean
 * the code tried to edit a fixed record: that is a fault, so it stays an unmapped error (500, logged).
 */
const FINAL_STATE_HINTS: Readonly<Record<string, string>> = {
  task_final: 'already_confirmed',
  request_final: 'request_not_open',
};

/**
 * Translates database errors that mean something to the caller. Anything else is not mapped, so the
 * caller gets a generic 500 and the details stay in the server log.
 */
export function mapDatabaseError(error: unknown): ApiError | undefined {
  const e = error as PgLikeError | null;
  if (!e || typeof e.code !== 'string') return undefined;
  const rule = e.hint ? RULE_HINTS[e.hint] : undefined;
  if (e.code === '42501') {
    if (e.hint === 'mfa_required') return new ApiError(401, 'mfa_required', 'Unauthorized');
    if (e.hint === 'session_revoked')
      return new ApiError(401, 'session_revoked', 'Unauthorized', undefined, SESSION_ENDED_HEADERS);
    return rule && e.hint
      ? new ApiError(403, e.hint, 'Forbidden')
      : new ApiError(403, 'forbidden', 'Forbidden');
  }
  if (rule && e.hint && (e.code === '55000' || e.code === '22023')) {
    return new ApiError(
      e.code === '22023' ? 422 : 409,
      e.hint,
      e.code === '22023' ? 'Unprocessable Content' : 'Conflict',
      rule.showMessage ? e.message : undefined,
    );
  }
  switch (e.code) {
    case 'IK409':
      return new ApiError(
        422,
        'idempotency_key_reused',
        'Idempotency key reused',
        'This Idempotency-Key was already used with a different request.',
      );
    case 'P0001': {
      const code = e.hint ? FINAL_STATE_HINTS[e.hint] : undefined;
      return code ? new ApiError(409, code, 'Conflict') : undefined;
    }
    case 'P0002':
      return new ApiError(404, 'not_found', 'Not Found');
    // Malformed values that passed the shape check but are not real dates/uuids/numbers.
    case '22007':
    case '22008':
    case '22P02':
      return new ApiError(422, 'invalid_request', 'Unprocessable Content');
    case '22023':
      return new ApiError(422, 'invalid_request', 'Unprocessable Content');
    case '23503':
      return new ApiError(422, 'invalid_reference', 'Unprocessable Content');
    case '23505':
    case '23514':
    case '55000':
      return new ApiError(409, rule && e.hint ? e.hint : 'conflict', 'Conflict');
    default:
      return undefined;
  }
}
