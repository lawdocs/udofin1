import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { normaliseTimestamp, isValidIsoDate } from './lms.js';
import { formatMoneyMinor, MAX_MONEY_MINOR, parseMoneyMinor } from './money.js';
import {
  assertLocalOrTestOnly,
  type AppEnvironment,
  type ProviderCallContext,
  type ProviderDescriptor,
} from './provider.js';

/**
 * Payment-provider port, webhook verification and a labelled mock.
 *
 * Udofin never holds, routes or settles borrower money (CF para 10; ADR 0008). The lender is the merchant of record
 * and the provider settles into the lender's own account. Everything here only INSTRUCTS and OBSERVES:
 *   - `createOrder` asks the provider (with the lender's credentials) to create a payment order/link and returns a
 *     hand-off. It never means "paid".
 *   - A payment, refund or settlement changes state only on (a) a webhook that `WebhookVerifier.verify` returned as
 *     `verified`, or (b) an `getOrderStatus` answer, which is provider-authenticated. A redirect back to the app, a
 *     client claim or an unverified delivery proves nothing.
 *   - Unverified/stale/invalid deliveries are NOT financial events: the receiver stores a receipt and nothing else.
 *
 * Real provider schemes are NOT written: no provider contract, merchant account or specification exists (D-65/D-68).
 * `createUnconfiguredPaymentProvider()` answers `provider_scheme_not_configured`; the only working scheme is the
 * labelled test scheme `mock-standard-webhooks-v1`, allowed in local development and tests only.
 */

// ---------------------------------------------------------------------------------------------------------
// Normalised events
// ---------------------------------------------------------------------------------------------------------

export type ProviderObjectKind =
  'payment' | 'refund' | 'chargeback' | 'mandate' | 'debit' | 'settlement';

/**
 * Marker for an AUTHENTIC delivery whose object kind the platform does not support. It is stored verified-and-ignored
 * (owner decision, 14 Oct 2026): it changes no state and is never rejected solely because its kind is unknown. The
 * provider's own kind word is not kept (it is provider text); the receipt keeps the payload hash.
 */
export const UNSUPPORTED_OBJECT_KIND = 'unsupported';

export const PROVIDER_OBJECT_KINDS: readonly ProviderObjectKind[] = [
  'payment',
  'refund',
  'chargeback',
  'mandate',
  'debit',
  'settlement',
];

/**
 * The platform status vocabulary. Adapters map a provider's own words onto it; anything they cannot map becomes
 * `unmapped`, which can never authorise anything. Only `captured`, `paid` and `succeeded` can authorise a payment to
 * be marked succeeded (database `private.payment_success_statuses()`), and only for the intent's exact amount.
 */
export const PLATFORM_EVENT_STATUSES = [
  'created',
  'pending',
  'authorized',
  'captured',
  'paid',
  'succeeded',
  'failed',
  'refunded',
  'disputed',
  'cancelled',
  'expired',
  'active',
  'rejected',
  'returned',
  'revoked',
  'paused',
  'unmapped',
] as const;
export type PlatformEventStatus = (typeof PLATFORM_EVENT_STATUSES)[number];

/** Statuses that can authorise a payment success (must equal the database allow-list). */
export const PAYMENT_SUCCESS_STATUSES: readonly PlatformEventStatus[] = [
  'captured',
  'paid',
  'succeeded',
];

/**
 * Default monotonic rank of a status within one object. A lower rank arriving after a higher one is stale and is
 * ignored by the database (`ignored_stale`); it never reverts the object. Adapters whose provider documents its own
 * ordering may supply a different rank; this table is the platform default.
 */
const STATUS_RANK: Readonly<Record<PlatformEventStatus, number>> = {
  unmapped: 0,
  created: 10,
  pending: 15,
  authorized: 20,
  active: 30,
  failed: 25,
  rejected: 25,
  captured: 30,
  paid: 30,
  succeeded: 30,
  paused: 35,
  returned: 40,
  refunded: 40,
  cancelled: 45,
  revoked: 45,
  expired: 45,
  disputed: 50,
};
export const defaultEventRank = (status: PlatformEventStatus): number => STATUS_RANK[status];

export interface NormalisedProviderEvent {
  /** Provider key, e.g. `mock_payment_provider`. */
  readonly provider: string;
  /** Identifies THIS delivery (a retry of the same event carries the same delivery id). Replay-protection key. */
  readonly deliveryId: string;
  /** Identifies the provider event. Several deliveries may carry the same event id. */
  readonly eventId: string;
  /** `unsupported` = verified-and-ignored: an authentic event of a kind the platform does not handle. */
  readonly objectKind: ProviderObjectKind | typeof UNSUPPORTED_OBJECT_KIND;
  /** The provider's id of the object (payment, refund, mandate, debit, settlement). */
  readonly objectRef: string;
  /** The order/link the object belongs to, used to match an intent. */
  readonly orderRef?: string;
  readonly status: PlatformEventStatus;
  /** Monotonic per object; see `defaultEventRank`. */
  readonly rank: number;
  /** Integer paise, or null when the event states no amount. Never a float; never parsed with Number(). */
  readonly amountMinor: bigint | null;
  readonly currency: 'INR' | null;
  /** When the provider says it happened (UTC ISO-8601). */
  readonly occurredAt: string;
  readonly settlementRef?: string;
  /** The merchant the provider says this belongs to. Compared upstream with the lender's configuration. */
  readonly merchantRef?: string;
  /**
   * Refund and chargeback only: the provider's reference of the PAYMENT being refunded or disputed (not the refund's own
   * `objectRef`). Without it the database books the compensating entry only when the intent has exactly one provider
   * payment; with it, against the payment named.
   */
  readonly parentPaymentRef?: string;
}

