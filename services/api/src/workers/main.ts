import { loadConfig } from '../config.js';
import { createChangeRequestApplier } from '../system/change-requests.js';
import { createSystemPool } from '../system/pool.js';
import { createHandlers } from './handlers.js';
import { OutboxWorker, type WorkerLogger } from './outbox-worker.js';
import { createPgOutboxStore } from './pg-outbox-store.js';

// Worker entry point: `pnpm --filter @udofin/api worker`. Uses the system database login only.
const config = loadConfig();
if (!config.SYSTEM_DATABASE_URL) {
  process.stderr.write('SYSTEM_DATABASE_URL is required to run the worker\n');
  process.exit(1);
}

const out = (level: string) => (fields: Record<string, unknown>, message: string) => {
  process.stdout.write(
    `${JSON.stringify({ level, time: new Date().toISOString(), msg: message, ...fields })}\n`,
  );
};
const log: WorkerLogger = { info: out('info'), warn: out('warn'), error: out('error') };

const pool = createSystemPool(config.SYSTEM_DATABASE_URL);
const applier = createChangeRequestApplier(pool);
const handlers = createHandlers({
  applier,
  changeRequestStatus: (id) =>
    pool.withSystem(async (tx) => {
      const r = await tx.query<{ status: string }>(
        'select status::text as status from tenancy.change_requests where id = $1::uuid',
        [id],
      );
      return r.rows[0]?.status;
    }),
});

const worker = new OutboxWorker({
  store: createPgOutboxStore(pool),
  handlers,
  workerId: `worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
  log,
});

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, 'worker stopping');
  await worker.stop();
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

worker.start();
log.info({}, 'worker started');
