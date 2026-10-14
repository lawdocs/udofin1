import { describe, expect, it } from 'vitest';
import {
  assertLocalOrTestOnly,
  assertProviderAllowed,
  createMockLms,
  createMockMandateProvider,
  createMockNotifier,
  createMockPaymentProvider,
  createUnconfiguredLmsPort,
  createUnconfiguredMandateProvider,
  createUnconfiguredPaymentProvider,
  createUnconfiguredSmsChannel,
  ProviderNotAllowedError,
  satisfiesProductionGate,
  type AppEnvironment,
  type ProviderCapability,
  type ProviderDescriptor,
} from './index.js';

const mocks: readonly (readonly [string, (env: AppEnvironment) => unknown])[] = [
  ['mock LMS', (env) => createMockLms(env)],
  ['mock payment provider', (env) => createMockPaymentProvider(env)],
  ['mock mandate provider', (env) => createMockMandateProvider(env)],
  ['mock notifier', (env) => createMockNotifier(env)],
];

describe('every Phase 08a mock is refused where it must not exist', () => {
  it.each(mocks)(
    '%s: refused in production by the provider guard and in staging explicitly',
    (_name, create) => {
      expect(() => create('production')).toThrow(ProviderNotAllowedError);
      expect(() => create('staging')).toThrow(/local development and tests only/);
      expect(() => create('staging')).not.toThrow(ProviderNotAllowedError);
    },
  );
  it.each(mocks)('%s: allowed in local development and in tests', (_name, create) => {
    expect(() => create('local')).not.toThrow();
    expect(() => create('test')).not.toThrow();
  });
  it('every mock is labelled mode "mock" with a mock_ key', () => {
    const descriptors = [
      createMockLms('test').descriptor,
      createMockPaymentProvider('test').descriptor,
      createMockMandateProvider('test').descriptor,
      createMockNotifier('test').descriptor,
    ];
    for (const d of descriptors) {
      expect(d.mode).toBe('mock');
      expect(d.key).toMatch(/^mock_/);
    }
    expect(descriptors.map((d) => d.capability)).toEqual([
      'lms',
      'payment_collection',
      'mandate',
      'notification',
    ]);
  });
});

describe('provider guard for the new capabilities', () => {
  const capabilities: readonly ProviderCapability[] = [
    'lms',
    'payment_collection',
    'mandate',
    'notification',
  ];
  it.each(capabilities)(
    '%s: a sandbox is refused in production, a live provider in tests, a mock in production',
    (capability) => {
      const sandbox: ProviderDescriptor = { key: 's', capability, mode: 'sandbox' };
      const mock: ProviderDescriptor = { key: 'm', capability, mode: 'mock' };
      const live: ProviderDescriptor = { key: 'l', capability, mode: 'production' };
      expect(() => assertProviderAllowed(sandbox, 'production')).toThrow(ProviderNotAllowedError);
      expect(() => assertProviderAllowed(mock, 'production')).toThrow(ProviderNotAllowedError);
      expect(() => assertProviderAllowed(live, 'test')).toThrow(ProviderNotAllowedError);
      expect(() => assertProviderAllowed(live, 'production')).not.toThrow();
      expect(() => assertLocalOrTestOnly(sandbox, 'staging', 'x')).not.toThrow();
      expect(() => assertLocalOrTestOnly(mock, 'staging', 'x')).toThrow(
        /local development and tests only/,
      );
    },
  );

  it('a mock or sandbox record, or an unconfigured placeholder, never satisfies a production gate', () => {
    expect(
      satisfiesProductionGate({
        key: 'razorpay',
        capability: 'payment_collection',
        mode: 'production',
      }),
    ).toBe(true);
    expect(
      satisfiesProductionGate({
        key: 'razorpay',
        capability: 'payment_collection',
        mode: 'sandbox',
      }),
    ).toBe(false);
    expect(satisfiesProductionGate(createMockPaymentProvider('test').descriptor)).toBe(false);
    for (const placeholder of [
      createUnconfiguredLmsPort().descriptor,
      createUnconfiguredPaymentProvider().descriptor,
      createUnconfiguredMandateProvider().descriptor,
      createUnconfiguredSmsChannel().descriptor,
    ]) {
      expect(satisfiesProductionGate(placeholder)).toBe(false);
    }
  });

  it('error messages name the capability and key but carry no input data', () => {
    expect(() => createMockLms('production')).toThrow(ProviderNotAllowedError);
    let caught: unknown;
    try {
      createMockLms('production');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe(
      'lms provider "mock_lms" in mock mode is not allowed in production',
    );
  });
});
