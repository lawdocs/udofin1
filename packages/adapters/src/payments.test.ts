import { describe, expect, it } from 'vitest';
import {
  buildMockDeliveries,
  buildMockWebhookBody,
  createMockPaymentProvider,
  createUnconfiguredPaymentProvider,
  defaultEventRank,
  MOCK_OTHER_MERCHANT_REF,
  MOCK_PAYMENT_WEBHOOK_SCHEME,
  PAYMENT_SUCCESS_STATUSES,
  signMockWebhook,
  UNSUPPORTED_OBJECT_KIND,
  withPaymentTimeout,
  type PaymentProviderPort,
  type CreateOrderRequest,
  type MockDelivery,
  type MockPaymentScenario,
  type NormalisedProviderEvent,
  type WebhookVerification,
} from './index.js';
import { ProviderNotAllowedError, type ProviderCallContext } from './provider.js';

const NOW = new Date('2026-10-14T05:00:00.000Z');
const SECRET = 'SAMPLE-webhook-secret-not-real-0001';
const ctx: ProviderCallContext = { tenantId: 'SAMPLE-TENANT', correlationId: 'SAMPLE-CORR' };
const params = {
  secret: SECRET,
  orderRef: 'MOCK-ORDER-SAMPLE-INTENT-0001',
  paymentRef: 'MOCK-PAY-SAMPLE-INTENT-0001',
  amountMinor: 450_000n,
  merchantRef: 'SAMPLE-MERCHANT-0001',
  now: NOW,
};
const verifier = createMockPaymentProvider('test').webhookVerifier;
const verify = (d: MockDelivery, over: { secret?: string; now?: Date } = {}): WebhookVerification =>
  verifier.verify(d.rawBody, d.headers, { secret: over.secret ?? SECRET, now: over.now ?? NOW });
const verified = (v: WebhookVerification): NormalisedProviderEvent => {
  if (v.outcome !== 'verified') throw new Error(`expected verified, got ${v.outcome}`);
  return v.event;
};
const script = (scenario: MockPaymentScenario) => buildMockDeliveries(scenario, params);

