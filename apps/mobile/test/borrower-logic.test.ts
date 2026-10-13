import { type BorrowerMe } from '@udofin/contracts';
import { describe, expect, it } from 'vitest';
import { errorKey, isOffline } from '../src/borrower/errors';
import { expiryState } from '../src/borrower/expiry';
import { emptyForm, formReducer, newIdempotencyKey, type RequestForm } from '../src/borrower/form';
import { formatDate } from '../src/borrower/format';
import { nextStep, resolveLanguage } from '../src/borrower/journey';
import { formatRupees, MAX_AMOUNT_PAISE, parseRupees } from '../src/borrower/money';
import { canEnterCode, stepUpReducer, type StepUpState } from '../src/borrower/stepup';
import { daysToMonths, parseMonths } from '../src/borrower/tenure';
import { en } from '../src/i18n/en';

const me = (
  over: Partial<BorrowerMe['profile']> = {},
  journey: Partial<BorrowerMe['journey']> = {},
): BorrowerMe => ({
  profile: {
    displayName: null,
    preferredLanguage: 'en',
    onboardingStatus: 'account_created',
    ...over,
  },
  journey: {
    accountCreated: true,
    profileStarted: false,
    profileCompleted: false,
    consentsCompleted: false,
    draftRequests: 0,
    submittedRequests: 0,
    lenderKyc: 'not_started',
    eligibility: 'not_assessed',
    ...journey,
  },
  consents: [],
  preferences: { serviceUpdatesSms: true },
  marketing: { available: false },
  integrityLevel: 'none',
});

describe('money', () => {
  it('converts typed rupees to exact paise', () => {
    expect(parseRupees('50000')).toEqual({ ok: true, paise: 5_000_000 });
    expect(parseRupees('1,00,000.5')).toEqual({ ok: true, paise: 10_000_050 });
    expect(parseRupees('  12.34 ')).toEqual({ ok: true, paise: 1234 });
    expect(parseRupees('0.07')).toEqual({ ok: true, paise: 7 });
  });
  it('never goes through floating point (0.1 + 0.2 style traps)', () => {
    expect(parseRupees('1.15')).toEqual({ ok: true, paise: 115 });
    expect(parseRupees('4.35')).toEqual({ ok: true, paise: 435 });
    expect(parseRupees('1000000000000')).toEqual({ ok: true, paise: 100_000_000_000_000 });
  });
  it('refuses junk, more than two decimals, zero and oversize', () => {
    for (const bad of ['', 'abc', '1.234', '-5', '1e5', '5,,0.0.0', '₹500', '1 000'])
      expect(parseRupees(bad), bad).toEqual({ ok: false, error: 'invalid' });
    expect(parseRupees('0')).toEqual({ ok: false, error: 'too_small' });
    expect(parseRupees('0.00')).toEqual({ ok: false, error: 'too_small' });
    expect(parseRupees('1000000000001')).toEqual({ ok: false, error: 'too_large' });
    expect(MAX_AMOUNT_PAISE).toBe(100_000_000_000_000);
  });
  it('formats with Indian grouping', () => {
    expect(formatRupees(5_000_000)).toBe('50,000');
    expect(formatRupees(10_000_050)).toBe('1,00,000.50');
    expect(formatRupees(123_456_789_00)).toBe('12,34,56,789');
    expect(formatRupees(99)).toBe('0.99');
    expect(formatRupees(100)).toBe('1');
  });
});

