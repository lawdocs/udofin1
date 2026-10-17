import { LpReconciliationReportView, lpIsDate, lpLoadReconSummary } from '@udofin/portal-kit';
import { notFound } from 'next/navigation';
import { PageFrame } from '@/components/page-frame';
import { noLender, paymentsPage } from '../../../payments/_page-kit';

export default async function ReconciliationReportRoute({
  params,
  searchParams,
}: {
  params: Promise<{ date: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { date } = await params;
  if (!lpIsDate(date)) notFound();
  const page = await paymentsPage(searchParams);
  if ('blocked' in page) return page.blocked;
  const summary = page.lenderId
    ? await lpLoadReconSummary(page.api, page.lenderId, date)
    : noLender;
  return (
    <PageFrame me={page.me} current="/reconciliation">
      <LpReconciliationReportView summary={summary} date={date} />
    </PageFrame>
  );
}
