// @vitest-environment jsdom
import {
  LP_DEBIT_STATUSES,
  LP_EVENT_OBJECT_KINDS,
  LP_EVENT_OUTCOMES,
  LP_EXCEPTION_ACTIONS,
  LP_EXCEPTION_OWNERS,
  LP_EXCEPTION_SEVERITIES,
  LP_EXCEPTION_STATUSES,
  LP_MANDATE_RAILS,
  LP_MANDATE_REQUIREMENTS,
  LP_MANDATE_STATUSES,
  LP_PAYMENT_PURPOSES,
  LP_PAYMENT_STATUSES,
  LP_PROVIDER_PAYMENT_STATUSES,
  LP_RECEIPT_OUTCOMES,
  LP_REOPEN_REASONS,
  LP_RESOLVE_REASONS,
  LP_RETURN_CLASSES,
  LP_ADJUSTMENT_KINDS,
  LpPaymentListQuery,
} from '@udofin/contracts';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ZodType } from 'zod';
import {
  LP_OPERATION_NAMES,
  LpBankCreditUploadView,
  LpExceptionDetailView,
  LpExceptionsQueueView,
  LpMandateDebitsView,
  LpMandateDetailView,
  LpMandatePolicyView,
  LpMandatesListView,
  LpNotice,
  LpPaymentDetailView,
  LpPaymentPolicyView,
  LpPaymentsListView,
  LpProviderEventsView,
  LpReconciliationReportView,
  LpReconciliationRunsView,
  LpReconciliationSettingsView,
  LpSettlementBatchesView,
  LpSettlementBatchView,
  lpCapabilitiesFrom,
  lpCheckStatementHeader,
  lpCount,
  lpDate,
  lpDateTimeIst,
  lpErrorMessage,
  lpIsDate,
  lpIsUuid,
  lpLenderFrom,
  lpLoadExceptionDetail,
  lpLoadMandateDetail,
  lpLoadPaymentDetail,
  lpLoadPayments,
  lpLoadProviderEvents,
  lpLoadReconSummary,
  lpLoadSettlementItems,
  lpParseRupees,
  lpQueryString,
  lpRunOperation,
  lpRupees,
  lpRupeesPlain,
  lpSafeReturnPath,
  lpSplitEvidence,
  lpWord,
  type LpResult,
  type LpViewContext,
  type OnboardingApi,
  type OnboardingResult,
} from '../src/index.js';
import * as labels from '../src/payments/labels.js';
import {
  type ExceptionDetail,
  type ExceptionRow,
  type MandateDebit,
  type MandateDetail,
  type PaymentDetail,
  type PaymentRow,
  type ProviderEventPage,
  type ReconSummary,
  type SettlementBatch,
} from '../src/payments/types.js';

afterEach(cleanup);

// ---------------------------------------------------------------------------------------------------------------
// Fixtures: fixed, synthetic values only (no person, no real account, nothing shaped like a credential).
// ---------------------------------------------------------------------------------------------------------------
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const LENDER = uid(1);
const PAY = uid(2);
const LOAN = uid(3);
const ME = uid(9);
const COLLEAGUE = uid(10);
const KEY = 'ui-0f1e2d3c-4b5a-4c6d-8e7f-0a1b2c3d4e5f';
const STAMP = '2026-10-16T08:35:00+00:00';

const ok = <T,>(data: T): LpResult<T> => ({ ok: true, data });
const bad = (status: number, code: string): LpResult<never> => ({ ok: false, status, code });

const payment = (over: Partial<PaymentRow> = {}): PaymentRow => ({
  id: PAY,
  lenderId: LENDER,
  loanAccountId: LOAN,
  purpose: 'installment',
  amountMinor: 12345678,
  currency: 'INR',
  status: 'succeeded',
  provider: 'testpay',
  providerMode: 'sandbox',
  providerOrderRef: 'order-ref-1',
  targetInstallmentSeq: 4,
  linkExpiresAt: '2026-10-17T08:35:00+00:00',
  createdAt: STAMP,
  updatedAt: STAMP,
  ...over,
});

type Stage = NonNullable<PaymentDetail['providerPayments'][number]['stage']>;
const stage = (over: Partial<Stage> = {}): Stage => ({
  stage: 'provider_captured',
  providerCaptured: true,
  providerSettled: false,
  bankConfirmed: false,
  lenderPosted: false,
  settlementDestinationOk: null,
  ...over,
});

const detail = (
  over: Partial<PaymentDetail['providerPayments'][number]> = {},
  adjustments: PaymentDetail['adjustments'] = [],
): PaymentDetail => ({
  payment: payment(),
  providerPayments: [
    {
      id: uid(20),
      providerPaymentRef: 'pp-ref-1',
      orderRef: 'order-ref-1',
      status: 'captured',
      amountMinor: 12345678,
      currency: 'INR',
      capturedAt: STAMP,
      duplicateCapture: false,
      createdAt: STAMP,
      updatedAt: STAMP,
      stage: stage(),
      ...over,
    },
  ],
  adjustments,
});

const event = (over: Partial<ProviderEventPage['items'][number]> = {}) =>
  ({
    id: uid(30),
    lenderId: LENDER,
    provider: 'testpay',
    providerEventId: 'evt-1',
    eventType: 'payment.captured',
    objectKind: 'payment',
    objectRef: 'pp-ref-1',
    orderRef: 'order-ref-1',
    paymentIntentId: PAY,
    providerStatus: 'captured',
    amountMinor: 12345678,
    currency: 'INR',
    occurredAt: STAMP,
    receivedAt: STAMP,
    processingClass: 'actionable',
    verification: { authentication: 'x', integrity: 'x', correlation: 'x', business: 'x' },
    processing: {
      outcome: 'applied',
      reasonClass: 'intent_succeeded',
      attempt: 1,
      deferredUntil: null,
      processedAt: STAMP,
    },
    ...over,
  }) satisfies ProviderEventPage['items'][number];

const mandateRow = (over: Partial<MandateDetail['mandate']> = {}): MandateDetail['mandate'] => ({
  id: uid(40),
  lenderId: LENDER,
  loanAccountId: LOAN,
  rail: 'enach_api',
  status: 'registration_pending',
  provider: 'testpay',
  providerMode: 'sandbox',
  providerMandateRef: 'mandate-ref-1',
  maxAmountMinor: 5000000,
  startDate: '2026-11-01',
  endDate: '2027-11-01',
  maskedAccountRef: 'XXXXXX1234',
  needsAfaEachDebit: false,
  handoffExpiresAt: null,
  lastEventAt: null,
  cancelRequestedAt: null,
  cancelReason: null,
  cancelSentAt: null,
  createdAt: STAMP,
  updatedAt: STAMP,
  ...over,
});

const debit = (over: Partial<MandateDebit> = {}): MandateDebit => ({
  id: uid(50),
  lenderId: LENDER,
  mandateId: uid(40),
  loanAccountId: LOAN,
  planned: true,
  installmentSeq: 3,
  scheduledOn: '2026-12-05',
  amountMinor: 250000,
  status: 'scheduled',
  providerDebitRef: null,
  returnCode: null,
  returnClass: null,
  exceedsMandateMax: false,
  createdAt: STAMP,
  updatedAt: STAMP,
  ...over,
});

const mandateDetail = (over: Partial<MandateDetail> = {}): MandateDetail => ({
  mandate: mandateRow(),
  events: [],
  debits: [],
  notices: [],
  ...over,
});

const batch = (over: Partial<SettlementBatch> = {}): SettlementBatch => ({
  id: uid(60),
  lenderId: LENDER,
  provider: 'testpay',
  batchRef: 'batch-ref-1',
  settlementRef: 'UTR-TEST-0001',
  periodFrom: '2026-10-14',
  periodTo: '2026-10-15',
  destinationMaskedRef: 'XXXXXX4321',
  destinationOk: true,
  grossMinor: 1000000,
  feeMinor: 20000,
  taxMinor: 3600,
  netMinor: 976400,
  partsMismatch: false,
  itemCount: 2,
  reportDate: '2026-10-16',
  receivedAt: STAMP,
  ...over,
});

const exceptionRow = (over: Partial<ExceptionRow> = {}): ExceptionRow => ({
  id: uid(70),
  lenderId: LENDER,
  class: 'amount_mismatch',
  severity: 'warning',
  owner: 'lender',
  status: 'open',
  subject: { intent_id: PAY },
  assignedTo: null,
  openedAt: STAMP,
  resolvedAt: null,
  updatedAt: STAMP,
  ...over,
});

const exceptionDetail = (over: Partial<ExceptionRow> = {}): ExceptionDetail => ({
  exception: exceptionRow(over),
  events: [
    {
      id: uid(71),
      action: 'opened',
      actorKind: 'system',
      actorUserId: null,
      reasonCode: null,
      evidence: null,
      note: null,
      assignedTo: null,
      authorisedByPermission: null,
      occurredAt: STAMP,
    },
  ],
});

const report = (over: Partial<ReconSummary['report']> = {}): ReconSummary['report'] => ({
  runDate: '2026-10-16',
  paymentsConsidered: 10,
  matched: { settlement: 8, bank: 7, receipt: 6 },
  notReconcilable: [],
  settledToNonLender: { items: 0, minor: 0 },
  settings: { settlementLagDays: 3, receiptLagHours: 72 },
  ...over,
});

const summary = (over: Partial<ReconSummary['report']> = {}): ReconSummary => ({
  runId: uid(80),
  lenderId: LENDER,
  runNo: 2,
  runDate: '2026-10-16',
  counts: {
    paymentsConsidered: 10,
    matchedToSettlement: 8,
    matchedToBank: 7,
    matchedToReceipt: 6,
  },
  report: report(over),
  createdAt: STAMP,
});

const ctx = (
  permissions: string[],
  over: Partial<LpViewContext> = {},
  action = vi.fn(() => Promise.resolve()),
): LpViewContext => ({
  action,
  returnTo: '/payments/policy',
  caps: lpCapabilitiesFrom(permissions),
  userId: ME,
  lenderId: LENDER,
  ...over,
});

const text = (container: HTMLElement) => container.textContent ?? '';

