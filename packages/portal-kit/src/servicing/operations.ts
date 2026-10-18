import {
  LS_COLLATERAL_TYPES,
  LS_CONNECTION_STATUSES,
  LS_DOCUMENT_KINDS,
  LS_DOCUMENT_MAX_BYTES,
  LS_IMPORT_FILE_FORMATS,
  LS_IMPORT_FORMAT,
  LS_IMPORT_KINDS,
  LS_IMPORT_MAX_CHARS,
  LsImportOutcome,
} from '@udofin/contracts';
import { z } from 'zod';
import { type OnboardingApi } from '../onboarding/api.js';
import { stageStateFrom, type StageState } from './data.js';
import { istLocalToInstant, parseRupeesToPaise, realDate } from './format.js';
import { CAPABILITY_KEYS, safeErrorCode } from './wording.js';

/**
 * The only writes the lender servicing screens can make. A form names one operation; this table maps it to exactly one API
 * route with the fields checked again here. Anything not listed cannot be invoked from the portal, and the API and the
 * database authorise and validate every call again, so this list narrows the surface, it is not the authority.
 *
 * Nothing here computes a figure. The amounts of a quotation are the lender's own and are sent as typed (parsed into whole paise,
 * never rounded or totalled).
 */

type Fail = { ok: false; status: number; code: string };
export type ServicingResult = { ok: true; status: number; data: unknown } | Fail;
export interface ServicingOperation {
  run(api: OnboardingApi, form: FormData, key: string): Promise<ServicingResult>;
}

const bad = (code = 'validation_failed'): Fail => ({ ok: false, status: 422, code });
const anyResponse = z.unknown();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REFERENCE = /^[A-Za-z0-9._/-]{1,100}$/;
const CONFIRMATION_REF = /^[A-Za-z0-9._/-]{3,100}$/;
const EVIDENCE_KEY = /^[a-z][a-z0-9_]{1,40}$/;

/** A file larger than this is not read at all (the transport limit of the portal is 9 MiB for the whole form). */
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
/** The importer refuses a file over 5 MiB and writes an audit record of the refusal; this only mirrors the number for the screen. */
export const IMPORT_MAX_BYTES = 5 * 1024 * 1024;
export const IMPORT_MAX_RECORDS = 10_000;
export const EVIDENCE_SLOTS = 3;

const str = (form: FormData, name: string): string | undefined => {
  const v = form.get(name);
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
};
const uuid = (form: FormData, name: string): string | undefined => {
  const v = str(form, name);
  return v && UUID.test(v) ? v : undefined;
};
const oneOf = <T extends string>(allowed: readonly T[], value: string | undefined): T | undefined =>
  allowed.find((candidate) => candidate === value);

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

type FileRead = { ok: true; bytes: Uint8Array } | Fail;
async function readFile(form: FormData, name: string): Promise<FileRead> {
  const file = form.get(name);
  if (!(file instanceof File)) return bad('file_required');
  if (file.size === 0) return bad('file_empty');
  if (file.size > MAX_UPLOAD_BYTES) return bad('file_too_large');
  return { ok: true, bytes: new Uint8Array(await file.arrayBuffer()) };
}

/** Text of 10 to `max` characters (after trimming), or undefined. */
const note = (form: FormData, name: string, max: number): string | undefined => {
  const v = str(form, name);
  return v && v.length >= 10 && v.length <= max ? v : undefined;
};

const post = (api: OnboardingApi, path: string, body: unknown, key: string) =>
  api.post(path, anyResponse, body, key);

