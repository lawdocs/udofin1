import { createHmac, timingSafeEqual } from 'node:crypto';
import type { EncryptedBlob, KeyManager } from './key-management.js';

/**
 * Keyed fingerprint of a bank account, for the ownership registry (spec 08 section 7.1).
 *
 * Udofin never stores an account number. To still be able to say "this account is already registered by another
 * organisation" or "this account belongs to Udofin or a group company", the account is reduced to a keyed HMAC
 * (HMAC-SHA256 over a canonical, length-prefixed encoding of the normalised IFSC and account number) plus the
 * last four digits for display. Without the key the fingerprint cannot be reversed or guessed offline; with the key it
 * is deterministic, so equal accounts give equal fingerprints.
 *
 * This module:
 *   - never logs, returns or throws the IFSC or account number; error messages are fixed text with a reason CLASS;
 *   - takes its key from the existing key-management port (`loadFingerprintKey`): the key is stored wrapped by the
 *     key manager and unwrapped here, so no raw key sits in configuration or in this module;
 *   - does not generate, rotate or store any key. Provisioning the production key is a separate, authorised step.
 */

export type AccountFingerprintErrorReason =
  'invalid_ifsc' | 'invalid_account_number' | 'invalid_key';

export class AccountFingerprintError extends Error {
  override readonly name = 'AccountFingerprintError';
  readonly reason: AccountFingerprintErrorReason;
  constructor(reason: AccountFingerprintErrorReason) {
    super(`account fingerprint input rejected: ${reason}`);
    this.reason = reason;
  }
}

/** Key material for fingerprinting. Treat as a secret: never log or serialise it. */
export interface FingerprintKey {
  /** Identifies the key in the key manager (for example `platform/account-fingerprint`). */
  readonly keyId: string;
  /** Recorded next to every fingerprint so that a rotation can be told apart and old rows re-derived deliberately. */
  readonly keyVersion: number;
  readonly key: Uint8Array;
}

export interface AccountInput {
  readonly ifsc: string;
  readonly accountNumber: string;
}

export interface AccountFingerprint {
  /** 64 lowercase hex characters. */
  readonly fingerprint: string;
  readonly keyVersion: number;
  /** `XXXXXX` followed by the last four digits, the same shape the settlement-account table accepts. */
  readonly maskedRef: string;
}

const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const ACCOUNT_NUMBER = /^[0-9]{9,18}$/;
const MIN_KEY_BYTES = 32;
const DOMAIN = 'udofin-account-fingerprint-v1';

/** Trim, upper-case the IFSC, digits-only account number; anything malformed is rejected, never repaired. */
export function normaliseAccount(input: AccountInput): AccountInput {
  const ifsc = typeof input.ifsc === 'string' ? input.ifsc.trim().toUpperCase() : '';
  if (!IFSC.test(ifsc)) throw new AccountFingerprintError('invalid_ifsc');
  const accountNumber = typeof input.accountNumber === 'string' ? input.accountNumber.trim() : '';
  if (!ACCOUNT_NUMBER.test(accountNumber))
    throw new AccountFingerprintError('invalid_account_number');
  return { ifsc, accountNumber };
}

/** 4-byte big-endian length followed by the UTF-8 bytes, so ("AB","C") and ("A","BC") can never collide. */
function lengthPrefixed(...parts: readonly string[]): Buffer {
  return Buffer.concat(
    parts.map((part) => {
      const bytes = Buffer.from(part, 'utf8');
      const length = Buffer.alloc(4);
      length.writeUInt32BE(bytes.length);
      return Buffer.concat([length, bytes]);
    }),
  );
}

export function fingerprintAccount(key: FingerprintKey, input: AccountInput): AccountFingerprint {
  if (
    !(key.key instanceof Uint8Array) ||
    key.key.length < MIN_KEY_BYTES ||
    key.keyId.length === 0 ||
    !Number.isSafeInteger(key.keyVersion) ||
    key.keyVersion < 1
  ) {
    throw new AccountFingerprintError('invalid_key');
  }
  const { ifsc, accountNumber } = normaliseAccount(input);
  const fingerprint = createHmac('sha256', key.key)
    .update(lengthPrefixed(DOMAIN, ifsc, accountNumber))
    .digest('hex');
  return {
    fingerprint,
    keyVersion: key.keyVersion,
    maskedRef: `XXXXXX${accountNumber.slice(-4)}`,
  };
}

/** Constant-time comparison of two fingerprints. Anything that is not 64 hex characters never matches. */
export function fingerprintsEqual(a: string, b: string): boolean {
  const hex = /^[0-9a-f]{64}$/;
  if (!hex.test(a) || !hex.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/**
 * Unwraps the fingerprint key through the key-management port. `wrapped` is the key stored encrypted by the key
 * manager under its key reference; its key version becomes the fingerprint key version.
 */
export async function loadFingerprintKey(
  keyManager: KeyManager,
  wrapped: EncryptedBlob,
  context: Readonly<Record<string, string>> = { purpose: 'account-fingerprint' },
): Promise<FingerprintKey> {
  let bytes: Uint8Array;
  try {
    bytes = await keyManager.decrypt(wrapped, context);
  } catch {
    throw new AccountFingerprintError('invalid_key');
  }
  if (bytes.length < MIN_KEY_BYTES) throw new AccountFingerprintError('invalid_key');
  return { keyId: wrapped.keyRef, keyVersion: wrapped.keyVersion, key: bytes };
}
