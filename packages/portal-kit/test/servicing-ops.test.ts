// @vitest-environment node
// Logic of the lender servicing screens that needs no browser: formatting, wording, queries, loaders, the allow-listed
// operations and the guards around them. The server runtime (a real File, FormData and Web Crypto) is what these run on.
import {
  LS_ANOMALY_KINDS,
  LS_ANOMALY_SEVERITIES,
  LS_BATCH_STATUSES,
  LS_CAPABILITY_KEYS,
  LS_CLOSURE_KINDS,
  LS_COLLATERAL_TYPES,
  LS_CONFLICT_REASONS,
  LS_CONFLICT_RECORD_TYPES,
  LS_CONFLICT_STATUSES,
  LS_CONFLICT_VERSIONS,
  LS_CONNECTION_KINDS,
  LS_CONNECTION_STATUSES,
  LS_DOCUMENT_KINDS,
  LS_DOCUMENT_SOURCES,
  LS_IMPORT_KINDS,
  LS_LOAN_STATUSES,
  LS_QUOTE_SOURCES,
  LS_RELEASE_STATUSES,
  LS_REQUEST_STATUSES,
  LS_ROW_ERROR_OUTCOMES,
  LsImportOutcome,
} from '@udofin/contracts';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { type OnboardingApi } from '../src/onboarding/api.js';
import {
  loadCorrectableImports,
  loadDocumentContent,
  loadLoans,
  loadSyncStatus,
  mayIn,
  parseListQuery,
  servicingGrants,
  stageStateFrom,
  verifiedDocumentBytes,
  lendersWith,
  lenderNameOf,
} from '../src/servicing/data.js';
import {
  formatCount,
  formatDate,
  formatIst,
  formatRupees,
  groupIndian,
  istLocalToInstant,
  parseRupeesToPaise,
  realDate,
  rupeesOrNotReported,
} from '../src/servicing/format.js';
import { openLenderDocument } from '../src/servicing/document-file.js';
import {
  noticeUrl,
  runServicingOperation,
  SERVICING_OPERATIONS,
  safeServicingReturnPath,
} from '../src/servicing/operations.js';
import {
  anomalyWords,
  batchStatusWords,
  CAPABILITY_KEYS,
  capabilityWords,
  closureKindWords,
  collateralWords,
  conflictReasonWords,
  conflictStatusWords,
  confirmedVersionWords,
  connectionKindWords,
  connectionStatusWords,
  countLabelWords,
  documentKindWords,
  documentSourceWords,
  importErrorWords,
  importFieldName,
  importKindWords,
  loanStatusWords,
  quoteSourceWords,
  recordTypeWords,
  releaseStatusWords,
  requestStatusWords,
  rowOutcomeWords,
  safeErrorCode,
  servicingErrorMessage,
  severityWords,
  sourceSystemWords,
} from '../src/servicing/wording.js';
import {
  BATCH,
  CONFLICT,
  DOC,
  formOf,
  KEY,
  LENDER_A,
  LENDER_B,
  LOAN,
  REQUEST,
  recordingApi,
  SHA,
  TASK,
  batch,
} from './servicing-fixtures.js';

const GENERIC = 'The action could not be completed. Nothing was changed.';

describe('money, dates and times are written down, never worked out', () => {
  it('groups rupees the Indian way from integer paise', () => {
    expect(formatRupees(0)).toBe('₹0.00');
    expect(formatRupees(5)).toBe('₹0.05');
    expect(formatRupees(100)).toBe('₹1.00');
    expect(formatRupees(99_999)).toBe('₹999.99');
    expect(formatRupees(100_000)).toBe('₹1,000.00');
    expect(formatRupees(12_345_678)).toBe('₹1,23,456.78');
    expect(formatRupees(12_500_000)).toBe('₹1,25,000.00');
    expect(formatRupees(1_000_000_000)).toBe('₹1,00,00,000.00');
    // The largest amount the contract allows: 10,00,00,00,00,000 rupees.
    expect(formatRupees(100_000_000_000_000)).toBe('₹10,00,00,00,00,000.00');
  });

  it('refuses a value that is not whole paise instead of rounding it', () => {
    for (const bad of [1.5, -1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60]) {
      expect(() => formatRupees(bad)).toThrow(RangeError);
    }
  });

  it('never shows a figure that was not reported as zero', () => {
    expect(rupeesOrNotReported(null)).toBe('Not reported');
    expect(rupeesOrNotReported(0)).toBe('₹0.00');
  });

  it('groups digits and counts', () => {
    expect(groupIndian('7')).toBe('7');
    expect(groupIndian('1234')).toBe('1,234');
    expect(groupIndian('123456')).toBe('1,23,456');
    expect(groupIndian('12345678')).toBe('1,23,45,678');
    expect(() => groupIndian('12a')).toThrow(RangeError);
    expect(formatCount(10_000)).toBe('10,000');
    expect(() => formatCount(-1)).toThrow(RangeError);
  });

  it('writes a date without applying any time zone', () => {
    expect(formatDate('2026-10-16')).toBe('16 Oct 2026');
    expect(formatDate('2026-01-05')).toBe('5 Jan 2026');
    expect(() => formatDate('2026-02-31')).toThrow(RangeError);
    expect(() => formatDate('16/10/2026')).toThrow(RangeError);
  });

  it('writes an instant in India time with the zone named', () => {
    expect(formatIst('2026-10-16T10:15:30.123456+00:00')).toBe('16 Oct 2026, 15:45 IST');
    // The same instant written with another offset reads the same in India.
    expect(formatIst('2026-10-16T15:45:30+05:30')).toBe('16 Oct 2026, 15:45 IST');
    // A late UTC evening is the next morning in India.
    expect(formatIst('2026-12-31T20:00:00Z')).toBe('1 Jan 2027, 01:30 IST');
    expect(formatIst('2026-10-16T18:29:59.000000+00:00')).toBe('16 Oct 2026, 23:59 IST');
    expect(() => formatIst('not a time')).toThrow(RangeError);
  });

  it('turns what a person types into paise exactly, or refuses it', () => {
    expect(parseRupeesToPaise('0')).toBe(0);
    expect(parseRupeesToPaise('12500')).toBe(1_250_000);
    expect(parseRupeesToPaise('12500.5')).toBe(1_250_050);
    expect(parseRupeesToPaise('12500.50')).toBe(1_250_050);
    expect(parseRupeesToPaise(' 99.99 ')).toBe(9_999);
    for (const bad of [
      '',
      '1,250',
      '12.345',
      '-5',
      '+5',
      '1e3',
      '12.',
      '.5',
      'abc',
      '₹100',
      '1 000',
    ]) {
      expect(parseRupeesToPaise(bad), bad).toBeNull();
    }
    // More than the contract's largest amount.
    expect(parseRupeesToPaise('1000000000000.01')).toBeNull();
    expect(parseRupeesToPaise('1000000000000.00')).toBe(100_000_000_000_000);
  });

  it('reads a wall-clock time as India time and refuses a time that does not exist', () => {
    expect(istLocalToInstant('2026-10-13T10:00')).toBe('2026-10-13T10:00:00+05:30');
    expect(istLocalToInstant('2026-10-13T10:00:30')).toBe('2026-10-13T10:00:30+05:30');
    expect(istLocalToInstant('2026-02-30T10:00')).toBeNull();
    expect(istLocalToInstant('2026-10-13T25:00')).toBeNull();
    expect(istLocalToInstant('2026-10-13')).toBeNull();
    expect(istLocalToInstant('')).toBeNull();
    expect(realDate('2026-10-16')).toBe('2026-10-16');
    expect(realDate('2026-13-01')).toBeNull();
  });
});

