'use server';

import { createApiClient } from '@udofin/auth-client';
import {
  remindersNoticeUrl,
  runRemindersOperation,
  safeRemindersReturnPath,
  type RemindersFormOutcome,
} from '@udofin/portal-kit';
import { redirect } from 'next/navigation';
import { currentSession, portalAuth } from '@/lib/auth';
import { rememberSuccess } from '@/app/_flash';

async function apiFor() {
  const session = await currentSession();
  if (session.state !== 'ok') return null;
  return createApiClient({
    baseUrl: portalAuth().apiBaseUrl,
    getAccessToken: () => Promise.resolve(session.accessToken),
  });
}

/**
 * The entry point for the small reminder forms (approve, retire, release). A form names an allow-listed operation (see
 * runRemindersOperation); the API authorises the call again with the signed-in person's own token. The page goes back to where
 * the form was, with the result as a short notice.
 */
export async function remindersAction(formData: FormData): Promise<void> {
  const returnTo = safeRemindersReturnPath(formData.get('returnTo'));
  const api = await apiFor();
  if (!api) return redirect('/login');
  const outcome = await runRemindersOperation(api, formData);
  // The confirmation is written here, after the API accepted the change, not carried in the address.
  if (outcome.ok) await rememberSuccess(returnTo);
  return redirect(remindersNoticeUrl(returnTo, outcome));
}

/**
 * The entry point for the forms that keep what was typed when they are refused (the drafts and the hold). A refusal is handed
 * back to the form as a stable code; success goes back to the page with the notice.
 */
export async function remindersDraftAction(formData: FormData): Promise<RemindersFormOutcome> {
  const returnTo = safeRemindersReturnPath(formData.get('returnTo'));
  const api = await apiFor();
  if (!api) return redirect('/login');
  const outcome = await runRemindersOperation(api, formData);
  if (!outcome.ok) return outcome;
  await rememberSuccess(returnTo);
  return redirect(remindersNoticeUrl(returnTo, outcome));
}
