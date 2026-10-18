// Unit tests for the parts of the lender-accounts module that need no database: the account secret, the fingerprint key source,
// the request shapes and the route table. The flows over HTTP are in test/integration/lender-accounts.integration.test.ts.
import { format, inspect } from 'node:util';
import {
  createLocalKeyManager,
  loadFingerprintKey,
  ProviderNotAllowedError,
  type EncryptedBlob,
  type KeyManager,
} from '@udofin/adapters';
import {
  AccountsEvidenceLabel,
  AccountsReason,
  FeatureChangeRequestInput,
  LenderRecordActionInput,
  OwnAccountListAttestInput,
  OwnAccountListState,
  PaymentConfigDraftInput,
  PaymentConfigEntry,
  PaymentConfigRailLimits,
  RegistryAccountRegisterInput,
  SecretRefPrefix,
  SecretRefPrefixQuery,
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
/** A lender namespace as the database derives it: L, twelve capital hexadecimal digits, an underscore. */
const NAMESPACE = 'L0198B3F40001_';

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

  it('does not remember a failed load: a key manager that fails once and then recovers works on the next call, with the key cached after that (A18)', async () => {
    const raw = new Uint8Array(32).fill(9);
    const blob = await wrap(1, raw);
    let calls = 0;
    let failuresLeft = 1;
    const flaky: KeyManager = {
      descriptor: manager.descriptor,
      encrypt: (request) => manager.encrypt(request),
      decrypt: (wrapped, context) => {
        calls += 1;
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          return Promise.reject(new Error('the key manager timed out'));
        }
        return manager.decrypt(wrapped, context);
      },
    };
    const source = createFingerprintKeySource({
      environment: 'test',
      keyManager: flaky,
      wrapped: { 1: blob },
    });
    expect(await source.keyFor(1)).toBeUndefined();
    const recovered = await source.keyFor(1);
    expect(Buffer.from(recovered?.key ?? []).equals(Buffer.from(raw))).toBe(true);
    expect(calls).toBe(2);
    // The success is kept: no third call to the key manager.
    expect((await source.keyFor(1))?.keyVersion).toBe(1);
    expect(calls).toBe(2);
  });

  it('shares one load between callers that arrive while it runs, and a failure reaches all of them without being kept (A18)', async () => {
    const blob = await wrap(1, new Uint8Array(32).fill(9));
    let calls = 0;
    let fail = true;
    const flaky: KeyManager = {
      descriptor: manager.descriptor,
      encrypt: (request) => manager.encrypt(request),
      decrypt: async (wrapped, context) => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (fail) throw new Error('throttled');
        return manager.decrypt(wrapped, context);
      },
    };
    const source = createFingerprintKeySource({
      environment: 'test',
      keyManager: flaky,
      wrapped: { 1: blob },
    });
    const together = await Promise.all([source.keyFor(1), source.keyFor(1), source.keyFor(1)]);
    expect(together).toEqual([undefined, undefined, undefined]);
    expect(calls).toBe(1);
    fail = false;
    expect((await source.keyFor(1))?.keyVersion).toBe(1);
    expect(calls).toBe(2);
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
      secretRef: `${NAMESPACE}TESTPAY_API`,
      webhookSecretRef: `${NAMESPACE}TESTPAY_WEBHOOK`,
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

  it('accepts a secret name only inside a lender namespace: a platform secret name or a bare name is refused (U51)', () => {
    const draft = {
      lenderId: '0198b3f4-0000-7000-8000-000000000001',
      provider: 'testpay',
      providerMode: 'production',
      merchantRegistryId: '0198b3f4-0000-7000-8000-000000000002',
      settlementAccountId: '0198b3f4-0000-7000-8000-000000000003',
      secretRef: `${NAMESPACE}TESTPAY_API`,
      webhookSecretRef: `${NAMESPACE}TESTPAY_WEBHOOK`,
    };
    const accepted = [
      `${NAMESPACE}AB`, // the shortest: a capital and one more character
      `${NAMESPACE}A${'B'.repeat(48)}`, // the longest: 49 characters after the namespace
      `${NAMESPACE}TESTPAY_API_2`,
    ];
    for (const name of accepted) {
      expect(PaymentConfigDraftInput.safeParse({ ...draft, secretRef: name }).success, name).toBe(
        true,
      );
    }
    const refused = [
      'TESTPAY_API_SECRET', // a bare name: the old rule
      'SYSTEM_DATABASE_URL', // a platform secret
      'PROVIDER_HOOK_IP_HMAC_KEY',
      'HANDOFF_ENCRYPTION_KEYS',
      `${NAMESPACE}A`, // too short after the namespace
      `${NAMESPACE}A${'B'.repeat(49)}`, // too long after the namespace
      `${NAMESPACE}1ABC`, // must start with a capital letter
      `${NAMESPACE}lower_case`,
      NAMESPACE, // the namespace alone
      'L0198b3f40001_TESTPAY_API', // lower-case hexadecimal digits
      'L0198B3F4000_TESTPAY_API', // eleven digits
      'L0198B3F400012_TESTPAY_API', // thirteen digits
      'L0198B3F4000G_TESTPAY_API', // not hexadecimal
      `l0198B3F40001_TESTPAY_API`,
      ` ${NAMESPACE}TESTPAY_API`,
      `${NAMESPACE}TESTPAY_API\n`,
      `${NAMESPACE}TESTPAY-API`,
    ];
    for (const name of refused) {
      expect(
        PaymentConfigDraftInput.safeParse({ ...draft, secretRef: name }).success,
        JSON.stringify(name),
      ).toBe(false);
      expect(
        PaymentConfigDraftInput.safeParse({ ...draft, webhookSecretRef: name }).success,
        JSON.stringify(name),
      ).toBe(false);
    }
  });

  it('validates the prefix answer and the inputs of the own-account list, the withdrawals and the hold release', () => {
    const lender = '0198b3f4-0000-7000-8000-000000000001';
    expect(SecretRefPrefixQuery.safeParse({ lenderId: lender }).success).toBe(true);
    expect(SecretRefPrefixQuery.safeParse({}).success).toBe(false);
    expect(SecretRefPrefixQuery.safeParse({ lenderId: lender, extra: 1 }).success).toBe(false);
    expect(SecretRefPrefix.safeParse({ lenderId: lender, prefix: NAMESPACE }).success).toBe(true);
    for (const prefix of ['L0198B3F40001', 'TESTPAY_', 'L0198b3f40001_', `${NAMESPACE}X`]) {
      expect(SecretRefPrefix.safeParse({ lenderId: lender, prefix }).success, prefix).toBe(false);
    }

    expect(LenderRecordActionInput.safeParse({ lenderId: lender }).success).toBe(true);
    expect(LenderRecordActionInput.safeParse({}).success).toBe(false);
    expect(LenderRecordActionInput.safeParse({ lenderId: lender, status: 'revoked' }).success).toBe(
      false,
    );

    expect(
      OwnAccountListAttestInput.safeParse({ evidenceRef: 'SAMPLE-OWN-ACCOUNT-RECONCILIATION-1' })
        .success,
    ).toBe(true);
    for (const body of [
      {},
      { evidenceRef: 'ab' },
      { evidenceRef: 'BANK-LETTER-912345678901' },
      { evidenceRef: 'SAMPLE-RECONCILIATION-1', note: 'call 9876543210 about it' },
      { evidenceRef: 'SAMPLE-RECONCILIATION-1', keyVersion: 2 },
    ]) {
      expect(OwnAccountListAttestInput.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }

    const event = {
      id: lender,
      eventKind: 'attested',
      keyVersion: 1,
      evidenceRef: 'SAMPLE-RECONCILIATION-1',
      reason: null,
      entriesCounted: 2,
      actorId: lender,
      occurredAt: '2026-10-18T10:00:00.000Z',
    };
    expect(
      OwnAccountListState.safeParse({ keyVersion: 1, attested: true, events: [event] }).success,
    ).toBe(true);
    expect(
      OwnAccountListState.safeParse({ keyVersion: null, attested: false, events: [] }).success,
    ).toBe(true);
    expect(
      OwnAccountListState.safeParse({
        keyVersion: 1,
        attested: true,
        events: [{ ...event, eventKind: 'verified' }],
      }).success,
    ).toBe(false);
  });

  it('reports a hold on a configuration, and null when the answer does not mention one', () => {
    const entry = {
      id: '0198b3f4-0000-7000-8000-000000000009',
      lenderId: '0198b3f4-0000-7000-8000-000000000001',
      provider: 'testpay',
      providerMode: 'production',
      merchantRegistryId: '0198b3f4-0000-7000-8000-000000000002',
      settlementAccountId: '0198b3f4-0000-7000-8000-000000000003',
      secretRef: `${NAMESPACE}TESTPAY_API`,
      webhookSecretRef: `${NAMESPACE}TESTPAY_WEBHOOK`,
      railLimits: {},
      railLimitsSource: null,
      evidenceRef: null,
      contractSectionRef: null,
      status: 'suspended',
      draftedBy: '0198b3f4-0000-7000-8000-000000000004',
      draftedAt: '2026-10-18T10:00:00.000Z',
      submittedBy: null,
      submittedAt: null,
      approvedBy: null,
      approvedAt: null,
      statusReason: 'suspended by the platform',
      statusReasons: [],
      lastValidatedAt: null,
      lastValidationOk: null,
      updatedAt: '2026-10-18T10:00:00.000Z',
    };
    expect(PaymentConfigEntry.parse(entry)).toMatchObject({ holdKind: null, holdSetAt: null });
    expect(
      PaymentConfigEntry.parse({
        ...entry,
        holdKind: 'platform',
        holdSetAt: '2026-10-18T10:05:00.000Z',
      }),
    ).toMatchObject({ holdKind: 'platform', holdSetAt: '2026-10-18T10:05:00.000Z' });
    expect(PaymentConfigEntry.safeParse({ ...entry, holdKind: 'lender' }).success).toBe(false);
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

  it('declares the routes the accounts migration needs: the own-account list, the hold release, both withdrawals and the secret prefix', () => {
    const wanted: [string, string, string, boolean][] = [
      ['get', '/v1/platform/own-account-list', 'getOwnAccountList', false],
      ['post', '/v1/platform/own-account-list/attest', 'attestOwnAccountList', true],
      ['post', '/v1/platform/own-account-list/withdraw', 'withdrawOwnAccountListAttestation', true],
      ['post', '/v1/platform/payment-configs/:id/release-hold', 'releasePaymentConfigHold', true],
      ['post', '/v1/lender/merchants/:id/withdraw', 'withdrawMerchantClaim', true],
      ['post', '/v1/lender/settlement-accounts/:id/withdraw', 'withdrawSettlementAccount', true],
      ['get', '/v1/lender/secret-ref-prefix', 'getSecretRefPrefix', false],
    ];
    for (const [method, path, operationId, writes] of wanted) {
      const route = routes.find((r) => r.operationId === operationId);
      expect(route, operationId).toBeDefined();
      expect([route?.method, route?.path, route?.auth], operationId).toEqual([
        method,
        path,
        'staff',
      ]);
      expect(route?.idempotent === true, operationId).toBe(writes);
    }
    // The lender-scoped writes name the lender in the body and key idempotency per lender, like every other lender write.
    for (const operationId of ['withdrawMerchantClaim', 'withdrawSettlementAccount']) {
      const route = routes.find((r) => r.operationId === operationId);
      expect(
        route?.idempotencyTenant?.({ body: { lenderId: 'lender-1' } } as never),
        operationId,
      ).toBe('lender-1');
      expect(route?.body?.safeParse({}).success, operationId).toBe(false);
    }
    // A hold is lifted with a reason, and the answer carries an id and a status only.
    const release = routes.find((r) => r.operationId === 'releasePaymentConfigHold');
    expect(release?.body?.safeParse({ reason: 'short' }).success).toBe(false);
    expect(release?.body?.safeParse({ reason: 'the provider incident is closed' }).success).toBe(
      true,
    );
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
