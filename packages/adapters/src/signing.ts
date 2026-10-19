import { assertProviderAllowed, type AppEnvironment, type ProviderDescriptor } from './provider.js';

/**
 * Boundary for electronic signing. No real provider exists: the vendor structure (D-13) and the legally approved
 * signature method (D-58) are undecided, so nothing here pretends to sign. The application depends on this port;
 * a real provider is an adapter written once a specification and credentials exist.
 *
 * An OTP is NOT an electronic signature. A request is "executed" only when the provider says so, with its own
 * reference and evidence. An outcome the caller could not observe is `unknown` and is reconciled by a status lookup,
 * never by starting the signing again.
 */
export type SigningStatus =
  | { state: 'initiated'; providerRef: string }
  | { state: 'awaiting_borrower'; providerRef: string }
  | { state: 'executed'; providerRef: string; evidenceRef: string }
  | {
      state: 'failed';
      providerRef?: string;
      reason: 'provider_error' | 'declined' | 'document_rejected';
    }
  | { state: 'expired'; providerRef: string }
  | { state: 'cancelled'; providerRef: string }
  | { state: 'unknown' };

export interface SigningRequest {
  /** Stable per document: the provider (and the mock) must treat a repeat as the same request. */
  idempotencyKey: string;
  documentId: string;
  documentSha256: string;
  /** Opaque key of the exact stored file; the adapter reads the bytes through the document store, never a public URL. */
  storageKey: string;
}

export interface SigningProvider {
  readonly descriptor: ProviderDescriptor;
  readonly capabilities: { statusLookup: boolean };
  initiate(request: SigningRequest): Promise<SigningStatus>;
  /** Asks the provider where a request stands, by its own reference or, if the start was never confirmed, by our idempotency key. */
  status(query: { providerRef: string | null; idempotencyKey: string }): Promise<SigningStatus>;
}

/** Used when no provider is approved: refuses honestly. */
export function createUnconfiguredSigningProvider(): SigningProvider {
  return {
    descriptor: { key: 'esign_not_configured', capability: 'esign', mode: 'production' },
    capabilities: { statusLookup: false },
    initiate: () =>
      Promise.resolve({ state: 'failed' as const, reason: 'provider_error' as const }),
    status: () => Promise.resolve({ state: 'unknown' as const }),
  };
}

const mockRef = (idempotencyKey: string): string => `MOCK-${idempotencyKey.slice(0, 24)}`;

export type MockSigningScript = 'complete' | 'await_borrower' | 'fail' | 'timeout';

/**
 * Test/development double, clearly labelled `mock_esign`. It produces no signature and no legal effect. The provider
 * guard refuses it in staging and production, and the database refuses a mock signing request unless the session
 * allows it.
 */
export function createMockSigningProvider(
  environment: AppEnvironment,
  script: () => MockSigningScript = () => 'complete',
): SigningProvider & { readonly calls: SigningRequest[] } {
  const descriptor: ProviderDescriptor = { key: 'mock_esign', capability: 'esign', mode: 'mock' };
  assertProviderAllowed(descriptor, environment);
  if (environment === 'staging') {
    // The generic guard allows mocks in staging; a mock signer must not exist anywhere deployed.
    throw new Error('the mock signing provider is for local development and tests only');
  }
  const calls: SigningRequest[] = [];
  const known = new Map<string, SigningStatus>();
  return {
    descriptor,
    capabilities: { statusLookup: true },
    calls,
    initiate: (request) => {
      const ref = mockRef(request.idempotencyKey);
      const existing = known.get(ref);
      if (existing) return Promise.resolve(existing);
      calls.push(request);
      const outcome = script();
      let status: SigningStatus;
      switch (outcome) {
        case 'complete':
          status = { state: 'executed', providerRef: ref, evidenceRef: `MOCK-EVIDENCE-${ref}` };
          break;
        case 'await_borrower':
          status = { state: 'awaiting_borrower', providerRef: ref };
          break;
        case 'fail':
          status = { state: 'failed', providerRef: ref, reason: 'declined' };
          break;
        case 'timeout':
          // The mock "may have" started signing: the caller must reconcile, not retry blindly.
          known.set(ref, { state: 'awaiting_borrower', providerRef: ref });
          return Promise.resolve({ state: 'unknown' as const });
      }
      known.set(ref, status);
      return Promise.resolve(status);
    },
    status: ({ providerRef, idempotencyKey }) =>
      Promise.resolve(
        known.get(providerRef ?? mockRef(idempotencyKey)) ?? { state: 'unknown' as const },
      ),
  };
}
