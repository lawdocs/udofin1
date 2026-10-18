import {
  PAYMENT_SUCCESS_STATUSES,
  type AppEnvironment,
  type ChannelSendResult,
  type MandateProviderPort,
  type PaymentProviderPort,
  type SettlementReport,
} from '@udofin/adapters';
import {
  createJobsStore,
  type ClaimedReminder,
  type ExpiryCandidate,
  type JobsStore,
  type NoticeState,
  type PaymentConfigFacts,
  type ReminderErrorClass,
  type ReminderSendState,
  type SettlementBatchJson,
} from '../system/jobs.js';
import { type SystemPool } from '../system/pool.js';
import { type WorkerLogger } from './outbox-worker.js';
import {
  type PaymentConfigRow,
  type ProviderResolver,
  type Resolved,
  type ResolvedPort,
} from './provider-resolver.js';
import {
  createServiceChannels,
  type ChannelMessage,
  type ServiceChannels,
} from './reminder-channels.js';

export interface PeriodicJobDeps {
  readonly pool: SystemPool;
  readonly providers: ProviderResolver;
  readonly environment: AppEnvironment;
  readonly log: WorkerLogger;
}

/**
 * The scheduled work of Phase 08a: reminders (plan, claim, send), mandate sweeps and debit planning and pre-debit notices,
 * order and mandate lookups, expiry of stale payments, the daily reconciliation run, revalidation of payment configurations and
 * the purge of expired hand-off links.
 *
 * Rules every job follows:
 *   - idempotent (the database functions are; a job that runs twice does nothing the second time);
 *   - one run of a job at a time in this process (an in-flight guard; a tick that finds its job still running is skipped);
 *   - an error stops that step and is logged by class only (never a row value, a message or a reference), and never stops the loop;
 *   - no rule is decided here: the database functions plan, claim, apply and reconcile; this file schedules them, calls the
 *     provider ports in between (outside any database transaction) and passes the answers back;
 *   - a provider is called only through the resolver. A lender the resolver cannot serve (not configured, mock refused here,
 *     secret missing) is skipped and only the reason class is logged. A lender whose switch is off is excluded in SQL.
 * Returns a stop function (a job that is already running finishes its current item and then stops).
 */
export function startPeriodicJobs(deps: PeriodicJobDeps): { stop(): void } {
  const jobs = createPeriodicJobs(deps);
  jobs.start();
  return { stop: () => jobs.stop() };
}

// ---------------------------------------------------------------------------------------------------------------------
// Named constants: how often, how many, how long
// ---------------------------------------------------------------------------------------------------------------------
const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;

export const REMINDERS_INTERVAL_MS = MINUTE_MS;
export const PAYMENTS_UPKEEP_INTERVAL_MS = 5 * MINUTE_MS;
export const SERVICING_UPKEEP_INTERVAL_MS = 5 * MINUTE_MS;
export const MANDATES_INTERVAL_MS = 5 * MINUTE_MS;
export const HANDOFF_PURGE_INTERVAL_MS = 5 * MINUTE_MS;
export const CONFIG_REVALIDATION_INTERVAL_MS = HOUR_MS;
/** How often the reconciliation job looks at the clock; it does its work once per IST day (see RECONCILIATION_FROM_IST_MINUTE). */
export const RECONCILIATION_CHECK_INTERVAL_MS = 15 * MINUTE_MS;
/** The first run of each job comes this long after start-up, one more second for each job, so they do not all start at once. */
const FIRST_RUN_DELAY_MS = 5 * SECOND_MS;

/** Reminders claimed per call, and calls per run (a run that claims a full batch asks again, up to this many times). */
const REMINDER_CLAIM_BATCH = 100;
const CLAIM_BATCHES_PER_RUN = 10;

/** The grace the database function uses by default: an intent is a candidate this long after its link expired. */
export const INTENT_EXPIRY_GRACE_SECONDS = 15 * 60;
const INTENT_LOOKUPS_PER_RUN = 200;
/** An intent the worker could not clear is held back from expiry this long after its link expired; then the database rules take over. */
export const INTENT_HOLD_LIMIT_SECONDS = 24 * 60 * 60;
/** After this many failed answers from one provider in a run, the rest of its lookups wait for the next run. */
const PROVIDER_FAILURES_BEFORE_SKIP = 3;

/**
 * Provider calls one run of the mandates job may make for status lookups, and for debit reports. A longer list is not dropped:
 * the next run starts with the mandates that were looked at least recently, so every mandate is reached in turn.
 */
export const MANDATE_LOOKUPS_PER_RUN = 200;
export const DEBIT_LOOKUPS_PER_RUN = 200;
/**
 * How long each polling step of one run may keep calling the provider (calls are made one after another, and a provider that answers
 * in a few hundred milliseconds would otherwise take longer than the five minutes between runs for a few thousand mandates). Two
 * steps of two minutes leave the rest of the interval for the database work.
 */
