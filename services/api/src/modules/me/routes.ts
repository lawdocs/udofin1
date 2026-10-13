import { z } from 'zod';
import { userRoute, type RouteDefinition } from '../../http/routes.js';

interface MembershipRow {
  membership_id: string;
  org_id: string;
  org_kind: string;
  org_name: string;
  permission_key: string | null;
}

export const MeResponse = z.object({
  userId: z.uuid(),
  actor: z.enum(['borrower', 'lender', 'platform']),
  memberships: z.array(
    z.object({
      membershipId: z.uuid(),
      organizationId: z.uuid(),
      organizationKind: z.string(),
      organizationName: z.string(),
      permissions: z.array(z.string()),
    }),
  ),
});

/** GET /v1/me: who the database says the caller is, and what they may do. Never cached. */
export const meRoutes: RouteDefinition[] = [
  userRoute({
    method: 'get',
    path: '/v1/me',
    operationId: 'getMe',
    summary: 'Current identity, memberships and permissions',
    description:
      'Identity and permissions are resolved from the database on every request, never from the token. Staff sessions must have completed the second factor (aal2).',
    tags: ['Identity'],
    auth: 'user',
    responses: { 200: MeResponse },
    errors: [401, 403],
    handler: async ({ tx, auth }) => {
      const rows = await tx.query<MembershipRow>(
        `select m.id as membership_id, m.org_id, o.kind::text as org_kind, o.display_name as org_name,
                rp.permission_key
           from tenancy.memberships m
           join tenancy.organizations o on o.id = m.org_id
           left join tenancy.membership_roles mr on mr.membership_id = m.id
           left join tenancy.role_permissions rp on rp.role_id = mr.role_id
          where m.user_id = (select auth.uid()) and m.status = 'active'
            and (m.valid_until is null or m.valid_until > now())
          order by m.id, rp.permission_key`,
      );
      const byMembership = new Map<string, z.infer<typeof MeResponse>['memberships'][number]>();
      for (const row of rows.rows) {
        let entry = byMembership.get(row.membership_id);
        if (!entry) {
          entry = {
            membershipId: row.membership_id,
            organizationId: row.org_id,
            organizationKind: row.org_kind,
            organizationName: row.org_name,
            permissions: [],
          };
          byMembership.set(row.membership_id, entry);
        }
        if (row.permission_key) entry.permissions.push(row.permission_key);
      }
      return {
        status: 200,
        body: {
          userId: auth.claims.sub,
          actor: auth.actor,
          memberships: [...byMembership.values()],
        },
      };
    },
  }),
];
