import {
  assertLocalOrTestOnly,
  assertProviderAllowed,
  type AppEnvironment,
  type ProviderDescriptor,
} from './provider.js';

/**
 * Notification channels for service messages (reminders, payment and document notices). In-app and push are the only
 * channels that can work today; SMS is `not_configured` (no provider, no DLT registration: D-35/D-72) and is NEVER
 * reported as sent.
 *
 * Two facts are kept apart on purpose:
 *   - `ChannelSendResult` says whether a channel TOOK the message. `accepted` is not delivery.
 *   - `DeliveryReport` is the only thing that can say a message was delivered, and only when a delivery report
 *     actually arrived from the channel.
 *
 * Personal data: a push payload carries ONLY an opaque id and a fixed title key (the shape below has no body text and
 * `assertPushPayload` rejects any other key). No payload type carries a name, phone number, PAN, Aadhaar or account
 * number; recipients are opaque references the adapter resolves, never a phone number.
 */

export type NotificationChannel = 'in_app' | 'push' | 'sms';

/** The closed set of push titles. The apps localise the key; the payload never carries free text. */
export const PUSH_TITLE_KEYS = [
  'service_update',
  'payment_update',
  'reminder',
  'document_ready',
] as const;
export type PushTitleKey = (typeof PUSH_TITLE_KEYS)[number];

/** Opaque id the app resolves after authentication; it identifies a stored in-app notification. */
export type OpaqueNotificationId = string;

/**
 * What goes to the push provider. Exactly two fields. There is no `body`, `text`, `data` or `message`: the content is
 * fetched by the app, after sign-in, using the id.
 */
export interface PushPayload {
  readonly id: OpaqueNotificationId;
  readonly titleKey: PushTitleKey;
}

const OPAQUE_ID = /^[A-Za-z0-9_-]{16,64}$/;
/** A recipient is an opaque reference. Digits only (a phone number, an account number) or any '+' / '@' is not one. */
const RECIPIENT_REF = /^[A-Za-z0-9_-]{6,128}$/;

/** Runtime guard for the push payload shape (also protects against a cast around the type). */
export function isPushPayload(value: unknown): value is PushPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== 'id' || keys[1] !== 'titleKey') return false;
  const { id, titleKey } = value as Record<string, unknown>;
  return (
    typeof id === 'string' &&
    OPAQUE_ID.test(id) &&
    typeof titleKey === 'string' &&
    PUSH_TITLE_KEYS.some((key) => key === titleKey)
  );
}

/** The closed set of variables a service message may use (spec 08 section 11). Nothing else is accepted. */
export const NOTIFICATION_VARIABLE_KEYS = [
  'lenderDisplayName',
  'dueDate',
  'amount',
  'linkReference',
  'penalChargeText',
  'helpContact',
] as const;
export type NotificationVariableKey = (typeof NOTIFICATION_VARIABLE_KEYS)[number];
export type NotificationVariables = Readonly<Partial<Record<NotificationVariableKey, string>>>;

export interface InAppPayload {
  readonly id: OpaqueNotificationId;
  /** Key of an approved template; the stored content is rendered from the template and the closed variables. */
  readonly templateKey: string;
  readonly language: 'en' | 'hi';
  readonly variables: NotificationVariables;
}

export interface SmsPayload {
  readonly templateKey: string;
  /** DLT-registered template id; null while none exists, which means the channel cannot send. */
  readonly dltTemplateId: string | null;
  readonly language: 'en' | 'hi';
  readonly variables: NotificationVariables;
}

interface BaseRequest {
  /** One message per key and channel: the channel (and the mock) treat a repeat as the same message. */
  readonly idempotencyKey: string;
  /** Opaque recipient reference (a device registration or borrower reference). Never a phone number or name. */
  readonly recipientRef: string;
}

export type NotificationRequest =
  | (BaseRequest & { readonly channel: 'in_app'; readonly payload: InAppPayload })
  | (BaseRequest & { readonly channel: 'push'; readonly payload: PushPayload })
  | (BaseRequest & { readonly channel: 'sms'; readonly payload: SmsPayload });

export type NotificationRequestFor<C extends NotificationChannel> = Extract<
  NotificationRequest,
  { channel: C }
>;

/** `accepted` means the channel took the message. It is NOT delivery. */
export type ChannelSendResult =
  | { readonly state: 'accepted'; readonly providerRef?: string }
  | { readonly state: 'not_configured' }
  /** A DEFINITE refusal: the channel did not take the message. Safe to treat as not sent. */
  | { readonly state: 'failed'; readonly reason: 'invalid_request' }
  /**
   * The channel may or may not have taken the message (a timeout, a 5xx or an unparseable answer). Not a refusal:
   * look the message up by its idempotency key before any retry that could send it twice.
   */
  | { readonly state: 'unknown'; readonly reason: 'timeout' | 'network' | 'provider_error' };

export interface NotificationChannelPort<C extends NotificationChannel = NotificationChannel> {
  readonly descriptor: ProviderDescriptor;
  readonly channel: C;
  send(request: NotificationRequestFor<C>): Promise<ChannelSendResult>;
}

