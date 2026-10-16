import { type SystemPool } from './pool.js';

/** Applies an approved change request (database function private.apply_change_request). */
export interface ChangeRequestApplier {
  apply(id: string): Promise<Record<string, unknown>>;
}

export function createChangeRequestApplier(pool: SystemPool): ChangeRequestApplier {
  return {
    apply: (id) =>
      pool.withSystem(async (tx) => {
        const result = await tx.query<{ result: Record<string, unknown> }>(
          'select private.apply_change_request($1::uuid) as result',
          [id],
        );
        return result.rows[0]?.result ?? {};
      }),
  };
}