// ---------------------------------------------------------------------------------------------------------------
// A recording stand-in for the API client.
// ---------------------------------------------------------------------------------------------------------------
interface Call {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  key?: string;
}
function recorder(reply: unknown = { outcome: 'set' }, failure?: { status: number; code: string }) {
  const calls: Call[] = [];
  const api: OnboardingApi = {
    get: <T,>(path: string, _schema: ZodType<T>) => {
      calls.push({ method: 'GET', path });
      return Promise.resolve({ ok: false as const, status: 500, code: 'unused' });
    },
    post: <T,>(path: string, _schema: ZodType<T>, body: unknown, key: string) => {
      calls.push({ method: 'POST', path, body, key });
      return Promise.resolve(
        failure
          ? { ok: false as const, status: failure.status, code: failure.code }
          : ({ ok: true, status: 200, data: reply } as OnboardingResult<T>),
      );
    },
  };
  return { api, calls };
}

const form = (fields: Record<string, string | File>): FormData => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

// ---------------------------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------------------------
describe('money, dates and counts', () => {
  it('writes integer paise as rupees with Indian grouping and two decimals', () => {
    expect(lpRupees(0)).toBe('₹0.00');
    expect(lpRupees(5)).toBe('₹0.05');
    expect(lpRupees(99999)).toBe('₹999.99');
    expect(lpRupees(100000)).toBe('₹1,000.00');
    expect(lpRupees(12345678)).toBe('₹1,23,456.78');
    expect(lpRupees(1000000000)).toBe('₹1,00,00,000.00');
    expect(lpRupees(100_000_000_000_000)).toBe('₹10,00,00,00,00,000.00');
  });

  it('never writes a missing or invalid figure as zero', () => {
    expect(lpRupees(null)).toBe('Not reported');
    expect(lpRupees(undefined)).toBe('Not reported');
    expect(lpRupees(null, 'Withheld')).toBe('Withheld');
    expect(lpRupees(1.5)).toBe('Not available');
    expect(lpRupees(-100)).toBe('Not available');
    expect(lpRupees(Number.NaN)).toBe('Not available');
    expect(lpCount(null)).toBe('Not available');
    expect(lpCount(-1)).toBe('Not available');
    expect(lpCount(1234567)).toBe('12,34,567');
  });

  it('writes plain rupees for a form field', () => {
    expect(lpRupeesPlain(150050)).toBe('1500.50');
    expect(lpRupeesPlain(5)).toBe('0.05');
    expect(lpRupeesPlain(null)).toBe('');
  });

  it('writes dates as stated and timestamps in IST with the 24-hour clock', () => {
    expect(lpDate('2026-10-16')).toBe('16 Oct 2026');
    expect(lpDate('2026-13-01')).toBe('Not available');
    expect(lpDate(null)).toBe('Not available');
    expect(lpDateTimeIst('2026-10-16T08:35:00+00:00')).toBe('16 Oct 2026, 14:05 IST');
    expect(lpDateTimeIst('2026-10-16T14:05:00+05:30')).toBe('16 Oct 2026, 14:05 IST');
    // The day rolls over in IST before it does in UTC.
    expect(lpDateTimeIst('2026-10-16T20:00:00Z')).toBe('17 Oct 2026, 01:30 IST');
    expect(lpDateTimeIst('2026-10-16T08:35:00.123456+00:00')).toBe('16 Oct 2026, 14:05 IST');
    expect(lpDateTimeIst('not a date')).toBe('Not available');
    expect(lpDateTimeIst(null)).toBe('Not available');
  });

  it('reads typed rupees into paise by string arithmetic and refuses anything it would have to guess', () => {
    expect(lpParseRupees('1500')).toBe(150000);
    expect(lpParseRupees('1500.5')).toBe(150050);
    expect(lpParseRupees(' 0.07 ')).toBe(7);
    expect(lpParseRupees('0.10')).toBe(10);
    expect(lpParseRupees('999999999999.99')).toBe(99999999999999);
    for (const refused of ['1,500', '₹5', '1.234', '', '-1', '1e3', '1.', '.5', '1500 rupees']) {
      expect(lpParseRupees(refused), refused).toBeNull();
    }
    expect(lpParseRupees('1000000000000')).toBeNull();
  });

  it('recognises ids and dates strictly', () => {
    expect(lpIsUuid(PAY)).toBe(true);
    expect(lpIsUuid('../etc')).toBe(false);
    expect(lpIsUuid(undefined)).toBe(false);
    expect(lpIsDate('2026-10-16')).toBe(true);
    expect(lpIsDate('2026-10-16T00:00')).toBe(false);
  });
});

describe('words', () => {
  const lists: [string, readonly string[], Readonly<Record<string, string>>][] = [
    ['payment statuses', LP_PAYMENT_STATUSES, labels.PAYMENT_STATUS_WORDS],
    ['payment purposes', LP_PAYMENT_PURPOSES, labels.PAYMENT_PURPOSE_WORDS],
    [
      'provider payment statuses',
      LP_PROVIDER_PAYMENT_STATUSES,
      labels.PROVIDER_PAYMENT_STATUS_WORDS,
    ],
    ['adjustment kinds', LP_ADJUSTMENT_KINDS, labels.ADJUSTMENT_KIND_WORDS],
    ['event object kinds', LP_EVENT_OBJECT_KINDS, labels.EVENT_OBJECT_KIND_WORDS],
    ['event outcomes', LP_EVENT_OUTCOMES, labels.EVENT_OUTCOME_WORDS],
    ['receipt outcomes', LP_RECEIPT_OUTCOMES, labels.RECEIPT_OUTCOME_WORDS],
    ['mandate rails', LP_MANDATE_RAILS, labels.MANDATE_RAIL_WORDS],
    ['mandate statuses', LP_MANDATE_STATUSES, labels.MANDATE_STATUS_WORDS],
    ['mandate requirements', LP_MANDATE_REQUIREMENTS, labels.MANDATE_REQUIREMENT_WORDS],
    ['debit statuses', LP_DEBIT_STATUSES, labels.DEBIT_STATUS_WORDS],
    ['return classes', LP_RETURN_CLASSES, labels.RETURN_CLASS_WORDS],
    ['exception statuses', LP_EXCEPTION_STATUSES, labels.EXCEPTION_STATUS_WORDS],
    ['exception actions', LP_EXCEPTION_ACTIONS, labels.EXCEPTION_ACTION_WORDS],
    ['exception severities', LP_EXCEPTION_SEVERITIES, labels.EXCEPTION_SEVERITY_WORDS],
    ['exception owners', LP_EXCEPTION_OWNERS, labels.EXCEPTION_OWNER_WORDS],
    ['resolve reasons', LP_RESOLVE_REASONS, labels.RESOLVE_REASON_WORDS],
    ['reopen reasons', LP_REOPEN_REASONS, labels.RESOLVE_REASON_WORDS],
  ];

  it.each(lists)('has words for every value of the contract list: %s', (_name, values, words) => {
    for (const value of values) {
      expect(lpWord(words, value), value).not.toBe(labels.LP_UNRECOGNISED);
    }
  });

  it('never echoes a value it does not know', () => {
    expect(lpWord(labels.PAYMENT_STATUS_WORDS, 'zz_unknown_code')).toBe(labels.LP_UNRECOGNISED);
    expect(lpWord(labels.PAYMENT_STATUS_WORDS, 'constructor')).toBe(labels.LP_UNRECOGNISED);
    expect(lpWord(labels.PAYMENT_STATUS_WORDS, '__proto__')).toBe(labels.LP_UNRECOGNISED);
    expect(lpWord(labels.PAYMENT_STATUS_WORDS, null)).toBe('—');
  });

  it('never says paid, successful or approved in its own voice', () => {
    const own = [
      labels.PAYMENT_STATUS_WORDS,
      labels.PAYMENT_PURPOSE_WORDS,
      labels.STAGE_WORDS,
      labels.STAGE_SOURCE_WORDS,
      labels.EVENT_OUTCOME_WORDS,
      labels.MANDATE_STATUS_WORDS,
      labels.DEBIT_STATUS_WORDS,
      labels.NOT_RECONCILABLE_WORDS,
    ];
    for (const words of own) {
      for (const value of Object.values(words))
        expect(value).not.toMatch(/\b(paid|successful|approved)\b/i);
    }
    // The one exception class that names an approval says whose it is: the lender's approved sentence.
    for (const value of Object.values(labels.EXCEPTION_CLASS_WORDS)) {
      expect(value).not.toMatch(/\b(paid|successful)\b/i);
    }
    // The provider's own word is quoted as the provider's.
    expect(labels.PROVIDER_PAYMENT_STATUS_WORDS.paid).toContain('The provider calls it');
    expect(labels.PAYMENT_STATUS_WORDS.succeeded).toBe('Received by the payment provider');
  });

  it('maps error codes to sentences and never shows an unknown code', () => {
    expect(lpErrorMessage('utr_conflict')).toContain('Nothing was stored');
    expect(lpErrorMessage('zz_secret_code')).toBe('The action could not be completed.');
    expect(lpErrorMessage('http_503')).toBe('The service had a problem. Try again later.');
    expect(lpErrorMessage(undefined)).toBe('The action could not be completed.');
    expect(lpErrorMessage('zz_secret_code')).not.toContain('zz_secret_code');
  });
});

describe('who and what', () => {
  it('reads what a role may do from its permissions', () => {
    expect(lpCapabilitiesFrom(['payment.read'])).toEqual({
      read: true,
      configure: false,
      reconcile: false,
    });
    expect(lpCapabilitiesFrom(['payment.configure', 'payment.reconcile'])).toEqual({
      read: true,
      configure: true,
      reconcile: true,
    });
    expect(lpCapabilitiesFrom([]).read).toBe(false);
  });

  it('picks the lender membership that holds a payment permission', () => {
    expect(
      lpLenderFrom([
        { organizationId: uid(5), organizationKind: 'platform', permissions: ['payment.read'] },
        { organizationId: uid(6), organizationKind: 'lender', permissions: ['loan.read'] },
        { organizationId: uid(7), organizationKind: 'lender', permissions: ['payment.read'] },
      ]),
    ).toBe(uid(7));
    expect(lpLenderFrom([])).toBeUndefined();
  });
});

