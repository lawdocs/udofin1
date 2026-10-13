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
}

const MESSAGE_ID = /^[A-Za-z0-9._:-]{8,100}$/;

function problem(
  reply: FastifyReply,
  status: number,
  code: string,
  requestId: string,
): FastifyReply {
  return reply
    .code(status)
    .type(PROBLEM_CONTENT_TYPE)
    .send({
      type: 'about:blank',
      title: status >= 500 ? 'Service Unavailable' : 'Error',
      status,
      code,
      instance: requestId,
    });
}

export async function buildCallbackApp(
  config: AppConfig,
  deps: CallbackDeps,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: config.APP_ENV === 'test' ? false : loggerOptions(config),
    bodyLimit: 262_144,
    requestTimeout: 15_000,
    trustProxy: (_a: string, hop: number) => hop < config.TRUST_PROXY_HOPS,
    genReqId: () => randomUUID(),
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

  app.get('/health/live', () => ({ status: 'ok' }));

  app.post('/v1/hooks/lenders/:lenderId', async (request, reply) => {
    const lenderId = (request.params as { lenderId?: string }).lenderId ?? '';
    if (!/^[0-9a-f-]{36}$/i.test(lenderId)) return problem(reply, 404, 'not_found', request.id);
    const h = request.headers;
    const messageId = typeof h['webhook-id'] === 'string' ? h['webhook-id'] : '';
    if (!MESSAGE_ID.test(messageId)) return problem(reply, 400, 'bad_request', request.id);

    const context = await deps.routing.hookContext(lenderId);
    // Unknown, inactive and manual lenders look the same from outside.
    if (!context || context.status !== 'active' || context.kind === 'manual')
      return problem(reply, 404, 'not_found', request.id);

    if (context.kind === 'api')
      return problem(reply, 503, 'callback_scheme_not_configured', request.id);
    if (deps.environment === 'staging' || deps.environment === 'production')
      return problem(reply, 503, 'mock_connector_blocked', request.id);
    const secret = context.signingSecretRef ? deps.secret(context.signingSecretRef) : undefined;
    if (!secret) return problem(reply, 503, 'callback_secret_not_configured', request.id);

    const raw = (request as { rawBody?: string }).rawBody ?? '';
    const ok = verifyMockCallback({
      secret,
      id: messageId,
      timestamp: typeof h['webhook-timestamp'] === 'string' ? h['webhook-timestamp'] : undefined,
      signatureHeader:
        typeof h['webhook-signature'] === 'string' ? h['webhook-signature'] : undefined,
      body: raw,
    });
    if (!ok) return problem(reply, 401, 'invalid_signature', request.id);

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
