import {
  PanelViewList,
  TRANSACTION_COLUMNS,
  TRANSACTION_KINDS,
  TransactionCatalogue,
  TransactionExport as TransactionExportSchema,
  TransactionDetail,
  TransactionPage,
  TransactionSummary,
  ProductList,
  type ViewConfig,
} from '@udofin/contracts';
import { type OnboardingApi } from '../onboarding/api.js';

export const DEFAULT_COLUMNS = [
  'kind',
  'occurredAt',
  'status',
  'amountMinor',
  'reference',
  'productCode',
] as const;
type Column = (typeof TRANSACTION_COLUMNS)[number];
type Kind = (typeof TRANSACTION_KINDS)[number];

export interface PanelState {
  lenderId?: string;
  kinds: Kind[];
  statuses: string[];
  productId?: string;
  from?: string;
  to?: string;
  minAmountMinor?: string;
  maxAmountMinor?: string;
  q?: string;
  order: 'asc' | 'desc';
  columns: Column[];
  groupBy?: 'kind' | 'status' | 'product' | 'day' | 'month';
  viewId?: string;
  cursor?: string;
  pageSize: number;
}

type Params = Record<string, string | string[] | undefined>;
const one = (p: Params, k: string): string | undefined => {
  const v = p[k];
  const s = Array.isArray(v) ? v[0] : v;
  return s && s.trim() !== '' ? s.trim() : undefined;
};
const list = (p: Params, k: string): string[] => {
  const v = p[k];
  const raw = Array.isArray(v) ? v : v ? [v] : [];
  return raw
    .flatMap((x) => x.split(','))
    .map((x) => x.trim())
    .filter(Boolean);
};
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f-]{36}$/;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** URL parameters (and an optional saved view) to a validated panel state. Unknown values are dropped. */
export function parsePanelState(p: Params, view?: ViewConfig, now = new Date()): PanelState {
  const kinds = (list(p, 'kinds').length ? list(p, 'kinds') : (view?.kinds ?? [])).filter(
    (k): k is Kind => (TRANSACTION_KINDS as readonly string[]).includes(k),
  );
  const statuses = (
    list(p, 'statuses').length ? list(p, 'statuses') : (view?.statuses ?? [])
  ).filter((s) => /^[a-z_]{2,40}$/.test(s));
  const columns = (
    list(p, 'columns').length ? list(p, 'columns') : (view?.columns ?? [...DEFAULT_COLUMNS])
  ).filter((c): c is Column => (TRANSACTION_COLUMNS as readonly string[]).includes(c));
  const range = view?.range;
  const days =
    range === 'last_7_days' ? 7 : range === 'last_30_days' ? 30 : range === 'last_90_days' ? 90 : 0;
  const from = one(p, 'from');
  const to = one(p, 'to');
  const lenderId = one(p, 'lenderId');
  const productId = one(p, 'productId') ?? view?.productId;
  const group = one(p, 'groupBy') ?? view?.groupBy;
  const money = (k: string) => {
    const v = one(p, k);
    return v && /^\d{1,15}$/.test(v) ? v : undefined;
  };
  const q = one(p, 'q');
  const pageSize = Number(one(p, 'pageSize') ?? view?.pageSize ?? 25);
  return {
    ...(lenderId && UUID.test(lenderId) ? { lenderId } : {}),
    kinds,
    statuses,
    ...(productId && UUID.test(productId) ? { productId } : {}),
    ...(from && DAY.test(from)
      ? { from }
      : days
        ? { from: isoDay(new Date(now.getTime() - days * 86_400_000)) }
        : {}),
    ...(to && DAY.test(to) ? { to } : {}),
    ...(money('minAmountMinor') ? { minAmountMinor: money('minAmountMinor') } : {}),
    ...(money('maxAmountMinor') ? { maxAmountMinor: money('maxAmountMinor') } : {}),
    ...(q && q.length >= 3 && q.length <= 60 ? { q } : {}),
    order: (one(p, 'order') ?? view?.order) === 'asc' ? 'asc' : 'desc',
    columns: columns.length ? columns : [...DEFAULT_COLUMNS],
    ...(group && ['kind', 'status', 'product', 'day', 'month'].includes(group)
      ? { groupBy: group as NonNullable<PanelState['groupBy']> }
      : {}),
    ...(one(p, 'view') && UUID.test(one(p, 'view') ?? '') ? { viewId: one(p, 'view') } : {}),
    ...(one(p, 'cursor') ? { cursor: one(p, 'cursor') } : {}),
    pageSize: Number.isInteger(pageSize) && pageSize >= 10 && pageSize <= 100 ? pageSize : 25,
  };
}