describe('wording', () => {
  const vocabularies: [string, readonly string[], (value: string) => string][] = [
    ['loan status', LS_LOAN_STATUSES, loanStatusWords],
    ['connection kind', LS_CONNECTION_KINDS, connectionKindWords],
    ['connection status', LS_CONNECTION_STATUSES, connectionStatusWords],
    ['capability', LS_CAPABILITY_KEYS, capabilityWords],
    ['import kind', LS_IMPORT_KINDS, importKindWords],
    ['batch status', LS_BATCH_STATUSES, batchStatusWords],
    ['row outcome', LS_ROW_ERROR_OUTCOMES, rowOutcomeWords],
    ['anomaly', LS_ANOMALY_KINDS, anomalyWords],
    ['severity', LS_ANOMALY_SEVERITIES, severityWords],
    ['conflict record type', LS_CONFLICT_RECORD_TYPES, recordTypeWords],
    ['conflict reason', LS_CONFLICT_REASONS, conflictReasonWords],
    ['conflict status', LS_CONFLICT_STATUSES, conflictStatusWords],
    ['confirmed version', LS_CONFLICT_VERSIONS, confirmedVersionWords],
    ['document kind', LS_DOCUMENT_KINDS, documentKindWords],
    ['document source', LS_DOCUMENT_SOURCES, documentSourceWords],
    ['request status', LS_REQUEST_STATUSES, requestStatusWords],
    ['quote source', LS_QUOTE_SOURCES, quoteSourceWords],
    ['collateral', LS_COLLATERAL_TYPES, collateralWords],
    ['closure kind', LS_CLOSURE_KINDS, closureKindWords],
    ['release status', LS_RELEASE_STATUSES, releaseStatusWords],
  ];

  it.each(vocabularies)('has plain words for every %s the API can send', (_name, values, words) => {
    const fallback = words('a_value_nobody_defined');
    for (const value of values) {
      const text = words(value);
      expect(text, value).not.toBe(fallback);
      // A closed-vocabulary code is never the text shown.
      expect(text, value).not.toMatch(/_/);
    }
  });

  it('does not print a vocabulary value it has no wording for', () => {
    for (const [, , words] of vocabularies) {
      expect(words('internal_state_xyz')).not.toContain('internal_state_xyz');
    }
  });

  it('has the same list of capabilities as the contract', () => {
    expect([...CAPABILITY_KEYS].sort()).toEqual([...LS_CAPABILITY_KEYS].sort());
  });

  it('has wording for every import error class and names only the format’s columns', () => {
    const classes = [
      'file_too_large',
      'too_many_rows',
      'empty_file',
      'malformed_file',
      'unknown_column',
      'missing_column',
      'duplicate_column',
      'column_count_mismatch',
      'row_not_object',
      'unknown_field',
      'missing_required',
      'invalid_reference',
      'borrower_ref_looks_personal',
      'invalid_amount',
      'amount_not_positive',
      'invalid_date',
      'invalid_timestamp',
      'timestamp_in_future',
      'invalid_integer',
      'invalid_status',
      'invalid_receipt_kind',
      'incomplete_disbursement',
      'incomplete_next_due',
      'disbursed_exceeds_sanctioned',
      'reversal_reference_invalid',
      'invalid_items',
      'inconsistent_report_head',
      'invalid_validity',
      'duplicate_row',
      'conflicting_duplicate',
      'content_hash_mismatch',
      'application_not_found',
      'application_ambiguous',
      'application_not_ready',
      'application_already_linked',
      'disbursement_evidence_incomplete',
      'disbursement_date_in_future',
      'disbursement_reference_in_use',
      'unknown_loan',
      'reversal_target_unknown',
      'borrower_ref_mismatch',
    ];
    const fallback = importErrorWords('something_new');
    for (const code of classes) {
      expect(importErrorWords(code), code).not.toBe(fallback);
      expect(importErrorWords(code), code).not.toMatch(/_/);
    }
    expect(importFieldName('sanctioned_amount')).toBe('sanctioned_amount');
    expect(importFieldName('installment_seq')).toBe('installment_seq');
    expect(importFieldName('my own column')).toBe('a column the format does not define');
    expect(countLabelWords('ignoredOlder')).toBe(countLabelWords('ignored_older'));
    expect(sourceSystemWords('file_import')).toBe('file import');
    expect(sourceSystemWords('something_else')).toBe('another source');
  });

  it('maps a stable error code to a sentence and anything else to the generic sentence', () => {
    expect(servicingErrorMessage('import_has_errors')).toMatch(/errors/);
    expect(servicingErrorMessage('mfa_required')).toMatch(/second factor/);
    expect(servicingErrorMessage('feature_disabled')).toMatch(/switched off/);
    expect(servicingErrorMessage('http_500')).toBe(GENERIC);
    expect(servicingErrorMessage(undefined)).toBe(GENERIC);
    expect(servicingErrorMessage('')).toBe(GENERIC);
    // Server text, a stack, an address: none of it is ever echoed.
    for (const raw of [
      'duplicate key value violates unique constraint "uq_x"',
      'ECONNREFUSED 10.1.2.3:5432',
      '__proto__',
      'constructor',
      'toString',
    ]) {
      expect(servicingErrorMessage(raw), raw).toBe(GENERIC);
    }
  });

  it('lets only a short lower-case code travel in an address', () => {
    expect(safeErrorCode('import_has_errors')).toBe('import_has_errors');
    expect(safeErrorCode('http_500')).toBe('http_500');
    expect(safeErrorCode('Some Server Text: with spaces')).toBe('unknown');
    expect(safeErrorCode('a'.repeat(80))).toBe('unknown');
    expect(safeErrorCode('x&done=1')).toBe('unknown');
  });
});

