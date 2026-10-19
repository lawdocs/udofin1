'use client';

import { LoginFlow } from '@udofin/portal-kit';

// A full navigation on purpose: the session cookies just changed and the proxy must see them.
// eslint-disable-next-line @next/next/no-location-assign-relative-destination
const goHome = () => window.location.assign('/');

export function LoginClient({ portalName }: { portalName: string }) {
  return <LoginFlow portalName={portalName} onDone={goHome} />;
}
