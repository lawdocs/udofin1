// Unit tests for the parts of the lender-accounts module that need no database: the account secret, the fingerprint key source,
// the request shapes and the route table. The flows over HTTP are in test/integration/lender-accounts.integration.test.ts.
import { format, inspect } from 'node:util';
import {
  createLocalKeyManager,
  loadFingerprintKey,
  ProviderNotAllowedError,
  type EncryptedBlob,
} from '@udofin/adapters';
import {
  AccountsEvidenceLabel,
  AccountsReason,
  FeatureChangeRequestInput,
  PaymentConfigDraftInput,
  PaymentConfigRailLimits,
  RegistryAccountRegisterInput,
  SettlementAccountRequestInput,
} from '@udofin/contracts';
import { describe, expect, it } from 'vitest';
import { requestFingerprint } from '../src/idempotency/idempotency.js';
import {
  AccountSecret,
  createFingerprintKeySource,
} from '../src/modules/lender-accounts/fingerprint-keys.js';
import { lenderAccountsRoutes } from '../src/modules/lender-accounts/routes.js';

const NUMBER = '918273645500';
const IFSC = 'CNRY0CAN4RY';

describe('AccountSecret', () => {
  it('shows only the bank code, the length and the last four digits to anything that serialises, prints or hashes it', () => {
    const secret = new AccountSecret(NUMBER, IFSC);
    const views = [
      JSON.stringify(secret),
      JSON.stringify({ body: { account: secret } }),
      inspect(secret, { depth: 5, showHidden: true }),
      format('%o %O %s %j', secret, secret, secret, secret),
      JSON.stringify(Object.entries(secret)),
      JSON.stringify(Object.getOwnPropertyNames(secret)),
      requestFingerprint({ route: 'POST /x', params: undefined, body: { account: secret } }),
    ].join('\n');
    expect(views).not.toContain(NUMBER);
    expect(views).not.toContain(IFSC);
    expect(JSON.parse(JSON.stringify(secret))).toEqual({
      bankCode: 'CNRY',
      digits: 12,
      lastFour: '5500',
    });
  });

  it('hands the values over until it is wiped, and never afterwards', () => {
    const secret = new AccountSecret(NUMBER, IFSC);
    expect(secret.reveal()).toEqual({ accountNumber: NUMBER, ifsc: IFSC });
    secret.wipe();
    expect(() => secret.reveal()).toThrow('already dropped');
    expect(JSON.stringify(secret)).not.toContain(NUMBER);
  });

  it('gives two different numbers the same request hash only when bank code, length and last four digits agree', () => {
    const hash = (n: string, ifsc: string) =>
      requestFingerprint({
        route: 'r',
        params: undefined,
        body: { account: new AccountSecret(n, ifsc) },
      });
    expect(hash(NUMBER, IFSC)).toBe(hash(NUMBER, IFSC));
    expect(hash(NUMBER, IFSC)).not.toBe(hash('918273645501', IFSC));
    expect(hash(NUMBER, IFSC)).not.toBe(hash('91827364550', IFSC));
    expect(hash(NUMBER, IFSC)).not.toBe(hash(NUMBER, 'HDFC0CAN4RY'));
  });
});

describe('createFingerprintKeySource', () => {
  const masters = { 1: Buffer.alloc(32, 3).toString('base64') };
  const manager = createLocalKeyManager('test', masters, 1);
  const wrap = (version: number, bytes: Uint8Array): Promise<EncryptedBlob> =>
    manager.encrypt({
      keyRef: 'platform/account-fingerprint',
      plaintext: bytes,
      context: { purpose: 'account-fingerprint', fingerprint_key_version: String(version) },
    });

  it('unwraps the key of a version through the key manager and knows nothing about other versions', async () => {
    const raw = new Uint8Array(32).fill(9);
    const source = createFingerprintKeySource({
      environment: 'test',
      keyManager: manager,
      wrapped: { 1: await wrap(1, raw) },
    });
    const key = await source.keyFor(1);
    expect(key).toMatchObject({ keyId: 'platform/account-fingerprint', keyVersion: 1 });
    expect(Buffer.from(key?.key ?? []).equals(Buffer.from(raw))).toBe(true);
    expect(await source.keyFor(2)).toBeUndefined();
  });

  it('fails closed when a blob cannot be unwrapped for the version it is filed under', async () => {
    const source = createFingerprintKeySource({
      environment: 'test',
      keyManager: manager,
      wrapped: { 2: await wrap(1, new Uint8Array(32).fill(9)) },
    });
    expect(await source.keyFor(2)).toBeUndefined();
    const direct = await wrap(1, new Uint8Array(32).fill(9));
    await expect(loadFingerprintKey(manager, direct, 2)).rejects.toThrow(/invalid_key/);
  });

  it('refuses a labelled mock key manager in production, and the local manager cannot even be built in staging or production', async () => {
    const blob = await wrap(1, new Uint8Array(32).fill(9));
    expect(() =>
      createFingerprintKeySource({
        environment: 'production',
        keyManager: manager,
        wrapped: { 1: blob },
      }),
    ).toThrow(ProviderNotAllowedError);
    for (const environment of ['staging', 'production'] as const) {
      expect(() => createLocalKeyManager(environment, masters, 1)).toThrow();
    }
  });
});

