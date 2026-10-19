import {
  accountsNoticeFrom,
  accountsReturnPath,
  AccountsHoldsPage,
  loadPlatformLenderChoices,
  loadPlatformSuspendedConfigs,
  parseAccountsQuery,
} from '@udofin/portal-kit';
import { connection } from 'next/server';
import { PageFrame } from '@/components/page-frame';
import { successNotice } from '@/app/_flash';
import { platformAction, registerAccountAction } from '../../accounts/actions';
import { platformSession } from '../../accounts/platform-session';

export default async function HoldsRoute({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();
  const page = await platformSession();
  if ('blocked' in page) return page.blocked;
  const raw = await searchParams;
  const query = parseAccountsQuery(raw);
  const [configs, lenders] = await Promise.all([
    loadPlatformSuspendedConfigs(page.api, query),
    loadPlatformLenderChoices(page.generic),
  ]);
  // A success is what the server wrote for this page after the API accepted the change, never what the address says.
  const flash = await successNotice('/providers/holds');
  return (
    <PageFrame me={page.session.me} current="/providers">
      <AccountsHoldsPage
        configs={configs}
        lenders={lenders}
        query={query}
        ctx={{
          action: platformAction,
          registerAction: registerAccountAction,
          returnTo: accountsReturnPath('/providers/holds', raw, ['lenderId', 'cursor']),
          caps: page.caps,
          userId: page.userId,
        }}
        notice={accountsNoticeFrom(raw, flash)}
      />
    </PageFrame>
  );
}
