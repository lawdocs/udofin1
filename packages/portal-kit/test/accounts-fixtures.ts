// Synthetic (SAMPLE) data for the operations screens for providers, the account registry, feature switches and platform
// exceptions. Every fixture is parsed by the real contract schema, so a screen is only ever tested against a shape the API can
// send. Nothing here is a real person, account or lender. The "canary" values are made-up numbers that must never appear in any
// output; they are fixed so that a scan for them is exact.
import {
  AccountFormatRuleEntry,
  FeatureCatalogEntry,
  FeatureChangeRequestEntry,
  FeatureSwitchState,
  FingerprintKeyVersionEntry,
  LpException,
  LpExceptionDetail,
  MerchantEntry,
  OwnAccountListEvent,
  OwnAccountListState,
  PaymentConfigEntry,
  PaymentProviderEntry,
  RegistryAccountEntry,
  ReturnCodeClassEntry,
  SettlementAccountForLinking,
} from '@udofin/contracts';
import { vi } from 'vitest';
import { type z } from 'zod';
import { type AccountsContext } from '../src/accounts/common.js';
import { type PlatformApi } from '../src/accounts/client.js';
import { platformCaps } from '../src/accounts/data.js';

// People: the signed-in person, and someone else.
export const ME = '0190a000-0000-7000-8000-0000000000a1';
export const OTHER = '0190a000-0000-7000-8000-0000000000a2';
export const LENDER_A = '0190a000-0000-7000-8000-00000000000a';
export const LENDER_B = '0190a000-0000-7000-8000-00000000000b';
export const REGISTRY_1 = '0190a000-0000-7000-8000-000000000101';
export const REGISTRY_2 = '0190a000-0000-7000-8000-000000000102';
export const REGISTRY_3 = '0190a000-0000-7000-8000-000000000103';
export const RULE_1 = '0190a000-0000-7000-8000-000000000201';
export const RULE_2 = '0190a000-0000-7000-8000-000000000202';
export const SETTLEMENT_1 = '0190a000-0000-7000-8000-000000000301';
export const MERCHANT_1 = '0190a000-0000-7000-8000-000000000401';
export const MERCHANT_2 = '0190a000-0000-7000-8000-000000000402';
export const REQUEST_1 = '0190a000-0000-7000-8000-000000000501';
export const REQUEST_2 = '0190a000-0000-7000-8000-000000000502';
export const EXCEPTION_1 = '0190a000-0000-7000-8000-000000000601';
export const EXCEPTION_2 = '0190a000-0000-7000-8000-000000000602';
export const EVENT_1 = '0190a000-0000-7000-8000-000000000701';
export const CODE_1 = '0190a000-0000-7000-8000-000000000801';
export const CONFIG_1 = '0190a000-0000-7000-8000-000000000901';
export const CONFIG_2 = '0190a000-0000-7000-8000-000000000902';
export const OWN_EVENT_1 = '0190a000-0000-7000-8000-000000000a01';
export const OWN_EVENT_2 = '0190a000-0000-7000-8000-000000000a02';

/** Made-up values that must never appear in a page, an address, an error or a log line. */
export const CANARY_ACCOUNT = '482719503628';
export const CANARY_BRANCH_CODE = 'ZZZZ0QX7R4P';
export const CANARY_LAST_FOUR = CANARY_ACCOUNT.slice(-4);

/** A request id the way a rendered form mints one, made at run time. */
export const freshRequestId = (): string => `ui-${crypto.randomUUID()}`;

export const NOW = '2026-10-18T09:30:00.000000+05:30';

const make = <S extends z.ZodType>(
  schema: S,
  base: Record<string, unknown>,
  over: object,
): z.infer<S> => schema.parse({ ...base, ...over });

export const provider = (over: object = {}) =>
  make(
    PaymentProviderEntry,
    {
      provider: 'sample_pay',
      displayName: 'Sample Pay (test only)',
      kind: 'payment_and_mandate',
      status: 'approved',
      authorisationEvidenceRef: 'Sample provider letter 1',
      evidenceLabel: 'likely',
      statusReason: null,
      updatedAt: NOW,
    },
    over,
  );

export const returnCode = (over: object = {}) =>
  make(
    ReturnCodeClassEntry,
    {
      id: CODE_1,
      provider: 'sample_pay',
      code: 'R01',
      class: 'insufficient_funds',
      evidenceRef: 'Sample return-code sheet',
      status: 'active',
      setBy: OTHER,
      setAt: NOW,
    },
    over,
  );

export const rule = (over: object = {}) =>
  make(
    AccountFormatRuleEntry,
    {
      id: RULE_1,
      country: 'IN',
      accountType: 'bank_account',
      version: 1,
      minDigits: 9,
      maxDigits: 18,
      ifscRequired: true,
      status: 'draft',
      evidenceLabel: 'unverified',
      sourceNote: 'initial assumption, no source on file',
      effectiveFrom: '2026-10-01',
      effectiveTo: null,
      draftedBy: null,
      submittedBy: null,
      approvedBy: null,
      approvedAt: null,
      retiredAt: null,
      retiredReason: null,
      createdAt: NOW,
    },
    over,
  );

