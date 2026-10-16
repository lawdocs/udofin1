import { describe, expect, it } from 'vitest';
import { ProviderNotAllowedError } from './provider.js';
import { createMockSigningProvider, createUnconfiguredSigningProvider } from './signing.js';

const request = {
  idempotencyKey: 'doc-1-agreement-0001',
  documentId: 'd1',
  documentSha256: 'a'.repeat(64),
  storageKey: 'agr/test/1',
};

describe('signing boundary', () => {
  it('labels the mock and refuses it in staging and production', () => {
    expect(createMockSigningProvider('test').descriptor).toEqual({
      key: 'mock_esign',
      capability: 'esign',
      mode: 'mock',
    });
    expect(() => createMockSigningProvider('staging')).toThrow();
    expect(() => createMockSigningProvider('production')).toThrow(ProviderNotAllowedError);
  });

  it('reports execution only with the provider reference and evidence', async () => {
    const p = createMockSigningProvider('local', () => 'complete');
    const r = await p.initiate(request);
    expect(r.state).toBe('executed');
    expect(r).toMatchObject({
      providerRef: expect.stringMatching(/^MOCK-/) as string,
      evidenceRef: expect.stringMatching(/^MOCK-EVIDENCE-/) as string,
    });
  });

  it('treats a repeat as the same request', async () => {
    const p = createMockSigningProvider('local', () => 'complete');
    await p.initiate(request);
    await p.initiate(request);
    expect(p.calls).toHaveLength(1);
  });

  it('keeps an unobserved outcome unknown and resolves it by lookup, never by starting again', async () => {
    const p = createMockSigningProvider('local', () => 'timeout');
    const first = await p.initiate(request);
    expect(first.state).toBe('unknown');
    expect(
      (await p.status({ providerRef: null, idempotencyKey: request.idempotencyKey })).state,
    ).toBe('awaiting_borrower');
    await p.initiate(request);
    expect(p.calls).toHaveLength(1);
  });

  it('can fail and can wait for the borrower', async () => {
    expect((await createMockSigningProvider('local', () => 'fail').initiate(request)).state).toBe(
      'failed',
    );
    expect(
      (await createMockSigningProvider('local', () => 'await_borrower').initiate(request)).state,
    ).toBe('awaiting_borrower');
  });

  it('answers honestly when no provider is approved', async () => {
    const p = createUnconfiguredSigningProvider();
    expect(p.descriptor.key).toBe('esign_not_configured');
    expect((await p.initiate(request)).state).toBe('failed');
    expect((await p.status({ providerRef: 'x', idempotencyKey: 'k' })).state).toBe('unknown');
  });
});
