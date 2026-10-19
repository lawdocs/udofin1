// The ONLY module allowed to hold the system (service_role) database pool. Import boundary:
// only files under src/system and src/workers may import this file (eslint + test/boundary.test.ts).
import pg from 'pg';

export interface SystemPool {
  /** Runs `fn` in one transaction as `service_role`. */
  withSystem<T>(fn: (tx: pg.PoolClient) => Promise<T>): Promise<T>;
  end(): Promise<void>;
}

export function createSystemPool(connectionString: string): SystemPool {
  const pool = new pg.Pool({
    connectionString,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: 'udofin-system',
    statement_timeout: 120_000,
    idle_in_transaction_session_timeout: 60_000,
  });
  pool.on('error', (error) => {
    process.stderr.write(
      `${JSON.stringify({ level: 'error', msg: 'idle system database client error', type: error.name })}\n`,
    );
  });
  return {
    async withSystem(fn) {
      const client = await pool.connect();
      let failed = false;
      try {
        await client.query('begin');
        await client.query('set local role service_role');
        const result = await fn(client);
        await client.query('commit');
        return result;
      } catch (error) {
        failed = true;
        try {
          await client.query('rollback');
        } catch {
          // destroyed below
        }
        throw error;
      } finally {
        client.release(failed ? true : undefined);
      }
    },
    end: () => pool.end(),
  };
}
