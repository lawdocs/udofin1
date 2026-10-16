import { describe, expect, it } from 'vitest';
import {
  assertProviderAllowed,
  ProviderNotAllowedError,
  type ProviderDescriptor,
} from './provider.js';

const mock: ProviderDescriptor = { key: 'mock_kyc', capability: 'kyc', mode: 'mock' };
const sandbox: ProviderDescriptor = { key: 'surepass', capability: 'kyc', mode: 'sandbox' };
const live: ProviderDescriptor = { key: 'surepass', capability: 'kyc', mode: 'production' };

describe('assertProviderAllowed', () => {
  it('only allows live providers in production', () => {
    expect(() => assertProviderAllowed(live, 'production')).not.toThrow();
    expect(() => assertProviderAllowed(mock, 'production')).toThrow(ProviderNotAllowedError);
    expect(() => assertProviderAllowed(sandbox, 'production')).toThrow(ProviderNotAllowedError);
  });

  it('never sends test or staging traffic to a live provider', () => {
    for (const env of ['local', 'test', 'staging'] as const) {
      expect(() => assertProviderAllowed(live, env)).toThrow(ProviderNotAllowedError);
    }
  });

  it('keeps automated tests on mocks only', () => {
    expect(() => assertProviderAllowed(mock, 'test')).not.toThrow();
    expect(() => assertProviderAllowed(sandbox, 'test')).toThrow(ProviderNotAllowedError);
  });
});
