import { z } from 'zod';
import { type OnboardingApi } from '../onboarding/api.js';
import { type Operation } from '../onboarding/operations.js';

/**
 * Lender document forms. Each becomes one API call whose body the API validates strictly again. These forms only record what
 * the lender states or decides; Udofin never edits a figure and never approves a lender's document.
 */
const UUID = /^[0-9a-f-]{36}$/;
const lenderOnly = ['lender'] as const;
const anyUnknown = z.unknown();
const invalid = { ok: false as const, status: 422, code: 'validation_failed' };
const MAX_JSON = 400_000;
const MAX_FILE = 8 * 1024 * 1024;

const str = (form: FormData, name: string): string | undefined => {
  const v = form.get(name);
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
};
const uuid = (form: FormData, name: string): string | undefined => {
  const v = str(form, name);
  return v && UUID.test(v) ? v : undefined;
};

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

type Run = (api: OnboardingApi, form: FormData, key: string) => ReturnType<Operation['run']>;
const op = (run: Run): Operation => ({ portals: lenderOnly, run });

const REASONS = ['prepared_in_error', 'figures_changed', 'offer_changed', 'other'] as const;

export const DOCUMENT_OPERATIONS: Readonly<Record<string, Operation>> = {
  'document.kfs_data': op((api, form, key) => {
    const offerId = uuid(form, 'offerId');
    const mode = str(form, 'mode');
    const raw = str(form, 'data');
    if (
      !offerId ||
      (mode !== 'data' && mode !== 'declared_for_upload') ||
      !raw ||
      raw.length > MAX_JSON
    )
      return Promise.resolve(invalid);
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      return Promise.resolve({ ok: false as const, status: 422, code: 'kfs_data_invalid' });
    }
    if (typeof data !== 'object' || data === null || Array.isArray(data))
      return Promise.resolve(invalid);
    // Sent exactly as typed: the API and the database check structure and flag differences; nothing is corrected here.
    return api.post(`/v1/lender/offers/${offerId}/kfs-data`, anyUnknown, { mode, data }, key);
  }),
  'document.generate': op((api, form, key) => {
    const offerId = uuid(form, 'offerId');
    const inputId = uuid(form, 'inputId');
    const language = str(form, 'language');
    const documentType = str(form, 'documentType');
    if (
      !offerId ||
      !inputId ||
      (language !== 'en' && language !== 'hi') ||
      (documentType !== 'kfs' && documentType !== 'loan_agreement')
    ) {
      return Promise.resolve(invalid);
    }
    return api.post(
      `/v1/lender/offers/${offerId}/generation`,
      anyUnknown,
      { inputId, language, documentType },
      key,
    );
  }),
  'document.kfs_upload': op(async (api, form, key) => {
    const offerId = uuid(form, 'offerId');
    const inputId = uuid(form, 'inputId');
    const file = form.get('file');
    if (!offerId || !inputId || !(file instanceof File) || file.size === 0 || file.size > MAX_FILE)
      return invalid;
    const contentBase64 = toBase64(new Uint8Array(await file.arrayBuffer()));
    return api.post(
      `/v1/lender/offers/${offerId}/kfs-upload`,
      anyUnknown,
      { inputId, contentBase64 },
      key,
    );
  }),
  'document.approve': op((api, form, key) => {
    const id = uuid(form, 'id');
    const sha256 = str(form, 'sha256');
    // The reviewer must tick that they reviewed the file; the hash names exactly which file that was.
    if (!id || !sha256 || !/^[0-9a-f]{64}$/.test(sha256) || form.get('reviewed') !== 'on')
      return Promise.resolve(invalid);
    return api.post(`/v1/lender/documents/${id}/approve`, anyUnknown, { sha256 }, key);
  }),
  'document.issue': op((api, form, key) => {
    const id = uuid(form, 'id');
    return id
      ? api.post(`/v1/lender/documents/${id}/issue`, anyUnknown, {}, key)
      : Promise.resolve(invalid);
  }),
  'document.reject': op((api, form, key) => {
    const id = uuid(form, 'id');
    const reason = REASONS.find((r) => r === str(form, 'reason'));
    return id && reason
      ? api.post(`/v1/lender/documents/${id}/reject`, anyUnknown, { reason }, key)
      : Promise.resolve(invalid);
  }),
  'document.withdraw': op((api, form, key) => {
    const id = uuid(form, 'id');
    const reason = REASONS.find((r) => r === str(form, 'reason'));
    return id && reason
      ? api.post(`/v1/lender/documents/${id}/withdraw`, anyUnknown, { reason }, key)
      : Promise.resolve(invalid);
  }),
};
