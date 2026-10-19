'use client';

import { useActionState } from 'react';
import { revealContact, type RevealState } from '../app/applications/actions';

export function ContactReveal({ id }: { id: string }) {
  const [state, formAction, pending] = useActionState<RevealState, FormData>(revealContact, null);
  return (
    <form action={formAction}>
      <input type="hidden" name="id" value={id} />
      {state?.phone ? (
        <p aria-live="polite">{state.phone}</p>
      ) : (
        <button type="submit" disabled={pending}>
          Show phone number
        </button>
      )}
      {state && !state.phone ? (
        <p role="alert" className="form-error">
          {state.error === 'consent_withdrawn' || state.error === 'conflict'
            ? 'The number is no longer available: consent was withdrawn.'
            : 'The number could not be shown.'}
        </p>
      ) : null}
    </form>
  );
}
