import { createHash } from 'node:crypto';
import { type DocumentStore } from '@udofin/adapters';
import {
  SvcActivityPage,
  SvcActivityQuery,
  SvcClosureResult,
  SvcContentQuery,
  SvcDocumentRequestList,
  SvcDocumentRequestParams,
  SvcDocumentRequestResult,
  SvcLatestQuote,
  SvcLoan,
  SvcLoanDocumentContent,
  SvcLoanDocumentList,
  SvcLoanDocumentParams,
  SvcLoanIdParams,
  SvcLoanList,
  SvcReminderList,
  SvcReminderParams,
  SvcReminderRead,
  SvcSchedule,
  SvcStatementRequestInput,
} from '@udofin/contracts';
import { z } from 'zod';
import { columns } from '../../db/columns.js';
import { type UserTx } from '../../db/user-context.js';
import { ApiError } from '../../http/api-error.js';
import { decodeCursor, encodeCursor } from '../../http/pagination.js';
import { userRoute, type RouteDefinition } from '../../http/routes.js';

/**
 * Phase 08a, the borrower side of servicing: the loans the lender services (as the lender reported them), the schedule, the
 * activity, lender-issued statements and quotation documents, requests for them, closure and the service reminders.
 *
 * Every rule lives in the database. These routes validate the shape of a request, take the caller from the token (the database
 * resolves who the borrower is), pass identifiers, call one SQL function and map the result. Nothing here computes an amount,
 * derives a stage, decides an eligibility or re-renders a message. A loan, request, document or reminder that is not the caller's
 * answers 404 not_found (the database raises P0002), so existence is never revealed.
 *
 * Responses are mapped field by field from columns this module chooses to read: no row is spread, and the contract schemas are
 * strict, so an undeclared field (a bank reference, a payment mode, a provider reference, a storage key) cannot leave the API.
 */

const WRITE_LIMIT = { max: 30, timeWindow: '1 minute' };
const READ_LIMIT = { max: 120, timeWindow: '1 minute' };
const OPEN_LIMIT = { max: 60, timeWindow: '1 minute' };

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
/** A byte count (bigint as text). */
function bytes(value: string): number {
  if (!/^\d{1,12}$/.test(value)) throw new Error('the database returned a size outside the range');
  return Number(value);
}

const notFound = () => new ApiError(404, 'not_found', 'Not Found');

const first = <T>(rows: T[]): T => {
  const row = rows[0];
  if (row === undefined) throw new Error('database function returned nothing');
  return row;
};

/**
 * "Not your loan" is an explicit 404 for routes whose SQL function answers an empty set to a stranger (the latest quotation): the
 * probe raises P0002 for a loan that is unknown or belongs to someone else, and nothing else (it does not look at any switch).
 */
async function requireOwnLoan(tx: UserTx, loanId: string): Promise<void> {
  await tx.query('select 1 from servicing.my_document_requests($1::uuid) limit 1', [loanId]);
}

