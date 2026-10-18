// Phase 08a wire contracts: lender-side payments, verified provider events, policies, mandates, reconciliation and the
// exception queue. Every export carries the prefix `Lp` (lender payments) so it cannot collide with another module's names.
//
// Conventions: money is integer paise as a JSON number (`Paise`); dates are `YYYY-MM-DD`; timestamps are ISO 8601 with an
// offset. Responses are strict objects, so a field that is not declared here cannot leave the API. No borrower identity, no
// payload body or payload hash, no secret reference, no token hash, no fingerprint and no account number appears anywhere in
// this file: a masked reference (last digits only) is the most a response can carry.
import { z } from 'zod';
import { DateOnly, Paise, Timestamp } from '../primitives.js';

const Id = z.uuid();
const Limit = z.coerce.number().int().min(1).max(100).default(25);
const CursorText = z.string().min(1).max(300);
const Page = <T extends z.ZodType>(item: T) =>
  z.strictObject({ items: z.array(item), nextCursor: z.string().nullable() });

// ---------------------------------------------------------------------------------------------------------------
// Closed vocabularies. The database owns every list below (check constraints and enums); these mirror them so a
// client can render them, and the integration tests fail if one drifts.
// ---------------------------------------------------------------------------------------------------------------
export const LP_PAYMENT_STATUSES = [
  'created',
  'pending',
  'succeeded',
  'failed',
  'expired',
  'cancelled',
] as const;
export const LP_PAYMENT_PURPOSES = [
  'installment',
  'overdue',
  'part_prepayment',
  'foreclosure',
  'charges',
] as const;
export const LP_PROVIDER_PAYMENT_STATUSES = [
  'created',
  'pending',
  'authorized',
  'captured',
  'paid',
  'succeeded',
  'failed',
  'refunded',
  'disputed',
  'cancelled',
  'expired',
] as const;
export const LP_ADJUSTMENT_KINDS = ['refund', 'chargeback', 'reversal', 'correction'] as const;
export const LP_SETTLEMENT_STAGES = [
  'provider_captured',
  'provider_settled',
  'bank_confirmed',
  'lender_posted',
] as const;
/** What a bank-confirmed stage rests on. Today the only basis is a credit the LENDER reported: Udofin has no bank statement of its own. */
export const LP_BANK_CONFIRMATION_BASES = ['lender_reported_credit'] as const;
export const LP_EVENT_OBJECT_KINDS = [
  'payment',
  'refund',
  'chargeback',
  'mandate',
  'debit',
  'settlement',
  'unsupported',
] as const;
export const LP_EVENT_OUTCOMES = [
  'applied',
  'already_applied',
  'ignored_stale',
  'deferred',
  'exception',
  'ignored_unsupported',
  'ignored_unsupported_yet',
  'recorded_for_reconciliation',
] as const;
export const LP_RECEIPT_OUTCOMES = [
  'verified',
  'verified_ignored',
  'duplicate',
  'unverified',
  'stale_timestamp',
  'unmatched',
  'invalid',
  'scheme_not_configured',
] as const;
export const LP_MANDATE_RAILS = ['enach_api', 'upi_autopay'] as const;
export const LP_MANDATE_STATUSES = [
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
export const LP_DEBIT_STATUSES = [
  'scheduled',
  'notified',
  'presented',
  'unknown',
  'settled',
  'returned',
  'cancelled',
] as const;
export const LP_RETURN_CLASSES = [
  'insufficient_funds',
  'account_issue',
  'mandate_issue',
  'technical',
  'other',
] as const;
export const LP_MANDATE_REQUIREMENTS = ['optional', 'before_first_due'] as const;
export const LP_EXCEPTION_STATUSES = [
  'open',
  'acknowledged',
  'assigned',
  'resolved',
  'reopened',
] as const;
export const LP_EXCEPTION_ACTIONS = [
  'opened',
  'acknowledged',
  'assigned',
  'resolved',
  'reopened',
] as const;
export const LP_EXCEPTION_SEVERITIES = ['info', 'warning', 'critical'] as const;
export const LP_EXCEPTION_OWNERS = ['lender', 'platform'] as const;
/** The reasons a person may give when resolving an exception (the database list is authoritative). */
export const LP_RESOLVE_REASONS = [
  'verified_with_provider',
  'refunded_by_provider',
  'posted_by_lender',
  'duplicate_confirmed',
  'timing_difference',
  'no_action_needed',
  'escalated_to_provider',
  'escalated_to_lender',
  'documented_elsewhere',
  'raised_in_error',
  'new_information',
] as const;
/** The reasons a person may give when reopening a resolved exception (the database list is authoritative). */
export const LP_REOPEN_REASONS = [
  'new_information',
  'raised_in_error',
  'verified_with_provider',
  'escalated_to_provider',
  'escalated_to_lender',
] as const;

/** The maximum number of rows in one bank-credit upload (the database refuses more than 2,000). */
export const LP_BANK_CREDIT_MAX_ROWS = 2000;
/** The maximum size of an uploaded statement in characters. */
export const LP_BANK_CREDIT_MAX_CSV_CHARS = 250_000;

// ---------------------------------------------------------------------------------------------------------------
// Payments (what the borrowers asked to pay, what the provider reported, how far each payment has travelled)
// ---------------------------------------------------------------------------------------------------------------
export const LpPaymentListQuery = z.strictObject({
  lenderId: Id.optional(),
  status: z.enum(LP_PAYMENT_STATUSES).optional(),
  purpose: z.enum(LP_PAYMENT_PURPOSES).optional(),
  loanAccountId: Id.optional(),
  limit: Limit,
  cursor: CursorText.optional(),
});

/** One payment request as the lender sees it. No borrower identity: the loan account is the link. */
export const LpPaymentRow = z.strictObject({
  id: Id,
  lenderId: Id,
  loanAccountId: Id,
  purpose: z.enum(LP_PAYMENT_PURPOSES),
  amountMinor: Paise,
  currency: z.literal('INR'),
  status: z.enum(LP_PAYMENT_STATUSES),
  provider: z.string(),
  providerMode: z.string().nullable(),
  providerOrderRef: z.string().nullable(),
  targetInstallmentSeq: z.number().int().nullable(),
  linkExpiresAt: Timestamp.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type LpPaymentRow = z.infer<typeof LpPaymentRow>;
export const LpPaymentPage = Page(LpPaymentRow);

/**
 * How far a successful provider payment has travelled, DERIVED from the tables (nothing sets a stage): the provider
 * captured it, the provider's settlement report lists it, the lender's bank credit matches, the lender's own receipt
 * carries our reference. `settlementDestinationOk` is false when the provider reported settling somewhere other than
 * the lender's verified account, and null when the provider did not state a destination. `bankConfirmationBasis` says what a
 * confirmed bank stage rests on (null when it is not confirmed): the credit the lender reported, not a statement Udofin holds.
 */
export const LpPaymentStage = z.strictObject({
  stage: z.enum(LP_SETTLEMENT_STAGES),
  providerCaptured: z.boolean(),
  providerSettled: z.boolean(),
  bankConfirmed: z.boolean(),
  bankConfirmationBasis: z.enum(LP_BANK_CONFIRMATION_BASES).nullable(),
  lenderPosted: z.boolean(),
  settlementDestinationOk: z.boolean().nullable(),
});

export const LpProviderPayment = z.strictObject({
  id: Id,
  providerPaymentRef: z.string(),
  orderRef: z.string(),
  status: z.enum(LP_PROVIDER_PAYMENT_STATUSES),
  amountMinor: Paise.nullable(),
  currency: z.literal('INR').nullable(),
  capturedAt: Timestamp.nullable(),
  duplicateCapture: z.boolean(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  /** Null while the payment is not a successful, non-duplicate capture (the stage exists only for those). */
  stage: LpPaymentStage.nullable(),
});

export const LpAdjustment = z.strictObject({
  id: Id,
  providerPaymentId: Id,
  kind: z.enum(LP_ADJUSTMENT_KINDS),
  objectRef: z.string(),
  amountMinor: Paise,
  occurredAt: Timestamp,
  createdAt: Timestamp,
});

export const LpPaymentDetail = z.strictObject({
  payment: LpPaymentRow,
  providerPayments: z.array(LpProviderPayment),
  adjustments: z.array(LpAdjustment),
});

// ---------------------------------------------------------------------------------------------------------------
// Verified provider events and the webhook summary
// ---------------------------------------------------------------------------------------------------------------
export const LpProviderEventListQuery = z.strictObject({
  lenderId: Id.optional(),
  objectKind: z.enum(LP_EVENT_OBJECT_KINDS).optional(),
  paymentIntentId: Id.optional(),
  limit: Limit,
  cursor: CursorText.optional(),
});

export const LpEventProcessing = z.strictObject({
  outcome: z.enum(LP_EVENT_OUTCOMES),
  reasonClass: z.string(),
  attempt: z.number().int(),
  deferredUntil: Timestamp.nullable(),
  processedAt: Timestamp,
});

/**
 * A VERIFIED provider event (authenticated, integrity-checked, correlated, business-valid) and the newest outcome of
 * applying it. Never the payload, a payload hash, a signature, a header or an address.
 */
export const LpProviderEventRow = z.strictObject({
  id: Id,
  lenderId: Id,
  provider: z.string(),
  providerEventId: z.string(),
  eventType: z.string(),
  objectKind: z.enum(LP_EVENT_OBJECT_KINDS).nullable(),
  objectRef: z.string().nullable(),
  orderRef: z.string().nullable(),
  paymentIntentId: Id.nullable(),
  providerStatus: z.string().nullable(),
  amountMinor: Paise.nullable(),
  currency: z.literal('INR').nullable(),
  occurredAt: Timestamp.nullable(),
  receivedAt: Timestamp,
  processingClass: z.enum(['actionable', 'ignored']).nullable(),
  verification: z
    .strictObject({
      authentication: z.string(),
      integrity: z.string(),
      correlation: z.string(),
      business: z.string(),
    })
    .nullable(),
  /** Null while the worker has not yet recorded an outcome. */
  processing: LpEventProcessing.nullable(),
});
export const LpProviderEventPage = Page(LpProviderEventRow);

export const LpWebhookSummaryQuery = z.strictObject({ lenderId: Id });
export const LpWebhookSummary = z.strictObject({
  lenderId: Id,
  items: z.array(
    z.strictObject({
      outcome: z.enum(LP_RECEIPT_OUTCOMES),
      receipts: z.number().int().min(0),
      lastReceivedAt: Timestamp.nullable(),
    }),
  ),
});

// ---------------------------------------------------------------------------------------------------------------
// Policies and settings (what the lender accepts; Udofin decides no amount)
// ---------------------------------------------------------------------------------------------------------------
export const LpLenderFilterQuery = z.strictObject({ lenderId: Id.optional() });

export const LpPaymentPolicy = z.strictObject({
  lenderId: Id,
  allowPartialPayments: z.boolean(),
  minPartialAmountMinor: Paise.nullable(),
  allowPartPrepayment: z.boolean(),
  minPartPrepaymentMinor: Paise.nullable(),
  linkValidityMinutes: z.number().int(),
  updatedAt: Timestamp,
});
export const LpPaymentPolicyList = z.strictObject({ items: z.array(LpPaymentPolicy) });
export const LpPaymentPolicyInput = z.strictObject({
  lenderId: Id,
  allowPartialPayments: z.boolean(),
  minPartialAmountMinor: Paise.nullable().optional(),
  allowPartPrepayment: z.boolean(),
  minPartPrepaymentMinor: Paise.nullable().optional(),
  linkValidityMinutes: z.number().int().min(0).max(1_000_000),
});

export const LpMandatePolicy = z.strictObject({
  lenderId: Id,
  requirement: z.enum(LP_MANDATE_REQUIREMENTS),
  maxAmountCapMinor: Paise.nullable(),
  preDebitLeadHours: z.number().int(),
  updatedAt: Timestamp,
});
export const LpMandatePolicyList = z.strictObject({ items: z.array(LpMandatePolicy) });
export const LpMandatePolicyInput = z.strictObject({
  lenderId: Id,
  requirement: z.enum(LP_MANDATE_REQUIREMENTS),
  maxAmountCapMinor: Paise.nullable().optional(),
  preDebitLeadHours: z.number().int().min(0).max(100_000),
});

export const LpReconciliationSettings = z.strictObject({
  lenderId: Id,
  settlementLagDays: z.number().int(),
  receiptLagHours: z.number().int(),
  updatedAt: Timestamp,
});
export const LpReconciliationSettingsList = z.strictObject({
  items: z.array(LpReconciliationSettings),
});
/**
 * The waiting times, in the range the database accepts: 1 to 7 days and 1 to 168 hours. The ceilings are the platform's own
 * limits and are not verified against any provider or bank agreement.
 */
export const LP_SETTLEMENT_LAG_DAYS = { min: 1, max: 7 } as const;
export const LP_RECEIPT_LAG_HOURS = { min: 1, max: 168 } as const;
export const LpReconciliationSettingsInput = z.strictObject({
  lenderId: Id,
  settlementLagDays: z
    .number()
    .int()
    .min(LP_SETTLEMENT_LAG_DAYS.min)
    .max(LP_SETTLEMENT_LAG_DAYS.max),
  receiptLagHours: z.number().int().min(LP_RECEIPT_LAG_HOURS.min).max(LP_RECEIPT_LAG_HOURS.max),
});

/** The answer of every settings write: the database function answered `set`. */
export const LpSetResult = z.strictObject({ outcome: z.literal('set') });

// ---------------------------------------------------------------------------------------------------------------
// Mandates and their debits
// ---------------------------------------------------------------------------------------------------------------
export const LpMandateListQuery = z.strictObject({
  lenderId: Id.optional(),
  status: z.enum(LP_MANDATE_STATUSES).optional(),
  loanAccountId: Id.optional(),
  limit: Limit,
  cursor: CursorText.optional(),
});

/**
 * A mandate with the status exactly as the provider-confirmed history last left it: nothing is "active" until the provider
 * says so. The borrower's account appears only as the masked reference the borrower supplied.
 */
export const LpMandateRow = z.strictObject({
  id: Id,
  lenderId: Id,
  loanAccountId: Id,
  rail: z.enum(LP_MANDATE_RAILS),
  status: z.enum(LP_MANDATE_STATUSES),
  provider: z.string(),
  providerMode: z.string(),
  providerMandateRef: z.string().nullable(),
  maxAmountMinor: Paise,
  startDate: DateOnly,
  endDate: DateOnly,
  maskedAccountRef: z.string(),
  needsAfaEachDebit: z.boolean(),
  handoffExpiresAt: Timestamp.nullable(),
  lastEventAt: Timestamp.nullable(),
  cancelRequestedAt: Timestamp.nullable(),
  cancelReason: z.enum(['borrower', 'loan_closed']).nullable(),
  cancelSentAt: Timestamp.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export const LpMandatePage = Page(LpMandateRow);

export const LpMandateEvent = z.strictObject({
  id: Id,
  fromStatus: z.enum(LP_MANDATE_STATUSES).nullable(),
  toStatus: z.enum(LP_MANDATE_STATUSES),
  source: z.string(),
  providerEventId: Id.nullable(),
  observedAt: Timestamp,
  createdAt: Timestamp,
});

export const LpMandateDebitListQuery = z.strictObject({
  lenderId: Id.optional(),
  mandateId: Id.optional(),
  loanAccountId: Id.optional(),
  status: z.enum(LP_DEBIT_STATUSES).optional(),
  planned: z.enum(['true', 'false']).optional(),
  limit: Limit,
  cursor: CursorText.optional(),
});

/**
 * A debit of a mandate. `planned` debits are what Udofin expects from the lender's reported schedule (for the pre-debit
 * notice); an unplanned one is what the provider reported. The return code is the provider's own.
 */
export const LpMandateDebit = z.strictObject({
  id: Id,
  lenderId: Id,
  mandateId: Id,
  loanAccountId: Id,
  planned: z.boolean(),
  installmentSeq: z.number().int().nullable(),
  scheduledOn: DateOnly,
  amountMinor: Paise.nullable(),
  status: z.enum(LP_DEBIT_STATUSES),
  providerDebitRef: z.string().nullable(),
  returnCode: z.string().nullable(),
  returnClass: z.enum(LP_RETURN_CLASSES).nullable(),
  exceedsMandateMax: z.boolean(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export const LpMandateDebitPage = Page(LpMandateDebit);

export const LpPreDebitNotice = z.strictObject({
  id: Id,
  debitId: Id,
  noticeDueAt: Timestamp,
  status: z.enum(['planned', 'sent', 'late', 'not_needed']),
  deliveryState: z.enum(['accepted', 'delivered']).nullable(),
  sentAt: Timestamp.nullable(),
});

/** The newest 100 history rows, 60 debits and 60 notices; the full debit list is `GET /v1/lender/mandate-debits?mandateId=`. */
export const LpMandateDetail = z.strictObject({
  mandate: LpMandateRow,
  events: z.array(LpMandateEvent),
  debits: z.array(LpMandateDebit),
  notices: z.array(LpPreDebitNotice),
});

// ---------------------------------------------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------------------------------------------
export const LpRunListQuery = z.strictObject({
  lenderId: Id.optional(),
  date: DateOnly.optional(),
  limit: Limit,
  cursor: CursorText.optional(),
});

export const LpRunCounts = z.strictObject({
  paymentsConsidered: z.number().int().nullable(),
  matchedToSettlement: z.number().int().nullable(),
  matchedToBank: z.number().int().nullable(),
  matchedToReceipt: z.number().int().nullable(),
});
export const LpRunRow = z.strictObject({
  id: Id,
  lenderId: Id,
  runDate: DateOnly,
  runNo: z.number().int(),
  counts: LpRunCounts,
  createdAt: Timestamp,
});
export const LpRunPage = Page(LpRunRow);

/**
 * What the standing line rests on. Zero settled to another account is evidence only when `zeroIsEvidence` is true: a
 * settlement report exists and no batch lacks a verified destination. A batch whose destination the provider did not state
 * is counted under `destinationUnstated*`; it is neither safe nor wrong, and it blocks the evidence. A field the report does
 * not carry (a run made before this was recorded) is null, never zero, and a null `zeroIsEvidence` is not evidence.
 */
export const LpSettlementEvidence = z.strictObject({
  settlementReportExists: z.boolean().nullable(),
  offAccountBatches: z.number().int().min(0).nullable(),
  offAccountNetMinor: z.number().int().min(0).nullable(),
  destinationUnstatedBatches: z.number().int().min(0).nullable(),
  destinationUnstatedMinor: z.number().int().min(0).nullable(),
  destinationUnstatedNetMinor: z.number().int().min(0).nullable(),
  zeroIsEvidence: z.boolean().nullable(),
});

/**
 * What the run could not check is listed in `notReconcilable`, never reported as reconciled. `settledToNonLender` is the
 * standing line: provider settlements reported to an account that is not the lender's verified one (items and gross paise
 * of the batches); anything other than zero is a critical finding, and zero is evidence only as `settlementEvidence` says.
 */
export const LpRunReport = z.strictObject({
  runDate: DateOnly.nullable(),
  paymentsConsidered: z.number().int().nullable(),
  matched: z.strictObject({
    settlement: z.number().int().nullable(),
    bank: z.number().int().nullable(),
    receipt: z.number().int().nullable(),
  }),
  notReconcilable: z.array(z.string()),
  settledToNonLender: z.strictObject({
    items: z.number().int().nullable(),
    minor: z.number().int().min(0).nullable(),
  }),
  settlementEvidence: LpSettlementEvidence,
  settings: z.strictObject({
    settlementLagDays: z.number().int().nullable(),
    receiptLagHours: z.number().int().nullable(),
    /** True when a waiting time is longer than the platform default (3 days, 72 hours); null when the run did not record it. */
    abovePlatformDefault: z.boolean().nullable(),
  }),
});

export const LpReconciliationSummaryQuery = z.strictObject({ lenderId: Id, date: DateOnly });
export const LpReconciliationSummary = z.strictObject({
  runId: Id,
  lenderId: Id,
  runNo: z.number().int(),
  runDate: DateOnly,
  counts: LpRunCounts,
  report: LpRunReport,
  createdAt: Timestamp,
});

export const LpSettlementBatchListQuery = z.strictObject({
  lenderId: Id.optional(),
  from: DateOnly.optional(),
  to: DateOnly.optional(),
  limit: Limit,
  cursor: CursorText.optional(),
});

/**
 * A settlement batch exactly as the provider reported it (amounts are never recomputed). `destinationOk` is false when
 * the reported destination is not the lender's verified settlement account.
 */
export const LpSettlementBatch = z.strictObject({
  id: Id,
  lenderId: Id,
  provider: z.string(),
  batchRef: z.string(),
  settlementRef: z.string(),
  periodFrom: DateOnly,
  periodTo: DateOnly,
  destinationMaskedRef: z.string().nullable(),
  destinationOk: z.boolean().nullable(),
  grossMinor: Paise,
  feeMinor: Paise,
  taxMinor: Paise,
  netMinor: Paise,
  partsMismatch: z.boolean(),
  itemCount: z.number().int(),
  reportDate: DateOnly,
  receivedAt: Timestamp,
});
export const LpSettlementBatchPage = Page(LpSettlementBatch);

export const LpSettlementItemListQuery = z.strictObject({
  limit: Limit,
  cursor: CursorText.optional(),
});
export const LpSettlementItem = z.strictObject({
  id: Id,
  providerPaymentRef: z.string(),
  orderRef: z.string().nullable(),
  grossMinor: Paise,
  feeMinor: Paise,
  taxMinor: Paise,
  netMinor: Paise,
  partsMismatch: z.boolean(),
});
export const LpSettlementItemPage = Page(LpSettlementItem);

/** One credit the lender reports: the value date, the amount in paise and the bank reference (UTR). Nothing else is accepted. */
export const LpBankCreditRow = z.strictObject({
  valueDate: DateOnly,
  amountMinor: Paise.min(1),
  utr: z.string().min(4).max(60),
});
export const LpBankCreditsInput = z
  .strictObject({
    lenderId: Id,
    accountId: Id,
    /** The credits as JSON. Send exactly one of `rows` and `csv`. */
    rows: z.array(LpBankCreditRow).min(1).max(LP_BANK_CREDIT_MAX_ROWS).optional(),
    /**
     * The credits as CSV text with exactly the columns valueDate, amountMinor and utr (a header line, then one line per
     * credit). Any other column, quoted field or malformed line refuses the WHOLE upload and names no value.
     */
    csv: z.string().min(1).max(LP_BANK_CREDIT_MAX_CSV_CHARS).optional(),
  })
  .refine((body) => (body.rows === undefined) !== (body.csv === undefined), {
    message: 'send exactly one of rows and csv',
    path: ['rows'],
  });
export const LpBankCreditsResult = z.strictObject({
  inserted: z.number().int().min(0),
  duplicates: z.number().int().min(0),
});

// ---------------------------------------------------------------------------------------------------------------
// The exception queue
// ---------------------------------------------------------------------------------------------------------------
export const LpExceptionListQuery = z.strictObject({
  lenderId: Id.optional(),
  status: z.enum(LP_EXCEPTION_STATUSES).optional(),
  class: z
    .string()
    .regex(/^[a-z][a-z_]{2,60}$/)
    .optional(),
  severity: z.enum(LP_EXCEPTION_SEVERITIES).optional(),
  owner: z.enum(LP_EXCEPTION_OWNERS).optional(),
  limit: Limit,
  cursor: CursorText.optional(),
});
export const LpPlatformExceptionListQuery = z.strictObject({
  lenderId: Id.optional(),
  class: z
    .string()
    .regex(/^[a-z][a-z_]{2,60}$/)
    .optional(),
  severity: z.enum(LP_EXCEPTION_SEVERITIES).optional(),
  limit: Limit,
  cursor: CursorText.optional(),
});

/** An exception of the reconciliation queue. The subject holds identifiers only (never a name, number or amount). */
export const LpException = z.strictObject({
  id: Id,
  lenderId: Id,
  class: z.string(),
  severity: z.enum(LP_EXCEPTION_SEVERITIES),
  owner: z.enum(LP_EXCEPTION_OWNERS),
  status: z.enum(LP_EXCEPTION_STATUSES),
  subject: z.record(z.string(), z.string()),
  assignedTo: Id.nullable(),
  openedAt: Timestamp,
  resolvedAt: Timestamp.nullable(),
  updatedAt: Timestamp,
});
export const LpExceptionPage = Page(LpException);

export const LpExceptionEvent = z.strictObject({
  id: Id,
  action: z.enum(LP_EXCEPTION_ACTIONS),
  actorKind: z.enum(['system', 'lender_user', 'platform_user']),
  actorUserId: Id.nullable(),
  reasonCode: z.string().nullable(),
  evidence: z.array(z.string()).nullable(),
  note: z.string().nullable(),
  assignedTo: Id.nullable(),
  authorisedByPermission: z
    .enum(['payment.reconcile', 'platform.payments.providers.manage'])
    .nullable(),
  occurredAt: Timestamp,
});

export const LpExceptionDetail = z.strictObject({
  exception: LpException,
  events: z.array(LpExceptionEvent),
});

export const LpExceptionAssignInput = z.strictObject({ assignee: Id });

/**
 * Resolving annotates the exception and changes nothing else. `reasonCode` must be on the closed list
 * (LP_RESOLVE_REASONS) and `evidence` holds 1 to 10 short ids or labels (letters, digits and . _ : / # - only, no
 * spaces); the database enforces both and refuses anything else.
 */
export const LpExceptionResolveInput = z.strictObject({
  reasonCode: z.string().regex(/^[a-z][a-z_]{2,40}$/),
  evidence: z.array(z.string().min(1).max(100)).min(1).max(10),
  note: z.string().max(500).optional(),
});
/** Reopening needs a reason from LP_REOPEN_REASONS (the database list is authoritative). */
export const LpExceptionReopenInput = z.strictObject({
  reasonCode: z.string().regex(/^[a-z][a-z_]{2,40}$/),
  note: z.string().max(500).optional(),
});
export const LpExceptionActionResult = z.strictObject({
  status: z.enum(['acknowledged', 'assigned', 'resolved', 'reopened']),
});
