import { randomUUID } from 'node:crypto';
import { type AppEnvironment, verifyMockCallback } from '@udofin/adapters';
import { LenderEventInput, PROBLEM_CONTENT_TYPE } from '@udofin/contracts';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { loggerOptions } from '../logger.js';
import { type AppConfig } from '../config.js';
import { type RoutingProcessor } from '../system/routing.js';

/**
 * The receiver for signed events from lenders' systems. It is a SEPARATE small service so the public API never holds the
 * system database login: this process alone may call the two ingestion functions. It verifies the signature over the
 * exact bytes received, then lets the database apply the event once (message-id de-duplication, lender and application
 * matching, lifecycle rules). Nothing the lender sends is trusted before that.
 *
 * Signature schemes: only the labelled MOCK test scheme exists. A real lender's scheme is added with that lender's
 * specification; until then an `api` connector's callbacks are refused with 503 rather than accepted unauthenticated.
 */
export interface CallbackDeps {
  routing: RoutingProcessor;
  /** Resolves the NAME of a secret to its value (environment variables or a secrets manager). Never logged. */
  secret(name: string): string | undefined;
  environment: AppEnvironment;
  /** Tests only: where the log lines go (otherwise the logger is off in the test environment). */
  logStream?: { write(line: string): void };
}

const MESSAGE_ID = /^[A-Za-z0-9._:-]{8,100}$/;
/** A real UUID (not just 36 hex-and-dash characters), so a malformed id never reaches a `::uuid` cast in the database. */
const LENDER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Never a real secret: used only to spend the same effort on lenders that do not exist as on ones that do. */
const DECOY_SECRET = 'v1,whsec_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

function problemBody(status: number, code: string, requestId: string) {
  return {
    type: 'about:blank',
    title:
      status === 401
        ? 'Unauthorized'
        : status === 404
          ? 'Not Found'
          : status >= 500
            ? 'Service Unavailable'
            : 'Error',
    status,
    code,
    instance: requestId,
  };
}

function problem(
  reply: FastifyReply,
  status: number,
  code: string,
  requestId: string,
): FastifyReply {
  return reply
    .code(status)
    .type(PROBLEM_CONTENT_TYPE)
    .send(problemBody(status, code, requestId));
}

