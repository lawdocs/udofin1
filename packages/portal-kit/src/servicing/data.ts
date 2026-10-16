import {
  LS_LOAN_STATUSES,
  LsAnomalyPage,
  LsClosurePage,
  LsConflictPage,
  LsDocumentContent,
  LsDocumentList,
  LsDocumentRequestPage,
  LsImportBatchPage,
  LsImportDetail,
  LsLoanDetail,
  LsLoanPage,
  LsQuotePage,
  LsSyncStatus,
  type LsImportOutcome,
} from '@udofin/contracts';
import { type OnboardingApi } from '../onboarding/api.js';

// ---------------------------------------------------------------------------------------------------------------
// What the signed-in person may do, per lender. Hiding a form is a convenience: the API and the database decide.
// ---------------------------------------------------------------------------------------------------------------
export interface MembershipLike {
  organizationId: string;
  organizationKind: string;
  organizationName: string;
  permissions: readonly string[];
}

export interface ServicingGrant {
  lenderId: string;
  name: string;
  /** May read the loans of this lender (loan.read). */
  read: boolean;
  /** May set the LMS connection and apply or resolve (servicing.sync.manage). */
  syncManage: boolean;
  /** May upload an import file and discard a preview (servicing.manual_entry). */
  manualEntry: boolean;
  /** May register lender documents, decline requests, record quotations and confirm releases (servicing.document.issue). */
  documentIssue: boolean;
}

export type ServicingAbility = 'syncManage' | 'manualEntry' | 'documentIssue';

/** One grant per lender organisation the person belongs to. Platform memberships hold no lender grant, so they get no write form. */
export function servicingGrants(memberships: readonly MembershipLike[]): ServicingGrant[] {
  return memberships
    .filter((m) => m.organizationKind === 'lender')
    .map((m) => ({
      lenderId: m.organizationId,
      name: m.organizationName,
      read: m.permissions.includes('loan.read'),
      syncManage: m.permissions.includes('servicing.sync.manage'),
      manualEntry: m.permissions.includes('servicing.manual_entry'),
      documentIssue: m.permissions.includes('servicing.document.issue'),
    }));
}

/** Whether the person holds an ability in that lender. An unknown lender gives false. */
export const mayIn = (
  grants: readonly ServicingGrant[],
  lenderId: string,
  ability: ServicingAbility,
): boolean => grants.some((g) => g.lenderId === lenderId && g[ability]);

/** Lenders in which the person holds an ability (for a lender choice on a form). */
export const lendersWith = (
  grants: readonly ServicingGrant[],
  ability: ServicingAbility,
): ServicingGrant[] => grants.filter((g) => g[ability]);

/** The name of a lender organisation for "as reported by <lender>" wording. */
export const lenderNameOf = (grants: readonly ServicingGrant[], lenderId: string): string =>
  grants.find((g) => g.lenderId === lenderId)?.name ?? 'the lender';

// ---------------------------------------------------------------------------------------------------------------
// Page queries (from the URL). Anything that does not look right is dropped, never passed on.
// ---------------------------------------------------------------------------------------------------------------
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CURSOR = /^[A-Za-z0-9_-]{1,300}$/;

export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && UUID.test(value);

const one = (value: string | string[] | undefined): string | undefined =>
  typeof value === 'string' ? value : undefined;
const oneOf = <T extends string>(allowed: readonly T[], value: string | undefined) =>
  allowed.find((candidate) => candidate === value);

export interface ListQuery {
  cursor?: string;
  lenderId?: string;
  status?: string;
  kind?: string;
  severity?: string;
}

/** Reads the filters a list page understands from its URL. `allowed` names the closed values of the status/kind/severity filters. */
export function parseListQuery(
  raw: Record<string, string | string[] | undefined>,
  allowed: {
    status?: readonly string[];
    kind?: readonly string[];
    severity?: readonly string[];
  } = {},
): ListQuery {
  const cursor = one(raw.cursor);
  const lenderId = one(raw.lenderId);
  const status = allowed.status ? oneOf(allowed.status, one(raw.status)) : undefined;
  const kind = allowed.kind ? oneOf(allowed.kind, one(raw.kind)) : undefined;
  const severity = allowed.severity ? oneOf(allowed.severity, one(raw.severity)) : undefined;
  return {
    ...(cursor && CURSOR.test(cursor) ? { cursor } : {}),
    ...(isUuid(lenderId) ? { lenderId } : {}),
    ...(status ? { status } : {}),
    ...(kind ? { kind } : {}),
    ...(severity ? { severity } : {}),
  };
}

const qs = (params: Record<string, string | number | undefined>): string => {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
  return parts.length > 0 ? `?${parts.join('&')}` : '';
};

/** The query string for a link back to a list page with some filters (used for "older" links and filter links). */
export const listHref = (base: string, query: ListQuery): string =>
  `${base}${qs({
    status: query.status,
    kind: query.kind,
    severity: query.severity,
    lenderId: query.lenderId,
    cursor: query.cursor,
  })}`;

/** The same filters without the page position (for a link back to the first page). */
export const withoutCursor = (query: ListQuery): ListQuery => {
  const { cursor: _cursor, ...rest } = query;
  return rest;
};

