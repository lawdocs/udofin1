/**
 * Plain-English words for the closed lists the API returns. Every screen goes through `lpWord`, so a value this version of the
 * portal does not know is written as "Not recognised" and its raw text never reaches the page. The words only describe what the
 * API said; none of them says "paid", "approved" or "verified" about anything the API did not state.
 */

type Words = Readonly<Record<string, string>>;

export const LP_UNRECOGNISED = 'Not recognised by this version of the portal';

/** Looks a value up in a word list. An unknown or missing value is never echoed. */
export function lpWord(words: Words, key: string | null | undefined): string {
  if (key === null || key === undefined) return '—';
  return Object.hasOwn(words, key) ? (words[key] ?? LP_UNRECOGNISED) : LP_UNRECOGNISED;
}

/** The status of a payment request. "Received" means the provider reported it in a verified event, not that the lender posted it. */
export const PAYMENT_STATUS_WORDS: Words = {
  created: 'Started (no payment link at the provider yet)',
  pending: 'Sent to the provider (no verified payment yet)',
  succeeded: 'Received by the payment provider',
  failed: 'Failed',
  expired: 'Expired',
  cancelled: 'Cancelled',
};

export const PAYMENT_PURPOSE_WORDS: Words = {
  installment: 'Instalment',
  overdue: 'Overdue amount',
  part_prepayment: 'Part-prepayment',
  foreclosure: 'Foreclosure',
  charges: 'Charges',
};

/** What the provider calls its own status. The provider's word is quoted as the provider's, not as a fact of ours. */
export const PROVIDER_PAYMENT_STATUS_WORDS: Words = {
  created: 'Created at the provider',
  pending: 'Pending at the provider',
  authorized: 'Authorised, not yet captured',
  captured: 'Captured by the provider',
  paid: 'The provider calls it "paid"',
  succeeded: 'The provider calls it "succeeded"',
  failed: 'Failed',
  refunded: 'Refunded',
  disputed: 'Disputed',
  cancelled: 'Cancelled',
  expired: 'Expired',
};

export const ADJUSTMENT_KIND_WORDS: Words = {
  refund: 'Refund',
  chargeback: 'Chargeback',
  reversal: 'Reversal',
  correction: 'Correction',
};

/** The four settlement stages, each a separate fact with the source that records it. */
export const STAGE_WORDS: Readonly<
  Record<'provider_captured' | 'provider_settled' | 'bank_confirmed' | 'lender_posted', string>
> = {
  provider_captured: 'Provider captured',
  provider_settled: 'Provider settled',
  bank_confirmed: 'Bank confirmed',
  lender_posted: 'Lender posted',
};

export const STAGE_SOURCE_WORDS: Readonly<Record<keyof typeof STAGE_WORDS, string>> = {
  provider_captured: 'Source: a verified event from the payment provider.',
  provider_settled:
    'Source: the provider’s settlement report lists this payment with the same reference and amount.',
  bank_confirmed:
    'Source: a bank credit that you uploaded matches the provider’s settlement (same bank reference and amount) and your settlement account.',
  lender_posted:
    'Source: a receipt from your own loan system carries our payment reference, for the same amount.',
};

export const EVENT_OBJECT_KIND_WORDS: Words = {
  payment: 'Payment',
  refund: 'Refund',
  chargeback: 'Chargeback',
  mandate: 'Mandate',
  debit: 'Debit',
  settlement: 'Settlement',
  unsupported: 'Type not supported',
};

export const EVENT_OUTCOME_WORDS: Words = {
  applied: 'Applied',
  already_applied: 'Already applied earlier (no change)',
  ignored_stale: 'Ignored: older than a report already applied',
  deferred: 'Deferred: waiting for a related event, will be retried',
  exception: 'Raised an exception for a person to review',
  ignored_unsupported: 'Ignored: event type not supported',
  ignored_unsupported_yet: 'Recorded, not supported yet',
  recorded_for_reconciliation: 'Recorded for reconciliation (changes no payment)',
};

