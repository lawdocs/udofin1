// Phase 08a borrower servicing over HTTP, against a REAL migrated Postgres: the loans a lender services (as the lender reported
// them), the schedule, the activity, lender-issued documents, requests for statements and quotations, the foreclosure quotation,
// closure and the service reminders. Same gating as the other integration files (INTEGRATION_ADMIN_URL and INTEGRATION_API_URL
// and a freshly migrated database). Synthetic data only.
//
// Fixtures: five lenders. A, B and E have every switch the borrower routes read turned on (servicing_sync, statements_noc,
// payments, reminders). C has servicing_sync only (the statements, payments and reminders switches are off) and D has none. E is
// the lender whose switches the kill test turns off one by one, to prove the routes read the switch on every request. Lender A has a
// profile and its own approved due-date rules, so the due dates of requests and closures carry their basis.
//
// How the rows are made: lender-issued documents, quotations, the security-release tasks and their confirmation, and the decline of
// a request go through the real SQL functions, called as a signed-in lender user (aal2) so they have the shape the database really
// produces. The borrower's requests, cancellations and reads go through the real HTTP routes. What a lender's reports and the
// system create in production (balance snapshots, schedules, lender receipts, payment attempts, provider payments, refunds,
// reminders and their delivery log) are inserted AS THE TABLE OWNER with session_replication_role = replica, which switches off
// triggers and foreign key checks for that one transaction (check constraints and unique indexes still apply).
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLocalDocumentStore, type DocumentStore } from '@udofin/adapters';
import {
  SVC_ACTIVITY_KINDS,
  SVC_ACTIVITY_PURPOSES,
  SVC_ACTIVITY_STATES,
  SVC_COLLATERAL_TYPES,
  SVC_DOCUMENT_KINDS,
  SVC_DOCUMENT_SOURCES,
  SVC_EVIDENCE_STATUSES,
  SVC_LOAN_STATUSES,
  SVC_QUOTE_SOURCES,
  SVC_REMINDER_KINDS,
  SVC_REQUEST_STATUSES,
  SvcActivityPage,
  SvcClosureResult,
  SvcDocumentRequestList,
  SvcDocumentRequestResult,
  SvcLatestQuote,
  SvcLoan,
  SvcLoanDocumentContent,
  SvcLoanDocumentList,
  SvcLoanList,
  SvcReminderList,
  SvcReminderRead,
  SvcSchedule,
} from '@udofin/contracts';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app.js';
import { TokenError, type TokenVerifier } from '../../src/auth/token-verifier.js';
import { loadConfig } from '../../src/config.js';
import { createUserContext } from '../../src/db/user-context.js';

const ADMIN = process.env.INTEGRATION_ADMIN_URL;
const API = process.env.INTEGRATION_API_URL;
const enabled = Boolean(ADMIN && API);

const fakeVerifier: TokenVerifier = {
  verify(header) {
    const match = /^Bearer test\.([0-9a-f-]{36})\.(aal1|aal2)$/.exec(header ?? '');
    if (!match?.[1] || !match[2]) return Promise.reject(new TokenError('invalid'));
    return Promise.resolve({ sub: match[1], aal: match[2] as 'aal1' | 'aal2', sessionId: null });
  },
};
let nextAddress = 1;
const freshAddress = () => `10.14.${(nextAddress >> 8) & 255}.${nextAddress++ & 255}`;

/** Makes every reference of this run unique, so a re-run on a database that was not reset cannot collide. */
const RUN = randomUUID()
  .replace(/-/g, '')
  .slice(0, 8)
  .toUpperCase()
  // Letters only: a run id with digits could form a PAN-shaped or number-shaped reference that the importer refuses.
  .replace(/[0-9]/g, (digit) => 'GHIJKLMNOP'.charAt(Number(digit)));
const digits = (n: number) => String(Math.floor(10 ** (n - 1) + Math.random() * 9 * 10 ** (n - 1)));

// Values that must never come back in a response or a log line. They are planted where a careless layer could echo them: the
// borrowers' phone numbers (auth.users), the lender receipt's bank reference and payment mode, the provider's payment and order
// references, the settlement account reference of a payment, the receipt reference, the storage keys of documents and the
// lender user who uploaded them.
const CANARY = {
  phoneB1: `91${Math.floor(7_000_000_000 + Math.random() * 2_999_999_999)}`,
  phoneB2: `91${Math.floor(7_000_000_000 + Math.random() * 2_999_999_999)}`,
  phoneB3: `91${Math.floor(7_000_000_000 + Math.random() * 2_999_999_999)}`,
  phoneB4: `91${Math.floor(7_000_000_000 + Math.random() * 2_999_999_999)}`,
  bankRef: `UTRCANARY${RUN}${digits(10)}`,
  paymentMode: `canary_mode_${RUN.toLowerCase()}`,
  providerPaymentRef: `PAYREFCANARY-${RUN}`,
  providerOrderRef: `ORDERCANARY-${RUN}`,
  settlementRef: `ACCTNO${digits(12)}`,
  receiptRef: `RCPTREFCANARY-${RUN}`,
  storagePrefix: 'servicing/',
};

interface Problem {
  code?: string;
  status?: number;
  detail?: string;
}

const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** A flat, honest PDF: no scripts, no attachments. The label makes the bytes (and so the hash) differ. */
const pdf = (label: string) =>
  Buffer.from(
    `%PDF-1.4\n% ${label}\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`,
  );
/** An ISO instant with microseconds: the millisecond part from `ms`, three more digits from `micro`. */
const isoMicro = (ms: number, micro: number) =>
  new Date(ms).toISOString().replace('Z', `${String(micro).padStart(3, '0')}Z`);
const istDate = (ms: number) => new Date(ms + 5.5 * HOUR).toISOString().slice(0, 10);
const withOptions = (url: string, options: string) =>
  `${url}${url.includes('?') ? '&' : '?'}options=${encodeURIComponent(options)}`;

interface PlannedEntry {
  kind: string;
  id: string;
  /** Epoch milliseconds and the microseconds beyond them. */
  ms: number;
  micro: number;
  state: string;
  amount: number;
  purpose: string | null;
}

