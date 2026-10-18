import {
  LrArtefactAction,
  LrDeliveryLog,
  LrHoldListQuery,
  LrHoldPage,
  LrHoldPlaceInput,
  LrHoldPlaced,
  LrHoldReleaseInput,
  LrHoldReleased,
  LrPenalText,
  LrPenalTextDraftInput,
  LrPenalTextListQuery,
  LrPenalTextPage,
  LrPolicy,
  LrPolicyDraftInput,
  LrPolicyListQuery,
  LrPolicyPage,
  LrReminderListQuery,
  LrReminderPage,
  LrReminderSummary,
  LrReminderSummaryQuery,
  LrTemplate,
  LrTemplateDraftInput,
  LrTemplateListQuery,
  LrTemplatePage,
} from '@udofin/contracts';
import { z } from 'zod';
import { columns } from '../../db/columns.js';
import { type UserTx } from '../../db/user-context.js';
import { ApiError } from '../../http/api-error.js';
import { decodeCursor, encodeCursor } from '../../http/pagination.js';
import { userRoute, type RouteDefinition } from '../../http/routes.js';

/**
 * Phase 08a, lender side: the reminder policy, the reminder wording, the lender's penal-charge text, communication holds, the
 * reminders themselves and their attempt log.
 *
 * Every rule lives in the database. Reads go through row level security (a lender sees its own rows; platform operations roles
 * see every lender's through loan.read); writes call the SQL functions, which check the permission, the second factor, the
 * two-person approval and the closed vocabularies. These routes validate the shape of a request, take the caller from the
 * token, pass identifiers, and map the result. Nothing here computes a charge, writes, suggests or translates a sentence,
 * derives a stage or decides who may send what.
 *
 * What is passed through verbatim: the policy figures, the wording and the penal-charge figure and sentences are the lender's own
 * words and numbers. They are handed to the SQL functions unchanged (the database refuses what is not acceptable, with a stable
 * code) and returned exactly as stored.
 *
 * Responses are mapped field by field from the columns this module chooses to read: no row is ever spread, and the contract
 * schemas are strict, so an undeclared field cannot leave the API. Nothing here writes a log line.
 */

const WRITE_LIMIT = { max: 30, timeWindow: '1 minute' };
const READ_LIMIT = { max: 120, timeWindow: '1 minute' };
const Id = z.strictObject({ id: z.uuid() });

/** The permissions that let a lender user read each family of rows (they mirror the row level security policies). */
const READ_ARTEFACTS = [
  'loan.read',
  'reminder.policy.manage',
  'reminder.template.approve',
] as const;
const READ_LOANS = ['loan.read'] as const;

/** ISO text of a timestamp column (microsecond precision, with offset), null stays null. */
const ts = (column: string) => `(to_jsonb(${column}) #>> '{}')`;
const day = (column: string) => `to_char(${column}, 'YYYY-MM-DD')`;
const clock = (column: string) => `to_char(${column}, 'HH24:MI')`;

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

const notFound = () => new ApiError(404, 'not_found', 'Not Found');

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
 * Row level security hides other lenders' rows; this makes "you may not read this at all" an explicit 403 instead of a silent
 * empty list, and a lender filter the caller holds no permission on a 403 too (the same rule as the policies on the tables).
 */
async function requireReader(
  tx: UserTx,
  permissions: readonly string[],
  lenderId: string | undefined,
): Promise<void> {
  const r = await tx.query<{ ok: boolean }>(
    `select exists (select 1 from unnest($1::text[]) as p(key) cross join lateral private.orgs_with_permission(p.key) as o(id)
                     where $2::uuid is null or o.id = $2::uuid) as ok`,
    [permissions, lenderId ?? null],
  );
  if (!r.rows[0]?.ok) throw new ApiError(403, 'forbidden', 'Forbidden');
}

// ---------------------------------------------------------------------------------------------------------------
// Column lists and mappers (explicit: a column that is not listed here cannot reach a response)
// ---------------------------------------------------------------------------------------------------------------
interface PolicyRow {
  id: string;
  lenderId: string;
  version: number;
  status: string;
  offsetsDays: number[];
  overdueWeekly: boolean;
  channels: string[];
  windowFrom: string;
  windowTo: string;
  maxPerDay: number;
  draftedBy: string;
  draftedAt: string;
  approvedBy: string | null;
  approvedAt: string | null;
  retiredBy: string | null;
  retiredAt: string | null;
}
const POLICY_COLUMNS = columns({
  id: 'p.id',
  lenderId: 'p.lender_org_id',
  version: 'p.version',
  status: 'p.status',
  offsetsDays: 'p.offsets_days',
  overdueWeekly: 'p.overdue_weekly',
  channels: 'p.channels',
  windowFrom: clock('p.window_from'),
  windowTo: clock('p.window_to'),
  maxPerDay: 'p.max_per_day',
  draftedBy: 'p.drafted_by',
  draftedAt: ts('p.drafted_at'),
  approvedBy: 'p.approved_by',
  approvedAt: ts('p.approved_at'),
  retiredBy: 'p.retired_by',
  retiredAt: ts('p.retired_at'),
});
const mapPolicy = (r: PolicyRow) => ({
  id: r.id,
  lenderId: r.lenderId,
  version: r.version,
  status: r.status,
  offsetsDays: r.offsetsDays,
  overdueWeekly: r.overdueWeekly,
  channels: r.channels,
  windowFrom: r.windowFrom,
  windowTo: r.windowTo,
  maxPerDay: r.maxPerDay,
  draftedBy: r.draftedBy,
  draftedAt: r.draftedAt,
  approvedBy: r.approvedBy,
  approvedAt: r.approvedAt,
  retiredBy: r.retiredBy,
  retiredAt: r.retiredAt,
});

