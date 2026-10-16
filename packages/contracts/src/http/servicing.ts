// Phase 08a wire contracts: what the borrower sees of a loan the lender services (the loan as the lender reported it, the
// schedule, the activity, lender-issued statements and quotation documents, closure and the service reminders).
// Every export carries the prefix `Svc` so it cannot collide with another module's names.
//
// Conventions: money is integer paise as a JSON number (`Paise`); dates are `YYYY-MM-DD`; timestamps are ISO 8601 with an
// offset. Responses are strict objects, so a field that is not declared here cannot leave the API.
//
// Honesty rules the contract itself carries:
//  - Everything shown is what the LENDER reported, with the lender's time (`reportedAsOf`). Udofin computes nothing.
//  - When the figures of a loan are withheld (`figuresAvailable: false`) every amount is `null`, never zero, and the
//    schema refuses a response that says otherwise.
//  - A foreclosure quotation is the lender's own; a quotation whose parts do not add up to its total is returned flagged
//    (`totalMismatch: true`) so the app can refuse to pay it. An empty answer is `quote: null`, never an invented figure.
//  - The closure view carries prompt KEYS (the app maps them to wording). A key never says that anything was released
//    unless the lender confirmed it.
//  - No bank reference, payment mode or provider reference, no storage key and no lender user appears anywhere in this file.
import { z } from 'zod';
import { DateOnly, Paise, Timestamp } from '../primitives.js';

const Id = z.uuid();

// ---------------------------------------------------------------------------------------------------------------
// Closed vocabularies. The database owns every list below; these mirror them and the integration tests fail if one drifts.
// ---------------------------------------------------------------------------------------------------------------
export const SVC_LOAN_STATUSES = [
  'active',
  'closed',
  'foreclosed',
  'written_off',
  'cancelled',
] as const;
export const SvcLoanStatus = z.enum(SVC_LOAN_STATUSES);

export const SVC_DOCUMENT_KINDS = [
  'statement',
  'foreclosure_quote',
  'noc',
  'closure_letter',
] as const;
export const SvcDocumentKind = z.enum(SVC_DOCUMENT_KINDS);
export const SVC_DOCUMENT_SOURCES = ['lender_upload', 'lms', 'mock'] as const;
export const SvcDocumentSource = z.enum(SVC_DOCUMENT_SOURCES);
export const SVC_QUOTE_SOURCES = ['lender_portal', 'lms', 'mock'] as const;
export const SvcQuoteSource = z.enum(SVC_QUOTE_SOURCES);

export const SVC_REQUEST_STATUSES = [
  'requested',
  'fulfilled',
  'declined',
  'expired',
  'cancelled',
] as const;
export const SvcRequestStatus = z.enum(SVC_REQUEST_STATUSES);

export const SVC_EVIDENCE_STATUSES = [
  'confirmed',
  'likely',
  'interpretation',
  'unverified',
] as const;
export const SvcEvidenceStatus = z.enum(SVC_EVIDENCE_STATUSES);

export const SVC_ACTIVITY_KINDS = [
  'lender_receipt',
  'lender_reversal',
  'payment_attempt',
  'payment_adjustment',
] as const;
export const SvcActivityKind = z.enum(SVC_ACTIVITY_KINDS);
/**
 * receipts: posted, reversed, recorded (what the lender's own system posted); payment attempts: the honest stage derived from
 * verified provider events and the lender's receipts (started, provider_received, lender_posted, needs_attention) or
 * cancelled, failed, expired when the provider never reported money; adjustments: refund, chargeback, reversal, correction.
 */
export const SVC_ACTIVITY_STATES = [
  'posted',
  'reversed',
  'recorded',
  'started',
  'provider_received',
  'lender_posted',
  'needs_attention',
  'cancelled',
  'failed',
  'expired',
  'refund',
  'chargeback',
  'reversal',
  'correction',
] as const;
export const SvcActivityState = z.enum(SVC_ACTIVITY_STATES);
export const SVC_ACTIVITY_PURPOSES = [
  'installment',
  'overdue',
  'part_prepayment',
  'foreclosure',
  'charges',
] as const;
export const SvcActivityPurpose = z.enum(SVC_ACTIVITY_PURPOSES);