export const approvedRule = (over: object = {}) =>
  rule({
    status: 'approved',
    draftedBy: OTHER,
    submittedBy: OTHER,
    approvedBy: ME,
    approvedAt: NOW,
    ...over,
  });

export const keyVersion = (over: object = {}) =>
  make(
    FingerprintKeyVersionEntry,
    {
      keyVersion: 1,
      status: 'active',
      proposedBy: OTHER,
      proposedAt: NOW,
      approvedBy: ME,
      approvedAt: NOW,
      retiredAt: null,
      note: null,
    },
    over,
  );

export const registryEntry = (over: object = {}) =>
  make(
    RegistryAccountEntry,
    {
      id: REGISTRY_1,
      maskedRef: `XXXXXX${CANARY_LAST_FOUR}`,
      keyVersion: 1,
      rekeyedFromId: null,
      country: 'IN',
      accountType: 'bank_account',
      formatRuleId: RULE_1,
      ownerKind: 'lender',
      ownerOrgId: LENDER_A,
      legalOwnerName: 'Sample Finance Ltd',
      permittedPurposes: ['repayment_settlement'],
      verificationStatus: 'unverified',
      evidenceRef: null,
      effectiveFrom: '2026-10-01',
      effectiveTo: null,
      registeredBy: OTHER,
      registeredAt: NOW,
      verifiedBy: null,
      verifiedAt: null,
      rejectedAt: null,
      rejectionReason: null,
      revokedAt: null,
      revokedReason: null,
    },
    over,
  );

export const settlement = (over: object = {}) =>
  make(
    SettlementAccountForLinking,
    {
      id: SETTLEMENT_1,
      lenderId: LENDER_A,
      label: 'Collections account',
      bankName: 'Sample Bank',
      maskedRef: `XXXXXX${CANARY_LAST_FOUR}`,
      status: 'unverified',
      registryId: null,
      createdAt: NOW,
    },
    over,
  );

export const merchant = (over: object = {}) =>
  make(
    MerchantEntry,
    {
      id: MERCHANT_1,
      provider: 'sample_pay',
      merchantRef: 'MERCH-SAMPLE-1',
      ownerKind: 'lender',
      ownerOrgId: LENDER_A,
      purpose: 'repayment',
      status: 'active',
      verificationStatus: 'unverified',
      verificationEvidenceRef: null,
      claimedAt: NOW,
      verifiedAt: null,
      revokedAt: null,
      revokedReason: null,
    },
    over,
  );

export const feeMerchant = (over: object = {}) =>
  merchant({
    id: MERCHANT_2,
    merchantRef: 'FEES-SAMPLE-1',
    ownerKind: 'udofin_fees',
    ownerOrgId: null,
    purpose: 'fee_collection',
    verificationStatus: 'verified',
    verificationEvidenceRef: 'Sample provider letter 2',
    verifiedAt: NOW,
    ...over,
  });

export const catalogueEntry = (feature: string, over: object = {}) =>
  make(
    FeatureCatalogEntry,
    {
      feature,
      enableable: true,
      introducedIn: 'phase_08a',
      description: `Sample description of ${feature}`,
      lockedReason: null,
    },
    over,
  );

export const CATALOGUE = [
  catalogueEntry('servicing_sync'),
  catalogueEntry('payments'),
  catalogueEntry('mandates'),
  catalogueEntry('reminders'),
  catalogueEntry('statements_noc'),
  catalogueEntry('collections', {
    enableable: false,
    introducedIn: 'phase_08b',
    lockedReason: 'Phase 08b is not authorised.',
  }),
  catalogueEntry('dlg', {
    enableable: false,
    introducedIn: 'phase_08c',
    lockedReason: 'Phase 08c is not authorised.',
  }),
];

export const switchState = (feature: string, over: object = {}) =>
  make(
    FeatureSwitchState,
    {
      lenderId: LENDER_A,
      feature,
      enabled: false,
      enableable: true,
      enabledAt: null,
      disabledAt: null,
    },
    over,
  );

export const changeRequest = (over: object = {}) =>
  make(
    FeatureChangeRequestEntry,
    {
      id: REQUEST_1,
      lenderId: LENDER_A,
      feature: 'payments',
      enable: true,
      mode: 'two_person',
      status: 'pending',
      evidence: { contract_reference: 'Sample agreement 7' },
      reason: null,
      requestedBy: OTHER,
      requestedAt: NOW,
      expiresAt: '2026-10-25T09:30:00.000000+05:30',
      decidedBy: null,
      decidedAt: null,
      decisionNote: null,
      appliedAt: null,
    },
    over,
  );

export const platformException = (over: object = {}) =>
  make(
    LpException,
    {
      id: EXCEPTION_1,
      lenderId: LENDER_A,
      class: 'merchant_mismatch',
      severity: 'critical',
      owner: 'platform',
      status: 'open',
      subject: { config_id: '0190a000-0000-7000-8000-000000000901', provider: 'sample_pay' },
      assignedTo: null,
      openedAt: NOW,
      resolvedAt: null,
      updatedAt: NOW,
    },
    over,
  );

