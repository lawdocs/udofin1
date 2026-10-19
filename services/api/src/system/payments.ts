import { type HandoffKind } from '@udofin/adapters';
import { z } from 'zod';
import { type SystemPool } from './pool.js';

/**
 * Worker-side payment and mandate operations: read-only selects the system role is granted, and the database functions only the
 * system login may run (migrations 913, 915 and 917). Every call is its own short transaction. No provider is ever called from
 * inside one: the handlers call the provider between these calls, never during them.
 *
 * Nothing here decides anything. The database owns every rule (which transitions are allowed, what an order may cost, whether a
 * link may be kept); this module passes ids and the provider's answer through and returns what the database said.
 */

/** The closed list `payments.record_order_failed` accepts. */
export type OrderFailureClass =
  'provider_rejected' | 'provider_unavailable' | 'merchant_mismatch' | 'invalid_request';

/** The closed list `payments.record_mandate_handoff` accepts. */
export type MandateHandoffOutcome = 'handoff' | 'rejected' | 'unknown' | 'not_sent';

export type MandateRailName = 'enach_api' | 'upi_autopay';

/** A lender's payment configuration as the worker needs it to pick a provider (names of secrets, never secrets). */
export interface PaymentConfigRecord {
  readonly configId: string;
  readonly lenderOrgId: string;
  /** `active`, `suspended`, `retired` ... as stored. The worker calls a provider only under an active configuration. */
  readonly status: string;
  readonly provider: string;
  readonly providerMode: 'mock' | 'sandbox' | 'live';
  /** The lender's own merchant reference from the verified merchant registry (a reference, not a secret). */
  readonly merchantRef: string;
  readonly secretRef: string;
  readonly webhookSecretRef: string;
}

export interface PaymentIntentRecord {
  readonly id: string;
  readonly lenderOrgId: string;
  /** `created`, `pending`, `succeeded`, `failed`, `expired`, `cancelled`. */
  readonly status: string;
  readonly amountMinor: bigint;
  readonly purpose: string;
  /** UTC ISO-8601 or null. */
  readonly linkExpiresAt: string | null;
  readonly providerOrderRef: string | null;
  /** Undefined for a history row that has no configuration. */
  readonly config: PaymentConfigRecord | undefined;
}

export interface MandateRecord {
  readonly id: string;
  readonly lenderOrgId: string;
  readonly status: string;
  readonly rail: MandateRailName;
  /** The lender's own merchant reference, copied onto the mandate at creation. */
  readonly creditorRef: string;
  readonly providerMandateRef: string | null;
  readonly maxAmountMinor: bigint;
  /** YYYY-MM-DD. */
  readonly startDate: string;
  readonly endDate: string;
  /** Masked reference such as XXXXXX1234. Never a full account number. */
  readonly maskedAccountRef: string;
  readonly cancelRequested: boolean;
  readonly cancelSent: boolean;
  readonly config: PaymentConfigRecord | undefined;
}

export interface ApplyEventResult {
  /** `applied`, `already_applied`, `ignored_stale`, `deferred`, `exception`, `ignored_unsupported`, ... as the database says. */
  readonly outcome: string;
  readonly reason: string | undefined;
}

export interface PaymentsProcessor {
  /** Undefined when no intent has this id. */
  loadIntent(intentId: string): Promise<PaymentIntentRecord | undefined>;
  recordOrderCreated(
    intentId: string,
    providerOrderRef: string,
    linkExpiresAt: string | null,
  ): Promise<string>;
  recordOrderFailed(intentId: string, reason: OrderFailureClass): Promise<string>;
  /** Keeps the SEALED link. The ciphertext is opaque here; nothing in this module can read it. */
  storeHandoffLink(input: {
    kind: HandoffKind;
    subjectId: string;
    keyVersion: string;
    ciphertext: Uint8Array;
    expiresAt: string;
  }): Promise<void>;
  applyProviderEvent(eventId: string): Promise<ApplyEventResult>;
  /** Undefined when no mandate has this id. */
  loadMandate(mandateId: string): Promise<MandateRecord | undefined>;
  recordMandateHandoff(
    mandateId: string,
    outcome: MandateHandoffOutcome,
    providerMandateRef: string | null,
    expiresAt: string | null,
  ): Promise<string>;
  markMandateCancelSent(mandateId: string): Promise<void>;
  /**
   * Queues a `mandate.cancel` event under a key of its own, for a cancellation the borrower asked for while the hand-off was in
   * flight (the event queued when the request was made may already have run before the provider reference existed). The same
   * key twice queues one event. Idempotent: a mandate whose cancellation was already sent is skipped by the handler.
   */
  enqueueMandateCancel(mandateId: string): Promise<void>;
}

