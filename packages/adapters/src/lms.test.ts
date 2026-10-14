import { describe, expect, it } from 'vitest';
import {
  createMockLms,
  createUnconfiguredLmsPort,
  isValidIsoDate,
  LMS_IMPORT_FORMAT,
  MOCK_LMS_LOAN_REF,
  MOCK_LMS_UNKNOWN_LOAN_REF,
  normaliseLmsLoan,
  normaliseTimestamp,
  parseLmsImportFile,
  withLmsTimeout,
  type LmsImportError,
  type LmsImportFormatSpec,
  type LmsPort,
  type MockLmsScenario,
} from './index.js';
import { ProviderNotAllowedError, type ProviderCallContext } from './provider.js';

const NOW = new Date('2026-10-14T00:00:00.000Z');
const ctx: ProviderCallContext = { tenantId: 'SAMPLE-TENANT', correlationId: 'SAMPLE-CORR' };

const LOAN_ROW: Record<string, string> = {
  lms_loan_ref: 'SAMPLE-LOAN-0001',
  borrower_ref: 'SAMPLE-APP-0001',
  status: 'active',
  sanctioned_amount: '50000.00',
  disbursed_amount: '50000.00',
  disbursement_ref: 'SAMPLE-DISB-0001',
  disbursement_date: '2026-09-01',
  outstanding_principal: '41666.67',
  next_due_date: '2026-11-05',
  next_due_amount: '4500.00',
  overdue_principal: '0.00',
  overdue_interest: '0.00',
  penal_charges: '0.00',
  other_charges: '0.00',
  total_overdue: '0.00',
  days_past_due: '0',
  source_record_id: 'SAMPLE-REC-0007',
  reported_as_of: '2026-10-13T06:00:00Z',
  sequence: '7',
};

const cell = (value: string): string =>
  /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
function toCsv(rows: readonly Record<string, string>[], header?: readonly string[]): string {
  const columns = header ?? Object.keys(rows[0] ?? {});
  return `${[columns.join(','), ...rows.map((r) => columns.map((c) => cell(r[c] ?? '')).join(','))].join('\n')}\n`;
}

const loanSpec = (
  extra: Partial<LmsImportFormatSpec<'loan'>> = {},
): LmsImportFormatSpec<'loan'> => ({
  format: 'csv',
  kind: 'loan',
  sourceSystem: 'file_import',
  now: NOW,
  ...extra,
});
const parseLoans = (rows: readonly Record<string, string>[], extra = {}) =>
  parseLmsImportFile(toCsv(rows), loanSpec(extra));
const codes = (errors: readonly LmsImportError[]): string[] =>
  errors.map((e) => `${String(e.rowNumber)}:${e.field ?? '-'}:${e.code}`);

