import {
  HandoffVaultError,
  openHandoffLink,
  type HandoffKeyring,
  type HandoffKind,
} from '@udofin/adapters';
import {
  BP_MANDATE_REQUIREMENTS,
  BP_MANDATE_UNAVAILABLE_KEYS,
  BP_MANDATE_RAILS,
  BP_PAYMENT_PURPOSES,
  BP_PAYMENT_STATUSES,
  BP_PAYMENT_UNAVAILABLE_KEYS,
  BpHandoffLink,
  BpIdParam,
  BpMandate,
  BpMandateCancelRequested,
  BpMandateDebitList,
  BpMandateList,
  BpMandateOptions,
  BpMandateRequest,
  BpPaymentCancelled,
  BpPaymentDetail,
  BpPaymentOptions,
  BpPaymentRequest,
  DateOnly,
  Paise,
  Timestamp,
} from '@udofin/contracts';
import { type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { columns } from '../../db/columns.js';
import { type UserTx } from '../../db/user-context.js';
import { ApiError } from '../../http/api-error.js';
import { userRoute, type RouteDefinition } from '../../http/routes.js';

/**
 * Phase 08a, borrower side: paying a loan through the lender's payment provider, and mandates for automatic debits.
 *
 * Every rule lives in the database. These routes validate the SHAPE of a request, take the caller from the token (the database
 * resolves who the borrower is, and every function answers P0002, which is 404 here, for a loan, payment or mandate that is not
 * the caller's or whose lender switch is off), pass identifiers, call one SQL function and map the answer. Nothing here computes
 * an amount, derives a stage, decides an eligibility or checks a limit.
 *
 * Responses are mapped field by field from the columns this module chooses to read: no row is spread, and the contract objects
 * are strict, so an undeclared field cannot leave the API. Money is integer paise (the database returns bigint as text; a checked
 * parse turns it into a number). The provider's hand-off link is a bearer secret: it is opened here only for the borrower who owns
 * the payment or mandate, travels in no log, URL or event, and is returned with `cache-control: no-store`.
 */

const WRITE_LIMIT = { max: 30, timeWindow: '1 minute' };
const READ_LIMIT = { max: 120, timeWindow: '1 minute' };
/** Fetching a bearer link is rare (once per checkout), so the limit is tight. */
const LINK_LIMIT = { max: 10, timeWindow: '1 minute' };

/** ISO text of a timestamp column (with offset); null stays null. */
const ts = (column: string) => `(to_jsonb(${column}) #>> '{}')`;
const day = (column: string) => `to_char(${column}, 'YYYY-MM-DD')`;

/** Money comes out of the database as text (bigint); a checked parse keeps it an exact integer or fails loudly. */
function paise(value: string): number {
  if (!/^\d{1,15}$/.test(value)) {
    throw new Error('the database returned an amount outside the paise range');
  }
  return Number(value);
}
const paiseOrNull = (value: string | null): number | null => (value === null ? null : paise(value));

const notFound = () => new ApiError(404, 'not_found', 'Not Found');

const first = <T>(rows: T[]): T => {
  const row = rows[0];
  if (row === undefined) throw new Error('database function returned nothing');
  return row;
};

// ---------------------------------------------------------------------------------------------------------------
// Payments: column lists and mappers (a column that is not listed here cannot reach a response)
// ---------------------------------------------------------------------------------------------------------------
interface PaymentDetailRow {
  id: string;
  loanId: string;
  lenderDisplayName: string;
  purpose: string;
  amountMinor: string;
  status: string;
  stage: string;
  createdAt: string;
  linkExpiresAt: string | null;
  linkAvailable: boolean;
  cancellable: boolean;
  destinationMaskedRef: string | null;
  providerReceivedAt: string | null;
  lenderPostedOn: string | null;
}
const PAYMENT_DETAIL_COLUMNS = columns({
  id: 'intent_id',
  loanId: 'loan_account_id',
  lenderDisplayName: 'lender_display_name',
  purpose: 'purpose',
  amountMinor: 'amount_minor::text',
  status: 'intent_status',
  stage: 'stage',
  createdAt: ts('created_at'),
  linkExpiresAt: ts('link_expires_at'),
  linkAvailable: 'link_available',
  cancellable: 'cancellable',
  destinationMaskedRef: 'destination_masked_ref',
  providerReceivedAt: ts('provider_received_at'),
  lenderPostedOn: day('lender_posted_on'),
});
const mapPaymentDetail = (r: PaymentDetailRow) => ({
  id: r.id,
  loanId: r.loanId,
  lenderDisplayName: r.lenderDisplayName,
  purpose: r.purpose,
  amountMinor: paise(r.amountMinor),
  status: r.status,
  stage: r.stage,
  createdAt: r.createdAt,
  linkExpiresAt: r.linkExpiresAt,
  linkAvailable: r.linkAvailable,
  cancellable: r.cancellable,
  destinationMaskedRef: r.destinationMaskedRef,
  providerReceivedAt: r.providerReceivedAt,
  lenderPostedOn: r.lenderPostedOn,
});

/** The payment as payments.my_payment_detail shows it (P0002, so 404, for someone else's payment or a lender whose switch is off). */
async function readPayment(tx: UserTx, id: string) {
  const r = await tx.query<PaymentDetailRow>(
    `select ${PAYMENT_DETAIL_COLUMNS} from payments.my_payment_detail($1::uuid)`,
    [id],
  );
  return mapPaymentDetail(first(r.rows));
}

// The shape of the jsonb that payments.my_payment_options returns. The parse refuses a shape the contract does not model (a
// 500, never a guess); the mapping below copies named fields only, so nothing the database adds later can leak.
const DbPurposeOption = z.discriminatedUnion('purpose', [
  z.object({
    purpose: z.literal('installment'),
    amount_source: z.literal('lender_reported'),
    amount_minor: Paise,
    due_on: DateOnly.nullable(),
    min_minor: Paise,
    max_minor: Paise,
  }),
  z.object({
    purpose: z.literal('overdue'),
    amount_source: z.literal('lender_reported'),
    amount_minor: Paise,
    min_minor: Paise,
    max_minor: Paise,
  }),
  z.object({
    purpose: z.literal('part_prepayment'),
    amount_source: z.literal('borrower_within_lender_limits'),
    min_minor: Paise,
    max_minor: Paise,
  }),
  z.object({
    purpose: z.literal('foreclosure'),
    amount_source: z.literal('lender_quote'),
    amount_minor: Paise,
    min_minor: Paise,
    max_minor: Paise,
    quote_id: z.uuid(),
    valid_until: Timestamp,
    flagged: z.boolean(),
  }),
]);
const DbPaymentOptions = z.object({
  loan_account_id: z.uuid(),
  lender_display_name: z.string(),
  available: z.boolean(),
  unavailable_key: z.enum(BP_PAYMENT_UNAVAILABLE_KEYS).nullable(),
  destination_masked_ref: z.string().nullable(),
  figures_available: z.boolean(),
  stale: z.boolean(),
  reported_as_of: Timestamp.nullable(),
  purposes: z.array(DbPurposeOption),
  penal_charge: z
    .object({
      version: z.number().int(),
      sentence_en: z.string(),
      sentence_hi: z.string().nullable(),
    })
    .nullable(),
  penal_charge_text_missing: z.boolean(),
  open_payments: z.array(
    z.object({
      intent_id: z.uuid(),
      purpose: z.enum(BP_PAYMENT_PURPOSES),
      status: z.enum(BP_PAYMENT_STATUSES),
    }),
  ),
});

function mapPurposeOption(p: z.infer<typeof DbPurposeOption>) {
  switch (p.purpose) {
    case 'installment':
      return {
        purpose: p.purpose,
        amountSource: p.amount_source,
        amountMinor: p.amount_minor,
        dueOn: p.due_on,
        minMinor: p.min_minor,
        maxMinor: p.max_minor,
      };
    case 'overdue':
      return {
        purpose: p.purpose,
        amountSource: p.amount_source,
        amountMinor: p.amount_minor,
        minMinor: p.min_minor,
        maxMinor: p.max_minor,
      };
    case 'part_prepayment':
      return {
        purpose: p.purpose,
        amountSource: p.amount_source,
        minMinor: p.min_minor,
        maxMinor: p.max_minor,
      };
    case 'foreclosure':
      return {
        purpose: p.purpose,
        amountSource: p.amount_source,
        amountMinor: p.amount_minor,
        quoteId: p.quote_id,
        validUntil: p.valid_until,
        flagged: p.flagged,
        minMinor: p.min_minor,
        maxMinor: p.max_minor,
      };
  }
}

function mapPaymentOptions(raw: unknown) {
  const o = DbPaymentOptions.parse(raw);
  return {
    loanId: o.loan_account_id,
    lenderDisplayName: o.lender_display_name,
    available: o.available,
    unavailableKey: o.unavailable_key,
    destinationMaskedRef: o.destination_masked_ref,
    figuresAvailable: o.figures_available,
    stale: o.stale,
    reportedAsOf: o.reported_as_of,
    purposes: o.purposes.map(mapPurposeOption),
    penalCharge: o.penal_charge
      ? {
          version: o.penal_charge.version,
          sentenceEn: o.penal_charge.sentence_en,
          sentenceHi: o.penal_charge.sentence_hi,
        }
      : null,
    penalChargeTextMissing: o.penal_charge_text_missing,
    openPayments: o.open_payments.map((p) => ({
      id: p.intent_id,
      purpose: p.purpose,
      status: p.status,
    })),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Mandates: column lists and mappers
// ---------------------------------------------------------------------------------------------------------------
interface MandateRow {
  id: string;
  loanId: string;
  lenderDisplayName: string;
  rail: string;
  status: string;
  maxAmountMinor: string;
  startDate: string;
  endDate: string;
  maskedAccountRef: string;
  needsAfaEachDebit: boolean;
  cancelRequested: boolean;
  nextDebitOn: string | null;
  nextDebitMinor: string | null;
  nextDebitNotified: boolean | null;
}
const MANDATE_COLUMNS = columns({
  id: 'mandate_id',
  loanId: 'loan_account_id',
  lenderDisplayName: 'lender_display_name',
  rail: 'rail',
  status: 'status',
  maxAmountMinor: 'max_amount_minor::text',
  startDate: day('start_date'),
  endDate: day('end_date'),
  maskedAccountRef: 'masked_account_ref',
  needsAfaEachDebit: 'needs_afa_each_debit',
  cancelRequested: 'cancel_requested',
  nextDebitOn: day('next_debit_on'),
  nextDebitMinor: 'next_debit_minor::text',
  nextDebitNotified: 'next_debit_notified',
});
const mapMandate = (r: MandateRow) => ({
  id: r.id,
  loanId: r.loanId,
  lenderDisplayName: r.lenderDisplayName,
  rail: r.rail,
  status: r.status,
  maxAmountMinor: paise(r.maxAmountMinor),
  startDate: r.startDate,
  endDate: r.endDate,
  maskedAccountRef: r.maskedAccountRef,
  needsAfaEachDebit: r.needsAfaEachDebit,
  cancelRequested: r.cancelRequested,
  nextDebitOn: r.nextDebitOn,
  nextDebitMinor: paiseOrNull(r.nextDebitMinor),
  nextDebitNotified: r.nextDebitNotified,
});

/** One of the caller's own mandates, as payments.my_mandates lists it (the function only ever returns the caller's). */
async function readMandate(tx: UserTx, id: string) {
  const r = await tx.query<MandateRow>(
    `select ${MANDATE_COLUMNS} from payments.my_mandates() where mandate_id = $1::uuid`,
    [id],
  );
  if (r.rows.length === 0) throw notFound();
  return mapMandate(first(r.rows));
}

const DbMandateOptions = z.object({
  loan_account_id: z.uuid(),
  lender_display_name: z.string(),
  available: z.boolean(),
  unavailable_key: z.enum(BP_MANDATE_UNAVAILABLE_KEYS).nullable(),
  requirement: z.enum(BP_MANDATE_REQUIREMENTS).nullable(),
  pre_debit_lead_hours: z.number().int(),
  rails: z.array(
    z.object({
      rail: z.enum(BP_MANDATE_RAILS),
      max_amount_minor: Paise,
      needs_afa_each_debit: z.boolean(),
    }),
  ),
  existing_mandate_id: z.uuid().nullable(),
});
function mapMandateOptions(raw: unknown) {
  const o = DbMandateOptions.parse(raw);
  return {
    loanId: o.loan_account_id,
    lenderDisplayName: o.lender_display_name,
    available: o.available,
    unavailableKey: o.unavailable_key,
    requirement: o.requirement,
    preDebitLeadHours: o.pre_debit_lead_hours,
    rails: o.rails.map((r) => ({
      rail: r.rail,
      maxAmountMinor: r.max_amount_minor,
      needsAfaEachDebit: r.needs_afa_each_debit,
    })),
    existingMandateId: o.existing_mandate_id,
  };
}

interface DebitRow {
  id: string;
  scheduledOn: string;
  amountMinor: string | null;
  status: string;
  planned: boolean;
  returnCode: string | null;
  returnClass: string | null;
  noticeStatus: string | null;
  noticeDueAt: string | null;
  noticeSentAt: string | null;
}
const DEBIT_COLUMNS = columns({
  id: 'debit_id',
  scheduledOn: day('scheduled_on'),
  amountMinor: 'amount_minor::text',
  status: 'status',
  planned: 'planned',
  returnCode: 'return_code',
  returnClass: 'return_class',
  noticeStatus: 'notice_status',
  noticeDueAt: ts('notice_due_at'),
  noticeSentAt: ts('notice_sent_at'),
});
function mapDebit(r: DebitRow) {
  let notice: { status: string; dueAt: string; sentAt: string | null } | null = null;
  if (r.noticeStatus !== null) {
    if (r.noticeDueAt === null)
      throw new Error('the database returned a notice without a due time');
    notice = { status: r.noticeStatus, dueAt: r.noticeDueAt, sentAt: r.noticeSentAt };
  }
  return {
    id: r.id,
    scheduledOn: r.scheduledOn,
    amountMinor: paiseOrNull(r.amountMinor),
    status: r.status,
    planned: r.planned,
    returnCode: r.returnCode,
    returnClass: r.returnClass,
    notice,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Hand-off links
// ---------------------------------------------------------------------------------------------------------------
interface LinkRow {
  lenderId: string;
  keyVersion: string;
  alg: string;
  ciphertext: Buffer;
  expiresAt: string;
}
/** The one cipher the vault implements (`packages/adapters/src/handoff-vault.ts`); a row with another name is not opened. */
const VAULT_ALG = 'aes-256-gcm';

/** True when a database error carries exactly this hint (the stable word the SQL function raised). */
const hasHint = (error: unknown, hint: string): boolean =>
  typeof error === 'object' && error !== null && (error as { hint?: unknown }).hint === hint;

export function paymentsRoutes(deps: { handoff?: HandoffKeyring }): RouteDefinition[] {
  /**
   * Fetches the sealed link of one payment or mandate and opens it. The keyring is checked FIRST, so a missing key does not count a
   * read that could not be delivered. Not yours, not waiting for you, expired, or the lender's switch is off: the database
   * answers P0002 and the caller sees 404 (the cases are indistinguishable). A link that cannot be opened (wrong key, tampering,
   * a stored value that no longer looks like a link) is a 500 with no detail; the log line names the error class and the subject
   * id, never the link.
   */
  async function openLink(request: FastifyRequest, tx: UserTx, kind: HandoffKind, id: string) {
    const keyring = deps.handoff;
    if (!keyring) {
      throw new ApiError(
        503,
        'handoff_unavailable',
        'Service Unavailable',
        'Payment links cannot be shown in this environment.',
      );
    }
    const r = await tx.query<LinkRow>(
      `select lender_org_id as "lenderId", key_version as "keyVersion", alg, ciphertext, ${ts('expires_at')} as "expiresAt"
         from payments.take_handoff_link($1, $2::uuid)`,
      [kind, id],
    );
    const row = first(r.rows);
    let link: string;
    try {
      if (row.alg !== VAULT_ALG) throw new HandoffVaultError('cannot_open');
      link = openHandoffLink(
        keyring,
        { kind, subjectId: id, lenderOrgId: row.lenderId },
        row.keyVersion,
        row.ciphertext,
      );
    } catch (error) {
      request.log.error(
        {
          errorClass: error instanceof Error ? error.name : 'unknown',
          reason: error instanceof HandoffVaultError ? error.reason : 'unexpected',
          subjectKind: kind,
          subjectId: id,
        },
        'a stored hand-off link could not be opened',
      );
      throw new ApiError(500, 'internal_error', 'Internal Server Error');
    }
    return {
      status: 200,
      headers: { 'cache-control': 'no-store' },
      body: { link, expiresAt: row.expiresAt },
    };
  }

  return [
    // ---- payments ---------------------------------------------------------------------------------------------------
    userRoute({
      method: 'get',
      path: '/v1/loans/:id/payment-options',
      operationId: 'getPaymentOptions',
      summary: 'What can be paid on this loan now',
      description:
        "The lender's reported next installment and overdue figures (or a part the lender accepts), a part-prepayment within the lender's limits, the amount of an unexpired lender quotation, the lender's masked destination account, the lender's approved penal-charge sentence when something is overdue, and the borrower's open payments. Nothing is offered when the figures are missing, withheld or stale, or the lender's collection target is not valid (`unavailableKey` names why). Udofin computes none of these amounts. Another borrower's loan, and a lender whose payments switch is off, answer 404.",
      tags: ['Payments'],
      auth: 'borrower',
      params: BpIdParam,
      responses: { 200: BpPaymentOptions },
      errors: [401, 403, 404],
      rateLimit: READ_LIMIT,
      handler: async ({ tx, params }) => {
        const r = await tx.query<{ r: unknown }>(
          'select payments.my_payment_options($1::uuid) as r',
          [params.id],
        );
        return { status: 200, body: mapPaymentOptions(first(r.rows).r) };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/loans/:id/payments',
      operationId: 'requestPayment',
      summary:
        'Ask to pay this loan (the lender decides the amounts; the provider takes the money)',
      description:
        "Creates a payment request ('created'). The database checks the amount against the lender's REPORTED figures (exactly the reported figure, or a part the lender accepts, or between the lender's limits, or exactly the lender's unexpired quotation), the lender's payment configuration and the lender's switches. The order at the payment provider is created AFTER this request commits, by a background job, so the response never waits for it: poll `GET /v1/payments/{id}` until `linkAvailable` is true, then fetch the link. Repeating the request with the same Idempotency-Key and the same content returns the same payment. Nothing the app reports moves the payment: only verified provider events and the lender's own receipts do.",
      tags: ['Payments'],
      auth: 'borrower',
      idempotent: true,
      params: BpIdParam,
      body: BpPaymentRequest,
      responses: { 201: BpPaymentDetail },
      errors: [400, 401, 403, 404, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params, body, idempotencyKey }) => {
        if (idempotencyKey === undefined) throw new Error('an idempotent route has no key');
        const created = await tx.query<{ id: string }>(
          'select payments.request_payment($1::uuid, $2::payments.intent_purpose, $3::bigint, $4, $5::uuid) as id',
          [params.id, body.purpose, body.amountMinor, idempotencyKey, body.quoteId ?? null],
        );
        return { status: 201, body: await readPayment(tx, first(created.rows).id) };
      },
    }),
    userRoute({
      method: 'get',
      path: '/v1/payments/:id',
      operationId: 'getPayment',
      summary: 'One of your payments, with its honest stage',
      description:
        "The stage is derived by the database only from verified provider events and the lender's own receipts: `started`, `provider_received` (the provider reports it; the lender has not necessarily posted it), `lender_posted` (the lender's own receipt names it) or `needs_attention`. Another borrower's payment, and a lender whose payments switch is off, answer 404.",
      tags: ['Payments'],
      auth: 'borrower',
      params: BpIdParam,
      responses: { 200: BpPaymentDetail },
      errors: [401, 403, 404],
      rateLimit: READ_LIMIT,
      handler: async ({ tx, params }) => ({
        status: 200,
        body: await readPayment(tx, params.id),
      }),
    }),
    userRoute({
      method: 'get',
      path: '/v1/payments/:id/link',
      operationId: 'getPaymentLink',
      summary: "The provider's checkout link for a pending payment",
      description:
        'The link is a bearer secret: whoever holds it can complete the payment. It is opened only for the borrower who owns the payment, only while the payment is pending and the link has not expired, is returned with `cache-control: no-store` and is never logged. Not yours, not pending, expired or not stored: 404. No key configured in this environment: 503 `handoff_unavailable`.',
      tags: ['Payments'],
      auth: 'borrower',
      params: BpIdParam,
      responses: { 200: BpHandoffLink },
      errors: [401, 403, 404, 503],
      rateLimit: LINK_LIMIT,
      handler: ({ request, tx, params }) => openLink(request, tx, 'payment_intent', params.id),
    }),
    userRoute({
      method: 'post',
      path: '/v1/payments/:id/cancel',
      operationId: 'cancelPayment',
      summary: 'Cancel a payment that has no order at the provider yet',
      description:
        'Only a payment in status `created` can be cancelled (409 `intent_not_cancellable` otherwise): once an order exists, its link expires on its own and any money received on it is handled through the provider-event and reconciliation path. Repeating the request answers the same.',
      tags: ['Payments'],
      auth: 'borrower',
      idempotent: true,
      params: BpIdParam,
      responses: { 200: BpPaymentCancelled },
      errors: [400, 401, 403, 404, 409],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params }) => {
        try {
          await tx.query('select payments.cancel_my_payment($1::uuid)', [params.id]);
        } catch (error) {
          // The stable word of the SQL function, kept here until the shared hint table lists it.
          if (hasHint(error, 'intent_not_cancellable')) {
            throw new ApiError(409, 'intent_not_cancellable', 'Conflict');
          }
          throw error;
        }
        return { status: 200, body: { id: params.id, status: 'cancelled' as const } };
      },
    }),

    // ---- mandates ---------------------------------------------------------------------------------------------------
    userRoute({
      method: 'get',
      path: '/v1/loans/:id/mandate-options',
      operationId: 'getMandateOptions',
      summary: 'Which mandate rails the lender offers for this loan',
      description:
        "Only rails whose limits were copied from the provider's documentation into the lender's configuration are listed, with the maximum amount per rail (the lower of the rail limit and the lender's ceiling), whether the rail may ask for authentication on every debit, the lender's mandate requirement (informational), the pre-debit notice lead time and the loan's existing live mandate. `unavailableKey` names the first reason nothing can be offered. Another borrower's loan, and a lender whose mandates switch is off, answer 404.",
      tags: ['Mandates'],
      auth: 'borrower',
      params: BpIdParam,
      responses: { 200: BpMandateOptions },
      errors: [401, 403, 404],
      rateLimit: READ_LIMIT,
      handler: async ({ tx, params }) => {
        const r = await tx.query<{ r: unknown }>(
          'select payments.my_mandate_options($1::uuid) as r',
          [params.id],
        );
        return { status: 200, body: mapMandateOptions(first(r.rows).r) };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/loans/:id/mandates',
      operationId: 'requestMandate',
      summary:
        'Ask for a mandate for automatic debits (needs a verified step-up code bound to the mandate id)',
      description:
        "The app chooses `mandateId`, asks for a step-up code with action `mandate_creation` and that id as `contextRef`, verifies it with the step-up endpoints, then calls this route. The database checks the code (403 `stepup_required`), the device-integrity level (403 `integrity_insufficient`), the lender's configuration, the rail limits, the amount, the dates and the masked reference (a full account number is refused with 422 `account_ref_invalid`). It creates a DRAFT: the mandate is registered only when the provider confirms it, so the status stays 'draft' and then 'registration_pending' until a verified provider event or an authenticated lookup says otherwise. Fetch the authorisation link from `GET /v1/mandates/{id}/link` once the status is 'registration_pending'. Repeating the request with the same content returns the same mandate.",
      tags: ['Mandates'],
      auth: 'borrower',
      idempotent: true,
      params: BpIdParam,
      body: BpMandateRequest,
      responses: { 201: BpMandate },
      errors: [400, 401, 403, 404, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params, body }) => {
        await tx.query(
          'select payments.request_mandate($1::uuid, $2::uuid, $3, $4::bigint, $5::date, $6::date, $7)',
          [
            body.mandateId,
            params.id,
            body.rail,
            body.maxAmountMinor ?? null,
            body.startDate,
            body.endDate,
            body.maskedAccountRef,
          ],
        );
        return { status: 201, body: await readMandate(tx, body.mandateId) };
      },
    }),
    userRoute({
      method: 'get',
      path: '/v1/mandates',
      operationId: 'listMandates',
      summary: 'Your mandates, newest first',
      description:
        'The status is exactly what the provider-confirmed history last left it: nothing is `active` until the provider says so. Mandates of a lender whose mandates switch is off are not listed.',
      tags: ['Mandates'],
      auth: 'borrower',
      responses: { 200: BpMandateList },
      errors: [401, 403],
      rateLimit: READ_LIMIT,
      handler: async ({ tx }) => {
        const r = await tx.query<MandateRow>(
          `select ${MANDATE_COLUMNS} from payments.my_mandates()`,
        );
        return { status: 200, body: { items: r.rows.map(mapMandate) } };
      },
    }),
    userRoute({
      method: 'get',
      path: '/v1/mandates/:id',
      operationId: 'getMandate',
      summary: 'One of your mandates',
      description:
        "Another borrower's mandate, and a lender whose mandates switch is off, answer 404.",
      tags: ['Mandates'],
      auth: 'borrower',
      params: BpIdParam,
      responses: { 200: BpMandate },
      errors: [401, 403, 404],
      rateLimit: READ_LIMIT,
      handler: async ({ tx, params }) => ({
        status: 200,
        body: await readMandate(tx, params.id),
      }),
    }),
    userRoute({
      method: 'get',
      path: '/v1/mandates/:id/link',
      operationId: 'getMandateLink',
      summary: "The provider's authorisation link for a mandate waiting for you",
      description:
        'The link is a bearer secret. It is opened only for the borrower who owns the mandate, only while the mandate is `registration_pending` and the hand-off has not expired, is returned with `cache-control: no-store` and is never logged. Not yours, not waiting, expired or not stored: 404. No key configured in this environment: 503 `handoff_unavailable`.',
      tags: ['Mandates'],
      auth: 'borrower',
      params: BpIdParam,
      responses: { 200: BpHandoffLink },
      errors: [401, 403, 404, 503],
      rateLimit: LINK_LIMIT,
      handler: ({ request, tx, params }) => openLink(request, tx, 'mandate', params.id),
    }),
    userRoute({
      method: 'post',
      path: '/v1/mandates/:id/cancel',
      operationId: 'cancelMandate',
      summary: 'Ask to cancel a mandate',
      description:
        'Records the REQUEST and queues it for the provider; the mandate becomes `cancelled` only when the provider confirms it (a verified event or an authenticated lookup), or, for a draft the provider never saw, when the system abandons it. The answer is 202 with `cancel_requested`; `GET /v1/mandates/{id}` then shows `cancelRequested: true` and the unchanged status. A finished mandate answers 409 `mandate_finished`. Repeating the request answers the same.',
      tags: ['Mandates'],
      auth: 'borrower',
      idempotent: true,
      params: BpIdParam,
      responses: { 202: BpMandateCancelRequested },
      errors: [400, 401, 403, 404, 409],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params }) => {
        await tx.query('select payments.request_mandate_cancellation($1::uuid)', [params.id]);
        return { status: 202, body: { id: params.id, result: 'cancel_requested' as const } };
      },
    }),
    userRoute({
      method: 'get',
      path: '/v1/mandates/:id/debits',
      operationId: 'listMandateDebits',
      summary: 'The newest debits of one of your mandates, with the pre-debit notice state',
      description:
        "At most 60, newest scheduled date first. A planned debit is what Udofin expects from the lender's reported schedule; an unplanned one is what the provider reported. The return code is the provider's own; its class is shown only when the lender's configuration classified it. Another borrower's mandate, and a lender whose mandates switch is off, answer 404.",
      tags: ['Mandates'],
      auth: 'borrower',
      params: BpIdParam,
      responses: { 200: BpMandateDebitList },
      errors: [401, 403, 404],
      rateLimit: READ_LIMIT,
      handler: async ({ tx, params }) => {
        const r = await tx.query<DebitRow>(
          `select ${DEBIT_COLUMNS} from payments.my_mandate_debits($1::uuid)`,
          [params.id],
        );
        return { status: 200, body: { items: r.rows.map(mapDebit) } };
      },
    }),
  ];
}
