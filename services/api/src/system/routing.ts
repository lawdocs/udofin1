import { type SystemPool } from './pool.js';

/** Worker-side lender routing operations (database functions that only the system login may run). */
export interface TransmissionBegin {
  skip?: string;
  applicationId?: string;
  lenderId?: string;
  connectorKind?: 'api' | 'mock';
  correlationRef?: string;
  attempt?: number;
  payload?: {
    udofinReference: string | null;
    request: { categoryKey: string; amountMinor: number; tenureDays: number; purposeCode: string };
    productVersionId: string;
    displayName: string | null;
    phone: string;
    language: 'en' | 'hi';
  };
}

export interface LenderHookContext {
  kind: 'manual' | 'api' | 'mock';
  status: 'draft' | 'active' | 'suspended';
  signingSecretRef: string | null;
}

export interface IngestResult {
  outcome: 'applied' | 'duplicate' | 'rejected' | 'quarantined';
  reason?: string;
}

export interface RoutingProcessor {
  beginTransmission(applicationId: string): Promise<TransmissionBegin>;
  recordResult(
    applicationId: string,
    outcome: 'accepted' | 'rejected' | 'unknown',
    lenderRef: string | null,
    errorClass: string | null,
  ): Promise<string>;
  resolveUncertain(
    applicationId: string,
    found: 'found' | 'not_found' | 'unknown',
    lenderRef: string | null,
  ): Promise<string>;
  /** What is needed to ask the lender about an uncertain application; null once it is no longer uncertain. */
  beginReconcile(
    applicationId: string,
  ): Promise<{ lenderId: string; correlationRef: string; connectorKind: 'api' | 'mock' } | null>;
  processDeadlines(): Promise<{ noResponse: number; offersExpired: number }>;
  /** Schedules a job through the outbox. Only identifiers go in the payload. */
  enqueue(
    type: string,
    payload: Record<string, string | number>,
    dedupeKey: string,
    delaySeconds: number,
  ): Promise<void>;
  hookContext(lenderId: string): Promise<LenderHookContext | null>;
  ingest(input: {
    lenderId: string;
    messageId: string;
    type: string;
    correlationRef: string;
    body: Record<string, unknown>;
  }): Promise<IngestResult>;
}

export function createRoutingProcessor(pool: SystemPool): RoutingProcessor {
  const one = async <T>(sql: string, values: unknown[]): Promise<T> =>
    pool.withSystem(async (tx) => {
      const r = await tx.query<{ r: T }>(sql, values);
      return r.rows[0]?.r as T;
    });
  return {
    beginTransmission: (id) =>
      one<TransmissionBegin>('select lending.begin_transmission($1::uuid) as r', [id]),
    recordResult: (id, outcome, ref, cls) =>
      one<string>('select lending.record_transmission_result($1::uuid, $2, $3, $4) as r', [
        id,
        outcome,
        ref,
        cls,
      ]),
    resolveUncertain: (id, found, ref) =>
      one<string>('select lending.resolve_uncertain($1::uuid, $2, $3) as r', [id, found, ref]),
    beginReconcile: (id) => one('select lending.reconcile_context($1::uuid) as r', [id]),
    processDeadlines: () => one('select lending.process_deadlines() as r', []),
    enqueue: async (type, payload, dedupeKey, delaySeconds) => {
      await pool.withSystem((tx) =>
        tx.query(
          `select ops.enqueue_event($1, $2::jsonb, null, $3, now() + make_interval(secs => $4::int))`,
          [type, JSON.stringify(payload), dedupeKey, delaySeconds],
        ),
      );
    },
    hookContext: (lenderId) =>
      one<LenderHookContext | null>('select lending.lender_hook_context($1::uuid) as r', [
        lenderId,
      ]),
    ingest: ({ lenderId, messageId, type, correlationRef, body }) =>
      one<IngestResult>(
        'select lending.ingest_lender_event($1::uuid, $2, $3, $4::uuid, $5::jsonb) as r',
        [lenderId, messageId, type, correlationRef, JSON.stringify(body)],
      ),
  };
}