export const EVENT_REASON_WORDS: Words = {
  unsupported_kind: 'event type not supported',
  unmapped_status: 'status not recognised',
  settlement_event: 'settlement event, kept for reconciliation',
  mandates_not_built: 'mandate events not supported yet',
  mandate_event: 'mandate or debit event',
  failure_after_success: 'a failure arrived after a success; the success was kept',
  lower_rank: 'older than a status already applied',
  same_status: 'same status as already recorded',
  no_adjustment_for_status: 'no refund or chargeback to record',
  no_capture_found: 'refund or chargeback arrived with no capture',
  capture_not_seen_yet: 'waiting for the capture event',
  adjustment_exists: 'refund or chargeback already recorded',
  adjustments_exceed_payment: 'refunds and chargebacks would exceed the payment',
  adjustment_recorded: 'refund or chargeback recorded',
  duplicate_capture: 'second capture on the same order',
  intent_closed: 'money captured on a payment request that was already closed',
  amount_differs: 'captured amount differs from the amount asked for',
  intent_succeeded: 'payment request marked as received by the provider',
  intent_already_succeeded: 'payment request was already marked as received',
  payment_status_recorded: 'provider status recorded',
};

export const EVENT_PROCESSING_CLASS_WORDS: Words = {
  actionable: 'Can change a payment',
  ignored: 'Recorded only, changes nothing',
};

/** Webhook deliveries by outcome. Only a verified delivery can become an event; the others change nothing. */
export const RECEIPT_OUTCOME_WORDS: Words = {
  verified: 'Verified',
  verified_ignored: 'Verified, nothing to apply',
  duplicate: 'Repeat of an earlier delivery (not processed again)',
  unverified: 'Could not be verified (no effect on any payment)',
  stale_timestamp: 'Refused: timestamp outside the allowed window',
  unmatched: 'Refused: matched no configuration',
  invalid: 'Refused: not a valid delivery',
  scheme_not_configured: 'Not processed: signature scheme not set up for this provider',
};

export const MANDATE_RAIL_WORDS: Words = {
  enach_api: 'eNACH (API mandate)',
  upi_autopay: 'UPI AutoPay',
};

/** The status exactly as the provider-confirmed history last left it. Nothing is "active" until the provider says so. */
export const MANDATE_STATUS_WORDS: Words = {
  draft: 'Requested, not yet handed to the provider',
  registration_pending: 'Waiting for the borrower’s bank',
  active: 'Active, as confirmed by the provider',
  paused: 'Paused',
  rejected: 'Rejected',
  failed: 'Failed',
  expired: 'Expired',
  cancelled: 'Cancelled',
  revoked: 'Revoked at the bank',
  requires_reconciliation: 'Outcome unknown, being checked with the provider',
};

export const MANDATE_MODE_WORDS: Words = {
  mock: 'MOCK (test only, not a real provider)',
  sandbox: 'Sandbox (test only)',
  production: 'Production',
};

export const MANDATE_EVENT_SOURCE_WORDS: Words = {
  request: 'Requested',
  handoff: 'Handed to the provider',
  provider_event: 'Verified provider event',
  status_lookup: 'Authenticated status lookup',
  system: 'System time rule',
};

export const MANDATE_CANCEL_REASON_WORDS: Words = {
  borrower: 'asked for by the borrower',
  loan_closed: 'the loan was closed',
};

export const MANDATE_REQUIREMENT_WORDS: Words = {
  optional: 'Optional: the borrower may set up a mandate',
  before_first_due:
    'Asked for before the first due date (informational: no loan operation is blocked)',
};

export const DEBIT_STATUS_WORDS: Words = {
  scheduled: 'Scheduled',
  notified: 'Pre-debit notice accepted for sending',
  presented: 'Presented to the bank',
  unknown: 'Outcome unknown',
  settled: 'Settled, as reported by the provider',
  returned: 'Returned',
  cancelled: 'Cancelled',
};

export const RETURN_CLASS_WORDS: Words = {
  insufficient_funds: 'Insufficient funds',
  account_issue: 'Account issue',
  mandate_issue: 'Mandate issue',
  technical: 'Technical',
  other: 'Other',
};

