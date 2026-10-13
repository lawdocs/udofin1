import { type NextRequest, NextResponse } from 'next/server';
import { portalAuth } from '@/lib/auth';

/**
 * Issues a fresh nonce per request and a strict Content-Security-Policy: no inline scripts or
 * styles except those Next.js tags with the nonce, no framing, no third-party origins.
 * It also keeps the staff session fresh: a nearly expired access token is refreshed here (refresh
 * tokens rotate, so exactly one place does it), and a rejected refresh clears the cookies. Whether
 * the person may see a page is decided by the API when the page renders, never in this file.
 */
export async function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const isDev = process.env.NODE_ENV === 'development';
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''}`,
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' blob: data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    'upgrade-insecure-requests',
  ].join('; ');

  const { handlers, portalOrigin } = portalAuth();
  const { pathname } = request.nextUrl;
  const isPublic = pathname === '/login' || pathname.startsWith('/auth/');
  const hasSession = request.cookies.has(handlers.names.refresh);

  // No session at all: go to sign-in (this is a convenience; pages re-check with the API).
  if (!isPublic && !hasSession) {
    const redirect = NextResponse.redirect(new URL('/login', portalOrigin));
    redirect.headers.set('Content-Security-Policy', csp);
    return redirect;
  }

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);

  const refreshed =
    hasSession && !pathname.startsWith('/auth/')
      ? await handlers.refreshIfNeeded(request)
      : { setCookies: [] };
  if (refreshed.cookieHeader) requestHeaders.set('cookie', refreshed.cookieHeader);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  for (const cookie of refreshed.setCookies) response.headers.append('set-cookie', cookie);
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  matcher: [
    {
      source: '/((?!_next/static|_next/image|favicon.ico|theme.css).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
