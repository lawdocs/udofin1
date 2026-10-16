import { type AppEnvironment } from '@udofin/adapters';
import { type SystemPool } from '../system/pool.js';
import { type WorkerLogger } from './outbox-worker.js';
import { type ProviderResolver } from './provider-resolver.js';

export interface PeriodicJobDeps {
  readonly pool: SystemPool;
  readonly providers: ProviderResolver;
  readonly environment: AppEnvironment;
  readonly log: WorkerLogger;
}

/**
 * The scheduled work of Phase 08a: reminders (plan, claim, send), mandate sweeps and debit planning and pre-debit notices,
 * order and mandate lookups, expiry of stale payments, the daily reconciliation run, revalidation of payment configurations and
 * the purge of expired hand-off links. Wave 5 (builder W2) fills this in. Returns a stop function.
 */
export function startPeriodicJobs(_deps: PeriodicJobDeps): { stop(): void } {
  return { stop: () => undefined };
}
