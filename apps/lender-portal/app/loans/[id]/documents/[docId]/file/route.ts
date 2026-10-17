import { createApiClient } from '@udofin/auth-client';
import {
  isServicingId,
  loadServicingDocumentContent,
  verifiedServicingDocument,
} from '@udofin/portal-kit';
import { currentSession, portalAuth } from '@/lib/auth';

const plain = (status: number, text: string): Response =>
  new Response(text, { status, headers: { 'cache-control': 'no-store' } });

/**
 * Streams the exact stored PDF of one lender-issued document after the API has authorised the caller, recorded the access
 * and compared the stored bytes with the SHA-256 recorded at registration. The size and the SHA-256 are compared once more
 * here, so a damaged answer is never passed on. Nothing the API said is repeated in an error.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; docId: string }> },
): Promise<Response> {
  const { id, docId } = await params;
  if (!isServicingId(id) || !isServicingId(docId)) return plain(404, 'Not found');
  const session = await currentSession();
  if (session.state !== 'ok') return plain(401, 'Unauthorized');
  const api = createApiClient({
    baseUrl: portalAuth().apiBaseUrl,
    getAccessToken: () => Promise.resolve(session.accessToken),
    timeoutMs: 30_000,
  });
  const result = await loadServicingDocumentContent(api, id, docId, 'view');
  if (!result.ok) {
    if (result.status === 404) return plain(404, 'Not found');
    if (result.status === 401 || result.status === 403) return plain(403, 'Not available');
    if (result.status === 409 || result.status === 503)
      return plain(result.status, 'Not available');
    return plain(502, 'Not available');
  }
  const bytes = await verifiedServicingDocument(result.data);
  if (!bytes) return plain(502, 'Not available');
  return new Response(bytes, {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `inline; filename="document-${docId.slice(0, 8)}.pdf"`,
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
      'content-security-policy': "sandbox; default-src 'none'",
    },
  });
}
