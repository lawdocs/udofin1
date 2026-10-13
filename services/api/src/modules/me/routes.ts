import type { FastifyInstance } from 'fastify';
import { withAuthenticatedUser, type ActorKind } from '../../auth/request-auth.js';
import { type AuthDeps } from '../../auth/deps.js';

interface MembershipRow {
  membership_id: string;
  org_id: string;
  org_kind: string;
  org_name: string;
  permission_key: string | null;
}

export interface MeResponse {
  userId: string;
  actor: ActorKind;
  memberships: {
    membershipId: string;
    organizationId: string;
    organizationKind: string;
    organizationName: string;
    permissions: string[];
  }[];
}

/** GET /v1/me: who the database says the caller is, and what they may do. Never cached. */
export function registerMeRoutes(app: FastifyInstance, deps: AuthDeps): void {
  app.get('/v1/me', async (request, reply) => {
    const me = await withAuthenticatedUser(
      deps,
      request,
      reply,
      { require: 'any_user' },
      async (tx, auth): Promise<MeResponse> => {
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
        const byMembership = new Map<string, MeResponse['memberships'][number]>();
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
          userId: auth.claims.sub,
          actor: auth.actor,
          memberships: [...byMembership.values()],
        };
      },
    );
    if (me) return reply.send(me);
    return reply;
  });
}
