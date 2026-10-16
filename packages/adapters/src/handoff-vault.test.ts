import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  HandoffVaultError,
  openHandoffLink,
  parseHandoffKeyring,
  sealHandoffLink,
  type HandoffContext,
} from './handoff-vault.js';

const KEY_A = randomBytes(32).toString('base64');
const KEY_B = randomBytes(32).toString('base64');
const ring = parseHandoffKeyring(JSON.stringify({ v1: KEY_A, v2: KEY_B }), 'v2');
const ctx: HandoffContext = {
  kind: 'payment_intent',
  subjectId: '01a1422c-87dc-7809-a142-d33e43352bc2',
  lenderOrgId: 'fcb00000-0000-4000-8000-000000000001',
};
const LINK = 'https://pay.example.test/checkout/abc123?token=SAMPLE-ONLY';

function keyring() {
  if (!ring) throw new Error('keyring missing');
  return ring;
}

describe('hand-off vault', () => {
  it('seals and opens a link for the subject it was sealed for', () => {
    const sealed = sealHandoffLink(keyring(), ctx, LINK);
    expect(sealed.keyVersion).toBe('v2');
    expect(openHandoffLink(keyring(), ctx, sealed.keyVersion, sealed.ciphertext)).toBe(LINK);
  });

  it('never leaves the link readable in the stored blob', () => {
    const { ciphertext } = sealHandoffLink(keyring(), ctx, LINK);
    expect(ciphertext.toString('utf8')).not.toContain('pay.example.test');
    expect(ciphertext.toString('hex')).not.toContain(Buffer.from('SAMPLE-ONLY').toString('hex'));
    expect(ciphertext.toString('base64')).not.toContain('checkout');
  });

  it('uses a fresh nonce every time, so the same link seals differently', () => {
    const a = sealHandoffLink(keyring(), ctx, LINK).ciphertext;
    const b = sealHandoffLink(keyring(), ctx, LINK).ciphertext;
    expect(a.equals(b)).toBe(false);
    expect(a.subarray(0, 12).equals(b.subarray(0, 12))).toBe(false);
  });

  it('keeps the blob inside the size bounds the database enforces', () => {
    const { ciphertext } = sealHandoffLink(keyring(), ctx, LINK);
    expect(ciphertext.length).toBe(12 + Buffer.byteLength(LINK) + 16);
    expect(ciphertext.length).toBeGreaterThanOrEqual(29);
  });

  it('refuses to open a blob moved to another payment, kind or lender', () => {
    const sealed = sealHandoffLink(keyring(), ctx, LINK);
    const open = (c: HandoffContext) =>
      openHandoffLink(keyring(), c, sealed.keyVersion, sealed.ciphertext);
    expect(() => open({ ...ctx, subjectId: '01a1422c-87dd-7643-ae98-e740f95c8dfa' })).toThrow(
      HandoffVaultError,
    );
    expect(() => open({ ...ctx, kind: 'mandate' })).toThrow(HandoffVaultError);
    expect(() => open({ ...ctx, lenderOrgId: 'fcb00000-0000-4000-8000-000000000002' })).toThrow(
      HandoffVaultError,
    );
  });

  it('refuses a tampered blob in any byte', () => {
    const sealed = sealHandoffLink(keyring(), ctx, LINK);
    for (const index of [0, 11, 12, sealed.ciphertext.length - 1]) {
      const copy = Buffer.from(sealed.ciphertext);
      copy[index] = (copy[index] ?? 0) ^ 0x01;
      expect(() => openHandoffLink(keyring(), ctx, sealed.keyVersion, copy)).toThrow(
        HandoffVaultError,
      );
    }
    expect(() =>
      openHandoffLink(keyring(), ctx, sealed.keyVersion, sealed.ciphertext.subarray(0, 20)),
    ).toThrow(HandoffVaultError);
  });

  it('opens a link sealed under an older key version and refuses an unknown or wrong one', () => {
    const old = parseHandoffKeyring(JSON.stringify({ v1: KEY_A }), 'v1');
    if (!old) throw new Error('keyring missing');
    const sealed = sealHandoffLink(old, ctx, LINK);
    expect(openHandoffLink(keyring(), ctx, 'v1', sealed.ciphertext)).toBe(LINK);
    expect(() => openHandoffLink(keyring(), ctx, 'v9', sealed.ciphertext)).toThrow(
      HandoffVaultError,
    );
    // The right blob under the wrong key version does not open.
    expect(() => openHandoffLink(keyring(), ctx, 'v2', sealed.ciphertext)).toThrow(
      HandoffVaultError,
    );
  });

  it('seals only a plain https or upi link', () => {
    for (const bad of [
      '',
      'http://pay.example.test/x',
      'javascript:alert(1)',
      'https://pay.example.test/a b',
      'https://pay.example.test/\nx',
      'ftp://pay.example.test/x',
      `https://pay.example.test/${'a'.repeat(4100)}`,
    ]) {
      expect(() => sealHandoffLink(keyring(), ctx, bad)).toThrow(HandoffVaultError);
    }
    expect(() => sealHandoffLink(keyring(), ctx, 'upi://mandate?pa=sample@test')).not.toThrow();
  });

  it('refuses an invalid subject', () => {
    expect(() => sealHandoffLink(keyring(), { ...ctx, subjectId: 'not-a-uuid' }, LINK)).toThrow(
      HandoffVaultError,
    );
  });

  describe('configuration', () => {
    it('is absent when nothing is configured', () => {
      expect(parseHandoffKeyring(undefined, undefined)).toBeUndefined();
    });

    it('refuses half a configuration, bad JSON, a short key and an unknown active version', () => {
      const bad: [string | undefined, string | undefined][] = [
        [JSON.stringify({ v1: KEY_A }), undefined],
        [undefined, 'v1'],
        ['{not json', 'v1'],
        [JSON.stringify([KEY_A]), 'v1'],
        [JSON.stringify({ v1: randomBytes(16).toString('base64') }), 'v1'],
        [JSON.stringify({ v1: `${KEY_A}x` }), 'v1'],
        [JSON.stringify({ 'bad version!': KEY_A }), 'bad version!'],
        [JSON.stringify({ v1: KEY_A }), 'v2'],
        [JSON.stringify({ v1: 7 }), 'v1'],
      ];
      for (const [keys, active] of bad) {
        expect(() => parseHandoffKeyring(keys, active)).toThrow(HandoffVaultError);
      }
    });

    it('never echoes a key in an error message', () => {
      try {
        parseHandoffKeyring(JSON.stringify({ v1: KEY_A.slice(0, 20) }), 'v1');
        throw new Error('expected a configuration error');
      } catch (error) {
        expect(String((error as Error).message)).not.toContain(KEY_A.slice(0, 20));
        expect((error as HandoffVaultError).reason).toBe('config');
      }
    });
  });
});
