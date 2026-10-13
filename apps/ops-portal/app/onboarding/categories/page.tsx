import { createApiClient } from '@udofin/auth-client';
import { capabilitiesFrom, CategorySignoff, loadCategories, Notice } from '@udofin/portal-kit';
import { connection } from 'next/server';
import { PageFrame } from '@/components/page-frame';
import { requireSession } from '@/components/session-gate';
import { portalAuth } from '@/lib/auth';
import { onboardingAction } from '../actions';

export default async function CategoriesPage({
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
  const categories = await loadCategories(api);
  const caps = capabilitiesFrom(session.me.memberships.flatMap((m) => m.permissions));
  return (
    <PageFrame me={session.me} current="/onboarding">
      <h1>Institution categories</h1>
      <p className="muted">
        A lender can only be activated if its category has a confirmed regulatory basis or a
        recorded compliance sign-off citing the primary source reviewed. Banks, urban co-operative
        banks and other regulated entities start without it. A sign-off is a human compliance
        decision.
      </p>
      <Notice
        done={query.done === '1'}
        error={typeof query.error === 'string' ? query.error : undefined}
      />
      <CategorySignoff
        categories={categories}
        ctx={{ portal: 'ops', caps, action: onboardingAction, returnTo: '/onboarding/categories' }}
      />
    </PageFrame>
  );
}
