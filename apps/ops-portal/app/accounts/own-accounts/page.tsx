import {
  accountsNoticeFrom,
  accountsReturnPath,
  AccountsOwnListPage,
  loadPlatformOwnAccountList,
} from '@udofin/portal-kit';
import { connection } from 'next/server';
import { PageFrame } from '@/components/page-frame';
import { successNotice } from '@/app/_flash';
import { platformAction, registerAccountAction } from '../actions';
import { platformSession } from '../platform-session';

export default async function OwnAccountListRoute({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();
  const page = await platformSession();
  if ('blocked' in page) return page.blocked;
  const raw = await searchParams;
  const state = await loadPlatformOwnAccountList(page.api);
  // A success is what the server wrote for this page after the API accepted the change, never what the address says.
  const flash = await successNotice('/accounts/own-accounts');
  return (
    <PageFrame me={page.session.me} current="/accounts">
      <AccountsOwnListPage
        state={state}
        ctx={{
          action: platformAction,
          registerAction: registerAccountAction,
          returnTo: accountsReturnPath('/accounts/own-accounts', raw, []),
          caps: page.caps,
          userId: page.userId,
        }}
        notice={accountsNoticeFrom(raw, flash)}
      />
    </PageFrame>
  );
}
