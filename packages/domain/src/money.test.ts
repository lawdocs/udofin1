import { describe, expect, it } from 'vitest';
import {
  add,
  allocate,
  compare,
  formatINR,
  money,
  MoneyError,
  parseMajor,
  subtract,
  toMajorString,
} from './money.js';

describe('parseMajor', () => {
  it.each([
    ['0', 0n],
    ['1', 100n],
    ['1250.5', 125050n],
    ['1250.05', 125005n],
    ['-10.25', -1025n],
    ['99999999999999.99', 9999999999999999n],
  ])('parses %s into %s paise', (input, expected) => {
    expect(parseMajor(input).minor).toBe(expected);
  });

  it.each(['', ' 1', '1.234', '1e3', '1,000', '₹10', 'NaN', '.5', '1.'])(
    'rejects %j instead of rounding or guessing',
    (input) => {
      expect(() => parseMajor(input)).toThrow(MoneyError);
    },
  );
});

describe('arithmetic', () => {
  it('adds, subtracts and compares in paise', () => {
    const a = parseMajor('100.10');
    const b = parseMajor('0.20');
    expect(add(a, b).minor).toBe(10030n);
    expect(subtract(a, b).minor).toBe(9990n);
    expect(compare(a, b)).toBe(1);
    expect(compare(b, a)).toBe(-1);
    expect(compare(a, money(10010n))).toBe(0);
  });
});

describe('allocate', () => {
  it('never loses or invents a paisa', () => {
    const parts = allocate(money(100n), [1n, 1n, 1n]);
    expect(parts.map((p) => p.minor)).toEqual([34n, 33n, 33n]);
    expect(parts.reduce((s, p) => s + p.minor, 0n)).toBe(100n);
  });

  it('respects weights and skips zero-weight parts for remainders', () => {
    const parts = allocate(money(1001n), [0n, 3n, 7n]);
    expect(parts.map((p) => p.minor)).toEqual([0n, 301n, 700n]);
  });

  it('handles negative totals symmetrically', () => {
    const parts = allocate(money(-100n), [1n, 2n]);
    expect(parts.map((p) => p.minor)).toEqual([-34n, -66n]);
  });

  it('rejects empty, negative or all-zero weights', () => {
    expect(() => allocate(money(1n), [])).toThrow(MoneyError);
    expect(() => allocate(money(1n), [-1n, 2n])).toThrow(MoneyError);
    expect(() => allocate(money(1n), [0n, 0n])).toThrow(MoneyError);
  });
});

describe('formatting', () => {
  it.each([
    [0n, '₹0.00'],
    [5n, '₹0.05'],
    [100000n, '₹1,000.00'],
    [12345678n, '₹1,23,456.78'],
    [1234567890n, '₹1,23,45,678.90'],
    [-150050n, '-₹1,500.50'],
  ])('formats %s paise as %s', (minor, expected) => {
    expect(formatINR(money(minor))).toBe(expected);
  });

  it('serialises to a JSON-safe decimal string', () => {
    expect(toMajorString(money(-5n))).toBe('-0.05');
    expect(toMajorString(parseMajor('1250.5'))).toBe('1250.50');
  });
});
