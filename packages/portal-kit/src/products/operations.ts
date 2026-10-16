import { z } from 'zod';
import { type Operation } from '../onboarding/operations.js';
import { type OnboardingApi } from '../onboarding/api.js';

/**
 * Product configuration forms. A form is turned into the same JSON the API validates strictly; the
 * API is the authority. Numbers are integer paise / basis points / days. An "advanced JSON" box lets a
 * lender supply any configuration the structured fields do not cover, and replaces the structured part.
 */
const UUID = /^[0-9a-f-]{36}$/;
const str = (form: FormData, name: string): string | undefined => {
  const v = form.get(name);
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
};
const int = (form: FormData, name: string): number | undefined => {
  const v = str(form, name);
  return v !== undefined && /^-?\d{1,15}$/.test(v) ? Number(v) : undefined;
};
const checked = (form: FormData, name: string) => form.get(name) === 'on';
const many = (form: FormData, name: string) =>
  form.getAll(name).filter((v): v is string => typeof v === 'string');
const MAX_ROWS = 8;
const anyUnknown = z.unknown();

function scalarList(raw: string): (string | number)[] {
  return raw
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => (/^-?\d{1,15}$/.test(x) ? Number(x) : x));
}

export function buildVersionBody(form: FormData): { ok: true; body: unknown } | { ok: false } {
  const terms = {
    minAmountMinor: int(form, 'minAmountMinor'),
    maxAmountMinor: int(form, 'maxAmountMinor'),
    minTenureDays: int(form, 'minTenureDays'),
    maxTenureDays: int(form, 'maxTenureDays'),
    rateType: str(form, 'rateType'),
    minAnnualRateBps: int(form, 'minAnnualRateBps'),
    maxAnnualRateBps: int(form, 'maxAnnualRateBps'),
  };
  const advanced = str(form, 'advancedJson');
  if (advanced !== undefined) {
    try {
      const parsed: unknown = JSON.parse(advanced);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
        return { ok: false };
      return { ok: true, body: { terms, config: parsed } };
    } catch {
      return { ok: false };
    }
  }

  const rows = <T>(read: (i: number) => T | undefined): T[] => {
    const out: T[] = [];
    for (let i = 0; i < MAX_ROWS; i += 1) {
      const r = read(i);
      if (r !== undefined) out.push(r);
    }
    return out;
  };
  const fees = rows((i) => {
    const code = str(form, `fee_${String(i)}_code`);
    if (!code) return undefined;
    return {
      code,
      label: str(form, `fee_${String(i)}_label`) ?? code,
      kind: str(form, `fee_${String(i)}_kind`),
      amountMinor: int(form, `fee_${String(i)}_amountMinor`),
      rateBps: int(form, `fee_${String(i)}_rateBps`),
      taxIncluded: checked(form, `fee_${String(i)}_taxIncluded`),
      timing: str(form, `fee_${String(i)}_timing`),
      refundable: checked(form, `fee_${String(i)}_refundable`),
    };
  });
  const ruleRows = rows((i) => {
    const field = str(form, `elig_${String(i)}_field`);
    const operator = str(form, `elig_${String(i)}_operator`);
    const raw = str(form, `elig_${String(i)}_value`);
    if (!field || !operator || raw === undefined) return undefined;
    const list = scalarList(raw);
    const value =
      operator === 'in' || operator === 'not_in' || operator === 'between' ? list : list[0];
    return { field, operator, value };
  });
  const documents = rows((i) => {
    const code = str(form, `doc_${String(i)}_code`);
    if (!code) return undefined;
    return {
      code,
      label: str(form, `doc_${String(i)}_label`) ?? code,
      mandatory: checked(form, `doc_${String(i)}_mandatory`),
      acceptedMimeTypes: [str(form, `doc_${String(i)}_mime`) ?? 'application/pdf'],
    };
  });
  const attributes: Record<string, string | number | boolean> = {};
  for (let i = 0; i < MAX_ROWS; i += 1) {
    const key = str(form, `attr_${String(i)}_key`);
    const value = str(form, `attr_${String(i)}_value`);
    if (key && value !== undefined)
      attributes[key] = /^-?\d{1,15}$/.test(value)
        ? Number(value)
        : value === 'true'
          ? true
          : value === 'false'
            ? false
            : value;
  }
  const frequencies = many(form, 'repay_frequencies');
  const methods = many(form, 'repay_methods');
  const penalKind = str(form, 'penal_kind');
  const marketingName = str(form, 'marketingName');
  const shortDescription = str(form, 'shortDescription');
  const config: Record<string, unknown> = {
    fees,
    documents,
    attributes,
    ...(marketingName || shortDescription
      ? {
          display: {
            ...(marketingName ? { marketingName } : {}),
            ...(shortDescription ? { shortDescription } : {}),
          },
        }
      : {}),
    ...(ruleRows.length > 0
      ? { eligibility: { match: str(form, 'elig_match') ?? 'all', rules: ruleRows } }
      : {}),
    ...(frequencies.length > 0 && methods.length > 0
      ? {
          repayment: {
            frequencies,
            methods,
            installmentType: str(form, 'installmentType') ?? 'equated',
            gracePeriodDays: int(form, 'repay_grace') ?? 0,
            moratoriumDays: int(form, 'repay_moratorium') ?? 0,
          },
        }
      : {}),
    ...(form.has('prepay_present')
      ? {
          prepayment: {
            allowed: checked(form, 'prepay_allowed'),
            partPrepaymentAllowed: checked(form, 'prepay_part'),
            lockInDays: int(form, 'prepay_lockin') ?? 0,
            ...(str(form, 'prepay_charge') ? { chargeSummary: str(form, 'prepay_charge') } : {}),
          },
        }
      : {}),
    ...(penalKind
      ? {
          penalCharges: {
            kind: penalKind,
            ...(int(form, 'penal_amount') !== undefined
              ? { amountMinor: int(form, 'penal_amount') }
              : {}),
            ...(int(form, 'penal_rate') !== undefined ? { rateBps: int(form, 'penal_rate') } : {}),
            gracePeriodDays: int(form, 'penal_grace') ?? 0,
            summary: str(form, 'penal_summary') ?? "As per the lender's schedule of charges",
          },
        }
      : {}),
    channels: ['mobile_app'],
  };
  return { ok: true, body: { terms, config } };
}

