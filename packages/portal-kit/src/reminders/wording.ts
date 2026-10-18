// The words the lender reminder screens use for the API's closed vocabularies and stable error codes. A value or code the table
// does not know is never printed as it came: the screen says it has no wording for it. No server text reaches a screen.
// Nothing here is a statement about a law or a regulator: the screens show what the lender wrote and what the API stored.

const lookup = (table: Readonly<Record<string, string>>, key: string | null, unknown: string) =>
  key !== null && Object.hasOwn(table, key) ? (table[key] ?? unknown) : unknown;

const ARTEFACT_STATUS: Readonly<Record<string, string>> = {
  draft: 'Draft: waiting for approval by another person',
  approved: 'Approved',
  retired: 'Retired',
};
export const artefactStatusWords = (status: string): string =>
  lookup(ARTEFACT_STATUS, status, 'A status this screen has no wording for');

/** Short form for filters and compact lists. */
const ARTEFACT_STATUS_SHORT: Readonly<Record<string, string>> = {
  draft: 'Draft',
  approved: 'Approved',
  retired: 'Retired',
};
export const artefactStatusShort = (status: string): string =>
  lookup(ARTEFACT_STATUS_SHORT, status, 'Unknown status');

const KIND: Readonly<Record<string, string>> = {
  pre_due: 'Before the due date',
  due_day: 'On the due date',
  overdue: 'After the due date (overdue)',
};
export const reminderKindWords = (kind: string): string =>
  lookup(KIND, kind, 'A kind of reminder this screen has no wording for');

const LANGUAGE: Readonly<Record<string, string>> = { en: 'English', hi: 'Hindi' };
export const languageWords = (language: string | null): string =>
  lookup(LANGUAGE, language, 'A language this screen has no wording for');

/** SMS is an inert placeholder: no SMS provider exists and nothing is ever sent by SMS. */
const CHANNEL: Readonly<Record<string, string>> = {
  in_app: 'In-app message',
  push: 'Push notification',
  sms: 'SMS: not available, never sent',
};
export const channelWords = (channel: string): string =>
  lookup(CHANNEL, channel, 'A channel this screen has no wording for');

const REMINDER_STATUS: Readonly<Record<string, string>> = {
  planned: 'Planned: not sent yet',
  claimed: 'Being sent',
  sent: 'Handed to the channel (delivery is shown in the attempts)',
  failed: 'Failed',
  suppressed: 'Not sent',
};
export const reminderStatusWords = (status: string): string =>
  lookup(REMINDER_STATUS, status, 'A status this screen has no wording for');

const REMINDER_STATUS_SHORT: Readonly<Record<string, string>> = {
  planned: 'Planned',
  claimed: 'Being sent',
  sent: 'Handed to the channel',
  failed: 'Failed',
  suppressed: 'Not sent',
};
export const reminderStatusShort = (status: string): string =>
  lookup(REMINDER_STATUS_SHORT, status, 'Unknown status');

const SUPPRESS_REASON: Readonly<Record<string, string>> = {
  loan_closed: 'The loan is reported closed.',
  paid: 'The instalment is reported paid.',
  recent_payment: 'A payment was recorded recently.',
  hold: 'A communication hold is on the loan.',
  penal_text_missing:
    'No approved penal-charge text exists, so an overdue reminder is not sent.',
  template_missing: 'No approved wording exists for this kind of reminder and language.',
  nothing_due: 'The lender reports nothing due.',
  nothing_overdue: 'The lender reports nothing overdue.',
  sms_not_configured: 'SMS is not available and is never sent.',
  channel_not_configured: 'The channel is not set up.',
  policy_retired: 'The policy it came from was replaced or retired.',
  expired: 'It could not be sent in time.',
  figures_unavailable:
    'The lender’s reported figures were not available or not current, so nothing was sent.',
};
export const suppressReasonWords = (reason: string | null): string =>
  lookup(SUPPRESS_REASON, reason, 'A reason this screen has no wording for.');

const HOLD_REASON: Readonly<Record<string, string>> = {
  complaint: 'Complaint',
  hardship: 'Hardship',
  dispute: 'Dispute',
  lender_instruction: 'Lender instruction',
  borrower_request: 'Borrower request',
  legal: 'Legal',
};
export const holdReasonWords = (reason: string): string =>
  lookup(HOLD_REASON, reason, 'A reason this screen has no wording for');

const HOLD_STATUS: Readonly<Record<string, string>> = { active: 'Active', released: 'Released' };
export const holdStatusWords = (status: string): string =>
  lookup(HOLD_STATUS, status, 'A status this screen has no wording for');

const DELIVERY_STATE: Readonly<Record<string, string>> = {
  accepted: 'Accepted by the channel (this is not a delivery report)',
  not_configured: 'The channel is not set up: nothing was sent',
  failed: 'Failed',
  delivered: 'Delivered (from a delivery report)',
  read: 'Read (reported by the app)',
};
export const deliveryStateWords = (state: string): string =>
  lookup(DELIVERY_STATE, state, 'A state this screen has no wording for');

const DELIVERY_SOURCE: Readonly<Record<string, string>> = {
  send: 'Send attempt',
  delivery_report: 'Delivery report',
  app: 'Reported by the app',
};
export const deliverySourceWords = (source: string): string =>
  lookup(DELIVERY_SOURCE, source, 'Another source');

const ERROR_CLASS: Readonly<Record<string, string>> = {
  provider_error: 'The channel reported an error',
  provider_timeout: 'The channel did not answer in time',
  invalid_target: 'The destination was not valid',
  no_consent: 'There is no consent for this channel',
  rate_limited: 'The channel limited the rate',
  unknown: 'The problem is not known',
};
export const deliveryErrorWords = (errorClass: string | null): string =>
  errorClass === null ? '—' : lookup(ERROR_CLASS, errorClass, 'A problem this screen has no wording for');

