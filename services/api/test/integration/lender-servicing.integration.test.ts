// Phase 08a lender-side servicing over HTTP, against a REAL migrated Postgres: loans as the lender reported them, the sync
// status and the LMS connection, the all-or-nothing file import, conflicts and anomalies, lender-issued documents, foreclosure
// quotations, closure and security release. Same gating as the other integration files (INTEGRATION_ADMIN_URL and
// INTEGRATION_API_URL, a freshly migrated database). Synthetic data only.
//
// Fixtures: four lenders (A and B with both switches on, C with every switch off and a blocked REST connection, D with both
// switches on that the kill-switch test turns off), lender users who hold different single permissions, a platform auditor and
// two borrowers. The rows that a lender's reports would create (snapshots, schedule, receipts, flags, a conflict) are inserted
// AS THE TABLE OWNER with triggers and foreign keys switched off for one transaction; everything else (loans created by an
// import, conflicts, anomalies, documents, quotations, closure tasks) goes through the real routes and the real SQL
// functions with row level security applied, so the rows have the shape the database really produces.
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createLocalDocumentStore,
  parseLmsImportFile,
  type DocumentStore,
  type LmsImportKind,
} from '@udofin/adapters';
import {
  LS_ANOMALY_KINDS,
  LS_BATCH_STATUSES,
  LS_CAPABILITY_KEYS,
  LS_COLLATERAL_TYPES,
  LS_CONFLICT_REASONS,
  LS_DOCUMENT_KINDS,
  LS_LOAN_STATUSES,
  LsAnomalyPage,
  LsClosurePage,
  LsConflictPage,
  LsDocumentContent,
  LsDocumentList,
  LsDocumentRequestPage,
  LsImportBatchPage,
  LsImportDetail,
  LsImportOutcome,
  LsLoanDetail,
  LsLoanPage,
  LsQuotePage,
  LsQuoteResult,
  LsSyncStatus,
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
const freshAddress = () => `10.12.${(nextAddress >> 8) & 255}.${nextAddress++ & 255}`;

/** Makes every reference of this run unique, so a re-run on a database that was not reset cannot collide. */
const RUN = randomUUID().slice(0, 8).toUpperCase();

// Values that must never come back in a response, an audit record or a log line. They are planted where a careless layer could
// echo them: the borrower's phone number, an account-number-shaped reference inside an import file, the name of a secret, a
// storage key prefix, and text of a request.
const digits = (n: number) => String(Math.floor(10 ** (n - 1) + Math.random() * 9 * 10 ** (n - 1)));
const CANARY = {
  phoneB1: `91${Math.floor(7_000_000_000 + Math.random() * 2_999_999_999)}`,
  phoneB2: `91${Math.floor(7_000_000_000 + Math.random() * 2_999_999_999)}`,
  /** A 12-digit, account-number-shaped value a careless lender could put in a reference column. */
  account: digits(12),
  /** A phone-number-shaped reference. */
  phoneRef: `+91${Math.floor(7_000_000_000 + Math.random() * 2_999_999_999)}`,
  secretRef: `CANARY_SECRET_REF_${RUN}`,
  email: `someone.${RUN.toLowerCase()}@example.test`,
  amountText: '12.345',
  logToken: `LOGCANARY-${RUN}`,
};

interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
interface Problem {
  code?: string;
  status?: number;
  detail?: string;
}

const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const iso = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
const dateOnly = (daysAgo: number) =>
  new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);

/** A flat, honest PDF: no scripts, no attachments. The label makes the bytes (and so the hash) differ. */
const pdf = (label: string) =>
  Buffer.from(
    `%PDF-1.4\n% ${label}\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`,
  );

type LoanRecord = Record<string, string>;
/** A SAMPLE loan record in format udofin-lms-import-v1: every value a string, money in rupees. */
function loanRecord(input: {
  loanRef: string;
  appRef: string;
  srid: string;
  hoursAgo: number;
  extra?: Record<string, string>;
  drop?: string[];
}): LoanRecord {
  const record: LoanRecord = {
    lms_loan_ref: input.loanRef,
    borrower_ref: input.appRef,
    status: 'active',
    sanctioned_amount: '50000.00',
    disbursed_amount: '50000.00',
    disbursement_ref: `DISB-${input.loanRef}`,
    disbursement_date: dateOnly(30),
    outstanding_principal: '41666.67',
    next_due_date: dateOnly(-10),
    next_due_amount: '4500.00',
    overdue_principal: '0.00',
    overdue_interest: '0.00',
    penal_charges: '0.00',
    other_charges: '0.00',
    total_overdue: '0.00',
    days_past_due: '0',
    source_record_id: input.srid,
    reported_as_of: iso(input.hoursAgo),
    ...input.extra,
  };
  for (const key of input.drop ?? []) delete record[key];
  return record;
}

/** A valid request body for staging a file (the shape is checked before the caller is). */
const importBody = (lenderId: string, over: Record<string, unknown> = {}) => ({
  lenderId,
  kind: 'loan',
  sourceKind: 'file',
  formatVersion: 'udofin-lms-import-v1',
  fileFormat: 'json',
  content: '[]',
  ...over,
});
/** A valid request body for registering a statement. */
const uploadBody = (reference: string, over: Record<string, unknown> = {}) => ({
  kind: 'statement',
  mimeType: 'application/pdf',
  contentBase64: pdf(reference).toString('base64'),
  lenderReference: reference,
  issuedAt: iso(1),
  periodFrom: dateOnly(60),
  periodTo: dateOnly(30),
  ...over,
});

