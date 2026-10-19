// @vitest-environment node
// Phase 08a review fixes (P2), the logic that needs no browser: the own-account list (attest, withdraw), the release of a hold on
// a payment configuration, the new loaders and paths, the words for the new answers of the API, and that nothing a person typed
// (an evidence reference, a reason) reaches an address, a notice or a log line.
import { describe, expect, it, vi } from 'vitest';
import { openFlash, sealFlash } from '../src/flash.js';
import { createPlatformClient } from '../src/accounts/client.js';
import {
  loadOwnAccountList,
  loadSuspendedConfigs,
  mayAttestOwnList,
  mayReleaseHold,
  mayWithdrawOwnList,
  platformCaps,
} from '../src/accounts/data.js';
import {
  accountsFlashFor,
  accountsNoticeUrl,
  ACCOUNTS_OPERATIONS,
  runAccountRegistration,
  runAccountsOperation,
  safeAccountsReturnPath,
} from '../src/accounts/operations.js';
import {
  accountsErrorMessage,
  decisionResultWords,
  DECISION_RESULTS,
  featureReasonWords,
  holdKindWords,
  nextStepsFor,
  ownListEventWords,
  paymentConfigReasonWords,
  releaseRuleWords,
} from '../src/accounts/wording.js';
import {
  CONFIG_1,
  CONFIG_2,
  formOf,
  LENDER_A,
  ownListEvent,
  ownListState,
  paymentConfig,
  recordingApi,
} from './accounts-fixtures.js';

const GENERIC = 'The action could not be completed. Nothing was changed.';
const EVIDENCE = 'Sample reconciliation sheet 4';
const REASON = 'The cause of the hold is resolved';

const run = async (
  op: string,
  fields: Record<string, string | string[]>,
  answer: unknown = {},
  failWith?: { status: number; code: string },
) => {
  const rec = recordingApi(answer, {}, failWith);
  const outcome = await runAccountsOperation(rec.api, formOf({ op, ...fields }), 'ops');
  return { ...rec, outcome };
};

const attestFields = { evidenceRef: EVIDENCE, confirm: 'on' };
const released = (id = CONFIG_1) => ({ id, status: 'suspended' });

