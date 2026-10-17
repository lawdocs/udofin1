import { LS_ANOMALY_SEVERITIES } from '@udofin/contracts';
import {
  loadServicingAnomalies,
  parseServicingQuery,
  ServicingAnomaliesPage,
} from '@udofin/portal-kit';
import { connection } from 'next/server';
import { PageFrame } from '@/components/page-frame';
import { servicingSession } from '../../loans/servicing-session';

export default async function AnomaliesRoute({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();
  const page = await servicingSession();
  if ('blocked' in page) return page.blocked;
  const query = parseServicingQuery(await searchParams, { severity: LS_ANOMALY_SEVERITIES });
  const anomalies = await loadServicingAnomalies(page.api, query);
  return (
    <PageFrame me={page.session.me} current="/imports">
      <ServicingAnomaliesPage page={anomalies} query={query} />
    </PageFrame>
  );
}
