import { createHash, randomUUID } from 'node:crypto';
import {
  assertValidDocumentKey,
  formatMoneyMinor,
  LMS_IMPORT_FORMAT,
  LMS_LOAN_FIELDS,
  LMS_RECEIPT_FIELDS,
  LMS_SCHEDULE_HEAD_FIELDS,
  LMS_SCHEDULE_INSTALLMENT_FIELDS,
  parseLmsImportFile,
  sha256Hex,
  type DocumentStore,
  type LmsImportError,
  type LmsImportReportMap,
} from '@udofin/adapters';
import {
  LS_DOCUMENT_MAX_BYTES,
  LsAnomalyListQuery,
  LsAnomalyPage,
  LsClosureListQuery,
  LsClosurePage,
  LsConflictActionResult,
  LsConflictListQuery,
  LsConflictPage,
  LsConflictResolveInput,
  LsConnectionInput,
  LsConnectionResult,
  LsDocumentContent,
  LsDocumentList,
  LsDocumentOpenQuery,
  LsDocumentRequestDeclineInput,
  LsDocumentRequestDeclineResult,
  LsDocumentRequestListQuery,
  LsDocumentRequestPage,
  LsDocumentUploadInput,
  LsDocumentUploadResult,
  LsImportBatchPage,
  LsImportDetail,
  LsImportInput,
  LsImportListQuery,
  LsImportOutcome,
  LsImportRejectInput,
  LsLenderFilterQuery,
  LsLoanDetail,
  LsLoanListQuery,
  LsLoanPage,
  LsQuoteInput,
  LsQuoteListQuery,
  LsQuotePage,
  LsQuoteResult,
  LsSecurityReleaseActionResult,
  LsSecurityReleaseConfirmInput,
  LsSecurityReleaseDelayInput,
  LsSecurityReleaseOpenInput,
  LsSecurityReleaseOpenResult,
  LsSyncStatus,
} from '@udofin/contracts';
import { z } from 'zod';
import { columns } from '../../db/columns.js';
import { type UserTx } from '../../db/user-context.js';
import { ApiError } from '../../http/api-error.js';
import { decodeCursor, encodeCursor } from '../../http/pagination.js';
import { userRoute, type RouteDefinition } from '../../http/routes.js';
import { assertUploadAllowed } from '../../http/upload-safety.js';

/**
 * Phase 08a, lender side: loans as the lender reported them, the sync status and the LMS connection, the all-or-nothing file
 * import, conflicts and anomalies, lender-issued documents, foreclosure quotations and closure / security release.
 *
 * Every rule lives in the database. Reads go through row level security (a lender sees its own rows; a platform grantee of
 * loan.read sees every lender's); writes call the SQL functions, which check the permission, the second factor, the
 * `servicing_sync` / `statements_noc` switch and the closed vocabularies. These routes validate the shape of a request, take
 * the caller from the token, pass identifiers and map the result. Nothing here computes an amount, derives a stage or decides
 * an eligibility. The one piece of logic that is not a pass-through is the file import front end: it hashes the exact bytes,
 * uses the adapters' own parser for fast, value-free feedback and maps the normalised reports back to import records; the
 * database validates every record again and never trusts this step.
 *
 * Responses are mapped field by field from the columns this module chooses to read: no row is ever spread, and the contract
 * schemas are strict, so an undeclared field cannot leave the API.
 */

const WRITE_LIMIT = { max: 30, timeWindow: '1 minute' };
const READ_LIMIT = { max: 120, timeWindow: '1 minute' };
const IMPORT_LIMIT = { max: 10, timeWindow: '1 minute' };
const UPLOAD_LIMIT = { max: 20, timeWindow: '1 minute' };
const OPEN_LIMIT = { max: 60, timeWindow: '1 minute' };
const Id = z.strictObject({ id: z.uuid() });
const TaskId = z.strictObject({ taskId: z.uuid() });
const LoanDocumentParams = z.strictObject({ id: z.uuid(), docId: z.uuid() });

/** A batch of 10,000 records takes about 10 s to stage; the API login's default of 30 s is too short for the largest files. */
const BULK_STATEMENT_TIMEOUT = "set local statement_timeout = '120s'";
/** Larger than the 5 MiB the importer accepts, so a file over the limit still reaches the importer and is audited. */
const IMPORT_BODY_LIMIT = 12_000_000;
const DOCUMENT_BODY_LIMIT = 12_000_000;
const MAX_ERROR_ROWS = 1000;

/** ISO text of a timestamp column (microsecond precision, with offset), null stays null. */
const ts = (column: string) => `(to_jsonb(${column}) #>> '{}')`;
const day = (column: string) => `to_char(${column}, 'YYYY-MM-DD')`;

/** Money comes out of the database as text (bigint); a checked parse keeps it an exact integer or fails loudly. */
function paise(value: string): number {
  if (!/^\d{1,15}$/.test(value))
    throw new Error('the database returned an amount outside the paise range');
  return Number(value);
}
const paiseOrNull = (value: string | null): number | null => (value === null ? null : paise(value));
const count = (value: string | number): number => {
  const text = String(value);
  if (!/^\d{1,15}$/.test(text)) throw new Error('the database returned a count outside the range');
  return Number(text);
};

const first = <T>(rows: { r: T }[]): T => {
  const row = rows[0];
  if (!row) throw new Error('database function returned nothing');
  return row.r;
};

/** A parameterised WHERE clause. Values are never interpolated into the SQL text. */
class Where {
  private readonly parts: string[] = [];
  readonly values: unknown[] = [];

  placeholder(value: unknown): string {
    this.values.push(value);
    return `$${String(this.values.length)}`;
  }
  add(condition: (placeholder: string) => string, value: unknown): void {
    this.parts.push(condition(this.placeholder(value)));
  }
  raw(condition: string): void {
    this.parts.push(condition);
  }
  get sql(): string {
    return this.parts.length > 0 ? this.parts.join(' and ') : 'true';
  }
}

/** Adds the keyset condition "older than the cursor" over (timestamp, id), both descending. */
function olderThan(where: Where, cursor: string | undefined, timestamp: string, id: string): void {
  const c = decodeCursor(cursor);
  if (!c) return;
  const t = where.placeholder(c.t);
  const i = where.placeholder(c.id);
  where.raw(`(${timestamp}, ${id}) < (${t}::timestamptz, ${i}::uuid)`);
}

function pageOf<R, T>(
  rows: R[],
  limit: number,
  map: (row: R) => T,
  cursorOf: (row: R) => string,
): { items: T[]; nextCursor: string | null } {
  const kept = rows.slice(0, limit);
  const last = kept.at(-1);
  return {
    items: kept.map(map),
    nextCursor: rows.length > limit && last ? cursorOf(last) : null,
  };
}

/**
 * Row level security hides other lenders' rows; this makes "you may not read this at all" an explicit 403 instead of a
 * silent empty list, and a lender filter the caller does not hold a 403 too.
 */
async function requireReader(tx: UserTx, lenderId: string | undefined): Promise<void> {
  const r = await tx.query<{ ok: boolean }>(
    `select exists (select 1 from private.orgs_with_permission('loan.read') as o(id)
                     where $1::uuid is null or o.id = $1::uuid) as ok`,
    [lenderId ?? null],
  );
  if (!r.rows[0]?.ok) throw new ApiError(403, 'forbidden', 'Forbidden');
}

const notFound = () => new ApiError(404, 'not_found', 'Not Found');

// ---------------------------------------------------------------------------------------------------------------
// File import front end (pure, exported for the unit tests)
// ---------------------------------------------------------------------------------------------------------------
type ImportReport = LmsImportReportMap[keyof LmsImportReportMap];

/** Drops absent (null) values: "empty strings and nulls mean absent" in the format, and absent is simply not sent. */
function present(entries: Record<string, string | number | null | undefined | readonly unknown[]>) {
  return Object.fromEntries(
    Object.entries(entries).filter(([, value]) => value !== null && value !== undefined),
  );
}
const money = (value: bigint | null): string | null =>
  value === null ? null : formatMoneyMinor(value);

/**
 * Maps a NORMALISED report back to the snake_case import record `servicing.stage_import` takes (money as decimal rupee text,
 * timestamps in UTC). The database validates the record again and computes the same content hash as the importer. Only
 * fields the format defines are written, so nothing a file contained beyond the format can reach the database.
 */
export function toImportRecord(report: ImportReport): Record<string, unknown> {
  switch (report.reportType) {
    case 'loan':
      return present({
        lms_loan_ref: report.lmsLoanRef,
        borrower_ref: report.borrowerRef,
        status: report.status,
        sanctioned_amount: money(report.sanctionedMinor),
        disbursed_amount: money(report.disbursedMinor),
        disbursement_ref: report.disbursementRef,
        disbursement_date: report.disbursedOn,
        outstanding_principal: money(report.outstandingPrincipalMinor),
        next_due_date: report.nextDueOn,
        next_due_amount: money(report.nextDueMinor),
        overdue_principal: money(report.overduePrincipalMinor),
        overdue_interest: money(report.overdueInterestMinor),
        penal_charges: money(report.penalChargesMinor),
        other_charges: money(report.otherChargesMinor),
        total_overdue: money(report.totalOverdueMinor),
        days_past_due: report.daysPastDue,
        source_record_id: report.sourceRecordId,
        reported_as_of: report.reportedAt,
        sequence: report.sequence,
      });
    case 'receipt':
      return present({
        lms_loan_ref: report.lmsLoanRef,
        lms_receipt_ref: report.lmsReceiptRef,
        receipt_kind: report.receiptKind,
        reverses_receipt_ref: report.reversesReceiptRef,
        amount: money(report.amountMinor),
        value_date: report.valueDate,
        payment_mode: report.paymentMode,
        bank_reference: report.bankReference,
        source_record_id: report.sourceRecordId,
        reported_as_of: report.reportedAt,
        sequence: report.sequence,
      });
    case 'schedule':
      return present({
        lms_loan_ref: report.lmsLoanRef,
        source_record_id: report.sourceRecordId,
        reported_as_of: report.reportedAt,
        sequence: report.sequence,
        installments: report.installments.map((item) => ({
          installment_seq: item.sequence,
          due_date: item.dueOn,
          principal: formatMoneyMinor(item.principalMinor),
          interest: formatMoneyMinor(item.interestMinor),
          fees: formatMoneyMinor(item.feesMinor),
        })),
      });
  }
}

