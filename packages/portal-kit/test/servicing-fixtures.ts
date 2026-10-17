// Synthetic (SAMPLE) data for the lender servicing screens. Every fixture is parsed by the real contract schema, so a screen
// is only ever tested against a shape the API can send. Nothing here is a real person, account or loan.
import {
  LsAnomaly,
  LsBalanceReport,
  LsClosure,
  LsConflict,
  LsDocument,
  LsDocumentRequest,
  LsImportBatch,
  LsLoanDetail,
  LsLoanRow,
  LsQuote,
  LsSyncStatusItem,
} from '@udofin/contracts';
import { vi } from 'vitest';
import { type z } from 'zod';
import { type OnboardingApi } from '../src/onboarding/api.js';
import { servicingGrants, type ServicingGrant } from '../src/servicing/data.js';
import { type ServicingContext } from '../src/servicing/common.js';

export const LENDER_A = '0190a000-0000-7000-8000-00000000000a';
export const LENDER_B = '0190a000-0000-7000-8000-00000000000b';
export const LOAN = '0190a000-0000-7000-8000-000000000101';
export const LOAN_2 = '0190a000-0000-7000-8000-000000000102';
export const DOC = '0190a000-0000-7000-8000-000000000201';
export const DOC_2 = '0190a000-0000-7000-8000-000000000202';
export const REQUEST = '0190a000-0000-7000-8000-000000000301';
export const REQUEST_2 = '0190a000-0000-7000-8000-000000000302';
export const TASK = '0190a000-0000-7000-8000-000000000401';
export const TASK_2 = '0190a000-0000-7000-8000-000000000402';
export const CONFLICT = '0190a000-0000-7000-8000-000000000501';
export const CONFLICT_2 = '0190a000-0000-7000-8000-000000000502';
export const CONFLICT_3 = '0190a000-0000-7000-8000-000000000503';
export const BATCH = '0190a000-0000-7000-8000-000000000601';
export const BATCH_2 = '0190a000-0000-7000-8000-000000000602';
export const QUOTE = '0190a000-0000-7000-8000-000000000701';
export const KEY = 'ui-0190a000-0000-7000-8000-0000000009ff';
export const SHA = 'ab'.repeat(32);

export const ALL_PERMISSIONS = [
  'loan.read',
  'servicing.sync.manage',
  'servicing.manual_entry',
  'servicing.document.issue',
] as const;

export const grantsFor = (
  permissions: readonly string[],
  lender = LENDER_A,
  name = 'Sample Finance Ltd',
): ServicingGrant[] =>
  servicingGrants([
    {
      organizationId: lender,
      organizationKind: 'lender',
      organizationName: name,
      permissions,
    },
  ]);

export const contextFor = (
  permissions: readonly string[],
  returnTo = '/loans',
  lender = LENDER_A,
): ServicingContext => ({
  action: vi.fn(() => Promise.resolve()),
  returnTo,
  grants: grantsFor(permissions, lender),
});

/** `over` replaces fields of the base fixture; the result is parsed by the contract schema. */
const make = <S extends z.ZodType>(schema: S, base: Record<string, unknown>, over: object) =>
  schema.parse({ ...base, ...over }) as z.infer<S>;

export const loanRow = (over: object = {}) =>
  make(
    LsLoanRow,
    {
      id: LOAN,
      lenderId: LENDER_A,
      lmsLoanRef: 'LN-SAMPLE-001',
      status: 'active',
      sanctionedAmountMinor: 12_500_000,
      disbursedAmountMinor: 12_500_000,
      disbursedAt: '2026-08-01T05:00:00.000000+00:00',
      lastSyncedAt: '2026-10-16T10:15:30.123456+00:00',
      createdAt: '2026-08-01T05:00:00.000000+00:00',
      sync: {
        newestReportedAsOf: '2026-10-16T10:15:30.123456+00:00',
        newestReceivedAt: '2026-10-16T10:20:00.000000+00:00',
        newestReportedStatus: 'active',
        stale: false,
        stalenessThresholdMinutes: 1440,
        hasOpenConflict: false,
        newestHasWarning: false,
      },
    },
    over,
  );

export const report = (over: object = {}) =>
  make(
    LsBalanceReport,
    {
      id: '0190a000-0000-7000-8000-000000000801',
      version: 3,
      status: 'active',
      reportedAsOf: '2026-10-16T10:15:30.123456+00:00',
      receivedAt: '2026-10-16T10:20:00.000000+00:00',
      outstandingPrincipalMinor: 10_000_050,
      overduePrincipalMinor: 100_000,
      overdueInterestMinor: 25_050,
      penalChargesMinor: 5_000,
      otherChargesMinor: 0,
      totalOverdueMinor: 130_050,
      nextDueOn: '2026-11-05',
      nextDueMinor: 1_250_000,
      daysPastDue: 12,
      flags: [],
      sourceSystem: 'file_import',
    },
    over,
  );

