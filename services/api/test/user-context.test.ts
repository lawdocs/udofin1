import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { ContextError, createUserContext, type UserTx } from '../src/db/user-context.js';

const CLAIMS = {
  sub: '0f0f0f0f-0000-4000-8000-000000000001',
  aal: 'aal2' as const,
  sessionId: null,
};

function fakePool() {
  const log: string[] = [];
  const params: unknown[][] = [];
  const state = { released: undefined as boolean | undefined, releasedCount: 0, failOn: '' };
  const client = {
    query: (text: string, values?: unknown[]) => {
      log.push(text.trim().split('\n')[0] ?? '');
      if (values) params.push(values);
      if (state.failOn && text.includes(state.failOn)) return Promise.reject(new Error('boom'));
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
    release: (destroy?: boolean) => {
      state.released = destroy;
      state.releasedCount += 1;
    },
  };
  const pool = { connect: () => Promise.resolve(client) } as unknown as Pick<pg.Pool, 'connect'>;
  return { pool, log, params, state };
}

describe('withUserContext', () => {
  it('sets role and claims for the transaction only, then commits', async () => {
    const { pool, log, params, state } = fakePool();
    await createUserContext(pool).withUserContext(CLAIMS, async (tx) => {
      await tx.query('select 1');
    });
    expect(log.slice(0, 3)).toEqual([
      'begin',
      'set local role authenticated',
      "select set_config('request.jwt.claims', $1, true)",
    ]);
    expect(log.at(-1)).toBe('commit');
    expect(JSON.parse(String(params[0]?.[0]))).toEqual({
      sub: CLAIMS.sub,
      role: 'authenticated',
      aal: 'aal2',
    });
    expect(state.released).toBeUndefined();
  });

  it('refuses to use the handle after the transaction ended', async () => {
    const { pool } = fakePool();
    let leaked: UserTx | undefined;
    await createUserContext(pool).withUserContext(CLAIMS, (tx) => {
      leaked = tx;
      return Promise.resolve();
    });
    await expect(leaked?.query('select 1')).rejects.toBeInstanceOf(ContextError);
  });

  it('rolls back and destroys the connection when the callback fails', async () => {
    const { pool, log, state } = fakePool();
    await expect(
      createUserContext(pool).withUserContext(CLAIMS, () => Promise.reject(new Error('nope'))),
    ).rejects.toThrow('nope');
    expect(log.at(-1)).toBe('rollback');
    expect(state.released).toBe(true);
  });

  it('never touches the database with missing or malformed claims', async () => {
    const { pool, log } = fakePool();
    const ctx = createUserContext(pool);
    const bad = [
      {},
      { sub: 'x', aal: 'aal2', sessionId: null },
      { sub: CLAIMS.sub, aal: 'aal3', sessionId: null },
      undefined,
    ];
    for (const claims of bad) {
      await expect(
        ctx.withUserContext(claims as never, () => Promise.resolve(1)),
      ).rejects.toBeInstanceOf(ContextError);
    }
    expect(log).toEqual([]);
  });

  it('does not run the callback when setting up the session fails', async () => {
    const { pool, state } = fakePool();
    state.failOn = 'set local role';
    let ran = false;
    await expect(
      createUserContext(pool).withUserContext(CLAIMS, () => {
        ran = true;
        return Promise.resolve();
      }),
    ).rejects.toThrow('boom');
    expect(ran).toBe(false);
    expect(state.released).toBe(true);
  });
});
