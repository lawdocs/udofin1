import { randomUUID } from 'node:crypto';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { PROBLEM_CONTENT_TYPE, type ProblemDetails } from '@udofin/contracts';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { type AppConfig } from './config.js';
import { loggerOptions } from './logger.js';

/** A dependency the API needs before it can serve traffic (database, queue, ...). */
export interface ReadinessCheck {
  name: string;
  check(signal: AbortSignal): Promise<void>;
}

export interface AppDependencies {
  readinessChecks?: readonly ReadinessCheck[];
}

const READINESS_TIMEOUT_MS = 2_000;
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
    // Do not let Fastify trust the raw header: genReqId validates it first (prevents log injection).
    requestIdHeader: false,
    // Accept a caller-supplied request id only if it is well-formed; otherwise mint one.
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && REQUEST_ID.test(incoming) ? incoming : randomUUID();
    },
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

  /** Liveness: the process is up. Never touches dependencies, so restarts are not triggered by them. */
  app.get('/health/live', { config: { rateLimit: false } }, () => ({ status: 'ok' }));

  /** Readiness: every dependency answers within the timeout. Reports names only, never errors. */
  app.get('/health/ready', { config: { rateLimit: false } }, async (_request, reply) => {
    const checks = deps.readinessChecks ?? [];
    const results = await Promise.all(
      checks.map(async (dependency) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), READINESS_TIMEOUT_MS);
        try {
          await Promise.race([
            dependency.check(controller.signal),
            new Promise<never>((_, reject) => {
              controller.signal.addEventListener('abort', () => reject(new Error('timeout')));
            }),
          ]);
          return { name: dependency.name, ok: true };
        } catch (error) {
          app.log.warn({ dependency: dependency.name, err: error }, 'readiness check failed');
          return { name: dependency.name, ok: false };
        } finally {
          clearTimeout(timer);
        }
      }),
    );
    const ready = results.every((result) => result.ok);
    return reply.code(ready ? 200 : 503).send({
      status: ready ? 'ready' : 'not_ready',
      checks: Object.fromEntries(
        results.map((result) => [result.name, result.ok ? 'ok' : 'failing']),
      ),
    });
  });

  return app;
}
