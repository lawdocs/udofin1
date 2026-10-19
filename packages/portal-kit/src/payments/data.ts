import {
  LpExceptionDetail,
  LpExceptionListQuery,
  LpExceptionPage,
  LpMandateDebitListQuery,
  LpMandateDebitPage,
  LpMandateDetail,
  LpMandateListQuery,
  LpMandatePage,
  LpMandatePolicyList,
  LpPaymentDetail,
  LpPaymentListQuery,
  LpPaymentPage,
  LpPaymentPolicyList,
  LpProviderEventListQuery,
  LpProviderEventPage,
  LpReconciliationSettingsList,
  LpReconciliationSummary,
  LpRunListQuery,
  LpRunPage,
  LpSettlementBatch,
  LpSettlementBatchListQuery,
  LpSettlementBatchPage,
  LpSettlementItemListQuery,
  LpSettlementItemPage,
  LpWebhookSummary,
  SettlementAccountRegistryStatusList,
} from '@udofin/contracts';
import { type ZodType } from 'zod';
import { type OnboardingApi } from '../onboarding/api.js';
import { type SettlementAccounts } from './types.js';

/** What a load returned: the data, or a stable code. Never raw server text. */
export type LpResult<T> = { ok: true; data: T } | { ok: false; status: number; code: string };

/** What the signed-in person may do, from the permissions the API reported. Hiding a form is a convenience; the API decides. */
export interface LpCapabilities {
  read: boolean;
  configure: boolean;
  reconcile: boolean;
}

export function lpCapabilitiesFrom(permissions: readonly string[]): LpCapabilities {
  const has = (permission: string) => permissions.includes(permission);
  return {
    read: has('payment.read') || has('payment.reconcile'),
    configure: has('payment.configure'),
    reconcile: has('payment.reconcile'),
  };
}

interface MembershipLike {
  organizationId: string;
  organizationKind: string;
  organizationName?: string;
  permissions: readonly string[];
}

const holdsPaymentRight = (m: MembershipLike) =>
  m.permissions.some((p) => p.startsWith('payment.'));

/**
 * The lender organisation the payment screens act for. A person may belong to several lenders: the one asked for in the page
 * address is used when the person holds a payment permission in it, otherwise the first lender that holds one (else the first
 * lender). An asked-for lender the person does not belong to is ignored, never used. The API checks the permission for the
 * lender again on every call.
 */
export function lpLenderFrom(
  memberships: readonly MembershipLike[],
  asked?: string,
): string | undefined {
  const lenders = memberships.filter((m) => m.organizationKind === 'lender');
  const paying = lenders.filter(holdsPaymentRight);
  return (
    paying.find((m) => m.organizationId === asked)?.organizationId ??
    paying[0]?.organizationId ??
    lenders[0]?.organizationId
  );
}

/** The lenders a person can choose between on the payment screens: those in which they hold a payment permission, once each. */
export function lpLendersOf(
  memberships: readonly MembershipLike[],
): { lenderId: string; name: string }[] {
  const seen = new Set<string>();
  const lenders: { lenderId: string; name: string }[] = [];
  for (const m of memberships) {
    if (m.organizationKind !== 'lender' || !holdsPaymentRight(m) || seen.has(m.organizationId))
      continue;
    seen.add(m.organizationId);
    lenders.push({ lenderId: m.organizationId, name: m.organizationName ?? 'Lender' });
  }
  return lenders;
}

/**
 * The permissions the person holds in the one lender the screens act for. A right in another organisation does not draw a
 * form for this one (the API would refuse it). Nobody, or no lender, means no permission.
 */
