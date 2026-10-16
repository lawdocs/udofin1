import { createApiClient } from '@udofin/auth-client';
import { loadDocument } from '@udofin/portal-kit';
import { z } from 'zod';
import { currentSession, portalAuth } from '@/lib/auth';

/** Streams one onboarding document after the API has authorised and audited the retrieval. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const parsed = z.uuid().safeParse((await params).id);
  if (!parsed.success) return new Response('Not found', { status: 404 });
  const session = await currentSession();
  if (session.state !== 'ok') return new Response('Unauthorized', { status: 401 });
  const api = createApiClient({
    baseUrl: portalAuth().apiBaseUrl,
    getAccessToken: () => Promise.resolve(session.accessToken),
  });
  const doc = await loadDocument(api, parsed.data);
  if (!doc.ok) return new Response('Not available', { status: doc.status === 404 ? 404 : 403 });
  const extension =
    doc.data.mimeType === 'application/pdf'
      ? 'pdf'
      : doc.data.mimeType === 'image/png'
        ? 'png'
        : 'jpg';
  return new Response(Buffer.from(doc.data.contentBase64, 'base64'), {
    headers: {
      'content-type': doc.data.mimeType,
      'content-disposition': `attachment; filename="document-${doc.data.id.slice(0, 8)}.${extension}"`,
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    },
  });
}
