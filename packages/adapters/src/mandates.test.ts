import { describe, expect, it } from 'vitest';
import {
  buildMockMandateDeliveries,
  createMockMandateProvider,
  createMockPaymentProvider,
  createUnconfiguredMandateProvider,
  defaultEventRank,
  MOCK_MANDATE_RETURN_CODE,
  type MandateRequest,
  type MockMandateScenario,
  type NormalisedProviderEvent,
} from './index.js';
import { ProviderNotAllowedError, type ProviderCallContext } from './provider.js';

const ctx: ProviderCallContext = { tenantId: 'SAMPLE-TENANT', correlationId: 'SAMPLE-CORR' };
const NOW = new Date('2026-10-14T05:00:00.000Z');
const SECRET = 'SAMPLE-webhook-secret-not-real-0002';
const request: MandateRequest = {
  operationKey: 'SAMPLE-MANDATE-0001',
  rail: 'enach_api',
  merchantRef: 'SAMPLE-CREDITOR-0001',
  maxAmountMinor: 1_000_000n,
  currency: 'INR',
  startDate: '2026-11-01',
  endDate: '2027-11-01',
  maskedAccountRef: 'XXXXXX0001',
};

describe('mock mandate provider', () => {
  it('is labelled, and refused in staging and production', () => {
    expect(createMockMandateProvider('test').descriptor).toEqual({
      key: 'mock_mandate_provider',
      capability: 'mandate',
      mode: 'mock',
    });
    expect(() => createMockMandateProvider('production')).toThrow(ProviderNotAllowedError);
    expect(() => createMockMandateProvider('staging')).toThrow(/local development and tests only/);
    expect(() => createMockMandateProvider('local')).not.toThrow();
  });

  it('reports per-rail capability, with UPI conservatively needing authentication on each debit', () => {
    const { capabilities } = createMockMandateProvider('test');
    expect(capabilities.rails.upi_autopay).toEqual({ supported: true, needsAfaEachDebit: true });
    expect(capabilities.rails.enach_api.supported).toBe(true);
  });

  it('a hand-off is typed and valued as NOT an activation, and a repeat is the same request', async () => {
    const p = createMockMandateProvider('test');
    const first = await p.createMandateRequest(ctx, request);
    expect(first).toMatchObject({ outcome: 'ok', value: { kind: 'handoff', activated: false } });
    expect(JSON.stringify(first)).not.toMatch(/"(status|state)":"active"/);
    expect(await p.createMandateRequest(ctx, request)).toEqual(first);
    expect(p.requests).toHaveLength(1);
    // A hand-off alone leaves the mandate unregistered: the status comes only from a lookup.
    const q = createMockMandateProvider('test', 'delayed');
    await q.createMandateRequest(ctx, request);
    const status = await q.getMandateStatus(ctx, {
      providerMandateRef: null,
      operationKey: request.operationKey,
    });
    expect(status).toMatchObject({
      outcome: 'ok',
      value: { source: 'provider_authenticated_lookup', status: 'registration_pending' },
    });
  });

  it('refuses a full account number, a bad rail, a bad amount and bad dates', async () => {
    const p = createMockMandateProvider('test');
    const rejected = { outcome: 'rejected', reason: 'invalid_request' };
    expect(
      await p.createMandateRequest(ctx, { ...request, maskedAccountRef: '123456789012' }),
    ).toEqual(rejected);
    expect(await p.createMandateRequest(ctx, { ...request, maxAmountMinor: 0n })).toEqual(rejected);
    expect(await p.createMandateRequest(ctx, { ...request, startDate: '2027-12-01' })).toEqual(
      rejected,
    );
    expect(await p.createMandateRequest(ctx, { ...request, endDate: '2027-02-30' })).toEqual(
      rejected,
    );
    expect(await p.createMandateRequest(ctx, { ...request, merchantRef: 'has space' })).toEqual(
      rejected,
    );
    expect(
      await p.createMandateRequest(ctx, { ...request, rail: 'cheque' as 'enach_api' }),
    ).toEqual({ outcome: 'rejected', reason: 'rail_not_supported' });
    expect(p.requests).toHaveLength(0);
  });

  const lookups = async (scenario: MockMandateScenario, count = 3) => {
    const p = createMockMandateProvider('test', scenario);
    await p.createMandateRequest(ctx, request);
    const out: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const r = await p.getMandateStatus(ctx, {
        providerMandateRef: null,
        operationKey: request.operationKey,
      });
      if (r.outcome === 'ok') out.push(r.value.status);
    }
    return out;
  };

  it('scenarios resolve through the authenticated lookup', async () => {
    expect(await lookups('registered')).toEqual(['active', 'active', 'active']);
    expect(await lookups('rejected')).toEqual(['rejected', 'rejected', 'rejected']);
    expect(await lookups('expired', 1)).toEqual(['expired']);
    expect(await lookups('revoked')).toEqual(['active', 'revoked', 'revoked']);
    expect(await lookups('delayed', 4)).toEqual([
      'registration_pending',
      'registration_pending',
      'active',
      'active',
    ]);
    expect(await lookups('contradictory_events', 2)).toEqual(['active', 'active']);
  });

  it('unknown outcome: create answers unknown, a lookup by our key finds it, a retry creates nothing more', async () => {
    const p = createMockMandateProvider('test', 'unknown_outcome');
    expect(await p.createMandateRequest(ctx, request)).toEqual({
      outcome: 'unknown',
      reason: 'timeout',
    });
    const first = await p.getMandateStatus(ctx, {
      providerMandateRef: null,
      operationKey: request.operationKey,
    });
    expect(first).toMatchObject({ outcome: 'ok', value: { status: 'registration_pending' } });
    expect((await p.createMandateRequest(ctx, request)).outcome).toBe('ok');
    expect(p.requests).toHaveLength(1);
    expect(
      await p.getMandateStatus(ctx, { providerMandateRef: 'nope', operationKey: 'nope' }),
    ).toEqual({ outcome: 'not_found' });
  });

  it('cancel is a request: it never claims the mandate is cancelled', async () => {
    const p = createMockMandateProvider('test');
    const created = await p.createMandateRequest(ctx, request);
    const ref = created.outcome === 'ok' ? created.value.providerMandateRef : '';
    const ack = await p.cancelMandate(ctx, {
      providerMandateRef: ref,
      operationKey: 'SAMPLE-CANCEL-1',
    });
    expect(ack).toMatchObject({
      outcome: 'ok',
      value: { kind: 'cancel_requested', cancelled: false },
    });
    const after = await p.getMandateStatus(ctx, {
      providerMandateRef: ref,
      operationKey: request.operationKey,
    });
    expect(after).toMatchObject({ value: { status: 'active' } });
    expect(await p.cancelMandate(ctx, { providerMandateRef: 'nope', operationKey: 'k' })).toEqual({
      outcome: 'not_found',
    });
    expect(p.cancelRequests).toHaveLength(1);
  });

  it('returned debit: the return code is stored verbatim and the amount never exceeds the mandate maximum', async () => {
    const p = createMockMandateProvider('test', 'returned_debit');
    const created = await p.createMandateRequest(ctx, { ...request, maxAmountMinor: 100_000n });
    const ref = created.outcome === 'ok' ? created.value.providerMandateRef : '';
    const debits = await p.listDebitStatus(ctx, {
      providerMandateRef: ref,
      from: '2026-11-05',
      to: '2026-11-05',
    });
    expect(debits).toMatchObject({
      outcome: 'ok',
      value: [
        {
          status: 'returned',
          returnCode: MOCK_MANDATE_RETURN_CODE,
          amountMinor: 100_000n,
          scheduledOn: '2026-11-05',
        },
      ],
    });
    expect(
      await p.listDebitStatus(ctx, {
        providerMandateRef: ref,
        from: '2026-11-06',
        to: '2026-11-05',
      }),
    ).toEqual({ outcome: 'rejected', reason: 'invalid_request' });
    const ok = createMockMandateProvider('test', 'registered');
    const made = await ok.createMandateRequest(ctx, request);
    const okRef = made.outcome === 'ok' ? made.value.providerMandateRef : '';
    expect(
      await ok.listDebitStatus(ctx, {
        providerMandateRef: okRef,
        from: '2026-11-05',
        to: '2026-11-05',
      }),
    ).toMatchObject({ value: [{ status: 'scheduled', returnCode: null, amountMinor: 450_000n }] });
    expect(
      await createMockMandateProvider('test', 'rejected').listDebitStatus(ctx, {
        providerMandateRef: 'x',
        from: '2026-11-05',
        to: '2026-11-05',
      }),
    ).toEqual({ outcome: 'not_found' });
  });
});

