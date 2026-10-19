import { type ApiResult } from '@udofin/auth-client';
import { useCallback, useEffect, useState } from 'react';

export type LoadState<T> =
  { kind: 'loading' } | { kind: 'ready'; data: T } | { kind: 'error'; code: string };

interface Settled<T> {
  deps: readonly unknown[];
  tick: number;
  value: LoadState<T>;
}

/**
 * Runs a read on mount, when `deps` change, and on `reload`. Failures become codes (never thrown), so every
 * screen can show a retry. A result belongs to the inputs it was fetched for; if they changed, the state is
 * "loading" again, without any state being set inside the effect itself.
 */
export function useLoad<T>(
  fetcher: () => Promise<ApiResult<T>>,
  deps: readonly unknown[],
): { state: LoadState<T>; reload: () => void } {
  const [settled, setSettled] = useState<Settled<T> | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void fetcher().then((result) => {
      if (cancelled) return;
      setSettled({
        deps,
        tick,
        value: result.ok
          ? { kind: 'ready', data: result.data }
          : { kind: 'error', code: result.code },
      });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, ...deps]);

  const current =
    settled !== null &&
    settled.tick === tick &&
    settled.deps.length === deps.length &&
    settled.deps.every((d, i) => Object.is(d, deps[i]));
  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { state: current && settled ? settled.value : { kind: 'loading' }, reload };
}
