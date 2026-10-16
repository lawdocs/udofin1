import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  type AppEnvironment,
  createMockPaymentProvider,
  MOCK_PAYMENT_PROVIDER_KEY,
  type NormalisedProviderEvent,
  type WebhookHeaders,
  type WebhookVerification,
  type WebhookVerifier,
} from '@udofin/adapters';
import { PROBLEM_CONTENT_TYPE } from '@udofin/contracts';
import { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import {
  createProviderHookProcessor,
  type DeliveryEvent,
  type DeliveryOutcome,
  type IngestAnswer,
  type ProviderDelivery,
  type ProviderHookConfig,
  type ProviderHookProcessor,
} from '../system/provider-hooks.js';
import { type SystemPool } from '../system/pool.js';

/**
 * The receiver for signed events from payment providers (payments, refunds, chargebacks, mandates, debits, settlements):
 * `POST /v1/hooks/provider/:endpointToken`. It lives on the callback-receiver app, the separate process that holds the system
 * database login; the public API never registers this route and it is not in the public OpenAPI document.
 *
 * What this file does, and nothing more: shape-check the routing token, look up the ACTIVE configuration by the token's hash,
 * verify the signature over the EXACT bytes received with the provider's `WebhookVerifier`, and hand the result to
 * `payments.ingest_provider_delivery` ONCE. Every business rule (replay, merchant, correlation, amounts, lifecycle) is in the
 * database; none is repeated here.
 *
 * No enumeration: before the signature is verified every outcome looks the same from outside, 401 `invalid_signature`. An unknown,
 * suspended or retired token, a malformed token, a configuration this environment may not use, a missing secret, a missing
 * header and a bad signature all take the same path (a lookup, the same signature work, one ingest call) and give the same
 * answer. The real reason is a receipt in `payments.webhook_receipts`, and for our own configuration gaps a reason CLASS in the
 * server log.
 *
 * Nothing sensitive is logged: never a body, header, token, signature, address or payload. A log line carries the request id
 * (added by the logger) and a reason class. The route logs at warn level only, so the automatic "incoming request" line, which
 * contains the URL and therefore the token, is never written for it.
 *
 * Signature schemes: only the labelled MOCK test scheme (`mock-standard-webhooks-v1`) exists, and only in local development and
 * tests. A real provider's scheme is added with that provider's specification; until then its deliveries are refused (and the
 * database keeps a `scheme_not_configured` receipt) rather than accepted unauthenticated.
 */
export interface ProviderHookDeps {
  readonly pool: SystemPool;
  /** Resolves the NAME of a secret to its value (environment variables or a secrets manager). Never logged. */
  secret(name: string): string | undefined;
  readonly environment: AppEnvironment;
  /** Tests only: replaces the database-backed processor. */
  readonly processor?: ProviderHookProcessor;
  /** Tests only: the clock used for the timestamp tolerance. */
  readonly now?: () => Date;
  /** Tuning of the rate limits (requests per minute). */
  readonly limits?: Partial<ProviderHookLimits>;
}

export interface ProviderHookLimits {
  /** Per client address, on this route. */
  readonly perAddressPerMinute: number;
  /** Per routing-token HASH (of whatever token was sent, valid or not), so a known token gets no different treatment. */
  readonly perTokenPerMinute: number;
}

export const PROVIDER_HOOK_DEFAULT_LIMITS: ProviderHookLimits = {
  perAddressPerMinute: 300,
  perTokenPerMinute: 120,
};

/** Name of the server secret that keys the address hash. */
export const IP_HMAC_SECRET_NAME = 'PROVIDER_HOOK_IP_HMAC_KEY';
/** Body limit of the route: 256 KiB. */
export const PROVIDER_HOOK_BODY_LIMIT = 262_144;
/** How far the signed timestamp may be from now. */
export const TIMESTAMP_TOLERANCE_SECONDS = 300;

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{32,128}$/;
const SAFE_DELIVERY_ID = /^[A-Za-z0-9._:=+/-]{4,200}$/;
const EPOCH_SECONDS = /^[0-9]{1,12}$/;
const MAX_SKEW_SECONDS = 31_536_000;
/** The mock scheme refuses to compute a signature over a body larger than this; the decoy work does the same. */
const SCHEME_BODY_BYTES = 64 * 1024;
const MAX_TOKEN_BUCKETS = 10_000;

// ---------------------------------------------------------------------------------------------------------
// Pure parts
// ---------------------------------------------------------------------------------------------------------

/** An opaque routing token is 32 to 128 URL-safe characters (letters, digits, `-`, `_`). Anything else is refused alike. */
export function isEndpointTokenShape(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_SHAPE.test(value);
}

/** SHA-256 (hex) of the token: what `payments.lender_payment_configs.endpoint_token_hash` stores. The token itself is never kept. */
export function hashEndpointToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Keyed hash of the client address, so receipts can show repeated sources without storing an address. */
export function addressHmac(key: Uint8Array, address: string): string {
  return createHmac('sha256', key).update(address, 'utf8').digest('hex');
}

/**
 * The HTTP status for a database answer to a delivery that THIS receiver verified: stored (200), authentic but not matched yet,
 * so the provider should retry later (409), authentic but not business-valid (422), anything else rejected (401, the uniform answer).
 */
export function statusForAnswer(answer: IngestAnswer): 200 | 401 | 409 | 422 {
  if (answer.accepted) return 200;
  switch (answer.outcome) {
    case 'unmatched':
      return 409;
    case 'invalid':
      return 422;
    case 'rejected':
      return 401;
  }
}

/** Seconds between the signed timestamp header and now; null when the header is missing, malformed or absurd. Receipt metadata only. */
export function timestampSkewSeconds(
  header: string | undefined,
  nowSeconds: number,
): number | null {
  if (header === undefined || !EPOCH_SECONDS.test(header)) return null;
  const skew = nowSeconds - parseInt(header, 10);
  return Math.abs(skew) <= MAX_SKEW_SECONDS ? skew : null;
}

/** Fixed window counter in memory, bounded in size. An address or token flood cannot grow it without limit. */
export class FixedWindowLimiter {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
    private readonly maxKeys: number = MAX_TOKEN_BUCKETS,
  ) {}

  /** True when this request is within the limit. */
  allow(key: string): boolean {
    const at = this.now();
    const bucket = this.buckets.get(key);
    if (bucket === undefined || bucket.resetAt <= at) {
      if (bucket === undefined && this.buckets.size >= this.maxKeys) {
        const oldest = this.buckets.keys().next();
        if (!oldest.done) this.buckets.delete(oldest.value);
      }
      this.buckets.set(key, { count: 1, resetAt: at + this.windowMs });
      return true;
    }
    bucket.count += 1;
    return bucket.count <= this.max;
  }
}

