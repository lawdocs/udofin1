import { createHash } from 'node:crypto';
import { parseMoneyMinor } from './money.js';
import {
  assertLocalOrTestOnly,
  type AppEnvironment,
  type ProviderCallContext,
  type ProviderDescriptor,
} from './provider.js';

/**
 * Port between Udofin and a lender's own loan management system (LMS), plus the pure file-import normaliser.
 *
 * The lender's LMS is the system of record (ADR 0007). Everything here is READ-ONLY: there is no method that posts a
 * receipt, changes a schedule or closes a loan, and Udofin never computes a balance, interest, penal charge or
 * foreclosure amount. A report is stored exactly as the lender stated it, with where it came from (sourceSystem,
 * sourceRecordId), when the lender said it was true (reportedAt) and a content hash. A timeout is `unknown`, never an
 * empty report. No real LMS connector exists (lender API specification and callback scheme are open, D-43/D-64); the
 * only producers of these reports today are the labelled mock below and the file/manual import.
 *
 * ---------------------------------------------------------------------------------------------------------
 * IMPORT FILE FORMAT v1 (`udofin-lms-import-v1`)
 * ---------------------------------------------------------------------------------------------------------
 * Three record kinds, one kind per file. CSV has a header row; JSON carries the same field names. Text encoding is
 * UTF-8 (a leading BOM is ignored). Nothing is trimmed, rounded, guessed or "fixed": a cell is accepted exactly or
 * the row is rejected with an error CLASS (never the cell content). Cells that look like spreadsheet formulas
 * ("=", "+", "-", "@") are plain text: they are never interpreted, and because no field accepts such characters at
 * its start they are rejected as invalid references or amounts.
 *
 * Common to every kind
 *   source_record_id  required  the lender's own id for this record (reference charset below)
 *   reported_as_of    required  ISO-8601 timestamp WITH zone ("2026-10-13T06:00:00Z", "...+05:30"): when the lender
 *                               says the figures were true. Normalised to UTC. Not more than 15 minutes in the future.
 *   sequence          optional  non-negative integer, the lender's monotonic sequence for this loan, if it has one
 *
 * kind = loan (one row per report)
 *   lms_loan_ref          required  lender's loan reference
 *   borrower_ref          required  an OPAQUE reference as supplied: Udofin application reference or lender customer
 *                                   reference. Never a name, phone number, PAN or Aadhaar number: values that look
 *                                   like one are rejected (`borrower_ref_looks_personal`)
 *   status                required  active | closed | foreclosed | written_off | cancelled
 *   sanctioned_amount     required  decimal rupees, > 0
 *   disbursed_amount, disbursement_ref, disbursement_date (YYYY-MM-DD)
 *                         optional, but all three together or none; disbursed_amount <= sanctioned_amount
 *   outstanding_principal optional  decimal rupees
 *   next_due_date (YYYY-MM-DD), next_due_amount  optional, both or neither
 *   overdue_principal, overdue_interest, penal_charges, other_charges, total_overdue  optional decimal rupees,
 *                         exactly as the lender reports them. If all five are present and the four parts do not add
 *                         up to the total, the report is still accepted and carries the flag `overdue_total_mismatch`
 *                         (flag, never fix).
 *   days_past_due         optional  non-negative integer AS REPORTED by the lender (Udofin never computes it)
 *
 * kind = receipt (one row per receipt or reversal)
 *   lms_loan_ref, lms_receipt_ref (the lender's id of THIS row), receipt_kind (receipt | reversal),
 *   reverses_receipt_ref (required for a reversal, forbidden for a receipt), amount (> 0, positive also for
 *   reversals), value_date (YYYY-MM-DD), payment_mode (optional, reference charset), bank_reference (optional, e.g. UTR)
 *
 * kind = schedule (one report = one source_record_id per loan)
 *   lms_loan_ref + the common fields, and installments: JSON carries an `installments` array of
 *   { installment_seq, due_date, principal, interest, fees? }; CSV carries one row per installment repeating the
 *   head fields (lms_loan_ref, source_record_id, reported_as_of, sequence), which must agree within a report.
 *   installment_seq runs 1..n without gaps or repeats; due dates strictly increase; amounts are decimal rupees >= 0.
 *
 * JSON top level: an array of records, or { "format_version": "udofin-lms-import-v1", "records": [...] }. Money is
 * always a JSON STRING (a JSON number is rejected, because floats are never money).
 *
 * File limits (override per call): 5 MiB, 10 000 records. Duplicates inside a file: the same key twice with identical
 * content keeps the first and reports the rest as `duplicate_row`; the same key with different content rejects ALL
 * occurrences as `conflicting_duplicate`. Nothing about a file ever reaches the network.
 */

export const LMS_IMPORT_FORMAT = 'udofin-lms-import-v1';

/** Lender-reported loan states (same vocabulary as servicing.loan_status). Anything else is rejected, never mapped. */
export const LMS_LOAN_STATUSES = [
  'active',
  'closed',
  'foreclosed',
  'written_off',
  'cancelled',
] as const;
export type LmsLoanStatus = (typeof LMS_LOAN_STATUSES)[number];

// ---------------------------------------------------------------------------------------------------------
// Normalised reports
// ---------------------------------------------------------------------------------------------------------

/** Provenance carried by every report. Nothing is ever stored without it. */
export interface LmsReportMeta {
  /** Where this came from, e.g. `mock_lms`, `file_import`, `manual_import`, or a lender system key. */
  readonly sourceSystem: string;
  /** The lender's own id for the record. */
  readonly sourceRecordId: string;
  /** When the lender says this was true (UTC, ISO-8601 with milliseconds). Not our receipt time. */
  readonly reportedAt: string;
  /** The lender's monotonic sequence for the loan, if it supplies one. */
  readonly sequence: number | null;
  /** SHA-256 (hex) of the canonical encoding of the report's fields (see `lmsReportHash`); excludes sourceSystem. */
  readonly contentSha256: string;
}

export interface LmsLoanReport extends LmsReportMeta {
  readonly reportType: 'loan';
  readonly lmsLoanRef: string;
  /** Opaque: Udofin application reference or lender customer reference. Never personal data. */
  readonly borrowerRef: string;
  readonly status: LmsLoanStatus;
  readonly sanctionedMinor: bigint;
  readonly disbursedMinor: bigint | null;
  readonly disbursementRef: string | null;
  readonly disbursedOn: string | null;
  readonly outstandingPrincipalMinor: bigint | null;
  readonly nextDueOn: string | null;
  readonly nextDueMinor: bigint | null;
  readonly overduePrincipalMinor: bigint | null;
  readonly overdueInterestMinor: bigint | null;
  readonly penalChargesMinor: bigint | null;
  readonly otherChargesMinor: bigint | null;
  readonly totalOverdueMinor: bigint | null;
  /** As reported by the lender. Never computed by Udofin. */
  readonly daysPastDue: number | null;
  /** Anomalies noticed in the report itself (flag, never fix). Currently: `overdue_total_mismatch`. */
  readonly flags: readonly 'overdue_total_mismatch'[];
}

export interface LmsScheduleInstallment {
  readonly sequence: number;
  readonly dueOn: string;
  readonly principalMinor: bigint;
  readonly interestMinor: bigint;
  readonly feesMinor: bigint;
}

export interface LmsScheduleReport extends LmsReportMeta {
  readonly reportType: 'schedule';
  readonly lmsLoanRef: string;
  readonly installments: readonly LmsScheduleInstallment[];
}

export interface LmsReceiptReport extends LmsReportMeta {
  readonly reportType: 'receipt';
  readonly receiptKind: 'receipt' | 'reversal';
  readonly lmsLoanRef: string;
  /** The lender's id of this row (unique per lender). */
  readonly lmsReceiptRef: string;
  /** For a reversal, the lender receipt it reverses. */
  readonly reversesReceiptRef: string | null;
  /** Always positive; a reversal is a separate row, not a negative amount. */
  readonly amountMinor: bigint;
  readonly valueDate: string;
  readonly paymentMode: string | null;
  /** Bank reference such as a UTR, as the lender recorded it. */
  readonly bankReference: string | null;
}