export const SERVICING_OPERATIONS: Readonly<Record<string, ServicingOperation>> = {
  // ---- LMS connection ---------------------------------------------------------------------------------------------
  'servicing.connection.set': {
    run: (api, form, key) => {
      const lenderId = uuid(form, 'lenderId');
      const kind = oneOf(['file_import', 'manual'] as const, str(form, 'kind'));
      const status = oneOf(
        LS_CONNECTION_STATUSES.filter((s) => s !== 'blocked_unverified'),
        str(form, 'status'),
      );
      const minutesText = str(form, 'stalenessThresholdMinutes');
      const minutes = minutesText && /^\d{1,5}$/.test(minutesText) ? Number(minutesText) : NaN;
      if (!lenderId || !kind || !status || !(minutes >= 5 && minutes <= 43200))
        return Promise.resolve(bad());
      // The lender declares what its system can do; every flag is sent as ticked or unticked, nothing is assumed.
      const capabilities = Object.fromEntries(
        CAPABILITY_KEYS.map((name) => [name, form.get(`cap_${name}`) === 'on']),
      );
      return post(
        api,
        '/v1/lender/lms-connection',
        { lenderId, kind, status, capabilities, stalenessThresholdMinutes: minutes },
        key,
      );
    },
  },

  // ---- File import: stage (preview), commit, reject ----------------------------------------------------------------
  'servicing.import.stage': {
    run: async (api, form, key) => {
      const lenderId = uuid(form, 'lenderId');
      const kind = oneOf(LS_IMPORT_KINDS, str(form, 'kind'));
      const fileFormat = oneOf(LS_IMPORT_FILE_FORMATS, str(form, 'fileFormat'));
      const resubmission = str(form, 'resubmissionOf');
      if (!lenderId || !kind || !fileFormat || (resubmission && !UUID.test(resubmission)))
        return bad();
      const read = await readFile(form, 'file');
      if (!read.ok) return read;
      let content: string;
      try {
        // Exact text of the file, byte for byte; a leading byte-order mark is kept for the importer, which ignores it.
        content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(read.bytes);
      } catch {
        return bad('file_not_text');
      }
      if (content.length > LS_IMPORT_MAX_CHARS) return bad('file_too_large');
      return api.post(
        '/v1/lender/imports',
        LsImportOutcome,
        {
          lenderId,
          kind,
          sourceKind: 'file',
          formatVersion: LS_IMPORT_FORMAT,
          fileFormat,
          content,
          ...(resubmission ? { resubmissionOf: resubmission } : {}),
        },
        key,
      );
    },
  },
  'servicing.import.commit': {
    run: (api, form, key) => {
      const id = uuid(form, 'id');
      if (!id) return Promise.resolve(bad());
      // Applying is an explicit step: the person ticks that they reviewed this preview.
      if (form.get('reviewed') !== 'on') return Promise.resolve(bad('review_required'));
      return post(api, `/v1/lender/imports/${id}/commit`, {}, key);
    },
  },
  'servicing.import.reject': {
    run: (api, form, key) => {
      const id = uuid(form, 'id');
      const reason = note(form, 'reason', 1000);
      if (!id) return Promise.resolve(bad());
      if (!reason) return Promise.resolve(bad('reason_required'));
      return post(api, `/v1/lender/imports/${id}/reject`, { reason }, key);
    },
  },

  // ---- Conflicts -------------------------------------------------------------------------------------------------
  'servicing.conflict.acknowledge': {
    run: (api, form, key) => {
      const id = uuid(form, 'id');
      return id
        ? post(api, `/v1/lender/sync/conflicts/${id}/acknowledge`, {}, key)
        : Promise.resolve(bad());
    },
  },
  'servicing.conflict.resolve': {
    run: (api, form, key) => {
      const id = uuid(form, 'id');
      const confirmedVersion = oneOf(
        ['existing', 'incoming'] as const,
        str(form, 'confirmedVersion'),
      );
      const text = note(form, 'note', 1000);
      if (!id || !confirmedVersion) return Promise.resolve(bad());
      if (!text) return Promise.resolve(bad('reason_required'));
      const evidence: Record<string, string> = {};
      for (let slot = 1; slot <= EVIDENCE_SLOTS; slot++) {
        const label = str(form, `evidenceLabel${String(slot)}`);
        const value = str(form, `evidenceValue${String(slot)}`);
        if (!label && !value) continue;
        // A label without a reference, a reference without a label, a repeated label or an over-long reference is refused.
        if (
          !label ||
          !value ||
          !EVIDENCE_KEY.test(label) ||
          value.length > 200 ||
          label in evidence
        )
          return Promise.resolve(bad('evidence_invalid'));
        evidence[label] = value;
      }
      if (Object.keys(evidence).length === 0) return Promise.resolve(bad('evidence_invalid'));
      return post(
        api,
        `/v1/lender/sync/conflicts/${id}/resolve`,
        { confirmedVersion, note: text, evidence },
        key,
      );
    },
  },

  // ---- Documents and quotations ----------------------------------------------------------------------------------
  'servicing.document.register': {
    run: async (api, form, key) => {
      const loanId = uuid(form, 'loanId');
      const kind = oneOf(LS_DOCUMENT_KINDS, str(form, 'kind'));
      const lenderReference = str(form, 'lenderReference');
      const issuedAt = istLocalToInstant(str(form, 'issuedAt') ?? '');
      if (!loanId || !kind) return bad();
      if (!lenderReference || !REFERENCE.test(lenderReference)) return bad('reference_invalid');
      if (!issuedAt) return bad('time_invalid');
      const periodFromText = str(form, 'periodFrom');
      const periodToText = str(form, 'periodTo');
      const periodFrom = periodFromText ? realDate(periodFromText) : undefined;
      const periodTo = periodToText ? realDate(periodToText) : undefined;
      if ((periodFromText && !periodFrom) || (periodToText && !periodTo))
        return bad('date_invalid');
      const supersedes = str(form, 'supersedesDocumentId');
      const requestId = str(form, 'requestId');
      if ((supersedes && !UUID.test(supersedes)) || (requestId && !UUID.test(requestId)))
        return bad();
      const read = await readFile(form, 'file');
      if (!read.ok) return read;
      if (read.bytes.length > LS_DOCUMENT_MAX_BYTES) return bad('document_too_large');
      // Only a PDF is accepted; the API checks the content again and refuses a PDF that carries scripts or attachments.
      if (String.fromCharCode(...read.bytes.subarray(0, 5)) !== '%PDF-') return bad('file_not_pdf');
      return post(
        api,
        `/v1/lender/loans/${loanId}/documents`,
        {
          kind,
          mimeType: 'application/pdf',
          contentBase64: toBase64(read.bytes),
          lenderReference,
          issuedAt,
          ...(periodFrom ? { periodFrom } : {}),
          ...(periodTo ? { periodTo } : {}),
          ...(supersedes ? { supersedesDocumentId: supersedes } : {}),
          ...(requestId ? { requestId } : {}),
        },
        key,
      );
    },
  },
  'servicing.request.decline': {
    run: (api, form, key) => {
      const id = uuid(form, 'id');
      const text = note(form, 'note', 500);
      if (!id) return Promise.resolve(bad());
      if (!text) return Promise.resolve(bad('note_invalid'));
      return post(api, `/v1/lender/document-requests/${id}/decline`, { note: text }, key);
    },
  },
  'servicing.quote.record': {
    run: (api, form, key) => {
      const loanId = uuid(form, 'loanId');
      const lenderQuoteRef = str(form, 'lenderQuoteRef');
      const asOf = istLocalToInstant(str(form, 'asOf') ?? '');
      const validUntil = istLocalToInstant(str(form, 'validUntil') ?? '');
      if (!loanId) return Promise.resolve(bad());
      if (!lenderQuoteRef || !REFERENCE.test(lenderQuoteRef))
        return Promise.resolve(bad('reference_invalid'));
      if (!asOf || !validUntil) return Promise.resolve(bad('time_invalid'));
      // The five figures are the lender's own: parsed into whole paise exactly as typed, never rounded, never totalled here.
      const names = ['principal', 'interest', 'charges', 'prepaymentCharge', 'total'] as const;
      const amounts = names.map((name) => parseRupeesToPaise(str(form, name) ?? ''));
      if (amounts.some((a) => a === null)) return Promise.resolve(bad('amount_invalid'));
      const [principalMinor, interestMinor, chargesMinor, prepaymentChargeMinor, totalMinor] =
        amounts as [number, number, number, number, number];
      const requestId = str(form, 'requestId');
      const letterDocumentId = str(form, 'letterDocumentId');
      if (
        (requestId && !UUID.test(requestId)) ||
        (letterDocumentId && !UUID.test(letterDocumentId))
      )
        return Promise.resolve(bad());
      return post(
        api,
        `/v1/lender/loans/${loanId}/foreclosure-quotes`,
        {
          lenderQuoteRef,
          asOf,
          validUntil,
          principalMinor,
          interestMinor,
          chargesMinor,
          prepaymentChargeMinor,
          totalMinor,
          ...(requestId ? { requestId } : {}),
          ...(letterDocumentId ? { letterDocumentId } : {}),
        },
        key,
      );
    },
  },

  // ---- Closure and security release --------------------------------------------------------------------------------
  'servicing.closure.open': {
    run: (api, form, key) => {
      const loanId = uuid(form, 'loanId');
      const chosen = form
        .getAll('collateralTypes')
        .filter((v): v is string => typeof v === 'string');
      const types = [...new Set(chosen)];
      const valid = types.every((t) => oneOf(LS_COLLATERAL_TYPES, t) !== undefined);
      if (!loanId) return Promise.resolve(bad());
      if (types.length < 1 || types.length > 5 || !valid)
        return Promise.resolve(bad('collateral_types_invalid'));
      return post(
        api,
        `/v1/lender/loans/${loanId}/security-release-tasks`,
        { collateralTypes: types },
        key,
      );
    },
  },
  'servicing.closure.confirm': {
    run: (api, form, key) => {
      const taskId = uuid(form, 'taskId');
      const confirmationRef = str(form, 'confirmationRef');
      if (!taskId) return Promise.resolve(bad());
      if (!confirmationRef || !CONFIRMATION_REF.test(confirmationRef))
        return Promise.resolve(bad('confirmation_ref_invalid'));
      return post(api, `/v1/lender/security-release/${taskId}/confirm`, { confirmationRef }, key);
    },
  },
  'servicing.closure.delay': {
    run: (api, form, key) => {
      const taskId = uuid(form, 'taskId');
      const reason = note(form, 'reason', 500);
      if (!taskId) return Promise.resolve(bad());
      if (!reason) return Promise.resolve(bad('reason_invalid'));
      return post(api, `/v1/lender/security-release/${taskId}/delay-reason`, { reason }, key);
    },
  },
};

