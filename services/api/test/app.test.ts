import { afterEach, describe, expect, it } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { buildApp, type ReadinessCheck } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const testConfig = loadConfig({ APP_ENV: 'test', RATE_LIMIT_MAX_PER_MINUTE: '3' });

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function start(readinessChecks: ReadinessCheck[] = []) {
  app = await buildApp(testConfig, { readinessChecks });
  return app;
}

describe('health endpoints', () => {
  it('reports liveness without touching dependencies', async () => {
    const failing: ReadinessCheck = {
      name: 'database',
      check: () => Promise.reject(new Error('down')),
    };
    const res = await (await start([failing])).inject({ method: 'GET', url: '/health/live' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('reports ready when every dependency answers', async () => {
    const ok: ReadinessCheck = { name: 'database', check: () => Promise.resolve() };
    const res = await (await start([ok])).inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ready', checks: { database: 'ok' } });
  });

  it('returns 503 without leaking the dependency error', async () => {
    const failing: ReadinessCheck = {
      name: 'database',
      check: () => Promise.reject(new Error('password authentication failed for user "x"')),
    };
    const res = await (await start([failing])).inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'not_ready', checks: { database: 'failing' } });
    expect(res.body).not.toContain('password');
  });

  it('times out a hanging dependency', async () => {
    const hanging: ReadinessCheck = { name: 'queue', check: () => new Promise<void>(() => {}) };
    const res = await (await start([hanging])).inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(503);
  }, 5_000);
});

describe('HTTP hygiene', () => {
  it('answers unknown routes with RFC 9457 problem details', async () => {
    const res = await (await start()).inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toMatchObject({ status: 404, code: 'not_found', title: 'Not Found' });
  });

  it('sets security headers and disables caching', async () => {
    const res = await (await start()).inject({ method: 'GET', url: '/health/live' });
    expect(res.headers['strict-transport-security']).toContain('max-age=31536000');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('echoes a well-formed request id and replaces a malformed one', async () => {
    const a = await start();
    const good = await a.inject({
      method: 'GET',
      url: '/health/live',
      headers: { 'x-request-id': 'abc-12345678' },
    });
    expect(good.headers['x-request-id']).toBe('abc-12345678');
    const bad = await a.inject({
      method: 'GET',
      url: '/health/live',
      headers: { 'x-request-id': '<script>' },
    });
    expect(bad.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('rate-limits with a problem response', async () => {
    const a = await start();
    a.get('/limited', () => ({ ok: true }));
    const statuses: number[] = [];
    let last;
    for (let i = 0; i < 4; i += 1) {
      last = await a.inject({ method: 'GET', url: '/limited' });
      statuses.push(last.statusCode);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
    expect(last?.json()).toMatchObject({ status: 429, code: 'rate_limited' });
  });

  it('hides internal error details from clients', async () => {
    const a = await start();
    a.get('/boom', () => {
      throw new Error('relation "secret_table" does not exist');
    });
    const res = await a.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ status: 500, code: 'internal_error' });
    expect(res.body).not.toContain('secret_table');
  });
});
