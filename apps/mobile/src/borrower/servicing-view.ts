import { type Language, type MessageKey } from '../i18n';
import {
  formatAmount,
  formatDateOnly,
  formatInstantDay,
  formatReportedAt,
  isCalendarDate,
} from './servicing-format';
import {
  type SvcActivityEntry,
  type SvcActivityPage,
  type SvcClosure,
  type SvcDocumentRequest,
  type SvcLoan,
  type SvcLoanDocument,
  type SvcQuote,
  type SvcReminder,
  type SvcSchedule,
} from './servicing-types';

/**
 * What the loan screens say, as plain data. A screen draws these descriptions and decides nothing; every sentence is a message
 * key with its values, so both languages and the tests read the same thing.
 *
 * The rules that make this file the place they are kept:
 *  - A figure is the lender's, shown as reported with the lender's time. Nothing is added, rounded, totalled, compared or
 *    inferred. A figure that is `null` is "not reported" or "being checked", never zero.
 *  - Withheld figures (the API says `figuresAvailable: false`) produce NO amount at all.
 *  - Overdue shows the lender's overdue figures and nothing about charges: the lender's approved penal-charge sentence is not on
 *    these routes, so this app shows no charge figure of its own (the pay screen and the reminders carry the lender's sentence).
 *  - A stage is a word from the API's closed list. A word this app does not know becomes a neutral sentence, never a guess,
 *    and nothing here ever says "paid" or "successful".
 */

export interface TextRef {
  key: MessageKey;
  vars?: Record<string, string | number>;
}
const ref = (key: MessageKey, vars?: Record<string, string | number>): TextRef =>
  vars ? { key, vars } : { key };

/** A label with a word that is itself a message ("Loan status" and "Active"): drawn as "<label>: <word>". */
export interface LabelledWord {
  label: TextRef;
  value: TextRef;
}

