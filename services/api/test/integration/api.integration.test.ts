// Integration tests against a REAL migrated Postgres through the real HTTP app and the real outbox
// store. They run only when INTEGRATION_ADMIN_URL (owner, used for fixtures), INTEGRATION_API_URL
// (udofin_api) and INTEGRATION_SYSTEM_URL (udofin_system) are set; see docs/testing/strategy.md.
// The database must be disposable: fixtures are not cleaned up.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { TokenError, type TokenVerifier } from '../../src/auth/token-verifier.js';
import { loadConfig } from '../../src/config.js';
import { assertUserLoginPosture, LoginPostureError } from '../../src/db/login-posture.js';
import { createUserContext } from '../../src/db/user-context.js';
import { createMockLenderConnector } from '@udofin/adapters';
import { createRoutingProcessor } from '../../src/system/routing.js';
import { createConnectorResolver } from '../../src/workers/routing-handlers.js';
import { createBorrowerProcessor } from '../../src/system/borrower.js';
import { createChangeRequestApplier } from '../../src/system/change-requests.js';
import { createSystemPool, type SystemPool } from '../../src/system/pool.js';
import { createHandlers } from '../../src/workers/handlers.js';
import {
  OutboxWorker,
  PermanentError,
  type HandlerDefinition,
  type WorkerLogger,
} from '../../src/workers/outbox-worker.js';
import { createPgOutboxStore } from '../../src/workers/pg-outbox-store.js';
import { z } from 'zod';

const ADMIN = process.env.INTEGRATION_ADMIN_URL;
const API = process.env.INTEGRATION_API_URL;
const SYSTEM = process.env.INTEGRATION_SYSTEM_URL;
const enabled = Boolean(ADMIN && API && SYSTEM);

/** Test tokens look like `test.<user uuid>.<aal>`; the real verifier is covered separately. */
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
const silent: WorkerLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
const newKey = () => `it-${randomUUID()}`;
// Each call comes from its own client address, so route-level rate limits (tested separately) do not interfere.
let nextAddress = 1;
const freshAddress = () =>
  `10.${(nextAddress >> 16) & 255}.${(nextAddress >> 8) & 255}.${nextAddress++ & 255}`;

