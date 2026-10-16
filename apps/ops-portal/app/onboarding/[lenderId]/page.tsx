import { createApiClient } from '@udofin/auth-client';
import { capabilitiesFrom, isTab, LenderBody, loadLenderTab, type Tab } from '@udofin/portal-kit';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { z } from 'zod';
import { PageFrame } from '@/components/page-frame';
import { requireSession } from '@/components/session-gate';
import { portalAuth } from '@/lib/auth';
import { onboardingAction } from '../actions';

export default async function LenderOnboardingPage({
  params,
  searchParams,
}: {
  params: Promise<{ lenderId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();
  const lenderId = z.uuid().safeParse((await params).lenderId);
  if (!lenderId.success) return notFound();
  const session = await requireSession();
  if ('blocked' in session) return session.blocked;
  const query = await searchParams;
  const tab: Tab = isTab(query.tab) ? query.tab : 'profile';
  const api = createApiClient({
    baseUrl: portalAuth().apiBaseUrl,
    getAccessToken: () => Promise.resolve(session.accessToken),
  });
  const data = await loadLenderTab(api, lenderId.data, tab);
  if (!data.overview.ok && data.overview.status === 404) return notFound();
  const caps = capabilitiesFrom(session.me.memberships.flatMap((m) => m.permissions));
  const returnTo = `/onboarding/${lenderId.data}?tab=${tab}`;
  return (
    <PageFrame me={session.me} current="/onboarding">
      <LenderBody
        tab={tab}
        data={data}
        lenderId={lenderId.data}
        base="/onboarding"
        downloadBase="/onboarding/documents"
        ctx={{ portal: 'ops', caps, action: onboardingAction, returnTo }}
        done={query.done === '1'}
        error={typeof query.error === 'string' ? query.error : undefined}
      />
    </PageFrame>
  );
}
