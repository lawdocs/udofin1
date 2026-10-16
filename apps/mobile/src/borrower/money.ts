/** Money in the app is integer paise, like everywhere else. Typed rupee text is converted exactly, never through floats. */
export type AmountError = 'invalid' | 'too_small' | 'too_large';
export type AmountResult = { ok: true; paise: number } | { ok: false; error: AmountError };

/** Largest amount a single request may carry (matches the API contract). */
export const MAX_AMOUNT_PAISE = 100_000_000_000_000;

/** Accepts "50000", "50,000", "1,00,000.50" (Indian or Western grouping), up to two decimals. */
export function parseRupees(input: string): AmountResult {
  const text = input.trim().replace(/,/g, '');
  if (!/^\d{1,15}(\.\d{1,2})?$/.test(text)) return { ok: false, error: 'invalid' };
  const [whole = '0', fraction = ''] = text.split('.');
  const paise = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0') || '0');
  if (paise <= 0n) return { ok: false, error: 'too_small' };
  if (paise > BigInt(MAX_AMOUNT_PAISE)) return { ok: false, error: 'too_large' };
  return { ok: true, paise: Number(paise) };
}

/** Indian digit grouping (12,34,567). Shows decimals only when there are paise. */
export function formatRupees(paise: number): string {
  const negative = paise < 0;
  const abs = Math.abs(Math.trunc(paise));
  const rupees = String(Math.floor(abs / 100));
  const fraction = abs % 100;
  const head = rupees.slice(0, -3);
  const tail = rupees.slice(-3);
  const grouped = head ? `${head.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${tail}` : tail;
  const body = fraction === 0 ? grouped : `${grouped}.${String(fraction).padStart(2, '0')}`;
  return negative ? `-${body}` : body;
}