// ---------------------------------------------------------------------------------------------------------
// Webhook verification
// ---------------------------------------------------------------------------------------------------------

/** Request headers, any case. Values may be undefined. */
export type WebhookHeaders = Readonly<Record<string, string | undefined>>;

export interface WebhookVerifyContext {
  /** The lender's webhook secret, resolved by the caller from its secret reference. Never logged, never returned. */
  readonly secret: string;
  readonly now?: Date;
  /** Default 300 seconds. */
  readonly toleranceSeconds?: number;
}

export type WebhookRejectionReason =
  'missing_headers' | 'malformed_headers' | 'no_secret' | 'signature_mismatch';

export type WebhookInvalidReason =
  | 'provider_scheme_not_configured'
  | 'body_too_large'
  | 'malformed_body'
  | 'unsupported_event'
  | 'invalid_amount'
  | 'unsupported_currency'
  | 'invalid_timestamp'
  | 'invalid_identifier';

/**
 * Receipt outcomes from spec 08 section 9 (`duplicate`/`unmatched` are decided upstream, in the database):
 *  - verified:        authentic, fresh and well-formed. `event` is ready for the database.
 *  - unverified:      signature missing or wrong. Never a financial event.
 *  - stale_timestamp: authentic signature but outside the tolerance (replay of an old capture). Inert.
 *  - invalid:         the body cannot be used (or this provider has no scheme yet). Inert.
 * An authentic, fresh delivery of an object kind the platform does not support is `verified` with objectKind
 * `unsupported` (verified-and-ignored), not `invalid`; `unsupported_event` is only for a body with no usable kind.
 * `payloadSha256` is the hash of the raw body, always present, for the receipt. Raw bodies are never stored.
 */
export type WebhookVerification =
  | {
      readonly outcome: 'verified';
      readonly event: NormalisedProviderEvent;
      readonly payloadSha256: string;
    }
  | {
      readonly outcome: 'unverified';
      readonly reason: WebhookRejectionReason;
      readonly payloadSha256: string;
    }
  | {
      readonly outcome: 'stale_timestamp';
      readonly reason: 'timestamp_outside_tolerance';
      readonly payloadSha256: string;
    }
  | {
      readonly outcome: 'invalid';
      readonly reason: WebhookInvalidReason;
      readonly payloadSha256: string;
    };

export interface WebhookVerifier {
  /** Name of the scheme, e.g. `mock-standard-webhooks-v1`. */
  readonly scheme: string;
  /** Signature, timestamp tolerance and integrity are the adapter's job; replay and business checks happen upstream. */
  verify(
    rawBody: Uint8Array,
    headers: WebhookHeaders,
    context: WebhookVerifyContext,
  ): WebhookVerification;
}

const sha256Hex = (data: Uint8Array | string): string =>
  createHash('sha256').update(data).digest('hex');

// ---------------------------------------------------------------------------------------------------------
// Provider port
// ---------------------------------------------------------------------------------------------------------

export type PaymentPurpose =
  'installment' | 'overdue' | 'part_prepayment' | 'foreclosure' | 'cooling_off_exit' | 'charges';

export interface CreateOrderRequest {
  /** Idempotency key: the payment intent id. The provider (and the mock) must treat a repeat as the same order. */
  readonly operationKey: string;
  /** Our reference that a later lookup can use if the create call's outcome was never observed. */
  readonly receiptRef: string;
  /** The lender's merchant id from the approved configuration. */
  readonly merchantRef: string;
  /** Integer paise, > 0. The amount is the lender's, accepted unchanged by Udofin. */
  readonly amountMinor: bigint;
  readonly currency: 'INR';
  readonly purpose: PaymentPurpose;
  /** UTC ISO-8601, or null for the provider's default validity. */
  readonly expiresAt: string | null;
}
// There is deliberately no field for a name, phone number, e-mail, PAN, Aadhaar or account number.

export interface CreatedOrder {
  readonly orderRef: string;
  /** What the provider says the order belongs to. Bound back against the configuration: a difference is `merchant_mismatch`. */
  readonly merchantRef: string | null;
  readonly settlementProfileRef: string | null;
  /** A BEARER SECRET. Never stored in clear, never logged, never put in an event. */
  readonly checkoutLink: string | null;
  readonly expiresAt: string | null;
}

export interface OrderLookupQuery {
  readonly orderRef: string | null;
  readonly operationKey: string;
}

