import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { assertProviderAllowed, type AppEnvironment, type ProviderDescriptor } from './provider.js';

/**
 * Per-lender encryption behind a port. Phase 06 stores no lender-owned artefact (KYC results, bureau reports and
 * the like stay with the lender), so nothing in the application calls this yet; it exists so that the first feature
 * that must hold such an artefact briefly has a defined, replaceable boundary and per-lender key references.
 *
 * The only adapter is a LOCAL DEVELOPMENT/TEST adapter. It is not production key management: its master key is
 * a process secret, there is no hardware protection, audit or separation of duties. A production adapter (AWS KMS in
 * Mumbai) is written when that environment exists and is approved. Nothing here generates or rotates a production key.
 */
export interface EncryptedBlob {
  /** Opaque key reference, for example `lender/<lender id>`. Different lenders use different references. */
  keyRef: string;
  keyVersion: number;
  algorithm: 'AES-256-GCM';
  iv: string;
  ciphertext: string;
  tag: string;
}

export interface KeyManager {
  readonly descriptor: ProviderDescriptor;
  encrypt(input: {
    keyRef: string;
    plaintext: Uint8Array;
    context: Readonly<Record<string, string>>;
  }): Promise<EncryptedBlob>;
  decrypt(blob: EncryptedBlob, context: Readonly<Record<string, string>>): Promise<Uint8Array>;
}

const contextBytes = (context: Readonly<Record<string, string>>): Buffer =>
  Buffer.from(JSON.stringify(Object.entries(context).sort(([a], [b]) => (a < b ? -1 : 1))), 'utf8');

/** Development/test only: refused in staging and production. `versions` lets old blobs be read after a rotation. */
export function createLocalKeyManager(
  environment: AppEnvironment,
  masterKeys: Readonly<Record<number, string>>,
  currentVersion: number,
): KeyManager {
  const descriptor: ProviderDescriptor = {
    key: 'local_dev_key_manager',
    capability: 'key_management',
    mode: 'mock',
  };
  assertProviderAllowed(descriptor, environment);
  if (environment === 'staging')
    throw new Error('the local key manager is for local development and tests only');
  const master = (version: number): Buffer => {
    const value = masterKeys[version];
    if (!value) throw new Error(`no key material for version ${String(version)}`);
    const bytes = Buffer.from(value, 'base64');
    if (bytes.length < 32) throw new Error('master key must be at least 32 bytes (base64)');
    return bytes;
  };
  const derive = (keyRef: string, version: number): Buffer =>
    Buffer.from(
      hkdfSync(
        'sha256',
        master(version),
        Buffer.from(keyRef, 'utf8'),
        Buffer.from('udofin-local-key-v1'),
        32,
      ),
    );
  master(currentVersion); // fail at start-up, not at first use
  return {
    descriptor,
    encrypt({ keyRef, plaintext, context }) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', derive(keyRef, currentVersion), iv);
      cipher.setAAD(contextBytes({ ...context, keyRef }));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return Promise.resolve({
        keyRef,
        keyVersion: currentVersion,
        algorithm: 'AES-256-GCM' as const,
        iv: iv.toString('base64'),
        ciphertext: ciphertext.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
      });
    },
    decrypt(blob, context) {
      try {
        const decipher = createDecipheriv(
          'aes-256-gcm',
          derive(blob.keyRef, blob.keyVersion),
          Buffer.from(blob.iv, 'base64'),
        );
        decipher.setAAD(contextBytes({ ...context, keyRef: blob.keyRef }));
        decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
        return Promise.resolve(
          new Uint8Array(
            Buffer.concat([
              decipher.update(Buffer.from(blob.ciphertext, 'base64')),
              decipher.final(),
            ]),
          ),
        );
      } catch {
        return Promise.reject(new Error('decryption failed'));
      }
    },
  };
}
