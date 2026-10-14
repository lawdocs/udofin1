import {
  ApplicationDetail,
  GROUP_BY,
  LoanAccountDetail,
  PanelViewInput,
  PanelViewList,
  PaymentDetail,
  TRANSACTION_COLUMNS,
  TRANSACTION_KINDS,
  TransactionCatalogue,
  TransactionDetail,
  TransactionExport,
  TransactionPage,
  TransactionSummary,
  ViewConfig,
  Created,
  Done,
} from '@udofin/contracts';
import { z } from 'zod';
import { ApiError } from '../../http/api-error.js';
import { decodeCursor, encodeCursor } from '../../http/pagination.js';
import { userRoute, type RouteDefinition } from '../../http/routes.js';
import { type UserTx } from '../../db/user-context.js';
import { columns } from '../../db/columns.js';

const MAX_EXPORT_ROWS = 5000;
const WRITE_LIMIT = { max: 40, timeWindow: '1 minute' };
const EXPORT_LIMIT = { max: 6, timeWindow: '1 minute' };
const csvList = <T extends z.ZodType<string, string>>(item: T) =>
  z
    .string()
    .max(400)
    .transform((s) =>
      s
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
    )
    .pipe(z.array(item).max(20));

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const FilterQuery = z.strictObject({
  lenderId: z.uuid().optional(),
  kinds: csvList(z.enum(TRANSACTION_KINDS)).optional(),
  statuses: csvList(z.string().regex(/^[a-z_]{2,40}$/)).optional(),
  productId: z.uuid().optional(),
  from: day.optional(),
  to: day.optional(),
  minAmountMinor: z.coerce.number().int().min(0).max(100_000_000_000_000).optional(),
  maxAmountMinor: z.coerce.number().int().min(0).max(100_000_000_000_000).optional(),
  q: z.string().trim().min(3).max(60).optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
});
type Filters = z.output<typeof FilterQuery>;

interface Row {
  kind: (typeof TRANSACTION_KINDS)[number];
  id: string;
  lenderOrgId: string;
  occurredAt: string;
  status: string;
  amountMinor: string;
  reference: string | null;
  productId: string | null;
  productCode: string | null;
  purpose: string | null;
  applicationId: string | null;
  loanAccountId: string | null;
}
const TX_COLUMNS = columns({
  kind: 'kind',
  id: 'id',
  lenderOrgId: 'lender_org_id',
  occurredAt: 'occurred_at::text',
  status: 'status',
  amountMinor: 'amount_minor::text',
  reference: 'reference',
  productId: 'product_id',
  productCode: 'product_code',
  purpose: 'purpose',
  applicationId: 'application_id',
  loanAccountId: 'loan_account_id',
});

