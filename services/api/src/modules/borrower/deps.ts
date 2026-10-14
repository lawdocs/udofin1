import { type IntegrityVerifier, type SmsSender } from '@udofin/adapters';
import { type WebhookDedup } from '../../db/user-context.js';

/** Everything the borrower routes need from outside the database. Missing pieces make the matching routes refuse honestly. */
export interface BorrowerDeps {
  sms: SmsSender;
  integrity: IntegrityVerifier;
  /** Keys the hash of step-up codes; without it step-up cannot start. */
  stepUpPepper?: string;
  /** Verifies the signature of the Supabase "Send SMS" auth hook; without it the hook endpoint refuses. */
  sendSmsHookSecret?: string;
  /**
   * Durable, cross-instance replay guard for the Send-SMS hook. Deployed environments always wire it
   * (server.ts). Without it only the per-process cache applies, which is enough for a single local process.
   */
  webhookDedup?: WebhookDedup;
  /** Milliseconds allowed for the SMS provider (the auth hook has a 5 s budget in total). */
  smsTimeoutMs: number;
}
