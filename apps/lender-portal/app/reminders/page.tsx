import {
  chooseRemindersLender,
  loadReminderLog,
  loadReminderPenalTexts,
  loadReminderSummary,
  parseRemindersQuery,
  REMINDERS_STATUS_FILTERS,
  RemindersLogPage,
} from '@udofin/portal-kit';
import { connection } from 'next/server';
import { PageFrame } from '@/components/page-frame';
import { remindersAction, remindersDraftAction } from './actions';
import { KEPT_FILTERS, noticeFrom, remindersSession, returnPath } from './reminders-session';

export default async function RemindersRoute({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();
  const page = await remindersSession();
  if ('blocked' in page) return page.blocked;
  const raw = await searchParams;
  const query = parseRemindersQuery(raw, REMINDERS_STATUS_FILTERS.reminder);
  const lender = chooseRemindersLender(page.grants, query.lenderId, (g) => g.read);
  const [summary, reminders, penal] = lender
    ? await Promise.all([
        loadReminderSummary(page.api, lender.lenderId),
        loadReminderLog(page.api, { ...query, lenderId: lender.lenderId }),
        loadReminderPenalTexts(page.api, lender.lenderId, {}, 1),
      ])
    : [null, { ok: false, status: 403, code: 'forbidden' } as const, null];
  const notice = noticeFrom(raw);
  return (
    <PageFrame me={page.session.me} current="/reminders">
      <RemindersLogPage
        lender={lender}
        summary={summary}
        reminders={reminders}
        overdue={penal?.ok ? penal.data.overdueReminders : null}
        query={query}
        ctx={{
          action: remindersAction,
          draft: remindersDraftAction,
          returnTo: returnPath('/reminders', raw, KEPT_FILTERS),
          grants: page.grants,
          userId: page.userId,
        }}
        done={notice.done}
        error={notice.error}
      />
    </PageFrame>
  );
}
