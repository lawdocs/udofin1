import { type Session } from '../src/gotrue.js';

export const USER_ID = '0f0f0f0f-0000-4000-8000-000000000001';

export function jwt(claims: Record<string, unknown>): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'ES256', typ: 'JWT' })}.${enc(claims)}.c2lnbmF0dXJl`;
}

export function accessToken(
  over: { exp?: number; aal?: 'aal1' | 'aal2'; sub?: string } = {},
): string {
  return jwt({
    sub: over.sub ?? USER_ID,
    aal: over.aal ?? 'aal1',
    exp: over.exp ?? Math.floor(Date.now() / 1000) + 900,
    role: 'authenticated',
  });
}

export function sessionOf(over: Partial<Session> = {}): Session {
  return {
    accessToken: accessToken({ exp: over.expiresAt, aal: over.aal }),
    refreshToken: 'refresh-token-1',
    expiresAt: Math.floor(Date.now() / 1000) + 900,
    userId: USER_ID,
    aal: 'aal1',
    ...over,
  };
}

export interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A scripted fetch: matches by "METHOD path" and records every call. */
export function fakeFetch(
  routes: Record<string, (call: Recorded) => Response | Promise<Response>>,
) {
  const calls: Recorded[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    const path = new URL(url).pathname + new URL(url).search;
    const method = init?.method ?? 'GET';
    const call: Recorded = {
      url,
      method,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const handler = routes[`${method} ${path}`] ?? routes[`${method} ${new URL(url).pathname}`];
    if (!handler) return new Response(JSON.stringify({ error: 'unexpected' }), { status: 599 });
    return handler(call);
  }) as typeof fetch;
  return { fetch: impl, calls };
}

export const ok = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
