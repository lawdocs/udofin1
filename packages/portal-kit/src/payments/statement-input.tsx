'use client';

import { useId, useRef, useState, type ChangeEvent } from 'react';
import { LP_STATEMENT_HEADER_SCAN, lpCheckStatementHeader } from './statement.js';

type Check = 'none' | 'ok' | 'bad';

/** The two ways to give a bank statement: a file or pasted text. Both are looked at in the browser, nothing is sent from here. */
export function LpStatementInput() {
  const id = useId();
  const [fileCheck, setFileCheck] = useState<Check>('none');
  const [textCheck, setTextCheck] = useState<Check>('none');
  // A later choice makes an earlier, slower read stale.
  const latest = useRef(0);

  const onFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    latest.current += 1;
    const mine = latest.current;
    if (!file) {
      setFileCheck('none');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (latest.current !== mine) return;
      const head = typeof reader.result === 'string' ? reader.result : '';
      setFileCheck(lpCheckStatementHeader(head).ok ? 'ok' : 'bad');
    };
    reader.onerror = () => {
      if (latest.current === mine) setFileCheck('none');
    };
    reader.readAsText(file.slice(0, LP_STATEMENT_HEADER_SCAN));
  };

  const onText = (event: ChangeEvent<HTMLTextAreaElement>) => {
    const value = event.currentTarget.value;
    setTextCheck(value.trim() === '' ? 'none' : lpCheckStatementHeader(value).ok ? 'ok' : 'bad');
  };

  return (
    <>
      <div className="field">
        <label htmlFor={`${id}-file`}>Statement file (CSV)</label>
        <input
          id={`${id}-file`}
          name="file"
          type="file"
          accept=".csv,text/csv,text/plain"
          onChange={onFile}
          aria-describedby={`${id}-check`}
        />
      </div>
      <div className="field">
        <label htmlFor={`${id}-text`}>Or paste the statement text</label>
        <textarea
          id={`${id}-text`}
          name="csv"
          rows={6}
          autoComplete="off"
          onChange={onText}
          aria-describedby={`${id}-check ${id}-hint`}
        />
        <small id={`${id}-hint`} className="muted">
          Give either a file or pasted text, not both. Do not include names, narrations or account
          numbers.
        </small>
      </div>
      <div id={`${id}-check`} aria-live="polite">
        {fileCheck === 'bad' || textCheck === 'bad' ? (
          <p className="form-error">
            <strong>Problem with the first line.</strong> It does not name exactly the three columns
            valueDate, amountMinor and utr. Any other column makes the server refuse the whole file
            and store nothing. Nothing has been sent yet.
          </p>
        ) : null}
        {fileCheck === 'ok' || textCheck === 'ok' ? (
          <p>
            The first line names the three columns. The server still checks every line and decides.
          </p>
        ) : null}
        {fileCheck !== 'none' && textCheck !== 'none' ? (
          <p className="form-error">
            <strong>Both a file and pasted text are given.</strong> Give only one of them.
          </p>
        ) : null}
      </div>
    </>
  );
}
