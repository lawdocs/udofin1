import { type ZodType } from 'zod';

/**
 * The operations portal's connection to the platform-staff routes of the API (providers, the account registry, feature
 * switches and the platform exception queue).
 *
 * Why this exists next to the generic client of @udofin/auth-client: that client deliberately cannot reach /v1/platform (the
 * borrower app and the lender portal share it, and a path it can reach is a path they can reach). The operations portal needs
 * exactly these routes and no others, so this client carries its own allow-list of exactly the routes the screens call. It runs
 * on the server only, speaks as the signed-in person (their own token, their second factor) and never retries a request: a
 * retry of the account registration would send the account number a second time.
 *
 * What it never does: put anything but an identifier in a path, log anything, or return text the server wrote. A failure is
 * a short code; the only other detail kept is the list of unmet-prerequisite codes some refusals carry (stable identifiers,
 * filtered to the shape of an identifier).
 */

export type PlatformFailure = {
  ok: false;
  status: number;
  code: string;
  /** Stable reason identifiers of a refusal that lists them (unmet prerequisites). Never free text. */
  reasons?: readonly string[];
};
export type PlatformResult<T> = { ok: true; status: number; data: T } | PlatformFailure;

export interface PlatformApi {
  get<T>(path: string, schema: ZodType<T>): Promise<PlatformResult<T>>;
  post<T>(
    path: string,
    schema: ZodType<T>,
    body: unknown,
    idempotencyKey: string,
  ): Promise<PlatformResult<T>>;
}

export interface PlatformClientOptions {
  baseUrl: string;
  /** The signed-in person's access token, or null when signed out. */
  getAccessToken: () => Promise<string | null>;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const ID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const QUERY = String.raw`(?:\?[A-Za-z0-9=&_.%-]{1,700})?`;

/** The routes the screens read. */
const GET_PATHS = new RegExp(
  `^/v1/(?:` +
    [
      'platform/payment-providers',
      'platform/return-code-classes',
      'platform/account-format-rules',
      'platform/fingerprint-key-versions',
      `platform/accounts(?:/${ID})?`,
      'platform/settlement-accounts',
      'platform/merchants',
      'platform/features',
      `platform/lenders/${ID}/features`,
      'platform/feature-change-requests',
      'platform/exceptions',
      `lender/reconciliation/exceptions(?:/${ID})?`,
    ].join('|') +
    `)${QUERY}$`,
);

/** The routes the screens write. The registration of an account is the one POST that carries an account number. */
const POST_PATHS = new RegExp(
  `^/v1/(?:` +
    [
      'platform/payment-providers',
      'platform/return-code-classes',
      'platform/account-format-rules',
      `platform/account-format-rules/${ID}/(?:submit|approve|retire)`,
      'platform/fingerprint-key-versions',
      `platform/fingerprint-key-versions/[0-9]{1,4}/approve`,
      'platform/accounts',
      `platform/accounts/${ID}/(?:verify|reject|revoke)`,
      `platform/settlement-accounts/${ID}/link`,
      `platform/merchants/${ID}/(?:verify|revoke)`,
      'platform/udofin-fee-merchants',
      'platform/feature-change-requests',
      `platform/feature-change-requests/${ID}/(?:decide|cancel)`,
      'platform/features/kill',
      `lender/reconciliation/exceptions/${ID}/(?:acknowledge|assign|resolve|reopen)`,
    ].join('|') +
    `)$`,
);

/** Whether the client would send a GET to this path. Exported so the allow-list can be tested on its own. */
export const isPlatformReadPath = (path: string): boolean =>
  GET_PATHS.test(path) && !path.includes('..');
/** Whether the client would send a POST to this path. */
export const isPlatformWritePath = (path: string): boolean =>
  POST_PATHS.test(path) && !path.includes('..');

const blocked = (): PlatformFailure => ({ ok: false, status: 0, code: 'path_not_allowed' });
const CODE = /^[a-z][a-z0-9_]{1,59}$/;
const REASON = /^[a-z][a-z0-9_]{1,63}$/;
/** Only these refusals list reasons; the list is read from the problem detail, which reads "Reasons: a, b". */
const CODES_WITH_REASONS: ReadonlySet<string> = new Set([
  'prerequisites_unmet',
  'collection_target_invalid',
]);

/** Reads the stable code (and, for the two refusals that list them, the reason identifiers) of a problem answer. */
export async function readProblem(
  response: Response,
): Promise<{ code: string; reasons?: string[] }> {
  const fallback = `http_${String(response.status)}`;
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { code: fallback };
  }
  if (typeof body !== 'object' || body === null) return { code: fallback };
  const record = body as Record<string, unknown>;
  const code = typeof record.code === 'string' && CODE.test(record.code) ? record.code : fallback;
  if (!CODES_WITH_REASONS.has(code) || typeof record.detail !== 'string') return { code };
  const match = /^Reasons: (.{1,800})$/.exec(record.detail);
  const reasons = (match?.[1] ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => REASON.test(part))
    .slice(0, 10);
  return reasons.length > 0 ? { code, reasons } : { code };
}

export function createPlatformClient(options: PlatformClientOptions): PlatformApi {
  const base = options.baseUrl.replace(/\/$/, '');
  const doFetch = options.fetch ?? fetch;

  async function request<T>(
    method: 'GET' | 'POST',
    path: string,
    schema: ZodType<T>,
    init: { body?: unknown; idempotencyKey?: string } = {},
  ): Promise<PlatformResult<T>> {
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
        // No redirect is ever followed with a body or a token attached.
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
      });
    } catch {
      // The reason a request failed can quote what was sent. Only the fact that it failed is kept.
      return { ok: false, status: 0, code: 'network_error' };
    }
    if (!response.ok)
      return { ok: false, status: response.status, ...(await readProblem(response)) };
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
    get: (path, schema) =>
      isPlatformReadPath(path) ? request('GET', path, schema) : Promise.resolve(blocked()),
    post: (path, schema, body, idempotencyKey) =>
      isPlatformWritePath(path)
        ? request('POST', path, schema, { body, idempotencyKey })
        : Promise.resolve(blocked()),
  };
}