export type VerifierResolution =
  | { readonly ok: true; readonly verifier: WebhookVerifier }
  | { readonly ok: false; readonly reason: 'scheme_not_configured' | 'mock_blocked' };

/**
 * Which signature scheme verifies deliveries for a configuration. Only the labelled mock scheme exists: for the mock provider in
 * local development and tests. A real provider (sandbox or production mode, or any other provider key) has no scheme yet.
 * A mock configuration in staging or production is refused (CLAUDE.md rule 9).
 */
export function resolveWebhookVerifier(
  config: Pick<ProviderHookConfig, 'provider' | 'providerMode'>,
  environment: AppEnvironment,
): VerifierResolution {
  if (config.providerMode !== 'mock' || config.provider !== MOCK_PAYMENT_PROVIDER_KEY) {
    return { ok: false, reason: 'scheme_not_configured' };
  }
  if (environment !== 'local' && environment !== 'test')
    return { ok: false, reason: 'mock_blocked' };
  try {
    return { ok: true, verifier: createMockPaymentProvider(environment).webhookVerifier };
  } catch {
    return { ok: false, reason: 'mock_blocked' };
  }
}

function toDeliveryEvent(event: NormalisedProviderEvent): DeliveryEvent {
  return {
    provider: event.provider,
    deliveryId: event.deliveryId,
    eventId: event.eventId,
    objectKind: event.objectKind,
    objectRef: event.objectRef,
    ...(event.orderRef !== undefined ? { orderRef: event.orderRef } : {}),
    status: event.status,
    rank: event.rank,
    amountMinor: event.amountMinor === null ? null : event.amountMinor.toString(),
    currency: event.currency,
    occurredAt: event.occurredAt,
    ...(event.merchantRef !== undefined ? { merchantRef: event.merchantRef } : {}),
  };
}

/** Maps the verifier's result onto the outcome words and reason classes the database accepts. */
export function describeVerification(verification: WebhookVerification): {
  readonly outcome: DeliveryOutcome;
  readonly reasonClass: string;
  readonly event?: DeliveryEvent;
} {
  switch (verification.outcome) {
    case 'verified':
      return {
        outcome: 'verified',
        reasonClass: 'none',
        event: toDeliveryEvent(verification.event),
      };
    case 'unverified':
      return { outcome: 'unverified', reasonClass: verification.reason };
    case 'stale_timestamp':
      return { outcome: 'stale_timestamp', reasonClass: verification.reason };
    case 'invalid':
      return { outcome: 'invalid', reasonClass: verification.reason };
  }
}

// ---------------------------------------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------------------------------------

