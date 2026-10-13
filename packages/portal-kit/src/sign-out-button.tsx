'use client';

import { useState } from 'react';

export interface SignOutButtonProps {
  onDone: () => void;
  basePath?: string;
  fetchImpl?: typeof fetch;
}

/** Ends the session on the server (cookies are cleared even if the auth server is unreachable). */
export function SignOutButton({ onDone, basePath = '/auth', fetchImpl }: SignOutButtonProps) {
  const [busy, setBusy] = useState(false);
  const doFetch = fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void doFetch(`${basePath}/sign-out`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: '{}',
        })
          .catch(() => undefined)
          .finally(onDone);
      }}
    >
      {busy ? 'Signing out…' : 'Sign out'}
    </button>
  );
}
