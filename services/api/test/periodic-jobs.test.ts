// Unit tests of the scheduled work (Phase 08a, wave 5): scheduling and the named intervals, the in-flight guard, error isolation, the
// logging rule (classes only), the way channel and provider answers are mapped for the database, the order lookup before an intent
// is expired, the once-a-day reconciliation, and the servicing event handlers. A fake store and fake scheduler stand in for the
// database and the timers; the real database is covered by test/integration/periodic-jobs.integration.test.ts.
import {
  createMockMandateProvider,
  createMockNotifier,
  createMockPaymentProvider,
  type ChannelSendResult,
  type MandateDebitReport,
  type MandateProviderPort,
  type PaymentProviderPort,
  type PaymentResult,
  type OrderStatus,
} from '@udofin/adapters';
import { describe, expect, it, vi } from 'vitest';
import {
  type ClaimedNotice,
  type ClaimedReminder,
  type ExpiryCandidate,
  type JobsStore,
  type PaymentConfigFacts,
} from '../src/system/jobs.js';
import { type SystemPool } from '../src/system/pool.js';
import {
  addDays,
  createPeriodicJobs,
  DEBIT_LOOKAHEAD_DAYS,
  DEBIT_LOOKBACK_DAYS,
  DEBIT_LOOKUPS_PER_RUN,
  errorFields,
  INTENT_HOLD_LIMIT_SECONDS,
  istNow,
  MANDATE_LOOKUPS_PER_RUN,
  MANDATE_POLLING_BUDGET_MS,
  noticeOutcomeOf,
  reminderRecordOf,
  sendOnChannel,
  settlementBatchesJson,
  startPeriodicJobs,
  type PeriodicJobOptions,
  type Scheduler,
} from '../src/workers/periodic-jobs.js';
import { type WorkerLogger } from '../src/workers/outbox-worker.js';
import {
  type PaymentConfigRow,
  type ProviderResolver,
  type Resolved,
  type ResolvedPort,
} from '../src/workers/provider-resolver.js';
import {
  assertPushChannelAllowed,
  createInAppInboxChannel,
  createServiceChannels,
  createUnconfiguredPushChannel,
  type ServiceChannels,
} from '../src/workers/reminder-channels.js';
import { createServicingHandlers } from '../src/workers/servicing-handlers.js';
import { type OutboxEvent } from '../src/workers/outbox-worker.js';

// ---- doubles ----------------------------------------------------------------------------------------------------------------
const LENDER = '11111111-1111-4111-8111-111111111111';
const CONFIG = '22222222-2222-4222-8222-222222222222';
const BORROWER = '33333333-3333-4333-8333-333333333333';
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function captureLog() {
  const lines: string[] = [];
  const log: WorkerLogger = {
    info: (f, m) => lines.push(JSON.stringify({ level: 'info', f, m })),
    warn: (f, m) => lines.push(JSON.stringify({ level: 'warn', f, m })),
    error: (f, m) => lines.push(JSON.stringify({ level: 'error', f, m })),
  };
  return { log, lines };
}

