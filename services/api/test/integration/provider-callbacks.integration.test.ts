// The payment-provider callback receiver (`POST /v1/hooks/provider/:endpointToken`) over HTTP against a REAL migrated Postgres, with the
// real system login, the real callback app (`buildCallbackApp` + `registerProviderHooks`, as `workers/callbacks-main.ts` assembles
// them) and real SIGNED deliveries from the labelled mock provider (`buildMockDeliveries`, `signMockWebhook`). Runs only with
// INTEGRATION_ADMIN_URL and INTEGRATION_SYSTEM_URL (a freshly migrated database); INTEGRATION_API_URL adds one database-failure case.
// Synthetic data only. No real provider exists: nothing here proves a real integration.
//
// What is checked after every delivery is what the database kept: `payments.webhook_receipts` (one row per delivery, whatever the
// outcome), `payments.provider_events` (verified events only), `ops.seen_webhooks` (the replay store, consumed only after
// verification, correlation and business validation) and `ops.outbox_events` (ids only). Every query is scoped to this file's own
// lenders, configurations, delivery ids or payload hashes: other integration files share the database.
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import {
  buildMockDeliveries,
  buildMockWebhookBody,
  MOCK_PAYMENT_PROVIDER_KEY,
  MOCK_PAYMENT_WEBHOOK_SCHEME,
  signMockWebhook,
  type MockDelivery,
  type AppEnvironment,
  type MockPaymentScenario,
} from '@udofin/adapters';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { loggerOptions } from '../../src/logger.js';
import {
  createProviderHookProcessor,
  type ProviderHookProcessor,
} from '../../src/system/provider-hooks.js';
import { createRoutingProcessor } from '../../src/system/routing.js';
import { createSystemPool, type SystemPool } from '../../src/system/pool.js';
import { buildCallbackApp } from '../../src/workers/lender-callbacks.js';
import {
  addressHmac,
  hashEndpointToken,
  IP_HMAC_SECRET_NAME,
  PROVIDER_HOOK_BODY_LIMIT,
  registerProviderHooks,
} from '../../src/workers/provider-callbacks.js';

const ADMIN = process.env.INTEGRATION_ADMIN_URL;
const API = process.env.INTEGRATION_API_URL;
const SYSTEM = process.env.INTEGRATION_SYSTEM_URL;
const enabled = Boolean(ADMIN && SYSTEM);

const PROVIDER = MOCK_PAYMENT_PROVIDER_KEY;
// Ids are unique per run, so the file can run again against a database an earlier run used.
const RUN = randomBytes(4).toString('hex');
/** Receipts are read from this moment on: a body that is the same in every run (an empty one) has receipts from earlier runs. */
const STARTED = new Date(Date.now() - 2000);
const RAIL_LIMITS = JSON.stringify({
  enach_api: { max_mandate_amount_minor: 5_000_000, needs_afa_each_debit: false },
});
const LOANS = 13;
const phone = () => `91${Math.floor(1_000_000_000 + Math.random() * 8_999_999_999)}`;
const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const UUID_RUN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const HEX_RUN = /[0-9a-f]{32,}/gi;

/** The fixed answer of every refusal before a delivery is authenticated. */
const UNIFORM_401 = {
  type: 'about:blank',
  title: 'Unauthorized',
  status: 401,
  code: 'invalid_signature',
};

interface Lender {
  readonly id: string;
  readonly tag: string;
  readonly merchantRef: string;
  readonly configId: string;
  /** The real routing token (what the provider is given once); the database keeps only its hash. */
  readonly token: string;
  readonly webhookSecretRef: string;
  readonly secret: string;
  readonly borrowerUser: string | null;
  readonly borrowerId: string | null;
  readonly phone: string | null;
  readonly loans: readonly string[];
}

interface BuildOptions {
  readonly loans?: number;
  /** Name of the webhook secret; defaults to one of the lender's own. */
  readonly webhookSecretRef?: string;
  readonly secret?: string;
}

