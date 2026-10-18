// F-03: before the signature is verified, every outcome of the callback receiver looks the same, so lender
// ids cannot be enumerated. Real configuration problems stay in the server log.
import { randomUUID } from 'node:crypto';
import { signMockCallback } from '@udofin/adapters';
import { afterEach, describe, expect, it } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.js';
import { type LenderHookContext, type RoutingProcessor } from '../src/system/routing.js';
import { buildCallbackApp } from '../src/workers/lender-callbacks.js';

const SECRET = 'v1,whsec_dGVzdC1zZWNyZXQtZm9yLWNhbGxiYWNrcy0wMDAwMDAwMDA=';
const lenders = new Map<string, LenderHookContext | null>();
let ingested = 0;
const routing = {
  hookContext: (id: string) => Promise.resolve(lenders.get(id) ?? null),
  ingest: () => {
    ingested += 1;
    return Promise.resolve({ outcome: 'applied' });
  },
} as unknown as RoutingProcessor;

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
  lenders.clear();
  ingested = 0;
});

const context = (over: Partial<LenderHookContext>): LenderHookContext => ({
  status: 'active',
  kind: 'mock',
  signingSecretRef: 'SECRET_REF',
  ...over,
});

async function start(
  environment: 'local' | 'test' | 'staging' | 'production' = 'test',
  secret: (name: string) => string | undefined = () => SECRET,
) {
  app = await buildCallbackApp(
    loadConfig({ APP_ENV: 'test', RATE_LIMIT_MAX_PER_MINUTE: '100000' }),
    {
      routing,
      secret,
      environment,
    },
  );
  return app;
}

const body = JSON.stringify({
  correlationRef: randomUUID(),
  type: 'ack',
  body: {},
});
async function post(lender: string, headers: Record<string, string> = {}, payload = body) {
  return app!.inject({
    method: 'POST',
    url: `/v1/hooks/lenders/${lender}`,
    headers: { 'content-type': 'application/json', ...headers },
    payload,
  });
}
function signed(secret = SECRET) {
  const id = `msg-${randomUUID()}`;
  const ts = Math.floor(Date.now() / 1000);
  return {
    'webhook-id': id,
    'webhook-timestamp': String(ts),
    'webhook-signature': signMockCallback(secret, id, ts, body),
  };
}

/** What a caller can observe, minus the per-request id. */
const observable = (res: Awaited<ReturnType<typeof post>>) => {
  const { instance: _instance, ...rest } = res.json<Record<string, unknown>>();
  return { status: res.statusCode, type: res.headers['content-type'], body: rest };
};

describe('lender callback receiver: unauthenticated outcomes are indistinguishable', () => {
  it('answers the same for unknown, inactive, manual and api-kind lenders, bad ids and missing headers', async () => {
    await start('test', (name) => (name === 'SECRET_REF' ? SECRET : undefined));
    const active = randomUUID();
    const inactive = randomUUID();
    const manual = randomUUID();
    const api = randomUUID();
    const noSecret = randomUUID();
    lenders.set(active, context({}));
    lenders.set(inactive, context({ status: 'suspended' }));
    lenders.set(manual, context({ kind: 'manual' }));
    lenders.set(api, context({ kind: 'api' }));
    lenders.set(noSecret, context({ signingSecretRef: 'MISSING' }));

    const attempts = [
      await post(randomUUID(), signed()), // unknown lender
      await post(inactive, signed()),
      await post(manual, signed()),
      await post(api, signed()), // scheme not written yet: a configuration state, not a distinguishable answer
      await post(noSecret, signed()), // secret reference not resolvable: configuration error
      await post('not-a-lender-id', signed()),
      await post(active, {}), // no headers at all
      await post(active, { ...signed(), 'webhook-id': 'x' }), // malformed message id
      await post(active, { ...signed(), 'webhook-signature': 'v1,AAAA' }), // bad signature for a REAL lender
    ];
    const first = observable(attempts[0]!);
    expect(first.status).toBe(401);
    expect(first.body).toEqual({
      type: 'about:blank',
      title: 'Unauthorized',
      status: 401,
      code: 'invalid_signature',
    });
    for (const attempt of attempts) expect(observable(attempt)).toEqual(first);
    expect(ingested).toBe(0);
  });

  it('answers the same in a deployed environment, where mock lenders are refused', async () => {
    await start('production');
    const mock = randomUUID();
    lenders.set(mock, context({}));
    const real = observable(await post(mock, signed()));
    const unknown = observable(await post(randomUUID(), signed()));
    expect(real).toEqual(unknown);
    expect(real.status).toBe(401);
  });

  it('still accepts a correctly signed event for an active mock lender', async () => {
    await start();
    const id = randomUUID();
    lenders.set(id, context({}));
    const res = await post(id, signed());
    expect(res.statusCode).toBe(200);
    expect(ingested).toBe(1);
  });

  it('refuses a validly signed body that fails validation only after authentication (422)', async () => {
    await start();
    const id = randomUUID();
    lenders.set(id, context({}));
    const bad = JSON.stringify({ nope: true });
    const messageId = `msg-${randomUUID()}`;
    const ts = Math.floor(Date.now() / 1000);
    const res = await post(
      id,
      {
        'webhook-id': messageId,
        'webhook-timestamp': String(ts),
        'webhook-signature': signMockCallback(SECRET, messageId, ts, bad),
      },
      bad,
    );
    expect(res.statusCode).toBe(422);
  });
});

