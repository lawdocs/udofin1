/**
 * Fixed-window counter. IN-MEMORY and per process: it slows guessing against one instance but is NOT
 * a shared control. Each portal instance counts on its own, so the limits below are only meaningful
 * with a SINGLE instance of the portal; running more than one multiplies every limit by the number of
 * instances and a request can be retried against another instance. A shared store needs an approved
 * decision (docs/auth/README.md). Supabase Auth's own rate limits are the authoritative protection.
 */
export interface RateLimiter {
  /** Records an attempt; returns false when the key is over its limit. */
  hit(key: string, limit: number, windowSeconds: number): boolean;
}

/**
 * Placeholders `clientAddress` returns when no usable client address exists: `direct` (no trusted proxy is
 * configured, so the portal cannot see who connected) and `unknown` (behind a configured proxy, but the
 * forwarded header is missing or malformed). Several visitors can share such a placeholder, so it must
 * NEVER be used as a rate-limit key: one attacker would exhaust the bucket for everybody.
 */
export const UNATTRIBUTED_ADDRESSES: readonly string[] = ['direct', 'unknown'];

export const isAttributedAddress = (address: string): boolean =>
  !UNATTRIBUTED_ADDRESSES.includes(address);

export function createMemoryRateLimiter(now: () => number = () => Date.now()): RateLimiter {
  const windows = new Map<string, { start: number; count: number }>();
  return {
    hit(key, limit, windowSeconds) {
      const t = now();
      const entry = windows.get(key);
      if (!entry || t - entry.start >= windowSeconds * 1000) {
        windows.set(key, { start: t, count: 1 });
        if (windows.size > 10_000) {
          for (const [k, v] of windows) if (t - v.start >= windowSeconds * 1000) windows.delete(k);
          // Still too many live keys (for example forged addresses): drop the oldest so memory stays bounded.
          for (const k of windows.keys()) {
            if (windows.size <= 8_000) break;
            windows.delete(k);
          }
        }
        return true;
      }
      entry.count += 1;
      return entry.count <= limit;
    },
  };
}
