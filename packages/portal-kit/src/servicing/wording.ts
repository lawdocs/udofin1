// The words the lender servicing screens use for the API's closed vocabularies and stable error codes. A value the table does
// not know is never printed as it came: the screen says it has no wording for it instead. No server text reaches a screen.

const lookup = (table: Readonly<Record<string, string>>, key: string | null, unknown: string) =>
  key !== null && Object.hasOwn(table, key) ? (table[key] ?? unknown) : unknown;

// -- Loans ---------------------------------------------------------------------------------------------------------
const LOAN_STATUS: Readonly<Record<string, string>> = {
  active: 'Active',
  closed: 'Closed',
  foreclosed: 'Foreclosed',
  written_off: 'Written off',
  cancelled: 'Cancelled',
};
/** The status is the lender's own, as last reported. */
export const loanStatusWords = (status: string | null): string =>
  lookup(LOAN_STATUS, status, 'Not reported');

const SOURCE_SYSTEM: Readonly<Record<string, string>> = {
  file_import: 'file import',
  manual_import: 'manual import',
  mock_lms: 'mock source (for testing only)',
};
/** Where a report came from. */
export const sourceSystemWords = (source: string): string =>
  lookup(SOURCE_SYSTEM, source, 'another source');

const REPORT_FLAG: Readonly<Record<string, string>> = {
  overdue_total_mismatch:
    'The overdue parts reported do not add up to the overdue total reported. Both are shown exactly as reported; nothing was corrected.',
};
export const reportFlagWords = (flag: string): string =>
  lookup(REPORT_FLAG, flag, 'A note was recorded with this report.');

// -- Connection ----------------------------------------------------------------------------------------------------
const CONNECTION_KIND: Readonly<Record<string, string>> = {
  file_import: 'File import',
  manual: 'Manual entry',
  mock: 'Mock connection (for testing only)',
  finbyx: 'Finbyx (no specification yet, so it cannot be used)',
  generic_rest: 'Generic REST (no specification yet, so it cannot be used)',
};
export const connectionKindWords = (kind: string): string =>
  lookup(CONNECTION_KIND, kind, 'A connection kind this screen has no wording for');

const CONNECTION_STATUS: Readonly<Record<string, string>> = {
  draft: 'Draft (not in use)',
  active: 'Active',
  paused: 'Paused',
  blocked_unverified: 'Blocked (the connector is unverified and cannot be used)',
};
export const connectionStatusWords = (status: string): string =>
  lookup(CONNECTION_STATUS, status, 'A status this screen has no wording for');

const CAPABILITY: Readonly<Record<string, string>> = {
  pull: 'Pull changes',
  push: 'Receive pushed changes',
  receipts: 'Receipts',
  schedule: 'Repayment schedules',
  foreclosure_quote: 'Foreclosure quotations',
  statement: 'Statements of account',
  closure_documents: 'Closure documents',
};
export const CAPABILITY_KEYS = Object.keys(CAPABILITY);
export const capabilityWords = (key: string): string =>
  lookup(CAPABILITY, key, 'A capability this screen has no wording for');

// -- Imports -------------------------------------------------------------------------------------------------------
const IMPORT_KIND: Readonly<Record<string, string>> = {
  loan: 'Loan reports',
  receipt: 'Receipts',
  schedule: 'Repayment schedules',
};
export const importKindWords = (kind: string): string =>
  lookup(IMPORT_KIND, kind, 'A file kind this screen has no wording for');

const BATCH_STATUS: Readonly<Record<string, string>> = {
  uploaded: 'Received (preview not ready)',
  previewed: 'Preview ready: nothing has been applied yet',
  invalid: 'Not importable: nothing was applied',
  committed: 'Applied',
  rejected: 'Discarded: nothing was applied',
  failed: 'Applying failed and was rolled back: nothing was applied',
};
export const batchStatusWords = (status: string): string =>
  lookup(BATCH_STATUS, status, 'A status this screen has no wording for');