/** The filter part of the state as an API query string (no paging, no columns). */
export function filterQuery(s: PanelState): URLSearchParams {
  const q = new URLSearchParams();
  if (s.lenderId) q.set('lenderId', s.lenderId);
  if (s.kinds.length) q.set('kinds', s.kinds.join(','));
  if (s.statuses.length) q.set('statuses', s.statuses.join(','));
  if (s.productId) q.set('productId', s.productId);
  if (s.from) q.set('from', s.from);
  if (s.to) q.set('to', s.to);
  if (s.minAmountMinor) q.set('minAmountMinor', s.minAmountMinor);
  if (s.maxAmountMinor) q.set('maxAmountMinor', s.maxAmountMinor);
  if (s.q) q.set('q', s.q);
  return q;
}

/** The state as page parameters (for links that keep the user's choices). */
export function stateToParams(
  s: PanelState,
  override: Record<string, string | undefined> = {},
): string {
  const q = filterQuery(s);
  q.set('order', s.order);
  q.set('columns', s.columns.join(','));
  if (s.groupBy) q.set('groupBy', s.groupBy);
  if (s.viewId) q.set('view', s.viewId);
  if (s.pageSize !== 25) q.set('pageSize', String(s.pageSize));
  for (const [k, v] of Object.entries(override)) {
    if (v === undefined) q.delete(k);
    else q.set(k, v);
  }
  return q.toString();
}

export function stateToViewConfig(s: PanelState): ViewConfig {
  return {
    ...(s.kinds.length ? { kinds: s.kinds } : {}),
    ...(s.statuses.length ? { statuses: s.statuses } : {}),
    ...(s.productId ? { productId: s.productId } : {}),
    columns: s.columns,
    order: s.order,
    ...(s.groupBy ? { groupBy: s.groupBy } : {}),
    pageSize: s.pageSize,
  };
}

export async function loadPanel(api: OnboardingApi, s: PanelState) {
  const q = filterQuery(s);
  q.set('order', s.order);
  q.set('limit', String(s.pageSize));
  if (s.cursor) q.set('cursor', s.cursor);
  const sq = filterQuery(s);
  sq.set('groupBy', s.groupBy ?? 'kind');
  const [catalogue, page, summary, views, products] = await Promise.all([
    api.get('/v1/lender/transactions/catalogue', TransactionCatalogue),
    api.get(`/v1/lender/transactions?${q.toString()}`, TransactionPage),
    s.groupBy
      ? api.get(`/v1/lender/transactions/summary?${sq.toString()}`, TransactionSummary)
      : Promise.resolve(undefined),
    api.get(`/v1/lender/panel-views${s.lenderId ? `?lenderId=${s.lenderId}` : ''}`, PanelViewList),
    api.get(`/v1/lender/products${s.lenderId ? `?lenderId=${s.lenderId}` : ''}`, ProductList),
  ]);
  return { catalogue, page, summary, views, products };
}

export const loadExport = (api: OnboardingApi, s: PanelState) => {
  const q = filterQuery(s);
  q.set('order', s.order);
  q.set('columns', s.columns.join(','));
  return api.get(`/v1/lender/transactions/export?${q.toString()}`, TransactionExportSchema);
};

export const loadTransactionDetail = (api: OnboardingApi, kind: string, id: string) =>
  api.get(`/v1/lender/transactions/${kind}/${id}`, TransactionDetail);

export const loadPanelViews = (api: OnboardingApi, lenderId?: string) =>
  api.get(`/v1/lender/panel-views${lenderId ? `?lenderId=${lenderId}` : ''}`, PanelViewList);
