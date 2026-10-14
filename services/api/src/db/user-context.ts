import type pg from 'pg';
import { z } from 'zod';
import type { VerifiedClaims } from '../auth/token-verifier.js';

/**
 * Query handle that is valid only inside one `withUserContext` transaction. After the transaction
 * ends it throws, so a handle that leaks (stored in a closure, returned, used in a timer) can never
 * run SQL on a connection that has been handed to another request.
 */
export interface UserTx {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<pg.QueryResult<R>>;
}

export interface UserContext {
  withUserContext<T>(claims: VerifiedClaims, fn: (tx: UserTx) => Promise<T>): Promise<T>;
}

export class ContextError extends Error {
  override readonly name = 'ContextError';
}

// Defence in depth: even though claims come from the verifier, re-check their shape here so this
// helper can never be called with a hand-built object that would make `auth.uid()` something odd.
const ClaimsGuard = z.object({
  sub: z.uuid(),
  aal: z.enum(['aal1', 'aal2']),
  sessionId: z.string().nullable(),
});

/**
 * Runs `fn` in a transaction as the database role `authenticated` with the caller's claims set for
 * that transaction only (`SET LOCAL`). Row Level Security then applies exactly as it does for
 * any end user. Fails closed: invalid claims never reach the database.
 */
export function createUserContext(pool: Pick<pg.Pool, 'connect'>): UserContext {
  return {
    async withUserContext(claims, fn) {
      const checked = ClaimsGuard.safeParse(claims);
      if (!checked.success) throw new ContextError('invalid claims');

      const client = await pool.connect();
      let live = false;
      let failed = false;
      try {
        await client.query('begin');
        await client.query('set local role authenticated');
        await client.query("select set_config('request.jwt.claims', $1, true)", [
          JSON.stringify({
            sub: checked.data.sub,
            role: 'authenticated',
            aal: checked.data.aal,
            ...(checked.data.sessionId ? { session_id: checked.data.sessionId } : {}),
          }),
        ]);
        live = true;
        const tx: UserTx = {
          query: (text, values) => {
            if (!live) {
              return Promise.reject(new ContextError('transaction handle used after it ended'));
            }
            // pg accepts a mutable array; copy so callers cannot mutate parameters mid-flight.
            return client.query(text, values ? [...values] : undefined);
          },
        };
        const result = await fn(tx);
        live = false;
        await client.query('commit');
        return result;
      } catch (error) {
        live = false;
        failed = true;
        try {
          await client.query('rollback');
        } catch {
          // The connection is unusable; it is destroyed below.
        }
        throw error;
      } finally {
        live = false;
        // `release(true)` destroys the connection after a failure so no half-configured session
        // (role, claims) can ever be reused.
        client.release(failed ? true : undefined);
      }
    },
  };
}

/**
 * Durable "first delivery only" guard for signed webhooks, shared by every API instance (audit F-06).
 *
 * The public API process must not hold the system login, and a hook has no end user. So this runs one
 * call as role `authenticated` WITHOUT user claims, against `private.mark_webhook_seen`, a narrowly granted
 * definer function that refuses any call carrying a user identity. Callers must verify the signature
 * BEFORE calling this: only authenticated message ids may be recorded.
 */
export interface WebhookDedup {
  /** True the first time (source, id) is seen anywhere; false for a repeat. Rejects when the database is unavailable (fail closed). */
  claim(source: string, id: string): Promise<boolean>;
}

export function createWebhookDedup(pool: Pick<pg.Pool, 'connect'>): WebhookDedup {
  return {
    async claim(source, id) {
      const client = await pool.connect();
      let failed = false;
      try {
        await client.query('begin');
        await client.query('set local role authenticated');
        // No identity: clear any claims so the function's "no user" rule is what it checks.
        await client.query("select set_config('request.jwt.claims', '', true)");
        const result = await client.query<{ first: boolean }>(
          'select private.mark_webhook_seen($1, $2) as first',
          [source, id],
        );
        await client.query('commit');
        return result.rows[0]?.first === true;
      } catch (error) {
        failed = true;
        try {
          await client.query('rollback');
        } catch {
          // The connection is unusable; it is destroyed below.
        }
        throw error;
      } finally {
        client.release(failed ? true : undefined);
      }
    },
  };
}
