import { z } from 'zod';
import { createJobsStore, type JobsStore } from '../system/jobs.js';
import { type SystemPool } from '../system/pool.js';
import { type HandlerDefinition, type WorkerLogger } from './outbox-worker.js';

export interface ServicingHandlerDeps {
  readonly pool: SystemPool;
  /** Counts are logged here. Absent: the handlers run silently (the database audit has the same facts). */
  readonly log?: WorkerLogger;
  /** Replaces the database wrappers (tests). */
  readonly store?: JobsStore;
}

// The payloads the database writes (migrations 20261018000911 and 20261018000912): ids only, every field required, nothing else.
const ImportCommitted = z.strictObject({ batch_id: z.uuid(), lender_org_id: z.uuid() });
const SyncConflictOpened = z.strictObject({ conflict_id: z.uuid(), lender_org_id: z.uuid() });
const SyncQuarantineOpened = z.strictObject({ quarantine_id: z.uuid(), lender_org_id: z.uuid() });
const LoanClosed = z.strictObject({
  closure_id: z.uuid(),
  loan_account_id: z.uuid(),
  lender_org_id: z.uuid(),
});

/**
 * Outbox handlers for servicing events: `servicing.import.committed`, `servicing.loan_closed`, `servicing.sync_conflict.opened`,
 * `servicing.sync_quarantine.opened`.
 * An event type with no handler is retried and finally dead-lettered by the worker, so every event the database enqueues in
 * servicing has one. Delivery is at least once: each handler is safe to run again.
 */
export function createServicingHandlers(
  deps: ServicingHandlerDeps,
): Record<string, HandlerDefinition> {
  const store = deps.store ?? createJobsStore(deps.pool);
  return {
    // A lender user who commits an import can take an application only as far as `disbursement_pending`; the last step belongs to
    // the system, and this event is the trigger (the database notes say a worker must call it after commits). Only the number
    // moved is logged: no batch, lender or application is named.
    'servicing.import.committed': {
      schema: ImportCommitted,
      run: async (payload) => {
        const { lender_org_id: lender } = payload as z.infer<typeof ImportCommitted>;
        const disbursed = await store.completeDisbursements(lender);
        deps.log?.info(
          { event: 'servicing.import.committed', disbursed },
          'import commit acknowledged',
        );
      },
    },
    // The conflict is already in the lender's queue (servicing.sync_conflicts); there is nothing to send or decide. The event is
    // acknowledged so it does not dead-letter.
    'servicing.sync_conflict.opened': {
      schema: SyncConflictOpened,
      run: () => {
        deps.log?.info({ event: 'servicing.sync_conflict.opened' }, 'sync conflict acknowledged');
        return Promise.resolve();
      },
    },
    // A report the database could not apply is held in servicing.sync_quarantine (migration 20261018000925); the first time a row
    // is stored the database enqueues this event. The row is already in the lender's queue (readable with loan.read); nothing is
    // sent or decided here. The event is acknowledged so it does not dead-letter. Only the two ids are logged, never a value.
    'servicing.sync_quarantine.opened': {
      schema: SyncQuarantineOpened,
      run: (payload) => {
        const { quarantine_id: quarantine, lender_org_id: lender } = payload as z.infer<
          typeof SyncQuarantineOpened
        >;
        deps.log?.info(
          { event: 'servicing.sync_quarantine.opened', quarantine, lender },
          'sync quarantine acknowledged',
        );
        return Promise.resolve();
      },
    },
    // A closed loan sends no more reminders and its mandate is cancelled at the provider (a request: it is cancelled when the
    // provider confirms). Both in one transaction; both are idempotent.
    'servicing.loan_closed': {
      schema: LoanClosed,
      run: async (payload) => {
        const { loan_account_id: loan } = payload as z.infer<typeof LoanClosed>;
        const result = await store.suppressAndCancelForClosedLoan(loan);
        deps.log?.info({ event: 'servicing.loan_closed', ...result }, 'loan closure handled');
      },
    },
  };
}
