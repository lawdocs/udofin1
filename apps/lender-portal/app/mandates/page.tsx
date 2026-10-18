import { LpMandatesListView, lpLoadMandates } from '@udofin/portal-kit';
import { PageFrame } from '@/components/page-frame';
import { firstParam, keepFilters, paymentsPage } from '../payments/_page-kit';

export default async function MandatesRoute({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const page = await paymentsPage(searchParams);
  if ('blocked' in page) return page.blocked;
  const mandates = await lpLoadMandates(page.api, page.query);
  return (
    <PageFrame me={page.me} current="/mandates">
      <LpMandatesListView
        page={mandates}
        filters={{
          status: firstParam(page.query.status),
          loanAccountId: firstParam(page.query.loanAccountId),
        }}
        keep={keepFilters(page.query, 'mandates')}
      />
    </PageFrame>
  );
}
