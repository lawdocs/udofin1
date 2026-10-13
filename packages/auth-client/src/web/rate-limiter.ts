/**
 * Fixed-window counter. IN-MEMORY and per process: it slows guessing against one instance but is NOT
 * a shared control. Supabase Auth's own rate limits are the authoritative protection; with more than
 * one portal instance, replace this with a shared store (documented limitation, docs/auth/README.md).
 */
export interface RateLimiter {
  /** Records an attempt; returns false when the key is over its limit. */
  hit(key: string, limit: number, windowSeconds: number): boolean;
}

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
        }
        return true;
      }
      entry.count += 1;
      return entry.count <= limit;
    },
  };
}