/**
 * What stands in the importer's text for a number that is not finite (JSON written as 1e999 is read as Infinity). It is not a
 * valid reference, amount, integer, date, timestamp or status, so the importer refuses the record with the class of the
 * field, exactly as it does for the same record sent as text. A plain JSON.stringify would write such a number as null,
 * which the importer reads as an absent optional field: the lender's figure would be dropped silently.
 */
export const NON_FINITE_NUMBER_TEXT = 'non-finite number';

/** The text the importer reads for JSON records (`rows`): the records as sent, with no value changed or lost. */
export function importTextOfRows(rows: unknown): string {
  return JSON.stringify(rows, (_key, value: unknown) =>
    typeof value === 'number' && !Number.isFinite(value) ? NON_FINITE_NUMBER_TEXT : value,
  );
}

/** The field names a refusal may carry: the format's own, never text from the file. */
const KNOWN_FIELDS: ReadonlySet<string> = new Set<string>([
  ...LMS_LOAN_FIELDS,
  ...LMS_RECEIPT_FIELDS,
  ...LMS_SCHEDULE_HEAD_FIELDS,
  ...LMS_SCHEDULE_INSTALLMENT_FIELDS,
  'installments',
]);
/** The error classes the database accepts in an audit record of a refused file (`quote validity` is not a file error). */
const AUDIT_CODES: ReadonlySet<string> = new Set([
  'file_too_large',
  'too_many_rows',
  'empty_file',
  'malformed_file',
  'unknown_column',
  'missing_column',
  'duplicate_column',
  'column_count_mismatch',
  'unknown_field',
  'missing_required',
  'invalid_reference',
  'borrower_ref_looks_personal',
  'invalid_amount',
  'amount_not_positive',
  'invalid_date',
  'invalid_timestamp',
  'timestamp_in_future',
  'invalid_integer',
  'invalid_status',
  'invalid_receipt_kind',
  'incomplete_disbursement',
  'incomplete_next_due',
  'disbursed_exceeds_sanctioned',
  'reversal_reference_invalid',
  'invalid_items',
  'inconsistent_report_head',
  'duplicate_row',
  'conflicting_duplicate',
]);

/** One error of the importer as the audit record of a refused file wants it: position, class, field name or null. */
export function auditErrors(
  errors: readonly LmsImportError[],
): { row_no: number; code: string; field: string | null }[] {
  return errors.slice(0, MAX_ERROR_ROWS).map((error) => ({
    row_no: Number.isSafeInteger(error.rowNumber) && error.rowNumber >= 0 ? error.rowNumber : 0,
    code: AUDIT_CODES.has(error.code) ? error.code : 'malformed_file',
    field: error.field !== null && KNOWN_FIELDS.has(error.field) ? error.field : null,
  }));
}

/** The same errors grouped per row, in the shape of the database's row-level problems. */
export function groupRowErrors(errors: readonly LmsImportError[]): {
  rows: { rowNo: number; outcome: 'error'; errorCodes: string[]; fieldNames: string[] }[];
  truncated: boolean;
} {
  const byRow = new Map<number, { codes: Set<string>; fields: Set<string> }>();
  for (const error of auditErrors(errors)) {
    const entry = byRow.get(error.row_no) ?? {
      codes: new Set<string>(),
      fields: new Set<string>(),
    };
    entry.codes.add(error.code);
    if (error.field !== null) entry.fields.add(error.field);
    byRow.set(error.row_no, entry);
  }
  const rows = [...byRow.entries()]
    .sort(([a], [b]) => a - b)
    .map(([rowNo, entry]) => ({
      rowNo,
      outcome: 'error' as const,
      errorCodes: [...entry.codes].sort(),
      fieldNames: [...entry.fields].sort(),
    }));
  return { rows, truncated: errors.length > MAX_ERROR_ROWS };
}

// ---------------------------------------------------------------------------------------------------------------
// Column lists and mappers (explicit: a column that is not listed here cannot reach a response)
// ---------------------------------------------------------------------------------------------------------------
interface LoanRow {
  id: string;
  lenderId: string;
  lmsLoanRef: string;
  status: string;
  sanctionedAmountMinor: string;
  disbursedAmountMinor: string | null;
  disbursedAt: string | null;
  lastSyncedAt: string;
  createdAt: string;
  newestReportedAsOf: string | null;
  newestReceivedAt: string | null;
  newestReportedStatus: string | null;
  stale: boolean;
  stalenessThresholdMinutes: number;
  hasOpenConflict: boolean;
  newestHasWarning: boolean;
}
const LOAN_COLUMNS = columns({
  id: 'la.id',
  lenderId: 'la.lender_org_id',
  lmsLoanRef: 'la.lms_loan_ref',
  status: 'la.status::text',
  sanctionedAmountMinor: 'la.sanctioned_amount_minor::text',
  disbursedAmountMinor: 'la.disbursed_amount_minor::text',
  disbursedAt: ts('la.disbursed_at'),
  lastSyncedAt: ts('la.last_synced_at'),
  createdAt: ts('la.created_at'),
  newestReportedAsOf: ts('s.newest_reported_as_of'),
  newestReceivedAt: ts('s.newest_received_at'),
  newestReportedStatus: 's.newest_reported_status::text',
  stale: 'coalesce(s.stale, true)',
  stalenessThresholdMinutes: 'coalesce(s.staleness_threshold_minutes, 1440)',
  hasOpenConflict: 'coalesce(s.has_open_conflict, false)',
  newestHasWarning: 'coalesce(s.newest_has_warning, false)',
});
const LOAN_FROM = `servicing.loan_accounts la left join servicing.loan_sync_status s on s.loan_account_id = la.id`;
const mapLoan = (r: LoanRow) => ({
  id: r.id,
  lenderId: r.lenderId,
  lmsLoanRef: r.lmsLoanRef,
  status: r.status,
  sanctionedAmountMinor: paise(r.sanctionedAmountMinor),
  disbursedAmountMinor: paiseOrNull(r.disbursedAmountMinor),
  disbursedAt: r.disbursedAt,
  lastSyncedAt: r.lastSyncedAt,
  createdAt: r.createdAt,
  sync: {
    newestReportedAsOf: r.newestReportedAsOf,
    newestReceivedAt: r.newestReceivedAt,
    newestReportedStatus: r.newestReportedStatus,
    stale: r.stale,
    stalenessThresholdMinutes: r.stalenessThresholdMinutes,
    hasOpenConflict: r.hasOpenConflict,
    newestHasWarning: r.newestHasWarning,
  },
});

interface ReportRow {
  id: string;
  version: number;
  status: string;
  reportedAsOf: string;
  receivedAt: string;
  outstandingPrincipalMinor: string | null;
  overduePrincipalMinor: string | null;
  overdueInterestMinor: string | null;
  penalChargesMinor: string | null;
  otherChargesMinor: string | null;
  totalOverdueMinor: string | null;
  nextDueOn: string | null;
  nextDueMinor: string | null;
  daysPastDue: number | null;
  flags: string[];
  sourceSystem: string;
}
const REPORT_COLUMNS = columns({
  id: 'b.id',
  version: 'b.version',
  status: 'b.status::text',
  reportedAsOf: ts('b.reported_as_of'),
  receivedAt: ts('b.received_at'),
  outstandingPrincipalMinor: 'b.outstanding_principal_minor::text',
  overduePrincipalMinor: 'b.overdue_principal_minor::text',
  overdueInterestMinor: 'b.overdue_interest_minor::text',
  penalChargesMinor: 'b.penal_charges_minor::text',
  otherChargesMinor: 'b.other_charges_minor::text',
  totalOverdueMinor: 'b.total_overdue_minor::text',
  nextDueOn: day('b.next_due_on'),
  nextDueMinor: 'b.next_due_minor::text',
  daysPastDue: 'b.days_past_due',
  flags: 'b.flags',
  sourceSystem: 'b.source_system::text',
});
const mapReport = (r: ReportRow) => ({
  id: r.id,
  version: r.version,
  status: r.status,
  reportedAsOf: r.reportedAsOf,
  receivedAt: r.receivedAt,
  outstandingPrincipalMinor: paiseOrNull(r.outstandingPrincipalMinor),
  overduePrincipalMinor: paiseOrNull(r.overduePrincipalMinor),
  overdueInterestMinor: paiseOrNull(r.overdueInterestMinor),
  penalChargesMinor: paiseOrNull(r.penalChargesMinor),
  otherChargesMinor: paiseOrNull(r.otherChargesMinor),
  totalOverdueMinor: paiseOrNull(r.totalOverdueMinor),
  nextDueOn: r.nextDueOn,
  nextDueMinor: paiseOrNull(r.nextDueMinor),
  daysPastDue: r.daysPastDue,
  flags: r.flags,
  sourceSystem: r.sourceSystem,
});

interface InstallmentRow {
  seq: number;
  dueDate: string;
  principalMinor: string;
  interestMinor: string;
  feesMinor: string;
  totalMinor: string;
}
interface ReceiptRow {
  id: string;
  kind: string;
  lmsReceiptRef: string;
  reversesReceiptRef: string | null;
  amountMinor: string;
  valueDate: string;
  paymentMode: string | null;
  bankReference: string | null;
  reportedAsOf: string;
  receivedAt: string;
}
const RECEIPT_COLUMNS = columns({
  id: 'r.id',
  kind: 'r.kind',
  lmsReceiptRef: 'r.lms_receipt_ref',
  reversesReceiptRef: 'r.reverses_receipt_ref',
  amountMinor: 'r.amount_minor::text',
  valueDate: day('r.value_date'),
  paymentMode: 'r.payment_mode',
  bankReference: 'r.bank_reference',
  reportedAsOf: ts('r.reported_as_of'),
  receivedAt: ts('r.received_at'),
});
const mapReceipt = (r: ReceiptRow) => ({
  id: r.id,
  kind: r.kind,
  lmsReceiptRef: r.lmsReceiptRef,
  reversesReceiptRef: r.reversesReceiptRef,
  amountMinor: paise(r.amountMinor),
  valueDate: r.valueDate,
  paymentMode: r.paymentMode,
  bankReference: r.bankReference,
  reportedAsOf: r.reportedAsOf,
  receivedAt: r.receivedAt,
});

