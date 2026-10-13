import { assertProviderAllowed, type AppEnvironment, type ProviderDescriptor } from './provider.js';

/**
 * Port for device / app integrity assessment (D-24: tiered). It answers ONE question - how much do
 * we trust the app and device - and never anything about who the user is. A token from the client
 * is only evidence for a verifier to check on the server; the client's own claim about its level is
 * never accepted.
 */
export type IntegrityLevel = 'none' | 'basic' | 'device' | 'strong';

export type IntegrityResult =
  { status: 'verified'; level: IntegrityLevel } | { status: 'invalid' } | { status: 'unavailable' };

export interface IntegrityVerifier {
  readonly descriptor: ProviderDescriptor;
  /** `nonce` is the single-use value the server issued; the verifier must confirm it is bound into the token. */
  verify(input: { token: string; nonce: string }): Promise<IntegrityResult>;
}

/** No provider configured (the production Play Integrity adapter needs Google Cloud credentials). */
export function createUnavailableIntegrityVerifier(): IntegrityVerifier {
  return {
    descriptor: {
      key: 'integrity_not_configured',
      capability: 'device_integrity',
      mode: 'production',
    },
    verify: () => Promise.resolve({ status: 'unavailable' as const }),
  };
}

const LEVELS: readonly IntegrityLevel[] = ['none', 'basic', 'device', 'strong'];

/**
 * Test double: accepts tokens of the form `mock:<level>:<nonce>`. It is NOT device security and the
 * guard refuses it outside local development and tests.
 */
export function createMockIntegrityVerifier(environment: AppEnvironment): IntegrityVerifier {
  const descriptor: ProviderDescriptor = {
    key: 'mock_integrity',
    capability: 'device_integrity',
    mode: 'mock',
  };
  assertProviderAllowed(descriptor, environment);
  if (environment === 'staging')
    throw new Error('the mock integrity verifier is for local development and tests only');
  return {
    descriptor,
    verify({ token, nonce }) {
      const [prefix, level, boundNonce] = token.split(':');
      if (prefix !== 'mock' || boundNonce !== nonce || !LEVELS.includes(level as IntegrityLevel)) {
        return Promise.resolve({ status: 'invalid' as const });
      }
      return Promise.resolve({ status: 'verified' as const, level: level as IntegrityLevel });
    },
  };
}
