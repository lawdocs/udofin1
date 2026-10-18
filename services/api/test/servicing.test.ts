// Unit tests for the borrower servicing routes and their wire contracts: the shape of the route table (who may call, idempotency,
// rate limits), and the contract's honesty rules (a withheld figure is null and never zero, money is integer paise, nothing outside
// the declared fields can leave the API). The database-backed behaviour is in test/integration/servicing.integration.test.ts.
import {
  SvcActivityEntry,
  SvcActivityQuery,
  SvcClosure,
  SvcContentQuery,
  SvcDocumentRequest,
  SvcLoan,
  SvcLoanDocument,
  SvcLoanDocumentContent,
  SvcLoanList,
  SvcQuote,
  SvcReminder,
  SvcSchedule,
  SvcSecurityReleaseTask,
  SvcStatementRequestInput,
} from '@udofin/contracts';
import { describe, expect, it } from 'vitest';
import { z, type ZodType } from 'zod';
import { servicingRoutes } from '../src/modules/servicing/routes.js';

const routes = servicingRoutes({});
const ID = '0199b2c4-7d3a-7000-8000-000000000001';
const ID2 = '0199b2c4-7d3a-7000-8000-000000000002';
const NOW = '2026-10-16T10:00:00.123456+00:00';

const loan = {
  loanId: ID,
  lenderId: ID2,
  lenderDisplayName: 'Alpha Servicing',
  lenderLoanRef: 'LN-1',
  loanStatus: 'active',
  sanctionedAmountMinor: 5_000_000,
  disbursedAmountMinor: 5_000_000,
  disbursedAt: NOW,
  reportedAsOf: NOW,
  receivedAt: NOW,
  stale: false,
  staleThresholdMinutes: 1440,
  figuresAvailable: true,
  reportedStatus: 'active',
  outstandingPrincipalMinor: 4_000_000,
  overduePrincipalMinor: 0,
  overdueInterestMinor: 0,
  penalChargesMinor: 0,
  otherChargesMinor: 0,
  totalOverdueMinor: 0,
  nextDueOn: '2026-11-01',
  nextDueMinor: 475_000,
  daysPastDue: 0,
};
const FIGURE_KEYS = [
  'reportedStatus',
  'outstandingPrincipalMinor',
  'overduePrincipalMinor',
  'overdueInterestMinor',
  'penalChargesMinor',
  'otherChargesMinor',
  'totalOverdueMinor',
  'nextDueOn',
  'nextDueMinor',
  'daysPastDue',
] as const;
const withheld = {
  ...loan,
  figuresAvailable: false,
  ...Object.fromEntries(FIGURE_KEYS.map((k) => [k, null])),
};

describe('the borrower servicing route table', () => {
  const expected = [
    'get /v1/loans',
    'get /v1/loans/:id',
    'get /v1/loans/:id/schedule',
    'get /v1/loans/:id/activity',
    'get /v1/loans/:id/documents',
    'get /v1/loans/:id/documents/:docId/content',
    'post /v1/loans/:id/statements',
    'post /v1/loans/:id/foreclosure-quotes',
    'get /v1/loans/:id/foreclosure-quotes/latest',
    'get /v1/loans/:id/document-requests',
    'post /v1/loans/:id/document-requests/:requestId/cancel',
    'get /v1/loans/:id/closure',
    'get /v1/me/reminders',
    'post /v1/me/reminders/:id/read',
  ];

  it('has exactly the routes of the brief, once each', () => {
    expect(routes.map((r) => `${r.method} ${r.path}`).sort()).toEqual([...expected].sort());
  });

  it('serves the signed-in borrower only', () => {
    for (const route of routes)
      expect([route.operationId, route.auth]).toEqual([route.operationId, 'borrower']);
  });

  it('makes every POST idempotent and no GET', () => {
    for (const route of routes) {
      if (route.auth === 'none') throw new Error('a public route in the borrower servicing table');
      expect([route.operationId, route.idempotent === true]).toEqual([
        route.operationId,
        route.method === 'post',
      ]);
    }
  });

  it('rate-limits every route, and writes harder than reads', () => {
    for (const route of routes) {
      expect(route.rateLimit, route.operationId).toBeTruthy();
      if (!route.rateLimit) continue;
      expect(route.rateLimit.max, route.operationId).toBeGreaterThan(0);
      if (route.method === 'post')
        expect(route.rateLimit.max, route.operationId).toBeLessThanOrEqual(30);
    }
  });

  it('declares a response schema for every success status it can return and a unique operation id', () => {
    const operations = routes.map((r) => r.operationId);
    expect(new Set(operations).size).toBe(operations.length);
    for (const route of routes) {
      expect(Object.keys(route.responses).length, route.operationId).toBeGreaterThan(0);
      expect(route.tags, route.operationId).toEqual(['Servicing']);
      expect(route.summary.length, route.operationId).toBeGreaterThan(10);
    }
  });

  it('opens a document through the store only: without one the content route would answer 503, the list needs none', () => {
    const content = routes.find((r) => r.operationId === 'downloadMyLoanDocument');
    expect(content?.errors).toContain(503);
    expect(routes.find((r) => r.operationId === 'listMyLoanDocuments')?.errors).not.toContain(503);
  });
});

