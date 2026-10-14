import { createHash } from 'node:crypto';
import { isValidIsoDate } from './lms.js';
import { MAX_MONEY_MINOR } from './money.js';
import {
  buildMockWebhookBody,
  signMockWebhook,
  type MockDelivery,
  type PlatformEventStatus,
} from './payments.js';
import {
  assertLocalOrTestOnly,
  type AppEnvironment,
  type ProviderCallContext,
  type ProviderDescriptor,
} from './provider.js';

/**
 * Repayment-mandate port (eNACH / API mandate and UPI AutoPay), with the LENDER as creditor.
 *
 * What the port can and cannot do:
 *   - `createMandateRequest` returns a HAND-OFF to the provider/bank flow, typed `activated: false`. It is not a
 *     mandate and never marks anything active. A redirect back to the app proves nothing.
 *   - A mandate becomes active, rejected, revoked or expired only on a verified provider event or on
 *     `getMandateStatus`, an authenticated lookup. Anything else is `requires_reconciliation`.
 *   - `cancelMandate` is a REQUEST. The mandate is cancelled only when the provider confirms it.
 *   - Udofin never tries to avoid an additional factor of authentication; `needsAfaEachDebit` says that a rail may ask
 *     the borrower to authenticate every debit.
 *   - The account is carried as a masked reference (last digits) only. No account number, no name, no phone number.
 *
 * No provider, sponsor bank or utility code exists (D-65/D-66): nothing here is a real rail. The only implementation is
 * the labelled mock below and an unconfigured placeholder.
 */

export type MandateRail = 'enach_api' | 'upi_autopay';
export const MANDATE_RAILS: readonly MandateRail[] = ['enach_api', 'upi_autopay'];

export interface MandateRailCapability {
  readonly supported: boolean;
  /**
   * True when this rail may require the borrower to authenticate EVERY debit (for example a UPI AutoPay debit above the
   * no-authentication limit, whose value is configuration from the provider documentation and unverified today). The
   * app then steers to another rail or tells the borrower a bank prompt will appear. Conservative default: true.
   */
  readonly needsAfaEachDebit: boolean;
}

export interface MandateProviderCapabilities {
  readonly rails: Readonly<Record<MandateRail, MandateRailCapability>>;
  readonly statusLookup: boolean;
  readonly cancellation: boolean;
  readonly debitStatus: boolean;
}

export interface MandateRequest {
  /** The mandate id. Idempotency key: a repeat is the same request. */
  readonly operationKey: string;
  readonly rail: MandateRail;
  /** The lender's creditor identifier (utility code / merchant id) from the approved configuration. */
  readonly merchantRef: string;
  /** Integer paise, set by lender policy and the configured rail limit. */
  readonly maxAmountMinor: bigint;
  readonly currency: 'INR';
  readonly startDate: string;
  readonly endDate: string;
  /** Masked reference such as `XXXXXX1234`. A full account number is refused. */
  readonly maskedAccountRef: string;
}

/** A hand-off to the bank/provider authorisation flow. NOT an activation, by type and by value. */
export interface MandateHandOff {
  readonly kind: 'handoff';
  readonly activated: false;
  readonly providerMandateRef: string;
  /** A BEARER SECRET for the borrower's authorisation flow. Never stored in clear, never logged. */
  readonly handOffLink: string | null;
  readonly expiresAt: string | null;
}

export type MandateProviderStatus =
  | 'registration_pending'
  | 'active'
  | 'rejected'
  | 'failed'
  | 'expired'
  | 'paused'
  | 'cancelled'
  | 'revoked';

export interface MandateStatusReport {
  readonly source: 'provider_authenticated_lookup';
  readonly providerMandateRef: string;
  readonly rail: MandateRail;
  readonly status: MandateProviderStatus;
  readonly maxAmountMinor: bigint | null;
  readonly merchantRef: string | null;
  readonly observedAt: string;
}

export interface MandateLookupQuery {
  readonly providerMandateRef: string | null;
  readonly operationKey: string;
}

export interface MandateCancelRequest {
  readonly providerMandateRef: string;
  readonly operationKey: string;
}

/** The provider took the cancellation request. The mandate is NOT yet cancelled. */
export interface MandateCancelAck {
  readonly kind: 'cancel_requested';
  readonly cancelled: false;
  readonly providerMandateRef: string;
}

export type MandateDebitStatus =
  'scheduled' | 'notified' | 'presented' | 'settled' | 'returned' | 'cancelled' | 'unknown';

