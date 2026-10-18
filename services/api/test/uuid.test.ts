import { describe, expect, it } from 'vitest';
import { normaliseUuid, sameUuid } from '../src/http/uuid.js';

describe('uuid comparison', () => {
  const lower = '0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
  it('treats upper and lower case spellings of one uuid as the same identifier', () => {
    expect(normaliseUuid(lower.toUpperCase())).toBe(lower);
    expect(sameUuid(lower, lower.toUpperCase())).toBe(true);
    expect(sameUuid(lower.toUpperCase(), lower)).toBe(true);
  });
  it('still tells two different uuids apart', () => {
    expect(sameUuid(lower, '0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c')).toBe(false);
  });
});
