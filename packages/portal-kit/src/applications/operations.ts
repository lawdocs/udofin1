import { CHECK_KINDS, CHECK_STATUSES, LENDER_DECISIONS } from '@udofin/contracts';
import { z } from 'zod';
import { type Operation } from '../onboarding/operations.js';

/**
 * Lender application forms. Each form becomes one API call whose body the API validates strictly
 * again. Udofin never decides: these forms only record what the lender reports.
 */
const UUID = /^[0-9a-f-]{36}$/;
const lenderOnly = ['lender'] as const;
const anyUnknown = z.unknown();
const invalid = { ok: false as const, status: 422, code: 'validation_failed' };

const str = (form: FormData, name: string): string | undefined => {
  const v = form.get(name);
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
};
const int = (form: FormData, name: string): number | undefined => {
  const v = str(form, name);
  return v !== undefined && /^\d{1,15}$/.test(v) ? Number(v) : undefined;
};
const oneOf = <T extends string>(value: string | undefined, allowed: readonly T[]) =>
  allowed.find((a) => a === value);
/** A datetime-local value is read as India time, as shown to the lender, and sent with its offset. */
const istInstant = (value: string | undefined): string | undefined =>
  value && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) ? `${value}:00+05:30` : undefined;

type Call = (
  api: Parameters<Operation['run']>[0],
  id: string,
  form: FormData,
  key: string,
) => ReturnType<Operation['run']>;

const forApplication = (call: Call): Operation => ({
  portals: lenderOnly,
  run: (api, form, key) => {
    const id = str(form, 'id');
    if (!id || !UUID.test(id)) return Promise.resolve(invalid);
    return call(api, id, form, key);
  },
});

export const APPLICATION_OPERATIONS: Readonly<Record<string, Operation>> = {
  'application.ack': forApplication((api, id, form, key) =>
    api.post(
      `/v1/lender/applications/${id}/acknowledge`,
      anyUnknown,
      {
        ...(str(form, 'lenderApplicationRef')
          ? { lenderApplicationRef: str(form, 'lenderApplicationRef') }
          : {}),
      },
      key,
    ),
  ),
  'application.check': forApplication((api, id, form, key) => {
    const kind = oneOf(str(form, 'kind'), CHECK_KINDS);
    const status = oneOf(str(form, 'status'), CHECK_STATUSES);
    if (!kind || !status) return Promise.resolve(invalid);
    return api.post(`/v1/lender/applications/${id}/checks`, anyUnknown, { kind, status }, key);
  }),
  'application.decision': forApplication((api, id, form, key) => {
    const decision = oneOf(str(form, 'decision'), LENDER_DECISIONS);
    if (!decision) return Promise.resolve(invalid);
    return api.post(`/v1/lender/applications/${id}/decision`, anyUnknown, { decision }, key);
  }),
  'application.offer': forApplication((api, id, form, key) => {
    const ref = str(form, 'lenderOfferRef');
    const issuedAt = istInstant(str(form, 'issuedAt'));
    const validUntil = istInstant(str(form, 'validUntil'));
    const frequency = oneOf(str(form, 'installmentFrequency'), [
      'monthly',
      'fortnightly',
      'weekly',
    ] as const);
    const numbers = {
      principalMinor: int(form, 'principalMinor'),
      tenureDays: int(form, 'tenureDays'),
      installmentCount: int(form, 'installmentCount'),
      installmentAmountMinor: int(form, 'installmentAmountMinor'),
      monthlyRepaymentMinor: int(form, 'monthlyRepaymentMinor'),
      annualInterestRateBps: int(form, 'annualInterestRateBps'),
      aprBps: int(form, 'aprBps'),
      processingFeeMinor: int(form, 'processingFeeMinor'),
      totalRepayableMinor: int(form, 'totalRepayableMinor'),
    };
    const penal = str(form, 'penalChargesSummary');
    const kfsUrl = str(form, 'kfsUrl');
    if (
      !ref ||
      !issuedAt ||
      !validUntil ||
      !frequency ||
      !penal ||
      !kfsUrl ||
      Object.values(numbers).some((n) => n === undefined)
    )
      return Promise.resolve(invalid);
    // Values go to the API exactly as typed; nothing is calculated or rounded here.
    return api.post(
      `/v1/lender/applications/${id}/offers`,
      anyUnknown,
      {
        lenderOfferRef: ref,
        ...numbers,
        installmentFrequency: frequency,
        otherCharges: [],
        penalChargesSummary: penal,
        kfsUrl,
        issuedAt,
        validUntil,
      },
      key,
    );
  }),
  'application.offer_withdraw': forApplication((api, id, form, key) => {
    const ref = str(form, 'lenderOfferRef');
    if (!ref) return Promise.resolve(invalid);
    return api.post(
      `/v1/lender/applications/${id}/offers/withdraw`,
      anyUnknown,
      { lenderOfferRef: ref },
      key,
    );
  }),
};
