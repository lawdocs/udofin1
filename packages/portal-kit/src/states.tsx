import { type ReactNode } from 'react';

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <p role="status" aria-live="polite" className="muted">
      {label}
    </p>
  );
}

export function ErrorState({
  title = 'Something went wrong',
  detail,
  action,
}: {
  title?: string;
  detail?: string;
  action?: ReactNode;
}) {
  return (
    <section role="alert" className="state state-error">
      <h2>{title}</h2>
      {detail ? <p>{detail}</p> : null}
      {action}
    </section>
  );
}

export function EmptyState({ title, detail }: { title: string; detail?: string }) {
  return (
    <section className="state">
      <h2>{title}</h2>
      {detail ? <p className="muted">{detail}</p> : null}
    </section>
  );
}

export function UnauthorizedState({
  title = 'You do not have access to this page',
  detail,
  action,
}: {
  title?: string;
  detail?: string;
  action?: ReactNode;
}) {
  return (
    <section className="state state-error" role="alert">
      <h2>{title}</h2>
      <p>
        {detail ??
          'Your account is signed in but is not permitted to see this. Contact your administrator if you think this is wrong.'}
      </p>
      {action}
    </section>
  );
}