/** The answer of an authenticated status lookup: same standing as a verified event, nothing else has it. */
export interface OrderStatus {
  readonly source: 'provider_authenticated_lookup';
  readonly orderRef: string;
  readonly status: PlatformEventStatus;
  readonly amountMinor: bigint | null;
  readonly currency: 'INR' | null;
  readonly merchantRef: string | null;
  readonly providerPaymentRef: string | null;
  readonly observedAt: string;
}

export interface SettlementItem {
  readonly providerPaymentRef: string;
  readonly orderRef: string | null;
  readonly grossMinor: bigint;
  readonly feeMinor: bigint;
  readonly taxMinor: bigint;
  readonly netMinor: bigint;
}

export interface SettlementBatch {
  readonly batchRef: string;
  /** Bank reference (UTR) of the settlement credit. */
  readonly settlementRef: string;
  readonly periodFrom: string;
  readonly periodTo: string;
  /** Last four digits only, as the provider reports the destination; compared with the lender's verified account. */
  readonly destinationMaskedRef: string | null;
  readonly grossMinor: bigint;
  readonly feeMinor: bigint;
  readonly taxMinor: bigint;
  readonly netMinor: bigint;
  readonly items: readonly SettlementItem[];
}

export interface SettlementReport {
  readonly date: string;
  readonly batches: readonly SettlementBatch[];
}

export type PaymentResult<T> =
  | { readonly outcome: 'ok'; readonly value: T }
  /**
   * The provider may or may not have acted. Look the order up by `receiptRef` before ANY retry. This includes a 5xx or
   * an unparseable answer (`provider_error`): the order may have been committed. `rejected` is only a definite refusal
   * (a 4xx the provider says it did not act on).
   */
  | { readonly outcome: 'unknown'; readonly reason: 'timeout' | 'network' | 'provider_error' }
  | {
      readonly outcome: 'rejected';
      readonly reason: 'invalid_request' | 'unsupported_currency';
    }
  | { readonly outcome: 'not_found' }
  | { readonly outcome: 'unsupported' }
  | { readonly outcome: 'not_configured' };

export interface PaymentProviderCapabilities {
  readonly orderCreation: boolean;
  readonly statusLookup: boolean;
  readonly settlementReports: boolean;
  readonly partialAmounts: boolean;
  readonly webhooks: boolean;
}

export interface PaymentProviderPort {
  readonly descriptor: ProviderDescriptor;
  readonly capabilities: PaymentProviderCapabilities;
  readonly webhookVerifier: WebhookVerifier;
  createOrder(
    ctx: ProviderCallContext,
    request: CreateOrderRequest,
  ): Promise<PaymentResult<CreatedOrder>>;
  /** Authenticated lookup at the provider. The only non-webhook evidence of a payment. */
  getOrderStatus(
    ctx: ProviderCallContext,
    query: OrderLookupQuery,
  ): Promise<PaymentResult<OrderStatus>>;
  /** The provider's settlement report for a date (YYYY-MM-DD). */
  fetchSettlements(
    ctx: ProviderCallContext,
    date: string,
  ): Promise<PaymentResult<SettlementReport>>;
}

/**
 * Bounds every provider call. A call that outlasts `milliseconds`, or that throws, becomes the explicit
 * `unknown` outcome (`timeout` / `network`), never an empty value, a success and never a refusal: the provider may
 * have acted (an order may have been created), so look it up by `receiptRef` / operation key before any retry. A late
 * answer to a call that has already timed out is discarded. The webhook verifier is passed through unchanged (it is
 * synchronous and makes no network call). `milliseconds` must be a finite number > 0, otherwise `RangeError` (a
 * wiring mistake, raised when the port is wrapped, not at call time).
 */
