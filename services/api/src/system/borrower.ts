import { type SystemPool } from './pool.js';

/** Worker-side borrower operations (database functions that only the system login may run). */
export interface BorrowerProcessor {
  /** Anonymises the profile for a deletion request; repeating a processed request is a no-op. */
  processDeletion(id: string): Promise<string>;
  /** Marks drafts past their expiry. Reads never depend on this; it only keeps the stored status honest. */
  expireDrafts(): Promise<number>;
}

export function createBorrowerProcessor(pool: SystemPool): BorrowerProcessor {
  return {
    processDeletion: (id) =>
      pool.withSystem(async (tx) => {
        const result = await tx.query<{ status: string }>(
          'select identity.process_deletion($1::uuid) as status',
          [id],
        );
        return result.rows[0]?.status ?? 'unknown';
      }),
    expireDrafts: () =>
      pool.withSystem(async (tx) => {
        const result = await tx.query<{ n: number }>('select lending.expire_drafts() as n');
        return result.rows[0]?.n ?? 0;
      }),
  };
}
