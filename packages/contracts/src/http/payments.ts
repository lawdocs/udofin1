// Phase 08a wire contracts: the BORROWER side of payments and mandates. Every export carries the prefix `Bp` / `BP_` (borrower
// payments) so it cannot collide with another module's names.
//
// Conventions: money is integer paise as a JSON number (`Paise`); dates are `YYYY-MM-DD`; timestamps are ISO 8601 with an offset.
// Responses are strict objects, so a field that is not declared here cannot leave the API. Nothing here carries a provider
// reference, a merchant, a configuration or settlement-account id, a secret reference, a fingerprint, a ciphertext or a key
// version: the most a response can show of the lender's destination account is its masked reference (last digits only), and the
// provider's hand-off link appears only in the response of the two `/link` routes.
//
// The database owns every rule and every closed list below (check constraints, enums and the SQL functions); the lists mirror
// them so a client can render them, and the integration tests fail if one drifts.
import { z } from 'zod';
import { DateOnly, Paise, Timestamp } from '../primitives.js';

const Id = z.uuid();

// ---------------------------------------------------------------------------------------------------------------
// Closed vocabularies
// ---------------------------------------------------------------------------------------------------------------
/** Why a payment is requested. `charges` exists in the database but is refused (409 purpose_not_supported) until the lender reports charges. */
export const BP_PAYMENT_PURPOSES = [
  'installment',
  'overdue',
  'part_prepayment',
  'foreclosure',
  'charges',
] as const;
/** The state of the payment request itself (payments.intent_status). It changes only on a verified provider event or the system's own rules. */
export const BP_PAYMENT_STATUSES = [
  'created',
  'pending',
  'succeeded',
  'failed',
  'expired',
  'cancelled',
] as const;
/**
 * The honest stage derived by the database from verified provider events and the lender's own receipts. `provider_received` means a
 * verified provider event reports the payment, NOT that the lender has posted it; `lender_posted` means the lender's own receipt
 * names it. A redirect, a screen or a client flag can never move it.
 */
export const BP_PAYMENT_STAGES = [
  'started',
  'provider_received',
  'lender_posted',
  'needs_attention',
] as const;
/** Why nothing can be offered right now (the first reason the database found). */
export const BP_PAYMENT_UNAVAILABLE_KEYS = [
  'loan_not_active',
  'collection_target_invalid',
  'config_ambiguous',
] as const;
export const BP_PAYMENT_AMOUNT_SOURCES = [
  'lender_reported',
  'borrower_within_lender_limits',
  'lender_quote',
] as const;
export const BP_MANDATE_RAILS = ['enach_api', 'upi_autopay'] as const;
/** The status exactly as the provider-confirmed history last left it. Only `active` means the provider says the mandate is live. */
export const BP_MANDATE_STATUSES = [
  'draft',
  'registration_pending',
  'active',
  'paused',
  'rejected',
  'failed',
  'expired',
  'cancelled',
  'revoked',
  'requires_reconciliation',
] as const;
export const BP_MANDATE_UNAVAILABLE_KEYS = [
  'loan_not_active',
  'collection_target_invalid',
  'config_ambiguous',
  'provider_not_mandate_capable',
  'rail_not_configured',
  'mandate_exists',
] as const;
export const BP_MANDATE_REQUIREMENTS = ['optional', 'before_first_due'] as const;
export const BP_DEBIT_STATUSES = [
  'scheduled',
  'notified',
  'presented',
  'unknown',
  'settled',
  'returned',
  'cancelled',
] as const;
/** The class of a provider return code, shown only when the lender's configuration classified that code. */
export const BP_RETURN_CLASSES = [
  'insufficient_funds',
  'account_issue',
  'mandate_issue',
  'technical',
  'other',
] as const;
export const BP_NOTICE_STATUSES = ['planned', 'sent', 'late', 'not_needed'] as const;

// ---------------------------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------------------------
export const BpIdParam = z.strictObject({ id: Id });

/**
 * A payment request. The amount is checked by the database against the lender's REPORTED figures (exactly the reported figure,
 * or a part the lender accepts, or between the lender's limits, or exactly the lender's unexpired quotation); this schema checks
 * the shape only. The `Idempotency-Key` header (16 to 128 characters) is also the database's idempotency key.
 */
export const BpPaymentRequest = z.strictObject({
  purpose: z.enum(BP_PAYMENT_PURPOSES),
  amountMinor: Paise.min(1),
  /** Only a foreclosure payment names a quotation (the one from payment-options). */
  quoteId: Id.optional(),
});
export type BpPaymentRequest = z.infer<typeof BpPaymentRequest>;

