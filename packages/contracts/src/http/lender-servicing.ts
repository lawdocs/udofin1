// Phase 08a wire contracts: lender-side servicing (loans as the lender reported them, sync status, the LMS connection,
// file import, conflicts and anomalies), lender-issued documents, foreclosure quotations and closure / security release.
// Every export carries the prefix `Ls` (lender servicing) so it cannot collide with another module's names.
//
// Conventions: money is integer paise as a JSON number (`Paise`); dates are `YYYY-MM-DD`; timestamps are ISO 8601 with an
// offset. Responses are strict objects, so a field that is not declared here cannot leave the API. Everything below is
// what the LENDER reported, with the lender's time: Udofin computes no balance, interest, charge, days past due, stage or
// foreclosure amount. No borrower identity, no user id, no storage key, no secret reference, no content hash of a
// record and no row value of an import appears anywhere in this file: an import error carries a row number, a class and
// the NAME of a field, never the value.
import { z } from 'zod';
import { DateOnly, Paise, Timestamp } from '../primitives.js';

const Id = z.uuid();
const Limit = z.coerce.number().int().min(1).max(100).default(25);
const CursorText = z.string().min(1).max(300);
const Page = <T extends z.ZodType>(item: T) =>
  z.strictObject({ items: z.array(item), nextCursor: z.string().nullable() });
const Count = z.number().int().min(0);
/** An error class or a field name: lower-case words only, so no value can be smuggled through a response. */
const Code = z.string().regex(/^[a-z][a-z0-9_]{1,59}$/);
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

// ---------------------------------------------------------------------------------------------------------------
// Closed vocabularies. The database owns every list below (check constraints and enums); these mirror them so a
// client can render them, and the integration tests fail if one drifts.
// ---------------------------------------------------------------------------------------------------------------
export const LS_LOAN_STATUSES = [
  'active',
  'closed',
  'foreclosed',
  'written_off',
  'cancelled',
] as const;
export const LS_CONNECTION_KINDS = [
  'file_import',
  'manual',
  'mock',
  'finbyx',
  'generic_rest',
] as const;
export const LS_CONNECTION_STATUSES = ['draft', 'active', 'paused', 'blocked_unverified'] as const;
export const LS_CAPABILITY_KEYS = [
  'pull',
  'push',
  'receipts',
  'schedule',
  'foreclosure_quote',
  'statement',
  'closure_documents',
] as const;
export const LS_IMPORT_FORMAT = 'udofin-lms-import-v1';
export const LS_IMPORT_KINDS = ['loan', 'receipt', 'schedule'] as const;
export const LS_IMPORT_SOURCE_KINDS = ['file', 'manual'] as const;
export const LS_IMPORT_FILE_FORMATS = ['csv', 'json'] as const;
/** The most characters of file text one request may carry (the importer itself refuses a file over 5 MiB). */
export const LS_IMPORT_MAX_CHARS = 8_000_000;
export const LS_IMPORT_MAX_ROWS = 10_000;
export const LS_BATCH_STATUSES = [
  'uploaded',
  'previewed',
  'invalid',
  'committed',
  'rejected',
  'failed',
] as const;
export const LS_ROW_ERROR_OUTCOMES = ['error', 'quarantined'] as const;
export const LS_ANOMALY_KINDS = [
  'status_regression',
  'terminal_status_changed',
  'outstanding_rise_without_charge',
  'overdue_total_mismatch',
  'sanctioned_amount_changed',
  'disbursement_evidence_differs',
  'reversal_exceeds_receipt',
  'older_report_ignored',
  'older_sequence_ignored',
] as const;
export const LS_ANOMALY_SEVERITIES = ['info', 'warning'] as const;
export const LS_CONFLICT_RECORD_TYPES = ['loan', 'receipt', 'schedule'] as const;
export const LS_CONFLICT_REASONS = [
  'same_record_different_content',
  'same_time_different_content',
  'sequence_reused',
  'receipt_differs',
] as const;
export const LS_CONFLICT_STATUSES = ['open', 'acknowledged', 'resolved'] as const;
export const LS_CONFLICT_VERSIONS = ['existing', 'incoming'] as const;
export const LS_DOCUMENT_KINDS = [
  'statement',
  'foreclosure_quote',
  'noc',
  'closure_letter',
] as const;
export const LS_DOCUMENT_SOURCES = ['lender_upload', 'lms', 'mock'] as const;
export const LS_REQUEST_STATUSES = [
  'requested',
  'fulfilled',
  'declined',
  'expired',
  'cancelled',
] as const;
export const LS_QUOTE_SOURCES = ['lender_portal', 'lms', 'mock'] as const;
export const LS_CLOSURE_KINDS = ['closed', 'foreclosed'] as const;
export const LS_COLLATERAL_TYPES = [
  'mutual_fund_lien',
  'demat_pledge',
  'property_documents',
  'vehicle_hypothecation',
  'other',
] as const;
export const LS_RELEASE_STATUSES = ['open', 'confirmed_by_lender'] as const;
/** The largest document the API accepts, in bytes (the database allows more; the API is stricter). */
export const LS_DOCUMENT_MAX_BYTES = 8 * 1024 * 1024;

