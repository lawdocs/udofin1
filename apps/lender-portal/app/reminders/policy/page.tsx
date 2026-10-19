import {
  chooseRemindersLender,
  loadReminderPolicies,
  mayViewReminderArtefacts,
  parseRemindersQuery,
  REMINDERS_STATUS_FILTERS,
  RemindersPolicyPage,
} from '@udofin/portal-kit';
import { connection } from 'next/server';
import { PageFrame } from '@/components/page-frame';
import { remindersAction, remindersDraftAction } from '../actions';
import { KEPT_FILTERS, noticeFrom, remindersSession, returnPath } from '../reminders-session';

export default async function PolicyRoute({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();
  const page = await remindersSession();
  if ('blocked' in page) return page.blocked;
  const raw = await searchParams;
  const query = parseRemindersQuery(raw, REMINDERS_STATUS_FILTERS.artefact);
  const lender = chooseRemindersLender(page.grants, query.lenderId, mayViewReminderArtefacts);
  const policies = lender
    ? await loadReminderPolicies(page.api, lender.lenderId, query)
    : ({ ok: false, status: 403, code: 'forbidden' } as const);
  const notice = await noticeFrom(raw, '/reminders/policy');
  return (
    <PageFrame me={page.session.me} current="/reminders">
      <RemindersPolicyPage
        lender={lender}
        page={policies}
        query={query}
        ctx={{
          action: remindersAction,
          draft: remindersDraftAction,
          returnTo: returnPath('/reminders/policy', raw, KEPT_FILTERS),
          grants: page.grants,
          userId: page.userId,
        }}
        done={notice.done}
        error={notice.error}
      />
    </PageFrame>
  );
}
