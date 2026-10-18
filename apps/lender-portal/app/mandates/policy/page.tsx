import { LpMandatePolicyView, lpLoadMandatePolicy } from '@udofin/portal-kit';
import { PageFrame } from '@/components/page-frame';
import { noLender, noticeFrom, paymentsPage, viewContext } from '../../payments/_page-kit';

export default async function MandatePolicyRoute({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const page = await paymentsPage(searchParams);
  if ('blocked' in page) return page.blocked;
  // The policy of the lender acted for only: the list is asked for that lender, never for every lender the person belongs to.
  const policy = page.lenderId ? await lpLoadMandatePolicy(page.api, page.lenderId) : noLender;
  const notice = await noticeFrom(page.query, '/mandates/policy');
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
