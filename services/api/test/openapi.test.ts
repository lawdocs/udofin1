import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { API_VERSION, buildApp } from '../src/app.js';
import { authenticatedRoutes } from '../src/http/api-routes.js';
import { buildOpenApi } from '../src/http/openapi.js';
import { loadConfig } from '../src/config.js';
import { healthRoutes } from '../src/modules/health/routes.js';
import { TokenError } from '../src/auth/token-verifier.js';

const routes = [...healthRoutes([], () => undefined), ...authenticatedRoutes()];
const doc = buildOpenApi(routes, API_VERSION) as {
  openapi: string;
  paths: Record<
    string,
    Record<
      string,
      {
        responses: Record<string, unknown>;
        parameters?: { name: string; in: string }[];
        security: unknown[];
        requestBody?: unknown;
      }
    >
  >;
};

describe('OpenAPI contract', () => {
  it('is OpenAPI 3.1 and lists exactly the declared routes', () => {
    expect(doc.openapi).toBe('3.1.0');
    const listed = Object.entries(doc.paths).flatMap(([path, ops]) =>
      Object.keys(ops).map((m) => `${m.toUpperCase()} ${path}`),
    );
    const declared = routes.map(
      (r) => `${r.method.toUpperCase()} ${r.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}')}`,
    );
    expect(listed.sort()).toEqual(declared.sort());
  });

  it('every route declares a success schema and a problem response, and authenticated ones require a bearer token', () => {
    for (const [path, ops] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(ops)) {
        const statuses = Object.keys(op.responses);
        expect(
          statuses.some((s) => s.startsWith('2') || s === '503'),
          `${method} ${path} success`,
        ).toBe(true);
        expect(statuses, `${method} ${path} 500`).toContain('500');
        if (!path.startsWith('/health') && path !== '/v1/hooks/send-sms')
          expect(op.security, `${method} ${path} security`).toEqual([{ bearerAuth: [] }]);
      }
    }
  });

  it('every idempotent POST documents the required Idempotency-Key header', () => {
    for (const route of routes) {
      if (route.auth === 'none' || !route.idempotent) continue;
      const op = doc.paths[route.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}')]?.[route.method];
      expect(op?.parameters?.some((p) => p.name === 'Idempotency-Key' && p.in === 'header')).toBe(
        true,
      );
    }
  });

  it('every state-changing authenticated route is idempotent', () => {
    for (const route of routes) {
      if (route.method === 'post' && route.auth !== 'none')
        expect(route.idempotent, route.operationId).toBe(true);
    }
  });

  it('operation ids are unique', () => {
    const ids = routes.map((r) => r.operationId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('the committed docs/api/openapi.json is current (run `pnpm --filter @udofin/api openapi`)', () => {
    const committed = readFileSync(
      join(import.meta.dirname, '..', '..', '..', 'docs', 'api', 'openapi.json'),
      'utf8',
    );
    expect(committed).toBe(`${JSON.stringify(doc, null, 2)}\n`);
  });

  it('the running app registers exactly the declared routes (nothing undocumented)', async () => {
    const app = await buildApp(loadConfig({ APP_ENV: 'test' }), {
      auth: {
        verifier: { verify: () => Promise.reject(new TokenError('invalid')) },
        context: { withUserContext: () => Promise.reject(new Error('unused')) },
      },
    });
    const registered = app.registeredRoutes
      .map((r) => `${r.method} ${r.url}`)
      .filter((r) => !r.endsWith('/v1/openapi.json'));
    const declared = routes.map((r) => `${r.method.toUpperCase()} ${r.path}`);
    expect(registered.sort()).toEqual(declared.sort());
    await app.close();
  });

  it('is not served in production', async () => {
    const app = await buildApp({ ...loadConfig({ APP_ENV: 'test' }), APP_ENV: 'production' });
    expect((await app.inject({ method: 'GET', url: '/v1/openapi.json' })).statusCode).toBe(404);
    await app.close();
  });
});
