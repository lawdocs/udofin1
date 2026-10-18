// @vitest-environment jsdom
// The lender reminder screens: every state (loading failure, empty, forbidden, each status and reason), the wording rules, the
// guards that hide a write form from a role that may not use it (and the approve form from the person who drafted), the
// allow-listed operations, and the cross-checks that no screen invents a figure, shows a raw server code or posts anything
// outside the allow-list. Every fixture is parsed by the real contract schema. All people, loans and texts are synthetic.
import {
  LR_ARTEFACT_STATUSES,
  LR_CHANNELS,
  LR_CHARGE_BASES,
  LR_CHARGE_KINDS,
  LR_DELIVERY_ERROR_CLASSES,
  LR_DELIVERY_SOURCES,
  LR_DELIVERY_STATES,
  LR_HOLD_REASONS,
  LR_HOLD_STATUSES,
  LR_REMINDER_KINDS,
  LR_REMINDER_STATUSES,
  LR_SUPPRESS_REASONS,
  LR_TEMPLATE_LANGUAGES,
  LrDelivery,
  LrHold,
  LrPenalText,
  LrPolicy,
  LrReminder,
  LrTemplate,
} from '@udofin/contracts';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type OnboardingApi } from '../src/onboarding/api.js';
import {
  HoldPlaceFields,
  PenalDraftFields,
  PolicyDraftFields,
  TemplateDraftFields,
} from '../src/reminders/draft-forms.js';
import {
  chooseLender,
  loadDeliveries,
  loadHolds,
  loadPenalTexts,
  loadPolicies,
  loadReminders,
  loadSummary,
  loadTemplates,
  mayApprove,
  mayIn,
  mayRetire,
  mayViewArtefacts,
  parseRemindersQuery,
  reminderGrants,
  remindersHref,
  STATUS_FILTERS,
} from '../src/reminders/data.js';
import {
  parseOffsets,
  REMINDERS_OPERATIONS,
  remindersNoticeUrl,
  runRemindersOperation,
  safeRemindersReturnPath,
} from '../src/reminders/operations.js';
import { type RemindersContext } from '../src/reminders/common.js';
import {
  HoldsPage,
  PenalTextPage,
  PolicyPage,
  ReminderAttemptsPage,
  RemindersLogPage,
  WordingPage,
} from '../src/reminders/views.js';
import {
  artefactStatusShort,
  artefactStatusWords,
  channelWords,
  chargeBasisWords,
  chargeKindWords,
  deliveryErrorWords,
  deliverySourceWords,
  deliveryStateWords,
  holdReasonWords,
  holdStatusWords,
  languageWords,
  offsetWords,
  parsePercentToBps,
  percentFromBps,
  reminderKindWords,
  reminderStatusShort,
  reminderStatusWords,
  remindersErrorMessage,
  suppressReasonWords,
} from '../src/reminders/wording.js';

afterEach(cleanup);

// ---------------------------------------------------------------------------------------------------------------------
// Synthetic fixtures
// ---------------------------------------------------------------------------------------------------------------------
const LENDER_A = '0190a000-0000-7000-8000-00000000000a';
const LENDER_B = '0190a000-0000-7000-8000-00000000000b';
const ME = '0190a000-0000-7000-8000-0000000000e1';
const OTHER = '0190a000-0000-7000-8000-0000000000e2';
const THIRD = '0190a000-0000-7000-8000-0000000000e3';
const POLICY = '0190a000-0000-7000-8000-000000000a01';
const POLICY_2 = '0190a000-0000-7000-8000-000000000a02';
const TEMPLATE = '0190a000-0000-7000-8000-000000000b01';
const TEMPLATE_2 = '0190a000-0000-7000-8000-000000000b02';
const PENAL = '0190a000-0000-7000-8000-000000000c01';
const PENAL_2 = '0190a000-0000-7000-8000-000000000c02';
const HOLD = '0190a000-0000-7000-8000-000000000d01';
const HOLD_2 = '0190a000-0000-7000-8000-000000000d02';
const LOAN = '0190a000-0000-7000-8000-000000000101';
const REMINDER = '0190a000-0000-7000-8000-000000000e01';
const REMINDER_2 = '0190a000-0000-7000-8000-000000000e02';
const DELIVERY = '0190a000-0000-7000-8000-000000000f01';
const AT = '2026-10-16T10:15:30.000000+00:00';
const AT_2 = '2026-10-17T04:30:00.000000+00:00';
const SHA_A = 'ab'.repeat(32);
const SHA_B = 'cd'.repeat(32);

const GENERIC = 'The action could not be completed. Nothing was changed.';

const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const fail = (status: number, code = 'internal_failure') => ({
  ok: false as const,
  status,
  code,
});
const withFlag = (approved: boolean) => ({
  penalTextApproved: approved,
  overdueRemindersWithheld: !approved,
});
const pageOf = <T,>(items: T[], approved = true, nextCursor: string | null = null) =>
  ok({ items, nextCursor, overdueReminders: withFlag(approved) });
const plainPage = <T,>(items: T[], nextCursor: string | null = null) => ok({ items, nextCursor });

const policy = (over: object = {}) =>
  LrPolicy.parse({
    id: POLICY,
    lenderId: LENDER_A,
    version: 2,
    status: 'draft',
    offsetsDays: [-3, -1, 0, 1],
    overdueWeekly: true,
    channels: ['in_app', 'push', 'sms'],
    windowFrom: '09:00',
    windowTo: '18:00',
    maxPerDay: 1,
    draftedBy: OTHER,
    draftedAt: AT,
    approvedBy: null,
    approvedAt: null,
    retiredBy: null,
    retiredAt: null,
    ...over,
  });

const template = (over: object = {}) =>
  LrTemplate.parse({
    id: TEMPLATE,
    lenderId: LENDER_A,
    kind: 'overdue',
    language: 'en',
    version: 1,
    status: 'draft',
    body: 'Your instalment with {{lender_name}} was due on {{due_date}}.\n{{penal_text}}',
    draftedBy: OTHER,
    draftedAt: AT,
    approvedBy: null,
    approvedAt: null,
    retiredBy: null,
    retiredAt: null,
    ...over,
  });

const penal = (over: object = {}) =>
  LrPenalText.parse({
    id: PENAL,
    lenderId: LENDER_A,
    version: 1,
    status: 'draft',
    chargeKind: 'flat',
    flatAmountMinor: 25_000,
    percentBps: null,
    basis: 'overdue_amount',
    separateFromInterest: true,
    notCompounded: true,
    reason: 'Late payment of an instalment.',
    sentenceEn: 'A penal charge of the lender’s stated amount applies to the overdue amount.',
    sentenceHi: null,
    draftedBy: OTHER,
    draftedAt: AT,
    approvedBy: null,
    approvedAt: null,
    retiredBy: null,
    retiredAt: null,
    ...over,
  });

const hold = (over: object = {}) =>
  LrHold.parse({
    id: HOLD,
    lenderId: LENDER_A,
    loanAccountId: LOAN,
    reason: 'hardship',
    note: 'The lender asked for a pause.',
    placedBy: OTHER,
    placedAt: AT,
    releasedBy: null,
    releasedAt: null,
    releaseNote: null,
    active: true,
    ...over,
  });

const reminder = (over: object = {}) =>
  LrReminder.parse({
    id: REMINDER,
    lenderId: LENDER_A,
    loanAccountId: LOAN,
    installmentSeq: 4,
    dueDate: '2026-10-20',
    offsetDays: -3,
    channel: 'in_app',
    kind: 'pre_due',
    scheduledFor: AT_2,
    status: 'sent',
    suppressReason: null,
    attempts: 1,
    claimedAt: AT,
    templateId: TEMPLATE,
    penalTextId: null,
    languageUsed: 'en',
    languageFallback: false,
    amountMinor: 1_250_000,
    createdAt: AT,
    updatedAt: AT,
    ...over,
  });

const delivery = (over: object = {}) =>
  LrDelivery.parse({
    id: DELIVERY,
    channel: 'in_app',
    state: 'accepted',
    source: 'send',
    providerRef: null,
    errorClass: null,
    contentSha256: SHA_A,
    penalTextSha256: null,
    occurredAt: AT,
    ...over,
  });

const grantsFor = (
  permissions: readonly string[],
  lender = LENDER_A,
  name = 'Sample Finance Ltd',
) =>
  reminderGrants([
    {
      organizationId: lender,
      organizationKind: 'lender',
      organizationName: name,
      permissions,
    },
  ]);

const ctxFor = (
  permissions: readonly string[],
  returnTo = '/reminders/policy',
  userId = ME,
): RemindersContext => ({
  action: vi.fn(() => Promise.resolve()),
  draft: vi.fn(() => Promise.resolve({ ok: true as const })),
  returnTo,
  grants: grantsFor(permissions),
  userId,
});

const MANAGE = ['loan.read', 'reminder.policy.manage'] as const;
const APPROVE = ['loan.read', 'reminder.template.approve'] as const;
const READ = ['loan.read'] as const;

const text = (container: HTMLElement) => container.textContent ?? '';
const ops = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLInputElement>('input[name="op"]')].map((i) => i.value);
const stripIds = (value: string) =>
  value.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, 'ID');

/** A recording API: every write is kept, every read path is kept and answered with a 404. */
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

const KEY = 'ui-0190a000-0000-7000-8000-0000000009ff';
function formOf(fields: Record<string, string | string[]>, withKey = true): FormData {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    if (Array.isArray(value)) for (const v of value) form.append(name, v);
    else form.append(name, value);
  }
  if (withKey) form.set('key', KEY);
  return form;
}

const ATTEST = { separateFromInterest: 'on', notCompounded: 'on' };