describe('the loan contract', () => {
  it('accepts a loan with its figures', () => {
    expect(SvcLoan.safeParse(loan).success).toBe(true);
  });

  it('accepts a loan whose figures are withheld when every figure is null', () => {
    expect(SvcLoan.safeParse(withheld).success).toBe(true);
    expect(SvcLoanList.safeParse({ items: [loan, withheld] }).success).toBe(true);
  });

  it('refuses a withheld loan that carries any figure, and zero is not null', () => {
    for (const key of FIGURE_KEYS) {
      const value = key === 'nextDueOn' ? '2026-11-01' : key === 'reportedStatus' ? 'active' : 0;
      const result = SvcLoan.safeParse({ ...withheld, [key]: value });
      expect([key, result.success]).toEqual([key, false]);
    }
  });

  it('keeps money in integer paise within the database limits', () => {
    for (const bad of [-1, 1.5, 100_000_000_000_001, '5000000', Number.NaN, null]) {
      expect([bad, SvcLoan.safeParse({ ...loan, sanctionedAmountMinor: bad }).success]).toEqual([
        bad,
        false,
      ]);
    }
    expect(SvcLoan.safeParse({ ...loan, sanctionedAmountMinor: 100_000_000_000_000 }).success).toBe(
      true,
    );
  });

  it('refuses a field it does not declare', () => {
    expect(SvcLoan.safeParse({ ...loan, bankReference: 'X' }).success).toBe(false);
    expect(SvcLoan.safeParse({ ...loan, borrowerId: ID }).success).toBe(false);
  });

  it('refuses a status or time outside its vocabulary', () => {
    expect(SvcLoan.safeParse({ ...loan, loanStatus: 'disbursed' }).success).toBe(false);
    expect(SvcLoan.safeParse({ ...loan, reportedAsOf: '2026-10-16 10:00:00' }).success).toBe(false);
    expect(SvcLoan.safeParse({ ...loan, reportedAsOf: '2026-10-16T10:00:00' }).success).toBe(false);
  });
});