interface TemplateRow {
  id: string;
  lenderId: string;
  kind: string;
  language: string;
  version: number;
  status: string;
  body: string;
  draftedBy: string;
  draftedAt: string;
  approvedBy: string | null;
  approvedAt: string | null;
  retiredBy: string | null;
  retiredAt: string | null;
}
const TEMPLATE_COLUMNS = columns({
  id: 't.id',
  lenderId: 't.lender_org_id',
  kind: 't.kind',
  language: 't.language',
  version: 't.version',
  status: 't.status',
  body: 't.body',
  draftedBy: 't.drafted_by',
  draftedAt: ts('t.drafted_at'),
  approvedBy: 't.approved_by',
  approvedAt: ts('t.approved_at'),
  retiredBy: 't.retired_by',
  retiredAt: ts('t.retired_at'),
});
const mapTemplate = (r: TemplateRow) => ({
  id: r.id,
  lenderId: r.lenderId,
  kind: r.kind,
  language: r.language,
  version: r.version,
  status: r.status,
  body: r.body,
  draftedBy: r.draftedBy,
  draftedAt: r.draftedAt,
  approvedBy: r.approvedBy,
  approvedAt: r.approvedAt,
  retiredBy: r.retiredBy,
  retiredAt: r.retiredAt,
});

interface PenalTextRow {
  id: string;
  lenderId: string;
  version: number;
  status: string;
  chargeKind: string;
  flatAmountMinor: string | null;
  percentBps: number | null;
  basis: string;
  separateFromInterest: boolean;
  notCompounded: boolean;
  reason: string;
  sentenceEn: string;
  sentenceHi: string | null;
  draftedBy: string;
  draftedAt: string;
  approvedBy: string | null;
  approvedAt: string | null;
  retiredBy: string | null;
  retiredAt: string | null;
}
const PENAL_COLUMNS = columns({
  id: 't.id',
  lenderId: 't.lender_org_id',
  version: 't.version',
  status: 't.status',
  chargeKind: 't.charge_kind',
  flatAmountMinor: 't.flat_amount_minor::text',
  percentBps: 't.percent_bps',
  basis: 't.basis',
  separateFromInterest: 't.separate_from_interest',
  notCompounded: 't.not_compounded',
  reason: 't.reason',
  sentenceEn: 't.sentence_en',
  sentenceHi: 't.sentence_hi',
  draftedBy: 't.drafted_by',
  draftedAt: ts('t.drafted_at'),
  approvedBy: 't.approved_by',
  approvedAt: ts('t.approved_at'),
  retiredBy: 't.retired_by',
  retiredAt: ts('t.retired_at'),
});
const mapPenalText = (r: PenalTextRow) => ({
  id: r.id,
  lenderId: r.lenderId,
  version: r.version,
  status: r.status,
  chargeKind: r.chargeKind,
  flatAmountMinor: paiseOrNull(r.flatAmountMinor),
  percentBps: r.percentBps,
  basis: r.basis,
  separateFromInterest: r.separateFromInterest,
  notCompounded: r.notCompounded,
  reason: r.reason,
  sentenceEn: r.sentenceEn,
  sentenceHi: r.sentenceHi,
  draftedBy: r.draftedBy,
  draftedAt: r.draftedAt,
  approvedBy: r.approvedBy,
  approvedAt: r.approvedAt,
  retiredBy: r.retiredBy,
  retiredAt: r.retiredAt,
});

