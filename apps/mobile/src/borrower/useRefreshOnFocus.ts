import { useFocusEffect } from 'expo-router';
import { useCallback, useRef } from 'react';

/** Runs `reload` each time the screen comes back into focus (not on the first focus, when the screen loads by itself). */
export function useRefreshOnFocus(reload: () => void): void {
  const first = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (first.current) {
        first.current = false;
        return;
      }
      reload();
    }, [reload]),
  );
}
