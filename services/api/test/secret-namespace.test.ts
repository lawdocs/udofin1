// A secret is read from the environment only under a name inside the lender's own namespace (review finding U51). These tests
// use a fake environment that records every read, so "never read" is proved, not assumed.
import { createMockPaymentProvider, type PaymentProviderPort } from '@udofin/adapters';
import { describe, expect, it } from 'vitest';
import { createProviderHookProcessor } from '../src/system/provider-hooks.js';
import {
  createSecretReader,
  NO_SECRET_NAME,
  secretNamesInNamespace,
  secretNamespaceOf,
} from '../src/system/secret-namespace.js';
import { type SystemPool } from '../src/system/pool.js';
import { withLenderSecretNamespace } from '../src/workers/namespaced-resolver.js';
import {
  createProviderResolverWith,
  type PaymentConfigRow,
} from '../src/workers/provider-resolver.js';

// Two lenders whose ids differ in the last twelve hexadecimal digits, which are what the namespace is made of.
const LENDER_A = '0198b3f4-0000-7000-8000-00000000abcd';
const LENDER_B = '0198b3f4-0000-7000-8000-00000000ef01';
const NS_A = 'L00000000ABCD_';
const NS_B = 'L00000000EF01_';

/** An environment whose every read is recorded. Setting a value does not count as a read. */
function recordingEnv(values: Record<string, string>) {
  const reads: string[] = [];
  const env: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(values)) {
    Object.defineProperty(env, name, {
      enumerable: true,
      get() {
        reads.push(name);
        return value;
      },
    });
  }
  return { env, reads };
}

describe('secretNamespaceOf', () => {
  it('derives the namespace exactly as private.secret_ref_prefix does: L, the last twelve hex digits in capitals, an underscore', () => {
    expect(secretNamespaceOf(LENDER_A)).toBe(NS_A);
    expect(secretNamespaceOf(LENDER_B)).toBe(NS_B);
    expect(secretNamespaceOf('0198B3F4-0000-7000-8000-00000000ABCD')).toBeUndefined();
    expect(secretNamespaceOf('not-a-uuid')).toBeUndefined();
    expect(secretNamespaceOf('')).toBeUndefined();
  });
});

describe('secretNamesInNamespace', () => {
  const ok = {
    storedNamespace: NS_A,
    expectedNamespace: NS_A,
    secretRef: `${NS_A}PAY_API`,
    webhookSecretRef: `${NS_A}PAY_HOOK`,
  };

  it('is true only when the namespace is stored, is the lender namespace, and both names start with it', () => {
    expect(secretNamesInNamespace(ok)).toBe(true);
  });

  it.each([
    ['no stored namespace (a row written before the rule)', { storedNamespace: null }],
    ['an undefined stored namespace', { storedNamespace: undefined }],
    ['a stored namespace that is not shaped like one', { storedNamespace: 'PAY_' }],
    ['a stored namespace of another lender', { storedNamespace: NS_B }],
    ['no expected namespace', { expectedNamespace: null }],
    ['an expected namespace of another lender', { expectedNamespace: NS_B }],
    ['a secret name of another lender', { secretRef: `${NS_B}PAY_API` }],
    ['a webhook secret name of another lender', { webhookSecretRef: `${NS_B}PAY_HOOK` }],
    ['a bare secret name', { secretRef: 'PAY_API' }],
    ['a platform secret as the webhook secret', { webhookSecretRef: 'SYSTEM_DATABASE_URL' }],
    ['an empty secret name', { secretRef: '' }],
    ['a namespace written in lower case in the name', { secretRef: `${NS_A.toLowerCase()}pay` }],
  ])('is false for %s', (_label, change) => {
    expect(secretNamesInNamespace({ ...ok, ...change })).toBe(false);
  });
});