export type ServicingOutcome = { ok: true; stage?: StageState } | { ok: false; code: string };

const KEY = /^[A-Za-z0-9._:-]{16,128}$/;
const STAGE_OPERATION = 'servicing.import.stage';
const COMMIT_OPERATION = 'servicing.import.commit';
const REGISTER_OPERATION = 'servicing.document.register';

/**
 * How long the portal waits for the API on the operations that carry or process a whole file. Staging checks every record,
 * applying writes them, and registering a document posts a PDF of up to 8 MiB as a JSON body of about 11 MB. The generic client
 * limit (10 s) cut these off while the API was still working and showed a false failure. The limit is bounded: a call that
 * takes longer than this is reported as "result unknown", never waited for without end.
 */
export const SERVICING_LONG_TIMEOUT_MS = 60_000;

/** The API timeout an operation needs, or undefined for the client's own default (small writes). */
export function servicingTimeoutMs(name: unknown): number | undefined {
  return name === STAGE_OPERATION || name === COMMIT_OPERATION || name === REGISTER_OPERATION
    ? SERVICING_LONG_TIMEOUT_MS
    : undefined;
}

/**
 * Runs the operation a form names. Unknown operations are refused without any call to the API. A caller that serves one
 * kind of form only (the file upload) passes `only`, and then the form's own `op` field is ignored.
 */
