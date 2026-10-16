import { z, type ZodType } from 'zod';
import { type RouteDefinition } from './routes.js';

type Json = Record<string, unknown>;

function schemaOf(schema: ZodType, io: 'input' | 'output'): Json {
  const json = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io,
    unrepresentable: 'any',
  }) as Json;
  delete json.$schema;
  return json;
}

const PROBLEM_REF = { $ref: '#/components/schemas/ProblemDetails' };
const PROBLEM_TITLES: Record<number, string> = {
  400: 'Bad request',
  401: 'Not authenticated, or a staff session without the second factor',
  403: 'Authenticated but not allowed',
  404: 'Not found (also returned when the caller may not know the resource exists)',
  409: 'Conflicts with the current state',
  422: 'Validation failed, or an idempotency key was reused with a different request',
  429: 'Rate limit exceeded',
  500: 'Internal error (no details are returned)',
};

function openApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function parameters(schema: ZodType | undefined, where: 'path' | 'query'): Json[] {
  if (!schema) return [];
  const json = schemaOf(schema, 'input') as {
    properties?: Record<string, Json>;
    required?: string[];
  };
  return Object.entries(json.properties ?? {}).map(([name, s]) => ({
    name,
    in: where,
    required: where === 'path' ? true : (json.required ?? []).includes(name),
    schema: s,
  }));
}

/** Builds the OpenAPI 3.1 document from the same declarations that serve the routes. */
export function buildOpenApi(routes: readonly RouteDefinition[], version: string): Json {
  const paths: Record<string, Record<string, Json>> = {};
  for (const route of routes) {
    const hasInput = Boolean(route.params ?? route.query ?? route.body);
    const idempotent = route.auth !== 'none' && route.idempotent === true;
    const params = [...parameters(route.params, 'path'), ...parameters(route.query, 'query')];
    if (idempotent) {
      params.push({
        name: 'Idempotency-Key',
        in: 'header',
        required: true,
        description:
          '16 to 128 characters (letters, digits, . _ : -). Retrying with the same key and the same request returns the original result; the same key with a different request returns 422.',
        schema: {
          type: 'string',
          minLength: 16,
          maxLength: 128,
          pattern: '^[A-Za-z0-9._:-]{16,128}$',
        },
      });
    }
    const errorStatuses = new Set<number>(route.errors ?? []);
    errorStatuses.add(500);
    if (route.auth !== 'none') {
      errorStatuses.add(401);
      errorStatuses.add(403);
    }
    if (hasInput) errorStatuses.add(422);
    if (route.rateLimit !== false) errorStatuses.add(429);
    if (idempotent) errorStatuses.add(400);

    const responses: Record<string, Json> = {};
    for (const [status, schema] of Object.entries(route.responses)) {
      responses[status] = {
        description: Number(status) >= 500 ? 'Service unavailable' : 'Success',
        content: { 'application/json': { schema: schemaOf(schema, 'output') } },
        ...(idempotent
          ? {
              headers: {
                'Idempotent-Replayed': {
                  description: 'Present and "true" when this response is a stored replay.',
                  schema: { type: 'string', enum: ['true'] },
                },
              },
            }
          : {}),
      };
    }
    for (const status of [...errorStatuses].sort()) {
      if (responses[String(status)]) continue;
      responses[String(status)] = {
        description: PROBLEM_TITLES[status] ?? 'Error',
        content: { 'application/problem+json': { schema: PROBLEM_REF } },
      };
    }

    const operation: Json = {
      operationId: route.operationId,
      summary: route.summary,
      ...(route.description ? { description: route.description } : {}),
      tags: route.tags,
      ...(params.length > 0 ? { parameters: params } : {}),
      ...(route.body
        ? {
            requestBody: {
              required: true,
              content: { 'application/json': { schema: schemaOf(route.body, 'input') } },
            },
          }
        : {}),
      responses,
      security: route.auth === 'none' ? [] : [{ bearerAuth: [] }],
      ...(route.auth === 'staff'
        ? { 'x-udofin-requires': 'staff session with second factor (aal2)' }
        : {}),
    };
    const key = openApiPath(route.path);
    (paths[key] ??= {})[route.method] = operation;
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Udofin API',
      version,
      description:
        'Versioned HTTP API of the Udofin lending service provider platform. Errors use RFC 9457 problem+json with a stable `code`. Only implemented endpoints are listed.',
    },
    servers: [{ url: '/', description: 'Relative to the API host' }],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description:
            'Supabase access token. Identity and permissions are resolved server-side on every request.',
        },
      },
      schemas: {
        ProblemDetails: {
          type: 'object',
          required: ['type', 'title', 'status', 'code', 'instance'],
          properties: {
            type: { type: 'string' },
            title: { type: 'string' },
            status: { type: 'integer' },
            code: { type: 'string', description: 'Stable machine-readable error code.' },
            instance: {
              type: 'string',
              description: 'The request id (also in the x-request-id header).',
            },
            detail: { type: 'string' },
          },
        },
      },
    },
  };
}
