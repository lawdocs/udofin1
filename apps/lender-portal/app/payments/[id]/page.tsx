import {
  LpPaymentDetailView,
  lpIsUuid,
  lpLoadPaymentDetail,
  lpLoadProviderEvents,
} from '@udofin/portal-kit';
import { notFound } from 'next/navigation';
import { PageFrame } from '@/components/page-frame';
import { paymentsPage } from '../_page-kit';

export default async function PaymentRoute({
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
  const [detail, events] = await Promise.all([
    lpLoadPaymentDetail(page.api, id),
    lpLoadProviderEvents(page.api, {}, { paymentIntentId: id }),
  ]);
  // A payment that does not exist, or belongs to another lender, is the same answer: not found.
  if (!detail.ok && detail.status === 404) notFound();
  return (
    <PageFrame me={page.me} current="/payments">
      <LpPaymentDetailView detail={detail} events={events} />
    </PageFrame>
  );
}
