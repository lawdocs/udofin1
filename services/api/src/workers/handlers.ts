import { z } from 'zod';
import { type BorrowerProcessor } from '../system/borrower.js';
import { type ChangeRequestApplier } from '../system/change-requests.js';
import { PermanentError, type HandlerDefinition } from './outbox-worker.js';
import { createRoutingHandlers, type ConnectorResolver } from './routing-handlers.js';
import { type RoutingProcessor } from '../system/routing.js';

const ChangeRequestApproved = z.strictObject({ change_request_id: z.uuid() });
const DeletionRequested = z.strictObject({ deletion_request_id: z.uuid() });

interface PgLikeError {
  code?: string;
}

/**
 * Handlers for events this phase actually produces. Integrations that do not exist yet (SMS,
 * documents, payment providers) get handlers in the phases that build them, not here.
 */
export function createHandlers(deps: {
  applier: ChangeRequestApplier;
  /** Returns the request's status, or undefined if it does not exist. */
  changeRequestStatus: (id: string) => Promise<string | undefined>;
  borrower: BorrowerProcessor;
  routing: RoutingProcessor;
  connectors: ConnectorResolver;
}): Record<string, HandlerDefinition> {
  return {
    ...createRoutingHandlers({ routing: deps.routing, connectors: deps.connectors }),
    'borrower.deletion_requested': {
      schema: DeletionRequested,
      run: async (payload) => {
        const { deletion_request_id: id } = payload as z.infer<typeof DeletionRequested>;
        try {
          // 'blocked' (an active loan account) is a recorded outcome, not a failure to retry.
          await deps.borrower.processDeletion(id);
        } catch (error) {
          if ((error as PgLikeError).code === 'P0002') throw new PermanentError('request_missing');
          throw error;
        }
      },
    },
    'change_request.approved': {
      schema: ChangeRequestApproved,
      run: async (payload) => {
        const { change_request_id: id } = payload as z.infer<typeof ChangeRequestApproved>;
        try {
          await deps.applier.apply(id);
        } catch (error) {
          const code = (error as PgLikeError).code;
          if (code === '55000') {
            // Already applied by an earlier delivery (or expired / not approved): re-running is a no-op.
            const status = await deps.changeRequestStatus(id);
            if (status === 'applied') return;
            throw new PermanentError(`request_${status ?? 'missing'}`);
          }
          // A rule that will always refuse (permission lost, segregation, unknown target): no point retrying.
          if (code === '42501' || code === '23514' || code === 'P0002' || code === '22023') {
            throw new PermanentError('apply_refused');
          }
          throw error; // connection problems and the like: retry with backoff
        }
      },
    },
  };
}
