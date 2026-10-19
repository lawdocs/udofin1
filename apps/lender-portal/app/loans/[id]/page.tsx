import {
  isServicingId,
  loadServicingConflicts,
  loadServicingAnomalies,
  loadServicingDocuments,
  loadServicingLoan,
  loadServicingQuotes,
  loadServicingRequests,
  ServicingLoanDetailPage,
} from '@udofin/portal-kit';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { PageFrame } from '@/components/page-frame';
import { servicingAction } from '../actions';
import { noticeFrom, servicingSession } from '../servicing-session';

export default async function LoanRoute({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();
  const { id } = await params;
  if (!isServicingId(id)) notFound();
  const page = await servicingSession();
  if ('blocked' in page) return page.blocked;
  const { api } = page;
  const [detail, conflicts, anomalies, documents, quotes, requests] = await Promise.all([
    loadServicingLoan(api, id),
    loadServicingConflicts(api, { loanAccountId: id }),
    loadServicingAnomalies(api, { loanAccountId: id }),
    loadServicingDocuments(api, id),
    loadServicingQuotes(api, id),
    loadServicingRequests(api, { loanAccountId: id, status: 'requested' }),
  ]);
  if (!detail.ok && detail.status === 404) notFound();
  const notice = await noticeFrom(await searchParams, `/loans/${id}`);
  return (
    <PageFrame me={page.session.me} current="/loans">
      <ServicingLoanDetailPage
        detail={detail}
        conflicts={conflicts}
        anomalies={anomalies}
        documents={documents}
        quotes={quotes}
        requests={requests}
        ctx={{ action: servicingAction, returnTo: `/loans/${id}`, grants: page.grants }}
        done={notice.done}
        error={notice.error}
      />
    </PageFrame>
  );
}