/**
 * A mandate request. The app chooses `mandateId` BEFORE it asks for the step-up code, and the code (action `mandate_creation`) is
 * bound to this id. The database checks the code, the device-integrity level, the limits and the dates. `maskedAccountRef` is a
 * masked reference only (letters X or *, then the last 2 to 4 digits); a full account number is refused.
 */
export const BpMandateRequest = z.strictObject({
  mandateId: Id,
  rail: z.enum(BP_MANDATE_RAILS),
  /** Omitted: the database uses the lower of the rail limit and the lender's ceiling. */
  maxAmountMinor: Paise.min(1).optional(),
  startDate: DateOnly,
  endDate: DateOnly,
  maskedAccountRef: z
    .string()
    .max(64)
    .regex(/^[X*]{2,}[0-9]{2,4}$/),
});
export type BpMandateRequest = z.infer<typeof BpMandateRequest>;

// ---------------------------------------------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------------------------------------------
export const BpPaymentDetail = z.strictObject({
  id: Id,
  loanId: Id,
  lenderDisplayName: z.string(),
  purpose: z.enum(BP_PAYMENT_PURPOSES),
  /** The amount requested. */
  amountMinor: Paise,
  status: z.enum(BP_PAYMENT_STATUSES),
  stage: z.enum(BP_PAYMENT_STAGES),
  createdAt: Timestamp,
  /** When the payment link stops working at the provider; null until the provider has an order. */
  linkExpiresAt: Timestamp.nullable(),
  /** True while an unexpired payment link can be fetched from `GET /v1/payments/{id}/link`. */
  linkAvailable: z.boolean(),
  /** True only while no order exists at the provider yet (status `created`). */
  cancellable: z.boolean(),
  /** The lender's destination account, masked (last digits only). */
  destinationMaskedRef: z.string().nullable(),
  /** When a verified provider event reported the payment. */
  providerReceivedAt: Timestamp.nullable(),
  /** The value date of the lender's own receipt. */
  lenderPostedOn: DateOnly.nullable(),
});
export type BpPaymentDetail = z.infer<typeof BpPaymentDetail>;

const OptionBase = {
  minMinor: Paise,
  maxMinor: Paise,
};
/** One thing the borrower can pay now. The amounts are the lender's reported figures or limits; Udofin computes none of them. */
export const BpPaymentOption = z.discriminatedUnion('purpose', [
  z.strictObject({
    purpose: z.literal('installment'),
    amountSource: z.literal('lender_reported'),
    /** The lender's reported next installment. */
    amountMinor: Paise,
    dueOn: DateOnly.nullable(),
    ...OptionBase,
  }),
  z.strictObject({
    purpose: z.literal('overdue'),
    amountSource: z.literal('lender_reported'),
    /** The lender's reported total overdue. */
    amountMinor: Paise,
    ...OptionBase,
  }),
  z.strictObject({
    purpose: z.literal('part_prepayment'),
    amountSource: z.literal('borrower_within_lender_limits'),
    ...OptionBase,
  }),
  z.strictObject({
    purpose: z.literal('foreclosure'),
    amountSource: z.literal('lender_quote'),
    /** The amount of the lender's unexpired quotation; the payment must equal it. */
    amountMinor: Paise,
    quoteId: Id,
    validUntil: Timestamp,
    /** True when the lender's quotation does not add up: the payment is refused (quote_flagged) until the lender corrects it. */
    flagged: z.boolean(),
    ...OptionBase,
  }),
]);
export type BpPaymentOption = z.infer<typeof BpPaymentOption>;

export const BpPenalCharge = z.strictObject({
  version: z.number().int(),
  sentenceEn: z.string(),
  sentenceHi: z.string().nullable(),
});

export const BpOpenPayment = z.strictObject({
  id: Id,
  purpose: z.enum(BP_PAYMENT_PURPOSES),
  status: z.enum(BP_PAYMENT_STATUSES),
});

export const BpPaymentOptions = z.strictObject({
  loanId: Id,
  lenderDisplayName: z.string(),
  /** False: nothing can be paid through the app now; `unavailableKey` names the first reason. */
  available: z.boolean(),
  unavailableKey: z.enum(BP_PAYMENT_UNAVAILABLE_KEYS).nullable(),
  destinationMaskedRef: z.string().nullable(),
  /** False when the lender's figures are missing or withheld. Amount-dependent purposes are not offered then. */
  figuresAvailable: z.boolean(),
  /** True when the lender's figures are out of date. Amount-dependent purposes are not offered then. */
  stale: z.boolean(),
  reportedAsOf: Timestamp.nullable(),
  purposes: z.array(BpPaymentOption),
  /** The lender's APPROVED penal-charge sentence when something is overdue; never invented or computed. */
  penalCharge: BpPenalCharge.nullable(),
  /** True when something is overdue and the lender has no approved penal-charge sentence: the app shows nothing in its place. */
  penalChargeTextMissing: z.boolean(),
  /** The borrower's payments on this loan that are still `created` or `pending`. */
  openPayments: z.array(BpOpenPayment),
});
export type BpPaymentOptions = z.infer<typeof BpPaymentOptions>;