// ---------------------------------------------------------------------------------------------------------------------
describe('figures are written down, never worked out', () => {
  it('writes an offset in words', () => {
    expect(offsetWords(0)).toBe('On the due date');
    expect(offsetWords(-1)).toBe('1 day before the due date');
    expect(offsetWords(-3)).toBe('3 days before the due date');
    expect(offsetWords(1)).toBe('1 day after the due date');
    expect(offsetWords(7)).toBe('7 days after the due date');
    expect(() => offsetWords(1.5)).toThrow(RangeError);
  });

  it('writes basis points as a percentage with exact integer arithmetic', () => {
    expect(percentFromBps(0)).toBe('0.00 per cent');
    expect(percentFromBps(5)).toBe('0.05 per cent');
    expect(percentFromBps(250)).toBe('2.50 per cent');
    expect(percentFromBps(10_000)).toBe('100.00 per cent');
    expect(percentFromBps(12_345)).toBe('123.45 per cent');
    expect(() => percentFromBps(-1)).toThrow(RangeError);
    expect(() => percentFromBps(1.5)).toThrow(RangeError);
  });

  it('turns a typed percentage into whole basis points, or refuses it', () => {
    expect(parsePercentToBps('2')).toBe(200);
    expect(parsePercentToBps('2.5')).toBe(250);
    expect(parsePercentToBps('2.55')).toBe(255);
    expect(parsePercentToBps('0.05')).toBe(5);
    expect(parsePercentToBps(' 1.25 ')).toBe(125);
    expect(parsePercentToBps('100000')).toBe(10_000_000);
    for (const bad of ['', '-1', '2.555', '1e2', '2,5', '2%', 'abc', '100001', '.5', '2.'])
      expect(parsePercentToBps(bad), bad).toBeNull();
  });
});

describe('every value of a closed vocabulary has plain words, and an unknown one is never printed', () => {
  const FALLBACKS = [
    'A status this screen has no wording for',
    'A kind of reminder this screen has no wording for',
    'A language this screen has no wording for',
    'A channel this screen has no wording for',
    'A reason this screen has no wording for',
    'A state this screen has no wording for',
    'Another source',
    'A problem this screen has no wording for',
    'A kind of charge this screen has no wording for',
    'a basis this screen has no wording for',
    'Unknown status',
  ];
  const known = (words: string) => FALLBACKS.every((f) => !words.startsWith(f));

  it('covers every value the contract lists', () => {
    for (const v of LR_ARTEFACT_STATUSES) {
      expect(known(artefactStatusWords(v)), v).toBe(true);
      expect(known(artefactStatusShort(v)), v).toBe(true);
    }
    for (const v of LR_REMINDER_KINDS) expect(known(reminderKindWords(v)), v).toBe(true);
    for (const v of LR_TEMPLATE_LANGUAGES) expect(known(languageWords(v)), v).toBe(true);
    for (const v of LR_CHANNELS) expect(known(channelWords(v)), v).toBe(true);
    for (const v of LR_REMINDER_STATUSES) {
      expect(known(reminderStatusWords(v)), v).toBe(true);
      expect(known(reminderStatusShort(v)), v).toBe(true);
    }
    for (const v of LR_SUPPRESS_REASONS) expect(known(suppressReasonWords(v)), v).toBe(true);
    for (const v of LR_HOLD_REASONS) expect(known(holdReasonWords(v)), v).toBe(true);
    for (const v of LR_HOLD_STATUSES) expect(known(holdStatusWords(v)), v).toBe(true);
    for (const v of LR_DELIVERY_STATES) expect(known(deliveryStateWords(v)), v).toBe(true);
    for (const v of LR_DELIVERY_SOURCES) expect(known(deliverySourceWords(v)), v).toBe(true);
    for (const v of LR_DELIVERY_ERROR_CLASSES) expect(known(deliveryErrorWords(v)), v).toBe(true);
    for (const v of LR_CHARGE_KINDS) expect(known(chargeKindWords(v)), v).toBe(true);
    for (const v of LR_CHARGE_BASES) expect(known(chargeBasisWords(v)), v).toBe(true);
  });

  it('says SMS is not available and is never sent', () => {
    expect(channelWords('sms')).toBe('SMS: not available, never sent');
    expect(suppressReasonWords('sms_not_configured')).toBe(
      'SMS is not available and is never sent.',
    );
  });

  it('never prints a value it has no wording for', () => {
    expect(suppressReasonWords('weird_reason_code')).not.toContain('weird_reason_code');
    expect(channelWords('carrier_pigeon')).not.toContain('carrier_pigeon');
    expect(reminderStatusShort('exploded')).not.toContain('exploded');
    expect(deliveryStateWords('vanished')).not.toContain('vanished');
    expect(holdReasonWords('mystery')).not.toContain('mystery');
    expect(artefactStatusWords('toString')).not.toContain('toString');
    expect(suppressReasonWords('constructor')).not.toContain('constructor');
  });

  it('keeps the words for "sent" from being read as "delivered"', () => {
    expect(reminderStatusShort('sent')).not.toMatch(/deliver/i);
    expect(deliveryStateWords('accepted')).toMatch(/not a delivery report/);
    expect(deliveryStateWords('delivered')).toMatch(/delivery report/);
  });
});