export function withPaymentTimeout(
  inner: PaymentProviderPort,
  milliseconds: number,
): PaymentProviderPort {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
    throw new RangeError('payment timeout must be a finite number of milliseconds above zero');
  }
  const bound = async <T>(call: () => Promise<PaymentResult<T>>): Promise<PaymentResult<T>> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<PaymentResult<T>>((resolve) => {
      timer = setTimeout(() => resolve({ outcome: 'unknown', reason: 'timeout' }), milliseconds);
    });
    try {
      return await Promise.race([
        (async () => call())().catch((): PaymentResult<T> => ({
          outcome: 'unknown',
          reason: 'network',
        })),
        timeout,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  return {
    descriptor: inner.descriptor,
    capabilities: inner.capabilities,
    webhookVerifier: inner.webhookVerifier,
    createOrder: (ctx, request) => bound(() => inner.createOrder(ctx, request)),
    getOrderStatus: (ctx, query) => bound(() => inner.getOrderStatus(ctx, query)),
    fetchSettlements: (ctx, date) => bound(() => inner.fetchSettlements(ctx, date)),
  };
}

/** No provider is contracted or specified: refuses honestly. Webhooks answer `provider_scheme_not_configured`. */
export function createUnconfiguredPaymentProvider(): PaymentProviderPort {
  const notConfigured = (): Promise<{ readonly outcome: 'not_configured' }> =>
    Promise.resolve({ outcome: 'not_configured' as const });
  return {
    descriptor: {
      key: 'payment_provider_not_configured',
      capability: 'payment_collection',
      mode: 'production',
    },
    capabilities: {
      orderCreation: false,
      statusLookup: false,
      settlementReports: false,
      partialAmounts: false,
      webhooks: false,
    },
    webhookVerifier: {
      scheme: 'none',
      verify: (rawBody) => ({
        outcome: 'invalid',
        reason: 'provider_scheme_not_configured',
        payloadSha256: sha256Hex(rawBody),
      }),
    },
    createOrder: notConfigured,
    getOrderStatus: notConfigured,
    fetchSettlements: notConfigured,
  };
}

// ---------------------------------------------------------------------------------------------------------
// The labelled mock scheme: `mock-standard-webhooks-v1`
// ---------------------------------------------------------------------------------------------------------

/**
 * TEST SCHEME ONLY. A Standard-Webhooks-style HMAC-SHA256 so tests can exercise verification, replay windows and
 * tampering. It is not any provider's protocol. Headers:
 *   webhook-id         delivery id (reference charset)
 *   webhook-timestamp  integer seconds since the epoch
 *   webhook-signature  one or more space-separated `v1,<base64 HMAC>`
 * HMAC-SHA256(secret as UTF-8, `<id>.<timestamp>.` followed by the RAW body bytes), compared in constant time.
 * Body: JSON with string fields event_id, object_kind, object_ref, status, occurred_at and optional order_ref, amount
 * (decimal rupees as a STRING), currency, settlement_ref, merchant_ref.
 */
export const MOCK_PAYMENT_WEBHOOK_SCHEME = 'mock-standard-webhooks-v1';
export const MOCK_PAYMENT_PROVIDER_KEY = 'mock_payment_provider';

const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const EPOCH_SECONDS = /^[0-9]{1,12}$/;

/** Canonical base64 only: the candidate must equal the re-encoding of what it decodes to (no junk, no base64url, no missing padding). */
function decodeCanonicalBase64(candidate: string): Buffer | null {
  const decoded = Buffer.from(candidate, 'base64');
  return decoded.toString('base64') === candidate ? decoded : null;
}

function header(headers: WebhookHeaders, name: string): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return undefined;
}

const mockMac = (secret: string, id: string, timestamp: string, rawBody: Uint8Array): Buffer =>
  createHmac('sha256', Buffer.from(secret, 'utf8'))
    .update(Buffer.concat([Buffer.from(`${id}.${timestamp}.`, 'utf8'), rawBody]))
    .digest();

/** Signs a body the way the mock scheme expects. Test helper. */
export function signMockWebhook(input: {
  secret: string;
  deliveryId: string;
  timestampSeconds: number;
  rawBody: Uint8Array | string;
}): Record<'webhook-id' | 'webhook-timestamp' | 'webhook-signature', string> {
  const body =
    typeof input.rawBody === 'string' ? Buffer.from(input.rawBody, 'utf8') : input.rawBody;
  const timestamp = String(input.timestampSeconds);
  return {
    'webhook-id': input.deliveryId,
    'webhook-timestamp': timestamp,
    'webhook-signature': `v1,${mockMac(input.secret, input.deliveryId, timestamp, body).toString('base64')}`,
  };
}

export interface MockWebhookBodyFields {
  eventId: string;
  /** Usually a supported kind; any text is allowed so tests can send an unsupported one. */
  objectKind: ProviderObjectKind | (string & {});
  objectRef: string;
  orderRef?: string;
  /** Usually a platform status; any text is allowed so tests can send an unmapped one. */
  status: string;
  amountMinor?: bigint | null;
  currency?: string | null;
  occurredAt: string;
  settlementRef?: string;
  merchantRef?: string;
  /** Refund and chargeback: the provider's reference of the payment concerned. */
  parentPaymentRef?: string;
}

/** Builds a mock-scheme body. Money is written as a decimal string through formatMoneyMinor. */
export function buildMockWebhookBody(fields: MockWebhookBodyFields): Uint8Array {
  const body: Record<string, string> = {
    event_id: fields.eventId,
    object_kind: fields.objectKind,
    object_ref: fields.objectRef,
    status: fields.status,
    occurred_at: fields.occurredAt,
  };
  if (fields.orderRef !== undefined) body.order_ref = fields.orderRef;
  if (fields.amountMinor !== undefined && fields.amountMinor !== null) {
    body.amount = formatMoneyMinor(fields.amountMinor);
  }
  if (fields.currency !== undefined && fields.currency !== null) body.currency = fields.currency;
  if (fields.settlementRef !== undefined) body.settlement_ref = fields.settlementRef;
  if (fields.merchantRef !== undefined) body.merchant_ref = fields.merchantRef;
  if (fields.parentPaymentRef !== undefined) body.parent_payment_ref = fields.parentPaymentRef;
  return new Uint8Array(Buffer.from(JSON.stringify(body), 'utf8'));
}

function optionalString(
  body: Readonly<Record<string, unknown>>,
  key: string,
): string | null | undefined {
  if (!Object.hasOwn(body, key) || body[key] === undefined || body[key] === null) return null;
  const value = body[key];
  return typeof value === 'string' ? value : undefined;
}

function verifyMockWebhook(
  rawBody: Uint8Array,
  headers: WebhookHeaders,
  context: WebhookVerifyContext,
): WebhookVerification {
  const tolerance = context.toleranceSeconds ?? 300;
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    // A configuration error must stop the receiver, not silently switch the replay window off (NaN) or on (negative).
    throw new RangeError('toleranceSeconds must be a finite number of seconds, zero or more');
  }
  const payloadSha256 = sha256Hex(rawBody);
  const unverified = (reason: WebhookRejectionReason): WebhookVerification => ({
    outcome: 'unverified',
    reason,
    payloadSha256,
  });
  const invalid = (reason: WebhookInvalidReason): WebhookVerification => ({
    outcome: 'invalid',
    reason,
    payloadSha256,
  });

  // Bound the work first: no HMAC over a body above the limit. (The transport should also cap the body it reads.)
  if (rawBody.length > MAX_WEBHOOK_BODY_BYTES) return invalid('body_too_large');

  const id = header(headers, 'webhook-id');
  const timestamp = header(headers, 'webhook-timestamp');
  const signature = header(headers, 'webhook-signature');
  if (!id || !timestamp || !signature) return unverified('missing_headers');
  if (!IDENTIFIER.test(id) || !EPOCH_SECONDS.test(timestamp))
    return unverified('malformed_headers');
  if (context.secret.length === 0) return unverified('no_secret');

  const expected = mockMac(context.secret, id, timestamp, rawBody);
  const authentic = signature.split(' ').some((part) => {
    const [version, candidate] = part.split(',');
    if (version !== 'v1' || !candidate) return false;
    const given = decodeCanonicalBase64(candidate);
    return given !== null && given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!authentic) return unverified('signature_mismatch');

  const now = Math.floor((context.now ?? new Date()).getTime() / 1000);
  if (Math.abs(now - parseInt(timestamp, 10)) > tolerance) {
    return { outcome: 'stale_timestamp', reason: 'timestamp_outside_tolerance', payloadSha256 };
  }

  // From here on the sender is authentic; the body still has to be usable.
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBody));
  } catch {
    return invalid('malformed_body');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return invalid('malformed_body');
  }
  const body = parsed as Record<string, unknown>;
  const eventId = optionalString(body, 'event_id');
  const objectRef = optionalString(body, 'object_ref');
  const orderRef = optionalString(body, 'order_ref');
  const settlementRef = optionalString(body, 'settlement_ref');
  const merchantRef = optionalString(body, 'merchant_ref');
  const parentPaymentRef = optionalString(body, 'parent_payment_ref');
  const objectKind = optionalString(body, 'object_kind');
  const statusText = optionalString(body, 'status');
  const amountText = optionalString(body, 'amount');
  const currencyText = optionalString(body, 'currency');
  const occurredText = optionalString(body, 'occurred_at');
  if (
    typeof eventId !== 'string' ||
    !IDENTIFIER.test(eventId) ||
    typeof objectRef !== 'string' ||
    !IDENTIFIER.test(objectRef) ||
    orderRef === undefined ||
    (orderRef !== null && !IDENTIFIER.test(orderRef)) ||
    settlementRef === undefined ||
    (settlementRef !== null && !IDENTIFIER.test(settlementRef)) ||
    merchantRef === undefined ||
    (merchantRef !== null && !IDENTIFIER.test(merchantRef)) ||
    parentPaymentRef === undefined ||
    (parentPaymentRef !== null && !IDENTIFIER.test(parentPaymentRef))
  ) {
    return invalid('invalid_identifier');
  }
  // A body with no usable kind word is malformed. A kind word we do not support is an authentic event that is stored
  // verified-and-ignored: it carries identifiers and a time only, never an amount, a status or the kind text.
  if (typeof objectKind !== 'string' || objectKind === '') return invalid('unsupported_event');
  const kind = PROVIDER_OBJECT_KINDS.find((candidate) => candidate === objectKind);
  if (kind === undefined) {
    const ignoredAt = typeof occurredText === 'string' ? normaliseTimestamp(occurredText) : null;
    if (ignoredAt === null) return invalid('invalid_timestamp');
    return {
      outcome: 'verified',
      payloadSha256,
      event: {
        provider: MOCK_PAYMENT_PROVIDER_KEY,
        deliveryId: id,
        eventId,
        objectKind: UNSUPPORTED_OBJECT_KIND,
        objectRef,
        status: 'unmapped',
        rank: defaultEventRank('unmapped'),
        amountMinor: null,
        currency: null,
        occurredAt: ignoredAt,
      },
    };
  }
  if (typeof statusText !== 'string') return invalid('unsupported_event');
  const status: PlatformEventStatus =
    PLATFORM_EVENT_STATUSES.find((candidate) => candidate === statusText) ?? 'unmapped';

  let amountMinor: bigint | null = null;
  if (amountText === undefined) return invalid('invalid_amount');
  if (amountText !== null) {
    try {
      amountMinor = parseMoneyMinor(amountText);
    } catch {
      return invalid('invalid_amount');
    }
  }
  if (currencyText === undefined || (currencyText !== null && currencyText !== 'INR')) {
    return invalid('unsupported_currency');
  }
  // An amount without a currency would never confirm INR: refuse it.
  if (amountMinor !== null && currencyText === null) return invalid('unsupported_currency');
  const occurredAt = typeof occurredText === 'string' ? normaliseTimestamp(occurredText) : null;
  if (occurredAt === null) return invalid('invalid_timestamp');

  return {
    outcome: 'verified',
    payloadSha256,
    event: {
      provider: MOCK_PAYMENT_PROVIDER_KEY,
      deliveryId: id,
      eventId,
      objectKind: kind,
      objectRef,
      ...(orderRef !== null ? { orderRef } : {}),
      status,
      rank: defaultEventRank(status),
      amountMinor,
      currency: currencyText === 'INR' ? 'INR' : null,
      occurredAt,
      ...(settlementRef !== null ? { settlementRef } : {}),
      ...(merchantRef !== null ? { merchantRef } : {}),
      // Only a refund or a chargeback concerns another object: no other kind carries a parent.
      ...(parentPaymentRef !== null && (kind === 'refund' || kind === 'chargeback')
        ? { parentPaymentRef }
        : {}),
    },
  };
}

