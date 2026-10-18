// @vitest-environment node
// Logic of the operations screens for providers, the account registry, feature switches and platform exceptions that needs no
// browser: the platform client and its allow-list, wording, queries, loaders, the allow-listed operations and the guards around
// them, and above all the path of an account number: typed once, posted once, to one route, and never anywhere else.
import {
  AccountFormatRuleStatus,
  AccountOwnerKind,
  AccountPurpose,
  AccountsEvidenceStatus,
  FeatureChangeStatus,
  FingerprintKeyVersionStatus,
  LP_EXCEPTION_ACTIONS,
  LP_EXCEPTION_SEVERITIES,
  LP_EXCEPTION_STATUSES,
  LP_REOPEN_REASONS,
  LP_RESOLVE_REASONS,
  PaymentProviderKind,
  PaymentProviderStatus,
  RegistryVerificationStatus,
  ReturnCodeClass,
} from '@udofin/contracts';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { openFlash, sealFlash } from '../src/flash.js';
import { type OnboardingApi } from '../src/onboarding/api.js';
import {
  createPlatformClient,
  isPlatformReadPath,
  isPlatformWritePath,
  readProblem,
} from '../src/accounts/client.js';
import {
  accountsHref,
  isId,
  loadAccounts,
  loadFeatureRequests,
  loadLenderChoices,
  loadOpenExceptions,
  loadResolvedExceptions,
  loadReturnCodes,
  loadSettlementAccounts,
  mayReadRegistry,
  noticeFrom,
  parseAccountsQuery,
  platformCaps,
  registeredIdFrom,
  returnPath,
  withoutCursor,
} from '../src/accounts/data.js';
import {
  accountRegisteredUrl,
  accountsFlashFor,
  ACCOUNTS_OPERATIONS,
  accountsNoticeUrl,
  runAccountRegistration,
  runAccountsOperation,
  safeAccountsReturnPath,
} from '../src/accounts/operations.js';
import {
  accountsErrorMessage,
  actorKindWords,
  decisionResultWords,
  evidenceStatusWords,
  exceptionActionWords,
  exceptionClassWords,
  exceptionSeverityWords,
  exceptionStatusWords,
  featureReasonWords,
  featureWords,
  isLockedFeature,
  keyStatusWords,
  merchantOwnerWords,
  ownerKindWords,
  providerKindWords,
  providerStatusWords,
  purposeWords,
  reasonCodesFrom,
  reasonWords,
  registryStatusWords,
  requestModeWords,
  requestStatusWords,
  resolveReasonWords,
  returnClassWords,
  ruleStatusWords,
  safeErrorCode,
  settlementStatusWords,
} from '../src/accounts/wording.js';
import {
  CANARY_ACCOUNT,
  CANARY_BRANCH_CODE,
  CANARY_LAST_FOUR,
  EXCEPTION_1,
  formOf,
  LENDER_A,
  LENDER_B,
  MERCHANT_1,
  recordingApi,
  REGISTRY_1,
  REGISTRY_2,
  REQUEST_1,
  RULE_1,
  SETTLEMENT_1,
} from './accounts-fixtures.js';

const NO_WORDING = /has no wording|no wording for/;
const GENERIC = 'The action could not be completed. Nothing was changed.';

const run = async (
  op: string,
  fields: Record<string, string | string[]>,
  answer: unknown = {},
  portal: 'ops' | 'lender' = 'ops',
) => {
  const rec = recordingApi(answer);
  const outcome = await runAccountsOperation(rec.api, formOf({ op, ...fields }), portal);
  return { ...rec, outcome };
};

// -------------------------------------------------------------------------------------------------------------------
describe('wording covers every closed list of the contracts', () => {
  it.each([
    ['provider kinds', PaymentProviderKind.options, providerKindWords],
    ['provider statuses', PaymentProviderStatus.options, providerStatusWords],
    ['evidence labels', AccountsEvidenceStatus.options, evidenceStatusWords],
    ['return classes', ReturnCodeClass.options, returnClassWords],
    ['rule statuses', AccountFormatRuleStatus.options, ruleStatusWords],
    ['key statuses', FingerprintKeyVersionStatus.options, keyStatusWords],
    ['owner kinds', AccountOwnerKind.options, ownerKindWords],
    ['purposes', AccountPurpose.options, purposeWords],
    ['registry statuses', RegistryVerificationStatus.options, registryStatusWords],
    ['request statuses', FeatureChangeStatus.options, requestStatusWords],
    ['exception severities', LP_EXCEPTION_SEVERITIES, exceptionSeverityWords],
    ['exception statuses', LP_EXCEPTION_STATUSES, exceptionStatusWords],
    ['exception actions', LP_EXCEPTION_ACTIONS, exceptionActionWords],
    ['resolve reasons', LP_RESOLVE_REASONS, resolveReasonWords],
    ['reopen reasons', LP_REOPEN_REASONS, resolveReasonWords],
    ['request modes', ['two_person', 'emergency'], requestModeWords],
    ['merchant owners', ['lender', 'udofin_fees'], merchantOwnerWords],
    ['settlement statuses', ['unverified', 'verified', 'revoked'], settlementStatusWords],
    ['actors', ['system', 'lender_user', 'platform_user'], actorKindWords],
    [
      'features',
      [
        'servicing_sync',
        'payments',
        'mandates',
        'reminders',
        'statements_noc',
        'collections',
        'dlg',
      ],
      featureWords,
    ],
  ] as const)('has words for every value of %s', (_name, values, words) => {
    for (const value of values) expect(words(value)).not.toMatch(NO_WORDING);
  });

  it('does not print a value it has no wording for', () => {
    expect(providerKindWords('zz_unknown_kind_1')).toMatch(NO_WORDING);
    expect(providerKindWords('zz_unknown_kind_1')).not.toContain('zz_unknown_kind_1');
    expect(featureWords('zz_unknown_feature')).not.toContain('zz_unknown_feature');
    expect(exceptionClassWords('zz_unknown_class')).not.toContain('zz_unknown_class');
    expect(registryStatusWords('constructor')).toMatch(NO_WORDING);
    expect(featureReasonWords('constructor')).toMatch(/another reason/i);
  });

  it('knows the platform exception classes of the notes and falls back for others', () => {
    for (const klass of [
      'merchant_mismatch',
      'event_payload_conflict',
      'settlement_account_mismatch',
    ])
      expect(exceptionClassWords(klass)).not.toMatch(NO_WORDING);
    expect(exceptionClassWords('something_else')).toMatch(NO_WORDING);
  });

  it('words every reason a refused switch request can list, and none for an unknown one', () => {
    const reasons = [
      'feature_unknown',
      'feature_not_enableable',
      'lender_organisation_not_active',
      'onboarding_gate_not_activated',
      'evidence_missing',
      'payment_config_missing',
      'payment_config_mock_or_sandbox_only',
      'registry_entry_not_verified',
      'payment_config_validation_failed',
      'lms_connection_not_active',
      'servicing_sync_not_enabled',
      'reminder_policy_missing',
      'reminder_templates_missing',
      'provider_not_mandate_capable',
      'mandate_rail_not_configured',
      'mandate_policy_missing',
    ];
    for (const reason of reasons) {
      expect(featureReasonWords(reason)).not.toMatch(/another reason/i);
      expect(featureReasonWords(reason)).not.toContain('_');
    }
    // A mock or sandbox configuration is described as test only.
    expect(featureReasonWords('payment_config_mock_or_sandbox_only')).toMatch(/testing only/);
    expect(featureReasonWords('brand_new_reason')).toMatch(/another reason/i);
  });

  it('words each answer to a decision, and nothing for any other text', () => {
    expect(decisionResultWords('applied')).toMatch(/switch has changed/);
    expect(decisionResultWords('rejected')).toMatch(/Nothing changed/);
    expect(decisionResultWords('expired')).toMatch(/not applied/);
    expect(decisionResultWords('<script>')).toBeNull();
    expect(reasonWords('verified_with_provider')).toBe('Checked with the provider');
    expect(reasonWords('free text from somewhere')).toBeNull();
    expect(reasonWords(null)).toBeNull();
  });

  it('never calls an evidence label a finding, and never claims compliance', () => {
    for (const label of AccountsEvidenceStatus.options) {
      const words = evidenceStatusWords(label);
      expect(words).not.toMatch(/complian|compliant|regulator|approved by|safe/i);
    }
    expect(evidenceStatusWords('confirmed')).toMatch(/by staff/);
    expect(providerStatusWords('approved')).toBe('Approved by staff');
  });

  it('keeps collections and the default loss guarantee locked in a second list', () => {
    expect(isLockedFeature('collections')).toBe(true);
    expect(isLockedFeature('dlg')).toBe(true);
    expect(isLockedFeature('payments')).toBe(false);
  });
});

