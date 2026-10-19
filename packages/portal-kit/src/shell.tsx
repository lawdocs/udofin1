import { type ReactNode } from 'react';

export interface NavItem {
  href: string;
  label: string;
  current?: boolean;
}

export interface PortalShellProps {
  portalName: string;
  /** Who is signed in, for display only (never an authorisation signal). */
  userLabel: string;
  nav: NavItem[];
  /** The sign-out control (a client component). */
  signOut: ReactNode;
  children: ReactNode;
}

/**
 * Page frame. Navigation is built from what the server says the user may do, but hiding a link
 * is only a convenience: every page and API call is authorised again on the server.
 */
export function PortalShell({ portalName, userLabel, nav, signOut, children }: PortalShellProps) {
  return (
    <div className="portal">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="portal-header">
        <strong>{portalName}</strong>
        <nav aria-label="Main">
          <ul>
            {nav.map((item) => (
              <li key={item.href}>
                <a href={item.href} aria-current={item.current ? 'page' : undefined}>
                  {item.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <div className="portal-user">
          <span className="muted">{userLabel}</span>
          {signOut}
        </div>
      </header>
      <main id="main" className="shell">
        {children}
      </main>
    </div>
  );
}
