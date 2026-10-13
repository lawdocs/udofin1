import { type ZodType } from 'zod';

/**
 * Outbox dispatcher. Delivery is AT LEAST ONCE: a worker can die after a handler succeeded but
 * before the event was marked complete, and the event will then run again. Handlers must be
 * idempotent. External calls are made by handlers OUTSIDE any database transaction, using the
 * provider's own idempotency and later reconciliation.
 */

export interface OutboxEvent {
  id: string;
  event_type: string;
  payload: unknown;
  payload_version: number;
  attempts: number;
  max_attempts: number;
  correlation_id: string | null;
}

/** Storage operations. The Postgres implementation wraps the ops.* functions. */
export interface OutboxStore {
  claim(workerId: string, batch: number, leaseSeconds: number): Promise<OutboxEvent[]>;
  complete(id: string, workerId: string): Promise<boolean>;
  fail(
    id: string,
    workerId: string,
    errorCode: string,
    permanent: boolean,
  ): Promise<'pending' | 'dead' | null>;
  /** Housekeeping: expired idempotency records and old completed events. */
  purge(): Promise<{ idempotency: number; completedEvents: number }>;
}

/** Throw from a handler when retrying cannot help (bad data, a rule that will always refuse). */
export class PermanentError extends Error {
  override readonly name = 'PermanentError';
  constructor(readonly code: string) {
    super(code);
  }
}

export interface HandlerDefinition {
  /** Validates the payload before the handler sees it. Invalid payloads are permanent failures. */
  schema: ZodType;
  run(payload: unknown, event: OutboxEvent): Promise<void>;
}

export interface WorkerLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export interface WorkerOptions {
  store: OutboxStore;
  handlers: Readonly<Record<string, HandlerDefinition>>;
  workerId: string;
  log: WorkerLogger;
  concurrency?: number;
  leaseSeconds?: number;
  pollIntervalMs?: number;
  maintenanceIntervalMs?: number;
}

export interface RunSummary {
  claimed: number;
  completed: number;
  retried: number;
  dead: number;
  lostLease: number;
}

const ERROR_CODE = /^[a-z0-9_.-]{1,64}$/;

export class OutboxWorker {
  private readonly concurrency: number;
  private readonly leaseSeconds: number;
  private stopping = false;
  private loop: Promise<void> | undefined;

  constructor(private readonly options: WorkerOptions) {
    this.concurrency = options.concurrency ?? 4;
    this.leaseSeconds = options.leaseSeconds ?? 60;
  }

  /** Claims one batch and processes it. Exposed so tests and one-shot jobs can drive the worker. */
  async runOnce(): Promise<RunSummary> {
    const { store, workerId } = this.options;
    const events = await store.claim(workerId, this.concurrency, this.leaseSeconds);
    const summary: RunSummary = {
      claimed: events.length,
      completed: 0,
      retried: 0,
      dead: 0,
      lostLease: 0,
    };
    await Promise.all(
      events.map(async (event) => {
        const outcome = await this.process(event);
        if (outcome === 'completed') summary.completed += 1;
        else if (outcome === 'pending') summary.retried += 1;
        else if (outcome === 'dead') summary.dead += 1;
        else summary.lostLease += 1;
      }),
    );
    return summary;
  }

  private async process(event: OutboxEvent): Promise<'completed' | 'pending' | 'dead' | 'lost'> {
    const { store, workerId, log } = this.options;
    const fields = { eventId: event.id, eventType: event.event_type, attempt: event.attempts };
    const definition = this.options.handlers[event.event_type];
    if (!definition) {
      // Not permanent: during a rolling deploy an older worker can see a type only the new release
      // handles. It backs off and retries; if nobody ever handles it, it ends up dead after max attempts.
      return this.fail(event, 'unknown_event_type', false);
    }
    const parsed = definition.schema.safeParse(event.payload);
    if (!parsed.success) {
      return this.fail(event, 'invalid_payload', true);
    }
    try {
      await definition.run(parsed.data, event);
    } catch (error) {
      if (error instanceof PermanentError) {
        return this.fail(event, ERROR_CODE.test(error.code) ? error.code : 'permanent_error', true);
      }
      // Log the error class only: messages can carry personal data from upstream systems.
      log.warn(
        { ...fields, errorClass: error instanceof Error ? error.name : 'unknown' },
        'outbox handler failed',
      );
      return this.fail(event, 'handler_error', false);
    }
    const done = await store.complete(event.id, workerId);
    if (!done) {
      log.warn(fields, 'outbox event finished after its lease was lost; it may run again');
      return 'lost';
    }
    return 'completed';
  }

  private async fail(
    event: OutboxEvent,
    code: string,
    permanent: boolean,
  ): Promise<'pending' | 'dead' | 'lost'> {
    const { store, workerId, log } = this.options;
    const status = await store.fail(event.id, workerId, code, permanent);
    if (status === null) return 'lost';
    if (status === 'dead') {
      log.error(
        { eventId: event.id, eventType: event.event_type, errorCode: code },
        'outbox event is dead',
      );
    }
    return status;
  }

  /** Starts the polling loop. Call stop() to finish in-flight work and exit. */
  start(): void {
    if (this.loop) return;
    this.stopping = false;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.loop;
    this.loop = undefined;
  }

  private async run(): Promise<void> {
    const poll = this.options.pollIntervalMs ?? 1_000;
    const maintenanceEvery = this.options.maintenanceIntervalMs ?? 600_000;
    let lastMaintenance = 0;
    while (!this.stopping) {
      let busy = false;
      try {
        busy = (await this.runOnce()).claimed > 0;
        if (Date.now() - lastMaintenance >= maintenanceEvery) {
          lastMaintenance = Date.now();
          const purged = await this.options.store.purge();
          this.options.log.info(purged, 'outbox housekeeping');
        }
      } catch (error) {
        this.options.log.error(
          { errorClass: error instanceof Error ? error.name : 'unknown' },
          'outbox poll failed',
        );
      }
      if (!busy && !this.stopping) {
        await new Promise((resolve) => setTimeout(resolve, poll + Math.floor(Math.random() * 250)));
      }
    }
  }
}