describe('mock webhook scheme mock-standard-webhooks-v1', () => {
  it('is named exactly as the spec says', () => {
    expect(MOCK_PAYMENT_WEBHOOK_SCHEME).toBe('mock-standard-webhooks-v1');
    expect(verifier.scheme).toBe('mock-standard-webhooks-v1');
  });

  it('verifies a valid delivery and normalises it into integer paise with rank and provenance', () => {
    const [authorized, captured] = script('success');
    const event = verified(verify(captured as MockDelivery));
    expect(event).toMatchObject({
      provider: 'mock_payment_provider',
      objectKind: 'payment',
      objectRef: params.paymentRef,
      orderRef: params.orderRef,
      status: 'captured',
      rank: defaultEventRank('captured'),
      amountMinor: 450_000n,
      currency: 'INR',
      merchantRef: params.merchantRef,
      occurredAt: NOW.toISOString(),
    });
    expect(typeof event.amountMinor).toBe('bigint');
    expect(event.deliveryId).not.toBe('');
    expect(event.eventId).not.toBe(verified(verify(authorized as MockDelivery)).eventId);
    const v = verify(captured as MockDelivery);
    expect(v.payloadSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects a tampered body as unverified, and a different secret as unverified', () => {
    const [captured] = script('success').slice(1) as [MockDelivery];
    const tampered = new Uint8Array(captured.rawBody);
    tampered[tampered.length - 3] = (tampered[tampered.length - 3] ?? 0) ^ 1;
    expect(verifier.verify(tampered, captured.headers, { secret: SECRET, now: NOW })).toMatchObject(
      {
        outcome: 'unverified',
        reason: 'signature_mismatch',
      },
    );
    expect(verify(captured, { secret: `${SECRET}-other` })).toMatchObject({
      outcome: 'unverified',
      reason: 'signature_mismatch',
    });
    expect(verify(captured, { secret: '' })).toMatchObject({
      outcome: 'unverified',
      reason: 'no_secret',
    });
  });

  it('refuses a signature made over a different delivery id or timestamp', () => {
    const [captured] = script('success').slice(1) as [MockDelivery];
    const swapped = { ...captured.headers, 'webhook-id': 'SAMPLE-DLV-OTHER' };
    expect(verifier.verify(captured.rawBody, swapped, { secret: SECRET, now: NOW }).outcome).toBe(
      'unverified',
    );
    const shifted = {
      ...captured.headers,
      'webhook-timestamp': String(Math.floor(NOW.getTime() / 1000) + 1),
    };
    expect(verifier.verify(captured.rawBody, shifted, { secret: SECRET, now: NOW }).outcome).toBe(
      'unverified',
    );
  });

  it('treats missing or malformed headers as unverified and reads header names in any case', () => {
    const [captured] = script('success').slice(1) as [MockDelivery];
    expect(verifier.verify(captured.rawBody, {}, { secret: SECRET, now: NOW })).toMatchObject({
      outcome: 'unverified',
      reason: 'missing_headers',
    });
    expect(
      verifier.verify(
        captured.rawBody,
        { ...captured.headers, 'webhook-timestamp': 'yesterday' },
        { secret: SECRET, now: NOW },
      ),
    ).toMatchObject({ outcome: 'unverified', reason: 'malformed_headers' });
    const upper = Object.fromEntries(
      Object.entries(captured.headers).map(([k, v]) => [k.toUpperCase(), v]),
    );
    expect(verifier.verify(captured.rawBody, upper, { secret: SECRET, now: NOW }).outcome).toBe(
      'verified',
    );
  });

  it('accepts a signature list in which one entry is valid', () => {
    const [captured] = script('success').slice(1) as [MockDelivery];
    const headers = {
      ...captured.headers,
      'webhook-signature': `v1,AAAA ${captured.headers['webhook-signature']}`,
    };
    expect(verifier.verify(captured.rawBody, headers, { secret: SECRET, now: NOW }).outcome).toBe(
      'verified',
    );
  });

  it('requires canonical base64: junk after the signature, base64url and stripped padding are not the signature', () => {
    const [captured] = script('success').slice(1) as [MockDelivery];
    const given = captured.headers['webhook-signature'];
    const check = (signature: string) =>
      verifier.verify(
        captured.rawBody,
        { ...captured.headers, 'webhook-signature': signature },
        { secret: SECRET, now: NOW },
      ).outcome;
    expect(check(given)).toBe('verified');
    expect(check(`${given}==garbage!!`)).toBe('unverified');
    expect(check(given.replace(/=+$/, ''))).toBe('unverified');
    expect(check(given.replaceAll('+', '-').replaceAll('/', '_'))).toBe(
      given.includes('+') || given.includes('/') ? 'unverified' : 'verified',
    );
    expect(check(`${given}A`)).toBe('unverified');
  });

  it('matches a signature computed outside this code (python hmac, base64)', () => {
    // python: base64(hmac_sha256(b'SAMPLE-WEBHOOK-SECRET', b'SAMPLE-DLV-1.1791936000.' + body))
    const rawBody = new TextEncoder().encode('{"event_id":"SAMPLE-EVT-1"}');
    const headers = signMockWebhook({
      secret: 'SAMPLE-WEBHOOK-SECRET',
      deliveryId: 'SAMPLE-DLV-1',
      timestampSeconds: 1_791_936_000,
      rawBody,
    });
    expect(headers['webhook-signature']).toBe('v1,vhC76i8cTs9WirPSlJqT1YaT/sBOAKGprPfFdidIN7g=');
  });

  it('refuses an unusable tolerance instead of switching the replay window off (NaN) or on (negative)', () => {
    const [captured] = script('success').slice(1) as [MockDelivery];
    for (const toleranceSeconds of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(() =>
        verifier.verify(captured.rawBody, captured.headers, {
          secret: SECRET,
          now: NOW,
          toleranceSeconds,
        }),
      ).toThrow(RangeError);
    }
    expect(
      verifier.verify(captured.rawBody, captured.headers, {
        secret: SECRET,
        now: NOW,
        toleranceSeconds: 0,
      }).outcome,
    ).toBe('verified');
  });

  it('checks the size before any signature work: an oversize body is invalid even with no signature', () => {
    const rawBody = new Uint8Array(70_000).fill(97);
    expect(verifier.verify(rawBody, {}, { secret: SECRET, now: NOW })).toMatchObject({
      outcome: 'invalid',
      reason: 'body_too_large',
    });
  });

  it('stale timestamp: an authentic but old delivery is stale_timestamp, never verified; the boundary is 5 minutes', () => {
    const [old] = script('old_timestamp') as [MockDelivery];
    expect(verify(old)).toMatchObject({
      outcome: 'stale_timestamp',
      reason: 'timestamp_outside_tolerance',
    });
    const [captured] = script('success').slice(1) as [MockDelivery];
    expect(verify(captured, { now: new Date(NOW.getTime() + 300_000) }).outcome).toBe('verified');
    expect(verify(captured, { now: new Date(NOW.getTime() + 301_000) }).outcome).toBe(
      'stale_timestamp',
    );
    expect(verify(captured, { now: new Date(NOW.getTime() - 301_000) }).outcome).toBe(
      'stale_timestamp',
    );
    expect(
      verifier.verify(captured.rawBody, captured.headers, {
        secret: SECRET,
        now: new Date(NOW.getTime() + 301_000),
        toleranceSeconds: 600,
      }).outcome,
    ).toBe('verified');
  });

  it('a forged delivery with a stale timestamp reveals nothing: it is just unverified', () => {
    const [captured] = script('success').slice(1) as [MockDelivery];
    expect(
      verify(captured, { secret: 'x'.repeat(20), now: new Date(NOW.getTime() + 3_600_000) })
        .outcome,
    ).toBe('unverified');
  });

  it('bad signature scenario is unverified', () => {
    const [bad] = script('bad_signature') as [MockDelivery];
    expect(verify(bad)).toMatchObject({ outcome: 'unverified', reason: 'signature_mismatch' });
  });

  it('wrong currency is invalid (authentic, but never an applicable event)', () => {
    const [wrong] = script('wrong_currency') as [MockDelivery];
    expect(verify(wrong)).toMatchObject({ outcome: 'invalid', reason: 'unsupported_currency' });
  });

  it('wrong merchant is verified with the merchant it claims, for the database to compare and suspend', () => {
    const [wrong] = script('wrong_merchant') as [MockDelivery];
    expect(verified(verify(wrong)).merchantRef).toBe(MOCK_OTHER_MERCHANT_REF);
  });

  it('partial amount is carried exactly as sent (the database refuses it as a success)', () => {
    const [partial] = script('partial_amount') as [MockDelivery];
    expect(verified(verify(partial)).amountMinor).toBe(225_000n);
  });

  const signedWith = (body: string | Uint8Array) => {
    const rawBody = typeof body === 'string' ? new TextEncoder().encode(body) : body;
    const headers = signMockWebhook({
      secret: SECRET,
      deliveryId: 'SAMPLE-DLV-X',
      timestampSeconds: Math.floor(NOW.getTime() / 1000),
      rawBody,
    });
    return verifier.verify(rawBody, headers, { secret: SECRET, now: NOW });
  };
  const base = {
    event_id: 'E1',
    object_kind: 'payment',
    object_ref: 'P1',
    status: 'captured',
    occurred_at: NOW.toISOString(),
  };

  it('refuses amounts that are not exact decimal strings (float, fraction of a paisa, exponent, number)', () => {
    for (const amount of ['10.005', '1e2', ' 10', '-1', '10,00', 10.5, 10]) {
      expect(signedWith(JSON.stringify({ ...base, amount }))).toMatchObject({
        outcome: 'invalid',
        reason: 'invalid_amount',
      });
    }
    expect(
      verified(signedWith(JSON.stringify({ ...base, amount: '10.5', currency: 'INR' })))
        .amountMinor,
    ).toBe(1_050n);
    expect(verified(signedWith(JSON.stringify(base))).amountMinor).toBeNull();
  });

  it('refuses unusable bodies once authentic: malformed, non-object, oversize, bad identifiers, bad time, unknown kind', () => {
    expect(signedWith('{nope')).toMatchObject({ outcome: 'invalid', reason: 'malformed_body' });
    expect(signedWith('[1]')).toMatchObject({ outcome: 'invalid', reason: 'malformed_body' });
    expect(signedWith(new Uint8Array([0xff, 0xfe]))).toMatchObject({
      outcome: 'invalid',
      reason: 'malformed_body',
    });
    expect(signedWith(`{"pad":"${'a'.repeat(70_000)}"}`)).toMatchObject({
      outcome: 'invalid',
      reason: 'body_too_large',
    });
    expect(signedWith(JSON.stringify({ ...base, event_id: 'has space' }))).toMatchObject({
      outcome: 'invalid',
      reason: 'invalid_identifier',
    });
    expect(signedWith(JSON.stringify({ ...base, event_id: 5 }))).toMatchObject({
      outcome: 'invalid',
      reason: 'invalid_identifier',
    });
    expect(signedWith(JSON.stringify({ ...base, occurred_at: 'soon' }))).toMatchObject({
      outcome: 'invalid',
      reason: 'invalid_timestamp',
    });
    expect(signedWith(JSON.stringify({ ...base, object_kind: '' }))).toMatchObject({
      outcome: 'invalid',
      reason: 'unsupported_event',
    });
    expect(signedWith(JSON.stringify({ ...base, object_kind: 5 }))).toMatchObject({
      outcome: 'invalid',
      reason: 'unsupported_event',
    });
  });

  it('stores an authentic delivery of an unsupported kind as verified-and-ignored, never as invalid', () => {
    const result = signedWith(
      JSON.stringify({ ...base, object_kind: 'dispute_note', amount: '1.00', currency: 'USD' }),
    );
    expect(result.outcome).toBe('verified');
    const event = verified(result);
    expect(event.objectKind).toBe(UNSUPPORTED_OBJECT_KIND);
    expect(event.status).toBe('unmapped');
    expect(event.rank).toBe(0);
    // It carries nothing that could authorise or move money, and not the provider's kind word.
    expect(event.amountMinor).toBeNull();
    expect(event.currency).toBeNull();
    expect(JSON.stringify(event)).not.toContain('dispute_note');
    expect(PAYMENT_SUCCESS_STATUSES).not.toContain(event.status);
    // Still inert without a valid time or identifiers, and still unverified without a good signature.
    expect(
      signedWith(JSON.stringify({ ...base, object_kind: 'dispute_note', occurred_at: 'soon' })),
    ).toMatchObject({ outcome: 'invalid', reason: 'invalid_timestamp' });
    expect(
      signedWith(JSON.stringify({ ...base, object_kind: 'dispute_note', event_id: 'has space' })),
    ).toMatchObject({ outcome: 'invalid', reason: 'invalid_identifier' });
    const forged = verify({
      ...(script('success')[0] as MockDelivery),
      rawBody: new TextEncoder().encode(JSON.stringify({ ...base, object_kind: 'dispute_note' })),
    });
    expect(forged.outcome).toBe('unverified');
  });

  it('refuses an amount without a currency, so INR is always confirmed', () => {
    expect(signedWith(JSON.stringify({ ...base, amount: '10.50' }))).toMatchObject({
      outcome: 'invalid',
      reason: 'unsupported_currency',
    });
  });

  it('maps an unknown status to unmapped, which can never authorise a payment', () => {
    const event = verified(signedWith(JSON.stringify({ ...base, status: 'MYSTERY' })));
    expect(event.status).toBe('unmapped');
    expect(PAYMENT_SUCCESS_STATUSES).not.toContain(event.status);
    expect([...PAYMENT_SUCCESS_STATUSES]).toEqual(['captured', 'paid', 'succeeded']);
  });

  it('never echoes the secret or the body in a result', () => {
    for (const d of script('bad_signature')) {
      const text = JSON.stringify(verify(d), (_k, v: unknown) =>
        typeof v === 'bigint' ? v.toString() : v,
      );
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(params.paymentRef);
    }
  });
});

describe('scripted deliveries', () => {
  const events = (scenario: MockPaymentScenario) =>
    script(scenario)
      .map((d) => verify(d))
      .filter(
        (v): v is Extract<WebhookVerification, { outcome: 'verified' }> => v.outcome === 'verified',
      )
      .map((v) => v.event);

  it('success: authorized then captured', () => {
    expect(events('success').map((e) => e.status)).toEqual(['authorized', 'captured']);
  });
  it('failure and delayed', () => {
    expect(events('failure').map((e) => e.status)).toEqual(['failed']);
    const [late] = events('delayed');
    expect(late?.occurredAt).toBe('2026-10-14T03:00:00.000Z');
  });
  it('duplicate event: one event id, a replayed delivery id, and a new delivery id', () => {
    const [a, b, c] = events('duplicate_event');
    expect(a?.eventId).toBe(b?.eventId);
    expect(a?.eventId).toBe(c?.eventId);
    expect(a?.deliveryId).toBe(b?.deliveryId);
    expect(a?.deliveryId).not.toBe(c?.deliveryId);
  });
  it('out of order: refund before capture, and failed after captured (lower rank)', () => {
    const [refund, captured] = events('out_of_order_refund_first');
    expect(refund).toMatchObject({ objectKind: 'refund', status: 'refunded' });
    expect(captured?.status).toBe('captured');
    const [cap, failed] = events('out_of_order_failed_after_captured');
    expect((failed?.rank ?? 99) < (cap?.rank ?? 0)).toBe(true);
  });
  it('refund and chargeback carry their own object kinds and outrank the capture', () => {
    const [cap, refund] = events('refund');
    expect(refund).toMatchObject({ objectKind: 'refund', amountMinor: 450_000n });
    expect((refund?.rank ?? 0) > (cap?.rank ?? 99)).toBe(true);
    const [, dispute] = events('chargeback');
    expect(dispute).toMatchObject({ objectKind: 'chargeback', status: 'disputed' });
  });
  it('unknown outcome sends nothing at all', () => {
    expect(script('unknown_outcome')).toEqual([]);
  });
  it('is deterministic for fixed parameters', () => {
    expect(script('success').map((d) => d.headers)).toEqual(
      script('success').map((d) => d.headers),
    );
  });
  it('builds bodies whose money is a decimal string', () => {
    const body = JSON.parse(
      new TextDecoder().decode(
        buildMockWebhookBody({
          eventId: 'E',
          objectKind: 'payment',
          objectRef: 'P',
          status: 'captured',
          amountMinor: 5n,
          currency: 'INR',
          occurredAt: NOW.toISOString(),
        }),
      ),
    ) as Record<string, unknown>;
    expect(body.amount).toBe('0.05');
  });
  it('rank is monotonic along the life of a payment', () => {
    const order = ['created', 'pending', 'authorized', 'captured', 'refunded', 'disputed'] as const;
    const ranks = order.map(defaultEventRank);
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
  });
});

describe('mock payment provider', () => {
  const request: CreateOrderRequest = {
    operationKey: 'SAMPLE-INTENT-0001',
    receiptRef: 'SAMPLE-INTENT-0001',
    merchantRef: 'SAMPLE-MERCHANT-0001',
    amountMinor: 450_000n,
    currency: 'INR',
    purpose: 'installment',
    expiresAt: null,
  };

  it('is labelled, and refused in staging and production', () => {
    expect(createMockPaymentProvider('test').descriptor).toEqual({
      key: 'mock_payment_provider',
      capability: 'payment_collection',
      mode: 'mock',
    });
    expect(() => createMockPaymentProvider('production')).toThrow(ProviderNotAllowedError);
    expect(() => createMockPaymentProvider('staging')).toThrow(/local development and tests only/);
    expect(() => createMockPaymentProvider('local')).not.toThrow();
  });

  it('creates an order idempotently and binds back the merchant it was created for', async () => {
    const p = createMockPaymentProvider('test');
    const first = await p.createOrder(ctx, request);
    const second = await p.createOrder(ctx, request);
    expect(first).toEqual(second);
    expect(p.created).toHaveLength(1);
    expect(first).toMatchObject({ outcome: 'ok', value: { merchantRef: 'SAMPLE-MERCHANT-0001' } });
    // The lookup is not the payment: an order that nobody paid is not captured.
    const status = await p.getOrderStatus(ctx, {
      orderRef: null,
      operationKey: request.operationKey,
    });
    expect(status).toMatchObject({
      outcome: 'ok',
      value: { source: 'provider_authenticated_lookup', status: 'captured', amountMinor: 450_000n },
    });
  });

  it('gives distinct operation keys distinct refs, even when they share a long prefix or are UUIDs', async () => {
    const p = createMockPaymentProvider('test');
    const keys = [
      'SAMPLE-INTENT-000000000000001',
      'SAMPLE-INTENT-000000000000002',
      '0198a1b2-c3d4-7e5f-8a6b-111111111111',
      '0198a1b2-c3d4-7e5f-8a6b-222222222222',
      'key with spaces and a very long tail '.repeat(4),
      'key with spaces and a very long tail '.repeat(4) + 'x',
    ];
    const refs: string[] = [];
    for (const operationKey of keys) {
      const created = await p.createOrder(ctx, { ...request, operationKey });
      expect(created.outcome).toBe('ok');
      if (created.outcome === 'ok') refs.push(created.value.orderRef);
    }
    expect(new Set(refs).size).toBe(keys.length);
    // Refs stay usable in a webhook body (the identifier rule), and a lookup returns the right order.
    for (const ref of refs) expect(ref).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/);
    const second = await p.getOrderStatus(ctx, {
      orderRef: refs[1] ?? null,
      operationKey: 'unknown',
    });
    expect(second).toMatchObject({ outcome: 'ok', value: { orderRef: refs[1] } });
    const settled = await p.fetchSettlements(ctx, '2026-10-14');
    const items = settled.outcome === 'ok' ? (settled.value.batches[0]?.items ?? []) : [];
    expect(new Set(items.map((i) => i.providerPaymentRef)).size).toBe(keys.length);
  });

  it('refuses a reused operation key with different parameters instead of returning the first order', async () => {
    const p = createMockPaymentProvider('test');
    expect((await p.createOrder(ctx, request)).outcome).toBe('ok');
    expect(await p.createOrder(ctx, { ...request, amountMinor: 999_999n })).toEqual({
      outcome: 'rejected',
      reason: 'invalid_request',
    });
    expect(p.created).toHaveLength(1);
  });

  it('refuses malformed requests', async () => {
    const p = createMockPaymentProvider('test');
    expect(await p.createOrder(ctx, { ...request, amountMinor: 0n })).toEqual({
      outcome: 'rejected',
      reason: 'invalid_request',
    });
    expect(await p.createOrder(ctx, { ...request, amountMinor: -1n })).toEqual({
      outcome: 'rejected',
      reason: 'invalid_request',
    });
    expect(await p.createOrder(ctx, { ...request, currency: 'USD' as 'INR' })).toEqual({
      outcome: 'rejected',
      reason: 'invalid_request',
    });
    expect(await p.getOrderStatus(ctx, { orderRef: 'nope', operationKey: 'nope' })).toEqual({
      outcome: 'not_found',
    });
    expect(await p.fetchSettlements(ctx, '2026-13-40')).toEqual({
      outcome: 'rejected',
      reason: 'invalid_request',
    });
  });

  it('unknown outcome: create answers unknown, a lookup by our key finds the order, a retry never creates a second', async () => {
    const p = createMockPaymentProvider('test', { scenario: 'unknown_outcome' });
    expect(await p.createOrder(ctx, request)).toEqual({ outcome: 'unknown', reason: 'timeout' });
    const first = await p.getOrderStatus(ctx, {
      orderRef: null,
      operationKey: request.operationKey,
    });
    expect(first).toMatchObject({ outcome: 'ok', value: { status: 'created', amountMinor: null } });
    const retry = await p.createOrder(ctx, request);
    expect(retry.outcome).toBe('ok');
    expect(p.created).toHaveLength(1);
    const second = await p.getOrderStatus(ctx, {
      orderRef: null,
      operationKey: request.operationKey,
    });
    expect(second).toMatchObject({ outcome: 'ok', value: { status: 'captured' } });
  });

  it('delayed: pending twice, then captured', async () => {
    const p = createMockPaymentProvider('test', { scenario: 'delayed' });
    await p.createOrder(ctx, request);
    const statuses: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const r = await p.getOrderStatus(ctx, { orderRef: null, operationKey: request.operationKey });
      if (r.outcome === 'ok') statuses.push(r.value.status);
    }
    expect(statuses).toEqual(['pending', 'pending', 'captured']);
  });

  it('failure, partial amount, wrong currency and wrong merchant', async () => {
    const lookup = async (scenario: MockPaymentScenario) => {
      const p = createMockPaymentProvider('test', { scenario });
      const created = await p.createOrder(ctx, request);
      const status = await p.getOrderStatus(ctx, {
        orderRef: null,
        operationKey: request.operationKey,
      });
      return { created, status };
    };
    expect((await lookup('failure')).status).toMatchObject({
      outcome: 'ok',
      value: { status: 'failed', amountMinor: null },
    });
    expect((await lookup('partial_amount')).status).toMatchObject({
      outcome: 'ok',
      value: { status: 'captured', amountMinor: 225_000n },
    });
    expect((await lookup('wrong_currency')).status).toEqual({
      outcome: 'rejected',
      reason: 'unsupported_currency',
    });
    const wrong = await lookup('wrong_merchant');
    expect(wrong.created).toMatchObject({
      outcome: 'ok',
      value: { merchantRef: MOCK_OTHER_MERCHANT_REF },
    });
    expect(wrong.status).toMatchObject({
      outcome: 'ok',
      value: { merchantRef: MOCK_OTHER_MERCHANT_REF },
    });
  });

  it('settlement reports list what the provider says it settled, with exact paise, and nothing invented', async () => {
    const p = createMockPaymentProvider('test', { settlementDestinationMaskedRef: 'XXXXXX0001' });
    expect(await p.fetchSettlements(ctx, '2026-10-14')).toEqual({
      outcome: 'ok',
      value: { date: '2026-10-14', batches: [] },
    });
    await p.createOrder(ctx, request);
    const report = await p.fetchSettlements(ctx, '2026-10-14');
    expect(report).toMatchObject({
      outcome: 'ok',
      value: {
        batches: [
          {
            destinationMaskedRef: 'XXXXXX0001',
            grossMinor: 450_000n,
            feeMinor: 0n,
            netMinor: 450_000n,
            items: [{ grossMinor: 450_000n }],
          },
        ],
      },
    });
    const failed = createMockPaymentProvider('test', { scenario: 'failure' });
    await failed.createOrder(ctx, request);
    expect(await failed.fetchSettlements(ctx, '2026-10-14')).toMatchObject({
      outcome: 'ok',
      value: { batches: [] },
    });
  });

  it('never accepts personal data fields: the request type has none', () => {
    expect(Object.keys(request).sort()).toEqual([
      'amountMinor',
      'currency',
      'expiresAt',
      'merchantRef',
      'operationKey',
      'purpose',
      'receiptRef',
    ]);
  });
});

