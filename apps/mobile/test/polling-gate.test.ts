import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type ApiResult } from '@udofin/auth-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_POLL_ATTEMPTS,
  backoffDelay,
  createPollGate,
  startPollRun,
} from '../src/borrower/payments-polling';

/**
 * Automatic checking must follow the screen the borrower is looking at, not the component's mount. The bottom tabs keep a
 * visited screen mounted after the borrower leaves it, so these tests drive the same pieces the hook uses (`createPollGate` and
 * `startPollRun`) with fake timers, and a source check ties the hook to them. A run is ended by losing focus, by the app going
 * to the background and by unmounting; a hidden screen never reads, whatever the app does.
 */
type Payload = { n: number };
const ok = (n: number): ApiResult<Payload> => ({ ok: true, status: 200, data: { n } });

/** A counting loader that always answers "keep waiting" until the attempt limit. */
function harness(result: (read: number) => ApiResult<Payload> = ok) {
  const log = { reads: 0, results: [] as ApiResult<Payload>[], done: 0, starts: 0 };
  const start = () => {
    log.starts += 1;
    return startPollRun<Payload>({
      load: () => {
        log.reads += 1;
        return Promise.resolve(result(log.reads));
      },
      delayFor: (_data, attempt) => (attempt >= MAX_POLL_ATTEMPTS ? null : backoffDelay(attempt)),
      onResult: (r) => log.results.push(r),
      onDone: () => {
        log.done += 1;
      },
    });
  };
  return { log, start };
}

const EIGHT_MINUTES = 8 * 60 * 1000;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('startPollRun', () => {
  it('reads, waits with back-off, and reports done by itself at the attempt limit', async () => {
    const { log, start } = harness();
    start();
    await vi.advanceTimersByTimeAsync(0);
    expect(log.reads).toBe(1);
    await vi.advanceTimersByTimeAsync(backoffDelay(0));
    expect(log.reads).toBe(2);
    await vi.advanceTimersByTimeAsync(2 * EIGHT_MINUTES);
    expect(log.reads).toBe(MAX_POLL_ATTEMPTS + 1);
    expect(log.done).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops at the first failed read and reports done', async () => {
    const { log, start } = harness((read) =>
      read === 2 ? { ok: false, status: 0, code: 'network_error' } : ok(read),
    );
    start();
    await vi.advanceTimersByTimeAsync(EIGHT_MINUTES);
    expect(log.reads).toBe(2);
    expect(log.results.map((r) => r.ok)).toEqual([true, false]);
    expect(log.done).toBe(1);
  });

  it('stop ends the run for good: its wait is cleared and nothing more is read, reported or called back', async () => {
    const { log, start } = harness();
    const stop = start();
    await vi.advanceTimersByTimeAsync(0);
    expect(log.reads).toBe(1);
    expect(vi.getTimerCount()).toBe(1); // the pending wait
    stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(2 * EIGHT_MINUTES);
    expect(log.reads).toBe(1);
    expect(log.results).toHaveLength(1);
    expect(log.done).toBe(0);
  });

  it('stop while a read is in flight drops that read’s result', async () => {
    let release: (r: ApiResult<Payload>) => void = () => undefined;
    const results: ApiResult<Payload>[] = [];
    const stop = startPollRun<Payload>({
      load: () =>
        new Promise<ApiResult<Payload>>((resolve) => {
          release = resolve;
        }),
      delayFor: () => 1000,
      onResult: (r) => results.push(r),
      onDone: () => undefined,
    });
    stop();
    release(ok(1));
    await vi.advanceTimersByTimeAsync(5000);
    expect(results).toEqual([]);
  });
});

