import { createApiClient } from '@udofin/auth-client';
import {
  capabilitiesFrom,
  loadPanel,
  parsePanelState,
  stateToParams,
  TransactionsPanel,
  loadPanelViews,
} from '@udofin/portal-kit';
import { connection } from 'next/server';
import { PageFrame } from '@/components/page-frame';
import { requireSession } from '@/components/session-gate';
import { portalAuth } from '@/lib/auth';
import { onboardingAction } from '../onboarding/actions';

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();
  const session = await requireSession();
  if ('blocked' in session) return session.blocked;
  const query = await searchParams;
  const api = createApiClient({
    baseUrl: portalAuth().apiBaseUrl,
    getAccessToken: () => Promise.resolve(session.accessToken),
  });
  // A saved view supplies defaults; choices in the URL override it.
  const viewId = typeof query.view === 'string' ? query.view : undefined;
  const lenderId = typeof query.lenderId === 'string' ? query.lenderId : undefined;
  const views = viewId ? await loadPanelViews(api, lenderId) : undefined;
  const view = views?.ok ? views.data.items.find((v) => v.id === viewId)?.config : undefined;
  const hasExplicit = ['kinds', 'statuses', 'columns', 'order', 'groupBy'].some((k) => k in query);
  const state = parsePanelState(query, hasExplicit ? undefined : view);
  const data = await loadPanel(api, state);
  const caps = capabilitiesFrom(session.me.memberships.flatMap((m) => m.permissions));
  const returnTo = `/transactions?${stateToParams(state)}`.slice(0, 600);
  return (
    <PageFrame me={session.me} current="/transactions">
      <TransactionsPanel
        state={state}
        data={{
          catalogue: data.catalogue,
          page: data.page,
          summary: data.summary,
          views: data.views,
          products: data.products,
        }}
        ctx={{
          portal: 'lender',
          caps,
          action: onboardingAction,
          returnTo,
          userId: session.me.userId,
        }}
        base="/transactions"
        exportBase="/transactions/export"
        done={query.done === '1'}
        error={typeof query.error === 'string' ? query.error : undefined}
      />
    </PageFrame>
  );
}
