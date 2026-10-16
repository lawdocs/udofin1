/**
 * Money is always held as an integer number of minor units (paise for INR) in a bigint.
 * Floating-point numbers are never accepted, so rounding errors cannot creep into
 * schedules, allocations or ledger entries.
 */

export type CurrencyCode = 'INR';

export interface Money {
  readonly minor: bigint;
  readonly currency: CurrencyCode;
}

export class MoneyError extends Error {
  override readonly name = 'MoneyError';
}

const MINOR_UNITS_PER_MAJOR = 100n;
const DECIMAL_AMOUNT = /^(-)?(\d+)(?:\.(\d{1,2}))?$/;

export function money(minor: bigint, currency: CurrencyCode = 'INR'): Money {
  return Object.freeze({ minor, currency });
}

export const ZERO_INR: Money = money(0n);

/**
 * Parses a decimal rupee string such as "1250", "1250.5" or "1250.50" into paise.
 * Rejects more than two decimal places, exponents, separators and whitespace instead of rounding.
 */
export function parseMajor(amount: string, currency: CurrencyCode = 'INR'): Money {
  const match = DECIMAL_AMOUNT.exec(amount);
  if (!match) {
    throw new MoneyError(`Invalid ${currency} amount: ${JSON.stringify(amount)}`);
  }
  const [, sign, whole = '0', fraction = ''] = match;
  const minor = BigInt(whole) * MINOR_UNITS_PER_MAJOR + BigInt(fraction.padEnd(2, '0'));
  return money(sign ? -minor : minor, currency);
}

function assertSameCurrency(a: Money, b: Money): void {
  // Only INR exists today; the guard keeps future currencies from mixing silently.
  if ((a.currency as string) !== (b.currency as string)) {
    throw new MoneyError(`Currency mismatch: ${String(a.currency)} vs ${String(b.currency)}`);
  }
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.minor + b.minor, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.minor - b.minor, a.currency);
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  if (a.minor === b.minor) return 0;
  return a.minor < b.minor ? -1 : 1;
}

export function isZero(a: Money): boolean {
  return a.minor === 0n;
}

export function isNegative(a: Money): boolean {
  return a.minor < 0n;
}

/**
 * Splits an amount across integer weights without losing or inventing a single paisa.
 * Remainders go to the earliest parts, so the result is deterministic and always sums to the input.
 */
export function allocate(total: Money, weights: readonly bigint[]): Money[] {
  if (weights.length === 0) {
    throw new MoneyError('allocate() needs at least one weight');
  }
  if (weights.some((w) => w < 0n)) {
    throw new MoneyError('allocate() weights must be non-negative');
  }
  const weightSum = weights.reduce((sum, w) => sum + w, 0n);
  if (weightSum === 0n) {
    throw new MoneyError('allocate() weights must not all be zero');
  }
  const sign = total.minor < 0n ? -1n : 1n;
  const absolute = total.minor * sign;
  const parts = weights.map((w) => (absolute * w) / weightSum);
  let remainder = absolute - parts.reduce((sum, p) => sum + p, 0n);
  for (let i = 0; remainder > 0n; i = (i + 1) % parts.length) {
    if (weights[i] === 0n) continue;
    parts[i] = (parts[i] ?? 0n) + 1n;
    remainder -= 1n;
  }
  return parts.map((p) => money(p * sign, total.currency));
}

/** Formats with Indian digit grouping, e.g. 12345678 paise -> "₹1,23,456.78". */
export function formatINR(value: Money): string {
  const negative = value.minor < 0n;
  const absolute = negative ? -value.minor : value.minor;
  const whole = (absolute / MINOR_UNITS_PER_MAJOR).toString();
  const fraction = (absolute % MINOR_UNITS_PER_MAJOR).toString().padStart(2, '0');
  const lastThree = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${lastThree}` : lastThree;
  return `${negative ? '-' : ''}₹${grouped}.${fraction}`;
}

/** Serialises to a decimal string for JSON transport (bigint is not JSON-safe). */
export function toMajorString(value: Money): string {
  const negative = value.minor < 0n;
  const absolute = negative ? -value.minor : value.minor;
  const whole = absolute / MINOR_UNITS_PER_MAJOR;
  const fraction = (absolute % MINOR_UNITS_PER_MAJOR).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}