describe('error codes become sentences, never server text', () => {
  it('maps the codes of the notes to plain sentences', () => {
    for (const code of [
      'forbidden',
      'mfa_required',
      'self_approval',
      'segregation_of_duties',
      'key_management_unavailable',
      'account_format_unvalidated',
      'account_number_invalid',
      'ifsc_invalid',
      'owner_invalid',
      'account_already_registered',
      'not_unverified',
      'reason_required',
      'reason_invalid',
      'rule_not_draft',
      'not_submitted',
      'proposal_open',
      'rotation_incomplete',
      'merchant_already_claimed',
      'registry_not_permitted',
      'masked_ref_mismatch',
      'feature_not_enableable',
      'pending_request_exists',
      'prerequisites_unmet',
      'request_not_pending',
      'confirm_required',
      'exception_state_invalid',
      'validation_failed',
      'path_not_allowed',
      'network_error',
    ])
      expect(accountsErrorMessage(code), code).not.toBe(GENERIC);
  });

  it('gives the generic sentence for an unknown or hostile code and repeats nothing', () => {
    for (const code of ['', 'weird code with spaces', '__proto__', 'constructor', 'toString'])
      expect(accountsErrorMessage(code)).toBe(GENERIC);
    expect(accountsErrorMessage(undefined)).toBe(GENERIC);
    expect(accountsErrorMessage(null)).toBe(GENERIC);
    expect(accountsErrorMessage('upstream says: boom 42')).not.toContain('boom');
  });

  it('lets only a short lower-case code travel in an address', () => {
    expect(safeErrorCode('self_approval')).toBe('self_approval');
    expect(safeErrorCode('Some Raw Text!')).toBe('unknown');
    expect(safeErrorCode('x'.repeat(80))).toBe('unknown');
    expect(safeErrorCode('')).toBe('unknown');
  });

  it('reads reason identifiers from an address: well-formed ones only, at most ten', () => {
    expect(reasonCodesFrom('a_b,payment_config_missing')).toEqual([
      'a_b',
      'payment_config_missing',
    ]);
    expect(reasonCodesFrom('Bad Reason,<b>x</b>,ok_one')).toEqual(['ok_one']);
    expect(reasonCodesFrom(undefined)).toEqual([]);
    expect(
      reasonCodesFrom(Array.from({ length: 30 }, (_, i) => `r_${String(i)}`).join(',')),
    ).toHaveLength(10);
  });
});

// -------------------------------------------------------------------------------------------------------------------
describe('what the person may do, and what the page address may ask for', () => {
  it('reads the four platform permissions and nothing else', () => {
    expect(platformCaps([])).toEqual({
      providersManage: false,
      registryManage: false,
      registryVerify: false,
      featuresManage: false,
    });
    expect(
      platformCaps([
        'platform.payments.providers.manage',
        'platform.accounts.registry.manage',
        'platform.accounts.registry.verify',
        'platform.features.manage',
      ]),
    ).toEqual({
      providersManage: true,
      registryManage: true,
      registryVerify: true,
      featuresManage: true,
    });
    // A lender permission with a similar name grants nothing here.
    expect(platformCaps(['payment.configure', 'payment.config.approve']).providersManage).toBe(
      false,
    );
    expect(mayReadRegistry(platformCaps(['platform.accounts.registry.verify']))).toBe(true);
    expect(mayReadRegistry(platformCaps(['platform.features.manage']))).toBe(false);
  });

  it('keeps only well-formed filters from the page address', () => {
    const query = parseAccountsQuery(
      {
        cursor: 'abc_DEF-123',
        lenderId: LENDER_A,
        status: 'verified',
        verification: 'verified',
        severity: 'critical',
        provider: 'sample_pay',
        class: 'merchant_mismatch',
        view: 'resolved',
        linked: 'false',
      },
      {
        status: ['unverified', 'verified'],
        verification: ['unverified', 'verified'],
        severity: ['critical'],
        view: ['open', 'resolved'],
        linked: ['true', 'false'],
      },
    );
    expect(query).toEqual({
      cursor: 'abc_DEF-123',
      lenderId: LENDER_A,
      status: 'verified',
      verification: 'verified',
      severity: 'critical',
      provider: 'sample_pay',
      class: 'merchant_mismatch',
      view: 'resolved',
      linked: 'false',
    });
    expect(
      parseAccountsQuery(
        {
          cursor: 'bad cursor!',
          lenderId: 'not-a-uuid',
          status: 'other',
          provider: 'Bad Provider',
          class: 'Bad Class',
          view: ['open', 'resolved'],
        },
        { status: ['verified'], view: ['open'] },
      ),
    ).toEqual({});
    // A filter that the page did not declare closed is dropped, not passed on.
    expect(parseAccountsQuery({ status: 'verified' })).toEqual({});
  });

  it('builds links back to a list with the same filters, and without the page position', () => {
    const query = { status: 'verified', lenderId: LENDER_A, cursor: 'c1' };
    expect(accountsHref('/accounts', query)).toBe(
      `/accounts?status=verified&lenderId=${LENDER_A}&cursor=c1`,
    );
    expect(accountsHref('/accounts', withoutCursor(query))).toBe(
      `/accounts?status=verified&lenderId=${LENDER_A}`,
    );
    expect(accountsHref('/accounts', {})).toBe('/accounts');
  });

  // A success reaches the page as a notice the server wrote (see flash.ts), never as something the address says.
  const NOW = Date.UTC(2026, 9, 18, 10, 0, 0);
  const noticeFor = (path: string, detail: { result?: string; registered?: string } = {}) =>
    openFlash(sealFlash({ path, ...detail }, NOW), path, NOW);

  it('reads the new entry from the notice the server wrote, and never from the address', () => {
    expect(registeredIdFrom(noticeFor('/accounts', { registered: REGISTRY_1 }))).toBe(REGISTRY_1);
    expect(registeredIdFrom(noticeFor('/accounts'))).toBeUndefined();
    expect(registeredIdFrom(undefined)).toBeUndefined();
    // The function has no way to be given an address: a crafted ?registered=<id> cannot name an entry.
    expect(registeredIdFrom.length).toBe(1);
    expect(isId(REGISTRY_1)).toBe(true);
    expect(isId('1; drop')).toBe(false);
  });

  it('takes a success and a decision only from the notice the server wrote', () => {
    const raw = {
      done: '1',
      error: 'x',
      result: 'applied',
      reasons: 'a,b',
      registered: REGISTRY_1,
    };
    // A forged address alone: no confirmation, no decision. Only the closed failure codes can arrive this way.
    expect(noticeFrom(raw, undefined)).toEqual({
      done: false,
      error: 'x',
      result: undefined,
      reasons: 'a,b',
    });
    expect(noticeFrom({ done: '1', result: 'applied' }, undefined)).toEqual({
      done: false,
      error: undefined,
      result: undefined,
      reasons: undefined,
    });
    expect(noticeFrom({}, noticeFor('/features', { result: 'applied' }))).toEqual({
      done: true,
      error: undefined,
      result: 'applied',
      reasons: undefined,
    });
    expect(noticeFrom({ result: 'rejected' }, noticeFor('/features'))).toEqual({
      done: true,
      error: undefined,
      result: undefined,
      reasons: undefined,
    });
    expect(noticeFrom({}, undefined)).toEqual({
      done: false,
      error: undefined,
      result: undefined,
      reasons: undefined,
    });
  });

  it('returns to the same filters, never to the old notice', () => {
    const raw = { status: 'verified', done: '1', error: 'x', registered: REGISTRY_1, cursor: 'c1' };
    expect(returnPath('/accounts', raw, ['status', 'cursor'])).toBe(
      '/accounts?status=verified&cursor=c1',
    );
    expect(returnPath('/accounts', raw, ['lenderId'])).toBe('/accounts');
    expect(returnPath('/accounts', { status: '<script>' }, ['status'])).toBe('/accounts');
  });
});