describe.skipIf(!enabled)('lender servicing over HTTP', () => {
  const ids = {
    platformOrg: randomUUID() as string,
    lenderA: randomUUID(),
    lenderB: randomUUID(),
    lenderC: randomUUID(),
    lenderD: randomUUID(),
    // lender A users: the system role of an operator holds loan.read, servicing.manual_entry, servicing.sync.manage and
    // servicing.document.issue; the others hold one thing each.
    aOp: randomUUID(),
    aOp2: randomUUID(),
    aOp3: randomUUID(),
    aOp4: randomUUID(),
    aViewer: randomUUID(), // loan.read only
    aNoRead: randomUUID(), // product approver: no loan.read
    aManual: randomUUID(), // loan.read + servicing.manual_entry
    aSync: randomUUID(), // loan.read + servicing.sync.manage
    aDocs: randomUUID(), // loan.read + servicing.document.issue
    aDocs2: randomUUID(),
    bOp: randomUUID(),
    cOp: randomUUID(),
    dOp: randomUUID(),
    pAud: randomUUID(), // platform auditor: loan.read across lenders
    pFeatures: randomUUID(), // platform features admin (kills a switch)
    requester: randomUUID(), // signs the switch requests (not a member)
    decider: randomUUID(),
    b1: randomUUID(), // borrower users
    b2: randomUUID(),
    stranger: randomUUID(), // a signed-in user with no access at all
  };
  const aOps = [ids.aOp, ids.aOp2, ids.aOp3, ids.aOp4];
  let nextOp = 0;
  /** Imports are limited per person; the tests rotate over four operators of the same lender. */
  const rotateOp = () => aOps[nextOp++ % aOps.length] ?? ids.aOp;

  const borrower = { b1: '', b2: '' };
  const apps: Record<string, string> = {};
  const loan: Record<string, string> = {};
  const appRef = (label: string) => `SAMPLE-APP-${label}-${RUN}`;
  let admin: pg.Pool;
  let apiPool: pg.Pool;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let appNoStore: Awaited<ReturnType<typeof buildApp>>;
  let store: DocumentStore;
  let storeRoot = '';
  /** Every response body this file received, for the final scan. */
  const seen: string[] = [];

  type Target = Awaited<ReturnType<typeof buildApp>>;
  const call = (
    method: 'GET' | 'POST',
    url: string,
    user: string | null,
    payload?: unknown,
    options: { aal?: 'aal1' | 'aal2'; key?: string | null; on?: Target } = {},
  ) =>
    (options.on ?? app)
      .inject({
        method,
        url,
        remoteAddress: freshAddress(),
        headers: {
          ...(user ? { authorization: `Bearer test.${user}.${options.aal ?? 'aal2'}` } : {}),
          ...(method === 'POST' && options.key !== null
            ? { 'idempotency-key': options.key ?? `it-${randomUUID()}` }
            : {}),
        },
        ...(payload === undefined ? {} : { payload: payload as object }),
      })
      .then((res) => {
        seen.push(res.body);
        return res;
      });
  type Res = Awaited<ReturnType<typeof call>>;
  const get = (url: string, user: string | null, options: Parameters<typeof call>[4] = {}) =>
    call('GET', url, user, undefined, options);
  const post = (
    url: string,
    user: string | null,
    payload: unknown = {},
    options: Parameters<typeof call>[4] = {},
  ) => call('POST', url, user, payload, options);
  const code = (res: { json: () => unknown }) => (res.json() as Problem).code;
  const q = async <T extends pg.QueryResultRow>(sql: string, values: unknown[] = []) =>
    (await admin.query<T>(sql, values)).rows;
  const scalar = async <T>(sql: string, values: unknown[] = []): Promise<T> => {
    const rows = await q<{ v: T }>(sql, values);
    if (!rows[0]) throw new Error('no row');
    return rows[0].v;
  };

  /** Runs statements in one transaction as the table owner. */
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

  /** A role of one lender that holds exactly the listed permissions, and a member who holds it. */
  async function memberWithPermissions(
    org: string,
    user: string,
    key: string,
    permissions: string[],
  ) {
    const role = randomUUID();
    await admin.query(
      `insert into tenancy.roles (id, org_id, applies_to, key, name) values ($1, $2, 'lender', $3, $4)`,
      [role, org, key, `${key} (test)`],
    );
    await admin.query(
      `insert into tenancy.role_permissions (role_id, permission_key) select $1, unnest($2::text[])`,
      [role, permissions],
    );
    const m = await admin.query<{ id: string }>(
      'insert into tenancy.memberships (org_id, user_id, status) values ($1, $2, $3) returning id',
      [org, user, 'active'],
    );
    await admin.query(
      'insert into tenancy.membership_roles (membership_id, role_id) values ($1, $2)',
      [m.rows[0]?.id, role],
    );
  }

  /** Objects in the document store (the files under servicing/). */
  const storeFiles = (): string[] => {
    const dir = path.join(storeRoot, 'servicing');
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => !f.endsWith('.mime')) : [];
  };

  /** Calls a database function as a signed-in user and COMMITS (the kill switch is a real, lasting change). */
  async function asUserCommit(user: string, sql: string, values: unknown[] = []) {
    const c = await admin.connect();
    try {
      await c.query('begin');
      await c.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: user, role: 'authenticated', aal: 'aal2' }),
      ]);
      await c.query('set local role authenticated');
      await c.query(sql, values);
      await c.query('commit');
    } catch (error) {
      await c.query('rollback');
      throw error;
    } finally {
      c.release();
    }
  }

  // ----------------------------------------------------------------------------------------------------------------
  // Fixture
  // ----------------------------------------------------------------------------------------------------------------
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: ADMIN, max: 4 });
    apiPool = new pg.Pool({ connectionString: API, max: 8 });
    storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'udofin-ls-store-'));
    store = createLocalDocumentStore(storeRoot, 'test');

    const staff = [
      ids.aOp,
      ids.aOp2,
      ids.aOp3,
      ids.aOp4,
      ids.aViewer,
      ids.aNoRead,
      ids.aManual,
      ids.aSync,
      ids.aDocs,
      ids.aDocs2,
      ids.bOp,
      ids.cOp,
      ids.dOp,
      ids.pAud,
      ids.pFeatures,
      ids.requester,
      ids.decider,
      ids.stranger,
    ];
    for (const id of staff)
      await admin.query(
        `insert into auth.users (id, phone, raw_app_meta_data) values ($1, null, '{"actor_type":"staff"}')`,
        [id],
      );
    for (const [id, phone] of [
      [ids.b1, CANARY.phoneB1],
      [ids.b2, CANARY.phoneB2],
    ] as const)
      await admin.query(
        `insert into auth.users (id, phone, raw_app_meta_data) values ($1, $2, '{}')`,
        [id, phone],
      );
    borrower.b1 = await scalar<string>(
      'select id::text as v from identity.borrowers where user_id = $1',
      [ids.b1],
    );
    borrower.b2 = await scalar<string>(
      'select id::text as v from identity.borrowers where user_id = $1',
      [ids.b2],
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
    ] as const) {
      await admin.query(
        `insert into tenancy.organizations (id, kind, legal_name, display_name, regulator_registration_no, status) values ($1, 'lender', $2, $3, $4, 'active')`,
        [lender, `${name} Ltd (test)`, name, `IT-LS-${lender.slice(0, 8)}`],
      );
      await admin.query(
        `insert into onboarding.lender_gates (lender_org_id, stage) values ($1, 'activated')`,
        [lender],
      );
    }
    for (const u of aOps) await member(ids.lenderA, u, 'lender', 'servicing_operator');
    await member(ids.lenderA, ids.aViewer, 'lender', 'viewer');
    await member(ids.lenderA, ids.aNoRead, 'lender', 'product_approver');
    await memberWithPermissions(ids.lenderA, ids.aManual, 'ls_manual_entry_only', [
      'loan.read',
      'servicing.manual_entry',
    ]);
    await memberWithPermissions(ids.lenderA, ids.aSync, 'ls_sync_manage_only', [
      'loan.read',
      'servicing.sync.manage',
    ]);
    await memberWithPermissions(ids.lenderA, ids.aDocs, 'ls_document_issue_only', [
      'loan.read',
      'servicing.document.issue',
    ]);
    await memberWithPermissions(ids.lenderA, ids.aDocs2, 'ls_document_issue_only_two', [
      'loan.read',
      'servicing.document.issue',
    ]);
    await member(ids.lenderB, ids.bOp, 'lender', 'servicing_operator');
    await member(ids.lenderC, ids.cOp, 'lender', 'servicing_operator');
    await member(ids.lenderD, ids.dOp, 'lender', 'servicing_operator');
    await member(ids.platformOrg, ids.pAud, 'platform', 'auditor');
    await member(ids.platformOrg, ids.pFeatures, 'platform', 'platform_features_admin');

    // The switches (an applied two-person request and the switch row in ONE transaction, the only way the guard accepts).
    await transaction(async (c) => {
      const switches: [string, string][] = [
        ...[ids.lenderA, ids.lenderB, ids.lenderD].flatMap((l): [string, string][] => [
          [l, 'servicing_sync'],
          [l, 'statements_noc'],
        ]),
      ];
      for (const [lender, feature] of switches)
        await c.query(
          `insert into servicing.feature_change_requests (lender_org_id, feature, enable, mode, status, evidence, requested_by, idempotency_key, decided_by, decided_at, applied_at)
           values ($1::uuid, $2, true, 'two_person', 'applied', '{"contract_ref":"SAMPLE-LS"}', $3::uuid, $4, $5::uuid, now(), now())`,
          [
            lender,
            feature,
            ids.requester,
            `ls-req-${feature}-${lender.slice(0, 8)}-0001`,
            ids.decider,
          ],
        );
      await c.query(
        `insert into servicing.lender_features (lender_org_id, feature, enabled, evidence, enabled_by, enabled_at, last_change_request_id)
         select r.lender_org_id, r.feature, true, r.evidence, $1::uuid, now(), r.id from servicing.feature_change_requests r
          where r.idempotency_key like 'ls-req-%' and r.requested_by = $2::uuid`,
        [ids.decider, ids.requester],
      );
    });

    // Connections: A, B and D take files; C records a REST connector that is blocked (its secret name is a canary).
    for (const lender of [ids.lenderA, ids.lenderB, ids.lenderD])
      await admin.query(
        `insert into servicing.lms_connections (lender_org_id, kind, status, capabilities, created_by, updated_by)
         values ($1, 'file_import', 'active', '{"receipts": true}'::jsonb, $2, $2)`,
        [lender, ids.decider],
      );
    await admin.query(
      `insert into servicing.lms_connections (lender_org_id, kind, status, secret_ref, created_by, updated_by)
       values ($1, 'finbyx', 'blocked_unverified', $2, $3, $3)`,
      [ids.lenderC, CANARY.secretRef, ids.decider],
    );

    // Applications the lenders can name in a file (borrower_ref): created with foreign keys off, as the products and loan
    // requests behind them are not what these tests are about.
    const appPlan: [string, string, string][] = [
      // label, lender, borrower
      ['A1', ids.lenderA, borrower.b1],
      ['A2', ids.lenderA, borrower.b1],
      ['A3', ids.lenderA, borrower.b2],
      ['B1', ids.lenderB, borrower.b2],
      ['C1', ids.lenderC, borrower.b1],
      ['D1', ids.lenderD, borrower.b1],
      ['IMP1', ids.lenderA, borrower.b1],
      ['IMP2', ids.lenderA, borrower.b2],
      ['IMP3', ids.lenderA, borrower.b1],
      ['IMP4', ids.lenderA, borrower.b2],
      ['IMP5', ids.lenderA, borrower.b1],
      ['IMPB', ids.lenderB, borrower.b2],
      ['LOGA', ids.lenderA, borrower.b1],
    ];
    await transaction(async (c) => {
      for (const [label, lender, who] of appPlan) {
        const id = randomUUID();
        apps[label] = id;
        await c.query(
          `insert into lending.applications (id, lender_org_id, loan_request_id, borrower_id, product_version_id, status, requested_amount_minor, requested_tenure_days, lender_reference)
           values ($1::uuid, $2::uuid, gen_random_uuid(), $3::uuid, gen_random_uuid(), 'disbursement_pending', 5000000, 365, $4)`,
          [id, lender, who, appRef(label)],
        );
      }
    }, true);

    // Loans (normal mode: the closure trigger fires for the closed one).
    const loanPlan: [string, string, string, string][] = [
      // label, lender, status, application label
      ['A1', ids.lenderA, 'active', 'A1'],
      ['A2', ids.lenderA, 'closed', 'A2'],
      ['A3', ids.lenderA, 'active', 'A3'],
      ['B1', ids.lenderB, 'active', 'B1'],
      ['C1', ids.lenderC, 'active', 'C1'],
      ['D1', ids.lenderD, 'active', 'D1'],
    ];
    for (const [label, lender, status, appLabel] of loanPlan) {
      const id = randomUUID();
      loan[label] = id;
      await admin.query(
        `insert into servicing.loan_accounts (id, lender_org_id, application_id, borrower_id, source_system, lms_loan_ref, status, sanctioned_amount_minor,
                                              disbursed_amount_minor, disbursed_at, disbursement_reference)
         select $1::uuid, $2::uuid, a.id, a.borrower_id, 'file_import', $3, $4::servicing.loan_status, 5000000, 5000000, now() - interval '30 days', $5
           from lending.applications a where a.id = $6::uuid`,
        [id, lender, `LS-${label}-${RUN}`, status, `FIX-DISB-${label}-${RUN}`, apps[appLabel]],
      );
    }

    // What the lender reported for the loans, flags and one conflict (rows the sync would have written).
    await transaction(async (c) => {
      const snapshot = async (
        lender: string,
        loanId: string,
        version: number,
        hoursAgo: number,
        extra: { total: number; flags?: string[] } = { total: 125_000 },
      ) => {
        const id = randomUUID();
        await c.query(
          `insert into servicing.balance_snapshots (id, lender_org_id, loan_account_id, version, status, outstanding_principal_minor, overdue_principal_minor,
             overdue_interest_minor, penal_charges_minor, other_charges_minor, total_overdue_minor, next_due_on, next_due_minor, days_past_due, flags,
             source_system, source_record_id, reported_as_of, content_sha256)
           values ($1::uuid, $2::uuid, $3::uuid, $4, 'active', 4000000, 100000, 20000, 5000, 0, $5, (now() at time zone 'Asia/Kolkata')::date + 1, 475000, 3,
                   $6::text[], 'file_import', $7, now() - make_interval(hours => $8::int), $9)`,
          [
            id,
            lender,
            loanId,
            version,
            extra.total,
            extra.flags ?? [],
            `FIX-SRC-${String(version)}-${loanId.slice(0, 8)}`,
            hoursAgo,
            sha256(`fixture-${loanId}-${String(version)}`),
          ],
        );
        return id;
      };
      const a1v1 = await snapshot(ids.lenderA, loan.A1 ?? '', 1, 3);
      const a1v2 = await snapshot(ids.lenderA, loan.A1 ?? '', 2, 1, {
        total: 130_000,
        flags: ['overdue_total_mismatch'],
      });
      void a1v1;
      await snapshot(ids.lenderB, loan.B1 ?? '', 1, 2);
      await snapshot(ids.lenderD, loan.D1 ?? '', 1, 2);

      // The newest schedule (version 2) supersedes version 1; three installments.
      for (const version of [1, 2]) {
        const sid = randomUUID();
        await c.query(
          `insert into servicing.schedule_snapshots (id, lender_org_id, loan_account_id, version, reported_as_of)
           values ($1::uuid, $2::uuid, $3::uuid, $4, now() - make_interval(hours => $5::int))`,
          [sid, ids.lenderA, loan.A1, version, 5 - version],
        );
        for (let seq = 1; seq <= (version === 2 ? 3 : 1); seq += 1)
          await c.query(
            `insert into servicing.schedule_installments (snapshot_id, lender_org_id, seq, due_date, principal_minor, interest_minor, fees_minor)
             values ($1::uuid, $2::uuid, $3, (now() at time zone 'Asia/Kolkata')::date + $4::int, 400000, 75000, $5)`,
            [sid, ids.lenderA, seq, seq * 30, seq === 3 ? 1000 : 0],
          );
      }

      // Receipts: one receipt and a reversal of part of it.
      const r1 = randomUUID();
      await c.query(
        `insert into servicing.lms_receipts (id, lender_org_id, loan_account_id, kind, lms_receipt_ref, amount_minor, value_date, payment_mode, bank_reference,
           source_system, source_record_id, reported_as_of, content_sha256)
         values ($1::uuid, $2::uuid, $3::uuid, 'receipt', $4, 475000, (now() at time zone 'Asia/Kolkata')::date - 3, 'upi', $5, 'file_import', 'FIX-R1',
                 now() - interval '2 hours', $6)`,
        [r1, ids.lenderA, loan.A1, `FIX-RCPT-1-${RUN}`, `SAMPLE-UTR-${RUN}`, sha256(`r1-${RUN}`)],
      );
      await c.query(
        `insert into servicing.lms_receipts (lender_org_id, loan_account_id, kind, lms_receipt_ref, reverses_receipt_id, reverses_receipt_ref, amount_minor,
           value_date, source_system, source_record_id, reported_as_of, content_sha256)
         values ($1::uuid, $2::uuid, 'reversal', $3, $4::uuid, $5, 100000, (now() at time zone 'Asia/Kolkata')::date - 2, 'file_import', 'FIX-R2',
                 now() - interval '1 hour', $6)`,
        [ids.lenderA, loan.A1, `FIX-RCPT-2-${RUN}`, r1, `FIX-RCPT-1-${RUN}`, sha256(`r2-${RUN}`)],
      );

      // Flags: one warning (the lender's parts do not add up) and one note (an older report was ignored).
      await c.query(
        `insert into servicing.sync_anomalies (lender_org_id, loan_account_id, kind, severity, snapshot_id, previous_amount_minor, reported_amount_minor,
           source_system, source_record_id, content_sha256, reported_as_of)
         values ($1::uuid, $2::uuid, 'overdue_total_mismatch', 'warning', $3::uuid, 125000, 130000, 'file_import', 'FIX-SRC-2', $4, now() - interval '1 hour')`,
        [ids.lenderA, loan.A1, a1v2, sha256(`an1-${RUN}`)],
      );
      await c.query(
        `insert into servicing.sync_anomalies (lender_org_id, loan_account_id, kind, severity, source_system, source_record_id, content_sha256, reported_as_of)
         values ($1::uuid, $2::uuid, 'older_report_ignored', 'info', 'file_import', 'FIX-SRC-0', $3, now() - interval '9 hours')`,
        [ids.lenderA, loan.A1, sha256(`an2-${RUN}`)],
      );
      // An open conflict on each of A1 and B1 (the lender reported the same record twice with different content).
      for (const [lender, loanId, label] of [
        [ids.lenderA, loan.A1, 'a1'],
        [ids.lenderB, loan.B1, 'b1'],
      ] as const)
        await c.query(
          `insert into servicing.sync_conflicts (lender_org_id, loan_account_id, record_type, conflict_reason, source_record_id, existing_content_sha256,
             existing_reported_as_of, incoming_content_sha256, incoming_reported_as_of, incoming_report, source_system)
           values ($1::uuid, $2::uuid, 'loan', 'same_time_different_content', $3, $4, now() - interval '1 hour', $5, now() - interval '1 hour',
                   $6::jsonb, 'file_import')`,
          [
            lender,
            loanId,
            `FIX-SRC-${label}`,
            sha256(`ex-${label}-${RUN}`),
            sha256(`in-${label}-${RUN}`),
            JSON.stringify({
              lms_loan_ref: `LS-${label.toUpperCase()}-${RUN}`,
              source_record_id: `FIX-SRC-${label}`,
            }),
          ],
        );
    }, true);

    // Borrowers' requests for documents (the borrower side is another route; the lender side answers them here).
    await transaction(async (c) => {
      const requests: [string, string, string, string, string | null, string | null][] = [
        // key, lender, loan, kind, period from, period to
        ['STMT-A1', ids.lenderA, 'A1', 'statement', dateOnly(60), dateOnly(30)],
        ['QUOTE-A1', ids.lenderA, 'A1', 'foreclosure_quote', null, null],
        ['NOC-A2', ids.lenderA, 'A2', 'noc', null, null],
        ['DECL-A3', ids.lenderA, 'A3', 'statement', dateOnly(90), dateOnly(60)],
        ['STMT-B1', ids.lenderB, 'B1', 'statement', dateOnly(60), dateOnly(30)],
        ['STMT-C1', ids.lenderC, 'C1', 'statement', dateOnly(60), dateOnly(30)],
      ];
      for (const [key, lender, loanLabel, kind, from, to] of requests) {
        const id = randomUUID();
        apps[`REQ-${key}`] = id;
        await c.query(
          `insert into servicing.document_requests (id, lender_org_id, loan_account_id, kind, period_from, period_to, requested_by, idempotency_key)
           values ($1::uuid, $2::uuid, $3::uuid, $4, $5::date, $6::date, $7::uuid, $8)`,
          [id, lender, loan[loanLabel], kind, from, to, ids.b1, `ls-req-${key}-${RUN}`],
        );
      }
    }, true);

    const config = loadConfig({ APP_ENV: 'test' });
    const auth = { verifier: fakeVerifier, context: createUserContext(apiPool) };
    app = await buildApp(config, { auth, documents: store });
    appNoStore = await buildApp(config, { auth });
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await appNoStore?.close();
    await apiPool?.end();
    // The integration files share one database, so this file leaves none of its servicing rows behind. Triggers and foreign
    // keys are off for this one transaction (the append-only triggers would refuse a delete) and every delete is scoped to
    // this file's four lenders.
    if (admin && ids.lenderD) {
      const mine = [ids.lenderA, ids.lenderB, ids.lenderC, ids.lenderD];
      const c = await admin.connect();
      try {
        await c.query('begin');
        await c.query('set local session_replication_role = replica');
        for (const table of [
          'servicing.loan_document_access',
          'servicing.foreclosure_quotes',
          'servicing.document_requests',
          'servicing.security_release_tasks',
          'servicing.closure_records',
          'servicing.loan_documents',
          'servicing.sync_anomalies',
          'servicing.sync_conflicts',
          'servicing.sync_quarantine',
          'servicing.lms_receipts',
          'servicing.schedule_installments',
          'servicing.schedule_snapshots',
          'servicing.balance_snapshots',
          'servicing.import_rows',
          'servicing.import_batches',
          'servicing.loan_account_events',
          'servicing.loan_accounts',
          'servicing.lms_connections',
          'servicing.lender_features',
          'servicing.feature_change_requests',
          'lending.applications',
        ])
          await c.query(`delete from ${table} where lender_org_id = any($1::uuid[])`, [mine]);
        await c.query(
          `delete from ops.outbox_events where payload ->> 'lender_org_id' = any($1::text[])`,
          [mine],
        );
        await c.query('commit');
      } catch (error) {
        await c.query('rollback');
        throw error;
      } finally {
        c.release();
      }
    }
    await admin?.end();
    if (storeRoot) fs.rmSync(storeRoot, { recursive: true, force: true });
  });

  // ================================================================================================================
  // Who may call at all
  // ================================================================================================================
  describe('callers', () => {
    const routes: [string, 'GET' | 'POST', string][] = [
      ['loans', 'GET', '/v1/lender/loans'],
      ['sync status', 'GET', '/v1/lender/sync/status'],
      ['imports', 'GET', '/v1/lender/imports'],
      ['closures', 'GET', '/v1/lender/closures'],
      ['document requests', 'GET', '/v1/lender/document-requests'],
      ['conflicts', 'GET', '/v1/lender/sync/conflicts'],
    ];

    it('answers 401 to a caller without a token on every route', async () => {
      for (const [, method, url] of routes) {
        const res = await call(method, url, null, method === 'POST' ? {} : undefined);
        expect([url, res.statusCode]).toEqual([url, 401]);
      }
      // The request is checked for shape before the caller is, so a valid body is needed to reach the 401.
      const write = await post('/v1/lender/lms-connection', null, {
        lenderId: ids.lenderA,
        kind: 'file_import',
        status: 'active',
      });
      expect(write.statusCode).toBe(401);
      const upload = await post(
        `/v1/lender/loans/${loan.A1 ?? ''}/documents`,
        null,
        uploadBody(`ANON-${RUN}`),
      );
      expect(upload.statusCode).toBe(401);
      const staged = await post('/v1/lender/imports', null, importBody(ids.lenderA));
      expect(staged.statusCode).toBe(401);
      expect(storeFiles()).toHaveLength(0);
    });

    it('answers 401 mfa_required to a staff session without the second factor, on reads and writes alike', async () => {
      for (const [, , url] of routes) {
        const res = await call('GET', url, ids.aOp, undefined, { aal: 'aal1' });
        expect([url, res.statusCode, code(res)]).toEqual([url, 401, 'mfa_required']);
      }
      const write = await post(
        '/v1/lender/lms-connection',
        ids.aSync,
        { lenderId: ids.lenderA, kind: 'file_import', status: 'active' },
        { aal: 'aal1' },
      );
      expect([write.statusCode, code(write)]).toEqual([401, 'mfa_required']);
      const upload = await post(
        `/v1/lender/loans/${loan.A1 ?? ''}/documents`,
        ids.aDocs,
        uploadBody(`AAL1-${RUN}`),
        { aal: 'aal1' },
      );
      expect([upload.statusCode, code(upload)]).toEqual([401, 'mfa_required']);
      const staged = await post('/v1/lender/imports', ids.aOp, importBody(ids.lenderA), {
        aal: 'aal1',
      });
      expect([staged.statusCode, code(staged)]).toEqual([401, 'mfa_required']);
      const committed = await post(
        `/v1/lender/imports/${randomUUID()}/commit`,
        ids.aOp,
        {},
        {
          aal: 'aal1',
        },
      );
      expect([committed.statusCode, code(committed)]).toEqual([401, 'mfa_required']);
      expect(storeFiles()).toHaveLength(0);
      expect(
        await scalar<string>(
          `select count(*)::text as v from servicing.loan_documents where lender_reference = $1`,
          [`AAL1-${RUN}`],
        ),
      ).toBe('0');
    });

    it('answers 403 staff_only to a borrower and 403 no_active_access to a user with no access', async () => {
      const borrowerRes = await get('/v1/lender/loans', ids.b1);
      expect([borrowerRes.statusCode, code(borrowerRes)]).toEqual([403, 'staff_only']);
      const strangerRes = await get('/v1/lender/loans', ids.stranger);
      expect([strangerRes.statusCode, code(strangerRes)]).toEqual([403, 'no_active_access']);
      const write = await post('/v1/lender/imports', ids.b1, importBody(ids.lenderA));
      expect([write.statusCode, code(write)]).toEqual([403, 'staff_only']);
      const upload = await post(
        `/v1/lender/loans/${loan.A1 ?? ''}/documents`,
        ids.b1,
        uploadBody(`BORROWER-${RUN}`),
      );
      expect([upload.statusCode, code(upload)]).toEqual([403, 'staff_only']);
      expect(storeFiles()).toHaveLength(0);
    });

    it('answers 403 to a lender user who cannot read loans, on every read', async () => {
      for (const [, , url] of routes) {
        const res = await get(url, ids.aNoRead);
        expect([url, res.statusCode, code(res)]).toEqual([url, 403, 'forbidden']);
      }
      for (const url of [
        `/v1/lender/loans/${loan.A1 ?? ''}`,
        `/v1/lender/loans/${loan.A1 ?? ''}/foreclosure-quotes`,
        `/v1/lender/imports/${randomUUID()}`,
      ]) {
        const res = await get(url, ids.aNoRead);
        expect([url, res.statusCode]).toEqual([url, 403]);
      }
    });

    it('answers a method that is not declared with 404 or 405, never with data', async () => {
      const res = await call('POST', '/v1/lender/loans', ids.aOp, {});
      expect([404, 405]).toContain(res.statusCode);
    });
  });

  // ================================================================================================================
  // Loans as the lender reported them
  // ================================================================================================================
  describe('loans', () => {
    it("lists a lender's own loans, newest first, and nobody else's", async () => {
      const res = await get('/v1/lender/loans?limit=100', ids.aViewer);
      expect(res.statusCode).toBe(200);
      const page = LsLoanPage.parse(res.json());
      const idsSeen = page.items.map((i) => i.id);
      expect(idsSeen).toEqual(expect.arrayContaining([loan.A1, loan.A2, loan.A3]));
      for (const other of [loan.B1, loan.C1, loan.D1]) expect(idsSeen).not.toContain(other);
      expect(new Set(page.items.map((i) => i.lenderId))).toEqual(new Set([ids.lenderA]));
      const created = page.items.map((i) => i.createdAt);
      expect(created).toEqual([...created].sort().reverse());
      const a1 = page.items.find((i) => i.id === loan.A1);
      expect(a1).toMatchObject({
        lmsLoanRef: `LS-A1-${RUN}`,
        status: 'active',
        sanctionedAmountMinor: 5_000_000,
        disbursedAmountMinor: 5_000_000,
        sync: {
          stale: false,
          hasOpenConflict: true,
          newestHasWarning: true,
          stalenessThresholdMinutes: 1440,
        },
      });
    });

    it('filters by status and by lender, and pages with a keyset cursor', async () => {
      const closed = LsLoanPage.parse(
        (await get('/v1/lender/loans?status=closed&limit=100', ids.aOp)).json(),
      );
      expect(closed.items.map((i) => i.id)).toEqual([loan.A2]);
      expect(closed.items[0]?.disbursedAmountMinor).toBe(5_000_000);
      const walked: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 50; guard += 1) {
        const res: Res = await get(
          `/v1/lender/loans?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
          ids.aOp,
        );
        const page = LsLoanPage.parse(res.json());
        expect(page.items.length).toBeLessThanOrEqual(1);
        walked.push(...page.items.map((i) => i.id));
        cursor = page.nextCursor;
        if (!cursor) break;
      }
      expect(new Set(walked).size).toBe(walked.length);
      expect(walked).toEqual(expect.arrayContaining([loan.A1, loan.A2, loan.A3]));
      // A cursor cannot widen access: lender B walks only its own loans, whatever the cursor says.
      const b = LsLoanPage.parse((await get('/v1/lender/loans?limit=100', ids.bOp)).json());
      expect(b.items.map((i) => i.id)).toContain(loan.B1);
      expect(b.items.map((i) => i.id)).not.toContain(loan.A1);
      expect((await get('/v1/lender/loans?cursor=not-a-cursor', ids.aOp)).statusCode).toBe(400);
      expect((await get('/v1/lender/loans?status=nonsense', ids.aOp)).statusCode).toBe(422);
      expect((await get('/v1/lender/loans?extra=1', ids.aOp)).statusCode).toBe(422);
      expect((await get('/v1/lender/loans?limit=101', ids.aOp)).statusCode).toBe(422);
    });

    it("answers 403 for a lender filter the caller does not hold, and shows another lender's loans to nobody", async () => {
      const res = await get(`/v1/lender/loans?lenderId=${ids.lenderA}`, ids.bOp);
      expect([res.statusCode, code(res)]).toEqual([403, 'forbidden']);
      const unknown = await get(`/v1/lender/loans?lenderId=${randomUUID()}`, ids.aOp);
      expect(unknown.statusCode).toBe(403);
      const own = await get(`/v1/lender/loans?lenderId=${ids.lenderA}&limit=100`, ids.aOp);
      expect(own.statusCode).toBe(200);
      for (const item of LsLoanPage.parse(own.json()).items)
        expect(item.lenderId).toBe(ids.lenderA);
    });

    it('lets a platform auditor (loan.read across lenders) read, and shows every lender it may', async () => {
      const res = await get('/v1/lender/loans?limit=100', ids.pAud);
      expect(res.statusCode).toBe(200);
      const seenIds = LsLoanPage.parse(res.json()).items.map((i) => i.id);
      expect(seenIds).toEqual(expect.arrayContaining([loan.A1, loan.B1]));
    });

    it('returns the loan with the newest report, schedule, receipts and the flags that wait', async () => {
      const res = await get(`/v1/lender/loans/${loan.A1 ?? ''}`, ids.aViewer);
      expect(res.statusCode).toBe(200);
      const detail = LsLoanDetail.parse(res.json());
      expect(detail.loan.id).toBe(loan.A1);
      // The newest report is version 2, reported an hour ago, with the lender's own mismatch flag; nothing is recomputed.
      expect(detail.report).toMatchObject({
        version: 2,
        status: 'active',
        outstandingPrincipalMinor: 4_000_000,
        overduePrincipalMinor: 100_000,
        overdueInterestMinor: 20_000,
        penalChargesMinor: 5_000,
        otherChargesMinor: 0,
        totalOverdueMinor: 130_000,
        nextDueMinor: 475_000,
        daysPastDue: 3,
        flags: ['overdue_total_mismatch'],
        sourceSystem: 'file_import',
      });
      expect(detail.schedule?.version).toBe(2);
      expect(detail.schedule?.installments.map((i) => [i.seq, i.totalMinor])).toEqual([
        [1, 475_000],
        [2, 475_000],
        [3, 476_000],
      ]);
      expect(detail.receipts.map((r) => [r.kind, r.amountMinor]).sort()).toEqual([
        ['receipt', 475_000],
        ['reversal', 100_000],
      ]);
      const reversal = detail.receipts.find((r) => r.kind === 'reversal');
      expect(reversal?.reversesReceiptRef).toBe(`FIX-RCPT-1-${RUN}`);
      expect(detail.receipts.find((r) => r.kind === 'receipt')?.bankReference).toBe(
        `SAMPLE-UTR-${RUN}`,
      );
      expect(detail.openConflicts).toBe(1);
      expect(detail.anomalies).toEqual({ warning: 1, info: 1 });
    });

    it('answers a loan without a report with an empty report and a stale flag, never a guess', async () => {
      const detail = LsLoanDetail.parse(
        (await get(`/v1/lender/loans/${loan.A3 ?? ''}`, ids.aOp)).json(),
      );
      expect(detail.report).toBeNull();
      expect(detail.schedule).toBeNull();
      expect(detail.receipts).toEqual([]);
      expect(detail.loan.sync).toMatchObject({ stale: true, newestReportedAsOf: null });
    });

    it("answers 404 for another lender's loan, an unknown loan, and 422 for a malformed id; never the data", async () => {
      for (const [user, id] of [
        [ids.bOp, loan.A1],
        [ids.cOp, loan.A1],
        [ids.aOp, loan.B1],
        [ids.aOp, randomUUID()],
      ] as const) {
        const res = await get(`/v1/lender/loans/${id ?? ''}`, user);
        expect([res.statusCode, code(res)]).toEqual([404, 'not_found']);
      }
      expect((await get('/v1/lender/loans/not-a-uuid', ids.aOp)).statusCode).toBe(422);
    });
  });

  // ================================================================================================================
  // Sync status, anomalies, conflicts and the LMS connection
  // ================================================================================================================
  describe('sync status', () => {
    it('shows each lender its connection and counts over its own loans', async () => {
      const res = await get('/v1/lender/sync/status', ids.aViewer);
      expect(res.statusCode).toBe(200);
      const status = LsSyncStatus.parse(res.json());
      expect(status.items.map((i) => i.lenderId)).toEqual([ids.lenderA]);
      const a = status.items[0];
      expect(a?.connection).toMatchObject({
        lenderId: ids.lenderA,
        kind: 'file_import',
        status: 'active',
        capabilities: { receipts: true },
        stalenessThresholdMinutes: 1440,
      });
      expect(a?.loans.total).toBeGreaterThanOrEqual(3);
      // A1 has a conflict and a warning; A2 and A3 never reported (a loan with no report is counted stale).
      expect(a?.loans.withOpenConflict).toBeGreaterThanOrEqual(1);
      expect(a?.loans.withWarning).toBeGreaterThanOrEqual(1);
      expect(a?.loans.neverReported).toBeGreaterThanOrEqual(2);
      expect(a?.loans.stale).toBeGreaterThanOrEqual(a?.loans.neverReported ?? 0);
      expect(a?.newestReportedAsOf).not.toBeNull();
    });

    it("shows nothing of another lender, answers 403 for a lender the caller does not hold, and never returns a secret's name", async () => {
      const b = LsSyncStatus.parse((await get('/v1/lender/sync/status', ids.bOp)).json());
      expect(b.items.map((i) => i.lenderId)).toEqual([ids.lenderB]);
      expect(
        (await get(`/v1/lender/sync/status?lenderId=${ids.lenderA}`, ids.bOp)).statusCode,
      ).toBe(403);
      // Lender C records a REST connector that is blocked; reading is allowed with every switch off, and the name of the
      // secret never leaves the database.
      const c = await get(`/v1/lender/sync/status?lenderId=${ids.lenderC}`, ids.cOp);
      expect(c.statusCode).toBe(200);
      const item = LsSyncStatus.parse(c.json()).items[0];
      expect(item?.connection).toMatchObject({ kind: 'finbyx', status: 'blocked_unverified' });
      expect(c.body).not.toContain(CANARY.secretRef);
      // The auditor sees the lenders it may.
      const all = LsSyncStatus.parse((await get('/v1/lender/sync/status', ids.pAud)).json());
      expect(all.items.map((i) => i.lenderId)).toEqual(
        expect.arrayContaining([ids.lenderA, ids.lenderB]),
      );
    });

    it('lists the flags the sync raised, newest first, with both figures and nothing corrected', async () => {
      const res = await get(
        `/v1/lender/sync/anomalies?loanAccountId=${loan.A1 ?? ''}`,
        ids.aViewer,
      );
      expect(res.statusCode).toBe(200);
      const page = LsAnomalyPage.parse(res.json());
      expect(page.items.map((i) => [i.kind, i.severity]).sort()).toEqual([
        ['older_report_ignored', 'info'],
        ['overdue_total_mismatch', 'warning'],
      ]);
      const warning = page.items.find((i) => i.severity === 'warning');
      expect(warning).toMatchObject({
        previousAmountMinor: 125_000,
        reportedAmountMinor: 130_000,
        sourceSystem: 'file_import',
      });
      const onlyWarnings = LsAnomalyPage.parse(
        (
          await get(
            `/v1/lender/sync/anomalies?severity=warning&lenderId=${ids.lenderA}&limit=100`,
            ids.aOp,
          )
        ).json(),
      );
      expect(onlyWarnings.items.every((i) => i.severity === 'warning')).toBe(true);
      expect(onlyWarnings.items.every((i) => i.lenderId === ids.lenderA)).toBe(true);
      // Another lender sees none of A's flags.
      const other = LsAnomalyPage.parse(
        (await get(`/v1/lender/sync/anomalies?limit=100`, ids.bOp)).json(),
      );
      expect(other.items.map((i) => i.loanAccountId)).not.toContain(loan.A1);
      expect(
        (await get(`/v1/lender/sync/anomalies?lenderId=${ids.lenderA}`, ids.bOp)).statusCode,
      ).toBe(403);
    });

    it('lists conflicts of the lender only, and filters by status', async () => {
      const a = LsConflictPage.parse(
        (await get('/v1/lender/sync/conflicts?limit=100', ids.aViewer)).json(),
      );
      expect(a.items.map((i) => i.loanAccountId)).toContain(loan.A1);
      expect(a.items.map((i) => i.loanAccountId)).not.toContain(loan.B1);
      const conflict = a.items.find((i) => i.loanAccountId === loan.A1);
      expect(conflict).toMatchObject({
        recordType: 'loan',
        conflictReason: 'same_time_different_content',
        status: 'open',
        acknowledgedAt: null,
        resolvedAt: null,
        confirmedVersion: null,
      });
      const resolved = LsConflictPage.parse(
        (await get('/v1/lender/sync/conflicts?status=resolved&limit=100', ids.aViewer)).json(),
      );
      expect(resolved.items.every((i) => i.status === 'resolved')).toBe(true);
      expect(
        (await get(`/v1/lender/sync/conflicts?lenderId=${ids.lenderB}`, ids.aOp)).statusCode,
      ).toBe(403);
    });
  });

  describe('the LMS connection', () => {
    it('lets a person who may manage the sync set the single connection, and shows it back', async () => {
      const key = `it-conn-${randomUUID()}`;
      const body = {
        lenderId: ids.lenderA,
        kind: 'file_import',
        status: 'active',
        capabilities: { receipts: true, schedule: true },
        stalenessThresholdMinutes: 720,
      };
      const res = await post('/v1/lender/lms-connection', ids.aSync, body, { key });
      expect(res.statusCode).toBe(200);
      const { id } = res.json<{ id: string }>();
      const row = await q<{
        kind: string;
        status: string;
        threshold: number;
        caps: Record<string, boolean>;
      }>(
        `select kind, status, staleness_threshold_minutes as threshold, capabilities as caps from servicing.lms_connections where id = $1`,
        [id],
      );
      expect(row[0]).toMatchObject({ kind: 'file_import', status: 'active', threshold: 720 });
      expect(row[0]?.caps).toEqual({ receipts: true, schedule: true });
      const shown = LsSyncStatus.parse((await get('/v1/lender/sync/status', ids.aViewer)).json());
      expect(shown.items[0]?.connection).toMatchObject({
        id,
        stalenessThresholdMinutes: 720,
        capabilities: { receipts: true, schedule: true },
      });
      // The same request with the same key is a replay: the stored answer, flagged.
      const again = await post('/v1/lender/lms-connection', ids.aSync, body, { key });
      expect(again.statusCode).toBe(200);
      expect(again.headers['idempotent-replayed']).toBe('true');
      expect(again.json()).toEqual({ id });
      // The same key with another body is refused.
      const clash = await post(
        '/v1/lender/lms-connection',
        ids.aSync,
        { ...body, stalenessThresholdMinutes: 60 },
        { key },
      );
      expect([clash.statusCode, code(clash)]).toEqual([422, 'idempotency_key_reused']);
      // Put it back for the import tests.
      await post('/v1/lender/lms-connection', ids.aSync, {
        lenderId: ids.lenderA,
        kind: 'file_import',
        status: 'active',
        capabilities: { receipts: true },
        stalenessThresholdMinutes: 1440,
      });
    });

    it('refuses a connector that has no specification, and a mock outside local and test sessions', async () => {
      const finbyx = await post('/v1/lender/lms-connection', ids.aSync, {
        lenderId: ids.lenderA,
        kind: 'finbyx',
        status: 'active',
      });
      expect([finbyx.statusCode, code(finbyx)]).toEqual([409, 'connector_unverified']);
      const mock = await post('/v1/lender/lms-connection', ids.aSync, {
        lenderId: ids.lenderA,
        kind: 'mock',
        status: 'active',
      });
      expect([mock.statusCode, code(mock)]).toEqual([403, 'mock_provider_blocked']);
      const blocked = await post('/v1/lender/lms-connection', ids.aSync, {
        lenderId: ids.lenderA,
        kind: 'file_import',
        status: 'blocked_unverified',
      });
      expect([blocked.statusCode, code(blocked)]).toEqual([409, 'bad_status']);
      const connection = await q<{ kind: string }>(
        'select kind from servicing.lms_connections where lender_org_id = $1',
        [ids.lenderA],
      );
      expect(connection[0]?.kind).toBe('file_import');
    });

    it('answers 403 to a person without servicing.sync.manage, to another lender and to an unknown lender', async () => {
      const body = { lenderId: ids.lenderA, kind: 'file_import', status: 'paused' };
      const who: [string, string][] = [
        ['viewer', ids.aViewer],
        ['manual entry only', ids.aManual],
        ['document issue only', ids.aDocs],
        ['no loan.read', ids.aNoRead],
        ['other lender', ids.bOp],
        ['platform auditor', ids.pAud],
      ];
      for (const [label, user] of who) {
        const res = await post('/v1/lender/lms-connection', user, body);
        expect([label, res.statusCode, code(res)]).toEqual([label, 403, 'forbidden']);
      }
      const unknown = await post('/v1/lender/lms-connection', ids.aSync, {
        ...body,
        lenderId: randomUUID(),
      });
      expect([unknown.statusCode, code(unknown)]).toEqual([403, 'forbidden']);
      const status = await scalar<string>(
        'select status as v from servicing.lms_connections where lender_org_id = $1',
        [ids.lenderA],
      );
      expect(status).toBe('active');
    });

    it('answers feature_disabled while the servicing_sync switch is off', async () => {
      const res = await post('/v1/lender/lms-connection', ids.cOp, {
        lenderId: ids.lenderC,
        kind: 'file_import',
        status: 'active',
      });
      expect([res.statusCode, code(res)]).toEqual([409, 'feature_disabled']);
      const kind = await scalar<string>(
        'select kind as v from servicing.lms_connections where lender_org_id = $1',
        [ids.lenderC],
      );
      expect(kind).toBe('finbyx');
    });

    it('validates the shape: unknown fields, capabilities, threshold, kinds', async () => {
      const base = { lenderId: ids.lenderA, kind: 'file_import', status: 'active' };
      for (const bad of [
        { ...base, extra: 1 },
        { ...base, capabilities: { pull: 'yes' } },
        { ...base, capabilities: { telepathy: true } },
        { ...base, stalenessThresholdMinutes: 4 },
        { ...base, stalenessThresholdMinutes: 43_201 },
        { ...base, stalenessThresholdMinutes: 1.5 },
        { ...base, kind: 'ftp' },
        { ...base, status: 'on' },
        { ...base, lenderId: 'nope' },
        {},
      ]) {
        const res = await post('/v1/lender/lms-connection', ids.aSync, bad);
        expect([JSON.stringify(bad), res.statusCode, code(res)]).toEqual([
          JSON.stringify(bad),
          422,
          'validation_failed',
        ]);
      }
      const noKey = await post('/v1/lender/lms-connection', ids.aSync, base, { key: null });
      expect([noKey.statusCode, code(noKey)]).toEqual([400, 'idempotency_key_required']);
    });
  });

  // @@MORE@@
});
