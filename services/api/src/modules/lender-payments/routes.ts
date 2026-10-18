import {
  LP_BANK_CREDIT_MAX_ROWS,
  LpBankCreditRow,
  LpBankCreditsInput,
  LpBankCreditsResult,
  LpExceptionActionResult,
  LpExceptionAssignInput,
  LpExceptionDetail,
  LpExceptionListQuery,
  LpExceptionPage,
  LpExceptionReopenInput,
  LpExceptionResolveInput,
  LpLenderFilterQuery,
  LpMandateDebitListQuery,
  LpMandateDebitPage,
  LpMandateDetail,
  LpMandateListQuery,
  LpMandatePage,
  LpMandatePolicyInput,
  LpMandatePolicyList,
  LpPaymentDetail,
  LpPaymentListQuery,
  LpPaymentPage,
  LpPaymentPolicyInput,
  LpPaymentPolicyList,
  LpPlatformExceptionListQuery,
  LpProviderEventListQuery,
  LpProviderEventPage,
  LpReconciliationSettingsInput,
  LpReconciliationSettingsList,
  LpReconciliationSummary,
  LpReconciliationSummaryQuery,
  LpRunListQuery,
  LpRunPage,
  LpSetResult,
  LpSettlementBatch,
  LpSettlementBatchListQuery,
  LpSettlementBatchPage,
  LpSettlementItemListQuery,
  LpSettlementItemPage,
  LpWebhookSummary,
  LpWebhookSummaryQuery,
} from '@udofin/contracts';
import { z } from 'zod';
import { columns } from '../../db/columns.js';
import { type UserTx } from '../../db/user-context.js';
import { ApiError } from '../../http/api-error.js';
import { decodeCursor, encodeCursor } from '../../http/pagination.js';
import { userRoute, type RouteDefinition } from '../../http/routes.js';

/**
 * Phase 08a, lender side: payments and what the provider reported about them, policies, mandates and their debits,
 * reconciliation (runs, settlement batches, bank credits) and the exception queue.
 *
 * Every rule lives in the database. Reads go through row level security (a lender sees its own rows; platform operations
 * roles see every lender's through payment.read); writes call the SQL functions, which check the permission, the second
 * factor and the closed vocabularies. These routes validate the shape of a request, take the caller from the token, pass
 * identifiers, and map the result. Nothing here computes an amount, derives a stage or decides an eligibility.
 *
 * Responses are mapped field by field from the columns this module chooses to read: no row is ever spread, and the
 * contract schemas are strict, so an undeclared field cannot leave the API.
 */

const WRITE_LIMIT = { max: 30, timeWindow: '1 minute' };
const READ_LIMIT = { max: 120, timeWindow: '1 minute' };
const UPLOAD_LIMIT = { max: 30, timeWindow: '1 minute' };
const Id = z.strictObject({ id: z.uuid() });

