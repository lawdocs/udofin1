import {
  AccountsNote,
  AccountsReason,
  MerchantClaimInput,
  PaymentConfigDraftInput,
  PaymentConfigDrafted,
  PaymentConfigMode,
  SettlementAccountRequestInput,
} from '@udofin/contracts';
import { z } from 'zod';
import { type OnboardingApi } from '../onboarding/api.js';
import { parseRupeesToPaise } from '../servicing/format.js';
import { safeErrorCode } from '../servicing/wording.js';
import { RAIL_LIMIT_ROWS, type DraftedConfig } from './types.js';
import { looksLikeAccountDetail, looksLikeSecretValue } from './wording.js';

export type { DraftedConfig };

/**
 * The only writes the lender payment-setup screens can make. A form names one operation; this table maps it to exactly one API
 * route with the fields checked again here (with the same shape rules the API uses, taken from the contracts). Anything not
 * listed cannot be invoked from the portal, and the API and the database authorise and validate every call again, so this list
 * narrows the surface, it is not the authority.
 *
 * Three things these operations never do: they never accept a full account number (a settlement account is requested by label,
 * bank name and masked reference only), they never accept a secret value (only the NAME of a secret), and they never put the
 * callback token anywhere but in the answer of the one draft that created it.
 */

type Fail = { ok: false; status: number; code: string };
export type SetupResult = { ok: true; status: number; data: unknown } | Fail;
export interface SetupOperation {
  run(api: OnboardingApi, form: FormData, key: string): Promise<SetupResult>;
}

const bad = (code = 'validation_failed'): Promise<Fail> =>
  Promise.resolve({ ok: false, status: 422, code });
const anyResponse = z.unknown();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const str = (form: FormData, name: string): string | undefined => {
  const v = form.get(name);
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
};
const uuid = (form: FormData, name: string): string | undefined => {
  const v = str(form, name);
  return v && UUID.test(v) ? v : undefined;
};

const post = (api: OnboardingApi, path: string, body: unknown, key: string) =>
  api.post(path, anyResponse, body, key);

/** Which stable code a failed contract check stands for, by the field it failed on. */
function codeFor(error: z.ZodError, fields: Readonly<Record<string, string>>): string {
  const first = error.issues[0];
  const field = first?.path[0];
  if (first?.message === 'unsafe_free_text') return 'unsafe_free_text';
  return typeof field === 'string' && Object.hasOwn(fields, field)
    ? (fields[field] ?? 'validation_failed')
    : 'validation_failed';
}

// ---- Rail limits: up to eight rows of (rail, limit, kind, value), copied from the provider's documentation -----------------
type RailValue = string | boolean | number;
/** The shape the contract allows for a rail name and a limit name. */
const RAIL_NAME = /^[a-z][a-z0-9_]{1,40}$/;

function railValue(kind: string, text: string): RailValue | undefined {
  switch (kind) {
    case 'text':
      return text.length <= 100 ? text : undefined;
    case 'flag':
      return text.toLowerCase() === 'yes' ? true : text.toLowerCase() === 'no' ? false : undefined;
    case 'amount':
      // Rupees typed by the lender become whole paise, exactly as typed.
      return parseRupeesToPaise(text) ?? undefined;
    case 'count':
      return /^[0-9]{1,15}$/.test(text) ? Number(text) : undefined;
    default:
      return undefined;
  }
}

/**
 * The rows of the form as the contract's nested object, or the code that says what is wrong. Names are kept in Maps while the
 * rows are read, so a name such as "constructor" or "__proto__" can never reach a prototype; the contract then checks every name.
 */
export function readRailLimits(
  form: FormData,
): { ok: true; limits: Record<string, Record<string, RailValue>> } | { ok: false; code: string } {
  const rails = new Map<string, Map<string, RailValue>>();
  for (let row = 1; row <= RAIL_LIMIT_ROWS; row++) {
    const rail = str(form, `rail${String(row)}`);
    const limit = str(form, `limit${String(row)}`);
    const kind = str(form, `kind${String(row)}`);
    const value = str(form, `value${String(row)}`);
    if (!rail && !limit && !value) continue;
    if (!rail || !limit || !kind || value === undefined)
      return { ok: false, code: 'rail_limits_invalid' };
    // A name the contract would not accept is refused here, so no row is ever dropped without the person being told.
    if (!RAIL_NAME.test(rail) || !RAIL_NAME.test(limit))
      return { ok: false, code: 'rail_limits_invalid' };
    const parsed = railValue(kind, value);
    if (parsed === undefined) return { ok: false, code: 'limit_value_invalid' };
    const leaf = rails.get(rail) ?? new Map<string, RailValue>();
    if (leaf.has(limit)) return { ok: false, code: 'rail_limits_invalid' };
    leaf.set(limit, parsed);
    rails.set(rail, leaf);
  }
  return {
    ok: true,
    limits: Object.fromEntries([...rails].map(([rail, leaf]) => [rail, Object.fromEntries(leaf)])),
  };
}