// ---------------------------------------------------------------------------------------------------------------
// Column lists and mappers
// ---------------------------------------------------------------------------------------------------------------
interface LoanRow {
  loanId: string;
  lenderId: string;
  lenderDisplayName: string;
  lenderLoanRef: string;
  loanStatus: string;
  sanctionedAmountMinor: string;
  disbursedAmountMinor: string | null;
  disbursedAt: string | null;
  reportedStatus: string | null;
  reportedAsOf: string | null;
  receivedAt: string | null;
  stale: boolean;
  staleThresholdMinutes: number;
  figuresAvailable: boolean;
  outstandingPrincipalMinor: string | null;
  overduePrincipalMinor: string | null;
  overdueInterestMinor: string | null;
  penalChargesMinor: string | null;
  otherChargesMinor: string | null;
  totalOverdueMinor: string | null;
  nextDueOn: string | null;
  nextDueMinor: string | null;
  daysPastDue: number | null;
}
const LOAN_COLUMNS = columns({
  loanId: 'l.loan_account_id',
  lenderId: 'l.lender_org_id',
  lenderDisplayName: 'l.lender_display_name',
  lenderLoanRef: 'l.lender_loan_ref',
  loanStatus: 'l.loan_status::text',
  sanctionedAmountMinor: 'l.sanctioned_amount_minor::text',
  disbursedAmountMinor: 'l.disbursed_amount_minor::text',
  disbursedAt: ts('l.disbursed_at'),
  reportedStatus: 'l.reported_status::text',
  reportedAsOf: ts('l.reported_as_of'),
  receivedAt: ts('l.received_at'),
  stale: 'l.stale',
  staleThresholdMinutes: 'l.stale_threshold_minutes',
  figuresAvailable: 'l.figures_available',
  outstandingPrincipalMinor: 'l.outstanding_principal_minor::text',
  overduePrincipalMinor: 'l.overdue_principal_minor::text',
  overdueInterestMinor: 'l.overdue_interest_minor::text',
  penalChargesMinor: 'l.penal_charges_minor::text',
  otherChargesMinor: 'l.other_charges_minor::text',
  totalOverdueMinor: 'l.total_overdue_minor::text',
  nextDueOn: day('l.next_due_on'),
  nextDueMinor: 'l.next_due_minor::text',
  daysPastDue: 'l.days_past_due',
});
/** The figures stay exactly as the database gave them: null is "not reported or withheld", never zero. */
const mapLoan = (r: LoanRow) => ({
  loanId: r.loanId,
  lenderId: r.lenderId,
  lenderDisplayName: r.lenderDisplayName,
  lenderLoanRef: r.lenderLoanRef,
  loanStatus: r.loanStatus,
  sanctionedAmountMinor: paise(r.sanctionedAmountMinor),
  disbursedAmountMinor: paiseOrNull(r.disbursedAmountMinor),
  disbursedAt: r.disbursedAt,
  reportedAsOf: r.reportedAsOf,
  receivedAt: r.receivedAt,
  stale: r.stale,
  staleThresholdMinutes: r.staleThresholdMinutes,
  figuresAvailable: r.figuresAvailable,
  reportedStatus: r.reportedStatus,
  outstandingPrincipalMinor: paiseOrNull(r.outstandingPrincipalMinor),
  overduePrincipalMinor: paiseOrNull(r.overduePrincipalMinor),
  overdueInterestMinor: paiseOrNull(r.overdueInterestMinor),
  penalChargesMinor: paiseOrNull(r.penalChargesMinor),
  otherChargesMinor: paiseOrNull(r.otherChargesMinor),
  totalOverdueMinor: paiseOrNull(r.totalOverdueMinor),
  nextDueOn: r.nextDueOn,
  nextDueMinor: paiseOrNull(r.nextDueMinor),
  daysPastDue: r.daysPastDue,
});

interface InstallmentRow {
  scheduleVersion: number;
  reportedAsOf: string | null;
  seq: number;
  dueDate: string;
  principalMinor: string;
  interestMinor: string;
  feesMinor: string;
  totalMinor: string;
}
const INSTALLMENT_COLUMNS = columns({
  scheduleVersion: 's.schedule_version',
  reportedAsOf: ts('s.reported_as_of'),
  seq: 's.seq',
  dueDate: day('s.due_date'),
  principalMinor: 's.principal_minor::text',
  interestMinor: 's.interest_minor::text',
  feesMinor: 's.fees_minor::text',
  totalMinor: 's.total_minor::text',
});

interface ActivityRow {
  entryKind: string;
  entryId: string;
  sortAt: string;
  occurredOn: string;
  amountMinor: string | null;
  state: string;
  purpose: string | null;
}
const ACTIVITY_COLUMNS = columns({
  entryKind: 'a.entry_kind',
  entryId: 'a.entry_id',
  sortAt: ts('a.sort_at'),
  occurredOn: day('a.occurred_on'),
  amountMinor: 'a.amount_minor::text',
  state: 'a.state',
  purpose: 'a.purpose',
});
const mapActivity = (r: ActivityRow) => ({
  entryKind: r.entryKind,
  entryId: r.entryId,
  sortAt: r.sortAt,
  occurredOn: r.occurredOn,
  amountMinor: paiseOrNull(r.amountMinor),
  state: r.state,
  purpose: r.purpose,
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
  sizeBytes: bytes(r.sizeBytes),
  source: r.source,
  supersededById: r.supersededById,
});

