import {
  AccountFormatRuleApproveInput,
  AccountFormatRuleDraftInput,
  AccountsReasonInput,
  FeatureChangeDecided,
  FeatureChangeDecisionInput,
  FeatureChangeRequestInput,
  FeatureKillInput,
  FingerprintKeyVersionApproveInput,
  FingerprintKeyVersionProposalInput,
  LP_REOPEN_REASONS,
  LP_RESOLVE_REASONS,
  LpExceptionAssignInput,
  LpExceptionReopenInput,
  LpExceptionResolveInput,
  MerchantVerifyInput,
  PaymentProviderInput,
  RegistryAccountRegisterInput,
  RegistryAccountRegistered,
  RegistryAccountVerifyInput,
  ReturnCodeClassInput,
  SettlementAccountLinkInput,
  UdofinFeeMerchantInput,
} from '@udofin/contracts';
import { z, type ZodType } from 'zod';
import { type PortalKind } from '../onboarding/api.js';
import { realDate } from '../servicing/format.js';
import { type PlatformApi, type PlatformResult } from './client.js';
import {
  DECISION_RESULTS,
  EVIDENCE_STATUSES,
  isLockedFeature,
  PROVIDER_KINDS,
  PROVIDER_STATUSES,
  reasonCodesFrom,
  RETURN_CLASSES,
  safeErrorCode,
} from './wording.js';

/**
 * The only writes the operations screens for providers, the account registry, feature switches and platform exceptions can
 * make. A form names one operation; this table maps it to exactly one API route with the fields checked again here and the
 * finished body checked against the same contract the API uses. Anything not listed cannot be invoked from the portal, and the
 * API and the database authorise and validate every call again, so this list narrows the surface, it is not the authority.
 *
 * Nothing here computes a figure or decides anything. A rule that needs two people (verify, approve, decide) is enforced by the
 * database; the screens only avoid offering the second step to the first person.
 *
 * THE ACCOUNT NUMBER. `account.register` is the only operation whose form carries a full bank account number, entered once by
 * the person registering it. It is read from the form, placed in the request body of the single registration route and nowhere
 * else: it is never returned in an outcome, never part of a path or a query, never in an error, and the operation keeps no
 * copy. It has its own entry point (`runAccountRegistration`); the general entry point refuses it.
 */

type Fail = { ok: false; status: number; code: string; reasons?: readonly string[] };
export type AccountsResult = PlatformResult<unknown> | Fail;
export interface AccountsOperation {
  portals: readonly PortalKind[];
  run(api: PlatformApi, form: FormData, key: string): Promise<AccountsResult>;
}

const bad = (code = 'validation_failed'): Fail => ({ ok: false, status: 422, code });
const anyResponse = z.unknown();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EVIDENCE_KEY = /^[a-z][a-z0-9_]{1,40}$/;
const EXCEPTION_EVIDENCE = /^[A-Za-z0-9._:/#-]{1,100}$/;
const ops = ['ops'] as const;

/** The only operation whose form holds an account number. */
export const REGISTER_OPERATION = 'account.register';
export const EXCEPTION_EVIDENCE_SLOTS = 3;
export const FEATURE_EVIDENCE_SLOTS = 3;

const str = (form: FormData, name: string): string | undefined => {
  const v = form.get(name);
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
};
const uuid = (form: FormData, name: string): string | undefined => {
  const v = str(form, name);
  return v && UUID.test(v) ? v : undefined;
};
const oneOf = (allowed: readonly string[], value: string | undefined): string | undefined =>
  allowed.find((candidate) => candidate === value);
/** Text of 10 to `max` characters after trimming, or undefined. */
const reasonText = (form: FormData, name: string, max = 1000): string | undefined => {
  const v = str(form, name);
  return v && v.length >= 10 && v.length <= max ? v : undefined;
};
/** A real calendar date, or undefined when blank; `null` when something was typed that is not a date. */
const optionalDate = (form: FormData, name: string): string | undefined | null => {
  const v = str(form, name);
  if (v === undefined) return undefined;
  return realDate(v);
};
const wholeNumber = (form: FormData, name: string, max: number): number | undefined => {
  const v = str(form, name);
  if (!v || !/^\d{1,4}$/.test(v)) return undefined;
  const n = Number(v);
  return n >= 1 && n <= max ? n : undefined;
};

/** Checks a finished body against the contract the API uses. A body that does not fit is never sent. */
function checked<S extends ZodType>(
  schema: S,
  body: unknown,
  send: (parsed: z.output<S>) => Promise<PlatformResult<unknown>>,
): Promise<AccountsResult> {
  const parsed = schema.safeParse(body);
  return parsed.success ? send(parsed.data) : Promise.resolve(bad());
}

const post = (api: PlatformApi, path: string, body: unknown, key: string) =>
  api.post(path, anyResponse, body, key);

/** One to three label and reference pairs, "label" and "value" slots. Returns null when a slot is half filled or repeated. */
function pairs(form: FormData, slots: number): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (let slot = 1; slot <= slots; slot++) {
    const label = str(form, `evidenceLabel${String(slot)}`);
    const value = str(form, `evidenceValue${String(slot)}`);
    if (!label && !value) continue;
    if (!label || !value || !EVIDENCE_KEY.test(label) || value.length > 200 || label in out)
      return null;
    out[label] = value;
  }
  return out;
}

