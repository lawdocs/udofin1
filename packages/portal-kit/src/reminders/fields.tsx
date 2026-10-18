import { type ReactNode, useId } from 'react';

// Labelled form controls for the reminder and payment-setup screens. Every control has a visible label, hints are tied to the
// control with aria-describedby, and ids come from useId so a server render and the browser agree. Nothing is pre-filled or
// pre-ticked unless the screen is showing a value the person typed a moment ago.

const Hint = ({ id, hint }: { id: string; hint: string | undefined }) =>
  hint ? (
    <small id={`${id}-hint`} className="muted">
      {hint}
    </small>
  ) : null;

export function TextInput({
  name,
  label,
  defaultValue,
  type = 'text',
  required,
  hint,
  maxLength,
  inputMode,
  pattern,
}: {
  name: string;
  label: string;
  defaultValue?: string | undefined;
  type?: 'text' | 'time' | 'number';
  required?: boolean;
  hint?: string;
  maxLength?: number;
  inputMode?: 'numeric' | 'decimal' | 'text';
  /** A browser-side shape check. The hint is the explanation the browser shows with it. */
  pattern?: string;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        name={name}
        type={type}
        defaultValue={defaultValue ?? ''}
        required={required}
        autoComplete="off"
        spellCheck={false}
        maxLength={maxLength}
        inputMode={inputMode}
        pattern={pattern}
        title={pattern ? hint : undefined}
        aria-describedby={hint ? `${id}-hint` : undefined}
      />
      <Hint id={id} hint={hint} />
    </div>
  );
}

export function TextArea({
  name,
  label,
  defaultValue,
  required,
  hint,
  rows = 5,
  maxLength,
}: {
  name: string;
  label: string;
  defaultValue?: string | undefined;
  required?: boolean;
  hint?: string;
  rows?: number;
  maxLength?: number;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <textarea
        id={id}
        name={name}
        rows={rows}
        defaultValue={defaultValue ?? ''}
        required={required}
        maxLength={maxLength}
        aria-describedby={hint ? `${id}-hint` : undefined}
      />
      <Hint id={id} hint={hint} />
    </div>
  );
}

export function SelectInput({
  name,
  label,
  options,
  defaultValue,
  blank,
  required,
  hint,
}: {
  name: string;
  label: string;
  options: readonly { value: string; label: string }[];
  defaultValue?: string | undefined;
  /** An empty first choice. A required select with a blank first choice forces the person to choose. */
  blank?: string;
  required?: boolean;
  hint?: string;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        name={name}
        defaultValue={defaultValue ?? ''}
        required={required}
        aria-describedby={hint ? `${id}-hint` : undefined}
      >
        {blank !== undefined ? <option value="">{blank}</option> : null}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <Hint id={id} hint={hint} />
    </div>
  );
}

/**
 * One tick box. It is NEVER ticked unless the screen is showing a choice the person made a moment ago: a statement or
 * attestation is the person's own act.
 */
export function CheckInput({
  name,
  value = 'on',
  label,
  checked,
  required,
  hint,
}: {
  name: string;
  value?: string;
  label: string;
  checked?: boolean | undefined;
  required?: boolean;
  hint?: string;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          name={name}
          value={value}
          defaultChecked={checked === true}
          required={required}
          aria-describedby={hint ? `${id}-hint` : undefined}
        />{' '}
        {label}
      </label>
      <Hint id={id} hint={hint} />
    </div>
  );
}

/** A group of related controls with its own name for screen readers. */
export function Group({ legend, children }: { legend: string; children: ReactNode }) {
  return (
    <fieldset>
      <legend>{legend}</legend>
      {children}
    </fieldset>
  );
}
