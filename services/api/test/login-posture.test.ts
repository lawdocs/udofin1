import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import {
  assertSystemLoginPosture,
  assertUserLoginPosture,
  LoginPostureError,
  systemLoginViolations,
  type SystemPoolLike,
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

describe('system login posture (audit R-10)', () => {
  const systemSafe = { ...safe, rolcreatedb: false, canAssumeServiceRole: true };
  /** A system pool whose single query returns `row`, or whose switch to service_role fails with `error`. */
  const systemPool = (row: object | undefined, error?: Error): SystemPoolLike => ({
    withSystem: (fn) =>
      error
        ? Promise.reject(error)
        : fn({ query: () => Promise.resolve({ rows: row ? [row] : [] }) } as never),
  });

  it('accepts a login that can only assume service_role', async () => {
    expect(systemLoginViolations(systemSafe)).toEqual([]);
    await expect(assertSystemLoginPosture(systemPool(systemSafe))).resolves.toBeUndefined();
  });

  it.each([
    ['rolsuper', 'is a superuser'],
    ['rolbypassrls', 'can bypass row-level security'],
    ['rolcreaterole', 'can create roles'],
    ['rolcreatedb', 'can create databases'],
    ['rolreplication', 'can start replication'],
    ['memberOfPrivilegedRole', 'is a member of a privileged role other than service_role'],
  ])('refuses to start when %s', async (field, message) => {
    const row = { ...systemSafe, [field]: true };
    expect(systemLoginViolations(row)).toEqual([message]);
    await expect(assertSystemLoginPosture(systemPool(row))).rejects.toThrow(message);
  });

  it('refuses to start when the login cannot assume service_role (membership missing)', async () => {
    const row = { ...systemSafe, canAssumeServiceRole: false };
    expect(systemLoginViolations(row)).toEqual(['cannot assume service_role']);
    await expect(assertSystemLoginPosture(systemPool(row))).rejects.toThrow(
      /cannot assume service_role/,
    );
  });

  it('refuses to start when SET ROLE service_role itself is denied', async () => {
    await expect(
      assertSystemLoginPosture(
        systemPool(undefined, Object.assign(new Error('x'), { code: '42501' })),
      ),
    ).rejects.toThrow(/cannot assume service_role/);
  });

  it('reports a connection problem without echoing its message', async () => {
    const failure = assertSystemLoginPosture(
      systemPool(
        undefined,
        Object.assign(new Error('password=hunter2'), { name: 'ConnectionError' }),
      ),
    );
    await expect(failure).rejects.toBeInstanceOf(LoginPostureError);
    await expect(failure).rejects.not.toThrow(/hunter2/);
  });

  it('refuses when the login cannot be found', async () => {
    await expect(assertSystemLoginPosture(systemPool(undefined))).rejects.toBeInstanceOf(
      LoginPostureError,
    );
  });
});
