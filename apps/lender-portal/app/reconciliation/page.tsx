import { LpReconciliationRunsView, lpLoadReconRuns } from '@udofin/portal-kit';
import { PageFrame } from '@/components/page-frame';
import { keepFilters, paymentsPage } from '../payments/_page-kit';

export default async function ReconciliationRoute({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const page = await paymentsPage(searchParams);
  if ('blocked' in page) return page.blocked;
  const runs = await lpLoadReconRuns(page.api, page.query);
  return (
    <PageFrame me={page.me} current="/reconciliation">
      <LpReconciliationRunsView page={runs} keep={keepFilters(page.query, 'runs')} />
    </PageFrame>
  );
}
