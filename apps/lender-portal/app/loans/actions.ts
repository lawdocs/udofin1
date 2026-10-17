'use server';

import { createApiClient } from '@udofin/auth-client';
import {
  runServicingOperation,
  safeServicingReturnPath,
  servicingNoticeUrl,
} from '@udofin/portal-kit';
import { redirect } from 'next/navigation';
import { currentSession, portalAuth } from '@/lib/auth';

/**
 * The single entry point for the lender servicing forms. A form names an allow-listed operation (see
 * runServicingOperation); the API authorises the call again with the signed-in person's own token. The page goes back to
 * where the form was, with the result as a short notice.
 */
export async function servicingAction(formData: FormData): Promise<void> {
  const returnTo = safeServicingReturnPath(formData.get('returnTo'));
  const session = await currentSession();
  if (session.state !== 'ok') return redirect('/login');
  const api = createApiClient({
    baseUrl: portalAuth().apiBaseUrl,
    getAccessToken: () => Promise.resolve(session.accessToken),
  });
  const outcome = await runServicingOperation(api, formData);
  return redirect(servicingNoticeUrl(returnTo, outcome));
}