describe('what the person may do, lender by lender', () => {
  const memberships = [
    {
      organizationId: LENDER_A,
      organizationKind: 'lender',
      organizationName: 'Sample Finance Ltd',
      permissions: ['loan.read', 'servicing.manual_entry'],
    },
    {
      organizationId: LENDER_B,
      organizationKind: 'lender',
      organizationName: 'Other Finance Ltd',
      permissions: ['loan.read', 'servicing.sync.manage', 'servicing.document.issue'],
    },
    {
      organizationId: '0190a000-0000-7000-8000-00000000000c',
      organizationKind: 'platform',
      organizationName: 'Platform',
      permissions: [
        'loan.read',
        'servicing.sync.manage',
        'servicing.manual_entry',
        'servicing.document.issue',
      ],
    },
  ];
  const grants = servicingGrants(memberships);

  it('keeps a permission with the lender that granted it', () => {
    expect(mayIn(grants, LENDER_A, 'manualEntry')).toBe(true);
    expect(mayIn(grants, LENDER_A, 'syncManage')).toBe(false);
    expect(mayIn(grants, LENDER_B, 'syncManage')).toBe(true);
    expect(mayIn(grants, LENDER_B, 'manualEntry')).toBe(false);
    expect(lendersWith(grants, 'documentIssue').map((g) => g.lenderId)).toEqual([LENDER_B]);
    expect(lenderNameOf(grants, LENDER_B)).toBe('Other Finance Ltd');
    expect(lenderNameOf(grants, 'unknown')).toBe('the lender');
  });

  it('gives a platform membership no lender grant at all', () => {
    expect(grants).toHaveLength(2);
    expect(mayIn(grants, '0190a000-0000-7000-8000-00000000000c', 'syncManage')).toBe(false);
  });
});

describe('list queries from the address', () => {
  it('keeps only values the page understands', () => {
    const q = parseListQuery(
      {
        status: 'active',
        kind: 'loan',
        severity: 'warning',
        lenderId: LENDER_A,
        cursor: 'abc_DEF-123',
      },
      { status: ['active', 'closed'], kind: ['loan'], severity: ['warning'] },
    );
    expect(q).toEqual({
      status: 'active',
      kind: 'loan',
      severity: 'warning',
      lenderId: LENDER_A,
      cursor: 'abc_DEF-123',
    });
  });

  it('drops a value that is not allowed, not a uuid, or not a cursor', () => {
    const q = parseListQuery(
      { status: 'weird', kind: 'x', lenderId: 'not-a-uuid', cursor: 'a b&c=d' },
      { status: ['active'], kind: ['loan'] },
    );
    expect(q).toEqual({});
    expect(parseListQuery({ status: ['active', 'closed'] }, { status: ['active'] })).toEqual({});
    expect(parseListQuery({ status: 'active' })).toEqual({});
  });
});

describe('loaders ask for exactly the documented routes', () => {
  it('lists loans with the filters encoded', async () => {
    const { api, reads } = recordingApi();
    await loadLoans(api, { status: 'active', lenderId: LENDER_A, cursor: 'a-b_c' });
    await loadLoans(api, {});
    expect(reads[0]).toBe(
      `/v1/lender/loans?limit=25&cursor=a-b_c&lenderId=${LENDER_A}&status=active`,
    );
    expect(reads[1]).toBe('/v1/lender/loans?limit=25');
  });

  it('ignores a status the API does not know instead of passing it on', async () => {
    const { api, reads } = recordingApi();
    await loadLoans(api, { status: 'paid' });
    expect(reads[0]).toBe('/v1/lender/loans?limit=25');
  });

  it('reads the sync status, a document’s content and the correctable files', async () => {
    const { api, reads } = recordingApi();
    await loadSyncStatus(api);
    await loadDocumentContent(api, LOAN, DOC);
    await loadDocumentContent(api, LOAN, DOC, 'download');
    expect(reads).toEqual([
      '/v1/lender/sync/status',
      `/v1/lender/loans/${LOAN}/documents/${DOC}/content?purpose=view`,
      `/v1/lender/loans/${LOAN}/documents/${DOC}/content?purpose=download`,
    ]);
  });

  it('collects the invalid, discarded and failed files, newest first', async () => {
    const older = batch({
      id: BATCH,
      status: 'invalid',
      uploadedAt: '2026-10-10T00:00:00.000000+00:00',
    });
    const newer = batch({
      id: '0190a000-0000-7000-8000-000000000699',
      status: 'failed',
      uploadedAt: '2026-10-12T00:00:00.000000+00:00',
    });
    const { api, reads } = recordingApi(
      {},
      {
        '/v1/lender/imports?limit=25&status=invalid': { items: [older], nextCursor: null },
        '/v1/lender/imports?limit=25&status=rejected': { items: [], nextCursor: null },
        '/v1/lender/imports?limit=25&status=failed': { items: [newer], nextCursor: null },
      },
    );
    const found = await loadCorrectableImports(api);
    expect(reads).toHaveLength(3);
    expect(found.map((b) => b.id)).toEqual([newer.id, older.id]);
  });
});

describe('a document’s bytes are checked again before they are streamed', () => {
  const bytes = new TextEncoder().encode('%PDF-1.4 sample');
  const content = (over: Record<string, unknown> = {}) => ({
    contentBase64: Buffer.from(bytes).toString('base64'),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.length,
    ...over,
  });

  it('returns the bytes when size and SHA-256 match', async () => {
    const out = await verifiedDocumentBytes(content());
    expect(out && Buffer.from(out).toString('utf8')).toBe('%PDF-1.4 sample');
  });

  it('returns nothing when the fingerprint differs', async () => {
    expect(await verifiedDocumentBytes(content({ sha256: SHA }))).toBeNull();
  });

  it('returns nothing when the size differs or the text is not base64', async () => {
    expect(await verifiedDocumentBytes(content({ sizeBytes: bytes.length + 1 }))).toBeNull();
    expect(await verifiedDocumentBytes(content({ contentBase64: 'not base64!' }))).toBeNull();
    expect(await verifiedDocumentBytes(content({ contentBase64: 'abc' }))).toBeNull();
  });
});

