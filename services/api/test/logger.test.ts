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
});
