import { describe, expect, it } from 'vitest';
import {
  createMockIntegrityVerifier,
  createMockSmsSender,
  createUnavailableIntegrityVerifier,
  createUnconfiguredSmsSender,
  isE164,
  SMS_TEMPLATE_PURPOSE,
  withSmsTimeout,
  type SmsSendRequest,
  type SmsSender,
} from './index.js';
import { ProviderNotAllowedError } from './provider.js';

const request: SmsSendRequest = {
  template: 'stepup_otp',
  to: '+919999900001',
  language: 'en',
  variables: { otp: '123456' },
  idempotencyKey: 'k-0000000000000001',
};

describe('SMS port', () => {
  it('has no marketing template: every template is a service or security message', () => {
    expect(
      Object.values(SMS_TEMPLATE_PURPOSE).every((p) => p === 'security' || p === 'service'),
    ).toBe(true);
    expect(Object.keys(SMS_TEMPLATE_PURPOSE).some((k) => /market|promo|offer/i.test(k))).toBe(
      false,
    );
  });

  it('an unconfigured sender refuses honestly', async () => {
    expect(await createUnconfiguredSmsSender().send(request)).toEqual({ status: 'not_configured' });
  });

  it('the mock accepts valid numbers, refuses invalid ones, and exists only locally and in tests', async () => {
    const mock = createMockSmsSender('test');
    expect(await mock.send(request)).toEqual({ status: 'accepted', providerRef: 'mock-1' });
    expect(await mock.send({ ...request, to: '99999' })).toEqual({
      status: 'rejected',
      reason: 'invalid_number',
    });
    expect(mock.sent).toHaveLength(1);
    expect(() => createMockSmsSender('staging')).toThrow();
    expect(() => createMockSmsSender('production')).toThrow(ProviderNotAllowedError);
  });

  it('turns a slow or failing provider into a timeout or rejection, never a hang or a throw', async () => {
    const slow: SmsSender = {
      descriptor: { key: 'slow', capability: 'sms', mode: 'production' },
      send: () => new Promise(() => undefined),
    };
    expect(await withSmsTimeout(slow, 20).send(request)).toEqual({ status: 'timeout' });
    const broken: SmsSender = { ...slow, send: () => Promise.reject(new Error('boom')) };
    expect(await withSmsTimeout(broken, 20).send(request)).toEqual({
      status: 'rejected',
      reason: 'provider_error',
    });
  });

  it('accepts only E.164 numbers', () => {
    expect(isE164('+919876543210')).toBe(true);
    expect(isE164('9876543210')).toBe(false);
    expect(isE164('+0123456789')).toBe(false);
  });
});

describe('integrity port', () => {
  it('the mock verifies a token only when it carries the issued nonce and a known level', async () => {
    const v = createMockIntegrityVerifier('test');
    expect(await v.verify({ token: 'mock:device:n1', nonce: 'n1' })).toEqual({
      status: 'verified',
      level: 'device',
    });
    expect(await v.verify({ token: 'mock:device:other', nonce: 'n1' })).toEqual({
      status: 'invalid',
    });
    expect(await v.verify({ token: 'mock:perfect:n1', nonce: 'n1' })).toEqual({
      status: 'invalid',
    });
    expect(await v.verify({ token: 'device', nonce: 'n1' })).toEqual({ status: 'invalid' });
    expect(() => createMockIntegrityVerifier('production')).toThrow();
  });

  it('with no verifier configured the result is unavailable, not a pass', async () => {
    expect(await createUnavailableIntegrityVerifier().verify({ token: 'x', nonce: 'y' })).toEqual({
      status: 'unavailable',
    });
  });
});
