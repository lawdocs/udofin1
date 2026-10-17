import { LS_LOAN_STATUSES } from '@udofin/contracts';
import { loadServicingLoans, parseServicingQuery, ServicingLoansPage } from '@udofin/portal-kit';
import { connection } from 'next/server';
import { PageFrame } from '@/components/page-frame';
import { servicingAction } from './actions';
import { returnPath, servicingSession } from './servicing-session';

export default async function LoansRoute({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();
  const page = await servicingSession();
  if ('blocked' in page) return page.blocked;
  const raw = await searchParams;
  const query = parseServicingQuery(raw, { status: LS_LOAN_STATUSES });
  const loans = await loadServicingLoans(page.api, query);
  return (
    <PageFrame me={page.session.me} current="/loans">
      <ServicingLoansPage
        page={loans}
        query={query}
        ctx={{
          action: servicingAction,
          returnTo: returnPath('/loans', raw, ['status', 'lenderId']),
          grants: page.grants,
        }}
      />
    </PageFrame>
  );
}
