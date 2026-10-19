// A20: a validation error names the failing fields and rule codes, never a value and never a key the caller typed. The key of a
// record is caller text (a pasted account number, PAN or phone number can end up there), so it must not come back in the problem.
import { FeatureChangeRequestInput, PaymentConfigDraftInput } from '@udofin/contracts';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { publicRoute, registerRoutes } from '../src/http/routes.js';

const LENDER = '0198f3a0-0000-7000-8000-000000000001';
const REGISTRY = '0198f3a0-0000-7000-8000-000000000002';
const SETTLEMENT = '0198f3a0-0000-7000-8000-000000000003';
const NUMBER = '918273645500';
const PAN = 'ABCDE1234F';
// A key the record accepts (lower case) and one it does not (upper case): both are caller text.
const MARKER = 'canary_key_zq7x';
const BAD_MARKER = 'CANARY_KEY_ZQ7X';

const NestedInput = z.strictObject({
  items: z.array(z.strictObject({ name: z.string(), tags: z.record(z.string(), z.number()) })),
});

const echo = (path: string, operationId: string, body: z.ZodType) =>
  publicRoute({
    method: 'post',
    path,
    operationId,
    summary: operationId,
    tags: ['Test'],
    auth: 'none',
    body,
    responses: { 200: z.object({}) },
    errors: [422],
    rateLimit: false,
    handler: () => Promise.resolve({ status: 200, body: {} }),
  });

describe('validation problems never carry a caller-supplied key (A20)', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = Fastify({ logger: false });
    registerRoutes(
      app,
      [
        echo('/t/config', 'testConfig', PaymentConfigDraftInput),
        echo('/t/feature', 'testFeature', FeatureChangeRequestInput),
        echo('/t/nested', 'testNested', NestedInput),
      ],
      {},
    );
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  const post = async (url: string, payload: unknown) => {
    const res = await app.inject({ method: 'POST', url, payload: payload as object });
    return {
      status: res.statusCode,
      body: res.body,
      detail: res.json<{ detail?: string }>().detail,
    };
  };
  const config = {
    lenderId: LENDER,
    provider: 'testpay',
    providerMode: 'sandbox',
    merchantRegistryId: REGISTRY,
    settlementAccountId: SETTLEMENT,
    // Secret NAMES lie inside a lender namespace (L, twelve capital hexadecimal digits, an underscore).
    secretRef: 'L0198B3F40001_PROVIDER_API',
    webhookSecretRef: 'L0198B3F40001_PROVIDER_HOOK',
  };

  it('writes `*` for the key of a record, at the first and the second level', async () => {
    const first = await post('/t/config', { ...config, railLimits: { [NUMBER]: { a_limit: 1 } } });
    expect(first.status).toBe(422);
    expect(first.detail).toBe('railLimits.*: invalid_key');
    expect(first.body).not.toContain(NUMBER);
    const leaf = await post('/t/config', { ...config, railLimits: { upi: { [NUMBER]: 1 } } });
    expect(leaf.detail).toBe('railLimits.*.*: invalid_key');
    expect(leaf.body).not.toContain(NUMBER);
    expect(leaf.body).not.toContain('upi');
  });

  it('does the same for a feature request whose evidence has a number, a PAN or any other text as its key', async () => {
    const base = { lenderId: LENDER, feature: 'payments', enable: true };
    for (const key of [NUMBER, PAN, BAD_MARKER, 'x y', '9876543210', `${PAN}.${NUMBER}`]) {
      const res = await post('/t/feature', { ...base, evidence: { [key]: 'x' } });
      expect([key, res.status]).toEqual([key, 422]);
      expect(res.body, key).not.toContain(key);
      expect(res.detail, key).toMatch(/^evidence\.\*: invalid_key$/);
    }
    // A key that is allowed but whose value is wrong would also have been echoed (the path names the key).
    const value = await post('/t/feature', { ...base, evidence: { [MARKER]: 5 } });
    expect(value.status).toBe(422);
    expect(value.body).not.toContain(MARKER);
  });

  it('writes `*` for a record key under an array element and keeps the array position and the declared names', async () => {
    const res = await post('/t/nested', {
      items: [
        { name: 'a', tags: {} },
        { name: 'b', tags: { [PAN]: 'not a number' } },
        { tags: {} },
      ],
    });
    expect(res.status).toBe(422);
    expect(res.detail).toContain('items.1.tags.*: invalid_type');
    expect(res.detail).toContain('items.2.name: invalid_type');
    expect(res.body).not.toContain(PAN);
  });

  it('still names the declared field of an ordinary mistake, and an unknown field only as a rule code', async () => {
    const res = await post('/t/feature', {
      lenderId: 'not-a-uuid',
      feature: 'payments',
      enable: 'yes',
    });
    expect(res.detail).toContain('lenderId: invalid_format');
    expect(res.detail).toContain('enable: invalid_type');
    const unknown = await post('/t/feature', {
      lenderId: LENDER,
      feature: 'payments',
      enable: true,
      [NUMBER]: 'x',
    });
    expect(unknown.status).toBe(422);
    expect(unknown.detail).toBe('body: unrecognized_keys');
    expect(unknown.body).not.toContain(NUMBER);
  });
});
