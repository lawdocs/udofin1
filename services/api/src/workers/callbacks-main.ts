import { loadConfig } from '../config.js';
import { assertSystemLoginPosture } from '../db/login-posture.js';
import { createRoutingProcessor } from '../system/routing.js';
import { createSystemPool } from '../system/pool.js';
import { buildCallbackApp } from './lender-callbacks.js';
import { IP_HMAC_SECRET_NAME, registerProviderHooks } from './provider-callbacks.js';
import { createSecretReader } from '../system/secret-namespace.js';

/** Entry point of the lender callback receiver: `pnpm --filter @udofin/api callbacks`. Uses the system login. */
{
  const config = loadConfig();
  if (!config.SYSTEM_DATABASE_URL) {
    process.stderr.write('SYSTEM_DATABASE_URL is required to run the lender callback receiver\n');
    process.exit(1);
  }
  const pool = createSystemPool(config.SYSTEM_DATABASE_URL);
  // Refuse to start if the system login is over-privileged or cannot assume service_role (audit R-10).
  await assertSystemLoginPosture(pool);
  const app = await buildCallbackApp(config, {
    routing: createRoutingProcessor(pool),
    // Secret references are names of environment variables set by the deployment; values are never read into config files.
    secret: (name) => process.env[name],
    environment: config.APP_ENV,
  });
  // Phase 08a: signed payment-provider and mandate events (verified here, applied by the database).
  // Only the platform's own address-hash key and names inside a lender namespace are ever read; the receiver also refuses a
  // configuration whose secret names are not inside its lender's namespace (system/provider-hooks.ts, U51).
  registerProviderHooks(app, {
    pool,
    secret: createSecretReader(process.env, [IP_HMAC_SECRET_NAME]),
    environment: config.APP_ENV,
  });
  const stop = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));
  await app.listen({ host: config.HOST, port: config.PORT });
}
