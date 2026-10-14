// Phase 07 integration tests: KFS data, rule/template/calendar approval, document generation by the worker (real PDF, private
// store), lender approval and issuance, acknowledgement, offer acceptance bound to a step-up code, the agreement with its KFS
// summary box, the signing boundary (labelled mock) and access evidence, over HTTP against a REAL migrated Postgres.
// No real signing, SMS or lender provider exists; mocks are labelled. Runs only when the INTEGRATION_* URLs are set.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createLocalDocumentStore,
  createMockLenderConnector,
  createMockSigningProvider,
  createMockSmsSender,
  createMockIntegrityVerifier,
  type MockSigningScript,
} from '@udofin/adapters';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { TokenError, type TokenVerifier } from '../../src/auth/token-verifier.js';
import { loadConfig } from '../../src/config.js';
import { createUserContext } from '../../src/db/user-context.js';
import { createBorrowerProcessor } from '../../src/system/borrower.js';
import { createChangeRequestApplier } from '../../src/system/change-requests.js';
import { createDocumentProcessor, type DocumentProcessor } from '../../src/system/documents.js';
import { createSystemPool, type SystemPool } from '../../src/system/pool.js';
import { createRoutingProcessor } from '../../src/system/routing.js';
import { createHandlers } from '../../src/workers/handlers.js';
import { type OutboxEvent } from '../../src/workers/outbox-worker.js';
import { createConnectorResolver } from '../../src/workers/routing-handlers.js';
import { sampleKfsData } from './kfs-fixture.js';

const ADMIN = process.env.INTEGRATION_ADMIN_URL;
const API = process.env.INTEGRATION_API_URL;
const SYSTEM = process.env.INTEGRATION_SYSTEM_URL;
const enabled = Boolean(ADMIN && API && SYSTEM);
const PEPPER = randomBytes(24).toString('hex');

