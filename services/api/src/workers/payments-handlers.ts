import {
  HandoffVaultError,
  sealHandoffLink,
  withMandateTimeout,
  withPaymentTimeout,
  type CreatedOrder,
  type CreateOrderRequest,
  type HandoffKeyring,
  type HandoffKind,
  type MandateRequest,
  type PaymentProviderPort,
  type PaymentPurpose,
  type ProviderCallContext,
} from '@udofin/adapters';
import { MANDATE_LIVE_STATUSES } from '@udofin/domain';
import { z } from 'zod';
import {
  createPaymentsProcessor,
  databaseFailureOf,
  type MandateHandoffOutcome,
  type OrderFailureClass,
  type PaymentConfigRecord,
  type PaymentsProcessor,
} from '../system/payments.js';
import { type SystemPool } from '../system/pool.js';
import {
  PermanentError,
  RetryableError,
  type HandlerDefinition,
  type OutboxEvent,
  type WorkerLogger,
} from './outbox-worker.js';
import { type PaymentConfigRow, type ProviderResolver } from './provider-resolver.js';

export interface PaymentsHandlerDeps {
  readonly pool: SystemPool;
  readonly providers: ProviderResolver;
  /** Seals hand-off links before they are stored. Absent: no link can be kept and the order/mandate is recorded without one. */
  readonly keyring: HandoffKeyring | undefined;
  /** The database calls. Default: the system SQL functions over `pool`. Tests pass a fake. */
  readonly processor?: PaymentsProcessor;
  /** Where the handlers report. Default: one JSON line per message on stdout, like the worker's own logger. */
  readonly log?: WorkerLogger;
  readonly now?: () => Date;
  /** Bound on every provider call, in milliseconds (default 15 000). The outbox lease is 60 s and a handler makes at most two calls. */
  readonly providerTimeoutMs?: number;
}

/** The outcome of an order creation that the provider never answered clearly and a lookup did not settle: the outbox retries it. */
export class OrderOutcomeUnresolvedError extends Error {
  override readonly name = 'OrderOutcomeUnresolved';
  constructor() {
    super('the provider order outcome is not resolved yet');
  }
}

const CreateOrder = z.strictObject({ intent_id: z.uuid() });
const ApplyEvent = z.strictObject({ event_id: z.uuid() });
const MandateId = z.strictObject({ mandate_id: z.uuid() });

const PURPOSES: readonly PaymentPurpose[] = [
  'installment',
  'overdue',
  'part_prepayment',
  'foreclosure',
  'cooling_off_exit',
  'charges',
];

const DAY_MS = 86_400_000;
/** A link is a bearer secret: it is never kept longer than this, whatever the provider says. Below the database limit of 31 days. */
const MAX_LINK_LIFE_MS = 30 * DAY_MS;
/** When neither the provider nor the intent names an expiry, a payment link is kept this long, and a mandate link this long. */
const PAYMENT_LINK_FALLBACK_MS = 60 * 60 * 1000;
const MANDATE_LINK_FALLBACK_MS = DAY_MS;
/** A link that expires within this long is not worth keeping. */
const MIN_LINK_LIFE_MS = 5_000;
const DEFAULT_PROVIDER_TIMEOUT_MS = 15_000;

const stdoutLogger: WorkerLogger = (() => {
  const out = (level: string) => (fields: Record<string, unknown>, message: string) => {
    process.stdout.write(
      `${JSON.stringify({ level, time: new Date().toISOString(), msg: message, ...fields })}\n`,
    );
  };
  return { info: out('info'), warn: out('warn'), error: out('error') };
})();

function toResolverRow(config: PaymentConfigRecord): PaymentConfigRow {
  return {
    configId: config.configId,
    lenderOrgId: config.lenderOrgId,
    provider: config.provider,
    providerMode: config.providerMode,
    merchantRef: config.merchantRef,
    secretRef: config.secretRef,
    webhookSecretRef: config.webhookSecretRef,
  };
}

