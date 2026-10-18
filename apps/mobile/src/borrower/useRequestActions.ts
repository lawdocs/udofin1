import { useCallback, useRef, useState } from 'react';
import { keyAfter, newActionKey, type ServicingClient } from './servicing';

/**
 * Cancelling an open statement or quotation request. Every cancellation is one user action with its own Idempotency-Key: a
 * lost answer (offline) is retried with the same key, anything else ends the action and the next tap gets a new key.
 * A cancellation is shown as done only when the API said so.
 */
export function useRequestActions(
  servicing: ServicingClient,
  loanId: string,
  onChanged: () => void,
) {
  const keys = useRef(new Map<string, string>());
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelled, setCancelled] = useState(false);

  const cancel = useCallback(
    async (requestId: string) => {
      setCancelling(requestId);
      setError(null);
      setCancelled(false);
      const key = keys.current.get(requestId) ?? newActionKey();
      keys.current.set(requestId, key);
      const result = await servicing.cancelDocumentRequest(loanId, requestId, key);
      setCancelling(null);
      if (keyAfter(result, key) !== key) keys.current.delete(requestId);
      if (!result.ok) {
        setError(result.code);
        // The request may have been answered meanwhile: show the list as it is now.
        if (result.code === 'request_not_open') onChanged();
        return;
      }
      setCancelled(true);
      onChanged();
    },
    [servicing, loanId, onChanged],
  );

  return { cancel, cancelling, error, cancelled };
}