describe('LMS import file v1: loan reports', () => {
  it('parses a good CSV into normalised reports with exact paise, provenance and a content hash', () => {
    const second = {
      ...LOAN_ROW,
      lms_loan_ref: 'SAMPLE-LOAN-0002',
      source_record_id: 'SAMPLE-REC-0100',
    };
    const result = parseLoans([LOAN_ROW, second]);
    expect(result.errors).toEqual([]);
    expect(result.formatVersion).toBe(LMS_IMPORT_FORMAT);
    expect(result.fileSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.recordCount).toBe(2);
    expect(result.rows).toHaveLength(2);
    const [row] = result.rows;
    expect(row).toMatchObject({
      reportType: 'loan',
      sourceSystem: 'file_import',
      sourceRecordId: 'SAMPLE-REC-0007',
      reportedAt: '2026-10-13T06:00:00.000Z',
      sequence: 7,
      lmsLoanRef: 'SAMPLE-LOAN-0001',
      borrowerRef: 'SAMPLE-APP-0001',
      status: 'active',
      sanctionedMinor: 5_000_000n,
      disbursedMinor: 5_000_000n,
      disbursementRef: 'SAMPLE-DISB-0001',
      disbursedOn: '2026-09-01',
      outstandingPrincipalMinor: 4_166_667n,
      nextDueOn: '2026-11-05',
      nextDueMinor: 450_000n,
      totalOverdueMinor: 0n,
      daysPastDue: 0,
      flags: [],
    });
    expect(row?.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.contentSha256).not.toBe(result.rows[1]?.contentSha256);
  });

  it('accepts optional fields left empty and a header with only the required columns', () => {
    const minimal = {
      lms_loan_ref: 'SAMPLE-LOAN-0001',
      borrower_ref: 'SAMPLE-APP-0001',
      status: 'closed',
      sanctioned_amount: '50000',
      source_record_id: 'SAMPLE-REC-1',
      reported_as_of: '2026-10-13T06:00:00Z',
    };
    const result = parseLoans([minimal]);
    expect(result.errors).toEqual([]);
    expect(result.rows[0]).toMatchObject({
      disbursedMinor: null,
      nextDueOn: null,
      nextDueMinor: null,
      daysPastDue: null,
      sequence: null,
      status: 'closed',
    });
  });

  it('normalises a zoned timestamp to UTC, so the same instant hashes the same', () => {
    const a = parseLoans([LOAN_ROW]).rows[0];
    const b = parseLoans([{ ...LOAN_ROW, reported_as_of: '2026-10-13T11:30:00+05:30' }]).rows[0];
    expect(b?.reportedAt).toBe('2026-10-13T06:00:00.000Z');
    expect(b?.contentSha256).toBe(a?.contentSha256);
  });

  it('hash covers what the lender said when (reportedAt, sequence) but not the channel', () => {
    const base = parseLoans([LOAN_ROW]).rows[0];
    const later = parseLoans([{ ...LOAN_ROW, reported_as_of: '2026-10-13T07:00:00Z' }]).rows[0];
    const viaManual = parseLmsImportFile(
      toCsv([LOAN_ROW]),
      loanSpec({ sourceSystem: 'manual_import' }),
    ).rows[0];
    expect(later?.contentSha256).not.toBe(base?.contentSha256);
    expect(viaManual?.contentSha256).toBe(base?.contentSha256);
    expect(viaManual?.sourceSystem).toBe('manual_import');
  });

  it('flags, but never fixes, overdue parts that do not add up to the total', () => {
    const result = parseLoans([
      { ...LOAN_ROW, overdue_principal: '10.00', total_overdue: '99.00' },
    ]);
    expect(result.errors).toEqual([]);
    expect(result.rows[0]?.flags).toEqual(['overdue_total_mismatch']);
    expect(result.rows[0]?.totalOverdueMinor).toBe(9_900n);
    expect(result.rows[0]?.overduePrincipalMinor).toBe(1_000n);
  });

  const BAD: readonly (readonly [string, Record<string, string>, string, string])[] = [
    ['empty loan ref', { lms_loan_ref: '' }, 'lms_loan_ref', 'missing_required'],
    ['space in loan ref', { lms_loan_ref: ' SAMPLE' }, 'lms_loan_ref', 'invalid_reference'],
    [
      'formula in loan ref',
      { lms_loan_ref: '=HYPERLINK("x")' },
      'lms_loan_ref',
      'invalid_reference',
    ],
    [
      'PAN as borrower ref',
      { borrower_ref: 'ABCDE1234F' },
      'borrower_ref',
      'borrower_ref_looks_personal',
    ],
    [
      'phone as borrower ref',
      { borrower_ref: '9999900001' },
      'borrower_ref',
      'borrower_ref_looks_personal',
    ],
    [
      '12 digits as borrower ref',
      { borrower_ref: '123412341234' },
      'borrower_ref',
      'borrower_ref_looks_personal',
    ],
    ['name as borrower ref', { borrower_ref: 'Asha Kumar' }, 'borrower_ref', 'invalid_reference'],
    ['e-mail as borrower ref', { borrower_ref: 'a@b.c' }, 'borrower_ref', 'invalid_reference'],
    ['unknown status', { status: 'overdue' }, 'status', 'invalid_status'],
    ['upper-case status', { status: 'ACTIVE' }, 'status', 'invalid_status'],
    ['three decimals', { sanctioned_amount: '1250.555' }, 'sanctioned_amount', 'invalid_amount'],
    ['exponent amount', { sanctioned_amount: '1e3' }, 'sanctioned_amount', 'invalid_amount'],
    ['negative amount', { sanctioned_amount: '-5' }, 'sanctioned_amount', 'invalid_amount'],
    ['separator amount', { sanctioned_amount: '50,000' }, 'sanctioned_amount', 'invalid_amount'],
    ['formula amount', { sanctioned_amount: '=1+1' }, 'sanctioned_amount', 'invalid_amount'],
    ['zero sanctioned', { sanctioned_amount: '0' }, 'sanctioned_amount', 'amount_not_positive'],
    [
      'disbursed above sanctioned',
      { disbursed_amount: '60000' },
      'disbursed_amount',
      'disbursed_exceeds_sanctioned',
    ],
    [
      'partial disbursement evidence',
      { disbursement_ref: '' },
      'disbursed_amount',
      'incomplete_disbursement',
    ],
    ['due date without amount', { next_due_amount: '' }, 'next_due_date', 'incomplete_next_due'],
    ['impossible date', { next_due_date: '2026-02-30' }, 'next_due_date', 'invalid_date'],
    ['slash date', { next_due_date: '05/11/2026' }, 'next_due_date', 'invalid_date'],
    [
      'timestamp without zone',
      { reported_as_of: '2026-10-13T06:00:00' },
      'reported_as_of',
      'invalid_timestamp',
    ],
    [
      'timestamp with space',
      { reported_as_of: '2026-10-13 06:00:00Z' },
      'reported_as_of',
      'invalid_timestamp',
    ],
    [
      'timestamp from the future',
      { reported_as_of: '2026-10-15T06:00:00Z' },
      'reported_as_of',
      'timestamp_in_future',
    ],
    ['missing timestamp', { reported_as_of: '' }, 'reported_as_of', 'missing_required'],
    ['negative days past due', { days_past_due: '-1' }, 'days_past_due', 'invalid_integer'],
    ['fractional days past due', { days_past_due: '1.5' }, 'days_past_due', 'invalid_integer'],
    ['non-numeric sequence', { sequence: 'abc' }, 'sequence', 'invalid_integer'],
    ['missing source record id', { source_record_id: '' }, 'source_record_id', 'missing_required'],
  ];
  it.each(BAD)('rejects the row: %s', (_label, change, field, code) => {
    const result = parseLoans([{ ...LOAN_ROW, ...change }]);
    expect(result.rows).toEqual([]);
    expect(result.errors).toContainEqual({ rowNumber: 1, field, code });
  });

  it('treats formula-looking cells as plain text: never interpreted, never echoed, row refused', () => {
    const evil = "=cmd|' /C calc'!A0";
    const result = parseLoans([
      LOAN_ROW,
      { ...LOAN_ROW, lms_loan_ref: 'SAMPLE-LOAN-0002', source_record_id: evil },
      { ...LOAN_ROW, lms_loan_ref: 'SAMPLE-LOAN-0003', source_record_id: '@SUM(1+1)' },
      { ...LOAN_ROW, lms_loan_ref: 'SAMPLE-LOAN-0004', source_record_id: '+1-1' },
      { ...LOAN_ROW, lms_loan_ref: 'SAMPLE-LOAN-0005', source_record_id: '-2+3' },
    ]);
    expect(result.rows).toHaveLength(1);
    expect(codes(result.errors)).toEqual([
      '2:source_record_id:invalid_reference',
      '3:source_record_id:invalid_reference',
      '4:source_record_id:invalid_reference',
      '5:source_record_id:invalid_reference',
    ]);
    expect(JSON.stringify(result.errors)).not.toContain('calc');
  });

  it('never puts cell values in errors, even for a PAN-like borrower reference', () => {
    const result = parseLoans([
      { ...LOAN_ROW, borrower_ref: 'ABCDE1234F', sanctioned_amount: '12.345' },
    ]);
    const text = JSON.stringify(result.errors);
    expect(text).not.toContain('ABCDE1234F');
    expect(text).not.toContain('12.345');
  });

  it('keeps the first of identical duplicates and reports the rest; rejects conflicting duplicates entirely', () => {
    const dup = parseLoans([LOAN_ROW, LOAN_ROW]);
    expect(dup.rows).toHaveLength(1);
    expect(codes(dup.errors)).toEqual(['2:-:duplicate_row']);

    const conflict = parseLoans([
      LOAN_ROW,
      { ...LOAN_ROW, outstanding_principal: '1.00' },
      { ...LOAN_ROW, lms_loan_ref: 'SAMPLE-LOAN-0002', source_record_id: 'SAMPLE-REC-9' },
    ]);
    expect(conflict.rows.map((r) => r.lmsLoanRef)).toEqual(['SAMPLE-LOAN-0002']);
    expect(codes(conflict.errors)).toEqual([
      '1:-:conflicting_duplicate',
      '2:-:conflicting_duplicate',
    ]);
  });

  it('reports row-level errors without dropping the good rows', () => {
    const result = parseLoans([
      LOAN_ROW,
      {
        ...LOAN_ROW,
        lms_loan_ref: 'SAMPLE-LOAN-0002',
        sanctioned_amount: 'x',
        source_record_id: 'B',
      },
      { ...LOAN_ROW, lms_loan_ref: 'SAMPLE-LOAN-0003', source_record_id: 'C' },
    ]);
    expect(result.rows.map((r) => r.lmsLoanRef)).toEqual(['SAMPLE-LOAN-0001', 'SAMPLE-LOAN-0003']);
    expect(codes(result.errors)).toEqual(['2:sanctioned_amount:invalid_amount']);
  });

  describe('file-level guards', () => {
    const fileError = (text: string, extra = {}) =>
      parseLmsImportFile(text, loanSpec(extra)).errors;
    it('refuses an oversize file and a file with too many records without reading rows', () => {
      const csv = toCsv([LOAN_ROW, { ...LOAN_ROW, source_record_id: 'X' }]);
      expect(fileError(csv, { maxBytes: 100 })).toEqual([
        { rowNumber: 0, field: null, code: 'file_too_large' },
      ]);
      expect(fileError(csv, { maxRows: 1 })).toEqual([
        { rowNumber: 0, field: null, code: 'too_many_rows' },
      ]);
      expect(parseLmsImportFile(csv, loanSpec({ maxBytes: 100 })).rows).toEqual([]);
    });
    it('refuses empty, malformed and mis-headed files', () => {
      expect(fileError('')).toEqual([{ rowNumber: 0, field: null, code: 'empty_file' }]);
      expect(fileError('   \n')).toEqual([{ rowNumber: 0, field: null, code: 'empty_file' }]);
      expect(fileError('lms_loan_ref\n"unterminated')[0]?.code).toBe('malformed_file');
      expect(fileError('lms_loan_ref,lms_loan_ref\na,b\n')[0]?.code).toBe('duplicate_column');
      expect(fileError('lms_loan_ref,balance\na,b\n')[0]?.code).toBe('unknown_column');
      expect(fileError('lms_loan_ref\na\n')).toContainEqual({
        rowNumber: 0,
        field: 'borrower_ref',
        code: 'missing_column',
      });
      expect(fileError('a\u0000b\n')[0]?.code).toBe('malformed_file');
      expect(fileError('lms_loan_ref\r,x\n')[0]?.code).toBe('malformed_file');
    });
    it('flags a row with the wrong number of cells and ignores a BOM and CRLF', () => {
      const header = Object.keys(LOAN_ROW).join(',');
      const full = Object.values(LOAN_ROW).join(',');
      const text = `\uFEFF${header}\r\n${full}\r\nSAMPLE-LOAN-0002,x\r\n`;
      const result = parseLmsImportFile(text, loanSpec());
      expect(result.rows).toHaveLength(1);
      expect(codes(result.errors)).toEqual(['2:-:column_count_mismatch']);
    });
    it('reads quoted cells with commas and doubled quotes as plain text', () => {
      const result = parseLmsImportFile(
        `${Object.keys(LOAN_ROW).join(',')}\n${Object.values({ ...LOAN_ROW, lms_loan_ref: '"A,""B"""' }).join(',')}\n`,
        loanSpec(),
      );
      expect(codes(result.errors)).toEqual(['1:lms_loan_ref:invalid_reference']);
    });
  });
});