export interface MandateDebitReport {
  readonly providerDebitRef: string;
  readonly providerMandateRef: string;
  readonly scheduledOn: string;
  readonly amountMinor: bigint;
  readonly status: MandateDebitStatus;
  /** The provider's return/reject code, verbatim. Classified through configuration, never by a hard-coded table. */
  readonly returnCode: string | null;
  readonly observedAt: string;
}

export interface MandateDebitQuery {
  readonly providerMandateRef: string;
  /** YYYY-MM-DD, inclusive. */
  readonly from: string;
  readonly to: string;
}

export type MandateResult<T> =
  | { readonly outcome: 'ok'; readonly value: T }
  /** The provider may or may not have acted. Look it up by operation key before any retry. */
  | { readonly outcome: 'unknown'; readonly reason: 'timeout' | 'network' }
  | {
      readonly outcome: 'rejected';
      readonly reason: 'invalid_request' | 'rail_not_supported' | 'provider_error';
    }
  | { readonly outcome: 'not_found' }
  | { readonly outcome: 'unsupported' }
  | { readonly outcome: 'not_configured' };

export interface MandateProviderPort {
  readonly descriptor: ProviderDescriptor;
  readonly capabilities: MandateProviderCapabilities;
  /** Returns a hand-off reference only. It never activates anything. */
  createMandateRequest(
    ctx: ProviderCallContext,
    request: MandateRequest,
  ): Promise<MandateResult<MandateHandOff>>;
  getMandateStatus(
    ctx: ProviderCallContext,
    query: MandateLookupQuery,
  ): Promise<MandateResult<MandateStatusReport>>;
  cancelMandate(
    ctx: ProviderCallContext,
    request: MandateCancelRequest,
  ): Promise<MandateResult<MandateCancelAck>>;
  listDebitStatus(
    ctx: ProviderCallContext,
    query: MandateDebitQuery,
  ): Promise<MandateResult<readonly MandateDebitReport[]>>;
}