/** Which lender a list is about. Row level security still decides what the caller may see. */
export const LsLenderFilterQuery = z.strictObject({ lenderId: Id.optional() });

// ---------------------------------------------------------------------------------------------------------------
// Loans as the lender reported them
// ---------------------------------------------------------------------------------------------------------------
export const LsLoanListQuery = z.strictObject({
  lenderId: Id.optional(),
  status: z.enum(LS_LOAN_STATUSES).optional(),
  limit: Limit,
  cursor: CursorText.optional(),
});

/** Where the loan stands in the sync, straight from the view `servicing.loan_sync_status`. */
export const LsLoanSync = z.strictObject({
  newestReportedAsOf: Timestamp.nullable(),
  newestReceivedAt: Timestamp.nullable(),
  newestReportedStatus: z.enum(LS_LOAN_STATUSES).nullable(),
  /** No report yet, or the newest report is older than the lender's staleness threshold. */
  stale: z.boolean(),
  stalenessThresholdMinutes: z.number().int().min(5).max(43200),
  hasOpenConflict: z.boolean(),
  newestHasWarning: z.boolean(),
});

/** No borrower identity and no application reference: the loan account is the link. */
export const LsLoanRow = z.strictObject({
  id: Id,
  lenderId: Id,
  lmsLoanRef: z.string(),
  status: z.enum(LS_LOAN_STATUSES),
  sanctionedAmountMinor: Paise,
  disbursedAmountMinor: Paise.nullable(),
  disbursedAt: Timestamp.nullable(),
  lastSyncedAt: Timestamp,
  createdAt: Timestamp,
  sync: LsLoanSync,
});
export type LsLoanRow = z.infer<typeof LsLoanRow>;
export const LsLoanPage = Page(LsLoanRow);

/** What the lender reported at one time, stored exactly as received. A null figure was not reported. */
export const LsBalanceReport = z.strictObject({
  id: Id,
  version: z.number().int().min(1),
  status: z.enum(LS_LOAN_STATUSES),
  reportedAsOf: Timestamp,
  receivedAt: Timestamp,
  outstandingPrincipalMinor: Paise.nullable(),
  overduePrincipalMinor: Paise.nullable(),
  overdueInterestMinor: Paise.nullable(),
  penalChargesMinor: Paise.nullable(),
  otherChargesMinor: Paise.nullable(),
  totalOverdueMinor: Paise.nullable(),
  nextDueOn: DateOnly.nullable(),
  nextDueMinor: Paise.nullable(),
  /** As the lender reported it. Udofin never computes it. */
  daysPastDue: z.number().int().min(0).nullable(),
  /** `overdue_total_mismatch`: the lender's parts do not add up to the lender's total (flagged, never corrected). */
  flags: z.array(Code),
  sourceSystem: Code,
});

