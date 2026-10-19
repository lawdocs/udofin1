import { describe, expect, it } from 'vitest';
import { MoneyMinor } from './primitives.js';

describe('MoneyMinor', () => {
  it('accepts integer paise strings in INR', () => {
    expect(MoneyMinor.safeParse({ minor: '125050', currency: 'INR' }).success).toBe(true);
    expect(MoneyMinor.safeParse({ minor: '-5', currency: 'INR' }).success).toBe(true);
  });

  it.each([
    { minor: 125050, currency: 'INR' },
    { minor: '1250.50', currency: 'INR' },
    { minor: '100', currency: 'USD' },
    { minor: '1234567890123456789', currency: 'INR' },
  ])('rejects %j', (value) => {
    expect(MoneyMinor.safeParse(value).success).toBe(false);
  });
});
