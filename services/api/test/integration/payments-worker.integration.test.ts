// Phase 08a worker integration tests: payment orders, provider events and mandates, run through the real outbox worker, the real
// handlers and the real system SQL functions on a REAL migrated Postgres, with the labelled mock providers. Fixtures are built the
// way the pgTAP suites build them (SAMPLE data, a lender with an active mock configuration, switches on, reported figures), and the
// intents and mandates are created through the borrower functions (payments.request_payment, payments.request_mandate), so the
// outbox events are the ones the database really enqueues. No real provider exists; nothing here proves a real integration.
// Runs only when INTEGRATION_ADMIN_URL and INTEGRATION_SYSTEM_URL are set (a freshly migrated database).
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  buildMockDeliveries,
  createMockMandateProvider,
  createMockPaymentProvider,
  createUnconfiguredMandateProvider,
  HandoffVaultError,
  openHandoffLink,
  parseHandoffKeyring,
  type HandoffKeyring,
  type MandateProviderPort,
  type MockMandateProvider,
  type MockPaymentProvider,
  type PaymentProviderPort,
  type WebhookVerification,
} from '@udofin/adapters';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSystemPool, type SystemPool } from '../../src/system/pool.js';
import {
  OutboxWorker,
  type OutboxEvent,
  type OutboxStore,
  type WorkerLogger,
} from '../../src/workers/outbox-worker.js';
import { createPgOutboxStore } from '../../src/workers/pg-outbox-store.js';
import { createPaymentsHandlers } from '../../src/workers/payments-handlers.js';
import {
  createProviderResolver,
  type PaymentConfigRow,
  type ProviderResolver,
  type ResolvedPort,
} from '../../src/workers/provider-resolver.js';

const ADMIN = process.env.INTEGRATION_ADMIN_URL;
const SYSTEM = process.env.INTEGRATION_SYSTEM_URL;
const enabled = Boolean(ADMIN && SYSTEM);

// A provider key of this file's own, so a provider row another integration file registered with a different kind cannot interfere.
const PROVIDER = 'mock_gateway_w1';
// Event and delivery ids are unique per run, so the file can run again against a database an earlier run used.
const RUN = randomBytes(4).toString('hex');
const WEBHOOK_SECRET = `unit-webhook-secret-${randomBytes(10).toString('hex')}`;
const RAIL_LIMITS = JSON.stringify({
  enach_api: { max_mandate_amount_minor: 5_000_000, needs_afa_each_debit: false },
  upi_autopay: { max_mandate_amount_minor: 1_500_000, needs_afa_each_debit: true },
});
const LOANS_PER_LENDER = 9;
const phone = () => `91${Math.floor(1_000_000_000 + Math.random() * 8_999_999_999)}`;
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

interface Lender {
  readonly id: string;
  readonly tag: string;
  readonly merchantRef: string;
  readonly configId: string;
  readonly tokenHash: string;
  readonly borrowerUser: string;
  readonly borrowerId: string;
  readonly phone: string;
  readonly loans: readonly string[];
  readonly config: PaymentConfigRow;
}

type Overrides = { payment?: PaymentProviderPort; mandate?: MandateProviderPort };