// -------------------------------------------------------------------------------------------------------------------
describe('the new answers of the API, in plain words that name what to do next', () => {
  const CODES = [
    'own_account_list_not_attested',
    'own_account_list_incomplete',
    'platform_hold',
    'active_config_exists',
    'merchant_already_claimed',
    'self_approval',
    'forbidden',
    'mfa_required',
    'not_found',
    'config_state_invalid',
    'attest_confirm_required',
    'evidence_invalid',
    'reason_required',
    'reason_invalid',
    'key_version_not_active',
  ];

  it('words every code of the new routes, with no code and no value in the sentence', () => {
    for (const code of CODES) {
      const words = accountsErrorMessage(code);
      expect(words, code).not.toBe(GENERIC);
      expect(words, code).not.toContain(code);
      expect(words, code).not.toMatch(/SQLSTATE|\d{4,}/);
    }
  });

  it('says what to do next for the three that have a next step', () => {
    expect(accountsErrorMessage('own_account_list_not_attested')).toMatch(
      /Attest the list first, then try again/,
    );
    expect(accountsErrorMessage('own_account_list_incomplete')).toMatch(
      /Register and verify those accounts first/,
    );
    expect(accountsErrorMessage('platform_hold')).toMatch(/Release the hold first, then try again/);
    expect(accountsErrorMessage('active_config_exists')).toMatch(/retires the other one first/);
    for (const code of [
      'own_account_list_not_attested',
      'own_account_list_incomplete',
      'platform_hold',
      'active_config_exists',
    ])
      expect(accountsErrorMessage(code), code).toMatch(/Nothing was (changed|recorded)/);
  });

  it('says a merchant claim cannot be verified because another claim of it is verified', () => {
    expect(accountsErrorMessage('merchant_already_claimed')).toMatch(
      /Another claim of this merchant reference is already verified/,
    );
  });

  it('claims no compliance, approval or safety in any of them', () => {
    const everything = [
      ...CODES.map(accountsErrorMessage),
      ...DECISION_RESULTS.map((r) => decisionResultWords(r) ?? ''),
      featureReasonWords('own_account_list_not_attested'),
      holdKindWords('platform'),
      holdKindWords('system'),
      holdKindWords(null),
      releaseRuleWords('platform') ?? '',
      releaseRuleWords('system') ?? '',
    ];
    for (const words of everything)
      expect(words).not.toMatch(/complian|regulat|\bRBI\b|\bsafe\b|\bsafety\b|\bsecure\b/i);
  });

  it('links a next step by a fixed page chosen by the code, once each, in order', () => {
    expect(nextStepsFor('own_account_list_not_attested', [])).toEqual([
      { href: '/accounts/own-accounts', label: 'Open the own-account list' },
    ]);
    expect(nextStepsFor('platform_hold', [])).toEqual([
      { href: '/providers/holds', label: 'Open the suspended payment configurations' },
    ]);
    expect(nextStepsFor('own_account_list_incomplete', [])[0]?.href).toBe('/accounts');
    // A refused switch request lists its reasons: the same step is not offered twice.
    expect(
      nextStepsFor('prerequisites_unmet', [
        'own_account_list_not_attested',
        'payment_config_missing',
        'own_account_list_not_attested',
      ]),
    ).toEqual([{ href: '/accounts/own-accounts', label: 'Open the own-account list' }]);
    expect(
      nextStepsFor('own_account_list_not_attested', ['own_account_list_not_attested']),
    ).toHaveLength(1);
    // Nothing the server wrote chooses a link.
    for (const hostile of [
      'constructor',
      '__proto__',
      'toString',
      'https://evil.example',
      undefined,
    ])
      expect(nextStepsFor(hostile, ['constructor', '__proto__'])).toEqual([]);
  });

  it('words the unmet prerequisite of the own-account list and no other raw code', () => {
    expect(featureReasonWords('own_account_list_not_attested')).toMatch(
      /Attest it first, on the Own-account list page/,
    );
    expect(featureReasonWords('own_account_list_not_attested')).not.toContain('_');
  });

  it('words the three results of the new actions, and no result for any other text', () => {
    expect(decisionResultWords('attested')).toMatch(/platform’s own statement/);
    expect(decisionResultWords('attestation_withdrawn')).toMatch(/cannot be verified or linked/);
    expect(decisionResultWords('hold_released')).toMatch(/stays suspended/);
    expect(decisionResultWords('hold_released')).toMatch(/a different approver at the lender/);
    expect(decisionResultWords('<b>')).toBeNull();
  });

  it('words the events and the holds, and says the rule for lifting each kind before anybody tries', () => {
    expect(ownListEventWords('attested')).toBe('Attested');
    expect(ownListEventWords('withdrawn')).toBe('Attestation withdrawn');
    expect(ownListEventWords('toString')).toMatch(/no wording/);
    expect(ownListEventWords('toString')).not.toContain('toString');
    expect(holdKindWords('platform')).toMatch(/Held by the platform/);
    expect(holdKindWords('system')).toMatch(/Held by the system \(the nightly check/);
    expect(holdKindWords(null)).toMatch(/Suspended without a hold/);
    expect(holdKindWords('constructor')).toMatch(/no wording/);
    expect(releaseRuleWords('platform')).toMatch(/only by a different member of staff/);
    expect(releaseRuleWords('platform')).toMatch(/does not say who set it/);
    expect(releaseRuleWords('system')).toMatch(/any member of staff who may manage providers/);
    expect(releaseRuleWords('constructor')).toBeNull();
  });

  it('reuses the lender wording for the reason codes of a suspended configuration', () => {
    expect(paymentConfigReasonWords('platform_suspension')).toBe('The platform team suspended it.');
    expect(paymentConfigReasonWords('merchant_mismatch')).toMatch(/different merchant/);
    expect(paymentConfigReasonWords('brand_new_code')).not.toContain('brand_new_code');
  });
});

// -------------------------------------------------------------------------------------------------------------------
describe('who may do what, and what is asked of the API', () => {
  it('reads the three rights of the new screens from the four platform permissions', () => {
    const verifier = platformCaps(['platform.accounts.registry.verify']);
    const manager = platformCaps(['platform.accounts.registry.manage']);
    const providers = platformCaps(['platform.payments.providers.manage']);
    const nobody = platformCaps([]);
    expect([
      mayAttestOwnList(verifier),
      mayAttestOwnList(manager),
      mayAttestOwnList(providers),
    ]).toEqual([true, false, false]);
    expect([
      mayWithdrawOwnList(verifier),
      mayWithdrawOwnList(manager),
      mayWithdrawOwnList(providers),
    ]).toEqual([true, true, false]);
    expect([mayReleaseHold(providers), mayReleaseHold(verifier), mayReleaseHold(manager)]).toEqual([
      true,
      false,
      false,
    ]);
    for (const may of [mayAttestOwnList, mayWithdrawOwnList, mayReleaseHold])
      expect(may(nobody)).toBe(false);
  });

  it('asks for the own-account list on its one route', async () => {
    const rec = recordingApi({}, { '/v1/platform/own-account-list': ownListState() });
    const result = await loadOwnAccountList(rec.api);
    expect(result.ok).toBe(true);
    expect(rec.reads).toEqual(['/v1/platform/own-account-list']);
  });

  it('asks for suspended configurations only, with the lender and the page position when they are well formed', async () => {
    const rec = recordingApi();
    await loadSuspendedConfigs(rec.api, {});
    await loadSuspendedConfigs(rec.api, { lenderId: LENDER_A, cursor: 'abc_DEF-1' });
    expect(rec.reads).toEqual([
      '/v1/platform/payment-configs?limit=25&status=suspended',
      `/v1/platform/payment-configs?limit=25&cursor=abc_DEF-1&lenderId=${LENDER_A}&status=suspended`,
    ]);
  });

  it('declares every new operation for the operations portal only', () => {
    for (const name of ['ownlist.attest', 'ownlist.withdraw', 'hold.release'])
      expect(ACCOUNTS_OPERATIONS[name]?.portals, name).toEqual(['ops']);
  });

  it('refuses all three from the lender portal without calling the API', async () => {
    const { api, calls } = recordingApi();
    for (const [op, fields] of [
      ['ownlist.attest', attestFields],
      ['ownlist.withdraw', { reason: REASON }],
      ['hold.release', { id: CONFIG_1, reason: REASON }],
    ] as const)
      expect(await runAccountsOperation(api, formOf({ op, ...fields }), 'lender'), op).toEqual({
        ok: false,
        code: 'path_not_allowed',
      });
    expect(calls).toEqual([]);
  });
});

// -------------------------------------------------------------------------------------------------------------------
describe('attesting the own-account list', () => {
  it('sends the evidence reference and the note to the one route, checks the answer, and says what was recorded', async () => {
    const { outcome, calls } = await run(
      'ownlist.attest',
      { ...attestFields, note: 'Checked against the sheet' },
      ownListState(),
    );
    expect(outcome).toEqual({ ok: true, result: 'attested' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      path: '/v1/platform/own-account-list/attest',
      body: { evidenceRef: EVIDENCE, note: 'Checked against the sheet' },
    });
  });

  it('sends no note when none was written', async () => {
    const { calls } = await run('ownlist.attest', attestFields, ownListState());
    expect(calls[0]?.body).toEqual({ evidenceRef: EVIDENCE });
  });

  it('needs the deliberate tick, and sends nothing without it', async () => {
    for (const confirm of [undefined, '', 'yes', 'true', 'ON']) {
      const fields: Record<string, string> = { evidenceRef: EVIDENCE };
      if (confirm !== undefined) fields.confirm = confirm;
      const { outcome, calls } = await run('ownlist.attest', fields, ownListState());
      expect(outcome, String(confirm)).toEqual({ ok: false, code: 'attest_confirm_required' });
      expect(calls).toEqual([]);
    }
  });

  it('needs a reference to the evidence of the right shape, and sends nothing for a bad one', async () => {
    for (const evidenceRef of [
      '',
      '   ',
      'ab',
      'x'.repeat(201),
      'Account 123456789012 sheet',
      'ABCDE1234F sheet',
      '<script>alert(1)</script>',
      '../../etc',
    ]) {
      const { outcome, calls } = await run(
        'ownlist.attest',
        { confirm: 'on', evidenceRef },
        ownListState(),
      );
      expect(outcome, evidenceRef).toEqual({ ok: false, code: 'evidence_invalid' });
      expect(calls).toEqual([]);
    }
    expect((await run('ownlist.attest', { confirm: 'on' }, ownListState())).calls).toEqual([]);
  });

  it('refuses a note with a long number or over 1000 characters before it is sent', async () => {
    for (const note of ['Account 123456789012 is fine', 'x'.repeat(1001)]) {
      const { outcome, calls } = await run(
        'ownlist.attest',
        { ...attestFields, note },
        ownListState(),
      );
      expect(outcome, note.slice(0, 20)).toEqual({ ok: false, code: 'validation_failed' });
      expect(calls).toEqual([]);
    }
  });

  it('does not call an answer an attestation unless the list is attested in it', async () => {
    for (const answer of [
      ownListState({ attested: false }),
      { keyVersion: 1, attested: 'yes', events: [] },
      { attested: true },
      {},
      'attested',
    ]) {
      const { outcome } = await run('ownlist.attest', attestFields, answer);
      expect(outcome, JSON.stringify(answer)).toEqual({ ok: false, code: 'bad_response' });
    }
  });

  it('sends the same request key again for a double click, so the API applies it once', async () => {
    const rec = recordingApi(ownListState());
    const form = formOf({ op: 'ownlist.attest', ...attestFields });
    await runAccountsOperation(rec.api, form, 'ops');
    await runAccountsOperation(rec.api, form, 'ops');
    expect(rec.calls).toHaveLength(2);
    expect(rec.calls[1]?.requestId).toBe(rec.calls[0]?.requestId);
    expect(rec.calls[0]?.requestId).toMatch(/^ui-/);
  });

  it('refuses a request key of the wrong shape or none, without calling the API', async () => {
    const rec = recordingApi(ownListState());
    const form = formOf({ op: 'ownlist.attest', ...attestFields, key: 'short' });
    expect(await runAccountsOperation(rec.api, form, 'ops')).toEqual({
      ok: false,
      code: 'validation_failed',
    });
    expect(rec.calls).toEqual([]);
  });

  it.each([
    [409, 'own_account_list_incomplete'],
    [409, 'key_version_not_active'],
    [403, 'forbidden'],
    [401, 'mfa_required'],
    [422, 'evidence_invalid'],
    [422, 'reason_invalid'],
    [429, 'rate_limited'],
  ])(
    'turns the answer %i %s into the code and a sentence, never the text the API wrote',
    async (status, code) => {
      const { outcome, calls } = await run('ownlist.attest', attestFields, {}, { status, code });
      expect(outcome).toEqual({ ok: false, code });
      expect(calls).toHaveLength(1);
      expect(accountsErrorMessage(code), code).not.toBe(GENERIC);
    },
  );

  it('turns text the server wrote into the generic sentence', async () => {
    const { outcome } = await run(
      'ownlist.attest',
      attestFields,
      {},
      {
        status: 409,
        code: `Some raw text! ${EVIDENCE}`,
      },
    );
    expect(outcome).toEqual({ ok: false, code: 'unknown' });
    expect(accountsErrorMessage('unknown')).toBe(GENERIC);
  });

  it('keeps the evidence reference and the note out of the outcome, the address, the notice and every log line', async () => {
    const spies = (['log', 'warn', 'error', 'info', 'debug'] as const).map((name) =>
      vi.spyOn(console, name).mockImplementation(() => undefined),
    );
    const note = 'Checked against the sheet';
    const ok = await run('ownlist.attest', { ...attestFields, note }, ownListState());
    const refused = await run(
      'ownlist.attest',
      { ...attestFields, note },
      {},
      {
        status: 409,
        code: 'own_account_list_incomplete',
      },
    );
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
    for (const outcome of [ok.outcome, refused.outcome]) {
      expect(JSON.stringify(outcome)).not.toContain(EVIDENCE);
      expect(JSON.stringify(outcome)).not.toContain(note);
      const address = accountsNoticeUrl('/accounts/own-accounts', outcome);
      expect(address).not.toContain('Sample');
      expect(address).not.toContain('sheet');
      expect(address).not.toMatch(/evidence/i);
    }
    expect(accountsFlashFor(ok.outcome)).toEqual({ result: 'attested' });
    expect(accountsNoticeUrl('/accounts/own-accounts', ok.outcome)).toBe('/accounts/own-accounts');
    expect(accountsNoticeUrl('/accounts/own-accounts', refused.outcome)).toBe(
      '/accounts/own-accounts?error=own_account_list_incomplete',
    );
    expect(ok.calls[0]?.path).toBe('/v1/platform/own-account-list/attest');
    expect(ok.calls[0]?.path).not.toContain('?');
  });

  it('is served by the general entry point, and the registration entry point stays a separate one', async () => {
    const rec = recordingApi(ownListState());
    expect(
      await runAccountRegistration(
        rec.api,
        formOf({ op: 'ownlist.attest', ...attestFields }),
        'ops',
      ),
    ).toMatchObject({ ok: false });
    expect(rec.calls.every((call) => call.path === '/v1/platform/accounts')).toBe(true);
  });
});

// -------------------------------------------------------------------------------------------------------------------
describe('withdrawing the attestation', () => {
  it('sends the reason to the one route and says what the withdrawal means', async () => {
    const { outcome, calls } = await run(
      'ownlist.withdraw',
      { reason: 'An Udofin account was found that is not on the list' },
      ownListState({ attested: false, events: [ownListEvent({ eventKind: 'withdrawn' })] }),
    );
    expect(outcome).toEqual({ ok: true, result: 'attestation_withdrawn' });
    expect(calls[0]).toMatchObject({
      path: '/v1/platform/own-account-list/withdraw',
      body: { reason: 'An Udofin account was found that is not on the list' },
    });
  });

  it('needs a reason of 10 to 1000 plain characters, or sends nothing', async () => {
    const state = ownListState({ attested: false });
    for (const reason of ['', '   ', 'x'.repeat(9), 'x'.repeat(1001)]) {
      const { outcome, calls } = await run('ownlist.withdraw', { reason }, state);
      expect(outcome, String(reason.length)).toEqual({ ok: false, code: 'reason_required' });
      expect(calls).toEqual([]);
    }
    const personal = await run('ownlist.withdraw', { reason: 'Account 123456789012 found' }, state);
    expect(personal.outcome).toEqual({ ok: false, code: 'validation_failed' });
    expect(personal.calls).toEqual([]);
    expect((await run('ownlist.withdraw', { reason: 'x'.repeat(10) }, state)).calls).toHaveLength(
      1,
    );
    expect((await run('ownlist.withdraw', { reason: 'x'.repeat(1000) }, state)).calls).toHaveLength(
      1,
    );
  });

  it('does not call an answer a withdrawal while the list is still attested in it', async () => {
    const { outcome } = await run('ownlist.withdraw', { reason: REASON }, ownListState());
    expect(outcome).toEqual({ ok: false, code: 'bad_response' });
  });

  it.each([
    [403, 'forbidden'],
    [401, 'mfa_required'],
    [422, 'reason_invalid'],
  ])(
    'turns the answer %i %s into the code, and a caller without the right is refused by the API',
    async (status, code) => {
      const { outcome, calls } = await run(
        'ownlist.withdraw',
        { reason: REASON },
        {},
        { status, code },
      );
      expect(outcome).toEqual({ ok: false, code });
      expect(calls).toHaveLength(1);
    },
  );

  it('sends the same request key for a double click', async () => {
    const rec = recordingApi(ownListState({ attested: false }));
    const form = formOf({ op: 'ownlist.withdraw', reason: REASON });
    await runAccountsOperation(rec.api, form, 'ops');
    await runAccountsOperation(rec.api, form, 'ops');
    expect(rec.calls[1]?.requestId).toBe(rec.calls[0]?.requestId);
  });
});

// -------------------------------------------------------------------------------------------------------------------
describe('releasing a hold on a payment configuration', () => {
  it('sends the reason to the configuration’s release route, checks the answer, and says what happened', async () => {
    const { outcome, calls } = await run(
      'hold.release',
      { id: CONFIG_1, reason: REASON },
      released(),
    );
    expect(outcome).toEqual({ ok: true, result: 'hold_released' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      path: `/v1/platform/payment-configs/${CONFIG_1}/release-hold`,
      body: { reason: REASON },
    });
    expect(calls[0]?.path).not.toContain('?');
  });

  it('accepts a reason of exactly 10 and exactly 200 characters, and nothing outside that', async () => {
    for (const length of [10, 200]) {
      const { calls } = await run(
        'hold.release',
        { id: CONFIG_1, reason: 'x'.repeat(length) },
        released(),
      );
      expect(calls, String(length)).toHaveLength(1);
    }
    for (const [reason, code] of [
      ['', 'reason_required'],
      ['         ', 'reason_required'],
      ['x'.repeat(9), 'reason_required'],
      ['x'.repeat(201), 'reason_invalid'],
      ['x'.repeat(1000), 'reason_invalid'],
    ] as const) {
      const { outcome, calls } = await run('hold.release', { id: CONFIG_1, reason }, released());
      expect(outcome, String(reason.length)).toEqual({ ok: false, code });
      expect(calls).toEqual([]);
    }
  });

  it('refuses a reason that carries a long number or a PAN-shaped token, and a missing or bad id', async () => {
    for (const reason of ['Reopened account 123456789012', 'Checked ABCDE1234F again']) {
      const { outcome, calls } = await run('hold.release', { id: CONFIG_1, reason }, released());
      expect(outcome, reason).toEqual({ ok: false, code: 'validation_failed' });
      expect(calls).toEqual([]);
    }
    for (const id of ['', 'nope', '../x', `${CONFIG_1}/x`, CONFIG_1.toUpperCase()]) {
      const { outcome, calls } = await run('hold.release', { id, reason: REASON }, released());
      expect(outcome, id).toEqual({ ok: false, code: 'validation_failed' });
      expect(calls).toEqual([]);
    }
  });

  it('maps the self-approval refusal to the code that explains the rule, and changes nothing', async () => {
    const { outcome, calls } = await run(
      'hold.release',
      { id: CONFIG_1, reason: REASON },
      {},
      {
        status: 403,
        code: 'self_approval',
      },
    );
    expect(outcome).toEqual({ ok: false, code: 'self_approval' });
    expect(calls).toHaveLength(1);
    expect(accountsErrorMessage('self_approval')).toMatch(/A different person must do this step/);
    expect(accountsNoticeUrl('/providers/holds', outcome)).toBe(
      '/providers/holds?error=self_approval',
    );
    expect(accountsFlashFor(outcome)).toBeUndefined();
  });

  it.each([
    [404, 'not_found'],
    [409, 'config_state_invalid'],
    [403, 'forbidden'],
    [401, 'mfa_required'],
    [422, 'reason_invalid'],
    [429, 'rate_limited'],
  ])('turns the answer %i %s into the code and a sentence', async (status, code) => {
    const { outcome } = await run(
      'hold.release',
      { id: CONFIG_1, reason: REASON },
      {},
      { status, code },
    );
    expect(outcome).toEqual({ ok: false, code });
    expect(accountsErrorMessage(code), code).not.toBe(GENERIC);
  });

  it('does not call an answer a release unless it is this configuration, still suspended', async () => {
    for (const answer of [
      { id: CONFIG_1, status: 'active' },
      { id: CONFIG_2, status: 'suspended' },
      { id: CONFIG_1 },
      { status: 'suspended' },
      {},
    ]) {
      const { outcome } = await run('hold.release', { id: CONFIG_1, reason: REASON }, answer);
      expect(outcome, JSON.stringify(answer)).toEqual({ ok: false, code: 'bad_response' });
    }
  });

  it('sends the same request key for a double click, a new one only for a new form', async () => {
    const rec = recordingApi(released());
    const form = formOf({ op: 'hold.release', id: CONFIG_1, reason: REASON });
    await runAccountsOperation(rec.api, form, 'ops');
    await runAccountsOperation(rec.api, form, 'ops');
    await runAccountsOperation(
      rec.api,
      formOf({ op: 'hold.release', id: CONFIG_1, reason: REASON }),
      'ops',
    );
    expect(rec.calls[1]?.requestId).toBe(rec.calls[0]?.requestId);
    expect(rec.calls[2]?.requestId).not.toBe(rec.calls[0]?.requestId);
  });

  it('keeps the reason out of the outcome, the address, the notice and every log line', async () => {
    const spies = (['log', 'warn', 'error', 'info', 'debug'] as const).map((name) =>
      vi.spyOn(console, name).mockImplementation(() => undefined),
    );
    const ok = await run('hold.release', { id: CONFIG_1, reason: REASON }, released());
    const refused = await run(
      'hold.release',
      { id: CONFIG_1, reason: REASON },
      {},
      {
        status: 403,
        code: 'self_approval',
      },
    );
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
    for (const outcome of [ok.outcome, refused.outcome]) {
      expect(JSON.stringify(outcome)).not.toContain(REASON);
      expect(accountsNoticeUrl('/providers/holds?lenderId=' + LENDER_A, outcome)).not.toContain(
        'resolved',
      );
    }
    expect(accountsFlashFor(ok.outcome)).toEqual({ result: 'hold_released' });
    expect(accountsNoticeUrl('/providers/holds', ok.outcome)).toBe('/providers/holds');
  });
});

// -------------------------------------------------------------------------------------------------------------------
describe('the notice that follows the new actions', () => {
  const NOW = Date.UTC(2026, 9, 18, 10, 0, 0);

  it('carries the three results through the short-lived notice and reads them back for the right page only', () => {
    for (const [result, path] of [
      ['attested', '/accounts/own-accounts'],
      ['attestation_withdrawn', '/accounts/own-accounts'],
      ['hold_released', '/providers/holds'],
    ] as const) {
      const sealed = sealFlash({ path, result }, NOW);
      expect(sealed, result).toBeDefined();
      expect(openFlash(sealed, path, NOW)?.result).toBe(result);
      expect(openFlash(sealed, '/accounts', NOW)).toBeUndefined();
    }
  });

  it('lets a form return to the two new pages with their filters, and to no other page', () => {
    for (const ok of [
      '/accounts/own-accounts',
      '/providers/holds',
      `/providers/holds?lenderId=${LENDER_A}&cursor=abc_DEF-1`,
    ])
      expect(safeAccountsReturnPath(ok), ok).toBe(ok);
    for (const bad of [
      '/accounts/own-accounts/x',
      '/accounts/own-accounts?evidenceRef=Sample sheet',
      '/providers/holds/x',
      '//providers/holds',
      'https://evil.example/providers/holds',
    ])
      expect(safeAccountsReturnPath(bad), bad).toBe('/accounts');
  });
});

// -------------------------------------------------------------------------------------------------------------------
describe('through the real platform client', () => {
  const ACCESS = 'sample-access-value';
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const make = (respond: (url: string) => Response) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchStub = vi.fn((url: string, init?: RequestInit) => {
      calls.push({ url, init: init ?? {} });
      return Promise.resolve(respond(url));
    });
    const client = createPlatformClient({
      baseUrl: 'https://api.example/',
      getAccessToken: () => Promise.resolve(ACCESS),
      fetch: fetchStub as unknown as typeof fetch,
    });
    return { client, calls, fetchStub };
  };

  it('sends an attestation once, with the person’s token and the request key, and checks the answer', async () => {
    const { client, calls } = make(() => json(200, ownListState()));
    const form = formOf({ op: 'ownlist.attest', ...attestFields });
    const key = form.get('key');
    expect(await runAccountsOperation(client, form, 'ops')).toEqual({
      ok: true,
      result: 'attested',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.example/v1/platform/own-account-list/attest');
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.body).toBe(JSON.stringify({ evidenceRef: EVIDENCE }));
    expect(calls[0]?.init.headers).toMatchObject({
      authorization: `Bearer ${ACCESS}`,
      'idempotency-key': key,
    });
    expect(calls[0]?.url).not.toContain(EVIDENCE);
  });

  it('reads an answer that does not fit the contract as one it cannot use', async () => {
    const { client } = make(() => json(200, { keyVersion: 'one', attested: true, events: [] }));
    expect(
      await runAccountsOperation(client, formOf({ op: 'ownlist.attest', ...attestFields }), 'ops'),
    ).toEqual({ ok: false, code: 'bad_response' });
  });

  it('keeps only the stable code of a refusal: a person without the right is told so, in words', async () => {
    const problem = {
      type: 'about:blank',
      title: `Forbidden ${EVIDENCE}`,
      status: 403,
      code: 'forbidden',
      detail: `You may not: ${EVIDENCE}`,
    };
    const { client, calls } = make(() => json(403, problem));
    const outcome = await runAccountsOperation(
      client,
      formOf({ op: 'hold.release', id: CONFIG_1, reason: REASON }),
      'ops',
    );
    expect(outcome).toEqual({ ok: false, code: 'forbidden' });
    expect(JSON.stringify(outcome)).not.toContain(EVIDENCE);
    expect(calls).toHaveLength(1);
    expect(accountsErrorMessage('forbidden')).toBe('You are not allowed to do that.');
  });

  it('sends a release to the configuration’s own path and nowhere else, and never retries', async () => {
    const { client, calls } = make(() => json(401, { code: 'mfa_required' }));
    const outcome = await runAccountsOperation(
      client,
      formOf({ op: 'hold.release', id: CONFIG_1, reason: REASON }),
      'ops',
    );
    expect(outcome).toEqual({ ok: false, code: 'mfa_required' });
    expect(calls.map((c) => c.url)).toEqual([
      `https://api.example/v1/platform/payment-configs/${CONFIG_1}/release-hold`,
    ]);
  });

  it('reads the own-account list and the suspended configurations with a plain GET', async () => {
    const { client, calls } = make((url) =>
      url.endsWith('/own-account-list')
        ? json(200, ownListState())
        : json(200, { items: [paymentConfig()], nextCursor: null }),
    );
    const list = await loadOwnAccountList(client);
    const configs = await loadSuspendedConfigs(client, {});
    expect(list.ok && list.data.attested).toBe(true);
    expect(configs.ok && configs.data.items[0]?.holdKind).toBe('platform');
    expect(calls.map((c) => c.init.method)).toEqual(['GET', 'GET']);
    expect(calls.every((c) => c.init.body === undefined)).toBe(true);
  });

  it('shows a hold the older parsers know nothing about as no hold', async () => {
    const { holdKind: _kind, holdSetAt: _at, ...older } = paymentConfig();
    const { client } = make(() => json(200, { items: [older], nextCursor: null }));
    const configs = await loadSuspendedConfigs(client, {});
    expect(configs.ok && configs.data.items[0]?.holdKind).toBeNull();
  });
});
