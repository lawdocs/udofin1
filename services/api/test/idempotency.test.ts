import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/http/api-error.js';
import {
  canonicalJson,
  parseIdempotencyKey,
  requestFingerprint,
} from '../src/idempotency/idempotency.js';

describe('idempotency helpers', () => {
  it('canonical JSON ignores key order and undefined fields', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: undefined } })).toBe(
      canonicalJson({ a: { c: undefined, d: [3, { x: 2, y: 1 }] }, b: 1 }),
    );
  });

  it('distinguishes materially different payloads', () => {
    const base = { route: 'POST /v1/x', params: { id: 'a' }, body: { amount: 100 } };
    expect(requestFingerprint(base)).toBe(requestFingerprint({ ...base, body: { amount: 100 } }));
    expect(requestFingerprint(base)).not.toBe(
      requestFingerprint({ ...base, body: { amount: 101 } }),
    );
    expect(requestFingerprint(base)).not.toBe(requestFingerprint({ ...base, params: { id: 'b' } }));
    expect(requestFingerprint(base)).not.toBe(requestFingerprint({ ...base, route: 'POST /v1/y' }));
    // Array order is meaningful.
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it('accepts well-formed keys and rejects the rest with a documented error', () => {
    expect(parseIdempotencyKey('0123456789abcdef')).toBe('0123456789abcdef');
    for (const bad of [
      undefined,
      '',
      'short',
      'x'.repeat(129),
      'has space in it 123456',
      ['a'.repeat(20), 'b'.repeat(20)].join('\n'),
    ]) {
      expect(() => parseIdempotencyKey(bad)).toThrow(ApiError);
    }
    try {
      parseIdempotencyKey(undefined);
    } catch (error) {
      expect(error).toMatchObject({ status: 400, code: 'idempotency_key_required' });
    }
  });
});
