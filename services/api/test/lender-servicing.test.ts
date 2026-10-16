// Unit tests for the file-import front end of the lender servicing routes: mapping a normalised report back to an import record
// is lossless (the importer computes the same content hash from the record), a refusal never carries a value, and the request
// contract rejects what it must. The database-backed behaviour is in test/integration/lender-servicing.integration.test.ts.
import {
  parseLmsImportFile,
  type LmsImportError,
  type LmsImportKind,
  type LmsImportReportMap,
} from '@udofin/adapters';
import { LsEvidence, LsImportInput } from '@udofin/contracts';
import { describe, expect, it } from 'vitest';
import {
  auditErrors,
  groupRowErrors,
  toImportRecord,
} from '../src/modules/lender-servicing/routes.js';

const NOW = new Date('2026-10-16T10:00:00.000Z');
const parse = <K extends LmsImportKind>(kind: K, records: unknown[]) =>
  parseLmsImportFile(JSON.stringify(records), {
    format: 'json',
    kind,
    sourceSystem: 'file_import',
    now: NOW,
  });

const loan = {
  lms_loan_ref: 'LN-1',
  borrower_ref: 'APP-1',
  status: 'active',
  sanctioned_amount: '50000.00',
  disbursed_amount: '50000.00',
  disbursement_ref: 'DISB-1',
  disbursement_date: '2026-09-16',
  outstanding_principal: '41666.67',
  next_due_date: '2026-10-26',
  next_due_amount: '4500.5',
  overdue_principal: '0',
  overdue_interest: '0.00',
  penal_charges: '0.00',
  other_charges: '0.00',
  total_overdue: '0.00',
  days_past_due: 0,
  source_record_id: 'SRC-1',
  reported_as_of: '2026-10-16T15:30:00+05:30',
  sequence: 7,
};
const receipt = {
  lms_loan_ref: 'LN-1',
  lms_receipt_ref: 'RC-1',
  receipt_kind: 'receipt',
  amount: '1500.00',
  value_date: '2026-10-15',
  source_record_id: 'SRC-R1',
  reported_as_of: '2026-10-16T09:00:00Z',
};
const reversal = {
  lms_loan_ref: 'LN-1',
  lms_receipt_ref: 'RC-2',
  receipt_kind: 'reversal',
  reverses_receipt_ref: 'RC-1',
  amount: '500.00',
  value_date: '2026-10-16',
  payment_mode: 'upi',
  bank_reference: 'UTR-1',
  source_record_id: 'SRC-R2',
  reported_as_of: '2026-10-16T09:00:00.5Z',
  sequence: '3',
};
const schedule = {
  lms_loan_ref: 'LN-1',
  source_record_id: 'SRC-S1',
  reported_as_of: '2026-10-16T09:00:00Z',
  installments: [
    {
      installment_seq: '1',
      due_date: '2026-11-16',
      principal: '4166.67',
      interest: '333.33',
      fees: '1.5',
    },
    { installment_seq: 2, due_date: '2026-12-16', principal: '4166.67', interest: '333.33' },
  ],
};

describe('toImportRecord', () => {
  const cases: [LmsImportKind, unknown[]][] = [
    ['loan', [loan]],
    ['receipt', [receipt, reversal]],
    ['schedule', [schedule]],
  ];

  it.each(cases)(
    'maps %s reports back to records that carry the same content hash',
    (kind, records) => {
      const parsed = parse(kind, records);
      expect(parsed.importable).toBe(true);
      const mapped = parsed.rows.map((r: LmsImportReportMap[LmsImportKind]) => toImportRecord(r));
      const again = parse(kind, mapped);
      expect(again.importable).toBe(true);
      expect(again.rows.map((r) => r.contentSha256)).toEqual(
        parsed.rows.map((r) => r.contentSha256),
      );
    },
  );

  it('writes money as decimal rupee text, times in UTC and nothing that is absent', () => {
    const [report] = parse('loan', [loan]).rows;
    if (!report) throw new Error('no report');
    const record = toImportRecord(report);
    expect(record).toMatchObject({
      sanctioned_amount: '50000.00',
      next_due_amount: '4500.50',
      overdue_principal: '0.00',
      reported_as_of: '2026-10-16T10:00:00.000Z',
      days_past_due: 0,
      sequence: 7,
    });
    const minimal = parse('loan', [
      {
        lms_loan_ref: 'LN-2',
        borrower_ref: 'APP-2',
        status: 'closed',
        sanctioned_amount: '1.00',
        source_record_id: 'SRC-2',
        reported_as_of: '2026-10-16T09:00:00Z',
      },
    ]).rows[0];
    if (!minimal) throw new Error('no report');
    expect(Object.keys(toImportRecord(minimal)).sort()).toEqual([
      'borrower_ref',
      'lms_loan_ref',
      'reported_as_of',
      'sanctioned_amount',
      'source_record_id',
      'status',
    ]);
  });

  it('defaults an absent installment fee to zero, as the importer does', () => {
    const [report] = parse('schedule', [schedule]).rows;
    if (!report) throw new Error('no report');
    const record = toImportRecord(report) as { installments: Record<string, unknown>[] };
    expect(record.installments.map((i) => i.fees)).toEqual(['1.50', '0.00']);
    expect(record.installments.map((i) => i.installment_seq)).toEqual([1, 2]);
  });
});