export const ACCOUNTS_OPERATIONS: Readonly<Record<string, AccountsOperation>> = {
  // ---- Payment providers and return codes ------------------------------------------------------------------------
  'provider.set': {
    portals: ops,
    run: (api, form, key) => {
      const kind = oneOf(PROVIDER_KINDS, str(form, 'kind'));
      const status = oneOf(PROVIDER_STATUSES, str(form, 'status'));
      const evidenceLabel = oneOf(EVIDENCE_STATUSES, str(form, 'evidenceLabel'));
      if (!kind || !status || !evidenceLabel) return Promise.resolve(bad());
      const reason = str(form, 'reason');
      // Suspending a provider needs a reason, so the register always says why.
      if (status === 'suspended' && !reasonText(form, 'reason'))
        return Promise.resolve(bad('reason_required'));
      return checked(
        PaymentProviderInput,
        {
          provider: str(form, 'provider'),
          displayName: str(form, 'displayName'),
          kind,
          status,
          authorisationEvidenceRef: str(form, 'authorisationEvidenceRef') ?? null,
          evidenceLabel,
          ...(reason ? { reason } : {}),
        },
        (body) => post(api, '/v1/platform/payment-providers', body, key),
      );
    },
  },
  'returncode.set': {
    portals: ops,
    run: (api, form, key) => {
      const klass = oneOf(RETURN_CLASSES, str(form, 'class'));
      if (!klass) return Promise.resolve(bad());
      return checked(
        ReturnCodeClassInput,
        {
          provider: str(form, 'provider'),
          code: str(form, 'code'),
          class: klass,
          evidenceRef: str(form, 'evidenceRef'),
        },
        (body) => post(api, '/v1/platform/return-code-classes', body, key),
      );
    },
  },

  // ---- Account format rules and fingerprint key versions ----------------------------------------------------------
  'rule.draft': {
    portals: ops,
    run: (api, form, key) => {
      const min = wholeNumber(form, 'minDigits', 40);
      const max = wholeNumber(form, 'maxDigits', 40);
      const ifsc = oneOf(['yes', 'no'], str(form, 'ifscRequired'));
      const evidenceLabel = oneOf(EVIDENCE_STATUSES, str(form, 'evidenceLabel'));
      const from = optionalDate(form, 'effectiveFrom');
      const to = optionalDate(form, 'effectiveTo');
      if (min === undefined || max === undefined || !ifsc || !evidenceLabel)
        return Promise.resolve(bad());
      if (min > max) return Promise.resolve(bad('rule_invalid'));
      if (from === null || to === null) return Promise.resolve(bad('dates_invalid'));
      if (!str(form, 'sourceNote')) return Promise.resolve(bad('source_note_required'));
      return checked(
        AccountFormatRuleDraftInput,
        {
          country: str(form, 'country')?.toUpperCase(),
          accountType: str(form, 'accountType'),
          minDigits: min,
          maxDigits: max,
          ifscRequired: ifsc === 'yes',
          evidenceLabel,
          sourceNote: str(form, 'sourceNote'),
          ...(from ? { effectiveFrom: from } : {}),
          ...(to ? { effectiveTo: to } : {}),
        },
        (body) => post(api, '/v1/platform/account-format-rules', body, key),
      );
    },
  },
  'rule.submit': {
    portals: ops,
    run: (api, form, key) => {
      const id = uuid(form, 'id');
      return id
        ? post(api, `/v1/platform/account-format-rules/${id}/submit`, {}, key)
        : Promise.resolve(bad());
    },
  },
  'rule.approve': {
    portals: ops,
    run: (api, form, key) => {
      const id = uuid(form, 'id');
      if (!id) return Promise.resolve(bad());
      const note = str(form, 'note');
      return checked(AccountFormatRuleApproveInput, note ? { note } : {}, (body) =>
        post(api, `/v1/platform/account-format-rules/${id}/approve`, body, key),
      );
    },
  },
  'rule.retire': {
    portals: ops,
    run: (api, form, key) => {
      const id = uuid(form, 'id');
      if (!id) return Promise.resolve(bad());
      const reason = reasonText(form, 'reason');
      if (!reason) return Promise.resolve(bad('reason_required'));
      return checked(AccountsReasonInput, { reason }, (body) =>
        post(api, `/v1/platform/account-format-rules/${id}/retire`, body, key),
      );
    },
  },
  'keyversion.propose': {
    portals: ops,
    run: (api, form, key) => {
      const version = wholeNumber(form, 'version', 1000);
      if (version === undefined) return Promise.resolve(bad('key_version_invalid'));
      const note = str(form, 'note');
      return checked(
        FingerprintKeyVersionProposalInput,
        { version, ...(note ? { note } : {}) },
        (body) => post(api, '/v1/platform/fingerprint-key-versions', body, key),
      );
    },
  },
  'keyversion.approve': {
    portals: ops,
    run: (api, form, key) => {
      const version = wholeNumber(form, 'version', 1000);
      if (version === undefined) return Promise.resolve(bad('key_version_invalid'));
      const note = str(form, 'note');
      return checked(FingerprintKeyVersionApproveInput, note ? { note } : {}, (body) =>
        post(api, `/v1/platform/fingerprint-key-versions/${String(version)}/approve`, body, key),
      );
    },
  },

  // ---- Registered accounts ----------------------------------------------------------------------------------------
  [REGISTER_OPERATION]: {
    portals: ops,
    run: (api, form, key) => {
      const ownerKind = oneOf(
        ['lender', 'udofin', 'group_company', 'other'],
        str(form, 'ownerKind'),
      );
      const ownerOrgId = uuid(form, 'ownerOrgId');
      const rekeys = uuid(form, 'rekeysRegistryId');
      const from = optionalDate(form, 'effectiveFrom');
      const to = optionalDate(form, 'effectiveTo');
      if (!ownerKind) return Promise.resolve(bad('owner_invalid'));
      // The owner organisation is required exactly when the owner is a lender.
      if ((ownerKind === 'lender') !== (ownerOrgId !== undefined))
        return Promise.resolve(bad('owner_invalid'));
      if (from === null || to === null) return Promise.resolve(bad('dates_invalid'));
      if (str(form, 'rekeysRegistryId') !== undefined && !rekeys)
        return Promise.resolve(bad('rekey_invalid'));
      const purposes = [
        ...new Set(form.getAll('permittedPurposes').filter((v) => typeof v === 'string')),
      ];
      // The number is read here, once. Fixed-text codes only: the value is never named in a refusal.
      const accountNumber = str(form, 'accountNumber');
      const ifsc = str(form, 'ifsc');
      if (!accountNumber || !/^[0-9]{1,34}$/.test(accountNumber))
        return Promise.resolve(bad('account_number_invalid'));
      if (!ifsc || !/^[A-Za-z]{4}0[A-Za-z0-9]{6}$/.test(ifsc))
        return Promise.resolve(bad('ifsc_invalid'));
      return checked(
        RegistryAccountRegisterInput,
        {
          accountNumber,
          ifsc: ifsc.toUpperCase(),
          country: str(form, 'country')?.toUpperCase(),
          accountType: str(form, 'accountType'),
          ownerKind,
          ...(ownerOrgId ? { ownerOrgId } : {}),
          legalOwnerName: str(form, 'legalOwnerName'),
          permittedPurposes: purposes,
          ...(from ? { effectiveFrom: from } : {}),
          ...(to ? { effectiveTo: to } : {}),
          ...(rekeys ? { rekeysRegistryId: rekeys } : {}),
        },
        (body) => api.post('/v1/platform/accounts', RegistryAccountRegistered, body, key),
      );
    },
  },
  'account.verify': {
    portals: ops,
    run: (api, form, key) => {
      const id = uuid(form, 'id');
      if (!id) return Promise.resolve(bad());
      const note = str(form, 'note');
      return checked(
        RegistryAccountVerifyInput,
        { evidenceRef: str(form, 'evidenceRef'), ...(note ? { note } : {}) },
        (body) => post(api, `/v1/platform/accounts/${id}/verify`, body, key),
      );
    },
  },
  'account.reject': {
    portals: ops,
    run: (api, form, key) => {
      const id = uuid(form, 'id');
      if (!id) return Promise.resolve(bad());
      const reason = reasonText(form, 'reason');
      if (!reason) return Promise.resolve(bad('reason_required'));
      return checked(AccountsReasonInput, { reason }, (body) =>
        post(api, `/v1/platform/accounts/${id}/reject`, body, key),
      );
    },
  },
  'account.revoke': {
    portals: ops,
    run: (api, form, key) => {
      const id = uuid(form, 'id');
      if (!id) return Promise.resolve(bad());
      // Revoking cuts off every settlement account and configuration that relies on the entry, so a real reason is needed.
      const reason = reasonText(form, 'reason');
      if (!reason) return Promise.resolve(bad('reason_required'));
      return checked(AccountsReasonInput, { reason }, (body) =>
        post(api, `/v1/platform/accounts/${id}/revoke`, body, key),
      );
    },
  },
  'settlement.link': {
    portals: ops,
    run: (api, form, key) => {
      const id = uuid(form, 'id');
      const registryId = uuid(form, 'registryId');
      if (!id || !registryId) return Promise.resolve(bad());
      return checked(SettlementAccountLinkInput, { registryId }, (body) =>
        post(api, `/v1/platform/settlement-accounts/${id}/link`, body, key),
      );
    },
  },

  // ---- Merchants --------------------------------------------------------------------------------------------------
  'merchant.verify': {
    portals: ops,
    run: (api, form, key) => {
      const id = uuid(form, 'id');
      if (!id) return Promise.resolve(bad());
      return checked(MerchantVerifyInput, { evidenceRef: str(form, 'evidenceRef') }, (body) =>
        post(api, `/v1/platform/merchants/${id}/verify`, body, key),
      );
    },
  },
  'merchant.revoke': {
    portals: ops,
    run: (api, form, key) => {
      const id = uuid(form, 'id');
      if (!id) return Promise.resolve(bad());
      const reason = reasonText(form, 'reason');
      if (!reason) return Promise.resolve(bad('reason_required'));
      return checked(AccountsReasonInput, { reason }, (body) =>
        post(api, `/v1/platform/merchants/${id}/revoke`, body, key),
      );
    },
  },
  'feemerchant.register': {
    portals: ops,
    run: (api, form, key) =>
      checked(
        UdofinFeeMerchantInput,
        { provider: str(form, 'provider'), merchantRef: str(form, 'merchantRef') },
        (body) => post(api, '/v1/platform/udofin-fee-merchants', body, key),
      ),
  },

  // ---- Feature switches -------------------------------------------------------------------------------------------
  'feature.request': {
    portals: ops,
    run: (api, form, key) => {
      const lenderId = uuid(form, 'lenderId');
      const feature = str(form, 'feature');
      const direction = oneOf(['on', 'off'], str(form, 'direction'));
      if (!lenderId || !feature || !direction) return Promise.resolve(bad());
      const enable = direction === 'on';
      // Collections and the default loss guarantee cannot be switched on in this release. The request is not even sent.
      if (enable && isLockedFeature(feature)) return Promise.resolve(bad('feature_not_enableable'));
      const evidence = pairs(form, FEATURE_EVIDENCE_SLOTS);
      if (evidence === null) return Promise.resolve(bad('evidence_invalid'));
      if (enable && Object.keys(evidence).length === 0)
        return Promise.resolve(bad('evidence_invalid'));
      const reason = str(form, 'reason');
      // Switching something off needs a reason, so the history says why.
      if (!enable && !reasonText(form, 'reason')) return Promise.resolve(bad('reason_required'));
      return checked(
        FeatureChangeRequestInput,
        { lenderId, feature, enable, evidence, ...(reason ? { reason } : {}) },
        (body) => post(api, '/v1/platform/feature-change-requests', body, key),
      );
    },
  },
  'feature.decide': {
    portals: ops,
    run: (api, form, key) => {
      const id = uuid(form, 'id');
      const verdict = oneOf(['approve', 'reject'], str(form, 'verdict'));
      if (!id || !verdict) return Promise.resolve(bad());
      const note = str(form, 'note');
      // A rejection says why.
      if (verdict === 'reject' && !reasonText(form, 'note'))
        return Promise.resolve(bad('reason_required'));
      return checked(
        FeatureChangeDecisionInput,
        { approve: verdict === 'approve', ...(note ? { note } : {}) },
        (body) =>
          api.post(
            `/v1/platform/feature-change-requests/${id}/decide`,
            FeatureChangeDecided,
            body,
            key,
          ),
      );
    },
  },
  'feature.cancel': {
    portals: ops,
    run: (api, form, key) => {
      const id = uuid(form, 'id');
      return id
        ? post(api, `/v1/platform/feature-change-requests/${id}/cancel`, {}, key)
        : Promise.resolve(bad());
    },
  },
  'feature.kill': {
    portals: ops,
    run: (api, form, key) => {
      const lenderId = uuid(form, 'lenderId');
      const feature = str(form, 'feature');
      if (!lenderId || !feature) return Promise.resolve(bad());
      // An emergency switch-off needs one deliberate confirmation and a reason.
      if (form.get('confirm') !== 'on') return Promise.resolve(bad('confirm_required'));
      const reason = reasonText(form, 'reason');
      if (!reason) return Promise.resolve(bad('reason_required'));
      return checked(FeatureKillInput, { lenderId, feature, reason }, (body) =>
        post(api, '/v1/platform/features/kill', body, key),
      );
    },
  },

  // ---- Platform exceptions ----------------------------------------------------------------------------------------
  'exception.acknowledge': {
    portals: ops,
    run: (api, form, key) => {
      const id = uuid(form, 'id');
      return id
        ? post(api, `/v1/lender/reconciliation/exceptions/${id}/acknowledge`, {}, key)
        : Promise.resolve(bad());
    },
  },
  'exception.assign': {
    portals: ops,
    run: (api, form, key) => {
      const id = uuid(form, 'id');
      const assignee = uuid(form, 'assignee');
      if (!id) return Promise.resolve(bad());
      if (!assignee) return Promise.resolve(bad('assignee_invalid'));
      return checked(LpExceptionAssignInput, { assignee }, (body) =>
        post(api, `/v1/lender/reconciliation/exceptions/${id}/assign`, body, key),
      );
    },
  },
  'exception.resolve': {
    portals: ops,
    run: (api, form, key) => {
      const id = uuid(form, 'id');
      const reasonCode = oneOf(LP_RESOLVE_REASONS, str(form, 'reasonCode'));
      if (!id || !reasonCode) return Promise.resolve(bad());
      const evidence: string[] = [];
      for (let slot = 1; slot <= EXCEPTION_EVIDENCE_SLOTS; slot++) {
        const value = str(form, `evidence${String(slot)}`);
        if (value === undefined) continue;
        if (!EXCEPTION_EVIDENCE.test(value)) return Promise.resolve(bad('evidence_required'));
        evidence.push(value);
      }
      if (evidence.length === 0) return Promise.resolve(bad('evidence_required'));
      const note = str(form, 'note');
      return checked(
        LpExceptionResolveInput,
        { reasonCode, evidence, ...(note ? { note } : {}) },
        (body) => post(api, `/v1/lender/reconciliation/exceptions/${id}/resolve`, body, key),
      );
    },
  },
  'exception.reopen': {
    portals: ops,
    run: (api, form, key) => {
      const id = uuid(form, 'id');
      const reasonCode = oneOf(LP_REOPEN_REASONS, str(form, 'reasonCode'));
      if (!id || !reasonCode) return Promise.resolve(bad());
      const note = str(form, 'note');
      return checked(LpExceptionReopenInput, { reasonCode, ...(note ? { note } : {}) }, (body) =>
        post(api, `/v1/lender/reconciliation/exceptions/${id}/reopen`, body, key),
      );
    },
  },
};