const COUNT_LABEL: Readonly<Record<string, string>> = {
  new: 'New records',
  unchanged: 'Unchanged (already held exactly)',
  duplicate: 'Repeated inside the file (kept once)',
  changed: 'Changed (a newer report of a record already held)',
  conflict: 'Conflicting (differs from a report already held)',
  error: 'Rows with errors',
  quarantined: 'Held aside (could not be matched)',
  ignoredOlder: 'Older than a report already held (ignored)',
  ignored_older: 'Older than a report already held (ignored)',
};
export const countLabelWords = (key: string): string => lookup(COUNT_LABEL, key, 'Another outcome');

const ROW_OUTCOME: Readonly<Record<string, string>> = {
  error: 'Error',
  quarantined: 'Held aside',
};
export const rowOutcomeWords = (outcome: string): string => lookup(ROW_OUTCOME, outcome, 'Problem');

const IMPORT_ERROR: Readonly<Record<string, string>> = {
  file_too_large: 'The file is larger than the 5 MiB limit.',
  too_many_rows: 'The file has more than 10,000 records.',
  empty_file: 'The file is empty.',
  malformed_file: 'The file could not be read in the expected format.',
  unknown_column: 'The file has a column the format does not define.',
  missing_column: 'A required column is missing.',
  duplicate_column: 'A column appears more than once.',
  column_count_mismatch: 'A row has a different number of cells from the header row.',
  row_not_object: 'A record is not a set of named fields.',
  unknown_field: 'A field is not part of the format.',
  missing_required: 'A required value is missing.',
  invalid_reference: 'A reference has a character or a length the format does not allow.',
  borrower_ref_looks_personal:
    'The borrower reference looks like personal data. Use an opaque reference of your own.',
  invalid_amount: 'An amount is not plain rupees with at most two decimals.',
  amount_not_positive: 'An amount must be more than zero.',
  invalid_date: 'A date is not a real date written as YYYY-MM-DD.',
  invalid_timestamp: 'A time is not a valid time with an offset.',
  timestamp_in_future: 'A reported time is in the future.',
  invalid_integer: 'A whole number is not valid.',
  invalid_status: 'The loan status is not one the format allows.',
  invalid_receipt_kind: 'The receipt kind is neither receipt nor reversal.',
  incomplete_disbursement:
    'The disbursement details are only partly given: give the amount, the date and the reference together, or none.',
  incomplete_next_due: 'The next due date and the next due amount must be given together.',
  disbursed_exceeds_sanctioned: 'The disbursed amount is more than the sanctioned amount.',
  reversal_reference_invalid:
    'A reversal must name the receipt it reverses, and a receipt must not.',
  invalid_items: 'The instalments of a schedule are not valid.',
  inconsistent_report_head: 'Rows of one schedule disagree about the loan or the report.',
  invalid_validity: 'A validity time is not valid.',
  duplicate_row: 'The same record is repeated.',
  conflicting_duplicate: 'The same record appears more than once with different content.',
  content_hash_mismatch: 'A record did not pass the integrity check. Upload the file again.',
  application_not_found: 'No application of this lender matches this loan.',
  application_ambiguous: 'More than one application could match this loan.',
  application_not_ready: 'The matching application is not at a stage that allows a loan.',
  application_already_linked: 'The matching application already has a loan.',
  disbursement_evidence_incomplete: 'The disbursement evidence is incomplete.',
  disbursement_date_in_future: 'The disbursement date is in the future.',
  disbursement_reference_in_use: 'The disbursement reference is already used by another loan.',
  unknown_loan: 'The loan reference is not a loan held for this lender.',
  reversal_target_unknown: 'The receipt being reversed is not known.',
  borrower_ref_mismatch: 'The borrower reference differs from the one held for this loan.',
};
export const importErrorWords = (code: string): string =>
  lookup(
    IMPORT_ERROR,
    code,
    'A problem this screen has no wording for. Compare the row with the file format.',
  );