describe('request shapes', () => {
  const registration = {
    accountNumber: NUMBER,
    ifsc: IFSC,
    country: 'IN',
    accountType: 'bank_account',
    ownerKind: 'lender',
    legalOwnerName: 'Alpha Finance Private Limited',
    permittedPurposes: ['repayment_settlement'],
  };

  it('accepts a registration and refuses anything that is not digits, an IFSC, a closed list value or a known field', () => {
    expect(RegistryAccountRegisterInput.safeParse(registration).success).toBe(true);
    const bad: Record<string, unknown>[] = [
      { accountNumber: '' },
      { accountNumber: '1234 5678 9012' },
      { accountNumber: '12345678901X' },
      { accountNumber: '1'.repeat(35) },
      { ifsc: 'CNRY1CAN4RY' },
      { ifsc: 'CNRY0CAN4R' },
      { ownerKind: 'individual' },
      { permittedPurposes: [] },
      { permittedPurposes: ['marketing'] },
      { legalOwnerName: 'AB' },
      { legalOwnerName: 'ABCDE1234F proprietor' },
      { fingerprint: 'a'.repeat(64) },
      { effectiveFrom: '16-10-2026' },
    ];
    for (const change of bad) {
      expect(
        RegistryAccountRegisterInput.safeParse({ ...registration, ...change }).success,
        JSON.stringify(Object.keys(change)),
      ).toBe(false);
    }
  });

  it('keeps free text from becoming a second copy of a personal number', () => {
    expect(
      AccountsReason.safeParse('The bank letter reference INV-2026-0042 was checked').success,
    ).toBe(true);
    for (const text of [
      'short',
      'the account is 912345678901 at that bank',
      'phone 98765 43210 of the contact',
      'phone 98765-43210 of the contact',
      'PAN ABCDE1234F belongs to the proprietor',
      'x'.repeat(1001),
    ]) {
      expect(AccountsReason.safeParse(text).success, text.slice(0, 30)).toBe(false);
    }
  });

  it('takes a settlement account request with the registry form of the masked reference only (A15)', () => {
    const request = {
      lenderId: '0198f3a0-0000-7000-8000-000000000001',
      label: 'Collections account',
      bankName: 'Sample Bank',
      maskedRef: 'XXXXXX1234',
    };
    expect(SettlementAccountRequestInput.safeParse(request).success).toBe(true);
    for (const maskedRef of [
      'XXXX1234',
      '******1234',
      'XXXXXX34',
      'XXXXXX123',
      'XXXXXX12345',
      'XXXXXXX1234',
      'xxxxxx1234',
      'XXXXXX123A',
      ' XXXXXX1234',
      'XXXXXX1234\n',
    ])
      expect(
        SettlementAccountRequestInput.safeParse({ ...request, maskedRef }).success,
        maskedRef,
      ).toBe(false);
  });

  it('keeps a full account number out of the settlement account label and bank name, however it is spaced (A16)', () => {
    const request = {
      lenderId: '0198f3a0-0000-7000-8000-000000000001',
      label: 'Collections account',
      bankName: 'Sample Bank',
      maskedRef: 'XXXXXX1234',
    };
    for (const text of [
      'SBI 5010 0123 4567 89',
      'Account 5010-0123-4567-89',
      'Collections 1234 5678 9012 3456',
      '  5010 0123 4567  ',
      'Holder ABCDE1234F',
    ]) {
      expect(
        SettlementAccountRequestInput.safeParse({ ...request, label: text }).success,
        text,
      ).toBe(false);
      expect(
        SettlementAccountRequestInput.safeParse({ ...request, bankName: text }).success,
        text,
      ).toBe(false);
    }
    // Short digit groups are not an account number.
    for (const text of [
      'Collections 2026-27 account 01',
      'Branch 0042 collections',
      'Sample Bank 2',
    ]) {
      expect(
        SettlementAccountRequestInput.safeParse({ ...request, label: text }).success,
        text,
      ).toBe(true);
    }
  });

  it('keeps an evidence label a label: letters, short numbers and separators, never a long number', () => {
    for (const label of [
      'SAMPLE-BANK-LETTER-2026-1',
      'LSP agreement 7.1 (signed)',
      'PA/2026/0042',
    ]) {
      expect(AccountsEvidenceLabel.safeParse(label).success, label).toBe(true);
    }
    for (const label of [
      '',
      'ab',
      '-leading',
      'BANK-LETTER-912345678901',
      'letter ABCDE1234F',
      'a'.repeat(201),
    ]) {
      expect(AccountsEvidenceLabel.safeParse(label).success, label).toBe(false);
    }
  });

  it('takes secrets only as names and rail limits only as flat limits of strings, flags and integers', () => {
    const draft = {
      lenderId: '0198b3f4-0000-7000-8000-000000000001',
      provider: 'testpay',
      providerMode: 'production',
      merchantRegistryId: '0198b3f4-0000-7000-8000-000000000002',
      settlementAccountId: '0198b3f4-0000-7000-8000-000000000003',
      secretRef: 'TESTPAY_API_SECRET',
      webhookSecretRef: 'TESTPAY_WEBHOOK_SECRET',
    };
    expect(PaymentConfigDraftInput.safeParse(draft).success).toBe(true);
    for (const change of [
      { secretRef: 'not_a_secret_name_but_a_value_1' },
      { secretRef: 'AB' },
      { webhookSecretRef: 'whsec abc' },
      { providerMode: 'staging' },
      { endpointToken: 'x'.repeat(43) },
      { endpointTokenHash: 'a'.repeat(64) },
      { webhookSecret: 'whsec_abc' },
    ]) {
      expect(
        PaymentConfigDraftInput.safeParse({ ...draft, ...change }).success,
        JSON.stringify(Object.keys(change)),
      ).toBe(false);
    }
    expect(
      PaymentConfigRailLimits.safeParse({
        upi: { max_amount_minor: 10_000_000, afa: true, note: 'per day' },
      }).success,
    ).toBe(true);
    for (const rails of [
      { upi: { max_amount_minor: 1.5 } },
      { upi: { max_amount_minor: -1 } },
      { upi: { max_amount_minor: 100_000_000_000_001 } },
      { upi: { nested: { a: 1 } } },
      { UPI: { a: 1 } },
      { upi: 3 },
    ]) {
      expect(PaymentConfigRailLimits.safeParse(rails).success, JSON.stringify(rails)).toBe(false);
    }
  });

  it('limits feature evidence to flat reference labels', () => {
    const base = {
      lenderId: '0198b3f4-0000-7000-8000-000000000001',
      feature: 'payments',
      enable: true,
    };
    expect(
      FeatureChangeRequestInput.safeParse({ ...base, evidence: { contract_ref: 'SAMPLE-1' } })
        .success,
    ).toBe(true);
    expect(
      FeatureChangeRequestInput.safeParse({ ...base, evidence: { 'Bad Key': 'x' } }).success,
    ).toBe(false);
    expect(
      FeatureChangeRequestInput.safeParse({ ...base, evidence: { a_key: { nested: true } } })
        .success,
    ).toBe(false);
    expect(FeatureChangeRequestInput.safeParse({ ...base, feature: 'Payments' }).success).toBe(
      false,
    );
  });
});

