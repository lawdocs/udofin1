import {
  LP_BANK_CREDIT_MAX_CSV_CHARS,
  LP_MANDATE_REQUIREMENTS,
  LP_REOPEN_REASONS,
  LP_RESOLVE_REASONS,
  LpBankCreditsResult,
  LpExceptionActionResult,
  LpSetResult,
} from '@udofin/contracts';
import { type ZodType } from 'zod';
import { type OnboardingApi } from '../onboarding/api.js';
import { lpParseRupees } from './format.js';

/**
 * The only writes the lender payment screens can make. A form names one operation from the table below; the table maps it to one
 * API call with fields checked for shape. Anything not listed cannot be invoked from the portal, and the API authorises every
 * call again with the signed-in person's own token, so this list narrows the surface, it is not the authority. The server
 * decides every business rule (ranges, states, who may act): nothing here refuses a value for a business reason.
 */

type Fail = { ok: false; status: number; code: string };
type Done = { ok: true; counts?: { inserted: number; duplicates: number } };
export type LpRunResult = Done | Fail;

export interface LpOperation {
  run(api: OnboardingApi, form: FormData, key: string): Promise<LpRunResult>;
}

export type LpOutcome = Done | { ok: false; code: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY = /^[A-Za-z0-9._:-]{16,128}$/;
const WHOLE = /^\d{1,7}$/;
/** Letters, digits and . _ : / # - only, no spaces (the evidence rule the database enforces; repeated here only to explain it). */
const EVIDENCE = /^[A-Za-z0-9._:/#-]{1,100}$/;
const MAX_NOTE = 500;

const fail = (code: string, status = 422): Fail => ({ ok: false, status, code });
const invalid = fail('validation_failed');

const str = (form: FormData, name: string): string | undefined => {
  const value = form.get(name);
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
};
const uuid = (form: FormData, name: string): string | undefined => {
  const value = str(form, name);
  return value && UUID.test(value) ? value : undefined;
};
const whole = (form: FormData, name: string): number | undefined => {
  const value = str(form, name);
  return value && WHOLE.test(value) ? Number(value) : undefined;
};
const yesNo = (form: FormData, name: string): boolean | undefined => {
  const value = str(form, name);
  return value === 'true' ? true : value === 'false' ? false : undefined;
};
/** A box the person ticked on purpose. It is never pre-ticked by the forms. */
const confirmed = (form: FormData): boolean => form.get('confirm') === 'on';

const post = async <T>(
  api: OnboardingApi,
  path: string,
  schema: ZodType<T>,
  body: unknown,
  key: string,
): Promise<{ ok: true; data: T } | Fail> => {
  const result = await api.post(path, schema, body, key);
  return result.ok ? { ok: true, data: result.data } : fail(result.code, result.status);
};

/** The header check of a bank statement: exactly the three columns valueDate, amountMinor and utr, in any order. */
export function lpCheckStatementHeader(csv: string): { ok: true } | { ok: false } {
  const text = csv.charCodeAt(0) === 0xfeff ? csv.slice(1) : csv;
  const header = text.split('\n', 1)[0]?.replace(/\r$/, '') ?? '';
  const columns = header.split(',').map((column) => column.trim());
  const wanted = ['valueDate', 'amountMinor', 'utr'];
  const exact =
    columns.length === wanted.length &&
    wanted.every((name) => columns.filter((column) => column === name).length === 1);
  return exact ? { ok: true } : { ok: false };
}

/** Splits typed evidence references (separated by spaces, commas or new lines). The server checks them again. */
export function lpSplitEvidence(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

const rupeesOrNull = (form: FormData, name: string): number | null | undefined => {
  const raw = str(form, name);
  if (raw === undefined) return null;
  // Only the shape is checked here. Whether an amount is acceptable (for example above zero) is the server's decision.
  return lpParseRupees(raw) ?? undefined;
};

export const LP_OPERATIONS: Readonly<Record<string, LpOperation>> = {
  'payments.policy.set': {
    run: async (api, form, key) => {
      if (!confirmed(form)) return fail('confirmation_required');
      const lenderId = uuid(form, 'lenderId');
      const allowPartialPayments = yesNo(form, 'allowPartialPayments');
      const allowPartPrepayment = yesNo(form, 'allowPartPrepayment');
      const linkValidityMinutes = whole(form, 'linkValidityMinutes');
      if (
        !lenderId ||
        allowPartialPayments === undefined ||
        allowPartPrepayment === undefined ||
        linkValidityMinutes === undefined
      )
        return invalid;
      const minPartial = rupeesOrNull(form, 'minPartialAmount');
      const minPrepayment = rupeesOrNull(form, 'minPartPrepayment');
      if (minPartial === undefined || minPrepayment === undefined) return fail('amount_invalid');
      // A minimum is sent only where the matching option is on; the server decides whether the figures are acceptable.
      const result = await post(
        api,
        '/v1/lender/payment-policy',
        LpSetResult,
        {
          lenderId,
          allowPartialPayments,
          minPartialAmountMinor: allowPartialPayments ? minPartial : null,
          allowPartPrepayment,
          minPartPrepaymentMinor: allowPartPrepayment ? minPrepayment : null,
          linkValidityMinutes,
        },
        key,
      );
      return result.ok ? { ok: true } : result;
    },
  },
  'payments.mandate_policy.set': {
    run: async (api, form, key) => {
      if (!confirmed(form)) return fail('confirmation_required');
      const lenderId = uuid(form, 'lenderId');
      const requirement = LP_MANDATE_REQUIREMENTS.find((r) => r === str(form, 'requirement'));
      const preDebitLeadHours = whole(form, 'preDebitLeadHours');
      if (!lenderId || !requirement || preDebitLeadHours === undefined) return invalid;
      const ceiling = rupeesOrNull(form, 'maxAmountCap');
      if (ceiling === undefined) return fail('amount_invalid');
      const result = await post(
        api,
        '/v1/lender/mandate-policy',
        LpSetResult,
        { lenderId, requirement, maxAmountCapMinor: ceiling, preDebitLeadHours },
        key,
      );
      return result.ok ? { ok: true } : result;
    },
  },
  'payments.recon_settings.set': {
    run: async (api, form, key) => {
      if (!confirmed(form)) return fail('confirmation_required');
      const lenderId = uuid(form, 'lenderId');
      const settlementLagDays = whole(form, 'settlementLagDays');
      const receiptLagHours = whole(form, 'receiptLagHours');
      if (!lenderId || settlementLagDays === undefined || receiptLagHours === undefined)
        return invalid;
      const result = await post(
        api,
        '/v1/lender/reconciliation/settings',
        LpSetResult,
        { lenderId, settlementLagDays, receiptLagHours },
        key,
      );
      return result.ok ? { ok: true } : result;
    },
  },
  'payments.bank_credits.upload': {
    run: async (api, form, key) => {
      if (!confirmed(form)) return fail('confirmation_required');
      const lenderId = uuid(form, 'lenderId');
      const accountId = uuid(form, 'accountId');
      if (!lenderId || !accountId) return invalid;
      const file = form.get('file');
      const hasFile = file instanceof File && file.size > 0;
      const pastedField = form.get('csv');
      const pasted = typeof pastedField === 'string' ? pastedField : '';
      const hasPasted = pasted.trim() !== '';
      if (hasFile && hasPasted) return fail('csv_both');
      if (!hasFile && !hasPasted) return fail('csv_missing');
      const csv = hasFile ? await file.text() : pasted;
      if (csv.length > LP_BANK_CREDIT_MAX_CSV_CHARS) return fail('csv_too_large', 413);
      // Checked here so a wrong file is stopped before it travels; the server repeats every rule and decides.
      if (!lpCheckStatementHeader(csv).ok) return fail('csv_header_invalid');
      const result = await post(
        api,
        '/v1/lender/reconciliation/bank-credits',
        LpBankCreditsResult,
        { lenderId, accountId, csv },
        key,
      );
      return result.ok
        ? {
            ok: true,
            counts: { inserted: result.data.inserted, duplicates: result.data.duplicates },
          }
        : result;
    },
  },
  'payments.exception.acknowledge': {
    run: async (api, form, key) => {
      if (!confirmed(form)) return fail('confirmation_required');
      const id = uuid(form, 'id');
      if (!id) return invalid;
      const result = await post(
        api,
        `/v1/lender/reconciliation/exceptions/${id}/acknowledge`,
        LpExceptionActionResult,
        {},
        key,
      );
      return result.ok ? { ok: true } : result;
    },
  },
  'payments.exception.assign': {
    run: async (api, form, key) => {
      if (!confirmed(form)) return fail('confirmation_required');
      const id = uuid(form, 'id');
      const assignee = uuid(form, 'assignee');
      if (!id || !assignee) return invalid;
      const result = await post(
        api,
        `/v1/lender/reconciliation/exceptions/${id}/assign`,
        LpExceptionActionResult,
        { assignee },
        key,
      );
      return result.ok ? { ok: true } : result;
    },
  },
  'payments.exception.resolve': {
    run: async (api, form, key) => {
      if (!confirmed(form)) return fail('confirmation_required');
      const id = uuid(form, 'id');
      if (!id) return invalid;
      const reasonCode = LP_RESOLVE_REASONS.find((r) => r === str(form, 'reasonCode'));
      if (!reasonCode) return fail('reason_required');
      const evidence = lpSplitEvidence(str(form, 'evidence') ?? '');
      if (evidence.length < 1 || evidence.length > 10 || !evidence.every((e) => EVIDENCE.test(e)))
        return fail('evidence_required');
      const note = str(form, 'note');
      if (note !== undefined && note.length > MAX_NOTE) return fail('reason_invalid');
      const result = await post(
        api,
        `/v1/lender/reconciliation/exceptions/${id}/resolve`,
        LpExceptionActionResult,
        { reasonCode, evidence, ...(note !== undefined ? { note } : {}) },
        key,
      );
      return result.ok ? { ok: true } : result;
    },
  },
  'payments.exception.reopen': {
    run: async (api, form, key) => {
      if (!confirmed(form)) return fail('confirmation_required');
      const id = uuid(form, 'id');
      if (!id) return invalid;
      const reasonCode = LP_REOPEN_REASONS.find((r) => r === str(form, 'reasonCode'));
      if (!reasonCode) return fail('reason_required');
      const note = str(form, 'note');
      if (note !== undefined && note.length > MAX_NOTE) return fail('reason_invalid');
      const result = await post(
        api,
        `/v1/lender/reconciliation/exceptions/${id}/reopen`,
        LpExceptionActionResult,
        { reasonCode, ...(note !== undefined ? { note } : {}) },
        key,
      );
      return result.ok ? { ok: true } : result;
    },
  },
};

/** The names of the operations the payment screens may run. */
export const LP_OPERATION_NAMES = Object.keys(LP_OPERATIONS);

/** Runs the operation a form names. Unknown operations are refused before anything is sent. */
export async function lpRunOperation(api: OnboardingApi, form: FormData): Promise<LpOutcome> {
  const name = form.get('op');
  const key = form.get('key');
  const operation =
    typeof name === 'string' && Object.hasOwn(LP_OPERATIONS, name)
      ? LP_OPERATIONS[name]
      : undefined;
  if (!operation) return { ok: false, code: 'path_not_allowed' };
  if (typeof key !== 'string' || !KEY.test(key)) return { ok: false, code: 'validation_failed' };
  const result = await operation.run(api, form, key);
  return result.ok ? result : { ok: false, code: result.code };
}

const RETURN_PATHS = [
  /^\/payments(\/(events|policy|[0-9a-f-]{36}))?$/,
  /^\/mandates(\/(debits|policy|[0-9a-f-]{36}))?$/,
  /^\/reconciliation(\/(settings|bank-credits|settlements|exceptions|settlements\/[0-9a-f-]{36}|exceptions\/[0-9a-f-]{36}|runs\/\d{4}-\d{2}-\d{2}))?$/,
];

/** Only the payment, mandate and reconciliation pages may be returned to (prevents open redirects). */
export function lpSafeReturnPath(value: unknown): string {
  return typeof value === 'string' && RETURN_PATHS.some((pattern) => pattern.test(value))
    ? value
    : '/payments';
}
