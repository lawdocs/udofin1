import { LpExceptionDetailView, lpIsUuid, lpLoadExceptionDetail } from '@udofin/portal-kit';
import { notFound } from 'next/navigation';
import { PageFrame } from '@/components/page-frame';
import { noticeFrom, paymentsPage, viewContext } from '../../../payments/_page-kit';

export default async function ExceptionRoute({
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
  const detail = await lpLoadExceptionDetail(page.api, id);
  // An exception that does not exist, or belongs to another lender, is the same answer: not found.
  if (!detail.ok && detail.status === 404) notFound();
  const notice = noticeFrom(page.query);
  return (
    <PageFrame me={page.me} current="/reconciliation">
      <LpExceptionDetailView
        detail={detail}
        ctx={viewContext(page, `/reconciliation/exceptions/${id}`)}
        done={notice.done}
        error={notice.error}
      />
    </PageFrame>
  );
}