function fakeScheduler() {
  const registered: {
    intervalMs: number;
    firstDelayMs: number;
    task: () => void;
    cancelled: boolean;
  }[] = [];
  const scheduler: Scheduler = {
    every(intervalMs, task, firstDelayMs) {
      const entry = { intervalMs, firstDelayMs, task, cancelled: false };
      registered.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
  };
  return { scheduler, registered };
}

const FACTS: PaymentConfigFacts = {
  configId: CONFIG,
  lenderOrgId: LENDER,
  provider: 'mock_payment_provider',
  providerMode: 'mock',
  merchantRef: 'SAMPLE-MERCHANT',
  secretRef: 'SAMPLE_SECRET',
  webhookSecretRef: 'SAMPLE_WEBHOOK_SECRET',
};

interface FakeStore extends JobsStore {
  readonly calls: { name: string; args: unknown[] }[];
  readonly called: (name: string) => unknown[][];
}

function fakeStore(overrides: Partial<JobsStore> = {}): FakeStore {
  const calls: { name: string; args: unknown[] }[] = [];
  const record =
    <A extends unknown[], R>(name: string, value: (...args: A) => R) =>
    (...args: A): R => {
      calls.push({ name, args });
      return value(...args);
    };
  const base: JobsStore = {
    planReminders: record('planReminders', () => Promise.resolve(0)),
    claimDueReminders: record('claimDueReminders', () => Promise.resolve([])),
    recordReminderAttempt: record('recordReminderAttempt', () => Promise.resolve('ok')),
    expiryCandidates: record('expiryCandidates', () =>
      Promise.resolve({ cutoff: '2026-10-16 10:00:00+00', candidates: [] }),
    ),
    paymentConfig: record('paymentConfig', () => Promise.resolve(FACTS)),
    raiseException: record('raiseException', () => Promise.resolve()),
    expireStaleIntents: record('expireStaleIntents', () => Promise.resolve(0)),
    expireDocumentRequests: record('expireDocumentRequests', () => Promise.resolve(0)),
    completeDisbursements: record('completeDisbursements', () => Promise.resolve(0)),
    mandatesNeedingLookup: record('mandatesNeedingLookup', () => Promise.resolve([])),
    applyMandateLookup: record('applyMandateLookup', () => Promise.resolve('applied')),
    activeMandates: record('activeMandates', () => Promise.resolve([])),
    applyDebitLookup: record('applyDebitLookup', () => Promise.resolve('applied')),
    sweepMandates: record('sweepMandates', () => Promise.resolve({})),
    requestCancelForClosedLoans: record('requestCancelForClosedLoans', () => Promise.resolve(0)),
    planMandateDebits: record('planMandateDebits', () => Promise.resolve({})),
    claimPreDebitNotices: record('claimPreDebitNotices', () => Promise.resolve([])),
    recordPreDebitNotice: record('recordPreDebitNotice', () => Promise.resolve('accepted')),
    revalidatePaymentConfigs: record('revalidatePaymentConfigs', () =>
      Promise.resolve({ checked: 0, notOk: 0, suspended: 0 }),
    ),
    purgeHandoffLinks: record('purgeHandoffLinks', () => Promise.resolve(0)),
    activeCollectionConfigs: record('activeCollectionConfigs', () => Promise.resolve([])),
    reconciledDates: record('reconciledDates', () => Promise.resolve(new Set<string>())),
    recordSettlementReport: record('recordSettlementReport', () =>
      Promise.resolve({ recorded: 1 }),
    ),
    runReconciliation: record('runReconciliation', () =>
      Promise.resolve({ runNo: 1, unchanged: false }),
    ),
    suppressAndCancelForClosedLoan: record('suppressAndCancelForClosedLoan', () =>
      Promise.resolve({ suppressed: 0, cancelRequested: 0 }),
    ),
  };
  const merged: JobsStore = { ...base };
  for (const [name, fn] of Object.entries(overrides)) {
    Object.assign(merged, { [name]: record(name, fn as (...args: unknown[]) => unknown) });
  }
  return Object.assign(merged, {
    calls,
    called: (name: string) => calls.filter((c) => c.name === name).map((c) => c.args),
  });
}

function portOf<P>(port: P): ResolvedPort<P> {
  return {
    port,
    contextFor: (correlationId, idempotencyKey) => ({
      tenantId: LENDER,
      correlationId,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    }),
  };
}

function resolverOf(options: {
  payment?: Resolved<ResolvedPort<PaymentProviderPort>>;
  mandate?: Resolved<ResolvedPort<MandateProviderPort>>;
}): ProviderResolver & { rows: PaymentConfigRow[] } {
  const rows: PaymentConfigRow[] = [];
  return {
    rows,
    payment: (row) => {
      rows.push(row);
      return options.payment ?? { ok: false, reason: 'provider_not_configured' };
    },
    mandate: (row) => {
      rows.push(row);
      return options.mandate ?? { ok: false, reason: 'provider_not_configured' };
    },
  };
}

const fakePool: SystemPool = {
  withSystem: () => Promise.reject(new Error('the fake pool is never used')),
  end: () => Promise.resolve(),
};

function jobs(
  parts: {
    store?: FakeStore;
    resolver?: ProviderResolver;
    channels?: ServiceChannels;
    options?: PeriodicJobOptions;
    environment?: 'local' | 'test' | 'staging' | 'production';
  } = {},
) {
  const { log, lines } = captureLog();
  const { scheduler, registered } = fakeScheduler();
  const store: FakeStore = parts.store ?? fakeStore();
  const instance = createPeriodicJobs(
    {
      pool: fakePool,
      providers: parts.resolver ?? resolverOf({}),
      environment: parts.environment ?? 'test',
      log,
    },
    {
      scheduler,
      store,
      channels: parts.channels ?? createServiceChannels({ environment: 'test' }),
      ...parts.options,
    },
  );
  return { instance, lines, registered, store };
}

const accepted: ChannelSendResult = { state: 'accepted' };
const channelsOf = (inApp: ChannelSendResult, push: ChannelSendResult): ServiceChannels => ({
  in_app: { descriptor: createInAppInboxChannel().descriptor, send: () => Promise.resolve(inApp) },
  push: { descriptor: createInAppInboxChannel().descriptor, send: () => Promise.resolve(push) },
});

// ---- scheduling, guard, isolation -----------------------------------------------------------------------------------------
describe('scheduling', () => {
  it('registers every job with its named interval, staggered, and cancels them on stop', () => {
    const { instance, registered } = jobs();
    instance.start();
    expect(instance.names).toEqual([
      'reminders',
      'payments_upkeep',
      'servicing_upkeep',
      'mandates',
      'handoff_links',
      'payment_configs',
      'reconciliation',
    ]);
    expect(registered.map((r) => r.intervalMs)).toEqual([
      60_000, // reminders: every minute
      300_000, // payments upkeep: every 5 minutes
      300_000, // servicing upkeep
      300_000, // mandates
      300_000, // hand-off links
      3_600_000, // payment configurations: hourly
      900_000, // reconciliation: looks at the clock every 15 minutes
    ]);
    expect(new Set(registered.map((r) => r.firstDelayMs)).size).toBe(registered.length);
    instance.start(); // starting twice does not schedule twice
    expect(registered).toHaveLength(7);
    instance.stop();
    expect(registered.every((r) => r.cancelled)).toBe(true);
  });

  it('startPeriodicJobs keeps its signature and returns a stop function', () => {
    const { log } = captureLog();
    const started = startPeriodicJobs({
      pool: fakePool,
      providers: resolverOf({}),
      environment: 'test',
      log,
    });
    expect(typeof started.stop).toBe('function');
    started.stop();
  });

  it('with the real timers (a fake clock): the first run comes shortly after start, then once a minute for reminders; stop ends it', async () => {
    vi.useFakeTimers();
    try {
      const { log } = captureLog();
      const store = fakeStore();
      const instance = createPeriodicJobs(
        { pool: fakePool, providers: resolverOf({}), environment: 'test', log },
        { store, channels: createServiceChannels({ environment: 'test' }) },
      );
      instance.start();
      expect(store.called('planReminders')).toHaveLength(0); // nothing at start-up itself
      await vi.advanceTimersByTimeAsync(5_000);
      expect(store.called('planReminders')).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(59_999);
      expect(store.called('planReminders')).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(store.called('planReminders')).toHaveLength(2);
      // The five-minute jobs ran once by now and run again five minutes after their first run.
      expect(store.called('purgeHandoffLinks')).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(store.called('purgeHandoffLinks')).toHaveLength(2);
      instance.stop();
      const before = store.called('planReminders').length;
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(store.called('planReminders')).toHaveLength(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs a job only once at a time: a tick that finds it running is skipped', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const store = fakeStore({ planReminders: () => gate.then(() => 0) });
    const { instance, lines } = jobs({ store });
    const first = instance.run('reminders');
    expect(await instance.run('reminders')).toBe('skipped');
    expect(lines.some((l) => l.includes('still running'))).toBe(true);
    release();
    expect(await first).toBe('ran');
    expect(await instance.run('reminders')).toBe('ran');
    expect(store.called('planReminders')).toHaveLength(2);
  });

  it('different jobs do not block each other', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { instance } = jobs({ store: fakeStore({ planReminders: () => gate.then(() => 0) }) });
    const slow = instance.run('reminders');
    expect(await instance.run('handoff_links')).toBe('ran');
    release();
    await slow;
  });

  it('does nothing after stop, and a job already running stops taking new work', async () => {
    const reminders: ClaimedReminder[] = [1, 2, 3].map((n) => ({
      reminderId: ID(n),
      borrowerId: BORROWER,
      channel: 'in_app' as const,
    }));
    let calls = 0;
    const { instance, store } = jobs({
      store: fakeStore({
        claimDueReminders: () => Promise.resolve(reminders),
        recordReminderAttempt: () => {
          calls += 1;
          instance.stop();
          return Promise.resolve('ok');
        },
      }),
    });
    await instance.run('reminders');
    expect(calls).toBe(1);
    expect(await instance.run('reminders')).toBe('skipped');
    expect(store.called('recordReminderAttempt')).toHaveLength(1);
  });
});

describe('error isolation and the logging rule', () => {
  it('a failing step is logged by class and sqlstate only, and the next step still runs', async () => {
    const dbError = Object.assign(new Error('secret row value 9876543210 https://x.invalid/k'), {
      name: 'error',
      code: '42501',
    });
    const store = fakeStore({
      planReminders: () => Promise.reject(dbError),
      claimDueReminders: () => Promise.resolve([]),
    });
    const { instance, lines } = jobs({ store });
    expect(await instance.run('reminders')).toBe('ran');
    expect(store.called('claimDueReminders')).toHaveLength(1);
    const text = lines.join('\n');
    expect(text).toContain('"errorClass":"error"');
    expect(text).toContain('"sqlstate":"42501"');
    expect(text).not.toContain('9876543210');
    expect(text).not.toContain('https://');
    expect(text).not.toContain('secret row value');
  });

  it('a throwing job never stops another job or the loop', async () => {
    const store = fakeStore({
      sweepMandates: () => Promise.reject(new TypeError('boom')),
      planMandateDebits: () => Promise.resolve({ planned: 2 }),
    });
    const { instance, lines } = jobs({ store });
    expect(await instance.run('mandates')).toBe('ran');
    expect(store.called('planMandateDebits')).toHaveLength(1);
    expect(store.called('claimPreDebitNotices')).toHaveLength(1);
    expect(lines.join('\n')).toContain('"errorClass":"TypeError"');
    expect(await instance.run('handoff_links')).toBe('ran');
  });

  it('errorFields keeps a five-character SQLSTATE and drops everything else', () => {
    expect(errorFields(Object.assign(new Error('m'), { code: '23505' }))).toEqual({
      errorClass: 'Error',
      sqlstate: '23505',
    });
    expect(errorFields(Object.assign(new Error('m'), { code: 'ECONNRESET' }))).toEqual({
      errorClass: 'Error',
    });
    expect(errorFields('a string')).toEqual({ errorClass: 'unknown' });
    expect(errorFields(null)).toEqual({ errorClass: 'unknown' });
  });
});

// ---- reminders --------------------------------------------------------------------------------------------------------------
describe('reminders', () => {
  const claimed = (channel: ClaimedReminder['channel'], n: number): ClaimedReminder => ({
    reminderId: ID(n),
    borrowerId: BORROWER,
    channel,
  });

  it('plans, claims, sends on in_app and push, records every attempt, and never calls anything for sms', async () => {
    const notifier = createMockNotifier('test');
    const channels = createServiceChannels({ environment: 'test', push: notifier.channels.push });
    const store = fakeStore({
      planReminders: () => Promise.resolve(3),
      claimDueReminders: () =>
        Promise.resolve([claimed('in_app', 1), claimed('push', 2), claimed('sms', 3)]),
    });
    const { instance, lines } = jobs({ store, channels });
    await instance.run('reminders');
    expect(store.calls.map((c) => c.name).slice(0, 2)).toEqual([
      'planReminders',
      'claimDueReminders',
    ]);
    expect(store.called('recordReminderAttempt')).toEqual([
      [ID(1), 'accepted', null, null],
      [ID(2), 'accepted', 'mock-notice-1', null],
      [ID(3), 'not_configured', null, null],
    ]);
    // Only the opaque id and the fixed title key went to the push channel.
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]).toMatchObject({
      channel: 'push',
      idempotencyKey: ID(2),
      recipientRef: BORROWER,
      payload: { id: ID(2), titleKey: 'reminder' },
    });
    expect(Object.keys(notifier.sent[0]?.payload ?? {}).sort()).toEqual(['id', 'titleKey']);
    expect(lines.join('\n')).toContain('"claimed":3');
  });

  it('push outside local and test answers not_configured and is recorded as such, never as sent', async () => {
    for (const environment of ['staging', 'production'] as const) {
      const channels = createServiceChannels({ environment });
      const store = fakeStore({ claimDueReminders: () => Promise.resolve([claimed('push', 4)]) });
      const { instance } = jobs({ store, channels, environment });
      await instance.run('reminders');
      expect(store.called('recordReminderAttempt')).toEqual([
        [ID(4), 'not_configured', null, null],
      ]);
    }
  });

  it('maps a definite refusal and an unknown outcome to failed with a class the delivery log allows', () => {
    expect(reminderRecordOf({ state: 'failed', reason: 'invalid_request' })).toEqual({
      state: 'failed',
      providerRef: null,
      errorClass: 'invalid_target',
    });
    expect(reminderRecordOf({ state: 'unknown', reason: 'timeout' })).toMatchObject({
      state: 'failed',
      errorClass: 'provider_timeout',
    });
    expect(reminderRecordOf({ state: 'unknown', reason: 'network' })).toMatchObject({
      errorClass: 'provider_error',
    });
    expect(reminderRecordOf({ state: 'unknown', reason: 'provider_error' })).toMatchObject({
      errorClass: 'provider_error',
    });
    // A provider reference the database would refuse (a link, a space) is not passed on.
    expect(
      reminderRecordOf({ state: 'accepted', providerRef: 'https://x.invalid/ab' }).providerRef,
    ).toBeNull();
    expect(reminderRecordOf({ state: 'accepted', providerRef: 'mock-notice-9' }).providerRef).toBe(
      'mock-notice-9',
    );
  });

  it('a channel that throws is recorded as a failed attempt, and the other reminders still go out', async () => {
    const channels: ServiceChannels = {
      in_app: {
        descriptor: createInAppInboxChannel().descriptor,
        send: () => Promise.reject(new Error('9876543210')),
      },
      push: createServiceChannels({ environment: 'production' }).push,
    };
    const store = fakeStore({
      claimDueReminders: () => Promise.resolve([claimed('in_app', 5), claimed('push', 6)]),
    });
    const { instance, lines } = jobs({ store, channels });
    await instance.run('reminders');
    expect(store.called('recordReminderAttempt')).toEqual([
      [ID(5), 'failed', null, 'provider_error'],
      [ID(6), 'not_configured', null, null],
    ]);
    expect(lines.join('\n')).not.toContain('9876543210');
  });

  it('an attempt that cannot be recorded is logged by class, does not stop the batch and is left to be claimed again', async () => {
    let n = 0;
    const store = fakeStore({
      claimDueReminders: () => Promise.resolve([claimed('in_app', 7), claimed('in_app', 8)]),
      recordReminderAttempt: () => {
        n += 1;
        return n === 1 ? Promise.reject(new Error('db down 9123456780')) : Promise.resolve('ok');
      },
    });
    const { instance, lines } = jobs({ store });
    await instance.run('reminders');
    expect(store.called('recordReminderAttempt')).toHaveLength(2);
    expect(lines.join('\n')).toContain('reminder attempt was not recorded');
    expect(lines.join('\n')).not.toContain('9123456780');
  });

  it('keeps asking while a full batch comes back, up to the cap', async () => {
    const full = Array.from({ length: 100 }, (_, i) => claimed('in_app', i + 100));
    let calls = 0;
    const store = fakeStore({
      claimDueReminders: () => {
        calls += 1;
        return Promise.resolve(calls < 3 ? full : []);
      },
    });
    const { instance } = jobs({ store });
    await instance.run('reminders');
    expect(calls).toBe(3);
    expect(store.called('recordReminderAttempt')).toHaveLength(200);
  });

  it('sendOnChannel never reaches a channel for sms', async () => {
    let touched = false;
    const spy: ServiceChannels = {
      in_app: {
        descriptor: createInAppInboxChannel().descriptor,
        send: () => ((touched = true), Promise.resolve(accepted)),
      },
      push: {
        descriptor: createInAppInboxChannel().descriptor,
        send: () => ((touched = true), Promise.resolve(accepted)),
      },
    };
    expect(
      await sendOnChannel(spy, 'sms', { id: ID(1), recipientRef: BORROWER, titleKey: 'reminder' }),
    ).toEqual({
      state: 'not_configured',
    });
    expect(touched).toBe(false);
  });
});

