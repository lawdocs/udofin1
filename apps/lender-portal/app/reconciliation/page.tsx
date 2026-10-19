import { LpReconciliationRunsView, lpLoadReconRuns } from '@udofin/portal-kit';
import { PageFrame } from '@/components/page-frame';
import { keepFilters, noLender, paymentsPage } from '../payments/_page-kit';

export default async function ReconciliationRoute({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const page = await paymentsPage(searchParams);
  if ('blocked' in page) return page.blocked;
  // The runs of the lender acted for: a report opens for that lender only, so the list shows that lender's runs only.
  const runs = page.lenderId
    ? await lpLoadReconRuns(page.api, page.query, page.lenderId)
    : noLender;
  return (
    <PageFrame me={page.me} current="/reconciliation">
      <LpReconciliationRunsView
        page={runs}
        keep={{
          ...keepFilters(page.query, 'runs'),
          ...(page.lenderId ? { lenderId: page.lenderId } : {}),
        }}
        lenders={page.lenders}
        lenderId={page.lenderId}
      />
    </PageFrame>
  );
}
