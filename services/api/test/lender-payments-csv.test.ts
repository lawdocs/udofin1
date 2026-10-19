// The bank statement parser of POST /v1/lender/reconciliation/bank-credits. Pure functions: no database. A narration may carry a
// name, so the parser accepts exactly three columns and refuses the WHOLE upload at the first problem, naming a rule and a line but
// never a value from the file.
import { LP_BANK_CREDIT_MAX_ROWS } from '@udofin/contracts';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/http/api-error.js';
import { parseBankCreditsCsv } from '../src/modules/lender-payments/routes.js';

const HEADER = 'valueDate,amountMinor,utr';
const NAME = 'RAMESH-KUMAR-SHARMA';

function refusal(csv: string): ApiError {
  try {
    parseBankCreditsCsv(csv);
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('the upload was accepted');
}

describe('parseBankCreditsCsv', () => {
  it('reads the three columns into rows with integer paise', () => {
    expect(
      parseBankCreditsCsv(`${HEADER}\n2026-10-15,250000,UTR0000001\n2026-10-16,1,BANK-REF.2/x\n`),
    ).toEqual([
      { valueDate: '2026-10-15', amountMinor: 250_000, utr: 'UTR0000001' },
      { valueDate: '2026-10-16', amountMinor: 1, utr: 'BANK-REF.2/x' },
    ]);
  });

  it('accepts any order of the columns, CRLF line ends, a byte-order mark and no final newline', () => {
    const rows = parseBankCreditsCsv(
      `\uFEFFutr,valueDate,amountMinor\r\nUTR0000001,2026-10-15,500\r\nUTR0000002,2026-10-16,600`,
    );
    expect(rows).toEqual([
      { valueDate: '2026-10-15', amountMinor: 500, utr: 'UTR0000001' },
      { valueDate: '2026-10-16', amountMinor: 600, utr: 'UTR0000002' },
    ]);
  });

  it('refuses any column other than the three, and says so without naming it', () => {
    for (const header of [
      `${HEADER},narration`,
      `${HEADER},${NAME}`,
      `narration,${HEADER}`,
      'valueDate,amountMinor,utr2',
    ]) {
      const error = refusal(`${header}\n2026-10-15,1000,UTR0000001,${NAME}\n`);
      expect([header, error.status, error.code]).toEqual([header, 422, 'unexpected_field']);
      expect(JSON.stringify(error)).not.toContain(NAME);
      expect(error.detail ?? '').not.toContain('narration');
    }
  });

  it('refuses a header that does not name each column exactly once', () => {
    for (const header of [
      'valueDate,amountMinor',
      'valueDate,valueDate,utr',
      'valueDate,amountMinor,utr,',
      ' valueDate,amountMinor,utr',
      'VALUEDATE,AMOUNTMINOR,UTR',
      '',
    ]) {
      const error = refusal(`${header}\n2026-10-15,1000,UTR0000001\n`);
      expect([header, error.status]).toEqual([header, 422]);
    }
  });

  it('refuses a file with no credits', () => {
    expect(refusal(HEADER).status).toBe(422);
    expect(refusal(`${HEADER}\n`).status).toBe(422);
    expect(refusal('').status).toBe(422);
  });

  it('refuses quotes, escapes, NUL characters, blank lines and the wrong number of fields', () => {
    const cases: string[] = [
      `${HEADER}\n2026-10-15,"1000",UTR0000001\n`,
      `${HEADER}\n2026-10-15,1000,"${NAME}"\n`,
      `${HEADER}\n2026-10-15,1000\n`,
      `${HEADER}\n2026-10-15,1000,UTR0000001,${NAME}\n`,
      `${HEADER}\n2026-10-15,1000,UTR0000001\n\n2026-10-16,1000,UTR0000002\n`,
      `${HEADER}\n2026-10-15,1000,UTR0000001\0\n`,
      `${HEADER}\r2026-10-15,1000,UTR0000001\r`,
    ];
    for (const csv of cases) {
      const error = refusal(csv);
      expect(error.status).toBe(422);
      expect(JSON.stringify(error)).not.toContain(NAME);
    }
  });

  it('refuses bad values by line and field and never echoes the value', () => {
    const bad: [string, string][] = [
      ['2026-10-15,ABCDEF,UTR0000001', 'amountMinor'],
      ['2026-10-15,-5,UTR0000001', 'amountMinor'],
      ['2026-10-15,007,UTR0000001', 'amountMinor'],
      ['2026-10-15,1.50,UTR0000001', 'amountMinor'],
      ['2026-10-15,0,UTR0000001', 'amountMinor'],
      ['2026-10-15,1000000000000000,UTR0000001', 'amountMinor'],
      ['15/10/2026,1000,UTR0000001', 'valueDate'],
      ['2026-10-15,1000,AB1', 'utr'],
      [`2026-10-15,1000,${'X'.repeat(61)}`, 'utr'],
    ];
    for (const [line, field] of bad) {
      const error = refusal(`${HEADER}\n2026-10-14,1000,UTR0000000\n${line}\n`);
      expect([line, error.status, error.code]).toEqual([line, 422, 'row_invalid']);
      expect(error.detail).toContain('line 3');
      expect(error.detail).toContain(field);
      for (const part of line.split(','))
        if (part.length > 4) expect(error.detail ?? '').not.toContain(part);
    }
  });

  it('refuses the whole file when one line is bad, even the last one', () => {
    const lines = Array.from(
      { length: 5 },
      (_, n) => `2026-10-15,${String(1000 + n)},UTR000000${String(n)}`,
    );
    const error = refusal([HEADER, ...lines, '2026-10-15,x,UTR0000009'].join('\n'));
    expect(error.status).toBe(422);
    expect(error.detail).toContain('line 7');
  });

  it('accepts as many credits as the database does and refuses one more', () => {
    const rows = (n: number) =>
      [
        HEADER,
        ...Array.from(
          { length: n },
          (_, i) => `2026-10-15,${String(1000 + i)},BIG${String(i).padStart(6, '0')}`,
        ),
      ].join('\n');
    expect(parseBankCreditsCsv(rows(LP_BANK_CREDIT_MAX_ROWS))).toHaveLength(
      LP_BANK_CREDIT_MAX_ROWS,
    );
    expect(refusal(rows(LP_BANK_CREDIT_MAX_ROWS + 1)).code).toBe('rows_invalid');
  });
});
