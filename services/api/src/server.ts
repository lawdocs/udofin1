import {
  createLocalDocumentStore,
  createMockIntegrityVerifier,
  createMockSmsSender,
  createUnconfiguredSmsSender,
  createUnavailableIntegrityVerifier,
} from '@udofin/adapters';
import pg from 'pg';
import { buildApp, type ReadinessCheck } from './app.js';
import { createTokenVerifier, supabaseKeys } from './auth/token-verifier.js';
import { loadConfig, sessionIdRequired } from './config.js';
import { assertUserLoginPosture } from './db/login-posture.js';
import { createUserContext, createWebhookDedup } from './db/user-context.js';

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

// Refuse to start if the user-request login could skip row-level security.
if (pool) await assertUserLoginPosture(pool);

const readinessChecks: ReadinessCheck[] = [];
if (pool) {
  readinessChecks.push({
    name: 'database',
    check: async () => {
      await pool.query('select 1');
    },
  });
}

let auth;
if (pool && config.SUPABASE_URL) {
  const { issuer, keys } = supabaseKeys(config.SUPABASE_URL);
  auth = {
    verifier: createTokenVerifier({ issuer, audience: 'authenticated', keys }),
    context: createUserContext(pool),
    // Deployed: a token without a session_id cannot be checked for sign-out, so it is refused (config.ts).
    requireSessionId: sessionIdRequired(config),
  };
}

// Evidence documents need a private, encrypted store. Only the development-only local store is wired
// today. The production store (AWS S3 with KMS, ap-south-1) is a PORT with NO implementation yet, so
// staging and production answer 503 on document routes until that adapter is written and approved.
const documents = config.LOCAL_DOCUMENT_DIR
  ? createLocalDocumentStore(config.LOCAL_DOCUMENT_DIR, config.APP_ENV)
  : undefined;

// SMS and device integrity: only labelled mocks exist today, and the adapters refuse to build outside
// local/test. With no provider configured the routes that need one answer honestly that they cannot run.
const borrower = {
  sms:
    config.SMS_PROVIDER === 'mock'
      ? createMockSmsSender(config.APP_ENV)
      : createUnconfiguredSmsSender(),
  integrity:
    config.INTEGRITY_PROVIDER === 'mock'
      ? createMockIntegrityVerifier(config.APP_ENV)
      : createUnavailableIntegrityVerifier(),
  ...(config.STEPUP_OTP_PEPPER ? { stepUpPepper: config.STEPUP_OTP_PEPPER } : {}),
  ...(config.SEND_SMS_HOOK_SECRET ? { sendSmsHookSecret: config.SEND_SMS_HOOK_SECRET } : {}),
  // Replay protection for the hook that holds across instances (audit F-06). Uses the user pool without
  // end-user claims; the public API never holds the system login.
  ...(pool ? { webhookDedup: createWebhookDedup(pool) } : {}),
  smsTimeoutMs: 4000,
};

const app = await buildApp(config, {
  borrower,
  readinessChecks,
  ...(auth ? { auth } : {}),
  ...(documents ? { documents } : {}),
  // No signing provider is approved (D-13, D-58). Only the labelled mock exists, and the database refuses it unless it allows mock signing.
  ...(config.SIGNING_PROVIDER === 'mock'
    ? { signing: { providerKey: 'mock_esign', mode: 'mock' as const } }
    : {}),
});

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