interface RequestRow {
  requestId: string;
  kind: string;
  status: string;
  periodFrom: string | null;
  periodTo: string | null;
  requestedAt: string;
  dueBy: string | null;
  dueRuleKey: string | null;
  dueEvidenceStatus: string | null;
  lenderNote: string | null;
  decidedAt: string | null;
  fulfilledDocumentId: string | null;
  fulfilledQuoteId: string | null;
}
const REQUEST_COLUMNS = columns({
  requestId: 'r.request_id',
  kind: 'r.kind',
  status: 'r.status',
  periodFrom: day('r.period_from'),
  periodTo: day('r.period_to'),
  requestedAt: ts('r.requested_at'),
  dueBy: ts('r.due_by'),
  dueRuleKey: 'r.due_rule_key',
  dueEvidenceStatus: 'r.due_evidence_status',
  lenderNote: 'r.lender_note',
  decidedAt: ts('r.decided_at'),
  fulfilledDocumentId: 'r.fulfilled_document_id',
  fulfilledQuoteId: 'r.fulfilled_quote_id',
});
const mapRequest = (r: RequestRow) => ({
  requestId: r.requestId,
  kind: r.kind,
  status: r.status,
  periodFrom: r.periodFrom,
  periodTo: r.periodTo,
  requestedAt: r.requestedAt,
  dueBy: r.dueBy,
  dueRuleKey: r.dueRuleKey,
  dueEvidenceStatus: r.dueEvidenceStatus,
  lenderNote: r.lenderNote,
  decidedAt: r.decidedAt,
  fulfilledDocumentId: r.fulfilledDocumentId,
  fulfilledQuoteId: r.fulfilledQuoteId,
});

interface QuoteRow {
  quoteId: string;
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
}
const QUOTE_COLUMNS = columns({
  quoteId: 'q.id',
  lenderQuoteRef: 'q.lender_quote_ref',
  asOf: ts('q.as_of'),
  validUntil: ts('q.valid_until'),
  principalMinor: 'q.principal_minor::text',
  interestMinor: 'q.interest_minor::text',
  chargesMinor: 'q.charges_minor::text',
  prepaymentChargeMinor: 'q.prepayment_charge_minor::text',
  totalMinor: 'q.total_minor::text',
  // The flag is generated by the database from the lender's own figures. Unknown is treated as a mismatch (fail closed).
  totalMismatch: 'coalesce(q.total_mismatch, true)',
  source: 'q.source',
  letterDocumentId: 'q.letter_document_id',
});
const mapQuote = (r: QuoteRow) => ({
  quoteId: r.quoteId,
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
});

interface ReminderRow {
  reminderId: string;
  loanId: string;
  lenderDisplayName: string | null;
  kind: string;
  dueDate: string;
  sentAt: string;
  message: string;
  readAt: string | null;
}
const REMINDER_COLUMNS = columns({
  reminderId: 'm.reminder_id',
  loanId: 'm.loan_account_id',
  lenderDisplayName: 'm.lender_display_name',
  kind: 'm.kind',
  dueDate: day('m.due_date'),
  sentAt: ts('m.sent_at'),
  message: 'm.message',
  readAt: ts('m.read_at'),
});
const mapReminder = (r: ReminderRow) => ({
  reminderId: r.reminderId,
  loanId: r.loanId,
  lenderDisplayName: r.lenderDisplayName,
  kind: r.kind,
  dueDate: r.dueDate,
  sentAt: r.sentAt,
  message: r.message,
  readAt: r.readAt,
});