describe('channels', () => {
  it('the in-app inbox accepts a well-formed id and refuses a malformed one', async () => {
    const inbox = createInAppInboxChannel();
    expect(await inbox.send({ id: ID(1), recipientRef: BORROWER, titleKey: 'reminder' })).toEqual({
      state: 'accepted',
    });
    expect(await inbox.send({ id: 'short', recipientRef: BORROWER, titleKey: 'reminder' })).toEqual(
      {
        state: 'failed',
        reason: 'invalid_request',
      },
    );
  });

  it('push is the labelled mock in local and test only', async () => {
    for (const environment of ['local', 'test'] as const) {
      const channels = createServiceChannels({ environment });
      expect(channels.push.descriptor).toMatchObject({ key: 'mock_notifier', mode: 'mock' });
      expect(
        await channels.push.send({ id: ID(1), recipientRef: BORROWER, titleKey: 'reminder' }),
      ).toMatchObject({
        state: 'accepted',
      });
    }
    for (const environment of ['staging', 'production'] as const) {
      const channels = createServiceChannels({ environment });
      expect(channels.push.descriptor.key).toBe('push_channel_not_configured');
      expect(
        await channels.push.send({ id: ID(1), recipientRef: BORROWER, titleKey: 'reminder' }),
      ).toEqual({
        state: 'not_configured',
      });
    }
  });

  it('a mock push port is refused outside local and test even when one is passed in', () => {
    const mock = createMockNotifier('test').channels.push;
    expect(() => createServiceChannels({ environment: 'staging', push: mock })).toThrow();
    expect(() => createServiceChannels({ environment: 'production', push: mock })).toThrow();
    expect(() =>
      assertPushChannelAllowed(createUnconfiguredPushChannel(), 'production'),
    ).not.toThrow();
  });

  it('push never carries more than an id and a title key', async () => {
    const notifier = createMockNotifier('test');
    const channels = createServiceChannels({ environment: 'test', push: notifier.channels.push });
    await channels.push.send({ id: ID(1), recipientRef: BORROWER, titleKey: 'payment_update' });
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]?.payload).toEqual({ id: ID(1), titleKey: 'payment_update' });
    // An id the channel would refuse is not sent at all.
    expect(
      await channels.push.send({
        id: '+919876543210',
        recipientRef: BORROWER,
        titleKey: 'reminder',
      }),
    ).toEqual({
      state: 'failed',
      reason: 'invalid_request',
    });
    expect(notifier.sent).toHaveLength(1);
  });
});

