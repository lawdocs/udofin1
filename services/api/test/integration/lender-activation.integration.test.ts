// Phase 08a integration test: the WHOLE activation order of a lender, through HTTP routes only and two platform people, against a
// REAL migrated Postgres. No owner-level insert of any kind builds the lender's state after the organisation and its people exist:
//
//   connection -> servicing_sync -> statements_noc -> reminders -> (registry, own-account list, settlement account, merchant)
//   -> payment configuration -> payments -> mandate settings -> mandates
//
// It proves that every switch can be reached with the routes alone (the attestation route is what lets payments and mandates be
// switched on), that each refusal on the way is a stable code, and that no switch is ever decided by the person who asked for it.
// The same order is proved with public SQL functions in supabase/tests/028_p08a_fix_accounts.test.sql (section 13). Account
// details are SAMPLE and synthetic. Runs only when the INTEGRATION_* URLs are set.
import { randomBytes, randomUUID } from 'node:crypto';
import { createLocalKeyManager } from '@udofin/adapters';
import Fastify, { type FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TokenError, type TokenVerifier } from '../../src/auth/token-verifier.js';
import { createUserContext } from '../../src/db/user-context.js';
import { registerRoutes } from '../../src/http/routes.js';
import { createFingerprintKeySource } from '../../src/modules/lender-accounts/fingerprint-keys.js';
import { lenderAccountsRoutes } from '../../src/modules/lender-accounts/routes.js';
import { lenderPaymentsRoutes } from '../../src/modules/lender-payments/routes.js';
import { lenderRemindersRoutes } from '../../src/modules/lender-reminders/routes.js';
import { lenderServicingRoutes } from '../../src/modules/lender-servicing/routes.js';

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