describe('scripted mandate deliveries', () => {
  const verifier = createMockPaymentProvider('test').webhookVerifier;
  const params = {
    secret: SECRET,
    providerMandateRef: 'MOCK-MANDATE-SAMPLE-1',
    providerDebitRef: 'MOCK-DEBIT-SAMPLE-1',
    debitAmountMinor: 450_000n,
    merchantRef: 'SAMPLE-CREDITOR-0001',
    now: NOW,
  };
  const events = (scenario: MockMandateScenario): NormalisedProviderEvent[] =>
    buildMockMandateDeliveries(scenario, params).map((d) => {
      const v = verifier.verify(d.rawBody, d.headers, { secret: SECRET, now: NOW });
      if (v.outcome !== 'verified') throw new Error(`delivery ${d.label} not verified`);
      return v.event;
    });

  it('produces verified mandate and debit events for each scenario', () => {
    expect(events('registered').map((e) => e.status)).toEqual(['pending', 'active']);
    expect(events('rejected').map((e) => e.status)).toEqual(['rejected']);
    expect(events('revoked').map((e) => e.status)).toEqual(['active', 'revoked']);
    expect(events('expired').map((e) => e.status)).toEqual(['active', 'expired']);
    expect(events('unknown_outcome')).toEqual([]);
    const returned = events('returned_debit');
    expect(returned.map((e) => [e.objectKind, e.status])).toEqual([
      ['mandate', 'active'],
      ['debit', 'pending'],
      ['debit', 'returned'],
    ]);
    expect(returned[2]).toMatchObject({
      amountMinor: 450_000n,
      orderRef: params.providerMandateRef,
    });
    expect(events('delayed')[0]?.occurredAt).toBe('2026-10-13T05:00:00.000Z');
  });

  it('contradictory events: a later rejection ranks below the activation and so can never revert it', () => {
    const [active, rejected] = events('contradictory_events');
    expect(active?.status).toBe('active');
    expect(rejected?.status).toBe('rejected');
    expect((rejected?.rank ?? 99) < (active?.rank ?? 0)).toBe(true);
    expect(defaultEventRank('revoked')).toBeGreaterThan(defaultEventRank('active'));
  });
});

describe('unconfigured mandate provider', () => {
  it('refuses honestly: no rail is supported and every call is not_configured', async () => {
    const p = createUnconfiguredMandateProvider();
    expect(p.descriptor.key).toBe('mandate_provider_not_configured');
    expect(p.capabilities.rails.enach_api.supported).toBe(false);
    expect(p.capabilities.rails.upi_autopay.supported).toBe(false);
    const nc = { outcome: 'not_configured' };
    expect(await p.createMandateRequest(ctx, request)).toEqual(nc);
    expect(await p.getMandateStatus(ctx, { providerMandateRef: null, operationKey: 'k' })).toEqual(
      nc,
    );
    expect(await p.cancelMandate(ctx, { providerMandateRef: 'm', operationKey: 'k' })).toEqual(nc);
    expect(
      await p.listDebitStatus(ctx, {
        providerMandateRef: 'm',
        from: '2026-11-01',
        to: '2026-11-02',
      }),
    ).toEqual(nc);
  });
});
