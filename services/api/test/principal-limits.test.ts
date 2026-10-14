// R-02: per-principal rate limits, in addition to per-address limits that run before authentication.
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createPrincipalLimits } from '../src/auth/principal-limits.js';
import { TokenError, type TokenVerifier } from '../src/auth/token-verifier.js';
import { type UserContext } from '../src/db/user-context.js';
import { registerRoutes, userRoute } from '../src/http/routes.js';

const verifier: TokenVerifier = {
  verify(header) {
    const user = /^Bearer user-(\w+)$/.exec(header ?? '')?.[1];
    if (!user) return Promise.reject(new TokenError('invalid'));
    // Distinct, well-formed ids per test user.
    return Promise.resolve({
      sub: `00000000-0000-4000-8000-${user.padStart(12, '0')}`,
      aal: 'aal2' as const,
      sessionId: null,
    });
  },
};
const context: UserContext = {
  withUserContext: (_c, fn) =>
    fn({ query: () => Promise.resolve({ rows: [{ actor: 'platform', active: true }] } as never) }),
};

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function build(options: {
  ceiling: number;
  perAddress?: number;
  routeLimit?: { max: number; timeWindow: string };
}) {
  app = Fastify({ trustProxy: true });
  await app.register(rateLimit, { max: options.perAddress ?? 1000, timeWindow: '1 minute' });
  registerRoutes(
    app,
    [
      userRoute({
        method: 'get',
        path: '/v1/probe',
        operationId: 'probe',
        summary: 'probe',
        tags: ['Test'],
        auth: 'staff',
        ...(options.routeLimit ? { rateLimit: options.routeLimit } : {}),
        responses: { 200: z.object({ ok: z.literal(true) }) },
        handler: () => Promise.resolve({ status: 200, body: { ok: true as const } }),
      }),
    ],
    {
      auth: { verifier, context },
      principalLimits: createPrincipalLimits(app, options.ceiling),
    },
  );
  const get = (user: string, ip: string) =>
    app!.inject({
      method: 'GET',
      url: '/v1/probe',
      headers: { authorization: `Bearer user-${user}`, 'x-forwarded-for': ip },
    });
  return { get };
}

describe('per-principal rate limits', () => {
  it('limits one verified user across many addresses, without touching other users', async () => {
    const { get } = await build({ ceiling: 3 });
    const codes: number[] = [];
    for (let i = 1; i <= 5; i += 1) codes.push((await get('a', `203.0.113.${i}`)).statusCode);
    expect(codes).toEqual([200, 200, 200, 429, 429]); // five different addresses, one user
    expect((await get('b', '203.0.113.1')).statusCode).toBe(200); // another user on a used address is fine
  });

  it('answers 429 as problem+json with retry-after and no request data', async () => {
    const { get } = await build({ ceiling: 1 });
    await get('a', '203.0.113.1');
    const res = await get('a', '203.0.113.2');
    expect(res.statusCode).toBe(429);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toMatchObject({
      status: 429,
      code: 'rate_limited',
      title: 'Too Many Requests',
    });
    expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(1);
  });

  it("applies a route's own limit per principal as well (for example the step-up limit)", async () => {
    const { get } = await build({ ceiling: 100, routeLimit: { max: 2, timeWindow: '1 minute' } });
    const codes: number[] = [];
    for (let i = 1; i <= 3; i += 1) codes.push((await get('a', `198.51.100.${i}`)).statusCode);
    expect(codes).toEqual([200, 200, 429]);
    expect((await get('b', '198.51.100.9')).statusCode).toBe(200);
  });

  it('does not count requests that failed authentication against any principal', async () => {
    const { get } = await build({ ceiling: 1 });
    for (let i = 0; i < 3; i += 1) {
      const res = await app!.inject({ method: 'GET', url: '/v1/probe' });
      expect(res.statusCode).toBe(401);
    }
    expect((await get('a', '203.0.113.1')).statusCode).toBe(200);
  });

  it('keeps the per-address limit in force before authentication', async () => {
    const { get } = await build({ ceiling: 100, perAddress: 2 });
    const codes: number[] = [];
    for (let i = 0; i < 3; i += 1) codes.push((await get(`u${i}`, '203.0.113.50')).statusCode);
    expect(codes).toEqual([200, 200, 429]); // three users, one address
  });
});
