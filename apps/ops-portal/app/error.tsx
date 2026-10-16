'use client';

import { ErrorState } from '@udofin/portal-kit';

export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  // The error object is deliberately not rendered or logged here: it may contain request data.
  return (
    <main className="shell">
      <ErrorState
        title="Something went wrong"
        detail="The page could not be shown. Try again."
        action={
          <button type="button" onClick={reset}>
            Try again
          </button>
        }
      />
    </main>
  );
}
