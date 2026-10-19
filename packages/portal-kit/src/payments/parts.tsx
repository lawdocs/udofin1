import { type ReactNode, useId } from 'react';
import { type FormAction } from '../onboarding/forms.js';
import { LenderPicker } from '../reminders/common.js';
import { ErrorState, LoadingState } from '../states.js';
import { type LpCapabilities, type LpResult } from './data.js';
import { ERROR_WORDS, lpErrorMessage } from './labels.js';

/** What every payment screen needs to draw its forms. The API decides what the person may actually do. */
export interface LpViewContext {
  action: FormAction;
  /** The page a form returns to (one of the payment, mandate or reconciliation pages). */
  returnTo: string;
  caps: LpCapabilities;
  /** The signed-in person, used only to offer "assign to me". */
  userId?: string;
  /** The lender organisation the screens act for. */
  lenderId?: string;
  /** The lenders the person holds a payment permission in (named, so the page can say whose figures it shows and offer a choice). */
  lenders?: readonly { lenderId: string; name: string }[];
}

/**
 * Which lender a page is about. With one lender it is named; with several, a small form chooses (a GET to the same page, so the
 * choice is in the address and survives a reload). Nothing is drawn when no lender is known.
 */
export function LpLender({ ctx, path }: { ctx: LpViewContext; path: string }) {
  return <LenderPicker lenders={ctx.lenders ?? []} selected={ctx.lenderId} path={path} />;
}

/** The detail line of a failed load: a stable explanation, never the server's own text. */
export function lpLoadDetail(status: number, code: string): string {
  if (status === 403) return 'Your role does not include this.';
  if (status === 404) return 'It was not found for your organisation.';
  if (status === 401 || code === 'mfa_required') return lpErrorMessage('mfa_required');
  return Object.hasOwn(ERROR_WORDS, code) || /^http_5\d\d$/.test(code)
    ? lpErrorMessage(code)
    : 'Reload the page.';
}

/**
 * Draws the result of a load: nothing while it is absent (loading), a plain explanation when it failed, the content when it
 * arrived. A failure is never drawn as an empty list or as zero.
 */
export function Loadable<T>({
  result,
  title,
  children,
}: {
  result: LpResult<T> | undefined;
  title: string;
  children: (data: T) => ReactNode;
}) {
  if (!result) return <LoadingState label={`Loading ${title}…`} />;
  if (!result.ok) {
    return (
      <ErrorState
        title={
          result.status === 403
            ? `You cannot view ${title}`
            : result.status === 404
              ? `${title.charAt(0).toUpperCase()}${title.slice(1)} not found`
              : `Could not load ${title}`
        }
        detail={lpLoadDetail(result.status, result.code)}
      />
    );
  }
  return <>{children(result.data)}</>;
}

/** The outcome of the last form: what the API said, in the portal's own words. */
export function LpNotice({
  done,
  error,
  inserted,
  duplicates,
}: {
  done?: boolean;
  error?: string | undefined;
  inserted?: number | undefined;
  duplicates?: number | undefined;
}) {
  if (error) {
    return (
      <p role="alert" className="form-error">
        <strong>Not done.</strong> {lpErrorMessage(error)}
      </p>
    );
  }
  if (!done) return null;
  return (
    <p role="status">
      <strong>Done.</strong> The server accepted the change.
      {inserted !== undefined && duplicates !== undefined
        ? ` ${String(inserted)} bank credit(s) were recorded and ${String(duplicates)} were already on record.`
        : ''}
    </p>
  );
}

export interface SectionLink {
  href: string;
  label: string;
}

export const PAYMENTS_LINKS: readonly SectionLink[] = [
  { href: '/payments', label: 'Payments' },
  { href: '/payments/events', label: 'Provider events' },
  { href: '/payments/policy', label: 'Payment policy' },
];
export const MANDATES_LINKS: readonly SectionLink[] = [
  { href: '/mandates', label: 'Mandates' },
  { href: '/mandates/debits', label: 'Debits' },
  { href: '/mandates/policy', label: 'Mandate policy' },
];
export const RECONCILIATION_LINKS: readonly SectionLink[] = [
  { href: '/reconciliation', label: 'Runs' },
  { href: '/reconciliation/settlements', label: 'Settlements' },
  { href: '/reconciliation/bank-credits', label: 'Bank credits' },
  { href: '/reconciliation/exceptions', label: 'Exceptions' },
  { href: '/reconciliation/settings', label: 'Waiting times' },
];

/** The links between the pages of one area. The current page is marked in words for assistive technology, not by style alone. */
export function SectionNav({
  links,
  current,
  label,
}: {
  links: readonly SectionLink[];
  current: string;
  label: string;
}) {
  return (
    <nav className="tabs" aria-label={label}>
      <ul>
        {links.map((link) => (
          <li key={link.href}>
            <a href={link.href} aria-current={link.href === current ? 'page' : undefined}>
              {link.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** "Older entries" for a cursor-paged list. The cursor is opaque and travels only in the address. */
export function Pager({
  basePath,
  keep,
  nextCursor,
}: {
  basePath: string;
  keep: Readonly<Record<string, string>>;
  nextCursor: string | null;
}) {
  if (!nextCursor) return null;
  const search = new URLSearchParams({ ...keep, cursor: nextCursor }).toString();
  return (
    <p>
      <a href={`${basePath}?${search}`}>Show older entries</a>
    </p>
  );
}

/** A term and its value, one per row. A missing value is written as a dash. */
export function Facts({ rows }: { rows: readonly [string, ReactNode][] }) {
  return (
    <dl className="facts">
      {rows.map(([term, value]) => (
        <div key={term}>
          <dt>{term}</dt>
          <dd>{value ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A box the person ticks on purpose to confirm an action. It is never ticked in advance. */
export function ConfirmField({ label }: { label: string }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>
        <input id={id} type="checkbox" name="confirm" required /> {label}
      </label>
    </div>
  );
}

/** A banner for a finding that needs attention. It says so in words ("Critical"), so colour is never the only signal. */
export function CriticalBanner({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section role="alert" className="state state-error">
      <h2>
        <span>Critical: </span>
        {title}
      </h2>
      {children}
    </section>
  );
}

/** A plain statement of what a form changes (and what it does not). */
export function WhatItChanges({ children }: { children: ReactNode }) {
  return (
    <div className="card">
      <h3>What this changes</h3>
      {children}
    </div>
  );
}
