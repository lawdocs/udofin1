// The words the operations screens for providers, the account registry, feature switches and platform exceptions use for the
// API's closed vocabularies and stable error codes. A value the table does not know is never printed as it came: the screen says
// it has no wording for it instead. No server text reaches a screen. Nothing here claims that anything is compliant, approved by a
// regulator or safe: a label is what a member of staff recorded, and the words say so.

const lookup = (table: Readonly<Record<string, string>>, key: string | null, unknown: string) =>
  key !== null && Object.hasOwn(table, key) ? (table[key] ?? unknown) : unknown;

// -- Providers -----------------------------------------------------------------------------------------------------
const PROVIDER_KIND: Readonly<Record<string, string>> = {
  payment: 'Payments',
  mandate: 'Mandates',
  payment_and_mandate: 'Payments and mandates',
};
export const providerKindWords = (kind: string): string =>
  lookup(PROVIDER_KIND, kind, 'A kind this screen has no wording for');

const PROVIDER_STATUS: Readonly<Record<string, string>> = {
  draft: 'Draft: not usable',
  approved: 'Approved by staff',
  suspended: 'Suspended',
};
export const providerStatusWords = (status: string): string =>
  lookup(PROVIDER_STATUS, status, 'A status this screen has no wording for');

/**
 * The evidence label is what a member of staff recorded about a source. It is not a finding by Udofin that anything is
 * authorised, and "confirmed" only means staff marked it so against a source they hold.
 */
const EVIDENCE_STATUS: Readonly<Record<string, string>> = {
  unverified: 'Unverified: no source has been supplied',
  likely: 'Likely: not confirmed against a source',
  confirmed: 'Marked confirmed by staff against a source',
};
export const evidenceStatusWords = (status: string): string =>
  lookup(EVIDENCE_STATUS, status, 'A label this screen has no wording for');
export const EVIDENCE_STATUSES = Object.keys(EVIDENCE_STATUS);

const RETURN_CLASS: Readonly<Record<string, string>> = {
  insufficient_funds: 'Insufficient funds',
  account_issue: 'A problem with the account',
  mandate_issue: 'A problem with the mandate',
  technical: 'Technical',
  other: 'Other',
};
export const returnClassWords = (value: string): string =>
  lookup(RETURN_CLASS, value, 'A class this screen has no wording for');
export const RETURN_CLASSES = Object.keys(RETURN_CLASS);

export const PROVIDER_KINDS = Object.keys(PROVIDER_KIND);
export const PROVIDER_STATUSES = Object.keys(PROVIDER_STATUS);

// -- Account format rules and key versions -------------------------------------------------------------------------
const RULE_STATUS: Readonly<Record<string, string>> = {
  draft: 'Draft: not in use',
  approved: 'Approved',
  retired: 'Retired',
};
export const ruleStatusWords = (status: string): string =>
  lookup(RULE_STATUS, status, 'A status this screen has no wording for');
export const RULE_STATUSES = Object.keys(RULE_STATUS);

const KEY_STATUS: Readonly<Record<string, string>> = {
  proposed: 'Proposed: waiting for a second person',
  active: 'Active',
  retired: 'Retired',
};
export const keyStatusWords = (status: string): string =>
  lookup(KEY_STATUS, status, 'A status this screen has no wording for');

// -- Registered accounts --------------------------------------------------------------------------------------------
const OWNER_KIND: Readonly<Record<string, string>> = {
  lender: 'A lender',
  udofin: 'Udofin’s own account',
  group_company: 'A group company’s account',
  other: 'Another owner',
};
export const ownerKindWords = (kind: string): string =>
  lookup(OWNER_KIND, kind, 'An owner kind this screen has no wording for');
export const OWNER_KINDS = Object.keys(OWNER_KIND);

const PURPOSE: Readonly<Record<string, string>> = {
  repayment_settlement: 'Repayment settlement',
  fee_collection: 'Fee collection',
  disbursement_source: 'Disbursement source',
  operational: 'Operational',
};
export const purposeWords = (purpose: string): string =>
  lookup(PURPOSE, purpose, 'A purpose this screen has no wording for');
