import { type MeResponse } from '@udofin/contracts';
import { PortalShell, type NavItem } from '@udofin/portal-kit';
import { type ReactNode } from 'react';
import { SignOut } from './sign-out-client';

/** Navigation reflects what the API says the user may do; every page and call is authorised again server-side. */
function navFor(me: MeResponse, current: string): NavItem[] {
  // Lender features add items here, driven by me.memberships[].permissions (applications, products, ...).
  void me;
  const items: NavItem[] = [{ href: '/', label: 'Home' }];
  return items.map((item) => ({ ...item, current: item.href === current }));
}

export function PageFrame({
  me,
  current,
  children,
}: {
  me: MeResponse;
  current: string;
  children: ReactNode;
}) {
  return (
    <PortalShell
      portalName="Udofin Lender Portal"
      userLabel="Lender staff"
      nav={navFor(me, current)}
      signOut={<SignOut />}
    >
      {children}
    </PortalShell>
  );
}
