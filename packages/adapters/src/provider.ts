/**
 * Common vocabulary for provider adapters (KYC, bureau, eSign, payments, LMS, ...).
 *
 * Every adapter declares whether it is a mock, a provider sandbox or a live production
 * integration. The environment guard below makes it impossible to run a mock in production
 * or to send test traffic to a live provider. Port interfaces per capability are added in
 * the phase that first uses them (see docs/integrations/register.md).
 */

export type AppEnvironment = 'local' | 'test' | 'staging' | 'production';

export type ProviderMode = 'mock' | 'sandbox' | 'production';

export type ProviderCapability =
  | 'kyc'
  | 'pan_verification'
  | 'bank_account_verification'
  | 'credit_bureau'
  | 'account_aggregator'
  | 'esign'
  | 'estamp'
  | 'payment_collection'
  | 'mandate'
  | 'payout'
  | 'securities_pledge'
  | 'lms'
  | 'accounting_export'
  | 'sms'
  | 'email'
  | 'push'
  | 'object_storage'
  | 'dispute_resolution'
  | 'compliance_feed'
  | 'ai_inference'
  | 'device_integrity';

export interface ProviderDescriptor {
  /** Stable key, e.g. `surepass`, `razorpay`, `finbyx`, `mock_kyc`. */
  readonly key: string;
  readonly capability: ProviderCapability;
  readonly mode: ProviderMode;
}

/** Context passed on every provider call so results can be attributed, consented and replayed safely. */
export interface ProviderCallContext {
  /** Lender (tenant) on whose behalf and under whose credentials the call is made. */
  readonly tenantId: string;
  readonly correlationId: string;
  /** Required for any call that creates or moves something; providers must honour it on retry. */
  readonly idempotencyKey?: string;
  /** Consent record authorising this processing, where the purpose requires consent. */
  readonly consentRecordId?: string;
}

export class ProviderNotAllowedError extends Error {
  override readonly name = 'ProviderNotAllowedError';
}

const ALLOWED_MODES: Readonly<Record<AppEnvironment, readonly ProviderMode[]>> = {
  local: ['mock', 'sandbox'],
  test: ['mock'],
  staging: ['mock', 'sandbox'],
  production: ['production'],
};

/** Throws unless `provider` may be used in `environment`. Call when wiring adapters at start-up. */
export function assertProviderAllowed(
  provider: ProviderDescriptor,
  environment: AppEnvironment,
): void {
  if (!ALLOWED_MODES[environment].includes(provider.mode)) {
    throw new ProviderNotAllowedError(
      `${provider.capability} provider "${provider.key}" in ${provider.mode} mode is not allowed in ${environment}`,
    );
  }
}
