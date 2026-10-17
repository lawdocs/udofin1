import { LS_REQUEST_STATUSES } from '@udofin/contracts';
import {
  loadServicingRequests,
  parseServicingQuery,
  ServicingRequestsPage,
} from '@udofin/portal-kit';
import { connection } from 'next/server';
import { PageFrame } from '@/components/page-frame';
import { servicingAction } from '../actions';
import { noticeFrom, returnPath, servicingSession } from '../servicing-session';

export default async function DocumentRequestsRoute({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();
  const page = await servicingSession();
  if ('blocked' in page) return page.blocked;
  const raw = await searchParams;
  const query = parseServicingQuery(raw, { status: [...LS_REQUEST_STATUSES, 'all'] });
  // The queue opens on the requests that wait for an answer; "all" lifts the filter.
  const status = query.status ?? 'requested';
  const requests = await loadServicingRequests(page.api, {
    status: status === 'all' ? undefined : status,
    ...(query.cursor ? { cursor: query.cursor } : {}),
    ...(query.lenderId ? { lenderId: query.lenderId } : {}),
  });
  const notice = noticeFrom(raw);
  return (
    <PageFrame me={page.session.me} current="/loans">
      <ServicingRequestsPage
        page={requests}
        query={{ ...query, status }}
        ctx={{
          action: servicingAction,
          returnTo: returnPath('/loans/requests', { ...raw, status }, ['status', 'cursor']),
          grants: page.grants,
        }}
        done={notice.done}
        error={notice.error}
      />
    </PageFrame>
  );
}