type ProblemStatus = 401 | 409 | 422 | 429 | 503;
const PROBLEMS: Readonly<Record<ProblemStatus, { readonly title: string; readonly code: string }>> =
  {
    401: { title: 'Unauthorized', code: 'invalid_signature' },
    409: { title: 'Conflict', code: 'unmatched' },
    422: { title: 'Unprocessable Entity', code: 'invalid_event' },
    429: { title: 'Too Many Requests', code: 'rate_limited' },
    503: { title: 'Service Unavailable', code: 'temporarily_unavailable' },
  };

/** The fixed problem document of a status. Fixed text only: nothing from the request or the database is ever in it. */
export function providerHookProblem(
  status: ProblemStatus,
  requestId: string,
): {
  readonly type: 'about:blank';
  readonly title: string;
  readonly status: ProblemStatus;
  readonly code: string;
  readonly instance: string;
} {
  const fixed = PROBLEMS[status];
  return {
    type: 'about:blank',
    title: fixed.title,
    status,
    code: fixed.code,
    instance: requestId,
  };
}

function sendProblem(reply: FastifyReply, status: ProblemStatus, requestId: string): FastifyReply {
  return reply.code(status).type(PROBLEM_CONTENT_TYPE).send(providerHookProblem(status, requestId));
}

// ---------------------------------------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------------------------------------

function resolveIpKey(deps: Pick<ProviderHookDeps, 'secret' | 'environment'>): Uint8Array {
  const deployed = deps.environment === 'staging' || deps.environment === 'production';
  const configured = deps.secret(IP_HMAC_SECRET_NAME);
  if (configured !== undefined && configured.length > 0) {
    if (deployed && configured.length < 32) {
      throw new Error(
        `${IP_HMAC_SECRET_NAME} must be at least 32 characters in staging and production`,
      );
    }
    return Buffer.from(configured, 'utf8');
  }
  if (deployed) {
    // Without the key the address hash would be unkeyed or random per restart, and the evidence in the receipts would be useless.
    throw new Error(
      `${IP_HMAC_SECRET_NAME} is required in staging and production: the provider callback route will not start without it`,
    );
  }
  // Local development and tests: a random key for this process only (hashes are comparable within one run).
  return randomBytes(32);
}

function stringHeaders(request: FastifyRequest): WebhookHeaders {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === 'string') out[name] = value;
    else if (Array.isArray(value)) out[name] = value.join(', ');
  }
  return out;
}

function bodyBytes(body: unknown): Buffer {
  return Buffer.isBuffer(body) ? body : Buffer.alloc(0);
}

/** The first five characters of a database error code, never its message (messages can carry data). */
function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
}

/**
 * The work of checking a signature against a secret nobody has, spent when there is nothing real to verify against. The result
 * is discarded and can never accept a delivery: the only effect is that unknown tokens, unusable configurations and bad
 * signatures cost about the same. The decoy key is random per process, so there is no public constant to sign with.
 */
function spendVerificationEffort(
  decoyKey: Uint8Array,
  raw: Uint8Array,
  headers: WebhookHeaders,
): void {
  if (raw.length > SCHEME_BODY_BYTES) return;
  const id = headers['webhook-id'] ?? '';
  const timestamp = headers['webhook-timestamp'] ?? '';
  const mac = createHmac('sha256', decoyKey)
    .update(`${id}.${timestamp}.`, 'utf8')
    .update(raw)
    .digest();
  const given = Buffer.from((headers['webhook-signature'] ?? '').split(',')[1] ?? '', 'base64');
  void (given.length === mac.length && timingSafeEqual(given, mac));
}

