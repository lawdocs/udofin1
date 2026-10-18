import { LpMandatePolicyView, lpLoadMandatePolicy } from '@udofin/portal-kit';
import { PageFrame } from '@/components/page-frame';
import { noticeFrom, paymentsPage, viewContext } from '../../payments/_page-kit';

export default async function MandatePolicyRoute({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const page = await paymentsPage(searchParams);
  if ('blocked' in page) return page.blocked;
  const policy = await lpLoadMandatePolicy(page.api);
  const notice = noticeFrom(page.query);
  return (
    <PageFrame me={page.me} current="/mandates">
      <LpMandatePolicyView
        policy={policy}
        ctx={viewContext(page, '/mandates/policy')}
        done={notice.done}
        error={notice.error}
      />
    </PageFrame>
  );
}
