import { z } from 'zod';

/**
 * Lender transactions panel (Phase 04): a read-only feed of applications, loan accounts and
 * payments for one or more lenders the caller may see, with customisable filters, columns,
 * grouping, saved views and CSV export. No borrower identity is exposed.
 */
export const TRANSACTION_KINDS = ['application', 'loan_account', 'payment'] as const;
export const TRANSACTION_COLUMNS = [
  'kind',
  'occurredAt',
  'status',
  'amountMinor',
  'reference',
  'productCode',
  'purpose',
  'lenderOrgId',
  'id',
  'applicationId',
  'loanAccountId',
] as const;
export const GROUP_BY = ['kind', 'status', 'product', 'day', 'month'] as const;

export const Transaction = z.object({
  kind: z.enum(TRANSACTION_KINDS),
  id: z.uuid(),
  lenderOrgId: z.uuid(),
  occurredAt: z.string(),
  status: z.string(),
  /** Integer paise as a decimal string. */
  amountMinor: z.string(),
  reference: z.string().nullable(),
  productId: z.uuid().nullable(),
  productCode: z.string().nullable(),
  purpose: z.string().nullable(),
  applicationId: z.uuid().nullable(),
  loanAccountId: z.uuid().nullable(),
});
export type Transaction = z.infer<typeof Transaction>;
export const TransactionPage = z.object({
  items: z.array(Transaction),
  nextCursor: z.string().nullable(),
});

export const SummaryRow = z.object({
  key: z.string(),
  count: z.number().int(),
  totalAmountMinor: z.string(),
});
export const TransactionSummary = z.object({
  groupBy: z.enum(GROUP_BY),
  items: z.array(SummaryRow),
});

export const TransactionColumn = z.object({
  key: z.string(),
  label: z.string(),
  exportable: z.boolean(),
});
export const TransactionCatalogue = z.object({
  kinds: z.array(z.string()),
  statusesByKind: z.record(z.string(), z.array(z.string())),
  columns: z.array(TransactionColumn),
  groupBy: z.array(z.string()),
  maxExportRows: z.number().int(),
});

export const TransactionExport = z.object({
  filename: z.string(),
  rows: z.number().int(),
  truncated: z.boolean(),
  csv: z.string(),
});

export const ViewConfig = z.strictObject({
  kinds: z.array(z.enum(TRANSACTION_KINDS)).max(3).optional(),
  statuses: z
    .array(z.string().regex(/^[a-z_]{2,40}$/))
    .max(20)
    .optional(),
  productId: z.uuid().optional(),
  columns: z.array(z.enum(TRANSACTION_COLUMNS)).min(1).max(TRANSACTION_COLUMNS.length).optional(),
  order: z.enum(['asc', 'desc']).optional(),
  range: z.enum(['last_7_days', 'last_30_days', 'last_90_days', 'all']).optional(),
  groupBy: z.enum(GROUP_BY).optional(),
  pageSize: z.number().int().min(10).max(100).optional(),
});
export type ViewConfig = z.infer<typeof ViewConfig>;

export const PanelView = z.object({
  id: z.uuid(),
  lenderOrgId: z.uuid(),
  name: z.string(),
  shared: z.boolean(),
  mine: z.boolean(),
  config: ViewConfig,
  createdAt: z.string(),
});
export type PanelView = z.infer<typeof PanelView>;
export const PanelViewList = z.object({ items: z.array(PanelView) });
export const PanelViewInput = z.strictObject({
  lenderId: z.uuid(),
  name: z.string().trim().min(1).max(80),
  shared: z.boolean().default(false),
  config: ViewConfig,
});

export const ApplicationDetail = z.object({
  transaction: Transaction,
  events: z.array(
    z.object({
      fromStatus: z.string().nullable(),
      toStatus: z.string(),
      actor: z.string(),
      occurredAt: z.string(),
    }),
  ),
});
export const LoanAccountDetail = z.object({
  transaction: Transaction,
  sourceSystem: z.string(),
  sanctionedAmountMinor: z.string(),
  disbursedAmountMinor: z.string().nullable(),
  disbursedAt: z.string().nullable(),
  lastSyncedAt: z.string(),
  schedule: z.array(
    z.object({
      seq: z.number().int(),
      dueDate: z.string(),
      principalMinor: z.string(),
      interestMinor: z.string(),
      feesMinor: z.string(),
      totalMinor: z.string(),
    }),
  ),
});
export const PaymentDetail = z.object({
  transaction: Transaction,
  provider: z.string(),
  events: z.array(
    z.object({
      eventType: z.string(),
      providerStatus: z.string().nullable(),
      signatureVerified: z.boolean(),
      receivedAt: z.string(),
    }),
  ),
});
export const TransactionDetail = z.union([ApplicationDetail, LoanAccountDetail, PaymentDetail]);