describe('createPollGate', () => {
  it('does not read before the screen is focused, then starts once', async () => {
    const { log, start } = harness();
    const gate = createPollGate(start);
    await vi.advanceTimersByTimeAsync(EIGHT_MINUTES);
    expect(log.reads).toBe(0);
    expect(gate.isRunning()).toBe(false);
    gate.setFocused(true);
    gate.setFocused(true); // focusing twice does not start a second run
    await vi.advanceTimersByTimeAsync(0);
    expect(log.starts).toBe(1);
    expect(log.reads).toBe(1);
    expect(gate.isRunning()).toBe(true);
  });

  it('ends the run when the screen loses focus and reads nothing more while hidden', async () => {
    const { log, start } = harness();
    const gate = createPollGate(start);
    gate.setFocused(true);
    await vi.advanceTimersByTimeAsync(backoffDelay(0) + backoffDelay(1));
    const readsWhileVisible = log.reads;
    expect(readsWhileVisible).toBeGreaterThanOrEqual(2);
    gate.setFocused(false);
    expect(gate.isRunning()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(4 * EIGHT_MINUTES);
    expect(log.reads).toBe(readsWhileVisible);
  });

  it('a hidden screen does not read when the app returns from the background (the old AppState refresh)', async () => {
    const { log, start } = harness();
    const gate = createPollGate(start);
    gate.setFocused(true);
    await vi.advanceTimersByTimeAsync(0);
    gate.setFocused(false); // the borrower tapped another tab
    const reads = log.reads;
    gate.setForeground(false);
    gate.setForeground(true);
    gate.setForeground(false);
    gate.setForeground(true);
    await vi.advanceTimersByTimeAsync(2 * EIGHT_MINUTES);
    expect(log.reads).toBe(reads);
    expect(log.starts).toBe(1);
  });

  it('ends the run in the background and starts a new one, with a fresh read, when the app returns', async () => {
    const { log, start } = harness();
    const gate = createPollGate(start);
    gate.setFocused(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(log.reads).toBe(1);
    gate.setForeground(false);
    expect(gate.isRunning()).toBe(false);
    await vi.advanceTimersByTimeAsync(EIGHT_MINUTES);
    expect(log.reads).toBe(1);
    gate.setForeground(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(log.starts).toBe(2);
    expect(log.reads).toBe(2);
    expect(gate.isRunning()).toBe(true);
  });

  it('starts again with a fresh read when the screen is focused again, and attempts count from zero', async () => {
    const { log, start } = harness();
    const gate = createPollGate(start);
    gate.setFocused(true);
    await vi.advanceTimersByTimeAsync(EIGHT_MINUTES / 2);
    gate.setFocused(false);
    const before = log.reads;
    gate.setFocused(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(log.reads).toBe(before + 1);
    // The new run has the full attempt budget again.
    await vi.advanceTimersByTimeAsync(2 * EIGHT_MINUTES);
    expect(log.reads).toBe(before + MAX_POLL_ATTEMPTS + 1);
  });

  it('needs both: focused in the background, or in the foreground but hidden, never runs', async () => {
    const { log, start } = harness();
    const gate = createPollGate(start);
    gate.setForeground(false);
    gate.setFocused(true);
    await vi.advanceTimersByTimeAsync(EIGHT_MINUTES);
    expect(log.reads).toBe(0);
    gate.setForeground(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(log.reads).toBe(1);
    gate.setFocused(false);
    gate.setForeground(false);
    gate.setForeground(true);
    await vi.advanceTimersByTimeAsync(EIGHT_MINUTES);
    expect(log.reads).toBe(1);
  });

  it('restart reads again now for a visible screen and does nothing for a hidden one', async () => {
    const { log, start } = harness();
    const gate = createPollGate(start);
    gate.restart();
    await vi.advanceTimersByTimeAsync(0);
    expect(log.reads).toBe(0);
    gate.setFocused(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(log.reads).toBe(1);
    gate.restart();
    await vi.advanceTimersByTimeAsync(0);
    expect(log.starts).toBe(2);
    expect(log.reads).toBe(2);
    // Only one run is live: the first one was stopped.
    expect(vi.getTimerCount()).toBe(1);
    gate.setFocused(false);
    gate.restart();
    await vi.advanceTimersByTimeAsync(EIGHT_MINUTES);
    expect(log.reads).toBe(2);
  });
});

describe('the polling hook is tied to the gate (source check)', () => {
  const root = join(import.meta.dirname, '..');
  const source = readFileSync(join(root, 'src', 'borrower', 'usePayments.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('follows focus with the navigation hook and ends the run on unmount', () => {
    expect(source).toContain("import { useFocusEffect } from 'expo-router';");
    expect(source).toContain('createPollGate(');
    expect(source).toContain('gateRef.current?.setFocused(true)');
    expect(source).toContain('gateRef.current?.setFocused(false)');
    // The unmount cleanup of the effect that makes the gate stops the run.
    expect(source).toMatch(
      /return \(\) => \{\s*gate\.setFocused\(false\);\s*gateRef\.current = null;/,
    );
  });

  it('follows the foreground: background ends the run, and only the gate decides whether a read starts', () => {
    expect(source).toContain(
      "else if (next === 'background') gateRef.current?.setForeground(false)",
    );
    expect(source).toContain("if (next === 'active') gateRef.current?.setForeground(true)");
    // The listener must not read by itself: that is what kept hidden screens reading.
    const listener = source.slice(source.indexOf('AppState.addEventListener'));
    expect(listener.slice(0, listener.indexOf('subscription.remove()'))).not.toMatch(/refresh\(/);
  });

  it('no longer starts a run from mount alone', () => {
    expect(source).not.toMatch(/useEffect\(\(\) => \{\s*let cancelled = false/);
    expect(source).not.toContain('pollLoop(');
    expect(source).not.toContain('setNonce');
  });
});