/**
 * The answer to a cancellation. Only a payment that has no order at the provider yet can be cancelled (409 intent_not_cancellable
 * otherwise); repeating the request answers the same. Fetch the payment again for its current state.
 */
export const BpPaymentCancelled = z.strictObject({ id: Id, status: z.literal('cancelled') });
export type BpPaymentCancelled = z.infer<typeof BpPaymentCancelled>;

/** The bearer link for the provider's hosted checkout. Short-lived; never logged, never cached. */
export const BpHandoffLink = z.strictObject({
  link: z.string().min(1),
  expiresAt: Timestamp,
});
export type BpHandoffLink = z.infer<typeof BpHandoffLink>;

// ---------------------------------------------------------------------------------------------------------------
// Mandates
// ---------------------------------------------------------------------------------------------------------------
export const BpMandateRailOption = z.strictObject({
  rail: z.enum(BP_MANDATE_RAILS),
  /** The lower of the rail limit (copied from the provider documentation into the lender's configuration) and the lender's ceiling. */
  maxAmountMinor: Paise,
  /** True when the rail may ask for authentication on every debit. */
  needsAfaEachDebit: z.boolean(),
});

export const BpMandateOptions = z.strictObject({
  loanId: Id,
  lenderDisplayName: z.string(),
  available: z.boolean(),
  unavailableKey: z.enum(BP_MANDATE_UNAVAILABLE_KEYS).nullable(),
  /** The lender's mandate requirement (informational: no loan operation is blocked by it). Null when the lender set none. */
  requirement: z.enum(BP_MANDATE_REQUIREMENTS).nullable(),
  preDebitLeadHours: z.number().int(),
  rails: z.array(BpMandateRailOption),
  /** The loan's live mandate, if any (a second one cannot be requested). */
  existingMandateId: Id.nullable(),
});
export type BpMandateOptions = z.infer<typeof BpMandateOptions>;

export const BpMandate = z.strictObject({
  id: Id,
  loanId: Id,
  lenderDisplayName: z.string(),
  rail: z.enum(BP_MANDATE_RAILS),
  status: z.enum(BP_MANDATE_STATUSES),
  maxAmountMinor: Paise,
  startDate: DateOnly,
  endDate: DateOnly,
  maskedAccountRef: z.string(),
  needsAfaEachDebit: z.boolean(),
  /** True once the borrower asked to cancel. The status above changes only when the provider confirms. */
  cancelRequested: z.boolean(),
  nextDebitOn: DateOnly.nullable(),
  nextDebitMinor: Paise.nullable(),
  nextDebitNotified: z.boolean().nullable(),
});
export type BpMandate = z.infer<typeof BpMandate>;

export const BpMandateList = z.strictObject({ items: z.array(BpMandate) });
export type BpMandateList = z.infer<typeof BpMandateList>;

/**
 * The answer to a cancellation request. It is a REQUEST: the mandate is cancelled only when the provider confirms it (a verified
 * event or an authenticated lookup), so the status of `GET /v1/mandates/{id}` does not change here, only `cancelRequested`.
 */
export const BpMandateCancelRequested = z.strictObject({
  id: Id,
  result: z.literal('cancel_requested'),
});
export type BpMandateCancelRequested = z.infer<typeof BpMandateCancelRequested>;

export const BpDebitNotice = z.strictObject({
  status: z.enum(BP_NOTICE_STATUSES),
  dueAt: Timestamp,
  sentAt: Timestamp.nullable(),
});

export const BpMandateDebit = z.strictObject({
  id: Id,
  scheduledOn: DateOnly,
  /** Null for a debit the provider reported without an amount. */
  amountMinor: Paise.nullable(),
  status: z.enum(BP_DEBIT_STATUSES),
  /** True: what Udofin expects from the lender's reported schedule. False: what the provider reported. */
  planned: z.boolean(),
  /** The provider's own return code, verbatim. */
  returnCode: z.string().nullable(),
  returnClass: z.enum(BP_RETURN_CLASSES).nullable(),
  notice: BpDebitNotice.nullable(),
});
export type BpMandateDebit = z.infer<typeof BpMandateDebit>;

/** The newest 60 debits of one mandate, newest scheduled date first. */
export const BpMandateDebitList = z.strictObject({ items: z.array(BpMandateDebit) });
export type BpMandateDebitList = z.infer<typeof BpMandateDebitList>;
