'use server';

import { createApiClient } from '@udofin/auth-client';
import {
  paymentSetupNoticeUrl,
  runPaymentSetupOperation,
  safePaymentSetupReturnPath,
  type DraftedPaymentConfig,
  type RemindersFormOutcome,
} from '@udofin/portal-kit';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { currentSession, portalAuth } from '@/lib/auth';

async function apiFor() {
  const session = await currentSession();
  if (session.state !== 'ok') return null;
  return createApiClient({
    baseUrl: portalAuth().apiBaseUrl,
    getAccessToken: () => Promise.resolve(session.accessToken),
  });
}

/**
 * The entry point for the small payment-setup forms (submit, decide, withdraw, retire). A form names an allow-listed
 * operation (see runPaymentSetupOperation); the API authorises the call again with the signed-in person's own token. The page
 * goes back to where the form was, with the result as a short notice. The configuration draft has its own entry point below
 * and is refused here.
 */
export async function setupAction(formData: FormData): Promise<void> {
  const returnTo = safePaymentSetupReturnPath(formData.get('returnTo'));
  const api = await apiFor();
  if (!api) return redirect('/login');
  const outcome = await runPaymentSetupOperation(api, formData);
  return redirect(paymentSetupNoticeUrl(returnTo, outcome));
}

/**
 * The entry point for the forms that keep what was typed when they are refused (a merchant claim and a settlement account
 * request). A refusal is handed back to the form as a stable code; success goes back to the page with the notice.
 */
export async function setupDraftAction(formData: FormData): Promise<RemindersFormOutcome> {
  const returnTo = safePaymentSetupReturnPath(formData.get('returnTo'));
  const api = await apiFor();
  if (!api) return redirect('/login');
  const outcome = await runPaymentSetupOperation(api, formData);
  if (!outcome.ok) return outcome;
  return redirect(paymentSetupNoticeUrl(returnTo, outcome));
}

/**
 * Drafts a payment configuration. This action serves that one operation and no other, whatever the form says. The answer
 * carries the callback token, which goes back to the one form that asked and is shown once: it is not put in an address, a
 * cookie, a log line or any storage here.
 */
export async function setupConfigDraftAction(
  formData: FormData,
): Promise<RemindersFormOutcome<DraftedPaymentConfig>> {
  const api = await apiFor();
  if (!api) return redirect('/login');
  const outcome = await runPaymentSetupOperation(api, formData, 'setup.config.draft');
  if (!outcome.ok) return outcome;
  revalidatePath('/payment-setup');
  return outcome.drafted
    ? { ok: true, result: outcome.drafted }
    : { ok: false, code: 'bad_response' };
}
