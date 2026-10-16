// Phase 08a integration tests: payment providers, the account registry, merchants, payment configurations and the per-lender
// feature switches, over HTTP against a REAL migrated Postgres. Every rule (permissions, aal2, two-person approval, tenant
// isolation, the fail-closed registry, switches that can never turn on) is in the database; these tests drive the whole flows
// through the routes and check that the API layer adds nothing and leaks nothing. Account details are SAMPLE and synthetic.
// Runs only when the INTEGRATION_* URLs are set.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import {
  createLocalKeyManager,
  fingerprintAccount,
  type AccountFormatRule,
} from '@udofin/adapters';
import Fastify, { type FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { TokenError, type TokenVerifier } from '../../src/auth/token-verifier.js';
import { loadConfig } from '../../src/config.js';
import { createUserContext } from '../../src/db/user-context.js';
import { registerRoutes } from '../../src/http/routes.js';
import { loggerOptions } from '../../src/logger.js';
import {
  createFingerprintKeySource,
  type FingerprintKeySource,
} from '../../src/modules/lender-accounts/fingerprint-keys.js';
import { lenderAccountsRoutes } from '../../src/modules/lender-accounts/routes.js';
import { hashEndpointToken } from '../../src/workers/provider-callbacks.js';

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
const freshAddress = () => `10.11.${(nextAddress >> 8) & 255}.${nextAddress++ & 255}`;

const digits = (n: number) => '9' + Array.from(randomBytes(n - 1), (b) => b % 10).join('');
const letters = (n: number) =>
  Array.from(randomBytes(n), (b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[b % 24]).join('');
const alnum = (n: number) =>
  Array.from(randomBytes(n), (b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');
const newIfsc = () => `${letters(4)}0${alnum(6)}`;

type Res = Awaited<ReturnType<FastifyInstance['inject']>>;
interface Sample {
  accountNumber: string;
  ifsc: string;
}

describe.skipIf(!enabled)(
  'providers, account registry, merchants, payment configurations and feature switches over HTTP against a real database',
  () => {
    const ids = {
      platformOrg: randomUUID() as string,
      lenderA: randomUUID(),
      lenderB: randomUUID(),
      p1: randomUUID(), // platform: providers.manage + registry.manage + features.manage
      p2: randomUUID(), // platform: registry.verify + features.manage (a different person for every second signature)
      p3: randomUUID(), // platform: no payments permission at all
      l1: randomUUID(), // lender A maker: payment.configure
      l2: randomUUID(), // lender A checker: payment.config.approve
      l3: randomUUID(), // lender A second maker (the submitter)
      la: randomUUID(), // lender A reader: payment.read and loan.read only
      b1: randomUUID(), // lender B maker
      b2: randomUUID(), // lender B checker
      borrower: randomUUID(),
    };
    const logs: string[] = [];
    /** Everything any response of this file carried (bodies and headers), for the canary scans at the end. */
    const seen: string[] = [];
    const used: Sample[] = [];
    const state: Record<string, string> = {};
    let admin: pg.Pool;
    let apiPool: pg.Pool;
    let app: FastifyInstance; // the full application, without any fingerprint key
    let keyed: FastifyInstance; // the module's routes with a local test key source and captured logs
    let keyedV1Only: FastifyInstance;
    let source: FingerprintKeySource;
    const rawKeys: Record<number, Uint8Array> = {};
    let rule: AccountFormatRule;

    const call = (
      target: FastifyInstance,
      method: 'GET' | 'POST',
      url: string,
      user: string | null,
      payload?: unknown,
      key: string | null = method === 'POST' ? `it-${randomUUID()}` : null,
      aal: 'aal1' | 'aal2' = 'aal2',
    ): Promise<Res> =>
      target
        .inject({
          method,
          url,
          remoteAddress: freshAddress(),
          headers: {
            ...(user ? { authorization: `Bearer test.${user}.${aal}` } : {}),
            ...(key ? { 'idempotency-key': key } : {}),
          },
          ...(payload === undefined ? {} : { payload: payload as object }),
        })
        .then((res) => {
          seen.push(res.body, JSON.stringify(res.headers));
          return res;
        });
    const get = (url: string, user: string | null) => call(keyed, 'GET', url, user);
    const post = (url: string, user: string | null, payload: unknown = {}, key?: string | null) =>
      call(keyed, 'POST', url, user, payload, key);
    const code = (res: Res) => res.json<{ code?: string }>().code;
    const ok = (res: Res, status = 200) => {
      expect(res.statusCode, res.body).toBe(status);
      return res;
    };
    const q = async <T extends pg.QueryResultRow>(sql: string, values: unknown[] = []) =>
      (await admin.query<T>(sql, values)).rows;

    async function member(org: string, user: string, kind: 'lender' | 'platform', roles: string[]) {
      const m = await admin.query<{ id: string }>(
        'insert into tenancy.memberships (org_id, user_id, status) values ($1, $2, $3) returning id',
        [org, user, 'active'],
      );
      for (const role of roles) {
        await admin.query(
          `insert into tenancy.membership_roles (membership_id, role_id)
           select $1, r.id from tenancy.roles r where r.org_id is null and r.applies_to = $2::tenancy.organization_kind and r.key = $3`,
          [m.rows[0]?.id, kind, role],
        );
      }
    }

    async function makeApp(
      keys: FingerprintKeySource | undefined,
      sink: string[] | undefined,
    ): Promise<FastifyInstance> {
      const stream = new Writable({
        write(chunk: Buffer, _encoding, callback) {
          sink?.push(chunk.toString());
          callback();
        },
      });
      const instance = Fastify({
        logger: sink
          ? { ...loggerOptions({ LOG_LEVEL: 'trace', APP_ENV: 'test' }), stream }
          : false,
        requestIdHeader: false,
        genReqId: () => randomUUID(),
      });
      // The same shape as the application's error handler: server errors are logged by type and code only.
      instance.setErrorHandler((error: Error, request, reply) => {
        request.log.error({ err: error }, 'unhandled error');
        void reply.code(500).send({ code: 'internal_error' });
      });
      registerRoutes(instance, lenderAccountsRoutes(keys ? { fingerprintKeys: keys } : {}), {
        auth: { verifier: fakeVerifier, context: createUserContext(apiPool) },
      });
      await instance.ready();
      return instance;
    }

    /** The adapters' own computation, for checking what the route stored. */
    const fingerprintOf = (sample: Sample, version: number) =>
      fingerprintAccount(
        {
          keyId: 'platform/account-fingerprint',
          keyVersion: version,
          key: rawKeys[version] as Uint8Array,
        },
        sample,
        rule,
      );

    /** Which of the numbers this file used has this fingerprint (invalid numbers are skipped). */
    const sampleWithFingerprint = (fingerprint: string, version: number): Sample | undefined =>
      used.find((candidate) => {
        try {
          return fingerprintOf(candidate, version).fingerprint === fingerprint;
        } catch {
          return false;
        }
      });

    const registerBody = (sample: Sample, over: Record<string, unknown> = {}) => ({
      accountNumber: sample.accountNumber,
      ifsc: sample.ifsc,
      country: 'IN',
      accountType: 'bank_account',
      ownerKind: 'lender',
      ownerOrgId: ids.lenderA,
      legalOwnerName: 'Alpha Finance Private Limited',
      permittedPurposes: ['repayment_settlement'],
      ...over,
    });
    const newSample = (length = 12): Sample => {
      const sample = { accountNumber: digits(length), ifsc: newIfsc() };
      used.push(sample);
      return sample;
    };

    beforeAll(async () => {
      admin = new pg.Pool({ connectionString: ADMIN, max: 3 });
      apiPool = new pg.Pool({ connectionString: API, max: 10 });

      for (const id of [ids.p1, ids.p2, ids.p3, ids.l1, ids.l2, ids.l3, ids.la, ids.b1, ids.b2]) {
        await admin.query(
          `insert into auth.users (id, phone, raw_app_meta_data) values ($1, null, '{"actor_type":"staff"}')`,
          [id],
        );
      }
      await admin.query(
        `insert into auth.users (id, phone, raw_app_meta_data) values ($1, $2, '{}')`,
        [ids.borrower, `91${Math.floor(1_000_000_000 + Math.random() * 8_999_999_999)}`],
      );
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
        [ids.lenderA, 'Alpha Finance'],
        [ids.lenderB, 'Beta Finance'],
      ] as const) {
        await admin.query(
          `insert into tenancy.organizations (id, kind, legal_name, display_name, regulator_registration_no, status) values ($1, 'lender', $2, $3, $4, 'active')`,
          [lender, `${name} Ltd`, name, `IT-ACC-${alnum(8)}`],
        );
        await admin.query(
          `insert into onboarding.lender_gates (lender_org_id, stage) values ($1, 'activated') on conflict (lender_org_id) do update set stage = 'activated'`,
          [lender],
        );
      }
      await member(ids.platformOrg, ids.p1, 'platform', [
        'platform_payments_admin',
        'platform_features_admin',
      ]);
      await member(ids.platformOrg, ids.p2, 'platform', [
        'platform_account_verifier',
        'platform_features_admin',
      ]);
      await member(ids.platformOrg, ids.p3, 'platform', ['platform_admin']);
      await member(ids.lenderA, ids.l1, 'lender', ['payments_admin']);
      await member(ids.lenderA, ids.l2, 'lender', ['payments_approver']);
      await member(ids.lenderA, ids.l3, 'lender', ['payments_admin']);
      await member(ids.lenderA, ids.la, 'lender', ['lender_admin']);
      await member(ids.lenderB, ids.b1, 'lender', ['payments_admin']);
      await member(ids.lenderB, ids.b2, 'lender', ['payments_approver']);

      // Two versions of the fingerprint key, wrapped by the labelled local key manager (local and test only).
      const masters = { 1: Buffer.alloc(32, 7).toString('base64') };
      const keyManager = createLocalKeyManager('test', masters, 1);
      const wrapped: Record<number, Awaited<ReturnType<typeof keyManager.encrypt>>> = {};
      for (const version of [1, 2]) {
        rawKeys[version] = new Uint8Array(randomBytes(32));
        wrapped[version] = await keyManager.encrypt({
          keyRef: 'platform/account-fingerprint',
          plaintext: new Uint8Array(rawKeys[version] ?? []),
          context: { purpose: 'account-fingerprint', fingerprint_key_version: String(version) },
        });
      }
      source = createFingerprintKeySource({ environment: 'test', keyManager, wrapped });
      const v1Only = createFingerprintKeySource({
        environment: 'test',
        keyManager,
        wrapped: { 1: wrapped[1] as never },
      });
      keyed = await makeApp(source, logs);
      keyedV1Only = await makeApp(v1Only, undefined);
      app = await buildApp(loadConfig({ APP_ENV: 'test' }), {
        auth: { verifier: fakeVerifier, context: createUserContext(apiPool) },
      });
    });

    afterAll(async () => {
      await app?.close();
      await keyed?.close();
      await keyedV1Only?.close();
      await apiPool?.end();
      await admin?.end();
    });

    // ----------------------------------------------------------------------------------------------------------------------
    describe('authentication, permissions and tenant isolation of the read and write surfaces', () => {
      const platformReads = [
        '/v1/platform/payment-providers',
        '/v1/platform/return-code-classes',
        '/v1/platform/account-format-rules',
        '/v1/platform/fingerprint-key-versions',
        '/v1/platform/accounts',
        '/v1/platform/settlement-accounts',
        '/v1/platform/merchants',
        '/v1/platform/payment-configs',
        '/v1/platform/features',
        '/v1/platform/feature-change-requests',
      ];

      it('refuses anonymous callers with 401 and a borrower token with 403 on every route family', async () => {
        for (const url of [
          ...platformReads,
          '/v1/lender/merchants',
          '/v1/lender/payment-configs',
          '/v1/lender/features',
        ]) {
          expect((await get(url, null)).statusCode, url).toBe(401);
          const borrower = await get(url, ids.borrower);
          expect(borrower.statusCode, url).toBe(403);
          expect(code(borrower)).toBe('staff_only');
        }
        const provider = {
          provider: 'testpay',
          displayName: 'Testpay',
          kind: 'payment',
          status: 'draft',
          evidenceLabel: 'unverified',
        };
        expect((await post('/v1/platform/payment-providers', null, provider)).statusCode).toBe(401);
        const claim = { lenderId: ids.lenderA, provider: 'testpay', merchantRef: 'MER-NOBODY-1' };
        expect((await post('/v1/lender/merchants', null, claim)).statusCode).toBe(401);
        expect((await post('/v1/lender/merchants', ids.borrower, claim)).statusCode).toBe(403);
        expect(
          (await post('/v1/platform/accounts', null, registerBody(newSample()))).statusCode,
        ).toBe(401);
      });

      it('requires the second factor: an aal1 staff token is refused on reads and on writes', async () => {
        const read = await call(
          keyed,
          'GET',
          '/v1/platform/payment-providers',
          ids.p1,
          undefined,
          null,
          'aal1',
        );
        expect(read.statusCode).toBe(401);
        expect(code(read)).toBe('mfa_required');
        const write = await call(
          keyed,
          'POST',
          '/v1/platform/features/kill',
          ids.p1,
          {
            lenderId: ids.lenderA,
            feature: 'payments',
            reason: 'testing the second factor refusal',
          },
          undefined,
          'aal1',
        );
        expect(write.statusCode).toBe(401);
        expect(code(write)).toBe('mfa_required');
        const lender = await call(
          keyed,
          'GET',
          '/v1/lender/payment-configs',
          ids.l1,
          undefined,
          null,
          'aal1',
        );
        expect(lender.statusCode).toBe(401);
      });

      it('answers 403 forbidden on platform reads to lender staff and to a platform user without the permission', async () => {
        for (const url of platformReads) {
          for (const user of [ids.l1, ids.l2, ids.la, ids.b1, ids.p3]) {
            const res = await get(url, user);
            expect(res.statusCode, `${url} as ${user}`).toBe(403);
            expect(code(res)).toBe('forbidden');
          }
        }
        // The two registry permissions are separate from the provider and the feature permissions.
        expect((await get('/v1/platform/payment-providers', ids.p2)).statusCode).toBe(403);
        expect((await get('/v1/platform/features', ids.p2)).statusCode).toBe(200);
        expect((await get('/v1/platform/accounts', ids.p1)).statusCode).toBe(200);
        expect((await get('/v1/platform/accounts', ids.p2)).statusCode).toBe(200);
        expect((await get('/v1/platform/features', ids.p1)).statusCode).toBe(200);
      });

      it('answers 403 on lender reads to someone who holds no payment permission in the lender, and to a platform person', async () => {
        for (const url of [
          '/v1/lender/merchants',
          '/v1/lender/payment-configs',
          '/v1/lender/payment-providers',
          '/v1/lender/settlement-accounts/registry-status',
        ]) {
          expect((await get(url, ids.l1)).statusCode, url).toBe(200);
          expect((await get(url, ids.p3)).statusCode, `${url} platform without permission`).toBe(
            403,
          );
        }
        // Lender B cannot ask for lender A's view of itself.
        expect((await get(`/v1/lender/merchants?lenderId=${ids.lenderA}`, ids.b1)).statusCode).toBe(
          403,
        );
        expect(
          (await get(`/v1/lender/payment-configs?lenderId=${ids.lenderA}`, ids.b1)).statusCode,
        ).toBe(403);
        expect((await get(`/v1/lender/features?lenderId=${ids.lenderA}`, ids.b1)).statusCode).toBe(
          403,
        );
      });

      it('rejects unknown query fields, malformed ids and unknown body fields with 422 and never echoes the value', async () => {
        const badId = await get('/v1/platform/accounts/not-a-uuid', ids.p1);
        expect(badId.statusCode).toBe(422);
        expect(code(badId)).toBe('validation_failed');
        const unknownQuery = await get('/v1/platform/accounts?secret=1234567890', ids.p1);
        expect(unknownQuery.statusCode).toBe(422);
        expect(unknownQuery.body).not.toContain('1234567890');
        const unknownBody = await post('/v1/platform/payment-providers', ids.p1, {
          provider: 'testpay',
          displayName: 'Testpay',
          kind: 'payment',
          status: 'draft',
          evidenceLabel: 'unverified',
          apiKey: 'sk_live_abcdefghijklmnop',
        });
        expect(unknownBody.statusCode).toBe(422);
        expect(unknownBody.body).not.toContain('sk_live');
      });

      it('requires an Idempotency-Key on every write', async () => {
        const body = {
          lenderId: ids.lenderA,
          feature: 'payments',
          reason: 'testing the idempotency key requirement',
        };
        const res = await call(keyed, 'POST', '/v1/platform/features/kill', ids.p1, body, null);
        expect(res.statusCode).toBe(400);
        expect(code(res)).toBe('idempotency_key_required');
      });
    });

    // ----------------------------------------------------------------------------------------------------------------------
    describe('payment providers and return-code classes (platform)', () => {
      it('registers a provider as a draft, approves it with evidence, and shows lenders only the approved ones without evidence', async () => {
        const draft = ok(
          await post('/v1/platform/payment-providers', ids.p1, {
            provider: 'testpay',
            displayName: 'Testpay (SAMPLE provider)',
            kind: 'payment_and_mandate',
            status: 'draft',
            evidenceLabel: 'unverified',
          }),
        );
        expect(draft.json()).toEqual({ provider: 'testpay', status: 'draft' });
        expect(
          (await get('/v1/lender/payment-providers', ids.l1)).json<{ items: unknown[] }>().items,
        ).toEqual([]);

        const approved = ok(
          await post('/v1/platform/payment-providers', ids.p1, {
            provider: 'testpay',
            displayName: 'Testpay (SAMPLE provider)',
            kind: 'payment_and_mandate',
            status: 'approved',
            authorisationEvidenceRef: 'SAMPLE-PA-AUTHORISATION-2026',
            evidenceLabel: 'likely',
          }),
        );
        expect(approved.json()).toEqual({ provider: 'testpay', status: 'approved' });
        const list = ok(await get('/v1/platform/payment-providers', ids.p1)).json<{
          items: {
            provider: string;
            status: string;
            authorisationEvidenceRef: string | null;
            evidenceLabel: string;
          }[];
        }>();
        expect(list.items).toEqual([
          expect.objectContaining({
            provider: 'testpay',
            status: 'approved',
            authorisationEvidenceRef: 'SAMPLE-PA-AUTHORISATION-2026',
            evidenceLabel: 'likely',
          }),
        ]);
        const choices = ok(await get('/v1/lender/payment-providers', ids.l1)).json<{
          items: Record<string, unknown>[];
        }>();
        expect(choices.items).toEqual([
          {
            provider: 'testpay',
            displayName: 'Testpay (SAMPLE provider)',
            kind: 'payment_and_mandate',
            status: 'approved',
          },
        ]);
      });

      it('refuses a suspension without a reason, free text that looks like a number, other roles, and a replayed key with other content', async () => {
        const base = {
          provider: 'testpay',
          displayName: 'Testpay (SAMPLE provider)',
          kind: 'payment_and_mandate',
          evidenceLabel: 'likely',
        };
        const noReason = await post('/v1/platform/payment-providers', ids.p1, {
          ...base,
          status: 'suspended',
        });
        expect(noReason.statusCode).toBe(422);
        expect(code(noReason)).toBe('reason_required');
        const personal = await post('/v1/platform/payment-providers', ids.p1, {
          ...base,
          status: 'suspended',
          reason: 'call the contact on 9876543210 about it',
        });
        expect(personal.statusCode).toBe(422);
        expect(code(personal)).toBe('validation_failed');
        expect(personal.body).not.toContain('9876543210');
        for (const user of [ids.p2, ids.p3, ids.l1]) {
          expect(
            (await post('/v1/platform/payment-providers', user, { ...base, status: 'draft' }))
              .statusCode,
          ).toBe(403);
        }
        const key = `it-${randomUUID()}`;
        ok(
          await post(
            '/v1/platform/payment-providers',
            ids.p1,
            {
              ...base,
              status: 'approved',
              authorisationEvidenceRef: 'SAMPLE-PA-AUTHORISATION-2026',
            },
            key,
          ),
        );
        const replay = await post(
          '/v1/platform/payment-providers',
          ids.p1,
          { ...base, status: 'approved', authorisationEvidenceRef: 'SAMPLE-PA-AUTHORISATION-2026' },
          key,
        );
        expect(replay.statusCode).toBe(200);
        expect(replay.headers['idempotent-replayed']).toBe('true');
        const reused = await post(
          '/v1/platform/payment-providers',
          ids.p1,
          { ...base, status: 'draft' },
          key,
        );
        expect(reused.statusCode).toBe(422);
        expect(code(reused)).toBe('idempotency_key_reused');
      });

      it('classifies a return code, replaces the classification with a new one and keeps the old one as retired', async () => {
        const first = ok(
          await post('/v1/platform/return-code-classes', ids.p1, {
            provider: 'testpay',
            code: 'U16',
            class: 'insufficient_funds',
            evidenceRef: 'SAMPLE-RC-DOC-1',
          }),
        );
        expect(first.json()).toEqual({
          provider: 'testpay',
          code: 'U16',
          class: 'insufficient_funds',
          status: 'set',
        });
        ok(
          await post('/v1/platform/return-code-classes', ids.p1, {
            provider: 'testpay',
            code: 'U16',
            class: 'technical',
            evidenceRef: 'SAMPLE-RC-DOC-2',
          }),
        );
        const active = ok(
          await get('/v1/platform/return-code-classes?provider=testpay', ids.p1),
        ).json<{ items: { code: string; class: string }[] }>();
        expect(active.items).toEqual([
          expect.objectContaining({ code: 'U16', class: 'technical' }),
        ]);
        const retired = ok(
          await get('/v1/platform/return-code-classes?status=retired', ids.p1),
        ).json<{ items: { class: string }[] }>();
        expect(retired.items.map((i) => i.class)).toEqual(['insufficient_funds']);
        const unknown = await post('/v1/platform/return-code-classes', ids.p1, {
          provider: 'nosuch',
          code: 'U16',
          class: 'other',
          evidenceRef: 'SAMPLE-RC-DOC-3',
        });
        expect(unknown.statusCode).toBe(422);
        expect(code(unknown)).toBe('return_code_invalid');
        expect(
          (
            await post('/v1/platform/return-code-classes', ids.p2, {
              provider: 'testpay',
              code: 'U17',
              class: 'other',
              evidenceRef: 'SAMPLE-RC-DOC-4',
            })
          ).statusCode,
        ).toBe(403);
      });
    });

    // ----------------------------------------------------------------------------------------------------------------------
    describe('the registry fails closed until a key version and a format rule are approved by two different people', () => {
      it('refuses to register an account while no fingerprint key version is active', async () => {
        const sample = newSample();
        const res = await post('/v1/platform/accounts', ids.p1, registerBody(sample));
        expect(res.statusCode, res.body).toBe(409);
        expect(code(res)).toBe('key_version_not_active');
        expect(await q('select 1 from payments.account_registry')).toHaveLength(0);
      });

      it('proposes key version 1 by one person and activates it by a different one', async () => {
        const wrongNext = await post('/v1/platform/fingerprint-key-versions', ids.p1, {
          version: 3,
        });
        expect(wrongNext.statusCode).toBe(422);
        expect(code(wrongNext)).toBe('key_version_invalid');
        expect(
          (await post('/v1/platform/fingerprint-key-versions', ids.p2, { version: 1 })).statusCode,
        ).toBe(403);
        const proposed = ok(
          await post('/v1/platform/fingerprint-key-versions', ids.p1, {
            version: 1,
            note: 'first key, SAMPLE',
          }),
          201,
        );
        expect(proposed.json()).toEqual({ keyVersion: 1, status: 'proposed' });
        // The proposer holds the manage permission, not the verify permission, so cannot approve; a second proposal is refused.
        expect(
          (await post('/v1/platform/fingerprint-key-versions/1/approve', ids.p1, {})).statusCode,
        ).toBe(403);
        const dup = await post('/v1/platform/fingerprint-key-versions', ids.p1, { version: 2 });
        expect(code(dup)).toBe('proposal_open');
        expect(
          (await post('/v1/platform/fingerprint-key-versions/0/approve', ids.p2, {})).statusCode,
        ).toBe(422);
        expect(
          (await post('/v1/platform/fingerprint-key-versions/9/approve', ids.p2, {})).statusCode,
        ).toBe(404);
        const approved = ok(
          await post('/v1/platform/fingerprint-key-versions/1/approve', ids.p2, {}),
        );
        expect(approved.json()).toEqual({ keyVersion: 1, status: 'active' });
        const list = ok(await get('/v1/platform/fingerprint-key-versions', ids.p1)).json<{
          items: { keyVersion: number; status: string; proposedBy: string; approvedBy: string }[];
        }>();
        expect(list.items).toEqual([
          expect.objectContaining({
            keyVersion: 1,
            status: 'active',
            proposedBy: ids.p1,
            approvedBy: ids.p2,
          }),
        ]);
        // The response never carries key material.
        expect(JSON.stringify(list)).not.toMatch(/[A-Za-z0-9+/]{43}=/);
      });

      it('still refuses to register while the only format rule is the unverified, unapproved seed', async () => {
        const seeded = ok(await get('/v1/platform/account-format-rules', ids.p1)).json<{
          items: Record<string, unknown>[];
        }>();
        expect(seeded.items).toEqual([
          expect.objectContaining({
            country: 'IN',
            accountType: 'bank_account',
            version: 1,
            minDigits: 9,
            maxDigits: 18,
            status: 'draft',
            evidenceLabel: 'unverified',
            draftedBy: null,
            submittedBy: null,
            approvedBy: null,
          }),
        ]);
        state.seedRule = String(seeded.items[0]?.id);
        const res = await post('/v1/platform/accounts', ids.p1, registerBody(newSample()));
        expect(res.statusCode).toBe(409);
        expect(code(res)).toBe('account_format_unvalidated');
        expect(await q('select 1 from payments.account_registry')).toHaveLength(0);
      });

      it('takes the seeded rule through submit by one person and approval by another, and keeps the evidence label honest', async () => {
        // Approving a rule nobody proposed is refused; a person without the verify permission cannot approve at all.
        const early = await post(
          `/v1/platform/account-format-rules/${state.seedRule}/approve`,
          ids.p2,
          {},
        );
        expect(early.statusCode).toBe(409);
        expect(code(early)).toBe('not_submitted');
        expect(
          (await post(`/v1/platform/account-format-rules/${state.seedRule}/submit`, ids.p2, {}))
            .statusCode,
        ).toBe(403);
        const submitted = ok(
          await post(`/v1/platform/account-format-rules/${state.seedRule}/submit`, ids.p1, {}),
        );
        expect(submitted.json()).toEqual({ id: state.seedRule, status: 'draft' });
        expect(
          (await post(`/v1/platform/account-format-rules/${state.seedRule}/approve`, ids.p1, {}))
            .statusCode,
        ).toBe(403);
        expect(
          (await post(`/v1/platform/account-format-rules/${state.seedRule}/approve`, ids.p3, {}))
            .statusCode,
        ).toBe(403);
        const approved = ok(
          await post(`/v1/platform/account-format-rules/${state.seedRule}/approve`, ids.p2, {
            note: 'approved as a recorded platform decision, source still to come',
          }),
        );
        expect(approved.json()).toEqual({ id: state.seedRule, status: 'approved' });
        const rules = ok(
          await get('/v1/platform/account-format-rules?status=approved', ids.p2),
        ).json<{
          items: {
            id: string;
            evidenceLabel: string;
            approvedBy: string;
            draftedBy: string | null;
            submittedBy: string;
          }[];
        }>();
        // Approval is a platform decision, not evidence: the label is still unverified.
        expect(rules.items).toEqual([
          expect.objectContaining({
            id: state.seedRule,
            evidenceLabel: 'unverified',
            approvedBy: ids.p2,
            submittedBy: ids.p1,
          }),
        ]);
        rule = {
          ruleId: state.seedRule as string,
          country: 'IN',
          accountType: 'bank_account',
          minDigits: 9,
          maxDigits: 18,
          status: 'unverified',
          source: null,
        };
      });

      it('validates a rule draft by shape and by the database, and lists nothing to a lender', async () => {
        const base = {
          country: 'IN',
          accountType: 'bank_account',
          minDigits: 9,
          maxDigits: 18,
          ifscRequired: true,
          evidenceLabel: 'unverified',
          sourceNote: 'SAMPLE: owner supplied range, no document yet',
        };
        expect((await post('/v1/platform/account-format-rules', ids.p2, base)).statusCode).toBe(
          403,
        );
        const inverted = await post('/v1/platform/account-format-rules', ids.p1, {
          ...base,
          minDigits: 20,
          maxDigits: 12,
        });
        expect(inverted.statusCode).toBe(422);
        expect(code(inverted)).toBe('rule_invalid');
        const shortNote = await post('/v1/platform/account-format-rules', ids.p1, {
          ...base,
          sourceNote: 'x',
        });
        expect(shortNote.statusCode).toBe(422);
        const lowerCountry = await post('/v1/platform/account-format-rules', ids.p1, {
          ...base,
          country: 'in',
        });
        expect(lowerCountry.statusCode).toBe(422);
        expect(code(lowerCountry)).toBe('validation_failed');
        expect((await get('/v1/platform/account-format-rules', ids.l1)).statusCode).toBe(403);
      });
    });

    // ----------------------------------------------------------------------------------------------------------------------
    describe('registering an account: the number is fingerprinted once and dropped', () => {
      it('registers an account and answers with the registry id, the masked reference and the status only', async () => {
        const sample = newSample();
        state.sampleE = JSON.stringify(sample);
        const key = `it-${randomUUID()}`;
        const res = ok(await post('/v1/platform/accounts', ids.p1, registerBody(sample), key), 201);
        const body = res.json<Record<string, unknown>>();
        expect(Object.keys(body).sort()).toEqual(['id', 'maskedRef', 'status']);
        expect(body.maskedRef).toBe(`XXXXXX${sample.accountNumber.slice(-4)}`);
        expect(body.status).toBe('unverified');
        state.regE = String(body.id);

        // The stored fingerprint is the adapters' keyed computation under key version 1; the number is nowhere in the row.
        const row = (
          await q<Record<string, unknown>>(
            'select * from payments.account_registry where id = $1',
            [state.regE],
          )
        )[0];
        expect(row?.fingerprint).toBe(fingerprintOf(sample, 1).fingerprint);
        expect(row).toMatchObject({
          key_version: 1,
          masked_ref: body.maskedRef,
          format_rule_id: state.seedRule,
          format_validated: true,
          verification_status: 'unverified',
          registered_by: ids.p1,
          owner_org_id: ids.lenderA,
        });
        expect(JSON.stringify(row)).not.toContain(sample.accountNumber);

        // The same key and request replay the same answer; the same key with another account is refused.
        const replay = await post('/v1/platform/accounts', ids.p1, registerBody(sample), key);
        expect(replay.statusCode).toBe(201);
        expect(replay.headers['idempotent-replayed']).toBe('true');
        expect(replay.json()).toEqual(body);
        const other = newSample();
        const reused = await post('/v1/platform/accounts', ids.p1, registerBody(other), key);
        expect(reused.statusCode).toBe(422);
        expect(code(reused)).toBe('idempotency_key_reused');
        expect(await q('select 1 from payments.account_registry')).toHaveLength(1);
      });

      it('refuses the same real account again, under any owner, and keeps one entry per account', async () => {
        const sample = JSON.parse(state.sampleE ?? '{}') as Sample;
        const again = await post('/v1/platform/accounts', ids.p1, registerBody(sample));
        expect(again.statusCode).toBe(409);
        expect(code(again)).toBe('account_already_registered');
        const otherOwner = await post(
          '/v1/platform/accounts',
          ids.p1,
          registerBody(sample, {
            ownerKind: 'lender',
            ownerOrgId: ids.lenderB,
            legalOwnerName: 'Beta Finance Private Limited',
          }),
        );
        expect(otherOwner.statusCode).toBe(409);
        expect(code(otherOwner)).toBe('account_already_registered');
        // Same account, branch part of the IFSC changed: still the same account.
        const otherBranch = await post(
          '/v1/platform/accounts',
          ids.p1,
          registerBody({ ...sample, ifsc: `${sample.ifsc.slice(0, 4)}0${alnum(6)}` }),
        );
        expect(code(otherBranch)).toBe('account_already_registered');
        expect(await q('select 1 from payments.account_registry')).toHaveLength(1);
      });

      it('validates the number against the approved rule and the request by shape, and never echoes the number', async () => {
        const cases: [string, Sample, number, string][] = [
          [
            'too short for the rule',
            { accountNumber: digits(8), ifsc: newIfsc() },
            422,
            'account_number_invalid',
          ],
          [
            'too long for the rule',
            { accountNumber: digits(19), ifsc: newIfsc() },
            422,
            'account_number_invalid',
          ],
          [
            'letters in the number',
            { accountNumber: `${digits(11)}X`, ifsc: newIfsc() },
            422,
            'validation_failed',
          ],
          [
            'spaces in the number',
            { accountNumber: `${digits(6)} ${digits(6)}`, ifsc: newIfsc() },
            422,
            'validation_failed',
          ],
          [
            'an IFSC that is not one',
            { accountNumber: digits(12), ifsc: 'NOTANIFSC' },
            422,
            'validation_failed',
          ],
        ];
        for (const [label, sample, status, expected] of cases) {
          used.push(sample);
          const res = await post('/v1/platform/accounts', ids.p1, registerBody(sample));
          expect(res.statusCode, label).toBe(status);
          expect(code(res), label).toBe(expected);
          expect(res.body, label).not.toContain(sample.accountNumber);
          expect(res.body, label).not.toContain(sample.ifsc);
        }
        const sample = newSample();
        const missingOwner = await post(
          '/v1/platform/accounts',
          ids.p1,
          registerBody(sample, { ownerOrgId: undefined }),
        );
        expect(code(missingOwner)).toBe('owner_invalid');
        const platformOwned = await post(
          '/v1/platform/accounts',
          ids.p1,
          registerBody(sample, { ownerOrgId: ids.platformOrg }),
        );
        expect(code(platformOwned)).toBe('owner_invalid');
        const udofinSettles = await post(
          '/v1/platform/accounts',
          ids.p1,
          registerBody(sample, {
            ownerKind: 'udofin',
            ownerOrgId: undefined,
            legalOwnerName: 'Udofin Technologies Private Limited',
          }),
        );
        expect(code(udofinSettles)).toBe('purposes_invalid');
        const personal = await post(
          '/v1/platform/accounts',
          ids.p1,
          registerBody(sample, { legalOwnerName: 'ABCDE1234F proprietor' }),
        );
        expect(code(personal)).toBe('validation_failed');
        const extra = await post('/v1/platform/accounts', ids.p1, {
          ...registerBody(sample),
          fingerprint: 'a'.repeat(64),
        });
        expect(extra.statusCode).toBe(422);
        const badDate = await post(
          '/v1/platform/accounts',
          ids.p1,
          registerBody(sample, { effectiveFrom: '2026-02-30x' }),
        );
        expect(badDate.statusCode).toBe(422);
        const datesBackwards = await post(
          '/v1/platform/accounts',
          ids.p1,
          registerBody(sample, { effectiveFrom: '2026-10-01', effectiveTo: '2026-09-01' }),
        );
        expect(code(datesBackwards)).toBe('dates_invalid');
        expect(await q('select 1 from payments.account_registry')).toHaveLength(1);
      });

      it('lets only a registry manager register: the verifier, a lender user and a platform user without it get 403', async () => {
        const sample = newSample();
        for (const user of [ids.p2, ids.p3, ids.l1, ids.b1, ids.la]) {
          const res = await post('/v1/platform/accounts', user, registerBody(sample));
          expect(res.statusCode, user).toBe(403);
          expect(res.body).not.toContain(sample.accountNumber);
        }
        expect(
          (await post('/v1/platform/accounts', ids.borrower, registerBody(sample))).statusCode,
        ).toBe(403);
        expect(await q('select 1 from payments.account_registry')).toHaveLength(1);
      });

      it('answers 503 key_management_unavailable when this process has no fingerprint key, after checking the permission', async () => {
        const sample = newSample();
        const denied = await call(
          app,
          'POST',
          '/v1/platform/accounts',
          ids.p2,
          registerBody(sample),
        );
        expect(denied.statusCode).toBe(403);
        const res = await call(app, 'POST', '/v1/platform/accounts', ids.p1, registerBody(sample));
        expect(res.statusCode, res.body).toBe(503);
        expect(code(res)).toBe('key_management_unavailable');
        expect(res.body).not.toContain(sample.accountNumber);
        expect(await q('select 1 from payments.account_registry')).toHaveLength(1);
        // The full application declares the module's routes (the lead wires the key source in).
        const declared = app.registeredRoutes.map((r) => `${r.method} ${r.url}`);
        expect(declared).toContain('POST /v1/platform/accounts');
        expect(declared).toContain('POST /v1/lender/payment-configs');
        expect(declared).toContain('POST /v1/platform/features/kill');
      });

      it('lists and reads registrations masked, never with a fingerprint, and hides them from every lender', async () => {
        const list = ok(await get('/v1/platform/accounts', ids.p2));
        const page = list.json<{ items: Record<string, unknown>[]; nextCursor: string | null }>();
        expect(page.items).toHaveLength(1);
        expect(page.nextCursor).toBeNull();
        expect(Object.keys(page.items[0] ?? {})).not.toContain('fingerprint');
        expect(page.items[0]).toMatchObject({
          id: state.regE,
          verificationStatus: 'unverified',
          ownerKind: 'lender',
          ownerOrgId: ids.lenderA,
          keyVersion: 1,
          permittedPurposes: ['repayment_settlement'],
          legalOwnerName: 'Alpha Finance Private Limited',
        });
        const sample = JSON.parse(state.sampleE ?? '{}') as Sample;
        expect(list.body).not.toContain(fingerprintOf(sample, 1).fingerprint);
        const one = ok(await get(`/v1/platform/accounts/${state.regE}`, ids.p1)).json<
          Record<string, unknown>
        >();
        expect(one.maskedRef).toBe(`XXXXXX${sample.accountNumber.slice(-4)}`);
        expect((await get(`/v1/platform/accounts/${randomUUID()}`, ids.p1)).statusCode).toBe(404);
        for (const user of [ids.l1, ids.la, ids.b1]) {
          expect((await get(`/v1/platform/accounts/${state.regE}`, user)).statusCode).toBe(403);
        }
        expect(
          (await get('/v1/platform/accounts?status=verified', ids.p1)).json<{ items: unknown[] }>()
            .items,
        ).toHaveLength(0);
      });

      it('pages the registry with a keyset cursor and rejects a tampered cursor', async () => {
        const sample = newSample();
        state.sampleF = JSON.stringify(sample);
        const second = ok(
          await post(
            '/v1/platform/accounts',
            ids.p1,
            registerBody(sample, {
              ownerKind: 'udofin',
              ownerOrgId: undefined,
              legalOwnerName: 'Udofin Technologies Private Limited',
              permittedPurposes: ['fee_collection'],
            }),
          ),
          201,
        );
        state.regF = String(second.json<{ id: string }>().id);
        const firstPage = ok(await get('/v1/platform/accounts?limit=1', ids.p1)).json<{
          items: { id: string }[];
          nextCursor: string | null;
        }>();
        expect(firstPage.items.map((i) => i.id)).toEqual([state.regF]);
        expect(firstPage.nextCursor).not.toBeNull();
        const nextPage = ok(
          await get(`/v1/platform/accounts?limit=1&cursor=${firstPage.nextCursor}`, ids.p1),
        ).json<{ items: { id: string }[]; nextCursor: string | null }>();
        expect(nextPage.items.map((i) => i.id)).toEqual([state.regE]);
        expect(nextPage.nextCursor).toBeNull();
        const bad = await get('/v1/platform/accounts?cursor=%7B%7D', ids.p1);
        expect(bad.statusCode).toBe(400);
        expect(code(bad)).toBe('invalid_cursor');
      });

      it('verifies by a different person with an evidence label, once, and rejects or revokes with a reason', async () => {
        const evidence = { evidenceRef: 'SAMPLE-BANK-LETTER-2026-1' };
        expect(
          (await post(`/v1/platform/accounts/${state.regE}/verify`, ids.p1, evidence)).statusCode,
        ).toBe(403);
        expect(
          (await post(`/v1/platform/accounts/${state.regE}/verify`, ids.l2, evidence)).statusCode,
        ).toBe(403);
        const noEvidence = await post(`/v1/platform/accounts/${state.regE}/verify`, ids.p2, {
          evidenceRef: '  ',
        });
        expect(noEvidence.statusCode).toBe(422);
        const key = `it-${randomUUID()}`;
        const verified = ok(
          await post(`/v1/platform/accounts/${state.regE}/verify`, ids.p2, evidence, key),
        );
        expect(verified.json()).toEqual({ id: state.regE, status: 'verified' });
        expect(
          (await post(`/v1/platform/accounts/${state.regE}/verify`, ids.p2, evidence, key)).headers[
            'idempotent-replayed'
          ],
        ).toBe('true');
        const again = await post(`/v1/platform/accounts/${state.regE}/verify`, ids.p2, {
          evidenceRef: 'SAMPLE-OTHER-EVIDENCE',
        });
        expect(again.statusCode).toBe(409);
        expect(code(again)).toBe('not_unverified');
        expect(
          (await post(`/v1/platform/accounts/${randomUUID()}/verify`, ids.p2, evidence)).statusCode,
        ).toBe(404);

        // Reject: only an unverified entry; the reason must be a real reason and must not hold a number.
        const reasonShort = await post(`/v1/platform/accounts/${state.regF}/reject`, ids.p1, {
          reason: 'bad',
        });
        expect(reasonShort.statusCode).toBe(422);
        const reasonNumber = await post(`/v1/platform/accounts/${state.regF}/reject`, ids.p1, {
          reason: 'the account 912345678901 is wrong',
        });
        expect(reasonNumber.statusCode).toBe(422);
        expect(reasonNumber.body).not.toContain('912345678901');
        const rejected = ok(
          await post(`/v1/platform/accounts/${state.regF}/reject`, ids.p1, {
            reason: 'rejected: owner letter does not match',
          }),
        );
        expect(rejected.json()).toEqual({ id: state.regF, status: 'rejected' });
        const verifiedReject = await post(`/v1/platform/accounts/${state.regE}/reject`, ids.p1, {
          reason: 'too late to reject a verified entry',
        });
        expect(code(verifiedReject)).toBe('not_unverified');
        const row = ok(await get(`/v1/platform/accounts/${state.regF}`, ids.p1)).json<
          Record<string, unknown>
        >();
        expect(row).toMatchObject({
          verificationStatus: 'rejected',
          rejectionReason: 'rejected: owner letter does not match',
        });
        expect(
          (
            await post(`/v1/platform/accounts/${state.regF}/revoke`, ids.p3, {
              reason: 'not allowed to revoke at all',
            })
          ).statusCode,
        ).toBe(403);
        const verifiedRow = ok(await get(`/v1/platform/accounts/${state.regE}`, ids.p2)).json<
          Record<string, unknown>
        >();
        expect(verifiedRow).toMatchObject({
          verificationStatus: 'verified',
          verifiedBy: ids.p2,
          evidenceRef: 'SAMPLE-BANK-LETTER-2026-1',
        });
      });
    });

    // ----------------------------------------------------------------------------------------------------------------------
    describe('the rule is data: a newer version governs, a retired one fails closed', () => {
      it('validates a number against the newest approved rule and refuses everything once no rule is approved', async () => {
        const narrow = ok(
          await post('/v1/platform/account-format-rules', ids.p1, {
            country: 'IN',
            accountType: 'bank_account',
            minDigits: 14,
            maxDigits: 16,
            ifscRequired: true,
            evidenceLabel: 'unverified',
            sourceNote: 'SAMPLE: narrower range used to test versioning',
          }),
          201,
        ).json<{ id: string; status: string }>();
        expect(narrow.status).toBe('draft');
        // A draft governs nothing yet.
        const sample12 = newSample(12);
        const stillOld = ok(
          await post('/v1/platform/accounts', ids.p1, registerBody(sample12)),
          201,
        );
        state.regG = stillOld.json<{ id: string }>().id;
        ok(await post(`/v1/platform/account-format-rules/${narrow.id}/approve`, ids.p2, {}));
        expect(
          (await get('/v1/platform/account-format-rules?status=retired', ids.p1))
            .json<{ items: { id: string }[] }>()
            .items.map((r) => r.id),
        ).toEqual([state.seedRule]);
        const refused = await post('/v1/platform/accounts', ids.p1, registerBody(newSample(12)));
        expect(code(refused)).toBe('account_number_invalid');
        const accepted = ok(
          await post(
            '/v1/platform/accounts',
            ids.p1,
            registerBody(newSample(15), { legalOwnerName: 'Alpha Finance Private Limited' }),
          ),
          201,
        );
        state.regH = accepted.json<{ id: string }>().id;
        expect(
          (
            await q<{ format_rule_id: string }>(
              'select format_rule_id from payments.account_registry where id = $1',
              [state.regH],
            )
          )[0]?.format_rule_id,
        ).toBe(narrow.id);

        // Retire it with a reason: no approved rule is left, so nothing can be registered.
        expect(
          (
            await post(`/v1/platform/account-format-rules/${narrow.id}/retire`, ids.p1, {
              reason: 'short',
            })
          ).statusCode,
        ).toBe(422);
        const retired = ok(
          await post(`/v1/platform/account-format-rules/${narrow.id}/retire`, ids.p1, {
            reason: 'retired to test failing closed',
          }),
        );
        expect(retired.json()).toEqual({ id: narrow.id, status: 'retired' });
        const none = await post('/v1/platform/accounts', ids.p1, registerBody(newSample(15)));
        expect(none.statusCode).toBe(409);
        expect(code(none)).toBe('account_format_unvalidated');

        // Restore the original range as a new, approved version.
        const restored = ok(
          await post('/v1/platform/account-format-rules', ids.p1, {
            country: 'IN',
            accountType: 'bank_account',
            minDigits: 9,
            maxDigits: 18,
            ifscRequired: true,
            evidenceLabel: 'unverified',
            sourceNote: 'SAMPLE: the owner range of 9 to 18 digits again',
          }),
          201,
        ).json<{ id: string }>();
        ok(await post(`/v1/platform/account-format-rules/${restored.id}/approve`, ids.p2, {}));
        rule = { ...rule, ruleId: restored.id };
        state.rule3 = restored.id;
        ok(await post('/v1/platform/accounts', ids.p1, registerBody(newSample(12))), 201);
      });
    });

    // ----------------------------------------------------------------------------------------------------------------------
    describe('merchants', () => {
      it('lets a lender claim its merchant identifier once, and nobody else', async () => {
        const claim = { lenderId: ids.lenderA, provider: 'testpay', merchantRef: 'MER-ALPHA-0001' };
        const created = ok(await post('/v1/lender/merchants', ids.l1, claim), 201);
        expect(created.json()).toMatchObject({ status: 'active' });
        state.merchantA = created.json<{ id: string }>().id;
        // Idempotent for the same lender (a new key, the same identifier: the same entry).
        expect(
          ok(await post('/v1/lender/merchants', ids.l1, claim), 201).json<{ id: string }>().id,
        ).toBe(state.merchantA);
        const stolen = await post('/v1/lender/merchants', ids.b1, {
          ...claim,
          lenderId: ids.lenderB,
        });
        expect(stolen.statusCode).toBe(409);
        expect(code(stolen)).toBe('merchant_already_claimed');
        expect((await post('/v1/lender/merchants', ids.b1, claim)).statusCode).toBe(403);
        expect((await post('/v1/lender/merchants', ids.l2, claim)).statusCode).toBe(403);
        expect((await post('/v1/lender/merchants', ids.p1, claim)).statusCode).toBe(403);
        expect(
          code(await post('/v1/lender/merchants', ids.l1, { ...claim, provider: 'nosuch' })),
        ).toBe('provider_invalid');
        expect(
          (await post('/v1/lender/merchants', ids.l1, { ...claim, merchantRef: 'x y' })).statusCode,
        ).toBe(422);
        const merchantB = ok(
          await post('/v1/lender/merchants', ids.b1, {
            lenderId: ids.lenderB,
            provider: 'testpay',
            merchantRef: 'MER-BETA-0001',
          }),
          201,
        );
        state.merchantB = merchantB.json<{ id: string }>().id;
      });

      it('shows each lender its own claims and the platform every claim, with the verification state', async () => {
        const mine = ok(await get('/v1/lender/merchants', ids.l1)).json<{
          items: { id: string; verificationStatus: string; ownerOrgId: string }[];
        }>();
        expect(mine.items.map((m) => m.id)).toEqual([state.merchantA]);
        expect(mine.items[0]).toMatchObject({
          verificationStatus: 'unverified',
          ownerOrgId: ids.lenderA,
        });
        expect(
          ok(await get('/v1/lender/merchants', ids.la)).json<{ items: unknown[] }>().items,
        ).toHaveLength(1);
        expect(
          ok(await get('/v1/lender/merchants', ids.b1))
            .json<{ items: { id: string }[] }>()
            .items.map((m) => m.id),
        ).toEqual([state.merchantB]);
        const all = ok(await get('/v1/platform/merchants', ids.p1)).json<{
          items: { id: string }[];
        }>();
        expect(all.items.map((m) => m.id).sort()).toEqual(
          [state.merchantA, state.merchantB].sort(),
        );
        expect(
          ok(
            await get(
              `/v1/platform/merchants?lenderId=${ids.lenderB}&verification=unverified`,
              ids.p1,
            ),
          ).json<{ items: unknown[] }>().items,
        ).toHaveLength(1);
      });

      it('verifies a claim against evidence by the platform, once, and revokes with a reason', async () => {
        expect(
          (
            await post(`/v1/platform/merchants/${state.merchantA}/verify`, ids.l1, {
              evidenceRef: 'SAMPLE-PROVIDER-ONBOARDING-1',
            })
          ).statusCode,
        ).toBe(403);
        expect(
          (
            await post(`/v1/platform/merchants/${state.merchantA}/verify`, ids.p2, {
              evidenceRef: 'SAMPLE-PROVIDER-ONBOARDING-1',
            })
          ).statusCode,
        ).toBe(403);
        expect(
          (
            await post(`/v1/platform/merchants/${state.merchantA}/verify`, ids.p1, {
              evidenceRef: '',
            })
          ).statusCode,
        ).toBe(422);
        const verified = ok(
          await post(`/v1/platform/merchants/${state.merchantA}/verify`, ids.p1, {
            evidenceRef: 'SAMPLE-PROVIDER-ONBOARDING-1',
          }),
        );
        expect(verified.json()).toEqual({ id: state.merchantA, status: 'verified' });
        const again = await post(`/v1/platform/merchants/${state.merchantA}/verify`, ids.p1, {
          evidenceRef: 'SAMPLE-ANOTHER-EVIDENCE',
        });
        expect(code(again)).toBe('already_verified');
        expect(
          (
            await post(`/v1/platform/merchants/${randomUUID()}/verify`, ids.p1, {
              evidenceRef: 'SAMPLE-PROVIDER-ONBOARDING-1',
            })
          ).statusCode,
        ).toBe(404);
        // Lender B's claim is revoked; the identifier stays taken.
        expect(
          (
            await post(`/v1/platform/merchants/${state.merchantB}/revoke`, ids.p1, {
              reason: 'short',
            })
          ).statusCode,
        ).toBe(422);
        const revoked = ok(
          await post(`/v1/platform/merchants/${state.merchantB}/revoke`, ids.p1, {
            reason: 'claim could not be confirmed with the provider',
          }),
        );
        expect(revoked.json()).toEqual({ id: state.merchantB, status: 'revoked' });
        const reclaim = await post('/v1/lender/merchants', ids.b1, {
          lenderId: ids.lenderB,
          provider: 'testpay',
          merchantRef: 'MER-BETA-0001',
        });
        expect(reclaim.statusCode).toBe(201);
        expect(
          (
            await post(`/v1/platform/merchants/${state.merchantB}/revoke`, ids.l1, {
              reason: 'lender cannot revoke merchants',
            })
          ).statusCode,
        ).toBe(403);
      });

      it("registers Udofin's own fee merchant, which no lender can claim", async () => {
        const created = ok(
          await post('/v1/platform/udofin-fee-merchants', ids.p1, {
            provider: 'testpay',
            merchantRef: 'MER-UDOFIN-FEES-1',
          }),
          201,
        );
        expect(created.json()).toMatchObject({ status: 'active' });
        const again = ok(
          await post('/v1/platform/udofin-fee-merchants', ids.p1, {
            provider: 'testpay',
            merchantRef: 'MER-UDOFIN-FEES-1',
          }),
          201,
        );
        expect(again.json<{ id: string }>().id).toBe(created.json<{ id: string }>().id);
        const claim = await post('/v1/lender/merchants', ids.l1, {
          lenderId: ids.lenderA,
          provider: 'testpay',
          merchantRef: 'MER-UDOFIN-FEES-1',
        });
        expect(code(claim)).toBe('merchant_already_claimed');
        expect(
          (
            await post('/v1/platform/udofin-fee-merchants', ids.p2, {
              provider: 'testpay',
              merchantRef: 'MER-UDOFIN-FEES-2',
            })
          ).statusCode,
        ).toBe(403);
        expect(
          (
            await post('/v1/platform/udofin-fee-merchants', ids.l1, {
              provider: 'testpay',
              merchantRef: 'MER-UDOFIN-FEES-2',
            })
          ).statusCode,
        ).toBe(403);
        // The lender listing never shows Udofin's own merchant.
        const lenderView = ok(await get('/v1/lender/merchants', ids.l1)).json<{
          items: { merchantRef: string }[];
        }>();
        expect(lenderView.items.map((m) => m.merchantRef)).toEqual(['MER-ALPHA-0001']);
      });
    });

    // ----------------------------------------------------------------------------------------------------------------------
    describe('linking a settlement account to a verified registry entry', () => {
      it('shows the platform the unlinked account, and links it only to a verified entry of the same lender with the same masked reference', async () => {
        const sampleE = JSON.parse(state.sampleE ?? '{}') as Sample;
        const masked = `XXXXXX${sampleE.accountNumber.slice(-4)}`;
        state.settlementA = randomUUID();
        await admin.query(
          `insert into tenancy.lender_settlement_accounts (id, lender_org_id, label, bank_name, masked_account_ref) values ($1, $2, 'Collections (SAMPLE)', 'Sample Bank', $3)`,
          [state.settlementA, ids.lenderA, masked],
        );
        const mismatched = randomUUID();
        await admin.query(
          `insert into tenancy.lender_settlement_accounts (id, lender_org_id, label, bank_name, masked_account_ref) values ($1, $2, 'Other (SAMPLE)', 'Sample Bank', 'XXXXXX0001')`,
          [mismatched, ids.lenderA],
        );
        const listed = ok(
          await get(
            `/v1/platform/settlement-accounts?lenderId=${ids.lenderA}&linked=false`,
            ids.p1,
          ),
        ).json<{ items: { id: string; maskedRef: string; registryId: string | null }[] }>();
        expect(listed.items.map((s) => s.id).sort()).toEqual(
          [state.settlementA, mismatched].sort(),
        );
        expect(listed.items.every((s) => s.registryId === null)).toBe(true);
        expect((await get('/v1/platform/settlement-accounts', ids.l1)).statusCode).toBe(403);

        expect(
          (
            await post(`/v1/platform/settlement-accounts/${state.settlementA}/link`, ids.p2, {
              registryId: state.regE,
            })
          ).statusCode,
        ).toBe(403);
        expect(
          (
            await post(`/v1/platform/settlement-accounts/${state.settlementA}/link`, ids.l1, {
              registryId: state.regE,
            })
          ).statusCode,
        ).toBe(403);
        // A rejected entry, the wrong masked reference, and an unknown account are refused.
        expect(
          code(
            await post(`/v1/platform/settlement-accounts/${state.settlementA}/link`, ids.p1, {
              registryId: state.regF,
            }),
          ),
        ).toBe('registry_not_permitted');
        expect(
          code(
            await post(`/v1/platform/settlement-accounts/${mismatched}/link`, ids.p1, {
              registryId: state.regE,
            }),
          ),
        ).toBe('masked_ref_mismatch');
        expect(
          (
            await post(`/v1/platform/settlement-accounts/${randomUUID()}/link`, ids.p1, {
              registryId: state.regE,
            })
          ).statusCode,
        ).toBe(404);
        expect(
          (
            await post(`/v1/platform/settlement-accounts/${state.settlementA}/link`, ids.p1, {
              registryId: 'nope',
            })
          ).statusCode,
        ).toBe(422);
        const linked = ok(
          await post(`/v1/platform/settlement-accounts/${state.settlementA}/link`, ids.p1, {
            registryId: state.regE,
          }),
        );
        expect(linked.json()).toEqual({ id: state.settlementA, status: 'verified' });
        expect(
          (
            await q<{ status: string; registry_id: string }>(
              'select status::text, registry_id from tenancy.lender_settlement_accounts where id = $1',
              [state.settlementA],
            )
          )[0],
        ).toEqual({ status: 'verified', registry_id: state.regE });
      });

      it('gives each lender the registry status of its own settlement accounts only, without a fingerprint or an owner', async () => {
        const mine = ok(await get('/v1/lender/settlement-accounts/registry-status', ids.l1)).json<{
          items: Record<string, unknown>[];
        }>();
        const sampleE = JSON.parse(state.sampleE ?? '{}') as Sample;
        expect(mine.items).toEqual([
          {
            settlementAccountId: state.settlementA,
            lenderId: ids.lenderA,
            maskedRef: `XXXXXX${sampleE.accountNumber.slice(-4)}`,
            verificationStatus: 'verified',
            effectiveFrom: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) as string,
            effectiveTo: null,
            usable: true,
          },
        ]);
        expect(
          ok(await get('/v1/lender/settlement-accounts/registry-status', ids.b1)).json<{
            items: unknown[];
          }>().items,
        ).toEqual([]);
        expect(
          (await get('/v1/lender/settlement-accounts/registry-status', ids.borrower)).statusCode,
        ).toBe(403);
      });
    });

    // ----------------------------------------------------------------------------------------------------------------------
    describe('payment configurations: draft, submit and decide by different people; the callback token is shown once', () => {
      const draftBody = (over: Record<string, unknown> = {}) => ({
        lenderId: ids.lenderA,
        provider: 'testpay',
        providerMode: 'production',
        merchantRegistryId: state.merchantA,
        settlementAccountId: state.settlementA,
        secretRef: 'TESTPAY_API_SECRET',
        webhookSecretRef: 'TESTPAY_WEBHOOK_SECRET',
        railLimits: { upi: { max_amount_minor: 10_000_000, needs_afa_each_debit: false } },
        railLimitsSource: 'SAMPLE provider documentation v1, section 4',
        evidenceRef: 'SAMPLE-ONBOARDING-CONFIRMATION-1',
        contractSectionRef: 'SAMPLE-LSP-AGREEMENT-7.1',
        ...over,
      });

      it('refuses a draft that holds a secret value, a bad shape, a foreign merchant or account, a mock mode, or a person without the permission', async () => {
        const value = await post(
          '/v1/lender/payment-configs',
          ids.l1,
          draftBody({ secretRef: 'sk_live_abcdef123456' }),
        );
        expect(value.statusCode).toBe(422);
        expect(value.body).not.toContain('sk_live');
        expect(
          code(
            await post(
              '/v1/lender/payment-configs',
              ids.l1,
              draftBody({ webhookSecretRef: 'TESTPAY_API_SECRET' }),
            ),
          ),
        ).toBe('secret_ref_invalid');
        expect(
          (
            await post(
              '/v1/lender/payment-configs',
              ids.l1,
              draftBody({ railLimits: { upi: { nested: { a: 1 } } } }),
            )
          ).statusCode,
        ).toBe(422);
        expect(
          (
            await post(
              '/v1/lender/payment-configs',
              ids.l1,
              draftBody({ railLimits: { upi: { max_amount_minor: 1.5 } } }),
            )
          ).statusCode,
        ).toBe(422);
        expect(
          (
            await post(
              '/v1/lender/payment-configs',
              ids.l1,
              draftBody({ webhookSecret: 'whsec_abcdefgh' }),
            )
          ).statusCode,
        ).toBe(422);
        expect(
          (
            await post(
              '/v1/lender/payment-configs',
              ids.l1,
              draftBody({ endpointTokenHash: 'a'.repeat(64) }),
            )
          ).statusCode,
        ).toBe(422);
        expect(
          code(
            await post(
              '/v1/lender/payment-configs',
              ids.l1,
              draftBody({ merchantRegistryId: state.merchantB }),
            ),
          ),
        ).toBe('merchant_invalid');
        expect(
          code(
            await post(
              '/v1/lender/payment-configs',
              ids.l1,
              draftBody({ settlementAccountId: randomUUID() }),
            ),
          ),
        ).toBe('settlement_account_invalid');
        expect(
          code(await post('/v1/lender/payment-configs', ids.l1, draftBody({ provider: 'nosuch' }))),
        ).toBe('provider_invalid');
        expect(
          code(
            await post(
              '/v1/lender/payment-configs',
              ids.l1,
              draftBody({ railLimitsSource: undefined }),
            ),
          ),
        ).toBe('rail_limits_invalid');
        // Mock and sandbox are blocked in this environment (the API login allows neither).
        const mock = await post(
          '/v1/lender/payment-configs',
          ids.l1,
          draftBody({ providerMode: 'mock' }),
        );
        expect(mock.statusCode).toBe(403);
        expect(code(mock)).toBe('mock_provider_blocked');
        expect(
          code(
            await post(
              '/v1/lender/payment-configs',
              ids.l1,
              draftBody({ providerMode: 'sandbox' }),
            ),
          ),
        ).toBe('sandbox_provider_blocked');
        // Permission and tenant.
        for (const user of [ids.l2, ids.la, ids.b1, ids.p1, ids.p2]) {
          expect(
            (await post('/v1/lender/payment-configs', user, draftBody())).statusCode,
            user,
          ).toBe(403);
        }
        expect(await q('select 1 from payments.lender_payment_configs')).toHaveLength(0);
      });

      it('explains why a configuration cannot be submitted (an unverified merchant and an unlinked account are named)', async () => {
        // Lender B's merchant is claimed but unverified and its settlement account is not linked: its draft cannot pass validation.
        const settlementB = randomUUID();
        await admin.query(
          `insert into tenancy.lender_settlement_accounts (id, lender_org_id, label, bank_name, masked_account_ref) values ($1, $2, 'Collections B (SAMPLE)', 'Sample Bank', 'XXXXXX7777')`,
          [settlementB, ids.lenderB],
        );
        const merchantB = ok(
          await post('/v1/lender/merchants', ids.b1, {
            lenderId: ids.lenderB,
            provider: 'testpay',
            merchantRef: 'MER-BETA-0002',
          }),
          201,
        ).json<{ id: string }>().id;
        const drafted = ok(
          await post(
            '/v1/lender/payment-configs',
            ids.b1,
            draftBody({
              lenderId: ids.lenderB,
              merchantRegistryId: merchantB,
              settlementAccountId: settlementB,
            }),
          ),
          201,
        );
        state.configB = drafted.json<{ id: string }>().id;
        const submit = await post(`/v1/lender/payment-configs/${state.configB}/submit`, ids.b1);
        expect(submit.statusCode).toBe(409);
        expect(code(submit)).toBe('collection_target_invalid');
        expect(submit.json<{ detail?: string }>().detail).toMatch(
          /^Reasons: settlement_account_not_verified/,
        );
        expect(
          await q(
            `select status from payments.lender_payment_configs where id = $1 and status = 'draft'`,
            [state.configB],
          ),
        ).toHaveLength(1);
      });

      it('drafts a configuration, returns the callback token once and stores only its SHA-256', async () => {
        const key = `it-${randomUUID()}`;
        const drafted = ok(
          await post(
            '/v1/lender/payment-configs',
            ids.l1,
            draftBody({ evidenceRef: undefined, contractSectionRef: undefined }),
            key,
          ),
          201,
        );
        const body = drafted.json<{
          id: string;
          status: string;
          endpointToken: string;
          callbackPath: string;
        }>();
        expect(Object.keys(body).sort()).toEqual(['callbackPath', 'endpointToken', 'id', 'status']);
        expect(body.status).toBe('draft');
        expect(body.endpointToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(body.callbackPath).toBe(`/v1/hooks/provider/${body.endpointToken}`);
        state.config1 = body.id;
        state.token1 = body.endpointToken;
        const row = (
          await q<Record<string, unknown>>(
            'select * from payments.lender_payment_configs where id = $1',
            [body.id],
          )
        )[0];
        expect(row?.endpoint_token_hash).toBe(
          createHash('sha256').update(body.endpointToken).digest('hex'),
        );
        expect(row?.endpoint_token_hash).toBe(hashEndpointToken(body.endpointToken));
        expect(JSON.stringify(row)).not.toContain(body.endpointToken);
        expect(row).toMatchObject({
          lender_org_id: ids.lenderA,
          status: 'draft',
          provider_mode: 'production',
          secret_ref: 'TESTPAY_API_SECRET',
          webhook_secret_ref: 'TESTPAY_WEBHOOK_SECRET',
          drafted_by: ids.l1,
        });
        // A second configuration gets a different token.
        const second = ok(await post('/v1/lender/payment-configs', ids.l1, draftBody()), 201).json<{
          id: string;
          endpointToken: string;
        }>();
        expect(second.endpointToken).not.toBe(body.endpointToken);
        state.config2 = second.id;
        state.token2 = second.endpointToken;
        // The same key with the same request replays the stored answer; another request with that key is refused.
        const replay = await post(
          '/v1/lender/payment-configs',
          ids.l1,
          draftBody({ evidenceRef: undefined, contractSectionRef: undefined }),
          key,
        );
        expect(replay.statusCode).toBe(201);
        expect(replay.headers['idempotent-replayed']).toBe('true');
        expect(replay.json<{ id: string }>().id).toBe(body.id);
        expect(
          code(
            await post(
              '/v1/lender/payment-configs',
              ids.l1,
              draftBody({ secretRef: 'OTHER_SECRET_NAME' }),
              key,
            ),
          ),
        ).toBe('idempotency_key_reused');
        expect(
          await q('select 1 from payments.lender_payment_configs where lender_org_id = $1', [
            ids.lenderA,
          ]),
        ).toHaveLength(2);
      });

      it('never returns the token or its hash again, and shows a configuration only to its own lender and the platform', async () => {
        for (const url of [
          `/v1/lender/payment-configs/${state.config1}`,
          '/v1/lender/payment-configs',
        ]) {
          for (const user of [ids.l1, ids.l2, ids.la]) {
            const res = ok(await get(url, user));
            expect(res.body, `${url} as ${user}`).not.toContain(state.token1);
            expect(res.body).not.toContain(state.token2);
            expect(res.body).not.toMatch(/endpoint|[0-9a-f]{64}/i);
          }
        }
        const one = ok(await get(`/v1/lender/payment-configs/${state.config1}`, ids.l2)).json<
          Record<string, unknown>
        >();
        expect(one).toMatchObject({
          id: state.config1,
          lenderId: ids.lenderA,
          status: 'draft',
          provider: 'testpay',
          providerMode: 'production',
          secretRef: 'TESTPAY_API_SECRET',
          webhookSecretRef: 'TESTPAY_WEBHOOK_SECRET',
          evidenceRef: null,
          draftedBy: ids.l1,
          statusReasons: [],
          railLimits: { upi: { max_amount_minor: 10_000_000, needs_afa_each_debit: false } },
        });
        // Lender B sees nothing of lender A: a 404 for its id, an empty list.
        expect((await get(`/v1/lender/payment-configs/${state.config1}`, ids.b1)).statusCode).toBe(
          404,
        );
        const listB = ok(await get('/v1/lender/payment-configs', ids.b1)).json<{
          items: { id: string }[];
        }>();
        expect(listB.items.map((c) => c.id)).toEqual([state.configB]);
        expect(
          (await get(`/v1/platform/payment-configs/${state.config1}`, ids.p1)).statusCode,
        ).toBe(200);
        expect(
          (await get(`/v1/platform/payment-configs/${state.config1}`, ids.p2)).statusCode,
        ).toBe(403);
        expect(
          (await get(`/v1/platform/payment-configs/${state.config1}`, ids.l1)).statusCode,
        ).toBe(403);
        expect((await get(`/v1/lender/payment-configs/${randomUUID()}`, ids.l1)).statusCode).toBe(
          404,
        );
        const filtered = ok(
          await get(`/v1/lender/payment-configs?lenderId=${ids.lenderA}&status=draft`, ids.l1),
        ).json<{ items: unknown[] }>();
        expect(filtered.items).toHaveLength(2);
        const platformAll = ok(await get('/v1/platform/payment-configs', ids.p1)).json<{
          items: unknown[];
        }>();
        expect(platformAll.items).toHaveLength(3);
      });

      it('refuses to submit a configuration without evidence, then submits and withdraws it', async () => {
        const noEvidence = await post(`/v1/lender/payment-configs/${state.config1}/submit`, ids.l3);
        expect(noEvidence.statusCode).toBe(409);
        expect(code(noEvidence)).toBe('collection_target_invalid');
        expect(noEvidence.json<{ detail?: string }>().detail).toMatch(/config_evidence_missing/);
        for (const user of [ids.l2, ids.b1, ids.la, ids.p1]) {
          expect(
            (await post(`/v1/lender/payment-configs/${state.config1}/submit`, user)).statusCode,
            user,
          ).toBe(404);
        }
        const withdrawn = ok(
          await post(`/v1/lender/payment-configs/${state.config1}/withdraw`, ids.l1, {
            reason: 'drafted without its evidence by mistake',
          }),
        );
        expect(withdrawn.json()).toEqual({ id: state.config1, status: 'retired' });
        expect(
          (
            await post(`/v1/lender/payment-configs/${state.config1}/withdraw`, ids.l1, {
              reason: 'again, already withdrawn',
            })
          ).statusCode,
        ).toBe(200);
        expect(
          (
            await post(`/v1/lender/payment-configs/${state.config1}/withdraw`, ids.l1, {
              reason: 'x',
            })
          ).statusCode,
        ).toBe(422);
      });

      it('submits by one person and decides by a different one with the approve permission; rejection needs a reason', async () => {
        const submitted = ok(
          await post(`/v1/lender/payment-configs/${state.config2}/submit`, ids.l3),
        );
        expect(submitted.json()).toEqual({ id: state.config2, status: 'pending_approval' });
        // The maker (no approve permission), another lender's checker and a reader cannot decide: a 404, no existence oracle.
        for (const user of [ids.l1, ids.l3, ids.la, ids.b2, ids.p1]) {
          expect(
            (
              await post(`/v1/lender/payment-configs/${state.config2}/decide`, user, {
                approve: true,
              })
            ).statusCode,
            user,
          ).toBe(404);
        }
        const noReason = await post(`/v1/lender/payment-configs/${state.config2}/decide`, ids.l2, {
          approve: false,
        });
        expect(noReason.statusCode).toBe(422);
        expect(code(noReason)).toBe('reason_required');
        expect(
          await q(
            `select 1 from payments.lender_payment_configs where id = $1 and status = 'pending_approval'`,
            [state.config2],
          ),
        ).toHaveLength(1);
        const key = `it-${randomUUID()}`;
        const decided = ok(
          await post(
            `/v1/lender/payment-configs/${state.config2}/decide`,
            ids.l2,
            { approve: true, note: 'approved against the provider confirmation' },
            key,
          ),
        );
        expect(decided.json()).toEqual({ id: state.config2, status: 'active' });
        expect(
          (
            await post(
              `/v1/lender/payment-configs/${state.config2}/decide`,
              ids.l2,
              { approve: true, note: 'approved against the provider confirmation' },
              key,
            )
          ).headers['idempotent-replayed'],
        ).toBe('true');
        const row = ok(await get(`/v1/lender/payment-configs/${state.config2}`, ids.l1)).json<
          Record<string, unknown>
        >();
        expect(row).toMatchObject({
          status: 'active',
          draftedBy: ids.l1,
          submittedBy: ids.l3,
          approvedBy: ids.l2,
          lastValidationOk: true,
        });
        const decidedAgain = await post(
          `/v1/lender/payment-configs/${state.config2}/decide`,
          ids.l2,
          { approve: false, note: 'changed my mind after approval' },
        );
        expect(code(decidedAgain)).toBe('config_state_invalid');
        const history = ok(
          await get(`/v1/lender/payment-configs/${state.config2}/history`, ids.l1),
        ).json<{ items: { eventKind: string; toStatus: string | null }[] }>();
        expect(history.items.map((e) => e.eventKind)).toEqual(
          expect.arrayContaining(['drafted', 'submitted', 'approved']),
        );
        expect(
          (await get(`/v1/lender/payment-configs/${state.config2}/history`, ids.b1)).statusCode,
        ).toBe(404);
      });
    });

    // ----------------------------------------------------------------------------------------------------------------------
    describe('feature switches: a two-person flow, an emergency kill, and two switches that can never turn on', () => {
      it('lists the catalogue with the two locked features, and every lender switch off by default', async () => {
        const catalogue = ok(await get('/v1/platform/features', ids.p1)).json<{
          items: { feature: string; enableable: boolean; lockedReason: string | null }[];
        }>();
        expect(catalogue.items.map((f) => f.feature).sort()).toEqual([
          'collections',
          'dlg',
          'mandates',
          'payments',
          'reminders',
          'servicing_sync',
          'statements_noc',
        ]);
        const locked = catalogue.items.filter((f) => !f.enableable);
        expect(locked.map((f) => f.feature).sort()).toEqual(['collections', 'dlg']);
        expect(locked.every((f) => typeof f.lockedReason === 'string')).toBe(true);
        const switches = ok(
          await get(`/v1/platform/lenders/${ids.lenderA}/features`, ids.p2),
        ).json<{ items: { feature: string; enabled: boolean; lenderId: string }[] }>();
        expect(switches.items).toHaveLength(7);
        expect(switches.items.every((s) => !s.enabled && s.lenderId === ids.lenderA)).toBe(true);
        expect((await get(`/v1/platform/lenders/${ids.lenderA}/features`, ids.l1)).statusCode).toBe(
          403,
        );
        expect((await get('/v1/platform/features', ids.l1)).statusCode).toBe(403);
      });

      it('refuses to enable collections and dlg whatever the evidence, and names unmet prerequisites', async () => {
        for (const feature of ['collections', 'dlg']) {
          const res = await post('/v1/platform/feature-change-requests', ids.p1, {
            lenderId: ids.lenderA,
            feature,
            enable: true,
            evidence: { contract_ref: 'SAMPLE-CONTRACT-1' },
          });
          expect(res.statusCode, feature).toBe(409);
          expect(code(res)).toBe('feature_not_enableable');
        }
        expect(
          await q(
            `select 1 from servicing.feature_change_requests where feature in ('collections', 'dlg')`,
          ),
        ).toHaveLength(0);
        const noEvidence = await post('/v1/platform/feature-change-requests', ids.p1, {
          lenderId: ids.lenderA,
          feature: 'servicing_sync',
          enable: true,
        });
        expect(code(noEvidence)).toBe('evidence_missing');
        const unmet = await post('/v1/platform/feature-change-requests', ids.p1, {
          lenderId: ids.lenderA,
          feature: 'servicing_sync',
          enable: true,
          evidence: { contract_ref: 'SAMPLE-CONTRACT-1' },
        });
        expect(unmet.statusCode).toBe(409);
        expect(code(unmet)).toBe('prerequisites_unmet');
        expect(unmet.json<{ detail?: string }>().detail).toBe('Reasons: lms_connection_not_active');
        expect(await q('select 1 from servicing.feature_change_requests')).toHaveLength(0);
        const unknown = await post('/v1/platform/feature-change-requests', ids.p1, {
          lenderId: ids.lenderA,
          feature: 'telepathy',
          enable: false,
          reason: 'no such feature in the catalogue',
        });
        expect(code(unknown)).toBe('unknown_feature');
        expect(
          (
            await post('/v1/platform/feature-change-requests', ids.p1, {
              lenderId: randomUUID(),
              feature: 'servicing_sync',
              enable: false,
              reason: 'no such lender anywhere',
            })
          ).statusCode,
        ).toBe(404);
      });

      it('requires the platform permission and validates the shape: lender staff, other platform staff and bad evidence are refused', async () => {
        const body = {
          lenderId: ids.lenderA,
          feature: 'servicing_sync',
          enable: true,
          evidence: { contract_ref: 'SAMPLE-CONTRACT-1' },
        };
        for (const user of [ids.l1, ids.la, ids.b1, ids.p3]) {
          expect(
            (await post('/v1/platform/feature-change-requests', user, body)).statusCode,
            user,
          ).toBe(403);
        }
        const sneaky = await post('/v1/platform/feature-change-requests', ids.p1, {
          ...body,
          evidence: { note: 'call 9876543210 now' },
        });
        expect(sneaky.statusCode).toBe(422);
        expect(code(sneaky)).toBe('evidence_invalid');
        expect(sneaky.body).not.toContain('9876543210');
        expect(
          (
            await post('/v1/platform/feature-change-requests', ids.p1, {
              ...body,
              evidence: { 'Bad Key': 'x' },
            })
          ).statusCode,
        ).toBe(422);
        expect(
          (await post('/v1/platform/feature-change-requests', ids.p1, { ...body, extra: 1 }))
            .statusCode,
        ).toBe(422);
        expect(
          (
            await post('/v1/platform/feature-change-requests', ids.p1, {
              lenderId: ids.lenderA,
              feature: 'servicing_sync',
              enable: false,
            })
          ).statusCode,
        ).toBe(422);
      });

      it('enables servicing_sync through a request by one person and a decision by another, and reflects it for the lender', async () => {
        await admin.query(
          `insert into servicing.lms_connections (lender_org_id, kind, status, provider_mode) values ($1, 'manual', 'active', 'production')`,
          [ids.lenderA],
        );
        const key = `it-${randomUUID()}`;
        const body = {
          lenderId: ids.lenderA,
          feature: 'servicing_sync',
          enable: true,
          evidence: { contract_ref: 'SAMPLE-CONTRACT-1', approval_ref: 'SAMPLE-APPROVAL-9' },
        };
        const requested = ok(
          await post('/v1/platform/feature-change-requests', ids.p1, body, key),
          201,
        );
        expect(requested.json()).toMatchObject({ status: 'pending' });
        state.req1 = requested.json<{ id: string }>().id;
        const replay = await post('/v1/platform/feature-change-requests', ids.p1, body, key);
        expect(replay.headers['idempotent-replayed']).toBe('true');
        expect(replay.json<{ id: string }>().id).toBe(state.req1);
        expect(code(await post('/v1/platform/feature-change-requests', ids.p1, body))).toBe(
          'pending_request_exists',
        );
        // Nothing changes before the decision; the requester cannot decide, and neither can anyone without the permission.
        expect(
          ok(await get(`/v1/platform/lenders/${ids.lenderA}/features`, ids.p1))
            .json<{ items: { feature: string; enabled: boolean }[] }>()
            .items.find((s) => s.feature === 'servicing_sync')?.enabled,
        ).toBe(false);
        const self = await post(
          `/v1/platform/feature-change-requests/${state.req1}/decide`,
          ids.p1,
          { approve: true },
        );
        expect(self.statusCode).toBe(403);
        expect(code(self)).toBe('self_approval');
        for (const user of [ids.l2, ids.p3, ids.b1]) {
          expect(
            (
              await post(`/v1/platform/feature-change-requests/${state.req1}/decide`, user, {
                approve: true,
              })
            ).statusCode,
            user,
          ).toBe(403);
        }
        const noNote = await post(
          `/v1/platform/feature-change-requests/${state.req1}/decide`,
          ids.p2,
          { approve: false },
        );
        expect(noNote.statusCode).toBe(422);
        expect(code(noNote)).toBe('reason_required');
        const decided = ok(
          await post(`/v1/platform/feature-change-requests/${state.req1}/decide`, ids.p2, {
            approve: true,
            note: 'evidence checked',
          }),
        );
        expect(decided.json()).toEqual({ id: state.req1, status: 'applied' });
        expect(
          code(
            await post(`/v1/platform/feature-change-requests/${state.req1}/decide`, ids.p2, {
              approve: true,
            }),
          ),
        ).toBe('request_not_pending');
        expect(
          (
            await post(`/v1/platform/feature-change-requests/${randomUUID()}/decide`, ids.p2, {
              approve: true,
            })
          ).statusCode,
        ).toBe(404);

        const lenderView = ok(await get('/v1/lender/features', ids.l1)).json<{
          items: { lenderId: string; feature: string; enabled: boolean; enableable: boolean }[];
        }>();
        expect(lenderView.items).toHaveLength(7);
        expect(lenderView.items.every((s) => s.lenderId === ids.lenderA)).toBe(true);
        expect(lenderView.items.filter((s) => s.enabled).map((s) => s.feature)).toEqual([
          'servicing_sync',
        ]);
        expect(lenderView.items.find((s) => s.feature === 'collections')).toMatchObject({
          enabled: false,
          enableable: false,
        });
        // Lender B sees its own switches only, all off; a person with no read permission gets 403.
        const lenderB = ok(await get('/v1/lender/features', ids.b1)).json<{
          items: { lenderId: string; enabled: boolean }[];
        }>();
        expect(lenderB.items.every((s) => s.lenderId === ids.lenderB && !s.enabled)).toBe(true);
        expect((await get('/v1/lender/features', ids.p3)).statusCode).toBe(403);
        expect((await get('/v1/lender/features', ids.l2)).statusCode).toBe(200);
        // The list of requests shows it to the platform and to nobody else.
        const requests = ok(
          await get(
            `/v1/platform/feature-change-requests?lenderId=${ids.lenderA}&status=applied`,
            ids.p2,
          ),
        ).json<{ items: Record<string, unknown>[] }>();
        expect(requests.items).toEqual([
          expect.objectContaining({
            id: state.req1,
            feature: 'servicing_sync',
            enable: true,
            mode: 'two_person',
            status: 'applied',
            requestedBy: ids.p1,
            decidedBy: ids.p2,
            evidence: { contract_ref: 'SAMPLE-CONTRACT-1', approval_ref: 'SAMPLE-APPROVAL-9' },
          }),
        ]);
        expect((await get('/v1/platform/feature-change-requests', ids.l1)).statusCode).toBe(403);
      });

      it('lets the requester cancel a pending request, and nobody else', async () => {
        const requested = ok(
          await post('/v1/platform/feature-change-requests', ids.p1, {
            lenderId: ids.lenderA,
            feature: 'servicing_sync',
            enable: false,
            reason: 'pausing this lender for a review',
          }),
          201,
        );
        const id = requested.json<{ id: string }>().id;
        expect(
          (await post(`/v1/platform/feature-change-requests/${id}/cancel`, ids.p2)).statusCode,
        ).toBe(404);
        expect(
          (await post(`/v1/platform/feature-change-requests/${id}/cancel`, ids.l1)).statusCode,
        ).toBe(403);
        const cancelled = ok(
          await post(`/v1/platform/feature-change-requests/${id}/cancel`, ids.p1),
        );
        expect(cancelled.json()).toEqual({ id, status: 'cancelled' });
        expect(
          (await post(`/v1/platform/feature-change-requests/${id}/cancel`, ids.p1)).statusCode,
        ).toBe(404);
        // A rejected request changes nothing.
        const second = ok(
          await post('/v1/platform/feature-change-requests', ids.p2, {
            lenderId: ids.lenderA,
            feature: 'servicing_sync',
            enable: false,
            reason: 'pausing this lender again for a review',
          }),
          201,
        );
        const rejected = ok(
          await post(
            `/v1/platform/feature-change-requests/${second.json<{ id: string }>().id}/decide`,
            ids.p1,
            { approve: false, note: 'not needed after all' },
          ),
        );
        expect(rejected.json()).toMatchObject({ status: 'rejected' });
        expect(
          ok(await get('/v1/lender/features', ids.l1))
            .json<{ items: { feature: string; enabled: boolean }[] }>()
            .items.find((s) => s.feature === 'servicing_sync')?.enabled,
        ).toBe(true);
      });

      it('turns payments on only after a production configuration is active and its registry entry is verified', async () => {
        const body = {
          lenderId: ids.lenderA,
          feature: 'payments',
          enable: true,
          evidence: { contract_ref: 'SAMPLE-CONTRACT-1' },
        };
        // Lender B has no active configuration: payments cannot be enabled, and the reasons are named.
        const refused = await post('/v1/platform/feature-change-requests', ids.p1, {
          ...body,
          lenderId: ids.lenderB,
        });
        expect(code(refused)).toBe('prerequisites_unmet');
        expect(refused.json<{ detail?: string }>().detail).toMatch(/payment_config_missing/);
        const requested = ok(await post('/v1/platform/feature-change-requests', ids.p1, body), 201);
        const decided = ok(
          await post(
            `/v1/platform/feature-change-requests/${requested.json<{ id: string }>().id}/decide`,
            ids.p2,
            { approve: true },
          ),
        );
        expect(decided.json()).toMatchObject({ status: 'applied' });
        const enabled = ok(await get('/v1/lender/features', ids.la))
          .json<{ items: { feature: string; enabled: boolean }[] }>()
          .items.filter((s) => s.enabled)
          .map((s) => s.feature);
        expect(enabled).toEqual(['payments', 'servicing_sync']);
        // mandates still need a mandate policy and rail limits for mandates.
        const mandates = await post('/v1/platform/feature-change-requests', ids.p1, {
          ...body,
          feature: 'mandates',
        });
        expect(code(mandates)).toBe('prerequisites_unmet');
        expect(mandates.json<{ detail?: string }>().detail).toMatch(/mandate_policy_missing/);
      });

      it('kills a switch at once by one person with a reason, idempotently, and cannot turn anything on', async () => {
        const key = `it-${randomUUID()}`;
        const body = {
          lenderId: ids.lenderA,
          feature: 'payments',
          reason: 'provider incident under investigation',
        };
        for (const user of [ids.l1, ids.la, ids.p3]) {
          expect((await post('/v1/platform/features/kill', user, body)).statusCode, user).toBe(403);
        }
        expect(
          (await post('/v1/platform/features/kill', ids.p1, { ...body, reason: 'short' }))
            .statusCode,
        ).toBe(422);
        expect(
          code(await post('/v1/platform/features/kill', ids.p1, { ...body, feature: 'telepathy' })),
        ).toBe('unknown_feature');
        expect(
          (await post('/v1/platform/features/kill', ids.p1, { ...body, lenderId: randomUUID() }))
            .statusCode,
        ).toBe(404);
        const killed = ok(await post('/v1/platform/features/kill', ids.p2, body, key), 201);
        expect(killed.json()).toMatchObject({ status: 'applied' });
        const replay = await post('/v1/platform/features/kill', ids.p2, body, key);
        expect(replay.headers['idempotent-replayed']).toBe('true');
        expect(replay.json<{ id: string }>().id).toBe(killed.json<{ id: string }>().id);
        expect(
          code(
            await post(
              '/v1/platform/features/kill',
              ids.p2,
              { ...body, feature: 'servicing_sync' },
              key,
            ),
          ),
        ).toBe('idempotency_key_reused');
        const view = ok(await get('/v1/lender/features', ids.l1)).json<{
          items: { feature: string; enabled: boolean }[];
        }>().items;
        expect(view.filter((s) => s.enabled).map((s) => s.feature)).toEqual(['servicing_sync']);
        const record = ok(
          await get(
            `/v1/platform/feature-change-requests?lenderId=${ids.lenderA}&status=applied`,
            ids.p1,
          ),
        ).json<{ items: { mode: string; enable: boolean; feature: string }[] }>();
        expect(record.items).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ mode: 'emergency', enable: false, feature: 'payments' }),
          ]),
        );
      });
    });

    // ----------------------------------------------------------------------------------------------------------------------
    describe('platform controls on configurations and the cascade from the registry', () => {
      it('suspends an active configuration by one platform person, needs a fresh two-person approval, and retires it', async () => {
        const reason = { reason: 'provider reported a settlement incident' };
        for (const user of [ids.l1, ids.l2, ids.p2, ids.p3]) {
          expect(
            (await post(`/v1/platform/payment-configs/${state.config2}/suspend`, user, reason))
              .statusCode,
            user,
          ).toBe(403);
        }
        expect(
          (
            await post(`/v1/platform/payment-configs/${state.config2}/suspend`, ids.p1, {
              reason: 'short',
            })
          ).statusCode,
        ).toBe(422);
        expect(
          (await post(`/v1/platform/payment-configs/${randomUUID()}/suspend`, ids.p1, reason))
            .statusCode,
        ).toBe(404);
        const suspended = ok(
          await post(`/v1/platform/payment-configs/${state.config2}/suspend`, ids.p1, reason),
        );
        expect(suspended.json()).toEqual({ id: state.config2, status: 'suspended' });
        const resubmitted = ok(
          await post(`/v1/lender/payment-configs/${state.config2}/submit`, ids.l3),
        );
        expect(resubmitted.json()).toEqual({ id: state.config2, status: 'pending_approval' });
        ok(
          await post(`/v1/lender/payment-configs/${state.config2}/decide`, ids.l2, {
            approve: true,
            note: 'incident resolved, approved again',
          }),
        );
        // The lender approver (or the platform) retires an active configuration; the lender's maker cannot.
        expect(
          (
            await post(`/v1/lender/payment-configs/${state.config2}/retire`, ids.l1, {
              reason: 'maker may not retire this',
            })
          ).statusCode,
        ).toBe(404);
        expect(
          (
            await post(`/v1/lender/payment-configs/${state.config2}/retire`, ids.b2, {
              reason: 'other lender may not retire this',
            })
          ).statusCode,
        ).toBe(404);
        const retired = ok(
          await post(`/v1/platform/payment-configs/${state.config2}/retire`, ids.p1, {
            reason: 'configuration replaced by a newer one',
          }),
        );
        expect(retired.json()).toEqual({ id: state.config2, status: 'retired' });
        expect(
          code(
            await post(`/v1/lender/payment-configs/${state.config2}/decide`, ids.l2, {
              approve: true,
            }),
          ),
        ).toBe('config_state_invalid');
      });

      it('suspends the configurations that settle into a revoked registry entry and revokes its settlement account', async () => {
        // A fresh active configuration, then revoke the registry entry underneath it.
        const drafted = ok(
          await post('/v1/lender/payment-configs', ids.l1, {
            lenderId: ids.lenderA,
            provider: 'testpay',
            providerMode: 'production',
            merchantRegistryId: state.merchantA,
            settlementAccountId: state.settlementA,
            secretRef: 'TESTPAY_API_SECRET_2',
            webhookSecretRef: 'TESTPAY_WEBHOOK_SECRET_2',
            railLimits: {},
            evidenceRef: 'SAMPLE-ONBOARDING-CONFIRMATION-2',
            contractSectionRef: 'SAMPLE-LSP-AGREEMENT-7.1',
          }),
          201,
        ).json<{ id: string }>();
        ok(await post(`/v1/lender/payment-configs/${drafted.id}/submit`, ids.l3));
        ok(
          await post(`/v1/lender/payment-configs/${drafted.id}/decide`, ids.l2, { approve: true }),
        );
        state.config3 = drafted.id;
        expect(
          (
            await post(`/v1/platform/accounts/${state.regE}/revoke`, ids.l1, {
              reason: 'lender may not revoke registry entries',
            })
          ).statusCode,
        ).toBe(403);
        const revoked = ok(
          await post(`/v1/platform/accounts/${state.regE}/revoke`, ids.p2, {
            reason: 'owner reported the account closed at the bank',
          }),
        );
        expect(revoked.json()).toEqual({ id: state.regE, status: 'revoked' });
        const config = ok(await get(`/v1/lender/payment-configs/${state.config3}`, ids.l1)).json<{
          status: string;
          statusReasons: string[];
        }>();
        expect(config.status).toBe('suspended');
        expect(config.statusReasons).toContain('destination_account_revoked');
        const status = ok(
          await get('/v1/lender/settlement-accounts/registry-status', ids.l1),
        ).json<{ items: { verificationStatus: string; usable: boolean }[] }>();
        expect(status.items).toEqual([
          expect.objectContaining({ verificationStatus: 'revoked', usable: false }),
        ]);
        expect(
          (
            await q<{ status: string }>(
              'select status::text from tenancy.lender_settlement_accounts where id = $1',
              [state.settlementA],
            )
          )[0]?.status,
        ).toBe('revoked');
        // Revoking again is idempotent; a lender can no longer submit the suspended configuration.
        expect(
          ok(
            await post(`/v1/platform/accounts/${state.regE}/revoke`, ids.p1, {
              reason: 'owner reported the account closed at the bank',
            }),
          ).json(),
        ).toMatchObject({ status: 'revoked' });
        expect(code(await post(`/v1/lender/payment-configs/${state.config3}/submit`, ids.l3))).toBe(
          'collection_target_invalid',
        );
      });
    });

    // ----------------------------------------------------------------------------------------------------------------------
    describe('rotating the fingerprint key: every live entry is re-keyed, and the proposal needs a different approver', () => {
      it('needs the fingerprint under every live key version, so a process missing a key answers 503', async () => {
        ok(
          await post('/v1/platform/fingerprint-key-versions', ids.p1, {
            version: 2,
            note: 'rotation test, SAMPLE',
          }),
          201,
        );
        const sample = newSample();
        const missingKey = await call(
          keyedV1Only,
          'POST',
          '/v1/platform/accounts',
          ids.p1,
          registerBody(sample),
        );
        expect(missingKey.statusCode).toBe(503);
        expect(code(missingKey)).toBe('key_management_unavailable');
        // With both keys the account is registered under version 1 and the database receives its version 2 fingerprint too.
        const registered = ok(
          await post('/v1/platform/accounts', ids.p1, registerBody(sample)),
          201,
        ).json<{ id: string }>();
        state.regR = registered.id;
        state.sampleR = JSON.stringify(sample);
        const other = (
          await q<{ fingerprint: string; key_version: number }>(
            'select fingerprint, key_version from payments.account_registry where id = $1',
            [registered.id],
          )
        )[0];
        expect(other).toEqual({
          fingerprint: fingerprintOf(sample, 1).fingerprint,
          key_version: 1,
        });
        // A re-key is registered under the proposed version; a re-key without a proposed version is refused.
        const direct = await post(
          '/v1/platform/accounts',
          ids.p1,
          registerBody(newSample(), { rekeysRegistryId: randomUUID() }),
        );
        expect(direct.statusCode).toBe(422);
        expect(code(direct)).toBe('rekey_invalid');
      });

      it('refuses to approve version 2 until every unverified or verified entry has a successor, then activates it', async () => {
        expect(
          code(await post('/v1/platform/fingerprint-key-versions/2/approve', ids.p2, {})),
        ).toBe('rotation_incomplete');
        // One live entry is verified first, so its successor must be verified too.
        const unverified = ok(await get('/v1/platform/accounts?status=unverified', ids.p1)).json<{
          items: { id: string }[];
        }>().items;
        expect(unverified.length).toBeGreaterThan(2);
        const toVerify = unverified[0]?.id as string;
        ok(
          await post(`/v1/platform/accounts/${toVerify}/verify`, ids.p2, {
            evidenceRef: 'SAMPLE-BANK-LETTER-PRE-ROTATION',
          }),
        );

        // The numbers behind the live entries are entered once more, each to be re-keyed under version 2.
        const rows = await q<{
          id: string;
          fingerprint: string;
          owner_org_id: string | null;
          owner_kind: string;
          legal_owner_name: string;
          permitted_purposes: string[];
          verification_status: string;
        }>(
          `select id, fingerprint, owner_org_id, owner_kind, legal_owner_name, permitted_purposes, verification_status from payments.account_registry
            where key_version = 1 and verification_status in ('unverified', 'verified')`,
        );
        expect(rows.length).toBe(unverified.length);
        const successorOfVerified: string[] = [];
        for (const row of rows) {
          const sample = sampleWithFingerprint(row.fingerprint, 1);
          expect(sample, `a known number for ${row.id}`).toBeDefined();
          const rekey = ok(
            await post(
              '/v1/platform/accounts',
              ids.p1,
              registerBody(sample as Sample, {
                ownerKind: row.owner_kind,
                ownerOrgId: row.owner_org_id ?? undefined,
                legalOwnerName: row.legal_owner_name,
                permittedPurposes: row.permitted_purposes,
                rekeysRegistryId: row.id,
              }),
            ),
            201,
          ).json<{ id: string }>();
          const after = (
            await q<{
              key_version: number;
              rekeyed_from_id: string;
              fingerprint: string;
              verification_status: string;
            }>(
              'select key_version, rekeyed_from_id, fingerprint, verification_status from payments.account_registry where id = $1',
              [rekey.id],
            )
          )[0];
          expect(after).toEqual({
            key_version: 2,
            rekeyed_from_id: row.id,
            fingerprint: fingerprintOf(sample as Sample, 2).fingerprint,
            verification_status: 'unverified',
          });
          if (row.verification_status === 'verified') successorOfVerified.push(rekey.id);
        }
        expect(successorOfVerified).toHaveLength(1);
        // Every entry has a successor, but the successor of the verified entry is not verified yet.
        expect(
          code(await post('/v1/platform/fingerprint-key-versions/2/approve', ids.p2, {})),
        ).toBe('rotation_incomplete');
        ok(
          await post(`/v1/platform/accounts/${successorOfVerified[0]}/verify`, ids.p2, {
            evidenceRef: 'SAMPLE-BANK-LETTER-ROTATION',
          }),
        );
        expect(
          (await post('/v1/platform/fingerprint-key-versions/2/approve', ids.p1, {})).statusCode,
        ).toBe(403);
        const activated = ok(
          await post('/v1/platform/fingerprint-key-versions/2/approve', ids.p2, {
            note: 'rotation complete',
          }),
        );
        expect(activated.json()).toEqual({ keyVersion: 2, status: 'active' });
        const versions = ok(await get('/v1/platform/fingerprint-key-versions', ids.p1)).json<{
          items: { keyVersion: number; status: string }[];
        }>().items;
        expect(versions.map((v) => `${v.keyVersion}:${v.status}`)).toEqual([
          '2:active',
          '1:retired',
        ]);
        // New registrations now use version 2, and a re-key is no longer possible (nothing is proposed).
        const sample = newSample();
        const fresh = ok(
          await post('/v1/platform/accounts', ids.p1, registerBody(sample)),
          201,
        ).json<{ id: string }>();
        expect(
          (
            await q<{ key_version: number }>(
              'select key_version from payments.account_registry where id = $1',
              [fresh.id],
            )
          )[0]?.key_version,
        ).toBe(2);
        expect(
          code(
            await post(
              '/v1/platform/accounts',
              ids.p1,
              registerBody(newSample(), { rekeysRegistryId: fresh.id }),
            ),
          ),
        ).toBe('rekey_invalid');
      });
    });

    // ----------------------------------------------------------------------------------------------------------------------
    describe('no personal-looking value leaves the registration and configuration paths', () => {
      const DB_TABLES = `select schemaname as s, tablename as t from pg_tables where schemaname not in ('pg_catalog', 'information_schema') and schemaname not like 'pg_%' order by 1, 2`;
      async function tablesContaining(
        needles: string[],
      ): Promise<{ table: string; needle: string }[]> {
        const found: { table: string; needle: string }[] = [];
        const patterns = needles.map((n) => `%${n}%`);
        for (const { s, t } of await q<{ s: string; t: string }>(DB_TABLES)) {
          const any = await admin.query(
            `select 1 from "${s}"."${t}" x where x::text like any($1::text[]) limit 1`,
            [patterns],
          );
          if (!any.rowCount) continue;
          for (const needle of needles) {
            const hit = await admin.query(
              `select 1 from "${s}"."${t}" x where x::text like $1 limit 1`,
              [`%${needle}%`],
            );
            if (hit.rowCount) found.push({ table: `${s}.${t}`, needle });
          }
        }
        return found;
      }

      it('keeps every account number and IFSC used in this file out of every response, log line and database table', async () => {
        expect(used.length).toBeGreaterThan(8);
        const needles = [...new Set(used.flatMap((s) => [s.accountNumber, s.ifsc]))];
        const joinedResponses = seen.join('\n');
        const joinedLogs = logs.join('\n');
        expect(logs.length, 'the logger captured the requests').toBeGreaterThan(20);
        for (const needle of needles) {
          expect(joinedResponses, `a response carries ${needle.slice(0, 3)}…`).not.toContain(
            needle,
          );
          expect(joinedLogs, `a log line carries ${needle.slice(0, 3)}…`).not.toContain(needle);
        }
        // Also no fingerprint (under either key version) in a response or a log.
        for (const sample of used) {
          for (const version of [1, 2]) {
            let fp: string;
            try {
              fp = fingerprintOf(sample, version).fingerprint;
            } catch {
              continue; // a number the rule refuses has no fingerprint
            }
            expect(joinedResponses).not.toContain(fp);
            expect(joinedLogs).not.toContain(fp);
          }
        }
        const hits = await tablesContaining(needles);
        expect(
          hits,
          'tables holding an account number or IFSC (audit events, outbox, exceptions, idempotency records included)',
        ).toEqual([]);
      }, 600_000);

      it('keeps the callback token out of every response but the draft, every log line and every table but the idempotency replay record', async () => {
        const tokens = [state.token1 as string, state.token2 as string];
        const drafts = seen.filter((body) => tokens.some((t) => body.includes(t)));
        // Each token appears in exactly the draft response (and its replay for token 1) and nowhere else the API answered.
        expect(drafts.length).toBeLessThanOrEqual(3);
        for (const token of tokens) {
          expect(logs.join('\n')).not.toContain(token);
        }
        const hits = await tablesContaining(tokens);
        // KNOWN GAP (documented in the notes): the generic idempotency layer keeps the stored response of a POST for 24 hours so a
        // retry returns the same answer, and that response is the one place the token exists besides the provider configuration.
        expect([...new Set(hits.map((h) => h.table))]).toEqual(['ops.idempotency_keys']);
        const row = await q<{ response_body: unknown }>(
          `select response_body from ops.idempotency_keys where response_body::text like $1`,
          [`%${tokens[0]}%`],
        );
        expect(row).toHaveLength(1);
        // The hash of the token is the only form on the configuration row, and the audit trail names ids and codes only.
        const audit = await q<{ metadata: unknown }>(
          `select metadata from audit.events where action like 'payments.config.%' or action like 'payments.account_registry.%' or action like 'payments.fingerprint_key.%'`,
        );
        expect(audit.length).toBeGreaterThan(5);
        expect(JSON.stringify(audit)).not.toMatch(/[0-9a-f]{64}/);
      }, 600_000);

      it('logs requests, but nothing of a request body', () => {
        const joined = logs.join('\n');
        expect(joined).toContain('incoming request');
        expect(joined).not.toMatch(/accountNumber|legalOwnerName|secretRef|merchantRef/);
        expect(joined).not.toMatch(/"authorization"|Bearer test\./);
      });
    });
  },
);
