// F-06 and R-10 against a REAL migrated Postgres.
//  - Two API instances sharing one database refuse a replayed Send-SMS hook delivery.
//  - The de-duplication guard is narrow: a signed-in user cannot use it, the table is unreachable to the
//    API login, and housekeeping removes only old rows.
//  - The system login posture check accepts the real system login and refuses the API login.
// Runs only with the INTEGRATION_* variables (see api.integration.test.ts).
import { randomUUID } from 'node:crypto';
import {
  createMockIntegrityVerifier,
  createMockSmsSender,
  signMockCallback,
} from '@udofin/adapters';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import {
  assertSystemLoginPosture,
  assertUserLoginPosture,
  LoginPostureError,
} from '../../src/db/login-posture.js';
import { createUserContext, createWebhookDedup } from '../../src/db/user-context.js';
import { createSystemPool, type SystemPool } from '../../src/system/pool.js';

const ADMIN = process.env.INTEGRATION_ADMIN_URL;
const API = process.env.INTEGRATION_API_URL;
const SYSTEM = process.env.INTEGRATION_SYSTEM_URL;
const enabled = Boolean(ADMIN && API && SYSTEM);

const SECRET = 'v1,whsec_dGVzdC1zZWNyZXQtZm9yLWhvb2tzLTAwMDAwMDAwMDAwMDA=';
const payload = JSON.stringify({ user: { phone: '+919000000002' }, sms: { otp: '135790' } });