describe('review SEC-2: a malformed lender id never reaches the database', () => {
  it('answers a 36-character non-UUID like an unknown lender (401), not 500', async () => {
    await start();
    const unknown = observable(await post(randomUUID(), signed()));
    for (const id of [
      '0123456789abcdef0123456789abcdef0123',
      '------------------------------------',
    ]) {
      const res = await post(id, signed());
      expect(res.statusCode).toBe(401);
      expect(observable(res)).toEqual(unknown);
    }
  });

  it('answers the same 401 when the context lookup itself fails', async () => {
    app = await buildCallbackApp(
      loadConfig({ APP_ENV: 'test', RATE_LIMIT_MAX_PER_MINUTE: '100000' }),
      {
        routing: {
          hookContext: () => Promise.reject(Object.assign(new Error('boom'), { code: '08006' })),
          ingest: () => Promise.resolve({ outcome: 'applied' }),
        } as unknown as RoutingProcessor,
        secret: () => SECRET,
        environment: 'test',
      },
    );
    const res = await post(randomUUID(), signed());
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'invalid_signature' });
  });
});

describe('A29: a misrouted URL is not written to the log and not echoed', () => {
  const buildLogged = async (lines: string[], id: string) => {
    app = await buildCallbackApp(
      loadConfig({ APP_ENV: 'local', LOG_LEVEL: 'trace', RATE_LIMIT_MAX_PER_MINUTE: '100000' }),
      {
        routing,
        secret: () => SECRET,
        environment: 'test',
        logStream: { write: (line) => void lines.push(line) },
      },
    );
    lenders.set(id, context({}));
    return app;
  };

  it('answers one fixed 404 and logs no path (the usual dashboard mistakes: doubled slash, other case, missing segment)', async () => {
    const lines: string[] = [];
    const id = randomUUID();
    const instance = await buildLogged(lines, id);
    const misses = [
      { method: 'POST' as const, url: `//v1/hooks/lenders/${id}` },
      { method: 'POST' as const, url: `/V1/hooks/lenders/${id}` },
      { method: 'POST' as const, url: `/hooks/lenders/${id}?x=1` },
      { method: 'POST' as const, url: `/v1/hooks/lender/${id}` },
      { method: 'POST' as const, url: `/v1/hooks/lenders/${id}/` },
      { method: 'POST' as const, url: `/v1/hooks/lenders/${id}/extra` },
      { method: 'GET' as const, url: `/v1/hooks/lenders/${id}` },
    ];
    for (const miss of misses) {
      const res = await instance.inject({
        ...miss,
        headers: { 'content-type': 'application/json' },
        payload: miss.method === 'POST' ? '{}' : undefined,
      });
      expect([miss.url, res.statusCode]).toEqual([miss.url, 404]);
      expect(res.json()).toMatchObject({ status: 404, code: 'not_found', title: 'Not Found' });
      expect(res.body, miss.url).not.toContain(id);
      expect(res.body).not.toContain('not found:');
    }
    const log = lines.join('\n');
    expect(log).not.toContain(id);
    // The framework's "Route ... not found" line (which carries the path) is gone; what is left is a fixed warning without the URL.
    const entries = lines.map((line) => JSON.parse(line) as { level: string; msg?: string });
    expect(entries.filter((entry) => /not found/i.test(entry.msg ?? ''))).toEqual([]);
    expect(
      entries.filter((entry) => entry.msg === 'callback receiver: no such route'),
    ).toHaveLength(misses.length);
  });

  it('answers a malformed URL (a bad percent escape) with a fixed 400 that does not echo the path', async () => {
    const lines: string[] = [];
    const id = randomUUID();
    const instance = await buildLogged(lines, id);
    const res = await instance.inject({ method: 'POST', url: `/v1/hooks/lenders/${id}%zz` });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ status: 400, code: 'bad_request' });
    expect(res.body).not.toContain(id);
    expect(lines.join('\n')).not.toContain(id);
  });

  it('control: a refusal on the real route that logs the lender id does reach the capture, so the absence above means something', async () => {
    const lines: string[] = [];
    const id = randomUUID();
    const instance = await buildLogged(lines, id);
    lenders.set(id, context({ kind: 'api' }));
    const res = await instance.inject({
      method: 'POST',
      url: `/v1/hooks/lenders/${id}`,
      headers: { 'content-type': 'application/json', ...signed() },
      payload: body,
    });
    expect(res.statusCode).toBe(401);
    expect(lines.join('\n')).toContain(id);
    expect(lines.join('\n')).toContain('callback_scheme_not_configured');
  });
});
