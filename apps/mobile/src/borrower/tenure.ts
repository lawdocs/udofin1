/**
 * The API stores tenure in days. The app asks in months because that is how people think, and counts a
 * month as 30 days. This is a deliberate simplification shown to the borrower ("Counted as N days");
 * the lender's own schedule is authoritative (open decision recorded in docs/product/open-decisions.md).
 */
export const DAYS_PER_MONTH = 30;
export const MAX_TENURE_DAYS = 10_950;

export type TenureError = 'invalid' | 'too_short' | 'too_long';
export type TenureResult = { ok: true; days: number } | { ok: false; error: TenureError };

export function parseMonths(input: string, minDays: number): TenureResult {
  const text = input.trim();
  if (!/^\d{1,3}$/.test(text)) return { ok: false, error: 'invalid' };
  const months = Number(text);
  if (months < 1) return { ok: false, error: 'invalid' };
  const days = months * DAYS_PER_MONTH;
  if (days < minDays) return { ok: false, error: 'too_short' };
  if (days > MAX_TENURE_DAYS) return { ok: false, error: 'too_long' };
  return { ok: true, days };
}

/** Whole months for display only (rounds up so a 31-day product is not shown as 1 month). */
export const daysToMonths = (days: number): number => Math.max(1, Math.ceil(days / DAYS_PER_MONTH));
