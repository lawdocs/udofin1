'use server';

import {
  accountRegisteredUrl,
  accountsNoticeUrl,
  createPlatformClient,
  runAccountRegistration,
  runAccountsOperation,
  safeAccountsReturnPath,
} from '@udofin/portal-kit';
import { redirect } from 'next/navigation';
import { currentSession, portalAuth } from '@/lib/auth';

/**
 * The single entry point for the platform-staff forms (providers, the account registry, feature switches, exceptions). A form
 * names an allow-listed operation (see runAccountsOperation); the API authorises the call again with the signed-in person's own
 * token. The page goes back to where the form was, with the result as a short notice. The account registration is refused here:
 * it has its own entry point below.
 */
export async function platformAction(formData: FormData): Promise<void> {
  const returnTo = safeAccountsReturnPath(formData.get('returnTo'));
  const session = await currentSession();
  if (session.state !== 'ok') return redirect('/login');
  const api = createPlatformClient({
    baseUrl: portalAuth().apiBaseUrl,
    getAccessToken: () => Promise.resolve(session.accessToken),
  });
  const outcome = await runAccountsOperation(api, formData, 'ops');
  return redirect(accountsNoticeUrl(returnTo, outcome));
}

/**
 * Registers one account. This action serves that one operation and no other, whatever the form says. The account number is in
 * the form data and in the request body of the one registration call and nowhere else: it is not logged, not kept, and the
 * address this action redirects to holds only the identifier of the new entry or a short code, never anything that was typed.
 */
export async function registerAccountAction(formData: FormData): Promise<void> {
  const session = await currentSession();
  if (session.state !== 'ok') return redirect('/login');
  const api = createPlatformClient({
    baseUrl: portalAuth().apiBaseUrl,
    getAccessToken: () => Promise.resolve(session.accessToken),
  });
  const outcome = await runAccountRegistration(api, formData, 'ops');
  return redirect(accountRegisteredUrl(outcome));
}
