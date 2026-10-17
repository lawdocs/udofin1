import { isServicingId, loadServicingImport, ServicingImportPage } from '@udofin/portal-kit';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { PageFrame } from '@/components/page-frame';
import { servicingAction } from '../../loans/actions';
import { noticeFrom, servicingSession } from '../../loans/servicing-session';

export default async function ImportRoute({
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
  const detail = await loadServicingImport(page.api, id);
  if (!detail.ok && detail.status === 404) notFound();
  const raw = await searchParams;
  const notice = noticeFrom(raw);
  return (
    <PageFrame me={page.session.me} current="/imports">
      <ServicingImportPage
        detail={detail}
        ctx={{ action: servicingAction, returnTo: `/imports/${id}`, grants: page.grants }}
        existing={raw.existing === '1'}
        done={notice.done}
        error={notice.error}
      />
    </PageFrame>
  );
}
