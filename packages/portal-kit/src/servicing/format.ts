// Pure display helpers for the lender servicing screens. They only change how a reported value is written down; they never
// add, round, convert or infer a figure. Money arrives as integer paise and leaves as rupees with Indian digit grouping.

export const NOT_REPORTED = 'Not reported';

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/** India Standard Time is UTC+05:30 all year (no daylight saving). */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const MAX_PAISE = 100_000_000_000_000;

/** Groups a string of digits the Indian way: the last three digits, then pairs (1,23,45,678). */
export function groupIndian(digits: string): string {
  if (!/^\d+$/.test(digits)) throw new RangeError('groupIndian takes digits only');
  if (digits.length <= 3) return digits;
  const head = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${head},${digits.slice(-3)}`;
}

/** A whole number (a count, a number of bytes) with Indian grouping. */
export function formatCount(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError('a count is a non-negative whole number');
  return groupIndian(String(value));
}

/**
 * Integer paise as rupees: 12345678 becomes "₹1,23,456.78". Exact integer arithmetic only; anything that is not a
 * non-negative safe integer is refused instead of being rounded, because a screen must never show a changed figure.
 */
export function formatRupees(paise: number): string {
  if (!Number.isSafeInteger(paise) || paise < 0)
    throw new RangeError('paise must be a non-negative whole number');
  const value = BigInt(paise);
  const rupees = (value / 100n).toString();
  const rest = (value % 100n).toString().padStart(2, '0');
  return `₹${groupIndian(rupees)}.${rest}`;
}

/** A reported amount, or the plain statement that none was reported. A missing figure is never shown as zero. */
export const rupeesOrNotReported = (paise: number | null): string =>
  paise === null ? NOT_REPORTED : formatRupees(paise);

/** A calendar date the lender stated (YYYY-MM-DD) as "16 Oct 2026". No time zone is applied to a date. */
export function formatDate(date: string): string {
  const real = realDate(date);
  const m = real ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(real) : null;
  if (!m) throw new RangeError('not a calendar date');
  return `${String(Number(m[3]))} ${MONTHS[Number(m[2]) - 1] ?? ''} ${m[1] ?? ''}`;
}

export const dateOrDash = (date: string | null): string => (date === null ? '—' : formatDate(date));

/** An instant (ISO 8601 with an offset) as "16 Oct 2026, 15:45 IST". The clock is computed by hand so it never depends on the ICU build. */
export function formatIst(instant: string): string {
  const ms = Date.parse(instant);
  if (Number.isNaN(ms)) throw new RangeError('not a timestamp');
  const d = new Date(ms + IST_OFFSET_MS);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${String(d.getUTCDate())} ${MONTHS[d.getUTCMonth()] ?? ''} ${String(d.getUTCFullYear())}, ${hh}:${mm} IST`;
}

export const istOrDash = (instant: string | null): string =>
  instant === null ? '—' : formatIst(instant);

/**
 * What a person types for an amount, in rupees: digits with at most two decimals ("12500" or "12500.50"). Anything else,
 * including commas, signs and exponents, is refused rather than guessed. Returns integer paise or null.
 */
export function parseRupeesToPaise(text: string): number | null {
  const m = /^(\d{1,13})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!m) return null;
  const paise = BigInt(m[1] ?? '0') * 100n + BigInt((m[2] ?? '').padEnd(2, '0') || '0');
  return paise <= BigInt(MAX_PAISE) ? Number(paise) : null;
}

/**
 * A "datetime-local" value is a wall-clock time with no zone; the portal means India time. This returns the same instant
 * written with the +05:30 offset the API requires, or null for something that is not a real date and time.
 */
export function istLocalToInstant(local: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(local.trim());
  if (!m) return null;
  const [year, month, day, hour, minute, second] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? '00'].map(
    Number,
  ) as [number, number, number, number, number, number];
  const probe = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day ||
    probe.getUTCHours() !== hour ||
    probe.getUTCMinutes() !== minute ||
    probe.getUTCSeconds() !== second
  )
    return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${m[1] ?? ''}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}+05:30`;
}

/** "YYYY-MM-DD" that is a real calendar date, or null. */
export function realDate(text: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])] as [number, number, number];
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
    ? text.trim()
    : null;
}