// ---- payments upkeep --------------------------------------------------------------------------------------------------------
describe('payments upkeep: look the order up before an intent is expired', () => {
  const candidate = (n: number, over: Partial<ExpiryCandidate> = {}): ExpiryCandidate => ({
    intentId: ID(n),
    lenderOrgId: LENDER,
    configId: CONFIG,
    providerOrderRef: `ORDER-${String(n)}`,
    linkExpiresAt: `2026-10-16 0${String(n)}:00:00+00`,
    ageSeconds: 3_600,
    ...over,
  });
  const status = (value: OrderStatus['status']): PaymentResult<OrderStatus> => ({
    outcome: 'ok',
    value: {
      source: 'provider_authenticated_lookup',
      orderRef: 'ORDER',
      status: value,
      amountMinor: null,
      currency: 'INR',
      merchantRef: null,
      providerPaymentRef: null,
      observedAt: '2026-10-16T00:00:00.000Z',
    },
  });
  const paymentPort = (
    answers: Record<string, PaymentResult<OrderStatus>>,
    seen: string[] = [],
  ): PaymentProviderPort => ({
    ...createMockPaymentProvider('test'),
    getOrderStatus: (_ctx, query) => {
      seen.push(query.operationKey);
      return Promise.resolve(answers[query.operationKey] ?? { outcome: 'not_found' });
    },
  });
  const upkeep = (
    candidates: ExpiryCandidate[],
    answers: Record<string, PaymentResult<OrderStatus>>,
    extra: Partial<JobsStore> = {},
    resolverPayment?: Resolved<ResolvedPort<PaymentProviderPort>>,
    seen: string[] = [],
  ) => {
    const store = fakeStore({
      expiryCandidates: () => Promise.resolve({ cutoff: '2026-10-16 10:00:00+00', candidates }),
      expireStaleIntents: () => Promise.resolve(2),
      ...extra,
    });
    const run = jobs({
      store,
      resolver: resolverOf({
        payment: resolverPayment ?? { ok: true, value: portOf(paymentPort(answers, seen)) },
      }),
    });
    return { ...run, store };
  };

  it('an intent the provider reports as paid is not expired: an exception for a person, and the expiry boundary stops short of it', async () => {
    const { instance, store } = upkeep([candidate(1), candidate(2), candidate(3)], {
      [ID(1)]: status('failed'),
      [ID(2)]: status('captured'),
      [ID(3)]: status('cancelled'),
    });
    await instance.run('payments_upkeep');
    expect(store.called('raiseException')).toEqual([
      [
        {
          lenderOrgId: LENDER,
          class: 'webhook_gap',
          severity: 'warning',
          owner: 'platform',
          subject: { intent_id: ID(2) },
        },
      ],
    ]);
    expect(store.called('expireStaleIntents')).toEqual([
      [
        {
          cutoff: '2026-10-16 10:00:00+00',
          truncatedAt: undefined,
          oldestHeld: candidate(2).linkExpiresAt,
        },
      ],
    ]);
  });

  it('every success status holds the intent', async () => {
    for (const success of ['captured', 'paid', 'succeeded'] as const) {
      const { instance, store } = upkeep([candidate(1)], { [ID(1)]: status(success) });
      await instance.run('payments_upkeep');
      expect(store.called('raiseException')).toHaveLength(1);
      expect(store.called('expireStaleIntents')[0]?.[0]).toMatchObject({
        oldestHeld: candidate(1).linkExpiresAt,
      });
    }
  });

  it('an unfinished or unexpected status is held and a person is told; a clean "nothing was paid" answer is not held', async () => {
    const held = upkeep([candidate(1), candidate(2)], {
      [ID(1)]: status('pending'),
      [ID(2)]: status('authorized'),
    });
    await held.instance.run('payments_upkeep');
    expect(held.store.called('raiseException')).toHaveLength(2);
    const clean = upkeep([candidate(1), candidate(2), candidate(3), candidate(4)], {
      [ID(1)]: status('created'),
      [ID(2)]: status('failed'),
      [ID(3)]: status('cancelled'),
      [ID(4)]: status('expired'),
    });
    await clean.instance.run('payments_upkeep');
    expect(clean.store.called('raiseException')).toHaveLength(0);
    expect(clean.store.called('expireStaleIntents')[0]?.[0]).toMatchObject({
      oldestHeld: undefined,
    });
  });

  it('an unknown order: safe for a created intent that has no order, a contradiction for one that has', async () => {
    const created = upkeep([candidate(1, { providerOrderRef: undefined })], {});
    await created.instance.run('payments_upkeep');
    expect(created.store.called('raiseException')).toHaveLength(0);
    const pending = upkeep([candidate(2)], {});
    await pending.instance.run('payments_upkeep');
    expect(pending.store.called('raiseException')).toHaveLength(1);
    expect(pending.store.called('expireStaleIntents')[0]?.[0]).toMatchObject({
      oldestHeld: candidate(2).linkExpiresAt,
    });
  });

  it('a lookup that gets no answer holds the intent quietly (no exception yet), and an intent past the hold limit is released with an exception', async () => {
    const quiet = upkeep([candidate(1)], { [ID(1)]: { outcome: 'unknown', reason: 'timeout' } });
    await quiet.instance.run('payments_upkeep');
    expect(quiet.store.called('raiseException')).toHaveLength(0);
    expect(quiet.store.called('expireStaleIntents')[0]?.[0]).toMatchObject({
      oldestHeld: candidate(1).linkExpiresAt,
    });

    const old = upkeep([candidate(1, { ageSeconds: INTENT_HOLD_LIMIT_SECONDS + 1 })], {
      [ID(1)]: { outcome: 'unknown', reason: 'timeout' },
    });
    await old.instance.run('payments_upkeep');
    expect(old.store.called('raiseException')).toHaveLength(1);
    expect(old.store.called('expireStaleIntents')[0]?.[0]).toMatchObject({ oldestHeld: undefined });
  });

  it('an intent that could not be flagged is not let go', async () => {
    const { instance, store, lines } = upkeep(
      [candidate(1)],
      { [ID(1)]: status('captured') },
      {
        raiseException: () => Promise.reject(new Error('down')),
      },
    );
    await instance.run('payments_upkeep');
    expect(store.called('expireStaleIntents')[0]?.[0]).toMatchObject({
      oldestHeld: candidate(1).linkExpiresAt,
    });
    expect(lines.join('\n')).toContain('could not open an exception');
  });

  it('an intent whose hold has ended is let go only once a person has been told; if that fails it is held one more run', async () => {
    const old = candidate(1, { ageSeconds: INTENT_HOLD_LIMIT_SECONDS + 1 });
    const failing = upkeep(
      [old],
      { [ID(1)]: status('captured') },
      { raiseException: () => Promise.reject(new Error('down')) },
    );
    await failing.instance.run('payments_upkeep');
    expect(failing.store.called('expireStaleIntents')[0]?.[0]).toMatchObject({
      oldestHeld: old.linkExpiresAt,
    });
    const working = upkeep([old], { [ID(1)]: status('captured') });
    await working.instance.run('payments_upkeep');
    expect(working.store.called('raiseException')).toHaveLength(1);
    expect(working.store.called('expireStaleIntents')[0]?.[0]).toMatchObject({
      oldestHeld: undefined,
    });
  });

  it('a lender the resolver cannot serve is skipped: nothing is looked up, nothing is expired for it, only the reason class is logged', async () => {
    const { instance, store, lines } = upkeep(
      [candidate(1)],
      {},
      {},
      { ok: false, reason: 'mock_not_allowed_here' },
    );
    await instance.run('payments_upkeep');
    expect(store.called('raiseException')).toHaveLength(0);
    expect(store.called('expireStaleIntents')[0]?.[0]).toMatchObject({
      oldestHeld: candidate(1).linkExpiresAt,
    });
    expect(lines.join('\n')).not.toContain('ORDER-1');
  });

  it('a provider with no status lookup is never asked', async () => {
    const seen: string[] = [];
    const base = paymentPort({}, seen);
    const noLookup: PaymentProviderPort = {
      ...base,
      capabilities: { ...base.capabilities, statusLookup: false },
    };
    const { instance, store } = upkeep(
      [candidate(1)],
      {},
      {},
      { ok: true, value: portOf(noLookup) },
    );
    await instance.run('payments_upkeep');
    expect(seen).toEqual([]);
    expect(store.called('expireStaleIntents')[0]?.[0]).toMatchObject({
      oldestHeld: candidate(1).linkExpiresAt,
    });
  });

  it('after three failed answers from one provider, the rest of its lookups wait for the next run', async () => {
    const seen: string[] = [];
    const answers: Record<string, PaymentResult<OrderStatus>> = {};
    const list = [1, 2, 3, 4, 5].map((n) => {
      answers[ID(n)] = { outcome: 'unknown', reason: 'network' };
      return candidate(n);
    });
    const { instance } = upkeep(list, answers, {}, undefined, seen);
    await instance.run('payments_upkeep');
    expect(seen).toHaveLength(3);
  });

  it('a list that was cut short at the cap passes the last intent looked at as the boundary', async () => {
    const list = Array.from({ length: 200 }, (_, i) =>
      candidate((i % 8) + 1, {
        intentId: ID(1000 + i),
        linkExpiresAt: `2026-10-16 05:00:${String(i % 60).padStart(2, '0')}+00`,
      }),
    );
    const answers: Record<string, PaymentResult<OrderStatus>> = {};
    for (const c of list) answers[c.intentId] = status('failed');
    const { instance, store } = upkeep(list, answers);
    await instance.run('payments_upkeep');
    expect(store.called('expireStaleIntents')[0]?.[0]).toMatchObject({
      truncatedAt: list[199]?.linkExpiresAt,
      oldestHeld: undefined,
    });
  });

  it('no config on the intent means no lookup, and the config is read once per run', async () => {
    const withoutConfig = upkeep([candidate(1, { configId: undefined })], {});
    await withoutConfig.instance.run('payments_upkeep');
    expect(withoutConfig.store.called('paymentConfig')).toHaveLength(0);
    expect(withoutConfig.store.called('expireStaleIntents')[0]?.[0]).toMatchObject({
      oldestHeld: candidate(1).linkExpiresAt,
    });
    const two = upkeep([candidate(1), candidate(2)], {
      [ID(1)]: status('failed'),
      [ID(2)]: status('failed'),
    });
    await two.instance.run('payments_upkeep');
    expect(two.store.called('paymentConfig')).toHaveLength(1);
  });

  it('a live configuration is handed to the resolver as `live`, never as the database word', async () => {
    const run = upkeep(
      [candidate(1)],
      { [ID(1)]: status('failed') },
      { paymentConfig: () => Promise.resolve({ ...FACTS, providerMode: 'production' }) },
    );
    const resolver = resolverOf({
      payment: { ok: true, value: portOf(paymentPort({ [ID(1)]: status('failed') })) },
    });
    const again = jobs({
      store: fakeStore({
        expiryCandidates: () => Promise.resolve({ cutoff: 'x', candidates: [candidate(1)] }),
        paymentConfig: () => Promise.resolve({ ...FACTS, providerMode: 'production' }),
      }),
      resolver,
    });
    await again.instance.run('payments_upkeep');
    expect(resolver.rows[0]?.providerMode).toBe('live');
    await run.instance.run('payments_upkeep');
  });

  it('a boundary the database refuses (too old) is logged, and the run does not fail', async () => {
    const { instance, lines } = upkeep(
      [candidate(1)],
      { [ID(1)]: status('failed') },
      { expireStaleIntents: () => Promise.resolve(undefined) },
    );
    await expect(instance.run('payments_upkeep')).resolves.toBe('ran');
    expect(lines.join('\n')).toContain('nothing expired');
  });
});

describe('servicing upkeep', () => {
  it('completes disbursements, and expires document requests only when an age was given', async () => {
    const plain = jobs();
    await plain.instance.run('servicing_upkeep');
    expect(plain.store.called('completeDisbursements')).toEqual([[null]]);
    expect(plain.store.called('expireDocumentRequests')).toHaveLength(0);
    plain.instance.start();
    expect(plain.lines.join('\n')).toContain('document request expiry is not scheduled');

    const now = new Date('2026-10-16T10:00:00.000Z');
    const aged = jobs({ options: { documentRequestExpiryDays: 30, clock: () => now } });
    await aged.instance.run('servicing_upkeep');
    expect(aged.store.called('expireDocumentRequests')).toEqual([
      [new Date('2026-09-16T10:00:00.000Z')],
    ]);
  });
});

