// Send-SMS auth hook: signature first (before the body schema and before any database work), then a
// replay guard that holds across API instances (audit F-06 and R3 of the Phase 01 audit).
import { randomUUID } from 'node:crypto';
import {
  createMockIntegrityVerifier,
  createMockSmsSender,
  signMockCallback,
} from '@udofin/adapters';
import { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { type WebhookDedup } from '../src/db/user-context.js';

const SECRET = 'v1,whsec_dGVzdC1zZWNyZXQtZm9yLWhvb2tzLTAwMDAwMDAwMDAwMDA=';
const good = JSON.stringify({ user: { phone: '+919000000001' }, sms: { otp: '482913' } });

/** One shared "database" for several app instances: the same Set behind every dedup handle. */
function sharedDedup(): { handle: () => WebhookDedup; calls: string[] } {
  const seen = new Set<string>();
  const calls: string[] = [];
  return {
    calls,
    handle: () => ({
      claim: (source, id) => {
        calls.push(`${source}:${id}`);
        const key = `${source}:${id}`;
        if (seen.has(key)) return Promise.resolve(false);
        seen.add(key);
        return Promise.resolve(true);
      },
    }),
  };
}

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

async function instance(webhookDedup?: WebhookDedup) {
  const sms = createMockSmsSender('test');
  const app = await buildApp(loadConfig({ APP_ENV: 'test', RATE_LIMIT_MAX_PER_MINUTE: '100000' }), {
    borrower: {
      sms,
      integrity: createMockIntegrityVerifier('test'),
      sendSmsHookSecret: SECRET,
      smsTimeoutMs: 2000,
      ...(webhookDedup ? { webhookDedup } : {}),
    },
  });
  apps.push(app);
  return { app, sms };
}

function deliver(app: FastifyInstance, id: string, payload = good, sign = true) {
  const ts = Math.floor(Date.now() / 1000);
  return app.inject({
    method: 'POST',
    url: '/v1/hooks/send-sms',
    headers: {
      'content-type': 'application/json',
      'webhook-id': id,
      'webhook-timestamp': String(ts),
      'webhook-signature': sign ? signMockCallback(SECRET, id, ts, payload) : 'v1,AAAA',
    },
    payload,
  });
}

describe('Send-SMS hook', () => {
  it('verifies the signature before validating the body or touching the database', async () => {
    const db = sharedDedup();
    const { app, sms } = await instance(db.handle());
    // A body that fails the schema, unsigned: 401 (not 422), so an unsigned caller learns nothing about the rules.
    const unsignedBadBody = await deliver(app, 'msg_aaaa1111', '{"unexpected":true}', false);
    expect(unsignedBadBody.statusCode).toBe(401);
    expect(unsignedBadBody.json()).toMatchObject({ code: 'invalid_signature' });
    // A body that is fine, unsigned: 401.
    expect((await deliver(app, 'msg_aaaa2222', good, false)).statusCode).toBe(401);
    // No headers at all.
    const bare = await app.inject({
      method: 'POST',
      url: '/v1/hooks/send-sms',
      headers: { 'content-type': 'application/json' },
      payload: good,
    });
    expect(bare.statusCode).toBe(401);
    expect(db.calls).toEqual([]); // no database work for any unauthenticated request
    expect(sms.sent).toHaveLength(0);
  });

  it('answers a signed but invalid body with 422 and does not consume the message id', async () => {
    const db = sharedDedup();
    const { app } = await instance(db.handle());
    const res = await deliver(app, 'msg_bbbb1111', '{"unexpected":true}');
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'validation_failed' });
    expect(db.calls).toEqual([]);
  });

  it('rejects a replay that lands on a different instance sharing the same database', async () => {
    const db = sharedDedup();
    const a = await instance(db.handle());
    const b = await instance(db.handle());
    const id = `msg_${randomUUID()}`;
    expect((await deliver(a.app, id)).statusCode).toBe(200);
    const replay = await deliver(b.app, id);
    expect(replay.statusCode).toBe(401);
    expect(replay.json()).toMatchObject({ code: 'replayed' });
    expect(a.sms.sent).toHaveLength(1);
    expect(b.sms.sent).toHaveLength(0); // nothing was sent by the second instance
    // A different message is still delivered by either instance.
    expect((await deliver(b.app, `msg_${randomUUID()}`)).statusCode).toBe(200);
  });

  it('fails closed when the de-duplication store is unavailable, sending nothing', async () => {
    const { app, sms } = await instance({ claim: () => Promise.reject(new Error('db down')) });
    const res = await deliver(app, `msg_${randomUUID()}`);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'dedup_unavailable' });
    expect(res.body).not.toContain('db down');
    expect(sms.sent).toHaveLength(0);
  });

  it('refuses a signed message id outside the shape the database accepts', async () => {
    const db = sharedDedup();
    const { app, sms } = await instance(db.handle());
    const res = await deliver(app, 'bad id with spaces');
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'invalid_message_id' });
    expect(sms.sent).toHaveLength(0);
  });

  it('keeps the per-process guard as the fallback when no database guard is wired (single local process)', async () => {
    const { app, sms } = await instance();
    const id = `msg_${randomUUID()}`;
    expect((await deliver(app, id)).statusCode).toBe(200);
    expect((await deliver(app, id)).statusCode).toBe(401);
    expect(sms.sent).toHaveLength(1);
  });
});
