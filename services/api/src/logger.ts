import { type LoggerOptions } from 'pino';
import { type AppConfig } from './config.js';

/** Credential headers, redacted on requests and responses. */
const REDACTED_HEADERS = ['authorization', 'cookie', 'set-cookie', 'x-api-key'] as const;

/**
 * Field names that must never reach logs, at any depth we log. Identity numbers, OTPs, contact
 * details, bank details and credentials are redacted even if a developer logs a whole object.
 * Prefer not logging payloads at all; this list is the safety net, not the policy.
 */
export const REDACTED_KEYS = [
  'password',
  'secret',
  'token',
  'accessToken',
  'refreshToken',
  'otp',
  'pin',
  'aadhaar',
  'aadhaarNumber',
  'vid',
  'pan',
  'panNumber',
  'ckycNumber',
  'phone',
  'mobile',
  'mobileNumber',
  'email',
  'dob',
  'dateOfBirth',
  'accountNumber',
  'bankAccountNumber',
  'upiId',
  'vpa',
  'address',
  'fullName',
] as const;

export function redactPaths(): string[] {
  const paths: string[] = [];
  for (const header of REDACTED_HEADERS) {
    paths.push(`req.headers["${header}"]`, `res.headers["${header}"]`);
  }
  for (const key of REDACTED_KEYS) {
    paths.push(key, `*.${key}`, `*.*.${key}`);
  }
  return paths;
}

export function loggerOptions(config: Pick<AppConfig, 'LOG_LEVEL' | 'APP_ENV'>): LoggerOptions {
  return {
    level: config.LOG_LEVEL,
    base: { service: 'udofin-api', env: config.APP_ENV },
    timestamp: () => `,"time":"${new Date().toISOString()}"`,
    redact: { paths: redactPaths(), censor: '[REDACTED]' },
    formatters: {
      level: (label) => ({ level: label }),
    },
  };
}