/** Builds a parameterised WHERE clause from validated filters. Values are never interpolated. */
function where(f: Filters, startAt = 1): { sql: string; values: unknown[] } {
  const parts: string[] = [];
  const values: unknown[] = [];
  const add = (condition: (p: string) => string, value: unknown) => {
    values.push(value);
    parts.push(condition(`$${String(startAt + values.length - 1)}`));
  };
  if (f.lenderId) add((p) => `lender_org_id = ${p}::uuid`, f.lenderId);
  if (f.kinds?.length) add((p) => `kind = any(${p}::text[])`, f.kinds);
  if (f.statuses?.length) add((p) => `status = any(${p}::text[])`, f.statuses);
  if (f.productId) add((p) => `product_id = ${p}::uuid`, f.productId);
  if (f.from) add((p) => `occurred_at >= ${p}::date`, f.from);
  if (f.to) add((p) => `occurred_at < (${p}::date + 1)`, f.to);
  if (f.minAmountMinor !== undefined) add((p) => `amount_minor >= ${p}::bigint`, f.minAmountMinor);
  if (f.maxAmountMinor !== undefined) add((p) => `amount_minor <= ${p}::bigint`, f.maxAmountMinor);
  if (f.q)
    add((p) => `reference ilike ${p} escape '\\'`, `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  return { sql: parts.length ? parts.join(' and ') : 'true', values };
}

const COLUMN_LABELS: Record<(typeof TRANSACTION_COLUMNS)[number], string> = {
  kind: 'Type',
  occurredAt: 'Date',
  status: 'Status',
  amountMinor: 'Amount (paise)',
  reference: 'Reference',
  productCode: 'Product',
  purpose: 'Purpose',
  lenderOrgId: 'Lender',
  id: 'Record id',
  applicationId: 'Application id',
  loanAccountId: 'Loan account id',
};

const STATUSES_BY_KIND = {
  application: [
    'draft',
    'submitted',
    'under_review',
    'info_requested',
    'approved',
    'rejected',
    'offer_accepted',
    'agreement_pending',
    'agreement_executed',
    'disbursement_pending',
    'disbursed',
    'withdrawn',
    'expired',
    'cancelled',
  ],
  loan_account: ['active', 'closed', 'foreclosed', 'written_off', 'cancelled'],
  payment: ['created', 'pending', 'succeeded', 'failed', 'expired', 'cancelled'],
};

/** Spreadsheet programs run cells that start with these characters as formulas; neutralise them. */
function csvCell(value: string | number | boolean | null | undefined): string {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function assertReader(tx: UserTx, lenderId: string | undefined): Promise<void> {
  const r = await tx.query<{ ok: boolean }>(
    `select exists (
       select 1 from private.orgs_with_permission('application.read') o where $1::uuid is null or o = $1::uuid
       union all select 1 from private.orgs_with_permission('loan.read') o where $1::uuid is null or o = $1::uuid
       union all select 1 from private.orgs_with_permission('payment.read') o where $1::uuid is null or o = $1::uuid) as ok`,
    [lenderId ?? null],
  );
  if (!r.rows[0]?.ok) throw new ApiError(403, 'forbidden', 'Forbidden');
}

/**
 * The lender transactions panel. Reads go through the SECURITY INVOKER view lending.lender_transactions,
 * so row-level security of each source table decides what is visible; the API additionally refuses
 * callers who hold none of the read permissions for the requested lender.
 */
export const panelRoutes: RouteDefinition[] = [
  userRoute({
    method: 'get',
    path: '/v1/lender/transactions/catalogue',
    operationId: 'getTransactionCatalogue',
    summary: 'Filters, columns and groupings the panel supports (for building the screen)',
    tags: ['Lender panel'],
    auth: 'staff',
    responses: { 200: TransactionCatalogue },
    errors: [401, 403],
    handler: async ({ tx }) => {
      await assertReader(tx, undefined);
      return {
        status: 200,
        body: {
          kinds: [...TRANSACTION_KINDS],
          statusesByKind: STATUSES_BY_KIND,
          columns: TRANSACTION_COLUMNS.map((key) => ({
            key,
            label: COLUMN_LABELS[key],
            exportable: true,
          })),
          groupBy: [...GROUP_BY],
          maxExportRows: MAX_EXPORT_ROWS,
        },
      };
    },
  }),

  userRoute({
    method: 'get',
    path: '/v1/lender/transactions',
    operationId: 'listLenderTransactions',
    summary: 'Applications, loan accounts and payments, newest first, with filters',
    description:
      'Rows come only from lenders the caller may read; payment rows need payment.read, loan accounts loan.read, applications application.read. Cursor pagination over time; amounts are integer paise as strings. No borrower identity is returned.',
    tags: ['Lender panel'],
    auth: 'staff',
    query: FilterQuery.extend({
      limit: z.coerce.number().int().min(1).max(100).default(25),
      cursor: z.string().max(300).optional(),
    }),
    responses: { 200: TransactionPage },
    errors: [400, 401, 403, 422],
    handler: async ({ tx, query }) => {
      await assertReader(tx, query.lenderId);
      const { limit, cursor, ...filters } = query;
      const c = decodeCursor(cursor);
      const w = where(filters);
      const values = [...w.values];
      let cursorSql = '';
      if (c) {
        values.push(c.t, c.id);
        const cmp = filters.order === 'asc' ? '>' : '<';
        cursorSql = ` and (occurred_at, id) ${cmp} ($${String(values.length - 1)}::timestamptz, $${String(values.length)}::uuid)`;
      }
      values.push(limit + 1);
      const dir = filters.order === 'asc' ? 'asc' : 'desc';
      const r = await tx.query<Row>(
        `select ${TX_COLUMNS} from lending.lender_transactions where ${w.sql}${cursorSql}
          order by occurred_at ${dir}, id ${dir} limit $${String(values.length)}`,
        values,
      );
      const rows = r.rows.slice(0, limit);
      const last = rows.at(-1);
      return {
        status: 200,
        body: {
          items: rows,
          nextCursor:
            r.rows.length > limit && last
              ? encodeCursor({ t: last.occurredAt, id: last.id })
              : null,
        },
      };
    },
  }),

  userRoute({
    method: 'get',
    path: '/v1/lender/transactions/summary',
    operationId: 'summariseLenderTransactions',
    summary: 'Counts and totals grouped by type, status, product, day or month',
    tags: ['Lender panel'],
    auth: 'staff',
    query: FilterQuery.omit({ order: true }).extend({ groupBy: z.enum(GROUP_BY).default('kind') }),
    responses: { 200: TransactionSummary },
    errors: [400, 401, 403, 422],
    handler: async ({ tx, query }) => {
      await assertReader(tx, query.lenderId);
      const { groupBy, ...filters } = query;
      const w = where({ ...filters, order: 'desc' });
      const key = {
        kind: 'kind',
        status: 'status',
        product: `coalesce(product_code, 'unknown')`,
        day: `to_char(occurred_at at time zone 'Asia/Kolkata', 'YYYY-MM-DD')`,
        month: `to_char(occurred_at at time zone 'Asia/Kolkata', 'YYYY-MM')`,
      }[groupBy];
      const r = await tx.query<{ key: string; count: string; total: string }>(
        `select ${key} as key, count(*)::text as count, coalesce(sum(amount_minor), 0)::text as total
           from lending.lender_transactions where ${w.sql} group by 1 order by 1 limit 400`,
        w.values,
      );
      return {
        status: 200,
        body: {
          groupBy,
          items: r.rows.map((x) => ({
            key: x.key,
            count: Number(x.count),
            totalAmountMinor: x.total,
          })),
        },
      };
    },
  }),

  userRoute({
    method: 'get',
    path: '/v1/lender/transactions/export',
    operationId: 'exportLenderTransactions',
    summary: 'Export the filtered rows as CSV (at most 5,000 rows; every export is audited)',
    description:
      'Choose the columns with `columns`. Cells that could run as spreadsheet formulas are neutralised. The export is recorded with its row count and the names (not values) of the filters used.',
    tags: ['Lender panel'],
    auth: 'staff',
    query: FilterQuery.extend({ columns: csvList(z.enum(TRANSACTION_COLUMNS)).optional() }),
    responses: { 200: TransactionExport },
    errors: [400, 401, 403, 422],
    rateLimit: EXPORT_LIMIT,
    handler: async ({ tx, query }) => {
      await assertReader(tx, query.lenderId);
      const { columns: chosen, ...filters } = query;
      const cols = chosen?.length
        ? chosen
        : ['kind', 'occurredAt', 'status', 'amountMinor', 'reference', 'productCode'];
      const w = where(filters);
      const dir = filters.order === 'asc' ? 'asc' : 'desc';
      const r = await tx.query<Row>(
        `select ${TX_COLUMNS} from lending.lender_transactions where ${w.sql} order by occurred_at ${dir}, id ${dir} limit ${String(MAX_EXPORT_ROWS + 1)}`,
        w.values,
      );
      const truncated = r.rows.length > MAX_EXPORT_ROWS;
      const rows = r.rows.slice(0, MAX_EXPORT_ROWS);
      const header = cols
        .map((c) => csvCell(COLUMN_LABELS[c as (typeof TRANSACTION_COLUMNS)[number]]))
        .join(',');
      const lines = rows.map((row) => cols.map((c) => csvCell(row[c as keyof Row])).join(','));
      const lenders = filters.lenderId ?? rows[0]?.lenderOrgId;
      if (lenders) {
        await tx.query('select lending.record_panel_export($1::uuid, $2, $3, $4::text[])', [
          lenders,
          'transactions',
          rows.length,
          Object.keys(filters).filter(
            (k) => (filters as Record<string, unknown>)[k] !== undefined && k !== 'order',
          ),
        ]);
      }
      return {
        status: 200,
        body: {
          filename: `transactions-${new Date().toISOString().slice(0, 10)}.csv`,
          rows: rows.length,
          truncated,
          csv: [header, ...lines].join('\r\n') + '\r\n',
        },
      };
    },
  }),

  userRoute({
    method: 'get',
    path: '/v1/lender/transactions/:kind/:id',
    operationId: 'getLenderTransaction',
    summary:
      'One application, loan account (with its latest schedule) or payment (with provider events)',
    tags: ['Lender panel'],
    auth: 'staff',
    params: z.strictObject({ kind: z.enum(TRANSACTION_KINDS), id: z.uuid() }),
    responses: { 200: TransactionDetail },
    errors: [401, 403, 404],
    handler: async ({ tx, params }) => {
      const base = await tx.query<Row>(
        `select ${TX_COLUMNS} from lending.lender_transactions where kind = $1 and id = $2::uuid`,
        [params.kind, params.id],
      );
      const t = base.rows[0];
      if (!t) throw new ApiError(404, 'not_found', 'Not Found');
      if (params.kind === 'application') {
        const e = await tx.query(
          `select from_status::text as "fromStatus", to_status::text as "toStatus", actor, occurred_at::text as "occurredAt"
             from lending.application_events where application_id = $1::uuid order by occurred_at, id`,
          [params.id],
        );
        return { status: 200, body: ApplicationDetail.parse({ transaction: t, events: e.rows }) };
      }
      if (params.kind === 'loan_account') {
        const a = await tx.query(
          `select source_system::text as "sourceSystem", sanctioned_amount_minor::text as "sanctionedAmountMinor",
                  disbursed_amount_minor::text as "disbursedAmountMinor", disbursed_at::text as "disbursedAt", last_synced_at::text as "lastSyncedAt"
             from servicing.loan_accounts where id = $1::uuid`,
          [params.id],
        );
        const s = await tx.query(
          `select i.seq, i.due_date::text as "dueDate", i.principal_minor::text as "principalMinor", i.interest_minor::text as "interestMinor",
                  i.fees_minor::text as "feesMinor", i.total_minor::text as "totalMinor"
             from servicing.schedule_installments i
            where i.snapshot_id = (select id from servicing.schedule_snapshots where loan_account_id = $1::uuid order by version desc limit 1)
            order by i.seq`,
          [params.id],
        );
        return {
          status: 200,
          body: LoanAccountDetail.parse({ transaction: t, ...a.rows[0], schedule: s.rows }),
        };
      }
      const p = await tx.query<{ provider: string }>(
        `select provider from payments.payment_intents where id = $1::uuid`,
        [params.id],
      );
      const ev = await tx.query(
        `select event_type as "eventType", provider_status as "providerStatus", signature_verified as "signatureVerified", received_at::text as "receivedAt"
           from payments.provider_events where payment_intent_id = $1::uuid order by received_at, id`,
        [params.id],
      );
      return {
        status: 200,
        body: PaymentDetail.parse({
          transaction: t,
          provider: p.rows[0]?.provider ?? 'unknown',
          events: ev.rows,
        }),
      };
    },
  }),

  userRoute({
    method: 'get',
    path: '/v1/lender/panel-views',
    operationId: 'listPanelViews',
    summary: 'Your saved views and the views colleagues shared',
    tags: ['Lender panel'],
    auth: 'staff',
    query: z.strictObject({ lenderId: z.uuid().optional() }),
    responses: { 200: PanelViewList },
    errors: [401, 403],
    handler: async ({ tx, query }) => {
      const r = await tx.query<{
        id: string;
        lenderOrgId: string;
        name: string;
        shared: boolean;
        mine: boolean;
        config: unknown;
        createdAt: string;
      }>(
        `select id, lender_org_id as "lenderOrgId", name, shared, owner_user_id = (select auth.uid()) as mine, config, created_at::text as "createdAt"
           from lending.panel_views where kind = 'transactions' and archived_at is null and ($1::uuid is null or lender_org_id = $1::uuid)
          order by mine desc, name limit 100`,
        [query.lenderId ?? null],
      );
      const items = r.rows.flatMap((row) => {
        const config = ViewConfig.safeParse(row.config);
        return config.success ? [{ ...row, config: config.data }] : [];
      });
      return { status: 200, body: { items } };
    },
  }),

  userRoute({
    method: 'post',
    path: '/v1/lender/panel-views',
    operationId: 'createPanelView',
    summary: 'Save a view (filters, columns, ordering, grouping)',
    tags: ['Lender panel'],
    auth: 'staff',
    idempotent: true,
    body: PanelViewInput,
    responses: { 201: Created },
    errors: [400, 401, 403, 409, 422],
    rateLimit: WRITE_LIMIT,
    handler: async ({ tx, body }) => {
      await assertReader(tx, body.lenderId);
      const r = await tx.query<{ id: string }>(
        `insert into lending.panel_views (lender_org_id, owner_user_id, name, config, shared)
         values ($1::uuid, (select auth.uid()), $2, $3::jsonb, $4) returning id`,
        [body.lenderId, body.name, JSON.stringify(body.config), body.shared],
      );
      const id = r.rows[0]?.id;
      if (!id) throw new Error('insert returned nothing');
      return { status: 201, body: { id } };
    },
  }),

  userRoute({
    method: 'post',
    path: '/v1/lender/panel-views/:id',
    operationId: 'updatePanelView',
    summary: 'Change or archive one of your views',
    tags: ['Lender panel'],
    auth: 'staff',
    idempotent: true,
    params: z.strictObject({ id: z.uuid() }),
    body: z.strictObject({
      name: z.string().trim().min(1).max(80).optional(),
      shared: z.boolean().optional(),
      config: ViewConfig.optional(),
      archive: z.boolean().optional(),
    }),
    responses: { 200: Done },
    errors: [400, 401, 403, 404, 409, 422],
    rateLimit: WRITE_LIMIT,
    handler: async ({ tx, params, body }) => {
      const r = await tx.query(
        `update lending.panel_views set name = coalesce($2, name), shared = coalesce($3, shared), config = coalesce($4::jsonb, config),
            archived_at = case when $5::boolean then now() else archived_at end
          where id = $1::uuid and owner_user_id = (select auth.uid()) and archived_at is null`,
        [
          params.id,
          body.name ?? null,
          body.shared ?? null,
          body.config ? JSON.stringify(body.config) : null,
          body.archive ?? false,
        ],
      );
      if (r.rowCount === 0) throw new ApiError(404, 'not_found', 'Not Found');
      return { status: 200, body: { ok: true as const } };
    },
  }),
];
