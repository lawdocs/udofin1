import { type AppEnvironment } from '@udofin/adapters';
import { type FastifyInstance } from 'fastify';
import { type SystemPool } from '../system/pool.js';

export interface ProviderHookDeps {
  readonly pool: SystemPool;
  /** Resolves the NAME of a secret to its value (environment variables or a secrets manager). Never logged. */
  secret(name: string): string | undefined;
  readonly environment: AppEnvironment;
}

/**
 * Registers `POST /v1/hooks/provider/:endpointToken` on the callback-receiver app (the separate process that holds the system
 * login; the public API never does). Wave 5 (builder D) fills this in.
 */
export function registerProviderHooks(_app: FastifyInstance, _deps: ProviderHookDeps): void {
  // Nothing registered yet.
}
