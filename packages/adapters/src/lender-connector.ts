import { createHmac, timingSafeEqual } from 'node:crypto';
import { assertProviderAllowed, type AppEnvironment, type ProviderDescriptor } from './provider.js';

/**
 * Port between Udofin's routing logic and one lender's own system. Nothing in the borrower flow knows
 * how a lender is reached; a real connector is written per lender once the lender's API, authentication,
 * payload specification and test environment exist (none exists today). Lenders without an API are
 * served by the lender portal and need no connector.
 *
 * Results never claim more than is known: a timeout is `unknown`, not `rejected`.
 */

/** The fixed minimum payload (scope `minimum_payload_v1`). Nothing else may be added without new consent. */
export interface LenderApplicationPayload {
  udofinReference: string | null;
  request: { categoryKey: string; amountMinor: number; tenureDays: number; purposeCode: string };
  productVersionId: string;
  displayName: string | null;
  /** Read from the authentication record at send time; never stored by Udofin. */
  phone: string;
  language: 'en' | 'hi';
}

export interface LenderSubmitRequest {
  lenderId: string;
  /** Stable per application; the lender should use it to recognise a retry. Not the lender's own id. */
  correlationRef: string;
  attempt: number;
  payload: LenderApplicationPayload;
}

export type LenderSubmitResult =
  | { status: 'accepted'; lenderApplicationRef?: string }
  | { status: 'rejected'; reason: 'invalid_request' | 'lender_refused' | 'provider_error' }
  | { status: 'unknown'; reason: 'timeout' | 'network' }
  | { status: 'not_configured' };

export type LenderLookupResult =
  | { status: 'found'; lenderApplicationRef?: string }
  | { status: 'not_found' }
  | { status: 'unknown' };

export interface LenderConnector {
  readonly descriptor: ProviderDescriptor;
  readonly capabilities: { callbacks: boolean; statusLookup: boolean };
  submit(request: LenderSubmitRequest): Promise<LenderSubmitResult>;
  /** Asks the lender whether it holds an application with this correlation reference. */
  lookup(input: { lenderId: string; correlationRef: string }): Promise<LenderLookupResult>;
}

/** No connector exists for this lender: refuses honestly instead of pretending to send. */
export function createUnconfiguredLenderConnector(): LenderConnector {
  return {
    descriptor: {
      key: 'lender_connector_not_configured',
      capability: 'lender_connector',
      mode: 'production',
    },
    capabilities: { callbacks: false, statusLookup: false },
    submit: () => Promise.resolve({ status: 'not_configured' as const }),
    lookup: () => Promise.resolve({ status: 'unknown' as const }),
  };
}

export interface MockLenderConnector extends LenderConnector {
  readonly submitted: readonly LenderSubmitRequest[];
  /** Results to return for the next calls, in order; afterwards the mock accepts. */
  queue(...results: LenderSubmitResult[]): void;
  /** What `lookup` answers for a reference, for reconciliation tests. */
  setLookup(correlationRef: string, result: LenderLookupResult): void;
}

/**
 * TEST DOUBLE. Not a lender, not a production integration. It records what it was sent so tests can prove
 * the payload is exactly the approved one. Allowed only in local development and tests.
 */
export function createMockLenderConnector(environment: AppEnvironment): MockLenderConnector {
  const descriptor: ProviderDescriptor = {
    key: 'mock_lender_connector',
    capability: 'lender_connector',
    mode: 'mock',
  };
  assertProviderAllowed(descriptor, environment);
  if (environment === 'staging') {
    throw new Error('the mock lender connector is for local development and tests only');
  }
  const submitted: LenderSubmitRequest[] = [];
  const results: LenderSubmitResult[] = [];
  const lookups = new Map<string, LenderLookupResult>();
  return {
    descriptor,
    capabilities: { callbacks: true, statusLookup: true },
    submitted,
    queue: (...r) => void results.push(...r),
    setLookup: (ref, result) => void lookups.set(ref, result),
    submit(request) {
      submitted.push(structuredClone(request));
      return Promise.resolve(
        results.shift() ?? {
          status: 'accepted',
          lenderApplicationRef: `MOCK-${request.correlationRef.slice(0, 8)}`,
        },
      );
    },
    lookup: ({ correlationRef }) =>
      Promise.resolve(lookups.get(correlationRef) ?? { status: 'unknown' as const }),
  };
}

/** Bounds a connector call; a slow lender becomes `unknown/timeout` instead of a hung job. */
export function withLenderTimeout(inner: LenderConnector, milliseconds: number): LenderConnector {
  return {
    descriptor: inner.descriptor,
    capabilities: inner.capabilities,
    async submit(request) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<LenderSubmitResult>((resolve) => {
        timer = setTimeout(() => resolve({ status: 'unknown', reason: 'timeout' }), milliseconds);
      });
      try {
        return await Promise.race([
          inner
            .submit(request)
            .catch((): LenderSubmitResult => ({ status: 'unknown', reason: 'network' })),
          timeout,
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    async lookup(input) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<LenderLookupResult>((resolve) => {
        timer = setTimeout(() => resolve({ status: 'unknown' }), milliseconds);
      });
      try {
        return await Promise.race([
          inner.lookup(input).catch((): LenderLookupResult => ({ status: 'unknown' })),
          timeout,
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}

/**
 * Callback signing for the MOCK connector only: a Standard-Webhooks-style HMAC so tests can exercise signature
 * verification, replay windows and tampering. It is NOT a production protocol. A real lender's scheme is written
 * with that lender's specification.
 */
export const MOCK_CALLBACK_SCHEME = 'mock-standard-webhooks-v1';

export function signMockCallback(
  secret: string,
  id: string,
  timestampSeconds: number,
  body: string,
): string {
  const key = Buffer.from(secret.replace(/^v1,whsec_/, '').replace(/^whsec_/, ''), 'base64');
  return `v1,${createHmac('sha256', key)
    .update(`${id}.${String(timestampSeconds)}.${body}`)
    .digest('base64')}`;
}

export function verifyMockCallback(input: {
  secret: string;
  id: string | undefined;
  timestamp: string | undefined;
  signatureHeader: string | undefined;
  body: string;
  now?: number;
  toleranceSeconds?: number;
}): boolean {
  const { secret, id, timestamp, signatureHeader, body } = input;
  if (!id || !timestamp || !signatureHeader) return false;
  const ts = Number(timestamp);
  const now = input.now ?? Math.floor(Date.now() / 1000);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > (input.toleranceSeconds ?? 300)) return false;
  const expected = Buffer.from(signMockCallback(secret, id, ts, body).slice(3), 'base64');
  return signatureHeader.split(' ').some((part) => {
    const [version, signature] = part.split(',');
    if (version !== 'v1' || !signature) return false;
    const given = Buffer.from(signature, 'base64');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}
