/**
 * The header check of a bank statement, shared by the browser (an early warning while the person chooses a file) and the
 * portal's server action (the same check again before anything is sent). It has no imports so the browser bundle stays small.
 * The API repeats this rule and every other rule on every line, and its answer is the one that counts.
 */

/** The only columns a statement may have. Any other column makes the API refuse the whole file. */
export const LP_STATEMENT_COLUMNS = ['valueDate', 'amountMinor', 'utr'] as const;

/** How much of a file the browser reads to look at the first line. A header longer than this cannot be the three columns. */
export const LP_STATEMENT_HEADER_SCAN = 4096;

/** The header check of a bank statement: exactly the three columns valueDate, amountMinor and utr, in any order. */
export function lpCheckStatementHeader(csv: string): { ok: true } | { ok: false } {
  const text = csv.charCodeAt(0) === 0xfeff ? csv.slice(1) : csv;
  const header = text.split('\n', 1)[0]?.replace(/\r$/, '') ?? '';
  const columns = header.split(',').map((column) => column.trim());
  const exact =
    columns.length === LP_STATEMENT_COLUMNS.length &&
    LP_STATEMENT_COLUMNS.every((name) => columns.filter((column) => column === name).length === 1);
  return exact ? { ok: true } : { ok: false };
}
