'use server';

import { createApiClient } from '@udofin/auth-client';
import { lpIsUuid, lpRunOperation, lpSafeReturnPath } from '@udofin/portal-kit';
import { redirect } from 'next/navigation';
import { currentSession, portalAuth } from '@/lib/auth';
import { rememberSuccess } from '@/lib/flash';

/**
 * The single entry point for the payment, mandate and reconciliation forms. A form names an operation from the allow-list in
 * `lpRunOperation`; anything else is refused before a request is made. The API authorises every call again with the signed-in
 * person's own token, and the answer comes back only as a stable code or a count: the server's own text never reaches the page.
 */
export async function paymentsAction(formData: FormData): Promise<void> {
  const returnTo = lpSafeReturnPath(formData.get('returnTo'));
  const session = await currentSession();
  if (session.state !== 'ok') return redirect('/login');
  const api = createApiClient({
    baseUrl: portalAuth().apiBaseUrl,
    getAccessToken: () => Promise.resolve(session.accessToken),
  });
  const outcome = await lpRunOperation(api, formData);
  const params = new URLSearchParams();
  // A person who belongs to several lenders comes back to the lender the form was for (an identifier, checked), not to another.
  const lenderId = formData.get('lenderId');
  if (lpIsUuid(lenderId)) params.set('lenderId', lenderId);
  if (outcome.ok) {
    // The confirmation (and the counts of an upload) are written here, after the API accepted the change: a count or a "done" in
    // the address could be written by anybody.
    await rememberSuccess(returnTo, outcome.counts ? { counts: outcome.counts } : {});
  } else {
    // Only a stable code travels in the address; anything else becomes a neutral one.
    params.set('error', /^[a-z0-9_]{1,60}$/.test(outcome.code) ? outcome.code : 'failed');
  }
  const query = params.toString();
  return redirect(query ? `${returnTo}?${query}` : returnTo);
}
