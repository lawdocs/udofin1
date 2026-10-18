import {
  accountsNoticeFrom,
  accountsReturnPath,
  AccountsFeaturesPage,
  ACCOUNTS_REQUEST_STATUSES,
  loadPlatformFeatureRequests,
  loadPlatformFeatures,
  loadPlatformLenderChoices,
  loadPlatformLenderSwitches,
  parseAccountsQuery,
} from '@udofin/portal-kit';
import { connection } from 'next/server';
import { PageFrame } from '@/components/page-frame';
import { platformAction, registerAccountAction } from '../accounts/actions';
import { platformSession } from '../accounts/platform-session';

export default async function FeaturesRoute({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();
  const page = await platformSession();
  if ('blocked' in page) return page.blocked;
  const raw = await searchParams;
  const query = parseAccountsQuery(raw, { status: ACCOUNTS_REQUEST_STATUSES });
  const [catalogue, switches, requests, lenders] = await Promise.all([
    loadPlatformFeatures(page.api),
    query.lenderId ? loadPlatformLenderSwitches(page.api, query.lenderId) : Promise.resolve(null),
    loadPlatformFeatureRequests(page.api, query),
    loadPlatformLenderChoices(page.generic),
  ]);
  return (
    <PageFrame me={page.session.me} current="/features">
      <AccountsFeaturesPage
        catalogue={catalogue}
        lenderId={query.lenderId}
        switches={switches}
        requests={requests}
        lenders={lenders}
        query={query}
        ctx={{
          action: platformAction,
          registerAction: registerAccountAction,
          returnTo: accountsReturnPath('/features', raw, ['lenderId', 'status', 'cursor']),
          caps: page.caps,
          userId: page.userId,
        }}
        notice={accountsNoticeFrom(raw)}
      />
    </PageFrame>
  );
}
