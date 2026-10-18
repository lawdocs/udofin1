import { createApiClient } from '@udofin/auth-client';
import { paymentSetupGrants } from '@udofin/portal-kit';
import { requireSession } from '@/components/session-gate';
import { portalAuth } from '@/lib/auth';
import { successNotice } from '@/lib/flash';

/**
 * What every payment-setup page needs: the signed-in person (or the explanation to show instead), an API client that speaks as
 * that person, what that person may do in each of their lenders, and who they are (so a decide form is never drawn for a
 * configuration they drafted or submitted). The grants only decide which forms are drawn; the API and the database authorise
 * every call again.
 */
export async function setupSession() {
  const session = await requireSession();
  if ('blocked' in session) return { blocked: session.blocked } as const;
  const api = createApiClient({
    baseUrl: portalAuth().apiBaseUrl,
    getAccessToken: () => Promise.resolve(session.accessToken),
  });
  return {
    session,
    api,
    grants: paymentSetupGrants(session.me.memberships),
    userId: session.me.userId,
  } as const;
}

/**
 * The result notice of the last action on this page. A success is what the server wrote after the API accepted the change, for
 * this page, a few seconds ago; the page address cannot claim one. An error is a closed code in the address that is shown only as
 * a fixed sentence.
 */
export async function noticeFrom(
  query: Record<string, string | string[] | undefined>,
  path: string,
) {
  return {
    done: (await successNotice(path)) !== undefined,
    error: typeof query.error === 'string' ? query.error : undefined,
  };
}

/** The page address to return to after an action: the same list filters, never the result notice. */
export function returnPath(
  base: string,
  query: Record<string, string | string[] | undefined>,
  keys: readonly string[],
): string {
  const params = new URLSearchParams();
  for (const key of keys) {
    const value = query[key];
    if (typeof value === 'string' && value !== '') params.set(key, value);
  }
  const text = params.toString();
  return text ? `${base}?${text}` : base;
}