export type AccountsOutcome =
  | { ok: true; created?: { id: string }; result?: string }
  | { ok: false; code: string; reasons?: readonly string[] };

const KEY = /^[A-Za-z0-9._:-]{16,128}$/;

function failure(
  result: Fail | { ok: false; code: string; reasons?: readonly string[] },
): AccountsOutcome {
  const reasons = result.reasons ? reasonCodesFrom(result.reasons.join(',')) : [];
  return {
    ok: false,
    code: safeErrorCode(result.code),
    ...(reasons.length > 0 ? { reasons } : {}),
  };
}

/**
 * Runs the operation a form names. Unknown operations and operations of the other portal are refused without any call to the
 * API. The registration of an account has its own entry point: the general one refuses it.
 */
export async function runAccountsOperation(
  api: PlatformApi,
  form: FormData,
  portal: PortalKind,
): Promise<AccountsOutcome> {
  const name = form.get('op');
  const operation =
    typeof name === 'string' &&
    name !== REGISTER_OPERATION &&
    Object.hasOwn(ACCOUNTS_OPERATIONS, name)
      ? ACCOUNTS_OPERATIONS[name]
      : undefined;
  if (!operation || !operation.portals.includes(portal))
    return { ok: false, code: 'path_not_allowed' };
  const key = form.get('key');
  if (typeof key !== 'string' || !KEY.test(key)) return { ok: false, code: 'validation_failed' };
  const result = await operation.run(api, form, key);
  if (!result.ok) return failure(result);
  if (name === 'feature.decide') {
    const decided = FeatureChangeDecided.safeParse(result.data);
    // The answer matters: an "expired" decision applied nothing.
    return decided.success && DECISION_RESULTS.includes(decided.data.status)
      ? { ok: true, result: decided.data.status }
      : { ok: true };
  }
  return { ok: true };
}