export async function runServicingOperation(
  api: OnboardingApi,
  form: FormData,
  only?: string,
): Promise<ServicingOutcome> {
  const name = only ?? form.get('op');
  const key = form.get('key');
  const operation =
    typeof name === 'string' && Object.hasOwn(SERVICING_OPERATIONS, name)
      ? SERVICING_OPERATIONS[name]
      : undefined;
  if (!operation) return { ok: false, code: 'path_not_allowed' };
  // Staging a file has its own entry point, which shows a refused file's problems; the general one does not serve it.
  if (name === STAGE_OPERATION && only !== STAGE_OPERATION)
    return { ok: false, code: 'path_not_allowed' };
  if (typeof key !== 'string' || !KEY.test(key)) return { ok: false, code: 'validation_failed' };
  const result = await operation.run(api, form, key);
  if (!result.ok) {
    // A write that got no answer (timeout or a dropped connection) may still have been applied: the person is told to check,
    // never that nothing happened.
    if (
      (name === COMMIT_OPERATION || name === REGISTER_OPERATION) &&
      result.code === 'network_error'
    )
      return { ok: false, code: 'result_unknown' };
    return { ok: false, code: safeErrorCode(result.code) };
  }
  const outcome = LsImportOutcome.safeParse(result.data);
  // A commit that fails inside the database is an HTTP 200 whose batch says "failed": nothing was applied, so it is not
  // reported as done.
  if (name === COMMIT_OPERATION && outcome.success && outcome.data.batch?.status === 'failed')
    return { ok: false, code: 'import_apply_failed' };
  return name === STAGE_OPERATION && outcome.success
    ? { ok: true, stage: stageStateFrom(outcome.data) }
    : { ok: true };
}

/** Where a form may return to: the lender servicing pages only (prevents an open redirect). */
export function safeServicingReturnPath(value: unknown): string {
  const QUERY = String.raw`(?:\?[A-Za-z0-9=&_.%-]{1,700})?`;
  const ID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  const allowed = new RegExp(
    `^/(?:loans(?:/closures|/requests|/${ID})?|imports(?:/conflicts|/anomalies|/${ID})?)${QUERY}$`,
  );
  return typeof value === 'string' && allowed.test(value) ? value : '/loans';
}

/** The page address to go back to after an action, with the result as `done=1` or a short `error` code (nothing else). */
export function noticeUrl(
  returnTo: string,
  outcome: { ok: true } | { ok: false; code: string },
): string {
  const [path = '/loans', query = ''] = returnTo.split('?', 2);
  const kept = query.split('&').filter((part) => part !== '' && !/^(done|error)=/.test(part));
  kept.push(outcome.ok ? 'done=1' : `error=${encodeURIComponent(safeErrorCode(outcome.code))}`);
  return `${path}?${kept.join('&')}`;
}
