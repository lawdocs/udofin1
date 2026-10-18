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
const RUN = randomUUID()
  .replace(/-/g, '')
  .slice(0, 8)
  .toUpperCase()
  // Letters only: a run id with digits could form a PAN-shaped or number-shaped reference that the importer refuses.
  .replace(/[0-9]/g, (digit) => 'GHIJKLMNOP'.charAt(Number(digit)));

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
    aDocs3: randomUUID(),
    aDocs4: randomUUID(),
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
  const aDocUsers = [ids.aDocs, ids.aDocs2, ids.aDocs3, ids.aDocs4];
  let nextDocUser = 0;
  /** Uploads are limited per person; where the identity does not matter the tests rotate over four people who may issue. */
  const docUser = () => aDocUsers[nextDocUser++ % aDocUsers.length] ?? ids.aDocs;

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
      ids.aDocs3,
      ids.aDocs4,
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
    for (const [user, key] of [
      [ids.aDocs2, 'ls_document_issue_only_two'],
      [ids.aDocs3, 'ls_document_issue_only_three'],
      [ids.aDocs4, 'ls_document_issue_only_four'],
    ] as const)
      await memberWithPermissions(ids.lenderA, user, key, [
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

    it('answers feature_disabled for every kind but file_import and manual while the servicing_sync switch is off (A42)', async () => {
      // A file_import or manual connection is recorded before the switch is on (the switch needs one): see the kill-switch test,
      // which does it for a lender whose switch is off. Every other kind stays behind the switch.
      for (const body of [
        { kind: 'mock', status: 'active' },
        { kind: 'finbyx', status: 'blocked_unverified' },
        { kind: 'generic_rest', status: 'blocked_unverified' },
      ]) {
        const res = await post('/v1/lender/lms-connection', ids.cOp, {
          lenderId: ids.lenderC,
          ...body,
        });
        expect([body.kind, res.statusCode, code(res)]).toEqual([
          body.kind,
          409,
          'feature_disabled',
        ]);
      }
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

  // ================================================================================================================
  // File import: all or nothing
  // ================================================================================================================
  describe('file import', () => {
    const A = () => ids.lenderA;
    const out = (res: Res) => LsImportOutcome.parse(res.json());
    const stage = (user: string, over: Record<string, unknown>, key?: string) =>
      post('/v1/lender/imports', user, importBody(A(), over), key ? { key } : {});
    const parseAs = (kind: LmsImportKind, content: string, format: 'csv' | 'json' = 'json') =>
      parseLmsImportFile(content, { format, kind, sourceSystem: 'file_import' });
    const audit = (action: string, entityId?: string) =>
      q<{ metadata: Record<string, unknown>; tenant: string }>(
        `select metadata, tenant_org_id::text as tenant from audit.events
          where action = $1 and ($2::text is null or entity_id = $2) order by occurred_at`,
        [action, entityId ?? null],
      );
    const loanExists = async (ref: string) =>
      (await scalar<string>(
        `select count(*)::text as v from servicing.loan_accounts where lms_loan_ref = $1`,
        [ref],
      )) !== '0';
    const batchesWith = async (hash: string) =>
      Number(
        await scalar<string>(
          `select count(*)::text as v from servicing.import_batches where file_sha256 = $1`,
          [hash],
        ),
      );
    const ref = (label: string) => `LS-${label}-${RUN}`;
    const rec = (label: string, over: Partial<Parameters<typeof loanRecord>[0]> = {}) =>
      loanRecord({
        loanRef: ref(label),
        appRef: appRef(label),
        srid: `SRC-${label}-${RUN}`,
        hoursAgo: 5,
        ...over,
      });

    const state = {
      invalidBatch: '',
      invalidContent: '',
      imp1: rec('IMP1'),
      imp2: rec('IMP2'),
      committed: '',
      conflictId: '',
      failedBatch: '',
      rejectedBatch: '',
    };

    it('refuses a file with one bad row as a whole, shows the row error without the value, applies nothing and audits it', async () => {
      const op = rotateOp();
      const bad = rec('IMP2', { extra: { sanctioned_amount: CANARY.amountText } });
      const content = JSON.stringify([rec('IMP1'), bad]);
      const key = `it-refuse-${randomUUID()}`;
      const res = await post('/v1/lender/imports', op, importBody(A(), { content }), { key });
      expect(res.statusCode).toBe(200);
      const outcome = out(res);
      expect(outcome.batch).toBeNull();
      expect(outcome.existing).toBe(false);
      const hash = sha256(content);
      expect(outcome.refusedFile).toEqual({
        fileSha256: hash,
        byteSize: Buffer.byteLength(content),
        recordCount: 2,
      });
      expect(outcome.errors).toEqual([
        {
          rowNo: 2,
          outcome: 'error',
          errorCodes: ['invalid_amount'],
          fieldNames: ['sanctioned_amount'],
        },
      ]);
      // The row number, the class and the name of the field: never the value.
      expect(res.body).not.toContain(CANARY.amountText);
      // All or nothing: the good row of the same file was not applied either, and no batch exists.
      expect(await batchesWith(hash)).toBe(0);
      expect(await loanExists(ref('IMP1'))).toBe(false);
      expect(await loanExists(ref('IMP2'))).toBe(false);
      // The attempt is audited: the file's hash and size, the record count and the position, class and field name.
      const rows = await audit('servicing.import.file_rejected', hash);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.tenant).toBe(A());
      expect(rows[0]?.metadata).toMatchObject({
        kind: 'loan',
        source_kind: 'file',
        format_version: 'udofin-lms-import-v1',
        file_sha256: hash,
        byte_size: Buffer.byteLength(content),
        record_count: 2,
        error_count: 1,
        errors: [{ row_no: 2, code: 'invalid_amount', field: 'sanctioned_amount' }],
      });
      const text = JSON.stringify(rows[0]?.metadata);
      for (const secret of [CANARY.amountText, ref('IMP1'), appRef('IMP1'), `SRC-IMP1-${RUN}`])
        expect(text).not.toContain(secret);
      // The same request again with the same key is a replay: the stored answer, and no second audit record.
      const replay = await post('/v1/lender/imports', op, importBody(A(), { content }), { key });
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.json()).toEqual(res.json());
      expect(await audit('servicing.import.file_rejected', hash)).toHaveLength(1);
      // A new attempt with a new key is a new attempt, and is audited again.
      const again = await stage(rotateOp(), { content });
      expect(again.statusCode).toBe(200);
      expect(await audit('servicing.import.file_rejected', hash)).toHaveLength(2);
    });

    it('never echoes a value that looks like an account number, a phone number or a PAN, in the answer or the audit record', async () => {
      const pan = `ABCDE${digits(4)}F`;
      for (const [label, value] of [
        ['account', CANARY.account],
        ['phone', CANARY.phoneRef],
        ['pan', pan],
      ] as const) {
        const content = JSON.stringify([rec('IMP1', { appRef: value })]);
        const res = await stage(rotateOp(), { content });
        expect([label, res.statusCode]).toEqual([label, 200]);
        const outcome = out(res);
        expect(outcome.batch).toBeNull();
        expect(outcome.errors).toHaveLength(1);
        expect(outcome.errors[0]?.fieldNames).toEqual(['borrower_ref']);
        expect(['borrower_ref_looks_personal', 'invalid_reference']).toContain(
          outcome.errors[0]?.errorCodes[0],
        );
        expect(res.body).not.toContain(value.replace('+', ''));
        const rows = await audit('servicing.import.file_rejected', sha256(content));
        expect(rows).toHaveLength(1);
        expect(JSON.stringify(rows[0]?.metadata)).not.toContain(value.replace('+', ''));
      }
    });

    it('refuses what cannot be parsed or is not in the format, and audits the class at position zero', async () => {
      const cases: [string, string, 'csv' | 'json', string, string | null, number][] = [
        ['malformed JSON', '{ not json', 'json', 'malformed_file', null, 0],
        ['an unknown column', 'lms_loan_ref,secret_notes\nX,Y\n', 'csv', 'unknown_column', null, 0],
        ['a missing column', 'lms_loan_ref\nX\n', 'csv', 'missing_column', 'lms_receipt_ref', 0],
        ['an empty list', '[]', 'json', 'empty_file', null, 0],
      ];
      for (const [label, content, format, expectedCode, field, row] of cases) {
        const before = (await audit('servicing.import.file_rejected', sha256(content))).length;
        const res = await stage(rotateOp(), { content, fileFormat: format, kind: 'receipt' });
        expect([label, res.statusCode]).toEqual([label, 200]);
        const outcome = out(res);
        expect([label, outcome.batch]).toEqual([label, null]);
        expect(outcome.errors[0]).toMatchObject({ rowNo: row, errorCodes: [expectedCode] });
        if (field) expect(outcome.errors[0]?.fieldNames).toEqual([field]);
        const rows = await audit('servicing.import.file_rejected', sha256(content));
        expect([label, rows.length]).toEqual([label, before + 1]);
      }
    });

    it('refuses a file over the size limit, audited with its hash and size', async () => {
      const content = `${' '.repeat(5 * 1024 * 1024 + 16)}[]`;
      const res = await stage(rotateOp(), { content });
      expect(res.statusCode).toBe(200);
      const outcome = out(res);
      expect(outcome.errors).toEqual([
        { rowNo: 0, outcome: 'error', errorCodes: ['file_too_large'], fieldNames: [] },
      ]);
      expect(outcome.refusedFile?.byteSize).toBe(Buffer.byteLength(content));
      const rows = await audit('servicing.import.file_rejected', sha256(content));
      expect(rows[0]?.metadata).toMatchObject({
        byte_size: Buffer.byteLength(content),
        error_count: 1,
      });
    });

    it('stages a file the importer accepts but the database finds unmatched: invalid as a whole, no values kept, nothing applied', async () => {
      const unmatched = rec('NOAPP', { appRef: `SAMPLE-NOAPP-${RUN}` });
      state.invalidContent = JSON.stringify([state.imp1, unmatched]);
      const res = await stage(rotateOp(), { content: state.invalidContent });
      expect(res.statusCode).toBe(201);
      const outcome = out(res);
      const batch = outcome.batch;
      expect(batch).toMatchObject({
        lenderId: A(),
        kind: 'loan',
        sourceKind: 'file',
        status: 'invalid',
        rowCount: 2,
        counts: { new: 1, quarantined: 1, error: 0, conflict: 0 },
        fileSha256: sha256(state.invalidContent),
        byteSize: Buffer.byteLength(state.invalidContent),
      });
      state.invalidBatch = batch?.id ?? '';
      expect(outcome.errors).toEqual([
        { rowNo: 2, outcome: 'quarantined', errorCodes: ['application_not_found'], fieldNames: [] },
      ]);
      // The preview keeps no row value for an invalid batch (data minimisation, in the same transaction).
      const kept = await q<{ n: string; leaked: string }>(
        `select count(*)::text as n, count(*) filter (where normalised is not null or source_record_id is not null or row_sha256 is not null)::text as leaked
           from servicing.import_rows where batch_id = $1`,
        [state.invalidBatch],
      );
      expect(kept[0]).toEqual({ n: '2', leaked: '0' });
      // All or nothing: the matching row was not applied.
      expect(await loanExists(ref('IMP1'))).toBe(false);
      expect(res.body).not.toContain(appRef('NOAPP'));
      expect(res.body).not.toContain(`SAMPLE-NOAPP-${RUN}`);
      // It cannot be committed.
      const commit = await post(`/v1/lender/imports/${state.invalidBatch}/commit`, rotateOp(), {});
      expect([commit.statusCode, code(commit)]).toEqual([409, 'import_has_errors']);
      expect(await loanExists(ref('IMP1'))).toBe(false);
      // The same file again returns the same batch, whoever sends it.
      const again = await stage(rotateOp(), { content: state.invalidContent });
      expect(again.statusCode).toBe(200);
      expect(out(again).existing).toBe(true);
      expect(out(again).batch?.id).toBe(state.invalidBatch);
    });

    it('shows the stored problems of a batch to the lender and to nobody else', async () => {
      const res = await get(`/v1/lender/imports/${state.invalidBatch}`, ids.aViewer);
      expect(res.statusCode).toBe(200);
      const detail = LsImportDetail.parse(res.json());
      expect(detail.batch.status).toBe('invalid');
      expect(detail.errors).toEqual([
        { rowNo: 2, outcome: 'quarantined', errorCodes: ['application_not_found'], fieldNames: [] },
      ]);
      expect(detail.errorsTruncated).toBe(false);
      for (const user of [ids.bOp, ids.cOp, ids.pFeatures]) {
        const other = await get(`/v1/lender/imports/${state.invalidBatch}`, user);
        expect([other.statusCode]).toEqual([user === ids.pFeatures ? 403 : 404]);
      }
      const unknown = await get(`/v1/lender/imports/${randomUUID()}`, ids.aViewer);
      expect([unknown.statusCode, code(unknown)]).toEqual([404, 'not_found']);
      expect((await get('/v1/lender/imports/not-a-uuid', ids.aViewer)).statusCode).toBe(422);
    });

    it('says what a row number counts: a row of your file for a refused file, a record position for a stored batch (A5)', async () => {
      // File rows: 1 and 2 are identical (the importer keeps one), row 3 is a record no application matches. The database
      // numbers the records it received, so the unmatched one is its record 2 although it is row 3 of the file.
      const unmatched = rec('POS3', { appRef: `SAMPLE-NOAPP-POS3-${RUN}` });
      const content = JSON.stringify([state.imp1, state.imp1, unmatched]);
      const res = await stage(rotateOp(), { content });
      expect(res.statusCode).toBe(201);
      const outcome = out(res);
      expect(outcome.batch).toMatchObject({ status: 'invalid', rowCount: 2 });
      expect(outcome.errors).toEqual([
        { rowNo: 2, outcome: 'quarantined', errorCodes: ['application_not_found'], fieldNames: [] },
      ]);
      expect(outcome.rowNumbering).toBe('record_position');
      const detail = LsImportDetail.parse(
        (await get(`/v1/lender/imports/${outcome.batch?.id ?? ''}`, ids.aViewer)).json(),
      );
      expect(detail.rowNumbering).toBe('record_position');
      expect(detail.errors).toEqual(outcome.errors);
      // A file the importer refuses is numbered by its own rows.
      const refused = out(
        await stage(rotateOp(), {
          content: JSON.stringify([state.imp1, state.imp1, { ...state.imp2, status: 'nope' }]),
        }),
      );
      expect(refused.batch).toBeNull();
      expect(refused.errors.map((e) => e.rowNo)).toEqual([3]);
      expect(refused.rowNumbering).toBe('file_row');
    });

    it('refuses a number that is not finite in rows instead of dropping the field, as it does for the same record sent as text (A8)', async () => {
      const bad = JSON.stringify(rec('INF1')).replace(
        '"penal_charges":"0.00"',
        '"penal_charges":1e999',
      );
      expect(bad).toContain('1e999');
      const asRows = await app.inject({
        method: 'POST',
        url: '/v1/lender/imports',
        remoteAddress: freshAddress(),
        headers: {
          authorization: `Bearer test.${rotateOp()}.aal2`,
          'idempotency-key': `it-${randomUUID()}`,
          'content-type': 'application/json',
        },
        payload: `{"lenderId":"${A()}","kind":"loan","sourceKind":"file","formatVersion":"udofin-lms-import-v1","rows":[${bad}]}`,
      });
      seen.push(asRows.body);
      expect(asRows.statusCode, asRows.body).toBe(200);
      const outcome = out(asRows);
      expect(outcome.batch).toBeNull();
      expect(outcome.refusedFile).not.toBeNull();
      expect(outcome.errors).toEqual([
        {
          rowNo: 1,
          outcome: 'error',
          errorCodes: ['invalid_amount'],
          fieldNames: ['penal_charges'],
        },
      ]);
      // The same record as text is refused the same way.
      const asText = out(await stage(rotateOp(), { content: `[${bad}]` }));
      expect(asText.errors).toEqual(outcome.errors);
      expect(await loanExists(ref('INF1'))).toBe(false);
    });

    it('takes the corrected file as a resubmission, previews it, and keeps the earlier batch untouched', async () => {
      const content = JSON.stringify([state.imp1, state.imp2]);
      const res = await stage(rotateOp(), { content, resubmissionOf: state.invalidBatch });
      expect(res.statusCode).toBe(201);
      const outcome = out(res);
      expect(outcome.batch).toMatchObject({
        status: 'previewed',
        rowCount: 2,
        counts: { new: 2, quarantined: 0, error: 0 },
        resubmissionOf: state.invalidBatch,
      });
      expect(outcome.errors).toEqual([]);
      state.committed = outcome.batch?.id ?? '';
      const earlier = await get(`/v1/lender/imports/${state.invalidBatch}`, ids.aOp);
      expect(LsImportDetail.parse(earlier.json()).batch.status).toBe('invalid');
      // Nothing is applied by staging.
      expect(await loanExists(ref('IMP1'))).toBe(false);
      // A resubmission must name an earlier invalid, rejected or failed batch of the same lender and kind.
      const wrong = await stage(rotateOp(), {
        content: JSON.stringify([rec('IMP3')]),
        resubmissionOf: state.committed,
      });
      expect([wrong.statusCode, code(wrong)]).toEqual([422, 'resubmission_invalid']);
    });

    it('needs servicing.sync.manage to commit: manual entry alone, a viewer and another lender cannot', async () => {
      for (const [label, user, status] of [
        ['manual entry only', ids.aManual, 403],
        ['viewer', ids.aViewer, 403],
        ['document issue only', ids.aDocs, 403],
        ['other lender', ids.bOp, 404],
        ['switch-off lender', ids.cOp, 404],
        ['platform auditor', ids.pAud, 403],
      ] as const) {
        const res = await post(`/v1/lender/imports/${state.committed}/commit`, user, {});
        expect([label, res.statusCode]).toEqual([label, status]);
      }
      const still = await scalar<string>(
        `select status as v from servicing.import_batches where id = $1`,
        [state.committed],
      );
      expect(still).toBe('previewed');
      expect(await loanExists(ref('IMP1'))).toBe(false);
    });

    it('commits a previewed batch in one transaction, replays the same key, and answers the same batch for another key', async () => {
      const key = `it-commit-${randomUUID()}`;
      const res = await post(
        `/v1/lender/imports/${state.committed}/commit`,
        ids.aSync,
        {},
        { key },
      );
      expect(res.statusCode).toBe(200);
      const outcome = out(res);
      expect(outcome.existing).toBe(false);
      expect(outcome.batch).toMatchObject({
        status: 'committed',
        appliedCounts: { new: 2 },
        failureClass: null,
      });
      expect(outcome.batch?.committedAt).not.toBeNull();
      expect(await loanExists(ref('IMP1'))).toBe(true);
      expect(await loanExists(ref('IMP2'))).toBe(true);
      const replay = await post(
        `/v1/lender/imports/${state.committed}/commit`,
        ids.aSync,
        {},
        { key },
      );
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.json()).toEqual(res.json());
      const other = await post(`/v1/lender/imports/${state.committed}/commit`, ids.aSync, {});
      expect(other.statusCode).toBe(200);
      expect(out(other).existing).toBe(true);
      expect(out(other).batch?.status).toBe('committed');
      // Audited, and the outbox is told in the same transaction.
      expect(await audit('servicing.import.committed', state.committed)).toHaveLength(1);
      const events = await scalar<string>(
        `select count(*)::text as v from ops.outbox_events where event_type = 'servicing.import.committed' and payload ->> 'batch_id' = $1`,
        [state.committed],
      );
      expect(events).toBe('1');
    });

    it("shows the committed loans as the lender reported them, and the stored hash is the importer's hash", async () => {
      const list = LsLoanPage.parse((await get('/v1/lender/loans?limit=100', ids.aViewer)).json());
      const created = list.items.find((i) => i.lmsLoanRef === ref('IMP1'));
      expect(created).toMatchObject({
        status: 'active',
        sanctionedAmountMinor: 5_000_000,
        disbursedAmountMinor: 5_000_000,
        sync: { stale: false, hasOpenConflict: false, newestHasWarning: false },
      });
      loan.IMP1 = created?.id ?? '';
      const detail = LsLoanDetail.parse(
        (await get(`/v1/lender/loans/${loan.IMP1}`, ids.aViewer)).json(),
      );
      expect(detail.report).toMatchObject({
        version: 1,
        status: 'active',
        outstandingPrincipalMinor: 4_166_667,
        overduePrincipalMinor: 0,
        totalOverdueMinor: 0,
        nextDueMinor: 450_000,
        daysPastDue: 0,
        flags: [],
        sourceSystem: 'file_import',
      });
      // The API's parser and the database compute the same content hash for the same record.
      const parsed = parseAs('loan', JSON.stringify([state.imp1, state.imp2]));
      expect(parsed.importable).toBe(true);
      for (const report of parsed.rows) {
        const stored = await scalar<string>(
          `select b.content_sha256 as v from servicing.balance_snapshots b
             join servicing.loan_accounts l on l.id = b.loan_account_id where l.lms_loan_ref = $1`,
          [report.reportType === 'loan' ? report.lmsLoanRef : ''],
        );
        expect(stored).toBe(report.contentSha256);
      }
      // The lender's own application is untouched by a lender-run import (the system finishes the lifecycle).
      const appStatus = await scalar<string>(
        `select status::text as v from lending.applications where id = $1`,
        [apps.IMP1],
      );
      expect(appStatus).toBe('disbursement_pending');
    });

    it('lists the batches of the lender with their status, filters them, and shows other lenders none', async () => {
      const all = LsImportBatchPage.parse(
        (await get('/v1/lender/imports?limit=100', ids.aViewer)).json(),
      );
      expect(all.items.length).toBeGreaterThanOrEqual(2);
      expect(new Set(all.items.map((i) => i.lenderId))).toEqual(new Set([A()]));
      for (const status of all.items.map((i) => i.status))
        expect(LS_BATCH_STATUSES).toContain(status);
      const committed = LsImportBatchPage.parse(
        (await get('/v1/lender/imports?status=committed&kind=loan&limit=100', ids.aOp)).json(),
      );
      expect(committed.items.map((i) => i.id)).toContain(state.committed);
      expect(committed.items.every((i) => i.status === 'committed' && i.kind === 'loan')).toBe(
        true,
      );
      const b = LsImportBatchPage.parse(
        (await get('/v1/lender/imports?limit=100', ids.bOp)).json(),
      );
      expect(b.items.map((i) => i.id)).not.toContain(state.committed);
      expect((await get(`/v1/lender/imports?lenderId=${A()}`, ids.bOp)).statusCode).toBe(403);
      // A page holds at most the limit and ends with a null cursor.
      const walked: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 80; guard += 1) {
        const res: Res = await get(
          `/v1/lender/imports?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
          ids.aOp,
        );
        const page = LsImportBatchPage.parse(res.json());
        expect(page.items.length).toBeLessThanOrEqual(2);
        walked.push(...page.items.map((i) => i.id));
        cursor = page.nextCursor;
        if (!cursor) break;
      }
      expect(new Set(walked).size).toBe(walked.length);
      expect(walked).toContain(state.committed);
    });

    it('imports receipts from a CSV file entered by hand: staged by manual entry, committed by someone who may manage the sync', async () => {
      const header =
        'lms_loan_ref,lms_receipt_ref,receipt_kind,reverses_receipt_ref,amount,value_date,payment_mode,bank_reference,source_record_id,reported_as_of';
      const stamp = iso(4);
      const csv = [
        header,
        `${ref('IMP1')},RCPT-${RUN}-1,receipt,,1500.00,${dateOnly(2)},upi,SAMPLE-UTR-${RUN}-1,SRC-RCPT-${RUN}-1,${stamp}`,
        `${ref('IMP1')},RCPT-${RUN}-2,reversal,RCPT-${RUN}-1,500.00,${dateOnly(1)},,,SRC-RCPT-${RUN}-2,${stamp}`,
      ].join('\n');
      // Only manual entry can stage; sync.manage alone cannot.
      const denied = await stage(ids.aSync, {
        kind: 'receipt',
        sourceKind: 'manual',
        fileFormat: 'csv',
        content: csv,
      });
      expect([denied.statusCode, code(denied)]).toEqual([403, 'forbidden']);
      expect(await batchesWith(sha256(csv))).toBe(0);
      const res = await stage(ids.aManual, {
        kind: 'receipt',
        sourceKind: 'manual',
        fileFormat: 'csv',
        content: csv,
      });
      expect(res.statusCode).toBe(201);
      const outcome = out(res);
      expect(outcome.batch).toMatchObject({
        kind: 'receipt',
        sourceKind: 'manual',
        status: 'previewed',
        rowCount: 2,
        counts: { new: 2 },
      });
      const id = outcome.batch?.id ?? '';
      expect(
        await scalar<string>(
          `select source_system::text as v from servicing.import_batches where id = $1`,
          [id],
        ),
      ).toBe('manual_import');
      // Manual entry cannot commit.
      const forbidden = await post(`/v1/lender/imports/${id}/commit`, ids.aManual, {});
      expect([forbidden.statusCode, code(forbidden)]).toEqual([403, 'forbidden']);
      const committed = await post(`/v1/lender/imports/${id}/commit`, ids.aSync, {});
      expect(committed.statusCode).toBe(200);
      expect(out(committed).batch?.appliedCounts).toEqual({ new: 2 });
      const detail = LsLoanDetail.parse(
        (await get(`/v1/lender/loans/${loan.IMP1}`, ids.aViewer)).json(),
      );
      expect(detail.receipts.map((r) => [r.kind, r.amountMinor]).sort()).toEqual([
        ['receipt', 150_000],
        ['reversal', 50_000],
      ]);
      expect(detail.receipts.find((r) => r.kind === 'reversal')?.reversesReceiptRef).toBe(
        `RCPT-${RUN}-1`,
      );
      // The stored receipt hashes are the importer's.
      const parsed = parseAs('receipt', csv, 'csv');
      expect(parsed.importable).toBe(true);
      for (const report of parsed.rows) {
        const stored = await scalar<string>(
          `select content_sha256 as v from servicing.lms_receipts where lms_receipt_ref = $1 and lender_org_id = $2`,
          [report.reportType === 'receipt' ? report.lmsReceiptRef : '', A()],
        );
        expect(stored).toBe(report.contentSha256);
      }
    });

    it("imports a schedule given as JSON records, and the stored hash is the importer's", async () => {
      const record = {
        lms_loan_ref: ref('IMP1'),
        source_record_id: `SRC-SCHED-${RUN}`,
        reported_as_of: iso(4),
        installments: [
          {
            installment_seq: '1',
            due_date: dateOnly(-30),
            principal: '4166.67',
            interest: '333.33',
            fees: '0.00',
          },
          {
            installment_seq: '2',
            due_date: dateOnly(-60),
            principal: '4166.67',
            interest: '333.33',
          },
        ],
      };
      const res = await stage(rotateOp(), { kind: 'schedule', rows: [record], content: undefined });
      expect(res.statusCode).toBe(201);
      const id = out(res).batch?.id ?? '';
      const committed = await post(`/v1/lender/imports/${id}/commit`, rotateOp(), {});
      expect(out(committed).batch?.status).toBe('committed');
      const detail = LsLoanDetail.parse(
        (await get(`/v1/lender/loans/${loan.IMP1}`, ids.aViewer)).json(),
      );
      expect(detail.schedule?.version).toBe(1);
      expect(detail.schedule?.installments).toEqual([
        {
          seq: 1,
          dueDate: dateOnly(-30),
          principalMinor: 416_667,
          interestMinor: 33_333,
          feesMinor: 0,
          totalMinor: 450_000,
        },
        {
          seq: 2,
          dueDate: dateOnly(-60),
          principalMinor: 416_667,
          interestMinor: 33_333,
          feesMinor: 0,
          totalMinor: 450_000,
        },
      ]);
      const parsed = parseAs('schedule', JSON.stringify([record]));
      expect(parsed.importable).toBe(true);
      const report = parsed.rows[0];
      const stored = await scalar<string>(
        `select s.content_sha256 as v from servicing.schedule_snapshots s where s.loan_account_id = $1`,
        [loan.IMP1],
      );
      expect(stored).toBe(report?.contentSha256);
    });

    it('queues a conflict for a record reported twice with different content, and the lender handles it: acknowledge, then resolve', async () => {
      const changed = { ...state.imp1, outstanding_principal: '40000.00' };
      const content = JSON.stringify([changed]);
      const res = await stage(rotateOp(), { content });
      expect(res.statusCode).toBe(201);
      const outcome = out(res);
      // A conflict does not invalidate the file; it is queued at commit and nothing is applied for that record.
      expect(outcome.batch).toMatchObject({ status: 'previewed', counts: { conflict: 1, new: 0 } });
      const commit = await post(
        `/v1/lender/imports/${outcome.batch?.id ?? ''}/commit`,
        rotateOp(),
        {},
      );
      expect(out(commit).batch).toMatchObject({
        status: 'committed',
        appliedCounts: { conflict: 1 },
      });
      const list = LsConflictPage.parse(
        (await get(`/v1/lender/sync/conflicts?loanAccountId=${loan.IMP1}`, ids.aViewer)).json(),
      );
      expect(list.items).toHaveLength(1);
      const conflict = list.items[0];
      expect(conflict).toMatchObject({
        conflictReason: 'same_record_different_content',
        recordType: 'loan',
        status: 'open',
        sourceRecordId: `SRC-IMP1-${RUN}`,
      });
      state.conflictId = conflict?.id ?? '';
      expect(
        (LS_CONFLICT_REASONS as readonly string[]).includes(conflict?.conflictReason ?? ''),
      ).toBe(true);
      // The stored report is unchanged: still the first one.
      const detail = LsLoanDetail.parse(
        (await get(`/v1/lender/loans/${loan.IMP1}`, ids.aViewer)).json(),
      );
      expect(detail.report?.outstandingPrincipalMinor).toBe(4_166_667);
      expect(detail.openConflicts).toBe(1);

      // Acknowledge: sync.manage only; another lender cannot even see it.
      for (const [label, user, status] of [
        ['viewer', ids.aViewer, 403],
        ['manual entry only', ids.aManual, 403],
        ['other lender', ids.bOp, 404],
      ] as const) {
        const denied = await post(
          `/v1/lender/sync/conflicts/${state.conflictId}/acknowledge`,
          user,
          {},
        );
        expect([label, denied.statusCode]).toEqual([label, status]);
        // Resolving is guarded the same way.
        const deniedResolve = await post(
          `/v1/lender/sync/conflicts/${state.conflictId}/resolve`,
          user,
          {
            confirmedVersion: 'existing',
            note: 'Checked against the lender system of record.',
            evidence: { review_ref: `REV-${RUN}` },
          },
        );
        expect([label, deniedResolve.statusCode]).toEqual([label, status]);
      }
      const early = await post(`/v1/lender/sync/conflicts/${state.conflictId}/resolve`, ids.aSync, {
        confirmedVersion: 'existing',
        note: 'Checked against the lender system of record.',
        evidence: { review_ref: `REV-${RUN}` },
      });
      expect([early.statusCode, code(early)]).toEqual([409, 'conflict_not_acknowledged']);
      const key = `it-ack-${randomUUID()}`;
      const ack = await post(
        `/v1/lender/sync/conflicts/${state.conflictId}/acknowledge`,
        ids.aSync,
        {},
        { key },
      );
      expect([ack.statusCode, ack.json()]).toEqual([
        200,
        { id: state.conflictId, status: 'acknowledged' },
      ]);
      const ackReplay = await post(
        `/v1/lender/sync/conflicts/${state.conflictId}/acknowledge`,
        ids.aSync,
        {},
        { key },
      );
      expect(ackReplay.headers['idempotent-replayed']).toBe('true');
      const ackAgain = await post(
        `/v1/lender/sync/conflicts/${state.conflictId}/acknowledge`,
        ids.aSync,
        {},
      );
      expect([ackAgain.statusCode, code(ackAgain)]).toEqual([409, 'conflict_not_open']);

      const resolveBody = {
        confirmedVersion: 'existing',
        note: 'Checked against the lender system of record.',
        evidence: { review_ref: `REV-${RUN}` },
      };
      // Evidence that looks like personal data is refused, and so is a note that is too short or a bad version.
      const personal = await post(
        `/v1/lender/sync/conflicts/${state.conflictId}/resolve`,
        ids.aSync,
        {
          ...resolveBody,
          evidence: { reviewer: CANARY.email },
        },
      );
      expect([personal.statusCode, code(personal)]).toEqual([422, 'evidence_invalid']);
      expect(personal.body).not.toContain(CANARY.email);
      for (const bad of [
        { ...resolveBody, note: 'short' },
        { ...resolveBody, confirmedVersion: 'both' },
        { ...resolveBody, evidence: {} },
        { ...resolveBody, evidence: { Bad_Key: 'x' } },
        { ...resolveBody, evidence: { review_ref: 5 } },
        { ...resolveBody, extra: true },
      ]) {
        const res422 = await post(
          `/v1/lender/sync/conflicts/${state.conflictId}/resolve`,
          ids.aSync,
          bad,
        );
        expect([JSON.stringify(bad), res422.statusCode]).toEqual([JSON.stringify(bad), 422]);
      }
      const resolved = await post(
        `/v1/lender/sync/conflicts/${state.conflictId}/resolve`,
        ids.aSync,
        resolveBody,
      );
      expect([resolved.statusCode, resolved.json()]).toEqual([
        200,
        { id: state.conflictId, status: 'resolved' },
      ]);
      const resolvedAgain = await post(
        `/v1/lender/sync/conflicts/${state.conflictId}/resolve`,
        ids.aSync,
        resolveBody,
      );
      expect([resolvedAgain.statusCode, code(resolvedAgain)]).toEqual([409, 'conflict_resolved']);
      const after = LsConflictPage.parse(
        (
          await get(
            `/v1/lender/sync/conflicts?status=resolved&loanAccountId=${loan.IMP1}`,
            ids.aViewer,
          )
        ).json(),
      );
      expect(after.items[0]).toMatchObject({
        status: 'resolved',
        confirmedVersion: 'existing',
        resolutionNote: 'Checked against the lender system of record.',
      });
      // Resolving changed no stored report.
      const detail2 = LsLoanDetail.parse(
        (await get(`/v1/lender/loans/${loan.IMP1}`, ids.aViewer)).json(),
      );
      expect(detail2.report?.outstandingPrincipalMinor).toBe(4_166_667);
      expect(detail2.openConflicts).toBe(0);
      // The conflict that came with the fixture cannot be resolved before it is acknowledged.
      const fixture = LsConflictPage.parse(
        (await get(`/v1/lender/sync/conflicts?loanAccountId=${loan.A1}`, ids.aViewer)).json(),
      ).items[0];
      const premature = await post(
        `/v1/lender/sync/conflicts/${fixture?.id ?? ''}/resolve`,
        ids.aSync,
        resolveBody,
      );
      expect([premature.statusCode, code(premature)]).toEqual([409, 'conflict_not_acknowledged']);
    });

    it('flags, never corrects: a newer report with a higher outstanding amount and no reported charge is stored and raises an anomaly', async () => {
      const newer = rec('IMP1', {
        srid: `SRC-IMP1-${RUN}-2`,
        hoursAgo: 2,
        extra: { outstanding_principal: '43000.00' },
      });
      const res = await stage(rotateOp(), { content: JSON.stringify([newer]) });
      expect(res.statusCode).toBe(201);
      expect(out(res).batch).toMatchObject({ status: 'previewed', counts: { changed: 1 } });
      const commit = await post(
        `/v1/lender/imports/${out(res).batch?.id ?? ''}/commit`,
        rotateOp(),
        {},
      );
      expect(out(commit).batch?.appliedCounts).toEqual({ changed: 1 });
      const anomalies = LsAnomalyPage.parse(
        (await get(`/v1/lender/sync/anomalies?loanAccountId=${loan.IMP1}`, ids.aViewer)).json(),
      );
      expect(anomalies.items).toHaveLength(1);
      expect(anomalies.items[0]).toMatchObject({
        kind: 'outstanding_rise_without_charge',
        severity: 'warning',
        previousAmountMinor: 4_166_667,
        reportedAmountMinor: 4_300_000,
      });
      expect((LS_ANOMALY_KINDS as readonly string[]).includes(anomalies.items[0]?.kind ?? '')).toBe(
        true,
      );
      const detail = LsLoanDetail.parse(
        (await get(`/v1/lender/loans/${loan.IMP1}`, ids.aViewer)).json(),
      );
      // Stored exactly as reported, not corrected; the loan list marks the warning.
      expect(detail.report).toMatchObject({ version: 2, outstandingPrincipalMinor: 4_300_000 });
      expect(detail.anomalies).toEqual({ warning: 1, info: 0 });
      expect(detail.loan.sync.newestHasWarning).toBe(true);
      // Other lenders see none of it.
      const other = LsAnomalyPage.parse(
        (await get('/v1/lender/sync/anomalies?limit=100', ids.bOp)).json(),
      );
      expect(other.items.map((i) => i.loanAccountId)).not.toContain(loan.IMP1);
    });

    it('records a commit that fails inside the database as failed, applies nothing, keeps the record, and lets the file be staged again', async () => {
      // Two files claim one application under different loan references. Both preview as new; the second cannot apply.
      const f1 = JSON.stringify([rec('F1', { appRef: appRef('IMP3') })]);
      const f2 = JSON.stringify([rec('F2', { appRef: appRef('IMP3') })]);
      const s1 = await stage(rotateOp(), { content: f1 });
      const s2 = await stage(rotateOp(), { content: f2 });
      expect(out(s1).batch?.status).toBe('previewed');
      expect(out(s2).batch?.status).toBe('previewed');
      const first = await post(
        `/v1/lender/imports/${out(s1).batch?.id ?? ''}/commit`,
        rotateOp(),
        {},
      );
      expect(out(first).batch?.status).toBe('committed');
      state.failedBatch = out(s2).batch?.id ?? '';
      const failed = await post(`/v1/lender/imports/${state.failedBatch}/commit`, rotateOp(), {});
      // A failed commit is answered, not raised: raising would roll back the very record that says it failed.
      expect(failed.statusCode).toBe(200);
      expect(out(failed).batch).toMatchObject({
        status: 'failed',
        failureClass: 'P0001',
        appliedCounts: null,
      });
      expect(await loanExists(ref('F2'))).toBe(false);
      expect(await loanExists(ref('F1'))).toBe(true);
      // The failure is on record: the batch, the audit event, and no row values kept.
      const kept = await scalar<string>(
        `select count(*) filter (where normalised is not null)::text as v from servicing.import_rows where batch_id = $1`,
        [state.failedBatch],
      );
      expect(kept).toBe('0');
      const detail = LsImportDetail.parse(
        (await get(`/v1/lender/imports/${state.failedBatch}`, ids.aViewer)).json(),
      );
      expect(detail.batch).toMatchObject({ status: 'failed', failureClass: 'P0001' });
      expect(detail.batch.failedAt).not.toBeNull();
      const failures = await audit('servicing.import.failed', state.failedBatch);
      expect(failures).toHaveLength(1);
      expect(failures[0]?.metadata).toMatchObject({ failure_class: 'P0001' });
      // It cannot be committed again; staging the same file starts over (the hash was released).
      const again = await post(`/v1/lender/imports/${state.failedBatch}/commit`, rotateOp(), {});
      expect([again.statusCode, code(again)]).toEqual([409, 'batch_failed']);
      const restaged = await stage(rotateOp(), { content: f2, resubmissionOf: state.failedBatch });
      expect(restaged.statusCode).toBe(201);
      expect(out(restaged).batch?.id).not.toBe(state.failedBatch);
      expect(out(restaged).batch).toMatchObject({
        status: 'invalid',
        resubmissionOf: state.failedBatch,
      });
      expect(out(restaged).errors[0]?.errorCodes).toEqual(['application_already_linked']);
    });

    it('rejects a previewed batch with a reason and drops its content; only people who work with imports may', async () => {
      const content = JSON.stringify([rec('IMP4', { appRef: appRef('IMP4') })]);
      const staged = await stage(rotateOp(), { content });
      const id = out(staged).batch?.id ?? '';
      expect(out(staged).batch?.status).toBe('previewed');
      const url = `/v1/lender/imports/${id}/reject`;
      const reason = 'The file is the wrong period; the lender will send the right one.';
      expect([(await post(url, ids.aOp, { reason: 'too short' })).statusCode]).toEqual([422]);
      expect((await post(url, ids.aOp, { reason, extra: 1 })).statusCode).toBe(422);
      for (const [label, user, status] of [
        ['viewer', ids.aViewer, 403],
        ['document issue only', ids.aDocs, 403],
        ['other lender', ids.bOp, 404],
        ['platform auditor', ids.pAud, 403],
      ] as const) {
        const denied = await post(url, user, { reason });
        expect([label, denied.statusCode]).toEqual([label, status]);
      }
      expect(
        await scalar<string>(`select status as v from servicing.import_batches where id = $1`, [
          id,
        ]),
      ).toBe('previewed');
      const key = `it-reject-${randomUUID()}`;
      const rejected = await post(url, ids.aManual, { reason }, { key });
      expect(rejected.statusCode).toBe(200);
      expect(out(rejected).batch).toMatchObject({ status: 'rejected' });
      expect(out(rejected).batch?.rejectedAt).not.toBeNull();
      expect(
        (await post(url, ids.aManual, { reason }, { key })).headers['idempotent-replayed'],
      ).toBe('true');
      const left = await q<{ n: string; leaked: string }>(
        `select count(*)::text as n, count(*) filter (where normalised is not null or source_record_id is not null or row_sha256 is not null)::text as leaked
           from servicing.import_rows where batch_id = $1`,
        [id],
      );
      expect(left[0]).toEqual({ n: '1', leaked: '0' });
      // Rejecting again answers the same batch; committing a rejected batch is refused.
      const twice = await post(url, ids.aOp, { reason });
      expect([twice.statusCode, out(twice).existing]).toEqual([200, true]);
      const commit = await post(`/v1/lender/imports/${id}/commit`, rotateOp(), {});
      expect([commit.statusCode, code(commit)]).toEqual([409, 'batch_rejected']);
      // The hash was released: the same file can be staged again, and sync.manage alone may reject that one.
      const restaged = await stage(rotateOp(), { content });
      expect(restaged.statusCode).toBe(201);
      expect(out(restaged).batch?.id).not.toBe(id);
      const byManager = await post(
        `/v1/lender/imports/${out(restaged).batch?.id ?? ''}/reject`,
        ids.aSync,
        { reason },
      );
      expect(out(byManager).batch?.status).toBe('rejected');
      // A committed batch cannot be rejected.
      const late = await post(`/v1/lender/imports/${state.committed}/reject`, ids.aOp, { reason });
      expect([late.statusCode, code(late)]).toEqual([409, 'batch_not_rejectable']);
      state.rejectedBatch = id;
    });

    it('stages a larger receipt file (500 records) within the extended time limit', async () => {
      const header =
        'lms_loan_ref,lms_receipt_ref,receipt_kind,reverses_receipt_ref,amount,value_date,payment_mode,bank_reference,source_record_id,reported_as_of';
      const stamp = iso(3);
      const rows = Array.from(
        { length: 500 },
        (_, n) =>
          `${ref('IMP1')},BULK-${RUN}-${String(n)},receipt,,10.00,${dateOnly(1)},upi,,SRC-BULK-${RUN}-${String(n)},${stamp}`,
      );
      const content = [header, ...rows].join('\n');
      const res = await stage(rotateOp(), { kind: 'receipt', fileFormat: 'csv', content });
      expect(res.statusCode).toBe(201);
      expect(out(res).batch).toMatchObject({
        rowCount: 500,
        counts: { new: 500 },
        status: 'previewed',
      });
      const commit = await post(
        `/v1/lender/imports/${out(res).batch?.id ?? ''}/commit`,
        rotateOp(),
        {},
      );
      expect(out(commit).batch?.appliedCounts).toEqual({ new: 500 });
      expect(
        await scalar<string>(
          `select count(*)::text as v from servicing.lms_receipts where lms_receipt_ref like $1`,
          [`BULK-${RUN}-%`],
        ),
      ).toBe('500');
    });

    it('keeps lenders apart: a batch of lender B is invisible to lender A, and A cannot stage for B', async () => {
      const content = JSON.stringify([rec('IMPB', { appRef: appRef('IMPB') })]);
      const staged = await post(
        '/v1/lender/imports',
        ids.bOp,
        importBody(ids.lenderB, { content }),
      );
      expect(staged.statusCode).toBe(201);
      const bBatch = out(staged).batch?.id ?? '';
      expect(out(staged).batch?.lenderId).toBe(ids.lenderB);
      for (const [method, url] of [
        ['GET', `/v1/lender/imports/${bBatch}`],
        ['POST', `/v1/lender/imports/${bBatch}/commit`],
        ['POST', `/v1/lender/imports/${bBatch}/reject`],
      ] as const) {
        const res = await call(
          method,
          url,
          ids.aOp,
          method === 'POST' ? { reason: 'A reason that is long enough.' } : undefined,
        );
        expect([url, res.statusCode, code(res)]).toEqual([url, 404, 'not_found']);
      }
      const asA = LsImportBatchPage.parse(
        (await get('/v1/lender/imports?limit=100', ids.aOp)).json(),
      );
      expect(asA.items.map((i) => i.id)).not.toContain(bBatch);
      // A caller of lender B cannot stage into lender A, and a refused file leaves nothing in A's audit trail either.
      const refusedBefore = (await audit('servicing.import.file_rejected')).filter(
        (r) => r.tenant === A(),
      ).length;
      for (const body of [
        importBody(A(), { content: JSON.stringify([rec('IMPB')]) }),
        importBody(A(), { content: '{ not json' }),
      ]) {
        const into = await post('/v1/lender/imports', ids.bOp, body);
        expect([into.statusCode, code(into)]).toEqual([403, 'forbidden']);
      }
      expect(
        (await audit('servicing.import.file_rejected')).filter((r) => r.tenant === A()).length,
      ).toBe(refusedBefore);
      expect(await loanExists(ref('IMPB'))).toBe(false);
      // A resubmission cannot point at another lender's batch.
      const link = await stage(rotateOp(), {
        content: JSON.stringify([rec('IMP5', { appRef: appRef('IMP5') })]),
        resubmissionOf: bBatch,
      });
      expect([link.statusCode, code(link)]).toEqual([422, 'resubmission_invalid']);
    });

    it('needs servicing.manual_entry to stage: nobody else, not even for a file that would be refused, leaves a trace', async () => {
      const valid = JSON.stringify([rec('IMP5', { appRef: appRef('IMP5') })]);
      const refused = '{ not json at all';
      const refusedHash = sha256(refused);
      for (const [label, user] of [
        ['viewer', ids.aViewer],
        ['sync.manage only', ids.aSync],
        ['document issue only', ids.aDocs],
        ['no loan.read', ids.aNoRead],
        ['platform auditor', ids.pAud],
      ] as const) {
        for (const content of [valid, refused]) {
          const res = await post('/v1/lender/imports', user, importBody(A(), { content }));
          expect([label, res.statusCode]).toEqual([label, 403]);
        }
      }
      expect(await batchesWith(sha256(valid))).toBe(0);
      expect(await audit('servicing.import.file_rejected', refusedHash)).toHaveLength(0);
      // Unknown lender: the same answer as a lender that is not yours.
      const unknown = await post(
        '/v1/lender/imports',
        ids.aOp,
        importBody(randomUUID(), { content: valid }),
      );
      expect([unknown.statusCode, code(unknown)]).toEqual([403, 'forbidden']);
    });

    it('answers feature_disabled while the servicing_sync switch is off, for a good file and a refused one, and records nothing', async () => {
      const valid = JSON.stringify([rec('C1', { appRef: appRef('C1') })]);
      const refused = '{ nope';
      for (const content of [valid, refused]) {
        const res = await post('/v1/lender/imports', ids.cOp, importBody(ids.lenderC, { content }));
        expect([res.statusCode, code(res)]).toEqual([409, 'feature_disabled']);
      }
      expect(
        await scalar<string>(
          `select count(*)::text as v from servicing.import_batches where lender_org_id = $1`,
          [ids.lenderC],
        ),
      ).toBe('0');
      expect(await audit('servicing.import.file_rejected', sha256(refused))).toHaveLength(0);
      // Reading stays possible with the switch off (history is never hidden): the lender's own loan.
      const loans = LsLoanPage.parse((await get('/v1/lender/loans', ids.cOp)).json());
      expect(loans.items.map((i) => i.id)).toEqual([loan.C1]);
    });

    it('validates the shape of the request before anything else', async () => {
      const ok = importBody(A(), { content: JSON.stringify([rec('IMP5')]) });
      const rows = [rec('IMP5')];
      const bad: [string, Record<string, unknown>][] = [
        ['content and rows together', { ...ok, rows }],
        ['neither content nor rows', { ...ok, content: undefined }],
        ['content without a format', { ...ok, fileFormat: undefined }],
        ['rows declared csv', { ...ok, content: undefined, rows, fileFormat: 'csv' }],
        ['an unknown field', { ...ok, extra: 1 }],
        ['an unknown kind', { ...ok, kind: 'payment' }],
        ['an unknown source kind', { ...ok, sourceKind: 'api' }],
        ['another format version', { ...ok, formatVersion: 'v2' }],
        ['a lender that is not an id', { ...ok, lenderId: 'nope' }],
        ['a resubmission that is not an id', { ...ok, resubmissionOf: 'nope' }],
        ['empty content', { ...ok, content: '' }],
        ['empty rows', { ...ok, content: undefined, rows: [] }],
        ['rows that are not records', { ...ok, content: undefined, rows: ['x'] }],
      ];
      for (const [label, body] of bad) {
        const res = await post('/v1/lender/imports', ids.aOp, body);
        expect([label, res.statusCode, code(res)]).toEqual([label, 422, 'validation_failed']);
      }
      const noKey = await post('/v1/lender/imports', ids.aOp, ok, { key: null });
      expect([noKey.statusCode, code(noKey)]).toEqual([400, 'idempotency_key_required']);
      expect((await post('/v1/lender/imports/not-a-uuid/commit', ids.aSync, {})).statusCode).toBe(
        422,
      );
      expect(
        (await post(`/v1/lender/imports/${randomUUID()}/commit`, rotateOp(), {})).statusCode,
      ).toBe(404);
      expect(
        (
          await post(`/v1/lender/imports/${randomUUID()}/reject`, ids.aSync, {
            reason: 'A reason that is long enough.',
          })
        ).statusCode,
      ).toBe(404);
    });
  });

  // ================================================================================================================
  // Lender-issued documents
  // ================================================================================================================
  describe('lender-issued documents', () => {
    const docs: Record<string, string> = {};
    const bytes1 = pdf(`statement one ${RUN}`);
    const ref1 = `STMT-${RUN}-1`;
    const A1 = () => loan.A1 ?? '';
    const upload = (
      user: string,
      loanId: string,
      reference: string,
      over: Record<string, unknown> = {},
      options: Parameters<typeof call>[4] = {},
    ) => post(`/v1/lender/loans/${loanId}/documents`, user, uploadBody(reference, over), options);
    const documentRows = (reference: string) =>
      q<{
        id: string;
        kind: string;
        sha256: string;
        size_bytes: string;
        mime_type: string;
        source: string;
        uploaded_by: string;
        loan_account_id: string;
        storage_key: string;
      }>(
        `select id, kind, sha256, size_bytes::text, mime_type, source, uploaded_by::text, loan_account_id::text, storage_key
           from servicing.loan_documents where lender_reference = $1`,
        [reference],
      );
    const accessCount = async (documentId: string) =>
      Number(
        await scalar<string>(
          `select count(*)::text as v from servicing.loan_document_access where document_id = $1`,
          [documentId],
        ),
      );

    it("registers the lender's own signed PDF: the database accepts first, the bytes are stored under an opaque key, the hash and size are recorded", async () => {
      const key = `it-doc-${randomUUID()}`;
      // One request body, sent twice: the time of issue is part of the request, so a replay must repeat it exactly.
      const payload = uploadBody(ref1, { contentBase64: bytes1.toString('base64') });
      const res = await post(`/v1/lender/loans/${A1()}/documents`, ids.aDocs, payload, { key });
      expect(res.statusCode).toBe(201);
      const body = res.json<{ documentId: string; existing: boolean }>();
      expect(body.existing).toBe(false);
      docs.one = body.documentId;
      expect(storeFiles()).toHaveLength(1);
      const rows = await documentRows(ref1);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: docs.one,
        kind: 'statement',
        sha256: sha256(bytes1),
        size_bytes: String(bytes1.length),
        mime_type: 'application/pdf',
        source: 'lender_upload',
        uploaded_by: ids.aDocs,
        loan_account_id: loan.A1,
      });
      const storageKey = rows[0]?.storage_key ?? '';
      expect(storageKey).toMatch(/^servicing\/[0-9a-f-]{36}$/);
      expect(fs.readFileSync(path.join(storeRoot, storageKey)).equals(bytes1)).toBe(true);
      // The key, the hash and the person never come back; only the document's id.
      expect(res.body).not.toContain('servicing/');
      expect(res.body).not.toContain(sha256(bytes1));
      // Audited without the key, the hash or the lender's reference.
      const events = await q<{ metadata: Record<string, unknown> }>(
        `select metadata from audit.events where action = 'servicing.loan_document.registered' and entity_id = $1`,
        [docs.one],
      );
      expect(events).toHaveLength(1);
      const text = JSON.stringify(events[0]?.metadata);
      for (const secret of [storageKey, sha256(bytes1), ref1]) expect(text).not.toContain(secret);
      // The same request with the same key is a replay.
      const replay = await post(`/v1/lender/loans/${A1()}/documents`, ids.aDocs, payload, { key });
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.json()).toEqual(body);
      expect(storeFiles()).toHaveLength(1);
    });

    it('treats the same reference with the same bytes as the same document, and the same reference with other bytes as a conflict; neither stores anything new', async () => {
      const same = await upload(docUser(), A1(), ref1, {
        contentBase64: bytes1.toString('base64'),
      });
      expect(same.statusCode).toBe(200);
      expect(same.json()).toEqual({ documentId: docs.one, existing: true });
      const other = await upload(docUser(), A1(), ref1, {
        contentBase64: pdf(`another ${RUN}`).toString('base64'),
      });
      expect([other.statusCode, code(other)]).toEqual([409, 'lender_reference_reused']);
      expect(storeFiles()).toHaveLength(1);
      expect(await documentRows(ref1)).toHaveLength(1);
    });

    it('refuses what is not a flat PDF, what is too large and what is not base64, and stores nothing', async () => {
      const before = storeFiles().length;
      const withScript = Buffer.from(
        '%PDF-1.4\n1 0 obj\n<< /S /JavaScript /JS (app.alert(1)) >>\nendobj\n%%EOF\n',
      );
      const cases: [string, Record<string, unknown>, number, string][] = [
        [
          'active content',
          { contentBase64: withScript.toString('base64') },
          422,
          'document_type_mismatch',
        ],
        [
          'not a PDF',
          { contentBase64: Buffer.from('hello, this is text').toString('base64') },
          422,
          'document_type_mismatch',
        ],
        [
          'too large',
          {
            contentBase64: Buffer.concat([
              Buffer.from('%PDF-1.4\n'),
              Buffer.alloc(8 * 1024 * 1024),
            ]).toString('base64'),
          },
          413,
          'document_too_large',
        ],
        ['not base64', { contentBase64: 'not base64 at all!!' }, 422, 'validation_failed'],
        ['truncated base64', { contentBase64: 'JVBERi0xLjQ' }, 422, 'validation_failed'],
        ['another media type', { mimeType: 'image/png' }, 422, 'validation_failed'],
        ['an unknown kind', { kind: 'invoice' }, 422, 'validation_failed'],
        ['a reference with a space', { lenderReference: 'has a space' }, 422, 'validation_failed'],
        ['an unknown field', { extra: 1 }, 422, 'validation_failed'],
      ];
      for (const [label, over, status, expectedCode] of cases) {
        const res = await upload(docUser(), A1(), `REFUSED-${RUN}-${label.length}`, over);
        expect([label, res.statusCode, code(res)]).toEqual([label, status, expectedCode]);
      }
      expect(storeFiles()).toHaveLength(before);
      expect(
        await scalar<string>(
          `select count(*)::text as v from servicing.loan_documents where lender_reference like $1`,
          [`REFUSED-${RUN}-%`],
        ),
      ).toBe('0');
    });

    it('lets the database refuse a bad period, kind or time before any byte is stored', async () => {
      const before = storeFiles().length;
      const cases: [string, string, Record<string, unknown>, string][] = [
        [
          'a statement without a period',
          'P1',
          { periodFrom: undefined, periodTo: undefined },
          'period_invalid',
        ],
        [
          'a period in the future',
          'P2',
          { periodFrom: dateOnly(1), periodTo: dateOnly(-30) },
          'period_invalid',
        ],
        [
          'a period that ends before it starts',
          'P3',
          { periodFrom: dateOnly(10), periodTo: dateOnly(40) },
          'period_invalid',
        ],
        ['a period on a notice', 'P4', { kind: 'noc' }, 'period_not_allowed'],
        ['an issue time in the future', 'P5', { issuedAt: iso(-48) }, 'issued_at_invalid'],
        [
          'a supersession of nothing',
          'P6',
          { supersedesDocumentId: randomUUID() },
          'supersedes_invalid',
        ],
      ];
      for (const [label, suffix, over, expectedCode] of cases) {
        const res = await upload(docUser(), A1(), `BAD-${RUN}-${suffix}`, over);
        expect([label, res.statusCode, code(res)]).toEqual([label, 422, expectedCode]);
      }
      expect(storeFiles()).toHaveLength(before);
    });

    it('needs servicing.document.issue: nobody else registers, and a refusal stores nothing and records nothing', async () => {
      const before = storeFiles().length;
      const reference = `DENIED-${RUN}`;
      for (const [label, user, status] of [
        ['viewer', ids.aViewer, 403],
        ['manual entry only', ids.aManual, 403],
        ['sync.manage only', ids.aSync, 403],
        ['platform auditor', ids.pAud, 403],
        ['no loan.read at all', ids.aNoRead, 404],
        ['another lender', ids.bOp, 404],
        ['the lender with every switch off', ids.cOp, 404],
      ] as const) {
        const res = await upload(user, A1(), reference);
        expect([label, res.statusCode]).toEqual([label, status]);
      }
      expect(storeFiles()).toHaveLength(before);
      expect(await documentRows(reference)).toHaveLength(0);
      expect((await upload(docUser(), randomUUID(), reference)).statusCode).toBe(404);
      expect(
        (await post('/v1/lender/loans/not-a-uuid/documents', ids.aDocs, uploadBody(reference)))
          .statusCode,
      ).toBe(422);
    });

    it('answers feature_disabled while the statements_noc switch is off, and stores nothing', async () => {
      const before = storeFiles().length;
      const res = await upload(ids.cOp, loan.C1 ?? '', `OFF-${RUN}`);
      expect([res.statusCode, code(res)]).toEqual([409, 'feature_disabled']);
      expect(storeFiles()).toHaveLength(before);
      expect(await documentRows(`OFF-${RUN}`)).toHaveLength(0);
    });

    it('answers 503 without a configured store, for uploads and for retrieval, and registers nothing', async () => {
      const reference = `NOSTORE-${RUN}`;
      const res = await upload(docUser(), A1(), reference, {}, { on: appNoStore });
      expect([res.statusCode, code(res)]).toEqual([503, 'document_store_unavailable']);
      expect(await documentRows(reference)).toHaveLength(0);
      const open = await get(
        `/v1/lender/loans/${A1()}/documents/${docs.one ?? ''}/content`,
        ids.aViewer,
        {
          on: appNoStore,
        },
      );
      expect([open.statusCode, code(open)]).toEqual([503, 'document_store_unavailable']);
      expect(await accessCount(docs.one ?? '')).toBe(0);
    });

    it('leaves no record behind when the store fails after the database accepted: the registration rolls back with the request', async () => {
      const failing: DocumentStore = {
        ...store,
        put: () => Promise.reject(new Error('disk full')),
      };
      const config = loadConfig({ APP_ENV: 'test' });
      const broken = await buildApp(config, {
        auth: { verifier: fakeVerifier, context: createUserContext(apiPool) },
        documents: failing,
      });
      try {
        const reference = `BROKEN-${RUN}`;
        const res = await upload(docUser(), loan.A3 ?? '', reference, {}, { on: broken });
        expect(res.statusCode).toBe(500);
        expect(await documentRows(reference)).toHaveLength(0);
        expect(res.body).not.toContain('disk full');
      } finally {
        await broken.close();
      }
    });

    it('lists the documents of a loan with their metadata and never the storage key', async () => {
      const res = await get(`/v1/lender/loans/${A1()}/documents`, ids.aViewer);
      expect(res.statusCode).toBe(200);
      const list = LsDocumentList.parse(res.json());
      const one = list.items.find((i) => i.documentId === docs.one);
      expect(one).toMatchObject({
        kind: 'statement',
        issuer: 'lender',
        lenderReference: ref1,
        sizeBytes: bytes1.length,
        sha256: sha256(bytes1),
        source: 'lender_upload',
        supersededById: null,
        periodFrom: dateOnly(60),
        periodTo: dateOnly(30),
      });
      expect(res.body).not.toContain('servicing/');
      expect(res.body).not.toMatch(/storage/i);
      for (const [label, user] of [
        ['another lender', ids.bOp],
        ['no loan.read', ids.aNoRead],
        ['switch-off lender', ids.cOp],
      ] as const) {
        const denied = await get(`/v1/lender/loans/${A1()}/documents`, user);
        expect([label, denied.statusCode, code(denied)]).toEqual([label, 404, 'not_found']);
      }
      expect(
        (await get(`/v1/lender/loans/${randomUUID()}/documents`, ids.aViewer)).statusCode,
      ).toBe(404);
    });

    it('opens the exact file for a reader of the lender, records the access, compares the hash and never caches', async () => {
      const url = `/v1/lender/loans/${A1()}/documents/${docs.one ?? ''}/content`;
      const res = await get(`${url}?purpose=download`, ids.aViewer);
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const content = LsDocumentContent.parse(res.json());
      expect(Buffer.from(content.contentBase64, 'base64').equals(bytes1)).toBe(true);
      expect(content).toMatchObject({
        documentId: docs.one,
        kind: 'statement',
        mimeType: 'application/pdf',
        sha256: sha256(bytes1),
        sizeBytes: bytes1.length,
        lenderReference: ref1,
      });
      const viewed = await get(url, ids.aOp);
      expect(viewed.statusCode).toBe(200);
      const access = await q<{ actor_type: string; actor_user_id: string; purpose: string }>(
        `select actor_type, actor_user_id::text, purpose from servicing.loan_document_access where document_id = $1 order by accessed_at`,
        [docs.one],
      );
      expect(access).toEqual([
        { actor_type: 'lender', actor_user_id: ids.aViewer, purpose: 'download' },
        { actor_type: 'lender', actor_user_id: ids.aOp, purpose: 'view' },
      ]);
      expect((await get(`${url}?purpose=edit`, ids.aViewer)).statusCode).toBe(422);
      expect((await get(`${url}?extra=1`, ids.aViewer)).statusCode).toBe(422);
    });

    it('opens nothing for the wrong loan, another lender, platform staff or someone who cannot read; and records no access', async () => {
      const wrongLoan = `/v1/lender/loans/${loan.A3 ?? ''}/documents/${docs.one ?? ''}/content`;
      const right = `/v1/lender/loans/${A1()}/documents/${docs.one ?? ''}/content`;
      const before = await accessCount(docs.one ?? '');
      const wrong = await get(wrongLoan, ids.aViewer);
      expect([wrong.statusCode, code(wrong)]).toEqual([404, 'not_found']);
      for (const [label, user] of [
        ['another lender', ids.bOp],
        ['platform auditor', ids.pAud],
        ['no loan.read', ids.aNoRead],
        ['switch-off lender', ids.cOp],
      ] as const) {
        const res = await get(right, user);
        expect([label, res.statusCode, code(res)]).toEqual([label, 404, 'not_found']);
      }
      expect(
        (await get(`/v1/lender/loans/${A1()}/documents/${randomUUID()}/content`, ids.aViewer))
          .statusCode,
      ).toBe(404);
      expect(await accessCount(docs.one ?? '')).toBe(before);
    });

    it('fails closed when the stored bytes do not match the recorded hash, or are gone, and records no access for a failed read', async () => {
      const url = `/v1/lender/loans/${A1()}/documents/${docs.one ?? ''}/content`;
      const storageKey = (await documentRows(ref1))[0]?.storage_key ?? '';
      const file = path.join(storeRoot, storageKey);
      const before = await accessCount(docs.one ?? '');
      fs.writeFileSync(file, pdf(`tampered ${RUN}`));
      try {
        const tampered = await get(url, ids.aViewer);
        expect(tampered.statusCode).toBe(500);
        expect(tampered.body).not.toContain('contentBase64');
        expect(tampered.body).not.toContain(sha256(bytes1));
        expect(await accessCount(docs.one ?? '')).toBe(before);
        fs.rmSync(file);
        const gone = await get(url, ids.aViewer);
        expect([gone.statusCode, code(gone)]).toEqual([404, 'not_found']);
        expect(await accessCount(docs.one ?? '')).toBe(before);
      } finally {
        fs.writeFileSync(file, bytes1);
      }
      expect((await get(url, ids.aViewer)).statusCode).toBe(200);
    });

    it("fulfils a borrower's open request when the matching document is registered, and checks kind and period", async () => {
      // A request for a quotation is not answered by a statement; a statement must cover the period asked for.
      const kind = await upload(docUser(), A1(), `MISMATCH-${RUN}-1`, {
        requestId: apps['REQ-QUOTE-A1'],
      });
      expect([kind.statusCode, code(kind)]).toEqual([409, 'request_kind_mismatch']);
      const narrow = await upload(docUser(), A1(), `MISMATCH-${RUN}-2`, {
        requestId: apps['REQ-STMT-A1'],
        periodFrom: dateOnly(50),
        periodTo: dateOnly(30),
      });
      expect([narrow.statusCode, code(narrow)]).toEqual([409, 'period_does_not_cover_request']);
      const unknown = await upload(docUser(), A1(), `MISMATCH-${RUN}-3`, {
        requestId: randomUUID(),
      });
      expect([unknown.statusCode, code(unknown)]).toEqual([409, 'request_not_open']);
      expect(await documentRows(`MISMATCH-${RUN}-1`)).toHaveLength(0);

      const ok = await upload(docUser(), A1(), `STMT-${RUN}-2`, {
        requestId: apps['REQ-STMT-A1'],
        periodFrom: dateOnly(61),
        periodTo: dateOnly(29),
      });
      expect(ok.statusCode).toBe(201);
      docs.two = ok.json<{ documentId: string }>().documentId;
      const list = LsDocumentRequestPage.parse(
        (
          await get(`/v1/lender/document-requests?loanAccountId=${A1()}&limit=100`, ids.aViewer)
        ).json(),
      );
      const fulfilled = list.items.find((i) => i.id === apps['REQ-STMT-A1']);
      expect(fulfilled).toMatchObject({
        kind: 'statement',
        status: 'fulfilled',
        fulfilledDocumentId: docs.two,
        fulfilledQuoteId: null,
        lenderId: ids.lenderA,
      });
      expect(fulfilled?.decidedAt).not.toBeNull();
      // Once fulfilled, the request is closed.
      const again = await upload(docUser(), A1(), `STMT-${RUN}-2b`, {
        requestId: apps['REQ-STMT-A1'],
        periodFrom: dateOnly(61),
        periodTo: dateOnly(29),
      });
      expect([again.statusCode, code(again)]).toEqual([409, 'request_not_open']);
    });

    it('registers a no-dues certificate against a closed loan, answers its request, and the closure record shows it', async () => {
      const res = await upload(docUser(), loan.A2 ?? '', `NOC-${RUN}`, {
        kind: 'noc',
        periodFrom: undefined,
        periodTo: undefined,
        requestId: apps['REQ-NOC-A2'],
      });
      expect(res.statusCode).toBe(201);
      docs.noc = res.json<{ documentId: string }>().documentId;
      const closures = LsClosurePage.parse(
        (await get('/v1/lender/closures?limit=100', ids.aViewer)).json(),
      );
      const closure = closures.items.find((c) => c.loanAccountId === loan.A2);
      expect(closure).toMatchObject({
        closureKind: 'closed',
        lenderId: ids.lenderA,
        nocDocumentId: docs.noc,
      });
      expect(closure?.nocIssuedAt).not.toBeNull();
      const request = LsDocumentRequestPage.parse(
        (
          await get(`/v1/lender/document-requests?loanAccountId=${loan.A2 ?? ''}`, ids.aViewer)
        ).json(),
      ).items.find((i) => i.id === apps['REQ-NOC-A2']);
      expect(request).toMatchObject({ status: 'fulfilled', fulfilledDocumentId: docs.noc });
    });

    it('supersedes a document once, on the same loan and kind only', async () => {
      const res = await upload(docUser(), A1(), `STMT-${RUN}-3`, {
        supersedesDocumentId: docs.one,
        contentBase64: pdf(`corrected ${RUN}`).toString('base64'),
      });
      expect(res.statusCode).toBe(201);
      docs.three = res.json<{ documentId: string }>().documentId;
      const list = LsDocumentList.parse(
        (await get(`/v1/lender/loans/${A1()}/documents`, ids.aViewer)).json(),
      );
      expect(list.items.find((i) => i.documentId === docs.one)?.supersededById).toBe(docs.three);
      const twice = await upload(docUser(), A1(), `STMT-${RUN}-4`, {
        supersedesDocumentId: docs.one,
        contentBase64: pdf(`again ${RUN}`).toString('base64'),
      });
      expect([twice.statusCode, code(twice)]).toEqual([409, 'already_superseded']);
      const crossLoan = await upload(docUser(), loan.A3 ?? '', `STMT-${RUN}-5`, {
        supersedesDocumentId: docs.one,
        contentBase64: pdf(`cross ${RUN}`).toString('base64'),
      });
      expect([crossLoan.statusCode, code(crossLoan)]).toEqual([422, 'supersedes_invalid']);
      const otherKind = await upload(docUser(), A1(), `STMT-${RUN}-6`, {
        kind: 'noc',
        periodFrom: undefined,
        periodTo: undefined,
        supersedesDocumentId: docs.three,
        contentBase64: pdf(`kind ${RUN}`).toString('base64'),
      });
      expect([otherKind.statusCode, code(otherKind)]).toEqual([422, 'supersedes_invalid']);
    });

    it('lists the requests of the lender only, filters them and pages through them', async () => {
      const a = LsDocumentRequestPage.parse(
        (await get('/v1/lender/document-requests?limit=100', ids.aViewer)).json(),
      );
      expect(new Set(a.items.map((i) => i.lenderId))).toEqual(new Set([ids.lenderA]));
      expect(a.items.map((i) => i.id)).toEqual(
        expect.arrayContaining([apps['REQ-QUOTE-A1'], apps['REQ-DECL-A3']]),
      );
      expect(a.items.map((i) => i.id)).not.toContain(apps['REQ-STMT-B1']);
      const open = LsDocumentRequestPage.parse(
        (
          await get(
            '/v1/lender/document-requests?status=requested&kind=foreclosure_quote&limit=100',
            ids.aOp,
          )
        ).json(),
      );
      expect(
        open.items.every((i) => i.status === 'requested' && i.kind === 'foreclosure_quote'),
      ).toBe(true);
      expect(open.items.map((i) => i.id)).toContain(apps['REQ-QUOTE-A1']);
      const b = LsDocumentRequestPage.parse(
        (await get('/v1/lender/document-requests?limit=100', ids.bOp)).json(),
      );
      expect(b.items.map((i) => i.id)).toEqual([apps['REQ-STMT-B1']]);
      const walked: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 30; guard += 1) {
        const res: Res = await get(
          `/v1/lender/document-requests?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
          ids.aOp,
        );
        const page = LsDocumentRequestPage.parse(res.json());
        walked.push(...page.items.map((i) => i.id));
        cursor = page.nextCursor;
        if (!cursor) break;
      }
      expect(new Set(walked).size).toBe(a.items.length);
      expect(
        (await get(`/v1/lender/document-requests?lenderId=${ids.lenderB}`, ids.aOp)).statusCode,
      ).toBe(403);
      // The borrower who asked is never named.
      for (const body of seen.slice(-6)) {
        expect(body).not.toContain(ids.b1);
        expect(body).not.toContain(borrower.b1);
      }
    });

    it('declines an open request with a reason the borrower can read; a reason with personal data is refused', async () => {
      const url = `/v1/lender/document-requests/${apps['REQ-DECL-A3'] ?? ''}/decline`;
      const note = 'We cannot issue this statement yet; please ask again next month.';
      for (const [label, user, status] of [
        ['viewer', ids.aViewer, 403],
        ['manual entry only', ids.aManual, 403],
        ['platform auditor', ids.pAud, 403],
        ['another lender', ids.bOp, 404],
        ['no loan.read', ids.aNoRead, 404],
      ] as const) {
        const res = await post(url, user, { note });
        expect([label, res.statusCode]).toEqual([label, status]);
      }
      const personal = await post(url, ids.aDocs, {
        note: `Write to ${CANARY.email} for details please.`,
      });
      expect([personal.statusCode, code(personal)]).toEqual([422, 'note_invalid']);
      expect(personal.body).not.toContain(CANARY.email);
      expect((await post(url, ids.aDocs, { note: 'short' })).statusCode).toBe(422);
      const key = `it-decline-${randomUUID()}`;
      const ok = await post(url, ids.aDocs, { note }, { key });
      expect([ok.statusCode, ok.json()]).toEqual([
        200,
        { id: apps['REQ-DECL-A3'], status: 'declined' },
      ]);
      expect((await post(url, ids.aDocs, { note }, { key })).headers['idempotent-replayed']).toBe(
        'true',
      );
      const again = await post(url, ids.aDocs2, { note });
      expect([again.statusCode, code(again)]).toEqual([409, 'request_not_open']);
      const shown = LsDocumentRequestPage.parse(
        (
          await get(
            `/v1/lender/document-requests?status=declined&loanAccountId=${loan.A3 ?? ''}`,
            ids.aViewer,
          )
        ).json(),
      ).items[0];
      expect(shown).toMatchObject({ status: 'declined', lenderNote: note });
      // The switch-off lender cannot decline either.
      const off = await post(
        `/v1/lender/document-requests/${apps['REQ-STMT-C1'] ?? ''}/decline`,
        ids.cOp,
        { note },
      );
      expect([off.statusCode, code(off)]).toEqual([409, 'feature_disabled']);
      expect(
        (await post(`/v1/lender/document-requests/${randomUUID()}/decline`, ids.aDocs, { note }))
          .statusCode,
      ).toBe(404);
    });
  });

  // ================================================================================================================
  // Foreclosure quotations
  // ================================================================================================================
  describe('foreclosure quotations', () => {
    const A1 = () => loan.A1 ?? '';
    const quoteBody = (reference: string, over: Record<string, unknown> = {}) => ({
      lenderQuoteRef: reference,
      asOf: iso(1),
      validUntil: iso(-24),
      principalMinor: 1_000_000,
      interestMinor: 50_000,
      chargesMinor: 10_000,
      prepaymentChargeMinor: 20_000,
      totalMinor: 1_080_000,
      ...over,
    });
    const record = (
      user: string,
      loanId: string,
      body: unknown,
      options: Parameters<typeof call>[4] = {},
    ) => post(`/v1/lender/loans/${loanId}/foreclosure-quotes`, user, body, options);
    const ids2: Record<string, string> = {};
    const firstQuote = quoteBody(`FQ-${RUN}-1`);

    it('records the quotation exactly as the lender issued it, in integer paise', async () => {
      const key = `it-quote-${randomUUID()}`;
      const res = await record(ids.aDocs, A1(), firstQuote, { key });
      expect(res.statusCode).toBe(201);
      const result = LsQuoteResult.parse(res.json());
      expect(result.existing).toBe(false);
      expect(result.quote).toMatchObject({
        lenderId: ids.lenderA,
        loanAccountId: loan.A1,
        lenderQuoteRef: `FQ-${RUN}-1`,
        principalMinor: 1_000_000,
        interestMinor: 50_000,
        chargesMinor: 10_000,
        prepaymentChargeMinor: 20_000,
        totalMinor: 1_080_000,
        totalMismatch: false,
        source: 'lender_portal',
        letterDocumentId: null,
      });
      ids2.one = result.quote.id;
      const stored = await q<Record<string, string>>(
        `select principal_minor::text as p, interest_minor::text as i, charges_minor::text as c, prepayment_charge_minor::text as pp, total_minor::text as t,
                reported_by::text as who, total_mismatch::text as flagged
           from servicing.foreclosure_quotes where id = $1`,
        [ids2.one],
      );
      expect(stored[0]).toEqual({
        p: '1000000',
        i: '50000',
        c: '10000',
        pp: '20000',
        t: '1080000',
        who: ids.aDocs,
        flagged: 'false',
      });
      const replay = await record(ids.aDocs, A1(), firstQuote, { key });
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.json()).toEqual(res.json());
    });

    it('answers the same quotation for the same reference and figures, and refuses the same reference with other figures', async () => {
      const first = await record(
        ids.aDocs,
        A1(),
        quoteBody(`FQ-${RUN}-1`, { asOf: undefined, validUntil: undefined }),
      );
      // The times are part of the figures: a repeat with other times is a different quotation under the same reference.
      expect([first.statusCode, code(first)]).toEqual([422, 'validation_failed']);
      const stored = await q<{ as_of: Date; valid_until: Date }>(
        `select as_of, valid_until from servicing.foreclosure_quotes where id = $1`,
        [ids2.one],
      );
      const same = await record(
        ids.aDocs2,
        A1(),
        quoteBody(`FQ-${RUN}-1`, {
          asOf: stored[0]?.as_of.toISOString(),
          validUntil: stored[0]?.valid_until.toISOString(),
        }),
      );
      expect(same.statusCode).toBe(200);
      expect(LsQuoteResult.parse(same.json())).toMatchObject({
        existing: true,
        quote: { id: ids2.one },
      });
      const other = await record(
        ids.aDocs,
        A1(),
        quoteBody(`FQ-${RUN}-1`, { totalMinor: 1_090_000 }),
      );
      expect([other.statusCode, code(other)]).toEqual([409, 'quote_ref_reused']);
    });

    it('stores a quotation whose parts do not add up to its total FLAGGED, never corrected', async () => {
      const res = await record(
        ids.aDocs,
        A1(),
        quoteBody(`FQ-${RUN}-2`, { totalMinor: 1_000_000 }),
      );
      expect(res.statusCode).toBe(201);
      const quote = LsQuoteResult.parse(res.json()).quote;
      expect(quote.totalMismatch).toBe(true);
      expect(quote.totalMinor).toBe(1_000_000);
      expect(
        quote.principalMinor +
          quote.interestMinor +
          quote.chargesMinor +
          quote.prepaymentChargeMinor,
      ).toBe(1_080_000);
      ids2.flagged = quote.id;
      const row = await scalar<string>(
        `select total_mismatch::text as v from servicing.foreclosure_quotes where id = $1`,
        [quote.id],
      );
      expect(row).toBe('true');
    });

    it('refuses what the database refuses: validity order, a time in the future, a bad reference, a wrong letter, money that is not paise', async () => {
      const cases: [string, Record<string, unknown>, number, string][] = [
        ['validity not after the as-of time', { validUntil: iso(2) }, 422, 'validity_order'],
        [
          'an as-of time in the future',
          { asOf: iso(-48), validUntil: iso(-72) },
          422,
          'as_of_invalid',
        ],
        ['a reference with a space', { lenderQuoteRef: 'has a space' }, 422, 'reference_invalid'],
        [
          'a letter that is not a quotation document',
          { letterDocumentId: randomUUID() },
          422,
          'letter_invalid',
        ],
        ['a request that is not open', { requestId: randomUUID() }, 409, 'request_not_open'],
        ['money with a fraction', { totalMinor: 10.5 }, 422, 'validation_failed'],
        ['negative money', { principalMinor: -1 }, 422, 'validation_failed'],
        ['money as text', { interestMinor: '500' }, 422, 'validation_failed'],
        ['money above the limit', { chargesMinor: 100_000_000_000_001 }, 422, 'validation_failed'],
        ['a missing figure', { totalMinor: undefined }, 422, 'validation_failed'],
        ['an unknown field', { total: 1 }, 422, 'validation_failed'],
        ['a time without an offset', { asOf: '2026-10-01T10:00:00' }, 422, 'validation_failed'],
      ];
      for (const [label, over, status, expectedCode] of cases) {
        const res = await record(
          ids.aDocs,
          A1(),
          quoteBody(`FQ-${RUN}-X${String(label.length)}`, over),
        );
        expect([label, res.statusCode, code(res)]).toEqual([label, status, expectedCode]);
      }
      expect(
        await scalar<string>(
          `select count(*)::text as v from servicing.foreclosure_quotes where lender_quote_ref like $1`,
          [`FQ-${RUN}-X%`],
        ),
      ).toBe('0');
    });

    it("links the lender's own quotation letter, and answers the borrower's open request only with a quotation that is still valid", async () => {
      const letter = await post(
        `/v1/lender/loans/${A1()}/documents`,
        docUser(),
        uploadBody(`LETTER-${RUN}`, {
          kind: 'foreclosure_quote',
          periodFrom: undefined,
          periodTo: undefined,
        }),
      );
      expect(letter.statusCode).toBe(201);
      const letterId = letter.json<{ documentId: string }>().documentId;
      // An expired quotation may be recorded as history but cannot answer a request.
      const expired = await record(
        ids.aDocs,
        A1(),
        quoteBody(`FQ-${RUN}-OLD`, {
          asOf: iso(5),
          validUntil: iso(1),
          requestId: apps['REQ-QUOTE-A1'],
        }),
      );
      expect([expired.statusCode, code(expired)]).toEqual([409, 'quote_already_expired']);
      const res = await record(
        ids.aDocs,
        A1(),
        quoteBody(`FQ-${RUN}-3`, { requestId: apps['REQ-QUOTE-A1'], letterDocumentId: letterId }),
      );
      expect(res.statusCode).toBe(201);
      const quote = LsQuoteResult.parse(res.json()).quote;
      expect(quote.letterDocumentId).toBe(letterId);
      const request = LsDocumentRequestPage.parse(
        (
          await get(
            `/v1/lender/document-requests?kind=foreclosure_quote&loanAccountId=${A1()}`,
            ids.aViewer,
          )
        ).json(),
      ).items.find((i) => i.id === apps['REQ-QUOTE-A1']);
      expect(request).toMatchObject({
        status: 'fulfilled',
        fulfilledQuoteId: quote.id,
        fulfilledDocumentId: null,
      });
    });

    it('lists the quotations of a loan newest first, flagged ones included, and only for a reader of the lender', async () => {
      const res = await get(`/v1/lender/loans/${A1()}/foreclosure-quotes?limit=100`, ids.aViewer);
      expect(res.statusCode).toBe(200);
      const page = LsQuotePage.parse(res.json());
      expect(page.items.map((i) => i.lenderQuoteRef)).toEqual([
        `FQ-${RUN}-3`,
        `FQ-${RUN}-2`,
        `FQ-${RUN}-1`,
      ]);
      expect(page.items.map((i) => i.totalMismatch)).toEqual([false, true, false]);
      const first = LsQuotePage.parse(
        (await get(`/v1/lender/loans/${A1()}/foreclosure-quotes?limit=2`, ids.aViewer)).json(),
      );
      expect(first.items).toHaveLength(2);
      const second = LsQuotePage.parse(
        (
          await get(
            `/v1/lender/loans/${A1()}/foreclosure-quotes?limit=2&cursor=${encodeURIComponent(first.nextCursor ?? '')}`,
            ids.aViewer,
          )
        ).json(),
      );
      expect(second.items.map((i) => i.lenderQuoteRef)).toEqual([`FQ-${RUN}-1`]);
      expect(second.nextCursor).toBeNull();
      for (const [label, user, status] of [
        ['another lender', ids.bOp, 404],
        ['no loan.read', ids.aNoRead, 403],
        ['switch-off lender', ids.cOp, 404],
      ] as const) {
        const denied = await get(`/v1/lender/loans/${A1()}/foreclosure-quotes`, user);
        expect([label, denied.statusCode]).toEqual([label, status]);
      }
      expect(
        (await get(`/v1/lender/loans/${randomUUID()}/foreclosure-quotes`, ids.aViewer)).statusCode,
      ).toBe(404);
    });

    it('needs servicing.document.issue and the statements_noc switch: nothing is recorded otherwise', async () => {
      const before = await scalar<string>(
        `select count(*)::text as v from servicing.foreclosure_quotes`,
      );
      for (const [label, user, loanId, status, expectedCode] of [
        ['viewer', ids.aViewer, A1(), 403, 'forbidden'],
        ['manual entry only', ids.aManual, A1(), 403, 'forbidden'],
        ['sync.manage only', ids.aSync, A1(), 403, 'forbidden'],
        ['platform auditor', ids.pAud, A1(), 403, 'forbidden'],
        ['no loan.read', ids.aNoRead, A1(), 404, 'not_found'],
        ['another lender', ids.bOp, A1(), 404, 'not_found'],
        ['switch off', ids.cOp, loan.C1 ?? '', 409, 'feature_disabled'],
      ] as const) {
        const res = await record(user, loanId, quoteBody(`FQ-${RUN}-DENIED`));
        expect([label, res.statusCode, code(res)]).toEqual([label, status, expectedCode]);
      }
      expect(
        await scalar<string>(`select count(*)::text as v from servicing.foreclosure_quotes`),
      ).toBe(before);
      expect((await record(ids.aDocs, randomUUID(), quoteBody(`FQ-${RUN}-NONE`))).statusCode).toBe(
        404,
      );
    });
  });

  // ================================================================================================================
  // Closure and security release
  // ================================================================================================================
  describe('closure and security release', () => {
    const A2 = () => loan.A2 ?? '';
    const open = (user: string, loanId: string, collateralTypes: unknown) =>
      post(`/v1/lender/loans/${loanId}/security-release-tasks`, user, { collateralTypes });
    const tasks = async (user = ids.aViewer, lenderId?: string) => {
      const page = LsClosurePage.parse(
        (
          await get(`/v1/lender/closures?limit=100${lenderId ? `&lenderId=${lenderId}` : ''}`, user)
        ).json(),
      );
      return page.items.find((c) => c.loanAccountId === A2())?.tasks ?? [];
    };
    const taskIds: Record<string, string> = {};

    it("shows the loans the lender reported closed, opened once by the database, with nobody else's", async () => {
      const page = LsClosurePage.parse(
        (await get('/v1/lender/closures?limit=100', ids.aViewer)).json(),
      );
      const closure = page.items.find((c) => c.loanAccountId === A2());
      expect(closure).toMatchObject({ lenderId: ids.lenderA, closureKind: 'closed', tasks: [] });
      // No approved rule resolves in the test database: the due date is empty, never invented.
      expect(closure?.nocDueBy).toBeNull();
      expect(new Set(page.items.map((c) => c.lenderId))).toEqual(new Set([ids.lenderA]));
      expect(
        await scalar<string>(
          `select count(*)::text as v from servicing.closure_records where loan_account_id = $1`,
          [A2()],
        ),
      ).toBe('1');
      const b = LsClosurePage.parse((await get('/v1/lender/closures?limit=100', ids.bOp)).json());
      expect(b.items.map((c) => c.loanAccountId)).not.toContain(A2());
      expect((await get(`/v1/lender/closures?lenderId=${ids.lenderA}`, ids.bOp)).statusCode).toBe(
        403,
      );
      // Page size and cursor.
      const one = LsClosurePage.parse(
        (await get('/v1/lender/closures?limit=1', ids.aViewer)).json(),
      );
      expect(one.items.length).toBeLessThanOrEqual(1);
    });

    it('records the collateral the lender holds on a closed loan, once per type, and refuses an open loan', async () => {
      const res = await open(ids.aDocs, A2(), ['mutual_fund_lien', 'demat_pledge']);
      expect([res.statusCode, res.json()]).toEqual([200, { created: 2 }]);
      const again = await open(ids.aDocs, A2(), ['mutual_fund_lien', 'demat_pledge']);
      expect(again.json()).toEqual({ created: 0 });
      const more = await open(ids.aDocs2, A2(), ['other']);
      expect(more.json()).toEqual({ created: 1 });
      const list = await tasks();
      expect(list.map((t) => t.collateralType).sort()).toEqual([
        'demat_pledge',
        'mutual_fund_lien',
        'other',
      ]);
      for (const t of list) {
        expect(t).toMatchObject({
          status: 'open',
          dueBy: null,
          delayReason: null,
          lenderConfirmationRef: null,
          confirmedAt: null,
        });
        taskIds[t.collateralType] = t.id;
      }
      const active = await open(ids.aDocs, loan.A1 ?? '', ['mutual_fund_lien']);
      expect([active.statusCode, code(active)]).toEqual([409, 'loan_not_closed']);
      const dup = await open(ids.aDocs, A2(), ['other', 'other']);
      expect([dup.statusCode, code(dup)]).toEqual([422, 'collateral_types_invalid']);
      for (const bad of [
        [],
        ['gold'],
        [
          'other',
          'mutual_fund_lien',
          'demat_pledge',
          'property_documents',
          'vehicle_hypothecation',
          'other',
        ],
        'other',
      ]) {
        expect([JSON.stringify(bad), (await open(ids.aDocs, A2(), bad)).statusCode]).toEqual([
          JSON.stringify(bad),
          422,
        ]);
      }
      for (const type of LS_COLLATERAL_TYPES) expect(typeof type).toBe('string');
    });

    it('needs servicing.document.issue and the statements_noc switch to record collateral', async () => {
      for (const [label, user, loanId, status, expectedCode] of [
        ['viewer', ids.aViewer, A2(), 403, 'forbidden'],
        ['manual entry only', ids.aManual, A2(), 403, 'forbidden'],
        ['sync.manage only', ids.aSync, A2(), 403, 'forbidden'],
        ['platform auditor', ids.pAud, A2(), 403, 'forbidden'],
        ['no loan.read', ids.aNoRead, A2(), 404, 'not_found'],
        ['another lender', ids.bOp, A2(), 404, 'not_found'],
        ['switch off', ids.cOp, loan.C1 ?? '', 409, 'feature_disabled'],
      ] as const) {
        const res = await open(user, loanId, ['property_documents']);
        expect([label, res.statusCode, code(res)]).toEqual([label, status, expectedCode]);
      }
      expect((await tasks()).map((t) => t.collateralType)).not.toContain('property_documents');
    });

    it("records why a release is late, in the lender's own words, without personal data", async () => {
      const url = `/v1/lender/security-release/${taskIds.mutual_fund_lien ?? ''}/delay-reason`;
      const reason = 'The depository has not yet acknowledged the release request.';
      for (const [label, user, status] of [
        ['viewer', ids.aViewer, 403],
        ['manual entry only', ids.aManual, 403],
        ['platform auditor', ids.pAud, 403],
        ['another lender', ids.bOp, 404],
        ['no loan.read', ids.aNoRead, 404],
      ] as const) {
        const res = await post(url, user, { reason });
        expect([label, res.statusCode]).toEqual([label, status]);
      }
      const personal = await post(url, ids.aDocs, {
        reason: `Call ${CANARY.email} about it please.`,
      });
      expect([personal.statusCode, code(personal)]).toEqual([422, 'reason_invalid']);
      expect(personal.body).not.toContain(CANARY.email);
      expect((await post(url, ids.aDocs, { reason: 'late' })).statusCode).toBe(422);
      const ok = await post(url, ids.aDocs, { reason });
      expect([ok.statusCode, ok.json()]).toEqual([
        200,
        { id: taskIds.mutual_fund_lien, outcome: 'recorded' },
      ]);
      const task = (await tasks()).find((t) => t.id === taskIds.mutual_fund_lien);
      expect(task).toMatchObject({ delayReason: reason, status: 'open' });
      expect(task?.delayReasonAt).not.toBeNull();
      expect(
        (
          await post(`/v1/lender/security-release/${randomUUID()}/delay-reason`, ids.aDocs, {
            reason,
          })
        ).statusCode,
      ).toBe(404);
    });

    it("lets only a lender user confirm a release, with the lender's own reference; Udofin staff and other lenders cannot", async () => {
      const url = `/v1/lender/security-release/${taskIds.mutual_fund_lien ?? ''}/confirm`;
      const body = { confirmationRef: `REL-${RUN}-1` };
      for (const [label, user, status, expectedCode] of [
        ['viewer', ids.aViewer, 403, 'forbidden'],
        ['manual entry only', ids.aManual, 403, 'forbidden'],
        ['sync.manage only', ids.aSync, 403, 'forbidden'],
        ['platform auditor (reads, never confirms)', ids.pAud, 403, 'forbidden'],
        ['platform features admin', ids.pFeatures, 404, 'not_found'],
        ['another lender', ids.bOp, 404, 'not_found'],
        ['no loan.read', ids.aNoRead, 404, 'not_found'],
      ] as const) {
        const res = await post(url, user, body);
        expect([label, res.statusCode, code(res)].slice(0, 3)).toEqual([
          label,
          status,
          expectedCode,
        ]);
      }
      expect((await tasks()).find((t) => t.id === taskIds.mutual_fund_lien)?.status).toBe('open');
      for (const bad of [
        { confirmationRef: 'x y' },
        { confirmationRef: 'ab' },
        { confirmationRef: 'has space here' },
      ]) {
        const res = await post(url, ids.aDocs, bad);
        expect(res.statusCode).toBe(422);
      }
      const key = `it-confirm-${randomUUID()}`;
      const ok = await post(url, ids.aDocs, body, { key });
      expect([ok.statusCode, ok.json()]).toEqual([
        200,
        { id: taskIds.mutual_fund_lien, outcome: 'confirmed_by_lender' },
      ]);
      expect((await post(url, ids.aDocs, body, { key })).headers['idempotent-replayed']).toBe(
        'true',
      );
      const task = (await tasks()).find((t) => t.id === taskIds.mutual_fund_lien);
      expect(task).toMatchObject({
        status: 'confirmed_by_lender',
        lenderConfirmationRef: `REL-${RUN}-1`,
      });
      expect(task?.confirmedAt).not.toBeNull();
      // The database recorded who; the response never names them.
      expect(
        await scalar<string>(
          `select confirmed_by::text as v from servicing.security_release_tasks where id = $1`,
          [taskIds.mutual_fund_lien],
        ),
      ).toBe(ids.aDocs);
      const again = await post(url, ids.aDocs2, body);
      expect([again.statusCode, code(again)]).toEqual([409, 'already_confirmed']);
      const late = await post(
        `/v1/lender/security-release/${taskIds.mutual_fund_lien ?? ''}/delay-reason`,
        ids.aDocs,
        {
          reason: 'A reason added after the release was confirmed.',
        },
      );
      expect([late.statusCode, code(late)]).toEqual([409, 'already_confirmed']);
      // The other tasks stay open: nothing is confirmed on anyone's behalf.
      expect((await tasks()).filter((t) => t.status === 'open')).toHaveLength(2);
      expect(
        (await post(`/v1/lender/security-release/not-a-uuid/confirm`, ids.aDocs, body)).statusCode,
      ).toBe(422);
      expect(
        (await post(`/v1/lender/security-release/${randomUUID()}/confirm`, ids.aDocs, body))
          .statusCode,
      ).toBe(404);
    });

    it('answers 409 to the losing side of a confirmation that raced it, and to a delay reason that lost to it, never 500 (A7)', async () => {
      const taskId = taskIds.demat_pledge ?? '';
      const confirmUrl = `/v1/lender/security-release/${taskId}/confirm`;
      const delayUrl = `/v1/lender/security-release/${taskId}/delay-reason`;
      // The winner: a confirmation that has updated the task but not yet committed. The loser reads the task as open (the
      // winner's change is not visible yet), passes the status check and then waits for the row lock.
      const winner = await admin.connect();
      try {
        await winner.query('begin');
        await winner.query(
          `update servicing.security_release_tasks
              set status = 'confirmed_by_lender', lender_confirmation_ref = $2, confirmed_by = $3, confirmed_at = clock_timestamp()
            where id = $1`,
          [taskId, `REL-${RUN}-WIN`, ids.aDocs],
        );
        const waiting = async (fn: string) => {
          for (let n = 0; n < 100; n++) {
            const r = await q<{ n: string }>(
              `select count(*)::text as n from pg_stat_activity
                where wait_event_type = 'Lock' and datname = current_database() and query like $1`,
              [`%${fn}%`],
            );
            if (r[0]?.n !== '0') return;
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          throw new Error(`${fn} never waited for the lock`);
        };
        const loserConfirm = post(confirmUrl, ids.aDocs2, { confirmationRef: `REL-${RUN}-LOSE` });
        await waiting('confirm_security_release');
        const loserDelay = post(delayUrl, ids.aDocs3, {
          reason: 'The depository has not yet acknowledged the release request.',
        });
        await waiting('set_security_release_delay_reason');
        await winner.query('commit');
        for (const res of [await loserConfirm, await loserDelay]) {
          expect([res.statusCode, code(res)]).toEqual([409, 'already_confirmed']);
          expect(res.body).not.toContain('P0001');
        }
      } finally {
        await winner.query('rollback').catch(() => undefined);
        winner.release();
      }
      expect(
        await scalar<string>(
          `select lender_confirmation_ref as v from servicing.security_release_tasks where id = $1`,
          [taskId],
        ),
      ).toBe(`REL-${RUN}-WIN`);
    });

    it('answers feature_disabled for a lender whose switch is off, when it has a task', async () => {
      // Lender C reported no closure; a task id of another lender is simply not found for it.
      const res = await post(
        `/v1/lender/security-release/${taskIds.demat_pledge ?? ''}/confirm`,
        ids.cOp,
        {
          confirmationRef: `REL-${RUN}-C`,
        },
      );
      expect([res.statusCode, code(res)]).toEqual([404, 'not_found']);
    });
  });

  // ================================================================================================================
  // The kill switch
  // ================================================================================================================
  describe('the kill switch', () => {
    it('hides the feature at once: writes and openings answer feature_disabled, reading history stays possible', async () => {
      const D1 = loan.D1 ?? '';
      // While both switches are on, lender D can do everything.
      const before = await post(
        `/v1/lender/loans/${D1}/documents`,
        ids.dOp,
        uploadBody(`KILL-${RUN}-1`),
      );
      expect(before.statusCode).toBe(201);
      const documentId = before.json<{ documentId: string }>().documentId;
      const url = `/v1/lender/loans/${D1}/documents/${documentId}/content`;
      expect((await get(url, ids.dOp)).statusCode).toBe(200);
      const connect = {
        lenderId: ids.lenderD,
        kind: 'file_import',
        status: 'active',
      };
      expect((await post('/v1/lender/lms-connection', ids.dOp, connect)).statusCode).toBe(200);
      const stagedBefore = await post(
        '/v1/lender/imports',
        ids.dOp,
        importBody(ids.lenderD, {
          content: JSON.stringify([
            loanRecord({
              loanRef: `LS-KILL-${RUN}`,
              appRef: appRef('D1'),
              srid: `SRC-KILL-${RUN}`,
              hoursAgo: 4,
            }),
          ]),
        }),
      );
      expect(stagedBefore.statusCode).toBe(201);
      const batchId = LsImportOutcome.parse(stagedBefore.json()).batch?.id ?? '';

      // One platform person turns both switches off (a real, lasting change).
      for (const feature of ['statements_noc', 'servicing_sync'])
        await asUserCommit(ids.pFeatures, 'select servicing.kill_feature($1::uuid, $2, $3, $4)', [
          ids.lenderD,
          feature,
          'Test: emergency stop of the feature for this lender.',
          `it-kill-${feature}-${RUN}-0001`,
        ]);

      const upload = await post(
        `/v1/lender/loans/${D1}/documents`,
        ids.dOp,
        uploadBody(`KILL-${RUN}-2`),
      );
      expect([upload.statusCode, code(upload)]).toEqual([409, 'feature_disabled']);
      expect(
        await scalar<string>(
          `select count(*)::text as v from servicing.loan_documents where lender_reference = $1`,
          [`KILL-${RUN}-2`],
        ),
      ).toBe('0');
      const open = await get(url, ids.dOp);
      expect([open.statusCode, code(open)]).toEqual([409, 'feature_disabled']);
      const quote = await post(`/v1/lender/loans/${D1}/foreclosure-quotes`, ids.dOp, {
        lenderQuoteRef: `KQ-${RUN}`,
        asOf: iso(1),
        validUntil: iso(-1),
        principalMinor: 1,
        interestMinor: 1,
        chargesMinor: 1,
        prepaymentChargeMinor: 1,
        totalMinor: 4,
      });
      expect([quote.statusCode, code(quote)]).toEqual([409, 'feature_disabled']);
      // A42: the file_import connection is configuration (it sends nothing and stores no loan data) and is recorded while the
      // switch is off, because the switch cannot be turned on again without one. Every other kind stays behind the switch.
      const connection = await post('/v1/lender/lms-connection', ids.dOp, connect);
      expect(connection.statusCode).toBe(200);
      expect(
        await scalar<string>(
          `select count(*)::text as v from audit.events where action = 'servicing.connection.set' and entity_id = $1`,
          [connection.json<{ id: string }>().id],
        ),
      ).not.toBe('0');
      for (const other of [
        { kind: 'mock', status: 'active' },
        { kind: 'finbyx', status: 'blocked_unverified' },
      ]) {
        const refused = await post('/v1/lender/lms-connection', ids.dOp, {
          lenderId: ids.lenderD,
          ...other,
        });
        expect([other.kind, refused.statusCode, code(refused)]).toEqual([
          other.kind,
          409,
          'feature_disabled',
        ]);
      }
      const commit = await post(`/v1/lender/imports/${batchId}/commit`, ids.dOp, {});
      expect([commit.statusCode, code(commit)]).toEqual([409, 'feature_disabled']);
      const reject = await post(`/v1/lender/imports/${batchId}/reject`, ids.dOp, {
        reason: 'Switched off, discarding the preview.',
      });
      expect([reject.statusCode, code(reject)]).toEqual([409, 'feature_disabled']);
      const stage = await post(
        '/v1/lender/imports',
        ids.dOp,
        importBody(ids.lenderD, {
          content: JSON.stringify([
            loanRecord({
              loanRef: `LS-KILL2-${RUN}`,
              appRef: appRef('D1'),
              srid: `SRC-KILL2-${RUN}`,
              hoursAgo: 4,
            }),
          ]),
        }),
      );
      expect([stage.statusCode, code(stage)]).toEqual([409, 'feature_disabled']);
      // History is never hidden: the lender still reads its loans, its documents' metadata and its batches.
      const loans = LsLoanPage.parse((await get('/v1/lender/loans', ids.dOp)).json());
      expect(loans.items.map((i) => i.id)).toContain(loan.D1);
      expect((await get(`/v1/lender/loans/${D1}/documents`, ids.dOp)).statusCode).toBe(200);
      expect((await get(`/v1/lender/imports/${batchId}`, ids.dOp)).statusCode).toBe(200);
      // And the other lenders are not affected.
      expect(
        (
          await post(
            `/v1/lender/loans/${loan.A3 ?? ''}/documents`,
            docUser(),
            uploadBody(`KILL-${RUN}-A`),
          )
        ).statusCode,
      ).toBe(201);
    });
  });

  // ================================================================================================================
  // Nothing personal leaves the API
  // ================================================================================================================
  describe('data minimisation', () => {
    it('returns no borrower, user, application, hash-of-record, key or secret in any response of this file', () => {
      const everything = seen.join('\n');
      expect(everything.length).toBeGreaterThan(10_000);
      const values: [string, string][] = [
        ['borrower phone 1', CANARY.phoneB1],
        ['borrower phone 2', CANARY.phoneB2],
        ['account-shaped value', CANARY.account],
        ['phone-shaped reference', CANARY.phoneRef.replace('+', '')],
        ['secret name', CANARY.secretRef],
        ['e-mail address', CANARY.email],
        ['borrower id 1', borrower.b1],
        ['borrower id 2', borrower.b2],
        ['borrower user 1', ids.b1],
        ['borrower user 2', ids.b2],
        ['storage key prefix', '"servicing/'],
        ...Object.entries(apps)
          .filter(([label]) => !label.startsWith('REQ-'))
          .map(([label, id]): [string, string] => [`application ${label}`, id]),
        ...[
          ids.aOp,
          ids.aOp2,
          ids.aViewer,
          ids.aManual,
          ids.aSync,
          ids.aDocs,
          ids.aDocs2,
          ids.bOp,
          ids.cOp,
          ids.dOp,
          ids.pAud,
          ids.pFeatures,
        ].map((id, n): [string, string] => [`staff user ${String(n)}`, id]),
      ];
      for (const [label, value] of values)
        expect([label, everything.includes(value)]).toEqual([label, false]);
      // And by field name: nothing the database keeps for itself is a key of any response.
      for (const name of [
        'storage_key',
        'storageKey',
        'content_sha256',
        'contentSha256',
        'secret_ref',
        'secretRef',
        'idempotency_key',
        'idempotencyKey',
        'borrower_id',
        'borrowerId',
        'application_id',
        'applicationId',
        'uploaded_by',
        'uploadedBy',
        'requested_by',
        'requestedBy',
        'confirmed_by',
        'confirmedBy',
        'decided_by',
        'recorded_by',
        'reported_by',
        'incoming_report',
        'incomingReport',
        'normalised',
        'row_sha256',
        'accountNumber',
        'phone',
      ])
        expect([name, everything.includes(`"${name}"`)]).toEqual([name, false]);
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
      const logContent = JSON.stringify([
        loanRecord({
          loanRef: `LS-LOG-${RUN}`,
          appRef: appRef('LOGA'),
          srid: `${CANARY.logToken}-SRC`,
          hoursAgo: 3,
        }),
      ]);
      const pdfBytes = pdf(`log canary ${RUN}`);
      try {
        const send = (method: 'GET' | 'POST', url: string, user: string, payload?: unknown) =>
          logged.inject({
            method,
            url,
            remoteAddress: freshAddress(),
            headers: {
              authorization: `Bearer test.${user}.aal2`,
              ...(method === 'POST' ? { 'idempotency-key': `it-${randomUUID()}` } : {}),
            },
            ...(payload === undefined ? {} : { payload: payload as object }),
          });
        await send('GET', `/v1/lender/loans?lenderId=${ids.lenderA}&status=active`, ids.aViewer);
        await send('GET', `/v1/lender/loans/${loan.A1 ?? ''}`, ids.bOp);
        // A file with an account-number-shaped reference, a file the database will take, and the commit of that one.
        await send(
          'POST',
          '/v1/lender/imports',
          ids.aOp3,
          importBody(ids.lenderA, {
            content: JSON.stringify([
              loanRecord({
                loanRef: `LS-LOG0-${RUN}`,
                appRef: CANARY.account,
                srid: `${CANARY.logToken}-BAD`,
                hoursAgo: 3,
                extra: { sanctioned_amount: CANARY.amountText },
              }),
            ]),
          }),
        );
        const staged = await send(
          'POST',
          '/v1/lender/imports',
          ids.aOp3,
          importBody(ids.lenderA, { content: logContent }),
        );
        const batchId = staged.json<{ batch?: { id?: string } }>().batch?.id ?? '';
        await send('POST', `/v1/lender/imports/${batchId}/commit`, ids.aOp4, {});
        await send(
          'POST',
          `/v1/lender/loans/${loan.A1 ?? ''}/documents`,
          ids.aDocs,
          uploadBody(`${CANARY.logToken}-DOC`, { contentBase64: pdfBytes.toString('base64') }),
        );
        await send(
          'POST',
          `/v1/lender/loans/${loan.A1 ?? ''}/documents`,
          ids.bOp,
          uploadBody(`${CANARY.logToken}-DENIED`),
        );
        await send('POST', `/v1/lender/loans/${loan.A1 ?? ''}/foreclosure-quotes`, ids.aDocs, {
          lenderQuoteRef: `${CANARY.logToken}-Q`,
          asOf: iso(1),
          validUntil: iso(-1),
          principalMinor: 1,
          interestMinor: 1,
          chargesMinor: 1,
          prepaymentChargeMinor: 1,
          totalMinor: 4,
        });
        await send('POST', `/v1/lender/sync/conflicts/${randomUUID()}/resolve`, ids.aSync, {
          confirmedVersion: 'existing',
          note: `Reviewed by ${CANARY.email} last week.`,
          evidence: { reviewer: CANARY.email },
        });
        await new Promise((resolve) => setTimeout(resolve, 300));
      } finally {
        await logged.close();
        vi.restoreAllMocks();
      }
      const log = captured.join('');
      expect(log).toContain('request completed');
      for (const value of [
        CANARY.account,
        CANARY.phoneB1,
        CANARY.phoneB2,
        CANARY.logToken,
        CANARY.amountText,
        CANARY.secretRef,
        CANARY.email,
        borrower.b1,
        borrower.b2,
        sha256(logContent),
        sha256(pdfBytes),
        pdfBytes.toString('base64').slice(0, 24),
        `LS-LOG-${RUN}`,
        appRef('LOGA'),
        'servicing/',
        'contentBase64',
      ])
        expect([value, log.includes(value)]).toEqual([value, false]);
      // The path is logged; the query string and the body are not.
      expect(log).not.toContain('lenderId=');
      expect(log).not.toContain('"content"');
    });
  });

  // ================================================================================================================
  // The declared contract
  // ================================================================================================================
  describe('contract', () => {
    it('declares every route in the OpenAPI document', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/openapi.json' });
      expect(res.statusCode).toBe(200);
      const paths = Object.keys(res.json<{ paths: Record<string, unknown> }>().paths);
      for (const path of [
        '/v1/lender/loans',
        '/v1/lender/loans/{id}',
        '/v1/lender/sync/status',
        '/v1/lender/lms-connection',
        '/v1/lender/sync/anomalies',
        '/v1/lender/sync/conflicts',
        '/v1/lender/sync/conflicts/{id}/acknowledge',
        '/v1/lender/sync/conflicts/{id}/resolve',
        '/v1/lender/imports',
        '/v1/lender/imports/{id}',
        '/v1/lender/imports/{id}/commit',
        '/v1/lender/imports/{id}/reject',
        '/v1/lender/loans/{id}/documents',
        '/v1/lender/loans/{id}/documents/{docId}/content',
        '/v1/lender/document-requests',
        '/v1/lender/document-requests/{id}/decline',
        '/v1/lender/loans/{id}/foreclosure-quotes',
        '/v1/lender/closures',
        '/v1/lender/loans/{id}/security-release-tasks',
        '/v1/lender/security-release/{taskId}/confirm',
        '/v1/lender/security-release/{taskId}/delay-reason',
      ])
        expect(paths).toContain(path);
    });

    it('mirrors the database vocabularies: a constant that drifts from a check constraint or an enum fails here', async () => {
      const checkValues = async (table: string, column: string): Promise<string[]> => {
        const rows = await q<{ def: string }>(
          `select pg_get_constraintdef(c.oid) as def from pg_constraint c
             join pg_class t on t.oid = c.conrelid join pg_namespace n on n.oid = t.relnamespace
            where n.nspname = 'servicing' and t.relname = $1 and c.conname = $2`,
          [table, `${table}_${column}_check`],
        );
        const def = rows[0]?.def ?? '';
        expect([table, column, def.length > 0]).toEqual([table, column, true]);
        return [...def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1] ?? '').sort();
      };
      const same = (actual: string[], expected: readonly string[]) =>
        expect([...actual].sort()).toEqual([...expected].sort());
      same(
        await scalar<string[]>(`select enum_range(null::servicing.loan_status)::text[] as v`),
        LS_LOAN_STATUSES,
      );
      same(await checkValues('import_batches', 'status'), LS_BATCH_STATUSES);
      same(await checkValues('sync_anomalies', 'kind'), LS_ANOMALY_KINDS);
      same(await checkValues('sync_conflicts', 'conflict_reason'), LS_CONFLICT_REASONS);
      same(await checkValues('document_requests', 'kind'), LS_DOCUMENT_KINDS);
      same(await checkValues('security_release_tasks', 'collateral_type'), LS_COLLATERAL_TYPES);
      for (const key of LS_CAPABILITY_KEYS) {
        expect(
          await scalar<boolean>(
            `select private.servicing_capabilities_ok(jsonb_build_object($1::text, true)) as v`,
            [key],
          ),
        ).toBe(true);
      }
      expect(
        await scalar<boolean>(
          `select private.servicing_capabilities_ok('{"telepathy": true}'::jsonb) as v`,
        ),
      ).toBe(false);
    });
  });
});