/**
 * Evidence from the channel that a message reached (or did not reach) the device or handset. Only this type may
 * be used to record "delivered".
 */
export interface DeliveryReport {
  readonly channel: NotificationChannel;
  readonly providerRef: string;
  readonly state: 'delivered' | 'failed' | 'expired';
  /** Provider's failure class, verbatim and free of personal data. */
  readonly reasonClass: string | null;
  /** UTC ISO-8601, from the report itself. */
  readonly reportedAt: string;
}

export const isDelivered = (report: DeliveryReport): boolean => report.state === 'delivered';

// ---------------------------------------------------------------------------------------------------------
// SMS: not configured, and never a mock outside a developer machine
// ---------------------------------------------------------------------------------------------------------

/** No SMS provider or DLT registration exists: always `not_configured`. Never reports a message as sent. */
export function createUnconfiguredSmsChannel(): NotificationChannelPort<'sms'> {
  return {
    descriptor: { key: 'sms_channel_not_configured', capability: 'sms', mode: 'production' },
    channel: 'sms',
    send: () => Promise.resolve({ state: 'not_configured' as const }),
  };
}

/**
 * Start-up guard for the SMS channel. In staging and production any mock-mode SMS channel is refused (the generic
 * provider guard allows mocks in staging; a mock SMS must not exist anywhere deployed), and sandbox is refused in
 * production like every provider.
 */
export function assertSmsChannelAllowed(
  channel: NotificationChannelPort<'sms'>,
  environment: AppEnvironment,
): void {
  assertProviderAllowed(channel.descriptor, environment);
  if (channel.descriptor.mode === 'mock' && environment !== 'local' && environment !== 'test') {
    throw new Error('a mock SMS channel is for local development and tests only');
  }
}

// ---------------------------------------------------------------------------------------------------------
// In-app / push recording mock
// ---------------------------------------------------------------------------------------------------------

export type RecordedNotification =
  | (BaseRequest & { readonly channel: 'in_app'; readonly payload: InAppPayload })
  | (BaseRequest & { readonly channel: 'push'; readonly payload: PushPayload });

export interface MockNotifier {
  readonly descriptor: ProviderDescriptor;
  readonly channels: {
    readonly in_app: NotificationChannelPort<'in_app'>;
    readonly push: NotificationChannelPort<'push'>;
  };
  /** Everything accepted, in order. A repeated channel and idempotency key is recorded once. */
  readonly sent: readonly RecordedNotification[];
}

function validVariables(variables: NotificationVariables): boolean {
  return Object.entries(variables).every(
    ([key, value]) =>
      NOTIFICATION_VARIABLE_KEYS.some((allowed) => allowed === key) && typeof value === 'string',
  );
}

/**
 * TEST DOUBLE, `mock_notifier`. Records in-app and push requests and "accepts" them; it delivers nothing and reports
 * no delivery. There is no SMS here. Allowed in local development and tests only (staging is refused as well).
 */
export function createMockNotifier(environment: AppEnvironment): MockNotifier {
  const descriptor: ProviderDescriptor = {
    key: 'mock_notifier',
    capability: 'notification',
    mode: 'mock',
  };
  assertLocalOrTestOnly(descriptor, environment, 'mock notifier');
  const sent: RecordedNotification[] = [];
  // Keyed by channel AND idempotency key: one notification id used for both channels sends both.
  const seen = new Map<string, { providerRef: string; content: string }>();
  const accept = (request: RecordedNotification): ChannelSendResult => {
    if (!RECIPIENT_REF.test(request.recipientRef) || /^[0-9]+$/.test(request.recipientRef)) {
      return { state: 'failed', reason: 'invalid_request' };
    }
    const mapKey = `${request.channel}\u0000${request.idempotencyKey}`;
    const content = JSON.stringify([request.recipientRef, request.payload]);
    const known = seen.get(mapKey);
    if (known !== undefined) {
      // The same key with different content is a caller bug (a reused key), not a repeat of the same message.
      return known.content === content
        ? { state: 'accepted', providerRef: known.providerRef }
        : { state: 'failed', reason: 'invalid_request' };
    }
    const providerRef = `mock-notice-${String(sent.length + 1)}`;
    seen.set(mapKey, { providerRef, content });
    sent.push(structuredClone(request));
    return { state: 'accepted', providerRef };
  };
  return {
    descriptor,
    sent,
    channels: {
      in_app: {
        descriptor,
        channel: 'in_app',
        send: (request) =>
          Promise.resolve(
            OPAQUE_ID.test(request.payload.id) &&
              (request.payload.language === 'en' || request.payload.language === 'hi') &&
              validVariables(request.payload.variables)
              ? accept(request)
              : { state: 'failed', reason: 'invalid_request' },
          ),
      },
      push: {
        descriptor,
        channel: 'push',
        send: (request) =>
          Promise.resolve(
            isPushPayload(request.payload)
              ? accept(request)
              : { state: 'failed', reason: 'invalid_request' },
          ),
      },
    },
  };
}