export const NOTICE_STATUS_WORDS: Words = {
  planned: 'Planned',
  sent: 'Sent',
  late: 'LATE: planned too close to the debit, or could not go out in time',
  not_needed: 'Not needed',
};

export const NOTICE_DELIVERY_WORDS: Words = {
  accepted: 'accepted by the channel (not proof of delivery)',
  delivered: 'delivered',
};

export const EXCEPTION_STATUS_WORDS: Words = {
  open: 'Open',
  acknowledged: 'Acknowledged',
  assigned: 'Assigned',
  resolved: 'Resolved',
  reopened: 'Reopened',
};

export const EXCEPTION_ACTION_WORDS: Words = {
  opened: 'Opened',
  acknowledged: 'Acknowledged',
  assigned: 'Assigned',
  resolved: 'Resolved',
  reopened: 'Reopened',
};

export const EXCEPTION_SEVERITY_WORDS: Words = {
  info: 'Information',
  warning: 'Warning',
  critical: 'Critical',
};

export const EXCEPTION_OWNER_WORDS: Words = {
  lender: 'Your organisation',
  platform: 'Handled by Udofin platform staff',
};

export const EXCEPTION_ACTOR_WORDS: Words = {
  system: 'The system',
  lender_user: 'A person at the lender',
  platform_user: 'Udofin platform staff',
};

export const EXCEPTION_CLASS_WORDS: Words = {
  provider_success_no_settlement:
    'The provider reports a payment, but no settlement has been reported for it',
  settlement_no_intent: 'A provider settlement item matches no payment request',
  amount_mismatch: 'An amount differs from the amount asked for',
  duplicate_payment: 'A second payment was captured for the same request',
  lender_receipt_missing: 'A captured payment has not been posted by the lender in time',
  lender_receipt_no_intent: 'A lender receipt matches no payment request',
  refund_unmatched: 'A refund matches no payment',
  settlement_account_mismatch:
    'Settlement was reported to an account that is not the lender’s verified account',
  merchant_mismatch: 'The provider reported a different merchant than the configured one',
  late_settlement: 'Settlement is later than the waiting time',
  stale_sync: 'Loan data from the lender is out of date',
  mandate_debit_unresolved: 'A mandate debit could not be matched or resolved',
  webhook_gap: 'A payment is still pending and no provider event has arrived',
  event_payload_conflict: 'The provider sent conflicting details for the same event',
  payment_status_conflict: 'A provider status contradicts one already applied',
  payment_on_closed_intent: 'Money was captured for a payment request that was already closed',
  penal_text_missing: 'The lender’s approved penal-charge sentence is missing',
  mandate_status_conflict: 'A provider mandate status contradicts the recorded one',
  mandate_unresolved: 'A mandate outcome is unknown',
  mandate_cancel_unconfirmed: 'A mandate cancellation has not been confirmed by the provider',
  mandate_notice_late: 'A pre-debit notice was late',
  mandate_debit_exceeds_max: 'A debit is above the mandate maximum',
};

/** The subject of an exception holds identifiers only; these say which kind each identifier is. */
export const EXCEPTION_SUBJECT_WORDS: Words = {
  intent_id: 'Payment request',
  provider_payment_id: 'Provider payment',
  event_id: 'Provider event',
  config_id: 'Payment configuration',
  loan_account_id: 'Loan account',
  mandate_id: 'Mandate',
  debit_id: 'Debit',
  settlement_item_id: 'Settlement item',
  settlement_batch_id: 'Settlement batch',
  receipt_id: 'Lender receipt',
  run_id: 'Reconciliation run',
  lender_org_id: 'Lender',
  installment_seq: 'Instalment number',
};

export const RESOLVE_REASON_WORDS: Words = {
  verified_with_provider: 'Verified with the provider',
  refunded_by_provider: 'Refunded by the provider',
  posted_by_lender: 'Posted by the lender',
  duplicate_confirmed: 'Confirmed as a duplicate',
  timing_difference: 'Timing difference',
  no_action_needed: 'No action needed',
  escalated_to_provider: 'Escalated to the provider',
  escalated_to_lender: 'Escalated to the lender',
  documented_elsewhere: 'Documented elsewhere',
  raised_in_error: 'Raised in error',
  new_information: 'New information',
};

