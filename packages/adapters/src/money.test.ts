import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  formatMoneyMinor,
  MAX_MONEY_MINOR,
  MONEY_TEXT_VECTORS,
  MoneyTextError,
  parseMoneyMinor,
  tryParseMoneyMinor,
} from './money.js';

describe('parseMoneyMinor (same rules as private.parse_money_minor)', () => {
  it.each(MONEY_TEXT_VECTORS.accepted.map((v) => [v.text, v.minor] as const))(
    'accepts %s',
    (text, minor) => {
      expect(parseMoneyMinor(text)).toBe(minor);
    },
  );

  it.each(MONEY_TEXT_VECTORS.rejected.map((v) => [v.label, v] as const))(
    'rejects %s',
    (_label, { text, reason }) => {
      expect(() => parseMoneyMinor(text)).toThrow(MoneyTextError);
      try {
        parseMoneyMinor(text);
      } catch (error) {
        expect((error as MoneyTextError).reason).toBe(reason);
      }
      expect(tryParseMoneyMinor(text)).toEqual({ ok: false, reason });
    },
  );

  it('returns a bigint and never loses a paisa on large values', () => {
    expect(typeof parseMoneyMinor('1.05')).toBe('bigint');
    expect(parseMoneyMinor('999999999999.99')).toBe(MAX_MONEY_MINOR - 1n);
  });

  it('never puts the rejected text in an error', () => {
    for (const text of ['SECRET-1,5', '9876543210123456789012', '1.2345', '١٢']) {
      try {
        parseMoneyMinor(text);
        throw new Error('should have thrown');
      } catch (error) {
        expect((error as Error).message).not.toContain(text);
      }
    }
  });
});

// The database stream's vectors, copied verbatim from docs/specs/08a-notes/foundation.md section 4 (the pgTAP file
// supabase/tests/015_p08a_foundation.test.sql runs the same list against private.parse_money_minor). If either list
// changes, both sides must be re-compared.
const DB_VALID: readonly (readonly [string, string])[] = [
  ['0', '0'],
  ['0.0', '0'],
  ['0.00', '0'],
  ['0.5', '50'],
  ['0.05', '5'],
  ['0.50', '50'],
  ['0.99', '99'],
  ['1', '100'],
  ['1.01', '101'],
  ['9', '900'],
  ['10', '1000'],
  ['20.10', '2010'],
  ['100.1', '10010'],
  ['1250', '125000'],
  ['1250.5', '125050'],
  ['1250.50', '125050'],
  ['1250.05', '125005'],
  ['1250.00', '125000'],
  ['10000000', '1000000000'],
  ['123456789012', '12345678901200'],
  ['999999999999.99', '99999999999999'],
  ['1000000000000', '100000000000000'],
  ['1000000000000.0', '100000000000000'],
  ['1000000000000.00', '100000000000000'],
];
const DB_INVALID: readonly (string | null)[] = [
  null,
  '',
  ' ',
  ' 1250',
  '1250 ',
  '1 250',
  '1250\n',
  '\t1250',
  '1250\r',
  '\u00a01250',
  '+1250',
  '-1250',
  '-0',
  '+0',
  '1e3',
  '1E3',
  '1e-2',
  '0x10',
  '1,250',
  '1,250.50',
  '1_250',
  '1250.',
  '.5',
  '.',
  '1250.505',
  '1250.500',
  '1250.001',
  '00',
  '01',
  '007',
  '00.5',
  '01.50',
  '1250,50',
  '1.2.3',
  'abc',
  '12a',
  'Infinity',
  'NaN',
  '0.5.',
  '1000000000000.01',
  '1000000000001',
  '9999999999999999',
  '99999999999999999',
  '\u0661\u0662\u0663',
  '\u0967\u0968\u0969',
  '\uff11\uff12\uff13',
  '12\uff11',
  '\u20b91250',
  'Rs 1250',
  '1250/-',
];

describe('agreement with the database function private.parse_money_minor', () => {
  it.each(DB_VALID)('accepts %j as the database does', (text, minor) => {
    expect(parseMoneyMinor(text)).toBe(BigInt(minor));
  });
  it.each(DB_INVALID.map((v, i) => [i, v] as const))(
    'rejects database-invalid vector %i',
    (_i, text) => {
      expect(() => parseMoneyMinor(text)).toThrow(MoneyTextError);
    },
  );
  it('has the same counts as the database list (24 valid, 50 invalid)', () => {
    expect(DB_VALID).toHaveLength(24);
    expect(DB_INVALID).toHaveLength(50);
  });
  it('every vector of this package is also valid or invalid in the same way for the database grammar', () => {
    const grammar = /^(0|[1-9][0-9]{0,15})(\.[0-9]{1,2})?$/;
    for (const { text, minor } of MONEY_TEXT_VECTORS.accepted) {
      expect(grammar.test(text)).toBe(true);
      expect(minor <= MAX_MONEY_MINOR).toBe(true);
    }
    for (const { text } of MONEY_TEXT_VECTORS.rejected) {
      const passesGrammar = typeof text === 'string' && grammar.test(text);
      // Inputs that pass the grammar can only be rejected for exceeding the maximum.
      if (passesGrammar) expect(() => parseMoneyMinor(text)).toThrow(/above_maximum/);
    }
  });
});

describe('formatMoneyMinor', () => {
  it('always writes two decimals and round-trips every accepted vector', () => {
    expect(formatMoneyMinor(0n)).toBe('0.00');
    expect(formatMoneyMinor(5n)).toBe('0.05');
    expect(formatMoneyMinor(125_050n)).toBe('1250.50');
    expect(formatMoneyMinor(MAX_MONEY_MINOR)).toBe('1000000000000.00');
    for (const { minor } of MONEY_TEXT_VECTORS.accepted) {
      expect(parseMoneyMinor(formatMoneyMinor(minor))).toBe(minor);
    }
  });

  it('refuses negatives, values above the maximum and non-bigints', () => {
    expect(() => formatMoneyMinor(-1n)).toThrow(MoneyTextError);
    expect(() => formatMoneyMinor(MAX_MONEY_MINOR + 1n)).toThrow(MoneyTextError);
    expect(() => formatMoneyMinor(12.5 as unknown as bigint)).toThrow(MoneyTextError);
  });
});

describe('no floating point on money in the new modules', () => {
  const stripComments = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const files = [
    'money.ts',
    'lms.ts',
    'payments.ts',
    'mandates.ts',
    'notifications.ts',
    'account-fingerprint.ts',
  ];
  it.each(files)(
    '%s has no Number(), parseFloat, toFixed or Math rounding (Math.floor is used only for epoch seconds)',
    (file) => {
      const code = stripComments(readFileSync(new URL(`./${file}`, import.meta.url), 'utf8'));
      expect(code).not.toMatch(/\bNumber\(/);
      expect(code).not.toMatch(/parseFloat|toFixed|Math\.(round|ceil|trunc)/);
    },
  );
});
