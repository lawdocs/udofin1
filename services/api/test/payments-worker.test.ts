// Unit tests for the payments worker: the provider resolver (every environment and mode, secret handling) and the four outbox
// handlers against a fake processor and the labelled mock providers. No database here; the integration file runs the same
// handlers against a real migrated Postgres. Synthetic values only.
import { randomBytes, randomUUID } from 'node:crypto';
import {
  createMockMandateProvider,
  createMockPaymentProvider,
  openHandoffLink,
  type AppEnvironment,
  type HandoffKeyring,
  type MandateProviderPort,
  type PaymentProviderPort,
} from '@udofin/adapters';
import { describe, expect, it } from 'vitest';
import {
  type ApplyEventResult,
  type MandateHandoffOutcome,
  type MandateRecord,
  type OrderFailureClass,
  type PaymentConfigRecord,
  type PaymentIntentRecord,
  type PaymentsProcessor,
} from '../src/system/payments.js';
import { type SystemPool } from '../src/system/pool.js';
import {
  type OutboxEvent,
  type WorkerLogger,
  PermanentError,
} from '../src/workers/outbox-worker.js';
import {
  createPaymentsHandlers,
  OrderOutcomeUnresolvedError,
} from '../src/workers/payments-handlers.js';
import {
  createProviderResolver,
  createProviderResolverWith,
  type PaymentConfigRow,
  type ProviderResolver,
  type ResolvedPort,
} from '../src/workers/provider-resolver.js';

const LENDER = randomUUID();
const INTENT = randomUUID();
const MANDATE = randomUUID();
const MERCHANT = 'SAMPLE-MERCHANT-UNIT';
const SECRET_VALUE = `unit-secret-${randomBytes(12).toString('hex')}`;
const ALL_ENVIRONMENTS: readonly AppEnvironment[] = ['local', 'test', 'staging', 'production'];

const row = (over: Partial<PaymentConfigRow> = {}): PaymentConfigRow => ({
  configId: randomUUID(),
  lenderOrgId: LENDER,
  provider: 'mock_gateway',
  providerMode: 'mock',
  merchantRef: MERCHANT,
  secretRef: 'SAMPLE_SECRET',
  webhookSecretRef: 'SAMPLE_WEBHOOK_SECRET',
  ...over,
});

describe('createProviderResolver: environment x mode', () => {
  const secrets: string[] = [];
  const secret = (name: string) => {
    secrets.push(name);
    return SECRET_VALUE;
  };

  for (const environment of ALL_ENVIRONMENTS) {
    const mocksAllowed = environment === 'local' || environment === 'test';
    describe(environment, () => {
      const resolver = createProviderResolver({ environment, secret });

      it(`mock mode: ${mocksAllowed ? 'a labelled mock' : 'refused'}`, () => {
        const config = row({ providerMode: 'mock' });
        const payment = resolver.payment(config);
        const mandate = resolver.mandate(config);
        if (mocksAllowed) {
          expect(payment.ok && payment.value.port.descriptor).toMatchObject({
            key: 'mock_payment_provider',
            mode: 'mock',
          });
          expect(mandate.ok && mandate.value.port.descriptor).toMatchObject({
            key: 'mock_mandate_provider',
            mode: 'mock',
          });
        } else {
          expect(payment).toEqual({ ok: false, reason: 'mock_not_allowed_here' });
          expect(mandate).toEqual({ ok: false, reason: 'mock_not_allowed_here' });
        }
      });

      for (const providerMode of ['sandbox', 'live'] as const) {
        it(`${providerMode} mode: the unconfigured placeholder, every call answers not_configured`, async () => {
          const config = row({ providerMode });
          const payment = resolver.payment(config);
          const mandate = resolver.mandate(config);
          if (!payment.ok || !mandate.ok) throw new Error('expected a placeholder');
          expect(payment.value.port.descriptor.key).toMatch(/_not_configured$/);
          expect(mandate.value.port.descriptor.key).toMatch(/_not_configured$/);
          const ctx = payment.value.contextFor('corr', 'key');
          expect(
            await payment.value.port.createOrder(ctx, {
              operationKey: INTENT,
              receiptRef: INTENT,
              merchantRef: MERCHANT,
              amountMinor: 100n,
              currency: 'INR',
              purpose: 'installment',
              expiresAt: null,
            }),
          ).toEqual({ outcome: 'not_configured' });
          expect(
            await payment.value.port.getOrderStatus(ctx, { orderRef: null, operationKey: INTENT }),
          ).toEqual({
            outcome: 'not_configured',
          });
          expect(
            await mandate.value.port.createMandateRequest(ctx, {
              operationKey: MANDATE,
              rail: 'enach_api',
              merchantRef: MERCHANT,
              maxAmountMinor: 100n,
              currency: 'INR',
              startDate: '2026-11-01',
              endDate: '2027-11-01',
              maskedAccountRef: 'XXXXXX1234',
            }),
          ).toEqual({ outcome: 'not_configured' });
        });
      }
    });
  }

  it('never reads a secret when no real adapter exists (sandbox and live placeholders, mocks)', () => {
    expect(secrets).toEqual([]);
  });

  it('refuses a configuration that names no provider or an unknown mode', () => {
    const resolver = createProviderResolver({ environment: 'test', secret });
    expect(resolver.payment(row({ provider: '' }))).toEqual({
      ok: false,
      reason: 'provider_not_configured',
    });
    expect(resolver.mandate(row({ providerMode: 'production' as unknown as 'live' }))).toEqual({
      ok: false,
      reason: 'provider_not_configured',
    });
  });

  it('builds the call context with the lender as tenant and passes the idempotency key only when given', () => {
    const resolver = createProviderResolver({ environment: 'test', secret });
    const resolved = resolver.payment(row());
    if (!resolved.ok) throw new Error('expected a port');
    expect(resolved.value.contextFor('corr-1', 'key-1')).toEqual({
      tenantId: LENDER,
      correlationId: 'corr-1',
      idempotencyKey: 'key-1',
    });
    expect(resolved.value.contextFor('corr-2')).toEqual({
      tenantId: LENDER,
      correlationId: 'corr-2',
    });
  });

  it('keeps one mock per configuration, so a retried delivery meets the provider it met before', () => {
    const resolver = createProviderResolver({ environment: 'test', secret });
    const config = row();
    const a = resolver.payment(config);
    const b = resolver.payment(config);
    const other = resolver.payment(row());
    if (!a.ok || !b.ok || !other.ok) throw new Error('expected ports');
    expect(a.value.port).toBe(b.value.port);
    expect(a.value.port).not.toBe(other.value.port);
  });
});

