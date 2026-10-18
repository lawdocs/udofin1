'use server';

import { createApiClient } from '@udofin/auth-client';
import { runServicingOperation, type ServicingStageState } from '@udofin/portal-kit';
import { redirect } from 'next/navigation';
import { currentSession, portalAuth } from '@/lib/auth';

/**
 * Stages one import file (a preview only: nothing is applied). This action serves that one operation and no other, whatever
 * the form says. A file that was staged goes to its preview page; a file the importer refused has no preview page, so the
 * problems found are handed back to the upload form to show.
 */
export async function stageImportAction(
  _previous: ServicingStageState,
  formData: FormData,
): Promise<ServicingStageState> {
  const session = await currentSession();
  if (session.state !== 'ok') return redirect('/login');
  const api = createApiClient({
    baseUrl: portalAuth().apiBaseUrl,
    getAccessToken: () => Promise.resolve(session.accessToken),
    // A file of ten thousand records takes the API several seconds to check.
    timeoutMs: 60_000,
  });
  const outcome = await runServicingOperation(api, formData, 'servicing.import.stage');
  if (!outcome.ok) return { status: 'error', code: outcome.code };
  const stage = outcome.stage ?? ({ status: 'error', code: 'bad_response' } as const);
  if (stage.status === 'staged') {
    return redirect(`/imports/${stage.batchId}${stage.existing ? '?existing=1' : ''}`);
  }
  return stage;
}