/** A line of the form "<label>: <value>". A null value is drawn as "not reported by <lender>", never as zero. */
export interface FigureRow {
  label: TextRef;
  value: string | null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Where the buttons go. The pay and mandate screens belong to the payments builder; these are the exact params they expect.
// ---------------------------------------------------------------------------------------------------------------------
export const payHref = (loanId: string) =>
  ({ pathname: '/payments/pay', params: { loanId } }) as const;
export const payQuotationHref = (loanId: string) =>
  ({ pathname: '/payments/pay', params: { loanId, purpose: 'foreclosure' } }) as const;
export const mandateSetupHref = (loanId: string) =>
  ({ pathname: '/payments/mandate-setup', params: { loanId } }) as const;
export const paymentStatusHref = (paymentId: string) =>
  ({ pathname: '/payments/status', params: { paymentId } }) as const;

/** The path and query of a link, for tests and logs that want to see the address a button opens. */
export function hrefToUrl(href: { pathname: string; params: Record<string, string> }): string {
  const query = Object.entries(href.params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  return query ? `${href.pathname}?${query}` : href.pathname;
}

// ---------------------------------------------------------------------------------------------------------------------
// Loan status
// ---------------------------------------------------------------------------------------------------------------------
const LOAN_STATUS_KEYS = {
  active: 'loans.status.active',
  closed: 'loans.status.closed',
  foreclosed: 'loans.status.foreclosed',
  written_off: 'loans.status.written_off',
  cancelled: 'loans.status.cancelled',
} as const satisfies Record<SvcLoan['loanStatus'], MessageKey>;

export function loanStatusKey(status: string): MessageKey {
  return (LOAN_STATUS_KEYS as Record<string, MessageKey>)[status] ?? 'loans.status.unknown';
}

// ---------------------------------------------------------------------------------------------------------------------
// The figures of a loan
// ---------------------------------------------------------------------------------------------------------------------
export interface OverdueModel {
  title: TextRef;
  rows: FigureRow[];
  note: TextRef;
}
export type FiguresModel =
  | { kind: 'withheld'; notice: TextRef }
  | {
      kind: 'shown';
      attribution: TextRef;
      /** Set when the API says the report is old. A plain notice, never an alarm. */
      staleNotice: TextRef | null;
      rows: FigureRow[];
      overdue: OverdueModel | null;
    };

const money = (value: number | null): string | null =>
  value === null ? null : formatAmount(value);

/**
 * The figures of one loan exactly as the API sent them. They are shown only when the API says they are available AND the
 * lender's report time is known and readable, because a figure that cannot say who reported it and when is not shown.
 */
export function figuresModel(loan: SvcLoan, language: Language): FiguresModel {
  const lender = loan.lenderDisplayName;
  const reportedAt =
    loan.reportedAsOf === null ? '' : formatReportedAt(loan.reportedAsOf, language);
  if (!loan.figuresAvailable || reportedAt === '') {
    return { kind: 'withheld', notice: ref('loans.fig.withheld', { lender }) };
  }
  const rows: FigureRow[] = [
    { label: ref('loans.fig.outstanding'), value: money(loan.outstandingPrincipalMinor) },
    {
      label: ref('loans.fig.nextDueOn'),
      value: loan.nextDueOn === null ? null : formatDateOnly(loan.nextDueOn, language) || null,
    },
    { label: ref('loans.fig.nextDueAmount'), value: money(loan.nextDueMinor) },
  ];
  // The overdue block appears when the lender reported something overdue. Only the overdue amounts and the days are shown:
  // no charge figure is drawn, because the lender's approved penal-charge sentence is not part of this answer.
  const reportedOverdue = [
    loan.overduePrincipalMinor,
    loan.overdueInterestMinor,
    loan.totalOverdueMinor,
    loan.daysPastDue,
  ].some((value) => value !== null && value > 0);
  const overdue: OverdueModel | null = reportedOverdue
    ? {
        title: ref('loans.fig.overdueTitle', { lender }),
        rows: [
          { label: ref('loans.fig.overduePrincipal'), value: money(loan.overduePrincipalMinor) },
          { label: ref('loans.fig.overdueInterest'), value: money(loan.overdueInterestMinor) },
          { label: ref('loans.fig.totalOverdue'), value: money(loan.totalOverdueMinor) },
          {
            label: ref('loans.fig.daysPastDue'),
            value: loan.daysPastDue === null ? null : String(loan.daysPastDue),
          },
        ],
        note: ref('loans.fig.overdueNote'),
      }
    : null;
  return {
    kind: 'shown',
    attribution: ref('loans.fig.asReported', { lender, date: reportedAt }),
    staleNotice: loan.stale ? ref('loans.fig.stale', { lender, date: reportedAt }) : null,
    rows,
    overdue,
  };
}

export interface LoanHomeModel {
  loanId: string;
  lender: string;
  reference: TextRef;
  /** "Loan status: Active". The status held here follows the lender's reports forward only. */
  status: LabelledWord;
  /** Set only when the lender's latest report names a status other than the one held here. */
  reportedStatus: LabelledWord | null;
  statusNote: TextRef | null;
  facts: TextRef[];
  figures: FiguresModel;
}

export function loanHomeModel(loan: SvcLoan, language: Language): LoanHomeModel {
  const lender = loan.lenderDisplayName;
  const facts: TextRef[] = [
    ref('loans.fact.sanctioned', { amount: formatAmount(loan.sanctionedAmountMinor) }),
  ];
  if (loan.disbursedAmountMinor !== null) {
    facts.push(ref('loans.fact.disbursed', { amount: formatAmount(loan.disbursedAmountMinor) }));
  }
  // Both are the lender's own words about the loan: the status held here follows the lender's reports forward only.
  const figures = figuresModel(loan, language);
  const differs =
    figures.kind === 'shown' &&
    loan.reportedStatus !== null &&
    loan.reportedStatus !== loan.loanStatus;
  return {
    loanId: loan.loanId,
    lender,
    reference: ref('loans.card.reference', { ref: loan.lenderLoanRef }),
    status: { label: ref('loans.status.label'), value: ref(loanStatusKey(loan.loanStatus)) },
    reportedStatus:
      differs && loan.reportedStatus !== null
        ? {
            label: ref('loans.status.reportedBy', { lender }),
            value: ref(loanStatusKey(loan.reportedStatus)),
          }
        : null,
    statusNote:
      loan.loanStatus === 'written_off' ? ref('loans.status.writtenOffNote', { lender }) : null,
    facts,
    figures,
  };
}

export interface LoanCardModel {
  loanId: string;
  lender: string;
  reference: TextRef;
  status: LabelledWord;
  /** The next due line when the lender's figures are shown; otherwise the withheld notice. */
  summary: TextRef[];
}

/** The short version of a loan for the list: who, what status, and either the next due date or the withheld notice. */
export function loanCardModel(loan: SvcLoan, language: Language): LoanCardModel {
  const figures = figuresModel(loan, language);
  const lender = loan.lenderDisplayName;
  const summary: TextRef[] = [];
  if (figures.kind === 'withheld') {
    summary.push(figures.notice);
  } else {
    const nextDue = loan.nextDueOn === null ? '' : formatDateOnly(loan.nextDueOn, language);
    summary.push(
      nextDue !== ''
        ? ref('loans.card.nextDue', { date: nextDue })
        : ref('loans.card.nextDueNone', { lender }),
    );
    if (loan.nextDueMinor !== null) {
      summary.push(ref('loans.card.nextDueAmount', { amount: formatAmount(loan.nextDueMinor) }));
    }
    summary.push(figures.attribution);
    if (figures.staleNotice) summary.push(figures.staleNotice);
  }
  return {
    loanId: loan.loanId,
    lender,
    reference: ref('loans.card.reference', { ref: loan.lenderLoanRef }),
    status: { label: ref('loans.status.label'), value: ref(loanStatusKey(loan.loanStatus)) },
    summary,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------------------------------------------------
export interface ScheduleRow {
  seq: number;
  title: TextRef;
  lines: TextRef[];
}
export type ScheduleModel =
  | { kind: 'none'; notice: TextRef }
  | { kind: 'rows'; attribution: TextRef | null; note: TextRef; rows: ScheduleRow[] };

/** The lender's installments as reported. No instalment status is shown or worked out: the app allocates nothing. */
export function scheduleModel(
  schedule: SvcSchedule,
  lender: string,
  language: Language,
): ScheduleModel {
  if (schedule.scheduleVersion === null || schedule.installments.length === 0) {
    return { kind: 'none', notice: ref('loans.schedule.none', { lender }) };
  }
  const reportedAt =
    schedule.reportedAsOf === null ? '' : formatReportedAt(schedule.reportedAsOf, language);
  return {
    kind: 'rows',
    attribution:
      reportedAt === '' ? null : ref('loans.schedule.asReported', { lender, date: reportedAt }),
    note: ref('loans.schedule.note', { lender }),
    rows: schedule.installments.map((i) => ({
      seq: i.seq,
      title: ref('loans.schedule.row', { seq: i.seq, date: formatDateOnly(i.dueDate, language) }),
      lines: [
        ref('loans.schedule.principal', { amount: formatAmount(i.principalMinor) }),
        ref('loans.schedule.interest', { amount: formatAmount(i.interestMinor) }),
        ref('loans.schedule.fees', { amount: formatAmount(i.feesMinor) }),
        ref('loans.schedule.total', { amount: formatAmount(i.totalMinor) }),
      ],
    })),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------------------------------------------------
const ACTIVITY_KIND_KEYS = {
  lender_receipt: 'loans.activity.kind.lender_receipt',
  lender_reversal: 'loans.activity.kind.lender_reversal',
  payment_attempt: 'loans.activity.kind.payment_attempt',
  payment_adjustment: 'loans.activity.kind.payment_adjustment',
} as const satisfies Record<SvcActivityEntry['entryKind'], MessageKey>;

/**
 * The closed list of stages the API reports. "received by the payment provider" is not "paid to the lender": only
 * `lender_posted` says the lender has posted it. There is deliberately no "paid", "successful" or "completed" anywhere.
 */
const ACTIVITY_STATE_KEYS = {
  started: 'loans.state.started',
  provider_received: 'loans.state.provider_received',
  lender_posted: 'loans.state.lender_posted',
  needs_attention: 'loans.state.needs_attention',
  cancelled: 'loans.state.cancelled',
  failed: 'loans.state.failed',
  expired: 'loans.state.expired',
  posted: 'loans.state.posted',
  reversed: 'loans.state.reversed',
  recorded: 'loans.state.recorded',
  refund: 'loans.state.refund',
  chargeback: 'loans.state.chargeback',
  reversal: 'loans.state.reversal',
  correction: 'loans.state.correction',
} as const satisfies Record<SvcActivityEntry['state'], MessageKey>;

const ACTIVITY_PURPOSE_KEYS = {
  installment: 'loans.purpose.installment',
  overdue: 'loans.purpose.overdue',
  part_prepayment: 'loans.purpose.part_prepayment',
  foreclosure: 'loans.purpose.foreclosure',
  charges: 'loans.purpose.charges',
} as const satisfies Record<NonNullable<SvcActivityEntry['purpose']>, MessageKey>;

/** The sentence for a stage. A stage this app version does not know says so plainly and invents nothing. */
export function activityStateRef(state: string, lender: string): TextRef {
  const key = (ACTIVITY_STATE_KEYS as Record<string, MessageKey>)[state];
  return key ? ref(key, { lender }) : ref('loans.state.unknown', { lender });
}

export interface ActivityRow {
  id: string;
  title: TextRef;
  purpose: TextRef | null;
  /** The date the entry is about (not the order it arrived in). */
  date: string;
  amount: TextRef;
  state: TextRef;
  /** Only a payment attempt has a status screen. */
  detail: ReturnType<typeof paymentStatusHref> | null;
}

export function activityRowModel(
  entry: SvcActivityEntry,
  lender: string,
  language: Language,
): ActivityRow {
  const kindKey = (ACTIVITY_KIND_KEYS as Record<string, MessageKey>)[entry.entryKind];
  const purposeKey =
    entry.purpose === null
      ? undefined
      : (ACTIVITY_PURPOSE_KEYS as Record<string, MessageKey>)[entry.purpose];
  return {
    id: entry.entryId,
    title: kindKey ? ref(kindKey, { lender }) : ref('loans.activity.kind.unknown'),
    purpose: purposeKey ? ref(purposeKey) : null,
    date: formatDateOnly(entry.occurredOn, language),
    amount:
      entry.amountMinor === null
        ? ref('loans.activity.amountNone')
        : ref('loans.activity.amount', { amount: formatAmount(entry.amountMinor) }),
    state: activityStateRef(entry.state, lender),
    detail: entry.entryKind === 'payment_attempt' ? paymentStatusHref(entry.entryId) : null,
  };
}

/**
 * Adds the next page after the entries already shown. An entry that is already there is not drawn twice (the API's paging
 * does not repeat entries; this only protects the screen if a retry delivered a page twice). The cursor stays opaque.
 */
export function appendActivityPage(
  shown: readonly SvcActivityEntry[],
  page: SvcActivityPage,
): { items: SvcActivityEntry[]; cursor: string | null } {
  const seen = new Set(shown.map((e) => e.entryId));
  const added = page.items.filter((e) => {
    if (seen.has(e.entryId)) return false;
    seen.add(e.entryId);
    return true;
  });
  return { items: [...shown, ...added], cursor: page.nextCursor };
}

// ---------------------------------------------------------------------------------------------------------------------
// Documents, requests and the foreclosure quotation
// ---------------------------------------------------------------------------------------------------------------------
const DOCUMENT_KIND_KEYS = {
  statement: 'loans.doc.kind.statement',
  foreclosure_quote: 'loans.doc.kind.foreclosure_quote',
  noc: 'loans.doc.kind.noc',
  closure_letter: 'loans.doc.kind.closure_letter',
} as const satisfies Record<SvcLoanDocument['kind'], MessageKey>;

export function documentKindKey(kind: string): MessageKey {
  return (DOCUMENT_KIND_KEYS as Record<string, MessageKey>)[kind] ?? 'loans.doc.kind.unknown';
}

export interface DocumentRowModel {
  id: string;
  title: TextRef;
  reference: TextRef;
  issued: TextRef;
  period: TextRef | null;
  notices: TextRef[];
  /** The file title handed to the device's PDF viewer. */
  viewerTitle: MessageKey;
}

export function documentRowModel(
  doc: SvcLoanDocument,
  lender: string,
  language: Language,
): DocumentRowModel {
  const notices: TextRef[] = [];
  if (doc.source === 'mock') notices.push(ref('loans.doc.mock'));
  if (doc.supersededById !== null) notices.push(ref('loans.doc.superseded', { lender }));
  const from = doc.periodFrom === null ? '' : formatDateOnly(doc.periodFrom, language);
  const to = doc.periodTo === null ? '' : formatDateOnly(doc.periodTo, language);
  return {
    id: doc.documentId,
    title: ref(documentKindKey(doc.kind), { lender }),
    reference: ref('loans.doc.reference', { ref: doc.lenderReference }),
    issued: ref('loans.doc.issued', { lender, date: formatReportedAt(doc.issuedAt, language) }),
    period: from !== '' && to !== '' ? ref('loans.doc.period', { from, to }) : null,
    notices,
    viewerTitle: documentKindKey(doc.kind),
  };
}

const REQUEST_STATUS_KEYS = {
  requested: 'loans.req.status.requested',
  fulfilled: 'loans.req.status.fulfilled',
  declined: 'loans.req.status.declined',
  expired: 'loans.req.status.expired',
  cancelled: 'loans.req.status.cancelled',
} as const satisfies Record<SvcDocumentRequest['status'], MessageKey>;

export interface RequestRowModel {
  id: string;
  title: TextRef;
  status: TextRef;
  requested: TextRef;
  period: TextRef | null;
  due: TextRef | null;
  dueNote: TextRef | null;
  /** The lender's own reason, shown as written and labelled as the lender's. */
  lenderNote: { label: TextRef; text: string } | null;
  /** Only an open request can be cancelled. */
  canCancel: boolean;
  fulfilledDocumentId: string | null;
  fulfilledQuoteId: string | null;
}

/**
 * One request. The date by which the lender is expected to answer comes from a platform setting that the API labels with an
 * evidence status. Only the date is shown, as a target and never as a regulatory deadline: any status but `confirmed` (and an
 * absent one) adds the plain sentence that it is a platform default. It is shown only while the request is open.
 */
export function requestRowModel(
  request: SvcDocumentRequest,
  lender: string,
  language: Language,
): RequestRowModel {
  const open = request.status === 'requested';
  const showDue =
    open && request.dueBy !== null && formatReportedAt(request.dueBy, language) !== '';
  const from = request.periodFrom === null ? '' : formatDateOnly(request.periodFrom, language);
  const to = request.periodTo === null ? '' : formatDateOnly(request.periodTo, language);
  return {
    id: request.requestId,
    title: ref(documentKindKey(request.kind), { lender }),
    status: ref(REQUEST_STATUS_KEYS[request.status], { lender }),
    requested: ref('loans.req.requestedOn', {
      date: formatReportedAt(request.requestedAt, language),
    }),
    period: from !== '' && to !== '' ? ref('loans.doc.period', { from, to }) : null,
    due:
      showDue && request.dueBy !== null
        ? ref('loans.due.target', { date: formatReportedAt(request.dueBy, language) })
        : null,
    dueNote:
      showDue && request.dueEvidenceStatus !== 'confirmed'
        ? ref('loans.due.default', { lender })
        : null,
    lenderNote:
      request.status === 'declined' && request.lenderNote
        ? { label: ref('loans.req.lenderNote', { lender }), text: request.lenderNote }
        : null,
    canCancel: open,
    fulfilledDocumentId: request.fulfilledDocumentId,
    fulfilledQuoteId: request.fulfilledQuoteId,
  };
}

/** The request of one kind that is still open, if any (the API allows one open request per kind and loan). */
export function openRequestOfKind(
  requests: readonly SvcDocumentRequest[],
  kind: SvcDocumentRequest['kind'],
): SvcDocumentRequest | null {
  return requests.find((r) => r.kind === kind && r.status === 'requested') ?? null;
}

export type PeriodParse =
  | { ok: true; period: { periodFrom: string; periodTo: string } | null }
  | { ok: false; error: 'incomplete' | 'invalid' };

/**
 * The optional statement period typed as two dates. Both or neither; each a real calendar day written YYYY-MM-DD. Whether the
 * period is in the future or backwards is the API's decision (`period_invalid`), not repeated here.
 */
export function parseStatementPeriod(from: string, to: string): PeriodParse {
  const a = from.trim();
  const b = to.trim();
  if (a === '' && b === '') return { ok: true, period: null };
  if (a === '' || b === '') return { ok: false, error: 'incomplete' };
  if (!isCalendarDate(a) || !isCalendarDate(b)) return { ok: false, error: 'invalid' };
  return { ok: true, period: { periodFrom: a, periodTo: b } };
}

export interface QuoteModel {
  quoteId: string;
  lender: string;
  attribution: TextRef;
  asOf: TextRef;
  /** A date and time, never a timer. */
  validUntil: TextRef;
  parts: FigureRow[];
  total: FigureRow;
  notices: TextRef[];
  /** False when the parts do not add up to the total: the app then offers no payment, only a request for a corrected one. */
  canPay: boolean;
  /** The flag the API sent, shown as a plain sentence. */
  mismatch: TextRef | null;
  letterDocumentId: string | null;
}

/** The lender's quotation, unchanged. The parts are never added up here and the total is never recomputed. */
export function quoteModel(quote: SvcQuote, lender: string, language: Language): QuoteModel {
  const notices: TextRef[] = [];
  if (quote.source === 'mock') notices.push(ref('loans.doc.mock'));
  return {
    quoteId: quote.quoteId,
    lender,
    attribution: ref('loans.quote.attribution', { lender, ref: quote.lenderQuoteRef }),
    asOf: ref('loans.quote.asOf', { date: formatReportedAt(quote.asOf, language) }),
    validUntil: ref('loans.quote.validUntil', {
      date: formatReportedAt(quote.validUntil, language),
    }),
    parts: [
      { label: ref('loans.quote.principal'), value: formatAmount(quote.principalMinor) },
      { label: ref('loans.quote.interest'), value: formatAmount(quote.interestMinor) },
      { label: ref('loans.quote.charges'), value: formatAmount(quote.chargesMinor) },
      { label: ref('loans.quote.prepayment'), value: formatAmount(quote.prepaymentChargeMinor) },
    ],
    total: { label: ref('loans.quote.total', { lender }), value: formatAmount(quote.totalMinor) },
    notices,
    canPay: !quote.totalMismatch,
    mismatch: quote.totalMismatch ? ref('loans.quote.mismatch', { lender }) : null,
    letterDocumentId: quote.letterDocumentId,
  };
}

/** Whether the opened file is the one asked for and has the size the API recorded. A file that fails is never handed to a viewer. */
export function documentContentProblem(
  content: { documentId: string; loanId: string; sizeBytes: number; contentBase64: string },
  expected: { loanId: string; documentId: string },
  byteLength: (base64: string) => number,
): 'wrong_document' | 'size_mismatch' | null {
  if (content.documentId !== expected.documentId || content.loanId !== expected.loanId)
    return 'wrong_document';
  if (byteLength(content.contentBase64) !== content.sizeBytes) return 'size_mismatch';
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Closure
// ---------------------------------------------------------------------------------------------------------------------
const SECURITY_KEYS = {
  mutual_fund_lien: {
    pending: 'loans.closure.sec.mutual_fund_lien.pending',
    confirmed: 'loans.closure.sec.mutual_fund_lien.confirmed',
  },
  demat_pledge: {
    pending: 'loans.closure.sec.demat_pledge.pending',
    confirmed: 'loans.closure.sec.demat_pledge.confirmed',
  },
  property_documents: {
    pending: 'loans.closure.sec.property_documents.pending',
    confirmed: 'loans.closure.sec.property_documents.confirmed',
  },
  vehicle_hypothecation: {
    pending: 'loans.closure.sec.vehicle_hypothecation.pending',
    confirmed: 'loans.closure.sec.vehicle_hypothecation.confirmed',
  },
  other: {
    pending: 'loans.closure.sec.other.pending',
    confirmed: 'loans.closure.sec.other.confirmed',
  },
} as const satisfies Record<string, { pending: MessageKey; confirmed: MessageKey }>;

const SECURITY_PROMPT =
  /^closure\.security_release\.([a-z_]+)\.(lender_to_release|lender_confirmed)$/;

export interface ClosureItem {
  id: string;
  heading: TextRef;
  /** What the lender has reported. Says "confirmed" only when the lender confirmed it. */
  line: TextRef;
  confirmed: boolean;
  due: TextRef | null;
  dueNote: TextRef | null;
  delay: { label: TextRef; text: string } | null;
  confirmedOn: TextRef | null;
  /** The no-dues letter, when the lender attached one. */
  documentId: string | null;
}

function dueRefs(
  dueBy: string | null,
  basis: { evidenceStatus: string } | null,
  lender: string,
  language: Language,
): { due: TextRef | null; dueNote: TextRef | null } {
  const text = dueBy === null ? '' : formatReportedAt(dueBy, language);
  if (text === '') return { due: null, dueNote: null };
  return {
    due: ref('loans.due.target', { date: text }),
    dueNote: basis?.evidenceStatus === 'confirmed' ? null : ref('loans.due.default', { lender }),
  };
}

/** The no-dues letter line. A prompt that does not agree with the recorded status is not trusted and says nothing about it. */
export function nocLine(closure: SvcClosure): { line: TextRef; confirmed: boolean } {
  const lender = closure.lenderDisplayName;
  if (closure.nocPromptKey === 'closure.noc.lender_to_issue' && closure.nocStatus === 'pending')
    return { line: ref('loans.closure.noc.pending', { lender }), confirmed: false };
  if (closure.nocPromptKey === 'closure.noc.issued_by_lender' && closure.nocStatus === 'issued')
    return { line: ref('loans.closure.noc.issued', { lender }), confirmed: true };
  return { line: ref('loans.closure.unknown', { lender }), confirmed: false };
}

/**
 * The line for one security-release task, from the prompt KEY the API returned. The key is mapped to this app's own wording;
 * an unknown key, or a key that does not agree with the task's recorded status, shows a neutral line and never the key itself.
 * "Confirmed" is said only when the key, the status and the lender-confirmed flag all say the lender confirmed it. The wording
 * never says that Udofin or this app released anything.
 */
export function securityLine(
  task: SvcClosure['securityReleaseTasks'][number],
  lender: string,
): { line: TextRef; confirmed: boolean } {
  const unknown = { line: ref('loans.closure.unknown', { lender }), confirmed: false };
  const match = SECURITY_PROMPT.exec(task.promptKey);
  const type = match?.[1];
  const keys = type
    ? (SECURITY_KEYS as Record<string, { pending: MessageKey; confirmed: MessageKey }>)[type]
    : undefined;
  if (!match || !keys) return unknown;
  if (match[2] === 'lender_confirmed') {
    return task.lenderConfirmed && task.status === 'confirmed_by_lender'
      ? { line: ref(keys.confirmed, { lender }), confirmed: true }
      : unknown;
  }
  return !task.lenderConfirmed && task.status === 'open'
    ? { line: ref(keys.pending, { lender }), confirmed: false }
    : unknown;
}

export type ClosureModel =
  | { kind: 'none'; notice: TextRef }
  | {
      kind: 'closed';
      lender: string;
      headline: TextRef;
      recorded: TextRef;
      noc: ClosureItem;
      security: ClosureItem[];
      footer: TextRef;
    };

export function closureModel(
  closure: SvcClosure | null,
  lender: string,
  language: Language,
): ClosureModel {
  if (closure === null) return { kind: 'none', notice: ref('loans.closure.none', { lender }) };
  const l = closure.lenderDisplayName;
  const noc = nocLine(closure);
  const nocIssued =
    closure.nocIssuedAt === null ? '' : formatReportedAt(closure.nocIssuedAt, language);
  return {
    kind: 'closed',
    lender: l,
    headline:
      closure.closureKind === 'foreclosed'
        ? ref('loans.closure.kind.foreclosed', { lender: l })
        : ref('loans.closure.kind.closed', { lender: l }),
    recorded: ref('loans.closure.recorded', {
      date: formatReportedAt(closure.closureRecordedAt, language),
    }),
    noc: {
      id: 'noc',
      heading: ref('loans.closure.noc.heading'),
      line: noc.line,
      confirmed: noc.confirmed,
      ...(noc.confirmed
        ? { due: null, dueNote: null }
        : dueRefs(closure.nocDueBy, closure.nocDueBasis, l, language)),
      delay: null,
      confirmedOn:
        noc.confirmed && nocIssued !== ''
          ? ref('loans.closure.issuedOn', { date: nocIssued })
          : null,
      documentId: noc.confirmed ? closure.nocDocumentId : null,
    },
    security: closure.securityReleaseTasks.map((task) => {
      const line = securityLine(task, l);
      const confirmedAt =
        task.confirmedAt === null ? '' : formatReportedAt(task.confirmedAt, language);
      return {
        id: task.taskId,
        heading: ref('loans.closure.sec.heading'),
        line: line.line,
        confirmed: line.confirmed,
        ...(line.confirmed
          ? { due: null, dueNote: null }
          : dueRefs(task.dueBy, task.dueBasis, l, language)),
        delay:
          !line.confirmed && task.delayReason
            ? { label: ref('loans.closure.delay', { lender: l }), text: task.delayReason }
            : null,
        confirmedOn:
          line.confirmed && confirmedAt !== ''
            ? ref('loans.closure.confirmedOn', { date: confirmedAt })
            : null,
        documentId: null,
      };
    }),
    footer: ref('loans.closure.footer', { lender: l }),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------------------------------------------------
const REMINDER_KIND_KEYS = {
  pre_due: 'reminders.kind.pre_due',
  due_day: 'reminders.kind.due_day',
  overdue: 'reminders.kind.overdue',
} as const satisfies Record<SvcReminder['kind'], MessageKey>;

export interface ReminderModel {
  id: string;
  loanId: string;
  lender: TextRef;
  kind: TextRef;
  due: TextRef;
  sent: TextRef;
  /** The lender's approved wording exactly as the API returned it. Never shortened, translated or re-rendered. */
  message: string;
  unread: boolean;
}

export function reminderModel(
  reminder: SvcReminder,
  language: Language,
  readNow: ReadonlySet<string> = new Set(),
): ReminderModel {
  const kindKey = (REMINDER_KIND_KEYS as Record<string, MessageKey>)[reminder.kind];
  return {
    id: reminder.reminderId,
    loanId: reminder.loanId,
    lender: reminder.lenderDisplayName
      ? ref('reminders.from', { lender: reminder.lenderDisplayName })
      : ref('reminders.fromUnknown'),
    kind: ref(kindKey ?? 'reminders.kind.unknown'),
    due: ref('reminders.dueOn', { date: formatDateOnly(reminder.dueDate, language) }),
    sent: ref('reminders.sentOn', { date: formatInstantDay(reminder.sentAt, language) }),
    message: reminder.message,
    unread: reminder.readAt === null && !readNow.has(reminder.reminderId),
  };
}

export function unreadReminderCount(
  reminders: readonly SvcReminder[],
  readNow: ReadonlySet<string> = new Set(),
): number {
  return reminders.filter((r) => r.readAt === null && !readNow.has(r.reminderId)).length;
}

/** Whether to ask the API to mark a reminder read: only a reminder that is unread, and not one already being marked. */
export function shouldMarkRead(
  model: Pick<ReminderModel, 'id' | 'unread'>,
  inFlight: ReadonlySet<string>,
): boolean {
  return model.unread && !inFlight.has(model.id);
}

// ---------------------------------------------------------------------------------------------------------------------
// The home screen entry
// ---------------------------------------------------------------------------------------------------------------------
/** "My loans" appears on the home screen only when the borrower has at least one loan in the list. */
export const hasAnyLoan = (list: { items: readonly unknown[] }): boolean => list.items.length > 0;
