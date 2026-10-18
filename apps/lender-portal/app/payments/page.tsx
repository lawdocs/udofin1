import { LpPaymentsListView, lpLoadPayments } from '@udofin/portal-kit';
import { PageFrame } from '@/components/page-frame';
import { firstParam, keepFilters, noticeFrom, paymentsPage } from './_page-kit';

export default async function PaymentsRoute({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const page = await paymentsPage(searchParams);
  if ('blocked' in page) return page.blocked;
  const payments = await lpLoadPayments(page.api, page.query);
  const notice = noticeFrom(page.query);
  return (
    <PageFrame me={page.me} current="/payments">
      <LpPaymentsListView
        page={payments}
        filters={{
          status: firstParam(page.query.status),
          purpose: firstParam(page.query.purpose),
          loanAccountId: firstParam(page.query.loanAccountId),
        }}
        keep={keepFilters(page.query, 'payments')}
        done={notice.done}
        error={notice.error}
      />
    </PageFrame>
  );
}
