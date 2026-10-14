import { describe, expect, it } from 'vitest';
import {
  AccountFingerprintError,
  createLocalKeyManager,
  fingerprintAccount,
  fingerprintsEqual,
  INITIAL_IN_BANK_ACCOUNT_RULE,
  loadFingerprintKey,
  normaliseAccount,
  type AccountFormatRule,
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
const rule = INITIAL_IN_BANK_ACCOUNT_RULE;

describe('fingerprintAccount', () => {
  it('is deterministic: 64 hex characters, the key version, and a masked reference with the last four digits only', () => {
    const a = fingerprintAccount(key1, input, rule);
    expect(a).toEqual(fingerprintAccount(key1, input, rule));
    expect(a.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(a.keyVersion).toBe(1);
    expect(a.maskedRef).toBe('XXXXXX2222');
    expect(a.maskedRef).toMatch(/^[X*]{2,}[0-9]{2,4}$/);
  });

  it('separates key versions: different key material gives a different fingerprint and reports its version', () => {
    const a = fingerprintAccount(key1, input, rule);
    const b = fingerprintAccount(key2, input, rule);
    expect(b.fingerprint).not.toBe(a.fingerprint);
    expect(b.keyVersion).toBe(2);
  });

  it('gives different accounts different fingerprints, including a different leading zero and a different IFSC', () => {
    const base = fingerprintAccount(key1, input, rule).fingerprint;
    expect(
      fingerprintAccount(key1, { ...input, accountNumber: '000011112223' }, rule).fingerprint,
    ).not.toBe(base);
    expect(
      fingerprintAccount(key1, { ...input, accountNumber: '00011112222' }, rule).fingerprint,
    ).not.toBe(base);
    expect(fingerprintAccount(key1, { ...input, ifsc: 'OTHR0000001' }, rule).fingerprint).not.toBe(
      base,
    );
  });

  it('treats the same account at another branch of the same bank as the same account, but not at another bank', () => {
    const base = fingerprintAccount(key1, input, rule);
    const otherBranch = fingerprintAccount(key1, { ...input, ifsc: 'SAMP0000002' }, rule);
    expect(otherBranch.fingerprint).toBe(base.fingerprint);
    expect(fingerprintsEqual(base.fingerprint, otherBranch.fingerprint)).toBe(true);
    expect(otherBranch.maskedRef).toBe(base.maskedRef);
    expect(fingerprintAccount(key1, { ...input, ifsc: 'SAMQ0000001' }, rule).fingerprint).not.toBe(
      base.fingerprint,
    );
  });

  it('matches a known answer computed outside this code (HMAC-SHA256 over length-prefixed domain, bank code, number)', () => {
    // python: hmac.new(bytes([1])*32, lp('udofin-account-fingerprint-v2', 'SAMP', '000011112222'), sha256)
    expect(fingerprintAccount(key1, input, rule).fingerprint).toBe(
      '4ba9b4df6fdc0392c6d74091bc8ef7622943aa96c113eb4628b1463e4699988b',
    );
  });

  it('is equivalent across harmless formatting: trimming and IFSC case', () => {
    const base = fingerprintAccount(key1, input, rule).fingerprint;
    expect(
      fingerprintAccount(
        key1,
        {
          ifsc: ` ${SAMPLE_IFSC.toLowerCase()} `,
          accountNumber: `  ${SAMPLE_ACCOUNT}\n`,
        },
        rule,
      ).fingerprint,
    ).toBe(base);
    expect(
      normaliseAccount({ ifsc: ' samp0000001', accountNumber: ` ${SAMPLE_ACCOUNT} ` }, rule),
    ).toEqual(input);
  });

  it('never returns or contains the account number or the IFSC', () => {
    const text = JSON.stringify(fingerprintAccount(key1, input, rule));
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
        fingerprintAccount(key1, { ifsc: SAMPLE_IFSC, accountNumber }, rule);
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
        fingerprintAccount(key1, { ifsc, accountNumber: SAMPLE_ACCOUNT }, rule);
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
      fingerprintAccount(
        key1,
        { ifsc: 5 as unknown as string, accountNumber: SAMPLE_ACCOUNT },
        rule,
      ),
    ).toThrow(AccountFingerprintError);
    expect(() =>
      fingerprintAccount(
        key1,
        { ifsc: SAMPLE_IFSC, accountNumber: null as unknown as string },
        rule,
      ),
    ).toThrow(AccountFingerprintError);
    for (const bad of [
      { ...key1, key: new Uint8Array(16) },
      { ...key1, key: 'not bytes' as unknown as Uint8Array },
      { ...key1, keyVersion: 0 },
      { ...key1, keyId: '' },
    ]) {
      expect(() => fingerprintAccount(bad, input, rule)).toThrow(/invalid_key/);
    }
    try {
      fingerprintAccount({ ...key1, key: new Uint8Array(16).fill(7) }, input, rule);
    } catch (error) {
      expect((error as Error).message).not.toContain(SAMPLE_ACCOUNT);
    }
  });
});

describe('the account-number format is data, not code', () => {
  const narrow: AccountFormatRule = { ...rule, minDigits: 12, maxDigits: 12 };

  it('applies the range of the rule it is given, so a changed range needs no code change', () => {
    expect(() =>
      fingerprintAccount(key1, { ...input, accountNumber: '00001111222' }, narrow),
    ).toThrow(/invalid_account_number/);
    expect(fingerprintAccount(key1, input, narrow).fingerprint).toBe(
      fingerprintAccount(key1, input, rule).fingerprint,
    );
    const wide: AccountFormatRule = { ...rule, minDigits: 8, maxDigits: 20 };
    expect(fingerprintAccount(key1, { ...input, accountNumber: '12345678' }, wide).maskedRef).toBe(
      'XXXXXX5678',
    );
  });

  it('reports the status of the rule next to the fingerprint: the initial range is unverified', () => {
    expect(INITIAL_IN_BANK_ACCOUNT_RULE).toMatchObject({ status: 'unverified', source: null });
    expect(fingerprintAccount(key1, input, rule).ruleStatus).toBe('unverified');
    const verified: AccountFormatRule = { ...rule, status: 'verified', source: 'SAMPLE-SOURCE-1' };
    expect(fingerprintAccount(key1, input, verified).ruleStatus).toBe('verified');
  });

  it('fails closed without a usable rule: nothing is fingerprinted', () => {
    const bad: unknown[] = [
      undefined,
      null,
      { ...rule, minDigits: 0 },
      { ...rule, minDigits: 19, maxDigits: 9 },
      { ...rule, maxDigits: 100 },
      { ...rule, minDigits: 9.5 },
      { ...rule, country: 'US' },
      { ...rule, accountType: '' },
      { ...rule, status: 'trusted' },
      { ...rule, status: 'verified', source: null },
    ];
    for (const candidate of bad) {
      expect(() => fingerprintAccount(key1, input, candidate as AccountFormatRule)).toThrow(
        /invalid_rule/,
      );
    }
  });
});

describe('fingerprintsEqual', () => {
  it('compares in constant time and treats anything that is not a 64-hex fingerprint as unequal', () => {
    const a = fingerprintAccount(key1, input, rule).fingerprint;
    const b = fingerprintAccount(key2, input, rule).fingerprint;
    expect(fingerprintsEqual(a, a)).toBe(true);
    expect(fingerprintsEqual(a, b)).toBe(false);
    expect(fingerprintsEqual(a, a.toUpperCase())).toBe(false);
    expect(fingerprintsEqual(a, a.slice(0, 62))).toBe(false);
    expect(fingerprintsEqual('', '')).toBe(false);
    expect(fingerprintsEqual('zz'.repeat(32), 'zz'.repeat(32))).toBe(false);
  });
});

describe('loadFingerprintKey (key comes from the key-management port)', () => {
  const masters = {
    1: Buffer.alloc(32, 9).toString('base64'),
    2: Buffer.alloc(32, 8).toString('base64'),
  };
  const wrapWith = async (
    km: ReturnType<typeof createLocalKeyManager>,
    raw: Uint8Array,
    fingerprintKeyVersion: number,
  ) =>
    km.encrypt({
      keyRef: 'platform/account-fingerprint',
      plaintext: raw,
      context: {
        purpose: 'account-fingerprint',
        fingerprint_key_version: String(fingerprintKeyVersion),
      },
    });

  it('unwraps a key held by the key manager and uses its key reference and the version it is given', async () => {
    const km = createLocalKeyManager('test', masters, 1);
    const raw = new Uint8Array(32).fill(5);
    const wrapped = await wrapWith(km, raw, 1);
    const loaded = await loadFingerprintKey(km, wrapped, 1);
    expect(loaded).toMatchObject({ keyId: 'platform/account-fingerprint', keyVersion: 1 });
    expect(fingerprintAccount(loaded, input, rule).fingerprint).toBe(
      fingerprintAccount({ keyId: 'x', keyVersion: 1, key: raw }, input, rule).fingerprint,
    );
    expect(JSON.stringify(wrapped)).not.toContain(Buffer.from(raw).toString('base64'));
  });

  it('keeps the fingerprint key version when only the master key rotates (same key, same fingerprint, same version)', async () => {
    const raw = new Uint8Array(32).fill(5);
    const underMaster1 = await wrapWith(createLocalKeyManager('test', masters, 1), raw, 1);
    const kmV2 = createLocalKeyManager('test', masters, 2);
    const underMaster2 = await wrapWith(kmV2, raw, 1);
    expect(underMaster1.keyVersion).toBe(1);
    expect(underMaster2.keyVersion).toBe(2);
    const a = await loadFingerprintKey(createLocalKeyManager('test', masters, 1), underMaster1, 1);
    const b = await loadFingerprintKey(kmV2, underMaster2, 1);
    expect(b.keyVersion).toBe(1);
    const fa = fingerprintAccount(a, input, rule);
    const fb = fingerprintAccount(b, input, rule);
    expect(fb.fingerprint).toBe(fa.fingerprint);
    expect(fb.keyVersion).toBe(fa.keyVersion);
  });

  it('gives a new fingerprint key its own version even under the same master key', async () => {
    const km = createLocalKeyManager('test', masters, 1);
    const v1 = await loadFingerprintKey(km, await wrapWith(km, new Uint8Array(32).fill(5), 1), 1);
    const v2 = await loadFingerprintKey(km, await wrapWith(km, new Uint8Array(32).fill(6), 2), 2);
    const f1 = fingerprintAccount(v1, input, rule);
    const f2 = fingerprintAccount(v2, input, rule);
    expect(f2.fingerprint).not.toBe(f1.fingerprint);
    expect(f2.keyVersion).toBe(2);
    expect(f1.keyVersion).toBe(1);
  });

  it('refuses a blob loaded under a version it was not wrapped for, a wrong context, a tampered blob, a short key and a bad version', async () => {
    const km = createLocalKeyManager('test', masters, 1);
    const wrapped = await wrapWith(km, new Uint8Array(32).fill(5), 1);
    await expect(loadFingerprintKey(km, wrapped, 2)).rejects.toThrow(/invalid_key/);
    await expect(loadFingerprintKey(km, wrapped, 1, { purpose: 'something-else' })).rejects.toThrow(
      /invalid_key/,
    );
    await expect(
      loadFingerprintKey(
        km,
        { ...wrapped, ciphertext: Buffer.from('tampered').toString('base64') },
        1,
      ),
    ).rejects.toThrow(/invalid_key/);
    const short = await wrapWith(km, new Uint8Array(8), 1);
    await expect(loadFingerprintKey(km, short, 1)).rejects.toThrow(/invalid_key/);
    for (const version of [0, -1, 1.5, Number.NaN]) {
      await expect(loadFingerprintKey(km, wrapped, version)).rejects.toThrow(/invalid_key/);
    }
  });
});