describe('opening a lender document streams the stored file or a short refusal', () => {
  const bytes = new TextEncoder().encode('%PDF-1.4 sample');
  const sha = createHash('sha256').update(bytes).digest('hex');
  const stored = (over: Record<string, unknown> = {}) => ({
    documentId: DOC,
    kind: 'statement',
    mimeType: 'application/pdf',
    sha256: sha,
    sizeBytes: bytes.length,
    lenderReference: 'STMT/SAMPLE/001',
    contentBase64: Buffer.from(bytes).toString('base64'),
    ...over,
  });
  const path = `/v1/lender/loans/${LOAN}/documents/${DOC}/content?purpose=view`;
  /** An API that answers the content route with a stored document, or fails with a status and a code. */
  const apiWith = (
    answer: { data: unknown } | { status: number; code: string },
  ): OnboardingApi => ({
    get: (requested) => {
      expect(requested).toBe(path);
      return Promise.resolve(
        'data' in answer
          ? { ok: true as const, status: 200, data: answer.data as never }
          : { ok: false as const, status: answer.status, code: answer.code },
      );
    },
    post: () => Promise.reject(new Error('a document is never opened with a write')),
  });

  it('streams the exact bytes as a PDF that the browser may not sniff, cache or run', async () => {
    const response = await openLenderDocument(apiWith({ data: stored() }), LOAN, DOC);
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).toString('utf8')).toBe('%PDF-1.4 sample');
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-security-policy')).toContain('sandbox');
    // The file name carries no lender reference and no person: only the start of the document id.
    expect(response.headers.get('content-disposition')).toBe(
      `inline; filename="document-${DOC.slice(0, 8)}.pdf"`,
    );
  });

  it('refuses bytes whose fingerprint or size differ from the recorded ones, and says only that', async () => {
    for (const bad of [
      { sha256: SHA },
      { sizeBytes: bytes.length + 1 },
      { contentBase64: '%%%' },
    ]) {
      const response = await openLenderDocument(apiWith({ data: stored(bad) }), LOAN, DOC);
      expect(response.status).toBe(502);
      expect(await response.text()).toBe('Not available');
    }
  });

  it('maps each refusal to a short status and repeats nothing the API said', async () => {
    const cases: [number, number][] = [
      [404, 404],
      [401, 403],
      [403, 403],
      [409, 409],
      [503, 503],
      [500, 502],
      [422, 502],
    ];
    for (const [from, to] of cases) {
      const response = await openLenderDocument(
        apiWith({ status: from, code: 'internal_detail_code' }),
        LOAN,
        DOC,
      );
      const body = await response.text();
      expect(response.status, String(from)).toBe(to);
      expect(body).toMatch(/^(Not found|Not available)$/);
      expect(body).not.toContain('internal_detail_code');
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('does not call the API for a loan or document that is not an id', async () => {
    const api: OnboardingApi = {
      get: () => Promise.reject(new Error('the API must not be called')),
      post: () => Promise.reject(new Error('the API must not be called')),
    };
    expect((await openLenderDocument(api, '../x', DOC)).status).toBe(404);
    expect((await openLenderDocument(api, LOAN, 'not-an-id')).status).toBe(404);
  });
});

describe('the answer to staging a file', () => {
  const rowError = {
    rowNo: 3,
    outcome: 'error',
    errorCodes: ['invalid_amount'],
    fieldNames: ['sanctioned_amount'],
  };

  it('goes to the preview when a batch exists', () => {
    const outcome = LsImportOutcome.parse({
      existing: true,
      batch: batch(),
      refusedFile: null,
      errors: [],
      errorsTruncated: false,
    });
    expect(stageStateFrom(outcome)).toEqual({ status: 'staged', batchId: BATCH, existing: true });
  });

  it('keeps the problems of a refused file, which has no preview page', () => {
    const outcome = LsImportOutcome.parse({
      existing: false,
      batch: null,
      refusedFile: { fileSha256: SHA, byteSize: 40, recordCount: 2 },
      errors: [rowError],
      errorsTruncated: true,
    });
    expect(stageStateFrom(outcome)).toEqual({
      status: 'refused',
      fileSha256: SHA,
      byteSize: 40,
      recordCount: 2,
      errors: [rowError],
      errorsTruncated: true,
    });
  });
});

// -------------------------------------------------------------------------------------------------------------------
// The allow-listed operations
// -------------------------------------------------------------------------------------------------------------------
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a]); // "%PDF-1.4\n"
const pdfFile = (bytes: Uint8Array<ArrayBuffer> = PDF) =>
  new File([bytes], 'x.pdf', { type: 'application/pdf' });
const csvFile = (text: string) => new File([text], 'x.csv', { type: 'text/csv' });
const base = { key: KEY };