export const MANDATE_POLLING_BUDGET_MS = 2 * MINUTE_MS;
/** The window of debit reports asked of the provider: this many days back and ahead of today (IST). */
export const DEBIT_LOOKBACK_DAYS = 7;
export const DEBIT_LOOKAHEAD_DAYS = 3;
const NOTICE_CLAIM_BATCH = 100;

/** Reconciliation runs once per IST calendar day, from 20:00 IST (after the provider cut-off the spec assumes). */
export const RECONCILIATION_FROM_IST_MINUTE = 20 * 60;

// ---------------------------------------------------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------------------------------------------------
export type JobName =
  | 'reminders'
  | 'payments_upkeep'
  | 'servicing_upkeep'
  | 'mandates'
  | 'handoff_links'
  | 'payment_configs'
  | 'reconciliation';

export interface Scheduler {
  /** Runs `task` every `intervalMs`, the first time after `firstDelayMs`. Returns a function that cancels it. */
  every(intervalMs: number, task: () => void, firstDelayMs: number): () => void;
}

const timerScheduler: Scheduler = {
  every(intervalMs, task, firstDelayMs) {
    let interval: ReturnType<typeof setInterval> | undefined;
    const first = setTimeout(() => {
      task();
      interval = setInterval(task, intervalMs);
      interval.unref();
    }, firstDelayMs);
    first.unref();
    return () => {
      clearTimeout(first);
      if (interval) clearInterval(interval);
    };
  },
};

export interface PeriodicJobOptions {
  readonly scheduler?: Scheduler;
  /** The clock for "which IST day is it". Defaults to the system clock. */
  readonly clock?: () => Date;
  /** Replaces the database wrappers (tests). */
  readonly store?: JobsStore;
  /** Replaces the notification channels (tests). */
  readonly channels?: ServiceChannels;
  /**
   * Open document requests older than this many days are expired. There is no approved age (the database takes the cutoff from
   * the caller and hard-codes none), so by default this step does not run.
   */
  readonly documentRequestExpiryDays?: number;
}

export interface PeriodicJobs {
  readonly names: readonly JobName[];
  start(): void;
  stop(): void;
  /** Runs one job now unless it is already running. */
  run(name: JobName): Promise<'ran' | 'skipped'>;
}

/** Logging fields for an error: the class name and, for a database error, the five-character SQLSTATE. Never the message. */
export function errorFields(error: unknown): Record<string, string> {
  const fields: Record<string, string> = {
    errorClass: error instanceof Error ? error.name : 'unknown',
  };
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) fields['sqlstate'] = code;
  return fields;
}