export const LsScheduleInstallment = z.strictObject({
  seq: z.number().int().min(1),
  dueDate: DateOnly,
  principalMinor: Paise,
  interestMinor: Paise,
  feesMinor: Paise,
  totalMinor: Paise,
});

export const LsSchedule = z.strictObject({
  id: Id,
  version: z.number().int().min(1),
  reportedAsOf: Timestamp.nullable(),
  receivedAt: Timestamp,
  installments: z.array(LsScheduleInstallment),
});

export const LsReceipt = z.strictObject({
  id: Id,
  kind: z.enum(['receipt', 'reversal']),
  lmsReceiptRef: z.string(),
  reversesReceiptRef: z.string().nullable(),
  amountMinor: Paise,
  valueDate: DateOnly,
  paymentMode: z.string().nullable(),
  bankReference: z.string().nullable(),
  reportedAsOf: Timestamp,
  receivedAt: Timestamp,
});

/** The loan, the newest report, the newest schedule, the newest receipts and how many flags and conflicts wait. */
export const LsLoanDetail = z.strictObject({
  loan: LsLoanRow,
  report: LsBalanceReport.nullable(),
  schedule: LsSchedule.nullable(),
  receipts: z.array(LsReceipt),
  openConflicts: Count,
  anomalies: z.strictObject({ warning: Count, info: Count }),
});
export type LsLoanDetail = z.infer<typeof LsLoanDetail>;

export const LsAnomalyListQuery = z.strictObject({
  lenderId: Id.optional(),
  loanAccountId: Id.optional(),
  severity: z.enum(LS_ANOMALY_SEVERITIES).optional(),
  limit: Limit,
  cursor: CursorText.optional(),
});
/** A flag the sync raised next to what the lender reported. Both figures are the lender's; nothing was corrected. */
export const LsAnomaly = z.strictObject({
  id: Id,
  lenderId: Id,
  loanAccountId: Id,
  kind: z.enum(LS_ANOMALY_KINDS),
  severity: z.enum(LS_ANOMALY_SEVERITIES),
  previousStatus: z.enum(LS_LOAN_STATUSES).nullable(),
  reportedStatus: z.enum(LS_LOAN_STATUSES).nullable(),
  previousAmountMinor: Paise.nullable(),
  reportedAmountMinor: Paise.nullable(),
  sourceSystem: Code,
  reportedAsOf: Timestamp,
  detectedAt: Timestamp,
});
export const LsAnomalyPage = Page(LsAnomaly);

// ---------------------------------------------------------------------------------------------------------------
// The LMS connection and the sync status
// ---------------------------------------------------------------------------------------------------------------
export const LsCapabilities = z.strictObject({
  pull: z.boolean().optional(),
  push: z.boolean().optional(),
  receipts: z.boolean().optional(),
  schedule: z.boolean().optional(),
  foreclosure_quote: z.boolean().optional(),
  statement: z.boolean().optional(),
  closure_documents: z.boolean().optional(),
});
export type LsCapabilities = z.infer<typeof LsCapabilities>;

/** The connection as recorded. The name of a secret, if one is ever recorded, is never returned. */
export const LsConnection = z.strictObject({
  id: Id,
  lenderId: Id,
  kind: z.enum(LS_CONNECTION_KINDS),
  status: z.enum(LS_CONNECTION_STATUSES),
  providerMode: z.string(),
  capabilities: LsCapabilities,
  stalenessThresholdMinutes: z.number().int().min(5).max(43200),
  lastSuccessAt: Timestamp.nullable(),
  updatedAt: Timestamp,
});