const draftFields = {
  lenderId: 'validation_failed',
  provider: 'provider_invalid',
  providerMode: 'provider_mode_invalid',
  merchantRegistryId: 'merchant_invalid',
  settlementAccountId: 'settlement_account_invalid',
  secretRef: 'secret_ref_invalid',
  webhookSecretRef: 'secret_ref_invalid',
  railLimits: 'rail_limits_invalid',
  railLimitsSource: 'rail_limits_invalid',
  evidenceRef: 'unsafe_free_text',
  contractSectionRef: 'unsafe_free_text',
} as const;

/** Text typed as the note or reason of a decision, checked with the contract's own rules. */
const reasonOf = (form: FormData, name: string) => {
  const text = str(form, name);
  if (text === undefined) return { ok: false as const, code: 'reason_required' };
  const parsed = AccountsReason.safeParse(text);
  if (!parsed.success)
    return {
      ok: false as const,
      code:
        parsed.error.issues[0]?.message === 'unsafe_free_text'
          ? 'unsafe_free_text'
          : 'reason_invalid',
    };
  return { ok: true as const, text: parsed.data };
};

const actionOn = (route: (id: string) => string, needsReason: boolean): SetupOperation => ({
  run: (api, form, key) => {
    const id = uuid(form, 'id');
    if (!id) return bad();
    if (!needsReason) return post(api, route(id), {}, key);
    const reason = reasonOf(form, 'reason');
    return reason.ok ? post(api, route(id), { reason: reason.text }, key) : bad(reason.code);
  },
});

export const SETUP_OPERATIONS: Readonly<Record<string, SetupOperation>> = {
  // ---- Settlement accounts (masked reference only) -----------------------------------------------------------------------
  'setup.settlement.request': {
    run: (api, form, key) => {
      const parsed = SettlementAccountRequestInput.safeParse({
        lenderId: uuid(form, 'lenderId'),
        label: str(form, 'label'),
        bankName: str(form, 'bankName'),
        maskedRef: str(form, 'maskedRef'),
      });
      if (!parsed.success)
        return bad(
          codeFor(parsed.error, {
            maskedRef: 'masked_ref_invalid',
            label: 'settlement_account_invalid',
            bankName: 'settlement_account_invalid',
          }),
        );
      // A number must not hide in the label or the bank name: a run of six or more digits, a number split by spaces, hyphens,
      // dots or slashes (nine or more digits in all) and a PAN-shaped token are all refused before anything is sent.
      if (looksLikeAccountDetail(parsed.data.label) || looksLikeAccountDetail(parsed.data.bankName))
        return bad('settlement_account_invalid');
      return post(api, '/v1/lender/settlement-accounts', parsed.data, key);
    },
  },

  // ---- Merchants ---------------------------------------------------------------------------------------------------------
  'setup.merchant.claim': {
    run: (api, form, key) => {
      const parsed = MerchantClaimInput.safeParse({
        lenderId: uuid(form, 'lenderId'),
        provider: str(form, 'provider'),
        merchantRef: str(form, 'merchantRef'),
      });
      if (!parsed.success)
        return bad(
          codeFor(parsed.error, {
            provider: 'provider_invalid',
            merchantRef: 'merchant_ref_invalid',
          }),
        );
      return post(api, '/v1/lender/merchants', parsed.data, key);
    },
  },

  // ---- Payment configurations ---------------------------------------------------------------------------------------------
  'setup.config.draft': {
    run: (api, form, key) => {
      const secretRef = str(form, 'secretRef');
      const webhookSecretRef = str(form, 'webhookSecretRef');
      // A secret is referred to by NAME. Anything that looks like a value is refused before it is sent anywhere.
      if (
        !secretRef ||
        !webhookSecretRef ||
        looksLikeSecretValue(secretRef) ||
        looksLikeSecretValue(webhookSecretRef)
      )
        return bad('secret_looks_like_value');
      if (secretRef === webhookSecretRef) return bad('secrets_same');
      const rails = readRailLimits(form);
      if (!rails.ok) return bad(rails.code);
      const railLimitsSource = str(form, 'railLimitsSource');
      if (Object.keys(rails.limits).length > 0 && !railLimitsSource)
        return bad('rail_limits_source_required');
      const parsed = PaymentConfigDraftInput.safeParse({
        lenderId: uuid(form, 'lenderId'),
        provider: str(form, 'provider'),
        providerMode: PaymentConfigMode.safeParse(str(form, 'providerMode')).data,
        merchantRegistryId: uuid(form, 'merchantRegistryId'),
        settlementAccountId: uuid(form, 'settlementAccountId'),
        secretRef,
        webhookSecretRef,
        railLimits: rails.limits,
        ...(railLimitsSource ? { railLimitsSource } : {}),
        ...(str(form, 'evidenceRef') ? { evidenceRef: str(form, 'evidenceRef') } : {}),
        ...(str(form, 'contractSectionRef')
          ? { contractSectionRef: str(form, 'contractSectionRef') }
          : {}),
      });
      if (!parsed.success) return bad(codeFor(parsed.error, draftFields));
      // The answer carries the callback token. It is read here once and goes back to the one form that asked; it is not logged.
      return api.post('/v1/lender/payment-configs', PaymentConfigDrafted, parsed.data, key);
    },
  },
  'setup.config.submit': actionOn((id) => `/v1/lender/payment-configs/${id}/submit`, false),
  'setup.config.decide': {
    run: (api, form, key) => {
      const id = uuid(form, 'id');
      const decision = str(form, 'decision');
      if (!id) return bad();
      if (decision !== 'approve' && decision !== 'reject') return bad('decision_invalid');
      const noteText = str(form, 'note');
      // A rejection needs a note; an approval may have one. The note is the person's own words, checked with the contract's rules.
      if (decision === 'reject' && noteText === undefined) return bad('reason_required');
      let note: string | undefined;
      if (noteText !== undefined) {
        const parsed = AccountsNote.safeParse(noteText);
        if (!parsed.success)
          return bad(
            parsed.error.issues[0]?.message === 'unsafe_free_text'
              ? 'unsafe_free_text'
              : 'reason_invalid',
          );
        if (decision === 'reject' && parsed.data.length < 10) return bad('reason_required');
        note = parsed.data;
      }
      return post(
        api,
        `/v1/lender/payment-configs/${id}/decide`,
        { approve: decision === 'approve', ...(note !== undefined ? { note } : {}) },
        key,
      );
    },
  },
  'setup.config.withdraw': actionOn((id) => `/v1/lender/payment-configs/${id}/withdraw`, true),
  'setup.config.retire': actionOn((id) => `/v1/lender/payment-configs/${id}/retire`, true),
};

