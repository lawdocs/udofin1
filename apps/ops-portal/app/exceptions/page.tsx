import {
  accountsNoticeFrom,
  accountsReturnPath,
  AccountsExceptionsPage,
  ACCOUNTS_EXCEPTION_SEVERITIES,
  loadPlatformLenderChoices,
  loadPlatformOpenExceptions,
  loadPlatformResolvedExceptions,
  parseAccountsQuery,
} from '@udofin/portal-kit';
import { connection } from 'next/server';
import { PageFrame } from '@/components/page-frame';
import { platformAction, registerAccountAction } from '../accounts/actions';
import { platformSession } from '../accounts/platform-session';

export default async function ExceptionsRoute({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();
  const page = await platformSession();
  if ('blocked' in page) return page.blocked;
  const raw = await searchParams;
  const query = parseAccountsQuery(raw, {
    severity: ACCOUNTS_EXCEPTION_SEVERITIES,
    view: ['open', 'resolved'],
  });
  const view = query.view === 'resolved' ? 'resolved' : 'open';
  const [shown, lenders] = await Promise.all([
    view === 'resolved'
      ? loadPlatformResolvedExceptions(page.api, query)
      : loadPlatformOpenExceptions(page.api, query),
    loadPlatformLenderChoices(page.generic),
  ]);
  return (
    <PageFrame me={page.session.me} current="/exceptions">
      <AccountsExceptionsPage
        open={shown}
        resolved={view === 'resolved' ? shown : null}
        view={view}
        lenders={lenders}
        query={query}
        ctx={{
          action: platformAction,
          registerAction: registerAccountAction,
          returnTo: accountsReturnPath('/exceptions', raw, ['view', 'severity', 'cursor']),
          caps: page.caps,
          userId: page.userId,
        }}
        notice={accountsNoticeFrom(raw)}
      />
    </PageFrame>
  );
}