export async function buildCallbackApp(
  config: AppConfig,
  deps: CallbackDeps,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: deps.logStream
      ? { ...loggerOptions(config), stream: deps.logStream }
      : config.APP_ENV === 'test'
        ? false
        : loggerOptions(config),
    bodyLimit: 262_144,
    requestTimeout: 15_000,
    trustProxy: (_a: string, hop: number) => hop < config.TRUST_PROXY_HOPS,
    genReqId: () => randomUUID(),
    // A malformed URL (a bad percent escape) and the other errors Fastify raises before a route is chosen get a fixed answer. The
    // default would echo the raw path, which on this receiver can be a lender's routing id.
    frameworkErrors: (_error, request, reply) => {
      void (reply as unknown as FastifyReply)
        .code(400)
        .type(PROBLEM_CONTENT_TYPE)
        .send(problemBody(400, 'bad_request', request.id));
    },
  });
  const parseJson = app.getDefaultJsonParser('error', 'error');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    (request as { rawBody?: string }).rawBody = body as string;
    void parseJson(request, body as string, (error: Error | null, parsed?: unknown) => {
      if (error) done(Object.assign(new Error('invalid_json'), { statusCode: 400 }), undefined);
      else done(null, parsed);
    });
  });
  app.addHook('onSend', (_request, reply, payload, done) => {
    reply.header('cache-control', 'no-store');
    done(null, payload);
  });
  await app.register(rateLimit, { global: true, max: 600, timeWindow: '1 minute' });
  app.setErrorHandler((error, request, reply) => {
    const status = (error as { statusCode?: number }).statusCode;
    return problem(
      reply,
      status && status >= 400 && status < 500 ? status : 500,
      status && status < 500 ? 'bad_request' : 'internal_error',
      request.id,
    );
  });

  // A request that matches no route (a doubled slash, another letter case, a missing segment: the usual ways a dashboard gets the
  // URL wrong) answers one fixed 404. Without this handler Fastify writes "Route POST:<path> not found" at info level and echoes
  // it in the response, and the path of this receiver's route carries the lender's routing id. The warning left here has a fixed
  // reason and no URL, so an operator still learns that something is calling a wrong address.
  app.setNotFoundHandler((request, reply) => {
    request.log.warn({ reason: 'route_not_found' }, 'callback receiver: no such route');
    return problem(reply, 404, 'not_found', request.id);
  });

  app.get('/health/live', () => ({ status: 'ok' }));

  app.post('/v1/hooks/lenders/:lenderId', async (request, reply) => {
    // EVERY outcome before the signature is verified looks the same from outside: 401 `invalid_signature`.
    // Unknown, inactive, manual and api-kind lenders, malformed ids, missing headers and our own
    // configuration gaps are indistinguishable, so lender ids cannot be enumerated (audit F-03). The real
    // reason goes to the server log only (ids are validated uuids; never headers, bodies or secrets).
    const refuse = (reason: string, level: 'info' | 'warn' = 'info', lender?: string) => {
      request.log[level](
        { reason, ...(lender ? { lenderId: lender } : {}) },
        'lender callback refused',
      );
      return problem(reply, 401, 'invalid_signature', request.id);
    };
    const lenderId = (request.params as { lenderId?: string }).lenderId ?? '';
    if (!LENDER_ID.test(lenderId)) return refuse('malformed_lender_id');
    const h = request.headers;
    const messageId = typeof h['webhook-id'] === 'string' ? h['webhook-id'] : '';
    if (!MESSAGE_ID.test(messageId)) return refuse('missing_or_malformed_message_id');
    const headerOf = (name: string): string | undefined =>
      typeof h[name] === 'string' ? h[name] : undefined;

    let context: Awaited<ReturnType<typeof deps.routing.hookContext>>;
    try {
      context = await deps.routing.hookContext(lenderId);
    } catch (error) {
      // A database problem must not turn into a different answer for an unauthenticated caller.
      return refuse(
        `context_lookup_failed:${(error as { code?: string }).code ?? 'error'}`,
        'warn',
      );
    }
    if (!context || context.status !== 'active' || context.kind === 'manual') {
      // Do the same signature work a real lender would cost, so response time does not reveal the difference.
      verifyMockCallback({
        secret: DECOY_SECRET,
        id: messageId,
        timestamp: headerOf('webhook-timestamp'),
        signatureHeader: headerOf('webhook-signature'),
        body: (request as { rawBody?: string }).rawBody ?? '',
      });
      return refuse('lender_unknown_inactive_or_manual');
    }
    if (context.kind === 'api') return refuse('callback_scheme_not_configured', 'warn', lenderId);
    if (deps.environment === 'staging' || deps.environment === 'production')
      return refuse('mock_connector_blocked', 'warn', lenderId);
    const secret = context.signingSecretRef ? deps.secret(context.signingSecretRef) : undefined;
    if (!secret) return refuse('callback_secret_not_configured', 'warn', lenderId);

    const raw = (request as { rawBody?: string }).rawBody ?? '';
    const ok = verifyMockCallback({
      secret,
      id: messageId,
      timestamp: headerOf('webhook-timestamp'),
      signatureHeader: headerOf('webhook-signature'),
      body: raw,
    });
    if (!ok) return refuse('signature_invalid');

    const parsed = LenderEventInput.safeParse(request.body);
    if (!parsed.success) return problem(reply, 422, 'validation_failed', request.id);
    const result = await deps.routing.ingest({
      lenderId,
      messageId,
      type: parsed.data.type,
      correlationRef: parsed.data.correlationRef,
      body: parsed.data.body,
    });
    return reply.code(200).send(result);
  });

  return app;
}
