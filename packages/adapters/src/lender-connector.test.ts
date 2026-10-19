import { describe, expect, it } from 'vitest';
import {
  createLocalKeyManager,
  createMockLenderConnector,
  createUnconfiguredLenderConnector,
  signMockCallback,
  verifyMockCallback,
  withLenderTimeout,
  type LenderConnector,
  type LenderSubmitRequest,
} from './index.js';
import { ProviderNotAllowedError } from './provider.js';

const request: LenderSubmitRequest = {
  lenderId: '00000000-0000-4000-8000-000000000001',
  correlationRef: '11111111-2222-4333-8444-555555555555',
  attempt: 1,
  payload: {
    udofinReference: 'UR-AAAAAAAAA1',
    request: {
      categoryKey: 'personal',
      amountMinor: 5_000_000,
      tenureDays: 365,
      purposeCode: 'medical',
    },
    productVersionId: '22222222-2222-4222-8222-222222222222',
    displayName: null,
    phone: '919999900001',
    language: 'en',
  },
};

describe('lender connector port', () => {
  it('an unconfigured connector refuses honestly', async () => {
    const c = createUnconfiguredLenderConnector();
    expect(await c.submit(request)).toEqual({ status: 'not_configured' });
    expect(await c.lookup(request)).toEqual({ status: 'unknown' });
  });

  it('the mock is labelled, records exactly what it was sent, and exists only locally and in tests', async () => {
    const mock = createMockLenderConnector('test');
    expect(mock.descriptor.mode).toBe('mock');
    expect(mock.descriptor.key).toMatch(/^mock_/);
    const result = await mock.submit(request);
    expect(result.status).toBe('accepted');
    expect(mock.submitted).toHaveLength(1);
    expect(Object.keys(mock.submitted[0]?.payload ?? {}).sort()).toEqual([
      'displayName',
      'language',
      'phone',
      'productVersionId',
      'request',
      'udofinReference',
    ]);
    expect(() => createMockLenderConnector('production')).toThrow(ProviderNotAllowedError);
    expect(() => createMockLenderConnector('staging')).toThrow(/local development and tests only/);
    expect(() => createMockLenderConnector('local')).not.toThrow();
  });

  it("keeps recorded requests independent of later changes to the caller's object", async () => {
    const mock = createMockLenderConnector('test');
    const copy = structuredClone(request);
    await mock.submit(copy);
    copy.payload.phone = 'changed';
    expect(mock.submitted[0]?.payload.phone).toBe('919999900001');
  });

  it('a slow lender is "unknown", never "rejected"; a thrown error is "unknown" too', async () => {
    const slow: LenderConnector = {
      ...createUnconfiguredLenderConnector(),
      submit: () => new Promise(() => undefined),
    };
    expect(await withLenderTimeout(slow, 20).submit(request)).toEqual({
      status: 'unknown',
      reason: 'timeout',
    });
    const broken: LenderConnector = {
      ...createUnconfiguredLenderConnector(),
      submit: () => Promise.reject(new Error('boom')),
    };
    expect(await withLenderTimeout(broken, 1000).submit(request)).toEqual({
      status: 'unknown',
      reason: 'network',
    });
    const hangingLookup: LenderConnector = {
      ...createUnconfiguredLenderConnector(),
      lookup: () => new Promise(() => undefined),
    };
    expect(await withLenderTimeout(hangingLookup, 20).lookup(request)).toEqual({
      status: 'unknown',
    });
  });

  it('queued results and lookup answers can be scripted for reconciliation tests', async () => {
    const mock = createMockLenderConnector('test');
    mock.queue(
      { status: 'unknown', reason: 'timeout' },
      { status: 'rejected', reason: 'lender_refused' },
    );
    expect((await mock.submit(request)).status).toBe('unknown');
    expect((await mock.submit(request)).status).toBe('rejected');
    expect((await mock.submit(request)).status).toBe('accepted');
    mock.setLookup(request.correlationRef, { status: 'found', lenderApplicationRef: 'X-1' });
    expect(await mock.lookup(request)).toEqual({ status: 'found', lenderApplicationRef: 'X-1' });
  });
});

