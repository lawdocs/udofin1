export interface CookieOptions {
  secure: boolean;
  /** Seconds; omit for a session cookie (cleared when the browser closes). */
  maxAge?: number;
}

export interface SessionCookieNames {
  access: string;
  refresh: string;
}

/**
 * `__Host-` cookies are origin-locked: Secure, Path=/, no Domain, so a sibling sub-domain cannot set
 * or overwrite them. Browsers only accept the prefix on HTTPS, so local http development drops it.
 */
export function cookieNames(secure: boolean): SessionCookieNames {
  const prefix = secure ? '__Host-' : '';
  return { access: `${prefix}udofin_at`, refresh: `${prefix}udofin_rt` };
}

const TOKEN_VALUE = /^[A-Za-z0-9._~+/=-]+$/;

export function serializeSessionCookie(
  name: string,
  value: string,
  options: CookieOptions,
): string {
  if (!TOKEN_VALUE.test(value))
    throw new Error('refusing to set a cookie with unexpected characters');
  const parts = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict'];
  if (options.secure) parts.push('Secure');
  if (options.maxAge !== undefined) parts.push(`Max-Age=${String(options.maxAge)}`);
  return parts.join('; ');
}

export function clearSessionCookie(name: string, options: CookieOptions): string {
  const parts = [
    `${name}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ];
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

export function parseCookieHeader(header: string | null | undefined): Map<string, string> {
  const result = new Map<string, string>();
  if (!header) return result;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name && !result.has(name)) result.set(name, value);
  }
  return result;
}
