import {
  assertProviderAllowed,
  createMockNotifier,
  isPushPayload,
  type AppEnvironment,
  type ChannelSendResult,
  type NotificationChannelPort,
  type ProviderDescriptor,
  type PushTitleKey,
} from '@udofin/adapters';

/**
 * The channels the worker sends service messages through (reminders and pre-debit notices). Only two exist, and neither carries
 * text: the borrower reads the message in the app, after signing in, from the database (servicing.my_reminders; the pre-debit
 * notice is a fixed factual line the app builds from the debit). So what leaves this module is an opaque id and a fixed title key.
 *
 *   in_app   the database is the inbox. "Sending" means recording that the message is there; nothing leaves the system.
 *   push     there is no push provider. The labelled mock exists in local development and tests only; everywhere else the
 *            unconfigured placeholder answers `not_configured`, which the database records as such (never as sent).
 *   sms      never sent (no provider, no DLT registration). The jobs record `not_configured` without calling anything.
 *
 * `accepted` means a channel took the message. It is not delivery; only a delivery report from a channel can say that.
 */

/** What a channel is asked to carry: ids only. No text, no amount, no name, no phone number. */
export interface ChannelMessage {
  /** The reminder id or the pre-debit notice id: the opaque id the app resolves after sign-in. */
  readonly id: string;
  /** The borrower reference the channel resolves to a device (an opaque id, never a phone number). */
  readonly recipientRef: string;
  /** The fixed title key shown by push. */
  readonly titleKey: PushTitleKey;
}

export interface ServiceChannel {
  readonly descriptor: ProviderDescriptor;
  send(message: ChannelMessage): Promise<ChannelSendResult>;
}

export interface ServiceChannels {
  readonly in_app: ServiceChannel;
  readonly push: ServiceChannel;
}

const OPAQUE_ID = /^[A-Za-z0-9_-]{16,64}$/;

/** The in-app inbox: accepts any message with a well-formed id. The text is in the database, frozen when the message was claimed. */
export function createInAppInboxChannel(): ServiceChannel {
  return {
    descriptor: { key: 'in_app_inbox', capability: 'notification', mode: 'production' },
    send: (message) =>
      Promise.resolve<ChannelSendResult>(
        OPAQUE_ID.test(message.id)
          ? { state: 'accepted' }
          : { state: 'failed', reason: 'invalid_request' },
      ),
  };
}

/** No push provider exists: always `not_configured`. Never reports a message as sent. */
export function createUnconfiguredPushChannel(): NotificationChannelPort<'push'> {
  return {
    descriptor: { key: 'push_channel_not_configured', capability: 'push', mode: 'production' },
    channel: 'push',
    send: () => Promise.resolve({ state: 'not_configured' as const }),
  };
}

/** Start-up guard for the push channel, the same shape as the SMS guard: no mock outside local development and tests. */
export function assertPushChannelAllowed(
  channel: NotificationChannelPort<'push'>,
  environment: AppEnvironment,
): void {
  assertProviderAllowed(channel.descriptor, environment);
  if (channel.descriptor.mode === 'mock' && environment !== 'local' && environment !== 'test') {
    throw new Error('a mock push channel is for local development and tests only');
  }
}

/** Wraps a push port: the payload is exactly an opaque id and a title key (checked again with isPushPayload). */
function pushChannel(port: NotificationChannelPort<'push'>): ServiceChannel {
  return {
    descriptor: port.descriptor,
    send(message) {
      const payload = { id: message.id, titleKey: message.titleKey };
      if (!isPushPayload(payload)) {
        return Promise.resolve<ChannelSendResult>({ state: 'failed', reason: 'invalid_request' });
      }
      return port.send({
        channel: 'push',
        // One message per id: a repeat of the same message (a retry after a lost lease) is the same message to the channel.
        idempotencyKey: message.id,
        recipientRef: message.recipientRef,
        payload,
      });
    },
  };
}

export interface ServiceChannelOptions {
  readonly environment: AppEnvironment;
  /** A push port to use instead of the default (tests; later a real adapter). Checked against the environment. */
  readonly push?: NotificationChannelPort<'push'>;
}

/**
 * The channels for an environment. Push is the labelled mock in local and test and the unconfigured placeholder everywhere else,
 * unless a port is passed in (and then the environment guard applies to it).
 */
export function createServiceChannels(options: ServiceChannelOptions): ServiceChannels {
  const { environment } = options;
  const push =
    options.push ??
    (environment === 'local' || environment === 'test'
      ? createMockNotifier(environment).channels.push
      : createUnconfiguredPushChannel());
  assertPushChannelAllowed(push, environment);
  return { in_app: createInAppInboxChannel(), push: pushChannel(push) };
}
