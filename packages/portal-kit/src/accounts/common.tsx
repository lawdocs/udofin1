import { useId, type ReactNode } from 'react';
import { type FormAction } from '../onboarding/forms.js';
import { SelectField, TextField } from '../onboarding/forms.js';
import { Section } from '../servicing/common.js';
import { type PlatformCaps } from './data.js';
import { type LenderChoice, type ProviderEntry } from './types.js';
import {
  accountsErrorMessage,
  decisionResultWords,
  featureReasonWords,
  reasonCodesFrom,
} from './wording.js';

export { Section };

/** What every operations screen needs: the form actions, where they return to, and who the person is and may be. */
export interface AccountsContext {
  /** The one entry point for allow-listed forms (never the account registration). */
  action: FormAction;
  /** The entry point that serves the account registration only. */
  registerAction: FormAction;
  /** The page the action returns to (an allow-listed operations path). */
  returnTo: string;
  caps: PlatformCaps;
  /** The signed-in person: used to avoid offering a second step to the person who did the first. */
  userId: string;
}

/**
 * The result of the last action, as plain words. The error is a stable code mapped to a sentence, never server text. A refusal
 * that lists unmet prerequisites shows each in words (identifiers that are not on the list are shown as "another reason").
 */
export function AccountsNotice({
  done,
  error,
  result,
  reasons,
}: {
  done?: boolean | undefined;
  error?: string | undefined;
  result?: string | undefined;
  reasons?: string | undefined;
}) {
  if (error) {
    const codes = reasonCodesFrom(reasons);
    return (
      <div role="alert" className="form-error">
        <p>{accountsErrorMessage(error)}</p>
        {codes.length > 0 ? (
          <ul>
            {codes.map((code) => (
              <li key={code}>{featureReasonWords(code)}</li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  }
  const decided = result ? decisionResultWords(result) : null;
  if (decided) return <p role="status">{decided}</p>;
  if (done) return <p role="status">Your action was recorded.</p>;
  return null;
}

const NAV = [
  { href: '/accounts', label: 'Registered accounts' },
  { href: '/accounts/rules', label: 'Format rules and key versions' },
  { href: '/accounts/settlement', label: 'Settlement accounts' },
  { href: '/accounts/merchants', label: 'Merchants' },
] as const;

/** Links between the account registry pages. The current page is named in words, not only by style. */
export function AccountsNav({ current }: { current: (typeof NAV)[number]['href'] }) {
  return (
    <nav aria-label="Account registry pages" className="tabs">
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

/** A lender chosen by name when the list is available, else by its identifier. */
export function LenderField({
  name,
  label,
  lenders,
  defaultValue,
  required,
  hint,
  blank = 'Choose a lender',
}: {
  name: string;
  label: string;
  lenders: readonly LenderChoice[] | null;
  defaultValue?: string | undefined;
  required?: boolean;
  hint?: string;
  blank?: string;
}) {
  if (lenders && lenders.length > 0)
    return (
      <SelectField
        name={name}
        label={label}
        blank={blank}
        options={lenders.map((l) => ({ value: l.id, label: l.name }))}
        defaultValue={defaultValue ?? ''}
        {...(required ? { required } : {})}
      />
    );
  return (
    <TextField
      name={name}
      label={`${label} (its identifier)`}
      defaultValue={defaultValue}
      {...(required ? { required } : {})}
      hint={hint ?? 'The list of lenders could not be read, so type the lender’s identifier.'}
    />
  );
}

/** A provider chosen from the register when it could be read, else typed. */
export function ProviderField({
  name,
  label,
  providers,
  defaultValue,
}: {
  name: string;
  label: string;
  providers: readonly ProviderEntry[] | null;
  defaultValue?: string | undefined;
}) {
  if (providers && providers.length > 0)
    return (
      <SelectField
        name={name}
        label={label}
        blank="Choose a provider"
        required
        options={providers.map((p) => ({ value: p.provider, label: p.displayName }))}
        defaultValue={defaultValue ?? ''}
      />
    );
  return (
    <TextField
      name={name}
      label={`${label} (its key in the register)`}
      defaultValue={defaultValue}
      required
    />
  );
}

/** A password-type field for a number that must never be shown again: no autofill, no spell check, no remembered value. */
export function SecretField({
  name,
  label,
  hint,
  inputMode,
}: {
  name: string;
  label: string;
  hint?: string;
  inputMode?: 'numeric' | 'text';
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        name={name}
        type="password"
        required
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        inputMode={inputMode ?? 'text'}
        data-1p-ignore="true"
        data-lpignore="true"
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

/**
 * The hidden fields every allow-listed form carries: the operation, a request key minted when the page renders (a double click
 * or a retry of the same rendered form is applied once) and the page to return to. `children` holds the visible controls.
 */
export function PlatformForm({
  op,
  action,
  returnTo,
  hidden,
  autoComplete,
  inline,
  children,
}: {
  op?: string;
  action: FormAction;
  returnTo?: string;
  hidden?: Record<string, string | readonly string[]>;
  autoComplete?: 'off';
  inline?: boolean;
  children: ReactNode;
}) {
  return (
    <form
      action={action}
      method="post"
      className={inline ? 'inline' : 'form'}
      encType="multipart/form-data"
      {...(autoComplete ? { autoComplete } : {})}
    >
      {op ? <input type="hidden" name="op" value={op} /> : null}
      <input type="hidden" name="key" value={`ui-${crypto.randomUUID()}`} />
      {returnTo ? <input type="hidden" name="returnTo" value={returnTo} /> : null}
      {Object.entries(hidden ?? {}).flatMap(([name, value]) =>
        (typeof value === 'string' ? [value] : [...value]).map((v) => (
          <input key={`${name}-${v}`} type="hidden" name={name} value={v} />
        )),
      )}
      {children}
    </form>
  );
}

/** Who did a step, in terms of the person looking: never an identifier. */
export function whoWords(actorId: string | null, userId: string): string {
  if (actorId === null) return 'nobody yet';
  return actorId === userId ? 'you' : 'another member of staff';
}

/** Why a second step is not offered to this person. */
export function SecondPerson({ children }: { children: ReactNode }) {
  return <p className="muted">{children}</p>;
}
