import { type MeResponse } from '@udofin/contracts';
import { PortalShell, type NavItem } from '@udofin/portal-kit';
import { type ReactNode } from 'react';
import { SignOut } from './sign-out-client';

/** Navigation reflects what the API says the user may do; every page and call is authorised again server-side. */
function navFor(me: MeResponse, current: string): NavItem[] {
  // Lender features add items here, driven by me.memberships[].permissions (applications, products, ...).
  const permissions = new Set(me.memberships.flatMap((m) => m.permissions));
  const items: NavItem[] = [{ href: '/', label: 'Home' }];
  if (permissions.has('onboarding.read')) items.push({ href: '/onboarding', label: 'Onboarding' });
  if (
    permissions.has('application.read') ||
    permissions.has('loan.read') ||
    permissions.has('payment.read')
  ) {
    items.push({ href: '/transactions', label: 'Transactions' });
  }
  if (permissions.has('application.read'))
    items.push({ href: '/applications', label: 'Applications' });
  if (permissions.has('product.read')) items.push({ href: '/products', label: 'Products' });
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