// ---------------------------------------------------------------------------------------------------------------
// What the database returns as jsonb is validated before it is mapped (a shape that drifted fails loudly, it is never passed on)
// ---------------------------------------------------------------------------------------------------------------
const DbTimestamp = z.string().min(1);
const DbBasis = z
  .object({
    rule_key: z.string(),
    rule_version: z.number().int(),
    evidence_status: z.string(),
  })
  .nullable();
const DbClosure = z.object({
  loan_account_id: z.uuid(),
  lender_display_name: z.string(),
  loan_status: z.string(),
  closure_kind: z.string(),
  closure_recorded_at: DbTimestamp,
  noc_status: z.string(),
  noc_status_source: z.string(),
  noc_prompt_key: z.string(),
  noc_due_by: DbTimestamp.nullable(),
  noc_due_basis: DbBasis,
  noc_document_id: z.uuid().nullable(),
  noc_issued_at: DbTimestamp.nullable(),
  security_release_tasks: z.array(
    z.object({
      task_id: z.uuid(),
      collateral_type: z.string(),
      status: z.string(),
      status_source: z.string(),
      prompt_key: z.string(),
      lender_confirmed: z.boolean(),
      due_by: DbTimestamp.nullable(),
      due_basis: DbBasis,
      delay_reason: z.string().nullable(),
      confirmed_at: DbTimestamp.nullable(),
    }),
  ),
});
const mapBasis = (b: z.infer<typeof DbBasis>) =>
  b === null
    ? null
    : { ruleKey: b.rule_key, ruleVersion: b.rule_version, evidenceStatus: b.evidence_status };

const DbOpenedDocument = z.object({
  document_id: z.uuid(),
  loan_account_id: z.uuid(),
  kind: z.string(),
  storage_key: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size_bytes: z.number().int().min(1),
  mime_type: z.literal('application/pdf'),
  lender_reference: z.string(),
  source: z.string(),
});

