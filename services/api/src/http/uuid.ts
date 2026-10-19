/**
 * The canonical text form of a UUID is lower-case hex, which is what the database returns. A path or body value that passed
 * `z.uuid()` may be written in upper case. Compare through this helper, never with a plain `===`, or the same record is
 * found by one route (SQL casts to uuid) and refused by another.
 */
export function normaliseUuid(value: string): string {
  return value.toLowerCase();
}

/** True when two UUID texts name the same identifier, whatever the letter case of either. */
export function sameUuid(a: string, b: string): boolean {
  return normaliseUuid(a) === normaliseUuid(b);
}