export const loanDetail = (over: Record<string, unknown> = {}) =>
  make(
    LsLoanDetail,
    {
      loan: loanRow(),
      report: report(),
      schedule: {
        id: '0190a000-0000-7000-8000-000000000802',
        version: 2,
        reportedAsOf: '2026-10-15T04:00:00.000000+00:00',
        receivedAt: '2026-10-15T04:05:00.000000+00:00',
        installments: [
          {
            seq: 1,
            dueDate: '2026-09-05',
            principalMinor: 1_000_000,
            interestMinor: 250_000,
            feesMinor: 0,
            totalMinor: 1_250_000,
          },
          {
            seq: 2,
            dueDate: '2026-10-05',
            principalMinor: 1_010_000,
            interestMinor: 240_000,
            feesMinor: 0,
            totalMinor: 1_250_000,
          },
        ],
      },
      receipts: [
        {
          id: '0190a000-0000-7000-8000-000000000803',
          kind: 'receipt',
          lmsReceiptRef: 'RC-SAMPLE-1',
          reversesReceiptRef: null,
          amountMinor: 1_250_000,
          valueDate: '2026-09-05',
          paymentMode: 'upi',
          bankReference: 'UTRSAMPLE01',
          reportedAsOf: '2026-09-05T09:00:00.000000+00:00',
          receivedAt: '2026-09-05T09:05:00.000000+00:00',
        },
        {
          id: '0190a000-0000-7000-8000-000000000804',
          kind: 'reversal',
          lmsReceiptRef: 'RC-SAMPLE-2',
          reversesReceiptRef: 'RC-SAMPLE-1',
          amountMinor: 100,
          valueDate: '2026-09-06',
          paymentMode: null,
          bankReference: null,
          reportedAsOf: '2026-09-06T09:00:00.000000+00:00',
          receivedAt: '2026-09-06T09:05:00.000000+00:00',
        },
      ],
      openConflicts: 1,
      anomalies: { warning: 1, info: 0 },
    },
    over,
  );

export const conflict = (over: object = {}) =>
  make(
    LsConflict,
    {
      id: CONFLICT,
      lenderId: LENDER_A,
      loanAccountId: LOAN,
      recordType: 'loan',
      conflictReason: 'same_record_different_content',
      sourceRecordId: 'SRC-SAMPLE-9',
      existingReportedAsOf: '2026-10-10T04:00:00.000000+00:00',
      incomingReportedAsOf: '2026-10-10T04:00:00.000000+00:00',
      sourceSystem: 'file_import',
      receivedAt: '2026-10-11T04:00:00.000000+00:00',
      status: 'open',
      acknowledgedAt: null,
      resolvedAt: null,
      confirmedVersion: null,
      resolutionNote: null,
    },
    over,
  );

export const anomaly = (over: object = {}) =>
  make(
    LsAnomaly,
    {
      id: '0190a000-0000-7000-8000-000000000901',
      lenderId: LENDER_A,
      loanAccountId: LOAN,
      kind: 'status_regression',
      severity: 'warning',
      previousStatus: 'closed',
      reportedStatus: 'active',
      previousAmountMinor: 500_000,
      reportedAmountMinor: null,
      sourceSystem: 'manual_import',
      reportedAsOf: '2026-10-12T04:00:00.000000+00:00',
      detectedAt: '2026-10-12T04:01:00.000000+00:00',
    },
    over,
  );

export const document = (over: object = {}) =>
  make(
    LsDocument,
    {
      documentId: DOC,
      kind: 'statement',
      issuer: 'lender',
      lenderReference: 'STMT/SAMPLE/001',
      issuedAt: '2026-10-01T04:30:00.000000+00:00',
      periodFrom: '2026-04-01',
      periodTo: '2026-09-30',
      sizeBytes: 123_456,
      sha256: SHA,
      source: 'lender_upload',
      supersededById: null,
    },
    over,
  );

export const docRequest = (over: object = {}) =>
  make(
    LsDocumentRequest,
    {
      id: REQUEST,
      lenderId: LENDER_A,
      loanAccountId: LOAN,
      kind: 'noc',
      periodFrom: null,
      periodTo: null,
      status: 'requested',
      requestedAt: '2026-10-14T08:00:00.000000+00:00',
      dueBy: '2026-10-21T08:00:00.000000+00:00',
      lenderNote: null,
      decidedAt: null,
      fulfilledDocumentId: null,
      fulfilledQuoteId: null,
    },
    over,
  );