// ---------------------------------------------------------------------------------------------------------
// Scripted deliveries
// ---------------------------------------------------------------------------------------------------------

export type MockPaymentScenario =
  | 'success'
  | 'failure'
  | 'delayed'
  | 'duplicate_event'
  | 'out_of_order_refund_first'
  | 'out_of_order_failed_after_captured'
  | 'partial_amount'
  | 'wrong_currency'
  | 'wrong_merchant'
  | 'refund'
  | 'chargeback'
  | 'unknown_outcome'
  | 'bad_signature'
  | 'old_timestamp';

export interface MockDelivery {
  /** What this delivery is, for test output. */
  readonly label: string;
  readonly rawBody: Uint8Array;
  readonly headers: Record<'webhook-id' | 'webhook-timestamp' | 'webhook-signature', string>;
}

export interface MockDeliveryParams {
  readonly secret: string;
  readonly orderRef: string;
  readonly paymentRef: string;
  readonly amountMinor: bigint;
  readonly merchantRef: string;
  /** "Now" of the receiver: signatures and occurred_at are derived from it, so runs are reproducible. */
  readonly now: Date;
  /** Prefix for generated event/delivery ids. */
  readonly idPrefix?: string;
}

export const MOCK_OTHER_MERCHANT_REF = 'SAMPLE-OTHER-MERCHANT';

