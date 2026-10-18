import { type ApiResult } from '@udofin/auth-client';
import { type BpMandate, type BpPaymentDetail } from '@udofin/contracts';

/** Waits between reads: short at first, then slower. The last value repeats until the attempts run out. */
export const POLL_DELAYS_MS = [2_000, 3_000, 5_000, 8_000, 13_000, 20_000, 30_000] as const;
/** Reads in one automatic run (about eight minutes in all). After that the screen offers "Check again" instead. */
export const MAX_POLL_ATTEMPTS = 20;

export function backoffDelay(attempt: number): number {
  const index = Math.min(Math.max(Math.trunc(attempt), 0), POLL_DELAYS_MS.length - 1);
  return POLL_DELAYS_MS[index] ?? 30_000;
}

export interface PollContext {
  /** Zero for the first read of a run. */
  attempt: number;
  /** The borrower opened the provider's page in this visit and is waiting for the result. */
  linkOpened: boolean;
}

/**
 * When to read a payment again, or null to stop. Nothing here decides what the payment IS; it only decides whether waiting could
 * help. A payment is waited for only while it is still `created` or `pending` and the stage is still `started`: once the
 * provider has reported it, or the request ended, further reads change nothing until the lender posts, which can take long
 * (the screen offers "Check again" for that). While an unexpired link is waiting for the borrower to tap, there is nothing to
 * wait for either.
 */
export function paymentPollDelay(
  payment: Pick<BpPaymentDetail, 'status' | 'stage' | 'linkAvailable'>,
  context: PollContext,
): number | null {
  if (context.attempt >= MAX_POLL_ATTEMPTS) return null;
  if (payment.status !== 'created' && payment.status !== 'pending') return null;
  if (payment.stage !== 'started') return null;
  if (payment.status === 'pending' && payment.linkAvailable && !context.linkOpened) return null;
  return backoffDelay(context.attempt);
}

/**
 * When to read a mandate again, or null to stop. A `draft` mandate is waiting for the worker to ask the provider for the hand-off
 * (the link is fetched only once the status is `registration_pending`). After the borrower opened the provider's page, or asked
 * for cancellation, the status is waited for a while because only the provider can change it.
 */
export function mandatePollDelay(
  mandate: Pick<BpMandate, 'status' | 'cancelRequested'>,
  context: PollContext,
): number | null {
  if (context.attempt >= MAX_POLL_ATTEMPTS) return null;
  if (mandate.status === 'draft') return backoffDelay(context.attempt);
  if (mandate.status === 'registration_pending' && context.linkOpened) {
    return backoffDelay(context.attempt);
  }
  if (mandate.cancelRequested && mandate.status !== 'cancelled') {
    return backoffDelay(context.attempt);
  }
  return null;
}

export interface PollLoopDeps<T> {
  load: () => Promise<ApiResult<T>>;
  /** Milliseconds to wait before the next read, or null to stop. */
  delayFor: (data: T, attempt: number) => number | null;
  sleep: (ms: number) => Promise<void>;
  /** True once the screen was left: nothing more is read and nothing more is reported. */
  isCancelled: () => boolean;
  onResult: (result: ApiResult<T>) => void;
}

/**
 * Reads, reports, waits, repeats. It stops at the first failed read (the screen then shows what it had, a plain notice and a
 * "Check again" button), when `delayFor` says stop, and, always, as soon as the screen is left.
 */
export async function pollLoop<T>(deps: PollLoopDeps<T>): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    if (deps.isCancelled()) return;
    const result = await deps.load();
    if (deps.isCancelled()) return;
    deps.onResult(result);
    if (!result.ok) return;
    const delay = deps.delayFor(result.data, attempt);
    if (delay === null) return;
    await deps.sleep(delay);
  }
}

export interface PollRunDeps<T> {
  load: () => Promise<ApiResult<T>>;
  delayFor: (data: T, attempt: number) => number | null;
  onResult: (result: ApiResult<T>) => void;
  /** The run ended by itself (first failed read, attempt limit, or `delayFor` said stop). Never called after `stop`. */
  onDone: () => void;
}

/**
 * One run of automatic checking. Returns `stop`: it ends the run for good, clears the pending wait and wakes the loop so that it
 * returns without reading or reporting again. After `stop`, nothing more is read, reported or called back.
 */
export function startPollRun<T>(deps: PollRunDeps<T>): () => void {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wake: (() => void) | undefined;
  void pollLoop<T>({
    load: deps.load,
    delayFor: deps.delayFor,
    sleep: (ms) =>
      new Promise<void>((resolve) => {
        wake = resolve;
        timer = setTimeout(resolve, ms);
      }),
    isCancelled: () => cancelled,
    onResult: deps.onResult,
  }).then(() => {
    if (!cancelled) deps.onDone();
  });
  return () => {
    cancelled = true;
    if (timer !== undefined) clearTimeout(timer);
    wake?.();
  };
}

export interface PollGate {
  /** The screen is the one the borrower is looking at (navigation focus). */
  setFocused: (focused: boolean) => void;
  /** The app is in the foreground. */
  setForeground: (foreground: boolean) => void;
  /** Ends the current run, if any, and starts a new one when the screen is focused and the app is in the foreground. */
  restart: () => void;
  /** True while a run is active. */
  isRunning: () => boolean;
}

/**
 * Runs automatic checking only while the screen is focused AND the app is in the foreground. Tabs keep a visited screen mounted
 * after the borrower leaves it, so tying the run to mount would keep reading in the background; here the run ends the moment the
 * screen loses focus or the app goes to the background, and a new run (a fresh read, attempts counted from zero) starts when both
 * hold again. `start` begins a run and returns its `stop`.
 */
export function createPollGate(start: () => () => void): PollGate {
  let focused = false;
  let foreground = true;
  let stop: (() => void) | null = null;
  const sync = () => {
    const wanted = focused && foreground;
    if (wanted && stop === null) stop = start();
    else if (!wanted && stop !== null) {
      stop();
      stop = null;
    }
  };
  return {
    setFocused: (value) => {
      focused = value;
      sync();
    },
    setForeground: (value) => {
      foreground = value;
      sync();
    },
    restart: () => {
      if (stop !== null) {
        stop();
        stop = null;
      }
      sync();
    },
    isRunning: () => stop !== null,
  };
}