describe('LMS import file v1: JSON', () => {
  const jsonSpec = (kind: 'loan' | 'receipt' | 'schedule' = 'loan') =>
    ({ format: 'json', kind, sourceSystem: 'manual_import', now: NOW }) as const;

  it('accepts an array, or an object with records and the format version, with the same fields', () => {
    const array = parseLmsImportFile(JSON.stringify([LOAN_ROW]), jsonSpec());
    const wrapped = parseLmsImportFile(
      JSON.stringify({
        format_version: LMS_IMPORT_FORMAT,
        records: [{ ...LOAN_ROW, sequence: 7, days_past_due: 0 }],
      }),
      jsonSpec(),
    );
    expect(array.errors).toEqual([]);
    expect(wrapped.errors).toEqual([]);
    expect(wrapped.rows[0]?.contentSha256).toBe(array.rows[0]?.contentSha256);
    expect(array.rows[0]?.sourceSystem).toBe('manual_import');
  });

  it('rejects money written as a JSON number (floats are never money), unknown fields and prototype keys', () => {
    const result = parseLmsImportFile(
      JSON.stringify([
        { ...LOAN_ROW, sanctioned_amount: 50000.5 },
        { ...LOAN_ROW, lms_loan_ref: 'B', source_record_id: 'B', balance: '1' },
      ]).replace('"balance"', '"__proto__"'),
      jsonSpec(),
    );
    expect(result.rows).toEqual([]);
    expect(codes(result.errors)).toEqual([
      '1:sanctioned_amount:invalid_amount',
      '2:__proto__:unknown_field',
    ]);
  });

  it('refuses malformed JSON, a wrong wrapper, a wrong version and non-object records', () => {
    const errors = (text: string) => parseLmsImportFile(text, jsonSpec()).errors[0];
    expect(errors('{not json')).toEqual({ rowNumber: 0, field: null, code: 'malformed_file' });
    expect(errors('{"records": [], "extra": 1}')?.code).toBe('malformed_file');
    expect(errors('{"format_version": "v2", "records": [{}]}')?.code).toBe('malformed_file');
    expect(errors('[]')?.code).toBe('empty_file');
    expect(errors('"text"')?.code).toBe('malformed_file');
    expect(parseLmsImportFile('[1, null]', jsonSpec()).errors.map((e) => e.code)).toEqual([
      'malformed_file',
      'malformed_file',
    ]);
  });
});

