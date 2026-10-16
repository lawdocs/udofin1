import { createApiClient } from '@udofin/auth-client';
import { ErrorState, LendersTable, loadLenderList } from '@udofin/portal-kit';
import { redirect } from 'next/navigation';
import { connection } from 'next/server';
import { PageFrame } from '@/components/page-frame';
import { requireSession } from '@/components/session-gate';
import { portalAuth } from '@/lib/auth';

export default async function OnboardingPage() {
  await connection();
  const session = await requireSession();
  if ('blocked' in session) return session.blocked;
  const api = createApiClient({
    baseUrl: portalAuth().apiBaseUrl,
    getAccessToken: () => Promise.resolve(session.accessToken),
  });
  const [lenders] = await loadLenderList(api);
  if (lenders.ok && lenders.data.items.length === 1 && lenders.data.items[0]) {
    return redirect(`/onboarding/${lenders.data.items[0].lenderOrgId}`);
  }
  return (
    <PageFrame me={session.me} current="/onboarding">
      <h1>Onboarding</h1>
      {!lenders.ok ? (
        <ErrorState
          title={
            lenders.status === 403 ? 'You cannot view onboarding' : 'Could not load onboarding'
          }
          detail={
            lenders.status === 403 ? 'Your role does not include onboarding.' : 'Reload the page.'
          }
        />
      ) : (
        <LendersTable lenders={lenders.data.items} base="/onboarding" />
      )}
    </PageFrame>
  );
}
