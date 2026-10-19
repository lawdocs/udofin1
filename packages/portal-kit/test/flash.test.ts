// @vitest-environment node
// The success notice of the last action is written by the server, in a short-lived cookie, and read back only for the page it
// was written for. A confirmation that arrives any other way (an address, a stale or foreign cookie, a malformed value) is
// never shown.
import { LP_BANK_CREDIT_MAX_ROWS } from '@udofin/contracts';
import { describe, expect, it } from 'vitest';
import {
  FLASH_TTL_SECONDS,
  flashCookieName,
  flashIsDone,
  flashIsExisting,
  flashPathOf,
  openFlash,
  sealFlash,
  type Flash,
} from '../src/flash.js';

const NOW = Date.UTC(2026, 9, 18, 10, 0, 0);
const ENTRY = '0190a000-0000-7000-8000-000000000a01';

const b64 = (value: unknown): string =>
  btoa(typeof value === 'string' ? value : JSON.stringify(value))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');

describe('a notice written by the server for one page', () => {
  it('is read back for the page it was written for, with only what was put in it', () => {
    const sealed = sealFlash({ path: '/loans/requests' }, NOW);
    expect(sealed).toBeTypeOf('string');
    expect(openFlash(sealed, '/loans/requests', NOW + 1000)).toEqual({ path: '/loans/requests' });
  });

  it('carries the counts of an upload, a decision and the entry that was registered', () => {
    const counts = sealFlash(
      { path: '/reconciliation/bank-credits', counts: { inserted: 7, duplicates: 2 } },
      NOW,
    );
    expect(openFlash(counts, '/reconciliation/bank-credits', NOW)).toEqual({
      path: '/reconciliation/bank-credits',
      counts: { inserted: 7, duplicates: 2 },
    });
    const decided = sealFlash({ path: '/features', result: 'applied' }, NOW);
    expect(openFlash(decided, '/features', NOW)).toEqual({ path: '/features', result: 'applied' });
    const registered = sealFlash({ path: '/accounts', registered: ENTRY }, NOW);
    expect(openFlash(registered, '/accounts', NOW)).toEqual({
      path: '/accounts',
      registered: ENTRY,
    });
  });

  it('carries that a file had been received before', () => {
    const sealed = sealFlash(
      { path: '/imports/0190a000-0000-7000-8000-000000000b01', existing: true },
      NOW,
    );
    expect(openFlash(sealed, '/imports/0190a000-0000-7000-8000-000000000b01', NOW)).toEqual({
      path: '/imports/0190a000-0000-7000-8000-000000000b01',
      existing: true,
    });
  });

  it('is shown on its own page only', () => {
    const sealed = sealFlash({ path: '/payments/policy' }, NOW);
    for (const other of ['/payments', '/mandates/policy', '/payments/policy/', '/', '']) {
      expect(openFlash(sealed, other, NOW), other).toBeUndefined();
    }
  });

  it('lasts twenty seconds', () => {
    expect(FLASH_TTL_SECONDS).toBe(20);
    const sealed = sealFlash({ path: '/loans' }, NOW);
    expect(openFlash(sealed, '/loans', NOW + 19_999)).toBeDefined();
    expect(openFlash(sealed, '/loans', NOW + 20_000)).toBeDefined();
    expect(openFlash(sealed, '/loans', NOW + 20_001)).toBeUndefined();
    expect(openFlash(sealed, '/loans', NOW + 3_600_000)).toBeUndefined();
  });

  it('is not believed when it claims to come from the future', () => {
    const sealed = sealFlash({ path: '/loans' }, NOW + 60_000);
    expect(openFlash(sealed, '/loans', NOW)).toBeUndefined();
    // A few seconds of difference between two clocks is tolerated.
    expect(openFlash(sealFlash({ path: '/loans' }, NOW + 3000), '/loans', NOW)).toBeDefined();
  });

  it('is never written for a path, code, identifier or count it would not read back', () => {
    const bad: Record<string, unknown>[] = [
      { path: '/loans?done=1' },
      { path: 'loans' },
      { path: '/loans/<b>' },
      { path: `/${'a'.repeat(250)}` },
      { path: '/loans', result: 'Applied' },
      { path: '/loans', result: 'applied; drop' },
      { path: '/accounts', registered: 'XXXXXX1234' },
      { path: '/accounts', registered: ENTRY.toUpperCase() },
      { path: '/x', counts: { inserted: -1, duplicates: 0 } },
      { path: '/x', counts: { inserted: 1.5, duplicates: 0 } },
      { path: '/x', counts: { inserted: 0, duplicates: LP_BANK_CREDIT_MAX_ROWS + 1 } },
      { path: '/x', existing: false },
    ];
    for (const flash of bad)
      expect(sealFlash(flash as unknown as Flash, NOW), JSON.stringify(flash)).toBeUndefined();
    // A path outside the Latin-1 range would make the encoder throw after a change had already been accepted.
    expect(() => sealFlash({ path: '/lån' }, NOW)).not.toThrow();
    expect(sealFlash({ path: '/lån' }, NOW)).toBeUndefined();
  });

  it('is cookie-safe: letters, digits, hyphen and underscore only', () => {
    const sealed = sealFlash(
      { path: '/reconciliation/bank-credits', counts: { inserted: 1, duplicates: 1 } },
      NOW,
    );
    expect(sealed).toMatch(/^[A-Za-z0-9_-]+$/);
    expect((sealed ?? '').length).toBeLessThan(300);
  });
});

