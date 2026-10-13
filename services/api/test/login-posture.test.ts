import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import {
  assertUserLoginPosture,
  LoginPostureError,
  userLoginViolations,
} from '../src/db/login-posture.js';

const safe = {
  rolsuper: false,
  rolbypassrls: false,
  rolcreaterole: false,
  canAssumeServiceRole: false,
};
const poolReturning = (row: object | undefined) =>
  ({ query: () => Promise.resolve({ rows: row ? [row] : [] }) }) as unknown as Pick<
    pg.Pool,
    'query'
  >;

describe('user login posture', () => {
  it('accepts a restricted login', async () => {
    expect(userLoginViolations(safe)).toEqual([]);
    await expect(assertUserLoginPosture(poolReturning(safe))).resolves.toBeUndefined();
  });

  it.each([
    ['rolsuper', 'is a superuser'],
    ['rolbypassrls', 'can bypass row-level security'],
    ['canAssumeServiceRole', 'can assume service_role'],
    ['rolcreaterole', 'can create roles'],
  ])('refuses to start when %s', async (field, message) => {
    const row = { ...safe, [field]: true };
    expect(userLoginViolations(row)).toEqual([message]);
    await expect(assertUserLoginPosture(poolReturning(row))).rejects.toBeInstanceOf(
      LoginPostureError,
    );
  });

  it('refuses when the login cannot be inspected', async () => {
    await expect(assertUserLoginPosture(poolReturning(undefined))).rejects.toBeInstanceOf(
      LoginPostureError,
    );
  });
});
