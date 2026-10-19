import { LpMandateDebitsView, lpLoadMandateDebits } from '@udofin/portal-kit';
import { PageFrame } from '@/components/page-frame';
import { firstParam, keepFilters, paymentsPage } from '../../payments/_page-kit';

export default async function MandateDebitsRoute({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const page = await paymentsPage(searchParams);
  if ('blocked' in page) return page.blocked;
  const debits = await lpLoadMandateDebits(page.api, page.query);
  return (
    <PageFrame me={page.me} current="/mandates">
      <LpMandateDebitsView
        page={debits}
        filters={{
          status: firstParam(page.query.status),
          planned: firstParam(page.query.planned),
          mandateId: firstParam(page.query.mandateId),
        }}
        keep={keepFilters(page.query, 'debits')}
      />
    </PageFrame>
  );
}
