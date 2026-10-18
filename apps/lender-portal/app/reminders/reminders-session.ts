import { createApiClient } from '@udofin/auth-client';
import { reminderGrants } from '@udofin/portal-kit';
import { requireSession } from '@/components/session-gate';
import { portalAuth } from '@/lib/auth';

/**
 * What every reminders page needs: the signed-in person (or the explanation to show instead), an API client that speaks as that
 * person, what that person may do in each of their lenders, and who they are (so an approve form is never drawn for something
 * they drafted). The grants only decide which forms are drawn; the API and the database authorise every call again.
 */
export async function remindersSession() {
  const session = await requireSession();
  if ('blocked' in session) return { blocked: session.blocked } as const;
  const api = createApiClient({
    baseUrl: portalAuth().apiBaseUrl,
    getAccessToken: () => Promise.resolve(session.accessToken),
  });
  return {
    session,
    api,
    grants: reminderGrants(session.me.memberships),
    userId: session.me.userId,
  } as const;
}

/** The result notice of the last action, read from the page address. */
export function noticeFrom(query: Record<string, string | string[] | undefined>) {
  return {
    done: query.done === '1',
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

/** The filters every reminders list keeps when an action sends the person back to it. */
export const KEPT_FILTERS = [
  'lenderId',
  'status',
  'kind',
  'language',
  'channel',
  'suppressReason',
  'loanAccountId',
  'cursor',
] as const;
