/**
 * Decimal money text on the wire. Every adapter, import file and provider payload carries rupee amounts as DECIMAL
 * STRINGS ("1250", "1250.5", "1250.50") and every one of them is parsed by parseMoneyMinor, which returns integer
 * paise as a bigint. There is no Number(), no parseFloat and no floating-point arithmetic anywhere on this path.
 *
 * The rules are the SAME as the database function private.parse_money_minor, so a value accepted here is accepted
 * there and the reverse. Both sides must be compared with MONEY_TEXT_VECTORS (see docs/specs/08a-notes/ports.md).
 *
 * Accepted:  a whole part of "0" or digits without a leading zero, optionally followed by "." and ONE or TWO digits
 *            (ASCII 0-9 only), and a value of at most 100000000000000 paise (1,000,000,000,000 rupees).
 * Rejected:  null and non-strings, the empty string, signs (+ and -), exponents, thousands separators and any other
 *            separator, spaces and other whitespace (including leading/trailing), non-ASCII digits, more than two
 *            decimals (even "1.230"), a trailing or leading ".", leading zeros beyond a single "0", and any value
 *            above the maximum. Nothing is ever rounded.
 *
 * Errors carry a reason CLASS only. They never contain the rejected text, because that text can be anything a
 * lender or provider sent.
 */

/** The largest amount any money column or wire value may hold, in paise (matches the database check). */
export const MAX_MONEY_MINOR = 100_000_000_000_000n;

export type MoneyTextErrorReason =
  | 'not_a_string'
  | 'empty'
  | 'too_long'
  | 'invalid_format'
  | 'above_maximum'
  | 'negative'
  | 'not_a_bigint';

export class MoneyTextError extends Error {
  override readonly name = 'MoneyTextError';
  readonly reason: MoneyTextErrorReason;
  constructor(reason: MoneyTextErrorReason) {
    super(`invalid money text: ${reason}`);
    this.reason = reason;
  }
}

const DECIMAL_RUPEES = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,2}))?$/;
// "1000000000000.00" is 16 characters; anything longer cannot be valid and is refused before matching.
const MAX_TEXT_LENGTH = 16;

/** Decimal rupee string to integer paise. Throws MoneyTextError (reason class only) when the text is not valid. */
export function parseMoneyMinor(text: unknown): bigint {
  if (typeof text !== 'string') throw new MoneyTextError('not_a_string');
  if (text.length === 0) throw new MoneyTextError('empty');
  if (text.length > MAX_TEXT_LENGTH) throw new MoneyTextError('too_long');
  const match = DECIMAL_RUPEES.exec(text);
  if (!match) throw new MoneyTextError('invalid_format');
  const [, whole = '0', fraction = ''] = match;
  const minor = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (minor > MAX_MONEY_MINOR) throw new MoneyTextError('above_maximum');
  return minor;
}

/** Non-throwing variant for validators that collect row errors. */
export function tryParseMoneyMinor(
  text: unknown,
): { ok: true; minor: bigint } | { ok: false; reason: MoneyTextErrorReason } {
  try {
    return { ok: true, minor: parseMoneyMinor(text) };
  } catch (error) {
    if (error instanceof MoneyTextError) return { ok: false, reason: error.reason };
    throw error;
  }
}

/** Integer paise to the canonical wire text, always with two decimals ("1250.50"). Negative values are refused. */
export function formatMoneyMinor(minor: bigint): string {
  if (typeof minor !== 'bigint') throw new MoneyTextError('not_a_bigint');
  if (minor < 0n) throw new MoneyTextError('negative');
  if (minor > MAX_MONEY_MINOR) throw new MoneyTextError('above_maximum');
  const whole = minor / 100n;
  const fraction = (minor % 100n).toString().padStart(2, '0');
  return `${whole.toString()}.${fraction}`;
}

/**
 * Shared test vectors. The database stream's copy lives in docs/specs/08a-notes/foundation.md; the two lists must be
 * compared and any difference resolved before either side is relied on. Fixtures are synthetic.
 */
