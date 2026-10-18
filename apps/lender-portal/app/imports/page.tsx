import { LS_BATCH_STATUSES, LS_IMPORT_KINDS } from '@udofin/contracts';
import {
  isServicingId,
  loadServicingCorrections,
  loadServicingImports,
  loadServicingSyncStatus,
  parseServicingQuery,
  ServicingSyncPage,
} from '@udofin/portal-kit';
import { connection } from 'next/server';
import { PageFrame } from '@/components/page-frame';
import { servicingAction } from '../loans/actions';
import { noticeFrom, servicingSession } from '../loans/servicing-session';
import { stageImportAction } from './actions';

export default async function ImportsRoute({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();
  const page = await servicingSession();
  if ('blocked' in page) return page.blocked;
  const raw = await searchParams;
  const query = parseServicingQuery(raw, { status: LS_BATCH_STATUSES, kind: LS_IMPORT_KINDS });
  const [status, imports, corrections] = await Promise.all([
    loadServicingSyncStatus(page.api),
    loadServicingImports(page.api, query),
    loadServicingCorrections(page.api),
  ]);
  const notice = noticeFrom(raw);
  const correct = typeof raw.correct === 'string' ? raw.correct : undefined;
  return (
    <PageFrame me={page.session.me} current="/imports">
      <ServicingSyncPage
        status={status}
        imports={imports}
        corrections={corrections}
        query={query}
        ctx={{ action: servicingAction, returnTo: '/imports', grants: page.grants }}
        stageAction={stageImportAction}
        correctionOf={isServicingId(correct) ? correct : undefined}
        done={notice.done}
        error={notice.error}
      />
    </PageFrame>
  );
}
