import {
  accountsNoticeFrom,
  accountsReturnPath,
  AccountsRulesPage,
  ACCOUNTS_RULE_STATUSES,
  loadPlatformKeyVersions,
  loadPlatformRules,
  parseAccountsQuery,
} from '@udofin/portal-kit';
import { connection } from 'next/server';
import { PageFrame } from '@/components/page-frame';
import { successNotice } from '@/lib/flash';
import { platformAction, registerAccountAction } from '../actions';
import { platformSession } from '../platform-session';

export default async function RulesRoute({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();
  const page = await platformSession();
  if ('blocked' in page) return page.blocked;
  const raw = await searchParams;
  const query = parseAccountsQuery(raw, { status: ACCOUNTS_RULE_STATUSES });
  const [rules, keys] = await Promise.all([
    loadPlatformRules(page.api, query.status),
    loadPlatformKeyVersions(page.api),
  ]);
  // A success is what the server wrote for this page after the API accepted the change, never what the address says.
  const flash = await successNotice('/accounts/rules');
  return (
    <PageFrame me={page.session.me} current="/accounts">
      <AccountsRulesPage
        rules={rules}
        keys={keys}
        query={query}
        ctx={{
          action: platformAction,
          registerAction: registerAccountAction,
          returnTo: accountsReturnPath('/accounts/rules', raw, ['status']),
          caps: page.caps,
          userId: page.userId,
        }}
        notice={accountsNoticeFrom(raw, flash)}
      />
    </PageFrame>
  );
}
