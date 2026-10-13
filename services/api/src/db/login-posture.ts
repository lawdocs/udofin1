import type pg from 'pg';

export interface LoginPosture {
  rolsuper: boolean;
  rolbypassrls: boolean;
  rolcreaterole: boolean;
  canAssumeServiceRole: boolean;
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