describe('createProviderResolverWith: secrets of a real adapter (none exists yet; the rules are fixed first)', () => {
  const received: string[] = [];
  const fakeRealPayment = (secret: string): PaymentProviderPort => {
    received.push(secret);
    return {
      ...createMockPaymentProvider('test'),
      descriptor: { key: 'real_like', capability: 'payment_collection', mode: 'production' },
    };
  };

  it('reads the secret by the NAME in the configuration and refuses when it is missing or empty', () => {
    const asked: string[] = [];
    const resolver = createProviderResolverWith(
      { environment: 'production', secret: (name) => (asked.push(name), undefined) },
      { real_gateway: { payment: fakeRealPayment } },
    );
    const config = row({
      provider: 'real_gateway',
      providerMode: 'live',
      secretRef: 'REAL_GATEWAY_KEY',
    });
    expect(resolver.payment(config)).toEqual({ ok: false, reason: 'secret_missing' });
    expect(asked).toEqual(['REAL_GATEWAY_KEY']);
    const empty = createProviderResolverWith(
      { environment: 'production', secret: () => '' },
      { real_gateway: { payment: fakeRealPayment } },
    );
    expect(empty.payment(config)).toEqual({ ok: false, reason: 'secret_missing' });
  });

  it('bounds every port it hands out: a call that never answers ends as an unknown outcome (timeout)', async () => {
    const hanging: PaymentProviderPort = {
      ...createMockPaymentProvider('test'),
      getOrderStatus: () => new Promise(() => undefined),
    };
    const resolver = createProviderResolverWith(
      { environment: 'production', secret: () => SECRET_VALUE, providerTimeoutMs: 20 },
      { real_gateway: { payment: () => hanging } },
    );
    const resolved = resolver.payment(row({ provider: 'real_gateway', providerMode: 'live' }));
    if (!resolved.ok) throw new Error('expected a port');
    await expect(
      resolved.value.port.getOrderStatus(resolved.value.contextFor('corr-1'), {
        orderRef: null,
        operationKey: 'key-1',
      }),
    ).resolves.toEqual({ outcome: 'unknown', reason: 'timeout' });
  });

  it('gives the adapter the secret and never returns, names or logs it', () => {
    const resolver = createProviderResolverWith(
      { environment: 'production', secret: () => SECRET_VALUE },
      { real_gateway: { payment: fakeRealPayment } },
    );
    const resolved = resolver.payment(row({ provider: 'real_gateway', providerMode: 'live' }));
    expect(resolved.ok).toBe(true);
    expect(received).toEqual([SECRET_VALUE]);
    if (!resolved.ok) return;
    // Only enumerable data of what the resolver itself returns: the port is the adapter's own object.
    expect(
      JSON.stringify({ ok: resolved.ok, context: resolved.value.contextFor('c', 'k') }),
    ).not.toContain(SECRET_VALUE);
    // Another provider key has no adapter: the placeholder, and its secret is not even asked for.
    const asked: string[] = [];
    const placeholder = createProviderResolverWith(
      { environment: 'production', secret: (name) => (asked.push(name), SECRET_VALUE) },
      { real_gateway: { payment: fakeRealPayment } },
    ).payment(row({ provider: 'other_gateway', providerMode: 'live' }));
    expect(placeholder.ok && placeholder.value.port.descriptor.key).toMatch(/_not_configured$/);
    expect(asked).toEqual([]);
  });

  it('a factory that throws with the secret in its message yields a closed reason, not the message', () => {
    const resolver = createProviderResolverWith(
      { environment: 'production', secret: () => SECRET_VALUE },
      {
        real_gateway: {
          payment: (secret) => {
            throw new Error(`bad key ${secret}`);
          },
        },
      },
    );
    const result = resolver.payment(row({ provider: 'real_gateway', providerMode: 'live' }));
    expect(result).toEqual({ ok: false, reason: 'provider_not_configured' });
    expect(JSON.stringify(result)).not.toContain(SECRET_VALUE);
  });

  it('a mock configuration never reaches a real adapter or a secret', () => {
    const asked: string[] = [];
    const resolver = createProviderResolverWith(
      { environment: 'test', secret: (name) => (asked.push(name), SECRET_VALUE) },
      { real_gateway: { payment: fakeRealPayment } },
    );
    const resolved = resolver.payment(row({ provider: 'real_gateway', providerMode: 'mock' }));
    expect(resolved.ok && resolved.value.port.descriptor.mode).toBe('mock');
    expect(asked).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------------------------------------

const keyring: HandoffKeyring = {
  activeVersion: 'k1',
  keys: new Map([['k1', new Uint8Array(randomBytes(32))]]),
};
const NOW = new Date('2026-10-16T10:00:00.000Z');
const plus = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const noPool: SystemPool = {
  withSystem: () => Promise.reject(new Error('no database in a unit test')),
  end: () => Promise.resolve(),
};

function config(over: Partial<PaymentConfigRecord> = {}): PaymentConfigRecord {
  return {
    configId: randomUUID(),
    lenderOrgId: LENDER,
    status: 'active',
    provider: 'mock_gateway',
    providerMode: 'mock',
    merchantRef: MERCHANT,
    secretRef: 'SAMPLE_SECRET',
    webhookSecretRef: 'SAMPLE_WEBHOOK_SECRET',
    ...over,
  };
}
function intentRecord(over: Partial<PaymentIntentRecord> = {}): PaymentIntentRecord {
  return {
    id: INTENT,
    lenderOrgId: LENDER,
    status: 'created',
    amountMinor: 475_000n,
    purpose: 'installment',
    linkExpiresAt: plus(HOUR),
    providerOrderRef: null,
    config: config(),
    ...over,
  };
}
function mandateRecord(over: Partial<MandateRecord> = {}): MandateRecord {
  return {
    id: MANDATE,
    lenderOrgId: LENDER,
    status: 'draft',
    rail: 'enach_api',
    creditorRef: MERCHANT,
    providerMandateRef: null,
    maxAmountMinor: 4_000_000n,
    startDate: '2026-11-01',
    endDate: '2027-11-01',
    maskedAccountRef: 'XXXXXX1234',
    cancelRequested: false,
    cancelSent: false,
    config: config(),
    ...over,
  };
}
const event = (over: Partial<OutboxEvent> = {}): OutboxEvent => ({
  id: randomUUID(),
  event_type: 'test',
  payload: {},
  payload_version: 1,
  attempts: 1,
  max_attempts: 8,
  correlation_id: null,
  ...over,
});
const sqlError = (code: string, hint?: string): Error =>
  Object.assign(new Error('database refused, with data in its message: 9100000000'), {
    code,
    ...(hint === undefined ? {} : { hint }),
  });

type Call = readonly [string, ...unknown[]];
interface FakeProcessor extends PaymentsProcessor {
  readonly calls: Call[];
  intent: PaymentIntentRecord | undefined;
  mandate: MandateRecord | undefined;
  failures: Partial<Record<string, Error>>;
  results: { handoff: string; applied: ApplyEventResult };
}

function fakeProcessor(init: {
  intent?: PaymentIntentRecord | undefined;
  mandate?: MandateRecord | undefined;
}): FakeProcessor {
  const calls: Call[] = [];
  const p: FakeProcessor = {
    calls,
    intent: 'intent' in init ? init.intent : intentRecord(),
    mandate: 'mandate' in init ? init.mandate : mandateRecord(),
    failures: {},
    results: { handoff: 'registration_pending', applied: { outcome: 'applied', reason: 'x' } },
    loadIntent(id) {
      calls.push(['loadIntent', id]);
      return Promise.resolve(p.intent);
    },
    recordOrderCreated(id, ref, expiry) {
      calls.push(['recordOrderCreated', id, ref, expiry]);
      const failure = p.failures.recordOrderCreated;
      if (failure) return Promise.reject(failure);
      if (p.intent) p.intent = { ...p.intent, status: 'pending', providerOrderRef: ref };
      return Promise.resolve('pending');
    },
    recordOrderFailed(id, reason: OrderFailureClass) {
      calls.push(['recordOrderFailed', id, reason]);
      const failure = p.failures.recordOrderFailed;
      if (failure) return Promise.reject(failure);
      if (p.intent) p.intent = { ...p.intent, status: 'failed' };
      return Promise.resolve('failed');
    },
    storeHandoffLink(input) {
      calls.push(['storeHandoffLink', input]);
      const failure = p.failures.storeHandoffLink;
      return failure ? Promise.reject(failure) : Promise.resolve();
    },
    applyProviderEvent(id) {
      calls.push(['applyProviderEvent', id]);
      const failure = p.failures.applyProviderEvent;
      return failure ? Promise.reject(failure) : Promise.resolve(p.results.applied);
    },
    loadMandate(id) {
      calls.push(['loadMandate', id]);
      return Promise.resolve(p.mandate);
    },
    recordMandateHandoff(id, outcome: MandateHandoffOutcome, ref, expiry) {
      calls.push(['recordMandateHandoff', id, outcome, ref, expiry]);
      const failure =
        p.failures[`recordMandateHandoff:${outcome}`] ?? p.failures.recordMandateHandoff;
      if (failure) return Promise.reject(failure);
      return Promise.resolve(p.results.handoff);
    },
    markMandateCancelSent(id) {
      calls.push(['markMandateCancelSent', id]);
      const failure = p.failures.markMandateCancelSent;
      return failure ? Promise.reject(failure) : Promise.resolve();
    },
  };
  return p;
}
const names = (p: FakeProcessor) => p.calls.map((c) => c[0]);

interface LogLine {
  level: string;
  fields: Record<string, unknown>;
  message: string;
}
function capture() {
  const lines: LogLine[] = [];
  const log: WorkerLogger = {
    info: (fields, message) => lines.push({ level: 'info', fields, message }),
    warn: (fields, message) => lines.push({ level: 'warn', fields, message }),
    error: (fields, message) => lines.push({ level: 'error', fields, message }),
  };
  return { lines, log, text: () => JSON.stringify(lines) };
}

function resolverOf(ports: { payment?: PaymentProviderPort; mandate?: MandateProviderPort }) {
  const asked: PaymentConfigRow[] = [];
  const wrap = <P>(port: P): ResolvedPort<P> => ({
    port,
    contextFor: (correlationId, idempotencyKey) => ({
      tenantId: LENDER,
      correlationId,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    }),
  });
  const resolver: ProviderResolver = {
    payment: (c) => {
      asked.push(c);
      return ports.payment
        ? { ok: true, value: wrap(ports.payment) }
        : { ok: false, reason: 'provider_not_configured' };
    },
    mandate: (c) => {
      asked.push(c);
      return ports.mandate
        ? { ok: true, value: wrap(ports.mandate) }
        : { ok: false, reason: 'provider_not_configured' };
    },
  };
  return { resolver, asked };
}

function setup(
  init: Parameters<typeof fakeProcessor>[0],
  ports: Parameters<typeof resolverOf>[0],
  options: { keyring?: HandoffKeyring | undefined; timeoutMs?: number } = {},
) {
  const processor = fakeProcessor(init);
  const logs = capture();
  const { resolver, asked } = resolverOf(ports);
  const handlers = createPaymentsHandlers({
    pool: noPool,
    providers: resolver,
    keyring: 'keyring' in options ? options.keyring : keyring,
    processor,
    log: logs.log,
    now: () => NOW,
    ...(options.timeoutMs === undefined ? {} : { providerTimeoutMs: options.timeoutMs }),
  });
  const run = (type: string, payload: unknown, ev: OutboxEvent = event()) => {
    const handler = handlers[type];
    if (!handler) throw new Error(`no handler ${type}`);
    return handler.run(handler.schema.parse(payload), ev);
  };
  return { processor, logs, run, asked, handlers };
}

const paymentPort = (scenario?: Parameters<typeof createMockPaymentProvider>[1]) =>
  createMockPaymentProvider('test', scenario);

describe('handlers: the set and the payloads', () => {
  it('registers exactly the four event types the database enqueues', () => {
    const { handlers } = setup({}, {});
    expect(Object.keys(handlers).sort()).toEqual([
      'mandate.cancel',
      'mandate.handoff',
      'payment.apply_event',
      'payment.create_order',
    ]);
  });

  it('payloads are strict: ids only, no extra key, a real uuid', () => {
    const { handlers } = setup({}, {});
    const schema = (type: string) => {
      const handler = handlers[type];
      if (!handler) throw new Error(type);
      return handler.schema;
    };
    expect(schema('payment.create_order').safeParse({ intent_id: INTENT }).success).toBe(true);
    expect(
      schema('payment.create_order').safeParse({ intent_id: INTENT, phone: '9100000000' }).success,
    ).toBe(false);
    expect(schema('payment.create_order').safeParse({ intent_id: 'not-a-uuid' }).success).toBe(
      false,
    );
    expect(schema('payment.create_order').safeParse({}).success).toBe(false);
    expect(schema('payment.apply_event').safeParse({ event_id: INTENT }).success).toBe(true);
    expect(schema('payment.apply_event').safeParse({ intent_id: INTENT }).success).toBe(false);
    expect(schema('mandate.handoff').safeParse({ mandate_id: MANDATE }).success).toBe(true);
    expect(schema('mandate.handoff').safeParse({ mandate_id: MANDATE, link: 'x' }).success).toBe(
      false,
    );
    expect(schema('mandate.cancel').safeParse({ mandate_id: 5 }).success).toBe(false);
  });
});

describe('payment.create_order', () => {
  it('creates the order with the intent as operation key, records it, seals the link and stores only ciphertext', async () => {
    const provider = paymentPort();
    const { processor, logs, run } = setup({}, { payment: provider });
    await run('payment.create_order', { intent_id: INTENT });

    expect(provider.created).toHaveLength(1);
    expect(provider.created[0]).toEqual({
      operationKey: INTENT,
      receiptRef: INTENT,
      merchantRef: MERCHANT,
      amountMinor: 475_000n,
      currency: 'INR',
      purpose: 'installment',
      expiresAt: plus(HOUR),
    });
    expect(names(processor)).toEqual(['loadIntent', 'recordOrderCreated', 'storeHandoffLink']);
    expect(processor.calls[1]).toEqual([
      'recordOrderCreated',
      INTENT,
      `MOCK-ORDER-${INTENT}`,
      plus(HOUR),
    ]);

    const stored = processor.calls[2]?.[1] as {
      kind: string;
      subjectId: string;
      keyVersion: string;
      ciphertext: Uint8Array;
      expiresAt: string;
    };
    expect(stored).toMatchObject({
      kind: 'payment_intent',
      subjectId: INTENT,
      keyVersion: 'k1',
      expiresAt: plus(HOUR),
    });
    // The link round trip: opened with the keyring it equals what the provider returned; the stored bytes hold no part of it.
    const request = provider.created[0];
    if (!request) throw new Error('expected an order request');
    const created = await provider.createOrder({ tenantId: LENDER, correlationId: 'c' }, request);
    const link = created.outcome === 'ok' ? created.value.checkoutLink : null;
    expect(link).toMatch(/^https:\/\/mock-checkout\.invalid\/pay\//);
    expect(
      openHandoffLink(
        keyring,
        { kind: 'payment_intent', subjectId: INTENT, lenderOrgId: LENDER },
        stored.keyVersion,
        stored.ciphertext,
      ),
    ).toBe(link);
    const bytes = Buffer.from(stored.ciphertext);
    const secretPart = (link ?? '').split('/').at(-1) ?? '';
    expect(secretPart.length).toBeGreaterThan(10);
    expect(bytes.includes(Buffer.from(secretPart))).toBe(false);
    expect(bytes.includes(Buffer.from('mock-checkout'))).toBe(false);
    // Nothing in the log is the link, a part of it, an order reference or the merchant.
    for (const forbidden of [
      link ?? 'x',
      secretPart,
      'mock-checkout',
      `MOCK-ORDER-${INTENT}`,
      MERCHANT,
    ]) {
      expect(logs.text()).not.toContain(forbidden);
    }
  });

  it('does nothing when the intent is not waiting for an order (cancelled, expired, pending, failed, succeeded)', async () => {
    for (const status of ['cancelled', 'expired', 'pending', 'failed', 'succeeded']) {
      const provider = paymentPort();
      const { processor, run } = setup({ intent: intentRecord({ status }) }, { payment: provider });
      await run('payment.create_order', { intent_id: INTENT });
      expect(provider.created).toHaveLength(0);
      expect(names(processor)).toEqual(['loadIntent']);
    }
  });

  it('makes no order for an intent whose payment period is already over: the expiry sweep closes it', async () => {
    const provider = paymentPort();
    const { processor, logs, run } = setup(
      { intent: intentRecord({ linkExpiresAt: plus(-1000) }) },
      { payment: provider },
    );
    await run('payment.create_order', { intent_id: INTENT });
    expect(provider.created).toHaveLength(0);
    expect(names(processor)).toEqual(['loadIntent']);
    expect(logs.lines.some((l) => l.message.includes('payment period has already ended'))).toBe(
      true,
    );
  });

  it('is safe to run twice: a repeat after success does nothing; a repeat after a crash meets the same order', async () => {
    const provider = paymentPort();
    const { processor, run } = setup({}, { payment: provider });
    await run('payment.create_order', { intent_id: INTENT });
    await run('payment.create_order', { intent_id: INTENT }); // the intent is pending now
    expect(provider.created).toHaveLength(1);
    expect(names(processor).filter((n) => n === 'recordOrderCreated')).toHaveLength(1);

    // Crash between the provider call and the database: the intent is still created, the provider already holds the order.
    const again = paymentPort();
    const second = setup({}, { payment: again });
    await second.run('payment.create_order', { intent_id: INTENT });
    second.processor.intent = intentRecord(); // as if the record never committed
    await second.run('payment.create_order', { intent_id: INTENT });
    expect(again.created).toHaveLength(1); // one order at the provider, not two
    expect(names(second.processor).filter((n) => n === 'recordOrderCreated')).toHaveLength(2);
  });

  it('an unknown intent is a permanent failure', async () => {
    const { run } = setup({ intent: undefined }, { payment: paymentPort() });
    await expect(run('payment.create_order', { intent_id: INTENT })).rejects.toBeInstanceOf(
      PermanentError,
    );
  });

  it('fails the intent without calling a provider when it has no configuration or the configuration is not active', async () => {
    for (const intent of [
      intentRecord({ config: undefined }),
      intentRecord({ config: config({ status: 'suspended' }) }),
      intentRecord({ config: config({ status: 'retired' }) }),
    ]) {
      const provider = paymentPort();
      const { processor, asked, run } = setup({ intent }, { payment: provider });
      await run('payment.create_order', { intent_id: INTENT });
      expect(provider.created).toHaveLength(0);
      expect(asked).toHaveLength(0);
      expect(processor.calls.at(-1)).toEqual(['recordOrderFailed', INTENT, 'provider_unavailable']);
    }
  });

  it('fails the intent as provider_unavailable when no provider can be resolved', async () => {
    const { processor, run } = setup({}, {});
    await run('payment.create_order', { intent_id: INTENT });
    expect(processor.calls.at(-1)).toEqual(['recordOrderFailed', INTENT, 'provider_unavailable']);
  });

  it('passes the configuration to the resolver by value: names of secrets, never a secret', async () => {
    const { asked, run } = setup({}, { payment: paymentPort() });
    await run('payment.create_order', { intent_id: INTENT });
    expect(asked[0]).toMatchObject({
      lenderOrgId: LENDER,
      provider: 'mock_gateway',
      providerMode: 'mock',
      merchantRef: MERCHANT,
      secretRef: 'SAMPLE_SECRET',
      webhookSecretRef: 'SAMPLE_WEBHOOK_SECRET',
    });
  });

  it('a merchant the provider names that differs from the configured one fails the intent and stops: no order, no link', async () => {
    const provider = paymentPort({ scenario: 'wrong_merchant' });
    const { processor, logs, run } = setup({}, { payment: provider });
    await run('payment.create_order', { intent_id: INTENT });
    expect(names(processor)).toEqual(['loadIntent', 'recordOrderFailed']);
    expect(processor.calls[1]).toEqual(['recordOrderFailed', INTENT, 'merchant_mismatch']);
    expect(logs.text()).not.toContain('SAMPLE-OTHER-MERCHANT');
    expect(logs.text()).not.toContain(MERCHANT);
  });

  it('a provider that names no merchant cannot be bound back: fail closed as a mismatch', async () => {
    const base = paymentPort();
    const port: PaymentProviderPort = {
      ...base,
      createOrder: async (ctx, request) => {
        const result = await base.createOrder(ctx, request);
        return result.outcome === 'ok'
          ? { outcome: 'ok', value: { ...result.value, merchantRef: null } }
          : result;
      },
    };
    const { processor, run } = setup({}, { payment: port });
    await run('payment.create_order', { intent_id: INTENT });
    expect(processor.calls.at(-1)).toEqual(['recordOrderFailed', INTENT, 'merchant_mismatch']);
    expect(names(processor)).not.toContain('recordOrderCreated');
  });

  it('a definite refusal fails the intent with the matching class', async () => {
    const refusing = (reason: 'invalid_request' | 'unsupported_currency'): PaymentProviderPort => ({
      ...paymentPort(),
      createOrder: () => Promise.resolve({ outcome: 'rejected', reason }),
    });
    const a = setup({}, { payment: refusing('invalid_request') });
    await a.run('payment.create_order', { intent_id: INTENT });
    expect(a.processor.calls.at(-1)).toEqual(['recordOrderFailed', INTENT, 'invalid_request']);
    const b = setup({}, { payment: refusing('unsupported_currency') });
    await b.run('payment.create_order', { intent_id: INTENT });
    expect(b.processor.calls.at(-1)).toEqual(['recordOrderFailed', INTENT, 'provider_rejected']);
  });

  it('an unsupported or unconfigured provider fails the intent as provider_unavailable', async () => {
    for (const outcome of ['unsupported', 'not_configured'] as const) {
      const port: PaymentProviderPort = {
        ...paymentPort(),
        createOrder: () => Promise.resolve({ outcome }),
      };
      const { processor, run } = setup({}, { payment: port });
      await run('payment.create_order', { intent_id: INTENT });
      expect(processor.calls.at(-1)).toEqual(['recordOrderFailed', INTENT, 'provider_unavailable']);
    }
  });

  it('a purpose the port does not know fails the intent without calling the provider', async () => {
    const provider = paymentPort();
    const { processor, run } = setup(
      { intent: intentRecord({ purpose: 'tip' }) },
      { payment: provider },
    );
    await run('payment.create_order', { intent_id: INTENT });
    expect(provider.created).toHaveLength(0);
    expect(processor.calls.at(-1)).toEqual(['recordOrderFailed', INTENT, 'invalid_request']);
  });

  describe('an unknown outcome is never re-created blindly', () => {
    it('timeout, then a lookup by operation key that finds the order: recorded, no link is available', async () => {
      const provider = paymentPort({ scenario: 'unknown_outcome' });
      const { processor, logs, run } = setup({}, { payment: provider });
      await run('payment.create_order', { intent_id: INTENT });
      expect(provider.created).toHaveLength(1);
      expect(names(processor)).toEqual(['loadIntent', 'recordOrderCreated']);
      // The lookup gives the order reference and no expiry.
      expect(processor.calls[1]).toEqual([
        'recordOrderCreated',
        INTENT,
        `MOCK-ORDER-${INTENT}`,
        null,
      ]);
      expect(logs.lines.some((l) => l.message.includes('no hand-off link is available'))).toBe(
        true,
      );
    });

    it('a call that outlasts the bound is an unknown outcome, then looked up', async () => {
      const base = paymentPort();
      const port: PaymentProviderPort = {
        ...base,
        createOrder: () => new Promise(() => undefined), // never answers
        getOrderStatus: (_ctx, query) => {
          expect(query).toEqual({ orderRef: null, operationKey: INTENT });
          return Promise.resolve({
            outcome: 'ok',
            value: {
              source: 'provider_authenticated_lookup',
              orderRef: 'ORDER-FOUND-1',
              status: 'created',
              amountMinor: null,
              currency: 'INR',
              merchantRef: MERCHANT,
              providerPaymentRef: null,
              observedAt: NOW.toISOString(),
            },
          });
        },
      };
      const { processor, run } = setup({}, { payment: port }, { timeoutMs: 25 });
      await run('payment.create_order', { intent_id: INTENT });
      expect(processor.calls.at(-1)).toEqual(['recordOrderCreated', INTENT, 'ORDER-FOUND-1', null]);
    });

    it('a lookup that finds the order under another merchant fails the intent as a mismatch', async () => {
      const provider = paymentPort({ scenario: 'unknown_outcome' });
      const base = provider.getOrderStatus.bind(provider);
      const port: PaymentProviderPort = {
        ...provider,
        createOrder: provider.createOrder.bind(provider),
        getOrderStatus: async (ctx, query) => {
          const result = await base(ctx, query);
          return result.outcome === 'ok'
            ? { outcome: 'ok', value: { ...result.value, merchantRef: 'OTHER' } }
            : result;
        },
      };
      const { processor, run } = setup({}, { payment: port });
      await run('payment.create_order', { intent_id: INTENT });
      expect(processor.calls.at(-1)).toEqual(['recordOrderFailed', INTENT, 'merchant_mismatch']);
    });

    const undecided = (): PaymentProviderPort => ({
      ...paymentPort(),
      createOrder: () => Promise.resolve({ outcome: 'unknown', reason: 'provider_error' }),
      getOrderStatus: () => Promise.resolve({ outcome: 'not_found' }),
    });

    it('not found: the outbox retries (a retryable error, nothing recorded)', async () => {
      const { processor, run } = setup({}, { payment: undecided() });
      await expect(
        run('payment.create_order', { intent_id: INTENT }, event({ attempts: 1 })),
      ).rejects.toBeInstanceOf(OrderOutcomeUnresolvedError);
      expect(names(processor)).toEqual(['loadIntent']);
    });

    it('not found after the last attempt: the intent is failed as provider_unavailable and the event completes', async () => {
      const { processor, run } = setup({}, { payment: undecided() });
      await run(
        'payment.create_order',
        { intent_id: INTENT },
        event({ attempts: 8, max_attempts: 8 }),
      );
      expect(processor.calls.at(-1)).toEqual(['recordOrderFailed', INTENT, 'provider_unavailable']);
    });

    it('a lookup that is itself unknown is treated the same way', async () => {
      const port: PaymentProviderPort = {
        ...undecided(),
        getOrderStatus: () => Promise.resolve({ outcome: 'unknown', reason: 'timeout' }),
      };
      const { run } = setup({}, { payment: port });
      await expect(run('payment.create_order', { intent_id: INTENT })).rejects.toBeInstanceOf(
        OrderOutcomeUnresolvedError,
      );
    });
  });

  describe('the database answers', () => {
    it('an unusable order reference or expiry fails the intent as provider_unavailable', async () => {
      for (const hint of ['order_ref_invalid', 'link_expiry_invalid']) {
        const { processor, run } = setup({}, { payment: paymentPort() });
        processor.failures.recordOrderCreated = sqlError('22023', hint);
        await run('payment.create_order', { intent_id: INTENT });
        expect(processor.calls.at(-1)).toEqual([
          'recordOrderFailed',
          INTENT,
          'provider_unavailable',
        ]);
        expect(names(processor)).not.toContain('storeHandoffLink');
      }
    });

    it('an intent that changed meanwhile ends the run quietly, with no link kept', async () => {
      const { processor, run } = setup({}, { payment: paymentPort() });
      processor.failures.recordOrderCreated = sqlError('55000', 'intent_state_invalid');
      await run('payment.create_order', { intent_id: INTENT });
      expect(names(processor)).toEqual(['loadIntent', 'recordOrderCreated']);
    });

    it('not found is permanent; a connection problem is retried (and keeps no link)', async () => {
      const a = setup({}, { payment: paymentPort() });
      a.processor.failures.recordOrderCreated = sqlError('P0002');
      await expect(a.run('payment.create_order', { intent_id: INTENT })).rejects.toBeInstanceOf(
        PermanentError,
      );
      const b = setup({}, { payment: paymentPort() });
      b.processor.failures.recordOrderCreated = sqlError('08006');
      const failure = await b
        .run('payment.create_order', { intent_id: INTENT })
        .catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(PermanentError);
      expect(names(b.processor)).not.toContain('storeHandoffLink');
    });

    it('a failure to record the failure of an intent that moved meanwhile is not an error', async () => {
      const { processor, run } = setup({}, {});
      processor.failures.recordOrderFailed = sqlError('55000', 'intent_state_invalid');
      await run('payment.create_order', { intent_id: INTENT });
    });
  });

  describe('the link', () => {
    it('without a keyring the order is recorded and nothing is kept; the log says so and shows no link', async () => {
      const { processor, logs, run } = setup(
        {},
        { payment: paymentPort() },
        { keyring: undefined },
      );
      await run('payment.create_order', { intent_id: INTENT });
      expect(names(processor)).toEqual(['loadIntent', 'recordOrderCreated']);
      expect(logs.lines.some((l) => l.message.includes('no encryption key'))).toBe(true);
      expect(logs.text()).not.toContain('mock-checkout');
    });

    it('a provider that returns no link: recorded, nothing kept', async () => {
      const base = paymentPort();
      const port: PaymentProviderPort = {
        ...base,
        createOrder: async (ctx, request) => {
          const result = await base.createOrder(ctx, request);
          return result.outcome === 'ok'
            ? { outcome: 'ok', value: { ...result.value, checkoutLink: null } }
            : result;
        },
      };
      const { processor, logs, run } = setup({}, { payment: port });
      await run('payment.create_order', { intent_id: INTENT });
      expect(names(processor)).toEqual(['loadIntent', 'recordOrderCreated']);
      expect(logs.lines.some((l) => l.message.includes('returned none'))).toBe(true);
    });

    it('a link that is not a plain https or upi link is not kept and is not logged', async () => {
      const base = paymentPort();
      const bad = 'http://insecure.invalid/pay/SECRET-TOKEN-1';
      const port: PaymentProviderPort = {
        ...base,
        createOrder: async (ctx, request) => {
          const result = await base.createOrder(ctx, request);
          return result.outcome === 'ok'
            ? { outcome: 'ok', value: { ...result.value, checkoutLink: bad } }
            : result;
        },
      };
      const { processor, logs, run } = setup({}, { payment: port });
      await run('payment.create_order', { intent_id: INTENT });
      expect(names(processor)).toEqual(['loadIntent', 'recordOrderCreated']);
      expect(logs.text()).not.toContain('SECRET-TOKEN-1');
      expect(logs.text()).not.toContain('insecure.invalid');
      expect(logs.lines.some((l) => l.fields.reason === 'link_invalid')).toBe(true);
    });

    it('a failure to store the link is logged by class and does not undo or fail the recorded order', async () => {
      const { processor, logs, run } = setup({}, { payment: paymentPort() });
      processor.failures.storeHandoffLink = sqlError('55000', 'intent_state_invalid');
      await run('payment.create_order', { intent_id: INTENT });
      expect(names(processor)).toEqual(['loadIntent', 'recordOrderCreated', 'storeHandoffLink']);
      expect(
        logs.lines.some(
          (l) => l.fields.sqlstate === '55000' && l.fields.hint === 'intent_state_invalid',
        ),
      ).toBe(true);
      // The database error's message (which here carries a phone-looking value) never reaches the log.
      expect(logs.text()).not.toContain('9100000000');
    });

    it('the provider expiry is kept, but never longer than 30 days; with none the intent expiry, then one hour', async () => {
      const withExpiry = (expiresAt: string | null): PaymentProviderPort => {
        const base = paymentPort();
        return {
          ...base,
          createOrder: async (ctx, request) => {
            const result = await base.createOrder(ctx, request);
            return result.outcome === 'ok'
              ? { outcome: 'ok', value: { ...result.value, expiresAt } }
              : result;
          },
        };
      };
      const stored = (p: FakeProcessor) =>
        (p.calls.find((c) => c[0] === 'storeHandoffLink')?.[1] as { expiresAt: string }).expiresAt;

      const far = setup({}, { payment: withExpiry(plus(90 * DAY)) });
      await far.run('payment.create_order', { intent_id: INTENT });
      expect(stored(far.processor)).toBe(plus(30 * DAY));
      expect(far.processor.calls.find((c) => c[0] === 'recordOrderCreated')?.[3]).toBe(
        plus(30 * DAY),
      );

      const fromIntent = setup(
        { intent: intentRecord({ linkExpiresAt: plus(2 * HOUR) }) },
        { payment: withExpiry(null) },
      );
      await fromIntent.run('payment.create_order', { intent_id: INTENT });
      expect(stored(fromIntent.processor)).toBe(plus(2 * HOUR));

      const fallback = setup(
        { intent: intentRecord({ linkExpiresAt: null }) },
        { payment: withExpiry(null) },
      );
      await fallback.run('payment.create_order', { intent_id: INTENT });
      expect(stored(fallback.processor)).toBe(plus(HOUR));
    });

    it('a link that has already expired is not kept', async () => {
      const base = paymentPort();
      const port: PaymentProviderPort = {
        ...base,
        createOrder: async (ctx, request) => {
          const result = await base.createOrder(ctx, request);
          return result.outcome === 'ok'
            ? { outcome: 'ok', value: { ...result.value, expiresAt: plus(-1000) } }
            : result;
        },
      };
      const { processor, run } = setup({}, { payment: port });
      await run('payment.create_order', { intent_id: INTENT });
      expect(names(processor)).toEqual(['loadIntent', 'recordOrderCreated']);
    });
  });
});

describe('payment.apply_event', () => {
  it('applies the event and logs the outcome word, whatever it is', async () => {
    for (const outcome of [
      'applied',
      'already_applied',
      'ignored_stale',
      'deferred',
      'exception',
      'ignored_unsupported',
      'recorded_for_reconciliation',
    ]) {
      const { processor, logs, run } = setup({}, {});
      processor.results.applied = { outcome, reason: 'r' };
      const id = randomUUID();
      await run('payment.apply_event', { event_id: id });
      expect(processor.calls).toEqual([['applyProviderEvent', id]]);
      expect(logs.lines[0]?.fields).toMatchObject({ providerEventId: id, outcome, reason: 'r' });
    }
  });

  it('an unknown event is permanent; any other failure is retried', async () => {
    const a = setup({}, {});
    a.processor.failures.applyProviderEvent = sqlError('P0002');
    await expect(a.run('payment.apply_event', { event_id: randomUUID() })).rejects.toBeInstanceOf(
      PermanentError,
    );
    const b = setup({}, {});
    b.processor.failures.applyProviderEvent = sqlError('55000', 'event_not_correlated');
    const failure = await b
      .run('payment.apply_event', { event_id: randomUUID() })
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(PermanentError);
  });
});

describe('mandate.handoff', () => {
  const mandatePort = (scenario?: Parameters<typeof createMockMandateProvider>[1]) =>
    createMockMandateProvider('test', scenario);

  it('asks the provider for a hand-off, records it, THEN seals and stores the link; nothing is active', async () => {
    const provider = mandatePort();
    const { processor, logs, run } = setup({}, { mandate: provider });
    await run('mandate.handoff', { mandate_id: MANDATE });

    expect(provider.requests).toEqual([
      {
        operationKey: MANDATE,
        rail: 'enach_api',
        merchantRef: MERCHANT,
        maxAmountMinor: 4_000_000n,
        currency: 'INR',
        startDate: '2026-11-01',
        endDate: '2027-11-01',
        maskedAccountRef: 'XXXXXX1234',
      },
    ]);
    expect(names(processor)).toEqual(['loadMandate', 'recordMandateHandoff', 'storeHandoffLink']);
    expect(processor.calls[1]).toEqual([
      'recordMandateHandoff',
      MANDATE,
      'handoff',
      `MOCK-MANDATE-${MANDATE}`,
      null,
    ]);
    const stored = processor.calls[2]?.[1] as {
      kind: string;
      subjectId: string;
      keyVersion: string;
      ciphertext: Uint8Array;
      expiresAt: string;
    };
    expect(stored).toMatchObject({
      kind: 'mandate',
      subjectId: MANDATE,
      keyVersion: 'k1',
      expiresAt: plus(DAY),
    });
    const link = openHandoffLink(
      keyring,
      { kind: 'mandate', subjectId: MANDATE, lenderOrgId: LENDER },
      'k1',
      stored.ciphertext,
    );
    expect(link).toMatch(/^https:\/\/mock-mandate\.invalid\/handoff\//);
    expect(Buffer.from(stored.ciphertext).includes(Buffer.from('mock-mandate'))).toBe(false);
    for (const forbidden of [
      link,
      'mock-mandate',
      `MOCK-MANDATE-${MANDATE}`,
      'XXXXXX1234',
      MERCHANT,
    ]) {
      expect(logs.text()).not.toContain(forbidden);
    }
  });

  it('does nothing unless the mandate is a draft, and not when the borrower already asked to cancel it', async () => {
    for (const mandate of [
      mandateRecord({ status: 'registration_pending' }),
      mandateRecord({ status: 'active' }),
      mandateRecord({ status: 'cancelled' }),
      mandateRecord({ status: 'requires_reconciliation' }),
      mandateRecord({ cancelRequested: true }),
    ]) {
      const provider = mandatePort();
      const { processor, run } = setup({ mandate }, { mandate: provider });
      await run('mandate.handoff', { mandate_id: MANDATE });
      expect(provider.requests).toHaveLength(0);
      expect(names(processor)).toEqual(['loadMandate']);
    }
  });

  it('an unknown mandate is permanent', async () => {
    const { run } = setup({ mandate: undefined }, { mandate: mandatePort() });
    await expect(run('mandate.handoff', { mandate_id: MANDATE })).rejects.toBeInstanceOf(
      PermanentError,
    );
  });

  it('no configuration, a configuration that is not active, or no resolvable provider: nothing sent, the draft is closed as not sent', async () => {
    for (const [mandate, ports] of [
      [mandateRecord({ config: undefined }), { mandate: mandatePort() }],
      [mandateRecord({ config: config({ status: 'suspended' }) }), { mandate: mandatePort() }],
      [mandateRecord(), {}],
    ] as const) {
      const provider = 'mandate' in ports ? ports.mandate : undefined;
      const { processor, run } = setup({ mandate }, ports);
      await run('mandate.handoff', { mandate_id: MANDATE });
      expect(provider?.requests ?? []).toHaveLength(0);
      expect(processor.calls.at(-1)).toEqual([
        'recordMandateHandoff',
        MANDATE,
        'not_sent',
        null,
        null,
      ]);
    }
  });

  it('a definite refusal is recorded as rejected', async () => {
    const port: MandateProviderPort = {
      ...mandatePort(),
      createMandateRequest: () =>
        Promise.resolve({ outcome: 'rejected', reason: 'rail_not_supported' }),
    };
    const { processor, run } = setup({}, { mandate: port });
    await run('mandate.handoff', { mandate_id: MANDATE });
    expect(processor.calls.at(-1)).toEqual([
      'recordMandateHandoff',
      MANDATE,
      'rejected',
      null,
      null,
    ]);
    expect(names(processor)).not.toContain('storeHandoffLink');
  });

  it('an unknown outcome is parked for reconciliation: never retried, never rejected, no link', async () => {
    for (const port of [
      mandatePort('unknown_outcome'),
      {
        ...mandatePort(),
        createMandateRequest: () =>
          Promise.resolve({ outcome: 'unknown', reason: 'provider_error' } as const),
      },
      {
        ...mandatePort(),
        createMandateRequest: () => Promise.resolve({ outcome: 'not_found' } as const),
      },
    ] as MandateProviderPort[]) {
      const { processor, run } = setup({}, { mandate: port });
      await run('mandate.handoff', { mandate_id: MANDATE });
      expect(processor.calls.at(-1)).toEqual([
        'recordMandateHandoff',
        MANDATE,
        'unknown',
        null,
        null,
      ]);
      expect(names(processor)).not.toContain('storeHandoffLink');
    }
  });

  it('a call that outlasts the bound is an unknown outcome', async () => {
    const port: MandateProviderPort = {
      ...mandatePort(),
      createMandateRequest: () => new Promise(() => undefined),
    };
    const { processor, run } = setup({}, { mandate: port }, { timeoutMs: 25 });
    await run('mandate.handoff', { mandate_id: MANDATE });
    expect(processor.calls.at(-1)).toEqual([
      'recordMandateHandoff',
      MANDATE,
      'unknown',
      null,
      null,
    ]);
  });

  it('no provider configured (the placeholder) is recorded as not sent: nothing reached a provider, so nothing is unknown and nothing was refused', async () => {
    const resolver = createProviderResolver({ environment: 'test', secret: () => undefined });
    const processor = fakeProcessor({
      mandate: mandateRecord({ config: config({ providerMode: 'sandbox' }) }),
    });
    const handlers = createPaymentsHandlers({
      pool: noPool,
      providers: resolver,
      keyring,
      processor,
      log: capture().log,
      now: () => NOW,
    });
    await handlers['mandate.handoff']?.run({ mandate_id: MANDATE }, event());
    expect(processor.calls.at(-1)).toEqual([
      'recordMandateHandoff',
      MANDATE,
      'not_sent',
      null,
      null,
    ]);
  });

  it('a hand-off reference the database refuses is parked for reconciliation, not lost', async () => {
    const { processor, run } = setup({}, { mandate: mandatePort() });
    processor.failures['recordMandateHandoff:handoff'] = sqlError('22023', 'bad_request');
    await run('mandate.handoff', { mandate_id: MANDATE });
    expect(processor.calls.at(-1)).toEqual([
      'recordMandateHandoff',
      MANDATE,
      'unknown',
      null,
      null,
    ]);
    expect(names(processor)).not.toContain('storeHandoffLink');
  });

  it('keeps no link when the mandate had already left the draft by the time the hand-off was recorded', async () => {
    const { processor, run } = setup({}, { mandate: mandatePort() });
    processor.results.handoff = 'cancelled';
    await run('mandate.handoff', { mandate_id: MANDATE });
    expect(names(processor)).toEqual(['loadMandate', 'recordMandateHandoff']);
  });

  it('without a keyring or without a link the hand-off is still recorded', async () => {
    const a = setup({}, { mandate: mandatePort() }, { keyring: undefined });
    await a.run('mandate.handoff', { mandate_id: MANDATE });
    expect(names(a.processor)).toEqual(['loadMandate', 'recordMandateHandoff']);
    const base = mandatePort();
    const port: MandateProviderPort = {
      ...base,
      createMandateRequest: async (ctx, request) => {
        const result = await base.createMandateRequest(ctx, request);
        return result.outcome === 'ok'
          ? { outcome: 'ok', value: { ...result.value, handOffLink: null } }
          : result;
      },
    };
    const b = setup({}, { mandate: port });
    await b.run('mandate.handoff', { mandate_id: MANDATE });
    expect(names(b.processor)).toEqual(['loadMandate', 'recordMandateHandoff']);
  });

  it('keeps the provider expiry for the record and the link', async () => {
    const base = mandatePort();
    const port: MandateProviderPort = {
      ...base,
      createMandateRequest: async (ctx, request) => {
        const result = await base.createMandateRequest(ctx, request);
        return result.outcome === 'ok'
          ? { outcome: 'ok', value: { ...result.value, expiresAt: plus(3 * HOUR) } }
          : result;
      },
    };
    const { processor, run } = setup({}, { mandate: port });
    await run('mandate.handoff', { mandate_id: MANDATE });
    expect(processor.calls[1]?.[4]).toBe(plus(3 * HOUR));
    expect((processor.calls[2]?.[1] as { expiresAt: string }).expiresAt).toBe(plus(3 * HOUR));
  });

  it('is safe to run twice', async () => {
    const provider = mandatePort();
    const { processor, run } = setup({}, { mandate: provider });
    await run('mandate.handoff', { mandate_id: MANDATE });
    processor.mandate = mandateRecord({ status: 'registration_pending' });
    await run('mandate.handoff', { mandate_id: MANDATE });
    expect(provider.requests).toHaveLength(1);
    expect(names(processor).filter((n) => n === 'recordMandateHandoff')).toHaveLength(1);
  });
});

describe('mandate.cancel', () => {
  const live = () =>
    mandateRecord({
      status: 'active',
      providerMandateRef: 'MOCK-MANDATE-LIVE-1',
      cancelRequested: true,
    });
  const mandatePort = () => createMockMandateProvider('test');
  /** A mock that already holds the mandate, as it would after a hand-off. */
  async function knowing() {
    const provider = mandatePort();
    await provider.createMandateRequest(
      { tenantId: LENDER, correlationId: 'c' },
      {
        operationKey: 'LIVE-1',
        rail: 'enach_api',
        merchantRef: MERCHANT,
        maxAmountMinor: 4_000_000n,
        currency: 'INR',
        startDate: '2026-11-01',
        endDate: '2027-11-01',
        maskedAccountRef: 'XXXXXX1234',
      },
    );
    return provider;
  }

  it('sends the request with the provider reference, marks it sent, and does not call the mandate cancelled', async () => {
    const provider = await knowing();
    const { processor, logs, run } = setup({ mandate: live() }, { mandate: provider });
    await run('mandate.cancel', { mandate_id: MANDATE });
    expect(provider.cancelRequests).toEqual([
      { providerMandateRef: 'MOCK-MANDATE-LIVE-1', operationKey: MANDATE },
    ]);
    expect(names(processor)).toEqual(['loadMandate', 'markMandateCancelSent']);
    expect(logs.lines.at(-1)?.message).toContain('cancelled only when the provider confirms');
    expect(logs.text()).not.toContain('MOCK-MANDATE-LIVE-1');
  });

  it('sends nothing when no cancellation was requested, it was sent already, the mandate is finished, or the provider has no reference', async () => {
    for (const mandate of [
      { ...live(), cancelRequested: false },
      { ...live(), cancelSent: true },
      { ...live(), status: 'cancelled' },
      { ...live(), status: 'revoked' },
      { ...live(), status: 'draft', providerMandateRef: null },
      { ...live(), status: 'requires_reconciliation', providerMandateRef: null },
    ]) {
      const provider = await knowing();
      const { processor, run } = setup({ mandate }, { mandate: provider });
      await run('mandate.cancel', { mandate_id: MANDATE });
      expect(provider.cancelRequests).toHaveLength(0);
      expect(names(processor)).toEqual(['loadMandate']);
    }
  });

  it('an unknown, unconfigured, refused or unknown-to-the-provider answer is NOT marked as sent', async () => {
    for (const result of [
      { outcome: 'unknown', reason: 'timeout' },
      { outcome: 'not_configured' },
      { outcome: 'not_found' },
      { outcome: 'unsupported' },
      { outcome: 'rejected', reason: 'invalid_request' },
    ] as const) {
      const port: MandateProviderPort = {
        ...mandatePort(),
        cancelMandate: () => Promise.resolve(result),
      };
      const { processor, logs, run } = setup({ mandate: live() }, { mandate: port });
      await run('mandate.cancel', { mandate_id: MANDATE });
      expect(names(processor)).toEqual(['loadMandate']);
      expect(logs.lines.at(-1)?.fields.outcome).toBe(result.outcome);
    }
  });

  it('a call that outlasts the bound is not marked as sent', async () => {
    const port: MandateProviderPort = {
      ...mandatePort(),
      cancelMandate: () => new Promise(() => undefined),
    };
    const { processor, run } = setup({ mandate: live() }, { mandate: port }, { timeoutMs: 25 });
    await run('mandate.cancel', { mandate_id: MANDATE });
    expect(names(processor)).toEqual(['loadMandate']);
  });

  it('an unusable provider or a missing configuration is left to the sweep; a suspended configuration still cancels', async () => {
    const a = setup({ mandate: live() }, {});
    await a.run('mandate.cancel', { mandate_id: MANDATE });
    expect(names(a.processor)).toEqual(['loadMandate']);
    const b = setup({ mandate: { ...live(), config: undefined } }, { mandate: mandatePort() });
    await b.run('mandate.cancel', { mandate_id: MANDATE });
    expect(names(b.processor)).toEqual(['loadMandate']);
    const provider = await knowing();
    const c = setup(
      { mandate: { ...live(), config: config({ status: 'suspended' }) } },
      { mandate: provider },
    );
    await c.run('mandate.cancel', { mandate_id: MANDATE });
    expect(provider.cancelRequests).toHaveLength(1);
    expect(names(c.processor)).toEqual(['loadMandate', 'markMandateCancelSent']);
  });

  it('an unknown mandate is permanent', async () => {
    const { run } = setup({ mandate: undefined }, { mandate: mandatePort() });
    await expect(run('mandate.cancel', { mandate_id: MANDATE })).rejects.toBeInstanceOf(
      PermanentError,
    );
    const b = setup({ mandate: live() }, { mandate: mandatePort() });
    b.processor.failures.markMandateCancelSent = sqlError('P0002');
    const provider = await knowing();
    const c = setup({ mandate: live() }, { mandate: provider });
    c.processor.failures.markMandateCancelSent = sqlError('P0002');
    await expect(c.run('mandate.cancel', { mandate_id: MANDATE })).rejects.toBeInstanceOf(
      PermanentError,
    );
  });
});
