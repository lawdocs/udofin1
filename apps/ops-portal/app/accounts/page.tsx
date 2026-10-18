import {
  accountsNoticeFrom,
  accountsRegisteredIdFrom,
  accountsReturnPath,
  AccountsRegistryPage,
  loadPlatformAccount,
  loadPlatformAccounts,
  loadPlatformKeyVersions,
  loadPlatformLenderChoices,
  loadPlatformRules,
  parseAccountsQuery,
  ACCOUNTS_REGISTRY_STATUSES,
} from '@udofin/portal-kit';
import { connection } from 'next/server';
import { PageFrame } from '@/components/page-frame';
import { platformAction, registerAccountAction } from './actions';
import { platformSession } from './platform-session';

export default async function AccountsRoute({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();
  const page = await platformSession();
  if ('blocked' in page) return page.blocked;
  const raw = await searchParams;
  const query = parseAccountsQuery(raw, { status: ACCOUNTS_REGISTRY_STATUSES });
  const registeredId = accountsRegisteredIdFrom(raw);
  // Registering needs to know that a format rule is approved and a key version is active; only the people who can register read them.
  const [accounts, registered, rules, keys, lenders] = await Promise.all([
    loadPlatformAccounts(page.api, query),
    registeredId ? loadPlatformAccount(page.api, registeredId) : Promise.resolve(null),
    page.caps.registryManage ? loadPlatformRules(page.api, 'approved') : Promise.resolve(null),
    page.caps.registryManage || page.caps.registryVerify
      ? loadPlatformKeyVersions(page.api)
      : Promise.resolve(null),
    loadPlatformLenderChoices(page.generic),
  ]);
  return (
    <PageFrame me={page.session.me} current="/accounts">
      <AccountsRegistryPage
        accounts={accounts}
        registered={registered}
        rules={rules}
        keys={keys}
        lenders={lenders}
        query={query}
        ctx={{
          action: platformAction,
          registerAction: registerAccountAction,
          returnTo: accountsReturnPath('/accounts', raw, ['status', 'lenderId', 'cursor']),
          caps: page.caps,
          userId: page.userId,
        }}
        notice={accountsNoticeFrom(raw)}
      />
    </PageFrame>
  );
}
