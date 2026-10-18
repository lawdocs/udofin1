import {
  AccountFormatRuleList,
  FeatureCatalogList,
  FeatureChangeRequestPage,
  FeatureSwitchList,
  FingerprintKeyVersionList,
  LenderSummaryList,
  LpExceptionDetail,
  LpExceptionPage,
  MerchantPage,
  PaymentProviderList,
  RegistryAccountEntry,
  RegistryAccountPage,
  ReturnCodeClassList,
  SettlementAccountPage,
} from '@udofin/contracts';
import { type Flash } from '../flash.js';
import { type OnboardingApi } from '../onboarding/api.js';
import { type PlatformApi } from './client.js';
import { type LenderChoice } from './types.js';

// ---------------------------------------------------------------------------------------------------------------
// What the signed-in person may do. Hiding a form is a convenience: the API and the database authorise every call.
// ---------------------------------------------------------------------------------------------------------------
export interface PlatformCaps {
  /** platform.payments.providers.manage: providers, return codes, merchants, platform exceptions. */
  providersManage: boolean;
  /** platform.accounts.registry.manage: register, draft and submit rules, propose keys, link settlement accounts. */
  registryManage: boolean;
  /** platform.accounts.registry.verify: verify an account, approve a rule or a key version. */
  registryVerify: boolean;
  /** platform.features.manage: request, decide, cancel and switch off. */
  featuresManage: boolean;
}

export function platformCaps(permissions: readonly string[]): PlatformCaps {
  const has = (key: string) => permissions.includes(key);
  return {
    providersManage: has('platform.payments.providers.manage'),
    registryManage: has('platform.accounts.registry.manage'),
    registryVerify: has('platform.accounts.registry.verify'),
    featuresManage: has('platform.features.manage'),
  };
}

/** Either registry permission. */
export const mayReadRegistry = (caps: PlatformCaps): boolean =>
  caps.registryManage || caps.registryVerify;

// ---------------------------------------------------------------------------------------------------------------
// Page queries (from the URL). Anything that does not look right is dropped, never passed on.
// ---------------------------------------------------------------------------------------------------------------
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CURSOR = /^[A-Za-z0-9_-]{1,300}$/;
const PROVIDER = /^[a-z][a-z0-9_]{2,49}$/;
const CLASS = /^[a-z][a-z_]{2,60}$/;

export const isId = (value: unknown): value is string =>
  typeof value === 'string' && UUID.test(value);

const one = (value: string | string[] | undefined): string | undefined =>
  typeof value === 'string' ? value : undefined;
const oneOf = (allowed: readonly string[] | undefined, value: string | undefined) =>
  allowed ? allowed.find((candidate) => candidate === value) : undefined;

export interface AccountsQuery {
  cursor?: string;
  lenderId?: string;
  status?: string;
  verification?: string;
  severity?: string;
  provider?: string;
  class?: string;
  view?: string;
  linked?: string;
}

/** Reads the filters a page understands from its URL. `allowed` names the closed values of the closed filters. */
export function parseAccountsQuery(
  raw: Record<string, string | string[] | undefined>,
  allowed: {
    status?: readonly string[];
    verification?: readonly string[];
    severity?: readonly string[];
    view?: readonly string[];
    linked?: readonly string[];
  } = {},
): AccountsQuery {
  const cursor = one(raw.cursor);
  const lenderId = one(raw.lenderId);
  const provider = one(raw.provider);
  const klass = one(raw.class);
  const status = oneOf(allowed.status, one(raw.status));
  const verification = oneOf(allowed.verification, one(raw.verification));
  const severity = oneOf(allowed.severity, one(raw.severity));
  const view = oneOf(allowed.view, one(raw.view));
  const linked = oneOf(allowed.linked, one(raw.linked));
  return {
    ...(cursor && CURSOR.test(cursor) ? { cursor } : {}),
    ...(isId(lenderId) ? { lenderId } : {}),
    ...(provider && PROVIDER.test(provider) ? { provider } : {}),
    ...(klass && CLASS.test(klass) ? { class: klass } : {}),
    ...(status ? { status } : {}),
    ...(verification ? { verification } : {}),
    ...(severity ? { severity } : {}),
    ...(view ? { view } : {}),
    ...(linked ? { linked } : {}),
  };
}

const qs = (params: Record<string, string | number | undefined>): string => {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
  return parts.length > 0 ? `?${parts.join('&')}` : '';
};

/** The query string for a link back to a page with some filters. */
export const accountsHref = (base: string, query: AccountsQuery): string =>
  `${base}${qs({
    status: query.status,
    verification: query.verification,
    severity: query.severity,
    provider: query.provider,
    class: query.class,
    view: query.view,
    linked: query.linked,
    lenderId: query.lenderId,
    cursor: query.cursor,
  })}`;

/** The same filters without the page position (for a link back to the first page). */
export const withoutCursor = (query: AccountsQuery): AccountsQuery => {
  const { cursor: _cursor, ...rest } = query;
  return rest;
};

/**
 * The id of a registry entry that was just registered. It comes from the notice the server action wrote for this page (see
 * flash.ts), never from the address: an address can name any entry and would make the page say it was just registered.
 */
export const registeredIdFrom = (flash: Flash | undefined): string | undefined => flash?.registered;

/**
 * The notice of the last action. Whether it succeeded, and the decision a feature request ended in, come from the notice the
 * server wrote for this page (`flash`), never from the address. An error and the unmet prerequisites are closed codes in the
 * address, shown only as fixed sentences; a forged one can claim a failure, never a success.
 */
