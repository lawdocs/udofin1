import { createHmac, timingSafeEqual } from 'node:crypto';
import type { EncryptedBlob, KeyManager } from './key-management.js';

/**
 * Keyed fingerprint of a bank account, for the ownership registry (spec 08 section 7.1).
 *
 * Udofin never stores an account number. To still be able to say "this account is already registered by another
 * organisation" or "this account belongs to Udofin or a group company", the account is reduced to a keyed HMAC
 * (HMAC-SHA256 over a canonical, length-prefixed encoding of the BANK CODE and the account number) plus the
 * last four digits for display. Without the key the fingerprint cannot be reversed or guessed offline; with the key it
 * is deterministic, so equal accounts give equal fingerprints.
 *
 * The bank code is the first four letters of the IFSC, not the whole IFSC: the same account number at the same bank
 * can appear under another branch IFSC (a branch moves or merges, or the lender types another branch), and a
 * registry that hashed the branch would let the same account through twice. Two different accounts at one bank
 * never share an account number, so the cost is nothing. The full IFSC is still validated and is kept elsewhere for
 * display.
 *
 * The account-number format is DATA: the caller passes the `AccountFormatRule` that applies (country, account type,
 * length range, status). Without a valid rule nothing is fingerprinted. A rule whose status is `unverified` still
 * validates, but the result says so (`ruleStatus`), so the registry can see that the format has no source on file.
 *
 * This module:
 *   - never logs, returns or throws the IFSC or account number; error messages are fixed text with a reason CLASS;
 *   - takes its key from the existing key-management port (`loadFingerprintKey`): the key is stored wrapped by the
 *     key manager and unwrapped here, so no raw key sits in configuration or in this module;
 *   - does not generate, rotate or store any key. Provisioning the production key is a separate, authorised step.
 */

export type AccountFingerprintErrorReason =
  'invalid_ifsc' | 'invalid_account_number' | 'invalid_key' | 'invalid_rule';

export class AccountFingerprintError extends Error {
  override readonly name = 'AccountFingerprintError';
  readonly reason: AccountFingerprintErrorReason;
  constructor(reason: AccountFingerprintErrorReason) {
    super(`account fingerprint input rejected: ${reason}`);
    this.reason = reason;
  }
}

/**
 * The account-number format that applies, as data (owner decision of 14 Oct 2026: configurable by country and account
 * type, `unverified` until its source is supplied). Nothing here is a universal banking rule.
 */
export interface AccountFormatRule {
  /** ISO 3166-1 alpha-2. Only `IN` today, because the IFSC is an Indian code. */
  readonly country: string;
  /** For example `bank_account`. Identifies which rule this is; the caller selects the applicable one. */
  readonly accountType: string;
  readonly minDigits: number;
  readonly maxDigits: number;
  /** `verified` needs a `source`. */
  readonly status: 'verified' | 'unverified';
  /** Reference to the bank-format text the range comes from. Null while `unverified`. */
  readonly source: string | null;
}

/**
 * The owner's initial range (9 to 18 digits). An UNVERIFIED assumption, not a text on file. It is a starting value for
 * the configuration that supplies rules, not something this module applies by itself.
 */
export const INITIAL_IN_BANK_ACCOUNT_RULE: AccountFormatRule = {
  country: 'IN',
  accountType: 'bank_account',
  minDigits: 9,
  maxDigits: 18,
  status: 'unverified',
  source: null,
};

/** Key material for fingerprinting. Treat as a secret: never log or serialise it. */
export interface FingerprintKey {
  /** Identifies the key in the key manager (for example `platform/account-fingerprint`). */
  readonly keyId: string;
  /**
   * The version of THIS fingerprint key (not the key manager's master-key version). Recorded next to every
   * fingerprint so that a rotation can be told apart and old rows re-derived deliberately.
   */
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
  /** Whether the account-number rule that validated this account has a source on file. */
  readonly ruleStatus: AccountFormatRule['status'];
  /** `XXXXXX` followed by the last four digits, the same shape the settlement-account table accepts. */
  readonly maskedRef: string;
}