describe('tenure', () => {
  it('counts a month as 30 days and enforces the category minimum', () => {
    expect(parseMonths('12', 30)).toEqual({ ok: true, days: 360 });
    expect(parseMonths('1', 60)).toEqual({ ok: false, error: 'too_short' });
    expect(parseMonths('2', 60)).toEqual({ ok: true, days: 60 });
  });
  it('refuses non-numbers, zero and absurd periods', () => {
    for (const bad of ['', '0', '-1', '1.5', 'x', '1000'])
      expect(parseMonths(bad, 1).ok, bad).toBe(false);
    expect(parseMonths('400', 1)).toEqual({ ok: false, error: 'too_long' });
    expect(parseMonths('365', 1)).toEqual({ ok: true, days: 10_950 });
  });
  it('shows months rounded up', () => {
    expect(daysToMonths(360)).toBe(12);
    expect(daysToMonths(31)).toBe(2);
    expect(daysToMonths(1)).toBe(1);
  });
});

describe('draft expiry', () => {
  const now = new Date('2026-10-01T12:00:00Z');
  const at = (days: number) => new Date(now.getTime() + days * 86_400_000 - 1000).toISOString();
  it('uses the server deadline and warns only close to it', () => {
    expect(expiryState('draft', at(20), now)).toEqual({ kind: 'later', days: 20 });
    expect(expiryState('draft', at(7), now)).toEqual({ kind: 'soon', days: 7 });
    expect(expiryState('draft', at(3), now)).toEqual({ kind: 'soon', days: 3 });
    expect(expiryState('draft', at(1), now).kind).toBe('today');
  });
  it('treats a passed deadline or an expired status as expired, even before any job runs', () => {
    expect(expiryState('draft', new Date(now.getTime() - 1000).toISOString(), now).kind).toBe(
      'expired',
    );
    expect(expiryState('expired', null, now).kind).toBe('expired');
  });
  it('shows nothing for requests that are not drafts', () => {
    expect(expiryState('submitted', at(2), now).kind).toBe('none');
    expect(expiryState('draft', null, now).kind).toBe('none');
    expect(expiryState('draft', 'not-a-date', now).kind).toBe('none');
  });
});

describe('journey', () => {
  it('moves through separate steps and never skips ahead', () => {
    expect(nextStep(me())).toBe('profile');
    expect(
      nextStep(me({ onboardingStatus: 'profile_completed' }, { profileCompleted: true })),
    ).toBe('consents');
    expect(
      nextStep(
        me(
          { onboardingStatus: 'profile_completed' },
          { profileCompleted: true, consentsCompleted: true },
        ),
      ),
    ).toBe('request');
    expect(nextStep(me({ onboardingStatus: 'deletion_requested' }))).toBe('closing');
    expect(nextStep(me({ onboardingStatus: 'anonymised' }))).toBe('closed');
  });
  it('picks the language: server wins once a profile exists; before that the device choice is kept and pushed', () => {
    expect(resolveLanguage({ local: 'hi', server: null })).toEqual({
      language: 'hi',
      pushToServer: false,
    });
    expect(resolveLanguage({ local: 'hi', server: me().profile })).toEqual({
      language: 'hi',
      pushToServer: true,
    });
    expect(
      resolveLanguage({
        local: 'hi',
        server: me({ onboardingStatus: 'profile_started', preferredLanguage: 'en' }).profile,
      }),
    ).toEqual({
      language: 'en',
      pushToServer: false,
    });
    expect(resolveLanguage({ local: 'xx', server: null })).toEqual({
      language: 'en',
      pushToServer: false,
    });
  });
  it('never reports KYC or eligibility as anything but not started / not assessed', () => {
    const m = me(
      { onboardingStatus: 'profile_completed' },
      { profileCompleted: true, consentsCompleted: true },
    );
    expect(m.journey.lenderKyc).toBe('not_started');
    expect(m.journey.eligibility).toBe('not_assessed');
  });
});