export function noticeFrom(
  raw: Record<string, string | string[] | undefined>,
  flash: Flash | undefined,
) {
  return {
    done: flash !== undefined,
    error: one(raw.error),
    result: flash?.result,
    reasons: one(raw.reasons),
  };
}

/** The page address to return to after an action: the same filters, never the result notice. */
export function returnPath(
  base: string,
  raw: Record<string, string | string[] | undefined>,
  keys: readonly string[],
): string {
  const params = new URLSearchParams();
  for (const key of keys) {
    const value = one(raw[key]);
    if (value !== undefined && /^[A-Za-z0-9_.,:-]{1,300}$/.test(value)) params.set(key, value);
  }
  const text = params.toString();
  return text ? `${base}?${text}` : base;
}

// ---------------------------------------------------------------------------------------------------------------
// Loaders. Every response is checked against the contract by the client; a failure is a code, never server text.
// ---------------------------------------------------------------------------------------------------------------
const PAGE = 25;

export const loadProviders = (api: PlatformApi) =>
  api.get('/v1/platform/payment-providers', PaymentProviderList);

export const loadReturnCodes = (api: PlatformApi, provider?: string) =>
  api.get(
    `/v1/platform/return-code-classes${qs({ status: 'active', provider: provider && PROVIDER.test(provider) ? provider : undefined })}`,
    ReturnCodeClassList,
  );

export const loadRules = (api: PlatformApi, status?: string) =>
  api.get(`/v1/platform/account-format-rules${qs({ status })}`, AccountFormatRuleList);

export const loadKeyVersions = (api: PlatformApi) =>
  api.get('/v1/platform/fingerprint-key-versions', FingerprintKeyVersionList);

export const loadAccounts = (api: PlatformApi, query: AccountsQuery) =>
  api.get(
    `/v1/platform/accounts${qs({ limit: PAGE, cursor: query.cursor, status: query.status, ownerOrgId: query.lenderId })}`,
    RegistryAccountPage,
  );

export const loadAccount = (api: PlatformApi, id: string) =>
  api.get(`/v1/platform/accounts/${id}`, RegistryAccountEntry);

/** The verified entries a settlement account may be linked to (the first hundred; the API checks the choice again). */
export const loadVerifiedAccounts = (api: PlatformApi, lenderId?: string) =>
  api.get(
    `/v1/platform/accounts${qs({ limit: 100, status: 'verified', ownerOrgId: lenderId })}`,
    RegistryAccountPage,
  );

export const loadSettlementAccounts = (api: PlatformApi, query: AccountsQuery) =>
  api.get(
    `/v1/platform/settlement-accounts${qs({ limit: PAGE, cursor: query.cursor, lenderId: query.lenderId, linked: query.linked })}`,
    SettlementAccountPage,
  );

export const loadMerchants = (api: PlatformApi, query: AccountsQuery) =>
  api.get(
    `/v1/platform/merchants${qs({ limit: PAGE, cursor: query.cursor, lenderId: query.lenderId, verification: query.verification, status: query.status })}`,
    MerchantPage,
  );

export const loadFeatureCatalogue = (api: PlatformApi) =>
  api.get('/v1/platform/features', FeatureCatalogList);

export const loadLenderSwitches = (api: PlatformApi, lenderId: string) =>
  api.get(`/v1/platform/lenders/${lenderId}/features`, FeatureSwitchList);

export const loadFeatureRequests = (api: PlatformApi, query: AccountsQuery) =>
  api.get(
    `/v1/platform/feature-change-requests${qs({ limit: PAGE, cursor: query.cursor, lenderId: query.lenderId, status: query.status })}`,
    FeatureChangeRequestPage,
  );

/** Platform-owned exceptions that are not resolved yet, for every lender, newest first. */
export const loadOpenExceptions = (api: PlatformApi, query: AccountsQuery) =>
  api.get(
    `/v1/platform/exceptions${qs({ limit: PAGE, cursor: query.cursor, lenderId: query.lenderId, severity: query.severity, class: query.class })}`,
    LpExceptionPage,
  );

/** Platform-owned exceptions that were resolved, read through the shared queue route (the platform list leaves them out). */
export const loadResolvedExceptions = (api: PlatformApi, query: AccountsQuery) =>
  api.get(
    `/v1/lender/reconciliation/exceptions${qs({ limit: PAGE, cursor: query.cursor, lenderId: query.lenderId, severity: query.severity, class: query.class, owner: 'platform', status: 'resolved' })}`,
    LpExceptionPage,
  );

export const loadException = (api: PlatformApi, id: string) =>
  api.get(`/v1/lender/reconciliation/exceptions/${id}`, LpExceptionDetail);

/**
 * The lenders to choose from in a form. This reads the onboarding list, which a person without the onboarding permission
 * cannot see; then the form asks for the lender's id instead. Null means the list could not be read.
 */
export async function loadLenderChoices(api: OnboardingApi): Promise<LenderChoice[] | null> {
  const result = await api.get('/v1/onboarding/lenders', LenderSummaryList);
  if (!result.ok) return null;
  return result.data.items.map((l) => ({ id: l.lenderOrgId, name: l.displayName }));
}

/** The name of a lender for a heading, or its identifier when the list is not available. */
export const lenderLabel = (choices: readonly LenderChoice[] | null, lenderId: string): string =>
  choices?.find((c) => c.id === lenderId)?.name ?? `Lender ${lenderId}`;