export const SVC_COLLATERAL_TYPES = [
  'mutual_fund_lien',
  'demat_pledge',
  'property_documents',
  'vehicle_hypothecation',
  'other',
] as const;
export const SvcCollateralType = z.enum(SVC_COLLATERAL_TYPES);

export const SVC_REMINDER_KINDS = ['pre_due', 'due_day', 'overdue'] as const;
export const SvcReminderKind = z.enum(SVC_REMINDER_KINDS);

// ---------------------------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------------------------
export const SvcLoanIdParams = z.strictObject({ id: Id });
export const SvcLoanDocumentParams = z.strictObject({ id: Id, docId: Id });
export const SvcDocumentRequestParams = z.strictObject({ id: Id, requestId: Id });
export const SvcReminderParams = z.strictObject({ id: Id });

/** The page size is at most 50: the route asks the database for one row more to know whether another page exists. */
export const SVC_ACTIVITY_MAX_LIMIT = 50;
export const SvcActivityQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(SVC_ACTIVITY_MAX_LIMIT).default(25),
  cursor: z.string().min(1).max(300).optional(),
});
export const SvcContentQuery = z.strictObject({
  purpose: z.enum(['view', 'download']).default('view'),
});

/**
 * Both ends or neither (all of the loan's history). The database checks the period (not in the future, not backwards).
 */
export const SvcStatementRequestInput = z.strictObject({
  periodFrom: DateOnly.optional(),
  periodTo: DateOnly.optional(),
});

// ---------------------------------------------------------------------------------------------------------------
// The loan, as the lender reported it
// ---------------------------------------------------------------------------------------------------------------
const FIGURE_KEYS = [
  'reportedStatus',
  'outstandingPrincipalMinor',
  'overduePrincipalMinor',
  'overdueInterestMinor',
  'penalChargesMinor',
  'otherChargesMinor',
  'totalOverdueMinor',
  'nextDueOn',
  'nextDueMinor',
  'daysPastDue',
] as const;

export const SvcLoan = z
  .strictObject({
    loanId: Id,
    lenderId: Id,
    lenderDisplayName: z.string(),
    /** The lender's own reference for the loan. */
    lenderLoanRef: z.string(),
    /** The loan's status as Udofin holds it (it follows the lender forward only). */
    loanStatus: SvcLoanStatus,
    sanctionedAmountMinor: Paise,
    disbursedAmountMinor: Paise.nullable(),
    disbursedAt: Timestamp.nullable(),
    /** The lender's time of the newest report; null when the lender has not reported yet. */
    reportedAsOf: Timestamp.nullable(),
    /** When Udofin received that report. */
    receivedAt: Timestamp.nullable(),
    /** True when nothing was reported, or the newest report is older than the lender's staleness threshold. Pure staleness. */
    stale: z.boolean(),
    staleThresholdMinutes: z.number().int().min(1),
    /**
     * False when there is no report yet, or the newest report is under review (a warning on it, or an unresolved conflict
     * about it). Then every figure below is null. The borrower is not told why: the app says "ask <lender>" or "refresh".
     */
    figuresAvailable: z.boolean(),
    // The figures: the lender's, null when not reported or withheld. Never zero for "unknown".
    reportedStatus: SvcLoanStatus.nullable(),
    outstandingPrincipalMinor: Paise.nullable(),
    overduePrincipalMinor: Paise.nullable(),
    overdueInterestMinor: Paise.nullable(),
    penalChargesMinor: Paise.nullable(),
    otherChargesMinor: Paise.nullable(),
    totalOverdueMinor: Paise.nullable(),
    nextDueOn: DateOnly.nullable(),
    nextDueMinor: Paise.nullable(),
    daysPastDue: z.number().int().min(0).nullable(),
  })
  .superRefine((loan, ctx) => {
    if (loan.figuresAvailable) return;
    for (const key of FIGURE_KEYS) {
      if (loan[key] !== null) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: 'figures are withheld, so this must be null',
        });
      }
    }
  });