export function lpPermissionsIn(
  memberships: readonly MembershipLike[],
  lenderId: string | undefined,
): string[] {
  if (lenderId === undefined) return [];
  return memberships
    .filter((m) => m.organizationId === lenderId)
    .flatMap((m) => [...m.permissions]);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const lpIsUuid = (value: unknown): value is string =>
  typeof value === 'string' && UUID.test(value);
export const lpIsDate = (value: unknown): value is string =>
  typeof value === 'string' && DATE.test(value);

const notFound = { ok: false as const, status: 404, code: 'not_found' };

/** The page parameters as Next.js hands them to a server component. */
export type LpParams = Readonly<Record<string, string | string[] | undefined>>;

const first = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

/** The lender a person chose on a page (the `lenderId` of the address), only when it is an identifier. */
export const lpAskedLender = (params: LpParams): string | undefined => {
  const value = first(params.lenderId);
  return lpIsUuid(value) ? value : undefined;
};

/**
 * The filters a list page accepts, checked against the same contract the API uses. A value that does not pass is dropped, so a
 * hand-edited address can never send anything the API does not define. Returns the query string (with the leading "?") or "".
 */
export function lpQueryString(
  schema: ZodType,
  params: LpParams,
  keys: readonly string[],
  extra: Readonly<Record<string, string>> = {},
): string {
  const accepted: Record<string, string> = { ...extra };
  for (const key of keys) {
    const value = first(params[key]);
    if (value === undefined || value === '') continue;
    if (schema.safeParse({ ...accepted, [key]: value }).success) accepted[key] = value;
  }
  const search = new URLSearchParams(accepted).toString();
  return search ? `?${search}` : '';
}

/** The filters worth keeping when a page links to the next page of the same list. */
export function lpKeepParams(params: LpParams, keys: readonly string[]): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const key of keys) {
    const value = first(params[key]);
    if (value !== undefined && value !== '') kept[key] = value;
  }
  return kept;
}

const LIST_KEYS = {
  payments: ['status', 'purpose', 'loanAccountId', 'cursor'],
  events: ['objectKind', 'paymentIntentId', 'cursor'],
  mandates: ['status', 'loanAccountId', 'cursor'],
  debits: ['mandateId', 'status', 'planned', 'loanAccountId', 'cursor'],
  runs: ['cursor'],
  batches: ['from', 'to', 'cursor'],
  items: ['cursor'],
  exceptions: ['status', 'class', 'severity', 'owner', 'cursor'],
} as const;
export const LP_LIST_KEYS = LIST_KEYS;

export const lpLoadPayments = (api: OnboardingApi, params: LpParams) =>
  api.get(
    `/v1/lender/payments${lpQueryString(LpPaymentListQuery, params, LIST_KEYS.payments)}`,
    LpPaymentPage,
  );

export const lpLoadPaymentDetail = (api: OnboardingApi, id: string) =>
  lpIsUuid(id) ? api.get(`/v1/lender/payments/${id}`, LpPaymentDetail) : Promise.resolve(notFound);

export const lpLoadProviderEvents = (
  api: OnboardingApi,
  params: LpParams,
  fixed: Readonly<Record<string, string>> = {},
) =>
  api.get(
    `/v1/lender/provider-events${lpQueryString(LpProviderEventListQuery, params, LIST_KEYS.events, fixed)}`,
    LpProviderEventPage,
  );

export const lpLoadWebhookSummary = (api: OnboardingApi, lenderId: string) =>
  lpIsUuid(lenderId)
    ? api.get(`/v1/lender/webhook-summary?lenderId=${lenderId}`, LpWebhookSummary)
    : Promise.resolve(notFound);

/**
 * The policy and settings lists are asked for ONE lender (the one the screen acts for). The routes list every set row the
 * person may see when no lender is named, which is how another lender's figures were once shown and pre-filled as this
 * lender's. A lender that is not an identifier gives "not found", never an unfiltered list.
 */
export const lpLoadPaymentPolicy = (api: OnboardingApi, lenderId: string) =>
  lpIsUuid(lenderId)
    ? api.get(`/v1/lender/payment-policy?lenderId=${lenderId}`, LpPaymentPolicyList)
    : Promise.resolve(notFound);

export const lpLoadMandatePolicy = (api: OnboardingApi, lenderId: string) =>
  lpIsUuid(lenderId)
    ? api.get(`/v1/lender/mandate-policy?lenderId=${lenderId}`, LpMandatePolicyList)
    : Promise.resolve(notFound);