interface AnomalyRow {
  id: string;
  lenderId: string;
  loanAccountId: string;
  kind: string;
  severity: string;
  previousStatus: string | null;
  reportedStatus: string | null;
  previousAmountMinor: string | null;
  reportedAmountMinor: string | null;
  sourceSystem: string;
  reportedAsOf: string;
  detectedAt: string;
}
const ANOMALY_COLUMNS = columns({
  id: 'a.id',
  lenderId: 'a.lender_org_id',
  loanAccountId: 'a.loan_account_id',
  kind: 'a.kind',
  severity: 'a.severity',
  previousStatus: 'a.previous_status::text',
  reportedStatus: 'a.reported_status::text',
  previousAmountMinor: 'a.previous_amount_minor::text',
  reportedAmountMinor: 'a.reported_amount_minor::text',
  sourceSystem: 'a.source_system::text',
  reportedAsOf: ts('a.reported_as_of'),
  detectedAt: ts('a.detected_at'),
});
const mapAnomaly = (r: AnomalyRow) => ({
  id: r.id,
  lenderId: r.lenderId,
  loanAccountId: r.loanAccountId,
  kind: r.kind,
  severity: r.severity,
  previousStatus: r.previousStatus,
  reportedStatus: r.reportedStatus,
  previousAmountMinor: paiseOrNull(r.previousAmountMinor),
  reportedAmountMinor: paiseOrNull(r.reportedAmountMinor),
  sourceSystem: r.sourceSystem,
  reportedAsOf: r.reportedAsOf,
  detectedAt: r.detectedAt,
});

interface ConnectionRow {
  id: string;
  lenderId: string;
  kind: string;
  status: string;
  providerMode: string;
  capabilities: Record<string, boolean>;
  stalenessThresholdMinutes: number;
  lastSuccessAt: string | null;
  updatedAt: string;
}
const mapConnection = (r: ConnectionRow) => ({
  id: r.id,
  lenderId: r.lenderId,
  kind: r.kind,
  status: r.status,
  providerMode: r.providerMode,
  capabilities: r.capabilities,
  stalenessThresholdMinutes: r.stalenessThresholdMinutes,
  lastSuccessAt: r.lastSuccessAt,
  updatedAt: r.updatedAt,
});

interface BatchRow {
  id: string;
  lenderId: string;
  kind: string;
  sourceKind: string;
  status: string;
  formatVersion: string;
  rowCount: number;
  countNew: number;
  countUnchanged: number;
  countDuplicate: number;
  countChanged: number;
  countConflict: number;
  countError: number;
  countQuarantined: number;
  countIgnoredOlder: number;
  resubmissionOf: string | null;
  fileSha256: string;
  byteSize: string;
  uploadedAt: string;
  committedAt: string | null;
  rejectedAt: string | null;
  failedAt: string | null;
  failureClass: string | null;
  appliedCounts: Record<string, number> | null;
}
const BATCH_COLUMNS = columns({
  id: 'b.id',
  lenderId: 'b.lender_org_id',
  kind: 'b.kind',
  sourceKind: 'b.source_kind',
  status: 'b.status',
  formatVersion: 'b.format_version',
  rowCount: 'b.row_count',
  countNew: 'b.count_new',
  countUnchanged: 'b.count_unchanged',
  countDuplicate: 'b.count_duplicate',
  countChanged: 'b.count_changed',
  countConflict: 'b.count_conflict',
  countError: 'b.count_error',
  countQuarantined: 'b.count_quarantined',
  countIgnoredOlder: 'b.count_ignored_older',
  resubmissionOf: 'b.resubmission_of',
  fileSha256: 'b.file_sha256',
  byteSize: 'b.byte_size::text',
  uploadedAt: ts('b.uploaded_at'),
  committedAt: ts('b.committed_at'),
  rejectedAt: ts('b.rejected_at'),
  failedAt: ts('b.failed_at'),
  failureClass: 'b.failure_class',
  appliedCounts: 'b.applied_counts',
});
const mapBatch = (r: BatchRow) => ({
  id: r.id,
  lenderId: r.lenderId,
  kind: r.kind,
  sourceKind: r.sourceKind,
  status: r.status,
  formatVersion: r.formatVersion,
  rowCount: r.rowCount,
  counts: {
    new: r.countNew,
    unchanged: r.countUnchanged,
    duplicate: r.countDuplicate,
    changed: r.countChanged,
    conflict: r.countConflict,
    error: r.countError,
    quarantined: r.countQuarantined,
    ignoredOlder: r.countIgnoredOlder,
  },
  resubmissionOf: r.resubmissionOf,
  fileSha256: r.fileSha256,
  byteSize: count(r.byteSize),
  uploadedAt: r.uploadedAt,
  committedAt: r.committedAt,
  rejectedAt: r.rejectedAt,
  failedAt: r.failedAt,
  failureClass: r.failureClass,
  appliedCounts: r.appliedCounts,
});

interface ConflictRow {
  id: string;
  lenderId: string;
  loanAccountId: string;
  recordType: string;
  conflictReason: string;
  sourceRecordId: string;
  existingReportedAsOf: string;
  incomingReportedAsOf: string;
  sourceSystem: string;
  receivedAt: string;
  status: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  confirmedVersion: string | null;
  resolutionNote: string | null;
}
const CONFLICT_COLUMNS = columns({
  id: 'c.id',
  lenderId: 'c.lender_org_id',
  loanAccountId: 'c.loan_account_id',
  recordType: 'c.record_type',
  conflictReason: 'c.conflict_reason',
  sourceRecordId: 'c.source_record_id',
  existingReportedAsOf: ts('c.existing_reported_as_of'),
  incomingReportedAsOf: ts('c.incoming_reported_as_of'),
  sourceSystem: 'c.source_system::text',
  receivedAt: ts('c.received_at'),
  status: 'c.status',
  acknowledgedAt: ts('c.acknowledged_at'),
  resolvedAt: ts('c.resolved_at'),
  confirmedVersion: 'c.confirmed_version',
  resolutionNote: 'c.resolution_note',
});
const mapConflict = (r: ConflictRow) => ({
  id: r.id,
  lenderId: r.lenderId,
  loanAccountId: r.loanAccountId,
  recordType: r.recordType,
  conflictReason: r.conflictReason,
  sourceRecordId: r.sourceRecordId,
  existingReportedAsOf: r.existingReportedAsOf,
  incomingReportedAsOf: r.incomingReportedAsOf,
  sourceSystem: r.sourceSystem,
  receivedAt: r.receivedAt,
  status: r.status,
  acknowledgedAt: r.acknowledgedAt,
  resolvedAt: r.resolvedAt,
  confirmedVersion: r.confirmedVersion,
  resolutionNote: r.resolutionNote,
});

interface RequestRow {
  id: string;
  lenderId: string;
  loanAccountId: string;
  kind: string;
  periodFrom: string | null;
  periodTo: string | null;
  status: string;
  requestedAt: string;
  dueBy: string | null;
  lenderNote: string | null;
  decidedAt: string | null;
  fulfilledDocumentId: string | null;
  fulfilledQuoteId: string | null;
}
const REQUEST_COLUMNS = columns({
  id: 'q.id',
  lenderId: 'q.lender_org_id',
  loanAccountId: 'q.loan_account_id',
  kind: 'q.kind',
  periodFrom: day('q.period_from'),
  periodTo: day('q.period_to'),
  status: 'q.status',
  requestedAt: ts('q.requested_at'),
  dueBy: ts('q.due_by'),
  lenderNote: 'q.lender_note',
  decidedAt: ts('q.decided_at'),
  fulfilledDocumentId: 'q.fulfilled_document_id',
  fulfilledQuoteId: 'q.fulfilled_quote_id',
});
const mapRequest = (r: RequestRow) => ({
  id: r.id,
  lenderId: r.lenderId,
  loanAccountId: r.loanAccountId,
  kind: r.kind,
  periodFrom: r.periodFrom,
  periodTo: r.periodTo,
  status: r.status,
  requestedAt: r.requestedAt,
  dueBy: r.dueBy,
  lenderNote: r.lenderNote,
  decidedAt: r.decidedAt,
  fulfilledDocumentId: r.fulfilledDocumentId,
  fulfilledQuoteId: r.fulfilledQuoteId,
});

interface DocumentRow {
  documentId: string;
  kind: string;
  issuer: string;
  lenderReference: string;
  issuedAt: string;
  periodFrom: string | null;
  periodTo: string | null;
  sizeBytes: string;
  sha256: string;
  source: string;
  supersededById: string | null;
}
const DOCUMENT_COLUMNS = columns({
  documentId: 'd.document_id',
  kind: 'd.kind',
  issuer: 'd.issuer',
  lenderReference: 'd.lender_reference',
  issuedAt: ts('d.issued_at'),
  periodFrom: day('d.period_from'),
  periodTo: day('d.period_to'),
  sizeBytes: 'd.size_bytes::text',
  sha256: 'd.sha256',
  source: 'd.source',
  supersededById: 'd.superseded_by_id',
});
const mapDocument = (r: DocumentRow) => ({
  documentId: r.documentId,
  kind: r.kind,
  issuer: r.issuer,
  lenderReference: r.lenderReference,
  issuedAt: r.issuedAt,
  periodFrom: r.periodFrom,
  periodTo: r.periodTo,
  sizeBytes: count(r.sizeBytes),
  sha256: r.sha256,
  source: r.source,
  supersededById: r.supersededById,
});