describe.skipIf(!enabled)('API against a real database', () => {
  const ids = {
    platformOrg: randomUUID(),
    lenderA: randomUUID(),
    lenderB: randomUUID(),
    p1: randomUUID(),
    p2: randomUUID(),
    aAdmin: randomUUID(),
    aSuspended: randomUUID(),
    bAdmin: randomUUID(),
    nobody: randomUUID(),
    borrower: randomUUID(),
  };
  let admin: pg.Pool;
  let apiPool: pg.Pool;
  let systemPool: SystemPool;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let worker: OutboxWorker;

  const store = () => createPgOutboxStore(systemPool);

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: ADMIN, max: 2 });
    apiPool = new pg.Pool({ connectionString: API, max: 10 });
    systemPool = createSystemPool(SYSTEM ?? '');

    const staff = [ids.p1, ids.p2, ids.aAdmin, ids.aSuspended, ids.bAdmin, ids.nobody];
    for (const id of staff) {
      await admin.query(
        `insert into auth.users (id, phone, raw_app_meta_data) values ($1, null, '{"actor_type":"staff"}')`,
        [id],
      );
    }
    await admin.query(
      `insert into auth.users (id, phone, raw_app_meta_data) values ($1, $2, '{}')`,
      [ids.borrower, `91${Math.floor(1_000_000_000 + Math.random() * 8_999_999_999)}`],
    );
    // Exactly one platform organisation can exist; reuse it when an earlier run left one behind.
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
        ($1, 'lender', 'Alpha IT Ltd', 'Alpha IT', 'IT-NBFC-A', 'active'),
        ($2, 'lender', 'Beta IT Ltd', 'Beta IT', 'IT-NBFC-B', 'active')`,
      [ids.lenderA, ids.lenderB],
    );
    const members: [string, string, string, string][] = [
      [ids.platformOrg, ids.p1, 'active', 'platform_admin'],
      [ids.platformOrg, ids.p2, 'active', 'platform_admin'],
      [ids.lenderA, ids.aAdmin, 'active', 'lender_admin'],
      [ids.lenderA, ids.aSuspended, 'suspended', 'lender_admin'],
      [ids.lenderB, ids.bAdmin, 'active', 'lender_admin'],
    ];
    for (const [org, user, status, role] of members) {
      const m = await admin.query<{ id: string }>(
        'insert into tenancy.memberships (org_id, user_id, status) values ($1, $2, $3) returning id',
        [org, user, status],
      );
      await admin.query(
        `insert into tenancy.membership_roles (membership_id, role_id)
         select $1, r.id from tenancy.roles r join tenancy.organizations o on o.kind = r.applies_to
          where o.id = $2 and r.org_id is null and r.key = $3`,
        [m.rows[0]?.id, org, role],
      );
    }

    app = await buildApp(loadConfig({ APP_ENV: 'test' }), {
      auth: { verifier: fakeVerifier, context: createUserContext(apiPool) },
    });

    const applier = createChangeRequestApplier(systemPool);
    worker = new OutboxWorker({
      store: store(),
      handlers: createHandlers({
        applier,
        borrower: createBorrowerProcessor(systemPool),
        routing: createRoutingProcessor(systemPool),
        connectors: createConnectorResolver({
          environment: 'test',
          createMock: () => createMockLenderConnector('test'),
        }),
        changeRequestStatus: (id) =>
          systemPool.withSystem(async (tx) => {
            const r = await tx.query<{ status: string }>(
              'select status::text as status from tenancy.change_requests where id = $1::uuid',
              [id],
            );
            return r.rows[0]?.status;
          }),
      }),
      workerId: `it-${randomUUID().slice(0, 8)}`,
      log: silent,
    });
  });

  afterAll(async () => {
    await app?.close();
    await systemPool?.end();
    await apiPool?.end();
    await admin?.end();
  });

  const me = (headers: Record<string, string>) =>
    app.inject({ method: 'GET', url: '/v1/me', headers });
  const post = (
    url: string,
    user: string,
    payload: unknown,
    key: string | null = newKey(),
    aal: 'aal1' | 'aal2' = 'aal2',
  ) =>
    app.inject({
      method: 'POST',
      url,
      remoteAddress: freshAddress(),
      headers: { ...token(user, aal), ...(key ? { 'idempotency-key': key } : {}) },
      payload: payload as object,
    });
  const orgBody = (name: string) => ({
    type: 'organization.create',
    payload: {
      kind: 'lender',
      legal_name: name,
      display_name: 'IT Org',
      regulator_registration_no: 'IT-NBFC-X',
    },
  });
  const drain = async () => {
    for (let i = 0; i < 20; i += 1) if ((await worker.runOnce()).claimed === 0) return;
  };
  const count = async (sql: string, args: unknown[] = []) =>
    Number((await admin.query<{ n: string }>(sql, args)).rows[0]?.n ?? 0);

  describe('authentication and authorisation', () => {
    it('requires a token', async () => {
      expect((await me({})).statusCode).toBe(401);
      expect((await me({ authorization: 'Bearer garbage' })).statusCode).toBe(401);
    });

    it('returns identity, memberships and permissions resolved by the database', async () => {
      const res = await me(token(ids.aAdmin));
      expect(res.statusCode).toBe(200);
      const body = res.json<{
        actor: string;
        memberships: { organizationId: string; permissions: string[] }[];
      }>();
      expect(body.actor).toBe('lender');
      expect(body.memberships).toHaveLength(1);
      expect(body.memberships[0]?.organizationId).toBe(ids.lenderA);
      expect(body.memberships[0]?.permissions).toContain('org.members.manage');
    });

    it('refuses staff without the second factor, but not borrowers', async () => {
      const staff = await me(token(ids.aAdmin, 'aal1'));
      expect(staff.statusCode).toBe(401);
      expect(staff.json<{ code: string }>().code).toBe('mfa_required');
      const borrower = await me(token(ids.borrower, 'aal1'));
      expect(borrower.statusCode).toBe(200);
      expect(borrower.json<{ actor: string }>().actor).toBe('borrower');
    });

    it('refuses a suspended membership and a user with no access on the next request', async () => {
      expect((await me(token(ids.aSuspended))).statusCode).toBe(403);
      expect((await me(token(ids.nobody))).statusCode).toBe(403);
    });

    it('does not let a borrower use staff routes', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/admin/change-requests',
        headers: token(ids.borrower, 'aal1'),
      });
      expect(res.statusCode).toBe(403);
    });

    it('keeps tenants apart on the change-request routes', async () => {
      const own = await post('/v1/admin/change-requests', ids.aAdmin, {
        type: 'membership.suspend',
        targetOrganizationId: ids.lenderB,
        payload: { membership_id: randomUUID() },
      });
      expect(own.statusCode).toBe(403);
      const list = await app.inject({
        method: 'GET',
        url: '/v1/admin/change-requests',
        headers: token(ids.bAdmin),
      });
      const items = list.json<{ items: { targetOrganizationId: string | null }[] }>().items;
      expect(items.every((i) => i.targetOrganizationId === ids.lenderB)).toBe(true);
    });

    it('a cursor with an impossible date is a client error, not a server error', async () => {
      const cursor = Buffer.from(
        JSON.stringify({ t: '9999-99-99 99:99:99+00', id: randomUUID() }),
      ).toString('base64url');
      const res = await app.inject({
        method: 'GET',
        url: `/v1/admin/change-requests?cursor=${cursor}`,
        headers: token(ids.p1),
      });
      expect(res.statusCode).toBe(422);
      const junk = await app.inject({
        method: 'GET',
        url: '/v1/admin/change-requests?cursor=not-a-cursor',
        headers: token(ids.p1),
      });
      expect(junk.statusCode).toBe(400);
      expect(junk.json<{ code: string }>().code).toBe('invalid_cursor');
    });

    it('validation errors do not echo submitted values', async () => {
      const res = await post('/v1/admin/change-requests', ids.p1, {
        type: 'organization.create',
        payload: { legal_name: 'Secret Name 98765' },
        extra: 1,
      });
      expect(res.statusCode).toBe(422);
      expect(res.body).not.toContain('Secret Name');
      expect(res.headers['content-type']).toContain('application/problem+json');
    });
  });

  describe('idempotency', () => {
    it('requires an Idempotency-Key on idempotent POSTs', async () => {
      const res = await post(
        '/v1/admin/change-requests',
        ids.p1,
        orgBody(`NoKey ${randomUUID()}`),
        null,
      );
      expect(res.statusCode).toBe(400);
      expect(res.json<{ code: string }>().code).toBe('idempotency_key_required');
    });

    it('replays the original response for an identical repeat and creates nothing new', async () => {
      const key = newKey();
      const name = `Replay ${randomUUID()}`;
      const first = await post('/v1/admin/change-requests', ids.p1, orgBody(name), key);
      const second = await post('/v1/admin/change-requests', ids.p1, orgBody(name), key);
      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(201);
      expect(second.json()).toEqual(first.json());
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(first.headers['idempotent-replayed']).toBeUndefined();
      expect(
        await count(
          `select count(*) n from tenancy.change_requests where payload->>'legal_name' = $1`,
          [name],
        ),
      ).toBe(1);
    });

    it('treats a reordered but equivalent body as the same request', async () => {
      const key = newKey();
      const name = `Order ${randomUUID()}`;
      const a = await post(
        '/v1/admin/change-requests',
        ids.p1,
        {
          type: 'organization.create',
          payload: { kind: 'lender', legal_name: name, display_name: 'D' },
        },
        key,
      );
      const b = await post(
        '/v1/admin/change-requests',
        ids.p1,
        {
          payload: { display_name: 'D', legal_name: name, kind: 'lender' },
          type: 'organization.create',
        },
        key,
      );
      expect(b.statusCode).toBe(201);
      expect(b.json()).toEqual(a.json());
    });

    it('refuses the same key with a different request', async () => {
      const key = newKey();
      await post('/v1/admin/change-requests', ids.p1, orgBody(`First ${randomUUID()}`), key);
      const res = await post(
        '/v1/admin/change-requests',
        ids.p1,
        orgBody(`Second ${randomUUID()}`),
        key,
      );
      expect(res.statusCode).toBe(422);
      expect(res.json<{ code: string }>().code).toBe('idempotency_key_reused');
    });

    it('serialises concurrent duplicates into exactly one effect', async () => {
      const key = newKey();
      const name = `Concurrent ${randomUUID()}`;
      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          post('/v1/admin/change-requests', ids.p1, orgBody(name), key),
        ),
      );
      expect(results.every((r) => r.statusCode === 201)).toBe(true);
      expect(new Set(results.map((r) => r.json<{ id: string }>().id)).size).toBe(1);
      expect(results.filter((r) => r.headers['idempotent-replayed'] === 'true')).toHaveLength(5);
      expect(
        await count(
          `select count(*) n from tenancy.change_requests where payload->>'legal_name' = $1`,
          [name],
        ),
      ).toBe(1);
    });

    it('a failed attempt leaves no record, so a retry with the same key runs again', async () => {
      const key = newKey();
      const bad = await post(
        '/v1/admin/change-requests',
        ids.p1,
        {
          type: 'organization.create',
          payload: { kind: 'platform', legal_name: 'X', display_name: 'Y' },
        },
        key,
      );
      expect(bad.statusCode).toBe(422);
      expect(
        await count(`select count(*) n from ops.idempotency_keys where idem_key = $1`, [key]),
      ).toBe(0);
      const ok = await post(
        '/v1/admin/change-requests',
        ids.p1,
        orgBody(`Retry ${randomUUID()}`),
        key,
      );
      expect(ok.statusCode).toBe(201);
    });

    it('is isolated per user and per tenant', async () => {
      const key = newKey();
      const body = { type: 'membership.suspend', payload: { membership_id: randomUUID() } };
      const platformUser = await post(
        '/v1/admin/change-requests',
        ids.p1,
        orgBody(`Iso ${randomUUID()}`),
        key,
      );
      const otherPlatformUser = await post(
        '/v1/admin/change-requests',
        ids.p2,
        orgBody(`Iso2 ${randomUUID()}`),
        key,
      );
      expect(platformUser.statusCode).toBe(201);
      expect(otherPlatformUser.statusCode).toBe(201);
      expect(otherPlatformUser.json<{ id: string }>().id).not.toBe(
        platformUser.json<{ id: string }>().id,
      );
      expect(otherPlatformUser.headers['idempotent-replayed']).toBeUndefined();
      // Two lenders using the same key never see each other's stored response.
      const aRes = await post(
        '/v1/admin/change-requests',
        ids.aAdmin,
        { ...body, targetOrganizationId: ids.lenderA },
        key,
      );
      const bRes = await post(
        '/v1/admin/change-requests',
        ids.bAdmin,
        { ...body, targetOrganizationId: ids.lenderB },
        key,
      );
      expect([aRes.headers['idempotent-replayed'], bRes.headers['idempotent-replayed']]).toEqual([
        undefined,
        undefined,
      ]);
    });

    it('still checks authentication before replaying a stored response', async () => {
      const key = newKey();
      const name = `Auth ${randomUUID()}`;
      await post('/v1/admin/change-requests', ids.p1, orgBody(name), key);
      const noMfa = await post('/v1/admin/change-requests', ids.p1, orgBody(name), key, 'aal1');
      expect(noMfa.statusCode).toBe(401);
      const stranger = await post('/v1/admin/change-requests', ids.nobody, orgBody(name), key);
      expect(stranger.statusCode).toBe(403);
    });

    it('stops protecting a key after it expires (the domain guard still prevents a duplicate request)', async () => {
      const key = newKey();
      const name = `Expire ${randomUUID()}`;
      const first = await post('/v1/admin/change-requests', ids.p1, orgBody(name), key);
      await admin.query(
        `update ops.idempotency_keys set expires_at = now() - interval '1 minute' where idem_key = $1`,
        [key],
      );
      // After expiry the HTTP-level record is gone: the handler runs again (no replay header) ...
      const again = await post('/v1/admin/change-requests', ids.p1, orgBody(name), key);
      expect(again.statusCode).toBe(201);
      expect(again.headers['idempotent-replayed']).toBeUndefined();
      // ... and a different request under the expired key is accepted as a new request.
      const other = await post('/v1/admin/change-requests', ids.p1, orgBody(`${name} other`), key);
      expect(other.statusCode).toBe(422); // the refreshed record protects the key again
      // The database's own (requester, key) guard returns the same request instead of creating a second.
      expect(again.json<{ id: string }>().id).toBe(first.json<{ id: string }>().id);
      expect(
        await count(
          `select count(*) n from tenancy.change_requests where payload->>'legal_name' = $1`,
          [name],
        ),
      ).toBe(1);
    });
  });

  describe('two-person flow with the outbox', () => {
    it('approval commits with its outbox event; the worker applies the change', async () => {
      const name = `Flow ${randomUUID()}`;
      const create = await post('/v1/admin/change-requests', ids.p1, orgBody(name));
      const id = create.json<{ id: string }>().id;

      expect((await post(`/v1/admin/change-requests/${id}/approve`, ids.p1, {})).statusCode).toBe(
        403,
      );
      expect(
        (await post(`/v1/admin/change-requests/${id}/approve`, ids.aAdmin, {})).statusCode,
      ).toBe(404);

      const approve = await post(`/v1/admin/change-requests/${id}/approve`, ids.p2, {});
      expect(approve.statusCode).toBe(200);
      expect(approve.json<{ status: string }>().status).toBe('approved');

      expect(
        await count(
          `select count(*) n from ops.outbox_events where payload->>'change_request_id' = $1 and status = 'pending'`,
          [id],
        ),
      ).toBe(1);
      expect(
        await count(`select count(*) n from tenancy.organizations where legal_name = $1`, [name]),
      ).toBe(0);

      await drain();
      const read = await app.inject({
        method: 'GET',
        url: `/v1/admin/change-requests/${id}`,
        headers: token(ids.p1),
      });
      expect(read.json<{ status: string }>().status).toBe('applied');
      expect(
        await count(
          `select count(*) n from tenancy.organizations where legal_name = $1 and status = 'onboarding'`,
          [name],
        ),
      ).toBe(1);
      expect(
        await count(
          `select count(*) n from ops.outbox_events where payload->>'change_request_id' = $1 and status = 'completed'`,
          [id],
        ),
      ).toBe(1);
    });

    it('approving twice with the same key replays; a duplicate delivery changes nothing', async () => {
      const name = `Dup ${randomUUID()}`;
      const id = (await post('/v1/admin/change-requests', ids.p1, orgBody(name))).json<{
        id: string;
      }>().id;
      const key = newKey();
      const a = await post(`/v1/admin/change-requests/${id}/approve`, ids.p2, {}, key);
      const b = await post(`/v1/admin/change-requests/${id}/approve`, ids.p2, {}, key);
      expect(b.json()).toEqual(a.json());
      expect(b.headers['idempotent-replayed']).toBe('true');
      // A different key for an already-decided request is a conflict, not a second approval.
      expect(
        (await post(`/v1/admin/change-requests/${id}/approve`, ids.p2, {}, newKey())).statusCode,
      ).toBe(409);

      await drain();
      // Deliver the same fact again under a different dedupe key: the handler must be a no-op.
      await admin.query(
        `select ops.enqueue_event('change_request.approved', jsonb_build_object('change_request_id', $1::uuid), null, $2)`,
        [id, `manual-${randomUUID()}`],
      );
      await drain();
      expect(
        await count(`select count(*) n from tenancy.organizations where legal_name = $1`, [name]),
      ).toBe(1);
      expect(
        await count(
          `select count(*) n from ops.outbox_events where payload->>'change_request_id' = $1 and status = 'completed'`,
          [id],
        ),
      ).toBe(2);
    });

    it('a decision that rolls back leaves no outbox event', async () => {
      const id = (
        await post('/v1/admin/change-requests', ids.p1, orgBody(`Atomic ${randomUUID()}`))
      ).json<{ id: string }>().id;
      const context = createUserContext(apiPool);
      await expect(
        context.withUserContext({ sub: ids.p2, aal: 'aal2', sessionId: null }, async (tx) => {
          await tx.query('select private.decide_change_request($1::uuid, true)', [id]);
          throw new Error('abort after the decision');
        }),
      ).rejects.toThrow('abort after the decision');
      expect(
        await count(
          `select count(*) n from ops.outbox_events where payload->>'change_request_id' = $1`,
          [id],
        ),
      ).toBe(0);
      expect(
        await count(
          `select count(*) n from tenancy.change_requests where id = $1 and status = 'pending'`,
          [id],
        ),
      ).toBe(1);
    });

    it('recovers an event whose worker died holding the lease', async () => {
      const name = `Recover ${randomUUID()}`;
      const id = (await post('/v1/admin/change-requests', ids.p1, orgBody(name))).json<{
        id: string;
      }>().id;
      await post(`/v1/admin/change-requests/${id}/approve`, ids.p2, {});
      // The dying worker claims everything ready (other tests may have left events behind) and then vanishes.
      let claimedTarget = false;
      for (let i = 0; i < 50 && !claimedTarget; i += 1) {
        const batch = await store().claim('dying-worker', 100, 30);
        if (batch.length === 0) break;
        claimedTarget = batch.some(
          (e) => (e.payload as { change_request_id?: string }).change_request_id === id,
        );
      }
      expect(claimedTarget).toBe(true);
      await admin.query(
        `update ops.outbox_events set locked_until = now() - interval '1 second' where status = 'processing' and locked_by = 'dying-worker'`,
      );
      await drain();
      expect(
        await count(`select count(*) n from tenancy.organizations where legal_name = $1`, [name]),
      ).toBe(1);
    });
  });

  describe('worker reliability against the real store', () => {
    const testHandlers = (seen: Map<string, number>): Record<string, HandlerDefinition> => ({
      'test.counted': {
        schema: z.strictObject({ ref: z.string() }),
        run: async (payload) => {
          const { ref } = payload as { ref: string };
          await new Promise((resolve) => setTimeout(resolve, 15));
          seen.set(ref, (seen.get(ref) ?? 0) + 1);
        },
      },
      'test.flaky': {
        schema: z.strictObject({ ref: z.string() }),
        run: () => Promise.reject(new Error('upstream down 9876543210')),
      },
      'test.refused': {
        schema: z.strictObject({ ref: z.string() }),
        run: () => Promise.reject(new PermanentError('refused_by_rule')),
      },
    });
    const workerWith = (handlers: Record<string, HandlerDefinition>, logs: string[] = []) =>
      new OutboxWorker({
        store: store(),
        handlers,
        workerId: `it-${randomUUID().slice(0, 8)}`,
        concurrency: 5,
        log: {
          info: (f, m) => logs.push(JSON.stringify({ f, m })),
          warn: (f, m) => logs.push(JSON.stringify({ f, m })),
          error: (f, m) => logs.push(JSON.stringify({ f, m })),
        },
      });
    const enqueue = async (type: string, ref: string) =>
      (
        await admin.query<{ id: string }>(
          `select ops.enqueue_event($1, jsonb_build_object('ref', $2::text), null, $3) as id`,
          [type, ref, `it-${randomUUID()}`],
        )
      ).rows[0]?.id as string;

    it('three concurrent workers process each event exactly once when nothing fails', async () => {
      const seen = new Map<string, number>();
      const refs = Array.from({ length: 24 }, () => randomUUID());
      for (const ref of refs) await enqueue('test.counted', ref);
      const workers = [1, 2, 3].map(() => workerWith(testHandlers(seen)));
      await Promise.all(
        workers.map(async (w) => {
          for (let i = 0; i < 30; i += 1)
            if ((await w.runOnce()).claimed === 0 && seen.size >= refs.length) return;
        }),
      );
      for (const ref of refs) expect(seen.get(ref)).toBe(1);
    });

    it('retries with backoff, then dead-letters, without storing error text', async () => {
      const logs: string[] = [];
      const w = workerWith(testHandlers(new Map()), logs);
      const id = await enqueue('test.flaky', randomUUID());
      await admin.query('update ops.outbox_events set max_attempts = 2 where id = $1', [id]);
      const first = await w.runOnce();
      expect(first.retried).toBe(1);
      const waiting = await admin.query<{
        status: string;
        available_at: Date;
        last_error_code: string;
      }>(
        'select status::text, available_at, last_error_code from ops.outbox_events where id = $1',
        [id],
      );
      expect(waiting.rows[0]?.status).toBe('pending');
      expect(waiting.rows[0]?.available_at.getTime()).toBeGreaterThan(Date.now());
      expect(waiting.rows[0]?.last_error_code).toBe('handler_error');
      expect((await w.runOnce()).claimed).toBe(0); // still backing off
      await admin.query(
        `update ops.outbox_events set available_at = now() - interval '1 second' where id = $1`,
        [id],
      );
      const second = await w.runOnce();
      expect(second.dead).toBe(1);
      expect(
        await count(
          `select count(*) n from ops.outbox_events where id = $1 and status = 'dead' and attempts = 2`,
          [id],
        ),
      ).toBe(1);
      expect(logs.join('\n')).not.toContain('9876543210');
      expect(logs.join('\n')).toContain('outbox event is dead');
    });

    it('retries an unknown event type; treats an invalid payload and a refused rule as permanent', async () => {
      const w = workerWith(testHandlers(new Map()));
      const unknown = await enqueue('test.nobody_handles_this', 'x');
      const invalid = (
        await admin.query<{ id: string }>(
          `select ops.enqueue_event('test.counted', '{"unexpected":"field"}', null, $1) as id`,
          [`it-${randomUUID()}`],
        )
      ).rows[0]?.id as string;
      const refused = await enqueue('test.refused', 'x');
      await w.runOnce();
      const rows = await admin.query<{ id: string; status: string; last_error_code: string }>(
        'select id, status::text, last_error_code from ops.outbox_events where id = any($1::uuid[])',
        [[unknown, invalid, refused]],
      );
      const byId = new Map(rows.rows.map((r) => [r.id, r]));
      // Unknown types are retried (a newer release may handle them) rather than dead-lettered at once.
      expect(byId.get(unknown)).toMatchObject({
        status: 'pending',
        last_error_code: 'unknown_event_type',
      });
      expect(byId.get(invalid)).toMatchObject({
        status: 'dead',
        last_error_code: 'invalid_payload',
      });
      expect(byId.get(refused)).toMatchObject({
        status: 'dead',
        last_error_code: 'refused_by_rule',
      });
    });
  });

  describe('platform plumbing', () => {
    it('boot guard accepts the API login and refuses the system login', async () => {
      await expect(assertUserLoginPosture(apiPool)).resolves.toBeUndefined();
      const sysAsUser = new pg.Pool({ connectionString: SYSTEM, max: 1 });
      try {
        await expect(assertUserLoginPosture(sysAsUser)).rejects.toBeInstanceOf(LoginPostureError);
      } finally {
        await sysAsUser.end();
      }
    });

    it('the API login cannot read tables or the ops schema directly, only through the assumed role', async () => {
      await expect(
        apiPool.query('select 1 from tenancy.organizations limit 1'),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(apiPool.query('select 1 from ops.outbox_events limit 1')).rejects.toMatchObject({
        code: '42501',
      });
      await expect(apiPool.query('set role service_role')).rejects.toMatchObject({ code: '42501' });
    });

    it('serves the OpenAPI document outside production', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/openapi.json' });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ openapi: string }>().openapi).toBe('3.1.0');
    });
  });
});
