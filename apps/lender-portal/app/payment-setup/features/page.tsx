import {
  choosePaymentSetupLender,
  loadPaymentSetupFeatures,
  parsePaymentSetupQuery,
  PaymentSetupFeaturesPage,
} from '@udofin/portal-kit';
import { connection } from 'next/server';
import { PageFrame } from '@/components/page-frame';
import { setupAction, setupConfigDraftAction, setupDraftAction } from '../actions';
import { returnPath, setupSession } from '../setup-session';

export default async function PaymentFeaturesRoute({
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
  const features = lender
    ? await loadPaymentSetupFeatures(page.api, lender.lenderId)
    : ({ ok: false, status: 403, code: 'forbidden' } as const);
  return (
    <PageFrame me={page.session.me} current="/payment-setup">
      <PaymentSetupFeaturesPage
        lender={lender}
        features={features}
        ctx={{
          action: setupAction,
          draft: setupDraftAction,
          draftConfig: setupConfigDraftAction,
          returnTo: returnPath('/payment-setup/features', raw, ['lenderId']),
          grants: page.grants,
          userId: page.userId,
        }}
      />
    </PageFrame>
  );
}
