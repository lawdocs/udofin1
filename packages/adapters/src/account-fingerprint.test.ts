import { describe, expect, it } from 'vitest';
import {
  AccountFingerprintError,
  createLocalKeyManager,
  fingerprintAccount,
  fingerprintsEqual,
  loadFingerprintKey,
  normaliseAccount,
  type FingerprintKey,
} from './index.js';

// Obviously synthetic values: SAMP is not a bank, and the number is a counting sequence.
const SAMPLE_IFSC = 'SAMP0000001';
const SAMPLE_ACCOUNT = '000011112222';
const key1: FingerprintKey = {
  keyId: 'platform/account-fingerprint',
  keyVersion: 1,
  key: new Uint8Array(32).fill(1),
};
const key2: FingerprintKey = {
  keyId: 'platform/account-fingerprint',
  keyVersion: 2,
  key: new Uint8Array(32).fill(2),
};
const input = { ifsc: SAMPLE_IFSC, accountNumber: SAMPLE_ACCOUNT };

describe('fingerprintAccount', () => {
  it('is deterministic: 64 hex characters, the key version, and a masked reference with the last four digits only', () => {
    const a = fingerprintAccount(key1, input);
    expect(a).toEqual(fingerprintAccount(key1, input));
    expect(a.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(a.keyVersion).toBe(1);
    expect(a.maskedRef).toBe('XXXXXX2222');
    expect(a.maskedRef).toMatch(/^[X*]{2,}[0-9]{2,4}$/);
  });

  it('separates key versions: different key material gives a different fingerprint and reports its version', () => {
    const a = fingerprintAccount(key1, input);
    const b = fingerprintAccount(key2, input);
    expect(b.fingerprint).not.toBe(a.fingerprint);
    expect(b.keyVersion).toBe(2);
  });

  it('gives different accounts different fingerprints, including a different leading zero and a different IFSC', () => {
    const base = fingerprintAccount(key1, input).fingerprint;
    expect(
      fingerprintAccount(key1, { ...input, accountNumber: '000011112223' }).fingerprint,
    ).not.toBe(base);
    expect(
      fingerprintAccount(key1, { ...input, accountNumber: '00011112222' }).fingerprint,
    ).not.toBe(base);
    expect(fingerprintAccount(key1, { ...input, ifsc: 'SAMP0000002' }).fingerprint).not.toBe(base);
  });

  it('is equivalent across harmless formatting: trimming and IFSC case', () => {
    const base = fingerprintAccount(key1, input).fingerprint;
    expect(
      fingerprintAccount(key1, {
        ifsc: ` ${SAMPLE_IFSC.toLowerCase()} `,
        accountNumber: `  ${SAMPLE_ACCOUNT}\n`,
      }).fingerprint,
    ).toBe(base);
    expect(
      normaliseAccount({ ifsc: ' samp0000001', accountNumber: ` ${SAMPLE_ACCOUNT} ` }),
    ).toEqual(input);
  });

  it('never returns or contains the account number or the IFSC', () => {
    const text = JSON.stringify(fingerprintAccount(key1, input));
    expect(text).not.toContain(SAMPLE_ACCOUNT);
    expect(text).not.toContain(SAMPLE_IFSC);
    expect(text).not.toContain('0000111');
  });

  const BAD_ACCOUNTS = [
    '',
    '12345678',
    '1234567890123456789',
    '1234 5678 9012',
    '12345678901a',
    '1234-5678-9012',
    '١٢٣٤٥٦٧٨٩',
    '1234567890.5',
    '-12345678901',
  ];
  const BAD_IFSC = [
    '',
    'SAMP1000001',
    'SAMP000001',
    'SAMP00000012',
    'SA1P0000001',
    'SAMP0 00001',
    'SAMP0000001\n\u0000',
  ];

  it.each(BAD_ACCOUNTS)(
    'rejects the malformed account number %j with a reason class and no input in the error',
    (accountNumber) => {
      let caught: unknown;
      try {
        fingerprintAccount(key1, { ifsc: SAMPLE_IFSC, accountNumber });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(AccountFingerprintError);
      expect((caught as AccountFingerprintError).reason).toBe('invalid_account_number');
      const rendered = `${String(caught)} ${(caught as Error).message} ${JSON.stringify(caught)} ${(caught as Error).stack ?? ''}`;
      if (accountNumber.length > 3) expect(rendered).not.toContain(accountNumber);
      expect(rendered).not.toContain(SAMPLE_IFSC);
    },
  );

  it.each(BAD_IFSC)(
    'rejects the malformed IFSC %j with a reason class and no input in the error',
    (ifsc) => {
      let caught: unknown;
      try {
        fingerprintAccount(key1, { ifsc, accountNumber: SAMPLE_ACCOUNT });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(AccountFingerprintError);
      expect((caught as AccountFingerprintError).reason).toBe('invalid_ifsc');
      const rendered = `${String(caught)} ${JSON.stringify(caught)} ${(caught as Error).stack ?? ''}`;
      expect(rendered).not.toContain(SAMPLE_ACCOUNT);
      if (ifsc.length > 3) expect(rendered).not.toContain(ifsc);
    },
  );

  it('rejects non-string input and unusable keys without echoing anything', () => {
    expect(() =>
      fingerprintAccount(key1, { ifsc: 5 as unknown as string, accountNumber: SAMPLE_ACCOUNT }),
    ).toThrow(AccountFingerprintError);
    expect(() =>
      fingerprintAccount(key1, { ifsc: SAMPLE_IFSC, accountNumber: null as unknown as string }),
    ).toThrow(AccountFingerprintError);
    for (const bad of [
      { ...key1, key: new Uint8Array(16) },
      { ...key1, key: 'not bytes' as unknown as Uint8Array },
      { ...key1, keyVersion: 0 },
      { ...key1, keyId: '' },
    ]) {
      expect(() => fingerprintAccount(bad, input)).toThrow(/invalid_key/);
    }
    try {
      fingerprintAccount({ ...key1, key: new Uint8Array(16).fill(7) }, input);
    } catch (error) {
      expect((error as Error).message).not.toContain(SAMPLE_ACCOUNT);
    }
  });
});

describe('fingerprintsEqual', () => {
  it('compares in constant time and treats anything that is not a 64-hex fingerprint as unequal', () => {
    const a = fingerprintAccount(key1, input).fingerprint;
    const b = fingerprintAccount(key2, input).fingerprint;
    expect(fingerprintsEqual(a, a)).toBe(true);
    expect(fingerprintsEqual(a, b)).toBe(false);
    expect(fingerprintsEqual(a, a.toUpperCase())).toBe(false);
    expect(fingerprintsEqual(a, a.slice(0, 62))).toBe(false);
    expect(fingerprintsEqual('', '')).toBe(false);
    expect(fingerprintsEqual('zz'.repeat(32), 'zz'.repeat(32))).toBe(false);
  });
});

describe('loadFingerprintKey (key comes from the key-management port)', () => {
  const masters = { 1: Buffer.alloc(32, 9).toString('base64') };

  it('unwraps a key held by the key manager and uses its key reference and version', async () => {
    const km = createLocalKeyManager('test', masters, 1);
    const raw = new Uint8Array(32).fill(5);
    const wrapped = await km.encrypt({
      keyRef: 'platform/account-fingerprint',
      plaintext: raw,
      context: { purpose: 'account-fingerprint' },
    });
    const loaded = await loadFingerprintKey(km, wrapped);
    expect(loaded).toMatchObject({ keyId: 'platform/account-fingerprint', keyVersion: 1 });
    expect(fingerprintAccount(loaded, input).fingerprint).toBe(
      fingerprintAccount({ keyId: 'x', keyVersion: 1, key: raw }, input).fingerprint,
    );
    expect(JSON.stringify(wrapped)).not.toContain(Buffer.from(raw).toString('base64'));
  });

  it('refuses a wrong context, a tampered blob and a key that is too short', async () => {
    const km = createLocalKeyManager('test', masters, 1);
    const wrapped = await km.encrypt({
      keyRef: 'platform/account-fingerprint',
      plaintext: new Uint8Array(32).fill(5),
      context: { purpose: 'account-fingerprint' },
    });
    await expect(loadFingerprintKey(km, wrapped, { purpose: 'something-else' })).rejects.toThrow(
      /invalid_key/,
    );
    await expect(
      loadFingerprintKey(km, {
        ...wrapped,
        ciphertext: Buffer.from('tampered').toString('base64'),
      }),
    ).rejects.toThrow(/invalid_key/);
    const short = await km.encrypt({
      keyRef: 'platform/account-fingerprint',
      plaintext: new Uint8Array(8),
      context: { purpose: 'account-fingerprint' },
    });
    await expect(loadFingerprintKey(km, short)).rejects.toThrow(/invalid_key/);
  });
});
