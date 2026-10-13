import { type SystemPool } from '../system/pool.js';
import { type OutboxEvent, type OutboxStore } from './outbox-worker.js';

/** Postgres implementation of the outbox storage, over the ops.* functions. */
export function createPgOutboxStore(pool: SystemPool): OutboxStore {
  return {
    claim: (workerId, batch, leaseSeconds) =>
      pool.withSystem(async (tx) => {
        const result = await tx.query<OutboxEvent>(
          'select id, event_type, payload, payload_version, attempts, max_attempts, correlation_id from ops.claim_outbox_events($1, $2, make_interval(secs => $3))',
          [workerId, batch, leaseSeconds],
        );
        return result.rows;
      }),
    complete: (id, workerId) =>
      pool.withSystem(async (tx) => {
        const result = await tx.query<{ ok: boolean }>(
          'select ops.complete_outbox_event($1::uuid, $2) as ok',
          [id, workerId],
        );
        return result.rows[0]?.ok === true;
      }),
    fail: (id, workerId, errorCode, permanent) =>
      pool.withSystem(async (tx) => {
        const result = await tx.query<{ status: 'pending' | 'dead' | null }>(
          'select ops.fail_outbox_event($1::uuid, $2, $3, $4)::text as status',
          [id, workerId, errorCode, permanent],
        );
        return result.rows[0]?.status ?? null;
      }),
    purge: () =>
      pool.withSystem(async (tx) => {
        const a = await tx.query<{ n: number }>('select ops.purge_expired_idempotency(1000) as n');
        const b = await tx.query<{ n: number }>(
          "select ops.purge_completed_events(interval '30 days', 1000) as n",
        );
        return { idempotency: a.rows[0]?.n ?? 0, completedEvents: b.rows[0]?.n ?? 0 };
      }),
  };
}
