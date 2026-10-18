// The words the lender payment-setup screens use for the API's closed vocabularies, reason codes and stable error codes. A value
// or code the table does not know is never printed as it came: the screen says it has no wording for it. No server text reaches a
// screen. Nothing here says that a set-up is live, safe or compliant: it says what the API reported.

const lookup = (table: Readonly<Record<string, string>>, key: string | null, unknown: string) =>
  key !== null && Object.hasOwn(table, key) ? (table[key] ?? unknown) : unknown;

// -- Modes: a mock or sandbox configuration is for tests and is never presented as live --------------------------------
const MODE: Readonly<Record<string, string>> = {
  mock: 'Test only: mock provider',
  sandbox: 'Test only: provider sandbox',
  production: 'Production mode',
};
export const modeWords = (mode: string): string =>
  lookup(MODE, mode, 'A mode this screen has no wording for');
/** Mock and sandbox are test modes. A mode the screen does not know is treated as a test mode (the cautious reading). */
export const isTestMode = (mode: string): boolean => mode !== 'production';

const CONFIG_STATUS: Readonly<Record<string, string>> = {
  draft: 'Draft: not submitted for approval yet',
  pending_approval: 'Waiting for approval by another person',
  active: 'Approved',
  suspended: 'Suspended: not in use',
  retired: 'Retired',
};
/** The status of a configuration in words; a test-mode configuration always says so next to its status. */
export function configStatusWords(status: string, mode: string): string {
  const words = lookup(CONFIG_STATUS, status, 'A status this screen has no wording for');
  return isTestMode(mode) ? `${words} (test only)` : words;
}
export const CONFIG_STATUSES_SHORT: Readonly<Record<string, string>> = {
  draft: 'Draft',
  pending_approval: 'Waiting for approval',
  active: 'Approved',
  suspended: 'Suspended',
  retired: 'Retired',
};
export const configStatusShort = (status: string): string =>
  lookup(CONFIG_STATUSES_SHORT, status, 'Unknown status');

// -- Merchants, settlement accounts, registry ----------------------------------------------------------------------------
const MERCHANT_VERIFICATION: Readonly<Record<string, string>> = {
  unverified:
    'Not verified yet: the platform team confirms, against evidence, that this identifier belongs to your organisation',
  verified: 'Verified by the platform team',
};
export const merchantVerificationWords = (status: string): string =>
  lookup(MERCHANT_VERIFICATION, status, 'A status this screen has no wording for');

const MERCHANT_STATUS: Readonly<Record<string, string>> = {
  active: 'Claimed',
  revoked: 'Revoked: it cannot be used',
};
export const merchantStatusWords = (status: string): string =>
  lookup(MERCHANT_STATUS, status, 'A status this screen has no wording for');

const SETTLEMENT_STATUS: Readonly<Record<string, string>> = {
  unverified: 'Requested: waiting for the platform team to verify it',
  verified: 'Verified',
  revoked: 'Revoked: it cannot be used',
};
export const settlementStatusWords = (status: string): string =>
  lookup(SETTLEMENT_STATUS, status, 'A status this screen has no wording for');

const REGISTRY_STATUS: Readonly<Record<string, string>> = {
  unverified: 'Registered, not verified yet',
  verified: 'Verified in the account registry',
  rejected: 'Rejected in the account registry',
  revoked: 'Revoked in the account registry',
};
export const registryStatusWords = (status: string): string =>
  lookup(REGISTRY_STATUS, status, 'A status this screen has no wording for');

const PROVIDER_KIND: Readonly<Record<string, string>> = {
  payment: 'payments',
  mandate: 'mandates',
  payment_and_mandate: 'payments and mandates',
};
export const providerKindWords = (kind: string): string =>
  lookup(PROVIDER_KIND, kind, 'a service this screen has no wording for');

