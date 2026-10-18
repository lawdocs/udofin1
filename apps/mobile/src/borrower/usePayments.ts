import { type ApiResult } from '@udofin/auth-client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useAuth } from '../auth/AuthProvider';
import { createMandatesClient, type MandatesClient } from './mandates';
import { createPaymentsClient, type PaymentsClient } from './payments';
import { pollLoop, type PollContext } from './payments-polling';

export function usePaymentsClient(): PaymentsClient {
  const { api } = useAuth();
  return useMemo(() => createPaymentsClient(api), [api]);
}

export function useMandatesClient(): MandatesClient {
  const { api } = useAuth();
  return useMemo(() => createMandatesClient(api), [api]);
}

export type PolledState<T> =
  | { kind: 'loading' }
  | { kind: 'ready'; data: T; refreshFailed: boolean }
  | { kind: 'error'; code: string };

export interface Polled<T> {
  state: PolledState<T>;
  /** True while automatic checking is running. */
  polling: boolean;
  /** Reads again now and starts a new run of automatic checks. */
  refresh: () => void;
  /** The borrower opened the provider's page in this visit. */
  linkOpened: boolean;
  markLinkOpened: () => void;
}

/**
 * Reads a payment or a mandate and keeps reading it, with back-off, for as long as `delayFor` says waiting can help. Automatic
 * checking ends the moment the screen is left (the loop is told it is cancelled and its pending wait is cleared), and it also
 * ends at the first failed read, at the attempt limit, or when `delayFor` says stop. Coming back to the app from the background
 * reads again. If a later read fails the last good data stays on screen with a flag, so a notice can say it may be out of date.
 *
 * The screen must be keyed by the id it shows, so a new id starts a new instance.
 */
export function usePolled<T>(
  load: () => Promise<ApiResult<T>>,
  delayFor: (data: T, context: PollContext) => number | null,
): Polled<T> {
  const [state, setState] = useState<PolledState<T>>({ kind: 'loading' });
  const [polling, setPolling] = useState(true);
  const [nonce, setNonce] = useState(0);
  const [linkOpened, setLinkOpened] = useState(false);
  const latest = useRef({ load, delayFor, linkOpened });

  useEffect(() => {
    latest.current = { load, delayFor, linkOpened };
  });

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void pollLoop<T>({
      load: () => latest.current.load(),
      delayFor: (data, attempt) =>
        latest.current.delayFor(data, { attempt, linkOpened: latest.current.linkOpened }),
      sleep: (ms) =>
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, ms);
        }),
      isCancelled: () => cancelled,
      onResult: (result) =>
        setState((previous) => {
          if (result.ok) return { kind: 'ready', data: result.data, refreshFailed: false };
          return previous.kind === 'ready'
            ? { ...previous, refreshFailed: true }
            : { kind: 'error', code: result.code };
        }),
    }).then(() => {
      if (!cancelled) setPolling(false);
    });
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [nonce]);

  const refresh = useCallback(() => {
    setState((previous) => (previous.kind === 'error' ? { kind: 'loading' } : previous));
    setPolling(true);
    setNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') refresh();
    });
    return () => subscription.remove();
  }, [refresh]);

  const markLinkOpened = useCallback(() => {
    setLinkOpened(true);
    refresh();
  }, [refresh]);

  return { state, polling, refresh, linkOpened, markLinkOpened };
}
