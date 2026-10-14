// F-01: the access token's session must still exist. Unit level with a fake database context; the same
// behaviour against a real auth.sessions row is in test/integration/session.integration.test.ts.
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { type AuthDeps } from '../src/auth/deps.js';
import { TokenError, type TokenVerifier, type VerifiedClaims } from '../src/auth/token-verifier.js';
import { type UserContext, type UserTx } from '../src/db/user-context.js';
import { registerRoutes, userRoute } from '../src/http/routes.js';
import { z } from 'zod';

const USER = '0f0f0f0f-0000-4000-8000-000000000001';
const SESSION = '5e5e5e5e-0000-4000-8000-000000000001';

function harness(options: {
  claims: Partial<VerifiedClaims>;
  sessionActive: boolean;
  actor?: string;
  requireSessionId?: boolean;
  verifierFails?: boolean;
}) {
  const queries: { text: string; values: readonly unknown[] | undefined }[] = [];
  const verifier: TokenVerifier = {
    verify: () =>
      options.verifierFails
        ? Promise.reject(new TokenError('invalid'))
        : Promise.resolve({ sub: USER, aal: 'aal2', sessionId: null, ...options.claims }),
  };
  const context: UserContext = {
    withUserContext: (_claims, fn) => {
      const tx: UserTx = {
        query: (text, values) => {
          queries.push({ text, values });
          return Promise.resolve({
            rows: [{ actor: options.actor ?? 'platform', active: options.sessionActive }],
          } as never);
        },
      };
      return fn(tx);
    },
  };
  const auth: AuthDeps = {
    verifier,
    context,
    ...(options.requireSessionId === undefined
      ? {}
      : { requireSessionId: options.requireSessionId }),
  };
  return { auth, queries };
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function call(auth: AuthDeps, requirement: 'user' | 'staff' | 'borrower' = 'staff') {
  app = Fastify();
  let handlerRuns = 0;
  registerRoutes(
    app,
    [
      userRoute({
        method: 'get',
        path: '/v1/probe',
        operationId: 'probe',
        summary: 'probe',
        tags: ['Test'],
        auth: requirement,
        responses: { 200: z.object({ ok: z.literal(true) }) },
        handler: () => {
          handlerRuns += 1;
          return Promise.resolve({ status: 200, body: { ok: true as const } });
        },
      }),
    ],
    { auth },
  );
  const res = await app.inject({ method: 'GET', url: '/v1/probe' });
  return { res, handlerRuns: () => handlerRuns };
}

describe('session check on every authenticated request (F-01)', () => {
  it('lets an active session through, with exactly one database round trip before the handler', async () => {
    const h = harness({ claims: { sessionId: SESSION }, sessionActive: true });
    const { res, handlerRuns } = await call(h.auth);
    expect(res.statusCode).toBe(200);
    expect(handlerRuns()).toBe(1);
    expect(h.queries).toHaveLength(1);
    expect(h.queries[0]?.text).toContain('private.session_is_active($1::uuid)');
    expect(h.queries[0]?.values).toEqual([SESSION]);
  });

  it('refuses a signed-out or revoked session with 401 session_revoked and never runs the handler', async () => {
    const h = harness({ claims: { sessionId: SESSION }, sessionActive: false });
    const { res, handlerRuns } = await call(h.auth);
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toMatchObject({ status: 401, code: 'session_revoked' });
    expect(res.headers['www-authenticate']).toContain('invalid_token');
    expect(handlerRuns()).toBe(0);
  });

  it.each(['user', 'staff', 'borrower'] as const)(
    'applies to %s routes alike because the check lives in runAsUser (step-up routes are borrower routes)',
    async (requirement) => {
      const h = harness({
        claims: { sessionId: SESSION },
        sessionActive: false,
        actor: requirement === 'borrower' ? 'borrower' : 'platform',
      });
      const { res, handlerRuns } = await call(h.auth, requirement);
      expect(res.json()).toMatchObject({ code: 'session_revoked' });
      expect(handlerRuns()).toBe(0);
    },
  );

  it('refuses a token without a session id when the environment requires one', async () => {
    const h = harness({ claims: { sessionId: null }, sessionActive: true, requireSessionId: true });
    const { res, handlerRuns } = await call(h.auth);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'token_invalid' });
    expect(handlerRuns()).toBe(0);
    expect(h.queries).toHaveLength(0); // refused before any database work
  });

  it('accepts a token without a session id when not required (local and test fake verifiers)', async () => {
    const h = harness({
      claims: { sessionId: null },
      sessionActive: false,
      requireSessionId: false,
    });
    const { res } = await call(h.auth);
    expect(res.statusCode).toBe(200);
  });

  it('still reports an invalid token before looking at sessions', async () => {
    const h = harness({ claims: {}, sessionActive: true, verifierFails: true });
    const { res } = await call(h.auth);
    expect(res.json()).toMatchObject({ code: 'token_invalid' });
    expect(h.queries).toHaveLength(0);
  });
});
