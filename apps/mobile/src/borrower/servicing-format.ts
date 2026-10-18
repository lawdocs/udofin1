import { type Language } from '../i18n';
import { formatRupees } from './money';

/**
 * Money, date and time text for the loan screens. Nothing here rounds, totals or converts a figure: money arrives as
 * integer paise and leaves as rupees with Indian digit grouping; a date-only value stays the calendar date it is.
 *
 * Dates and times do not use `Intl`: the month names are fixed tables and India time is computed as UTC plus 5 hours 30
 * minutes (India has no daylight saving time), so the text is the same on every device and every engine, in the tests and on
 * the phone. Digits are the ones used everywhere else in the app.
 */

/** Rupees with the rupee sign and Indian digit grouping (12,34,567). Decimals appear only when there are paise. */
export function formatAmount(paise: number): string {
  return `₹${formatRupees(paise)}`;
}

const MONTHS: Record<Language, readonly string[]> = {
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  hi: [
    'जनवरी',
    'फ़रवरी',
    'मार्च',
    'अप्रैल',
    'मई',
    'जून',
    'जुलाई',
    'अगस्त',
    'सितंबर',
    'अक्टूबर',
    'नवंबर',
    'दिसंबर',
  ],
};

/** India Standard Time is always UTC+05:30. */
const IST_OFFSET_MINUTES = 330;

const ISO_INSTANT = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})$/;

/**
 * The API prints timestamps with microseconds and an offset ("2026-10-18T09:00:00.123456+00:00"). Not every JavaScript
 * engine reads more than three fractional digits, so they are cut to three (cutting never moves the time by a second)
 * before parsing. Returns null for anything that is not such a timestamp.
 */
export function parseInstant(iso: string): Date | null {
  const match = ISO_INSTANT.exec(iso);
  if (!match) return null;
  const [, base = '', fraction = '', zone = ''] = match;
  const millis = fraction.slice(0, 3).padEnd(3, '0');
  const normalisedZone = /^[+-]\d{4}$/.test(zone) ? `${zone.slice(0, 3)}:${zone.slice(3)}` : zone;
  const date = new Date(`${base}.${millis}${normalisedZone}`);
  return Number.isNaN(date.getTime()) ? null : date;
}

const two = (n: number): string => String(n).padStart(2, '0');

/** "5 Nov 2026" from a year, a month (1 to 12) and a day. */
function dayText(year: number, month: number, day: number, language: Language): string {
  return `${String(day)} ${MONTHS[language][month - 1] ?? ''} ${String(year)}`;
}

/** The wall-clock fields of an instant in India time. */
function istFields(date: Date) {
  const ist = new Date(date.getTime() + IST_OFFSET_MINUTES * 60_000);
  return {
    year: ist.getUTCFullYear(),
    month: ist.getUTCMonth() + 1,
    day: ist.getUTCDate(),
    hour: ist.getUTCHours(),
    minute: ist.getUTCMinutes(),
  };
}

/**
 * "18 Oct 2026, 14:30 IST": the lender's report time or any other instant, in India time, always naming the zone so the
 * borrower is not left to guess. Midnight is 00:00. An unreadable value gives an empty string, never a made-up time.
 */
export function formatReportedAt(iso: string, language: Language): string {
  const date = parseInstant(iso);
  if (!date) return '';
  const f = istFields(date);
  return `${dayText(f.year, f.month, f.day, language)}, ${two(f.hour)}:${two(f.minute)} IST`;
}

/** The calendar day of an instant in India time ("18 Oct 2026"). */
export function formatInstantDay(iso: string, language: Language): string {
  const date = parseInstant(iso);
  if (!date) return '';
  const f = istFields(date);
  return dayText(f.year, f.month, f.day, language);
}

/** True for a real calendar date written YYYY-MM-DD (not 2026-02-31). */
export function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  // A day past the end of the month rolls the date into the next month, so comparing the year and the month finds it.
  const check = new Date(Date.UTC(year, month - 1, day));
  return check.getUTCFullYear() === year && check.getUTCMonth() === month - 1;
}

/**
 * A date without a time ("2026-12-01") is a calendar day, not an instant: it is written from its own parts, so no time zone can
 * move it to the day before or after. An unreadable value gives an empty string.
 */
export function formatDateOnly(value: string, language: Language): string {
  if (!isCalendarDate(value)) return '';
  const [year = 0, month = 1, day = 1] = value.split('-').map(Number);
  return dayText(year, month, day, language);
}

/** The number of bytes a base64 text decodes to, worked out from its length (no decoding). -1 for text that is not base64. */
export function base64ByteLength(input: string): number {
  const clean = input.replace(/\s/g, '');
  if (clean.length === 0 || clean.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean))
    return -1;
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return (clean.length / 4) * 3 - padding;
}
