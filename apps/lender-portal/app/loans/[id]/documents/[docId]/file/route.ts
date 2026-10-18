import { createApiClient } from '@udofin/auth-client';
import { openServicingDocument } from '@udofin/portal-kit';
import { currentSession, portalAuth } from '@/lib/auth';

/**
 * Streams the exact stored PDF of one lender-issued document. The session is checked here; everything after that (the API's
 * authorisation and access record, the SHA-256 and size checks, the refusals that repeat nothing the API said) lives in
 * openServicingDocument, which has its own tests.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; docId: string }> },
): Promise<Response> {
  const { id, docId } = await params;
  const session = await currentSession();
  if (session.state !== 'ok')
    return new Response('Unauthorized', { status: 401, headers: { 'cache-control': 'no-store' } });
  const api = createApiClient({
    baseUrl: portalAuth().apiBaseUrl,
    getAccessToken: () => Promise.resolve(session.accessToken),
    timeoutMs: 30_000,
  });
  return openServicingDocument(api, id, docId);
}
