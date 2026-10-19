import {
  accountsNoticeFrom,
  AccountsExceptionDetailPage,
  isPlatformId,
  loadPlatformException,
  loadPlatformLenderChoices,
} from '@udofin/portal-kit';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { PageFrame } from '@/components/page-frame';
import { successNotice } from '@/app/_flash';
import { platformAction, registerAccountAction } from '../../accounts/actions';
import { platformSession } from '../../accounts/platform-session';

export default async function ExceptionRoute({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();
  const { id } = await params;
  if (!isPlatformId(id)) notFound();
  const page = await platformSession();
  if ('blocked' in page) return page.blocked;
  const raw = await searchParams;
  const [detail, lenders] = await Promise.all([
    loadPlatformException(page.api, id),
    loadPlatformLenderChoices(page.generic),
  ]);
  // A success is what the server wrote for this page after the API accepted the change, never what the address says.
  const flash = await successNotice(`/exceptions/${id}`);
  return (
    <PageFrame me={page.session.me} current="/exceptions">
      <AccountsExceptionDetailPage
        detail={detail}
        lenders={lenders}
        ctx={{
          action: platformAction,
          registerAction: registerAccountAction,
          returnTo: `/exceptions/${id}`,
          caps: page.caps,
          userId: page.userId,
        }}
        notice={accountsNoticeFrom(raw, flash)}
      />
    </PageFrame>
  );
}
