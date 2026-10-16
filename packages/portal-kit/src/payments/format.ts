/**
 * Pure formatting helpers for the lender payment screens. They only change how a value the API reported is written; they never
 * compute, total, round or infer one. Money arrives as integer paise and is written as rupees with Indian digit grouping using
 * integer arithmetic only (no floating point).
 */

/** Written when a figure is missing. A missing figure is never shown as zero. */
export const LP_NOT_REPORTED = 'Not reported';
/** Written when a value cannot be shown safely (for example a malformed date). */
export const LP_NOT_AVAILABLE = 'Not available';

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

/** Groups digits the Indian way: the last three, then pairs (1,23,45,678). */
export function lpGroupIndian(digits: string): string {
  if (!/^\d+$/.test(digits)) return digits;
  if (digits.length <= 3) return digits;
  const last = digits.slice(-3);
  const head = digits.slice(0, -3);
  return `${head.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last}`;
}

/** A whole number with Indian grouping (a count, not money). */
export function lpCount(value: number | null | undefined): string {
  if (value === null || value === undefined) return LP_NOT_AVAILABLE;
  if (!Number.isSafeInteger(value) || value < 0) return LP_NOT_AVAILABLE;
  return lpGroupIndian(String(value));
}

/**
 * Integer paise as rupees with two decimals and Indian grouping: 12345678 becomes "₹1,23,456.78". A missing or invalid value
 * is written as words, never as zero.
 */
export function lpRupees(paise: number | null | undefined, missing = LP_NOT_REPORTED): string {
  if (paise === null || paise === undefined) return missing;
  if (!Number.isSafeInteger(paise) || paise < 0) return LP_NOT_AVAILABLE;
  const whole = BigInt(paise);
  const rupees = whole / 100n;
  const rest = whole % 100n;
  return `₹${lpGroupIndian(rupees.toString())}.${rest.toString().padStart(2, '0')}`;
}

/** "16 Oct 2026" from a calendar date (YYYY-MM-DD). No time zone is involved: the lender's date is shown as stated. */
export function lpDate(value: string | null | undefined): string {
  if (!value) return LP_NOT_AVAILABLE;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return LP_NOT_AVAILABLE;
  const month = MONTHS[Number(match[2]) - 1];
  if (!month) return LP_NOT_AVAILABLE;
  return `${String(Number(match[3]))} ${month} ${match[1] ?? ''}`;
}

/**
 * "16 Oct 2026, 14:05 IST" from an ISO 8601 timestamp with an offset. India has no daylight saving, so a fixed offset of
 * five hours thirty minutes is exact. The 24-hour clock avoids any am/pm doubt.
 */
export function lpDateTimeIst(value: string | null | undefined): string {
  if (!value) return LP_NOT_AVAILABLE;
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) return LP_NOT_AVAILABLE;
  const ist = new Date(epoch + 330 * 60_000);
  const day = String(ist.getUTCDate());
  const month = MONTHS[ist.getUTCMonth()];
  const year = String(ist.getUTCFullYear());
  const hh = String(ist.getUTCHours()).padStart(2, '0');
  const mm = String(ist.getUTCMinutes()).padStart(2, '0');
  return `${day} ${month ?? ''} ${year}, ${hh}:${mm} IST`;
}

/**
 * Reads a rupee amount typed by a person ("1500" or "1500.50") into integer paise using string arithmetic only. Digits and one
 * decimal point only: at most two decimals and at most twelve whole-rupee digits. A comma, a currency sign or anything else is
 * refused (a comma could be a decimal comma, and a guess could be a hundred times wrong). Nothing is rounded: the person is
 * asked again.
 */
export function lpParseRupees(text: string): number | null {
  const match = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!match) return null;
  const whole = match[1] ?? '';
  const fraction = (match[2] ?? '').padEnd(2, '0');
  const paise = BigInt(whole) * 100n + BigInt(fraction);
  if (paise > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(paise);
}

/** Integer paise as plain rupees for a form field ("150050" becomes "1500.50"): digits and a point only, no sign, no grouping. */
export function lpRupeesPlain(paise: number | null | undefined): string {
  if (paise === null || paise === undefined || !Number.isSafeInteger(paise) || paise < 0) return '';
  const whole = BigInt(paise);
  return `${(whole / 100n).toString()}.${(whole % 100n).toString().padStart(2, '0')}`;
}
