import {
  createUnconfiguredLenderConnector,
  withLenderTimeout,
  type AppEnvironment,
  type LenderConnector,
  type LenderSubmitResult,
} from '@udofin/adapters';
import { z } from 'zod';
import { type RoutingProcessor } from '../system/routing.js';
import { PermanentError, type HandlerDefinition } from './outbox-worker.js';

const Routed = z.strictObject({ application_id: z.uuid() });
const Reconcile = z.strictObject({
  application_id: z.uuid(),
  round: z.number().int().min(1).max(20),
});

/** How long to wait before asking a lender whether an uncertain application arrived, by round. */
const RECONCILE_DELAYS_SECONDS = [60, 300, 900, 3600, 14_400] as const;

export interface ConnectorResolver {
  /** Returns the connector for a lender. `mock` is refused outside local/test; `api` has no connector until a lender's specification exists. */
  for(input: { kind: 'api' | 'mock'; lenderId: string }): LenderConnector;
}

/**
 * Builds the resolver. A mock is created lazily and only where the environment allows it. A real lender
 * connector is registered here, per lender, once that lender's API specification and credentials exist.
 */
export function createConnectorResolver(options: {
  environment: AppEnvironment;
  createMock: () => LenderConnector;
  registered?: Readonly<Record<string, LenderConnector>>;
  timeoutMs?: number;
}): ConnectorResolver {
  let mock: LenderConnector | undefined;
  const bound = (c: LenderConnector) => withLenderTimeout(c, options.timeoutMs ?? 8000);
  return {
    for({ kind, lenderId }) {
      if (kind === 'mock') {
        if (options.environment === 'staging' || options.environment === 'production') {
          throw new PermanentError('mock_connector_blocked');
        }
        mock ??= options.createMock();
        return bound(mock);
      }
      const real = options.registered?.[lenderId];
      return bound(real ?? createUnconfiguredLenderConnector());
    },
  };
}

function toOutcome(result: LenderSubmitResult): {
  outcome: 'accepted' | 'rejected' | 'unknown';
  ref: string | null;
  cls: string | null;
} {
  switch (result.status) {
    case 'accepted':
      return { outcome: 'accepted', ref: result.lenderApplicationRef ?? null, cls: null };
    case 'rejected':
      return { outcome: 'rejected', ref: null, cls: result.reason };
    case 'unknown':
      return { outcome: 'unknown', ref: null, cls: result.reason };
    case 'not_configured':
      return { outcome: 'rejected', ref: null, cls: 'connector_not_configured' };
  }
}

/**
 * Transmission jobs. The job holds only an application id. Consent and state are checked again inside the database when
 * the job runs, and the contact detail is read there; this process never writes the payload anywhere. A timeout is
 * recorded as UNCERTAIN and reconciled by asking the lender, never blindly resent. Delivery is at least once, so every
 * step is safe to repeat.
 */
export function createRoutingHandlers(deps: {
  routing: RoutingProcessor;
  connectors: ConnectorResolver;
}): Record<string, HandlerDefinition> {
  const scheduleReconcile = (applicationId: string, round: number) =>
    deps.routing.enqueue(
      'application.reconcile',
      { application_id: applicationId, round },
      `reconcile:${applicationId}:${String(round)}`,
      RECONCILE_DELAYS_SECONDS[Math.min(round, RECONCILE_DELAYS_SECONDS.length) - 1] ?? 3600,
    );
  return {
    'application.routed': {
      schema: Routed,
      run: async (payload) => {
        const { application_id: id } = payload as z.infer<typeof Routed>;
        const begun = await deps.routing.beginTransmission(id);
        if (begun.skip) {
          if (begun.skip === 'uncertain') await scheduleReconcile(id, 1);
          return; // nothing to send (already sent, stopped for consent, cancelled, or in progress elsewhere)
        }
        if (!begun.payload || !begun.lenderId || !begun.correlationRef || !begun.connectorKind) {
          throw new PermanentError('malformed_transmission');
        }
        const connector = deps.connectors.for({
          kind: begun.connectorKind,
          lenderId: begun.lenderId,
        });
        const result = await connector.submit({
          lenderId: begun.lenderId,
          correlationRef: begun.correlationRef,
          attempt: begun.attempt ?? 1,
          payload: begun.payload,
        });
        const { outcome, ref, cls } = toOutcome(result);
        await deps.routing.recordResult(id, outcome, ref, cls);
        if (outcome === 'unknown') await scheduleReconcile(id, 1);
      },
    },
    'application.reconcile': {
      schema: Reconcile,
      run: async (payload) => {
        const { application_id: id, round } = payload as z.infer<typeof Reconcile>;
        const begun = await deps.routing.beginReconcile(id);
        if (!begun) return; // no longer uncertain
        const connector = deps.connectors.for({
          kind: begun.connectorKind,
          lenderId: begun.lenderId,
        });
        const found = connector.capabilities.statusLookup
          ? await connector.lookup({
              lenderId: begun.lenderId,
              correlationRef: begun.correlationRef,
            })
          : ({ status: 'unknown' } as const);
        const state = await deps.routing.resolveUncertain(
          id,
          found.status,
          found.status === 'found' ? (found.lenderApplicationRef ?? null) : null,
        );
        if (state === 'uncertain' && round < RECONCILE_DELAYS_SECONDS.length)
          await scheduleReconcile(id, round + 1);
      },
    },
  };
}