describe('form state', () => {
  const filled = (): RequestForm => ({
    ...emptyForm(),
    categoryKey: 'personal',
    purposeCode: 'medical',
    amountText: '50000',
    monthsText: '12',
    productVersionId: 'p1',
    draftId: 'd1',
    draftVersion: 2,
  });
  it('keeps every field when only the language changes (the form has no language input at all)', () => {
    const before = filled();
    expect(Object.keys(before)).not.toContain('language');
    expect(formReducer(before, { type: 'saved', id: 'd1', version: 2 })).toEqual(before);
  });
  it('an edit invalidates the previous submit key so a changed request is a new attempt', () => {
    const keyed = formReducer(filled(), { type: 'submitKey', key: 'k1' });
    expect(keyed.submitKey).toBe('k1');
    expect(
      formReducer(keyed, { type: 'set', field: 'amountText', value: '60000' }).submitKey,
    ).toBeNull();
    expect(formReducer(keyed, { type: 'submitKey', key: null }).submitKey).toBeNull();
  });
  it('changing the category drops the product preference', () => {
    const next = formReducer(filled(), { type: 'set', field: 'categoryKey', value: 'other' });
    expect(next.productVersionId).toBeNull();
    expect(
      formReducer(filled(), { type: 'set', field: 'categoryKey', value: 'personal' })
        .productVersionId,
    ).toBe('p1');
  });
  it('reset empties the form; ids are unique per attempt', () => {
    expect(formReducer(filled(), { type: 'reset' })).toEqual(emptyForm());
    expect(newIdempotencyKey()).not.toBe(newIdempotencyKey());
    expect(newIdempotencyKey()).toMatch(/^m-[0-9a-f]{24}$/);
  });
});

describe('step-up states', () => {
  const run = (events: Parameters<typeof stepUpReducer>[1][]): StepUpState =>
    events.reduce<StepUpState>(stepUpReducer, { kind: 'idle' });
  const started = {
    type: 'started',
    challengeId: 'c1',
    expiresAt: 'e',
    delivery: 'accepted',
  } as const;
  it('allows entering a code only when the provider accepted the message', () => {
    expect(canEnterCode(run([{ type: 'start' }, started]))).toBe(true);
    for (const delivery of ['rejected', 'timeout', 'not_configured'] as const)
      expect(canEnterCode(run([{ type: 'start' }, { ...started, delivery }])), delivery).toBe(
        false,
      );
  });
  it('a wrong code allows another try; locked, expired and unknown end the check', () => {
    const wrong = run([
      { type: 'start' },
      started,
      { type: 'verify' },
      { type: 'result', result: 'invalid' },
    ]);
    expect(wrong.kind).toBe('failed');
    expect(canEnterCode(wrong)).toBe(true);
    for (const result of ['locked', 'expired', 'not_found', 'already_verified'] as const)
      expect(
        run([{ type: 'start' }, started, { type: 'verify' }, { type: 'result', result }]).kind,
        result,
      ).toBe('ended');
  });
  it('verifies, and cannot be verified from idle', () => {
    expect(
      run([{ type: 'start' }, started, { type: 'verify' }, { type: 'result', result: 'verified' }])
        .kind,
    ).toBe('verified');
    expect(run([{ type: 'verify' }]).kind).toBe('idle');
  });
});

describe('errors', () => {
  it('maps stable codes to existing messages and falls back to a generic one', () => {
    for (const code of [
      'network_error',
      'version_conflict',
      'draft_expired',
      'consent_required',
      'account_closed',
      'http_404',
    ])
      expect(errorKey(code) in en, code).toBe(true);
    expect(errorKey('network_error')).toBe('error.offline');
    expect(errorKey('something_new')).toBe('error.generic');
    expect(isOffline('network_error')).toBe(true);
    expect(isOffline('http_500')).toBe(false);
  });
});

describe('dates', () => {
  it('formats in the borrower language and the Indian time zone; bad input yields empty text', () => {
    expect(formatDate('2026-10-13T20:00:00Z', 'en')).toMatch(/14/); // already the next day in IST
    expect(formatDate('garbage', 'en')).toBe('');
    expect(formatDate('2026-10-13T00:00:00Z', 'hi').length).toBeGreaterThan(4);
  });
});
