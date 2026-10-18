import { type ApiResult } from '@udofin/auth-client';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useAuth } from '../auth/AuthProvider';
import { createMandatesClient, type MandatesClient } from './mandates';
import { createPaymentsClient, type PaymentsClient } from './payments';
import { createPollGate, startPollRun, type PollContext, type PollGate } from './payments-polling';

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
 * checking runs only while the screen is FOCUSED and the app is in the FOREGROUND (see `createPollGate`): the bottom tabs keep a
 * visited screen mounted after the borrower leaves it, so mount and unmount are not enough. The run ends the moment the screen
 * loses focus, the app goes to the background or the screen unmounts (the loop is told it is cancelled and its pending wait is
 * cleared), and a new run, starting with a fresh read, begins when the screen is focused in the foreground again. It also ends at
 * the first failed read, at the attempt limit, or when `delayFor` says stop. If a later read fails the last good data stays on
 * screen with a flag, so a notice can say it may be out of date.
 *
 * The screen must be keyed by the id it shows, so a new id starts a new instance.
 */
export function usePolled<T>(
  load: () => Promise<ApiResult<T>>,
  delayFor: (data: T, context: PollContext) => number | null,
): Polled<T> {
  const [state, setState] = useState<PolledState<T>>({ kind: 'loading' });
  const [polling, setPolling] = useState(true);
  const [linkOpened, setLinkOpened] = useState(false);
  const latest = useRef({ load, delayFor, linkOpened });

  useEffect(() => {
    latest.current = { load, delayFor, linkOpened };
  });

  // The gate is made in an effect (it reads `latest`, which render must not touch). Effects run in the order written here, so it
  // exists before the focus and foreground effects below use it.
  const gateRef = useRef<PollGate | null>(null);
  useEffect(() => {
    const gate = createPollGate(() => {
      setPolling(true);
      return startPollRun<T>({
        load: () => latest.current.load(),
        delayFor: (data, attempt) =>
          latest.current.delayFor(data, { attempt, linkOpened: latest.current.linkOpened }),
        onResult: (result) =>
          setState((previous) => {
            if (result.ok) return { kind: 'ready', data: result.data, refreshFailed: false };
            return previous.kind === 'ready'
              ? { ...previous, refreshFailed: true }
              : { kind: 'error', code: result.code };
          }),
        onDone: () => setPolling(false),
      });
    });
    gateRef.current = gate;
    return () => {
      // Unmounting ends any run.
      gate.setFocused(false);
      gateRef.current = null;
    };
  }, []);

  // Focus: a run starts when the screen becomes the focused one (this includes the first time) and ends when it loses focus.
  useFocusEffect(
    useCallback(() => {
      gateRef.current?.setFocused(true);
      return () => gateRef.current?.setFocused(false);
    }, []),
  );

  // Foreground: the run ends when the app goes to the background and starts again, with a fresh read, when it comes back. The
  // transitional 'inactive' state (iOS only) changes nothing.
  useEffect(() => {
    gateRef.current?.setForeground(AppState.currentState !== 'background');
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') gateRef.current?.setForeground(true);
      else if (next === 'background') gateRef.current?.setForeground(false);
    });
    return () => subscription.remove();
  }, []);

  const refresh = useCallback(() => {
    setState((previous) => (previous.kind === 'error' ? { kind: 'loading' } : previous));
    setPolling(true);
    gateRef.current?.restart();
  }, []);

  const markLinkOpened = useCallback(() => {
    latest.current.linkOpened = true;
    setLinkOpened(true);
    refresh();
  }, [refresh]);

  return { state, polling, refresh, linkOpened, markLinkOpened };
}
