import { defineStateMachine } from '../state-machine.js';
import type { LifecycleActor } from './application.js';

/**
 * Lifecycle of one repayment mandate (the lender is the creditor). The database enforces the same table
 * (payments.mandate_transitions, see supabase/migrations/20261018000915_p08a_mandates.sql);
 * test/mandate-lifecycle-sync.test.ts fails if the two ever diverge.
 *
 * Every move after the draft is made by the system, and only on a VERIFIED provider event or an AUTHENTICATED provider
 * status lookup. A redirect back to the app, a client flag or a screen proves nothing. A cancellation by the borrower
 * is a REQUEST (a timestamp on the mandate); the mandate is `cancelled` only when the provider confirms it.
 */
export const MANDATE_STATUSES = [
  'draft',
  'registration_pending',
  'active',
  'paused',
  'rejected',
  'failed',
  'expired',
  'cancelled',
  'revoked',
  'requires_reconciliation',
] as const;
export type MandateStatus = (typeof MANDATE_STATUSES)[number];

type MandateTransitionRule = readonly [MandateStatus, MandateStatus, readonly LifecycleActor[]];

export const MANDATE_TRANSITIONS: readonly MandateTransitionRule[] = [
  ['draft', 'registration_pending', ['system']],
  ['draft', 'failed', ['system']],
  ['draft', 'requires_reconciliation', ['system']],
  ['draft', 'cancelled', ['system']],
  ['registration_pending', 'active', ['system']],
  ['registration_pending', 'rejected', ['system']],
  ['registration_pending', 'failed', ['system']],
  ['registration_pending', 'expired', ['system']],
  ['registration_pending', 'requires_reconciliation', ['system']],
  ['registration_pending', 'cancelled', ['system']],
  ['requires_reconciliation', 'registration_pending', ['system']],
  ['requires_reconciliation', 'active', ['system']],
  ['requires_reconciliation', 'rejected', ['system']],
  ['requires_reconciliation', 'failed', ['system']],
  ['requires_reconciliation', 'expired', ['system']],
  ['requires_reconciliation', 'cancelled', ['system']],
  ['active', 'paused', ['system']],
  ['active', 'cancelled', ['system']],
  ['active', 'revoked', ['system']],
  ['active', 'expired', ['system']],
  ['paused', 'active', ['system']],
  ['paused', 'cancelled', ['system']],
  ['paused', 'revoked', ['system']],
  ['paused', 'expired', ['system']],
];

const transitionMap: Partial<Record<MandateStatus, MandateStatus[]>> = {};
for (const [from, to] of MANDATE_TRANSITIONS) {
  (transitionMap[from] ??= []).push(to);
}

export const mandateLifecycle = defineStateMachine<MandateStatus>({
  name: 'mandate',
  states: MANDATE_STATUSES,
  initial: 'draft',
  terminal: ['rejected', 'failed', 'expired', 'cancelled', 'revoked'],
  transitions: transitionMap,
});

/** Whether `actor` may move a mandate from `from` to `to`. Only the system ever may. */
export function canActorMoveMandate(
  actor: LifecycleActor,
  from: MandateStatus,
  to: MandateStatus,
): boolean {
  return MANDATE_TRANSITIONS.some(
    ([f, t, actors]) => f === from && t === to && actors.includes(actor),
  );
}

/** The statuses in which a mandate can still be used to take a debit (the others never can). */
export const MANDATE_LIVE_STATUSES: readonly MandateStatus[] = [
  'draft',
  'registration_pending',
  'active',
  'paused',
  'requires_reconciliation',
];

/**
 * Debit statuses and their forward-only rank (mirrors payments.mandate_debits and private.debit_rank). A lower rank after a
 * higher one never moves a debit back; two different terminal statuses contradict each other and open an exception.
 */
export const MANDATE_DEBIT_RANKS = {
  scheduled: 10,
  notified: 20,
  presented: 30,
  unknown: 35,
  settled: 40,
  returned: 40,
  cancelled: 40,
} as const;
export type MandateDebitStatus = keyof typeof MANDATE_DEBIT_RANKS;
