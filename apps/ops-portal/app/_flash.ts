import {
  FLASH_TTL_SECONDS,
  flashCookieName,
  flashPathOf,
  openFlash,
  sealFlash,
  type Flash,
} from '@udofin/portal-kit';
import { cookies } from 'next/headers';
import { portalAuth } from '@/lib/auth';

/** Server-only. Whether the portal's cookies are Secure: the same answer as the session cookies (they carry the `__Host-` prefix). */
const secureCookies = (): boolean => portalAuth().handlers.names.access.startsWith('__Host-');

/**
 * Called by a server action AFTER the API accepted a change: writes the confirmation of the page the action returns to, as a
 * short-lived HttpOnly cookie (see flash.ts in the portal kit for why it is not carried in the address). Nothing is written for
 * a notice the kit would not read back.
 */
export async function rememberSuccess(
  returnTo: string,
  detail: Omit<Flash, 'path'> = {},
): Promise<void> {
  const secure = secureCookies();
  const value = sealFlash({ path: flashPathOf(returnTo), ...detail });
  if (value === undefined) return;
  (await cookies()).set(flashCookieName(secure), value, {
    httpOnly: true,
    sameSite: 'strict',
    secure,
    path: '/',
    maxAge: FLASH_TTL_SECONDS,
  });
}

/** Called by a page: the confirmation the server wrote for THIS page a few seconds ago, or undefined (nothing, or another page's). */
export async function successNotice(path: string): Promise<Flash | undefined> {
  return openFlash((await cookies()).get(flashCookieName(secureCookies()))?.value, path);
}
