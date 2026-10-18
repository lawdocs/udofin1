import { type FormAction } from '../onboarding/forms.js';
import { SelectInput } from '../reminders/fields.js';
import { type FormRun } from '../reminders/stateful-form.js';
import { type SetupGrant } from './data.js';
import { type DraftedConfig } from './types.js';
import { setupErrorMessage } from './wording.js';

export type { Loaded } from '../servicing/common.js';

/** What every payment-setup view needs: the form actions, where they return to, what the person may do and who the person is. */
export interface SetupContext {
  /** For the small forms (submit, decide, withdraw, retire): the server action redirects back with a short notice. */
  action: FormAction;
  /** For the forms that keep what was typed when they are refused (a settlement account request, a merchant claim). */
  draft: FormRun;
  /** For the configuration draft, whose answer carries the callback token to show once. */
  draftConfig: FormRun<DraftedConfig>;
  /** The page the actions return to (an allow-listed payment-setup path). */
  returnTo: string;
  grants: readonly SetupGrant[];
  /** The signed-in person: a decide form is never drawn for a configuration this person drafted or submitted. */
  userId: string;
}

/** The result of the last action, shown as plain words. The error is a stable code mapped to a sentence, never server text. */
export function SetupNotice({ done, error }: { done?: boolean; error?: string | undefined }) {
  if (error)
    return (
      <p role="alert" className="form-error">
        {setupErrorMessage(error)}
      </p>
    );
  if (done) return <p role="status">Your action was recorded.</p>;
  return null;
}

const NAV = [
  { href: '/payment-setup', label: 'Configurations' },
  { href: '/payment-setup/new', label: 'New configuration' },
  { href: '/payment-setup/accounts', label: 'Merchants and settlement accounts' },
  { href: '/payment-setup/features', label: 'Features' },
] as const;

/** Links between the payment-setup pages. The current page is named in words, not only by style. */
export function SetupNav({ current }: { current: (typeof NAV)[number]['href'] | null }) {
  return (
    <nav aria-label="Payment setup pages" className="tabs">
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

/** Which lender a page is about: named when there is one, a small GET form when there are several. */
export function SetupLenderPicker({
  lenders,
  selected,
  path,
}: {
  lenders: readonly { lenderId: string; name: string }[];
  selected: string | undefined;
  path: string;
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