const fakeVerifier: TokenVerifier = {
  verify(header) {
    const match = /^Bearer test\.([0-9a-f-]{36})\.(aal1|aal2)$/.exec(header ?? '');
    if (!match?.[1] || !match[2]) return Promise.reject(new TokenError('invalid'));
    return Promise.resolve({ sub: match[1], aal: match[2] as 'aal1' | 'aal2', sessionId: null });
  },
};
let nextAddress = 1;
const freshAddress = () => `10.7.${(nextAddress >> 8) & 255}.${nextAddress++ & 255}`;
const phone = () => `91${Math.floor(1_000_000_000 + Math.random() * 8_999_999_999)}`;
const ref = () =>
  Array.from(randomBytes(10), (b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');
const ALL_SECTIONS = ['part1', 'apr_sheet', 'schedule', 'part2'];

describe.skipIf(!enabled)(
  'documents, acknowledgement and acceptance over HTTP against a real database',
  () => {
    const ids = {
      b1: randomUUID(),
      b2: randomUUID(),
      lenderA: randomUUID(),
      lenderB: randomUUID(),
      aPrep: randomUUID(),
      aApprover: randomUUID(),
      bOfficer: randomUUID(),
      drafter: randomUUID(),
      approver: randomUUID(),
      p1: randomUUID(),
      p2: randomUUID(),
      platformOrg: randomUUID() as string,
      req1: randomUUID(),
      req2: randomUUID(),
      appA: randomUUID(),
      appB: randomUUID(),
      offerA: randomUUID(),
      offerB: randomUUID(),
    };
    const phones = { b1: phone(), b2: phone() };
    const sms = createMockSmsSender('test');
    let signingScript: MockSigningScript = 'timeout';
    const signing = createMockSigningProvider('test', () => signingScript);
    const dir = mkdtempSync(join(tmpdir(), 'udofin-docs-'));
    const store = createLocalDocumentStore(dir, 'test');
    let admin: pg.Pool;
    let apiPool: pg.Pool;
    let blockedPool: pg.Pool;
    let systemPool: SystemPool;
    let processor: DocumentProcessor;
    let app: Awaited<ReturnType<typeof buildApp>>;
    let blockedApp: Awaited<ReturnType<typeof buildApp>>;
    let handlers: ReturnType<typeof createHandlers>;
    let dbName = '';
    const notice = { ack: '', ackHi: '' };
    const state: Record<string, string> = {};

    const call = (
      target: typeof app,
      method: 'GET' | 'POST',
      url: string,
      user: string | null,
      payload?: unknown,
      key: string | null = method === 'POST' ? `it-${randomUUID()}` : null,
      aal: 'aal1' | 'aal2' = 'aal2',
    ) =>
      target.inject({
        method,
        url,
        remoteAddress: freshAddress(),
        headers: {
          ...(user ? { authorization: `Bearer test.${user}.${aal}` } : {}),
          ...(key ? { 'idempotency-key': key } : {}),
        },
        ...(payload === undefined ? {} : { payload: payload as object }),
      });
    const get = (url: string, user: string | null) => call(app, 'GET', url, user);
    const post = (url: string, user: string | null, payload: unknown = {}, key?: string | null) =>
      call(app, 'POST', url, user, payload, key);
    const code = (res: { json: () => unknown }) => (res.json() as { code?: string }).code;
    const run = (type: string, payload: Record<string, unknown>) =>
      handlers[type]?.run(payload, { id: randomUUID() } as OutboxEvent) ??
      Promise.reject(new Error(`no handler ${type}`));
    const q = async <T extends pg.QueryResultRow>(sql: string, values: unknown[] = []) =>
      (await admin.query<T>(sql, values)).rows;

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

    async function newOffer(offerId: string, appId: string, lender: string, host: string) {
      await admin.query(
        `insert into lending.offers (id, lender_org_id, application_id, status, principal_minor, tenure_days, installment_frequency, installment_count, installment_amount_minor,
         annual_interest_rate_bps, apr_bps, processing_fee_minor, other_charges, total_repayable_minor, penal_charges_summary, valid_until, monthly_repayment_minor,
         kfs_url, lender_offer_ref, revision, lender_issued_at, source)
       values ($1, $2, $3, 'issued', 2000000, 720, 'monthly', 24, 97000, 1500, 1707, 24000, '[]', 2327400, '2% per annum on the overdue amount',
         now() + interval '30 days', 97000, $4, $5, 1, now(), 'manual')`,
        [offerId, lender, appId, `https://${host}/k/${ref()}`, `OFFER-${ref()}`],
      );
    }

    /** Runs a freshly created job through the worker handler. */
    const runJob = (jobId: string) => run('document.generate', { job_id: jobId });

    beforeAll(async () => {
      admin = new pg.Pool({ connectionString: ADMIN, max: 3 });
      dbName = (await q<{ d: string }>('select current_database() d'))[0]?.d ?? '';
      // The database must allow the labelled mock signer for this API pool; a second pool is told NOT to.
      await admin.query(`alter database "${dbName}" set udofin.allow_mock_signing = 'on'`);
      await admin.query(`alter database "${dbName}" set udofin.allow_sample_documents = 'on'`);
      apiPool = new pg.Pool({ connectionString: API, max: 10 });
      blockedPool = new pg.Pool({
        connectionString: API,
        max: 3,
        options: '-c udofin.allow_mock_signing=off -c udofin.allow_sample_documents=off',
      });
      systemPool = createSystemPool(SYSTEM ?? '');
      processor = createDocumentProcessor(systemPool);
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
        ids.aPrep,
        ids.aApprover,
        ids.bOfficer,
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
      const existing = await q<{ id: string }>(
        `select id from tenancy.organizations where kind = 'platform'`,
      );
      if (existing[0]) ids.platformOrg = existing[0].id;
      else
        await admin.query(
          `insert into tenancy.organizations (id, kind, legal_name, display_name, status) values ($1, 'platform', 'Udofin Platform (it)', 'Udofin', 'active')`,
          [ids.platformOrg],
        );
      for (const [lender, name] of [
        [ids.lenderA, 'Alpha Documents'],
        [ids.lenderB, 'Beta Documents'],
      ] as const) {
        await admin.query(
          `insert into tenancy.organizations (id, kind, legal_name, display_name, regulator_registration_no, status) values ($1, 'lender', $2, $3, $4, 'active')`,
          [lender, `${name} Ltd`, name, `IT-DOC-${ref()}`],
        );
        await member(lender, ids.drafter, 'lender', 'lender_admin');
        await member(lender, ids.approver, 'lender', 'product_approver');
      }
      await member(ids.lenderA, ids.aPrep, 'lender', 'credit_officer');
      await member(ids.lenderA, ids.aApprover, 'lender', 'lender_admin');
      await member(ids.lenderB, ids.bOfficer, 'lender', 'credit_officer');
      await member(ids.platformOrg, ids.p1, 'platform', 'platform_admin');
      await member(ids.platformOrg, ids.p2, 'platform', 'platform_admin');
      for (const lender of [ids.lenderA, ids.lenderB]) {
        const product = randomUUID();
        await admin.query(
          `insert into lending.loan_products (id, lender_org_id, category_key, code, name, status) values ($1, $2, 'personal', 'PL-IT', $3, 'active')`,
          [product, lender, `Loan ${ref()}`],
        );
        const version = randomUUID();
        await admin.query(
          `insert into lending.loan_product_versions (id, product_id, lender_org_id, version, status, min_amount_minor, max_amount_minor, min_tenure_days, max_tenure_days, rate_type, min_annual_rate_bps, max_annual_rate_bps, drafted_by, approved_by, approved_at, effective_from)
         values ($1, $2, $3, 1, 'approved', 1000000, 50000000, 180, 1825, 'fixed', 1400, 2400, $4, $5, now(), now())`,
          [version, product, lender, ids.drafter, ids.approver],
        );
        state[`version-${lender}`] = version;
        await makeLive(lender, ids.aPrep, ids.bOfficer);
        await admin.query(
          `insert into lending.lender_connectors (lender_org_id, kind, status, kfs_allowed_hosts) values ($1, 'manual', 'active', array['kfs.example'])`,
          [lender],
        );
      }
      // Consent wording for sharing (approved), and the acknowledgement wording (English approved; Hindi not).
      for (const lender of [ids.lenderA, ids.lenderB]) {
        state[`consent-${lender}`] = randomUUID();
        await admin.query(
          `insert into consent.notices (id, purpose, version, language, lender_org_id, title, body_markdown, status, published_at, drafted_by, approved_by, review_status)
         values ($1, 'share_with_lender', 1, 'en', $2, 'Share', 'Sharing wording (test)', 'published', now(), $3, $4, 'approved')`,
          [state[`consent-${lender}`], lender, ids.drafter, ids.approver],
        );
      }
      notice.ack = randomUUID();
      notice.ackHi = randomUUID();
      await admin.query(
        `insert into consent.notices (id, purpose, version, language, lender_org_id, title, body_markdown, status, published_at, drafted_by, approved_by, review_status)
       values ($1, 'kfs_acknowledgement', (select coalesce(max(version), 0) + 1 from consent.notices where purpose = 'kfs_acknowledgement' and language = 'en' and lender_org_id is null), 'en', null,
              'KFS acknowledgement (SAMPLE WORDING)', 'SAMPLE: I read the Key Facts Statement and its contents were explained to me.', 'published', now(), $2, $3, 'approved'),
              ($4, 'kfs_acknowledgement', (select coalesce(max(version), 0) + 1 from consent.notices where purpose = 'kfs_acknowledgement' and language = 'hi' and lender_org_id is null), 'hi', null,
              'KFS acknowledgement (Hindi, unreviewed)', 'समीक्षा के लिए लंबित', 'published', now(), $2, $3, 'requires_review')`,
        [notice.ack, ids.drafter, ids.approver, notice.ackHi],
      );
      for (const [req, user] of [
        [ids.req1, ids.b1],
        [ids.req2, ids.b2],
      ] as const) {
        await admin.query(
          `insert into lending.loan_requests (id, borrower_id, category_key, requested_amount_minor, requested_tenure_days, purpose_code, status, submission_reference)
         values ($1, (select id from identity.borrowers where user_id = $2), 'personal', 2000000, 720, 'home_renovation', 'submitted', $3)`,
          [req, user, `UR-${ref()}`],
        );
      }
      // Two approved applications (A for borrower 1, B for borrower 2), each with a consent and one issued offer.
      for (const [appId, lender, req, offerId, host] of [
        [ids.appA, ids.lenderA, ids.req1, ids.offerA, 'kfs.example'],
        [ids.appB, ids.lenderB, ids.req2, ids.offerB, 'kfs.example'],
      ] as const) {
        await admin.query(
          `insert into lending.applications (id, lender_org_id, loan_request_id, borrower_id, product_version_id, status, requested_amount_minor, requested_tenure_days)
         select $1, $2, $3, borrower_id, $4, 'submitted', 2000000, 720 from lending.loan_requests where id = $3`,
          [appId, lender, req, state[`version-${lender}`]],
        );
        await admin.query(`update lending.applications set status = 'under_review' where id = $1`, [
          appId,
        ]);
        await admin.query(`update lending.applications set status = 'approved' where id = $1`, [
          appId,
        ]);
        await admin.query(
          `insert into consent.records (borrower_id, notice_id, lender_org_id, decision, channel, app_version, evidence)
         select borrower_id, $2, $3, 'granted', 'mobile_app', '1.0.0', jsonb_build_object('loan_request_id', $1::uuid, 'scope', 'minimum_payload_v1') from lending.loan_requests where id = $1`,
          [req, state[`consent-${lender}`], lender],
        );
        await newOffer(offerId, appId, lender, host);
      }
      app = await buildApp(loadConfig({ APP_ENV: 'test' }), {
        auth: { verifier: fakeVerifier, context: createUserContext(apiPool) },
        borrower: {
          sms,
          integrity: createMockIntegrityVerifier('test'),
          stepUpPepper: PEPPER,
          smsTimeoutMs: 2000,
        },
        documents: store,
        signing: { providerKey: 'mock_esign', mode: 'mock' },
      });
      blockedApp = await buildApp(loadConfig({ APP_ENV: 'test' }), {
        auth: { verifier: fakeVerifier, context: createUserContext(blockedPool) },
        borrower: {
          sms,
          integrity: createMockIntegrityVerifier('test'),
          stepUpPepper: PEPPER,
          smsTimeoutMs: 2000,
        },
        documents: store,
        signing: { providerKey: 'mock_esign', mode: 'mock' },
      });
      handlers = createHandlers({
        applier: createChangeRequestApplier(systemPool),
        borrower: createBorrowerProcessor(systemPool),
        changeRequestStatus: () => Promise.resolve(undefined),
        routing: createRoutingProcessor(systemPool),
        connectors: createConnectorResolver({
          environment: 'test',
          createMock: () => createMockLenderConnector('test'),
        }),
        documents: { processor, store, signing, sms },
      });
    });

    afterAll(async () => {
      await app?.close();
      await blockedApp?.close();
      await admin
        ?.query(`alter database "${dbName}" reset udofin.allow_mock_signing`)
        .catch(() => undefined);
      await admin
        ?.query(`alter database "${dbName}" reset udofin.allow_sample_documents`)
        .catch(() => undefined);
      await apiPool?.end();
      await blockedPool?.end();
      await systemPool?.end();
      await admin?.end();
      rmSync(dir, { recursive: true, force: true });
    });

    /** Verifies a step-up code for an action and object through the real routes, using the code the mock SMS recorded. */
    async function stepUp(user: string, action: string, contextRef: string) {
      const before = sms.sent.length;
      const started = await post('/v1/stepup/challenges', user, { action, contextRef });
      expect(started.statusCode, started.body).toBe(201);
      const { challengeId } = started.json<{ challengeId: string }>();
      const otp = sms.sent[before]?.variables.otp ?? '';
      const verified = await post(`/v1/stepup/challenges/${challengeId}/verify`, user, {
        code: otp,
      });
      expect(verified.json<{ result: string }>().result).toBe('verified');
    }

    describe('before anything is approved', () => {
      it('cannot prepare a KFS: the seeded NBFC rule is a draft and no calendar or approved template exists', async () => {
        const submitted = await post(`/v1/lender/offers/${ids.offerA}/kfs-data`, ids.aPrep, {
          mode: 'data',
          data: sampleKfsData(),
        });
        expect(submitted.statusCode, submitted.body).toBe(201);
        const { inputId, validation } = submitted.json<{ inputId: string; validation: string }>();
        expect(validation).toBe('accepted');
        state.inputA = inputId;
        const refused = await post(`/v1/lender/offers/${ids.offerA}/generation`, ids.aPrep, {
          inputId,
          language: 'en',
          documentType: 'kfs',
        });
        expect(refused.statusCode).toBe(409);
        expect(code(refused)).toBe('applicability_unresolved');
      });

      it('lists the seeded rules as drafts with no reviewer, and shows nothing to lenders', async () => {
        const rules = await get('/v1/platform/document-rules', ids.p1);
        expect(rules.statusCode, rules.body).toBe(200);
        const items = rules.json<{
          items: {
            ruleKey: string;
            approvalStatus: string;
            reviewerRef: string | null;
            lenderCategoryKeys: string[];
          }[];
        }>().items;
        expect(items.every((r) => r.approvalStatus === 'draft' && r.reviewerRef === null)).toBe(
          true,
        );
        expect(items.flatMap((r) => r.lenderCategoryKeys).sort()).toEqual([
          'nbfc_d',
          'nbfc_d',
          'nbfc_icc',
          'nbfc_icc',
        ]);
        expect(code(await get('/v1/platform/document-rules', ids.aPrep))).toBe('forbidden');
      });
    });

    describe('platform approvals (rule, template, calendar)', () => {
      it('needs a named reviewer; the reviewer is never invented', async () => {
        const rules = (await get('/v1/platform/document-rules', ids.p1)).json<{
          items: { id: string; ruleKey: string }[];
        }>().items;
        const kfs = rules.find((r) => r.ruleKey === 'kfs.nbfc.retail_msme_term')?.id ?? '';
        const agr = rules.find((r) => r.ruleKey === 'agreement.nbfc.kfs_summary_box')?.id ?? '';
        state.ruleKfs = kfs;
        state.ruleAgr = agr;
        expect(
          code(
            await post(`/v1/platform/document-rules/${kfs}/decision`, ids.p1, { approve: true }),
          ),
        ).toBe('reviewer_required');
        expect(
          (
            await post(`/v1/platform/document-rules/${kfs}/decision`, ids.p1, {
              approve: true,
              reviewerRef: 'Test compliance reviewer',
            })
          ).statusCode,
        ).toBe(200);
        expect(
          (
            await post(`/v1/platform/document-rules/${agr}/decision`, ids.p1, {
              approve: true,
              reviewerRef: 'Test compliance reviewer',
            })
          ).statusCode,
        ).toBe(200);
        const stored = await q<{ reviewer_ref: string; approval_status: string }>(
          'select reviewer_ref, approval_status from documents.applicability_rules where id = $1',
          [kfs],
        );
        expect(stored[0]).toEqual({
          reviewer_ref: 'Test compliance reviewer',
          approval_status: 'approved',
        });
      });

      it('approves the Annex I layout, then the draft still cannot be prepared without a working-day calendar', async () => {
        const templates = (await get('/v1/platform/document-templates', ids.p1)).json<{
          items: { id: string; templateKey: string; status: string }[];
        }>().items;
        const annex = templates.find((t) => t.templateKey === 'kfs.rbi_annex_i');
        expect(annex?.status).toBe('draft');
        expect(
          (
            await post(`/v1/platform/document-templates/${annex?.id}/compliance-approval`, ids.p1, {
              reviewerRef: 'Test compliance reviewer',
            })
          ).statusCode,
        ).toBe(200);
        const refused = await post(`/v1/lender/offers/${ids.offerA}/generation`, ids.aPrep, {
          inputId: state.inputA,
          language: 'en',
          documentType: 'kfs',
        });
        expect(code(refused)).toBe('calendar_missing');
        const hindi = await post(`/v1/lender/offers/${ids.offerA}/generation`, ids.aPrep, {
          inputId: state.inputA,
          language: 'hi',
          documentType: 'kfs',
        });
        expect(code(hindi)).toBe('template_not_ready');
      });

      it("approves a calendar only with a second person and the lender's confirmation reference", async () => {
        const from = new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10);
        const to = new Date(Date.now() + 120 * 86_400_000).toISOString().slice(0, 10);
        for (const lender of [ids.lenderA, ids.lenderB]) {
          const proposed = await post('/v1/platform/document-calendars', ids.p1, {
            lenderId: lender,
            name: 'Test calendar',
            weeklyOff: [0, 6],
            coveredFrom: from,
            coveredTo: to,
            exceptions: [],
          });
          expect(proposed.statusCode, proposed.body).toBe(201);
          const id = proposed.json<{ id: string }>().id;
          expect(
            code(
              await post(`/v1/platform/document-calendars/${id}/decision`, ids.p1, {
                approve: true,
                lenderConfirmationRef: 'CONF-1',
              }),
            ),
          ).toBe('segregation_of_duties');
          expect(
            code(
              await post(`/v1/platform/document-calendars/${id}/decision`, ids.p2, {
                approve: true,
              }),
            ),
          ).toBe('lender_confirmation_required');
          expect(
            (
              await post(`/v1/platform/document-calendars/${id}/decision`, ids.p2, {
                approve: true,
                lenderConfirmationRef: `CONF-${ref()}`,
              })
            ).statusCode,
          ).toBe(200);
        }
      });
    });

    describe('KFS data and generation', () => {
      it('holds data that differs from the offer or lacks a required part, and never alters what was sent', async () => {
        const noApr = { ...sampleKfsData() } as Record<string, unknown>;
        delete noApr.aprBps;
        const held = await post(`/v1/lender/offers/${ids.offerA}/kfs-data`, ids.aPrep, {
          mode: 'data',
          data: noApr,
        });
        expect(held.json<{ validation: string; issues: string[] }>()).toMatchObject({
          validation: 'held',
          issues: ['apr_missing'],
        });
        const wrongApr = await post(`/v1/lender/offers/${ids.offerA}/kfs-data`, ids.aPrep, {
          mode: 'data',
          data: { ...sampleKfsData(), aprBps: 1800 },
        });
        expect(wrongApr.json<{ issues: string[] }>().issues).toEqual(['apr_mismatch_offer']);
        const stored = await q<{ data: unknown }>(
          'select data from documents.kfs_inputs where id = $1',
          [state.inputA],
        );
        expect(stored[0]?.data).toEqual(JSON.parse(JSON.stringify(sampleKfsData())));
        const offer = await q<{ apr_bps: number; principal_minor: string }>(
          'select apr_bps, principal_minor::text from lending.offers where id = $1',
          [ids.offerA],
        );
        expect(offer[0]).toEqual({ apr_bps: 1707, principal_minor: '2000000' });
        // The held versions are newer; submit the good data again so it is the latest accepted package.
        const again = await post(`/v1/lender/offers/${ids.offerA}/kfs-data`, ids.aPrep, {
          mode: 'data',
          data: sampleKfsData(),
        });
        state.inputA = again.json<{ inputId: string }>().inputId;
        expect(again.json<{ validation: string }>().validation).toBe('accepted');
      });

      it('keeps KFS data private to its lender and to people allowed to prepare it', async () => {
        expect(
          code(
            await post(`/v1/lender/offers/${ids.offerA}/kfs-data`, ids.bOfficer, {
              mode: 'data',
              data: sampleKfsData(),
            }),
          ),
        ).toBe('not_found');
        expect(
          code(
            await post(`/v1/lender/offers/${ids.offerA}/kfs-data`, ids.b1, {
              mode: 'data',
              data: sampleKfsData(),
            }),
          ),
        ).toBe('staff_only');
        const lenderBsees = await get(`/v1/lender/offers/${ids.offerA}/kfs-data`, ids.bOfficer);
        expect(lenderBsees.json<{ items: unknown[] }>().items).toHaveLength(0);
      });

      it('prepares a draft through the worker: one real PDF, stored privately, hashed, idempotent', async () => {
        const requested = await post(`/v1/lender/offers/${ids.offerA}/generation`, ids.aPrep, {
          inputId: state.inputA,
          language: 'en',
          documentType: 'kfs',
        });
        expect(requested.statusCode, requested.body).toBe(202);
        const { jobId } = requested.json<{ jobId: string }>();
        const same = await post(`/v1/lender/offers/${ids.offerA}/generation`, ids.aPrep, {
          inputId: state.inputA,
          language: 'en',
          documentType: 'kfs',
        });
        expect(same.json<{ jobId: string }>().jobId).toBe(jobId);
        await runJob(jobId);
        await runJob(jobId);
        const docs = await q<{
          id: string;
          sha256: string;
          storage_key: string;
          proposal_no: string;
          approval_status: string;
          issuance_status: string;
          kfs_valid_until: Date;
          valid_until: Date;
        }>(
          `select i.id, i.sha256, i.storage_key, i.proposal_no, i.approval_status, i.issuance_status, i.kfs_valid_until, o.valid_until
           from documents.items i join lending.offers o on o.id = i.offer_id where i.offer_id = $1 and i.document_type = 'kfs'`,
          [ids.offerA],
        );
        expect(docs).toHaveLength(1);
        const d = docs[0];
        if (!d) throw new Error('no document');
        state.docA = d.id;
        state.shaA = d.sha256;
        expect(d.proposal_no).toMatch(/^UDF-[0-9A-F]{12}$/);
        expect([d.approval_status, d.issuance_status]).toEqual(['draft', 'not_issued']);
        expect(d.kfs_valid_until.getTime()).toBeLessThan(d.valid_until.getTime()); // separate from the offer's own validity
        const object = await store.get(d.storage_key);
        expect(object).toBeDefined();
        expect(
          createHash('sha256')
            .update(object?.bytes ?? new Uint8Array())
            .digest('hex'),
        ).toBe(d.sha256);
        expect(Buffer.from(object?.bytes.slice(0, 5) ?? []).toString()).toBe('%PDF-');
        const job = await q<{ status: string }>(
          'select status from documents.generation_jobs where id = $1',
          [jobId],
        );
        expect(job[0]?.status).toBe('succeeded');
      });

      it('does not show a draft to the borrower, and shows the lender exactly the stored file', async () => {
        expect(code(await get(`/v1/documents/${state.docA}/content`, ids.b1))).toBe('not_found');
        expect(code(await get(`/v1/documents/${state.docA}/kfs?language=en`, ids.b1))).toBe(
          'not_found',
        );
        const content = await get(`/v1/lender/documents/${state.docA}/content`, ids.aPrep);
        expect(content.statusCode, content.body).toBe(200);
        expect(content.headers['cache-control']).toBe('no-store');
        const body = content.json<{ sha256: string; contentBase64: string; mimeType: string }>();
        expect(body.mimeType).toBe('application/pdf');
        expect(
          createHash('sha256').update(Buffer.from(body.contentBase64, 'base64')).digest('hex'),
        ).toBe(state.shaA);
        expect(code(await get(`/v1/lender/documents/${state.docA}/content`, ids.bOfficer))).toBe(
          'not_found',
        );
      });
    });

    describe('lender approval and issuance', () => {
      it('needs a different lender person, the exact hash, and then issues', async () => {
        expect(
          code(
            await post(`/v1/lender/documents/${state.docA}/approve`, ids.aPrep, {
              sha256: state.shaA,
            }),
          ),
        ).toBe('segregation_of_duties');
        expect(code(await post(`/v1/lender/documents/${state.docA}/issue`, ids.aApprover))).toBe(
          'approval_required',
        );
        expect(
          code(
            await post(`/v1/lender/documents/${state.docA}/approve`, ids.aApprover, {
              sha256: '0'.repeat(64),
            }),
          ),
        ).toBe('hash_mismatch');
        expect(
          code(
            await post(`/v1/lender/documents/${state.docA}/approve`, ids.bOfficer, {
              sha256: state.shaA,
            }),
          ),
        ).toBe('not_found');
        expect(
          (
            await post(`/v1/lender/documents/${state.docA}/approve`, ids.aApprover, {
              sha256: state.shaA,
            })
          ).statusCode,
        ).toBe(200);
        const issued = await post(`/v1/lender/documents/${state.docA}/issue`, ids.aApprover);
        expect(issued.statusCode, issued.body).toBe(200);
        const history = (await get(`/v1/lender/documents/${state.docA}/history`, ids.aApprover))
          .json<{ items: { event: string }[] }>()
          .items.map((e) => e.event);
        expect(history).toEqual(['generated', 'lender_approved', 'issued']);
      });
    });

    describe('borrower: review, acknowledgement and acceptance', () => {
      it("shows only the borrower's own issued documents, with offer and KFS validity as separate dates", async () => {
        const mine = await get(`/v1/applications/${ids.appA}/documents`, ids.b1);
        expect(mine.statusCode, mine.body).toBe(200);
        const body = mine.json<{
          kfs: { documentId: string; validUntil: string; proposalNo: string } | null;
          offer: { validUntil: string; status: string } | null;
          documents: unknown[];
        }>();
        expect(body.kfs?.documentId).toBe(state.docA);
        expect(body.documents).toHaveLength(1);
        expect(body.offer?.validUntil).not.toBe(body.kfs?.validUntil);
        expect(code(await get(`/v1/applications/${ids.appA}/documents`, ids.b2))).toBe('not_found');
        expect(code(await get(`/v1/documents/${state.docA}/content`, ids.b2))).toBe('not_found');
        expect(code(await get(`/v1/documents/${state.docA}/content`, ids.bOfficer))).toBe(
          'borrower_only',
        );
      });

      it('offers approved wording only: Hindi falls back to English and says so', async () => {
        const view = await get(`/v1/documents/${state.docA}/kfs?language=hi`, ids.b1);
        expect(view.statusCode, view.body).toBe(200);
        const v = view.json<{
          wording: { noticeId: string; language: string; languageFallback: boolean } | null;
          data: { aprBps: number } | null;
          ackSections: string[];
        }>();
        expect(v.wording?.language).toBe('en');
        expect(v.wording?.languageFallback).toBe(true);
        expect(v.wording?.noticeId).toBe(notice.ack);
        expect(v.data?.aprBps).toBe(1707);
        expect(v.ackSections).toEqual(ALL_SECTIONS);
      });

      it('does not accept an acknowledgement before the file was opened, without every section, or on unapproved wording', async () => {
        const body = {
          noticeId: notice.ack,
          sections: ALL_SECTIONS,
          action: 'checkbox_and_button',
        };
        expect(code(await post(`/v1/documents/${state.docA}/acknowledge`, ids.b1, body))).toBe(
          'document_not_opened',
        );
        const opened = await get(`/v1/documents/${state.docA}/content?purpose=view`, ids.b1);
        expect(opened.statusCode, opened.body).toBe(200);
        expect(opened.json<{ sha256: string }>().sha256).toBe(state.shaA);
        expect(
          code(
            await post(`/v1/documents/${state.docA}/acknowledge`, ids.b1, {
              ...body,
              sections: ['part1'],
            }),
          ),
        ).toBe('sections_not_shown');
        expect(
          code(
            await post(`/v1/documents/${state.docA}/acknowledge`, ids.b1, {
              ...body,
              noticeId: notice.ackHi,
            }),
          ),
        ).toBe('wording_not_approved');
        expect(
          code(
            await post(`/v1/documents/${state.docA}/acknowledge`, ids.b1, {
              ...body,
              action: 'navigated',
            }),
          ),
        ).toBe('validation_failed');
        expect(code(await post(`/v1/documents/${state.docA}/acknowledge`, ids.b2, body))).toBe(
          'not_found',
        );
      });

      it('records the acknowledgement against the exact file and wording, once', async () => {
        const body = {
          noticeId: notice.ack,
          sections: ALL_SECTIONS,
          action: 'checkbox_and_button',
        };
        const first = await post(
          `/v1/documents/${state.docA}/acknowledge`,
          ids.b1,
          body,
          'ack-key-1-fixed-value',
        );
        expect(first.statusCode, first.body).toBe(200);
        state.ackA = first.json<{ acknowledgementId: string }>().acknowledgementId;
        const replay = await post(
          `/v1/documents/${state.docA}/acknowledge`,
          ids.b1,
          body,
          'ack-key-1-fixed-value',
        );
        expect(replay.json<{ acknowledgementId: string }>().acknowledgementId).toBe(state.ackA);
        const rows = await q<{ n: string; sha: string; lang: string; wording: string }>(
          `select count(*) over () n, document_sha256 sha, language lang, wording_sha256 wording from documents.acknowledgements where document_id = $1`,
          [state.docA],
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]?.sha).toBe(state.shaA);
        expect(rows[0]?.lang).toBe('en');
        const noticeRow = await q<{ body_sha256: string }>(
          'select body_sha256 from consent.notices where id = $1',
          [notice.ack],
        );
        expect(rows[0]?.wording).toBe(noticeRow[0]?.body_sha256);
      });

      it('refuses acceptance without a step-up code for THIS offer, and with a code for another object', async () => {
        const body = { kfsDocumentId: state.docA, acknowledgementId: state.ackA };
        expect(code(await post(`/v1/offers/${ids.offerA}/accept`, ids.b1, body))).toBe(
          'stepup_required',
        );
        await stepUp(ids.b1, 'offer_acceptance', ids.offerB);
        expect(code(await post(`/v1/offers/${ids.offerA}/accept`, ids.b1, body))).toBe(
          'stepup_required',
        );
        await stepUp(ids.b1, 'esign', ids.offerA);
        expect(code(await post(`/v1/offers/${ids.offerA}/accept`, ids.b1, body))).toBe(
          'stepup_required',
        );
        expect(code(await post(`/v1/offers/${ids.offerA}/accept`, ids.b2, body))).toBe('not_found');
      });

      it('accepts once; the acceptance is neither a signature nor a disbursement', async () => {
        const body = { kfsDocumentId: state.docA, acknowledgementId: state.ackA };
        await stepUp(ids.b1, 'offer_acceptance', ids.offerA);
        const accepted = await post(
          `/v1/offers/${ids.offerA}/accept`,
          ids.b1,
          body,
          'accept-key-1-fixed-value',
        );
        expect(accepted.statusCode, accepted.body).toBe(200);
        expect(accepted.json()).toMatchObject({
          applicationStatus: 'offer_accepted',
          signatureStatus: 'not_signed',
          disbursementStatus: 'not_started',
          replayed: false,
        });
        const replay = await post(
          `/v1/offers/${ids.offerA}/accept`,
          ids.b1,
          body,
          'accept-key-1-fixed-value',
        );
        expect(replay.headers['idempotent-replayed']).toBe('true');
        expect(replay.json<{ acceptanceId: string }>().acceptanceId).toBe(
          accepted.json<{ acceptanceId: string }>().acceptanceId,
        );
        expect(
          code(
            await post(`/v1/offers/${ids.offerA}/accept`, ids.b1, body, 'another-accept-key-value'),
          ),
        ).toBe('already_accepted');
        const rows = await q<{ offer_status: string; app_status: string; n: string }>(
          `select o.status::text offer_status, a.status::text app_status, (select count(*) from documents.acceptances where offer_id = o.id)::text n
           from lending.offers o join lending.applications a on a.id = o.application_id where o.id = $1`,
          [ids.offerA],
        );
        expect(rows[0]).toEqual({ offer_status: 'accepted', app_status: 'offer_accepted', n: '1' });
        expect((await q('select 1 from servicing.loan_accounts')).length).toBe(0);
      });
    });

    describe('agreement with the KFS summary box', () => {
      it('is not ready without an approved agreement template (Udofin ships no legal text); the failure is recorded', async () => {
        const job = await q<{ id: string }>(
          `select id from documents.generation_jobs where offer_id = $1 and document_type = 'loan_agreement'`,
          [ids.offerA],
        );
        expect(job).toHaveLength(1);
        await runJob(job[0]?.id ?? '');
        const after = await q<{ status: string; failure_class: string }>(
          'select status, failure_class from documents.generation_jobs where id = $1',
          [job[0]?.id],
        );
        expect(after[0]).toEqual({ status: 'failed', failure_class: 'template_not_ready' });
        state.agrJob = job[0]?.id ?? '';
      });

      it('is refused while its template is a sample on a database that does not allow samples, then built once approved', async () => {
        // This admin connection was opened before the database setting existed, so it asks for the allowance itself.
        const c = await admin.connect();
        await c.query(`select set_config('udofin.allow_sample_documents', 'on', false)`);
        const t = await c.query<{ id: string }>(
          `insert into documents.templates (template_key, document_type, language, lender_org_id, version, body, is_sample, status, created_by)
         values ('agreement.loan', 'loan_agreement', 'en', $1, 1, $2::jsonb, true, 'in_review', $3) returning id`,
          [
            ids.lenderA,
            JSON.stringify({
              engine: 'agreement_v1',
              title: 'SAMPLE - NOT A LEGAL DOCUMENT',
              sections: [
                { heading: 'Sample clause', text: 'Test fixture text for {{lenderName}}.' },
              ],
            }),
            ids.aPrep,
          ],
        );
        c.release();
        state.tplAgr = t.rows[0]?.id ?? '';
        expect(
          code(
            await post(
              `/v1/platform/document-templates/${state.tplAgr}/compliance-approval`,
              ids.aPrep,
              { reviewerRef: 'xx' },
            ),
          ),
        ).toBe('forbidden');
        expect(code(await post(`/v1/lender/templates/${state.tplAgr}/approve`, ids.aPrep))).toBe(
          'segregation_of_duties',
        );
        expect(
          (await post(`/v1/lender/templates/${state.tplAgr}/approve`, ids.aApprover)).statusCode,
        ).toBe(200);
        expect(
          (
            await post(
              `/v1/platform/document-templates/${state.tplAgr}/compliance-approval`,
              ids.p1,
              { reviewerRef: 'Test compliance reviewer' },
            )
          ).statusCode,
        ).toBe(200);
        const body = { inputId: state.inputA, language: 'en', documentType: 'loan_agreement' };
        expect(
          code(
            await call(
              blockedApp,
              'POST',
              `/v1/lender/offers/${ids.offerA}/generation`,
              ids.aPrep,
              body,
            ),
          ),
        ).toBe('template_not_ready');
        const retry = await post(`/v1/lender/offers/${ids.offerA}/generation`, ids.aPrep, body);
        expect(retry.statusCode, retry.body).toBe(202);
        expect(retry.json<{ jobId: string }>().jobId).toBe(state.agrJob);
        await runJob(state.agrJob ?? '');
        const doc = await q<{
          id: string;
          sha256: string;
          content_digest: string;
          app_status: string;
          kfs_digest: string;
        }>(
          `select i.id, i.sha256, i.content_digest, a.status::text app_status, (select content_digest from documents.items where id = $2) kfs_digest
           from documents.items i join lending.applications a on a.id = i.application_id where i.offer_id = $1 and i.document_type = 'loan_agreement'`,
          [ids.offerA, state.docA],
        );
        expect(doc).toHaveLength(1);
        expect(doc[0]?.content_digest).toBe(doc[0]?.kfs_digest);
        expect(doc[0]?.app_status).toBe('agreement_pending');
        state.docAgr = doc[0]?.id ?? '';
        state.shaAgr = doc[0]?.sha256 ?? '';
        const pdf = (
          await get(`/v1/lender/documents/${state.docAgr}/content`, ids.aApprover)
        ).json<{ contentBase64: string }>();
        expect(Buffer.from(pdf.contentBase64, 'base64').subarray(0, 5).toString()).toBe('%PDF-');
      });

      it('is issued only after lender approval; the borrower then sees it listed', async () => {
        expect(code(await post(`/v1/lender/documents/${state.docAgr}/issue`, ids.aApprover))).toBe(
          'approval_required',
        );
        expect(
          (
            await post(`/v1/lender/documents/${state.docAgr}/approve`, ids.aApprover, {
              sha256: state.shaAgr,
            })
          ).statusCode,
        ).toBe(200);
        expect(
          (await post(`/v1/lender/documents/${state.docAgr}/issue`, ids.aApprover)).statusCode,
        ).toBe(200);
        const mine = (await get(`/v1/applications/${ids.appA}/documents`, ids.b1)).json<{
          agreement: { documentId: string } | null;
          documents: { type: string }[];
          signing: unknown;
        }>();
        expect(mine.agreement?.documentId).toBe(state.docAgr);
        expect(mine.documents.map((d) => d.type).sort()).toEqual(['kfs', 'loan_agreement']);
        expect(mine.signing).toBeNull();
      });
    });

    describe('signing boundary (labelled mock only; an OTP is not a signature)', () => {
      it('is unavailable when the API has no provider, and refused when the database does not allow the mock', async () => {
        await stepUp(ids.b1, 'esign', state.docAgr ?? '');
        const noSigning = await buildApp(loadConfig({ APP_ENV: 'test' }), {
          auth: { verifier: fakeVerifier, context: createUserContext(apiPool) },
          borrower: {
            sms,
            integrity: createMockIntegrityVerifier('test'),
            stepUpPepper: PEPPER,
            smsTimeoutMs: 2000,
          },
          documents: store,
        });
        try {
          expect(
            code(
              await call(noSigning, 'POST', `/v1/agreements/${state.docAgr}/signing`, ids.b1, {}),
            ),
          ).toBe('signing_not_available');
        } finally {
          await noSigning.close();
        }
        expect(
          code(
            await call(blockedApp, 'POST', `/v1/agreements/${state.docAgr}/signing`, ids.b1, {}),
          ),
        ).toBe('mock_signing_blocked');
        const spent = await q<{ status: string }>(
          `select status from identity.stepup_challenges where action = 'esign' and context_ref = $1 order by created_at desc limit 1`,
          [state.docAgr],
        );
        expect(spent[0]?.status).toBe('verified'); // the refused starts did not spend the code
      });

      it('starts only with the one-time code, then follows what the provider reports', async () => {
        const started = await post(
          `/v1/agreements/${state.docAgr}/signing`,
          ids.b1,
          {},
          'sign-key-1-fixed-value',
        );
        expect(started.statusCode, started.body).toBe(200);
        const { requestId, state: first } = started.json<{ requestId: string; state: string }>();
        expect(first).toBe('ready_for_signing');
        expect(
          code(
            await post(
              `/v1/agreements/${state.docAgr}/signing`,
              ids.b2,
              {},
              'sign-key-2-fixed-value',
            ),
          ),
        ).toBe('not_found');
        const again = await post(
          `/v1/agreements/${state.docAgr}/signing`,
          ids.b1,
          {},
          'sign-key-1-fixed-value',
        );
        expect(again.json<{ requestId: string }>().requestId).toBe(requestId);
        const app1 = await q<{ status: string }>(
          'select status::text from lending.applications where id = $1',
          [ids.appA],
        );
        expect(app1[0]?.status).toBe('agreement_pending'); // verifying a code does not execute the agreement
        // The provider call times out: the outcome is unknown and is reconciled, never started again.
        signingScript = 'timeout';
        await run('signing.initiate', { request_id: requestId });
        expect(
          (await get(`/v1/agreements/${state.docAgr}/signing`, ids.b1)).json<{ state: string }>()
            .state,
        ).toBe('requires_reconciliation');
        await run('signing.reconcile', { request_id: requestId, round: 1 });
        expect(
          (await get(`/v1/agreements/${state.docAgr}/signing`, ids.b1)).json<{ state: string }>()
            .state,
        ).toBe('awaiting_borrower');
        expect(signing.calls).toHaveLength(1);
        expect(
          (
            await q<{ status: string }>(
              'select status::text from lending.applications where id = $1',
              [ids.appA],
            )
          )[0]?.status,
        ).toBe('agreement_pending');
        // Only the provider's own "executed" report completes it (here recorded as a verified callback would).
        await processor.recordSigningEvent({
          requestId,
          to: 'executed',
          providerRef: 'MOCK-REF',
          evidenceRef: 'MOCK-EVIDENCE',
        });
        const done = (await get(`/v1/agreements/${state.docAgr}/signing`, ids.b1)).json<{
          state: string;
          providerMode: string;
          executedAt: string | null;
        }>();
        expect(done).toMatchObject({ state: 'executed', providerMode: 'mock' });
        expect(done.executedAt).not.toBeNull();
        expect(
          (
            await q<{ status: string }>(
              'select status::text from lending.applications where id = $1',
              [ids.appA],
            )
          )[0]?.status,
        ).toBe('agreement_executed');
        const acceptance = await q<{ signature_status: string; disbursement_status: string }>(
          'select signature_status, disbursement_status from documents.acceptances where offer_id = $1',
          [ids.offerA],
        );
        expect(acceptance[0]).toEqual({
          signature_status: 'not_signed',
          disbursement_status: 'not_started',
        }); // acceptance itself is unchanged
      });
    });

    describe('delivery and access evidence', () => {
      it('records opens without content and never claims delivery', async () => {
        const log = await q<{ n: string }>(
          `select count(*)::text n from documents.access_log where document_id = $1`,
          [state.docA],
        );
        expect(Number(log[0]?.n)).toBeGreaterThanOrEqual(2);
        const email = await post(`/v1/documents/${state.docA}/delivery`, ids.b1, {
          channel: 'email_notice',
        });
        expect(email.json<{ status: string }>().status).toBe('not_configured');
        const requested = await post(`/v1/documents/${state.docA}/delivery`, ids.b1, {
          channel: 'sms_notice',
        });
        expect(requested.statusCode, requested.body).toBe(200);
        const { deliveryId } = requested.json<{ deliveryId: string }>();
        const before = sms.sent.length;
        await run('document.deliver', { delivery_id: deliveryId });
        expect(sms.sent.length).toBe(before + 1);
        const message = sms.sent[before];
        expect(message?.template).toBe('documents_ready');
        expect(JSON.stringify(message?.variables)).toBe('{}');
        const rows = await q<{ status: string }>(
          'select status from documents.deliveries where id = $1',
          [deliveryId],
        );
        expect(rows[0]?.status).toBe('accepted_by_provider');
        const list = (await get(`/v1/documents/${state.docA}/deliveries`, ids.b1)).json<{
          items: { channel: string; status: string }[];
        }>().items;
        expect(list.some((d) => d.status === 'delivered')).toBe(false);
        expect(code(await get(`/v1/documents/${state.docA}/deliveries`, ids.b2))).toBe('not_found');
      });

      it("keeps the borrower's phone number out of every document table and audit entry", async () => {
        const found = await q<{ n: string }>(
          `select (select count(*) from documents.deliveries d where to_jsonb(d)::text like '%' || $1 || '%')
              + (select count(*) from documents.items d where to_jsonb(d)::text like '%' || $1 || '%')
              + (select count(*) from audit.events e where e.action like 'documents.%' and to_jsonb(e)::text like '%' || $1 || '%')
              + (select count(*) from ops.outbox_events o where o.event_type like 'document.%' and o.payload::text like '%' || $1 || '%') as n`,
          [phones.b1],
        );
        expect(found[0]?.n).toBe('0');
      });
    });
  },
);
