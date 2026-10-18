import {
  FeatureSwitchList,
  MerchantPage,
  PaymentConfigEntry,
  PaymentConfigHistory,
  PaymentConfigPage,
  PaymentConfigStatus,
  PaymentProviderChoiceList,
  SettlementAccountPage,
  SettlementAccountRegistryStatusList,
} from '@udofin/contracts';
import { type OnboardingApi } from '../onboarding/api.js';

// ---------------------------------------------------------------------------------------------------------------
// What the signed-in person may do, per lender. Hiding a form is a convenience: the API and the database decide.
// ---------------------------------------------------------------------------------------------------------------
export interface MembershipLike {
  organizationId: string;
  organizationKind: string;
  organizationName: string;
  permissions: readonly string[];
}

export interface SetupGrant {
  lenderId: string;
  name: string;
  /** May read payment setup, the registry status and the features (payment.read). */
  read: boolean;
  /** May draft, submit, withdraw configurations, claim merchants and request settlement accounts (payment.configure). */
  configure: boolean;
  /** May decide a submitted configuration made by someone else, and retire one (payment.config.approve). */
  approve: boolean;
}

export type SetupAbility = 'read' | 'configure' | 'approve';

/** One grant per lender organisation the person belongs to. Platform memberships hold no lender grant, so they get no write form. */
export function setupGrants(memberships: readonly MembershipLike[]): SetupGrant[] {
  return memberships
    .filter((m) => m.organizationKind === 'lender')
    .map((m) => ({
      lenderId: m.organizationId,
      name: m.organizationName,
      read: m.permissions.includes('payment.read'),
      configure: m.permissions.includes('payment.configure'),
      approve: m.permissions.includes('payment.config.approve'),
    }));
}

export const mayIn = (
  grants: readonly SetupGrant[],
  lenderId: string,
  ability: SetupAbility,
): boolean => grants.some((g) => g.lenderId === lenderId && g[ability]);

/** The pages open to payment.read, payment.configure or payment.config.approve. */
export const maySeeSetup = (grant: SetupGrant): boolean =>
  grant.read || grant.configure || grant.approve;

/**
 * Whether a decide form may be drawn: the configuration waits for a decision, the person holds the approve permission in that
 * lender, and the person neither drafted nor submitted it. The API and the database refuse self-approval again; this only hides it.
 */
export const mayDecide = (
  grants: readonly SetupGrant[],
  config: { lenderId: string; status: string; draftedBy: string; submittedBy: string | null },
  userId: string,
): boolean =>
  config.status === 'pending_approval' &&
  config.draftedBy !== userId &&
  config.submittedBy !== userId &&
  mayIn(grants, config.lenderId, 'approve');

/** Submitting needs payment.configure and a draft or a suspended configuration. */
export const maySubmit = (
  grants: readonly SetupGrant[],
  config: { lenderId: string; status: string },
): boolean =>
  (config.status === 'draft' || config.status === 'suspended') &&
  mayIn(grants, config.lenderId, 'configure');

/** Withdrawing needs payment.configure and a draft or a configuration waiting for approval. */
export const mayWithdraw = (
  grants: readonly SetupGrant[],
  config: { lenderId: string; status: string },
): boolean =>
  (config.status === 'draft' || config.status === 'pending_approval') &&
  mayIn(grants, config.lenderId, 'configure');

/** Retiring is the lender approver's act, on an approved or suspended configuration. */
export const mayRetire = (
  grants: readonly SetupGrant[],
  config: { lenderId: string; status: string },
): boolean =>
  (config.status === 'active' || config.status === 'suspended') &&
  mayIn(grants, config.lenderId, 'approve');

/** The lender a page is about: the one asked for if the person belongs to it, else the first that fits. Null when none fits. */
export function chooseLender(
  grants: readonly SetupGrant[],
  asked: string | undefined,
  fits: (grant: SetupGrant) => boolean = maySeeSetup,
): SetupGrant | null {
  const candidates = grants.filter(fits);
  return candidates.find((g) => g.lenderId === asked) ?? candidates[0] ?? null;
}

// ---------------------------------------------------------------------------------------------------------------
// Page queries (from the URL). Anything that does not look right is dropped, never passed on.
// ---------------------------------------------------------------------------------------------------------------
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CURSOR = /^[A-Za-z0-9_-]{1,300}$/;

export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && UUID.test(value);

const one = (value: string | string[] | undefined): string | undefined =>
  typeof value === 'string' ? value : undefined;

export interface SetupQuery {
  cursor?: string;
  lenderId?: string;
  status?: string;
}

export function parseSetupQuery(raw: Record<string, string | string[] | undefined>): SetupQuery {
  const cursor = one(raw.cursor);
  const lenderId = one(raw.lenderId);
  const status = PaymentConfigStatus.options.find((candidate) => candidate === one(raw.status));
  return {
    ...(cursor && CURSOR.test(cursor) ? { cursor } : {}),
    ...(isUuid(lenderId) ? { lenderId } : {}),
    ...(status ? { status } : {}),
  };
}

const qs = (params: Record<string, string | number | undefined>): string => {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
  return parts.length > 0 ? `?${parts.join('&')}` : '';
};

export const setupHref = (base: string, query: SetupQuery): string =>
  `${base}${qs({ lenderId: query.lenderId, status: query.status, cursor: query.cursor })}`;

export const withoutCursor = (query: SetupQuery): SetupQuery => {
  const { cursor: _cursor, ...rest } = query;
  return rest;
};

// ---------------------------------------------------------------------------------------------------------------
// Loaders. Every response is checked against the contract by the API client; a failure is a code, never server text.
// ---------------------------------------------------------------------------------------------------------------
export const loadConfigs = (api: OnboardingApi, lenderId: string, query: SetupQuery) =>
  api.get(
    `/v1/lender/payment-configs${qs({ lenderId, limit: 25, cursor: query.cursor, status: query.status })}`,
    PaymentConfigPage,
  );

export const loadConfig = (api: OnboardingApi, id: string) =>
  api.get(`/v1/lender/payment-configs/${id}`, PaymentConfigEntry);

export const loadConfigHistory = (api: OnboardingApi, id: string) =>
  api.get(`/v1/lender/payment-configs/${id}/history`, PaymentConfigHistory);

export const loadProviders = (api: OnboardingApi) =>
  api.get('/v1/lender/payment-providers', PaymentProviderChoiceList);

/** A lender has at most a few merchants; one page of 100 names them all for the lists and the draft form. */
export const loadMerchants = (api: OnboardingApi, lenderId: string) =>
  api.get(`/v1/lender/merchants${qs({ lenderId, limit: 100 })}`, MerchantPage);

/** At most 20 settlement accounts per lender exist, so one page names them all. */
export const loadSettlementAccounts = (api: OnboardingApi, lenderId: string) =>
  api.get(`/v1/lender/settlement-accounts${qs({ lenderId, limit: 100 })}`, SettlementAccountPage);

export const loadRegistryStatus = (api: OnboardingApi) =>
  api.get('/v1/lender/settlement-accounts/registry-status', SettlementAccountRegistryStatusList);

export const loadFeatures = (api: OnboardingApi, lenderId: string) =>
  api.get(`/v1/lender/features${qs({ lenderId })}`, FeatureSwitchList);