// -- Reasons a configuration is not in use (stable identifiers, never data) ----------------------------------------------
const REASON: Readonly<Record<string, string>> = {
  organisation_not_lender: 'The organisation is not recorded as a lender.',
  lender_organisation_not_active: 'The organisation is not active.',
  onboarding_gate_not_activated: 'Onboarding has not reached the stage that allows payments.',
  settlement_account_not_found: 'The settlement account was not found for your organisation.',
  settlement_account_not_verified: 'The settlement account is not verified.',
  settlement_account_unregistered: 'The settlement account is not linked to the account registry.',
  settlement_masked_ref_mismatch:
    'The masked reference of the settlement account differs from the registry entry.',
  merchant_not_found: 'The merchant was not found for your organisation.',
  merchant_not_active: 'The merchant is not active.',
  merchant_not_verified: 'The merchant is not verified.',
  merchant_not_repayment: 'The merchant is not recorded for repayments.',
  merchant_owner_mismatch: 'The merchant belongs to another organisation.',
  merchant_provider_mismatch: 'The merchant is registered at a different provider.',
  provider_not_registered: 'The provider is not on the platform’s provider register.',
  provider_not_approved: 'The provider is not approved on the platform’s provider register.',
  provider_kind_not_payment: 'The provider is not registered for payments.',
  provider_evidence_missing: 'The platform has no authorisation evidence on file for the provider.',
  provider_mode_mock_blocked: 'A mock provider is not allowed in this environment.',
  provider_mode_sandbox_blocked: 'A sandbox provider is not allowed in this environment.',
  config_evidence_missing: 'The provider onboarding confirmation reference is missing.',
  contract_section_missing: 'The contract section reference is missing.',
  config_not_found: 'The configuration was not found.',
  platform_suspension: 'The platform team suspended it.',
};
/** One reason code in words. A code the table does not know gives a plain sentence, never the code. */
export function reasonWords(code: string): string {
  if (Object.hasOwn(REASON, code)) return REASON[code] ?? 'A check did not pass.';
  if (code.startsWith('destination_'))
    return 'The account registry does not accept the settlement account for repayments.';
  return 'A check did not pass. This screen has no wording for it.';
}

const EVENT_KIND: Readonly<Record<string, string>> = {
  drafted: 'Drafted',
  submitted: 'Submitted for approval',
  approved: 'Approved',
  suspended: 'Suspended',
  retired: 'Retired',
};
export const eventKindWords = (kind: string): string =>
  lookup(EVENT_KIND, kind, 'A change this screen has no wording for');

const ACTOR_KIND: Readonly<Record<string, string>> = {
  lender: 'Your organisation',
  platform: 'The platform team',
  system: 'The system',
};
export const actorKindWords = (kind: string): string => lookup(ACTOR_KIND, kind, 'Someone');

// -- Feature switches ----------------------------------------------------------------------------------------------------
const FEATURE: Readonly<Record<string, string>> = {
  servicing_sync: 'Servicing sync (loan data from your lender system)',
  payments: 'Payments',
  mandates: 'Repayment mandates',
  reminders: 'Service reminders',
  statements_noc: 'Statements, foreclosure quotations and no-dues letters',
  collections: 'Collections',
  dlg: 'Default loss guarantee',
};
export const featureWords = (feature: string): string =>
  lookup(FEATURE, feature, 'A feature this screen has no wording for');

// -- Rail limits --------------------------------------------------------------------------------------------------------
/** A limit as the lender typed it: text as written, a flag as yes or no, a whole number exactly as stored (amounts are paise). */
export const railValueWords = (value: string | boolean | number): string =>
  typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value);

// -- Secret references: NAMES, never values ------------------------------------------------------------------------------
export const SECRET_NAME = /^[A-Z][A-Z0-9_]{2,63}$/;
/**
 * Whether text typed as the name of a secret looks like something else: a value. A name is capital letters, digits and
 * underscores, starts with a letter and is 3 to 64 characters long; on top of that this refuses a long run of digits, a long
 * run that is all hexadecimal digits and a long unbroken run with no word separator. It is a convenience that catches the
 * obvious mistake; the API applies its own check and stays the authority.
 */
