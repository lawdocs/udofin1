import {
  ChangeRequestDecision,
  ChangeRequestPage,
  MeResponse,
  type ChangeRequestDecision as ChangeRequestDecisionType,
  type ChangeRequestPage as ChangeRequestPageType,
  type MeResponse as MeResponseType,
} from '@udofin/contracts';
import { z, type ZodType } from 'zod';

export type ApiResult<T> =
  { ok: true; status: number; data: T } | { ok: false; status: number; code: string };

export interface ApiClientOptions {
  baseUrl: string;
  /** Returns a usable access token, or null when signed out. */
  getAccessToken: () => Promise<string | null>;
  /** Called on 401 for a token we believed valid; return true if a new token is available to retry with. */
  onUnauthorised?: () => Promise<boolean>;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const ProblemBody = z.object({ code: z.string().optional() });

/**
 * Typed client for the Udofin API. Response bodies are validated against the shared contracts, so a
 * server change that breaks a client is caught here instead of rendering wrong data. Failures come
 * back as codes (including `network_error`), never as thrown exceptions or raw server text.
 */
export function createApiClient(options: ApiClientOptions) {
  const base = options.baseUrl.replace(/\/$/, '');
  const doFetch = options.fetch ?? fetch;

  async function request<T>(
    method: 'GET' | 'POST',
    path: string,
    schema: ZodType<T>,
    init: { body?: unknown; idempotencyKey?: string } = {},
    retried = false,
  ): Promise<ApiResult<T>> {
    const token = await options.getAccessToken();
    if (!token) return { ok: false, status: 401, code: 'signed_out' };
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(init.idempotencyKey ? { 'idempotency-key': init.idempotencyKey } : {}),
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      });
    } catch {
      return { ok: false, status: 0, code: 'network_error' };
    }
    if (response.status === 401 && !retried && options.onUnauthorised) {
      const code = await readCode(response);
      // mfa_required is a real answer, not a stale token.
      if (code !== 'mfa_required' && (await options.onUnauthorised())) {
        return request(method, path, schema, init, true);
      }
      return { ok: false, status: 401, code };
    }
    if (!response.ok) return { ok: false, status: response.status, code: await readCode(response) };
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      return { ok: false, status: response.status, code: 'bad_response' };
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) return { ok: false, status: response.status, code: 'bad_response' };
    return { ok: true, status: response.status, data: parsed.data };
  }

  return {
    me: (): Promise<ApiResult<MeResponseType>> => request('GET', '/v1/me', MeResponse),
    /** Generic reads and writes for the onboarding screens (paths are restricted to the onboarding, lender and borrower-app prefixes). */
    get: <T>(path: string, schema: ZodType<T>): Promise<ApiResult<T>> =>
      onboardingPath(path) ? request('GET', path, schema) : Promise.resolve(blocked()),
    post: <T>(
      path: string,
      schema: ZodType<T>,
      body: unknown,
      idempotencyKey: string,
    ): Promise<ApiResult<T>> =>
      onboardingPath(path)
        ? request('POST', path, schema, { body, idempotencyKey })
        : Promise.resolve(blocked()),
    listChangeRequests: (
      query: { cursor?: string; limit?: number } = {},
    ): Promise<ApiResult<ChangeRequestPageType>> => {
      const params = new URLSearchParams();
      if (query.cursor) params.set('cursor', query.cursor);
      if (query.limit) params.set('limit', String(query.limit));
      const qs = params.size > 0 ? `?${params.toString()}` : '';
      return request('GET', `/v1/admin/change-requests${qs}`, ChangeRequestPage);
    },
    decideChangeRequest: (
      id: string,
      verb: 'approve' | 'reject',
      idempotencyKey: string,
      note?: string,
    ): Promise<ApiResult<ChangeRequestDecisionType>> =>
      request(
        'POST',
        `/v1/admin/change-requests/${encodeURIComponent(id)}/${verb}`,
        ChangeRequestDecision,
        {
          body: note ? { note } : {},
          idempotencyKey,
        },
      ),
  };
}

// Only portal onboarding/lender paths and the borrower-app paths are reachable through the generic calls.
const ONBOARDING_PATH =
  /^\/v1\/(?:(?:onboarding|lender)\/|(?:borrower|consent|loan-requests|stepup|integrity)(?:\/|\?|$)|loan-purposes(?:\?|$))[A-Za-z0-9/_?=&.,%-]*$/;
const onboardingPath = (path: string): boolean =>
  ONBOARDING_PATH.test(path) && !path.includes('..') && !/%2e/i.test(path);
const blocked = (): { ok: false; status: number; code: string } => ({
  ok: false,
  status: 0,
  code: 'path_not_allowed',
});

async function readCode(response: Response): Promise<string> {
  try {
    const parsed = ProblemBody.safeParse(await response.json());
    return parsed.success && parsed.data.code
      ? parsed.data.code
      : `http_${String(response.status)}`;
  } catch {
    return `http_${String(response.status)}`;
  }
}

export type ApiClient = ReturnType<typeof createApiClient>;
