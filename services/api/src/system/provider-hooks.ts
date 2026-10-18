import { type SystemPool } from './pool.js';
import { NO_SECRET_NAME, secretNamesInNamespace } from './secret-namespace.js';

/**
 * System-role access for the payment-provider callback receiver (`POST /v1/hooks/provider/:endpointToken`). Only the separate
 * callback-receiver process holds the system login; the public API never does (see `test/boundary.test.ts`).
 *
 * Two operations, nothing else:
 *   - `lookupConfig`: which ACTIVE payment configuration a routing-token HASH belongs to. Only the four columns the receiver needs
 *     are read: no lender id, no merchant, no account, no limits. The token itself never reaches this file.
 *   - `ingest`: `payments.ingest_provider_delivery`, the ONLY way a delivery enters the database. Every rule (replay, merchant,
 *     correlation, business validation) lives there; this file only hands the delivery over and reads the two-field answer.
 */

export type HookProviderMode = 'mock' | 'sandbox' | 'production';

/** The ACTIVE configuration a token hash routes to. Contains NAMES of secrets only, never a secret. */
export interface ProviderHookConfig {
  readonly configId: string;
  /** Provider key from the provider register, e.g. `mock_payment_provider`. */
  readonly provider: string;
  readonly providerMode: HookProviderMode;
  /**
   * Name of the environment variable or secret that holds the webhook signing secret. It is `NO_SECRET_NAME` (an empty string,
   * which no reader resolves to a value) when the configuration's secret names are not inside its lender's namespace: the
   * receiver then treats the secret as not configured (U51).
   */
  readonly webhookSecretRef: string;
}

/** The outcome words `payments.ingest_provider_delivery` accepts from the receiver. */
export type DeliveryOutcome = 'verified' | 'unverified' | 'stale_timestamp' | 'invalid';

/** The verified, normalised event as the SQL function reads it (money is a digit string of integer paise). */
export interface DeliveryEvent {
  readonly provider: string;
  readonly deliveryId: string;
  readonly eventId: string;
  readonly objectKind: string;
  readonly objectRef: string;
  readonly orderRef?: string;
  readonly status: string;
  readonly rank: number;
  readonly amountMinor: string | null;
  readonly currency: 'INR' | null;
  readonly occurredAt: string;
  readonly merchantRef?: string;
}

/** What the receiver hands to the database for one delivery. No body, header, signature, token or address is in here. */
export interface ProviderDelivery {
  readonly provider: string;
  readonly outcome: DeliveryOutcome;
  readonly reasonClass: string;
  readonly deliveryId: string | null;
  /** SHA-256 (hex) of the raw body bytes. */
  readonly payloadSha256: string;
  readonly scheme: string | null;
  readonly signaturePresent: boolean;
  readonly timestampSkewSeconds: number | null;
  readonly bodyBytes: number;
  /** HMAC-SHA256 (hex) of the client address under a server secret; the address itself is never sent. */
  readonly ipHmac: string;
  /** Present only for `verified`. */
  readonly event?: DeliveryEvent;
}

/** `{accepted, outcome}` exactly as the database answers. */
export type IngestAnswer =
  | { readonly accepted: true; readonly outcome: 'ok' }
  | { readonly accepted: false; readonly outcome: 'rejected' | 'unmatched' | 'invalid' };

export interface ProviderHookProcessor {
  lookupConfig(tokenHash: string): Promise<ProviderHookConfig | null>;
  ingest(tokenHash: string, delivery: ProviderDelivery): Promise<IngestAnswer>;
}