// -------------------------------------------------------------------------------------------------------------------
describe('loaders ask for exactly the routes of the notes', () => {
  it('builds the read paths and drops filters that are not well formed', async () => {
    const { api, reads } = recordingApi();
    await loadAccounts(api, { status: 'verified', lenderId: LENDER_A, cursor: 'c1' });
    await loadSettlementAccounts(api, { linked: 'false', lenderId: LENDER_B });
    await loadFeatureRequests(api, { status: 'pending' });
    await loadOpenExceptions(api, { severity: 'critical' });
    await loadResolvedExceptions(api, {});
    await loadReturnCodes(api, 'sample_pay');
    await loadReturnCodes(api, 'Bad Provider');
    expect(reads).toEqual([
      `/v1/platform/accounts?limit=25&cursor=c1&status=verified&ownerOrgId=${LENDER_A}`,
      `/v1/platform/settlement-accounts?limit=25&lenderId=${LENDER_B}&linked=false`,
      '/v1/platform/feature-change-requests?limit=25&status=pending',
      '/v1/platform/exceptions?limit=25&severity=critical',
      '/v1/lender/reconciliation/exceptions?limit=25&owner=platform&status=resolved',
      '/v1/platform/return-code-classes?status=active&provider=sample_pay',
      '/v1/platform/return-code-classes?status=active',
    ]);
    // Every path a loader builds is one the platform client would send.
    for (const path of reads) expect(isPlatformReadPath(path), path).toBe(true);
  });

  it('offers a lender choice by name, or none when the list cannot be read', async () => {
    const good = {
      get: () =>
        Promise.resolve({
          ok: true as const,
          status: 200,
          data: {
            items: [
              {
                lenderOrgId: LENDER_A,
                legalName: 'Sample Finance Private Limited',
                displayName: 'Sample Finance',
                organizationStatus: 'active',
                categoryKey: null,
                categoryLabel: null,
                stage: null,
                verificationStatus: null,
                accountingStatus: null,
              },
            ],
          },
        }),
      post: () => Promise.reject(new Error('not used')),
    };
    expect(await loadLenderChoices(good as unknown as OnboardingApi)).toEqual([
      { id: LENDER_A, name: 'Sample Finance' },
    ]);
    const bad = {
      get: () => Promise.resolve({ ok: false as const, status: 403, code: 'forbidden' }),
      post: () => Promise.reject(new Error('not used')),
    };
    expect(await loadLenderChoices(bad as unknown as OnboardingApi)).toBeNull();
  });
});