/** A timestamp the provider sent, as UTC ISO-8601; null when it sent none or one that cannot be read. */
function isoOrNull(value: string | null): string | null {
  if (value === null) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

/**
 * The expiry recorded for an order and the one a stored link keeps. The payment period belongs to the intent (the lender's link
 * validity, or a foreclosure quotation's remaining validity, whichever is sooner) and was sent to the provider as the wanted
 * expiry. The provider may only SHORTEN it: a provider that ignores the request and answers with its own default (days) must not
 * leave a checkout payable after the lender's period or the quotation ended. When the provider names none, the database keeps the
 * intent's (`record` null). Without an intent expiry the provider's is used, never beyond the longest a link may live. A past
 * time is passed on and refused by the database.
 */
export function orderExpiry(
  now: Date,
  providerExpiresAt: string | null,
  intentExpiresAt: string | null,
): {
  readonly record: string | null;
  readonly keep: string | null;
  readonly providerLater: boolean;
} {
  const provider = isoOrNull(providerExpiresAt);
  const intent = isoOrNull(intentExpiresAt);
  if (provider === null) return { record: null, keep: intent, providerLater: false };
  if (intent !== null) {
    return Date.parse(provider) > Date.parse(intent)
      ? { record: intent, keep: intent, providerLater: true }
      : { record: provider, keep: provider, providerLater: false };
  }
  const limit = now.getTime() + MAX_LINK_LIFE_MS;
  const capped = Date.parse(provider) > limit ? new Date(limit).toISOString() : provider;
  return { record: capped, keep: capped, providerLater: false };
}

/** When a stored link stops being served: the provider's expiry, else the fallback; undefined when that is already (almost) over. */
function linkExpiry(now: Date, expiresAt: string | null, fallbackMs: number): string | undefined {
  const base = now.getTime();
  const wanted = expiresAt === null ? base + fallbackMs : Date.parse(expiresAt);
  const time = Math.min(Number.isNaN(wanted) ? base + fallbackMs : wanted, base + MAX_LINK_LIFE_MS);
  return time - base < MIN_LINK_LIFE_MS ? undefined : new Date(time).toISOString();
}

/**
 * Outbox handlers for payments and mandates: `payment.create_order`, `payment.apply_event`, `mandate.handoff`, `mandate.cancel`.
 *
 * Every payload is ids only. Delivery is at least once, so every handler can run twice: a repeat finds the intent or mandate
 * already moved on and does nothing, or meets the provider's own idempotency (the operation key is the intent or mandate id).
 * The provider is called between database calls, never inside a transaction. A provider's success is never trusted for what it
 * cannot prove: an order is not a payment and a hand-off is not a mandate; only verified events and authenticated lookups move
 * money state, and they do so inside the database. Nothing here computes an amount, a stage or an eligibility.
 *
 * The log carries ids and closed words. Never a link, a reference of the provider, a merchant, a secret or any personal value.
 */
export function createPaymentsHandlers(
  deps: PaymentsHandlerDeps,
): Record<string, HandlerDefinition> {
  const processor = deps.processor ?? createPaymentsProcessor(deps.pool);
  const log = deps.log ?? stdoutLogger;
  const now = deps.now ?? (() => new Date());
  const timeoutMs = deps.providerTimeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;

  /** Seals the link and hands it to the vault. A failure here never changes what was recorded: the order or mandate stands without a link. */
  async function keepLink(
    kind: HandoffKind,
    subject: { readonly id: string; readonly lenderOrgId: string },
    link: string | null,
    expiresAt: string | null,
    fallbackMs: number,
    fields: Record<string, unknown>,
  ): Promise<void> {
    const what = kind === 'mandate' ? 'authorisation' : 'payment';
    if (deps.keyring === undefined) {
      log.info(fields, `no ${what} hand-off link kept: no encryption key is configured`);
      return;
    }
    if (link === null) {
      log.info(fields, `no ${what} hand-off link kept: the provider returned none`);
      return;
    }
    const keepUntil = linkExpiry(now(), expiresAt, fallbackMs);
    if (keepUntil === undefined) {
      log.info(fields, `no ${what} hand-off link kept: it has already expired`);
      return;
    }
    let sealed: { keyVersion: string; ciphertext: Buffer };
    try {
      sealed = sealHandoffLink(
        deps.keyring,
        { kind, subjectId: subject.id, lenderOrgId: subject.lenderOrgId },
        link,
      );
    } catch (error) {
      // The closed reason only: the error never carries the link, but the log should not depend on that.
      const reason = error instanceof HandoffVaultError ? error.reason : 'unexpected';
      log.warn({ ...fields, reason }, `no ${what} hand-off link kept: it could not be sealed`);
      return;
    }
    try {
      await processor.storeHandoffLink({
        kind,
        subjectId: subject.id,
        keyVersion: sealed.keyVersion,
        ciphertext: sealed.ciphertext,
        expiresAt: keepUntil,
      });
      log.info(fields, `${what} hand-off link sealed and kept`);
    } catch (error) {
      const failure = databaseFailureOf(error);
      log.warn(
        { ...fields, sqlstate: failure.code, hint: failure.hint },
        `${what} hand-off link not stored; the borrower is told no link is available`,
      );
    }
  }

  // -------------------------------------------------------------------------------------------------------
  // payment.create_order
  // -------------------------------------------------------------------------------------------------------
  async function createOrder(intentId: string, event: OutboxEvent): Promise<void> {
    const intent = await processor.loadIntent(intentId);
    if (!intent) throw new PermanentError('intent_not_found');
    const fields = { outboxEventId: event.id, intentId };
    if (intent.status !== 'created') {
      // Cancelled, expired, failed, already pending or paid: a repeated delivery, or the borrower moved first.
      log.info(
        { ...fields, intentStatus: intent.status },
        'payment order not created: the intent is not waiting for an order',
      );
      return;
    }
    if (intent.linkExpiresAt !== null && Date.parse(intent.linkExpiresAt) <= now().getTime()) {
      // The worker was down for longer than the whole payment period. No order is made for a link that is already over; the
      // expiry sweep (payments.expire_stale_intents) closes the intent as expired, which is the honest word for it.
      log.info(
        fields,
        'payment order not created: the payment period has already ended; the expiry sweep closes the intent',
      );
      return;
    }

    const failIntent = async (reason: OrderFailureClass, why: string): Promise<void> => {
      try {
        await processor.recordOrderFailed(intent.id, reason);
        log.warn({ ...fields, reason, why }, 'payment order failed');
      } catch (error) {
        const failure = databaseFailureOf(error);
        if (failure.code === 'P0002') throw new PermanentError('intent_not_found');
        if (failure.hint === 'intent_state_invalid') {
          log.info(fields, 'payment intent changed before its failure was recorded');
          return;
        }
        throw error;
      }
    };

    const config = intent.config;
    if (config === undefined) return failIntent('provider_unavailable', 'no_configuration');
    // A suspended or retired configuration takes no new orders (the kill switch). Nothing is sent to the provider.
    if (config.status !== 'active')
      return failIntent('provider_unavailable', 'configuration_not_active');
    const resolved = deps.providers.payment(toResolverRow(config));
    if (!resolved.ok) return failIntent('provider_unavailable', resolved.reason);
    const purpose = PURPOSES.find((candidate) => candidate === intent.purpose);
    if (purpose === undefined) return failIntent('invalid_request', 'purpose_unknown');

    const port = withPaymentTimeout(resolved.value.port, timeoutMs);
    const ctx = resolved.value.contextFor(event.correlation_id ?? event.id, intent.id);

    /** Binds the provider's answer back to the configuration, records the order and keeps the link. */
    const recordOrder = async (
      orderRef: string,
      reportedMerchant: string | null,
      expiresAt: string | null,
      created: CreatedOrder | undefined,
    ): Promise<void> => {
      // The provider must say the order belongs to the lender's configured merchant. A different merchant, or none stated, is
      // not accepted: the intent fails, the configuration is suspended and a critical exception opens (all in the database).
      if (reportedMerchant !== config.merchantRef) {
        return failIntent(
          'merchant_mismatch',
          reportedMerchant === null ? 'merchant_not_reported' : 'merchant_differs',
        );
      }
      const expiry = orderExpiry(now(), expiresAt, intent.linkExpiresAt);
      if (expiry.providerLater) {
        log.info(
          { ...fields, why: 'provider_expiry_later_than_requested' },
          'the provider order expires later than the payment period; the payment period is kept',
        );
      }
      let recorded: string;
      try {
        recorded = await processor.recordOrderCreated(intent.id, orderRef, expiry.record);
      } catch (error) {
        const failure = databaseFailureOf(error);
        if (failure.code === 'P0002') throw new PermanentError('intent_not_found');
        if (failure.hint === 'order_ref_invalid' || failure.hint === 'link_expiry_invalid') {
          return failIntent('provider_unavailable', failure.hint);
        }
        if (failure.hint === 'intent_state_invalid') {
          log.info(
            fields,
            'payment intent changed while its order was being created; the order is left unused',
          );
          return;
        }
        throw error;
      }
      if (recorded !== 'pending') {
        // The database keeps the order reference of an intent that closed while the provider call ran (the borrower cancelled it, or it
        // failed or expired) and answers with the closed status instead of an error; it never reopens the intent, and a platform
        // exception names the order. The same answer comes for a repeat of this job after the payment moved on. No link is kept for a
        // payment nobody can open. There is no port to void an order at the provider, so the order is left there: money paid on it
        // is found by its reference and raises payment_on_closed_intent.
        log.warn(
          { ...fields, intentStatus: recorded, why: 'intent_not_pending' },
          'payment order recorded but the intent is no longer pending; no hand-off link is kept and the order is left at the provider',
        );
        return;
      }
      if (created === undefined) {
        log.info(
          fields,
          'payment order recorded from a status lookup; no hand-off link is available for it',
        );
        return;
      }
      await keepLink(
        'payment_intent',
        { id: intent.id, lenderOrgId: intent.lenderOrgId },
        created.checkoutLink,
        expiry.keep,
        PAYMENT_LINK_FALLBACK_MS,
        fields,
      );
    };

    const request: CreateOrderRequest = {
      operationKey: intent.id,
      receiptRef: intent.id,
      merchantRef: config.merchantRef,
      amountMinor: intent.amountMinor,
      currency: 'INR',
      purpose,
      expiresAt: intent.linkExpiresAt,
    };
    const result = await port.createOrder(ctx, request);
    switch (result.outcome) {
      case 'ok':
        return recordOrder(
          result.value.orderRef,
          result.value.merchantRef,
          result.value.expiresAt,
          result.value,
        );
      case 'rejected':
        return failIntent(
          result.reason === 'invalid_request' ? 'invalid_request' : 'provider_rejected',
          result.reason,
        );
      case 'unsupported':
      case 'not_configured':
        return failIntent('provider_unavailable', result.outcome);
      case 'unknown':
      case 'not_found':
        return resolveUnknownOrder(port, ctx, event, intent.id, recordOrder, failIntent, fields);
    }
  }

  /**
   * The create call may or may not have created the order (timeout, network, 5xx). It is NOT created again blindly: the order is
   * looked up by the operation key. Found: it is recorded (no link is available then). Not found or still unclear: the outbox
   * retries with its backoff, and the create call repeats under the SAME operation key, which the provider treats as the same
   * order. After the last attempt the intent is failed as `provider_unavailable`.
   */
  async function resolveUnknownOrder(
    port: PaymentProviderPort,
    ctx: ProviderCallContext,
    event: OutboxEvent,
    intentId: string,
    recordOrder: (
      orderRef: string,
      reportedMerchant: string | null,
      expiresAt: string | null,
      created: CreatedOrder | undefined,
    ) => Promise<void>,
    failIntent: (reason: OrderFailureClass, why: string) => Promise<void>,
    fields: Record<string, unknown>,
  ): Promise<void> {
    log.warn(fields, 'payment order outcome unknown; looking the order up before any retry');
    const lookup = await port.getOrderStatus(ctx, { orderRef: null, operationKey: intentId });
    if (lookup.outcome === 'ok') {
      return recordOrder(lookup.value.orderRef, lookup.value.merchantRef, null, undefined);
    }
    if (event.attempts >= event.max_attempts) {
      return failIntent('provider_unavailable', 'outcome_unresolved');
    }
    throw new OrderOutcomeUnresolvedError();
  }

  // -------------------------------------------------------------------------------------------------------
  // payment.apply_event
  // -------------------------------------------------------------------------------------------------------
  async function applyEvent(providerEventId: string, event: OutboxEvent): Promise<void> {
    try {
      const result = await processor.applyProviderEvent(providerEventId);
      // Every outcome the database names is a normal result: applied, already_applied, ignored_stale, deferred, exception ...
      log.info(
        {
          outboxEventId: event.id,
          providerEventId,
          outcome: result.outcome,
          ...(result.reason === undefined ? {} : { reason: result.reason }),
        },
        'provider event processed',
      );
    } catch (error) {
      if (databaseFailureOf(error).code === 'P0002') throw new PermanentError('event_not_found');
      throw error;
    }
  }

  // -------------------------------------------------------------------------------------------------------
  // mandate.handoff
  // -------------------------------------------------------------------------------------------------------
  async function handOffMandate(mandateId: string, event: OutboxEvent): Promise<void> {
    const mandate = await processor.loadMandate(mandateId);
    if (!mandate) throw new PermanentError('mandate_not_found');
    const fields = { outboxEventId: event.id, mandateId };
    if (mandate.status !== 'draft') {
      log.info(
        { ...fields, mandateStatus: mandate.status },
        'mandate hand-off not requested: the mandate is no longer a draft',
      );
      return;
    }
    if (mandate.cancelRequested) {
      // The borrower withdrew before the provider saw anything. Nothing is sent; the sweep closes the draft.
      log.info(fields, 'mandate hand-off not requested: the borrower asked to cancel the draft');
      return;
    }

    const record = async (
      outcome: MandateHandoffOutcome,
      providerMandateRef: string | null,
      expiresAt: string | null,
    ): Promise<string> => {
      try {
        return await processor.recordMandateHandoff(
          mandate.id,
          outcome,
          providerMandateRef,
          expiresAt,
        );
      } catch (error) {
        if (databaseFailureOf(error).code === 'P0002')
          throw new PermanentError('mandate_not_found');
        throw error;
      }
    };
    /**
     * A hand-off that did not happen. Nothing reached any provider ('not_sent': no configuration, an inactive one, no provider here, a
     * rail the provider cannot carry), so nothing is unknown and nothing was refused; only a provider's own refusal is 'rejected'.
     */
    const refuse = async (
      why: string,
      outcome: 'not_sent' | 'rejected' = 'not_sent',
    ): Promise<void> => {
      const status = await record(outcome, null, null);
      log.warn({ ...fields, why, mandateStatus: status }, 'mandate hand-off not possible');
    };

    const config = mandate.config;
    if (config === undefined) return refuse('no_configuration');
    if (config.status !== 'active') return refuse('configuration_not_active');
    const resolved = deps.providers.mandate(toResolverRow(config));
    if (!resolved.ok) return refuse(resolved.reason);

    const port = withMandateTimeout(resolved.value.port, timeoutMs);
    const ctx = resolved.value.contextFor(event.correlation_id ?? event.id, mandate.id);
    const request: MandateRequest = {
      operationKey: mandate.id,
      rail: mandate.rail,
      merchantRef: mandate.creditorRef,
      maxAmountMinor: mandate.maxAmountMinor,
      currency: 'INR',
      startDate: mandate.startDate,
      endDate: mandate.endDate,
      maskedAccountRef: mandate.maskedAccountRef,
    };
    const result = await port.createMandateRequest(ctx, request);
    switch (result.outcome) {
      case 'ok': {
        const handOff = result.value;
        const expiresAt = isoOrNull(handOff.expiresAt);
        let status: string;
        try {
          status = await processor.recordMandateHandoff(
            mandate.id,
            'handoff',
            handOff.providerMandateRef,
            expiresAt,
          );
        } catch (error) {
          const failure = databaseFailureOf(error);
          if (failure.code === 'P0002') throw new PermanentError('mandate_not_found');
          if (failure.hint === 'bad_request') {
            // The provider answered with a reference we cannot store, so no later event could ever be matched to this mandate.
            // It may have registered something: park it for reconciliation, never retry without a lookup.
            const parked = await record('unknown', null, null);
            log.warn(
              { ...fields, mandateStatus: parked },
              'mandate hand-off answered with an unusable reference; parked for reconciliation',
            );
            return;
          }
          throw error;
        }
        if (status !== 'registration_pending') {
          log.info(
            { ...fields, mandateStatus: status },
            'mandate hand-off recorded; the mandate had already moved on, no link kept',
          );
          return;
        }
        // The borrower may have asked to cancel while the provider call was in flight: the cancellation that was queued then
        // found no provider reference (the draft had none yet) and the link below would let the borrower authorise a mandate
        // they asked to cancel. No link is kept, and the cancellation is queued again now that the reference exists.
        const afterHandOff = await processor.loadMandate(mandate.id);
        if (afterHandOff?.cancelRequested === true && !afterHandOff.cancelSent) {
          await processor.enqueueMandateCancel(mandate.id);
          log.info(
            { ...fields, why: 'cancel_requested_during_handoff' },
            'mandate hand-off recorded, but a cancellation was requested while it was made; no link is kept and the cancellation is queued',
          );
          return;
        }
        log.info(
          fields,
          'mandate hand-off recorded; the mandate waits for the borrower, nothing is active',
        );
        await keepLink(
          'mandate',
          { id: mandate.id, lenderOrgId: mandate.lenderOrgId },
          handOff.handOffLink,
          expiresAt,
          MANDATE_LINK_FALLBACK_MS,
          fields,
        );
        return;
      }
      case 'rejected':
        return refuse(result.reason, 'rejected');
      case 'unsupported':
      case 'not_configured':
        return refuse(result.outcome);
      case 'unknown':
      case 'not_found': {
        const status = await record('unknown', null, null);
        log.warn(
          { ...fields, mandateStatus: status },
          'mandate hand-off outcome unknown; parked for reconciliation, no retry without a lookup',
        );
        return;
      }
    }
  }

  // -------------------------------------------------------------------------------------------------------
  // mandate.cancel
  // -------------------------------------------------------------------------------------------------------
  /**
   * A cancellation the provider did not acknowledge must not be dropped: the mandate would stay live at the bank after the borrower
   * withdrew consent (or the loan closed), and nothing else re-sends the request. The event is retried by the outbox with the same
   * operation key (the provider treats a repeat as the same request) until the provider acknowledges it. After the last attempt it
   * is dead, which is loud (an error line here, the worker's own "outbox event is dead" and the event row with its closed code),
   * never silent; an operator then cancels the mandate at the provider.
   */
  function notDelivered(
    event: OutboxEvent,
    fields: Record<string, unknown>,
    why: string,
    extra: Record<string, unknown> = {},
  ): never {
    if (event.attempts >= event.max_attempts) {
      log.error(
        { ...fields, ...extra, why, attempt: event.attempts },
        'mandate cancellation could not be delivered after the last attempt; the mandate may still be live at the provider and an operator must cancel it there',
      );
    } else {
      log.warn(
        { ...fields, ...extra, why, attempt: event.attempts },
        'mandate cancellation not delivered yet; the outbox retries it with the same operation key',
      );
    }
    throw new RetryableError('mandate_cancel_not_delivered');
  }

  async function cancelMandate(mandateId: string, event: OutboxEvent): Promise<void> {
    const mandate = await processor.loadMandate(mandateId);
    if (!mandate) throw new PermanentError('mandate_not_found');
    const fields = { outboxEventId: event.id, mandateId };
    if (!mandate.cancelRequested) {
      log.info(fields, 'mandate cancellation not sent: none was requested');
      return;
    }
    if (mandate.cancelSent) {
      log.info(fields, 'mandate cancellation not sent: it was sent already');
      return;
    }
    // A cancellation asked for and not yet sent goes out whatever the status is now, once the provider has a reference: a mandate that
    // finished (rejected, expired, cancelled by the bank) while the request waited, or whose reference arrived late, may still be
    // live at the provider, and a request lowers risk. Without a reference only a live mandate is worth waiting for.
    const live = (MANDATE_LIVE_STATUSES as readonly string[]).includes(mandate.status);
    if (mandate.providerMandateRef === null && !live) {
      log.info(
        { ...fields, mandateStatus: mandate.status },
        'mandate cancellation not sent: the mandate is no longer live and the provider holds no reference to cancel',
      );
      return;
    }
    if (mandate.providerMandateRef === null) {
      // The provider has no reference to cancel yet: a draft whose hand-off is in flight, or a hand-off whose outcome is unknown
      // (requires_reconciliation). Neither is final. A draft the borrower cancelled is closed by the sweep (and then the mandate is
      // no longer live, which ends this); a hand-off that completes gives the mandate its reference; a lookup can find one. Until
      // one of those happens the request cannot be sent, so it is retried, not dropped.
      return notDelivered(event, fields, 'no_provider_reference_yet', {
        mandateStatus: mandate.status,
      });
    }
    // A cancellation lowers risk, so it is sent whatever the status of the configuration (even a suspended one).
    const config = mandate.config;
    if (config === undefined) return notDelivered(event, fields, 'no_configuration');
    const resolved = deps.providers.mandate(toResolverRow(config));
    if (!resolved.ok) return notDelivered(event, fields, resolved.reason);
    const port = withMandateTimeout(resolved.value.port, timeoutMs);
    const ctx = resolved.value.contextFor(event.correlation_id ?? event.id, mandate.id);
    const result = await port.cancelMandate(ctx, {
      providerMandateRef: mandate.providerMandateRef,
      operationKey: mandate.id,
    });
    if (result.outcome === 'rejected' || result.outcome === 'unsupported') {
      // A definite refusal: asking again cannot change it. Not retried; the event ends dead with a closed code, which is how an
      // operator sees a mandate the provider will not cancel. Nothing new is opened here.
      log.error(
        { ...fields, outcome: result.outcome },
        'mandate cancellation refused by the provider; it is not retried and an operator must cancel the mandate there',
      );
      throw new PermanentError('mandate_cancel_refused');
    }
    if (result.outcome !== 'ok') {
      // Unknown (a timeout, the network, a provider error), not found, not configured: nothing says the provider has the request.
      return notDelivered(event, fields, 'not_acknowledged', { outcome: result.outcome });
    }
    try {
      await processor.markMandateCancelSent(mandate.id);
    } catch (error) {
      if (databaseFailureOf(error).code === 'P0002') throw new PermanentError('mandate_not_found');
      throw error;
    }
    // Acknowledged is not cancelled: the mandate changes only on a verified event or a lookup.
    log.info(
      fields,
      'mandate cancellation sent and acknowledged; the mandate is cancelled only when the provider confirms',
    );
  }

  return {
    'payment.create_order': {
      schema: CreateOrder,
      run: async (payload, event) => {
        await createOrder(CreateOrder.parse(payload).intent_id, event);
      },
    },
    'payment.apply_event': {
      schema: ApplyEvent,
      run: async (payload, event) => {
        await applyEvent(ApplyEvent.parse(payload).event_id, event);
      },
    },
    'mandate.handoff': {
      schema: MandateId,
      run: async (payload, event) => {
        await handOffMandate(MandateId.parse(payload).mandate_id, event);
      },
    },
    'mandate.cancel': {
      schema: MandateId,
      run: async (payload, event) => {
        await cancelMandate(MandateId.parse(payload).mandate_id, event);
      },
    },
  };
}
