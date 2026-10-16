import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Seals and opens a provider hand-off link (a payment checkout link or a mandate authorisation link).
 *
 * A hand-off link is a BEARER SECRET: whoever holds it can complete the payment or the mandate. It is never stored in clear, never
 * logged and never put in an event. The worker holds the lender's provider credentials and creates the link; the public API does
 * not, yet it must show the link to the borrower. The link therefore travels through the database ONLY as ciphertext
 * (`payments.handoff_links`), sealed with AES-256-GCM under a key that never enters the database. The associated data names the
 * subject, so a stored blob cannot be moved to another payment, mandate or lender.
 *
 * Wire format: nonce (12 bytes) || ciphertext || authentication tag (16 bytes). A fresh random nonce is used for every seal.
 */

export type HandoffKind = 'payment_intent' | 'mandate';

export interface HandoffContext {
  readonly kind: HandoffKind;
  /** The payment intent id or the mandate id. */
  readonly subjectId: string;
  /** The lender the subject belongs to. */
  readonly lenderOrgId: string;
}

export interface HandoffKeyring {
  /** The version used to seal new links. */
  readonly activeVersion: string;
  /** Every version that may still open a stored link (an old version stays until its links have expired). */
  readonly keys: ReadonlyMap<string, Uint8Array>;
}

export class HandoffVaultError extends Error {
  override readonly name = 'HandoffVaultError';
  constructor(readonly reason: 'config' | 'link_invalid' | 'unknown_key_version' | 'cannot_open') {
    // Never carries a key, a link or a subject: the reason is a closed word.
    super(`hand-off vault: ${reason}`);
  }
}

const KEY_VERSION = /^[A-Za-z0-9._-]{1,40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
/** A link is a URL the provider's flow understands: the hosted page (https) or a UPI intent (upi). No whitespace or control characters. */
const LINK = /^(https:\/\/|upi:\/\/)[^\s\u0000-\u001f\u007f]{4,4000}$/;
/** The same bounds as the database check on `payments.handoff_links.ciphertext`. */
export const HANDOFF_MIN_CIPHERTEXT_BYTES = 29;
export const HANDOFF_MAX_CIPHERTEXT_BYTES = 8192;

function aad(ctx: HandoffContext): Buffer {
  if (
    (ctx.kind !== 'payment_intent' && ctx.kind !== 'mandate') ||
    !UUID.test(ctx.subjectId) ||
    !UUID.test(ctx.lenderOrgId)
  ) {
    throw new HandoffVaultError('link_invalid');
  }
  return Buffer.from(
    `udofin-handoff-v1|${ctx.kind}|${ctx.subjectId.toLowerCase()}|${ctx.lenderOrgId.toLowerCase()}`,
    'utf8',
  );
}

/**
 * Reads the keyring from configuration: `keysJson` is a JSON object of version to base64 key (32 bytes each), `activeVersion` names
 * the one used for new links. Returns undefined when neither is set (links cannot be created or shown). Error messages name the
 * problem and never echo a key.
 */
export function parseHandoffKeyring(
  keysJson: string | undefined,
  activeVersion: string | undefined,
): HandoffKeyring | undefined {
  if (!keysJson && !activeVersion) return undefined;
  if (!keysJson || !activeVersion) throw new HandoffVaultError('config');
  let raw: unknown;
  try {
    raw = JSON.parse(keysJson);
  } catch {
    throw new HandoffVaultError('config');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new HandoffVaultError('config');
  }
  const keys = new Map<string, Uint8Array>();
  for (const [version, value] of Object.entries(raw)) {
    if (!KEY_VERSION.test(version) || typeof value !== 'string') {
      throw new HandoffVaultError('config');
    }
    const bytes = Buffer.from(value, 'base64');
    // Buffer.from is lenient: require an exact round trip so a truncated or mistyped key is refused.
    if (bytes.length !== 32 || bytes.toString('base64') !== value) {
      throw new HandoffVaultError('config');
    }
    keys.set(version, new Uint8Array(bytes));
  }
  if (!KEY_VERSION.test(activeVersion) || !keys.has(activeVersion)) {
    throw new HandoffVaultError('config');
  }
  return { activeVersion, keys };
}

/** Seals a link for the subject. The result is what `payments.store_handoff_link` stores. */
export function sealHandoffLink(
  keyring: HandoffKeyring,
  ctx: HandoffContext,
  link: string,
): { keyVersion: string; ciphertext: Buffer } {
  if (!LINK.test(link)) throw new HandoffVaultError('link_invalid');
  const key = keyring.keys.get(keyring.activeVersion);
  if (!key) throw new HandoffVaultError('config');
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad(ctx));
  const body = Buffer.concat([cipher.update(link, 'utf8'), cipher.final()]);
  const ciphertext = Buffer.concat([nonce, body, cipher.getAuthTag()]);
  if (
    ciphertext.length < HANDOFF_MIN_CIPHERTEXT_BYTES ||
    ciphertext.length > HANDOFF_MAX_CIPHERTEXT_BYTES
  ) {
    throw new HandoffVaultError('link_invalid');
  }
  return { keyVersion: keyring.activeVersion, ciphertext };
}

/** Opens a stored link for the subject it was sealed for. Any failure (wrong key, wrong subject, tampering) is `cannot_open`. */
export function openHandoffLink(
  keyring: HandoffKeyring,
  ctx: HandoffContext,
  keyVersion: string,
  ciphertext: Uint8Array,
): string {
  const key = keyring.keys.get(keyVersion);
  if (!key) throw new HandoffVaultError('unknown_key_version');
  if (
    ciphertext.length < HANDOFF_MIN_CIPHERTEXT_BYTES ||
    ciphertext.length > HANDOFF_MAX_CIPHERTEXT_BYTES
  ) {
    throw new HandoffVaultError('cannot_open');
  }
  const buffer = Buffer.from(ciphertext);
  const nonce = buffer.subarray(0, NONCE_BYTES);
  const tag = buffer.subarray(buffer.length - TAG_BYTES);
  const body = buffer.subarray(NONCE_BYTES, buffer.length - TAG_BYTES);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad(ctx));
    decipher.setAuthTag(tag);
    const link = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
    // A stored value that no longer looks like a link is never handed on.
    if (!LINK.test(link)) throw new HandoffVaultError('cannot_open');
    return link;
  } catch (error) {
    if (error instanceof HandoffVaultError) throw error;
    throw new HandoffVaultError('cannot_open');
  }
}