describe('a forged or damaged notice is never shown', () => {
  const read = (value: string | undefined, path = '/features') => openFlash(value, path, NOW);
  const at = { p: '/features', t: NOW };

  it('shows nothing without a cookie', () => {
    expect(read(undefined)).toBeUndefined();
    expect(read('')).toBeUndefined();
  });

  it('shows nothing for what is not an encoded notice', () => {
    for (const value of [
      '1',
      'done=1',
      'applied',
      '!!!',
      '%7B%22p%22%3A%22%2Ffeatures%22%7D',
      b64('not json'),
      b64('null'),
      b64('[]'),
      b64('"features"'),
      b64('42'),
      'a'.repeat(601),
    ])
      expect(read(value), value.slice(0, 30)).toBeUndefined();
  });

  it('shows nothing for a notice with a missing, foreign or malformed part', () => {
    const cases: unknown[] = [
      {},
      { t: NOW },
      { p: '/features' },
      { p: '/other', t: NOW },
      { p: '/features', t: 'now' },
      { p: '/features', t: null },
      { p: ['/features'], t: NOW },
      { ...at, extra: 1 },
      { ...at, x: '<script>' },
      { ...at, i: 1 },
      { ...at, u: 1 },
      { ...at, i: '1', u: '1' },
      { ...at, i: 1.2, u: 1 },
      { ...at, i: -1, u: 1 },
      { ...at, i: LP_BANK_CREDIT_MAX_ROWS + 1, u: 0 },
      { ...at, i: 2000, u: 2000, r: 5 },
      { ...at, r: 'Applied' },
      { ...at, r: '<b>applied</b>' },
      { ...at, r: ['applied'] },
      { ...at, g: 'XXXXXX1234' },
      { ...at, g: ENTRY.toUpperCase() },
      { ...at, g: 7 },
      { ...at, x: 0 },
      { ...at, x: true },
      { ...at, x: '1' },
    ];
    for (const raw of cases) expect(read(b64(raw)), JSON.stringify(raw)).toBeUndefined();
  });

  it('shows what is well formed, to prove the cases above fail for their own reasons', () => {
    expect(read(b64(at))).toEqual({ path: '/features' });
    expect(read(b64({ ...at, i: 2, u: 1, r: 'applied', g: ENTRY }))).toEqual({
      path: '/features',
      counts: { inserted: 2, duplicates: 1 },
      result: 'applied',
      registered: ENTRY,
    });
  });
});

describe('the cookie and the path', () => {
  it('is origin-locked on HTTPS and plain over local http', () => {
    expect(flashCookieName(true)).toBe('__Host-udofin_flash');
    expect(flashCookieName(false)).toBe('udofin_flash');
  });

  it('takes the path of an address and drops its query', () => {
    expect(flashPathOf('/loans/requests?lenderId=x&cursor=y')).toBe('/loans/requests');
    expect(flashPathOf('/loans')).toBe('/loans');
    expect(flashPathOf('/accounts?error=x')).toBe('/accounts');
  });
});

describe('what a notice says', () => {
  it('confirms a recorded change when there is a notice, and only then', () => {
    expect(flashIsDone(undefined)).toBe(false);
    expect(flashIsDone({ path: '/loans' })).toBe(true);
    expect(flashIsDone({ path: '/accounts', registered: ENTRY })).toBe(true);
    expect(flashIsDone({ path: '/features', result: 'applied' })).toBe(true);
  });

  it('keeps "the file had been received before" apart from "a change was recorded"', () => {
    const received = { path: '/imports/x', existing: true as const };
    expect(flashIsExisting(received)).toBe(true);
    expect(flashIsDone(received)).toBe(false);
    expect(flashIsExisting({ path: '/loans' })).toBe(false);
    expect(flashIsExisting(undefined)).toBe(false);
  });
});