describe('createSecretReader', () => {
  it('reads a name inside a lender namespace and the platform names it was given, and nothing else', () => {
    const { env, reads } = recordingEnv({
      [`${NS_A}PAY_API`]: 'value-a',
      [`${NS_B}PAY_API`]: 'value-b',
      PROVIDER_HOOK_IP_HMAC_KEY: 'platform-value',
      SYSTEM_DATABASE_URL: 'database-login',
      HANDOFF_ENCRYPTION_KEYS: 'handoff-keys',
      PAY_API: 'bare',
    });
    const read = createSecretReader(env, ['PROVIDER_HOOK_IP_HMAC_KEY']);
    expect(read(`${NS_A}PAY_API`)).toBe('value-a');
    expect(read('PROVIDER_HOOK_IP_HMAC_KEY')).toBe('platform-value');
    expect(reads).toEqual([`${NS_A}PAY_API`, 'PROVIDER_HOOK_IP_HMAC_KEY']);

    reads.length = 0;
    for (const name of [
      'SYSTEM_DATABASE_URL',
      'HANDOFF_ENCRYPTION_KEYS',
      'PAY_API',
      NO_SECRET_NAME,
      NS_A, // the namespace alone is not a name
      `${NS_A}pay_api`,
      `${NS_A}PAY-API`,
      `${NS_A}PAY_API `,
      'constructor',
      '__proto__',
      'toString',
    ])
      expect(read(name), JSON.stringify(name)).toBeUndefined();
    // The environment was not touched for any of them.
    expect(reads).toEqual([]);
  });

  it('answers nothing for a lender-shaped name that is not set, and never an inherited member', () => {
    const read = createSecretReader({}, []);
    expect(read(`${NS_A}NOT_SET`)).toBeUndefined();
    expect(read('hasOwnProperty')).toBeUndefined();
  });

  it('refuses a platform secret named inside a lender namespace, so no lender configuration can ever name it', () => {
    expect(() => createSecretReader({}, [`${NS_A}PLATFORM_KEY`])).toThrow(/lender namespace/);
    expect(() => createSecretReader({}, [`${NS_A}`])).toThrow(/lender namespace/);
    expect(() => createSecretReader({}, ['PROVIDER_HOOK_IP_HMAC_KEY'])).not.toThrow();
  });
});

describe('the callback receiver: lookupConfig hands on the webhook secret name only when it is inside the lender namespace', () => {
  interface Row {
    id: string;
    provider: string;
    provider_mode: string;
    secret_ref: string;
    webhook_secret_ref: string;
    secret_namespace: string | null;
    expected_namespace: string;
  }
  const row = (change: Partial<Row> = {}): Row => ({
    id: '0198b3f4-0000-7000-8000-000000000099',
    provider: 'testpay',
    provider_mode: 'production',
    secret_ref: `${NS_A}PAY_API`,
    webhook_secret_ref: `${NS_A}PAY_HOOK`,
    secret_namespace: NS_A,
    expected_namespace: NS_A,
    ...change,
  });
  const poolOf = (rows: Row[], sql: string[] = []): SystemPool => ({
    withSystem: (fn) =>
      fn({
        query: (text: string) => {
          sql.push(text);
          return Promise.resolve({ rows });
        },
      } as never),
    end: () => Promise.resolve(),
  });

  it('asks the database for the namespace the lender must have, in the same query', async () => {
    const sql: string[] = [];
    await createProviderHookProcessor(poolOf([row()], sql)).lookupConfig('a'.repeat(64));
    expect(sql).toHaveLength(1);
    expect(sql[0]).toContain('private.secret_ref_prefix(lender_org_id)');
    expect(sql[0]).toContain('secret_namespace');
    expect(sql[0]).toContain('secret_ref');
  });

  it('returns the name for a configuration whose namespace is stored, is the lender namespace and covers both names', async () => {
    const config = await createProviderHookProcessor(poolOf([row()])).lookupConfig('a'.repeat(64));
    expect(config).toEqual({
      configId: '0198b3f4-0000-7000-8000-000000000099',
      provider: 'testpay',
      providerMode: 'production',
      webhookSecretRef: `${NS_A}PAY_HOOK`,
    });
  });

  it.each([
    ['no stored namespace', { secret_namespace: null }],
    ['a stored namespace that is not the lender namespace', { secret_namespace: NS_B }],
    ['a webhook secret name outside the namespace', { webhook_secret_ref: 'SYSTEM_DATABASE_URL' }],
    ['a webhook secret name of another lender', { webhook_secret_ref: `${NS_B}PAY_HOOK` }],
    ['a secret name outside the namespace', { secret_ref: 'PAY_API' }],
  ])('treats the secret as missing for %s: no name is handed on', async (_label, change) => {
    const config = await createProviderHookProcessor(poolOf([row(change)])).lookupConfig(
      'a'.repeat(64),
    );
    // The rest of the configuration is still found, so the delivery is recorded as unverified for a closed reason.
    expect(config).toMatchObject({ provider: 'testpay', providerMode: 'production' });
    expect(config?.webhookSecretRef).toBe(NO_SECRET_NAME);
    // And the reader the receiver is started with reads nothing for it.
    const { env, reads } = recordingEnv({ SYSTEM_DATABASE_URL: 'database-login' });
    expect(createSecretReader(env, [])(config?.webhookSecretRef ?? 'x')).toBeUndefined();
    expect(reads).toEqual([]);
  });

  it('returns null for an unknown token as before', async () => {
    expect(await createProviderHookProcessor(poolOf([])).lookupConfig('b'.repeat(64))).toBeNull();
  });
});

