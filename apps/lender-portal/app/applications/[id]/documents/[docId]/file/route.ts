import { createApiClient } from '@udofin/auth-client';
import { IssuedDocumentContent } from '@udofin/contracts';
import { z } from 'zod';
import { currentSession, portalAuth } from '@/lib/auth';

/** Streams the exact stored file of one document after the API has authorised and recorded the retrieval. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; docId: string }> },
): Promise<Response> {
  const { id, docId } = await params;
  if (!z.uuid().safeParse(id).success || !z.uuid().safeParse(docId).success)
    return new Response('Not found', { status: 404 });
  const session = await currentSession();
  if (session.state !== 'ok') return new Response('Unauthorized', { status: 401 });
  const api = createApiClient({
    baseUrl: portalAuth().apiBaseUrl,
    getAccessToken: () => Promise.resolve(session.accessToken),
  });
  const result = await api.get(
    `/v1/lender/documents/${docId}/content?purpose=view`,
    IssuedDocumentContent,
  );
  if (!result.ok)
    return new Response('Not available', { status: result.status === 404 ? 404 : 403 });
  return new Response(Buffer.from(result.data.contentBase64, 'base64'), {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `inline; filename="document-${result.data.documentId.slice(0, 8)}-v${String(result.data.version)}.pdf"`,
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    },
  });
}
