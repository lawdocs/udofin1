import { LpExceptionsQueueView, lpLoadExceptions } from '@udofin/portal-kit';
import { PageFrame } from '@/components/page-frame';
import { firstParam, keepFilters, paymentsPage } from '../../payments/_page-kit';

export default async function ExceptionsRoute({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const page = await paymentsPage(searchParams);
  if ('blocked' in page) return page.blocked;
  const exceptions = await lpLoadExceptions(page.api, page.query);
  return (
    <PageFrame me={page.me} current="/reconciliation">
      <LpExceptionsQueueView
        page={exceptions}
        filters={{
          status: firstParam(page.query.status),
          severity: firstParam(page.query.severity),
          owner: firstParam(page.query.owner),
          class: firstParam(page.query.class),
        }}
        keep={keepFilters(page.query, 'exceptions')}
        userId={page.userId}
      />
    </PageFrame>
  );
}
