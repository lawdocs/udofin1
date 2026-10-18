import { describe, expect, it } from 'vitest';
import { mapDatabaseError } from '../src/http/api-error.js';

const dbError = (code: string, hint?: string) => ({ code, ...(hint ? { hint } : {}) });

describe('mapDatabaseError: the losing side of a concurrent change (A7)', () => {
  it('maps a protect trigger that finds the record already final to the conflict the function would have raised', () => {
    const task = mapDatabaseError(dbError('P0001', 'task_final'));
    expect([task?.status, task?.code]).toEqual([409, 'already_confirmed']);
    const request = mapDatabaseError(dbError('P0001', 'request_final'));
    expect([request?.status, request?.code]).toEqual([409, 'request_not_open']);
  });

  it('keeps every other P0001 unmapped: an attempt to edit a fixed record is a fault, not a conflict', () => {
    for (const hint of [
      'task_immutable',
      'request_immutable',
      'closure_immutable',
      'document_immutable',
      'row_not_applicable',
      'approval_required',
      'something_else',
    ])
      expect(mapDatabaseError(dbError('P0001', hint)), hint).toBeUndefined();
    expect(mapDatabaseError(dbError('P0001'))).toBeUndefined();
  });

  it('leaves the mappings that already existed as they were', () => {
    expect(mapDatabaseError(dbError('55000', 'already_confirmed'))?.status).toBe(409);
    expect(mapDatabaseError(dbError('P0002'))?.code).toBe('not_found');
    expect(mapDatabaseError(dbError('23514'))?.code).toBe('conflict');
  });
});

describe('mapDatabaseError: the hints of the accounts and activation fixes (SQL migration 20261018000924)', () => {
  // [hint, SQLSTATE the function raises, expected HTTP status]. The status follows the SQLSTATE: 55000 is a conflict, 22023 is
  // an unprocessable request.
  const cases: [string, string, number][] = [
    ['platform_hold', '55000', 409],
    ['active_config_exists', '55000', 409],
    ['own_account_list_not_attested', '55000', 409],
    ['own_account_list_incomplete', '55000', 409],
    ['too_many_claims', '22023', 422],
    ['merchant_already_claimed', '55000', 409],
  ];

  it.each(cases)(
    'maps %s (%s) to %i with the hint as the code and no detail',
    (hint, state, status) => {
      const mapped = mapDatabaseError({ code: state, hint, message: 'a row: lender 1234567890' });
      expect([mapped?.status, mapped?.code]).toEqual([status, hint]);
      // Nothing from the database message reaches the caller.
      expect(mapped?.detail).toBeUndefined();
      expect(JSON.stringify(mapped)).not.toContain('1234567890');
    },
  );

  it('maps the uniqueness violation of a second active configuration to the same stable code', () => {
    const mapped = mapDatabaseError({ code: '23505', hint: 'active_config_exists' });
    expect([mapped?.status, mapped?.code]).toEqual([409, 'active_config_exists']);
  });

  it('answers 403 self_approval when the same platform person tries to lift their own hold', () => {
    const mapped = mapDatabaseError({ code: '42501', hint: 'self_approval' });
    expect([mapped?.status, mapped?.code]).toEqual([403, 'self_approval']);
  });

  it('does not invent a code for a hint that is not on the list', () => {
    expect(mapDatabaseError({ code: '55000', hint: 'platform_hold_typo' })?.code).toBe('conflict');
    expect(mapDatabaseError({ code: '22023', hint: 'too_many_claims_typo' })?.code).toBe(
      'invalid_request',
    );
  });
});
