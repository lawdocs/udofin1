// Phase 08a (wave 5) integration tests of the scheduled work and the servicing event handlers, against a REAL migrated Postgres:
// reminders planned, claimed and sent on in_app and push (push not configured outside local and test), the order lookup before a
// payment intent is expired, mandate lookups and sweeps, debit planning and pre-debit notices, hand-off link purge, configuration
// revalidation, the daily reconciliation run, and the servicing handlers run by the real outbox worker. Providers are the labelled
// mocks (test environment), the notifier is the mock notifier. Runs only when the INTEGRATION_* URLs are set, on a freshly migrated
// database (bash /tmp/.../apply.sh before each run).
//
// Where a database state is hard to build through the product (a loan with a schedule, an intent whose link expired hours ago, a
// mandate stuck in registration), it is built as the owner with session_replication_role = replica, the way the pgTAP tests do, and
// committed before the jobs run. Everything the jobs then do goes through the system login (service_role) and the real functions.
import { randomUUID } from 'node:crypto';
import {
  createMockMandateProvider,
  createMockNotifier,
  createMockPaymentProvider,
  type MandateDebitReport,
  type MandateProviderPort,
  type PaymentProviderPort,
} from '@udofin/adapters';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createJobsStore,
  RECONCILIATION_LOOKBACK_DAYS,
  type JobsStore,
} from '../../src/system/jobs.js';
import { createSystemPool, type SystemPool } from '../../src/system/pool.js';
import { OutboxWorker, type WorkerLogger } from '../../src/workers/outbox-worker.js';
import { createPgOutboxStore } from '../../src/workers/pg-outbox-store.js';
import { createPeriodicJobs, type PeriodicJobOptions } from '../../src/workers/periodic-jobs.js';
import {
  type PaymentConfigRow,
  type ProviderResolver,
} from '../../src/workers/provider-resolver.js';
import {
  createServiceChannels,
  type ServiceChannels,
} from '../../src/workers/reminder-channels.js';
import { createServicingHandlers } from '../../src/workers/servicing-handlers.js';

const ADMIN = process.env.INTEGRATION_ADMIN_URL;
const API = process.env.INTEGRATION_API_URL;
const SYSTEM = process.env.INTEGRATION_SYSTEM_URL;
const enabled = Boolean(ADMIN && API && SYSTEM);

/** The system login, with the session settings the pgTAP suite uses: mock providers allowed, and the reminder window judged at 10:00 IST. */
function systemUrl(url: string): string {
  const u = new URL(url);
  u.searchParams.set(
    'options',
    '-c udofin.allow_mock_providers=on -c udofin.test_clock=2026-03-10T10:00:00+05:30',
  );
  return u.toString();
}

const phone = () => `91${Math.floor(1_000_000_000 + Math.random() * 8_999_999_999)}`;
const lit = (id: string) => `'${id}'::uuid`;