// ---- mandates ---------------------------------------------------------------------------------------------------------------
describe('mandates', () => {
  const lookup = {
    mandateId: ID(50),
    lenderOrgId: LENDER,
    configId: CONFIG,
    providerMandateRef: 'MANDATE-REF-1' as string | undefined,
    status: 'registration_pending',
  };

  it('applies an authenticated status lookup, with the provider reference and the observed time', async () => {
    const mandate: MandateProviderPort = {
      ...createMockMandateProvider('test'),
      getMandateStatus: () =>
        Promise.resolve({
          outcome: 'ok',
          value: {
            source: 'provider_authenticated_lookup',
            providerMandateRef: 'MANDATE-REF-1',
            rail: 'enach_api',
            status: 'active',
            maxAmountMinor: null,
            merchantRef: null,
            observedAt: '2026-10-16T01:02:03.000Z',
          },
        }),
    };
    const store = fakeStore({ mandatesNeedingLookup: () => Promise.resolve([lookup]) });
    const { instance } = jobs({
      store,
      resolver: resolverOf({ mandate: { ok: true, value: portOf(mandate) } }),
    });
    await instance.run('mandates');
    expect(store.called('applyMandateLookup')).toEqual([
      [
        {
          mandateId: ID(50),
          status: 'active',
          providerMandateRef: 'MANDATE-REF-1',
          observedAt: '2026-10-16T01:02:03.000Z',
        },
      ],
    ]);
  });

  it('applies nothing when the provider does not answer or does not know the mandate, and never asks a lender without a provider', async () => {
    for (const outcome of [
      { outcome: 'unknown', reason: 'timeout' },
      { outcome: 'not_found' },
      { outcome: 'rejected', reason: 'invalid_request' },
      { outcome: 'not_configured' },
    ] as const) {
      const mandate: MandateProviderPort = {
        ...createMockMandateProvider('test'),
        getMandateStatus: () => Promise.resolve(outcome),
      };
      const store = fakeStore({ mandatesNeedingLookup: () => Promise.resolve([lookup]) });
      const { instance } = jobs({
        store,
        resolver: resolverOf({ mandate: { ok: true, value: portOf(mandate) } }),
      });
      await instance.run('mandates');
      expect(store.called('applyMandateLookup')).toHaveLength(0);
    }
    const store = fakeStore({ mandatesNeedingLookup: () => Promise.resolve([lookup]) });
    const { instance, lines } = jobs({ store });
    await instance.run('mandates');
    expect(store.called('applyMandateLookup')).toHaveLength(0);
    expect(lines.join('\n')).toContain('provider_not_configured');
    expect(lines.join('\n')).not.toContain('MANDATE-REF-1');
  });

  it('asks for debit reports in a window around today (IST) and applies one call per report, with the return code only for a returned debit', async () => {
    const asked: unknown[] = [];
    const report = (
      n: number,
      status: MandateDebitReport['status'],
      code: string | null,
    ): MandateDebitReport => ({
      providerDebitRef: `DEBIT-${String(n)}`,
      providerMandateRef: 'MANDATE-REF-1',
      scheduledOn: '2026-10-17',
      amountMinor: 450_000n,
      status,
      returnCode: code,
      observedAt: '2026-10-16T00:00:00.000Z',
    });
    const mandate: MandateProviderPort = {
      ...createMockMandateProvider('test'),
      listDebitStatus: (_ctx, query) => {
        asked.push(query);
        return Promise.resolve({
          outcome: 'ok',
          value: [
            report(1, 'returned', 'R01'),
            report(2, 'settled', 'STRAY'),
            { ...report(3, 'settled', null), providerMandateRef: 'SOMEONE-ELSE' },
          ],
        });
      },
    };
    const store = fakeStore({
      activeMandates: () =>
        Promise.resolve([
          {
            mandateId: ID(50),
            lenderOrgId: LENDER,
            configId: CONFIG,
            providerMandateRef: 'MANDATE-REF-1',
          },
        ]),
    });
    const { instance } = jobs({
      store,
      resolver: resolverOf({ mandate: { ok: true, value: portOf(mandate) } }),
      // 2026-10-15 20:00 UTC is 2026-10-16 01:30 IST: the IST day, not the UTC day, is what counts.
      options: { clock: () => new Date('2026-10-15T20:00:00.000Z') },
    });
    await instance.run('mandates');
    expect(asked).toEqual([
      {
        providerMandateRef: 'MANDATE-REF-1',
        from: addDays('2026-10-16', -DEBIT_LOOKBACK_DAYS),
        to: addDays('2026-10-16', DEBIT_LOOKAHEAD_DAYS),
      },
    ]);
    const applied = store.called('applyDebitLookup').map((a) => a[0]);
    expect(applied).toHaveLength(2); // the report about another mandate is not applied
    expect(applied[0]).toMatchObject({
      providerDebitRef: 'DEBIT-1',
      status: 'returned',
      returnCode: 'R01',
      amountMinor: 450_000n,
    });
    expect(applied[1]).toMatchObject({
      providerDebitRef: 'DEBIT-2',
      status: 'settled',
      returnCode: null,
    });
  });

  it('one bad debit report does not stop the others', async () => {
    const report = (n: number): MandateDebitReport => ({
      providerDebitRef: `DEBIT-${String(n)}`,
      providerMandateRef: 'MANDATE-REF-1',
      scheduledOn: '2026-10-17',
      amountMinor: 1n,
      status: 'scheduled',
      returnCode: null,
      observedAt: '2026-10-16T00:00:00.000Z',
    });
    const mandate: MandateProviderPort = {
      ...createMockMandateProvider('test'),
      listDebitStatus: () => Promise.resolve({ outcome: 'ok', value: [report(1), report(2)] }),
    };
    let n = 0;
    const store = fakeStore({
      activeMandates: () =>
        Promise.resolve([
          {
            mandateId: ID(50),
            lenderOrgId: LENDER,
            configId: CONFIG,
            providerMandateRef: 'MANDATE-REF-1',
          },
        ]),
      applyDebitLookup: () =>
        ++n === 1
          ? Promise.reject(Object.assign(new Error('x'), { code: '22023' }))
          : Promise.resolve('applied'),
    });
    const { instance, lines } = jobs({
      store,
      resolver: resolverOf({ mandate: { ok: true, value: portOf(mandate) } }),
    });
    await instance.run('mandates');
    expect(store.called('applyDebitLookup')).toHaveLength(2);
    expect(lines.join('\n')).toContain('"sqlstate":"22023"');
  });

  it('runs sweep, closed-loan cancellation, debit planning and notices BEFORE the provider polling, each isolated (A26)', async () => {
    const store = fakeStore({ sweepMandates: () => Promise.reject(new Error('x')) });
    const { instance } = jobs({ store });
    await instance.run('mandates');
    expect(store.calls.map((c) => c.name)).toEqual([
      'sweepMandates',
      'requestCancelForClosedLoans',
      'planMandateDebits',
      'claimPreDebitNotices',
      'mandatesNeedingLookup',
      'activeMandates',
    ]);
  });

  /** Mandates the way `activeMandates` lists them, numbered so a test can see which were asked about. */
  const activeList = (count: number) =>
    Array.from({ length: count }, (_, n) => ({
      mandateId: ID(1000 + n),
      lenderOrgId: LENDER,
      configId: CONFIG,
      providerMandateRef: `REF-${String(n)}`,
    }));
  const refNumber = (ref: string | null | undefined) => Number((ref ?? '').replace('REF-', ''));

  it('asks about at most DEBIT_LOOKUPS_PER_RUN mandates per run and starts the next run with the ones it did not reach (A26)', async () => {
    const asked: number[][] = [[]];
    const mandate: MandateProviderPort = {
      ...createMockMandateProvider('test'),
      listDebitStatus: (_ctx, query) => {
        asked.at(-1)?.push(refNumber(query.providerMandateRef));
        return Promise.resolve({ outcome: 'ok', value: [] });
      },
    };
    const total = DEBIT_LOOKUPS_PER_RUN + 5;
    const store = fakeStore({ activeMandates: () => Promise.resolve(activeList(total)) });
    const { instance, lines } = jobs({
      store,
      resolver: resolverOf({ mandate: { ok: true, value: portOf(mandate) } }),
    });
    await instance.run('mandates');
    expect(asked[0]).toHaveLength(DEBIT_LOOKUPS_PER_RUN);
    expect(asked[0]?.[0]).toBe(0);
    expect(lines.join('\n')).toContain('"left_for_next_run":5');
    asked.push([]);
    await instance.run('mandates');
    // The five that were not reached come first, then the rotation goes on from the start.
    expect(asked[1]?.slice(0, 5)).toEqual([200, 201, 202, 203, 204]);
    expect(asked[1]?.[5]).toBe(0);
    expect(asked[1]).toHaveLength(DEBIT_LOOKUPS_PER_RUN);
    // Over the two runs every mandate was asked about.
    expect(new Set([...(asked[0] ?? []), ...(asked[1] ?? [])]).size).toBe(total);
  });

  it('stops polling when its time is up (a fake clock) and continues with the next mandate on the next run (A26)', async () => {
    let now = new Date('2026-10-16T10:00:00.000Z').getTime();
    const asked: number[][] = [[]];
    const callMs = MANDATE_POLLING_BUDGET_MS / 2.5; // the third call ends past the budget
    const mandate: MandateProviderPort = {
      ...createMockMandateProvider('test'),
      listDebitStatus: (_ctx, query) => {
        asked.at(-1)?.push(refNumber(query.providerMandateRef));
        now += callMs; // a slow provider
        return Promise.resolve({ outcome: 'ok', value: [] });
      },
    };
    const store = fakeStore({ activeMandates: () => Promise.resolve(activeList(7)) });
    const { instance } = jobs({
      store,
      resolver: resolverOf({ mandate: { ok: true, value: portOf(mandate) } }),
      options: { clock: () => new Date(now) },
    });
    await instance.run('mandates');
    expect(asked[0]).toEqual([0, 1, 2]);
    asked.push([]);
    await instance.run('mandates');
    expect(asked[1]).toEqual([3, 4, 5]);
    asked.push([]);
    await instance.run('mandates');
    expect(asked[2]).toEqual([6, 0, 1]);
  });

  it('the pre-debit notices are claimed before any provider call, even when the polling uses up its time (A26)', async () => {
    let now = new Date('2026-10-16T10:00:00.000Z').getTime();
    const order: string[] = [];
    const mandate: MandateProviderPort = {
      ...createMockMandateProvider('test'),
      listDebitStatus: () => {
        order.push('provider');
        now += MANDATE_POLLING_BUDGET_MS;
        return Promise.resolve({ outcome: 'ok', value: [] });
      },
    };
    const store = fakeStore({
      activeMandates: () => Promise.resolve(activeList(3)),
      claimPreDebitNotices: () => {
        order.push('notices');
        return Promise.resolve([]);
      },
    });
    const { instance } = jobs({
      store,
      resolver: resolverOf({ mandate: { ok: true, value: portOf(mandate) } }),
      options: { clock: () => new Date(now) },
    });
    await instance.run('mandates');
    expect(order[0]).toBe('notices');
    expect(order.filter((entry) => entry === 'provider')).toHaveLength(1);
  });

  it('a mandate the provider cannot find does not keep the newer ones out of the status lookups (A26)', async () => {
    const candidates = Array.from({ length: MANDATE_LOOKUPS_PER_RUN + 50 }, (_, n) => ({
      mandateId: ID(2000 + n),
      lenderOrgId: LENDER,
      configId: CONFIG,
      providerMandateRef: `REF-${String(n)}` as string | undefined,
      status: 'requires_reconciliation',
    }));
    const stuck = new Set(
      candidates.slice(0, MANDATE_LOOKUPS_PER_RUN).map((c) => c.providerMandateRef),
    );
    const mandate: MandateProviderPort = {
      ...createMockMandateProvider('test'),
      getMandateStatus: (_ctx, query) =>
        Promise.resolve(
          stuck.has(query.providerMandateRef ?? undefined)
            ? { outcome: 'not_found' }
            : {
                outcome: 'ok',
                value: {
                  source: 'provider_authenticated_lookup',
                  providerMandateRef: query.providerMandateRef ?? 'x',
                  rail: 'enach_api',
                  status: 'active',
                  maxAmountMinor: null,
                  merchantRef: null,
                  observedAt: '2026-10-16T01:02:03.000Z',
                },
              },
        ),
    };
    // The database lists them by when they last changed: the same order every time, the stuck ones first.
    const store = fakeStore({ mandatesNeedingLookup: () => Promise.resolve(candidates) });
    const { instance } = jobs({
      store,
      resolver: resolverOf({ mandate: { ok: true, value: portOf(mandate) } }),
    });
    await instance.run('mandates');
    expect(store.called('applyMandateLookup')).toHaveLength(0);
    await instance.run('mandates');
    const applied = store
      .called('applyMandateLookup')
      .map((a) => (a[0] as { mandateId: string }).mandateId);
    expect(applied).toEqual(candidates.slice(MANDATE_LOOKUPS_PER_RUN).map((c) => c.mandateId));
  });

  it('sends each pre-debit notice through in_app and push with opaque ids only and records one state', async () => {
    const notifier = createMockNotifier('test');
    const channels = createServiceChannels({ environment: 'test', push: notifier.channels.push });
    const notices: ClaimedNotice[] = [{ noticeId: ID(70), borrowerId: BORROWER }];
    const store = fakeStore({ claimPreDebitNotices: () => Promise.resolve(notices) });
    const { instance } = jobs({ store, channels });
    await instance.run('mandates');
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]?.payload).toEqual({ id: ID(70), titleKey: 'payment_update' });
    expect(store.called('recordPreDebitNotice')).toEqual([[ID(70), 'accepted', 'mock-notice-1']]);
  });

  const inApp = (result: ChannelSendResult) => ({ channel: 'in_app' as const, result });
  const push = (result: ChannelSendResult) => ({ channel: 'push' as const, result });

  it('notice outcomes: accepted only if a channel that reaches the borrower took it; the in-app inbox alone is not enough (A54)', () => {
    // push is the channel that reaches the borrower.
    expect(noticeOutcomeOf([inApp({ state: 'not_configured' }), push(accepted)])).toEqual({
      state: 'accepted',
      providerRef: null,
    });
    expect(
      noticeOutcomeOf([inApp({ state: 'failed', reason: 'invalid_request' }), push(accepted)]),
    ).toMatchObject({ state: 'accepted' });
    expect(
      noticeOutcomeOf([inApp(accepted), push({ state: 'accepted', providerRef: 'PUSH-REF-1' })]),
    ).toEqual({ state: 'accepted', providerRef: 'PUSH-REF-1' });
    // The in-app inbox accepts and writes nothing for a notice: with push not configured, nothing carried it. The database's word
    // for that is not_configured (the notice stays late and the lender is told); it is never recorded as sent.
    expect(noticeOutcomeOf([inApp(accepted), push({ state: 'not_configured' })])).toEqual({
      state: 'not_configured',
      providerRef: null,
    });
    expect(noticeOutcomeOf([inApp(accepted)])).toEqual({
      state: 'not_configured',
      providerRef: null,
    });
    expect(noticeOutcomeOf([inApp({ state: 'accepted', providerRef: 'INBOX-REF-1' })])).toEqual({
      state: 'not_configured',
      providerRef: null,
    });
    // A push that failed or did not answer may work next time: released for a retry, whatever the inbox said.
    expect(
      noticeOutcomeOf([inApp(accepted), push({ state: 'failed', reason: 'invalid_request' })]),
    ).toEqual({ state: 'failed', providerRef: null });
    expect(
      noticeOutcomeOf([inApp(accepted), push({ state: 'unknown', reason: 'timeout' })]).state,
    ).toBe('failed');
    expect(
      noticeOutcomeOf([
        inApp({ state: 'not_configured' }),
        push({ state: 'accepted', providerRef: 'https://x.invalid' }),
      ]),
    ).toEqual({ state: 'accepted', providerRef: null });
    // sms is never sent and never counts.
    expect(
      noticeOutcomeOf([{ channel: 'sms', result: accepted }, push({ state: 'not_configured' })])
        .state,
    ).toBe('not_configured');
  });

  it('with push not configured (staging, production) an accepted in-app message is NOT recorded as a notice that was sent (A54)', async () => {
    const store = fakeStore({
      claimPreDebitNotices: () => Promise.resolve([{ noticeId: ID(72), borrowerId: BORROWER }]),
    });
    const channels = channelsOf(accepted, { state: 'not_configured' });
    const { instance, lines } = jobs({ store, channels });
    await instance.run('mandates');
    expect(store.called('recordPreDebitNotice')).toEqual([[ID(72), 'not_configured', null]]);
    expect(lines.join('\n')).toContain('"not_configured":1');
    expect(lines.join('\n')).toContain('"accepted":0');
    // A push that failed is released for a retry, not recorded as late and not as sent.
    const flaky = fakeStore({
      claimPreDebitNotices: () => Promise.resolve([{ noticeId: ID(73), borrowerId: BORROWER }]),
    });
    await jobs({
      store: flaky,
      channels: channelsOf(accepted, { state: 'unknown', reason: 'timeout' }),
    }).instance.run('mandates');
    expect(flaky.called('recordPreDebitNotice')).toEqual([[ID(73), 'failed', null]]);
  });

  it('a notice no channel could carry is recorded as not_configured and the delivery is never claimed', async () => {
    const store = fakeStore({
      claimPreDebitNotices: () => Promise.resolve([{ noticeId: ID(71), borrowerId: BORROWER }]),
    });
    const channels = channelsOf({ state: 'not_configured' }, { state: 'not_configured' });
    const { instance } = jobs({ store, channels });
    await instance.run('mandates');
    expect(store.called('recordPreDebitNotice')).toEqual([[ID(71), 'not_configured', null]]);
  });
});

