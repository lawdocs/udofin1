import { loadConfig } from '../config.js';
import { createRoutingProcessor } from '../system/routing.js';
import { createSystemPool } from '../system/pool.js';
import { buildCallbackApp } from './lender-callbacks.js';

/** Entry point of the lender callback receiver: `pnpm --filter @udofin/api callbacks`. Uses the system login. */
{
  const config = loadConfig();
  if (!config.SYSTEM_DATABASE_URL) {
    process.stderr.write('SYSTEM_DATABASE_URL is required to run the lender callback receiver\n');
    process.exit(1);
  }
  const pool = createSystemPool(config.SYSTEM_DATABASE_URL);
  const app = await buildCallbackApp(config, {
    routing: createRoutingProcessor(pool),
    // Secret references are names of environment variables set by the deployment; values are never read into config files.
    secret: (name) => process.env[name],
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