// ---------------------------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------------------------
export function servicingRoutes(deps: { documents?: DocumentStore }): RouteDefinition[] {
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

  /** The request as the borrower sees it, read back through the borrower's own listing (which also proves the loan is theirs). */
  async function readRequest(tx: UserTx, loanId: string, requestId: string) {
    const r = await tx.query<RequestRow>(
      `select ${REQUEST_COLUMNS} from servicing.my_document_requests($1::uuid) r where r.request_id = $2::uuid`,
      [loanId, requestId],
    );
    const row = r.rows[0];
    // Not in the caller's list of THIS loan: the request is not theirs, or not on this loan. Nothing is revealed.
    if (!row) throw notFound();
    return { request: mapRequest(row) };
  }

  async function requestDocument(
    tx: UserTx,
    loanId: string,
    kind: 'statement' | 'foreclosure_quote',
    key: string | undefined,
    period: { from?: string | undefined; to?: string | undefined } = {},
  ) {
    const created = await tx.query<{ id: string }>(
      'select servicing.request_document($1::uuid, $2, $3, $4::date, $5::date) as id',
      [loanId, kind, key ?? null, period.from ?? null, period.to ?? null],
    );
    return readRequest(tx, loanId, first(created.rows).id);
  }

  return [
    // ---- loans ----------------------------------------------------------------------------------------------------
    userRoute({
      method: 'get',
      path: '/v1/loans',
      operationId: 'listMyLoans',
      summary: "The borrower's loans, with only what the lender reported",
      description:
        "Each loan carries the lender's time of the report (`reportedAsOf`) and a staleness flag. When `figuresAvailable` is false every amount is null (never zero): there is no report yet, or the newest one is under review. An empty list is normal. Lenders whose servicing switch is off are not listed. Nothing is computed by Udofin.",
      tags: ['Servicing'],
      auth: 'borrower',
      responses: { 200: SvcLoanList },
      errors: [401, 403],
      rateLimit: READ_LIMIT,
      handler: async ({ tx }) => {
        const r = await tx.query<LoanRow>(
          `select ${LOAN_COLUMNS} from servicing.my_loans() l order by l.disbursed_at desc nulls last, l.loan_account_id desc`,
        );
        return { status: 200, body: { items: r.rows.map(mapLoan) } };
      },
    }),
    userRoute({
      method: 'get',
      path: '/v1/loans/:id',
      operationId: 'getMyLoan',
      summary: 'One loan as the lender reported it',
      description:
        "The same shape as one item of the list. Another borrower's loan, an unknown loan and a lender whose servicing switch is off all answer 404 not_found.",
      tags: ['Servicing'],
      auth: 'borrower',
      params: SvcLoanIdParams,
      responses: { 200: SvcLoan },
      errors: [401, 403, 404],
      rateLimit: READ_LIMIT,
      handler: async ({ tx, params }) => {
        const r = await tx.query<LoanRow>(
          `select ${LOAN_COLUMNS} from servicing.my_loan($1::uuid) l`,
          [params.id],
        );
        return { status: 200, body: mapLoan(first(r.rows)) };
      },
    }),
    userRoute({
      method: 'get',
      path: '/v1/loans/:id/schedule',
      operationId: 'getMyLoanSchedule',
      summary: 'The repayment schedule exactly as the lender reported it',
      description:
        'Installment by installment: due date, principal, interest, fees and total. There is no per-installment status: Udofin allocates and computes nothing. Empty (version null) when no schedule was reported or an unresolved conflict about it withholds it.',
      tags: ['Servicing'],
      auth: 'borrower',
      params: SvcLoanIdParams,
      responses: { 200: SvcSchedule },
      errors: [401, 403, 404],
      rateLimit: READ_LIMIT,
      handler: async ({ tx, params }) => {
        const r = await tx.query<InstallmentRow>(
          `select ${INSTALLMENT_COLUMNS} from servicing.my_loan_schedule($1::uuid) s order by s.seq`,
          [params.id],
        );
        const head = r.rows[0];
        return {
          status: 200,
          body: {
            scheduleVersion: head ? head.scheduleVersion : null,
            reportedAsOf: head ? head.reportedAsOf : null,
            installments: r.rows.map((row) => ({
              seq: row.seq,
              dueDate: row.dueDate,
              principalMinor: paise(row.principalMinor),
              interestMinor: paise(row.interestMinor),
              feesMinor: paise(row.feesMinor),
              totalMinor: paise(row.totalMinor),
            })),
          },
        };
      },
    }),
    userRoute({
      method: 'get',
      path: '/v1/loans/:id/activity',
      operationId: 'getMyLoanActivity',
      summary: 'Lender receipts, payment attempts and adjustments of one loan, newest first',
      description:
        "Keyset pagination: pass `nextCursor` back as `cursor`. A page never repeats or skips an entry. Lender receipts show what the lender's own system posted; a payment attempt shows the honest stage derived from verified provider events and lender receipts. No bank reference, payment mode or provider reference is ever returned.",
      tags: ['Servicing'],
      auth: 'borrower',
      params: SvcLoanIdParams,
      query: SvcActivityQuery,
      responses: { 200: SvcActivityPage },
      errors: [400, 401, 403, 404],
      rateLimit: READ_LIMIT,
      handler: async ({ tx, params, query }) => {
        const cursor = decodeCursor(query.cursor);
        // One row more than the page, to know whether another page exists.
        const r = await tx.query<ActivityRow>(
          `select ${ACTIVITY_COLUMNS}
             from servicing.my_loan_activity($1::uuid, $2::timestamptz, $3::uuid, $4::int) a
            order by a.sort_at desc, a.entry_id desc`,
          [params.id, cursor?.t ?? null, cursor?.id ?? null, query.limit + 1],
        );
        const page = r.rows.slice(0, query.limit);
        const last = page.at(-1);
        return {
          status: 200,
          body: {
            items: page.map(mapActivity),
            nextCursor:
              r.rows.length > query.limit && last
                ? encodeCursor({ t: last.sortAt, id: last.entryId })
                : null,
          },
        };
      },
    }),

    // ---- documents ------------------------------------------------------------------------------------------------
    userRoute({
      method: 'get',
      path: '/v1/loans/:id/documents',
      operationId: 'listMyLoanDocuments',
      summary: 'Statements, quotation letters and no-dues letters the lender issued for this loan',
      description:
        "Lender-issued documents only (Udofin generates none). Empty when the lender's statements switch is off. Documents with `source: mock` are labelled test documents and appear only where mock providers are allowed.",
      tags: ['Servicing'],
      auth: 'borrower',
      params: SvcLoanIdParams,
      responses: { 200: SvcLoanDocumentList },
      errors: [401, 403, 404],
      rateLimit: READ_LIMIT,
      handler: async ({ tx, params }) => {
        const r = await tx.query<DocumentRow>(
          `select ${DOCUMENT_COLUMNS} from servicing.my_loan_documents($1::uuid) d order by d.issued_at desc, d.document_id`,
          [params.id],
        );
        return { status: 200, body: { items: r.rows.map(mapDocument) } };
      },
    }),
    userRoute({
      method: 'get',
      path: '/v1/loans/:id/documents/:docId/content',
      operationId: 'downloadMyLoanDocument',
      summary:
        'Retrieve a lender-issued document (the exact stored file; every retrieval is recorded)',
      description:
        'Authorised owners only. The file is read from the private store and its SHA-256 is checked against the recorded value before anything is returned; a file that was altered is never served. The response is not cached. There is no permanent or public link to a document.',
      tags: ['Servicing'],
      auth: 'borrower',
      params: SvcLoanDocumentParams,
      query: SvcContentQuery,
      responses: { 200: SvcLoanDocumentContent },
      errors: [401, 403, 404, 409, 503],
      rateLimit: OPEN_LIMIT,
      handler: async ({ tx, params, query }) => {
        const store = requireStore();
        // The database authorises the caller, writes the access record first and returns the opaque key and the recorded hash.
        const opened = await tx.query<{ r: unknown }>(
          'select servicing.open_loan_document($1::uuid, $2) as r',
          [params.docId, query.purpose],
        );
        const meta = DbOpenedDocument.parse(first(opened.rows).r);
        // A document of another loan (even the caller's own) is not found on this path. Throwing rolls the access record back.
        if (meta.loan_account_id !== params.id) throw notFound();
        // Fail closed, and leave no access record for a read that did not deliver (throwing rolls the record back). Bytes that
        // are gone answer 404 like every other document route; bytes that were altered are a server fault (500, logged, no detail).
        const object = await store.get(meta.storage_key);
        if (!object) throw notFound();
        const actual = createHash('sha256').update(object.bytes).digest('hex');
        if (actual !== meta.sha256 || object.bytes.length !== meta.size_bytes)
          throw new Error('stored document does not match its recorded checksum');
        return {
          status: 200,
          headers: { 'cache-control': 'no-store' },
          body: {
            documentId: meta.document_id,
            loanId: meta.loan_account_id,
            kind: meta.kind,
            lenderReference: meta.lender_reference,
            mimeType: meta.mime_type,
            sizeBytes: meta.size_bytes,
            sha256: meta.sha256,
            source: meta.source,
            contentBase64: Buffer.from(object.bytes).toString('base64'),
          },
        };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/loans/:id/statements',
      operationId: 'requestMyLoanStatement',
      summary: 'Ask the lender for a statement of account',
      description:
        'Optionally for a period (both ends, or neither for the whole history). The lender issues the statement; Udofin does not generate one. The due date shown comes from a platform setting labelled `unverified`: it is not a regulatory deadline. One open request per kind and loan.',
      tags: ['Servicing'],
      auth: 'borrower',
      idempotent: true,
      params: SvcLoanIdParams,
      body: SvcStatementRequestInput,
      responses: { 201: SvcDocumentRequestResult },
      errors: [400, 401, 403, 404, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params, body, idempotencyKey }) => ({
        status: 201,
        body: await requestDocument(tx, params.id, 'statement', idempotencyKey, {
          from: body.periodFrom,
          to: body.periodTo,
        }),
      }),
    }),
    userRoute({
      method: 'post',
      path: '/v1/loans/:id/foreclosure-quotes',
      operationId: 'requestMyForeclosureQuote',
      summary: 'Ask the lender for a foreclosure quotation',
      description:
        'The lender answers with its own quotation (see `latest foreclosure quote`). Only for an active loan. One open request per loan.',
      tags: ['Servicing'],
      auth: 'borrower',
      idempotent: true,
      params: SvcLoanIdParams,
      responses: { 201: SvcDocumentRequestResult },
      errors: [400, 401, 403, 404, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params, idempotencyKey }) => ({
        status: 201,
        body: await requestDocument(tx, params.id, 'foreclosure_quote', idempotencyKey),
      }),
    }),
    userRoute({
      method: 'get',
      path: '/v1/loans/:id/foreclosure-quotes/latest',
      operationId: 'getMyLatestForeclosureQuote',
      summary: 'The newest unexpired foreclosure quotation, as the lender reported it',
      description:
        "The quotation is the lender's own figures, unchanged; Udofin computes none. `quote` is null when there is none (also when the lender's statements switch is off): never an invented figure. A quotation whose parts do not add up to its total is returned with `totalMismatch: true`; the app must refuse to pay it. A foreclosure payment must equal `totalMinor` of an unexpired quotation.",
      tags: ['Servicing'],
      auth: 'borrower',
      params: SvcLoanIdParams,
      responses: { 200: SvcLatestQuote },
      errors: [401, 403, 404],
      rateLimit: READ_LIMIT,
      handler: async ({ tx, params }) => {
        await requireOwnLoan(tx, params.id);
        const r = await tx.query<QuoteRow>(
          `select ${QUOTE_COLUMNS} from servicing.latest_valid_quote($1::uuid) q`,
          [params.id],
        );
        const row = r.rows[0];
        return { status: 200, body: { quote: row ? mapQuote(row) : null } };
      },
    }),
    userRoute({
      method: 'get',
      path: '/v1/loans/:id/document-requests',
      operationId: 'listMyDocumentRequests',
      summary: 'The statement and quotation requests made for this loan, newest first',
      description:
        "Each request shows where it stands (requested, fulfilled, declined with the lender's reason, expired, cancelled) and the due date with its basis. Empty when the lender's statements switch is off.",
      tags: ['Servicing'],
      auth: 'borrower',
      params: SvcLoanIdParams,
      responses: { 200: SvcDocumentRequestList },
      errors: [401, 403, 404],
      rateLimit: READ_LIMIT,
      handler: async ({ tx, params }) => {
        const r = await tx.query<RequestRow>(
          `select ${REQUEST_COLUMNS} from servicing.my_document_requests($1::uuid) r order by r.requested_at desc, r.request_id`,
          [params.id],
        );
        return { status: 200, body: { items: r.rows.map(mapRequest) } };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/loans/:id/document-requests/:requestId/cancel',
      operationId: 'cancelMyDocumentRequest',
      summary: 'Withdraw a request that is still open',
      description:
        "Only an open request of the caller on this loan. A request that is already decided answers 409 request_not_open; one that is not the caller's, or not on this loan, answers 404.",
      tags: ['Servicing'],
      auth: 'borrower',
      idempotent: true,
      params: SvcDocumentRequestParams,
      responses: { 200: SvcDocumentRequestResult },
      errors: [400, 401, 403, 404, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params }) => {
        // The database resolves the request through the caller's own loans (a stranger's request is P0002).
        await tx.query('select servicing.cancel_document_request($1::uuid)', [params.requestId]);
        // The request must be on the loan in the path; if it is not, this throws and the cancellation is rolled back.
        return { status: 200, body: await readRequest(tx, params.id, params.requestId) };
      },
    }),

    // ---- closure --------------------------------------------------------------------------------------------------
    userRoute({
      method: 'get',
      path: '/v1/loans/:id/closure',
      operationId: 'getMyLoanClosure',
      summary: 'Closure facts as the lender reported them, with prompt keys and due dates',
      description:
        '`closure` is null until the lender has reported the loan closed. The prompt keys (`closure.noc.*`, `closure.security_release.<type>.*`) are mapped to wording by the app; a key never says that anything was released unless the lender confirmed it. Statuses always come from the lender, never from Udofin or the app. Due dates carry their basis, labelled `unverified` where they are platform defaults.',
      tags: ['Servicing'],
      auth: 'borrower',
      params: SvcLoanIdParams,
      responses: { 200: SvcClosureResult },
      errors: [401, 403, 404, 409],
      rateLimit: READ_LIMIT,
      handler: async ({ tx, params }) => {
        const r = await tx.query<{ r: unknown }>('select servicing.my_closure($1::uuid) as r', [
          params.id,
        ]);
        const raw = first(r.rows).r;
        if (raw === null) return { status: 200, body: { closure: null } };
        const c = DbClosure.parse(raw);
        return {
          status: 200,
          body: {
            closure: {
              loanId: c.loan_account_id,
              lenderDisplayName: c.lender_display_name,
              loanStatus: c.loan_status,
              closureKind: c.closure_kind,
              closureRecordedAt: c.closure_recorded_at,
              nocStatus: c.noc_status,
              nocStatusSource: c.noc_status_source,
              nocPromptKey: c.noc_prompt_key,
              nocDueBy: c.noc_due_by,
              nocDueBasis: mapBasis(c.noc_due_basis),
              nocDocumentId: c.noc_document_id,
              nocIssuedAt: c.noc_issued_at,
              securityReleaseTasks: c.security_release_tasks.map((t) => ({
                taskId: t.task_id,
                collateralType: t.collateral_type,
                status: t.status,
                statusSource: t.status_source,
                promptKey: t.prompt_key,
                lenderConfirmed: t.lender_confirmed,
                dueBy: t.due_by,
                dueBasis: mapBasis(t.due_basis),
                delayReason: t.delay_reason,
                confirmedAt: t.confirmed_at,
              })),
            },
          },
        };
      },
    }),

    // ---- reminders ------------------------------------------------------------------------------------------------
    userRoute({
      method: 'get',
      path: '/v1/me/reminders',
      operationId: 'listMyReminders',
      summary: 'The service messages the lender sent about due dates, newest first',
      description:
        'The latest 50 messages, one per message across channels. The wording is exactly what was sent and approved by the lender; it is shown only if it still matches the hash stored when it was sent. Lenders whose reminders switch is off are not listed. These are service messages, not offers.',
      tags: ['Servicing'],
      auth: 'borrower',
      responses: { 200: SvcReminderList },
      errors: [401, 403],
      rateLimit: READ_LIMIT,
      handler: async ({ tx }) => {
        const r = await tx.query<ReminderRow>(
          `select ${REMINDER_COLUMNS} from servicing.my_reminders() m order by m.sent_at desc, m.reminder_id`,
        );
        return { status: 200, body: { items: r.rows.map(mapReminder) } };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/me/reminders/:id/read',
      operationId: 'markMyReminderRead',
      summary: 'Record that the borrower opened one of their own reminders',
      description:
        "Idempotent. Marks every channel copy of the same message. Another borrower's reminder, an unknown one and one that was not sent answer 404.",
      tags: ['Servicing'],
      auth: 'borrower',
      idempotent: true,
      params: SvcReminderParams,
      responses: { 200: SvcReminderRead },
      errors: [400, 401, 403, 404, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params }) => {
        const r = await tx.query<{ state: string }>(
          'select servicing.mark_reminder_read($1::uuid) as state',
          [params.id],
        );
        if (first(r.rows).state !== 'read')
          throw new Error('unexpected result of mark_reminder_read');
        return { status: 200, body: { reminderId: params.id, state: 'read' } };
      },
    }),
  ];
}
