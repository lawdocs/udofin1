import { type UserTx } from '../../db/user-context.js';
import { ApiError } from '../../http/api-error.js';

/** `select` list that returns camelCase keys, e.g. { lenderOrgId: 'lender_org_id' }. */
export const columns = (map: Record<string, string>): string =>
  Object.entries(map)
    .map(([key, expression]) => `${expression} as "${key}"`)
    .join(', ');

/** Keys of an input object converted to snake_case for the SQL functions (undefined dropped). */
export function toSnake(input: Record<string, unknown>): string {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    out[key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)] = value;
  }
  return JSON.stringify(out);
}

export type Need = 'read' | 'writer' | 'agree' | 'manage' | 'approve' | 'compliance';

/**
 * API-layer permission check, before any write is attempted. The database functions repeat every
 * check (and are the authority); this gives callers a clean 403 and keeps the two layers aligned.
 */
export async function assertCan(tx: UserTx, need: Need, lenderId?: string): Promise<void> {
  const result = await tx.query<{ allowed: boolean }>(
    `select case $1::text
        when 'manage' then private.has_platform_permission('onboarding.manage')
        when 'approve' then private.has_platform_permission('onboarding.approve')
        when 'compliance' then private.has_platform_permission('onboarding.compliance_signoff')
        when 'read' then $2::uuid in (select private.orgs_with_permission('onboarding.read'))
        when 'agree' then private.has_platform_permission('onboarding.approve')
                          or $2::uuid in (select private.orgs_with_permission('onboarding.submit'))
        when 'writer' then private.has_platform_permission('onboarding.manage')
                           or $2::uuid in (select private.orgs_with_permission('onboarding.submit'))
      end as allowed`,
    [need, lenderId ?? null],
  );
  if (!result.rows[0]?.allowed) throw new ApiError(403, 'forbidden', 'Forbidden');
}

const OWNER_TABLES = {
  accounting: 'onboarding.accounting_profiles',
  contract: 'onboarding.lender_contracts',
  service: 'onboarding.lender_services',
  serviceVersion: 'onboarding.service_versions',
  requirement: 'onboarding.lender_requirements',
  integration: 'onboarding.integrations',
  gateRequest: 'onboarding.gate_requests',
  document: 'onboarding.documents',
} as const;

/** The lender a record belongs to, as seen through row-level security (404 if not visible). */
export async function lenderOf(
  tx: UserTx,
  kind: keyof typeof OWNER_TABLES,
  id: string,
): Promise<string> {
  const result = await tx.query<{ lender: string }>(
    `select lender_org_id as lender from ${OWNER_TABLES[kind]} where id = $1::uuid`,
    [id],
  );
  const lender = result.rows[0]?.lender;
  if (!lender) throw new ApiError(404, 'not_found', 'Not Found');
  return lender;
}

export async function scalar<T>(tx: UserTx, text: string, values: readonly unknown[]): Promise<T> {
  const result = await tx.query<{ v: T }>(text, values);
  const row = result.rows[0];
  if (!row) throw new Error('expected a row');
  return row.v;
}
