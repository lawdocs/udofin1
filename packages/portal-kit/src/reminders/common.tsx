import { type LrOverdueReminders } from '@udofin/contracts';
import { type ReactNode } from 'react';
import { type FormAction } from '../onboarding/forms.js';
import { formatIst } from '../servicing/format.js';
import { SelectInput } from './fields.js';
import { type RemindersGrant } from './data.js';
import { type FormRun } from './stateful-form.js';
import { remindersErrorMessage } from './wording.js';

/** What every reminders view needs: the form actions, where they return to, what the person may do and who the person is. */
export interface RemindersContext {
  /** For the small forms (approve, retire, release): the server action redirects back with a short notice. */
  action: FormAction;
  /** For the forms that keep what was typed when they are refused (the drafts and the hold). */
  draft: FormRun;
  /** The page the actions return to (an allow-listed lender reminders path). */
  returnTo: string;
  grants: readonly RemindersGrant[];
  /** The signed-in person: an approve form is never drawn for something this person drafted. */
  userId: string;
}

export type { Loaded } from '../servicing/common.js';

/** The result of the last action, shown as plain words. The error is a stable code mapped to a sentence, never server text. */
export function RemindersNotice({ done, error }: { done?: boolean; error?: string | undefined }) {
  if (error)
    return (
      <p role="alert" className="form-error">
        {remindersErrorMessage(error)}
      </p>
    );
  if (done) return <p role="status">Your action was recorded.</p>;
  return null;
}

const NAV = [
  { href: '/reminders', label: 'Reminder log' },
  { href: '/reminders/policy', label: 'Policy' },
  { href: '/reminders/wording', label: 'Wording' },
  { href: '/reminders/penal-text', label: 'Penal-charge text' },
  { href: '/reminders/holds', label: 'Holds' },
] as const;

/** Links between the reminder pages. The current page is named in words, not only by style. */
export function RemindersNav({ current }: { current: (typeof NAV)[number]['href'] | null }) {
  return (
    <nav aria-label="Reminder pages" className="tabs">
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

/**
 * Which lender a page is about. With one lender it is named; with several, a small GET form chooses (the other filters of the
 * page are kept as hidden fields so choosing a lender does not lose them).
 */
export function LenderPicker({
  lenders,
  selected,
  path,
  keep,
}: {
  lenders: readonly { lenderId: string; name: string }[];
  selected: string | undefined;
  path: string;
  keep?: Record<string, string | undefined>;
}) {
  if (lenders.length === 0) return null;
  if (lenders.length === 1)
    return (
      <p>
        Lender: <strong>{lenders[0]?.name ?? ''}</strong>
      </p>
    );
  return (
    <form method="get" action={path} className="inline">
      {Object.entries(keep ?? {}).map(([name, value]) =>
        value ? <input key={name} type="hidden" name={name} value={value} /> : null,
      )}
      <SelectInput
        name="lenderId"
        label="Lender"
        options={lenders.map((l) => ({ value: l.lenderId, label: l.name }))}
        defaultValue={selected}
      />
      <button type="submit" className="secondary">
        Show
      </button>
    </form>
  );
}

/**
 * The overdue-reminder flag the API derives from the lender's penal-charge text rows. While no approved text exists, every
 * overdue reminder is held back and never sent; before-due and due-day reminders do not depend on it.
 */
export function OverdueNotice({ overdue }: { overdue: LrOverdueReminders | null }) {
  if (overdue === null)
    return (
      <p className="muted">
        Whether an approved penal-charge text exists could not be checked just now.
      </p>
    );
  if (!overdue.penalTextApproved || overdue.overdueRemindersWithheld)
    return (
      <section className="state" role="status" aria-labelledby="overdue-notice-title">
        <h2 id="overdue-notice-title">
          Overdue reminders are not sent until an approved penal-charge text exists
        </h2>
        <p>
          This lender has no approved penal-charge text, so every overdue reminder is held back and
          recorded as not sent. Reminders before the due date and on the due date do not depend on
          it.
        </p>
        <p>
          <a href="/reminders/penal-text">Go to the penal-charge text</a>
        </p>
      </section>
    );
  return (
    <p className="muted">
      An approved penal-charge text exists. Overdue reminders also need approved overdue wording and
      an approved policy.
    </p>
  );
}

/** "you" for the signed-in person, otherwise the identifier the API gives (no names are available). */
export function Person({ id, userId }: { id: string; userId: string }) {
  return id === userId ? <>you</> : <>another person (ID {id})</>;
}

/** Who drafted, approved and retired a version, and when. */
export function Trail({
  userId,
  draftedBy,
  draftedAt,
  approvedBy,
  approvedAt,
  retiredBy,
  retiredAt,
}: {
  userId: string;
  draftedBy: string;
  draftedAt: string;
  approvedBy: string | null;
  approvedAt: string | null;
  retiredBy: string | null;
  retiredAt: string | null;
}): ReactNode {
  return (
    <>
      <div>
        <dt>Drafted</dt>
        <dd>
          By <Person id={draftedBy} userId={userId} /> on {formatIst(draftedAt)}
        </dd>
      </div>
      <div>
        <dt>Approved</dt>
        <dd>
          {approvedBy !== null && approvedAt !== null ? (
            <>
              By <Person id={approvedBy} userId={userId} /> on {formatIst(approvedAt)}
            </>
          ) : (
            'Not approved'
          )}
        </dd>
      </div>
      {retiredBy !== null && retiredAt !== null ? (
        <div>
          <dt>Retired</dt>
          <dd>
            By <Person id={retiredBy} userId={userId} /> on {formatIst(retiredAt)}
          </dd>
        </div>
      ) : null}
    </>
  );
}
