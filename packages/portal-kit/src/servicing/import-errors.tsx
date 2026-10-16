import { type LsImportRowError } from '@udofin/contracts';
import { type StageState } from './data.js';
import { formatCount } from './format.js';
import { importErrorWords, importFieldName, rowOutcomeWords } from './wording.js';

const MAX_LISTED = 1000;

/**
 * The row-level problems of a file: where, what kind and which column. Never a value from the file; the API does not send
 * one. Row 0 means the problem is with the file as a whole (for example a missing column).
 */
export function RowErrorsTable({
  errors,
  truncated,
}: {
  errors: readonly LsImportRowError[];
  truncated: boolean;
}) {
  if (errors.length === 0) return null;
  return (
    <div>
      <table>
        <caption>Problems found, by row</caption>
        <thead>
          <tr>
            <th scope="col">Row</th>
            <th scope="col">Kind</th>
            <th scope="col">What is wrong</th>
            <th scope="col">Column</th>
          </tr>
        </thead>
        <tbody>
          {errors.map((e) => (
            <tr key={`${String(e.rowNo)}-${e.outcome}`}>
              <th scope="row">{e.rowNo === 0 ? 'Whole file' : formatCount(e.rowNo)}</th>
              <td>{rowOutcomeWords(e.outcome)}</td>
              <td>
                <ul>
                  {e.errorCodes.map((code) => (
                    <li key={code}>{importErrorWords(code)}</li>
                  ))}
                </ul>
              </td>
              <td>
                {e.fieldNames.length === 0
                  ? '—'
                  : e.fieldNames.map((name) => importFieldName(name)).join(', ')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {truncated ? (
        <p role="note">
          Only the first {formatCount(MAX_LISTED)} problem rows are listed. Correct these and upload
          the file again to see the rest.
        </p>
      ) : null}
    </div>
  );
}

/**
 * A file the importer could not accept at all. There is no preview page because nothing reached the import tables; the
 * attempt is recorded as an audit entry (file hash, size, positions and kinds of problem, no values).
 */
export function RefusedFile({ state }: { state: Extract<StageState, { status: 'refused' }> }) {
  return (
    <section role="alert" className="state state-error">
      <h3>The file was not accepted and nothing was applied</h3>
      <p>
        The file ({formatCount(state.byteSize)} bytes, {formatCount(state.recordCount)} records
        found) could not be read as the import format. It was not stored. Only its fingerprint, its
        size and the kinds of problem were recorded in the audit log, with no values from the file.
      </p>
      <RowErrorsTable errors={state.errors} truncated={state.errorsTruncated} />
      <p>Correct the file and choose it again.</p>
    </section>
  );
}