// ---- configuration, links ---------------------------------------------------------------------------------------------------
describe('configuration revalidation and hand-off links', () => {
  it('calls the database functions and logs counts only', async () => {
    const store = fakeStore({
      revalidatePaymentConfigs: () => Promise.resolve({ checked: 3, notOk: 1, suspended: 1 }),
      purgeHandoffLinks: () => Promise.resolve(4),
    });
    const { instance, lines } = jobs({ store });
    await instance.run('payment_configs');
    await instance.run('handoff_links');
    expect(store.called('revalidatePaymentConfigs')).toHaveLength(1);
    expect(store.called('purgeHandoffLinks')).toHaveLength(1);
    const text = lines.join('\n');
    expect(text).toContain('"suspended":1');
    expect(text).toContain('"purged":4');
  });
});

// ---- reconciliation ---------------------------------------------------------------------------------------------------------
describe('reconciliation', () => {
  const at = (iso: string) => ({ clock: () => new Date(iso) });
  const settlementPort = (calls: string[], date?: string): PaymentProviderPort => ({
    ...createMockPaymentProvider('test'),
    fetchSettlements: (_ctx, requested) => {
      calls.push(requested);
      return Promise.resolve({
        outcome: 'ok',
        value: {
          date: date ?? requested,
          batches: [
            {
              batchRef: 'B-1',
              settlementRef: 'UTR-0001',
              periodFrom: requested,
              periodTo: requested,
              destinationMaskedRef: 'XXXXXX1234',
              grossMinor: 1_000_050n,
              feeMinor: 50n,
              taxMinor: 0n,
              netMinor: 1_000_000n,
              items: [
                {
                  providerPaymentRef: 'PAY-1',
                  orderRef: null,
                  grossMinor: 1_000_050n,
                  feeMinor: 50n,
                  taxMinor: 0n,
                  netMinor: 1_000_000n,
                },
              ],
            },
          ],
        },
      });
    },
  });
  const setup = (
    iso: string,
    extra: Partial<JobsStore> = {},
    port: PaymentProviderPort = settlementPort([]),
  ) => {
    const store = fakeStore({ activeCollectionConfigs: () => Promise.resolve([FACTS]), ...extra });
    const resolver = resolverOf({ payment: { ok: true, value: portOf(port) } });
    return { ...jobs({ store, resolver, options: at(iso) }), store };
  };

  it('does nothing before 20:00 IST and does its work from 20:00 IST on, judged in Indian time', async () => {
    // 19:59 IST, 14:29 UTC
    const early = setup('2026-10-16T14:29:00.000Z');
    await early.instance.run('reconciliation');
    expect(early.store.calls).toHaveLength(0);
    // 20:00 IST, 14:30 UTC
    const onTime = setup('2026-10-16T14:30:00.000Z');
    await onTime.instance.run('reconciliation');
    expect(onTime.store.called('runReconciliation')).toHaveLength(2);
    // 23:59 IST still counts as the same IST day; 00:00 IST the next day is before 20:00 again.
    const late = setup('2026-10-16T18:29:00.000Z');
    await late.instance.run('reconciliation');
    expect(late.store.called('runReconciliation').map((a) => a[1])).toEqual([
      '2026-10-15',
      '2026-10-16',
    ]);
    const midnight = setup('2026-10-16T18:30:00.000Z');
    await midnight.instance.run('reconciliation');
    expect(midnight.store.calls).toHaveLength(0);
  });

  it('for the previous and the current report date not yet done: fetch, record the report as digit strings, then run', async () => {
    const fetched: string[] = [];
    const { instance, store } = setup('2026-10-16T15:00:00.000Z', {}, settlementPort(fetched));
    await instance.run('reconciliation');
    expect(fetched).toEqual(['2026-10-15', '2026-10-16']);
    expect(store.called('reconciledDates')).toEqual([[LENDER, ['2026-10-15', '2026-10-16']]]);
    expect(
      store.calls
        .map((c) => c.name)
        .filter((n) => n !== 'activeCollectionConfigs' && n !== 'reconciledDates'),
    ).toEqual([
      'recordSettlementReport',
      'runReconciliation',
      'recordSettlementReport',
      'runReconciliation',
    ]);
    const [configId, date, batches] = store.called('recordSettlementReport')[1] ?? [];
    expect(configId).toBe(CONFIG);
    expect(date).toBe('2026-10-16');
    expect(batches).toEqual([
      {
        batchRef: 'B-1',
        settlementRef: 'UTR-0001',
        periodFrom: '2026-10-16',
        periodTo: '2026-10-16',
        destinationMaskedRef: 'XXXXXX1234',
        grossMinor: '1000050',
        feeMinor: '50',
        taxMinor: '0',
        netMinor: '1000000',
        items: [
          {
            providerPaymentRef: 'PAY-1',
            orderRef: null,
            grossMinor: '1000050',
            feeMinor: '50',
            taxMinor: '0',
            netMinor: '1000000',
          },
        ],
      },
    ]);
    expect(store.called('runReconciliation')).toEqual([
      [LENDER, '2026-10-15'],
      [LENDER, '2026-10-16'],
    ]);
  });

  it('a date the database already has a run for is not fetched or run again, so a second check the same day does nothing', async () => {
    const fetched: string[] = [];
    const { instance, store } = setup(
      '2026-10-16T15:00:00.000Z',
      { reconciledDates: () => Promise.resolve(new Set(['2026-10-15', '2026-10-16'])) },
      settlementPort(fetched),
    );
    await instance.run('reconciliation');
    expect(fetched).toEqual([]);
    expect(store.called('runReconciliation')).toHaveLength(0);
    const half = setup(
      '2026-10-16T15:00:00.000Z',
      { reconciledDates: () => Promise.resolve(new Set(['2026-10-15'])) },
      settlementPort(fetched),
    );
    await half.instance.run('reconciliation');
    expect(fetched).toEqual(['2026-10-16']);
  });

  it('a provider that cannot report settlements is not asked; the run still happens and reports the source as not reconcilable', async () => {
    const base = settlementPort([]);
    const fetched: string[] = [];
    const port: PaymentProviderPort = {
      ...base,
      capabilities: { ...base.capabilities, settlementReports: false },
      fetchSettlements: (...a) => (fetched.push('x'), base.fetchSettlements(...a)),
    };
    const { instance, store } = setup('2026-10-16T15:00:00.000Z', {}, port);
    await instance.run('reconciliation');
    expect(fetched).toEqual([]);
    expect(store.called('recordSettlementReport')).toHaveLength(0);
    expect(store.called('runReconciliation')).toHaveLength(2);
  });

  it('a report that cannot be obtained leaves the date undone: no run is made on a half-known day', async () => {
    const port: PaymentProviderPort = {
      ...settlementPort([]),
      fetchSettlements: () => Promise.resolve({ outcome: 'unknown', reason: 'timeout' }),
    };
    const { instance, store, lines } = setup('2026-10-16T15:00:00.000Z', {}, port);
    await instance.run('reconciliation');
    expect(store.called('runReconciliation')).toHaveLength(0);
    expect(lines.join('\n')).toContain('settlement report not obtained');
  });

  it('a report dated differently from the one asked for is not recorded', async () => {
    const { instance, store } = setup(
      '2026-10-16T15:00:00.000Z',
      {},
      settlementPort([], '2020-01-01'),
    );
    await instance.run('reconciliation');
    expect(store.called('recordSettlementReport')).toHaveLength(0);
    expect(store.called('runReconciliation')).toHaveLength(0);
  });

  it('a lender the resolver cannot serve gets no call and no run; another lender is not affected', async () => {
    const other: PaymentConfigFacts = { ...FACTS, configId: ID(900), lenderOrgId: ID(901) };
    const fetched: string[] = [];
    const store = fakeStore({ activeCollectionConfigs: () => Promise.resolve([FACTS, other]) });
    const resolver: ProviderResolver = {
      payment: (row) =>
        row.lenderOrgId === LENDER
          ? { ok: false, reason: 'secret_missing' }
          : { ok: true, value: portOf(settlementPort(fetched)) },
      mandate: () => ({ ok: false, reason: 'provider_not_configured' }),
    };
    const { instance } = jobs({ store, resolver, options: at('2026-10-16T15:00:00.000Z') });
    await instance.run('reconciliation');
    expect(store.called('runReconciliation').map((a) => a[0])).toEqual([ID(901), ID(901)]);
  });

  it('a lender whose step fails does not stop the next lender', async () => {
    const other: PaymentConfigFacts = { ...FACTS, configId: ID(900), lenderOrgId: ID(901) };
    let first = true;
    const store = fakeStore({
      activeCollectionConfigs: () => Promise.resolve([FACTS, other]),
      reconciledDates: () =>
        first
          ? ((first = false), Promise.reject(new Error('x')))
          : Promise.resolve(new Set<string>()),
    });
    const { instance } = jobs({
      store,
      resolver: resolverOf({ payment: { ok: true, value: portOf(settlementPort([])) } }),
      options: at('2026-10-16T15:00:00.000Z'),
    });
    await instance.run('reconciliation');
    expect(store.called('runReconciliation').map((a) => a[0])).toEqual([ID(901), ID(901)]);
  });

  it('settlementBatchesJson keeps every amount as a string of digits and nothing as a float', () => {
    const json = settlementBatchesJson({
      date: '2026-10-16',
      batches: [
        {
          batchRef: 'B',
          settlementRef: 'UTR-1234',
          periodFrom: '2026-10-16',
          periodTo: '2026-10-16',
          destinationMaskedRef: null,
          grossMinor: 99_999_999_999_999n,
          feeMinor: 0n,
          taxMinor: 0n,
          netMinor: 99_999_999_999_999n,
          items: [],
        },
      ],
    });
    expect(JSON.stringify(json)).toContain('"grossMinor":"99999999999999"');
    expect(json[0]?.destinationMaskedRef).toBeNull();
  });
});