export const SvcLoanList = z.strictObject({ items: z.array(SvcLoan) });

// ---------------------------------------------------------------------------------------------------------------
// The schedule, exactly as the lender reported it
// ---------------------------------------------------------------------------------------------------------------
export const SvcInstallment = z.strictObject({
  seq: z.number().int().min(1),
  dueDate: DateOnly,
  principalMinor: Paise,
  interestMinor: Paise,
  feesMinor: Paise,
  totalMinor: Paise,
});
export const SvcSchedule = z.strictObject({
  /** Null (with no installments) when no schedule was reported, or an unresolved conflict about it withholds it. */
  scheduleVersion: z.number().int().min(1).nullable(),
  reportedAsOf: Timestamp.nullable(),
  installments: z.array(SvcInstallment),
});

// ---------------------------------------------------------------------------------------------------------------
// Activity: lender receipts, payment attempts, adjustments
// ---------------------------------------------------------------------------------------------------------------
export const SvcActivityEntry = z.strictObject({
  entryKind: SvcActivityKind,
  entryId: Id,
  /** The instant this entry is ordered by (newest first). */
  sortAt: Timestamp,
  occurredOn: DateOnly,
  amountMinor: Paise.nullable(),
  state: SvcActivityState,
  /** Set for payment attempts only. */
  purpose: SvcActivityPurpose.nullable(),
});
export const SvcActivityPage = z.strictObject({
  items: z.array(SvcActivityEntry),
  nextCursor: z.string().nullable(),
});

// ---------------------------------------------------------------------------------------------------------------
// Lender-issued documents and requests for them
// ---------------------------------------------------------------------------------------------------------------
export const SvcLoanDocument = z.strictObject({
  documentId: Id,
  kind: SvcDocumentKind,
  issuer: z.literal('lender'),
  /** The lender's own number for the document. */
  lenderReference: z.string(),
  issuedAt: Timestamp,
  periodFrom: DateOnly.nullable(),
  periodTo: DateOnly.nullable(),
  sizeBytes: z.number().int().min(1),
  /** `mock` means a labelled test document: the app shows a non-production watermark. */
  source: SvcDocumentSource,
  /** The id of the document that replaced this one, when the lender re-issued it. */
  supersededById: Id.nullable(),
});
export const SvcLoanDocumentList = z.strictObject({ items: z.array(SvcLoanDocument) });

export const SvcLoanDocumentContent = z.strictObject({
  documentId: Id,
  loanId: Id,
  kind: SvcDocumentKind,
  lenderReference: z.string(),
  mimeType: z.literal('application/pdf'),
  sizeBytes: z.number().int().min(1),
  /** SHA-256 of the file; the API has already verified the stored bytes against it, the app may verify again. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  source: SvcDocumentSource,
  contentBase64: z.string(),
});

export const SvcDocumentRequest = z.strictObject({
  requestId: Id,
  kind: SvcDocumentKind,
  status: SvcRequestStatus,
  periodFrom: DateOnly.nullable(),
  periodTo: DateOnly.nullable(),
  requestedAt: Timestamp,
  /** When the lender is expected to answer, from a platform setting that is labelled `unverified`: not a regulatory deadline. */
  dueBy: Timestamp.nullable(),
  dueRuleKey: z.string().nullable(),
  dueEvidenceStatus: SvcEvidenceStatus.nullable(),
  /** The lender's reason when it declined. */
  lenderNote: z.string().nullable(),
  decidedAt: Timestamp.nullable(),
  fulfilledDocumentId: Id.nullable(),
  fulfilledQuoteId: Id.nullable(),
});
export const SvcDocumentRequestList = z.strictObject({ items: z.array(SvcDocumentRequest) });
export const SvcDocumentRequestResult = z.strictObject({ request: SvcDocumentRequest });

