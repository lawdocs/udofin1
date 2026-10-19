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
  merchant_mismatch: 'A provider message named a different merchant from the one configured.',
  settlement_account_mismatch:
    'A settlement was reported for an account other than the linked settlement account.',
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
  hold_released: 'Hold released by the platform team',
};
export const eventKindWords = (kind: string): string =>
  lookup(EVENT_KIND, kind, 'A change this screen has no wording for');

/**
 * Who put a suspended configuration on hold. A hold is stronger than a suspension: while it stands, nothing can be submitted,
 * approved or retired for the organisation until the platform team releases it.
 */
const HOLD_KIND: Readonly<Record<string, string>> = {
  platform: 'Held by the platform team',
  system: 'Held by the system after a check did not pass',
};
export const holdKindWords = (kind: string): string =>
  lookup(HOLD_KIND, kind, 'A hold this screen has no wording for');

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
 * Every secret name of a payment configuration starts with the lender's own prefix: `L`, twelve capital hexadecimal digits and an
 * underscore (the API serves it at `GET /v1/lender/secret-ref-prefix`). The prefix is not a secret: it is derived from the
 * organisation's identifier and shown on the form. After it comes a name of two to forty-nine characters, starting with a capital
 * letter. The API and the database stay the authority (they know which prefix is this lender's); this is the shape.
 */
export const SECRET_PREFIX = /^L[0-9A-F]{12}_$/;
export const NAMESPACED_SECRET_NAME = /^L[0-9A-F]{12}_[A-Z][A-Z0-9_]{1,48}$/;
const SECRET_PREFIX_LENGTH = 14;
/** The part of a name the lender chose (after the prefix), or the whole text when it does not start with a prefix. */
const chosenPart = (text: string): string =>
  NAMESPACED_SECRET_NAME.test(text) ? text.slice(SECRET_PREFIX_LENGTH) : text;

/**
 * Whether text typed as the name of a secret looks like something else: a value. A name is capital letters, digits and
 * underscores, starts with a letter and is 3 to 64 characters long; on top of that this refuses a long run of digits, a long
 * run that is all hexadecimal digits and a long unbroken run with no word separator. It is a convenience that catches the
 * obvious mistake; the API applies its own check and stays the authority. The lender's prefix is not judged (it is made of
 * hexadecimal digits that can form a long run of digits); only what the lender chose after it is.
 */
export function looksLikeSecretValue(text: string): boolean {
  if (!SECRET_NAME.test(text)) return true;
  const chosen = chosenPart(text);
  if (/[0-9]{6,}/.test(chosen)) return true;
  if (/^[A-F0-9]{16,}$/.test(chosen)) return true;
  if (!chosen.includes('_') && chosen.length >= 20) return true;
  return false;
}

/**
 * Why a secret name is not accepted for a lender whose prefix is `prefix` (null when the prefix is not known), or null when it is.
 * `secret_looks_like_value` comes first, so a pasted value is never described as merely having the wrong prefix.
 */
export function secretNameProblem(
  name: string,
  prefix: string | null,
): 'secret_looks_like_value' | 'secret_prefix_wrong' | null {
  if (looksLikeSecretValue(name)) return 'secret_looks_like_value';
  if (!NAMESPACED_SECRET_NAME.test(name)) return 'secret_prefix_wrong';
  if (prefix !== null && !name.startsWith(prefix)) return 'secret_prefix_wrong';
  return null;
}

/**
 * Whether the label or bank name of a settlement account could carry a personal or account number. A run of six or more digits
 * is refused (the database does the same), and so is a number split up so that no run is long: nine or more digits once
 * spaces, hyphens, dots and slashes are removed, or a PAN-shaped token in any letter case. The masked reference is the only
 * place an account is named; these two fields are free text and must never become a second copy of a number. The contract and
 * the database apply their own check and stay the authority.
 */
export function looksLikeAccountDetail(text: string): boolean {
  if (/[0-9]{6,}/.test(text)) return true;
  if (/[0-9]{9,}/.test(text.replace(/[\s\-./]/g, ''))) return true;
  return /\b[A-Za-z]{5}[0-9]{4}[A-Za-z]\b/.test(text);
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
    'A secret reference must be the NAME of a secret in your secrets manager, not its value, and it must start with the prefix shown on the form. The two names must differ.',
  rail_limits_invalid:
    'The rail limits were not accepted. Check the names, the values and the source note.',
  merchant_ref_invalid: 'The merchant identifier was not accepted. Check it against your provider.',
  merchant_already_claimed: 'That merchant identifier is already claimed.',
  too_many_claims:
    'You have too many merchant claims waiting for verification. Withdraw the ones you do not need, then claim again.',
  already_verified:
    'A verified merchant cannot be withdrawn here. The platform team revokes a verified merchant.',
  already_linked:
    'A settlement account that is linked to the account registry cannot be withdrawn here. The platform team revokes it.',
  active_config_exists:
    'Another configuration of your organisation is already approved. A lender can have only one approved configuration: retire the other one first.',
  platform_hold:
    'The platform team put a hold on a payment configuration of your organisation, so nothing can be submitted, approved or retired until the platform team releases that hold. Contact the platform team.',
  own_account_list_not_attested:
    'The platform team has not yet confirmed its own list of accounts, so this cannot go ahead yet. Nothing was changed. Try again after the platform team tells you it is done.',
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
    'Write only the masked reference: six capital X letters followed by the last four digits, for example XXXXXX1234. Never type a full account number.',
  secret_looks_like_value:
    'That looks like a secret value, not a name. Type only the name of the secret.',
  secret_prefix_wrong:
    'A secret name must start with the prefix shown on the form, followed by a capital letter and then capital letters, digits or underscores. Nothing was sent.',
  secret_prefix_unknown:
    'The prefix for your secret names could not be read, so a configuration cannot be drafted right now. Try again later.',
  secrets_same: 'The two secret names must be different.',
  rail_limits_source_required: 'Give the source of the limits when you give any limit.',
  limit_value_invalid:
    'A limit value is not valid for its kind. Amounts are rupees with at most two decimals.',
  review_required: 'Tick the box to confirm that you checked it.',
  confirm_required: 'Tick the box to confirm that you want to withdraw this.',
  decision_invalid: 'Choose approve or reject.',
};
export const setupErrorMessage = (code: string | null | undefined): string =>
  code && Object.hasOwn(ERROR, code) ? (ERROR[code] ?? GENERIC_ERROR) : GENERIC_ERROR;