export const lpLoadReconSettings = (api: OnboardingApi, lenderId: string) =>
  lpIsUuid(lenderId)
    ? api.get(
        `/v1/lender/reconciliation/settings?lenderId=${lenderId}`,
        LpReconciliationSettingsList,
      )
    : Promise.resolve(notFound);

export const lpLoadMandates = (api: OnboardingApi, params: LpParams) =>
  api.get(
    `/v1/lender/mandates${lpQueryString(LpMandateListQuery, params, LIST_KEYS.mandates)}`,
    LpMandatePage,
  );

export const lpLoadMandateDetail = (api: OnboardingApi, id: string) =>
  lpIsUuid(id) ? api.get(`/v1/lender/mandates/${id}`, LpMandateDetail) : Promise.resolve(notFound);

export const lpLoadMandateDebits = (api: OnboardingApi, params: LpParams) =>
  api.get(
    `/v1/lender/mandate-debits${lpQueryString(LpMandateDebitListQuery, params, LIST_KEYS.debits)}`,
    LpMandateDebitPage,
  );

/** The runs of the lender the screen acts for: the report of a run opens for that lender only, so the list is that lender's too. */
export const lpLoadReconRuns = (api: OnboardingApi, params: LpParams, lenderId: string) =>
  lpIsUuid(lenderId)
    ? api.get(
        `/v1/lender/reconciliation/runs${lpQueryString(LpRunListQuery, params, LIST_KEYS.runs, { lenderId })}`,
        LpRunPage,
      )
    : Promise.resolve(notFound);

export const lpLoadReconSummary = (api: OnboardingApi, lenderId: string, date: string) =>
  lpIsUuid(lenderId) && lpIsDate(date)
    ? api.get(
        `/v1/lender/reconciliation/summary?lenderId=${lenderId}&date=${date}`,
        LpReconciliationSummary,
      )
    : Promise.resolve(notFound);

export const lpLoadSettlementBatches = (api: OnboardingApi, params: LpParams) =>
  api.get(
    `/v1/lender/reconciliation/settlement-batches${lpQueryString(LpSettlementBatchListQuery, params, LIST_KEYS.batches)}`,
    LpSettlementBatchPage,
  );

export const lpLoadSettlementBatch = (api: OnboardingApi, id: string) =>
  lpIsUuid(id)
    ? api.get(`/v1/lender/reconciliation/settlement-batches/${id}`, LpSettlementBatch)
    : Promise.resolve(notFound);

export const lpLoadSettlementItems = (api: OnboardingApi, id: string, params: LpParams) =>
  lpIsUuid(id)
    ? api.get(
        `/v1/lender/reconciliation/settlement-batches/${id}/items${lpQueryString(LpSettlementItemListQuery, params, LIST_KEYS.items)}`,
        LpSettlementItemPage,
      )
    : Promise.resolve(notFound);

export const lpLoadExceptions = (api: OnboardingApi, params: LpParams) =>
  api.get(
    `/v1/lender/reconciliation/exceptions${lpQueryString(LpExceptionListQuery, params, LIST_KEYS.exceptions)}`,
    LpExceptionPage,
  );

export const lpLoadExceptionDetail = (api: OnboardingApi, id: string) =>
  lpIsUuid(id)
    ? api.get(`/v1/lender/reconciliation/exceptions/${id}`, LpExceptionDetail)
    : Promise.resolve(notFound);

/**
 * The settlement accounts of the lender the screen acts for, as the registry reports them (masked reference and status only),
 * for the bank-credit upload. The route lists the accounts of every lender the person belongs to and takes no lender filter, so
 * the rows of any other lender are dropped here: an upload names one lender and must offer that lender's accounts only.
 */
export const lpLoadSettlementAccounts = async (
  api: OnboardingApi,
  lenderId: string,
): Promise<LpResult<SettlementAccounts>> => {
  if (!lpIsUuid(lenderId)) return notFound;
  const result = await api.get(
    '/v1/lender/settlement-accounts/registry-status',
    SettlementAccountRegistryStatusList,
  );
  return result.ok
    ? {
        ok: true,
        data: { items: result.data.items.filter((account) => account.lenderId === lenderId) },
      }
    : { ok: false, status: result.status, code: result.code };
};
