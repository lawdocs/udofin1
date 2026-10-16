// F-04: 4xx answers use fixed wording per status; the framework's message (which can echo parts of the
// request) is never sent.
import { afterEach, describe, expect, it } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const FRAGMENT = 'SECRET-FRAGMENT-9876500000';
const hook = (headers: Record<string, string>, payload: string | Buffer) =>
  app!.inject({ method: 'POST', url: '/v1/hooks/send-sms', headers, payload });

describe('client error wording', () => {
  it('does not echo an unsupported media type', async () => {
    app = await buildApp(loadConfig({ APP_ENV: 'test' }));
    const res = await hook({ 'content-type': `text/${FRAGMENT}` }, 'x');
    expect(res.statusCode).toBe(415);
    expect(res.body).not.toContain(FRAGMENT);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toEqual({
      type: 'about:blank',
      title: 'Unsupported Media Type',
      status: 415,
      code: 'fst_err_ctp_invalid_media_type',
      instance: res.headers['x-request-id'],
      detail: 'The content type is not supported.',
    });
  });

  it('does not echo a malformed JSON body', async () => {
    app = await buildApp(loadConfig({ APP_ENV: 'test' }));
    const res = await hook({ 'content-type': 'application/json' }, `{"phone":"${FRAGMENT}"`);
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain(FRAGMENT);
    expect(res.json()).toMatchObject({
      title: 'Bad Request',
      code: 'bad_request',
      detail: 'The request could not be understood.',
    });
  });

  it('does not echo anything for an oversized body', async () => {
    app = await buildApp(loadConfig({ APP_ENV: 'test' }));
    const res = await hook(
      { 'content-type': 'application/json' },
      Buffer.from(`{"a":"${FRAGMENT}${'x'.repeat(1_100_000)}"}`),
    );
    expect(res.statusCode).toBe(413);
    expect(res.body).not.toContain(FRAGMENT);
    expect(res.json()).toMatchObject({ title: 'Content Too Large', status: 413 });
  });

  it('uses the same fixed text for the rate limit (no timing text from the limiter)', async () => {
    app = await buildApp(loadConfig({ APP_ENV: 'test', RATE_LIMIT_MAX_PER_MINUTE: '1' }));
    app.get('/limited', () => ({ ok: true }));
    await app.inject({ method: 'GET', url: '/limited' });
    const res = await app.inject({ method: 'GET', url: '/limited' });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({
      title: 'Too Many Requests',
      code: 'rate_limited',
      detail: 'Too many requests. Try again later.',
    });
    expect(res.body).not.toMatch(/retry after/i);
  });

  it('keeps 5xx details out as before', async () => {
    app = await buildApp(loadConfig({ APP_ENV: 'test' }));
    app.get('/boom', () => {
      throw new Error(`relation "${FRAGMENT}" does not exist`);
    });
    const res = await app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain(FRAGMENT);
  });
});
