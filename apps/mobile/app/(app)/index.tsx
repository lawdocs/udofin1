import { type MeResponse } from '@udofin/contracts';
import { useEffect, useState } from 'react';
import { useAuth } from '../../src/auth/AuthProvider';
import { Banner, Body, Button, Heading, Loading, Screen } from '../../src/ui/kit';

type Load =
  | { kind: 'loading' }
  | { kind: 'ready'; me: MeResponse }
  | { kind: 'offline' }
  | { kind: 'error'; code: string };

/**
 * Signed-in home. Phase 03 shows only that the session works end to end (token -> API -> database).
 * Onboarding, offers and loans arrive in later phases; nothing here is sample or fabricated loan data.
 */
export default function HomeScreen() {
  const { api, signOut } = useAuth();
  const [load, setLoad] = useState<Load>({ kind: 'loading' });

  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void api.me().then((result) => {
      if (cancelled) return;
      if (result.ok) setLoad({ kind: 'ready', me: result.data });
      else if (result.code === 'network_error') setLoad({ kind: 'offline' });
      else setLoad({ kind: 'error', code: result.code });
    });
    return () => {
      cancelled = true;
    };
  }, [api, attempt]);

  const retry = () => {
    setLoad({ kind: 'loading' });
    setAttempt((n) => n + 1);
  };

  if (load.kind === 'loading') return <Loading label="Loading your account" />;
  return (
    <Screen>
      <Heading>Udofin</Heading>
      {load.kind === 'ready' ? (
        <>
          <Banner tone="info">
            You are signed in. Loan features are not available yet in this build.
          </Banner>
          <Body muted>Account type: {load.me.actor}</Body>
        </>
      ) : null}
      {load.kind === 'offline' ? (
        <>
          <Banner tone="warning">
            You appear to be offline. Check your connection and try again.
          </Banner>
          <Button title="Try again" onPress={() => retry()} />
        </>
      ) : null}
      {load.kind === 'error' ? (
        <>
          <Banner tone="danger">
            We could not load your account right now. Please try again in a moment.
          </Banner>
          <Button title="Try again" onPress={() => retry()} />
        </>
      ) : null}
      <Button title="Sign out" secondary onPress={() => void signOut()} />
    </Screen>
  );
}
