import type pg from 'pg';

export interface LoginPosture {
  rolsuper: boolean;
  rolbypassrls: boolean;
  rolcreaterole: boolean;
  /** Only inspected for the system login. */
  rolcreatedb?: boolean;
  rolreplication?: boolean;
  canAssumeServiceRole: boolean;
  /** True when the login is a member (directly or through inheritance) of a role other than service_role that is a superuser or holds BYPASSRLS, CREATEROLE, CREATEDB or REPLICATION. Only inspected for the system login. */
  memberOfPrivilegedRole?: boolean;
}

export class LoginPostureError extends Error {
  override readonly name = 'LoginPostureError';
}

/** Returns the reasons a database login is unsafe for the user-request pool (empty when fine). */
export function userLoginViolations(posture: LoginPosture): string[] {
  const problems: string[] = [];
  if (posture.rolsuper) problems.push('is a superuser');
  if (posture.rolbypassrls) problems.push('can bypass row-level security');
  if (posture.rolcreaterole) problems.push('can create roles');
  if (posture.canAssumeServiceRole) problems.push('can assume service_role');
  return problems;
}

/** Boot guard: the API must not start when its user-request login could skip row-level security. */
export async function assertUserLoginPosture(pool: Pick<pg.Pool, 'query'>): Promise<void> {
  const result = await pool.query<LoginPosture>(
    `select r.rolsuper, r.rolbypassrls, r.rolcreaterole,
            pg_has_role(current_user, 'service_role', 'member') as "canAssumeServiceRole"
       from pg_roles r where r.rolname = current_user`,
  );
  const row = result.rows[0];
  if (!row) throw new LoginPostureError('database login not found');
  const problems = userLoginViolations(row);
  if (problems.length > 0) {
    throw new LoginPostureError(`unsafe database login for user requests: ${problems.join('; ')}`);
  }
}

/**
 * Returns the reasons a database login is unsafe for the SYSTEM pool (empty when fine). The system login
 * may do exactly one privileged thing, `SET ROLE service_role`; it must not itself be a superuser or hold
 * any of the attributes that would let it skip the grants and policies `service_role` is held to (audit R-10).
 */
export function systemLoginViolations(posture: LoginPosture): string[] {
  const problems: string[] = [];
  if (posture.rolsuper) problems.push('is a superuser');
  if (posture.rolbypassrls) problems.push('can bypass row-level security');
  if (posture.rolcreaterole) problems.push('can create roles');
  if (posture.rolcreatedb) problems.push('can create databases');
  if (posture.rolreplication) problems.push('can start replication');
  if (posture.memberOfPrivilegedRole)
    problems.push('is a member of a privileged role other than service_role');
  if (!posture.canAssumeServiceRole) problems.push('cannot assume service_role');
  return problems;
}

/** The part of the system pool this check needs: one transaction that has already switched to `service_role`. */
export interface SystemPoolLike {
  withSystem<T>(fn: (tx: Pick<pg.PoolClient, 'query'>) => Promise<T>): Promise<T>;
}

/**
 * Boot guard for the worker and the callback receiver: refuse to start when the system login is
 * over-privileged, or when it cannot actually assume `service_role` (on managed Supabase the platform
 * role grants can fail with only a warning in the migration, so this proves the result).
 * The check looks at `session_user` (the login), because inside `withSystem` the current user is already service_role.
 */
export async function assertSystemLoginPosture(pool: SystemPoolLike): Promise<void> {
  let row: LoginPosture | undefined;
  try {
    row = await pool.withSystem(async (tx) => {
      const result = await tx.query<LoginPosture>(
        `select r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb, r.rolreplication,
                pg_has_role(session_user, 'service_role', 'member') as "canAssumeServiceRole",
                exists (
                  select 1 from pg_roles p
                   where p.rolname <> 'service_role' and p.rolname <> session_user
                     and (p.rolsuper or p.rolbypassrls or p.rolcreaterole or p.rolcreatedb or p.rolreplication)
                     and pg_has_role(session_user, p.oid, 'member')
                ) as "memberOfPrivilegedRole"
           from pg_roles r where r.rolname = session_user`,
      );
      return result.rows[0];
    });
  } catch (error) {
    // 42501: the login is not allowed to switch to service_role (the grant is missing). Anything else is
    // a connection problem; either way the process must not start half-configured.
    if ((error as { code?: string } | null)?.code === '42501') {
      throw new LoginPostureError(
        'unsafe database login for system work: cannot assume service_role (grant it as the project owner, docs/operations/supabase-setup.md)',
      );
    }
    throw new LoginPostureError(
      `system database login could not be inspected (${(error as Error).name})`,
    );
  }
  if (!row) throw new LoginPostureError('system database login not found');
  const problems = systemLoginViolations(row);
  if (problems.length > 0) {
    throw new LoginPostureError(`unsafe database login for system work: ${problems.join('; ')}`);
  }
}
