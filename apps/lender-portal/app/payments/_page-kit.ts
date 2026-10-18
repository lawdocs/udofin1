import { createApiClient } from '@udofin/auth-client';
import {
  LP_LIST_KEYS,
  lpAskedLender,
  lpCapabilitiesFrom,
  lpKeepParams,
  lpLenderFrom,
  lpLendersOf,
  lpPermissionsIn,
  type LpParams,
  type LpResult,
  type LpViewContext,
} from '@udofin/portal-kit';
import { connection } from 'next/server';
import { requireSession } from '@/components/session-gate';
import { portalAuth } from '@/lib/auth';
import { successNotice } from '@/lib/flash';
import { paymentsAction } from './actions';

/**
 * What every payment, mandate and reconciliation page needs: the signed-in person (or the explanation to show instead), an API
 * client that carries their own token, what their role may do (for hiding forms only; the API decides) and the page parameters.
 */
export async function paymentsPage(searchParams: Promise<LpParams>) {
  await connection();
  const session = await requireSession();
  if ('blocked' in session) return { blocked: session.blocked } as const;
  const query = await searchParams;
  const api = createApiClient({
    baseUrl: portalAuth().apiBaseUrl,
    getAccessToken: () => Promise.resolve(session.accessToken),
  });
  // The lender the screens act for (the one chosen in the address when the person belongs to it, else the first that holds a
  // payment permission), and what the person may do in that lender (not in any other organisation).
  const lenderId = lpLenderFrom(session.me.memberships, lpAskedLender(query));
  return {
    me: session.me,
    api,
    query,
    caps: lpCapabilitiesFrom(lpPermissionsIn(session.me.memberships, lenderId)),
    lenderId,
    lenders: lpLendersOf(session.me.memberships),
    userId: session.me.userId,
  } as const;
}

type Ready = Exclude<Awaited<ReturnType<typeof paymentsPage>>, { blocked: unknown }>;

/** The context the views draw their forms with. */
export const viewContext = (page: Ready, returnTo: string): LpViewContext => ({
  action: paymentsAction,
  returnTo,
  caps: page.caps,
  userId: page.userId,
  lenders: page.lenders,
  ...(page.lenderId ? { lenderId: page.lenderId } : {}),
});

const NOT_ALLOWED = {
  ok: false,
  status: 403,
  code: 'forbidden',
} as const satisfies LpResult<never>;
/** Used when the person has no lender organisation to act for: the page says so instead of guessing one. */
export const noLender: LpResult<never> = NOT_ALLOWED;

export const firstParam = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

/** The filters to carry to the next page of a list. */
export const keepFilters = (query: LpParams, list: keyof typeof LP_LIST_KEYS) =>
  lpKeepParams(
    query,
    LP_LIST_KEYS[list].filter((key) => key !== 'cursor'),
  );

const CODE = /^[a-z0-9_]{1,60}$/;

/**
 * The outcome of the last form on this page. A success, and the counts of a bank-credit upload, are what the server wrote after
 * the API accepted the change, for this page, a few seconds ago: neither can be claimed by the address. Only a stable error code
 * can arrive in the address, and it is shown as a fixed sentence.
 */
export async function noticeFrom(query: LpParams, path: string) {
  const error = firstParam(query.error);
  const notice = await successNotice(path);
  return {
    done: notice !== undefined,
    error: error !== undefined && CODE.test(error) ? error : undefined,
    inserted: notice?.counts?.inserted,
    duplicates: notice?.counts?.duplicates,
  };
}
