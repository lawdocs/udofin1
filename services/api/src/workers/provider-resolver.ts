import {
  assertLocalOrTestOnly,
  createMockMandateProvider,
  createMockPaymentProvider,
  createUnconfiguredMandateProvider,
  createUnconfiguredPaymentProvider,
  MOCK_PAYMENT_PROVIDER_KEY,
  withMandateTimeout,
  withPaymentTimeout,
  type AppEnvironment,
  type MandateProviderPort,
  type PaymentProviderPort,
  type ProviderCallContext,
  type ProviderDescriptor,
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
  /**
   * Bound on every provider call, in milliseconds (default 15 000). Every port the resolver hands out is wrapped with it, so a port that
   * never answers cannot hold a worker job: the call ends as an unknown outcome (timeout), which the callers already treat as "look it up".
   */
  readonly providerTimeoutMs?: number;
}

const DEFAULT_PROVIDER_TIMEOUT_MS = 15_000;

/**
 * A real adapter for one provider key (`sandbox` or `live` mode). NONE EXISTS TODAY: the registry below is empty and a real
 * adapter needs a provider specification, a contract and owner approval first (D-65/D-66). The shape is here so that adding
 * one cannot skip the two rules this file enforces: the secret is read by NAME and its absence is a refusal, and the secret
 * never leaves the factory.
 */
export interface RealAdapterFactories {
  /** `secret` is the value the configuration's `secretRef` names; the factory keeps it in a closure and nowhere else. */
  readonly payment?: (secret: string, config: PaymentConfigRow) => PaymentProviderPort;
  readonly mandate?: (secret: string, config: PaymentConfigRow) => MandateProviderPort;
}

/** Provider key to its real adapter. Empty on purpose: no provider is contracted, specified or approved. */
const NO_REAL_ADAPTERS: Readonly<Record<string, RealAdapterFactories>> = {};

const contextOf =
  (lenderOrgId: string) =>
  (correlationId: string, idempotencyKey?: string): ProviderCallContext => ({
    tenantId: lenderOrgId,
    correlationId,
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  });

const MODES: readonly string[] = ['mock', 'sandbox', 'live'];

/** A configuration row that cannot name a provider or a mode is not a configuration: nothing is guessed from it. */
function isUsable(config: PaymentConfigRow): boolean {
  return config.provider.length > 0 && MODES.includes(config.providerMode);
}

/**
 * Same as `createProviderResolver` with the real-adapter registry supplied. Production code calls `createProviderResolver`
 * (empty registry); this exists so the secret rules can be tested before any real adapter exists.
 */
export function createProviderResolverWith(
  deps: ProviderResolverDeps,
  adapters: Readonly<Record<string, RealAdapterFactories>>,
): ProviderResolver {
  // A mock keeps its scripted state (orders it created, how often it was asked) for as long as the process runs, so a retried
  // delivery of the same outbox event meets the same "provider" it met the first time. One instance per configuration.
  const mockPayments = new Map<string, PaymentProviderPort>();
  const mockMandates = new Map<string, MandateProviderPort>();
  const timeoutMs = deps.providerTimeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;

  function resolve<P>(
    config: PaymentConfigRow,
    mockDescriptor: ProviderDescriptor,
    mock: () => P,
    placeholder: () => P,
    cache: Map<string, P>,
    real: ((secret: string, config: PaymentConfigRow) => P) | undefined,
    bound: (port: P, milliseconds: number) => P,
  ): Resolved<ResolvedPort<P>> {
    if (!isUsable(config)) return { ok: false, reason: 'provider_not_configured' };
    const wrap = (port: P): Resolved<ResolvedPort<P>> => ({
      ok: true,
      value: { port, contextFor: contextOf(config.lenderOrgId) },
    });

    if (config.providerMode === 'mock') {
      const cached = cache.get(config.configId);
      if (cached) return wrap(cached);
      try {
        // Stated here and again inside the mock constructors: a mock exists in local development and tests only. Staging
        // and production refuse it, and the thrown message is not passed on (a closed reason is all a caller needs).
        assertLocalOrTestOnly(
          mockDescriptor,
          deps.environment,
          `mock ${mockDescriptor.capability} provider`,
        );
        const port = bound(mock(), timeoutMs);
        cache.set(config.configId, port);
        return wrap(port);
      } catch {
        return { ok: false, reason: 'mock_not_allowed_here' };
      }
    }

    // sandbox / live: a real adapter if one is registered for the provider, else the placeholder that refuses every call.
    if (real === undefined) return wrap(bound(placeholder(), timeoutMs));
    const secret = deps.secret(config.secretRef);
    if (secret === undefined || secret.length === 0) return { ok: false, reason: 'secret_missing' };
    try {
      return wrap(bound(real(secret, config), timeoutMs));
    } catch {
      // A factory that throws may have put the secret in its message. Say only that the provider is not usable.
      return { ok: false, reason: 'provider_not_configured' };
    }
  }

  return {
    payment: (config) =>
      resolve<PaymentProviderPort>(
        config,
        { key: MOCK_PAYMENT_PROVIDER_KEY, capability: 'payment_collection', mode: 'mock' },
        () => createMockPaymentProvider(deps.environment),
        createUnconfiguredPaymentProvider,
        mockPayments,
        adapters[config.provider]?.payment,
        withPaymentTimeout,
      ),
    mandate: (config) =>
      resolve<MandateProviderPort>(
        config,
        { key: 'mock_mandate_provider', capability: 'mandate', mode: 'mock' },
        () => createMockMandateProvider(deps.environment),
        createUnconfiguredMandateProvider,
        mockMandates,
        adapters[config.provider]?.mandate,
        withMandateTimeout,
      ),
  };
}

export function createProviderResolver(deps: ProviderResolverDeps): ProviderResolver {
  return createProviderResolverWith(deps, NO_REAL_ADAPTERS);
}
