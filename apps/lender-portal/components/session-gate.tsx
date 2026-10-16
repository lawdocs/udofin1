import { UnauthorizedState } from '@udofin/portal-kit';
import { redirect } from 'next/navigation';
import { type ReactNode } from 'react';
import { currentSession } from '@/lib/auth';
import { SignOut } from './sign-out-client';

type Ok = Extract<Awaited<ReturnType<typeof currentSession>>, { state: 'ok' }>;

/**
 * Resolves the signed-in staff member from the API. Anything other than a valid platform session
 * redirects to sign-in or renders an explanation; page content is never built without it.
 */
export async function requireSession(): Promise<Ok | { blocked: ReactNode }> {
  const session = await currentSession();
  switch (session.state) {
    case 'ok':
      return session;
    case 'unauthenticated':
    case 'mfa_required':
      return redirect('/login');
    case 'wrong_portal':
      return {
        blocked: (
          <main className="shell">
            <UnauthorizedState
              title="This account cannot use the lender portal"
              detail="Sign in with your lender organisation account."
              action={<SignOut />}
            />
          </main>
        ),
      };
    case 'no_access':
      return {
        blocked: (
          <main className="shell">
            <UnauthorizedState
              title="Your access is not active"
              detail="Contact your organisation's administrator."
              action={<SignOut />}
            />
          </main>
        ),
      };
    case 'unavailable':
      return {
        blocked: (
          <main className="shell">
            <section role="alert" className="state state-error">
              <h2>The service is temporarily unavailable</h2>
              <p>Reload in a moment. If it continues, contact the platform team.</p>
            </section>
          </main>
        ),
      };
  }
}
