// Product configuration and the lender transactions panel over HTTP against a real migrated Postgres
// (same gating as api.integration.test.ts). Synthetic data only.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
const freshAddress = () => `10.9.${(nextAddress >> 8) & 255}.${nextAddress++ & 255}`;

describe.skipIf(!enabled)('product configuration and lender panel over HTTP', () => {
  const ids = {
    platformOrg: randomUUID(),
    lenderA: randomUUID(),
    lenderB: randomUUID(),
    aAdmin: randomUUID(),
    aApprover: randomUUID(),
    aViewer: randomUUID(),
    bAdmin: randomUUID(),
    ops: randomUUID(),
    mgr: randomUUID(),
    apr: randomUUID(),
    cmp: randomUUID(),
    borrower: randomUUID(),
  };
  let admin: pg.Pool;
  let apiPool: pg.Pool;
  let app: Awaited<ReturnType<typeof buildApp>>;

  const call = (method: 'GET' | 'POST', url: string, user: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      remoteAddress: freshAddress(),
      headers: {
        authorization: `Bearer test.${user}.aal2`,
        ...(method === 'POST' ? { 'idempotency-key': `it-${randomUUID()}` } : {}),
      },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  const get = (url: string, user: string) => call('GET', url, user);
  const post = (url: string, user: string, payload: unknown = {}) =>
    call('POST', url, user, payload);

  const terms = {
    minAmountMinor: 1_000_000,
    maxAmountMinor: 50_000_000,
    minTenureDays: 180,
    maxTenureDays: 1825,
    rateType: 'fixed',
    minAnnualRateBps: 1400,
    maxAnnualRateBps: 2400,
  };
  const config = {
    display: { marketingName: 'Everyday Personal Loan' },
    fees: [
      {
        code: 'processing',
        label: 'Processing fee',
        kind: 'percent_of_principal',
        rateBps: 200,
        taxIncluded: false,
        timing: 'at_disbursement',
        refundable: false,
      },
    ],
    eligibility: {
      match: 'all',
      rules: [
        { field: 'age_years', operator: 'between', value: [21, 60] },
        { field: 'employment_type', operator: 'in', value: ['salaried', 'self_employed'] },
      ],
    },
    repayment: {
      frequencies: ['monthly'],
      methods: ['upi_autopay'],
      installmentType: 'reducing_balance',
      gracePeriodDays: 0,
      moratoriumDays: 0,
    },
    documents: [
      {
        code: 'income_proof',
        label: 'Income proof',
        mandatory: true,
        acceptedMimeTypes: ['application/pdf'],
      },
    ],
    attributes: { internal_code: 'PL-01' },
  };

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: ADMIN, max: 2 });
    apiPool = new pg.Pool({ connectionString: API, max: 8 });
    for (const id of [
      ids.aAdmin,
      ids.aApprover,
      ids.aViewer,
      ids.bAdmin,
      ids.ops,
      ids.mgr,
      ids.apr,
      ids.cmp,
    ]) {
      await admin.query(
        `insert into auth.users (id, phone, raw_app_meta_data) values ($1, null, '{"actor_type":"staff"}')`,
        [id],
      );
    }
    await admin.query(
      `insert into auth.users (id, phone, raw_app_meta_data) values ($1, $2, '{}')`,
      [ids.borrower, `91${Math.floor(1_000_000_000 + Math.random() * 8_999_999_999)}`],
    );
    const existing = await admin.query<{ id: string }>(
      `select id from tenancy.organizations where kind = 'platform'`,
    );
    if (existing.rows[0]) ids.platformOrg = existing.rows[0].id as typeof ids.platformOrg;
    else {
      await admin.query(
        `insert into tenancy.organizations (id, kind, legal_name, display_name, status) values ($1, 'platform', 'Udofin Platform (it)', 'Udofin', 'active')`,
        [ids.platformOrg],
      );
    }
    await admin.query(
      `insert into tenancy.organizations (id, kind, legal_name, display_name, regulator_registration_no, status) values
        ($1, 'lender', 'Panel Alpha IT Ltd', 'Alpha', 'IT-PNL-A', 'active'), ($2, 'lender', 'Panel Beta IT Ltd', 'Beta', 'IT-PNL-B', 'active')`,
      [ids.lenderA, ids.lenderB],
    );
    const members: [string, string, string][] = [
      [ids.lenderA, ids.aAdmin, 'lender_admin'],
      [ids.lenderA, ids.aApprover, 'product_approver'],
      [ids.lenderA, ids.aViewer, 'viewer'],
      [ids.lenderB, ids.bAdmin, 'lender_admin'],
      [ids.platformOrg, ids.ops, 'operations_agent'],
      [ids.platformOrg, ids.mgr, 'onboarding_manager'],
      [ids.platformOrg, ids.apr, 'onboarding_approver'],
      [ids.platformOrg, ids.cmp, 'compliance_officer'],
    ];
    for (const [org, user, role] of members) {
      const m = await admin.query<{ id: string }>(
        'insert into tenancy.memberships (org_id, user_id, status) values ($1, $2, $3) returning id',
        [org, user, 'active'],
      );
      await admin.query(
        `insert into tenancy.membership_roles (membership_id, role_id)
         select $1, r.id from tenancy.roles r join tenancy.organizations o on o.kind = r.applies_to where o.id = $2 and r.org_id is null and r.key = $3`,
        [m.rows[0]?.id, org, role],
      );
    }

    // Panel fixtures (owner-inserted): for each lender one product version, application, loan account and payment.
    const borrower = (
      await admin.query<{ id: string }>('select id from identity.borrowers where user_id = $1', [
        ids.borrower,
      ])
    ).rows[0]?.id;
    for (const [lender, drafter, approver, code] of [
      [ids.lenderA, ids.aAdmin, ids.aApprover, 'PNL-A'],
      [ids.lenderB, ids.bAdmin, ids.bAdmin, 'PNL-B'],
    ] as const) {
      const product = (
        await admin.query<{ id: string }>(
          `insert into lending.loan_products (lender_org_id, category_key, code, name, status) values ($1, 'personal', $2, $2, 'active') returning id`,
          [lender, code],
        )
      ).rows[0]?.id;
      await admin.query(`update lending.loan_products set status = 'active' where id = $1`, [
        product,
      ]);
      const draftedBy = lender === ids.lenderB ? ids.bAdmin : drafter;
      const version = (
        await admin.query<{ id: string }>(
          `insert into lending.loan_product_versions (product_id, lender_org_id, version, status, min_amount_minor, max_amount_minor, min_tenure_days, max_tenure_days, rate_type, min_annual_rate_bps, max_annual_rate_bps, drafted_by)
         values ($1, $2, 1, 'draft', 1000000, 5000000, 180, 720, 'fixed', 1400, 2400, $3) returning id`,
          [product, lender, draftedBy],
        )
      ).rows[0]?.id;
      void approver;
      const request = (
        await admin.query<{ id: string }>(
          `insert into lending.loan_requests (borrower_id, category_key, requested_amount_minor, requested_tenure_days, purpose_code, status)
         values ($1, 'personal', 2000000, 365, 'education', 'submitted') returning id`,
          [borrower],
        )
      ).rows[0]?.id;
      const application = (
        await admin.query<{ id: string }>(
          `insert into lending.applications (lender_org_id, loan_request_id, borrower_id, product_version_id, status, requested_amount_minor, requested_tenure_days, lender_reference)
         values ($1, $2, $3, $4, 'disbursed', 2000000, 365, $5) returning id`,
          [
            lender,
            request,
            borrower,
            version,
            lender === ids.lenderA ? '=HYPERLINK("x")' : 'B-REF-1',
          ],
        )
      ).rows[0]?.id;
      const loan = (
        await admin.query<{ id: string }>(
          `insert into servicing.loan_accounts (lender_org_id, application_id, borrower_id, source_system, lms_loan_ref, sanctioned_amount_minor, disbursed_amount_minor, disbursed_at, disbursement_reference)
         values ($1, $2, $3, 'lender_lms', $4, 2000000, 2000000, now(), 'UTR-IT-1') returning id`,
          [lender, application, borrower, `LN-${code}`],
        )
      ).rows[0]?.id;
      await admin.query(
        `insert into payments.payment_intents (lender_org_id, loan_account_id, borrower_id, purpose, amount_minor, settlement_account_ref, provider, idempotency_key)
         values ($1, $2, $3, 'installment', 175000, 'masked-ref', 'mock_gateway', $4)`,
        [lender, loan, borrower, `idem-${code}-${randomUUID()}`],
      );
      const snap = (
        await admin.query<{ id: string }>(
          `insert into servicing.schedule_snapshots (lender_org_id, loan_account_id, version) values ($1, $2, 1) returning id`,
          [lender, loan],
        )
      ).rows[0]?.id;
      await admin.query(
        `insert into servicing.schedule_installments (snapshot_id, lender_org_id, seq, due_date, principal_minor, interest_minor) values ($1, $2, 1, current_date + 30, 150000, 25000)`,
        [snap, lender],
      );
    }
    app = await buildApp(loadConfig({ APP_ENV: 'test' }), {
      auth: { verifier: fakeVerifier, context: createUserContext(apiPool) },
    });
  });

  afterAll(async () => {
    await app?.close();
    await apiPool?.end();
    await admin?.end();
  });

  describe('product configuration', () => {
    let productId = '';
    let versionId = '';

    it('describes what can be configured', async () => {
      const res = await get('/v1/lender/product-config-schema', ids.aAdmin);
      expect(res.statusCode).toBe(200);
      expect(res.json<{ eligibilityFields: string[] }>().eligibilityFields).toContain(
        'monthly_income_minor',
      );
    });

    it("lets the lender draft a customised product but not another lender's", async () => {
      const created = await post('/v1/lender/products', ids.aAdmin, {
        lenderId: ids.lenderA,
        categoryKey: 'personal',
        code: `EVERY-${randomUUID().slice(0, 6).toUpperCase()}`,
        name: 'Everyday Personal Loan',
      });
      expect(created.statusCode).toBe(201);
      productId = created.json<{ id: string }>().id;
      expect(
        (
          await post('/v1/lender/products', ids.bAdmin, {
            lenderId: ids.lenderA,
            categoryKey: 'personal',
            code: 'HIJACK',
            name: 'Nope',
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (await post(`/v1/lender/products/${productId}/versions`, ids.bAdmin, { terms, config }))
          .statusCode,
      ).toBe(404);
      const v = await post(`/v1/lender/products/${productId}/versions`, ids.aAdmin, {
        terms,
        config,
      });
      expect(v.statusCode).toBe(201);
      versionId = v.json<{ id: string }>().id;
    });

    it('validates the configuration strictly', async () => {
      const bad = (cfg: unknown) =>
        post(`/v1/lender/products/${productId}/versions`, ids.aAdmin, { terms, config: cfg });
      expect(
        (
          await bad({
            fees: [
              {
                code: 'x1',
                label: 'Flat without amount',
                kind: 'flat',
                taxIncluded: false,
                timing: 'at_disbursement',
              },
            ],
          })
        ).statusCode,
      ).toBe(422);
      expect(
        (await bad({ eligibility: { rules: [{ field: 'age_years', operator: 'in', value: 5 }] } }))
          .statusCode,
      ).toBe(422);
      expect((await bad({ surprise: true })).statusCode).toBe(422);
      expect(
        (
          await post(`/v1/lender/products/${productId}/versions`, ids.aAdmin, {
            terms: { ...terms, minAmountMinor: 9_000_000_000 },
            config,
          })
        ).statusCode,
      ).toBe(422);
    });

    it('returns the configuration exactly as stored', async () => {
      const list = await get(`/v1/lender/products?lenderId=${ids.lenderA}`, ids.aAdmin);
      const product = list
        .json<{
          items: {
            id: string;
            versions: {
              id: string;
              status: string;
              config: { fees: unknown[]; attributes: Record<string, unknown> };
            }[];
          }[];
        }>()
        .items.find((p) => p.id === productId);
      expect(product?.versions[0]).toMatchObject({ id: versionId, status: 'draft' });
      expect(product?.versions[0]?.config.fees).toHaveLength(1);
      expect(product?.versions[0]?.config.attributes).toEqual({ internal_code: 'PL-01' });
    });

    it('needs a different person to approve, and freezes the approved version', async () => {
      expect(
        (await post(`/v1/lender/product-versions/${versionId}/submit`, ids.aAdmin)).statusCode,
      ).toBe(200);
      const self = await post(`/v1/lender/product-versions/${versionId}/decision`, ids.aAdmin, {
        approve: true,
      });
      expect(self.statusCode).toBe(403);
      const viewer = await post(`/v1/lender/product-versions/${versionId}/decision`, ids.aViewer, {
        approve: true,
      });
      expect(viewer.statusCode).toBe(403);
      expect(
        (
          await post(`/v1/lender/product-versions/${versionId}/decision`, ids.aApprover, {
            approve: true,
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await post(`/v1/lender/product-versions/${versionId}/draft`, ids.aAdmin, {
            terms,
            config,
          })
        ).statusCode,
      ).toBe(409);
      expect(
        (await post(`/v1/lender/product-versions/${versionId}/submit`, ids.aAdmin)).statusCode,
      ).toBe(409);
    });

    it('activates a product only with an approved version and by an approver', async () => {
      expect(
        (await post(`/v1/lender/products/${productId}/status`, ids.aAdmin, { to: 'active' }))
          .statusCode,
      ).toBe(403);
      expect(
        (await post(`/v1/lender/products/${productId}/status`, ids.aApprover, { to: 'active' }))
          .statusCode,
      ).toBe(200);
      const empty = await post('/v1/lender/products', ids.aAdmin, {
        lenderId: ids.lenderA,
        categoryKey: 'personal',
        code: `EMPTY-${randomUUID().slice(0, 6).toUpperCase()}`,
        name: 'No versions',
      });
      const res = await post(
        `/v1/lender/products/${empty.json<{ id: string }>().id}/status`,
        ids.aApprover,
        { to: 'active' },
      );
      expect(res.statusCode).toBe(409);
      expect(res.json<{ code: string }>().code).toBe('no_approved_version');
    });

    it('does not show an active, approved product to borrowers while the lender is not live', async () => {
      const r = await admin.query(
        'select 1 from lending.borrower_visible_product_versions where product_id = $1',
        [productId],
      );
      expect(r.rowCount).toBe(0);
    });
  });

  describe('transactions panel', () => {
    it('shows each lender only its own applications, loan accounts and payments', async () => {
      const a = await get(`/v1/lender/transactions?lenderId=${ids.lenderA}`, ids.aViewer);
      expect(a.statusCode).toBe(200);
      const items = a.json<{ items: { kind: string; lenderOrgId: string }[] }>().items;
      expect(new Set(items.map((i) => i.kind))).toEqual(
        new Set(['application', 'loan_account', 'payment']),
      );
      expect(items.every((i) => i.lenderOrgId === ids.lenderA)).toBe(true);
      const cross = await get(`/v1/lender/transactions?lenderId=${ids.lenderA}`, ids.bAdmin);
      expect(cross.statusCode).toBe(403);
      const b = await get('/v1/lender/transactions', ids.bAdmin);
      expect(
        b
          .json<{ items: { lenderOrgId: string }[] }>()
          .items.every((i) => i.lenderOrgId === ids.lenderB),
      ).toBe(true);
      const platform = await get('/v1/lender/transactions?limit=100', ids.ops);
      expect(
        new Set(
          platform.json<{ items: { lenderOrgId: string }[] }>().items.map((i) => i.lenderOrgId),
        ).size,
      ).toBeGreaterThanOrEqual(2);
    });

    it('returns no borrower identity', async () => {
      const res = await get(`/v1/lender/transactions?lenderId=${ids.lenderA}`, ids.aViewer);
      expect(res.body).not.toMatch(/borrower|phone|\+91|masked-ref/i);
    });

    it('filters, pages and sorts', async () => {
      const q = `lenderId=${ids.lenderA}&kinds=payment,loan_account&statuses=created,active&minAmountMinor=100000`;
      const filtered = await get(`/v1/lender/transactions?${q}`, ids.aViewer);
      expect(
        filtered
          .json<{ items: { kind: string }[] }>()
          .items.map((i) => i.kind)
          .sort(),
      ).toEqual(['loan_account', 'payment']);
      const p1 = await get(`/v1/lender/transactions?lenderId=${ids.lenderA}&limit=2`, ids.aViewer);
      const page1 = p1.json<{ items: { id: string }[]; nextCursor: string | null }>();
      expect(page1.items).toHaveLength(2);
      expect(page1.nextCursor).toBeTruthy();
      const p2 = await get(
        `/v1/lender/transactions?lenderId=${ids.lenderA}&limit=2&cursor=${page1.nextCursor ?? ''}`,
        ids.aViewer,
      );
      const page2 = p2.json<{ items: { id: string }[] }>();
      expect(page2.items).toHaveLength(1);
      expect(page2.items[0]?.id).not.toBe(page1.items[0]?.id);
      expect((await get('/v1/lender/transactions?cursor=garbage', ids.aViewer)).statusCode).toBe(
        400,
      );
      expect((await get('/v1/lender/transactions?kinds=nonsense', ids.aViewer)).statusCode).toBe(
        422,
      );
      expect((await get('/v1/lender/transactions?q=ab', ids.aViewer)).statusCode).toBe(422);
      const asc = await get(
        `/v1/lender/transactions?lenderId=${ids.lenderA}&order=asc`,
        ids.aViewer,
      );
      expect(asc.statusCode).toBe(200);
    });

    it('treats search text as data, not as SQL or wildcards', async () => {
      const res = await get(
        `/v1/lender/transactions?lenderId=${ids.lenderA}&q=${encodeURIComponent("%' or 1=1 --")}`,
        ids.aViewer,
      );
      expect(res.statusCode).toBe(200);
      expect(res.json<{ items: unknown[] }>().items).toHaveLength(0);
    });

    it('summarises with exact integer paise', async () => {
      const res = await get(
        `/v1/lender/transactions/summary?lenderId=${ids.lenderA}&groupBy=kind`,
        ids.aViewer,
      );
      const rows = res.json<{ items: { key: string; count: number; totalAmountMinor: string }[] }>()
        .items;
      expect(rows.find((r) => r.key === 'payment')).toEqual({
        key: 'payment',
        count: 1,
        totalAmountMinor: '175000',
      });
      const byMonth = await get(
        `/v1/lender/transactions/summary?lenderId=${ids.lenderA}&groupBy=month`,
        ids.aViewer,
      );
      expect(byMonth.statusCode).toBe(200);
    });

    it('exports CSV with chosen columns, neutralises formulas and audits the export', async () => {
      const res = await get(
        `/v1/lender/transactions/export?lenderId=${ids.lenderA}&kinds=application&columns=kind,reference,amountMinor`,
        ids.aViewer,
      );
      expect(res.statusCode).toBe(200);
      const body = res.json<{ csv: string; rows: number; truncated: boolean }>();
      expect(body.rows).toBe(1);
      expect(body.csv.split('\r\n')[0]).toBe('Type,Reference,Amount (paise)');
      expect(body.csv).toContain(`"'=HYPERLINK(""x"")"`);
      const audited = await admin.query(
        `select metadata from audit.events where action = 'lending.transactions.export' and tenant_org_id = $1`,
        [ids.lenderA],
      );
      expect(audited.rowCount).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(audited.rows[0])).not.toContain('HYPERLINK');
    });

    it('shows one record in detail', async () => {
      const list = await get(
        `/v1/lender/transactions?lenderId=${ids.lenderA}&kinds=loan_account`,
        ids.aViewer,
      );
      const loan = list.json<{ items: { id: string }[] }>().items[0];
      const d = await get(`/v1/lender/transactions/loan_account/${loan?.id ?? ''}`, ids.aViewer);
      expect(d.statusCode).toBe(200);
      expect(d.json<{ schedule: { totalMinor: string }[] }>().schedule[0]?.totalMinor).toBe(
        '175000',
      );
      expect(
        (await get(`/v1/lender/transactions/loan_account/${loan?.id ?? ''}`, ids.bAdmin))
          .statusCode,
      ).toBe(404);
    });

    it('saves, shares and isolates views', async () => {
      const made = await post('/v1/lender/panel-views', ids.aAdmin, {
        lenderId: ids.lenderA,
        name: 'Payments only',
        shared: true,
        config: {
          kinds: ['payment'],
          columns: ['occurredAt', 'status', 'amountMinor'],
          order: 'asc',
          range: 'last_30_days',
        },
      });
      expect(made.statusCode).toBe(201);
      const seen = await get(`/v1/lender/panel-views?lenderId=${ids.lenderA}`, ids.aViewer);
      expect(seen.json<{ items: { name: string; mine: boolean }[] }>().items).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'Payments only', mine: false })]),
      );
      expect(
        (await get('/v1/lender/panel-views', ids.bAdmin)).json<{ items: unknown[] }>().items,
      ).toHaveLength(0);
      const id = made.json<{ id: string }>().id;
      expect(
        (await post(`/v1/lender/panel-views/${id}`, ids.aViewer, { name: 'Hijack' })).statusCode,
      ).toBe(404);
      expect(
        (await post(`/v1/lender/panel-views/${id}`, ids.aAdmin, { archive: true })).statusCode,
      ).toBe(200);
      expect(
        (
          await post('/v1/lender/panel-views', ids.bAdmin, {
            lenderId: ids.lenderA,
            name: 'Cross',
            config: {},
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await post('/v1/lender/panel-views', ids.aAdmin, {
            lenderId: ids.lenderA,
            name: 'Bad',
            config: { columns: ['borrowerPhone'] },
          })
        ).statusCode,
      ).toBe(422);
    });
  });

  describe('accounting waiver option (D-33)', () => {
    it('is off by default, switched on only by compliance, and needs two people', async () => {
      await post('/v1/onboarding/lenders', ids.mgr, {
        lenderOrgId: ids.lenderB,
        categoryKey: 'nbfc_icc',
        registrationNo: 'IT-W-B',
        licenceStatus: 'active',
      });
      const reason = 'The accounting review will follow after go-live under an agreed plan.';
      const off = await post(`/v1/onboarding/lenders/${ids.lenderB}/accounting-waivers`, ids.mgr, {
        reason,
      });
      expect(off.statusCode).toBe(409);
      expect(off.json<{ code: string }>().code).toBe('waiver_not_allowed');
      expect(
        (
          await post('/v1/onboarding/settings/accounting_waiver_allowed', ids.apr, {
            value: true,
            reason: 'Owner decision on pilot lenders',
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await post('/v1/onboarding/settings/accounting_waiver_allowed', ids.cmp, {
            value: true,
            reason: 'Owner decision on pilot lenders, case by case',
          })
        ).statusCode,
      ).toBe(200);
      const req = await post(`/v1/onboarding/lenders/${ids.lenderB}/accounting-waivers`, ids.mgr, {
        reason,
      });
      expect(req.statusCode).toBe(201);
      const id = req.json<{ id: string }>().id;
      expect(
        (await post(`/v1/onboarding/accounting-waivers/${id}/decision`, ids.mgr, { approve: true }))
          .statusCode,
      ).toBe(403);
      expect(
        (
          await post(`/v1/onboarding/accounting-waivers/${id}/decision`, ids.apr, {
            approve: true,
            note: 'Accepted',
          })
        ).statusCode,
      ).toBe(200);
      const cond = await get(
        `/v1/onboarding/lenders/${ids.lenderB}/gate/conditions?target=production_ready_approved`,
        ids.mgr,
      );
      expect(
        cond
          .json<{ items: { key: string; satisfied: boolean }[] }>()
          .items.find((i) => i.key === 'accounting_profile_verified')?.satisfied,
      ).toBe(true);
      await post('/v1/onboarding/settings/accounting_waiver_allowed', ids.cmp, {
        value: false,
        reason: 'Pilot finished, waivers no longer allowed',
      });
    });
  });
});
