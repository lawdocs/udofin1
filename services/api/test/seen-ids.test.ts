import { describe, expect, it } from 'vitest';
import { createSeenIds } from '../src/modules/borrower/routes.js';

describe('seen message ids (hook replay guard)', () => {
  it('accepts an id once, refuses a repeat and an empty id', () => {
    const seen = createSeenIds();
    expect(seen.claim('a')).toBe(true);
    expect(seen.claim('a')).toBe(false);
    expect(seen.claim('')).toBe(false);
    expect(seen.claim('b')).toBe(true);
  });
  it('forgets ids after the window and stays bounded', () => {
    let t = 0;
    const seen = createSeenIds(1000, 3, () => t);
    expect(seen.claim('a')).toBe(true);
    t = 2000;
    expect(seen.claim('a')).toBe(true);
    for (const id of ['b', 'c', 'd', 'e']) seen.claim(id);
    expect(seen.claim('e')).toBe(false);
  });
});
