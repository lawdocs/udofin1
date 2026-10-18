// @vitest-environment jsdom
// The lender payment-setup screens: every state, the wording rules (a test configuration is never presented as live), the
// guards that hide a write form from a role that may not use it (and the decide form from the drafter and the submitter), the
// allow-listed operations (no full account number, no secret value, one callback token shown once), and the cross-checks that
// no screen shows a raw server code. Every fixture is parsed by the real contract schema. All names and values are synthetic.
import {
  FeatureSwitchState,
  MerchantEntry,
  PaymentConfigEntry,
  PaymentConfigHistoryEntry,
  PaymentConfigMode,
  PaymentConfigStatus,
  PaymentProviderChoice,
  RegistryVerificationStatus,
  SettlementAccountForLinking,
  SettlementAccountRegistryStatus,
} from '@udofin/contracts';
import {
  cleanup,
  configure,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type OnboardingApi } from '../src/onboarding/api.js';
import {
  ConfigDraftForm,
  MerchantClaimForm,
  OneTimeToken,
  SettlementRequestForm,
} from '../src/setup/client-forms.js';
import { type SetupContext } from '../src/setup/common.js';
import {
  chooseLender,
  loadConfig,
  loadConfigHistory,
  loadConfigs,
  loadFeatures,
  loadMerchants,
  loadProviders,
  loadRegistryStatus,
  loadSettlementAccounts,
  mayDecide,
  mayIn,
  mayRetire,
  maySeeSetup,
  maySubmit,
  mayWithdraw,
  parseSetupQuery,
  setupGrants,
  setupHref,
} from '../src/setup/data.js';
import {
  readRailLimits,
  runSetupOperation,
  safeSetupReturnPath,
  SETUP_OPERATIONS,
  setupNoticeUrl,
} from '../src/setup/operations.js';
import {
  SetupAccountsPage,
  SetupConfigDetailPage,
  SetupConfigsPage,
  SetupFeaturesPage,
  SetupNewConfigPage,
} from '../src/setup/views.js';
import {
  actorKindWords,
  configStatusShort,
  configStatusWords,
  eventKindWords,
  featureWords,
  isTestMode,
  looksLikeSecretValue,
  merchantStatusWords,
  merchantVerificationWords,
  modeWords,
  providerKindWords,
  railValueWords,
  reasonWords,
  registryStatusWords,
  settlementStatusWords,
  setupErrorMessage,
} from '../src/setup/wording.js';

// These tests type into real forms; on a busy machine that can take longer than the defaults.
configure({ asyncUtilTimeout: 20000 });
vi.setConfig({ testTimeout: 30_000 });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------------------------------------------------
// Synthetic fixtures
// ---------------------------------------------------------------------------------------------------------------------
const LENDER_A = '0190a000-0000-7000-8000-00000000000a';
const LENDER_B = '0190a000-0000-7000-8000-00000000000b';
const ME = '0190a000-0000-7000-8000-0000000000e1';
const OTHER = '0190a000-0000-7000-8000-0000000000e2';
const THIRD = '0190a000-0000-7000-8000-0000000000e3';
const CONFIG = '0190a000-0000-7000-8000-000000000a01';
const CONFIG_2 = '0190a000-0000-7000-8000-000000000a02';
const MERCHANT = '0190a000-0000-7000-8000-000000000b01';
const MERCHANT_2 = '0190a000-0000-7000-8000-000000000b02';
const SETTLEMENT = '0190a000-0000-7000-8000-000000000c01';
const SETTLEMENT_2 = '0190a000-0000-7000-8000-000000000c02';
const REGISTRY = '0190a000-0000-7000-8000-000000000d01';
const EVENT = '0190a000-0000-7000-8000-000000000e01';
const AT = '2026-10-16T10:15:30.000000+00:00';
const AT_2 = '2026-10-17T04:30:00.000000+00:00';
const PATH_PART = `sample-callback-part-${'x'.repeat(22)}`;
const CALLBACK_PATH = `/v1/hooks/provider/${PATH_PART}`;

const GENERIC = 'The action could not be completed. Nothing was changed.';

const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const fail = (status: number, code = 'internal_failure') => ({
  ok: false as const,
  status,
  code,
});
const pageOf = <T,>(items: T[], nextCursor: string | null = null) => ok({ items, nextCursor });

const config = (over: object = {}) =>
  PaymentConfigEntry.parse({
    id: CONFIG,
    lenderId: LENDER_A,
    provider: 'sample_psp',
    providerMode: 'production',
    merchantRegistryId: MERCHANT,
    settlementAccountId: SETTLEMENT,
    secretRef: 'LENDER_PSP_ONE',
    webhookSecretRef: 'LENDER_PSP_TWO',
    railLimits: { upi: { per_payment_max: 10_000_000, needs_prompt: true, window: 'next day' } },
    railLimitsSource: 'Provider guide, section on limits',
    evidenceRef: 'Onboarding mail ref 7',
    contractSectionRef: 'Agreement clause 4',
    status: 'draft',
    draftedBy: OTHER,
    draftedAt: AT,
    submittedBy: null,
    submittedAt: null,
    approvedBy: null,
    approvedAt: null,
    statusReason: null,
    statusReasons: [],
    lastValidatedAt: null,
    lastValidationOk: null,
    updatedAt: AT,
    ...over,
  });

const merchant = (over: object = {}) =>
  MerchantEntry.parse({
    id: MERCHANT,
    provider: 'sample_psp',
    merchantRef: 'SAMPLE-MERCH-01',
    ownerKind: 'lender',
    ownerOrgId: LENDER_A,
    purpose: 'repayment',
    status: 'active',
    verificationStatus: 'verified',
    verificationEvidenceRef: null,
    claimedAt: AT,
    verifiedAt: AT_2,
    revokedAt: null,
    revokedReason: null,
    ...over,
  });

const settlement = (over: object = {}) =>
  SettlementAccountForLinking.parse({
    id: SETTLEMENT,
    lenderId: LENDER_A,
    label: 'Collections account',
    bankName: 'Sample Bank',
    maskedRef: 'XXXXXX1234',
    status: 'verified',
    registryId: REGISTRY,
    createdAt: AT,
    ...over,
  });

const registryRow = (over: object = {}) =>
  SettlementAccountRegistryStatus.parse({
    settlementAccountId: SETTLEMENT,
    lenderId: LENDER_A,
    maskedRef: 'XXXXXX1234',
    verificationStatus: 'verified',
    effectiveFrom: '2026-10-01',
    effectiveTo: null,
    usable: true,
    ...over,
  });

const feature = (over: object = {}) =>
  FeatureSwitchState.parse({
    lenderId: LENDER_A,
    feature: 'payments',
    enabled: false,
    enableable: true,
    enabledAt: null,
    disabledAt: null,
    ...over,
  });

const event = (over: object = {}) =>
  PaymentConfigHistoryEntry.parse({
    id: EVENT,
    eventKind: 'drafted',
    fromStatus: null,
    toStatus: 'draft',
    actorKind: 'lender',
    occurredAt: AT,
    reasons: [],
    ...over,
  });

const providers = ok({
  items: [
    PaymentProviderChoice.parse({
      provider: 'sample_psp',
      displayName: 'Sample Payments Ltd',
      kind: 'payment',
      status: 'approved',
    }),
  ],
});
const merchants = ok({ items: [merchant()], nextCursor: null });
const settlements = ok({ items: [settlement()], nextCursor: null });
const history = ok({ items: [event()] });

const grantsFor = (
  permissions: readonly string[],
  lender = LENDER_A,
  name = 'Sample Finance Ltd',
) =>
  setupGrants([
    {
      organizationId: lender,
      organizationKind: 'lender',
      organizationName: name,
      permissions,
    },
  ]);

const ctxFor = (
  permissions: readonly string[],
  returnTo = '/payment-setup',
  userId = ME,
): SetupContext => ({
  action: vi.fn(() => Promise.resolve()),
  draft: vi.fn(() => Promise.resolve({ ok: true as const })),
  draftConfig: vi.fn(() => Promise.resolve({ ok: false as const, code: 'validation_failed' })),
  returnTo,
  grants: grantsFor(permissions),
  userId,
});

const READ = ['payment.read'] as const;
const CONFIGURE = ['payment.read', 'payment.configure'] as const;
const APPROVE = ['payment.read', 'payment.config.approve'] as const;

const text = (container: HTMLElement) => container.textContent ?? '';
const ops = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLInputElement>('input[name="op"]')].map((i) => i.value);
const stripIds = (value: string) =>
  value.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, 'ID');

function recorder(answer: unknown = {}) {
  const calls: { path: string; body: unknown; key: string }[] = [];
  const reads: string[] = [];
  const api: OnboardingApi = {
    get: (path) => {
      reads.push(path);
      return Promise.resolve({ ok: false as const, status: 404, code: 'not_found' });
    },
    post: (path, _schema, body, key) => {
      calls.push({ path, body, key });
      return Promise.resolve({ ok: true as const, status: 200, data: answer as never });
    },
  };
  return { api, calls, reads };
}

const REQUEST_ID = 'ui-0190a000-0000-7000-8000-0000000009ff';
function formOf(fields: Record<string, string | string[]>, withKey = true): FormData {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    if (Array.isArray(value)) for (const v of value) form.append(name, v);
    else form.append(name, value);
  }
  if (withKey) form.set('key', REQUEST_ID);
  return form;
}

const DRAFT_ANSWER = {
  id: CONFIG,
  status: 'draft',
  endpointToken: PATH_PART,
  callbackPath: CALLBACK_PATH,
};

const draftFields = {
  op: 'setup.config.draft',
  lenderId: LENDER_A,
  provider: 'sample_psp',
  providerMode: 'sandbox',
  merchantRegistryId: MERCHANT,
  settlementAccountId: SETTLEMENT,
  secretRef: 'LENDER_PSP_ONE',
  webhookSecretRef: 'LENDER_PSP_TWO',
};

// ---------------------------------------------------------------------------------------------------------------------
describe('wording: a test configuration is never presented as live', () => {
  it('names the modes and marks mock and sandbox as test only', () => {
    expect(modeWords('mock')).toBe('Test only: mock provider');
    expect(modeWords('sandbox')).toBe('Test only: provider sandbox');
    expect(modeWords('production')).toBe('Production mode');
    expect(isTestMode('mock')).toBe(true);
    expect(isTestMode('sandbox')).toBe(true);
    expect(isTestMode('production')).toBe(false);
    // A mode the screen does not know is treated as a test mode, the cautious reading.
    expect(isTestMode('staging_or_whatever')).toBe(true);
  });

  it('adds "test only" to every status of a test configuration, and to none of a production one', () => {
    for (const status of PaymentConfigStatus.options) {
      expect(configStatusWords(status, 'mock'), status).toMatch(/\(test only\)$/);
      expect(configStatusWords(status, 'sandbox'), status).toMatch(/\(test only\)$/);
      expect(configStatusWords(status, 'production'), status).not.toMatch(/test only/);
    }
  });

  it('never says an approved configuration is live', () => {
    for (const status of PaymentConfigStatus.options)
      for (const mode of PaymentConfigMode.options) {
        expect(configStatusWords(status, mode)).not.toMatch(/\blive\b/i);
        expect(configStatusShort(status)).not.toMatch(/\blive\b/i);
      }
    expect(configStatusWords('active', 'production')).toBe('Approved');
  });
});

