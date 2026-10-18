import {
  accountsNoticeFrom,
  accountsReturnPath,
  AccountsMerchantsPage,
  ACCOUNTS_MERCHANT_STATUSES,
  ACCOUNTS_MERCHANT_VERIFICATIONS,
  loadPlatformLenderChoices,
  loadPlatformMerchants,
  loadPlatformProviders,
  parseAccountsQuery,
} from '@udofin/portal-kit';
import { connection } from 'next/server';
import { PageFrame } from '@/components/page-frame';
import { platformAction, registerAccountAction } from '../actions';
import { platformSession } from '../platform-session';

export default async function MerchantsRoute({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();
  const page = await platformSession();
  if ('blocked' in page) return page.blocked;
  const raw = await searchParams;
  const query = parseAccountsQuery(raw, {
    status: ACCOUNTS_MERCHANT_STATUSES,
    verification: ACCOUNTS_MERCHANT_VERIFICATIONS,
  });
  const [merchants, providers, lenders] = await Promise.all([
    loadPlatformMerchants(page.api, query),
    loadPlatformProviders(page.api),
    loadPlatformLenderChoices(page.generic),
  ]);
  return (
    <PageFrame me={page.session.me} current="/accounts">
      <AccountsMerchantsPage
        merchants={merchants}
        providers={providers.ok ? providers.data.items : null}
        lenders={lenders}
        query={query}
        ctx={{
          action: platformAction,
          registerAction: registerAccountAction,
          returnTo: accountsReturnPath('/accounts/merchants', raw, [
            'status',
            'verification',
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
