/** Warn this many days before a draft closes. Expiry itself is fixed at creation and never extended. */
export const EXPIRY_WARNING_DAYS = 7;

export type ExpiryState =
  | { kind: 'none' }
  | { kind: 'expired' }
  | { kind: 'today' }
  | { kind: 'soon'; days: number }
  | { kind: 'later'; days: number };

/** Based on the server's `expiresAt`; the client never computes a deadline of its own. */
export function expiryState(
  status: string,
  expiresAt: string | null,
  now: Date = new Date(),
): ExpiryState {
  if (status === 'expired') return { kind: 'expired' };
  if (status !== 'draft' || !expiresAt) return { kind: 'none' };
  const end = new Date(expiresAt).getTime();
  if (Number.isNaN(end)) return { kind: 'none' };
  const remaining = end - now.getTime();
  if (remaining <= 0) return { kind: 'expired' };
  const days = Math.ceil(remaining / 86_400_000);
  if (days <= 1) return { kind: 'today' };
  return days <= EXPIRY_WARNING_DAYS ? { kind: 'soon', days } : { kind: 'later', days };
}