type DeliveryFields = Pick<MockWebhookBodyFields, 'objectKind' | 'objectRef' | 'status'> &
  Partial<MockWebhookBodyFields>;

/**
 * Pure, deterministic delivery scripts for the scenarios of spec 08 section 20. Each element is a complete signed HTTP
 * delivery (raw body and headers) ready to POST to a receiver under test.
 */
export function buildMockDeliveries(
  scenario: MockPaymentScenario,
  params: MockDeliveryParams,
): MockDelivery[] {
  const prefix = params.idPrefix ?? 'SAMPLE';
  const nowSeconds = Math.floor(params.now.getTime() / 1000);
  const at = (secondsAgo: number): string =>
    new Date((nowSeconds - secondsAgo) * 1000).toISOString();
  let counter = 0;
  const make = (
    label: string,
    fields: DeliveryFields,
    options: { deliveryId?: string; signedAgoSeconds?: number; secret?: string } = {},
  ): MockDelivery => {
    counter += 1;
    const rawBody = buildMockWebhookBody({
      eventId: `${prefix}-EVT-${String(counter)}`,
      orderRef: params.orderRef,
      merchantRef: params.merchantRef,
      occurredAt: at(0),
      ...fields,
    });
    const headers = signMockWebhook({
      secret: options.secret ?? params.secret,
      deliveryId: options.deliveryId ?? `${prefix}-DLV-${String(counter)}`,
      timestampSeconds: nowSeconds - (options.signedAgoSeconds ?? 0),
      rawBody,
    });
    return { label, rawBody, headers };
  };
  const payment = (
    status: PlatformEventStatus,
    extra: Partial<MockWebhookBodyFields> = {},
  ): DeliveryFields => ({
    objectKind: 'payment',
    objectRef: params.paymentRef,
    status,
    amountMinor: params.amountMinor,
    currency: 'INR',
    ...extra,
  });
  // A refund or a chargeback names the payment it concerns (parentPaymentRef): the provider's reference of that payment.
  const refund = (): DeliveryFields => ({
    objectKind: 'refund',
    objectRef: `${params.paymentRef}-REFUND`,
    parentPaymentRef: params.paymentRef,
    status: 'refunded',
    amountMinor: params.amountMinor,
    currency: 'INR',
  });

  switch (scenario) {
    case 'success':
      return [make('authorized', payment('authorized')), make('captured', payment('captured'))];
    case 'failure':
      return [make('failed', payment('failed'))];
    case 'delayed':
      // The provider reports a capture from two hours ago; the signature is fresh, so it is accepted.
      return [make('captured, reported late', payment('captured', { occurredAt: at(7200) }))];
    case 'duplicate_event': {
      const eventId = `${prefix}-EVT-DUP`;
      const first = make('captured', payment('captured', { eventId }), {
        deliveryId: `${prefix}-DLV-A`,
      });
      return [
        first,
        // The very same delivery again (the replay guard upstream must make it inert).
        { ...first, label: 'captured, same delivery replayed' },
        // The same event under a new delivery id (the unique event key must make it inert).
        make('captured, same event under a new delivery id', payment('captured', { eventId }), {
          deliveryId: `${prefix}-DLV-B`,
        }),
      ];
    }
    case 'out_of_order_refund_first':
      return [make('refund before capture', refund()), make('captured', payment('captured'))];
    case 'out_of_order_failed_after_captured':
      return [
        make('captured', payment('captured')),
        make('failed after captured', payment('failed')),
      ];
    case 'partial_amount':
      return [
        make('captured, partial', payment('captured', { amountMinor: params.amountMinor / 2n })),
      ];
    case 'wrong_currency':
      return [make('captured, wrong currency', payment('captured', { currency: 'USD' }))];
    case 'wrong_merchant':
      return [
        make(
          'captured, wrong merchant',
          payment('captured', { merchantRef: MOCK_OTHER_MERCHANT_REF }),
        ),
      ];
    case 'refund':
      return [make('captured', payment('captured')), make('refunded', refund())];
    case 'chargeback':
      return [
        make('captured', payment('captured')),
        make('disputed', {
          objectKind: 'chargeback',
          objectRef: `${params.paymentRef}-DISPUTE`,
          parentPaymentRef: params.paymentRef,
          status: 'disputed',
          amountMinor: params.amountMinor,
          currency: 'INR',
        }),
      ];
    case 'unknown_outcome':
      // Nothing ever arrives: only a status lookup can settle the question.
      return [];
    case 'bad_signature':
      return [
        make('captured, wrong secret', payment('captured'), { secret: `${params.secret}-wrong` }),
      ];
    case 'old_timestamp':
      return [make('captured, stale signature', payment('captured'), { signedAgoSeconds: 3600 })];
  }
}