describe('the route table of the module', () => {
  const routes = lenderAccountsRoutes();

  it('declares only staff routes under the platform and lender prefixes, each with a rate limit and unique ids', () => {
    expect(routes.length).toBeGreaterThan(40);
    for (const route of routes) {
      expect(route.auth, route.operationId).toBe('staff');
      expect(route.path, route.operationId).toMatch(/^\/v1\/(platform|lender)\//);
      expect(route.rateLimit, route.operationId).toBeTruthy();
    }
    const ids = routes.map((r) => r.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    const keys = routes.map((r) => `${r.method} ${r.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('makes every write idempotent and no read idempotent', () => {
    for (const route of routes) {
      if (route.auth === 'none') continue;
      expect(route.idempotent === true, route.operationId).toBe(route.method === 'post');
    }
  });

  it('exposes the registration only with a sealed body that never reaches an OpenAPI example or a response', () => {
    const register = routes.find((r) => r.operationId === 'registerAccount');
    expect(
      register?.responses[201]?.safeParse({
        id: 'x',
        maskedRef: 'XXXXXX5500',
        status: 'unverified',
      }).success,
    ).toBe(false);
    expect(
      register?.responses[201]?.safeParse({
        id: '0198b3f4-0000-7000-8000-000000000001',
        maskedRef: 'XXXXXX5500',
        status: 'unverified',
      }).success,
    ).toBe(true);
    const parsed = register?.body?.safeParse({
      accountNumber: NUMBER,
      ifsc: IFSC,
      country: 'IN',
      accountType: 'bank_account',
      ownerKind: 'udofin',
      legalOwnerName: 'Udofin Technologies Private Limited',
      permittedPurposes: ['fee_collection'],
    });
    expect(parsed?.success).toBe(true);
    expect(JSON.stringify(parsed?.success ? parsed.data : null)).not.toContain(NUMBER);
  });
});