export const LsConnectionInput = z.strictObject({
  lenderId: Id,
  kind: z.enum(LS_CONNECTION_KINDS),
  status: z.enum(LS_CONNECTION_STATUSES),
  capabilities: LsCapabilities.default({}),
  stalenessThresholdMinutes: z.number().int().min(5).max(43200).default(1440),
});
export const LsConnectionResult = z.strictObject({ id: Id });

/** Counts over `servicing.loan_sync_status` for one lender (a display count, not a rule). */
export const LsSyncStatusItem = z.strictObject({
  lenderId: Id,
  connection: LsConnection.nullable(),
  loans: z.strictObject({
    total: Count,
    neverReported: Count,
    stale: Count,
    withOpenConflict: Count,
    withWarning: Count,
  }),
  newestReportedAsOf: Timestamp.nullable(),
});
export const LsSyncStatus = z.strictObject({ items: z.array(LsSyncStatusItem) });

// ---------------------------------------------------------------------------------------------------------------
// File import (format udofin-lms-import-v1). All or nothing: any error means nothing is applied.
// ---------------------------------------------------------------------------------------------------------------
/**
 * One file, as text (`content` with its `fileFormat`) or as JSON records (`rows`). The API hashes the exact bytes,
 * parses and validates the whole file, and the database validates it again. The format is documented in
 * packages/adapters/src/lms.ts. Money is a decimal rupee STRING in the file ("1250.50"); a JSON number is refused.
 */
export const LsImportInput = z
  .strictObject({
    lenderId: Id,
    kind: z.enum(LS_IMPORT_KINDS),
    sourceKind: z.enum(LS_IMPORT_SOURCE_KINDS),
    formatVersion: z.literal(LS_IMPORT_FORMAT),
    fileFormat: z.enum(LS_IMPORT_FILE_FORMATS).optional(),
    content: z.string().min(1).max(LS_IMPORT_MAX_CHARS).optional(),
    rows: z
      .array(z.record(z.string().max(60), z.unknown()))
      .min(1)
      .max(LS_IMPORT_MAX_ROWS)
      .optional(),
    /** The earlier invalid, rejected or failed batch this file corrects (linkage only). */
    resubmissionOf: Id.optional(),
  })
  .refine((input) => (input.content === undefined) !== (input.rows === undefined), {
    message: 'send exactly one of content and rows',
    path: ['content'],
  })
  .refine((input) => input.content === undefined || input.fileFormat !== undefined, {
    message: 'content needs its fileFormat',
    path: ['fileFormat'],
  })
  .refine((input) => input.rows === undefined || input.fileFormat !== 'csv', {
    message: 'rows are JSON records, not csv',
    path: ['fileFormat'],
  });
export type LsImportInput = z.infer<typeof LsImportInput>;

export const LsImportRejectInput = z.strictObject({ reason: z.string().min(10).max(1000) });

export const LsImportListQuery = z.strictObject({
  lenderId: Id.optional(),
  kind: z.enum(LS_IMPORT_KINDS).optional(),
  status: z.enum(LS_BATCH_STATUSES).optional(),
  limit: Limit,
  cursor: CursorText.optional(),
});

export const LsImportCounts = z.strictObject({
  new: Count,
  unchanged: Count,
  duplicate: Count,
  changed: Count,
  conflict: Count,
  error: Count,
  quarantined: Count,
  ignoredOlder: Count,
});

/** One batch = one file of one kind for one lender. Rows and values are not part of it. */
export const LsImportBatch = z.strictObject({
  id: Id,
  lenderId: Id,
  kind: z.enum(LS_IMPORT_KINDS),
  sourceKind: z.enum(LS_IMPORT_SOURCE_KINDS),
  status: z.enum(LS_BATCH_STATUSES),
  formatVersion: z.literal(LS_IMPORT_FORMAT),
  rowCount: z.number().int().min(1),
  counts: LsImportCounts,
  resubmissionOf: Id.nullable(),
  fileSha256: Sha256,
  byteSize: z.number().int().min(1),
  uploadedAt: Timestamp,
  committedAt: Timestamp.nullable(),
  rejectedAt: Timestamp.nullable(),
  failedAt: Timestamp.nullable(),
  /** The SQLSTATE of the error that made a commit roll back (a class, never a message). */
  failureClass: z
    .string()
    .regex(/^[0-9A-Z]{5}$/)
    .nullable(),
  /** What a committed batch applied, by outcome. */
  appliedCounts: z.record(Code, Count).nullable(),
});
export type LsImportBatch = z.infer<typeof LsImportBatch>;
export const LsImportBatchPage = Page(LsImportBatch);