// -------------------------------------------------------------------------------------------------------------------
describe('the platform client sends only the routes the screens use', () => {
  const ACCESS = 'sample-access-value';
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const make = (respond: (url: string, init: RequestInit) => Response | Promise<Response>) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchStub = vi.fn((url: string, init?: RequestInit) => {
      calls.push({ url, init: init ?? {} });
      return Promise.resolve(respond(url, init ?? {}));
    });
    const client = createPlatformClient({
      baseUrl: 'https://api.example/',
      getAccessToken: () => Promise.resolve(ACCESS),
      fetch: fetchStub as unknown as typeof fetch,
    });
    return { client, calls, fetchStub };
  };
  const any = z.unknown();

  it('accepts the read routes and refuses everything else, without sending anything', async () => {
    const reads = [
      '/v1/platform/payment-providers',
      '/v1/platform/return-code-classes?status=active&provider=sample_pay',
      '/v1/platform/account-format-rules?status=approved',
      '/v1/platform/fingerprint-key-versions',
      '/v1/platform/accounts?limit=25&status=verified',
      `/v1/platform/accounts/${REGISTRY_1}`,
      '/v1/platform/settlement-accounts?limit=25',
      '/v1/platform/merchants?limit=25',
      '/v1/platform/features',
      `/v1/platform/lenders/${LENDER_A}/features`,
      '/v1/platform/feature-change-requests?limit=25',
      '/v1/platform/exceptions?limit=25',
      '/v1/lender/reconciliation/exceptions?owner=platform&status=resolved',
      `/v1/lender/reconciliation/exceptions/${EXCEPTION_1}`,
    ];
    for (const path of reads) expect(isPlatformReadPath(path), path).toBe(true);
    const refused = [
      '/v1/me',
      '/v1/admin/change-requests',
      '/v1/platform/document-rules',
      '/v1/platform/payment-configs',
      '/v1/platform/../admin/x',
      '/v1/platform/accounts/not-an-id',
      `/v1/platform/accounts/${REGISTRY_1}/verify`,
      '/v1/platform/udofin-fee-merchants',
      '/v1/platform/features/kill',
      '/v1/onboarding/lenders',
      '/v1/lender/reconciliation/exceptions/x/resolve',
      'https://evil.example/v1/platform/accounts',
      '/v1/platform/accounts?x=<script>',
      '//v1/platform/accounts',
    ];
    for (const path of refused) expect(isPlatformReadPath(path), path).toBe(false);
    const { client, fetchStub } = make(() => json(200, {}));
    for (const path of refused)
      expect(await client.get(path, any)).toEqual({
        ok: false,
        status: 0,
        code: 'path_not_allowed',
      });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('accepts the write routes and refuses everything else, without sending anything', async () => {
    const writes = [
      '/v1/platform/payment-providers',
      '/v1/platform/return-code-classes',
      '/v1/platform/account-format-rules',
      `/v1/platform/account-format-rules/${RULE_1}/submit`,
      `/v1/platform/account-format-rules/${RULE_1}/approve`,
      `/v1/platform/account-format-rules/${RULE_1}/retire`,
      '/v1/platform/fingerprint-key-versions',
      '/v1/platform/fingerprint-key-versions/2/approve',
      '/v1/platform/accounts',
      `/v1/platform/accounts/${REGISTRY_1}/verify`,
      `/v1/platform/accounts/${REGISTRY_1}/reject`,
      `/v1/platform/accounts/${REGISTRY_1}/revoke`,
      `/v1/platform/settlement-accounts/${SETTLEMENT_1}/link`,
      `/v1/platform/merchants/${MERCHANT_1}/verify`,
      `/v1/platform/merchants/${MERCHANT_1}/revoke`,
      '/v1/platform/udofin-fee-merchants',
      '/v1/platform/feature-change-requests',
      `/v1/platform/feature-change-requests/${REQUEST_1}/decide`,
      `/v1/platform/feature-change-requests/${REQUEST_1}/cancel`,
      '/v1/platform/features/kill',
      `/v1/lender/reconciliation/exceptions/${EXCEPTION_1}/acknowledge`,
      `/v1/lender/reconciliation/exceptions/${EXCEPTION_1}/assign`,
      `/v1/lender/reconciliation/exceptions/${EXCEPTION_1}/resolve`,
      `/v1/lender/reconciliation/exceptions/${EXCEPTION_1}/reopen`,
    ];
    for (const path of writes) expect(isPlatformWritePath(path), path).toBe(true);
    const refused = [
      '/v1/platform/exceptions',
      '/v1/platform/accounts?x=1',
      `/v1/platform/accounts/${REGISTRY_1}`,
      `/v1/platform/accounts/${REGISTRY_1}/delete`,
      '/v1/platform/accounts/../accounts',
      '/v1/platform/payment-configs',
      `/v1/platform/payment-configs/${REGISTRY_1}/suspend`,
      '/v1/lender/payment-configs',
      '/v1/lender/merchants',
      '/v1/admin/change-requests/x/approve',
      '/v1/platform/fingerprint-key-versions/x/approve',
    ];
    for (const path of refused) expect(isPlatformWritePath(path), path).toBe(false);
    const { client, fetchStub } = make(() => json(200, {}));
    for (const path of refused)
      expect(await client.post(path, any, {}, 'ui-sample-request-1')).toEqual({
        ok: false,
        status: 0,
        code: 'path_not_allowed',
      });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('sends the signed-in person’s token, a JSON body and the request id, and checks the answer against the contract', async () => {
    const { client, calls } = make(() => json(201, { id: REGISTRY_1 }));
    const result = await client.post(
      '/v1/platform/udofin-fee-merchants',
      z.object({ id: z.string() }),
      { provider: 'sample_pay' },
      'ui-sample-request-2',
    );
    expect(result).toEqual({ ok: true, status: 201, data: { id: REGISTRY_1 } });
    const call = calls[0];
    expect(call?.url).toBe('https://api.example/v1/platform/udofin-fee-merchants');
    expect(call?.init.method).toBe('POST');
    expect(call?.init.body).toBe('{"provider":"sample_pay"}');
    expect(call?.init.headers).toMatchObject({
      authorization: `Bearer ${ACCESS}`,
      'content-type': 'application/json',
      'idempotency-key': 'ui-sample-request-2',
    });
    // No redirect is followed with the token and a body attached.
    expect(call?.init.redirect).toBe('error');
  });

  it('sends a read without a body and reports contract drift as bad_response, never as data', async () => {
    const { client, calls } = make(() => json(200, { items: 'not a list' }));
    expect(
      await client.get('/v1/platform/features', z.object({ items: z.array(z.string()) })),
    ).toEqual({
      ok: false,
      status: 200,
      code: 'bad_response',
    });
    expect(calls[0]?.init.body).toBeUndefined();
    expect(calls[0]?.init.method).toBe('GET');
  });

  it('answers signed_out without sending when there is no token', async () => {
    const fetchStub = vi.fn();
    const client = createPlatformClient({
      baseUrl: 'https://api.example',
      getAccessToken: () => Promise.resolve(null),
      fetch: fetchStub,
    });
    expect(await client.get('/v1/platform/features', any)).toEqual({
      ok: false,
      status: 401,
      code: 'signed_out',
    });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('never retries: a 401 is reported once, so a body is never sent twice', async () => {
    const { client, fetchStub } = make(() => json(401, { code: 'mfa_required' }));
    expect(
      await client.post('/v1/platform/accounts', any, { x: 1 }, 'ui-sample-request-3'),
    ).toEqual({
      ok: false,
      status: 401,
      code: 'mfa_required',
    });
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it('keeps only the stable code of a refusal, not the title, detail or anything else the server wrote', async () => {
    const { client } = make(() =>
      json(409, {
        type: 'about:blank',
        title: 'Raw title with detail 99887766',
        detail: 'Raw detail text that must not travel',
        code: 'account_already_registered',
        extra: 'x',
      }),
    );
    const result = await client.post('/v1/platform/accounts', any, {}, 'ui-sample-request-4');
    expect(result).toEqual({ ok: false, status: 409, code: 'account_already_registered' });
    expect(JSON.stringify(result)).not.toMatch(/Raw|99887766/);
  });

  it('falls back to the status when the answer has no usable code', async () => {
    for (const body of [{ code: 'Has Spaces' }, { code: 7 }, {}, 'text', null]) {
      const { client } = make(() => json(500, body));
      expect(await client.get('/v1/platform/features', any)).toEqual({
        ok: false,
        status: 500,
        code: 'http_500',
      });
    }
    const { client } = make(() => new Response('<html>oops</html>', { status: 502 }));
    expect(await client.get('/v1/platform/features', any)).toEqual({
      ok: false,
      status: 502,
      code: 'http_502',
    });
  });

  it('lists unmet prerequisites only for the two refusals that carry them, as identifiers', async () => {
    const detail =
      'Reasons: payment_config_missing, servicing_sync_not_enabled, <b>bad</b>, Bad Reason';
    const { client } = make(() => json(409, { code: 'prerequisites_unmet', detail }));
    expect(
      await client.post('/v1/platform/feature-change-requests', any, {}, 'ui-sample-request-5'),
    ).toEqual({
      ok: false,
      status: 409,
      code: 'prerequisites_unmet',
      reasons: ['payment_config_missing', 'servicing_sync_not_enabled'],
    });
    // Any other code ignores a detail, even one that looks like a list.
    const other = make(() => json(409, { code: 'no_change', detail }));
    expect(
      await other.client.post(
        '/v1/platform/feature-change-requests',
        any,
        {},
        'ui-sample-request-6',
      ),
    ).toEqual({
      ok: false,
      status: 409,
      code: 'no_change',
    });
    // At most ten, and a list with nothing usable gives none.
    const many = new Response(
      JSON.stringify({
        code: 'collection_target_invalid',
        detail: `Reasons: ${Array.from({ length: 25 }, (_, i) => `r_${String(i)}`).join(', ')}`,
      }),
      { status: 409 },
    );
    expect((await readProblem(many)).reasons).toHaveLength(10);
    const none = new Response(
      JSON.stringify({ code: 'prerequisites_unmet', detail: 'Reasons: !!' }),
      {
        status: 409,
      },
    );
    expect(await readProblem(none)).toEqual({ code: 'prerequisites_unmet' });
  });

  it('reports a network failure as a code and not as the text of the failure', async () => {
    const client = createPlatformClient({
      baseUrl: 'https://api.example',
      getAccessToken: () => Promise.resolve(ACCESS),
      fetch: () => Promise.reject(new Error(`connect failed while sending ${CANARY_ACCOUNT}`)),
    });
    const result = await client.post(
      '/v1/platform/accounts',
      any,
      { accountNumber: CANARY_ACCOUNT },
      'ui-sample-request-7',
    );
    expect(result).toEqual({ ok: false, status: 0, code: 'network_error' });
    expect(JSON.stringify(result)).not.toContain(CANARY_ACCOUNT);
  });
});

// -------------------------------------------------------------------------------------------------------------------
describe('the dispatcher runs only what is on the list', () => {
  it('refuses an unknown operation, a prototype name and the other portal without calling the API', async () => {
    for (const op of ['nope', 'constructor', '__proto__', 'toString', 'hasOwnProperty', '']) {
      const { calls, outcome } = await run(op, { id: REGISTRY_1 });
      expect(outcome, op).toEqual({ ok: false, code: 'path_not_allowed' });
      expect(calls).toHaveLength(0);
    }
    const lender = await run(
      'account.revoke',
      { id: REGISTRY_1, reason: 'a sample reason text' },
      {},
      'lender',
    );
    expect(lender.outcome).toEqual({ ok: false, code: 'path_not_allowed' });
    expect(lender.calls).toHaveLength(0);
    const rec = recordingApi();
    expect(await runAccountsOperation(rec.api, new FormData(), 'ops')).toEqual({
      ok: false,
      code: 'path_not_allowed',
    });
  });

  it('declares every operation for the operations portal only', () => {
    for (const [name, operation] of Object.entries(ACCOUNTS_OPERATIONS))
      expect(operation.portals, name).toEqual(['ops']);
  });

  it('refuses a missing or malformed request id without calling the API', async () => {
    const rec = recordingApi();
    const form = formOf({ op: 'rule.submit', id: RULE_1, key: 'short' });
    expect(await runAccountsOperation(rec.api, form, 'ops')).toEqual({
      ok: false,
      code: 'validation_failed',
    });
    const none = new FormData();
    none.set('op', 'rule.submit');
    none.set('id', RULE_1);
    expect(await runAccountsOperation(rec.api, none, 'ops')).toEqual({
      ok: false,
      code: 'validation_failed',
    });
    expect(rec.calls).toHaveLength(0);
  });

  it('turns a failure into a code (and listed reasons), never into the text the API wrote', async () => {
    const hostile = recordingApi({}, {}, { status: 409, code: 'Some Raw Text! 42' });
    expect(
      await runAccountsOperation(hostile.api, formOf({ op: 'rule.submit', id: RULE_1 }), 'ops'),
    ).toEqual({
      ok: false,
      code: 'unknown',
    });
    const reasons = recordingApi(
      {},
      {},
      {
        status: 409,
        code: 'prerequisites_unmet',
        reasons: ['payment_config_missing', 'Bad Reason', '<i>x</i>'],
      },
    );
    expect(
      await runAccountsOperation(
        reasons.api,
        formOf({
          op: 'feature.request',
          lenderId: LENDER_A,
          feature: 'payments',
          direction: 'on',
          evidenceLabel1: 'contract_reference',
          evidenceValue1: 'Sample agreement 7',
        }),
        'ops',
      ),
    ).toEqual({ ok: false, code: 'prerequisites_unmet', reasons: ['payment_config_missing'] });
  });
});

describe('providers and return codes', () => {
  const provider = {
    provider: 'sample_pay',
    displayName: 'Sample Pay (test only)',
    kind: 'payment_and_mandate',
    status: 'approved',
    authorisationEvidenceRef: 'Sample provider letter 1',
    evidenceLabel: 'likely',
  };

  it('sets a provider with exactly the contract body', async () => {
    const { calls, outcome } = await run('provider.set', provider);
    expect(outcome).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe('/v1/platform/payment-providers');
    expect(calls[0]?.body).toEqual(provider);
  });

  it('sends no evidence reference as null, not as an empty text', async () => {
    const { authorisationEvidenceRef: _ignored, ...rest } = provider;
    const { calls } = await run('provider.set', rest);
    expect(calls[0]?.body).toMatchObject({ authorisationEvidenceRef: null });
  });

  it('needs a reason of at least ten characters to suspend, and sends it', async () => {
    const none = await run('provider.set', { ...provider, status: 'suspended' });
    expect(none.outcome).toEqual({ ok: false, code: 'reason_required' });
    expect(none.calls).toHaveLength(0);
    const short = await run('provider.set', {
      ...provider,
      status: 'suspended',
      reason: 'too short',
    });
    expect(short.outcome).toEqual({ ok: false, code: 'reason_required' });
    expect(short.calls).toHaveLength(0);
    const good = await run('provider.set', {
      ...provider,
      status: 'suspended',
      reason: 'Provider paused the service',
    });
    expect(good.outcome).toEqual({ ok: true });
    expect(good.calls[0]?.body).toMatchObject({
      status: 'suspended',
      reason: 'Provider paused the service',
    });
  });

  it('refuses a value outside the closed lists and a reason that carries a long number', async () => {
    for (const bad of [
      { kind: 'other' },
      { status: 'live' },
      { evidenceLabel: 'verified' },
      { provider: 'Bad Key' },
      { displayName: 'x' },
      { authorisationEvidenceRef: '!!' },
    ]) {
      const { calls, outcome } = await run('provider.set', { ...provider, ...bad });
      expect(outcome, JSON.stringify(bad)).toEqual({ ok: false, code: 'validation_failed' });
      expect(calls).toHaveLength(0);
    }
    const personal = await run('provider.set', {
      ...provider,
      reason: 'see account 123456789012 for details',
    });
    expect(personal.outcome).toEqual({ ok: false, code: 'validation_failed' });
    expect(personal.calls).toHaveLength(0);
  });

  it('sets the class of a return code', async () => {
    const fields = {
      provider: 'sample_pay',
      code: 'R01',
      class: 'insufficient_funds',
      evidenceRef: 'Sample return-code sheet',
    };
    const { calls, outcome } = await run('returncode.set', fields);
    expect(outcome).toEqual({ ok: true });
    expect(calls[0]).toMatchObject({ path: '/v1/platform/return-code-classes', body: fields });
    for (const bad of [
      { class: 'fraud' },
      { code: 'has spaces' },
      { evidenceRef: '' },
      { provider: '' },
    ]) {
      const r = await run('returncode.set', { ...fields, ...bad });
      expect(r.outcome).toEqual({ ok: false, code: 'validation_failed' });
      expect(r.calls).toHaveLength(0);
    }
  });
});

describe('format rules and key versions', () => {
  const draft = {
    country: 'in',
    accountType: 'bank_account',
    minDigits: '9',
    maxDigits: '18',
    ifscRequired: 'yes',
    evidenceLabel: 'unverified',
    sourceNote: 'Working assumption, no source yet',
  };

  it('drafts a rule: the country in capitals, the numbers as numbers, the IFSC flag as a boolean', async () => {
    const { calls, outcome } = await run('rule.draft', { ...draft, effectiveFrom: '2026-10-20' });
    expect(outcome).toEqual({ ok: true });
    expect(calls[0]?.path).toBe('/v1/platform/account-format-rules');
    expect(calls[0]?.body).toEqual({
      country: 'IN',
      accountType: 'bank_account',
      minDigits: 9,
      maxDigits: 18,
      ifscRequired: true,
      evidenceLabel: 'unverified',
      sourceNote: 'Working assumption, no source yet',
      effectiveFrom: '2026-10-20',
    });
    const no = await run('rule.draft', { ...draft, ifscRequired: 'no' });
    expect(no.calls[0]?.body).toMatchObject({ ifscRequired: false });
  });

  it('refuses a rule that is inconsistent without calling the API', async () => {
    const cases: [Record<string, string>, string][] = [
      [{ minDigits: '20', maxDigits: '10' }, 'rule_invalid'],
      [{ effectiveFrom: '2026-02-31' }, 'dates_invalid'],
      [{ effectiveTo: 'soon' }, 'dates_invalid'],
      [{ sourceNote: '' }, 'source_note_required'],
      [{ ifscRequired: '' }, 'validation_failed'],
      [{ minDigits: '0' }, 'validation_failed'],
      [{ maxDigits: '41' }, 'validation_failed'],
      [{ evidenceLabel: 'checked' }, 'validation_failed'],
      [{ country: 'India' }, 'validation_failed'],
      [{ sourceNote: 'see account 123456789012 sheet' }, 'validation_failed'],
    ];
    for (const [change, code] of cases) {
      const { calls, outcome } = await run('rule.draft', { ...draft, ...change });
      expect(outcome, JSON.stringify(change)).toEqual({ ok: false, code });
      expect(calls).toHaveLength(0);
    }
  });

  it('submits, approves and retires a rule on its own path', async () => {
    const submit = await run('rule.submit', { id: RULE_1 });
    expect(submit.calls[0]).toMatchObject({
      path: `/v1/platform/account-format-rules/${RULE_1}/submit`,
      body: {},
    });
    const approve = await run('rule.approve', {
      id: RULE_1,
      note: 'Checked against the cited source',
    });
    expect(approve.calls[0]).toMatchObject({
      path: `/v1/platform/account-format-rules/${RULE_1}/approve`,
      body: { note: 'Checked against the cited source' },
    });
    const bare = await run('rule.approve', { id: RULE_1 });
    expect(bare.calls[0]?.body).toEqual({});
    const retire = await run('rule.retire', { id: RULE_1, reason: 'Replaced by a newer version' });
    expect(retire.calls[0]).toMatchObject({
      path: `/v1/platform/account-format-rules/${RULE_1}/retire`,
      body: { reason: 'Replaced by a newer version' },
    });
    const short = await run('rule.retire', { id: RULE_1, reason: 'too short' });
    expect(short.outcome).toEqual({ ok: false, code: 'reason_required' });
    expect(short.calls).toHaveLength(0);
    const badId = await run('rule.submit', { id: 'not-an-id' });
    expect(badId.outcome).toEqual({ ok: false, code: 'validation_failed' });
    expect(badId.calls).toHaveLength(0);
  });

  it('proposes and approves a key version by number', async () => {
    const propose = await run('keyversion.propose', { version: '2', note: 'Planned rotation' });
    expect(propose.calls[0]).toMatchObject({
      path: '/v1/platform/fingerprint-key-versions',
      body: { version: 2, note: 'Planned rotation' },
    });
    const approve = await run('keyversion.approve', { version: '2' });
    expect(approve.calls[0]).toMatchObject({
      path: '/v1/platform/fingerprint-key-versions/2/approve',
      body: {},
    });
    for (const version of ['0', '1001', 'two', '1.5', '']) {
      const r = await run('keyversion.propose', { version });
      expect(r.outcome, version).toEqual({ ok: false, code: 'key_version_invalid' });
      expect(r.calls).toHaveLength(0);
    }
    expect((await run('keyversion.approve', { version: '../x' })).calls).toHaveLength(0);
  });
});

describe('verify, reject, revoke, link and merchants', () => {
  it('verifies with an evidence reference, rejects and revokes with a reason of ten characters or more', async () => {
    const verify = await run('account.verify', {
      id: REGISTRY_1,
      evidenceRef: 'Sample bank letter 3',
      note: 'Checked the letter',
    });
    expect(verify.calls[0]).toMatchObject({
      path: `/v1/platform/accounts/${REGISTRY_1}/verify`,
      body: { evidenceRef: 'Sample bank letter 3', note: 'Checked the letter' },
    });
    expect((await run('account.verify', { id: REGISTRY_1, evidenceRef: '' })).calls).toHaveLength(
      0,
    );
    // An evidence reference may not carry a long number.
    expect(
      (await run('account.verify', { id: REGISTRY_1, evidenceRef: 'letter 123456789012' })).calls,
    ).toHaveLength(0);

    for (const op of ['account.reject', 'account.revoke']) {
      const verb = op === 'account.reject' ? 'reject' : 'revoke';
      const good = await run(op, { id: REGISTRY_1, reason: 'Entered for the wrong owner' });
      expect(good.calls[0]).toMatchObject({
        path: `/v1/platform/accounts/${REGISTRY_1}/${verb}`,
        body: { reason: 'Entered for the wrong owner' },
      });
      // Nine characters are not enough; ten are.
      const nine = await run(op, { id: REGISTRY_1, reason: 'x'.repeat(9) });
      expect(nine.outcome).toEqual({ ok: false, code: 'reason_required' });
      expect(nine.calls).toHaveLength(0);
      const ten = await run(op, { id: REGISTRY_1, reason: 'x'.repeat(10) });
      expect(ten.calls).toHaveLength(1);
      const blank = await run(op, { id: REGISTRY_1, reason: '          ' });
      expect(blank.calls).toHaveLength(0);
      const personal = await run(op, { id: REGISTRY_1, reason: 'moved to 123456789012 instead' });
      expect(personal.outcome).toEqual({ ok: false, code: 'validation_failed' });
      expect(personal.calls).toHaveLength(0);
    }
  });

  it('links a settlement account to one registry entry', async () => {
    const link = await run('settlement.link', { id: SETTLEMENT_1, registryId: REGISTRY_1 });
    expect(link.calls[0]).toMatchObject({
      path: `/v1/platform/settlement-accounts/${SETTLEMENT_1}/link`,
      body: { registryId: REGISTRY_1 },
    });
    expect((await run('settlement.link', { id: SETTLEMENT_1 })).calls).toHaveLength(0);
    expect(
      (await run('settlement.link', { id: SETTLEMENT_1, registryId: 'x' })).calls,
    ).toHaveLength(0);
  });

  it('verifies and revokes a merchant, and registers the fee merchant', async () => {
    const verify = await run('merchant.verify', {
      id: MERCHANT_1,
      evidenceRef: 'Sample provider letter 2',
    });
    expect(verify.calls[0]).toMatchObject({
      path: `/v1/platform/merchants/${MERCHANT_1}/verify`,
      body: { evidenceRef: 'Sample provider letter 2' },
    });
    const revoke = await run('merchant.revoke', {
      id: MERCHANT_1,
      reason: 'Provider closed the merchant',
    });
    expect(revoke.calls[0]).toMatchObject({
      path: `/v1/platform/merchants/${MERCHANT_1}/revoke`,
      body: { reason: 'Provider closed the merchant' },
    });
    expect((await run('merchant.revoke', { id: MERCHANT_1, reason: 'short' })).calls).toHaveLength(
      0,
    );
    const fee = await run('feemerchant.register', {
      provider: 'sample_pay',
      merchantRef: 'FEES-SAMPLE-1',
    });
    expect(fee.calls[0]).toMatchObject({
      path: '/v1/platform/udofin-fee-merchants',
      body: { provider: 'sample_pay', merchantRef: 'FEES-SAMPLE-1' },
    });
    expect(
      (await run('feemerchant.register', { provider: 'sample_pay', merchantRef: 'x' })).calls,
    ).toHaveLength(0);
  });
});

describe('feature switches', () => {
  const evidence = { evidenceLabel1: 'contract_reference', evidenceValue1: 'Sample agreement 7' };

  it('asks to switch a feature on with evidence, for a different person to decide', async () => {
    const { calls, outcome } = await run('feature.request', {
      lenderId: LENDER_A,
      feature: 'payments',
      direction: 'on',
      ...evidence,
      evidenceLabel2: 'approval_note',
      evidenceValue2: 'Sample note 4',
    });
    expect(outcome).toEqual({ ok: true });
    expect(calls[0]?.path).toBe('/v1/platform/feature-change-requests');
    expect(calls[0]?.body).toEqual({
      lenderId: LENDER_A,
      feature: 'payments',
      enable: true,
      evidence: { contract_reference: 'Sample agreement 7', approval_note: 'Sample note 4' },
    });
  });

  it('never sends a request to switch collections or the default loss guarantee on', async () => {
    for (const feature of ['collections', 'dlg']) {
      const { calls, outcome } = await run('feature.request', {
        lenderId: LENDER_A,
        feature,
        direction: 'on',
        ...evidence,
      });
      expect(outcome, feature).toEqual({ ok: false, code: 'feature_not_enableable' });
      expect(calls, feature).toHaveLength(0);
    }
  });

  it('needs evidence to switch on, and a reason of ten characters to switch off', async () => {
    const base = { lenderId: LENDER_A, feature: 'payments' };
    const noEvidence = await run('feature.request', { ...base, direction: 'on' });
    expect(noEvidence.outcome).toEqual({ ok: false, code: 'evidence_invalid' });
    expect(noEvidence.calls).toHaveLength(0);
    const half = await run('feature.request', {
      ...base,
      direction: 'on',
      evidenceLabel1: 'contract_reference',
    });
    expect(half.outcome).toEqual({ ok: false, code: 'evidence_invalid' });
    const badName = await run('feature.request', {
      ...base,
      direction: 'on',
      evidenceLabel1: 'Bad Name',
      evidenceValue1: 'x',
    });
    expect(badName.outcome).toEqual({ ok: false, code: 'evidence_invalid' });
    const repeated = await run('feature.request', {
      ...base,
      direction: 'on',
      ...evidence,
      evidenceLabel2: 'contract_reference',
      evidenceValue2: 'again',
    });
    expect(repeated.outcome).toEqual({ ok: false, code: 'evidence_invalid' });
    const off = await run('feature.request', { ...base, direction: 'off' });
    expect(off.outcome).toEqual({ ok: false, code: 'reason_required' });
    const offShort = await run('feature.request', {
      ...base,
      direction: 'off',
      reason: 'too short',
    });
    expect(offShort.calls).toHaveLength(0);
    const offGood = await run('feature.request', {
      ...base,
      direction: 'off',
      reason: 'The lender asked to pause it',
    });
    expect(offGood.calls[0]?.body).toEqual({
      lenderId: LENDER_A,
      feature: 'payments',
      enable: false,
      evidence: {},
      reason: 'The lender asked to pause it',
    });
    for (const bad of [{ direction: 'sideways' }, { lenderId: 'x' }, { feature: '' }]) {
      const r = await run('feature.request', { ...base, direction: 'on', ...evidence, ...bad });
      expect(r.calls, JSON.stringify(bad)).toHaveLength(0);
    }
  });

  it('decides a request: approving needs no note, rejecting needs one, and the answer is carried back', async () => {
    const approve = await run(
      'feature.decide',
      { id: REQUEST_1, verdict: 'approve' },
      { id: REQUEST_1, status: 'applied' },
    );
    expect(approve.calls[0]).toMatchObject({
      path: `/v1/platform/feature-change-requests/${REQUEST_1}/decide`,
      body: { approve: true },
    });
    expect(approve.outcome).toEqual({ ok: true, result: 'applied' });
    // An "expired" answer is not a success of the switch: it is reported as it is.
    const expired = await run(
      'feature.decide',
      { id: REQUEST_1, verdict: 'approve' },
      { id: REQUEST_1, status: 'expired' },
    );
    expect(expired.outcome).toEqual({ ok: true, result: 'expired' });
    const reject = await run('feature.decide', { id: REQUEST_1, verdict: 'reject' });
    expect(reject.outcome).toEqual({ ok: false, code: 'reason_required' });
    expect(reject.calls).toHaveLength(0);
    const rejectGood = await run(
      'feature.decide',
      { id: REQUEST_1, verdict: 'reject', note: 'Evidence does not match the request' },
      { id: REQUEST_1, status: 'rejected' },
    );
    expect(rejectGood.calls[0]?.body).toEqual({
      approve: false,
      note: 'Evidence does not match the request',
    });
    expect(rejectGood.outcome).toEqual({ ok: true, result: 'rejected' });
    // An answer the screen does not know is not carried to the address.
    const odd = await run(
      'feature.decide',
      { id: REQUEST_1, verdict: 'approve' },
      { id: REQUEST_1, status: 'done_somehow' },
    );
    expect(odd.outcome).toEqual({ ok: true });
    expect((await run('feature.decide', { id: REQUEST_1, verdict: 'maybe' })).calls).toHaveLength(
      0,
    );
  });

  it('cancels a request on its own path', async () => {
    const cancel = await run('feature.cancel', { id: REQUEST_1 });
    expect(cancel.calls[0]).toMatchObject({
      path: `/v1/platform/feature-change-requests/${REQUEST_1}/cancel`,
      body: {},
    });
    expect((await run('feature.cancel', { id: 'x' })).calls).toHaveLength(0);
  });

  it('switches off in an emergency only with a confirmation and a reason', async () => {
    const base = { lenderId: LENDER_A, feature: 'payments' };
    const unconfirmed = await run('feature.kill', { ...base, reason: 'Provider reported a fault' });
    expect(unconfirmed.outcome).toEqual({ ok: false, code: 'confirm_required' });
    expect(unconfirmed.calls).toHaveLength(0);
    for (const confirm of ['off', 'true', 'yes', '']) {
      const r = await run('feature.kill', {
        ...base,
        reason: 'Provider reported a fault',
        confirm,
      });
      expect(r.calls, confirm).toHaveLength(0);
    }
    const noReason = await run('feature.kill', { ...base, confirm: 'on' });
    expect(noReason.outcome).toEqual({ ok: false, code: 'reason_required' });
    expect(
      (await run('feature.kill', { ...base, confirm: 'on', reason: 'too short' })).calls,
    ).toHaveLength(0);
    const good = await run('feature.kill', {
      ...base,
      confirm: 'on',
      reason: 'Provider reported a fault',
    });
    expect(good.outcome).toEqual({ ok: true });
    expect(good.calls[0]).toMatchObject({
      path: '/v1/platform/features/kill',
      body: { lenderId: LENDER_A, feature: 'payments', reason: 'Provider reported a fault' },
    });
    // The body of a kill carries no way to switch anything on.
    expect(Object.keys(good.calls[0]?.body as object).sort()).toEqual([
      'feature',
      'lenderId',
      'reason',
    ]);
  });
});

describe('platform exceptions', () => {
  it('acknowledges and assigns', async () => {
    const ack = await run('exception.acknowledge', { id: EXCEPTION_1 });
    expect(ack.calls[0]).toMatchObject({
      path: `/v1/lender/reconciliation/exceptions/${EXCEPTION_1}/acknowledge`,
      body: {},
    });
    const assign = await run('exception.assign', { id: EXCEPTION_1, assignee: LENDER_B });
    expect(assign.calls[0]).toMatchObject({
      path: `/v1/lender/reconciliation/exceptions/${EXCEPTION_1}/assign`,
      body: { assignee: LENDER_B },
    });
    const none = await run('exception.assign', { id: EXCEPTION_1, assignee: 'me' });
    expect(none.outcome).toEqual({ ok: false, code: 'assignee_invalid' });
    expect(none.calls).toHaveLength(0);
  });

  it('resolves with a reason from the closed list and one to three references to what was checked', async () => {
    const good = await run('exception.resolve', {
      id: EXCEPTION_1,
      reasonCode: 'verified_with_provider',
      evidence1: 'PROVIDER-TICKET-77',
      evidence3: 'statement/2026-10',
      note: 'Provider confirmed the merchant',
    });
    expect(good.calls[0]).toMatchObject({
      path: `/v1/lender/reconciliation/exceptions/${EXCEPTION_1}/resolve`,
      body: {
        reasonCode: 'verified_with_provider',
        evidence: ['PROVIDER-TICKET-77', 'statement/2026-10'],
        note: 'Provider confirmed the merchant',
      },
    });
    for (const bad of [
      { reasonCode: 'because' },
      { reasonCode: '' },
      { evidence1: '' },
      { evidence1: 'has spaces' },
      { evidence1: 'x'.repeat(101) },
    ]) {
      const r = await run('exception.resolve', {
        id: EXCEPTION_1,
        reasonCode: 'verified_with_provider',
        evidence1: 'PROVIDER-TICKET-77',
        ...bad,
      });
      expect(r.calls, JSON.stringify(bad)).toHaveLength(0);
    }
    const none = await run('exception.resolve', {
      id: EXCEPTION_1,
      reasonCode: 'no_action_needed',
    });
    expect(none.outcome).toEqual({ ok: false, code: 'evidence_required' });
    expect(
      (
        await run('exception.resolve', {
          id: EXCEPTION_1,
          reasonCode: 'no_action_needed',
          evidence1: 'T-1',
          note: 'x'.repeat(501),
        })
      ).calls,
    ).toHaveLength(0);
  });

  it('reopens only with a reason that is on the reopen list', async () => {
    const good = await run('exception.reopen', {
      id: EXCEPTION_1,
      reasonCode: 'new_information',
      note: 'Provider wrote again',
    });
    expect(good.calls[0]).toMatchObject({
      path: `/v1/lender/reconciliation/exceptions/${EXCEPTION_1}/reopen`,
      body: { reasonCode: 'new_information', note: 'Provider wrote again' },
    });
    // A reason that only fits a resolution is refused before any call.
    const wrong = await run('exception.reopen', {
      id: EXCEPTION_1,
      reasonCode: 'duplicate_confirmed',
    });
    expect(wrong.calls).toHaveLength(0);
  });
});

// -------------------------------------------------------------------------------------------------------------------
describe('where a form may go back to', () => {
  it('allows only the operations pages of this portal', () => {
    for (const ok of [
      '/providers',
      '/providers?provider=sample_pay',
      '/accounts',
      '/accounts/rules',
      '/accounts/settlement?linked=false',
      '/accounts/merchants?status=active&verification=unverified',
      '/features',
      `/features?lenderId=${LENDER_A}`,
      '/exceptions',
      `/exceptions/${EXCEPTION_1}`,
      '/exceptions?view=resolved&severity=critical',
    ])
      expect(safeAccountsReturnPath(ok), ok).toBe(ok);
    for (const bad of [
      'https://evil.example/accounts',
      '//evil.example',
      '/onboarding',
      '/transactions',
      '/accounts/../admin',
      '/accounts/other',
      '/accounts?x=<script>',
      '/accounts#frag',
      '/exceptions/not-an-id',
      '',
      null,
      undefined,
      42,
    ])
      expect(safeAccountsReturnPath(bad), String(bad)).toBe('/accounts');
  });

  it('puts nothing about a success in the address, only a short error code, and drops an older notice', () => {
    expect(accountsNoticeUrl('/accounts', { ok: true })).toBe('/accounts');
    expect(
      accountsNoticeUrl('/accounts?status=verified&done=1&error=x&registered=y', { ok: true }),
    ).toBe('/accounts?status=verified');
    expect(accountsNoticeUrl('/features', { ok: true, result: 'applied' })).toBe('/features');
    expect(accountsNoticeUrl('/features?done=1&result=applied', { ok: true })).toBe('/features');
    expect(accountsNoticeUrl('/features', { ok: true, result: '<b>' })).toBe('/features');
    expect(accountsNoticeUrl('/features', { ok: false, code: 'self_approval' })).toBe(
      '/features?error=self_approval',
    );
    expect(accountsNoticeUrl('/features', { ok: false, code: 'Raw Text 42' })).toBe(
      '/features?error=unknown',
    );
    expect(
      accountsNoticeUrl('/features', {
        ok: false,
        code: 'prerequisites_unmet',
        reasons: ['payment_config_missing', 'Bad Reason'],
      }),
    ).toBe('/features?error=prerequisites_unmet&reasons=payment_config_missing');
  });

  it('writes a success notice with the known decision and the new entry only, and none for a failure', () => {
    expect(accountsFlashFor({ ok: true, result: 'applied' })).toEqual({ result: 'applied' });
    expect(accountsFlashFor({ ok: true, result: '<b>' })).toEqual({});
    expect(accountsFlashFor({ ok: true })).toEqual({});
    expect(accountsFlashFor({ ok: true, created: { id: '123456789012' } })).toEqual({});
    expect(accountsFlashFor({ ok: false, code: 'self_approval' })).toBeUndefined();
  });
});

// -------------------------------------------------------------------------------------------------------------------
describe('the account number: typed once, posted once, to one route, and never anywhere else', () => {
  const registered = {
    id: REGISTRY_1,
    maskedRef: `XXXXXX${CANARY_LAST_FOUR}`,
    status: 'unverified',
  };
  const fields = {
    accountNumber: CANARY_ACCOUNT,
    ifsc: CANARY_BRANCH_CODE.toLowerCase(),
    country: 'in',
    accountType: 'bank_account',
    ownerKind: 'lender',
    ownerOrgId: LENDER_A,
    legalOwnerName: 'Sample Finance Ltd',
    permittedPurposes: ['repayment_settlement'],
  };
  const everywhere = (value: unknown) => JSON.stringify(value) ?? '';
  const count = (text: string, needle: string) => text.split(needle).length - 1;

  it('is refused by the general entry point, whatever the form says', async () => {
    const rec = recordingApi(registered);
    const outcome = await runAccountsOperation(
      rec.api,
      formOf({ op: 'account.register', ...fields }),
      'ops',
    );
    expect(outcome).toEqual({ ok: false, code: 'path_not_allowed' });
    expect(rec.calls).toHaveLength(0);
    expect(everywhere(outcome)).not.toContain(CANARY_ACCOUNT);
  });

  it('is served by its own entry point, which ignores the form’s own operation name', async () => {
    const rec = recordingApi(registered);
    // A form that names another operation still registers (and only registers): it cannot be used to run anything else.
    const outcome = await runAccountRegistration(
      rec.api,
      formOf({
        op: 'account.revoke',
        id: REGISTRY_1,
        reason: 'a reason of enough length',
        ...fields,
      }),
      'ops',
    );
    expect(outcome).toEqual({ ok: true, created: { id: REGISTRY_1 } });
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]?.path).toBe('/v1/platform/accounts');
    expect(await runAccountRegistration(rec.api, formOf(fields), 'lender')).toEqual({
      ok: false,
      code: 'path_not_allowed',
    });
    expect(rec.calls).toHaveLength(1);
  });

  it('puts the number in the body of the one registration request exactly once, and nowhere in the call', async () => {
    const rec = recordingApi(registered);
    const form = formOf({ op: 'account.register', ...fields });
    await runAccountRegistration(rec.api, form, 'ops');
    expect(rec.calls).toHaveLength(1);
    const call = rec.calls[0];
    expect(call?.path).toBe('/v1/platform/accounts');
    expect(count(everywhere(call?.body), CANARY_ACCOUNT)).toBe(1);
    expect(call?.path).not.toContain(CANARY_ACCOUNT);
    expect(call?.requestId).not.toContain(CANARY_ACCOUNT);
    expect(call?.body).toMatchObject({
      accountNumber: CANARY_ACCOUNT,
      ifsc: CANARY_BRANCH_CODE,
      country: 'IN',
      accountType: 'bank_account',
      ownerKind: 'lender',
      ownerOrgId: LENDER_A,
      legalOwnerName: 'Sample Finance Ltd',
      permittedPurposes: ['repayment_settlement'],
    });
    expect(rec.reads).toEqual([]);
  });

  it('sends exactly one request on the wire, with the number only in its body', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const client = createPlatformClient({
      baseUrl: 'https://api.example',
      getAccessToken: () => Promise.resolve('sample-access-value'),
      fetch: ((url: string, init: RequestInit) => {
        calls.push({ url, init });
        return Promise.resolve(new Response(JSON.stringify(registered), { status: 201 }));
      }) as unknown as typeof fetch,
    });
    const outcome = await runAccountRegistration(client, formOf(fields), 'ops');
    expect(outcome).toEqual({ ok: true, created: { id: REGISTRY_1 } });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.example/v1/platform/accounts');
    expect(calls[0]?.init.method).toBe('POST');
    const sent = calls[0]?.init.body;
    expect(typeof sent).toBe('string');
    expect(count(typeof sent === 'string' ? sent : '', CANARY_ACCOUNT)).toBe(1);
    expect(calls[0]?.url).not.toContain(CANARY_ACCOUNT);
    expect(everywhere(calls[0]?.init.headers)).not.toContain(CANARY_ACCOUNT);
    expect(everywhere(calls[0]?.init.headers)).not.toContain(CANARY_BRANCH_CODE);
  });

  it('hands back the identifier of the new entry and nothing that was typed, not even the masked reference', async () => {
    const rec = recordingApi(registered);
    const outcome = await runAccountRegistration(rec.api, formOf(fields), 'ops');
    expect(outcome).toEqual({ ok: true, created: { id: REGISTRY_1 } });
    const text = everywhere(outcome);
    for (const forbidden of [CANARY_ACCOUNT, CANARY_LAST_FOUR, CANARY_BRANCH_CODE, 'XXXXXX'])
      expect(text).not.toContain(forbidden);
  });

  it('goes next to the registry, or to a short code, and nothing typed is in the address', async () => {
    const rec = recordingApi(registered);
    const outcome = await runAccountRegistration(rec.api, formOf(fields), 'ops');
    const url = accountRegisteredUrl(outcome);
    // The identifier of the new entry is the notice the server writes (accountsFlashFor), not part of the address.
    expect(url).toBe('/accounts');
    expect(accountsFlashFor(outcome)).toEqual({ registered: REGISTRY_1 });
    for (const forbidden of [CANARY_ACCOUNT, CANARY_LAST_FOUR, CANARY_BRANCH_CODE, 'XXXXXX'])
      expect(url).not.toContain(forbidden);
    expect(accountRegisteredUrl({ ok: false, code: 'account_number_invalid' })).toBe(
      '/accounts?error=account_number_invalid',
    );
    expect(accountRegisteredUrl({ ok: false, code: `bad ${CANARY_ACCOUNT}` })).toBe(
      '/accounts?error=unknown',
    );
    // A success without an identifier is not shown as one.
    expect(accountRegisteredUrl({ ok: true })).toBe('/accounts?error=bad_response');
    expect(accountRegisteredUrl({ ok: true, created: { id: CANARY_ACCOUNT } })).toBe(
      '/accounts?error=bad_response',
    );
  });

  it('refuses a malformed number or IFSC with a fixed code and without naming the value or calling the API', async () => {
    const cases: [Record<string, string>, string][] = [
      [{ accountNumber: `${CANARY_ACCOUNT}x` }, 'account_number_invalid'],
      [{ accountNumber: `${CANARY_ACCOUNT} 1` }, 'account_number_invalid'],
      [{ accountNumber: '' }, 'account_number_invalid'],
      [{ accountNumber: '1'.repeat(35) }, 'account_number_invalid'],
      [{ ifsc: `${CANARY_BRANCH_CODE}9` }, 'ifsc_invalid'],
      [{ ifsc: '' }, 'ifsc_invalid'],
      [{ ownerKind: 'lender', ownerOrgId: '' }, 'owner_invalid'],
      [{ ownerKind: 'udofin' }, 'owner_invalid'],
      [{ ownerKind: 'somebody' }, 'owner_invalid'],
      [{ effectiveFrom: '2026-02-30' }, 'dates_invalid'],
    ];
    for (const [change, code] of cases) {
      const rec = recordingApi(registered);
      const outcome = await runAccountRegistration(
        rec.api,
        formOf({ ...fields, ...change }),
        'ops',
      );
      expect(outcome, JSON.stringify(change)).toEqual({ ok: false, code });
      expect(rec.calls).toHaveLength(0);
      expect(everywhere(outcome)).not.toContain(CANARY_ACCOUNT);
    }
    // No purpose chosen: the contract needs at least one, and the request is not sent.
    const rec = recordingApi(registered);
    const { permittedPurposes: _none, ...noPurpose } = fields;
    expect(await runAccountRegistration(rec.api, formOf(noPurpose), 'ops')).toEqual({
      ok: false,
      code: 'validation_failed',
    });
    expect(rec.calls).toHaveLength(0);
  });

  it('takes an owner organisation only for a lender, and sends none for another owner', async () => {
    const rec = recordingApi(registered);
    const { ownerOrgId: _lender, ...rest } = fields;
    await runAccountRegistration(
      rec.api,
      formOf({ ...rest, ownerKind: 'group_company', permittedPurposes: ['fee_collection'] }),
      'ops',
    );
    expect(rec.calls[0]?.body).toMatchObject({ ownerKind: 'group_company' });
    expect(Object.keys(rec.calls[0]?.body as object)).not.toContain('ownerOrgId');
  });

  it('passes the entry being re-registered, for a key rotation, and refuses a malformed one', async () => {
    const rec = recordingApi(registered);
    await runAccountRegistration(
      rec.api,
      formOf({ ...fields, rekeysRegistryId: REGISTRY_2 }),
      'ops',
    );
    expect(rec.calls[0]?.body).toMatchObject({ rekeysRegistryId: REGISTRY_2 });
    const bad = recordingApi(registered);
    expect(
      await runAccountRegistration(bad.api, formOf({ ...fields, rekeysRegistryId: 'x' }), 'ops'),
    ).toEqual({
      ok: false,
      code: 'rekey_invalid',
    });
    expect(bad.calls).toHaveLength(0);
  });

  it('shows no number in any refusal, even when the server writes it back', async () => {
    for (const code of [
      'account_number_invalid',
      'account_already_registered',
      'key_management_unavailable',
    ]) {
      const client = createPlatformClient({
        baseUrl: 'https://api.example',
        getAccessToken: () => Promise.resolve('sample-access-value'),
        fetch: () =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                code,
                title: `Account ${CANARY_ACCOUNT} refused`,
                detail: `${CANARY_ACCOUNT} at ${CANARY_BRANCH_CODE}`,
              }),
              { status: 422 },
            ),
          ),
      });
      const outcome = await runAccountRegistration(client, formOf(fields), 'ops');
      expect(outcome).toEqual({ ok: false, code });
      const text = everywhere(outcome) + accountRegisteredUrl(outcome) + accountsErrorMessage(code);
      for (const forbidden of [CANARY_ACCOUNT, CANARY_BRANCH_CODE])
        expect(text).not.toContain(forbidden);
    }
  });

  it('shows no number when the request itself fails or throws', async () => {
    const throwing = {
      get: () => Promise.reject(new Error(`unexpected ${CANARY_ACCOUNT}`)),
      post: () => Promise.reject(new Error(`unexpected ${CANARY_ACCOUNT} ${CANARY_BRANCH_CODE}`)),
    };
    const outcome = await runAccountRegistration(throwing, formOf(fields), 'ops');
    expect(outcome).toEqual({ ok: false, code: 'network_error' });
    expect(everywhere(outcome)).not.toContain(CANARY_ACCOUNT);
    const wire = createPlatformClient({
      baseUrl: 'https://api.example',
      getAccessToken: () => Promise.resolve('sample-access-value'),
      fetch: () => Promise.reject(new Error(`socket closed after ${CANARY_ACCOUNT}`)),
    });
    const viaClient = await runAccountRegistration(wire, formOf(fields), 'ops');
    expect(viaClient).toEqual({ ok: false, code: 'network_error' });
    expect(accountRegisteredUrl(viaClient)).toBe('/accounts?error=network_error');
  });

  it('reports an answer it cannot use as a failure and never as a registration', async () => {
    const rec = recordingApi({ id: 'not-an-id' });
    expect(await runAccountRegistration(rec.api, formOf(fields), 'ops')).toEqual({
      ok: false,
      code: 'bad_response',
    });
  });

  it('refuses a missing or malformed request id before reading the form', async () => {
    const rec = recordingApi(registered);
    const form = formOf({ ...fields, key: 'short' });
    expect(await runAccountRegistration(rec.api, form, 'ops')).toEqual({
      ok: false,
      code: 'validation_failed',
    });
    expect(rec.calls).toHaveLength(0);
  });
});