/**
 * Registers one account. This entry point serves that one operation whatever the form says, calls the one registration route
 * once, and hands back the registry id only: never the number, never the masked reference.
 */
export async function runAccountRegistration(
  api: PlatformApi,
  form: FormData,
  portal: PortalKind,
): Promise<AccountsOutcome> {
  const operation = ACCOUNTS_OPERATIONS[REGISTER_OPERATION];
  if (!operation || !operation.portals.includes(portal))
    return { ok: false, code: 'path_not_allowed' };
  const key = form.get('key');
  if (typeof key !== 'string' || !KEY.test(key)) return { ok: false, code: 'validation_failed' };
  let result: AccountsResult;
  try {
    result = await operation.run(api, form, key);
  } catch {
    // Whatever went wrong can quote the request. Only the fact is kept.
    return { ok: false, code: 'network_error' };
  }
  if (!result.ok) return failure(result);
  const registered = RegistryAccountRegistered.safeParse(result.data);
  return registered.success
    ? { ok: true, created: { id: registered.data.id } }
    : { ok: false, code: 'bad_response' };
}

/** The pages a form may return to (prevents an open redirect). */
export function safeAccountsReturnPath(value: unknown): string {
  const QUERY = String.raw`(?:\?[A-Za-z0-9=&_.%,:-]{1,700})?`;
  const ID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  const allowed = new RegExp(
    `^/(?:providers|accounts(?:/rules|/settlement|/merchants)?|features|exceptions(?:/${ID})?)${QUERY}$`,
  );
  return typeof value === 'string' && allowed.test(value) ? value : '/accounts';
}

