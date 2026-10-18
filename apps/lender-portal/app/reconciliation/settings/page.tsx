import { LpReconciliationSettingsView, lpLoadReconSettings } from '@udofin/portal-kit';
import { PageFrame } from '@/components/page-frame';
import { noticeFrom, paymentsPage, viewContext } from '../../payments/_page-kit';

export default async function ReconciliationSettingsRoute({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const page = await paymentsPage(searchParams);
  if ('blocked' in page) return page.blocked;
  const settings = await lpLoadReconSettings(page.api);
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