const invalid = { ok: false as const, status: 422, code: 'validation_failed' };
const lenderOnly = ['lender'] as const;
const bothPortals = ['ops', 'lender'] as const;

function versionOp(kind: 'create' | 'edit'): Operation {
  return {
    portals: lenderOnly,
    run: async (api: OnboardingApi, form, key) => {
      const id = str(form, 'id');
      if (!id || !UUID.test(id)) return invalid;
      const built = buildVersionBody(form);
      if (!built.ok) return invalid;
      const path =
        kind === 'create'
          ? `/v1/lender/products/${id}/versions`
          : `/v1/lender/product-versions/${id}/draft`;
      return api.post(path, anyUnknown, built.body, key);
    },
  };
}
const simple = (
  path: (id: string) => string,
  body: (form: FormData) => unknown = () => ({}),
  portals: Operation['portals'] = lenderOnly,
): Operation => ({
  portals,
  run: (api, form, key) => {
    const id = str(form, 'id');
    if (!id || !UUID.test(id)) return Promise.resolve(invalid);
    return api.post(path(id), anyUnknown, body(form), key);
  },
});

export const PRODUCT_OPERATIONS: Readonly<Record<string, Operation>> = {
  'product.create': {
    portals: lenderOnly,
    run: (api, form, key) => {
      const lenderId = str(form, 'lenderId');
      const categoryKey = str(form, 'categoryKey');
      const code = str(form, 'code');
      const name = str(form, 'name');
      if (!lenderId || !UUID.test(lenderId) || !categoryKey || !code || !name)
        return Promise.resolve(invalid);
      return api.post(
        '/v1/lender/products',
        anyUnknown,
        { lenderId, categoryKey, code, name },
        key,
      );
    },
  },
  'product.status': simple(
    (id) => `/v1/lender/products/${id}/status`,
    (f) => ({ to: str(f, 'to') }),
  ),
  'product.version.create': versionOp('create'),
  'product.version.edit': versionOp('edit'),
  'product.version.submit': simple((id) => `/v1/lender/product-versions/${id}/submit`),
  'product.version.decide': simple(
    (id) => `/v1/lender/product-versions/${id}/decision`,
    (f) => ({
      approve: str(f, 'approve') === 'true',
      ...(str(f, 'note') ? { note: str(f, 'note') } : {}),
    }),
  ),
  'product.version.retire': simple((id) => `/v1/lender/product-versions/${id}/retire`),
  'panel.view.save': {
    portals: bothPortals,
    run: (api, form, key) => {
      const lenderId = str(form, 'lenderId');
      const name = str(form, 'name');
      const raw = str(form, 'config');
      if (!lenderId || !UUID.test(lenderId) || !name || !raw) return Promise.resolve(invalid);
      try {
        const config: unknown = JSON.parse(raw);
        return api.post(
          '/v1/lender/panel-views',
          anyUnknown,
          { lenderId, name, shared: checked(form, 'shared'), config },
          key,
        );
      } catch {
        return Promise.resolve(invalid);
      }
    },
  },
  'panel.view.archive': simple(
    (id) => `/v1/lender/panel-views/${id}`,
    () => ({ archive: true }),
    bothPortals,
  ),
};
