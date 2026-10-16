import { type HandoffKeyring } from '@udofin/adapters';
import { type SystemPool } from '../system/pool.js';
import { type HandlerDefinition } from './outbox-worker.js';
import { type ProviderResolver } from './provider-resolver.js';

export interface PaymentsHandlerDeps {
  readonly pool: SystemPool;
  readonly providers: ProviderResolver;
  /** Seals hand-off links before they are stored. Absent: no link can be kept and the order/mandate is recorded without one. */
  readonly keyring: HandoffKeyring | undefined;
}

/**
 * Outbox handlers for payments and mandates: `payment.create_order`, `payment.apply_event`, `mandate.handoff`, `mandate.cancel`.
 * Wave 5 (builder W1) fills this in.
 */
export function createPaymentsHandlers(
  _deps: PaymentsHandlerDeps,
): Record<string, HandlerDefinition> {
  return {};
}
