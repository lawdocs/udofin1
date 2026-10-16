import { type MeResponse } from '@udofin/contracts';
import { PortalShell, type NavItem } from '@udofin/portal-kit';
import { type ReactNode } from 'react';
import { SignOut } from './sign-out-client';

/** Navigation reflects what the API says the user may do; every page and call is authorised again server-side. */
function navFor(me: MeResponse, current: string): NavItem[] {
  const permissions = new Set(me.memberships.flatMap((m) => m.permissions));
  const items: NavItem[] = [{ href: '/', label: 'Home' }];
  if (
    permissions.has('platform.organizations.manage') ||
    permissions.has('platform.consent_notices.manage')
  ) {
    items.push({ href: '/change-requests', label: 'Change requests' });
  }
  if (permissions.has('onboarding.read')) {
    items.push({ href: '/onboarding', label: 'Lender onboarding' });
  }
  if (
    permissions.has('application.read') ||
    permissions.has('loan.read') ||
    permissions.has('payment.read')
  ) {
    items.push({ href: '/transactions', label: 'Transactions' });
  }
  if (permissions.has('product.read')) items.push({ href: '/products', label: 'Products' });
  // Phase 08a: platform-side payment setup. The links are conveniences; the API and the database authorise every call.
  if (permissions.has('platform.payments.providers.manage'))
    items.push({ href: '/providers', label: 'Payment providers' });
  if (
    permissions.has('platform.accounts.registry.manage') ||
    permissions.has('platform.accounts.registry.verify')
  )
    items.push({ href: '/accounts', label: 'Account registry' });
  if (permissions.has('platform.features.manage'))
    items.push({ href: '/features', label: 'Feature switches' });
  if (permissions.has('platform.payments.providers.manage'))
    items.push({ href: '/exceptions', label: 'Platform exceptions' });
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
      portalName="Udofin Operations"
      userLabel="Udofin staff"
      nav={navFor(me, current)}
      signOut={<SignOut />}
    >
      {children}
    </PortalShell>
  );
}