export type SetupOutcome = { ok: true; drafted?: DraftedConfig } | { ok: false; code: string };

const KEY = /^[A-Za-z0-9._:-]{16,128}$/;
const DRAFT_OPERATION = 'setup.config.draft';

/**
 * Runs the operation a form names. Unknown operations are refused without any call to the API, and so is a key of the wrong
 * shape. A caller that serves the draft only passes `only`, and then the form's own `op` field is ignored; the draft is the only
 * operation whose answer carries something to show.
 */
export async function runSetupOperation(
  api: OnboardingApi,
  form: FormData,
  only?: string,
): Promise<SetupOutcome> {
  const name = only ?? form.get('op');
  const key = form.get('key');
  const operation =
    typeof name === 'string' && Object.hasOwn(SETUP_OPERATIONS, name)
      ? SETUP_OPERATIONS[name]
      : undefined;
  if (!operation) return { ok: false, code: 'path_not_allowed' };
  // The draft shows the callback token once, through its own entry point; the general one does not serve it.
  if (name === DRAFT_OPERATION && only !== DRAFT_OPERATION)
    return { ok: false, code: 'path_not_allowed' };
  if (typeof key !== 'string' || !KEY.test(key)) return { ok: false, code: 'validation_failed' };
  const result = await operation.run(api, form, key);
  if (!result.ok) return { ok: false, code: safeErrorCode(result.code) };
  if (name === DRAFT_OPERATION) {
    const drafted = PaymentConfigDrafted.safeParse(result.data);
    return drafted.success
      ? {
          ok: true,
          drafted: {
            id: drafted.data.id,
            endpointToken: drafted.data.endpointToken,
            callbackPath: drafted.data.callbackPath,
          },
        }
      : { ok: false, code: 'bad_response' };
  }
  return { ok: true };
}

/** Where a form may return to: the lender payment-setup pages only (prevents an open redirect). */
export function safeSetupReturnPath(value: unknown): string {
  const QUERY = String.raw`(?:\?[A-Za-z0-9=&_.%-]{1,700})?`;
  const ID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  const allowed = new RegExp(`^/payment-setup(?:/new|/accounts|/features|/${ID})?${QUERY}$`);
  return typeof value === 'string' && allowed.test(value) ? value : '/payment-setup';
}

/** The page address to go back to after an action, with the result as `done=1` or a short `error` code (nothing else). */
export function setupNoticeUrl(
  returnTo: string,
  outcome: { ok: true } | { ok: false; code: string },
): string {
  const [path = '/payment-setup', query = ''] = returnTo.split('?', 2);
  const kept = query.split('&').filter((part) => part !== '' && !/^(done|error)=/.test(part));
  kept.push(outcome.ok ? 'done=1' : `error=${encodeURIComponent(safeErrorCode(outcome.code))}`);
  return `${path}?${kept.join('&')}`;
}
