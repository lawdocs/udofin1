import { createApiClient } from '@udofin/auth-client';
import {
  ApplicationDetailView,
  ErrorState,
  capabilitiesFrom,
  loadApplication,
  loadApplications,
} from '@udofin/portal-kit';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { PageFrame } from '@/components/page-frame';
import { ContactReveal } from '@/components/contact-reveal';
import { requireSession } from '@/components/session-gate';
import { portalAuth } from '@/lib/auth';
import { onboardingAction } from '../../onboarding/actions';

const UUID = /^[0-9a-f-]{36}$/;
/** The queue is cursor-paged; a detail page looks for its application across a bounded number of pages. */
const MAX_PAGES = 8;

export default async function ApplicationRoute({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const session = await requireSession();
  if ('blocked' in session) return session.blocked;
  const query = await searchParams;
  const api = createApiClient({
    baseUrl: portalAuth().apiBaseUrl,
    getAccessToken: () => Promise.resolve(session.accessToken),
  });
  let cursor: string | undefined;
  let application;
  for (let page = 0; page < MAX_PAGES && !application; page++) {
    const list = await loadApplications(api, cursor);
    if (!list.ok)
      return (
        <PageFrame me={session.me} current="/applications">
          <ErrorState title="Could not load the application" detail="Reload the page." />
        </PageFrame>
      );
    application = list.data.items.find((a) => a.applicationId === id);
    if (!list.data.nextCursor) break;
    cursor = list.data.nextCursor;
  }
  if (!application) notFound();
  const detail = await loadApplication(api, id);
  const caps = capabilitiesFrom(session.me.memberships.flatMap((m) => m.permissions));
  return (
    <PageFrame me={session.me} current="/applications">
      <ApplicationDetailView
        application={application}
        detail={detail}
        contact={<ContactReveal id={id} />}
        ctx={{
          portal: 'lender',
          caps,
          action: onboardingAction,
          returnTo: `/applications/${id}`,
          userId: session.me.userId,
        }}
        done={query.done === '1'}
        error={typeof query.error === 'string' ? query.error : undefined}
      />
    </PageFrame>
  );
}