// ---------------------------------------------------------------------------------------------------------------
// Loaders. Every response is checked against the contract by the API client; a failure is a code, never server text.
// ---------------------------------------------------------------------------------------------------------------
export const loadLoans = (api: OnboardingApi, query: ListQuery) =>
  api.get(
    `/v1/lender/loans${qs({ limit: 25, cursor: query.cursor, lenderId: query.lenderId, status: oneOf(LS_LOAN_STATUSES, query.status) })}`,
    LsLoanPage,
  );

export const loadLoanDetail = (api: OnboardingApi, id: string) =>
  api.get(`/v1/lender/loans/${id}`, LsLoanDetail);

export const loadLoanDocuments = (api: OnboardingApi, loanId: string) =>
  api.get(`/v1/lender/loans/${loanId}/documents`, LsDocumentList);

export const loadLoanQuotes = (api: OnboardingApi, loanId: string, cursor?: string) =>
  api.get(`/v1/lender/loans/${loanId}/foreclosure-quotes${qs({ limit: 10, cursor })}`, LsQuotePage);

export const loadDocumentRequests = (
  api: OnboardingApi,
  query: { loanAccountId?: string; status?: string; cursor?: string; lenderId?: string },
) =>
  api.get(
    `/v1/lender/document-requests${qs({ limit: 25, loanAccountId: query.loanAccountId, status: query.status, cursor: query.cursor, lenderId: query.lenderId })}`,
    LsDocumentRequestPage,
  );

export const loadSyncStatus = (api: OnboardingApi, lenderId?: string) =>
  api.get(`/v1/lender/sync/status${qs({ lenderId })}`, LsSyncStatus);

export const loadImports = (api: OnboardingApi, query: ListQuery) =>
  api.get(
    `/v1/lender/imports${qs({ limit: 25, cursor: query.cursor, lenderId: query.lenderId, kind: query.kind, status: query.status })}`,
    LsImportBatchPage,
  );

export const loadImport = (api: OnboardingApi, id: string) =>
  api.get(`/v1/lender/imports/${id}`, LsImportDetail);

export const loadConflicts = (api: OnboardingApi, query: ListQuery & { loanAccountId?: string }) =>
  api.get(
    `/v1/lender/sync/conflicts${qs({ limit: 25, cursor: query.cursor, lenderId: query.lenderId, loanAccountId: query.loanAccountId, status: query.status })}`,
    LsConflictPage,
  );

export const loadAnomalies = (api: OnboardingApi, query: ListQuery & { loanAccountId?: string }) =>
  api.get(
    `/v1/lender/sync/anomalies${qs({ limit: 25, cursor: query.cursor, lenderId: query.lenderId, loanAccountId: query.loanAccountId, severity: query.severity })}`,
    LsAnomalyPage,
  );

export const loadClosures = (api: OnboardingApi, query: ListQuery) =>
  api.get(
    `/v1/lender/closures${qs({ limit: 25, cursor: query.cursor, lenderId: query.lenderId })}`,
    LsClosurePage,
  );

/** The exact stored file; the API compared its SHA-256 with the recorded one before returning it. */
export const loadDocumentContent = (
  api: OnboardingApi,
  loanId: string,
  documentId: string,
  purpose: 'view' | 'download' = 'view',
) =>
  api.get(
    `/v1/lender/loans/${loanId}/documents/${documentId}/content?purpose=${purpose}`,
    LsDocumentContent,
  );

// ---------------------------------------------------------------------------------------------------------------
// Opening a document: decode and check the bytes once more before they are streamed.
// ---------------------------------------------------------------------------------------------------------------
const hex = (bytes: ArrayBuffer): string =>
  [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * The API already compared the stored bytes with the recorded SHA-256. This checks the same two facts again on arrival (the
 * size and the SHA-256 of the decoded bytes) so a damaged or substituted answer is never streamed. Returns null if either differs.
 */
export async function verifiedDocumentBytes(content: {
  contentBase64: string;
  sha256: string;
  sizeBytes: number;
}): Promise<Uint8Array<ArrayBuffer> | null> {
  if (
    !/^[A-Za-z0-9+/]+={0,2}$/.test(content.contentBase64) ||
    content.contentBase64.length % 4 !== 0
  )
    return null;
  const binary = atob(content.contentBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  if (bytes.length !== content.sizeBytes) return null;
  const digest = hex(await crypto.subtle.digest('SHA-256', bytes));
  return digest === content.sha256 ? bytes : null;
}

// ---------------------------------------------------------------------------------------------------------------
// The result of staging a file, as a plain object the browser can hold (the upload form shows it).
// ---------------------------------------------------------------------------------------------------------------
export type StageState =
  | { status: 'idle' }
  | { status: 'error'; code: string }
  | { status: 'staged'; batchId: string; existing: boolean }
  | {
      status: 'refused';
      fileSha256: string;
      byteSize: number;
      recordCount: number;
      errors: LsImportOutcome['errors'];
      errorsTruncated: boolean;
    };

/** Maps the API's answer to staging a file to what the page shows next. A refused file has no batch; its problems are shown at once. */
export function stageStateFrom(outcome: LsImportOutcome): StageState {
  if (outcome.batch)
    return { status: 'staged', batchId: outcome.batch.id, existing: outcome.existing };
  if (outcome.refusedFile) {
    return {
      status: 'refused',
      fileSha256: outcome.refusedFile.fileSha256,
      byteSize: outcome.refusedFile.byteSize,
      recordCount: outcome.refusedFile.recordCount,
      errors: outcome.errors,
      errorsTruncated: outcome.errorsTruncated,
    };
  }
  return { status: 'error', code: 'bad_response' };
}