export interface LmsQuoteComponent {
  /** The lender's own label, e.g. `outstanding_principal`, `prepayment_charge`. Udofin neither maps nor adds them. */
  readonly kind: string;
  readonly amountMinor: bigint;
}

/** A foreclosure (or cooling-off exit) quote exactly as the lender issued it. */
export interface LmsQuote extends LmsReportMeta {
  readonly reportType: 'quote';
  readonly lmsLoanRef: string;
  readonly lenderQuoteRef: string;
  readonly amountMinor: bigint;
  readonly components: readonly LmsQuoteComponent[];
  /** The date the quote is for (YYYY-MM-DD). */
  readonly asOfDate: string;
  /** After this instant the quote is dead (UTC ISO-8601). */
  readonly validUntil: string;
}

/** A lender-issued document (statement, no-dues certificate, closure letter). Bytes are fetched elsewhere. */
export interface LmsDocumentRef extends LmsReportMeta {
  readonly reportType: 'document';
  readonly lmsLoanRef: string;
  readonly documentKind: 'statement' | 'no_dues_certificate' | 'closure_letter';
  readonly lenderDocumentRef: string;
  readonly mediaType: 'application/pdf';
  /** SHA-256 (hex) of the document bytes as the lender states it; verified again when the bytes are read. */
  readonly documentSha256: string;
  readonly periodFrom: string | null;
  readonly periodTo: string | null;
}

export interface LmsChange {
  readonly lmsLoanRef: string;
  readonly sourceRecordId: string;
  readonly reportedAt: string;
}

