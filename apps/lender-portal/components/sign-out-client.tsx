'use client';

import { SignOutButton } from '@udofin/portal-kit';

// eslint-disable-next-line @next/next/no-location-assign-relative-destination
const goToLogin = () => window.location.assign('/login');

export function SignOut() {
  return <SignOutButton onDone={goToLogin} />;
}
