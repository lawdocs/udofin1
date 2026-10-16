import { type SystemPool } from '../system/pool.js';
import { type HandlerDefinition } from './outbox-worker.js';

export interface ServicingHandlerDeps {
  readonly pool: SystemPool;
}

/**
 * Outbox handlers for servicing events: `servicing.import.committed`, `servicing.loan_closed`, `servicing.sync_conflict.opened`.
 * An event type with no handler is dead-lettered by the worker, so every event the database enqueues needs one.
 * Wave 5 (builder W2) fills this in.
 */
export function createServicingHandlers(
  _deps: ServicingHandlerDeps,
): Record<string, HandlerDefinition> {
  return {};
}
