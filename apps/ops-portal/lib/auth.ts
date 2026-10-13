import { createPortalAuth, type PortalAuth } from '@udofin/auth-client/web';
import { headers } from 'next/headers';

let cached: PortalAuth | undefined;

/** Server-only. Validates the environment on first use (and at start-up via instrumentation.ts). */
export function portalAuth(): PortalAuth {
  cached ??= createPortalAuth(process.env, 'platform');
  return cached;
}

/** Who the API says the current request is (null cookies mean signed out). */
export async function currentSession() {
  return portalAuth().handlers.portalSession({ headers: await headers() });
}
