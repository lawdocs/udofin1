'use server';

import {
  accountRegisteredUrl,
  accountsFlashFor,
  accountsNoticeUrl,
  createPlatformClient,
  runAccountRegistration,
  runAccountsOperation,
  safeAccountsReturnPath,
} from '@udofin/portal-kit';
import { redirect } from 'next/navigation';
import { currentSession, portalAuth } from '@/lib/auth';
import { rememberSuccess } from '@/lib/flash';

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
  // The confirmation (and the decision of a feature request) is written here, after the API accepted the change, not carried in
  // the address.
  const flash = accountsFlashFor(outcome);
  if (flash) await rememberSuccess(returnTo, flash);
  return redirect(accountsNoticeUrl(returnTo, outcome));
}

/**
 * Registers one account. This action serves that one operation and no other, whatever the form says. The account number is in
 * the form data and in the request body of the one registration call and nowhere else: it is not logged, not kept, and the
 * address this action redirects to holds at most a short code, never anything that was typed. The identifier of the new entry
 * reaches the page as a notice written here, after the API accepted the registration.
 */
export async function registerAccountAction(formData: FormData): Promise<void> {
  const session = await currentSession();
  if (session.state !== 'ok') return redirect('/login');
  const api = createPlatformClient({
    baseUrl: portalAuth().apiBaseUrl,
    getAccessToken: () => Promise.resolve(session.accessToken),
  });
  const outcome = await runAccountRegistration(api, formData, 'ops');
  // The identifier of the new entry reaches the page as a notice written here, not as a value in the address.
  const flash = accountsFlashFor(outcome);
  if (flash) await rememberSuccess('/accounts', flash);
  return redirect(accountRegisteredUrl(outcome));
}
