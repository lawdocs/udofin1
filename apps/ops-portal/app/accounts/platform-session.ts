import { createApiClient } from '@udofin/auth-client';
import { createPlatformClient, platformCaps } from '@udofin/portal-kit';
import { requireSession } from '@/components/session-gate';
import { portalAuth } from '@/lib/auth';

/**
 * What every platform-staff page of Phase 08a needs: the signed-in person (or the explanation to show instead), a client that
 * speaks as that person to the platform routes, the generic client (used only to read the list of lenders for a choice) and
 * what the person may do. The capabilities only decide which forms are drawn; the API and the database authorise every call
 * again.
 */
export async function platformSession() {
  const session = await requireSession();
  if ('blocked' in session) return { blocked: session.blocked } as const;
  const getAccessToken = () => Promise.resolve(session.accessToken);
  const baseUrl = portalAuth().apiBaseUrl;
  return {
    session,
    api: createPlatformClient({ baseUrl, getAccessToken }),
    generic: createApiClient({ baseUrl, getAccessToken }),
    caps: platformCaps(session.me.memberships.flatMap((m) => m.permissions)),
    userId: session.me.userId,
  } as const;
}
