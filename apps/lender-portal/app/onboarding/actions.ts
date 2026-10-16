'use server';

import { createApiClient } from '@udofin/auth-client';
import { runOperation, safeReturnPath } from '@udofin/portal-kit';
import { redirect } from 'next/navigation';
import { currentSession, portalAuth } from '@/lib/auth';

/**
 * The single entry point for onboarding forms. The form names an allow-listed operation (see
 * runOperation); the API authorises the call again with the signed-in person's own token.
 */
export async function onboardingAction(formData: FormData): Promise<void> {
  const returnTo = safeReturnPath(formData.get('returnTo'));
  const session = await currentSession();
  if (session.state !== 'ok') return redirect('/login');
  const api = createApiClient({
    baseUrl: portalAuth().apiBaseUrl,
    getAccessToken: () => Promise.resolve(session.accessToken),
  });
  const outcome = await runOperation(api, formData, 'lender');
  const separator = returnTo.includes('?') ? '&' : '?';
  return redirect(
    outcome.ok
      ? `${returnTo}${separator}done=1`
      : `${returnTo}${separator}error=${encodeURIComponent(outcome.code)}`,
  );
}