const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const DIGITS = /^[0-9]+$/;
const MIN_KEY_BYTES = 32;
const DOMAIN = 'udofin-account-fingerprint-v2';

/** A rule is usable only if it is well-formed; a missing or malformed rule fails closed. */
function assertRule(rule: AccountFormatRule): void {
  if (
    typeof rule !== 'object' ||
    rule === null ||
    rule.country !== 'IN' ||
    typeof rule.accountType !== 'string' ||
    rule.accountType.length === 0 ||
    !Number.isSafeInteger(rule.minDigits) ||
    !Number.isSafeInteger(rule.maxDigits) ||
    rule.minDigits < 1 ||
    rule.maxDigits < rule.minDigits ||
    rule.maxDigits > 34 ||
    (rule.status !== 'verified' && rule.status !== 'unverified') ||
    (rule.status === 'verified' && (typeof rule.source !== 'string' || rule.source.length === 0))
  ) {
    throw new AccountFingerprintError('invalid_rule');
  }
}

/** Trim, upper-case the IFSC, digits-only account number within the rule's range; anything else is rejected, never repaired. */
export function normaliseAccount(input: AccountInput, rule: AccountFormatRule): AccountInput {
  assertRule(rule);
  const ifsc = typeof input.ifsc === 'string' ? input.ifsc.trim().toUpperCase() : '';
  if (!IFSC.test(ifsc)) throw new AccountFingerprintError('invalid_ifsc');
  const accountNumber = typeof input.accountNumber === 'string' ? input.accountNumber.trim() : '';
  if (
    !DIGITS.test(accountNumber) ||
    accountNumber.length < rule.minDigits ||
    accountNumber.length > rule.maxDigits
  ) {
    throw new AccountFingerprintError('invalid_account_number');
  }
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

export function fingerprintAccount(
  key: FingerprintKey,
  input: AccountInput,
  rule: AccountFormatRule,
): AccountFingerprint {
  if (
    !(key.key instanceof Uint8Array) ||
    key.key.length < MIN_KEY_BYTES ||
    key.keyId.length === 0 ||
    !Number.isSafeInteger(key.keyVersion) ||
    key.keyVersion < 1
  ) {
    throw new AccountFingerprintError('invalid_key');
  }
  const { ifsc, accountNumber } = normaliseAccount(input, rule);
  // Bank code (the first four IFSC letters) and account number identify the account; the branch part does not.
  const fingerprint = createHmac('sha256', key.key)
    .update(lengthPrefixed(DOMAIN, ifsc.slice(0, 4), accountNumber))
    .digest('hex');
  return {
    fingerprint,
    keyVersion: key.keyVersion,
    ruleStatus: rule.status,
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
 * manager under its key reference. `keyVersion` is the version of the FINGERPRINT key, supplied by the caller from
 * wherever the wrapped key is recorded; it is deliberately not the key manager's master-key version (re-wrapping the
 * same key under a new master key must not change the version, and a new fingerprint key under the same master key
 * must). The version is also bound into the encryption context, so a blob wrapped for version 2 cannot be loaded as
 * version 1. Use the same context when wrapping.
 */
export async function loadFingerprintKey(
  keyManager: KeyManager,
  wrapped: EncryptedBlob,
  keyVersion: number,
  context: Readonly<Record<string, string>> = { purpose: 'account-fingerprint' },
): Promise<FingerprintKey> {
  if (!Number.isSafeInteger(keyVersion) || keyVersion < 1) {
    throw new AccountFingerprintError('invalid_key');
  }
  let bytes: Uint8Array;
  try {
    bytes = await keyManager.decrypt(wrapped, {
      ...context,
      fingerprint_key_version: String(keyVersion),
    });
  } catch {
    throw new AccountFingerprintError('invalid_key');
  }
  if (bytes.length < MIN_KEY_BYTES) throw new AccountFingerprintError('invalid_key');
  return { keyId: wrapped.keyRef, keyVersion, key: bytes };
}
