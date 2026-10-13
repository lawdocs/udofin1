// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent, type UserEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoginFlow } from '../src/login-flow.js';
import { PortalShell } from '../src/shell.js';
import { SignOutButton } from '../src/sign-out-button.js';
import { EmptyState, ErrorState, LoadingState, UnauthorizedState } from '../src/states.js';

afterEach(cleanup);

type Reply = { status: number; body: unknown };
function scripted(replies: Record<string, Reply[]>) {
  const calls: { path: string; body: unknown }[] = [];
  const impl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const path =
      typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
    calls.push({ path, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
    const next = replies[path]?.shift();
    if (!next) return Promise.reject(new TypeError('network down'));
    return Promise.resolve(new Response(JSON.stringify(next.body), { status: next.status }));
  });
  return { fetchImpl: impl as unknown as typeof fetch, calls };
}

async function signIn(user: UserEvent) {
  await user.type(screen.getByLabelText('Work email'), 'staff@udofin.example');
  await user.type(screen.getByLabelText('Password'), 'a long passphrase');
  await user.click(screen.getByRole('button', { name: 'Continue' }));
}

describe('LoginFlow', () => {
  it('has labelled fields, a heading and the right autocomplete hints', () => {
    render(<LoginFlow portalName="Udofin Operations" onDone={() => undefined} />);
    expect(screen.getByRole('heading', { name: 'Sign in to Udofin Operations' })).toBeTruthy();
    expect(screen.getByLabelText('Password').getAttribute('type')).toBe('password');
    expect(screen.getByLabelText('Password').getAttribute('autocomplete')).toBe('current-password');
    expect(screen.getByLabelText('Work email').getAttribute('autocomplete')).toBe('username');
  });

  it('shows a generic message for wrong credentials and keeps the form usable', async () => {
    const user = userEvent.setup();
    const { fetchImpl } = scripted({
      '/auth/sign-in': [{ status: 401, body: { error: 'invalid_credentials' } }],
    });
    render(<LoginFlow portalName="P" onDone={() => undefined} fetchImpl={fetchImpl} />);
    await signIn(user);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('The email or password is not correct.');
    expect(alert.textContent).not.toMatch(/exist|account found|unknown/i);
    expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(screen.getByLabelText('Work email').getAttribute('aria-describedby')).toBe(alert.id);
  });

  it('walks first-time enrolment: QR code, manual key, then verification completes sign-in', async () => {
    const user = userEvent.setup();
    const done = vi.fn();
    const { fetchImpl, calls } = scripted({
      '/auth/sign-in': [{ status: 200, body: { next: 'mfa_enrol' } }],
      '/auth/mfa/enrol': [
        {
          status: 200,
          body: {
            factorId: 'f1',
            qrCode: 'data:image/svg+xml;base64,AAAA',
            secret: 'JBSWY3DPEHPK3PXP',
          },
        },
      ],
      '/auth/mfa/verify': [{ status: 200, body: { next: 'done' } }],
    });
    render(<LoginFlow portalName="P" onDone={done} fetchImpl={fetchImpl} />);
    await signIn(user);
    expect(
      await screen.findByRole('heading', { name: 'Set up your authenticator app' }),
    ).toBeTruthy();
    expect(screen.getByAltText('QR code for your authenticator app')).toBeTruthy();
    expect(screen.getByText('JBSWY3DPEHPK3PXP')).toBeTruthy();
    await user.type(screen.getByLabelText('6-digit code'), '123 456');
    await user.click(screen.getByRole('button', { name: 'Verify and continue' }));
    await waitFor(() => expect(done).toHaveBeenCalledTimes(1));
    expect(calls.at(-1)).toEqual({
      path: '/auth/mfa/verify',
      body: { factorId: 'f1', code: '123456' },
    });
  });

  it('never renders a QR source that is not an inline image', async () => {
    const user = userEvent.setup();
    const { fetchImpl } = scripted({
      '/auth/sign-in': [{ status: 200, body: { next: 'mfa_enrol' } }],
      '/auth/mfa/enrol': [
        {
          status: 200,
          body: { factorId: 'f1', qrCode: 'https://evil.example/x.svg', secret: 'S' },
        },
      ],
    });
    render(<LoginFlow portalName="P" onDone={() => undefined} fetchImpl={fetchImpl} />);
    await signIn(user);
    await screen.findByRole('heading', { name: 'Set up your authenticator app' });
    expect(screen.queryByAltText('QR code for your authenticator app')).toBeNull();
  });

  it('asks an enrolled user for the code and reports a wrong one without leaving the step', async () => {
    const user = userEvent.setup();
    const { fetchImpl } = scripted({
      '/auth/sign-in': [{ status: 200, body: { next: 'mfa_verify', factorId: 'f9' } }],
      '/auth/mfa/verify': [{ status: 401, body: { error: 'invalid_code' } }],
    });
    render(<LoginFlow portalName="P" onDone={() => undefined} fetchImpl={fetchImpl} />);
    await signIn(user);
    await screen.findByRole('heading', { name: 'Enter your authentication code' });
    await user.type(screen.getByLabelText('6-digit code'), '000000');
    await user.click(screen.getByRole('button', { name: 'Verify and continue' }));
    expect((await screen.findByRole('alert')).textContent).toContain('That code is not correct');
    expect(screen.getByLabelText('6-digit code')).toBeTruthy();
  });

  it('explains wrong portal, rate limits, outages and network failure plainly', async () => {
    const cases: [Reply, string][] = [
      [{ status: 429, body: { error: 'rate_limited' } }, 'Too many attempts'],
      [{ status: 503, body: { error: 'unavailable' } }, 'temporarily unavailable'],
      [{ status: 403, body: { error: 'wrong_portal' } }, 'not set up for this portal'],
    ];
    for (const [reply, text] of cases) {
      const user = userEvent.setup();
      const { fetchImpl } = scripted({ '/auth/sign-in': [reply] });
      render(<LoginFlow portalName="P" onDone={() => undefined} fetchImpl={fetchImpl} />);
      await signIn(user);
      expect((await screen.findByRole('alert')).textContent).toContain(text);
      cleanup();
    }
    const user = userEvent.setup();
    render(
      <LoginFlow portalName="P" onDone={() => undefined} fetchImpl={scripted({}).fetchImpl} />,
    );
    await signIn(user);
    expect((await screen.findByRole('alert')).textContent).toContain('Could not reach the server');
  });

  it('returns to the password step when the half-finished session has expired', async () => {
    const user = userEvent.setup();
    const { fetchImpl } = scripted({
      '/auth/sign-in': [{ status: 200, body: { next: 'mfa_verify', factorId: 'f9' } }],
      '/auth/mfa/verify': [{ status: 401, body: { error: 'invalid_session' } }],
    });
    render(<LoginFlow portalName="P" onDone={() => undefined} fetchImpl={fetchImpl} />);
    await signIn(user);
    await user.type(await screen.findByLabelText('6-digit code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Verify and continue' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Start again');
    expect(screen.getByLabelText('Work email')).toBeTruthy();
  });
});

describe('SignOutButton and shell', () => {
  it('posts to sign-out and then navigates even when the request fails', async () => {
    const user = userEvent.setup();
    const done = vi.fn();
    render(<SignOutButton onDone={done} fetchImpl={scripted({}).fetchImpl} />);
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(done).toHaveBeenCalled());
  });

  it('renders landmarks, a skip link and marks the current page', () => {
    render(
      <PortalShell
        portalName="Udofin Operations"
        userLabel="Platform staff"
        nav={[
          { href: '/', label: 'Home', current: true },
          { href: '/x', label: 'Requests' },
        ]}
        signOut={<button>Sign out</button>}
      >
        <p>content</p>
      </PortalShell>,
    );
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeTruthy();
    expect(screen.getByRole('main')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Skip to content' }).getAttribute('href')).toBe(
      '#main',
    );
    expect(screen.getByRole('link', { name: 'Home' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'Requests' }).getAttribute('aria-current')).toBeNull();
  });

  it('state panels announce themselves to assistive technology', () => {
    render(
      <>
        <LoadingState />
        <ErrorState title="Oops" detail="Try again" />
        <UnauthorizedState />
        <EmptyState title="Nothing here" />
      </>,
    );
    expect(screen.getByRole('status').textContent).toBe('Loading…');
    expect(screen.getAllByRole('alert')).toHaveLength(2);
    expect(screen.getByText('Nothing here')).toBeTruthy();
  });
});