export function looksLikeSecretValue(text: string): boolean {
  if (!SECRET_NAME.test(text)) return true;
  if (/[0-9]{6,}/.test(text)) return true;
  if (/^[A-F0-9]{16,}$/.test(text)) return true;
  if (!text.includes('_') && text.length >= 20) return true;
  return false;
}

// -- Errors ---------------------------------------------------------------------------------------------------------------
const GENERIC_ERROR = 'The action could not be completed. Nothing was changed.';
const ERROR: Readonly<Record<string, string>> = {
  forbidden: 'You are not allowed to do that for this lender.',
  staff_only: 'This is only available to lender staff.',
  no_active_access: 'Your access is not active. Contact your organisation’s administrator.',
  mfa_required: 'Your session needs the second factor again. Sign in once more.',
  signed_out: 'You were signed out. Sign in again.',
  not_found: 'That record was not found for your organisation, or you cannot act on it.',
  mock_provider_blocked: 'A mock provider is not allowed in this environment.',
  sandbox_provider_blocked: 'A sandbox provider is not allowed in this environment.',
  provider_mode_invalid: 'That mode is not valid.',
  provider_invalid: 'That provider is not one you can choose.',
  merchant_invalid: 'That merchant is not one of your organisation’s.',
  settlement_account_invalid:
    'The settlement account details were not accepted. Check the label, the bank name and the masked reference.',
  secret_ref_invalid:
    'A secret reference must be the NAME of a secret in your secrets manager, not its value, and the two names must differ.',
  rail_limits_invalid:
    'The rail limits were not accepted. Check the names, the values and the source note.',
  merchant_ref_invalid: 'The merchant identifier was not accepted. Check it against your provider.',
  merchant_already_claimed: 'That merchant identifier is already claimed.',
  endpoint_token_in_use: 'Please try again.',
  idempotency_conflict:
    'That request was already used for a different configuration. Reload the page and try again.',
  idempotency_key_reused:
    'That request key was already used for a different request. Reload the page and try again.',
  idempotency_key_required: 'The request could not be sent safely. Reload the page and try again.',
  config_state_invalid: 'The configuration is not in a state that allows this.',
  collection_target_invalid:
    'The settlement account, merchant, provider or references did not pass the check. The reasons are shown on the configuration.',
  self_approval:
    'The person who drafted or submitted a configuration cannot approve it. Another person must.',
  requester_not_entitled: 'Your role does not allow that.',
  reason_required: 'Write a note of at least 10 characters.',
  reason_invalid:
    'The text is too short or too long, or it contains personal details. Use 10 to 1,000 characters and no personal details.',
  unsafe_free_text:
    'The text contains something that looks like personal data and was not accepted. Remove it and try again.',
  validation_failed: 'Please check the values you entered.',
  invalid_request: 'Please check the values you entered.',
  rate_limited: 'Too many requests. Wait a minute and try again.',
  network_error: 'The service could not be reached. Try again.',
  bad_response: 'The service gave an answer this page could not use. Try again.',
  path_not_allowed: 'That action is not available.',
  // Local checks made before anything is sent.
  masked_ref_invalid:
    'Write only the masked reference: X characters followed by the last 2 to 4 digits. Never type a full account number.',
  secret_looks_like_value:
    'That looks like a secret value, not a name. Type only the name of the secret.',
  secrets_same: 'The two secret names must be different.',
  rail_limits_source_required: 'Give the source of the limits when you give any limit.',
  limit_value_invalid:
    'A limit value is not valid for its kind. Amounts are rupees with at most two decimals.',
  review_required: 'Tick the box to confirm that you checked it.',
  decision_invalid: 'Choose approve or reject.',
};
export const setupErrorMessage = (code: string | null | undefined): string =>
  code && Object.hasOwn(ERROR, code) ? (ERROR[code] ?? GENERIC_ERROR) : GENERIC_ERROR;