/** The column names of the import format (the names a lender wrote in the file header). Anything else is not echoed. */
const IMPORT_FIELDS: ReadonlySet<string> = new Set([
  'lms_loan_ref',
  'borrower_ref',
  'status',
  'sanctioned_amount',
  'disbursed_amount',
  'disbursement_ref',
  'disbursement_date',
  'outstanding_principal',
  'next_due_date',
  'next_due_amount',
  'overdue_principal',
  'overdue_interest',
  'penal_charges',
  'other_charges',
  'total_overdue',
  'days_past_due',
  'source_record_id',
  'reported_as_of',
  'sequence',
  'lms_receipt_ref',
  'receipt_kind',
  'reverses_receipt_ref',
  'amount',
  'value_date',
  'payment_mode',
  'bank_reference',
  'installments',
  'installment_seq',
  'due_date',
  'principal',
  'interest',
  'fees',
  'format_version',
]);
/** A column name of the format, as written in the file; a name the format does not define is not echoed. */
export const importFieldName = (name: string): string =>
  IMPORT_FIELDS.has(name) ? name : 'a column the format does not define';

// -- Sync flags ----------------------------------------------------------------------------------------------------
const CONFLICT_REASON: Readonly<Record<string, string>> = {
  same_record_different_content: 'The same record was reported twice with different content.',
  same_time_different_content: 'Two reports for the same time had different content.',
  sequence_reused: 'A sequence number was reused for different content.',
  receipt_differs: 'A receipt was reported again with different details.',
};
export const conflictReasonWords = (reason: string): string =>
  lookup(CONFLICT_REASON, reason, 'A conflict this screen has no wording for.');

const RECORD_TYPE: Readonly<Record<string, string>> = {
  loan: 'Loan report',
  receipt: 'Receipt',
  schedule: 'Repayment schedule',
};
export const recordTypeWords = (type: string): string => lookup(RECORD_TYPE, type, 'A record');

const CONFLICT_STATUS: Readonly<Record<string, string>> = {
  open: 'Open: waiting to be acknowledged',
  acknowledged: 'Acknowledged: waiting to be resolved',
  resolved: 'Resolved',
};
export const conflictStatusWords = (status: string): string =>
  lookup(CONFLICT_STATUS, status, 'A status this screen has no wording for');

const CONFIRMED_VERSION: Readonly<Record<string, string>> = {
  existing: 'The report already held',
  incoming: 'The report that arrived later',
};
export const confirmedVersionWords = (version: string): string =>
  lookup(CONFIRMED_VERSION, version, 'A version this screen has no wording for');

const ANOMALY: Readonly<Record<string, string>> = {
  status_regression: 'The reported status moved backwards.',
  terminal_status_changed: 'A loan reported as ended was reported with a different status.',
  outstanding_rise_without_charge:
    'The reported outstanding principal rose without a reported charge.',
  overdue_total_mismatch: 'The reported overdue parts do not add up to the reported overdue total.',
  sanctioned_amount_changed: 'The reported sanctioned amount changed.',
  disbursement_evidence_differs: 'The reported disbursement details differ from those held.',
  reversal_exceeds_receipt: 'A reversal is larger than the receipt it reverses.',
  older_report_ignored: 'A report older than the one held was ignored.',
  older_sequence_ignored: 'A report with an older sequence number was ignored.',
};
export const anomalyWords = (kind: string): string =>
  lookup(ANOMALY, kind, 'A flag this screen has no wording for.');

const SEVERITY: Readonly<Record<string, string>> = {
  warning: 'Warning',
  info: 'For information',
};
export const severityWords = (severity: string): string => lookup(SEVERITY, severity, 'Flag');

// -- Documents, quotations, closure --------------------------------------------------------------------------------
const DOCUMENT_KIND: Readonly<Record<string, string>> = {
  statement: 'Statement of account',
  foreclosure_quote: 'Foreclosure quotation letter',
  noc: 'No-dues certificate (NOC)',
  closure_letter: 'Closure letter',
};
export const documentKindWords = (kind: string): string =>
  lookup(DOCUMENT_KIND, kind, 'A document');