describe('the other contracts', () => {
  it('declares the schedule empty with a null version', () => {
    expect(
      SvcSchedule.safeParse({ scheduleVersion: null, reportedAsOf: null, installments: [] })
        .success,
    ).toBe(true);
    expect(
      SvcSchedule.safeParse({ scheduleVersion: 0, reportedAsOf: null, installments: [] }).success,
    ).toBe(false);
  });

  it('allows an activity entry to carry no amount, and refuses an unknown kind or state', () => {
    const entry = {
      entryKind: 'payment_attempt',
      entryId: ID,
      sortAt: NOW,
      occurredOn: '2026-10-16',
      amountMinor: 475_000,
      state: 'started',
      purpose: 'installment',
    };
    expect(SvcActivityEntry.safeParse(entry).success).toBe(true);
    expect(SvcActivityEntry.safeParse({ ...entry, entryKind: 'bank_transfer' }).success).toBe(
      false,
    );
    expect(SvcActivityEntry.safeParse({ ...entry, state: 'settled' }).success).toBe(false);
    expect(SvcActivityEntry.safeParse({ ...entry, paymentMode: 'upi' }).success).toBe(false);
    expect(SvcActivityEntry.safeParse({ ...entry, bankReference: 'UTR' }).success).toBe(false);
  });

  it('bounds the page size at 50 with a default of 25, and ignores nothing it does not declare', () => {
    expect(SvcActivityQuery.parse({}).limit).toBe(25);
    expect(SvcActivityQuery.parse({ limit: '50' }).limit).toBe(50);
    for (const limit of ['0', '51', '-1', '1.5', 'x'])
      expect([limit, SvcActivityQuery.safeParse({ limit }).success]).toEqual([limit, false]);
    expect(SvcActivityQuery.safeParse({ extra: '1' }).success).toBe(false);
    expect(SvcActivityQuery.safeParse({ cursor: 'x'.repeat(301) }).success).toBe(false);
    expect(SvcContentQuery.parse({}).purpose).toBe('view');
    expect(SvcContentQuery.safeParse({ purpose: 'edit' }).success).toBe(false);
  });

  it('takes a statement request with both ends of the period, one, or none, as dates only', () => {
    expect(SvcStatementRequestInput.safeParse({}).success).toBe(true);
    expect(
      SvcStatementRequestInput.safeParse({ periodFrom: '2026-01-01', periodTo: '2026-03-31' })
        .success,
    ).toBe(true);
    expect(SvcStatementRequestInput.safeParse({ periodFrom: '2026-01-01T00:00:00Z' }).success).toBe(
      false,
    );
    expect(SvcStatementRequestInput.safeParse({ periodFrom: 20260101 }).success).toBe(false);
    expect(SvcStatementRequestInput.safeParse({ extra: true }).success).toBe(false);
  });

  it('lists a document without its hash or storage key, and gives the content only with the checksum the API verified', () => {
    const document = {
      documentId: ID,
      kind: 'statement',
      issuer: 'lender',
      lenderReference: 'S-1',
      issuedAt: NOW,
      periodFrom: '2026-01-01',
      periodTo: '2026-03-31',
      sizeBytes: 1200,
      source: 'lender_upload',
      supersededById: null,
    };
    expect(SvcLoanDocument.safeParse(document).success).toBe(true);
    expect(SvcLoanDocument.safeParse({ ...document, issuer: 'udofin' }).success).toBe(false);
    expect(SvcLoanDocument.safeParse({ ...document, sha256: 'a'.repeat(64) }).success).toBe(false);
    expect(SvcLoanDocument.safeParse({ ...document, storageKey: 'servicing/x' }).success).toBe(
      false,
    );
    const content = {
      documentId: ID,
      loanId: ID2,
      kind: 'statement',
      lenderReference: 'S-1',
      mimeType: 'application/pdf',
      sizeBytes: 1200,
      sha256: 'a'.repeat(64),
      source: 'lender_upload',
      contentBase64: 'JVBERg==',
    };
    expect(SvcLoanDocumentContent.safeParse(content).success).toBe(true);
    expect(SvcLoanDocumentContent.safeParse({ ...content, sha256: 'A'.repeat(64) }).success).toBe(
      false,
    );
    expect(SvcLoanDocumentContent.safeParse({ ...content, mimeType: 'text/html' }).success).toBe(
      false,
    );
  });

  it("declares a request with its due date, the rule it came from and the rule's evidence label", () => {
    const request = {
      requestId: ID,
      kind: 'statement',
      status: 'requested',
      periodFrom: null,
      periodTo: null,
      requestedAt: NOW,
      dueBy: NOW,
      dueRuleKey: 'servicing.statement_sla_days_default',
      dueEvidenceStatus: 'unverified',
      lenderNote: null,
      decidedAt: null,
      fulfilledDocumentId: null,
      fulfilledQuoteId: null,
    };
    expect(SvcDocumentRequest.safeParse(request).success).toBe(true);
    expect(
      SvcDocumentRequest.safeParse({ ...request, dueEvidenceStatus: 'verified' }).success,
    ).toBe(false);
    expect(SvcDocumentRequest.safeParse({ ...request, status: 'approved' }).success).toBe(false);
    expect(SvcDocumentRequest.safeParse({ ...request, requestedBy: ID }).success).toBe(false);
  });

  it('flags a quotation whose parts do not add up instead of correcting it', () => {
    const quote = {
      quoteId: ID,
      lenderQuoteRef: 'Q-1',
      asOf: NOW,
      validUntil: NOW,
      principalMinor: 1_000_000,
      interestMinor: 50_000,
      chargesMinor: 10_000,
      prepaymentChargeMinor: 20_000,
      totalMinor: 1_090_000,
      totalMismatch: true,
      source: 'lender_portal',
      letterDocumentId: null,
    };
    expect(SvcQuote.safeParse(quote).success).toBe(true);
    const { totalMismatch: _flag, ...withoutFlag } = quote;
    expect(SvcQuote.safeParse(withoutFlag).success).toBe(false);
    expect(SvcQuote.safeParse({ ...quote, totalMinor: -1 }).success).toBe(false);
  });

  it('only lets a prompt key say that the lender confirmed a release, never that anything was released', () => {
    const task = {
      taskId: ID,
      collateralType: 'mutual_fund_lien',
      status: 'confirmed_by_lender',
      statusSource: 'lender',
      promptKey: 'closure.security_release.mutual_fund_lien.lender_confirmed',
      lenderConfirmed: true,
      dueBy: null,
      dueBasis: null,
      delayReason: null,
      confirmedAt: NOW,
    };
    expect(SvcSecurityReleaseTask.safeParse(task).success).toBe(true);
    expect(
      SvcSecurityReleaseTask.safeParse({
        ...task,
        promptKey: 'closure.security_release.mutual_fund_lien.released',
      }).success,
    ).toBe(false);
    expect(
      SvcSecurityReleaseTask.safeParse({
        ...task,
        promptKey: 'closure.security_release.mutual_fund_lien.udofin_released',
      }).success,
    ).toBe(false);
    expect(SvcSecurityReleaseTask.safeParse({ ...task, statusSource: 'udofin' }).success).toBe(
      false,
    );
    expect(SvcSecurityReleaseTask.safeParse({ ...task, collateralType: 'gold' }).success).toBe(
      false,
    );
    const closure = {
      loanId: ID,
      lenderDisplayName: 'Alpha Servicing',
      loanStatus: 'closed',
      closureKind: 'closed',
      closureRecordedAt: NOW,
      nocStatus: 'pending',
      nocStatusSource: 'lender',
      nocPromptKey: 'closure.noc.lender_to_issue',
      nocDueBy: null,
      nocDueBasis: null,
      nocDocumentId: null,
      nocIssuedAt: null,
      securityReleaseTasks: [task],
    };
    expect(SvcClosure.safeParse(closure).success).toBe(true);
    expect(
      SvcClosure.safeParse({ ...closure, nocPromptKey: 'closure.noc.issued_by_udofin' }).success,
    ).toBe(false);
    expect(SvcClosure.safeParse({ ...closure, nocStatusSource: 'udofin' }).success).toBe(false);
  });

  it('carries a reminder as the wording that was sent, with the time it was read', () => {
    const reminder = {
      reminderId: ID,
      loanId: ID2,
      lenderDisplayName: 'Alpha Servicing',
      kind: 'pre_due',
      dueDate: '2026-11-01',
      sentAt: NOW,
      message:
        'Reminder from Alpha Servicing: your instalment of Rs 4,750.00 is due on 01 Nov 2026.',
      readAt: null,
    };
    expect(SvcReminder.safeParse(reminder).success).toBe(true);
    expect(SvcReminder.safeParse({ ...reminder, kind: 'offer' }).success).toBe(false);
    expect(SvcReminder.safeParse({ ...reminder, channel: 'push' }).success).toBe(false);
  });

  it('names no bank reference, payment mode, provider reference, storage key, phone number or user in any response schema', () => {
    const responses: Record<string, ZodType> = Object.fromEntries(
      routes.flatMap((route) =>
        Object.entries(route.responses).map(([status, schema]) => [
          `${route.operationId} ${status}`,
          schema,
        ]),
      ),
    );
    const names = (schema: ZodType): string[] => {
      const json = z.toJSONSchema(schema, {
        target: 'draft-2020-12',
        io: 'output',
        unrepresentable: 'any',
      });
      const found: string[] = [];
      const walk = (node: unknown) => {
        if (Array.isArray(node)) node.forEach(walk);
        else if (node && typeof node === 'object') {
          for (const [key, value] of Object.entries(node) as [string, unknown][]) {
            if (key === 'properties' && value !== null && typeof value === 'object')
              found.push(...Object.keys(value));
            walk(value);
          }
        }
      };
      walk(json);
      return found;
    };
    const forbidden =
      /bank|payment_?mode|provider|storage|settlement|uploaded|idempotency|phone|account(?!s)|confirmation_?ref|recorded_?by|requested_?by|borrower_?id/i;
    for (const [operation, schema] of Object.entries(responses)) {
      for (const name of names(schema))
        expect([operation, name, forbidden.test(name)]).toEqual([operation, name, false]);
    }
  });
});