export function createPeriodicJobs(
  deps: PeriodicJobDeps,
  options: PeriodicJobOptions = {},
): PeriodicJobs {
  const { log } = deps;
  const store = options.store ?? createJobsStore(deps.pool);
  const channels = options.channels ?? createServiceChannels({ environment: deps.environment });
  const scheduler = options.scheduler ?? timerScheduler;
  const clock = options.clock ?? (() => new Date());
  let stopping = false;

  /** Runs one step of a job. A failure is logged by class and ends the step only. */
  const step = async (job: JobName, name: string, work: () => Promise<void>): Promise<void> => {
    if (stopping) return;
    try {
      await work();
    } catch (error) {
      log.warn({ job, step: name, ...errorFields(error) }, 'periodic job step failed');
    }
  };

  // -- Provider ports, resolved once per configuration per run -----------------------------------------------------------
  const configRowOf = (facts: PaymentConfigFacts): PaymentConfigRow => ({
    configId: facts.configId,
    lenderOrgId: facts.lenderOrgId,
    provider: facts.provider,
    providerMode: facts.providerMode === 'production' ? 'live' : facts.providerMode,
    merchantRef: facts.merchantRef,
    secretRef: facts.secretRef,
    webhookSecretRef: facts.webhookSecretRef,
  });
  type PortFailure = { readonly ok: false; readonly reason: string };
  type PortLookup<P> = Resolved<ResolvedPort<P>> | PortFailure;
  const portCache = <P>(resolve: (row: PaymentConfigRow) => Resolved<ResolvedPort<P>>) => {
    const cache = new Map<string, PortLookup<P>>();
    return async (configId: string): Promise<PortLookup<P>> => {
      const known = cache.get(configId);
      if (known) return known;
      const facts = await store.paymentConfig(configId);
      const answer: PortLookup<P> = facts
        ? resolve(configRowOf(facts))
        : { ok: false, reason: 'config_missing' };
      cache.set(configId, answer);
      return answer;
    };
  };
  const paymentPorts = () => portCache<PaymentProviderPort>((row) => deps.providers.payment(row));
  const mandatePorts = () => portCache<MandateProviderPort>((row) => deps.providers.mandate(row));

  // -- Reminders -----------------------------------------------------------------------------------------------------------
  const remindersJob = async (): Promise<void> => {
    let planned = 0;
    await step('reminders', 'plan', async () => {
      planned = await store.planReminders();
    });
    const tally = { claimed: 0, accepted: 0, not_configured: 0, failed: 0, unrecorded: 0 };
    await step('reminders', 'claim_and_send', async () => {
      for (let batch = 0; batch < CLAIM_BATCHES_PER_RUN && !stopping; batch += 1) {
        const claimed = await store.claimDueReminders(REMINDER_CLAIM_BATCH);
        tally.claimed += claimed.length;
        for (const reminder of claimed) {
          if (stopping) break;
          try {
            const state = await deliverReminder(reminder);
            tally[state] += 1;
          } catch (error) {
            // Not recorded: the claim lapses and the message is claimed again (at most three attempts in all).
            tally.unrecorded += 1;
            log.warn(
              { job: 'reminders', ...errorFields(error) },
              'reminder attempt was not recorded',
            );
          }
        }
        if (claimed.length < REMINDER_CLAIM_BATCH) break;
      }
    });
    if (planned > 0 || tally.claimed > 0)
      log.info({ job: 'reminders', planned, ...tally }, 'reminders processed');
  };

  const deliverReminder = async (reminder: ClaimedReminder): Promise<ReminderSendState> => {
    const result = await sendOnChannel(channels, reminder.channel, {
      id: reminder.reminderId,
      recipientRef: reminder.borrowerId,
      titleKey: 'reminder',
    });
    const record = reminderRecordOf(result);
    await store.recordReminderAttempt(
      reminder.reminderId,
      record.state,
      record.providerRef,
      record.errorClass,
    );
    return record.state;
  };

  // -- Payments upkeep: look the order up, then expire the intents that are safe to expire ----------------------------------
  const paymentsUpkeepJob = async (): Promise<void> => {
    await step('payments_upkeep', 'expire_stale_intents', expireStaleIntentsStep);
  };

  const expireStaleIntentsStep = async (): Promise<void> => {
    const { cutoff, candidates } = await store.expiryCandidates(
      INTENT_EXPIRY_GRACE_SECONDS,
      INTENT_LOOKUPS_PER_RUN,
    );
    const payments = paymentPorts();
    const failures = new Map<string, number>();
    const tally = { examined: 0, safe: 0, held: 0, exceptions: 0 };
    const reasons: Record<string, number> = {};
    let oldestHeld: string | undefined;
    for (const candidate of candidates) {
      if (stopping) return; // nothing is expired on a half-finished pass
      tally.examined += 1;
      const verdict = await examineIntent(candidate, payments, failures);
      if (verdict.kind === 'safe') {
        tally.safe += 1;
        continue;
      }
      reasons[verdict.reason] = (reasons[verdict.reason] ?? 0) + 1;
      // Not safe: the intent is held back from expiry until the hold ends. Evidence (the provider reports money, or something
      // that contradicts what we hold) is told to a person at once. When nothing could be established, a person is told when
      // the hold ends, because from then on the database expires the intent without an answer. An intent that should have
      // been flagged and could not be is not let go.
      const holdEnded = candidate.ageSeconds >= INTENT_HOLD_LIMIT_SECONDS;
      let flagged = true;
      if (verdict.kind === 'evidence' || holdEnded) {
        try {
          await store.raiseException({
            lenderOrgId: candidate.lenderOrgId,
            class: 'webhook_gap',
            severity: 'warning',
            owner: 'platform',
            subject: { intent_id: candidate.intentId },
          });
          tally.exceptions += 1;
        } catch (error) {
          flagged = false;
          log.warn(
            { job: 'payments_upkeep', ...errorFields(error) },
            'could not open an exception',
          );
        }
      }
      if (!holdEnded || !flagged) {
        tally.held += 1;
        oldestHeld ??= candidate.linkExpiresAt;
      }
    }
    // The candidates come oldest first. A full list may have been cut short: the newer intents were not looked at.
    const last = candidates[candidates.length - 1];
    const truncatedAt =
      candidates.length >= INTENT_LOOKUPS_PER_RUN && last ? last.linkExpiresAt : undefined;
    const expired = await store.expireStaleIntents({ cutoff, truncatedAt, oldestHeld });
    if (expired === undefined) {
      log.warn(
        { job: 'payments_upkeep' },
        'nothing expired: the oldest held intent is too old to be left out',
      );
    }
    if (tally.examined > 0 || (expired ?? 0) > 0) {
      log.info(
        { job: 'payments_upkeep', ...tally, reasons, expired: expired ?? 0 },
        'stale payments processed',
      );
    }
  };

  type IntentVerdict =
    | { readonly kind: 'safe' }
    | { readonly kind: 'evidence'; readonly reason: string }
    | { readonly kind: 'undetermined'; readonly reason: string };

  const examineIntent = async (
    candidate: ExpiryCandidate,
    payments: (configId: string) => Promise<PortLookup<PaymentProviderPort>>,
    failures: Map<string, number>,
  ): Promise<IntentVerdict> => {
    const configId = candidate.configId;
    if (configId === undefined) return { kind: 'undetermined', reason: 'no_config' };
    const resolved = await payments(configId);
    if (!resolved.ok) return { kind: 'undetermined', reason: `resolver_${resolved.reason}` };
    const { port } = resolved.value;
    if (!port.capabilities.statusLookup)
      return { kind: 'undetermined', reason: 'lookup_unsupported' };
    if ((failures.get(configId) ?? 0) >= PROVIDER_FAILURES_BEFORE_SKIP) {
      return { kind: 'undetermined', reason: 'provider_skipped' };
    }
    const failed = (): void => {
      failures.set(configId, (failures.get(configId) ?? 0) + 1);
    };
    let answer: Awaited<ReturnType<PaymentProviderPort['getOrderStatus']>>;
    try {
      answer = await port.getOrderStatus(resolved.value.contextFor(candidate.intentId), {
        orderRef: candidate.providerOrderRef ?? null,
        operationKey: candidate.intentId,
      });
    } catch {
      failed();
      return { kind: 'undetermined', reason: 'provider_error' };
    }
    switch (answer.outcome) {
      case 'ok': {
        const status = answer.value.status;
        if (PAYMENT_SUCCESS_STATUSES.some((s) => s === status)) {
          return { kind: 'evidence', reason: 'provider_reports_success' };
        }
        // Nothing was paid on this order: no attempt was made, or it ended without money.
        if (
          status === 'created' ||
          status === 'failed' ||
          status === 'cancelled' ||
          status === 'expired'
        ) {
          return { kind: 'safe' };
        }
        return { kind: 'evidence', reason: 'provider_status_not_final' };
      }
      case 'not_found':
        // A created intent has no order at the provider if the provider has never heard of it. A pending intent has one on
        // record, so "unknown order" contradicts what we hold.
        return candidate.providerOrderRef === undefined
          ? { kind: 'safe' }
          : { kind: 'evidence', reason: 'provider_does_not_know_order' };
      case 'unknown':
        failed();
        return { kind: 'undetermined', reason: `provider_${answer.reason}` };
      case 'rejected':
        return { kind: 'undetermined', reason: 'lookup_rejected' };
      case 'unsupported':
      case 'not_configured':
        return { kind: 'undetermined', reason: 'lookup_unsupported' };
    }
  };

  // -- Servicing upkeep ------------------------------------------------------------------------------------------------------
  const servicingUpkeepJob = async (): Promise<void> => {
    await step('servicing_upkeep', 'complete_disbursements', async () => {
      const moved = await store.completeDisbursements(null);
      if (moved > 0)
        log.info({ job: 'servicing_upkeep', disbursed: moved }, 'disbursements completed');
    });
    const days = options.documentRequestExpiryDays;
    if (days !== undefined) {
      await step('servicing_upkeep', 'expire_document_requests', async () => {
        const expired = await store.expireDocumentRequests(
          new Date(clock().getTime() - days * 24 * HOUR_MS),
        );
        if (expired > 0)
          log.info({ job: 'servicing_upkeep', expired }, 'document requests expired');
      });
    }
  };

  // -- Mandates ------------------------------------------------------------------------------------------------------------
  const mandatesJob = async (): Promise<void> => {
    // The database work and the pre-debit notices come FIRST: a notice has a lead time to keep, and the provider polling below
    // calls one provider after another with no fixed duration. Polling is capped per run (see MANDATE_LOOKUPS_PER_RUN,
    // DEBIT_LOOKUPS_PER_RUN and MANDATE_POLLING_BUDGET_MS) and takes its turn from where the last run stopped.
    await step('mandates', 'sweep', async () => {
      const counts = await store.sweepMandates();
      if (Object.values(counts).some((n) => n > 0))
        log.info({ job: 'mandates', ...counts }, 'mandates swept');
    });
    await step('mandates', 'cancel_for_closed_loans', async () => {
      const requested = await store.requestCancelForClosedLoans();
      if (requested > 0)
        log.info({ job: 'mandates', requested }, 'cancellation requested for closed loans');
    });
    await step('mandates', 'plan_debits', async () => {
      const counts = await store.planMandateDebits();
      if (Object.values(counts).some((n) => n > 0))
        log.info({ job: 'mandates', ...counts }, 'debits planned');
    });
    await step('mandates', 'pre_debit_notices', preDebitNotices);
    await step('mandates', 'status_lookups', mandateLookups);
    await step('mandates', 'debit_lookups', debitLookups);
  };

  /**
   * Who was asked about last, so a capped or timed-out run continues where the previous one stopped. Kept in this process only
   * (a restart starts the rotation again, which costs nothing but order). An entry is the number of the attempt that last touched
   * the mandate; a mandate never attempted is absent and goes first.
   */
  const lastStatusLookup = new Map<string, number>();
  const lastDebitLookup = new Map<string, number>();
  let attemptNumber = 0;
  const leastRecentFirst = <T>(
    items: readonly T[],
    keyOf: (item: T) => string,
    last: ReadonlyMap<string, number>,
  ): T[] =>
    items
      .map((item, index) => ({ item, index, last: last.get(keyOf(item)) ?? 0 }))
      .sort((a, b) => a.last - b.last || a.index - b.index)
      .map((entry) => entry.item);
  /** Forgets mandates that are no longer in the list, so the memory stays as small as the list. */
  const forgetOthers = (last: Map<string, number>, live: ReadonlySet<string>): void => {
    for (const key of [...last.keys()]) if (!live.has(key)) last.delete(key);
  };
  /** A deadline for one polling step, read from the job's clock. */
  const pollingDeadline = (): (() => boolean) => {
    const until = clock().getTime() + MANDATE_POLLING_BUDGET_MS;
    return () => clock().getTime() >= until;
  };

  const mandateLookups = async (): Promise<void> => {
    const candidates = await store.mandatesNeedingLookup();
    forgetOthers(lastStatusLookup, new Set(candidates.map((candidate) => candidate.mandateId)));
    // The database lists them by when they last changed, and a mandate the provider cannot find never changes: 200 of those would
    // keep every newer one out of the slice for good. The least recently asked about go first.
    const ordered = leastRecentFirst(candidates, (c) => c.mandateId, lastStatusLookup);
    const timeIsUp = pollingDeadline();
    const ports = mandatePorts();
    const failures = new Map<string, number>();
    const tally = { looked_up: 0, applied: 0, skipped: 0, left_for_next_run: 0 };
    for (const [position, candidate] of ordered.entries()) {
      if (stopping) return;
      if (position >= MANDATE_LOOKUPS_PER_RUN || timeIsUp()) {
        tally.left_for_next_run = ordered.length - position;
        break;
      }
      lastStatusLookup.set(candidate.mandateId, (attemptNumber += 1));
      try {
        const resolved = await ports(candidate.configId);
        if (!resolved.ok) {
          tally.skipped += 1;
          log.info(
            { job: 'mandates', reason: resolved.reason },
            'mandate lookup skipped: no provider',
          );
          continue;
        }
        const { port } = resolved.value;
        if (
          !port.capabilities.statusLookup ||
          (failures.get(candidate.configId) ?? 0) >= PROVIDER_FAILURES_BEFORE_SKIP
        ) {
          tally.skipped += 1;
          continue;
        }
        tally.looked_up += 1;
        const answer = await port.getMandateStatus(resolved.value.contextFor(candidate.mandateId), {
          providerMandateRef: candidate.providerMandateRef ?? null,
          operationKey: candidate.mandateId,
        });
        if (answer.outcome === 'unknown') {
          failures.set(candidate.configId, (failures.get(candidate.configId) ?? 0) + 1);
          tally.skipped += 1;
          continue;
        }
        if (answer.outcome !== 'ok') {
          // not_found, rejected, unsupported, not_configured: nothing the database can apply. It looks again next run, and the
          // sweep opens an exception for an outcome that stays unresolved.
          tally.skipped += 1;
          continue;
        }
        await store.applyMandateLookup({
          mandateId: candidate.mandateId,
          status: answer.value.status,
          providerMandateRef: answer.value.providerMandateRef,
          observedAt: answer.value.observedAt,
        });
        tally.applied += 1;
      } catch (error) {
        tally.skipped += 1;
        log.warn({ job: 'mandates', ...errorFields(error) }, 'mandate lookup failed');
      }
    }
    if (candidates.length > 0) log.info({ job: 'mandates', ...tally }, 'mandate lookups processed');
  };

  const debitLookups = async (): Promise<void> => {
    const listed = await store.activeMandates();
    if (listed.length === 0) return;
    forgetOthers(lastDebitLookup, new Set(listed.map((mandate) => mandate.mandateId)));
    const mandates = leastRecentFirst(listed, (m) => m.mandateId, lastDebitLookup);
    const timeIsUp = pollingDeadline();
    const ports = mandatePorts();
    const failures = new Map<string, number>();
    const today = istNow(clock()).date;
    const query = {
      from: addDays(today, -DEBIT_LOOKBACK_DAYS),
      to: addDays(today, DEBIT_LOOKAHEAD_DAYS),
    };
    const tally = { mandates: 0, reports: 0, applied: 0, skipped: 0, left_for_next_run: 0 };
    for (const [position, mandate] of mandates.entries()) {
      if (stopping) return;
      if (position >= DEBIT_LOOKUPS_PER_RUN || timeIsUp()) {
        tally.left_for_next_run = mandates.length - position;
        break;
      }
      lastDebitLookup.set(mandate.mandateId, (attemptNumber += 1));
      try {
        const resolved = await ports(mandate.configId);
        if (!resolved.ok) {
          tally.skipped += 1;
          continue;
        }
        const { port } = resolved.value;
        if (
          !port.capabilities.debitStatus ||
          (failures.get(mandate.configId) ?? 0) >= PROVIDER_FAILURES_BEFORE_SKIP
        ) {
          tally.skipped += 1;
          continue;
        }
        tally.mandates += 1;
        const answer = await port.listDebitStatus(resolved.value.contextFor(mandate.mandateId), {
          providerMandateRef: mandate.providerMandateRef,
          ...query,
        });
        if (answer.outcome === 'unknown') {
          failures.set(mandate.configId, (failures.get(mandate.configId) ?? 0) + 1);
          continue;
        }
        if (answer.outcome !== 'ok') continue;
        for (const report of answer.value) {
          tally.reports += 1;
          // A report about another mandate is not applied to this one.
          if (report.providerMandateRef !== mandate.providerMandateRef) {
            tally.skipped += 1;
            continue;
          }
          try {
            await store.applyDebitLookup({
              mandateId: mandate.mandateId,
              providerDebitRef: report.providerDebitRef,
              scheduledOn: report.scheduledOn,
              amountMinor: report.amountMinor,
              status: report.status,
              // The database stores a return code only with the status `returned`.
              returnCode: report.status === 'returned' ? report.returnCode : null,
              observedAt: report.observedAt,
            });
            tally.applied += 1;
          } catch (error) {
            tally.skipped += 1;
            log.warn({ job: 'mandates', ...errorFields(error) }, 'debit report was not applied');
          }
        }
      } catch (error) {
        tally.skipped += 1;
        log.warn({ job: 'mandates', ...errorFields(error) }, 'debit lookup failed');
      }
    }
    if (tally.reports > 0 || tally.left_for_next_run > 0)
      log.info({ job: 'mandates', ...tally }, 'debit lookups processed');
  };

  const preDebitNotices = async (): Promise<void> => {
    const tally = { claimed: 0, accepted: 0, failed: 0, not_configured: 0, unrecorded: 0 };
    for (let batch = 0; batch < CLAIM_BATCHES_PER_RUN && !stopping; batch += 1) {
      const claimed = await store.claimPreDebitNotices(NOTICE_CLAIM_BATCH);
      tally.claimed += claimed.length;
      for (const notice of claimed) {
        if (stopping) break;
        try {
          const message: ChannelMessage = {
            id: notice.noticeId,
            recipientRef: notice.borrowerId,
            titleKey: 'payment_update',
          };
          const results: NoticeChannelResult[] = [
            { channel: 'in_app', result: await sendOnChannel(channels, 'in_app', message) },
            { channel: 'push', result: await sendOnChannel(channels, 'push', message) },
          ];
          const outcome = noticeOutcomeOf(results);
          await store.recordPreDebitNotice(notice.noticeId, outcome.state, outcome.providerRef);
          if (outcome.state === 'accepted') tally.accepted += 1;
          else if (outcome.state === 'not_configured') tally.not_configured += 1;
          else tally.failed += 1;
        } catch (error) {
          tally.unrecorded += 1;
          log.warn({ job: 'mandates', ...errorFields(error) }, 'pre-debit notice was not recorded');
        }
      }
      if (claimed.length < NOTICE_CLAIM_BATCH) break;
    }
    if (tally.claimed > 0) log.info({ job: 'mandates', ...tally }, 'pre-debit notices processed');
  };

  // -- Configuration and links -----------------------------------------------------------------------------------------------
  const paymentConfigsJob = async (): Promise<void> => {
    await step('payment_configs', 'revalidate', async () => {
      const result = await store.revalidatePaymentConfigs();
      if (result.notOk > 0 || result.suspended > 0)
        log.warn({ job: 'payment_configs', ...result }, 'payment configurations revalidated');
    });
  };

  const handoffLinksJob = async (): Promise<void> => {
    await step('handoff_links', 'purge', async () => {
      const purged = await store.purgeHandoffLinks();
      if (purged > 0) log.info({ job: 'handoff_links', purged }, 'hand-off links purged');
    });
  };

  // -- Reconciliation: once per IST day, from 20:00 IST ------------------------------------------------------------------------
  const reconciliationJob = async (): Promise<void> => {
    const now = istNow(clock());
    if (now.minuteOfDay < RECONCILIATION_FROM_IST_MINUTE) return;
    // The previous and the current report date. A date is done when the database holds a run for it.
    const dates = [addDays(now.date, -1), now.date];
    const configs = await store.activeCollectionConfigs();
    const byLender = new Map<string, PaymentConfigFacts[]>();
    for (const config of configs) {
      byLender.set(config.lenderOrgId, [...(byLender.get(config.lenderOrgId) ?? []), config]);
    }
    for (const [lender, lenderConfigs] of byLender) {
      if (stopping) return;
      await step('reconciliation', 'lender', async () => {
        const done = await store.reconciledDates(lender, dates);
        for (const date of dates.filter((d) => !done.has(d))) {
          if (stopping) return;
          if (!(await fetchAndRecordSettlements(lenderConfigs, date))) continue;
          const run = await store.runReconciliation(lender, date);
          log.info({ job: 'reconciliation', unchanged: run.unchanged }, 'reconciliation run');
        }
      });
    }
  };

  /**
   * Fetches and records the provider's settlement report for a date, for each of the lender's active configurations whose
   * provider can report settlements. Returns false when a report was due and could not be obtained (the run for that date waits
   * for the next check; running it without the report would only mark the date done). A provider that cannot report
   * settlements is not called: the run lists the source as not reconcilable.
   */
  const fetchAndRecordSettlements = async (
    configs: readonly PaymentConfigFacts[],
    date: string,
  ): Promise<boolean> => {
    let complete = true;
    for (const facts of configs) {
      const resolved = deps.providers.payment(configRowOf(facts));
      if (!resolved.ok) {
        log.info(
          { job: 'reconciliation', reason: resolved.reason },
          'settlement report skipped: no provider',
        );
        complete = false;
        continue;
      }
      const { port } = resolved.value;
      if (!port.capabilities.settlementReports) continue;
      const answer = await port.fetchSettlements(resolved.value.contextFor(facts.configId), date);
      if (answer.outcome !== 'ok') {
        log.warn(
          { job: 'reconciliation', outcome: answer.outcome },
          'settlement report not obtained',
        );
        complete = false;
        continue;
      }
      if (answer.value.date !== date) {
        log.warn({ job: 'reconciliation' }, 'settlement report is for another date; not recorded');
        complete = false;
        continue;
      }
      const recorded = await store.recordSettlementReport(
        facts.configId,
        date,
        settlementBatchesJson(answer.value),
      );
      log.info({ job: 'reconciliation', ...recorded }, 'settlement report recorded');
    }
    return complete;
  };

  // -- The table of jobs ---------------------------------------------------------------------------------------------------
  const jobs: ReadonlyArray<{ name: JobName; intervalMs: number; work: () => Promise<void> }> = [
    { name: 'reminders', intervalMs: REMINDERS_INTERVAL_MS, work: remindersJob },
    { name: 'payments_upkeep', intervalMs: PAYMENTS_UPKEEP_INTERVAL_MS, work: paymentsUpkeepJob },
    {
      name: 'servicing_upkeep',
      intervalMs: SERVICING_UPKEEP_INTERVAL_MS,
      work: servicingUpkeepJob,
    },
    { name: 'mandates', intervalMs: MANDATES_INTERVAL_MS, work: mandatesJob },
    { name: 'handoff_links', intervalMs: HANDOFF_PURGE_INTERVAL_MS, work: handoffLinksJob },
    {
      name: 'payment_configs',
      intervalMs: CONFIG_REVALIDATION_INTERVAL_MS,
      work: paymentConfigsJob,
    },
    {
      name: 'reconciliation',
      intervalMs: RECONCILIATION_CHECK_INTERVAL_MS,
      work: reconciliationJob,
    },
  ];

  const running = new Set<JobName>();
  const runJob = async (name: JobName): Promise<'ran' | 'skipped'> => {
    const job = jobs.find((candidate) => candidate.name === name);
    if (!job || stopping) return 'skipped';
    if (running.has(name)) {
      log.info({ job: name }, 'periodic job is still running; this run is skipped');
      return 'skipped';
    }
    running.add(name);
    try {
      await job.work();
    } catch (error) {
      // A step catches its own errors; this is for what happens outside a step.
      log.error({ job: name, ...errorFields(error) }, 'periodic job failed');
    } finally {
      running.delete(name);
    }
    return 'ran';
  };

  const cancellers: Array<() => void> = [];
  return {
    names: jobs.map((job) => job.name),
    start() {
      if (cancellers.length > 0) return;
      stopping = false;
      if (options.documentRequestExpiryDays === undefined) {
        log.info(
          { job: 'servicing_upkeep' },
          'document request expiry is not scheduled: no approved age exists',
        );
      }
      jobs.forEach((job, index) => {
        cancellers.push(
          scheduler.every(
            job.intervalMs,
            () => {
              void runJob(job.name);
            },
            FIRST_RUN_DELAY_MS + index * SECOND_MS,
          ),
        );
      });
    },
    stop() {
      stopping = true;
      for (const cancel of cancellers.splice(0)) cancel();
    },
    run: runJob,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Pure helpers (exported for the unit tests)
// ---------------------------------------------------------------------------------------------------------------------
const IST_OFFSET_MS = 330 * MINUTE_MS;

/** The Indian calendar date (YYYY-MM-DD) and minute of the day (0 to 1439) of an instant. IST has no daylight saving. */
export function istNow(instant: Date): { date: string; minuteOfDay: number } {
  const shifted = new Date(instant.getTime() + IST_OFFSET_MS);
  return {
    date: shifted.toISOString().slice(0, 10),
    minuteOfDay: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
}

/** A calendar date moved by whole days (YYYY-MM-DD in and out). */
export function addDays(date: string, days: number): string {
  const moved = new Date(`${date}T00:00:00.000Z`);
  moved.setUTCDate(moved.getUTCDate() + days);
  return moved.toISOString().slice(0, 10);
}

/**
 * What the database accepts as a provider reference in the delivery log, and nothing that looks like a link (a reference is an id;
 * the character set the database allows would let a URL through).
 */
const PROVIDER_REF = /^[A-Za-z0-9._:=+/-]{1,100}$/;
export function safeProviderRef(ref: string | undefined): string | null {
  return ref !== undefined && PROVIDER_REF.test(ref) && !ref.includes('//') ? ref : null;
}

/** Sends on a channel. sms is never sent: there is no provider, and nothing is called. A channel that throws did not answer. */
export async function sendOnChannel(
  channels: ServiceChannels,
  channel: 'in_app' | 'push' | 'sms',
  message: ChannelMessage,
): Promise<ChannelSendResult> {
  if (channel === 'sms') return { state: 'not_configured' };
  try {
    return await channels[channel].send(message);
  } catch {
    return { state: 'unknown', reason: 'provider_error' };
  }
}

/** Maps what a channel answered to what servicing.record_reminder_attempt (source `send`) accepts. */
export function reminderRecordOf(result: ChannelSendResult): {
  state: ReminderSendState;
  providerRef: string | null;
  errorClass: ReminderErrorClass | null;
} {
  switch (result.state) {
    case 'accepted':
      return {
        state: 'accepted',
        providerRef: safeProviderRef(result.providerRef),
        errorClass: null,
      };
    case 'not_configured':
      return { state: 'not_configured', providerRef: null, errorClass: null };
    case 'failed':
      return { state: 'failed', providerRef: null, errorClass: 'invalid_target' };
    case 'unknown':
      return {
        state: 'failed',
        providerRef: null,
        errorClass: result.reason === 'timeout' ? 'provider_timeout' : 'provider_error',
      };
  }
}

export type NoticeChannel = 'in_app' | 'push' | 'sms';
export interface NoticeChannelResult {
  readonly channel: NoticeChannel;
  readonly result: ChannelSendResult;
}

/**
 * The channels whose acceptance means a pre-debit notice reached, or is on its way to, the borrower. The in-app channel is NOT
 * one of them for a notice: for a reminder the database row is the inbox the app reads (servicing.my_reminders), so the in-app
 * channel accepting it is true; a pre-debit notice has no inbox row (the app builds its line from the debit), so the in-app
 * channel accepts it and writes nothing. Counting that acceptance would record the notice as sent, and the debit as notified, when
 * the borrower was told nothing but what the mandate screen already shows. sms is never sent. Add a channel here only when it
 * really tells the borrower.
 */
export const NOTICE_CHANNELS_THAT_REACH_THE_BORROWER: readonly NoticeChannel[] = ['push'];

/**
 * One state for a pre-debit notice that went to several channels, judged on the channels that can reach the borrower
 * (NOTICE_CHANNELS_THAT_REACH_THE_BORROWER). Accepted if one of them took it (the database then marks the debit notified;
 * `delivered` is never claimed here). `not_configured`, the database's word for "no channel can carry this notice", when none of
 * them can, which includes the case where only the in-app channel accepted: the notice stays late and the lender is told
 * (`mandate_notice_late`) instead of being shown as sent. Anything else is a failure the database releases for a retry.
 */
export function noticeOutcomeOf(results: readonly NoticeChannelResult[]): {
  state: NoticeState;
  providerRef: string | null;
} {
  const reaching = results.filter((entry) =>
    NOTICE_CHANNELS_THAT_REACH_THE_BORROWER.includes(entry.channel),
  );
  const taken = reaching.flatMap((entry) =>
    entry.result.state === 'accepted' ? [entry.result] : [],
  );
  if (taken.length > 0) {
    // A channel that gave a usable reference supplies it.
    const ref = taken.map((result) => safeProviderRef(result.providerRef)).find((r) => r !== null);
    return { state: 'accepted', providerRef: ref ?? null };
  }
  if (reaching.every((entry) => entry.result.state === 'not_configured')) {
    return { state: 'not_configured', providerRef: null };
  }
  return { state: 'failed', providerRef: null };
}

/** The settlement report as the JSON payments.record_settlement_report reads: money as digit strings of paise, nothing recomputed. */
export function settlementBatchesJson(report: SettlementReport): SettlementBatchJson[] {
  return report.batches.map((batch) => ({
    batchRef: batch.batchRef,
    settlementRef: batch.settlementRef,
    periodFrom: batch.periodFrom,
    periodTo: batch.periodTo,
    destinationMaskedRef: batch.destinationMaskedRef,
    grossMinor: batch.grossMinor.toString(),
    feeMinor: batch.feeMinor.toString(),
    taxMinor: batch.taxMinor.toString(),
    netMinor: batch.netMinor.toString(),
    items: batch.items.map((item) => ({
      providerPaymentRef: item.providerPaymentRef,
      orderRef: item.orderRef,
      grossMinor: item.grossMinor.toString(),
      feeMinor: item.feeMinor.toString(),
      taxMinor: item.taxMinor.toString(),
      netMinor: item.netMinor.toString(),
    })),
  }));
}
