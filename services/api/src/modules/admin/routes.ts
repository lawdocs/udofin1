import { createHash } from 'node:crypto';
import {
  type CHANGE_REQUEST_STATUSES,
  CHANGE_REQUEST_TYPES,
  ChangeRequest,
  ChangeRequestDecision,
  ChangeRequestPage,
} from '@udofin/contracts';
import { z } from 'zod';
import { ApiError } from '../../http/api-error.js';
import { decodeCursor, encodeCursor, PageQuerySchema } from '../../http/pagination.js';
import { userRoute, type RouteDefinition } from '../../http/routes.js';

const CreateBody = z.strictObject({
  type: z.enum(CHANGE_REQUEST_TYPES),
  targetOrganizationId: z.uuid().nullable().default(null),
  payload: z.record(z.string(), z.unknown()).default({}),
});
const DecisionBody = z.strictObject({ note: z.string().max(1000).optional() });
const IdParams = z.strictObject({ id: z.uuid() });

const ChangeRequestDto = ChangeRequest;
const DecisionResponse = ChangeRequestDecision;
const ListResponse = ChangeRequestPage;
const CreatedResponse = z.object({ id: z.uuid() });

interface RequestRow {
  id: string;
  request_type: (typeof CHANGE_REQUEST_TYPES)[number];
  target_org_id: string | null;
  status: (typeof CHANGE_REQUEST_STATUSES)[number];
  requested_by: string;
  decided_by: string | null;
  created_at: string;
  expires_at: string;
}

const COLUMNS = `id, request_type::text as request_type, target_org_id, status::text as status, requested_by,
                 decided_by, created_at::text as created_at, expires_at::text as expires_at`;

const toDto = (row: RequestRow): z.infer<typeof ChangeRequestDto> => ({
  id: row.id,
  type: row.request_type,
  targetOrganizationId: row.target_org_id,
  status: row.status,
  requestedBy: row.requested_by,
  decidedBy: row.decided_by,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
});

const STAFF_WRITE_LIMIT = { max: 30, timeWindow: '1 minute' };

/**
 * Two-person change control. The database enforces who may request and decide; these routes only
 * translate. Approving enqueues application of the change in the same transaction (outbox); the
 * worker applies it, so a crash between decision and application cannot lose it.
 */
export const adminRoutes: RouteDefinition[] = [
  userRoute({
    method: 'post',
    path: '/v1/admin/change-requests',
    operationId: 'createChangeRequest',
    summary: 'File a change request',
    description:
      'Requires an Idempotency-Key. A repeat with the same key and body returns the original response; the same key with a different body is refused with 422 idempotency_key_reused.',
    tags: ['Administration'],
    auth: 'staff',
    idempotent: true,
    idempotencyTenant: ({ body }) => body.targetOrganizationId,
    body: CreateBody,
    responses: { 201: CreatedResponse },
    errors: [400, 401, 403, 409, 422],
    rateLimit: STAFF_WRITE_LIMIT,
    handler: async ({ tx, body, idempotencyKey }) => {
      const input = body;
      const row = await tx.query<{ id: string }>(
        'select private.request_change($1::tenancy.change_request_type, $2::uuid, $3::jsonb, $4) as id',
        [
          input.type,
          input.targetOrganizationId,
          JSON.stringify(input.payload),
          // The database also de-duplicates on (requester, key): derive its key from the HTTP key
          // so the two guards agree.
          createHash('sha256')
            .update(idempotencyKey ?? '')
            .digest('hex'),
        ],
      );
      const id = row.rows[0]?.id;
      if (!id) throw new Error('request_change returned nothing');
      return { status: 201, body: { id } };
    },
  }),

  userRoute({
    method: 'get',
    path: '/v1/admin/change-requests',
    operationId: 'listChangeRequests',
    summary: 'List change requests visible to the caller',
    description: 'Newest first, cursor pagination. Rows are limited by row-level security.',
    tags: ['Administration'],
    auth: 'staff',
    query: PageQuerySchema,
    responses: { 200: ListResponse },
    errors: [400, 401, 403, 422],
    handler: async ({ tx, query }) => {
      const page = query;
      const cursor = decodeCursor(page.cursor);
      const result = await tx.query<RequestRow>(
        `select ${COLUMNS} from tenancy.change_requests
          where ($1::timestamptz is null or (created_at, id) < ($1::timestamptz, $2::uuid))
          order by created_at desc, id desc limit $3`,
        [cursor?.t ?? null, cursor?.id ?? null, page.limit + 1],
      );
      const rows = result.rows.slice(0, page.limit);
      const more = result.rows.length > page.limit;
      const last = rows.at(-1);
      return {
        status: 200,
        body: {
          items: rows.map(toDto),
          nextCursor: more && last ? encodeCursor({ t: last.created_at, id: last.id }) : null,
        },
      };
    },
  }),

  userRoute({
    method: 'get',
    path: '/v1/admin/change-requests/:id',
    operationId: 'getChangeRequest',
    summary: 'Read one change request (use to follow an approval to "applied")',
    tags: ['Administration'],
    auth: 'staff',
    params: IdParams,
    responses: { 200: ChangeRequestDto },
    errors: [401, 403, 404, 422],
    handler: async ({ tx, params }) => {
      const result = await tx.query<RequestRow>(
        `select ${COLUMNS} from tenancy.change_requests where id = $1::uuid`,
        [params.id],
      );
      const row = result.rows[0];
      if (!row) throw new ApiError(404, 'not_found', 'Not Found');
      return { status: 200, body: toDto(row) };
    },
  }),

  ...(['approve', 'reject'] as const).map((verb) =>
    userRoute({
      method: 'post',
      path: `/v1/admin/change-requests/:id/${verb}`,
      operationId: `${verb}ChangeRequest`,
      summary: `${verb === 'approve' ? 'Approve' : 'Reject'} a change request`,
      description:
        verb === 'approve'
          ? 'Must be a different person from the requester. Approval returns status "approved"; the change is applied asynchronously by the worker (poll the request until "applied").'
          : 'Must be a different person from the requester.',
      tags: ['Administration'],
      auth: 'staff',
      idempotent: true,
      params: IdParams,
      body: DecisionBody,
      responses: { 200: DecisionResponse },
      errors: [400, 401, 403, 404, 409, 422],
      rateLimit: STAFF_WRITE_LIMIT,
      handler: async ({ tx, params, body }) => {
        const { id } = params;
        const { note } = body;
        const row = await tx.query<{ status: (typeof CHANGE_REQUEST_STATUSES)[number] }>(
          'select private.decide_change_request($1::uuid, $2::boolean, $3)::text as status',
          [id, verb === 'approve', note ?? null],
        );
        const status = row.rows[0]?.status;
        if (!status) throw new Error('decide_change_request returned nothing');
        return { status: 200, body: { id, status } };
      },
    }),
  ),
];