// ---------------------------------------------------------------------------------------------------------
// Labelled mock provider
// ---------------------------------------------------------------------------------------------------------

export interface MockPaymentProvider extends PaymentProviderPort {
  readonly scenario: MockPaymentScenario;
  /** createOrder calls that created something (a repeated operation key is not counted again). */
  readonly created: readonly CreateOrderRequest[];
}

function sameOrderRequest(a: CreateOrderRequest, b: CreateOrderRequest): boolean {
  return (
    a.receiptRef === b.receiptRef &&
    a.merchantRef === b.merchantRef &&
    a.amountMinor === b.amountMinor &&
    a.currency === b.currency &&
    a.purpose === b.purpose &&
    a.expiresAt === b.expiresAt
  );
}

export interface MockPaymentProviderOptions {
  readonly scenario?: MockPaymentScenario;
  /** What the mock reports as the settlement destination, e.g. a masked reference ending in four digits. */
  readonly settlementDestinationMaskedRef?: string | null;
}

/**
 * Reference text derived from the WHOLE operation key, for mock refs. A key that is already a safe reference is used
 * as is (readable in test output); any other key is hashed. Never truncated, so distinct keys never share a ref.
 */
export function mockRefSuffix(operationKey: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/.test(operationKey)
    ? operationKey
    : `HASH-${sha256Hex(operationKey).slice(0, 32)}`;
}

/** Fixed time the mock reports lookups and settlements at, so its output never depends on the wall clock. */
export const MOCK_PAYMENT_OBSERVED_AT = '2026-10-14T00:00:00.000Z';

/**
 * TEST DOUBLE, `mock_payment_provider`. No network, no money, deterministic. Allowed in local development and tests
 * only (staging is refused as well). Pair `webhookVerifier` with `buildMockDeliveries` for the receiver.
 */