/** The page address to go back to after an action, with the result as `done=1` or a short `error` code (nothing else). */
export function accountsNoticeUrl(returnTo: string, outcome: AccountsOutcome): string {
  const [path = '/accounts', query = ''] = returnTo.split('?', 2);
  const kept = query
    .split('&')
    .filter((part) => part !== '' && !/^(done|error|result|reasons|registered)=/.test(part));
  if (outcome.ok) {
    kept.push('done=1');
    if (outcome.result && DECISION_RESULTS.includes(outcome.result))
      kept.push(`result=${outcome.result}`);
  } else {
    kept.push(`error=${encodeURIComponent(safeErrorCode(outcome.code))}`);
    const reasons = outcome.reasons ? reasonCodesFrom(outcome.reasons.join(',')) : [];
    if (reasons.length > 0) kept.push(`reasons=${reasons.join(',')}`);
  }
  return `${path}?${kept.join('&')}`;
}

/**
 * Where the registration goes next. A success carries the registry id (an identifier) so the page can read the entry and show
 * its masked reference; a failure carries a code. Nothing a person typed is ever part of the address.
 */
export function accountRegisteredUrl(outcome: AccountsOutcome): string {
  if (outcome.ok && outcome.created && UUID.test(outcome.created.id))
    return `/accounts?registered=${outcome.created.id}`;
  return outcome.ok
    ? '/accounts?error=bad_response'
    : `/accounts?error=${encodeURIComponent(safeErrorCode(outcome.code))}`;
}
