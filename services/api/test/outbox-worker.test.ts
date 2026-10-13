import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  OutboxWorker,
  PermanentError,
  type OutboxEvent,
  type OutboxStore,
  type WorkerLogger,
} from '../src/workers/outbox-worker.js';

function event(over: Partial<OutboxEvent> = {}): OutboxEvent {
  return {
    id: crypto.randomUUID(),
    event_type: 'test.event',
    payload: { ref: 'r1' },
    payload_version: 1,
    attempts: 1,
    max_attempts: 8,
    correlation_id: null,
    ...over,
  };
}

function fakeStore(events: OutboxEvent[], leaseLost = false) {
  const calls: { op: string; id?: string; code?: string; permanent?: boolean }[] = [];
  const store: OutboxStore = {
    claim: () => Promise.resolve(events.splice(0, events.length)),
    complete: (id) => {
      calls.push({ op: 'complete', id });
      return Promise.resolve(!leaseLost);
    },
    fail: (id, _w, code, permanent) => {
      calls.push({ op: 'fail', id, code, permanent });
      return Promise.resolve(leaseLost ? null : permanent ? 'dead' : 'pending');
    },
    purge: () => Promise.resolve({ idempotency: 0, completedEvents: 0 }),
  };
  return { store, calls };
}

const logs: string[] = [];
const log: WorkerLogger = {
  info: (f, m) => logs.push(JSON.stringify({ f, m })),
  warn: (f, m) => logs.push(JSON.stringify({ f, m })),
  error: (f, m) => logs.push(JSON.stringify({ f, m })),
};
const schema = z.strictObject({ ref: z.string() });

describe('OutboxWorker', () => {
  it('completes an event whose handler succeeds, validating the payload first', async () => {
    const e = event();
    const { store, calls } = fakeStore([e]);
    let seen: unknown;
    const summary = await new OutboxWorker({
      store,
      workerId: 'w',
      log,
      handlers: { 'test.event': { schema, run: (p) => ((seen = p), Promise.resolve()) } },
    }).runOnce();
    expect(summary).toMatchObject({ claimed: 1, completed: 1 });
    expect(seen).toEqual({ ref: 'r1' });
    expect(calls).toEqual([{ op: 'complete', id: e.id }]);
  });

  it('fails an invalid payload permanently without running the handler', async () => {
    const { store, calls } = fakeStore([event({ payload: { ref: 1, extra: true } })]);
    let ran = false;
    const summary = await new OutboxWorker({
      store,
      workerId: 'w',
      log,
      handlers: { 'test.event': { schema, run: () => ((ran = true), Promise.resolve()) } },
    }).runOnce();
    expect(ran).toBe(false);
    expect(summary.dead).toBe(1);
    expect(calls[0]).toMatchObject({ op: 'fail', code: 'invalid_payload', permanent: true });
  });

  it('retries an unknown event type (rolling deploys), without marking it permanent', async () => {
    const { store, calls } = fakeStore([event({ event_type: 'test.unknown' })]);
    await new OutboxWorker({ store, workerId: 'w', log, handlers: {} }).runOnce();
    expect(calls[0]).toMatchObject({ code: 'unknown_event_type', permanent: false });
  });

  it('retries a transient handler error and keeps the error text out of storage and logs', async () => {
    logs.length = 0;
    const { store, calls } = fakeStore([event()]);
    const summary = await new OutboxWorker({
      store,
      workerId: 'w',
      log,
      handlers: {
        'test.event': {
          schema,
          run: () => Promise.reject(new Error('connect to 9876543210 failed')),
        },
      },
    }).runOnce();
    expect(summary.retried).toBe(1);
    expect(calls[0]).toMatchObject({ code: 'handler_error', permanent: false });
    expect(logs.join('')).not.toContain('9876543210');
  });

  it('treats PermanentError as terminal and sanitises its code', async () => {
    const { store, calls } = fakeStore([event(), event()]);
    let n = 0;
    await new OutboxWorker({
      store,
      workerId: 'w',
      log,
      handlers: {
        'test.event': {
          schema,
          run: () =>
            Promise.reject(new PermanentError(n++ === 0 ? 'rule_refused' : 'Has Spaces 123')),
        },
      },
    }).runOnce();
    const codes = calls.map((c) => c.code).sort();
    expect(codes).toEqual(['permanent_error', 'rule_refused']);
    expect(calls.every((c) => c.permanent)).toBe(true);
  });

  it('reports a lost lease instead of counting the event as completed', async () => {
    const { store } = fakeStore([event()], true);
    const summary = await new OutboxWorker({
      store,
      workerId: 'w',
      log,
      handlers: { 'test.event': { schema, run: () => Promise.resolve() } },
    }).runOnce();
    expect(summary).toMatchObject({ completed: 0, lostLease: 1 });
  });

  it('start/stop finishes in-flight work and stops polling', async () => {
    const { store } = fakeStore([]);
    const worker = new OutboxWorker({
      store,
      workerId: 'w',
      log,
      handlers: {},
      pollIntervalMs: 10,
    });
    worker.start();
    await new Promise((r) => setTimeout(r, 30));
    await expect(worker.stop()).resolves.toBeUndefined();
  });
});
