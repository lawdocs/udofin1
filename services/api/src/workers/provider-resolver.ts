import {
  type AppEnvironment,
  type MandateProviderPort,
  type PaymentProviderPort,
  type ProviderCallContext,
} from '@udofin/adapters';

/**
 * Which provider port to use for a lender's payment configuration. The worker (which alone holds the lender's provider
 * credentials, by NAME of an environment variable or secret) asks this; nothing else in the process builds a provider.
 *
 * Rules (spec 08, sections 7 and 20; CLAUDE.md rule 9):
 *   - No real provider adapter exists (D-65/D-66). The only implementations are the labelled mocks and the unconfigured placeholders.
 *   - A MOCK configuration yields a mock port only in local and test environments (`assertLocalOrTestOnly`); anywhere else it is refused.
 *   - A SANDBOX or LIVE configuration yields the unconfigured placeholder until a real adapter is written and approved: every call
 *     answers `not_configured`, never a made-up success.
 *   - A secret is read by name when a port needs it and never logged, stored or put in an error.
 */
export interface PaymentConfigRow {
  readonly configId: string;
  readonly lenderOrgId: string;
  /** The provider key from the provider register. */
  readonly provider: string;
  readonly providerMode: 'mock' | 'sandbox' | 'live';
  /** The lender's own merchant reference from the verified merchant registry (a reference, not a secret). */
  readonly merchantRef: string;
  /** NAMES of secrets (never values). */
  readonly secretRef: string;
  readonly webhookSecretRef: string;
}

export type ResolveFailure = 'provider_not_configured' | 'mock_not_allowed_here' | 'secret_missing';

export type Resolved<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: ResolveFailure };

export interface ResolvedPort<P> {
  readonly port: P;
  /** The call context for one operation: the lender is the tenant; the idempotency key is the intent or mandate id. */
  contextFor(correlationId: string, idempotencyKey?: string): ProviderCallContext;
}

export interface ProviderResolver {
  payment(config: PaymentConfigRow): Resolved<ResolvedPort<PaymentProviderPort>>;
  mandate(config: PaymentConfigRow): Resolved<ResolvedPort<MandateProviderPort>>;
}

export interface ProviderResolverDeps {
  readonly environment: AppEnvironment;
  /** Resolves the NAME of a secret to its value. Never logged. */
  secret(name: string): string | undefined;
}

/** Wave 5 (builder W1) replaces this body. Until then nothing is configured, which is the honest answer. */
export function createProviderResolver(_deps: ProviderResolverDeps): ProviderResolver {
  return {
    payment: () => ({ ok: false, reason: 'provider_not_configured' }),
    mandate: () => ({ ok: false, reason: 'provider_not_configured' }),
  };
}
