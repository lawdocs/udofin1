// Lender onboarding through the real HTTP app against a real migrated Postgres (same gating as
// api.integration.test.ts). Uses synthetic data and the development-only local document store.
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalDocumentStore } from '@udofin/adapters';
import {
  ACCOUNTING_FRAMEWORKS,
  ACCOUNTING_STATUSES,
  APPLICABILITY_BASES,
  CONFIRMATION_SOURCES,
  CONTRACT_TYPES,
  GATE_STAGES,
  IND_AS_APPLICABILITY,
  IND_AS_IMPLEMENTATION,
  INTEGRATION_STATUSES,
  REQUIREMENT_STATUSES,
  SERVICE_STATUSES,
  STATEMENT_SCOPES,
} from '@udofin/contracts';
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
const token = (user: string, aal: 'aal1' | 'aal2' = 'aal2') => ({
  authorization: `Bearer test.${user}.${aal}`,
});
let nextAddress = 1;
const freshAddress = () => `10.7.${(nextAddress >> 8) & 255}.${nextAddress++ & 255}`;

const PDF = Buffer.from('%PDF-1.4\n% synthetic test document\n').toString('base64');

describe.skipIf(!enabled)('lender onboarding over HTTP', () => {
  const ids = {
    platformOrg: randomUUID(),
    lenderA: randomUUID(),
    lenderB: randomUUID(),
    manager: randomUUID(),
    approver: randomUUID(),
    both: randomUUID(),
    aAdmin: randomUUID(),
    bAdmin: randomUUID(),
  };
  let admin: pg.Pool;
  let apiPool: pg.Pool;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let dir: string;

  const call = (
    method: 'GET' | 'POST',
    url: string,
    user: string,
    payload?: unknown,
    key: string | null = method === 'POST' ? `it-${randomUUID()}` : null,
  ) =>
    app.inject({
      method,
      url,
      remoteAddress: freshAddress(),
      headers: { ...token(user), ...(key ? { 'idempotency-key': key } : {}) },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  const post = (url: string, user: string, payload: unknown = {}, key?: string) =>
    call('POST', url, user, payload, key);
  const get = (url: string, user: string) => call('GET', url, user);

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: ADMIN, max: 2 });
    apiPool = new pg.Pool({ connectionString: API, max: 8 });
    dir = await mkdtemp(join(tmpdir(), 'udofin-onb-'));

    for (const id of [ids.manager, ids.approver, ids.both, ids.aAdmin, ids.bAdmin]) {
      await admin.query(
        `insert into auth.users (id, phone, raw_app_meta_data) values ($1, null, '{"actor_type":"staff"}')`,
        [id],
      );
    }
    const existing = await admin.query<{ id: string }>(
      `select id from tenancy.organizations where kind = 'platform'`,
    );
    if (existing.rows[0]) ids.platformOrg = existing.rows[0].id as typeof ids.platformOrg;
    else {
      await admin.query(
        `insert into tenancy.organizations (id, kind, legal_name, display_name, status)
         values ($1, 'platform', 'Udofin Platform (it)', 'Udofin', 'active')`,
        [ids.platformOrg],
      );
    }
    await admin.query(
      `insert into tenancy.organizations (id, kind, legal_name, display_name, regulator_registration_no, status) values
        ($1, 'lender', 'Onboarding Alpha IT Ltd', 'Alpha', 'IT-ONB-A', 'onboarding'),
        ($2, 'lender', 'Onboarding Beta IT Ltd', 'Beta', 'IT-ONB-B', 'onboarding')`,
      [ids.lenderA, ids.lenderB],
    );
    const members: [string, string, string[]][] = [
      [ids.platformOrg, ids.manager, ['onboarding_manager']],
      [ids.platformOrg, ids.approver, ['onboarding_approver']],
      [ids.platformOrg, ids.both, ['onboarding_manager', 'onboarding_approver']],
      [ids.lenderA, ids.aAdmin, ['lender_admin']],
      [ids.lenderB, ids.bAdmin, ['lender_admin']],
    ];
    for (const [org, user, roles] of members) {
      const m = await admin.query<{ id: string }>(
        'insert into tenancy.memberships (org_id, user_id, status) values ($1, $2, $3) returning id',
        [org, user, 'active'],
      );
      for (const role of roles) {
        await admin.query(
          `insert into tenancy.membership_roles (membership_id, role_id)
           select $1, r.id from tenancy.roles r join tenancy.organizations o on o.kind = r.applies_to
            where o.id = $2 and r.org_id is null and r.key = $3`,
          [m.rows[0]?.id, org, role],
        );
      }
    }
    app = await buildApp(loadConfig({ APP_ENV: 'test' }), {
      auth: { verifier: fakeVerifier, context: createUserContext(apiPool) },
      documents: createLocalDocumentStore(dir, 'test'),
    });
  });

  afterAll(async () => {
    await app?.close();
    await apiPool?.end();
    await admin?.end();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  let docA = '';

  it('keeps the wire enumerations aligned with the database constraints', async () => {
    const pairs: [string, string, readonly string[]][] = [
      ['accounting_profiles', 'accounting_framework', ACCOUNTING_FRAMEWORKS],
      ['accounting_profiles', 'ind_as_applicability', IND_AS_APPLICABILITY],
      ['accounting_profiles', 'ind_as_implementation_status', IND_AS_IMPLEMENTATION],
      ['accounting_profiles', 'applicability_basis', APPLICABILITY_BASES],
      ['accounting_profiles', 'statement_scope', STATEMENT_SCOPES],
      ['accounting_profiles', 'confirmation_source', CONFIRMATION_SOURCES],
      ['accounting_profiles', 'status', ACCOUNTING_STATUSES],
      ['service_versions', 'status', SERVICE_STATUSES],
      ['lender_requirements', 'status', REQUIREMENT_STATUSES],
      ['integrations', 'status', INTEGRATION_STATUSES],
      ['lender_contracts', 'contract_type', CONTRACT_TYPES],
      ['lender_gates', 'stage', GATE_STAGES],
    ];
    for (const [table, column, expected] of pairs) {
      const r = await admin.query<{ def: string }>(
        `select pg_get_constraintdef(c.oid) as def from pg_constraint c
          where c.conrelid = ('onboarding.' || $1)::regclass and c.contype = 'c'
            and pg_get_constraintdef(c.oid) like 'CHECK ((' || $2 || ' = ANY%'`,
        [table, column],
      );
      const values = new Set(
        r.rows.flatMap((row) => [...row.def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1] ?? '')),
      );
      expect([...values].sort(), `${table}.${column}`).toEqual([...expected].sort());
    }
  });

  it('lists categories for several institution types from one module', async () => {
    const res = await get('/v1/onboarding/institution-categories', ids.manager);
    expect(res.statusCode).toBe(200);
    const items = res.json<{ items: { key: string; activationAllowed: boolean }[] }>().items;
    expect(items.find((c) => c.key === 'nbfc_icc')?.activationAllowed).toBe(true);
    expect(items.find((c) => c.key === 'bank_commercial')?.activationAllowed).toBe(false);
    expect(items.find((c) => c.key === 'ucb_scheduled')?.activationAllowed).toBe(false);
  });

  it('only Udofin onboarding managers create a profile; a lender is refused', async () => {
    const body = {
      lenderOrgId: ids.lenderA,
      categoryKey: 'nbfc_icc',
      registrationNo: 'IT-REG-A',
      licenceStatus: 'active',
    };
    expect((await post('/v1/onboarding/lenders', ids.aAdmin, body)).statusCode).toBe(403);
    expect((await post('/v1/onboarding/lenders', ids.approver, body)).statusCode).toBe(403);
    expect((await post('/v1/onboarding/lenders', ids.manager, body)).statusCode).toBe(201);
    const b = {
      lenderOrgId: ids.lenderB,
      categoryKey: 'bank_commercial',
      registrationNo: 'IT-REG-B',
      licenceStatus: 'active',
    };
    expect((await post('/v1/onboarding/lenders', ids.manager, b)).statusCode).toBe(201);
  });

  it('replays an idempotent request and refuses a changed body for the same key', async () => {
    const key = `it-${randomUUID()}`;
    const body = {
      categoryKey: 'lead_generation',
      title: 'Idempotent lead service',
      requestedScope: 'Leads please',
    };
    const first = await post(
      `/v1/onboarding/lenders/${ids.lenderB}/services`,
      ids.bAdmin,
      body,
      key,
    );
    const again = await post(
      `/v1/onboarding/lenders/${ids.lenderB}/services`,
      ids.bAdmin,
      body,
      key,
    );
    expect(first.statusCode).toBe(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json()).toEqual(first.json());
    const changed = await post(
      `/v1/onboarding/lenders/${ids.lenderB}/services`,
      ids.bAdmin,
      { ...body, title: 'Other' },
      key,
    );
    expect(changed.statusCode).toBe(422);
    expect(changed.json<{ code: string }>().code).toBe('idempotency_key_reused');
  });

  it('keeps lenders apart', async () => {
    const own = await get(`/v1/onboarding/lenders/${ids.lenderA}`, ids.aAdmin);
    expect(own.statusCode).toBe(200);
    expect(own.json<{ profile: { verificationStatus: string } }>().profile.verificationStatus).toBe(
      'unverified',
    );
    expect((await get(`/v1/onboarding/lenders/${ids.lenderB}`, ids.aAdmin)).statusCode).toBe(404);
    expect(
      (await get(`/v1/onboarding/lenders/${ids.lenderB}/services`, ids.aAdmin)).statusCode,
    ).toBe(403);
    expect(
      (await get(`/v1/onboarding/lenders/${ids.lenderB}/accounting-profiles`, ids.aAdmin))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await post(`/v1/onboarding/lenders/${ids.lenderB}/services`, ids.aAdmin, {
          categoryKey: 'reporting',
          title: 'Hijack',
        })
      ).statusCode,
    ).toBe(403);
    const list = await get('/v1/onboarding/lenders', ids.aAdmin);
    expect(
      list.json<{ items: { lenderOrgId: string }[] }>().items.map((l) => l.lenderOrgId),
    ).toEqual([ids.lenderA]);
  });

  it('stores a private document, checks its type, and serves it only to authorised readers', async () => {
    const up = await post(`/v1/onboarding/lenders/${ids.lenderA}/documents`, ids.aAdmin, {
      purpose: 'licence',
      label: 'Licence copy (synthetic)',
      mimeType: 'application/pdf',
      contentBase64: PDF,
    });
    expect(up.statusCode).toBe(201);
    docA = up.json<{ id: string }>().id;
    const bad = await post(`/v1/onboarding/lenders/${ids.lenderA}/documents`, ids.aAdmin, {
      purpose: 'licence',
      label: 'Not a PDF',
      mimeType: 'application/pdf',
      contentBase64: Buffer.from('hello this is not a pdf').toString('base64'),
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json<{ code: string }>().code).toBe('document_type_mismatch');

    const own = await get(`/v1/onboarding/documents/${docA}/content`, ids.aAdmin);
    expect(own.statusCode).toBe(200);
    expect(own.json<{ contentBase64: string }>().contentBase64).toBe(PDF);
    expect((await get(`/v1/onboarding/documents/${docA}/content`, ids.bAdmin)).statusCode).toBe(
      404,
    );
    const audited = await admin.query(
      `select 1 from audit.events where action = 'onboarding.documents.download' and entity_id = $1`,
      [docA],
    );
    expect(audited.rowCount).toBeGreaterThanOrEqual(1);
  });

  it('refuses secret-like text with a stable code', async () => {
    const res = await post(`/v1/onboarding/lenders/${ids.lenderA}/services`, ids.aAdmin, {
      categoryKey: 'technology_api_integration',
      title: 'API integration',
      requestedScope: 'our api_key = sk_live_abcdef123456',
    });
    expect(res.statusCode).toBe(422);
    expect(res.json<{ code: string }>().code).toBe('unsafe_free_text');
  });

  it('verifies the institution only through an independent reviewer', async () => {
    const submit = await post(
      `/v1/onboarding/lenders/${ids.lenderA}/verification/submit`,
      ids.aAdmin,
      { evidenceDocumentId: docA },
    );
    expect(submit.statusCode).toBe(200);
    // The manager edits the profile (a contributor) and holds both roles: still cannot verify.
    expect(
      (
        await post(`/v1/onboarding/lenders/${ids.lenderA}/profile`, ids.both, {
          notes: 'edited by reviewer',
        })
      ).statusCode,
    ).toBe(200);
    const self = await post(
      `/v1/onboarding/lenders/${ids.lenderA}/verification/decision`,
      ids.both,
      { approve: true, note: 'ok' },
    );
    expect(self.statusCode).toBe(403);
    expect(self.json<{ code: string }>().code).toBe('self_approval');
    expect(
      (
        await post(`/v1/onboarding/lenders/${ids.lenderA}/verification/decision`, ids.manager, {
          approve: true,
        })
      ).statusCode,
    ).toBe(403);
    const ok = await post(
      `/v1/onboarding/lenders/${ids.lenderA}/verification/decision`,
      ids.approver,
      { approve: true, note: 'Evidence checked (synthetic)' },
    );
    expect(ok.statusCode).toBe(200);
    const history = await get(
      `/v1/onboarding/lenders/${ids.lenderA}/verification-history`,
      ids.aAdmin,
    );
    expect(history.json<{ items: unknown[] }>().items.length).toBeGreaterThanOrEqual(3);
  });

  it('keeps Ind AS applicability and implementation separate and never verifies an unconfirmed record', async () => {
    const draft = await post(
      `/v1/onboarding/lenders/${ids.lenderA}/accounting-profiles`,
      ids.aAdmin,
      {
        indAsApplicability: 'under_assessment',
        indAsImplementationStatus: 'in_progress',
        netWorthPaise: '50000000000',
        netWorthMeasuredOn: '2026-03-31',
        netWorthFy: '2025-26',
      },
    );
    expect(draft.statusCode).toBe(200);
    const id = draft.json<{ id: string }>().id;
    const list = await get(`/v1/onboarding/lenders/${ids.lenderA}/accounting-profiles`, ids.aAdmin);
    const v1 = list.json<{
      items: {
        id: string;
        accountingFramework: string;
        indAsApplicability: string;
        indAsImplementationStatus: string;
        netWorthPaise: string;
      }[];
    }>().items[0];
    expect(v1).toMatchObject({
      id,
      accountingFramework: 'to_be_confirmed',
      indAsApplicability: 'under_assessment',
      indAsImplementationStatus: 'in_progress',
      netWorthPaise: '50000000000',
    });
    expect(
      (await post(`/v1/onboarding/accounting-profiles/${id}/submit`, ids.aAdmin)).statusCode,
    ).toBe(200);
    const noEvidence = await post(
      `/v1/onboarding/accounting-profiles/${id}/decision`,
      ids.approver,
      { approve: true, note: 'looks fine' },
    );
    expect(noEvidence.statusCode).toBe(409);
    expect(noEvidence.json<{ code: string }>().code).toBe('evidence_required');
    expect(
      (
        await post(`/v1/onboarding/accounting-profiles/${id}/decision`, ids.aAdmin, {
          approve: true,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await post(`/v1/onboarding/accounting-profiles/${id}/decision`, ids.approver, {
          approve: false,
          note: 'Evidence is missing',
        })
      ).statusCode,
    ).toBe(200);
  });

  it('moves services from requested to agreed to active only with both sides and an independent activator', async () => {
    const created = await post(`/v1/onboarding/lenders/${ids.lenderA}/services`, ids.aAdmin, {
      categoryKey: 'lead_generation',
      title: 'Lead generation',
      requestedScope: 'Qualified personal-loan leads',
    });
    expect(created.statusCode).toBe(201);
    const serviceId = created.json<{ id: string }>().id;
    const listed = await get(`/v1/onboarding/lenders/${ids.lenderA}/services`, ids.aAdmin);
    const version = listed
      .json<{
        items: {
          id: string;
          versions: { id: string; status: string; agreedScope: string | null }[];
        }[];
      }>()
      .items.find((s) => s.id === serviceId)?.versions[0];
    expect(version).toMatchObject({ status: 'proposed', agreedScope: null });
    const versionId = version?.id ?? '';

    const noScope = await post(`/v1/onboarding/service-versions/${versionId}/agree`, ids.aAdmin);
    expect(noScope.json<{ code: string }>().code).toBe('agreed_scope_required');

    const shared = await post(`/v1/onboarding/services/${serviceId}/revise`, ids.manager, {
      proposedScope: 'Udofin sources leads',
      agreedScope: 'Udofin sources leads; the lender decides on every application',
      responsibleParty: 'shared',
    });
    expect(shared.statusCode).toBe(409); // shared without an allocation
    const revised = await post(`/v1/onboarding/services/${serviceId}/revise`, ids.manager, {
      proposedScope: 'Udofin sources leads',
      agreedScope: 'Udofin sources leads; the lender decides on every application',
      responsibleParty: 'shared',
      sharedAllocation:
        'Udofin runs the journey and consent; the lender owns eligibility and decisions',
    });
    expect(revised.statusCode).toBe(200);

    expect(
      (await post(`/v1/onboarding/service-versions/${versionId}/agree`, ids.aAdmin)).json<{
        status: string;
      }>().status,
    ).toBe('under_discussion');
    expect(
      (await post(`/v1/onboarding/service-versions/${versionId}/agree`, ids.manager)).statusCode,
    ).toBe(403);
    const agreed = await post(`/v1/onboarding/service-versions/${versionId}/agree`, ids.approver);
    expect(agreed.json<{ status: string }>().status).toBe('agreed');
    const early = await post(`/v1/onboarding/service-versions/${versionId}/activate`, ids.both);
    expect(early.statusCode).toBe(409);
    expect(early.json<{ code: string }>().code).toBe('gate_not_met');
  });

  it('enforces gate order, readiness and two-person decisions', async () => {
    const skip = await post(`/v1/onboarding/lenders/${ids.lenderA}/gate-requests`, ids.manager, {
      targetStage: 'activated',
    });
    expect(skip.statusCode).toBe(409);
    expect(skip.json<{ code: string }>().code).toBe('gate_order');

    const cond = await get(`/v1/onboarding/lenders/${ids.lenderA}/gate/conditions`, ids.aAdmin);
    expect(
      cond.json<{ targetStage: string; items: { key: string; satisfied: boolean }[] }>()
        .targetStage,
    ).toBe('institution_verified');

    const req = await post(`/v1/onboarding/lenders/${ids.lenderA}/gate-requests`, ids.both, {
      targetStage: 'institution_verified',
    });
    expect(req.statusCode).toBe(201);
    const id = req.json<{ id: string }>().id;
    const self = await post(`/v1/onboarding/gate-requests/${id}/decision`, ids.both, {
      approve: true,
    });
    expect(self.statusCode).toBe(403);
    expect(self.json<{ code: string }>().code).toBe('self_approval');
    expect(
      (await post(`/v1/onboarding/gate-requests/${id}/decision`, ids.aAdmin, { approve: true }))
        .statusCode,
    ).toBe(403);
    const done = await post(`/v1/onboarding/gate-requests/${id}/decision`, ids.approver, {
      approve: true,
    });
    expect(done.json<{ stage: string }>().stage).toBe('institution_verified');

    // Lender B has no verified institution: the first gate is refused, naming what is missing.
    const unmet = await post(`/v1/onboarding/lenders/${ids.lenderB}/gate-requests`, ids.manager, {
      targetStage: 'institution_verified',
    });
    expect(unmet.statusCode).toBe(409);
    expect(unmet.json<{ code: string }>().code).toBe('gate_not_met');
    expect(unmet.json<{ detail: string }>().detail).toContain('institution_verified');
  });

  it('a bank-type lender cannot reach production readiness without category sign-off', async () => {
    const c = await get(
      `/v1/onboarding/lenders/${ids.lenderB}/gate/conditions?target=production_ready_approved`,
      ids.manager,
    );
    const items = c.json<{ items: { key: string; satisfied: boolean }[] }>().items;
    expect(items.find((i) => i.key === 'category_activation_allowed')?.satisfied).toBe(false);
    expect(
      (
        await post('/v1/onboarding/institution-categories/bank_commercial/signoff', ids.approver, {
          sourceRef: 'RBI direction (synthetic reference)',
        })
      ).statusCode,
    ).toBe(403);
  });

  it('answers 503 on document routes when no store is configured', async () => {
    const bare = await buildApp(loadConfig({ APP_ENV: 'test' }), {
      auth: { verifier: fakeVerifier, context: createUserContext(apiPool) },
    });
    const res = await bare.inject({
      method: 'POST',
      url: `/v1/onboarding/lenders/${ids.lenderA}/documents`,
      remoteAddress: freshAddress(),
      headers: { ...token(ids.aAdmin), 'idempotency-key': `it-${randomUUID()}` },
      payload: { purpose: 'other', label: 'x', mimeType: 'application/pdf', contentBase64: PDF },
    });
    expect(res.statusCode).toBe(503);
    await bare.close();
  });
});
