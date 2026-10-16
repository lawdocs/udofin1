import { createApiClient } from '@udofin/auth-client';
import { capabilitiesFrom, loadProducts, ProductsPage } from '@udofin/portal-kit';
import { connection } from 'next/server';
import { PageFrame } from '@/components/page-frame';
import { requireSession } from '@/components/session-gate';
import { portalAuth } from '@/lib/auth';
import { onboardingAction } from '../onboarding/actions';

export default async function ProductsRoute({
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
  const [products, , categories] = await loadProducts(api);
  const caps = capabilitiesFrom(session.me.memberships.flatMap((m) => m.permissions));
  // A lender user belongs to one lender; the create form needs its id.
  const lenderId = session.me.memberships.find(
    (m) => m.organizationKind === 'lender',
  )?.organizationId;
  return (
    <PageFrame me={session.me} current="/products">
      <ProductsPage
        products={products}
        categories={
          categories.ok
            ? categories.data.items
                .filter((c) => c.availability === 'enabled')
                .map((c) => ({ key: c.key, label: c.name }))
            : []
        }
        lenderId={lenderId}
        ctx={{
          portal: 'ops',
          caps,
          action: onboardingAction,
          returnTo: '/products',
          userId: session.me.userId,
        }}
        done={query.done === '1'}
        error={typeof query.error === 'string' ? query.error : undefined}
      />
    </PageFrame>
  );
}
