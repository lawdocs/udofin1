import { type ApiClient } from '@udofin/auth-client';
import {
  SvcActivityPage,
  SvcClosureResult,
  SvcDocumentRequestList,
  SvcDocumentRequestResult,
  SvcLatestQuote,
  SvcLoan,
  SvcLoanDocumentContent,
  SvcLoanDocumentList,
  SvcLoanList,
  SvcReminderList,
  SvcReminderRead,
  SvcSchedule,
} from '@udofin/contracts';
import { newIdempotencyKey } from './form';

/** The page size the activity screen asks for. The API accepts 1 to 50 and defaults to 25. */
export const ACTIVITY_PAGE_SIZE = 25;

const enc = encodeURIComponent;

/**
 * Typed calls for the loan screens (Phase 08a, borrower side). Every call goes through the generic API client, whose path
 * allow-list keeps /v1/me, /v1/admin and /v1/platform unreachable on purpose. Identifiers are opaque ids and the activity
 * cursor is opaque text: no personal data is ever put in a URL. The responses are checked against the shared contracts, so a
 * server answer of the wrong shape becomes a `bad_response` code and never reaches a screen.
 *
 * Writes need an Idempotency-Key. Each key belongs to ONE user action: the caller keeps it while a lost answer is retried and
 * makes a new one for the next action (see `keyAfter`). Nothing here has a default key, so a write cannot silently reuse one.
 */
export function createServicingClient(api: ApiClient) {
  return {
    loans: () => api.get('/v1/loans', SvcLoanList),
    loan: (loanId: string) => api.get(`/v1/loans/${enc(loanId)}`, SvcLoan),
    schedule: (loanId: string) => api.get(`/v1/loans/${enc(loanId)}/schedule`, SvcSchedule),
    /** One page of the activity. `cursor` is the opaque `nextCursor` of the page before it, passed back unchanged. */
    activity: (loanId: string, cursor?: string, limit: number = ACTIVITY_PAGE_SIZE) =>
      api.get(
        `/v1/loans/${enc(loanId)}/activity?limit=${String(limit)}${cursor ? `&cursor=${enc(cursor)}` : ''}`,
        SvcActivityPage,
      ),
    documents: (loanId: string) =>
      api.get(`/v1/loans/${enc(loanId)}/documents`, SvcLoanDocumentList),
    /** The lender's file, through the authenticated content route (never a stored or public link). */
    documentContent: (loanId: string, documentId: string, purpose: 'view' | 'download' = 'view') =>
      api.get(
        `/v1/loans/${enc(loanId)}/documents/${enc(documentId)}/content?purpose=${purpose}`,
        SvcLoanDocumentContent,
      ),
    documentRequests: (loanId: string) =>
      api.get(`/v1/loans/${enc(loanId)}/document-requests`, SvcDocumentRequestList),
    /** Both dates or neither (the whole history). The API checks the period itself. */
    requestStatement: (
      loanId: string,
      period: { periodFrom: string; periodTo: string } | null,
      idempotencyKey: string,
    ) =>
      api.post(
        `/v1/loans/${enc(loanId)}/statements`,
        SvcDocumentRequestResult,
        period ?? {},
        idempotencyKey,
      ),
    cancelDocumentRequest: (loanId: string, requestId: string, idempotencyKey: string) =>
      api.post(
        `/v1/loans/${enc(loanId)}/document-requests/${enc(requestId)}/cancel`,
        SvcDocumentRequestResult,
        {},
        idempotencyKey,
      ),
    requestForeclosureQuote: (loanId: string, idempotencyKey: string) =>
      api.post(
        `/v1/loans/${enc(loanId)}/foreclosure-quotes`,
        SvcDocumentRequestResult,
        {},
        idempotencyKey,
      ),
    latestQuote: (loanId: string) =>
      api.get(`/v1/loans/${enc(loanId)}/foreclosure-quotes/latest`, SvcLatestQuote),
    closure: (loanId: string) => api.get(`/v1/loans/${enc(loanId)}/closure`, SvcClosureResult),
    reminders: () => api.get('/v1/me/reminders', SvcReminderList),
    markReminderRead: (reminderId: string, idempotencyKey: string) =>
      api.post(`/v1/me/reminders/${enc(reminderId)}/read`, SvcReminderRead, {}, idempotencyKey),
  };
}
export type ServicingClient = ReturnType<typeof createServicingClient>;

/** A new key for a new user action. */
export const newActionKey = (): string => newIdempotencyKey();

/**
 * The key to use for the NEXT attempt after an attempt finished. A lost answer (offline, timed out) may have been processed, so
 * the same key is kept and the retry finds the first attempt's result. Anything else (success, or an answer from the server)
 * ends that action: the next tap is a new action with a new key.
 */
export function keyAfter(
  outcome: { ok: true } | { ok: false; code: string },
  current: string,
  make: () => string = newActionKey,
): string {
  if (!outcome.ok && outcome.code === 'network_error') return current;
  return make();
}
