import {
  loadReminderHolds,
  parseRemindersQuery,
  REMINDERS_STATUS_FILTERS,
  RemindersHoldsPage,
} from '@udofin/portal-kit';
import { connection } from 'next/server';
import { PageFrame } from '@/components/page-frame';
import { remindersAction, remindersDraftAction } from '../actions';
import { KEPT_FILTERS, noticeFrom, remindersSession, returnPath } from '../reminders-session';

export default async function HoldsRoute({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();
  const page = await remindersSession();
  if ('blocked' in page) return page.blocked;
  const raw = await searchParams;
  const query = parseRemindersQuery(raw, REMINDERS_STATUS_FILTERS.hold);
  const holds = await loadReminderHolds(page.api, query);
  const notice = await noticeFrom(raw, '/reminders/holds');
  return (
    <PageFrame me={page.session.me} current="/reminders">
      <RemindersHoldsPage
        holds={holds}
        query={query}
        ctx={{
          action: remindersAction,
          draft: remindersDraftAction,
          returnTo: returnPath('/reminders/holds', raw, KEPT_FILTERS),
          grants: page.grants,
          userId: page.userId,
        }}
        done={notice.done}
        error={notice.error}
      />
    </PageFrame>
  );
}
