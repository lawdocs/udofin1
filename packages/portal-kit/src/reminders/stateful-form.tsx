'use client';

import { type ReactNode, useActionState } from 'react';

/** What a form action answers: done (with anything the screen must show once), or a stable error code. */
export type FormOutcome<R extends object = Record<string, never>> =
  { ok: true; result?: R } | { ok: false; code: string };

export type FormRun<R extends object = Record<string, never>> = (
  form: FormData,
) => Promise<FormOutcome<R>>;

/** What the person typed in the last attempt, by field name, so a refused form keeps their text. */
export type Typed = Readonly<Record<string, readonly string[]>>;

export const typedFirst = (typed: Typed, name: string): string | undefined => typed[name]?.[0];
export const typedHas = (typed: Typed, name: string, value = 'on'): boolean =>
  typed[name]?.includes(value) === true;

type State<R extends object> =
  | { status: 'idle'; typed: Typed }
  | { status: 'error'; code: string; typed: Typed }
  | { status: 'done'; result: R | undefined; typed: Typed };

const SKIPPED_FIELDS = new Set(['op', 'key', 'returnTo']);
const NONE: Typed = {};

function typedFrom(form: FormData): Typed {
  const out: Record<string, string[]> = {};
  for (const [name, value] of form.entries()) {
    if (typeof value !== 'string' || SKIPPED_FIELDS.has(name)) continue;
    (out[name] ??= []).push(value);
  }
  return out;
}

/**
 * A form that sends one allow-listed operation to a server action and keeps what the person typed when the answer is a refusal
 * (React would otherwise empty the form). Every submission mints a fresh request key, so correcting a refused form and sending
 * it again is a new request, while a double click is stopped by the disabled button. Nothing the server said is shown: an error
 * code is mapped to a sentence by `errorMessage`.
 *
 * When the outcome carries a result (for example something shown only once), `renderResult` draws it from the form's own state:
 * it is not put in a URL, a cookie or storage.
 */
export function StatefulForm<R extends object = Record<string, never>>({
  op,
  action,
  returnTo,
  hidden,
  submit,
  pendingLabel = 'Sending…',
  doneMessage = 'Your action was recorded.',
  errorMessage,
  fields,
  renderResult,
}: {
  op: string;
  action: FormRun<R>;
  returnTo: string;
  hidden?: Record<string, string>;
  submit: string;
  pendingLabel?: string;
  doneMessage?: string;
  errorMessage: (code: string) => string;
  /** The controls, drawn with the text typed in the last refused attempt. */
  fields: (typed: Typed) => ReactNode;
  renderResult?: (result: R) => ReactNode;
}) {
  const [state, run, pending] = useActionState<State<R>, FormData>(
    async (_previous, form) => {
      form.set('key', `ui-${crypto.randomUUID()}`);
      const typed = typedFrom(form);
      const outcome = await action(form);
      return outcome.ok
        ? { status: 'done', result: outcome.result, typed: NONE }
        : { status: 'error', code: outcome.code, typed };
    },
    { status: 'idle', typed: NONE },
  );
  return (
    <div>
      <form action={run} className="form" aria-busy={pending}>
        <input type="hidden" name="op" value={op} />
        <input type="hidden" name="key" value="ui-placeholder-replaced-on-submit" />
        <input type="hidden" name="returnTo" value={returnTo} />
        {Object.entries(hidden ?? {}).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
        {fields(state.typed)}
        <button type="submit" disabled={pending}>
          {pending ? pendingLabel : submit}
        </button>
      </form>
      <div aria-live="polite">
        {state.status === 'error' ? (
          <p role="alert" className="form-error">
            {errorMessage(state.code)}
          </p>
        ) : null}
        {state.status === 'done' ? <p role="status">{doneMessage}</p> : null}
        {state.status === 'done' && state.result !== undefined && renderResult
          ? renderResult(state.result)
          : null}
      </div>
    </div>
  );
}
