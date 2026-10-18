/**
 * The namespace of a lender's secrets (review finding U51).
 *
 * A payment configuration names the secrets it uses (the provider credential and the webhook signing secret) by NAME, and the
 * worker and the callback receiver resolve those names from the process environment. A name chosen by a lender must never be
 * able to reach a secret that is not that lender's: another lender's credential, or a platform secret such as the database
 * login. The database therefore only lets a lender draft names inside its own namespace (`payments.secret_ref_prefix`: `L`, the
 * last twelve hexadecimal digits of the lender id in capitals, and an underscore), and records that namespace on the
 * configuration (`secret_namespace`). The resolvers repeat the check here, because a row can be written by a path that does not
 * go through the draft function (a fixture, a repair, a future change):
 *
 *   a secret is READ only when the configuration's `secret_namespace` is set, equals the prefix of the configuration's lender,
 *   and both secret names start with it. Any other name resolves to nothing, and nothing is read from the environment for it.
 *
 * Nothing here logs or returns a secret name or value; a refusal is a closed reason chosen by the caller.
 */

/** `L` + twelve capital hexadecimal digits + `_`: what `private.secret_ref_prefix` returns. */
const NAMESPACE = /^L[0-9A-F]{12}_$/;
/** A secret name inside some lender namespace, as `payments.draft_payment_config` accepts it. */
const LENDER_SECRET_NAME = /^L[0-9A-F]{12}_[A-Z][A-Z0-9_]{1,48}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Stands in for a secret name that must not be read. It is not a name any environment holds, so a reader answers nothing for it
 * and the caller's "secret not configured" path runs.
 */
export const NO_SECRET_NAME = '';

/** The namespace of a lender, derived from its id exactly as the database derives it. Undefined for anything that is not a UUID. */
export function secretNamespaceOf(lenderOrgId: string): string | undefined {
  if (!UUID.test(lenderOrgId)) return undefined;
  return `L${lenderOrgId.replaceAll('-', '').slice(-12).toUpperCase()}_`;
}

export interface SecretNamespaceFacts {
  /** The `secret_namespace` stored on the configuration; null for a row written before the rule. */
  readonly storedNamespace: string | null | undefined;
  /** The namespace of the configuration's lender: `private.secret_ref_prefix(lender_org_id)` or `secretNamespaceOf(lender)`. */
  readonly expectedNamespace: string | null | undefined;
  readonly secretRef: string;
  readonly webhookSecretRef: string;
}

/** True only when every condition holds. Anything missing, malformed or different is false. */
export function secretNamesInNamespace(facts: SecretNamespaceFacts): boolean {
  const { storedNamespace, expectedNamespace, secretRef, webhookSecretRef } = facts;
  if (typeof storedNamespace !== 'string' || !NAMESPACE.test(storedNamespace)) return false;
  if (typeof expectedNamespace !== 'string' || expectedNamespace !== storedNamespace) return false;
  return (
    typeof secretRef === 'string' &&
    typeof webhookSecretRef === 'string' &&
    secretRef.startsWith(storedNamespace) &&
    webhookSecretRef.startsWith(storedNamespace)
  );
}

export type SecretReader = (name: string) => string | undefined;
export type SecretEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * Reads a value from the environment only for the names given and for names inside a lender namespace; every other name is
 * answered with nothing WITHOUT touching the environment. Own properties only, so a name such as `constructor` can never reach
 * an inherited member.
 *
 * `platformNames` are the platform's own secrets the same process needs (for example the key that protects client addresses).
 * They must not be shaped like a lender name: a platform secret named `L` + twelve hexadecimal digits + `_` would be readable
 * by that lender's configuration, so such a name is refused here too.
 */
export function createSecretReader(
  env: SecretEnvironment,
  platformNames: readonly string[] = [],
): SecretReader {
  for (const name of platformNames) {
    if (LENDER_SECRET_NAME.test(name) || NAMESPACE.test(name.slice(0, 14))) {
      throw new Error('a platform secret must not be named inside a lender namespace');
    }
  }
  const platform = new Set(platformNames);
  return (name) => {
    if (typeof name !== 'string' || name.length === 0) return undefined;
    if (!platform.has(name) && !LENDER_SECRET_NAME.test(name)) return undefined;
    return Object.hasOwn(env, name) ? env[name] : undefined;
  };
}
