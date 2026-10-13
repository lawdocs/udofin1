import { createApiClient } from '@udofin/auth-client';
import { loadExport, parsePanelState } from '@udofin/portal-kit';
import { currentSession, portalAuth } from '@/lib/auth';

/** CSV download of the filtered transactions. The API authorises, caps and audits the export. */
export async function GET(request: Request): Promise<Response> {
  const session = await currentSession();
  if (session.state !== 'ok') return new Response('Unauthorized', { status: 401 });
  const params = Object.fromEntries(new URL(request.url).searchParams.entries());
  const state = parsePanelState(params);
  const api = createApiClient({
    baseUrl: portalAuth().apiBaseUrl,
    getAccessToken: () => Promise.resolve(session.accessToken),
  });
  const result = await loadExport(api, state);
  if (!result.ok)
    return new Response('Not available', { status: result.status === 403 ? 403 : 502 });
  return new Response(result.data.csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${result.data.filename}"`,
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    },
  });
}
