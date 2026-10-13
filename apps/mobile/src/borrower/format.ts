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
