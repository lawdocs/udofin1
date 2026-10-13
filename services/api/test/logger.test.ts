import { Writable } from 'node:stream';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { loggerOptions } from '../src/logger.js';

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  const logger = pino(loggerOptions({ LOG_LEVEL: 'info', APP_ENV: 'test' }), stream);
  return { logger, lines };
}

describe('log redaction', () => {
  it('redacts identity, contact and credential fields at any logged depth', () => {
    const { logger, lines } = capture();
    logger.info(
      {
        pan: 'ABCDE1234F',
        borrower: { aadhaar: '999911112222', mobile: '9876543210', fullName: 'Asha Rao' },
        request: { body: { otp: '123456', accountNumber: '000123456789' } },
        req: { headers: { authorization: 'Bearer eyJhbGciOi', cookie: 'sb=abc' } },
        applicationId: '01928c6e-7c1a-7d3e-9a4b-1f2e3d4c5b6b',
      },
      'test',
    );
    const out = lines.join('');
    for (const secret of [
      'ABCDE1234F',
      '999911112222',
      '9876543210',
      'Asha Rao',
      '123456',
      '000123456789',
      'eyJhbGciOi',
      'sb=abc',
    ]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain('01928c6e-7c1a-7d3e-9a4b-1f2e3d4c5b6b');
    expect(out).toContain('[REDACTED]');
  });

  it('redacts at any depth and in snake_case, upper-case and spaced spellings', () => {
    const { logger, lines } = capture();
    logger.info(
      {
        a: { b: { c: { d: { e: { f: { pan: 'ZZZZZ9999Z' } } } } } },
        borrower_profile: {
          phone_number: '9123456789',
          ACCOUNT_NUMBER: '555500001111',
          'Full Name': 'Meera Iyer',
        },
        list: [{ Aadhaar_Number: '888877776666' }],
      },
      'deep',
    );
    const out = lines.join('');
    for (const secret of [
      'ZZZZZ9999Z',
      '9123456789',
      '555500001111',
      'Meera Iyer',
      '888877776666',
    ]) {
      expect(out).not.toContain(secret);
    }
  });

  it('logs errors by type and code, never by message or stack', () => {
    const { logger, lines } = capture();
    const dbError = Object.assign(new Error('Key (phone)=(9876500000) already exists'), {
      code: '23505',
      detail: 'Key (phone)=(9876500000) already exists',
    });
    logger.error({ err: dbError }, 'insert failed');
    const out = lines.join('');
    expect(out).not.toContain('9876500000');
    expect(out).toContain('23505');
  });

  it('logs requests by path only, without the query string', () => {
    const { logger, lines } = capture();
    logger.info(
      {
        req: {
          id: 'r1',
          method: 'GET',
          url: '/v1/things?token=abc123secret&pan=ABCDE1234F',
          ip: '10.0.0.1',
        },
      },
      'request',
    );
    const out = lines.join('');
    expect(out).toContain('/v1/things');
    expect(out).not.toContain('abc123secret');
    expect(out).not.toContain('ABCDE1234F');
  });
});