export const DOCUMENT_KINDS = Object.keys(DOCUMENT_KIND);

const REQUEST_STATUS: Readonly<Record<string, string>> = {
  requested: 'Open: waiting for your organisation',
  fulfilled: 'Fulfilled',
  declined: 'Declined',
  expired: 'Expired',
  cancelled: 'Cancelled by the borrower',
};
export const requestStatusWords = (status: string): string =>
  lookup(REQUEST_STATUS, status, 'A status this screen has no wording for');

const COLLATERAL: Readonly<Record<string, string>> = {
  mutual_fund_lien: 'Lien on mutual fund units',
  demat_pledge: 'Pledge of demat holdings',
  property_documents: 'Property documents',
  vehicle_hypothecation: 'Vehicle hypothecation',
  other: 'Other security',
};
export const collateralWords = (type: string): string => lookup(COLLATERAL, type, 'Security');
export const COLLATERAL_TYPES = Object.keys(COLLATERAL);

const CLOSURE_KIND: Readonly<Record<string, string>> = {
  closed: 'Closed',
  foreclosed: 'Foreclosed',
};
export const closureKindWords = (kind: string): string => lookup(CLOSURE_KIND, kind, 'Closure');

const RELEASE_STATUS: Readonly<Record<string, string>> = {
  open: 'Open: not yet confirmed by your organisation',
  confirmed_by_lender: 'Confirmed by your organisation',
};
export const releaseStatusWords = (status: string): string =>
  lookup(RELEASE_STATUS, status, 'A status this screen has no wording for');

const QUOTE_SOURCE: Readonly<Record<string, string>> = {
  lender_portal: 'Recorded in this portal by your organisation',
  lms: 'Received from the lender system',
  mock: 'Mock source (for testing only)',
};
export const quoteSourceWords = (source: string): string =>
  lookup(QUOTE_SOURCE, source, 'Another source');

const DOCUMENT_SOURCE: Readonly<Record<string, string>> = {
  lender_upload: 'Uploaded by your organisation',
  lms: 'Received from the lender system',
  mock: 'Mock source (for testing only)',
};
export const documentSourceWords = (source: string): string =>
  lookup(DOCUMENT_SOURCE, source, 'Another source');

