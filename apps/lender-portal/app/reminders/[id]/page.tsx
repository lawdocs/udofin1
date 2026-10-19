import { isReminderId, loadReminderDeliveries, RemindersAttemptsPage } from '@udofin/portal-kit';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { PageFrame } from '@/components/page-frame';
import { remindersSession } from '../reminders-session';

export default async function ReminderAttemptsRoute({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await connection();
  const { id } = await params;
  if (!isReminderId(id)) notFound();
  const page = await remindersSession();
  if ('blocked' in page) return page.blocked;
  const log = await loadReminderDeliveries(page.api, id);
  return (
    <PageFrame me={page.session.me} current="/reminders">
      <RemindersAttemptsPage log={log} />
    </PageFrame>
  );
}
