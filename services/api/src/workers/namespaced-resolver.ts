import { secretNamesInNamespace, secretNamespaceOf } from '../system/secret-namespace.js';
import {
  type PaymentConfigRow,
  type ProviderResolver,
  type ResolvedPort,
  type Resolved,
} from './provider-resolver.js';

/**
 * Puts the lender's secret namespace in front of a provider resolver (review finding U51).
 *
 * The resolver reads the secret a configuration names (by NAME) when it builds a real provider port. This wrapper refuses to let
 * it do that unless both names of the configuration are inside the namespace of the configuration's own lender; otherwise the
 * answer is the same closed reason the resolver gives for a secret that is not there, `secret_missing`, and the environment is
 * not read at all. The namespace is derived from the lender id exactly as the database derives it
 * (`private.secret_ref_prefix`), which is also what `secret_namespace` on the configuration must equal.
 *
 * A mock configuration reads no secret (the resolver never asks for one), so it is passed through unchanged: a mock exists in
 * local development and tests only, and refusing its fixture names would break them for no gain.
 *
 * Nothing is logged here and no name or value is put in the answer.
 */
export function withLenderSecretNamespace(inner: ProviderResolver): ProviderResolver {
  const allowed = (config: PaymentConfigRow): boolean => {
    if (config.providerMode === 'mock') return true;
    const namespace = secretNamespaceOf(config.lenderOrgId);
    // The worker's row does not carry `secret_namespace`, so the lender's own namespace stands for it here: what is checked is that
    // both names lie inside the namespace of THIS lender. (The database ties the stored namespace to the names by a check
    // constraint, and the callback receiver checks the stored value itself; see system/provider-hooks.ts.)
    return secretNamesInNamespace({
      storedNamespace: namespace,
      expectedNamespace: namespace,
      secretRef: config.secretRef,
      webhookSecretRef: config.webhookSecretRef,
    });
  };
  const refused = <P>(): Resolved<ResolvedPort<P>> => ({ ok: false, reason: 'secret_missing' });
  return {
    payment: (config) => (allowed(config) ? inner.payment(config) : refused()),
    mandate: (config) => (allowed(config) ? inner.mandate(config) : refused()),
  };
}