describe('mock callback signing (test scheme only)', () => {
  const secret = `v1,whsec_${Buffer.from('a-test-secret-of-sufficient-length-0123').toString('base64')}`;
  const body = '{"x":1}';
  const now = 1_800_000_000;
  const sig = signMockCallback(secret, 'msg_00000001', now, body);

  it('accepts a valid signature and rejects tampering, a wrong secret, a stale time and missing parts', () => {
    const base = {
      secret,
      id: 'msg_00000001',
      timestamp: String(now),
      signatureHeader: sig,
      body,
      now,
    };
    expect(verifyMockCallback(base)).toBe(true);
    expect(verifyMockCallback({ ...base, body: '{"x":2}' })).toBe(false);
    expect(verifyMockCallback({ ...base, id: 'msg_00000002' })).toBe(false);
    expect(
      verifyMockCallback({
        ...base,
        secret: `v1,whsec_${Buffer.from('another-secret-of-sufficient-length-99').toString('base64')}`,
      }),
    ).toBe(false);
    expect(verifyMockCallback({ ...base, now: now + 301 })).toBe(false);
    expect(verifyMockCallback({ ...base, now: now - 301 })).toBe(false);
    expect(verifyMockCallback({ ...base, signatureHeader: undefined })).toBe(false);
    expect(verifyMockCallback({ ...base, signatureHeader: 'v1,AAAA' })).toBe(false);
    expect(verifyMockCallback({ ...base, timestamp: 'x' })).toBe(false);
  });
});

describe('local key manager (development and tests only)', () => {
  const keys = {
    1: Buffer.alloc(32, 1).toString('base64'),
    2: Buffer.alloc(32, 2).toString('base64'),
  };

  it("round-trips, binds to the context, and keeps lenders' keys apart", async () => {
    const km = createLocalKeyManager('test', keys, 1);
    expect(km.descriptor.mode).toBe('mock');
    const data = new TextEncoder().encode('lender-owned artefact');
    const blob = await km.encrypt({
      keyRef: 'lender/A',
      plaintext: data,
      context: { application: 'app-1' },
    });
    expect(blob.ciphertext).not.toContain('artefact');
    expect(new TextDecoder().decode(await km.decrypt(blob, { application: 'app-1' }))).toBe(
      'lender-owned artefact',
    );
    await expect(km.decrypt(blob, { application: 'app-2' })).rejects.toThrow('decryption failed');
    await expect(
      km.decrypt({ ...blob, keyRef: 'lender/B' }, { application: 'app-1' }),
    ).rejects.toThrow('decryption failed');
    await expect(
      km.decrypt(
        { ...blob, ciphertext: Buffer.from('tampered').toString('base64') },
        { application: 'app-1' },
      ),
    ).rejects.toThrow();
  });

  it('reads old blobs after a rotation and writes new ones with the new version', async () => {
    const old = createLocalKeyManager('test', keys, 1);
    const blob = await old.encrypt({
      keyRef: 'lender/A',
      plaintext: new Uint8Array([1, 2, 3]),
      context: {},
    });
    const rotated = createLocalKeyManager('test', keys, 2);
    expect(Array.from(await rotated.decrypt(blob, {}))).toEqual([1, 2, 3]);
    expect(
      (await rotated.encrypt({ keyRef: 'lender/A', plaintext: new Uint8Array([1]), context: {} }))
        .keyVersion,
    ).toBe(2);
  });

  it('is refused in staging and production, and fails early without key material', () => {
    expect(() => createLocalKeyManager('production', keys, 1)).toThrow(ProviderNotAllowedError);
    expect(() => createLocalKeyManager('staging', keys, 1)).toThrow(
      /local development and tests only/,
    );
    expect(() => createLocalKeyManager('test', keys, 9)).toThrow(/no key material/);
    expect(() => createLocalKeyManager('test', { 1: 'c2hvcnQ=' }, 1)).toThrow(/at least 32 bytes/);
  });
});
