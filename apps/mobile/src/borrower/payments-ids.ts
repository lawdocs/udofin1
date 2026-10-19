/** The few places a platform random source may exist. Hermes has `crypto.getRandomValues` in recent React Native; older runtimes do not. */
export interface RandomSource {
  getRandomValues?: (bytes: Uint8Array) => Uint8Array;
}

const platformSource = (): RandomSource | undefined => {
  const candidate = (globalThis as { crypto?: RandomSource }).crypto;
  return typeof candidate?.getRandomValues === 'function' ? candidate : undefined;
};

const HEX = '0123456789abcdef';

/**
 * A random version-4 UUID. The mandate id is chosen by the app (the step-up code is bound to it), so it must be unique and hard
 * to guess. The platform's secure generator is used when it exists; only if it does not, `fallback` (Math.random by default) fills
 * the bytes. The id is an identifier, not a secret: nothing here protects a credential.
 */
export function newUuid(
  source: RandomSource | undefined = platformSource(),
  fallback: () => number = Math.random,
): string {
  const bytes = new Uint8Array(16);
  if (source?.getRandomValues) source.getRandomValues(bytes);
  else for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(fallback() * 256) & 255;
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  let out = '';
  for (let i = 0; i < 16; i += 1) {
    const b = bytes[i] ?? 0;
    out += HEX.charAt(b >> 4) + HEX.charAt(b & 15);
    if (i === 3 || i === 5 || i === 7 || i === 9) out += '-';
  }
  return out;
}

/**
 * An Idempotency-Key for one payment or mandate attempt: 32 hex characters from the same source (the API accepts 16 to 128 of
 * letters, digits and `. _ : -`). Payment keys are scoped per lender in the database, so they must be random, never derived from
 * a loan id.
 */
export function newAttemptKey(
  source: RandomSource | undefined = platformSource(),
  fallback: () => number = Math.random,
): string {
  return `a-${newUuid(source, fallback).replace(/-/g, '')}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Route parameters are untrusted text: an id is used only if it has the shape of a UUID. */
export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && UUID.test(value);

/** expo-router hands a parameter over as text, or as a list when it is repeated; only the first text is used. */
export const firstParam = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;