describe('the worker: a provider port is built only for secret names inside the namespace of the configuration lender', () => {
  const config = (change: Partial<PaymentConfigRow> = {}): PaymentConfigRow => ({
    configId: '0198b3f4-0000-7000-8000-000000000098',
    lenderOrgId: LENDER_A,
    provider: 'real_gateway',
    providerMode: 'live',
    merchantRef: 'MER-A-1',
    secretRef: `${NS_A}GATEWAY_API`,
    webhookSecretRef: `${NS_A}GATEWAY_HOOK`,
    ...change,
  });

  function build() {
    const given: string[] = [];
    const real = (secret: string): PaymentProviderPort => {
      given.push(secret);
      return createMockPaymentProvider('test');
    };
    const { env, reads } = recordingEnv({
      [`${NS_A}GATEWAY_API`]: 'credential-of-a',
      [`${NS_B}GATEWAY_API`]: 'credential-of-b',
      SYSTEM_DATABASE_URL: 'database-login',
      HANDOFF_ENCRYPTION_KEYS: 'handoff-keys',
    });
    const resolver = withLenderSecretNamespace(
      createProviderResolverWith(
        { environment: 'production', secret: createSecretReader(env) },
        { real_gateway: { payment: real } },
      ),
    );
    return { resolver, given, reads };
  }

  it('builds the port with the credential of its own lender', () => {
    const { resolver, given, reads } = build();
    expect(resolver.payment(config()).ok).toBe(true);
    expect(given).toEqual(['credential-of-a']);
    expect(reads).toEqual([`${NS_A}GATEWAY_API`]);
  });

  it.each([
    ["another lender's credential", { secretRef: `${NS_B}GATEWAY_API` }],
    ['a platform secret as the credential', { secretRef: 'SYSTEM_DATABASE_URL' }],
    ['a platform secret as the webhook secret', { webhookSecretRef: 'HANDOFF_ENCRYPTION_KEYS' }],
    ['a bare name', { secretRef: 'GATEWAY_API' }],
  ])('answers secret_missing for %s and reads nothing from the environment', (_label, change) => {
    const { resolver, given, reads } = build();
    expect(resolver.payment(config(change))).toEqual({ ok: false, reason: 'secret_missing' });
    expect(resolver.mandate(config(change))).toEqual({ ok: false, reason: 'secret_missing' });
    expect(given).toEqual([]);
    expect(reads).toEqual([]);
  });

  it('refuses the same configuration under the id of a lender whose namespace the names are not in', () => {
    const { resolver, given, reads } = build();
    expect(resolver.payment(config({ lenderOrgId: LENDER_B }))).toEqual({
      ok: false,
      reason: 'secret_missing',
    });
    expect(given).toEqual([]);
    expect(reads).toEqual([]);
  });

  it('leaves a mock configuration alone: it reads no secret, so its fixture names are not a risk', () => {
    const { resolver, reads } = build();
    const mock = resolver.payment(
      config({ providerMode: 'mock', secretRef: 'MOCK_KEY', webhookSecretRef: 'MOCK_HOOK' }),
    );
    // The resolver is built for production here, so a mock is refused by its own rule, not by the namespace.
    expect(mock).toEqual({ ok: false, reason: 'mock_not_allowed_here' });
    expect(reads).toEqual([]);
  });
});
