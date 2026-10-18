'use server';

import { createApiClient } from '@udofin/auth-client';
import {
  runServicingOperation,
  safeServicingReturnPath,
  servicingNoticeUrl,
  servicingTimeoutMs,
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
  // Applying an import and registering a document take longer than a small write (the same file was given 60 s to stage).
  const timeoutMs = servicingTimeoutMs(formData.get('op'));
  const api = createApiClient({
    baseUrl: portalAuth().apiBaseUrl,
    getAccessToken: () => Promise.resolve(session.accessToken),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
  const outcome = await runServicingOperation(api, formData);
  return redirect(servicingNoticeUrl(returnTo, outcome));
}
