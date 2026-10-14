import { describe, expect, it } from 'vitest';
import {
  assertSmsChannelAllowed,
  createMockNotifier,
  createUnconfiguredSmsChannel,
  isDelivered,
  isPushPayload,
  PUSH_TITLE_KEYS,
  type DeliveryReport,
  type InAppPayload,
  type NotificationChannelPort,
  type PushPayload,
} from './index.js';
import { ProviderNotAllowedError } from './provider.js';

const ID = 'ntf_0123456789abcdef';
const push: PushPayload = { id: ID, titleKey: 'reminder' };
const inApp: InAppPayload = {
  id: ID,
  templateKey: 'reminder_due_soon',
  language: 'en',
  variables: { lenderDisplayName: 'SAMPLE Lender', dueDate: '2026-11-05', amount: '4500.00' },
};

describe('push payload', () => {
  it('has exactly an opaque id and a fixed title key, at the type level and at run time', () => {
    // @ts-expect-error a body would be free text that could carry personal data
    const withBody: PushPayload = { id: ID, titleKey: 'reminder', body: 'Pay 4500 to Asha' };
    // @ts-expect-error titles are a closed set of keys, not free text
    const freeTitle: PushPayload = { id: ID, titleKey: 'Your EMI is due' };
    // @ts-expect-error the id is required
    const noId: PushPayload = { titleKey: 'reminder' };
    expect(isPushPayload(push)).toBe(true);
    expect(isPushPayload(withBody)).toBe(false);
    expect(isPushPayload(freeTitle)).toBe(false);
    expect(isPushPayload(noId)).toBe(false);
    expect(isPushPayload({ ...push, data: { amount: '1' } })).toBe(false);
    expect(isPushPayload({ id: '+919999900001', titleKey: 'reminder' })).toBe(false);
    expect(isPushPayload({ id: 'short', titleKey: 'reminder' })).toBe(false);
    expect(isPushPayload(null)).toBe(false);
    expect(isPushPayload([ID, 'reminder'])).toBe(false);
    expect(PUSH_TITLE_KEYS.length).toBeGreaterThan(0);
  });
});

describe('mock notifier (mock_notifier)', () => {
  it('is labelled and exists only in local development and tests', () => {
    expect(createMockNotifier('test').descriptor).toEqual({
      key: 'mock_notifier',
      capability: 'notification',
      mode: 'mock',
    });
    expect(() => createMockNotifier('production')).toThrow(ProviderNotAllowedError);
    expect(() => createMockNotifier('staging')).toThrow(/local development and tests only/);
    expect(() => createMockNotifier('local')).not.toThrow();
  });

  it('accepts and records in-app and push, and accepting is not delivering', async () => {
    const n = createMockNotifier('test');
    const a = await n.channels.push.send({
      channel: 'push',
      idempotencyKey: 'k1',
      recipientRef: 'device-ref-1',
      payload: push,
    });
    const b = await n.channels.in_app.send({
      channel: 'in_app',
      idempotencyKey: 'k2',
      recipientRef: 'borrower-ref-1',
      payload: inApp,
    });
    expect(a).toEqual({ state: 'accepted', providerRef: 'mock-notice-1' });
    expect(b).toEqual({ state: 'accepted', providerRef: 'mock-notice-2' });
    expect(n.sent.map((s) => s.channel)).toEqual(['push', 'in_app']);
    expect(Object.keys(n.channels).sort()).toEqual(['in_app', 'push']);
    // There is no delivery information in a send result.
    expect(JSON.stringify([a, b])).not.toMatch(/deliver/i);
  });

  it('treats a repeated idempotency key as the same message', async () => {
    const n = createMockNotifier('test');
    const send = () =>
      n.channels.push.send({
        channel: 'push',
        idempotencyKey: 'same',
        recipientRef: 'device-ref-1',
        payload: push,
      });
    expect(await send()).toEqual(await send());
    expect(n.sent).toHaveLength(1);
  });

  it('refuses a push payload with extra content and an in-app message with variables outside the closed set', async () => {
    const n = createMockNotifier('test');
    const bad = { ...push, body: 'secret' } as unknown as PushPayload;
    expect(
      await n.channels.push.send({
        channel: 'push',
        idempotencyKey: 'k',
        recipientRef: 'r',
        payload: bad,
      }),
    ).toEqual({ state: 'failed', reason: 'invalid_request' });
    const sneaky = { ...inApp, variables: { phone: '+919999900001' } } as unknown as InAppPayload;
    expect(
      await n.channels.in_app.send({
        channel: 'in_app',
        idempotencyKey: 'k',
        recipientRef: 'r',
        payload: sneaky,
      }),
    ).toEqual({ state: 'failed', reason: 'invalid_request' });
    expect(n.sent).toHaveLength(0);
  });

  it('keeps recorded requests independent of later changes by the caller', async () => {
    const n = createMockNotifier('test');
    const payload = { ...inApp, variables: { ...inApp.variables } };
    await n.channels.in_app.send({
      channel: 'in_app',
      idempotencyKey: 'k',
      recipientRef: 'r',
      payload,
    });
    (payload.variables as Record<string, string>).amount = '1.00';
    expect((n.sent[0]?.payload as InAppPayload).variables.amount).toBe('4500.00');
  });
});

describe('SMS channel', () => {
  const smsPayload = {
    templateKey: 'reminder_due_soon',
    dltTemplateId: null,
    language: 'en',
    variables: {},
  } as const;

  it('is not_configured and never reports a message as sent', async () => {
    const sms = createUnconfiguredSmsChannel();
    expect(sms.channel).toBe('sms');
    expect(
      await sms.send({
        channel: 'sms',
        idempotencyKey: 'k',
        recipientRef: 'r',
        payload: smsPayload,
      }),
    ).toEqual({ state: 'not_configured' });
    expect(
      await sms.send({
        channel: 'sms',
        idempotencyKey: 'k2',
        recipientRef: 'r',
        payload: { ...smsPayload, dltTemplateId: 'SAMPLE-DLT-1' },
      }),
    ).toEqual({ state: 'not_configured' });
  });

  it('the guard refuses any mock-mode SMS channel in staging and production, and a sandbox one in production', () => {
    const mock: NotificationChannelPort<'sms'> = {
      descriptor: { key: 'mock_sms_channel', capability: 'sms', mode: 'mock' },
      channel: 'sms',
      send: () => Promise.resolve({ state: 'accepted' }),
    };
    expect(() => assertSmsChannelAllowed(mock, 'staging')).toThrow(
      /local development and tests only/,
    );
    expect(() => assertSmsChannelAllowed(mock, 'production')).toThrow(ProviderNotAllowedError);
    expect(() => assertSmsChannelAllowed(mock, 'local')).not.toThrow();
    expect(() => assertSmsChannelAllowed(mock, 'test')).not.toThrow();
    const sandbox = { ...mock, descriptor: { ...mock.descriptor, mode: 'sandbox' as const } };
    expect(() => assertSmsChannelAllowed(sandbox, 'production')).toThrow(ProviderNotAllowedError);
  });
});

describe('delivery reports', () => {
  it('only a delivery report that says delivered counts as delivered', () => {
    const base: DeliveryReport = {
      channel: 'push',
      providerRef: 'mock-notice-1',
      state: 'delivered',
      reasonClass: null,
      reportedAt: '2026-10-14T00:00:00.000Z',
    };
    expect(isDelivered(base)).toBe(true);
    expect(isDelivered({ ...base, state: 'failed', reasonClass: 'device_unreachable' })).toBe(
      false,
    );
    expect(isDelivered({ ...base, state: 'expired' })).toBe(false);
  });
});
