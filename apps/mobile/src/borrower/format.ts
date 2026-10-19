import { type Language } from '../i18n';

const LOCALE: Record<Language, string> = { en: 'en-IN', hi: 'hi-IN' };

/** Day-month-year in the borrower's language. Falls back to the ISO date if Intl is unavailable. */
export function formatDate(iso: string, language: Language): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  try {
    return new Intl.DateTimeFormat(LOCALE[language], {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'Asia/Kolkata',
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/** Date and time in India time, for validity windows. Always says IST so the borrower is not left to guess the zone. */
export function formatDateTime(iso: string, language: Language): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  try {
    return `${new Intl.DateTimeFormat(LOCALE[language], {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'Asia/Kolkata',
    }).format(date)} IST`;
  } catch {
    return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  }
}