export const PURPOSES = Object.keys(PURPOSE);

const REGISTRY_STATUS: Readonly<Record<string, string>> = {
  unverified: 'Unverified: waiting for a different person to verify it',
  verified: 'Verified',
  rejected: 'Rejected',
  revoked: 'Revoked',
};
export const registryStatusWords = (status: string): string =>
  lookup(REGISTRY_STATUS, status, 'A status this screen has no wording for');
export const REGISTRY_STATUSES = Object.keys(REGISTRY_STATUS);

// -- Merchants -----------------------------------------------------------------------------------------------------
const MERCHANT_OWNER: Readonly<Record<string, string>> = {
  lender: 'A lender’s repayment merchant',
  udofin_fees: 'Udofin’s fee merchant',
};
export const merchantOwnerWords = (kind: string): string =>
  lookup(MERCHANT_OWNER, kind, 'An owner this screen has no wording for');

const MERCHANT_STATUS: Readonly<Record<string, string>> = {
  active: 'Active',
  revoked: 'Revoked',
};
export const merchantStatusWords = (status: string): string =>
  lookup(MERCHANT_STATUS, status, 'A status this screen has no wording for');
export const MERCHANT_STATUSES = Object.keys(MERCHANT_STATUS);

const MERCHANT_VERIFICATION: Readonly<Record<string, string>> = {
  unverified: 'Unverified',
  verified: 'Verified',
};
export const merchantVerificationWords = (status: string): string =>
  lookup(MERCHANT_VERIFICATION, status, 'A status this screen has no wording for');
export const MERCHANT_VERIFICATIONS = Object.keys(MERCHANT_VERIFICATION);

// -- Settlement accounts -------------------------------------------------------------------------------------------
const SETTLEMENT_STATUS: Readonly<Record<string, string>> = {
  unverified: 'Not linked to a registry entry',
  verified: 'Linked to a verified registry entry',
  revoked: 'Revoked',
};
export const settlementStatusWords = (status: string): string =>
  lookup(SETTLEMENT_STATUS, status, 'A status this screen has no wording for');

// -- Feature switches ------------------------------------------------------------------------------------------------
const FEATURE: Readonly<Record<string, string>> = {
  servicing_sync: 'Servicing sync',
  payments: 'Payments',
  mandates: 'Mandates',
  reminders: 'Reminders',
  statements_noc: 'Statements and no-dues letters',
  collections: 'Collections',
  dlg: 'Default loss guarantee (DLG)',
};
export const featureWords = (feature: string): string =>
  lookup(FEATURE, feature, 'A feature this screen has no wording for');

/**
 * Features that cannot be switched on in this release. The catalogue says the same (enableable false); this list is a second,
 * independent guard so that a screen never draws an enable control for them even if a catalogue row were wrong.
 */
export const LOCKED_FEATURES: readonly string[] = ['collections', 'dlg'];
export const isLockedFeature = (feature: string): boolean => LOCKED_FEATURES.includes(feature);

const REQUEST_STATUS: Readonly<Record<string, string>> = {
  pending: 'Pending: waiting for a different person to decide',
  applied: 'Applied: the switch changed',
  rejected: 'Rejected: nothing changed',
  cancelled: 'Cancelled: nothing changed',
  expired: 'Expired: not applied, nothing changed',
};
export const requestStatusWords = (status: string): string =>
  lookup(REQUEST_STATUS, status, 'A status this screen has no wording for');
export const REQUEST_STATUSES = Object.keys(REQUEST_STATUS);

const REQUEST_MODE: Readonly<Record<string, string>> = {
  two_person: 'Two-person change',
  emergency: 'Emergency switch-off by one person',
};
export const requestModeWords = (mode: string): string =>
  lookup(REQUEST_MODE, mode, 'A mode this screen has no wording for');

