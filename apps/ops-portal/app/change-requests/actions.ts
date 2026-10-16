'use server';

import { createApiClient } from '@udofin/auth-client';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { currentSession, portalAuth } from '@/lib/auth';

const Input = z.object({
  id: z.uuid(),
  verb: z.enum(['approve', 'reject']),
  // Generated when the page rendered: a double click or a retry re-sends the same key, so the
  // decision is applied once (the API replays the stored result).
  key: z.string().regex(/^[A-Za-z0-9._:-]{16,128}$/),
});

export async function decideAction(formData: FormData): Promise<void> {
  const parsed = Input.safeParse({
    id: formData.get('id'),
    verb: formData.get('verb'),
    key: formData.get('key'),
  });
  if (!parsed.success) return redirect('/change-requests?error=invalid_request');
  const session = await currentSession();
  if (session.state !== 'ok') return redirect('/login');
  const api = createApiClient({
    baseUrl: portalAuth().apiBaseUrl,
    getAccessToken: () => Promise.resolve(session.accessToken),
  });
  const result = await api.decideChangeRequest(parsed.data.id, parsed.data.verb, parsed.data.key);
  return redirect(
    result.ok
      ? `/change-requests?result=${result.data.status}`
      : `/change-requests?error=${encodeURIComponent(result.code)}`,
  );
}
