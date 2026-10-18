import {
  LpSettlementBatchView,
  lpIsUuid,
  lpLoadSettlementBatch,
  lpLoadSettlementItems,
} from '@udofin/portal-kit';
import { notFound } from 'next/navigation';
import { PageFrame } from '@/components/page-frame';
import { keepFilters, paymentsPage } from '../../../payments/_page-kit';

export default async function SettlementBatchRoute({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  if (!lpIsUuid(id)) notFound();
  const page = await paymentsPage(searchParams);
  if ('blocked' in page) return page.blocked;
  const [batch, items] = await Promise.all([
    lpLoadSettlementBatch(page.api, id),
    lpLoadSettlementItems(page.api, id, page.query),
  ]);
  // A batch that does not exist, or belongs to another lender, is the same answer: not found.
  if (!batch.ok && batch.status === 404) notFound();
  return (
    <PageFrame me={page.me} current="/reconciliation">
      <LpSettlementBatchView
        batch={batch}
        items={items}
        keep={keepFilters(page.query, 'items')}
        id={id}
      />
    </PageFrame>
  );
}