/** The answer to a decision, as far as the switch is concerned. */
const DECISION_RESULT: Readonly<Record<string, string>> = {
  applied: 'The request was approved and the switch has changed.',
  rejected: 'The request was rejected. Nothing changed.',
  expired: 'The request had run out of time, so it was not applied. Nothing changed.',
};
export const decisionResultWords = (result: string): string | null =>
  Object.hasOwn(DECISION_RESULT, result) ? (DECISION_RESULT[result] ?? null) : null;
export const DECISION_RESULTS = Object.keys(DECISION_RESULT);

/** The reasons a refused request lists (stable identifiers of unmet prerequisites), in plain words. */
const FEATURE_REASON: Readonly<Record<string, string>> = {
  feature_unknown: 'The feature is not in the catalogue.',
  feature_not_enableable: 'This feature cannot be enabled in this release.',
  lender_organisation_not_active: 'The lender’s organisation is not active.',
  onboarding_gate_not_activated: 'The lender’s onboarding has not reached the activated stage.',
  evidence_missing: 'The request carries no evidence references.',
  payment_config_missing: 'There is no active payment configuration in production mode.',
  payment_config_mock_or_sandbox_only:
    'Only a mock or sandbox payment configuration is active. Those are for testing only and never count.',
  registry_entry_not_verified:
    'The settlement account of the active payment configuration is not linked to a verified registry entry.',
  payment_config_validation_failed:
    'The active payment configuration does not pass its collection-target check.',
  lms_connection_not_active: 'There is no active production connection to the lender’s system.',
  servicing_sync_not_enabled: 'Servicing sync is not switched on for this lender.',
  reminder_policy_missing: 'The lender has no approved reminder policy.',
  reminder_templates_missing: 'An approved English wording is missing for a kind of reminder.',
  provider_not_mandate_capable: 'The provider in use does not offer mandates.',
  mandate_rail_not_configured:
    'The payment configuration does not carry the limits of any mandate rail.',
  mandate_policy_missing: 'The lender has no mandate settings.',
};
const UNKNOWN_REASON = 'Another reason that this screen has no wording for.';
export const featureReasonWords = (code: string): string =>
  lookup(FEATURE_REASON, code, UNKNOWN_REASON);
/** Reason identifiers from a page address: only well-formed identifiers survive, at most ten. */
export const reasonCodesFrom = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .filter((part) => /^[a-z][a-z0-9_]{1,63}$/.test(part))
    .slice(0, 10);

// -- Exceptions ------------------------------------------------------------------------------------------------------
const EXCEPTION_CLASS: Readonly<Record<string, string>> = {
  merchant_mismatch: 'The provider named a different merchant from the one configured',
  event_payload_conflict: 'The same provider message arrived twice with different content',
  settlement_account_mismatch:
    'A settlement was reported for an account that is not the lender’s linked settlement account',
  provider_mismatch: 'The provider differs from the one configured',
  payment_status_conflict: 'Two provider messages disagree about the status of a payment',
  amount_mismatch: 'An amount differs between two sources',
  provider_success_no_settlement: 'The provider reported a success with no settlement yet',
  settlement_no_intent: 'A settlement matches no payment request',
  late_settlement: 'A settlement arrived later than expected',
  lender_receipt_missing: 'No receipt from the lender for a payment',
  lender_receipt_no_intent: 'A lender receipt matches no payment request',
};
export const exceptionClassWords = (value: string): string =>
  lookup(EXCEPTION_CLASS, value, 'A kind of exception this screen has no wording for');

const EXCEPTION_SEVERITY: Readonly<Record<string, string>> = {
  info: 'For information',
  warning: 'Warning',
  critical: 'Critical',
};
export const exceptionSeverityWords = (value: string): string =>
  lookup(EXCEPTION_SEVERITY, value, 'A severity this screen has no wording for');
export const EXCEPTION_SEVERITIES = Object.keys(EXCEPTION_SEVERITY);