describe('unconfigured payment provider', () => {
  it('refuses every call, and its webhook verifier answers invalid / provider_scheme_not_configured', async () => {
    const p = createUnconfiguredPaymentProvider();
    expect(p.descriptor.key).toBe('payment_provider_not_configured');
    expect(Object.values(p.capabilities).every((v) => !v)).toBe(true);
    expect(
      await p.createOrder(ctx, {
        operationKey: 'k',
        receiptRef: 'k',
        merchantRef: 'm',
        amountMinor: 1n,
        currency: 'INR',
        purpose: 'installment',
        expiresAt: null,
      }),
    ).toEqual({ outcome: 'not_configured' });
    expect(await p.getOrderStatus(ctx, { orderRef: null, operationKey: 'k' })).toEqual({
      outcome: 'not_configured',
    });
    expect(await p.fetchSettlements(ctx, '2026-10-14')).toEqual({ outcome: 'not_configured' });
    const [captured] = script('success').slice(1) as [MockDelivery];
    // Even a perfectly signed mock delivery is not accepted by a provider with no scheme.
    expect(
      p.webhookVerifier.verify(captured.rawBody, captured.headers, { secret: SECRET, now: NOW }),
    ).toMatchObject({
      outcome: 'invalid',
      reason: 'provider_scheme_not_configured',
      payloadSha256: expect.stringMatching(/^[0-9a-f]{64}$/) as string,
    });
  });
});