const MODES: readonly HookProviderMode[] = ['mock', 'sandbox', 'production'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROVIDER_KEY = /^[a-z][a-z0-9_]{2,49}$/;
const SECRET_NAME = /^[A-Z][A-Z0-9_]{2,63}$/;

/** Thrown when the database answers with something this layer does not understand. Carries no data from the answer. */
export class UnreadableAnswerError extends Error {
  constructor(what: string) {
    super(`unreadable ${what}`);
    this.name = 'UnreadableAnswerError';
  }
}

interface ConfigRow {
  id: unknown;
  provider: unknown;
  provider_mode: unknown;
  secret_ref: unknown;
  webhook_secret_ref: unknown;
  /** `secret_namespace` as stored, and what `private.secret_ref_prefix(lender_org_id)` says it must be. */
  secret_namespace: unknown;
  expected_namespace: unknown;
}

function readConfig(row: ConfigRow): ProviderHookConfig {
  const mode = MODES.find((candidate) => candidate === row.provider_mode);
  if (
    typeof row.id !== 'string' ||
    !UUID.test(row.id) ||
    typeof row.provider !== 'string' ||
    !PROVIDER_KEY.test(row.provider) ||
    mode === undefined ||
    typeof row.webhook_secret_ref !== 'string' ||
    !SECRET_NAME.test(row.webhook_secret_ref)
  ) {
    throw new UnreadableAnswerError('configuration row');
  }
  // The secret is read only when the configuration's namespace is set, is the namespace of its lender and both names are inside
  // it. Otherwise the name is not handed on at all, so nothing can read the environment under it.
  const inNamespace = secretNamesInNamespace({
    storedNamespace: typeof row.secret_namespace === 'string' ? row.secret_namespace : null,
    expectedNamespace: typeof row.expected_namespace === 'string' ? row.expected_namespace : null,
    secretRef: typeof row.secret_ref === 'string' ? row.secret_ref : '',
    webhookSecretRef: row.webhook_secret_ref,
  });
  return {
    configId: row.id,
    provider: row.provider,
    providerMode: mode,
    webhookSecretRef: inNamespace ? row.webhook_secret_ref : NO_SECRET_NAME,
  };
}

function readAnswer(value: unknown): IngestAnswer {
  if (typeof value === 'object' && value !== null) {
    const accepted = (value as { accepted?: unknown }).accepted;
    const outcome = (value as { outcome?: unknown }).outcome;
    if (accepted === true && outcome === 'ok') return { accepted: true, outcome: 'ok' };
    if (
      accepted === false &&
      (outcome === 'rejected' || outcome === 'unmatched' || outcome === 'invalid')
    ) {
      return { accepted: false, outcome };
    }
  }
  throw new UnreadableAnswerError('ingest answer');
}

/** The JSON object `payments.ingest_provider_delivery` reads (snake_case at the top, camelCase inside `event`). */
export function toDeliveryJson(delivery: ProviderDelivery): Record<string, unknown> {
  return {
    provider: delivery.provider,
    outcome: delivery.outcome,
    reason_class: delivery.reasonClass,
    ...(delivery.deliveryId !== null ? { delivery_id: delivery.deliveryId } : {}),
    payload_sha256: delivery.payloadSha256,
    ...(delivery.scheme !== null ? { scheme: delivery.scheme } : {}),
    signature_present: delivery.signaturePresent,
    ...(delivery.timestampSkewSeconds !== null
      ? { timestamp_skew_seconds: delivery.timestampSkewSeconds }
      : {}),
    body_bytes: delivery.bodyBytes,
    ip_hmac: delivery.ipHmac,
    ...(delivery.event !== undefined
      ? {
          event: {
            provider: delivery.event.provider,
            deliveryId: delivery.event.deliveryId,
            eventId: delivery.event.eventId,
            objectKind: delivery.event.objectKind,
            objectRef: delivery.event.objectRef,
            ...(delivery.event.orderRef !== undefined ? { orderRef: delivery.event.orderRef } : {}),
            status: delivery.event.status,
            rank: delivery.event.rank,
            amountMinor: delivery.event.amountMinor,
            currency: delivery.event.currency,
            occurredAt: delivery.event.occurredAt,
            ...(delivery.event.merchantRef !== undefined
              ? { merchantRef: delivery.event.merchantRef }
              : {}),
          },
        }
      : {}),
  };
}

export function createProviderHookProcessor(pool: SystemPool): ProviderHookProcessor {
  return {
    async lookupConfig(tokenHash) {
      return pool.withSystem(async (tx) => {
        const result = await tx.query<ConfigRow>(
          `select id::text as id, provider, provider_mode::text as provider_mode, secret_ref, webhook_secret_ref,
                  secret_namespace, private.secret_ref_prefix(lender_org_id) as expected_namespace
             from payments.lender_payment_configs
            where endpoint_token_hash = $1 and status = 'active'`,
          [tokenHash],
        );
        const row = result.rows[0];
        return row === undefined ? null : readConfig(row);
      });
    },
    async ingest(tokenHash, delivery) {
      return pool.withSystem(async (tx) => {
        const result = await tx.query<{ r: unknown }>(
          'select payments.ingest_provider_delivery($1, $2::jsonb) as r',
          [tokenHash, JSON.stringify(toDeliveryJson(delivery))],
        );
        return readAnswer(result.rows[0]?.r);
      });
    },
  };
}