describe('error codes become sentences, and nothing the server said reaches the screen', () => {
  it('maps every code the API documents for the reminder routes', () => {
    const codes = [
      'forbidden',
      'staff_only',
      'no_active_access',
      'mfa_required',
      'not_found',
      'self_approval',
      'not_a_draft',
      'already_retired',
      'hold_active',
      'already_released',
      'offsets_invalid',
      'channels_invalid',
      'window_invalid',
      'policy_invalid',
      'template_invalid',
      'wording_invalid',
      'penal_text_variable_missing',
      'charge_invalid',
      'attestation_missing',
      'hold_invalid',
      'unsafe_free_text',
      'validation_failed',
      'idempotency_key_reused',
      'idempotency_key_required',
      'rate_limited',
    ];
    for (const code of codes) expect(remindersErrorMessage(code), code).not.toBe(GENERIC);
  });

  it('gives the generic sentence for an unknown code, a database state or nothing', () => {
    for (const code of ['23505', 'SQLSTATE 23505', 'internal_failure', '', 'toString', '__proto__'])
      expect(remindersErrorMessage(code), code).toBe(GENERIC);
    expect(remindersErrorMessage(null)).toBe(GENERIC);
    expect(remindersErrorMessage(undefined)).toBe(GENERIC);
  });

  it('says what self-approval means and that another person must approve', () => {
    expect(remindersErrorMessage('self_approval')).toMatch(/Another person must/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('what the person may do, per lender', () => {
  it('turns lender memberships into grants and ignores platform memberships', () => {
    const grants = reminderGrants([
      {
        organizationId: LENDER_A,
        organizationKind: 'lender',
        organizationName: 'A',
        permissions: ['loan.read', 'reminder.policy.manage'],
      },
      {
        organizationId: LENDER_B,
        organizationKind: 'lender',
        organizationName: 'B',
        permissions: ['reminder.template.approve'],
      },
      {
        organizationId: '0190a000-0000-7000-8000-0000000000aa',
        organizationKind: 'platform',
        organizationName: 'P',
        permissions: ['loan.read', 'reminder.policy.manage', 'reminder.template.approve'],
      },
    ]);
    expect(grants).toHaveLength(2);
    expect(mayIn(grants, LENDER_A, 'manage')).toBe(true);
    expect(mayIn(grants, LENDER_A, 'approve')).toBe(false);
    expect(mayIn(grants, LENDER_B, 'approve')).toBe(true);
    expect(mayIn(grants, LENDER_B, 'read')).toBe(false);
    expect(mayIn(grants, '0190a000-0000-7000-8000-0000000000ff', 'manage')).toBe(false);
  });

  it('draws an approve form only for a draft by another person, for a person with the approve permission', () => {
    const grants = grantsFor(['reminder.template.approve']);
    expect(mayApprove(grants, LENDER_A, { status: 'draft', draftedBy: OTHER }, ME)).toBe(true);
    // The person who drafted it never gets the form.
    expect(mayApprove(grants, LENDER_A, { status: 'draft', draftedBy: ME }, ME)).toBe(false);
    expect(mayApprove(grants, LENDER_A, { status: 'approved', draftedBy: OTHER }, ME)).toBe(false);
    expect(mayApprove(grants, LENDER_A, { status: 'retired', draftedBy: OTHER }, ME)).toBe(false);
    expect(
      mayApprove(
        grantsFor(['reminder.policy.manage']),
        LENDER_A,
        { status: 'draft', draftedBy: OTHER },
        ME,
      ),
    ).toBe(false);
    expect(mayApprove(grants, LENDER_B, { status: 'draft', draftedBy: OTHER }, ME)).toBe(false);
  });

  it('draws a retire form only for a person who manages reminders, and not for what is retired', () => {
    const grants = grantsFor(['reminder.policy.manage']);
    expect(mayRetire(grants, LENDER_A, { status: 'draft' })).toBe(true);
    expect(mayRetire(grants, LENDER_A, { status: 'approved' })).toBe(true);
    expect(mayRetire(grants, LENDER_A, { status: 'retired' })).toBe(false);
    expect(mayRetire(grantsFor(['reminder.template.approve']), LENDER_A, { status: 'draft' })).toBe(
      false,
    );
  });

  it('opens the artefact pages to loan.read, manage or approve, and the log to loan.read only', () => {
    const [read] = grantsFor(['loan.read']);
    const [manage] = grantsFor(['reminder.policy.manage']);
    const [approve] = grantsFor(['reminder.template.approve']);
    const [none] = grantsFor(['payment.read']);
    expect([read, manage, approve].map((g) => (g ? mayViewArtefacts(g) : null))).toEqual([
      true,
      true,
      true,
    ]);
    expect(none ? mayViewArtefacts(none) : null).toBe(false);
  });

  it('chooses the lender asked for when the person belongs to it, else the first that fits', () => {
    const grants = [
      ...grantsFor(['loan.read'], LENDER_A, 'A'),
      ...grantsFor(['loan.read'], LENDER_B, 'B'),
    ];
    expect(chooseLender(grants, LENDER_B, (g) => g.read)?.lenderId).toBe(LENDER_B);
    expect(
      chooseLender(grants, '0190a000-0000-7000-8000-0000000000ff', (g) => g.read)?.lenderId,
    ).toBe(LENDER_A);
    expect(chooseLender(grants, undefined, (g) => g.manage)).toBeNull();
    expect(chooseLender([], LENDER_A, () => true)).toBeNull();
  });
});

describe('page queries and loaders', () => {
  it('keeps only filters that look right', () => {
    expect(
      parseRemindersQuery(
        {
          lenderId: LENDER_A,
          loanAccountId: LOAN,
          status: 'approved',
          kind: 'overdue',
          language: 'hi',
          channel: 'push',
          suppressReason: 'hold',
          cursor: 'abc_DEF-123',
        },
        STATUS_FILTERS.artefact,
      ),
    ).toEqual({
      lenderId: LENDER_A,
      loanAccountId: LOAN,
      status: 'approved',
      kind: 'overdue',
      language: 'hi',
      channel: 'push',
      suppressReason: 'hold',
      cursor: 'abc_DEF-123',
    });
    expect(
      parseRemindersQuery(
        {
          lenderId: 'not-an-id',
          loanAccountId: '123',
          status: 'planned',
          kind: 'weekly',
          language: 'fr',
          channel: 'sms2',
          suppressReason: 'mystery',
          cursor: 'a b;drop',
        },
        STATUS_FILTERS.artefact,
      ),
    ).toEqual({});
    expect(parseRemindersQuery({ status: ['approved', 'draft'] }, STATUS_FILTERS.artefact)).toEqual(
      {},
    );
  });

  it('builds links that keep the filters', () => {
    expect(remindersHref('/reminders', { status: 'sent', cursor: 'c1' })).toBe(
      '/reminders?status=sent&cursor=c1',
    );
    expect(remindersHref('/reminders', {})).toBe('/reminders');
  });

  it('reads each list from its own route and always names the lender for the three artefact lists', async () => {
    const { api, reads } = recorder();
    await loadPolicies(api, LENDER_A, { status: 'approved', cursor: 'c1' });
    await loadTemplates(api, LENDER_A, { kind: 'overdue', language: 'hi' });
    await loadPenalTexts(api, LENDER_A, {}, 1);
    await loadHolds(api, { status: 'active', loanAccountId: LOAN });
    await loadReminders(api, { lenderId: LENDER_A, status: 'suppressed', suppressReason: 'hold' });
    await loadSummary(api, LENDER_A);
    await loadDeliveries(api, REMINDER);
    expect(reads).toEqual([
      `/v1/lender/reminder-policies?lenderId=${LENDER_A}&limit=25&cursor=c1&status=approved`,
      `/v1/lender/reminder-templates?lenderId=${LENDER_A}&limit=25&kind=overdue&language=hi`,
      `/v1/lender/penal-charge-texts?lenderId=${LENDER_A}&limit=1`,
      `/v1/lender/communication-holds?limit=25&loanAccountId=${LOAN}&status=active`,
      `/v1/lender/reminders?limit=25&lenderId=${LENDER_A}&status=suppressed&suppressReason=hold`,
      `/v1/lender/reminders/summary?lenderId=${LENDER_A}`,
      `/v1/lender/reminders/${REMINDER}/deliveries`,
    ]);
  });

  it('drops a filter value the contract does not list instead of sending it', async () => {
    const { api, reads } = recorder();
    await loadReminders(api, { status: 'exploded', kind: 'weekly', channel: 'pigeon' });
    expect(reads).toEqual(['/v1/lender/reminders?limit=25']);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('the allow-listed operations', () => {
  it('refuses an operation that is not on the list, without any call', async () => {
    const { api, calls } = recorder();
    for (const op of [
      'reminders.policy.delete',
      'servicing.import.commit',
      '__proto__',
      'constructor',
      '',
    ])
      expect(await runRemindersOperation(api, formOf({ op })), op).toEqual({
        ok: false,
        code: 'path_not_allowed',
      });
    expect(await runRemindersOperation(api, formOf({}))).toEqual({
      ok: false,
      code: 'path_not_allowed',
    });
    expect(calls).toEqual([]);
  });

  it('refuses a request key of the wrong shape, without any call', async () => {
    const { api, calls } = recorder();
    for (const key of ['', 'short', 'has spaces in it and is long enough', 'x'.repeat(200)]) {
      const form = formOf({ op: 'reminders.hold.release', id: HOLD }, false);
      form.set('key', key);
      expect(await runRemindersOperation(api, form), key).toEqual({
        ok: false,
        code: 'validation_failed',
      });
    }
    expect(
      await runRemindersOperation(api, formOf({ op: 'reminders.hold.release', id: HOLD }, false)),
    ).toEqual({
      ok: false,
      code: 'validation_failed',
    });
    expect(calls).toEqual([]);
  });

  it('exposes exactly the operations the screens draw', () => {
    expect(Object.keys(REMINDERS_OPERATIONS).sort()).toEqual([
      'reminders.hold.place',
      'reminders.hold.release',
      'reminders.penal.approve',
      'reminders.penal.draft',
      'reminders.penal.retire',
      'reminders.policy.approve',
      'reminders.policy.draft',
      'reminders.policy.retire',
      'reminders.template.approve',
      'reminders.template.draft',
      'reminders.template.retire',
    ]);
  });

  describe('policy', () => {
    const base = {
      op: 'reminders.policy.draft',
      lenderId: LENDER_A,
      offsets: '-3, -1, 0, 1',
      channels: ['in_app', 'push'],
      windowFrom: '09:00',
      windowTo: '18:00',
      maxPerDay: '1',
    };

    it('sends the policy exactly as typed', async () => {
      const { api, calls } = recorder();
      expect(await runRemindersOperation(api, formOf({ ...base, overdueWeekly: 'on' }))).toEqual({
        ok: true,
      });
      expect(calls).toEqual([
        {
          path: '/v1/lender/reminder-policies',
          key: KEY,
          body: {
            lenderId: LENDER_A,
            offsetsDays: [-3, -1, 0, 1],
            overdueWeekly: true,
            channels: ['in_app', 'push'],
            windowFrom: '09:00',
            windowTo: '18:00',
            maxPerDay: 1,
          },
        },
      ]);
    });

    it('sends weekly overdue reminders as false unless the box was ticked', async () => {
      const { api, calls } = recorder();
      await runRemindersOperation(api, formOf(base));
      expect((calls[0]?.body as { overdueWeekly: boolean }).overdueWeekly).toBe(false);
    });

    it('never sends SMS and says so', async () => {
      const { api, calls } = recorder();
      const result = await runRemindersOperation(
        api,
        formOf({ ...base, channels: ['in_app', 'sms'] }),
      );
      expect(result).toEqual({ ok: false, code: 'channels_invalid' });
      expect(calls).toEqual([]);
    });

    it('needs at least one channel', async () => {
      const { api, calls } = recorder();
      expect(await runRemindersOperation(api, formOf({ ...base, channels: [] }))).toEqual({
        ok: false,
        code: 'channels_required',
      });
      expect(calls).toEqual([]);
    });

    it('counts a repeated channel once', async () => {
      const { api, calls } = recorder();
      await runRemindersOperation(api, formOf({ ...base, channels: ['push', 'push'] }));
      expect((calls[0]?.body as { channels: string[] }).channels).toEqual(['push']);
    });

    it('reads offsets as whole numbers or refuses them', () => {
      expect(parseOffsets('-3, -1,0, 7')).toEqual([-3, -1, 0, 7]);
      expect(parseOffsets('5')).toEqual([5]);
      expect(parseOffsets('')).toBeNull();
      expect(parseOffsets(undefined)).toBeNull();
      for (const bad of ['1.5', '1,,2', 'a', '+3', '-0', '007', '1 2', '12345', '1;2'])
        expect(parseOffsets(bad), bad).toBeNull();
      expect(parseOffsets(Array.from({ length: 31 }, (_, i) => String(i)).join(','))).toBeNull();
    });

    it.each([
      ['offsets', { offsets: '1.5' }, 'offsets_format'],
      ['window start', { windowFrom: '9:00' }, 'time_invalid'],
      ['window end', { windowTo: '25:00' }, 'time_invalid'],
      ['window end missing', { windowTo: '' }, 'time_invalid'],
      ['cap', { maxPerDay: '-1' }, 'cap_invalid'],
      ['cap text', { maxPerDay: 'two' }, 'cap_invalid'],
      ['cap too large', { maxPerDay: '1001' }, 'cap_invalid'],
      ['lender', { lenderId: 'not-an-id' }, 'validation_failed'],
    ])('sends nothing when the %s is wrong', async (_name, change, code) => {
      const { api, calls } = recorder();
      expect(await runRemindersOperation(api, formOf({ ...base, ...change }))).toEqual({
        ok: false,
        code,
      });
      expect(calls).toEqual([]);
    });
  });

  describe('wording', () => {
    const base = {
      op: 'reminders.template.draft',
      lenderId: LENDER_A,
      kind: 'overdue',
      language: 'hi',
      body: '  First line {{lender_name}}\r\nSecond line  ',
    };

    it('sends the wording byte for byte', async () => {
      const { api, calls } = recorder();
      expect(await runRemindersOperation(api, formOf(base))).toEqual({ ok: true });
      expect(calls).toEqual([
        {
          path: '/v1/lender/reminder-templates',
          key: KEY,
          body: { lenderId: LENDER_A, kind: 'overdue', language: 'hi', body: base.body },
        },
      ]);
    });

    it('does not add, suggest, translate or complete anything', async () => {
      const { api, calls } = recorder();
      await runRemindersOperation(api, formOf({ ...base, body: 'x' }));
      expect(Object.keys(calls[0]?.body as object).sort()).toEqual([
        'body',
        'kind',
        'language',
        'lenderId',
      ]);
      expect((calls[0]?.body as { body: string }).body).toBe('x');
    });

    it.each([
      ['a blank wording', { body: '   \n ' }, 'body_required'],
      ['no wording', { body: '' }, 'body_required'],
      ['a too long wording', { body: 'a'.repeat(4001) }, 'body_required'],
      ['an unknown kind', { kind: 'weekly' }, 'validation_failed'],
      ['an unknown language', { language: 'fr' }, 'validation_failed'],
      ['a missing lender', { lenderId: '' }, 'validation_failed'],
    ])('sends nothing for %s', async (_name, change, code) => {
      const { api, calls } = recorder();
      expect(await runRemindersOperation(api, formOf({ ...base, ...change }))).toEqual({
        ok: false,
        code,
      });
      expect(calls).toEqual([]);
    });
  });

  describe('penal-charge text', () => {
    const flat = {
      op: 'reminders.penal.draft',
      lenderId: LENDER_A,
      chargeKind: 'flat',
      flatAmount: '250.50',
      percent: '',
      reason: 'Late payment of an instalment.',
      sentenceEn: 'The lender’s own sentence.',
      sentenceHi: '',
      ...ATTEST,
    };

    it('sends a flat figure as whole paise exactly as typed, with both statements', async () => {
      const { api, calls } = recorder();
      expect(await runRemindersOperation(api, formOf(flat))).toEqual({ ok: true });
      expect(calls).toEqual([
        {
          path: '/v1/lender/penal-charge-texts',
          key: KEY,
          body: {
            lenderId: LENDER_A,
            chargeKind: 'flat',
            flatAmountMinor: 25_050,
            separateFromInterest: true,
            notCompounded: true,
            reason: 'Late payment of an instalment.',
            sentenceEn: 'The lender’s own sentence.',
          },
        },
      ]);
    });

    it('sends a percentage as whole basis points exactly as typed', async () => {
      const { api, calls } = recorder();
      await runRemindersOperation(
        api,
        formOf({
          ...flat,
          chargeKind: 'percentage',
          flatAmount: '',
          percent: '2.5',
          sentenceHi: 'वाक्य',
        }),
      );
      const body = calls[0]?.body as Record<string, unknown>;
      expect(body.percentBps).toBe(250);
      expect(body).not.toHaveProperty('flatAmountMinor');
      expect(body.sentenceHi).toBe('वाक्य');
    });

    it('never applies the figure to anything: only the stated figure leaves', async () => {
      const { api, calls } = recorder();
      await runRemindersOperation(api, formOf({ ...flat, flatAmount: '1' }));
      const body = calls[0]?.body as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual([
        'chargeKind',
        'flatAmountMinor',
        'lenderId',
        'notCompounded',
        'reason',
        'sentenceEn',
        'separateFromInterest',
      ]);
      expect(body.flatAmountMinor).toBe(100);
    });

    it('sends the sentences and the reason exactly as typed', async () => {
      const { api, calls } = recorder();
      await runRemindersOperation(
        api,
        formOf({ ...flat, sentenceEn: '  Spaced  sentence.\n', reason: ' why ' }),
      );
      const body = calls[0]?.body as { sentenceEn: string; reason: string };
      expect(body.sentenceEn).toBe('  Spaced  sentence.\n');
      expect(body.reason).toBe(' why ');
    });

    it('sends nothing unless BOTH statements are ticked', async () => {
      const { api, calls } = recorder();
      for (const missing of [
        { separateFromInterest: '' },
        { notCompounded: '' },
        { separateFromInterest: '', notCompounded: '' },
      ]) {
        const form = formOf({ ...flat, ...missing });
        for (const name of Object.keys(missing)) form.delete(name);
        expect(await runRemindersOperation(api, form)).toEqual({
          ok: false,
          code: 'attestation_missing',
        });
      }
      expect(calls).toEqual([]);
    });

    it('refuses a figure of the wrong kind, or both figures, or a malformed one', async () => {
      const { api, calls } = recorder();
      const cases: [Record<string, string>, string][] = [
        [{ percent: '2' }, 'charge_choice'],
        [{ chargeKind: 'percentage', flatAmount: '10', percent: '' }, 'charge_choice'],
        [{ flatAmount: '' }, 'amount_invalid'],
        [{ flatAmount: '12.345' }, 'amount_invalid'],
        [{ flatAmount: '1,000' }, 'amount_invalid'],
        [{ flatAmount: '-5' }, 'amount_invalid'],
        [{ chargeKind: 'percentage', flatAmount: '', percent: '' }, 'percent_invalid'],
        [{ chargeKind: 'percentage', flatAmount: '', percent: '2.555' }, 'percent_invalid'],
        [{ chargeKind: 'monthly' }, 'validation_failed'],
        [{ reason: '  ' }, 'text_required'],
        [{ sentenceEn: '' }, 'text_required'],
      ];
      for (const [change, code] of cases)
        expect(
          await runRemindersOperation(api, formOf({ ...flat, ...change })),
          JSON.stringify(change),
        ).toEqual({
          ok: false,
          code,
        });
      expect(calls).toEqual([]);
    });
  });

  describe('approve, retire and holds', () => {
    it.each([
      ['reminders.policy.approve', `/v1/lender/reminder-policies/${POLICY}/approve`],
      ['reminders.template.approve', `/v1/lender/reminder-templates/${POLICY}/approve`],
      ['reminders.penal.approve', `/v1/lender/penal-charge-texts/${POLICY}/approve`],
    ])(
      '%s posts to its own route, and only after the approver ticked that they read it',
      async (op, path) => {
        const { api, calls } = recorder();
        expect(await runRemindersOperation(api, formOf({ op, id: POLICY }))).toEqual({
          ok: false,
          code: 'review_required',
        });
        expect(calls).toEqual([]);
        expect(
          await runRemindersOperation(api, formOf({ op, id: POLICY, reviewed: 'on' })),
        ).toEqual({ ok: true });
        expect(calls).toEqual([{ path, body: {}, key: KEY }]);
      },
    );

    it.each([
      ['reminders.policy.retire', `/v1/lender/reminder-policies/${POLICY}/retire`],
      ['reminders.template.retire', `/v1/lender/reminder-templates/${POLICY}/retire`],
      ['reminders.penal.retire', `/v1/lender/penal-charge-texts/${POLICY}/retire`],
    ])('%s posts to its own route', async (op, path) => {
      const { api, calls } = recorder();
      expect(await runRemindersOperation(api, formOf({ op, id: POLICY }))).toEqual({ ok: true });
      expect(calls).toEqual([{ path, body: {}, key: KEY }]);
    });

    it('refuses an id that is not an id, so nothing odd can be put in a path', async () => {
      const { api, calls } = recorder();
      for (const op of Object.keys(REMINDERS_OPERATIONS).filter((o) =>
        /approve|retire|release/.test(o),
      ))
        for (const id of ['', 'not-an-id', '../../v1/platform/features', `${POLICY}/extra`])
          expect(
            await runRemindersOperation(api, formOf({ op, id, reviewed: 'on' })),
            `${op} ${id}`,
          ).toEqual({
            ok: false,
            code: 'validation_failed',
          });
      expect(calls).toEqual([]);
    });

    it('places a hold with a reason from the closed list and the lender’s note', async () => {
      const { api, calls } = recorder();
      expect(
        await runRemindersOperation(
          api,
          formOf({
            op: 'reminders.hold.place',
            loanAccountId: LOAN,
            reason: 'dispute',
            note: ' paused ',
          }),
        ),
      ).toEqual({ ok: true });
      expect(calls).toEqual([
        {
          path: `/v1/lender/loans/${LOAN}/communication-hold`,
          key: KEY,
          body: { reason: 'dispute', note: 'paused' },
        },
      ]);
    });

    it('places a hold without a note, and never sends a lender assertion', async () => {
      const { api, calls } = recorder();
      await runRemindersOperation(
        api,
        formOf({
          op: 'reminders.hold.place',
          loanAccountId: LOAN,
          reason: 'legal',
          lenderId: LENDER_A,
        }),
      );
      expect(calls[0]?.body).toEqual({ reason: 'legal' });
    });

    it.each([
      [{ loanAccountId: 'not-an-id', reason: 'legal' }, 'id_invalid'],
      [{ loanAccountId: '', reason: 'legal' }, 'id_invalid'],
      [{ loanAccountId: LOAN, reason: 'fun' }, 'validation_failed'],
      [{ loanAccountId: LOAN, reason: '' }, 'validation_failed'],
      [{ loanAccountId: LOAN, reason: 'legal', note: 'n'.repeat(1001) }, 'note_invalid'],
    ])('sends nothing for a bad hold %j', async (fields, code) => {
      const { api, calls } = recorder();
      expect(
        await runRemindersOperation(api, formOf({ op: 'reminders.hold.place', ...fields })),
      ).toEqual({
        ok: false,
        code,
      });
      expect(calls).toEqual([]);
    });

    it('releases a hold, with or without a note', async () => {
      const { api, calls } = recorder();
      await runRemindersOperation(api, formOf({ op: 'reminders.hold.release', id: HOLD }));
      await runRemindersOperation(
        api,
        formOf({ op: 'reminders.hold.release', id: HOLD, note: ' done ' }),
      );
      expect(calls).toEqual([
        { path: `/v1/lender/communication-holds/${HOLD}/release`, body: {}, key: KEY },
        {
          path: `/v1/lender/communication-holds/${HOLD}/release`,
          body: { note: 'done' },
          key: KEY,
        },
      ]);
    });

    it('reports an API refusal as a short code, never as the text the server sent', async () => {
      const api: OnboardingApi = {
        get: () => Promise.resolve(fail(404, 'not_found')),
        post: () => Promise.resolve(fail(403, 'self_approval')),
      };
      expect(
        await runRemindersOperation(
          api,
          formOf({ op: 'reminders.policy.approve', id: POLICY, reviewed: 'on' }),
        ),
      ).toEqual({ ok: false, code: 'self_approval' });
      const odd: OnboardingApi = {
        get: () => Promise.resolve(fail(404, 'not_found')),
        post: () => Promise.resolve(fail(500, 'SQLSTATE 23505 duplicate key value')),
      };
      expect(
        await runRemindersOperation(odd, formOf({ op: 'reminders.policy.retire', id: POLICY })),
      ).toEqual({ ok: false, code: 'unknown' });
    });
  });

  describe('where a form may return to', () => {
    it('allows the reminder pages, with a short query', () => {
      for (const path of [
        '/reminders',
        '/reminders?status=sent',
        '/reminders/policy',
        '/reminders/wording?lenderId=abc&cursor=x_y-z',
        '/reminders/penal-text',
        '/reminders/holds?status=active',
        `/reminders/${REMINDER}`,
      ])
        expect(safeRemindersReturnPath(path), path).toBe(path);
    });

    it('sends anything else back to the reminder log', () => {
      for (const path of [
        'https://evil.example/reminders',
        '//evil.example',
        '/loans',
        '/payment-setup',
        '/reminders/../loans',
        '/reminders/other',
        '/reminders/policy?x=<script>',
        '/reminders/policy#frag',
        `/reminders/${REMINDER}/extra`,
        'javascript:alert(1)',
        '',
        null,
        undefined,
        42,
      ])
        expect(safeRemindersReturnPath(path), String(path)).toBe('/reminders');
    });

    it('adds the result as done=1 or a short error code and nothing else', () => {
      expect(remindersNoticeUrl('/reminders/policy', { ok: true })).toBe(
        '/reminders/policy?done=1',
      );
      expect(
        remindersNoticeUrl('/reminders/policy?lenderId=abc', { ok: false, code: 'self_approval' }),
      ).toBe('/reminders/policy?lenderId=abc&error=self_approval');
      expect(
        remindersNoticeUrl('/reminders/holds?done=1&error=x', { ok: false, code: 'Not A Code!' }),
      ).toBe('/reminders/holds?error=unknown');
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('Reminder log', () => {
  const lenderOf = (ctx: RemindersContext) => ctx.grants[0] ?? null;
  const view = (
    over: Partial<Parameters<typeof RemindersLogPage>[0]> = {},
    ctx = ctxFor(READ, '/reminders'),
  ) =>
    render(
      <RemindersLogPage
        lender={lenderOf(ctx)}
        summary={ok({ lenderId: LENDER_A, since: null, items: [] })}
        reminders={plainPage([])}
        overdue={withFlag(true)}
        query={{}}
        ctx={ctx}
        {...over}
      />,
    );

  it('says plainly that there are no reminders yet', () => {
    view();
    expect(screen.getByText('No reminders')).toBeTruthy();
    expect(screen.queryByRole('table', { name: /Reminders, newest first/ })).toBeNull();
    expect(screen.getByText('No reminder is counted for this period yet.')).toBeTruthy();
  });

  it('says in the first paragraph that reminders are in-app and push only, and that SMS is never sent', () => {
    const { container } = view();
    expect(text(container)).toMatch(/in the app and as push notifications only/);
    expect(text(container)).toMatch(/SMS is not available and is never sent/);
  });

  it('shows a load failure without repeating what the server said', () => {
    const { container } = view({
      reminders: fail(500, 'SQLSTATE 23505 duplicate key value'),
      summary: fail(500, 'SQLSTATE 42P01 relation missing'),
    });
    expect(screen.getByText('Could not load the reminders')).toBeTruthy();
    expect(screen.getByText('Could not load the summary')).toBeTruthy();
    expect(text(container)).not.toMatch(/SQLSTATE|duplicate key|23505|42P01/);
  });

  it('says when the role cannot read reminders', () => {
    view({ lender: null });
    expect(screen.getByText('You cannot view the reminder log')).toBeTruthy();
  });

  it('shows each reminder with its status, reason, channel and the lender’s reported amount', () => {
    const { container } = view({
      reminders: plainPage([
        reminder(),
        reminder({
          id: REMINDER_2,
          kind: 'overdue',
          offsetDays: 3,
          channel: 'sms',
          status: 'suppressed',
          suppressReason: 'sms_not_configured',
          attempts: 0,
          amountMinor: null,
          languageUsed: null,
        }),
      ]),
    });
    const table = screen.getByRole('table', { name: 'Reminders, newest first' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(text(rows[1] as HTMLElement)).toContain(
      'Before the due date: 3 days before the due date',
    );
    expect(text(rows[1] as HTMLElement)).toContain('₹12,500.00');
    expect(text(rows[1] as HTMLElement)).toContain('Handed to the channel');
    expect(text(rows[2] as HTMLElement)).toContain('SMS: not available, never sent');
    expect(text(rows[2] as HTMLElement)).toContain('SMS is not available and is never sent.');
    // No amount is shown as zero.
    expect(text(rows[2] as HTMLElement)).toContain('No amount recorded');
    expect(text(rows[2] as HTMLElement)).not.toContain('₹0');
    // No raw vocabulary value reaches the screen.
    expect(text(container)).not.toMatch(/sms_not_configured|pre_due|in_app|suppressed/);
  });

  it('shows the time in India time and the due date as a date', () => {
    view({ reminders: plainPage([reminder()]) });
    expect(screen.getByRole('rowheader', { name: '17 Oct 2026, 10:00 IST' })).toBeTruthy();
    expect(screen.getByText(/due 20 Oct 2026/)).toBeTruthy();
  });

  it('says when Hindi fell back to English', () => {
    view({ reminders: plainPage([reminder({ languageFallback: true })]) });
    expect(
      screen.getByText(/English \(used because no approved Hindi wording was available\)/),
    ).toBeTruthy();
  });

  it('links each reminder to its attempts with a name a screen reader can use', () => {
    view({ reminders: plainPage([reminder()]) });
    const link = screen.getByRole('link', {
      name: 'View attempts for the reminder scheduled 17 Oct 2026, 10:00 IST',
    });
    expect(link.getAttribute('href')).toBe(`/reminders/${REMINDER}`);
  });

  it('shows the summary as counts only', () => {
    const { container } = view({
      summary: ok({
        lenderId: LENDER_A,
        since: null,
        items: [
          { status: 'sent', suppressReason: null, channel: 'push', count: 1234 },
          {
            status: 'suppressed',
            suppressReason: 'penal_text_missing',
            channel: 'in_app',
            count: 7,
          },
        ],
      }),
    });
    const table = screen.getByRole('table', { name: 'Reminders by status, reason and channel' });
    expect(text(table)).toContain('1,234');
    expect(text(table)).toContain(
      'No approved penal-charge text exists, so an overdue reminder is not sent.',
    );
    expect(text(container)).toMatch(/the last 30 days/);
    expect(text(container)).not.toContain('penal_text_missing');
  });

  it('names the period when one was asked for', () => {
    view({
      summary: ok({
        lenderId: LENDER_A,
        since: '2026-10-01T00:00:00.000000+05:30',
        items: [{ status: 'sent', suppressReason: null, channel: 'push', count: 2 }],
      }),
    });
    expect(screen.getByText(/at or after 1 Oct 2026, 00:00 IST/)).toBeTruthy();
  });

  it('offers older reminders only when the API gave a cursor', () => {
    view({ reminders: plainPage([reminder()], 'next_cursor_1'), query: { status: 'sent' } });
    expect(screen.getByRole('link', { name: 'Older reminders' }).getAttribute('href')).toBe(
      `/reminders?lenderId=${LENDER_A}&status=sent&cursor=next_cursor_1`,
    );
    cleanup();
    view({ reminders: plainPage([reminder()]) });
    expect(screen.queryByRole('link', { name: 'Older reminders' })).toBeNull();
  });

  it('asks which lender when the person belongs to several', () => {
    const ctx: RemindersContext = {
      ...ctxFor(READ, '/reminders'),
      grants: [
        ...grantsFor(READ, LENDER_A, 'Alpha Finance'),
        ...grantsFor(READ, LENDER_B, 'Beta Finance'),
      ],
    };
    view({ lender: ctx.grants[1] ?? null }, ctx);
    const select = screen.getByLabelText<HTMLSelectElement>('Lender');
    expect(select.value).toBe(LENDER_B);
    expect([...select.options].map((o) => o.text)).toEqual(['Alpha Finance', 'Beta Finance']);
  });

  describe('the notice about overdue reminders', () => {
    it('says overdue reminders are not sent when no approved penal-charge text exists', () => {
      view({ overdue: withFlag(false) });
      const heading = screen.getByRole('heading', {
        name: 'Overdue reminders are not sent until an approved penal-charge text exists',
      });
      expect(heading).toBeTruthy();
      const notice = heading.closest('section') as HTMLElement;
      expect(notice.getAttribute('role')).toBe('status');
      expect(
        within(notice)
          .getByRole('link', { name: 'Go to the penal-charge text' })
          .getAttribute('href'),
      ).toBe('/reminders/penal-text');
    });

    it('does not show it when an approved penal-charge text exists', () => {
      const { container } = view({ overdue: withFlag(true) });
      expect(text(container)).not.toMatch(
        /are not sent until an approved penal-charge text exists/,
      );
      expect(text(container)).toMatch(/An approved penal-charge text exists/);
    });

    it('treats the withheld flag as enough, even if the text flag looks fine', () => {
      view({ overdue: { penalTextApproved: true, overdueRemindersWithheld: true } });
      expect(screen.getByRole('heading', { name: /Overdue reminders are not sent/ })).toBeTruthy();
    });

    it('says it could not check, rather than guess, when the flag is unknown', () => {
      const { container } = view({ overdue: null });
      expect(text(container)).toMatch(/could not be checked just now/);
      expect(text(container)).not.toMatch(/are not sent until/);
      expect(text(container)).not.toMatch(/An approved penal-charge text exists/);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('Attempts of one reminder', () => {
  it('shows each attempt in words, oldest first, and says accepted is not delivered', () => {
    const { container } = render(
      <ReminderAttemptsPage
        log={ok({
          reminderId: REMINDER,
          items: [
            delivery(),
            delivery({
              id: '0190a000-0000-7000-8000-000000000f02',
              state: 'delivered',
              source: 'delivery_report',
              providerRef: 'msg-ref-1',
              penalTextSha256: SHA_B,
              occurredAt: AT_2,
            }),
            delivery({
              id: '0190a000-0000-7000-8000-000000000f03',
              channel: 'push',
              state: 'failed',
              errorClass: 'provider_timeout',
              occurredAt: AT_2,
            }),
          ],
        })}
      />,
    );
    const table = screen.getByRole('table', { name: 'Attempts, oldest first' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(4);
    expect(text(rows[1] as HTMLElement)).toContain(
      'Accepted by the channel (this is not a delivery report)',
    );
    expect(text(rows[2] as HTMLElement)).toContain('Delivered (from a delivery report)');
    expect(text(rows[3] as HTMLElement)).toContain('The channel did not answer in time');
    expect(text(container)).toContain(SHA_B);
    expect(text(container)).toContain('none carried');
    expect(text(container)).toContain('msg-ref-1');
    expect(text(container)).not.toMatch(/provider_timeout|delivery_report|not_configured/);
  });

  it('says an SMS attempt could not be sent', () => {
    render(
      <ReminderAttemptsPage
        log={ok({
          reminderId: REMINDER,
          items: [delivery({ channel: 'sms', state: 'not_configured', errorClass: null })],
        })}
      />,
    );
    expect(screen.getByText('SMS: not available, never sent')).toBeTruthy();
    expect(screen.getByText('The channel is not set up: nothing was sent')).toBeTruthy();
  });

  it('says plainly when nothing was attempted', () => {
    render(<ReminderAttemptsPage log={ok({ reminderId: REMINDER, items: [] })} />);
    expect(screen.getByText('No attempt recorded')).toBeTruthy();
  });

  it('says when the reminder is not found, and shows no server text on a failure', () => {
    render(<ReminderAttemptsPage log={fail(404, 'not_found')} />);
    expect(screen.getByText('Reminder not found')).toBeTruthy();
    cleanup();
    const failed = render(<ReminderAttemptsPage log={fail(500, 'SQLSTATE 23505')} />);
    expect(screen.getByText('Could not load the attempts')).toBeTruthy();
    expect(text(failed.container)).not.toContain('23505');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('Policy', () => {
  const view = (
    items = [policy()],
    permissions: readonly string[] = MANAGE,
    over: {
      userId?: string;
      approved?: boolean;
      query?: object;
      page?: Parameters<typeof PolicyPage>[0]['page'];
    } = {},
  ) => {
    const ctx = ctxFor(permissions, '/reminders/policy', over.userId ?? ME);
    return {
      ctx,
      ...render(
        <PolicyPage
          lender={ctx.grants[0] ?? null}
          page={over.page ?? pageOf(items, over.approved ?? true)}
          query={over.query ?? {}}
          ctx={ctx}
        />,
      ),
    };
  };

  it('shows a version in words: offsets, channels with SMS marked, window, cap and the trail', () => {
    const { container } = view();
    const card = screen.getByRole('article', { name: /Version 2: Draft/ });
    expect(text(card)).toContain('3 days before the due date');
    expect(text(card)).toContain('On the due date');
    expect(text(card)).toContain('1 day after the due date');
    expect(text(card)).toContain('In-app message');
    expect(text(card)).toContain('Push notification');
    expect(text(card)).toContain('SMS: not available, never sent');
    expect(text(card)).toContain('From 09:00 to 18:00');
    expect(text(card)).toContain('Draft: waiting for approval by another person');
    expect(text(card)).toContain(`By another person (ID ${OTHER})`);
    expect(text(card)).toContain('Not approved');
    expect(text(container)).not.toMatch(/in_app|overdueWeekly|offsetsDays/);
  });

  it('says "you" for the person’s own drafts and shows who approved and retired a version', () => {
    view(
      [
        policy({ draftedBy: ME }),
        policy({
          id: POLICY_2,
          version: 1,
          status: 'retired',
          approvedBy: OTHER,
          approvedAt: '2026-10-16T12:00:00.000000+00:00',
          retiredBy: THIRD,
          retiredAt: AT_2,
        }),
      ],
      APPROVE,
    );
    expect(screen.getByText(/By you on/)).toBeTruthy();
    expect(
      screen.getByText(`By another person (ID ${THIRD}) on 17 Oct 2026, 10:00 IST`),
    ).toBeTruthy();
    expect(
      screen.getByText(`By another person (ID ${OTHER}) on 16 Oct 2026, 17:30 IST`),
    ).toBeTruthy();
  });

  it('says there is no policy yet, and that nothing is planned without an approved one', () => {
    view([]);
    expect(screen.getByText('No policy yet')).toBeTruthy();
    expect(screen.getByText(/Reminders are not planned without an approved policy/)).toBeTruthy();
  });

  it('shows a failure without server text, and says when the role cannot read', () => {
    const { container } = view([], MANAGE, { page: fail(500, 'SQLSTATE 23505') });
    expect(screen.getByText('Could not load the policy')).toBeTruthy();
    expect(text(container)).not.toContain('23505');
    cleanup();
    render(
      <PolicyPage lender={null} page={fail(403, 'forbidden')} query={{}} ctx={ctxFor(MANAGE)} />,
    );
    expect(screen.getByText('You cannot view the reminder policy')).toBeTruthy();
  });

  it('shows the overdue notice when no approved penal-charge text exists', () => {
    view([policy()], MANAGE, { approved: false });
    expect(
      screen.getByRole('heading', {
        name: /Overdue reminders are not sent until an approved penal-charge text exists/,
      }),
    ).toBeTruthy();
  });

  describe('guards', () => {
    it('a read-only role sees no write form at all', () => {
      const { container } = view(
        [policy(), policy({ id: POLICY_2, status: 'approved', version: 1 })],
        READ,
      );
      expect(ops(container)).toEqual([]);
      expect(container.querySelector('form[method="get"]')).toBeTruthy();
      expect(screen.queryByText('Draft a new policy')).toBeNull();
    });

    it('a person who manages policy sees the draft form and the retire form, but cannot approve', () => {
      const { container } = view(
        [policy(), policy({ id: POLICY_2, status: 'approved', version: 1 })],
        MANAGE,
      );
      expect(ops(container).sort()).toEqual([
        'reminders.policy.draft',
        'reminders.policy.retire',
        'reminders.policy.retire',
      ]);
    });

    it('a person who may approve sees the approve form for another person’s draft', () => {
      const { container } = view([policy()], APPROVE);
      expect(ops(container)).toEqual(['reminders.policy.approve']);
      const form = container.querySelector('input[name="op"]')?.closest('form') as HTMLFormElement;
      expect(within(form).getByRole('button', { name: 'Approve this policy' })).toBeTruthy();
      const box = within(form).getByLabelText<HTMLInputElement>('I have read this policy in full.');
      expect(box.required).toBe(true);
      expect(box.checked).toBe(false);
      expect(form.querySelector<HTMLInputElement>('input[name="id"]')?.value).toBe(POLICY);
    });

    it('never draws the approve form for the person who drafted the version', () => {
      const { container } = view([policy({ draftedBy: ME })], APPROVE);
      expect(ops(container)).toEqual([]);
      expect(
        screen.getByText('You drafted this version, so another person must approve it.'),
      ).toBeTruthy();
    });

    it('does not draw approve for a version that is already approved or retired', () => {
      const { container } = view(
        [policy({ status: 'approved' }), policy({ id: POLICY_2, status: 'retired', version: 1 })],
        APPROVE,
      );
      expect(ops(container)).toEqual([]);
    });

    it('does not draw retire for a retired version', () => {
      const { container } = view([policy({ status: 'retired' })], MANAGE);
      expect(ops(container)).toEqual(['reminders.policy.draft']);
    });

    it('draws nothing for a person with rights in another lender only', () => {
      const ctx: RemindersContext = {
        ...ctxFor(READ),
        grants: [
          ...grantsFor(READ, LENDER_A),
          ...grantsFor(
            ['loan.read', 'reminder.policy.manage', 'reminder.template.approve'],
            LENDER_B,
            'Other',
          ),
        ],
      };
      const { container } = render(
        <PolicyPage
          lender={ctx.grants[0] ?? null}
          page={pageOf([policy()])}
          query={{}}
          ctx={ctx}
        />,
      );
      expect(ops(container)).toEqual([]);
    });
  });

  describe('the draft form', () => {
    it('labels every control, starts empty and unticked, and offers no SMS', () => {
      const { container } = view([]);
      const form = ctxFor(MANAGE);
      expect(form).toBeTruthy();
      const offsets = screen.getByLabelText<HTMLInputElement>('Days from each due date');
      expect(offsets.value).toBe('');
      expect(offsets.required).toBe(true);
      expect(screen.getByLabelText<HTMLInputElement>('In-app message').checked).toBe(false);
      expect(screen.getByLabelText<HTMLInputElement>('Push notification').checked).toBe(false);
      expect(
        screen.getByLabelText<HTMLInputElement>('Also send weekly overdue reminders').checked,
      ).toBe(false);
      expect(
        screen.getByLabelText<HTMLInputElement>('Daily window starts (India time)').value,
      ).toBe('');
      expect(screen.getByLabelText<HTMLInputElement>('Daily window ends (India time)').value).toBe(
        '',
      );
      expect(screen.getByLabelText<HTMLInputElement>('Most messages per loan per day').value).toBe(
        '',
      );
      expect(container.querySelector('input[value="sms"]')).toBeNull();
      expect(screen.getByText('SMS: not available, never sent.')).toBeTruthy();
    });

    it('suggests no value anywhere', () => {
      const { container } = view([]);
      const filled = [
        ...container.querySelectorAll<HTMLInputElement>(
          'form input:not([type="hidden"]):not([type="checkbox"])',
        ),
      ].filter((i) => i.value !== '');
      expect(filled).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('Wording', () => {
  const view = (
    items = [template()],
    permissions: readonly string[] = MANAGE,
    page?: Parameters<typeof WordingPage>[0]['page'],
  ) => {
    const ctx = ctxFor(permissions, '/reminders/wording');
    return render(
      <WordingPage
        lender={ctx.grants[0] ?? null}
        page={page ?? plainPage(items)}
        query={{}}
        ctx={ctx}
      />,
    );
  };

  it('shows the wording exactly as saved, with its line breaks, and does not run markup in it', () => {
    const { container } = view([template({ body: 'Line one\nLine two <b>bold</b> & more' })]);
    const dd = [...container.querySelectorAll('dd')].find((d) =>
      d.textContent?.startsWith('Line one'),
    );
    expect(dd?.textContent).toBe('Line one\nLine two <b>bold</b> & more');
    expect(container.querySelector('b')).toBeNull();
  });

  it('names the kind, language, version and status of each version', () => {
    view([
      template(),
      template({ id: TEMPLATE_2, kind: 'pre_due', language: 'hi', version: 3, status: 'approved' }),
    ]);
    expect(
      screen.getByRole('article', {
        name: /After the due date \(overdue\), English: version 1, Draft/,
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole('article', { name: /Before the due date, Hindi: version 3, Approved/ }),
    ).toBeTruthy();
  });

  it('lists the only placeholders a wording may use, and says an overdue wording needs the penal-charge one', () => {
    const { container } = view([]);
    for (const name of ['lender_name', 'due_date', 'amount', 'penal_text'])
      expect(text(container)).toContain(`{{${name}}}`);
    expect(text(container)).toMatch(/Wording for an overdue reminder must contain/);
    expect(text(container)).toMatch(/Udofin does not suggest, generate or translate/);
  });

  it('says Hindi is checked for shape only', () => {
    const { container } = view([]);
    expect(text(container)).toMatch(/Hindi wording is checked only for its shape, not its meaning/);
  });

  it('says there is no wording yet', () => {
    view([]);
    expect(screen.getByText('No wording yet')).toBeTruthy();
  });

  it('shows a failure without server text', () => {
    const { container } = view([], MANAGE, fail(500, 'SQLSTATE 23505'));
    expect(screen.getByText('Could not load the wording')).toBeTruthy();
    expect(text(container)).not.toContain('23505');
  });

  it('guards the forms by role and by drafter, like the policy', () => {
    const readOnly = view([template()], READ);
    expect(ops(readOnly.container)).toEqual([]);
    cleanup();
    expect(ops(view([template()], MANAGE).container).sort()).toEqual([
      'reminders.template.draft',
      'reminders.template.retire',
    ]);
    cleanup();
    expect(ops(view([template()], APPROVE).container)).toEqual(['reminders.template.approve']);
    cleanup();
    expect(ops(view([template({ draftedBy: ME })], APPROVE).container)).toEqual([]);
  });

  it('starts the draft form empty', () => {
    view([]);
    expect(screen.getByLabelText<HTMLSelectElement>('Kind of reminder').value).toBe('');
    expect(screen.getByLabelText<HTMLSelectElement>('Language').value).toBe('');
    expect(screen.getByLabelText<HTMLTextAreaElement>('Wording').value).toBe('');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('Penal-charge text', () => {
  const view = (
    items = [penal()],
    permissions: readonly string[] = MANAGE,
    over: { approved?: boolean; page?: Parameters<typeof PenalTextPage>[0]['page'] } = {},
  ) => {
    const ctx = ctxFor(permissions, '/reminders/penal-text');
    return render(
      <PenalTextPage
        lender={ctx.grants[0] ?? null}
        page={over.page ?? pageOf(items, over.approved ?? true)}
        query={{}}
        ctx={ctx}
      />,
    );
  };

  it('shows the lender’s flat figure and statements as the lender stated them, and the sentences verbatim', () => {
    const { container } = view([
      penal({ sentenceEn: 'Exactly this <i>sentence</i>.', sentenceHi: 'ठीक यही वाक्य।' }),
    ]);
    const card = screen.getByRole('article', { name: /Version 1: Draft/ });
    expect(text(card)).toContain('A flat amount: ₹250.00 of the overdue amount');
    expect(text(card)).toContain('Stated by the lender: charged separately from interest');
    expect(text(card)).toContain('Stated by the lender: not compounded');
    expect(text(card)).toContain('Exactly this <i>sentence</i>.');
    expect(text(card)).toContain('ठीक यही वाक्य।');
    expect(text(card)).toContain('Late payment of an instalment.');
    expect(container.querySelector('i')).toBeNull();
  });

  it('shows a percentage as the lender stated it and applies it to nothing', () => {
    const { container } = view([
      penal({ chargeKind: 'percentage', flatAmountMinor: null, percentBps: 250 }),
    ]);
    expect(text(container)).toContain('A percentage: 2.50 per cent of the overdue amount');
    // Nothing is calculated from it: no rupee amount appears anywhere on the page.
    expect(text(container)).not.toMatch(/₹/);
  });

  it('shows no calculated amount beside a flat figure', () => {
    const { container } = view([penal()]);
    expect([...text(container).matchAll(/₹[\d,]+\.\d\d/g)].map((m) => m[0])).toEqual(['₹250.00']);
  });

  it('says plainly when there is no Hindi sentence, and shows a stated "no" as no', () => {
    const { container } = view([penal({ separateFromInterest: false, notCompounded: false })]);
    expect(text(container)).toContain('No Hindi sentence');
    const dts = [...container.querySelectorAll('dt')].filter((d) =>
      d.textContent?.startsWith('Stated by the lender'),
    );
    expect(dts.map((d) => d.nextElementSibling?.textContent)).toEqual(['No', 'No']);
  });

  it('shows the notice about overdue reminders while no approved text exists, and not afterwards', () => {
    view([penal()], MANAGE, { approved: false });
    expect(
      screen.getByRole('heading', {
        name: /Overdue reminders are not sent until an approved penal-charge text exists/,
      }),
    ).toBeTruthy();
    cleanup();
    const { container } = view([penal({ status: 'approved' })], MANAGE, { approved: true });
    expect(text(container)).not.toMatch(/are not sent until an approved penal-charge text exists/);
  });

  it('warns that retiring the only approved text stops overdue reminders', () => {
    view([penal({ status: 'approved' })], MANAGE);
    expect(
      screen.getByText(/retiring it stops overdue reminders until another is approved/),
    ).toBeTruthy();
  });

  it('guards the forms by role and by drafter', () => {
    expect(ops(view([penal()], READ).container)).toEqual([]);
    cleanup();
    expect(ops(view([penal()], MANAGE).container).sort()).toEqual([
      'reminders.penal.draft',
      'reminders.penal.retire',
    ]);
    cleanup();
    expect(ops(view([penal()], APPROVE).container)).toEqual(['reminders.penal.approve']);
    cleanup();
    expect(ops(view([penal({ draftedBy: ME })], APPROVE).container)).toEqual([]);
  });

  it('asks for the two statements as required boxes that are never ticked for the lender', () => {
    view([]);
    for (const label of [
      'Our organisation states that this charge is charged separately from interest.',
      'Our organisation states that this charge is not compounded.',
    ]) {
      const box = screen.getByLabelText<HTMLInputElement>(label);
      expect(box.type).toBe('checkbox');
      expect(box.required).toBe(true);
      expect(box.checked).toBe(false);
    }
  });

  it('says it is the lender’s own statement and not a legal opinion, and offers no suggestion', () => {
    const { container } = view([]);
    expect(text(container)).toMatch(/Udofin does not suggest, translate or calculate any charge/);
    expect(text(container)).toMatch(/not a legal opinion/);
    const filled = [
      ...container.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
        'form input:not([type="hidden"]):not([type="checkbox"]), form textarea',
      ),
    ].filter((i) => i.value !== '');
    expect(filled).toEqual([]);
  });

  it('says there is none yet, and shows a failure without server text', () => {
    view([]);
    expect(screen.getByText('No penal-charge text yet')).toBeTruthy();
    cleanup();
    const { container } = view([], MANAGE, { page: fail(500, 'SQLSTATE 23505') });
    expect(screen.getByText('Could not load the penal-charge text')).toBeTruthy();
    expect(text(container)).not.toContain('23505');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('Holds', () => {
  const view = (
    holds: Parameters<typeof HoldsPage>[0]['holds'],
    permissions: readonly string[] = MANAGE,
    query = {},
  ) => {
    const ctx = ctxFor(permissions, '/reminders/holds');
    return render(<HoldsPage holds={holds} query={query} ctx={ctx} done={false} />);
  };

  it('says that a hold never stops the borrower from paying', () => {
    const { container } = view(plainPage([]));
    expect(text(container)).toMatch(/A hold never stops the borrower from paying/);
  });

  it('shows an active hold with a release form, and a released hold with its release note', () => {
    const { container } = view(
      plainPage([
        hold(),
        hold({
          id: HOLD_2,
          reason: 'legal',
          note: null,
          active: false,
          releasedBy: THIRD,
          releasedAt: AT_2,
          releaseNote: 'Sorted out.',
        }),
      ]),
    );
    const rows = within(screen.getByRole('table', { name: 'Holds, newest first' })).getAllByRole(
      'row',
    );
    expect(text(rows[1] as HTMLElement)).toContain('Hardship');
    expect(text(rows[1] as HTMLElement)).toContain('The lender asked for a pause.');
    expect(text(rows[1] as HTMLElement)).toContain('Active');
    expect(text(rows[2] as HTMLElement)).toContain('Released 17 Oct 2026, 10:00 IST: Sorted out.');
    expect(ops(container).sort()).toEqual(['reminders.hold.place', 'reminders.hold.release']);
    expect(text(container)).not.toMatch(/lender_instruction|borrower_request|hardship/);
  });

  it('guards: a read-only role sees no place or release form', () => {
    const { container } = view(plainPage([hold()]), READ);
    expect(ops(container)).toEqual([]);
    expect(screen.queryByText('Place a hold')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Release this hold' })).toBeNull();
  });

  it('guards: release is drawn only for a lender the person manages', () => {
    const ctx: RemindersContext = {
      ...ctxFor(MANAGE, '/reminders/holds'),
      grants: [...grantsFor(MANAGE, LENDER_A), ...grantsFor(READ, LENDER_B, 'Other')],
    };
    const { container } = render(
      <HoldsPage
        holds={plainPage([hold({ lenderId: LENDER_B }), hold({ id: HOLD_2, lenderId: LENDER_A })])}
        query={{}}
        ctx={ctx}
      />,
    );
    expect(ops(container).filter((o) => o === 'reminders.hold.release')).toHaveLength(1);
  });

  it('starts the place form empty with every control labelled', () => {
    view(plainPage([]));
    expect(screen.getByLabelText<HTMLInputElement>('Loan ID').value).toBe('');
    expect(screen.getByLabelText<HTMLSelectElement>('Reason').value).toBe('');
    expect(screen.getByLabelText<HTMLTextAreaElement>('Note (optional)').value).toBe('');
  });

  it('says there are no holds, and shows a failure without server text', () => {
    view(plainPage([]));
    expect(screen.getByText('No holds')).toBeTruthy();
    cleanup();
    const { container } = view(fail(500, 'SQLSTATE 23505'));
    expect(screen.getByText('Could not load the holds')).toBeTruthy();
    expect(text(container)).not.toContain('23505');
  });

  it('links each hold to its loan without naming a borrower', () => {
    view(plainPage([hold()]));
    expect(screen.getByRole('link', { name: 'The loan' }).getAttribute('href')).toBe(
      `/loans/${LOAN}`,
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('the forms that keep what was typed', () => {
  const user = () => userEvent.setup();

  it('sends the policy form with a fresh request key each time and keeps the text after a refusal', async () => {
    const seen: FormData[] = [];
    const action = vi.fn((form: FormData) => {
      seen.push(form);
      return Promise.resolve({ ok: false as const, code: 'window_invalid' });
    });
    const u = user();
    render(<PolicyDraftFields lenderId={LENDER_A} action={action} returnTo="/reminders/policy" />);
    await u.type(screen.getByLabelText('Days from each due date'), '-3, 0');
    await u.click(screen.getByLabelText('In-app message'));
    await u.click(screen.getByLabelText('Also send weekly overdue reminders'));
    fireEvent.change(screen.getByLabelText('Daily window starts (India time)'), {
      target: { value: '09:00' },
    });
    fireEvent.change(screen.getByLabelText('Daily window ends (India time)'), {
      target: { value: '18:00' },
    });
    await u.type(screen.getByLabelText('Most messages per loan per day'), '1');
    await u.click(screen.getByRole('button', { name: 'Save as a draft' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(
      'The daily window was not accepted. It can only be inside what the platform allows.',
    );
    await waitFor(() =>
      expect(screen.getByLabelText<HTMLInputElement>('Days from each due date').value).toBe(
        '-3, 0',
      ),
    );
    expect(screen.getByLabelText<HTMLInputElement>('In-app message').checked).toBe(true);
    expect(screen.getByLabelText<HTMLInputElement>('Push notification').checked).toBe(false);
    expect(
      screen.getByLabelText<HTMLInputElement>('Also send weekly overdue reminders').checked,
    ).toBe(true);
    expect(screen.getByLabelText<HTMLInputElement>('Daily window starts (India time)').value).toBe(
      '09:00',
    );
    await u.click(screen.getByRole('button', { name: 'Save as a draft' }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(2));
    const first = seen[0];
    expect(first?.get('op')).toBe('reminders.policy.draft');
    expect(first?.get('lenderId')).toBe(LENDER_A);
    expect(first?.getAll('channels')).toEqual(['in_app']);
    expect(first?.get('overdueWeekly')).toBe('on');
    expect(first?.get('returnTo')).toBe('/reminders/policy');
    expect(first?.get('key')).toMatch(/^ui-[0-9a-f-]{36}$/);
    expect(seen[1]?.get('key')).toMatch(/^ui-[0-9a-f-]{36}$/);
    expect(seen[1]?.get('key')).not.toBe(first?.get('key'));
  });

  it('shows an error as a sentence and never the text the server sent', async () => {
    const action = vi.fn(() =>
      Promise.resolve({ ok: false as const, code: 'SQLSTATE 23505 duplicate key' }),
    );
    const u = user();
    const { container } = render(<HoldPlaceFields action={action} returnTo="/reminders/holds" />);
    await u.type(screen.getByLabelText('Loan ID'), LOAN);
    await u.selectOptions(screen.getByLabelText('Reason'), 'legal');
    await u.click(screen.getByRole('button', { name: 'Place the hold' }));
    expect((await screen.findByRole('alert')).textContent).toBe(GENERIC);
    expect(text(container)).not.toMatch(/SQLSTATE|23505|duplicate/);
  });

  it('says the action was recorded, and empties the form, after success', async () => {
    const action = vi.fn(() => Promise.resolve({ ok: true as const }));
    const u = user();
    render(
      <TemplateDraftFields lenderId={LENDER_A} action={action} returnTo="/reminders/wording" />,
    );
    await u.selectOptions(screen.getByLabelText('Kind of reminder'), 'overdue');
    await u.selectOptions(screen.getByLabelText('Language'), 'en');
    await u.type(screen.getByLabelText('Wording'), 'Hello {{lender_name}}');
    await u.click(screen.getByRole('button', { name: 'Save as a draft' }));
    expect((await screen.findByRole('status')).textContent).toBe('Your action was recorded.');
    await waitFor(() =>
      expect(screen.getByLabelText<HTMLTextAreaElement>('Wording').value).toBe(''),
    );
  });

  it('says it is sending, and cannot be sent twice meanwhile', async () => {
    let finish: (outcome: { ok: true }) => void = () => undefined;
    const action = vi.fn(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          finish = resolve;
        }),
    );
    const u = user();
    render(<HoldPlaceFields action={action} returnTo="/reminders/holds" />);
    await u.type(screen.getByLabelText('Loan ID'), LOAN);
    await u.selectOptions(screen.getByLabelText('Reason'), 'legal');
    await u.click(screen.getByRole('button', { name: 'Place the hold' }));
    const waiting = await screen.findByRole('button', { name: 'Sending…' });
    expect((waiting as HTMLButtonElement).disabled).toBe(true);
    finish({ ok: true });
    await screen.findByRole('button', { name: 'Place the hold' });
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('does not restore the two statements about a penal charge after a refusal', async () => {
    const action = vi.fn(() => Promise.resolve({ ok: false as const, code: 'charge_invalid' }));
    const u = user();
    render(
      <PenalDraftFields lenderId={LENDER_A} action={action} returnTo="/reminders/penal-text" />,
    );
    await u.selectOptions(screen.getByLabelText('Kind of charge'), 'flat');
    await u.type(screen.getByLabelText('Flat amount in rupees (for a flat charge)'), '250');
    await u.type(screen.getByLabelText('Reason for the charge'), 'A reason');
    await u.type(screen.getByLabelText('Sentence shown to the borrower, in English'), 'A sentence');
    const separate = screen.getByLabelText<HTMLInputElement>(
      'Our organisation states that this charge is charged separately from interest.',
    );
    const compounded = screen.getByLabelText<HTMLInputElement>(
      'Our organisation states that this charge is not compounded.',
    );
    await u.click(separate);
    await u.click(compounded);
    await u.click(screen.getByRole('button', { name: 'Save as a draft' }));
    await screen.findByRole('alert');
    await waitFor(() =>
      expect(screen.getByLabelText<HTMLTextAreaElement>('Reason for the charge').value).toBe(
        'A reason',
      ),
    );
    expect(separate.checked).toBe(false);
    expect(compounded.checked).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('across every page', () => {
  const everyPage = () => {
    const ctx = ctxFor([...MANAGE, 'reminder.template.approve'] as const, '/reminders');
    // The grants hold both permissions here so every form is drawn; the segregation of the two is the database's rule.
    const lender = ctx.grants[0] ?? null;
    return [
      render(
        <RemindersLogPage
          lender={lender}
          summary={ok({
            lenderId: LENDER_A,
            since: null,
            items: [{ status: 'sent', suppressReason: null, channel: 'push', count: 3 }],
          })}
          reminders={plainPage([reminder()])}
          overdue={withFlag(false)}
          query={{}}
          ctx={ctx}
        />,
      ),
      render(
        <PolicyPage
          lender={lender}
          page={pageOf([policy(), policy({ id: POLICY_2, status: 'approved', version: 1 })])}
          query={{}}
          ctx={ctx}
        />,
      ),
      render(
        <WordingPage
          lender={lender}
          page={plainPage([
            template(),
            template({ id: TEMPLATE_2, status: 'approved', version: 2 }),
          ])}
          query={{}}
          ctx={ctx}
        />,
      ),
      render(
        <PenalTextPage
          lender={lender}
          page={pageOf([penal(), penal({ id: PENAL_2, status: 'approved', version: 2 })])}
          query={{}}
          ctx={ctx}
        />,
      ),
      render(<HoldsPage holds={plainPage([hold()])} query={{}} ctx={ctx} />),
      render(<ReminderAttemptsPage log={ok({ reminderId: REMINDER, items: [delivery()] })} />),
    ];
  };

  it('draws only operations that are on the allow-list, and draws every operation on it somewhere', () => {
    const drawn = new Set<string>();
    for (const view of everyPage()) for (const op of ops(view.container)) drawn.add(op);
    for (const op of drawn) expect(Object.hasOwn(REMINDERS_OPERATIONS, op), op).toBe(true);
    expect([...drawn].sort()).toEqual(Object.keys(REMINDERS_OPERATIONS).sort());
  });

  it('has exactly one h1 per page and labels every control', () => {
    for (const view of everyPage()) {
      expect(view.container.querySelectorAll('h1')).toHaveLength(1);
      const controls = view.container.querySelectorAll<HTMLInputElement>(
        'input:not([type="hidden"]), select, textarea',
      );
      for (const control of controls)
        expect(control.labels?.length ?? 0, `${control.tagName} ${control.name}`).toBeGreaterThan(
          0,
        );
      for (const table of view.container.querySelectorAll('table'))
        expect(table.querySelector('caption'), 'a table has a caption').toBeTruthy();
    }
  });

  it('puts a scope on every table header', () => {
    for (const view of everyPage())
      for (const th of view.container.querySelectorAll('th'))
        expect(th.getAttribute('scope'), th.textContent ?? '').toBeTruthy();
  });

  it('uses calm wording: no urgency, no countdown, no marketing', () => {
    const banned =
      /urgent|hurry|last chance|act now|limited time|don.t miss|expires? in|countdown|offer|discount|cashback|free\b|only today/i;
    for (const view of everyPage()) expect(text(view.container)).not.toMatch(banned);
  });

  it('makes no claim of compliance, approval by a regulator or safety', () => {
    const claims =
      /complian|regulator|RBI|legally|certified|guarantee|safe\b|secure\b|approved by (the )?(bank|authority)/i;
    for (const view of everyPage()) expect(text(view.container)).not.toMatch(claims);
  });

  it('shows no raw vocabulary value, database state or long run of digits', () => {
    for (const view of everyPage()) {
      const t = stripIds(text(view.container)).replace(/[0-9a-f]{64}/g, 'HASH');
      expect(t).not.toMatch(
        /\b(in_app|pre_due|due_day|penal_text_missing|sms_not_configured|not_configured|delivery_report|SQLSTATE)\b/,
      );
      expect(t).not.toMatch(/\d{9,}/);
    }
  });

  it('sends the person back to a reminders page and puts the lender’s own return path in every form', () => {
    for (const view of everyPage())
      for (const input of view.container.querySelectorAll<HTMLInputElement>(
        'input[name="returnTo"]',
      ))
        expect(safeRemindersReturnPath(input.value)).toBe(input.value);
  });

  it('never prints a person’s name, phone number or account number in a link', () => {
    for (const view of everyPage())
      for (const a of view.container.querySelectorAll('a')) {
        const href = stripIds(a.getAttribute('href') ?? '');
        expect(href).not.toMatch(/\d{6,}|@|name=|phone|account/i);
      }
  });
});