export const exceptionDetail = (over: object = {}) =>
  make(
    LpExceptionDetail,
    {
      exception: platformException(),
      events: [
        {
          id: EVENT_1,
          action: 'opened',
          actorKind: 'system',
          actorUserId: null,
          reasonCode: null,
          evidence: null,
          note: null,
          assignedTo: null,
          authorisedByPermission: null,
          occurredAt: NOW,
        },
      ],
    },
    over,
  );

/** A payment configuration as the platform reads it. Secret NAMES inside the lender's namespace; never a value. */
export const paymentConfig = (over: object = {}) =>
  make(
    PaymentConfigEntry,
    {
      id: CONFIG_1,
      lenderId: LENDER_A,
      provider: 'sample_pay',
      providerMode: 'production',
      merchantRegistryId: MERCHANT_1,
      settlementAccountId: SETTLEMENT_1,
      secretRef: 'L00000000000A_PSP_ONE',
      webhookSecretRef: 'L00000000000A_PSP_TWO',
      railLimits: {},
      railLimitsSource: null,
      evidenceRef: null,
      contractSectionRef: null,
      status: 'suspended',
      draftedBy: OTHER,
      draftedAt: NOW,
      submittedBy: OTHER,
      submittedAt: NOW,
      approvedBy: ME,
      approvedAt: NOW,
      statusReason: null,
      statusReasons: ['platform_suspension'],
      lastValidatedAt: null,
      lastValidationOk: null,
      holdKind: 'platform',
      holdSetAt: '2026-10-18T10:00:00.000000+05:30',
      updatedAt: NOW,
    },
    over,
  );

export const ownListEvent = (over: object = {}) =>
  make(
    OwnAccountListEvent,
    {
      id: OWN_EVENT_1,
      eventKind: 'attested',
      keyVersion: 1,
      evidenceRef: 'Sample reconciliation sheet 4',
      reason: null,
      entriesCounted: 2,
      actorId: OTHER,
      occurredAt: NOW,
    },
    over,
  );

/** The own-account list as the platform reads it: attested by default, with its one attestation. */
export const ownListState = (over: object = {}) =>
  make(OwnAccountListState, { keyVersion: 1, attested: true, events: [ownListEvent()] }, over);

// ---- results of loaders -----------------------------------------------------------------------------------------------
export const ok = <T>(data: T) => ({ ok: true as const, status: 200, data });
export const fail = (status: number, code: string) => ({
  ok: false as const,
  status,
  code,
});
export const page = <T>(items: T[], nextCursor: string | null = null) => ok({ items, nextCursor });
export const list = <T>(items: T[]) => ok({ items });

// ---- contexts ---------------------------------------------------------------------------------------------------------
export const ALL_PERMISSIONS = [
  'platform.payments.providers.manage',
  'platform.accounts.registry.manage',
  'platform.accounts.registry.verify',
  'platform.features.manage',
] as const;

export const contextFor = (
  permissions: readonly string[],
  returnTo = '/accounts',
  userId = ME,
): AccountsContext => ({
  action: vi.fn(() => Promise.resolve()),
  registerAction: vi.fn(() => Promise.resolve()),
  returnTo,
  caps: platformCaps(permissions),
  userId,
});

// ---- the API, recorded ------------------------------------------------------------------------------------------------
export interface RecordedCall {
  path: string;
  body: unknown;
  requestId: string;
}

/**
 * A platform API that records every write and answers it with `answer`. A read is answered from `reads` (by exact path) or
 * with a 404, and every read path is recorded.
 */
export function recordingApi(
  answer: unknown = {},
  readAnswers: Record<string, unknown> = {},
  failWith?: { status: number; code: string; reasons?: readonly string[] },
) {
  const calls: RecordedCall[] = [];
  const reads: string[] = [];
  const api: PlatformApi = {
    get: (path) => {
      reads.push(path);
      return Promise.resolve(
        Object.hasOwn(readAnswers, path)
          ? {
              ok: true as const,
              status: 200,
              data: readAnswers[path] as never,
            }
          : { ok: false as const, status: 404, code: 'not_found' },
      );
    },
    post: (path, _schema, body, requestId) => {
      calls.push({ path, body, requestId });
      return Promise.resolve(
        failWith
          ? { ok: false as const, ...failWith }
          : { ok: true as const, status: 200, data: answer as never },
      );
    },
  };
  return { api, calls, reads };
}

/** Builds a form the way the browser sends it. A request id is added unless one is given. */
export function formOf(fields: Record<string, string | string[]>): FormData {
  const form = new FormData();
  if (!('key' in fields)) form.set('key', freshRequestId());
  for (const [name, value] of Object.entries(fields)) {
    if (Array.isArray(value)) for (const v of value) form.append(name, v);
    else form.set(name, value);
  }
  return form;
}
