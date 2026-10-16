import { inspect } from 'node:util';
import {
  assertProviderAllowed,
  loadFingerprintKey,
  type AccountInput,
  type AppEnvironment,
  type EncryptedBlob,
  type FingerprintKey,
  type KeyManager,
} from '@udofin/adapters';

/**
 * Where the account-fingerprint keys come from. The routes never see a raw key in configuration: a key is stored WRAPPED by the
 * key-management port and unwrapped on first use. `undefined` means this process holds no key for that fingerprint key version,
 * and the registration route answers 503 `key_management_unavailable` (fail closed).
 */
export interface FingerprintKeySource {
  keyFor(keyVersion: number): Promise<FingerprintKey | undefined>;
}

/**
 * Builds a source over a key manager and the wrapped keys by fingerprint key version. The key manager must be allowed in this
 * environment (the labelled local manager exists only in local and test: `assertProviderAllowed` and the manager's own
 * constructor refuse it in staging and production), so elsewhere no source can be built and the route stays unavailable.
 */
export function createFingerprintKeySource(input: {
  environment: AppEnvironment;
  keyManager: KeyManager;
  wrapped: Readonly<Record<number, EncryptedBlob>>;
}): FingerprintKeySource {
  assertProviderAllowed(input.keyManager.descriptor, input.environment);
  const loaded = new Map<number, Promise<FingerprintKey | undefined>>();
  return {
    keyFor(keyVersion) {
      const blob = input.wrapped[keyVersion];
      if (!blob) return Promise.resolve(undefined);
      let pending = loaded.get(keyVersion);
      if (!pending) {
        pending = loadFingerprintKey(input.keyManager, blob, keyVersion).catch(() => undefined);
        loaded.set(keyVersion, pending);
      }
      return pending;
    },
  };
}

/**
 * Holds the bank account number and IFSC of ONE registration request from the moment the request body is parsed until the
 * fingerprint has been computed. It is built so that nothing which serialises, hashes, prints or inspects it can see the
 * values: the digits live in private fields, `toJSON` and the Node inspector show only the bank code, the length and the last
 * four digits (the masked reference, which the registry stores anyway), and `wipe()` empties the fields as soon as the
 * handler is done. The idempotency layer hashes the parsed body, so this also keeps the number out of the stored request hash.
 *
 * JavaScript strings cannot be overwritten in memory; what this guarantees is that no logger, error mapper, serialiser or
 * idempotency record reaches the number, and that the reference is dropped when the request ends.
 */
export class AccountSecret {
  readonly bankCode: string;
  readonly digits: number;
  readonly lastFour: string;
  #accountNumber: string;
  #ifsc: string;

  constructor(accountNumber: string, ifsc: string) {
    this.#accountNumber = accountNumber;
    this.#ifsc = ifsc;
    this.bankCode = ifsc.slice(0, 4).toUpperCase();
    this.digits = accountNumber.length;
    this.lastFour = accountNumber.slice(-4);
  }

  /** The values, for the one call that fingerprints them. Throws once the secret has been wiped. */
  reveal(): AccountInput {
    if (this.#accountNumber === '') throw new Error('account details were already dropped');
    return { ifsc: this.#ifsc, accountNumber: this.#accountNumber };
  }

  wipe(): void {
    this.#accountNumber = '';
    this.#ifsc = '';
  }

  toJSON(): { bankCode: string; digits: number; lastFour: string } {
    return { bankCode: this.bankCode, digits: this.digits, lastFour: this.lastFour };
  }

  [inspect.custom](): string {
    return 'AccountSecret [redacted]';
  }
}