describe.skipIf(!enabled)('scheduled jobs and servicing handlers against a real database', () => {
  const ids = {
    b1: randomUUID(),
    b2: randomUUID(),
    commsAdmin: randomUUID(),
    commsApprover: randomUUID(),
    switchRequester: randomUUID(),
    switchDecider: randomUUID(),
    lenderA: randomUUID(), // reminders on
    lenderB: randomUUID(), // servicing_sync on, reminders OFF
    lenderP: randomUUID(), // payments + mandates + servicing_sync; a settlement-capable mock provider
    lenderQ: randomUUID(), // no switch on at all, but an active configuration
    lenderR: randomUUID(), // payments; its configuration is broken later
    lenderN: randomUUID(), // payments; a provider that cannot report settlements
  };
  const phones = { b1: phone(), b2: phone() };
  const cfg: Record<'P' | 'Q' | 'R' | 'N', string> = { P: '', Q: '', R: '', N: '' };
  const borrower: Record<'b1' | 'b2', string> = { b1: '', b2: '' };
  /** Loans, intents, mandates: ids chosen here, rows built by the fixture. */
  const loan = {
    a1: randomUUID(),
    a2: randomUUID(),
    a3: randomUUID(),
    b1: randomUUID(),
    p: randomUUID(), // all intents of lender P hang off this loan (each with its own installment number)
    m10: randomUUID(),
    m11: randomUUID(),
    m12: randomUUID(),
    m13: randomUUID(),
    m14: randomUUID(),
    mc: randomUUID(),
    q: randomUUID(),
  };
  const intent = {
    old: randomUUID(),
    held: randomUUID(),
    young: randomUUID(),
    created: randomUUID(),
    recent: randomUUID(),
    withPayment: randomUUID(),
    rec: randomUUID(),
    linkOk: randomUUID(),
    linkOld: randomUUID(),
    linkOrphan: randomUUID(),
    off: randomUUID(),
  };
  const mandate = {
    m10: randomUUID(), // registration pending, the provider will say active
    m11: randomUUID(), // active, installments to plan debits for
    m12: randomUUID(), // active on a loan the lender already closed
    m13: randomUUID(), // a draft nobody finished
    m14: randomUUID(), // active; no channel can carry its notice
    mc: randomUUID(), // active on a loan that is closed through the real transition
    off10: randomUUID(), // lender Q (switch off): registration pending
    off11: randomUUID(), // lender Q (switch off): active
  };

  let admin: pg.Pool;
  let systemPool: SystemPool;
  let store: JobsStore;
  let istToday = '';
  const logLines: string[] = [];
  const log: WorkerLogger = {
    info: (f, m) => logLines.push(JSON.stringify({ level: 'info', f, m })),
    warn: (f, m) => logLines.push(JSON.stringify({ level: 'warn', f, m })),
    error: (f, m) => logLines.push(JSON.stringify({ level: 'error', f, m })),
  };

  // ---- the providers: labelled mocks, with spies on what is asked of them --------------------------------------------------
  const calls = {
    orderLookups: [] as string[],
    settlementFetches: [] as { config: string; date: string }[],
    mandateStatus: [] as string[],
    debitLists: [] as string[],
  };
  const paymentSuccess = createMockPaymentProvider('test', { scenario: 'success' });
  const paymentFailure = createMockPaymentProvider('test', { scenario: 'failure' });
  /** Only the reconciliation order lives here, so the settlement report holds exactly that payment. */
  const settlementMock = createMockPaymentProvider('test', {
    settlementDestinationMaskedRef: 'XXXXXX1111',
  });
  const orderRoutes = new Map<string, PaymentProviderPort>();
  const paymentPortP: PaymentProviderPort = {
    ...paymentSuccess,
    getOrderStatus: (ctx, query) => {
      calls.orderLookups.push(query.operationKey);
      return (orderRoutes.get(query.operationKey) ?? paymentFailure).getOrderStatus(ctx, query);
    },
    fetchSettlements: (ctx, date) => {
      calls.settlementFetches.push({ config: cfg.P, date });
      // The provider settled the payment on the current day. Another date's report is empty (an empty report is a report).
      return date === istToday
        ? settlementMock.fetchSettlements(ctx, date)
        : Promise.resolve({ outcome: 'ok' as const, value: { date, batches: [] } });
    },
  };
  const paymentPortN: PaymentProviderPort = {
    ...paymentSuccess,
    capabilities: { ...paymentSuccess.capabilities, settlementReports: false },
    fetchSettlements: (ctx, date) => {
      calls.settlementFetches.push({ config: cfg.N, date });
      return paymentSuccess.fetchSettlements(ctx, date);
    },
  };
  const mandateMock = createMockMandateProvider('test', 'registered');
  const debitReports = new Map<string, MandateDebitReport[]>();
  const mandatePortP: MandateProviderPort = {
    ...mandateMock,
    getMandateStatus: (ctx, query) => {
      calls.mandateStatus.push(query.operationKey);
      return mandateMock.getMandateStatus(ctx, query);
    },
    listDebitStatus: (_ctx, query) => {
      calls.debitLists.push(query.providerMandateRef);
      return Promise.resolve({
        outcome: 'ok' as const,
        value: debitReports.get(query.providerMandateRef) ?? [],
      });
    },
  };
  const paymentPorts = new Map<string, PaymentProviderPort>();
  const mandatePorts = new Map<string, MandateProviderPort>();
  const resolvedRows: PaymentConfigRow[] = [];
  const resolver: ProviderResolver = {
    payment(row) {
      resolvedRows.push(row);
      const port = paymentPorts.get(row.configId);
      return port
        ? {
            ok: true,
            value: {
              port,
              contextFor: (correlationId, idempotencyKey) => ({
                tenantId: row.lenderOrgId,
                correlationId,
                ...(idempotencyKey ? { idempotencyKey } : {}),
              }),
            },
          }
        : { ok: false, reason: 'provider_not_configured' };
    },
    mandate(row) {
      resolvedRows.push(row);
      const port = mandatePorts.get(row.configId);
      return port
        ? {
            ok: true,
            value: {
              port,
              contextFor: (correlationId, idempotencyKey) => ({
                tenantId: row.lenderOrgId,
                correlationId,
                ...(idempotencyKey ? { idempotencyKey } : {}),
              }),
            },
          }
        : { ok: false, reason: 'provider_not_configured' };
    },
  };
  const notifier = createMockNotifier('test');
  const testChannels: ServiceChannels = createServiceChannels({
    environment: 'test',
    push: notifier.channels.push,
  });

  function periodic(
    options: PeriodicJobOptions & {
      environment?: 'test' | 'staging' | 'production';
      providers?: ProviderResolver;
    } = {},
  ) {
    const { environment = 'test', providers = resolver, ...rest } = options;
    return createPeriodicJobs(
      { pool: systemPool, providers, environment, log },
      { channels: testChannels, ...rest },
    );
  }

  // ---- database helpers -----------------------------------------------------------------------------------------------------
  const q = async <T extends pg.QueryResultRow>(sql: string, values: unknown[] = []) =>
    (await admin.query<T>(sql, values)).rows;
  const scalar = async <T>(sql: string, values: unknown[] = []): Promise<T> => {
    const rows = await q<{ v: T }>(sql, values);
    return rows[0]?.v as T;
  };
  /** Runs several statements on one connection, in one transaction, with temp helper functions available. */
  async function transaction(work: (client: pg.PoolClient) => Promise<void>) {
    const client = await admin.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('udofin.allow_mock_providers', 'on', true)`);
      await work(client);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }
  /** Reads as a signed-in borrower (row level security applies, as it does in the API). */
  async function asBorrower<T extends pg.QueryResultRow>(userId: string, sql: string) {
    const client = await admin.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: userId, role: 'authenticated', aal: 'aal1' }),
      ]);
      await client.query('set local role authenticated');
      const result = await client.query<T>(sql);
      await client.query('rollback');
      return result.rows;
    } finally {
      client.release();
    }
  }
  const makeDue = (loanId: string) =>
    q(
      `update servicing.reminders set scheduled_for = now() - interval '1 hour' where loan_account_id = $1::uuid and status = 'planned'`,
      [loanId],
    );
  const postpone = (loanId: string) =>
    q(
      `update servicing.reminders set scheduled_for = now() + interval '1 day' where loan_account_id = $1::uuid and status = 'planned'`,
      [loanId],
    );
  const reminders = (loanId: string) =>
    q<{ channel: string; kind: string; status: string; suppress_reason: string | null }>(
      `select channel, kind, status, suppress_reason from servicing.reminders where loan_account_id = $1::uuid order by kind, channel`,
      [loanId],
    );
  const deliveries = (loanId: string) =>
    q<{ channel: string; state: string; source: string; provider_ref: string | null }>(
      `select d.channel, d.state, d.source, d.provider_ref from servicing.reminder_deliveries d
         join servicing.reminders r on r.id = d.reminder_id where r.loan_account_id = $1::uuid order by d.occurred_at, d.channel`,
      [loanId],
    );
  const intentStatus = (id: string) =>
    scalar<string>(`select status::text as v from payments.payment_intents where id = $1::uuid`, [
      id,
    ]);
  const openExceptions = (klass: string, subjectKey?: string, subjectValue?: string) =>
    scalar<number>(
      `select count(*)::int as v from payments.reconciliation_exceptions
        where class = $1 and status <> 'resolved' and ($2::text is null or subject ->> $2 = $3)`,
      [klass, subjectKey ?? null, subjectValue ?? null],
    );
  const mandateStatus = (id: string) =>
    scalar<string>(`select status as v from payments.mandates where id = $1::uuid`, [id]);

  // ---- fixture --------------------------------------------------------------------------------------------------------------
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: ADMIN, max: 4 });
    systemPool = createSystemPool(systemUrl(SYSTEM ?? ''));
    store = createJobsStore(systemPool);
    istToday = await scalar<string>(`select (now() at time zone 'Asia/Kolkata')::date::text as v`);

    // 1. people, lenders, switches, reminder policies and wording (drafted by one person, approved by another, through the functions)
    await transaction(async (c) => {
      await c.query(`
        create function pg_temp.as_user(uid uuid, aal text default 'aal2') returns void language plpgsql as $fn$
        begin
          execute 'reset role';
          perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated', 'aal', aal)::text, true);
          execute 'set local role authenticated';
        end $fn$;
        create function pg_temp.as_owner() returns void language plpgsql as $fn$
        begin
          execute 'reset role';
          perform set_config('request.jwt.claims', '', true);
        end $fn$;
        grant execute on all functions in schema pg_temp to public;
        insert into auth.users (id, phone, raw_app_meta_data) values
          (${lit(ids.b1)}, '${phones.b1}', '{}'), (${lit(ids.b2)}, '${phones.b2}', '{}'),
          (${lit(ids.commsAdmin)}, null, '{"actor_type":"staff"}'), (${lit(ids.commsApprover)}, null, '{"actor_type":"staff"}'),
          (${lit(ids.switchRequester)}, null, '{"actor_type":"staff"}'), (${lit(ids.switchDecider)}, null, '{"actor_type":"staff"}');
        insert into tenancy.organizations (id, kind, legal_name, display_name, regulator_registration_no, status) values
          (${lit(ids.lenderA)}, 'lender', 'Alpha Finance Ltd (test)', 'Alpha', 'TEST-PJ-A-${ids.lenderA.slice(0, 8)}', 'active'),
          (${lit(ids.lenderB)}, 'lender', 'Beta Capital Ltd (test)', 'Beta', 'TEST-PJ-B-${ids.lenderB.slice(0, 8)}', 'active'),
          (${lit(ids.lenderP)}, 'lender', 'Gamma Finance Ltd (test)', 'Gamma', 'TEST-PJ-P-${ids.lenderP.slice(0, 8)}', 'active'),
          (${lit(ids.lenderQ)}, 'lender', 'Delta Credit Ltd (test)', 'Delta', 'TEST-PJ-Q-${ids.lenderQ.slice(0, 8)}', 'active'),
          (${lit(ids.lenderR)}, 'lender', 'Epsilon Loans Ltd (test)', 'Epsilon', 'TEST-PJ-R-${ids.lenderR.slice(0, 8)}', 'active'),
          (${lit(ids.lenderN)}, 'lender', 'Zeta Lending Ltd (test)', 'Zeta', 'TEST-PJ-N-${ids.lenderN.slice(0, 8)}', 'active');
        insert into onboarding.lender_gates (lender_org_id, stage)
          select o, 'activated' from unnest(array[${[ids.lenderA, ids.lenderB, ids.lenderP, ids.lenderQ, ids.lenderR, ids.lenderN].map(lit).join(', ')}]) o;
        insert into tenancy.memberships (id, org_id, user_id, status) values
          (gen_random_uuid(), ${lit(ids.lenderA)}, ${lit(ids.commsAdmin)}, 'active'), (gen_random_uuid(), ${lit(ids.lenderA)}, ${lit(ids.commsApprover)}, 'active'),
          (gen_random_uuid(), ${lit(ids.lenderB)}, ${lit(ids.commsAdmin)}, 'active'), (gen_random_uuid(), ${lit(ids.lenderB)}, ${lit(ids.commsApprover)}, 'active');
        insert into tenancy.membership_roles (membership_id, role_id)
          select m.id, r.id from tenancy.memberships m
            join tenancy.roles r on r.org_id is null and r.applies_to = 'lender'
           where (m.user_id = ${lit(ids.commsAdmin)} and r.key = 'communications_admin') or (m.user_id = ${lit(ids.commsApprover)} and r.key = 'communications_approver');
      `);
      // Switches: an applied two-person request and the switch, the way the pgTAP suites record it.
      const switches: [string, string][] = [
        [ids.lenderA, 'servicing_sync'],
        [ids.lenderA, 'reminders'],
        [ids.lenderB, 'servicing_sync'],
        [ids.lenderP, 'servicing_sync'],
        [ids.lenderP, 'payments'],
        [ids.lenderP, 'mandates'],
        [ids.lenderR, 'payments'],
        [ids.lenderN, 'payments'],
      ];
      for (const [lender, feature] of switches) {
        await c.query(
          `insert into servicing.feature_change_requests (lender_org_id, feature, enable, mode, status, evidence, requested_by, idempotency_key, decided_by, decided_at, applied_at)
           values ($1::uuid, $2, true, 'two_person', 'applied', '{"contract_ref":"SAMPLE-PJ"}', $3::uuid, $4, $5::uuid, now(), now())`,
          [
            lender,
            feature,
            ids.switchRequester,
            `pj-req-${feature}-${lender.slice(0, 8)}-0001`,
            ids.switchDecider,
          ],
        );
      }
      await c.query(
        `insert into servicing.lender_features (lender_org_id, feature, enabled, evidence, enabled_by, enabled_at, last_change_request_id)
         select r.lender_org_id, r.feature, true, r.evidence, $1::uuid, now(), r.id from servicing.feature_change_requests r
          where r.idempotency_key like 'pj-req-%' and r.requested_by = $2::uuid`,
        [ids.switchDecider, ids.switchRequester],
      );
      await c.query(`select pg_temp.as_user(${lit(ids.commsAdmin)})`);
      const policyA = (
        await c.query<{ id: string }>(
          `select servicing.draft_reminder_policy(${lit(ids.lenderA)}, array[-1, 0, 3], true, array['in_app', 'push', 'sms'], time '09:00', time '18:00', 2)::text as id`,
        )
      ).rows[0]?.id;
      const policyB = (
        await c.query<{ id: string }>(
          `select servicing.draft_reminder_policy(${lit(ids.lenderB)}, array[-1, 0, 3], true, array['in_app', 'push'], time '09:00', time '18:00', 2)::text as id`,
        )
      ).rows[0]?.id;
      const templates: string[] = [];
      for (const [lender, kind, body] of [
        [
          ids.lenderA,
          'pre_due',
          'Reminder from {{lender_name}}: {{amount}} is due on {{due_date}}.',
        ],
        [
          ids.lenderA,
          'due_day',
          'Reminder from {{lender_name}}: {{amount}} is due today, {{due_date}}.',
        ],
        [
          ids.lenderA,
          'overdue',
          'Reminder from {{lender_name}}: {{amount}} is overdue. {{penal_text}}',
        ],
        [
          ids.lenderB,
          'pre_due',
          'Reminder from {{lender_name}}: {{amount}} is due on {{due_date}}.',
        ],
      ] as const) {
        const r = await c.query<{ id: string }>(
          `select servicing.draft_reminder_template($1::uuid, $2, 'en', $3)::text as id`,
          [lender, kind, body],
        );
        templates.push(r.rows[0]?.id ?? '');
      }
      await c.query(`select pg_temp.as_user(${lit(ids.commsApprover)})`);
      for (const id of [policyA, policyB]) {
        await c.query(`select servicing.approve_reminder_policy($1::uuid)`, [id]);
      }
      for (const id of templates) {
        await c.query(`select servicing.approve_reminder_template($1::uuid)`, [id]);
      }
      await c.query(`select pg_temp.as_owner()`);
    });

    // 2. payment configurations (active, mock, valid): drafted, submitted and approved by three different people, as the owner
    await transaction(async (c) => {
      await c.query(`
        create function pg_temp.sample_config(p_lender uuid, p_settlement uuid, p_masked text, p_rail_limits jsonb) returns uuid language plpgsql as $fn$
        declare
          v_tag text := left(md5(p_lender::text), 12);
          u1 uuid := md5(p_lender::text || 'sample-maker')::uuid;
          u2 uuid := md5(p_lender::text || 'sample-checker')::uuid;
          u3 uuid := md5(p_lender::text || 'sample-submitter')::uuid;
          v_rule uuid; v_reg uuid; v_mer uuid; v_cfg uuid;
        begin
          perform set_config('udofin.allow_mock_providers', 'on', true);
          insert into auth.users (id, raw_app_meta_data) values (u1, '{"actor_type":"staff"}'), (u2, '{"actor_type":"staff"}'), (u3, '{"actor_type":"staff"}') on conflict (id) do nothing;
          insert into payments.account_format_rules (country, account_type, version, min_digits, max_digits, ifsc_required, status, evidence_label, source_note, effective_from, drafted_by, submitted_by,
                                                     submitted_at, approved_by, approved_at)
            values ('IN', 'sample_fixture', 1, 9, 18, true, 'approved', 'unverified', 'SAMPLE fixture rule, not a real source', date '2026-01-01', u1, u1, now(), u2, now())
            on conflict (country, account_type, version) do nothing;
          select id into v_rule from payments.account_format_rules where country = 'IN' and account_type = 'sample_fixture' and version = 1;
          insert into payments.fingerprint_key_versions (key_version, proposed_by) values (1, u1) on conflict (key_version) do nothing;
          update payments.fingerprint_key_versions set status = 'active', approved_by = u2, approved_at = now() where key_version = 1 and status = 'proposed';
          insert into payments.account_registry (fingerprint, key_version, masked_ref, country, account_type, format_rule_id, format_validated, owner_kind, owner_org_id, legal_owner_name,
                                                 permitted_purposes, verification_status, evidence_ref, effective_from, registered_by, idempotency_key, verified_by, verified_at)
            values (encode(sha256(convert_to('SAMPLE-FIXTURE-' || p_lender::text, 'UTF8')), 'hex'), 1, p_masked, 'IN', 'sample_fixture', v_rule, true, 'lender', p_lender,
                    'SAMPLE Lender Ltd (fixture)', array['repayment_settlement'], 'verified', 'SAMPLE-EVIDENCE-1', current_date - 30, u1, 'sample-fixture-registry-' || v_tag, u2, now())
            returning id into v_reg;
          insert into tenancy.lender_settlement_accounts (id, lender_org_id, label, bank_name, masked_account_ref, status, registry_id, verified_by, verified_at)
            values (p_settlement, p_lender, 'SAMPLE collections', 'Test Bank', p_masked, 'verified', v_reg, u1, now());
          insert into payments.provider_register (provider, display_name, kind, status, authorisation_evidence_ref)
            values ('mock_gateway', 'SAMPLE provider (fixture)', 'payment_and_mandate', 'approved', 'SAMPLE-AUTH-EVIDENCE-1') on conflict (provider) do nothing;
          insert into payments.merchant_registry (provider, merchant_ref, owner_kind, owner_org_id, purpose, claimed_by, verification_status, verification_evidence_ref, verified_by, verified_at)
            values ('mock_gateway', 'SAMPLE-MERCHANT-' || v_tag, 'lender', p_lender, 'repayment', u1, 'verified', 'SAMPLE-EVIDENCE-3', u2, now()) returning id into v_mer;
          insert into payments.lender_payment_configs (lender_org_id, provider, provider_mode, merchant_registry_id, settlement_account_id, secret_ref, webhook_secret_ref, endpoint_token_hash,
                                                       rail_limits, rail_limits_source, evidence_ref, contract_section_ref, idempotency_key, drafted_by)
            values (p_lender, 'mock_gateway', 'mock', v_mer, p_settlement, 'SAMPLE_SECRET', 'SAMPLE_WEBHOOK_SECRET', encode(sha256(convert_to('SAMPLE-TOKEN-' || p_lender::text, 'UTF8')), 'hex'),
                    p_rail_limits, case when p_rail_limits = '{}'::jsonb then null else 'SAMPLE copy of provider documentation (fixture)' end, 'SAMPLE-EVIDENCE-2', 'SAMPLE-CONTRACT-1',
                    'sample-fixture-config-' || v_tag, u1) returning id into v_cfg;
          update payments.lender_payment_configs set status = 'pending_approval', submitted_by = u3, submitted_at = now(), status_changed_by = u3 where id = v_cfg;
          update payments.lender_payment_configs set status = 'active', approved_by = u2, approved_at = now(), status_changed_by = u2 where id = v_cfg;
          return v_cfg;
        end $fn$;
      `);
      const rail =
        '{"enach_api": {"max_mandate_amount_minor": 5000000, "needs_afa_each_debit": false}, "upi_autopay": {"max_mandate_amount_minor": 1500000, "needs_afa_each_debit": true}}';
      const make = async (key: keyof typeof cfg, lender: string, masked: string, rails: string) => {
        const r = await c.query<{ id: string }>(
          `select pg_temp.sample_config($1::uuid, $2::uuid, $3, $4::jsonb)::text as id`,
          [lender, randomUUID(), masked, rails],
        );
        cfg[key] = r.rows[0]?.id ?? '';
      };
      await make('P', ids.lenderP, 'XXXXXX1111', rail);
      await make('Q', ids.lenderQ, 'XXXXXX2222', '{}');
      await make('R', ids.lenderR, 'XXXXXX3333', '{}');
      await make('N', ids.lenderN, 'XXXXXX4444', '{}');
    });
    paymentPorts.set(cfg.P, paymentPortP);
    paymentPorts.set(cfg.N, paymentPortN);
    mandatePorts.set(cfg.P, mandatePortP);
    // Lender Q has every switch off, but a working provider is registered for it: if any job asked it anything, the spies would show.
    paymentPorts.set(cfg.Q, {
      ...paymentFailure,
      getOrderStatus: (ctx, query) => {
        calls.orderLookups.push(query.operationKey);
        return paymentFailure.getOrderStatus(ctx, query);
      },
      fetchSettlements: (ctx, date) => {
        calls.settlementFetches.push({ config: cfg.Q, date });
        return paymentFailure.fetchSettlements(ctx, date);
      },
    });
    mandatePorts.set(cfg.Q, {
      ...mandateMock,
      getMandateStatus: (ctx, query) => {
        calls.mandateStatus.push(query.operationKey);
        return mandateMock.getMandateStatus(ctx, query);
      },
      listDebitStatus: (_ctx, query) => {
        calls.debitLists.push(query.providerMandateRef);
        return Promise.resolve({ outcome: 'ok' as const, value: [] });
      },
    });

    borrower.b1 = await scalar<string>(
      `select id::text as v from identity.borrowers where user_id = $1::uuid`,
      [ids.b1],
    );
    borrower.b2 = await scalar<string>(
      `select id::text as v from identity.borrowers where user_id = $1::uuid`,
      [ids.b2],
    );

    // 3. loans, schedules, intents and mandates, built directly (replica mode), then committed
    const order = async (port: PaymentProviderPort, intentId: string, amount: bigint) => {
      const result = await port.createOrder(
        { tenantId: ids.lenderP, correlationId: intentId, idempotencyKey: intentId },
        {
          operationKey: intentId,
          receiptRef: intentId,
          merchantRef: 'SAMPLE-MERCHANT',
          amountMinor: amount,
          currency: 'INR',
          purpose: 'installment',
          expiresAt: null,
        },
      );
      if (result.outcome !== 'ok') throw new Error('the mock refused an order');
      return result.value.orderRef;
    };
    const orderRef = {
      old: await order(paymentFailure, intent.old, 500_000n),
      held: await order(paymentSuccess, intent.held, 500_000n),
      young: await order(paymentFailure, intent.young, 500_000n),
      recent: await order(paymentFailure, intent.recent, 500_000n),
      rec: await order(settlementMock, intent.rec, 750_000n),
      linkOk: await order(paymentFailure, intent.linkOk, 500_000n),
      linkOld: await order(paymentFailure, intent.linkOld, 500_000n),
      linkOrphan: await order(paymentFailure, intent.linkOrphan, 500_000n),
      off: await order(paymentFailure, intent.off, 500_000n),
    };
    orderRoutes.set(intent.held, paymentSuccess);
    const mandateRef = async (id: string) => {
      const result = await mandateMock.createMandateRequest(
        { tenantId: ids.lenderP, correlationId: id, idempotencyKey: id },
        {
          operationKey: id,
          rail: 'enach_api',
          merchantRef: 'SAMPLE-MERCHANT',
          maxAmountMinor: 1_000_000n,
          currency: 'INR',
          startDate: '2026-01-01',
          endDate: '2027-12-31',
          maskedAccountRef: 'XXXXXX5555',
        },
      );
      if (result.outcome !== 'ok') throw new Error('the mock refused a mandate');
      return result.value.providerMandateRef;
    };
    const mref = {
      m10: await mandateRef(mandate.m10),
      m11: await mandateRef(mandate.m11),
      m12: await mandateRef(mandate.m12),
      m14: await mandateRef(mandate.m14),
      mc: await mandateRef(mandate.mc),
      off10: await mandateRef(mandate.off10),
      off11: await mandateRef(mandate.off11),
    };

    await transaction(async (c) => {
      await c.query(`set local session_replication_role = replica`);
      const loans: [string, string, string, string, boolean][] = [
        // id, lender, borrower, status, has a schedule and a report
        [loan.a1, ids.lenderA, borrower.b1, 'active', true],
        [loan.a2, ids.lenderA, borrower.b1, 'active', true],
        [loan.a3, ids.lenderA, borrower.b1, 'active', true],
        [loan.b1, ids.lenderB, borrower.b2, 'active', true],
        [loan.p, ids.lenderP, borrower.b1, 'active', false],
        [loan.m10, ids.lenderP, borrower.b1, 'active', false],
        [loan.m11, ids.lenderP, borrower.b1, 'active', true],
        [loan.m12, ids.lenderP, borrower.b1, 'closed', false],
        [loan.m13, ids.lenderP, borrower.b1, 'active', false],
        [loan.m14, ids.lenderP, borrower.b1, 'active', true],
        [loan.mc, ids.lenderP, borrower.b1, 'active', false],
        [loan.q, ids.lenderQ, borrower.b1, 'active', false],
      ];
      for (const [id, lender, who, status, schedule] of loans) {
        await c.query(
          `insert into servicing.loan_accounts (id, lender_org_id, application_id, borrower_id, source_system, lms_loan_ref, status, sanctioned_amount_minor)
           values ($1::uuid, $2::uuid, gen_random_uuid(), $3::uuid, 'lender_lms', $4, $5::servicing.loan_status, 5000000)`,
          [id, lender, who, `SAMPLE-LN-${id.slice(0, 8)}`, status],
        );
        if (!schedule) continue;
        const snapshot = randomUUID();
        await c.query(
          `insert into servicing.balance_snapshots (lender_org_id, loan_account_id, version, status, outstanding_principal_minor, overdue_principal_minor, overdue_interest_minor,
             penal_charges_minor, other_charges_minor, total_overdue_minor, next_due_on, next_due_minor, days_past_due, source_system, source_record_id, reported_as_of, content_sha256)
           values ($1::uuid, $2::uuid, 1, 'active', 4000000, 0, 0, 0, 0, 0, (now() at time zone 'Asia/Kolkata')::date + 1, 475000, 0, 'file_import', $3, clock_timestamp() - interval '1 hour', encode(sha256(convert_to($3, 'UTF8')), 'hex'))`,
          [lender, id, `SRC-${id}`],
        );
        await c.query(
          `insert into servicing.schedule_snapshots (id, lender_org_id, loan_account_id, version) values ($1::uuid, $2::uuid, $3::uuid, 1)`,
          [snapshot, lender, id],
        );
        // Installment 2 falls due in six days for the mandate loans (its notice is not yet due, and it is more than three days
        // from installment 1, so a debit report for installment 1 cannot be taken for installment 2), in a month for the others.
        const second = lender === ids.lenderP ? 6 : 31;
        await c.query(
          `insert into servicing.schedule_installments (snapshot_id, lender_org_id, seq, due_date, principal_minor, interest_minor) values
             ($1::uuid, $2::uuid, 1, (now() at time zone 'Asia/Kolkata')::date + 1, 400000, 75000),
             ($1::uuid, $2::uuid, 2, (now() at time zone 'Asia/Kolkata')::date + $3::int, 400000, 75000)`,
          [snapshot, lender, second],
        );
      }
      // Intents of lender P (all on loan.p, one installment number each) and one of lender Q.
      const intents: [string, string, string, string | null, number, string, number][] = [
        // id, lender, status, order ref, link expired this many minutes ago, loan, installment number
        [intent.created, ids.lenderP, 'created', null, 240, loan.p, 1],
        [intent.old, ids.lenderP, 'pending', orderRef.old, 180, loan.p, 2],
        [intent.held, ids.lenderP, 'pending', orderRef.held, 120, loan.p, 3],
        [intent.young, ids.lenderP, 'pending', orderRef.young, 60, loan.p, 4],
        [intent.recent, ids.lenderP, 'pending', orderRef.recent, 5, loan.p, 5],
        [intent.withPayment, ids.lenderP, 'pending', 'MOCK-ORDER-WITH-PAYMENT', 300, loan.p, 6],
        [intent.rec, ids.lenderP, 'succeeded', orderRef.rec, 60, loan.p, 7],
        [intent.linkOk, ids.lenderP, 'pending', orderRef.linkOk, -30, loan.p, 8],
        [intent.linkOld, ids.lenderP, 'pending', orderRef.linkOld, -30, loan.p, 9],
        [intent.linkOrphan, ids.lenderP, 'pending', orderRef.linkOrphan, -30, loan.p, 10],
        [intent.off, ids.lenderQ, 'pending', orderRef.off, 360, loan.q, 1],
      ];
      for (const [id, lender, status, ref, expiredMinutesAgo, onLoan, seq] of intents) {
        await c.query(
          `insert into payments.payment_intents (id, lender_org_id, loan_account_id, borrower_id, purpose, amount_minor, provider, provider_order_ref, idempotency_key, status, config_id, provider_mode,
             link_expires_at, target_installment_seq)
           values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'installment', $5, 'mock_gateway', $6, $7, $8::payments.intent_status, $9::uuid, 'mock', now() - make_interval(mins => $10::int), $11)`,
          [
            id,
            lender,
            onLoan,
            borrower.b1,
            id === intent.rec ? 750_000 : 500_000,
            ref,
            `pj-intent-${id}`,
            status,
            lender === ids.lenderP ? cfg.P : cfg.Q,
            expiredMinutesAgo,
            seq,
          ],
        );
      }
      // A provider payment on file for one intent: the database never expires such an intent, whatever the provider says.
      await c.query(
        `insert into payments.provider_payments (lender_org_id, config_id, provider, provider_payment_ref, order_ref, intent_id, loan_account_id, status, rank, amount_minor, currency, captured_at, first_event_id, last_event_id)
         values ($1::uuid, $2::uuid, 'mock_gateway', 'PAY-WITH-PAYMENT', 'MOCK-ORDER-WITH-PAYMENT', $3::uuid, $4::uuid, 'captured', 30, 500000, 'INR', now() - interval '5 hours', gen_random_uuid(), gen_random_uuid())`,
        [ids.lenderP, cfg.P, intent.withPayment, loan.p],
      );
      // The captured payment the reconciliation run will match to the provider's settlement item (reference MOCK-PAY-<intent>).
      await c.query(
        `insert into payments.provider_payments (lender_org_id, config_id, provider, provider_payment_ref, order_ref, intent_id, loan_account_id, status, rank, amount_minor, currency, captured_at, first_event_id, last_event_id)
         values ($1::uuid, $2::uuid, 'mock_gateway', $3, $4, $5::uuid, $6::uuid, 'captured', 30, 750000, 'INR', now() - interval '1 hour', gen_random_uuid(), gen_random_uuid())`,
        [ids.lenderP, cfg.P, `MOCK-PAY-${intent.rec}`, orderRef.rec, intent.rec, loan.p],
      );
      // Mandates. updated_at three hours back: a registration "that has stayed pending".
      const mandates: [string, string, string, string, string | null, string, string][] = [
        // id, lender, status, loan, provider reference, config, borrower
        [mandate.m10, ids.lenderP, 'registration_pending', loan.m10, mref.m10, cfg.P, borrower.b1],
        [mandate.m11, ids.lenderP, 'active', loan.m11, mref.m11, cfg.P, borrower.b1],
        [mandate.m12, ids.lenderP, 'active', loan.m12, mref.m12, cfg.P, borrower.b1],
        [mandate.m13, ids.lenderP, 'draft', loan.m13, null, cfg.P, borrower.b1],
        [mandate.m14, ids.lenderP, 'active', loan.m14, mref.m14, cfg.P, borrower.b1],
        [mandate.mc, ids.lenderP, 'active', loan.mc, mref.mc, cfg.P, borrower.b1],
        [
          mandate.off10,
          ids.lenderQ,
          'registration_pending',
          loan.q,
          mref.off10,
          cfg.Q,
          borrower.b1,
        ],
      ];
      for (const [id, lender, status, onLoan, ref, config, who] of mandates) {
        await c.query(
          `insert into payments.mandates (id, lender_org_id, config_id, borrower_id, loan_account_id, rail, status, provider, provider_mode, creditor_ref, provider_mandate_ref, max_amount_minor,
             start_date, end_date, masked_account_ref, needs_afa_each_debit, created_by, created_at, updated_at)
           values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'enach_api', $6, 'mock_gateway', 'mock', 'SAMPLE-MERCHANT', $7, 1000000, current_date - 10, current_date + 300, 'XXXXXX5555', false, $8::uuid,
             now() - interval '3 hours', now() - interval '3 hours')`,
          [id, lender, config, who, onLoan, status, ref, ids.b1],
        );
      }
      // Lender Q's second mandate is ACTIVE (on a second loan of its own), to show that debit reports are not asked for a lender whose switch is off.
      const loanQ2 = randomUUID();
      await c.query(
        `insert into servicing.loan_accounts (id, lender_org_id, application_id, borrower_id, source_system, lms_loan_ref, status, sanctioned_amount_minor)
         values ($1::uuid, $2::uuid, gen_random_uuid(), $3::uuid, 'lender_lms', $4, 'active', 5000000)`,
        [loanQ2, ids.lenderQ, borrower.b1, `SAMPLE-LN-${loanQ2.slice(0, 8)}`],
      );
      await c.query(
        `insert into payments.mandates (id, lender_org_id, config_id, borrower_id, loan_account_id, rail, status, provider, provider_mode, creditor_ref, provider_mandate_ref, max_amount_minor,
           start_date, end_date, masked_account_ref, needs_afa_each_debit, created_by, created_at, updated_at)
         values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'enach_api', 'active', 'mock_gateway', 'mock', 'SAMPLE-MERCHANT', $6, 1000000, current_date - 10, current_date + 300, 'XXXXXX5555', false, $7::uuid, now(), now())`,
        [mandate.off11, ids.lenderQ, cfg.Q, borrower.b1, loanQ2, mref.off11, ids.b1],
      );
    });
  }, 180_000);

  afterAll(async () => {
    await systemPool?.end();
    await admin?.end();
  });

  // =========================================================================================================================
  describe('reminders', () => {
    it('plans (idempotently) for the lender whose switch is on and nothing for the lender whose switch is off', async () => {
      const planned = await store.planReminders();
      expect(planned).toBeGreaterThan(0);
      expect(await store.planReminders()).toBe(0); // the second call finds nothing to add
      // Lender A: two messages (pre_due, due_day) on three channels for each loan. The sms rows exist only as suppressed placeholders.
      const rows = await reminders(loan.a1);
      expect(
        rows
          .filter((r) => r.channel === 'sms')
          .every((r) => r.status === 'suppressed' && r.suppress_reason === 'sms_not_configured'),
      ).toBe(true);
      expect(rows.filter((r) => r.channel !== 'sms').every((r) => r.status === 'planned')).toBe(
        true,
      );
      // Lender B has servicing_sync on and an approved policy but its reminders switch is off: nothing at all.
      expect(await reminders(loan.b1)).toEqual([]);
    });

    it('claims, sends in_app and push (the mock) with opaque ids only, and records every attempt as accepted, never as delivered', async () => {
      await postpone(loan.a2);
      await postpone(loan.a3);
      await makeDue(loan.a1);
      const run = periodic();
      expect(await run.run('reminders')).toBe('ran');
      const rows = await reminders(loan.a1);
      expect(rows.filter((r) => r.channel === 'in_app').map((r) => r.status)).toEqual([
        'sent',
        'sent',
      ]);
      expect(rows.filter((r) => r.channel === 'push').map((r) => r.status)).toEqual([
        'sent',
        'sent',
      ]);
      expect(rows.filter((r) => r.channel === 'sms').map((r) => r.status)).toEqual([
        'suppressed',
        'suppressed',
      ]);
      const log1 = await deliveries(loan.a1);
      expect(log1).toHaveLength(4); // nothing for sms
      expect(log1.every((d) => d.source === 'send' && d.state === 'accepted')).toBe(true);
      expect(log1.some((d) => d.state === 'delivered')).toBe(false);
      expect(log1.filter((d) => d.channel === 'sms')).toEqual([]);
      // The push channel got an id and a title key, and a borrower reference: no text, no amount, no lender name, no phone number.
      const pushIds = await q<{ id: string }>(
        `select id::text from servicing.reminders where loan_account_id = $1::uuid and channel = 'push' order by id`,
        [loan.a1],
      );
      expect(
        notifier.sent
          .map((s) => s.payload)
          .sort((x, y) => (x as { id: string }).id.localeCompare((y as { id: string }).id)),
      ).toEqual(pushIds.map((p) => ({ id: p.id, titleKey: 'reminder' })));
      expect(new Set(notifier.sent.map((s) => s.recipientRef))).toEqual(new Set([borrower.b1]));
      const wire = JSON.stringify(notifier.sent);
      for (const secret of [phones.b1, 'Alpha', 'Rs ', '475000', '4,750'])
        expect(wire).not.toContain(secret);
    });

    it('is idempotent: running again sends and records nothing more', async () => {
      const before = await deliveries(loan.a1);
      const sent = notifier.sent.length;
      await periodic().run('reminders');
      expect(await deliveries(loan.a1)).toHaveLength(before.length);
      expect(notifier.sent).toHaveLength(sent);
    });

    it('the borrower reads the wording from the database, one message per reminder; another borrower sees nothing of it', async () => {
      const mine = await asBorrower<{ kind: string; message: string; lender_display_name: string }>(
        ids.b1,
        `select kind, message, lender_display_name from servicing.my_reminders() order by kind`,
      );
      expect(mine.map((m) => m.kind)).toEqual(['due_day', 'pre_due']);
      expect(mine.every((m) => m.lender_display_name === 'Alpha')).toBe(true);
      expect(mine.find((m) => m.kind === 'pre_due')?.message).toContain('Rs 4,750.00');
      expect(await asBorrower(ids.b2, `select * from servicing.my_reminders()`)).toEqual([]);
    });

    it('a report for a claim that is no longer the worker’s is refused by the database and changes nothing; the claim token is how it knows (M40)', async () => {
      const [reminder] = await q<{ id: string; attempts: number }>(
        `select id::text, attempts from servicing.reminders
          where loan_account_id = $1::uuid and channel = 'in_app' and status = 'sent' order by id limit 1`,
        [loan.a1],
      );
      if (!reminder) throw new Error('no sent reminder to use');
      const before = await deliveries(loan.a1);
      // As if the lease ran out and another worker claimed the message a second time (token = the attempt number now).
      await transaction(async (client) => {
        await client.query(`set local session_replication_role = replica`);
        await client.query(
          `update servicing.reminders set status = 'claimed', attempts = attempts + 1, claimed_until = now() + interval '5 minutes' where id = $1::uuid`,
          [reminder.id],
        );
      });
      try {
        // The first worker's late report carries the old token.
        expect(
          await store.recordReminderAttempt(reminder.id, 'accepted', null, null, reminder.attempts),
        ).toBe('not_claimed');
        expect(await deliveries(loan.a1)).toEqual(before);
        expect(
          await scalar<string>(`select status as v from servicing.reminders where id = $1::uuid`, [
            reminder.id,
          ]),
        ).toBe('claimed');
        // A message that is not claimed at all (already sent, or stopped by a hold) is refused the same way, whatever the token.
        const [other] = await q<{ id: string; attempts: number }>(
          `select id::text, attempts from servicing.reminders
            where loan_account_id = $1::uuid and channel = 'push' and status = 'sent' order by id limit 1`,
          [loan.a1],
        );
        if (!other) throw new Error('no second sent reminder');
        expect(
          await store.recordReminderAttempt(other.id, 'accepted', null, null, other.attempts),
        ).toBe('not_claimed');
        // Any other database refusal is still an error, not a quiet answer.
        await expect(
          store.recordReminderAttempt(randomUUID(), 'accepted', null, null, 1),
        ).rejects.toMatchObject({ code: 'P0002' });
      } finally {
        await transaction(async (client) => {
          await client.query(`set local session_replication_role = replica`);
          await client.query(
            `update servicing.reminders set status = 'sent', attempts = $2::int, claimed_until = null where id = $1::uuid`,
            [reminder.id, reminder.attempts],
          );
        });
      }
    });

    it('push outside local and test answers not_configured: the reminder is suppressed (channel_not_configured), never recorded as sent', async () => {
      await makeDue(loan.a2);
      const production = periodic({
        environment: 'production',
        channels: createServiceChannels({ environment: 'production' }),
      });
      await production.run('reminders');
      const rows = await reminders(loan.a2);
      expect(rows.filter((r) => r.channel === 'in_app').map((r) => r.status)).toEqual([
        'sent',
        'sent',
      ]);
      expect(
        rows.filter((r) => r.channel === 'push').map((r) => `${r.status}:${r.suppress_reason}`),
      ).toEqual(['suppressed:channel_not_configured', 'suppressed:channel_not_configured']);
      const log2 = await deliveries(loan.a2);
      expect(log2.filter((d) => d.channel === 'push').map((d) => d.state)).toEqual([
        'not_configured',
        'not_configured',
      ]);
      expect(log2.filter((d) => d.channel === 'in_app').map((d) => d.state)).toEqual([
        'accepted',
        'accepted',
      ]);
      expect(
        notifier.sent.filter(
          (s) => (s.payload as { id: string }).id.length > 0 && s.channel === 'push',
        ),
      ).toHaveLength(2); // nothing new was sent by the mock
    });
  });

  // =========================================================================================================================
  describe('payments upkeep: the order is looked up before an intent is expired', () => {
    it('hands the resolver the configuration facts (names of secrets, the live/mock vocabulary), never a secret value', async () => {
      await periodic().run('payments_upkeep');
      const row = resolvedRows.find((r) => r.configId === cfg.P);
      expect(row).toMatchObject({
        lenderOrgId: ids.lenderP,
        provider: 'mock_gateway',
        providerMode: 'mock',
        secretRef: 'SAMPLE_SECRET',
        webhookSecretRef: 'SAMPLE_WEBHOOK_SECRET',
      });
      expect(row?.merchantRef).toMatch(/^SAMPLE-MERCHANT-/);
    });

    it('an intent the provider says was paid is NOT expired: it stays pending, a person is told, no money row is written', async () => {
      expect(await intentStatus(intent.held)).toBe('pending');
      expect(calls.orderLookups).toContain(intent.held);
      expect(await openExceptions('webhook_gap', 'intent_id', intent.held)).toBe(1);
      const exception = (
        await q<{ severity: string; owner: string }>(
          `select severity, owner from payments.reconciliation_exceptions where class = 'webhook_gap'`,
        )
      )[0];
      expect(exception).toEqual({ severity: 'warning', owner: 'platform' });
      expect(
        await scalar<number>(
          `select count(*)::int as v from payments.provider_payments where intent_id = $1::uuid`,
          [intent.held],
        ),
      ).toBe(0);
      expect(
        await scalar<string>(
          `select amount_minor::text as v from payments.payment_intents where id = $1::uuid`,
          [intent.held],
        ),
      ).toBe('500000');
    });

    it('intents the provider says were never paid are expired: failed at the provider, or no order there at all', async () => {
      expect(await intentStatus(intent.old)).toBe('expired');
      expect(await intentStatus(intent.created)).toBe('expired');
    });

    it('an intent younger than the held one waits (the expiry boundary stops at the oldest held intent), and one inside the grace is untouched', async () => {
      expect(await intentStatus(intent.young)).toBe('pending');
      expect(await intentStatus(intent.recent)).toBe('pending');
      expect(calls.orderLookups).toContain(intent.young);
      expect(calls.orderLookups).not.toContain(intent.recent); // not a candidate yet
    });

    it('an intent with a provider payment on file is never a candidate and is left to a person', async () => {
      expect(await intentStatus(intent.withPayment)).toBe('pending');
      expect(calls.orderLookups).not.toContain(intent.withPayment);
    });

    it('a lender whose payments switch is off is never asked about: no lookup for its intent, no exception', async () => {
      expect(calls.orderLookups).not.toContain(intent.off);
      expect(await openExceptions('webhook_gap', 'intent_id', intent.off)).toBe(0);
      // The database function that expires intents does not look at switches, so this stale intent is expired by it, unlooked-up.
      expect(await intentStatus(intent.off)).toBe('expired');
    });

    it('running again changes nothing (one exception, same statuses, the held intent looked up again)', async () => {
      const lookups = calls.orderLookups.filter((id) => id === intent.held).length;
      await periodic().run('payments_upkeep');
      expect(await openExceptions('webhook_gap', 'intent_id', intent.held)).toBe(1);
      expect(await intentStatus(intent.held)).toBe('pending');
      expect(await intentStatus(intent.young)).toBe('pending');
      expect(calls.orderLookups.filter((id) => id === intent.held).length).toBe(lookups + 1);
    });

    it('after the hold limit the intent is no longer held back: the database rules take over, and the exception is still open', async () => {
      await transaction(async (c) => {
        await c.query(`set local session_replication_role = replica`);
        await c.query(
          `update payments.payment_intents set link_expires_at = now() - interval '25 hours' where id = $1::uuid`,
          [intent.held],
        );
      });
      await periodic().run('payments_upkeep');
      expect(await intentStatus(intent.held)).toBe('expired');
      expect(await intentStatus(intent.young)).toBe('expired');
      expect(await openExceptions('webhook_gap', 'intent_id', intent.held)).toBe(1);
    });
  });

  // =========================================================================================================================
  describe('mandates', () => {
    it('looks a pending registration up at the provider and applies the answer through the database function', async () => {
      expect(await mandateStatus(mandate.m10)).toBe('registration_pending');
      await periodic().run('mandates');
      expect(calls.mandateStatus).toContain(mandate.m10);
      expect(await mandateStatus(mandate.m10)).toBe('active');
      const history = await q<{ source: string; to_status: string }>(
        `select source, to_status from payments.mandate_events where mandate_id = $1::uuid order by created_at`,
        [mandate.m10],
      );
      expect(history.at(-1)).toEqual({ source: 'status_lookup', to_status: 'active' });
    });

    it('never asks the provider about a lender whose mandates switch is off', async () => {
      expect(calls.mandateStatus).not.toContain(mandate.off10);
      expect(await mandateStatus(mandate.off10)).toBe('registration_pending');
      expect(calls.debitLists).not.toContain(
        await scalar<string>(
          `select provider_mandate_ref as v from payments.mandates where id = $1::uuid`,
          [mandate.off11],
        ),
      );
    });

    it('sweeps an abandoned draft, and requests the cancellation of a mandate on a closed loan (queued for the provider, not cancelled)', async () => {
      expect(await mandateStatus(mandate.m13)).toBe('cancelled');
      const m12 = (
        await q<{
          status: string;
          cancel_reason: string | null;
          cancel_requested_at: string | null;
        }>(
          `select status, cancel_reason, cancel_requested_at::text from payments.mandates where id = $1::uuid`,
          [mandate.m12],
        )
      )[0];
      expect(m12?.status).toBe('active'); // cancelled only when the provider confirms it
      expect(m12?.cancel_reason).toBe('loan_closed');
      expect(
        await scalar<number>(
          `select count(*)::int as v from ops.outbox_events where event_type = 'mandate.cancel' and payload ->> 'mandate_id' = $1`,
          [mandate.m12],
        ),
      ).toBe(1);
    });

    it('plans one debit per upcoming installment with a notice for each, and sends the due notice on in_app and push with opaque ids only', async () => {
      const debits = await q<{ installment_seq: number; amount_minor: string; status: string }>(
        `select installment_seq, amount_minor::text, status from payments.mandate_debits where mandate_id = $1::uuid and planned order by installment_seq`,
        [mandate.m11],
      );
      expect(debits).toEqual([
        { installment_seq: 1, amount_minor: '475000', status: 'notified' }, // its notice was due (late) and was sent
        { installment_seq: 2, amount_minor: '475000', status: 'scheduled' }, // its notice is not due yet
      ]);
      const notices = await q<{
        seq: number;
        status: string;
        delivery_state: string | null;
        sent: boolean;
      }>(
        `select d.installment_seq as seq, n.status, n.delivery_state, n.sent_at is not null as sent
           from payments.pre_debit_notices n join payments.mandate_debits d on d.id = n.debit_id where n.mandate_id = $1::uuid order by d.installment_seq`,
        [mandate.m11],
      );
      expect(notices[0]).toEqual({
        seq: 1,
        status: 'late',
        delivery_state: 'accepted',
        sent: true,
      }); // late stays recorded as late, and is sent
      expect(notices[1]).toEqual({ seq: 2, status: 'planned', delivery_state: null, sent: false });
      const sentNotices = notifier.sent.filter(
        (s) => (s.payload as { titleKey?: string }).titleKey === 'payment_update',
      );
      expect(sentNotices.length).toBeGreaterThan(0);
      for (const message of sentNotices) {
        expect(Object.keys(message.payload).sort()).toEqual(['id', 'titleKey']);
        expect(message.recipientRef).toBe(borrower.b1);
      }
      expect(JSON.stringify(sentNotices)).not.toContain('475000');
    });

    it('a notice that becomes due is claimed once and recorded as accepted (never delivered)', async () => {
      await transaction(async (c) => {
        await c.query(`set local session_replication_role = replica`);
        await c.query(
          `update payments.pre_debit_notices set notice_due_at = now() - interval '1 minute' where mandate_id = $1::uuid and status = 'planned'`,
          [mandate.m11],
        );
      });
      await periodic().run('mandates');
      const notice = (
        await q<{ status: string; delivery_state: string | null }>(
          `select n.status, n.delivery_state from payments.pre_debit_notices n join payments.mandate_debits d on d.id = n.debit_id where n.mandate_id = $1::uuid and d.installment_seq = 2`,
          [mandate.m11],
        )
      )[0];
      expect(notice).toEqual({ status: 'sent', delivery_state: 'accepted' });
      const before = notifier.sent.length;
      await periodic().run('mandates');
      expect(notifier.sent).toHaveLength(before); // already sent: not claimed again
    });

    it('a notice no channel can carry is recorded as not_configured: the lender is told and the debit stays un-notified', async () => {
      // Lender P's other active mandate (m14) had its notice planned in the same runs; here no channel works.
      await transaction(async (c) => {
        await c.query(`set local session_replication_role = replica`);
        await c.query(
          `update payments.pre_debit_notices set notice_due_at = now() - interval '1 minute', claimed_until = null, sent_at = null, status = 'planned', delivery_state = null where mandate_id = $1::uuid`,
          [mandate.m14],
        );
        await c.query(
          `update payments.mandate_debits set status = 'scheduled', rank = 10 where mandate_id = $1::uuid`,
          [mandate.m14],
        );
      });
      const none = periodic({
        channels: {
          in_app: {
            descriptor: { key: 'in_app_down', capability: 'notification', mode: 'production' },
            send: () => Promise.resolve({ state: 'not_configured' as const }),
          },
          push: createServiceChannels({ environment: 'production' }).push,
        },
      });
      await none.run('mandates');
      const notices = await q<{ status: string; delivery_state: string | null; sent: boolean }>(
        `select status, delivery_state, sent_at is not null as sent from payments.pre_debit_notices where mandate_id = $1::uuid`,
        [mandate.m14],
      );
      expect(notices.length).toBeGreaterThan(0);
      expect(
        notices.every((n) => n.status === 'late' && n.delivery_state === null && !n.sent),
      ).toBe(true);
      expect(
        await scalar<number>(
          `select count(*)::int as v from payments.mandate_debits where mandate_id = $1::uuid and status = 'notified'`,
          [mandate.m14],
        ),
      ).toBe(0);
      expect(await openExceptions('mandate_notice_late')).toBeGreaterThan(0);
    });

    it('an in-app inbox that accepts is not enough: with push not configured the notice is late, the lender is told and the debit stays un-notified (A54)', async () => {
      await transaction(async (c) => {
        await c.query(`set local session_replication_role = replica`);
        await c.query(
          `update payments.pre_debit_notices set notice_due_at = now() - interval '1 minute', claimed_until = null, sent_at = null, status = 'planned', delivery_state = null where mandate_id = $1::uuid`,
          [mandate.m14],
        );
        await c.query(
          `update payments.mandate_debits set status = 'scheduled', rank = 10 where mandate_id = $1::uuid`,
          [mandate.m14],
        );
      });
      // The real channels of a deployed environment: the in-app inbox accepts anything, push is the unconfigured placeholder.
      const staging = periodic({ channels: createServiceChannels({ environment: 'production' }) });
      await staging.run('mandates');
      const notices = await q<{ status: string; delivery_state: string | null; sent: boolean }>(
        `select status, delivery_state, sent_at is not null as sent from payments.pre_debit_notices where mandate_id = $1::uuid`,
        [mandate.m14],
      );
      expect(notices.length).toBeGreaterThan(0);
      expect(
        notices.every((n) => n.status === 'late' && n.delivery_state === null && !n.sent),
      ).toBe(true);
      expect(
        await scalar<number>(
          `select count(*)::int as v from payments.mandate_debits where mandate_id = $1::uuid and status = 'notified'`,
          [mandate.m14],
        ),
      ).toBe(0);
      expect(await openExceptions('mandate_notice_late')).toBeGreaterThan(0);
    });

    it('applies an authenticated debit report to the planned debit, one call per report, and a returned debit touches no payment', async () => {
      const ref = await scalar<string>(
        `select provider_mandate_ref as v from payments.mandates where id = $1::uuid`,
        [mandate.m11],
      );
      const debit1 = (
        await q<{ scheduled_on: string; amount_minor: string }>(
          `select scheduled_on::text, amount_minor::text from payments.mandate_debits where mandate_id = $1::uuid and planned and installment_seq = 1`,
          [mandate.m11],
        )
      )[0];
      const report = (
        status: MandateDebitReport['status'],
        code: string | null,
      ): MandateDebitReport => ({
        providerDebitRef: 'SAMPLE-DEBIT-1',
        providerMandateRef: ref,
        scheduledOn: debit1?.scheduled_on ?? '',
        amountMinor: BigInt(debit1?.amount_minor ?? '0'),
        status,
        returnCode: code,
        observedAt: new Date().toISOString(),
      });
      const moneyBefore = await scalar<string>(
        `select (select count(*) from payments.provider_payments)::text || ':' || (select count(*) from payments.payment_adjustments)::text || ':' || (select count(*) from payments.payment_intents)::text as v`,
      );
      debitReports.set(ref, [report('presented', null)]);
      await periodic().run('mandates');
      const afterPresented = await q<{
        status: string;
        provider_debit_ref: string | null;
        planned: boolean;
      }>(
        `select status, provider_debit_ref, planned from payments.mandate_debits where mandate_id = $1::uuid and installment_seq = 1`,
        [mandate.m11],
      );
      expect(afterPresented).toEqual([
        { status: 'presented', provider_debit_ref: 'SAMPLE-DEBIT-1', planned: true },
      ]); // attached to the planned one, no second row
      debitReports.set(ref, [report('returned', 'R01')]);
      await periodic().run('mandates');
      const returned = (
        await q<{ status: string; return_code: string | null }>(
          `select status, return_code from payments.mandate_debits where mandate_id = $1::uuid and installment_seq = 1`,
          [mandate.m11],
        )
      )[0];
      expect(returned).toEqual({ status: 'returned', return_code: 'R01' }); // the provider's code, verbatim
      expect(
        await scalar<string>(
          `select (select count(*) from payments.provider_payments)::text || ':' || (select count(*) from payments.payment_adjustments)::text || ':' || (select count(*) from payments.payment_intents)::text as v`,
        ),
      ).toBe(moneyBefore);
    });

    it('a report about a debit that arrives again is the same debit (no duplicate row)', async () => {
      await periodic().run('mandates');
      expect(
        await scalar<number>(
          `select count(*)::int as v from payments.mandate_debits where mandate_id = $1::uuid`,
          [mandate.m11],
        ),
      ).toBe(2);
    });
  });

  // =========================================================================================================================
  describe('hand-off links', () => {
    it('purges expired links and links whose payment is no longer waiting, and keeps a valid one', async () => {
      // The system role stores a (here, dummy) ciphertext; the link itself is never in the database in clear.
      const store1 = (subject: string) =>
        systemPool.withSystem((tx) =>
          tx.query(
            `select payments.store_handoff_link('payment_intent', $1::uuid, 'v1', decode(repeat('ab', 40), 'hex'), now() + interval '2 hours')`,
            [subject],
          ),
        );
      await store1(intent.linkOk);
      await store1(intent.linkOld);
      await store1(intent.linkOrphan);
      await transaction(async (c) => {
        await c.query(`set local session_replication_role = replica`);
        await c.query(
          `update payments.handoff_links set created_at = now() - interval '2 hours', expires_at = now() - interval '1 minute' where subject_id = $1::uuid`,
          [intent.linkOld],
        );
        await c.query(
          `update payments.payment_intents set status = 'expired' where id = $1::uuid`,
          [intent.linkOrphan],
        );
      });
      // Other test files share this database and store links of their own, so only this test's three subjects are counted.
      const subjects = [intent.linkOk, intent.linkOld, intent.linkOrphan];
      const linksOfThisTest = () =>
        q<{ subject_id: string }>(
          `select subject_id::text as subject_id from payments.handoff_links where subject_id = any($1::uuid[])`,
          [subjects],
        );
      expect(await linksOfThisTest()).toHaveLength(3);
      await periodic().run('handoff_links');
      expect((await linksOfThisTest()).map((r) => r.subject_id)).toEqual([intent.linkOk]);
    });
  });

  // =========================================================================================================================
  describe('reconciliation: once per Indian day, after 20:00', () => {
    const at = (time: string) => ({ clock: () => new Date(`${istToday}T${time}+05:30`) });
    const runs = (lender: string) =>
      q<{
        run_date: string;
        run_no: number;
        counts: Record<string, number>;
        report: {
          not_reconcilable: string[];
          settled_to_non_lender: { items: number; minor: number };
        };
      }>(
        `select run_date::text, run_no, counts, report from payments.reconciliation_runs where lender_org_id = $1::uuid order by run_date, run_no`,
        [lender],
      );

    it('does nothing before 20:00 IST', async () => {
      await periodic(at('19:59:00')).run('reconciliation');
      expect(calls.settlementFetches).toEqual([]);
      expect(await runs(ids.lenderP)).toEqual([]);
    });

    it('from 20:00 IST fetches the provider report for the previous and the current date, records it, and runs; the run matches the payment to the settlement item', async () => {
      await periodic(at('20:00:00')).run('reconciliation');
      const yesterday = await scalar<string>(`select ($1::date - 1)::text as v`, [istToday]);
      expect(calls.settlementFetches.filter((f) => f.config === cfg.P).map((f) => f.date)).toEqual([
        yesterday,
        istToday,
      ]);
      const pRuns = await runs(ids.lenderP);
      // Yesterday's report was empty, today's holds one batch: both dates have a run.
      expect(pRuns.map((r) => r.run_date)).toEqual([yesterday, istToday]);
      expect(
        await scalar<number>(
          `select count(*)::int as v from payments.settlement_batches where lender_org_id = $1::uuid`,
          [ids.lenderP],
        ),
      ).toBe(1);
      const today = pRuns.find((r) => r.run_date === istToday);
      expect(today?.counts['matched_to_settlement']).toBe(1);
      expect(today?.report.settled_to_non_lender).toEqual({ items: 0, minor: 0 });
      // The amounts are stored as the provider reported them: paise, as integers.
      expect(
        await scalar<string>(
          `select gross_minor::text as v from payments.settlement_batches where lender_org_id = $1::uuid and report_date = $2::date`,
          [ids.lenderP, istToday],
        ),
      ).toBe('750000');
    });

    it('a provider that cannot report settlements is not asked; the run lists settlement as not reconcilable', async () => {
      expect(calls.settlementFetches.filter((f) => f.config === cfg.N)).toEqual([]);
      const nRuns = await runs(ids.lenderN);
      expect(nRuns.map((r) => r.run_date)).toContain(istToday);
      expect(nRuns[0]?.report.not_reconcilable).toContain('settlement_reports');
      expect(
        await scalar<number>(
          `select count(*)::int as v from payments.settlement_batches where lender_org_id = $1::uuid`,
          [ids.lenderN],
        ),
      ).toBe(0);
    });

    it('a lender the resolver cannot serve, and a lender whose switch is off, get no call and no run', async () => {
      expect(await runs(ids.lenderR)).toEqual([]);
      expect(await runs(ids.lenderQ)).toEqual([]);
      expect(
        calls.settlementFetches.filter((f) => f.config === cfg.R || f.config === cfg.Q),
      ).toEqual([]);
    });

    it('is done once the database holds the runs: a new process (no memory) the same evening fetches and runs nothing', async () => {
      const fetched = calls.settlementFetches.length;
      const before = await scalar<number>(
        `select count(*)::int as v from payments.reconciliation_runs`,
      );
      await periodic(at('21:15:00')).run('reconciliation');
      await periodic(at('23:59:00')).run('reconciliation');
      expect(calls.settlementFetches).toHaveLength(fetched);
      expect(
        await scalar<number>(`select count(*)::int as v from payments.reconciliation_runs`),
      ).toBe(before);
    });

    it('keeps a lender in the daily run after its configuration is suspended or retired, while it has recent payments or settlement batches; drops it when it has none in the window (A43)', async () => {
      const covered = async () => (await store.activeCollectionConfigs()).map((c) => c.configId);
      const setStatus = (status: 'active' | 'suspended' | 'retired') =>
        transaction(async (c) => {
          await c.query(`set local session_replication_role = replica`);
          await c.query(
            `update payments.lender_payment_configs set status = $2, status_changed_at = now(), status_reason = 'SAMPLE fixture status' where id = $1::uuid`,
            [cfg.P, status],
          );
        });
      // Shifts what lender P has taken and reported by whole days (the append-only protections are bypassed for the fixture only).
      const shift = (days: number) =>
        transaction(async (c) => {
          await c.query(`set local session_replication_role = replica`);
          await c.query(
            `update payments.provider_payments set created_at = created_at + make_interval(days => $2), captured_at = captured_at + make_interval(days => $2) where config_id = $1::uuid`,
            [cfg.P, days],
          );
          await c.query(
            `update payments.settlement_batches set report_date = report_date + $2::integer where config_id = $1::uuid`,
            [cfg.P, days],
          );
        });
      expect(await covered()).toContain(cfg.P);
      // The switch-off lender's configuration has taken no payment: it is not covered.
      expect(await covered()).not.toContain(cfg.Q);
      try {
        for (const status of ['suspended', 'retired'] as const) {
          await setStatus(status);
          // It used to drop out here, exactly when something had gone wrong with it.
          expect(await covered(), status).toContain(cfg.P);
        }
        // Its last payment and report are far outside the look-back window: nothing is in flight, so it drops out.
        await shift(-(RECONCILIATION_LOOKBACK_DAYS + 10));
        expect(await covered()).not.toContain(cfg.P);
        // Active with the switch on, it is covered without any activity, as before.
        await setStatus('active');
        expect(await covered()).toContain(cfg.P);
      } finally {
        await shift(RECONCILIATION_LOOKBACK_DAYS + 10);
        await setStatus('active');
      }
    });

    it('the run never writes a money row', async () => {
      expect(
        await scalar<number>(`select count(*)::int as v from payments.payment_adjustments`),
      ).toBe(0);
    });
  });

  // =========================================================================================================================
  describe('payment configuration revalidation', () => {
    it('suspends a configuration that is no longer valid and leaves the valid ones active', async () => {
      await transaction(async (c) => {
        await c.query(`set local session_replication_role = replica`);
        await c.query(
          `update payments.merchant_registry set status = 'revoked', revoked_by = $2::uuid, revoked_at = now(), revoked_reason = 'SAMPLE fixture: merchant revoked'
            where id = (select merchant_registry_id from payments.lender_payment_configs where id = $1::uuid)`,
          [cfg.R, ids.switchDecider],
        );
      });
      const status = (id: string) =>
        scalar<string>(
          `select status as v from payments.lender_payment_configs where id = $1::uuid`,
          [id],
        );
      expect(await status(cfg.R)).toBe('active');
      await periodic().run('payment_configs');
      expect(await status(cfg.R)).toBe('suspended');
      expect(await status(cfg.P)).toBe('active');
      expect(await status(cfg.N)).toBe('active');
    });
  });

  // =========================================================================================================================
  describe('servicing event handlers, run by the real outbox worker', () => {
    const worker = () =>
      new OutboxWorker({
        store: createPgOutboxStore(systemPool),
        handlers: createServicingHandlers({ pool: systemPool, log }),
        workerId: `pj-test-${randomUUID().slice(0, 8)}`,
        log,
        concurrency: 100,
      });
    const eventByKey = (key: string) =>
      q<{ status: string; last_error_code: string | null }>(
        `select status::text, last_error_code from ops.outbox_events where dedupe_key = $1`,
        [key],
      );

    it('servicing.loan_closed: the closure enqueues the event, and the handler suppresses the planned reminders and requests the mandate cancellation', async () => {
      // A real transition, not a replica insert: the database opens the closure record and enqueues the event.
      await q(`update servicing.loan_accounts set status = 'closed' where id = any($1::uuid[])`, [
        [loan.a3, loan.mc],
      ]);
      expect(await eventByKey(`servicing.loan_closed:${loan.a3}`)).toHaveLength(1);
      expect(await eventByKey(`servicing.loan_closed:${loan.mc}`)).toHaveLength(1);
      expect(
        (await reminders(loan.a3)).filter((r) => r.status === 'planned').length,
      ).toBeGreaterThan(0);
      const summary = await worker().runOnce();
      expect(summary.dead).toBe(0);
      expect(await eventByKey(`servicing.loan_closed:${loan.a3}`)).toEqual([
        { status: 'completed', last_error_code: null },
      ]);
      expect(await eventByKey(`servicing.loan_closed:${loan.mc}`)).toEqual([
        { status: 'completed', last_error_code: null },
      ]);
      const a3 = await reminders(loan.a3);
      expect(a3.filter((r) => r.status === 'planned')).toEqual([]);
      expect(
        a3
          .filter((r) => r.channel !== 'sms')
          .every((r) => r.status === 'suppressed' && r.suppress_reason === 'loan_closed'),
      ).toBe(true);
      const mc = (
        await q<{ cancel_reason: string | null }>(
          `select cancel_reason from payments.mandates where id = $1::uuid`,
          [mandate.mc],
        )
      )[0];
      expect(mc?.cancel_reason).toBe('loan_closed');
      expect(await mandateStatus(mandate.mc)).toBe('active'); // cancelled only when the provider confirms
    });

    it('servicing.import.committed and servicing.sync_conflict.opened are acknowledged, not dead-lettered; unknown fields are refused', async () => {
      const batch = randomUUID();
      const conflict = randomUUID();
      await q(
        `select ops.enqueue_event('servicing.import.committed', jsonb_build_object('batch_id', $1::uuid, 'lender_org_id', $2::uuid), null, $3)`,
        [batch, ids.lenderA, `pj-import-${batch}`],
      );
      await q(
        `select ops.enqueue_event('servicing.sync_conflict.opened', jsonb_build_object('conflict_id', $1::uuid, 'lender_org_id', $2::uuid), null, $3)`,
        [conflict, ids.lenderA, `pj-conflict-${conflict}`],
      );
      const strange = randomUUID();
      await q(
        `select ops.enqueue_event('servicing.sync_conflict.opened', jsonb_build_object('conflict_id', $1::uuid, 'lender_org_id', $2::uuid, 'unexpected', 1), null, $3)`,
        [strange, ids.lenderA, `pj-strange-${strange}`],
      );
      await worker().runOnce();
      expect(await eventByKey(`pj-import-${batch}`)).toEqual([
        { status: 'completed', last_error_code: null },
      ]);
      expect(await eventByKey(`pj-conflict-${conflict}`)).toEqual([
        { status: 'completed', last_error_code: null },
      ]);
      expect((await eventByKey(`pj-strange-${strange}`))[0]).toMatchObject({
        last_error_code: 'invalid_payload',
      });
    });

    it('servicing.import.committed completes the disbursement of an application whose loan the lender reported', async () => {
      const application = randomUUID();
      const request = randomUUID();
      await transaction(async (c) => {
        await c.query(`set local session_replication_role = replica`);
        const productId = randomUUID();
        const versionId = randomUUID();
        await c.query(
          `insert into lending.loan_products (id, lender_org_id, category_key, code, name, status) values ($1::uuid, $2::uuid, 'personal', 'PL-PJ', 'A Personal Loan', 'active')`,
          [productId, ids.lenderA],
        );
        await c.query(
          `insert into lending.loan_product_versions (id, product_id, lender_org_id, version, status, min_amount_minor, max_amount_minor, min_tenure_days, max_tenure_days, rate_type, min_annual_rate_bps, max_annual_rate_bps, drafted_by, approved_by, approved_at, effective_from)
           values ($1::uuid, $2::uuid, $3::uuid, 1, 'approved', 1000000, 50000000, 180, 1825, 'fixed', 1400, 2400, $4::uuid, $5::uuid, now(), now())`,
          [versionId, productId, ids.lenderA, ids.switchRequester, ids.switchDecider],
        );
        await c.query(
          `insert into lending.loan_requests (id, borrower_id, category_key, requested_amount_minor, requested_tenure_days, purpose_code, status) values ($1::uuid, $2::uuid, 'personal', 5000000, 365, 'education', 'submitted')`,
          [request, borrower.b1],
        );
        await c.query(
          `insert into lending.applications (id, lender_org_id, loan_request_id, borrower_id, product_version_id, status, requested_amount_minor, requested_tenure_days, lender_reference)
           values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'disbursement_pending', 5000000, 365, $6)`,
          [
            application,
            ids.lenderA,
            request,
            borrower.b1,
            versionId,
            `SAMPLE-APP-${application.slice(0, 8)}`,
          ],
        );
        await c.query(
          `insert into servicing.loan_accounts (id, lender_org_id, application_id, borrower_id, source_system, lms_loan_ref, status, sanctioned_amount_minor, disbursed_at, disbursement_reference, disbursed_amount_minor)
           values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'lender_lms', $5, 'active', 5000000, now(), 'SAMPLE-UTR-1', 5000000)`,
          [
            randomUUID(),
            ids.lenderA,
            application,
            borrower.b1,
            `SAMPLE-LN-${application.slice(0, 8)}`,
          ],
        );
      });
      const batch = randomUUID();
      await q(
        `select ops.enqueue_event('servicing.import.committed', jsonb_build_object('batch_id', $1::uuid, 'lender_org_id', $2::uuid), null, $3)`,
        [batch, ids.lenderA, `pj-disb-${batch}`],
      );
      expect(
        await scalar<string>(
          `select status::text as v from lending.applications where id = $1::uuid`,
          [application],
        ),
      ).toBe('disbursement_pending');
      await worker().runOnce();
      expect(await eventByKey(`pj-disb-${batch}`)).toEqual([
        { status: 'completed', last_error_code: null },
      ]);
      expect(
        await scalar<string>(
          `select status::text as v from lending.applications where id = $1::uuid`,
          [application],
        ),
      ).toBe('disbursed');
    });
  });

  // =========================================================================================================================
  describe('nothing personal in a log line or a stored reference', () => {
    it('no phone number, account-shaped number, link, lender name or token reached the logs, the outbox or the exception queue', async () => {
      expect(logLines.length).toBeGreaterThan(0);
      const text = logLines.join('\n');
      for (const secret of [
        phones.b1,
        phones.b2,
        'https://',
        'mock-checkout',
        'mock-mandate',
        'Alpha Finance',
        'SAMPLE_SECRET',
        'XXXXXX',
      ]) {
        expect(text).not.toContain(secret);
      }
      // Ids are random UUIDs whose last group can be twelve digits by chance, so they are removed before the digit-run checks.
      const withoutIds = text.replace(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
        '',
      );
      expect(withoutIds).not.toMatch(/\b[6-9][0-9]{9}\b/);
      expect(withoutIds).not.toMatch(/\b[0-9]{9,18}\b/);
      const tables = [
        'ops.outbox_events',
        'payments.reconciliation_exceptions',
        'servicing.reminder_deliveries',
        'payments.pre_debit_notices',
        'audit.events',
      ];
      for (const table of tables) {
        const leaked = await scalar<number>(
          `select count(*)::int as v from ${table} t where t::text like any(array[$1, $2, '%https://%', '%mock-checkout%', '%mock-mandate%'])`,
          [`%${phones.b1}%`, `%${phones.b2}%`],
        );
        expect(leaked, table).toBe(0);
      }
    });
  });
});