describe.skipIf(!enabled)('payments worker over a real database', () => {
  const keyBytes = randomBytes(32);
  const keyring: HandoffKeyring | undefined = parseHandoffKeyring(
    JSON.stringify({ k1: keyBytes.toString('base64') }),
    'k1',
  );
  let admin: pg.Pool;
  let systemPool: SystemPool;
  let blockedPool: SystemPool;
  let A: Lender;
  let B: Lender;
  /** A lender whose mandates switch is OFF. */
  let C: Lender;

  /** Every log line the handlers and the worker wrote in this file. */
  const logLines: string[] = [];
  const logger: WorkerLogger = {
    info: (fields, message) => logLines.push(JSON.stringify({ level: 'info', message, ...fields })),
    warn: (fields, message) => logLines.push(JSON.stringify({ level: 'warn', message, ...fields })),
    error: (fields, message) =>
      logLines.push(JSON.stringify({ level: 'error', message, ...fields })),
  };
  /** The ids of the intents, mandates and events THIS file made: the worker claims only these, never another file's. */
  const mine = new Set<string>();
  /** Every bearer link a mock handed out, so the canary scans can look for them. */
  const bearerLinks: string[] = [];

  // The resolver the worker uses: the real one (environment test) unless a test installs a scripted provider for a configuration.
  const real = createProviderResolver({ environment: 'test', secret: () => undefined });
  const overrides = new Map<string, Overrides>();
  const callLog: { tenantId: string; merchantRef: string; operationKey: string }[] = [];
  const asked: string[] = [];
  const wrap = <P>(port: P): ResolvedPort<P> => ({
    port,
    contextFor: (correlationId, idempotencyKey) => ({
      tenantId: 'ignored-by-the-override',
      correlationId,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    }),
  });
  const resolver: ProviderResolver = {
    payment: (config) => {
      asked.push(`payment:${config.configId}`);
      const port = overrides.get(config.configId)?.payment;
      if (!port) return real.payment(config);
      const resolved = real.payment(config);
      // Keep the real context (the lender as tenant) and record what the provider is asked.
      const contextFor = resolved.ok ? resolved.value.contextFor : wrap(port).contextFor;
      return {
        ok: true,
        value: {
          port: {
            ...port,
            createOrder: (ctx, request) => {
              callLog.push({
                tenantId: ctx.tenantId,
                merchantRef: request.merchantRef,
                operationKey: request.operationKey,
              });
              return port.createOrder(ctx, request);
            },
          },
          contextFor,
        },
      };
    },
    mandate: (config) => {
      asked.push(`mandate:${config.configId}`);
      const port = overrides.get(config.configId)?.mandate;
      if (!port) return real.mandate(config);
      const resolved = real.mandate(config);
      return {
        ok: true,
        value: {
          port,
          contextFor: resolved.ok ? resolved.value.contextFor : wrap(port).contextFor,
        },
      };
    },
  };

  const q = async <T extends pg.QueryResultRow>(sql: string, values: unknown[] = []) =>
    (await admin.query<T>(sql, values)).rows;
  const one = async <T extends pg.QueryResultRow>(sql: string, values: unknown[] = []) => {
    const rows = await q<T>(sql, values);
    if (!rows[0]) throw new Error('expected a row');
    return rows[0];
  };

  // ------------------------------------------------------------------------------------------------------
  // The outbox, restricted to this file's own events
  // ------------------------------------------------------------------------------------------------------
  const ownStore = (): OutboxStore => {
    const pgStore = createPgOutboxStore(systemPool);
    return {
      claim: async (workerId, batch, leaseSeconds) =>
        (
          await admin.query<OutboxEvent>(
            `with picked as (
               select e.id from ops.outbox_events e
                where e.status = 'pending' and e.available_at <= now()
                  and coalesce(e.payload ->> 'intent_id', e.payload ->> 'mandate_id', e.payload ->> 'event_id') = any ($1::text[])
                order by e.available_at, e.id limit $2 for update skip locked)
             update ops.outbox_events e set status = 'processing', attempts = e.attempts + 1, locked_by = $3, locked_until = now() + make_interval(secs => $4)
               from picked where e.id = picked.id
             returning e.id, e.event_type, e.payload, e.payload_version, e.attempts, e.max_attempts, e.correlation_id`,
            [[...mine], batch, workerId, leaseSeconds],
          )
        ).rows,
      complete: pgStore.complete,
      fail: pgStore.fail,
      purge: pgStore.purge,
    };
  };
  let workerNumber = 0;
  const drain = async (pool: SystemPool = systemPool, providers: ProviderResolver = resolver) => {
    const worker = new OutboxWorker({
      store: ownStore(),
      handlers: createPaymentsHandlers({ pool, providers, keyring, log: logger }),
      workerId: `it-w1-${String((workerNumber += 1))}`,
      log: logger,
      concurrency: 1,
    });
    const total = { claimed: 0, completed: 0, retried: 0, dead: 0, lostLease: 0 };
    for (let i = 0; i < 12; i += 1) {
      const summary = await worker.runOnce();
      for (const key of Object.keys(total) as (keyof typeof total)[]) total[key] += summary[key];
      if (summary.claimed === 0) break;
    }
    return total;
  };
  const eventOf = (id: string) =>
    one<{
      id: string;
      event_type: string;
      status: string;
      attempts: number;
      last_error_code: string | null;
    }>(
      `select id, event_type, status::text as status, attempts, last_error_code from ops.outbox_events
        where coalesce(payload ->> 'intent_id', payload ->> 'mandate_id', payload ->> 'event_id') = $1 order by created_at desc, id desc limit 1`,
      [id],
    );
  const requeue = (id: string) =>
    admin.query(
      `update ops.outbox_events set status = 'pending', locked_by = null, locked_until = null, completed_at = null, available_at = now(), attempts = 0
        where coalesce(payload ->> 'intent_id', payload ->> 'mandate_id', payload ->> 'event_id') = $1`,
      [id],
    );

  // ------------------------------------------------------------------------------------------------------
  // Acting as a borrower or as nobody (the same way the pgTAP suites do)
  // ------------------------------------------------------------------------------------------------------
  type Attempt<T> =
    { ok: true; rows: T[] } | { ok: false; code: string | undefined; hint: string | undefined };
  async function attempt<T extends pg.QueryResultRow>(
    user: string | null,
    sql: string,
    values: unknown[] = [],
  ): Promise<Attempt<T>> {
    const c = await admin.connect();
    try {
      await c.query('begin');
      await c.query(`select set_config('udofin.allow_mock_providers', 'on', true)`);
      if (user) {
        await c.query(`select set_config('request.jwt.claims', $1, true)`, [
          JSON.stringify({ sub: user, role: 'authenticated', aal: 'aal2' }),
        ]);
        await c.query('set local role authenticated');
      } else {
        await c.query('set local role anon');
      }
      const result = await c.query<T>(sql, values);
      await c.query('commit');
      return { ok: true, rows: result.rows };
    } catch (error) {
      await c.query('rollback');
      const { code, hint } = error as { code?: string; hint?: string };
      return { ok: false, code, hint };
    } finally {
      c.release();
    }
  }
  async function asBorrower<T extends pg.QueryResultRow>(
    user: string,
    sql: string,
    values: unknown[] = [],
  ) {
    const result = await attempt<T>(user, sql, values);
    if (!result.ok) throw new Error(`database refused: ${result.code ?? '?'} ${result.hint ?? ''}`);
    return result.rows;
  }

  const requestPayment = async (lender: Lender, loanIndex: number): Promise<string> => {
    const [row] = await asBorrower<{ id: string }>(
      lender.borrowerUser,
      `select payments.request_payment($1::uuid, 'installment'::payments.intent_purpose, 475000::bigint, $2, null) as id`,
      [lender.loans[loanIndex], `it-w1-pay-${randomUUID()}`],
    );
    if (!row) throw new Error('no intent');
    mine.add(row.id);
    return row.id;
  };
  const today = async (plusDays: number) =>
    (
      await one<{ d: string }>(
        `select to_char((clock_timestamp() at time zone 'Asia/Kolkata')::date + $1::int, 'YYYY-MM-DD') as d`,
        [plusDays],
      )
    ).d;
  const requestMandate = async (
    lender: Lender,
    loanIndex: number,
    rail = 'enach_api',
  ): Promise<string> => {
    const id = randomUUID();
    await q(
      `insert into identity.stepup_challenges (id, borrower_id, action, context_ref, code_hash, status, delivery_status, expires_at, verified_at, verified_until)
       values (gen_random_uuid(), $1, 'mandate_creation', $2, repeat('a', 64), 'verified', 'accepted', now() + interval '10 minutes', now(), now() + interval '10 minutes')`,
      [lender.borrowerId, id],
    );
    await asBorrower(
      lender.borrowerUser,
      `select payments.request_mandate($1::uuid, $2::uuid, $3, 4000000::bigint, $4::date, $5::date, 'XXXXXX1234') as id`,
      [id, lender.loans[loanIndex], rail, await today(1), await today(365)],
    );
    mine.add(id);
    return id;
  };

  const intentRow = (id: string) =>
    one<{ status: string; provider_order_ref: string | null; link_expires_at: Date | null }>(
      `select status::text as status, provider_order_ref, link_expires_at from payments.payment_intents where id = $1`,
      [id],
    );
  const mandateRow = (id: string) =>
    one<{
      status: string;
      provider_mandate_ref: string | null;
      cancel_requested_at: Date | null;
      cancel_sent_at: Date | null;
    }>(
      `select status, provider_mandate_ref, cancel_requested_at, cancel_sent_at from payments.mandates where id = $1`,
      [id],
    );
  /** The mandate's history as "source:new status" in order (the first row is the borrower's request, which has no earlier status). */
  const historySources = async (mandate: string) =>
    (
      await q<{ source: string; to_status: string }>(
        `select source, to_status from payments.mandate_events where mandate_id = $1 order by created_at, id`,
        [mandate],
      )
    ).map((r) => `${r.source}:${r.to_status}`);
  const linkRow = async (kind: string, subject: string) =>
    (
      await q<{
        id: string;
        ciphertext: Buffer;
        key_version: string;
        read_count: number;
        lender_org_id: string;
      }>(
        `select id, ciphertext, key_version, read_count, lender_org_id from payments.handoff_links where subject_kind = $1 and subject_id = $2`,
        [kind, subject],
      )
    )[0];
  const mockOf = (lender: Lender): MockPaymentProvider => {
    const resolved = real.payment(lender.config);
    if (!resolved.ok) throw new Error('no mock');
    return resolved.value.port as MockPaymentProvider;
  };
  const mandateMockOf = (lender: Lender): MockMandateProvider => {
    const resolved = real.mandate(lender.config);
    if (!resolved.ok) throw new Error('no mock');
    return resolved.value.port as MockMandateProvider;
  };
  /** The bearer link the mock handed out for an intent (asking again with the same operation key returns the same order). */
  async function linkOfIntent(lender: Lender, intent: string): Promise<string> {
    const mock = mockOf(lender);
    const request = mock.created.find((r) => r.operationKey === intent);
    if (!request) throw new Error('the mock never saw this intent');
    const again = await mock.createOrder({ tenantId: lender.id, correlationId: 'it' }, request);
    if (again.outcome !== 'ok' || again.value.checkoutLink === null) throw new Error('no link');
    bearerLinks.push(again.value.checkoutLink);
    return again.value.checkoutLink;
  }

  // ------------------------------------------------------------------------------------------------------
  // Fixture
  // ------------------------------------------------------------------------------------------------------
  async function buildLender(
    name: string,
    features: readonly string[] = ['payments', 'servicing_sync', 'mandates'],
  ): Promise<Lender> {
    const id = randomUUID();
    const tag = id.replaceAll('-', '').slice(0, 12);
    const [
      maker,
      checker,
      submitter,
      switchRequester,
      switchDecider,
      productMaker,
      productApprover,
    ] = Array.from({ length: 7 }, () => randomUUID());
    const borrowerUser = randomUUID();
    const borrowerPhone = phone();
    const merchantRef = `SAMPLE-MERCHANT-${tag}`;
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
      await c.query(`insert into auth.users (id, phone, raw_app_meta_data) values ($1, $2, '{}')`, [
        borrowerUser,
        borrowerPhone,
      ]);
      const borrowerId = (
        await c.query<{ id: string }>('select id from identity.borrowers where user_id = $1', [
          borrowerUser,
        ])
      ).rows[0]?.id;
      if (!borrowerId) throw new Error('no borrower');
      await c.query(
        `insert into tenancy.organizations (id, kind, legal_name, display_name, regulator_registration_no, status) values ($1, 'lender', $2, $3, $4, 'active')`,
        [id, `${name} W1 Ltd (test)`, name, `IT-W1-${tag}`],
      );
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

      // The collection configuration: an approved format rule, a verified registry entry and settlement account, a registered
      // provider and merchant, and a two-person active configuration in mock mode with rail limits (all SAMPLE).
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
          [id, rule, maker, `sample-fixture-registry-${tag}`, checker],
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
           values ($1, 'SAMPLE provider (fixture)', 'payment_and_mandate', 'approved', 'SAMPLE-AUTH-EVIDENCE-1') on conflict (provider) do nothing`,
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
      const tokenHash = sha256(`SAMPLE-TOKEN-${id}`);
      const configId = (
        await c.query<{ id: string }>(
          `insert into payments.lender_payment_configs (lender_org_id, provider, provider_mode, merchant_registry_id, settlement_account_id, secret_ref, webhook_secret_ref,
                                                        endpoint_token_hash, rail_limits, rail_limits_source, evidence_ref, contract_section_ref, idempotency_key, drafted_by)
             values ($1, $2, 'mock', $3, $4, 'SAMPLE_SECRET', 'SAMPLE_WEBHOOK_SECRET', $5, $6::jsonb, 'SAMPLE copy of provider documentation (fixture)',
                     'SAMPLE-EVIDENCE-2', 'SAMPLE-CONTRACT-1', $7, $8) returning id`,
          [
            id,
            PROVIDER,
            merchant,
            settlement,
            tokenHash,
            RAIL_LIMITS,
            `sample-fixture-config-${tag}`,
            maker,
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

      // The activation switches (an applied two-person request and the switch itself, as the pgTAP suites do).
      for (const feature of features) {
        const request = (
          await c.query<{ id: string }>(
            `insert into servicing.feature_change_requests (lender_org_id, feature, enable, mode, status, evidence, requested_by, idempotency_key, decided_by, decided_at, applied_at)
               values ($1, $2, true, 'two_person', 'applied', '{"contract_ref":"SAMPLE-W1"}', $3, $4, $5, now(), now()) returning id`,
            [id, feature, switchRequester, `it-w1-req-${feature}-${tag}`, switchDecider],
          )
        ).rows[0]?.id;
        await c.query(
          `insert into servicing.lender_features (lender_org_id, feature, enabled, evidence, enabled_by, enabled_at, last_change_request_id)
             values ($1, $2, true, '{"contract_ref":"SAMPLE-W1"}', $3, now(), $4)`,
          [id, feature, switchDecider, request],
        );
      }

      // One product, and LOANS_PER_LENDER active loans of the borrower with fresh lender-reported figures and a schedule.
      const product = randomUUID();
      const version = randomUUID();
      await c.query(
        `insert into lending.loan_products (id, lender_org_id, category_key, code, name, status) values ($1, $2, 'personal', $3, 'W1 Personal Loan', 'active')`,
        [product, id, `PL-${tag.slice(0, 6).toUpperCase()}`],
      );
      await c.query(
        `insert into lending.loan_product_versions (id, product_id, lender_org_id, version, status, min_amount_minor, max_amount_minor, min_tenure_days, max_tenure_days,
           rate_type, min_annual_rate_bps, max_annual_rate_bps, drafted_by, approved_by, approved_at, effective_from)
           values ($1, $2, $3, 1, 'approved', 1000000, 50000000, 180, 1825, 'fixed', 1400, 2400, $4, $5, now(), now())`,
        [version, product, id, productMaker, productApprover],
      );
      const loans: string[] = [];
      for (let n = 1; n <= LOANS_PER_LENDER; n += 1) {
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
          [application, id, request, borrowerId, version, `SAMPLE-APP-${tag}-${String(n)}`],
        );
        await c.query(
          `insert into servicing.loan_accounts (id, lender_org_id, application_id, borrower_id, source_system, lms_loan_ref, status, sanctioned_amount_minor)
             values ($1, $2, $3, $4, 'lender_lms', $5, 'active', 5000000)`,
          [loan, id, application, borrowerId, `SAMPLE-LN-${tag}-${String(n)}`],
        );
        await c.query(
          `insert into servicing.balance_snapshots (lender_org_id, loan_account_id, version, status, outstanding_principal_minor, total_overdue_minor, next_due_on, next_due_minor,
             days_past_due, source_system, source_record_id, reported_as_of, content_sha256)
             values ($1, $2, 1, 'active', 4000000, 0, (clock_timestamp() at time zone 'Asia/Kolkata')::date + 3, 475000, 0, 'file_import', $3, clock_timestamp() - interval '1 hour', $4)`,
          [id, loan, `SRC-${tag}-${String(n)}`, sha256(`snap-${loan}`)],
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
      // The device-integrity result a mandate needs, once per borrower.
      await c.query(
        `insert into identity.device_attestations (borrower_id, level, provider, verified_at, expires_at)
           values ($1, 'device', 'sample_attest', clock_timestamp(), clock_timestamp() + interval '2 hours')`,
        [borrowerId],
      );
      await c.query('commit');
      const config: PaymentConfigRow = {
        configId,
        lenderOrgId: id,
        provider: PROVIDER,
        providerMode: 'mock',
        merchantRef,
        secretRef: 'SAMPLE_SECRET',
        webhookSecretRef: 'SAMPLE_WEBHOOK_SECRET',
      };
      return {
        id,
        tag,
        merchantRef,
        configId,
        tokenHash,
        borrowerUser,
        borrowerId,
        phone: borrowerPhone,
        loans,
        config,
      };
    } catch (error) {
      await c.query('rollback');
      throw error;
    } finally {
      c.release();
    }
  }

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: ADMIN, max: 4 });
    const withOptions = (url: string, options: string) =>
      `${url}${url.includes('?') ? '&' : '?'}options=${encodeURIComponent(options)}`;
    // The database refuses to move a mock-mode mandate in a session that does not allow mock providers (the guard fires on every
    // update). The worker's session allows it here, as a local or test deployment must; a second pool does NOT, to show the guard.
    systemPool = createSystemPool(withOptions(SYSTEM ?? '', '-c udofin.allow_mock_providers=on'));
    blockedPool = createSystemPool(SYSTEM ?? '');
    A = await buildLender('Alpha');
    B = await buildLender('Beta');
    C = await buildLender('Gamma', ['payments', 'servicing_sync']);
  });

  afterAll(async () => {
    // Leave nothing pending for another file's worker to trip over.
    if (admin) {
      await admin.query(
        `update ops.outbox_events set status = 'completed', completed_at = now(), locked_by = null, locked_until = null
          where status in ('pending', 'processing')
            and coalesce(payload ->> 'intent_id', payload ->> 'mandate_id', payload ->> 'event_id') = any ($1::text[])`,
        [[...mine]],
      );
    }
    await systemPool?.end();
    await blockedPool?.end();
    await admin?.end();
  });

  // ======================================================================================================
  // Payment orders
  // ======================================================================================================
  describe('payment.create_order', () => {
    const s: { intent: string; link: string; eventId: string } = {
      intent: '',
      link: '',
      eventId: '',
    };

    it('the database enqueues the order job with the intent id and nothing else', async () => {
      s.intent = await requestPayment(A, 0);
      expect(await intentRow(s.intent)).toMatchObject({
        status: 'created',
        provider_order_ref: null,
      });
      const events = await q<{ event_type: string; payload: unknown; status: string }>(
        `select event_type, payload, status::text as status from ops.outbox_events where payload ->> 'intent_id' = $1`,
        [s.intent],
      );
      expect(events).toEqual([
        { event_type: 'payment.create_order', payload: { intent_id: s.intent }, status: 'pending' },
      ]);
    });

    it('creates the order at the provider, records it, and keeps only the SEALED link', async () => {
      const summary = await drain();
      expect(summary).toMatchObject({ claimed: 1, completed: 1, retried: 0, dead: 0 });
      const intent = await intentRow(s.intent);
      expect(intent.status).toBe('pending');
      expect(intent.provider_order_ref).toBe(`MOCK-ORDER-${s.intent}`);

      // The provider was asked once, with the intent as operation key, the lender's merchant and the exact amount.
      const mock = mockOf(A);
      expect(mock.created).toHaveLength(1);
      expect(mock.created[0]).toMatchObject({
        operationKey: s.intent,
        receiptRef: s.intent,
        merchantRef: A.merchantRef,
        amountMinor: 475_000n,
        currency: 'INR',
        purpose: 'installment',
      });

      s.link = await linkOfIntent(A, s.intent);
      const stored = await linkRow('payment_intent', s.intent);
      expect(stored).toBeDefined();
      if (!stored) return;
      expect(stored.lender_org_id).toBe(A.id);
      expect(stored.key_version).toBe('k1');
      const token = s.link.split('/').at(-1) ?? '';
      expect(token.length).toBeGreaterThan(10);
      // The stored bytes are ciphertext: they hold no part of the link.
      expect(stored.ciphertext.includes(Buffer.from(s.link))).toBe(false);
      expect(stored.ciphertext.includes(Buffer.from(token))).toBe(false);
      expect(stored.ciphertext.includes(Buffer.from('mock-checkout'))).toBe(false);
      expect(
        keyring &&
          openHandoffLink(
            keyring,
            { kind: 'payment_intent', subjectId: s.intent, lenderOrgId: A.id },
            stored.key_version,
            stored.ciphertext,
          ),
      ).toBe(s.link);
      expect(stored.read_count).toBe(0);
    });

    it('the owning borrower gets the ciphertext and opens exactly the provider link; the read is counted', async () => {
      if (!keyring) throw new Error('keyring');
      const result = await attempt<{
        lender_org_id: string;
        key_version: string;
        ciphertext: Buffer;
      }>(A.borrowerUser, `select * from payments.take_handoff_link('payment_intent', $1::uuid)`, [
        s.intent,
      ]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const [row] = result.rows;
      if (!row) throw new Error('no row');
      expect(
        openHandoffLink(
          keyring,
          { kind: 'payment_intent', subjectId: s.intent, lenderOrgId: row.lender_org_id },
          row.key_version,
          row.ciphertext,
        ),
      ).toBe(s.link);
      expect((await linkRow('payment_intent', s.intent))?.read_count).toBe(1);
    });

    it("another borrower, another lender's borrower, and anon get nothing", async () => {
      const other = await attempt(
        B.borrowerUser,
        `select * from payments.take_handoff_link('payment_intent', $1::uuid)`,
        [s.intent],
      );
      expect(other).toMatchObject({ ok: false, code: 'P0002', hint: 'link_unavailable' });
      const anon = await attempt(
        null,
        `select * from payments.take_handoff_link('payment_intent', $1::uuid)`,
        [s.intent],
      );
      expect(anon).toMatchObject({ ok: false, code: '42501' });
      expect((await linkRow('payment_intent', s.intent))?.read_count).toBe(1);
    });

    it('a lender that is not active hides the stored link at once, and it comes back when the lender does', async () => {
      const taking = () =>
        attempt(
          A.borrowerUser,
          `select * from payments.take_handoff_link('payment_intent', $1::uuid)`,
          [s.intent],
        );
      await admin.query(`update tenancy.organizations set status = 'suspended' where id = $1`, [
        A.id,
      ]);
      try {
        expect(await taking()).toMatchObject({
          ok: false,
          code: 'P0002',
          hint: 'link_unavailable',
        });
      } finally {
        await admin.query(`update tenancy.organizations set status = 'active' where id = $1`, [
          A.id,
        ]);
      }
      expect(await taking()).toMatchObject({ ok: true });
    });

    it('a lender whose payments switch is off cannot even start a mandate: nothing is enqueued for the worker', async () => {
      const id = randomUUID();
      const before = await q(
        `select 1 from ops.outbox_events where event_type = 'mandate.handoff' and payload ->> 'mandate_id' = $1`,
        [id],
      );
      await q(
        `insert into identity.stepup_challenges (id, borrower_id, action, context_ref, code_hash, status, delivery_status, expires_at, verified_at, verified_until)
         values (gen_random_uuid(), $1, 'mandate_creation', $2, repeat('a', 64), 'verified', 'accepted', now() + interval '10 minutes', now(), now() + interval '10 minutes')`,
        [C.borrowerId, id],
      );
      const refused = await attempt(
        C.borrowerUser,
        `select payments.request_mandate($1::uuid, $2::uuid, 'enach_api', 4000000::bigint, $3::date, $4::date, 'XXXXXX1234')`,
        [id, C.loans[0], await today(1), await today(365)],
      );
      expect(refused).toMatchObject({ ok: false, code: '55000', hint: 'feature_disabled' });
      expect(before).toHaveLength(0);
      expect(await q(`select 1 from payments.mandates where id = $1`, [id])).toHaveLength(0);
      expect(
        await q(`select 1 from ops.outbox_events where payload ->> 'mandate_id' = $1`, [id]),
      ).toHaveLength(0);
    });

    it('a stored link opens only for its own payment and its own lender (the associated data binds it)', async () => {
      if (!keyring) throw new Error('keyring');
      const stored = await linkRow('payment_intent', s.intent);
      if (!stored) throw new Error('no link');
      const open = (subjectId: string, lenderOrgId: string) =>
        openHandoffLink(
          keyring,
          { kind: 'payment_intent', subjectId, lenderOrgId },
          stored.key_version,
          stored.ciphertext,
        );
      expect(() => open(s.intent, B.id)).toThrow(HandoffVaultError);
      expect(() => open(randomUUID(), A.id)).toThrow(HandoffVaultError);
      expect(() =>
        openHandoffLink(
          keyring,
          { kind: 'mandate', subjectId: s.intent, lenderOrgId: A.id },
          stored.key_version,
          stored.ciphertext,
        ),
      ).toThrow(HandoffVaultError);
    });

    it('the audit trail of the vault names the key version and nothing else', async () => {
      const events = await q<{ metadata: unknown }>(
        `select metadata from audit.events where action = 'payments.handoff.stored' and entity_id = $1`,
        [s.intent],
      );
      expect(events).toEqual([{ metadata: { key_version: 'k1' } }]);
    });

    it('a REPLAYED delivery of the same outbox event does nothing: one order, the same intent, the same stored link', async () => {
      const before = await linkRow('payment_intent', s.intent);
      await requeue(s.intent);
      const summary = await drain();
      expect(summary).toMatchObject({ claimed: 1, completed: 1, dead: 0 });
      expect(mockOf(A).created).toHaveLength(1);
      expect(await intentRow(s.intent)).toMatchObject({
        status: 'pending',
        provider_order_ref: `MOCK-ORDER-${s.intent}`,
      });
      const after = await linkRow('payment_intent', s.intent);
      expect(after?.id).toBe(before?.id);
      expect(after?.ciphertext.equals(before?.ciphertext ?? Buffer.alloc(0))).toBe(true);
      expect(logLines.some((l) => l.includes('the intent is not waiting for an order'))).toBe(true);
    });

    it('a cancelled intent is never sent to the provider', async () => {
      const intent = await requestPayment(A, 1);
      const cancelled = await asBorrower<{ r: string }>(
        A.borrowerUser,
        `select payments.cancel_my_payment($1::uuid) as r`,
        [intent],
      );
      expect(cancelled[0]?.r).toBe('cancelled');
      const before = mockOf(A).created.length;
      const summary = await drain();
      expect(summary).toMatchObject({ claimed: 1, completed: 1, dead: 0 });
      expect(mockOf(A).created).toHaveLength(before);
      expect((await intentRow(intent)).status).toBe('cancelled');
      expect(await linkRow('payment_intent', intent)).toBeUndefined();
    });

    it("a merchant the provider names that is not the configured one fails the intent, suspends THAT lender's configuration and keeps no link", async () => {
      const first = await requestPayment(B, 0);
      const second = await requestPayment(B, 1);
      const aIntent = await requestPayment(A, 7);
      const scripted = createMockPaymentProvider('test', { scenario: 'wrong_merchant' });
      overrides.set(B.configId, { payment: scripted });
      try {
        const summary = await drain();
        expect(summary).toMatchObject({ claimed: 3, completed: 3, dead: 0 });
      } finally {
        overrides.delete(B.configId);
      }
      expect(await intentRow(first)).toMatchObject({ status: 'failed', provider_order_ref: null });
      expect(await linkRow('payment_intent', first)).toBeUndefined();
      const configB = await one<{ status: string }>(
        `select status from payments.lender_payment_configs where id = $1`,
        [B.configId],
      );
      expect(configB.status).toBe('suspended');
      const exceptions = await q<{ class: string; severity: string; owner: string }>(
        `select class, severity, owner from payments.reconciliation_exceptions where lender_org_id = $1 and class = 'merchant_mismatch'`,
        [B.id],
      );
      expect(exceptions).toEqual([
        { class: 'merchant_mismatch', severity: 'critical', owner: 'platform' },
      ]);
      // The second intent of the suspended configuration was never sent anywhere: the provider saw exactly one request.
      expect(scripted.created).toHaveLength(1);
      expect(await intentRow(second)).toMatchObject({ status: 'failed', provider_order_ref: null });
      // Lender A is untouched: its configuration is active and its intent was processed under its own merchant.
      const configA = await one<{ status: string }>(
        `select status from payments.lender_payment_configs where id = $1`,
        [A.configId],
      );
      expect(configA.status).toBe('active');
      expect(await intentRow(aIntent)).toMatchObject({ status: 'pending' });
      // The provider was asked as the right tenant with the right merchant every time.
      expect(callLog.filter((c) => c.operationKey === first)).toEqual([
        { tenantId: B.id, merchantRef: B.merchantRef, operationKey: first },
      ]);
      expect(await linkRow('payment_intent', aIntent)).toBeDefined();
    });

    it('a timeout is looked up by operation key, never created twice: the order is recorded and the log says no link is available', async () => {
      const intent = await requestPayment(A, 2);
      const scripted = createMockPaymentProvider('test', { scenario: 'unknown_outcome' });
      overrides.set(A.configId, { payment: scripted });
      try {
        const summary = await drain();
        expect(summary).toMatchObject({ claimed: 1, completed: 1, retried: 0, dead: 0 });
      } finally {
        overrides.delete(A.configId);
      }
      expect(scripted.created).toHaveLength(1);
      expect(await intentRow(intent)).toMatchObject({
        status: 'pending',
        provider_order_ref: `MOCK-ORDER-${intent}`,
      });
      expect(await linkRow('payment_intent', intent)).toBeUndefined();
      expect(
        logLines.some((l) => l.includes(intent) && l.includes('no hand-off link is available')),
      ).toBe(true);
    });

    it('a timeout that no lookup settles is retried with backoff, then the intent is failed as provider_unavailable', async () => {
      const intent = await requestPayment(A, 3);
      const undecided: PaymentProviderPort = {
        ...createMockPaymentProvider('test'),
        createOrder: () => Promise.resolve({ outcome: 'unknown', reason: 'timeout' }),
        getOrderStatus: () => Promise.resolve({ outcome: 'not_found' }),
      };
      overrides.set(A.configId, { payment: undecided });
      try {
        const first = await drain();
        expect(first).toMatchObject({ claimed: 1, completed: 0, retried: 1, dead: 0 });
        expect(await intentRow(intent)).toMatchObject({ status: 'created' });
        expect(await eventOf(intent)).toMatchObject({
          status: 'pending',
          attempts: 1,
          last_error_code: 'handler_error',
        });
        // The last allowed attempt: the outcome stays unresolved, so the intent is failed and the event completes.
        await admin.query(
          `update ops.outbox_events set attempts = max_attempts - 1, available_at = now() where payload ->> 'intent_id' = $1`,
          [intent],
        );
        const last = await drain();
        expect(last).toMatchObject({ claimed: 1, completed: 1, retried: 0, dead: 0 });
      } finally {
        overrides.delete(A.configId);
      }
      expect(await intentRow(intent)).toMatchObject({ status: 'failed', provider_order_ref: null });
    });

    it('a mock configuration is refused in a staging worker: the intent fails closed, nothing is created anywhere', async () => {
      const intent = await requestPayment(A, 6);
      const staging = createProviderResolver({ environment: 'staging', secret: () => undefined });
      const before = mockOf(A).created.length;
      const summary = await drain(systemPool, staging);
      expect(summary).toMatchObject({ claimed: 1, completed: 1, dead: 0 });
      expect(await intentRow(intent)).toMatchObject({ status: 'failed', provider_order_ref: null });
      expect(mockOf(A).created).toHaveLength(before);
      expect(logLines.some((l) => l.includes(intent) && l.includes('mock_not_allowed_here'))).toBe(
        true,
      );
      const config = await one<{ status: string }>(
        `select status from payments.lender_payment_configs where id = $1`,
        [A.configId],
      );
      expect(config.status).toBe('active');
    });

    it('an intent whose payment period ended while the worker was down gets no order; the expiry sweep closes it as expired', async () => {
      const intent = await requestPayment(A, 8);
      await admin.query(
        `update payments.payment_intents set link_expires_at = clock_timestamp() - interval '2 hours' where id = $1`,
        [intent],
      );
      const before = mockOf(A).created.length;
      expect(await drain()).toMatchObject({ claimed: 1, completed: 1, dead: 0 });
      expect(mockOf(A).created).toHaveLength(before);
      expect((await intentRow(intent)).status).toBe('created');
      const expired = await systemPool.withSystem((tx) =>
        tx.query<{ n: number }>(`select payments.expire_stale_intents(interval '0 minutes') as n`),
      );
      expect(expired.rows[0]?.n).toBeGreaterThanOrEqual(1);
      expect((await intentRow(intent)).status).toBe('expired');
      expect(await linkRow('payment_intent', intent)).toBeUndefined();
    });

    it('a job with a bad payload or for an unknown intent is dead at once with a stable code', async () => {
      const missing = randomUUID();
      mine.add(missing);
      await admin.query(
        `select ops.enqueue_event('payment.create_order', jsonb_build_object('intent_id', $1::text), null, $2)`,
        [missing, `it-w1-missing-${missing}`],
      );
      const extra = randomUUID();
      mine.add(extra);
      await admin.query(
        `select ops.enqueue_event('payment.create_order', jsonb_build_object('intent_id', $1::text, 'note', 'x'), null, $2)`,
        [extra, `it-w1-extra-${extra}`],
      );
      const summary = await drain();
      expect(summary).toMatchObject({ claimed: 2, dead: 2 });
      expect(await eventOf(missing)).toMatchObject({
        status: 'dead',
        last_error_code: 'intent_not_found',
      });
      expect(await eventOf(extra)).toMatchObject({
        status: 'dead',
        last_error_code: 'invalid_payload',
      });
    });
  });

  // ======================================================================================================
  // Provider events (verified deliveries), applied by the worker
  // ======================================================================================================
  describe('payment.apply_event', () => {
    function ingestPayload(verification: WebhookVerification, bodyBytes: number) {
      const verified = verification.outcome === 'verified' ? verification : undefined;
      const event = verified?.event;
      return {
        provider: PROVIDER,
        outcome: verification.outcome,
        reason_class:
          verification.outcome === 'verified'
            ? 'none'
            : 'reason' in verification
              ? verification.reason
              : 'none',
        delivery_id: event?.deliveryId ?? `it-w1-${randomUUID()}`,
        payload_sha256: verification.payloadSha256,
        scheme: 'mock-standard-webhooks-v1',
        signature_present: true,
        timestamp_skew_seconds: 0,
        body_bytes: bodyBytes,
        ip_hmac: 'a'.repeat(64),
        ...(event
          ? {
              event: {
                ...event,
                provider: PROVIDER,
                amountMinor: event.amountMinor === null ? null : event.amountMinor.toString(),
              },
            }
          : {}),
      };
    }
    async function deliver(
      lender: Lender,
      scenario: Parameters<typeof buildMockDeliveries>[0],
      orderRef: string,
      amount: bigint,
      prefix: string,
    ) {
      const now = new Date();
      const verifier = createMockPaymentProvider('test').webhookVerifier;
      const results: { outcome: string; accepted: unknown }[] = [];
      for (const delivery of buildMockDeliveries(scenario, {
        secret: WEBHOOK_SECRET,
        orderRef,
        paymentRef: `${prefix}-PAY`,
        amountMinor: amount,
        merchantRef: lender.merchantRef,
        now,
        idPrefix: prefix,
      })) {
        // The receiver's job: verify over the raw body with the lender's webhook secret, then hand the verdict to the database.
        const verdict = verifier.verify(delivery.rawBody, delivery.headers, {
          secret: WEBHOOK_SECRET,
          now,
        });
        const answer = (
          await systemPool.withSystem((tx) =>
            tx.query<{ r: { accepted: boolean; outcome: string } }>(
              `select payments.ingest_provider_delivery($1, $2::jsonb) as r`,
              [lender.tokenHash, JSON.stringify(ingestPayload(verdict, delivery.rawBody.length))],
            ),
          )
        ).rows[0]?.r;
        results.push({ outcome: verdict.outcome, accepted: answer });
      }
      const events = await q<{ id: string }>(
        `select id from payments.provider_events where provider_event_id like $1 order by received_at, id`,
        [`${prefix}-EVT-%`],
      );
      for (const e of events) mine.add(e.id);
      return { results, eventIds: events.map((e) => e.id) };
    }
    const orderOf = async (lender: Lender, loanIndex: number) => {
      const intent = await requestPayment(lender, loanIndex);
      await drain();
      const row = await intentRow(intent);
      expect(row.status).toBe('pending');
      return { intent, orderRef: row.provider_order_ref ?? '' };
    };

    it('a signed delivery verified by the receiver and ingested is applied exactly once and the intent succeeds only on the exact amount', async () => {
      const { intent, orderRef } = await orderOf(A, 4);
      const { results, eventIds } = await deliver(A, 'success', orderRef, 475_000n, `W1${RUN}OK`);
      expect(results.map((r) => r.outcome)).toEqual(['verified', 'verified']);
      expect(results.every((r) => (r.accepted as { accepted: boolean }).accepted)).toBe(true);
      expect(eventIds).toHaveLength(2);
      const queued = await q<{ event_type: string; payload: { event_id: string } }>(
        `select event_type, payload from ops.outbox_events where event_type = 'payment.apply_event' and payload ->> 'event_id' = any ($1::text[]) order by created_at, id`,
        [eventIds],
      );
      expect(queued.map((e) => e.payload)).toEqual(eventIds.map((event_id) => ({ event_id })));

      expect(await drain()).toMatchObject({ claimed: 2, completed: 2, dead: 0 });
      expect((await intentRow(intent)).status).toBe('succeeded');
      const payments = await q<{ status: string; amount_minor: string }>(
        `select status, amount_minor::text as amount_minor from payments.provider_payments where intent_id = $1`,
        [intent],
      );
      expect(payments).toEqual([{ status: 'captured', amount_minor: '475000' }]);
      const outcomes = await q<{ outcome: string }>(
        `select outcome from payments.event_processing where event_id = any ($1::uuid[]) order by processed_at, id`,
        [eventIds],
      );
      expect(outcomes.map((o) => o.outcome)).toEqual(['applied', 'applied']);

      // A replayed outbox event is already applied: nothing changes and the outcome word says so.
      for (const id of eventIds) await requeue(id);
      expect(await drain()).toMatchObject({ claimed: 2, completed: 2, dead: 0 });
      expect(
        logLines.filter((l) => l.includes('"outcome":"already_applied"')).length,
      ).toBeGreaterThanOrEqual(2);
      expect((await intentRow(intent)).status).toBe('succeeded');
      expect(
        await q(`select 1 from payments.provider_payments where intent_id = $1`, [intent]),
      ).toHaveLength(1);
    });

    it('a forged delivery (wrong secret) is rejected by the database and enqueues nothing: the intent stays pending', async () => {
      const { intent, orderRef } = await orderOf(A, 5);
      const { results, eventIds } = await deliver(
        A,
        'bad_signature',
        orderRef,
        475_000n,
        `W1${RUN}BAD`,
      );
      expect(results.map((r) => r.outcome)).toEqual(['unverified']);
      expect(results[0]?.accepted).toMatchObject({ accepted: false, outcome: 'rejected' });
      expect(eventIds).toEqual([]);
      expect(await drain()).toMatchObject({ claimed: 0 });
      expect((await intentRow(intent)).status).toBe('pending');
    });

    it('a capture of a different amount never makes the intent succeed: the worker reports an exception outcome', async () => {
      // A third lender-A intent: loan 2 is used by a timeout test, loan 7 by the tenant test; reuse loan 3 after its failure.
      const { intent, orderRef } = await orderOf(A, 3);
      const { eventIds } = await deliver(A, 'partial_amount', orderRef, 475_000n, `W1${RUN}PART`);
      expect(eventIds).toHaveLength(1);
      expect(await drain()).toMatchObject({ claimed: 1, completed: 1, dead: 0 });
      expect((await intentRow(intent)).status).toBe('pending');
      const exceptions = await q<{ class: string }>(
        `select class from payments.reconciliation_exceptions where lender_org_id = $1 and class = 'amount_mismatch' and status <> 'resolved'`,
        [A.id],
      );
      expect(exceptions.length).toBeGreaterThanOrEqual(1);
      expect(
        logLines.some((l) => l.includes(eventIds[0] ?? 'x') && l.includes('"outcome":"exception"')),
      ).toBe(true);
    });

    it('an event that does not exist is dead at once with a stable code', async () => {
      const missing = randomUUID();
      mine.add(missing);
      await admin.query(
        `select ops.enqueue_event('payment.apply_event', jsonb_build_object('event_id', $1::text), null, $2)`,
        [missing, `it-w1-noevent-${missing}`],
      );
      expect(await drain()).toMatchObject({ claimed: 1, dead: 1 });
      expect(await eventOf(missing)).toMatchObject({
        status: 'dead',
        last_error_code: 'event_not_found',
      });
    });
  });

  // ======================================================================================================
  // Mandates
  // ======================================================================================================
  describe('mandate.handoff and mandate.cancel', () => {
    const s: { ok: string; link: string } = { ok: '', link: '' };

    it('the hand-off is requested at the provider, recorded as registration_pending (NOT active) and the authorisation link is sealed', async () => {
      if (!keyring) throw new Error('keyring');
      s.ok = await requestMandate(A, 0);
      expect(await mandateRow(s.ok)).toMatchObject({ status: 'draft', provider_mandate_ref: null });
      const queued = await q<{ event_type: string; payload: unknown }>(
        `select event_type, payload from ops.outbox_events where payload ->> 'mandate_id' = $1`,
        [s.ok],
      );
      expect(queued).toEqual([{ event_type: 'mandate.handoff', payload: { mandate_id: s.ok } }]);

      expect(await drain()).toMatchObject({ claimed: 1, completed: 1, dead: 0 });
      expect(await mandateRow(s.ok)).toMatchObject({
        status: 'registration_pending',
        provider_mandate_ref: `MOCK-MANDATE-${s.ok}`,
      });
      const mock = mandateMockOf(A);
      expect(mock.requests).toHaveLength(1);
      expect(mock.requests[0]).toMatchObject({
        operationKey: s.ok,
        rail: 'enach_api',
        merchantRef: A.merchantRef,
        maxAmountMinor: 4_000_000n,
        currency: 'INR',
        maskedAccountRef: 'XXXXXX1234',
      });
      const history = await q<{ h: string }>(
        `select coalesce(from_status, '-') || '>' || to_status || '/' || source as h from payments.mandate_events where mandate_id = $1 order by created_at, id`,
        [s.ok],
      );
      expect(history.map((r) => r.h)).toEqual([
        '->draft/request',
        'draft>registration_pending/handoff',
      ]);

      // The borrower takes the sealed link and opens exactly what the provider returned.
      const stored = await linkRow('mandate', s.ok);
      if (!stored) throw new Error('no link stored');
      const request = mock.requests.find((r) => r.operationKey === s.ok);
      if (!request) throw new Error('the mock never saw this mandate');
      const handOff = await mock.createMandateRequest(
        { tenantId: A.id, correlationId: 'it' },
        request,
      );
      s.link = handOff.outcome === 'ok' ? (handOff.value.handOffLink ?? '') : '';
      expect(s.link).toMatch(/^https:\/\/mock-mandate\.invalid\/handoff\//);
      bearerLinks.push(s.link);
      expect(stored.ciphertext.includes(Buffer.from(s.link.split('/').at(-1) ?? 'x'))).toBe(false);
      expect(
        openHandoffLink(
          keyring,
          { kind: 'mandate', subjectId: s.ok, lenderOrgId: A.id },
          stored.key_version,
          stored.ciphertext,
        ),
      ).toBe(s.link);
      const taken = await attempt<{
        lender_org_id: string;
        key_version: string;
        ciphertext: Buffer;
      }>(A.borrowerUser, `select * from payments.take_handoff_link('mandate', $1::uuid)`, [s.ok]);
      expect(
        taken.ok &&
          taken.rows[0] &&
          openHandoffLink(
            keyring,
            { kind: 'mandate', subjectId: s.ok, lenderOrgId: A.id },
            taken.rows[0].key_version,
            taken.rows[0].ciphertext,
          ),
      ).toBe(s.link);
      // Not the other lender's borrower, not anon.
      expect(
        await attempt(
          B.borrowerUser,
          `select * from payments.take_handoff_link('mandate', $1::uuid)`,
          [s.ok],
        ),
      ).toMatchObject({ ok: false, code: 'P0002' });
      expect(
        await attempt(null, `select * from payments.take_handoff_link('mandate', $1::uuid)`, [
          s.ok,
        ]),
      ).toMatchObject({ ok: false, code: '42501' });
    });

    it('a replayed hand-off does nothing', async () => {
      const before = await linkRow('mandate', s.ok);
      await requeue(s.ok);
      expect(await drain()).toMatchObject({ claimed: 1, completed: 1, dead: 0 });
      expect(mandateMockOf(A).requests).toHaveLength(1);
      expect((await mandateRow(s.ok)).status).toBe('registration_pending');
      expect((await linkRow('mandate', s.ok))?.id).toBe(before?.id);
    });

    it('a refused hand-off closes the draft as failed; no link', async () => {
      const id = await requestMandate(A, 2);
      overrides.set(A.configId, {
        mandate: {
          ...createMockMandateProvider('test'),
          createMandateRequest: () =>
            Promise.resolve({ outcome: 'rejected', reason: 'rail_not_supported' }),
        },
      });
      try {
        expect(await drain()).toMatchObject({ claimed: 1, completed: 1, dead: 0 });
      } finally {
        overrides.delete(A.configId);
      }
      expect(await mandateRow(id)).toMatchObject({ status: 'failed', provider_mandate_ref: null });
      expect(await linkRow('mandate', id)).toBeUndefined();
      // A provider's own refusal is recorded with the source "handoff" (compare "no provider configured" below).
      expect(await historySources(id)).toEqual(['request:draft', 'handoff:failed']);
    });

    it('an unknown outcome is parked for reconciliation with a platform exception: not retried, not rejected, no link', async () => {
      const id = await requestMandate(A, 1);
      const scripted = createMockMandateProvider('test', 'unknown_outcome');
      overrides.set(A.configId, { mandate: scripted });
      try {
        expect(await drain()).toMatchObject({ claimed: 1, completed: 1, retried: 0, dead: 0 });
      } finally {
        overrides.delete(A.configId);
      }
      expect(scripted.requests).toHaveLength(1);
      expect(await mandateRow(id)).toMatchObject({ status: 'requires_reconciliation' });
      expect(await linkRow('mandate', id)).toBeUndefined();
      const exceptions = await q<{ class: string; owner: string }>(
        `select class, owner from payments.reconciliation_exceptions where lender_org_id = $1 and class = 'mandate_unresolved' and subject ->> 'mandate_id' = $2`,
        [A.id, id],
      );
      expect(exceptions).toEqual([{ class: 'mandate_unresolved', owner: 'platform' }]);
      // A replay never asks the provider again.
      await requeue(id);
      overrides.set(A.configId, { mandate: scripted });
      try {
        await drain();
      } finally {
        overrides.delete(A.configId);
      }
      expect(scripted.requests).toHaveLength(1);
    });

    it('no provider configured: nothing was sent, so the draft is closed as failed with the system as the source (not a refusal)', async () => {
      const id = await requestMandate(A, 3);
      overrides.set(A.configId, { mandate: createUnconfiguredMandateProvider() });
      try {
        expect(await drain()).toMatchObject({ claimed: 1, completed: 1, dead: 0 });
      } finally {
        overrides.delete(A.configId);
      }
      expect(await mandateRow(id)).toMatchObject({ status: 'failed', provider_mandate_ref: null });
      expect(await historySources(id)).toEqual(['request:draft', 'system:failed']);
      // Nothing is unresolved, so no exception was opened for it.
      expect(
        await q(
          `select 1 from payments.reconciliation_exceptions where lender_org_id = $1 and subject ->> 'mandate_id' = $2`,
          [A.id, id],
        ),
      ).toHaveLength(0);
    });

    it('the database guard still stops a mock mandate from moving in a session that does not allow mock providers; the retry then succeeds', async () => {
      const id = await requestMandate(A, 4);
      const scripted = createMockMandateProvider('test');
      overrides.set(A.configId, { mandate: scripted });
      try {
        const blocked = await drain(blockedPool);
        expect(blocked).toMatchObject({ claimed: 1, completed: 0, retried: 1, dead: 0 });
        expect(await mandateRow(id)).toMatchObject({ status: 'draft' });
        expect(await eventOf(id)).toMatchObject({
          status: 'pending',
          last_error_code: 'handler_error',
        });
        await admin.query(
          `update ops.outbox_events set available_at = now() where payload ->> 'mandate_id' = $1`,
          [id],
        );
        expect(await drain(systemPool)).toMatchObject({ claimed: 1, completed: 1, dead: 0 });
      } finally {
        overrides.delete(A.configId);
      }
      // The provider was asked twice with the SAME operation key and holds one mandate.
      expect(scripted.requests).toHaveLength(1);
      expect(await mandateRow(id)).toMatchObject({ status: 'registration_pending' });
    });

    it('a draft the borrower already asked to cancel is never sent to the provider', async () => {
      const id = await requestMandate(A, 5);
      const cancelled = await asBorrower<{ r: string }>(
        A.borrowerUser,
        `select payments.request_mandate_cancellation($1::uuid) as r`,
        [id],
      );
      expect(cancelled[0]?.r).toBe('cancel_requested');
      const scripted = createMockMandateProvider('test');
      overrides.set(A.configId, { mandate: scripted });
      try {
        // Two jobs: the hand-off and the cancel. Neither reaches the provider.
        expect(await drain()).toMatchObject({ claimed: 2, completed: 2, dead: 0 });
      } finally {
        overrides.delete(A.configId);
      }
      expect(scripted.requests).toHaveLength(0);
      expect(scripted.cancelRequests).toHaveLength(0);
      expect(await mandateRow(id)).toMatchObject({ status: 'draft', cancel_sent_at: null });
    });

    it('a cancellation request reaches the provider and is marked sent; the mandate is NOT cancelled by it', async () => {
      const cancelled = await asBorrower<{ r: string }>(
        A.borrowerUser,
        `select payments.request_mandate_cancellation($1::uuid) as r`,
        [s.ok],
      );
      expect(cancelled[0]?.r).toBe('cancel_requested');
      const queued = await q<{ event_type: string; payload: unknown }>(
        `select event_type, payload from ops.outbox_events where event_type = 'mandate.cancel' and payload ->> 'mandate_id' = $1`,
        [s.ok],
      );
      expect(queued).toEqual([{ event_type: 'mandate.cancel', payload: { mandate_id: s.ok } }]);
      // Only the cancel job is pending now: requeue marks the old hand-off job pending too, so drain and look at the cancel result.
      expect(await drain()).toMatchObject({ dead: 0 });
      const mock = mandateMockOf(A);
      expect(mock.cancelRequests).toEqual([
        { providerMandateRef: `MOCK-MANDATE-${s.ok}`, operationKey: s.ok },
      ]);
      const row = await mandateRow(s.ok);
      expect(row.cancel_sent_at).not.toBeNull();
      expect(row.status).toBe('registration_pending');
      // A replay sends nothing more.
      await admin.query(
        `update ops.outbox_events set status = 'pending', locked_by = null, locked_until = null, completed_at = null, available_at = now(), attempts = 0
          where event_type = 'mandate.cancel' and payload ->> 'mandate_id' = $1`,
        [s.ok],
      );
      expect(await drain()).toMatchObject({ dead: 0 });
      expect(mock.cancelRequests).toHaveLength(1);
    });

    it('an unanswered cancellation is not marked as sent; the sweep will report it', async () => {
      const id = await requestMandate(A, 6);
      expect(await drain()).toMatchObject({ claimed: 1, completed: 1, dead: 0 });
      expect((await mandateRow(id)).status).toBe('registration_pending');
      await asBorrower(A.borrowerUser, `select payments.request_mandate_cancellation($1::uuid)`, [
        id,
      ]);
      const silent: MandateProviderPort = {
        ...createMockMandateProvider('test'),
        cancelMandate: () => Promise.resolve({ outcome: 'unknown', reason: 'timeout' }),
      };
      overrides.set(A.configId, { mandate: silent });
      try {
        expect(await drain()).toMatchObject({ claimed: 1, completed: 1, dead: 0 });
      } finally {
        overrides.delete(A.configId);
      }
      expect(await mandateRow(id)).toMatchObject({
        cancel_sent_at: null,
        status: 'registration_pending',
      });
    });
  });

  // ======================================================================================================
  // What must never leak
  // ======================================================================================================
  describe('canaries', () => {
    it('no phone, link, link token, webhook secret or key appears in any log line the worker wrote', () => {
      const text = logLines.join('\n');
      expect(logLines.length).toBeGreaterThan(20);
      expect(bearerLinks.length).toBeGreaterThan(0);
      for (const link of bearerLinks) {
        expect(text).not.toContain(link);
        expect(text).not.toContain(link.split('/').at(-1) ?? 'x-never');
      }
      for (const forbidden of [
        A.phone,
        B.phone,
        'mock-checkout',
        'mock-mandate',
        WEBHOOK_SECRET,
        keyBytes.toString('base64'),
        keyBytes.toString('hex'),
        'XXXXXX1234',
      ]) {
        expect(text).not.toContain(forbidden);
      }
    });

    it('no link, phone or secret reaches the outbox, the audit trail, the intents, the mandates or the vault row', async () => {
      const ids = [...mine];
      const pieces = await q<{ t: string }>(
        `select to_jsonb(e)::text as t from ops.outbox_events e where coalesce(e.payload ->> 'intent_id', e.payload ->> 'mandate_id', e.payload ->> 'event_id') = any ($1::text[])
         union all select to_jsonb(a)::text from audit.events a where a.entity_id = any ($1::text[])
         union all select to_jsonb(i)::text from payments.payment_intents i where i.id::text = any ($1::text[])
         union all select to_jsonb(m)::text from payments.mandates m where m.id::text = any ($1::text[])
         union all select to_jsonb(me)::text from payments.mandate_events me where me.mandate_id::text = any ($1::text[])
         union all select to_jsonb(h)::text from payments.handoff_links h where h.subject_id::text = any ($1::text[])
         union all select to_jsonb(x)::text from payments.reconciliation_exceptions x where x.lender_org_id in ($2::uuid, $3::uuid)
         union all select to_jsonb(p)::text from payments.provider_payments p where p.lender_org_id in ($2::uuid, $3::uuid)`,
        [ids, A.id, B.id],
      );
      expect(pieces.length).toBeGreaterThan(10);
      const text = pieces.map((p) => p.t).join('\n');
      for (const link of bearerLinks) {
        expect(text).not.toContain(link);
        expect(text).not.toContain(link.split('/').at(-1) ?? 'x-never');
      }
      for (const forbidden of [
        A.phone,
        B.phone,
        'mock-checkout',
        'mock-mandate',
        WEBHOOK_SECRET,
        'SAMPLE_SECRET_VALUE',
      ]) {
        expect(text).not.toContain(forbidden);
      }
    });

    it('no event of this file is left dead or processing unexpectedly', async () => {
      const rows = await q<{ status: string; n: string }>(
        `select status::text as status, count(*)::text as n from ops.outbox_events
          where coalesce(payload ->> 'intent_id', payload ->> 'mandate_id', payload ->> 'event_id') = any ($1::text[]) group by status`,
        [[...mine]],
      );
      const byStatus = Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
      expect(byStatus.processing ?? 0).toBe(0);
      // The two deliberately dead jobs (unknown intent, bad payload) and the unknown event are the only dead ones.
      expect(byStatus.dead ?? 0).toBe(3);
    });
  });
});
