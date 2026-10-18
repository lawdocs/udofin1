import { type Language } from '../i18n';
import { formatRupees } from './money';

/**
 * Money, date and time text for the loan screens. Nothing here rounds, totals or converts a figure: money arrives as
 * integer paise and leaves as rupees with Indian digit grouping; a date-only value stays the calendar date it is.
 */

const LOCALE: Record<Language, string> = { en: 'en-IN', hi: 'hi-IN' };

/** Rupees with the rupee sign and Indian digit grouping (12,34,567). Decimals appear only when there are paise. */
export function formatAmount(paise: number): string {
  return `₹${formatRupees(paise)}`;
}

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

function parts(
  date: Date,
  language: Language,
  options: Intl.DateTimeFormatOptions,
): Record<string, string> | null {
  try {
    const formatted = new Intl.DateTimeFormat(LOCALE[language], options).formatToParts(date);
    const out: Record<string, string> = {};
    for (const part of formatted) out[part.type] = part.value;
    return out;
  } catch {
    return null;
  }
}

/**
 * "18 Oct 2026, 14:30 IST": the lender's report time or any other instant, in India time, always naming the zone so the
 * borrower is not left to guess. `hourCycle: 'h23'` keeps midnight as 00:00 (some engines print 24:00 with `hour12: false`).
 * An unreadable value gives an empty string, never a made-up time.
 */
export function formatReportedAt(iso: string, language: Language): string {
  const date = parseInstant(iso);
  if (!date) return '';
  const p = parts(date, language, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: 'Asia/Kolkata',
  });
  if (!p) return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  return `${p.day ?? ''} ${p.month ?? ''} ${p.year ?? ''}, ${p.hour ?? ''}:${p.minute ?? ''} IST`;
}

/** The calendar day of an instant in India time ("18 Oct 2026"). */
export function formatInstantDay(iso: string, language: Language): string {
  const date = parseInstant(iso);
  if (!date) return '';
  const p = parts(date, language, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Kolkata',
  });
  if (!p) return date.toISOString().slice(0, 10);
  return `${p.day ?? ''} ${p.month ?? ''} ${p.year ?? ''}`;
}

/** True for a real calendar date written YYYY-MM-DD (not 2026-02-31). */
export function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const check = new Date(Date.UTC(year, month - 1, day));
  return (
    check.getUTCFullYear() === year &&
    check.getUTCMonth() === month - 1 &&
    check.getUTCDate() === day
  );
}

/**
 * A date without a time ("2026-12-01") is a calendar day, not an instant: it is formatted from its own parts in UTC, so no
 * time zone can move it to the day before or after. An unreadable value gives an empty string.
 */
export function formatDateOnly(value: string, language: Language): string {
  if (!isCalendarDate(value)) return '';
  const [year = 0, month = 1, day = 1] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const p = parts(date, language, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
  if (!p) return value;
  return `${p.day ?? ''} ${p.month ?? ''} ${p.year ?? ''}`;
}

/** The number of bytes a base64 text decodes to, worked out from its length (no decoding). -1 for text that is not base64. */
export function base64ByteLength(input: string): number {
  const clean = input.replace(/\s/g, '');
  if (clean.length === 0 || clean.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean))
    return -1;
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return (clean.length / 4) * 3 - padding;
}