interface QuoteRow {
  id: string;
  lenderId: string;
  loanAccountId: string;
  lenderQuoteRef: string;
  asOf: string;
  validUntil: string;
  principalMinor: string;
  interestMinor: string;
  chargesMinor: string;
  prepaymentChargeMinor: string;
  totalMinor: string;
  totalMismatch: boolean;
  source: string;
  letterDocumentId: string | null;
  reportedAt: string;
}
const QUOTE_COLUMNS = columns({
  id: 'q.id',
  lenderId: 'q.lender_org_id',
  loanAccountId: 'q.loan_account_id',
  lenderQuoteRef: 'q.lender_quote_ref',
  asOf: ts('q.as_of'),
  validUntil: ts('q.valid_until'),
  principalMinor: 'q.principal_minor::text',
  interestMinor: 'q.interest_minor::text',
  chargesMinor: 'q.charges_minor::text',
  prepaymentChargeMinor: 'q.prepayment_charge_minor::text',
  totalMinor: 'q.total_minor::text',
  totalMismatch: 'q.total_mismatch',
  source: 'q.source',
  letterDocumentId: 'q.letter_document_id',
  reportedAt: ts('q.reported_at'),
});
const mapQuote = (r: QuoteRow) => ({
  id: r.id,
  lenderId: r.lenderId,
  loanAccountId: r.loanAccountId,
  lenderQuoteRef: r.lenderQuoteRef,
  asOf: r.asOf,
  validUntil: r.validUntil,
  principalMinor: paise(r.principalMinor),
  interestMinor: paise(r.interestMinor),
  chargesMinor: paise(r.chargesMinor),
  prepaymentChargeMinor: paise(r.prepaymentChargeMinor),
  totalMinor: paise(r.totalMinor),
  totalMismatch: r.totalMismatch,
  source: r.source,
  letterDocumentId: r.letterDocumentId,
  reportedAt: r.reportedAt,
});

interface ClosureRow {
  id: string;
  lenderId: string;
  loanAccountId: string;
  closureKind: string;
  closedAt: string;
  nocDueBy: string | null;
  nocDocumentId: string | null;
  nocIssuedAt: string | null;
}
const CLOSURE_COLUMNS = columns({
  id: 'c.id',
  lenderId: 'c.lender_org_id',
  loanAccountId: 'c.loan_account_id',
  closureKind: 'c.closure_kind',
  closedAt: ts('c.closed_at'),
  nocDueBy: ts('c.noc_due_by'),
  nocDocumentId: 'c.noc_document_id',
  nocIssuedAt: ts('c.noc_issued_at'),
});
interface TaskRow {
  closureId: string;
  id: string;
  collateralType: string;
  status: string;
  dueBy: string | null;
  delayReason: string | null;
  delayReasonAt: string | null;
  lenderConfirmationRef: string | null;
  confirmedAt: string | null;
  createdAt: string;
}
const TASK_COLUMNS = columns({
  closureId: 't.closure_id',
  id: 't.id',
  collateralType: 't.collateral_type',
  status: 't.status',
  dueBy: ts('t.due_by'),
  delayReason: 't.delay_reason',
  delayReasonAt: ts('t.delay_reason_at'),
  lenderConfirmationRef: 't.lender_confirmation_ref',
  confirmedAt: ts('t.confirmed_at'),
  createdAt: ts('t.created_at'),
});
const mapTask = (r: TaskRow) => ({
  id: r.id,
  collateralType: r.collateralType,
  status: r.status,
  dueBy: r.dueBy,
  delayReason: r.delayReason,
  delayReasonAt: r.delayReasonAt,
  lenderConfirmationRef: r.lenderConfirmationRef,
  confirmedAt: r.confirmedAt,
  createdAt: r.createdAt,
});

interface RowErrorRow {
  row_no: number;
  outcome: string;
  error_codes: string[];
  field_names: string[];
}

/** The batch row, or undefined when the caller cannot see it (another lender's batch looks exactly like a missing one). */
async function loadBatch(tx: UserTx, id: string): Promise<BatchRow | undefined> {
  const r = await tx.query<BatchRow>(
    `select ${BATCH_COLUMNS} from servicing.import_batches b where b.id = $1::uuid`,
    [id],
  );
  return r.rows[0];
}

/** Row-level problems of a stored preview: positions, classes and field names. Never a value. */
async function loadRowErrors(tx: UserTx, batch: BatchRow) {
  const r = await tx.query<RowErrorRow>(
    `select e.row_no, e.outcome, e.error_codes, e.field_names
       from servicing.import_errors($1::uuid) e order by e.row_no limit ${String(MAX_ERROR_ROWS)}`,
    [batch.id],
  );
  return {
    errors: r.rows.map((x) => ({
      rowNo: x.row_no,
      outcome: x.outcome,
      errorCodes: x.error_codes,
      fieldNames: x.field_names,
    })),
    errorsTruncated: batch.countError + batch.countQuarantined > MAX_ERROR_ROWS,
  };
}

/** What `commit`, `reject` and `stage` return: the batch as the database now holds it, with its row-level problems. */
async function importOutcome(tx: UserTx, id: string, existing: boolean) {
  const batch = await loadBatch(tx, id);
  if (!batch) throw notFound();
  return {
    existing,
    batch: mapBatch(batch),
    refusedFile: null,
    ...(await loadRowErrors(tx, batch)),
    rowNumbering: 'record_position' as const,
  };
}

const SqlBatchAnswer = z.object({ batch_id: z.uuid(), existing: z.boolean() });

/** A key for the database's own idempotency (16 to 128 characters), scoped to the caller so two people cannot collide. */
function databaseImportKey(subject: string, key: string): string {
  return createHash('sha256').update(`lender-import:${subject}:${key}`).digest('hex');
}

// ---------------------------------------------------------------------------------------------------------------
// The routes
// ---------------------------------------------------------------------------------------------------------------
/**
 * The routes. Lender users and platform staff are both `auth: 'staff'` (a second factor is always required); what each may
 * read or write is decided by the permissions and row level security in the database.
 */
