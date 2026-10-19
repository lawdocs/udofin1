import {
  LpProviderEventsView,
  lpLoadProviderEvents,
  lpLoadWebhookSummary,
} from '@udofin/portal-kit';
import { PageFrame } from '@/components/page-frame';
import { firstParam, keepFilters, noLender, paymentsPage } from '../_page-kit';

export default async function ProviderEventsRoute({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const page = await paymentsPage(searchParams);
  if ('blocked' in page) return page.blocked;
  const [summary, events] = await Promise.all([
    page.lenderId ? lpLoadWebhookSummary(page.api, page.lenderId) : Promise.resolve(noLender),
    lpLoadProviderEvents(page.api, page.query),
  ]);
  return (
    <PageFrame me={page.me} current="/payments">
      <LpProviderEventsView
        summary={summary}
        events={events}
        filters={{
          objectKind: firstParam(page.query.objectKind),
          paymentIntentId: firstParam(page.query.paymentIntentId),
        }}
        keep={keepFilters(page.query, 'events')}
      />
    </PageFrame>
  );
}
