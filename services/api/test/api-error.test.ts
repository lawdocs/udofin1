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
