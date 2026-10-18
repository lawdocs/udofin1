'use client';

import { LS_IMPORT_FILE_FORMATS, LS_IMPORT_KINDS } from '@udofin/contracts';
import { useActionState, useId } from 'react';
import { formatCount } from './format.js';
import { type StageState } from './data.js';
import { IMPORT_MAX_BYTES, IMPORT_MAX_RECORDS } from './operations.js';
import { RefusedFile } from './import-errors.js';
import { importKindWords, servicingErrorMessage } from './wording.js';

export type StageAction = (previous: StageState, form: FormData) => Promise<StageState>;

export interface StageFormProps {
  /** The server action that stages the file. On success it redirects to the preview; otherwise it answers with what to show. */
  action: StageAction;
  /** Lenders in which the person may upload. */
  lenders: readonly { id: string; name: string }[];
  /** Earlier invalid, discarded or failed files this upload may correct. */
  corrections: readonly { id: string; label: string }[];
  /** A correction chosen on arrival (from a link on the preview page). */
  correctionOf?: string | undefined;
}

const FORMAT_WORDS: Readonly<Record<string, string>> = {
  csv: 'CSV (comma separated)',
  json: 'JSON',
};

/**
 * Uploads one import file. The browser sends the file to the portal's server action, which reads it as text and posts it to
 * the API. Every submission mints a fresh request key, so correcting a file and sending it again is a new request (the same
 * file twice is recognised by its SHA-256 instead). The answer is shown here: a file the importer refuses has no preview page.
 */
export function ImportStageForm({ action, lenders, corrections, correctionOf }: StageFormProps) {
  const id = useId();
  const [state, run, pending] = useActionState<StageState, FormData>(
    (previous, form) => {
      form.set('key', `ui-${crypto.randomUUID()}`);
      return action(previous, form);
    },
    { status: 'idle' },
  );
  const only = lenders.length === 1 ? lenders[0] : undefined;
  return (
    <div>
      <form action={run} className="form" encType="multipart/form-data" aria-busy={pending}>
        <input type="hidden" name="op" value="servicing.import.stage" />
        <input type="hidden" name="key" value="ui-placeholder-replaced-on-submit" />
        <input type="hidden" name="returnTo" value="/imports" />
        {only ? (
          <>
            <input type="hidden" name="lenderId" value={only.id} />
            <p>
              Lender: <strong>{only.name}</strong>
            </p>
          </>
        ) : (
          <div className="field">
            <label htmlFor={`${id}-lender`}>Lender</label>
            <select id={`${id}-lender`} name="lenderId" required defaultValue="">
              <option value="" disabled>
                Choose a lender
              </option>
              {lenders.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="field">
          <label htmlFor={`${id}-kind`}>What the file contains</label>
          <select id={`${id}-kind`} name="kind" required defaultValue="loan">
            {LS_IMPORT_KINDS.map((k) => (
              <option key={k} value={k}>
                {importKindWords(k)}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${id}-format`}>File format</label>
          <select id={`${id}-format`} name="fileFormat" required defaultValue="csv">
            {LS_IMPORT_FILE_FORMATS.map((f) => (
              <option key={f} value={f}>
                {FORMAT_WORDS[f] ?? f}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${id}-file`}>File (UTF-8 text)</label>
          <input
            id={`${id}-file`}
            name="file"
            type="file"
            accept=".csv,.json,text/csv,application/json,text/plain"
            required
            aria-describedby={`${id}-file-hint`}
          />
          <small id={`${id}-file-hint`} className="muted">
            At most {formatCount(IMPORT_MAX_BYTES / (1024 * 1024))} MiB and{' '}
            {formatCount(IMPORT_MAX_RECORDS)} records in one file, one kind of record per file.
            Amounts are rupees written as text, for example 1250.50. A borrower reference must be
            your own opaque reference, never a name, phone number, PAN, Aadhaar or account number.
          </small>
        </div>
        {corrections.length > 0 ? (
          <div className="field">
            <label htmlFor={`${id}-correction`}>
              This file corrects an earlier file (optional)
            </label>
            <select id={`${id}-correction`} name="resubmissionOf" defaultValue={correctionOf ?? ''}>
              <option value="">No, this is a new file</option>
              {corrections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <button type="submit" disabled={pending}>
          {pending ? 'Checking the file…' : 'Check the file and show a preview'}
        </button>
      </form>
      <div aria-live="polite">
        {state.status === 'error' ? (
          <p role="alert" className="form-error">
            {servicingErrorMessage(state.code)}
          </p>
        ) : null}
        {state.status === 'refused' ? <RefusedFile state={state} /> : null}
      </div>
    </div>
  );
}