/** What a run could not check. A source that was missing is never reported as reconciled. */
export const NOT_RECONCILABLE_WORDS: Words = {
  settlement_reports:
    'No provider settlement report was available, so provider settlement could not be checked.',
  bank_credits: 'No bank credits had been uploaded, so bank confirmation could not be checked.',
  lms_receipts:
    'No receipt feed from your loan system was available, so “lender posted” could not be checked.',
};

export const SETTLEMENT_ACCOUNT_STATUS_WORDS: Words = {
  unverified: 'not yet verified',
  verified: 'verified',
  rejected: 'rejected',
  revoked: 'revoked',
};

/** Messages for stable error codes. Unknown codes get a neutral sentence; the code itself is never shown. */
export const ERROR_WORDS: Words = {
  signed_out: 'Your session has ended. Sign in again.',
  mfa_required: 'Your session needs the second factor again. Sign in once more.',
  forbidden: 'Your role does not allow that.',
  staff_only: 'This page is for lender staff.',
  no_active_access: 'Your access to this organisation is not active.',
  not_found: 'That record was not found for your organisation.',
  validation_failed: 'Please check the values you entered.',
  policy_invalid:
    'The server did not accept this policy. A minimum amount is needed wherever partial payments or part-prepayments are allowed, and every value must be inside the range the server allows.',
  settings_invalid:
    'The server did not accept these waiting times. Each must be a whole number inside the range the server allows.',
  unexpected_field:
    'The file has a column other than valueDate, amountMinor and utr, so the whole file was refused. Nothing was stored.',
  row_invalid:
    'A line in the file is not valid, so the whole file was refused. Nothing was stored.',
  rows_invalid:
    'The file has more lines than one upload may hold, so the whole file was refused. Nothing was stored.',
  utr_conflict:
    'A bank reference in the file clashes with one already recorded with different details, so the whole file was refused. Nothing was stored.',
  bad_request: 'The upload was not accepted. Nothing was stored.',
  exception_state_invalid:
    'That is not possible in the exception’s current state. Reload the page to see its state.',
  assignee_invalid: 'That person cannot act on this exception.',
  reason_required: 'Choose a reason from the list.',
  evidence_required:
    'Give between one and ten evidence references: letters, digits and . _ : / # - only, with no spaces.',
  reason_invalid: 'The reason or the note was not accepted. A note is at most 500 characters.',
  idempotency_key_required: 'This form could not be sent. Reload the page and try again.',
  idempotency_key_reused: 'This form was already used. Reload the page before trying again.',
  rate_limited: 'Too many requests. Wait a moment and try again.',
  invalid_cursor: 'That page link is no longer valid. Go back to the first page.',
  network_error: 'The service could not be reached. Try again.',
  bad_response: 'The service answered in an unexpected way. Reload to see the current state.',
  path_not_allowed: 'That action is not available.',
  confirmation_required: 'Tick the confirmation box to go ahead.',
  amount_invalid:
    'Enter an amount in rupees using digits and at most two decimals, for example 1500 or 1500.50.',
  csv_header_invalid:
    'The first line of the file must name exactly three columns: valueDate, amountMinor and utr. Any other column makes the server refuse the whole file.',
  csv_missing: 'Choose a file or paste the statement text.',
  csv_both: 'Give either a file or pasted text, not both.',
  csv_too_large: 'The statement is longer than one upload may hold.',
};

const GENERIC_ERROR = 'The action could not be completed.';
const SERVICE_ERROR = 'The service had a problem. Try again later.';

export function lpErrorMessage(code: string | null | undefined): string {
  if (!code) return GENERIC_ERROR;
  if (Object.hasOwn(ERROR_WORDS, code)) return ERROR_WORDS[code] ?? GENERIC_ERROR;
  return /^http_5\d\d$/.test(code) ? SERVICE_ERROR : GENERIC_ERROR;
}
