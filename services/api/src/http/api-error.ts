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
      return new ApiError(409, 'conflict', 'Conflict');
    default:
      return undefined;
  }
}
