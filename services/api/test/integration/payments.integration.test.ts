// Phase 08a borrower payments and mandates over HTTP, against a REAL migrated Postgres (same gating as the other integration files:
// INTEGRATION_ADMIN_URL, INTEGRATION_API_URL and INTEGRATION_SYSTEM_URL, and a freshly migrated database). Synthetic data only.
//
// Fixtures are built the way the pgTAP suites and the worker integration test build them: a lender with an approved format rule, a
// verified registry entry and settlement account, a registered provider and merchant, a two-person ACTIVE payment configuration in
// the labelled mock mode, the activation switches, reported balance figures and a schedule. Payment requests and mandates are then
// created through the real HTTP routes and the real SQL functions. What the system role does in production (record the order, store
// the sealed link, record the hand-off, look a mandate up) is done through the real system functions as the system login, and a few
// rows that only a provider event can create (a provider payment, a lender receipt, debits) are planted as the table owner with
// triggers and foreign keys switched off for that transaction only.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import {
  createMockIntegrityVerifier,
  createMockSmsSender,
  openHandoffLink,
  parseHandoffKeyring,
  sealHandoffLink,
  type HandoffKeyring,
  type HandoffKind,
  type MockMandateProvider,
  type MockPaymentProvider,
} from '@udofin/adapters';
import {
  BP_DEBIT_STATUSES,
  BP_MANDATE_RAILS,
  BP_MANDATE_STATUSES,
  BP_NOTICE_STATUSES,
  BP_PAYMENT_PURPOSES,
  BP_PAYMENT_STATUSES,
  BP_RETURN_CLASSES,
  BpHandoffLink,
  BpMandate,
  BpMandateDebitList,
  BpMandateList,
  BpMandateOptions,
  BpPaymentCancelled,
  BpPaymentDetail,
  BpPaymentOptions,
} from '@udofin/contracts';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app.js';
import { TokenError, type TokenVerifier } from '../../src/auth/token-verifier.js';
import { loadConfig } from '../../src/config.js';
import { createUserContext } from '../../src/db/user-context.js';
import { createSystemPool, type SystemPool } from '../../src/system/pool.js';
import {
  OutboxWorker,
  type OutboxEvent,
  type OutboxStore,
  type WorkerLogger,
} from '../../src/workers/outbox-worker.js';
import { createPaymentsHandlers } from '../../src/workers/payments-handlers.js';
import { createPgOutboxStore } from '../../src/workers/pg-outbox-store.js';
import {
  createProviderResolver,
  type PaymentConfigRow,
} from '../../src/workers/provider-resolver.js';

const ADMIN = process.env.INTEGRATION_ADMIN_URL;
const API = process.env.INTEGRATION_API_URL;
const SYSTEM = process.env.INTEGRATION_SYSTEM_URL;
const enabled = Boolean(ADMIN && API && SYSTEM);

const fakeVerifier: TokenVerifier = {
  verify(header) {
    const match = /^Bearer test\.([0-9a-f-]{36})\.(aal1|aal2)$/.exec(header ?? '');
    if (!match?.[1] || !match[2]) return Promise.reject(new TokenError('invalid'));
    return Promise.resolve({ sub: match[1], aal: match[2] as 'aal1' | 'aal2', sessionId: null });
  },
};
let nextAddress = 1;
const freshAddress = () => `10.21.${(nextAddress >> 8) & 255}.${nextAddress++ & 255}`;

// A provider key of this file's own, so a provider row another integration file registered with a different kind cannot interfere.
const PROVIDER = 'mock_gateway_pb';
const RUN = randomBytes(4).toString('hex');
/** Today's date in India, in SQL (the database judges every date by it). */
const IST_TODAY = `(clock_timestamp() at time zone 'Asia/Kolkata')::date`;
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const phone = () => `91${Math.floor(1_000_000_000 + Math.random() * 8_999_999_999)}`;

// Values that must never come back in a response or a log line. They are planted in the columns that hold secrets, hashes,
// references and personal-looking values; every response and the captured log of this file is scanned for them at the end.
const CANARY = {
  secretRef: `CANARY_SECRET_REF_${RUN.toUpperCase()}`,
  webhookSecretRef: `CANARY_WEBHOOK_REF_${RUN.toUpperCase()}`,
  account: `ACCTNO${Math.floor(100_000_000 + Math.random() * 899_999_999)}`,
  bankName: `CANARY Bank ${RUN}`,
  fingerprint: `canaryfp${RUN}`.padEnd(64, '0'),
  tokenHash: sha256(`canary-token-${RUN}`),
  orderRef: `CANARYORDER${RUN}`,
};

const RAIL_LIMITS = JSON.stringify({
  enach_api: { max_mandate_amount_minor: 5_000_000, needs_afa_each_debit: false },
  upi_autopay: { max_mandate_amount_minor: 1_500_000, needs_afa_each_debit: true },
});
const RAIL_LIMITS_ENACH_ONLY = JSON.stringify({
  enach_api: { max_mandate_amount_minor: 5_000_000, needs_afa_each_debit: false },
});

interface Problem {
  code?: string;
  status?: number;
  detail?: string;
  title?: string;
  instance?: string;
}
interface LoanSpec {
  name: string;
  /** Reported next installment; null: none reported. */
  nextDue?: number | null;
  overdue?: number;
  /** How old the lender's report is. */
  ageDays?: number;
  status?: 'active' | 'closed';
  outstanding?: number;
}
interface BorrowerFixture {
  user: string;
  id: string;
  phone: string;
  loans: Record<string, string>;
}
interface LenderFixture {
  id: string;
  name: string;
  tag: string;
  merchantRef: string;
  configId: string;
  maker: string;
  checker: string;
  staff: string;
  version: string;
}

