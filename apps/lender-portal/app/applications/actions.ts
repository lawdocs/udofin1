'use server';

import { ContactResult } from '@udofin/contracts';
import { createApiClient } from '@udofin/auth-client';
import { currentSession, portalAuth } from '@/lib/auth';

export type RevealState = { phone: string | null; error?: string } | null;

/**
 * Reveals the borrower's phone number on request. The API authorises the call, refuses it after consent is
 * withdrawn and audits it without the number; the number is returned to this one response and not stored.
 */
export async function revealContact(
  _previous: RevealState,
  formData: FormData,
): Promise<RevealState> {
  const id = formData.get('id');
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id))
    return { phone: null, error: 'invalid' };
  const session = await currentSession();
  if (session.state !== 'ok') return { phone: null, error: 'signed_out' };
  const api = createApiClient({
    baseUrl: portalAuth().apiBaseUrl,
    getAccessToken: () => Promise.resolve(session.accessToken),
  });
  const result = await api.get(`/v1/lender/applications/${id}/contact`, ContactResult);
  return result.ok ? { phone: result.data.phone } : { phone: null, error: result.code };
}