describe('Indian calendar helpers', () => {
  it('istNow', () => {
    expect(istNow(new Date('2026-10-16T14:29:59.999Z'))).toEqual({
      date: '2026-10-16',
      minuteOfDay: 19 * 60 + 59,
    });
    expect(istNow(new Date('2026-10-16T14:30:00.000Z'))).toEqual({
      date: '2026-10-16',
      minuteOfDay: 20 * 60,
    });
    expect(istNow(new Date('2026-10-16T18:30:00.000Z'))).toEqual({
      date: '2026-10-17',
      minuteOfDay: 0,
    });
    expect(istNow(new Date('2026-12-31T18:29:00.000Z'))).toEqual({
      date: '2026-12-31',
      minuteOfDay: 23 * 60 + 59,
    });
  });
  it('addDays crosses month and year ends', () => {
    expect(addDays('2026-10-01', -1)).toBe('2026-09-30');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
  });
});

// ---- log hygiene over a whole busy tick ---------------------------------------------------------------------------------------
describe('nothing personal in a log line', () => {
  it('a full set of runs with personal-looking values around logs none of them', async () => {
    const canaries = [
      '9876543210',
      '123456789012',
      'https://pay.invalid/secret-link',
      'Rahul Sharma',
      'ABCDE1234F',
    ];
    const notifier = createMockNotifier('test');
    const mandate: MandateProviderPort = {
      ...createMockMandateProvider('test'),
      getMandateStatus: () => Promise.reject(new Error(canaries.join(' '))),
      listDebitStatus: () => Promise.reject(new Error(canaries.join(' '))),
    };
    const payment: PaymentProviderPort = {
      ...createMockPaymentProvider('test'),
      getOrderStatus: () => Promise.reject(new Error(canaries.join(' '))),
      fetchSettlements: () => Promise.reject(new Error(canaries.join(' '))),
    };
    const store = fakeStore({
      planReminders: () => Promise.reject(new Error(canaries.join(' '))),
      claimDueReminders: () =>
        Promise.resolve([{ reminderId: ID(1), borrowerId: BORROWER, channel: 'push' }]),
      expiryCandidates: () =>
        Promise.resolve({
          cutoff: 'x',
          candidates: [
            {
              intentId: ID(2),
              lenderOrgId: LENDER,
              configId: CONFIG,
              providerOrderRef: 'ORDER-X',
              linkExpiresAt: 'x',
              ageSeconds: 1,
            },
          ],
        }),
      mandatesNeedingLookup: () =>
        Promise.resolve([
          {
            mandateId: ID(3),
            lenderOrgId: LENDER,
            configId: CONFIG,
            providerMandateRef: 'M-1',
            status: 'registration_pending',
          },
        ]),
      activeMandates: () =>
        Promise.resolve([
          { mandateId: ID(3), lenderOrgId: LENDER, configId: CONFIG, providerMandateRef: 'M-1' },
        ]),
      sweepMandates: () =>
        Promise.reject(Object.assign(new Error(canaries.join(' ')), { code: 'XX000' })),
      activeCollectionConfigs: () => Promise.resolve([FACTS]),
    });
    const { instance, lines } = jobs({
      store,
      channels: createServiceChannels({ environment: 'test', push: notifier.channels.push }),
      resolver: resolverOf({
        payment: { ok: true, value: portOf(payment) },
        mandate: { ok: true, value: portOf(mandate) },
      }),
      options: { clock: () => new Date('2026-10-16T15:00:00.000Z') },
    });
    for (const name of instance.names) await instance.run(name);
    expect(lines.length).toBeGreaterThan(0);
    const text = lines.join('\n');
    for (const canary of canaries) expect(text).not.toContain(canary);
    expect(text).not.toMatch(/\b[6-9][0-9]{9}\b/); // a phone-shaped number
    expect(text).not.toContain('ORDER-X');
    expect(text).not.toContain('M-1');
  });
});

