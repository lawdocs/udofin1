import { LpReconciliationSettingsView, lpLoadReconSettings } from '@udofin/portal-kit';
import { PageFrame } from '@/components/page-frame';
import { noLender, noticeFrom, paymentsPage, viewContext } from '../../payments/_page-kit';

export default async function ReconciliationSettingsRoute({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const page = await paymentsPage(searchParams);
  if ('blocked' in page) return page.blocked;
  // The waiting times of the lender acted for only: the list is asked for that lender, never for every lender the person belongs to.
  const settings = page.lenderId ? await lpLoadReconSettings(page.api, page.lenderId) : noLender;
  const notice = noticeFrom(page.query);
  return (
    <PageFrame me={page.me} current="/reconciliation">
      <LpReconciliationSettingsView
        settings={settings}
        ctx={viewContext(page, '/reconciliation/settings')}
        done={notice.done}
        error={notice.error}
      />
    </PageFrame>
  );
}
