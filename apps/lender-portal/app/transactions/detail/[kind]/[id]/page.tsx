import { createApiClient } from '@udofin/auth-client';
import { loadTransactionDetail, TransactionDetailView } from '@udofin/portal-kit';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { z } from 'zod';
import { PageFrame } from '@/components/page-frame';
import { requireSession } from '@/components/session-gate';
import { portalAuth } from '@/lib/auth';

export default async function TransactionDetailPage({
  params,
}: {
  params: Promise<{ kind: string; id: string }>;
}) {
  await connection();
  const p = z
    .object({ kind: z.enum(['application', 'loan_account', 'payment']), id: z.uuid() })
    .safeParse(await params);
  if (!p.success) return notFound();
  const session = await requireSession();
  if ('blocked' in session) return session.blocked;
  const api = createApiClient({
    baseUrl: portalAuth().apiBaseUrl,
    getAccessToken: () => Promise.resolve(session.accessToken),
  });
  const detail = await loadTransactionDetail(api, p.data.kind, p.data.id);
  if (!detail.ok && detail.status === 404) return notFound();
  return (
    <PageFrame me={session.me} current="/transactions">
      <TransactionDetailView detail={detail} base="/transactions" />
    </PageFrame>
  );
}
