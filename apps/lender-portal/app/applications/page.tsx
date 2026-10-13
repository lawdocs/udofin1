import { createApiClient } from '@udofin/auth-client';
import { ApplicationsList, loadApplications } from '@udofin/portal-kit';
import { connection } from 'next/server';
import { PageFrame } from '@/components/page-frame';
import { requireSession } from '@/components/session-gate';
import { portalAuth } from '@/lib/auth';

export default async function ApplicationsRoute({
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
  const cursor = typeof query.cursor === 'string' ? query.cursor.slice(0, 300) : undefined;
  const result = await loadApplications(api, cursor);
  return (
    <PageFrame me={session.me} current="/applications">
      <ApplicationsList
        result={result}
        nextHref={(next) => `/applications?cursor=${encodeURIComponent(next)}`}
      />
    </PageFrame>
  );
}
