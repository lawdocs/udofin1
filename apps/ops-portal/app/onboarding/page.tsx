import { createApiClient } from '@udofin/auth-client';
import {
  capabilitiesFrom,
  CreateProfileForm,
  ErrorState,
  LendersTable,
  loadLenderList,
  Notice,
} from '@udofin/portal-kit';
import { connection } from 'next/server';
import { PageFrame } from '@/components/page-frame';
import { requireSession } from '@/components/session-gate';
import { portalAuth } from '@/lib/auth';
import { onboardingAction } from './actions';

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();
  const session = await requireSession();
  if ('blocked' in session) return session.blocked;
  const query = await searchParams;
  const api = createApiClient({
    baseUrl: portalAuth().apiBaseUrl,
    getAccessToken: () => Promise.resolve(session.accessToken),
  });
  const [lenders, categories] = await loadLenderList(api);
  const caps = capabilitiesFrom(session.me.memberships.flatMap((m) => m.permissions));
  return (
    <PageFrame me={session.me} current="/onboarding">
      <h1>Lender onboarding</h1>
      <p className="muted">
        Every lender goes through the same steps, whatever its institution type. A profile or an
        approved step never makes a lender live by itself; activation needs every gate and two
        different people for each decision.
      </p>
      <Notice
        done={query.done === '1'}
        error={typeof query.error === 'string' ? query.error : undefined}
      />
      {!lenders.ok ? (
        <ErrorState
          title={lenders.status === 403 ? 'You cannot view onboarding' : 'Could not load lenders'}
          detail={
            lenders.status === 403 ? 'Your role does not include onboarding.' : 'Reload the page.'
          }
        />
      ) : (
        <>
          <LendersTable lenders={lenders.data.items} base="/onboarding" />
          {categories.ok ? (
            <CreateProfileForm
              lenders={lenders.data.items}
              categories={categories.data.items}
              ctx={{ portal: 'ops', caps, action: onboardingAction, returnTo: '/onboarding' }}
            />
          ) : null}
        </>
      )}
      {caps.compliance || caps.read ? (
        <p>
          <a href="/onboarding/categories">Institution categories and compliance sign-off</a>
        </p>
      ) : null}
    </PageFrame>
  );
}