describe('LMS import file v1: receipts', () => {
  const RECEIPT: Record<string, string> = {
    lms_loan_ref: 'SAMPLE-LOAN-0001',
    lms_receipt_ref: 'SAMPLE-RCPT-0001',
    receipt_kind: 'receipt',
    reverses_receipt_ref: '',
    amount: '4500.00',
    value_date: '2026-10-05',
    payment_mode: 'upi',
    bank_reference: 'SAMPLE-BANKREF-0001',
    source_record_id: 'SAMPLE-RCPT-0001',
    reported_as_of: '2026-10-13T06:00:00Z',
    sequence: '',
  };
  const spec = { format: 'csv', kind: 'receipt', sourceSystem: 'file_import', now: NOW } as const;

  it('parses receipts and reversals as separate positive rows', () => {
    const reversal = {
      ...RECEIPT,
      lms_receipt_ref: 'SAMPLE-RCPT-0002',
      receipt_kind: 'reversal',
      reverses_receipt_ref: 'SAMPLE-RCPT-0001',
      source_record_id: 'SAMPLE-RCPT-0002',
    };
    const result = parseLmsImportFile(toCsv([RECEIPT, reversal]), spec);
    expect(result.errors).toEqual([]);
    expect(result.rows[0]).toMatchObject({
      receiptKind: 'receipt',
      amountMinor: 450_000n,
      reversesReceiptRef: null,
    });
    expect(result.rows[1]).toMatchObject({
      receiptKind: 'reversal',
      amountMinor: 450_000n,
      reversesReceiptRef: 'SAMPLE-RCPT-0001',
    });
  });

  it('enforces the reversal reference rules and a positive amount', () => {
    const run = (change: Record<string, string>) =>
      parseLmsImportFile(toCsv([{ ...RECEIPT, ...change }]), spec).errors;
    expect(run({ receipt_kind: 'reversal' })).toContainEqual({
      rowNumber: 1,
      field: 'reverses_receipt_ref',
      code: 'reversal_reference_invalid',
    });
    expect(run({ reverses_receipt_ref: 'SAMPLE-RCPT-0009' })).toContainEqual({
      rowNumber: 1,
      field: 'reverses_receipt_ref',
      code: 'reversal_reference_invalid',
    });
    expect(
      run({ receipt_kind: 'reversal', reverses_receipt_ref: 'SAMPLE-RCPT-0001' }),
    ).toContainEqual({
      rowNumber: 1,
      field: 'reverses_receipt_ref',
      code: 'reversal_reference_invalid',
    });
    expect(run({ amount: '0' })).toContainEqual({
      rowNumber: 1,
      field: 'amount',
      code: 'amount_not_positive',
    });
    expect(run({ amount: '-45.00' })).toContainEqual({
      rowNumber: 1,
      field: 'amount',
      code: 'invalid_amount',
    });
    expect(run({ receipt_kind: 'refund' })).toContainEqual({
      rowNumber: 1,
      field: 'receipt_kind',
      code: 'invalid_receipt_kind',
    });
    expect(run({ value_date: '2026-13-01' })).toContainEqual({
      rowNumber: 1,
      field: 'value_date',
      code: 'invalid_date',
    });
  });

  it('detects a receipt id repeated with different content', () => {
    const result = parseLmsImportFile(toCsv([RECEIPT, { ...RECEIPT, amount: '1.00' }]), spec);
    expect(result.rows).toEqual([]);
    expect(codes(result.errors)).toEqual([
      '1:-:conflicting_duplicate',
      '2:-:conflicting_duplicate',
    ]);
  });
});

