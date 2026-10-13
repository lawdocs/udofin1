import { assertProviderAllowed, type AppEnvironment, type ProviderDescriptor } from './provider.js';

/**
 * Port for sending approved SMS templates. The application depends on this interface only; a real
 * provider is an adapter written once a vendor is chosen (D-26) and its DLT registration exists.
 *
 * Results are deliberately NOT "sent" or "delivered": `accepted` means the provider took the
 * message. Delivery is a separate fact that only a provider callback can establish.
 */
export type SmsTemplateKey = 'login_otp' | 'stepup_otp' | 'request_submitted';

/** Every template is a service or security message. There is no marketing template. */
export const SMS_TEMPLATE_PURPOSE: Readonly<Record<SmsTemplateKey, 'security' | 'service'>> = {
  login_otp: 'security',
  stepup_otp: 'security',
  request_submitted: 'service',
};

export interface SmsSendRequest {
  template: SmsTemplateKey;
  /** E.164 number, e.g. +919876543210. Never logged. */
  to: string;
  language: 'en' | 'hi';
  /** Template variables. OTP values travel here and nowhere else. */
  variables: Readonly<Record<string, string>>;
  /** Lets a provider (or the caller) recognise a retry of the same message. */
  idempotencyKey: string;
}

export type SmsSendResult =
  | { status: 'accepted'; providerRef: string }
  | { status: 'rejected'; reason: 'invalid_number' | 'template_rejected' | 'provider_error' }
  | { status: 'timeout' }
  | { status: 'not_configured' };

export interface SmsSender {
  readonly descriptor: ProviderDescriptor;
  send(request: SmsSendRequest): Promise<SmsSendResult>;
}

const E164 = /^\+[1-9][0-9]{7,14}$/;
export const isE164 = (value: string): boolean => E164.test(value);

/** Used when no provider is configured: refuses honestly instead of pretending to send. */
export function createUnconfiguredSmsSender(): SmsSender {
  return {
    descriptor: { key: 'sms_not_configured', capability: 'sms', mode: 'production' },
    send: () => Promise.resolve({ status: 'not_configured' as const }),
  };
}

export interface RecordedSms extends SmsSendRequest {
  providerRef: string;
}

/**
 * Test/development double. It "accepts" everything valid and records the message so tests can read
 * the code. It is a mock: the provider guard refuses it in staging and production.
 */
export function createMockSmsSender(
  environment: AppEnvironment,
): SmsSender & { readonly sent: readonly RecordedSms[] } {
  const descriptor: ProviderDescriptor = { key: 'mock_sms', capability: 'sms', mode: 'mock' };
  assertProviderAllowed(descriptor, environment);
  if (environment === 'staging') {
    // The generic guard allows mocks in staging; a mock SMS sender must not exist anywhere deployed.
    throw new Error('the mock SMS sender is for local development and tests only');
  }
  const sent: RecordedSms[] = [];
  return {
    descriptor,
    sent,
    send(request) {
      if (!isE164(request.to))
        return Promise.resolve({ status: 'rejected' as const, reason: 'invalid_number' as const });
      const providerRef = `mock-${String(sent.length + 1)}`;
      sent.push({ ...request, providerRef });
      return Promise.resolve({ status: 'accepted' as const, providerRef });
    },
  };
}

/** Bounds every provider call; a slow provider becomes a `timeout` result instead of a hung request. */
export function withSmsTimeout(inner: SmsSender, milliseconds: number): SmsSender {
  return {
    descriptor: inner.descriptor,
    async send(request) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<SmsSendResult>((resolve) => {
        timer = setTimeout(() => resolve({ status: 'timeout' }), milliseconds);
      });
      try {
        return await Promise.race([
          inner
            .send(request)
            .catch((): SmsSendResult => ({ status: 'rejected', reason: 'provider_error' })),
          timeout,
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}