describe('list queries', () => {
  it('keeps only filters the contract accepts and encodes the cursor', () => {
    const api = recorder();
    void lpLoadPayments(api.api, {
      status: 'succeeded',
      purpose: 'not_a_purpose',
      evil: 'x',
      cursor: 'a b+c:d',
    });
    expect(api.calls[0]?.path).toBe('/v1/lender/payments?status=succeeded&cursor=a+b%2Bc%3Ad');
  });

  it('drops an invalid filter instead of sending it', () => {
    expect(lpQueryString(LpPaymentListQuery, { status: 'bogus' }, ['status'])).toBe('');
  });

  it('refuses a malformed id or date before any request is made', async () => {
    const { api, calls } = recorder();
    expect((await lpLoadPaymentDetail(api, '../x')).ok).toBe(false);
    expect((await lpLoadMandateDetail(api, 'nope')).ok).toBe(false);
    expect((await lpLoadExceptionDetail(api, 'nope')).ok).toBe(false);
    expect((await lpLoadSettlementItems(api, 'nope', {})).ok).toBe(false);
    expect((await lpLoadReconSummary(api, LENDER, '2026-10-16T00:00')).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('asks only for the lender routes it needs', async () => {
    const { api, calls } = recorder();
    await lpLoadProviderEvents(api, {}, { paymentIntentId: PAY });
    await lpLoadPaymentDetail(api, PAY);
    await lpLoadReconSummary(api, LENDER, '2026-10-16');
    expect(calls.map((c) => c.path)).toEqual([
      `/v1/lender/provider-events?paymentIntentId=${PAY}`,
      `/v1/lender/payments/${PAY}`,
      `/v1/lender/reconciliation/summary?lenderId=${LENDER}&date=2026-10-16`,
    ]);
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Operations: the allow-list, the confirmation, the shapes sent
// ---------------------------------------------------------------------------------------------------------------
describe('operations: the allow-list', () => {
  it('knows exactly eight operations', () => {
    expect([...LP_OPERATION_NAMES].sort()).toEqual([
      'payments.bank_credits.upload',
      'payments.exception.acknowledge',
      'payments.exception.assign',
      'payments.exception.reopen',
      'payments.exception.resolve',
      'payments.mandate_policy.set',
      'payments.policy.set',
      'payments.recon_settings.set',
    ]);
  });

  it.each([
    'document.approve',
    'payments.refund',
    'payments.exception.delete',
    'payments.settlement.mark_settled',
    'constructor',
    '__proto__',
    'toString',
    '',
  ])('refuses the operation %j without calling the API', async (op) => {
    const { api, calls } = recorder();
    const outcome = await lpRunOperation(api, form({ op, key: KEY, id: uid(70), confirm: 'on' }));
    expect(outcome).toEqual({ ok: false, code: 'path_not_allowed' });
    expect(calls).toHaveLength(0);
  });

  it('refuses a missing or malformed idempotency key', async () => {
    const { api, calls } = recorder();
    const base = { op: 'payments.exception.acknowledge', id: uid(70), confirm: 'on' };
    expect(await lpRunOperation(api, form(base))).toEqual({ ok: false, code: 'validation_failed' });
    expect(await lpRunOperation(api, form({ ...base, key: 'short' }))).toEqual({
      ok: false,
      code: 'validation_failed',
    });
    expect(calls).toHaveLength(0);
  });

  it('returns only the stable code of an API refusal, never its text', async () => {
    const { api } = recorder({}, { status: 422, code: 'utr_conflict' });
    const outcome = await lpRunOperation(
      api,
      form({
        op: 'payments.bank_credits.upload',
        key: KEY,
        lenderId: LENDER,
        accountId: uid(4),
        csv: 'valueDate,amountMinor,utr\n2026-10-15,100,UTR-TEST-0001',
        confirm: 'on',
      }),
    );
    expect(outcome).toEqual({ ok: false, code: 'utr_conflict' });
  });
});

describe('operations: every write needs the box ticked on purpose', () => {
  const writes: Record<string, Record<string, string>> = {
    'payments.policy.set': {
      lenderId: LENDER,
      allowPartialPayments: 'false',
      allowPartPrepayment: 'false',
      linkValidityMinutes: '60',
    },
    'payments.mandate_policy.set': {
      lenderId: LENDER,
      requirement: 'optional',
      preDebitLeadHours: '48',
    },
    'payments.recon_settings.set': {
      lenderId: LENDER,
      settlementLagDays: '3',
      receiptLagHours: '72',
    },
    'payments.bank_credits.upload': {
      lenderId: LENDER,
      accountId: uid(4),
      csv: 'valueDate,amountMinor,utr\n2026-10-15,100,UTR-TEST-0001',
    },
    'payments.exception.acknowledge': { id: uid(70) },
    'payments.exception.assign': { id: uid(70), assignee: COLLEAGUE },
    'payments.exception.resolve': {
      id: uid(70),
      reasonCode: 'no_action_needed',
      evidence: 'doc:one',
    },
    'payments.exception.reopen': { id: uid(70), reasonCode: 'new_information' },
  };

  it.each(Object.keys(writes))(
    '%s is refused without the confirmation and sent with it',
    async (op) => {
      const fields = writes[op] ?? {};
      const refused = recorder({ outcome: 'set', status: 'resolved', inserted: 1, duplicates: 0 });
      expect(await lpRunOperation(refused.api, form({ op, key: KEY, ...fields }))).toEqual({
        ok: false,
        code: 'confirmation_required',
      });
      expect(
        await lpRunOperation(refused.api, form({ op, key: KEY, ...fields, confirm: 'yes' })),
      ).toEqual({ ok: false, code: 'confirmation_required' });
      expect(refused.calls).toHaveLength(0);

      const sent = recorder({ outcome: 'set', status: 'resolved', inserted: 1, duplicates: 0 });
      const outcome = await lpRunOperation(
        sent.api,
        form({ op, key: KEY, ...fields, confirm: 'on' }),
      );
      expect(outcome.ok).toBe(true);
      expect(sent.calls).toHaveLength(1);
      expect(sent.calls[0]?.key).toBe(KEY);
      expect(sent.calls[0]?.path.startsWith('/v1/lender/')).toBe(true);
    },
  );
});

describe('operations: policies and settings', () => {
  const base = {
    op: 'payments.policy.set',
    key: KEY,
    lenderId: LENDER,
    linkValidityMinutes: '1440',
    confirm: 'on',
  };

  it('turns typed rupees into paise and sends a minimum only where the option is on', async () => {
    const { api, calls } = recorder();
    const outcome = await lpRunOperation(
      api,
      form({
        ...base,
        allowPartialPayments: 'true',
        minPartialAmount: '500.50',
        allowPartPrepayment: 'false',
        minPartPrepayment: '9999',
      }),
    );
    expect(outcome).toEqual({ ok: true });
    expect(calls[0]).toMatchObject({
      path: '/v1/lender/payment-policy',
      body: {
        lenderId: LENDER,
        allowPartialPayments: true,
        minPartialAmountMinor: 50050,
        allowPartPrepayment: false,
        minPartPrepaymentMinor: null,
        linkValidityMinutes: 1440,
      },
    });
  });

  it('asks again for an amount it cannot read exactly, and for a missing yes or no', async () => {
    const { api, calls } = recorder();
    expect(
      await lpRunOperation(
        api,
        form({
          ...base,
          allowPartialPayments: 'true',
          minPartialAmount: '5,00',
          allowPartPrepayment: 'false',
        }),
      ),
    ).toEqual({ ok: false, code: 'amount_invalid' });
    expect(await lpRunOperation(api, form({ ...base, allowPartPrepayment: 'false' }))).toEqual({
      ok: false,
      code: 'validation_failed',
    });
    expect(calls).toHaveLength(0);
  });

  it('leaves the allowed range to the server', async () => {
    const { api, calls } = recorder();
    await lpRunOperation(
      api,
      form({
        ...base,
        allowPartialPayments: 'true',
        minPartialAmount: '0',
        allowPartPrepayment: 'false',
        linkValidityMinutes: '99999',
      }),
    );
    expect(calls[0]?.body).toMatchObject({ minPartialAmountMinor: 0, linkValidityMinutes: 99999 });
  });

  it('sends the mandate policy with an empty ceiling as null', async () => {
    const { api, calls } = recorder();
    await lpRunOperation(
      api,
      form({
        op: 'payments.mandate_policy.set',
        key: KEY,
        lenderId: LENDER,
        requirement: 'before_first_due',
        maxAmountCap: '',
        preDebitLeadHours: '48',
        confirm: 'on',
      }),
    );
    expect(calls[0]).toMatchObject({
      path: '/v1/lender/mandate-policy',
      body: {
        lenderId: LENDER,
        requirement: 'before_first_due',
        maxAmountCapMinor: null,
        preDebitLeadHours: 48,
      },
    });
  });

  it('refuses a mandate requirement that is not on the list', async () => {
    const { api, calls } = recorder();
    const outcome = await lpRunOperation(
      api,
      form({
        op: 'payments.mandate_policy.set',
        key: KEY,
        lenderId: LENDER,
        requirement: 'mandatory_now',
        preDebitLeadHours: '48',
        confirm: 'on',
      }),
    );
    expect(outcome).toEqual({ ok: false, code: 'validation_failed' });
    expect(calls).toHaveLength(0);
  });

  it('sends the waiting times as whole numbers', async () => {
    const { api, calls } = recorder();
    await lpRunOperation(
      api,
      form({
        op: 'payments.recon_settings.set',
        key: KEY,
        lenderId: LENDER,
        settlementLagDays: '4',
        receiptLagHours: '96',
        confirm: 'on',
      }),
    );
    expect(calls[0]).toMatchObject({
      path: '/v1/lender/reconciliation/settings',
      body: { lenderId: LENDER, settlementLagDays: 4, receiptLagHours: 96 },
    });
    expect(
      await lpRunOperation(
        api,
        form({
          op: 'payments.recon_settings.set',
          key: KEY,
          lenderId: LENDER,
          settlementLagDays: '4.5',
          receiptLagHours: '96',
          confirm: 'on',
        }),
      ),
    ).toEqual({ ok: false, code: 'validation_failed' });
  });
});

describe('operations: the bank statement', () => {
  const upload = (extra: Record<string, string | File>) =>
    form({
      op: 'payments.bank_credits.upload',
      key: KEY,
      lenderId: LENDER,
      accountId: uid(4),
      confirm: 'on',
      ...extra,
    });

  it('accepts exactly the three columns in any order, with a byte-order mark and CRLF', () => {
    expect(lpCheckStatementHeader('valueDate,amountMinor,utr\n').ok).toBe(true);
    expect(lpCheckStatementHeader('utr,valueDate,amountMinor\r\n2026-10-15,1,UTR').ok).toBe(true);
    expect(lpCheckStatementHeader('﻿valueDate,amountMinor,utr').ok).toBe(true);
  });

  it.each([
    ['an extra column', 'valueDate,amountMinor,utr,narration\n'],
    ['a missing column', 'valueDate,amountMinor\n'],
    ['a repeated column', 'valueDate,valueDate,utr\n'],
    ['another spelling', 'valuedate,amountminor,utr\n'],
    ['a quoted column', '"valueDate",amountMinor,utr\n'],
    ['no header at all', '2026-10-15,100,UTR0001\n'],
    ['an empty text', ''],
  ])('refuses %s before anything is sent', async (_name, csv) => {
    expect(lpCheckStatementHeader(csv).ok).toBe(false);
    const { api, calls } = recorder();
    const outcome = await lpRunOperation(api, upload({ csv: csv === '' ? ' ' : csv }));
    expect(outcome.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('sends pasted text exactly as typed and reports the counts the server returned', async () => {
    const { api, calls } = recorder({ inserted: 2, duplicates: 1 });
    const csv = 'amountMinor,utr,valueDate\r\n150050,UTR-TEST-0001,2026-10-15\r\n';
    const outcome = await lpRunOperation(api, upload({ csv }));
    expect(outcome).toEqual({ ok: true, counts: { inserted: 2, duplicates: 1 } });
    expect(calls[0]).toMatchObject({
      path: '/v1/lender/reconciliation/bank-credits',
      body: { lenderId: LENDER, accountId: uid(4), csv },
    });
  });

  it('reads an uploaded file and refuses a file together with pasted text', async () => {
    const { api, calls } = recorder({ inserted: 1, duplicates: 0 });
    const content = 'valueDate,amountMinor,utr\n2026-10-15,100,UTR-TEST-0001\n';
    const file = new File([content], 'statement.csv', { type: 'text/csv' });
    // The test browser lacks Blob.text(); the server (Node) has it. Give the file the same method.
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(content) });
    expect((await lpRunOperation(api, upload({ file }))).ok).toBe(true);
    expect((calls[0]?.body as { csv: string }).csv).toBe(content);
    expect(await lpRunOperation(api, upload({ file, csv: content }))).toEqual({
      ok: false,
      code: 'csv_both',
    });
    expect(await lpRunOperation(api, upload({}))).toEqual({ ok: false, code: 'csv_missing' });
    expect(calls).toHaveLength(1);
  });

  it('refuses a statement longer than one upload may hold', async () => {
    const { api, calls } = recorder();
    const csv = `valueDate,amountMinor,utr\n${'2026-10-15,100,UTR-TEST-0001\n'.repeat(9000)}`;
    expect(await lpRunOperation(api, upload({ csv }))).toEqual({
      ok: false,
      code: 'csv_too_large',
    });
    expect(calls).toHaveLength(0);
  });

  it('needs an account of the lender and a lender', async () => {
    const { api, calls } = recorder();
    const csv = 'valueDate,amountMinor,utr\n2026-10-15,100,UTR-TEST-0001';
    expect(await lpRunOperation(api, upload({ csv, accountId: 'not-an-id' }))).toEqual({
      ok: false,
      code: 'validation_failed',
    });
    expect(calls).toHaveLength(0);
  });
});

describe('operations: exceptions', () => {
  const id = uid(70);
  const run = (api: OnboardingApi, op: string, fields: Record<string, string>) =>
    lpRunOperation(api, form({ op, key: KEY, id, confirm: 'on', ...fields }));

  it('acknowledges and assigns on the exception’s own path', async () => {
    const { api, calls } = recorder({ status: 'assigned' });
    await run(api, 'payments.exception.acknowledge', {});
    await run(api, 'payments.exception.assign', { assignee: COLLEAGUE });
    expect(calls.map((c) => [c.path, c.body])).toEqual([
      [`/v1/lender/reconciliation/exceptions/${id}/acknowledge`, {}],
      [`/v1/lender/reconciliation/exceptions/${id}/assign`, { assignee: COLLEAGUE }],
    ]);
    expect(await run(api, 'payments.exception.assign', { assignee: 'someone' })).toEqual({
      ok: false,
      code: 'validation_failed',
    });
  });

  it('resolves with a reason from the closed list and 1 to 10 evidence references', async () => {
    const { api, calls } = recorder({ status: 'resolved' });
    const outcome = await run(api, 'payments.exception.resolve', {
      reasonCode: 'verified_with_provider',
      evidence: 'ticket:one doc/two,\n#three',
      note: ' checked ',
    });
    expect(outcome).toEqual({ ok: true });
    expect(calls[0]).toMatchObject({
      path: `/v1/lender/reconciliation/exceptions/${id}/resolve`,
      body: {
        reasonCode: 'verified_with_provider',
        evidence: ['ticket:one', 'doc/two', '#three'],
        note: 'checked',
      },
    });
    await run(api, 'payments.exception.resolve', {
      reasonCode: 'no_action_needed',
      evidence: 'ref-1',
    });
    expect(calls[1]?.body).toEqual({ reasonCode: 'no_action_needed', evidence: ['ref-1'] });
  });

  it.each([
    [
      'a reason that is not on the list',
      { reasonCode: 'because_i_said_so', evidence: 'ref-1' },
      'reason_required',
    ],
    [
      'a reason from the reopen list only',
      { reasonCode: 'made_up', evidence: 'ref-1' },
      'reason_required',
    ],
    ['no evidence', { reasonCode: 'no_action_needed', evidence: ' ' }, 'evidence_required'],
    [
      'evidence with a forbidden character',
      { reasonCode: 'no_action_needed', evidence: 'a;b' },
      'evidence_required',
    ],
    [
      'eleven references',
      { reasonCode: 'no_action_needed', evidence: 'a b c d e f g h i j k' },
      'evidence_required',
    ],
    [
      'a note over 500 characters',
      { reasonCode: 'no_action_needed', evidence: 'ref', note: 'x'.repeat(501) },
      'reason_invalid',
    ],
  ])('refuses %s without calling the API', async (_name, fields, code) => {
    const { api, calls } = recorder();
    expect(await run(api, 'payments.exception.resolve', fields)).toEqual({ ok: false, code });
    expect(calls).toHaveLength(0);
  });

  it('reopens only with a reason from the reopen list', async () => {
    const { api, calls } = recorder({ status: 'reopened' });
    expect(await run(api, 'payments.exception.reopen', { reasonCode: 'no_action_needed' })).toEqual(
      {
        ok: false,
        code: 'reason_required',
      },
    );
    expect(calls).toHaveLength(0);
    for (const reason of LP_REOPEN_REASONS) {
      expect((await run(api, 'payments.exception.reopen', { reasonCode: reason })).ok).toBe(true);
    }
    expect(calls).toHaveLength(LP_REOPEN_REASONS.length);
    expect(calls[0]?.path).toBe(`/v1/lender/reconciliation/exceptions/${id}/reopen`);
  });

  it('splits evidence on spaces, commas and new lines', () => {
    expect(lpSplitEvidence('a, b\n\nc  d')).toEqual(['a', 'b', 'c', 'd']);
    expect(lpSplitEvidence('   ')).toEqual([]);
  });
});

describe('where a form may return to', () => {
  it.each([
    '/payments',
    '/payments/events',
    '/payments/policy',
    `/payments/${PAY}`,
    '/mandates',
    '/mandates/debits',
    '/mandates/policy',
    `/mandates/${uid(40)}`,
    '/reconciliation',
    '/reconciliation/settings',
    '/reconciliation/bank-credits',
    '/reconciliation/settlements',
    `/reconciliation/settlements/${uid(60)}`,
    '/reconciliation/exceptions',
    `/reconciliation/exceptions/${uid(70)}`,
    '/reconciliation/runs/2026-10-16',
  ])('allows %s', (path) => {
    expect(lpSafeReturnPath(path)).toBe(path);
  });

  it.each([
    '//evil.example/payments',
    'https://evil.example/payments',
    '/payments/../loans',
    '/payments?next=//evil.example',
    '/payments/not-an-id',
    '/loans',
    '/applications',
    'payments',
    '',
    null,
    42,
  ])('sends %j to the payments page instead', (value) => {
    expect(lpSafeReturnPath(value)).toBe('/payments');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------------------------------------------
describe('payments list', () => {
  const page = (items: PaymentRow[], nextCursor: string | null = null) => ok({ items, nextCursor });

  it('says it is loading while there is no answer', () => {
    render(<LpPaymentsListView page={undefined} filters={{}} keep={{}} />);
    expect(screen.getByRole('status').textContent).toContain('Loading payments');
  });

  it('explains a refused or failed load without echoing a code or the server’s text', () => {
    const { container, rerender } = render(
      <LpPaymentsListView page={bad(403, 'forbidden')} filters={{}} keep={{}} />,
    );
    expect(text(container)).toContain('You cannot view payments');
    expect(text(container)).toContain('Your role does not include this.');
    rerender(<LpPaymentsListView page={bad(500, 'zz_internal_failure')} filters={{}} keep={{}} />);
    expect(text(container)).toContain('Could not load payments');
    expect(text(container)).not.toContain('zz_internal_failure');
    expect(text(container)).not.toContain('No payments to show');
  });

  it('says so when nothing matches', () => {
    render(<LpPaymentsListView page={page([])} filters={{}} keep={{}} />);
    expect(screen.getByText('No payments to show')).toBeTruthy();
  });

  it('writes the amount as rupees and the status in words that do not say paid', () => {
    const { container } = render(
      <LpPaymentsListView
        page={page([payment(), payment({ id: uid(21), status: 'pending', amountMinor: 250000 })])}
        filters={{}}
        keep={{}}
      />,
    );
    const body = text(container);
    expect(body).toContain('₹1,23,456.78');
    expect(body).toContain('₹2,500.00');
    expect(body).toContain('Received by the payment provider');
    expect(body).toContain('Sent to the provider (no verified payment yet)');
    expect(body).toContain('16 Oct 2026, 14:05 IST');
    expect(body).toContain('Sandbox (test only)');
    expect(body).not.toMatch(/\b(paid|successful)\b/i);
    expect(screen.getAllByRole('link', { name: 'Open' })[0]?.getAttribute('href')).toBe(
      `/payments/${PAY}`,
    );
  });

  it('filters with a plain GET form and pages with an encoded cursor', () => {
    const { container } = render(
      <LpPaymentsListView
        page={page([payment()], 'cursor with space+plus')}
        filters={{ status: 'succeeded' }}
        keep={{ status: 'succeeded' }}
      />,
    );
    const filter = container.querySelector('form[method="get"]');
    expect(filter?.getAttribute('action')).toBe('/payments');
    const more = screen.getByRole('link', { name: 'Show older entries' });
    expect(more.getAttribute('href')).toBe(
      '/payments?status=succeeded&cursor=cursor+with+space%2Bplus',
    );
  });

  it('does not echo a status or purpose it does not know', () => {
    const { container } = render(
      <LpPaymentsListView
        page={page([
          payment({ status: 'zz_new_status' as never, purpose: 'zz_new_purpose' as never }),
        ])}
        filters={{}}
        keep={{}}
      />,
    );
    expect(text(container)).not.toContain('zz_new_status');
    expect(text(container)).not.toContain('zz_new_purpose');
    expect(text(container)).toContain(labels.LP_UNRECOGNISED);
  });
});

describe('payment detail: four separate stages', () => {
  const show = (d: PaymentDetail, events: ProviderEventPage['items'] = []) =>
    render(<LpPaymentDetailView detail={ok(d)} events={ok({ items: events, nextCursor: null })} />);

  const row = (container: HTMLElement, stageName: string) => {
    const header = within(container).getByRole('rowheader', { name: stageName });
    return header.closest('tr') as HTMLElement;
  };

  it('shows each stage as its own fact with its source, from the API’s booleans only', () => {
    const { container } = show(detail());
    expect(text(row(container, 'Provider captured'))).toContain('Recorded');
    expect(text(row(container, 'Provider captured'))).toContain('verified event');
    expect(text(row(container, 'Provider settled'))).toContain('No record yet');
    expect(text(row(container, 'Bank confirmed'))).toContain('No record yet');
    expect(text(row(container, 'Lender posted'))).toContain('No record yet');
    expect(text(row(container, 'Lender posted'))).toContain('receipt from your own loan system');
  });

  it('never shows bank confirmed or lender posted unless the API says so', () => {
    const { container, unmount } = show(
      detail({
        stage: stage({
          stage: 'provider_settled',
          providerSettled: true,
          settlementDestinationOk: true,
        }),
      }),
    );
    expect(text(row(container, 'Provider settled'))).toContain('Recorded');
    expect(text(row(container, 'Bank confirmed'))).not.toContain('Recorded');
    expect(text(row(container, 'Lender posted'))).not.toContain('Recorded');
    expect(text(container)).toContain('Furthest stage the API records: Provider settled');
    unmount();

    const all = show(
      detail({
        stage: stage({
          stage: 'lender_posted',
          providerSettled: true,
          bankConfirmed: true,
          lenderPosted: true,
          settlementDestinationOk: true,
        }),
      }),
    );
    for (const name of [
      'Provider captured',
      'Provider settled',
      'Bank confirmed',
      'Lender posted',
    ]) {
      expect(text(row(all.container, name))).toContain('Recorded');
      expect(text(row(all.container, name))).not.toContain('No record yet');
    }
  });

  it('raises a critical banner when the provider settled somewhere else', () => {
    show(detail({ stage: stage({ settlementDestinationOk: false }) }));
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Critical');
    expect(alert.textContent).toContain('other than your verified settlement account');
  });

  it('says when no destination was reported and shows no banner', () => {
    const { container } = show(detail({ stage: stage({ settlementDestinationOk: null }) }));
    expect(text(container)).toContain('has not reported a settlement destination');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows no stages for a payment that is not a first, successful capture', () => {
    const { container } = show(detail({ stage: null, duplicateCapture: true, status: 'paid' }));
    expect(text(container)).toContain('No stages are recorded');
    expect(text(container)).toContain('a second capture on the same order');
    expect(text(container)).toContain('The provider calls it "paid"');
  });

  it('lists refunds and corrections as separate entries', () => {
    const { container } = show(
      detail({}, [
        {
          id: uid(22),
          providerPaymentId: uid(20),
          kind: 'refund',
          objectRef: 'refund-ref-1',
          amountMinor: 50000,
          occurredAt: STAMP,
          createdAt: STAMP,
        },
      ]),
    );
    expect(text(container)).toContain('Refund');
    expect(text(container)).toContain('₹500.00');
    expect(text(container)).toContain('never change the payment amount');
  });

  it('shows the processing outcome of each event, or that none exists yet', () => {
    const { container } = show(detail(), [
      event(),
      event({ id: uid(31), processing: null, processingClass: 'ignored' }),
      event({
        id: uid(32),
        processing: {
          outcome: 'deferred',
          reasonClass: 'capture_not_seen_yet',
          attempt: 2,
          deferredUntil: '2026-10-17T08:35:00+00:00',
          processedAt: STAMP,
        },
      }),
    ]);
    const body = text(container);
    expect(body).toContain('Applied (payment request marked as received by the provider)');
    expect(body).toContain('Not processed yet');
    expect(body).toContain('Deferred: waiting for a related event, will be retried');
    expect(body).toContain('attempt 2');
    expect(body).toContain('retry after 17 Oct 2026, 14:05 IST');
    expect(body).toContain('Recorded only, changes nothing');
  });

  it('answers a missing payment and a failed event load plainly', () => {
    const { container } = render(
      <LpPaymentDetailView detail={bad(404, 'not_found')} events={bad(500, 'zz')} />,
    );
    expect(text(container)).toContain('not found');
    expect(text(container)).toContain('Could not load the provider events');
    expect(text(container)).not.toContain('zz');
  });
});

describe('provider events and delivery counts', () => {
  it('writes each delivery outcome in words and never the body', () => {
    const { container } = render(
      <LpProviderEventsView
        summary={ok({
          lenderId: LENDER,
          items: [
            { outcome: 'verified', receipts: 1234, lastReceivedAt: STAMP },
            { outcome: 'unverified', receipts: 3, lastReceivedAt: null },
          ],
        })}
        events={ok({ items: [event()], nextCursor: null })}
        filters={{}}
        keep={{}}
      />,
    );
    const body = text(container);
    expect(body).toContain('1,234');
    expect(body).toContain('Could not be verified (no effect on any payment)');
    expect(body).toContain('Bodies, signatures and addresses are never stored or shown');
    expect(body).toContain('payment.captured');
  });

  it('says so when no delivery or event exists', () => {
    const { container } = render(
      <LpProviderEventsView
        summary={ok({ lenderId: LENDER, items: [] })}
        events={ok({ items: [], nextCursor: null })}
        filters={{}}
        keep={{}}
      />,
    );
    expect(text(container)).toContain('No delivery has been recorded');
    expect(text(container)).toContain('No verified events');
  });
});

describe('payment policy', () => {
  const policy = ok({
    items: [
      {
        lenderId: LENDER,
        allowPartialPayments: true,
        minPartialAmountMinor: 50000,
        allowPartPrepayment: false,
        minPartPrepaymentMinor: null,
        linkValidityMinutes: 1440,
        updatedAt: STAMP,
      },
    ],
  });

  it('shows no form to a role that cannot configure', () => {
    const { container } = render(
      <LpPaymentPolicyView policy={policy} ctx={ctx(['payment.read'])} />,
    );
    expect(container.querySelector('form')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save payment policy' })).toBeNull();
    expect(text(container)).toContain('your role does not include changing it');
    expect(text(container)).toContain('Accepted, from ₹500.00');
  });

  it('shows the form to a role that can, naming the operation and what it changes', () => {
    const { container } = render(
      <LpPaymentPolicyView policy={policy} ctx={ctx(['payment.read', 'payment.configure'])} />,
    );
    expect(screen.getByRole('button', { name: 'Save payment policy' })).toBeTruthy();
    expect(container.querySelector('input[name="op"][value="payments.policy.set"]')).toBeTruthy();
    expect(container.querySelector(`input[name="lenderId"][value="${LENDER}"]`)).toBeTruthy();
    expect(text(container)).toContain('What this changes');
    expect(text(container)).toContain('does not change any loan figure');
    expect(
      (container.querySelector('input[name="minPartialAmount"]') as HTMLInputElement).value,
    ).toBe('500.00');
  });

  it('has no pre-ticked box and no pre-chosen yes or no when no policy exists', () => {
    const { container } = render(
      <LpPaymentPolicyView policy={ok({ items: [] })} ctx={ctx(['payment.configure'])} />,
    );
    expect(text(container)).toContain('No policy has been set');
    const confirm = container.querySelector('input[name="confirm"]') as HTMLInputElement;
    expect(confirm.type).toBe('checkbox');
    expect(confirm.checked).toBe(false);
    expect(confirm.required).toBe(true);
    const choice = container.querySelector(
      'select[name="allowPartialPayments"]',
    ) as HTMLSelectElement;
    expect(choice.value).toBe('');
    expect(choice.required).toBe(true);
  });

  it('shows the outcome of the last save and never a raw code', () => {
    const { container, rerender } = render(<LpNotice done />);
    expect(text(container)).toContain('Done.');
    rerender(<LpNotice error="policy_invalid" />);
    expect(screen.getByRole('alert').textContent).toContain('did not accept this policy');
    rerender(<LpNotice error="zz_secret_code" />);
    expect(text(container)).not.toContain('zz_secret_code');
    rerender(<LpNotice done inserted={5} duplicates={2} />);
    expect(text(container)).toContain(
      '5 bank credit(s) were recorded and 2 were already on record',
    );
  });
});

describe('mandates', () => {
  it('writes the status only as the provider confirmed it and labels test modes', () => {
    const { container } = render(
      <LpMandatesListView
        page={ok({
          items: [
            mandateRow(),
            mandateRow({
              id: uid(41),
              status: 'active',
              providerMode: 'mock',
              cancelRequestedAt: STAMP,
            }),
          ],
          nextCursor: null,
        })}
        filters={{}}
        keep={{}}
      />,
    );
    const body = text(container);
    expect(body).toContain('Waiting for the borrower’s bank');
    expect(body).toContain('Active, as confirmed by the provider');
    expect(body).toContain('MOCK (test only, not a real provider)');
    expect(body).toContain('cancellation requested');
    expect(body).toContain('₹50,000.00');
    expect(body).toContain('1 Nov 2026');
  });

  it('is not active when the provider has not said so', () => {
    const { container } = render(<LpMandateDetailView detail={ok(mandateDetail())} />);
    expect(text(container)).not.toMatch(/\bActive\b/);
    expect(text(container)).toContain(
      'masked, as the borrower typed it; Udofin has not verified it',
    );
  });

  it('calls a cancellation a request until the provider confirms', () => {
    const { container } = render(
      <LpMandateDetailView
        detail={ok(
          mandateDetail({
            mandate: mandateRow({
              status: 'active',
              cancelRequestedAt: STAMP,
              cancelReason: 'loan_closed',
              cancelSentAt: null,
            }),
          }),
        )}
      />,
    );
    const body = text(container);
    expect(body).toContain('Cancellation requested');
    expect(body).toContain('the loan was closed');
    expect(body).toContain('It has not been sent to the provider yet');
    expect(body).toContain(
      'This is a request: the status above changes only when the provider confirms',
    );
  });

  it('says that a bank prompt may appear on every debit only when the flag says so', () => {
    const { container, rerender } = render(
      <LpMandateDetailView
        detail={ok(mandateDetail({ mandate: mandateRow({ needsAfaEachDebit: true }) }))}
      />,
    );
    expect(text(container)).toContain('may ask for authentication on every debit');
    rerender(<LpMandateDetailView detail={ok(mandateDetail())} />);
    expect(text(container)).not.toContain('every debit');
  });

  it('flags a late pre-debit notice in words and shows each notice beside its debit', () => {
    const { container } = render(
      <LpMandateDetailView
        detail={ok(
          mandateDetail({
            debits: [debit()],
            notices: [
              {
                id: uid(55),
                debitId: uid(50),
                noticeDueAt: STAMP,
                status: 'late',
                deliveryState: null,
                sentAt: null,
              },
            ],
          }),
        )}
      />,
    );
    expect(screen.getByRole('alert').textContent).toContain('Late pre-debit notice');
    expect(text(container)).toContain('LATE');
  });

  it('shows a returned debit with the provider’s own code and class, and says when it is unclassified', () => {
    const { container } = render(
      <LpMandateDebitsView
        page={ok({
          items: [
            debit({
              status: 'returned',
              returnCode: 'R-TEST-51',
              returnClass: 'insufficient_funds',
              providerDebitRef: 'debit-ref-1',
            }),
            debit({
              id: uid(51),
              status: 'returned',
              returnCode: 'R-TEST-99',
              returnClass: null,
              planned: false,
              exceedsMandateMax: true,
            }),
            debit({ id: uid(52), amountMinor: null }),
          ],
          nextCursor: null,
        })}
        filters={{}}
        keep={{}}
      />,
    );
    const body = text(container);
    expect(body).toContain('Provider code R-TEST-51; class: Insufficient funds');
    expect(body).toContain('Provider code R-TEST-99; class: not classified yet');
    expect(body).toContain('(above the mandate maximum)');
    expect(body).toContain('Reported by the provider, not planned');
    expect(body).toContain('Planned from your reported schedule');
    // A debit with no reported amount is not shown as zero.
    expect(body).toContain('Not reported');
    expect(body).toContain('Returned');
  });

  it('answers empty and failed loads', () => {
    const { container, rerender } = render(
      <LpMandateDebitsView page={ok({ items: [], nextCursor: null })} filters={{}} keep={{}} />,
    );
    expect(text(container)).toContain('No debits to show');
    rerender(<LpMandateDebitsView page={bad(403, 'forbidden')} filters={{}} keep={{}} />);
    expect(text(container)).toContain('You cannot view the debits');
    rerender(<LpMandateDebitsView page={undefined} filters={{}} keep={{}} />);
    expect(screen.getByRole('status')).toBeTruthy();
  });

  it('shows the mandate policy form only to a role that can configure', () => {
    const policy = ok({
      items: [
        {
          lenderId: LENDER,
          requirement: 'before_first_due' as const,
          maxAmountCapMinor: null,
          preDebitLeadHours: 48,
          updatedAt: STAMP,
        },
      ],
    });
    const readOnly = render(<LpMandatePolicyView policy={policy} ctx={ctx(['payment.read'])} />);
    expect(readOnly.container.querySelector('form')).toBeNull();
    expect(text(readOnly.container)).toContain('None set by you');
    expect(text(readOnly.container)).toContain('48 hours before the debit');
    readOnly.unmount();

    const editor = render(<LpMandatePolicyView policy={policy} ctx={ctx(['payment.configure'])} />);
    expect(
      editor.container.querySelector('input[name="op"][value="payments.mandate_policy.set"]'),
    ).toBeTruthy();
    expect(text(editor.container)).toContain('never edits an existing mandate');
  });
});

describe('reconciliation', () => {
  it('lists runs and writes a count the report lacks as not available, never zero', () => {
    const { container } = render(
      <LpReconciliationRunsView
        page={ok({
          items: [
            {
              id: uid(80),
              lenderId: LENDER,
              runDate: '2026-10-16',
              runNo: 1,
              counts: {
                paymentsConsidered: 10,
                matchedToSettlement: null,
                matchedToBank: 0,
                matchedToReceipt: null,
              },
              createdAt: STAMP,
            },
          ],
          nextCursor: null,
        })}
        keep={{}}
      />,
    );
    const cells = Array.from(container.querySelectorAll('tbody td')).map((td) => td.textContent);
    expect(cells).toContain('10');
    expect(cells.filter((c) => c === 'Not available')).toHaveLength(2);
    expect(cells).toContain('0');
    expect(screen.getByRole('link', { name: 'Open report' }).getAttribute('href')).toBe(
      '/reconciliation/runs/2026-10-16',
    );
  });

  it('answers an empty list of runs', () => {
    render(<LpReconciliationRunsView page={ok({ items: [], nextCursor: null })} keep={{}} />);
    expect(screen.getByText('No reconciliation run yet')).toBeTruthy();
  });

  it('lists the inputs a run could not check, plainly', () => {
    const { container } = render(
      <LpReconciliationReportView
        summary={ok(
          summary({ notReconcilable: ['settlement_reports', 'bank_credits', 'lms_receipts'] }),
        )}
        date="2026-10-16"
      />,
    );
    const body = text(container);
    expect(body).toContain('No provider settlement report was available');
    expect(body).toContain('No bank credits had been uploaded');
    expect(body).toContain('No receipt feed from your loan system was available');
    expect(body).toContain('Inputs this run could not check');
  });

  it('says a run had every input when none is missing', () => {
    const { container } = render(
      <LpReconciliationReportView summary={ok(summary())} date="2026-10-16" />,
    );
    expect(text(container)).toContain('This run had every input it looks for');
    expect(text(container)).toContain('Matched to a provider settlement');
    expect(text(container)).toContain('3 days');
    expect(text(container)).toContain('72 hours');
    expect(text(container)).toContain('unverified defaults');
  });

  it('shows the standing line with zero items as good news without a banner', () => {
    const { container } = render(
      <LpReconciliationReportView summary={ok(summary())} date="2026-10-16" />,
    );
    expect(text(container)).toContain('Settled to a non-lender account: 0 items, ₹0.00');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does not let a zero stand as evidence when the settlement report was missing', () => {
    const { container } = render(
      <LpReconciliationReportView
        summary={ok(summary({ notReconcilable: ['settlement_reports'] }))}
        date="2026-10-16"
      />,
    );
    expect(text(container)).toContain('Zero here is not evidence');
  });

  it('raises a critical banner when anything settled to a non-lender account', () => {
    render(
      <LpReconciliationReportView
        summary={ok(summary({ settledToNonLender: { items: 2, minor: 345600 } }))}
        date="2026-10-16"
      />,
    );
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Critical');
    expect(alert.textContent).toContain('2 item(s), ₹3,456.00');
    expect(
      within(alert).getByRole('link', { name: 'Critical exceptions' }).getAttribute('href'),
    ).toBe('/reconciliation/exceptions?severity=critical');
  });

  it('raises the banner for money without items and for items without money', () => {
    const { unmount } = render(
      <LpReconciliationReportView
        summary={ok(summary({ settledToNonLender: { items: 0, minor: 1 } }))}
        date="2026-10-16"
      />,
    );
    expect(screen.getByRole('alert')).toBeTruthy();
    unmount();
    render(
      <LpReconciliationReportView
        summary={ok(summary({ settledToNonLender: { items: 1, minor: 0 } }))}
        date="2026-10-16"
      />,
    );
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('writes a withheld standing line as not available, not as zero', () => {
    const { container } = render(
      <LpReconciliationReportView
        summary={ok(summary({ settledToNonLender: { items: null, minor: null } }))}
        date="2026-10-16"
      />,
    );
    expect(text(container)).toContain('not available');
    expect(text(container)).not.toContain('0 items');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('writes withheld counts and waiting times as not available', () => {
    const { container } = render(
      <LpReconciliationReportView
        summary={ok(
          summary({
            paymentsConsidered: null,
            matched: { settlement: null, bank: null, receipt: null },
            settings: { settlementLagDays: null, receiptLagHours: null },
          }),
        )}
        date="2026-10-16"
      />,
    );
    expect(text(container).match(/Not available/g)?.length).toBeGreaterThanOrEqual(6);
  });

  it('answers a date with no run', () => {
    const { container } = render(
      <LpReconciliationReportView summary={bad(404, 'not_found')} date="2026-10-16" />,
    );
    expect(text(container)).toContain('not found');
  });

  it('marks a settlement reported to another account and a report that does not add up', () => {
    const { container } = render(
      <LpSettlementBatchesView
        page={ok({
          items: [
            batch(),
            batch({
              id: uid(61),
              destinationOk: false,
              destinationMaskedRef: 'XXXXXX9999',
              partsMismatch: true,
            }),
            batch({ id: uid(62), destinationOk: null, destinationMaskedRef: null }),
          ],
          nextCursor: null,
        })}
        keep={{}}
      />,
    );
    const body = text(container);
    expect(screen.getByRole('alert').textContent).toContain('Critical');
    expect(body).toContain('Not your verified settlement account (XXXXXX9999)');
    expect(body).toContain('Your verified settlement account (XXXXXX4321)');
    expect(body).toContain('Destination not reported');
    expect(body).toContain('the provider’s figures do not add up');
    expect(body).toContain('₹9,764.00');
  });

  it('shows a batch’s figures exactly as reported, with its items', () => {
    const { container } = render(
      <LpSettlementBatchView
        id={uid(60)}
        batch={ok(batch({ partsMismatch: true }))}
        items={ok({
          items: [
            {
              id: uid(63),
              providerPaymentRef: 'pp-ref-1',
              orderRef: null,
              grossMinor: 500000,
              feeMinor: 10000,
              taxMinor: 1800,
              netMinor: 488200,
              partsMismatch: true,
            },
          ],
          nextCursor: 'next',
        })}
        keep={{}}
      />,
    );
    const body = text(container);
    expect(body).toContain('Gross, as reported');
    expect(body).toContain('₹10,000.00');
    expect(body).toContain('₹4,882.00');
    expect(body).toContain('The provider’s figures do not add up');
    expect(body).toContain('nothing was corrected');
    expect(screen.getByRole('link', { name: 'Show older entries' }).getAttribute('href')).toBe(
      `/reconciliation/settlements/${uid(60)}?cursor=next`,
    );
  });

  it('says so when no settlement has been reported', () => {
    render(<LpSettlementBatchesView page={ok({ items: [], nextCursor: null })} keep={{}} />);
    expect(screen.getByText('No settlement reported yet')).toBeTruthy();
  });
});

describe('bank-credit upload', () => {
  const accounts = ok({
    items: [
      {
        settlementAccountId: uid(4),
        lenderId: LENDER,
        maskedRef: 'XXXXXX4321',
        verificationStatus: 'verified' as const,
        effectiveFrom: '2026-01-01',
        effectiveTo: null,
        usable: true,
      },
      {
        settlementAccountId: uid(5),
        lenderId: LENDER,
        maskedRef: 'XXXXXX8765',
        verificationStatus: 'unverified' as const,
        effectiveFrom: '2026-01-01',
        effectiveTo: null,
        usable: false,
      },
    ],
  });
  const returnCtx = (permissions: string[]) =>
    ctx(permissions, { returnTo: '/reconciliation/bank-credits' });

  it('explains the three columns and that any other column refuses the whole file', () => {
    const { container } = render(
      <LpBankCreditUploadView accounts={accounts} ctx={returnCtx(['payment.reconcile'])} />,
    );
    const body = text(container);
    expect(container.querySelector('code')?.textContent).toBe('valueDate,amountMinor,utr');
    expect(body).toContain('Any other column');
    expect(body).toContain('refuse the whole file and store nothing');
    expect(body).toContain('the server checks every line and decides');
    expect(body).toContain('2,000 lines');
  });

  it('offers the lender’s own accounts by masked reference and status only', () => {
    const { container } = render(
      <LpBankCreditUploadView accounts={accounts} ctx={returnCtx(['payment.reconcile'])} />,
    );
    const select = container.querySelector('select[name="accountId"]') as HTMLSelectElement;
    const labelsText = Array.from(select.options).map((o) => o.textContent);
    expect(labelsText).toContain('XXXXXX4321 (verified)');
    expect(labelsText).toContain('XXXXXX8765 (not yet verified, not usable now)');
    expect(container.querySelector('input[type="file"]')).toBeTruthy();
    expect(
      container.querySelector('input[name="op"][value="payments.bank_credits.upload"]'),
    ).toBeTruthy();
    expect((container.querySelector('input[name="confirm"]') as HTMLInputElement).checked).toBe(
      false,
    );
  });

  it('shows no upload form to a role that cannot reconcile', () => {
    const { container } = render(
      <LpBankCreditUploadView accounts={undefined} ctx={returnCtx(['payment.read'])} />,
    );
    expect(container.querySelector('form')).toBeNull();
    expect(text(container)).toContain('your role does not include uploading bank credits');
  });

  it('says so when the lender has no settlement account on record', () => {
    const { container } = render(
      <LpBankCreditUploadView
        accounts={ok({ items: [] })}
        ctx={returnCtx(['payment.reconcile'])}
      />,
    );
    expect(text(container)).toContain('No settlement account on record');
    expect(container.querySelector('form')).toBeNull();
  });

  it('reports what the server recorded, and a whole-file refusal in words', () => {
    const { container, rerender } = render(
      <LpBankCreditUploadView
        accounts={accounts}
        ctx={returnCtx(['payment.reconcile'])}
        done
        inserted={4}
        duplicates={1}
      />,
    );
    expect(text(container)).toContain(
      '4 bank credit(s) were recorded and 1 were already on record',
    );
    rerender(
      <LpBankCreditUploadView
        accounts={accounts}
        ctx={returnCtx(['payment.reconcile'])}
        error="unexpected_field"
      />,
    );
    expect(screen.getByRole('alert').textContent).toContain('whole file was refused');
    expect(screen.getByRole('alert').textContent).toContain('Nothing was stored');
  });
});

describe('waiting times', () => {
  it('marks the platform defaults as unverified when the lender set none', () => {
    const { container } = render(
      <LpReconciliationSettingsView
        settings={ok({ items: [] })}
        ctx={ctx(['payment.read'], { returnTo: '/reconciliation/settings' })}
      />,
    );
    expect(text(container)).toContain('Unverified default');
    expect(text(container)).toContain('not set its own waiting times');
    expect(container.querySelector('form')).toBeNull();
  });

  it('shows the form to a role that can configure, with the current values', () => {
    const { container } = render(
      <LpReconciliationSettingsView
        settings={ok({
          items: [
            { lenderId: LENDER, settlementLagDays: 4, receiptLagHours: 96, updatedAt: STAMP },
          ],
        })}
        ctx={ctx(['payment.configure'], { returnTo: '/reconciliation/settings' })}
      />,
    );
    expect(
      (container.querySelector('input[name="settlementLagDays"]') as HTMLInputElement).value,
    ).toBe('4');
    expect(
      container.querySelector('input[name="op"][value="payments.recon_settings.set"]'),
    ).toBeTruthy();
    expect(text(container)).toContain('changes no payment');
  });
});

describe('exceptions', () => {
  const returnCtx = (permissions: string[]) =>
    ctx(permissions, { returnTo: `/reconciliation/exceptions/${uid(70)}` });
  const ops = (container: HTMLElement) =>
    Array.from(container.querySelectorAll('input[name="op"]')).map(
      (i) => (i as HTMLInputElement).value,
    );

  it('lists class, severity, owner and status in words, and marks platform-owned work', () => {
    const { container } = render(
      <LpExceptionsQueueView
        page={ok({
          items: [
            exceptionRow({
              severity: 'critical',
              class: 'settlement_account_mismatch',
              owner: 'platform',
            }),
            exceptionRow({ id: uid(72), assignedTo: ME, status: 'assigned' }),
            exceptionRow({ id: uid(73), assignedTo: COLLEAGUE, status: 'assigned' }),
          ],
          nextCursor: null,
        })}
        filters={{}}
        keep={{}}
        userId={ME}
      />,
    );
    const body = text(container);
    expect(body).toContain('Critical');
    expect(body).toContain('Handled by Udofin platform staff');
    expect(body).toContain('Your organisation');
    expect(body).toContain('An amount differs from the amount asked for');
    expect(body).toContain('You');
    expect(body).toContain('Another person (id ending 00000010)');
    expect(body).not.toContain('settlement_account_mismatch');
  });

  it('answers an empty queue and a refusal', () => {
    const { container, rerender } = render(
      <LpExceptionsQueueView page={ok({ items: [], nextCursor: null })} filters={{}} keep={{}} />,
    );
    expect(text(container)).toContain('No exceptions to show');
    rerender(<LpExceptionsQueueView page={bad(403, 'forbidden')} filters={{}} keep={{}} />);
    expect(text(container)).toContain('You cannot view the exceptions');
  });

  it('offers the right actions for each status to a role that may act', () => {
    const open = render(
      <LpExceptionDetailView
        detail={ok(exceptionDetail())}
        ctx={returnCtx(['payment.reconcile'])}
      />,
    );
    expect(ops(open.container).sort()).toEqual([
      'payments.exception.acknowledge',
      'payments.exception.assign',
      'payments.exception.assign',
      'payments.exception.resolve',
    ]);
    open.unmount();

    const assigned = render(
      <LpExceptionDetailView
        detail={ok(exceptionDetail({ status: 'assigned', assignedTo: ME }))}
        ctx={returnCtx(['payment.reconcile'])}
      />,
    );
    expect(ops(assigned.container)).not.toContain('payments.exception.acknowledge');
    expect(ops(assigned.container)).toContain('payments.exception.resolve');
    assigned.unmount();

    const resolved = render(
      <LpExceptionDetailView
        detail={ok(exceptionDetail({ status: 'resolved', resolvedAt: STAMP }))}
        ctx={returnCtx(['payment.reconcile'])}
      />,
    );
    expect(ops(resolved.container)).toEqual(['payments.exception.reopen']);
  });

  it('gives every action its own confirmation, unticked and required', () => {
    const { container } = render(
      <LpExceptionDetailView
        detail={ok(exceptionDetail())}
        ctx={returnCtx(['payment.reconcile'])}
      />,
    );
    const forms = Array.from(container.querySelectorAll('form'));
    expect(forms.length).toBe(4);
    for (const f of forms) {
      const box = f.querySelector('input[name="confirm"]') as HTMLInputElement;
      expect(box.type).toBe('checkbox');
      expect(box.checked).toBe(false);
      expect(box.required).toBe(true);
    }
  });

  it('offers exactly the closed reason lists', () => {
    const { container, unmount } = render(
      <LpExceptionDetailView
        detail={ok(exceptionDetail())}
        ctx={returnCtx(['payment.reconcile'])}
      />,
    );
    const resolve = container.querySelector('select[name="reasonCode"]') as HTMLSelectElement;
    expect(
      Array.from(resolve.options)
        .map((o) => o.value)
        .filter(Boolean),
    ).toEqual([...LP_RESOLVE_REASONS]);
    expect(text(container)).toContain('does not move money');
    unmount();
    const reopened = render(
      <LpExceptionDetailView
        detail={ok(exceptionDetail({ status: 'resolved', resolvedAt: STAMP }))}
        ctx={returnCtx(['payment.reconcile'])}
      />,
    );
    const reopen = reopened.container.querySelector(
      'select[name="reasonCode"]',
    ) as HTMLSelectElement;
    expect(
      Array.from(reopen.options)
        .map((o) => o.value)
        .filter(Boolean),
    ).toEqual([...LP_REOPEN_REASONS]);
  });

  it('shows a platform-owned exception as handled by platform staff and offers a lender user no action', () => {
    const { container } = render(
      <LpExceptionDetailView
        detail={ok(
          exceptionDetail({ owner: 'platform', class: 'merchant_mismatch', severity: 'critical' }),
        )}
        ctx={returnCtx(['payment.reconcile', 'payment.read'])}
      />,
    );
    expect(text(container)).toContain('handled by Udofin platform staff');
    expect(container.querySelector('form')).toBeNull();
    expect(screen.getByRole('alert').textContent).toContain('Critical');
  });

  it('offers a role without the reconciliation permission no action', () => {
    const { container } = render(
      <LpExceptionDetailView detail={ok(exceptionDetail())} ctx={returnCtx(['payment.read'])} />,
    );
    expect(container.querySelector('form')).toBeNull();
    expect(text(container)).toContain('your role does not include acting on it');
  });

  it('offers assigning to oneself only when the person is known', () => {
    const { container } = render(
      <LpExceptionDetailView
        detail={ok(exceptionDetail())}
        ctx={ctx(['payment.reconcile'], { userId: undefined })}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Assign to me' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Assign to a colleague' })).toBeTruthy();
    expect(container.querySelector('input[name="assignee"][type="hidden"]')).toBeNull();
  });

  it('links the subject to the pages that exist and shows notes as text, not markup', () => {
    const detailWithNote = exceptionDetail({
      subject: { intent_id: PAY, installment_seq: '4' },
    });
    detailWithNote.events.push({
      id: uid(72),
      action: 'resolved',
      actorKind: 'lender_user',
      actorUserId: ME,
      reasonCode: 'no_action_needed',
      evidence: ['ref-1', 'ref-2'],
      note: '<b>bold</b>',
      assignedTo: null,
      authorisedByPermission: 'payment.reconcile',
      occurredAt: STAMP,
    });
    const { container } = render(
      <LpExceptionDetailView detail={ok(detailWithNote)} ctx={returnCtx(['payment.read'])} />,
    );
    expect(container.querySelector(`a[href="/payments/${PAY}"]`)).toBeTruthy();
    expect(text(container)).toContain('Instalment number: 4');
    expect(container.querySelector('b')).toBeNull();
    expect(text(container)).toContain('<b>bold</b>');
    expect(text(container)).toContain('ref-1, ref-2');
    expect(text(container)).toContain('No action needed');
  });

  it('answers a missing exception', () => {
    const { container } = render(
      <LpExceptionDetailView detail={bad(404, 'not_found')} ctx={returnCtx(['payment.read'])} />,
    );
    expect(text(container)).toContain('not found');
  });
});

describe('no raw server text or code reaches the screen', () => {
  it('replaces every unknown value with a neutral sentence', () => {
    const odd = 'zz_unknown_value';
    const { container } = render(
      <>
        <LpPaymentDetailView
          detail={ok(
            detail({
              status: odd as never,
              stage: stage({ stage: odd as never }),
            }),
          )}
          events={ok({
            items: [
              event({
                objectKind: odd as never,
                providerStatus: odd,
                processingClass: odd as never,
                processing: {
                  outcome: odd as never,
                  reasonClass: odd,
                  attempt: 1,
                  deferredUntil: null,
                  processedAt: STAMP,
                },
              }),
            ],
            nextCursor: null,
          })}
        />
        <LpMandateDetailView
          detail={ok(
            mandateDetail({
              mandate: mandateRow({ status: odd as never, rail: odd as never, providerMode: odd }),
              debits: [debit({ status: odd as never, returnClass: odd as never })],
            }),
          )}
        />
        <LpExceptionsQueueView
          page={ok({
            items: [
              exceptionRow({
                class: odd,
                severity: odd as never,
                owner: odd as never,
                status: odd as never,
              }),
            ],
            nextCursor: null,
          })}
          filters={{}}
          keep={{}}
        />
        <LpReconciliationReportView
          summary={ok(summary({ notReconcilable: [odd] }))}
          date="2026-10-16"
        />
      </>,
    );
    expect(text(container)).not.toContain(odd);
    expect(text(container)).toContain(labels.LP_UNRECOGNISED);
  });

  it('never shows the text or code of a failed load', () => {
    const secret = 'zz_leaky_server_message';
    const { container } = render(
      <>
        <LpMandatesListView page={bad(500, secret)} filters={{}} keep={{}} />
        <LpReconciliationRunsView page={bad(500, secret)} keep={{}} />
        <LpSettlementBatchesView page={bad(500, secret)} keep={{}} />
        <LpExceptionsQueueView page={bad(500, secret)} filters={{}} keep={{}} />
        <LpNotice error={secret} />
      </>,
    );
    expect(text(container)).not.toContain(secret);
  });

  it('keeps personal-looking data out of the screens it renders', () => {
    const { container } = render(
      <>
        <LpPaymentsListView
          page={ok({ items: [payment()], nextCursor: null })}
          filters={{}}
          keep={{}}
        />
        <LpMandateDetailView detail={ok(mandateDetail({ debits: [debit()], notices: [] }))} />
        <LpExceptionDetailView detail={ok(exceptionDetail())} ctx={ctx(['payment.reconcile'])} />
      </>,
    );
    // Identifiers are stripped first: a random-looking id can hold a long run of digits.
    const body = text(container).replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
      '',
    );
    expect(body).not.toMatch(/\d{10,}/);
    expect(body).not.toMatch(/@/);
    expect(body).not.toMatch(/\+91/);
    expect(container.innerHTML).not.toMatch(/Bearer|payment_link|secret/i);
  });
});

describe('accessibility', () => {
  it('gives every table a caption or an accessible name and every column a scope', () => {
    const { container } = render(
      <>
        <LpPaymentsListView
          page={ok({ items: [payment()], nextCursor: null })}
          filters={{}}
          keep={{}}
        />
        <LpPaymentDetailView
          detail={ok(detail())}
          events={ok({ items: [event()], nextCursor: null })}
        />
        <LpMandateDetailView
          detail={ok(
            mandateDetail({
              debits: [debit()],
              events: [
                {
                  id: uid(56),
                  fromStatus: null,
                  toStatus: 'draft',
                  source: 'request',
                  providerEventId: null,
                  observedAt: STAMP,
                  createdAt: STAMP,
                },
              ],
            }),
          )}
        />
        <LpExceptionDetailView detail={ok(exceptionDetail())} ctx={ctx(['payment.read'])} />
      </>,
    );
    const tables = Array.from(container.querySelectorAll('table'));
    expect(tables.length).toBeGreaterThanOrEqual(5);
    for (const table of tables) {
      expect(table.querySelector('caption'), table.outerHTML.slice(0, 80)).toBeTruthy();
      for (const th of Array.from(table.querySelectorAll('thead th'))) {
        expect(th.getAttribute('scope')).toBe('col');
      }
    }
  });

  it('labels every visible control of every form', () => {
    const { container } = render(
      <>
        <LpPaymentPolicyView policy={ok({ items: [] })} ctx={ctx(['payment.configure'])} />
        <LpMandatePolicyView policy={ok({ items: [] })} ctx={ctx(['payment.configure'])} />
        <LpReconciliationSettingsView
          settings={ok({ items: [] })}
          ctx={ctx(['payment.configure'])}
        />
        <LpExceptionDetailView detail={ok(exceptionDetail())} ctx={ctx(['payment.reconcile'])} />
        <LpExceptionDetailView
          detail={ok(exceptionDetail({ status: 'resolved', resolvedAt: STAMP }))}
          ctx={ctx(['payment.reconcile'])}
        />
        <LpBankCreditUploadView
          accounts={ok({
            items: [
              {
                settlementAccountId: uid(4),
                lenderId: LENDER,
                maskedRef: 'XXXXXX4321',
                verificationStatus: 'verified',
                effectiveFrom: '2026-01-01',
                effectiveTo: null,
                usable: true,
              },
            ],
          })}
          ctx={ctx(['payment.reconcile'])}
        />
      </>,
    );
    const controls = Array.from(container.querySelectorAll('input, select, textarea')).filter(
      (el) => (el as HTMLInputElement).type !== 'hidden',
    ) as HTMLInputElement[];
    expect(controls.length).toBeGreaterThan(15);
    for (const control of controls) {
      expect(control.labels?.length, control.name).toBeGreaterThan(0);
    }
  });

  it('says critical in words, never by colour alone', () => {
    render(
      <LpReconciliationReportView
        summary={ok(summary({ settledToNonLender: { items: 1, minor: 100 } }))}
        date="2026-10-16"
      />,
    );
    expect(screen.getByRole('heading', { name: /^Critical:/ })).toBeTruthy();
  });

  it('never uses an inline style (the content security policy forbids it)', () => {
    const { container } = render(
      <>
        <LpExceptionDetailView
          detail={ok(exceptionDetail({ severity: 'critical' }))}
          ctx={ctx(['payment.reconcile'])}
        />
        <LpReconciliationReportView
          summary={ok(summary({ settledToNonLender: { items: 1, minor: 100 } }))}
          date="2026-10-16"
        />
      </>,
    );
    expect(container.querySelector('[style]')).toBeNull();
  });
});