describe('LMS import file v1: schedules', () => {
  const head = {
    lms_loan_ref: 'SAMPLE-LOAN-0001',
    source_record_id: 'SAMPLE-SCH-1',
    reported_as_of: '2026-10-13T06:00:00Z',
    sequence: '3',
  };
  const line = (n: number, due: string) => ({
    ...head,
    installment_seq: String(n),
    due_date: due,
    principal: '4166.67',
    interest: '333.33',
    fees: '0.00',
  });
  const spec = { format: 'csv', kind: 'schedule', sourceSystem: 'file_import', now: NOW } as const;

  it('groups installment rows into one report per loan and source record', () => {
    const result = parseLmsImportFile(
      toCsv([line(1, '2026-11-05'), line(2, '2026-12-05'), line(3, '2027-01-05')]),
      spec,
    );
    expect(result.errors).toEqual([]);
    expect(result.rows).toHaveLength(1);
    expect(
      result.rows[0]?.installments.map((i) => [
        i.sequence,
        i.dueOn,
        i.principalMinor + i.interestMinor + i.feesMinor,
      ]),
    ).toEqual([
      [1, '2026-11-05', 450_000n],
      [2, '2026-12-05', 450_000n],
      [3, '2027-01-05', 450_000n],
    ]);
  });

  it('refuses gaps, repeats and out-of-order dates, pointing at the CSV row', () => {
    const gap = parseLmsImportFile(toCsv([line(1, '2026-11-05'), line(3, '2026-12-05')]), spec);
    expect(gap.rows).toEqual([]);
    expect(codes(gap.errors)).toEqual(['2:installment_seq:invalid_items']);
    const order = parseLmsImportFile(toCsv([line(1, '2026-12-05'), line(2, '2026-11-05')]), spec);
    expect(codes(order.errors)).toEqual(['2:due_date:invalid_items']);
    const bad = parseLmsImportFile(
      toCsv([line(1, '2026-11-05'), { ...line(2, '2026-12-05'), interest: '1.234' }]),
      spec,
    );
    expect(codes(bad.errors)).toEqual(['2:interest:invalid_amount']);
  });

  it('refuses rows of one report that disagree on the head fields', () => {
    const result = parseLmsImportFile(
      toCsv([line(1, '2026-11-05'), { ...line(2, '2026-12-05'), sequence: '4' }]),
      spec,
    );
    expect(codes(result.errors)).toContain('2:-:inconsistent_report_head');
  });

  it('accepts the same schedule as JSON installments', () => {
    const json = JSON.stringify([
      {
        lms_loan_ref: 'SAMPLE-LOAN-0001',
        source_record_id: 'SAMPLE-SCH-1',
        reported_as_of: '2026-10-13T06:00:00Z',
        sequence: '3',
        installments: [
          {
            installment_seq: '1',
            due_date: '2026-11-05',
            principal: '4166.67',
            interest: '333.33',
            fees: '0.00',
          },
        ],
      },
    ]);
    const result = parseLmsImportFile(json, { ...spec, format: 'json' });
    expect(result.errors).toEqual([]);
    expect(result.rows[0]?.installments).toHaveLength(1);
  });
});