/** A row-level problem: the position, the classes and the NAMES of the fields at fault. Never a value. */
export const LsImportRowError = z.strictObject({
  rowNo: z.number().int().min(0),
  outcome: z.enum(LS_ROW_ERROR_OUTCOMES),
  errorCodes: z.array(Code),
  fieldNames: z.array(Code),
});
export type LsImportRowError = z.infer<typeof LsImportRowError>;

export const LsImportDetail = z.strictObject({
  batch: LsImportBatch,
  errors: z.array(LsImportRowError),
  errorsTruncated: z.boolean(),
});

/** A file the importer refused before any record reached the database: audited without row values, no batch exists. */
export const LsRefusedFile = z.strictObject({
  fileSha256: Sha256,
  byteSize: Count,
  recordCount: Count,
});

/**
 * The answer to staging, committing or rejecting. `batch` is null only for a refused file (see `refusedFile`).
 * A commit that failed is RETURNED with `batch.status = failed` and its `failureClass`: nothing was applied.
 */
export const LsImportOutcome = z.strictObject({
  existing: z.boolean(),
  batch: LsImportBatch.nullable(),
  refusedFile: LsRefusedFile.nullable(),
  errors: z.array(LsImportRowError),
  errorsTruncated: z.boolean(),
});
export type LsImportOutcome = z.infer<typeof LsImportOutcome>;

// ---------------------------------------------------------------------------------------------------------------
// Conflicts (the same record reported twice with different content): open, acknowledged, resolved
// ---------------------------------------------------------------------------------------------------------------
export const LsConflictListQuery = z.strictObject({
  lenderId: Id.optional(),
  loanAccountId: Id.optional(),
  status: z.enum(LS_CONFLICT_STATUSES).optional(),
  limit: Limit,
  cursor: CursorText.optional(),
});
/** Neither version is changed by handling a conflict; the refused version's content is not returned. */
export const LsConflict = z.strictObject({
  id: Id,
  lenderId: Id,
  loanAccountId: Id,
  recordType: z.enum(LS_CONFLICT_RECORD_TYPES),
  conflictReason: z.enum(LS_CONFLICT_REASONS),
  sourceRecordId: z.string(),
  existingReportedAsOf: Timestamp,
  incomingReportedAsOf: Timestamp,
  sourceSystem: Code,
  receivedAt: Timestamp,
  status: z.enum(LS_CONFLICT_STATUSES),
  acknowledgedAt: Timestamp.nullable(),
  resolvedAt: Timestamp.nullable(),
  confirmedVersion: z.enum(LS_CONFLICT_VERSIONS).nullable(),
  resolutionNote: z.string().nullable(),
});
export const LsConflictPage = Page(LsConflict);

/** A flat object of short references to what was reviewed (keys a-z0-9_, values 1 to 200 characters, at most 20). */
export const LsEvidence = z
  .record(z.string().regex(/^[a-z][a-z0-9_]{1,40}$/), z.string().min(1).max(200))
  .refine((value) => Object.keys(value).length >= 1 && Object.keys(value).length <= 20, {
    message: 'give 1 to 20 references',
  });
export const LsConflictResolveInput = z.strictObject({
  confirmedVersion: z.enum(LS_CONFLICT_VERSIONS),
  note: z.string().min(10).max(1000),
  evidence: LsEvidence,
});
export const LsConflictActionResult = z.strictObject({
  id: Id,
  status: z.enum(['acknowledged', 'resolved']),
});

