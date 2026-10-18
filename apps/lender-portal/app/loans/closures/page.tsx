import {
  loadServicingClosures,
  parseServicingQuery,
  ServicingClosuresPage,
} from '@udofin/portal-kit';
import { connection } from 'next/server';
import { PageFrame } from '@/components/page-frame';
import { servicingAction } from '../actions';
import { noticeFrom, returnPath, servicingSession } from '../servicing-session';

export default async function ClosuresRoute({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();
  const page = await servicingSession();
  if ('blocked' in page) return page.blocked;
  const raw = await searchParams;
  const query = parseServicingQuery(raw);
  const closures = await loadServicingClosures(page.api, query);
  const notice = await noticeFrom(raw, '/loans/closures');
  return (
    <PageFrame me={page.session.me} current="/loans">
      <ServicingClosuresPage
        page={closures}
        query={query}
        ctx={{
          action: servicingAction,
          returnTo: returnPath('/loans/closures', raw, ['cursor']),
          grants: page.grants,
        }}
        done={notice.done}
        error={notice.error}
      />
    </PageFrame>
  );
}
