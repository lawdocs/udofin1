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

describe('mapDatabaseError: hints added by the servicing sync fixes (migration 925)', () => {
  it('maps incoming_not_stored (55000) to a 409 with its own code and no message', () => {
    const mapped = mapDatabaseError({
      code: '55000',
      hint: 'incoming_not_stored',
      message: 'the incoming version must be stored first: LOAN-123',
    });
    expect([mapped?.status, mapped?.code, mapped?.detail]).toEqual([
      409,
      'incoming_not_stored',
      undefined,
    ]);
  });

  it('maps validity_too_long (22023) to a 422 with its own code and no message', () => {
    const mapped = mapDatabaseError({
      code: '22023',
      hint: 'validity_too_long',
      message: 'valid until 2027-12-31 is more than 31 days after the as-of date',
    });
    expect([mapped?.status, mapped?.code, mapped?.detail]).toEqual([
      422,
      'validity_too_long',
      undefined,
    ]);
  });

  it('does not map either hint under an unrelated SQLSTATE (the hint alone does not decide)', () => {
    expect(mapDatabaseError(dbError('P0001', 'incoming_not_stored'))).toBeUndefined();
    expect(mapDatabaseError(dbError('P0001', 'validity_too_long'))).toBeUndefined();
  });
});

describe('mapDatabaseError: hints the reminders fixes rely on (migration 923)', () => {
  it('maps a stale send report (55000 not_claimed), a note over the limit (22023 hold_invalid) and the wording refusal (22023 wording_invalid)', () => {
    const stale = mapDatabaseError(dbError('55000', 'not_claimed'));
    expect([stale?.status, stale?.code]).toEqual([409, 'not_claimed']);
    const hold = mapDatabaseError(dbError('22023', 'hold_invalid'));
    expect([hold?.status, hold?.code]).toEqual([422, 'hold_invalid']);
    const wording = mapDatabaseError(dbError('22023', 'wording_invalid'));
    expect([wording?.status, wording?.code]).toEqual([422, 'wording_invalid']);
  });
});
