import { createHash, randomUUID } from 'node:crypto';
import {
  renderDocument,
  RenderError,
  type DocumentStore,
  type SigningProvider,
  type SmsSender,
} from '@udofin/adapters';
import { RenderModel } from '@udofin/contracts';
import { z } from 'zod';
import { type DocumentProcessor } from '../system/documents.js';
import { PermanentError, type HandlerDefinition } from './outbox-worker.js';

const Generate = z.strictObject({ job_id: z.uuid() });
const SigningInitiate = z.strictObject({ request_id: z.uuid() });
const SigningReconcile = z.strictObject({
  request_id: z.uuid(),
  round: z.number().int().min(1).max(20),
});
const Deliver = z.strictObject({ delivery_id: z.uuid() });

/** How long to wait before asking the signing provider again about an uncertain request, by round. */
const RECONCILE_DELAYS_SECONDS = [60, 300, 900, 3600, 14_400] as const;

/**
 * Document jobs. A job holds only an identifier; the database re-checks every precondition when it runs. Generation is
 * idempotent: a repeat returns the document already made. A rendering problem is recorded as the job's failure class and
 * never touches the offer or an earlier document. An uncertain signing outcome is reconciled by asking the provider,
 * never by starting the signing again. A delivery result says what the provider said, nothing more.
 */
export function createDocumentHandlers(deps: {
  documents: DocumentProcessor;
  store: DocumentStore | undefined;
  signing: SigningProvider;
  sms: SmsSender;
  now?: () => Date;
}): Record<string, HandlerDefinition> {
  const now = deps.now ?? (() => new Date());
  const scheduleReconcile = (requestId: string, round: number) =>
    deps.documents.enqueue(
      'signing.reconcile',
      { request_id: requestId, round },
      `sign-reconcile:${requestId}:${String(round)}`,
      RECONCILE_DELAYS_SECONDS[Math.min(round, RECONCILE_DELAYS_SECONDS.length) - 1] ?? 3600,
    );

  return {
    'document.generate': {
      schema: Generate,
      run: async (payload) => {
        const { job_id: jobId } = payload as z.infer<typeof Generate>;
        const begun = (await deps.documents.beginGeneration(jobId)) as Record<string, unknown>;
        if ('done' in begun || 'failed' in begun) return; // finished earlier, or stopped by a precondition (recorded)
        const parsed = RenderModel.safeParse(begun);
        if (!parsed.success) {
          await deps.documents.failGeneration(jobId, 'render_model_invalid');
          return;
        }
        if (!deps.store) {
          await deps.documents.failGeneration(jobId, 'document_store_unavailable');
          return;
        }
        let bytes: Uint8Array;
        try {
          bytes = await renderDocument(parsed.data, { generatedAt: now() });
        } catch (error) {
          if (error instanceof RenderError) {
            await deps.documents.failGeneration(
              jobId,
              error.code.replace(/[^a-z_]/g, '_').slice(0, 50),
            );
            return;
          }
          throw error; // unexpected: retried, the job stays "running" until it succeeds or is swept
        }
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        const key = `documents/${randomUUID()}`;
        await deps.store.put(key, bytes, { mimeType: 'application/pdf', sha256 });
        try {
          await deps.documents.completeGeneration(jobId, key, sha256, bytes.length);
        } catch (error) {
          await deps.store.delete(key).catch(() => undefined); // never leave a file no record points to
          throw error;
        }
      },
    },

    'signing.initiate': {
      schema: SigningInitiate,
      run: async (payload) => {
        const { request_id: requestId } = payload as z.infer<typeof SigningInitiate>;
        const ctx = await deps.documents.signingContext(requestId);
        if (ctx.state !== 'ready_for_signing') return; // already started or closed
        if (ctx.providerMode === 'mock' && deps.signing.descriptor.mode !== 'mock') {
          throw new PermanentError('mock_signing_blocked');
        }
        const result = await deps.signing.initiate({
          idempotencyKey: requestId,
          documentId: ctx.documentId,
          documentSha256: ctx.documentSha256,
          storageKey: ctx.storageKey,
        });
        if (result.state === 'unknown') {
          await deps.documents.recordSigningEvent({
            requestId,
            to: 'requires_reconciliation',
            detail: { reason: 'outcome_unobserved' },
          });
          await scheduleReconcile(requestId, 1);
          return;
        }
        if (result.state === 'failed') {
          await deps.documents.recordSigningEvent({
            requestId,
            to: 'failed',
            providerRef: result.providerRef ?? null,
            detail: { reason: result.reason },
          });
          return;
        }
        await deps.documents.recordSigningEvent({
          requestId,
          to: 'initiated',
          providerRef: result.providerRef,
        });
        if (result.state === 'initiated') return;
        await deps.documents.recordSigningEvent({
          requestId,
          to: result.state,
          providerRef: result.providerRef,
          evidenceRef: result.state === 'executed' ? result.evidenceRef : null,
        });
      },
    },

    'signing.reconcile': {
      schema: SigningReconcile,
      run: async (payload) => {
        const { request_id: requestId, round } = payload as z.infer<typeof SigningReconcile>;
        const ctx = await deps.documents.signingContext(requestId);
        if (ctx.state !== 'requires_reconciliation') return;
        const result = deps.signing.capabilities.statusLookup
          ? await deps.signing.status({ providerRef: ctx.providerRef, idempotencyKey: requestId })
          : ({ state: 'unknown' } as const);
        if (result.state === 'unknown') {
          if (round < RECONCILE_DELAYS_SECONDS.length)
            await scheduleReconcile(requestId, round + 1);
          return;
        }
        if (result.state === 'failed') {
          await deps.documents.recordSigningEvent({
            requestId,
            to: 'failed',
            providerRef: result.providerRef ?? null,
          });
          return;
        }
        await deps.documents.recordSigningEvent({
          requestId,
          to: result.state,
          providerRef: result.providerRef,
          evidenceRef: result.state === 'executed' ? result.evidenceRef : null,
        });
      },
    },

    'document.deliver': {
      schema: Deliver,
      run: async (payload) => {
        const { delivery_id: id } = payload as z.infer<typeof Deliver>;
        const begun = await deps.documents.beginDelivery(id);
        if ('skip' in begun) return;
        // Content-free notice: it says documents are ready in the app. No amount, no link, no document.
        const result = await deps.sms.send({
          template: 'documents_ready',
          to: begun.phone.startsWith('+') ? begun.phone : `+${begun.phone}`,
          language: begun.language,
          variables: {},
          idempotencyKey: `deliver:${id}`,
        });
        switch (result.status) {
          case 'accepted':
            await deps.documents.recordDeliveryResult(
              id,
              'accepted_by_provider',
              result.providerRef,
              null,
            );
            return;
          case 'rejected':
            await deps.documents.recordDeliveryResult(id, 'failed', null, result.reason);
            return;
          case 'timeout':
            await deps.documents.recordDeliveryResult(id, 'failed', null, 'timeout');
            return;
          case 'not_configured':
            await deps.documents.recordDeliveryResult(
              id,
              'not_configured',
              null,
              'provider_not_configured',
            );
            return;
        }
      },
    },
  };
}