describe('the operation table', () => {
  it('lists exactly the operations the screens use', () => {
    expect(Object.keys(SERVICING_OPERATIONS).sort()).toEqual(
      [
        'servicing.closure.confirm',
        'servicing.closure.delay',
        'servicing.closure.open',
        'servicing.conflict.acknowledge',
        'servicing.conflict.resolve',
        'servicing.connection.set',
        'servicing.document.register',
        'servicing.import.commit',
        'servicing.import.reject',
        'servicing.import.stage',
        'servicing.quote.record',
        'servicing.request.decline',
      ].sort(),
    );
  });

  it('refuses an operation that is not on the list, with no call to the API', async () => {
    const { api, calls } = recordingApi();
    for (const op of [
      'onboarding.profile.update',
      'document.approve',
      '__proto__',
      'constructor',
      'toString',
      'hasOwnProperty',
      '',
      'servicing.import.apply',
    ]) {
      const out = await runServicingOperation(api, formOf({ ...base, op, id: BATCH }));
      expect(out, op).toEqual({ ok: false, code: 'path_not_allowed' });
    }
    expect(await runServicingOperation(api, formOf({ ...base }))).toEqual({
      ok: false,
      code: 'path_not_allowed',
    });
    expect(calls).toHaveLength(0);
  });

  it('needs a request key of the expected shape', async () => {
    const { api, calls } = recordingApi();
    for (const key of ['', 'short', 'has spaces in it 1234567890', 'x'.repeat(200)]) {
      const out = await runServicingOperation(
        api,
        formOf({ op: 'servicing.conflict.acknowledge', key, id: CONFLICT }),
      );
      expect(out, key).toEqual({ ok: false, code: 'validation_failed' });
    }
    expect(calls).toHaveLength(0);
  });

  it('sends the key with the call so a repeat is applied once', async () => {
    const { api, calls } = recordingApi();
    await runServicingOperation(
      api,
      formOf({ op: 'servicing.conflict.acknowledge', ...base, id: CONFLICT }),
    );
    expect(calls).toEqual([
      { path: `/v1/lender/sync/conflicts/${CONFLICT}/acknowledge`, body: {}, key: KEY },
    ]);
  });

  it('serves staging only through its own entry point', async () => {
    const { api, calls } = recordingApi();
    const form = formOf({
      op: 'servicing.import.stage',
      ...base,
      lenderId: LENDER_A,
      kind: 'loan',
      fileFormat: 'csv',
      file: csvFile('a,b\n1,2\n'),
    });
    expect(await runServicingOperation(api, form)).toEqual({ ok: false, code: 'path_not_allowed' });
    expect(calls).toHaveLength(0);
  });

  it('ignores the form’s own op when an entry point serves one operation', async () => {
    const { api, calls } = recordingApi({
      existing: false,
      batch: batch(),
      refusedFile: null,
      errors: [],
      errorsTruncated: false,
    });
    const out = await runServicingOperation(
      api,
      formOf({
        op: 'servicing.closure.confirm',
        ...base,
        taskId: TASK,
        confirmationRef: 'REL/1',
        lenderId: LENDER_A,
        kind: 'loan',
        fileFormat: 'csv',
        file: csvFile('a,b\n1,2\n'),
      }),
      'servicing.import.stage',
    );
    expect(out.ok && out.stage?.status).toBe('staged');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe('/v1/lender/imports');
  });
});

describe('LMS connection', () => {
  const fields = {
    op: 'servicing.connection.set',
    ...base,
    lenderId: LENDER_A,
    kind: 'file_import',
    status: 'active',
    stalenessThresholdMinutes: '1440',
  };

  it('sends the declared capabilities as ticked or unticked, and nothing assumed', async () => {
    const { api, calls } = recordingApi();
    const out = await runServicingOperation(
      api,
      formOf({ ...fields, cap_receipts: 'on', cap_schedule: 'on' }),
    );
    expect(out).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe('/v1/lender/lms-connection');
    expect(calls[0]?.body).toEqual({
      lenderId: LENDER_A,
      kind: 'file_import',
      status: 'active',
      capabilities: {
        pull: false,
        push: false,
        receipts: true,
        schedule: true,
        foreclosure_quote: false,
        statement: false,
        closure_documents: false,
      },
      stalenessThresholdMinutes: 1440,
    });
  });

  it.each([
    ['a kind the screen does not offer', { kind: 'finbyx' }],
    ['a mock connection', { kind: 'mock' }],
    ['a blocked status', { status: 'blocked_unverified' }],
    ['a threshold below the minimum', { stalenessThresholdMinutes: '4' }],
    ['a threshold above the maximum', { stalenessThresholdMinutes: '43201' }],
    ['a threshold that is not a whole number', { stalenessThresholdMinutes: '12.5' }],
    ['a lender that is not an id', { lenderId: 'lender-a' }],
  ])('refuses %s without calling the API', async (_name, over) => {
    const { api, calls } = recordingApi();
    const out = await runServicingOperation(api, formOf({ ...fields, ...over }));
    expect(out).toEqual({ ok: false, code: 'validation_failed' });
    expect(calls).toHaveLength(0);
  });
});

describe('importing a file', () => {
  const outcome = {
    existing: false,
    batch: batch(),
    refusedFile: null,
    errors: [],
    errorsTruncated: false,
  };
  const fields = { ...base, lenderId: LENDER_A, kind: 'loan', fileFormat: 'csv' };
  const stage = (api: ReturnType<typeof recordingApi>['api'], form: FormData) =>
    runServicingOperation(api, form, 'servicing.import.stage');

  it('sends the exact text of the file and the format version, and returns the preview address', async () => {
    const { api, calls } = recordingApi(outcome);
    const text = 'lms_loan_ref,status\r\nLN-1,active\r\n';
    const out = await stage(api, formOf({ ...fields, file: csvFile(text) }));
    expect(out).toEqual({ ok: true, stage: { status: 'staged', batchId: BATCH, existing: false } });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe('/v1/lender/imports');
    expect(calls[0]?.key).toBe(KEY);
    expect(calls[0]?.body).toEqual({
      lenderId: LENDER_A,
      kind: 'loan',
      sourceKind: 'file',
      formatVersion: 'udofin-lms-import-v1',
      fileFormat: 'csv',
      content: text,
    });
  });

  it('keeps a byte-order mark, which the importer ignores, rather than altering the file', async () => {
    const { api, calls } = recordingApi(outcome);
    await stage(api, formOf({ ...fields, file: csvFile('﻿lms_loan_ref\nLN-1\n') }));
    expect((calls[0]?.body as { content: string }).content.charCodeAt(0)).toBe(0xfeff);
  });

  it('links a correction to the earlier file, and only with a real id', async () => {
    const { api, calls } = recordingApi(outcome);
    await stage(api, formOf({ ...fields, resubmissionOf: BATCH, file: csvFile('x\n') }));
    expect((calls[0]?.body as { resubmissionOf?: string }).resubmissionOf).toBe(BATCH);
    const bad = await stage(
      api,
      formOf({ ...fields, resubmissionOf: 'not-an-id', file: csvFile('x\n') }),
    );
    expect(bad).toEqual({ ok: false, code: 'validation_failed' });
    expect(calls).toHaveLength(1);
  });

  it('hands back the problems of a file the importer refused', async () => {
    const refused = {
      existing: false,
      batch: null,
      refusedFile: { fileSha256: SHA, byteSize: 12, recordCount: 0 },
      errors: [
        { rowNo: 0, outcome: 'error', errorCodes: ['missing_column'], fieldNames: ['status'] },
      ],
      errorsTruncated: false,
    };
    const { api } = recordingApi(refused);
    const out = await stage(api, formOf({ ...fields, file: csvFile('x\n') }));
    expect(out.ok && out.stage?.status).toBe('refused');
  });

  it.each([
    ['no file', {}, 'file_required'],
    ['a field that is not a file', { file: 'text' }, 'file_required'],
    ['an empty file', { file: csvFile('') }, 'file_empty'],
    [
      'a file that is not UTF-8 text',
      { file: new File([new Uint8Array([0xff, 0xfe, 0x00, 0xd8])], 'x.csv') },
      'file_not_text',
    ],
  ])('refuses %s without calling the API', async (_name, over, code) => {
    const { api, calls } = recordingApi(outcome);
    const out = await stage(api, formOf({ ...fields, ...over }));
    expect(out).toEqual({ ok: false, code });
    expect(calls).toHaveLength(0);
  });

  it('refuses a file over the transport limit without reading it', async () => {
    const { api, calls } = recordingApi(outcome);
    const big = new File([new Uint8Array(8 * 1024 * 1024 + 1)], 'big.csv');
    const out = await stage(api, formOf({ ...fields, file: big }));
    expect(out).toEqual({ ok: false, code: 'file_too_large' });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['a kind the API does not know', { kind: 'statement' }],
    ['a format the API does not know', { fileFormat: 'xlsx' }],
    ['a lender that is not an id', { lenderId: 'x' }],
  ])('refuses %s', async (_name, over) => {
    const { api, calls } = recordingApi(outcome);
    const out = await stage(api, formOf({ ...fields, ...over, file: csvFile('x\n') }));
    expect(out).toEqual({ ok: false, code: 'validation_failed' });
    expect(calls).toHaveLength(0);
  });

  it('does not send the name of the file anywhere', async () => {
    const { api, calls } = recordingApi(outcome);
    const named = new File(['x\n'], 'borrower-names-october.csv', { type: 'text/csv' });
    await stage(api, formOf({ ...fields, file: named }));
    expect(JSON.stringify(calls)).not.toContain('borrower-names');
  });
});