const digits = (n: number) => '9' + Array.from(randomBytes(n - 1), (b) => b % 10).join('');
const letters = (n: number) =>
  Array.from(randomBytes(n), (b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[b % 24]).join('');
const alnum = (n: number) =>
  Array.from(randomBytes(n), (b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');
const newIfsc = () => `${letters(4)}0${alnum(6)}`;
/** The namespace of a lender's secret names, derived as the database derives it. */
const prefixOf = (lender: string) => `L${lender.replaceAll('-', '').slice(-12).toUpperCase()}_`;

type Res = Awaited<ReturnType<FastifyInstance['inject']>>;

describe.skipIf(!enabled)(
  'the whole activation order of a lender over HTTP: two platform people, no owner-level insert',
  () => {
    const ids = {
      platformOrg: randomUUID() as string,
      lender: randomUUID(), // the lender being activated
      other: randomUUID(), // another lender, for the negative cases
      p1: randomUUID(), // platform: providers.manage + registry.manage + features.manage (asks for every switch)
      p2: randomUUID(), // platform: registry.verify + features.manage (decides every switch: the second person)
      ops: randomUUID(), // lender: servicing operator (servicing.sync.manage)
      opsOther: randomUUID(), // another lender's servicing operator
      commsAdmin: randomUUID(), // lender: reminder.policy.manage
      commsApprover: randomUUID(), // lender: reminder.template.approve
      maker: randomUUID(), // lender: payment.configure (drafts)
      submitter: randomUUID(), // lender: payment.configure (submits)
      checker: randomUUID(), // lender: payment.config.approve
    };
    const state: Record<string, string> = {};
    let admin: pg.Pool;
    let apiPool: pg.Pool;
    let app: FastifyInstance;

    const call = (
      method: 'GET' | 'POST',
      url: string,
      user: string | null,
      payload?: unknown,
      key: string | null = method === 'POST' ? `it-${randomUUID()}` : null,
      aal: 'aal1' | 'aal2' = 'aal2',
    ): Promise<Res> =>
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
    const post = (url: string, user: string | null, payload: unknown = {}) =>
      call('POST', url, user, payload);
    const code = (res: Res) => res.json<{ code?: string }>().code;
    const detail = (res: Res) => res.json<{ detail?: string }>().detail ?? '';
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
      for (const role of roles)
        await admin.query(
          `insert into tenancy.membership_roles (membership_id, role_id)
           select $1, r.id from tenancy.roles r where r.org_id is null and r.applies_to = $2::tenancy.organization_kind and r.key = $3`,
          [m.rows[0]?.id, kind, role],
        );
    }

    /** A switch is asked for by the first platform person and decided by the second one. */
    async function switchOn(feature: string, note: string) {
      const requested = ok(
        await post('/v1/platform/feature-change-requests', ids.p1, {
          lenderId: ids.lender,
          feature,
          enable: true,
          evidence: { contract_ref: 'SAMPLE-MSA-ACTIVATION' },
        }),
        201,
      ).json<{ id: string; status: string }>();
      expect(requested.status).toBe('pending');
      const self = await post(
        `/v1/platform/feature-change-requests/${requested.id}/decide`,
        ids.p1,
        {
          approve: true,
        },
      );
      expect([feature, self.statusCode, code(self)]).toEqual([feature, 403, 'self_approval']);
      const decided = ok(
        await post(`/v1/platform/feature-change-requests/${requested.id}/decide`, ids.p2, {
          approve: true,
          note,
        }),
      ).json<{ status: string }>();
      expect(decided.status).toBe('applied');
    }
    const refusedSwitch = async (feature: string) =>
      post('/v1/platform/feature-change-requests', ids.p1, {
        lenderId: ids.lender,
        feature,
        enable: true,
        evidence: { contract_ref: 'SAMPLE-MSA-ACTIVATION' },
      });
    const enabledFeatures = async () =>
      ok(await get(`/v1/platform/lenders/${ids.lender}/features`, ids.p1))
        .json<{ items: { feature: string; enabled: boolean }[] }>()
        .items.filter((s) => s.enabled)
        .map((s) => s.feature)
        .sort();

    beforeAll(async () => {
      admin = new pg.Pool({ connectionString: ADMIN, max: 3 });
      apiPool = new pg.Pool({ connectionString: API, max: 10 });
      for (const id of [
        ids.p1,
        ids.p2,
        ids.ops,
        ids.opsOther,
        ids.commsAdmin,
        ids.commsApprover,
        ids.maker,
        ids.submitter,
        ids.checker,
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
        [ids.lender, 'Delta Lending'],
        [ids.other, 'Epsilon Lending'],
      ] as const) {
        await admin.query(
          `insert into tenancy.organizations (id, kind, legal_name, display_name, regulator_registration_no, status) values ($1, 'lender', $2, $3, $4, 'active')`,
          [lender, `${name} Ltd`, name, `IT-ACT-${alnum(8)}`],
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
      await member(ids.lender, ids.ops, 'lender', ['servicing_operator']);
      await member(ids.other, ids.opsOther, 'lender', ['servicing_operator']);
      await member(ids.lender, ids.commsAdmin, 'lender', ['communications_admin']);
      await member(ids.lender, ids.commsApprover, 'lender', ['communications_approver']);
      await member(ids.lender, ids.maker, 'lender', ['payments_admin']);
      await member(ids.lender, ids.submitter, 'lender', ['payments_admin']);
      await member(ids.lender, ids.checker, 'lender', ['payments_approver']);

      // Fingerprint keys for every version this database could be on, wrapped by the labelled local key manager (test only).
      const keyManager = createLocalKeyManager(
        'test',
        { 1: Buffer.alloc(32, 7).toString('base64') },
        1,
      );
      const wrapped: Record<number, Awaited<ReturnType<typeof keyManager.encrypt>>> = {};
      for (const version of [1, 2, 3]) {
        wrapped[version] = await keyManager.encrypt({
          keyRef: 'platform/account-fingerprint',
          plaintext: new Uint8Array(randomBytes(32)),
          context: { purpose: 'account-fingerprint', fingerprint_key_version: String(version) },
        });
      }
      const source = createFingerprintKeySource({ environment: 'test', keyManager, wrapped });

      app = Fastify({ logger: false, requestIdHeader: false, genReqId: () => randomUUID() });
      app.setErrorHandler((error: Error, request, reply) => {
        request.log.error({ err: error }, 'unhandled error');
        void reply.code(500).send({ code: 'internal_error' });
      });
      registerRoutes(
        app,
        [
          ...lenderAccountsRoutes({ fingerprintKeys: source }),
          ...lenderServicingRoutes({}),
          ...lenderRemindersRoutes({}),
          ...lenderPaymentsRoutes({}),
        ],
        { auth: { verifier: fakeVerifier, context: createUserContext(apiPool) } },
      );
      await app.ready();
    });

    afterAll(async () => {
      await app?.close();
      await apiPool?.end();
      await admin?.end();
    });

    // ----------------------------------------------------------------------------------------------------------------------
    it('prepares what every lender shares, through the routes: a fingerprint key version, a format rule and an approved provider', async () => {
      const versions = ok(await get('/v1/platform/fingerprint-key-versions', ids.p1)).json<{
        items: { keyVersion: number; status: string }[];
      }>().items;
      if (!versions.some((v) => v.status === 'active')) {
        ok(await post('/v1/platform/fingerprint-key-versions', ids.p1, { version: 1 }), 201);
        ok(await post('/v1/platform/fingerprint-key-versions/1/approve', ids.p2, {}));
      }
      const rules = ok(
        await get(
          '/v1/platform/account-format-rules?status=approved&accountType=bank_account',
          ids.p1,
        ),
      ).json<{ items: unknown[] }>().items;
      if (rules.length === 0) {
        const draft = ok(
          await post('/v1/platform/account-format-rules', ids.p1, {
            country: 'IN',
            accountType: 'bank_account',
            minDigits: 9,
            maxDigits: 18,
            ifscRequired: true,
            evidenceLabel: 'unverified',
            sourceNote: 'SAMPLE: owner supplied range, no document yet',
          }),
          201,
        ).json<{ id: string }>();
        ok(await post(`/v1/platform/account-format-rules/${draft.id}/approve`, ids.p2, {}));
      }
      ok(
        await post('/v1/platform/payment-providers', ids.p1, {
          provider: 'activationpay',
          displayName: 'Activationpay (SAMPLE provider)',
          kind: 'payment_and_mandate',
          status: 'approved',
          authorisationEvidenceRef: 'SAMPLE-PA-AUTHORISATION-ACTIVATION',
          evidenceLabel: 'likely',
        }),
      );
      // Nothing about this lender exists yet: every switch is off.
      expect(await enabledFeatures()).toEqual([]);
    });

    it('refuses servicing_sync while the lender has no active connection, and names the reason', async () => {
      const refused = await refusedSwitch('servicing_sync');
      expect([refused.statusCode, code(refused)]).toEqual([409, 'prerequisites_unmet']);
      expect(detail(refused)).toBe('Reasons: lms_connection_not_active');
    });

    it('records the connection BEFORE any switch is on (A42): file_import or manual only, by the lender servicing operator only', async () => {
      const body = { lenderId: ids.lender, kind: 'file_import', status: 'active' };
      // Every other kind needs the switch, and so does every other servicing write.
      for (const other of [
        { kind: 'mock', status: 'active' },
        { kind: 'finbyx', status: 'blocked_unverified' },
        { kind: 'generic_rest', status: 'blocked_unverified' },
      ]) {
        const res = await post('/v1/lender/lms-connection', ids.ops, {
          lenderId: ids.lender,
          ...other,
        });
        expect([other.kind, res.statusCode, code(res)]).toEqual([
          other.kind,
          409,
          'feature_disabled',
        ]);
      }
      // Who may: another lender's operator, a person without servicing.sync.manage, a platform person, and a missing second factor.
      for (const user of [ids.opsOther, ids.commsAdmin, ids.maker, ids.p1])
        expect((await post('/v1/lender/lms-connection', user, body)).statusCode, user).toBe(403);
      const aal1 = await call(
        'POST',
        '/v1/lender/lms-connection',
        ids.ops,
        body,
        undefined,
        'aal1',
      );
      expect([aal1.statusCode, code(aal1)]).toEqual([401, 'mfa_required']);
      expect(
        await q('select 1 from servicing.lms_connections where lender_org_id = $1', [ids.lender]),
      ).toHaveLength(0);

      const recorded = ok(await post('/v1/lender/lms-connection', ids.ops, body)).json<{
        id: string;
      }>();
      const row = await q<{ kind: string; status: string; provider_mode: string }>(
        'select kind, status, provider_mode::text from servicing.lms_connections where id = $1',
        [recorded.id],
      );
      expect(row).toEqual([{ kind: 'file_import', status: 'active', provider_mode: 'production' }]);
      expect(
        await q(
          `select 1 from audit.events where action = 'servicing.connection.set' and tenant_org_id = $1`,
          [ids.lender],
        ),
      ).toHaveLength(1);
      // Still nothing is on, and a servicing write other than the connection is still behind the switch.
      expect(await enabledFeatures()).toEqual([]);
    });

    it('turns servicing_sync and then statements_noc on: asked for by one platform person, decided by the other', async () => {
      const noc = await refusedSwitch('statements_noc');
      expect([noc.statusCode, code(noc)]).toEqual([409, 'prerequisites_unmet']);
      expect(detail(noc)).toBe('Reasons: servicing_sync_not_enabled');
      await switchOn('servicing_sync', 'connection recorded, evidence reviewed');
      expect(await enabledFeatures()).toEqual(['servicing_sync']);
      // With the switch on, the connection changes as before.
      for (const status of ['paused', 'active'])
        ok(
          await post('/v1/lender/lms-connection', ids.ops, {
            lenderId: ids.lender,
            kind: 'file_import',
            status,
          }),
        );
      await switchOn('statements_noc', 'statements and no-dues letters reviewed');
      expect(await enabledFeatures()).toEqual(['servicing_sync', 'statements_noc']);
    });

    it('refuses reminders until a policy and the wording are approved by a different lender person, then turns them on', async () => {
      const refused = await refusedSwitch('reminders');
      expect([refused.statusCode, code(refused)]).toEqual([409, 'prerequisites_unmet']);
      expect(detail(refused)).toBe('Reasons: reminder_policy_missing, reminder_templates_missing');

      const policy = ok(
        await post('/v1/lender/reminder-policies', ids.commsAdmin, {
          lenderId: ids.lender,
          offsetsDays: [-1, 0, 3],
          overdueWeekly: true,
          channels: ['in_app', 'push'],
          windowFrom: '09:00',
          windowTo: '18:00',
          maxPerDay: 2,
        }),
        201,
      ).json<{ id: string }>();
      const wording = {
        pre_due:
          'Reminder from {{lender_name}}: your installment of {{amount}} is due on {{due_date}}.',
        due_day:
          'Reminder from {{lender_name}}: your installment of {{amount}} is due today, {{due_date}}.',
        overdue:
          '{{lender_name}} reminder: {{amount}} is overdue since {{due_date}}. {{penal_text}}',
      } as const;
      const templates: string[] = [];
      for (const [kind, body] of Object.entries(wording))
        templates.push(
          ok(
            await post('/v1/lender/reminder-templates', ids.commsAdmin, {
              lenderId: ids.lender,
              kind,
              language: 'en',
              body,
            }),
            201,
          ).json<{ id: string }>().id,
        );
      // Drafted but not approved is not enough, and the drafter does not approve.
      expect(code(await refusedSwitch('reminders'))).toBe('prerequisites_unmet');
      const own = await post(`/v1/lender/reminder-policies/${policy.id}/approve`, ids.commsAdmin);
      expect(own.statusCode).toBe(404);
      for (const [path, id] of [
        ['reminder-policies', policy.id],
        ...templates.map((t) => ['reminder-templates', t] as const),
      ] as const)
        expect(
          ok(await post(`/v1/lender/${path}/${id}/approve`, ids.commsApprover)).json(),
        ).toEqual({ id, status: 'approved' });
      await switchOn('reminders', 'wording and policy reviewed');
      expect(await enabledFeatures()).toEqual(['reminders', 'servicing_sync', 'statements_noc']);
    });

    it('refuses payments until a production configuration is active, and says what is missing', async () => {
      const refused = await refusedSwitch('payments');
      expect([refused.statusCode, code(refused)]).toEqual([409, 'prerequisites_unmet']);
      expect(detail(refused)).toMatch(/payment_config_missing/);
    });

    it('verifies no lender account until the own-account list is attested, then registers, verifies and links the lender chain', async () => {
      // Start from a list that is not attested, whatever an earlier file left behind.
      const state0 = ok(await get('/v1/platform/own-account-list', ids.p1)).json<{
        attested: boolean;
      }>();
      if (state0.attested)
        ok(
          await post('/v1/platform/own-account-list/withdraw', ids.p1, {
            reason: 'activation test starts from an unattested list',
          }),
        );

      const lenderSample = { accountNumber: digits(12), ifsc: newIfsc() };
      const lenderEntry = ok(
        await post('/v1/platform/accounts', ids.p1, {
          ...lenderSample,
          country: 'IN',
          accountType: 'bank_account',
          ownerKind: 'lender',
          ownerOrgId: ids.lender,
          legalOwnerName: 'Delta Lending Private Limited',
          permittedPurposes: ['repayment_settlement'],
        }),
        201,
      ).json<{ id: string; maskedRef: string }>();
      state.entry = lenderEntry.id;
      state.masked = lenderEntry.maskedRef;

      // NEGATIVE: not attested -> 409 own_account_list_not_attested, and the entry stays unverified.
      const blocked = await post(`/v1/platform/accounts/${lenderEntry.id}/verify`, ids.p2, {
        evidenceRef: 'SAMPLE-BANK-LETTER-ACTIVATION',
      });
      expect([blocked.statusCode, code(blocked)]).toEqual([409, 'own_account_list_not_attested']);
      expect(
        await q(
          `select 1 from payments.account_registry where id = $1 and verification_status = 'unverified'`,
          [lenderEntry.id],
        ),
      ).toHaveLength(1);

      // The list is loaded: Udofin's own account is registered and verified (it needs no attestation), then attested by the verifier.
      const udofin = ok(
        await post('/v1/platform/accounts', ids.p1, {
          accountNumber: digits(12),
          ifsc: newIfsc(),
          country: 'IN',
          accountType: 'bank_account',
          ownerKind: 'udofin',
          legalOwnerName: 'Udofin Technologies Private Limited',
          permittedPurposes: ['fee_collection'],
        }),
        201,
      ).json<{ id: string }>();
      ok(
        await post(`/v1/platform/accounts/${udofin.id}/verify`, ids.p2, {
          evidenceRef: 'SAMPLE-BANK-LETTER-UDOFIN-ACTIVATION',
        }),
      );
      const attested = ok(
        await post('/v1/platform/own-account-list/attest', ids.p2, {
          evidenceRef: 'SAMPLE-OWN-ACCOUNT-RECONCILIATION-ACTIVATION',
        }),
      ).json<{ attested: boolean }>();
      expect(attested.attested).toBe(true);

      ok(
        await post(`/v1/platform/accounts/${lenderEntry.id}/verify`, ids.p2, {
          evidenceRef: 'SAMPLE-BANK-LETTER-ACTIVATION',
        }),
      );

      // The lender asks for its settlement account (masked reference only) and claims its merchant identifier.
      const settlement = ok(
        await post('/v1/lender/settlement-accounts', ids.maker, {
          lenderId: ids.lender,
          label: 'Delta collections (SAMPLE)',
          bankName: 'Sample Bank',
          maskedRef: lenderEntry.maskedRef,
        }),
        201,
      ).json<{ id: string; status: string }>();
      expect(settlement.status).toBe('unverified');
      state.settlement = settlement.id;
      const merchant = ok(
        await post('/v1/lender/merchants', ids.maker, {
          lenderId: ids.lender,
          provider: 'activationpay',
          merchantRef: `MER-DELTA-${alnum(6)}`,
        }),
        201,
      ).json<{ id: string }>();
      state.merchant = merchant.id;

      // NEGATIVE: with the attestation withdrawn the account cannot be linked either.
      ok(
        await post('/v1/platform/own-account-list/withdraw', ids.p2, {
          reason: 'withdrawn to check that linking waits for the list',
        }),
      );
      const unlinked = await post(
        `/v1/platform/settlement-accounts/${settlement.id}/link`,
        ids.p1,
        {
          registryId: lenderEntry.id,
        },
      );
      expect([unlinked.statusCode, code(unlinked)]).toEqual([409, 'own_account_list_not_attested']);
      ok(
        await post('/v1/platform/own-account-list/attest', ids.p2, {
          evidenceRef: 'SAMPLE-OWN-ACCOUNT-RECONCILIATION-ACTIVATION-2',
        }),
      );
      ok(
        await post(`/v1/platform/settlement-accounts/${settlement.id}/link`, ids.p1, {
          registryId: lenderEntry.id,
        }),
      );
      // The merchant is confirmed by the platform against evidence, not by the person who claimed it.
      ok(
        await post(`/v1/platform/merchants/${merchant.id}/verify`, ids.p1, {
          evidenceRef: 'SAMPLE-PROVIDER-ONBOARDING-ACTIVATION',
        }),
      );
      expect(
        ok(await get('/v1/lender/settlement-accounts/registry-status', ids.maker)).json<{
          items: { settlementAccountId: string; usable: boolean }[];
        }>().items,
      ).toEqual([expect.objectContaining({ settlementAccountId: settlement.id, usable: true })]);
    });

    it('drafts the production configuration with secret names in the lender namespace, submits it by a second person and approves it by a third', async () => {
      const prefix = ok(
        await get(`/v1/lender/secret-ref-prefix?lenderId=${ids.lender}`, ids.maker),
      ).json<{
        prefix: string;
      }>().prefix;
      expect(prefix).toBe(prefixOf(ids.lender));
      const draft = {
        lenderId: ids.lender,
        provider: 'activationpay',
        providerMode: 'production',
        merchantRegistryId: state.merchant,
        settlementAccountId: state.settlement,
        secretRef: `${prefix}ACTIVATIONPAY_API`,
        webhookSecretRef: `${prefix}ACTIVATIONPAY_HOOK`,
        railLimits: {
          enach_api: { max_mandate_amount_minor: 5_000_000, needs_afa_each_debit: false },
        },
        railLimitsSource: 'SAMPLE provider documentation section 4',
        evidenceRef: 'SAMPLE-ONBOARDING-CONFIRMATION-ACTIVATION',
        contractSectionRef: 'SAMPLE-LSP-AGREEMENT-7.1',
      };
      // A name outside the namespace is refused whatever the name is.
      const bare = await post('/v1/lender/payment-configs', ids.maker, {
        ...draft,
        secretRef: 'ACTIVATIONPAY_API',
      });
      expect([bare.statusCode, code(bare)]).toEqual([422, 'validation_failed']);
      const foreign = await post('/v1/lender/payment-configs', ids.maker, {
        ...draft,
        secretRef: `${prefixOf(ids.other)}ACTIVATIONPAY_API`,
      });
      expect([foreign.statusCode, code(foreign)]).toEqual([422, 'secret_ref_invalid']);

      const drafted = ok(await post('/v1/lender/payment-configs', ids.maker, draft), 201).json<{
        id: string;
      }>();
      state.config = drafted.id;
      expect(
        (
          await q<{ secret_namespace: string }>(
            'select secret_namespace from payments.lender_payment_configs where id = $1',
            [drafted.id],
          )
        )[0]?.secret_namespace,
      ).toBe(prefix);
      expect(
        ok(await post(`/v1/lender/payment-configs/${drafted.id}/submit`, ids.submitter)).json(),
      ).toEqual({ id: drafted.id, status: 'pending_approval' });
      // The drafter and the submitter cannot approve; the approver can.
      for (const user of [ids.maker, ids.submitter])
        expect(
          (await post(`/v1/lender/payment-configs/${drafted.id}/decide`, user, { approve: true }))
            .statusCode,
          user,
        ).toBe(404);
      expect(
        ok(
          await post(`/v1/lender/payment-configs/${drafted.id}/decide`, ids.checker, {
            approve: true,
            note: 'approved against the provider confirmation',
          }),
        ).json(),
      ).toEqual({ id: drafted.id, status: 'active' });
    });

    it('turns payments on only with the own-account list attested: the attestation route is what unlocks it', async () => {
      // NEGATIVE: with the attestation withdrawn, payments cannot be switched on for this lender, and the reason is named.
      ok(
        await post('/v1/platform/own-account-list/withdraw', ids.p1, {
          reason: 'withdrawn to check that payments wait for the list',
        }),
      );
      const refused = await refusedSwitch('payments');
      expect([refused.statusCode, code(refused)]).toEqual([409, 'prerequisites_unmet']);
      expect(detail(refused)).toBe('Reasons: own_account_list_not_attested');
      expect(await enabledFeatures()).toEqual(['reminders', 'servicing_sync', 'statements_noc']);

      ok(
        await post('/v1/platform/own-account-list/attest', ids.p2, {
          evidenceRef: 'SAMPLE-OWN-ACCOUNT-RECONCILIATION-ACTIVATION-3',
        }),
      );
      await switchOn('payments', 'configuration and registry reviewed');
      expect(await enabledFeatures()).toEqual([
        'payments',
        'reminders',
        'servicing_sync',
        'statements_noc',
      ]);
    });

    it('refuses mandates until the lender sets its mandate settings, then turns them on', async () => {
      const refused = await refusedSwitch('mandates');
      expect([refused.statusCode, code(refused)]).toEqual([409, 'prerequisites_unmet']);
      expect(detail(refused)).toBe('Reasons: mandate_policy_missing');
      const policy = await post('/v1/lender/mandate-policy', ids.maker, {
        lenderId: ids.lender,
        requirement: 'before_first_due',
        maxAmountCapMinor: 4_000_000,
        preDebitLeadHours: 48,
      });
      expect(ok(policy).json()).toEqual({ outcome: 'set' });
      await switchOn('mandates', 'mandate settings and rails reviewed');
    });

    it('ends with all five Phase 08a switches on, every one decided by the second platform person and none by its requester', async () => {
      expect(await enabledFeatures()).toEqual([
        'mandates',
        'payments',
        'reminders',
        'servicing_sync',
        'statements_noc',
      ]);
      // The two features that can never be switched on in this phase stay off.
      const all = ok(await get(`/v1/platform/lenders/${ids.lender}/features`, ids.p2)).json<{
        items: { feature: string; enabled: boolean; enableable: boolean }[];
      }>().items;
      for (const feature of ['collections', 'dlg'])
        expect(all.find((s) => s.feature === feature)).toMatchObject({
          enabled: false,
          enableable: false,
        });
      const applied = await q<{ requested_by: string; decided_by: string }>(
        `select requested_by, decided_by from servicing.feature_change_requests where lender_org_id = $1 and status = 'applied'`,
        [ids.lender],
      );
      expect(applied).toHaveLength(5);
      expect(applied.every((r) => r.requested_by === ids.p1 && r.decided_by === ids.p2)).toBe(true);
      // The lender sees its own switches, read-only.
      const own = ok(await get(`/v1/lender/features?lenderId=${ids.lender}`, ids.maker)).json<{
        items: { feature: string; enabled: boolean }[];
      }>().items;
      expect(
        own
          .filter((s) => s.enabled)
          .map((s) => s.feature)
          .sort(),
      ).toEqual(['mandates', 'payments', 'reminders', 'servicing_sync', 'statements_noc']);
      // And the audit trail names no account, no secret name and no evidence content.
      const audit = await q<{ metadata: unknown }>(
        `select metadata from audit.events where tenant_org_id = $1 or entity_id = $2`,
        [ids.lender, state.config ?? ''],
      );
      const text = JSON.stringify(audit);
      expect(text).not.toContain(prefixOf(ids.lender));
      expect(text).not.toContain('SAMPLE-BANK-LETTER');
    });
  },
);