export interface LmsChangePage {
  readonly changes: readonly LmsChange[];
  /** Pass back to continue. Null when the lender gave no cursor. */
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

export interface LmsReceiptPage {
  readonly receipts: readonly LmsReceiptReport[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

/**
 * Every outcome is explicit. `unknown` means the lender may or may not have answered: the caller keeps its cursor
 * and tries again later; it must never be treated as "no changes" or as an empty report.
 */
export type LmsResult<T> =
  | { readonly outcome: 'ok'; readonly value: T }
  | {
      readonly outcome: 'unknown';
      readonly reason: 'timeout' | 'network' | 'provider_error';
    }
  | { readonly outcome: 'not_found' }
  | { readonly outcome: 'invalid'; readonly reason: 'malformed_report' }
  | { readonly outcome: 'unsupported' }
  | { readonly outcome: 'not_configured' };

export interface LmsCapabilities {
  readonly pull: boolean;
  readonly push: boolean;
  readonly foreclosureQuote: boolean;
  readonly statement: boolean;
  readonly closureDocuments: boolean;
  readonly receipts: boolean;
}

/** Spec 08 section 6.1. No write methods exist or may be added. */
export interface LmsPort {
  readonly descriptor: ProviderDescriptor;
  readonly capabilities: LmsCapabilities;
  listChanges(ctx: ProviderCallContext, cursor: string | null): Promise<LmsResult<LmsChangePage>>;
  fetchLoan(ctx: ProviderCallContext, lmsLoanRef: string): Promise<LmsResult<LmsLoanReport>>;
  fetchSchedule(
    ctx: ProviderCallContext,
    lmsLoanRef: string,
  ): Promise<LmsResult<LmsScheduleReport>>;
  fetchReceipts(
    ctx: ProviderCallContext,
    lmsLoanRef: string,
    sinceCursor: string | null,
  ): Promise<LmsResult<LmsReceiptPage>>;
  requestForeclosureQuote(
    ctx: ProviderCallContext,
    lmsLoanRef: string,
    asOfDate: string,
  ): Promise<LmsResult<LmsQuote>>;
  fetchStatement(
    ctx: ProviderCallContext,
    lmsLoanRef: string,
    period: { readonly from: string; readonly to: string },
  ): Promise<LmsResult<LmsDocumentRef>>;
  fetchClosureDocuments(
    ctx: ProviderCallContext,
    lmsLoanRef: string,
  ): Promise<LmsResult<readonly LmsDocumentRef[]>>;
}

/** No LMS connector exists for this lender: refuses honestly instead of pretending. */
export function createUnconfiguredLmsPort(): LmsPort {
  const notConfigured = (): Promise<{ readonly outcome: 'not_configured' }> =>
    Promise.resolve({ outcome: 'not_configured' as const });
  return {
    descriptor: { key: 'lms_not_configured', capability: 'lms', mode: 'production' },
    capabilities: {
      pull: false,
      push: false,
      foreclosureQuote: false,
      statement: false,
      closureDocuments: false,
      receipts: false,
    },
    listChanges: notConfigured,
    fetchLoan: notConfigured,
    fetchSchedule: notConfigured,
    fetchReceipts: notConfigured,
    requestForeclosureQuote: notConfigured,
    fetchStatement: notConfigured,
    fetchClosureDocuments: notConfigured,
  };
}

/** Bounds every call; a slow or failing lender becomes `unknown`, never a hung job and never an empty report. */
export function withLmsTimeout(inner: LmsPort, milliseconds: number): LmsPort {
  const bound = async <T>(call: () => Promise<LmsResult<T>>): Promise<LmsResult<T>> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<LmsResult<T>>((resolve) => {
      timer = setTimeout(() => resolve({ outcome: 'unknown', reason: 'timeout' }), milliseconds);
    });
    try {
      return await Promise.race([
        call().catch((): LmsResult<T> => ({ outcome: 'unknown', reason: 'network' })),
        timeout,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  return {
    descriptor: inner.descriptor,
    capabilities: inner.capabilities,
    listChanges: (ctx, cursor) => bound(() => inner.listChanges(ctx, cursor)),
    fetchLoan: (ctx, ref) => bound(() => inner.fetchLoan(ctx, ref)),
    fetchSchedule: (ctx, ref) => bound(() => inner.fetchSchedule(ctx, ref)),
    fetchReceipts: (ctx, ref, since) => bound(() => inner.fetchReceipts(ctx, ref, since)),
    requestForeclosureQuote: (ctx, ref, asOf) =>
      bound(() => inner.requestForeclosureQuote(ctx, ref, asOf)),
    fetchStatement: (ctx, ref, period) => bound(() => inner.fetchStatement(ctx, ref, period)),
    fetchClosureDocuments: (ctx, ref) => bound(() => inner.fetchClosureDocuments(ctx, ref)),
  };
}

// ---------------------------------------------------------------------------------------------------------
// Field validation shared by the file importer and every adapter
// ---------------------------------------------------------------------------------------------------------

export type LmsImportErrorCode =
  | 'file_too_large'
  | 'too_many_rows'
  | 'empty_file'
  | 'malformed_file'
  | 'unknown_column'
  | 'missing_column'
  | 'duplicate_column'
  | 'column_count_mismatch'
  | 'unknown_field'
  | 'missing_required'
  | 'invalid_reference'
  | 'borrower_ref_looks_personal'
  | 'invalid_amount'
  | 'amount_not_positive'
  | 'invalid_date'
  | 'invalid_timestamp'
  | 'timestamp_in_future'
  | 'invalid_integer'
  | 'invalid_status'
  | 'invalid_receipt_kind'
  | 'incomplete_disbursement'
  | 'incomplete_next_due'
  | 'disbursed_exceeds_sanctioned'
  | 'reversal_reference_invalid'
  | 'invalid_items'
  | 'inconsistent_report_head'
  | 'invalid_validity'
  | 'duplicate_row'
  | 'conflicting_duplicate';

/** A row-level problem. Carries the position and a class, NEVER the offending value. */
export interface LmsImportError {
  /** 1-based data row (CSV) or record index (JSON). 0 for file-level problems. */
  readonly rowNumber: number;
  readonly field: string | null;
  readonly code: LmsImportErrorCode;
  /** For schedule installments: 0-based position inside the record. */
  readonly itemIndex?: number;
}

const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;
const PAN_LIKE = /^[A-Za-z]{5}[0-9]{4}[A-Za-z]$/;
const PHONE_OR_AADHAAR_LIKE = /^\+?[0-9]{10,13}$/;
const SOURCE_SYSTEM = /^[a-z][a-z0-9_]{1,49}$/;
const ISO_DATE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;
const ISO_TIMESTAMP =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,3})?(?:Z|[+-][0-9]{2}:[0-9]{2})$/;
const SMALL_INTEGER = /^[0-9]{1,9}$/;
const MAX_FUTURE_SKEW_MS = 15 * 60 * 1000;
const MAX_INSTALLMENTS = 600;

/** True for a real calendar date written YYYY-MM-DD (years 2000-2100). */
export function isValidIsoDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const [, y = '', m = '', d = ''] = match;
  const year = parseInt(y, 10);
  const month = parseInt(m, 10);
  const day = parseInt(d, 10);
  if (year < 2000 || year > 2100) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/** Parses an ISO-8601 timestamp WITH a zone into canonical UTC (`...T..:..:..sssZ`), or null. */
export function normaliseTimestamp(value: string): string | null {
  if (!ISO_TIMESTAMP.test(value)) return null;
  if (!isValidIsoDate(value.slice(0, 10))) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

type Raw = Readonly<Record<string, unknown>>;

class FieldReader {
  readonly errors: LmsImportError[] = [];
  constructor(
    private readonly raw: Raw,
    private readonly rowNumber: number,
    private readonly itemIndex?: number,
  ) {}

  /** Records an error and returns undefined so callers can `return r.fail(...)`. */
  fail(field: string | null, code: LmsImportErrorCode): undefined {
    const base = { rowNumber: this.rowNumber, field, code };
    this.errors.push(this.itemIndex === undefined ? base : { ...base, itemIndex: this.itemIndex });
    return undefined;
  }

  /** Rejects any key the format does not define. */
  allow(fields: readonly string[]): void {
    const allowed = new Set(fields);
    for (const key of Object.keys(this.raw)) if (!allowed.has(key)) this.fail(key, 'unknown_field');
  }

  /** The raw cell: undefined when absent, null or the empty string. */
  private cell(name: string): unknown {
    if (!Object.hasOwn(this.raw, name)) return undefined;
    const value = this.raw[name];
    return value === null || value === '' ? undefined : value;
  }

  // Conventions: `undefined` = this field failed (an error was recorded); `null` = optional field absent.

  reference(name: string): string | undefined {
    const value = this.cell(name);
    if (value === undefined) return this.fail(name, 'missing_required');
    if (typeof value !== 'string' || !REFERENCE.test(value))
      return this.fail(name, 'invalid_reference');
    return value;
  }

  optionalReference(name: string): string | null | undefined {
    return this.cell(name) === undefined ? null : this.reference(name);
  }

  /** A reference that must never be a name, phone number, PAN or Aadhaar number. */
  opaqueReference(name: string): string | undefined {
    const value = this.cell(name);
    if (typeof value === 'string' && (PAN_LIKE.test(value) || PHONE_OR_AADHAAR_LIKE.test(value))) {
      return this.fail(name, 'borrower_ref_looks_personal');
    }
    return this.reference(name);
  }

  money(name: string, positive = false): bigint | undefined {
    const value = this.cell(name);
    if (value === undefined) return this.fail(name, 'missing_required');
    let minor: bigint;
    try {
      minor = parseMoneyMinor(value);
    } catch {
      return this.fail(name, 'invalid_amount');
    }
    if (positive && minor <= 0n) return this.fail(name, 'amount_not_positive');
    return minor;
  }

  optionalMoney(name: string, positive = false): bigint | null | undefined {
    return this.cell(name) === undefined ? null : this.money(name, positive);
  }

  date(name: string): string | undefined {
    const value = this.cell(name);
    if (value === undefined) return this.fail(name, 'missing_required');
    if (typeof value !== 'string' || !isValidIsoDate(value)) return this.fail(name, 'invalid_date');
    return value;
  }

  optionalDate(name: string): string | null | undefined {
    return this.cell(name) === undefined ? null : this.date(name);
  }

  timestamp(name: string, now: Date): string | undefined {
    const value = this.cell(name);
    if (value === undefined) return this.fail(name, 'missing_required');
    const normalised = typeof value === 'string' ? normaliseTimestamp(value) : null;
    if (normalised === null) return this.fail(name, 'invalid_timestamp');
    if (Date.parse(normalised) > now.getTime() + MAX_FUTURE_SKEW_MS) {
      return this.fail(name, 'timestamp_in_future');
    }
    return normalised;
  }

  /** Non-negative integer, as a CSV/JSON string or a JSON integer. */
  integer(name: string, max = 999_999_999): number | undefined {
    const value = this.cell(name);
    if (value === undefined) return this.fail(name, 'missing_required');
    let parsed: number | undefined;
    if (typeof value === 'string' && SMALL_INTEGER.test(value)) parsed = parseInt(value, 10);
    else if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) parsed = value;
    if (parsed === undefined || parsed > max) return this.fail(name, 'invalid_integer');
    return parsed;
  }

  optionalInteger(name: string, max = 999_999_999): number | null | undefined {
    return this.cell(name) === undefined ? null : this.integer(name, max);
  }

  enumeration<T extends string>(
    name: string,
    allowed: readonly T[],
    code: LmsImportErrorCode,
  ): T | undefined {
    const value = this.cell(name);
    if (value === undefined) return this.fail(name, 'missing_required');
    const match = allowed.find((candidate) => candidate === value);
    return match === undefined ? this.fail(name, code) : match;
  }

  objectArray(name: string): readonly Raw[] | undefined {
    const value = this.cell(name);
    if (value === undefined) return this.fail(name, 'missing_required');
    if (
      !Array.isArray(value) ||
      value.length === 0 ||
      value.length > MAX_INSTALLMENTS ||
      value.some((item) => typeof item !== 'object' || item === null || Array.isArray(item))
    ) {
      return this.fail(name, 'invalid_items');
    }
    return value as readonly Raw[];
  }
}

type HashValue = string | number | bigint | boolean | null;

/**
 * Canonical content hash: SHA-256 over the JSON of `["udofin-lms-<type>-v1", [key, value], ...]` in the fixed key
 * order each normaliser uses. bigint is written as a decimal string, absent values as null. It INCLUDES the lender's
 * reportedAt, sequence and sourceRecordId (an unchanged balance reported later is a new fact: it refreshes
 * staleness), and EXCLUDES sourceSystem (the same facts via a different channel hash the same).
 */
export function lmsReportHash(
  reportType: string,
  fields: readonly (readonly [string, HashValue])[],
): string {
  const canonical = JSON.stringify([
    `udofin-lms-${reportType}-v1`,
    ...fields.map(([key, value]) => [key, typeof value === 'bigint' ? value.toString() : value]),
  ]);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------------------------------------
// Normalisers (wire record -> normalised report). The mock, the import file and a future real connector all use these.
// ---------------------------------------------------------------------------------------------------------

export type NormaliseResult<T> =
  | { readonly ok: true; readonly report: T }
  | { readonly ok: false; readonly errors: readonly LmsImportError[] };

export interface NormaliseOptions {
  /** e.g. `file_import`, `manual_import`, `mock_lms`. */
  readonly sourceSystem: string;
  /** Used only to refuse timestamps from the future. */
  readonly now?: Date;
  /** Position used in error rows. */
  readonly rowNumber?: number;
}

const COMMON_FIELDS = ['source_record_id', 'reported_as_of', 'sequence'] as const;
export const LMS_LOAN_FIELDS = [
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
  ...COMMON_FIELDS,
] as const;
export const LMS_LOAN_REQUIRED = [
  'lms_loan_ref',
  'borrower_ref',
  'status',
  'sanctioned_amount',
  'source_record_id',
  'reported_as_of',
] as const;
export const LMS_RECEIPT_FIELDS = [
  'lms_loan_ref',
  'lms_receipt_ref',
  'receipt_kind',
  'reverses_receipt_ref',
  'amount',
  'value_date',
  'payment_mode',
  'bank_reference',
  ...COMMON_FIELDS,
] as const;
export const LMS_RECEIPT_REQUIRED = [
  'lms_loan_ref',
  'lms_receipt_ref',
  'receipt_kind',
  'amount',
  'value_date',
  'source_record_id',
  'reported_as_of',
] as const;
export const LMS_SCHEDULE_HEAD_FIELDS = ['lms_loan_ref', ...COMMON_FIELDS] as const;
export const LMS_SCHEDULE_INSTALLMENT_FIELDS = [
  'installment_seq',
  'due_date',
  'principal',
  'interest',
  'fees',
] as const;
const QUOTE_FIELDS = [
  'lms_loan_ref',
  'lender_quote_ref',
  'as_of_date',
  'valid_until',
  'amount',
  'components',
  ...COMMON_FIELDS,
] as const;

function checkSource(options: NormaliseOptions): void {
  if (!SOURCE_SYSTEM.test(options.sourceSystem)) {
    throw new Error('invalid source system key');
  }
}

export function normaliseLmsLoan(
  raw: Raw,
  options: NormaliseOptions,
): NormaliseResult<LmsLoanReport> {
  checkSource(options);
  const r = new FieldReader(raw, options.rowNumber ?? 1);
  const now = options.now ?? new Date();
  r.allow(LMS_LOAN_FIELDS);
  const lmsLoanRef = r.reference('lms_loan_ref');
  const borrowerRef = r.opaqueReference('borrower_ref');
  const status = r.enumeration('status', LMS_LOAN_STATUSES, 'invalid_status');
  const sanctioned = r.money('sanctioned_amount', true);
  const disbursed = r.optionalMoney('disbursed_amount', true);
  const disbursementRef = r.optionalReference('disbursement_ref');
  const disbursedOn = r.optionalDate('disbursement_date');
  const outstanding = r.optionalMoney('outstanding_principal');
  const nextDueOn = r.optionalDate('next_due_date');
  const nextDue = r.optionalMoney('next_due_amount');
  const overduePrincipal = r.optionalMoney('overdue_principal');
  const overdueInterest = r.optionalMoney('overdue_interest');
  const penal = r.optionalMoney('penal_charges');
  const other = r.optionalMoney('other_charges');
  const totalOverdue = r.optionalMoney('total_overdue');
  const dpd = r.optionalInteger('days_past_due', 99_999);
  const sourceRecordId = r.reference('source_record_id');
  const reportedAt = r.timestamp('reported_as_of', now);
  const sequence = r.optionalInteger('sequence');

  if (r.errors.length === 0) {
    const evidence = [disbursed, disbursementRef, disbursedOn].filter((v) => v !== null).length;
    if (evidence !== 0 && evidence !== 3) r.fail('disbursed_amount', 'incomplete_disbursement');
    if ((nextDueOn === null) !== (nextDue === null)) r.fail('next_due_date', 'incomplete_next_due');
    if (typeof disbursed === 'bigint' && typeof sanctioned === 'bigint' && disbursed > sanctioned) {
      r.fail('disbursed_amount', 'disbursed_exceeds_sanctioned');
    }
  }
  if (
    r.errors.length > 0 ||
    lmsLoanRef === undefined ||
    borrowerRef === undefined ||
    status === undefined ||
    sanctioned === undefined ||
    sourceRecordId === undefined ||
    reportedAt === undefined ||
    disbursed === undefined ||
    disbursementRef === undefined ||
    disbursedOn === undefined ||
    outstanding === undefined ||
    nextDueOn === undefined ||
    nextDue === undefined ||
    overduePrincipal === undefined ||
    overdueInterest === undefined ||
    penal === undefined ||
    other === undefined ||
    totalOverdue === undefined ||
    dpd === undefined ||
    sequence === undefined
  ) {
    return { ok: false, errors: r.errors };
  }
  // Flag, never fix: if the lender's parts do not add up to the lender's total, store both as reported and say so.
  const flags: 'overdue_total_mismatch'[] = [];
  if (
    overduePrincipal !== null &&
    overdueInterest !== null &&
    penal !== null &&
    other !== null &&
    totalOverdue !== null &&
    overduePrincipal + overdueInterest + penal + other !== totalOverdue
  ) {
    flags.push('overdue_total_mismatch');
  }
  return {
    ok: true,
    report: {
      reportType: 'loan',
      sourceSystem: options.sourceSystem,
      sourceRecordId,
      reportedAt,
      sequence,
      contentSha256: lmsReportHash('loan', [
        ['lms_loan_ref', lmsLoanRef],
        ['borrower_ref', borrowerRef],
        ['status', status],
        ['sanctioned', sanctioned],
        ['disbursed', disbursed],
        ['disbursement_ref', disbursementRef],
        ['disbursed_on', disbursedOn],
        ['outstanding_principal', outstanding],
        ['next_due_on', nextDueOn],
        ['next_due', nextDue],
        ['overdue_principal', overduePrincipal],
        ['overdue_interest', overdueInterest],
        ['penal_charges', penal],
        ['other_charges', other],
        ['total_overdue', totalOverdue],
        ['days_past_due', dpd],
        ['source_record_id', sourceRecordId],
        ['reported_at', reportedAt],
        ['sequence', sequence],
      ]),
      lmsLoanRef,
      borrowerRef,
      status,
      sanctionedMinor: sanctioned,
      disbursedMinor: disbursed,
      disbursementRef,
      disbursedOn,
      outstandingPrincipalMinor: outstanding,
      nextDueOn,
      nextDueMinor: nextDue,
      overduePrincipalMinor: overduePrincipal,
      overdueInterestMinor: overdueInterest,
      penalChargesMinor: penal,
      otherChargesMinor: other,
      totalOverdueMinor: totalOverdue,
      daysPastDue: dpd,
      flags,
    },
  };
}

export function normaliseLmsReceipt(
  raw: Raw,
  options: NormaliseOptions,
): NormaliseResult<LmsReceiptReport> {
  checkSource(options);
  const r = new FieldReader(raw, options.rowNumber ?? 1);
  const now = options.now ?? new Date();
  r.allow(LMS_RECEIPT_FIELDS);
  const lmsLoanRef = r.reference('lms_loan_ref');
  const lmsReceiptRef = r.reference('lms_receipt_ref');
  const receiptKind = r.enumeration(
    'receipt_kind',
    ['receipt', 'reversal'],
    'invalid_receipt_kind',
  );
  const reverses = r.optionalReference('reverses_receipt_ref');
  const amount = r.money('amount', true);
  const valueDate = r.date('value_date');
  const paymentMode = r.optionalReference('payment_mode');
  const bankReference = r.optionalReference('bank_reference');
  const sourceRecordId = r.reference('source_record_id');
  const reportedAt = r.timestamp('reported_as_of', now);
  const sequence = r.optionalInteger('sequence');
  if (r.errors.length === 0) {
    const wrongReversal =
      receiptKind === 'reversal'
        ? reverses === null || reverses === lmsReceiptRef
        : reverses !== null;
    if (wrongReversal) r.fail('reverses_receipt_ref', 'reversal_reference_invalid');
  }
  if (
    r.errors.length > 0 ||
    lmsLoanRef === undefined ||
    lmsReceiptRef === undefined ||
    receiptKind === undefined ||
    reverses === undefined ||
    amount === undefined ||
    valueDate === undefined ||
    paymentMode === undefined ||
    bankReference === undefined ||
    sourceRecordId === undefined ||
    reportedAt === undefined ||
    sequence === undefined
  ) {
    return { ok: false, errors: r.errors };
  }
  return {
    ok: true,
    report: {
      reportType: 'receipt',
      sourceSystem: options.sourceSystem,
      sourceRecordId,
      reportedAt,
      sequence,
      contentSha256: lmsReportHash('receipt', [
        ['lms_loan_ref', lmsLoanRef],
        ['lms_receipt_ref', lmsReceiptRef],
        ['receipt_kind', receiptKind],
        ['reverses_receipt_ref', reverses],
        ['amount', amount],
        ['value_date', valueDate],
        ['payment_mode', paymentMode],
        ['bank_reference', bankReference],
        ['source_record_id', sourceRecordId],
        ['reported_at', reportedAt],
        ['sequence', sequence],
      ]),
      receiptKind,
      lmsLoanRef,
      lmsReceiptRef,
      reversesReceiptRef: reverses,
      amountMinor: amount,
      valueDate,
      paymentMode,
      bankReference,
    },
  };
}

export function normaliseLmsSchedule(
  raw: Raw,
  options: NormaliseOptions,
): NormaliseResult<LmsScheduleReport> {
  checkSource(options);
  const rowNumber = options.rowNumber ?? 1;
  const r = new FieldReader(raw, rowNumber);
  const now = options.now ?? new Date();
  r.allow([...LMS_SCHEDULE_HEAD_FIELDS, 'installments']);
  const lmsLoanRef = r.reference('lms_loan_ref');
  const sourceRecordId = r.reference('source_record_id');
  const reportedAt = r.timestamp('reported_as_of', now);
  const sequence = r.optionalInteger('sequence');
  const items = r.objectArray('installments');
  const installments: LmsScheduleInstallment[] = [];
  let previousDue: string | null = null;
  items?.forEach((item, index) => {
    const ir = new FieldReader(item, rowNumber, index);
    ir.allow(LMS_SCHEDULE_INSTALLMENT_FIELDS);
    const seq = ir.integer('installment_seq', MAX_INSTALLMENTS);
    const dueOn = ir.date('due_date');
    const principal = ir.money('principal');
    const interest = ir.money('interest');
    const fees = ir.optionalMoney('fees');
    if (seq !== undefined && seq !== index + 1) ir.fail('installment_seq', 'invalid_items');
    if (dueOn !== undefined) {
      if (previousDue !== null && dueOn <= previousDue) ir.fail('due_date', 'invalid_items');
      previousDue = dueOn;
    }
    r.errors.push(...ir.errors);
    if (
      ir.errors.length === 0 &&
      seq !== undefined &&
      dueOn !== undefined &&
      principal !== undefined &&
      interest !== undefined &&
      fees !== undefined
    ) {
      installments.push({
        sequence: seq,
        dueOn,
        principalMinor: principal,
        interestMinor: interest,
        feesMinor: fees ?? 0n,
      });
    }
  });
  if (
    r.errors.length > 0 ||
    lmsLoanRef === undefined ||
    sourceRecordId === undefined ||
    reportedAt === undefined ||
    sequence === undefined ||
    installments.length === 0
  ) {
    return { ok: false, errors: r.errors };
  }
  return {
    ok: true,
    report: {
      reportType: 'schedule',
      sourceSystem: options.sourceSystem,
      sourceRecordId,
      reportedAt,
      sequence,
      contentSha256: lmsReportHash('schedule', [
        ['lms_loan_ref', lmsLoanRef],
        ['source_record_id', sourceRecordId],
        ['reported_at', reportedAt],
        ['sequence', sequence],
        ...installments.flatMap((i): [string, HashValue][] => [
          ['seq', i.sequence],
          ['due_on', i.dueOn],
          ['principal', i.principalMinor],
          ['interest', i.interestMinor],
          ['fees', i.feesMinor],
        ]),
      ]),
      lmsLoanRef,
      installments,
    },
  };
}

/** A foreclosure/cooling-off quote as the lender issued it. Udofin adds up nothing and stores the lender's own labels. */
export function normaliseLmsQuote(raw: Raw, options: NormaliseOptions): NormaliseResult<LmsQuote> {
  checkSource(options);
  const rowNumber = options.rowNumber ?? 1;
  const r = new FieldReader(raw, rowNumber);
  const now = options.now ?? new Date();
  r.allow(QUOTE_FIELDS);
  const lmsLoanRef = r.reference('lms_loan_ref');
  const lenderQuoteRef = r.reference('lender_quote_ref');
  const asOfDate = r.date('as_of_date');
  const amount = r.money('amount', true);
  const sourceRecordId = r.reference('source_record_id');
  const reportedAt = r.timestamp('reported_as_of', now);
  const sequence = r.optionalInteger('sequence');
  // valid_until lies in the future of the report by design, so the "not from the future" rule does not apply to it.
  const validRaw = Object.hasOwn(raw, 'valid_until') ? raw.valid_until : undefined;
  const validUntil = typeof validRaw === 'string' ? normaliseTimestamp(validRaw) : null;
  if (validUntil === null) r.fail('valid_until', 'invalid_timestamp');
  else if (reportedAt !== undefined && validUntil <= reportedAt)
    r.fail('valid_until', 'invalid_validity');
  const components: LmsQuoteComponent[] = [];
  r.objectArray('components')?.forEach((item, index) => {
    const ir = new FieldReader(item, rowNumber, index);
    ir.allow(['kind', 'amount']);
    const kind = ir.reference('kind');
    const componentAmount = ir.money('amount');
    r.errors.push(...ir.errors);
    if (kind !== undefined && componentAmount !== undefined) {
      components.push({ kind, amountMinor: componentAmount });
    }
  });
  if (
    r.errors.length > 0 ||
    lmsLoanRef === undefined ||
    lenderQuoteRef === undefined ||
    asOfDate === undefined ||
    amount === undefined ||
    sourceRecordId === undefined ||
    reportedAt === undefined ||
    sequence === undefined ||
    validUntil === null
  ) {
    return { ok: false, errors: r.errors };
  }
  return {
    ok: true,
    report: {
      reportType: 'quote',
      sourceSystem: options.sourceSystem,
      sourceRecordId,
      reportedAt,
      sequence,
      contentSha256: lmsReportHash('quote', [
        ['lms_loan_ref', lmsLoanRef],
        ['lender_quote_ref', lenderQuoteRef],
        ['as_of_date', asOfDate],
        ['valid_until', validUntil],
        ['amount', amount],
        ...components.flatMap((c): [string, HashValue][] => [
          ['component', c.kind],
          ['component_amount', c.amountMinor],
        ]),
        ['source_record_id', sourceRecordId],
        ['reported_at', reportedAt],
        ['sequence', sequence],
      ]),
      lmsLoanRef,
      lenderQuoteRef,
      amountMinor: amount,
      components,
      asOfDate,
      validUntil,
    },
  };
}

// ---------------------------------------------------------------------------------------------------------
// File import (pure: no network, no file system, no clock unless `now` is omitted)
// ---------------------------------------------------------------------------------------------------------

export type LmsImportKind = 'loan' | 'receipt' | 'schedule';

export interface LmsImportReportMap {
  readonly loan: LmsLoanReport;
  readonly receipt: LmsReceiptReport;
  readonly schedule: LmsScheduleReport;
}

export interface LmsImportFormatSpec<K extends LmsImportKind = LmsImportKind> {
  readonly format: 'csv' | 'json';
  readonly kind: K;
  readonly sourceSystem: 'file_import' | 'manual_import';
  /** Default 5 MiB. */
  readonly maxBytes?: number;
  /** Default 10 000 records. */
  readonly maxRows?: number;
  /** For the "not from the future" rule. Defaults to the current time. */
  readonly now?: Date;
}

export interface LmsImportResult<K extends LmsImportKind> {
  readonly kind: K;
  readonly formatVersion: typeof LMS_IMPORT_FORMAT;
  /** SHA-256 (hex) of the file bytes: the import batch's identity. */
  readonly fileSha256: string;
  /** Records in the file (rows for CSV, records for JSON; schedule CSV counts installment rows). */
  readonly recordCount: number;
  readonly rows: readonly LmsImportReportMap[K][];
  readonly errors: readonly LmsImportError[];
}

export const LMS_IMPORT_DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
export const LMS_IMPORT_DEFAULT_MAX_ROWS = 10_000;

/** Minimal RFC 4180 parser. Returns null on any structural problem (it never guesses). */
function parseCsv(text: string): string[][] | null {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let afterQuote = false;
  let fieldStart = true;
  const endField = (): void => {
    row.push(field);
    field = '';
    fieldStart = true;
    afterQuote = false;
  };
  const endRow = (): void => {
    endField();
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (ch === '\0') return null;
    if (inQuotes) {
      if (ch === '"') {
        if (text.charAt(i + 1) === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
          afterQuote = true;
        }
      } else field += ch;
      continue;
    }
    if (ch === '"') {
      if (!fieldStart) return null;
      inQuotes = true;
      fieldStart = false;
      continue;
    }
    if (afterQuote && ch !== ',' && ch !== '\n' && ch !== '\r') return null;
    if (ch === ',') endField();
    else if (ch === '\n') endRow();
    else if (ch === '\r') {
      if (text.charAt(i + 1) !== '\n') return null;
    } else {
      field += ch;
      fieldStart = false;
    }
  }
  if (inQuotes) return null;
  if (field !== '' || row.length > 0 || afterQuote) endRow();
  return rows;
}

function fileError(code: LmsImportErrorCode, field: string | null = null): LmsImportError {
  return { rowNumber: 0, field, code };
}

interface ParsedRecords {
  /** Plain objects of cell values, with the row number each came from. */
  readonly records: readonly {
    readonly raw: Raw;
    readonly rowNumber: number;
    readonly rowNumbers?: readonly number[];
  }[];
  readonly recordCount: number;
  readonly errors: readonly LmsImportError[];
}

function csvRecords(
  text: string,
  kind: LmsImportKind,
  maxRows: number,
): ParsedRecords | { readonly fatal: LmsImportError } {
  const table = parseCsv(text);
  if (table === null) return { fatal: fileError('malformed_file') };
  const [header, ...body] = table;
  if (!header) return { fatal: fileError('empty_file') };
  if (body.length > maxRows) return { fatal: fileError('too_many_rows') };
  const known: readonly string[] =
    kind === 'loan'
      ? LMS_LOAN_FIELDS
      : kind === 'receipt'
        ? LMS_RECEIPT_FIELDS
        : [...LMS_SCHEDULE_HEAD_FIELDS, ...LMS_SCHEDULE_INSTALLMENT_FIELDS];
  const required: readonly string[] =
    kind === 'loan'
      ? LMS_LOAN_REQUIRED
      : kind === 'receipt'
        ? LMS_RECEIPT_REQUIRED
        : [
            'lms_loan_ref',
            'source_record_id',
            'reported_as_of',
            'installment_seq',
            'due_date',
            'principal',
            'interest',
          ];
  const seen = new Set<string>();
  for (const name of header) {
    if (seen.has(name)) return { fatal: fileError('duplicate_column', null) };
    seen.add(name);
    if (!known.includes(name)) return { fatal: fileError('unknown_column') };
  }
  for (const name of required)
    if (!seen.has(name)) return { fatal: fileError('missing_column', name) };

  const errors: LmsImportError[] = [];
  const rows: { raw: Raw; rowNumber: number }[] = [];
  body.forEach((cells, index) => {
    const rowNumber = index + 1;
    if (cells.length !== header.length) {
      errors.push({ rowNumber, field: null, code: 'column_count_mismatch' });
      return;
    }
    const raw: Record<string, unknown> = {};
    header.forEach((name, column) => {
      raw[name] = cells[column];
    });
    rows.push({ raw, rowNumber });
  });
  if (kind !== 'schedule') return { records: rows, recordCount: body.length, errors };

  // Schedule CSV: one row per installment; rows sharing (loan, source record) form one report.
  const groups = new Map<
    string,
    { head: Record<string, unknown>; items: Record<string, unknown>[]; rowNumbers: number[] }
  >();
  for (const { raw, rowNumber } of rows) {
    const key = JSON.stringify([raw.lms_loan_ref, raw.source_record_id]);
    const head: Record<string, unknown> = {};
    for (const name of LMS_SCHEDULE_HEAD_FIELDS)
      if (Object.hasOwn(raw, name)) head[name] = raw[name];
    const item: Record<string, unknown> = {};
    for (const name of LMS_SCHEDULE_INSTALLMENT_FIELDS) {
      if (Object.hasOwn(raw, name)) item[name] = raw[name];
    }
    const group = groups.get(key);
    if (!group) groups.set(key, { head, items: [item], rowNumbers: [rowNumber] });
    else {
      const same = LMS_SCHEDULE_HEAD_FIELDS.every((name) => group.head[name] === head[name]);
      if (!same) {
        errors.push({ rowNumber, field: null, code: 'inconsistent_report_head' });
        continue;
      }
      group.items.push(item);
      group.rowNumbers.push(rowNumber);
    }
  }
  const records = [...groups.values()].map((g) => ({
    raw: { ...g.head, installments: g.items },
    rowNumber: g.rowNumbers[0] ?? 0,
    rowNumbers: g.rowNumbers,
  }));
  return { records, recordCount: body.length, errors };
}

function jsonRecords(
  text: string,
  maxRows: number,
): ParsedRecords | { readonly fatal: LmsImportError } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { fatal: fileError('malformed_file') };
  }
  let list: unknown;
  if (Array.isArray(parsed)) list = parsed;
  else if (typeof parsed === 'object' && parsed !== null) {
    const keys = Object.keys(parsed);
    const top = parsed as Record<string, unknown>;
    if (keys.some((k) => k !== 'records' && k !== 'format_version')) {
      return { fatal: fileError('malformed_file') };
    }
    if (Object.hasOwn(top, 'format_version') && top.format_version !== LMS_IMPORT_FORMAT) {
      return { fatal: fileError('malformed_file', 'format_version') };
    }
    list = top.records;
  }
  if (!Array.isArray(list)) return { fatal: fileError('malformed_file') };
  if (list.length === 0) return { fatal: fileError('empty_file') };
  if (list.length > maxRows) return { fatal: fileError('too_many_rows') };
  const errors: LmsImportError[] = [];
  const records: { raw: Raw; rowNumber: number }[] = [];
  list.forEach((item: unknown, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      errors.push({ rowNumber: index + 1, field: null, code: 'malformed_file' });
      return;
    }
    records.push({ raw: item as Raw, rowNumber: index + 1 });
  });
  return { records, recordCount: list.length, errors };
}

/**
 * Parses and normalises a lender-supplied file into the same reports an LMS connector would return, with row-level
 * errors. Pure: it opens no network connection and reads no file. Errors never contain cell values.
 */
export function parseLmsImportFile<K extends LmsImportKind>(
  text: string,
  spec: LmsImportFormatSpec<K>,
): LmsImportResult<K> {
  const maxBytes = spec.maxBytes ?? LMS_IMPORT_DEFAULT_MAX_BYTES;
  const maxRows = spec.maxRows ?? LMS_IMPORT_DEFAULT_MAX_ROWS;
  const bytes = Buffer.from(text, 'utf8');
  const fileSha256 = createHash('sha256').update(bytes).digest('hex');
  const empty = (errors: readonly LmsImportError[], recordCount = 0): LmsImportResult<K> => ({
    kind: spec.kind,
    formatVersion: LMS_IMPORT_FORMAT,
    fileSha256,
    recordCount,
    rows: [],
    errors,
  });
  if (bytes.length > maxBytes) return empty([fileError('file_too_large')]);
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (body.trim() === '') return empty([fileError('empty_file')]);

  const parsed =
    spec.format === 'csv' ? csvRecords(body, spec.kind, maxRows) : jsonRecords(body, maxRows);
  if ('fatal' in parsed) return empty([parsed.fatal]);

  const now = spec.now ?? new Date();
  const errors: LmsImportError[] = [...parsed.errors];
  type AnyReport = LmsImportReportMap[LmsImportKind];
  interface Candidate {
    readonly rowNumber: number;
    readonly report: AnyReport;
  }
  const candidates: Candidate[] = [];
  for (const { raw, rowNumber, rowNumbers } of parsed.records) {
    const options: NormaliseOptions = { sourceSystem: spec.sourceSystem, now, rowNumber };
    const result: NormaliseResult<AnyReport> =
      spec.kind === 'loan'
        ? normaliseLmsLoan(raw, options)
        : spec.kind === 'receipt'
          ? normaliseLmsReceipt(raw, options)
          : normaliseLmsSchedule(raw, options);
    if (result.ok) {
      candidates.push({ rowNumber, report: result.report });
    } else {
      for (const error of result.errors) {
        // CSV schedule: point installment errors at the CSV row they came from.
        const mapped =
          rowNumbers && error.itemIndex !== undefined
            ? { ...error, rowNumber: rowNumbers[error.itemIndex] ?? rowNumber }
            : error;
        errors.push(mapped);
      }
    }
  }

  // Duplicates inside the file: identical content keeps the first; different content rejects every occurrence.
  const keyOf = (report: AnyReport): string =>
    report.reportType === 'receipt'
      ? report.lmsReceiptRef
      : `${report.lmsLoanRef}\u0000${report.sourceRecordId}`;
  const byKey = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const key = keyOf(candidate.report);
    byKey.set(key, [...(byKey.get(key) ?? []), candidate]);
  }
  const kept: Candidate[] = [];
  for (const group of byKey.values()) {
    const [first, ...rest] = group;
    if (!first) continue;
    if (group.every((c) => c.report.contentSha256 === first.report.contentSha256)) {
      kept.push(first);
      for (const duplicate of rest) {
        errors.push({ rowNumber: duplicate.rowNumber, field: null, code: 'duplicate_row' });
      }
    } else {
      for (const conflicting of group) {
        errors.push({
          rowNumber: conflicting.rowNumber,
          field: null,
          code: 'conflicting_duplicate',
        });
      }
    }
  }
  kept.sort((a, b) => a.rowNumber - b.rowNumber);
  errors.sort((a, b) => a.rowNumber - b.rowNumber);
  return {
    kind: spec.kind,
    formatVersion: LMS_IMPORT_FORMAT,
    fileSha256,
    recordCount: parsed.recordCount,
    // The reports were produced by the normaliser that matches spec.kind, so the union narrows to LmsImportReportMap[K].
    rows: kept.map((c) => c.report) as LmsImportReportMap[K][],
    errors,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Labelled mock LMS
// ---------------------------------------------------------------------------------------------------------

export type MockLmsScenario =
  | 'normal'
  | 'delayed'
  | 'duplicate_report'
  | 'older_sequence'
  | 'status_regression'
  | 'unknown_loan'
  | 'timeout'
  | 'malformed_amount';

/** The fixed "now" the mock validates against, so its reports never depend on the wall clock. */
export const MOCK_LMS_NOW = new Date('2026-10-14T00:00:00.000Z');
export const MOCK_LMS_LOAN_REF = 'SAMPLE-LOAN-0001';
export const MOCK_LMS_UNKNOWN_LOAN_REF = 'SAMPLE-LOAN-UNKNOWN';
export const MOCK_LMS_BORROWER_REF = 'SAMPLE-APP-0001';
const MOCK_SOURCE = 'mock_lms';
const MOCK_CURSOR = 'SAMPLE-CURSOR-0001';

export interface MockLms extends LmsPort {
  readonly scenario: MockLmsScenario;
  readonly calls: readonly { readonly method: string; readonly lmsLoanRef: string | null }[];
}

function sampleLoan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    lms_loan_ref: MOCK_LMS_LOAN_REF,
    borrower_ref: MOCK_LMS_BORROWER_REF,
    status: 'active',
    sanctioned_amount: '50000.00',
    disbursed_amount: '50000.00',
    disbursement_ref: 'SAMPLE-DISB-0001',
    disbursement_date: '2026-09-01',
    outstanding_principal: '41666.67',
    next_due_date: '2026-11-05',
    next_due_amount: '4500.00',
    overdue_principal: '0.00',
    overdue_interest: '0.00',
    penal_charges: '0.00',
    other_charges: '0.00',
    total_overdue: '0.00',
    days_past_due: '0',
    source_record_id: 'SAMPLE-REC-0007',
    reported_as_of: '2026-10-13T06:00:00Z',
    sequence: '7',
    ...overrides,
  };
}

function sampleSchedule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const installment = (n: number, due: string): Record<string, unknown> => ({
    installment_seq: String(n),
    due_date: due,
    principal: '4166.67',
    interest: '333.33',
    fees: '0.00',
  });
  return {
    lms_loan_ref: MOCK_LMS_LOAN_REF,
    source_record_id: 'SAMPLE-SCH-0001',
    reported_as_of: '2026-10-13T06:00:00Z',
    sequence: '7',
    installments: [
      installment(1, '2026-11-05'),
      installment(2, '2026-12-05'),
      installment(3, '2027-01-05'),
    ],
    ...overrides,
  };
}

function sampleReceipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    lms_loan_ref: MOCK_LMS_LOAN_REF,
    lms_receipt_ref: 'SAMPLE-RCPT-0001',
    receipt_kind: 'receipt',
    amount: '4500.00',
    value_date: '2026-10-05',
    payment_mode: 'upi',
    bank_reference: 'SAMPLE-BANKREF-0001',
    source_record_id: 'SAMPLE-RCPT-0001',
    reported_as_of: '2026-10-13T06:00:00Z',
    ...overrides,
  };
}

const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * TEST DOUBLE, `mock_lms`. Not a lender, no network, deterministic. Every figure is a labelled SAMPLE: nothing here is
 * computed by Udofin. Allowed only in local development and tests (staging is refused too).
 */
export function createMockLms(
  environment: AppEnvironment,
  scenario: MockLmsScenario = 'normal',
): MockLms {
  const descriptor: ProviderDescriptor = { key: 'mock_lms', capability: 'lms', mode: 'mock' };
  assertLocalOrTestOnly(descriptor, environment, 'mock LMS');
  const calls: { method: string; lmsLoanRef: string | null }[] = [];
  const fetchCount = new Map<string, number>();
  const record = (method: string, lmsLoanRef: string | null): number => {
    calls.push({ method, lmsLoanRef });
    const key = `${method}:${lmsLoanRef ?? ''}`;
    const n = (fetchCount.get(key) ?? 0) + 1;
    fetchCount.set(key, n);
    return n;
  };
  const timedOut = scenario === 'timeout';
  const unknownResult = { outcome: 'unknown', reason: 'timeout' } as const;
  const options: NormaliseOptions = { sourceSystem: MOCK_SOURCE, now: MOCK_LMS_NOW };

  const wrap = <T>(result: NormaliseResult<T>): LmsResult<T> =>
    result.ok
      ? { outcome: 'ok', value: result.report }
      : { outcome: 'invalid', reason: 'malformed_report' };

  const knownLoan = (ref: string): boolean =>
    ref === MOCK_LMS_LOAN_REF && scenario !== 'unknown_loan';

  return {
    descriptor,
    scenario,
    calls,
    capabilities: {
      pull: true,
      push: false,
      foreclosureQuote: true,
      statement: true,
      closureDocuments: true,
      receipts: true,
    },
    listChanges(_ctx, cursor) {
      record('listChanges', null);
      if (timedOut) return Promise.resolve(unknownResult);
      if (cursor !== null) {
        return Promise.resolve({
          outcome: 'ok',
          value: { changes: [], nextCursor: cursor, hasMore: false },
        });
      }
      const change: LmsChange = {
        lmsLoanRef: scenario === 'unknown_loan' ? MOCK_LMS_UNKNOWN_LOAN_REF : MOCK_LMS_LOAN_REF,
        sourceRecordId: 'SAMPLE-REC-0007',
        reportedAt: '2026-10-13T06:00:00.000Z',
      };
      return Promise.resolve({
        outcome: 'ok',
        value: {
          changes: scenario === 'duplicate_report' ? [change, { ...change }] : [change],
          nextCursor: MOCK_CURSOR,
          hasMore: false,
        },
      });
    },
    fetchLoan(_ctx, ref) {
      const n = record('fetchLoan', ref);
      if (timedOut) return Promise.resolve(unknownResult);
      if (!knownLoan(ref)) return Promise.resolve({ outcome: 'not_found' });
      let raw = sampleLoan();
      switch (scenario) {
        case 'delayed':
          raw = sampleLoan({
            reported_as_of: '2026-10-08T06:00:00Z',
            source_record_id: 'SAMPLE-REC-0004',
            sequence: '4',
          });
          break;
        case 'older_sequence':
          if (n > 1) {
            raw = sampleLoan({
              reported_as_of: '2026-10-12T06:00:00Z',
              source_record_id: 'SAMPLE-REC-0006',
              sequence: '6',
            });
          }
          break;
        case 'status_regression':
          raw =
            n === 1
              ? sampleLoan({
                  status: 'closed',
                  outstanding_principal: '0.00',
                  next_due_date: '',
                  next_due_amount: '',
                })
              : sampleLoan({
                  reported_as_of: '2026-10-13T12:00:00Z',
                  source_record_id: 'SAMPLE-REC-0008',
                  sequence: '8',
                });
          break;
        case 'malformed_amount':
          raw = sampleLoan({ sanctioned_amount: '50000.555' });
          break;
        case 'normal':
        case 'duplicate_report':
        case 'unknown_loan':
          break;
      }
      return Promise.resolve(wrap(normaliseLmsLoan(raw, options)));
    },
    fetchSchedule(_ctx, ref) {
      record('fetchSchedule', ref);
      if (timedOut) return Promise.resolve(unknownResult);
      if (!knownLoan(ref)) return Promise.resolve({ outcome: 'not_found' });
      const raw =
        scenario === 'malformed_amount'
          ? sampleSchedule({
              installments: [
                {
                  installment_seq: '1',
                  due_date: '2026-11-05',
                  principal: '4166.675',
                  interest: '333.33',
                },
              ],
            })
          : sampleSchedule(
              scenario === 'delayed'
                ? { reported_as_of: '2026-10-08T06:00:00Z', source_record_id: 'SAMPLE-SCH-0000' }
                : {},
            );
      return Promise.resolve(wrap(normaliseLmsSchedule(raw, options)));
    },
    fetchReceipts(_ctx, ref, sinceCursor) {
      record('fetchReceipts', ref);
      if (timedOut) return Promise.resolve(unknownResult);
      if (!knownLoan(ref)) return Promise.resolve({ outcome: 'not_found' });
      if (sinceCursor !== null) {
        return Promise.resolve({
          outcome: 'ok',
          value: { receipts: [], nextCursor: sinceCursor, hasMore: false },
        });
      }
      const result = normaliseLmsReceipt(
        sampleReceipt(scenario === 'malformed_amount' ? { amount: '4500.001' } : {}),
        options,
      );
      if (!result.ok) return Promise.resolve({ outcome: 'invalid', reason: 'malformed_report' });
      return Promise.resolve({
        outcome: 'ok',
        value: {
          receipts:
            scenario === 'duplicate_report'
              ? [result.report, { ...result.report }]
              : [result.report],
          nextCursor: MOCK_CURSOR,
          hasMore: false,
        },
      });
    },
    requestForeclosureQuote(_ctx, ref, asOfDate) {
      record('requestForeclosureQuote', ref);
      if (timedOut) return Promise.resolve(unknownResult);
      if (!knownLoan(ref)) return Promise.resolve({ outcome: 'not_found' });
      // The amounts are the mock lender's own SAMPLE figures; Udofin computes none of them.
      return Promise.resolve(
        wrap(
          normaliseLmsQuote(
            {
              lms_loan_ref: ref,
              lender_quote_ref: 'SAMPLE-QUOTE-0001',
              as_of_date: asOfDate,
              valid_until: '2026-10-15T18:30:00Z',
              amount: scenario === 'malformed_amount' ? '43000.5.0' : '43000.00',
              components: [
                { kind: 'outstanding_principal', amount: '41666.67' },
                { kind: 'accrued_interest', amount: '1000.00' },
                { kind: 'prepayment_charge', amount: '333.33' },
              ],
              source_record_id: 'SAMPLE-QUOTE-0001',
              reported_as_of: '2026-10-13T06:00:00Z',
              sequence: '',
            },
            options,
          ),
        ),
      );
    },
    fetchStatement(_ctx, ref, period) {
      record('fetchStatement', ref);
      if (timedOut) return Promise.resolve(unknownResult);
      if (!knownLoan(ref)) return Promise.resolve({ outcome: 'not_found' });
      if (!isValidIsoDate(period.from) || !isValidIsoDate(period.to) || period.from > period.to) {
        return Promise.resolve({ outcome: 'invalid', reason: 'malformed_report' });
      }
      return Promise.resolve({
        outcome: 'ok',
        value: sampleDocument(ref, 'statement', period.from, period.to),
      });
    },
    fetchClosureDocuments(_ctx, ref) {
      record('fetchClosureDocuments', ref);
      if (timedOut) return Promise.resolve(unknownResult);
      if (!knownLoan(ref)) return Promise.resolve({ outcome: 'not_found' });
      return Promise.resolve({
        outcome: 'ok',
        value: [sampleDocument(ref, 'no_dues_certificate', null, null)],
      });
    },
  };
}

function sampleDocument(
  lmsLoanRef: string,
  documentKind: LmsDocumentRef['documentKind'],
  periodFrom: string | null,
  periodTo: string | null,
): LmsDocumentRef {
  const reportedAt = '2026-10-13T06:00:00.000Z';
  const lenderDocumentRef = `SAMPLE-DOC-${documentKind.toUpperCase()}-0001`;
  return {
    reportType: 'document',
    sourceSystem: MOCK_SOURCE,
    sourceRecordId: lenderDocumentRef,
    reportedAt,
    sequence: null,
    contentSha256: lmsReportHash('document', [
      ['lms_loan_ref', lmsLoanRef],
      ['kind', documentKind],
      ['ref', lenderDocumentRef],
      ['period_from', periodFrom],
      ['period_to', periodTo],
      ['reported_at', reportedAt],
    ]),
    lmsLoanRef,
    documentKind,
    lenderDocumentRef,
    mediaType: 'application/pdf',
    documentSha256: sha256Hex(`SAMPLE ${documentKind} document for ${lmsLoanRef}`),
    periodFrom,
    periodTo,
  };
}
