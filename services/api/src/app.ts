import { randomUUID } from 'node:crypto';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { type DocumentStore } from '@udofin/adapters';
import { type BorrowerDeps } from './modules/borrower/deps.js';
import { PROBLEM_CONTENT_TYPE, type ProblemDetails } from '@udofin/contracts';
import { z } from 'zod';
import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply } from 'fastify';
import { type AuthDeps } from './auth/deps.js';
import { type AppConfig } from './config.js';
import { loggerOptions } from './logger.js';
import { authenticatedRoutes } from './http/api-routes.js';
import { buildOpenApi } from './http/openapi.js';
import { publicRoute, registerRoutes } from './http/routes.js';
import { healthRoutes } from './modules/health/routes.js';

/** A dependency the API needs before it can serve traffic (database, queue, ...). */
export interface ReadinessCheck {
  name: string;
  check(signal: AbortSignal): Promise<void>;
}

export interface AppDependencies {
  readinessChecks?: readonly ReadinessCheck[];
  /** Token verification and the per-request database context. Routes under /v1 exist only when set. */
  auth?: AuthDeps;
  /** Private store for lender evidence documents. Document routes answer 503 when it is absent. */
  documents?: DocumentStore;
  /** SMS and device-integrity adapters, and the secrets that guard them. */
  borrower?: BorrowerDeps;
}

export const API_VERSION = '0.5.0';

declare module 'fastify' {
  interface FastifyInstance {
    /** Every route Fastify registered (method and url), for the contract test. */
    registeredRoutes: { method: string; url: string }[];
  }
}

const REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;

function problem(
  status: number,
  title: string,
  code: string,
  instance: string,
  detail?: string,
): ProblemDetails {
  return { type: 'about:blank', title, status, code, instance, ...(detail ? { detail } : {}) };
}

export async function buildApp(
  config: AppConfig,
  deps: AppDependencies = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: config.APP_ENV === 'test' ? false : loggerOptions(config),
    // Trust only the configured number of proxy hops when resolving the client IP.
    trustProxy: (_address: string, hop: number) => hop < config.TRUST_PROXY_HOPS,
    bodyLimit: 1_048_576,
    // Bound how long a client can hold a connection or trickle a body (slow-request attacks).
    requestTimeout: 30_000,
    connectionTimeout: 30_000,
    keepAliveTimeout: 10_000,
    // Malformed URLs and other framework-level errors get the same safe problem response,
    // never an echo of the raw (possibly sensitive) URL.
    frameworkErrors: (_error, request, reply) => {
      void (reply as unknown as FastifyReply)
        .code(400)
        .type(PROBLEM_CONTENT_TYPE)
        .send(problem(400, 'Bad Request', 'bad_request', request.id));
    },
    // Do not let Fastify trust the raw header: genReqId validates it first (prevents log injection).
    requestIdHeader: false,
    // Accept a caller-supplied request id only if it is well-formed; otherwise mint one.
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && REQUEST_ID.test(incoming) ? incoming : randomUUID();
    },
  });

  // Keep the exact bytes of JSON bodies: signed webhooks (the Supabase auth hook) are verified over them.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    try {
      (request as { rawBody?: string }).rawBody = body as string;
      done(null, body === '' ? undefined : (JSON.parse(body as string) as unknown));
    } catch (error) {
      Object.assign(error as Error, { statusCode: 400 });
      done(error as Error, undefined);
    }
  });

  const registered: { method: string; url: string }[] = [];
  app.addHook('onRoute', (route) => {
    for (const method of Array.isArray(route.method) ? route.method : [route.method]) {
      if (method !== 'HEAD' && method !== 'OPTIONS') registered.push({ method, url: route.url });
    }
  });

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
    reply.header('cache-control', 'no-store');
  });

  await app.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    crossOriginResourcePolicy: { policy: 'same-site' },
    hsts: { maxAge: 31_536_000, includeSubDomains: true, preload: false },
  });
  await app.register(cors, {
    origin: config.CORS_ALLOWED_ORIGINS.length > 0 ? config.CORS_ALLOWED_ORIGINS : false,
    credentials: false,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  });
  await app.register(rateLimit, {
    max: config.RATE_LIMIT_MAX_PER_MINUTE,
    timeWindow: '1 minute',
    // The returned error is thrown and rendered by the error handler below.
    errorResponseBuilder: (_request, context) =>
      Object.assign(new Error(`Rate limit exceeded, retry after ${context.after}`), {
        statusCode: 429,
        code: 'RATE_LIMITED',
        name: 'Too Many Requests',
      }),
  });

  app.setNotFoundHandler((request, reply) => {
    void reply
      .code(404)
      .type(PROBLEM_CONTENT_TYPE)
      .send(problem(404, 'Not Found', 'not_found', request.id));
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status =
      error.statusCode && error.statusCode >= 400 && error.statusCode < 600
        ? error.statusCode
        : 500;
    if (status >= 500) {
      request.log.error({ err: error }, 'unhandled error');
    }
    // Client errors keep Fastify's safe message; server errors never leak internals.
    const body =
      status >= 500
        ? problem(status, 'Internal Server Error', 'internal_error', request.id)
        : problem(
            status,
            error.name || 'Bad Request',
            error.code?.toLowerCase() ?? 'bad_request',
            request.id,
            error.message,
          );
    void reply.code(status).type(PROBLEM_CONTENT_TYPE).send(body);
  });

  const routes = [
    ...healthRoutes(deps.readinessChecks ?? [], (name, error) => {
      app.log.warn({ dependency: name, err: error }, 'readiness check failed');
    }),
    ...authenticatedRoutes({
      ...(deps.documents ? { documents: deps.documents } : {}),
      ...(deps.borrower ? { borrower: deps.borrower } : {}),
    }),
  ];
  if (config.APP_ENV !== 'production') {
    routes.push(
      publicRoute({
        method: 'get',
        path: '/v1/openapi.json',
        operationId: 'getOpenApiDocument',
        summary: 'OpenAPI 3.1 description of this API (not served in production)',
        tags: ['Operations'],
        auth: 'none',
        responses: { 200: z.record(z.string(), z.unknown()) },
        handler: () =>
          Promise.resolve({
            status: 200,
            body: buildOpenApi(
              routes.filter((r) => r.path !== '/v1/openapi.json'),
              API_VERSION,
            ),
          }),
      }),
    );
  }
  registerRoutes(app, routes, deps.auth ? { auth: deps.auth } : {});
  app.decorate('registeredRoutes', registered);

  return app;
}
