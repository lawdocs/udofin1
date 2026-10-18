import {
  isPaymentSetupId,
  loadPaymentSetupConfig,
  loadPaymentSetupHistory,
  loadPaymentSetupMerchants,
  loadPaymentSetupProviders,
  loadPaymentSetupSettlements,
  PaymentSetupDetailPage,
} from '@udofin/portal-kit';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { PageFrame } from '@/components/page-frame';
import { setupAction, setupConfigDraftAction, setupDraftAction } from '../actions';
import { noticeFrom, setupSession } from '../setup-session';

export default async function PaymentConfigRoute({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();
  const { id } = await params;
  if (!isPaymentSetupId(id)) notFound();
  const page = await setupSession();
  if ('blocked' in page) return page.blocked;
  const config = await loadPaymentSetupConfig(page.api, id);
  if (!config.ok && config.status === 404) notFound();
  const forbidden = { ok: false, status: 403, code: 'forbidden' } as const;
  const [history, providers, merchants, settlements] = config.ok
    ? await Promise.all([
        loadPaymentSetupHistory(page.api, id),
        loadPaymentSetupProviders(page.api),
        loadPaymentSetupMerchants(page.api, config.data.lenderId),
        loadPaymentSetupSettlements(page.api, config.data.lenderId),
      ])
    : [forbidden, forbidden, forbidden, forbidden];
  const notice = await noticeFrom(await searchParams, `/payment-setup/${id}`);
  return (
    <PageFrame me={page.session.me} current="/payment-setup">
      <PaymentSetupDetailPage
        config={config}
        history={history}
        providers={providers}
        merchants={merchants}
        settlements={settlements}
        ctx={{
          action: setupAction,
          draft: setupDraftAction,
          draftConfig: setupConfigDraftAction,
          returnTo: `/payment-setup/${id}`,
          grants: page.grants,
          userId: page.userId,
        }}
        done={notice.done}
        error={notice.error}
      />
    </PageFrame>
  );
}
