import { LpSettlementBatchesView, lpLoadSettlementBatches } from '@udofin/portal-kit';
import { PageFrame } from '@/components/page-frame';
import { keepFilters, paymentsPage } from '../../payments/_page-kit';

export default async function SettlementsRoute({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const page = await paymentsPage(searchParams);
  if ('blocked' in page) return page.blocked;
  const batches = await lpLoadSettlementBatches(page.api, page.query);
  return (
    <PageFrame me={page.me} current="/reconciliation">
      <LpSettlementBatchesView page={batches} keep={keepFilters(page.query, 'batches')} />
    </PageFrame>
  );
}
