import { createApiClient } from '@udofin/auth-client';
import { EmptyState, ErrorState } from '@udofin/portal-kit';
import { connection } from 'next/server';
import { PageFrame } from '@/components/page-frame';
import { requireSession } from '@/components/session-gate';
import { portalAuth } from '@/lib/auth';
import { decideAction } from './actions';

const MESSAGES: Record<string, string> = {
  forbidden: 'You are not allowed to do that.',
  conflict: 'That request has already been decided or changed.',
  not_found: 'That request was not found.',
  invalid_request: 'The request was not valid.',
};

export default async function ChangeRequestsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await connection();
  const session = await requireSession();
  if ('blocked' in session) return session.blocked;
  const { me, accessToken } = session;
  const query = await searchParams;
  const cursor = typeof query.cursor === 'string' ? query.cursor : undefined;
  const RESULTS = ['approved', 'rejected', 'expired', 'pending', 'applied'];
  const result =
    typeof query.result === 'string' && RESULTS.includes(query.result) ? query.result : undefined;
  const error = typeof query.error === 'string' ? query.error : undefined;

  const api = createApiClient({
    baseUrl: portalAuth().apiBaseUrl,
    getAccessToken: () => Promise.resolve(accessToken),
  });
  const page = await api.listChangeRequests({ ...(cursor ? { cursor } : {}), limit: 25 });

  return (
    <PageFrame me={me} current="/change-requests">
      <h1>Change requests</h1>
      <p className="muted">
        Administrative changes need a second person. You cannot approve a request you filed.
        Approved changes are applied automatically a few seconds later.
      </p>
      {result ? <p role="status">Request {result}.</p> : null}
      {error ? <p role="alert">{MESSAGES[error] ?? 'The action could not be completed.'}</p> : null}
      {!page.ok ? (
        page.status === 403 ? (
          <ErrorState
            title="You cannot view change requests"
            detail="Your role does not include this."
          />
        ) : (
          <ErrorState
            title="Could not load change requests"
            detail="Reload the page. If it continues, contact the platform team."
          />
        )
      ) : page.data.items.length === 0 ? (
        <EmptyState title="No change requests" detail="Requests you can see will appear here." />
      ) : (
        <>
          <table>
            <caption className="sr-only">Change requests, newest first</caption>
            <thead>
              <tr>
                <th scope="col">Type</th>
                <th scope="col">Status</th>
                <th scope="col">Filed by</th>
                <th scope="col">Expires</th>
                <th scope="col">Decision</th>
              </tr>
            </thead>
            <tbody>
              {page.data.items.map((item) => (
                <tr key={item.id}>
                  <th scope="row">{item.type}</th>
                  <td>{item.status}</td>
                  <td>{item.requestedBy === me.userId ? 'You' : 'Another person'}</td>
                  <td>{item.expiresAt.slice(0, 16)}</td>
                  <td>
                    {item.status === 'pending' && item.requestedBy !== me.userId ? (
                      <form action={decideAction} className="inline">
                        <input type="hidden" name="id" value={item.id} />
                        <input type="hidden" name="key" value={`ops-${crypto.randomUUID()}`} />
                        <button type="submit" name="verb" value="approve">
                          Approve
                        </button>
                        <button type="submit" name="verb" value="reject" className="secondary">
                          Reject
                        </button>
                      </form>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {page.data.nextCursor ? (
            <p>
              <a href={`/change-requests?cursor=${encodeURIComponent(page.data.nextCursor)}`}>
                Older requests
              </a>
            </p>
          ) : null}
        </>
      )}
    </PageFrame>
  );
}
