import { defineStateMachine } from '../state-machine.js';

/**
 * Lifecycle of one lender application. The database enforces the same table
 * (lending.application_transitions, see supabase/migrations/20261010000400_lending_core.sql);
 * test/lifecycle-sync.test.ts fails if the two ever diverge.
 */
export const APPLICATION_STATUSES = [
  'draft',
  'submitted',
  'under_review',
  'info_requested',
  'approved',
  'rejected',
  'offer_accepted',
  'agreement_pending',
  'agreement_executed',
  'disbursement_pending',
  'disbursed',
  'withdrawn',
  'expired',
  'cancelled',
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

/** borrower = the applicant; lender = lender staff or the lender's system; system = trusted Udofin process. */
export type LifecycleActor = 'borrower' | 'lender' | 'system';

type TransitionRule = readonly [ApplicationStatus, ApplicationStatus, readonly LifecycleActor[]];

export const APPLICATION_TRANSITIONS: readonly TransitionRule[] = [
  ['draft', 'submitted', ['borrower']],
  ['draft', 'withdrawn', ['borrower']],
  ['draft', 'expired', ['system']],
  ['submitted', 'under_review', ['lender', 'system']],
  ['submitted', 'rejected', ['lender', 'system']],
  ['submitted', 'withdrawn', ['borrower']],
  ['submitted', 'expired', ['system']],
  ['under_review', 'info_requested', ['lender', 'system']],
  ['under_review', 'approved', ['lender', 'system']],
  ['under_review', 'rejected', ['lender', 'system']],
  ['under_review', 'withdrawn', ['borrower']],
  ['info_requested', 'under_review', ['borrower', 'lender', 'system']],
  ['info_requested', 'withdrawn', ['borrower']],
  ['info_requested', 'expired', ['system']],
  ['approved', 'offer_accepted', ['borrower']],
  ['approved', 'withdrawn', ['borrower']],
  ['approved', 'expired', ['system']],
  ['approved', 'cancelled', ['lender', 'system']],
  ['offer_accepted', 'agreement_pending', ['system']],
  ['offer_accepted', 'withdrawn', ['borrower']],
  ['offer_accepted', 'cancelled', ['lender', 'system']],
  ['agreement_pending', 'agreement_executed', ['system']],
  ['agreement_pending', 'withdrawn', ['borrower']],
  ['agreement_pending', 'expired', ['system']],
  ['agreement_pending', 'cancelled', ['lender', 'system']],
  ['agreement_executed', 'disbursement_pending', ['lender', 'system']],
  ['agreement_executed', 'withdrawn', ['borrower']],
  ['agreement_executed', 'cancelled', ['lender', 'system']],
  ['disbursement_pending', 'disbursed', ['system']],
  ['disbursement_pending', 'cancelled', ['lender', 'system']],
];

const transitionMap: Partial<Record<ApplicationStatus, ApplicationStatus[]>> = {};
for (const [from, to] of APPLICATION_TRANSITIONS) {
  (transitionMap[from] ??= []).push(to);
}

export const applicationLifecycle = defineStateMachine<ApplicationStatus>({
  name: 'application',
  states: APPLICATION_STATUSES,
  initial: 'draft',
  terminal: ['rejected', 'disbursed', 'withdrawn', 'expired', 'cancelled'],
  transitions: transitionMap,
});

/** Whether `actor` may move an application from `from` to `to`. */
export function canActorTransition(
  actor: LifecycleActor,
  from: ApplicationStatus,
  to: ApplicationStatus,
): boolean {
  return APPLICATION_TRANSITIONS.some(
    ([f, t, actors]) => f === from && t === to && actors.includes(actor),
  );
}