// ---- the servicing event handlers ---------------------------------------------------------------------------------------------
describe('servicing event handlers', () => {
  const event = { id: ID(1) } as OutboxEvent;
  const handlersOf = (store: JobsStore, log?: WorkerLogger) =>
    createServicingHandlers({ pool: fakePool, store, ...(log ? { log } : {}) });

  it('has a handler for every servicing event the database enqueues', () => {
    expect(Object.keys(handlersOf(fakeStore())).sort()).toEqual([
      'servicing.import.committed',
      'servicing.loan_closed',
      'servicing.sync_conflict.opened',
    ]);
  });

  it('validates the payloads strictly: extra fields, missing fields and non-uuid ids are refused', () => {
    const handlers = handlersOf(fakeStore());
    const closed = handlers['servicing.loan_closed']?.schema;
    const ok = { closure_id: ID(1), loan_account_id: ID(2), lender_org_id: LENDER };
    expect(closed?.safeParse(ok).success).toBe(true);
    expect(closed?.safeParse({ ...ok, phone: '9876543210' }).success).toBe(false);
    expect(closed?.safeParse({ loan_account_id: ID(2) }).success).toBe(false);
    expect(closed?.safeParse({ ...ok, loan_account_id: 'not-a-uuid' }).success).toBe(false);
    const committed = handlers['servicing.import.committed']?.schema;
    expect(committed?.safeParse({ batch_id: ID(1), lender_org_id: LENDER }).success).toBe(true);
    expect(committed?.safeParse({ batch_id: ID(1), lender_org_id: LENDER, rows: [] }).success).toBe(
      false,
    );
    const conflict = handlers['servicing.sync_conflict.opened']?.schema;
    expect(conflict?.safeParse({ conflict_id: ID(1), lender_org_id: LENDER }).success).toBe(true);
    expect(conflict?.safeParse({ conflict_id: ID(1) }).success).toBe(false);
  });

  it('servicing.loan_closed suppresses the loan reminders and requests mandate cancellation, in one call', async () => {
    const store = fakeStore({
      suppressAndCancelForClosedLoan: () => Promise.resolve({ suppressed: 2, cancelRequested: 1 }),
    });
    const { log, lines } = captureLog();
    await handlersOf(store, log)['servicing.loan_closed']?.run(
      { closure_id: ID(1), loan_account_id: ID(2), lender_org_id: LENDER },
      event,
    );
    expect(store.called('suppressAndCancelForClosedLoan')).toEqual([[ID(2)]]);
    expect(lines.join('\n')).toContain('"suppressed":2');
    expect(lines.join('\n')).not.toContain(ID(2));
  });

  it('servicing.import.committed completes disbursements for that lender only, and logs a count', async () => {
    const store = fakeStore({ completeDisbursements: () => Promise.resolve(3) });
    const { log, lines } = captureLog();
    await handlersOf(store, log)['servicing.import.committed']?.run(
      { batch_id: ID(1), lender_org_id: LENDER },
      event,
    );
    expect(store.called('completeDisbursements')).toEqual([[LENDER]]);
    expect(lines.join('\n')).toContain('"disbursed":3');
    expect(lines.join('\n')).not.toContain(LENDER);
  });

  it('servicing.sync_conflict.opened is acknowledged and touches nothing', async () => {
    const store = fakeStore();
    await handlersOf(store)['servicing.sync_conflict.opened']?.run(
      { conflict_id: ID(1), lender_org_id: LENDER },
      event,
    );
    expect(store.calls).toHaveLength(0);
  });

  it('a database failure is raised, so the worker retries the event', async () => {
    const store = fakeStore({
      suppressAndCancelForClosedLoan: () => Promise.reject(new Error('down')),
    });
    await expect(
      handlersOf(store)['servicing.loan_closed']?.run(
        { closure_id: ID(1), loan_account_id: ID(2), lender_org_id: LENDER },
        event,
      ),
    ).rejects.toThrow();
    const failing = fakeStore({ completeDisbursements: () => Promise.reject(new Error('down')) });
    await expect(
      handlersOf(failing)['servicing.import.committed']?.run(
        { batch_id: ID(1), lender_org_id: LENDER },
        event,
      ),
    ).rejects.toThrow();
  });
});
