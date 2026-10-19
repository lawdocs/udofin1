// The payment-provider callback receiver (`POST /v1/hooks/provider/:endpointToken`): the pure parts, then the route against an
// in-memory stand-in for the database (the real database is exercised by test/integration/provider-callbacks.integration.test.ts).
// Every guard has a test that fails when the guard is removed: the uniform refusal, the "only verified deliveries are accepted"
// rule, the raw-bytes signature check, the log discipline, the rate limits and the startup refusal without the address key.
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildMockDeliveries,
  MOCK_PAYMENT_PROVIDER_KEY,
  MOCK_PAYMENT_WEBHOOK_SCHEME,
  signMockWebhook,
  type AppEnvironment,
  type MockDelivery,
} from '@udofin/adapters';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { authenticatedRoutes } from '../src/http/api-routes.js';
import { buildOpenApi } from '../src/http/openapi.js';
import { loggerOptions } from '../src/logger.js';
import { type SystemPool } from '../src/system/pool.js';
import {
  toDeliveryJson,
  type IngestAnswer,
  type ProviderDelivery,
  type ProviderHookConfig,
  type ProviderHookProcessor,
} from '../src/system/provider-hooks.js';
import { buildCallbackApp } from '../src/workers/lender-callbacks.js';
import {
  addressHmac,
  describeVerification,
  FixedWindowLimiter,
  hashEndpointToken,
  IP_HMAC_SECRET_NAME,
  isEndpointTokenShape,
  PROVIDER_HOOK_BODY_LIMIT,
  PROVIDER_HOOK_DEFAULT_LIMITS,
  providerHookProblem,
  registerProviderHooks,
  resolveWebhookVerifier,
  statusForAnswer,
  timestampSkewSeconds,
  type ProviderHookDeps,
} from '../src/workers/provider-callbacks.js';

const NOW = new Date('2026-10-16T10:00:00.000Z');
const SECRET = 'whsec_test_provider_secret_for_unit_tests_0001';
const IP_KEY = 'unit-test-address-key-0123456789abcdef0123456789';
const WEBHOOK_SECRET_REF = 'SAMPLE_PROVIDER_WEBHOOK_SECRET';
const TOKEN = randomBytes(32).toString('base64url');
const TOKEN_HASH = hashEndpointToken(TOKEN);
const MERCHANT = 'SAMPLE-MERCHANT-1';
const ORDER = 'SAMPLE-ORDER-1';

const MOCK_CONFIG: ProviderHookConfig = {
  configId: randomUUID(),
  provider: MOCK_PAYMENT_PROVIDER_KEY,
  providerMode: 'mock',
  webhookSecretRef: WEBHOOK_SECRET_REF,
};

const sha256 = (data: Uint8Array | string): string =>
  createHash('sha256').update(data).digest('hex');

function deliveries(scenario: Parameters<typeof buildMockDeliveries>[0]): MockDelivery[] {
  return buildMockDeliveries(scenario, {
    secret: SECRET,
    orderRef: ORDER,
    paymentRef: 'SAMPLE-PAY-1',
    amountMinor: 125_000n,
    merchantRef: MERCHANT,
    now: NOW,
  });
}
function first(scenario: Parameters<typeof buildMockDeliveries>[0]): MockDelivery {
  const delivery = deliveries(scenario)[0];
  if (!delivery) throw new Error('scenario has no delivery');
  return delivery;
}
const captured = (): MockDelivery => {
  const delivery = deliveries('success')[1];
  if (!delivery) throw new Error('scenario has no second delivery');
  return delivery;
};

/** An in-memory stand-in for the database side: it records what the receiver asks and answers as scripted. */
class FakeProcessor implements ProviderHookProcessor {
  readonly configs = new Map<string, ProviderHookConfig>([[TOKEN_HASH, MOCK_CONFIG]]);
  readonly lookups: string[] = [];
  readonly ingests: { tokenHash: string; delivery: ProviderDelivery }[] = [];
  answer: (delivery: ProviderDelivery) => IngestAnswer = () => ({
    accepted: false,
    outcome: 'rejected',
  });
  failLookup = false;
  failIngest = false;
  lookupConfig(tokenHash: string): Promise<ProviderHookConfig | null> {
    this.lookups.push(tokenHash);
    if (this.failLookup) return Promise.reject(new Error('connection refused to db.internal'));
    return Promise.resolve(this.configs.get(tokenHash) ?? null);
  }
  ingest(tokenHash: string, delivery: ProviderDelivery): Promise<IngestAnswer> {
    this.ingests.push({ tokenHash, delivery });
    if (this.failIngest) {
      return Promise.reject(
        Object.assign(new Error('duplicate key (phone)=(9000000001)'), { code: '40001' }),
      );
    }
    return Promise.resolve(this.answer(delivery));
  }
}

const poolNotUsed = {
  withSystem: () => Promise.reject(new Error('the system pool must not be used in this test')),
  end: () => Promise.resolve(),
} satisfies SystemPool;

const accept: IngestAnswer = { accepted: true, outcome: 'ok' };

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

interface StartOptions {
  environment?: AppEnvironment;
  secret?: (name: string) => string | undefined;
  limits?: ProviderHookDeps['limits'];
  processor?: FakeProcessor;
}
async function start(options: StartOptions = {}) {
  const processor = options.processor ?? new FakeProcessor();
  const environment = options.environment ?? 'test';
  app = await buildCallbackApp(
    loadConfig({ APP_ENV: 'test', RATE_LIMIT_MAX_PER_MINUTE: '100000' }),
    {
      routing: {} as never,
      secret: () => undefined,
      environment,
    },
  );
  registerProviderHooks(app, {
    pool: poolNotUsed,
    environment,
    secret:
      options.secret ??
      ((name) =>
        name === WEBHOOK_SECRET_REF ? SECRET : name === IP_HMAC_SECRET_NAME ? IP_KEY : undefined),
    processor,
    now: () => NOW,
    ...(options.limits ? { limits: options.limits } : {}),
  });
  await app.ready();
  return { app, processor };
}