describe('date and timestamp helpers', () => {
  it('knows real calendar dates and canonical UTC timestamps', () => {
    expect(isValidIsoDate('2028-02-29')).toBe(true);
    expect(isValidIsoDate('2027-02-29')).toBe(false);
    expect(isValidIsoDate('2026-1-5')).toBe(false);
    expect(normaliseTimestamp('2026-10-13T06:00:00Z')).toBe('2026-10-13T06:00:00.000Z');
    expect(normaliseTimestamp('2026-10-13T06:00:00.5+05:30')).toBe('2026-10-13T00:30:00.500Z');
    expect(normaliseTimestamp('2026-02-30T06:00:00Z')).toBeNull();
    expect(normaliseTimestamp('2026-10-13')).toBeNull();
  });

  it('rejects an invalid source system key outright', () => {
    expect(() => normaliseLmsLoan(LOAN_ROW, { sourceSystem: 'Bad System' })).toThrow(
      'invalid source system key',
    );
  });
});

describe('mock LMS (mock_lms)', () => {
  const loan = (scenario: MockLmsScenario) => createMockLms('test', scenario);

  it('is labelled, read-only, and carries no write method', () => {
    const lms = loan('normal');
    expect(lms.descriptor).toEqual({ key: 'mock_lms', capability: 'lms', mode: 'mock' });
    expect(
      Object.keys(lms).filter((k) => /post|write|update|close|create|submit/i.test(k)),
    ).toEqual([]);
  });

  it('is refused in staging and production, allowed locally and in tests', () => {
    expect(() => createMockLms('production')).toThrow(ProviderNotAllowedError);
    expect(() => createMockLms('staging')).toThrow(/local development and tests only/);
    expect(() => createMockLms('local')).not.toThrow();
    expect(() => createMockLms('test')).not.toThrow();
  });

  it('normal: lists a change, then reports loan, schedule, receipts, quote and documents with provenance', async () => {
    const lms = loan('normal');
    const page = await lms.listChanges(ctx, null);
    expect(page).toMatchObject({
      outcome: 'ok',
      value: { changes: [{ lmsLoanRef: MOCK_LMS_LOAN_REF }], hasMore: false },
    });
    const again = await lms.listChanges(ctx, 'SAMPLE-CURSOR-0001');
    expect(again).toMatchObject({ outcome: 'ok', value: { changes: [] } });
    const report = await lms.fetchLoan(ctx, MOCK_LMS_LOAN_REF);
    expect(report).toMatchObject({
      outcome: 'ok',
      value: {
        sourceSystem: 'mock_lms',
        status: 'active',
        sanctionedMinor: 5_000_000n,
        sequence: 7,
      },
    });
    const schedule = await lms.fetchSchedule(ctx, MOCK_LMS_LOAN_REF);
    expect(schedule.outcome === 'ok' && schedule.value.installments).toHaveLength(3);
    const receipts = await lms.fetchReceipts(ctx, MOCK_LMS_LOAN_REF, null);
    expect(receipts.outcome === 'ok' && receipts.value.receipts).toHaveLength(1);
    const none = await lms.fetchReceipts(ctx, MOCK_LMS_LOAN_REF, 'SAMPLE-CURSOR-0001');
    expect(none.outcome === 'ok' && none.value.receipts).toHaveLength(0);
    const quote = await lms.requestForeclosureQuote(ctx, MOCK_LMS_LOAN_REF, '2026-10-14');
    expect(quote).toMatchObject({
      outcome: 'ok',
      value: { amountMinor: 4_300_000n, lenderQuoteRef: 'SAMPLE-QUOTE-0001' },
    });
    if (quote.outcome === 'ok') {
      // The components are the lender's own figures, reported as they came; the mock adds nothing up for the caller.
      expect(quote.value.components.map((c) => c.amountMinor)).toEqual([
        4_166_667n,
        100_000n,
        33_333n,
      ]);
    }
    const statement = await lms.fetchStatement(ctx, MOCK_LMS_LOAN_REF, {
      from: '2026-09-01',
      to: '2026-09-30',
    });
    expect(statement).toMatchObject({
      outcome: 'ok',
      value: { documentKind: 'statement', mediaType: 'application/pdf' },
    });
    const invalidPeriod = await lms.fetchStatement(ctx, MOCK_LMS_LOAN_REF, {
      from: '2026-10-01',
      to: '2026-09-30',
    });
    expect(invalidPeriod).toEqual({ outcome: 'invalid', reason: 'malformed_report' });
    const closure = await lms.fetchClosureDocuments(ctx, MOCK_LMS_LOAN_REF);
    expect(closure.outcome === 'ok' && closure.value[0]?.documentKind).toBe('no_dues_certificate');
    expect(await lms.fetchLoan(ctx, 'SAMPLE-LOAN-OTHER')).toEqual({ outcome: 'not_found' });
    expect(lms.calls.length).toBeGreaterThan(5);
  });

  it('delayed: the report is old (stale) but valid', async () => {
    const r = await loan('delayed').fetchLoan(ctx, MOCK_LMS_LOAN_REF);
    expect(r.outcome === 'ok' && r.value.reportedAt).toBe('2026-10-08T06:00:00.000Z');
  });

  it('duplicate_report: the same change and receipt are reported twice with identical hashes', async () => {
    const lms = loan('duplicate_report');
    const page = await lms.listChanges(ctx, null);
    expect(page.outcome === 'ok' && page.value.changes).toHaveLength(2);
    const receipts = await lms.fetchReceipts(ctx, MOCK_LMS_LOAN_REF, null);
    expect(receipts.outcome === 'ok' && receipts.value.receipts).toHaveLength(2);
    if (receipts.outcome === 'ok') {
      expect(receipts.value.receipts[0]?.contentSha256).toBe(
        receipts.value.receipts[1]?.contentSha256,
      );
    }
  });

  it('older_sequence: the second fetch carries a lower sequence and an older timestamp', async () => {
    const lms = loan('older_sequence');
    const first = await lms.fetchLoan(ctx, MOCK_LMS_LOAN_REF);
    const second = await lms.fetchLoan(ctx, MOCK_LMS_LOAN_REF);
    expect(first.outcome === 'ok' && first.value.sequence).toBe(7);
    expect(second.outcome === 'ok' && second.value.sequence).toBe(6);
    expect(second.outcome === 'ok' && second.value.reportedAt < '2026-10-13T06:00:00.000Z').toBe(
      true,
    );
  });

  it('status_regression: closed, then active again with a higher sequence (flagged upstream, not here)', async () => {
    const lms = loan('status_regression');
    const first = await lms.fetchLoan(ctx, MOCK_LMS_LOAN_REF);
    const second = await lms.fetchLoan(ctx, MOCK_LMS_LOAN_REF);
    expect(first.outcome === 'ok' && first.value.status).toBe('closed');
    expect(second.outcome === 'ok' && second.value.status).toBe('active');
    expect(second.outcome === 'ok' && second.value.sequence).toBe(8);
  });

  it('unknown_loan: a change names a loan the lender then cannot find', async () => {
    const lms = loan('unknown_loan');
    const page = await lms.listChanges(ctx, null);
    expect(page.outcome === 'ok' && page.value.changes[0]?.lmsLoanRef).toBe(
      MOCK_LMS_UNKNOWN_LOAN_REF,
    );
    expect(await lms.fetchLoan(ctx, MOCK_LMS_UNKNOWN_LOAN_REF)).toEqual({ outcome: 'not_found' });
  });

  it('timeout: every call is an explicit unknown outcome, never an empty report', async () => {
    const lms = loan('timeout');
    const unknown = { outcome: 'unknown', reason: 'timeout' };
    expect(await lms.listChanges(ctx, null)).toEqual(unknown);
    expect(await lms.fetchLoan(ctx, MOCK_LMS_LOAN_REF)).toEqual(unknown);
    expect(await lms.fetchSchedule(ctx, MOCK_LMS_LOAN_REF)).toEqual(unknown);
    expect(await lms.fetchReceipts(ctx, MOCK_LMS_LOAN_REF, null)).toEqual(unknown);
    expect(await lms.requestForeclosureQuote(ctx, MOCK_LMS_LOAN_REF, '2026-10-14')).toEqual(
      unknown,
    );
    expect(await lms.fetchClosureDocuments(ctx, MOCK_LMS_LOAN_REF)).toEqual(unknown);
  });

  it('malformed_amount: the bad amount is refused by the normaliser, never rounded', async () => {
    const lms = loan('malformed_amount');
    const bad = { outcome: 'invalid', reason: 'malformed_report' };
    expect(await lms.fetchLoan(ctx, MOCK_LMS_LOAN_REF)).toEqual(bad);
    expect(await lms.fetchSchedule(ctx, MOCK_LMS_LOAN_REF)).toEqual(bad);
    expect(await lms.fetchReceipts(ctx, MOCK_LMS_LOAN_REF, null)).toEqual(bad);
    expect(await lms.requestForeclosureQuote(ctx, MOCK_LMS_LOAN_REF, '2026-10-14')).toEqual(bad);
  });

  it('is deterministic: two instances give identical reports and hashes', async () => {
    const a = await loan('normal').fetchLoan(ctx, MOCK_LMS_LOAN_REF);
    const b = await loan('normal').fetchLoan(ctx, MOCK_LMS_LOAN_REF);
    expect(a).toEqual(b);
  });
});