// ---------------------------------------------------------------------------------------------------------------
// Lender-issued documents (statement of account, foreclosure quotation letter, no-dues / NOC, closure letter)
// ---------------------------------------------------------------------------------------------------------------
/**
 * The lender's own signed PDF. Udofin generates, renders and issues none: the bytes go to the private store under an
 * opaque key and the database keeps the key, the SHA-256 and the size. Only application/pdf is accepted.
 */
export const LsDocumentUploadInput = z.strictObject({
  kind: z.enum(LS_DOCUMENT_KINDS),
  mimeType: z.literal('application/pdf'),
  contentBase64: z.string().min(4).max(12_000_000),
  /** The lender's own number for this document (letters, digits and . _ / - only; the database checks it again). */
  lenderReference: z.string().min(1).max(100),
  issuedAt: Timestamp,
  periodFrom: DateOnly.optional(),
  periodTo: DateOnly.optional(),
  supersedesDocumentId: Id.optional(),
  requestId: Id.optional(),
});
export const LsDocumentUploadResult = z.strictObject({ documentId: Id, existing: z.boolean() });

export const LsDocument = z.strictObject({
  documentId: Id,
  kind: z.enum(LS_DOCUMENT_KINDS),
  issuer: z.literal('lender'),
  lenderReference: z.string(),
  issuedAt: Timestamp,
  periodFrom: DateOnly.nullable(),
  periodTo: DateOnly.nullable(),
  sizeBytes: z.number().int().min(1),
  sha256: Sha256,
  source: z.enum(LS_DOCUMENT_SOURCES),
  supersededById: Id.nullable(),
});
export const LsDocumentList = z.strictObject({ items: z.array(LsDocument) });

export const LsDocumentOpenQuery = z.strictObject({
  purpose: z.enum(['view', 'download']).default('view'),
});
/** The exact stored file. The API compared its SHA-256 with the recorded one before returning it. */
export const LsDocumentContent = z.strictObject({
  documentId: Id,
  kind: z.enum(LS_DOCUMENT_KINDS),
  mimeType: z.literal('application/pdf'),
  sha256: Sha256,
  sizeBytes: z.number().int().min(1),
  lenderReference: z.string(),
  contentBase64: z.string(),
});

export const LsDocumentRequestListQuery = z.strictObject({
  lenderId: Id.optional(),
  loanAccountId: Id.optional(),
  kind: z.enum(LS_DOCUMENT_KINDS).optional(),
  status: z.enum(LS_REQUEST_STATUSES).optional(),
  limit: Limit,
  cursor: CursorText.optional(),
});
/** A borrower's request for a lender-issued document. The borrower is not named; the loan account is the link. */
export const LsDocumentRequest = z.strictObject({
  id: Id,
  lenderId: Id,
  loanAccountId: Id,
  kind: z.enum(LS_DOCUMENT_KINDS),
  periodFrom: DateOnly.nullable(),
  periodTo: DateOnly.nullable(),
  status: z.enum(LS_REQUEST_STATUSES),
  requestedAt: Timestamp,
  /** A PLATFORM default from an approved rule, not a regulatory deadline; empty when no approved rule resolves. */
  dueBy: Timestamp.nullable(),
  lenderNote: z.string().nullable(),
  decidedAt: Timestamp.nullable(),
  fulfilledDocumentId: Id.nullable(),
  fulfilledQuoteId: Id.nullable(),
});
export const LsDocumentRequestPage = Page(LsDocumentRequest);
export const LsDocumentRequestDeclineInput = z.strictObject({ note: z.string().min(10).max(500) });
export const LsDocumentRequestDeclineResult = z.strictObject({
  id: Id,
  status: z.literal('declined'),
});