async function post(
  instance: FastifyInstance,
  token: string,
  delivery: Pick<MockDelivery, 'rawBody' | 'headers'>,
  extra: { headers?: Record<string, string>; remoteAddress?: string } = {},
) {
  return instance.inject({
    method: 'POST',
    url: `/v1/hooks/provider/${token}`,
    headers: { 'content-type': 'application/json', ...delivery.headers, ...extra.headers },
    payload: Buffer.from(delivery.rawBody),
    ...(extra.remoteAddress ? { remoteAddress: extra.remoteAddress } : {}),
  });
}

/** What a caller can observe, minus the per-request id. */
const observable = (res: Awaited<ReturnType<typeof post>>) => {
  const { instance: _instance, ...rest } = res.json<Record<string, unknown>>();
  return {
    status: res.statusCode,
    type: res.headers['content-type'],
    cache: res.headers['cache-control'],
    body: rest,
  };
};
const UNIFORM_401 = {
  type: 'about:blank',
  title: 'Unauthorized',
  status: 401,
  code: 'invalid_signature',
};

// ---------------------------------------------------------------------------------------------------------
describe('pure parts', () => {
  it('accepts only opaque tokens of 32 to 128 URL-safe characters', () => {
    expect(isEndpointTokenShape('a'.repeat(32))).toBe(true);
    expect(isEndpointTokenShape('A1_-'.repeat(32))).toBe(true);
    expect(isEndpointTokenShape('a'.repeat(128))).toBe(true);
    expect(isEndpointTokenShape(TOKEN)).toBe(true);
    for (const bad of [
      'a'.repeat(31),
      'a'.repeat(129),
      '',
      `${'a'.repeat(40)}/x`,
      `${'a'.repeat(40)}.`,
      `${'a'.repeat(40)} `,
      `${'a'.repeat(40)}%2e`,
      `${'a'.repeat(40)}=`,
      `${'a'.repeat(40)}\n`,
      `${'a'.repeat(40)}é`,
      undefined,
      null,
      42,
      ['a'.repeat(40)],
    ]) {
      expect(isEndpointTokenShape(bad)).toBe(false);
    }
  });

  it('hashes the token the way the configuration stores it (SHA-256, lower-case hex)', () => {
    expect(hashEndpointToken('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(hashEndpointToken(TOKEN)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keys the address hash and never returns the address', () => {
    const key = Buffer.from(IP_KEY);
    const h = addressHmac(key, '203.0.113.7');
    expect(h).toBe(createHmac('sha256', key).update('203.0.113.7').digest('hex'));
    expect(h).not.toContain('203');
    expect(addressHmac(Buffer.from('another-key'), '203.0.113.7')).not.toBe(h);
    expect(addressHmac(key, '203.0.113.8')).not.toBe(h);
  });

  it('maps database answers to statuses: ok 200, unmatched 409, invalid 422, anything else rejected 401', () => {
    expect(statusForAnswer({ accepted: true, outcome: 'ok' })).toBe(200);
    expect(statusForAnswer({ accepted: false, outcome: 'unmatched' })).toBe(409);
    expect(statusForAnswer({ accepted: false, outcome: 'invalid' })).toBe(422);
    expect(statusForAnswer({ accepted: false, outcome: 'rejected' })).toBe(401);
  });

  it('derives the timestamp skew from the signed header and drops absurd or malformed values', () => {
    expect(timestampSkewSeconds('1000', 1003)).toBe(3);
    expect(timestampSkewSeconds('1003', 1000)).toBe(-3);
    expect(timestampSkewSeconds(undefined, 1000)).toBeNull();
    expect(timestampSkewSeconds('abc', 1000)).toBeNull();
    expect(timestampSkewSeconds('-5', 1000)).toBeNull();
    expect(timestampSkewSeconds('1.5', 1000)).toBeNull();
    expect(timestampSkewSeconds('999999999999', 1000)).toBeNull();
  });

  it('limits per key within a window, resets after it, and stays bounded', () => {
    let at = 0;
    const limiter = new FixedWindowLimiter(2, 1000, () => at, 3);
    expect(limiter.allow('a')).toBe(true);
    expect(limiter.allow('a')).toBe(true);
    expect(limiter.allow('a')).toBe(false);
    expect(limiter.allow('b')).toBe(true);
    at = 1001;
    expect(limiter.allow('a')).toBe(true);
    // Bounded: the oldest key is dropped, not the process memory grown.
    for (const key of ['c', 'd', 'e', 'f', 'g']) expect(limiter.allow(key)).toBe(true);
    expect(limiter.allow('a')).toBe(true);
  });

  it('resolves a verifier only for the labelled mock provider in local development and tests', () => {
    const mock = { provider: MOCK_PAYMENT_PROVIDER_KEY, providerMode: 'mock' as const };
    for (const env of ['local', 'test'] as const) {
      const resolved = resolveWebhookVerifier(mock, env);
      expect(resolved.ok && resolved.verifier.scheme).toBe(MOCK_PAYMENT_WEBHOOK_SCHEME);
    }
    for (const env of ['staging', 'production'] as const) {
      expect(resolveWebhookVerifier(mock, env)).toEqual({ ok: false, reason: 'mock_blocked' });
    }
    for (const providerMode of ['sandbox', 'production'] as const) {
      expect(
        resolveWebhookVerifier({ provider: MOCK_PAYMENT_PROVIDER_KEY, providerMode }, 'test'),
      ).toEqual({
        ok: false,
        reason: 'scheme_not_configured',
      });
    }
    expect(
      resolveWebhookVerifier({ provider: 'some_real_gateway', providerMode: 'mock' }, 'test'),
    ).toEqual({
      ok: false,
      reason: 'scheme_not_configured',
    });
  });

  it('describes every verifier result with outcome words and reason classes the database accepts', () => {
    const resolved = resolveWebhookVerifier(MOCK_CONFIG, 'test');
    if (!resolved.ok) throw new Error('mock verifier expected');
    const verify = (delivery: Pick<MockDelivery, 'rawBody' | 'headers'>, secret = SECRET) =>
      describeVerification(
        resolved.verifier.verify(delivery.rawBody, delivery.headers, { secret, now: NOW }),
      );
    const ok = verify(captured());
    expect(ok).toMatchObject({ outcome: 'verified', reasonClass: 'none' });
    expect(ok.event).toMatchObject({
      provider: MOCK_PAYMENT_PROVIDER_KEY,
      objectKind: 'payment',
      status: 'captured',
      orderRef: ORDER,
      merchantRef: MERCHANT,
      amountMinor: '125000',
      currency: 'INR',
    });
    expect(verify(captured(), `${SECRET}-other`)).toEqual({
      outcome: 'unverified',
      reasonClass: 'signature_mismatch',
    });
    expect(verify(first('old_timestamp'))).toEqual({
      outcome: 'stale_timestamp',
      reasonClass: 'timestamp_outside_tolerance',
    });
    expect(verify({ rawBody: new TextEncoder().encode('not json'), headers: {} as never })).toEqual(
      {
        outcome: 'unverified',
        reasonClass: 'missing_headers',
      },
    );
    const garbage = new TextEncoder().encode('[1,2]');
    const signed = signMockWebhook({
      secret: SECRET,
      deliveryId: 'SAMPLE-DLV-GARBAGE',
      timestampSeconds: Math.floor(NOW.getTime() / 1000),
      rawBody: garbage,
    });
    expect(verify({ rawBody: garbage, headers: signed })).toEqual({
      outcome: 'invalid',
      reasonClass: 'malformed_body',
    });
  });

  it('turns a delivery into the JSON the database function reads, with money as a digit string and no empty keys', () => {
    const resolved = resolveWebhookVerifier(MOCK_CONFIG, 'test');
    if (!resolved.ok) throw new Error('mock verifier expected');
    const described = describeVerification(
      resolved.verifier.verify(captured().rawBody, captured().headers, {
        secret: SECRET,
        now: NOW,
      }),
    );
    const json = toDeliveryJson({
      provider: MOCK_PAYMENT_PROVIDER_KEY,
      outcome: 'verified',
      reasonClass: 'none',
      deliveryId: 'SAMPLE-DLV-2',
      payloadSha256: sha256('x'),
      scheme: MOCK_PAYMENT_WEBHOOK_SCHEME,
      signaturePresent: true,
      timestampSkewSeconds: 2,
      bodyBytes: 321,
      ipHmac: 'a'.repeat(64),
      ...(described.event ? { event: described.event } : {}),
    });
    expect(Object.keys(json).sort()).toEqual(
      [
        'body_bytes',
        'delivery_id',
        'event',
        'ip_hmac',
        'outcome',
        'payload_sha256',
        'provider',
        'reason_class',
        'scheme',
        'signature_present',
        'timestamp_skew_seconds',
      ].sort(),
    );
    expect(json.event).toMatchObject({ amountMinor: '125000', currency: 'INR', rank: 30 });
    const bare = toDeliveryJson({
      provider: 'unknown',
      outcome: 'unverified',
      reasonClass: 'signature_mismatch',
      deliveryId: null,
      payloadSha256: sha256('x'),
      scheme: null,
      signaturePresent: false,
      timestampSkewSeconds: null,
      bodyBytes: 0,
      ipHmac: 'b'.repeat(64),
    });
    expect(Object.keys(bare).sort()).toEqual(
      [
        'body_bytes',
        'ip_hmac',
        'outcome',
        'payload_sha256',
        'provider',
        'reason_class',
        'signature_present',
      ].sort(),
    );
  });

  it('carries the parent payment of a refund and of a chargeback all the way to the JSON the database reads, and none for a payment', () => {
    const resolved = resolveWebhookVerifier(MOCK_CONFIG, 'test');
    if (!resolved.ok) throw new Error('mock verifier expected');
    const eventJson = (delivery: MockDelivery) => {
      const described = describeVerification(
        resolved.verifier.verify(delivery.rawBody, delivery.headers, { secret: SECRET, now: NOW }),
      );
      if (!described.event) throw new Error('verified delivery expected');
      return toDeliveryJson({
        provider: MOCK_PAYMENT_PROVIDER_KEY,
        outcome: 'verified',
        reasonClass: 'none',
        deliveryId: delivery.headers['webhook-id'],
        payloadSha256: sha256('x'),
        scheme: MOCK_PAYMENT_WEBHOOK_SCHEME,
        signaturePresent: true,
        timestampSkewSeconds: 0,
        bodyBytes: delivery.rawBody.length,
        ipHmac: 'a'.repeat(64),
        event: described.event,
      }).event as Record<string, unknown>;
    };
    const refund = eventJson(deliveries('refund')[1] as MockDelivery);
    expect(refund).toMatchObject({
      objectKind: 'refund',
      objectRef: 'SAMPLE-PAY-1-REFUND',
      parentPaymentRef: 'SAMPLE-PAY-1',
    });
    const dispute = eventJson(deliveries('chargeback')[1] as MockDelivery);
    expect(dispute).toMatchObject({
      objectKind: 'chargeback',
      objectRef: 'SAMPLE-PAY-1-DISPUTE',
      parentPaymentRef: 'SAMPLE-PAY-1',
    });
    expect(Object.keys(eventJson(captured()))).not.toContain('parentPaymentRef');
  });

  it('has fixed problem documents that carry nothing from the request', () => {
    expect(providerHookProblem(401, 'req-1')).toEqual({ ...UNIFORM_401, instance: 'req-1' });
    expect(providerHookProblem(409, 'r')).toMatchObject({ status: 409, code: 'unmatched' });
    expect(providerHookProblem(422, 'r')).toMatchObject({ status: 422, code: 'invalid_event' });
    expect(providerHookProblem(429, 'r')).toMatchObject({ status: 429, code: 'rate_limited' });
    expect(providerHookProblem(503, 'r')).toMatchObject({
      status: 503,
      code: 'temporarily_unavailable',
    });
  });
});

// ---------------------------------------------------------------------------------------------------------
describe('what the receiver hands to the database', () => {
  it('sends one verified delivery with the hash of the exact body, the address only as a keyed hash, and answers 200', async () => {
    const { app: a, processor } = await start();
    processor.answer = () => accept;
    const delivery = captured();
    const res = await post(a, TOKEN, delivery, { remoteAddress: '203.0.113.7' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(processor.lookups).toEqual([TOKEN_HASH]);
    expect(processor.ingests).toHaveLength(1);
    const sent = processor.ingests[0];
    expect(sent?.tokenHash).toBe(TOKEN_HASH);
    expect(sent?.delivery).toMatchObject({
      provider: MOCK_PAYMENT_PROVIDER_KEY,
      outcome: 'verified',
      reasonClass: 'none',
      deliveryId: delivery.headers['webhook-id'],
      payloadSha256: sha256(delivery.rawBody),
      scheme: MOCK_PAYMENT_WEBHOOK_SCHEME,
      signaturePresent: true,
      timestampSkewSeconds: 0,
      bodyBytes: delivery.rawBody.length,
      ipHmac: addressHmac(Buffer.from(IP_KEY), '203.0.113.7'),
      event: {
        provider: MOCK_PAYMENT_PROVIDER_KEY,
        deliveryId: delivery.headers['webhook-id'],
        objectKind: 'payment',
        status: 'captured',
        orderRef: ORDER,
        amountMinor: '125000',
        currency: 'INR',
        merchantRef: MERCHANT,
      },
    });
    // The delivery handed over contains no token, signature, secret or address.
    const text = JSON.stringify(toDeliveryJson(sent?.delivery as ProviderDelivery));
    for (const forbidden of [TOKEN, delivery.headers['webhook-signature'], SECRET, '203.0.113.7']) {
      expect(text).not.toContain(forbidden);
    }
  });

  it('verifies the exact bytes: a signed body that is not valid UTF-8 passes the signature and is then invalid, not a signature failure', async () => {
    const { app: a, processor } = await start();
    const rawBody = Buffer.concat([
      Buffer.from('{"event_id":"SAMPLE-EVT-RAW","note":"'),
      Buffer.from([0xff, 0xfe, 0xfd]),
      Buffer.from('"}'),
    ]);
    const headers = signMockWebhook({
      secret: SECRET,
      deliveryId: 'SAMPLE-DLV-RAW',
      timestampSeconds: Math.floor(NOW.getTime() / 1000),
      rawBody,
    });
    const res = await post(a, TOKEN, { rawBody, headers });
    expect(res.statusCode).toBe(401);
    expect(processor.ingests[0]?.delivery).toMatchObject({
      outcome: 'invalid',
      reasonClass: 'malformed_body',
      payloadSha256: sha256(rawBody),
      bodyBytes: rawBody.length,
    });
    expect(processor.ingests[0]?.delivery.event).toBeUndefined();
  });

  it('maps the verifier outcomes to the words the database accepts, never attaching an event unless verified', async () => {
    const { app: a, processor } = await start();
    await post(a, TOKEN, first('bad_signature'));
    await post(a, TOKEN, first('old_timestamp'));
    await post(a, TOKEN, { rawBody: captured().rawBody, headers: {} as never });
    const outcomes = processor.ingests.map((i) => [i.delivery.outcome, i.delivery.reasonClass]);
    expect(outcomes).toEqual([
      ['unverified', 'signature_mismatch'],
      ['stale_timestamp', 'timestamp_outside_tolerance'],
      ['unverified', 'missing_headers'],
    ]);
    expect(processor.ingests.every((i) => i.delivery.event === undefined)).toBe(true);
    expect(processor.ingests[2]?.delivery.signaturePresent).toBe(false);
  });

  it('keeps an authentic unsupported kind verified-and-ignorable: it reaches the database as verified', async () => {
    const { app: a, processor } = await start();
    processor.answer = () => accept;
    const rawBody = new TextEncoder().encode(
      JSON.stringify({
        event_id: 'SAMPLE-EVT-UNSUPPORTED',
        object_kind: 'dispute_evidence',
        object_ref: 'SAMPLE-OBJ-1',
        status: 'whatever',
        occurred_at: NOW.toISOString(),
      }),
    );
    const headers = signMockWebhook({
      secret: SECRET,
      deliveryId: 'SAMPLE-DLV-UNSUPPORTED',
      timestampSeconds: Math.floor(NOW.getTime() / 1000),
      rawBody,
    });
    const res = await post(a, TOKEN, { rawBody, headers });
    expect(res.statusCode).toBe(200);
    expect(processor.ingests[0]?.delivery.event).toMatchObject({
      objectKind: 'unsupported',
      status: 'unmapped',
      amountMinor: null,
    });
  });
});

// ---------------------------------------------------------------------------------------------------------
describe('answers for a delivery this receiver verified', () => {
  it.each([
    [{ accepted: false, outcome: 'unmatched' } as const, 409, 'unmatched'],
    [{ accepted: false, outcome: 'invalid' } as const, 422, 'invalid_event'],
  ])('maps %o to %i', async (answer, status, code) => {
    const { app: a, processor } = await start();
    processor.answer = () => answer;
    const res = await post(a, TOKEN, captured());
    expect(res.statusCode).toBe(status);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toMatchObject({ status, code, type: 'about:blank' });
    expect(res.body).not.toContain('SAMPLE');
  });

  it('answers the uniform 401 when the database rejects an authentic delivery (for example a suspended configuration)', async () => {
    const { app: a, processor } = await start();
    processor.answer = () => ({ accepted: false, outcome: 'rejected' });
    const res = await post(a, TOKEN, captured());
    expect(observable(res)).toMatchObject({ status: 401, body: UNIFORM_401 });
  });

  it('answers 503 without detail when the database cannot be reached, so the provider retries', async () => {
    const lookup = await start();
    lookup.processor.failLookup = true;
    const a = await post(lookup.app, TOKEN, captured());
    expect(a.statusCode).toBe(503);
    expect(a.json()).toMatchObject({ status: 503, code: 'temporarily_unavailable' });
    expect(a.body).not.toContain('db.internal');
    await app?.close();

    const ingest = await start();
    ingest.processor.failIngest = true;
    const b = await post(ingest.app, TOKEN, captured());
    expect(b.statusCode).toBe(503);
    expect(b.body).not.toContain('9000000001');
    expect(b.body).not.toContain('duplicate');
  });
});

// ---------------------------------------------------------------------------------------------------------
describe('no enumeration: everything before the signature is verified looks the same', () => {
  it('answers the same for unknown, suspended, malformed, real-provider, mock-in-production, secretless and forged requests', async () => {
    const { app: a, processor } = await start();
    const realToken = randomBytes(32).toString('base64url');
    const sandboxToken = randomBytes(32).toString('base64url');
    const noSecretToken = randomBytes(32).toString('base64url');
    const otherProviderToken = randomBytes(32).toString('base64url');
    processor.configs.set(hashEndpointToken(sandboxToken), {
      ...MOCK_CONFIG,
      providerMode: 'sandbox',
    });
    processor.configs.set(hashEndpointToken(realToken), {
      ...MOCK_CONFIG,
      provider: 'some_real_gateway',
    });
    processor.configs.set(hashEndpointToken(noSecretToken), {
      ...MOCK_CONFIG,
      webhookSecretRef: 'MISSING_SECRET_NAME',
    });
    processor.configs.set(hashEndpointToken(otherProviderToken), {
      ...MOCK_CONFIG,
      provider: 'another_gateway',
    });

    const good = captured();
    const attempts = [
      await post(a, TOKEN, first('bad_signature')), // known token, forged signature
      await post(a, randomBytes(32).toString('base64url'), good), // unknown (or suspended or retired) token, GENUINE signature
      await post(a, 'short', good), // malformed token
      await post(a, `${'a'.repeat(40)}.dots`, good), // not URL-safe
      await post(a, sandboxToken, good), // sandbox mode: no scheme written
      await post(a, realToken, good), // a real provider's key: no scheme written
      await post(a, otherProviderToken, good),
      await post(a, noSecretToken, good), // our own configuration gap: secret name does not resolve
      await post(a, TOKEN, { rawBody: good.rawBody, headers: {} as never }), // no headers at all
      await post(a, TOKEN, first('old_timestamp')), // genuine signature, outside the tolerance
      await post(a, TOKEN, {
        rawBody: good.rawBody,
        headers: { ...good.headers, 'webhook-signature': 'v1,AAAA' },
      }),
    ];
    const reference = observable(attempts[0] as (typeof attempts)[number]);
    expect(reference).toEqual({
      status: 401,
      type: expect.stringContaining('application/problem+json') as string,
      cache: 'no-store',
      body: UNIFORM_401,
    });
    for (const attempt of attempts) expect(observable(attempt)).toEqual(reference);
    // Nothing was accepted by the database for any of them, and each request that passed the shape check made ONE lookup and ONE ingest.
    expect(processor.lookups).toHaveLength(attempts.length - 2);
    expect(processor.ingests).toHaveLength(attempts.length - 2);
    expect(processor.ingests.every((i) => i.delivery.event === undefined)).toBe(true);
  });

  it('takes the same path for an unknown token and for a bad signature: same calls, same delivery shape', async () => {
    const { app: a, processor } = await start();
    await post(a, TOKEN, first('bad_signature'));
    await post(a, randomBytes(32).toString('base64url'), first('bad_signature'));
    const [known, unknown] = processor.ingests;
    expect(processor.lookups).toHaveLength(2);
    expect(known?.delivery.outcome).toBe(unknown?.delivery.outcome);
    expect(known?.delivery.reasonClass).toBe(unknown?.delivery.reasonClass);
    expect(Object.keys(toDeliveryJson(known?.delivery as ProviderDelivery)).sort()).toEqual(
      Object.keys(toDeliveryJson(unknown?.delivery as ProviderDelivery))
        .filter((k) => k !== 'scheme')
        .concat('scheme')
        .sort(),
    );
  });

  it('never accepts a delivery it did not verify, whatever the database says', async () => {
    const { app: a, processor } = await start();
    processor.answer = () => accept; // a database that would accept anything
    const forged = await post(a, TOKEN, first('bad_signature'));
    const unknown = await post(a, randomBytes(32).toString('base64url'), captured());
    const stale = await post(a, TOKEN, first('old_timestamp'));
    const noHeaders = await post(a, TOKEN, { rawBody: captured().rawBody, headers: {} as never });
    for (const res of [forged, unknown, stale, noHeaders]) {
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject(UNIFORM_401);
    }
  });

  it('cannot be passed with a signature made from a public constant: the decoy key is random', async () => {
    const { app: a } = await start();
    const unknownToken = randomBytes(32).toString('base64url');
    for (const decoy of [
      'v1,whsec_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      '',
      'decoy',
      'whsec_decoy',
    ]) {
      const res = await post(a, unknownToken, {
        rawBody: captured().rawBody,
        headers: signMockWebhook({
          secret: decoy,
          deliveryId: 'SAMPLE-DLV-DECOY',
          timestampSeconds: Math.floor(NOW.getTime() / 1000),
          rawBody: captured().rawBody,
        }),
      });
      expect(res.statusCode).toBe(401);
    }
  });

  it('refuses a mock configuration outside local development and tests, even with a correct signature', async () => {
    for (const environment of ['staging', 'production'] as const) {
      const { app: a, processor } = await start({
        environment,
        secret: (name) =>
          name === WEBHOOK_SECRET_REF ? SECRET : name === IP_HMAC_SECRET_NAME ? IP_KEY : undefined,
      });
      processor.answer = () => accept;
      const res = await post(a, TOKEN, captured());
      expect(observable(res)).toMatchObject({ status: 401, body: UNIFORM_401 });
      expect(processor.ingests[0]?.delivery).toMatchObject({
        outcome: 'invalid',
        reasonClass: 'provider_scheme_not_configured',
      });
      await app?.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------
describe('transport limits', () => {
  it('rejects other content types and oversized bodies before any database work', async () => {
    const { app: a, processor } = await start();
    const text = await a.inject({
      method: 'POST',
      url: `/v1/hooks/provider/${TOKEN}`,
      headers: { 'content-type': 'text/plain' },
      payload: 'hello',
    });
    expect(text.statusCode).toBe(415);
    const form = await a.inject({
      method: 'POST',
      url: `/v1/hooks/provider/${TOKEN}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'a=b',
    });
    expect(form.statusCode).toBe(415);
    const big = await a.inject({
      method: 'POST',
      url: `/v1/hooks/provider/${TOKEN}`,
      headers: { 'content-type': 'application/json' },
      payload: Buffer.alloc(PROVIDER_HOOK_BODY_LIMIT + 1, 0x20),
    });
    expect(big.statusCode).toBe(413);
    expect(processor.lookups).toHaveLength(0);
    for (const res of [text, form, big]) expect(res.body).not.toContain(TOKEN);
  });

  it('accepts a body at the limit and treats an empty body as an unverified delivery', async () => {
    const { app: a, processor } = await start();
    const atLimit = await post(a, TOKEN, {
      rawBody: Buffer.alloc(PROVIDER_HOOK_BODY_LIMIT, 0x20),
      headers: first('bad_signature').headers,
    });
    expect(atLimit.statusCode).toBe(401);
    const empty = await a.inject({
      method: 'POST',
      url: `/v1/hooks/provider/${TOKEN}`,
      headers: { 'content-type': 'application/json' },
      payload: '',
    });
    expect(empty.statusCode).toBe(401);
    expect(processor.ingests).toHaveLength(2);
    expect(processor.ingests[1]?.delivery).toMatchObject({ outcome: 'unverified', bodyBytes: 0 });
  });

  it('counts failed deliveries per token hash and address, whether or not the token exists, and answers a valid and an invalid token alike (A30)', async () => {
    const { app: a, processor } = await start({ limits: { failuresPerMinute: 3 } });
    const unknown = randomBytes(32).toString('base64url');
    const known: number[] = [];
    for (let i = 0; i < 5; i++)
      known.push((await post(a, TOKEN, first('bad_signature'))).statusCode);
    expect(known).toEqual([401, 401, 401, 429, 429]);
    const other: number[] = [];
    for (let i = 0; i < 5; i++) other.push((await post(a, unknown, captured())).statusCode);
    expect(other).toEqual([401, 401, 401, 429, 429]);
    // A malformed token is counted the same way, so the shape of a token is not a way to tell the answers apart.
    const malformed: number[] = [];
    for (let i = 0; i < 5; i++)
      malformed.push((await post(a, 'x'.repeat(10), captured())).statusCode);
    expect(malformed).toEqual([401, 401, 401, 429, 429]);
    const limited = await post(a, TOKEN, first('bad_signature'));
    expect(limited.json()).toMatchObject({ status: 429, code: 'rate_limited' });
    expect(limited.headers['retry-after']).toBe('60');
    // The 429 stores nothing: only the three allowed failures of the known token and of the unknown token reached the database.
    expect(processor.ingests).toHaveLength(3 + 3);
  });

  it('junk sent to a callback URL cannot lock the real provider out of it (A30)', async () => {
    const { app: a, processor } = await start({
      limits: { failuresPerMinute: 3, perTokenPerMinute: 10 },
    });
    processor.answer = () => accept;
    // Someone who has seen the URL sends garbage from three addresses, far more than the failure budget of each.
    const junk: number[] = [];
    for (const address of ['198.51.100.1', '198.51.100.2', '198.51.100.3']) {
      for (let i = 0; i < 40; i++) {
        junk.push(
          (await post(a, TOKEN, first('bad_signature'), { remoteAddress: address })).statusCode,
        );
      }
    }
    expect(junk.filter((code) => code === 401)).toHaveLength(9);
    expect(junk.filter((code) => code === 429)).toHaveLength(111);
    // The genuine provider, from another address AND from an address that spent its whole failure budget, still gets through.
    const fresh = await post(a, TOKEN, captured(), { remoteAddress: '203.0.113.50' });
    expect(fresh.statusCode).toBe(200);
    const sameAsJunk = await post(a, TOKEN, deliveries('success')[0] as MockDelivery, {
      remoteAddress: '198.51.100.1',
    });
    expect(sameAsJunk.statusCode).toBe(200);
    // Junk from a new address still gets its own, fresh failure budget (the budget is per address, not shared).
    expect(
      (await post(a, TOKEN, first('bad_signature'), { remoteAddress: '198.51.100.9' })).statusCode,
    ).toBe(401);
    expect(processor.ingests.filter((i) => i.delivery.outcome === 'verified')).toHaveLength(2);
  });

  it('a verified delivery has a budget of its own per token, which junk never spends (A30)', async () => {
    const { app: a, processor } = await start({
      limits: { failuresPerMinute: 1000, perTokenPerMinute: 2 },
    });
    processor.answer = () => accept;
    for (let i = 0; i < 20; i++) await post(a, TOKEN, first('bad_signature'));
    const results: number[] = [];
    for (let i = 0; i < 4; i++) results.push((await post(a, TOKEN, captured())).statusCode);
    expect(results).toEqual([200, 200, 429, 429]);
    const limited = await post(a, TOKEN, captured());
    expect(limited.json()).toMatchObject({ status: 429, code: 'rate_limited' });
    expect(limited.headers['retry-after']).toBe('60');
    // The refused ones were not handed to the database; another token has its own budget.
    expect(processor.ingests.filter((i) => i.delivery.outcome === 'verified')).toHaveLength(2);
  });

  it('the defaults leave a verified delivery a much larger budget than a failed one', () => {
    expect(PROVIDER_HOOK_DEFAULT_LIMITS.perTokenPerMinute).toBeGreaterThan(
      PROVIDER_HOOK_DEFAULT_LIMITS.failuresPerMinute * 10,
    );
  });

  it('limits per client address on this route', async () => {
    const { app: a } = await start({
      limits: { perAddressPerMinute: 2, perTokenPerMinute: 1000, failuresPerMinute: 1000 },
    });
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) {
      codes.push((await post(a, TOKEN, captured(), { remoteAddress: '198.51.100.5' })).statusCode);
    }
    expect(codes).toEqual([401, 401, 429, 429]);
    expect((await post(a, TOKEN, captured(), { remoteAddress: '198.51.100.6' })).statusCode).toBe(
      401,
    );
  });
});

// ---------------------------------------------------------------------------------------------------------
describe('startup', () => {
  const build = async (
    environment: AppEnvironment,
    secret: (name: string) => string | undefined,
  ) => {
    const instance = Fastify();
    try {
      registerProviderHooks(instance, { pool: poolNotUsed, environment, secret });
      await instance.ready();
    } finally {
      await instance.close();
    }
  };

  it('refuses to start the route in staging and production without a strong address key', async () => {
    for (const environment of ['staging', 'production'] as const) {
      await expect(build(environment, () => undefined)).rejects.toThrow(IP_HMAC_SECRET_NAME);
      await expect(build(environment, () => '')).rejects.toThrow(IP_HMAC_SECRET_NAME);
      await expect(build(environment, () => 'too-short')).rejects.toThrow(/at least 32/);
      await expect(build(environment, () => 'x'.repeat(40))).resolves.toBeUndefined();
    }
  });

  it('does not put the key in the startup error, and starts locally with a per-process random key', async () => {
    const key = 'k'.repeat(10);
    await expect(build('production', () => key)).rejects.not.toThrow(key);
    await expect(build('local', () => undefined)).resolves.toBeUndefined();
    await expect(build('test', () => undefined)).resolves.toBeUndefined();
  });

  it('uses different address hashes across processes when no key is configured (a random key, not a constant)', async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2; i++) {
      const processor = new FakeProcessor();
      const instance = Fastify();
      await instance.register(rateLimit, { global: true, max: 1000, timeWindow: '1 minute' });
      registerProviderHooks(instance, {
        pool: poolNotUsed,
        environment: 'test',
        secret: (name) => (name === WEBHOOK_SECRET_REF ? SECRET : undefined),
        processor,
        now: () => NOW,
      });
      await instance.ready();
      await post(instance, TOKEN, captured());
      seen.add(processor.ingests[0]?.delivery.ipHmac ?? '');
      await instance.close();
    }
    expect(seen.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------------------
describe('logs', () => {
  /** The callback app the way it is built in a deployed process (real serializers and redaction), with the output captured. */
  async function loggedApp(processor: FakeProcessor, secret: (name: string) => string | undefined) {
    const lines: string[] = [];
    const stream = { write: (line: string) => void lines.push(line) };
    const config = loadConfig({ APP_ENV: 'local', LOG_LEVEL: 'trace' });
    const instance = Fastify({
      logger: { ...loggerOptions(config), level: 'trace', stream },
      bodyLimit: 262_144,
      genReqId: () => randomUUID(),
    });
    await instance.register(rateLimit, { global: true, max: 600, timeWindow: '1 minute' });
    instance.setErrorHandler((error, request, reply) => {
      const status = (error as { statusCode?: number }).statusCode;
      return reply
        .code(status && status >= 400 && status < 500 ? status : 500)
        .send({ code: 'bad_request', instance: request.id });
    });
    // A control route that logs the normal way: proves the capture would show a token in the path if the receiver did not suppress it.
    instance.post('/control/:endpointToken', () => ({ ok: true }));
    registerProviderHooks(instance, {
      pool: poolNotUsed,
      environment: 'test',
      secret,
      processor,
      now: () => NOW,
    });
    await instance.ready();
    app = instance;
    return { instance, lines };
  }

  it('never writes the token, signature, body, secret or address, in any outcome', async () => {
    const processor = new FakeProcessor();
    const noSecretToken = randomBytes(32).toString('base64url');
    const sandboxToken = randomBytes(32).toString('base64url');
    processor.configs.set(hashEndpointToken(noSecretToken), {
      ...MOCK_CONFIG,
      webhookSecretRef: 'NOT_SET_ANYWHERE',
    });
    processor.configs.set(hashEndpointToken(sandboxToken), {
      ...MOCK_CONFIG,
      providerMode: 'sandbox',
    });
    const { instance, lines } = await loggedApp(processor, (name) =>
      name === WEBHOOK_SECRET_REF ? SECRET : name === IP_HMAC_SECRET_NAME ? IP_KEY : undefined,
    );
    const address = '203.0.113.99';
    const good = captured();
    const canaryBody = Buffer.from(
      JSON.stringify({
        event_id: 'EVT-CANARY',
        account_number: '918273645500',
        note: 'CANARY-BODY-TEXT',
      }),
    );
    const canarySigned = {
      rawBody: canaryBody,
      headers: signMockWebhook({
        secret: SECRET,
        deliveryId: 'SAMPLE-DLV-CANARY',
        timestampSeconds: Math.floor(NOW.getTime() / 1000),
        rawBody: canaryBody,
      }),
    };
    const tokens = [TOKEN, noSecretToken, sandboxToken, randomBytes(32).toString('base64url')];

    processor.answer = () => accept;
    for (const token of tokens) {
      for (const delivery of [good, first('bad_signature'), first('old_timestamp'), canarySigned]) {
        await post(instance, token, delivery, { remoteAddress: address });
      }
    }
    processor.answer = () => ({ accepted: false, outcome: 'unmatched' });
    await post(instance, TOKEN, good, { remoteAddress: address });
    processor.failIngest = true;
    await post(instance, TOKEN, good, { remoteAddress: address });
    processor.failIngest = false;
    processor.failLookup = true;
    await post(instance, TOKEN, good, { remoteAddress: address });
    // Transport errors too (they are logged by the framework).
    await instance.inject({
      method: 'POST',
      url: `/v1/hooks/provider/${TOKEN}`,
      headers: { 'content-type': 'text/plain' },
      payload: 'CANARY-BODY-TEXT',
      remoteAddress: address,
    });

    const log = lines.join('\n');
    expect(lines.length).toBeGreaterThan(0); // configuration gaps and database trouble are logged, as reason classes
    const forbidden = [
      ...tokens,
      SECRET,
      IP_KEY,
      address,
      'CANARY-BODY-TEXT',
      '918273645500',
      'EVT-CANARY',
      'SAMPLE-ORDER-1',
      'SAMPLE-MERCHANT-1',
      'db.internal',
      '9000000001',
      good.headers['webhook-signature'],
      good.headers['webhook-id'],
      canarySigned.headers['webhook-signature'],
      first('bad_signature').headers['webhook-signature'],
      TOKEN_HASH,
      sha256(good.rawBody),
    ];
    for (const value of forbidden) expect(log).not.toContain(value);
    // What IS logged: reason classes.
    expect(log).toContain('webhook_secret_not_configured');
    expect(log).toContain('scheme_not_configured');
    expect(log).toContain('ingest_failed');
    expect(log).toContain('config_lookup_failed');
    expect(log).toContain('"code":"40001"');
    // Every line of this route is a warning or worse; the info lines that carry the URL are not written.
    for (const line of lines) {
      const entry = JSON.parse(line) as { level: string; req?: unknown; msg?: string };
      expect(['warn', 'error']).toContain(entry.level);
      expect(entry.req).toBeUndefined();
    }
  });

  it('does not write the token for requests that miss the route (trailing slash, wrong method, extra path)', async () => {
    const { instance, lines } = await loggedApp(new FakeProcessor(), () => IP_KEY);
    const address = '203.0.113.98';
    const responses = [
      await instance.inject({
        method: 'POST',
        url: `/v1/hooks/provider/${TOKEN}/`,
        headers: { 'content-type': 'application/json' },
        payload: '{}',
        remoteAddress: address,
      }),
      await instance.inject({
        method: 'GET',
        url: `/v1/hooks/provider/${TOKEN}`,
        remoteAddress: address,
      }),
      await instance.inject({
        method: 'POST',
        url: `/v1/hooks/provider/${TOKEN}/extra/path`,
        headers: { 'content-type': 'application/json' },
        payload: '{}',
        remoteAddress: address,
      }),
      await instance.inject({
        method: 'POST',
        url: `/v1/hooks/provider/${'a'.repeat(120)}`,
        headers: { 'content-type': 'application/json' },
        payload: '{}',
        remoteAddress: address,
      }),
    ];
    // All of them answer alike and fixed, and none of them is a processed delivery.
    for (const res of responses) {
      expect(res.statusCode).toBe(404);
      expect(res.body).not.toContain(TOKEN);
    }
    const log = lines.join('\n');
    expect(log).not.toContain(TOKEN);
    expect(log).not.toContain('a'.repeat(120));
    expect(log).not.toContain(address);
  });

  it('control: a route without the suppression writes request lines, so their absence for the receiver is meaningful', async () => {
    const { instance, lines } = await loggedApp(new FakeProcessor(), () => IP_KEY);
    await instance.inject({
      method: 'POST',
      url: `/control/${TOKEN}`,
      headers: { 'content-type': 'application/json' },
      payload: '{}',
      remoteAddress: '203.0.113.99',
    });
    const messages = lines.map((line) => (JSON.parse(line) as { msg?: string }).msg);
    expect(messages).toEqual(['incoming request', 'request completed']);
    // And the same request to the receiver writes none of them.
    lines.length = 0;
    await post(instance, TOKEN, captured(), { remoteAddress: '203.0.113.99' });
    expect(lines).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------
describe('boundary: the route exists only in the callback receiver', () => {
  it('is not in the public API route table and answers 404 there', async () => {
    const config = loadConfig({ APP_ENV: 'test' });
    const publicApp = await buildApp(config, {});
    try {
      expect(publicApp.printRoutes()).not.toMatch(/hooks\/provider|provider\/:endpointToken/);
      const res = await publicApp.inject({
        method: 'POST',
        url: `/v1/hooks/provider/${TOKEN}`,
        headers: { 'content-type': 'application/json' },
        payload: '{}',
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await publicApp.close();
    }
  });

  it('is not in the generated OpenAPI document or the committed one', () => {
    const doc = JSON.stringify(buildOpenApi(authenticatedRoutes(), '0.0.0'));
    expect(doc).not.toContain('hooks/provider');
    const committed = readFileSync(
      join(import.meta.dirname, '..', '..', '..', 'docs', 'api', 'openapi.json'),
      'utf8',
    );
    expect(committed).not.toContain('hooks/provider');
  });

  it('is registered by the callback-receiver entry point and by nothing that the public API loads', () => {
    const src = join(import.meta.dirname, '..', 'src');
    const read = (path: string) => readFileSync(join(src, path), 'utf8');
    expect(read('workers/callbacks-main.ts')).toContain('registerProviderHooks');
    for (const file of ['app.ts', 'server.ts', 'http/api-routes.ts', 'http/routes.ts']) {
      expect(read(file)).not.toMatch(/provider-callbacks|provider-hooks/);
    }
  });
});