const CHARGE_KIND: Readonly<Record<string, string>> = {
  flat: 'A flat amount',
  percentage: 'A percentage',
};
export const chargeKindWords = (kind: string): string =>
  lookup(CHARGE_KIND, kind, 'A kind of charge this screen has no wording for');

const CHARGE_BASIS: Readonly<Record<string, string>> = { overdue_amount: 'the overdue amount' };
export const chargeBasisWords = (basis: string): string =>
  lookup(CHARGE_BASIS, basis, 'a basis this screen has no wording for');

// -- Errors ---------------------------------------------------------------------------------------------------------
const GENERIC_ERROR = 'The action could not be completed. Nothing was changed.';
/** What each stable API or local error code means to the person who did the action. */
const ERROR: Readonly<Record<string, string>> = {
  forbidden: 'You are not allowed to do that for this lender.',
  staff_only: 'This is only available to lender staff.',
  no_active_access: 'Your access is not active. Contact your organisation’s administrator.',
  mfa_required: 'Your session needs the second factor again. Sign in once more.',
  signed_out: 'You were signed out. Sign in again.',
  not_found: 'That record was not found for your organisation, or you cannot act on it.',
  self_approval: 'The person who drafted something cannot approve it. Another person must.',
  not_a_draft: 'Only a draft can be approved.',
  already_retired: 'That was already retired.',
  hold_active: 'A hold is already active on that loan.',
  already_released: 'That hold was already released.',
  offsets_invalid:
    'The offsets were not accepted. Check the numbers and how many there are, then try again.',
  channels_invalid: 'The channels were not accepted. Choose each channel at most once.',
  window_invalid: 'The daily window was not accepted. It can only be inside what the platform allows.',
  policy_invalid: 'The policy was not accepted. Check every value and try again.',
  template_invalid: 'The kind or language was not accepted.',
  wording_invalid:
    'The wording was not accepted. It must be a plain service message: no link, address, phone number, long run of digits or promotional words, and only the listed placeholders.',
  penal_text_variable_missing:
    'An overdue wording must contain the penal-charge placeholder exactly as listed.',
  charge_invalid:
    'The charge was not accepted. Give a flat amount or a percentage, not both, and check the figure.',
  attestation_missing: 'Both statements about the charge must be ticked by the lender.',
  hold_invalid: 'The hold was not accepted. Check the reason and the note.',
  unsafe_free_text:
    'The text contains something that looks like personal or secret data and was not accepted. Remove it and try again.',
  validation_failed: 'Please check the values you entered.',
  invalid_request: 'Please check the values you entered.',
  idempotency_key_reused:
    'That request key was already used for a different request. Reload the page and try again.',
  idempotency_key_required: 'The request could not be sent safely. Reload the page and try again.',
  rate_limited: 'Too many requests. Wait a minute and try again.',
  network_error: 'The service could not be reached. Try again.',
  bad_response: 'The service gave an answer this page could not use. Try again.',
  path_not_allowed: 'That action is not available.',
  // Local checks made before anything is sent.
  offsets_format:
    'Write the offsets as whole numbers separated by commas, for example a negative number for days before the due date.',
  channels_required: 'Choose at least one channel.',
  time_invalid: 'Give the time as hours and minutes.',
  cap_invalid: 'Give the daily cap as a whole number.',
  body_required: 'Write the wording first.',
  amount_invalid:
    'Amounts are rupees with digits only and at most two decimals, for example 1250.50.',
  percent_invalid:
    'A percentage uses digits only and at most two decimals, for example 2.5.',
  charge_choice: 'Give a flat amount for a flat charge, or a percentage for a percentage charge, not both.',
  text_required: 'Fill in every required text.',
  note_invalid: 'The note is too long.',
  review_required: 'Tick the box to confirm that you read it in full.',
  id_invalid: 'The loan ID must be the ID shown in the address of the loan’s page.',
};
/** A stable code to plain words. A code the table does not know (and never a server message) gives the generic sentence. */
export const remindersErrorMessage = (code: string | null | undefined): string =>
  code && Object.hasOwn(ERROR, code) ? (ERROR[code] ?? GENERIC_ERROR) : GENERIC_ERROR;

// -- Figures the lender wrote, written down (never worked out) --------------------------------------------------------
/** A stored offset in days from the due date, in words. 0 is the due date; negative is before; positive is after. */
export function offsetWords(days: number): string {
  if (!Number.isSafeInteger(days)) throw new RangeError('an offset is a whole number of days');
  if (days === 0) return 'On the due date';
  const n = Math.abs(days);
  const unit = n === 1 ? 'day' : 'days';
  return days < 0
    ? `${String(n)} ${unit} before the due date`
    : `${String(n)} ${unit} after the due date`;
}

/**
 * A percentage the lender stated in basis points (hundredths of a per cent), written with exact integer arithmetic:
 * 250 becomes "2.50 per cent". It is only a way of writing the stored number; it is never applied to an amount.
 */
export function percentFromBps(bps: number): string {
  if (!Number.isSafeInteger(bps) || bps < 0)
    throw new RangeError('basis points are a non-negative whole number');
  return `${String(Math.floor(bps / 100))}.${String(bps % 100).padStart(2, '0')} per cent`;
}

/** What a person types as a percentage ("2.5"), as whole basis points, or null. Digits with at most two decimals only. */
export function parsePercentToBps(text: string): number | null {
  const m = /^(\d{1,5})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!m) return null;
  const bps = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || '0');
  return bps <= 10_000_000 ? bps : null;
}