interface HoldRow {
  id: string;
  lenderId: string;
  loanAccountId: string;
  reason: string;
  note: string | null;
  placedBy: string;
  placedAt: string;
  releasedBy: string | null;
  releasedAt: string | null;
  releaseNote: string | null;
  active: boolean;
}
const HOLD_COLUMNS = columns({
  id: 'h.id',
  lenderId: 'h.lender_org_id',
  loanAccountId: 'h.loan_account_id',
  reason: 'h.reason',
  note: 'h.note',
  placedBy: 'h.placed_by',
  placedAt: ts('h.placed_at'),
  releasedBy: 'h.released_by',
  releasedAt: ts('h.released_at'),
  releaseNote: 'h.release_note',
  active: '(h.released_at is null)',
});
const mapHold = (r: HoldRow) => ({
  id: r.id,
  lenderId: r.lenderId,
  loanAccountId: r.loanAccountId,
  reason: r.reason,
  note: r.note,
  placedBy: r.placedBy,
  placedAt: r.placedAt,
  releasedBy: r.releasedBy,
  releasedAt: r.releasedAt,
  releaseNote: r.releaseNote,
  active: r.active,
});

interface ReminderRow {
  id: string;
  lenderId: string;
  loanAccountId: string;
  installmentSeq: number;
  dueDate: string;
  offsetDays: number;
  channel: string;
  kind: string;
  scheduledFor: string;
  status: string;
  suppressReason: string | null;
  attempts: number;
  claimedAt: string | null;
  templateId: string | null;
  penalTextId: string | null;
  languageUsed: string | null;
  languageFallback: boolean;
  amountMinor: string | null;
  createdAt: string;
  updatedAt: string;
}
// The rendered wording is not stored in this table (only the references and the figures frozen at claim), so none is returned.
// `variables` is read for ONE key: the amount the lender reported, which the lender may see (its own figure, row level security
// applies). The lender display name and the due date inside it are not read: the due date is its own column.
const REMINDER_COLUMNS = columns({
  id: 'r.id',
  lenderId: 'r.lender_org_id',
  loanAccountId: 'r.loan_account_id',
  installmentSeq: 'r.installment_seq',
  dueDate: day('r.due_date'),
  offsetDays: 'r.offset_days',
  channel: 'r.channel',
  kind: 'r.kind',
  scheduledFor: ts('r.scheduled_for'),
  status: 'r.status',
  suppressReason: 'r.suppress_reason',
  attempts: 'r.attempts',
  claimedAt: ts('r.claimed_at'),
  templateId: 'r.template_id',
  penalTextId: 'r.penal_text_id',
  languageUsed: 'r.language_used',
  languageFallback: 'r.language_fallback',
  amountMinor: "(r.variables ->> 'amount_minor')",
  createdAt: ts('r.created_at'),
  updatedAt: ts('r.updated_at'),
});
const mapReminder = (r: ReminderRow) => ({
  id: r.id,
  lenderId: r.lenderId,
  loanAccountId: r.loanAccountId,
  installmentSeq: r.installmentSeq,
  dueDate: r.dueDate,
  offsetDays: r.offsetDays,
  channel: r.channel,
  kind: r.kind,
  scheduledFor: r.scheduledFor,
  status: r.status,
  suppressReason: r.suppressReason,
  attempts: r.attempts,
  claimedAt: r.claimedAt,
  templateId: r.templateId,
  penalTextId: r.penalTextId,
  languageUsed: r.languageUsed,
  languageFallback: r.languageFallback,
  amountMinor: paiseOrNull(r.amountMinor),
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

interface DeliveryRow {
  id: string;
  channel: string;
  state: string;
  source: string;
  providerRef: string | null;
  errorClass: string | null;
  contentSha256: string;
  penalTextSha256: string | null;
  occurredAt: string;
}
const DELIVERY_COLUMNS = columns({
  id: 'd.id',
  channel: 'd.channel',
  state: 'd.state',
  source: 'd.source',
  providerRef: 'd.provider_ref',
  errorClass: 'd.error_class',
  contentSha256: 'd.content_sha256',
  penalTextSha256: 'd.penal_text_sha256',
  occurredAt: ts('d.occurred_at'),
});
const mapDelivery = (r: DeliveryRow) => ({
  id: r.id,
  channel: r.channel,
  state: r.state,
  source: r.source,
  providerRef: r.providerRef,
  errorClass: r.errorClass,
  contentSha256: r.contentSha256,
  penalTextSha256: r.penalTextSha256,
  occurredAt: r.occurredAt,
});

/** Reads one row the caller just wrote (or is about to describe), through row level security. */
async function loadOne<R extends object>(
  tx: UserTx,
  table: string,
  alias: string,
  cols: string,
  id: string,
): Promise<R> {
  const r = await tx.query<R>(
    `select ${cols} from ${table} ${alias} where ${alias}.id = $1::uuid`,
    [id],
  );
  const row = r.rows[0];
  if (!row) throw new Error('the row that was just written cannot be read back');
  return row;
}

/**
 * Whether the lender has an APPROVED penal-charge text, and its negation: while it has none, overdue reminders are suppressed
 * (`penal_text_missing`) and never sent. Both come straight out of the rows (row level security applies); no rule is applied here.
 */
async function overdueState(tx: UserTx, lenderId: string) {
  const r = await tx.query<{ penalTextApproved: boolean; overdueRemindersWithheld: boolean }>(
    `select exists (select 1 from servicing.penal_charge_texts t where t.lender_org_id = $1::uuid and t.status = 'approved') as "penalTextApproved",
            not exists (select 1 from servicing.penal_charge_texts t where t.lender_org_id = $1::uuid and t.status = 'approved') as "overdueRemindersWithheld"`,
    [lenderId],
  );
  const row = r.rows[0];
  if (!row) throw new Error('the overdue state query returned nothing');
  return {
    penalTextApproved: row.penalTextApproved,
    overdueRemindersWithheld: row.overdueRemindersWithheld,
  };
}

/** Approve or retire one of the three artefacts by id; the database says who may, and another lender's id looks unknown. */
function artefactAction(spec: {
  slug: string;
  noun: string;
  action: 'approve' | 'retire';
  fn: string;
  operationId: string;
  permission: string;
}): RouteDefinition {
  const approving = spec.action === 'approve';
  return userRoute({
    method: 'post',
    path: `/v1/lender/${spec.slug}/:id/${spec.action}`,
    operationId: spec.operationId,
    summary: approving
      ? `Approve a drafted ${spec.noun} (a different person than the drafter)`
      : `Retire a draft or approved ${spec.noun}`,
    description: approving
      ? `Needs ${spec.permission} of the lender and a second factor, and must be a DIFFERENT person than the drafter (self_approval otherwise, 403). Only a draft can be approved (not_a_draft, 409). Approving retires the previously approved version. Another lender's id, an unknown id and an id the caller has no permission over all answer 404.`
      : `Needs ${spec.permission} of the lender and a second factor. A draft or an approved version can be retired (already_retired, 409, otherwise). Another lender's id, an unknown id and an id the caller has no permission over all answer 404.`,
    tags: ['Reminders (lender)'],
    auth: 'staff',
    idempotent: true,
    params: Id,
    responses: { 200: LrArtefactAction },
    errors: [400, 401, 403, 404, 409],
    rateLimit: WRITE_LIMIT,
    handler: async ({ tx, params }) => {
      const r = await tx.query<{ r: string }>(`select ${spec.fn}($1::uuid) as r`, [params.id]);
      return { status: 200, body: { id: params.id, status: first(r.rows) } };
    },
  });
}

/**
 * The routes. Lender users and platform staff are both `auth: 'staff'` (a second factor is always required); what each may read
 * or write is decided by the permissions and row level security in the database.
 */
export function lenderRemindersRoutes(_deps: Record<string, never>): RouteDefinition[] {
  void _deps;
  return [
    // ---- reminder policy ------------------------------------------------------------------------------------------
    userRoute({
      method: 'get',
      path: '/v1/lender/reminder-policies',
      operationId: 'listLenderReminderPolicies',
      summary: 'Your reminder policy versions (draft, approved, retired), newest first',
      description:
        'Needs loan.read, reminder.policy.manage or reminder.template.approve of that lender (a lender you hold none of answers 403). One version per draft; at most one is approved. `overdueReminders` says whether the lender has an approved penal-charge text: while it has none, overdue reminders are suppressed (penal_text_missing) and never sent. It is read from the penal-charge text rows, not decided here.',
      tags: ['Reminders (lender)'],
      auth: 'staff',
      query: LrPolicyListQuery,
      responses: { 200: LrPolicyPage },
      errors: [400, 401, 403, 422],
      rateLimit: READ_LIMIT,
      handler: async ({ tx, query }) => {
        await requireReader(tx, READ_ARTEFACTS, query.lenderId);
        const w = new Where();
        w.add((p) => `p.lender_org_id = ${p}::uuid`, query.lenderId);
        if (query.status) w.add((p) => `p.status = ${p}`, query.status);
        olderThan(w, query.cursor, 'p.drafted_at', 'p.id');
        const limit = w.placeholder(query.limit + 1);
        const r = await tx.query<PolicyRow>(
          `select ${POLICY_COLUMNS} from servicing.reminder_policies p where ${w.sql}
            order by p.drafted_at desc, p.id desc limit ${limit}::int`,
          w.values,
        );
        return {
          status: 200,
          body: {
            ...pageOf(r.rows, query.limit, mapPolicy, (row) =>
              encodeCursor({ t: row.draftedAt, id: row.id }),
            ),
            overdueReminders: await overdueState(tx, query.lenderId),
          },
        };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/lender/reminder-policies',
      operationId: 'draftLenderReminderPolicy',
      summary: 'Draft the next version of your reminder policy',
      description:
        'Needs reminder.policy.manage of that lender and a second factor. Nothing is sent until a DIFFERENT person approves the draft and the reminders switch is on. The figures are yours: offsets in days from each due date (negative before, positive after), channels (in_app and push; sms is accepted only as an inert placeholder that is never sent), a window and a daily cap. The database decides what is acceptable and answers offsets_invalid, channels_invalid, window_invalid or policy_invalid (422); the platform window, cap and quiet period can only narrow what you wrote.',
      tags: ['Reminders (lender)'],
      auth: 'staff',
      idempotent: true,
      idempotencyTenant: ({ body }) => (body as { lenderId: string }).lenderId,
      body: LrPolicyDraftInput,
      responses: { 201: LrPolicy },
      errors: [400, 401, 403, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, body }) => {
        const r = await tx.query<{ r: string }>(
          'select servicing.draft_reminder_policy($1::uuid, $2::int[], $3::boolean, $4::text[], $5::time, $6::time, $7::int) as r',
          [
            body.lenderId,
            body.offsetsDays,
            body.overdueWeekly,
            body.channels,
            body.windowFrom,
            body.windowTo,
            body.maxPerDay,
          ],
        );
        const row = await loadOne<PolicyRow>(
          tx,
          'servicing.reminder_policies',
          'p',
          POLICY_COLUMNS,
          first(r.rows),
        );
        return { status: 201, body: mapPolicy(row) };
      },
    }),
    artefactAction({
      slug: 'reminder-policies',
      noun: 'reminder policy',
      action: 'approve',
      fn: 'servicing.approve_reminder_policy',
      operationId: 'approveLenderReminderPolicy',
      permission: 'reminder.template.approve',
    }),
    artefactAction({
      slug: 'reminder-policies',
      noun: 'reminder policy',
      action: 'retire',
      fn: 'servicing.retire_reminder_policy',
      operationId: 'retireLenderReminderPolicy',
      permission: 'reminder.policy.manage',
    }),

    // ---- reminder wording -----------------------------------------------------------------------------------------
    userRoute({
      method: 'get',
      path: '/v1/lender/reminder-templates',
      operationId: 'listLenderReminderTemplates',
      summary: 'Your reminder wording versions per kind and language, newest first',
      description:
        'Needs loan.read, reminder.policy.manage or reminder.template.approve of that lender. The body is exactly the text that was submitted, so the approver can read it; it uses only the placeholders lender_name, due_date, amount and penal_text. Hindi wording is checked for shape only: a person who reads Hindi must approve it.',
      tags: ['Reminders (lender)'],
      auth: 'staff',
      query: LrTemplateListQuery,
      responses: { 200: LrTemplatePage },
      errors: [400, 401, 403, 422],
      rateLimit: READ_LIMIT,
      handler: async ({ tx, query }) => {
        await requireReader(tx, READ_ARTEFACTS, query.lenderId);
        const w = new Where();
        w.add((p) => `t.lender_org_id = ${p}::uuid`, query.lenderId);
        if (query.status) w.add((p) => `t.status = ${p}`, query.status);
        if (query.kind) w.add((p) => `t.kind = ${p}`, query.kind);
        if (query.language) w.add((p) => `t.language = ${p}`, query.language);
        olderThan(w, query.cursor, 't.drafted_at', 't.id');
        const limit = w.placeholder(query.limit + 1);
        const r = await tx.query<TemplateRow>(
          `select ${TEMPLATE_COLUMNS} from servicing.reminder_templates t where ${w.sql}
            order by t.drafted_at desc, t.id desc limit ${limit}::int`,
          w.values,
        );
        return {
          status: 200,
          body: pageOf(r.rows, query.limit, mapTemplate, (row) =>
            encodeCursor({ t: row.draftedAt, id: row.id }),
          ),
        };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/lender/reminder-templates',
      operationId: 'draftLenderReminderTemplate',
      summary: 'Draft the next version of your wording for a kind and language',
      description:
        'Needs reminder.policy.manage of that lender and a second factor. The wording is yours and is passed through unchanged; nothing is added, suggested or translated. The database refuses anything that is not a plain service message (a link, an address, a number that looks like a phone number, promotional wording, a placeholder outside the closed set) with wording_invalid, an unknown kind or language with template_invalid, and an overdue wording without {{penal_text}} with penal_text_variable_missing (all 422). A DIFFERENT person must approve it before it is used.',
      tags: ['Reminders (lender)'],
      auth: 'staff',
      idempotent: true,
      idempotencyTenant: ({ body }) => (body as { lenderId: string }).lenderId,
      body: LrTemplateDraftInput,
      responses: { 201: LrTemplate },
      errors: [400, 401, 403, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, body }) => {
        const r = await tx.query<{ r: string }>(
          'select servicing.draft_reminder_template($1::uuid, $2, $3, $4) as r',
          [body.lenderId, body.kind, body.language, body.body],
        );
        const row = await loadOne<TemplateRow>(
          tx,
          'servicing.reminder_templates',
          't',
          TEMPLATE_COLUMNS,
          first(r.rows),
        );
        return { status: 201, body: mapTemplate(row) };
      },
    }),
    artefactAction({
      slug: 'reminder-templates',
      noun: 'reminder wording',
      action: 'approve',
      fn: 'servicing.approve_reminder_template',
      operationId: 'approveLenderReminderTemplate',
      permission: 'reminder.template.approve',
    }),
    artefactAction({
      slug: 'reminder-templates',
      noun: 'reminder wording',
      action: 'retire',
      fn: 'servicing.retire_reminder_template',
      operationId: 'retireLenderReminderTemplate',
      permission: 'reminder.policy.manage',
    }),

    // ---- the lender's penal-charge text ---------------------------------------------------------------------------
    userRoute({
      method: 'get',
      path: '/v1/lender/penal-charge-texts',
      operationId: 'listLenderPenalChargeTexts',
      summary: 'Your penal-charge disclosure versions as you submitted them, newest first',
      description:
        'Needs loan.read, reminder.policy.manage or reminder.template.approve of that lender. Every figure and sentence is yours, returned exactly as stored: Udofin never computes, suggests, translates or fills in a charge or a sentence. `overdueReminders.penalTextApproved` is read from these rows: while it is false, overdue reminders are suppressed (penal_text_missing) and never sent, and the lender gets an exception in the reconciliation queue.',
      tags: ['Reminders (lender)'],
      auth: 'staff',
      query: LrPenalTextListQuery,
      responses: { 200: LrPenalTextPage },
      errors: [400, 401, 403, 422],
      rateLimit: READ_LIMIT,
      handler: async ({ tx, query }) => {
        await requireReader(tx, READ_ARTEFACTS, query.lenderId);
        const w = new Where();
        w.add((p) => `t.lender_org_id = ${p}::uuid`, query.lenderId);
        if (query.status) w.add((p) => `t.status = ${p}`, query.status);
        olderThan(w, query.cursor, 't.drafted_at', 't.id');
        const limit = w.placeholder(query.limit + 1);
        const r = await tx.query<PenalTextRow>(
          `select ${PENAL_COLUMNS} from servicing.penal_charge_texts t where ${w.sql}
            order by t.drafted_at desc, t.id desc limit ${limit}::int`,
          w.values,
        );
        return {
          status: 200,
          body: {
            ...pageOf(r.rows, query.limit, mapPenalText, (row) =>
              encodeCursor({ t: row.draftedAt, id: row.id }),
            ),
            overdueReminders: await overdueState(tx, query.lenderId),
          },
        };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/lender/penal-charge-texts',
      operationId: 'draftLenderPenalChargeText',
      summary:
        'Draft your penal-charge disclosure: the figure, your two attestations, the reason and the sentences',
      description:
        "Needs reminder.policy.manage of that lender and a second factor. Everything here is the lender's statement and is stored as sent: a flat amount in paise or a percentage in basis points of the overdue amount (exactly one, matching the kind: charge_invalid), the attestations that the charge is separate from interest and not compounded (both must be true: attestation_missing), the reason and the sentence in English and optionally Hindi (plain service text: wording_invalid). Udofin never computes, suggests, translates or fills in any part of it. A DIFFERENT person must approve it; until one is approved, overdue reminders are not sent.",
      tags: ['Reminders (lender)'],
      auth: 'staff',
      idempotent: true,
      idempotencyTenant: ({ body }) => (body as { lenderId: string }).lenderId,
      body: LrPenalTextDraftInput,
      responses: { 201: LrPenalText },
      errors: [400, 401, 403, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, body }) => {
        const r = await tx.query<{ r: string }>(
          'select servicing.draft_penal_charge_text($1::uuid, $2, $3::bigint, $4::int, $5::boolean, $6::boolean, $7, $8, $9) as r',
          [
            body.lenderId,
            body.chargeKind,
            body.flatAmountMinor ?? null,
            body.percentBps ?? null,
            body.separateFromInterest,
            body.notCompounded,
            body.reason,
            body.sentenceEn,
            body.sentenceHi ?? null,
          ],
        );
        const row = await loadOne<PenalTextRow>(
          tx,
          'servicing.penal_charge_texts',
          't',
          PENAL_COLUMNS,
          first(r.rows),
        );
        return { status: 201, body: mapPenalText(row) };
      },
    }),
    artefactAction({
      slug: 'penal-charge-texts',
      noun: 'penal-charge text',
      action: 'approve',
      fn: 'servicing.approve_penal_charge_text',
      operationId: 'approveLenderPenalChargeText',
      permission: 'reminder.template.approve',
    }),
    artefactAction({
      slug: 'penal-charge-texts',
      noun: 'penal-charge text',
      action: 'retire',
      fn: 'servicing.retire_penal_charge_text',
      operationId: 'retireLenderPenalChargeText',
      permission: 'reminder.policy.manage',
    }),

    // ---- communication holds --------------------------------------------------------------------------------------
    userRoute({
      method: 'get',
      path: '/v1/lender/communication-holds',
      operationId: 'listLenderCommunicationHolds',
      summary: 'Pauses on reminders for your loans, newest first',
      description:
        'Needs loan.read of that lender. While a hold is active no reminder is sent for the loan; a hold never blocks the borrower from paying. The notes are your own words.',
      tags: ['Reminders (lender)'],
      auth: 'staff',
      query: LrHoldListQuery,
      responses: { 200: LrHoldPage },
      errors: [400, 401, 403, 422],
      rateLimit: READ_LIMIT,
      handler: async ({ tx, query }) => {
        await requireReader(tx, READ_LOANS, query.lenderId);
        const w = new Where();
        if (query.lenderId) w.add((p) => `h.lender_org_id = ${p}::uuid`, query.lenderId);
        if (query.loanAccountId)
          w.add((p) => `h.loan_account_id = ${p}::uuid`, query.loanAccountId);
        if (query.status === 'active') w.raw('h.released_at is null');
        if (query.status === 'released') w.raw('h.released_at is not null');
        olderThan(w, query.cursor, 'h.placed_at', 'h.id');
        const limit = w.placeholder(query.limit + 1);
        const r = await tx.query<HoldRow>(
          `select ${HOLD_COLUMNS} from servicing.communication_holds h where ${w.sql}
            order by h.placed_at desc, h.id desc limit ${limit}::int`,
          w.values,
        );
        return {
          status: 200,
          body: pageOf(r.rows, query.limit, mapHold, (row) =>
            encodeCursor({ t: row.placedAt, id: row.id }),
          ),
        };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/lender/loans/:id/communication-hold',
      operationId: 'placeLenderCommunicationHold',
      summary: 'Pause reminders for one loan',
      description:
        'Needs reminder.policy.manage of the lender that owns the loan and a second factor. The reason is one of complaint, hardship, dispute, lender_instruction, borrower_request or legal; the optional note is 10 to 200 characters (longer or shorter is validation_failed, 422) and is checked as plain service text (hold_invalid, 422). The messages still planned for the loan are suppressed (hold); the borrower can still pay. One active hold per loan (hold_active, 409). `lenderId` is optional: the loan decides the lender, and when it is sent it must be that lender (otherwise 404). A loan of another lender, an unknown loan and a loan the caller has no permission over all answer 404.',
      tags: ['Reminders (lender)'],
      auth: 'staff',
      idempotent: true,
      idempotencyTenant: ({ body }) => (body as { lenderId?: string }).lenderId ?? null,
      params: Id,
      body: LrHoldPlaceInput,
      responses: { 201: LrHoldPlaced },
      errors: [400, 401, 403, 404, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params, body }) => {
        if (body.lenderId) {
          const owned = await tx.query(
            'select 1 from servicing.loan_accounts la where la.id = $1::uuid and la.lender_org_id = $2::uuid',
            [params.id, body.lenderId],
          );
          if (owned.rows.length === 0) throw notFound();
        }
        const r = await tx.query<{ r: string }>(
          'select servicing.place_communication_hold($1::uuid, $2, $3) as r',
          [params.id, body.reason, body.note ?? null],
        );
        return {
          status: 201,
          body: { id: first(r.rows), loanAccountId: params.id, reason: body.reason, active: true },
        };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/lender/communication-holds/:id/release',
      operationId: 'releaseLenderCommunicationHold',
      summary: 'Release a hold',
      description:
        'Needs reminder.policy.manage of the lender and a second factor. Messages suppressed during the hold stay suppressed; new ones are planned from the next planner run. Send {} when there is no note; a note is 10 to 200 characters. A hold already released answers already_released (409); a hold of another lender or an unknown id answers 404.',
      tags: ['Reminders (lender)'],
      auth: 'staff',
      idempotent: true,
      params: Id,
      body: LrHoldReleaseInput,
      responses: { 200: LrHoldReleased },
      errors: [400, 401, 403, 404, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params, body }) => {
        await tx.query('select servicing.release_communication_hold($1::uuid, $2) as r', [
          params.id,
          body.note ?? null,
        ]);
        return { status: 200, body: { id: params.id, active: false } };
      },
    }),

    // ---- reminders and their attempt log --------------------------------------------------------------------------
    userRoute({
      method: 'get',
      path: '/v1/lender/reminders',
      operationId: 'listLenderReminders',
      summary: 'Planned, sent and suppressed reminders for your loans, newest scheduled first',
      description:
        "Needs loan.read of that lender. Each row is one message for one installment, offset and channel: when it was due to go, where it stands and, when suppressed, why (a closed list). The rendered wording is not stored where a lender can read it (the borrower's app rebuilds it from the frozen references), so it is not returned; the frozen references, the language used and the amount you reported are. sms rows exist only as suppressed placeholders (sms_not_configured): no SMS provider exists. No borrower is named; the loan account is the link.",
      tags: ['Reminders (lender)'],
      auth: 'staff',
      query: LrReminderListQuery,
      responses: { 200: LrReminderPage },
      errors: [400, 401, 403, 422],
      rateLimit: READ_LIMIT,
      handler: async ({ tx, query }) => {
        await requireReader(tx, READ_LOANS, query.lenderId);
        const w = new Where();
        if (query.lenderId) w.add((p) => `r.lender_org_id = ${p}::uuid`, query.lenderId);
        if (query.loanAccountId)
          w.add((p) => `r.loan_account_id = ${p}::uuid`, query.loanAccountId);
        if (query.status) w.add((p) => `r.status = ${p}`, query.status);
        if (query.suppressReason) w.add((p) => `r.suppress_reason = ${p}`, query.suppressReason);
        if (query.kind) w.add((p) => `r.kind = ${p}`, query.kind);
        if (query.channel) w.add((p) => `r.channel = ${p}`, query.channel);
        if (query.from) w.add((p) => `r.scheduled_for >= ${p}::timestamptz`, query.from);
        if (query.to) w.add((p) => `r.scheduled_for < ${p}::timestamptz`, query.to);
        olderThan(w, query.cursor, 'r.scheduled_for', 'r.id');
        const limit = w.placeholder(query.limit + 1);
        const r = await tx.query<ReminderRow>(
          `select ${REMINDER_COLUMNS} from servicing.reminders r where ${w.sql}
            order by r.scheduled_for desc, r.id desc limit ${limit}::int`,
          w.values,
        );
        return {
          status: 200,
          body: pageOf(r.rows, query.limit, mapReminder, (row) =>
            encodeCursor({ t: row.scheduledFor, id: row.id }),
          ),
        };
      },
    }),
    userRoute({
      method: 'get',
      path: '/v1/lender/reminders/summary',
      operationId: 'getLenderReminderSummary',
      summary:
        'How many reminders of your lender are in each status, suppression reason and channel',
      description:
        'Needs loan.read of that lender. Counts only: no borrower, loan or message is named. Messages scheduled at or after `since` are counted (the database default, the last 30 days, applies when it is omitted).',
      tags: ['Reminders (lender)'],
      auth: 'staff',
      query: LrReminderSummaryQuery,
      responses: { 200: LrReminderSummary },
      errors: [400, 401, 403, 422],
      rateLimit: READ_LIMIT,
      handler: async ({ tx, query }) => {
        await requireReader(tx, READ_LOANS, query.lenderId);
        const select = `select status as "status", suppress_reason as "suppressReason", channel as "channel", n::text as "count"`;
        const r = query.since
          ? await tx.query<{
              status: string;
              suppressReason: string | null;
              channel: string;
              count: string;
            }>(`${select} from servicing.reminder_summary($1::uuid, $2::timestamptz)`, [
              query.lenderId,
              query.since,
            ])
          : await tx.query<{
              status: string;
              suppressReason: string | null;
              channel: string;
              count: string;
            }>(`${select} from servicing.reminder_summary($1::uuid)`, [query.lenderId]);
        return {
          status: 200,
          body: {
            lenderId: query.lenderId,
            since: query.since ?? null,
            items: r.rows.map((x) => ({
              status: x.status,
              suppressReason: x.suppressReason,
              channel: x.channel,
              count: count(x.count),
            })),
          },
        };
      },
    }),
    userRoute({
      method: 'get',
      path: '/v1/lender/reminders/:id/deliveries',
      operationId: 'listLenderReminderDeliveries',
      summary: 'The attempt log of one reminder, oldest first',
      description:
        'Needs loan.read of the lender; a reminder of another lender or an unknown id answers 404. `accepted` means the channel took the message, not that it was delivered; `delivered` appears only from a delivery report. An sms attempt can only be not_configured. The hashes identify the wording that was sent and the penal-charge sentence it carried; the wording itself is not stored here.',
      tags: ['Reminders (lender)'],
      auth: 'staff',
      params: Id,
      responses: { 200: LrDeliveryLog },
      errors: [400, 401, 403, 404],
      rateLimit: READ_LIMIT,
      handler: async ({ tx, params }) => {
        await requireReader(tx, READ_LOANS, undefined);
        const reminder = await tx.query(
          'select 1 from servicing.reminders r where r.id = $1::uuid',
          [params.id],
        );
        if (reminder.rows.length === 0) throw notFound();
        const r = await tx.query<DeliveryRow>(
          `select ${DELIVERY_COLUMNS} from servicing.reminder_deliveries d where d.reminder_id = $1::uuid
            order by d.occurred_at, d.id limit 100`,
          [params.id],
        );
        return { status: 200, body: { reminderId: params.id, items: r.rows.map(mapDelivery) } };
      },
    }),
  ];
}