describe('what a refusal may carry', () => {
  const error = (over: Partial<LmsImportError>): LmsImportError => ({
    rowNumber: 1,
    field: null,
    code: 'invalid_amount',
    ...over,
  });

  it('keeps the position, the class and a field name of the format; drops anything else', () => {
    expect(
      auditErrors([
        error({ rowNumber: 3, field: 'sanctioned_amount' }),
        error({ rowNumber: 4, field: 'a field the caller invented' }),
        error({ rowNumber: -1, field: null }),
        error({ rowNumber: 2, code: 'invalid_validity' }),
        error({ rowNumber: 0, field: 'format_version', code: 'malformed_file' }),
      ]),
    ).toEqual([
      { row_no: 3, code: 'invalid_amount', field: 'sanctioned_amount' },
      { row_no: 4, code: 'invalid_amount', field: null },
      { row_no: 0, code: 'invalid_amount', field: null },
      { row_no: 2, code: 'malformed_file', field: null },
      { row_no: 0, code: 'malformed_file', field: null },
    ]);
  });

  it('caps the list at 1,000 entries and says so when grouping', () => {
    const many = Array.from({ length: 1500 }, (_, n) => error({ rowNumber: n + 1 }));
    expect(auditErrors(many)).toHaveLength(1000);
    const grouped = groupRowErrors(many);
    expect(grouped.rows).toHaveLength(1000);
    expect(grouped.truncated).toBe(true);
    expect(groupRowErrors(many.slice(0, 10)).truncated).toBe(false);
  });

  it('groups the errors of a row, sorted, as the database lists them', () => {
    const grouped = groupRowErrors([
      error({ rowNumber: 5, code: 'invalid_date', field: 'value_date' }),
      error({ rowNumber: 2, code: 'invalid_amount', field: 'amount' }),
      error({ rowNumber: 5, code: 'invalid_amount', field: 'amount' }),
      error({ rowNumber: 0, code: 'unknown_column' }),
    ]);
    expect(grouped.rows).toEqual([
      { rowNo: 0, outcome: 'error', errorCodes: ['unknown_column'], fieldNames: [] },
      { rowNo: 2, outcome: 'error', errorCodes: ['invalid_amount'], fieldNames: ['amount'] },
      {
        rowNo: 5,
        outcome: 'error',
        errorCodes: ['invalid_amount', 'invalid_date'],
        fieldNames: ['amount', 'value_date'],
      },
    ]);
  });
});

describe('request contracts', () => {
  const base = {
    lenderId: '0198f3a0-0000-7000-8000-000000000001',
    kind: 'loan',
    sourceKind: 'file',
    formatVersion: 'udofin-lms-import-v1',
  };

  it('needs exactly one of content and rows, a format for content, and JSON records for rows', () => {
    const ok = [
      { ...base, content: '[]', fileFormat: 'json' },
      { ...base, content: 'a,b', fileFormat: 'csv' },
      { ...base, rows: [{ a: 'b' }] },
      { ...base, rows: [{ a: 'b' }], fileFormat: 'json' },
    ];
    for (const body of ok) expect(LsImportInput.safeParse(body).success).toBe(true);
    const bad = [
      { ...base },
      { ...base, content: '[]' },
      { ...base, content: '[]', fileFormat: 'json', rows: [{ a: 'b' }] },
      { ...base, rows: [{ a: 'b' }], fileFormat: 'csv' },
      { ...base, rows: [] },
      { ...base, content: '', fileFormat: 'json' },
      { ...base, content: '[]', fileFormat: 'json', extra: true },
      { ...base, content: '[]', fileFormat: 'json', formatVersion: 'v2' },
      { ...base, content: '[]', fileFormat: 'xml' },
    ];
    for (const body of bad) expect(LsImportInput.safeParse(body).success).toBe(false);
  });

  it('accepts flat references as evidence and nothing else', () => {
    expect(LsEvidence.safeParse({ review_ref: 'REV-1', second_ref: 'x' }).success).toBe(true);
    for (const bad of [
      {},
      { Review: 'x' },
      { review_ref: '' },
      { review_ref: 1 },
      { review_ref: { nested: 'x' } },
      Object.fromEntries(Array.from({ length: 21 }, (_, n) => [`ref_${String(n + 10)}`, 'x'])),
    ])
      expect(LsEvidence.safeParse(bad).success).toBe(false);
  });
});
