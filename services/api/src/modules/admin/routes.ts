import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { type AuthDeps } from '../../auth/deps.js';
import { sendProblem, withAuthenticatedUser } from '../../auth/request-auth.js';
import { type ChangeRequestApplier } from '../../system/change-requests.js';

const CHANGE_TYPES = [
  'organization.create',
  'organization.activate',
  'membership.invite',
  'membership.suspend',
  'role.grant',
  'role.revoke',
  'consent_notice.publish',
] as const;

const CreateBody = z.strictObject({
  type: z.enum(CHANGE_TYPES),
  targetOrganizationId: z.uuid().nullable().default(null),
  payload: z.record(z.string(), z.unknown()).default({}),
});
const DecisionBody = z.strictObject({ note: z.string().max(1000).optional() });
const IdParams = z.strictObject({ id: z.uuid() });
const IdempotencyKey = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);

interface PgLikeError {
  code?: string;
  hint?: string;
}

function mapDatabaseError(error: unknown): { status: number; code: string } | undefined {
  const e = error as PgLikeError;
  if (typeof e?.code !== 'string') return undefined;
  if (e.code === '42501') {
    return e.hint === 'mfa_required'
      ? { status: 401, code: 'mfa_required' }
      : { status: 403, code: 'forbidden' };
  }
  switch (e.code) {
    case 'P0002':
      return { status: 404, code: 'not_found' };
    case '22023':
      return { status: 422, code: 'invalid_change_request' };
    case '23505':
    case '23514':
    case '55000':
      return { status: 409, code: 'change_request_conflict' };
    default:
      return undefined;
  }
}

function fail(
  reply: FastifyReply,
  request: FastifyRequest,
  error: unknown,
): FastifyReply | undefined {
  const mapped = mapDatabaseError(error);
  if (!mapped) return undefined;
  return sendProblem(reply, request, mapped.status, 'Change request refused', mapped.code);
}

interface RequestRow {
  id: string;
  request_type: string;
  target_org_id: string | null;
  status: string;
  requested_by: string;
  decided_by: string | null;
  created_at: string;
  expires_at: string;
}

const toDto = (row: RequestRow) => ({
  id: row.id,
  type: row.request_type,
  targetOrganizationId: row.target_org_id,
  status: row.status,
  requestedBy: row.requested_by,
  decidedBy: row.decided_by,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
});

/**
 * Two-person change control. The database enforces who may request and decide; these routes only
 * translate. Approving applies the change immediately through the narrow system module.
 */
export function registerAdminRoutes(
  app: FastifyInstance,
  deps: AuthDeps,
  applier: ChangeRequestApplier,
): void {
  app.post('/v1/admin/change-requests', async (request, reply) => {
    const key = IdempotencyKey.safeParse(request.headers['idempotency-key']);
    if (!key.success) {
      return sendProblem(reply, request, 400, 'Bad Request', 'idempotency_key_required');
    }
    const body = CreateBody.safeParse(request.body);
    if (!body.success) return sendProblem(reply, request, 422, 'Unprocessable', 'invalid_body');
    try {
      const id = await withAuthenticatedUser(
        deps,
        request,
        reply,
        { require: 'staff' },
        async (tx) => {
          const row = await tx.query<{ id: string }>(
            'select private.request_change($1::tenancy.change_request_type, $2::uuid, $3::jsonb, $4) as id',
            [
              body.data.type,
              body.data.targetOrganizationId,
              JSON.stringify(body.data.payload),
              key.data,
            ],
          );
          return row.rows[0]?.id;
        },
      );
      if (id) return await reply.code(201).send({ id });
      return reply;
    } catch (error) {
      const handled = fail(reply, request, error);
      if (handled) return handled;
      throw error;
    }
  });

  app.get('/v1/admin/change-requests', async (request, reply) => {
    const rows = await withAuthenticatedUser(
      deps,
      request,
      reply,
      { require: 'staff' },
      async (tx) => {
        const result = await tx.query<RequestRow>(
          `select id, request_type::text, target_org_id, status::text, requested_by, decided_by,
                created_at::text, expires_at::text
           from tenancy.change_requests order by created_at desc limit 100`,
        );
        return result.rows.map(toDto);
      },
    );
    if (rows) return reply.send({ items: rows });
    return reply;
  });

  const decide = (approve: boolean) => async (request: FastifyRequest, reply: FastifyReply) => {
    const params = IdParams.safeParse(request.params);
    const body = DecisionBody.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return sendProblem(reply, request, 422, 'Unprocessable', 'invalid_request');
    }
    try {
      const status = await withAuthenticatedUser(
        deps,
        request,
        reply,
        { require: 'staff' },
        async (tx) => {
          const row = await tx.query<{ status: string }>(
            'select private.decide_change_request($1::uuid, $2::boolean, $3)::text as status',
            [params.data.id, approve, body.data.note ?? null],
          );
          return row.rows[0]?.status;
        },
      );
      if (!status) return reply;
      if (status !== 'approved') return await reply.send({ id: params.data.id, status });
      try {
        const result = await applier.apply(params.data.id);
        return await reply.send({ id: params.data.id, status: 'applied', result });
      } catch (error) {
        // The approval stands; applying failed (for example a segregation rule). Report, do not hide.
        request.log.warn(
          { code: (error as PgLikeError).code },
          'approved change request not applied',
        );
        return (
          fail(reply, request, error) ??
          sendProblem(reply, request, 502, 'Change not applied', 'apply_failed')
        );
      }
    } catch (error) {
      const handled = fail(reply, request, error);
      if (handled) return handled;
      throw error;
    }
  };
  app.post('/v1/admin/change-requests/:id/approve', decide(true));
  app.post('/v1/admin/change-requests/:id/reject', decide(false));
}