describe.skipIf(!enabled)('borrower payments and mandates over HTTP', () => {
  const keyBytes = randomBytes(32);
  const KEYRING = parseHandoffKeyring(JSON.stringify({ k1: keyBytes.toString('base64') }), 'k1');
  const OTHER_KEYRING = parseHandoffKeyring(
    JSON.stringify({ k1: randomBytes(32).toString('base64') }),
    'k1',
  );
  const sms = createMockSmsSender('test');
  const STEPUP_PEPPER = randomBytes(24).toString('hex');

  let admin: pg.Pool;
  let apiPool: pg.Pool;
  let blockedPool: pg.Pool;
  let systemPool: SystemPool;
  type App = Awaited<ReturnType<typeof buildApp>>;
  let app: App;
  let appNoKeyring: App;
  let appOtherKey: App;
  let appBlocked: App;

  let A: LenderFixture;
  let B: LenderFixture;
  let C: LenderFixture; // mandates switch off
  let D: LenderFixture; // payments switch off
  const people: Record<string, BorrowerFixture> = {};
  const loanOwner = new Map<string, BorrowerFixture>();

  /** Every response body this file received, with its route, for the final scan. */
  const seen: { url: string; body: string }[] = [];
  /** Every bearer link this file sealed, so the scans can look for them. */
  const bearerLinks: string[] = [];

  // ----------------------------------------------------------------------------------------------------------------------
  // Plumbing
  // ----------------------------------------------------------------------------------------------------------------------
  const token = (user: string, aal: 'aal1' | 'aal2' = 'aal1') => `Bearer test.${user}.${aal}`;
  type CallOptions = { key?: string | null; aal?: 'aal1' | 'aal2'; app?: App };
  const call = (
    method: 'GET' | 'POST',
    url: string,
    user: string | null,
    payload?: unknown,
    options: CallOptions = {},
  ) =>
    (options.app ?? app)
      .inject({
        method,
        url,
        remoteAddress: freshAddress(),
        headers: {
          ...(user ? { authorization: token(user, options.aal ?? 'aal1') } : {}),
          ...(method === 'POST' && options.key !== null
            ? { 'idempotency-key': options.key ?? `it-pb-${randomUUID()}` }
            : {}),
        },
        ...(payload === undefined ? {} : { payload: payload as object }),
      })
      .then((res) => {
        seen.push({ url, body: res.body });
        return res;
      });
  const get = (url: string, user: string | null, options: CallOptions = {}) =>
    call('GET', url, user, undefined, options);
  const post = (
    url: string,
    user: string | null,
    payload: unknown = {},
    options: CallOptions = {},
  ) => call('POST', url, user, payload, options);
  const problem = (res: { json: () => unknown }) => res.json() as Problem;
  const expectProblem = (
    res: { statusCode: number; json: () => unknown; body: string },
    status: number,
    code: string,
  ) => {
    expect([res.statusCode, problem(res).code], res.body).toEqual([status, code]);
  };

  const q = async <T extends pg.QueryResultRow>(sql: string, values: unknown[] = []) =>
    (await admin.query<T>(sql, values)).rows;
  const one = async <T extends pg.QueryResultRow>(sql: string, values: unknown[] = []) => {
    const row = (await q<T>(sql, values))[0];
    if (!row) throw new Error('expected a row');
    return row;
  };
  const count = async (sql: string, values: unknown[] = []) =>
    Number((await one<{ n: string }>(sql, values)).n);

  /** Runs statements as the table owner with triggers and foreign keys switched off for this transaction only. */
  async function replica(work: (c: pg.PoolClient) => Promise<void>) {
    const c = await admin.connect();
    try {
      await c.query('begin');
      await c.query('set local session_replication_role = replica');
      await work(c);
      await c.query('commit');
    } catch (error) {
      await c.query('rollback');
      throw error;
    } finally {
      c.release();
    }
  }
  const dayPlus = async (n: number) =>
    (
      await one<{ d: string }>(
        `select to_char((clock_timestamp() at time zone 'Asia/Kolkata')::date + $1::int, 'YYYY-MM-DD') as d`,
        [n],
      )
    ).d;

  /** What the worker would do after an order exists: seal the link under the keyring and store only the ciphertext. */
  async function storeLink(
    kind: HandoffKind,
    subject: string,
    lender: string,
    link: string,
    keyring: HandoffKeyring | undefined = KEYRING,
    expiresInMinutes = 60,
  ) {
    if (!keyring) throw new Error('keyring');
    bearerLinks.push(link);
    const sealed = sealHandoffLink(
      keyring,
      { kind, subjectId: subject, lenderOrgId: lender },
      link,
    );
    await systemPool.withSystem((c) =>
      c.query(
        `select payments.store_handoff_link($1, $2::uuid, $3, $4, clock_timestamp() + make_interval(mins => $5::int))`,
        [kind, subject, sealed.keyVersion, sealed.ciphertext, expiresInMinutes],
      ),
    );
  }
  /** The system records an order for the payment (created to pending), as the worker does. */
  const recordOrder = (intent: string, minutes = 60) =>
    systemPool.withSystem((c) =>
      c.query(
        `select payments.record_order_created($1::uuid, $2, clock_timestamp() + make_interval(mins => $3::int))`,
        [intent, `CANARYORDER-${intent}`.slice(0, 80), minutes],
      ),
    );
  const mandateLifecycle = {
    handoff: (mandate: string) =>
      systemPool.withSystem((c) =>
        c.query(
          `select payments.record_mandate_handoff($1::uuid, 'handoff', $2, clock_timestamp() + interval '2 hours')`,
          [mandate, `PROVIDER-MANDATE-${mandate}`.slice(0, 120)],
        ),
      ),
    lookup: (mandate: string, status: string) =>
      systemPool.withSystem((c) =>
        c.query(`select payments.apply_mandate_lookup($1::uuid, $2, null, clock_timestamp())`, [
          mandate,
          status,
        ]),
      ),
  };

  /** A verified step-up code bound to a mandate id, planted directly (the real endpoints are exercised in their own test). */
  const plantStepUp = (borrowerId: string, mandateId: string) =>
    q(
      `insert into identity.stepup_challenges (id, borrower_id, action, context_ref, code_hash, status, delivery_status, expires_at, verified_at, verified_until)
       values (gen_random_uuid(), $1, 'mandate_creation', $2, repeat('a', 64), 'verified', 'accepted', now() + interval '10 minutes', now(), now() + interval '10 minutes')`,
      [borrowerId, mandateId],
    );
  const stepUpOpen = (mandateId: string) =>
    count(
      `select count(*) as n from identity.stepup_challenges where context_ref = $1 and action = 'mandate_creation' and consumed_at is null`,
      [mandateId],
    );

  // ----------------------------------------------------------------------------------------------------------------------
  // Fixtures
  // ----------------------------------------------------------------------------------------------------------------------
  async function buildLender(
    name: string,
    features: readonly string[],
    railLimits: string,
  ): Promise<LenderFixture> {
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
    if (
      !maker ||
      !checker ||
      !submitter ||
      !switchRequester ||
      !switchDecider ||
      !productMaker ||
      !productApprover
    )
      throw new Error('ids');
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
      ])
        await c.query(
          `insert into auth.users (id, raw_app_meta_data) values ($1, '{"actor_type":"staff"}')`,
          [u],
        );
      await c.query(
        `insert into tenancy.organizations (id, kind, legal_name, display_name, regulator_registration_no, status) values ($1, 'lender', $2, $3, $4, 'active')`,
        [id, `${name} PB Ltd (test)`, name, `IT-PB-${tag}`],
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
             values ($6, 1, 'XXXXXX0000', 'IN', 'sample_fixture', $2, true, 'lender', $1,
                     'SAMPLE Lender Ltd (fixture)', array['repayment_settlement'], 'verified', 'SAMPLE-EVIDENCE-1', current_date - 30, $3, $4, $5, now())
             returning id`,
          [
            id,
            rule,
            maker,
            `sample-pb-registry-${tag}`,
            checker,
            sha256(`${CANARY.fingerprint}-${id}`),
          ],
        )
      ).rows[0]?.id;
      const settlement = randomUUID();
      await c.query(
        `insert into tenancy.lender_settlement_accounts (id, lender_org_id, label, bank_name, masked_account_ref, status, registry_id, verified_by, verified_at)
           values ($1, $2, $3, $4, 'XXXXXX0000', 'verified', $5, $6, now())`,
        [settlement, id, `SAMPLE ${CANARY.account}`, CANARY.bankName, registry, maker],
      );
      await c.query(
        `insert into payments.provider_register (provider, display_name, kind, status, authorisation_evidence_ref)
           values ($1, 'SAMPLE provider (fixture)', 'payment_and_mandate', 'approved', 'SAMPLE-AUTH-EVIDENCE-1') on conflict (provider) do nothing`,
        [PROVIDER],
      );
      const version = randomUUID();
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
                                                        endpoint_token_hash, rail_limits, rail_limits_source, evidence_ref, contract_section_ref, idempotency_key, drafted_by)
             values ($1, $2, 'mock', $3, $4, $5, $6, $7, $8::jsonb, 'SAMPLE copy of provider documentation (fixture)',
                     'SAMPLE-EVIDENCE-2', 'SAMPLE-CONTRACT-1', $9, $10) returning id`,
          [
            id,
            PROVIDER,
            merchant,
            settlement,
            CANARY.secretRef,
            CANARY.webhookSecretRef,
            sha256(`${CANARY.tokenHash}-${id}`),
            railLimits,
            `sample-pb-config-${tag}`,
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
      for (const feature of features) {
        const request = (
          await c.query<{ id: string }>(
            `insert into servicing.feature_change_requests (lender_org_id, feature, enable, mode, status, evidence, requested_by, idempotency_key, decided_by, decided_at, applied_at)
               values ($1, $2, true, 'two_person', 'applied', '{"contract_ref":"SAMPLE-PB"}', $3, $4, $5, now(), now()) returning id`,
            [id, feature, switchRequester, `it-pb-req-${feature}-${tag}`, switchDecider],
          )
        ).rows[0]?.id;
        await c.query(
          `insert into servicing.lender_features (lender_org_id, feature, enabled, evidence, enabled_by, enabled_at, last_change_request_id)
             values ($1, $2, true, '{"contract_ref":"SAMPLE-PB"}', $3, now(), $4)`,
          [id, feature, switchDecider, request],
        );
      }
      const product = randomUUID();
      await c.query(
        `insert into lending.loan_products (id, lender_org_id, category_key, code, name, status) values ($1, $2, 'personal', $3, 'PB Personal Loan', 'active')`,
        [product, id, `PB-${tag.slice(0, 6).toUpperCase()}`],
      );
      await c.query(
        `insert into lending.loan_product_versions (id, product_id, lender_org_id, version, status, min_amount_minor, max_amount_minor, min_tenure_days, max_tenure_days,
           rate_type, min_annual_rate_bps, max_annual_rate_bps, drafted_by, approved_by, approved_at, effective_from)
           values ($1, $2, $3, 1, 'approved', 1000000, 50000000, 180, 1825, 'fixed', 1400, 2400, $4, $5, now(), now())`,
        [version, product, id, productMaker, productApprover],
      );
      await c.query('commit');
      return { id, name, tag, merchantRef, configId, maker, checker, staff: productMaker, version };
    } catch (error) {
      await c.query('rollback');
      throw error;
    } finally {
      c.release();
    }
  }

  /** A borrower of the lender with active loans (reported figures and a schedule), optionally with a device-integrity result. */
  async function addBorrower(
    lender: LenderFixture,
    label: string,
    specs: readonly LoanSpec[],
    attested: boolean,
  ): Promise<BorrowerFixture> {
    const user = randomUUID();
    const borrowerPhone = phone();
    const c = await admin.connect();
    try {
      await c.query('begin');
      await c.query(`select set_config('udofin.allow_mock_providers', 'on', true)`);
      await c.query(`insert into auth.users (id, phone, raw_app_meta_data) values ($1, $2, '{}')`, [
        user,
        borrowerPhone,
      ]);
      const borrowerId = (
        await c.query<{ id: string }>('select id from identity.borrowers where user_id = $1', [
          user,
        ])
      ).rows[0]?.id;
      if (!borrowerId) throw new Error('no borrower');
      const loans: Record<string, string> = {};
      const closed: string[] = [];
      for (const [n, spec] of specs.entries()) {
        const request = randomUUID();
        const application = randomUUID();
        const loan = randomUUID();
        loans[spec.name] = loan;
        await c.query(
          `insert into lending.loan_requests (id, borrower_id, category_key, requested_amount_minor, requested_tenure_days, purpose_code, status)
             values ($1, $2, 'personal', 5000000, 365, 'education', 'submitted')`,
          [request, borrowerId],
        );
        await c.query(
          `insert into lending.applications (id, lender_org_id, loan_request_id, borrower_id, product_version_id, status, requested_amount_minor, requested_tenure_days, lender_reference)
             values ($1, $2, $3, $4, $5, 'disbursed', 5000000, 365, $6)`,
          [
            application,
            lender.id,
            request,
            borrowerId,
            lender.version,
            `SAMPLE-APP-${lender.tag}-${label}-${String(n)}`,
          ],
        );
        await c.query(
          `insert into servicing.loan_accounts (id, lender_org_id, application_id, borrower_id, source_system, lms_loan_ref, status, sanctioned_amount_minor)
             values ($1, $2, $3, $4, 'lender_lms', $5, $6::servicing.loan_status, 5000000)`,
          [
            loan,
            lender.id,
            application,
            borrowerId,
            `SAMPLE-LN-${lender.tag}-${label}-${String(n)}`,
            // A loan is closed afterwards with triggers off, so that no closure record or closure event is created.
            'active',
          ],
        );
        if (spec.status === 'closed') closed.push(loan);
        const nextDue = spec.nextDue === undefined ? 475_000 : spec.nextDue;
        await c.query(
          `insert into servicing.balance_snapshots (lender_org_id, loan_account_id, version, status, outstanding_principal_minor, total_overdue_minor, next_due_on, next_due_minor,
             days_past_due, source_system, source_record_id, reported_as_of, content_sha256)
             values ($1, $2, 1, 'active', $3, $4, case when $5::bigint is null then null else (clock_timestamp() at time zone 'Asia/Kolkata')::date + 3 end, $5,
                     $6, 'file_import', $7, clock_timestamp() - make_interval(days => $8::int, hours => 1), $9)`,
          [
            lender.id,
            loan,
            spec.outstanding ?? 4_000_000,
            spec.overdue ?? 0,
            nextDue,
            (spec.overdue ?? 0) > 0 ? 12 : 0,
            `SRC-${lender.tag}-${label}-${String(n)}`,
            spec.ageDays ?? 0,
            sha256(`snap-${loan}`),
          ],
        );
        const snapshot = randomUUID();
        await c.query(
          `insert into servicing.schedule_snapshots (id, lender_org_id, loan_account_id, version) values ($1, $2, $3, 1)`,
          [snapshot, lender.id, loan],
        );
        await c.query(
          `insert into servicing.schedule_installments (snapshot_id, lender_org_id, seq, due_date, principal_minor, interest_minor)
             values ($1, $2, 1, (clock_timestamp() at time zone 'Asia/Kolkata')::date + 3, 400000, 75000),
                    ($1, $2, 2, (clock_timestamp() at time zone 'Asia/Kolkata')::date + 33, 400000, 75000)`,
          [snapshot, lender.id],
        );
      }
      if (attested)
        await c.query(
          `insert into identity.device_attestations (borrower_id, level, provider, verified_at, expires_at)
             values ($1, 'device', 'sample_attest', clock_timestamp(), clock_timestamp() + interval '6 hours')`,
          [borrowerId],
        );
      await c.query('commit');
      if (closed.length > 0)
        await replica(async (r) => {
          await r.query(
            `update servicing.loan_accounts set status = 'closed' where id = any($1::uuid[])`,
            [closed],
          );
        });
      const fixture = { user, id: borrowerId, phone: borrowerPhone, loans };
      for (const loan of Object.values(loans)) loanOwner.set(loan, fixture);
      return fixture;
    } catch (error) {
      await c.query('rollback');
      throw error;
    } finally {
      c.release();
    }
  }
  const person = (key: string): BorrowerFixture => {
    const p = people[key];
    if (!p) throw new Error(`no fixture person ${key}`);
    return p;
  };
  const loanOf = (key: string, name: string): string => {
    const loan = person(key).loans[name];
    if (!loan) throw new Error(`no loan ${key}/${name}`);
    return loan;
  };

  const paymentBody = (over: Record<string, unknown> = {}) => ({
    purpose: 'installment',
    amountMinor: 475_000,
    ...over,
  });
  const mandateBody = async (id: string, over: Record<string, unknown> = {}) => ({
    mandateId: id,
    rail: 'enach_api',
    maxAmountMinor: 3_000_000,
    startDate: await dayPlus(1),
    endDate: await dayPlus(365),
    maskedAccountRef: 'XXXXXX1234',
    ...over,
  });

  /** Requests a payment over HTTP and returns the id. */
  async function newPayment(
    key: string,
    loanName: string,
    over: Record<string, unknown> = {},
  ): Promise<string> {
    const res = await post(
      `/v1/loans/${loanOf(key, loanName)}/payments`,
      person(key).user,
      paymentBody(over),
    );
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ id: string }>().id;
  }
  /** Requests a mandate over HTTP (a planted verified step-up code) and returns the id. */
  async function newMandate(
    key: string,
    loanName: string,
    over: Record<string, unknown> = {},
  ): Promise<string> {
    const id = randomUUID();
    await plantStepUp(person(key).id, id);
    const res = await post(
      `/v1/loans/${loanOf(key, loanName)}/mandates`,
      person(key).user,
      await mandateBody(id, over),
    );
    expect(res.statusCode, res.body).toBe(201);
    return id;
  }

  /** Captures what the process writes to its log (pino writes to file descriptor 1) while `work` runs. */
  async function captureLog(work: () => Promise<void>): Promise<string> {
    const captured: string[] = [];
    const realWriteSync = fs.writeSync.bind(fs);
    const realWrite = fs.write.bind(fs);
    vi.spyOn(fs, 'writeSync').mockImplementation(
      (fd: number, data: unknown, ...rest: unknown[]) => {
        if (fd === 1) {
          captured.push(String(data));
          return String(data).length;
        }
        return (realWriteSync as (...a: unknown[]) => number)(fd, data, ...rest);
      },
    );
    vi.spyOn(fs, 'write').mockImplementation((fd: number, data: unknown, ...rest: unknown[]) => {
      if (fd === 1) {
        captured.push(String(data));
        const done = rest.at(-1);
        if (typeof done === 'function')
          (done as (e: null, n: number) => void)(null, String(data).length);
        return;
      }
      (realWrite as (...a: unknown[]) => void)(fd, data, ...rest);
    });
    try {
      await work();
      await new Promise((resolve) => setTimeout(resolve, 300));
    } finally {
      vi.restoreAllMocks();
    }
    return captured.join('');
  }

  const withOptions = (url: string, options: string) =>
    `${url}${url.includes('?') ? '&' : '?'}options=${encodeURIComponent(options)}`;
  const allowMock = '-c udofin.allow_mock_providers=on';

  // ----------------------------------------------------------------------------------------------------------------------
  // Set up and tear down
  // ----------------------------------------------------------------------------------------------------------------------
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: ADMIN, max: 4 });
    // The database refuses mock-mode payments and mandates in a session that does not allow mock providers; this file's API pool
    // allows them (a local or test deployment must), a second pool does NOT (to prove the guard through the routes).
    apiPool = new pg.Pool({ connectionString: withOptions(API ?? '', allowMock), max: 8 });
    blockedPool = new pg.Pool({ connectionString: API, max: 2 });
    systemPool = createSystemPool(withOptions(SYSTEM ?? '', allowMock));

    A = await buildLender(
      'Alpha',
      ['payments', 'servicing_sync', 'mandates', 'statements_noc'],
      RAIL_LIMITS,
    );
    B = await buildLender(
      'Beta',
      ['payments', 'servicing_sync', 'mandates'],
      RAIL_LIMITS_ENACH_ONLY,
    );
    C = await buildLender('Gamma', ['payments', 'servicing_sync'], RAIL_LIMITS);
    D = await buildLender('Delta', ['servicing_sync', 'mandates'], RAIL_LIMITS);

    // Lender A has a payment policy (partial payments and part-prepayments) and a mandate policy (ceiling 40,000.00).
    await q(
      `insert into payments.lender_payment_policies (lender_org_id, allow_partial_payments, min_partial_amount_minor, allow_part_prepayment, min_part_prepayment_minor,
                                                   link_validity_minutes, updated_by)
       values ($1, true, 100000, true, 500000, 60, $2)`,
      [A.id, A.maker],
    );
    await q(
      `insert into payments.lender_mandate_policies (lender_org_id, requirement, max_amount_cap_minor, pre_debit_lead_hours, updated_by)
       values ($1, 'before_first_due', 4000000, 48, $2)`,
      [A.id, A.maker],
    );

    const normal = (name: string): LoanSpec => ({ name });
    people.a1 = await addBorrower(
      A,
      'a1',
      [
        'options',
        'happy',
        'sql',
        'cancel',
        'link',
        'stage',
        'stage2',
        'foreclosure',
        'other',
        'again',
        'worker',
      ].map(normal),
      true,
    );
    people.a3 = await addBorrower(
      A,
      'a3',
      [
        normal('refusals'),
        { name: 'overdue', overdue: 950_000 },
        { name: 'stale', ageDays: 30 },
        { name: 'nothing', nextDue: null },
        { name: 'closed', status: 'closed' },
        normal('partial'),
        normal('conflict'),
      ],
      true,
    );
    // The second borrower of lender A: no device-integrity result until a test adds one.
    people.a2 = await addBorrower(A, 'a2', [normal('first'), normal('second')], false);
    people.a4 = await addBorrower(
      A,
      'a4',
      ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 'm10'].map(normal),
      true,
    );
    people.b1 = await addBorrower(
      B,
      'b1',
      ['one', 'two', 'three', 'four', 'five'].map(normal),
      true,
    );
    people.b2 = await addBorrower(B, 'b2', [normal('spam')], true);
    people.c1 = await addBorrower(C, 'c1', [normal('one'), normal('two')], true);
    people.d1 = await addBorrower(D, 'd1', [normal('one'), normal('two')], true);

    const build = (deps: Parameters<typeof buildApp>[1]) =>
      buildApp(loadConfig({ APP_ENV: 'test' }), deps);
    const borrower = {
      sms,
      integrity: createMockIntegrityVerifier('test'),
      stepUpPepper: STEPUP_PEPPER,
      smsTimeoutMs: 2000,
    };
    const auth = { verifier: fakeVerifier, context: createUserContext(apiPool) };
    app = await build({ auth, borrower, ...(KEYRING ? { handoff: KEYRING } : {}) });
    appNoKeyring = await build({ auth, borrower });
    appOtherKey = await build({
      auth,
      borrower,
      ...(OTHER_KEYRING ? { handoff: OTHER_KEYRING } : {}),
    });
    appBlocked = await build({
      auth: { verifier: fakeVerifier, context: createUserContext(blockedPool) },
      borrower,
      ...(KEYRING ? { handoff: KEYRING } : {}),
    });
  }, 180_000);

  afterAll(async () => {
    await Promise.all([
      app?.close(),
      appNoKeyring?.close(),
      appOtherKey?.close(),
      appBlocked?.close(),
    ]);
    // Leave nothing pending for another file's worker to trip over, and no payment row behind: the integration files share one
    // database and some assert on database-wide counts of money rows. Triggers and foreign keys are off for this one transaction
    // (the append-only triggers would refuse a delete), and every delete is scoped to this file's lenders.
    if (admin && A && B && C && D) {
      const mine = [A.id, B.id, C.id, D.id];
      const c = await admin.connect();
      try {
        await c.query('begin');
        await c.query('set local session_replication_role = replica');
        await c.query(
          `update ops.outbox_events set status = 'completed', completed_at = now(), locked_by = null, locked_until = null
            where status in ('pending', 'processing')
              and (coalesce(payload ->> 'intent_id', payload ->> 'mandate_id') in
                    (select id::text from payments.payment_intents where lender_org_id = any($1::uuid[])
                     union select id::text from payments.mandates where lender_org_id = any($1::uuid[]))
                   or payload ->> 'lender_org_id' = any($2::text[]))`,
          [mine, mine],
        );
        for (const table of [
          'payments.reconciliation_exception_events',
          'payments.reconciliation_exceptions',
          'payments.event_processing',
          'payments.payment_adjustments',
          'payments.provider_payments',
          'payments.provider_events',
          'payments.pre_debit_notices',
          'payments.mandate_debits',
          'payments.mandate_events',
          'payments.mandates',
          'payments.handoff_links',
          'payments.payment_intents',
          'payments.lender_payment_policies',
          'payments.lender_mandate_policies',
          'payments.lender_payment_configs',
          'servicing.lms_receipts',
          'servicing.foreclosure_quotes',
          'servicing.penal_charge_texts',
          'tenancy.lender_settlement_accounts',
        ])
          await c.query(`delete from ${table} where lender_org_id = any($1::uuid[])`, [mine]);
        await c.query('commit');
      } catch (error) {
        await c.query('rollback');
        throw error;
      } finally {
        c.release();
      }
    }
    await apiPool?.end();
    await blockedPool?.end();
    await systemPool?.end();
    await admin?.end();
  });

  // ======================================================================================================================
  // The contract mirrors the database
  // ======================================================================================================================
  describe('closed lists', () => {
    const checkValues = async (table: string, constraint: string) => {
      const def = await one<{ def: string }>(
        `select pg_get_constraintdef(oid) as def from pg_constraint where conrelid = $1::regclass and conname = $2`,
        [table, constraint],
      );
      return [...def.def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]).sort();
    };
    const enumValues = async (type: string) =>
      (await one<{ v: string[] }>(`select enum_range(null::${type})::text[] as v`)).v.sort();

    it('the lists in the contract are exactly the database vocabularies', async () => {
      expect([...BP_PAYMENT_PURPOSES].sort()).toEqual(await enumValues('payments.intent_purpose'));
      expect([...BP_PAYMENT_STATUSES].sort()).toEqual(await enumValues('payments.intent_status'));
      expect([...BP_MANDATE_RAILS].sort()).toEqual(
        await checkValues('payments.mandates', 'mandates_rail_check'),
      );
      expect([...BP_MANDATE_STATUSES].sort()).toEqual(
        await checkValues('payments.mandates', 'mandates_status_check'),
      );
      expect([...BP_DEBIT_STATUSES].sort()).toEqual(
        await checkValues('payments.mandate_debits', 'mandate_debits_status_check'),
      );
      expect([...BP_RETURN_CLASSES].sort()).toEqual(
        await checkValues('payments.mandate_debits', 'mandate_debits_return_class_check'),
      );
      expect([...BP_NOTICE_STATUSES].sort()).toEqual(
        await checkValues('payments.pre_debit_notices', 'pre_debit_notices_status_check'),
      );
    });

    it('the stage words are the ones the database function can answer (nothing else)', async () => {
      const def = await one<{ def: string }>(
        `select pg_get_functiondef('payments.my_payment(uuid)'::regprocedure) as def`,
      );
      const words = [...def.def.matchAll(/then '([a-z_]+)'|else '([a-z_]+)'/g)].map(
        (m) => m[1] ?? m[2],
      );
      expect([...new Set(words)].sort()).toEqual(
        ['lender_posted', 'needs_attention', 'provider_received', 'started'].sort(),
      );
    });
  });

  // ======================================================================================================================
  // Who may call: every route is for a signed-in borrower
  // ======================================================================================================================
  describe('callers', () => {
    const someId = randomUUID();
    const routes: { method: 'GET' | 'POST'; url: string; body?: unknown }[] = [
      { method: 'GET', url: `/v1/loans/${someId}/payment-options` },
      { method: 'POST', url: `/v1/loans/${someId}/payments`, body: paymentBody() },
      { method: 'GET', url: `/v1/payments/${someId}` },
      { method: 'GET', url: `/v1/payments/${someId}/link` },
      { method: 'POST', url: `/v1/payments/${someId}/cancel`, body: {} },
      { method: 'GET', url: `/v1/loans/${someId}/mandate-options` },
      {
        method: 'POST',
        url: `/v1/loans/${someId}/mandates`,
        body: {
          mandateId: randomUUID(),
          rail: 'enach_api',
          startDate: '2030-01-01',
          endDate: '2031-01-01',
          maskedAccountRef: 'XXXXXX1234',
        },
      },
      { method: 'GET', url: '/v1/mandates' },
      { method: 'GET', url: `/v1/mandates/${someId}` },
      { method: 'GET', url: `/v1/mandates/${someId}/link` },
      { method: 'POST', url: `/v1/mandates/${someId}/cancel`, body: {} },
      { method: 'GET', url: `/v1/mandates/${someId}/debits` },
    ];

    it('a caller with no token gets 401 on every route', async () => {
      for (const r of routes) {
        const res = await call(r.method, r.url, null, r.body);
        expect([r.url, res.statusCode]).toEqual([r.url, 401]);
        expect(problem(res).code).toMatch(/^token_/);
      }
    });

    it('a lender user (second factor passed) is told these routes are for borrowers, on every route', async () => {
      for (const r of routes) {
        const res = await call(r.method, r.url, A.staff, r.body, { aal: 'aal2' });
        expect([r.url, res.statusCode, problem(res).code]).toEqual([r.url, 403, 'borrower_only']);
      }
    });

    it('every state-changing route needs an Idempotency-Key (400 without one, 400 when shorter than 16 characters)', async () => {
      for (const r of routes.filter((x) => x.method === 'POST')) {
        const none = await call(r.method, r.url, person('a1').user, r.body, { key: null });
        expectProblem(none, 400, 'idempotency_key_required');
        const short = await call(r.method, r.url, person('a1').user, r.body, {
          key: 'aaaaaaaaaaaaaaa',
        });
        expectProblem(short, 400, 'idempotency_key_required');
      }
    });

    it('a path id that is not a uuid is a validation error before anything runs', async () => {
      expectProblem(
        await get('/v1/payments/not-a-uuid', person('a1').user),
        422,
        'validation_failed',
      );
      expectProblem(
        await get('/v1/mandates/12345/debits', person('a1').user),
        422,
        'validation_failed',
      );
    });
  });

  // ======================================================================================================================
  // What can be paid
  // ======================================================================================================================
  describe('payment options', () => {
    it('shows the lender-reported installment, the destination and nothing computed', async () => {
      const res = await get(
        `/v1/loans/${loanOf('a1', 'options')}/payment-options`,
        person('a1').user,
      );
      expect(res.statusCode, res.body).toBe(200);
      const body = BpPaymentOptions.parse(res.json());
      expect(body).toMatchObject({
        loanId: loanOf('a1', 'options'),
        lenderDisplayName: 'Alpha',
        available: true,
        unavailableKey: null,
        destinationMaskedRef: 'XXXXXX0000',
        figuresAvailable: true,
        stale: false,
        penalCharge: null,
        penalChargeTextMissing: false,
        openPayments: [],
      });
      const installment = body.purposes.find((p) => p.purpose === 'installment');
      expect(installment).toEqual({
        purpose: 'installment',
        amountSource: 'lender_reported',
        amountMinor: 475_000,
        dueOn: await dayPlus(3),
        // the lender accepts a part from 1,000.00
        minMinor: 100_000,
        maxMinor: 475_000,
      });
      expect(body.purposes.find((p) => p.purpose === 'part_prepayment')).toEqual({
        purpose: 'part_prepayment',
        amountSource: 'borrower_within_lender_limits',
        minMinor: 500_000,
        maxMinor: 4_000_000,
      });
      expect(body.purposes.map((p) => p.purpose)).toEqual(['installment', 'part_prepayment']);
      expect(body.reportedAsOf).not.toBeNull();
    });

    it('a lender without a policy offers the exact installment only', async () => {
      const res = await get(`/v1/loans/${loanOf('b1', 'one')}/payment-options`, person('b1').user);
      const body = BpPaymentOptions.parse(res.json());
      expect(body.purposes).toEqual([
        {
          purpose: 'installment',
          amountSource: 'lender_reported',
          amountMinor: 475_000,
          dueOn: await dayPlus(3),
          minMinor: 475_000,
          maxMinor: 475_000,
        },
      ]);
    });

    it('an overdue figure is offered, and the penal-charge sentence is the lender-approved one or says it is missing', async () => {
      const url = `/v1/loans/${loanOf('a3', 'overdue')}/payment-options`;
      const before = BpPaymentOptions.parse((await get(url, person('a3').user)).json());
      expect(before.purposes.find((p) => p.purpose === 'overdue')).toMatchObject({
        amountMinor: 950_000,
        amountSource: 'lender_reported',
      });
      expect(before.penalChargeTextMissing).toBe(true);
      expect(before.penalCharge).toBeNull();
      await replica(async (c) => {
        await c.query(
          `insert into servicing.penal_charge_texts (lender_org_id, version, status, charge_kind, flat_amount_minor, separate_from_interest, not_compounded, reason, sentence_en, drafted_by, approved_by, approved_at)
           values ($1, 1, 'approved', 'flat', 50000, true, true, 'Charge as per the loan agreement', 'A separate penal charge applies to the overdue amount as per your loan agreement.', $2, $3, now())`,
          [A.id, A.maker, A.checker],
        );
      });
      const after = BpPaymentOptions.parse((await get(url, person('a3').user)).json());
      expect(after.penalChargeTextMissing).toBe(false);
      expect(after.penalCharge).toEqual({
        version: 1,
        sentenceEn:
          'A separate penal charge applies to the overdue amount as per your loan agreement.',
        sentenceHi: null,
      });
    });

    it('offers a foreclosure payment equal to the lender quotation, and shows a quotation that does not add up as flagged', async () => {
      const loan = loanOf('a1', 'foreclosure');
      await replica(async (c) => {
        await c.query(
          `insert into servicing.foreclosure_quotes (lender_org_id, loan_account_id, lender_quote_ref, as_of, valid_until, principal_minor, interest_minor, charges_minor, prepayment_charge_minor, total_minor, source, reported_by)
           values ($1, $2, $3, now() - interval '1 hour', now() + interval '3 days', 4000000, 75000, 5000, 20000, 4100000, 'lender_portal', $4)`,
          [A.id, loan, `SAMPLE-Q-${RUN}-1`, A.maker],
        );
      });
      const body = BpPaymentOptions.parse(
        (await get(`/v1/loans/${loan}/payment-options`, person('a1').user)).json(),
      );
      const quote = body.purposes.find((p) => p.purpose === 'foreclosure');
      expect(quote).toMatchObject({
        amountSource: 'lender_quote',
        amountMinor: 4_100_000,
        minMinor: 4_100_000,
        maxMinor: 4_100_000,
        flagged: false,
      });
      const row = await one<{ id: string }>(
        `select id from servicing.foreclosure_quotes where loan_account_id = $1`,
        [loan],
      );
      expect(quote).toMatchObject({ quoteId: row.id });
    });

    it('offers nothing when the lender report is stale, and says why nothing can be paid on a closed loan', async () => {
      const stale = BpPaymentOptions.parse(
        (await get(`/v1/loans/${loanOf('a3', 'stale')}/payment-options`, person('a3').user)).json(),
      );
      expect(stale).toMatchObject({ available: true, stale: true, purposes: [] });
      const closed = BpPaymentOptions.parse(
        (
          await get(`/v1/loans/${loanOf('a3', 'closed')}/payment-options`, person('a3').user)
        ).json(),
      );
      expect(closed).toMatchObject({
        available: false,
        unavailableKey: 'loan_not_active',
        destinationMaskedRef: null,
        purposes: [],
      });
    });

    it('another borrower of the same lender, another lender, an unknown loan and a lender whose payments switch is off all get 404', async () => {
      const loan = loanOf('a1', 'options');
      for (const user of [person('a2').user, person('b1').user]) {
        const res = await get(`/v1/loans/${loan}/payment-options`, user);
        expectProblem(res, 404, 'not_found');
        // The refusal is the same as for a loan that does not exist.
        const unknown = await get(`/v1/loans/${randomUUID()}/payment-options`, user);
        expect(res.body.replaceAll(/"instance":"[^"]*"/g, '')).toBe(
          unknown.body.replaceAll(/"instance":"[^"]*"/g, ''),
        );
      }
      expectProblem(
        await get(`/v1/loans/${randomUUID()}/payment-options`, person('a1').user),
        404,
        'not_found',
      );
      expectProblem(
        await get(`/v1/loans/${loanOf('d1', 'one')}/payment-options`, person('d1').user),
        404,
        'not_found',
      );
    });
  });

  // ======================================================================================================================
  // Asking to pay
  // ======================================================================================================================
  describe('requesting a payment', () => {
    const state: { id: string; key: string; loan: string } = { id: '', key: '', loan: '' };

    it('creates the request as created, creates NO order in the request, and queues the order job with the id only', async () => {
      state.loan = loanOf('a1', 'happy');
      state.key = `it-pb-happy-${randomUUID()}`;
      const res = await post(`/v1/loans/${state.loan}/payments`, person('a1').user, paymentBody(), {
        key: state.key,
      });
      expect(res.statusCode, res.body).toBe(201);
      const body = BpPaymentDetail.parse(res.json());
      state.id = body.id;
      expect(body).toMatchObject({
        loanId: state.loan,
        lenderDisplayName: 'Alpha',
        purpose: 'installment',
        amountMinor: 475_000,
        status: 'created',
        stage: 'started',
        linkExpiresAt: expect.any(String) as string,
        linkAvailable: false,
        cancellable: true,
        destinationMaskedRef: 'XXXXXX0000',
        providerReceivedAt: null,
        lenderPostedOn: null,
      });
      // The row: the caller's, the lender's reported amount, no provider order yet; the key is the one sent.
      const row = await one<{
        borrower_id: string;
        status: string;
        provider_order_ref: string | null;
        amount_minor: string;
        idempotency_key: string;
        lender_org_id: string;
      }>(
        `select borrower_id, status::text as status, provider_order_ref, amount_minor::text as amount_minor, idempotency_key, lender_org_id from payments.payment_intents where id = $1`,
        [state.id],
      );
      expect(row).toEqual({
        borrower_id: person('a1').id,
        status: 'created',
        provider_order_ref: null,
        amount_minor: '475000',
        idempotency_key: state.key,
        lender_org_id: A.id,
      });
      const events = await q<{ event_type: string; payload: unknown; status: string }>(
        `select event_type, payload, status::text as status from ops.outbox_events where payload ->> 'intent_id' = $1`,
        [state.id],
      );
      expect(events).toEqual([
        { event_type: 'payment.create_order', payload: { intent_id: state.id }, status: 'pending' },
      ]);
    });

    it('the same Idempotency-Key and content replays the stored answer; a different amount under the same key is refused', async () => {
      const again = await post(
        `/v1/loans/${state.loan}/payments`,
        person('a1').user,
        paymentBody(),
        { key: state.key },
      );
      expect(again.statusCode).toBe(201);
      expect(again.headers['idempotent-replayed']).toBe('true');
      expect(again.json<{ id: string }>().id).toBe(state.id);
      expect(
        await count(
          `select count(*) as n from payments.payment_intents where idempotency_key = $1`,
          [state.key],
        ),
      ).toBe(1);

      const different = await post(
        `/v1/loans/${state.loan}/payments`,
        person('a1').user,
        paymentBody({ amountMinor: 400_000 }),
        { key: state.key },
      );
      expectProblem(different, 422, 'idempotency_key_reused');
      expect(
        await count(
          `select count(*) as n from payments.payment_intents where loan_account_id = $1`,
          [state.loan],
        ),
      ).toBe(1);
    });

    it('the database repeats the check when the stored answer is gone: same content returns the same payment, other content is a conflict', async () => {
      const key = `it-pb-sql-${randomUUID()}`;
      const loan = loanOf('a1', 'sql');
      const first = await post(`/v1/loans/${loan}/payments`, person('a1').user, paymentBody(), {
        key,
      });
      expect(first.statusCode, first.body).toBe(201);
      const id = first.json<{ id: string }>().id;
      await q(`delete from ops.idempotency_keys where idem_key = $1`, [key]);

      const replay = await post(`/v1/loans/${loan}/payments`, person('a1').user, paymentBody(), {
        key,
      });
      expect(replay.statusCode, replay.body).toBe(201);
      expect(replay.headers['idempotent-replayed']).toBeUndefined();
      expect(replay.json<{ id: string }>().id).toBe(id);
      expect(
        await count(
          `select count(*) as n from payments.payment_intents where idempotency_key = $1`,
          [key],
        ),
      ).toBe(1);

      await q(`delete from ops.idempotency_keys where idem_key = $1`, [key]);
      const conflict = await post(
        `/v1/loans/${loan}/payments`,
        person('a1').user,
        paymentBody({ amountMinor: 400_000 }),
        { key },
      );
      expectProblem(conflict, 409, 'idempotency_conflict');
      expect(
        await count(
          `select count(*) as n from payments.payment_intents where idempotency_key = $1`,
          [key],
        ),
      ).toBe(1);
    });

    it("another borrower cannot use the first borrower's key to read or change the payment", async () => {
      // The key is the first borrower's: the second borrower's request is a conflict, never the first one's payment.
      const res = await post(
        `/v1/loans/${loanOf('a2', 'first')}/payments`,
        person('a2').user,
        paymentBody(),
        { key: state.key },
      );
      expectProblem(res, 409, 'idempotency_conflict');
      expect(res.body).not.toContain(state.id);
    });

    it('a second open request for the same installment is refused until the first is cancelled or expired', async () => {
      const res = await post(`/v1/loans/${state.loan}/payments`, person('a1').user, paymentBody());
      expectProblem(res, 409, 'open_intent_exists');
    });

    it('accepts a part the lender accepts, and a part-prepayment within the lender limits', async () => {
      const part = await post(
        `/v1/loans/${loanOf('a3', 'partial')}/payments`,
        person('a3').user,
        paymentBody({ amountMinor: 100_000 }),
      );
      expect(part.statusCode, part.body).toBe(201);
      expect(BpPaymentDetail.parse(part.json())).toMatchObject({
        amountMinor: 100_000,
        purpose: 'installment',
      });
      const prepay = await post(
        `/v1/loans/${loanOf('a3', 'partial')}/payments`,
        person('a3').user,
        paymentBody({ purpose: 'part_prepayment', amountMinor: 600_000 }),
      );
      expect(prepay.statusCode, prepay.body).toBe(201);
      expect(BpPaymentDetail.parse(prepay.json())).toMatchObject({
        amountMinor: 600_000,
        purpose: 'part_prepayment',
      });
    });

    it('a foreclosure payment must equal the lender quotation and name it', async () => {
      const loan = loanOf('a1', 'foreclosure');
      const quote = await one<{ id: string }>(
        `select id from servicing.foreclosure_quotes where loan_account_id = $1`,
        [loan],
      );
      const below = await post(`/v1/loans/${loan}/payments`, person('a1').user, {
        purpose: 'foreclosure',
        amountMinor: 4_099_999,
        quoteId: quote.id,
      });
      expectProblem(below, 422, 'amount_not_allowed');
      const wrongQuote = await post(`/v1/loans/${loan}/payments`, person('a1').user, {
        purpose: 'foreclosure',
        amountMinor: 4_100_000,
        quoteId: randomUUID(),
      });
      expectProblem(wrongQuote, 409, 'quote_not_current');
      const ok = await post(`/v1/loans/${loan}/payments`, person('a1').user, {
        purpose: 'foreclosure',
        amountMinor: 4_100_000,
        quoteId: quote.id,
      });
      expect(ok.statusCode, ok.body).toBe(201);
      expect(BpPaymentDetail.parse(ok.json())).toMatchObject({
        purpose: 'foreclosure',
        amountMinor: 4_100_000,
      });
      expect(
        await one(`select quote_id from payments.payment_intents where id = $1`, [
          ok.json<{ id: string }>().id,
        ]),
      ).toEqual({
        quote_id: quote.id,
      });
    });

    it('refusals keep their meaning: each rule of the database has its own status and stable code, and nothing is stored', async () => {
      const before = await count(
        `select count(*) as n from payments.payment_intents where lender_org_id = any($1::uuid[])`,
        [[A.id, B.id, D.id]],
      );
      const a3 = person('a3').user;
      const refusals: [string, string, string, unknown, number, string][] = [
        [
          'an amount above the reported figure',
          a3,
          loanOf('a3', 'refusals'),
          paymentBody({ amountMinor: 475_001 }),
          422,
          'amount_not_allowed',
        ],
        [
          'a part below the lender minimum',
          a3,
          loanOf('a3', 'refusals'),
          paymentBody({ amountMinor: 99_999 }),
          422,
          'amount_not_allowed',
        ],
        [
          'charges are not payable yet',
          a3,
          loanOf('a3', 'refusals'),
          paymentBody({ purpose: 'charges' }),
          409,
          'purpose_not_supported',
        ],
        [
          'overdue when nothing is overdue',
          a3,
          loanOf('a3', 'refusals'),
          paymentBody({ purpose: 'overdue', amountMinor: 100_000 }),
          409,
          'nothing_due',
        ],
        [
          'foreclosure without a quotation',
          a3,
          loanOf('a3', 'refusals'),
          paymentBody({ purpose: 'foreclosure', amountMinor: 4_000_000 }),
          409,
          'quote_required',
        ],
        [
          'a quotation named for an installment',
          a3,
          loanOf('a3', 'refusals'),
          paymentBody({ quoteId: randomUUID() }),
          422,
          'bad_request',
        ],
        [
          'a part-prepayment below the lender minimum',
          a3,
          loanOf('a3', 'refusals'),
          paymentBody({ purpose: 'part_prepayment', amountMinor: 499_999 }),
          422,
          'amount_not_allowed',
        ],
        [
          'a part-prepayment above the outstanding principal',
          a3,
          loanOf('a3', 'refusals'),
          paymentBody({ purpose: 'part_prepayment', amountMinor: 4_000_001 }),
          422,
          'amount_not_allowed',
        ],
        ['stale lender figures', a3, loanOf('a3', 'stale'), paymentBody(), 409, 'stale_data'],
        ['nothing due', a3, loanOf('a3', 'nothing'), paymentBody(), 409, 'nothing_due'],
        ['a closed loan', a3, loanOf('a3', 'closed'), paymentBody(), 409, 'loan_not_active'],
        [
          'a lender with no part-prepayment policy',
          person('b1').user,
          loanOf('b1', 'one'),
          paymentBody({ purpose: 'part_prepayment', amountMinor: 600_000 }),
          409,
          'purpose_not_enabled',
        ],
        [
          'a part from a lender that accepts none',
          person('b1').user,
          loanOf('b1', 'one'),
          paymentBody({ amountMinor: 100_000 }),
          422,
          'amount_not_allowed',
        ],
        [
          'a lender whose payments switch is off',
          person('d1').user,
          loanOf('d1', 'one'),
          paymentBody(),
          409,
          'feature_disabled',
        ],
        [
          "someone else's loan (same lender)",
          person('a2').user,
          loanOf('a1', 'again'),
          paymentBody(),
          404,
          'not_found',
        ],
        [
          "someone else's loan (other lender)",
          person('b1').user,
          loanOf('a1', 'again'),
          paymentBody(),
          404,
          'not_found',
        ],
        ['a loan that does not exist', a3, randomUUID(), paymentBody(), 404, 'not_found'],
      ];
      for (const [what, user, loan, body, status, code] of refusals) {
        const res = await post(`/v1/loans/${loan}/payments`, user, body);
        expect([what, res.statusCode, problem(res).code, res.body.includes('detail')]).toEqual([
          what,
          status,
          code,
          false,
        ]);
      }
      expect(
        await count(
          `select count(*) as n from payments.payment_intents where lender_org_id = any($1::uuid[])`,
          [[A.id, B.id, D.id]],
        ),
      ).toBe(before);
    });

    it('bad input is a validation error naming fields and rules, never values', async () => {
      const loan = loanOf('a3', 'refusals');
      const bad: [string, unknown][] = [
        ['zero amount', paymentBody({ amountMinor: 0 })],
        ['negative amount', paymentBody({ amountMinor: -5 })],
        ['fractional paise', paymentBody({ amountMinor: 4750.5 })],
        ['amount as text', paymentBody({ amountMinor: '475000' })],
        ['amount above the ceiling', paymentBody({ amountMinor: 100_000_000_000_001 })],
        ['unknown purpose', paymentBody({ purpose: 'tip' })],
        ['no purpose', { amountMinor: 475_000 }],
        [
          'a field the route does not know (the caller cannot set a status)',
          paymentBody({ status: 'succeeded' }),
        ],
        ['a provider reference', paymentBody({ providerOrderRef: 'ORDER-1' })],
        [
          'a quotation that is not a uuid',
          paymentBody({ purpose: 'foreclosure', quoteId: 'nope' }),
        ],
      ];
      for (const [what, body] of bad) {
        const res = await post(`/v1/loans/${loan}/payments`, person('a3').user, body);
        expect([what, res.statusCode, problem(res).code]).toEqual([what, 422, 'validation_failed']);
        expect(res.body).not.toContain('succeeded');
        expect(res.body).not.toContain('ORDER-1');
      }
      expect(
        await count(
          `select count(*) as n from payments.payment_intents where loan_account_id = $1`,
          [loan],
        ),
      ).toBe(0);
    });

    it('a mock-mode configuration is no valid collection target in a session that does not allow mock providers: refused, nothing created', async () => {
      const res = await post(
        `/v1/loans/${loanOf('a4', 'm10')}/payments`,
        person('a4').user,
        paymentBody(),
        { app: appBlocked },
      );
      expectProblem(res, 409, 'collection_target_invalid');
      expect(
        await count(
          `select count(*) as n from payments.payment_intents where loan_account_id = $1`,
          [loanOf('a4', 'm10')],
        ),
      ).toBe(0);
    });
  });

  // ======================================================================================================================
  // One payment, and its honest stage
  // ======================================================================================================================
  describe('one payment', () => {
    it('shows the caller their payment', async () => {
      const id = await newPayment('a1', 'other');
      const res = await get(`/v1/payments/${id}`, person('a1').user);
      expect(res.statusCode, res.body).toBe(200);
      expect(BpPaymentDetail.parse(res.json())).toMatchObject({
        id,
        status: 'created',
        stage: 'started',
        cancellable: true,
        linkAvailable: false,
      });
    });

    it("another borrower of the same lender, another lender, a lender's staff and an unknown id see nothing (404 or 403, same body as unknown)", async () => {
      const id = await newPayment('a2', 'second');
      const mine = await get(`/v1/payments/${id}`, person('a2').user);
      expect(mine.statusCode).toBe(200);
      for (const user of [person('a1').user, person('b1').user]) {
        const res = await get(`/v1/payments/${id}`, user);
        expectProblem(res, 404, 'not_found');
        const unknown = await get(`/v1/payments/${randomUUID()}`, user);
        expect(res.body.replaceAll(/"instance":"[^"]*"/g, '')).toBe(
          unknown.body.replaceAll(/"instance":"[^"]*"/g, ''),
        );
      }
      expect((await get(`/v1/payments/${id}`, A.staff, { aal: 'aal2' })).statusCode).toBe(403);
    });

    it("the stage words come from the database only: provider_received after a verified provider payment, lender_posted after the lender's own receipt, needs_attention when the amount differs", async () => {
      const loan = loanOf('a1', 'stage');
      const id = await newPayment('a1', 'stage');
      const ref = `PAY-${RUN}-1`;
      await replica(async (c) => {
        await c.query(
          `insert into payments.provider_payments (id, lender_org_id, config_id, provider, provider_payment_ref, order_ref, intent_id, loan_account_id, status, rank,
                                                 amount_minor, currency, captured_at, duplicate_capture, first_event_id, last_event_id)
           values (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, 'captured', 50, 475000, 'INR', now() - interval '2 minutes', false, gen_random_uuid(), gen_random_uuid())`,
          [A.id, A.configId, PROVIDER, ref, `order_${RUN}_1`, id, loan],
        );
      });
      const received = BpPaymentDetail.parse(
        (await get(`/v1/payments/${id}`, person('a1').user)).json(),
      );
      expect(received).toMatchObject({ stage: 'provider_received', lenderPostedOn: null });
      expect(received.providerReceivedAt).not.toBeNull();
      // The intent status is untouched by a provider payment row alone: only the system moves it.
      expect(received.status).toBe('created');

      await replica(async (c) => {
        await c.query(
          `insert into servicing.lms_receipts (lender_org_id, loan_account_id, kind, lms_receipt_ref, amount_minor, value_date, bank_reference, source_system,
                                             source_record_id, reported_as_of, content_sha256)
           values ($1, $2, 'receipt', $3, 475000, current_date, $4, 'file_import', $5, now(), $6)`,
          [A.id, loan, `RCPT-${RUN}-1`, ref, `SRC-${RUN}-1`, sha256(`receipt-${RUN}-1`)],
        );
      });
      const posted = BpPaymentDetail.parse(
        (await get(`/v1/payments/${id}`, person('a1').user)).json(),
      );
      expect(posted.stage).toBe('lender_posted');
      expect(posted.lenderPostedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);

      // A provider payment of another amount needs attention.
      const id2 = await newPayment('a1', 'stage2');
      await replica(async (c) => {
        await c.query(
          `insert into payments.provider_payments (id, lender_org_id, config_id, provider, provider_payment_ref, order_ref, intent_id, loan_account_id, status, rank,
                                                 amount_minor, currency, captured_at, duplicate_capture, first_event_id, last_event_id)
           values (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, 'captured', 50, 474000, 'INR', now(), false, gen_random_uuid(), gen_random_uuid())`,
          [
            A.id,
            A.configId,
            PROVIDER,
            `PAY-${RUN}-2`,
            `order_${RUN}_2`,
            id2,
            loanOf('a1', 'stage2'),
          ],
        );
      });
      expect(
        BpPaymentDetail.parse((await get(`/v1/payments/${id2}`, person('a1').user)).json()).stage,
      ).toBe('needs_attention');
    });
  });

  // ======================================================================================================================
  // Cancelling
  // ======================================================================================================================
  describe('cancelling a payment', () => {
    it('cancels a payment that has no order yet, repeats safely, and lets the borrower ask again', async () => {
      const id = await newPayment('a1', 'cancel');
      const key = `it-pb-cancel-${randomUUID()}`;
      const res = await post(`/v1/payments/${id}/cancel`, person('a1').user, {}, { key });
      expect(res.statusCode, res.body).toBe(200);
      expect(BpPaymentCancelled.parse(res.json())).toEqual({ id, status: 'cancelled' });
      expect(
        (
          await one<{ status: string }>(
            `select status::text as status from payments.payment_intents where id = $1`,
            [id],
          )
        ).status,
      ).toBe('cancelled');
      const detail = BpPaymentDetail.parse(
        (await get(`/v1/payments/${id}`, person('a1').user)).json(),
      );
      expect(detail).toMatchObject({
        status: 'cancelled',
        cancellable: false,
        linkAvailable: false,
      });

      const replay = await post(`/v1/payments/${id}/cancel`, person('a1').user, {}, { key });
      expect(replay.headers['idempotent-replayed']).toBe('true');
      const again = await post(`/v1/payments/${id}/cancel`, person('a1').user, {});
      expect(again.statusCode, again.body).toBe(200);
      expect(BpPaymentCancelled.parse(again.json()).status).toBe('cancelled');

      // The loan has no open payment now, so a new request is allowed.
      const next = await post(
        `/v1/loans/${loanOf('a1', 'cancel')}/payments`,
        person('a1').user,
        paymentBody(),
      );
      expect(next.statusCode, next.body).toBe(201);
    });

    it('another borrower cannot cancel it (404) and it stays as it was', async () => {
      const id = await newPayment('a2', 'first');
      for (const user of [person('a1').user, person('b1').user]) {
        expectProblem(await post(`/v1/payments/${id}/cancel`, user, {}), 404, 'not_found');
      }
      expect(
        (
          await one<{ status: string }>(
            `select status::text as status from payments.payment_intents where id = $1`,
            [id],
          )
        ).status,
      ).toBe('created');
    });

    it('a payment that already has an order at the provider cannot be cancelled here (409 intent_not_cancellable)', async () => {
      const id = await newPayment('b1', 'one');
      await recordOrder(id);
      const res = await post(`/v1/payments/${id}/cancel`, person('b1').user, {});
      expectProblem(res, 409, 'intent_not_cancellable');
      expect(
        (
          await one<{ status: string }>(
            `select status::text as status from payments.payment_intents where id = $1`,
            [id],
          )
        ).status,
      ).toBe('pending');
    });

    it('an unknown payment is a 404', async () => {
      expectProblem(
        await post(`/v1/payments/${randomUUID()}/cancel`, person('a1').user, {}),
        404,
        'not_found',
      );
    });
  });

  // ======================================================================================================================
  // The provider's link
  // ======================================================================================================================
  describe('the payment link', () => {
    const state: { id: string; link: string } = { id: '', link: '' };

    it('there is no link while the payment has no order, and none for someone who does not own it', async () => {
      state.id = await newPayment('a1', 'link');
      expectProblem(
        await get(`/v1/payments/${state.id}/link`, person('a1').user),
        404,
        'not_found',
      );
    });

    it('returns exactly the link the worker sealed, once the order exists, with no-store, and counts the read', async () => {
      await recordOrder(state.id);
      state.link = `https://pay.example.test/checkout/${randomUUID()}`;
      await storeLink('payment_intent', state.id, A.id, state.link);
      const detail = BpPaymentDetail.parse(
        (await get(`/v1/payments/${state.id}`, person('a1').user)).json(),
      );
      expect(detail).toMatchObject({ status: 'pending', linkAvailable: true, cancellable: false });

      const res = await get(`/v1/payments/${state.id}/link`, person('a1').user);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.headers['cache-control']).toContain('no-store');
      const body = BpHandoffLink.parse(res.json());
      expect(body.link).toBe(state.link);
      expect(Object.keys(body).sort()).toEqual(['expiresAt', 'link']);
      expect(res.body).not.toContain('k1');
      expect(
        (
          await one<{ read_count: number }>(
            `select read_count from payments.handoff_links where subject_id = $1`,
            [state.id],
          )
        ).read_count,
      ).toBe(1);
      // What is stored is ciphertext: it holds no part of the link.
      const stored = await one<{ ciphertext: Buffer }>(
        `select ciphertext from payments.handoff_links where subject_id = $1`,
        [state.id],
      );
      expect(stored.ciphertext.includes(Buffer.from(state.link.slice(-20)))).toBe(false);
    });

    it('another borrower, another lender, a lender user and an unknown id cannot get it (404 / 403), whatever they try', async () => {
      for (const user of [person('a2').user, person('b1').user]) {
        expectProblem(await get(`/v1/payments/${state.id}/link`, user), 404, 'not_found');
      }
      expect(
        (await get(`/v1/payments/${state.id}/link`, A.staff, { aal: 'aal2' })).statusCode,
      ).toBe(403);
      expectProblem(
        await get(`/v1/payments/${randomUUID()}/link`, person('a1').user),
        404,
        'not_found',
      );
      expect(
        (
          await one<{ read_count: number }>(
            `select read_count from payments.handoff_links where subject_id = $1`,
            [state.id],
          )
        ).read_count,
      ).toBe(1);
    });

    it('with no key configured the answer is 503 handoff_unavailable, and the read is not counted', async () => {
      const res = await get(`/v1/payments/${state.id}/link`, person('a1').user, {
        app: appNoKeyring,
      });
      expectProblem(res, 503, 'handoff_unavailable');
      expect(res.body).not.toContain(state.link);
      expect(
        (
          await one<{ read_count: number }>(
            `select read_count from payments.handoff_links where subject_id = $1`,
            [state.id],
          )
        ).read_count,
      ).toBe(1);
    });

    it('a stored link that cannot be opened is a 500 with no detail, and the log names the class and the payment id only', async () => {
      let res: Awaited<ReturnType<typeof get>> | undefined;
      const log = await captureLog(async () => {
        // A separate app, built the way a deployed process is built (real serializers and redaction), with the WRONG key.
        const logged = await buildApp(loadConfig({ APP_ENV: 'local', LOG_LEVEL: 'trace' }), {
          auth: { verifier: fakeVerifier, context: createUserContext(apiPool) },
          ...(OTHER_KEYRING ? { handoff: OTHER_KEYRING } : {}),
        });
        try {
          res = await logged.inject({
            method: 'GET',
            url: `/v1/payments/${state.id}/link`,
            remoteAddress: freshAddress(),
            headers: { authorization: token(person('a1').user) },
          });
        } finally {
          await logged.close();
        }
      });
      if (!res) throw new Error('no response');
      expect(res.statusCode).toBe(500);
      const body = res.json<Problem>();
      expect(body.code).toBe('internal_error');
      expect(body.detail).toBeUndefined();
      expect(res.body).not.toContain(state.link);
      expect(log).toContain('could not be opened');
      expect(log).toContain(state.id);
      expect(log).toContain('HandoffVaultError');
      expect(log).not.toContain(state.link);
      expect(log).not.toContain(state.link.slice(-20));
      expect(log).not.toContain(person('a1').phone);
      // The failed read was rolled back with the request, so it was not counted either.
      expect(
        (
          await one<{ read_count: number }>(
            `select read_count from payments.handoff_links where subject_id = $1`,
            [state.id],
          )
        ).read_count,
      ).toBe(1);
      // The same app with the right key still delivers it.
      expect(
        (await get(`/v1/payments/${state.id}/link`, person('a1').user)).json<{ link: string }>()
          .link,
      ).toBe(state.link);
      // And the app with another key gives the same refusal through the test app too.
      expect(
        (await get(`/v1/payments/${state.id}/link`, person('a1').user, { app: appOtherKey }))
          .statusCode,
      ).toBe(500);
    });

    it('the link is gone when the payment leaves pending, when it expires, and when the lender switch is off', async () => {
      // Leaves pending (the system expires it; simulated here for this one payment so that no other file's rows are touched).
      const failing = await newPayment('b1', 'two');
      await recordOrder(failing);
      await storeLink(
        'payment_intent',
        failing,
        B.id,
        `https://pay.example.test/checkout/${randomUUID()}`,
      );
      expect((await get(`/v1/payments/${failing}/link`, person('b1').user)).statusCode).toBe(200);
      await replica(async (c) => {
        await c.query(`update payments.payment_intents set status = 'expired' where id = $1`, [
          failing,
        ]);
      });
      expectProblem(await get(`/v1/payments/${failing}/link`, person('b1').user), 404, 'not_found');
      expect(
        BpPaymentDetail.parse((await get(`/v1/payments/${failing}`, person('b1').user)).json()),
      ).toMatchObject({ status: 'expired', linkAvailable: false });

      // Expires: the link row exists but the time has passed.
      const expiring = await newPayment('b1', 'three');
      await recordOrder(expiring);
      await storeLink(
        'payment_intent',
        expiring,
        B.id,
        `https://pay.example.test/checkout/${randomUUID()}`,
      );
      expect((await get(`/v1/payments/${expiring}/link`, person('b1').user)).statusCode).toBe(200);
      await replica(async (c) => {
        await c.query(
          `update payments.handoff_links set created_at = now() - interval '2 hours', expires_at = now() - interval '1 minute' where subject_id = $1`,
          [expiring],
        );
      });
      expectProblem(
        await get(`/v1/payments/${expiring}/link`, person('b1').user),
        404,
        'not_found',
      );

      // The payment's own link time is over although the stored link has not expired.
      const lapsed = await newPayment('b1', 'four');
      await recordOrder(lapsed);
      await storeLink(
        'payment_intent',
        lapsed,
        B.id,
        `https://pay.example.test/checkout/${randomUUID()}`,
      );
      await replica(async (c) => {
        await c.query(
          `update payments.payment_intents set link_expires_at = now() - interval '1 minute' where id = $1`,
          [lapsed],
        );
      });
      expectProblem(await get(`/v1/payments/${lapsed}/link`, person('b1').user), 404, 'not_found');

      // The lender's switch goes off: the payment, its options and its link are hidden, and a new request is refused.
      const live = await newPayment('b1', 'five');
      await recordOrder(live);
      await storeLink(
        'payment_intent',
        live,
        B.id,
        `https://pay.example.test/checkout/${randomUUID()}`,
      );
      expect((await get(`/v1/payments/${live}/link`, person('b1').user)).statusCode).toBe(200);
      const flip = (enabled: boolean) =>
        replica(async (c) => {
          await c.query(
            `update servicing.lender_features set enabled = $2 where lender_org_id = $1 and feature = 'payments'`,
            [B.id, enabled],
          );
        });
      await flip(false);
      try {
        expectProblem(await get(`/v1/payments/${live}/link`, person('b1').user), 404, 'not_found');
        expectProblem(await get(`/v1/payments/${live}`, person('b1').user), 404, 'not_found');
        expectProblem(
          await get(`/v1/loans/${loanOf('b1', 'five')}/payment-options`, person('b1').user),
          404,
          'not_found',
        );
        expectProblem(
          await post(
            `/v1/loans/${loanOf('b1', 'one')}/payments`,
            person('b1').user,
            paymentBody({ amountMinor: 475_000 }),
          ),
          409,
          'feature_disabled',
        );
      } finally {
        await flip(true);
      }
      expect((await get(`/v1/payments/${live}/link`, person('b1').user)).statusCode).toBe(200);
    });

    it('the link route has a tight rate limit', async () => {
      const id = await newPayment('b2', 'spam');
      await recordOrder(id);
      await storeLink(
        'payment_intent',
        id,
        B.id,
        `https://pay.example.test/checkout/${randomUUID()}`,
      );
      const statuses: number[] = [];
      for (let i = 0; i < 12; i += 1)
        statuses.push((await get(`/v1/payments/${id}/link`, person('b2').user)).statusCode);
      expect(statuses.slice(0, 10)).toEqual(Array.from({ length: 10 }, () => 200));
      expect(statuses.slice(10)).toEqual([429, 429]);
    });
  });

  // ======================================================================================================================
  // Mandates: options
  // ======================================================================================================================
  describe('mandate options', () => {
    it('lists the rails the lender configured, with the lower of the rail limit and the lender ceiling', async () => {
      const res = await get(`/v1/loans/${loanOf('a4', 'm1')}/mandate-options`, person('a4').user);
      expect(res.statusCode, res.body).toBe(200);
      expect(BpMandateOptions.parse(res.json())).toEqual({
        loanId: loanOf('a4', 'm1'),
        lenderDisplayName: 'Alpha',
        available: true,
        unavailableKey: null,
        requirement: 'before_first_due',
        preDebitLeadHours: 48,
        rails: [
          { rail: 'enach_api', maxAmountMinor: 4_000_000, needsAfaEachDebit: false },
          { rail: 'upi_autopay', maxAmountMinor: 1_500_000, needsAfaEachDebit: true },
        ],
        existingMandateId: null,
      });
    });

    it('a lender with no mandate policy still answers (default lead time) and only lists rails it configured', async () => {
      const body = BpMandateOptions.parse(
        (await get(`/v1/loans/${loanOf('b1', 'one')}/mandate-options`, person('b1').user)).json(),
      );
      expect(body).toMatchObject({
        available: true,
        requirement: null,
        preDebitLeadHours: 48,
        rails: [{ rail: 'enach_api', maxAmountMinor: 5_000_000, needsAfaEachDebit: false }],
      });
    });

    it('closed loans say why, and the other loans of other people are not found', async () => {
      const closed = BpMandateOptions.parse(
        (
          await get(`/v1/loans/${loanOf('a3', 'closed')}/mandate-options`, person('a3').user)
        ).json(),
      );
      expect(closed).toMatchObject({
        available: false,
        unavailableKey: 'loan_not_active',
        rails: [],
      });
      for (const user of [person('a2').user, person('b1').user])
        expectProblem(
          await get(`/v1/loans/${loanOf('a4', 'm1')}/mandate-options`, user),
          404,
          'not_found',
        );
      expectProblem(
        await get(`/v1/loans/${randomUUID()}/mandate-options`, person('a4').user),
        404,
        'not_found',
      );
    });

    it('a lender whose mandates switch is off hides the feature', async () => {
      expectProblem(
        await get(`/v1/loans/${loanOf('c1', 'one')}/mandate-options`, person('c1').user),
        404,
        'not_found',
      );
    });
  });

  // ======================================================================================================================
  // Mandates: asking for one
  // ======================================================================================================================
  describe('requesting a mandate', () => {
    const state: { id: string; loan: string; key: string } = { id: '', loan: '', key: '' };

    it('without a verified step-up code bound to the mandate it is refused, and nothing is created or queued', async () => {
      const id = randomUUID();
      const loan = loanOf('a4', 'm1');
      const res = await post(
        `/v1/loans/${loan}/mandates`,
        person('a4').user,
        await mandateBody(id),
      );
      expectProblem(res, 403, 'stepup_required');
      expect(await count(`select count(*) as n from payments.mandates where id = $1`, [id])).toBe(
        0,
      );
      expect(
        await count(
          `select count(*) as n from ops.outbox_events where payload ->> 'mandate_id' = $1`,
          [id],
        ),
      ).toBe(0);
      // A code verified for another action, or for another mandate, is no code for this one.
      await q(
        `insert into identity.stepup_challenges (id, borrower_id, action, context_ref, code_hash, status, delivery_status, expires_at, verified_at, verified_until)
         values (gen_random_uuid(), $1, 'offer_acceptance', $2, repeat('a', 64), 'verified', 'accepted', now() + interval '10 minutes', now(), now() + interval '10 minutes')`,
        [person('a4').id, id],
      );
      await plantStepUp(person('a4').id, randomUUID());
      expectProblem(
        await post(`/v1/loans/${loan}/mandates`, person('a4').user, await mandateBody(id)),
        403,
        'stepup_required',
      );
      expect(await count(`select count(*) as n from payments.mandates where id = $1`, [id])).toBe(
        0,
      );
    });

    it('without a sufficient device-integrity result it is refused, and the code is not spent', async () => {
      const id = randomUUID();
      await plantStepUp(person('a2').id, id);
      const res = await post(
        `/v1/loans/${loanOf('a2', 'first')}/mandates`,
        person('a2').user,
        await mandateBody(id),
      );
      expectProblem(res, 403, 'integrity_insufficient');
      expect(await stepUpOpen(id)).toBe(1);
      expect(await count(`select count(*) as n from payments.mandates where id = $1`, [id])).toBe(
        0,
      );
    });

    it('with the real step-up endpoints: ask for a code bound to the mandate id, verify it, then the mandate is created as a draft', async () => {
      const id = randomUUID();
      state.id = id;
      state.loan = loanOf('a4', 'm1');
      const before = sms.sent.length;
      const started = await post('/v1/stepup/challenges', person('a4').user, {
        action: 'mandate_creation',
        contextRef: id,
      });
      expect(started.statusCode, started.body).toBe(201);
      const code = sms.sent[before]?.variables.otp ?? '';
      expect(code).toMatch(/^[0-9]{6}$/);
      const verified = await post(
        `/v1/stepup/challenges/${started.json<{ challengeId: string }>().challengeId}/verify`,
        person('a4').user,
        { code },
      );
      expect(verified.json<{ result: string }>().result).toBe('verified');

      state.key = `it-pb-mandate-${randomUUID()}`;
      const body = await mandateBody(id);
      const res = await post(`/v1/loans/${state.loan}/mandates`, person('a4').user, body, {
        key: state.key,
      });
      expect(res.statusCode, res.body).toBe(201);
      const mandate = BpMandate.parse(res.json());
      expect(mandate).toEqual({
        id,
        loanId: state.loan,
        lenderDisplayName: 'Alpha',
        rail: 'enach_api',
        status: 'draft',
        maxAmountMinor: 3_000_000,
        startDate: body.startDate,
        endDate: body.endDate,
        maskedAccountRef: 'XXXXXX1234',
        needsAfaEachDebit: false,
        cancelRequested: false,
        nextDebitOn: null,
        nextDebitMinor: null,
        nextDebitNotified: null,
      });
      // The code was spent; the hand-off job is queued with the id only; the history starts with the borrower's request.
      expect(await stepUpOpen(id)).toBe(0);
      expect(
        await q<{ event_type: string; payload: unknown }>(
          `select event_type, payload from ops.outbox_events where payload ->> 'mandate_id' = $1`,
          [id],
        ),
      ).toEqual([{ event_type: 'mandate.handoff', payload: { mandate_id: id } }]);
      expect(
        await q<{ from_status: string | null; to_status: string; source: string }>(
          `select from_status, to_status, source from payments.mandate_events where mandate_id = $1 order by created_at`,
          [id],
        ),
      ).toEqual([{ from_status: null, to_status: 'draft', source: 'request' }]);
    });

    it('a replay returns the stored answer; the same request under a new key returns the same mandate and needs no new code', async () => {
      const body = await mandateBody(state.id);
      const replay = await post(`/v1/loans/${state.loan}/mandates`, person('a4').user, body, {
        key: state.key,
      });
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.json<{ id: string }>().id).toBe(state.id);
      const fresh = await post(`/v1/loans/${state.loan}/mandates`, person('a4').user, body);
      expect(fresh.statusCode, fresh.body).toBe(201);
      expect(fresh.json<{ id: string }>().id).toBe(state.id);
      expect(
        await count(`select count(*) as n from payments.mandates where id = $1`, [state.id]),
      ).toBe(1);
      expect(
        await count(
          `select count(*) as n from ops.outbox_events where payload ->> 'mandate_id' = $1`,
          [state.id],
        ),
      ).toBe(1);
    });

    it('the same mandate id with other content is a conflict, and a second live mandate on the loan is refused', async () => {
      const other = await post(
        `/v1/loans/${state.loan}/mandates`,
        person('a4').user,
        await mandateBody(state.id, { rail: 'upi_autopay', maxAmountMinor: 1_000_000 }),
      );
      expectProblem(other, 409, 'idempotency_conflict');
      const second = randomUUID();
      await plantStepUp(person('a4').id, second);
      expectProblem(
        await post(
          `/v1/loans/${state.loan}/mandates`,
          person('a4').user,
          await mandateBody(second),
        ),
        409,
        'mandate_exists',
      );
      expect(
        await count(`select count(*) as n from payments.mandates where id = $1`, [second]),
      ).toBe(0);
      // Nothing was spent by the refused request.
      expect(await stepUpOpen(second)).toBe(1);
    });

    it("someone else's loan, another lender's loan and an unknown loan are not found, and the code is not spent", async () => {
      const id = randomUUID();
      await plantStepUp(person('a2').id, id);
      expectProblem(
        await post(
          `/v1/loans/${loanOf('a4', 'm2')}/mandates`,
          person('a2').user,
          await mandateBody(id),
        ),
        404,
        'not_found',
      );
      expectProblem(
        await post(
          `/v1/loans/${loanOf('a4', 'm2')}/mandates`,
          person('b1').user,
          await mandateBody(id),
        ),
        404,
        'not_found',
      );
      expectProblem(
        await post(`/v1/loans/${randomUUID()}/mandates`, person('a4').user, await mandateBody(id)),
        404,
        'not_found',
      );
      expect(await stepUpOpen(id)).toBe(1);
      expect(await count(`select count(*) as n from payments.mandates where id = $1`, [id])).toBe(
        0,
      );
    });

    it('the database refusals keep their own status and code: limits, rails, dates and the switch', async () => {
      const a4 = person('a4');
      const attempt = async (
        what: string,
        over: Record<string, unknown>,
        status: number,
        code: string,
        loanName = 'm2',
      ) => {
        const id = randomUUID();
        await plantStepUp(a4.id, id);
        const res = await post(
          `/v1/loans/${loanOf('a4', loanName)}/mandates`,
          a4.user,
          await mandateBody(id, over),
        );
        expect([what, res.statusCode, problem(res).code]).toEqual([what, status, code]);
        expect(await count(`select count(*) as n from payments.mandates where id = $1`, [id])).toBe(
          0,
        );
      };
      await attempt(
        'an amount above the lender ceiling',
        { maxAmountMinor: 4_000_001 },
        422,
        'amount_not_allowed',
      );
      await attempt(
        'an amount above the rail limit',
        { rail: 'upi_autopay', maxAmountMinor: 1_500_001 },
        422,
        'amount_not_allowed',
      );
      await attempt(
        'a start date in the past',
        { startDate: await dayPlus(-1) },
        422,
        'dates_invalid',
      );
      await attempt(
        'an end date not after the start',
        { startDate: await dayPlus(10), endDate: await dayPlus(10) },
        422,
        'dates_invalid',
      );
      await attempt(
        'a mandate longer than ten years',
        { startDate: await dayPlus(1), endDate: await dayPlus(4000) },
        422,
        'dates_invalid',
      );
      await attempt(
        'a date that does not exist',
        { startDate: '2030-02-31' },
        422,
        'invalid_request',
      );
      // Lender B configured only the eNACH rail.
      const b1 = person('b1');
      const id = randomUUID();
      await plantStepUp(b1.id, id);
      const upi = await post(
        `/v1/loans/${loanOf('b1', 'one')}/mandates`,
        b1.user,
        await mandateBody(id, { rail: 'upi_autopay', maxAmountMinor: 1_000_000 }),
      );
      expectProblem(upi, 409, 'rail_not_configured');
      // Lender C has the mandates switch off.
      const idC = randomUUID();
      await plantStepUp(person('c1').id, idC);
      expectProblem(
        await post(
          `/v1/loans/${loanOf('c1', 'one')}/mandates`,
          person('c1').user,
          await mandateBody(idC),
        ),
        409,
        'feature_disabled',
      );
      // A closed loan.
      const idClosed = randomUUID();
      await plantStepUp(person('a3').id, idClosed);
      expectProblem(
        await post(
          `/v1/loans/${loanOf('a3', 'closed')}/mandates`,
          person('a3').user,
          await mandateBody(idClosed),
        ),
        409,
        'loan_not_active',
      );
    });

    it('a full account number, a rail the database does not know or an unknown field is a validation error and stores nothing', async () => {
      const a4 = person('a4');
      const bad: [string, Record<string, unknown>][] = [
        ['a full account number', { maskedAccountRef: '123456789012' }],
        ['an account number with a few masked letters', { maskedAccountRef: 'XX123456789012' }],
        ['one masked letter', { maskedAccountRef: 'X1234' }],
        ['five visible digits', { maskedAccountRef: 'XXXXXX12345' }],
        ['lower-case masking', { maskedAccountRef: 'xxxxxx1234' }],
        ['an unknown rail', { rail: 'physical_nach' }],
        ['a fractional amount', { maxAmountMinor: 3000000.5 }],
        ['an amount as text', { maxAmountMinor: '3000000' }],
        ['zero amount', { maxAmountMinor: 0 }],
        ['a start date that is not a date', { startDate: 'tomorrow' }],
        ['a mandate id that is not a uuid', { mandateId: 'abc' }],
        ['a provider reference', { providerMandateRef: 'PM-1' }],
        ['a status', { status: 'active' }],
      ];
      for (const [what, over] of bad) {
        const id = randomUUID();
        await plantStepUp(a4.id, id);
        const res = await post(
          `/v1/loans/${loanOf('a4', 'm2')}/mandates`,
          a4.user,
          await mandateBody(id, { ...over }),
        );
        expect([what, res.statusCode, problem(res).code]).toEqual([what, 422, 'validation_failed']);
        expect(res.body).not.toContain('123456789012');
        expect(await count(`select count(*) as n from payments.mandates where id = $1`, [id])).toBe(
          0,
        );
      }
      // Nothing is stored, and a masked reference with the shape the database wants is accepted.
      const ok = await newMandate('a4', 'm2', {
        maskedAccountRef: 'XXXXXXXX1234',
        maxAmountMinor: undefined,
      });
      const mandate = BpMandate.parse((await get(`/v1/mandates/${ok}`, a4.user)).json());
      // No amount asked for: the database uses the lower of the rail limit and the lender ceiling.
      expect(mandate.maxAmountMinor).toBe(4_000_000);
      expect(mandate.maskedAccountRef).toBe('XXXXXXXX1234');
    });

    it('a mock-mode configuration is no valid collection target for a mandate either in a session that does not allow mock providers', async () => {
      const id = randomUUID();
      await plantStepUp(person('a4').id, id);
      const res = await post(
        `/v1/loans/${loanOf('a4', 'm3')}/mandates`,
        person('a4').user,
        await mandateBody(id),
        { app: appBlocked },
      );
      expectProblem(res, 409, 'collection_target_invalid');
      expect(await count(`select count(*) as n from payments.mandates where id = $1`, [id])).toBe(
        0,
      );
      expect(await stepUpOpen(id)).toBe(1);
    });

    it('the loan now shows its live mandate in the options', async () => {
      const body = BpMandateOptions.parse(
        (await get(`/v1/loans/${state.loan}/mandate-options`, person('a4').user)).json(),
      );
      expect(body).toMatchObject({
        available: false,
        unavailableKey: 'mandate_exists',
        existingMandateId: state.id,
      });
    });
  });

  // ======================================================================================================================
  // Mandates: reading them, the link, cancelling, debits
  // ======================================================================================================================
  describe('mandates', () => {
    const state: { draft: string; pending: string; active: string; link: string } = {
      draft: '',
      pending: '',
      active: '',
      link: '',
    };

    it('lists the borrower’s own mandates newest first, with the status exactly as the history left it', async () => {
      state.draft = await newMandate('a4', 'm4');
      state.pending = await newMandate('a4', 'm5');
      state.active = await newMandate('a4', 'm6');
      await mandateLifecycle.handoff(state.pending);
      await mandateLifecycle.handoff(state.active);
      await mandateLifecycle.lookup(state.active, 'active');

      const list = BpMandateList.parse((await get('/v1/mandates', person('a4').user)).json());
      const mine = list.items.filter((m) =>
        [state.draft, state.pending, state.active].includes(m.id),
      );
      expect(mine.map((m) => [m.id, m.status])).toEqual([
        [state.active, 'active'],
        [state.pending, 'registration_pending'],
        [state.draft, 'draft'],
      ]);
      // Newest first overall: the order follows the creation order, not the status.
      const created = await q<{ id: string }>(
        `select id from payments.mandates where borrower_id = $1 order by created_at desc, id desc`,
        [person('a4').id],
      );
      expect(list.items.map((m) => m.id)).toEqual(created.map((r) => r.id));
      // The lender-confirmed status is the only word of activity: a mandate nobody confirmed is never shown as active.
      expect(list.items.find((m) => m.id === state.pending)?.status).not.toBe('active');
    });

    it("other borrowers see none of them, in the list or by id (404), and a lender user cannot read the borrower's list", async () => {
      for (const key of ['a2', 'b1', 'c1']) {
        const list = BpMandateList.parse((await get('/v1/mandates', person(key).user)).json());
        expect(
          list.items.some((m) => [state.draft, state.pending, state.active].includes(m.id)),
        ).toBe(false);
        for (const id of [state.draft, state.pending, state.active]) {
          expectProblem(await get(`/v1/mandates/${id}`, person(key).user), 404, 'not_found');
          expectProblem(await get(`/v1/mandates/${id}/debits`, person(key).user), 404, 'not_found');
          expectProblem(await get(`/v1/mandates/${id}/link`, person(key).user), 404, 'not_found');
          expectProblem(
            await post(`/v1/mandates/${id}/cancel`, person(key).user, {}),
            404,
            'not_found',
          );
        }
      }
      expectProblem(await get(`/v1/mandates/${randomUUID()}`, person('a4').user), 404, 'not_found');
      expect(
        await count(
          `select count(*) as n from payments.mandates where id = any($1::uuid[]) and cancel_requested_at is not null`,
          [[state.draft, state.pending, state.active]],
        ),
      ).toBe(0);
    });

    it('one mandate by id', async () => {
      const res = await get(`/v1/mandates/${state.active}`, person('a4').user);
      expect(res.statusCode, res.body).toBe(200);
      expect(BpMandate.parse(res.json())).toMatchObject({
        id: state.active,
        status: 'active',
        cancelRequested: false,
      });
    });

    it('hands over the sealed authorisation link only while the mandate waits for the borrower', async () => {
      if (!KEYRING) throw new Error('keyring');
      // A draft has no link yet.
      expectProblem(
        await get(`/v1/mandates/${state.draft}/link`, person('a4').user),
        404,
        'not_found',
      );
      state.link = `https://auth.example.test/mandate/${randomUUID()}`;
      await storeLink('mandate', state.pending, A.id, state.link);
      const res = await get(`/v1/mandates/${state.pending}/link`, person('a4').user);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.headers['cache-control']).toContain('no-store');
      expect(BpHandoffLink.parse(res.json()).link).toBe(state.link);
      // Another borrower, a missing key and a wrong key.
      expectProblem(
        await get(`/v1/mandates/${state.pending}/link`, person('a2').user),
        404,
        'not_found',
      );
      expectProblem(
        await get(`/v1/mandates/${state.pending}/link`, person('a4').user, { app: appNoKeyring }),
        503,
        'handoff_unavailable',
      );
      const wrong = await get(`/v1/mandates/${state.pending}/link`, person('a4').user, {
        app: appOtherKey,
      });
      expect(wrong.statusCode).toBe(500);
      expect(wrong.json<Problem>().detail).toBeUndefined();
      expect(wrong.body).not.toContain(state.link);
      // A link row that outlived its purpose (the mandate is active, not waiting for the borrower) is never handed out.
      const stale = `https://auth.example.test/mandate/${randomUUID()}`;
      bearerLinks.push(stale);
      const sealed = sealHandoffLink(
        KEYRING,
        { kind: 'mandate', subjectId: state.active, lenderOrgId: A.id },
        stale,
      );
      await replica(async (c) => {
        await c.query(
          `insert into payments.handoff_links (lender_org_id, borrower_id, subject_kind, subject_id, key_version, ciphertext, expires_at)
           values ($1, $2, 'mandate', $3, $4, $5, now() + interval '1 hour')`,
          [A.id, person('a4').id, state.active, sealed.keyVersion, sealed.ciphertext],
        );
      });
      expectProblem(
        await get(`/v1/mandates/${state.active}/link`, person('a4').user),
        404,
        'not_found',
      );
      // Once the provider confirms it, the link is gone.
      await mandateLifecycle.lookup(state.pending, 'active');
      expectProblem(
        await get(`/v1/mandates/${state.pending}/link`, person('a4').user),
        404,
        'not_found',
      );
    });

    it('a cancellation is a request: the status stays as confirmed, the job is queued, repeating is safe', async () => {
      const key = `it-pb-mcancel-${randomUUID()}`;
      const res = await post(`/v1/mandates/${state.active}/cancel`, person('a4').user, {}, { key });
      expect(res.statusCode, res.body).toBe(202);
      expect(res.json()).toEqual({ id: state.active, result: 'cancel_requested' });
      const after = BpMandate.parse(
        (await get(`/v1/mandates/${state.active}`, person('a4').user)).json(),
      );
      expect(after).toMatchObject({ status: 'active', cancelRequested: true });
      expect(
        await q(
          `select event_type, payload from ops.outbox_events where payload ->> 'mandate_id' = $1 and event_type = 'mandate.cancel'`,
          [state.active],
        ),
      ).toEqual([{ event_type: 'mandate.cancel', payload: { mandate_id: state.active } }]);
      const replay = await post(
        `/v1/mandates/${state.active}/cancel`,
        person('a4').user,
        {},
        { key },
      );
      expect(replay.headers['idempotent-replayed']).toBe('true');
      const again = await post(`/v1/mandates/${state.active}/cancel`, person('a4').user, {});
      expect(again.statusCode).toBe(202);
      expect(
        await count(
          `select count(*) as n from ops.outbox_events where payload ->> 'mandate_id' = $1 and event_type = 'mandate.cancel'`,
          [state.active],
        ),
      ).toBe(1);
    });

    it('a mandate that is finished cannot be cancelled again (409 mandate_finished)', async () => {
      const id = await newMandate('a4', 'm7');
      await mandateLifecycle.handoff(id);
      await mandateLifecycle.lookup(id, 'rejected');
      expect(
        BpMandate.parse((await get(`/v1/mandates/${id}`, person('a4').user)).json()).status,
      ).toBe('rejected');
      expectProblem(
        await post(`/v1/mandates/${id}/cancel`, person('a4').user, {}),
        409,
        'mandate_finished',
      );
    });

    it('lists the debits with the notice state, newest first, and nothing the provider alone knows', async () => {
      // A mandate of its own: state.active had its cancellation requested earlier in this file, and a mandate with a request shows
      // no next debit (A52, M45).
      const mandate = await newMandate('a4', 'm9');
      await mandateLifecycle.handoff(mandate);
      await mandateLifecycle.lookup(mandate, 'active');
      const lender = A.id;
      const snapshot = randomUUID();
      const debits: {
        on: string;
        planned: boolean;
        seq: number | null;
        status: string;
        amount: number | null;
        code: string | null;
        cls: string | null;
        ref: string | null;
      }[] = [
        {
          on: `${IST_TODAY} - 10`,
          planned: false,
          seq: null,
          status: 'settled',
          amount: 475_000,
          code: null,
          cls: null,
          ref: `DBT-${RUN}-1`,
        },
        {
          on: `${IST_TODAY} - 5`,
          planned: false,
          seq: null,
          status: 'returned',
          amount: 475_000,
          code: 'R01',
          cls: 'insufficient_funds',
          ref: `DBT-${RUN}-2`,
        },
        {
          on: `${IST_TODAY} - 3`,
          planned: false,
          seq: null,
          status: 'unknown',
          amount: null,
          code: null,
          cls: null,
          ref: `DBT-${RUN}-3`,
        },
        {
          // The lender's newest report in this file says the next installment falls due three days from now: a planned debit for an
          // earlier day would be shown as already paid (and is not offered as the next debit), so the first planned debit is on that day.
          on: `${IST_TODAY} + 3`,
          planned: true,
          seq: 1,
          status: 'notified',
          amount: 475_000,
          code: null,
          cls: null,
          ref: null,
        },
        {
          on: `${IST_TODAY} + 33`,
          planned: true,
          seq: 2,
          status: 'scheduled',
          amount: 475_000,
          code: null,
          cls: null,
          ref: null,
        },
      ];
      const ids: string[] = [];
      await replica(async (c) => {
        for (const [n, d] of debits.entries()) {
          const id = randomUUID();
          ids.push(id);
          await c.query(
            `insert into payments.mandate_debits (id, lender_org_id, mandate_id, loan_account_id, planned, schedule_snapshot_id, installment_seq, scheduled_on,
                                                amount_minor, status, provider_debit_ref, return_code, return_class, exceeds_mandate_max)
             values ($1, $2, $3, $4, $5, $6, $7, ${d.on}, $8, $9, $10, $11, $12, false)`,
            [
              id,
              lender,
              mandate,
              loanOf('a4', 'm9'),
              d.planned,
              d.planned ? snapshot : null,
              d.seq,
              d.amount,
              d.status,
              d.ref,
              d.code,
              d.cls,
            ],
          );
          if (d.planned)
            await c.query(
              `insert into payments.pre_debit_notices (lender_org_id, debit_id, mandate_id, borrower_id, notice_due_at, status, delivery_state, sent_at)
               values ($1, $2, $3, $4, now() + interval '${String(n)} hours', $5, $6, $7)`,
              [
                lender,
                id,
                mandate,
                person('a4').id,
                d.status === 'notified' ? 'sent' : 'planned',
                d.status === 'notified' ? 'accepted' : null,
                d.status === 'notified' ? new Date().toISOString() : null,
              ],
            );
        }
      });
      const res = await get(`/v1/mandates/${mandate}/debits`, person('a4').user);
      expect(res.statusCode, res.body).toBe(200);
      const list = BpMandateDebitList.parse(res.json());
      expect(list.items.map((d) => d.id)).toEqual([ids[4], ids[3], ids[2], ids[1], ids[0]]);
      expect(
        list.items.map((d) => [d.status, d.planned, d.amountMinor, d.returnCode, d.returnClass]),
      ).toEqual([
        ['scheduled', true, 475_000, null, null],
        ['notified', true, 475_000, null, null],
        ['unknown', false, null, null, null],
        ['returned', false, 475_000, 'R01', 'insufficient_funds'],
        ['settled', false, 475_000, null, null],
      ]);
      expect(list.items[0]?.notice).toMatchObject({ status: 'planned', sentAt: null });
      expect(list.items[1]?.notice).toMatchObject({ status: 'sent' });
      expect(list.items[1]?.notice?.sentAt).toEqual(expect.any(String));
      expect(list.items[2]?.notice).toBeNull();
      // The provider's debit reference is not part of the answer.
      expect(res.body).not.toContain(`DBT-${RUN}`);
      // The mandate shows the next planned debit.
      const detail = BpMandate.parse(
        (await get(`/v1/mandates/${mandate}`, person('a4').user)).json(),
      );
      expect(detail).toMatchObject({ nextDebitMinor: 475_000, nextDebitNotified: true });
      expect(detail.nextDebitOn).toBe(await dayPlus(3));
      // Once the borrower asks to cancel, nothing is taken any more: the planned debits stay on record but no next debit is shown (A52).
      const asked = await post(`/v1/mandates/${mandate}/cancel`, person('a4').user, {});
      expect(asked.statusCode, asked.body).toBe(202);
      const afterRequest = BpMandate.parse(
        (await get(`/v1/mandates/${mandate}`, person('a4').user)).json(),
      );
      expect(afterRequest).toMatchObject({
        cancelRequested: true,
        nextDebitOn: null,
        nextDebitMinor: null,
        nextDebitNotified: null,
      });
      // and the same through the list
      expect(
        BpMandateList.parse((await get('/v1/mandates', person('a4').user)).json()).items.find(
          (m) => m.id === mandate,
        ),
      ).toMatchObject({ nextDebitOn: null, nextDebitMinor: null, nextDebitNotified: null });
    });

    it('a lender whose mandates switch goes off keeps a live mandate listed and readable, hides a finished one and the options, and it all comes back when the switch does', async () => {
      // A mandate that is not over stays visible (and cancellable) so the borrower is never left with one they cannot see; a
      // finished mandate of that lender is hidden; nothing new can be started (U9).
      const live = await newMandate('b1', 'two');
      const finished = await newMandate('b1', 'three');
      await mandateLifecycle.handoff(finished);
      await mandateLifecycle.lookup(finished, 'rejected');
      const listed = async () =>
        BpMandateList.parse((await get('/v1/mandates', person('b1').user)).json()).items.map(
          (m) => m.id,
        );
      expect(await listed()).toEqual(expect.arrayContaining([live, finished]));
      expect(
        BpMandate.parse((await get(`/v1/mandates/${live}`, person('b1').user)).json()).id,
      ).toBe(live);
      const flip = (enabled: boolean) =>
        replica(async (c) => {
          await c.query(
            `update servicing.lender_features set enabled = $2 where lender_org_id = $1 and feature = 'mandates'`,
            [B.id, enabled],
          );
        });
      await flip(false);
      try {
        const whileOff = await listed();
        expect(whileOff).toContain(live);
        expect(whileOff).not.toContain(finished);
        const detail = await get(`/v1/mandates/${live}`, person('b1').user);
        expect(detail.statusCode, detail.body).toBe(200);
        expect(BpMandate.parse(detail.json())).toMatchObject({ id: live, status: 'draft' });
        const debits = await get(`/v1/mandates/${live}/debits`, person('b1').user);
        expect(debits.statusCode, debits.body).toBe(200);
        expect(BpMandateDebitList.parse(debits.json()).items).toEqual([]);
        expectProblem(await get(`/v1/mandates/${finished}`, person('b1').user), 404, 'not_found');
        expectProblem(
          await get(`/v1/mandates/${finished}/debits`, person('b1').user),
          404,
          'not_found',
        );
        expectProblem(
          await get(`/v1/loans/${loanOf('b1', 'two')}/mandate-options`, person('b1').user),
          404,
          'not_found',
        );
      } finally {
        await flip(true);
      }
      expect(await listed()).toEqual(expect.arrayContaining([live, finished]));
      expect(
        BpMandate.parse((await get(`/v1/mandates/${finished}`, person('b1').user)).json()).status,
      ).toBe('rejected');
    });
  });

  // ======================================================================================================================
  // The whole chain with the real worker and the labelled mock providers
  // ======================================================================================================================
  describe('end to end with the real outbox worker (labelled mock providers)', () => {
    const resolver = createProviderResolver({ environment: 'test', secret: () => undefined });
    const configOf = (lender: LenderFixture): PaymentConfigRow => ({
      configId: lender.configId,
      lenderOrgId: lender.id,
      provider: PROVIDER,
      providerMode: 'mock',
      merchantRef: lender.merchantRef,
      secretRef: CANARY.secretRef,
      webhookSecretRef: CANARY.webhookSecretRef,
    });
    const paymentMock = (lender: LenderFixture): MockPaymentProvider => {
      const resolved = resolver.payment(configOf(lender));
      if (!resolved.ok) throw new Error('no mock');
      return resolved.value.port as MockPaymentProvider;
    };
    const mandateMock = (lender: LenderFixture): MockMandateProvider => {
      const resolved = resolver.mandate(configOf(lender));
      if (!resolved.ok) throw new Error('no mock');
      return resolved.value.port as MockMandateProvider;
    };
    const logLines: string[] = [];
    const logger: WorkerLogger = {
      info: (fields, message) => logLines.push(JSON.stringify({ message, ...fields })),
      warn: (fields, message) => logLines.push(JSON.stringify({ message, ...fields })),
      error: (fields, message) => logLines.push(JSON.stringify({ message, ...fields })),
    };
    /** Only this file's events, so another file's jobs are never touched. */
    const ownStore = (ids: string[]): OutboxStore => {
      const pgStore = createPgOutboxStore(systemPool);
      return {
        claim: async (workerId, batch, leaseSeconds) =>
          (
            await admin.query<OutboxEvent>(
              `with picked as (
                 select e.id from ops.outbox_events e
                  where e.status = 'pending' and e.available_at <= now()
                    and coalesce(e.payload ->> 'intent_id', e.payload ->> 'mandate_id') = any ($1::text[])
                  order by e.available_at, e.id limit $2 for update skip locked)
               update ops.outbox_events e set status = 'processing', attempts = e.attempts + 1, locked_by = $3, locked_until = now() + make_interval(secs => $4)
                 from picked where e.id = picked.id
               returning e.id, e.event_type, e.payload, e.payload_version, e.attempts, e.max_attempts, e.correlation_id`,
              [ids, batch, workerId, leaseSeconds],
            )
          ).rows,
        complete: pgStore.complete,
        fail: pgStore.fail,
        purge: pgStore.purge,
      };
    };
    let workerNumber = 0;
    const drain = async (ids: string[]) => {
      const worker = new OutboxWorker({
        store: ownStore(ids),
        handlers: createPaymentsHandlers({
          pool: systemPool,
          providers: resolver,
          keyring: KEYRING,
          log: logger,
        }),
        workerId: `it-pb-${String((workerNumber += 1))}`,
        log: logger,
        concurrency: 1,
      });
      let completed = 0;
      for (let i = 0; i < 8; i += 1) {
        const summary = await worker.runOnce();
        completed += summary.completed;
        if (summary.claimed === 0) break;
      }
      return completed;
    };

    it('the request returns at once; after the worker creates the order the app sees the payment pending, fetches the link, and can no longer cancel', async () => {
      const id = await newPayment('a1', 'worker');
      const created = BpPaymentDetail.parse(
        (await get(`/v1/payments/${id}`, person('a1').user)).json(),
      );
      expect(created).toMatchObject({ status: 'created', linkAvailable: false, cancellable: true });
      expectProblem(await get(`/v1/payments/${id}/link`, person('a1').user), 404, 'not_found');

      expect(await drain([id])).toBe(1);
      const polled = BpPaymentDetail.parse(
        (await get(`/v1/payments/${id}`, person('a1').user)).json(),
      );
      expect(polled).toMatchObject({
        status: 'pending',
        stage: 'started',
        linkAvailable: true,
        cancellable: false,
      });
      expect(polled.linkExpiresAt).not.toBeNull();

      const res = await get(`/v1/payments/${id}/link`, person('a1').user);
      expect(res.statusCode, res.body).toBe(200);
      const link = BpHandoffLink.parse(res.json()).link;
      bearerLinks.push(link);
      // Exactly what the provider returned for this payment, asked again under the same operation key.
      const mock = paymentMock(A);
      const request = mock.created.find((r) => r.operationKey === id);
      if (!request) throw new Error('the mock never saw this payment');
      const again = await mock.createOrder({ tenantId: A.id, correlationId: 'it' }, request);
      expect(again.outcome === 'ok' ? again.value.checkoutLink : null).toBe(link);
      expect(request).toMatchObject({
        merchantRef: A.merchantRef,
        amountMinor: 475_000n,
        purpose: 'installment',
      });

      expectProblem(
        await post(`/v1/payments/${id}/cancel`, person('a1').user, {}),
        409,
        'intent_not_cancellable',
      );
      // The worker's log carries ids and closed words, never the link.
      expect(logLines.join('\n')).not.toContain(link);
    });

    it('a mandate: the hand-off job moves it to registration_pending, the link is available, and a cancellation request reaches the provider without cancelling anything', async () => {
      const id = await newMandate('a4', 'm8');
      expect(
        BpMandate.parse((await get(`/v1/mandates/${id}`, person('a4').user)).json()).status,
      ).toBe('draft');
      expectProblem(await get(`/v1/mandates/${id}/link`, person('a4').user), 404, 'not_found');

      expect(await drain([id])).toBe(1);
      expect(
        BpMandate.parse((await get(`/v1/mandates/${id}`, person('a4').user)).json()),
      ).toMatchObject({
        status: 'registration_pending',
        cancelRequested: false,
      });
      const res = await get(`/v1/mandates/${id}/link`, person('a4').user);
      expect(res.statusCode, res.body).toBe(200);
      const link = BpHandoffLink.parse(res.json()).link;
      bearerLinks.push(link);
      expect(link).toMatch(/^https:\/\/mock-mandate\.invalid\/handoff\//);

      const cancel = await post(`/v1/mandates/${id}/cancel`, person('a4').user, {});
      expect(cancel.statusCode, cancel.body).toBe(202);
      expect(await drain([id])).toBe(1);
      // The provider was asked; the mandate is cancelled only when the provider confirms it.
      expect(mandateMock(A).cancelRequests.length).toBeGreaterThan(0);
      expect(
        BpMandate.parse((await get(`/v1/mandates/${id}`, person('a4').user)).json()),
      ).toMatchObject({
        status: 'registration_pending',
        cancelRequested: true,
      });
      expect(
        await one(
          `select cancel_sent_at is not null as sent from payments.mandates where id = $1`,
          [id],
        ),
      ).toEqual({ sent: true });
      expect(logLines.join('\n')).not.toContain(link);
    });
  });

  // ======================================================================================================================
  // Nothing personal in any answer or log line
  // ======================================================================================================================
  describe('canaries', () => {
    const forbiddenKeys = [
      'providerOrderRef',
      'provider_order_ref',
      'providerMandateRef',
      'provider_mandate_ref',
      'providerPaymentRef',
      'merchant',
      'merchantRef',
      'creditorRef',
      'secretRef',
      'webhookSecretRef',
      'endpointTokenHash',
      'fingerprint',
      'ciphertext',
      'keyVersion',
      'key_version',
      'idempotencyKey',
      'idempotency_key',
      'borrowerId',
      'borrower_id',
      'configId',
      'config_id',
      'settlementAccountId',
      'lenderId',
      'lender_org_id',
      'accountNumber',
      'phone',
      'readCount',
      'alg',
    ];

    const planted = () => [
      CANARY.secretRef,
      CANARY.webhookSecretRef,
      CANARY.account,
      CANARY.bankName,
      CANARY.fingerprint,
      CANARY.tokenHash,
      CANARY.orderRef,
      A.merchantRef,
      B.merchantRef,
      'MOCK-ORDER',
      'CANARYORDER',
      'PROVIDER-MANDATE-',
      ...Object.values(people).map((p) => p.phone),
      ...Object.values(people).map((p) => p.phone.slice(2)),
    ];

    it('no response carries a secret reference, fingerprint, ciphertext, key version, provider reference, merchant, phone or account value', () => {
      const everything = seen
        .filter((s) => !s.url.endsWith('/link'))
        .map((s) => s.body)
        .join('\n');
      expect(seen.length).toBeGreaterThan(100);
      for (const value of planted())
        expect([value, everything.includes(value)]).toEqual([value, false]);
      for (const link of bearerLinks) expect(everything.includes(link)).toBe(false);
      for (const key of forbiddenKeys)
        expect([key, everything.includes(`"${key}"`)]).toEqual([key, false]);
    });

    it('the stored idempotent answers (replayed later) hold none of it either, and no link', async () => {
      const rows = await q<{ t: string }>(
        `select response_body::text as t from ops.idempotency_keys where principal_id = any($1::uuid[]) and response_body is not null`,
        [Object.values(people).map((p) => p.user)],
      );
      expect(rows.length).toBeGreaterThan(15);
      const everything = rows.map((r) => r.t).join('\n');
      for (const value of planted())
        expect([value, everything.includes(value)]).toEqual([value, false]);
      for (const link of bearerLinks) expect(everything.includes(link)).toBe(false);
      for (const key of forbiddenKeys)
        expect([key, everything.includes(`"${key}"`)]).toEqual([key, false]);
    });

    it('a bearer link appears only in the answer of the link routes, and only for its owner', () => {
      const linkBodies = seen.filter((s) => s.url.endsWith('/link') && s.body.includes('"link"'));
      expect(linkBodies.length).toBeGreaterThan(0);
      for (const entry of linkBodies)
        expect(bearerLinks.some((l) => entry.body.includes(l))).toBe(true);
      // And a link opened by the library is what the keyring seals: the vault round trip, independent of the routes.
      const probe = `https://pay.example.test/checkout/${randomUUID()}`;
      if (!KEYRING) throw new Error('keyring');
      const sealed = sealHandoffLink(
        KEYRING,
        { kind: 'payment_intent', subjectId: randomUUID(), lenderOrgId: A.id },
        probe,
      );
      expect(() =>
        openHandoffLink(
          KEYRING,
          { kind: 'payment_intent', subjectId: randomUUID(), lenderOrgId: A.id },
          sealed.keyVersion,
          sealed.ciphertext,
        ),
      ).toThrow();
    });

    it('the request log of the routes carries ids and paths, never a body, a link, a phone or a reference', async () => {
      const probeLink = `https://pay.example.test/checkout/${randomUUID()}`;
      const log = await captureLog(async () => {
        const logged = await buildApp(loadConfig({ APP_ENV: 'local', LOG_LEVEL: 'trace' }), {
          auth: { verifier: fakeVerifier, context: createUserContext(apiPool) },
          borrower: {
            sms,
            integrity: createMockIntegrityVerifier('test'),
            stepUpPepper: STEPUP_PEPPER,
            smsTimeoutMs: 2000,
          },
          ...(KEYRING ? { handoff: KEYRING } : {}),
        });
        try {
          const send = (method: 'GET' | 'POST', url: string, user: string, payload?: unknown) =>
            logged.inject({
              method,
              url,
              remoteAddress: freshAddress(),
              headers: {
                authorization: token(user),
                ...(method === 'POST' ? { 'idempotency-key': `it-pb-${randomUUID()}` } : {}),
              },
              ...(payload === undefined ? {} : { payload: payload as object }),
            });
          const a1 = person('a1');
          const pending = await one<{ id: string }>(
            `select id from payments.payment_intents where borrower_id = $1 and status = 'pending' limit 1`,
            [a1.id],
          );
          await send('GET', `/v1/loans/${loanOf('a1', 'options')}/payment-options`, a1.user);
          await send('GET', `/v1/payments/${pending.id}`, a1.user);
          await send('GET', `/v1/payments/${pending.id}/link`, a1.user);
          await send('GET', '/v1/mandates', person('a4').user);
          await send(
            'POST',
            `/v1/loans/${loanOf('a3', 'refusals')}/payments`,
            person('a3').user,
            paymentBody({ amountMinor: 475_001, providerOrderRef: probeLink }),
          );
        } finally {
          await logged.close();
        }
      });
      expect(log).toContain('request completed');
      const values = [
        probeLink,
        ...bearerLinks,
        ...Object.values(people).map((p) => p.phone),
        CANARY.secretRef,
        CANARY.account,
        CANARY.fingerprint,
        CANARY.orderRef,
        A.merchantRef,
        'amountMinor',
        'maskedAccountRef',
      ];
      for (const value of values) expect([value, log.includes(value)]).toEqual([value, false]);
    });
  });

  // ======================================================================================================================
  // The declared contract
  // ======================================================================================================================
  describe('contract', () => {
    it('every route is declared in the OpenAPI document with its strict request and response schemas', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/openapi.json' });
      expect(res.statusCode).toBe(200);
      const doc = res.json<{
        paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
      }>();
      const expected: [string, string][] = [
        ['get', '/v1/loans/{id}/payment-options'],
        ['post', '/v1/loans/{id}/payments'],
        ['get', '/v1/payments/{id}'],
        ['get', '/v1/payments/{id}/link'],
        ['post', '/v1/payments/{id}/cancel'],
        ['get', '/v1/loans/{id}/mandate-options'],
        ['post', '/v1/loans/{id}/mandates'],
        ['get', '/v1/mandates'],
        ['get', '/v1/mandates/{id}'],
        ['get', '/v1/mandates/{id}/link'],
        ['post', '/v1/mandates/{id}/cancel'],
        ['get', '/v1/mandates/{id}/debits'],
      ];
      for (const [method, path] of expected) {
        const op = doc.paths[path]?.[method];
        expect([method, path, op !== undefined]).toEqual([method, path, true]);
        expect(Object.keys(op?.responses ?? {}).some((s) => s.startsWith('2'))).toBe(true);
      }
    });

    it('a method that is not declared is not served', async () => {
      const res = await call('POST', `/v1/payments/${randomUUID()}`, person('a1').user, {});
      expect([404, 405]).toContain(res.statusCode);
      const del = await app.inject({
        method: 'DELETE',
        url: `/v1/mandates/${randomUUID()}`,
        remoteAddress: freshAddress(),
        headers: { authorization: token(person('a1').user) },
      });
      expect([404, 405]).toContain(del.statusCode);
    });
  });
});