export function lenderServicingRoutes(deps: { documents?: DocumentStore }): RouteDefinition[] {
  const requireStore = (): DocumentStore => {
    if (!deps.documents) {
      throw new ApiError(
        503,
        'document_store_unavailable',
        'Service Unavailable',
        'No private document store is configured in this environment.',
      );
    }
    return deps.documents;
  };

  return [
    // ---- loans as the lender reported them ------------------------------------------------------------------------
    userRoute({
      method: 'get',
      path: '/v1/lender/loans',
      operationId: 'listLenderLoans',
      summary: 'Loan accounts as your system reported them, newest first',
      description:
        'Needs loan.read. Each row is one loan account with the lender-reported status and sanctioned amount, and where the sync stands (the time of the newest report, whether it is stale, whether a conflict or a warning waits). No borrower identity is returned; the loan account is the link. Nothing is computed by Udofin.',
      tags: ['Servicing (lender)'],
      auth: 'staff',
      query: LsLoanListQuery,
      responses: { 200: LsLoanPage },
      errors: [400, 401, 403, 422],
      rateLimit: READ_LIMIT,
      handler: async ({ tx, query }) => {
        await requireReader(tx, query.lenderId);
        const w = new Where();
        if (query.lenderId) w.add((p) => `la.lender_org_id = ${p}::uuid`, query.lenderId);
        if (query.status) w.add((p) => `la.status = ${p}::servicing.loan_status`, query.status);
        olderThan(w, query.cursor, 'la.created_at', 'la.id');
        const limit = w.placeholder(query.limit + 1);
        const r = await tx.query<LoanRow>(
          `select ${LOAN_COLUMNS} from ${LOAN_FROM} where ${w.sql}
            order by la.created_at desc, la.id desc limit ${limit}::int`,
          w.values,
        );
        return {
          status: 200,
          body: pageOf(r.rows, query.limit, mapLoan, (row) =>
            encodeCursor({ t: row.createdAt, id: row.id }),
          ),
        };
      },
    }),
    userRoute({
      method: 'get',
      path: '/v1/lender/loans/:id',
      operationId: 'getLenderLoan',
      summary:
        'One loan with the newest report, its staleness, the newest schedule, recent receipts and the flags that wait',
      description:
        "Needs loan.read; another lender's loan answers 404. Every figure is the lender's, with the lender's time (`reportedAsOf`); a null figure was not reported. `anomalies` counts the flags the sync raised next to what was reported (nothing was corrected); `openConflicts` counts conflicts not yet resolved.",
      tags: ['Servicing (lender)'],
      auth: 'staff',
      params: Id,
      responses: { 200: LsLoanDetail },
      errors: [401, 403, 404],
      rateLimit: READ_LIMIT,
      handler: async ({ tx, params }) => {
        await requireReader(tx, undefined);
        const loan = await tx.query<LoanRow>(
          `select ${LOAN_COLUMNS} from ${LOAN_FROM} where la.id = $1::uuid`,
          [params.id],
        );
        const loanRow = loan.rows[0];
        if (!loanRow) throw notFound();
        const report = await tx.query<ReportRow>(
          `select ${REPORT_COLUMNS} from servicing.balance_snapshots b
            where b.loan_account_id = $1::uuid order by b.reported_as_of desc, b.version desc limit 1`,
          [params.id],
        );
        const snapshot = await tx.query<{
          id: string;
          version: number;
          reportedAsOf: string | null;
          receivedAt: string;
        }>(
          `select ${columns({
            id: 's.id',
            version: 's.version',
            reportedAsOf: ts('s.reported_as_of'),
            receivedAt: ts('s.received_at'),
          })} from servicing.schedule_snapshots s
            where s.loan_account_id = $1::uuid order by s.version desc limit 1`,
          [params.id],
        );
        const snap = snapshot.rows[0];
        let schedule = null;
        if (snap) {
          const items = await tx.query<InstallmentRow>(
            `select ${columns({
              seq: 'i.seq',
              dueDate: day('i.due_date'),
              principalMinor: 'i.principal_minor::text',
              interestMinor: 'i.interest_minor::text',
              feesMinor: 'i.fees_minor::text',
              totalMinor: 'i.total_minor::text',
            })} from servicing.schedule_installments i
              where i.snapshot_id = $1::uuid order by i.seq limit 700`,
            [snap.id],
          );
          schedule = {
            id: snap.id,
            version: snap.version,
            reportedAsOf: snap.reportedAsOf,
            receivedAt: snap.receivedAt,
            installments: items.rows.map((x) => ({
              seq: x.seq,
              dueDate: x.dueDate,
              principalMinor: paise(x.principalMinor),
              interestMinor: paise(x.interestMinor),
              feesMinor: paise(x.feesMinor),
              totalMinor: paise(x.totalMinor),
            })),
          };
        }
        const receipts = await tx.query<ReceiptRow>(
          `select ${RECEIPT_COLUMNS} from servicing.lms_receipts r
            where r.loan_account_id = $1::uuid order by r.received_at desc, r.id desc limit 20`,
          [params.id],
        );
        const flags = await tx.query<{ conflicts: string; warning: string; info: string }>(
          `select (select count(*) from servicing.sync_conflicts c
                    where c.loan_account_id = $1::uuid and c.status <> 'resolved')::text as conflicts,
                  (select count(*) from servicing.sync_anomalies a
                    where a.loan_account_id = $1::uuid and a.severity = 'warning')::text as warning,
                  (select count(*) from servicing.sync_anomalies a
                    where a.loan_account_id = $1::uuid and a.severity = 'info')::text as info`,
          [params.id],
        );
        const f = flags.rows[0];
        return {
          status: 200,
          body: {
            loan: mapLoan(loanRow),
            report: report.rows[0] ? mapReport(report.rows[0]) : null,
            schedule,
            receipts: receipts.rows.map(mapReceipt),
            openConflicts: count(f?.conflicts ?? '0'),
            anomalies: { warning: count(f?.warning ?? '0'), info: count(f?.info ?? '0') },
          },
        };
      },
    }),

    // ---- sync status and the LMS connection -----------------------------------------------------------------------
    userRoute({
      method: 'get',
      path: '/v1/lender/sync/status',
      operationId: 'getLenderSyncStatus',
      summary:
        'Where the sync stands for each of your lenders: the connection and counts over the loans',
      description:
        'Needs loan.read. Per lender: the single LMS connection (kind, status, capabilities, staleness threshold, time of the last successful import) and counts over servicing.loan_sync_status. `stale` counts loans with no report yet and loans whose newest report is older than the threshold; `neverReported` is the first of those. At most 100 lenders (a platform grantee of loan.read sees every lender).',
      tags: ['Servicing (lender)'],
      auth: 'staff',
      query: LsLenderFilterQuery,
      responses: { 200: LsSyncStatus },
      errors: [401, 403, 422],
      rateLimit: READ_LIMIT,
      handler: async ({ tx, query }) => {
        await requireReader(tx, query.lenderId);
        const r = await tx.query<{
          lenderId: string;
          connectionId: string | null;
          kind: string | null;
          status: string | null;
          providerMode: string | null;
          capabilities: Record<string, boolean> | null;
          stalenessThresholdMinutes: number | null;
          lastSuccessAt: string | null;
          updatedAt: string | null;
          total: string;
          neverReported: string;
          stale: string;
          withOpenConflict: string;
          withWarning: string;
          newestReportedAsOf: string | null;
        }>(
          `with lenders as (
             select c.lender_org_id from servicing.lms_connections c where $1::uuid is null or c.lender_org_id = $1::uuid
             union
             select s.lender_org_id from servicing.loan_sync_status s where $1::uuid is null or s.lender_org_id = $1::uuid)
           select ${columns({
             lenderId: 'l.lender_org_id',
             connectionId: 'c.id',
             kind: 'c.kind',
             status: 'c.status',
             providerMode: 'c.provider_mode::text',
             capabilities: 'c.capabilities',
             stalenessThresholdMinutes: 'c.staleness_threshold_minutes',
             lastSuccessAt: ts('c.last_success_at'),
             updatedAt: ts('c.updated_at'),
             total: 'n.total',
             neverReported: 'n.never_reported',
             stale: 'n.stale',
             withOpenConflict: 'n.with_open_conflict',
             withWarning: 'n.with_warning',
             newestReportedAsOf: ts('n.newest'),
           })}
             from lenders l
             left join servicing.lms_connections c on c.lender_org_id = l.lender_org_id
             cross join lateral (
               select count(*)::text as total,
                      (count(*) filter (where s.newest_snapshot_id is null))::text as never_reported,
                      (count(*) filter (where s.stale))::text as stale,
                      (count(*) filter (where s.has_open_conflict))::text as with_open_conflict,
                      (count(*) filter (where s.newest_has_warning))::text as with_warning,
                      max(s.newest_reported_as_of) as newest
                 from servicing.loan_sync_status s where s.lender_org_id = l.lender_org_id) n
            order by l.lender_org_id limit 100`,
          [query.lenderId ?? null],
        );
        return {
          status: 200,
          body: {
            items: r.rows.map((x) => ({
              lenderId: x.lenderId,
              connection:
                x.connectionId === null ||
                x.kind === null ||
                x.status === null ||
                x.providerMode === null ||
                x.capabilities === null ||
                x.stalenessThresholdMinutes === null ||
                x.updatedAt === null
                  ? null
                  : mapConnection({
                      id: x.connectionId,
                      lenderId: x.lenderId,
                      kind: x.kind,
                      status: x.status,
                      providerMode: x.providerMode,
                      capabilities: x.capabilities,
                      stalenessThresholdMinutes: x.stalenessThresholdMinutes,
                      lastSuccessAt: x.lastSuccessAt,
                      updatedAt: x.updatedAt,
                    }),
              loans: {
                total: count(x.total),
                neverReported: count(x.neverReported),
                stale: count(x.stale),
                withOpenConflict: count(x.withOpenConflict),
                withWarning: count(x.withWarning),
              },
              newestReportedAsOf: x.newestReportedAsOf,
            })),
          },
        };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/lender/lms-connection',
      operationId: 'setLenderLmsConnection',
      summary: "Create or change the lender's single LMS connection",
      description:
        'Needs servicing.sync.manage of that lender, a second factor and the servicing_sync switch on. file_import and manual can be active; mock only where the environment allows mock providers; finbyx and generic_rest can only be recorded as blocked_unverified (connector_unverified otherwise) because no specification exists. A lender the caller may not touch and a lender that does not exist both answer 403. The capabilities are flags the lender declares; no secret is recorded here.',
      tags: ['Servicing (lender)'],
      auth: 'staff',
      idempotent: true,
      idempotencyTenant: ({ body }) => (body as { lenderId: string }).lenderId,
      body: LsConnectionInput,
      responses: { 200: LsConnectionResult },
      errors: [400, 401, 403, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, body }) => {
        const r = await tx.query<{ r: string }>(
          'select servicing.set_lms_connection($1::uuid, $2, $3, $4::jsonb, $5::int, null) as r',
          [
            body.lenderId,
            body.kind,
            body.status,
            JSON.stringify(body.capabilities),
            body.stalenessThresholdMinutes,
          ],
        );
        return { status: 200, body: { id: first(r.rows) } };
      },
    }),
    userRoute({
      method: 'get',
      path: '/v1/lender/sync/anomalies',
      operationId: 'listLenderSyncAnomalies',
      summary: 'Flags the sync raised next to what the lender reported, newest first',
      description:
        "Needs loan.read. An anomaly is stored beside the report, never as a correction: a status that moved backwards, an outstanding amount that rose without a reported charge, parts that do not add up to the total, a changed sanctioned amount, and the older reports that were ignored and counted. Both figures are the lender's.",
      tags: ['Servicing (lender)'],
      auth: 'staff',
      query: LsAnomalyListQuery,
      responses: { 200: LsAnomalyPage },
      errors: [400, 401, 403, 422],
      rateLimit: READ_LIMIT,
      handler: async ({ tx, query }) => {
        await requireReader(tx, query.lenderId);
        const w = new Where();
        if (query.lenderId) w.add((p) => `a.lender_org_id = ${p}::uuid`, query.lenderId);
        if (query.loanAccountId)
          w.add((p) => `a.loan_account_id = ${p}::uuid`, query.loanAccountId);
        if (query.severity) w.add((p) => `a.severity = ${p}`, query.severity);
        olderThan(w, query.cursor, 'a.detected_at', 'a.id');
        const limit = w.placeholder(query.limit + 1);
        const r = await tx.query<AnomalyRow>(
          `select ${ANOMALY_COLUMNS} from servicing.sync_anomalies a where ${w.sql}
            order by a.detected_at desc, a.id desc limit ${limit}::int`,
          w.values,
        );
        return {
          status: 200,
          body: pageOf(r.rows, query.limit, mapAnomaly, (row) =>
            encodeCursor({ t: row.detectedAt, id: row.id }),
          ),
        };
      },
    }),

    // ---- conflicts ------------------------------------------------------------------------------------------------
    userRoute({
      method: 'get',
      path: '/v1/lender/sync/conflicts',
      operationId: 'listLenderSyncConflicts',
      summary: 'Records reported twice with different content, newest first',
      description:
        "Needs loan.read. A conflict keeps both versions untouched; handling it only changes its status (open, acknowledged, resolved). The refused version's content is not returned.",
      tags: ['Servicing (lender)'],
      auth: 'staff',
      query: LsConflictListQuery,
      responses: { 200: LsConflictPage },
      errors: [400, 401, 403, 422],
      rateLimit: READ_LIMIT,
      handler: async ({ tx, query }) => {
        await requireReader(tx, query.lenderId);
        const w = new Where();
        if (query.lenderId) w.add((p) => `c.lender_org_id = ${p}::uuid`, query.lenderId);
        if (query.loanAccountId)
          w.add((p) => `c.loan_account_id = ${p}::uuid`, query.loanAccountId);
        if (query.status) w.add((p) => `c.status = ${p}`, query.status);
        olderThan(w, query.cursor, 'c.received_at', 'c.id');
        const limit = w.placeholder(query.limit + 1);
        const r = await tx.query<ConflictRow>(
          `select ${CONFLICT_COLUMNS} from servicing.sync_conflicts c where ${w.sql}
            order by c.received_at desc, c.id desc limit ${limit}::int`,
          w.values,
        );
        return {
          status: 200,
          body: pageOf(r.rows, query.limit, mapConflict, (row) =>
            encodeCursor({ t: row.receivedAt, id: row.id }),
          ),
        };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/lender/sync/conflicts/:id/acknowledge',
      operationId: 'acknowledgeLenderSyncConflict',
      summary: 'Acknowledge a conflict (you have seen it and will look at it)',
      description:
        'Needs servicing.sync.manage of the lender, a second factor and the servicing_sync switch on. open to acknowledged only (conflict_not_open otherwise). A conflict of another lender answers 404.',
      tags: ['Servicing (lender)'],
      auth: 'staff',
      idempotent: true,
      params: Id,
      responses: { 200: LsConflictActionResult },
      errors: [400, 401, 403, 404, 409],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params }) => {
        await tx.query('select servicing.acknowledge_sync_conflict($1::uuid)', [params.id]);
        return { status: 200, body: { id: params.id, status: 'acknowledged' } };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/lender/sync/conflicts/:id/resolve',
      operationId: 'resolveLenderSyncConflict',
      summary:
        'Resolve an acknowledged conflict: which version the lender confirms, why, and what was reviewed',
      description:
        "Needs servicing.sync.manage of the lender, a second factor and the servicing_sync switch on. Resolving records the lender's decision and changes no stored report: neither version is rewritten, applied, hidden or deleted. The note is 10 to 1000 characters; the evidence is a flat object of 1 to 20 short references (keys a-z0-9_, values 1 to 200 characters) and must not look like personal data (evidence_invalid).",
      tags: ['Servicing (lender)'],
      auth: 'staff',
      idempotent: true,
      params: Id,
      body: LsConflictResolveInput,
      responses: { 200: LsConflictActionResult },
      errors: [400, 401, 403, 404, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params, body }) => {
        await tx.query('select servicing.resolve_sync_conflict($1::uuid, $2, $3, $4::jsonb)', [
          params.id,
          body.confirmedVersion,
          body.note,
          JSON.stringify(body.evidence),
        ]);
        return { status: 200, body: { id: params.id, status: 'resolved' } };
      },
    }),

    // ---- file import (all or nothing) -----------------------------------------------------------------------------
    userRoute({
      method: 'get',
      path: '/v1/lender/imports',
      operationId: 'listLenderImports',
      summary: 'Import batches (one per distinct file), newest first',
      description:
        'Needs loan.read. A batch carries its status (previewed, invalid, committed, rejected, failed), the counts per outcome and the SHA-256 and size of the file. No file name and no row value is stored or returned.',
      tags: ['Servicing (lender)'],
      auth: 'staff',
      query: LsImportListQuery,
      responses: { 200: LsImportBatchPage },
      errors: [400, 401, 403, 422],
      rateLimit: READ_LIMIT,
      handler: async ({ tx, query }) => {
        await requireReader(tx, query.lenderId);
        const w = new Where();
        if (query.lenderId) w.add((p) => `b.lender_org_id = ${p}::uuid`, query.lenderId);
        if (query.kind) w.add((p) => `b.kind = ${p}`, query.kind);
        if (query.status) w.add((p) => `b.status = ${p}`, query.status);
        olderThan(w, query.cursor, 'b.uploaded_at', 'b.id');
        const limit = w.placeholder(query.limit + 1);
        const r = await tx.query<BatchRow>(
          `select ${BATCH_COLUMNS} from servicing.import_batches b where ${w.sql}
            order by b.uploaded_at desc, b.id desc limit ${limit}::int`,
          w.values,
        );
        return {
          status: 200,
          body: pageOf(r.rows, query.limit, mapBatch, (row) =>
            encodeCursor({ t: row.uploadedAt, id: row.id }),
          ),
        };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/lender/imports',
      operationId: 'stageLenderImport',
      summary:
        'Stage a file of loan, receipt or schedule reports of the lender: validate it as a whole and store the preview (nothing is applied)',
      description:
        'Needs servicing.manual_entry (and loan.read) of the lender, a second factor, the servicing_sync switch on and an active file_import (or manual) connection. Send the file as text (`content` with `fileFormat` csv or json) or as JSON records (`rows`). Format udofin-lms-import-v1 (packages/adapters/src/lms.ts); money is a decimal rupee STRING; at most 5 MiB and 10,000 records. ALL OR NOTHING (owner decision of 14 Oct 2026): if any record has an error the whole file is invalid, nothing is applied and the answer lists the row numbers, error classes and field NAMES, never a value (`rowNumbering` says what a number counts: for a file the importer refuses it is a row of your file, CSV rows counted after the header; for a stored batch it is the position of the record among the distinct records found in the file, where identical repeated records count once and all installment rows of one CSV schedule are one record); correct the file and send it again (`resubmissionOf` links the new batch to the old). The same file twice returns the same batch (`existing`). A file the importer cannot accept at all (unparseable, too large, unknown column) is audited without row values and answers 200 with `refusedFile` and no batch. Committing is a separate step and needs servicing.sync.manage. Status 201 for a new batch.',
      tags: ['Servicing (lender)'],
      auth: 'staff',
      idempotent: true,
      idempotencyTenant: ({ body }) => (body as { lenderId: string }).lenderId,
      body: LsImportInput,
      responses: { 200: LsImportOutcome, 201: LsImportOutcome },
      errors: [400, 401, 403, 409, 422],
      rateLimit: IMPORT_LIMIT,
      bodyLimit: IMPORT_BODY_LIMIT,
      handler: async ({ tx, auth, body, idempotencyKey }) => {
        await requireReader(tx, body.lenderId);
        const text = body.content ?? importTextOfRows(body.rows);
        const parsed = parseLmsImportFile(text, {
          format: body.content === undefined ? 'json' : (body.fileFormat ?? 'json'),
          kind: body.kind,
          sourceSystem: body.sourceKind === 'file' ? 'file_import' : 'manual_import',
        });
        if (!parsed.importable) {
          // The importer refused the file before any record reached the database: leave the audit record (hash, size,
          // record count, positions, classes and field names) and answer without a batch.
          await tx.query(
            'select servicing.record_rejected_file($1::uuid, $2, $3, $4, $5::bigint, $6, $7::int, $8::jsonb)',
            [
              body.lenderId,
              body.kind,
              body.sourceKind,
              parsed.fileSha256,
              parsed.byteSize,
              LMS_IMPORT_FORMAT,
              parsed.recordCount,
              JSON.stringify(auditErrors(parsed.errors)),
            ],
          );
          const grouped = groupRowErrors(parsed.errors);
          return {
            status: 200,
            body: {
              existing: false,
              batch: null,
              refusedFile: {
                fileSha256: parsed.fileSha256,
                byteSize: parsed.byteSize,
                recordCount: parsed.recordCount,
              },
              errors: grouped.rows,
              errorsTruncated: grouped.truncated,
              rowNumbering: 'file_row' as const,
            },
          };
        }
        await tx.query(BULK_STATEMENT_TIMEOUT);
        const staged = await tx.query<{ r: unknown }>(
          'select servicing.stage_import($1::uuid, $2, $3, $4, $5::bigint, $6, $7::jsonb, $8, $9::uuid) as r',
          [
            body.lenderId,
            body.kind,
            body.sourceKind,
            parsed.fileSha256,
            parsed.byteSize,
            parsed.formatVersion,
            JSON.stringify(parsed.rows.map(toImportRecord)),
            databaseImportKey(auth.claims.sub, idempotencyKey ?? randomUUID()),
            body.resubmissionOf ?? null,
          ],
        );
        const answer = SqlBatchAnswer.parse(first(staged.rows));
        const outcome = await importOutcome(tx, answer.batch_id, answer.existing);
        return { status: answer.existing ? 200 : 201, body: outcome };
      },
    }),
    userRoute({
      method: 'get',
      path: '/v1/lender/imports/:id',
      operationId: 'getLenderImport',
      summary: 'One import batch with its row-level problems',
      description:
        "Needs loan.read; another lender's batch answers 404. The problems are record positions (`rowNumbering` is `record_position`: the position among the distinct records found in the file, identical repeated records counted once, all installment rows of one CSV schedule one record, so not always a row of the file), error classes and the names of the fields at fault (servicing.import_errors): never a value. At most 1,000 rows are listed (`errorsTruncated`).",
      tags: ['Servicing (lender)'],
      auth: 'staff',
      params: Id,
      responses: { 200: LsImportDetail },
      errors: [401, 403, 404],
      rateLimit: READ_LIMIT,
      handler: async ({ tx, params }) => {
        await requireReader(tx, undefined);
        const batch = await loadBatch(tx, params.id);
        if (!batch) throw notFound();
        return {
          status: 200,
          body: {
            batch: mapBatch(batch),
            ...(await loadRowErrors(tx, batch)),
            rowNumbering: 'record_position' as const,
          },
        };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/lender/imports/:id/commit',
      operationId: 'commitLenderImport',
      summary: 'Apply a previewed batch: every record in one transaction, or none',
      description:
        "Needs servicing.sync.manage of the lender, a second factor, the servicing_sync switch on and an active connection. An invalid batch is refused (import_has_errors), a rejected one batch_rejected, a failed one batch_failed, a batch not previewed batch_not_previewed. Committing a committed batch answers it again (`existing`). If applying fails, everything is rolled back and the answer is 200 with `batch.status` failed and its `failureClass` (an SQLSTATE): nothing was applied, the failure is audited and the file can be staged again. Another lender's batch answers 404.",
      tags: ['Servicing (lender)'],
      auth: 'staff',
      idempotent: true,
      params: Id,
      responses: { 200: LsImportOutcome },
      errors: [400, 401, 403, 404, 409],
      rateLimit: IMPORT_LIMIT,
      handler: async ({ tx, params }) => {
        if (!(await loadBatch(tx, params.id))) throw notFound();
        await tx.query(BULK_STATEMENT_TIMEOUT);
        const r = await tx.query<{ r: unknown }>('select servicing.commit_import($1::uuid) as r', [
          params.id,
        ]);
        const answer = SqlBatchAnswer.parse(first(r.rows));
        // A failed commit is a normal answer here: raising would roll back the record that says it failed.
        return { status: 200, body: await importOutcome(tx, answer.batch_id, answer.existing) };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/lender/imports/:id/reject',
      operationId: 'rejectLenderImport',
      summary: 'Discard a previewed batch with a reason; its content is dropped',
      description:
        "Needs servicing.manual_entry or servicing.sync.manage of the lender, a second factor and the servicing_sync switch on. Only a previewed batch can be rejected (batch_not_rejectable). The reason is 10 to 1000 characters of free text, stored on the batch and not written to the audit event. Hashes, counts and codes stay; the file's hash is released so the file can be staged again. Another lender's batch answers 404.",
      tags: ['Servicing (lender)'],
      auth: 'staff',
      idempotent: true,
      params: Id,
      body: LsImportRejectInput,
      responses: { 200: LsImportOutcome },
      errors: [400, 401, 403, 404, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params, body }) => {
        if (!(await loadBatch(tx, params.id))) throw notFound();
        const r = await tx.query<{ r: unknown }>(
          'select servicing.reject_import($1::uuid, $2) as r',
          [params.id, body.reason],
        );
        const answer = SqlBatchAnswer.parse(first(r.rows));
        return { status: 200, body: await importOutcome(tx, answer.batch_id, answer.existing) };
      },
    }),

    // ---- lender-issued documents ----------------------------------------------------------------------------------
    userRoute({
      method: 'post',
      path: '/v1/lender/loans/:id/documents',
      operationId: 'uploadLenderLoanDocument',
      summary:
        'Register a statement, quotation letter, no-dues certificate or closure letter your organisation issued (PDF, at most 8 MiB)',
      description:
        "Needs servicing.document.issue of the lender, a second factor and the statements_noc switch on. Udofin generates and issues none of these: the file is YOUR signed PDF. It is checked as an upload (a PDF with scripts or attachments is refused), hashed, stored privately under an opaque key and recorded with its SHA-256 and size. The database is asked first; the bytes are stored only after it accepted the registration. The same lender reference with the same bytes returns the same document (`existing`); the same reference with other bytes is lender_reference_reused. With `requestId` the borrower's open request is fulfilled in the same transaction. Without a configured store the answer is 503.",
      tags: ['Documents (lender)'],
      auth: 'staff',
      idempotent: true,
      params: Id,
      body: LsDocumentUploadInput,
      responses: { 200: LsDocumentUploadResult, 201: LsDocumentUploadResult },
      errors: [400, 401, 403, 404, 409, 413, 422, 503],
      rateLimit: UPLOAD_LIMIT,
      bodyLimit: DOCUMENT_BODY_LIMIT,
      handler: async ({ tx, request, params, body }) => {
        const store = requireStore();
        if (
          body.contentBase64.length % 4 !== 0 ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(body.contentBase64)
        ) {
          throw new ApiError(
            422,
            'validation_failed',
            'Unprocessable Content',
            'body.contentBase64: invalid_format',
          );
        }
        const bytes = Buffer.from(body.contentBase64, 'base64');
        if (bytes.length === 0 || bytes.length > LS_DOCUMENT_MAX_BYTES)
          throw new ApiError(413, 'document_too_large', 'Content Too Large');
        // A file that is not a PDF, or whose PDF names active content, is never stored: the borrower and Udofin staff open it.
        assertUploadAllowed(bytes, body.mimeType);
        const sha256 = sha256Hex(bytes);
        // The same reference with the same bytes is the same document: the database returns the existing one and nothing new is stored.
        const earlier = await tx.query<{ id: string; sha256: string }>(
          `select d.id, d.sha256 from servicing.loan_documents d
            where d.loan_account_id = $1::uuid and d.kind = $2 and d.lender_reference = $3`,
          [params.id, body.kind, body.lenderReference],
        );
        const existing = earlier.rows[0]?.sha256 === sha256;
        const key = `servicing/${randomUUID()}`;
        assertValidDocumentKey(key);
        // The database decides first (permission, tenant, switch, request, period). Nothing is stored for a request it refuses.
        const r = await tx.query<{ r: string }>(
          `select servicing.register_loan_document($1::uuid, $2, $3, $4, $5::bigint, $6, $7, $8::timestamptz,
                                                   $9::date, $10::date, $11::uuid, $12::uuid, 'lender_upload') as r`,
          [
            params.id,
            body.kind,
            key,
            sha256,
            bytes.length,
            body.mimeType,
            body.lenderReference,
            body.issuedAt,
            body.periodFrom ?? null,
            body.periodTo ?? null,
            body.supersedesDocumentId ?? null,
            body.requestId ?? null,
          ],
        );
        const documentId = first(r.rows);
        if (!existing) {
          try {
            await store.put(key, bytes, { mimeType: 'application/pdf', sha256 });
          } catch (error) {
            // The registration is still inside this request's transaction: raising rolls it back, so no record points at a
            // missing object. A partly written object is removed; if even that fails the key class is logged (never the key).
            await store.delete(key).catch(() => {
              request.log.warn(
                { event: 'document_store_cleanup_failed', keyClass: 'servicing_document' },
                'an unreferenced document object could not be removed',
              );
            });
            throw error;
          }
        }
        return { status: existing ? 200 : 201, body: { documentId, existing } };
      },
    }),
    userRoute({
      method: 'get',
      path: '/v1/lender/loans/:id/documents',
      operationId: 'listLenderLoanDocuments',
      summary: 'Documents your organisation issued for a loan, newest first',
      description:
        'Needs loan.read; a loan of another lender answers 404. Metadata only (kind, your reference, issue time, period, size, SHA-256, supersession): never the storage key. A document that a newer one supersedes names it in `supersededById`.',
      tags: ['Documents (lender)'],
      auth: 'staff',
      params: Id,
      responses: { 200: LsDocumentList },
      errors: [401, 403, 404],
      rateLimit: READ_LIMIT,
      handler: async ({ tx, params }) => {
        const r = await tx.query<DocumentRow>(
          `select ${DOCUMENT_COLUMNS} from servicing.lender_loan_documents($1::uuid) d limit 200`,
          [params.id],
        );
        return { status: 200, body: { items: r.rows.map(mapDocument) } };
      },
    }),
    userRoute({
      method: 'get',
      path: '/v1/lender/loans/:id/documents/:docId/content',
      operationId: 'downloadLenderLoanDocument',
      summary:
        'Retrieve the exact file of a document of a loan of yours (every retrieval is recorded)',
      description:
        'Needs loan.read through a membership of the lender (platform staff cannot open lender-issued content) and the statements_noc switch on. The access is recorded (who, which document, view or download; no content) and the SHA-256 of the stored bytes is compared with the recorded one before they are returned. A document that is not on this loan, or belongs to another lender, answers 404. Without a configured store the answer is 503. Never cached.',
      tags: ['Documents (lender)'],
      auth: 'staff',
      params: LoanDocumentParams,
      query: LsDocumentOpenQuery,
      responses: { 200: LsDocumentContent },
      errors: [401, 403, 404, 409, 503],
      rateLimit: OPEN_LIMIT,
      handler: async ({ tx, params, query }) => {
        const store = requireStore();
        // The document must be on THIS loan and visible to the caller: otherwise nothing is recorded and nothing is opened.
        const doc = await tx.query<{ id: string }>(
          `select d.id from servicing.loan_documents d where d.id = $1::uuid and d.loan_account_id = $2::uuid`,
          [params.docId, params.id],
        );
        if (!doc.rows[0]) throw notFound();
        const opened = await tx.query<{
          r: {
            document_id: string;
            kind: string;
            storage_key: string;
            sha256: string;
            size_bytes: number | string;
            mime_type: string;
            lender_reference: string;
          };
        }>('select servicing.lender_open_loan_document($1::uuid, $2) as r', [
          params.docId,
          query.purpose,
        ]);
        const meta = first(opened.rows);
        const object = await store.get(meta.storage_key);
        if (!object) throw notFound();
        const actual = sha256Hex(object.bytes);
        if (actual !== meta.sha256)
          throw new Error('stored document does not match its recorded checksum');
        return {
          status: 200,
          headers: { 'cache-control': 'no-store' },
          body: {
            documentId: meta.document_id,
            kind: meta.kind,
            mimeType: meta.mime_type,
            sha256: meta.sha256,
            sizeBytes: count(meta.size_bytes),
            lenderReference: meta.lender_reference,
            contentBase64: Buffer.from(object.bytes).toString('base64'),
          },
        };
      },
    }),
    userRoute({
      method: 'get',
      path: '/v1/lender/document-requests',
      operationId: 'listLenderDocumentRequests',
      summary:
        "Borrowers' requests for a statement, quotation, no-dues certificate or closure letter, newest first",
      description:
        'Needs loan.read. The borrower is not named; the loan account is the link. `dueBy` is a PLATFORM default taken from an approved rule (not a regulatory deadline) and is empty when no approved rule resolves. A request is fulfilled by registering the document (or recording the quotation) with `requestId`, or declined with a reason.',
      tags: ['Documents (lender)'],
      auth: 'staff',
      query: LsDocumentRequestListQuery,
      responses: { 200: LsDocumentRequestPage },
      errors: [400, 401, 403, 422],
      rateLimit: READ_LIMIT,
      handler: async ({ tx, query }) => {
        await requireReader(tx, query.lenderId);
        const w = new Where();
        if (query.lenderId) w.add((p) => `q.lender_org_id = ${p}::uuid`, query.lenderId);
        if (query.loanAccountId)
          w.add((p) => `q.loan_account_id = ${p}::uuid`, query.loanAccountId);
        if (query.kind) w.add((p) => `q.kind = ${p}`, query.kind);
        if (query.status) w.add((p) => `q.status = ${p}`, query.status);
        olderThan(w, query.cursor, 'q.requested_at', 'q.id');
        const limit = w.placeholder(query.limit + 1);
        const r = await tx.query<RequestRow>(
          `select ${REQUEST_COLUMNS} from servicing.document_requests q where ${w.sql}
            order by q.requested_at desc, q.id desc limit ${limit}::int`,
          w.values,
        );
        return {
          status: 200,
          body: pageOf(r.rows, query.limit, mapRequest, (row) =>
            encodeCursor({ t: row.requestedAt, id: row.id }),
          ),
        };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/lender/document-requests/:id/decline',
      operationId: 'declineLenderDocumentRequest',
      summary: "Decline a borrower's request with a reason the borrower can read",
      description:
        'Needs servicing.document.issue of the lender, a second factor and the statements_noc switch on. Only an open request can be declined (request_not_open). The note is 10 to 500 characters and must not hold personal data (note_invalid). A request of another lender answers 404.',
      tags: ['Documents (lender)'],
      auth: 'staff',
      idempotent: true,
      params: Id,
      body: LsDocumentRequestDeclineInput,
      responses: { 200: LsDocumentRequestDeclineResult },
      errors: [400, 401, 403, 404, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params, body }) => {
        await tx.query('select servicing.decline_document_request($1::uuid, $2)', [
          params.id,
          body.note,
        ]);
        return { status: 200, body: { id: params.id, status: 'declined' } };
      },
    }),

    // ---- foreclosure quotations -----------------------------------------------------------------------------------
    userRoute({
      method: 'post',
      path: '/v1/lender/loans/:id/foreclosure-quotes',
      operationId: 'recordLenderForeclosureQuote',
      summary: 'Record a foreclosure quotation exactly as your organisation issued it',
      description:
        "Needs servicing.document.issue of the lender, a second factor and the statements_noc switch on. Udofin never computes or adjusts a quotation: the parts and the total are yours, in integer paise. If the parts do not add up to the total the quotation is STORED and FLAGGED (`totalMismatch: true`), never corrected, and must not be paid until you re-quote. The same reference with the same figures returns the same quotation (`existing`); the same reference with other figures is quote_ref_reused. `validUntil` must be after `asOf`. With `requestId` the borrower's open quotation request is fulfilled; `letterDocumentId` links a foreclosure_quote document of this loan.",
      tags: ['Quotations (lender)'],
      auth: 'staff',
      idempotent: true,
      params: Id,
      body: LsQuoteInput,
      responses: { 200: LsQuoteResult, 201: LsQuoteResult },
      errors: [400, 401, 403, 404, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params, body }) => {
        const earlier = await tx.query<{ id: string }>(
          `select q.id from servicing.foreclosure_quotes q
            where q.loan_account_id = $1::uuid and q.lender_quote_ref = $2`,
          [params.id, body.lenderQuoteRef],
        );
        const r = await tx.query<{ r: string }>(
          `select servicing.record_foreclosure_quote($1::uuid, $2, $3::timestamptz, $4::timestamptz, $5, $6, $7, $8, $9,
                                                     'lender_portal', $10::uuid, $11::uuid) as r`,
          [
            params.id,
            body.lenderQuoteRef,
            body.asOf,
            body.validUntil,
            formatMoneyMinor(BigInt(body.principalMinor)),
            formatMoneyMinor(BigInt(body.interestMinor)),
            formatMoneyMinor(BigInt(body.chargesMinor)),
            formatMoneyMinor(BigInt(body.prepaymentChargeMinor)),
            formatMoneyMinor(BigInt(body.totalMinor)),
            body.requestId ?? null,
            body.letterDocumentId ?? null,
          ],
        );
        const id = first(r.rows);
        const quote = await tx.query<QuoteRow>(
          `select ${QUOTE_COLUMNS} from servicing.foreclosure_quotes q where q.id = $1::uuid`,
          [id],
        );
        const row = quote.rows[0];
        if (!row) throw notFound();
        const existing = earlier.rows.length > 0;
        return { status: existing ? 200 : 201, body: { quote: mapQuote(row), existing } };
      },
    }),
    userRoute({
      method: 'get',
      path: '/v1/lender/loans/:id/foreclosure-quotes',
      operationId: 'listLenderForeclosureQuotes',
      summary: 'Quotations recorded for a loan, newest first',
      description:
        "Needs loan.read; a loan of another lender answers 404. `totalMismatch` is true when the lender's parts do not add up to the lender's total: such a quotation must not be paid.",
      tags: ['Quotations (lender)'],
      auth: 'staff',
      params: Id,
      query: LsQuoteListQuery,
      responses: { 200: LsQuotePage },
      errors: [400, 401, 403, 404, 422],
      rateLimit: READ_LIMIT,
      handler: async ({ tx, params, query }) => {
        await requireReader(tx, undefined);
        const loan = await tx.query<{ id: string }>(
          'select la.id from servicing.loan_accounts la where la.id = $1::uuid',
          [params.id],
        );
        if (!loan.rows[0]) throw notFound();
        const w = new Where();
        w.add((p) => `q.loan_account_id = ${p}::uuid`, params.id);
        olderThan(w, query.cursor, 'q.reported_at', 'q.id');
        const limit = w.placeholder(query.limit + 1);
        const r = await tx.query<QuoteRow>(
          `select ${QUOTE_COLUMNS} from servicing.foreclosure_quotes q where ${w.sql}
            order by q.reported_at desc, q.id desc limit ${limit}::int`,
          w.values,
        );
        return {
          status: 200,
          body: pageOf(r.rows, query.limit, mapQuote, (row) =>
            encodeCursor({ t: row.reportedAt, id: row.id }),
          ),
        };
      },
    }),

    // ---- closure and security release -----------------------------------------------------------------------------
    userRoute({
      method: 'get',
      path: '/v1/lender/closures',
      operationId: 'listLenderClosures',
      summary:
        'Loans your system reported closed or foreclosed, with the no-dues status and the security-release tasks',
      description:
        "Needs loan.read. A closure record opens once per loan when the lender's report moves it to closed or foreclosed. `closedAt` is when Udofin recorded the report, not the lender's closure date. `nocDueBy` and a task's `dueBy` come from approved rules (a platform default for the no-dues certificate, not a regulatory deadline) and are empty when no approved rule resolves. Udofin holds no collateral and never confirms a release: a task is confirmed only by a lender user.",
      tags: ['Closure (lender)'],
      auth: 'staff',
      query: LsClosureListQuery,
      responses: { 200: LsClosurePage },
      errors: [400, 401, 403, 422],
      rateLimit: READ_LIMIT,
      handler: async ({ tx, query }) => {
        await requireReader(tx, query.lenderId);
        const w = new Where();
        if (query.lenderId) w.add((p) => `c.lender_org_id = ${p}::uuid`, query.lenderId);
        olderThan(w, query.cursor, 'c.closed_at', 'c.id');
        const limit = w.placeholder(query.limit + 1);
        const closures = await tx.query<ClosureRow>(
          `select ${CLOSURE_COLUMNS} from servicing.closure_records c where ${w.sql}
            order by c.closed_at desc, c.id desc limit ${limit}::int`,
          w.values,
        );
        const kept = closures.rows.slice(0, query.limit);
        const tasks = await tx.query<TaskRow>(
          `select ${TASK_COLUMNS} from servicing.security_release_tasks t
            where t.closure_id = any($1::uuid[]) order by t.created_at, t.id`,
          [kept.map((c) => c.id)],
        );
        return {
          status: 200,
          body: pageOf(
            closures.rows,
            query.limit,
            (c) => ({
              id: c.id,
              lenderId: c.lenderId,
              loanAccountId: c.loanAccountId,
              closureKind: c.closureKind,
              closedAt: c.closedAt,
              nocDueBy: c.nocDueBy,
              nocDocumentId: c.nocDocumentId,
              nocIssuedAt: c.nocIssuedAt,
              tasks: tasks.rows.filter((t) => t.closureId === c.id).map(mapTask),
            }),
            (c) => encodeCursor({ t: c.closedAt, id: c.id }),
          ),
        };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/lender/loans/:id/security-release-tasks',
      operationId: 'openLenderSecurityReleaseTasks',
      summary:
        'Record the collateral your organisation holds on a closed loan, so each release can be tracked',
      description:
        "Needs servicing.document.issue of the lender, a second factor and the statements_noc switch on. The collateral types are the lender's own report (1 to 5 distinct values); the loan must already be reported closed or foreclosed (loan_not_closed). Idempotent per loan and type; the answer counts the tasks created now. Udofin holds no collateral and has no depository access: the lender releases it and confirms.",
      tags: ['Closure (lender)'],
      auth: 'staff',
      idempotent: true,
      params: Id,
      body: LsSecurityReleaseOpenInput,
      responses: { 200: LsSecurityReleaseOpenResult },
      errors: [400, 401, 403, 404, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params, body }) => {
        const r = await tx.query<{ r: number }>(
          'select servicing.open_security_release_tasks($1::uuid, $2::text[]) as r',
          [params.id, body.collateralTypes],
        );
        return { status: 200, body: { created: count(first(r.rows)) } };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/lender/security-release/:taskId/confirm',
      operationId: 'confirmLenderSecurityRelease',
      summary:
        'Confirm that your organisation released the security, with your own confirmation reference',
      description:
        "Needs servicing.document.issue of the lender, a second factor and the statements_noc switch on. Only a lender user can confirm (the database refuses the system role and platform staff). The reference is the lender's own (3 to 100 characters of letters, digits and . _ / -; confirmation_ref_invalid otherwise). An already confirmed task answers already_confirmed. A task of another lender answers 404.",
      tags: ['Closure (lender)'],
      auth: 'staff',
      idempotent: true,
      params: TaskId,
      body: LsSecurityReleaseConfirmInput,
      responses: { 200: LsSecurityReleaseActionResult },
      errors: [400, 401, 403, 404, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params, body }) => {
        await tx.query('select servicing.confirm_security_release($1::uuid, $2)', [
          params.taskId,
          body.confirmationRef,
        ]);
        return { status: 200, body: { id: params.taskId, outcome: 'confirmed_by_lender' } };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/lender/security-release/:taskId/delay-reason',
      operationId: 'setLenderSecurityReleaseDelayReason',
      summary: 'Record why a release is late (your own words, shown to the borrower)',
      description:
        'Needs servicing.document.issue of the lender, a second factor and the statements_noc switch on. The reason is 10 to 500 characters and must not hold personal data (reason_invalid); it can be replaced while the task is open and cannot be set on a confirmed task (already_confirmed). A task of another lender answers 404.',
      tags: ['Closure (lender)'],
      auth: 'staff',
      idempotent: true,
      params: TaskId,
      body: LsSecurityReleaseDelayInput,
      responses: { 200: LsSecurityReleaseActionResult },
      errors: [400, 401, 403, 404, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params, body }) => {
        await tx.query('select servicing.set_security_release_delay_reason($1::uuid, $2)', [
          params.taskId,
          body.reason,
        ]);
        return { status: 200, body: { id: params.taskId, outcome: 'recorded' } };
      },
    }),
  ];
}