// ---------------------------------------------------------------------------------------------------------------
// Foreclosure quotations, exactly as the lender issued them
// ---------------------------------------------------------------------------------------------------------------
/**
 * Money is integer paise (the API writes it to the database as the rupee text the function parses). The parts are the
 * lender's, the total is the lender's: when they do not add up the quotation is stored FLAGGED (`totalMismatch`),
 * never corrected, and must not be paid until the lender re-quotes.
 */
export const LsQuoteInput = z.strictObject({
  lenderQuoteRef: z.string().min(1).max(100),
  asOf: Timestamp,
  validUntil: Timestamp,
  principalMinor: Paise,
  interestMinor: Paise,
  chargesMinor: Paise,
  prepaymentChargeMinor: Paise,
  totalMinor: Paise,
  /** The borrower's open foreclosure_quote request this quotation answers. */
  requestId: Id.optional(),
  /** A foreclosure_quote document of the same loan registered earlier. */
  letterDocumentId: Id.optional(),
});
export const LsQuote = z.strictObject({
  id: Id,
  lenderId: Id,
  loanAccountId: Id,
  lenderQuoteRef: z.string(),
  asOf: Timestamp,
  validUntil: Timestamp,
  principalMinor: Paise,
  interestMinor: Paise,
  chargesMinor: Paise,
  prepaymentChargeMinor: Paise,
  totalMinor: Paise,
  totalMismatch: z.boolean(),
  source: z.enum(LS_QUOTE_SOURCES),
  letterDocumentId: Id.nullable(),
  reportedAt: Timestamp,
});
export type LsQuote = z.infer<typeof LsQuote>;
export const LsQuoteResult = z.strictObject({ quote: LsQuote, existing: z.boolean() });
export const LsQuoteListQuery = z.strictObject({ limit: Limit, cursor: CursorText.optional() });
export const LsQuotePage = Page(LsQuote);

// ---------------------------------------------------------------------------------------------------------------
// Closure and security release: the lender releases and confirms; Udofin never does
// ---------------------------------------------------------------------------------------------------------------
export const LsClosureListQuery = z.strictObject({
  lenderId: Id.optional(),
  limit: Limit,
  cursor: CursorText.optional(),
});
export const LsSecurityReleaseTask = z.strictObject({
  id: Id,
  collateralType: z.enum(LS_COLLATERAL_TYPES),
  status: z.enum(LS_RELEASE_STATUSES),
  /** From an approved rule; empty when none resolves. */
  dueBy: Timestamp.nullable(),
  delayReason: z.string().nullable(),
  delayReasonAt: Timestamp.nullable(),
  lenderConfirmationRef: z.string().nullable(),
  confirmedAt: Timestamp.nullable(),
  createdAt: Timestamp,
});
export const LsClosure = z.strictObject({
  id: Id,
  lenderId: Id,
  loanAccountId: Id,
  closureKind: z.enum(LS_CLOSURE_KINDS),
  /** When Udofin recorded the lender's report of the closure (not the lender's closure date). */
  closedAt: Timestamp,
  /** A PLATFORM default from an approved rule, not a regulatory deadline; empty when no approved rule resolves. */
  nocDueBy: Timestamp.nullable(),
  nocDocumentId: Id.nullable(),
  nocIssuedAt: Timestamp.nullable(),
  tasks: z.array(LsSecurityReleaseTask),
});
export const LsClosurePage = Page(LsClosure);

export const LsSecurityReleaseOpenInput = z.strictObject({
  collateralTypes: z.array(z.enum(LS_COLLATERAL_TYPES)).min(1).max(5),
});
export const LsSecurityReleaseOpenResult = z.strictObject({ created: Count });
export const LsSecurityReleaseConfirmInput = z.strictObject({
  confirmationRef: z.string().min(3).max(100),
});
export const LsSecurityReleaseDelayInput = z.strictObject({
  reason: z.string().min(10).max(500),
});
export const LsSecurityReleaseActionResult = z.strictObject({
  id: Id,
  outcome: z.enum(['confirmed_by_lender', 'recorded']),
});
