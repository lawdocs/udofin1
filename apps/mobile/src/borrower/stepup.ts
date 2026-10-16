import { type STEPUP_ACTIONS } from '@udofin/contracts';

export type StepUpAction = (typeof STEPUP_ACTIONS)[number];

/** UI states of the one-time-code check. Pure, so every transition is testable. */
export type StepUpState =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | {
      kind: 'sent';
      challengeId: string;
      expiresAt: string;
      delivery: 'accepted' | 'rejected' | 'timeout' | 'not_configured';
    }
  | { kind: 'verifying'; challengeId: string; expiresAt: string }
  | { kind: 'failed'; challengeId: string; expiresAt: string; result: 'invalid' }
  | { kind: 'ended'; result: 'expired' | 'locked' | 'not_found' | 'already_verified' }
  | { kind: 'verified' }
  | { kind: 'error'; code: string };

export type StepUpEvent =
  | { type: 'start' }
  | {
      type: 'started';
      challengeId: string;
      expiresAt: string;
      delivery: 'accepted' | 'rejected' | 'timeout' | 'not_configured';
    }
  | { type: 'verify' }
  | {
      type: 'result';
      result: 'verified' | 'invalid' | 'expired' | 'locked' | 'not_found' | 'already_verified';
    }
  | { type: 'error'; code: string }
  | { type: 'reset' };

export function stepUpReducer(state: StepUpState, event: StepUpEvent): StepUpState {
  switch (event.type) {
    case 'start':
      return { kind: 'sending' };
    case 'started':
      // Only `accepted` means a code is on its way; the other results mean none was sent (see canEnterCode).
      return {
        kind: 'sent',
        challengeId: event.challengeId,
        expiresAt: event.expiresAt,
        delivery: event.delivery,
      };
    case 'verify':
      return state.kind === 'sent' || state.kind === 'failed'
        ? { kind: 'verifying', challengeId: state.challengeId, expiresAt: state.expiresAt }
        : state;
    case 'result':
      if (event.result === 'verified') return { kind: 'verified' };
      if (event.result === 'invalid') {
        return state.kind === 'verifying'
          ? {
              kind: 'failed',
              challengeId: state.challengeId,
              expiresAt: state.expiresAt,
              result: 'invalid',
            }
          : state;
      }
      return { kind: 'ended', result: event.result };
    case 'error':
      return { kind: 'error', code: event.code };
    case 'reset':
      return { kind: 'idle' };
  }
}

/** The code field is usable only when a code can actually have been sent. */
export const canEnterCode = (state: StepUpState): boolean =>
  (state.kind === 'sent' && state.delivery === 'accepted') || state.kind === 'failed';