// -- Errors --------------------------------------------------------------------------------------------------------
const GENERIC_ERROR = 'The action could not be completed. Nothing was changed.';
/** What each stable API or local error code means to the person who did the action. */
const ERROR: Readonly<Record<string, string>> = {
  forbidden: 'You are not allowed to do that for this lender.',
  staff_only: 'This is only available to lender staff.',
  no_active_access: 'Your access is not active. Contact your organisation’s administrator.',
  mfa_required: 'Your session needs the second factor again. Sign in once more.',
  signed_out: 'You were signed out. Sign in again.',
  feature_disabled: 'This part of servicing is switched off for your organisation.',
  connector_unverified:
    'That connection kind has no specification yet, so it can only be recorded as blocked.',
  mock_provider_blocked: 'A mock connection is not allowed in this environment.',
  bad_status: 'That status does not go with that connection kind.',
  capabilities_invalid: 'The declared capabilities were not valid.',
  threshold_invalid: 'The staleness threshold must be between 5 and 43,200 minutes.',
  connection_not_active:
    'There is no active connection that allows this upload. Set the connection up first.',
  idempotency_conflict:
    'That request key was already used for a different file. Upload the file again.',
  idempotency_key_reused:
    'That request key was already used for a different request. Reload the page and try again.',
  idempotency_key_required: 'The request could not be sent safely. Reload the page and try again.',
  resubmission_invalid:
    'The file you are correcting must be an earlier invalid, discarded or failed file of the same kind.',
  rows_invalid: 'The file has no records, or more than 10,000.',
  format_unsupported: 'That file format version is not supported.',
  import_has_errors:
    'This file has errors, so it cannot be applied. Correct it and upload it again.',
  import_apply_failed:
    'Applying the file failed and was rolled back. Nothing was applied. The result below says what happened.',
  batch_rejected: 'This file was discarded and cannot be applied.',
  batch_failed: 'Applying this file failed earlier. Upload the file again.',
  batch_not_previewed: 'This file is not ready to be applied.',
  batch_not_rejectable: 'Only a file with a ready preview can be discarded.',
  conflict_not_open: 'That conflict is no longer waiting to be acknowledged.',
  conflict_not_acknowledged: 'Acknowledge the conflict before resolving it.',
  conflict_resolved: 'That conflict is already resolved.',
  evidence_invalid:
    'Give one to twenty short references to what you reviewed, each using a label and a value.',
  reason_required: 'Write a note of at least 10 characters.',
  reason_invalid:
    'The text is too short or too long, or it contains personal details. Use 10 to 500 characters and no personal details.',
  note_invalid: 'The note must be 10 to 500 characters and must not contain personal details.',
  lender_reference_reused: 'That reference was already used with a different file.',
  request_not_open: 'That request is no longer open.',
  request_kind_mismatch: 'That request is for a different kind of document.',
  period_does_not_cover_request: 'The period of the document does not cover the period requested.',
  already_superseded: 'That document was already replaced by a newer one.',
  document_too_large: 'The file is larger than the 8 MiB limit.',
  document_store_unavailable: 'Document storage is not available in this environment yet.',
  quote_ref_reused: 'That quotation reference was already used with different figures.',
  quote_already_expired: 'That quotation had already expired when it was recorded.',
  validity_order: 'The quotation must remain valid until after the time it is as of.',
  as_of_invalid: 'The “as of” time is not valid. It cannot be in the future.',
  reference_invalid:
    'The reference may only use letters, digits and . _ / - (up to 100 characters).',
  letter_invalid: 'The letter must be a foreclosure quotation letter of this loan.',
  loan_not_closed: 'Security can only be recorded for a loan reported closed or foreclosed.',
  collateral_types_invalid: 'Choose between one and five kinds of security.',
  already_confirmed: 'That release was already confirmed.',
  confirmation_ref_invalid:
    'The confirmation reference needs 3 to 100 letters, digits or . _ / - characters.',
  validation_failed: 'Please check the values you entered.',
  invalid_request: 'Please check the values you entered.',
  not_found: 'That record was not found for your organisation.',
  conflict: 'That is not possible in the current state.',
  rate_limited: 'Too many requests. Wait a minute and try again.',
  network_error: 'The service could not be reached. Try again.',
  result_unknown:
    'The service did not answer in time, so it is not known whether this was done. Reload the page to see the current state before trying again.',
  bad_response: 'The service gave an answer this page could not use. Try again.',
  path_not_allowed: 'That action is not available.',
  file_required: 'Choose a file first.',
  file_empty: 'The file is empty.',
  file_too_large: 'The file is too large to send.',
  file_not_text: 'The file is not plain text in UTF-8.',
  file_not_pdf: 'The file is not a PDF.',
  review_required: 'Tick the box to confirm you reviewed the preview.',
  amount_invalid:
    'Amounts are rupees with digits only and at most two decimals, for example 12500.50.',
  time_invalid: 'Give a real date and time.',
  date_invalid: 'Give a real date.',
};
/** A stable code to plain words. A code the table does not know (and never a server message) gives the generic sentence. */
export const servicingErrorMessage = (code: string | null | undefined): string =>
  code && Object.hasOwn(ERROR, code) ? (ERROR[code] ?? GENERIC_ERROR) : GENERIC_ERROR;

/** Only a short lower-case code may travel in a redirect URL. */
export const safeErrorCode = (code: string): string =>
  /^[a-z][a-z0-9_]{1,59}$/.test(code) ? code : 'unknown';
