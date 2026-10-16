// Phase 08a: a lender asks for one of its own settlement accounts (masked reference only), over HTTP against a REAL migrated Postgres.
// The rules are in the database (payments.request_settlement_account); these tests drive the two routes and check what the API layer
// adds: authentication, strict bodies, the idempotency key, tenant isolation of the list and that no full account number is accepted
// or echoed anywhere. Runs only when the INTEGRATION_* URLs are set.
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TokenError, type TokenVerifier } from '../../src/auth/token-verifier.js';
import { createUserContext } from '../../src/db/user-context.js';
import { registerRoutes } from '../../src/http/routes.js';
import { lenderAccountsRoutes } from '../../src/modules/lender-accounts/routes.js';

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
const freshAddress = () => `10.31.${(nextAddress >> 8) & 255}.${nextAddress++ & 255}`;
type Res = Awaited<ReturnType<FastifyInstance['inject']>>;

describe.skipIf(!enabled)(
  'lender settlement account requests over HTTP against a real database',
  () => {
    const ids = {
      platformOrg: randomUUID() as string,
      lenderA: randomUUID(),
      lenderB: randomUUID(),
      maker: randomUUID(), // lender A: payment.configure
      approver: randomUUID(), // lender A: payment.config.approve only
      reader: randomUUID(), // lender A: payment.read, loan.read
      makerB: randomUUID(), // lender B
      borrower: randomUUID(),
    };
    const seen: string[] = [];
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
      app
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
    const code = (res: Res) => res.json<{ code?: string }>().code;
    const q = async <T extends pg.QueryResultRow>(sql: string, values: unknown[] = []) =>
      (await admin.query<T>(sql, values)).rows;

    async function member(org: string, user: string, roles: string[]) {
      const m = await admin.query<{ id: string }>(
        'insert into tenancy.memberships (org_id, user_id, status) values ($1, $2, $3) returning id',
        [org, user, 'active'],
      );
      for (const role of roles) {
        await admin.query(
          `insert into tenancy.membership_roles (membership_id, role_id)
         select $1, r.id from tenancy.roles r where r.org_id is null and r.applies_to = 'lender'::tenancy.organization_kind and r.key = $2`,
          [m.rows[0]?.id, role],
        );
      }
    }

    const body = (over: Record<string, unknown> = {}) => ({
      lenderId: ids.lenderA,
      label: 'SAMPLE collection account',
      bankName: 'Sample Bank',
      maskedRef: 'XXXXXX7421',
      ...over,
    });

    beforeAll(async () => {
      admin = new pg.Pool({ connectionString: ADMIN, max: 3 });
      apiPool = new pg.Pool({ connectionString: API, max: 5 });
      for (const id of [ids.maker, ids.approver, ids.reader, ids.makerB]) {
        await admin.query(
          `insert into auth.users (id, phone, raw_app_meta_data) values ($1, null, '{"actor_type":"staff"}')`,
          [id],
        );
      }
      await admin.query(
        `insert into auth.users (id, phone, raw_app_meta_data) values ($1, $2, '{}')`,
        [ids.borrower, `91${Math.floor(1_000_000_000 + Math.random() * 8_999_999_999)}`],
      );
      for (const [lender, name] of [
        [ids.lenderA, 'Settle Alpha'],
        [ids.lenderB, 'Settle Beta'],
      ] as const) {
        await admin.query(
          `insert into tenancy.organizations (id, kind, legal_name, display_name, regulator_registration_no, status) values ($1, 'lender', $2, $3, $4, 'active')`,
          [lender, `${name} Ltd`, name, `IT-SET-${randomUUID().slice(0, 8)}`],
        );
      }
      await member(ids.lenderA, ids.maker, ['payments_admin']);
      await member(ids.lenderA, ids.approver, ['payments_approver']);
      await member(ids.lenderA, ids.reader, ['lender_admin']);
      await member(ids.lenderB, ids.makerB, ['payments_admin']);

      app = Fastify({ logger: false });
      app.setErrorHandler((error: Error, _request, reply) => {
        void reply.code(500).send({ code: 'internal_error' });
      });
      registerRoutes(app, lenderAccountsRoutes({}), {
        auth: { verifier: fakeVerifier, context: createUserContext(apiPool) },
      });
      await app.ready();
    });

    afterAll(async () => {
      await app?.close();
      await admin?.end();
      await apiPool?.end();
    });

    it('a lender maker asks for a settlement account: 201, unverified, and the list shows it as not linked', async () => {
      const res = await call('POST', '/v1/lender/settlement-accounts', ids.maker, body());
      expect(res.statusCode, res.body).toBe(201);
      const created = res.json<{ id: string; status: string }>();
      expect(created.status).toBe('unverified');
      const rows = await q<{
        status: string;
        registry_id: string | null;
        masked_account_ref: string;
      }>(
        'select status::text, registry_id, masked_account_ref from tenancy.lender_settlement_accounts where id = $1',
        [created.id],
      );
      expect(rows).toEqual([
        { status: 'unverified', registry_id: null, masked_account_ref: 'XXXXXX7421' },
      ]);
      const list = await call(
        'GET',
        `/v1/lender/settlement-accounts?lenderId=${ids.lenderA}`,
        ids.reader,
      );
      expect(list.statusCode, list.body).toBe(200);
      expect(
        list.json<{
          items: { id: string; maskedRef: string; status: string; registryId: string | null }[];
        }>().items,
      ).toEqual([
        expect.objectContaining({
          id: created.id,
          maskedRef: 'XXXXXX7421',
          status: 'unverified',
          registryId: null,
        }),
      ]);
    });

    it('the same request with the same Idempotency-Key replays; with a new key it answers the same account', async () => {
      const key = `it-${randomUUID()}`;
      const first = await call(
        'POST',
        '/v1/lender/settlement-accounts',
        ids.maker,
        body({ maskedRef: 'XXXXXX5252', label: 'SAMPLE second account' }),
        key,
      );
      const replay = await call(
        'POST',
        '/v1/lender/settlement-accounts',
        ids.maker,
        body({ maskedRef: 'XXXXXX5252', label: 'SAMPLE second account' }),
        key,
      );
      expect(first.statusCode, first.body).toBe(201);
      expect(replay.statusCode, replay.body).toBe(201);
      expect(replay.json<{ id: string }>().id).toBe(first.json<{ id: string }>().id);
      const again = await call(
        'POST',
        '/v1/lender/settlement-accounts',
        ids.maker,
        body({ maskedRef: 'XXXXXX5252', label: 'SAMPLE second account' }),
      );
      expect(again.json<{ id: string }>().id).toBe(first.json<{ id: string }>().id);
      const relabelled = await call(
        'POST',
        '/v1/lender/settlement-accounts',
        ids.maker,
        body({ maskedRef: 'XXXXXX5252', label: 'SAMPLE other label' }),
      );
      expect(relabelled.statusCode, relabelled.body).toBe(409);
      expect(code(relabelled)).toBe('settlement_account_exists');
    });

    it('a full account number is refused as the reference, in the label and in the bank name; unknown fields are refused', async () => {
      for (const over of [
        { maskedRef: '123456789012' },
        { maskedRef: 'XXXXXXXXXXXX' },
        { label: 'Account 123456789012' },
        { bankName: 'Bank 9876543210' },
      ]) {
        const res = await call('POST', '/v1/lender/settlement-accounts', ids.maker, body(over));
        expect(res.statusCode, JSON.stringify(over)).toBeGreaterThanOrEqual(400);
        expect(res.statusCode).toBeLessThan(500);
        expect(res.body).not.toContain('123456789012');
        expect(res.body).not.toContain('9876543210');
      }
      const extra = await call('POST', '/v1/lender/settlement-accounts', ids.maker, {
        ...body(),
        accountNumber: '123456789012',
      });
      expect(extra.statusCode).toBe(422);
      expect(extra.body).not.toContain('123456789012');
      expect(
        await q(
          "select 1 from tenancy.lender_settlement_accounts where label like 'Account 1234%' or bank_name like 'Bank 9876%'",
        ),
      ).toHaveLength(0);
    });

    it('who may ask: another lender, an approver without payment.configure, a borrower, nobody, a first-factor session', async () => {
      const cases: [string | null, 'aal1' | 'aal2', number, string | undefined][] = [
        [ids.makerB, 'aal2', 403, 'forbidden'],
        [ids.approver, 'aal2', 403, 'forbidden'],
        [ids.reader, 'aal2', 403, 'forbidden'],
        [ids.borrower, 'aal2', 403, undefined],
        [null, 'aal2', 401, undefined],
      ];
      for (const [user, aal, status, errorCode] of cases) {
        const res = await call(
          'POST',
          '/v1/lender/settlement-accounts',
          user,
          body({ maskedRef: 'XXXXXX1357' }),
          undefined,
          aal,
        );
        expect(res.statusCode, `${String(user)}: ${res.body}`).toBe(status);
        if (errorCode) expect(code(res)).toBe(errorCode);
      }
      const weak = await call(
        'POST',
        '/v1/lender/settlement-accounts',
        ids.maker,
        body({ maskedRef: 'XXXXXX1357' }),
        undefined,
        'aal1',
      );
      expect(weak.statusCode, weak.body).toBeGreaterThanOrEqual(401);
      expect(weak.statusCode).toBeLessThan(500);
      expect(
        await q(
          "select 1 from tenancy.lender_settlement_accounts where masked_account_ref = 'XXXXXX1357'",
        ),
      ).toHaveLength(0);
    });

    it('the list shows a lender only its own accounts, and needs payment.read', async () => {
      await call(
        'POST',
        '/v1/lender/settlement-accounts',
        ids.makerB,
        body({ lenderId: ids.lenderB, label: 'SAMPLE beta account', maskedRef: 'XXXXXX9090' }),
      );
      const a = await call('GET', '/v1/lender/settlement-accounts', ids.maker);
      expect(a.statusCode, a.body).toBe(200);
      const aItems = a.json<{ items: { lenderId: string }[] }>().items;
      expect(aItems.length).toBeGreaterThan(0);
      expect(new Set(aItems.map((i) => i.lenderId))).toEqual(new Set([ids.lenderA]));
      const b = await call('GET', '/v1/lender/settlement-accounts', ids.makerB);
      expect(
        new Set(b.json<{ items: { lenderId: string }[] }>().items.map((i) => i.lenderId)),
      ).toEqual(new Set([ids.lenderB]));
      const cross = await call(
        'GET',
        `/v1/lender/settlement-accounts?lenderId=${ids.lenderA}`,
        ids.makerB,
      );
      expect(cross.statusCode, cross.body).toBe(403);
      expect((await call('GET', '/v1/lender/settlement-accounts', ids.borrower)).statusCode).toBe(
        403,
      );
      expect((await call('GET', '/v1/lender/settlement-accounts', null)).statusCode).toBe(401);
    });

    it('the account stays unverified: nothing in the API verifies it, and no response carries a full number', async () => {
      const rows = await q<{ status: string }>(
        'select status::text from tenancy.lender_settlement_accounts where lender_org_id = any($1::uuid[])',
        [[ids.lenderA, ids.lenderB]],
      );
      expect(rows.length).toBeGreaterThan(0);
      expect(new Set(rows.map((r) => r.status))).toEqual(new Set(['unverified']));
      expect(seen.join('\n')).not.toMatch(/[0-9]{9,}/);
    });
  },
);
