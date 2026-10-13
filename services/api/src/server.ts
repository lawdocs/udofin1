import pg from 'pg';
import { buildApp, type ReadinessCheck } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();

const pool = config.DATABASE_URL
  ? new pg.Pool({
      connectionString: config.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      application_name: 'udofin-api',
      // Server-side limits so a stuck query or abandoned transaction cannot hold a connection forever.
      statement_timeout: 30_000,
      idle_in_transaction_session_timeout: 30_000,
    })
  : undefined;

// An idle connection can fail (database restart, network drop). Without a listener Node treats the
// event as uncaught and kills the process without a graceful shutdown.
pool?.on('error', (error) => {
  process.stderr.write(
    `${JSON.stringify({ level: 'error', msg: 'idle database client error', type: error.name })}\n`,
  );
});

const readinessChecks: ReadinessCheck[] = [];
if (pool) {
  readinessChecks.push({
    name: 'database',
    check: async () => {
      await pool.query('select 1');
    },
  });
}

const app = await buildApp(config, { readinessChecks });

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  try {
    await app.close();
    await pool?.end();
    process.exit(0);
  } catch (error) {
    app.log.error({ err: error }, 'error during shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.HOST, port: config.PORT });
