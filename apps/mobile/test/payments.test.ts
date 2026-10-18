import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApiClient } from '@udofin/auth-client';
import {
  BpMandateRequest,
  BpPaymentRequest,
  BP_DEBIT_STATUSES,
  BP_MANDATE_STATUSES,
  BP_NOTICE_STATUSES,
  BP_PAYMENT_STAGES,
  BP_PAYMENT_STATUSES,
  BP_RETURN_CLASSES,
  type BpMandate,
  type BpMandateDebit,
  type BpMandateOptions,
  type BpPaymentDetail,
  type BpPaymentOptions,
} from '@udofin/contracts';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { translate, type Language, type MessageKey } from '../src/i18n';
import { en } from '../src/i18n/en';
import { enPayments } from '../src/i18n/en.payments';
import { hi } from '../src/i18n/hi';
import { hiPayments } from '../src/i18n/hi.payments';
import { createMandatesClient } from '../src/borrower/mandates';
import {
  canOpenAuthorisation,
  canRequestCancellation,
  debitView,
  emptyMandateDraft,
  forgetMandateDraftId,
  mandateDraftId,
  mandateDraftReducer,
  mandateHeadline,
  mandateListItemView,
  mandateSetupView,
  mandateView,
  maskedAccountRef,
  parseDayMonthYear,
  resolveMandateRequest,
  sanitizeLastFour,
} from '../src/borrower/mandates-view';
import { CLIENT_REFUSAL, createPaymentsClient } from '../src/borrower/payments';
import { needsNewMandateId, payErrorKey, refreshAfterError } from '../src/borrower/payments-errors';
import { isOpenableHandoffUrl, openHandoff } from '../src/borrower/payments-handoff';
import {
  firstParam,
  isUuid,
  newAttemptKey,
  newUuid,
  type RandomSource,
} from '../src/borrower/payments-ids';
import {
  MAX_POLL_ATTEMPTS,
  POLL_DELAYS_MS,
  backoffDelay,
  mandatePollDelay,
  paymentPollDelay,
  pollLoop,
} from '../src/borrower/payments-polling';
import {
  amountRuleFor,
  ctxFor,
  emptyPayDraft,
  formatDateOnly,
  isWaiting,
  payDraftReducer,
  payOptionsView,
  paymentHeadline,
  paymentStatusView,
  resolvePayment,
  safeMaskedRef,
  type Ctx,
  type OptionView,
  type PayDraft,
  type Word,
} from '../src/borrower/payments-view';

// ---------------------------------------------------------------------------------------------------------------
// Fixtures: synthetic values only (no personal data, no credential-shaped strings)
// ---------------------------------------------------------------------------------------------------------------
const LOAN = '0f0f0f0f-0000-4000-8000-000000000001';
const PAY = '0f0f0f0f-0000-4000-8000-000000000002';
const MANDATE = '0f0f0f0f-0000-4000-8000-000000000003';
const QUOTE = '0f0f0f0f-0000-4000-8000-000000000004';
const LENDER = 'Sample Lender Ltd';
const SENTENCE =
  'Sample penal charge sentence approved by the lender: 2% a year on the overdue amount.';

const enCtx = ctxFor('en');
const hiCtx = ctxFor('hi');
const text = (w: Word | null | undefined, ctx: Ctx = enCtx): string => (w ? ctx.say(w) : '');

const options = (over: Partial<BpPaymentOptions> = {}): BpPaymentOptions => ({
  loanId: LOAN,
  lenderDisplayName: LENDER,
  available: true,
  unavailableKey: null,
  destinationMaskedRef: 'XXXXXX1234',
  figuresAvailable: true,
  stale: false,
  reportedAsOf: '2026-10-17T09:30:00+05:30',
  purposes: [],
  penalCharge: null,
  penalChargeTextMissing: false,
  openPayments: [],
  ...over,
});

const installment = {
  purpose: 'installment',
  amountSource: 'lender_reported',
  amountMinor: 1_250_000,
  dueOn: '2026-11-05',
  minMinor: 1_250_000,
  maxMinor: 1_250_000,
} as const;
const installmentPartial = { ...installment, minMinor: 500_000 } as const;
const overdue = {
  purpose: 'overdue',
  amountSource: 'lender_reported',
  amountMinor: 2_500_000,
  minMinor: 2_500_000,
  maxMinor: 2_500_000,
} as const;
const prepay = {
  purpose: 'part_prepayment',
  amountSource: 'borrower_within_lender_limits',
  minMinor: 1_000_000,
  maxMinor: 15_000_000,
} as const;
const foreclosure = {
  purpose: 'foreclosure',
  amountSource: 'lender_quote',
  amountMinor: 18_765_432,
  quoteId: QUOTE,
  validUntil: '2026-10-25T17:45:00+05:30',
  flagged: false,
  minMinor: 18_765_432,
  maxMinor: 18_765_432,
} as const;

const payment = (over: Partial<BpPaymentDetail> = {}): BpPaymentDetail => ({
  id: PAY,
  loanId: LOAN,
  lenderDisplayName: LENDER,
  purpose: 'installment',
  amountMinor: 1_250_000,
  status: 'pending',
  stage: 'started',
  createdAt: '2026-10-18T10:00:00+05:30',
  linkExpiresAt: '2026-10-18T18:30:00+05:30',
  linkAvailable: true,
  cancellable: false,
  destinationMaskedRef: 'XXXXXX1234',
  providerReceivedAt: null,
  lenderPostedOn: null,
  ...over,
});

const mandate = (over: Partial<BpMandate> = {}): BpMandate => ({
  id: MANDATE,
  loanId: LOAN,
  lenderDisplayName: LENDER,
  rail: 'enach_api',
  status: 'active',
  maxAmountMinor: 3_000_000,
  startDate: '2026-11-01',
  endDate: '2027-10-31',
  maskedAccountRef: 'XXXXXX1234',
  needsAfaEachDebit: false,
  cancelRequested: false,
  nextDebitOn: '2026-11-05',
  nextDebitMinor: 1_250_000,
  nextDebitNotified: false,
  ...over,
});

const mandateOptions = (over: Partial<BpMandateOptions> = {}): BpMandateOptions => ({
  loanId: LOAN,
  lenderDisplayName: LENDER,
  available: true,
  unavailableKey: null,
  requirement: null,
  preDebitLeadHours: 48,
  rails: [
    { rail: 'enach_api', maxAmountMinor: 5_000_000, needsAfaEachDebit: false },
    { rail: 'upi_autopay', maxAmountMinor: 1_500_000, needsAfaEachDebit: true },
  ],
  existingMandateId: null,
  ...over,
});

const debit = (over: Partial<BpMandateDebit> = {}): BpMandateDebit => ({
  id: '0f0f0f0f-0000-4000-8000-000000000005',
  scheduledOn: '2026-11-05',
  amountMinor: 1_250_000,
  status: 'scheduled',
  planned: true,
  returnCode: null,
  returnClass: null,
  notice: null,
  ...over,
});

/** Every sentence a view would put on the screen, in the given language (words with their values, plus plain strings). */
const allText = (value: unknown, ctx: Ctx = enCtx): string[] => {
  if (value === null || typeof value !== 'object') return typeof value === 'string' ? [value] : [];
  if (Array.isArray(value)) return value.flatMap((v) => allText(v, ctx));
  const record = value as Record<string, unknown>;
  if (typeof record.key === 'string' && /^(pay|mandate)\./.test(record.key)) {
    return [ctx.say(record as unknown as Word)];
  }
  return Object.values(record).flatMap((v) => allText(v, ctx));
};

const optionOf = (view: ReturnType<typeof payOptionsView>, purpose: string): OptionView => {
  const found = view.options.find((o) => o.purpose === purpose);
  if (!found) throw new Error(`no ${purpose} option`);
  return found;
};