/** No mandate provider or sponsor-bank arrangement exists: refuses honestly. */
export function createUnconfiguredMandateProvider(): MandateProviderPort {
  const notConfigured = (): Promise<{ readonly outcome: 'not_configured' }> =>
    Promise.resolve({ outcome: 'not_configured' as const });
  const none: MandateRailCapability = { supported: false, needsAfaEachDebit: true };
  return {
    descriptor: {
      key: 'mandate_provider_not_configured',
      capability: 'mandate',
      mode: 'production',
    },
    capabilities: {
      rails: { enach_api: none, upi_autopay: none },
      statusLookup: false,
      cancellation: false,
      debitStatus: false,
    },
    createMandateRequest: notConfigured,
    getMandateStatus: notConfigured,
    cancelMandate: notConfigured,
    listDebitStatus: notConfigured,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Labelled mock
// ---------------------------------------------------------------------------------------------------------

export type MockMandateScenario =
  | 'registered'
  | 'rejected'
  | 'returned_debit'
  | 'revoked'
  | 'expired'
  | 'delayed'
  | 'contradictory_events'
  | 'unknown_outcome';

export interface MockMandateProvider extends MandateProviderPort {
  readonly scenario: MockMandateScenario;
  /** Requests that created a hand-off (a repeated operation key is not counted again). */
  readonly requests: readonly MandateRequest[];
  readonly cancelRequests: readonly MandateCancelRequest[];
}

export const MOCK_MANDATE_OBSERVED_AT = '2026-10-14T00:00:00.000Z';
export const MOCK_MANDATE_RETURN_CODE = 'SAMPLE-RETURN-CODE';
const MASKED_ACCOUNT = /^[X*]{2,}[0-9]{2,4}$/;
const MERCHANT_REF = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;
const SAMPLE_DEBIT_MINOR = 450_000n;

const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * TEST DOUBLE, `mock_mandate_provider`. No network, no bank, deterministic. Allowed in local development and tests only
 * (staging is refused as well). The mock UPI rail reports `needsAfaEachDebit: true`, the conservative answer.
 */
export function createMockMandateProvider(
  environment: AppEnvironment,
  scenario: MockMandateScenario = 'registered',
): MockMandateProvider {
  const descriptor: ProviderDescriptor = {
    key: 'mock_mandate_provider',
    capability: 'mandate',
    mode: 'mock',
  };
  assertLocalOrTestOnly(descriptor, environment, 'mock mandate provider');
  const requests: MandateRequest[] = [];
  const cancelRequests: MandateCancelRequest[] = [];
  const mandates = new Map<string, { providerMandateRef: string; request: MandateRequest }>();
  const lookups = new Map<string, number>();
  const refFor = (operationKey: string): string => `MOCK-MANDATE-${operationKey.slice(0, 24)}`;
  const findMandate = (query: MandateLookupQuery) =>
    mandates.get(query.operationKey) ??
    [...mandates.values()].find(
      (m) => query.providerMandateRef !== null && m.providerMandateRef === query.providerMandateRef,
    );
  const handOff = (providerMandateRef: string): MandateHandOff => ({
    kind: 'handoff',
    activated: false,
    providerMandateRef,
    handOffLink: `https://mock-mandate.invalid/handoff/${sha256Hex(providerMandateRef).slice(0, 24)}`,
    expiresAt: null,
  });

  return {
    descriptor,
    scenario,
    requests,
    cancelRequests,
    capabilities: {
      rails: {
        enach_api: { supported: true, needsAfaEachDebit: false },
        upi_autopay: { supported: true, needsAfaEachDebit: true },
      },
      statusLookup: true,
      cancellation: true,
      debitStatus: true,
    },
    createMandateRequest(_ctx, request) {
      if (!MANDATE_RAILS.includes(request.rail)) {
        return Promise.resolve({ outcome: 'rejected', reason: 'rail_not_supported' });
      }
      if (
        request.currency !== 'INR' ||
        request.maxAmountMinor <= 0n ||
        request.maxAmountMinor > MAX_MONEY_MINOR ||
        request.operationKey.length === 0 ||
        !MERCHANT_REF.test(request.merchantRef) ||
        !MASKED_ACCOUNT.test(request.maskedAccountRef) ||
        !isValidIsoDate(request.startDate) ||
        !isValidIsoDate(request.endDate) ||
        request.startDate > request.endDate
      ) {
        return Promise.resolve({ outcome: 'rejected', reason: 'invalid_request' });
      }
      const existing = mandates.get(request.operationKey);
      if (existing)
        return Promise.resolve({ outcome: 'ok', value: handOff(existing.providerMandateRef) });
      const providerMandateRef = refFor(request.operationKey);
      mandates.set(request.operationKey, { providerMandateRef, request });
      requests.push(request);
      if (scenario === 'unknown_outcome') {
        return Promise.resolve({ outcome: 'unknown', reason: 'timeout' });
      }
      return Promise.resolve({ outcome: 'ok', value: handOff(providerMandateRef) });
    },
    getMandateStatus(_ctx, query) {
      const entry = findMandate(query);
      if (!entry) return Promise.resolve({ outcome: 'not_found' });
      const n = (lookups.get(entry.providerMandateRef) ?? 0) + 1;
      lookups.set(entry.providerMandateRef, n);
      let status: MandateProviderStatus;
      switch (scenario) {
        case 'rejected':
          status = 'rejected';
          break;
        case 'expired':
          status = 'expired';
          break;
        case 'revoked':
          status = n === 1 ? 'active' : 'revoked';
          break;
        case 'delayed':
          status = n <= 2 ? 'registration_pending' : 'active';
          break;
        case 'unknown_outcome':
          status = n === 1 ? 'registration_pending' : 'active';
          break;
        case 'registered':
        case 'returned_debit':
        case 'contradictory_events':
          status = 'active';
          break;
      }
      return Promise.resolve({
        outcome: 'ok',
        value: {
          source: 'provider_authenticated_lookup',
          providerMandateRef: entry.providerMandateRef,
          rail: entry.request.rail,
          status,
          maxAmountMinor: entry.request.maxAmountMinor,
          merchantRef: entry.request.merchantRef,
          observedAt: MOCK_MANDATE_OBSERVED_AT,
        },
      });
    },
    cancelMandate(_ctx, request) {
      const entry = [...mandates.values()].find(
        (m) => m.providerMandateRef === request.providerMandateRef,
      );
      if (!entry) return Promise.resolve({ outcome: 'not_found' });
      cancelRequests.push(request);
      // A request only. The mandate is cancelled when a verified event or lookup says so.
      return Promise.resolve({
        outcome: 'ok',
        value: {
          kind: 'cancel_requested',
          cancelled: false,
          providerMandateRef: request.providerMandateRef,
        },
      });
    },
    listDebitStatus(_ctx, query) {
      const entry = [...mandates.values()].find(
        (m) => m.providerMandateRef === query.providerMandateRef,
      );
      if (!entry) return Promise.resolve({ outcome: 'not_found' });
      if (!isValidIsoDate(query.from) || !isValidIsoDate(query.to) || query.from > query.to) {
        return Promise.resolve({ outcome: 'rejected', reason: 'invalid_request' });
      }
      if (scenario !== 'registered' && scenario !== 'returned_debit') {
        return Promise.resolve({ outcome: 'ok', value: [] });
      }
      // The sample debit amount never exceeds the mandate maximum; the mock invents no schedule of its own.
      const amountMinor =
        entry.request.maxAmountMinor < SAMPLE_DEBIT_MINOR
          ? entry.request.maxAmountMinor
          : SAMPLE_DEBIT_MINOR;
      return Promise.resolve({
        outcome: 'ok',
        value: [
          {
            providerDebitRef: `MOCK-DEBIT-${entry.providerMandateRef.slice(-12)}-1`,
            providerMandateRef: entry.providerMandateRef,
            scheduledOn: query.from,
            amountMinor,
            status: scenario === 'returned_debit' ? 'returned' : 'scheduled',
            returnCode: scenario === 'returned_debit' ? MOCK_MANDATE_RETURN_CODE : null,
            observedAt: MOCK_MANDATE_OBSERVED_AT,
          },
        ],
      });
    },
  };
}

// ---------------------------------------------------------------------------------------------------------
// Scripted mandate deliveries (signed with the mock webhook scheme; verified by the payment provider's verifier)
// ---------------------------------------------------------------------------------------------------------

export interface MockMandateDeliveryParams {
  readonly secret: string;
  readonly providerMandateRef: string;
  readonly providerDebitRef: string;
  readonly debitAmountMinor: bigint;
  readonly merchantRef: string;
  readonly now: Date;
  readonly idPrefix?: string;
}

/**
 * Deterministic, signed delivery scripts for a mandate scenario. `contradictory_events` delivers `active` and then
 * `rejected` for the same mandate: the later one ranks lower and must never revert the mandate; the database should
 * raise a reconciliation item rather than silently drop it.
 */
export function buildMockMandateDeliveries(
  scenario: MockMandateScenario,
  params: MockMandateDeliveryParams,
): MockDelivery[] {
  const prefix = params.idPrefix ?? 'SAMPLE-MND';
  const nowSeconds = Math.floor(params.now.getTime() / 1000);
  let counter = 0;
  const make = (
    label: string,
    objectKind: 'mandate' | 'debit',
    status: PlatformEventStatus,
    options: { occurredSecondsAgo?: number } = {},
  ): MockDelivery => {
    counter += 1;
    const rawBody = buildMockWebhookBody({
      eventId: `${prefix}-EVT-${String(counter)}`,
      objectKind,
      objectRef: objectKind === 'mandate' ? params.providerMandateRef : params.providerDebitRef,
      orderRef: objectKind === 'debit' ? params.providerMandateRef : undefined,
      status,
      amountMinor: objectKind === 'debit' ? params.debitAmountMinor : null,
      currency: objectKind === 'debit' ? 'INR' : null,
      merchantRef: params.merchantRef,
      occurredAt: new Date((nowSeconds - (options.occurredSecondsAgo ?? 0)) * 1000).toISOString(),
    });
    const headers = signMockWebhook({
      secret: params.secret,
      deliveryId: `${prefix}-DLV-${String(counter)}`,
      timestampSeconds: nowSeconds,
      rawBody,
    });
    return { label, rawBody, headers };
  };
  switch (scenario) {
    case 'registered':
      return [make('pending', 'mandate', 'pending'), make('active', 'mandate', 'active')];
    case 'rejected':
      return [make('rejected', 'mandate', 'rejected')];
    case 'returned_debit':
      return [
        make('active', 'mandate', 'active'),
        make('debit presented', 'debit', 'pending'),
        make('debit returned', 'debit', 'returned'),
      ];
    case 'revoked':
      return [make('active', 'mandate', 'active'), make('revoked', 'mandate', 'revoked')];
    case 'expired':
      return [make('active', 'mandate', 'active'), make('expired', 'mandate', 'expired')];
    case 'delayed':
      return [
        make('active, reported a day late', 'mandate', 'active', { occurredSecondsAgo: 86_400 }),
      ];
    case 'contradictory_events':
      return [
        make('active', 'mandate', 'active'),
        make('rejected after active', 'mandate', 'rejected'),
      ];
    case 'unknown_outcome':
      return [];
  }
}