describe.skipIf(!enabled)('provider callback receiver over a real database', () => {
  let admin: pg.Pool;
  /** The receiver's own login: the plain system role, which may NOT move a mock-mode mandate (that is the worker's session). */
  let receiverPool: SystemPool;
  /** The worker's session for fixtures and for applying events: mock providers allowed, as a local or test deployment must. */
  let workerPool: SystemPool;
  let callbacks: FastifyInstance;
  let A: Lender; // the lender under test
  let B: Lender; // another lender, its own secret
  let C: Lender; // another lender that shares A's webhook secret
  let M: Lender; // for the merchant mismatch
  let S1: Lender; // configuration will be suspended
  let S2: Lender; // configuration will be retired

  // Secrets are resolved by NAME, as in a deployment. The values exist only in this process.
  const secrets = new Map<string, string>();
  const IP_KEY = `ip-key-${randomBytes(24).toString('hex')}`;
  secrets.set(IP_HMAC_SECRET_NAME, IP_KEY);
  const secretOf = (name: string): string | undefined => secrets.get(name);

  /** Event rows and outbox rows this file made: marked completed at the end so no other file's worker trips over them. */
  const myEventRows = new Set<string>();
  /** Everything a response or a log could leak: scanned at the end. */
  const everySeenResponse: string[] = [];
  const everyPayloadSha = new Set<string>();
  let nextAddress = 1;
  const freshAddress = () => `10.77.${(nextAddress >> 8) & 255}.${nextAddress++ & 255}`;

  const q = async <T extends pg.QueryResultRow>(sql: string, values: unknown[] = []) =>
    (await admin.query<T>(sql, values)).rows;
  const one = async <T extends pg.QueryResultRow>(sql: string, values: unknown[] = []) => {
    const rows = await q<T>(sql, values);
    if (!rows[0]) throw new Error('expected a row');
    return rows[0];
  };

  // ------------------------------------------------------------------------------------------------------
  // Acting as a borrower (the same way the pgTAP suites and the worker test do)
  // ------------------------------------------------------------------------------------------------------
  async function asBorrower<T extends pg.QueryResultRow>(
    user: string,
    sql: string,
    values: unknown[] = [],
  ): Promise<T[]> {
    const c = await admin.connect();
    try {
      await c.query('begin');
      await c.query(`select set_config('udofin.allow_mock_providers', 'on', true)`);
      await c.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: user, role: 'authenticated', aal: 'aal2' }),
      ]);
      await c.query('set local role authenticated');
      const result = await c.query<T>(sql, values);
      await c.query('commit');
      return result.rows;
    } catch (error) {
      await c.query('rollback');
      throw error;
    } finally {
      c.release();
    }
  }
  const today = async (plusDays: number) =>
    (
      await one<{ d: string }>(
        `select to_char((clock_timestamp() at time zone 'Asia/Kolkata')::date + $1::int, 'YYYY-MM-DD') as d`,
        [plusDays],
      )
    ).d;

  /** A payment intent of the lender's loan through the real borrower function, in status `created` (no provider order yet). */
  async function requestIntent(lender: Lender, loanIndex: number): Promise<string> {
    if (!lender.borrowerUser) throw new Error('lender without a borrower');
    const [row] = await asBorrower<{ id: string }>(
      lender.borrowerUser,
      `select payments.request_payment($1::uuid, 'installment'::payments.intent_purpose, 475000::bigint, $2, null) as id`,
      [lender.loans[loanIndex], `d-it-pay-${randomUUID()}`],
    );
    if (!row) throw new Error('no intent');
    return row.id;
  }
  /** What the payments worker does after the provider created the order: the intent becomes `pending` with the order reference. */
  const recordOrder = (intent: string, orderRef: string) =>
    workerPool.withSystem((tx) =>
      tx.query('select payments.record_order_created($1::uuid, $2, null)', [intent, orderRef]),
    );
  /** An intent with an order reference at the provider: what a delivery for a payment needs to match. */
  async function pendingIntent(lender: Lender, loanIndex: number, tag: string) {
    const intent = await requestIntent(lender, loanIndex);
    const orderRef = `D-ORDER-${RUN}-${tag}`;
    await recordOrder(intent, orderRef);
    return { intent, orderRef, paymentRef: `D-PAY-${RUN}-${tag}` };
  }
  const intentRow = (id: string) =>
    one<{ status: string; provider_order_ref: string | null }>(
      `select status::text as status, provider_order_ref from payments.payment_intents where id = $1`,
      [id],
    );

  // ------------------------------------------------------------------------------------------------------
  // Fixture: a lender with an ACTIVE mock configuration (two-person), optionally with a borrower and active loans
  // ------------------------------------------------------------------------------------------------------
  async function buildLender(name: string, options: BuildOptions = {}): Promise<Lender> {
    const id = randomUUID();
    const tag = id.replaceAll('-', '').slice(0, 12);
    const loanCount = options.loans ?? 0;
    // The secret names of a configuration lie inside the namespace of its lender (L, the last twelve hexadecimal digits of the
    // lender id in capitals, an underscore): the receiver hands on a webhook secret name only then (U51).
    const namespace = `L${id.replaceAll('-', '').slice(-12).toUpperCase()}_`;
    const webhookSecretRef = options.webhookSecretRef ?? `${namespace}HOOK_${tag.toUpperCase()}`;
    const secret = options.secret ?? `not_a_secret_${randomBytes(12).toString('hex')}`;
    if (!secrets.has(webhookSecretRef)) secrets.set(webhookSecretRef, secret);
    const token = randomBytes(32).toString('base64url');
    const merchantRef = `SAMPLE-MERCHANT-D-${tag}`;
    const [
      maker,
      checker,
      submitter,
      switchRequester,
      switchDecider,
      productMaker,
      productApprover,
    ] = Array.from({ length: 7 }, () => randomUUID());
    const borrowerUser = loanCount > 0 ? randomUUID() : null;
    const borrowerPhone = loanCount > 0 ? phone() : null;
    const c = await admin.connect();
    try {
      await c.query('begin');
      await c.query(`select set_config('udofin.allow_mock_providers', 'on', true)`);
      for (const u of [
        maker,
        checker,
        submitter,
        switchRequester,
        switchDecider,
        productMaker,
        productApprover,
      ]) {
        await c.query(
          `insert into auth.users (id, raw_app_meta_data) values ($1, '{"actor_type":"staff"}')`,
          [u],
        );
      }
      let borrowerId: string | null = null;
      if (borrowerUser) {
        await c.query(
          `insert into auth.users (id, phone, raw_app_meta_data) values ($1, $2, '{}')`,
          [borrowerUser, borrowerPhone],
        );
        borrowerId =
          (
            await c.query<{ id: string }>('select id from identity.borrowers where user_id = $1', [
              borrowerUser,
            ])
          ).rows[0]?.id ?? null;
        if (!borrowerId) throw new Error('no borrower');
      }
      await c.query(
        `insert into tenancy.organizations (id, kind, legal_name, display_name, regulator_registration_no, status) values ($1, 'lender', $2, $3, $4, 'active')`,
        [id, `${name} D Ltd (test)`, name, `IT-D-${tag}`],
      );
      await c.query(
        `insert into onboarding.lender_gates (lender_org_id, stage) values ($1, 'activated') on conflict (lender_org_id) do update set stage = 'activated'`,
        [id],
      );
      await c.query(
        `insert into payments.account_format_rules (country, account_type, version, min_digits, max_digits, ifsc_required, status, evidence_label, source_note,
                                                    effective_from, drafted_by, submitted_by, submitted_at, approved_by, approved_at)
           values ('IN', 'sample_fixture', 1, 9, 18, true, 'approved', 'unverified', 'SAMPLE fixture rule, not a real source', date '2026-01-01', $1, $1, now(), $2, now())
           on conflict (country, account_type, version) do nothing`,
        [maker, checker],
      );
      await c.query(
        `insert into payments.fingerprint_key_versions (key_version, proposed_by) values (1, $1) on conflict (key_version) do nothing`,
        [maker],
      );
      await c.query(
        `update payments.fingerprint_key_versions set status = 'active', approved_by = $1, approved_at = now() where key_version = 1 and status = 'proposed'`,
        [checker],
      );
      const rule = (
        await c.query<{ id: string }>(
          `select id from payments.account_format_rules where country = 'IN' and account_type = 'sample_fixture' and version = 1`,
        )
      ).rows[0]?.id;
      const registry = (
        await c.query<{ id: string }>(
          `insert into payments.account_registry (fingerprint, key_version, masked_ref, country, account_type, format_rule_id, format_validated, owner_kind, owner_org_id,
                                                  legal_owner_name, permitted_purposes, verification_status, evidence_ref, effective_from, registered_by,
                                                  idempotency_key, verified_by, verified_at)
             values (encode(sha256(convert_to('SAMPLE-FIXTURE-' || $1::uuid::text, 'UTF8')), 'hex'), 1, 'XXXXXX0000', 'IN', 'sample_fixture', $2, true, 'lender', $1,
                     'SAMPLE Lender Ltd (fixture)', array['repayment_settlement'], 'verified', 'SAMPLE-EVIDENCE-1', current_date - 30, $3, $4, $5, now())
             returning id`,
          [id, rule, maker, `sample-fixture-registry-d-${tag}`, checker],
        )
      ).rows[0]?.id;
      const settlement = randomUUID();
      await c.query(
        `insert into tenancy.lender_settlement_accounts (id, lender_org_id, label, bank_name, masked_account_ref, status, registry_id, verified_by, verified_at)
           values ($1, $2, 'SAMPLE collections', 'Test Bank', 'XXXXXX0000', 'verified', $3, $4, now())`,
        [settlement, id, registry, maker],
      );
      await c.query(
        `insert into payments.provider_register (provider, display_name, kind, status, authorisation_evidence_ref)
           values ($1, 'SAMPLE mock provider (fixture)', 'payment_and_mandate', 'approved', 'SAMPLE-AUTH-EVIDENCE-1') on conflict (provider) do nothing`,
        [PROVIDER],
      );
      const merchant = (
        await c.query<{ id: string }>(
          `insert into payments.merchant_registry (provider, merchant_ref, owner_kind, owner_org_id, purpose, claimed_by, verification_status,
                                                    verification_evidence_ref, verified_by, verified_at)
             values ($1, $2, 'lender', $3, 'repayment', $4, 'verified', 'SAMPLE-EVIDENCE-3', $5, now()) returning id`,
          [PROVIDER, merchantRef, id, maker, checker],
        )
      ).rows[0]?.id;
      const configId = (
        await c.query<{ id: string }>(
          `insert into payments.lender_payment_configs (lender_org_id, provider, provider_mode, merchant_registry_id, settlement_account_id, secret_ref, webhook_secret_ref,
                                                        endpoint_token_hash, rail_limits, rail_limits_source, evidence_ref, contract_section_ref, idempotency_key, drafted_by,
                                                        secret_namespace)
             values ($1, $2, 'mock', $3, $4, $5, $6, $7, $8::jsonb, 'SAMPLE copy of provider documentation (fixture)',
                     'SAMPLE-EVIDENCE-2', 'SAMPLE-CONTRACT-1', $9, $10, $11) returning id`,
          [
            id,
            PROVIDER,
            merchant,
            settlement,
            `${namespace}PROV_KEY_${tag.toUpperCase()}`,
            webhookSecretRef,
            hashEndpointToken(token),
            RAIL_LIMITS,
            `sample-fixture-config-d-${tag}`,
            maker,
            namespace,
          ],
        )
      ).rows[0]?.id;
      if (!configId) throw new Error('no config');
      await c.query(
        `update payments.lender_payment_configs set status = 'pending_approval', submitted_by = $2, submitted_at = now(), status_changed_by = $2 where id = $1`,
        [configId, submitter],
      );
      await c.query(
        `update payments.lender_payment_configs set status = 'active', approved_by = $2, approved_at = now(), status_changed_by = $2 where id = $1`,
        [configId, checker],
      );

      const loans: string[] = [];
      if (borrowerId) {
        // The activation switches (an applied two-person request and the switch itself, as the pgTAP suites do).
        for (const feature of ['payments', 'servicing_sync', 'mandates']) {
          const request = (
            await c.query<{ id: string }>(
              `insert into servicing.feature_change_requests (lender_org_id, feature, enable, mode, status, evidence, requested_by, idempotency_key, decided_by, decided_at, applied_at)
                 values ($1, $2, true, 'two_person', 'applied', '{"contract_ref":"SAMPLE-D"}', $3, $4, $5, now(), now()) returning id`,
              [id, feature, switchRequester, `it-d-req-${feature}-${tag}`, switchDecider],
            )
          ).rows[0]?.id;
          await c.query(
            `insert into servicing.lender_features (lender_org_id, feature, enabled, evidence, enabled_by, enabled_at, last_change_request_id)
               values ($1, $2, true, '{"contract_ref":"SAMPLE-D"}', $3, now(), $4)`,
            [id, feature, switchDecider, request],
          );
        }
        const product = randomUUID();
        const version = randomUUID();
        for (const [user, role] of [
          [productMaker, 'lender_admin'],
          [productApprover, 'product_approver'],
        ] as const) {
          const m = await c.query<{ id: string }>(
            'insert into tenancy.memberships (org_id, user_id, status) values ($1, $2, $3) returning id',
            [id, user, 'active'],
          );
          await c.query(
            `insert into tenancy.membership_roles (membership_id, role_id)
             select $1, r.id from tenancy.roles r where r.org_id is null and r.applies_to = 'lender'::tenancy.organization_kind and r.key = $2`,
            [m.rows[0]?.id, role],
          );
        }
        await c.query(
          `insert into lending.loan_products (id, lender_org_id, category_key, code, name, status) values ($1, $2, 'personal', $3, 'D Personal Loan', 'active')`,
          [product, id, `PD-${tag.slice(0, 6).toUpperCase()}`],
        );
        await c.query(
          `insert into lending.loan_product_versions (id, product_id, lender_org_id, version, status, min_amount_minor, max_amount_minor, min_tenure_days, max_tenure_days,
             rate_type, min_annual_rate_bps, max_annual_rate_bps, drafted_by, approved_by, approved_at, effective_from)
             values ($1, $2, $3, 1, 'approved', 1000000, 50000000, 180, 1825, 'fixed', 1400, 2400, $4, $5, now(), now())`,
          [version, product, id, productMaker, productApprover],
        );
        for (let n = 1; n <= loanCount; n += 1) {
          const request = randomUUID();
          const application = randomUUID();
          const loan = randomUUID();
          loans.push(loan);
          await c.query(
            `insert into lending.loan_requests (id, borrower_id, category_key, requested_amount_minor, requested_tenure_days, purpose_code, status)
               values ($1, $2, 'personal', 5000000, 365, 'education', 'submitted')`,
            [request, borrowerId],
          );
          await c.query(
            `insert into lending.applications (id, lender_org_id, loan_request_id, borrower_id, product_version_id, status, requested_amount_minor, requested_tenure_days, lender_reference)
               values ($1, $2, $3, $4, $5, 'disbursed', 5000000, 365, $6)`,
            [application, id, request, borrowerId, version, `SAMPLE-APP-D-${tag}-${String(n)}`],
          );
          await c.query(
            `insert into servicing.loan_accounts (id, lender_org_id, application_id, borrower_id, source_system, lms_loan_ref, status, sanctioned_amount_minor)
               values ($1, $2, $3, $4, 'lender_lms', $5, 'active', 5000000)`,
            [loan, id, application, borrowerId, `SAMPLE-LN-D-${tag}-${String(n)}`],
          );
          await c.query(
            `insert into servicing.balance_snapshots (lender_org_id, loan_account_id, version, status, outstanding_principal_minor, total_overdue_minor, next_due_on, next_due_minor,
               days_past_due, source_system, source_record_id, reported_as_of, content_sha256)
               values ($1, $2, 1, 'active', 4000000, 0, (clock_timestamp() at time zone 'Asia/Kolkata')::date + 3, 475000, 0, 'file_import', $3, clock_timestamp() - interval '1 hour', $4)`,
            [id, loan, `SRC-D-${tag}-${String(n)}`, sha256(`snap-${loan}`)],
          );
          const snapshot = randomUUID();
          await c.query(
            `insert into servicing.schedule_snapshots (id, lender_org_id, loan_account_id, version) values ($1, $2, $3, 1)`,
            [snapshot, id, loan],
          );
          await c.query(
            `insert into servicing.schedule_installments (snapshot_id, lender_org_id, seq, due_date, principal_minor, interest_minor)
               values ($1, $2, 1, (clock_timestamp() at time zone 'Asia/Kolkata')::date + 3, 400000, 75000),
                      ($1, $2, 2, (clock_timestamp() at time zone 'Asia/Kolkata')::date + 33, 400000, 75000)`,
            [snapshot, id],
          );
        }
        await c.query(
          `insert into identity.device_attestations (borrower_id, level, provider, verified_at, expires_at)
             values ($1, 'device', 'sample_attest', clock_timestamp(), clock_timestamp() + interval '2 hours')`,
          [borrowerId],
        );
      }
      await c.query('commit');
      return {
        id,
        tag,
        merchantRef,
        configId,
        token,
        webhookSecretRef,
        secret: secrets.get(webhookSecretRef) ?? secret,
        borrowerUser,
        borrowerId,
        phone: borrowerPhone,
        loans,
      };
    } catch (error) {
      await c.query('rollback');
      throw error;
    } finally {
      c.release();
    }
  }

  // ------------------------------------------------------------------------------------------------------
  // Sending deliveries
  // ------------------------------------------------------------------------------------------------------
  const idPrefix = (name: string) => `D${RUN}-${name}`;
  interface Sendable {
    readonly rawBody: Uint8Array;
    readonly headers: Readonly<Record<string, string>>;
  }

  /** Mock deliveries for a lender's order, signed with the lender's own secret unless told otherwise. */
  function deliveriesFor(
    scenario: MockPaymentScenario,
    lender: Lender,
    order: { orderRef: string; paymentRef: string },
    name: string,
    overrides: { secret?: string; merchantRef?: string; amountMinor?: bigint } = {},
  ): MockDelivery[] {
    return buildMockDeliveries(scenario, {
      secret: overrides.secret ?? lender.secret,
      orderRef: order.orderRef,
      paymentRef: order.paymentRef,
      amountMinor: overrides.amountMinor ?? 475_000n,
      merchantRef: overrides.merchantRef ?? lender.merchantRef,
      now: new Date(),
      idPrefix: idPrefix(name),
    });
  }
  function at(deliveries: MockDelivery[], index: number): MockDelivery {
    const delivery = deliveries[index];
    if (!delivery) throw new Error(`scenario has no delivery ${String(index)}`);
    return delivery;
  }
  /** A signed delivery with a body of the test's own making. */
  function signedBody(
    secret: string,
    name: string,
    fields: Parameters<typeof buildMockWebhookBody>[0],
    options: { secondsAgo?: number; deliveryId?: string } = {},
  ): MockDelivery {
    const rawBody = buildMockWebhookBody(fields);
    const headers = signMockWebhook({
      secret,
      deliveryId: options.deliveryId ?? `${idPrefix(name)}-DLV`,
      timestampSeconds: Math.floor(Date.now() / 1000) - (options.secondsAgo ?? 0),
      rawBody,
    });
    return { label: name, rawBody, headers };
  }

  async function post(
    app: FastifyInstance,
    token: string,
    delivery: Sendable,
    extra: { headers?: Record<string, string>; remoteAddress?: string } = {},
  ) {
    everyPayloadSha.add(sha256(delivery.rawBody));
    const res = await app.inject({
      method: 'POST',
      url: `/v1/hooks/provider/${token}`,
      headers: { 'content-type': 'application/json', ...delivery.headers, ...extra.headers },
      payload: Buffer.from(delivery.rawBody),
      remoteAddress: extra.remoteAddress ?? freshAddress(),
    });
    everySeenResponse.push(res.body, JSON.stringify(res.headers));
    return res;
  }
  /** What a caller can observe, minus the per-request id (which differs by design). */
  const observable = (res: Awaited<ReturnType<typeof post>>) => {
    const { instance: _instance, ...body } = res.json<Record<string, unknown>>();
    return {
      status: res.statusCode,
      type: res.headers['content-type'],
      cache: res.headers['cache-control'],
      length: res.headers['content-length'],
      headerNames: Object.keys(res.headers)
        .filter((name) => name !== 'date')
        .sort(),
      body,
    };
  };

  // ------------------------------------------------------------------------------------------------------
  // What the database kept
  // ------------------------------------------------------------------------------------------------------
  interface Receipt {
    outcome: string;
    reason_class: string;
    provider: string;
    lender_org_id: string | null;
    config_id: string | null;
    delivery_id: string | null;
    payload_sha256: string;
    scheme: string | null;
    signature_present: boolean;
    timestamp_skew_seconds: number | null;
    body_bytes: number | null;
    source_ip_hmac: string | null;
    event_id: string | null;
  }
  const receiptsOf = (delivery: Pick<Sendable, 'rawBody'> & Partial<Sendable>) =>
    q<Receipt>(
      `select outcome, reason_class, provider, lender_org_id, config_id, delivery_id, payload_sha256, scheme, signature_present,
              timestamp_skew_seconds, body_bytes, source_ip_hmac, event_id
         from payments.webhook_receipts where payload_sha256 = $1 and received_at >= $2 order by received_at, id`,
      [sha256(delivery.rawBody), STARTED],
    );
  const eventsByProviderId = (providerEventId: string) =>
    q<{
      id: string;
      lender_org_id: string;
      config_id: string;
      payment_intent_id: string | null;
      amount_minor: string | null;
      currency: string | null;
      provider_status: string;
      signature_verified: boolean;
      object_kind: string;
      object_ref: string;
      order_ref: string | null;
      processing_class: string;
      payload_sha256: string;
      event_type: string;
    }>(
      `select id, lender_org_id, config_id, payment_intent_id, amount_minor::text as amount_minor, currency::text as currency, provider_status, signature_verified,
              object_kind, object_ref, order_ref, processing_class, payload_sha256, event_type
         from payments.provider_events where provider = $1 and provider_event_id = $2`,
      [PROVIDER, providerEventId],
    );
  const eventIdOf = (delivery: MockDelivery): string => {
    const parsed: unknown = JSON.parse(Buffer.from(delivery.rawBody).toString('utf8'));
    const value = (parsed as { event_id?: unknown }).event_id;
    if (typeof value !== 'string') throw new Error('no event id');
    return value;
  };
  // The replay namespace is one per payment configuration ('pc_' and the configuration id, migration 920): a delivery id is looked up
  // by its own value, which is unique to the delivery.
  const seenCount = async (deliveryId: string) =>
    (
      await one<{ n: string }>(
        `select count(*)::text as n from ops.seen_webhooks where source like 'pc\\_%' and message_id = $1`,
        [deliveryId],
      )
    ).n;
  const outboxOf = (eventRowId: string) =>
    q<{ event_type: string; payload: unknown; status: string; dedupe_key: string | null }>(
      `select event_type, payload, status::text as status, dedupe_key from ops.outbox_events where payload ->> 'event_id' = $1`,
      [eventRowId],
    );
  const processingOf = (eventRowId: string) =>
    q<{ outcome: string; reason_class: string | null }>(
      `select outcome, reason_class from payments.event_processing where event_id = $1 order by processed_at, id`,
      [eventRowId],
    );
  const configStatus = async (lender: Lender) =>
    (
      await one<{ status: string }>(
        `select status from payments.lender_payment_configs where id = $1`,
        [lender.configId],
      )
    ).status;
  const exceptionsOf = (lender: Lender, exceptionClass: string) =>
    q<{ severity: string; owner: string; status: string; subject: unknown }>(
      `select severity, owner, status, subject from payments.reconciliation_exceptions where lender_org_id = $1 and class = $2`,
      [lender.id, exceptionClass],
    );
  /** Anything stored for the lender by deliveries: events, processing rows and outbox rows. */
  async function storedFor(lender: Lender) {
    const events = await q<{ id: string }>(
      `select id from payments.provider_events where lender_org_id = $1`,
      [lender.id],
    );
    const outbox =
      events.length === 0
        ? []
        : await q(
            `select 1 from ops.outbox_events where payload ->> 'event_id' = any($1::text[])`,
            [events.map((e) => e.id)],
          );
    return { events: events.length, outbox: outbox.length };
  }
  const noEventStored = async (delivery: MockDelivery) =>
    expect(await eventsByProviderId(eventIdOf(delivery))).toEqual([]);

  /**
   * The files share one database and others assert that no refund exists: a test that books one removes it again. The table is
   * append-only, so the delete runs with triggers off, scoped to the payments of the one intent.
   */
  async function removeAdjustmentsOf(intent: string): Promise<void> {
    const c = await admin.connect();
    try {
      await c.query('begin');
      await c.query('set local session_replication_role = replica');
      await c.query(
        `delete from payments.payment_adjustments
          where provider_payment_id in (select id from payments.provider_payments where intent_id = $1::uuid)`,
        [intent],
      );
      await c.query('commit');
    } catch (error) {
      await c.query('rollback');
      throw error;
    } finally {
      c.release();
    }
  }

  /** Stored event rows of this file: tracked so their outbox rows can be closed at the end. */
  async function trackEvent(providerEventId: string): Promise<string> {
    const [row] = await eventsByProviderId(providerEventId);
    if (!row) throw new Error('the event was not stored');
    myEventRows.add(row.id);
    return row.id;
  }

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: ADMIN, max: 4 });
    const withOptions = (url: string, options: string) =>
      `${url}${url.includes('?') ? '&' : '?'}options=${encodeURIComponent(options)}`;
    receiverPool = createSystemPool(SYSTEM ?? '');
    workerPool = createSystemPool(withOptions(SYSTEM ?? '', '-c udofin.allow_mock_providers=on'));

    A = await buildLender('Alpha', { loans: LOANS });
    B = await buildLender('Beta');
    // C has its own secret NAME (inside its own namespace) but the same VALUE as A: a provider that signs every lender's
    // deliveries alike.
    C = await buildLender('Gamma', { secret: A.secret });
    M = await buildLender('Merchant');
    S1 = await buildLender('SuspendedCo');
    S2 = await buildLender('RetiredCo');

    // The configurations whose tokens must stop working: suspended (the platform kill switch) and retired.
    await workerPool.withSystem((tx) =>
      tx.query('select payments.system_suspend_payment_config($1::uuid, $2)', [
        S1.configId,
        'merchant_mismatch',
      ]),
    );
    await admin.query(
      `update payments.lender_payment_configs set status = 'retired' where id = $1`,
      [S2.configId],
    );

    // The callback app the way callbacks-main assembles it: the lender receiver plus the provider route, one system login.
    callbacks = await buildCallbackApp(loadConfig({ APP_ENV: 'test' }), {
      routing: createRoutingProcessor(receiverPool),
      secret: secretOf,
      environment: 'test',
    });
    registerProviderHooks(callbacks, {
      pool: receiverPool,
      secret: secretOf,
      environment: 'test',
      limits: {
        perAddressPerMinute: 100_000,
        perTokenPerMinute: 100_000,
        failuresPerMinute: 100_000,
      },
    });
    await callbacks.ready();
  }, 120_000);

  afterAll(async () => {
    // Leave nothing pending for another file's worker to trip over.
    if (admin && A && B && C && M && S1 && S2) {
      await admin.query(
        `update ops.outbox_events set status = 'completed', completed_at = now(), locked_by = null, locked_until = null
          where status in ('pending', 'processing') and event_type = 'payment.apply_event'
            and payload ->> 'event_id' in (select e.id::text from payments.provider_events e where e.lender_org_id = any ($1::uuid[]))`,
        [[A, B, C, M, S1, S2].map((lender) => lender.id)],
      );
    }
    await callbacks?.close();
    await receiverPool?.end();
    await workerPool?.end();
    await admin?.end();
  });

  // ======================================================================================================
  // A payment that succeeded
  // ======================================================================================================
  describe('a verified payment delivery', () => {
    const s: {
      intent: string;
      order: { orderRef: string; paymentRef: string };
      deliveries: MockDelivery[];
      address: string;
      authorizedRow: string;
      capturedRow: string;
    } = {
      intent: '',
      order: { orderRef: '', paymentRef: '' },
      deliveries: [],
      address: '',
      authorizedRow: '',
      capturedRow: '',
    };

    it('stores the event, one receipt and one outbox job with ids only, and answers 200', async () => {
      const made = await pendingIntent(A, 0, 'pay0');
      s.intent = made.intent;
      s.order = made;
      s.deliveries = deliveriesFor('success', A, s.order, 'pay0');
      s.address = '203.0.113.7';
      const authorized = at(s.deliveries, 0);
      const res = await post(callbacks, A.token, authorized, { remoteAddress: s.address });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      expect(res.headers['cache-control']).toBe('no-store');

      const events = await eventsByProviderId(eventIdOf(authorized));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        lender_org_id: A.id,
        config_id: A.configId,
        payment_intent_id: s.intent,
        amount_minor: '475000',
        currency: 'INR',
        provider_status: 'authorized',
        signature_verified: true,
        object_kind: 'payment',
        order_ref: s.order.orderRef,
        object_ref: s.order.paymentRef,
        processing_class: 'actionable',
        payload_sha256: sha256(authorized.rawBody),
      });
      s.authorizedRow = await trackEvent(eventIdOf(authorized));

      const receipts = await receiptsOf(authorized);
      expect(receipts).toEqual([
        {
          outcome: 'verified',
          reason_class: 'none',
          provider: PROVIDER,
          lender_org_id: A.id,
          config_id: A.configId,
          delivery_id: authorized.headers['webhook-id'],
          payload_sha256: sha256(authorized.rawBody),
          scheme: MOCK_PAYMENT_WEBHOOK_SCHEME,
          signature_present: true,
          timestamp_skew_seconds: expect.any(Number) as number,
          body_bytes: authorized.rawBody.length,
          // The address is stored only as a keyed hash, never as itself.
          source_ip_hmac: addressHmac(Buffer.from(IP_KEY, 'utf8'), s.address),
          event_id: s.authorizedRow,
        },
      ]);
      expect(Math.abs(receipts[0]?.timestamp_skew_seconds ?? 999)).toBeLessThanOrEqual(5);

      // The replay store holds the delivery id now; the outbox job carries the event id and nothing else.
      expect(await seenCount(authorized.headers['webhook-id'])).toBe('1');
      expect(await outboxOf(s.authorizedRow)).toEqual([
        {
          event_type: 'payment.apply_event',
          payload: { event_id: s.authorizedRow },
          status: 'pending',
          dedupe_key: `payment.apply_event:${s.authorizedRow}:1`,
        },
      ]);
    });

    it('the receiver never marks anything successful: the intent stays pending until the worker applies a verified captured event', async () => {
      const captured = at(s.deliveries, 1);
      const res = await post(callbacks, A.token, captured, { remoteAddress: s.address });
      expect(res.statusCode).toBe(200);
      s.capturedRow = await trackEvent(eventIdOf(captured));
      expect(await intentRow(s.intent)).toMatchObject({
        status: 'pending',
        provider_order_ref: s.order.orderRef,
      });

      // The worker applies the events in order (here by calling the function the outbox handler calls).
      const apply = (event: string) =>
        workerPool.withSystem(async (tx) => {
          const r = await tx.query<{ r: { outcome?: string } }>(
            'select payments.apply_provider_event($1::uuid) as r',
            [event],
          );
          return r.rows[0]?.r.outcome;
        });
      expect(await apply(s.authorizedRow)).toBe('applied');
      expect(await intentRow(s.intent)).toMatchObject({ status: 'pending' });
      expect(await apply(s.capturedRow)).toBe('applied');
      expect(await intentRow(s.intent)).toMatchObject({ status: 'succeeded' });
      expect((await processingOf(s.capturedRow)).map((r) => r.outcome)).toEqual(['applied']);
    });

    it('a replay of the very same delivery answers 200 and stores nothing a second time', async () => {
      const captured = at(s.deliveries, 1);
      const again = await post(callbacks, A.token, captured, { remoteAddress: s.address });
      expect(again.statusCode).toBe(200);
      expect(again.json()).toEqual({ ok: true });
      expect(await eventsByProviderId(eventIdOf(captured))).toHaveLength(1);
      expect(await outboxOf(s.capturedRow)).toHaveLength(1);
      const receipts = await receiptsOf(captured);
      expect(receipts.map((r) => [r.outcome, r.reason_class])).toEqual([
        ['verified', 'none'],
        ['duplicate', 'replayed_delivery'],
      ]);
      expect(receipts[1]?.event_id).toBe(s.capturedRow);
      expect(await seenCount(captured.headers['webhook-id'])).toBe('1');
      // The intent is not touched by a replay.
      expect(await intentRow(s.intent)).toMatchObject({ status: 'succeeded' });
    });

    it('the same event under a new delivery id is acknowledged and inert; the same event id with a different payload raises a platform exception', async () => {
      const made = await pendingIntent(A, 1, 'dup1');
      const [first, replay, newDelivery] = deliveriesFor('duplicate_event', A, made, 'dup1');
      if (!first || !replay || !newDelivery) throw new Error('scenario');
      for (const delivery of [first, replay, newDelivery]) {
        const res = await post(callbacks, A.token, delivery);
        expect(res.statusCode).toBe(200);
      }
      const eventId = eventIdOf(first);
      const stored = await eventsByProviderId(eventId);
      expect(stored).toHaveLength(1);
      const row = await trackEvent(eventId);
      expect(await outboxOf(row)).toHaveLength(1);
      expect((await receiptsOf(first)).map((r) => [r.outcome, r.reason_class])).toEqual([
        ['verified', 'none'],
        ['duplicate', 'replayed_delivery'],
        ['duplicate', 'replayed_delivery'],
      ]);

      // The same event id with another amount, signed and fresh under yet another delivery id: authentic, but contradicts the first.
      const conflicting = signedBody(
        A.secret,
        'dup1-conflict',
        {
          eventId,
          objectKind: 'payment',
          objectRef: made.paymentRef,
          orderRef: made.orderRef,
          status: 'captured',
          amountMinor: 1n,
          currency: 'INR',
          occurredAt: new Date().toISOString(),
          merchantRef: A.merchantRef,
        },
        { deliveryId: `${idPrefix('dup1')}-DLV-CONFLICT` },
      );
      const res = await post(callbacks, A.token, conflicting);
      expect(res.statusCode).toBe(200);
      expect(await eventsByProviderId(eventId)).toHaveLength(1);
      expect((await receiptsOf(conflicting)).map((r) => [r.outcome, r.reason_class])).toEqual([
        ['duplicate', 'event_payload_conflict'],
      ]);
      const conflicts = await exceptionsOf(A, 'event_payload_conflict');
      expect(conflicts.length).toBeGreaterThanOrEqual(1);
      expect(conflicts[0]).toMatchObject({ owner: 'platform' });
      // The first event is the one that stands.
      expect((await eventsByProviderId(eventId))[0]).toMatchObject({
        amount_minor: '475000',
        payload_sha256: sha256(first.rawBody),
      });
    });

    it('a refund arrives with the reference of the payment it concerns, the database keeps it, and the compensating entry is booked against that payment', async () => {
      const made = await pendingIntent(A, 12, 'refpar12');
      const [captured, refunded] = deliveriesFor('refund', A, made, 'refpar12');
      if (!captured || !refunded) throw new Error('scenario');
      for (const delivery of [captured, refunded])
        expect((await post(callbacks, A.token, delivery)).statusCode).toBe(200);
      const capturedRow = await trackEvent(eventIdOf(captured));
      const refundRow = await trackEvent(eventIdOf(refunded));
      const parentOf = (event: string) =>
        one<{ parent_payment_ref: string | null }>(
          `select parent_payment_ref from payments.provider_events where id = $1`,
          [event],
        );
      expect(await parentOf(refundRow)).toEqual({ parent_payment_ref: made.paymentRef });
      expect(await parentOf(capturedRow)).toEqual({ parent_payment_ref: null });
      const apply = (event: string) =>
        workerPool.withSystem(async (tx) => {
          const r = await tx.query<{ r: { outcome?: string } }>(
            'select payments.apply_provider_event($1::uuid) as r',
            [event],
          );
          return r.rows[0]?.r.outcome;
        });
      expect(await apply(capturedRow)).toBe('applied');
      expect(await apply(refundRow)).toBe('applied');
      try {
        expect(
          await q(
            `select a.kind, a.amount_minor::text as amount_minor, p.provider_payment_ref
               from payments.payment_adjustments a join payments.provider_payments p on p.id = a.provider_payment_id
              where p.intent_id = $1`,
            [made.intent],
          ),
        ).toEqual([
          { kind: 'refund', amount_minor: '475000', provider_payment_ref: made.paymentRef },
        ]);
      } finally {
        await removeAdjustmentsOf(made.intent);
      }
    });
  });

  // ======================================================================================================
  // Deliveries that must not be accepted
  // ======================================================================================================
  describe('concurrent deliveries', () => {
    it('eight simultaneous copies of one delivery store exactly one event and one outbox job; the others are acknowledged duplicates', async () => {
      const made = await pendingIntent(A, 11, 'conc11');
      const captured = at(deliveriesFor('success', A, made, 'conc11'), 1);
      const results = await Promise.all(
        Array.from({ length: 8 }, () => post(callbacks, A.token, captured)),
      );
      expect(results.map((res) => res.statusCode)).toEqual(Array<number>(8).fill(200));
      expect(await eventsByProviderId(eventIdOf(captured))).toHaveLength(1);
      const row = await trackEvent(eventIdOf(captured));
      expect(await outboxOf(row)).toHaveLength(1);
      const receipts = await receiptsOf(captured);
      expect(receipts.filter((r) => r.outcome === 'verified')).toHaveLength(1);
      expect(receipts.filter((r) => r.outcome === 'duplicate')).toHaveLength(7);
      expect(await seenCount(captured.headers['webhook-id'])).toBe('1');
    });
  });

  describe('a forged, stale or malformed delivery', () => {
    const s: { order: { orderRef: string; paymentRef: string } } = {
      order: { orderRef: '', paymentRef: '' },
    };

    it('a forged signature is refused with the uniform 401; the receipt says unverified; no event; the delivery id is NOT consumed', async () => {
      s.order = await pendingIntent(A, 2, 'forge2');
      // Same ids in the forged and the genuine delivery: the event id and delivery id are reusable because the forgery reserved nothing.
      const forged = at(deliveriesFor('bad_signature', A, s.order, 'forge2'), 0);
      const genuine = at(deliveriesFor('success', A, s.order, 'forge2'), 0);
      expect(forged.headers['webhook-id']).toBe(genuine.headers['webhook-id']);
      expect(eventIdOf(forged)).toBe(eventIdOf(genuine));

      const res = await post(callbacks, A.token, forged);
      expect(observable(res)).toMatchObject({ status: 401, cache: 'no-store', body: UNIFORM_401 });
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(await receiptsOf(forged)).toMatchObject([
        {
          outcome: 'unverified',
          reason_class: 'signature_mismatch',
          lender_org_id: A.id,
          config_id: A.configId,
          signature_present: true,
          scheme: MOCK_PAYMENT_WEBHOOK_SCHEME,
          event_id: null,
        },
      ]);
      await noEventStored(forged);
      expect(await seenCount(forged.headers['webhook-id'])).toBe('0');

      // The genuine delivery with the same ids goes through afterwards: nothing was squatted.
      const ok = await post(callbacks, A.token, genuine);
      expect(ok.statusCode).toBe(200);
      const stored = await eventsByProviderId(eventIdOf(genuine));
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({ provider_status: 'authorized', signature_verified: true });
      await trackEvent(eventIdOf(genuine));
    });

    it('a signature that is genuine for other bytes does not verify: the check is over the exact raw body', async () => {
      const order = await pendingIntent(A, 3, 'bytes3');
      const [, captured] = deliveriesFor('success', A, order, 'bytes3');
      if (!captured) throw new Error('scenario');
      // The same JSON, re-serialised with different white space and the signature of the original: another byte sequence.
      const reformatted = Buffer.from(
        JSON.stringify(JSON.parse(Buffer.from(captured.rawBody).toString('utf8')), null, 2),
        'utf8',
      );
      expect(reformatted.equals(Buffer.from(captured.rawBody))).toBe(false);
      const res = await post(callbacks, A.token, {
        rawBody: reformatted,
        headers: captured.headers,
      });
      expect(observable(res)).toMatchObject({ status: 401, body: UNIFORM_401 });
      expect(await receiptsOf({ rawBody: reformatted, headers: captured.headers })).toMatchObject([
        { outcome: 'unverified', reason_class: 'signature_mismatch' },
      ]);
      await noEventStored(captured);
      // The original bytes verify.
      expect((await post(callbacks, A.token, captured)).statusCode).toBe(200);
      await trackEvent(eventIdOf(captured));
    });

    it('a missing header, an empty body and a body that is not JSON (even correctly signed) are refused alike', async () => {
      const order = { orderRef: `D-ORDER-${RUN}-hdr`, paymentRef: `D-PAY-${RUN}-hdr` };
      const good = at(deliveriesFor('success', A, order, 'hdr'), 1);
      const noHeaders = await post(callbacks, A.token, {
        rawBody: good.rawBody,
        headers: {},
      });
      const half = await post(callbacks, A.token, {
        rawBody: good.rawBody,
        headers: { ...good.headers, 'webhook-signature': '' },
      });
      const empty = await post(callbacks, A.token, {
        rawBody: Buffer.alloc(0),
        headers: {},
      });
      const garbage = Buffer.from(`[1, 2, "${RUN}"]`, 'utf8');
      const garbageSigned = {
        rawBody: garbage,
        headers: signMockWebhook({
          secret: A.secret,
          deliveryId: `${idPrefix('hdr')}-DLV-GARBAGE`,
          timestampSeconds: Math.floor(Date.now() / 1000),
          rawBody: garbage,
        }),
      };
      const notJson = await post(callbacks, A.token, garbageSigned);
      const reference = observable(noHeaders);
      expect(reference).toMatchObject({ status: 401, body: UNIFORM_401 });
      for (const res of [half, empty, notJson]) expect(observable(res)).toEqual(reference);
      expect((await receiptsOf({ rawBody: good.rawBody, headers: {} }))[0]).toMatchObject({
        outcome: 'unverified',
        reason_class: 'missing_headers',
        signature_present: false,
      });
      expect((await receiptsOf({ rawBody: Buffer.alloc(0), headers: {} }))[0]).toMatchObject({
        outcome: 'unverified',
        reason_class: 'missing_headers',
        body_bytes: 0,
      });
      expect(await receiptsOf(garbageSigned)).toMatchObject([
        { outcome: 'invalid', reason_class: 'malformed_body', signature_present: true },
      ]);
      await noEventStored(good);
      expect(await seenCount(garbageSigned.headers['webhook-id'])).toBe('0');
    });

    it('a stale timestamp (authentic signature) is refused; the receipt says stale; the delivery id is NOT consumed', async () => {
      const order = await pendingIntent(A, 4, 'stale4');
      const stale = at(deliveriesFor('old_timestamp', A, order, 'stale4'), 0);
      const res = await post(callbacks, A.token, stale);
      expect(observable(res)).toMatchObject({ status: 401, body: UNIFORM_401 });
      const [receipt] = await receiptsOf(stale);
      expect(receipt).toMatchObject({
        outcome: 'stale_timestamp',
        reason_class: 'timestamp_outside_tolerance',
        lender_org_id: A.id,
      });
      expect(receipt?.timestamp_skew_seconds).toBeGreaterThanOrEqual(3590);
      await noEventStored(stale);
      expect(await seenCount(stale.headers['webhook-id'])).toBe('0');
    });

    it('the tolerance is five minutes either way: 250 seconds old and 250 seconds ahead are accepted, 400 either way is not', async () => {
      const order = await pendingIntent(A, 5, 'tol5');
      const fields = (name: string) => ({
        eventId: `${idPrefix('tol5')}-EVT-${name}`,
        objectKind: 'payment',
        objectRef: order.paymentRef,
        orderRef: order.orderRef,
        status: 'authorized',
        amountMinor: 475_000n,
        currency: 'INR',
        occurredAt: new Date().toISOString(),
        merchantRef: A.merchantRef,
      });
      const cases: [string, number, number][] = [
        ['old-ok', 250, 200],
        ['ahead-ok', -250, 200],
        ['old-late', 400, 401],
        ['ahead-late', -400, 401],
      ];
      for (const [name, secondsAgo, status] of cases) {
        const delivery = signedBody(A.secret, `tol5-${name}`, fields(name), { secondsAgo });
        const res = await post(callbacks, A.token, delivery);
        expect(res.statusCode, name).toBe(status);
        if (status === 200) await trackEvent(`${idPrefix('tol5')}-EVT-${name}`);
        else
          expect((await receiptsOf(delivery))[0], name).toMatchObject({
            outcome: 'stale_timestamp',
          });
      }
    });

    it('an authentic delivery that is business-invalid is stored only as a receipt: a capture without an amount is 422, a foreign currency is refused before the database', async () => {
      const order = await pendingIntent(A, 10, 'inv10');
      const noAmount = signedBody(A.secret, 'inv-amount', {
        eventId: `${idPrefix('inv')}-EVT-AMOUNT`,
        objectKind: 'payment',
        objectRef: order.paymentRef,
        orderRef: order.orderRef,
        status: 'captured',
        occurredAt: new Date().toISOString(),
        merchantRef: A.merchantRef,
      });
      const res = await post(callbacks, A.token, noAmount);
      expect(res.statusCode).toBe(422);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.json()).toMatchObject({ status: 422, code: 'invalid_event', type: 'about:blank' });
      expect(await receiptsOf(noAmount)).toMatchObject([
        { outcome: 'invalid', reason_class: 'amount_missing', lender_org_id: A.id },
      ]);
      await noEventStored(noAmount);
      expect(await seenCount(noAmount.headers['webhook-id'])).toBe('0');

      const usd = at(deliveriesFor('wrong_currency', A, order, 'inv-usd'), 0);
      const usdRes = await post(callbacks, A.token, usd);
      expect(observable(usdRes)).toMatchObject({ status: 401, body: UNIFORM_401 });
      expect(await receiptsOf(usd)).toMatchObject([
        { outcome: 'invalid', reason_class: 'unsupported_currency' },
      ]);
      await noEventStored(usd);
    });
  });

  // ======================================================================================================
  // Routing: tokens, tenants
  // ======================================================================================================
  describe('routing by token', () => {
    it('an unknown, a suspended, a retired and a malformed token give the same answer as a forged signature, on the same code path', async () => {
      const order = { orderRef: `D-ORDER-${RUN}-uni`, paymentRef: `D-PAY-${RUN}-uni` };
      const genuine = at(deliveriesFor('success', A, order, 'uni'), 1);
      const forged = at(deliveriesFor('bad_signature', A, order, 'uni-forged'), 0);
      const unknownToken = randomBytes(32).toString('base64url');

      const attempts = {
        forgedKnownToken: await post(callbacks, A.token, forged),
        // Authentic bytes and signature, but the token is not an active configuration's.
        unknownToken: await post(callbacks, unknownToken, genuine),
        suspendedToken: await post(callbacks, S1.token, genuine),
        retiredToken: await post(callbacks, S2.token, genuine),
        malformedToken: await post(callbacks, 'short', genuine),
        notUrlSafeToken: await post(callbacks, `${'a'.repeat(40)}.dots`, genuine),
      };
      const reference = observable(attempts.forgedKnownToken);
      expect(reference).toMatchObject({ status: 401, cache: 'no-store', body: UNIFORM_401 });
      for (const [name, res] of Object.entries(attempts)) {
        expect(observable(res), name).toEqual(reference);
      }

      // The same path in the database: a lookup and one ingest, and a receipt. A token the database does not know has no
      // configuration to name, so its receipt carries none; the suspended and retired ones are not routed either.
      const receipts = await receiptsOf(genuine);
      expect(receipts).toHaveLength(3);
      for (const receipt of receipts) {
        expect(receipt).toMatchObject({
          outcome: 'unmatched',
          reason_class: 'token_unknown_or_inactive',
          provider: 'unknown',
          lender_org_id: null,
          config_id: null,
          signature_present: true,
        });
      }
      expect((await receiptsOf(forged))[0]).toMatchObject({
        outcome: 'unverified',
        reason_class: 'signature_mismatch',
        config_id: A.configId,
      });
      // Nothing was stored for anyone, and the genuine delivery's ids were not consumed by any of this.
      await noEventStored(genuine);
      expect(await seenCount(genuine.headers['webhook-id'])).toBe('0');
      for (const lender of [S1, S2])
        expect(await storedFor(lender)).toEqual({ events: 0, outbox: 0 });
    });

    it("another lender's token with this lender's payload is refused and nothing is stored for the wrong lender (a different secret)", async () => {
      const order = await pendingIntent(A, 6, 'wrong6');
      const forA = at(deliveriesFor('success', A, order, 'wrong6'), 1);
      const res = await post(callbacks, B.token, forA);
      expect(observable(res)).toMatchObject({ status: 401, body: UNIFORM_401 });
      const receipts = await receiptsOf(forA);
      expect(receipts).toMatchObject([
        {
          outcome: 'unverified',
          reason_class: 'signature_mismatch',
          lender_org_id: B.id,
          config_id: B.configId,
        },
      ]);
      await noEventStored(forA);
      expect(await seenCount(forA.headers['webhook-id'])).toBe('0');
      expect(await storedFor(B)).toEqual({ events: 0, outbox: 0 });
      // The right token takes the same bytes.
      expect((await post(callbacks, A.token, forA)).statusCode).toBe(200);
      const row = await trackEvent(eventIdOf(forA));
      expect((await eventsByProviderId(eventIdOf(forA)))[0]).toMatchObject({
        lender_org_id: A.id,
        config_id: A.configId,
      });
      expect(row).toBeTruthy();
    });

    it('a delivery the receiver did not verify is refused with the uniform 401 even if the database were to accept it', async () => {
      // The real lookup, but an ingest that always answers "stored": only the receiver's own rule stands between a forgery and a 200.
      const real = createProviderHookProcessor(receiverPool);
      const lax: ProviderHookProcessor = {
        lookupConfig: (hash) => real.lookupConfig(hash),
        ingest: async (hash, delivery) => {
          await real.ingest(hash, delivery);
          return { accepted: true, outcome: 'ok' };
        },
      };
      const lenient = Fastify();
      await lenient.register(rateLimit, { global: true, max: 100_000, timeWindow: '1 minute' });
      registerProviderHooks(lenient, {
        pool: receiverPool,
        secret: secretOf,
        environment: 'test',
        processor: lax,
        limits: {
          perTokenPerMinute: 100_000,
          perAddressPerMinute: 100_000,
          failuresPerMinute: 100_000,
        },
      });
      await lenient.ready();
      try {
        const order = { orderRef: `D-ORDER-${RUN}-lax`, paymentRef: `D-PAY-${RUN}-lax` };
        const genuine = at(deliveriesFor('success', A, order, 'lax'), 1);
        const forged = at(deliveriesFor('bad_signature', A, order, 'lax-forged'), 0);
        const stale = at(deliveriesFor('old_timestamp', A, order, 'lax-stale'), 0);
        const results = [
          await post(lenient, A.token, forged),
          await post(lenient, A.token, stale),
          await post(lenient, randomBytes(32).toString('base64url'), genuine),
          await post(lenient, S1.token, genuine),
          await post(lenient, B.token, genuine),
        ];
        for (const res of results) {
          expect(observable(res)).toMatchObject({ status: 401, body: UNIFORM_401 });
        }
        // Control: a delivery that IS verified gets the database's answer, which this stand-in turns into 200.
        expect((await post(lenient, A.token, genuine)).statusCode).toBe(200);
      } finally {
        await lenient.close();
      }
    });

    it("even when both lenders share one secret, the other lender's token does not match this lender's order: 409, nothing stored, the delivery id is free", async () => {
      // A provider that signs for every lender with one key: the signature verifies on C's route. The ORDER is not C's.
      const order = await pendingIntent(A, 7, 'shared7');
      const noMerchant = signedBody(A.secret, 'shared7', {
        eventId: `${idPrefix('shared7')}-EVT`,
        objectKind: 'payment',
        objectRef: order.paymentRef,
        orderRef: order.orderRef,
        status: 'captured',
        amountMinor: 475_000n,
        currency: 'INR',
        occurredAt: new Date().toISOString(),
      });
      const res = await post(callbacks, C.token, noMerchant);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ status: 409, code: 'unmatched' });
      expect(await receiptsOf(noMerchant)).toMatchObject([
        {
          outcome: 'unmatched',
          reason_class: 'order_ref_unknown',
          lender_org_id: C.id,
          config_id: C.configId,
        },
      ]);
      await noEventStored(noMerchant);
      expect(await seenCount(noMerchant.headers['webhook-id'])).toBe('0');
      expect(await storedFor(C)).toEqual({ events: 0, outbox: 0 });
      expect(await configStatus(C)).toBe('active');
    });

    it("a delivery that names A's merchant on C's route suspends C's configuration and opens a critical platform exception; A is untouched", async () => {
      const order = { orderRef: `D-ORDER-${RUN}-cross`, paymentRef: `D-PAY-${RUN}-cross` };
      const namesA = at(deliveriesFor('success', A, order, 'cross'), 1);
      expect(Buffer.from(namesA.rawBody).toString('utf8')).toContain(A.merchantRef);
      const res = await post(callbacks, C.token, namesA);
      expect(res.statusCode).toBe(409);
      expect(await receiptsOf(namesA)).toMatchObject([
        { outcome: 'unmatched', reason_class: 'merchant_mismatch', lender_org_id: C.id },
      ]);
      expect(await configStatus(C)).toBe('suspended');
      expect(await exceptionsOf(C, 'merchant_mismatch')).toMatchObject([
        { severity: 'critical', owner: 'platform', status: 'open' },
      ]);
      await noEventStored(namesA);
      expect(await seenCount(namesA.headers['webhook-id'])).toBe('0');
      expect(await storedFor(C)).toEqual({ events: 0, outbox: 0 });
      expect(await configStatus(A)).toBe('active');
      expect(await exceptionsOf(A, 'merchant_mismatch')).toEqual([]);
      // C's token no longer routes: the same fixed answer as any unknown token.
      const after = await post(callbacks, C.token, namesA);
      expect(observable(after)).toMatchObject({ status: 401, body: UNIFORM_401 });
    });
  });

  // ======================================================================================================
  // Authentic but not (yet) matched
  // ======================================================================================================
  describe('an authentic delivery with no matching order yet', () => {
    it('answers 409, consumes nothing, and the same delivery succeeds once the intent has its order reference', async () => {
      const intent = await requestIntent(A, 8);
      const order = { orderRef: `D-ORDER-${RUN}-late`, paymentRef: `D-PAY-${RUN}-late` };
      const captured = at(deliveriesFor('success', A, order, 'late'), 1);

      const early = await post(callbacks, A.token, captured);
      expect(early.statusCode).toBe(409);
      expect(early.headers['content-type']).toContain('application/problem+json');
      expect(early.json()).toMatchObject({ status: 409, code: 'unmatched', type: 'about:blank' });
      expect(early.body).not.toContain(order.orderRef);
      expect(await receiptsOf(captured)).toMatchObject([
        { outcome: 'unmatched', reason_class: 'order_ref_unknown', lender_org_id: A.id },
      ]);
      await noEventStored(captured);
      expect(await seenCount(captured.headers['webhook-id'])).toBe('0');
      expect((await intentRow(intent)).provider_order_ref).toBeNull();

      // The worker records the order; the provider retries the same delivery.
      await recordOrder(intent, order.orderRef);
      const retry = await post(callbacks, A.token, captured);
      expect(retry.statusCode).toBe(200);
      const stored = await eventsByProviderId(eventIdOf(captured));
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({ payment_intent_id: intent, signature_verified: true });
      await trackEvent(eventIdOf(captured));
      expect(await seenCount(captured.headers['webhook-id'])).toBe('1');
      expect((await receiptsOf(captured)).map((r) => r.outcome)).toEqual(['unmatched', 'verified']);
    });
  });

  // ======================================================================================================
  // Merchant mismatch
  // ======================================================================================================
  describe('a merchant that is not the configured one', () => {
    it("refuses it with 409, suspends only that lender's configuration and raises a critical platform exception; later deliveries get the uniform 401", async () => {
      const order = { orderRef: `D-ORDER-${RUN}-mer`, paymentRef: `D-PAY-${RUN}-mer` };
      const wrong = at(deliveriesFor('wrong_merchant', M, order, 'mer'), 0);
      expect(await configStatus(M)).toBe('active');
      const res = await post(callbacks, M.token, wrong);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ status: 409, code: 'unmatched' });
      expect(await receiptsOf(wrong)).toMatchObject([
        {
          outcome: 'unmatched',
          reason_class: 'merchant_mismatch',
          lender_org_id: M.id,
          config_id: M.configId,
        },
      ]);
      expect(await configStatus(M)).toBe('suspended');
      expect(await exceptionsOf(M, 'merchant_mismatch')).toMatchObject([
        { severity: 'critical', owner: 'platform' },
      ]);
      await noEventStored(wrong);
      expect(await seenCount(wrong.headers['webhook-id'])).toBe('0');
      expect(await storedFor(M)).toEqual({ events: 0, outbox: 0 });

      const ordinary = at(deliveriesFor('success', M, order, 'mer2'), 1);
      const after = await post(callbacks, M.token, ordinary);
      expect(observable(after)).toMatchObject({ status: 401, body: UNIFORM_401 });
    });
  });

  // ======================================================================================================
  // Unsupported kinds, mandates
  // ======================================================================================================
  describe('authentic events the platform does not act on', () => {
    it('an unsupported object kind is stored verified-and-ignored: 200, an ignored event, no outbox job, a verified_ignored receipt', async () => {
      const unsupported = signedBody(A.secret, 'unsup', {
        eventId: `${idPrefix('unsup')}-EVT`,
        objectKind: 'dispute_evidence',
        objectRef: `D-OBJ-${RUN}-1`,
        status: 'whatever',
        occurredAt: new Date().toISOString(),
      });
      const res = await post(callbacks, A.token, unsupported);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      const [event] = await eventsByProviderId(eventIdOf(unsupported));
      expect(event).toMatchObject({
        lender_org_id: A.id,
        object_kind: 'unsupported',
        provider_status: 'unmapped',
        processing_class: 'ignored',
        signature_verified: true,
        amount_minor: null,
        payment_intent_id: null,
      });
      if (!event) throw new Error('not stored');
      myEventRows.add(event.id);
      // The provider's own kind word is not kept anywhere.
      expect(JSON.stringify(event)).not.toContain('dispute_evidence');
      expect(await outboxOf(event.id)).toEqual([]);
      expect(await processingOf(event.id)).toEqual([
        { outcome: 'ignored_unsupported', reason_class: 'unsupported_kind' },
      ]);
      expect(await receiptsOf(unsupported)).toMatchObject([
        { outcome: 'verified_ignored', reason_class: 'none', event_id: event.id },
      ]);
      // And it is replay-safe.
      expect((await post(callbacks, A.token, unsupported)).statusCode).toBe(200);
      expect(await eventsByProviderId(eventIdOf(unsupported))).toHaveLength(1);
    });

    it('a supported kind with a status the platform cannot map is stored verified-and-ignored too, and never authorises anything', async () => {
      const unmapped = signedBody(A.secret, 'unmapped', {
        eventId: `${idPrefix('unmapped')}-EVT`,
        objectKind: 'payment',
        objectRef: `D-PAY-${RUN}-unmapped`,
        orderRef: `D-ORDER-${RUN}-unmapped`,
        status: 'settling_soon',
        occurredAt: new Date().toISOString(),
        merchantRef: A.merchantRef,
      });
      const res = await post(callbacks, A.token, unmapped);
      expect(res.statusCode).toBe(200);
      const [event] = await eventsByProviderId(eventIdOf(unmapped));
      expect(event).toMatchObject({ processing_class: 'ignored', provider_status: 'unmapped' });
      if (!event) throw new Error('not stored');
      myEventRows.add(event.id);
      expect(await outboxOf(event.id)).toEqual([]);
      expect(await processingOf(event.id)).toEqual([
        { outcome: 'ignored_unsupported', reason_class: 'unmapped_status' },
      ]);
    });
  });

  describe('a mandate event', () => {
    const s: { mandate: string; ref: string; row: string } = { mandate: '', ref: '', row: '' };

    it("is matched to the lender's own mandate by the provider reference, queued for the worker, and activates nothing by itself", async () => {
      if (!A.borrowerId || !A.borrowerUser) throw new Error('borrower');
      s.mandate = randomUUID();
      s.ref = `D-MND-${RUN}-1`;
      await q(
        `insert into identity.stepup_challenges (id, borrower_id, action, context_ref, code_hash, status, delivery_status, expires_at, verified_at, verified_until)
         values (gen_random_uuid(), $1, 'mandate_creation', $2, repeat('a', 64), 'verified', 'accepted', now() + interval '10 minutes', now(), now() + interval '10 minutes')`,
        [A.borrowerId, s.mandate],
      );
      await asBorrower(
        A.borrowerUser,
        `select payments.request_mandate($1::uuid, $2::uuid, 'enach_api', 4000000::bigint, $3::date, $4::date, 'XXXXXX1234') as id`,
        [s.mandate, A.loans[0], await today(1), await today(365)],
      );
      // The worker's hand-off result: the provider took the request and gave its reference.
      await workerPool.withSystem((tx) =>
        tx.query(`select payments.record_mandate_handoff($1::uuid, 'handoff', $2, null)`, [
          s.mandate,
          s.ref,
        ]),
      );
      const status = () =>
        one<{ status: string }>(`select status from payments.mandates where id = $1`, [s.mandate]);
      expect(await status()).toEqual({ status: 'registration_pending' });

      const active = signedBody(A.secret, 'mnd', {
        eventId: `${idPrefix('mnd')}-EVT`,
        objectKind: 'mandate',
        objectRef: s.ref,
        status: 'active',
        occurredAt: new Date().toISOString(),
        merchantRef: A.merchantRef,
      });
      const res = await post(callbacks, A.token, active);
      expect(res.statusCode).toBe(200);
      const [event] = await eventsByProviderId(eventIdOf(active));
      expect(event).toMatchObject({
        lender_org_id: A.id,
        object_kind: 'mandate',
        object_ref: s.ref,
        provider_status: 'active',
        processing_class: 'actionable',
        signature_verified: true,
        amount_minor: null,
      });
      s.row = await trackEvent(eventIdOf(active));
      expect(await outboxOf(s.row)).toMatchObject([
        { event_type: 'payment.apply_event', status: 'pending' },
      ]);
      // The receiver changed nothing about the mandate.
      expect(await status()).toEqual({ status: 'registration_pending' });

      // The worker applies it, and only then is the mandate active.
      const outcome = await workerPool.withSystem(async (tx) => {
        const r = await tx.query<{ r: { outcome?: string } }>(
          'select payments.apply_provider_event($1::uuid) as r',
          [s.row],
        );
        return r.rows[0]?.r.outcome;
      });
      expect(outcome).toBe('applied');
      expect(await status()).toEqual({ status: 'active' });
    });

    it('for a mandate or debit this lender does not have, or that belongs to another lender, is 409 and stores nothing', async () => {
      const unknown = signedBody(A.secret, 'mnd-unknown', {
        eventId: `${idPrefix('mnd-unknown')}-EVT`,
        objectKind: 'mandate',
        objectRef: `D-MND-${RUN}-nobody`,
        status: 'active',
        occurredAt: new Date().toISOString(),
        merchantRef: A.merchantRef,
      });
      const res = await post(callbacks, A.token, unknown);
      expect(res.statusCode).toBe(409);
      expect(await receiptsOf(unknown)).toMatchObject([
        { outcome: 'unmatched', reason_class: 'mandate_unknown' },
      ]);
      await noEventStored(unknown);
      expect(await seenCount(unknown.headers['webhook-id'])).toBe('0');

      // A's mandate reference, correctly signed, on B's route (B has its own secret, so this one signs with B's).
      const other = signedBody(B.secret, 'mnd-cross', {
        eventId: `${idPrefix('mnd-cross')}-EVT`,
        objectKind: 'mandate',
        objectRef: s.ref,
        status: 'revoked',
        occurredAt: new Date().toISOString(),
        merchantRef: B.merchantRef,
      });
      const cross = await post(callbacks, B.token, other);
      expect(cross.statusCode).toBe(409);
      expect(await receiptsOf(other)).toMatchObject([
        { outcome: 'unmatched', reason_class: 'mandate_unknown', lender_org_id: B.id },
      ]);
      await noEventStored(other);
      expect(
        (
          await one<{ status: string }>(`select status from payments.mandates where id = $1`, [
            s.mandate,
          ])
        ).status,
      ).toBe('active');

      const debit = signedBody(A.secret, 'debit-unknown', {
        eventId: `${idPrefix('debit-unknown')}-EVT`,
        objectKind: 'debit',
        objectRef: `D-DEBIT-${RUN}-nobody`,
        status: 'returned',
        amountMinor: 475_000n,
        currency: 'INR',
        occurredAt: new Date().toISOString(),
        merchantRef: A.merchantRef,
      });
      const debitRes = await post(callbacks, A.token, debit);
      expect(debitRes.statusCode).toBe(409);
      await noEventStored(debit);
    });
  });

  // ======================================================================================================
  // Transport
  // ======================================================================================================
  describe('transport limits', () => {
    const receiptCount = async (lender: Lender) =>
      Number(
        (
          await one<{ n: string }>(
            `select count(*)::text as n from payments.webhook_receipts where config_id = $1`,
            [lender.configId],
          )
        ).n,
      );

    it('another content type and an oversized body are refused before any database work: no receipt, no event', async () => {
      const before = await receiptCount(A);
      const text = await callbacks.inject({
        method: 'POST',
        url: `/v1/hooks/provider/${A.token}`,
        headers: { 'content-type': 'text/plain' },
        payload: 'hello',
      });
      const form = await callbacks.inject({
        method: 'POST',
        url: `/v1/hooks/provider/${A.token}`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'a=b',
      });
      const big = await callbacks.inject({
        method: 'POST',
        url: `/v1/hooks/provider/${A.token}`,
        headers: { 'content-type': 'application/json' },
        payload: Buffer.alloc(PROVIDER_HOOK_BODY_LIMIT + 1, 0x20),
      });
      expect([text.statusCode, form.statusCode, big.statusCode]).toEqual([415, 415, 413]);
      for (const res of [text, form, big]) {
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.body).not.toContain(A.token);
        everySeenResponse.push(res.body);
      }
      expect(await receiptCount(A)).toBe(before);
    });

    it('a body exactly at the limit is read (and, unsigned, refused with a receipt); anything under the prefix but the route is one fixed 404 that never echoes the token', async () => {
      const before = await receiptCount(A);
      const atLimit = await post(callbacks, A.token, {
        rawBody: Buffer.alloc(PROVIDER_HOOK_BODY_LIMIT, 0x20),
        headers: {},
      });
      expect(observable(atLimit)).toMatchObject({ status: 401, body: UNIFORM_401 });
      expect(await receiptCount(A)).toBe(before + 1);

      const misses = [
        await callbacks.inject({
          method: 'POST',
          url: `/v1/hooks/provider/${A.token}/`,
          payload: '{}',
          headers: { 'content-type': 'application/json' },
        }),
        await callbacks.inject({ method: 'GET', url: `/v1/hooks/provider/${A.token}` }),
        await callbacks.inject({
          method: 'PUT',
          url: `/v1/hooks/provider/${A.token}`,
          payload: '{}',
          headers: { 'content-type': 'application/json' },
        }),
        await callbacks.inject({
          method: 'POST',
          url: `/v1/hooks/provider/${A.token}/x/y`,
          payload: '{}',
          headers: { 'content-type': 'application/json' },
        }),
        await callbacks.inject({
          method: 'POST',
          url: `/v1/hooks/provider/${'b'.repeat(120)}`,
          payload: '{}',
          headers: { 'content-type': 'application/json' },
        }),
      ];
      for (const res of misses) {
        expect(res.statusCode).toBe(404);
        expect(res.json()).toMatchObject({ status: 404, code: 'not_found', type: 'about:blank' });
        expect(res.body).not.toContain(A.token);
        everySeenResponse.push(res.body);
      }
      expect(await receiptCount(A)).toBe(before + 1);
    });

    it('does not trust a forwarded-for header when no proxy hop is configured: the stored address hash is of the socket address', async () => {
      const order = { orderRef: `D-ORDER-${RUN}-xff`, paymentRef: `D-PAY-${RUN}-xff` };
      const forged = at(deliveriesFor('bad_signature', A, order, 'xff'), 0);
      const res = await post(callbacks, A.token, forged, {
        remoteAddress: '203.0.113.50',
        headers: { 'x-forwarded-for': '198.51.100.250' },
      });
      expect(res.statusCode).toBe(401);
      const [receipt] = await receiptsOf(forged);
      const key = Buffer.from(IP_KEY, 'utf8');
      expect(receipt?.source_ip_hmac).toBe(addressHmac(key, '203.0.113.50'));
      expect(receipt?.source_ip_hmac).not.toBe(addressHmac(key, '198.51.100.250'));
    });

    it('limits failed deliveries per routing-token hash and address, and per address, with a fixed 429 that writes no receipt; a verified delivery is not locked out (A30)', async () => {
      const limited = Fastify();
      await limited.register(rateLimit, { global: true, max: 100_000, timeWindow: '1 minute' });
      registerProviderHooks(limited, {
        pool: receiverPool,
        secret: secretOf,
        environment: 'test',
        limits: { failuresPerMinute: 3, perTokenPerMinute: 100_000, perAddressPerMinute: 100_000 },
      });
      await limited.ready();
      const byAddress = Fastify();
      await byAddress.register(rateLimit, { global: true, max: 100_000, timeWindow: '1 minute' });
      registerProviderHooks(byAddress, {
        pool: receiverPool,
        secret: secretOf,
        environment: 'test',
        limits: { perTokenPerMinute: 100_000, perAddressPerMinute: 2, failuresPerMinute: 100_000 },
      });
      await byAddress.ready();
      try {
        const order = { orderRef: `D-ORDER-${RUN}-rl`, paymentRef: `D-PAY-${RUN}-rl` };
        const forged = at(deliveriesFor('bad_signature', A, order, 'rl'), 0);
        // The failure budget is per address: every request of this test comes from one.
        const offender = '198.51.100.77';
        const before = await receiptCount(A);
        const codes: number[] = [];
        for (let i = 0; i < 5; i += 1)
          codes.push(
            (await post(limited, A.token, forged, { remoteAddress: offender })).statusCode,
          );
        expect(codes).toEqual([401, 401, 401, 429, 429]);
        // Unknown tokens are limited the same way, and the limit is per token HASH, so another token is not affected.
        const unknown = randomBytes(32).toString('base64url');
        const unknownCodes: number[] = [];
        for (let i = 0; i < 4; i += 1)
          unknownCodes.push(
            (await post(limited, unknown, forged, { remoteAddress: offender })).statusCode,
          );
        expect(unknownCodes).toEqual([401, 401, 401, 429]);
        const last = await post(limited, A.token, forged, { remoteAddress: offender });
        expect(last.json()).toMatchObject({ status: 429, code: 'rate_limited' });
        expect(last.headers['retry-after']).toBe('60');
        expect(await receiptCount(A)).toBe(before + 3);
        // The genuine sender, from the very address that has spent its failure budget, is neither refused as a failure nor
        // rate limited: the delivery verifies and the database answers it (here: an order that is not known, so nothing matches).
        const genuine = at(deliveriesFor('success', A, order, 'rl-genuine'), 1);
        const genuineAnswer = await post(limited, A.token, genuine, { remoteAddress: offender });
        expect(genuineAnswer.statusCode).toBe(409); // verified, but no such order: the database's answer, not a refusal
        expect((await receiptsOf(genuine)).map((r) => r.outcome)).toEqual(['unmatched']);

        const sameAddress = '198.51.100.5';
        const perAddress: number[] = [];
        for (let i = 0; i < 4; i += 1) {
          perAddress.push(
            (await post(byAddress, A.token, forged, { remoteAddress: sameAddress })).statusCode,
          );
        }
        expect(perAddress).toEqual([401, 401, 429, 429]);
        expect(
          (await post(byAddress, A.token, forged, { remoteAddress: '198.51.100.6' })).statusCode,
        ).toBe(401);
      } finally {
        await limited.close();
        await byAddress.close();
      }
    });
  });

  // ======================================================================================================
  // Starting the route
  // ======================================================================================================
  describe('starting the route', () => {
    it('is refused in staging and production without a strong address key, and works in local development with a random one', async () => {
      const start = async (environment: AppEnvironment, key?: string) => {
        const instance = Fastify();
        try {
          registerProviderHooks(instance, {
            pool: receiverPool,
            environment,
            secret: (name) => (name === IP_HMAC_SECRET_NAME ? key : undefined),
          });
          await instance.ready();
        } finally {
          await instance.close();
        }
      };
      for (const environment of ['staging', 'production'] as const) {
        await expect(start(environment)).rejects.toThrow(IP_HMAC_SECRET_NAME);
        await expect(start(environment, 'too-short')).rejects.toThrow(/at least 32/);
        await expect(start(environment, 'k'.repeat(40))).resolves.toBeUndefined();
      }
      await expect(start('local')).resolves.toBeUndefined();
    });

    it('a mock configuration is refused in staging with a correct signature: the same uniform 401, a scheme-not-configured receipt', async () => {
      const staging = Fastify();
      await staging.register(rateLimit, { global: true, max: 100_000, timeWindow: '1 minute' });
      registerProviderHooks(staging, {
        pool: receiverPool,
        secret: secretOf,
        environment: 'staging',
        limits: { perTokenPerMinute: 1000, perAddressPerMinute: 1000, failuresPerMinute: 1000 },
      });
      await staging.ready();
      try {
        const order = { orderRef: `D-ORDER-${RUN}-stg`, paymentRef: `D-PAY-${RUN}-stg` };
        const genuine = at(deliveriesFor('success', A, order, 'stg'), 1);
        const res = await post(staging, A.token, genuine);
        expect(observable(res)).toMatchObject({ status: 401, body: UNIFORM_401 });
        expect(await receiptsOf(genuine)).toMatchObject([
          {
            outcome: 'scheme_not_configured',
            reason_class: 'provider_scheme_not_configured',
            lender_org_id: A.id,
          },
        ]);
        await noEventStored(genuine);
      } finally {
        await staging.close();
      }
    });
  });

  // ======================================================================================================
  // Leaks
  // ======================================================================================================
  describe('nothing sensitive leaves the receiver', () => {
    it('writes no token, signature, body, secret or address to the log, in any outcome, including a failing database', async () => {
      const lines: string[] = [];
      const stream = { write: (line: string) => void lines.push(line) };
      const config = loadConfig({ APP_ENV: 'local', LOG_LEVEL: 'trace' });
      const leakApp = Fastify({
        logger: { ...loggerOptions(config), level: 'trace', stream },
        bodyLimit: 262_144,
        genReqId: () => randomUUID(),
      });
      await leakApp.register(rateLimit, { global: true, max: 100_000, timeWindow: '1 minute' });
      leakApp.setErrorHandler((error, request, reply) => {
        const status = (error as { statusCode?: number }).statusCode;
        return reply
          .code(status && status >= 400 && status < 500 ? status : 500)
          .send({ code: 'bad_request', instance: request.id });
      });
      registerProviderHooks(leakApp, {
        pool: receiverPool,
        secret: secretOf,
        environment: 'test',
        limits: {
          perTokenPerMinute: 100_000,
          perAddressPerMinute: 100_000,
          failuresPerMinute: 100_000,
        },
      });
      await leakApp.ready();

      // A second receiver whose database is unreachable, and one whose login may not assume the system role: real errors, real codes.
      const downPool = createSystemPool('postgresql://udofin_system@127.0.0.1:1/none');
      const noRolePool = API ? createSystemPool(API) : null;
      const failing: FastifyInstance[] = [];
      for (const pool of [downPool, noRolePool]) {
        if (!pool) continue;
        const instance = Fastify({
          logger: { ...loggerOptions(config), level: 'trace', stream },
          genReqId: () => randomUUID(),
        });
        await instance.register(rateLimit, { global: true, max: 100_000, timeWindow: '1 minute' });
        registerProviderHooks(instance, { pool, secret: secretOf, environment: 'test' });
        await instance.ready();
        failing.push(instance);
      }

      const address = '203.0.113.99';
      const canary = {
        account: `ACCTNO${Math.floor(100_000_000 + Math.random() * 899_999_999)}`,
        phone: phone(),
        link: `https://pay.example.test/checkout/CANARYLINK${randomUUID().slice(0, 8)}`,
        header: `canary-header-${randomUUID()}`,
      };
      const order = await pendingIntent(A, 9, 'leak');
      const canaryBody = buildMockWebhookBody({
        eventId: `${idPrefix('leak')}-EVT-CANARY`,
        objectKind: 'payment',
        objectRef: order.paymentRef,
        orderRef: order.orderRef,
        status: 'captured',
        amountMinor: 475_000n,
        currency: 'INR',
        occurredAt: new Date().toISOString(),
        merchantRef: A.merchantRef,
      });
      // Personal-looking fields that the mock scheme does not read: they ride in the body and must go nowhere.
      const withPersonal = Buffer.from(
        JSON.stringify({
          ...(JSON.parse(Buffer.from(canaryBody).toString('utf8')) as Record<string, unknown>),
          customer_phone: canary.phone,
          account_number: canary.account,
          checkout_link: canary.link,
        }),
        'utf8',
      );
      const canaryDelivery: MockDelivery = {
        label: 'canary',
        rawBody: new Uint8Array(withPersonal),
        headers: signMockWebhook({
          secret: A.secret,
          deliveryId: `${idPrefix('leak')}-DLV-CANARY`,
          timestampSeconds: Math.floor(Date.now() / 1000),
          rawBody: withPersonal,
        }),
      };
      const extra = { headers: { 'x-canary-header': canary.header }, remoteAddress: address };
      const unknownToken = randomBytes(32).toString('base64url');
      const forged = at(deliveriesFor('bad_signature', A, order, 'leak-forged'), 0);
      const stale = at(deliveriesFor('old_timestamp', A, order, 'leak-stale'), 0);
      const unsupported = signedBody(A.secret, 'leak-unsup', {
        eventId: `${idPrefix('leak-unsup')}-EVT`,
        objectKind: `kind_${canary.account}`,
        objectRef: `D-OBJ-${RUN}-leak`,
        status: 'x',
        occurredAt: new Date().toISOString(),
      });
      for (const token of [A.token, unknownToken, S1.token, S2.token, B.token]) {
        for (const delivery of [canaryDelivery, forged, stale, unsupported]) {
          await post(leakApp, token, delivery, extra);
        }
      }
      const canaryRow = await eventsByProviderId(eventIdOf(canaryDelivery));
      expect(canaryRow).toHaveLength(1);
      if (canaryRow[0]) myEventRows.add(canaryRow[0].id);
      const unsupportedRow = await eventsByProviderId(eventIdOf(unsupported));
      if (unsupportedRow[0]) myEventRows.add(unsupportedRow[0].id);
      // Transport errors and URL misses are logged by the framework.
      await leakApp.inject({
        method: 'POST',
        url: `/v1/hooks/provider/${A.token}`,
        headers: { 'content-type': 'text/plain' },
        payload: canary.account,
        remoteAddress: address,
      });
      await leakApp.inject({
        method: 'GET',
        url: `/v1/hooks/provider/${A.token}`,
        remoteAddress: address,
      });
      await leakApp.inject({
        method: 'POST',
        url: `/v1/hooks/provider/${A.token}/`,
        payload: '{}',
        headers: { 'content-type': 'application/json' },
        remoteAddress: address,
      });
      const failures: number[] = [];
      for (const instance of failing) {
        const res = await post(instance, A.token, canaryDelivery, extra);
        failures.push(res.statusCode);
        expect(res.json()).toMatchObject({ status: 503, code: 'temporarily_unavailable' });
      }
      expect(failures.length).toBeGreaterThan(0);

      const log = lines.join('\n');
      expect(lines.length).toBeGreaterThan(0); // the failing database is logged, as a reason class
      expect(log).toContain('config_lookup_failed');
      const forbidden = [
        A.token,
        B.token,
        C.token,
        S1.token,
        S2.token,
        unknownToken,
        hashEndpointToken(A.token),
        hashEndpointToken(unknownToken),
        A.secret,
        B.secret,
        A.webhookSecretRef,
        IP_KEY,
        address,
        canary.account,
        canary.phone,
        canary.link,
        canary.header,
        canaryDelivery.headers['webhook-signature'],
        canaryDelivery.headers['webhook-id'],
        forged.headers['webhook-signature'],
        stale.headers['webhook-signature'],
        sha256(canaryDelivery.rawBody),
        order.orderRef,
        order.paymentRef,
        A.merchantRef,
        'ECONNREFUSED',
        '127.0.0.1',
        'permission denied',
        'udofin_system',
        'udofin_api',
      ];
      for (const value of forbidden) expect(log, value).not.toContain(value);
      for (const line of lines) {
        const entry = JSON.parse(line) as { level: string; req?: unknown };
        expect(['warn', 'error']).toContain(entry.level);
        expect(entry.req).toBeUndefined();
      }

      for (const instance of failing) await instance.close();
      await leakApp.close();
      await downPool.end();
      await noRolePool?.end();
    });

    it('keeps no token, signature, secret, address or body in the database rows the receiver writes, and no personal-looking value in any response', async () => {
      const shas = [...everyPayloadSha];
      const dump = (
        await q<{ t: string }>(
          `select row_to_json(r)::text as t from payments.webhook_receipts r where r.payload_sha256 = any($1::text[])
           union all
           select row_to_json(e)::text from payments.provider_events e where e.payload_sha256 = any($1::text[]) or e.lender_org_id = any($2::uuid[])
           union all
           select row_to_json(o)::text from ops.outbox_events o where o.payload ->> 'event_id' = any($3::text[])
           union all
           select row_to_json(x)::text from payments.reconciliation_exceptions x where x.lender_org_id = any($2::uuid[])
           union all
           select row_to_json(p)::text from payments.event_processing p where p.lender_org_id = any($2::uuid[])
           union all
           select row_to_json(w)::text from ops.seen_webhooks w where w.message_id like $4`,
          [shas, [A, B, C, M, S1, S2].map((l) => l.id), [...myEventRows], `D${RUN}-%`],
        )
      ).map((row) => row.t);
      expect(dump.length).toBeGreaterThan(20);
      const text = dump.join('\n');
      const forbidden = [
        A.token,
        B.token,
        C.token,
        hashEndpointToken(A.token),
        A.secret,
        B.secret,
        IP_KEY,
        '203.0.113.7',
        '203.0.113.99',
        'v1,',
        'ACCTNO',
        'CANARYLINK',
        'checkout',
        'canary-header',
        A.phone ?? 'no-phone',
      ];
      for (const value of forbidden) expect(text, value).not.toContain(value);
      // Every stored address hash is a keyed hash: 64 hex, and none of them is the plain SHA-256 of an address.
      const hashes = await q<{ source_ip_hmac: string | null }>(
        `select distinct source_ip_hmac from payments.webhook_receipts where payload_sha256 = any($1::text[])`,
        [shas],
      );
      for (const { source_ip_hmac } of hashes) {
        expect(source_ip_hmac).toMatch(/^[0-9a-f]{64}$/);
        expect(source_ip_hmac).not.toBe(sha256('203.0.113.7'));
        expect(source_ip_hmac).not.toBe(
          createHmac('sha256', 'x').update('203.0.113.7').digest('hex'),
        );
      }

      // Every response of this file: no token, secret, signature, canary or digit run that looks like a phone or account number.
      const responses = everySeenResponse.join('\n');
      for (const value of [
        A.token,
        B.token,
        C.token,
        A.secret,
        B.secret,
        IP_KEY,
        'ACCTNO',
        'CANARYLINK',
        'checkout',
        'v1,',
      ]) {
        expect(responses, value).not.toContain(value);
      }
      expect(responses.replace(UUID_RUN, '').replace(HEX_RUN, '')).not.toMatch(/[0-9]{9,}/);
    });
  });
});
