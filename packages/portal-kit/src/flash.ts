import { LP_BANK_CREDIT_MAX_ROWS } from '@udofin/contracts';

/**
 * The success notice of the last action ("your action was recorded", the counts of a bank-credit upload, the decision of a
 * feature request, the entry that was just registered).
 *
 * It used to travel in the page address (`done=1`, `inserted=2000`, `result=applied`). An address can be written by anybody, so a
 * crafted link showed a confirmation of something that never happened. The notice is now written by the server action, in a
 * short-lived cookie, and only after the API accepted the change. A link cannot set a cookie in the reader's browser, so a
 * notice that arrives this way is true: it was written by this portal, for this page, a few seconds ago.
 *
 * The cookie is HttpOnly and SameSite=Strict (and `__Host-` prefixed on HTTPS), lives for twenty seconds, and holds only a path,
 * a time and the closed values below. Nothing a person typed, no name, no number and no server text is ever part of it.
 * A page cannot delete a cookie while it renders, so the notice is time-limited rather than cleared on read; it is shown only on
 * the page it was written for.
 *
 * Failures are not covered here: an error code in the address is a closed code that is mapped to a fixed sentence, and a forged
 * one can only claim that something did not work.
 */
export interface Flash {
  /** The page the action returned to: a path with no query. The notice is shown on that page and nowhere else. */
  path: string;
  /** The outcome counts of a bank-credit upload. */
  counts?: { inserted: number; duplicates: number };
  /** The decision a feature request ended in (a short lower-case code, mapped to words by the screen). */
  result?: string;
  /** The identifier of the registry entry that was just registered. */
  registered?: string;
  /** The server said that the file just sent had been received before, so the page shows the earlier result. */
  existing?: true;
}

export const FLASH_TTL_SECONDS = 20;
const TTL_MS = FLASH_TTL_SECONDS * 1000;
/** A little tolerance for the difference between the clock that wrote the notice and the one that reads it. */
const SKEW_MS = 5000;
const MAX_VALUE_LENGTH = 600;
const MAX_PATH_LENGTH = 200;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CODE = /^[a-z_]{2,40}$/;
const PATH = /^\/[A-Za-z0-9/_.-]{0,199}$/;

/** The name of the notice cookie. A `__Host-` cookie cannot be set or replaced by a sibling sub-domain; it needs HTTPS. */
export const flashCookieName = (secure: boolean): string =>
  `${secure ? '__Host-' : ''}udofin_flash`;

/** The path of an address, without its query: where a notice is shown. */
export const flashPathOf = (returnTo: string): string => returnTo.split('?', 1)[0] ?? '';

const toBase64Url = (text: string): string =>
  btoa(text).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const fromBase64Url = (text: string): string =>
  atob(text.replaceAll('-', '+').replaceAll('_', '/'));

const isCount = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= 0 &&
  value <= LP_BANK_CREDIT_MAX_ROWS;

/**
 * The cookie value for a notice written now, or undefined when the notice is not one this module would read back (a path that
 * is not a plain path, a code or identifier of the wrong shape, counts out of range): then nothing is written and the page shows
 * no notice. Everything in the value is ASCII (a path, a code, an identifier, two counts and a time).
 */
export function sealFlash(flash: Flash, now: number = Date.now()): string | undefined {
  const { path, counts, result, registered, existing } = flash;
  if (path.length > MAX_PATH_LENGTH || !PATH.test(path)) return undefined;
  if (counts && !(isCount(counts.inserted) && isCount(counts.duplicates))) return undefined;
  if (result !== undefined && !CODE.test(result)) return undefined;
  if (registered !== undefined && !UUID.test(registered)) return undefined;
  if (existing !== undefined && existing !== true) return undefined;
  return toBase64Url(
    JSON.stringify({
      p: path,
      t: now,
      ...(counts ? { i: counts.inserted, u: counts.duplicates } : {}),
      ...(result !== undefined ? { r: result } : {}),
      ...(registered !== undefined ? { g: registered } : {}),
      ...(existing ? { x: 1 } : {}),
    }),
  );
}

/**
 * The notice for `path`, or undefined. Anything that is not exactly what `sealFlash` writes for this page a moment ago gives
 * undefined: no cookie, a notice for another page, a stale or future one, an unknown shape, an unexpected value.
 */
export function openFlash(
  value: string | undefined,
  path: string,
  now: number = Date.now(),
): Flash | undefined {
  if (value === undefined || value === '' || value.length > MAX_VALUE_LENGTH) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(fromBase64Url(value));
  } catch {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const known = new Set(['p', 't', 'i', 'u', 'r', 'g', 'x']);
  if (Object.keys(record).some((key) => !known.has(key))) return undefined;
  const { p, t, i, u, r, g, x } = record;
  if (typeof p !== 'string' || p.length > MAX_PATH_LENGTH || !PATH.test(p) || p !== path)
    return undefined;
  if (typeof t !== 'number' || !Number.isFinite(t) || t < now - TTL_MS || t > now + SKEW_MS)
    return undefined;
  let counts: Flash['counts'];
  if (i !== undefined || u !== undefined) {
    if (!isCount(i) || !isCount(u)) return undefined;
    counts = { inserted: i, duplicates: u };
  }
  if (r !== undefined && (typeof r !== 'string' || !CODE.test(r))) return undefined;
  if (g !== undefined && (typeof g !== 'string' || !UUID.test(g))) return undefined;
  if (x !== undefined && x !== 1) return undefined;
  return {
    path: p,
    ...(counts ? { counts } : {}),
    ...(typeof r === 'string' ? { result: r } : {}),
    ...(typeof g === 'string' ? { registered: g } : {}),
    ...(x === 1 ? { existing: true as const } : {}),
  };
}

/**
 * Whether the notice confirms a change that was recorded ("done"). The notice that a file had already been received is a
 * different statement, shown on its own: nothing was recorded by it.
 */
export const flashIsDone = (flash: Flash | undefined): boolean =>
  flash !== undefined && flash.existing !== true;

/** Whether the notice says that the file just sent had been received before. */
export const flashIsExisting = (flash: Flash | undefined): boolean => flash?.existing === true;
