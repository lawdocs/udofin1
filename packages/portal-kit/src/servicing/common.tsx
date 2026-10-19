import { type ReactNode, useId } from 'react';
import { type FormAction } from '../onboarding/forms.js';
import { EmptyState, ErrorState, UnauthorizedState } from '../states.js';
import { type ServicingGrant } from './data.js';
import { formatIst } from './format.js';
import { servicingErrorMessage } from './wording.js';

/** What every servicing view needs: the form action, where it returns to, and what the person may do in each lender. */
export interface ServicingContext {
  action: FormAction;
  /** The page the action returns to (an allow-listed lender servicing path). */
  returnTo: string;
  grants: readonly ServicingGrant[];
}

export type Loaded<T> =
  { ok: true; status: number; data: T } | { ok: false; status: number; code: string };

/** The result of the last action, shown as plain words. The error is a stable code mapped to a sentence, never server text. */
export function ServicingNotice({ done, error }: { done?: boolean; error?: string | undefined }) {
  if (error)
    return (
      <p role="alert" className="form-error">
        {servicingErrorMessage(error)}
      </p>
    );
  if (done) return <p role="status">Your action was recorded.</p>;
  return null;
}

/** What to show in place of data that could not be loaded. Nothing the server said is repeated. */
export function LoadFailure({ what, status }: { what: string; status: number }) {
  if (status === 403)
    return (
      <UnauthorizedState
        title={`You cannot view ${what}`}
        detail="Your role does not include this."
      />
    );
  return <ErrorState title={`Could not load ${what}`} detail="Reload the page." />;
}

export function EmptyList({ title, detail }: { title: string; detail?: string }) {
  return detail ? <EmptyState title={title} detail={detail} /> : <EmptyState title={title} />;
}

const NAV = [
  { href: '/loans', label: 'Loans' },
  { href: '/loans/requests', label: 'Document requests' },
  { href: '/loans/closures', label: 'Closures' },
  { href: '/imports', label: 'Imports and sync' },
  { href: '/imports/conflicts', label: 'Conflicts' },
  { href: '/imports/anomalies', label: 'Flags' },
] as const;

/** Links between the servicing pages. The current page is named in words, not only by style. */
export function ServicingNav({ current }: { current: (typeof NAV)[number]['href'] }) {
  return (
    <nav aria-label="Servicing pages" className="tabs">
      <ul>
        {NAV.map((item) => (
          <li key={item.href}>
            <a href={item.href} aria-current={item.href === current ? 'page' : undefined}>
              {item.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** A file chooser with its label. */
export function FileField({
  name,
  label,
  accept,
  hint,
}: {
  name: string;
  label: string;
  accept: string;
  hint?: string;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        name={name}
        type="file"
        accept={accept}
        required
        aria-describedby={hint ? `${id}-hint` : undefined}
      />
      {hint ? (
        <small id={`${id}-hint`} className="muted">
          {hint}
        </small>
      ) : null}
    </div>
  );
}

/** One tick box. It is never ticked by default unless it shows a value the lender already stored. */
export function CheckField({
  name,
  value,
  label,
  checked,
}: {
  name: string;
  value?: string;
  label: string;
  checked?: boolean;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          name={name}
          {...(value !== undefined ? { value } : {})}
          defaultChecked={checked === true}
        />{' '}
        {label}
      </label>
    </div>
  );
}

/** "as reported by <lender> on <date, time IST>": whose figure it is and when. */
export function AsReported({
  lender,
  at,
  receivedAt,
}: {
  lender: string;
  at: string;
  receivedAt?: string;
}) {
  return (
    <p className="muted">
      As reported by {lender} on {formatIst(at)}
      {receivedAt ? ` (received by Udofin on ${formatIst(receivedAt)})` : ''}.
    </p>
  );
}

/** Older / newer links for a keyset-paged list. */
export function Paging({
  nextHref,
  firstHref,
  hasCursor,
  noun,
}: {
  nextHref: string | null;
  firstHref: string;
  hasCursor: boolean;
  noun: string;
}) {
  if (!nextHref && !hasCursor) return null;
  return (
    <nav aria-label={`More ${noun}`}>
      {hasCursor ? <a href={firstHref}>Back to the newest {noun}</a> : null}
      {hasCursor && nextHref ? ' · ' : null}
      {nextHref ? <a href={nextHref}>Older {noun}</a> : null}
    </nav>
  );
}

export const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="card">
    <h2>{title}</h2>
    {children}
  </section>
);
