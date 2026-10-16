import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertValidDocumentKey,
  createLocalDocumentStore,
  createObjectStorageDocumentStore,
  sha256Hex,
  type ObjectStorageClient,
} from './documents.js';
import { ProviderNotAllowedError } from './provider.js';

const bytes = new TextEncoder().encode('%PDF-1.4 synthetic');
const meta = { mimeType: 'application/pdf', sha256: sha256Hex(bytes) };
let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('document keys', () => {
  it.each([
    '../etc/passwd',
    '/abs/path00',
    'a b c d e f g h',
    'short',
    'x//yyyyyyy',
    'a/../bbbbbbbb',
  ])('rejects %s', (key) => {
    expect(() => assertValidDocumentKey(key)).toThrow('invalid document key');
  });
  it('accepts an opaque generated key', () => {
    expect(() => assertValidDocumentKey('lenders/0f1e2d3c/abcdef0123456789')).not.toThrow();
  });
});

describe('local document store (development only)', () => {
  it('refuses to exist in staging and production', () => {
    expect(() => createLocalDocumentStore('/tmp/x', 'staging')).toThrow(ProviderNotAllowedError);
    expect(() => createLocalDocumentStore('/tmp/x', 'production')).toThrow(ProviderNotAllowedError);
  });

  it('stores, returns and deletes a document, and verifies the checksum', async () => {
    dir = await mkdtemp(join(tmpdir(), 'udofin-docs-'));
    const store = createLocalDocumentStore(dir, 'test');
    await store.put('lenders/aaaa/doc-00000001', bytes, meta);
    const got = await store.get('lenders/aaaa/doc-00000001');
    expect(got?.mimeType).toBe('application/pdf');
    expect(Buffer.from(got?.bytes ?? []).toString()).toBe('%PDF-1.4 synthetic');
    await expect(
      store.put('lenders/aaaa/doc-00000002', bytes, { ...meta, sha256: '0'.repeat(64) }),
    ).rejects.toThrow('checksum');
    await store.delete('lenders/aaaa/doc-00000001');
    expect(await store.get('lenders/aaaa/doc-00000001')).toBeUndefined();
  });

  it('never overwrites an existing document', async () => {
    dir = await mkdtemp(join(tmpdir(), 'udofin-docs-'));
    const store = createLocalDocumentStore(dir, 'test');
    await store.put('lenders/aaaa/doc-00000003', bytes, meta);
    await expect(store.put('lenders/aaaa/doc-00000003', bytes, meta)).rejects.toThrow();
  });
});

describe('object storage document store', () => {
  const calls: unknown[] = [];
  const client: ObjectStorageClient = {
    putObject: (input) => {
      calls.push(input);
      return Promise.resolve();
    },
    getObject: () => Promise.resolve({ body: bytes, contentType: 'application/pdf' }),
    deleteObject: () => Promise.resolve(),
  };

  it('always encrypts with the configured KMS key', async () => {
    const store = createObjectStorageDocumentStore(client, { bucket: 'b', kmsKeyId: 'key-1' });
    await store.put('lenders/aaaa/doc-00000004', bytes, meta);
    expect(calls[0]).toMatchObject({ bucket: 'b', kmsKeyId: 'key-1', sha256Hex: meta.sha256 });
  });

  it('refuses to be built without a bucket and a KMS key', () => {
    expect(() => createObjectStorageDocumentStore(client, { bucket: '', kmsKeyId: 'k' })).toThrow();
    expect(() => createObjectStorageDocumentStore(client, { bucket: 'b', kmsKeyId: '' })).toThrow();
  });
});