export function createMockPaymentProvider(
  environment: AppEnvironment,
  options: MockPaymentProviderOptions = {},
): MockPaymentProvider {
  const descriptor: ProviderDescriptor = {
    key: MOCK_PAYMENT_PROVIDER_KEY,
    capability: 'payment_collection',
    mode: 'mock',
  };
  assertLocalOrTestOnly(descriptor, environment, 'mock payment provider');
  const scenario = options.scenario ?? 'success';
  const created: CreateOrderRequest[] = [];
  const orders = new Map<string, { orderRef: string; request: CreateOrderRequest }>();
  const lookups = new Map<string, number>();
  const orderRefFor = (operationKey: string): string => `MOCK-ORDER-${mockRefSuffix(operationKey)}`;
  const reportedMerchant = (request: CreateOrderRequest): string =>
    scenario === 'wrong_merchant' ? MOCK_OTHER_MERCHANT_REF : request.merchantRef;

  const capturedAmount = (request: CreateOrderRequest): bigint =>
    scenario === 'partial_amount' ? request.amountMinor / 2n : request.amountMinor;
  /** Whether, in this scenario, the provider ends up having captured money for the order. */
  const endsCaptured = scenario !== 'failure' && scenario !== 'wrong_currency';

  const toCreated = (request: CreateOrderRequest, orderRef: string): CreatedOrder => {
    const merchantRef = reportedMerchant(request);
    return {
      orderRef,
      merchantRef,
      settlementProfileRef: `MOCK-PROFILE-${merchantRef}`,
      checkoutLink: `https://mock-checkout.invalid/pay/${sha256Hex(request.operationKey).slice(0, 24)}`,
      expiresAt: request.expiresAt,
    };
  };

  return {
    descriptor,
    scenario,
    created,
    capabilities: {
      orderCreation: true,
      statusLookup: true,
      settlementReports: true,
      partialAmounts: true,
      webhooks: true,
    },
    webhookVerifier: { scheme: MOCK_PAYMENT_WEBHOOK_SCHEME, verify: verifyMockWebhook },
    createOrder(_ctx, request) {
      if (
        request.currency !== 'INR' ||
        request.amountMinor <= 0n ||
        request.amountMinor > MAX_MONEY_MINOR ||
        request.operationKey.length === 0
      ) {
        return Promise.resolve({ outcome: 'rejected', reason: 'invalid_request' });
      }
      const existing = orders.get(request.operationKey);
      if (existing) {
        // The same key with different parameters is a caller bug (a reused key), not the same order.
        if (!sameOrderRequest(existing.request, request)) {
          return Promise.resolve({ outcome: 'rejected', reason: 'invalid_request' });
        }
        return Promise.resolve({
          outcome: 'ok',
          value: toCreated(existing.request, existing.orderRef),
        });
      }
      const orderRef = orderRefFor(request.operationKey);
      orders.set(request.operationKey, { orderRef, request });
      created.push(request);
      if (scenario === 'unknown_outcome') {
        // The provider "may have" created the order: the caller must look it up, never create it again.
        return Promise.resolve({ outcome: 'unknown', reason: 'timeout' });
      }
      return Promise.resolve({ outcome: 'ok', value: toCreated(request, orderRef) });
    },
    getOrderStatus(_ctx, query) {
      const entry =
        orders.get(query.operationKey) ??
        [...orders.values()].find((o) => query.orderRef !== null && o.orderRef === query.orderRef);
      if (!entry) return Promise.resolve({ outcome: 'not_found' });
      if (scenario === 'wrong_currency') {
        return Promise.resolve({ outcome: 'rejected', reason: 'unsupported_currency' });
      }
      const key = entry.request.operationKey;
      const n = (lookups.get(key) ?? 0) + 1;
      lookups.set(key, n);
      const base = {
        source: 'provider_authenticated_lookup' as const,
        orderRef: entry.orderRef,
        currency: 'INR' as const,
        merchantRef: reportedMerchant(entry.request),
        observedAt: MOCK_PAYMENT_OBSERVED_AT,
      };
      const waiting =
        (scenario === 'delayed' && n <= 2) || (scenario === 'unknown_outcome' && n === 1);
      if (waiting) {
        return Promise.resolve({
          outcome: 'ok',
          value: {
            ...base,
            status: scenario === 'delayed' ? 'pending' : 'created',
            amountMinor: null,
            providerPaymentRef: null,
          },
        });
      }
      if (!endsCaptured) {
        return Promise.resolve({
          outcome: 'ok',
          value: { ...base, status: 'failed', amountMinor: null, providerPaymentRef: null },
        });
      }
      return Promise.resolve({
        outcome: 'ok',
        value: {
          ...base,
          status: 'captured',
          amountMinor: capturedAmount(entry.request),
          providerPaymentRef: `MOCK-PAY-${mockRefSuffix(key)}`,
        },
      });
    },
    fetchSettlements(_ctx, date) {
      if (!isValidIsoDate(date))
        return Promise.resolve({ outcome: 'rejected', reason: 'invalid_request' });
      const items: SettlementItem[] = endsCaptured
        ? [...orders.values()].map(({ orderRef, request }) => {
            const gross = capturedAmount(request);
            // Fees and tax are the provider's; the mock reports none rather than invent a rate.
            return {
              providerPaymentRef: `MOCK-PAY-${mockRefSuffix(request.operationKey)}`,
              orderRef,
              grossMinor: gross,
              feeMinor: 0n,
              taxMinor: 0n,
              netMinor: gross,
            };
          })
        : [];
      if (items.length === 0)
        return Promise.resolve({ outcome: 'ok', value: { date, batches: [] } });
      const gross = items.reduce((sum, item) => sum + item.grossMinor, 0n);
      return Promise.resolve({
        outcome: 'ok',
        value: {
          date,
          batches: [
            {
              batchRef: `MOCK-BATCH-${date}`,
              settlementRef: `MOCK-SETTLEMENT-${date}`,
              periodFrom: date,
              periodTo: date,
              destinationMaskedRef: options.settlementDestinationMaskedRef ?? null,
              grossMinor: gross,
              feeMinor: 0n,
              taxMinor: 0n,
              netMinor: gross,
              items,
            },
          ],
        },
      });
    },
  };
}