export const MONEY_TEXT_VECTORS: {
  readonly accepted: readonly { readonly text: string; readonly minor: bigint }[];
  readonly rejected: readonly {
    readonly text: unknown;
    readonly label: string;
    readonly reason: MoneyTextErrorReason;
  }[];
} = {
  accepted: [
    { text: '0', minor: 0n },
    { text: '0.0', minor: 0n },
    { text: '0.00', minor: 0n },
    { text: '0.5', minor: 50n },
    { text: '0.05', minor: 5n },
    { text: '0.01', minor: 1n },
    { text: '1', minor: 100n },
    { text: '1.5', minor: 150n },
    { text: '1.50', minor: 150n },
    { text: '1.05', minor: 105n },
    { text: '1250', minor: 125_000n },
    { text: '1250.5', minor: 125_050n },
    { text: '1250.50', minor: 125_050n },
    { text: '999999999999.99', minor: 99_999_999_999_999n },
    { text: '1000000000000', minor: 100_000_000_000_000n },
    { text: '1000000000000.00', minor: 100_000_000_000_000n },
  ],
  rejected: [
    { text: null, label: 'null', reason: 'not_a_string' },
    { text: undefined, label: 'undefined', reason: 'not_a_string' },
    { text: 1250, label: 'a JSON number', reason: 'not_a_string' },
    { text: 12.5, label: 'a float', reason: 'not_a_string' },
    { text: 100n, label: 'a bigint', reason: 'not_a_string' },
    { text: '', label: 'empty', reason: 'empty' },
    { text: ' ', label: 'a space', reason: 'invalid_format' },
    { text: ' 1', label: 'leading space', reason: 'invalid_format' },
    { text: '1 ', label: 'trailing space', reason: 'invalid_format' },
    { text: '1\n', label: 'trailing newline', reason: 'invalid_format' },
    { text: '1\t0', label: 'tab inside', reason: 'invalid_format' },
    { text: '1 000', label: 'space separator', reason: 'invalid_format' },
    { text: '+1', label: 'plus sign', reason: 'invalid_format' },
    { text: '-1', label: 'minus sign', reason: 'invalid_format' },
    { text: '-0', label: 'negative zero', reason: 'invalid_format' },
    { text: '1e3', label: 'exponent', reason: 'invalid_format' },
    { text: '1E3', label: 'upper-case exponent', reason: 'invalid_format' },
    { text: '1.5e1', label: 'exponent after decimals', reason: 'invalid_format' },
    { text: '1.', label: 'trailing point', reason: 'invalid_format' },
    { text: '.5', label: 'no whole part', reason: 'invalid_format' },
    { text: '.', label: 'a point alone', reason: 'invalid_format' },
    { text: '1.234', label: 'three decimals', reason: 'invalid_format' },
    { text: '1.230', label: 'three decimals ending in zero', reason: 'invalid_format' },
    { text: '1.2.3', label: 'two points', reason: 'invalid_format' },
    { text: '1,000', label: 'comma separator', reason: 'invalid_format' },
    { text: '1,5', label: 'decimal comma', reason: 'invalid_format' },
    { text: '1_000', label: 'underscore separator', reason: 'invalid_format' },
    { text: '00', label: 'double zero', reason: 'invalid_format' },
    { text: '01', label: 'leading zero', reason: 'invalid_format' },
    { text: '00.5', label: 'leading zeros before a point', reason: 'invalid_format' },
    { text: '0x10', label: 'hexadecimal', reason: 'invalid_format' },
    { text: 'NaN', label: 'NaN', reason: 'invalid_format' },
    { text: 'Infinity', label: 'Infinity', reason: 'invalid_format' },
    { text: '₹100', label: 'currency symbol', reason: 'invalid_format' },
    { text: '١٢٣', label: 'Arabic-Indic digits', reason: 'invalid_format' },
    { text: '१२', label: 'Devanagari digits', reason: 'invalid_format' },
    { text: '１２', label: 'full-width digits', reason: 'invalid_format' },
    { text: '1000000000000.01', label: 'one paisa above the maximum', reason: 'above_maximum' },
    { text: '1000000000001', label: 'a rupee above the maximum', reason: 'above_maximum' },
    { text: '9999999999999999', label: 'sixteen digits', reason: 'above_maximum' },
    { text: '99999999999999999', label: 'seventeen digits', reason: 'too_long' },
  ],
};