describe('every value of a closed vocabulary has plain words, and an unknown one is never printed', () => {
  const unknownMarker = /this screen has no wording|^Unknown|^Someone$|^a service this screen/;

  it('covers every value the contract lists', () => {
    for (const status of PaymentConfigStatus.options)
      expect(configStatusWords(status, 'production'), status).not.toMatch(unknownMarker);
    for (const status of RegistryVerificationStatus.options)
      expect(registryStatusWords(status), status).not.toMatch(unknownMarker);
    for (const status of ['unverified', 'verified'])
      expect(merchantVerificationWords(status), status).not.toMatch(unknownMarker);
    for (const status of ['active', 'revoked'])
      expect(merchantStatusWords(status), status).not.toMatch(unknownMarker);
    for (const status of ['unverified', 'verified', 'revoked'])
      expect(settlementStatusWords(status), status).not.toMatch(unknownMarker);
    for (const kind of ['drafted', 'submitted', 'approved', 'suspended', 'retired'])
      expect(eventKindWords(kind), kind).not.toMatch(unknownMarker);
    for (const kind of ['lender', 'platform', 'system'])
      expect(actorKindWords(kind), kind).not.toMatch(unknownMarker);
    for (const kind of ['payment', 'mandate', 'payment_and_mandate'])
      expect(providerKindWords(kind), kind).not.toMatch(unknownMarker);
    for (const name of [
      'servicing_sync',
      'payments',
      'mandates',
      'reminders',
      'statements_noc',
      'collections',
      'dlg',
    ])
      expect(featureWords(name), name).not.toMatch(unknownMarker);
  });

  it('gives plain words to every reason a configuration can be refused', () => {
    const codes = [
      'organisation_not_lender',
      'lender_organisation_not_active',
      'onboarding_gate_not_activated',
      'settlement_account_not_found',
      'settlement_account_not_verified',
      'settlement_account_unregistered',
      'settlement_masked_ref_mismatch',
      'merchant_not_found',
      'merchant_not_active',
      'merchant_not_verified',
      'merchant_not_repayment',
      'merchant_owner_mismatch',
      'merchant_provider_mismatch',
      'provider_not_registered',
      'provider_not_approved',
      'provider_kind_not_payment',
      'provider_evidence_missing',
      'provider_mode_mock_blocked',
      'provider_mode_sandbox_blocked',
      'config_evidence_missing',
      'contract_section_missing',
      'config_not_found',
      'platform_suspension',
      'destination_account_revoked',
      'destination_owner_mismatch',
    ];
    for (const code of codes) {
      const words = reasonWords(code);
      expect(words, code).not.toMatch(/this screen has no wording/);
      expect(words, code).not.toContain(code);
    }
  });

  it('never prints a value or code it has no wording for', () => {
    expect(reasonWords('some_new_reason')).not.toContain('some_new_reason');
    expect(reasonWords('__proto__')).not.toContain('__proto__');
    expect(modeWords('quantum')).not.toContain('quantum');
    expect(configStatusWords('exploded', 'production')).not.toContain('exploded');
    expect(featureWords('teleport')).not.toContain('teleport');
    expect(registryStatusWords('constructor')).not.toContain('constructor');
    expect(eventKindWords('toString')).not.toContain('toString');
  });

  it('shows limit values as written, as yes or no, or as the stored whole number', () => {
    expect(railValueWords('next day')).toBe('next day');
    expect(railValueWords(true)).toBe('Yes');
    expect(railValueWords(false)).toBe('No');
    expect(railValueWords(10_000_000)).toBe('10000000');
  });
});

describe('error codes become sentences, and nothing the server said reaches the screen', () => {
  it('maps every code the API documents for these routes', () => {
    const codes = [
      'forbidden',
      'not_found',
      'mock_provider_blocked',
      'sandbox_provider_blocked',
      'provider_mode_invalid',
      'secret_ref_invalid',
      'rail_limits_invalid',
      'provider_invalid',
      'merchant_invalid',
      'settlement_account_invalid',
      'merchant_ref_invalid',
      'merchant_already_claimed',
      'idempotency_conflict',
      'endpoint_token_in_use',
      'config_state_invalid',
      'collection_target_invalid',
      'self_approval',
      'requester_not_entitled',
      'reason_required',
      'reason_invalid',
      'unsafe_free_text',
      'validation_failed',
      'rate_limited',
      'mfa_required',
    ];
    for (const code of codes) expect(setupErrorMessage(code), code).not.toBe(GENERIC);
  });

  it('gives the generic sentence for an unknown code, a database state or nothing', () => {
    for (const code of ['23505', 'SQLSTATE 23505', 'internal_failure', '', 'toString', '__proto__'])
      expect(setupErrorMessage(code), code).toBe(GENERIC);
    expect(setupErrorMessage(null)).toBe(GENERIC);
    expect(setupErrorMessage(undefined)).toBe(GENERIC);
  });

  it('tells the lender never to type a full account number or a secret', () => {
    expect(setupErrorMessage('masked_ref_invalid')).toMatch(/Never type a full account number/);
    expect(setupErrorMessage('secret_looks_like_value')).toMatch(/not a name/);
    expect(setupErrorMessage('secret_ref_invalid')).toMatch(/NAME of a secret/);
  });
});

