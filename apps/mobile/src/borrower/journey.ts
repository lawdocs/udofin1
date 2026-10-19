import { type BorrowerMe } from '@udofin/contracts';
import { isLanguage, type Language } from '../i18n';

/** What the borrower should do next. Facts only: none of these states means KYC, eligibility or approval. */
export type NextStep = 'closed' | 'closing' | 'profile' | 'consents' | 'request';

export function nextStep(me: BorrowerMe): NextStep {
  const status = me.profile.onboardingStatus;
  if (status === 'anonymised') return 'closed';
  if (status === 'deletion_requested') return 'closing';
  if (!me.journey.profileCompleted) return 'profile';
  if (!me.journey.consentsCompleted) return 'consents';
  return 'request';
}

/**
 * Which language to use right after sign-in. Once the server holds a preference (profile started or
 * later), it wins so the app matches on every device; before that, the choice made on this device is kept.
 */
export function resolveLanguage(input: {
  local: string | null;
  server: BorrowerMe['profile'] | null;
}): { language: Language; pushToServer: boolean } {
  const local = isLanguage(input.local) ? input.local : null;
  const server = input.server;
  if (!server) return { language: local ?? 'en', pushToServer: false };
  const serverStarted = server.onboardingStatus !== 'account_created';
  if (serverStarted) return { language: server.preferredLanguage, pushToServer: false };
  if (local && local !== server.preferredLanguage) return { language: local, pushToServer: true };
  return { language: server.preferredLanguage, pushToServer: false };
}
