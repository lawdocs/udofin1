import {
  type SvcActivityEntry,
  type SvcClosure,
  type SvcDocumentRequest,
  type SvcLoan,
  type SvcLoanDocument,
  type SvcQuote,
  type SvcReminder,
} from '../src/borrower/servicing-types';

/** Fixed, synthetic values for the loan-screen tests. Nothing here is a real person, loan, account or credential. */
export const LOAN_ID = '0f0f0f0f-0000-4000-8000-000000000001';
export const DOC_ID = '0f0f0f0f-0000-4000-8000-000000000002';
export const REQUEST_ID = '0f0f0f0f-0000-4000-8000-000000000003';
export const PAYMENT_ID = '0f0f0f0f-0000-4000-8000-000000000004';
export const LENDER_ID = '0f0f0f0f-0000-4000-8000-000000000005';
export const OTHER_ID = '0f0f0f0f-0000-4000-8000-000000000006';
export const LENDER = 'Sample Finance Ltd';

/** 2026-10-18 09:00:00 UTC is 14:30 in India. The API prints microseconds and an offset. */
export const REPORTED_AT = '2026-10-18T09:00:00.123456+00:00';
export const REPORTED_AT_TEXT = '18 Oct 2026, 14:30 IST';

export const loan = (patch: Partial<SvcLoan> = {}): SvcLoan => ({
  loanId: LOAN_ID,
  lenderId: LENDER_ID,
  lenderDisplayName: LENDER,
  lenderLoanRef: 'SAMPLE-LN-0001',
  loanStatus: 'active',
  sanctionedAmountMinor: 50_000_000,
  disbursedAmountMinor: 50_000_000,
  disbursedAt: '2026-04-01T05:00:00.000000+00:00',
  reportedAsOf: REPORTED_AT,
  receivedAt: '2026-10-18T09:05:00.000000+00:00',
  stale: false,
  staleThresholdMinutes: 1440,
  figuresAvailable: true,
  reportedStatus: 'active',
  outstandingPrincipalMinor: 123_456_78,
  overduePrincipalMinor: 0,
  overdueInterestMinor: 0,
  penalChargesMinor: 0,
  otherChargesMinor: 0,
  totalOverdueMinor: 0,
  nextDueOn: '2026-11-05',
  nextDueMinor: 4_567_000,
  daysPastDue: 0,
  ...patch,
});

/** A loan whose figures are withheld: the contract requires every figure to be null. */
export const withheldLoan = (patch: Partial<SvcLoan> = {}): SvcLoan =>
  loan({
    figuresAvailable: false,
    reportedStatus: null,
    outstandingPrincipalMinor: null,
    overduePrincipalMinor: null,
    overdueInterestMinor: null,
    penalChargesMinor: null,
    otherChargesMinor: null,
    totalOverdueMinor: null,
    nextDueOn: null,
    nextDueMinor: null,
    daysPastDue: null,
    ...patch,
  });

export const overdueLoan = (): SvcLoan =>
  loan({
    overduePrincipalMinor: 3_000_000,
    overdueInterestMinor: 125_050,
    penalChargesMinor: 777_777,
    otherChargesMinor: 888_888,
    totalOverdueMinor: 4_791_715,
    daysPastDue: 12,
  });

export const entry = (patch: Partial<SvcActivityEntry> = {}): SvcActivityEntry => ({
  entryKind: 'payment_attempt',
  entryId: PAYMENT_ID,
  sortAt: '2026-10-17T10:00:00.123456+00:00',
  occurredOn: '2026-10-17',
  amountMinor: 4_567_000,
  state: 'started',
  purpose: 'installment',
  ...patch,
});

export const document = (patch: Partial<SvcLoanDocument> = {}): SvcLoanDocument => ({
  documentId: DOC_ID,
  kind: 'statement',
  issuer: 'lender',
  lenderReference: 'STM-2026-0001',
  issuedAt: '2026-10-10T06:00:00.000000+00:00',
  periodFrom: '2026-04-01',
  periodTo: '2026-09-30',
  sizeBytes: 1200,
  source: 'lender_upload',
  supersededById: null,
  ...patch,
});

export const request = (patch: Partial<SvcDocumentRequest> = {}): SvcDocumentRequest => ({
  requestId: REQUEST_ID,
  kind: 'statement',
  status: 'requested',
  periodFrom: null,
  periodTo: null,
  requestedAt: '2026-10-15T04:30:00.000000+00:00',
  dueBy: '2026-10-25T12:00:00.000000+00:00',
  dueRuleKey: 'statement.default',
  dueEvidenceStatus: 'unverified',
  lenderNote: null,
  decidedAt: null,
  fulfilledDocumentId: null,
  fulfilledQuoteId: null,
  ...patch,
});

export const quote = (patch: Partial<SvcQuote> = {}): SvcQuote => ({
  quoteId: OTHER_ID,
  lenderQuoteRef: 'FQ-0001',
  asOf: '2026-10-18T05:00:00.000000+00:00',
  validUntil: '2026-10-25T12:30:00.000000+00:00',
  principalMinor: 40_000_000,
  interestMinor: 150_000,
  chargesMinor: 25_000,
  prepaymentChargeMinor: 100_000,
  totalMinor: 40_275_000,
  totalMismatch: false,
  source: 'lender_portal',
  letterDocumentId: null,
  ...patch,
});

export const closure = (patch: Partial<SvcClosure> = {}): SvcClosure => ({
  loanId: LOAN_ID,
  lenderDisplayName: LENDER,
  loanStatus: 'closed',
  closureKind: 'closed',
  closureRecordedAt: '2026-10-18T09:00:00.000000+00:00',
  nocStatus: 'pending',
  nocStatusSource: 'lender',
  nocPromptKey: 'closure.noc.lender_to_issue',
  nocDueBy: '2026-11-01T12:00:00.000000+00:00',
  nocDueBasis: { ruleKey: 'noc.default', ruleVersion: 1, evidenceStatus: 'unverified' },
  nocDocumentId: null,
  nocIssuedAt: null,
  securityReleaseTasks: [],
  ...patch,
});

export const task = (
  patch: Partial<SvcClosure['securityReleaseTasks'][number]> = {},
): SvcClosure['securityReleaseTasks'][number] => ({
  taskId: '0f0f0f0f-0000-4000-8000-000000000007',
  collateralType: 'mutual_fund_lien',
  status: 'open',
  statusSource: 'lender',
  promptKey: 'closure.security_release.mutual_fund_lien.lender_to_release',
  lenderConfirmed: false,
  dueBy: '2026-11-17T12:00:00.000000+00:00',
  dueBasis: { ruleKey: 'security.default', ruleVersion: 1, evidenceStatus: 'confirmed' },
  delayReason: null,
  confirmedAt: null,
  ...patch,
});

export const reminder = (patch: Partial<SvcReminder> = {}): SvcReminder => ({
  reminderId: '0f0f0f0f-0000-4000-8000-000000000008',
  loanId: LOAN_ID,
  lenderDisplayName: LENDER,
  kind: 'pre_due',
  dueDate: '2026-11-05',
  sentAt: '2026-11-02T04:00:00.000000+00:00',
  message: 'Sample Finance Ltd: an instalment is due on 5 Nov 2026.',
  readAt: null,
  ...patch,
});