export const quote = (over: object = {}) =>
  make(
    LsQuote,
    {
      id: QUOTE,
      lenderId: LENDER_A,
      loanAccountId: LOAN,
      lenderQuoteRef: 'FQ-SAMPLE-1',
      asOf: '2026-10-15T05:00:00.000000+00:00',
      validUntil: '2026-10-22T18:29:59.000000+00:00',
      principalMinor: 9_000_000,
      interestMinor: 120_000,
      chargesMinor: 5_000,
      prepaymentChargeMinor: 270_000,
      totalMinor: 9_395_000,
      totalMismatch: false,
      source: 'lender_portal',
      letterDocumentId: null,
      reportedAt: '2026-10-15T05:05:00.000000+00:00',
    },
    over,
  );

export const closure = (over: object = {}) =>
  make(
    LsClosure,
    {
      id: '0190a000-0000-7000-8000-000000000a01',
      lenderId: LENDER_A,
      loanAccountId: LOAN,
      closureKind: 'closed',
      closedAt: '2026-10-10T05:00:00.000000+00:00',
      nocDueBy: null,
      nocDocumentId: null,
      nocIssuedAt: null,
      tasks: [
        {
          id: TASK,
          collateralType: 'mutual_fund_lien',
          status: 'open',
          dueBy: '2026-11-09T05:00:00.000000+00:00',
          delayReason: null,
          delayReasonAt: null,
          lenderConfirmationRef: null,
          confirmedAt: null,
          createdAt: '2026-10-10T05:01:00.000000+00:00',
        },
        {
          id: TASK_2,
          collateralType: 'demat_pledge',
          status: 'confirmed_by_lender',
          dueBy: null,
          delayReason: null,
          delayReasonAt: null,
          lenderConfirmationRef: 'REL/SAMPLE/7',
          confirmedAt: '2026-10-12T05:00:00.000000+00:00',
          createdAt: '2026-10-10T05:01:00.000000+00:00',
        },
      ],
    },
    over,
  );

const counts = {
  new: 8,
  unchanged: 1,
  duplicate: 0,
  changed: 1,
  conflict: 0,
  error: 0,
  quarantined: 0,
  ignoredOlder: 0,
};

export const batch = (over: object = {}) =>
  make(
    LsImportBatch,
    {
      id: BATCH,
      lenderId: LENDER_A,
      kind: 'loan',
      sourceKind: 'file',
      status: 'previewed',
      formatVersion: 'udofin-lms-import-v1',
      rowCount: 10,
      counts,
      resubmissionOf: null,
      fileSha256: SHA,
      byteSize: 2_345_678,
      uploadedAt: '2026-10-16T09:00:00.000000+00:00',
      committedAt: null,
      rejectedAt: null,
      failedAt: null,
      failureClass: null,
      appliedCounts: null,
    },
    over,
  );

export const syncItem = (over: Record<string, unknown> = {}) =>
  make(
    LsSyncStatusItem,
    {
      lenderId: LENDER_A,
      connection: {
        id: '0190a000-0000-7000-8000-000000000b01',
        lenderId: LENDER_A,
        kind: 'file_import',
        status: 'active',
        providerMode: 'production',
        capabilities: { receipts: true, schedule: true },
        stalenessThresholdMinutes: 1440,
        lastSuccessAt: '2026-10-16T09:30:00.000000+00:00',
        updatedAt: '2026-10-16T09:30:00.000000+00:00',
      },
      loans: { total: 120, neverReported: 3, stale: 7, withOpenConflict: 2, withWarning: 4 },
      newestReportedAsOf: '2026-10-16T09:00:00.000000+00:00',
    },
    over,
  );

export const ok = <T>(data: T) => ({ ok: true as const, status: 200, data });
export const fail = (status: number, code = 'internal_failure') => ({
  ok: false as const,
  status,
  code,
});
export const page = <T>(items: T[], nextCursor: string | null = null) => ok({ items, nextCursor });

/**
 * An API that records every write and answers it with `answer`. A read is answered from `reads` (by exact path) or with a
 * 404, and every read path is recorded.
 */
export function recordingApi(answer: unknown = {}, readAnswers: Record<string, unknown> = {}) {
  const calls: { path: string; body: unknown; key: string }[] = [];
  const reads: string[] = [];
  const api: OnboardingApi = {
    get: (path) => {
      reads.push(path);
      return Promise.resolve(
        Object.hasOwn(readAnswers, path)
          ? { ok: true as const, status: 200, data: readAnswers[path] as never }
          : { ok: false as const, status: 404, code: 'not_found' },
      );
    },
    post: (path, _schema, body, key) => {
      calls.push({ path, body, key });
      return Promise.resolve({ ok: true as const, status: 200, data: answer as never });
    },
  };
  return { api, calls, reads };
}

/** Builds a form the way the browser sends it. */
export function formOf(fields: Record<string, string | string[] | File>): FormData {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    if (Array.isArray(value)) for (const v of value) form.append(name, v);
    else form.set(name, value);
  }
  return form;
}
