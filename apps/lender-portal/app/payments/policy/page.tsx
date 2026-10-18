import { LpPaymentPolicyView, lpLoadPaymentPolicy } from '@udofin/portal-kit';
import { PageFrame } from '@/components/page-frame';
import { noticeFrom, paymentsPage, viewContext } from '../_page-kit';

export default async function PaymentPolicyRoute({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const page = await paymentsPage(searchParams);
  if ('blocked' in page) return page.blocked;
  const policy = await lpLoadPaymentPolicy(page.api);
  const notice = noticeFrom(page.query);
  return (
    <PageFrame me={page.me} current="/payments">
      <LpPaymentPolicyView
        policy={policy}
        ctx={viewContext(page, '/payments/policy')}
        done={notice.done}
        error={notice.error}
      />
    </PageFrame>
  );
}
