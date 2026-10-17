import { LS_CONFLICT_STATUSES } from '@udofin/contracts';
import {
  loadServicingConflicts,
  parseServicingQuery,
  ServicingConflictsPage,
} from '@udofin/portal-kit';
import { connection } from 'next/server';
import { PageFrame } from '@/components/page-frame';
import { servicingAction } from '../../loans/actions';
import { noticeFrom, returnPath, servicingSession } from '../../loans/servicing-session';

export default async function ConflictsRoute({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();
  const page = await servicingSession();
  if ('blocked' in page) return page.blocked;
  const raw = await searchParams;
  const query = parseServicingQuery(raw, { status: LS_CONFLICT_STATUSES });
  const conflicts = await loadServicingConflicts(page.api, query);
  const notice = noticeFrom(raw);
  return (
    <PageFrame me={page.session.me} current="/imports">
      <ServicingConflictsPage
        page={conflicts}
        query={query}
        ctx={{
          action: servicingAction,
          returnTo: returnPath('/imports/conflicts', raw, ['status', 'cursor']),
          grants: page.grants,
        }}
        done={notice.done}
        error={notice.error}
      />
    </PageFrame>
  );
}