describe.skipIf(!enabled)('borrower servicing over HTTP', () => {
  const ids = {
    platformOrg: randomUUID() as string,
    lenderA: randomUUID(),
    lenderB: randomUUID(),
    lenderC: randomUUID(),
    lenderD: randomUUID(),
    lenderE: randomUUID(),
    aOp: randomUUID(), // servicing_operator of A: registers documents and quotations, declines requests, confirms releases
    aOp2: randomUUID(),
    bOp: randomUUID(),
    eOp: randomUUID(),
    aViewer: randomUUID(), // a lender user: not a borrower
    nobody: randomUUID(), // a staff login with no membership anywhere
    pFeatures: randomUUID(), // platform features admin (turns a switch off)
    requester: randomUUID(), // signs the switch requests (not a member)
    decider: randomUUID(),
    ruleProposer: randomUUID(),
    ruleApprover: randomUUID(),
    b1: randomUUID(), // the borrower whose data is read
    b2: randomUUID(), // another borrower, of lenders A and B
    b3: randomUUID(), // a borrower with no loan at all
    b4: randomUUID(), // a borrower only the rate limit test uses
  };
  const borrower: Record<string, string> = {};
  const loan: Record<string, string> = {};
  let admin: pg.Pool;
  let apiPool: pg.Pool;
  let mockPool: pg.Pool;
  type App = Awaited<ReturnType<typeof buildApp>>;
  let app: App;
  let appNoStore: App;
  let appMock: App;
  let store: DocumentStore;
  let storeRoot = '';
  /** Every response body this file received, with its request, for the final scans. */
  const seen: { url: string; body: string }[] = [];
  const ruleVersion = 7000 + Math.floor(Math.random() * 900);

  const call = (
    method: 'GET' | 'POST',
    url: string,
    user: string | null,
    payload?: unknown,
    options: { aal?: 'aal1' | 'aal2'; key?: string | null; on?: App } = {},
  ) =>
    (options.on ?? app)
      .inject({
        method,
        url,
        remoteAddress: freshAddress(),
        headers: {
          ...(user ? { authorization: `Bearer test.${user}.${options.aal ?? 'aal1'}` } : {}),
          ...(method === 'POST' && options.key !== null
            ? { 'idempotency-key': options.key ?? `it-sv-${randomUUID()}` }
            : {}),
        },
        ...(payload === undefined ? {} : { payload: payload as object }),
      })
      .then((res) => {
        seen.push({ url, body: res.body });
        return res;
      });
  const get = (url: string, user: string | null, options: { on?: App } = {}) =>
    call('GET', url, user, undefined, options);
  const post = (
    url: string,
    user: string | null,
    payload: unknown = {},
    options: { key?: string | null; on?: App } = {},
  ) => call('POST', url, user, payload, options);
  const code = (res: { json: () => unknown }) => (res.json() as Problem).code;
  const problem = (res: { statusCode: number; json: () => unknown }) => [
    res.statusCode,
    (res.json() as Problem).code,
  ];
  const q = async <T extends pg.QueryResultRow>(sql: string, values: unknown[] = []) =>
    (await admin.query<T>(sql, values)).rows;
  const scalar = async <T>(sql: string, values: unknown[] = []): Promise<T> => {
    const rows = await q<{ v: T }>(sql, values);
    if (!rows[0]) throw new Error('no row');
    return rows[0].v;
  };
  const count = async (sql: string, values: unknown[] = []) =>
    Number(await scalar<string>(sql, values));

  /** Runs statements in one transaction as the table owner; `replica` also switches off triggers and foreign keys. */
  async function transaction(work: (c: pg.PoolClient) => Promise<void>, replica = false) {
    const c = await admin.connect();
    try {
      await c.query('begin');
      if (replica) await c.query('set local session_replication_role = replica');
      await work(c);
      await c.query('commit');
    } catch (error) {
      await c.query('rollback');
      throw error;
    } finally {
      c.release();
    }
  }

  /** Calls a database function as a signed-in lender (or platform) user at aal2 and COMMITS. */
  async function asUser<T extends pg.QueryResultRow = pg.QueryResultRow>(
    user: string,
    sql: string,
    values: unknown[] = [],
  ): Promise<T[]> {
    const c = await admin.connect();
    try {
      await c.query('begin');
      await c.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: user, role: 'authenticated', aal: 'aal2' }),
      ]);
      await c.query('set local role authenticated');
      const r = await c.query<T>(sql, values);
      await c.query('commit');
      return r.rows;
    } catch (error) {
      await c.query('rollback');
      throw error;
    } finally {
      c.release();
    }
  }

  async function member(org: string, user: string, kind: 'lender' | 'platform', role: string) {
    const m = await admin.query<{ id: string }>(
      'insert into tenancy.memberships (org_id, user_id, status) values ($1, $2, $3) returning id',
      [org, user, 'active'],
    );
    await admin.query(
      `insert into tenancy.membership_roles (membership_id, role_id)
         select $1, r.id from tenancy.roles r where r.org_id is null and r.applies_to = $2::tenancy.organization_kind and r.key = $3`,
      [m.rows[0]?.id, kind, role],
    );
  }

  /** An applied two-person switch request and the switch row, in ONE transaction (the only way the guard accepts it). */
  async function switchOn(lender: string, features: readonly string[]) {
    await transaction(async (c) => {
      for (const feature of features) {
        const request = await c.query<{ id: string }>(
          `insert into servicing.feature_change_requests (lender_org_id, feature, enable, mode, status, evidence, requested_by, idempotency_key, decided_by, decided_at, applied_at)
           values ($1::uuid, $2, true, 'two_person', 'applied', '{"contract_ref":"SAMPLE-SV"}', $3::uuid, $4, $5::uuid, now(), now()) returning id`,
          [
            lender,
            feature,
            ids.requester,
            `sv-req-${feature}-${lender.slice(0, 8)}-${RUN}`,
            ids.decider,
          ],
        );
        await c.query(
          `insert into servicing.lender_features (lender_org_id, feature, enabled, evidence, enabled_by, enabled_at, last_change_request_id)
           values ($1::uuid, $2, true, '{"contract_ref":"SAMPLE-SV"}', $3::uuid, now(), $4::uuid)`,
          [lender, feature, ids.decider, request.rows[0]?.id],
        );
      }
    });
  }

  /** Stores the bytes of a document under an opaque key and registers it as the lender's own, through the SQL function. */
  async function registerDocument(
    user: string,
    loanId: string,
    kind: string,
    label: string,
    o: {
      from?: string;
      to?: string;
      supersedes?: string;
      request?: string;
      issuedMsAgo?: number;
      /** A size to record that is NOT the size of the stored file (the hash stays the real one). */
      recordedSize?: number;
    } = {},
  ) {
    const bytes = pdf(`${label} ${RUN}`);
    const key = `${CANARY.storagePrefix}it-sv-${RUN}/${label}`;
    await store.put(key, bytes, { mimeType: 'application/pdf', sha256: sha256(bytes) });
    const reference = `SV-${label}-${RUN}`;
    const rows = await asUser<{ id: string }>(
      user,
      `select servicing.register_loan_document($1::uuid, $2, $3, $4, $5::bigint, 'application/pdf', $6, $7::timestamptz, $8::date, $9::date, $10::uuid, $11::uuid) as id`,
      [
        loanId,
        kind,
        key,
        sha256(bytes),
        o.recordedSize ?? bytes.length,
        reference,
        new Date(Date.now() - (o.issuedMsAgo ?? HOUR)).toISOString(),
        o.from ?? null,
        o.to ?? null,
        o.supersedes ?? null,
        o.request ?? null,
      ],
    );
    return { id: rows[0]?.id ?? '', bytes, key, reference };
  }

  /** A foreclosure quotation as the lender reports it (rupee text), through the SQL function. */
  async function recordQuote(
    user: string,
    loanId: string,
    ref: string,
    o: {
      asOfMsAgo: number;
      validForMs: number;
      parts?: [string, string, string, string];
      total: string;
      request?: string;
      letter?: string;
    },
  ) {
    const asOf = Date.now() - o.asOfMsAgo;
    const parts = o.parts ?? ['10000.00', '500.00', '100.00', '200.00'];
    const rows = await asUser<{ id: string }>(
      user,
      `select servicing.record_foreclosure_quote($1::uuid, $2, $3::timestamptz, $4::timestamptz, $5, $6, $7, $8, $9, 'lender_portal', $10::uuid, $11::uuid) as id`,
      [
        loanId,
        `${ref}-${RUN}`,
        new Date(asOf).toISOString(),
        new Date(asOf + o.validForMs).toISOString(),
        ...parts,
        o.total,
        o.request ?? null,
        o.letter ?? null,
      ],
    );
    return rows[0]?.id ?? '';
  }

  /** The access records written for a document (one per successful retrieval). */
  const accessRows = (documentId: string) =>
    q<{ actor_type: string; actor_user_id: string; purpose: string }>(
      `select actor_type, actor_user_id::text, purpose from servicing.loan_document_access where document_id = $1 order by accessed_at, id`,
      [documentId],
    );
  const requestRows = (loanId: string) =>
    q<{ id: string; status: string; kind: string }>(
      `select id::text, status, kind from servicing.document_requests where loan_account_id = $1 order by requested_at, id`,
      [loanId],
    );
  const ls = (loanKey: string) => loan[loanKey] ?? '';

  // ----------------------------------------------------------------------------------------------------------------
  // Fixture
  // ----------------------------------------------------------------------------------------------------------------
  const docs: Record<string, { id: string; bytes: Buffer; key: string; reference: string }> = {};
  const reqs: Record<string, string> = {};
  const quotes: Record<string, string> = {};
  const reminders: Record<string, string> = {};
  const reminderMessages: Record<string, string> = {};
  const REMINDER_BODY =
    'Reminder from {{lender_name}}: your instalment of {{amount}} is due on {{due_date}}.';
  const t0 = Math.floor((Date.now() - 20 * DAY) / 1000) * 1000;
  const activityPlan: PlannedEntry[] = [];
  const intentRows: Record<string, string> = {};

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: ADMIN, max: 4 });
    apiPool = new pg.Pool({ connectionString: API, max: 8 });
    // A second pool that allows the labelled mock providers: only a local or test deployment may. The first pool does NOT.
    mockPool = new pg.Pool({
      connectionString: withOptions(API ?? '', '-c udofin.allow_mock_providers=on'),
      max: 4,
    });
    storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'udofin-sv-store-'));
    store = createLocalDocumentStore(storeRoot, 'test');

    for (const id of [
      ids.aOp,
      ids.aOp2,
      ids.bOp,
      ids.eOp,
      ids.aViewer,
      ids.nobody,
      ids.pFeatures,
      ids.requester,
      ids.decider,
      ids.ruleProposer,
      ids.ruleApprover,
    ])
      await admin.query(
        `insert into auth.users (id, phone, raw_app_meta_data) values ($1, null, '{"actor_type":"staff"}')`,
        [id],
      );
    for (const [id, phone] of [
      [ids.b1, CANARY.phoneB1],
      [ids.b2, CANARY.phoneB2],
      [ids.b3, CANARY.phoneB3],
      [ids.b4, CANARY.phoneB4],
    ] as const)
      await admin.query(
        `insert into auth.users (id, phone, raw_app_meta_data) values ($1, $2, '{}')`,
        [id, phone],
      );
    for (const [key, user] of [
      ['b1', ids.b1],
      ['b2', ids.b2],
      ['b3', ids.b3],
      ['b4', ids.b4],
    ] as const)
      borrower[key] = await scalar<string>(
        'select id::text as v from identity.borrowers where user_id = $1',
        [user],
      );

    const platform = await q<{ id: string }>(
      `select id from tenancy.organizations where kind = 'platform'`,
    );
    if (platform[0]) ids.platformOrg = platform[0].id;
    else
      await admin.query(
        `insert into tenancy.organizations (id, kind, legal_name, display_name, status) values ($1, 'platform', 'Udofin Platform (it)', 'Udofin', 'active')`,
        [ids.platformOrg],
      );
    for (const [lender, name] of [
      [ids.lenderA, 'Alpha Servicing'],
      [ids.lenderB, 'Beta Servicing'],
      [ids.lenderC, 'Gamma Servicing'],
      [ids.lenderD, 'Delta Servicing'],
      [ids.lenderE, 'Epsilon Servicing'],
    ] as const) {
      await admin.query(
        `insert into tenancy.organizations (id, kind, legal_name, display_name, regulator_registration_no, status) values ($1, 'lender', $2, $3, $4, 'active')`,
        [lender, `${name} Ltd (test)`, name, `IT-SV-${lender.slice(0, 8)}`],
      );
      await admin.query(
        `insert into onboarding.lender_gates (lender_org_id, stage) values ($1, 'activated')`,
        [lender],
      );
    }
    await member(ids.lenderA, ids.aOp, 'lender', 'servicing_operator');
    await member(ids.lenderA, ids.aOp2, 'lender', 'servicing_operator');
    await member(ids.lenderA, ids.aViewer, 'lender', 'viewer');
    await member(ids.lenderB, ids.bOp, 'lender', 'servicing_operator');
    await member(ids.lenderE, ids.eOp, 'lender', 'servicing_operator');
    await member(ids.platformOrg, ids.pFeatures, 'platform', 'platform_features_admin');

    const all = ['servicing_sync', 'statements_noc', 'payments', 'reminders'];
    await switchOn(ids.lenderA, all);
    await switchOn(ids.lenderB, all);
    await switchOn(ids.lenderE, all);
    await switchOn(ids.lenderC, ['servicing_sync']); // statements, payments and reminders stay off
    // Lender D: every switch off.

    // Lender A: a profile and its own approved due-date rules (higher versions that apply to its category only, so no other
    // lender of this database is affected; the rules are retired again at the end). The due dates then carry their basis.
    await admin.query(
      `insert into onboarding.lender_profiles (lender_org_id, category_key, regulator, created_by)
       values ($1, 'other_regulated_entity', 'Reserve Bank of India', $2)`,
      [ids.lenderA, ids.ruleProposer],
    );
    await admin.query(
      `insert into documents.applicability_rules (rule_key, version, lender_category_keys, regulator, direction_ref, paragraph_refs, product_category_keys, exclusions,
         document_type, required_template_key, required_fields_version, required_acknowledgements, ack_sections, validity_rule, language_policy, effective_from,
         approval_status, evidence_status, reviewer_ref, proposed_by, approved_by, approved_at)
       select rule_key, $1::int, array['other_regulated_entity'], regulator, direction_ref, paragraph_refs, product_category_keys, exclusions,
              document_type, required_template_key, required_fields_version, required_acknowledgements, ack_sections, validity_rule, language_policy,
              date '2024-01-01', 'approved', evidence_status, 'SAMPLE reviewer', $2::uuid, $3::uuid, now()
         from documents.applicability_rules
        where version = 1 and rule_key in ('servicing.statement_sla_days_default', 'servicing.noc_sla_days_default', 'servicing.security_release_sla_days')`,
      [ruleVersion, ids.ruleProposer, ids.ruleApprover],
    );

    // Applications, then loans (normal mode, so the closure trigger opens the closure record of the closed loan).
    const loanPlan: [string, string, string, 'active' | 'closed', number][] = [
      // label, lender, borrower, status, days since disbursement
      ['A1', ids.lenderA, 'b1', 'active', 30],
      ['A2', ids.lenderA, 'b1', 'closed', 400],
      ['A3', ids.lenderA, 'b1', 'active', 20],
      ['A4', ids.lenderA, 'b1', 'active', 10],
      ['A5', ids.lenderA, 'b1', 'active', 15],
      ['AB2', ids.lenderA, 'b2', 'active', 25],
      ['BB2', ids.lenderB, 'b2', 'active', 35],
      ['C1', ids.lenderC, 'b1', 'active', 5],
      ['D1', ids.lenderD, 'b1', 'active', 6],
      ['E1', ids.lenderE, 'b1', 'active', 7],
    ];
    const apps: Record<string, string> = {};
    await transaction(async (c) => {
      for (const [label, lender, who] of loanPlan) {
        const id = randomUUID();
        apps[label] = id;
        await c.query(
          `insert into lending.applications (id, lender_org_id, loan_request_id, borrower_id, product_version_id, status, requested_amount_minor, requested_tenure_days, lender_reference)
           values ($1::uuid, $2::uuid, gen_random_uuid(), $3::uuid, gen_random_uuid(), 'disbursement_pending', 5000000, 365, $4)`,
          [id, lender, borrower[who], `SAMPLE-APP-${label}-${RUN}`],
        );
      }
    }, true);
    for (const [label, lender, , status, daysAgo] of loanPlan) {
      const id = randomUUID();
      loan[label] = id;
      await admin.query(
        `insert into servicing.loan_accounts (id, lender_org_id, application_id, borrower_id, source_system, lms_loan_ref, status, sanctioned_amount_minor,
                                              disbursed_amount_minor, disbursed_at, disbursement_reference)
         select $1::uuid, $2::uuid, a.id, a.borrower_id, 'file_import', $3, $4::servicing.loan_status, 5000000, 5000000,
                now() - make_interval(days => $5::int), $6
           from lending.applications a where a.id = $7::uuid`,
        [
          id,
          lender,
          `SV-${label}-${RUN}`,
          status,
          daysAgo,
          `FIX-DISB-${label}-${RUN}`,
          apps[label],
        ],
      );
    }

    // What the lenders reported (rows the sync would have written).
    await transaction(async (c) => {
      const snapshot = async (
        label: string,
        lender: string,
        version: number,
        hoursAgo: number,
        o: {
          status?: string;
          flags?: string[];
          outstanding?: number;
          overduePrincipal?: number;
          interest?: number;
          penal?: number;
          total?: number;
          nextDue?: number | null;
          dpd?: number;
        } = {},
      ) => {
        const id = randomUUID();
        const nextDue = o.nextDue === undefined ? 1 : o.nextDue;
        await c.query(
          `insert into servicing.balance_snapshots (id, lender_org_id, loan_account_id, version, status, outstanding_principal_minor, overdue_principal_minor,
             overdue_interest_minor, penal_charges_minor, other_charges_minor, total_overdue_minor, next_due_on, next_due_minor, days_past_due, flags,
             source_system, source_record_id, reported_as_of, content_sha256)
           values ($1::uuid, $2::uuid, $3::uuid, $4, $5::servicing.loan_status, $6, $7, $8, $9, 0, $10,
                   case when $11::int is null then null else (now() at time zone 'Asia/Kolkata')::date + $11::int end,
                   case when $11::int is null then null else 475000 end, $12, $13::text[], 'file_import', $14,
                   now() - make_interval(hours => $15::int), $16)`,
          [
            id,
            lender,
            loan[label],
            version,
            o.status ?? 'active',
            o.outstanding ?? 4_000_000,
            o.overduePrincipal ?? 100_000,
            o.interest ?? 20_000,
            o.penal ?? 5_000,
            o.total ?? 125_000,
            nextDue,
            o.dpd ?? 3,
            o.flags ?? [],
            `FIX-SRC-${label}-${String(version)}-${RUN}`,
            hoursAgo,
            sha256(`snapshot-${label}-${String(version)}-${RUN}`),
          ],
        );
        return id;
      };
      await snapshot('A1', ids.lenderA, 1, 3, { total: 120_000 });
      await snapshot('A1', ids.lenderA, 2, 1);
      await snapshot('A2', ids.lenderA, 1, 72, {
        status: 'closed',
        outstanding: 0,
        overduePrincipal: 0,
        interest: 0,
        penal: 0,
        total: 0,
        nextDue: null,
        dpd: 0,
      });
      const a3 = await snapshot('A3', ids.lenderA, 1, 2, { flags: ['overdue_total_mismatch'] });
      await c.query(
        `insert into servicing.sync_anomalies (lender_org_id, loan_account_id, kind, severity, snapshot_id, previous_amount_minor, reported_amount_minor,
           source_system, source_record_id, content_sha256, reported_as_of)
         values ($1::uuid, $2::uuid, 'overdue_total_mismatch', 'warning', $3::uuid, 125000, 130000, 'file_import', $4, $5, now() - interval '2 hours')`,
        [ids.lenderA, loan.A3, a3, `FIX-ANOM-A3-${RUN}`, sha256(`anomaly-A3-${RUN}`)],
      );
      await snapshot('A5', ids.lenderA, 1, 2);
      for (const recordType of ['loan', 'schedule'])
        await c.query(
          `insert into servicing.sync_conflicts (lender_org_id, loan_account_id, record_type, conflict_reason, source_record_id, existing_content_sha256,
             existing_reported_as_of, incoming_content_sha256, incoming_reported_as_of, incoming_report, source_system)
           values ($1::uuid, $2::uuid, $3, 'same_time_different_content', $4, $5, now() - interval '1 hour', $6, now() - interval '1 hour', $7::jsonb, 'file_import')`,
          [
            ids.lenderA,
            loan.A5,
            recordType,
            `FIX-CONFLICT-${recordType}-${RUN}`,
            sha256(`existing-${recordType}-${RUN}`),
            sha256(`incoming-${recordType}-${RUN}`),
            JSON.stringify({
              lms_loan_ref: `SV-A5-${RUN}`,
              source_record_id: `FIX-CONFLICT-${recordType}-${RUN}`,
            }),
          ],
        );
      await snapshot('AB2', ids.lenderA, 1, 2);
      await snapshot('BB2', ids.lenderB, 1, 2);
      await snapshot('C1', ids.lenderC, 1, 1);
      await snapshot('D1', ids.lenderD, 1, 2);
      await snapshot('E1', ids.lenderE, 1, 1);

      // Schedules: A1 has two versions (the newest, version 2, has three installments, the last with a fee); A3 and E1 have one; A5
      // has one that an unresolved schedule conflict withholds.
      const schedule = async (
        label: string,
        lender: string,
        version: number,
        hoursAgo: number,
        installments: number,
        feeOnLast = 0,
      ) => {
        const sid = randomUUID();
        await c.query(
          `insert into servicing.schedule_snapshots (id, lender_org_id, loan_account_id, version, reported_as_of)
           values ($1::uuid, $2::uuid, $3::uuid, $4, now() - make_interval(hours => $5::int))`,
          [sid, lender, loan[label], version, hoursAgo],
        );
        for (let seq = 1; seq <= installments; seq += 1)
          await c.query(
            `insert into servicing.schedule_installments (snapshot_id, lender_org_id, seq, due_date, principal_minor, interest_minor, fees_minor)
             values ($1::uuid, $2::uuid, $3, (now() at time zone 'Asia/Kolkata')::date + $4::int, 400000, 75000, $5)`,
            [sid, lender, seq, seq * 30, seq === installments ? feeOnLast : 0],
          );
      };
      await schedule('A1', ids.lenderA, 1, 6, 1);
      await schedule('A1', ids.lenderA, 2, 4, 3, 1_000);
      await schedule('A3', ids.lenderA, 1, 4, 2);
      await schedule('A5', ids.lenderA, 1, 4, 2);
      await schedule('E1', ids.lenderE, 1, 4, 2);
    }, true);

    // Lender receipts and payment attempts. Loan A1 gets twelve entries whose times are chosen to break a careless cursor: three
    // entries inside one millisecond (microseconds apart) and two at exactly the same instant (ordered by id).
    const at = (hours: number, micro = 0) => ({ ms: t0 + hours * HOUR, micro });
    const plan = (
      kind: string,
      key: string,
      when: { ms: number; micro: number },
      state: string,
      amount: number,
      purpose: string | null,
    ) => {
      const id = randomUUID();
      intentRows[key] = id;
      activityPlan.push({ kind, id, ...when, state, amount, purpose });
      return id;
    };
    const pRecvIntent = plan(
      'payment_attempt',
      'iRecv',
      at(7),
      'provider_received',
      950_000,
      'overdue',
    );
    const pPostedIntent = plan(
      'payment_attempt',
      'iPosted',
      at(6),
      'lender_posted',
      1_200_000,
      'part_prepayment',
    );
    const pAttnIntent = plan(
      'payment_attempt',
      'iAttn',
      at(6),
      'needs_attention',
      475_000,
      'installment',
    );
    const pStartIntent = plan(
      'payment_attempt',
      'iStart',
      at(5, 100),
      'started',
      475_000,
      'installment',
    );
    const rPosted3 = plan('lender_receipt', 'r3', at(5, 500), 'posted', 475_000, null);
    const adjustment = plan('payment_adjustment', 'adj', at(5, 900), 'refund', 100_000, null);
    const iExp = plan('payment_attempt', 'iExp', at(4), 'expired', 475_000, 'installment');
    const iFail = plan('payment_attempt', 'iFail', at(3), 'failed', 475_000, 'installment');
    // r1 is reversed in full (a receipt counts as reversed only when the reversals add up to its amount), r3 by part only.
    const r1r = plan('lender_reversal', 'r1r', at(2), 'recorded', 475_000, null);
    const r3r = plan('lender_reversal', 'r3r', at(7), 'recorded', 100_000, null);
    const iCancel = plan('payment_attempt', 'iCancel', at(1), 'cancelled', 475_000, 'installment');
    const r1 = plan('lender_receipt', 'r1', at(0), 'reversed', 475_000, null);
    const rPosted = plan('lender_receipt', 'rPosted', at(6.5), 'posted', 1_200_000, null);

    await transaction(async (c) => {
      const intent = async (
        label: string,
        lender: string,
        who: string,
        id: string,
        n: number,
        purpose: string,
        status: string,
        amount: number,
        createdIso: string,
      ) => {
        await c.query(
          `insert into payments.payment_intents (id, lender_org_id, loan_account_id, borrower_id, purpose, amount_minor, settlement_account_ref, provider,
                                                 provider_order_ref, idempotency_key, status, created_at, updated_at)
           values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::payments.intent_purpose, $6, $7, 'mock_gateway_sv', $8, $9, $10::payments.intent_status,
                   $11::timestamptz, $11::timestamptz)`,
          [
            id,
            lender,
            loan[label],
            borrower[who],
            purpose,
            amount,
            CANARY.settlementRef,
            `${CANARY.providerOrderRef}-${String(n)}`,
            `it-sv-intent-${RUN}-${String(n)}-${label}`,
            status,
            createdIso,
          ],
        );
      };
      const providerPayment = async (
        label: string,
        lender: string,
        intentId: string,
        n: number,
        amount: number,
      ) => {
        const id = randomUUID();
        await c.query(
          `insert into payments.provider_payments (id, lender_org_id, config_id, provider, provider_payment_ref, order_ref, intent_id, loan_account_id, status,
                                                   rank, amount_minor, currency, captured_at, first_event_id, last_event_id)
           values ($1::uuid, $2::uuid, gen_random_uuid(), 'mock_gateway_sv', $3, $4, $5::uuid, $6::uuid, 'captured', 30, $7, 'INR', now(), gen_random_uuid(), gen_random_uuid())`,
          [
            id,
            lender,
            `${CANARY.providerPaymentRef}-${String(n)}`,
            `${CANARY.providerOrderRef}-${String(n)}`,
            intentId,
            loan[label],
            amount,
          ],
        );
        return id;
      };
      const receipt = async (
        label: string,
        lender: string,
        id: string,
        n: number,
        o: {
          kind?: 'receipt' | 'reversal';
          at: { ms: number; micro: number };
          amount: number;
          bankRef?: string;
          reverses?: { id: string; ref: string };
        },
      ) => {
        const stamp = isoMicro(o.at.ms, o.at.micro);
        await c.query(
          `insert into servicing.lms_receipts (id, lender_org_id, loan_account_id, kind, lms_receipt_ref, reverses_receipt_id, reverses_receipt_ref, amount_minor,
             value_date, payment_mode, bank_reference, source_system, source_record_id, reported_as_of, received_at, content_sha256)
           values ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::uuid, $7, $8, $9::date, $10, $11, 'file_import', $12, $13::timestamptz, $13::timestamptz, $14)`,
          [
            id,
            lender,
            loan[label],
            o.kind ?? 'receipt',
            `${CANARY.receiptRef}-${String(n)}-${label}`,
            o.reverses?.id ?? null,
            o.reverses?.ref ?? null,
            o.amount,
            istDate(o.at.ms),
            CANARY.paymentMode,
            o.bankRef ?? CANARY.bankRef,
            `FIX-RCPT-${String(n)}-${label}-${RUN}`,
            stamp,
            sha256(`receipt-${String(n)}-${label}-${RUN}`),
          ],
        );
      };
      const a = (hours: number, micro = 0) => isoMicro(t0 + hours * HOUR, micro);
      // The lender's receipts.
      await receipt('A1', ids.lenderA, r1, 1, { at: at(0), amount: 475_000 });
      await receipt('A1', ids.lenderA, r1r, 2, {
        kind: 'reversal',
        at: at(2),
        amount: 475_000,
        reverses: { id: r1, ref: `${CANARY.receiptRef}-1-A1` },
      });
      await receipt('A1', ids.lenderA, rPosted3, 3, { at: at(5, 500), amount: 475_000 });
      await receipt('A1', ids.lenderA, r3r, 6, {
        kind: 'reversal',
        at: at(7),
        amount: 100_000,
        reverses: { id: rPosted3, ref: `${CANARY.receiptRef}-3-A1` },
      });
      // The payment attempts (the terminal ones first; only iStart is open).
      await intent('A1', ids.lenderA, 'b1', iCancel, 1, 'installment', 'cancelled', 475_000, a(1));
      await intent('A1', ids.lenderA, 'b1', iFail, 2, 'installment', 'failed', 475_000, a(3));
      await intent('A1', ids.lenderA, 'b1', iExp, 3, 'installment', 'expired', 475_000, a(4));
      await intent(
        'A1',
        ids.lenderA,
        'b1',
        pStartIntent,
        4,
        'installment',
        'pending',
        475_000,
        a(5, 100),
      );
      await intent(
        'A1',
        ids.lenderA,
        'b1',
        pAttnIntent,
        5,
        'installment',
        'succeeded',
        475_000,
        a(6),
      );
      await intent(
        'A1',
        ids.lenderA,
        'b1',
        pPostedIntent,
        6,
        'part_prepayment',
        'succeeded',
        1_200_000,
        a(6),
      );
      await intent('A1', ids.lenderA, 'b1', pRecvIntent, 7, 'overdue', 'succeeded', 950_000, a(7));
      // What the provider reported: money for iRecv, a different amount for iAttn (and a refund of that payment: any refund, partial
      // included, makes the borrower stage needs_attention, so it is attached to a payment that needs attention already and leaves
      // iRecv as the plain provider_received), the right amount for iPosted.
      await providerPayment('A1', ids.lenderA, pRecvIntent, 7, 950_000);
      const ppAttn = await providerPayment('A1', ids.lenderA, pAttnIntent, 5, 400_000);
      await providerPayment('A1', ids.lenderA, pPostedIntent, 6, 1_200_000);
      await c.query(
        `insert into payments.payment_adjustments (id, lender_org_id, provider_payment_id, kind, object_ref, amount_minor, source_event_id, occurred_at)
         values ($1::uuid, $2::uuid, $3::uuid, 'refund', $4, 100000, gen_random_uuid(), $5::timestamptz)`,
        [adjustment, ids.lenderA, ppAttn, `${CANARY.providerPaymentRef}-REFUND`, a(5, 900)],
      );
      // The lender's own receipt for iPosted carries the provider's payment reference: that is what makes it lender_posted.
      await receipt('A1', ids.lenderA, rPosted, 4, {
        at: at(6.5),
        amount: 1_200_000,
        bankRef: `${CANARY.providerPaymentRef}-6`,
      });
      // Loans C1 and E1: one receipt each; E1 also has one open payment attempt (the kill test turns the payments switch off).
      await receipt('C1', ids.lenderC, randomUUID(), 1, { at: at(0), amount: 250_000 });
      await receipt('E1', ids.lenderE, randomUUID(), 1, { at: at(0), amount: 250_000 });
      await intent(
        'E1',
        ids.lenderE,
        'b1',
        randomUUID(),
        8,
        'installment',
        'pending',
        475_000,
        a(2),
      );
      // Loan AB2 (the other borrower): a receipt and an open attempt, never to be seen by b1.
      await receipt('AB2', ids.lenderA, randomUUID(), 1, { at: at(0), amount: 333_000 });
      await intent(
        'AB2',
        ids.lenderA,
        'b2',
        randomUUID(),
        9,
        'installment',
        'pending',
        333_000,
        a(2),
      );
    }, true);

    // Lender-issued documents and quotations, through the real SQL functions as a lender user.
    const dateAgo = (days: number) => istDate(Date.now() - days * DAY);
    docs.stmt1 = await registerDocument(ids.aOp, ls('A1'), 'statement', 'stmt1', {
      from: dateAgo(60),
      to: dateAgo(30),
      issuedMsAgo: 5 * HOUR,
    });
    docs.stmt2 = await registerDocument(ids.aOp, ls('A1'), 'statement', 'stmt2', {
      from: dateAgo(60),
      to: dateAgo(30),
      supersedes: docs.stmt1.id,
      issuedMsAgo: 2 * HOUR,
    });
    docs.letter = await registerDocument(ids.aOp, ls('A1'), 'foreclosure_quote', 'letter', {
      issuedMsAgo: 3 * HOUR,
    });
    docs.ab2 = await registerDocument(ids.aOp, ls('AB2'), 'statement', 'ab2stmt', {
      from: dateAgo(60),
      to: dateAgo(30),
    });
    docs.e1 = await registerDocument(ids.eOp, ls('E1'), 'statement', 'e1stmt', {
      from: dateAgo(60),
      to: dateAgo(30),
    });
    quotes.q1 = await recordQuote(ids.aOp, ls('A1'), 'QUOTE-1', {
      asOfMsAgo: 3 * HOUR,
      validForMs: 30 * HOUR,
      total: '10800.00',
      letter: docs.letter.id,
    });
    // History: a quotation that expired days ago.
    quotes.old = await recordQuote(ids.aOp, ls('A1'), 'QUOTE-OLD', {
      asOfMsAgo: 4 * DAY,
      validForMs: DAY,
      total: '10800.00',
    });
    quotes.ab2 = await recordQuote(ids.aOp, ls('AB2'), 'QUOTE-AB2', {
      asOfMsAgo: HOUR,
      validForMs: 20 * HOUR,
      total: '10800.00',
    });

    // A statement of lender C, whose statements switch is off (the function refuses it, so the table owner plants it), and a
    // labelled MOCK statement and quotation on A3 (allowed only in a session that allows mock providers).
    {
      const bytes = pdf(`c1 ${RUN}`);
      const key = `${CANARY.storagePrefix}it-sv-${RUN}/c1stmt`;
      await store.put(key, bytes, { mimeType: 'application/pdf', sha256: sha256(bytes) });
      docs.c1 = { id: randomUUID(), bytes, key, reference: `SV-c1stmt-${RUN}` };
      await admin.query(
        `insert into servicing.loan_documents (id, lender_org_id, loan_account_id, kind, lender_reference, issued_at, period_from, period_to, storage_key, sha256,
                                               size_bytes, source, uploaded_by)
         values ($1::uuid, $2::uuid, $3::uuid, 'statement', $4, now() - interval '1 hour', $5::date, $6::date, $7, $8, $9, 'lender_upload', $10::uuid)`,
        [
          docs.c1.id,
          ids.lenderC,
          ls('C1'),
          docs.c1.reference,
          dateAgo(60),
          dateAgo(30),
          key,
          sha256(bytes),
          bytes.length,
          ids.aOp,
        ],
      );
      const mockBytes = pdf(`mock ${RUN}`);
      const mockKey = `${CANARY.storagePrefix}it-sv-${RUN}/mockstmt`;
      await store.put(mockKey, mockBytes, {
        mimeType: 'application/pdf',
        sha256: sha256(mockBytes),
      });
      docs.mock = {
        id: randomUUID(),
        bytes: mockBytes,
        key: mockKey,
        reference: `SV-mockstmt-${RUN}`,
      };
      await transaction(async (c) => {
        await c.query(`select set_config('udofin.allow_mock_providers', 'on', true)`);
        await c.query(
          `insert into servicing.loan_documents (id, lender_org_id, loan_account_id, kind, lender_reference, issued_at, period_from, period_to, storage_key, sha256,
                                                 size_bytes, source)
           values ($1::uuid, $2::uuid, $3::uuid, 'statement', $4, now() - interval '1 hour', $5::date, $6::date, $7, $8, $9, 'mock')`,
          [
            docs.mock?.id,
            ids.lenderA,
            ls('A3'),
            docs.mock?.reference,
            dateAgo(60),
            dateAgo(30),
            mockKey,
            sha256(mockBytes),
            mockBytes.length,
          ],
        );
        const mockQuote = await c.query<{ id: string }>(
          `insert into servicing.foreclosure_quotes (lender_org_id, loan_account_id, lender_quote_ref, as_of, valid_until, principal_minor, interest_minor, charges_minor,
                                                     prepayment_charge_minor, total_minor, source)
           values ($1::uuid, $2::uuid, $3, now() - interval '1 hour', now() + interval '20 hours', 1000000, 50000, 10000, 20000, 1080000, 'mock') returning id::text`,
          [ids.lenderA, ls('A3'), `QUOTE-MOCK-${RUN}`],
        );
        quotes.mock = mockQuote.rows[0]?.id ?? '';
      });
    }

    // Reminders: approved wording per lender (a draft by one person, approved by another), then sent messages, a sent message
    // whose wording no longer matches the hash stored when it was sent, a message that was only planned, and the delivery log.
    const templates: Record<string, { id: string; body: string }> = {};
    await transaction(async (c) => {
      for (const [key, lender] of [
        ['A', ids.lenderA],
        ['C', ids.lenderC],
        ['E', ids.lenderE],
      ] as const) {
        const id = randomUUID();
        templates[key] = { id, body: REMINDER_BODY };
        await c.query(
          `insert into servicing.reminder_templates (id, lender_org_id, kind, language, version, status, body, body_sha256, drafted_by, approved_by, approved_at)
           values ($1::uuid, $2::uuid, 'pre_due', 'en', 1, 'approved', $3, $4, $5::uuid, $6::uuid, now())`,
          [id, lender, REMINDER_BODY, sha256(REMINDER_BODY), ids.ruleProposer, ids.ruleApprover],
        );
      }
      const dueDueBody =
        'Service message from {{lender_name}}: your instalment of {{amount}} falls due today, {{due_date}}.';
      templates.Adue = { id: randomUUID(), body: dueDueBody };
      await c.query(
        `insert into servicing.reminder_templates (id, lender_org_id, kind, language, version, status, body, body_sha256, drafted_by, approved_by, approved_at)
         values ($1::uuid, $2::uuid, 'due_day', 'en', 1, 'approved', $3, $4, $5::uuid, $6::uuid, now())`,
        [
          templates.Adue.id,
          ids.lenderA,
          dueDueBody,
          sha256(dueDueBody),
          ids.ruleProposer,
          ids.ruleApprover,
        ],
      );
      const policy = randomUUID();
      const plant = async (
        key: string,
        o: {
          lender: string;
          label: string;
          who: string;
          template: { id: string; body: string };
          seq: number;
          offset: number;
          channels: ('in_app' | 'push')[];
          status: 'sent' | 'planned';
          hashOk?: boolean;
          lenderName: string;
          amount: number;
          sentMsAgo: number;
        },
      ) => {
        const vars = JSON.stringify({
          due_date: istDate(Date.now() + 3 * DAY),
          amount_minor: o.amount,
          lender_name: o.lenderName,
        });
        const rendered = await c.query<{ m: string }>(
          'select private.render_reminder($1, $2::jsonb, null) as m',
          [o.template.body, vars],
        );
        const message = rendered.rows[0]?.m ?? '';
        const hash = sha256(o.hashOk === false ? `${message} (edited later)` : message);
        for (const [n, channel] of o.channels.entries()) {
          const id = randomUUID();
          if (n === 0) reminders[key] = id;
          else reminders[`${key}.${channel}`] = id;
          await c.query(
            `insert into servicing.reminders (id, lender_org_id, loan_account_id, borrower_id, policy_id, installment_seq, due_date, offset_days, channel,
               scheduled_for, status, attempts, claimed_at, template_id, language_used, variables, content_sha256)
             values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, (now() at time zone 'Asia/Kolkata')::date + 3, $7, $8, now() - make_interval(secs => $9::int / 1000),
                     $10, $11, now(), $12::uuid, 'en', $13::jsonb, $14)`,
            [
              id,
              o.lender,
              loan[o.label],
              borrower[o.who],
              policy,
              o.seq,
              o.offset,
              channel,
              o.sentMsAgo,
              o.status,
              o.status === 'sent' ? 1 : 0,
              o.template.id,
              vars,
              hash,
            ],
          );
          if (o.status === 'sent')
            await c.query(
              `insert into servicing.reminder_deliveries (reminder_id, lender_org_id, channel, state, source, content_sha256, occurred_at)
               values ($1::uuid, $2::uuid, $3, 'accepted', 'send', $4, now() - make_interval(secs => ($5::int - $6::int) / 1000))`,
              [id, o.lender, channel, hash, o.sentMsAgo, n * 1000],
            );
        }
        return message;
      };
      const base = { lender: ids.lenderA, label: 'A1', who: 'b1', lenderName: 'Alpha Servicing' };
      reminderMessages.ra1 = await plant('ra1', {
        ...base,
        template: templates.A ?? { id: '', body: '' },
        seq: 1,
        offset: -3,
        channels: ['in_app', 'push'],
        status: 'sent',
        amount: 475_000,
        sentMsAgo: 2 * HOUR,
      });
      reminderMessages.ra2 = await plant('ra2', {
        ...base,
        template: templates.Adue ?? { id: '', body: '' },
        seq: 2,
        offset: 0,
        channels: ['in_app'],
        status: 'sent',
        amount: 475_000,
        sentMsAgo: HOUR,
      });
      await plant('ra3', {
        ...base,
        template: templates.A ?? { id: '', body: '' },
        seq: 3,
        offset: -3,
        channels: ['in_app'],
        status: 'sent',
        hashOk: false,
        amount: 475_000,
        sentMsAgo: 3 * HOUR,
      });
      await plant('ra4', {
        ...base,
        template: templates.Adue ?? { id: '', body: '' },
        seq: 3,
        offset: 0,
        channels: ['in_app'],
        status: 'planned',
        amount: 475_000,
        sentMsAgo: 0,
      });
      await plant('rb2', {
        ...base,
        label: 'AB2',
        who: 'b2',
        template: templates.A ?? { id: '', body: '' },
        seq: 1,
        offset: -3,
        channels: ['in_app'],
        status: 'sent',
        amount: 333_000,
        sentMsAgo: HOUR,
      });
      await plant('rc1', {
        lender: ids.lenderC,
        label: 'C1',
        who: 'b1',
        lenderName: 'Gamma Servicing',
        template: templates.C ?? { id: '', body: '' },
        seq: 1,
        offset: -3,
        channels: ['in_app'],
        status: 'sent',
        amount: 250_000,
        sentMsAgo: HOUR,
      });
      reminderMessages.re1 = await plant('re1', {
        lender: ids.lenderE,
        label: 'E1',
        who: 'b1',
        lenderName: 'Epsilon Servicing',
        template: templates.E ?? { id: '', body: '' },
        seq: 1,
        offset: -3,
        channels: ['in_app'],
        status: 'sent',
        amount: 250_000,
        sentMsAgo: 30 * 60_000,
      });
    }, true);

    const config = loadConfig({ APP_ENV: 'test', RATE_LIMIT_PRINCIPAL_MAX_PER_MINUTE: '100000' });
    const auth = { verifier: fakeVerifier, context: createUserContext(apiPool) };
    app = await buildApp(config, { auth, documents: store });
    appNoStore = await buildApp(config, { auth });
    appMock = await buildApp(config, {
      auth: { verifier: fakeVerifier, context: createUserContext(mockPool) },
      documents: store,
    });
  }, 240_000);

  afterAll(async () => {
    await Promise.all([app?.close(), appNoStore?.close(), appMock?.close()]);
    // Leave nothing behind for another file to trip over. The integration files share one database and some assert on
    // database-wide facts: that every rule is still a draft (documents), that no payment adjustment exists (scheduled jobs),
    // what is pending in the outbox (workers). Triggers and foreign keys are off for this one transaction (append-only triggers
    // would refuse a delete), and every statement is scoped to this file's five lenders. The organisations, their onboarding
    // gates and profile, the people and their memberships stay, like in the other files (the platform account listing
    // expects every lender organisation to have a gate).
    if (admin) {
      const mine = [ids.lenderA, ids.lenderB, ids.lenderC, ids.lenderD, ids.lenderE];
      const c = await admin.connect();
      try {
        await c.query('begin');
        await c.query('set local session_replication_role = replica');
        await c.query(
          `update ops.outbox_events set status = 'completed', completed_at = now(), locked_by = null, locked_until = null
            where status in ('pending', 'processing') and payload ->> 'lender_org_id' = any($1::text[])`,
          [mine],
        );
        for (const table of [
          'payments.payment_adjustments',
          'payments.provider_payments',
          'payments.payment_intents',
          'servicing.reminder_deliveries',
          'servicing.reminders',
          'servicing.reminder_templates',
          'servicing.sync_anomalies',
          'servicing.sync_conflicts',
          'servicing.schedule_installments',
          'servicing.schedule_snapshots',
          'servicing.balance_snapshots',
          'servicing.lms_receipts',
          'servicing.foreclosure_quotes',
          'servicing.loan_document_access',
          'servicing.loan_documents',
          'servicing.document_requests',
          'servicing.security_release_tasks',
          'servicing.closure_records',
          'servicing.loan_account_events',
          'servicing.loan_accounts',
          'servicing.lender_features',
          'servicing.feature_change_requests',
          'lending.applications',
        ])
          await c.query(`delete from ${table} where lender_org_id = any($1::uuid[])`, [mine]);
        // This file's approved due-date rules (version above) go last: the three tables that pointed at them are gone.
        await c.query(
          `delete from documents.applicability_rules
            where version = $1 and rule_key in ('servicing.statement_sla_days_default', 'servicing.noc_sla_days_default', 'servicing.security_release_sla_days')`,
          [ruleVersion],
        );
        await c.query('commit');
      } catch (error) {
        await c.query('rollback');
        throw error;
      } finally {
        c.release();
      }
    }
    await Promise.all([admin?.end(), apiPool?.end(), mockPool?.end()]);
    if (storeRoot) fs.rmSync(storeRoot, { recursive: true, force: true });
  });

  // ================================================================================================================
  // Who may call, and what a bad request looks like
  // ================================================================================================================
  /** Every borrower route, with the ids it needs. */
  const allRoutes = (loanId: string, docId: string, requestId: string, reminderId: string) =>
    [
      ['GET', '/v1/loans'],
      ['GET', `/v1/loans/${loanId}`],
      ['GET', `/v1/loans/${loanId}/schedule`],
      ['GET', `/v1/loans/${loanId}/activity`],
      ['GET', `/v1/loans/${loanId}/documents`],
      ['GET', `/v1/loans/${loanId}/documents/${docId}/content`],
      ['POST', `/v1/loans/${loanId}/statements`],
      ['POST', `/v1/loans/${loanId}/foreclosure-quotes`],
      ['GET', `/v1/loans/${loanId}/foreclosure-quotes/latest`],
      ['GET', `/v1/loans/${loanId}/document-requests`],
      ['POST', `/v1/loans/${loanId}/document-requests/${requestId}/cancel`],
      ['GET', `/v1/loans/${loanId}/closure`],
      ['GET', '/v1/me/reminders'],
      ['POST', `/v1/me/reminders/${reminderId}/read`],
    ] as const;

  describe('callers and request shape', () => {
    it('answers 401 to an anonymous caller on every route', async () => {
      for (const [method, url] of allRoutes(
        ls('A1'),
        docs.stmt2?.id ?? '',
        randomUUID(),
        randomUUID(),
      )) {
        const res = await call(method, url, null, method === 'POST' ? {} : undefined);
        expect([method, url, res.statusCode]).toEqual([method, url, 401]);
        expect(code(res)).toMatch(/^token_/);
      }
      expect(await requestRows(ls('A1'))).toHaveLength(0);
    });

    it('answers 403 to a lender user and to a login with no access, on every route', async () => {
      for (const [user, expected] of [
        [ids.aViewer, 'borrower_only'],
        [ids.aOp, 'borrower_only'],
        [ids.nobody, 'no_active_access'],
      ] as const)
        for (const [method, url] of allRoutes(
          ls('A1'),
          docs.stmt2?.id ?? '',
          randomUUID(),
          randomUUID(),
        )) {
          const res = await call(method, url, user, method === 'POST' ? {} : undefined, {
            aal: 'aal2',
          });
          expect([user, method, url, res.statusCode, code(res)]).toEqual([
            user,
            method,
            url,
            403,
            expected,
          ]);
        }
      expect(await requestRows(ls('A1'))).toHaveLength(0);
    });

    it('refuses a malformed path, query or body with 422 and names no value', async () => {
      const badId = '/v1/loans/not-a-uuid';
      for (const url of [
        badId,
        `${badId}/schedule`,
        `${badId}/activity`,
        `${badId}/documents`,
        `${badId}/closure`,
        `${badId}/foreclosure-quotes/latest`,
        `${badId}/document-requests`,
        `/v1/loans/${ls('A1')}/documents/not-a-uuid/content`,
      ]) {
        const res = await get(url, ids.b1);
        expect([url, ...problem(res)]).toEqual([url, 422, 'validation_failed']);
        expect(res.body).not.toContain('not-a-uuid');
      }
      for (const url of [
        `${badId}/statements`,
        `${badId}/foreclosure-quotes`,
        `/v1/loans/${ls('A1')}/document-requests/not-a-uuid/cancel`,
        '/v1/me/reminders/not-a-uuid/read',
      ])
        expect([url, ...problem(await post(url, ids.b1))]).toEqual([url, 422, 'validation_failed']);
      for (const query of ['limit=0', 'limit=51', 'limit=abc', 'limit=1.5', 'extra=1', 'cursor=']) {
        const res = await get(`/v1/loans/${ls('A1')}/activity?${query}`, ids.b1);
        expect([query, ...problem(res)]).toEqual([query, 422, 'validation_failed']);
      }
      expect(
        problem(await get(`/v1/loans/${ls('A1')}/activity?cursor=not-a-cursor`, ids.b1)),
      ).toEqual([400, 'invalid_cursor']);
      const forged = Buffer.from(
        JSON.stringify({ t: "2026-01-01'; drop table x;--", id: randomUUID() }),
      ).toString('base64url');
      expect(problem(await get(`/v1/loans/${ls('A1')}/activity?cursor=${forged}`, ids.b1))).toEqual(
        [400, 'invalid_cursor'],
      );
      for (const body of [
        { periodFrom: 'yesterday', periodTo: '2026-01-02' },
        { extra: true },
        { periodTo: 20260102 },
        [],
      ]) {
        const res = await post(`/v1/loans/${ls('A4')}/statements`, ids.b1, body);
        expect([JSON.stringify(body), ...problem(res)]).toEqual([
          JSON.stringify(body),
          422,
          'validation_failed',
        ]);
      }
      expect(await requestRows(ls('A4'))).toHaveLength(0);
      const purpose = await get(
        `/v1/loans/${ls('A1')}/documents/${docs.stmt2?.id ?? ''}/content?purpose=edit`,
        ids.b1,
      );
      expect(problem(purpose)).toEqual([422, 'validation_failed']);
    });

    it('requires an Idempotency-Key on every POST and refuses one of the wrong shape', async () => {
      for (const url of [
        `/v1/loans/${ls('A4')}/statements`,
        `/v1/loans/${ls('A4')}/foreclosure-quotes`,
        `/v1/loans/${ls('A4')}/document-requests/${randomUUID()}/cancel`,
        `/v1/me/reminders/${randomUUID()}/read`,
      ]) {
        expect([url, ...problem(await post(url, ids.b1, {}, { key: null }))]).toEqual([
          url,
          400,
          'idempotency_key_required',
        ]);
        expect([url, ...problem(await post(url, ids.b1, {}, { key: 'short' }))]).toEqual([
          url,
          400,
          'idempotency_key_required',
        ]);
      }
      expect(await requestRows(ls('A4'))).toHaveLength(0);
    });
  });

  // ================================================================================================================
  // Loans
  // ================================================================================================================
  describe('loans', () => {
    const newestSnapshot = (label: string) =>
      q<{ reported_as_of: string; received_at: string; next_due_on: string }>(
        `select (to_jsonb(reported_as_of) #>> '{}') as reported_as_of, (to_jsonb(received_at) #>> '{}') as received_at,
                to_char(next_due_on, 'YYYY-MM-DD') as next_due_on
           from servicing.balance_snapshots where loan_account_id = $1 order by reported_as_of desc, version desc limit 1`,
        [ls(label)],
      );
    const listOf = async (user: string) =>
      SvcLoanList.parse((await get('/v1/loans', user)).json()).items;

    it("lists the caller's own loans, newest disbursement first, and only what the lender reported", async () => {
      const res = await get('/v1/loans', ids.b1);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const list = SvcLoanList.parse(res.json());
      // D1 belongs to a lender whose servicing switch is off: it is not listed. Nothing of the other borrower is.
      expect(list.items.map((i) => i.loanId)).toEqual([
        ls('C1'),
        ls('E1'),
        ls('A4'),
        ls('A5'),
        ls('A3'),
        ls('A1'),
        ls('A2'),
      ]);
      const a1 = list.items.find((i) => i.loanId === ls('A1'));
      const [snap] = await newestSnapshot('A1');
      expect(a1).toEqual({
        loanId: ls('A1'),
        lenderId: ids.lenderA,
        lenderDisplayName: 'Alpha Servicing',
        lenderLoanRef: `SV-A1-${RUN}`,
        loanStatus: 'active',
        sanctionedAmountMinor: 5_000_000,
        disbursedAmountMinor: 5_000_000,
        disbursedAt: expect.any(String) as string,
        reportedAsOf: snap?.reported_as_of,
        receivedAt: snap?.received_at,
        stale: false,
        staleThresholdMinutes: 1440,
        figuresAvailable: true,
        reportedStatus: 'active',
        outstandingPrincipalMinor: 4_000_000,
        overduePrincipalMinor: 100_000,
        overdueInterestMinor: 20_000,
        penalChargesMinor: 5_000,
        otherChargesMinor: 0,
        totalOverdueMinor: 125_000,
        nextDueOn: snap?.next_due_on,
        nextDueMinor: 475_000,
        daysPastDue: 3,
      });
    });

    it('says stale for an old report, and withholds every figure as null (never zero) when the report is under review or missing', async () => {
      const items = await listOf(ids.b1);
      const by = (label: string) => items.find((i) => i.loanId === ls(label));
      // A closed loan whose last report is three days old: stale, but the figures are the lender's and are shown.
      expect(by('A2')).toMatchObject({
        loanStatus: 'closed',
        reportedStatus: 'closed',
        stale: true,
        figuresAvailable: true,
        outstandingPrincipalMinor: 0,
        totalOverdueMinor: 0,
        nextDueOn: null,
        nextDueMinor: null,
      });
      const figureKeys = [
        'reportedStatus',
        'outstandingPrincipalMinor',
        'overduePrincipalMinor',
        'overdueInterestMinor',
        'penalChargesMinor',
        'otherChargesMinor',
        'totalOverdueMinor',
        'nextDueOn',
        'nextDueMinor',
        'daysPastDue',
      ] as const;
      const raw = (await get('/v1/loans', ids.b1)).json<{ items: Record<string, unknown>[] }>();
      for (const [label, why] of [
        ['A3', 'the newest report carries a warning'],
        ['A4', 'no report was ever received'],
        ['A5', 'a conflict about the report is unresolved'],
      ] as const) {
        expect([label, why, by(label)?.figuresAvailable]).toEqual([label, why, false]);
        const rawItem = raw.items.find((i) => i.loanId === ls(label)) ?? {};
        for (const key of figureKeys)
          expect([label, key, rawItem[key]]).toEqual([label, key, null]);
      }
      // The warning does not make the report stale, and the lender's time is still shown.
      expect(by('A3')).toMatchObject({ stale: false });
      expect(by('A3')?.reportedAsOf).not.toBeNull();
      // Nothing was ever reported for A4: no time, and stale.
      expect(by('A4')).toMatchObject({
        reportedAsOf: null,
        receivedAt: null,
        stale: true,
        figuresAvailable: false,
      });
    });

    it("lists only the other borrower's loans to them, and nothing to a borrower with no loan", async () => {
      const b2 = await listOf(ids.b2);
      expect(b2.map((i) => i.loanId).sort()).toEqual([ls('AB2'), ls('BB2')].sort());
      const b3 = await get('/v1/loans', ids.b3);
      expect(b3.statusCode).toBe(200);
      expect(b3.json()).toEqual({ items: [] });
    });

    it("returns one loan in the same shape, and 404 for anything that is not the caller's or is hidden by a switch", async () => {
      const items = await listOf(ids.b1);
      for (const label of ['A1', 'A2', 'A3', 'A4', 'A5', 'C1', 'E1']) {
        const res = await get(`/v1/loans/${ls(label)}`, ids.b1);
        expect([label, res.statusCode]).toEqual([label, 200]);
        expect(SvcLoan.parse(res.json())).toEqual(items.find((i) => i.loanId === ls(label)));
      }
      for (const [label, user, why] of [
        ['AB2', ids.b1, "another borrower's loan"],
        ['A1', ids.b2, "another borrower's loan"],
        ['A1', ids.b3, 'a borrower with no loan'],
        ['D1', ids.b1, 'a lender whose servicing switch is off'],
      ] as const) {
        const res = await get(`/v1/loans/${ls(label)}`, user);
        expect([why, ...problem(res)]).toEqual([why, 404, 'not_found']);
        expect(res.body).not.toContain(`SV-${label}-${RUN}`);
      }
      expect(problem(await get(`/v1/loans/${randomUUID()}`, ids.b1))).toEqual([404, 'not_found']);
    });

    it('shows the same 404 for a loan that exists and one that does not, so existence is not revealed', async () => {
      const real = await get(`/v1/loans/${ls('AB2')}`, ids.b1);
      const none = await get(`/v1/loans/${randomUUID()}`, ids.b1);
      const strip = (b: string) => b.replace(/"instance":"[^"]*"/, '');
      expect(strip(real.body)).toBe(strip(none.body));
    });
  });

  // ================================================================================================================
  // Schedule
  // ================================================================================================================
  describe('schedule', () => {
    it('returns the newest schedule version installment by installment, exactly as reported', async () => {
      const res = await get(`/v1/loans/${ls('A1')}/schedule`, ids.b1);
      expect(res.statusCode, res.body).toBe(200);
      const schedule = SvcSchedule.parse(res.json());
      expect(schedule.scheduleVersion).toBe(2);
      expect(schedule.reportedAsOf).not.toBeNull();
      expect(schedule.installments).toHaveLength(3);
      const dates = await q<{ d: string }>(
        `select to_char(i.due_date, 'YYYY-MM-DD') as d
           from servicing.schedule_installments i join servicing.schedule_snapshots s on s.id = i.snapshot_id
          where s.loan_account_id = $1 and s.version = 2 order by i.seq`,
        [ls('A1')],
      );
      expect(schedule.installments.map((i) => i.dueDate)).toEqual(dates.map((r) => r.d));
      expect(schedule.installments.map((i) => i.seq)).toEqual([1, 2, 3]);
      expect(schedule.installments[2]).toMatchObject({
        principalMinor: 400_000,
        interestMinor: 75_000,
        feesMinor: 1_000,
        totalMinor: 476_000,
      });
      // Nothing about payment status or allocation: the keys are exactly the reported ones.
      expect(Object.keys(schedule.installments[0] ?? {}).sort()).toEqual(
        ['dueDate', 'feesMinor', 'interestMinor', 'principalMinor', 'seq', 'totalMinor'].sort(),
      );
    });

    it('returns an empty schedule (version null) when none was reported, and when an unresolved schedule conflict withholds it', async () => {
      for (const label of ['A4', 'A5']) {
        const res = await get(`/v1/loans/${ls(label)}/schedule`, ids.b1);
        expect([label, res.statusCode]).toEqual([label, 200]);
        expect(res.json()).toEqual({ scheduleVersion: null, reportedAsOf: null, installments: [] });
      }
      const a3 = SvcSchedule.parse((await get(`/v1/loans/${ls('A3')}/schedule`, ids.b1)).json());
      expect(a3.installments).toHaveLength(2);
    });

    it("answers 404 for another borrower's loan, an unknown loan, and a lender whose servicing switch is off", async () => {
      for (const [label, user] of [
        ['A1', ids.b2],
        ['AB2', ids.b1],
        ['D1', ids.b1],
      ] as const) {
        const res = await get(`/v1/loans/${ls(label)}/schedule`, user);
        expect([label, ...problem(res)]).toEqual([label, 404, 'not_found']);
      }
      expect(problem(await get(`/v1/loans/${randomUUID()}/schedule`, ids.b1))).toEqual([
        404,
        'not_found',
      ]);
    });
  });

  // ================================================================================================================
  // Activity
  // ================================================================================================================
  describe('activity', () => {
    /** The order a correct cursor must produce: newest first, ties by id, descending. */
    const expectedOrder = () =>
      [...activityPlan].sort(
        (a, b) =>
          b.ms * 1000 + b.micro - (a.ms * 1000 + a.micro) ||
          (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
      );
    const micros = (sortAt: string) => {
      const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?([+-]\d{2}:\d{2})$/.exec(sortAt);
      if (!m?.[1] || !m[3]) throw new Error(`unexpected timestamp ${sortAt}`);
      return Date.parse(`${m[1]}${m[3]}`) * 1000 + Number((m[2] ?? '').padEnd(6, '0'));
    };
    const walk = async (limit: number) => {
      const pages: { id: string; sortAt: string }[][] = [];
      const cursors: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 40; guard += 1) {
        const res: Awaited<ReturnType<typeof get>> = await get(
          `/v1/loans/${ls('A1')}/activity?limit=${String(limit)}${cursor ? `&cursor=${cursor}` : ''}`,
          ids.b1,
        );
        expect(res.statusCode, res.body).toBe(200);
        const page = SvcActivityPage.parse(res.json());
        pages.push(page.items.map((i) => ({ id: i.entryId, sortAt: i.sortAt })));
        cursor = page.nextCursor;
        if (!cursor) return { pages, cursors };
        cursors.push(cursor);
      }
      throw new Error('the cursor never ended');
    };

    it('lists receipts, payment attempts and adjustments newest first, each with its honest state', async () => {
      const res = await get(`/v1/loans/${ls('A1')}/activity?limit=50`, ids.b1);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const page = SvcActivityPage.parse(res.json());
      expect(page.nextCursor).toBeNull();
      const order = expectedOrder();
      expect(page.items.map((i) => i.entryId)).toEqual(order.map((e) => e.id));
      for (const [n, item] of page.items.entries()) {
        const planned = order[n];
        expect(item).toMatchObject({
          entryKind: planned?.kind,
          state: planned?.state,
          amountMinor: planned?.amount,
          purpose: planned?.purpose,
          occurredOn: istDate(planned?.ms ?? 0),
        });
        expect(micros(item.sortAt)).toBe((planned?.ms ?? 0) * 1000 + (planned?.micro ?? 0));
      }
      expect(new Set(page.items.map((i) => i.state))).toEqual(
        new Set([
          'reversed',
          'recorded',
          'posted',
          'cancelled',
          'failed',
          'expired',
          'started',
          'refund',
          'needs_attention',
          'lender_posted',
          'provider_received',
        ]),
      );
    });

    it('never returns a bank reference, a payment mode, a provider reference or a settlement account', async () => {
      const res = await get(`/v1/loans/${ls('A1')}/activity?limit=50`, ids.b1);
      for (const value of [
        CANARY.bankRef,
        CANARY.paymentMode,
        CANARY.providerPaymentRef,
        CANARY.providerOrderRef,
        CANARY.settlementRef,
        CANARY.receiptRef,
      ])
        expect([value, res.body.includes(value)]).toEqual([value, false]);
      expect(res.body).not.toMatch(
        /bank_?reference|payment_?mode|provider_?(payment|order)?_?ref|settlement|receipt_?ref/i,
      );
    });

    it('pages without skipping or repeating an entry, including three entries inside one millisecond and two at the same instant', async () => {
      const order = expectedOrder().map((e) => e.id);
      for (const limit of [1, 2, 3, 4, 5, 6, 7, 11, 12, 13]) {
        const { pages, cursors } = await walk(limit);
        const seenIds = pages.flat().map((i) => i.id);
        expect([limit, seenIds]).toEqual([limit, order]);
        expect(new Set(seenIds).size).toBe(order.length);
        expect(pages).toHaveLength(Math.ceil(order.length / limit));
        expect(pages.every((p) => p.length <= limit)).toBe(true);
        // The cursor holds the position of the last row of the page.
        for (const [n, cursor] of cursors.entries()) {
          const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
            t: string;
            id: string;
          };
          const last = pages[n]?.at(-1);
          expect(decoded.id).toBe(last?.id);
          expect(micros(decoded.t)).toBe(micros(last?.sortAt ?? ''));
        }
      }
    });

    it('keeps the microseconds in the cursor: a page that ends inside one millisecond neither skips nor repeats the entries after it', async () => {
      // The newest entry is the partial reversal; then limit 6 ends at the refund (900 microseconds), limit 7 at the receipt (500),
      // limit 8 at the open attempt (100).
      for (const [limit, micro] of [
        [6, 900],
        [7, 500],
        [8, 100],
      ] as const) {
        const { pages, cursors } = await walk(limit);
        const decoded = JSON.parse(Buffer.from(cursors[0] ?? '', 'base64url').toString('utf8')) as {
          t: string;
        };
        expect([limit, micros(decoded.t) % 1000]).toEqual([limit, micro]);
        expect(pages.flat()).toHaveLength(activityPlan.length);
      }
    });

    it('answers a page that holds everything without a cursor', async () => {
      const exact = SvcActivityPage.parse(
        (await get(`/v1/loans/${ls('C1')}/activity?limit=1`, ids.b1)).json(),
      );
      expect(exact.items).toHaveLength(1);
      expect(exact.nextCursor).toBeNull();
    });

    it("shows a lender whose payments switch is off only the lender's receipts, and hides everything of a lender whose switches are off", async () => {
      const c1 = SvcActivityPage.parse(
        (await get(`/v1/loans/${ls('C1')}/activity`, ids.b1)).json(),
      );
      expect(c1.items.map((i) => [i.entryKind, i.state, i.amountMinor])).toEqual([
        ['lender_receipt', 'posted', 250_000],
      ]);
      expect(problem(await get(`/v1/loans/${ls('D1')}/activity`, ids.b1))).toEqual([
        404,
        'not_found',
      ]);
    });

    it("answers 404 for another borrower's loan and an unknown loan, and shows nothing of the other borrower's attempts", async () => {
      for (const [label, user] of [
        ['A1', ids.b2],
        ['AB2', ids.b1],
        ['A1', ids.b3],
      ] as const)
        expect([label, ...problem(await get(`/v1/loans/${ls(label)}/activity`, user))]).toEqual([
          label,
          404,
          'not_found',
        ]);
      expect(problem(await get(`/v1/loans/${randomUUID()}/activity`, ids.b1))).toEqual([
        404,
        'not_found',
      ]);
      const b2 = SvcActivityPage.parse(
        (await get(`/v1/loans/${ls('AB2')}/activity`, ids.b2)).json(),
      );
      expect(b2.items.map((i) => [i.entryKind, i.amountMinor]).sort()).toEqual(
        [
          ['payment_attempt', 333_000],
          ['lender_receipt', 333_000],
        ].sort(),
      );
    });
  });

  // ================================================================================================================
  // Documents the lender issued
  // ================================================================================================================
  describe('documents', () => {
    it('lists the lender-issued documents of a loan with their metadata, newest first, and never a storage key or hash', async () => {
      const res = await get(`/v1/loans/${ls('A1')}/documents`, ids.b1);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const list = SvcLoanDocumentList.parse(res.json());
      expect(list.items.map((i) => i.documentId)).toEqual([
        docs.stmt2?.id,
        docs.letter?.id,
        docs.stmt1?.id,
      ]);
      expect(list.items.find((i) => i.documentId === docs.stmt1?.id)).toMatchObject({
        kind: 'statement',
        issuer: 'lender',
        lenderReference: docs.stmt1?.reference,
        sizeBytes: docs.stmt1?.bytes.length,
        source: 'lender_upload',
        supersededById: docs.stmt2?.id,
      });
      expect(list.items.find((i) => i.documentId === docs.stmt2?.id)).toMatchObject({
        supersededById: null,
        periodFrom: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) as string,
      });
      expect(list.items.find((i) => i.documentId === docs.letter?.id)).toMatchObject({
        kind: 'foreclosure_quote',
        periodFrom: null,
        periodTo: null,
      });
      expect(res.body).not.toContain(CANARY.storagePrefix);
      expect(res.body).not.toContain(sha256(docs.stmt1?.bytes ?? ''));
      expect(res.body).not.toMatch(/storage|sha256|uploaded/i);
      expect(res.body).not.toContain(ids.aOp);
    });

    it("lists nothing where the lender's statements switch is off, 404 for someone else's loan, and a labelled mock document only where mocks are allowed", async () => {
      for (const label of ['C1', 'D1']) {
        const res = await get(`/v1/loans/${ls(label)}/documents`, ids.b1);
        expect([label, res.statusCode, res.json()]).toEqual([label, 200, { items: [] }]);
      }
      expect(problem(await get(`/v1/loans/${ls('AB2')}/documents`, ids.b1))).toEqual([
        404,
        'not_found',
      ]);
      expect(problem(await get(`/v1/loans/${ls('A1')}/documents`, ids.b2))).toEqual([
        404,
        'not_found',
      ]);
      expect(problem(await get(`/v1/loans/${randomUUID()}/documents`, ids.b1))).toEqual([
        404,
        'not_found',
      ]);
      expect(
        SvcLoanDocumentList.parse((await get(`/v1/loans/${ls('A3')}/documents`, ids.b1)).json())
          .items,
      ).toEqual([]);
      const mock = SvcLoanDocumentList.parse(
        (await get(`/v1/loans/${ls('A3')}/documents`, ids.b1, { on: appMock })).json(),
      );
      expect(mock.items).toHaveLength(1);
      expect(mock.items[0]).toMatchObject({ documentId: docs.mock?.id, source: 'mock' });
    });

    it('serves the exact stored file with its recorded checksum, never cached, and records every retrieval', async () => {
      const url = `/v1/loans/${ls('A1')}/documents/${docs.stmt2?.id ?? ''}/content`;
      const before = (await accessRows(docs.stmt2?.id ?? '')).length;
      const res = await get(url, ids.b1);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const content = SvcLoanDocumentContent.parse(res.json());
      expect(
        Buffer.from(content.contentBase64, 'base64').equals(docs.stmt2?.bytes ?? Buffer.alloc(0)),
      ).toBe(true);
      expect(content).toMatchObject({
        documentId: docs.stmt2?.id,
        loanId: ls('A1'),
        kind: 'statement',
        lenderReference: docs.stmt2?.reference,
        mimeType: 'application/pdf',
        sha256: sha256(docs.stmt2?.bytes ?? ''),
        sizeBytes: docs.stmt2?.bytes.length,
        source: 'lender_upload',
      });
      const download = await get(`${url}?purpose=download`, ids.b1);
      expect(download.statusCode).toBe(200);
      const rows = await accessRows(docs.stmt2?.id ?? '');
      expect(rows.slice(before)).toEqual([
        { actor_type: 'borrower', actor_user_id: ids.b1, purpose: 'view' },
        { actor_type: 'borrower', actor_user_id: ids.b1, purpose: 'download' },
      ]);
      expect(res.body).not.toContain(docs.stmt2?.key ?? 'x');
    });

    it('serves the caller own document when the loan id in the path is written in upper case (A1), and still refuses another loan', async () => {
      const own = docs.stmt2?.id ?? '';
      const upper = `/v1/loans/${ls('A1').toUpperCase()}/documents/${own.toUpperCase()}/content`;
      expect(upper).not.toBe(upper.toLowerCase());
      const res = await get(upper, ids.b1);
      expect(res.statusCode, res.body).toBe(200);
      expect(SvcLoanDocumentContent.parse(res.json()).loanId).toBe(ls('A1'));
      // Case folding must not widen access: another loan, written in upper case, is still not found.
      const other = await get(
        `/v1/loans/${ls('A2').toUpperCase()}/documents/${own}/content`,
        ids.b1,
      );
      expect(problem(other)).toEqual([404, 'not_found']);
    });

    it('opens nothing for another borrower, the wrong loan path, an unknown document or a switched-off lender, and records no access', async () => {
      const own = docs.stmt2?.id ?? '';
      const theirs = docs.ab2?.id ?? '';
      const before = (await accessRows(own)).length;
      const beforeB2 = (await accessRows(theirs)).length;
      const tries: [string, string, string][] = [
        ['another borrower, right path', `/v1/loans/${ls('A1')}/documents/${own}/content`, ids.b2],
        ['a borrower with no loan', `/v1/loans/${ls('A1')}/documents/${own}/content`, ids.b3],
        [
          'own loan, but the document of another loan of theirs',
          `/v1/loans/${ls('A2')}/documents/${own}/content`,
          ids.b1,
        ],
        [
          "own loan, another borrower's document",
          `/v1/loans/${ls('A1')}/documents/${theirs}/content`,
          ids.b1,
        ],
        [
          "another borrower's loan and document",
          `/v1/loans/${ls('AB2')}/documents/${theirs}/content`,
          ids.b1,
        ],
        ['an unknown document', `/v1/loans/${ls('A1')}/documents/${randomUUID()}/content`, ids.b1],
        ['an unknown loan', `/v1/loans/${randomUUID()}/documents/${own}/content`, ids.b1],
      ];
      for (const [why, url, user] of tries) {
        const res = await get(url, user);
        expect([why, ...problem(res)]).toEqual([why, 404, 'not_found']);
        expect(res.body).not.toContain('contentBase64');
      }
      const off = await get(`/v1/loans/${ls('C1')}/documents/${docs.c1?.id ?? ''}/content`, ids.b1);
      expect(problem(off)).toEqual([409, 'feature_disabled']);
      expect((await accessRows(own)).length).toBe(before);
      expect((await accessRows(theirs)).length).toBe(beforeB2);
      expect(await accessRows(docs.c1?.id ?? '')).toEqual([]);
    });

    it('fails closed when the stored bytes were altered, or are gone, and records no access for a read that delivered nothing', async () => {
      const url = `/v1/loans/${ls('A1')}/documents/${docs.stmt1?.id ?? ''}/content`;
      const file = path.join(storeRoot, docs.stmt1?.key ?? '');
      const before = (await accessRows(docs.stmt1?.id ?? '')).length;
      fs.writeFileSync(file, pdf(`altered ${RUN}`));
      try {
        const tampered = await get(url, ids.b1);
        expect(tampered.statusCode).toBe(500);
        expect(code(tampered)).toBe('internal_error');
        expect(tampered.body).not.toContain('contentBase64');
        expect(tampered.body).not.toContain(sha256(docs.stmt1?.bytes ?? ''));
        expect(tampered.body).not.toContain('checksum');
        expect((await accessRows(docs.stmt1?.id ?? '')).length).toBe(before);
        fs.rmSync(file);
        const gone = await get(url, ids.b1);
        expect(problem(gone)).toEqual([404, 'not_found']);
        expect((await accessRows(docs.stmt1?.id ?? '')).length).toBe(before);
      } finally {
        fs.writeFileSync(file, docs.stmt1?.bytes ?? '');
      }
      const restored = await get(url, ids.b1);
      expect(restored.statusCode).toBe(200);
      expect((await accessRows(docs.stmt1?.id ?? '')).length).toBe(before + 1);
    });

    it('fails closed when the recorded size is not the size of the stored file, even though the hash matches', async () => {
      const real = pdf(`sizelie ${RUN}`);
      const lie = await registerDocument(ids.aOp, ls('A5'), 'statement', 'sizelie', {
        from: istDate(Date.now() - 60 * DAY),
        to: istDate(Date.now() - 30 * DAY),
        recordedSize: real.length + 7,
        issuedMsAgo: 6 * HOUR,
      });
      const url = `/v1/loans/${ls('A5')}/documents/${lie.id}/content`;
      const res = await get(url, ids.b1);
      expect(res.statusCode).toBe(500);
      expect(code(res)).toBe('internal_error');
      expect(res.body).not.toContain('contentBase64');
      expect(await accessRows(lie.id)).toEqual([]);
      // The list still shows the document (metadata only): it is the content that is refused.
      const list = SvcLoanDocumentList.parse(
        (await get(`/v1/loans/${ls('A5')}/documents`, ids.b1)).json(),
      );
      expect(list.items.map((i) => i.documentId)).toContain(lie.id);
    });

    it('answers 503 without a configured store and records no access', async () => {
      const own = docs.stmt2?.id ?? '';
      const before = (await accessRows(own)).length;
      const res = await get(`/v1/loans/${ls('A1')}/documents/${own}/content`, ids.b1, {
        on: appNoStore,
      });
      expect(problem(res)).toEqual([503, 'document_store_unavailable']);
      expect((await accessRows(own)).length).toBe(before);
      // The list needs no store.
      expect(
        (await get(`/v1/loans/${ls('A1')}/documents`, ids.b1, { on: appNoStore })).statusCode,
      ).toBe(200);
    });

    it('serves a labelled mock document only where mock providers are allowed', async () => {
      const url = `/v1/loans/${ls('A3')}/documents/${docs.mock?.id ?? ''}/content`;
      expect(problem(await get(url, ids.b1))).toEqual([404, 'not_found']);
      const res = await get(url, ids.b1, { on: appMock });
      expect(res.statusCode, res.body).toBe(200);
      expect(SvcLoanDocumentContent.parse(res.json())).toMatchObject({ source: 'mock' });
    });
  });

  // ================================================================================================================
  // Requests for a statement or a foreclosure quotation
  // ================================================================================================================
  describe('requests for statements and quotations', () => {
    const key = (n: string) => `it-sv-${RUN}-${n}-0000`;
    const dateAgo = (days: number) => istDate(Date.now() - days * DAY);
    const statusOf = (id: string) =>
      scalar<string>('select status as v from servicing.document_requests where id = $1', [id]);
    const statementsUrl = (label: string) => `/v1/loans/${ls(label)}/statements`;
    const quotesUrl = (label: string) => `/v1/loans/${ls(label)}/foreclosure-quotes`;
    const listUrl = (label: string) => `/v1/loans/${ls(label)}/document-requests`;

    it('creates a request for the whole statement history, shows its due date with the basis, and replays the same key to the same request', async () => {
      const K1 = key('s1');
      const res = await post(statementsUrl('A1'), ids.b1, {}, { key: K1 });
      expect(res.statusCode, res.body).toBe(201);
      expect(res.headers['cache-control']).toBe('no-store');
      const { request } = SvcDocumentRequestResult.parse(res.json());
      reqs.s1 = request.requestId;
      expect(request).toMatchObject({
        kind: 'statement',
        status: 'requested',
        periodFrom: null,
        periodTo: null,
        dueRuleKey: 'servicing.statement_sla_days_default',
        dueEvidenceStatus: 'unverified',
        lenderNote: null,
        decidedAt: null,
        fulfilledDocumentId: null,
        fulfilledQuoteId: null,
      });
      // The due date is the platform's setting (a rule labelled unverified), seven days after the request.
      expect(Date.parse(request.dueBy ?? '') - Date.parse(request.requestedAt)).toBe(7 * DAY);
      const rows = await q<{ requested_by: string; idempotency_key: string }>(
        `select requested_by::text, idempotency_key from servicing.document_requests where id = $1`,
        [reqs.s1],
      );
      expect(rows).toEqual([{ requested_by: ids.b1, idempotency_key: K1 }]);

      const again = await post(statementsUrl('A1'), ids.b1, {}, { key: K1 });
      expect(again.statusCode).toBe(201);
      expect(again.headers['idempotent-replayed']).toBe('true');
      expect(again.json()).toEqual(res.json());
      expect(await requestRows(ls('A1'))).toHaveLength(1);
    });

    it('refuses a second open request of the kind, a reused key with different content, a key used for the other kind, and a key of the wrong length', async () => {
      const second = await post(statementsUrl('A1'), ids.b1, {}, { key: key('s1-again') });
      expect(problem(second)).toEqual([409, 'open_request_exists']);
      const reused = await post(
        statementsUrl('A1'),
        ids.b1,
        { periodFrom: dateAgo(60), periodTo: dateAgo(30) },
        { key: key('s1') },
      );
      expect(problem(reused)).toEqual([422, 'idempotency_key_reused']);
      // The same key on the other route is a different request: the database's own key check refuses it.
      const other = await post(quotesUrl('A1'), ids.b1, {}, { key: key('s1') });
      expect(problem(other)).toEqual([409, 'idempotency_conflict']);
      expect(await requestRows(ls('A1'))).toHaveLength(1);
    });

    it('accepts an Idempotency-Key of the full documented length (128 characters), and stores the database its digest rather than the key', async () => {
      // The API documents 16 to 128 characters, the database function takes 8 to 100: a longer key is handed on as its SHA-256.
      const long = 'k'.repeat(128);
      const res = await post(statementsUrl('A3'), ids.b1, {}, { key: long });
      expect(res.statusCode, res.body).toBe(201);
      const replay = await post(statementsUrl('A3'), ids.b1, {}, { key: long });
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.json()).toEqual(res.json());
      const rows = await q<{ idempotency_key: string }>(
        'select idempotency_key from servicing.document_requests where loan_account_id = $1',
        [ls('A3')],
      );
      expect(rows).toEqual([{ idempotency_key: sha256(long) }]);
    });

    it('creates exactly one request when the same key arrives twice at once', async () => {
      const K = key('race');
      const [a, b] = await Promise.all([
        post(statementsUrl('A4'), ids.b1, {}, { key: K }),
        post(statementsUrl('A4'), ids.b1, {}, { key: K }),
      ]);
      expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
      expect(SvcDocumentRequestResult.parse(a.json()).request.requestId).toBe(
        SvcDocumentRequestResult.parse(b.json()).request.requestId,
      );
      expect(await requestRows(ls('A4'))).toHaveLength(1);
    });

    it('cancels only an open request of the caller on the loan in the path, and 404s anything else without changing it', async () => {
      const cancel = (loanLabel: string, request: string, user: string, k?: string) =>
        post(
          `/v1/loans/${ls(loanLabel)}/document-requests/${request}/cancel`,
          user,
          {},
          k ? { key: k } : {},
        );
      // The request exists and is the caller's, but it is not on this loan: nothing is cancelled.
      expect(problem(await cancel('A3', reqs.s1 ?? '', ids.b1))).toEqual([404, 'not_found']);
      expect(await statusOf(reqs.s1 ?? '')).toBe('requested');
      for (const [why, label, user] of [
        ['another borrower, the loan of the request', 'A1', ids.b2],
        ['another borrower, their own loan', 'AB2', ids.b2],
        ['a borrower with no loan', 'A1', ids.b3],
        ['the loan of someone else', 'AB2', ids.b1],
      ] as const) {
        const res = await cancel(label, reqs.s1 ?? '', user);
        expect([why, ...problem(res)]).toEqual([why, 404, 'not_found']);
        expect(await statusOf(reqs.s1 ?? '')).toBe('requested');
      }
      expect(problem(await cancel('A1', randomUUID(), ids.b1))).toEqual([404, 'not_found']);

      const K = key('cancel-1');
      const done = await cancel('A1', reqs.s1 ?? '', ids.b1, K);
      expect(done.statusCode, done.body).toBe(200);
      const { request } = SvcDocumentRequestResult.parse(done.json());
      expect(request).toMatchObject({ requestId: reqs.s1, status: 'cancelled' });
      expect(request.decidedAt).not.toBeNull();
      expect(await statusOf(reqs.s1 ?? '')).toBe('cancelled');
      const replay = await cancel('A1', reqs.s1 ?? '', ids.b1, K);
      expect(replay.statusCode).toBe(200);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.json()).toEqual(done.json());
      expect(problem(await cancel('A1', reqs.s1 ?? '', ids.b1))).toEqual([409, 'request_not_open']);
    });

    it('checks the period of a statement request in the database and creates nothing for a bad one', async () => {
      const before = (await requestRows(ls('A1'))).length;
      for (const [why, body] of [
        ['only the start', { periodFrom: dateAgo(60) }],
        ['only the end', { periodTo: dateAgo(30) }],
        ['backwards', { periodFrom: dateAgo(30), periodTo: dateAgo(60) }],
        ['in the future', { periodFrom: dateAgo(30), periodTo: dateAgo(-3) }],
        ['before the year 2000', { periodFrom: '1999-01-01', periodTo: dateAgo(30) }],
      ] as const) {
        const res = await post(statementsUrl('A1'), ids.b1, body);
        expect([why, ...problem(res)]).toEqual([why, 422, 'period_invalid']);
      }
      const impossible = await post(statementsUrl('A1'), ids.b1, {
        periodFrom: '2026-02-31',
        periodTo: '2026-03-01',
      });
      expect(problem(impossible)).toEqual([422, 'invalid_request']);
      expect(await requestRows(ls('A1'))).toHaveLength(before);
    });

    it('creates a request for a period, then a foreclosure quotation request, and refuses what the loan or the lender does not allow', async () => {
      const period = { periodFrom: dateAgo(60), periodTo: dateAgo(30) };
      const s2 = await post(statementsUrl('A1'), ids.b1, period, { key: key('s2') });
      expect(s2.statusCode, s2.body).toBe(201);
      const s2Request = SvcDocumentRequestResult.parse(s2.json()).request;
      reqs.s2 = s2Request.requestId;
      expect(s2Request).toMatchObject({ ...period, status: 'requested', kind: 'statement' });

      const q1 = await post(quotesUrl('A1'), ids.b1, {}, { key: key('q1') });
      expect(q1.statusCode, q1.body).toBe(201);
      const q1Request = SvcDocumentRequestResult.parse(q1.json()).request;
      reqs.q1 = q1Request.requestId;
      // A quotation has no platform due date: it is the lender's to give.
      expect(q1Request).toMatchObject({
        kind: 'foreclosure_quote',
        status: 'requested',
        dueBy: null,
        dueRuleKey: null,
        dueEvidenceStatus: null,
        periodFrom: null,
      });
      expect(problem(await post(quotesUrl('A1'), ids.b1))).toEqual([409, 'open_request_exists']);
      // The loan must be active for a quotation.
      expect(problem(await post(quotesUrl('A2'), ids.b1))).toEqual([409, 'loan_not_active']);
      // A switched-off lender: statements_noc is off for C and D.
      for (const label of ['C1', 'D1']) {
        expect([label, ...problem(await post(statementsUrl(label), ids.b1))]).toEqual([
          label,
          409,
          'feature_disabled',
        ]);
        expect([label, ...problem(await post(quotesUrl(label), ids.b1))]).toEqual([
          label,
          409,
          'feature_disabled',
        ]);
      }
      expect(await requestRows(ls('C1'))).toHaveLength(0);
      expect(await requestRows(ls('D1'))).toHaveLength(0);
    });

    it("answers 404 to a request for another borrower's loan or an unknown loan, and creates nothing", async () => {
      const before = (await requestRows(ls('AB2'))).length;
      for (const [why, url, user] of [
        ["another borrower's loan, statement", statementsUrl('AB2'), ids.b1],
        ["another borrower's loan, quotation", quotesUrl('AB2'), ids.b1],
        ["the first borrower's loan, statement", statementsUrl('A1'), ids.b2],
        ['no loan at all, quotation', quotesUrl('A1'), ids.b3],
        ['an unknown loan', `/v1/loans/${randomUUID()}/statements`, ids.b1],
      ] as const)
        expect([why, ...problem(await post(url, user))]).toEqual([why, 404, 'not_found']);
      expect(await requestRows(ls('AB2'))).toHaveLength(before);
      // The other borrower makes their own request, which the first borrower must never see or touch.
      const own = await post(statementsUrl('AB2'), ids.b2, {}, { key: key('b2-s') });
      expect(own.statusCode, own.body).toBe(201);
      reqs.b2 = SvcDocumentRequestResult.parse(own.json()).request.requestId;
    });

    it("shows the lender's answers: fulfilled by a document or a quotation, declined with the lender's own reason", async () => {
      // The lender fulfils the statement request with a document that covers the period, and the quotation request with a quotation.
      docs.stmt3 = await registerDocument(ids.aOp, ls('A1'), 'statement', 'stmt3', {
        from: dateAgo(61),
        to: dateAgo(29),
        request: reqs.s2 ?? '',
        issuedMsAgo: 30 * 60_000,
      });
      quotes.req = await recordQuote(ids.aOp, ls('A1'), 'QUOTE-REQ', {
        asOfMsAgo: 30 * 60_000,
        validForMs: 24 * HOUR,
        total: '10800.00',
        request: reqs.q1 ?? '',
        letter: docs.letter?.id ?? '',
      });
      // And declines a third request with a reason.
      const s3 = await post(statementsUrl('A1'), ids.b1, {}, { key: key('s3') });
      expect(s3.statusCode, s3.body).toBe(201);
      reqs.s3 = SvcDocumentRequestResult.parse(s3.json()).request.requestId;
      const note = 'The period requested is not yet closed for reporting.';
      await asUser(ids.aOp, 'select servicing.decline_document_request($1::uuid, $2)', [
        reqs.s3,
        note,
      ]);

      const res = await get(listUrl('A1'), ids.b1);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const list = SvcDocumentRequestList.parse(res.json());
      expect(list.items.map((i) => [i.requestId, i.status])).toEqual([
        [reqs.s3, 'declined'],
        [reqs.q1, 'fulfilled'],
        [reqs.s2, 'fulfilled'],
        [reqs.s1, 'cancelled'],
      ]);
      const by = (id: string | undefined) => list.items.find((i) => i.requestId === id);
      expect(by(reqs.s3)).toMatchObject({ lenderNote: note, fulfilledDocumentId: null });
      expect(by(reqs.s3)?.decidedAt).not.toBeNull();
      expect(by(reqs.s2)).toMatchObject({
        fulfilledDocumentId: docs.stmt3.id,
        fulfilledQuoteId: null,
      });
      expect(by(reqs.q1)).toMatchObject({
        fulfilledQuoteId: quotes.req,
        fulfilledDocumentId: null,
      });
      // The fulfilling document is now listed for the borrower, and the lender user who uploaded it is not named.
      const documents = SvcLoanDocumentList.parse(
        (await get(`/v1/loans/${ls('A1')}/documents`, ids.b1)).json(),
      );
      expect(documents.items.map((i) => i.documentId)).toContain(docs.stmt3.id);
    });

    it("lists nothing where the statements switch is off, 404 for someone else's loan, and only the caller's own requests", async () => {
      for (const label of ['C1', 'D1'])
        expect([label, (await get(listUrl(label), ids.b1)).json()]).toEqual([label, { items: [] }]);
      expect(problem(await get(listUrl('AB2'), ids.b1))).toEqual([404, 'not_found']);
      expect(problem(await get(listUrl('A1'), ids.b2))).toEqual([404, 'not_found']);
      expect(problem(await get(listUrl('A1'), ids.b3))).toEqual([404, 'not_found']);
      expect(problem(await get(`/v1/loans/${randomUUID()}/document-requests`, ids.b1))).toEqual([
        404,
        'not_found',
      ]);
      const b2 = SvcDocumentRequestList.parse((await get(listUrl('AB2'), ids.b2)).json());
      expect(b2.items.map((i) => i.requestId)).toEqual([reqs.b2]);
    });
  });

  // ================================================================================================================
  // The newest foreclosure quotation
  // ================================================================================================================
  describe('foreclosure quotation', () => {
    const latestUrl = (label: string) => `/v1/loans/${ls(label)}/foreclosure-quotes/latest`;

    it("returns the lender's own figures unchanged, with the validity as a date and time", async () => {
      const res = await get(latestUrl('A1'), ids.b1);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const { quote } = SvcLatestQuote.parse(res.json());
      expect(quote).toEqual({
        quoteId: quotes.req,
        lenderQuoteRef: `QUOTE-REQ-${RUN}`,
        asOf: expect.any(String) as string,
        validUntil: expect.any(String) as string,
        principalMinor: 1_000_000,
        interestMinor: 50_000,
        chargesMinor: 10_000,
        prepaymentChargeMinor: 20_000,
        totalMinor: 1_080_000,
        totalMismatch: false,
        source: 'lender_portal',
        letterDocumentId: docs.letter?.id,
      });
      expect(Date.parse(quote?.validUntil ?? '')).toBeGreaterThan(Date.now());
    });

    it("returns quote null, never an invented figure, when there is no unexpired quotation, or the lender's switch is off", async () => {
      // A4 has only a quotation that expired days ago (recorded as history); A5 has none; C1 and D1 have the statements switch off.
      await recordQuote(ids.aOp, ls('A4'), 'QUOTE-EXPIRED', {
        asOfMsAgo: 4 * DAY,
        validForMs: DAY,
        total: '10800.00',
      });
      expect(
        await count(
          'select count(*) as v from servicing.foreclosure_quotes where loan_account_id = $1',
          [ls('A4')],
        ),
      ).toBe(1);
      for (const label of ['A4', 'A5', 'C1', 'D1']) {
        const res = await get(latestUrl(label), ids.b1);
        expect([label, res.statusCode, res.json()]).toEqual([label, 200, { quote: null }]);
      }
    });

    it('shows a labelled mock quotation only where mock providers are allowed', async () => {
      expect((await get(latestUrl('A3'), ids.b1)).json()).toEqual({ quote: null });
      const res = await get(latestUrl('A3'), ids.b1, { on: appMock });
      expect(SvcLatestQuote.parse(res.json()).quote).toMatchObject({
        quoteId: quotes.mock,
        source: 'mock',
      });
    });

    it("answers 404, not an empty answer, for another borrower's loan or an unknown loan", async () => {
      for (const [why, label, user] of [
        ["another borrower's loan", 'AB2', ids.b1],
        ['the loan of the first borrower', 'A1', ids.b2],
        ['a borrower with no loan', 'A1', ids.b3],
      ] as const)
        expect([why, ...problem(await get(latestUrl(label), user))]).toEqual([
          why,
          404,
          'not_found',
        ]);
      expect(
        problem(await get(`/v1/loans/${randomUUID()}/foreclosure-quotes/latest`, ids.b1)),
      ).toEqual([404, 'not_found']);
      const own = SvcLatestQuote.parse((await get(latestUrl('AB2'), ids.b2)).json());
      expect(own.quote?.quoteId).toBe(quotes.ab2);
    });

    it("returns a newer quotation whose parts do not add up flagged, with the lender's figures as reported (never corrected), so the app can refuse to pay it", async () => {
      quotes.bad = await recordQuote(ids.aOp, ls('A1'), 'QUOTE-MISMATCH', {
        asOfMsAgo: 10 * 60_000,
        validForMs: 24 * HOUR,
        total: '10900.00',
      });
      const res = await get(latestUrl('A1'), ids.b1);
      const { quote } = SvcLatestQuote.parse(res.json());
      expect(quote).toMatchObject({
        quoteId: quotes.bad,
        principalMinor: 1_000_000,
        interestMinor: 50_000,
        chargesMinor: 10_000,
        prepaymentChargeMinor: 20_000,
        totalMinor: 1_090_000,
        totalMismatch: true,
      });
    });
  });

  // ================================================================================================================
  // Closure
  // ================================================================================================================
  describe('closure', () => {
    const closureUrl = (label: string) => `/v1/loans/${ls(label)}/closure`;

    it('returns closure null while the lender has not reported the loan closed', async () => {
      for (const label of ['A1', 'E1']) {
        const res = await get(closureUrl(label), ids.b1);
        expect([label, res.statusCode, res.json()]).toEqual([label, 200, { closure: null }]);
      }
    });

    it('shows the closed loan with the notice of discharge pending, the due date and its basis, and no release claimed', async () => {
      const res = await get(closureUrl('A2'), ids.b1);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const { closure } = SvcClosureResult.parse(res.json());
      expect(closure).toMatchObject({
        loanId: ls('A2'),
        lenderDisplayName: 'Alpha Servicing',
        loanStatus: 'closed',
        closureKind: 'closed',
        nocStatus: 'pending',
        nocStatusSource: 'lender',
        nocPromptKey: 'closure.noc.lender_to_issue',
        nocDocumentId: null,
        nocIssuedAt: null,
        nocDueBasis: {
          ruleKey: 'servicing.noc_sla_days_default',
          ruleVersion,
          evidenceStatus: 'unverified',
        },
        securityReleaseTasks: [],
      });
      expect(closure?.nocDueBy).not.toBeNull();
      expect(closure?.closureRecordedAt).toEqual(expect.any(String));
    });

    it("shows the lender's confirmation of each security release, the lender's own delay reason, and the no-dues letter once the lender issues it", async () => {
      const opened = await asUser<{ n: number }>(
        ids.aOp,
        `select servicing.open_security_release_tasks($1::uuid, array['mutual_fund_lien', 'property_documents']) as n`,
        [ls('A2')],
      );
      expect(opened[0]?.n).toBe(2);
      const task = async (type: string) =>
        scalar<string>(
          `select id::text as v from servicing.security_release_tasks where loan_account_id = $1 and collateral_type = $2`,
          [ls('A2'), type],
        );
      await asUser(ids.aOp, 'select servicing.confirm_security_release($1::uuid, $2)', [
        await task('mutual_fund_lien'),
        `REL-${RUN}`,
      ]);
      const reason = 'Awaiting the registrar to return the original papers.';
      await asUser(ids.aOp, 'select servicing.set_security_release_delay_reason($1::uuid, $2)', [
        await task('property_documents'),
        reason,
      ]);
      docs.noc = await registerDocument(ids.aOp, ls('A2'), 'noc', 'noc', {
        issuedMsAgo: 10 * 60_000,
      });

      const res = await get(closureUrl('A2'), ids.b1);
      expect(res.statusCode, res.body).toBe(200);
      const { closure } = SvcClosureResult.parse(res.json());
      expect(closure).toMatchObject({
        nocStatus: 'issued',
        nocPromptKey: 'closure.noc.issued_by_lender',
        nocDocumentId: docs.noc.id,
      });
      expect(closure?.nocIssuedAt).not.toBeNull();
      expect(closure?.securityReleaseTasks).toHaveLength(2);
      const [lien, property] = closure?.securityReleaseTasks ?? [];
      expect(lien).toMatchObject({
        collateralType: 'mutual_fund_lien',
        status: 'confirmed_by_lender',
        statusSource: 'lender',
        promptKey: 'closure.security_release.mutual_fund_lien.lender_confirmed',
        lenderConfirmed: true,
        delayReason: null,
        dueBasis: {
          ruleKey: 'servicing.security_release_sla_days',
          ruleVersion,
          // The paragraph text is confirmed but its application to the listed product categories is not (migration 925, U44).
          evidenceStatus: 'likely',
        },
      });
      expect(lien?.confirmedAt).not.toBeNull();
      expect(property).toMatchObject({
        collateralType: 'property_documents',
        status: 'open',
        promptKey: 'closure.security_release.property_documents.lender_to_release',
        lenderConfirmed: false,
        confirmedAt: null,
        delayReason: reason,
      });
      expect(property?.dueBy).not.toBeNull();
      // Nothing here claims a release: only the key of a confirmed task says "confirmed", and the confirmation reference is not shown.
      expect(res.body).not.toMatch(/released|REL-/);
      // The no-dues letter is an ordinary lender document the borrower can open.
      const list = SvcLoanDocumentList.parse(
        (await get(`/v1/loans/${ls('A2')}/documents`, ids.b1)).json(),
      );
      expect(list.items.map((i) => [i.documentId, i.kind])).toEqual([[docs.noc.id, 'noc']]);
      const opened2 = await get(`/v1/loans/${ls('A2')}/documents/${docs.noc.id}/content`, ids.b1);
      expect(opened2.statusCode, opened2.body).toBe(200);
    });

    it("answers 404 for another borrower's loan and an unknown loan, and 409 feature_disabled where the lender's switch is off", async () => {
      for (const [why, label, user] of [
        ["another borrower's loan", 'AB2', ids.b1],
        ['the closed loan of the first borrower', 'A2', ids.b2],
        ['a borrower with no loan', 'A2', ids.b3],
      ] as const)
        expect([why, ...problem(await get(closureUrl(label), user))]).toEqual([
          why,
          404,
          'not_found',
        ]);
      expect(problem(await get(`/v1/loans/${randomUUID()}/closure`, ids.b1))).toEqual([
        404,
        'not_found',
      ]);
      for (const label of ['C1', 'D1'])
        expect([label, ...problem(await get(closureUrl(label), ids.b1))]).toEqual([
          label,
          409,
          'feature_disabled',
        ]);
    });
  });

  // ================================================================================================================
  // Service reminders
  // ================================================================================================================
  describe('reminders', () => {
    const readUrl = (id: string | undefined) => `/v1/me/reminders/${id ?? ''}/read`;
    const dueDateOf = (id: string | undefined) =>
      scalar<string>(
        `select to_char(due_date, 'YYYY-MM-DD') as v from servicing.reminders where id = $1`,
        [id],
      );
    const readRows = (ids_: (string | undefined)[]) =>
      count(
        `select count(*) as v from servicing.reminder_deliveries where state = 'read' and source = 'app' and reminder_id = any($1::uuid[])`,
        [ids_],
      );

    it("lists the caller's sent messages newest first with the wording exactly as the database rebuilt it", async () => {
      const res = await get('/v1/me/reminders', ids.b1);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const list = SvcReminderList.parse(res.json());
      // One message per installment and offset, even when it went out on two channels (ra1 was sent in the app and as a push).
      expect(list.items.map((i) => i.reminderId)).toEqual([
        reminders.re1,
        reminders.ra2,
        reminders.ra1,
      ]);
      expect(list.items[2]).toEqual({
        reminderId: reminders.ra1,
        loanId: ls('A1'),
        lenderDisplayName: 'Alpha Servicing',
        kind: 'pre_due',
        dueDate: await dueDateOf(reminders.ra1),
        sentAt: expect.any(String) as string,
        message: reminderMessages.ra1,
        readAt: null,
      });
      expect(list.items[2]?.message).toContain('Rs 4,750.00');
      expect(list.items[1]).toMatchObject({ kind: 'due_day', message: reminderMessages.ra2 });
      // Not listed: a message whose wording no longer matches its stored hash, one that was only planned, one of a lender whose
      // reminders switch is off, and another borrower's.
      for (const hidden of [
        reminders.ra3,
        reminders.ra4,
        reminders.rc1,
        reminders.rb2,
        reminders['ra1.push'],
      ])
        expect(res.body).not.toContain(hidden ?? 'x');
      expect(res.body).not.toContain('edited later');
    });

    it("lists only the other borrower's own messages to them, and nothing to a borrower without any", async () => {
      const b2 = SvcReminderList.parse((await get('/v1/me/reminders', ids.b2)).json());
      expect(b2.items.map((i) => i.reminderId)).toEqual([reminders.rb2]);
      expect((await get('/v1/me/reminders', ids.b3)).json()).toEqual({ items: [] });
    });

    it('marks every channel copy of a message as read, idempotently, and shows the time it was read', async () => {
      const K = `it-sv-${RUN}-read-0001-xx`;
      const res = await post(readUrl(reminders['ra1.push']), ids.b1, {}, { key: K });
      expect(res.statusCode, res.body).toBe(200);
      expect(SvcReminderRead.parse(res.json())).toEqual({
        reminderId: reminders['ra1.push'],
        state: 'read',
      });
      expect(await readRows([reminders.ra1, reminders['ra1.push']])).toBe(2);
      const again = await post(readUrl(reminders.ra1), ids.b1);
      expect(again.statusCode).toBe(200);
      expect(await readRows([reminders.ra1, reminders['ra1.push']])).toBe(2);
      const replay = await post(readUrl(reminders['ra1.push']), ids.b1, {}, { key: K });
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.json()).toEqual(res.json());
      const list = SvcReminderList.parse((await get('/v1/me/reminders', ids.b1)).json());
      expect(list.items.find((i) => i.reminderId === reminders.ra1)?.readAt).not.toBeNull();
      expect(list.items.find((i) => i.reminderId === reminders.ra2)?.readAt).toBeNull();
    });

    it("answers 404 for another borrower's reminder, a message that was not sent, a lender whose reminders switch is off and an unknown one, and records nothing", async () => {
      const before = await readRows([reminders.ra2, reminders.ra4, reminders.rb2, reminders.rc1]);
      for (const [why, id, user] of [
        ["another borrower's reminder", reminders.rb2, ids.b1],
        ["the first borrower's reminder", reminders.ra2, ids.b2],
        ['a borrower with none', reminders.ra2, ids.b3],
        ['a message that was only planned', reminders.ra4, ids.b1],
        ['a lender whose reminders switch is off', reminders.rc1, ids.b1],
        ['an unknown reminder', randomUUID(), ids.b1],
      ] as const) {
        const res = await post(readUrl(id), user);
        expect([why, ...problem(res)]).toEqual([why, 404, 'not_found']);
      }
      expect(await readRows([reminders.ra2, reminders.ra4, reminders.rb2, reminders.rc1])).toBe(
        before,
      );
      expect(before).toBe(0);
    });
  });

  // ================================================================================================================
  // A switch turned off takes effect on the very next request
  // ================================================================================================================
  describe('a lender switch that is turned off', () => {
    const kill = (feature: string) =>
      asUser(ids.pFeatures, 'select servicing.kill_feature($1::uuid, $2, $3, $4)', [
        ids.lenderE,
        feature,
        'Test: emergency stop of the feature for this lender.',
        `it-sv-kill-${feature}-${RUN}-0001`,
      ]);
    const statusOfRequest = (id: string) =>
      scalar<string>('select status as v from servicing.document_requests where id = $1', [id]);
    const url = (suffix = '') => `/v1/loans/${ls('E1')}${suffix}`;

    it('hides the payment attempts of the lender whose payments switch was turned off, and keeps the lender receipts', async () => {
      const before = SvcActivityPage.parse((await get(url('/activity'), ids.b1)).json());
      expect(before.items.map((i) => i.entryKind).sort()).toEqual([
        'lender_receipt',
        'payment_attempt',
      ]);
      await kill('payments');
      const after = SvcActivityPage.parse((await get(url('/activity'), ids.b1)).json());
      expect(after.items.map((i) => i.entryKind)).toEqual(['lender_receipt']);
    });

    it('hides the reminders of the lender whose reminders switch was turned off, and refuses to mark them read', async () => {
      const before = SvcReminderList.parse((await get('/v1/me/reminders', ids.b1)).json());
      expect(before.items.map((i) => i.reminderId)).toContain(reminders.re1);
      await kill('reminders');
      const after = SvcReminderList.parse((await get('/v1/me/reminders', ids.b1)).json());
      expect(after.items.map((i) => i.reminderId)).not.toContain(reminders.re1);
      expect(problem(await post(`/v1/me/reminders/${reminders.re1 ?? ''}/read`, ids.b1))).toEqual([
        404,
        'not_found',
      ]);
    });

    it('answers feature_disabled, an empty list or quote null for everything of the lender whose statements switch was turned off', async () => {
      const e1doc = docs.e1?.id ?? '';
      expect(
        SvcLoanDocumentList.parse((await get(url('/documents'), ids.b1)).json()).items,
      ).toHaveLength(1);
      expect((await get(url(`/documents/${e1doc}/content`), ids.b1)).statusCode).toBe(200);
      expect(
        (await post(url('/statements'), ids.b1, {}, { key: `it-sv-${RUN}-e1-before-01` }))
          .statusCode,
      ).toBe(201);
      expect((await get(url('/closure'), ids.b1)).statusCode).toBe(200);
      await kill('statements_noc');
      const accessBefore = (await accessRows(e1doc)).length;
      expect((await get(url('/documents'), ids.b1)).json()).toEqual({ items: [] });
      expect(problem(await get(url(`/documents/${e1doc}/content`), ids.b1))).toEqual([
        409,
        'feature_disabled',
      ]);
      expect((await accessRows(e1doc)).length).toBe(accessBefore);
      expect(
        problem(await post(url('/statements'), ids.b1, {}, { key: `it-sv-${RUN}-e1-after-001` })),
      ).toEqual([409, 'feature_disabled']);
      expect(problem(await post(url('/foreclosure-quotes'), ids.b1))).toEqual([
        409,
        'feature_disabled',
      ]);
      expect((await get(url('/document-requests'), ids.b1)).json()).toEqual({ items: [] });
      expect((await get(url('/foreclosure-quotes/latest'), ids.b1)).json()).toEqual({
        quote: null,
      });
      expect(problem(await get(url('/closure'), ids.b1))).toEqual([409, 'feature_disabled']);
      const openRequest = (await requestRows(ls('E1')))[0]?.id ?? '';
      expect(
        problem(await post(`${url('/document-requests')}/${openRequest}/cancel`, ids.b1)),
      ).toEqual([409, 'feature_disabled']);
      expect(await statusOfRequest(openRequest)).toBe('requested');
    });

    it('hides the loan itself, its schedule and its activity from a lender whose servicing switch was turned off', async () => {
      expect(
        SvcLoanList.parse((await get('/v1/loans', ids.b1)).json()).items.map((i) => i.loanId),
      ).toContain(ls('E1'));
      expect((await get(url(), ids.b1)).statusCode).toBe(200);
      expect((await get(url('/schedule'), ids.b1)).statusCode).toBe(200);
      await kill('servicing_sync');
      for (const suffix of ['', '/schedule', '/activity'])
        expect([suffix, ...problem(await get(url(suffix), ids.b1))]).toEqual([
          suffix,
          404,
          'not_found',
        ]);
      expect(
        SvcLoanList.parse((await get('/v1/loans', ids.b1)).json()).items.map((i) => i.loanId),
      ).not.toContain(ls('E1'));
    });
  });

  // ================================================================================================================
  // Rate limits
  // ================================================================================================================
  describe('rate limits', () => {
    it('limits a write route per borrower and answers 429 with a stable code', async () => {
      const statuses: number[] = [];
      let last: Awaited<ReturnType<typeof post>> | undefined;
      for (let n = 0; n < 31; n += 1) {
        last = await post(`/v1/me/reminders/${randomUUID()}/read`, ids.b4);
        statuses.push(last.statusCode);
      }
      expect(statuses.slice(0, 30).every((s) => s === 404)).toBe(true);
      expect(statuses[30]).toBe(429);
      expect(last ? code(last) : '').toBe('rate_limited');
      expect(last?.headers['retry-after']).toBeDefined();
    });

    it('limits a read route per borrower and answers 429 with a stable code', async () => {
      const statuses: number[] = [];
      for (let n = 0; n < 121; n += 1)
        statuses.push((await get('/v1/me/reminders', ids.b4)).statusCode);
      expect(statuses.slice(0, 120).every((s) => s === 200)).toBe(true);
      expect(statuses[120]).toBe(429);
    });
  });

  // ================================================================================================================
  // What no response or log may contain
  // ================================================================================================================
  describe('data minimisation', () => {
    it('never returns a bank reference, payment mode, provider reference, settlement reference, storage key, phone number or lender user, in any response of this file', () => {
      expect(seen.length).toBeGreaterThan(300);
      const forbiddenValues = [
        CANARY.phoneB1,
        CANARY.phoneB2,
        CANARY.phoneB3,
        CANARY.phoneB4,
        CANARY.bankRef,
        CANARY.paymentMode,
        CANARY.providerPaymentRef,
        CANARY.providerOrderRef,
        CANARY.settlementRef,
        CANARY.receiptRef,
        CANARY.storagePrefix,
        ids.aOp,
        ids.aOp2,
        ids.bOp,
        ids.eOp,
        ids.pFeatures,
        borrower.b1 ?? 'x',
        borrower.b2 ?? 'x',
      ];
      const forbiddenNames =
        /bank_?reference|payment_?mode|provider_?(payment|order)?_?ref|settlement|storage_?key|uploaded_?by|content_?sha|idempotency_?key\b|confirmation_?ref|recorded_?by|requested_?by|borrower_?id|phone/i;
      for (const { url, body } of seen) {
        for (const value of forbiddenValues)
          expect([url, value, body.includes(value)]).toEqual([url, value, false]);
        // The document bodies are base64 of a PDF; every other response is JSON text that must carry no personal-looking digits.
        if (!url.endsWith('/content') && !url.includes('/content?')) {
          expect([url, forbiddenNames.test(body)]).toEqual([url, false]);
          expect([url, /\d{10,}/.test(body.replace(UUID_RE, ''))]).toEqual([url, false]);
        }
      }
    });

    it('writes none of it to the request log either, whatever the outcome', async () => {
      // A second app, built the way a deployed process is built (real serializers and redaction), with its log output captured.
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
      const logged = await buildApp(loadConfig({ APP_ENV: 'local', LOG_LEVEL: 'trace' }), {
        auth: { verifier: fakeVerifier, context: createUserContext(apiPool) },
        documents: store,
      });
      const send = (method: 'GET' | 'POST', url: string, user: string, payload?: unknown) =>
        logged.inject({
          method,
          url,
          remoteAddress: freshAddress(),
          headers: {
            authorization: `Bearer test.${user}.aal1`,
            ...(method === 'POST' ? { 'idempotency-key': `it-sv-log-${randomUUID()}` } : {}),
          },
          ...(payload === undefined ? {} : { payload: payload as object }),
        });
      const tamperFile = path.join(storeRoot, docs.stmt1?.key ?? '');
      let cursor: string;
      try {
        await send('GET', '/v1/loans', ids.b1);
        await send('GET', `/v1/loans/${ls('A1')}`, ids.b1);
        await send('GET', `/v1/loans/${ls('A1')}/schedule`, ids.b1);
        const page = await send('GET', `/v1/loans/${ls('A1')}/activity?limit=2`, ids.b1);
        cursor = page.json<{ nextCursor: string }>().nextCursor;
        await send('GET', `/v1/loans/${ls('A1')}/activity?limit=2&cursor=${cursor}`, ids.b1);
        await send('GET', `/v1/loans/${ls('A1')}/documents`, ids.b1);
        await send(
          'GET',
          `/v1/loans/${ls('A1')}/documents/${docs.stmt2?.id ?? ''}/content`,
          ids.b1,
        );
        await send('GET', `/v1/loans/${ls('A1')}/foreclosure-quotes/latest`, ids.b1);
        await send('GET', `/v1/loans/${ls('A2')}/closure`, ids.b1);
        await send('GET', '/v1/me/reminders', ids.b1);
        await send('POST', `/v1/me/reminders/${reminders.ra2 ?? ''}/read`, ids.b1, {});
        await send('POST', `/v1/loans/${ls('A5')}/statements`, ids.b1, {
          periodFrom: istDate(Date.now() - 60 * DAY),
          periodTo: istDate(Date.now() - 30 * DAY),
        });
        await send('GET', `/v1/loans/${ls('AB2')}`, ids.b1);
        await send('GET', `/v1/loans/${ls('AB2')}/documents/${docs.ab2?.id ?? ''}/content`, ids.b1);
        fs.writeFileSync(tamperFile, pdf(`altered for the log ${RUN}`));
        await send(
          'GET',
          `/v1/loans/${ls('A1')}/documents/${docs.stmt1?.id ?? ''}/content`,
          ids.b1,
        );
        await new Promise((resolve) => setTimeout(resolve, 300));
      } finally {
        fs.writeFileSync(tamperFile, docs.stmt1?.bytes ?? '');
        await logged.close();
        vi.restoreAllMocks();
      }
      const log = captured.join('');
      expect(log).toContain('request completed');
      expect(log).toContain('unhandled error');
      for (const value of [
        CANARY.phoneB1,
        CANARY.phoneB2,
        CANARY.bankRef,
        CANARY.paymentMode,
        CANARY.providerPaymentRef,
        CANARY.providerOrderRef,
        CANARY.settlementRef,
        CANARY.receiptRef,
        CANARY.storagePrefix,
        `SV-A1-${RUN}`,
        docs.stmt1?.reference ?? 'x',
        sha256(docs.stmt1?.bytes ?? ''),
        sha256(docs.stmt2?.bytes ?? ''),
        (docs.stmt2?.bytes ?? Buffer.alloc(0)).toString('base64').slice(0, 24),
        reminderMessages.ra2 ?? 'x',
        'Alpha Servicing',
        ids.aOp,
        cursor,
        'cursor=',
        'periodFrom',
        'contentBase64',
      ])
        expect([value, log.includes(value)]).toEqual([value, false]);
    });
  });

  // ================================================================================================================
  // The declared contract
  // ================================================================================================================
  describe('contract', () => {
    it('declares every route in the OpenAPI document', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/openapi.json' });
      expect(res.statusCode).toBe(200);
      const paths = res.json<{ paths: Record<string, Record<string, unknown>> }>().paths;
      const declared = [
        'get /v1/loans',
        'get /v1/loans/{id}',
        'get /v1/loans/{id}/schedule',
        'get /v1/loans/{id}/activity',
        'get /v1/loans/{id}/documents',
        'get /v1/loans/{id}/documents/{docId}/content',
        'post /v1/loans/{id}/statements',
        'post /v1/loans/{id}/foreclosure-quotes',
        'get /v1/loans/{id}/foreclosure-quotes/latest',
        'get /v1/loans/{id}/document-requests',
        'post /v1/loans/{id}/document-requests/{requestId}/cancel',
        'get /v1/loans/{id}/closure',
        'get /v1/me/reminders',
        'post /v1/me/reminders/{id}/read',
      ];
      for (const entry of declared) {
        const [method, route] = entry.split(' ');
        expect([entry, Boolean(paths[route ?? '']?.[method ?? ''])]).toEqual([entry, true]);
      }
    });

    /** The values a check constraint of a column lists (`kind = ANY (ARRAY['a'::text, 'b'::text])`). */
    const constraintValues = async (table: string, column: string) => {
      const rows = await q<{ def: string }>(
        `select pg_get_constraintdef(oid) as def from pg_constraint
          where conrelid = $1::regclass and contype = 'c' and pg_get_constraintdef(oid) ~ ('^CHECK \\(\\(?' || $2 || ' = ANY')`,
        [table, column],
      );
      const def = rows[0]?.def ?? '';
      return [...def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1] ?? '').sort();
    };
    const enumValues = async (type: string) =>
      (await q<{ v: string }>(`select unnest(enum_range(null::${type}))::text as v`))
        .map((r) => r.v)
        .sort();

    it('mirrors the closed vocabularies of the database', async () => {
      expect([...SVC_LOAN_STATUSES].sort()).toEqual(await enumValues('servicing.loan_status'));
      expect([...SVC_ACTIVITY_PURPOSES].sort()).toEqual(
        await enumValues('payments.intent_purpose'),
      );
      expect([...SVC_DOCUMENT_KINDS].sort()).toEqual(
        await constraintValues('servicing.loan_documents', 'kind'),
      );
      expect([...SVC_DOCUMENT_KINDS].sort()).toEqual(
        await constraintValues('servicing.document_requests', 'kind'),
      );
      expect([...SVC_DOCUMENT_SOURCES].sort()).toEqual(
        await constraintValues('servicing.loan_documents', 'source'),
      );
      expect([...SVC_QUOTE_SOURCES].sort()).toEqual(
        await constraintValues('servicing.foreclosure_quotes', 'source'),
      );
      expect([...SVC_REQUEST_STATUSES].sort()).toEqual(
        await constraintValues('servicing.document_requests', 'status'),
      );
      expect([...SVC_COLLATERAL_TYPES].sort()).toEqual(
        await constraintValues('servicing.security_release_tasks', 'collateral_type'),
      );
      expect([...SVC_EVIDENCE_STATUSES].sort()).toEqual(
        await constraintValues('documents.applicability_rules', 'evidence_status'),
      );
      expect([...SVC_REMINDER_KINDS].sort()).toEqual(
        await constraintValues('servicing.reminder_templates', 'kind'),
      );
      expect([...SVC_ACTIVITY_KINDS].sort()).toEqual(
        ['lender_receipt', 'lender_reversal', 'payment_attempt', 'payment_adjustment'].sort(),
      );
    });

    it('lists, as activity states, exactly the receipt states, the payment stages, the terminal attempt statuses and the adjustment kinds the database can produce', async () => {
      const intentStatuses = await enumValues('payments.intent_status');
      const adjustmentKinds = await constraintValues('payments.payment_adjustments', 'kind');
      const terminalAttempts = intentStatuses.filter((s) =>
        ['cancelled', 'failed', 'expired'].includes(s),
      );
      expect(terminalAttempts).toHaveLength(3);
      expect([...SVC_ACTIVITY_STATES].sort()).toEqual(
        [
          'posted',
          'reversed',
          'recorded',
          'started',
          'provider_received',
          'lender_posted',
          'needs_attention',
          ...terminalAttempts,
          ...adjustmentKinds,
        ].sort(),
      );
    });
  });
});
