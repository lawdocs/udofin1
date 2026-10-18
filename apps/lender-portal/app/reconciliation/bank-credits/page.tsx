import { LpBankCreditUploadView, lpLoadSettlementAccounts } from '@udofin/portal-kit';
import { PageFrame } from '@/components/page-frame';
import { noticeFrom, paymentsPage, viewContext } from '../../payments/_page-kit';

export default async function BankCreditsRoute({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const page = await paymentsPage(searchParams);
  if ('blocked' in page) return page.blocked;
  // The accounts are needed only by a person who may upload.
  const accounts =
    page.caps.reconcile && page.lenderId
      ? await lpLoadSettlementAccounts(page.api, page.lenderId)
      : undefined;
  const notice = await noticeFrom(page.query, '/reconciliation/bank-credits');
  return (
    <PageFrame me={page.me} current="/reconciliation">
      <LpBankCreditUploadView
        accounts={accounts}
        ctx={viewContext(page, '/reconciliation/bank-credits')}
        done={notice.done}
        error={notice.error}
        inserted={notice.inserted}
        duplicates={notice.duplicates}
      />
    </PageFrame>
  );
}