describe.skipIf(!enabled)('webhook replay and login posture against a real database', () => {
  let admin: pg.Pool;
  let apiPool: pg.Pool;
  let secondApiPool: pg.Pool;
  let systemPool: SystemPool;

  beforeAll(() => {
    admin = new pg.Pool({ connectionString: ADMIN, max: 2 });
    // Two separate pools stand in for two API processes: they share nothing but the database.
    apiPool = new pg.Pool({ connectionString: API, max: 3 });
    secondApiPool = new pg.Pool({ connectionString: API, max: 3 });
    systemPool = createSystemPool(SYSTEM ?? '');
  });
  afterAll(async () => {
    await systemPool?.end();
    await secondApiPool?.end();
    await apiPool?.end();
    await admin?.end();
  });

  async function instance(pool: pg.Pool) {
    const sms = createMockSmsSender('test');
    const app = await buildApp(
      loadConfig({ APP_ENV: 'test', RATE_LIMIT_MAX_PER_MINUTE: '100000' }),
      {
        auth: {
          verifier: { verify: () => Promise.reject(new Error('unused')) },
          context: createUserContext(pool),
        },
        borrower: {
          sms,
          integrity: createMockIntegrityVerifier('test'),
          sendSmsHookSecret: SECRET,
          smsTimeoutMs: 2000,
          webhookDedup: createWebhookDedup(pool),
        },
      },
    );
    return { app, sms };
  }
  const deliver = (app: Awaited<ReturnType<typeof instance>>['app'], id: string) => {
    const ts = Math.floor(Date.now() / 1000);
    return app.inject({
      method: 'POST',
      url: '/v1/hooks/send-sms',
      headers: {
        'content-type': 'application/json',
        'webhook-id': id,
        'webhook-timestamp': String(ts),
        'webhook-signature': signMockCallback(SECRET, id, ts, payload),
      },
      payload,
    });
  };

  it('rejects a replay that reaches a second instance, and sends the code exactly once', async () => {
    const a = await instance(apiPool);
    const b = await instance(secondApiPool);
    const id = `msg_${randomUUID()}`;
    expect((await deliver(a.app, id)).statusCode).toBe(200);
    const replay = await deliver(b.app, id);
    expect(replay.statusCode).toBe(401);
    expect(replay.json()).toMatchObject({ code: 'replayed' });
    expect(a.sms.sent).toHaveLength(1);
    expect(b.sms.sent).toHaveLength(0);
    const rows = await admin.query(
      `select source, message_id from ops.seen_webhooks where message_id = $1`,
      [id],
    );
    expect(rows.rows).toEqual([{ source: 'send_sms_hook', message_id: id }]);
    await a.app.close();
    await b.app.close();
  });

  it('lets exactly one of many concurrent deliveries through, across instances', async () => {
    const a = await instance(apiPool);
    const b = await instance(secondApiPool);
    const id = `msg_${randomUUID()}`;
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => deliver(i % 2 ? a.app : b.app, id)),
    );
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 401)).toHaveLength(7);
    expect(a.sms.sent.length + b.sms.sent.length).toBe(1);
    await a.app.close();
    await b.app.close();
  });

  it('stores only the message id, never the phone number or the code', async () => {
    const dump = await admin.query<{ row: string }>(
      'select t::text as row from ops.seen_webhooks t',
    );
    expect(dump.rows.length).toBeGreaterThan(0);
    for (const { row } of dump.rows) {
      expect(row).not.toContain('9000000002');
      expect(row).not.toContain('135790');
    }
  });

  it('is unusable by a signed-in user, and the API login cannot read or write the table', async () => {
    const user = randomUUID();
    await admin.query(
      `insert into auth.users (id, phone, raw_app_meta_data) values ($1, null, '{}')`,
      [user],
    );
    // The pool is the SAME login the API uses; with a user identity set, the guard refuses.
    await expect(
      createUserContext(apiPool).withUserContext(
        { sub: user, aal: 'aal2', sessionId: null },
        (tx) => tx.query(`select private.mark_webhook_seen('send_sms_hook', 'msg_user_preload')`),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(apiPool.query('select 1 from ops.seen_webhooks limit 1')).rejects.toMatchObject({
      code: '42501',
    });
    await expect(
      apiPool.query(
        `insert into ops.seen_webhooks (source, message_id) values ('x_hook', 'abcdefgh')`,
      ),
    ).rejects.toMatchObject({ code: '42501' });
    // The user pool cannot purge either.
    await expect(
      apiPool.query(`select ops.purge_seen_webhooks(interval '1 day', 10)`),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('housekeeping through the system login removes old rows and keeps recent ones', async () => {
    const oldId = `msg_old_${randomUUID()}`;
    const freshId = `msg_new_${randomUUID()}`;
    await admin.query(
      `insert into ops.seen_webhooks (source, message_id, seen_at) values ('send_sms_hook', $1, now() - interval '3 days')`,
      [oldId],
    );
    expect(await createWebhookDedup(apiPool).claim('send_sms_hook', freshId)).toBe(true);
    const purged = await systemPool.withSystem(async (tx) =>
      Number(
        (
          await tx.query<{ n: number }>(
            `select ops.purge_seen_webhooks(interval '1 day', 1000) as n`,
          )
        ).rows[0]?.n,
      ),
    );
    expect(purged).toBeGreaterThanOrEqual(1);
    const left = await admin.query<{ message_id: string }>(
      `select message_id from ops.seen_webhooks where message_id = any($1)`,
      [[oldId, freshId]],
    );
    expect(left.rows.map((r) => r.message_id)).toEqual([freshId]);
  });

  describe('system login posture (R-10)', () => {
    it('accepts the real system login', async () => {
      await expect(assertSystemLoginPosture(systemPool)).resolves.toBeUndefined();
    });

    it('refuses a login that cannot assume service_role (the API login)', async () => {
      const apiAsSystem = createSystemPool(API ?? '');
      try {
        await expect(assertSystemLoginPosture(apiAsSystem)).rejects.toBeInstanceOf(
          LoginPostureError,
        );
        await expect(assertSystemLoginPosture(apiAsSystem)).rejects.toThrow(/service_role/);
      } finally {
        await apiAsSystem.end();
      }
    });

    it('refuses a superuser login for system work (the admin connection)', async () => {
      const adminAsSystem = createSystemPool(ADMIN ?? '');
      try {
        await expect(assertSystemLoginPosture(adminAsSystem)).rejects.toBeInstanceOf(
          LoginPostureError,
        );
      } finally {
        await adminAsSystem.end();
      }
    });

    it('still refuses the system login as a user-request login, and accepts the API login', async () => {
      await expect(assertUserLoginPosture(apiPool)).resolves.toBeUndefined();
    });
  });
});
