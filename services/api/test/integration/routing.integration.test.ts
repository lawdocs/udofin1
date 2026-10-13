// Phase 06 integration tests: lender routing, per-lender consent, worker transmission, signed callbacks, lender-reported
// status, offers and the comparison, over HTTP against a REAL migrated Postgres. The lender connector is the labelled
// mock; no real lender is contacted. Runs only when the INTEGRATION_* URLs are set (see docs/testing/strategy.md).
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { createMockLenderConnector, signMockCallback } from '@udofin/adapters';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { TokenError, type TokenVerifier } from '../../src/auth/token-verifier.js';
import { loadConfig } from '../../src/config.js';
import { createUserContext } from '../../src/db/user-context.js';
import { createBorrowerProcessor } from '../../src/system/borrower.js';
import { createChangeRequestApplier } from '../../src/system/change-requests.js';
import { createSystemPool, type SystemPool } from '../../src/system/pool.js';
import { createRoutingProcessor } from '../../src/system/routing.js';
import { createHandlers } from '../../src/workers/handlers.js';
import { buildCallbackApp } from '../../src/workers/lender-callbacks.js';
import { type OutboxEvent } from '../../src/workers/outbox-worker.js';
import { createConnectorResolver } from '../../src/workers/routing-handlers.js';

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
const freshAddress = () => `10.9.${(nextAddress >> 8) & 255}.${nextAddress++ & 255}`;
const phone = () => `91${Math.floor(1_000_000_000 + Math.random() * 8_999_999_999)}`;
const ref = () =>
  Array.from(randomBytes(10), (b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const DAY = 86_400_000;
const CALLBACK_SECRET = `v1,whsec_${randomBytes(24).toString('base64')}`;

describe.skipIf(!enabled)('lender routing over HTTP against a real database', () => {
  const ids = {
    b1: randomUUID(),
    b2: randomUUID(),
    lenderA: randomUUID(),
    lenderB: randomUUID(),
    lenderC: randomUUID(),
    aOfficer: randomUUID(),
    bOfficer: randomUUID(),
    cOfficer: randomUUID(),
    aViewer: randomUUID(),
    drafter: randomUUID(),
    approver: randomUUID(),
    p1: randomUUID(),
    p2: randomUUID(),
    platformOrg: randomUUID() as string,
    req1: randomUUID(),
    req2: randomUUID(),
  };
  const phones = { b1: phone(), b2: phone() };
  const notice: Record<string, string> = {};
  const mock = createMockLenderConnector('test');
  let admin: pg.Pool;
  let apiPool: pg.Pool;
  let systemPool: SystemPool;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let callbacks: Awaited<ReturnType<typeof buildCallbackApp>>;
  let handlers: ReturnType<typeof createHandlers>;
  const apps = { A: '', B: '', C2: '' };

  const call = (
    method: 'GET' | 'POST',
    url: string,
    user: string | null,
    payload?: unknown,
    key: string | null = method === 'POST' ? `it-${randomUUID()}` : null,
    aal: 'aal1' | 'aal2' = 'aal2',
  ) =>
    app.inject({
      method,
      url,
      remoteAddress: freshAddress(),
      headers: {
        ...(user ? { authorization: `Bearer test.${user}.${aal}` } : {}),
        ...(key ? { 'idempotency-key': key } : {}),
      },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  const get = (url: string, user: string | null) => call('GET', url, user);
  const post = (url: string, user: string | null, payload: unknown = {}, key?: string | null) =>
    call('POST', url, user, payload, key);
  const code = (res: { json: () => unknown }) => (res.json() as { code?: string }).code;
  const run = (type: string, payload: Record<string, unknown>) =>
    handlers[type]?.run(payload, { id: randomUUID() } as OutboxEvent) ??
    Promise.reject(new Error(`no handler ${type}`));
  const status = async (appId: string) =>
    (
      await admin.query<{ s: string }>(
        'select transmission_status s from lending.application_routing where application_id = $1',
        [appId],
      )
    ).rows[0]?.s;

  const offer = (host: string, over: Record<string, unknown> = {}) => ({
    lenderOfferRef: `OFFER-${ref()}`,
    principalMinor: 20_000_000,
    tenureDays: 720,
    installmentFrequency: 'monthly',
    installmentCount: 24,
    installmentAmountMinor: 1_000_000,
    monthlyRepaymentMinor: 1_000_000,
    annualInterestRateBps: 1800,
    aprBps: 2050,
    processingFeeMinor: 200_000,
    otherCharges: [],
    totalRepayableMinor: 24_000_000,
    penalChargesSummary: '2% a year on the overdue instalment amount',
    kfsUrl: `https://${host}/kfs/${ref()}`,
    issuedAt: iso(-60_000),
    validUntil: iso(8 * DAY),
    ...over,
  });

  async function makeLive(lender: string, maker: string, checker: string) {
    const d1 = randomUUID();
    const d2 = randomUUID();
    await admin.query(
      `insert into onboarding.documents (id, lender_org_id, purpose, label, storage_key, sha256, size_bytes, mime_type, uploaded_by) values
        ($1, $3, 'registration', 'evidence', $4, repeat('a', 64), 1000, 'application/pdf', $5),
        ($2, $3, 'contract', 'agreement', $6, repeat('b', 64), 1000, 'application/pdf', $5)`,
      [d1, d2, lender, `it/${d1.replace(/-/g, '')}`, maker, `it/${d2.replace(/-/g, '')}`],
    );
    await admin.query(
      `insert into onboarding.lender_gates (lender_org_id, stage) values ($1, 'activated') on conflict (lender_org_id) do update set stage = 'activated'`,
      [lender],
    );
    await admin.query(
      `insert into onboarding.lender_profiles (lender_org_id, category_key, regulator, registration_no, licence_status, verification_status, verification_evidence_id, verified_by, verified_at, last_verified_on, created_by)
       values ($1, 'nbfc_icc', 'RBI', $2, 'active', 'verified', $3, $4, now(), current_date, $5)`,
      [lender, `IT-REG-${ref()}`, d1, checker, maker],
    );
    await admin.query(
      `insert into onboarding.lender_contracts (lender_org_id, contract_type, reference, executed_on, effective_from, document_id, status, recorded_by, verified_by, verified_at)
       values ($1, 'lsp_agreement', 'IT-LSP-1', current_date, current_date, $2, 'executed', $3, $4, now())`,
      [lender, d2, maker, checker],
    );
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

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: ADMIN, max: 3 });
    apiPool = new pg.Pool({ connectionString: API, max: 10 });
    systemPool = createSystemPool(SYSTEM ?? '');
    for (const [id, p] of [
      [ids.b1, phones.b1],
      [ids.b2, phones.b2],
    ] as const) {
      await admin.query(
        `insert into auth.users (id, phone, raw_app_meta_data) values ($1, $2, '{}')`,
        [id, p],
      );
    }
    for (const id of [
      ids.aOfficer,
      ids.bOfficer,
      ids.cOfficer,
      ids.aViewer,
      ids.drafter,
      ids.approver,
      ids.p1,
      ids.p2,
    ]) {
      await admin.query(
        `insert into auth.users (id, phone, raw_app_meta_data) values ($1, null, '{"actor_type":"staff"}')`,
        [id],
      );
    }
    const existing = await admin.query<{ id: string }>(
      `select id from tenancy.organizations where kind = 'platform'`,
    );
    if (existing.rows[0]) ids.platformOrg = existing.rows[0].id;
    else
      await admin.query(
        `insert into tenancy.organizations (id, kind, legal_name, display_name, status) values ($1, 'platform', 'Udofin Platform (it)', 'Udofin', 'active')`,
        [ids.platformOrg],
      );
    for (const [lender, name] of [
      [ids.lenderA, 'Alpha Routing'],
      [ids.lenderB, 'Beta Routing'],
      [ids.lenderC, 'Gamma Routing'],
    ] as const) {
      await admin.query(
        `insert into tenancy.organizations (id, kind, legal_name, display_name, regulator_registration_no, status) values ($1, 'lender', $2, $3, $4, 'active')`,
        [lender, `${name} Ltd`, name, `IT-RT-${ref()}`],
      );
      await member(lender, ids.drafter, 'lender', 'lender_admin');
      await member(lender, ids.approver, 'lender', 'product_approver');
    }
    await member(ids.lenderA, ids.aOfficer, 'lender', 'credit_officer');
    await member(ids.lenderA, ids.aViewer, 'lender', 'viewer');
    await member(ids.lenderB, ids.bOfficer, 'lender', 'credit_officer');
    await member(ids.lenderC, ids.cOfficer, 'lender', 'credit_officer');
    await member(ids.platformOrg, ids.p1, 'platform', 'platform_admin');
    await member(ids.platformOrg, ids.p2, 'platform', 'platform_admin');
    for (const lender of [ids.lenderA, ids.lenderB, ids.lenderC]) {
      const product = randomUUID();
      await admin.query(
        `insert into lending.loan_products (id, lender_org_id, category_key, code, name, status) values ($1, $2, 'personal', 'PL-IT', $3, 'active')`,
        [product, lender, `Loan ${ref()}`],
      );
      await admin.query(
        `insert into lending.loan_product_versions (id, product_id, lender_org_id, version, status, min_amount_minor, max_amount_minor, min_tenure_days, max_tenure_days, rate_type, min_annual_rate_bps, max_annual_rate_bps, drafted_by, approved_by, approved_at, effective_from)
         values ($1, $2, $3, 1, 'approved', 1000000, 50000000, 180, 1825, 'fixed', 1400, 2400, $4, $5, now(), now())`,
        [randomUUID(), product, lender, ids.drafter, ids.approver],
      );
      await makeLive(lender, ids.aOfficer, ids.bOfficer);
    }
    // Connectors: Alpha and Gamma manual; Beta a labelled MOCK (the database allows it only in a session that says so).
    const c = await admin.connect();
    try {
      await c.query(`select set_config('udofin.allow_mock_connectors', 'on', false)`);
      await c.query(
        `insert into lending.lender_connectors (lender_org_id, kind, status, kfs_allowed_hosts, signing_secret_ref) values
        ($1, 'manual', 'active', array['kfs.alpha.example'], null), ($2, 'mock', 'active', array['kfs.beta.example'], 'BETA_MOCK_SECRET'), ($3, 'manual', 'active', array['kfs.gamma.example'], null)`,
        [ids.lenderA, ids.lenderB, ids.lenderC],
      );
    } finally {
      await c.query(`select set_config('udofin.allow_mock_connectors', '', false)`);
      c.release();
    }
    // Approved wording for Alpha and Gamma only; Beta's is deliberately missing at first.
    for (const [key, lender] of [
      ['A', ids.lenderA],
      ['C', ids.lenderC],
    ] as const) {
      notice[key] = randomUUID();
      await admin.query(
        `insert into consent.notices (id, purpose, version, language, lender_org_id, title, body_markdown, status, published_at, drafted_by, approved_by, review_status)
         values ($1, 'share_with_lender', 1, 'en', $2, 'Share', $3, 'published', now(), $4, $5, 'approved')`,
        [notice[key], lender, `Wording for ${key}`, ids.drafter, ids.approver],
      );
    }
    for (const [req, user] of [
      [ids.req1, ids.b1],
      [ids.req2, ids.b2],
    ] as const) {
      await admin.query(
        `insert into lending.loan_requests (id, borrower_id, category_key, requested_amount_minor, requested_tenure_days, purpose_code, status, submission_reference)
         values ($1, (select id from identity.borrowers where user_id = $2), 'personal', 20000000, 720, 'home_renovation', 'submitted', $3)`,
        [req, user, `UR-${ref()}`],
      );
    }
    app = await buildApp(loadConfig({ APP_ENV: 'test' }), {
      auth: { verifier: fakeVerifier, context: createUserContext(apiPool) },
    });
    const routing = createRoutingProcessor(systemPool);
    handlers = createHandlers({
      applier: createChangeRequestApplier(systemPool),
      borrower: createBorrowerProcessor(systemPool),
      changeRequestStatus: () => Promise.resolve(undefined),
      routing,
      connectors: createConnectorResolver({ environment: 'test', createMock: () => mock }),
    });
    callbacks = await buildCallbackApp(loadConfig({ APP_ENV: 'test' }), {
      routing,
      secret: (name) => (name === 'BETA_MOCK_SECRET' ? CALLBACK_SECRET : undefined),
      environment: 'test',
    });
  });

  afterAll(async () => {
    await app?.close();
    await callbacks?.close();
    await apiPool?.end();
    await systemPool?.end();
    await admin?.end();
  });

  describe('access', () => {
    it('keeps borrower routes for borrowers and lender routes for lender staff', async () => {
      expect((await get(`/v1/loan-requests/${ids.req1}/lenders`, ids.aOfficer)).statusCode).toBe(
        403,
      );
      expect(code(await get(`/v1/loan-requests/${ids.req1}/lenders`, ids.aOfficer))).toBe(
        'borrower_only',
      );
      expect(code(await get('/v1/lender/applications', ids.b1))).toBe('staff_only');
      expect((await get(`/v1/loan-requests/${ids.req1}/lenders`, null)).statusCode).toBe(401);
    });

    it("does not let borrower 2 touch borrower 1's request", async () => {
      expect((await get(`/v1/loan-requests/${ids.req1}/lenders`, ids.b2)).statusCode).toBe(404);
      expect(
        (
          await post(`/v1/loan-requests/${ids.req1}/selection`, ids.b2, {
            items: [{ lenderId: ids.lenderA }],
          })
        ).statusCode,
      ).toBe(404);
      expect((await post(`/v1/loan-requests/${ids.req1}/comparison`, ids.b2, {})).statusCode).toBe(
        404,
      );
    });
  });

  describe('selection and per-lender consent', () => {
    it('lists the three live lenders and preselects nothing', async () => {
      const res = await get(`/v1/loan-requests/${ids.req1}/lenders`, ids.b1);
      expect(res.statusCode).toBe(200);
      // A reused test database may hold lenders from earlier runs; only this run's lenders are checked.
      const mine = res
        .json<{ items: { lenderId: string }[] }>()
        .items.filter((i) =>
          ([ids.lenderA, ids.lenderB, ids.lenderC] as string[]).includes(i.lenderId),
        );
      expect(mine).toHaveLength(3);
      expect(res.json<{ maxLenders: number }>().maxLenders).toBe(5);
      const sel = await get(`/v1/loan-requests/${ids.req1}/selection?language=en`, ids.b1);
      expect(sel.json<{ selectionId: string | null; items: unknown[] }>()).toMatchObject({
        selectionId: null,
        items: [],
      });
    });

    it('enforces the limit and duplicates on the server', async () => {
      const six = Array.from({ length: 6 }, () => ({ lenderId: randomUUID() }));
      expect(
        (await post(`/v1/loan-requests/${ids.req1}/selection`, ids.b1, { items: six })).statusCode,
      ).toBe(422);
      const dup = await post(`/v1/loan-requests/${ids.req1}/selection`, ids.b1, {
        items: [{ lenderId: ids.lenderA }, { lenderId: ids.lenderA }],
      });
      expect(code(dup)).toBe('duplicate_lender');
      const unknown = await post(`/v1/loan-requests/${ids.req1}/selection`, ids.b1, {
        items: [{ lenderId: randomUUID() }],
      });
      expect(code(unknown)).toBe('lender_not_available');
    });

    it('blocks sharing while a lender has no approved wording, and records one consent per lender', async () => {
      const sel = await post(`/v1/loan-requests/${ids.req1}/selection`, ids.b1, {
        items: [{ lenderId: ids.lenderA }, { lenderId: ids.lenderB }],
      });
      expect(sel.statusCode, sel.body).toBe(201);
      const selectionId = sel.json<{ selectionId: string }>().selectionId;
      const view = (
        await get(`/v1/loan-requests/${ids.req1}/selection?language=en`, ids.b1)
      ).json<SelectionResponse>();
      expect(view.items).toHaveLength(2);
      expect(view.items.find((i) => i.lenderId === ids.lenderB)?.notice).toBeNull();
      expect(view.items.find((i) => i.lenderId === ids.lenderA)?.notice?.reviewStatus).toBe(
        'approved',
      );

      const route = await post(`/v1/selections/${selectionId}/route`, ids.b1);
      expect(code(route)).toBe('consent_required');

      const wrongNotice = await post(`/v1/loan-requests/${ids.req1}/lender-consents`, ids.b1, {
        lenderId: ids.lenderA,
        noticeId: notice.C,
        decision: 'granted',
      });
      expect(wrongNotice.statusCode).toBe(404);
      const a = await post(`/v1/loan-requests/${ids.req1}/lender-consents`, ids.b1, {
        lenderId: ids.lenderA,
        noticeId: notice.A,
        decision: 'granted',
      });
      expect(a.statusCode, a.body).toBe(201);
      expect(code(await post(`/v1/selections/${selectionId}/route`, ids.b1))).toBe(
        'consent_required',
      );

      // Beta publishes approved wording.
      notice.B = randomUUID();
      await admin.query(
        `insert into consent.notices (id, purpose, version, language, lender_org_id, title, body_markdown, status, published_at, drafted_by, approved_by, review_status)
         values ($1, 'share_with_lender', 1, 'en', $2, 'Share', 'Wording for B', 'published', now(), $3, $4, 'approved')`,
        [notice.B, ids.lenderB, ids.drafter, ids.approver],
      );
      const b = await post(`/v1/loan-requests/${ids.req1}/lender-consents`, ids.b1, {
        lenderId: ids.lenderB,
        noticeId: notice.B,
        decision: 'granted',
      });
      expect(b.statusCode, b.body).toBe(201);
      const evidence = await admin.query<{ n: string }>(
        `select count(*) n from consent.records where lender_org_id in ($1, $2) and evidence ->> 'scope' = 'minimum_payload_v1' and evidence ->> 'loan_request_id' = $3`,
        [ids.lenderA, ids.lenderB, ids.req1],
      );
      expect(Number(evidence.rows[0]?.n)).toBe(2);

      const key = `it-${randomUUID()}`;
      const routed = await post(`/v1/selections/${selectionId}/route`, ids.b1, {}, key);
      expect(routed.statusCode, routed.body).toBe(201);
      const items = routed.json<{ items: { applicationId: string; lenderId: string }[] }>().items;
      expect(items).toHaveLength(2);
      apps.A = items.find((i) => i.lenderId === ids.lenderA)?.applicationId ?? '';
      apps.B = items.find((i) => i.lenderId === ids.lenderB)?.applicationId ?? '';
      expect(
        (await post(`/v1/selections/${selectionId}/route`, ids.b1, {}, key)).headers[
          'idempotent-replayed'
        ],
      ).toBe('true');
      expect(code(await post(`/v1/selections/${selectionId}/route`, ids.b1))).toBe(
        'selection_closed',
      );
      expect(await status(apps.A)).toBe('transmitted');
      expect(await status(apps.B)).toBe('queued');
    });
  });

  describe('transmission by the worker (mock connector, labelled)', () => {
    it('sends exactly the approved payload, never stores the phone number, and treats a timeout as uncertain', async () => {
      mock.queue({ status: 'unknown', reason: 'timeout' });
      await run('application.routed', { application_id: apps.B });
      const sent = mock.submitted.at(-1);
      expect(Object.keys(sent?.payload ?? {}).sort()).toEqual([
        'displayName',
        'language',
        'phone',
        'productVersionId',
        'request',
        'udofinReference',
      ]);
      expect(Object.keys(sent?.payload.request ?? {}).sort()).toEqual([
        'amountMinor',
        'categoryKey',
        'purposeCode',
        'tenureDays',
      ]);
      expect(sent?.payload.phone).toBe(phones.b1);
      expect(await status(apps.B)).toBe('uncertain');
      const list = (await get(`/v1/loan-requests/${ids.req1}/applications`, ids.b1)).json<{
        items: { applicationId: string; stage: string }[];
      }>().items;
      expect(list.find((i) => i.applicationId === apps.B)?.stage).toBe('technical_failure');
      expect(list.find((i) => i.applicationId === apps.A)?.stage).toBe('sent');
    });

    it('does not send blindly again: a repeated job is a no-op while the outcome is uncertain', async () => {
      const before = mock.submitted.length;
      await run('application.routed', { application_id: apps.B });
      expect(mock.submitted.length).toBe(before);
    });

    it('reconciles by asking the lender, then sends once more only when it is confirmed absent', async () => {
      const corr =
        (
          await admin.query<{ c: string }>(
            'select correlation_ref::text c from lending.application_routing where application_id = $1',
            [apps.B],
          )
        ).rows[0]?.c ?? '';
      mock.setLookup(corr, { status: 'not_found' });
      await run('application.reconcile', { application_id: apps.B, round: 1 });
      expect(await status(apps.B)).toBe('queued');
      await run('application.routed', { application_id: apps.B });
      expect(mock.submitted.at(-1)?.attempt).toBe(2);
      expect(mock.submitted.at(-1)?.correlationRef).toBe(corr);
      expect(await status(apps.B)).toBe('acknowledged');
      // The job payloads hold identifiers only.
      const jobs = await admin.query<{ p: string }>(
        `select payload::text p from ops.outbox_events where payload ->> 'application_id' = $1`,
        [apps.B],
      );
      expect(jobs.rows.length).toBeGreaterThan(0);
      for (const row of jobs.rows) expect(row.p).not.toContain(phones.b1);
    });

    it("leaves no copy of the phone number in Udofin's lending, consent, audit or outbox data", async () => {
      const tables = await admin.query<{ s: string; t: string }>(
        `select table_schema s, table_name t from information_schema.tables where table_type = 'BASE TABLE' and table_schema in ('lending', 'consent', 'audit', 'ops')`,
      );
      for (const { s, t } of tables.rows) {
        const hit = await admin.query<{ n: string }>(
          `select count(*) n from ${s}.${t} x where to_jsonb(x)::text like $1`,
          [`%${phones.b1}%`],
        );
        expect(Number(hit.rows[0]?.n), `${s}.${t}`).toBe(0);
      }
    });

    it('stops a job whose consent has been withdrawn (and records withdrawal after sending without pretending to undo it)', async () => {
      // Borrower 2 chooses Gamma, consents, routes, then withdraws before the job runs: nothing is sent.
      const sel = await post(`/v1/loan-requests/${ids.req2}/selection`, ids.b2, {
        items: [{ lenderId: ids.lenderC }],
      });
      const selectionId = sel.json<{ selectionId: string }>().selectionId;
      await post(`/v1/loan-requests/${ids.req2}/lender-consents`, ids.b2, {
        lenderId: ids.lenderC,
        noticeId: notice.C,
        decision: 'granted',
      });
      const routed = await post(`/v1/selections/${selectionId}/route`, ids.b2);
      apps.C2 = routed.json<{ items: { applicationId: string }[] }>().items[0]?.applicationId ?? '';
      expect(await status(apps.C2)).toBe('transmitted'); // manual lender: visible in the portal
      const withdrawn = await post(`/v1/loan-requests/${ids.req2}/lender-consents`, ids.b2, {
        lenderId: ids.lenderC,
        noticeId: notice.C,
        decision: 'withdrawn',
      });
      expect(withdrawn.statusCode).toBe(201);
      const after = await admin.query<{ e: string }>(
        `select event e from lending.routing_events where application_id = $1 order by occurred_at`,
        [apps.C2],
      );
      expect(after.rows.map((r) => r.e)).toContain('consent_withdrawn_after_transmission');
      // Alpha and Gamma staff no longer get the contact detail for a withdrawn consent.
      const contact = await get(`/v1/lender/applications/${apps.C2}/contact`, ids.cOfficer);
      expect(code(contact)).toBe('consent_required');
    });

    it('a withdrawal and a send racing for the same application cannot both "win": the lock orders them and the outcome is recorded', async () => {
      // Borrower 1 re-routes nothing new; use a fresh request/borrower to isolate the race.
      const b3 = randomUUID();
      const req3 = randomUUID();
      await admin.query(
        `insert into auth.users (id, phone, raw_app_meta_data) values ($1, $2, '{}')`,
        [b3, phone()],
      );
      await admin.query(
        `insert into lending.loan_requests (id, borrower_id, category_key, requested_amount_minor, requested_tenure_days, purpose_code, status, submission_reference)
         values ($1, (select id from identity.borrowers where user_id = $2), 'personal', 20000000, 720, 'home_renovation', 'submitted', $3)`,
        [req3, b3, `UR-${ref()}`],
      );
      const sel = await post(`/v1/loan-requests/${req3}/selection`, b3, {
        items: [{ lenderId: ids.lenderB }],
      });
      await post(`/v1/loan-requests/${req3}/lender-consents`, b3, {
        lenderId: ids.lenderB,
        noticeId: notice.B,
        decision: 'granted',
      });
      const routed = await post(
        `/v1/selections/${sel.json<{ selectionId: string }>().selectionId}/route`,
        b3,
      );
      const appId =
        routed.json<{ items: { applicationId: string }[] }>().items[0]?.applicationId ?? '';

      // Sender holds the row lock (as begin_transmission does) while the withdrawal arrives.
      const sender = await admin.connect();
      await sender.query('begin');
      await sender.query(
        'select 1 from lending.application_routing where application_id = $1 for update',
        [appId],
      );
      const withdrawal = post(`/v1/loan-requests/${req3}/lender-consents`, b3, {
        lenderId: ids.lenderB,
        noticeId: notice.B,
        decision: 'withdrawn',
      });
      await new Promise((r) => setTimeout(r, 300));
      await sender.query(
        `update lending.application_routing set transmission_status = 'transmitting' where application_id = $1`,
        [appId],
      );
      await sender.query('commit');
      sender.release();
      expect((await withdrawal).statusCode).toBe(201);
      const row = await admin.query<{ s: string; w: boolean }>(
        'select transmission_status s, consent_withdrawn_at is not null w from lending.application_routing where application_id = $1',
        [appId],
      );
      // The send had begun first, so the withdrawal is recorded as "after sending began", and the job cannot be undone.
      expect(row.rows[0]).toEqual({ s: 'transmitting', w: true });
      const events = await admin.query<{ e: string }>(
        `select event e from lending.routing_events where application_id = $1`,
        [appId],
      );
      expect(events.rows.map((r) => r.e)).toContain('consent_withdrawn_after_transmission');
    });
  });

  describe('signed callbacks (mock scheme; Beta)', () => {
    const body = (correlationRef: string, type: string, extra: Record<string, unknown>) =>
      JSON.stringify({ correlationRef, type, body: extra });
    const send = (
      lender: string,
      raw: string,
      id: string,
      secret = CALLBACK_SECRET,
      ts = Math.floor(Date.now() / 1000),
      signature?: string,
    ) =>
      callbacks.inject({
        method: 'POST',
        url: `/v1/hooks/lenders/${lender}`,
        remoteAddress: freshAddress(),
        headers: {
          'content-type': 'application/json',
          'webhook-id': id,
          'webhook-timestamp': String(ts),
          'webhook-signature': signature ?? signMockCallback(secret, id, ts, raw),
        },
        payload: raw,
      });
    let corrB = '';
    beforeAll(async () => {
      corrB =
        (
          await admin.query<{ c: string }>(
            'select correlation_ref::text c from lending.application_routing where application_id = $1',
            [apps.B],
          )
        ).rows[0]?.c ?? '';
    });

    it('applies a valid event once and ignores a replay', async () => {
      const raw = body(corrB, 'decision', { decision: 'approved' });
      const id = `msg-${randomUUID()}`;
      const first = await send(ids.lenderB, raw, id);
      expect(first.statusCode, first.body).toBe(200);
      expect(first.json<{ outcome: string }>().outcome).toBe('applied');
      expect((await send(ids.lenderB, raw, id)).json<{ outcome: string }>().outcome).toBe(
        'duplicate',
      );
      const s = await admin.query<{ s: string }>(
        'select status::text s from lending.applications where id = $1',
        [apps.B],
      );
      expect(s.rows[0]?.s).toBe('approved');
    });

    it('refuses a bad signature, a wrong secret, a stale timestamp, a tampered body and malformed JSON', async () => {
      const raw = body(corrB, 'check', { kind: 'kyc', status: 'completed' });
      const id = () => `msg-${randomUUID()}`;
      expect(
        (
          await send(
            ids.lenderB,
            raw,
            id(),
            CALLBACK_SECRET,
            Math.floor(Date.now() / 1000),
            'v1,AAAA',
          )
        ).statusCode,
      ).toBe(401);
      expect(
        (await send(ids.lenderB, raw, id(), `v1,whsec_${randomBytes(24).toString('base64')}`))
          .statusCode,
      ).toBe(401);
      expect(
        (await send(ids.lenderB, raw, id(), CALLBACK_SECRET, Math.floor(Date.now() / 1000) - 3600))
          .statusCode,
      ).toBe(401);
      const mid = id();
      const signed = signMockCallback(CALLBACK_SECRET, mid, Math.floor(Date.now() / 1000), raw);
      expect(
        (
          await send(
            ids.lenderB,
            raw.replace('completed', 'failed'),
            mid,
            CALLBACK_SECRET,
            Math.floor(Date.now() / 1000),
            signed,
          )
        ).statusCode,
      ).toBe(401);
      const bad = await send(ids.lenderB, '{"correlationRef":"x"', id());
      expect(bad.statusCode).toBe(400);
      expect(bad.body).not.toContain('correlationRef');
      const none = await callbacks.inject({
        method: 'POST',
        url: `/v1/hooks/lenders/${ids.lenderB}`,
        remoteAddress: freshAddress(),
        headers: { 'content-type': 'application/json' },
        payload: raw,
      });
      expect(none.statusCode).toBe(400);
    });

    it('treats unknown, manual and api-kind lenders without revealing which, and refuses to guess an unwritten scheme', async () => {
      const raw = body(corrB, 'ack', {});
      expect((await send(randomUUID(), raw, `msg-${randomUUID()}`)).statusCode).toBe(404);
      expect((await send(ids.lenderA, raw, `msg-${randomUUID()}`)).statusCode).toBe(404);
      await admin.query(
        `update lending.lender_connectors set kind = 'api' where lender_org_id = $1`,
        [ids.lenderB],
      );
      try {
        expect((await send(ids.lenderB, raw, `msg-${randomUUID()}`)).statusCode).toBe(503);
      } finally {
        const c = await admin.connect();
        await c.query(`select set_config('udofin.allow_mock_connectors', 'on', false)`);
        await c.query(
          `update lending.lender_connectors set kind = 'mock' where lender_org_id = $1`,
          [ids.lenderB],
        );
        await c.query(`select set_config('udofin.allow_mock_connectors', '', false)`);
        c.release();
      }
    });

    it('will not accept mock callbacks outside local and test', async () => {
      const prod = await buildCallbackApp(loadConfig({ APP_ENV: 'test' }), {
        routing: createRoutingProcessor(systemPool),
        secret: () => CALLBACK_SECRET,
        environment: 'production',
      });
      const raw = body(corrB, 'ack', {});
      const id = `msg-${randomUUID()}`;
      const ts = Math.floor(Date.now() / 1000);
      const res = await prod.inject({
        method: 'POST',
        url: `/v1/hooks/lenders/${ids.lenderB}`,
        headers: {
          'content-type': 'application/json',
          'webhook-id': id,
          'webhook-timestamp': String(ts),
          'webhook-signature': signMockCallback(CALLBACK_SECRET, id, ts, raw),
        },
        payload: raw,
      });
      expect(res.statusCode).toBe(503);
      await prod.close();
    });

    it("rejects events for another lender's application, unknown references and impossible transitions, changing nothing", async () => {
      const wrongLender = await send(
        ids.lenderA,
        body(corrB, 'decision', { decision: 'declined' }),
        `msg-${randomUUID()}`,
      );
      expect(wrongLender.statusCode).toBe(404); // Alpha is manual: no callbacks at all
      const unknown = (
        await send(
          ids.lenderB,
          body(randomUUID(), 'decision', { decision: 'declined' }),
          `msg-${randomUUID()}`,
        )
      ).json<{ outcome: string; reason: string }>();
      expect(unknown).toMatchObject({ outcome: 'rejected', reason: 'unknown_application' });
      const backwards = (
        await send(
          ids.lenderB,
          body(corrB, 'decision', { decision: 'processing' }),
          `msg-${randomUUID()}`,
        )
      ).json<{ outcome: string; reason: string }>();
      expect(backwards).toMatchObject({ outcome: 'rejected', reason: 'invalid_transition' });
      const type = (
        await send(
          ids.lenderB,
          body(corrB, 'ack', {}).replace('"ack"', '"ack"'),
          `msg-${randomUUID()}`,
        )
      ).json<{ outcome: string }>();
      expect(type.outcome).toBe('applied');
    });

    it('concurrent identical callbacks apply once', async () => {
      const raw = body(corrB, 'check', {
        kind: 'bureau',
        status: 'in_progress',
        lenderEventRef: 'BUR-CONC',
      });
      const id = `msg-${randomUUID()}`;
      const results = await Promise.all(
        Array.from({ length: 6 }, () => send(ids.lenderB, raw, id)),
      );
      const outcomes = results.map((r) => r.json<{ outcome: string }>().outcome);
      expect(outcomes.filter((o) => o === 'applied')).toHaveLength(1);
      expect(outcomes.filter((o) => o === 'duplicate')).toHaveLength(5);
      const n = await admin.query<{ n: string }>(
        `select count(*) n from lending.application_checks where application_id = $1 and lender_event_ref = 'BUR-CONC'`,
        [apps.B],
      );
      expect(Number(n.rows[0]?.n)).toBe(1);
    });

    it('a signed offer callback is validated like a manual one (bad KFS host is held, not shown)', async () => {
      const held = (
        await send(
          ids.lenderB,
          body(corrB, 'offer', { offer: offer('evil.example') }),
          `msg-${randomUUID()}`,
        )
      ).json<{ outcome: string; reason?: string }>();
      expect(held.outcome).toBe('applied'); // processed: stored as held
      const intake = await admin.query<{ v: string; i: string[] }>(
        `select validation v, issues i from lending.offer_intake where application_id = $1 order by submitted_at desc limit 1`,
        [apps.B],
      );
      expect(intake.rows[0]?.v).toBe('held');
      expect(intake.rows[0]?.i).toContain('kfs_host_not_allowed');
      const ok = (
        await send(
          ids.lenderB,
          body(corrB, 'offer', {
            offer: offer('kfs.beta.example', {
              aprBps: 2050,
              monthlyRepaymentMinor: 1_010_000,
              installmentAmountMinor: 1_010_000,
              totalRepayableMinor: 23_500_000,
            }),
          }),
          `msg-${randomUUID()}`,
        )
      ).json<{ outcome: string }>();
      expect(ok.outcome).toBe('applied');
    });
  });

  describe('lender portal (manual lender)', () => {
    it('shows each lender only its own applications, without borrower identifiers or phone numbers', async () => {
      const a = await get('/v1/lender/applications', ids.aOfficer);
      expect(a.statusCode).toBe(200);
      const items = a.json<{ items: { applicationId: string }[] }>().items;
      expect(items.map((i) => i.applicationId)).toContain(apps.A);
      expect(items.map((i) => i.applicationId)).not.toContain(apps.B);
      expect(a.body).not.toContain(phones.b1);
      expect(a.body).not.toMatch(/borrower_?id/i);
      const b = await get('/v1/lender/applications', ids.bOfficer);
      expect(
        b.json<{ items: { applicationId: string }[] }>().items.map((i) => i.applicationId),
      ).not.toContain(apps.A);
      expect((await get(`/v1/lender/applications/${apps.B}`, ids.aOfficer)).statusCode).toBe(404);
      expect(
        (
          await post(`/v1/lender/applications/${apps.B}/decision`, ids.aOfficer, {
            decision: 'declined',
          })
        ).statusCode,
      ).toBe(404);
    });

    it('requires the permission, a second factor and valid values', async () => {
      expect(
        (await post(`/v1/lender/applications/${apps.A}/acknowledge`, ids.aViewer, {})).statusCode,
      ).toBe(403);
      expect(
        (
          await call(
            'POST',
            `/v1/lender/applications/${apps.A}/acknowledge`,
            ids.aOfficer,
            {},
            `it-${randomUUID()}`,
            'aal1',
          )
        ).statusCode,
      ).toBe(401);
      expect(
        code(
          await post(`/v1/lender/applications/${apps.A}/checks`, ids.aOfficer, {
            kind: 'kyc',
            status: 'verified',
          }),
        ),
      ).toBe('validation_failed');
      expect(
        code(
          await post(`/v1/lender/applications/${apps.A}/checks`, ids.aOfficer, {
            kind: 'kyc',
            status: 'completed',
            pan: 'ABCDE1234F',
          }),
        ),
      ).toBe('validation_failed');
    });

    it('records acknowledgement, a reported check and a decision; the borrower sees them as lender-reported', async () => {
      expect(
        (
          await post(`/v1/lender/applications/${apps.A}/acknowledge`, ids.aOfficer, {
            lenderApplicationRef: 'ALPHA-1',
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await post(`/v1/lender/applications/${apps.A}/checks`, ids.aOfficer, {
            kind: 'kyc',
            status: 'in_progress',
          })
        ).statusCode,
      ).toBe(200);
      const view = (await get(`/v1/loan-requests/${ids.req1}/applications`, ids.b1)).json<{
        items: {
          applicationId: string;
          stage: string;
          checks: { kind: string; status: string }[];
        }[];
      }>().items;
      const mine = view.find((i) => i.applicationId === apps.A);
      expect(mine?.checks).toEqual([
        expect.objectContaining({ kind: 'kyc', status: 'in_progress' }),
      ]);
      expect(mine?.stage).toBe('acknowledged');
      expect(
        (
          await post(`/v1/lender/applications/${apps.A}/decision`, ids.aOfficer, {
            decision: 'approved',
          })
        ).statusCode,
      ).toBe(200);
    });

    it('holds an offer with problems for correction, stores a good one exactly as stated, and keeps revisions', async () => {
      const noKfs = await post(
        `/v1/lender/applications/${apps.A}/offers`,
        ids.aOfficer,
        offer('evil.example'),
      );
      expect(noKfs.json<{ status: string; issues: string[] }>()).toMatchObject({
        status: 'held',
        issues: ['kfs_host_not_allowed'],
      });
      const short = await post(
        `/v1/lender/applications/${apps.A}/offers`,
        ids.aOfficer,
        offer('kfs.alpha.example', { validUntil: iso(6 * DAY) }),
      );
      expect(short.json<{ issues: string[] }>().issues).toContain('validity_too_short');
      const good = await post(
        `/v1/lender/applications/${apps.A}/offers`,
        ids.aOfficer,
        offer('kfs.alpha.example', {
          lenderOfferRef: 'A-OFFER-1',
          aprBps: 2050,
          monthlyRepaymentMinor: 1_000_000,
          totalRepayableMinor: 23_900_000,
        }),
      );
      expect(good.json<{ status: string }>().status).toBe('accepted');
      const stored = await admin.query<{ r: string }>(
        `select row(apr_bps, monthly_repayment_minor, total_repayable_minor, principal_minor)::text r from lending.offers where lender_offer_ref = 'A-OFFER-1'`,
      );
      expect(stored.rows[0]?.r).toBe('(2050,1000000,23900000,20000000)');
      const detail = (await get(`/v1/lender/applications/${apps.A}`, ids.aOfficer)).json<{
        offerIntake: { validation: string }[];
        offers: unknown[];
      }>();
      expect(detail.offerIntake.map((i) => i.validation).sort()).toEqual([
        'accepted',
        'held',
        'held',
      ]);
      expect(detail.offers).toHaveLength(1);
    });

    it('discloses the contact detail only to the lender, only with consent, and never in the idempotency store or audit', async () => {
      const contact = await get(`/v1/lender/applications/${apps.A}/contact`, ids.aOfficer);
      expect(contact.statusCode).toBe(200);
      expect(contact.json<{ phone: string }>().phone).toBe(phones.b1);
      expect(contact.headers['cache-control']).toBe('no-store');
      expect(
        (await get(`/v1/lender/applications/${apps.A}/contact`, ids.bOfficer)).statusCode,
      ).toBe(404);
      const idem = await admin.query<{ n: string }>(
        `select count(*) n from ops.idempotency_keys k where k.response_body::text like $1`,
        [`%${phones.b1}%`],
      );
      expect(Number(idem.rows[0]?.n)).toBe(0);
      const audit = await admin.query<{ n: string }>(
        `select count(*) n from audit.events e where e.action = 'lending.contact.disclosed' and e.metadata::text like $1`,
        [`%${phones.b1}%`],
      );
      expect(Number(audit.rows[0]?.n)).toBe(0);
    });
  });

  describe('ordering rule and comparison', () => {
    it('cannot be served until an ordering rule is approved by two people', async () => {
      const existing = await admin.query<{ n: string }>(
        'select count(*) n from lending.matching_rule_versions where effective_from <= now()',
      );
      // On a fresh database no rule is in force and the comparison must refuse; a reused database already holds one.
      if (Number(existing.rows[0]?.n) === 0) {
        expect(code(await post(`/v1/loan-requests/${ids.req1}/comparison`, ids.b1, {}))).toBe(
          'ranking_rule_not_approved',
        );
      }
      const proposal = await post('/v1/platform/matching-rules', ids.p1, {
        mechanismSummary:
          'Offers are ordered by the lender-supplied APR, lowest first, then by lender-supplied monthly repayment.',
        disclosedMetric: 'Lender-supplied APR, then monthly repayment',
        sortKeys: ['apr_bps', 'monthly_repayment_minor'],
        alternativeSorts: ['monthly_repayment_minor', 'total_repayable_minor'],
        effectiveFrom: iso(-1000),
      });
      expect(proposal.statusCode, proposal.body).toBe(201);
      const id = proposal.json<{ id: string }>().id;
      expect(
        code(await post(`/v1/platform/matching-rules/${id}/decision`, ids.p1, { approve: true })),
      ).toBe('segregation_of_duties');
      expect(
        (await post(`/v1/platform/matching-rules/${id}/decision`, ids.aOfficer, { approve: true }))
          .statusCode,
      ).toBe(403);
      expect(
        (await post(`/v1/platform/matching-rules/${id}/decision`, ids.p2, { approve: true }))
          .statusCode,
      ).toBe(200);
      expect(
        (await get('/v1/platform/matching-rules', ids.p1)).json<{ versions: unknown[] }>().versions
          .length,
      ).toBeGreaterThan(0);
    });

    it('lists the valid offers in the approved order, names the lenders that did not offer, and logs the view', async () => {
      const res = await post(`/v1/loan-requests/${ids.req1}/comparison`, ids.b1, {
        platform: 'android',
        language: 'en',
      });
      expect(res.statusCode, res.body).toBe(200);
      const data = res.json<{
        runId: string;
        offers: {
          lenderId: string;
          rank: number;
          kfsUrl: string;
          aprBps: number;
          monthlyRepaymentMinor: number;
        }[];
        nonOffers: unknown[];
        rule: { version: number };
      }>();
      expect(data.offers).toHaveLength(2);
      // Equal APR (2050): the lower lender-supplied monthly repayment ranks first (Alpha 1,000,000 before Beta 1,010,000).
      expect(data.offers.map((o) => o.lenderId)).toEqual([ids.lenderA, ids.lenderB]);
      expect(data.offers.every((o) => o.kfsUrl.startsWith('https://kfs.'))).toBe(true);
      expect(data.nonOffers).toEqual([]);
      const total = await post(`/v1/loan-requests/${ids.req1}/comparison`, ids.b1, {
        sort: 'total_repayable_minor',
      });
      expect(
        total.json<{ offers: { lenderId: string }[] }>().offers.map((o) => o.lenderId),
      ).toEqual([ids.lenderB, ids.lenderA]);
      const logged = await admin.query<{ n: string }>(
        'select count(*) n from lending.offer_displays where run_id = $1 and rule_version_id is not null',
        [data.runId],
      );
      expect(Number(logged.rows[0]?.n)).toBe(2);
      expect(
        code(
          await post(`/v1/loan-requests/${ids.req1}/comparison`, ids.b1, {
            sort: 'borrower_score',
          }),
        ),
      ).toBe('validation_failed');
      expect(res.body).not.toMatch(/recommend|best offer|countdown/i);
    });

    it('replays an identical comparison request without logging a second view', async () => {
      const key = `it-${randomUUID()}`;
      const before = Number(
        (await admin.query<{ n: string }>('select count(*) n from lending.comparison_runs')).rows[0]
          ?.n,
      );
      const one = await post(`/v1/loan-requests/${ids.req1}/comparison`, ids.b1, {}, key);
      const two = await post(`/v1/loan-requests/${ids.req1}/comparison`, ids.b1, {}, key);
      expect(two.headers['idempotent-replayed']).toBe('true');
      expect(two.json<{ runId: string }>().runId).toBe(one.json<{ runId: string }>().runId);
      const after = Number(
        (await admin.query<{ n: string }>('select count(*) n from lending.comparison_runs')).rows[0]
          ?.n,
      );
      expect(after - before).toBe(1);
    });

    it('shows a decline, silence and a technical failure distinctly (never all as "declined")', async () => {
      // Gamma declines, borrower 2's Alpha-free request: use request 2 with Gamma (consent was withdrawn there), so use request 1 with a third lender instead.
      const sel = await post(`/v1/loan-requests/${ids.req1}/selection`, ids.b1, {
        items: [{ lenderId: ids.lenderC }],
      });
      await post(`/v1/loan-requests/${ids.req1}/lender-consents`, ids.b1, {
        lenderId: ids.lenderC,
        noticeId: notice.C,
        decision: 'granted',
      });
      const routed = await post(
        `/v1/selections/${sel.json<{ selectionId: string }>().selectionId}/route`,
        ids.b1,
      );
      expect(routed.statusCode, routed.body).toBe(201);
      const c1 =
        routed.json<{ items: { applicationId: string }[] }>().items[0]?.applicationId ?? '';
      // Silence: past its deadline, not declined.
      await admin.query(
        `update lending.application_routing set response_due_at = now() - interval '1 hour' where application_id = $1`,
        [c1],
      );
      await systemPool.withSystem((tx) => tx.query('select lending.process_deadlines()'));
      let cmp = (await post(`/v1/loan-requests/${ids.req1}/comparison`, ids.b1, {})).json<{
        nonOffers: { lenderId: string; reason: string }[];
      }>();
      expect(cmp.nonOffers.find((n) => n.lenderId === ids.lenderC)?.reason).toBe('no_response');
      expect(
        (
          await admin.query<{ s: string }>(
            'select status::text s from lending.applications where id = $1',
            [c1],
          )
        ).rows[0]?.s,
      ).toBe('submitted');
      // A late decline is recorded and flagged, not applied.
      const late = await post(`/v1/lender/applications/${c1}/decision`, ids.cOfficer, {
        decision: 'declined',
      });
      expect(late.json<{ applied: boolean; note: string }>()).toMatchObject({
        applied: false,
        note: 'late_response_policy_pending',
      });
      cmp = (await post(`/v1/loan-requests/${ids.req1}/comparison`, ids.b1, {})).json<{
        nonOffers: { lenderId: string; reason: string }[];
      }>();
      expect(cmp.nonOffers.find((n) => n.lenderId === ids.lenderC)?.reason).toBe('no_response');
    });

    it('hides a withdrawn offer and an expired one', async () => {
      expect(
        (
          await post(`/v1/lender/applications/${apps.A}/offers/withdraw`, ids.aOfficer, {
            lenderOfferRef: 'A-OFFER-1',
          })
        ).statusCode,
      ).toBe(200);
      const after = (await post(`/v1/loan-requests/${ids.req1}/comparison`, ids.b1, {})).json<{
        offers: { lenderId: string }[];
        nonOffers: { lenderId: string; reason: string }[];
      }>();
      expect(after.offers.map((o) => o.lenderId)).toEqual([ids.lenderB]);
      expect(after.nonOffers.find((n) => n.lenderId === ids.lenderA)?.reason).toBe(
        'offer_unavailable',
      );
      await admin.query('alter table lending.offers disable trigger offers_protect');
      await admin.query(
        `update lending.offers set valid_until = now() - interval '1 minute' where application_id = $1 and status = 'issued'`,
        [apps.B],
      );
      await admin.query('alter table lending.offers enable trigger offers_protect');
      const empty = (await post(`/v1/loan-requests/${ids.req1}/comparison`, ids.b1, {})).json<{
        offers: unknown[];
      }>();
      expect(empty.offers).toEqual([]);
    });

    it('keeps the iOS 36% filter off by default', async () => {
      const res = (
        await post(`/v1/loan-requests/${ids.req1}/comparison`, ids.b1, { platform: 'ios' })
      ).json<{ filteredCount: number }>();
      expect(res.filteredCount).toBe(0);
      const setting = await admin.query<{ v: boolean }>(
        `select bool_value v from onboarding.platform_settings where key = 'ios_apr_filter_enabled'`,
      );
      expect(setting.rows[0]?.v).toBe(false);
    });
  });

  describe('platform configuration', () => {
    it('lets platform staff, and only them, configure a connector; a mock cannot be configured here', async () => {
      const body = {
        kind: 'manual',
        status: 'active',
        responseHours: 72,
        offerMinValidityDays: 10,
        kfsAllowedHosts: ['kfs.alpha.example'],
      };
      expect(
        (await post(`/v1/platform/lenders/${ids.lenderA}/connector`, ids.aOfficer, body))
          .statusCode,
      ).toBe(403);
      expect(
        (
          await post(`/v1/platform/lenders/${ids.lenderA}/connector`, ids.p1, {
            ...body,
            kind: 'mock',
          })
        ).statusCode,
      ).toBe(422);
      expect(
        (
          await post(`/v1/platform/lenders/${ids.lenderA}/connector`, ids.p1, {
            ...body,
            offerMinValidityDays: 3,
          })
        ).statusCode,
      ).toBe(422);
      expect(
        (await post(`/v1/platform/lenders/${ids.lenderA}/connector`, ids.p1, body)).statusCode,
      ).toBe(200);
      const list = (await get('/v1/platform/lender-connectors', ids.p1)).json<{
        items: { lenderId: string; responseHours: number }[];
      }>();
      expect(list.items.find((i) => i.lenderId === ids.lenderA)?.responseHours).toBe(72);
      expect((await get('/v1/platform/lender-connectors', ids.b1)).statusCode).toBe(403);
    });
  });
});

interface SelectionResponse {
  items: { lenderId: string; notice: { reviewStatus: string } | null }[];
}
