import { PROBLEM_CONTENT_TYPE } from '@udofin/contracts';
import { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { type z, type ZodType } from 'zod';
import { type AuthDeps } from '../auth/deps.js';
import { type PrincipalLimits } from '../auth/principal-limits.js';
import { runAsUser, type Authenticated, type AuthRequirement } from '../auth/request-auth.js';
import { type UserTx } from '../db/user-context.js';
import {
  beginIdempotent,
  completeIdempotent,
  parseIdempotencyKey,
  requestFingerprint,
} from '../idempotency/idempotency.js';
import { ApiError, mapDatabaseError } from './api-error.js';

/**
 * Every HTTP route is declared here with its request and response schemas. The same declaration
 * (1) validates requests, (2) validates responses, (3) enforces authentication, MFA and
 * idempotency, and (4) generates the OpenAPI document, so the documentation cannot describe
 * something the code does not do. A test fails if a Fastify route exists that is not declared.
 */

export interface HandlerResult {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

interface CommonSpec<P extends ZodType, Q extends ZodType, B extends ZodType> {
  method: 'get' | 'post';
  path: string;
  operationId: string;
  summary: string;
  description?: string;
  tags: string[];
  params?: P;
  query?: Q;
  body?: B;
  /** Success responses by status. Errors are documented through `errors`. */
  responses: Record<number, ZodType>;
  /** Problem statuses this route can return, beyond the ones every route can. */
  errors?: number[];
  rateLimit?: { max: number; timeWindow: string } | false;
  /** Overrides the global request body limit (bytes) for routes that carry documents. */
  bodyLimit?: number;
}

export interface PublicRouteSpec<
  P extends ZodType,
  Q extends ZodType,
  B extends ZodType,
> extends CommonSpec<P, Q, B> {
  auth: 'none';
  /**
   * Runs BEFORE any request schema is applied. A signed webhook verifies its signature over the raw
   * bytes here, so an unsigned caller learns nothing from validation messages and triggers no database
   * work. Throw an ApiError to refuse.
   */
  verifyRequest?(request: FastifyRequest): void | Promise<void>;
  handler(ctx: {
    request: FastifyRequest;
    params: z.output<P>;
    query: z.output<Q>;
    body: z.output<B>;
  }): Promise<HandlerResult>;
}

export interface UserRouteSpec<
  P extends ZodType,
  Q extends ZodType,
  B extends ZodType,
> extends CommonSpec<P, Q, B> {
  auth: AuthRequirement;
  /** Requires an Idempotency-Key header; the result is stored and replayed (see docs/api/idempotency.md). */
  idempotent?: boolean;
  /** Optional tenant recorded with the idempotency record. */
  idempotencyTenant?: (input: { params: z.output<P>; body: z.output<B> }) => string | null;
  handler(ctx: {
    request: FastifyRequest;
    tx: UserTx;
    auth: Authenticated;
    /** The validated Idempotency-Key of an idempotent route. */
    idempotencyKey: string | undefined;
    params: z.output<P>;
    query: z.output<Q>;
    body: z.output<B>;
  }): Promise<HandlerResult>;
}

export type RouteDefinition =
  PublicRouteSpec<ZodType, ZodType, ZodType> | UserRouteSpec<ZodType, ZodType, ZodType>;

type NoSchema = z.ZodUndefined;

export function publicRoute<
  P extends ZodType = NoSchema,
  Q extends ZodType = NoSchema,
  B extends ZodType = NoSchema,
>(spec: PublicRouteSpec<P, Q, B>): RouteDefinition {
  return spec;
}

export function userRoute<
  P extends ZodType = NoSchema,
  Q extends ZodType = NoSchema,
  B extends ZodType = NoSchema,
>(spec: UserRouteSpec<P, Q, B>): RouteDefinition {
  return spec;
}

function problemBody(request: FastifyRequest, error: ApiError) {
  return {
    type: 'about:blank',
    title: error.title,
    status: error.status,
    code: error.code,
    instance: request.id,
    ...(error.detail ? { detail: error.detail } : {}),
  };
}

function sendError(reply: FastifyReply, request: FastifyRequest, error: ApiError): FastifyReply {
  for (const [name, value] of Object.entries(error.headers ?? {})) reply.header(name, value);
  return reply.code(error.status).type(PROBLEM_CONTENT_TYPE).send(problemBody(request, error));
}

/** Validation errors name the failing fields and rule codes, never the submitted values. */
function validationError(where: string, error: z.ZodError): ApiError {
  const fields = error.issues.map((issue) => `${issue.path.join('.') || where}: ${issue.code}`);
  return new ApiError(
    422,
    'validation_failed',
    'Unprocessable Content',
    fields.slice(0, 10).join('; '),
  );
}

function parseInput(schema: ZodType | undefined, value: unknown, where: string): unknown {
  if (!schema) return undefined;
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw validationError(where, parsed.error);
  return parsed.data;
}

function checkResponse(spec: RouteDefinition, result: HandlerResult): void {
  const schema = spec.responses[result.status];
  if (!schema) {
    throw new Error(
      `route ${spec.operationId} returned undeclared status ${String(result.status)}`,
    );
  }
  const parsed = schema.safeParse(result.body);
  if (!parsed.success) {
    throw new Error(`route ${spec.operationId} response does not match its declared schema`);
  }
}

export function registerRoutes(
  app: FastifyInstance,
  routes: readonly RouteDefinition[],
  deps: { auth?: AuthDeps; principalLimits?: PrincipalLimits },
): void {
  for (const route of routes) {
    if (route.auth !== 'none' && !deps.auth) continue; // authenticated routes exist only when auth is configured
    const config = route.rateLimit === undefined ? {} : { rateLimit: route.rateLimit };
    app.route({
      method: route.method.toUpperCase(),
      url: route.path,
      config: config as never,
      ...(route.bodyLimit ? { bodyLimit: route.bodyLimit } : {}),
      handler: async (request, reply) => {
        try {
          if (route.auth === 'none') await route.verifyRequest?.(request);
          const params = parseInput(route.params, request.params, 'path');
          const query = parseInput(route.query, request.query, 'query');
          const body = parseInput(route.body, request.body, 'body');
          let result: HandlerResult;

          if (route.auth === 'none') {
            result = await route.handler({ request, params, query, body });
          } else {
            const idempotencyKey = route.idempotent
              ? parseIdempotencyKey(request.headers['idempotency-key'])
              : undefined;
            const routeId = `${route.method.toUpperCase()} ${route.path}`;
            // `deps.auth` is defined: authenticated routes are skipped above otherwise.
            result = await runAsUser(
              deps.auth as AuthDeps,
              request,
              route.auth,
              async (tx, auth): Promise<HandlerResult> => {
                if (idempotencyKey) {
                  const started = await beginIdempotent(tx, {
                    route: routeId,
                    key: idempotencyKey,
                    fingerprint: requestFingerprint({ route: routeId, params, body }),
                    tenantOrgId: route.idempotencyTenant?.({ params, body }) ?? null,
                  });
                  if (started.outcome === 'replay') {
                    return {
                      status: started.status,
                      body: started.body,
                      headers: { 'idempotent-replayed': 'true' },
                    };
                  }
                }
                const handled = await route.handler({
                  request,
                  tx,
                  auth,
                  idempotencyKey,
                  params,
                  query,
                  body,
                });
                if (handled.status < 200 || handled.status > 299) {
                  throw new Error('authenticated handlers must throw ApiError for non-2xx results');
                }
                checkResponse(route, handled);
                if (idempotencyKey) {
                  await completeIdempotent(tx, {
                    route: routeId,
                    key: idempotencyKey,
                    status: handled.status,
                    body: handled.body,
                  });
                }
                return handled;
              },
              deps.principalLimits
                ? {
                    limits: deps.principalLimits,
                    route: { id: routeId, limit: route.rateLimit },
                  }
                : undefined,
            );
          }

          if (route.auth === 'none') checkResponse(route, result);
          for (const [name, value] of Object.entries(result.headers ?? {}))
            reply.header(name, value);
          return await reply.code(result.status).send(result.body);
        } catch (error) {
          if (error instanceof ApiError) return sendError(reply, request, error);
          const mapped = mapDatabaseError(error);
          if (mapped) return sendError(reply, request, mapped);
          throw error; // the global handler logs it and returns a generic 500
        }
      },
    });
  }
}