/** The SQLSTATE and hint of a database error, nothing else (a message can carry data). */
export interface DatabaseFailure {
  readonly code: string | undefined;
  readonly hint: string | undefined;
}

export function databaseFailureOf(error: unknown): DatabaseFailure {
  if (typeof error !== 'object' || error === null) return { code: undefined, hint: undefined };
  const { code, hint } = error as { code?: unknown; hint?: unknown };
  return {
    code: typeof code === 'string' ? code : undefined,
    hint: typeof hint === 'string' ? hint : undefined,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Row shapes. The database returns bigint as text and dates as text we format ourselves; both are parsed here once.
// ---------------------------------------------------------------------------------------------------------

/** Integer paise as text (the database check is 1 to 1e14). Never `Number()`: a bigint all the way. */
const Minor = z
  .string()
  .regex(/^[1-9][0-9]{0,14}$/)
  .transform((text) => BigInt(text));

const ConfigColumns = {
  config_id: z.uuid().nullable(),
  config_status: z.string().nullable(),
  config_provider: z.string().nullable(),
  config_mode: z.enum(['mock', 'sandbox', 'production']).nullable(),
  merchant_ref: z.string().nullable(),
  secret_ref: z.string().nullable(),
  webhook_secret_ref: z.string().nullable(),
};

function configOf(
  lenderOrgId: string,
  row: {
    config_id: string | null;
    config_status: string | null;
    config_provider: string | null;
    config_mode: 'mock' | 'sandbox' | 'production' | null;
    merchant_ref: string | null;
    secret_ref: string | null;
    webhook_secret_ref: string | null;
  },
): PaymentConfigRecord | undefined {
  if (
    row.config_id === null ||
    row.config_status === null ||
    row.config_provider === null ||
    row.config_mode === null ||
    row.merchant_ref === null ||
    row.secret_ref === null ||
    row.webhook_secret_ref === null
  ) {
    return undefined;
  }
  return {
    configId: row.config_id,
    lenderOrgId,
    status: row.config_status,
    provider: row.config_provider,
    // The database calls the live mode `production`; the provider resolver calls it `live`.
    providerMode: row.config_mode === 'production' ? 'live' : row.config_mode,
    merchantRef: row.merchant_ref,
    secretRef: row.secret_ref,
    webhookSecretRef: row.webhook_secret_ref,
  };
}

const IntentRow = z.object({
  id: z.uuid(),
  lender_org_id: z.uuid(),
  status: z.string(),
  amount_minor: Minor,
  purpose: z.string(),
  link_expires_at: z.date().nullable(),
  provider_order_ref: z.string().nullable(),
  ...ConfigColumns,
});

const MandateRow = z.object({
  id: z.uuid(),
  lender_org_id: z.uuid(),
  status: z.string(),
  rail: z.enum(['enach_api', 'upi_autopay']),
  creditor_ref: z.string(),
  provider_mandate_ref: z.string().nullable(),
  max_amount_minor: Minor,
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  masked_account_ref: z.string(),
  cancel_requested: z.boolean(),
  cancel_sent: z.boolean(),
  ...ConfigColumns,
});

const ApplyRow = z.object({
  outcome: z.string(),
  reason: z.string().optional(),
});

// Only the columns the worker needs. The configuration and its merchant are joined with the lender kept in both keys.
const CONFIG_SELECT = `c.id as config_id, c.status as config_status, c.provider as config_provider, c.provider_mode::text as config_mode,
       mr.merchant_ref, c.secret_ref, c.webhook_secret_ref`;
const CONFIG_JOIN = `left join payments.lender_payment_configs c on c.id = x.config_id and c.lender_org_id = x.lender_org_id
  left join payments.merchant_registry mr on mr.id = c.merchant_registry_id and mr.owner_org_id = c.lender_org_id`;

export function createPaymentsProcessor(pool: SystemPool): PaymentsProcessor {
  const one = async <T>(sql: string, values: unknown[]): Promise<T> =>
    pool.withSystem(async (tx) => {
      const r = await tx.query<{ r: T }>(sql, values);
      return r.rows[0]?.r as T;
    });
  return {
    loadIntent: (intentId) =>
      pool.withSystem(async (tx) => {
        const result = await tx.query<Record<string, unknown>>(
          `select x.id, x.lender_org_id, x.status::text as status, x.amount_minor::text as amount_minor, x.purpose::text as purpose,
                  x.link_expires_at, x.provider_order_ref, ${CONFIG_SELECT}
             from payments.payment_intents x
             ${CONFIG_JOIN}
            where x.id = $1::uuid`,
          [intentId],
        );
        const row = result.rows[0];
        if (!row) return undefined;
        const parsed = IntentRow.parse(row);
        return {
          id: parsed.id,
          lenderOrgId: parsed.lender_org_id,
          status: parsed.status,
          amountMinor: parsed.amount_minor,
          purpose: parsed.purpose,
          linkExpiresAt:
            parsed.link_expires_at === null ? null : parsed.link_expires_at.toISOString(),
          providerOrderRef: parsed.provider_order_ref,
          config: configOf(parsed.lender_org_id, parsed),
        };
      }),

    recordOrderCreated: (intentId, providerOrderRef, linkExpiresAt) =>
      one<string>('select payments.record_order_created($1::uuid, $2, $3::timestamptz) as r', [
        intentId,
        providerOrderRef,
        linkExpiresAt,
      ]),

    recordOrderFailed: (intentId, reason) =>
      one<string>('select payments.record_order_failed($1::uuid, $2) as r', [intentId, reason]),

    storeHandoffLink: async ({ kind, subjectId, keyVersion, ciphertext, expiresAt }) => {
      await pool.withSystem((tx) =>
        tx.query(
          'select payments.store_handoff_link($1, $2::uuid, $3, $4::bytea, $5::timestamptz)',
          [kind, subjectId, keyVersion, Buffer.from(ciphertext), expiresAt],
        ),
      );
    },

    applyProviderEvent: async (eventId) => {
      const raw = await one<unknown>('select payments.apply_provider_event($1::uuid) as r', [
        eventId,
      ]);
      const parsed = ApplyRow.parse(raw);
      return { outcome: parsed.outcome, reason: parsed.reason };
    },

    loadMandate: (mandateId) =>
      pool.withSystem(async (tx) => {
        const result = await tx.query<Record<string, unknown>>(
          `select x.id, x.lender_org_id, x.status, x.rail, x.creditor_ref, x.provider_mandate_ref, x.max_amount_minor::text as max_amount_minor,
                  to_char(x.start_date, 'YYYY-MM-DD') as start_date, to_char(x.end_date, 'YYYY-MM-DD') as end_date, x.masked_account_ref,
                  x.cancel_requested_at is not null as cancel_requested, x.cancel_sent_at is not null as cancel_sent, ${CONFIG_SELECT}
             from payments.mandates x
             ${CONFIG_JOIN}
            where x.id = $1::uuid`,
          [mandateId],
        );
        const row = result.rows[0];
        if (!row) return undefined;
        const parsed = MandateRow.parse(row);
        return {
          id: parsed.id,
          lenderOrgId: parsed.lender_org_id,
          status: parsed.status,
          rail: parsed.rail,
          creditorRef: parsed.creditor_ref,
          providerMandateRef: parsed.provider_mandate_ref,
          maxAmountMinor: parsed.max_amount_minor,
          startDate: parsed.start_date,
          endDate: parsed.end_date,
          maskedAccountRef: parsed.masked_account_ref,
          cancelRequested: parsed.cancel_requested,
          cancelSent: parsed.cancel_sent,
          config: configOf(parsed.lender_org_id, parsed),
        };
      }),

    recordMandateHandoff: (mandateId, outcome, providerMandateRef, expiresAt) =>
      one<string>(
        'select payments.record_mandate_handoff($1::uuid, $2, $3, $4::timestamptz) as r',
        [mandateId, outcome, providerMandateRef, expiresAt],
      ),

    markMandateCancelSent: async (mandateId) => {
      await pool.withSystem((tx) =>
        tx.query('select payments.mark_mandate_cancel_sent($1::uuid)', [mandateId]),
      );
    },

    enqueueMandateCancel: async (mandateId) => {
      await pool.withSystem((tx) =>
        tx.query(
          `select ops.enqueue_event('mandate.cancel', jsonb_build_object('mandate_id', $1::text), null, $2)`,
          [mandateId, `mandate.cancel:${mandateId}:after_handoff`],
        ),
      );
    },
  };
}