describe('withPaymentTimeout', () => {
  const orderRequest: CreateOrderRequest = {
    operationKey: 'SAMPLE-INTENT-TIMEOUT',
    receiptRef: 'SAMPLE-INTENT-TIMEOUT',
    merchantRef: 'SAMPLE-MERCHANT-0001',
    amountMinor: 1n,
    currency: 'INR',
    purpose: 'installment',
    expiresAt: null,
  };
  const hang = (): Promise<never> => new Promise(() => undefined);

  it('turns an elapsed timeout into the explicit unknown outcome for every call, never an empty or success result', async () => {
    const slow: PaymentProviderPort = {
      ...createUnconfiguredPaymentProvider(),
      createOrder: hang,
      getOrderStatus: hang,
      fetchSettlements: hang,
    };
    const bounded = withPaymentTimeout(slow, 20);
    const unknown = { outcome: 'unknown', reason: 'timeout' };
    expect(await bounded.createOrder(ctx, orderRequest)).toEqual(unknown);
    expect(await bounded.getOrderStatus(ctx, { orderRef: null, operationKey: 'k' })).toEqual(
      unknown,
    );
    expect(await bounded.fetchSettlements(ctx, '2026-10-14')).toEqual(unknown);
  });

  it('turns a throw or a rejection into unknown / network, even a synchronous throw, and leaks nothing', async () => {
    const SENTINEL = 'SENTINEL-PROVIDER-SECRET-4242';
    const broken: PaymentProviderPort = {
      ...createUnconfiguredPaymentProvider(),
      createOrder: () => Promise.reject(new Error(SENTINEL)),
      getOrderStatus: () => {
        throw new Error(SENTINEL);
      },
    };
    const bounded = withPaymentTimeout(broken, 1000);
    const created = await bounded.createOrder(ctx, orderRequest);
    expect(created).toEqual({ outcome: 'unknown', reason: 'network' });
    const looked = await bounded.getOrderStatus(ctx, { orderRef: null, operationKey: 'k' });
    expect(looked).toEqual({ outcome: 'unknown', reason: 'network' });
    expect(JSON.stringify([created, looked])).not.toContain(SENTINEL);
  });

  it('passes answers through unchanged, including a definite refusal and the unknown the provider itself reports', async () => {
    const mock = createMockPaymentProvider('test', { scenario: 'success' });
    const bounded = withPaymentTimeout(mock, 1000);
    expect(bounded.descriptor).toBe(mock.descriptor);
    expect(bounded.capabilities).toBe(mock.capabilities);
    expect(bounded.webhookVerifier).toBe(mock.webhookVerifier);
    const created = await bounded.createOrder(ctx, orderRequest);
    expect(created.outcome).toBe('ok');
    expect(mock.created).toHaveLength(1);
    const refused = await bounded.createOrder(ctx, { ...orderRequest, amountMinor: 2n });
    expect(refused).toEqual({ outcome: 'rejected', reason: 'invalid_request' });
    const unknownScenario = withPaymentTimeout(
      createMockPaymentProvider('test', { scenario: 'unknown_outcome' }),
      1000,
    );
    expect(await unknownScenario.createOrder(ctx, orderRequest)).toEqual({
      outcome: 'unknown',
      reason: 'timeout',
    });
    // The wrapped provider still found the order: unknown means "look it up", and the lookup works.
    const found = await unknownScenario.getOrderStatus(ctx, {
      orderRef: null,
      operationKey: orderRequest.operationKey,
    });
    expect(found.outcome).toBe('ok');
  });

  it('does not let a late answer overturn the unknown, and keeps not_configured as not_configured', async () => {
    const late: PaymentProviderPort = {
      ...createUnconfiguredPaymentProvider(),
      getOrderStatus: () =>
        new Promise((resolve) => setTimeout(() => resolve({ outcome: 'not_found' as const }), 60)),
    };
    const bounded = withPaymentTimeout(late, 10);
    expect(await bounded.getOrderStatus(ctx, { orderRef: null, operationKey: 'k' })).toEqual({
      outcome: 'unknown',
      reason: 'timeout',
    });
    expect(
      await withPaymentTimeout(createUnconfiguredPaymentProvider(), 10).fetchSettlements(
        ctx,
        '2026-10-14',
      ),
    ).toEqual({ outcome: 'not_configured' });
  });

  it('refuses a limit that is not a positive finite number of milliseconds', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => withPaymentTimeout(createUnconfiguredPaymentProvider(), bad)).toThrow(
        RangeError,
      );
    }
  });
});
