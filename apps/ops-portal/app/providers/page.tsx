import {
  accountsNoticeFrom,
  accountsReturnPath,
  AccountsProvidersPage,
  loadPlatformProviders,
  loadPlatformReturnCodes,
  parseAccountsQuery,
} from '@udofin/portal-kit';
import { connection } from 'next/server';
import { PageFrame } from '@/components/page-frame';
import { successNotice } from '@/lib/flash';
import { platformAction, registerAccountAction } from '../accounts/actions';
import { platformSession } from '../accounts/platform-session';

export default async function ProvidersRoute({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();
  const page = await platformSession();
  if ('blocked' in page) return page.blocked;
  const raw = await searchParams;
  const query = parseAccountsQuery(raw);
  const [providers, returnCodes] = await Promise.all([
    loadPlatformProviders(page.api),
    loadPlatformReturnCodes(page.api, query.provider),
  ]);
  // A success is what the server wrote for this page after the API accepted the change, never what the address says.
  const flash = await successNotice('/providers');
  return (
    <PageFrame me={page.session.me} current="/providers">
      <AccountsProvidersPage
        providers={providers}
        returnCodes={returnCodes}
        provider={query.provider}
        ctx={{
          action: platformAction,
          registerAction: registerAccountAction,
          returnTo: accountsReturnPath('/providers', raw, ['provider']),
          caps: page.caps,
          userId: page.userId,
        }}
        notice={accountsNoticeFrom(raw, flash)}
      />
    </PageFrame>
  );
}