// ---------------------------------------------------------------------------------------------------------------
// Foreclosure quotation
// ---------------------------------------------------------------------------------------------------------------
export const SvcQuote = z.strictObject({
  quoteId: Id,
  lenderQuoteRef: z.string(),
  asOf: Timestamp,
  /** Shown as a date and time, never as a countdown. */
  validUntil: Timestamp,
  principalMinor: Paise,
  interestMinor: Paise,
  chargesMinor: Paise,
  prepaymentChargeMinor: Paise,
  totalMinor: Paise,
  /** True when the parts do not add up to the total. The lender's figures are shown as reported; the app must refuse to pay. */
  totalMismatch: z.boolean(),
  /** `mock` means a labelled test quotation: the app shows a non-production watermark. */
  source: SvcQuoteSource,
  /** The lender's quotation letter, when it attached one (open it through the document routes). */
  letterDocumentId: Id.nullable(),
});
export const SvcLatestQuote = z.strictObject({ quote: SvcQuote.nullable() });

// ---------------------------------------------------------------------------------------------------------------
// Closure
// ---------------------------------------------------------------------------------------------------------------
export const SvcDueBasis = z.strictObject({
  ruleKey: z.string(),
  ruleVersion: z.number().int().min(1),
  evidenceStatus: SvcEvidenceStatus,
});
export const SvcSecurityReleaseTask = z.strictObject({
  taskId: Id,
  collateralType: SvcCollateralType,
  status: z.enum(['open', 'confirmed_by_lender']),
  /** Always the lender: only the lender's confirmation changes a status. */
  statusSource: z.literal('lender'),
  promptKey: z
    .string()
    .regex(/^closure\.security_release\.[a-z_]+\.(lender_to_release|lender_confirmed)$/),
  lenderConfirmed: z.boolean(),
  dueBy: Timestamp.nullable(),
  dueBasis: SvcDueBasis.nullable(),
  /** The lender's own words when it recorded a delay. */
  delayReason: z.string().nullable(),
  confirmedAt: Timestamp.nullable(),
});
export const SvcClosure = z.strictObject({
  loanId: Id,
  lenderDisplayName: z.string(),
  /** The live loan status. */
  loanStatus: SvcLoanStatus,
  closureKind: z.enum(['closed', 'foreclosed']),
  /** When Udofin recorded the lender's report, not the lender's own closure date. */
  closureRecordedAt: Timestamp,
  nocStatus: z.enum(['pending', 'issued']),
  nocStatusSource: z.literal('lender'),
  nocPromptKey: z.enum(['closure.noc.lender_to_issue', 'closure.noc.issued_by_lender']),
  nocDueBy: Timestamp.nullable(),
  nocDueBasis: SvcDueBasis.nullable(),
  nocDocumentId: Id.nullable(),
  nocIssuedAt: Timestamp.nullable(),
  securityReleaseTasks: z.array(SvcSecurityReleaseTask),
});
/** `closure` is null while the lender has not reported the loan closed. */
export const SvcClosureResult = z.strictObject({ closure: SvcClosure.nullable() });

// ---------------------------------------------------------------------------------------------------------------
// Service reminders
// ---------------------------------------------------------------------------------------------------------------
export const SvcReminder = z.strictObject({
  reminderId: Id,
  loanId: Id,
  lenderDisplayName: z.string().nullable(),
  kind: SvcReminderKind,
  dueDate: DateOnly,
  sentAt: Timestamp,
  /** The exact wording that was sent (the lender's approved text), nothing re-rendered. */
  message: z.string(),
  readAt: Timestamp.nullable(),
});
export const SvcReminderList = z.strictObject({ items: z.array(SvcReminder) });
export const SvcReminderRead = z.strictObject({ reminderId: Id, state: z.literal('read') });