export function registerProviderHooks(app: FastifyInstance, deps: ProviderHookDeps): void {
  // Startup errors, raised while the process starts: a deployed receiver must not run without its address key.
  const ipKey = resolveIpKey(deps);
  const decoyKey = randomBytes(32);
  const processor = deps.processor ?? createProviderHookProcessor(deps.pool);
  const clock = deps.now ?? (() => new Date());
  const limits = { ...PROVIDER_HOOK_DEFAULT_LIMITS, ...deps.limits };
  const tokenLimiter = new FixedWindowLimiter(limits.perTokenPerMinute, 60_000, () =>
    clock().getTime(),
  );

  // Its own scope: this route reads the body as raw bytes, so the signature is checked over exactly what was sent. The parsers
  // of the rest of the app are not touched.
  void app.register((scope, _options, done) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer', bodyLimit: PROVIDER_HOOK_BODY_LIMIT },
      (_request, body, finish) => {
        finish(null, body);
      },
    );

    scope.post(
      '/v1/hooks/provider/:endpointToken',
      {
        bodyLimit: PROVIDER_HOOK_BODY_LIMIT,
        // Only warnings and errors are logged for this route: the automatic request lines carry the URL, which holds the token.
        logLevel: 'warn',
        config: { rateLimit: { max: limits.perAddressPerMinute, timeWindow: '1 minute' } },
        onRequest: (request, reply, next) => {
          const given = (request.params as { endpointToken?: unknown }).endpointToken;
          const key = hashEndpointToken(typeof given === 'string' ? given.slice(0, 200) : '');
          if (!tokenLimiter.allow(key)) {
            reply.header('retry-after', '60');
            sendProblem(reply, 429, request.id);
            return;
          }
          next();
        },
      },
      async (request, reply) => {
        const refuse = (): FastifyReply => sendProblem(reply, 401, request.id);
        const unavailable = (reason: string, error?: unknown): FastifyReply => {
          const code = errorCode(error);
          request.log.warn(
            code === undefined ? { reason } : { reason, code },
            'provider callback not processed',
          );
          return sendProblem(reply, 503, request.id);
        };

        const raw = bodyBytes(request.body);
        const headers = stringHeaders(request);
        const given = (request.params as { endpointToken?: unknown }).endpointToken;
        if (!isEndpointTokenShape(given)) {
          spendVerificationEffort(decoyKey, raw, headers);
          return refuse();
        }
        const tokenHash = hashEndpointToken(given);
        const ipHmac = addressHmac(ipKey, request.ip);

        let config: ProviderHookConfig | null;
        try {
          config = await processor.lookupConfig(tokenHash);
        } catch (error) {
          return unavailable('config_lookup_failed', error);
        }

        const now = clock();
        const payloadSha256 = createHash('sha256').update(raw).digest('hex');
        const deliveryHeader = headers['webhook-id'];
        const base = {
          payloadSha256,
          bodyBytes: raw.length,
          ipHmac,
          deliveryId:
            deliveryHeader !== undefined && SAFE_DELIVERY_ID.test(deliveryHeader)
              ? deliveryHeader
              : null,
          signaturePresent: (headers['webhook-signature'] ?? '').length > 0,
          timestampSkewSeconds: timestampSkewSeconds(
            headers['webhook-timestamp'],
            Math.floor(now.getTime() / 1000),
          ),
        };

        let delivery: ProviderDelivery;
        if (config === null) {
          // Unknown, suspended or retired token: same work, same answer as a bad signature. The database keeps a receipt.
          spendVerificationEffort(decoyKey, raw, headers);
          delivery = {
            ...base,
            provider: 'unknown',
            outcome: 'unverified',
            reasonClass: 'signature_mismatch',
            scheme: null,
          };
        } else {
          const resolution = resolveWebhookVerifier(config, deps.environment);
          if (!resolution.ok) {
            spendVerificationEffort(decoyKey, raw, headers);
            request.log.warn({ reason: resolution.reason }, 'provider callback refused');
            delivery = {
              ...base,
              provider: config.provider,
              outcome: 'invalid',
              reasonClass: 'provider_scheme_not_configured',
              scheme: null,
            };
          } else {
            const secret = deps.secret(config.webhookSecretRef);
            if (secret === undefined || secret.length === 0) {
              spendVerificationEffort(decoyKey, raw, headers);
              request.log.warn(
                { reason: 'webhook_secret_not_configured' },
                'provider callback refused',
              );
              delivery = {
                ...base,
                provider: config.provider,
                outcome: 'unverified',
                reasonClass: 'no_secret',
                scheme: resolution.verifier.scheme,
              };
            } else {
              try {
                const verified = describeVerification(
                  resolution.verifier.verify(raw, headers, {
                    secret,
                    now,
                    toleranceSeconds: TIMESTAMP_TOLERANCE_SECONDS,
                  }),
                );
                delivery = {
                  ...base,
                  provider: config.provider,
                  outcome: verified.outcome,
                  reasonClass: verified.reasonClass,
                  scheme: resolution.verifier.scheme,
                  ...(verified.event !== undefined ? { event: verified.event } : {}),
                };
              } catch {
                // A verifier that throws is our fault, not the caller's: stored as an invalid receipt, refused alike.
                request.log.warn({ reason: 'verifier_failed' }, 'provider callback refused');
                delivery = {
                  ...base,
                  provider: config.provider,
                  outcome: 'invalid',
                  reasonClass: 'verifier_outcome_unknown',
                  scheme: resolution.verifier.scheme,
                };
              }
            }
          }
        }

        let answer: IngestAnswer;
        try {
          answer = await processor.ingest(tokenHash, delivery);
        } catch (error) {
          return unavailable('ingest_failed', error);
        }

        // Only a delivery THIS receiver verified can get anything but the uniform refusal, whatever the database says.
        if (delivery.outcome !== 'verified') return refuse();
        const status = statusForAnswer(answer);
        if (status === 200) return reply.code(200).send({ ok: true });
        if (status === 401) {
          request.log.warn({ reason: 'rejected_after_verification' }, 'provider callback refused');
          return refuse();
        }
        return sendProblem(reply, status, request.id);
      },
    );
    done();
  });
}
