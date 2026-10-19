'use client';

import { useId, useRef, useState, type FormEvent } from 'react';

/**
 * Staff sign-in: email and password, then the authenticator-app code (enrolling the first time).
 * It talks only to the portal's own origin (`basePath`, default /auth); tokens stay in HttpOnly
 * cookies set by the server and are never visible to this code. Error messages are deliberately
 * generic: they never say whether an account exists.
 */
export interface LoginFlowProps {
  portalName: string;
  /** Called after the session reached the second factor; normally navigates to the home page. */
  onDone: () => void;
  basePath?: string;
  fetchImpl?: typeof fetch;
}

type Step =
  | { kind: 'credentials' }
  | { kind: 'enrol'; factorId: string; qrCode: string; secret: string }
  | { kind: 'verify'; factorId: string };

const MESSAGES: Record<string, string> = {
  invalid_credentials: 'The email or password is not correct.',
  invalid_code: 'That code is not correct. Check your authenticator app and try again.',
  rate_limited: 'Too many attempts. Wait a few minutes and try again.',
  unavailable: 'Sign-in is temporarily unavailable. Try again shortly.',
  wrong_portal: 'This account is not set up for this portal.',
  no_access: 'This account has no active access. Contact your administrator.',
  forbidden_origin: 'This request was blocked. Reload the page and try again.',
  already_enrolled: 'A second factor is already set up for this account. Enter its code.',
  invalid_request: 'Check what you entered and try again.',
  network: 'Could not reach the server. Check your connection and try again.',
};

function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

interface Reply {
  status: number;
  body: Record<string, unknown>;
}

export function LoginFlow({ portalName, onDone, basePath = '/auth', fetchImpl }: LoginFlowProps) {
  const [step, setStep] = useState<Step>({ kind: 'credentials' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();
  const emailId = useId();
  const passwordId = useId();
  const codeId = useId();
  const emailRef = useRef<HTMLInputElement>(null);
  const doFetch = fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));

  async function post(path: string, payload: unknown): Promise<Reply | null> {
    try {
      const response = await doFetch(`${basePath}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(payload),
      });
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      return { status: response.status, body };
    } catch {
      return null;
    }
  }

  const fail = (code: unknown) =>
    setError(MESSAGES[typeof code === 'string' ? code : ''] ?? MESSAGES.unavailable ?? '');

  async function advance(next: unknown, factorId: unknown) {
    if (next === 'done') return onDone();
    if (next === 'mfa_verify' && typeof factorId === 'string')
      return setStep({ kind: 'verify', factorId });
    if (next === 'mfa_enrol') {
      const reply = await post('/mfa/enrol', {});
      if (!reply) return setError(MESSAGES.network ?? '');
      const { factorId: id, qrCode, secret } = reply.body;
      if (
        reply.status === 200 &&
        typeof id === 'string' &&
        typeof qrCode === 'string' &&
        typeof secret === 'string'
      ) {
        return setStep({ kind: 'enrol', factorId: id, qrCode, secret });
      }
      return fail(reply.body.error);
    }
    return fail('unavailable');
  }

  async function submitCredentials(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    const reply = await post('/sign-in', {
      email: field(form, 'email'),
      password: field(form, 'password'),
    });
    if (!reply) setError(MESSAGES.network ?? '');
    else if (reply.status === 200) await advance(reply.body.next, reply.body.factorId);
    else fail(reply.body.error);
    setBusy(false);
  }

  async function submitCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (step.kind === 'credentials') return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    const reply = await post('/mfa/verify', {
      factorId: step.factorId,
      code: field(form, 'code').replace(/\s/g, ''),
    });
    if (!reply) setError(MESSAGES.network ?? '');
    else if (reply.status === 200) onDone();
    else if (reply.body.error === 'invalid_session') {
      setStep({ kind: 'credentials' });
      setError('Your sign-in expired. Start again.');
    } else fail(reply.body.error);
    setBusy(false);
  }

  const errorBlock = (
    <p id={errorId} role="alert" className="form-error">
      {error}
    </p>
  );
  const describedBy = error ? errorId : undefined;

  if (step.kind === 'credentials') {
    return (
      <form
        onSubmit={(e) => void submitCredentials(e)}
        aria-labelledby={`${emailId}-title`}
        className="form"
        noValidate
      >
        <h1 id={`${emailId}-title`}>Sign in to {portalName}</h1>
        {error ? errorBlock : null}
        <label htmlFor={emailId}>Work email</label>
        <input
          ref={emailRef}
          id={emailId}
          name="email"
          type="email"
          autoComplete="username"
          required
          aria-describedby={describedBy}
          disabled={busy}
        />
        <label htmlFor={passwordId}>Password</label>
        <input
          id={passwordId}
          name="password"
          type="password"
          autoComplete="current-password"
          required
          aria-describedby={describedBy}
          disabled={busy}
        />
        <button type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Continue'}
        </button>
      </form>
    );
  }

  return (
    <form
      onSubmit={(e) => void submitCode(e)}
      className="form"
      noValidate
      aria-labelledby={`${codeId}-title`}
    >
      <h1 id={`${codeId}-title`}>
        {step.kind === 'enrol' ? 'Set up your authenticator app' : 'Enter your authentication code'}
      </h1>
      {step.kind === 'enrol' ? (
        <>
          <p>
            Scan this code with an authenticator app (for example Google Authenticator or Microsoft
            Authenticator), then enter the 6-digit code it shows.
          </p>
          {step.qrCode.startsWith('data:image/') ? (
            <img
              src={step.qrCode}
              alt="QR code for your authenticator app"
              width={192}
              height={192}
            />
          ) : null}
          <p>
            Cannot scan? Enter this key manually: <code>{step.secret}</code>
          </p>
        </>
      ) : (
        <p>Open your authenticator app and enter the 6-digit code for Udofin.</p>
      )}
      {error ? errorBlock : null}
      <label htmlFor={codeId}>6-digit code</label>
      <input
        id={codeId}
        name="code"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9 ]*"
        maxLength={7}
        required
        aria-describedby={describedBy}
        disabled={busy}
      />
      <button type="submit" disabled={busy}>
        {busy ? 'Checking…' : 'Verify and continue'}
      </button>
    </form>
  );
}
