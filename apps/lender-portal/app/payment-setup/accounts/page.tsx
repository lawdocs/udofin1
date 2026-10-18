import {
  choosePaymentSetupLender,
  loadPaymentSetupMerchants,
  loadPaymentSetupProviders,
  loadPaymentSetupRegistryStatus,
  loadPaymentSetupSettlements,
  parsePaymentSetupQuery,
  PaymentSetupAccountsPage,
} from '@udofin/portal-kit';
import { connection } from 'next/server';
import { PageFrame } from '@/components/page-frame';
import { setupAction, setupConfigDraftAction, setupDraftAction } from '../actions';
import { noticeFrom, returnPath, setupSession } from '../setup-session';

export default async function PaymentAccountsRoute({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();
  const page = await setupSession();
  if ('blocked' in page) return page.blocked;
  const raw = await searchParams;
  const query = parsePaymentSetupQuery(raw);
  const lender = choosePaymentSetupLender(page.grants, query.lenderId);
  const forbidden = { ok: false, status: 403, code: 'forbidden' } as const;
  const [providers, merchants, settlements, registry] = lender
    ? await Promise.all([
        loadPaymentSetupProviders(page.api),
        loadPaymentSetupMerchants(page.api, lender.lenderId),
        loadPaymentSetupSettlements(page.api, lender.lenderId),
        loadPaymentSetupRegistryStatus(page.api),
      ])
    : [forbidden, forbidden, forbidden, forbidden];
  const notice = noticeFrom(raw);
  return (
    <PageFrame me={page.session.me} current="/payment-setup">
      <PaymentSetupAccountsPage
        lender={lender}
        providers={providers}
        merchants={merchants}
        settlements={settlements}
        registry={registry}
        ctx={{
          action: setupAction,
          draft: setupDraftAction,
          draftConfig: setupConfigDraftAction,
          returnTo: returnPath('/payment-setup/accounts', raw, ['lenderId']),
          grants: page.grants,
          userId: page.userId,
        }}
        done={notice.done}
        error={notice.error}
      />
    </PageFrame>
  );
}