describe('unconfigured LMS and timeouts', () => {
  it('an unconfigured port refuses honestly on every method and can never satisfy a production gate', async () => {
    const lms = createUnconfiguredLmsPort();
    expect(lms.descriptor.key).toBe('lms_not_configured');
    expect(Object.values(lms.capabilities).every((v) => !v)).toBe(true);
    const nc = { outcome: 'not_configured' };
    expect(await lms.listChanges(ctx, null)).toEqual(nc);
    expect(await lms.fetchLoan(ctx, 'x')).toEqual(nc);
    expect(await lms.fetchSchedule(ctx, 'x')).toEqual(nc);
    expect(await lms.fetchReceipts(ctx, 'x', null)).toEqual(nc);
    expect(await lms.requestForeclosureQuote(ctx, 'x', '2026-10-14')).toEqual(nc);
    expect(await lms.fetchStatement(ctx, 'x', { from: '2026-10-01', to: '2026-10-02' })).toEqual(
      nc,
    );
    expect(await lms.fetchClosureDocuments(ctx, 'x')).toEqual(nc);
  });

  it('a slow or failing lender becomes unknown, never a hang or an empty report', async () => {
    const slow: LmsPort = {
      ...createUnconfiguredLmsPort(),
      fetchLoan: () => new Promise(() => undefined),
    };
    expect(await withLmsTimeout(slow, 20).fetchLoan(ctx, 'x')).toEqual({
      outcome: 'unknown',
      reason: 'timeout',
    });
    const broken: LmsPort = {
      ...createUnconfiguredLmsPort(),
      listChanges: () => Promise.reject(new Error('boom')),
    };
    expect(await withLmsTimeout(broken, 1000).listChanges(ctx, null)).toEqual({
      outcome: 'unknown',
      reason: 'network',
    });
  });
});
