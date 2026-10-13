import { type ReactNode } from 'react';

export type FormAction = (formData: FormData) => void | Promise<void>;

/**
 * A form that names one allow-listed operation. The key is minted when the page renders, so a
 * double click or retry of the same rendered form is applied once (the API replays the result).
 */
export function OpForm({
  op,
  action,
  returnTo,
  hidden,
  submit,
  secondary,
  inline,
  children,
}: {
  op: string;
  action: FormAction;
  returnTo: string;
  hidden?: Record<string, string>;
  submit: string;
  secondary?: boolean;
  inline?: boolean;
  children?: ReactNode;
}) {
  return (
    <form action={action} className={inline ? 'inline' : 'form'} encType="multipart/form-data">
      <input type="hidden" name="op" value={op} />
      <input type="hidden" name="key" value={`ui-${crypto.randomUUID()}`} />
      <input type="hidden" name="returnTo" value={returnTo} />
      {Object.entries(hidden ?? {}).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      {children}
      <button type="submit" className={secondary ? 'secondary' : undefined}>
        {submit}
      </button>
    </form>
  );
}

let counter = 0;
const nextId = (name: string) => `f-${name}-${String(counter++)}`;

export function TextField({
  name,
  label,
  defaultValue,
  type = 'text',
  required,
  hint,
}: {
  name: string;
  label: string;
  defaultValue?: string | null;
  type?: 'text' | 'date' | 'number' | 'datetime-local';
  required?: boolean;
  hint?: string;
}) {
  const id = nextId(name);
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

export function AreaField({
  name,
  label,
  defaultValue,
  required,
  hint,
}: {
  name: string;
  label: string;
  defaultValue?: string | null;
  required?: boolean;
  hint?: string;
}) {
  const id = nextId(name);
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <textarea
        id={id}
        name={name}
        rows={3}
        defaultValue={defaultValue ?? ''}
        required={required}
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

export function SelectField({
  name,
  label,
  options,
  defaultValue,
  blank,
  required,
}: {
  name: string;
  label: string;
  options: readonly { value: string; label: string }[];
  defaultValue?: string | null;
  /** Adds an empty choice that leaves the stored value unchanged. */
  blank?: string;
  required?: boolean;
}) {
  const id = nextId(name);
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} name={name} defaultValue={defaultValue ?? ''} required={required}>
        {blank !== undefined ? <option value="">{blank}</option> : null}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}