describe('secret references are names, never values', () => {
  it.each([
    'LENDER_PSP_ONE',
    'PROVIDER_ACCESS_NAME',
    'A_B',
    'ABC',
    'PSP_1_NAME_2',
    'X'.repeat(8) + '_' + 'Y'.repeat(8),
  ])('accepts the name %s', (name) => {
    expect(looksLikeSecretValue(name)).toBe(false);
  });

  it.each([
    ['empty', ''],
    ['too short', 'AB'],
    ['lower case', 'abc123def456'],
    ['mixed case', 'Provider_Name'],
    ['starts with a digit', '1_NAME_HERE'],
    ['has a space', 'NAME WITH SPACE'],
    ['has a symbol', 'NAME-WITH-DASH'],
    ['has a long run of digits', 'KEY_123456789'],
    ['is a long run of hexadecimal digits', 'ABCDEF0123456789ABCD'],
    ['is a shorter run of hexadecimal digits', 'ABCDEFAB12CDEF34'],
    ['is a long unbroken run', 'ABCDEFGHIJKLMNOPQRSTUVWX'],
    ['is longer than 64 characters', 'A_' + 'B'.repeat(70)],
  ])('refuses text that is %s', (_why, value) => {
    expect(looksLikeSecretValue(value)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('what the person may do, per lender', () => {
  const base = { lenderId: LENDER_A, draftedBy: OTHER, submittedBy: THIRD };

  it('turns lender memberships into grants and ignores platform memberships', () => {
    const grants = setupGrants([
      {
        organizationId: LENDER_A,
        organizationKind: 'lender',
        organizationName: 'A',
        permissions: ['payment.configure'],
      },
      {
        organizationId: LENDER_B,
        organizationKind: 'lender',
        organizationName: 'B',
        permissions: ['payment.config.approve', 'payment.read'],
      },
      {
        organizationId: '0190a000-0000-7000-8000-0000000000aa',
        organizationKind: 'platform',
        organizationName: 'P',
        permissions: ['payment.configure', 'payment.config.approve', 'payment.read'],
      },
    ]);
    expect(grants).toHaveLength(2);
    expect(mayIn(grants, LENDER_A, 'configure')).toBe(true);
    expect(mayIn(grants, LENDER_A, 'approve')).toBe(false);
    expect(mayIn(grants, LENDER_B, 'approve')).toBe(true);
    expect(mayIn(grants, LENDER_B, 'configure')).toBe(false);
    expect(mayIn(grants, '0190a000-0000-7000-8000-0000000000ff', 'read')).toBe(false);
  });

  it('opens the pages to a person with any payment permission', () => {
    for (const permissions of [
      ['payment.read'],
      ['payment.configure'],
      ['payment.config.approve'],
    ]) {
      const [grant] = grantsFor(permissions);
      expect(grant ? maySeeSetup(grant) : null).toBe(true);
    }
    const [none] = grantsFor(['loan.read']);
    expect(none ? maySeeSetup(none) : null).toBe(false);
  });

  it('draws the decide form only for a submitted configuration, for an approver who neither drafted nor submitted it', () => {
    const grants = grantsFor(APPROVE);
    const pending = { ...base, status: 'pending_approval' };
    expect(mayDecide(grants, pending, ME)).toBe(true);
    // The drafter never decides.
    expect(mayDecide(grants, { ...pending, draftedBy: ME }, ME)).toBe(false);
    // Nor does the person who submitted it.
    expect(mayDecide(grants, { ...pending, submittedBy: ME }, ME)).toBe(false);
    for (const status of ['draft', 'active', 'suspended', 'retired'])
      expect(mayDecide(grants, { ...base, status }, ME), status).toBe(false);
    expect(mayDecide(grantsFor(CONFIGURE), pending, ME)).toBe(false);
    expect(mayDecide(grantsFor(APPROVE, LENDER_B), pending, ME)).toBe(false);
  });

  it('draws submit for a draft or a suspended configuration, for a person who configures', () => {
    expect(maySubmit(grantsFor(CONFIGURE), { ...base, status: 'draft' })).toBe(true);
    expect(maySubmit(grantsFor(CONFIGURE), { ...base, status: 'suspended' })).toBe(true);
    for (const status of ['pending_approval', 'active', 'retired'])
      expect(maySubmit(grantsFor(CONFIGURE), { ...base, status }), status).toBe(false);
    expect(maySubmit(grantsFor(READ), { ...base, status: 'draft' })).toBe(false);
    expect(maySubmit(grantsFor(APPROVE), { ...base, status: 'draft' })).toBe(false);
  });

  it('draws withdraw for a draft or a waiting configuration, for a person who configures', () => {
    expect(mayWithdraw(grantsFor(CONFIGURE), { ...base, status: 'draft' })).toBe(true);
    expect(mayWithdraw(grantsFor(CONFIGURE), { ...base, status: 'pending_approval' })).toBe(true);
    for (const status of ['active', 'suspended', 'retired'])
      expect(mayWithdraw(grantsFor(CONFIGURE), { ...base, status }), status).toBe(false);
    expect(mayWithdraw(grantsFor(READ), { ...base, status: 'draft' })).toBe(false);
  });

  it('draws retire for an approved or suspended configuration, for the lender approver', () => {
    expect(mayRetire(grantsFor(APPROVE), { ...base, status: 'active' })).toBe(true);
    expect(mayRetire(grantsFor(APPROVE), { ...base, status: 'suspended' })).toBe(true);
    for (const status of ['draft', 'pending_approval', 'retired'])
      expect(mayRetire(grantsFor(APPROVE), { ...base, status }), status).toBe(false);
    expect(mayRetire(grantsFor(CONFIGURE), { ...base, status: 'active' })).toBe(false);
  });

  it('chooses the lender asked for when the person belongs to it, else the first that fits', () => {
    const grants = [...grantsFor(READ, LENDER_A, 'A'), ...grantsFor(CONFIGURE, LENDER_B, 'B')];
    expect(chooseLender(grants, LENDER_B)?.lenderId).toBe(LENDER_B);
    expect(chooseLender(grants, '0190a000-0000-7000-8000-0000000000ff')?.lenderId).toBe(LENDER_A);
    expect(chooseLender(grants, LENDER_A, (g) => g.configure)?.lenderId).toBe(LENDER_B);
    expect(chooseLender([], LENDER_A)).toBeNull();
  });
});

describe('page queries and loaders', () => {
  it('keeps only filters that look right', () => {
    expect(parseSetupQuery({ lenderId: LENDER_A, status: 'active', cursor: 'abc_DEF-1' })).toEqual({
      lenderId: LENDER_A,
      status: 'active',
      cursor: 'abc_DEF-1',
    });
    expect(parseSetupQuery({ lenderId: 'nope', status: 'live', cursor: 'a b' })).toEqual({});
    expect(parseSetupQuery({ status: ['active'] })).toEqual({});
  });

  it('builds links that keep the filters', () => {
    expect(setupHref('/payment-setup', { status: 'draft', cursor: 'c' })).toBe(
      '/payment-setup?status=draft&cursor=c',
    );
    expect(setupHref('/payment-setup', {})).toBe('/payment-setup');
  });

  it('reads each page from its own route', async () => {
    const { api, reads } = recorder();
    await loadConfigs(api, LENDER_A, { status: 'active', cursor: 'c1' });
    await loadConfig(api, CONFIG);
    await loadConfigHistory(api, CONFIG);
    await loadProviders(api);
    await loadMerchants(api, LENDER_A);
    await loadSettlementAccounts(api, LENDER_A);
    await loadRegistryStatus(api);
    await loadFeatures(api, LENDER_A);
    expect(reads).toEqual([
      `/v1/lender/payment-configs?lenderId=${LENDER_A}&limit=25&cursor=c1&status=active`,
      `/v1/lender/payment-configs/${CONFIG}`,
      `/v1/lender/payment-configs/${CONFIG}/history`,
      '/v1/lender/payment-providers',
      `/v1/lender/merchants?lenderId=${LENDER_A}&limit=100`,
      `/v1/lender/settlement-accounts?lenderId=${LENDER_A}&limit=100`,
      '/v1/lender/settlement-accounts/registry-status',
      `/v1/lender/features?lenderId=${LENDER_A}`,
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('the allow-listed operations', () => {
  it('exposes exactly the operations the screens draw', () => {
    expect(Object.keys(SETUP_OPERATIONS).sort()).toEqual([
      'setup.config.decide',
      'setup.config.draft',
      'setup.config.retire',
      'setup.config.submit',
      'setup.config.withdraw',
      'setup.merchant.claim',
      'setup.settlement.request',
    ]);
  });

  it('refuses an operation that is not on the list, without any call', async () => {
    const { api, calls } = recorder();
    for (const op of [
      'setup.config.suspend',
      'setup.account.register',
      'reminders.hold.release',
      '__proto__',
      'constructor',
      '',
    ])
      expect(await runSetupOperation(api, formOf({ op })), op).toEqual({
        ok: false,
        code: 'path_not_allowed',
      });
    expect(await runSetupOperation(api, formOf({}))).toEqual({
      ok: false,
      code: 'path_not_allowed',
    });
    expect(calls).toEqual([]);
  });

  it('refuses a request key of the wrong shape, without any call', async () => {
    const { api, calls } = recorder();
    for (const key of ['', 'short', 'has spaces in it and is long enough', 'x'.repeat(200)]) {
      const form = formOf({ op: 'setup.config.submit', id: CONFIG }, false);
      form.set('key', key);
      expect(await runSetupOperation(api, form), key).toEqual({
        ok: false,
        code: 'validation_failed',
      });
    }
    expect(calls).toEqual([]);
  });

  it('serves the configuration draft only through its own entry point', async () => {
    const { api, calls } = recorder(DRAFT_ANSWER);
    expect(await runSetupOperation(api, formOf(draftFields))).toEqual({
      ok: false,
      code: 'path_not_allowed',
    });
    expect(calls).toEqual([]);
    const result = await runSetupOperation(api, formOf(draftFields), 'setup.config.draft');
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('ignores a different operation named by the form when the draft entry point is used', async () => {
    const { api, calls } = recorder(DRAFT_ANSWER);
    await runSetupOperation(
      api,
      formOf({ ...draftFields, op: 'setup.config.submit' }),
      'setup.config.draft',
    );
    expect(calls[0]?.path).toBe('/v1/lender/payment-configs');
  });

  describe('settlement account request: masked reference only', () => {
    const base = {
      op: 'setup.settlement.request',
      lenderId: LENDER_A,
      label: 'Collections account',
      bankName: 'Sample Bank',
      maskedRef: 'XXXXXX1234',
    };

    it('sends the label, the bank and the masked reference and nothing else', async () => {
      const { api, calls } = recorder();
      expect(await runSetupOperation(api, formOf(base))).toEqual({ ok: true });
      expect(calls).toEqual([
        {
          path: '/v1/lender/settlement-accounts',
          key: REQUEST_ID,
          body: {
            lenderId: LENDER_A,
            label: 'Collections account',
            bankName: 'Sample Bank',
            maskedRef: 'XXXXXX1234',
          },
        },
      ]);
    });

    it.each(['XXXXXX1234', '****1234', 'XX12', 'XXXXXXXXXX123', 'X*X*X*123'])(
      'accepts the masked reference %s',
      async (maskedRef) => {
        const { api, calls } = recorder();
        expect(await runSetupOperation(api, formOf({ ...base, maskedRef }))).toEqual({ ok: true });
        expect(calls).toHaveLength(1);
      },
    );

    it.each([
      ['a full account number', '123456789012'],
      ['a long number', '12345678901234'],
      ['a number with a few X', 'XX123456789'],
      ['five trailing digits', 'XXXXXX12345'],
      ['one trailing digit', 'XXXXXX1'],
      ['one X only', 'X1234'],
      ['lower case x', 'xxxxxx1234'],
      ['letters', 'XXXXXXABCD'],
      ['a space', 'XXXX 1234'],
      ['nothing', ''],
    ])('sends nothing when the masked reference is %s', async (_why, maskedRef) => {
      const { api, calls } = recorder();
      expect(await runSetupOperation(api, formOf({ ...base, maskedRef }))).toEqual({
        ok: false,
        code: 'masked_ref_invalid',
      });
      expect(calls).toEqual([]);
    });

    it('sends nothing when the label or the bank name carries a long number', async () => {
      const { api, calls } = recorder();
      for (const change of [{ label: 'Account 123456' }, { bankName: 'Bank 12345678' }])
        expect(await runSetupOperation(api, formOf({ ...base, ...change }))).toEqual({
          ok: false,
          code: 'settlement_account_invalid',
        });
      expect(calls).toEqual([]);
    });

    it('sends nothing for a missing label, bank or lender', async () => {
      const { api, calls } = recorder();
      expect(await runSetupOperation(api, formOf({ ...base, label: '' }))).toEqual({
        ok: false,
        code: 'settlement_account_invalid',
      });
      expect(await runSetupOperation(api, formOf({ ...base, bankName: 'B' }))).toEqual({
        ok: false,
        code: 'settlement_account_invalid',
      });
      expect((await runSetupOperation(api, formOf({ ...base, lenderId: 'nope' }))).ok).toBe(false);
      expect(calls).toEqual([]);
    });

    it('does not accept an account number field at all', async () => {
      const { api, calls } = recorder();
      await runSetupOperation(
        api,
        formOf({ ...base, accountNumber: '123456789012', ifsc: 'ABCD0123456' }),
      );
      expect(JSON.stringify(calls)).not.toMatch(/accountNumber|ifsc|123456789012|ABCD0123456/);
    });
  });

  describe('merchant claim', () => {
    const base = {
      op: 'setup.merchant.claim',
      lenderId: LENDER_A,
      provider: 'sample_psp',
      merchantRef: 'SAMPLE-MERCH-01',
    };

    it('sends the claim exactly as typed', async () => {
      const { api, calls } = recorder();
      expect(await runSetupOperation(api, formOf(base))).toEqual({ ok: true });
      expect(calls).toEqual([
        {
          path: '/v1/lender/merchants',
          key: REQUEST_ID,
          body: { lenderId: LENDER_A, provider: 'sample_psp', merchantRef: 'SAMPLE-MERCH-01' },
        },
      ]);
    });

    it.each([
      [{ provider: 'Sample PSP' }, 'provider_invalid'],
      [{ provider: '' }, 'provider_invalid'],
      [{ merchantRef: 'ab' }, 'merchant_ref_invalid'],
      [{ merchantRef: 'has space' }, 'merchant_ref_invalid'],
      [{ merchantRef: '../x' }, 'merchant_ref_invalid'],
      [{ merchantRef: '' }, 'merchant_ref_invalid'],
    ])('sends nothing for %j', async (change, code) => {
      const { api, calls } = recorder();
      expect(await runSetupOperation(api, formOf({ ...base, ...change }))).toEqual({
        ok: false,
        code,
      });
      expect(calls).toEqual([]);
    });
  });

  describe('configuration draft', () => {
    it('sends the draft and hands the callback path back once, to the one caller that asked', async () => {
      const { api, calls } = recorder(DRAFT_ANSWER);
      const result = await runSetupOperation(api, formOf(draftFields), 'setup.config.draft');
      expect(result).toEqual({
        ok: true,
        drafted: { id: CONFIG, endpointToken: PATH_PART, callbackPath: CALLBACK_PATH },
      });
      expect(calls).toEqual([
        {
          path: '/v1/lender/payment-configs',
          key: REQUEST_ID,
          body: {
            lenderId: LENDER_A,
            provider: 'sample_psp',
            providerMode: 'sandbox',
            merchantRegistryId: MERCHANT,
            settlementAccountId: SETTLEMENT,
            secretRef: 'LENDER_PSP_ONE',
            webhookSecretRef: 'LENDER_PSP_TWO',
            railLimits: {},
          },
        },
      ]);
    });

    it('says the answer could not be used when it carries no usable token', async () => {
      const { api } = recorder({ id: CONFIG, status: 'draft' });
      expect(await runSetupOperation(api, formOf(draftFields), 'setup.config.draft')).toEqual({
        ok: false,
        code: 'bad_response',
      });
    });

    it('sends the evidence references and the rail limits as typed, with amounts in whole paise', async () => {
      const { api, calls } = recorder(DRAFT_ANSWER);
      await runSetupOperation(
        api,
        formOf({
          ...draftFields,
          providerMode: 'production',
          evidenceRef: 'Onboarding mail ref 7',
          contractSectionRef: 'Agreement clause 4',
          rail1: 'upi',
          limit1: 'per_payment_max',
          kind1: 'amount',
          value1: '100000.50',
          rail2: 'upi',
          limit2: 'needs_prompt',
          kind2: 'flag',
          value2: 'Yes',
          rail3: 'card',
          limit3: 'window',
          kind3: 'text',
          value3: 'next day',
          rail4: 'card',
          limit4: 'retries',
          kind4: 'count',
          value4: '3',
          railLimitsSource: 'Provider guide, section on limits',
        }),
        'setup.config.draft',
      );
      expect(calls[0]?.body).toMatchObject({
        providerMode: 'production',
        evidenceRef: 'Onboarding mail ref 7',
        contractSectionRef: 'Agreement clause 4',
        railLimits: {
          upi: { per_payment_max: 10_000_050, needs_prompt: true },
          card: { window: 'next day', retries: 3 },
        },
        railLimitsSource: 'Provider guide, section on limits',
      });
    });

    it.each([
      ['a lower case value', 'abc123def456'],
      ['a mixed case value', 'Some_Secret_Value'],
      ['a long hexadecimal value', 'ABCDEF0123456789ABCD'],
      ['a value with a long run of digits', 'KEY_123456789'],
      ['a long unbroken value', 'ABCDEFGHIJKLMNOPQRSTUVWX'],
      ['a value with symbols', 'NAME+WITH/SYMBOLS=='],
      ['nothing', ''],
    ])('sends nothing when a secret reference is %s', async (_why, value) => {
      const { api, calls } = recorder(DRAFT_ANSWER);
      for (const field of ['secretRef', 'webhookSecretRef'])
        expect(
          await runSetupOperation(
            api,
            formOf({ ...draftFields, [field]: value }),
            'setup.config.draft',
          ),
          field,
        ).toEqual({ ok: false, code: 'secret_looks_like_value' });
      expect(calls).toEqual([]);
    });

    it('sends nothing when the two names are the same', async () => {
      const { api, calls } = recorder(DRAFT_ANSWER);
      expect(
        await runSetupOperation(
          api,
          formOf({ ...draftFields, webhookSecretRef: 'LENDER_PSP_ONE' }),
          'setup.config.draft',
        ),
      ).toEqual({ ok: false, code: 'secrets_same' });
      expect(calls).toEqual([]);
    });

    it('does not accept a callback token or a secret value in the form', async () => {
      const { api, calls } = recorder(DRAFT_ANSWER);
      await runSetupOperation(
        api,
        formOf({
          ...draftFields,
          endpointToken: PATH_PART,
          secretValue: 'something-private',
          webhookSecret: 'x',
        }),
        'setup.config.draft',
      );
      expect(JSON.stringify(calls)).not.toMatch(
        /endpointToken|secretValue|webhookSecret"|something-private/,
      );
    });

    it.each([
      [{ provider: 'Sample PSP' }, 'provider_invalid'],
      [{ providerMode: 'live' }, 'provider_mode_invalid'],
      [{ providerMode: '' }, 'provider_mode_invalid'],
      [{ merchantRegistryId: 'nope' }, 'merchant_invalid'],
      [{ settlementAccountId: 'nope' }, 'settlement_account_invalid'],
      [{ lenderId: 'nope' }, 'validation_failed'],
      [{ evidenceRef: 'x' }, 'unsafe_free_text'],
      [{ contractSectionRef: 'Account 1234567890123' }, 'unsafe_free_text'],
    ])('sends nothing for %j', async (change, code) => {
      const { api, calls } = recorder(DRAFT_ANSWER);
      expect(
        await runSetupOperation(api, formOf({ ...draftFields, ...change }), 'setup.config.draft'),
      ).toEqual({ ok: false, code });
      expect(calls).toEqual([]);
    });

    it('needs a source for the limits whenever a limit is given', async () => {
      const { api, calls } = recorder(DRAFT_ANSWER);
      expect(
        await runSetupOperation(
          api,
          formOf({
            ...draftFields,
            rail1: 'upi',
            limit1: 'window',
            kind1: 'text',
            value1: 'next day',
          }),
          'setup.config.draft',
        ),
      ).toEqual({ ok: false, code: 'rail_limits_source_required' });
      expect(calls).toEqual([]);
    });

    it('refuses a source note that carries a long number', async () => {
      const { api, calls } = recorder(DRAFT_ANSWER);
      expect(
        await runSetupOperation(
          api,
          formOf({
            ...draftFields,
            rail1: 'upi',
            limit1: 'window',
            kind1: 'text',
            value1: 'next day',
            railLimitsSource: 'Phone 9876543210 of the manager',
          }),
          'setup.config.draft',
        ),
      ).toEqual({ ok: false, code: 'unsafe_free_text' });
      expect(calls).toEqual([]);
    });

    describe('rail limits', () => {
      const read = (fields: Record<string, string>) => readRailLimits(formOf(fields, false));

      it('reads nothing when no row is filled', () => {
        expect(read({})).toEqual({ ok: true, limits: {} });
        expect(read({ kind1: 'text' })).toEqual({ ok: true, limits: {} });
      });

      it('reads each kind of value', () => {
        expect(
          read({
            rail1: 'upi',
            limit1: 'a1',
            kind1: 'text',
            value1: 'as written',
            rail2: 'upi',
            limit2: 'a2',
            kind2: 'flag',
            value2: 'no',
            rail3: 'upi',
            limit3: 'a3',
            kind3: 'amount',
            value3: '12.5',
            rail4: 'upi',
            limit4: 'a4',
            kind4: 'count',
            value4: '7',
          }),
        ).toEqual({ ok: true, limits: { upi: { a1: 'as written', a2: false, a3: 1250, a4: 7 } } });
      });

      it.each([
        ['a half-filled row', { rail1: 'upi', limit1: 'a1', kind1: 'text' }, 'rail_limits_invalid'],
        ['a row with no rail', { limit1: 'a1', kind1: 'text', value1: 'x' }, 'rail_limits_invalid'],
        ['a row with no kind', { rail1: 'upi', limit1: 'a1', value1: 'x' }, 'rail_limits_invalid'],
        [
          'a repeated limit',
          {
            rail1: 'upi',
            limit1: 'aa',
            kind1: 'text',
            value1: 'x',
            rail2: 'upi',
            limit2: 'aa',
            kind2: 'text',
            value2: 'y',
          },
          'rail_limits_invalid',
        ],
        [
          'a flag that is not yes or no',
          { rail1: 'upi', limit1: 'a1', kind1: 'flag', value1: 'maybe' },
          'limit_value_invalid',
        ],
        [
          'an amount with three decimals',
          { rail1: 'upi', limit1: 'a1', kind1: 'amount', value1: '1.234' },
          'limit_value_invalid',
        ],
        [
          'an amount with a comma',
          { rail1: 'upi', limit1: 'a1', kind1: 'amount', value1: '1,000' },
          'limit_value_invalid',
        ],
        [
          'a count with a decimal',
          { rail1: 'upi', limit1: 'a1', kind1: 'count', value1: '1.5' },
          'limit_value_invalid',
        ],
        [
          'a text over 100 characters',
          { rail1: 'upi', limit1: 'a1', kind1: 'text', value1: 'x'.repeat(101) },
          'limit_value_invalid',
        ],
        [
          'an unknown kind',
          { rail1: 'upi', limit1: 'a1', kind1: 'object', value1: 'x' },
          'limit_value_invalid',
        ],
      ])('refuses %s', (_why, fields, code) => {
        expect(read(fields)).toEqual({ ok: false, code });
      });

      it('lets a name such as "constructor" reach no prototype, and refuses "__proto__" and other odd names', async () => {
        const result = read({
          rail1: 'constructor',
          limit1: 'polluted',
          kind1: 'flag',
          value1: 'yes',
        });
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(Object.hasOwn(result.limits, 'constructor')).toBe(true);
          expect(result.limits.constructor).toEqual({ polluted: true });
        }
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
        expect((Object as unknown as Record<string, unknown>).polluted).toBeUndefined();
        for (const name of ['__proto__', 'Upper', '1abc', 'a', 'has space', 'a-b', 'x'.repeat(42)])
          expect(read({ rail1: name, limit1: 'a1', kind1: 'flag', value1: 'yes' }), name).toEqual({
            ok: false,
            code: 'rail_limits_invalid',
          });
        const { api, calls } = recorder(DRAFT_ANSWER);
        expect(
          await runSetupOperation(
            api,
            formOf({
              ...draftFields,
              rail1: '__proto__',
              limit1: 'polluted',
              kind1: 'flag',
              value1: 'yes',
              railLimitsSource: 'Provider guide, section on limits',
            }),
            'setup.config.draft',
          ),
        ).toEqual({ ok: false, code: 'rail_limits_invalid' });
        expect(calls).toEqual([]);
      });
    });
  });

  describe('submit, decide, withdraw and retire', () => {
    it('submits a configuration by its id', async () => {
      const { api, calls } = recorder();
      expect(
        await runSetupOperation(api, formOf({ op: 'setup.config.submit', id: CONFIG })),
      ).toEqual({ ok: true });
      expect(calls).toEqual([
        { path: `/v1/lender/payment-configs/${CONFIG}/submit`, body: {}, key: REQUEST_ID },
      ]);
    });

    it('approves with or without a note', async () => {
      const { api, calls } = recorder();
      await runSetupOperation(
        api,
        formOf({ op: 'setup.config.decide', id: CONFIG, decision: 'approve' }),
      );
      await runSetupOperation(
        api,
        formOf({
          op: 'setup.config.decide',
          id: CONFIG,
          decision: 'approve',
          note: ' Checked the references. ',
        }),
      );
      expect(calls.map((c) => c.body)).toEqual([
        { approve: true },
        { approve: true, note: 'Checked the references.' },
      ]);
      expect(calls[0]?.path).toBe(`/v1/lender/payment-configs/${CONFIG}/decide`);
    });

    it('rejects only with a note of at least ten characters', async () => {
      const { api, calls } = recorder();
      for (const note of ['', '   ', 'too short'])
        expect(
          await runSetupOperation(
            api,
            formOf({ op: 'setup.config.decide', id: CONFIG, decision: 'reject', note }),
          ),
        ).toEqual({
          ok: false,
          code: 'reason_required',
        });
      expect(calls).toEqual([]);
      expect(
        await runSetupOperation(
          api,
          formOf({
            op: 'setup.config.decide',
            id: CONFIG,
            decision: 'reject',
            note: 'The merchant is not ours.',
          }),
        ),
      ).toEqual({ ok: true });
      expect(calls[0]?.body).toEqual({ approve: false, note: 'The merchant is not ours.' });
    });

    it('refuses a note that carries a long number, and any decision other than approve or reject', async () => {
      const { api, calls } = recorder();
      expect(
        await runSetupOperation(
          api,
          formOf({
            op: 'setup.config.decide',
            id: CONFIG,
            decision: 'approve',
            note: 'Account 1234567890123 is fine',
          }),
        ),
      ).toEqual({ ok: false, code: 'unsafe_free_text' });
      for (const decision of ['', 'maybe', 'APPROVE', 'true'])
        expect(
          await runSetupOperation(api, formOf({ op: 'setup.config.decide', id: CONFIG, decision })),
        ).toEqual({
          ok: false,
          code: 'decision_invalid',
        });
      expect(calls).toEqual([]);
    });

    it.each([
      ['setup.config.withdraw', 'withdraw'],
      ['setup.config.retire', 'retire'],
    ])('%s needs a reason of at least ten characters with no long number', async (op, route) => {
      const { api, calls } = recorder();
      expect(await runSetupOperation(api, formOf({ op, id: CONFIG }))).toEqual({
        ok: false,
        code: 'reason_required',
      });
      expect(await runSetupOperation(api, formOf({ op, id: CONFIG, reason: 'short' }))).toEqual({
        ok: false,
        code: 'reason_invalid',
      });
      expect(
        await runSetupOperation(
          api,
          formOf({ op, id: CONFIG, reason: 'Phone 9876543210 is wrong' }),
        ),
      ).toEqual({ ok: false, code: 'unsafe_free_text' });
      expect(calls).toEqual([]);
      expect(
        await runSetupOperation(
          api,
          formOf({ op, id: CONFIG, reason: ' No longer needed here. ' }),
        ),
      ).toEqual({ ok: true });
      expect(calls).toEqual([
        {
          path: `/v1/lender/payment-configs/${CONFIG}/${route}`,
          body: { reason: 'No longer needed here.' },
          key: REQUEST_ID,
        },
      ]);
    });

    it('refuses an id that is not an id, so nothing odd can be put in a path', async () => {
      const { api, calls } = recorder();
      for (const op of [
        'setup.config.submit',
        'setup.config.decide',
        'setup.config.withdraw',
        'setup.config.retire',
      ])
        for (const id of ['', 'nope', '../../v1/platform/features', `${CONFIG}/extra`])
          expect(
            await runSetupOperation(
              api,
              formOf({ op, id, decision: 'approve', reason: 'A valid reason here' }),
            ),
            `${op} ${id}`,
          ).toEqual({
            ok: false,
            code: 'validation_failed',
          });
      expect(calls).toEqual([]);
    });

    it('never offers suspend, which is the platform’s act', () => {
      expect(Object.keys(SETUP_OPERATIONS).join(' ')).not.toMatch(/suspend/);
    });

    it('reports an API refusal as a short code, never as the text the server sent', async () => {
      const api: OnboardingApi = {
        get: () => Promise.resolve(fail(404, 'not_found')),
        post: () => Promise.resolve(fail(409, 'collection_target_invalid')),
      };
      expect(
        await runSetupOperation(api, formOf({ op: 'setup.config.submit', id: CONFIG })),
      ).toEqual({ ok: false, code: 'collection_target_invalid' });
      const odd: OnboardingApi = {
        get: () => Promise.resolve(fail(404, 'not_found')),
        post: () => Promise.resolve(fail(500, 'SQLSTATE 23505 duplicate key value')),
      };
      expect(
        await runSetupOperation(odd, formOf({ op: 'setup.config.submit', id: CONFIG })),
      ).toEqual({ ok: false, code: 'unknown' });
    });
  });

  describe('where a form may return to', () => {
    it('allows the payment-setup pages, with a short query', () => {
      for (const path of [
        '/payment-setup',
        '/payment-setup?status=draft',
        '/payment-setup/new',
        '/payment-setup/accounts?lenderId=abc',
        '/payment-setup/features',
        `/payment-setup/${CONFIG}`,
      ])
        expect(safeSetupReturnPath(path), path).toBe(path);
    });

    it('sends anything else back to the configurations', () => {
      for (const path of [
        'https://evil.example/payment-setup',
        '//evil.example',
        '/loans',
        '/reminders',
        '/payment-setup/../loans',
        '/payment-setup/other',
        '/payment-setup?x=<script>',
        `/payment-setup/${CONFIG}/extra`,
        'javascript:alert(1)',
        '',
        null,
        undefined,
        42,
      ])
        expect(safeSetupReturnPath(path), String(path)).toBe('/payment-setup');
    });

    it('adds the result as done=1 or a short error code and nothing else', () => {
      expect(setupNoticeUrl('/payment-setup', { ok: true })).toBe('/payment-setup?done=1');
      expect(
        setupNoticeUrl('/payment-setup/accounts?lenderId=abc', {
          ok: false,
          code: 'masked_ref_invalid',
        }),
      ).toBe('/payment-setup/accounts?lenderId=abc&error=masked_ref_invalid');
      expect(
        setupNoticeUrl('/payment-setup?done=1&error=x', { ok: false, code: 'Not A Code!' }),
      ).toBe('/payment-setup?error=unknown');
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('Configurations', () => {
  const view = (
    over: Partial<Parameters<typeof SetupConfigsPage>[0]> = {},
    permissions: readonly string[] = CONFIGURE,
  ) => {
    const ctx = ctxFor(permissions);
    return render(
      <SetupConfigsPage
        lender={ctx.grants[0] ?? null}
        configs={pageOf([config()])}
        providers={providers}
        merchants={merchants}
        settlements={settlements}
        query={{}}
        ctx={ctx}
        {...over}
      />,
    );
  };

  it('shows a configuration in words, with the names of its provider, merchant and settlement account', () => {
    const { container } = view();
    const table = screen.getByRole('table', { name: 'Payment configurations, newest first' });
    const cells = text(within(table).getAllByRole('row')[1] as HTMLElement);
    expect(cells).toContain('Sample Payments Ltd');
    expect(cells).toContain('Production mode');
    expect(cells).toContain('Draft: not submitted for approval yet');
    expect(cells).toContain('SAMPLE-MERCH-01 at Sample Payments Ltd');
    expect(cells).toContain('Collections account, Sample Bank, XXXXXX1234');
    expect(cells).toContain('Not checked yet');
    expect(text(container)).not.toMatch(/sample_psp|pending_approval|production\b(?! mode)/);
  });

  it('labels a mock or sandbox configuration "test only" everywhere it appears and never as live', () => {
    const { container } = view({
      configs: pageOf([
        config({ id: CONFIG, providerMode: 'mock', status: 'active' }),
        config({ id: CONFIG_2, providerMode: 'sandbox', status: 'draft' }),
        config({
          id: '0190a000-0000-7000-8000-000000000a03',
          providerMode: 'production',
          status: 'active',
        }),
      ]),
    });
    const rows = within(screen.getByRole('table')).getAllByRole('row');
    expect(text(rows[1] as HTMLElement)).toContain('Test only: mock provider');
    expect(text(rows[1] as HTMLElement)).toContain('Approved (test only)');
    expect(text(rows[2] as HTMLElement)).toContain('Test only: provider sandbox');
    expect(text(rows[2] as HTMLElement)).toContain('(test only)');
    expect(text(rows[3] as HTMLElement)).not.toMatch(/test only/i);
    expect(text(container)).not.toMatch(/\blive\b/i);
  });

  it('says that approved does not by itself mean payments are switched on', () => {
    const { container } = view();
    expect(text(container)).toMatch(
      /“Approved” does not by itself mean that payments are switched on/,
    );
  });

  it('shows the last check as passed or not passed, in India time', () => {
    view({
      configs: pageOf([
        config({ lastValidatedAt: AT_2, lastValidationOk: true }),
        config({ id: CONFIG_2, lastValidatedAt: AT_2, lastValidationOk: false }),
      ]),
    });
    expect(screen.getByText('17 Oct 2026, 10:00 IST: passed')).toBeTruthy();
    expect(screen.getByText('17 Oct 2026, 10:00 IST: did not pass')).toBeTruthy();
  });

  it('falls back to words, not to a code, when a merchant or an account is not in the list', () => {
    const { container } = view({
      merchants: fail(500),
      settlements: pageOf([]),
      providers: fail(500),
    });
    expect(text(container)).toContain('A merchant not in the list');
    expect(text(container)).toContain('A settlement account not in the list');
  });

  it('says plainly that there is no configuration', () => {
    view({ configs: pageOf([]) });
    expect(screen.getByText('No payment configuration')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('shows a load failure without repeating what the server said', () => {
    const { container } = view({ configs: fail(500, 'SQLSTATE 23505 duplicate key value') });
    expect(screen.getByText('Could not load the configurations')).toBeTruthy();
    expect(text(container)).not.toMatch(/SQLSTATE|23505|duplicate/);
  });

  it('says when the role cannot read payment setup', () => {
    view({ lender: null });
    expect(screen.getByText('You cannot view the payment setup')).toBeTruthy();
  });

  it('shows the result of the last action as words', () => {
    view({ error: 'self_approval' });
    expect(screen.getByRole('alert').textContent).toMatch(/Another person must/);
    cleanup();
    view({ error: 'SQLSTATE 23505' });
    expect(screen.getByRole('alert').textContent).toBe(GENERIC);
    cleanup();
    view({ done: true });
    expect(screen.getByRole('status').textContent).toBe('Your action was recorded.');
  });

  it('links each configuration with a name a screen reader can use, and pages with a cursor', () => {
    view({ configs: pageOf([config()], 'next_cursor_1'), query: { status: 'draft' } });
    expect(
      screen
        .getByRole('link', { name: /Open the configuration drafted 16 Oct 2026, 15:45 IST/ })
        .getAttribute('href'),
    ).toBe(`/payment-setup/${CONFIG}`);
    expect(screen.getByRole('link', { name: 'Older configurations' }).getAttribute('href')).toBe(
      `/payment-setup?lenderId=${LENDER_A}&status=draft&cursor=next_cursor_1`,
    );
  });

  it('asks which lender when the person belongs to several', () => {
    const ctx: SetupContext = {
      ...ctxFor(READ),
      grants: [
        ...grantsFor(READ, LENDER_A, 'Alpha Finance'),
        ...grantsFor(READ, LENDER_B, 'Beta Finance'),
      ],
    };
    render(
      <SetupConfigsPage
        lender={ctx.grants[1] ?? null}
        configs={pageOf([])}
        providers={providers}
        merchants={merchants}
        settlements={settlements}
        query={{}}
        ctx={ctx}
      />,
    );
    const select = screen.getByLabelText<HTMLSelectElement>('Lender');
    expect(select.value).toBe(LENDER_B);
    expect([...select.options].map((o) => o.text)).toEqual(['Alpha Finance', 'Beta Finance']);
  });

  it('has no write form on the list', () => {
    const { container } = view({}, ['payment.read', 'payment.configure', 'payment.config.approve']);
    expect(ops(container)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('New configuration', () => {
  const view = (
    over: Partial<Parameters<typeof SetupNewConfigPage>[0]> = {},
    permissions: readonly string[] = CONFIGURE,
  ) => {
    const ctx = ctxFor(permissions, '/payment-setup/new');
    return render(
      <SetupNewConfigPage
        lender={ctx.grants[0] ?? null}
        providers={providers}
        merchants={merchants}
        settlements={settlements}
        ctx={ctx}
        {...over}
      />,
    );
  };

  it('draws the draft form for a person who may configure payments', () => {
    const { container } = view();
    expect(ops(container)).toEqual(['setup.config.draft']);
    expect(container.querySelector<HTMLInputElement>('input[name="lenderId"]')?.value).toBe(
      LENDER_A,
    );
  });

  it('guards: a person who cannot configure sees no draft form', () => {
    for (const permissions of [READ, APPROVE]) {
      const { container } = view({}, permissions);
      expect(ops(container), permissions.join()).toEqual([]);
      expect(screen.getByText('You cannot draft a configuration')).toBeTruthy();
      cleanup();
    }
    const { container } = view({ lender: null });
    expect(ops(container)).toEqual([]);
  });

  it('starts empty, labels every control and asks for names of secrets, never values', () => {
    const { container } = view();
    expect(screen.getByLabelText<HTMLSelectElement>('Payment provider').value).toBe('');
    expect(screen.getByLabelText<HTMLSelectElement>('Mode').value).toBe('');
    expect(screen.getByLabelText<HTMLSelectElement>('Merchant').value).toBe('');
    expect(screen.getByLabelText<HTMLSelectElement>('Settlement account').value).toBe('');
    const secret = screen.getByLabelText<HTMLInputElement>('Name of the provider secret');
    const signing = screen.getByLabelText<HTMLInputElement>('Name of the callback signing secret');
    for (const input of [secret, signing]) {
      expect(input.value).toBe('');
      expect(input.required).toBe(true);
      expect(input.type).toBe('text');
      expect(input.getAttribute('pattern')).toBe('[A-Z][A-Z0-9_]{2,63}');
    }
    expect(text(container)).toMatch(/Never type the secret itself/);
    expect(text(container)).toMatch(/NAME of the secret in your secrets manager/);
  });

  it('offers production, sandbox and mock and labels the two test modes', () => {
    view();
    const mode = screen.getByLabelText<HTMLSelectElement>('Mode');
    expect([...mode.options].map((o) => o.text)).toEqual([
      'Choose a mode',
      'Production mode',
      'Test only: provider sandbox',
      'Test only: mock provider',
    ]);
  });

  it('names merchants and accounts with their verification, and shows only masked account references', () => {
    const { container } = view({
      merchants: pageOf([
        merchant(),
        merchant({
          id: MERCHANT_2,
          merchantRef: 'SAMPLE-MERCH-02',
          verificationStatus: 'unverified',
          verifiedAt: null,
        }),
        merchant({ id: '0190a000-0000-7000-8000-000000000b03', status: 'revoked' }),
      ]),
      settlements: pageOf([
        settlement(),
        settlement({
          id: SETTLEMENT_2,
          status: 'unverified',
          registryId: null,
          maskedRef: 'XXXXXX9876',
        }),
        settlement({ id: '0190a000-0000-7000-8000-000000000c03', status: 'revoked' }),
      ]),
    });
    const merchantSelect = screen.getByLabelText<HTMLSelectElement>('Merchant');
    expect([...merchantSelect.options].map((o) => o.text)).toEqual([
      'Choose a merchant',
      'SAMPLE-MERCH-01 at Sample Payments Ltd (verified)',
      'SAMPLE-MERCH-02 at Sample Payments Ltd (not verified yet)',
    ]);
    const accountSelect = screen.getByLabelText<HTMLSelectElement>('Settlement account');
    expect([...accountSelect.options].map((o) => o.text)).toEqual([
      'Choose a settlement account',
      'Collections account, Sample Bank, XXXXXX1234 (verified)',
      'Collections account, Sample Bank, XXXXXX9876 (not verified yet)',
    ]);
    expect(text(container)).not.toMatch(/\d{7,}/);
  });

  it('has no field for an account number, an IFSC code or a secret value', () => {
    const { container } = view();
    const names = [...container.querySelectorAll<HTMLInputElement>('input, select, textarea')].map(
      (i) => i.name,
    );
    for (const name of names)
      expect(name, name).not.toMatch(/accountNumber|ifsc|password|secretValue|token/i);
  });

  it('says what is missing before a configuration can be drafted', () => {
    view({ merchants: pageOf([]) });
    expect(screen.getByText('Not ready to draft yet')).toBeTruthy();
    expect(screen.queryByLabelText('Merchant')).toBeNull();
    cleanup();
    view({ providers: ok({ items: [] }) });
    expect(screen.getByText('Not ready to draft yet')).toBeTruthy();
    cleanup();
    view({ settlements: pageOf([settlement({ status: 'revoked' })]) });
    expect(screen.getByText('Not ready to draft yet')).toBeTruthy();
  });

  it('shows a failure to load the choices without server text', () => {
    const { container } = view({ providers: fail(500, 'SQLSTATE 23505') });
    expect(screen.getByText('Could not load the choices for a configuration')).toBeTruthy();
    expect(text(container)).not.toContain('23505');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('One configuration', () => {
  const view = (
    over: {
      config?: Parameters<typeof SetupConfigDetailPage>[0]['config'];
      history?: Parameters<typeof SetupConfigDetailPage>[0]['history'];
      userId?: string;
      done?: boolean;
      error?: string;
    } = {},
    permissions: readonly string[] = CONFIGURE,
  ) => {
    const ctx = ctxFor(permissions, `/payment-setup/${CONFIG}`, over.userId ?? ME);
    return render(
      <SetupConfigDetailPage
        config={over.config ?? ok(config())}
        history={over.history ?? history}
        providers={providers}
        merchants={merchants}
        settlements={settlements}
        ctx={ctx}
        done={over.done}
        error={over.error}
      />,
    );
  };

  it('shows the configuration in words, with the secret names as names only', () => {
    const { container } = view();
    expect(text(container)).toContain('Sample Payments Ltd');
    expect(text(container)).toContain('Production mode');
    expect(text(container)).toContain('LENDER_PSP_ONE');
    expect(text(container)).toContain('LENDER_PSP_TWO');
    expect(text(container)).toMatch(/Udofin never shows or stores the secrets they name/);
    expect(text(container)).toContain('Onboarding mail ref 7');
    expect(text(container)).toContain('Agreement clause 4');
    expect(text(container)).toContain(`By another person (ID ${OTHER}) on 16 Oct 2026, 15:45 IST`);
    expect(text(container)).toContain('Not submitted');
    expect(text(container)).toContain('Not approved');
  });

  it('shows the rail limits as recorded with their source, numbers as stored', () => {
    view();
    const table = screen.getByRole('table', { name: 'Rail limits as recorded' });
    const rows = within(table)
      .getAllByRole('row')
      .map((r) => text(r));
    expect(rows.join('|')).toContain('upiper_payment_max10000000');
    expect(rows.join('|')).toContain('upineeds_promptYes');
    expect(rows.join('|')).toContain('upiwindownext day');
    expect(
      screen.getByText(/Numbers are shown as stored. An amount is stored in paise/),
    ).toBeTruthy();
    expect(screen.getByText(/Provider guide, section on limits/)).toBeTruthy();
  });

  it('says plainly when no limit or source was recorded', () => {
    view({ config: ok(config({ railLimits: {}, railLimitsSource: null })) });
    expect(screen.getByText('No rail limit was recorded.')).toBeTruthy();
  });

  it('says a test configuration is test only', () => {
    const { container } = view({ config: ok(config({ providerMode: 'mock', status: 'active' })) });
    expect(screen.getByText('Test only.')).toBeTruthy();
    expect(text(container)).toContain('It is never a live payment setup.');
    expect(text(container)).toContain('Approved (test only)');
  });

  it('does not say test only for a production configuration', () => {
    const { container } = view();
    expect(text(container)).not.toMatch(/test only/i);
  });

  it('gives the reasons a configuration is not in use in words', () => {
    const { container } = view({
      config: ok(
        config({
          status: 'suspended',
          statusReason: 'system hold: validation failed',
          statusReasons: [
            'settlement_account_not_verified',
            'merchant_not_active',
            'destination_account_revoked',
            'brand_new_code',
          ],
        }),
      ),
    });
    expect(text(container)).toContain('Why it is not in use');
    expect(text(container)).toContain('The settlement account is not verified.');
    expect(text(container)).toContain('The merchant is not active.');
    expect(text(container)).toContain(
      'The account registry does not accept the settlement account for repayments.',
    );
    expect(text(container)).toContain('A check did not pass. This screen has no wording for it.');
    // Neither a code nor the free text the system wrote reaches the screen.
    expect(text(container)).not.toMatch(
      /settlement_account_not_verified|brand_new_code|system hold/,
    );
  });

  it('shows the history in words', () => {
    const { container } = view({
      history: ok({
        items: [
          event(),
          event({
            id: '0190a000-0000-7000-8000-000000000e02',
            eventKind: 'suspended',
            fromStatus: 'active',
            toStatus: 'suspended',
            actorKind: 'system',
            occurredAt: AT_2,
            reasons: ['platform_suspension'],
          }),
        ],
      }),
    });
    const table = screen.getByRole('table', { name: 'Changes, oldest first' });
    const rows = within(table).getAllByRole('row');
    expect(text(rows[1] as HTMLElement)).toContain('Drafted');
    expect(text(rows[1] as HTMLElement)).toContain('Your organisation');
    expect(text(rows[2] as HTMLElement)).toContain('Suspended (from approved to suspended)');
    expect(text(rows[2] as HTMLElement)).toContain('The system');
    expect(text(rows[2] as HTMLElement)).toContain('The platform team suspended it.');
    expect(text(container)).not.toMatch(/platform_suspension|eventKind/);
  });

  it('says when the history cannot be loaded, or the configuration is not found', () => {
    view({ history: fail(500, 'SQLSTATE 23505') });
    expect(screen.getByText('Could not load the history')).toBeTruthy();
    cleanup();
    view({ config: fail(404, 'not_found') });
    expect(screen.getByText('Configuration not found')).toBeTruthy();
    cleanup();
    const { container } = view({ config: fail(500, 'SQLSTATE 23505') });
    expect(screen.getByText('Could not load the configuration')).toBeTruthy();
    expect(text(container)).not.toContain('23505');
  });

  describe('guards', () => {
    it('a read-only role sees no write form at all', () => {
      for (const status of ['draft', 'pending_approval', 'active', 'suspended']) {
        const { container } = view({ config: ok(config({ status, submittedBy: THIRD })) }, READ);
        expect(ops(container), status).toEqual([]);
        cleanup();
      }
    });

    it('a person who configures can submit a draft and withdraw it, but not decide or retire', () => {
      const { container } = view({ config: ok(config()) }, CONFIGURE);
      expect(ops(container).sort()).toEqual(['setup.config.submit', 'setup.config.withdraw']);
    });

    it('a person who configures can submit a suspended configuration again, but cannot withdraw it', () => {
      const { container } = view({ config: ok(config({ status: 'suspended' })) }, CONFIGURE);
      expect(ops(container)).toEqual(['setup.config.submit']);
    });

    it('draws decide for an approver who neither drafted nor submitted the configuration, with two plainly named buttons', () => {
      const { container } = view(
        {
          config: ok(config({ status: 'pending_approval', submittedBy: THIRD, submittedAt: AT_2 })),
        },
        APPROVE,
      );
      expect(ops(container)).toEqual(['setup.config.decide']);
      const form = container.querySelector('input[name="op"]')?.closest('form') as HTMLFormElement;
      const approve = within(form).getByRole<HTMLButtonElement>('button', {
        name: 'Approve this configuration',
      });
      const reject = within(form).getByRole<HTMLButtonElement>('button', {
        name: 'Reject this configuration',
      });
      expect([approve.name, approve.value]).toEqual(['decision', 'approve']);
      expect([reject.name, reject.value]).toEqual(['decision', 'reject']);
      expect(within(form).getByLabelText<HTMLTextAreaElement>('Note').value).toBe('');
      expect(form.querySelector<HTMLInputElement>('input[name="id"]')?.value).toBe(CONFIG);
    });

    it('never draws decide for the person who drafted the configuration', () => {
      const { container } = view(
        { config: ok(config({ status: 'pending_approval', draftedBy: ME, submittedBy: THIRD })) },
        APPROVE,
      );
      expect(ops(container)).toEqual([]);
      expect(
        screen.getByText(
          'You drafted or submitted this configuration, so another person must decide it.',
        ),
      ).toBeTruthy();
    });

    it('never draws decide for the person who submitted the configuration', () => {
      const { container } = view(
        { config: ok(config({ status: 'pending_approval', draftedBy: OTHER, submittedBy: ME })) },
        APPROVE,
      );
      expect(ops(container)).toEqual([]);
      expect(
        screen.getByText(
          'You drafted or submitted this configuration, so another person must decide it.',
        ),
      ).toBeTruthy();
    });

    it('does not draw decide without the approve permission, or for a configuration that is not waiting', () => {
      expect(
        ops(
          view(
            { config: ok(config({ status: 'pending_approval', submittedBy: THIRD })) },
            CONFIGURE,
          ).container,
        ),
      ).toEqual(['setup.config.withdraw']);
      cleanup();
      for (const status of ['draft', 'active', 'suspended', 'retired']) {
        const { container } = view({ config: ok(config({ status })) }, APPROVE);
        expect(ops(container), status).not.toContain('setup.config.decide');
        cleanup();
      }
    });

    it('draws retire for the lender approver on an approved or suspended configuration only', () => {
      for (const status of ['active', 'suspended']) {
        const { container } = view({ config: ok(config({ status })) }, APPROVE);
        expect(ops(container), status).toEqual(['setup.config.retire']);
        cleanup();
      }
      for (const status of ['draft', 'pending_approval', 'retired']) {
        const { container } = view({ config: ok(config({ status, submittedBy: THIRD })) }, APPROVE);
        expect(ops(container), status).not.toContain('setup.config.retire');
        cleanup();
      }
      expect(ops(view({ config: ok(config({ status: 'active' })) }, CONFIGURE).container)).toEqual(
        [],
      );
    });

    it('draws nothing for a person with rights in another lender only', () => {
      const ctx: SetupContext = {
        ...ctxFor(READ),
        grants: [
          ...grantsFor(READ, LENDER_A),
          ...grantsFor(
            ['payment.read', 'payment.configure', 'payment.config.approve'],
            LENDER_B,
            'Other',
          ),
        ],
      };
      const { container } = render(
        <SetupConfigDetailPage
          config={ok(config())}
          history={history}
          providers={providers}
          merchants={merchants}
          settlements={settlements}
          ctx={ctx}
        />,
      );
      expect(ops(container)).toEqual([]);
    });

    it('says only the platform team can suspend, and draws no suspend form', () => {
      const { container } = view({ config: ok(config({ status: 'active' })) }, APPROVE);
      expect(text(container)).toMatch(/Only the platform team can suspend a configuration/);
      expect(ops(container).join()).not.toMatch(/suspend/);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('Merchants and settlement accounts', () => {
  const view = (
    over: Partial<Parameters<typeof SetupAccountsPage>[0]> = {},
    permissions: readonly string[] = CONFIGURE,
  ) => {
    const ctx = ctxFor(permissions, '/payment-setup/accounts');
    return render(
      <SetupAccountsPage
        lender={ctx.grants[0] ?? null}
        providers={providers}
        merchants={merchants}
        settlements={settlements}
        registry={ok({ items: [registryRow()] })}
        ctx={ctx}
        {...over}
      />,
    );
  };

  it('shows merchants with their claim and verification status in words', () => {
    const { container } = view({
      merchants: pageOf([
        merchant(),
        merchant({
          id: MERCHANT_2,
          merchantRef: 'SAMPLE-MERCH-02',
          verificationStatus: 'unverified',
          verifiedAt: null,
        }),
        merchant({
          id: '0190a000-0000-7000-8000-000000000b03',
          merchantRef: 'SAMPLE-MERCH-03',
          status: 'revoked',
          revokedAt: AT_2,
          revokedReason: 'x',
        }),
      ]),
    });
    const rows = within(screen.getByRole('table', { name: 'Merchants' })).getAllByRole('row');
    expect(text(rows[1] as HTMLElement)).toContain('Verified by the platform team');
    expect(text(rows[2] as HTMLElement)).toContain('Not verified yet');
    expect(text(rows[3] as HTMLElement)).toContain('Revoked: it cannot be used');
    expect(text(container)).not.toMatch(/verification_status|ownerKind|verificationStatus/);
  });

  it('shows settlement accounts by masked reference only', () => {
    const { container } = view({
      settlements: pageOf([
        settlement(),
        settlement({
          id: SETTLEMENT_2,
          label: 'Second account',
          maskedRef: '****9876',
          status: 'unverified',
          registryId: null,
        }),
      ]),
    });
    const rows = within(screen.getByRole('table', { name: 'Settlement accounts' })).getAllByRole(
      'row',
    );
    expect(text(rows[1] as HTMLElement)).toContain('XXXXXX1234');
    expect(text(rows[1] as HTMLElement)).toContain('Linked to the account registry');
    expect(text(rows[2] as HTMLElement)).toContain('****9876');
    expect(text(rows[2] as HTMLElement)).toContain(
      'Requested: waiting for the platform team to verify it',
    );
    expect(text(rows[2] as HTMLElement)).toContain('Not linked to the account registry yet');
    expect(text(container)).not.toMatch(/\d{5,}/);
  });

  it('shows the registry status: the masked reference, the status and whether it can be used now', () => {
    view({
      registry: ok({
        items: [
          registryRow(),
          registryRow({
            settlementAccountId: SETTLEMENT_2,
            maskedRef: 'XXXXXX9876',
            verificationStatus: 'revoked',
            effectiveTo: '2026-12-31',
            usable: false,
          }),
        ],
      }),
    });
    const rows = within(
      screen.getByRole('table', { name: 'Registry status of your settlement accounts' }),
    ).getAllByRole('row');
    expect(text(rows[1] as HTMLElement)).toContain('Verified in the account registry');
    expect(text(rows[1] as HTMLElement)).toContain('1 Oct 2026');
    expect(text(rows[1] as HTMLElement)).toContain('Yes, as the registry reports');
    expect(text(rows[2] as HTMLElement)).toContain('Revoked in the account registry');
    expect(text(rows[2] as HTMLElement)).toContain('31 Dec 2026');
    expect(text(rows[2] as HTMLElement)).toContain('No');
    // The registry row for an account the list does not name still reads in words.
    expect(text(rows[2] as HTMLElement)).toContain('A settlement account');
  });

  it('says when nothing is linked yet, and when the role cannot read the registry', () => {
    view({ registry: ok({ items: [] }) });
    expect(screen.getByText('Nothing linked yet')).toBeTruthy();
    cleanup();
    view({ registry: fail(403, 'forbidden') });
    expect(screen.getByText('You cannot view the registry status')).toBeTruthy();
  });

  it('says plainly when there is no merchant or no settlement account', () => {
    view({ merchants: pageOf([]), settlements: pageOf([]) });
    expect(screen.getByText('No merchant')).toBeTruthy();
    expect(screen.getByText('No settlement account')).toBeTruthy();
  });

  it('shows load failures without server text', () => {
    const { container } = view({
      merchants: fail(500, 'SQLSTATE 23505'),
      settlements: fail(500, 'SQLSTATE 42P01'),
      registry: fail(500, 'x'),
    });
    expect(screen.getByText('Could not load the merchants')).toBeTruthy();
    expect(screen.getByText('Could not load the settlement accounts')).toBeTruthy();
    expect(screen.getByText('Could not load the registry status')).toBeTruthy();
    expect(text(container)).not.toMatch(/SQLSTATE|23505|42P01/);
  });

  describe('guards', () => {
    it('a person who configures sees the claim form and the request form', () => {
      const { container } = view();
      expect(ops(container).sort()).toEqual(['setup.merchant.claim', 'setup.settlement.request']);
    });

    it('a read-only role and an approver see no write form', () => {
      for (const permissions of [READ, APPROVE]) {
        const { container } = view({}, permissions);
        expect(ops(container), permissions.join()).toEqual([]);
        cleanup();
      }
    });

    it('draws nothing for a person with no lender', () => {
      const { container } = view({ lender: null });
      expect(ops(container)).toEqual([]);
      expect(
        screen.getByText('You cannot view the merchants and settlement accounts'),
      ).toBeTruthy();
    });

    it('says no provider is available when the register gave none', () => {
      const { container } = view({ providers: ok({ items: [] }) });
      expect(ops(container)).toEqual(['setup.settlement.request']);
      expect(text(container)).toMatch(/No provider is available to claim a merchant at yet/);
    });
  });

  it('says it never takes a full account number, and has no field for one', () => {
    const { container } = view();
    expect(text(container)).toMatch(
      /Never type the full account number: this form does not accept it/,
    );
    const masked = screen.getByLabelText<HTMLInputElement>('Masked account reference');
    expect(masked.getAttribute('pattern')).toBe('[X*]{2,}[0-9]{2,4}');
    expect(masked.required).toBe(true);
    expect(masked.value).toBe('');
    for (const input of container.querySelectorAll<HTMLInputElement>('input, select, textarea'))
      expect(input.name).not.toMatch(/accountNumber|ifsc|number/i);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('Features (read only)', () => {
  const view = (
    items = [feature()],
    permissions: readonly string[] = CONFIGURE,
    features?: Parameters<typeof SetupFeaturesPage>[0]['features'],
  ) => {
    const ctx = ctxFor(permissions, '/payment-setup/features');
    return render(
      <SetupFeaturesPage
        lender={ctx.grants[0] ?? null}
        features={features ?? ok({ items })}
        ctx={ctx}
      />,
    );
  };

  it('says the switches are read-only and only the platform team changes them', () => {
    const { container } = view();
    expect(text(container)).toMatch(/These switches are read-only/);
    expect(text(container)).toMatch(/Only the platform team can change them/);
  });

  it('says what is true about people: two to switch on, one may switch off in an emergency', () => {
    const { container } = view();
    const words = text(container);
    expect(words).toMatch(/Switching a feature on takes two platform people/);
    expect(words).toMatch(
      /The platform team can switch a feature off with one person, at once, in an emergency/,
    );
    expect(words).toMatch(/switching it on again then needs a new two-person request/);
    expect(words).toMatch(/Every change is kept in the platform’s history/);
    // The old sentence told lenders that no feature can be removed without a second person.
    expect(words).not.toMatch(/it takes two people/);
  });

  it('has no write form for anybody', () => {
    for (const permissions of [
      READ,
      CONFIGURE,
      APPROVE,
      ['payment.read', 'payment.configure', 'payment.config.approve'],
    ]) {
      const { container } = view([feature(), feature({ feature: 'reminders' })], permissions);
      expect(ops(container)).toEqual([]);
      expect(container.querySelectorAll('button[type="submit"]:not(.secondary)').length).toBe(0);
      cleanup();
    }
  });

  it('gives the reason a switch is off, in words', () => {
    const { container } = view([
      feature({ feature: 'payments' }),
      feature({ feature: 'mandates', disabledAt: AT_2 }),
      feature({ feature: 'collections', enableable: false }),
      feature({ feature: 'dlg', enableable: false }),
    ]);
    const rows = within(
      screen.getByRole('table', { name: 'Feature switches for this lender' }),
    ).getAllByRole('row');
    expect(text(rows[1] as HTMLElement)).toContain(
      'Off. It has not been switched on for your organisation.',
    );
    expect(text(rows[2] as HTMLElement)).toContain(
      'Off. It was switched off on 17 Oct 2026, 10:00 IST.',
    );
    expect(text(rows[3] as HTMLElement)).toContain(
      'Off. This feature cannot be switched on at present.',
    );
    expect(text(rows[4] as HTMLElement)).toContain(
      'This feature cannot be switched on at present.',
    );
    expect(text(container)).not.toMatch(/Phase 08|migration|locked_reason|enableable/);
  });

  it('says on means the stored switch, not that the feature works for borrowers', () => {
    const { container } = view([feature({ feature: 'reminders', enabled: true, enabledAt: AT_2 })]);
    expect(text(container)).toContain('On since 17 Oct 2026, 10:00 IST.');
    expect(text(container)).toMatch(
      /It does not by itself show that the feature is working for your borrowers/,
    );
  });

  it('names each feature in words', () => {
    view([feature({ feature: 'servicing_sync' }), feature({ feature: 'statements_noc' })]);
    expect(screen.getByText('Servicing sync (loan data from your lender system)')).toBeTruthy();
    expect(screen.getByText('Statements, foreclosure quotations and no-dues letters')).toBeTruthy();
  });

  it('says plainly when nothing was reported, and shows failures without server text', () => {
    view([]);
    expect(screen.getByText('No feature')).toBeTruthy();
    cleanup();
    const { container } = view([], CONFIGURE, fail(500, 'SQLSTATE 23505'));
    expect(screen.getByText('Could not load the features')).toBeTruthy();
    expect(text(container)).not.toContain('23505');
    cleanup();
    render(
      <SetupFeaturesPage lender={null} features={fail(403, 'forbidden')} ctx={ctxFor(READ)} />,
    );
    expect(screen.getByText('You cannot view the features')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('the callback token is shown once', () => {
  const user = () => userEvent.setup();

  const fillDraft = async (u: ReturnType<typeof user>) => {
    await u.selectOptions(screen.getByLabelText('Payment provider'), 'sample_psp');
    await u.selectOptions(screen.getByLabelText('Mode'), 'sandbox');
    await u.selectOptions(screen.getByLabelText('Merchant'), MERCHANT);
    await u.selectOptions(screen.getByLabelText('Settlement account'), SETTLEMENT);
    await u.type(screen.getByLabelText('Name of the provider secret'), 'LENDER_PSP_ONE');
    await u.type(screen.getByLabelText('Name of the callback signing secret'), 'LENDER_PSP_TWO');
  };

  const draftForm = (action: Parameters<typeof ConfigDraftForm>[0]['action']) =>
    render(
      <ConfigDraftForm
        lenderId={LENDER_A}
        action={action}
        returnTo="/payment-setup/new"
        providers={[{ value: 'sample_psp', label: 'Sample Payments Ltd' }]}
        merchants={[
          { value: MERCHANT, label: 'SAMPLE-MERCH-01 at Sample Payments Ltd (verified)' },
        ]}
        settlementAccounts={[
          { value: SETTLEMENT, label: 'Collections account, Sample Bank, XXXXXX1234 (verified)' },
        ]}
      />,
    );

  const drafted = { id: CONFIG, endpointToken: PATH_PART, callbackPath: CALLBACK_PATH };

  it('shows the callback path with a clear notice that it is shown only once', async () => {
    const action = vi.fn(() => Promise.resolve({ ok: true as const, result: drafted }));
    const u = user();
    const { container } = draftForm(action);
    await fillDraft(u);
    await u.click(screen.getByRole('button', { name: 'Save as a draft' }));
    const heading = await screen.findByRole('heading', { name: /shown only once/i });
    const section = heading.closest('section') as HTMLElement;
    expect(within(section).getByText(CALLBACK_PATH)).toBeTruthy();
    expect(text(section)).toMatch(/This is shown only once/);
    expect(text(section)).toMatch(/it cannot be shown again/);
    expect(text(section)).toMatch(
      /If you lose it, withdraw this draft and draft a new configuration/,
    );
    expect(text(section)).toMatch(/The address of the callback service is not shown on this page/);
    expect(within(section).getByRole('button', { name: 'Copy the callback path' })).toBeTruthy();
    // The token section and the saved message are separate renders: wait for the message instead of assuming it came with the heading.
    await waitFor(() => expect(text(container)).toContain('The draft was saved.'));
    const sent = (action.mock.calls[0] as unknown as [FormData])[0];
    expect(sent.get('op')).toBe('setup.config.draft');
    expect(sent.get('lenderId')).toBe(LENDER_A);
    expect(sent.get('provider')).toBe('sample_psp');
    expect(sent.get('providerMode')).toBe('sandbox');
    expect(sent.get('secretRef')).toBe('LENDER_PSP_ONE');
    expect(sent.get('key')).toMatch(/^ui-[0-9a-f-]{36}$/);
  });

  it('copies the callback path to the clipboard and says so', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    render(<OneTimeToken drafted={drafted} clear={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy the callback path' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Copied.'));
    expect(writeText).toHaveBeenCalledWith(CALLBACK_PATH);
  });

  it('says plainly when copying did not work', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: () => Promise.reject(new Error('blocked')) },
    });
    render(<OneTimeToken drafted={drafted} clear={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy the callback path' }));
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toMatch(/Copying did not work here/),
    );
    cleanup();
    vi.stubGlobal('navigator', {});
    render(<OneTimeToken drafted={drafted} clear={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy the callback path' }));
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toMatch(/Copying did not work here/),
    );
  });

  it('removes the path from the page when the person says they copied it, and it does not come back', async () => {
    const action = vi.fn(() => Promise.resolve({ ok: true as const, result: drafted }));
    const u = user();
    const { container } = draftForm(action);
    await fillDraft(u);
    await u.click(screen.getByRole('button', { name: 'Save as a draft' }));
    await screen.findByText(CALLBACK_PATH);
    await u.click(
      screen.getByRole('button', { name: 'I have copied it: remove it from this page' }),
    );
    expect(screen.queryByText(CALLBACK_PATH)).toBeNull();
    expect(container.innerHTML).not.toContain(PATH_PART);
    expect(screen.queryByRole('button', { name: 'Copy the callback path' })).toBeNull();
  });

  it('keeps the token out of the address, the cookies, the storage and every attribute', async () => {
    const action = vi.fn(() => Promise.resolve({ ok: true as const, result: drafted }));
    const u = user();
    const { container } = draftForm(action);
    await fillDraft(u);
    await u.click(screen.getByRole('button', { name: 'Save as a draft' }));
    await screen.findByText(CALLBACK_PATH);
    expect(window.location.href).not.toContain(PATH_PART);
    expect(document.cookie).not.toContain(PATH_PART);
    expect(JSON.stringify({ ...window.localStorage })).not.toContain(PATH_PART);
    expect(JSON.stringify({ ...window.sessionStorage })).not.toContain(PATH_PART);
    for (const el of container.querySelectorAll('*'))
      for (const attr of el.getAttributeNames())
        expect(el.getAttribute(attr) ?? '', `${el.tagName} ${attr}`).not.toContain(PATH_PART);
    for (const input of container.querySelectorAll<HTMLInputElement>('input, textarea'))
      expect(input.value).not.toContain(PATH_PART);
    // It appears exactly once in the text of the page.
    expect(text(container).split(PATH_PART)).toHaveLength(2);
  });

  it('does not show a token after a refusal, and takes an earlier one off the page when the person tries again', async () => {
    const answers = [
      { ok: true as const, result: drafted },
      { ok: false as const, code: 'secret_ref_invalid' },
    ];
    const action = vi.fn(() =>
      Promise.resolve(answers.shift() ?? { ok: false as const, code: 'validation_failed' }),
    );
    const u = user();
    const { container } = draftForm(action);
    await fillDraft(u);
    await u.click(screen.getByRole('button', { name: 'Save as a draft' }));
    await screen.findByText(CALLBACK_PATH);
    // The form is empty again after a success, so it is filled in again. The token appears before the form is cleared: wait for the
    // clearing, or the refill can be wiped by it and the second submission never happens.
    await waitFor(() =>
      expect(screen.getByLabelText<HTMLInputElement>('Name of the provider secret').value).toBe(''),
    );
    await fillDraft(u);
    await u.click(screen.getByRole('button', { name: 'Save as a draft' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/NAME of a secret/);
    expect(container.innerHTML).not.toContain(PATH_PART);
  });

  it('keeps what was typed after a refusal, except nothing secret is ever in the form', async () => {
    const action = vi.fn(() =>
      Promise.resolve({ ok: false as const, code: 'mock_provider_blocked' }),
    );
    const u = user();
    draftForm(action);
    await fillDraft(u);
    await u.click(screen.getByRole('button', { name: 'Save as a draft' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'A mock provider is not allowed in this environment.',
    );
    await waitFor(() =>
      expect(screen.getByLabelText<HTMLInputElement>('Name of the provider secret').value).toBe(
        'LENDER_PSP_ONE',
      ),
    );
    expect(screen.getByLabelText<HTMLSelectElement>('Mode').value).toBe('sandbox');
  });

  it('draws eight rail-limit rows, each labelled, with the source required when a limit is given', () => {
    const { container } = draftForm(vi.fn(() => Promise.resolve({ ok: true as const })));
    expect(container.querySelectorAll('fieldset fieldset')).toHaveLength(8);
    expect(screen.getAllByLabelText('Rail')).toHaveLength(8);
    expect(screen.getAllByLabelText('Limit name')).toHaveLength(8);
    expect(screen.getAllByLabelText('Kind of value')).toHaveLength(8);
    expect(screen.getAllByLabelText('Value')).toHaveLength(8);
    expect(screen.getByLabelText('Source of the limits (document name and section)')).toBeTruthy();
    expect(text(container)).toMatch(/none is suggested/);
    for (const value of container.querySelectorAll<HTMLInputElement>(
      'input[name^="value"], input[name^="rail"], input[name^="limit"]',
    ))
      expect(value.value).toBe('');
  });
});

describe('the settlement account request and the merchant claim forms', () => {
  it('sends the masked reference the person typed, with a fresh key each time', async () => {
    const seen: FormData[] = [];
    const action = vi.fn((form: FormData) => {
      seen.push(form);
      return Promise.resolve({ ok: false as const, code: 'settlement_account_invalid' });
    });
    const u = userEvent.setup();
    render(
      <SettlementRequestForm
        lenderId={LENDER_A}
        action={action}
        returnTo="/payment-setup/accounts"
      />,
    );
    await u.type(screen.getByLabelText('A name for the account'), 'Collections account');
    await u.type(screen.getByLabelText('Bank name'), 'Sample Bank');
    await u.type(screen.getByLabelText('Masked account reference'), 'XXXXXX1234');
    await u.click(screen.getByRole('button', { name: 'Request this settlement account' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /Check the label, the bank name and the masked reference/,
    );
    await waitFor(() =>
      expect(screen.getByLabelText<HTMLInputElement>('Masked account reference').value).toBe(
        'XXXXXX1234',
      ),
    );
    await u.click(screen.getByRole('button', { name: 'Request this settlement account' }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(2));
    expect(seen[0]?.get('op')).toBe('setup.settlement.request');
    expect(seen[0]?.get('maskedRef')).toBe('XXXXXX1234');
    expect(seen[0]?.get('lenderId')).toBe(LENDER_A);
    expect(seen[0]?.get('key')).not.toBe(seen[1]?.get('key'));
  });

  it('does not let a full account number leave the browser: the shape check stops it', async () => {
    const action = vi.fn(() => Promise.resolve({ ok: true as const }));
    const u = userEvent.setup();
    render(
      <SettlementRequestForm
        lenderId={LENDER_A}
        action={action}
        returnTo="/payment-setup/accounts"
      />,
    );
    await u.type(screen.getByLabelText('A name for the account'), 'Collections account');
    await u.type(screen.getByLabelText('Bank name'), 'Sample Bank');
    const masked = screen.getByLabelText<HTMLInputElement>('Masked account reference');
    await u.type(masked, '123456789012');
    expect(masked.validity.patternMismatch).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Request this settlement account' }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(action).not.toHaveBeenCalled();
  });

  it('sends a merchant claim and shows an error as a sentence', async () => {
    const action = vi.fn(() =>
      Promise.resolve({ ok: false as const, code: 'merchant_already_claimed' }),
    );
    const u = userEvent.setup();
    render(
      <MerchantClaimForm
        lenderId={LENDER_A}
        action={action}
        returnTo="/payment-setup/accounts"
        providers={[{ value: 'sample_psp', label: 'Sample Payments Ltd' }]}
      />,
    );
    await u.selectOptions(screen.getByLabelText('Payment provider'), 'sample_psp');
    await u.type(screen.getByLabelText('Merchant identifier at the provider'), 'SAMPLE-MERCH-01');
    await u.click(screen.getByRole('button', { name: 'Claim this merchant' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'That merchant identifier is already claimed.',
    );
    const sent = (action.mock.calls[0] as unknown as [FormData])[0];
    expect(sent.get('op')).toBe('setup.merchant.claim');
    expect(sent.get('merchantRef')).toBe('SAMPLE-MERCH-01');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('across every page', () => {
  const everyPage = () => {
    const all = ctxFor(
      ['payment.read', 'payment.configure', 'payment.config.approve'],
      '/payment-setup',
    );
    const lender = all.grants[0] ?? null;
    const pending = config({ status: 'pending_approval', submittedBy: THIRD, submittedAt: AT_2 });
    return [
      render(
        <SetupConfigsPage
          lender={lender}
          configs={pageOf([
            config(),
            config({ id: CONFIG_2, providerMode: 'mock', status: 'active' }),
          ])}
          providers={providers}
          merchants={merchants}
          settlements={settlements}
          query={{}}
          ctx={all}
        />,
      ),
      render(
        <SetupNewConfigPage
          lender={lender}
          providers={providers}
          merchants={merchants}
          settlements={settlements}
          ctx={all}
        />,
      ),
      ...[
        config(),
        pending,
        config({ status: 'active' }),
        config({ status: 'suspended', statusReasons: ['merchant_not_active'] }),
      ].map((c) =>
        render(
          <SetupConfigDetailPage
            config={ok(c)}
            history={history}
            providers={providers}
            merchants={merchants}
            settlements={settlements}
            ctx={all}
          />,
        ),
      ),
      render(
        <SetupAccountsPage
          lender={lender}
          providers={providers}
          merchants={merchants}
          settlements={settlements}
          registry={ok({ items: [registryRow()] })}
          ctx={all}
        />,
      ),
      render(
        <SetupFeaturesPage
          lender={lender}
          features={ok({
            items: [feature(), feature({ feature: 'collections', enableable: false })],
          })}
          ctx={all}
        />,
      ),
    ];
  };

  it('draws only operations that are on the allow-list, and draws every operation on it somewhere', () => {
    const drawn = new Set<string>();
    for (const view of everyPage()) for (const op of ops(view.container)) drawn.add(op);
    for (const op of drawn) expect(Object.hasOwn(SETUP_OPERATIONS, op), op).toBe(true);
    expect([...drawn].sort()).toEqual(Object.keys(SETUP_OPERATIONS).sort());
  });

  it('has exactly one h1 per page, labels every control, and gives every table a caption and scoped headers', () => {
    for (const view of everyPage()) {
      expect(view.container.querySelectorAll('h1')).toHaveLength(1);
      for (const control of view.container.querySelectorAll<HTMLInputElement>(
        'input:not([type="hidden"]), select, textarea',
      ))
        expect(control.labels?.length ?? 0, `${control.tagName} ${control.name}`).toBeGreaterThan(
          0,
        );
      for (const table of view.container.querySelectorAll('table'))
        expect(table.querySelector('caption')).toBeTruthy();
      for (const th of view.container.querySelectorAll('th'))
        expect(th.getAttribute('scope'), th.textContent ?? '').toBeTruthy();
    }
  });

  it('uses calm wording: no urgency, no countdown, no marketing', () => {
    const banned =
      /urgent|hurry|last chance|act now|limited time|don.t miss|expires? in|countdown|offer|discount|cashback|free\b|only today/i;
    for (const view of everyPage()) expect(text(view.container)).not.toMatch(banned);
  });

  it('makes no claim of compliance, approval by a regulator, or safety', () => {
    const claims = /complian|regulator|RBI|legally|certified|\bsafe\b|\bsecure\b|authorised by/i;
    for (const view of everyPage()) expect(text(view.container)).not.toMatch(claims);
  });

  it('shows no raw vocabulary value, reason code, database state or long run of digits', () => {
    for (const view of everyPage()) {
      const t = stripIds(text(view.container));
      expect(t).not.toMatch(
        /\b(pending_approval|production|sandbox|mock|payment_and_mandate|destination_|merchant_not_active|SQLSTATE|statusReasons|providerMode)\b(?! mode| provider)/,
      );
      expect(t).not.toMatch(/\d{9,}/);
    }
  });

  it('puts only allowed return paths in the forms', () => {
    for (const view of everyPage())
      for (const input of view.container.querySelectorAll<HTMLInputElement>(
        'input[name="returnTo"]',
      ))
        expect(safeSetupReturnPath(input.value)).toBe(input.value);
  });

  it('never puts a name, phone number or account number in a link', () => {
    for (const view of everyPage())
      for (const a of view.container.querySelectorAll('a')) {
        const href = stripIds(a.getAttribute('href') ?? '');
        expect(href).not.toMatch(/\d{6,}|@|name=|phone|accountNumber|account=/i);
      }
  });

  it('has no field anywhere named for a full account number, an IFSC code or a secret value', () => {
    for (const view of everyPage())
      for (const control of view.container.querySelectorAll<HTMLInputElement>(
        'input, select, textarea',
      ))
        expect(control.name, control.name).not.toMatch(
          /accountNumber|ifsc|password|secretValue|endpointToken/i,
        );
  });
});