const EXCEPTION_STATUS: Readonly<Record<string, string>> = {
  open: 'Open: nobody has acknowledged it',
  acknowledged: 'Acknowledged',
  assigned: 'Assigned',
  resolved: 'Resolved',
  reopened: 'Reopened',
};
export const exceptionStatusWords = (value: string): string =>
  lookup(EXCEPTION_STATUS, value, 'A status this screen has no wording for');

const EXCEPTION_ACTION: Readonly<Record<string, string>> = {
  opened: 'Opened by the system',
  acknowledged: 'Acknowledged',
  assigned: 'Assigned',
  resolved: 'Resolved',
  reopened: 'Reopened',
};
export const exceptionActionWords = (value: string): string =>
  lookup(EXCEPTION_ACTION, value, 'An action this screen has no wording for');

const ACTOR_KIND: Readonly<Record<string, string>> = {
  system: 'the system',
  lender_user: 'a lender user',
  platform_user: 'a member of Udofin staff',
};
export const actorKindWords = (value: string): string =>
  lookup(ACTOR_KIND, value, 'someone this screen has no wording for');

const RESOLVE_REASON: Readonly<Record<string, string>> = {
  verified_with_provider: 'Checked with the provider',
  refunded_by_provider: 'Refunded by the provider',
  posted_by_lender: 'Posted by the lender',
  duplicate_confirmed: 'Confirmed to be a duplicate',
  timing_difference: 'A difference in timing only',
  no_action_needed: 'No action needed',
  escalated_to_provider: 'Passed to the provider',
  escalated_to_lender: 'Passed to the lender',
  documented_elsewhere: 'Recorded elsewhere',
  raised_in_error: 'Raised in error',
  new_information: 'New information received',
};
export const resolveReasonWords = (value: string): string =>
  lookup(RESOLVE_REASON, value, 'A reason this screen has no wording for');

/** A reason read from a stored history row: its wording, or none when the stored value is not on the closed list. */
export const reasonWords = (value: string | null): string | null =>
  value !== null && Object.hasOwn(RESOLVE_REASON, value) ? (RESOLVE_REASON[value] ?? null) : null;