/** The permissions that let a lender user read each family of rows (they mirror the row level security policies). */
const READ = ['payment.read'] as const;
const READ_POLICY = ['payment.read', 'payment.configure', 'payment.config.approve'] as const;
const READ_EXCEPTIONS = ['payment.read', 'payment.reconcile'] as const;

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
const count = (value: string): number => {
  if (!/^\d{1,15}$/.test(value)) throw new Error('the database returned a count outside the range');
  return Number(value);
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
 * silent empty list, and a lender filter the caller does not hold a 403 too. Platform staff who run providers may read the
 * exception queue of every lender (the same rule as the policy on the table).
 */
async function requireReader(
  tx: UserTx,
  permissions: readonly string[],
  lenderId: string | undefined,
  allowPlatformProviderStaff = false,
): Promise<void> {
  const r = await tx.query<{ ok: boolean }>(
    `select (exists (select 1 from unnest($1::text[]) as p(key) cross join lateral private.orgs_with_permission(p.key) as o(id)
                      where $2::uuid is null or o.id = $2::uuid)
             or ($3::boolean and private.has_platform_permission('platform.payments.providers.manage'))) as ok`,
    [permissions, lenderId ?? null, allowPlatformProviderStaff],
  );
  if (!r.rows[0]?.ok) throw new ApiError(403, 'forbidden', 'Forbidden');
}

async function requirePlatformProviderStaff(tx: UserTx): Promise<void> {
  const r = await tx.query<{ ok: boolean }>(
    "select private.has_platform_permission('platform.payments.providers.manage') as ok",
  );
  if (!r.rows[0]?.ok) throw new ApiError(403, 'forbidden', 'Forbidden');
}

const notFound = () => new ApiError(404, 'not_found', 'Not Found');

// ---------------------------------------------------------------------------------------------------------------
// Bank statement as CSV: exactly the columns valueDate, amountMinor and utr
// ---------------------------------------------------------------------------------------------------------------
const CSV_COLUMNS = ['valueDate', 'amountMinor', 'utr'] as const;

/** A refusal of the whole upload. The detail names a rule and a line number, never a value. */
function csvRefusal(code: string, detail: string): ApiError {
  return new ApiError(422, code, 'Unprocessable Content', detail);
}

/**
 * Parses a bank statement given as CSV text. Strict by design: the header must be exactly the three columns (any order, no
 * other column, no repeat), every line must have exactly three plain fields (no quotes, no escapes), and every field is
 * checked for shape. The first problem refuses the WHOLE upload, and no message contains a value from the file: a narration
 * column could carry a name, so a column is never echoed, only the rule it broke. The database repeats these rules.
 */
export function parseBankCreditsCsv(text: string): z.infer<typeof LpBankCreditRow>[] {
  const body = text.startsWith('﻿') ? text.slice(1) : text;
  if (body.includes('\0') || body.includes('"')) {
    throw csvRefusal('row_invalid', 'csv: only plain fields are accepted');
  }
  const lines = body.split(/\r\n|\n/);
  if (lines.at(-1) === '') lines.pop();
  const [headerLine, ...dataLines] = lines;
  if (headerLine === undefined || dataLines.length === 0) {
    throw csvRefusal('row_invalid', 'csv: a header line and at least one credit are required');
  }
  const header = headerLine.split(',');
  if (header.some((name) => !(CSV_COLUMNS as readonly string[]).includes(name))) {
    throw csvRefusal('unexpected_field', 'csv: the header has a column that is not accepted');
  }
  if (header.length !== CSV_COLUMNS.length || new Set(header).size !== CSV_COLUMNS.length) {
    throw csvRefusal('row_invalid', 'csv: the header must name each of the three columns once');
  }
  if (dataLines.length > LP_BANK_CREDIT_MAX_ROWS) {
    throw csvRefusal('rows_invalid', 'csv: too many credits in one upload');
  }
  const index = {
    valueDate: header.indexOf('valueDate'),
    amountMinor: header.indexOf('amountMinor'),
    utr: header.indexOf('utr'),
  };
  return dataLines.map((line, n) => {
    const cells = line.split(',');
    const where = `csv line ${String(n + 2)}`;
    if (cells.length !== CSV_COLUMNS.length) {
      throw csvRefusal('row_invalid', `${where}: every line needs exactly three fields`);
    }
    const amountText = cells[index.amountMinor] ?? '';
    if (!/^[1-9][0-9]{0,14}$/.test(amountText)) {
      throw csvRefusal('row_invalid', `${where}: amountMinor: not a whole number of paise`);
    }
    const parsed = LpBankCreditRow.safeParse({
      valueDate: cells[index.valueDate] ?? '',
      amountMinor: Number(amountText),
      utr: cells[index.utr] ?? '',
    });
    if (!parsed.success) {
      const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))];
      throw csvRefusal('row_invalid', `${where}: ${fields.join(', ')}: invalid`);
    }
    return parsed.data;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Column lists and mappers (explicit: a column that is not listed here cannot reach a response)
// ---------------------------------------------------------------------------------------------------------------
interface IntentRow {
  id: string;
  lenderId: string;
  loanAccountId: string;
  purpose: string;
  amountMinor: string;
  currency: string;
  status: string;
  provider: string;
  providerMode: string | null;
  providerOrderRef: string | null;
  targetInstallmentSeq: number | null;
  linkExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}
const INTENT_COLUMNS = columns({
  id: 'i.id',
  lenderId: 'i.lender_org_id',
  loanAccountId: 'i.loan_account_id',
  purpose: 'i.purpose::text',
  amountMinor: 'i.amount_minor::text',
  currency: 'i.currency::text',
  status: 'i.status::text',
  provider: 'i.provider',
  providerMode: 'i.provider_mode',
  providerOrderRef: 'i.provider_order_ref',
  targetInstallmentSeq: 'i.target_installment_seq',
  linkExpiresAt: ts('i.link_expires_at'),
  createdAt: ts('i.created_at'),
  updatedAt: ts('i.updated_at'),
});
const mapIntent = (r: IntentRow) => ({
  id: r.id,
  lenderId: r.lenderId,
  loanAccountId: r.loanAccountId,
  purpose: r.purpose,
  amountMinor: paise(r.amountMinor),
  currency: r.currency,
  status: r.status,
  provider: r.provider,
  providerMode: r.providerMode,
  providerOrderRef: r.providerOrderRef,
  targetInstallmentSeq: r.targetInstallmentSeq,
  linkExpiresAt: r.linkExpiresAt,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

interface ProviderPaymentRow {
  id: string;
  providerPaymentRef: string;
  orderRef: string;
  status: string;
  amountMinor: string | null;
  currency: string | null;
  capturedAt: string | null;
  duplicateCapture: boolean;
  createdAt: string;
  updatedAt: string;
  stage: string | null;
  providerCaptured: boolean | null;
  providerSettled: boolean | null;
  bankConfirmed: boolean | null;
  bankConfirmationBasis: string | null;
  lenderPosted: boolean | null;
  settlementDestinationOk: boolean | null;
}
const PROVIDER_PAYMENT_COLUMNS = columns({
  id: 'p.id',
  providerPaymentRef: 'p.provider_payment_ref',
  orderRef: 'p.order_ref',
  status: 'p.status',
  amountMinor: 'p.amount_minor::text',
  currency: 'p.currency::text',
  capturedAt: ts('p.captured_at'),
  duplicateCapture: 'p.duplicate_capture',
  createdAt: ts('p.created_at'),
  updatedAt: ts('p.updated_at'),
  stage: 's.stage',
  providerCaptured: 's.provider_captured',
  providerSettled: 's.provider_settled',
  bankConfirmed: 's.bank_confirmed',
  bankConfirmationBasis: 's.bank_confirmation_basis',
  lenderPosted: 's.lender_posted',
  settlementDestinationOk: 's.settlement_destination_ok',
});
const mapProviderPayment = (r: ProviderPaymentRow) => ({
  id: r.id,
  providerPaymentRef: r.providerPaymentRef,
  orderRef: r.orderRef,
  status: r.status,
  amountMinor: paiseOrNull(r.amountMinor),
  currency: r.currency,
  capturedAt: r.capturedAt,
  duplicateCapture: r.duplicateCapture,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
  stage:
    r.stage === null
      ? null
      : {
          stage: r.stage,
          providerCaptured: r.providerCaptured === true,
          providerSettled: r.providerSettled === true,
          bankConfirmed: r.bankConfirmed === true,
          bankConfirmationBasis: r.bankConfirmationBasis,
          lenderPosted: r.lenderPosted === true,
          settlementDestinationOk: r.settlementDestinationOk,
        },
});

interface AdjustmentRow {
  id: string;
  providerPaymentId: string;
  kind: string;
  objectRef: string;
  amountMinor: string;
  occurredAt: string;
  createdAt: string;
}
const ADJUSTMENT_COLUMNS = columns({
  id: 'a.id',
  providerPaymentId: 'a.provider_payment_id',
  kind: 'a.kind',
  objectRef: 'a.object_ref',
  amountMinor: 'a.amount_minor::text',
  occurredAt: ts('a.occurred_at'),
  createdAt: ts('a.created_at'),
});
const mapAdjustment = (r: AdjustmentRow) => ({
  id: r.id,
  providerPaymentId: r.providerPaymentId,
  kind: r.kind,
  objectRef: r.objectRef,
  amountMinor: paise(r.amountMinor),
  occurredAt: r.occurredAt,
  createdAt: r.createdAt,
});

interface EventRow {
  id: string;
  lenderId: string;
  provider: string;
  providerEventId: string;
  eventType: string;
  objectKind: string | null;
  objectRef: string | null;
  orderRef: string | null;
  paymentIntentId: string | null;
  providerStatus: string | null;
  amountMinor: string | null;
  currency: string | null;
  occurredAt: string | null;
  receivedAt: string;
  processingClass: string | null;
  verificationStages: Record<string, unknown> | null;
  outcome: string | null;
  reasonClass: string | null;
  attempt: number | null;
  deferredUntil: string | null;
  processedAt: string | null;
}
const EVENT_COLUMNS = columns({
  id: 'e.id',
  lenderId: 'e.lender_org_id',
  provider: 'e.provider',
  providerEventId: 'e.provider_event_id',
  eventType: 'e.event_type',
  objectKind: 'e.object_kind',
  objectRef: 'e.object_ref',
  orderRef: 'e.order_ref',
  paymentIntentId: 'e.payment_intent_id',
  providerStatus: 'e.provider_status',
  amountMinor: 'e.amount_minor::text',
  currency: 'e.currency::text',
  occurredAt: ts('e.occurred_at'),
  receivedAt: ts('e.received_at'),
  processingClass: 'e.processing_class',
  verificationStages: 'e.verification_stages',
  outcome: 'p.outcome',
  reasonClass: 'p.reason_class',
  attempt: 'p.attempt',
  deferredUntil: ts('p.deferred_until'),
  processedAt: ts('p.processed_at'),
});
const stageText = (stages: Record<string, unknown>, key: string): string => {
  const value = stages[key];
  return typeof value === 'string' ? value : '';
};
const mapEvent = (r: EventRow) => ({
  id: r.id,
  lenderId: r.lenderId,
  provider: r.provider,
  providerEventId: r.providerEventId,
  eventType: r.eventType,
  objectKind: r.objectKind,
  objectRef: r.objectRef,
  orderRef: r.orderRef,
  paymentIntentId: r.paymentIntentId,
  providerStatus: r.providerStatus,
  amountMinor: paiseOrNull(r.amountMinor),
  currency: r.currency,
  occurredAt: r.occurredAt,
  receivedAt: r.receivedAt,
  processingClass: r.processingClass,
  verification: r.verificationStages
    ? {
        authentication: stageText(r.verificationStages, 'authentication'),
        integrity: stageText(r.verificationStages, 'integrity'),
        correlation: stageText(r.verificationStages, 'correlation'),
        business: stageText(r.verificationStages, 'business'),
      }
    : null,
  processing:
    r.outcome !== null && r.reasonClass !== null && r.attempt !== null && r.processedAt !== null
      ? {
          outcome: r.outcome,
          reasonClass: r.reasonClass,
          attempt: r.attempt,
          deferredUntil: r.deferredUntil,
          processedAt: r.processedAt,
        }
      : null,
});

interface MandateRow {
  id: string;
  lenderId: string;
  loanAccountId: string;
  rail: string;
  status: string;
  provider: string;
  providerMode: string;
  providerMandateRef: string | null;
  maxAmountMinor: string;
  startDate: string;
  endDate: string;
  maskedAccountRef: string;
  needsAfaEachDebit: boolean;
  handoffExpiresAt: string | null;
  lastEventAt: string | null;
  cancelRequestedAt: string | null;
  cancelReason: string | null;
  cancelSentAt: string | null;
  createdAt: string;
  updatedAt: string;
}
const MANDATE_COLUMNS = columns({
  id: 'm.id',
  lenderId: 'm.lender_org_id',
  loanAccountId: 'm.loan_account_id',
  rail: 'm.rail',
  status: 'm.status',
  provider: 'm.provider',
  providerMode: 'm.provider_mode',
  providerMandateRef: 'm.provider_mandate_ref',
  maxAmountMinor: 'm.max_amount_minor::text',
  startDate: day('m.start_date'),
  endDate: day('m.end_date'),
  maskedAccountRef: 'm.masked_account_ref',
  needsAfaEachDebit: 'm.needs_afa_each_debit',
  handoffExpiresAt: ts('m.handoff_expires_at'),
  lastEventAt: ts('m.last_event_at'),
  cancelRequestedAt: ts('m.cancel_requested_at'),
  cancelReason: 'm.cancel_reason',
  cancelSentAt: ts('m.cancel_sent_at'),
  createdAt: ts('m.created_at'),
  updatedAt: ts('m.updated_at'),
});
const mapMandate = (r: MandateRow) => ({
  id: r.id,
  lenderId: r.lenderId,
  loanAccountId: r.loanAccountId,
  rail: r.rail,
  status: r.status,
  provider: r.provider,
  providerMode: r.providerMode,
  providerMandateRef: r.providerMandateRef,
  maxAmountMinor: paise(r.maxAmountMinor),
  startDate: r.startDate,
  endDate: r.endDate,
  maskedAccountRef: r.maskedAccountRef,
  needsAfaEachDebit: r.needsAfaEachDebit,
  handoffExpiresAt: r.handoffExpiresAt,
  lastEventAt: r.lastEventAt,
  cancelRequestedAt: r.cancelRequestedAt,
  cancelReason: r.cancelReason,
  cancelSentAt: r.cancelSentAt,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

interface MandateEventRow {
  id: string;
  fromStatus: string | null;
  toStatus: string;
  source: string;
  providerEventId: string | null;
  observedAt: string;
  createdAt: string;
}
const MANDATE_EVENT_COLUMNS = columns({
  id: 'x.id',
  fromStatus: 'x.from_status',
  toStatus: 'x.to_status',
  source: 'x.source',
  providerEventId: 'x.provider_event_id',
  observedAt: ts('x.observed_at'),
  createdAt: ts('x.created_at'),
});
const mapMandateEvent = (r: MandateEventRow) => ({
  id: r.id,
  fromStatus: r.fromStatus,
  toStatus: r.toStatus,
  source: r.source,
  providerEventId: r.providerEventId,
  observedAt: r.observedAt,
  createdAt: r.createdAt,
});

interface DebitRow {
  id: string;
  lenderId: string;
  mandateId: string;
  loanAccountId: string;
  planned: boolean;
  installmentSeq: number | null;
  scheduledOn: string;
  amountMinor: string | null;
  status: string;
  providerDebitRef: string | null;
  returnCode: string | null;
  returnClass: string | null;
  exceedsMandateMax: boolean;
  createdAt: string;
  updatedAt: string;
}
const DEBIT_COLUMNS = columns({
  id: 'd.id',
  lenderId: 'd.lender_org_id',
  mandateId: 'd.mandate_id',
  loanAccountId: 'd.loan_account_id',
  planned: 'd.planned',
  installmentSeq: 'd.installment_seq',
  scheduledOn: day('d.scheduled_on'),
  amountMinor: 'd.amount_minor::text',
  status: 'd.status',
  providerDebitRef: 'd.provider_debit_ref',
  returnCode: 'd.return_code',
  returnClass: 'd.return_class',
  exceedsMandateMax: 'd.exceeds_mandate_max',
  createdAt: ts('d.created_at'),
  updatedAt: ts('d.updated_at'),
});
const mapDebit = (r: DebitRow) => ({
  id: r.id,
  lenderId: r.lenderId,
  mandateId: r.mandateId,
  loanAccountId: r.loanAccountId,
  planned: r.planned,
  installmentSeq: r.installmentSeq,
  scheduledOn: r.scheduledOn,
  amountMinor: paiseOrNull(r.amountMinor),
  status: r.status,
  providerDebitRef: r.providerDebitRef,
  returnCode: r.returnCode,
  returnClass: r.returnClass,
  exceedsMandateMax: r.exceedsMandateMax,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});
/** Debits are paged by scheduled date, newest first; the cursor carries the date as midnight UTC so it parses like the others. */
const debitCursor = (r: DebitRow) => encodeCursor({ t: `${r.scheduledOn} 00:00:00+00`, id: r.id });

interface NoticeRow {
  id: string;
  debitId: string;
  noticeDueAt: string;
  status: string;
  deliveryState: string | null;
  sentAt: string | null;
}
const NOTICE_COLUMNS = columns({
  id: 'n.id',
  debitId: 'n.debit_id',
  noticeDueAt: ts('n.notice_due_at'),
  status: 'n.status',
  deliveryState: 'n.delivery_state',
  sentAt: ts('n.sent_at'),
});
const mapNotice = (r: NoticeRow) => ({
  id: r.id,
  debitId: r.debitId,
  noticeDueAt: r.noticeDueAt,
  status: r.status,
  deliveryState: r.deliveryState,
  sentAt: r.sentAt,
});

// The jsonb a reconciliation run keeps (written only by the run function). Read defensively: a missing key is null, not zero.
const DbCounts = z.object({
  payments_considered: z.number().int().optional(),
  matched_to_settlement: z.number().int().optional(),
  matched_to_bank: z.number().int().optional(),
  matched_to_receipt: z.number().int().optional(),
});
const DbReport = z.object({
  run_date: z.string().optional(),
  payments_considered: z.number().int().optional(),
  matched: z
    .object({
      settlement: z.number().int().optional(),
      bank: z.number().int().optional(),
      receipt: z.number().int().optional(),
    })
    .optional(),
  not_reconcilable: z.array(z.string()).optional(),
  settled_to_non_lender: z
    .object({ items: z.number().int().optional(), minor: z.number().int().optional() })
    .optional(),
  settlement_evidence: z
    .object({
      settlement_report_exists: z.boolean().optional(),
      off_account_batches: z.number().int().optional(),
      off_account_net_minor: z.number().int().optional(),
      destination_unstated_batches: z.number().int().optional(),
      destination_unstated_minor: z.number().int().optional(),
      destination_unstated_net_minor: z.number().int().optional(),
      zero_is_evidence: z.boolean().optional(),
    })
    .optional(),
  settings: z
    .object({
      settlement_lag_days: z.number().int().optional(),
      receipt_lag_hours: z.number().int().optional(),
      above_platform_default: z.boolean().optional(),
    })
    .optional(),
});
function mapCounts(raw: unknown) {
  const c = DbCounts.parse(raw);
  return {
    paymentsConsidered: c.payments_considered ?? null,
    matchedToSettlement: c.matched_to_settlement ?? null,
    matchedToBank: c.matched_to_bank ?? null,
    matchedToReceipt: c.matched_to_receipt ?? null,
  };
}
function mapReport(raw: unknown) {
  const r = DbReport.parse(raw);
  return {
    runDate: r.run_date ?? null,
    paymentsConsidered: r.payments_considered ?? null,
    matched: {
      settlement: r.matched?.settlement ?? null,
      bank: r.matched?.bank ?? null,
      receipt: r.matched?.receipt ?? null,
    },
    notReconcilable: r.not_reconcilable ?? [],
    settledToNonLender: {
      items: r.settled_to_non_lender?.items ?? null,
      minor: r.settled_to_non_lender?.minor ?? null,
    },
    // What the standing line rests on. A key the run did not write (a run made before migration 922) is null, never zero or false:
    // the portal treats only an explicit true as evidence.
    settlementEvidence: {
      settlementReportExists: r.settlement_evidence?.settlement_report_exists ?? null,
      offAccountBatches: r.settlement_evidence?.off_account_batches ?? null,
      offAccountNetMinor: r.settlement_evidence?.off_account_net_minor ?? null,
      destinationUnstatedBatches: r.settlement_evidence?.destination_unstated_batches ?? null,
      destinationUnstatedMinor: r.settlement_evidence?.destination_unstated_minor ?? null,
      destinationUnstatedNetMinor: r.settlement_evidence?.destination_unstated_net_minor ?? null,
      zeroIsEvidence: r.settlement_evidence?.zero_is_evidence ?? null,
    },
    settings: {
      settlementLagDays: r.settings?.settlement_lag_days ?? null,
      receiptLagHours: r.settings?.receipt_lag_hours ?? null,
      abovePlatformDefault: r.settings?.above_platform_default ?? null,
    },
  };
}

interface RunRow {
  id: string;
  lenderId: string;
  runDate: string;
  runNo: number;
  counts: unknown;
  createdAt: string;
}
const RUN_COLUMNS = columns({
  id: 'r.id',
  lenderId: 'r.lender_org_id',
  runDate: day('r.run_date'),
  runNo: 'r.run_no',
  counts: 'r.counts',
  createdAt: ts('r.created_at'),
});
const mapRun = (r: RunRow) => ({
  id: r.id,
  lenderId: r.lenderId,
  runDate: r.runDate,
  runNo: r.runNo,
  counts: mapCounts(r.counts),
  createdAt: r.createdAt,
});

interface BatchRow {
  id: string;
  lenderId: string;
  provider: string;
  batchRef: string;
  settlementRef: string;
  periodFrom: string;
  periodTo: string;
  destinationMaskedRef: string | null;
  destinationOk: boolean | null;
  grossMinor: string;
  feeMinor: string;
  taxMinor: string;
  netMinor: string;
  partsMismatch: boolean;
  itemCount: number;
  reportDate: string;
  receivedAt: string;
}
const BATCH_COLUMNS = columns({
  id: 'b.id',
  lenderId: 'b.lender_org_id',
  provider: 'b.provider',
  batchRef: 'b.batch_ref',
  settlementRef: 'b.settlement_ref',
  periodFrom: day('b.period_from'),
  periodTo: day('b.period_to'),
  destinationMaskedRef: 'b.destination_masked_ref',
  destinationOk: 'b.destination_ok',
  grossMinor: 'b.gross_minor::text',
  feeMinor: 'b.fee_minor::text',
  taxMinor: 'b.tax_minor::text',
  netMinor: 'b.net_minor::text',
  partsMismatch: 'b.parts_mismatch',
  itemCount: 'b.item_count',
  reportDate: day('b.report_date'),
  receivedAt: ts('b.received_at'),
});
const mapBatch = (r: BatchRow) => ({
  id: r.id,
  lenderId: r.lenderId,
  provider: r.provider,
  batchRef: r.batchRef,
  settlementRef: r.settlementRef,
  periodFrom: r.periodFrom,
  periodTo: r.periodTo,
  destinationMaskedRef: r.destinationMaskedRef,
  destinationOk: r.destinationOk,
  grossMinor: paise(r.grossMinor),
  feeMinor: paise(r.feeMinor),
  taxMinor: paise(r.taxMinor),
  netMinor: paise(r.netMinor),
  partsMismatch: r.partsMismatch,
  itemCount: r.itemCount,
  reportDate: r.reportDate,
  receivedAt: r.receivedAt,
});

interface ItemRow {
  id: string;
  providerPaymentRef: string;
  orderRef: string | null;
  grossMinor: string;
  feeMinor: string;
  taxMinor: string;
  netMinor: string;
  partsMismatch: boolean;
}
const ITEM_COLUMNS = columns({
  id: 'i.id',
  providerPaymentRef: 'i.provider_payment_ref',
  orderRef: 'i.order_ref',
  grossMinor: 'i.gross_minor::text',
  feeMinor: 'i.fee_minor::text',
  taxMinor: 'i.tax_minor::text',
  netMinor: 'i.net_minor::text',
  partsMismatch: 'i.parts_mismatch',
});
const mapItem = (r: ItemRow) => ({
  id: r.id,
  providerPaymentRef: r.providerPaymentRef,
  orderRef: r.orderRef,
  grossMinor: paise(r.grossMinor),
  feeMinor: paise(r.feeMinor),
  taxMinor: paise(r.taxMinor),
  netMinor: paise(r.netMinor),
  partsMismatch: r.partsMismatch,
});

interface ExceptionRow {
  id: string;
  lenderId: string;
  class: string;
  severity: string;
  owner: string;
  status: string;
  subject: Record<string, string>;
  assignedTo: string | null;
  openedAt: string;
  resolvedAt: string | null;
  updatedAt: string;
}
const EXCEPTION_COLUMNS = columns({
  id: 'x.id',
  lenderId: 'x.lender_org_id',
  class: 'x.class',
  severity: 'x.severity',
  owner: 'x.owner',
  status: 'x.status',
  subject: 'x.subject',
  assignedTo: 'x.assigned_to',
  openedAt: ts('x.opened_at'),
  resolvedAt: ts('x.resolved_at'),
  updatedAt: ts('x.updated_at'),
});
const mapException = (r: ExceptionRow) => ({
  id: r.id,
  lenderId: r.lenderId,
  class: r.class,
  severity: r.severity,
  owner: r.owner,
  status: r.status,
  subject: r.subject,
  assignedTo: r.assignedTo,
  openedAt: r.openedAt,
  resolvedAt: r.resolvedAt,
  updatedAt: r.updatedAt,
});

interface ExceptionEventRow {
  id: string;
  action: string;
  actorKind: string;
  actorUserId: string | null;
  reasonCode: string | null;
  evidence: string[] | null;
  note: string | null;
  assignedTo: string | null;
  authorisedByPermission: string | null;
  occurredAt: string;
}
const EXCEPTION_EVENT_COLUMNS = columns({
  id: 'v.id',
  action: 'v.action',
  actorKind: 'v.actor_kind',
  actorUserId: 'v.actor_user_id',
  reasonCode: 'v.reason_code',
  evidence: 'v.evidence',
  note: 'v.note',
  assignedTo: 'v.assigned_to',
  authorisedByPermission: 'v.authorised_by_permission',
  occurredAt: ts('v.occurred_at'),
});
const mapExceptionEvent = (r: ExceptionEventRow) => ({
  id: r.id,
  action: r.action,
  actorKind: r.actorKind,
  actorUserId: r.actorUserId,
  reasonCode: r.reasonCode,
  evidence: r.evidence,
  note: r.note,
  assignedTo: r.assignedTo,
  authorisedByPermission: r.authorisedByPermission,
  occurredAt: r.occurredAt,
});

/** Settlement items have no timestamp; they are paged by their time-ordered identifier. */
const IdCursor = z.strictObject({ id: z.uuid() });
function decodeIdCursor(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  try {
    return IdCursor.parse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))).id;
  } catch {
    throw new ApiError(400, 'invalid_cursor', 'Bad Request', 'The cursor is not valid.');
  }
}
const encodeIdCursor = (id: string) =>
  Buffer.from(JSON.stringify({ id }), 'utf8').toString('base64url');

const POLICY_LIST_LIMIT = 200;

/**
 * The routes. Lender users and platform staff are both `auth: 'staff'` (a second factor is always required); what each may
 * read or write is decided by the permissions and row level security in the database.
 */
export function lenderPaymentsRoutes(_deps: Record<string, never>): RouteDefinition[] {
  void _deps;
  return [
    // ---- payments -------------------------------------------------------------------------------------------------
    userRoute({
      method: 'get',
      path: '/v1/lender/payments',
      operationId: 'listLenderPayments',
      summary: 'Payment requests of your borrowers, newest first',
      description:
        'Needs payment.read. Each row is one payment a borrower asked to make on a loan of yours, with the status the verified provider events and the expiry sweep gave it. No borrower identity is returned; the loan account is the link. Use the detail route for the provider payments, adjustments and the derived settlement stage.',
      tags: ['Payments (lender)'],
      auth: 'staff',
      query: LpPaymentListQuery,
      responses: { 200: LpPaymentPage },
      errors: [400, 401, 403, 422],
      rateLimit: READ_LIMIT,
      handler: async ({ tx, query }) => {
        await requireReader(tx, READ, query.lenderId);
        const w = new Where();
        if (query.lenderId) w.add((p) => `i.lender_org_id = ${p}::uuid`, query.lenderId);
        if (query.status) w.add((p) => `i.status = ${p}::payments.intent_status`, query.status);
        if (query.purpose) w.add((p) => `i.purpose = ${p}::payments.intent_purpose`, query.purpose);
        if (query.loanAccountId)
          w.add((p) => `i.loan_account_id = ${p}::uuid`, query.loanAccountId);
        olderThan(w, query.cursor, 'i.created_at', 'i.id');
        const limit = w.placeholder(query.limit + 1);
        const r = await tx.query<IntentRow>(
          `select ${INTENT_COLUMNS} from payments.payment_intents i where ${w.sql}
            order by i.created_at desc, i.id desc limit ${limit}::int`,
          w.values,
        );
        return {
          status: 200,
          body: pageOf(r.rows, query.limit, mapIntent, (row) =>
            encodeCursor({ t: row.createdAt, id: row.id }),
          ),
        };
      },
    }),
    userRoute({
      method: 'get',
      path: '/v1/lender/payments/:id',
      operationId: 'getLenderPayment',
      summary:
        'One payment request with the provider payments, the refunds and chargebacks, and the derived settlement stage',
      description:
        "Needs payment.read; another lender's payment answers 404. The stage of each successful provider payment (captured, settled, bank-confirmed, posted by the lender) is derived from the tables: nothing sets it and no function accepts one.",
      tags: ['Payments (lender)'],
      auth: 'staff',
      params: Id,
      responses: { 200: LpPaymentDetail },
      errors: [401, 403, 404],
      rateLimit: READ_LIMIT,
      handler: async ({ tx, params }) => {
        await requireReader(tx, READ, undefined);
        const intent = await tx.query<IntentRow>(
          `select ${INTENT_COLUMNS} from payments.payment_intents i where i.id = $1::uuid`,
          [params.id],
        );
        const row = intent.rows[0];
        if (!row) throw notFound();
        const payments = await tx.query<ProviderPaymentRow>(
          `select ${PROVIDER_PAYMENT_COLUMNS}
             from payments.provider_payments p
             left join payments.payment_stages s on s.provider_payment_id = p.id
            where p.intent_id = $1::uuid order by p.created_at, p.id limit 200`,
          [params.id],
        );
        const adjustments = await tx.query<AdjustmentRow>(
          `select ${ADJUSTMENT_COLUMNS} from payments.payment_adjustments a
            where a.provider_payment_id in (select p.id from payments.provider_payments p where p.intent_id = $1::uuid)
            order by a.occurred_at, a.id limit 200`,
          [params.id],
        );
        return {
          status: 200,
          body: {
            payment: mapIntent(row),
            providerPayments: payments.rows.map(mapProviderPayment),
            adjustments: adjustments.rows.map(mapAdjustment),
          },
        };
      },
    }),

    // ---- verified provider events ---------------------------------------------------------------------------------
    userRoute({
      method: 'get',
      path: '/v1/lender/provider-events',
      operationId: 'listLenderProviderEvents',
      summary: 'Verified provider events and what happened when they were applied, newest first',
      description:
        'Needs payment.read. Only events that passed authentication, integrity, correlation and business validation are stored here; an event of a kind the platform does not support is listed as ignored. Never a payload, a payload hash, a signature or an address.',
      tags: ['Payments (lender)'],
      auth: 'staff',
      query: LpProviderEventListQuery,
      responses: { 200: LpProviderEventPage },
      errors: [400, 401, 403, 422],
      rateLimit: READ_LIMIT,
      handler: async ({ tx, query }) => {
        await requireReader(tx, READ, query.lenderId);
        const w = new Where();
        if (query.lenderId) w.add((p) => `e.lender_org_id = ${p}::uuid`, query.lenderId);
        if (query.objectKind) w.add((p) => `e.object_kind = ${p}`, query.objectKind);
        if (query.paymentIntentId)
          w.add((p) => `e.payment_intent_id = ${p}::uuid`, query.paymentIntentId);
        olderThan(w, query.cursor, 'e.received_at', 'e.id');
        const limit = w.placeholder(query.limit + 1);
        const r = await tx.query<EventRow>(
          `select ${EVENT_COLUMNS}
             from payments.provider_events e
             left join lateral (select ep.* from payments.event_processing ep where ep.event_id = e.id
                                 order by ep.processed_at desc, ep.id desc limit 1) p on true
            where ${w.sql} order by e.received_at desc, e.id desc limit ${limit}::int`,
          w.values,
        );
        return {
          status: 200,
          body: pageOf(r.rows, query.limit, mapEvent, (row) =>
            encodeCursor({ t: row.receivedAt, id: row.id }),
          ),
        };
      },
    }),
    userRoute({
      method: 'get',
      path: '/v1/lender/webhook-summary',
      operationId: 'getLenderWebhookSummary',
      summary: 'How many provider callbacks reached your payment configurations, by outcome',
      description:
        'Needs payment.read of that lender. Counts and the time of the last delivery only: never a delivery, a hash or an address. Deliveries for an unknown token belong to no lender and appear nowhere.',
      tags: ['Payments (lender)'],
      auth: 'staff',
      query: LpWebhookSummaryQuery,
      responses: { 200: LpWebhookSummary },
      errors: [401, 403],
      rateLimit: READ_LIMIT,
      handler: async ({ tx, query }) => {
        await requireReader(tx, READ, query.lenderId);
        const r = await tx.query<{
          outcome: string;
          receipts: string;
          lastReceivedAt: string | null;
        }>(
          `select outcome, receipts::text as receipts, ${ts('last_received_at')} as "lastReceivedAt"
             from payments.lender_webhook_summary($1::uuid)`,
          [query.lenderId],
        );
        return {
          status: 200,
          body: {
            lenderId: query.lenderId,
            items: r.rows.map((x) => ({
              outcome: x.outcome,
              receipts: count(x.receipts),
              lastReceivedAt: x.lastReceivedAt,
            })),
          },
        };
      },
    }),

    // ---- policies and settings ------------------------------------------------------------------------------------
    userRoute({
      method: 'get',
      path: '/v1/lender/payment-policy',
      operationId: 'listLenderPaymentPolicies',
      summary:
        'What your lenders accept as a payment: partial amounts, part-prepayments and link validity',
      description:
        'Needs payment.read, payment.configure or payment.config.approve. A lender with no row accepts the exact reported figure only and no part-prepayment (the database default); this list shows only rows that were set.',
      tags: ['Payments (lender)'],
      auth: 'staff',
      query: LpLenderFilterQuery,
      responses: { 200: LpPaymentPolicyList },
      errors: [401, 403, 422],
      rateLimit: READ_LIMIT,
      handler: async ({ tx, query }) => {
        await requireReader(tx, READ_POLICY, query.lenderId);
        const r = await tx.query<{
          lenderId: string;
          allowPartialPayments: boolean;
          minPartialAmountMinor: string | null;
          allowPartPrepayment: boolean;
          minPartPrepaymentMinor: string | null;
          linkValidityMinutes: number;
          updatedAt: string;
        }>(
          `select ${columns({
            lenderId: 'p.lender_org_id',
            allowPartialPayments: 'p.allow_partial_payments',
            minPartialAmountMinor: 'p.min_partial_amount_minor::text',
            allowPartPrepayment: 'p.allow_part_prepayment',
            minPartPrepaymentMinor: 'p.min_part_prepayment_minor::text',
            linkValidityMinutes: 'p.link_validity_minutes',
            updatedAt: ts('p.updated_at'),
          })}
             from payments.lender_payment_policies p
            where ($1::uuid is null or p.lender_org_id = $1::uuid)
            order by p.lender_org_id limit ${String(POLICY_LIST_LIMIT)}`,
          [query.lenderId ?? null],
        );
        return {
          status: 200,
          body: {
            items: r.rows.map((x) => ({
              lenderId: x.lenderId,
              allowPartialPayments: x.allowPartialPayments,
              minPartialAmountMinor: paiseOrNull(x.minPartialAmountMinor),
              allowPartPrepayment: x.allowPartPrepayment,
              minPartPrepaymentMinor: paiseOrNull(x.minPartPrepaymentMinor),
              linkValidityMinutes: x.linkValidityMinutes,
              updatedAt: x.updatedAt,
            })),
          },
        };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/lender/payment-policy',
      operationId: 'setLenderPaymentPolicy',
      summary:
        'Set what you accept as a payment (partial amounts, part-prepayments, link validity)',
      description:
        'Needs payment.configure of that lender and a second factor. Udofin decides no amount: this records what the lender accepts. A change applies to payments requested afterwards. A minimum is required exactly when its switch is on; the database refuses anything else with policy_invalid.',
      tags: ['Payments (lender)'],
      auth: 'staff',
      idempotent: true,
      idempotencyTenant: ({ body }) => (body as { lenderId: string }).lenderId,
      body: LpPaymentPolicyInput,
      responses: { 200: LpSetResult },
      errors: [400, 401, 403, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, body }) => {
        const r = await tx.query<{ r: string }>(
          'select payments.set_payment_policy($1::uuid, $2::boolean, $3::bigint, $4::boolean, $5::bigint, $6::int) as r',
          [
            body.lenderId,
            body.allowPartialPayments,
            body.minPartialAmountMinor ?? null,
            body.allowPartPrepayment,
            body.minPartPrepaymentMinor ?? null,
            body.linkValidityMinutes,
          ],
        );
        return { status: 200, body: { outcome: first(r.rows) } };
      },
    }),
    userRoute({
      method: 'get',
      path: '/v1/lender/mandate-policy',
      operationId: 'listLenderMandatePolicies',
      summary:
        'Your mandate settings: requirement, ceiling on one debit and the pre-debit notice lead time',
      description:
        'Needs payment.read. Only rows that were set are listed. The requirement is informational: no loan operation is blocked in Phase 08a.',
      tags: ['Mandates (lender)'],
      auth: 'staff',
      query: LpLenderFilterQuery,
      responses: { 200: LpMandatePolicyList },
      errors: [401, 403, 422],
      rateLimit: READ_LIMIT,
      handler: async ({ tx, query }) => {
        await requireReader(tx, READ, query.lenderId);
        const r = await tx.query<{
          lenderId: string;
          requirement: string;
          maxAmountCapMinor: string | null;
          preDebitLeadHours: number;
          updatedAt: string;
        }>(
          `select ${columns({
            lenderId: 'p.lender_org_id',
            requirement: 'p.requirement',
            maxAmountCapMinor: 'p.max_amount_cap_minor::text',
            preDebitLeadHours: 'p.pre_debit_lead_hours',
            updatedAt: ts('p.updated_at'),
          })}
             from payments.lender_mandate_policies p
            where ($1::uuid is null or p.lender_org_id = $1::uuid)
            order by p.lender_org_id limit ${String(POLICY_LIST_LIMIT)}`,
          [query.lenderId ?? null],
        );
        return {
          status: 200,
          body: {
            items: r.rows.map((x) => ({
              lenderId: x.lenderId,
              requirement: x.requirement,
              maxAmountCapMinor: paiseOrNull(x.maxAmountCapMinor),
              preDebitLeadHours: x.preDebitLeadHours,
              updatedAt: x.updatedAt,
            })),
          },
        };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/lender/mandate-policy',
      operationId: 'setLenderMandatePolicy',
      summary: 'Set your mandate settings',
      description:
        'Needs payment.configure of that lender and a second factor. A change affects mandates requested later and never edits an existing mandate. The database refuses a lead time outside its range and a ceiling outside the paise range with policy_invalid.',
      tags: ['Mandates (lender)'],
      auth: 'staff',
      idempotent: true,
      idempotencyTenant: ({ body }) => (body as { lenderId: string }).lenderId,
      body: LpMandatePolicyInput,
      responses: { 200: LpSetResult },
      errors: [400, 401, 403, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, body }) => {
        const r = await tx.query<{ r: string }>(
          'select payments.set_mandate_policy($1::uuid, $2, $3::bigint, $4::int) as r',
          [body.lenderId, body.requirement, body.maxAmountCapMinor ?? null, body.preDebitLeadHours],
        );
        return { status: 200, body: { outcome: first(r.rows) } };
      },
    }),

    // ---- mandates -------------------------------------------------------------------------------------------------
    userRoute({
      method: 'get',
      path: '/v1/lender/mandates',
      operationId: 'listLenderMandates',
      summary:
        'Mandates of your borrowers with the status the provider last confirmed, newest first',
      description:
        "Needs payment.read. A draft or pending mandate is shown as such: nothing is active until the provider says so. The borrower's account appears only as the masked reference the borrower supplied. No borrower identity is returned.",
      tags: ['Mandates (lender)'],
      auth: 'staff',
      query: LpMandateListQuery,
      responses: { 200: LpMandatePage },
      errors: [400, 401, 403, 422],
      rateLimit: READ_LIMIT,
      handler: async ({ tx, query }) => {
        await requireReader(tx, READ, query.lenderId);
        const w = new Where();
        if (query.lenderId) w.add((p) => `m.lender_org_id = ${p}::uuid`, query.lenderId);
        if (query.status) w.add((p) => `m.status = ${p}`, query.status);
        if (query.loanAccountId)
          w.add((p) => `m.loan_account_id = ${p}::uuid`, query.loanAccountId);
        olderThan(w, query.cursor, 'm.created_at', 'm.id');
        const limit = w.placeholder(query.limit + 1);
        const r = await tx.query<MandateRow>(
          `select ${MANDATE_COLUMNS} from payments.mandates m where ${w.sql}
            order by m.created_at desc, m.id desc limit ${limit}::int`,
          w.values,
        );
        return {
          status: 200,
          body: pageOf(r.rows, query.limit, mapMandate, (row) =>
            encodeCursor({ t: row.createdAt, id: row.id }),
          ),
        };
      },
    }),
    userRoute({
      method: 'get',
      path: '/v1/lender/mandates/:id',
      operationId: 'getLenderMandate',
      summary: 'One mandate with its status history, its newest debits and the pre-debit notices',
      description:
        "Needs payment.read; another lender's mandate answers 404. Each history row names its source (the request, the hand-off, a verified provider event, an authenticated status lookup or a time rule). The newest 100 history rows, 60 debits and 60 notices are returned; the complete debit list is GET /v1/lender/mandate-debits?mandateId=.",
      tags: ['Mandates (lender)'],
      auth: 'staff',
      params: Id,
      responses: { 200: LpMandateDetail },
      errors: [401, 403, 404],
      rateLimit: READ_LIMIT,
      handler: async ({ tx, params }) => {
        await requireReader(tx, READ, undefined);
        const mandate = await tx.query<MandateRow>(
          `select ${MANDATE_COLUMNS} from payments.mandates m where m.id = $1::uuid`,
          [params.id],
        );
        const row = mandate.rows[0];
        if (!row) throw notFound();
        const events = await tx.query<MandateEventRow>(
          `select ${MANDATE_EVENT_COLUMNS} from payments.mandate_events x
            where x.mandate_id = $1::uuid order by x.created_at desc, x.id desc limit 100`,
          [params.id],
        );
        const debits = await tx.query<DebitRow>(
          `select ${DEBIT_COLUMNS} from payments.mandate_debits d
            where d.mandate_id = $1::uuid order by d.scheduled_on desc, d.id desc limit 60`,
          [params.id],
        );
        const notices = await tx.query<NoticeRow>(
          `select ${NOTICE_COLUMNS} from payments.pre_debit_notices n
            where n.mandate_id = $1::uuid order by n.notice_due_at desc, n.id desc limit 60`,
          [params.id],
        );
        return {
          status: 200,
          body: {
            mandate: mapMandate(row),
            events: events.rows.map(mapMandateEvent),
            debits: debits.rows.map(mapDebit),
            notices: notices.rows.map(mapNotice),
          },
        };
      },
    }),
    userRoute({
      method: 'get',
      path: '/v1/lender/mandate-debits',
      operationId: 'listLenderMandateDebits',
      summary: 'Debits of your mandates (planned and reported), newest scheduled date first',
      description:
        "Needs payment.read. A planned debit is what Udofin expects from your reported schedule; an unplanned one is what the provider reported. The return code is the provider's own and is stored verbatim; its class is shown only when a class was set for that code. Udofin presents no debit.",
      tags: ['Mandates (lender)'],
      auth: 'staff',
      query: LpMandateDebitListQuery,
      responses: { 200: LpMandateDebitPage },
      errors: [400, 401, 403, 422],
      rateLimit: READ_LIMIT,
      handler: async ({ tx, query }) => {
        await requireReader(tx, READ, query.lenderId);
        const w = new Where();
        if (query.lenderId) w.add((p) => `d.lender_org_id = ${p}::uuid`, query.lenderId);
        if (query.mandateId) w.add((p) => `d.mandate_id = ${p}::uuid`, query.mandateId);
        if (query.loanAccountId)
          w.add((p) => `d.loan_account_id = ${p}::uuid`, query.loanAccountId);
        if (query.status) w.add((p) => `d.status = ${p}`, query.status);
        if (query.planned) w.add((p) => `d.planned = ${p}::boolean`, query.planned === 'true');
        const c = decodeCursor(query.cursor);
        if (c) {
          const t = w.placeholder(c.t);
          const i = w.placeholder(c.id);
          w.raw(
            `(d.scheduled_on, d.id) < ((${t}::timestamptz at time zone 'UTC')::date, ${i}::uuid)`,
          );
        }
        const limit = w.placeholder(query.limit + 1);
        const r = await tx.query<DebitRow>(
          `select ${DEBIT_COLUMNS} from payments.mandate_debits d where ${w.sql}
            order by d.scheduled_on desc, d.id desc limit ${limit}::int`,
          w.values,
        );
        return { status: 200, body: pageOf(r.rows, query.limit, mapDebit, debitCursor) };
      },
    }),

    // ---- reconciliation -------------------------------------------------------------------------------------------
    userRoute({
      method: 'get',
      path: '/v1/lender/reconciliation/runs',
      operationId: 'listLenderReconciliationRuns',
      summary: 'Reconciliation runs of your lenders, newest first',
      description:
        'Needs payment.read. A run on unchanged inputs returns the same run; changed inputs make the next run number for that date. Use the summary route for the report of a date.',
      tags: ['Reconciliation (lender)'],
      auth: 'staff',
      query: LpRunListQuery,
      responses: { 200: LpRunPage },
      errors: [400, 401, 403, 422],
      rateLimit: READ_LIMIT,
      handler: async ({ tx, query }) => {
        await requireReader(tx, READ, query.lenderId);
        const w = new Where();
        if (query.lenderId) w.add((p) => `r.lender_org_id = ${p}::uuid`, query.lenderId);
        if (query.date) w.add((p) => `r.run_date = ${p}::date`, query.date);
        olderThan(w, query.cursor, 'r.created_at', 'r.id');
        const limit = w.placeholder(query.limit + 1);
        const r = await tx.query<RunRow>(
          `select ${RUN_COLUMNS} from payments.reconciliation_runs r where ${w.sql}
            order by r.created_at desc, r.id desc limit ${limit}::int`,
          w.values,
        );
        return {
          status: 200,
          body: pageOf(r.rows, query.limit, mapRun, (row) =>
            encodeCursor({ t: row.createdAt, id: row.id }),
          ),
        };
      },
    }),
    userRoute({
      method: 'get',
      path: '/v1/lender/reconciliation/summary',
      operationId: 'getLenderReconciliationSummary',
      summary: 'The newest reconciliation run of a lender for a date, with its counts and report',
      description:
        "Needs payment.read of that lender. What a run could not check is listed under notReconcilable and never reported as reconciled. settledToNonLender is the standing line: provider settlements to an account that is not the lender's verified one; anything but zero is a critical finding. No run for the date answers 404.",
      tags: ['Reconciliation (lender)'],
      auth: 'staff',
      query: LpReconciliationSummaryQuery,
      responses: { 200: LpReconciliationSummary },
      errors: [401, 403, 404, 422],
      rateLimit: READ_LIMIT,
      handler: async ({ tx, query }) => {
        await requireReader(tx, READ, query.lenderId);
        const r = await tx.query<{
          runId: string;
          runNo: number;
          runDate: string;
          counts: unknown;
          report: unknown;
          createdAt: string;
        }>(
          `select run_id as "runId", run_no as "runNo", ${day('run_date')} as "runDate", counts, report, ${ts('created_at')} as "createdAt"
             from payments.reconciliation_summary($1::uuid, $2::date)`,
          [query.lenderId, query.date],
        );
        const row = r.rows[0];
        if (!row) throw notFound();
        return {
          status: 200,
          body: {
            runId: row.runId,
            lenderId: query.lenderId,
            runNo: row.runNo,
            runDate: row.runDate,
            counts: mapCounts(row.counts),
            report: mapReport(row.report),
            createdAt: row.createdAt,
          },
        };
      },
    }),
    userRoute({
      method: 'get',
      path: '/v1/lender/reconciliation/settlement-batches',
      operationId: 'listLenderSettlementBatches',
      summary: 'Settlement batches as the provider reported them, newest first',
      description:
        'Needs payment.read. Amounts are stored as reported and never recomputed; partsMismatch flags a batch whose parts do not add up, destinationOk=false a batch reported to an account that is not your verified settlement account. `from` keeps batches whose period ends on or after that date, `to` those whose period starts on or before it.',
      tags: ['Reconciliation (lender)'],
      auth: 'staff',
      query: LpSettlementBatchListQuery,
      responses: { 200: LpSettlementBatchPage },
      errors: [400, 401, 403, 422],
      rateLimit: READ_LIMIT,
      handler: async ({ tx, query }) => {
        await requireReader(tx, READ, query.lenderId);
        const w = new Where();
        if (query.lenderId) w.add((p) => `b.lender_org_id = ${p}::uuid`, query.lenderId);
        if (query.from) w.add((p) => `b.period_to >= ${p}::date`, query.from);
        if (query.to) w.add((p) => `b.period_from <= ${p}::date`, query.to);
        olderThan(w, query.cursor, 'b.received_at', 'b.id');
        const limit = w.placeholder(query.limit + 1);
        const r = await tx.query<BatchRow>(
          `select ${BATCH_COLUMNS} from payments.settlement_batches b where ${w.sql}
            order by b.received_at desc, b.id desc limit ${limit}::int`,
          w.values,
        );
        return {
          status: 200,
          body: pageOf(r.rows, query.limit, mapBatch, (row) =>
            encodeCursor({ t: row.receivedAt, id: row.id }),
          ),
        };
      },
    }),
    userRoute({
      method: 'get',
      path: '/v1/lender/reconciliation/settlement-batches/:id',
      operationId: 'getLenderSettlementBatch',
      summary: 'One settlement batch',
      description:
        "Needs payment.read; another lender's batch answers 404. The items are listed by the /items route.",
      tags: ['Reconciliation (lender)'],
      auth: 'staff',
      params: Id,
      responses: { 200: LpSettlementBatch },
      errors: [401, 403, 404],
      rateLimit: READ_LIMIT,
      handler: async ({ tx, params }) => {
        await requireReader(tx, READ, undefined);
        const r = await tx.query<BatchRow>(
          `select ${BATCH_COLUMNS} from payments.settlement_batches b where b.id = $1::uuid`,
          [params.id],
        );
        const row = r.rows[0];
        if (!row) throw notFound();
        return { status: 200, body: mapBatch(row) };
      },
    }),
    userRoute({
      method: 'get',
      path: '/v1/lender/reconciliation/settlement-batches/:id/items',
      operationId: 'listLenderSettlementItems',
      summary: 'The payments listed in one settlement batch, in the order they were stored',
      description:
        "Needs payment.read; another lender's batch answers 404. Fee and tax are the provider's own figures, stored as reported.",
      tags: ['Reconciliation (lender)'],
      auth: 'staff',
      params: Id,
      query: LpSettlementItemListQuery,
      responses: { 200: LpSettlementItemPage },
      errors: [400, 401, 403, 404, 422],
      rateLimit: READ_LIMIT,
      handler: async ({ tx, params, query }) => {
        await requireReader(tx, READ, undefined);
        const batch = await tx.query(
          'select 1 from payments.settlement_batches b where b.id = $1::uuid',
          [params.id],
        );
        if (batch.rows.length === 0) throw notFound();
        const after = decodeIdCursor(query.cursor);
        const r = await tx.query<ItemRow>(
          `select ${ITEM_COLUMNS} from payments.settlement_items i
            where i.batch_id = $1::uuid and ($2::uuid is null or i.id > $2::uuid)
            order by i.id limit $3::int`,
          [params.id, after ?? null, query.limit + 1],
        );
        return {
          status: 200,
          body: pageOf(r.rows, query.limit, mapItem, (row) => encodeIdCursor(row.id)),
        };
      },
    }),
    userRoute({
      method: 'get',
      path: '/v1/lender/reconciliation/settings',
      operationId: 'listLenderReconciliationSettings',
      summary: 'How long reconciliation waits before it calls a missing item an exception',
      description:
        'Needs payment.read. Only rows that were set are listed; without a row the platform defaults apply, and those defaults have no source on file.',
      tags: ['Reconciliation (lender)'],
      auth: 'staff',
      query: LpLenderFilterQuery,
      responses: { 200: LpReconciliationSettingsList },
      errors: [401, 403, 422],
      rateLimit: READ_LIMIT,
      handler: async ({ tx, query }) => {
        await requireReader(tx, READ, query.lenderId);
        const r = await tx.query<{
          lenderId: string;
          settlementLagDays: number;
          receiptLagHours: number;
          updatedAt: string;
        }>(
          `select ${columns({
            lenderId: 's.lender_org_id',
            settlementLagDays: 's.settlement_lag_days',
            receiptLagHours: 's.receipt_lag_hours',
            updatedAt: ts('s.updated_at'),
          })}
             from payments.reconciliation_settings s
            where ($1::uuid is null or s.lender_org_id = $1::uuid)
            order by s.lender_org_id limit ${String(POLICY_LIST_LIMIT)}`,
          [query.lenderId ?? null],
        );
        return {
          status: 200,
          body: {
            items: r.rows.map((x) => ({
              lenderId: x.lenderId,
              settlementLagDays: x.settlementLagDays,
              receiptLagHours: x.receiptLagHours,
              updatedAt: x.updatedAt,
            })),
          },
        };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/lender/reconciliation/settings',
      operationId: 'setLenderReconciliationSettings',
      summary: 'Set the waiting times of reconciliation',
      description:
        'Needs payment.configure of that lender and a second factor. Applies to runs made afterwards. The database refuses values outside its range with settings_invalid.',
      tags: ['Reconciliation (lender)'],
      auth: 'staff',
      idempotent: true,
      idempotencyTenant: ({ body }) => (body as { lenderId: string }).lenderId,
      body: LpReconciliationSettingsInput,
      responses: { 200: LpSetResult },
      errors: [400, 401, 403, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, body }) => {
        const r = await tx.query<{ r: string }>(
          'select payments.set_reconciliation_settings($1::uuid, $2::int, $3::int) as r',
          [body.lenderId, body.settlementLagDays, body.receiptLagHours],
        );
        return { status: 200, body: { outcome: first(r.rows) } };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/lender/reconciliation/bank-credits',
      operationId: 'importLenderBankCredits',
      summary:
        'Report credits that reached one of your settlement accounts (value date, amount, bank reference)',
      description:
        'Needs payment.reconcile of that lender and a second factor. Send the credits as `rows` (JSON) or as `csv` text with exactly the columns valueDate, amountMinor and utr. A narration, a name or any other column is never accepted: it refuses the WHOLE upload and nothing is stored, and the message names no value from the file. One bad row, a value date in the future, or a bank reference that differs from one already recorded also refuses everything. A repeated identical credit counts as a duplicate. At most 2,000 credits per upload.',
      tags: ['Reconciliation (lender)'],
      auth: 'staff',
      idempotent: true,
      idempotencyTenant: ({ body }) => (body as { lenderId: string }).lenderId,
      body: LpBankCreditsInput,
      responses: { 200: LpBankCreditsResult },
      errors: [400, 401, 403, 404, 409, 422],
      rateLimit: UPLOAD_LIMIT,
      bodyLimit: 600_000,
      handler: async ({ tx, body }) => {
        const credits =
          body.rows ?? (body.csv === undefined ? undefined : parseBankCreditsCsv(body.csv));
        if (!credits) {
          throw new ApiError(422, 'validation_failed', 'Unprocessable Content', 'rows: required');
        }
        // The database takes money as digit strings; this is a change of format, not a computation.
        const payload = credits.map((c) => ({
          valueDate: c.valueDate,
          amountMinor: String(c.amountMinor),
          utr: c.utr,
        }));
        const r = await tx.query<{ r: { inserted: number; duplicates: number } }>(
          'select payments.import_bank_credits($1::uuid, $2::uuid, $3::jsonb) as r',
          [body.lenderId, body.accountId, JSON.stringify(payload)],
        );
        const result = first(r.rows);
        return {
          status: 200,
          body: { inserted: result.inserted, duplicates: result.duplicates },
        };
      },
    }),

    // ---- the exception queue --------------------------------------------------------------------------------------
    userRoute({
      method: 'get',
      path: '/v1/lender/reconciliation/exceptions',
      operationId: 'listLenderReconciliationExceptions',
      summary: 'Exceptions raised for your lenders, newest first',
      description:
        'Needs payment.read or payment.reconcile (platform staff who run providers see every lender). Lender-owned exceptions are worked by payment.reconcile; platform-owned ones (merchant mismatch, payload conflict, settlement account mismatch) are visible to you but worked by platform staff. The subject holds identifiers only.',
      tags: ['Exceptions (lender)'],
      auth: 'staff',
      query: LpExceptionListQuery,
      responses: { 200: LpExceptionPage },
      errors: [400, 401, 403, 422],
      rateLimit: READ_LIMIT,
      handler: async ({ tx, query }) => {
        await requireReader(tx, READ_EXCEPTIONS, query.lenderId, true);
        const w = new Where();
        if (query.lenderId) w.add((p) => `x.lender_org_id = ${p}::uuid`, query.lenderId);
        if (query.status) w.add((p) => `x.status = ${p}`, query.status);
        if (query.class) w.add((p) => `x.class = ${p}`, query.class);
        if (query.severity) w.add((p) => `x.severity = ${p}`, query.severity);
        if (query.owner) w.add((p) => `x.owner = ${p}`, query.owner);
        olderThan(w, query.cursor, 'x.opened_at', 'x.id');
        const limit = w.placeholder(query.limit + 1);
        const r = await tx.query<ExceptionRow>(
          `select ${EXCEPTION_COLUMNS} from payments.reconciliation_exceptions x where ${w.sql}
            order by x.opened_at desc, x.id desc limit ${limit}::int`,
          w.values,
        );
        return {
          status: 200,
          body: pageOf(r.rows, query.limit, mapException, (row) =>
            encodeCursor({ t: row.openedAt, id: row.id }),
          ),
        };
      },
    }),
    userRoute({
      method: 'get',
      path: '/v1/lender/reconciliation/exceptions/:id',
      operationId: 'getLenderReconciliationException',
      summary: 'One exception with its history',
      description:
        'Needs payment.read or payment.reconcile of that lender (or platform.payments.providers.manage); anyone else gets 404. Every step of the history names who acted and under which permission.',
      tags: ['Exceptions (lender)'],
      auth: 'staff',
      params: Id,
      responses: { 200: LpExceptionDetail },
      errors: [401, 403, 404],
      rateLimit: READ_LIMIT,
      handler: async ({ tx, params }) => {
        await requireReader(tx, READ_EXCEPTIONS, undefined, true);
        const x = await tx.query<ExceptionRow>(
          `select ${EXCEPTION_COLUMNS} from payments.reconciliation_exceptions x where x.id = $1::uuid`,
          [params.id],
        );
        const row = x.rows[0];
        if (!row) throw notFound();
        const events = await tx.query<ExceptionEventRow>(
          `select ${EXCEPTION_EVENT_COLUMNS} from payments.reconciliation_exception_events v
            where v.exception_id = $1::uuid order by v.occurred_at, v.id limit 500`,
          [params.id],
        );
        return {
          status: 200,
          body: { exception: mapException(row), events: events.rows.map(mapExceptionEvent) },
        };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/lender/reconciliation/exceptions/:id/acknowledge',
      operationId: 'acknowledgeReconciliationException',
      summary: 'Acknowledge an exception (you have seen it and will look at it)',
      description:
        'A lender-owned exception needs payment.reconcile of its lender; a platform-owned one needs platform.payments.providers.manage. Both need a second factor. Repeating it answers acknowledged. Anyone who may not see the exception gets 404.',
      tags: ['Exceptions (lender)'],
      auth: 'staff',
      idempotent: true,
      params: Id,
      responses: { 200: LpExceptionActionResult },
      errors: [400, 401, 403, 404, 409],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params }) => {
        const r = await tx.query<{ r: string }>(
          'select payments.acknowledge_exception($1::uuid) as r',
          [params.id],
        );
        return { status: 200, body: { status: first(r.rows) } };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/lender/reconciliation/exceptions/:id/assign',
      operationId: 'assignReconciliationException',
      summary: 'Assign an exception to someone who may act on it',
      description:
        'The assignee must hold the permission that works this exception (payment.reconcile of the lender, or platform.payments.providers.manage for a platform-owned one); otherwise assignee_invalid. A resolved exception cannot be assigned.',
      tags: ['Exceptions (lender)'],
      auth: 'staff',
      idempotent: true,
      params: Id,
      body: LpExceptionAssignInput,
      responses: { 200: LpExceptionActionResult },
      errors: [400, 401, 403, 404, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params, body }) => {
        const r = await tx.query<{ r: string }>(
          'select payments.assign_exception($1::uuid, $2::uuid) as r',
          [params.id, body.assignee],
        );
        return { status: 200, body: { status: first(r.rows) } };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/lender/reconciliation/exceptions/:id/resolve',
      operationId: 'resolveReconciliationException',
      summary:
        'Resolve an exception with a reason from the closed list and the evidence you reviewed',
      description:
        'Resolving annotates the exception and changes nothing else: no payment, intent, receipt or settlement row moves. reasonCode must be one of verified_with_provider, refunded_by_provider, posted_by_lender, duplicate_confirmed, timing_difference, no_action_needed, escalated_to_provider, escalated_to_lender, documented_elsewhere, raised_in_error, new_information (reason_required otherwise). evidence is 1 to 10 short ids or labels (letters, digits and . _ : / # - only, no spaces; evidence_required otherwise). The note is at most 500 characters and must not hold personal data.',
      tags: ['Exceptions (lender)'],
      auth: 'staff',
      idempotent: true,
      params: Id,
      body: LpExceptionResolveInput,
      responses: { 200: LpExceptionActionResult },
      errors: [400, 401, 403, 404, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params, body }) => {
        const r = await tx.query<{ r: string }>(
          'select payments.resolve_exception($1::uuid, $2, $3::jsonb, $4) as r',
          [params.id, body.reasonCode, JSON.stringify(body.evidence), body.note ?? null],
        );
        return { status: 200, body: { status: first(r.rows) } };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/lender/reconciliation/exceptions/:id/reopen',
      operationId: 'reopenReconciliationException',
      summary: 'Reopen a resolved exception with a reason from the closed list',
      description:
        "Only a resolved exception can be reopened. reasonCode must be one of new_information, raised_in_error, verified_with_provider, escalated_to_provider, escalated_to_lender (reason_required otherwise). The next reconciliation run does not open a resolved exception again: reopening is a person's decision.",
      tags: ['Exceptions (lender)'],
      auth: 'staff',
      idempotent: true,
      params: Id,
      body: LpExceptionReopenInput,
      responses: { 200: LpExceptionActionResult },
      errors: [400, 401, 403, 404, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params, body }) => {
        const r = await tx.query<{ r: string }>(
          'select payments.reopen_exception($1::uuid, $2, $3) as r',
          [params.id, body.reasonCode, body.note ?? null],
        );
        return { status: 200, body: { status: first(r.rows) } };
      },
    }),

    // ---- platform -------------------------------------------------------------------------------------------------
    userRoute({
      method: 'get',
      path: '/v1/platform/exceptions',
      operationId: 'listPlatformPaymentExceptions',
      summary: 'Open platform-owned payment exceptions across lenders, newest first',
      description:
        'Needs platform.payments.providers.manage. Lists exceptions the platform owns (for example merchant mismatch, payload conflict and settlement account mismatch) that are not resolved yet, for every lender. They are worked with the same acknowledge, assign, resolve and reopen routes.',
      tags: ['Exceptions (platform)'],
      auth: 'staff',
      query: LpPlatformExceptionListQuery,
      responses: { 200: LpExceptionPage },
      errors: [400, 401, 403, 422],
      rateLimit: READ_LIMIT,
      handler: async ({ tx, query }) => {
        await requirePlatformProviderStaff(tx);
        const w = new Where();
        w.raw("x.owner = 'platform'");
        w.raw("x.status <> 'resolved'");
        if (query.lenderId) w.add((p) => `x.lender_org_id = ${p}::uuid`, query.lenderId);
        if (query.class) w.add((p) => `x.class = ${p}`, query.class);
        if (query.severity) w.add((p) => `x.severity = ${p}`, query.severity);
        olderThan(w, query.cursor, 'x.opened_at', 'x.id');
        const limit = w.placeholder(query.limit + 1);
        const r = await tx.query<ExceptionRow>(
          `select ${EXCEPTION_COLUMNS} from payments.reconciliation_exceptions x where ${w.sql}
            order by x.opened_at desc, x.id desc limit ${limit}::int`,
          w.values,
        );
        return {
          status: 200,
          body: pageOf(r.rows, query.limit, mapException, (row) =>
            encodeCursor({ t: row.openedAt, id: row.id }),
          ),
        };
      },
    }),
  ];
}