// ---------------------------------------------------------------------------------------------------------------
// Ids, keys and route parameters
// ---------------------------------------------------------------------------------------------------------------
describe('ids and attempt keys', () => {
  const fixed: RandomSource = {
    getRandomValues: (bytes) => {
      bytes.forEach((_, i) => (bytes[i] = (i * 17 + 3) & 255));
      return bytes;
    },
  };

  it('builds a version-4 UUID that the contract accepts', () => {
    const id = newUuid(fixed);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(z.uuid().safeParse(id).success).toBe(true);
    expect(z.uuid().safeParse(newUuid(undefined)).success).toBe(true);
  });

  it('uses the secure source when there is one and Math.random only when there is not', () => {
    let calls = 0;
    const fallback = () => (calls += 1) / 1000;
    expect(newUuid(fixed, fallback)).toBe(newUuid(fixed, fallback));
    expect(calls).toBe(0);
    newUuid({}, fallback);
    expect(calls).toBe(16);
  });

  it('gives different ids and different attempt keys, in the range the API accepts', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newUuid(undefined)));
    expect(ids.size).toBe(50);
    const key = newAttemptKey(undefined);
    expect(key).toMatch(/^[A-Za-z0-9._:-]{16,128}$/);
    expect(newAttemptKey(undefined)).not.toBe(key);
  });

  it('accepts a route parameter only if it has the shape of a UUID', () => {
    expect(isUuid(LOAN)).toBe(true);
    for (const bad of ['', 'abc', `${LOAN}x`, '../../v1/me', undefined, null, 5, `${LOAN}/x`]) {
      expect(isUuid(bad), String(bad)).toBe(false);
    }
    expect(firstParam(['a', 'b'])).toBe('a');
    expect(firstParam('a')).toBe('a');
    expect(firstParam(undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The provider's link (a bearer secret)
// ---------------------------------------------------------------------------------------------------------------
describe('opening the provider link', () => {
  const GOOD = 'https://pay.provider.example/checkout/abcDEF?session=zz9&lang=en#top';

  it('accepts only plain https links', () => {
    expect(isOpenableHandoffUrl(GOOD)).toBe(true);
    expect(isOpenableHandoffUrl('https://pay.provider.example:8443/x')).toBe(true);
    const refused = [
      'http://pay.provider.example/x',
      'javascript:alert(1)',
      'upi://pay?pa=someone@bank',
      'intent://scan/#Intent;scheme=zxing;end',
      'file:///etc/passwd',
      'https://user:secret@pay.provider.example/x',
      'https://pay.provider.example\\@evil.example/x',
      'https://pay.provider.example/x y',
      'https://pay.provider.example/x\n',
      'https:///nohost',
      'https://',
      '',
      ` ${GOOD}`,
      `https://pay.provider.example/${'a'.repeat(5000)}`,
    ];
    for (const link of refused) expect(isOpenableHandoffUrl(link), link.slice(0, 40)).toBe(false);
  });

  it('hands the exact link to the opener once and reports a closed word', async () => {
    const seen: string[] = [];
    const outcome = await openHandoff(GOOD, (url) => {
      seen.push(url);
      return Promise.resolve();
    });
    expect(outcome).toBe('opened');
    expect(seen).toEqual([GOOD]);
  });

  it('never passes an unsafe link on', async () => {
    const seen: string[] = [];
    const outcome = await openHandoff('http://pay.provider.example/x', (url) => {
      seen.push(url);
      return Promise.resolve();
    });
    expect(outcome).toBe('unsafe');
    expect(seen).toEqual([]);
  });

  it('reports a failure without the link or the system message', async () => {
    const outcome = await openHandoff(GOOD, () => Promise.reject(new Error(`cannot open ${GOOD}`)));
    expect(outcome).toBe('failed');
    expect(JSON.stringify(outcome)).not.toContain('provider.example');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------------------------------------------
describe('polling plan', () => {
  it('backs off and then repeats the last wait', () => {
    expect(POLL_DELAYS_MS.map((_, i) => backoffDelay(i))).toEqual([...POLL_DELAYS_MS]);
    expect(backoffDelay(99)).toBe(30_000);
    expect(backoffDelay(-4)).toBe(2_000);
    expect(backoffDelay(2.9)).toBe(5_000);
  });

  const waiting = (over: Partial<BpPaymentDetail> = {}) =>
    payment({ status: 'created', stage: 'started', linkAvailable: false, ...over });

  it('waits for a created payment, with back-off, until the attempts run out', () => {
    expect(paymentPollDelay(waiting(), { attempt: 0, linkOpened: false })).toBe(2_000);
    expect(paymentPollDelay(waiting(), { attempt: 3, linkOpened: false })).toBe(8_000);
    expect(paymentPollDelay(waiting(), { attempt: MAX_POLL_ATTEMPTS - 1, linkOpened: false })).toBe(
      30_000,
    );
    expect(
      paymentPollDelay(waiting(), { attempt: MAX_POLL_ATTEMPTS, linkOpened: false }),
    ).toBeNull();
  });

  it('stops when the link is ready for the borrower to tap, and waits again once it was opened', () => {
    const ready = payment({ status: 'pending', linkAvailable: true });
    expect(paymentPollDelay(ready, { attempt: 0, linkOpened: false })).toBeNull();
    expect(paymentPollDelay(ready, { attempt: 0, linkOpened: true })).toBe(2_000);
  });

  it('keeps waiting for a pending payment whose link is not there yet', () => {
    const pending = payment({ status: 'pending', linkAvailable: false });
    expect(paymentPollDelay(pending, { attempt: 1, linkOpened: false })).toBe(3_000);
  });

  it('stops once the stage moved or the request ended', () => {
    for (const stage of ['provider_received', 'lender_posted', 'needs_attention'] as const) {
      expect(
        paymentPollDelay(waiting({ stage }), { attempt: 0, linkOpened: true }),
        stage,
      ).toBeNull();
    }
    for (const status of ['succeeded', 'failed', 'expired', 'cancelled'] as const) {
      expect(
        paymentPollDelay(waiting({ status }), { attempt: 0, linkOpened: true }),
        status,
      ).toBeNull();
    }
  });

  it('waits for a draft mandate, and after the page was opened, and after a cancellation request', () => {
    const idle = { attempt: 0, linkOpened: false };
    expect(mandatePollDelay(mandate({ status: 'draft' }), idle)).toBe(2_000);
    expect(mandatePollDelay(mandate({ status: 'registration_pending' }), idle)).toBeNull();
    expect(
      mandatePollDelay(mandate({ status: 'registration_pending' }), { ...idle, linkOpened: true }),
    ).toBe(2_000);
    expect(mandatePollDelay(mandate({ status: 'active', cancelRequested: true }), idle)).toBe(
      2_000,
    );
    expect(
      mandatePollDelay(mandate({ status: 'cancelled', cancelRequested: true }), idle),
    ).toBeNull();
    expect(mandatePollDelay(mandate({ status: 'active' }), idle)).toBeNull();
    expect(mandatePollDelay(mandate({ status: 'draft' }), { ...idle, attempt: 20 })).toBeNull();
  });
});

describe('the polling loop', () => {
  const ok = <T>(data: T) => ({ ok: true as const, status: 200, data });
  const fail = (code: string) => ({ ok: false as const, status: 500, code });

  it('reads, reports, waits and repeats until told to stop', async () => {
    const seen: number[] = [];
    const slept: number[] = [];
    let n = 0;
    await pollLoop<number>({
      load: () => Promise.resolve(ok((n += 1))),
      delayFor: (data, attempt) => (data < 4 ? 100 + attempt : null),
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
      isCancelled: () => false,
      onResult: (r) => {
        if (r.ok) seen.push(r.data);
      },
    });
    expect(seen).toEqual([1, 2, 3, 4]);
    expect(slept).toEqual([100, 101, 102]);
  });

  it('does not read at all once the screen was left', async () => {
    let loads = 0;
    await pollLoop<number>({
      load: () => Promise.resolve(ok((loads += 1))),
      delayFor: () => 10,
      sleep: () => Promise.resolve(),
      isCancelled: () => true,
      onResult: () => undefined,
    });
    expect(loads).toBe(0);
  });

  it('reports nothing and stops when the screen is left while a read is in flight', async () => {
    let cancelled = false;
    const reported: number[] = [];
    let loads = 0;
    await pollLoop<number>({
      load: () => {
        loads += 1;
        cancelled = true; // the screen is left while this read is on its way
        return Promise.resolve(ok(loads));
      },
      delayFor: () => 10,
      sleep: () => Promise.resolve(),
      isCancelled: () => cancelled,
      onResult: (r) => {
        if (r.ok) reported.push(r.data);
      },
    });
    expect(loads).toBe(1);
    expect(reported).toEqual([]);
  });

  it('stops at the first failed read after reporting it', async () => {
    let loads = 0;
    const codes: string[] = [];
    await pollLoop<number>({
      load: () => Promise.resolve(++loads === 1 ? ok(1) : fail('network_error')),
      delayFor: () => 10,
      sleep: () => Promise.resolve(),
      isCancelled: () => false,
      onResult: (r) => {
        if (!r.ok) codes.push(r.code);
      },
    });
    expect(loads).toBe(2);
    expect(codes).toEqual(['network_error']);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Pay: what is offered, in the lender's words and figures
// ---------------------------------------------------------------------------------------------------------------
describe('payment options view', () => {
  it('shows the lender, the masked destination and whose figure it is', () => {
    const v = payOptionsView(options({ purposes: [installment] }), enCtx);
    expect(v.lender).toBe(LENDER);
    expect(text(v.destination)).toBe(`Paid to ${LENDER}'s account XXXXXX1234`);
    expect(text(v.reported)).toContain(`As reported by ${LENDER} on`);
    expect(text(v.reported)).toContain('IST');
    expect(v.notice).toBeNull();
    expect(v.unavailable).toBeNull();
  });

  it('says the amount source in words and shows the amount exactly as stated', () => {
    const v = payOptionsView(
      options({ purposes: [installment, overdue, prepay, foreclosure] }),
      enCtx,
    );
    expect(text(optionOf(v, 'installment').source)).toBe(`Amount set by ${LENDER}: ₹12,500`);
    expect(text(optionOf(v, 'installment').due)).toContain('2026');
    expect(text(optionOf(v, 'overdue').source)).toBe(`Amount set by ${LENDER}: ₹25,000`);
    expect(text(optionOf(v, 'part_prepayment').source)).toBe(
      `You choose the amount, within limits set by ${LENDER}: ₹10,000 to ₹1,50,000`,
    );
    expect(text(optionOf(v, 'foreclosure').source)).toBe(
      `Amount set by ${LENDER}'s quotation: ₹1,87,654.32`,
    );
  });

  it('keeps a quotation validity as a date and time, never a timer', () => {
    const v = payOptionsView(options({ purposes: [foreclosure] }), enCtx);
    const validity = text(optionOf(v, 'foreclosure').quote?.validUntil);
    expect(validity).toContain('2026');
    expect(validity).toContain('IST');
    expect(validity).toMatch(/valid until/);
    expect(validity).not.toMatch(/\b(left|remaining|countdown|expires in)\b/i);
  });

  it('flags a quotation that does not add up and gives it no way to be paid', () => {
    const flagged = options({ purposes: [{ ...foreclosure, flagged: true }] });
    const v = payOptionsView(flagged, enCtx);
    const option = optionOf(v, 'foreclosure');
    expect(text(option.quote?.blocked)).toContain('does not add up');
    const draft: PayDraft = { ...emptyPayDraft(), purpose: 'foreclosure' };
    const resolved = resolvePayment(option, draft, enCtx);
    expect(resolved.ok).toBe(false);
    expect(
      payOptionsView(options({ purposes: [foreclosure] }), enCtx).options[0]?.quote?.blocked,
    ).toBeNull();
  });

  it('puts the lender approved penal sentence on the overdue option only, exactly as returned', () => {
    const penal = { version: 3, sentenceEn: `  ${SENTENCE}  `, sentenceHi: null };
    const v = payOptionsView(
      options({ purposes: [installment, overdue], penalCharge: penal }),
      enCtx,
    );
    expect(optionOf(v, 'overdue').penal?.sentence).toBe(`  ${SENTENCE}  `);
    expect(optionOf(v, 'installment').penal).toBeNull();
  });

  it('shows nothing about charges when the lender has no approved sentence', () => {
    const v = payOptionsView(
      options({ purposes: [overdue], penalCharge: null, penalChargeTextMissing: true }),
      enCtx,
    );
    expect(optionOf(v, 'overdue').penal).toBeNull();
    const rendered = allText(v).join(' | ');
    expect(rendered).toContain('Overdue amount');
    expect(rendered).not.toMatch(/penal|charge|fee/i);
  });

  it('uses the Hindi sentence only when the lender has one, and says so when it shows the English one', () => {
    const both = { version: 1, sentenceEn: SENTENCE, sentenceHi: 'अनुमोदित वाक्य (नमूना)' };
    const onlyEnglish = { version: 1, sentenceEn: SENTENCE, sentenceHi: null };
    const blankHindi = { version: 1, sentenceEn: SENTENCE, sentenceHi: '   ' };
    const view = (penal: BpPaymentOptions['penalCharge'], ctx: Ctx) =>
      optionOf(payOptionsView(options({ purposes: [overdue], penalCharge: penal }), ctx), 'overdue')
        .penal;
    expect(view(both, hiCtx)?.sentence).toBe('अनुमोदित वाक्य (नमूना)');
    expect(view(both, hiCtx)?.shownInEnglish).toBe(false);
    expect(view(onlyEnglish, hiCtx)?.sentence).toBe(SENTENCE);
    expect(view(onlyEnglish, hiCtx)?.shownInEnglish).toBe(true);
    expect(view(blankHindi, hiCtx)?.sentence).toBe(SENTENCE);
    expect(view(both, enCtx)?.sentence).toBe(SENTENCE);
    expect(view(both, enCtx)?.shownInEnglish).toBe(false);
  });

  it('shows no sentence at all if the approved sentence is empty', () => {
    const empty = { version: 1, sentenceEn: '  ', sentenceHi: null };
    expect(
      optionOf(
        payOptionsView(options({ purposes: [overdue], penalCharge: empty }), enCtx),
        'overdue',
      ).penal,
    ).toBeNull();
  });

  it('says the lender is checking withheld figures and shows no amount, never zero', () => {
    const v = payOptionsView(
      options({ figuresAvailable: false, stale: true, reportedAsOf: null }),
      enCtx,
    );
    expect(v.notice?.tone).toBe('warning');
    expect(text(v.notice?.word)).toBe(
      `${LENDER} is checking these figures. No amount is shown until ${LENDER} has confirmed them.`,
    );
    expect(v.options).toEqual([]);
    expect(v.reported).toBeNull();
    expect(JSON.stringify(v)).not.toMatch(/₹0\b/);
    // Withheld wins even if the API still names a date.
    const withDate = payOptionsView(options({ figuresAvailable: false }), enCtx);
    expect(text(withDate.notice?.word)).toContain('is checking these figures');
    expect(withDate.reported).toBeNull();
  });

  it('explains stale figures with the date, or without when none was given', () => {
    const dated = payOptionsView(options({ stale: true }), enCtx);
    expect(text(dated.notice?.word)).toContain('out of date');
    expect(text(dated.notice?.word)).toContain('IST');
    expect(dated.reported).toBeNull();
    const undated = payOptionsView(options({ stale: true, reportedAsOf: null }), enCtx);
    expect(text(undated.notice?.word)).toContain('out of date');
    expect(text(undated.notice?.word)).not.toContain('IST');
  });

  it('keeps a quotation visible when only the balance figures are out of date', () => {
    const v = payOptionsView(options({ stale: true, purposes: [foreclosure] }), enCtx);
    expect(v.options.map((o) => o.purpose)).toEqual(['foreclosure']);
    expect(v.noneOffered).toBeNull();
  });

  it('maps each unavailable key to plain words and offers nothing', () => {
    for (const key of [
      'loan_not_active',
      'collection_target_invalid',
      'config_ambiguous',
    ] as const) {
      const v = payOptionsView(
        options({ available: false, unavailableKey: key, purposes: [installment, prepay] }),
        enCtx,
      );
      expect(v.options, key).toEqual([]);
      expect(text(v.unavailable), key).toContain(LENDER);
      expect(text(v.unavailable), key).not.toContain(key);
      expect(v.noneOffered).toBeNull();
    }
    const unknown = payOptionsView(
      options({ available: false, unavailableKey: 'something_new' as never }),
      enCtx,
    );
    expect(text(unknown.unavailable)).toBe('Payments cannot be started in the app right now.');
    expect(JSON.stringify(unknown)).not.toContain('something_new');
  });

  it('says nothing is offered, in the lender words, when the list is empty and nothing else explains it', () => {
    const v = payOptionsView(options(), enCtx);
    expect(text(v.noneOffered)).toContain('No payment can be started in the app right now');
    expect(payOptionsView(options({ stale: true }), enCtx).noneOffered).toBeNull();
  });

  it('lists payments already in progress with plain status words', () => {
    const v = payOptionsView(
      options({
        openPayments: [
          { id: PAY, purpose: 'installment', status: 'created' },
          { id: LOAN, purpose: 'overdue', status: 'pending' },
        ],
      }),
      enCtx,
    );
    expect(v.openPayments.map((p) => p.id)).toEqual([PAY, LOAN]);
    expect(text(v.openPayments[0]?.status)).toBe('Started');
    expect(text(v.openPayments[1]?.status)).toBe('Started, with the payment provider');
    expect(text(v.openPayments[0]?.open)).toBe('View payment: Next instalment');
  });

  it('moves the option the borrower came for first, and selects nothing', () => {
    const v = payOptionsView(
      options({ purposes: [installment, overdue, foreclosure] }),
      enCtx,
      'foreclosure',
    );
    expect(v.options.map((o) => o.purpose)).toEqual(['foreclosure', 'installment', 'overdue']);
    const same = payOptionsView(options({ purposes: [installment, overdue] }), enCtx, 'charges');
    expect(same.options.map((o) => o.purpose)).toEqual(['installment', 'overdue']);
    expect(emptyPayDraft().purpose).toBeNull();
  });

  it('never draws a purpose it does not know', () => {
    const strange = { purpose: 'mystery', amountSource: 'x', minMinor: 1, maxMinor: 2 } as never;
    const v = payOptionsView(options({ purposes: [strange, installment] }), enCtx);
    expect(v.options.map((o) => o.purpose)).toEqual(['installment']);
  });

  it('shows a destination only if it looks masked', () => {
    expect(safeMaskedRef('XXXXXX1234')).toBe('XXXXXX1234');
    expect(safeMaskedRef('******98')).toBe('******98');
    for (const bad of ['123456789012', 'XXXXXX123456', 'X1', '12XX34', '', 'XXXXXX']) {
      expect(safeMaskedRef(bad), bad).toBeNull();
    }
    expect(safeMaskedRef(null)).toBeNull();
    const v = payOptionsView(options({ destinationMaskedRef: '123456789012' }), enCtx);
    expect(v.destination).toBeNull();
    expect(JSON.stringify(v)).not.toContain('123456789012');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Pay: the choice and the request (typed rupees to exact paise, nothing pre-selected)
// ---------------------------------------------------------------------------------------------------------------
describe('choosing what to pay', () => {
  const view = payOptionsView(
    options({ purposes: [installment, overdue, prepay, foreclosure] }),
    enCtx,
  );
  const partialView = payOptionsView(options({ purposes: [installmentPartial] }), enCtx);
  const choose = (purpose: PayDraft['purpose'], over: Partial<PayDraft> = {}): PayDraft => ({
    ...emptyPayDraft(),
    purpose,
    ...over,
  });

  it('starts with nothing chosen and resolves nothing', () => {
    const d = emptyPayDraft();
    expect(d).toEqual({ purpose: null, mode: null, amountText: '', attemptKey: null });
    expect(resolvePayment(optionOf(view, 'installment'), d, enCtx)).toEqual({
      ok: false,
      reason: null,
    });
    expect(resolvePayment(undefined, choose('installment'), enCtx)).toEqual({
      ok: false,
      reason: null,
    });
    // An option that is not the chosen one is not resolved either.
    expect(resolvePayment(optionOf(view, 'overdue'), choose('installment'), enCtx).ok).toBe(false);
  });

  it('reads the amount rule from the API figures', () => {
    expect(amountRuleFor(installment)).toEqual({ kind: 'fixed', amountMinor: 1_250_000 });
    expect(amountRuleFor(installmentPartial)).toEqual({
      kind: 'fixed_or_range',
      amountMinor: 1_250_000,
      minMinor: 500_000,
      maxMinor: 1_250_000,
    });
    expect(amountRuleFor(prepay)).toEqual({
      kind: 'range',
      minMinor: 1_000_000,
      maxMinor: 15_000_000,
    });
    expect(amountRuleFor(foreclosure)).toEqual({ kind: 'fixed', amountMinor: 18_765_432 });
    expect(text(optionOf(partialView, 'installment').partial)).toContain('smaller amount');
    expect(optionOf(view, 'installment').partial).toBeNull();
  });

  it('sends a fixed amount exactly as the API states it', () => {
    const r = resolvePayment(optionOf(view, 'installment'), choose('installment'), enCtx);
    expect(r).toEqual({
      ok: true,
      amountMinor: 1_250_000,
      request: { purpose: 'installment', amountMinor: 1_250_000 },
    });
  });

  it('names the quotation for a foreclosure and only then', () => {
    const r = resolvePayment(optionOf(view, 'foreclosure'), choose('foreclosure'), enCtx);
    expect(r).toEqual({
      ok: true,
      amountMinor: 18_765_432,
      request: { purpose: 'foreclosure', amountMinor: 18_765_432, quoteId: QUOTE },
    });
    const other = resolvePayment(optionOf(view, 'overdue'), choose('overdue'), enCtx);
    expect(other.ok && 'quoteId' in other.request).toBe(false);
  });

  it('turns typed rupees into exact paise without floats and keeps them inside the limits', () => {
    const o = optionOf(view, 'part_prepayment');
    const typed = (amountText: string) =>
      resolvePayment(o, choose('part_prepayment', { amountText }), enCtx);
    expect(typed('10,000')).toMatchObject({ ok: true, amountMinor: 1_000_000 });
    expect(typed('12345.67')).toMatchObject({ ok: true, amountMinor: 1_234_567 });
    expect(typed('1,50,000')).toMatchObject({ ok: true, amountMinor: 15_000_000 });
    expect(typed('0.1')).toMatchObject({ ok: false });
    // 19.99 * 100 is 1998.9999999999998 as a float; the exact parser gives 1999.
    const small = resolvePayment(
      { ...o, rule: { kind: 'range', minMinor: 1, maxMinor: 10_000 } },
      choose('part_prepayment', { amountText: '19.99' }),
      enCtx,
    );
    expect(small).toMatchObject({ ok: true, amountMinor: 1999 });
  });

  it('explains a typed amount that is out of range or not an amount, and says nothing before anything is typed', () => {
    const o = optionOf(view, 'part_prepayment');
    const reason = (amountText: string) => {
      const r = resolvePayment(o, choose('part_prepayment', { amountText }), enCtx);
      return r.ok ? 'ok' : text(r.reason);
    };
    expect(reason('')).toBe('');
    expect(reason('   ')).toBe('');
    expect(reason('9,999.99')).toBe('The amount must be at least ₹10,000.');
    expect(reason('1,50,000.01')).toBe('The amount must be at most ₹1,50,000.');
    for (const bad of ['abc', '12.345', '-5', '1e5', '₹5000', '5 000', '0', '1,2,3.456']) {
      expect(reason(bad), bad).toBe('Enter an amount in rupees, for example 5,000 or 5000.50.');
    }
  });

  it('offers the stated amount or a typed amount when the lender accepts a part, with neither chosen at first', () => {
    const o = optionOf(partialView, 'installment');
    expect(resolvePayment(o, choose('installment'), enCtx)).toEqual({ ok: false, reason: null });
    expect(resolvePayment(o, choose('installment', { mode: 'reported' }), enCtx)).toMatchObject({
      ok: true,
      amountMinor: 1_250_000,
    });
    expect(resolvePayment(o, choose('installment', { mode: 'other' }), enCtx)).toEqual({
      ok: false,
      reason: null,
    });
    expect(
      resolvePayment(o, choose('installment', { mode: 'other', amountText: '5,000' }), enCtx),
    ).toMatchObject({ ok: true, amountMinor: 500_000 });
    expect(
      text(
        (
          resolvePayment(
            o,
            choose('installment', { mode: 'other', amountText: '4,999' }),
            enCtx,
          ) as {
            reason: Word;
          }
        ).reason,
      ),
    ).toBe('The amount must be at least ₹5,000.');
  });

  it('produces a request the contract accepts, and nothing it would refuse', () => {
    for (const purpose of ['installment', 'overdue', 'foreclosure'] as const) {
      const r = resolvePayment(optionOf(view, purpose), choose(purpose), enCtx);
      expect(r.ok && BpPaymentRequest.safeParse(r.request).success).toBe(true);
    }
  });

  it('renews the attempt key whenever the content changes and keeps it otherwise', () => {
    let d = payDraftReducer(emptyPayDraft(), { type: 'purpose', purpose: 'part_prepayment' });
    d = payDraftReducer(d, { type: 'key', key: 'a-key-one-1234567890' });
    expect(d.attemptKey).toBe('a-key-one-1234567890');
    expect(payDraftReducer(d, { type: 'purpose', purpose: 'part_prepayment' }).attemptKey).toBe(
      'a-key-one-1234567890',
    );
    expect(payDraftReducer(d, { type: 'amount', text: '1' }).attemptKey).toBeNull();
    expect(payDraftReducer(d, { type: 'mode', mode: 'other' }).attemptKey).toBeNull();
    const switched = payDraftReducer(d, { type: 'purpose', purpose: 'overdue' });
    expect(switched).toEqual({ purpose: 'overdue', mode: null, amountText: '', attemptKey: null });
    expect(payDraftReducer(d, { type: 'reset' })).toEqual(emptyPayDraft());
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Payment status: honest stage words
// ---------------------------------------------------------------------------------------------------------------
describe('payment stage words', () => {
  const head = (stage: string, status: string) => paymentHeadline(stage, status, LENDER);

  it('uses the four stage words from the API', () => {
    expect(text(head('started', 'pending').headline)).toBe('Payment started');
    expect(text(head('provider_received', 'succeeded').headline)).toBe(
      'Received by the payment provider',
    );
    expect(text(head('lender_posted', 'succeeded').headline)).toBe(
      `${LENDER} has posted it to your loan`,
    );
    expect(text(head('needs_attention', 'pending').headline)).toBe(
      `Needs attention: contact ${LENDER}`,
    );
  });

  it('says received is not posted by the lender', () => {
    const explain = text(head('provider_received', 'succeeded').explain);
    expect(explain).toContain('does not yet mean');
    expect(explain).toContain(`${LENDER} has posted it to your loan`);
  });

  it('reads cancelled, failed or expired only for a payment the provider never reported money for', () => {
    expect(text(head('started', 'cancelled').headline)).toBe('Payment cancelled');
    expect(text(head('started', 'failed').headline)).toBe('Payment did not complete');
    expect(text(head('started', 'expired').headline)).toBe('Payment expired');
    // Once money was reported, those words must not hide it.
    expect(text(head('needs_attention', 'failed').headline)).toContain('Needs attention');
    expect(text(head('provider_received', 'expired').headline)).toBe(
      'Received by the payment provider',
    );
    expect(text(head('lender_posted', 'cancelled').headline)).toContain('has posted it');
  });

  it('does not say started for a request that is a plain success status with no stage news', () => {
    expect(text(head('started', 'succeeded').headline)).toBe('Payment started');
  });

  it('never says paid or successful in a stage headline or explanation', () => {
    for (const stage of BP_PAYMENT_STAGES) {
      for (const status of BP_PAYMENT_STATUSES) {
        for (const ctx of [enCtx, hiCtx]) {
          const h = head(stage, status);
          const all = `${text(h.headline, ctx)} ${text(h.explain, ctx)}`;
          expect(all, `${stage}/${status}`).not.toMatch(/\bpaid\b|success|भुगतान हो गया|सफल/i);
        }
      }
    }
  });

  it('shows a stage it does not know as a generic sentence, never as it came', () => {
    const h = head('settled_ok', 'succeeded');
    expect(text(h.headline)).toBe(
      `This payment's stage cannot be shown. Contact ${LENDER} if you need help.`,
    );
    expect(JSON.stringify(h)).not.toContain('settled_ok');
    expect(h.explain).toBeNull();
  });
});

describe('payment status view', () => {
  const state = { linkOpened: false, pollStopped: false };
  const lines = (v: ReturnType<typeof paymentStatusView>) => v.lines.map((l) => text(l));

  it('shows a created payment as being prepared, with no link and a cancel button when the API allows', () => {
    const v = paymentStatusView(
      payment({ status: 'created', linkAvailable: false, linkExpiresAt: null, cancellable: true }),
      state,
      enCtx,
    );
    expect(text(v.headline)).toBe('Payment started');
    expect(text(v.wait)).toContain('being prepared');
    expect(v.link).toBeNull();
    expect(v.linkMissing).toBeNull();
    expect(v.cancellable).toBe(true);
    expect(v.ended).toBe(false);
  });

  it('offers the provider button only while the API says a link is available, and shows its end as a date and time', () => {
    const v = paymentStatusView(payment({ linkAvailable: true }), state, enCtx);
    expect(v.link).not.toBeNull();
    expect(text(v.link?.until)).toContain('IST');
    expect(text(v.link?.until)).not.toMatch(/\b(left|remaining|countdown)\b/i);
    expect(v.wait).toBeNull();
    const none = paymentStatusView(payment({ linkAvailable: false }), state, enCtx);
    expect(none.link).toBeNull();
    expect(text(none.linkMissing)).toBe('There is no payment page to open right now.');
    const noEnd = paymentStatusView(
      payment({ linkAvailable: true, linkExpiresAt: null }),
      state,
      enCtx,
    );
    expect(noEnd.link).toEqual({ until: null });
  });

  it('shows the cancel button only when the API says cancellable', () => {
    for (const cancellable of [true, false]) {
      expect(paymentStatusView(payment({ cancellable }), state, enCtx).cancellable).toBe(
        cancellable,
      );
    }
    // Not derived from the status: a created payment the API says is not cancellable has no button.
    expect(
      paymentStatusView(payment({ status: 'created', cancellable: false }), state, enCtx)
        .cancellable,
    ).toBe(false);
  });

  it('after the provider page was opened, says that coming back proves nothing and shows the stage the API gives', () => {
    const v = paymentStatusView(payment(), { linkOpened: true, pollStopped: false }, enCtx);
    expect(text(v.wait)).toContain('does not show whether a payment was made');
    expect(text(v.headline)).toBe('Payment started');
    expect([text(v.headline), text(v.explain), text(v.wait)].join(' ')).not.toMatch(
      /\bpaid\b|success/i,
    );
  });

  it('says plainly when automatic checking has stopped', () => {
    const v = paymentStatusView(
      payment({ status: 'created', linkAvailable: false }),
      { linkOpened: false, pollStopped: true },
      enCtx,
    );
    expect(text(v.wait)).toContain('Check again');
    // A payment that is not waiting for anything says nothing about stopped checks.
    const done = paymentStatusView(
      payment({ status: 'succeeded', stage: 'provider_received', linkAvailable: false }),
      { linkOpened: false, pollStopped: true },
      enCtx,
    );
    expect(done.wait).toBeNull();
  });

  it('describes a payment the provider reported without calling it posted', () => {
    const v = paymentStatusView(
      payment({
        status: 'succeeded',
        stage: 'provider_received',
        linkAvailable: false,
        providerReceivedAt: '2026-10-18T11:05:00+05:30',
      }),
      state,
      enCtx,
    );
    expect(text(v.headline)).toBe('Received by the payment provider');
    expect(lines(v).some((l) => l.startsWith('Reported by the payment provider on'))).toBe(true);
    expect(lines(v).some((l) => l.startsWith('Posted by'))).toBe(false);
    expect(v.link).toBeNull();
  });

  it('says the lender posted it only when the API gives the stage and shows the value date', () => {
    const v = paymentStatusView(
      payment({
        status: 'succeeded',
        stage: 'lender_posted',
        linkAvailable: false,
        providerReceivedAt: '2026-10-18T11:05:00+05:30',
        lenderPostedOn: '2026-10-19',
      }),
      state,
      enCtx,
    );
    expect(text(v.headline)).toBe(`${LENDER} has posted it to your loan`);
    expect(lines(v).some((l) => l.startsWith(`Posted by ${LENDER} with value date`))).toBe(true);
  });

  it('asks the borrower to contact the lender when something needs attention', () => {
    const v = paymentStatusView(
      payment({ stage: 'needs_attention', status: 'pending', linkAvailable: false }),
      state,
      enCtx,
    );
    expect(text(v.headline)).toBe(`Needs attention: contact ${LENDER}`);
    expect(v.tone).toBe('warning');
  });

  it('offers a way back to the options only for a payment that ended without money being reported', () => {
    for (const status of ['cancelled', 'failed', 'expired'] as const) {
      expect(
        paymentStatusView(payment({ status, linkAvailable: false }), state, enCtx).ended,
        status,
      ).toBe(true);
    }
    expect(
      paymentStatusView(payment({ status: 'failed', stage: 'needs_attention' }), state, enCtx)
        .ended,
    ).toBe(false);
    expect(paymentStatusView(payment({ status: 'pending' }), state, enCtx).ended).toBe(false);
  });

  it('shows the amount the borrower asked for, the purpose and the masked destination', () => {
    const v = paymentStatusView(
      payment({ purpose: 'overdue', amountMinor: 2_500_000 }),
      state,
      enCtx,
    );
    expect(lines(v)).toContain('Amount: ₹25,000');
    expect(lines(v)).toContain('For: Overdue amount');
    expect(lines(v)).toContain(`Paid to ${LENDER}'s account XXXXXX1234`);
    const hidden = paymentStatusView(
      payment({ destinationMaskedRef: '123456789012' }),
      state,
      enCtx,
    );
    expect(lines(hidden).join(' ')).not.toContain('123456789012');
  });

  it('knows when a payment is waiting', () => {
    expect(isWaiting(payment({ status: 'created', linkAvailable: false }), false)).toBe(true);
    expect(isWaiting(payment({ status: 'pending', linkAvailable: true }), false)).toBe(false);
    expect(isWaiting(payment({ status: 'pending', linkAvailable: true }), true)).toBe(true);
    expect(isWaiting(payment({ status: 'pending', linkAvailable: false }), false)).toBe(true);
    expect(isWaiting(payment({ stage: 'provider_received', status: 'pending' }), true)).toBe(false);
    expect(isWaiting(payment({ status: 'failed' }), true)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Error words
// ---------------------------------------------------------------------------------------------------------------
describe('error words', () => {
  it('maps every stable code of the payment and mandate routes to a plain sentence', () => {
    const codes = [
      'amount_not_allowed',
      'bad_request',
      'feature_disabled',
      'loan_not_active',
      'collection_target_invalid',
      'config_ambiguous',
      'figures_unavailable',
      'stale_data',
      'nothing_due',
      'purpose_not_supported',
      'purpose_not_enabled',
      'quote_required',
      'quote_not_current',
      'quote_flagged',
      'open_intent_exists',
      'idempotency_conflict',
      'idempotency_key_reused',
      'mock_provider_blocked',
      'intent_not_cancellable',
      'handoff_unavailable',
      'stepup_required',
      'integrity_insufficient',
      'provider_not_mandate_capable',
      'creditor_not_lender',
      'rail_not_configured',
      'mandate_exists',
      'dates_invalid',
      'invalid_request',
      'account_ref_invalid',
      'mandate_finished',
      'not_found',
      'validation_failed',
      CLIENT_REFUSAL,
    ];
    for (const code of codes) {
      const key = payErrorKey(code);
      expect(key, code).not.toBe('error.generic');
      expect(en[key].length, code).toBeGreaterThan(10);
      expect(en[key], code).not.toContain(code);
    }
  });

  it('maps the step-up and device-check codes to plain words about what to do', () => {
    expect(payErrorKey('stepup_required')).toBe('mandate.err.stepup');
    expect(en[payErrorKey('stepup_required')]).toMatch(/one-time code.*step 1/);
    expect(payErrorKey('integrity_insufficient')).toBe('mandate.err.integrity');
    expect(en[payErrorKey('integrity_insufficient')]).toMatch(/security check/);
  });

  it('falls back to the shared words, then the generic sentence, and never shows server text', () => {
    expect(payErrorKey('network_error')).toBe('error.offline');
    expect(payErrorKey('rate_limited')).toBe('error.rateLimited');
    expect(payErrorKey('bad_response')).toBe('error.badResponse');
    expect(payErrorKey('http_500')).toBe('error.generic');
    expect(payErrorKey('SELECT * FROM payments; --')).toBe('error.generic');
    expect(payErrorKey('')).toBe('error.generic');
  });

  it('knows when to read again and when a mandate id can no longer be used', () => {
    expect(refreshAfterError('stale_data')).toBe(true);
    expect(refreshAfterError('open_intent_exists')).toBe(true);
    expect(refreshAfterError('network_error')).toBe(false);
    expect(refreshAfterError('amount_not_allowed')).toBe(false);
    expect(needsNewMandateId('idempotency_conflict')).toBe(true);
    expect(needsNewMandateId('stepup_required')).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Mandates: typed input
// ---------------------------------------------------------------------------------------------------------------
describe('mandate input', () => {
  it('reads day/month/year into a real ISO date and refuses anything else', () => {
    expect(parseDayMonthYear('05/11/2026')).toBe('2026-11-05');
    expect(parseDayMonthYear('5.1.2027')).toBe('2027-01-05');
    expect(parseDayMonthYear(' 29-02-2028 ')).toBe('2028-02-29');
    for (const bad of [
      '',
      '2026-11-05',
      '31/02/2027',
      '29/02/2027',
      '00/01/2027',
      '32/01/2027',
      '01/13/2027',
      '1/1/27',
      '01/01/20277',
      // Years below 100 are read by Date.UTC as 19xx; the year comparison refuses them.
      '01/01/0099',
      'ab/cd/efgh',
      '01//2027',
    ]) {
      expect(parseDayMonthYear(bad), bad).toBeNull();
    }
  });

  it('keeps only digits and never more than four: a long number is refused and the field keeps what it had', () => {
    expect(sanitizeLastFour('', '1')).toBe('1');
    expect(sanitizeLastFour('12', '12 3')).toBe('123');
    expect(sanitizeLastFour('', 'ab12-34')).toBe('1234');
    expect(sanitizeLastFour('1234', '12345')).toBe('1234');
    expect(sanitizeLastFour('', '123456789012')).toBe('');
    expect(sanitizeLastFour('12', '1234 5678 9012')).toBe('12');
    expect(sanitizeLastFour('1234', '')).toBe('');
  });

  it('builds the masked reference itself, and only from exactly four digits', () => {
    expect(maskedAccountRef('1234')).toBe('XXXXXX1234');
    for (const bad of ['', '123', '12345', 'abcd', '12a4', '123456789012']) {
      expect(maskedAccountRef(bad), bad).toBeNull();
    }
    expect(BpMandateRequest.shape.maskedAccountRef.safeParse('XXXXXX1234').success).toBe(true);
    expect(BpMandateRequest.shape.maskedAccountRef.safeParse('123456789012').success).toBe(false);
  });
});

describe('the mandate draft', () => {
  const offered = ['enach_api', 'upi_autopay'] as const;
  const filled = () => {
    let d = emptyMandateDraft();
    d = mandateDraftReducer(d, { type: 'rail', rail: 'enach_api' });
    d = mandateDraftReducer(d, { type: 'start', text: '01/11/2026' });
    d = mandateDraftReducer(d, { type: 'end', text: '31/10/2027' });
    d = mandateDraftReducer(d, { type: 'account', text: '1234' });
    return d;
  };

  it('starts empty, with no rail chosen', () => {
    expect(emptyMandateDraft()).toEqual({
      rail: null,
      startText: '',
      endText: '',
      lastFour: '',
      attemptKey: null,
    });
  });

  it('builds the request with the mandate id, the masked reference and no maximum amount', () => {
    const r = resolveMandateRequest(filled(), MANDATE, offered);
    expect(r).toEqual({
      ok: true,
      body: {
        mandateId: MANDATE,
        rail: 'enach_api',
        startDate: '2026-11-01',
        endDate: '2027-10-31',
        maskedAccountRef: 'XXXXXX1234',
      },
    });
    expect(r.ok && 'maxAmountMinor' in r.body).toBe(false);
    expect(r.ok && BpMandateRequest.safeParse(r.body).success).toBe(true);
  });

  it('says what is wrong with each field', () => {
    const r = resolveMandateRequest(emptyMandateDraft(), MANDATE, offered);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(text(r.errors.rail)).toBe('Choose how to set it up first.');
    expect(text(r.errors.start)).toBe('Enter a real date as DD/MM/YYYY.');
    expect(text(r.errors.end)).toBe('Enter a real date as DD/MM/YYYY.');
    expect(text(r.errors.account)).toBe('Enter exactly 4 digits.');
    const short = mandateDraftReducer(filled(), { type: 'account', text: '12' });
    const s = resolveMandateRequest(short, MANDATE, offered);
    expect(s.ok).toBe(false);
  });

  it('refuses a rail that was not offered', () => {
    const r = resolveMandateRequest(filled(), MANDATE, ['upi_autopay']);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.errors.rail).toBeDefined();
  });

  it('cannot hold a full account number: a long number leaves the field as it was', () => {
    let d = mandateDraftReducer(filled(), { type: 'account', text: '' });
    d = mandateDraftReducer(d, { type: 'account', text: '123456789012' });
    expect(d.lastFour).toBe('');
    d = mandateDraftReducer(d, { type: 'account', text: '4321' });
    d = mandateDraftReducer(d, { type: 'account', text: '43215' });
    expect(d.lastFour).toBe('4321');
  });

  it('renews the attempt key on every edit', () => {
    let d = mandateDraftReducer(filled(), { type: 'key', key: 'a-key-two-1234567890' });
    expect(d.attemptKey).toBe('a-key-two-1234567890');
    d = mandateDraftReducer(d, { type: 'end', text: '30/10/2027' });
    expect(d.attemptKey).toBeNull();
    d = mandateDraftReducer(d, { type: 'key', key: 'a-key-two-1234567890' });
    expect(mandateDraftReducer(d, { type: 'rail', rail: 'upi_autopay' }).attemptKey).toBeNull();
    expect(mandateDraftReducer(d, { type: 'reset' })).toEqual(emptyMandateDraft());
  });

  it('keeps one mandate id per loan until it is forgotten, because the one-time code is bound to it', () => {
    let n = 0;
    const make = () => `id-${String((n += 1))}`;
    forgetMandateDraftId('loan-a');
    forgetMandateDraftId('loan-b');
    expect(mandateDraftId('loan-a', make)).toBe('id-1');
    expect(mandateDraftId('loan-a', make)).toBe('id-1');
    expect(mandateDraftId('loan-b', make)).toBe('id-2');
    forgetMandateDraftId('loan-a');
    expect(mandateDraftId('loan-a', make)).toBe('id-3');
    forgetMandateDraftId('loan-a');
    forgetMandateDraftId('loan-b');
  });
});

describe('mandate setup view', () => {
  it('shows each rail with plain effects, its own maximum and the bank prompt note only when flagged', () => {
    const v = mandateSetupView(mandateOptions(), enCtx);
    expect(v.rails.map((r) => r.rail)).toEqual(['enach_api', 'upi_autopay']);
    const enach = v.rails[0];
    const upi = v.rails[1];
    expect(text(enach?.title)).toBe('eNACH (net banking or debit card)');
    expect(text(enach?.max)).toBe('Highest amount for one debit: ₹50,000');
    expect(text(upi?.max)).toBe('Highest amount for one debit: ₹15,000');
    expect(enach?.afa).toBeNull();
    expect(text(upi?.afa)).toBe('Your bank may ask you to approve every debit with a prompt.');
    expect(text(enach?.effect)).toContain(LENDER);
    expect(text(enach?.maxNote)).toContain('lower of');
  });

  it('says the lender requirement as the lender setting and the notice as a setting, not a guarantee', () => {
    const optional = mandateSetupView(mandateOptions({ requirement: 'optional' }), enCtx);
    expect(text(optional.requirement)).toBe(`${LENDER} lists auto-pay as optional.`);
    const before = mandateSetupView(mandateOptions({ requirement: 'before_first_due' }), enCtx);
    expect(text(before.requirement)).toContain("This is Sample Lender Ltd's setting.");
    expect(mandateSetupView(mandateOptions(), enCtx).requirement).toBeNull();
    expect(text(optional.lead)).toContain('48 hours');
    expect(text(optional.lead)).toContain('not a guarantee');
  });

  it('offers nothing and says why when the API says it is unavailable', () => {
    for (const key of [
      'loan_not_active',
      'collection_target_invalid',
      'config_ambiguous',
      'provider_not_mandate_capable',
      'rail_not_configured',
      'mandate_exists',
    ] as const) {
      const v = mandateSetupView(mandateOptions({ available: false, unavailableKey: key }), enCtx);
      expect(v.rails, key).toEqual([]);
      expect(text(v.unavailable), key).not.toContain(key);
      expect(v.unavailable, key).not.toBeNull();
    }
    const unknown = mandateSetupView(
      mandateOptions({ available: false, unavailableKey: 'new_reason' as never }),
      enCtx,
    );
    expect(text(unknown.unavailable)).toBe('Auto-pay cannot be set up in the app right now.');
    expect(JSON.stringify(unknown)).not.toContain('new_reason');
  });

  it('points to the existing mandate', () => {
    const v = mandateSetupView(mandateOptions({ existingMandateId: MANDATE }), enCtx);
    expect(v.existingMandateId).toBe(MANDATE);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Mandates: status, cancellation, debits
// ---------------------------------------------------------------------------------------------------------------
describe('mandate status words', () => {
  const head = (status: string) => mandateHeadline(status, LENDER);
  const all = (status: string, ctx: Ctx = enCtx) =>
    `${text(head(status).headline, ctx)} ${text(head(status).explain, ctx)}`;

  it('uses the plain word for each provider-confirmed status', () => {
    const expected: Record<string, string> = {
      draft: 'Requested',
      registration_pending: 'Waiting for your bank',
      active: 'Active',
      paused: 'Paused',
      rejected: 'Rejected',
      failed: 'Did not complete',
      expired: 'Expired',
      cancelled: 'Cancelled',
      revoked: 'Revoked',
      requires_reconciliation: 'Being checked',
    };
    expect(Object.keys(expected).sort()).toEqual([...BP_MANDATE_STATUSES].sort());
    for (const status of BP_MANDATE_STATUSES) {
      expect(text(head(status).headline), status).toBe(expected[status]);
    }
  });

  it('calls a mandate active only when the status is active', () => {
    for (const status of BP_MANDATE_STATUSES) {
      const said = all(status);
      if (status === 'active') expect(said).toMatch(/\bActive\b/);
      else expect(said, status).not.toMatch(/\bactive\b/i);
    }
    expect(all('draft')).toContain('Nothing is set up yet');
    expect(all('registration_pending')).toContain('only when the provider confirms it');
    expect(text(head('active').explain)).toBe('Active, as confirmed by the provider.');
  });

  it('shows a status it does not know as a generic sentence', () => {
    const h = head('suspended_by_bank');
    expect(text(h.headline)).toBe('Status not available');
    expect(JSON.stringify(h)).not.toContain('suspended_by_bank');
  });

  it('offers a cancellation request only while the provider could still move the mandate and none is open', () => {
    const can = (status: BpMandate['status'], cancelRequested = false) =>
      canRequestCancellation({ status, cancelRequested });
    for (const status of [
      'draft',
      'registration_pending',
      'active',
      'paused',
      'requires_reconciliation',
    ] as const) {
      expect(can(status), status).toBe(true);
      expect(can(status, true), `${status} requested`).toBe(false);
    }
    for (const status of ['rejected', 'failed', 'expired', 'cancelled', 'revoked'] as const) {
      expect(can(status), status).toBe(false);
    }
  });

  it('opens the authorisation page only while the status is waiting for the bank', () => {
    for (const status of BP_MANDATE_STATUSES) {
      expect(canOpenAuthorisation({ status }), status).toBe(status === 'registration_pending');
    }
  });
});

describe('mandate view', () => {
  const state = { linkOpened: false, pollStopped: false };

  it('shows the lender, the masked account, the limit and the dates', () => {
    const v = mandateView(mandate(), state, enCtx);
    const lines = v.lines.map((l) => text(l));
    expect(lines).toContain(`Lender: ${LENDER}`);
    expect(lines).toContain('Bank account: XXXXXX1234');
    expect(lines).toContain('Highest amount for one debit: ₹30,000');
    expect(
      lines.some((l) => l.startsWith('From ') && l.includes('2026') && l.includes('2027')),
    ).toBe(true);
    expect(lines).toContain('eNACH (net banking or debit card)');
  });

  it('says a bank prompt may appear on every debit only when the API flag says so', () => {
    expect(mandateView(mandate({ needsAfaEachDebit: false }), state, enCtx).afa).toBeNull();
    expect(text(mandateView(mandate({ needsAfaEachDebit: true }), state, enCtx).afa)).toContain(
      'approve every debit',
    );
  });

  it('shows the next planned debit without promising it, with the notice state when the API gives one', () => {
    const v = mandateView(mandate(), state, enCtx);
    expect(text(v.next.line)).toContain('₹12,500');
    expect(text(v.next.note)).toBe(
      `Planned debits come from ${LENDER}'s reported schedule. This is not a promise that a debit will or will not be made.`,
    );
    expect(text(v.next.notice)).toBe('A notice for this debit has not been sent yet.');
    expect(text(mandateView(mandate({ nextDebitNotified: true }), state, enCtx).next.notice)).toBe(
      'A notice for this debit has been sent.',
    );
    expect(mandateView(mandate({ nextDebitNotified: null }), state, enCtx).next.notice).toBeNull();
    const noAmount = mandateView(mandate({ nextDebitMinor: null }), state, enCtx);
    expect(text(noAmount.next.line)).toContain('amount not reported yet');
    expect(text(noAmount.next.line)).not.toContain('₹');
    const none = mandateView(
      mandate({ nextDebitOn: null, nextDebitMinor: null, nextDebitNotified: null }),
      state,
      enCtx,
    );
    expect(none.next.line).toBeNull();
    expect(none.next.notice).toBeNull();
  });

  it('calls a requested cancellation a request, and leaves the status as the API gave it', () => {
    const v = mandateView(mandate({ status: 'active', cancelRequested: true }), state, enCtx);
    expect(text(v.cancelRequested)).toContain('This is a request until the provider confirms it');
    expect(text(v.cancelRequested)).toContain('has not changed');
    expect(text(v.headline)).toBe('Active');
    expect(v.canCancel).toBe(false);
    expect(mandateView(mandate(), state, enCtx).cancelRequested).toBeNull();
    expect(mandateView(mandate(), state, enCtx).canCancel).toBe(true);
  });

  it('offers the authorisation page only while waiting for the bank, and explains the waits', () => {
    expect(
      mandateView(mandate({ status: 'registration_pending' }), state, enCtx).openAuthorisation,
    ).toBe(true);
    expect(mandateView(mandate({ status: 'active' }), state, enCtx).openAuthorisation).toBe(false);
    const afterReturn = mandateView(
      mandate({ status: 'registration_pending' }),
      { linkOpened: true, pollStopped: false },
      enCtx,
    );
    expect(text(afterReturn.wait)).toContain('changes only when the provider confirms it');
    const stopped = mandateView(
      mandate({ status: 'draft' }),
      { linkOpened: false, pollStopped: true },
      enCtx,
    );
    expect(text(stopped.wait)).toContain('Check again');
    expect(
      mandateView(mandate({ status: 'active' }), { linkOpened: false, pollStopped: true }, enCtx)
        .wait,
    ).toBeNull();
  });

  it('shows the list entry with the status word and the masked account', () => {
    const item = mandateListItemView(mandate({ status: 'registration_pending' }));
    expect(item.lender).toBe(LENDER);
    expect(text(item.headline)).toBe('Waiting for your bank');
    expect(text(item.account)).toBe('Bank account: XXXXXX1234');
    expect(mandateListItemView(mandate({ maskedAccountRef: '123456789012' })).account).toBeNull();
  });
});

describe('debits', () => {
  it('tells a planned debit from one the provider reported and shows an amount only when there is one', () => {
    const planned = debitView(debit(), enCtx);
    expect(text(planned.origin)).toBe('Planned');
    expect(text(planned.amount)).toBe('Amount: ₹12,500');
    const reported = debitView(debit({ planned: false, amountMinor: null }), enCtx);
    expect(text(reported.origin)).toBe('Reported by the provider');
    expect(text(reported.amount)).toBe('Amount not reported');
  });

  it('uses a plain word for each status', () => {
    const words = BP_DEBIT_STATUSES.map((status) =>
      text(debitView(debit({ status }), enCtx).status),
    );
    expect(new Set(words).size).toBe(BP_DEBIT_STATUSES.length);
    expect(words).toContain('Reported as settled');
    expect(words).toContain('Outcome not known yet');
    const strange = debitView(debit({ status: 'bounced_twice' as never }), enCtx);
    expect(text(strange.status)).toBe('Status not available');
  });

  it('shows the class of a return only when it was classified and invents no reason', () => {
    for (const returnClass of BP_RETURN_CLASSES) {
      const v = debitView(debit({ status: 'returned', returnCode: 'ZZ9', returnClass }), enCtx);
      expect(text(v.returned)).toMatch(/^Reason class: /);
    }
    const unclassified = debitView(
      debit({ status: 'returned', returnCode: 'ZZ9', returnClass: null }),
      enCtx,
    );
    expect(text(unclassified.returned)).toBe('No reason has been classified.');
    // Not returned, no class: nothing is said about a reason.
    expect(debitView(debit({ status: 'presented' }), enCtx).returned).toBeNull();
  });

  it('never shows the provider return code', () => {
    const v = debitView(
      debit({
        status: 'returned',
        returnCode: 'ZZ9-PROVIDER-TEXT',
        returnClass: 'insufficient_funds',
      }),
      enCtx,
    );
    expect(JSON.stringify(v)).not.toContain('ZZ9');
    expect(JSON.stringify(v)).not.toContain('PROVIDER-TEXT');
  });

  it('says the notice state with its date and time', () => {
    const base = { dueAt: '2026-11-03T10:00:00+05:30', sentAt: null };
    expect(
      BP_NOTICE_STATUSES.map((status) =>
        text(debitView(debit({ notice: { ...base, status } }), enCtx).notice),
      ),
    ).toEqual([
      expect.stringMatching(/^Notice planned for .*IST$/),
      expect.stringMatching(/^Notice sent on .*IST$/),
      expect.stringMatching(/^The notice was late \(it was due by .*IST\)$/),
      'No notice needed for this debit',
    ]);
    const sent = debitView(
      debit({ notice: { status: 'sent', dueAt: base.dueAt, sentAt: '2026-11-02T09:00:00+05:30' } }),
      enCtx,
    );
    expect(text(sent.notice)).toContain('2 Nov 2026');
    expect(debitView(debit(), enCtx).notice).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------------------------------------------
describe('formatting', () => {
  it('writes paise as rupees with Indian grouping and exact paise', () => {
    expect(enCtx.rupees(0)).toBe('0');
    expect(enCtx.rupees(99)).toBe('0.99');
    expect(enCtx.rupees(100_000)).toBe('1,000');
    expect(enCtx.rupees(1_250_000)).toBe('12,500');
    expect(enCtx.rupees(12_345_678_90)).toBe('1,23,45,678.90');
    expect(enCtx.rupees(18_765_432)).toBe('1,87,654.32');
  });

  it('writes dates and times in India time, with IST on times', () => {
    expect(enCtx.dateTime('2026-10-18T10:00:00+05:30')).toContain('IST');
    expect(enCtx.dateTime('2026-10-18T23:45:00Z')).toContain('19 Oct 2026');
    expect(enCtx.dateTime('not a time')).toBe('');
    expect(formatDateOnly('2026-11-05', 'en')).toBe('5 Nov 2026');
    expect(formatDateOnly('2026-11-05T00:00:00Z', 'en')).toBe('');
    expect(enCtx.date('2026-12-31')).toBe('31 Dec 2026');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The client (paths, keys, bodies, refusals)
// ---------------------------------------------------------------------------------------------------------------
interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}
function setup(routes: Record<string, { status?: number; body: unknown }>) {
  const calls: Call[] = [];
  const fetchFake = ((url: string, init: RequestInit) => {
    const path = url.replace('https://api.example', '');
    calls.push({
      method: init.method ?? 'GET',
      url: path,
      headers: init.headers as Record<string, string>,
      body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    });
    const hit = routes[`${init.method ?? 'GET'} ${path}`];
    if (!hit) return Promise.resolve(new Response('{}', { status: 404 }));
    return Promise.resolve(
      new Response(JSON.stringify(hit.body), {
        status: hit.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as unknown as typeof fetch;
  const api = createApiClient({
    baseUrl: 'https://api.example',
    getAccessToken: () => Promise.resolve('tok'),
    fetch: fetchFake,
  });
  return { payments: createPaymentsClient(api), mandates: createMandatesClient(api), calls };
}

describe('payment client', () => {
  it('reads options, the payment and the link from the right paths', async () => {
    const { payments, calls } = setup({
      [`GET /v1/loans/${LOAN}/payment-options`]: { body: options({ purposes: [installment] }) },
      [`GET /v1/payments/${PAY}`]: { body: payment() },
      [`GET /v1/payments/${PAY}/link`]: {
        body: { link: 'https://pay.provider.example/x', expiresAt: '2026-10-18T18:30:00+05:30' },
      },
    });
    expect((await payments.paymentOptions(LOAN)).ok).toBe(true);
    expect((await payments.payment(PAY)).ok).toBe(true);
    const link = await payments.paymentLink(PAY);
    expect(link.ok && link.data.link).toBe('https://pay.provider.example/x');
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET /v1/loans/${LOAN}/payment-options`,
      `GET /v1/payments/${PAY}`,
      `GET /v1/payments/${PAY}/link`,
    ]);
    expect(calls.every((c) => c.headers.authorization === 'Bearer tok')).toBe(true);
  });

  it('does not fetch the link unless asked: reading the payment never touches the link route', async () => {
    const { payments, calls } = setup({ [`GET /v1/payments/${PAY}`]: { body: payment() } });
    await payments.payment(PAY);
    expect(calls.some((c) => c.url.endsWith('/link'))).toBe(false);
  });

  it('sends a payment request with the idempotency key and the exact body', async () => {
    const { payments, calls } = setup({
      [`POST /v1/loans/${LOAN}/payments`]: { status: 201, body: payment({ status: 'created' }) },
    });
    const r = await payments.requestPayment(
      LOAN,
      { purpose: 'foreclosure', amountMinor: 18_765_432, quoteId: QUOTE },
      'a-key-three-1234567890',
    );
    expect(r.ok).toBe(true);
    expect(calls[0]?.headers['idempotency-key']).toBe('a-key-three-1234567890');
    expect(calls[0]?.body).toEqual({
      purpose: 'foreclosure',
      amountMinor: 18_765_432,
      quoteId: QUOTE,
    });
  });

  it('refuses on the device a request the contract would refuse, and makes no call', async () => {
    const { payments, calls } = setup({});
    for (const body of [
      { purpose: 'installment', amountMinor: 0.5 },
      { purpose: 'installment', amountMinor: 0 },
      { purpose: 'installment', amountMinor: -100 },
      { purpose: 'rent', amountMinor: 100 },
      { purpose: 'installment', amountMinor: 100, accountNumber: '123456789012' },
    ]) {
      const r = await payments.requestPayment(LOAN, body as never, 'a-key-four-1234567890');
      expect(r).toEqual({ ok: false, status: 0, code: CLIENT_REFUSAL });
    }
    expect(calls).toEqual([]);
  });

  it('returns a stable code, never server text, when the API refuses', async () => {
    const { payments } = setup({
      [`POST /v1/loans/${LOAN}/payments`]: {
        status: 409,
        body: {
          code: 'stale_data',
          title: 'Conflict',
          detail: 'server words that must not be shown',
        },
      },
    });
    const r = await payments.requestPayment(
      LOAN,
      { purpose: 'installment', amountMinor: 100 },
      'a-key-five-1234567890',
    );
    expect(r).toEqual({ ok: false, status: 409, code: 'stale_data' });
  });

  it('treats an answer that does not match the contract as a bad response', async () => {
    const { payments } = setup({
      [`GET /v1/payments/${PAY}`]: { body: { ...payment(), stage: 'paid_in_full' } },
    });
    expect(await payments.payment(PAY)).toEqual({ ok: false, status: 200, code: 'bad_response' });
  });

  it('cancels with a key and an empty body', async () => {
    const { payments, calls } = setup({
      [`POST /v1/payments/${PAY}/cancel`]: { body: { id: PAY, status: 'cancelled' } },
    });
    const r = await payments.cancelPayment(PAY);
    expect(r.ok && r.data.status).toBe('cancelled');
    expect(calls[0]?.headers['idempotency-key']).toMatch(/^[A-Za-z0-9._:-]{16,128}$/);
    expect(calls[0]?.body).toEqual({});
  });
});

describe('mandate client', () => {
  const body = {
    mandateId: MANDATE,
    rail: 'enach_api',
    startDate: '2026-11-01',
    endDate: '2027-10-31',
    maskedAccountRef: 'XXXXXX1234',
  } as const;

  it('reads options, the list, one mandate, its debits and its link from the right paths', async () => {
    const { mandates, calls } = setup({
      [`GET /v1/loans/${LOAN}/mandate-options`]: { body: mandateOptions() },
      'GET /v1/mandates': { body: { items: [mandate()] } },
      [`GET /v1/mandates/${MANDATE}`]: { body: mandate() },
      [`GET /v1/mandates/${MANDATE}/debits`]: { body: { items: [debit()] } },
      [`GET /v1/mandates/${MANDATE}/link`]: {
        body: { link: 'https://bank.example/authorise', expiresAt: '2026-10-18T18:30:00+05:30' },
      },
    });
    expect((await mandates.mandateOptions(LOAN)).ok).toBe(true);
    expect((await mandates.mandates()).ok).toBe(true);
    expect((await mandates.mandate(MANDATE)).ok).toBe(true);
    expect((await mandates.debits(MANDATE)).ok).toBe(true);
    expect((await mandates.mandateLink(MANDATE)).ok).toBe(true);
    expect(calls).toHaveLength(5);
  });

  it('creates a mandate with the app chosen id, the masked reference and a key', async () => {
    const { mandates, calls } = setup({
      [`POST /v1/loans/${LOAN}/mandates`]: { status: 201, body: mandate({ status: 'draft' }) },
    });
    const r = await mandates.requestMandate(LOAN, body, 'a-key-six-1234567890');
    expect(r.ok).toBe(true);
    expect(calls[0]?.body).toEqual(body);
    expect(calls[0]?.headers['idempotency-key']).toBe('a-key-six-1234567890');
  });

  it('refuses on the device a request that carries a full account number, and makes no call', async () => {
    const { mandates, calls } = setup({});
    for (const maskedAccountRef of [
      '123456789012',
      '1234567890123456',
      'XXXXXX123456',
      '1234',
      '',
    ]) {
      const r = await mandates.requestMandate(
        LOAN,
        { ...body, maskedAccountRef },
        'a-key-seven-1234567890',
      );
      expect(r, maskedAccountRef).toEqual({ ok: false, status: 0, code: CLIENT_REFUSAL });
    }
    const extra = await mandates.requestMandate(
      LOAN,
      { ...body, accountNumber: '123456789012' } as never,
      'a-key-seven-1234567890',
    );
    expect(extra.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it('maps a refused step-up to the stable code', async () => {
    const { mandates } = setup({
      [`POST /v1/loans/${LOAN}/mandates`]: { status: 403, body: { code: 'stepup_required' } },
    });
    const r = await mandates.requestMandate(LOAN, body, 'a-key-eight-1234567890');
    expect(r).toEqual({ ok: false, status: 403, code: 'stepup_required' });
  });

  it('asks for cancellation with a key and an empty body, and treats it as a request', async () => {
    const { mandates, calls } = setup({
      [`POST /v1/mandates/${MANDATE}/cancel`]: {
        status: 202,
        body: { id: MANDATE, result: 'cancel_requested' },
      },
    });
    const r = await mandates.requestCancellation(MANDATE);
    expect(r.ok && r.data.result).toBe('cancel_requested');
    expect(calls[0]?.body).toEqual({});
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Wording, catalogue and the source of the screens
// ---------------------------------------------------------------------------------------------------------------
describe('payments and mandates wording', () => {
  const keys = Object.keys(enPayments) as (keyof typeof enPayments)[];

  it('has Hindi for every key, the same placeholders, and keys only in its own namespaces', () => {
    expect(Object.keys(hiPayments).sort()).toEqual([...keys].sort());
    for (const key of keys) {
      expect(key.startsWith('pay.') || key.startsWith('mandate.'), key).toBe(true);
      expect(hi[key as MessageKey], key).toBe(hiPayments[key]);
      expect(en[key as MessageKey], key).toBe(enPayments[key]);
    }
  });

  it('stays calm: no urgency, countdown, offer, guarantee, compliance or safety claim', () => {
    const banned =
      /\b(hurry|last chance|act now|limited time|countdown|don't miss|urgent|urgently|immediately|congratulations|guaranteed|compliant|compliance|RBI|regulatory|approved by|safe|secure|secured|best rate|offer(ed)? for you)\b/i;
    for (const key of keys) expect(enPayments[key], key).not.toMatch(banned);
  });

  it('never says paid or successful about a stage, status or link', () => {
    for (const key of keys) {
      if (
        /^pay\.(stage|explain|status|link|wait)\./.test(key) ||
        /^mandate\.(status|explain|link|wait)\./.test(key)
      ) {
        expect(enPayments[key], key).not.toMatch(/\bpaid\b|success/i);
      }
    }
  });

  it('says whose figure it is and never shows a countdown', () => {
    expect(enPayments['pay.reportedAsOf']).toContain('As reported by {lender}');
    expect(enPayments['pay.withheld']).toContain('is checking these figures');
    expect(enPayments['pay.quote.validUntil']).toContain('valid until {date}');
  });

  it('writes every string without a long digit run when rendered with fixed values', () => {
    const view = payOptionsView(
      options({ purposes: [installment, overdue, prepay, foreclosure] }),
      enCtx,
    );
    const rendered =
      JSON.stringify(view) +
      JSON.stringify(mandateView(mandate(), { linkOpened: false, pollStopped: false }, enCtx));
    const stripped = rendered.replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      '',
    );
    expect(stripped).not.toMatch(/\d{9,}/);
  });

  it('translates a sentence with its values in both languages', () => {
    const langs: Language[] = ['en', 'hi'];
    for (const language of langs) {
      const said = translate(language, 'pay.stage.lender_posted', { lender: LENDER });
      expect(said).toContain(LENDER);
      expect(said).not.toContain('{');
    }
  });
});

describe('what the screens may do (source checks)', () => {
  const root = join(import.meta.dirname, '..');
  const read = (file: string) => readFileSync(join(root, file), 'utf8');
  const screens = ['pay', 'status', 'mandate-setup', 'mandate', 'index'].map(
    (n) => `app/(app)/payments/${n}.tsx`,
  );
  const sources = [
    ...screens,
    'src/borrower/payments.ts',
    'src/borrower/mandates.ts',
    'src/borrower/payments-handoff.ts',
    'src/borrower/payments-view.ts',
    'src/borrower/mandates-view.ts',
    'src/borrower/usePayments.ts',
  ];
  const code = (file: string) =>
    read(file)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

  it('does not log, copy, share or store anything', () => {
    const forbidden =
      /console\.|Clipboard|expo-clipboard|Sharing|Share\.share|AsyncStorage|SecureStore|localStorage|setItem\(|analytics|track\(|sentry/i;
    for (const file of sources) expect(code(file), file).not.toMatch(forbidden);
  });

  it('uses the system browser through react-native and no web-browser package', () => {
    for (const file of sources)
      expect(code(file), file).not.toMatch(/expo-web-browser|react-native-webview/);
    expect(code('app/(app)/payments/status.tsx')).toMatch(
      /import \{ Linking \} from 'react-native'/,
    );
    expect(code('app/(app)/payments/mandate.tsx')).toMatch(
      /import \{ Linking \} from 'react-native'/,
    );
  });

  it('fetches a hand-off link only inside the tap handler and passes it only to the opener', () => {
    for (const [file, call] of [
      ['app/(app)/payments/status.tsx', 'client.paymentLink('],
      ['app/(app)/payments/mandate.tsx', 'client.mandateLink('],
    ] as const) {
      const src = code(file);
      expect(src.split(call).length - 1, `${file} calls`).toBe(1);
      const handler = src.indexOf('async function continueToProvider');
      expect(handler).toBeGreaterThan(-1);
      expect(src.indexOf(call)).toBeGreaterThan(handler);
      // Every use of the link value is the argument of openHandoff.
      const uses = src.match(/\.data\.link/g) ?? [];
      expect(uses).toHaveLength(1);
      expect(src).toContain('openHandoff(result.data.link,');
      // The link is not state and not a navigation parameter.
      expect(src).not.toMatch(/const \[[^\]]*link[^\]]*\] = useState/i);
      expect(src).not.toMatch(/set[A-Z]?[A-Za-z]*Link\(/);
      expect(src).not.toMatch(/params:\s*\{[^}]*link/i);
    }
    // No other screen asks for a link at all.
    for (const file of screens.filter((f) => !/status\.tsx|mandate\.tsx/.test(f))) {
      expect(code(file), file).not.toMatch(/paymentLink|mandateLink/);
    }
  });

  it('keeps the account field to four digits and sends only what resolveMandateRequest built', () => {
    const src = code('app/(app)/payments/mandate-setup.tsx');
    expect(src).toMatch(/maxLength=\{4\}/);
    expect(src).toMatch(/keyboardType="number-pad"/);
    expect(src).toContain('client.requestMandate(loanId, resolution.body, key)');
    expect(src).toContain("action: 'mandate_creation'");
    expect(src).toContain('contextRef: mandateId');
    expect(src).toContain('usePreventScreenCapture()');
  });

  it('starts with nothing selected and posts only the resolved request', () => {
    const src = code('app/(app)/payments/pay.tsx');
    expect(src).toContain('useReducer(payDraftReducer, undefined, emptyPayDraft)');
    expect(src).toContain('client.requestPayment(loanId, resolution.request, key)');
    expect(src).not.toMatch(/purpose:\s*'(installment|overdue|foreclosure|part_prepayment)'/);
  });

  it('draws the penal sentence from the view only, with no wording of its own about charges', () => {
    const src = code('app/(app)/payments/pay.tsx');
    expect(src).toContain('{o.penal.sentence}');
    expect(src).not.toMatch(/penalChargeTextMissing/);
    expect(src).not.toMatch(/t\('pay\.penal\.[a-z]+'\)/i);
  });

  it('shows a cancel button only from the API flag and a cancellation request only from the status table', () => {
    expect(code('app/(app)/payments/status.tsx')).toContain('view.cancellable ?');
    expect(code('app/(app)/payments/mandate.tsx')).toContain('view.canCancel ?');
  });
});