// -- Errors ----------------------------------------------------------------------------------------------------------
const GENERIC_ERROR = 'The action could not be completed. Nothing was changed.';
/** What each stable API or local error code means to the person who did the action. */
const ERROR: Readonly<Record<string, string>> = {
  forbidden: 'You are not allowed to do that.',
  mfa_required: 'Your session needs the second factor again. Sign in once more.',
  signed_out: 'You were signed out. Sign in again.',
  not_found: 'That record was not found.',
  self_approval: 'A different person must do this step. The same person cannot do both.',
  segregation_of_duties: 'A different person must do this step. The same person cannot do both.',
  requester_not_entitled:
    'The person who made the request no longer holds the permission it needs, so it cannot be completed.',
  key_management_unavailable:
    'Registering an account is not available here yet: the key service is not set up. Nothing was stored.',
  account_format_unvalidated:
    'No approved account format rule applies, so the account cannot be registered. Approve a rule first.',
  account_number_invalid:
    'The account number was not accepted. Check the digits against the approved rule. Nothing was stored.',
  ifsc_invalid: 'The IFSC was not accepted. Nothing was stored.',
  owner_invalid: 'The owner details do not fit the owner kind. Nothing was stored.',
  legal_owner_name_invalid:
    'The legal owner name must be the name of an organisation, 3 to 200 characters, with no numbers that look personal.',
  purposes_invalid:
    'Choose between one and four purposes. Only a lender’s own account can be used for repayment settlement.',
  dates_invalid: 'The dates are not valid. The end must be after the start.',
  rekey_invalid: 'That entry cannot be re-registered under the new key version.',
  rekey_owner_mismatch: 'The owner must be the same as the entry being re-registered.',
  masked_ref_invalid: 'The masked reference was not valid. Nothing was stored.',
  account_already_registered: 'That account is already in the registry. Nothing was stored.',
  account_registered_under_other_key:
    'That account is already registered under another key version. Nothing was stored.',
  key_version_not_active: 'No fingerprint key version is active, so nothing can be registered.',
  key_version_not_allowed: 'That key version cannot take a registration.',
  already_rekeyed: 'That entry was already re-registered under the new key version.',
  idempotency_conflict:
    'That request key was already used for different content. Reload the page and try again.',
  idempotency_key_reused:
    'That request key was already used for a different request. Reload the page and try again.',
  idempotency_key_required: 'The request could not be sent safely. Reload the page and try again.',
  not_unverified: 'Only an entry that is waiting for verification can be verified or rejected.',
  not_effective: 'That entry is not effective on today’s date.',
  not_revocable: 'That entry cannot be revoked in its current state.',
  evidence_invalid:
    'Give a short reference to the source, 3 to 200 characters, without long numbers.',
  evidence_ref_invalid:
    'Give a short reference to the source, 3 to 200 characters, without long numbers.',
  reason_required: 'Write a reason of at least 10 characters.',
  reason_invalid:
    'The reason is too short or too long, or it holds a long number or something that looks personal.',
  rule_invalid: 'The rule details are not valid.',
  source_note_required: 'Write where the rule comes from (10 to 500 characters).',
  rule_not_draft: 'Only a draft rule can be submitted or approved.',
  already_submitted: 'That rule was already submitted.',
  not_submitted: 'Submit the rule first. A different person then approves it.',
  key_version_invalid: 'That key version number is not valid.',
  proposal_open: 'A key version is already proposed. Decide it first.',
  not_proposed: 'That key version is not waiting for approval.',
  rotation_incomplete:
    'Some live accounts have not been re-registered under the new key version yet.',
  provider_invalid: 'That provider is not valid.',
  return_code_invalid: 'The return code is not valid.',
  merchant_ref_invalid: 'The merchant reference is not valid.',
  merchant_already_claimed: 'That merchant reference is already taken.',
  merchant_not_active: 'That merchant is not active.',
  already_verified: 'That merchant is already verified.',
  already_linked: 'That settlement account is already linked.',
  settlement_account_revoked: 'That settlement account was revoked and cannot be linked.',
  registry_not_permitted:
    'That registry entry cannot back this settlement account: it must be verified, owned by the same lender, permitted for repayment settlement and effective today.',
  masked_ref_mismatch: 'The masked references of the two accounts differ.',
  unknown_feature: 'That feature is not in the catalogue.',
  feature_not_enableable: 'This feature cannot be enabled in this release.',
  no_change: 'The switch is already in that state.',
  pending_request_exists: 'A request for this switch is already waiting for a decision.',
  prerequisites_unmet:
    'The lender does not yet meet what this switch needs. The reasons are listed below.',
  request_not_pending: 'That request is no longer waiting for a decision.',
  confirm_required: 'Tick the box to confirm before switching a feature off.',
  exception_state_invalid: 'That is not possible in the exception’s current state.',
  assignee_invalid: 'The person to assign to was not valid.',
  evidence_required: 'Give one to three short references to what you checked.',
  validation_failed: 'Please check the values you entered.',
  invalid_request: 'Please check the values you entered.',
  conflict: 'That is not possible in the current state.',
  rate_limited: 'Too many requests. Wait a minute and try again.',
  network_error: 'The service could not be reached. Try again.',
  bad_response: 'The service gave an answer this page could not use. Try again.',
  path_not_allowed: 'That action is not available.',
  unknown: GENERIC_ERROR,
};
/** A stable code to plain words. A code the table does not know (and never a server message) gives the generic sentence. */
export const accountsErrorMessage = (code: string | null | undefined): string =>
  code && Object.hasOwn(ERROR, code) ? (ERROR[code] ?? GENERIC_ERROR) : GENERIC_ERROR;

/** Only a short lower-case code may travel in a redirect URL. */
export const safeErrorCode = (code: string): string =>
  /^[a-z][a-z0-9_]{1,59}$/.test(code) ? code : 'unknown';