describe('applying and discarding a file are separate explicit steps', () => {
  it('applies only when the person ticked that they reviewed the preview', async () => {
    const { api, calls } = recordingApi();
    const untick = await runServicingOperation(
      api,
      formOf({ op: 'servicing.import.commit', ...base, id: BATCH }),
    );
    expect(untick).toEqual({ ok: false, code: 'review_required' });
    expect(calls).toHaveLength(0);
    const ticked = await runServicingOperation(
      api,
      formOf({ op: 'servicing.import.commit', ...base, id: BATCH, reviewed: 'on' }),
    );
    expect(ticked).toEqual({ ok: true });
    expect(calls).toEqual([{ path: `/v1/lender/imports/${BATCH}/commit`, body: {}, key: KEY }]);
  });

  it('does not call a commit done when the API says applying failed and was rolled back', async () => {
    const failedAnswer = {
      existing: false,
      batch: batch({
        status: 'failed',
        failedAt: '2026-10-16T09:31:00.000000+00:00',
        failureClass: '40P01',
      }),
      refusedFile: null,
      errors: [],
      errorsTruncated: false,
    };
    const committedAnswer = {
      ...failedAnswer,
      batch: batch({
        status: 'committed',
        committedAt: '2026-10-16T09:30:00.000000+00:00',
        appliedCounts: { new: 8 },
      }),
    };
    const form = () =>
      formOf({ op: 'servicing.import.commit', ...base, id: BATCH, reviewed: 'on' });
    const failed = await runServicingOperation(recordingApi(failedAnswer).api, form());
    expect(failed).toEqual({ ok: false, code: 'import_apply_failed' });
    // The words say nothing was applied and never show the database class.
    expect(servicingErrorMessage('import_apply_failed')).toMatch(/Nothing was applied/);
    expect(servicingErrorMessage('import_apply_failed')).not.toContain('40P01');
    const applied = await runServicingOperation(recordingApi(committedAnswer).api, form());
    expect(applied).toEqual({ ok: true });
  });

  it('applying never discards and discarding never applies', async () => {
    const { api, calls } = recordingApi();
    await runServicingOperation(
      api,
      formOf({
        op: 'servicing.import.reject',
        ...base,
        id: BATCH,
        reason: 'The wrong month was exported',
        reviewed: 'on',
      }),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe(`/v1/lender/imports/${BATCH}/reject`);
    expect(calls[0]?.body).toEqual({ reason: 'The wrong month was exported' });
  });

  it('needs a reason of 10 to 1,000 characters to discard', async () => {
    const { api, calls } = recordingApi();
    for (const reason of ['', 'too short', 'x'.repeat(1001)]) {
      const out = await runServicingOperation(
        api,
        formOf({ op: 'servicing.import.reject', ...base, id: BATCH, reason }),
      );
      expect(out, reason).toEqual({ ok: false, code: 'reason_required' });
    }
    expect(calls).toHaveLength(0);
    const edge = await runServicingOperation(
      api,
      formOf({ op: 'servicing.import.reject', ...base, id: BATCH, reason: 'x'.repeat(1000) }),
    );
    expect(edge.ok).toBe(true);
  });

  it('refuses a batch that is not an id', async () => {
    const { api, calls } = recordingApi();
    const out = await runServicingOperation(
      api,
      formOf({ op: 'servicing.import.commit', ...base, id: '../x', reviewed: 'on' }),
    );
    expect(out.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('conflicts', () => {
  const resolve = {
    op: 'servicing.conflict.resolve',
    ...base,
    id: CONFLICT,
    confirmedVersion: 'incoming',
    note: 'Checked against the lender system screen',
    evidenceLabel1: 'lms_reference',
    evidenceValue1: 'LMS-VIEW-77',
  };

  it('records which report is confirmed, why, and what was reviewed', async () => {
    const { api, calls } = recordingApi();
    const out = await runServicingOperation(
      api,
      formOf({ ...resolve, evidenceLabel2: 'ticket_reference', evidenceValue2: 'TCK-9' }),
    );
    expect(out).toEqual({ ok: true });
    expect(calls[0]?.path).toBe(`/v1/lender/sync/conflicts/${CONFLICT}/resolve`);
    expect(calls[0]?.body).toEqual({
      confirmedVersion: 'incoming',
      note: 'Checked against the lender system screen',
      evidence: { lms_reference: 'LMS-VIEW-77', ticket_reference: 'TCK-9' },
    });
  });

  it.each([
    ['no evidence', { evidenceLabel1: '', evidenceValue1: '' }, 'evidence_invalid'],
    ['a label with no reference', { evidenceValue1: '' }, 'evidence_invalid'],
    ['a reference with no label', { evidenceLabel1: '' }, 'evidence_invalid'],
    ['a label that is not a key', { evidenceLabel1: 'Not A Key' }, 'evidence_invalid'],
    ['a reference over 200 characters', { evidenceValue1: 'x'.repeat(201) }, 'evidence_invalid'],
    ['a note that is too short', { note: 'too short' }, 'reason_required'],
  ])('refuses %s', async (_name, over, code) => {
    const { api, calls } = recordingApi();
    const out = await runServicingOperation(api, formOf({ ...resolve, ...over }));
    expect(out).toEqual({ ok: false, code });
    expect(calls).toHaveLength(0);
  });

  it('refuses the same label twice', async () => {
    const { api, calls } = recordingApi();
    const out = await runServicingOperation(
      api,
      formOf({ ...resolve, evidenceLabel2: 'lms_reference', evidenceValue2: 'again' }),
    );
    expect(out).toEqual({ ok: false, code: 'evidence_invalid' });
    expect(calls).toHaveLength(0);
  });

  it('refuses a version that is neither existing nor incoming', async () => {
    const { api, calls } = recordingApi();
    const out = await runServicingOperation(
      api,
      formOf({ ...resolve, confirmedVersion: 'merged' }),
    );
    expect(out).toEqual({ ok: false, code: 'validation_failed' });
    expect(calls).toHaveLength(0);
  });
});

describe('registering a lender document', () => {
  const fields = {
    op: 'servicing.document.register',
    ...base,
    loanId: LOAN,
    kind: 'statement',
    lenderReference: 'STMT/SAMPLE/001',
    issuedAt: '2026-10-01T10:00',
  };

  it('sends the PDF as base64 with the lender’s own reference and India-time issue instant', async () => {
    const { api, calls } = recordingApi();
    const out = await runServicingOperation(
      api,
      formOf({
        ...fields,
        periodFrom: '2026-04-01',
        periodTo: '2026-09-30',
        requestId: REQUEST,
        file: pdfFile(),
      }),
    );
    expect(out).toEqual({ ok: true });
    expect(calls[0]?.path).toBe(`/v1/lender/loans/${LOAN}/documents`);
    expect(calls[0]?.body).toEqual({
      kind: 'statement',
      mimeType: 'application/pdf',
      contentBase64: Buffer.from(PDF).toString('base64'),
      lenderReference: 'STMT/SAMPLE/001',
      issuedAt: '2026-10-01T10:00:00+05:30',
      periodFrom: '2026-04-01',
      periodTo: '2026-09-30',
      requestId: REQUEST,
    });
  });

  it.each([
    ['no file', {}, 'file_required'],
    [
      'a file that is not a PDF',
      {
        file: new File([new TextEncoder().encode('hello world')], 'x.pdf', {
          type: 'application/pdf',
        }),
      },
      'file_not_pdf',
    ],
    [
      'a reference with a space',
      { lenderReference: 'STMT 001', file: pdfFile() },
      'reference_invalid',
    ],
    ['no reference', { lenderReference: '', file: pdfFile() }, 'reference_invalid'],
    [
      'an issue time that does not exist',
      { issuedAt: '2026-02-30T10:00', file: pdfFile() },
      'time_invalid',
    ],
    [
      'a period date that does not exist',
      { periodFrom: '2026-02-30', file: pdfFile() },
      'date_invalid',
    ],
    ['a kind the API does not know', { kind: 'receipt', file: pdfFile() }, 'validation_failed'],
  ])('refuses %s without calling the API', async (_name, over, code) => {
    const { api, calls } = recordingApi();
    const out = await runServicingOperation(api, formOf({ ...fields, ...over }));
    expect(out).toEqual({ ok: false, code });
    expect(calls).toHaveLength(0);
  });

  it('refuses a file over 8 MiB', async () => {
    const { api, calls } = recordingApi();
    const big = new File([new Uint8Array(8 * 1024 * 1024 + 1)], 'x.pdf');
    const out = await runServicingOperation(api, formOf({ ...fields, file: big }));
    expect(out).toEqual({ ok: false, code: 'file_too_large' });
    expect(calls).toHaveLength(0);
  });

  it('declines a request with a note the borrower can read', async () => {
    const { api, calls } = recordingApi();
    const bad = await runServicingOperation(
      api,
      formOf({ op: 'servicing.request.decline', ...base, id: REQUEST, note: 'short' }),
    );
    expect(bad).toEqual({ ok: false, code: 'note_invalid' });
    const out = await runServicingOperation(
      api,
      formOf({
        op: 'servicing.request.decline',
        ...base,
        id: REQUEST,
        note: 'The loan is not closed yet',
      }),
    );
    expect(out).toEqual({ ok: true });
    expect(calls).toEqual([
      {
        path: `/v1/lender/document-requests/${REQUEST}/decline`,
        body: { note: 'The loan is not closed yet' },
        key: KEY,
      },
    ]);
  });
});

describe('recording a foreclosure quotation', () => {
  const fields = {
    op: 'servicing.quote.record',
    ...base,
    loanId: LOAN,
    lenderQuoteRef: 'FQ-SAMPLE-1',
    asOf: '2026-10-15T10:30',
    validUntil: '2026-10-22T23:59',
    principal: '90000',
    interest: '1200.5',
    charges: '50',
    prepaymentCharge: '2700',
    total: '93950.50',
  };

  it('sends the lender’s figures as whole paise exactly as typed', async () => {
    const { api, calls } = recordingApi();
    const out = await runServicingOperation(api, formOf(fields));
    expect(out).toEqual({ ok: true });
    expect(calls[0]?.path).toBe(`/v1/lender/loans/${LOAN}/foreclosure-quotes`);
    expect(calls[0]?.body).toEqual({
      lenderQuoteRef: 'FQ-SAMPLE-1',
      asOf: '2026-10-15T10:30:00+05:30',
      validUntil: '2026-10-22T23:59:00+05:30',
      principalMinor: 9_000_000,
      interestMinor: 120_050,
      chargesMinor: 5_000,
      prepaymentChargeMinor: 270_000,
      totalMinor: 9_395_050,
    });
  });

  it('sends a total that does not add up to its parts unchanged: it is flagged by the API, never corrected here', async () => {
    const { api, calls } = recordingApi();
    await runServicingOperation(api, formOf({ ...fields, total: '1' }));
    expect((calls[0]?.body as { totalMinor: number }).totalMinor).toBe(100);
  });

  it('links a request and a letter only when they are ids', async () => {
    const { api, calls } = recordingApi();
    await runServicingOperation(
      api,
      formOf({ ...fields, requestId: REQUEST, letterDocumentId: DOC }),
    );
    expect(calls[0]?.body).toMatchObject({ requestId: REQUEST, letterDocumentId: DOC });
    const bad = await runServicingOperation(api, formOf({ ...fields, requestId: 'x' }));
    expect(bad.ok).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it.each([
    ['an amount with a comma', { principal: '90,000' }, 'amount_invalid'],
    ['an amount with three decimals', { interest: '1.005' }, 'amount_invalid'],
    ['a negative amount', { charges: '-5' }, 'amount_invalid'],
    ['a missing amount', { total: '' }, 'amount_invalid'],
    ['a time that does not exist', { asOf: '2026-02-30T10:00' }, 'time_invalid'],
    ['a missing validity', { validUntil: '' }, 'time_invalid'],
    ['a reference with a space', { lenderQuoteRef: 'FQ 1' }, 'reference_invalid'],
  ])('refuses %s without calling the API', async (_name, over, code) => {
    const { api, calls } = recordingApi();
    const out = await runServicingOperation(api, formOf({ ...fields, ...over }));
    expect(out).toEqual({ ok: false, code });
    expect(calls).toHaveLength(0);
  });
});

describe('closure and security release', () => {
  it('records the chosen kinds of security, once each', async () => {
    const { api, calls } = recordingApi();
    const out = await runServicingOperation(
      api,
      formOf({
        op: 'servicing.closure.open',
        ...base,
        loanId: LOAN,
        collateralTypes: ['mutual_fund_lien', 'demat_pledge', 'mutual_fund_lien'],
      }),
    );
    expect(out).toEqual({ ok: true });
    expect(calls[0]?.path).toBe(`/v1/lender/loans/${LOAN}/security-release-tasks`);
    expect(calls[0]?.body).toEqual({ collateralTypes: ['mutual_fund_lien', 'demat_pledge'] });
  });

  it('records nothing when nothing is chosen, too many are chosen, or one is unknown', async () => {
    const { api, calls } = recordingApi();
    const open = (collateralTypes: string[]) =>
      runServicingOperation(
        api,
        formOf({ op: 'servicing.closure.open', ...base, loanId: LOAN, collateralTypes }),
      );
    expect(await open([])).toEqual({ ok: false, code: 'collateral_types_invalid' });
    expect(await open([...LS_COLLATERAL_TYPES, 'x'])).toEqual({
      ok: false,
      code: 'collateral_types_invalid',
    });
    expect(await open(['gold'])).toEqual({ ok: false, code: 'collateral_types_invalid' });
    expect(calls).toHaveLength(0);
  });

  it('confirms a release only with the lender’s own reference', async () => {
    const { api, calls } = recordingApi();
    for (const confirmationRef of ['', 'ab', 'has space', 'x'.repeat(101)]) {
      const out = await runServicingOperation(
        api,
        formOf({ op: 'servicing.closure.confirm', ...base, taskId: TASK, confirmationRef }),
      );
      expect(out, confirmationRef).toEqual({ ok: false, code: 'confirmation_ref_invalid' });
    }
    expect(calls).toHaveLength(0);
    const out = await runServicingOperation(
      api,
      formOf({
        op: 'servicing.closure.confirm',
        ...base,
        taskId: TASK,
        confirmationRef: 'REL/SAMPLE/7',
      }),
    );
    expect(out).toEqual({ ok: true });
    expect(calls[0]).toEqual({
      path: `/v1/lender/security-release/${TASK}/confirm`,
      body: { confirmationRef: 'REL/SAMPLE/7' },
      key: KEY,
    });
  });

  it('records a delay reason of 10 to 500 characters', async () => {
    const { api, calls } = recordingApi();
    const short = await runServicingOperation(
      api,
      formOf({ op: 'servicing.closure.delay', ...base, taskId: TASK, reason: 'late' }),
    );
    expect(short).toEqual({ ok: false, code: 'reason_invalid' });
    const long = await runServicingOperation(
      api,
      formOf({ op: 'servicing.closure.delay', ...base, taskId: TASK, reason: 'x'.repeat(501) }),
    );
    expect(long).toEqual({ ok: false, code: 'reason_invalid' });
    expect(calls).toHaveLength(0);
    await runServicingOperation(
      api,
      formOf({
        op: 'servicing.closure.delay',
        ...base,
        taskId: TASK,
        reason: 'Waiting for the depository',
      }),
    );
    expect(calls[0]?.path).toBe(`/v1/lender/security-release/${TASK}/delay-reason`);
  });
});

describe('where an action returns to', () => {
  it('allows the servicing pages and their filters', () => {
    for (const path of [
      '/loans',
      '/loans?status=active',
      '/loans/closures',
      '/loans/requests?status=requested&cursor=abc_DEF-1',
      `/loans/${LOAN}`,
      '/imports',
      `/imports/${BATCH}`,
      '/imports/conflicts?status=open',
      '/imports/anomalies',
    ]) {
      expect(safeServicingReturnPath(path), path).toBe(path);
    }
  });

  it('falls back to the loans page for anything else, so it cannot be used to redirect away', () => {
    for (const path of [
      '//evil.example/loans',
      'https://evil.example/loans',
      '/\\evil.example',
      '/loans/../admin',
      '/loans/not-an-id',
      `/loans/${LOAN}/documents`,
      '/imports/other',
      '/onboarding',
      '/loans?next=https://evil.example',
      '/loans?x=<script>',
      '',
      null,
      undefined,
      42,
    ]) {
      expect(safeServicingReturnPath(path), String(path)).toBe('/loans');
    }
  });

  it('adds the result to the address and replaces an older result', () => {
    expect(noticeUrl('/loans', { ok: true })).toBe('/loans?done=1');
    expect(noticeUrl('/loans?status=active', { ok: false, code: 'import_has_errors' })).toBe(
      '/loans?status=active&error=import_has_errors',
    );
    expect(noticeUrl('/imports?error=forbidden', { ok: true })).toBe('/imports?done=1');
    expect(noticeUrl('/imports?done=1&cursor=a', { ok: false, code: 'mfa_required' })).toBe(
      '/imports?cursor=a&error=mfa_required',
    );
    expect(noticeUrl('/loans', { ok: false, code: 'Some server text & more' })).toBe(
      '/loans?error=unknown',
    );
  });
});
