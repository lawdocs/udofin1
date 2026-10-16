import { handoffKeyringOf, loadConfig } from '../config.js';
import { assertSystemLoginPosture } from '../db/login-posture.js';
import { createBorrowerProcessor } from '../system/borrower.js';
import { createChangeRequestApplier } from '../system/change-requests.js';
import { createSystemPool } from '../system/pool.js';
import {
  createLocalDocumentStore,
  createMockLenderConnector,
  createMockSmsSender,
  createMockSigningProvider,
  createUnconfiguredSigningProvider,
  createUnconfiguredSmsSender,
} from '@udofin/adapters';
import { createDocumentProcessor } from '../system/documents.js';
import { createRoutingProcessor } from '../system/routing.js';
import { createHandlers } from './handlers.js';
import { createConnectorResolver } from './routing-handlers.js';
import { startPeriodicJobs } from './periodic-jobs.js';
import { createProviderResolver } from './provider-resolver.js';
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
// Refuse to start if the system login is over-privileged or cannot assume service_role (audit R-10).
await assertSystemLoginPosture(pool);
const applier = createChangeRequestApplier(pool);
const borrower = createBorrowerProcessor(pool);
const routing = createRoutingProcessor(pool);
const documentProcessor = createDocumentProcessor(pool);
// Same private store as the API (development-only local files until the AWS store exists). Without one, generation is recorded as failed.
const documentStore = config.LOCAL_DOCUMENT_DIR
  ? createLocalDocumentStore(config.LOCAL_DOCUMENT_DIR, config.APP_ENV)
  : undefined;
// Phase 08a: the worker alone resolves payment and mandate providers (by secret NAME) and seals hand-off links.
const providers = createProviderResolver({
  environment: config.APP_ENV,
  secret: (name) => process.env[name],
});
const keyring = handoffKeyringOf(config);
const handlers = createHandlers({
  payments: { pool, providers, keyring, log },
  servicing: { pool, log },
  applier,
  borrower,
  routing,
  documents: {
    processor: documentProcessor,
    store: documentStore,
    // No signing provider or SMS provider is approved; only labelled mocks exist, refused outside local and test.
    signing:
      config.SIGNING_PROVIDER === 'mock'
        ? createMockSigningProvider(config.APP_ENV)
        : createUnconfiguredSigningProvider(),
    sms:
      config.SMS_PROVIDER === 'mock'
        ? createMockSmsSender(config.APP_ENV)
        : createUnconfiguredSmsSender(),
  },
  // No real lender connector exists yet. `mock` rows are refused outside local and test (see createConnectorResolver).
  connectors: createConnectorResolver({
    environment: config.APP_ENV,
    createMock: () => createMockLenderConnector(config.APP_ENV),
  }),
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

const periodicJobs = startPeriodicJobs({ pool, providers, environment: config.APP_ENV, log });

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, 'worker stopping');
  periodicJobs.stop();
  await worker.stop();
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

// Housekeeping: keep stored draft statuses honest. Reads and writes already enforce expiry on their own.
const housekeeping = setInterval(
  () => {
    borrower
      .expireDrafts()
      .then((n) => {
        if (n > 0) log.info({ expired: n }, 'drafts expired');
        return routing.processDeadlines();
      })
      .then((r) => {
        if (r.noResponse > 0 || r.offersExpired > 0)
          log.info({ ...r }, 'lender deadlines processed');
        return documentProcessor.processExpiry();
      })
      .then((r) => {
        if (r.expired > 0 || r.withdrawn > 0 || r.jobsInterrupted > 0)
          log.info({ ...r }, 'document deadlines processed');
        // Webhook de-duplication rows only need to outlive the 5-minute signature window; keep a day.
        return pool.withSystem(async (tx) => {
          const purged = await tx.query<{ n: number }>(
            "select ops.purge_seen_webhooks(interval '1 day', 1000) as n",
          );
          return purged.rows[0]?.n ?? 0;
        });
      })
      .then((n) => {
        if (n > 0) log.info({ purged: n }, 'webhook de-duplication rows purged');
      })
      .catch((error: unknown) => {
        log.warn({ type: (error as Error).name }, 'draft expiry housekeeping failed');
      });
  },
  5 * 60 * 1000,
);
housekeeping.unref();

worker.start();
log.info({}, 'worker started');
