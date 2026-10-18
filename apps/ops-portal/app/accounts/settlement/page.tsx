import {
  accountsNoticeFrom,
  accountsReturnPath,
  AccountsSettlementPage,
  loadPlatformLenderChoices,
  loadPlatformSettlementAccounts,
  loadPlatformVerifiedAccounts,
  parseAccountsQuery,
} from '@udofin/portal-kit';
import { connection } from 'next/server';
import { PageFrame } from '@/components/page-frame';
import { platformAction, registerAccountAction } from '../actions';
import { platformSession } from '../platform-session';

export default async function SettlementRoute({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();
  const page = await platformSession();
  if ('blocked' in page) return page.blocked;
  const raw = await searchParams;
  const query = parseAccountsQuery(raw, { linked: ['true', 'false'] });
  const [accounts, verified, lenders] = await Promise.all([
    loadPlatformSettlementAccounts(page.api, query),
    // Only a person who may link needs the entries to link to.
    page.caps.registryManage
      ? loadPlatformVerifiedAccounts(page.api, query.lenderId)
      : Promise.resolve(null),
    loadPlatformLenderChoices(page.generic),
  ]);
  return (
    <PageFrame me={page.session.me} current="/accounts">
      <AccountsSettlementPage
        accounts={accounts}
        verified={verified}
        lenders={lenders}
        query={query}
        ctx={{
          action: platformAction,
          registerAction: registerAccountAction,
          returnTo: accountsReturnPath('/accounts/settlement', raw, [
            'linked',
            'lenderId',
            'cursor',
          ]),
          caps: page.caps,
          userId: page.userId,
        }}
        notice={accountsNoticeFrom(raw)}
      />
    </PageFrame>
  );
}
