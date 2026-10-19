import { type RenderModel } from '@udofin/contracts';
import { type SystemPool } from './pool.js';

/** Worker-side document operations (database functions only the system login may run). */
export type GenerationBegun = RenderModel | { done: true; documentId: string } | { failed: string };

export interface SigningContext {
  requestId: string;
  state: string;
  providerKey: string;
  providerMode: 'mock' | 'sandbox' | 'live';
  providerRef: string | null;
  documentId: string;
  documentSha256: string;
  storageKey: string;
  uncertainSince: string | null;
}

export type DeliveryBegun =
  { skip: string } | { deliveryId: string; channel: string; phone: string; language: 'en' | 'hi' };

export interface DocumentProcessor {
  beginGeneration(jobId: string): Promise<unknown>;
  completeGeneration(jobId: string, key: string, sha256: string, size: number): Promise<string>;
  failGeneration(jobId: string, failureClass: string): Promise<void>;
  processExpiry(): Promise<{ expired: number; withdrawn: number; jobsInterrupted: number }>;
  signingContext(requestId: string): Promise<SigningContext>;
  recordSigningEvent(input: {
    requestId: string;
    to: string;
    providerRef?: string | null;
    evidenceRef?: string | null;
    detail?: Record<string, unknown>;
  }): Promise<{ state: string; unchanged: boolean }>;
  beginDelivery(deliveryId: string): Promise<DeliveryBegun>;
  recordDeliveryResult(
    deliveryId: string,
    outcome: 'accepted_by_provider' | 'delivered' | 'failed' | 'not_configured',
    providerRef: string | null,
    failureClass: string | null,
  ): Promise<void>;
  /** Schedules a job through the outbox. Only identifiers go in the payload. */
  enqueue(
    type: string,
    payload: Record<string, string | number>,
    dedupeKey: string,
    delaySeconds: number,
  ): Promise<void>;
}

export function createDocumentProcessor(pool: SystemPool): DocumentProcessor {
  const one = async <T>(sql: string, values: unknown[]): Promise<T> =>
    pool.withSystem(async (tx) => {
      const r = await tx.query<{ r: T }>(sql, values);
      return r.rows[0]?.r as T;
    });
  return {
    beginGeneration: (id) => one('select documents.begin_generation($1::uuid) as r', [id]),
    completeGeneration: (id, key, sha, size) =>
      one<string>('select documents.complete_generation($1::uuid, $2, $3, $4::bigint) as r', [
        id,
        key,
        sha,
        size,
      ]),
    failGeneration: async (id, cls) => {
      await pool.withSystem((tx) =>
        tx.query('select documents.fail_generation($1::uuid, $2)', [id, cls]),
      );
    },
    processExpiry: () => one('select documents.process_expiry() as r', []),
    signingContext: (id) => one('select documents.signing_context($1::uuid) as r', [id]),
    recordSigningEvent: ({ requestId, to, providerRef, evidenceRef, detail }) =>
      one('select documents.record_signing_event($1::uuid, $2, $3, $4, $5::jsonb) as r', [
        requestId,
        to,
        providerRef ?? null,
        evidenceRef ?? null,
        JSON.stringify(detail ?? {}),
      ]),
    beginDelivery: (id) => one('select documents.begin_delivery($1::uuid) as r', [id]),
    recordDeliveryResult: async (id, outcome, ref, cls) => {
      await pool.withSystem((tx) =>
        tx.query('select documents.record_delivery_result($1::uuid, $2, $3, $4)', [
          id,
          outcome,
          ref,
          cls,
        ]),
      );
    },
    enqueue: async (type, payload, dedupeKey, delaySeconds) => {
      await pool.withSystem((tx) =>
        tx.query(
          `select ops.enqueue_event($1, $2::jsonb, null, $3, now() + make_interval(secs => $4::int))`,
          [type, JSON.stringify(payload), dedupeKey, delaySeconds],
        ),
      );
    },
  };
}
