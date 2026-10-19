import {
  type BorrowerMe,
  type BpMandate,
  type BpMandateDebit,
  type BpMandateOptions,
  type BpMandateRequest,
} from '@udofin/contracts';
import { type MessageKey } from '../i18n';
import { newUuid } from './payments-ids';
import { safeMaskedRef, word, type Ctx, type Tone, type Word } from './payments-view';

/**
 * What the auto-pay screens show, as plain data. The status is exactly what the provider-confirmed history last left: a draft or
 * "waiting for your bank" mandate is never described as active. A cancellation is a request until the status changes. Nothing
 * here promises that a debit will or will not happen, totals or nets an amount, or invents a reason for a returned debit.
 */
export type Rail = BpMandateOptions['rails'][number]['rail'];

// ---------------------------------------------------------------------------------------------------------------
// Typed input: dates and the last four digits of the account
// ---------------------------------------------------------------------------------------------------------------
/** "18/11/2026" (also with . or -) to "2026-11-18"; null for anything that is not a real calendar date. */
export function parseDayMonthYear(text: string): string | null {
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text.trim());
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = Number(m[3]);
  // A day or month that does not exist rolls the date into another month or year, so comparing both catches it.
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1) return null;
  const two = (n: number) => String(n).padStart(2, '0');
  return `${String(year)}-${two(month)}-${two(day)}`;
}

/**
 * The field for the account takes digits only and never more than four. If the new text holds more than four digits (a long
 * number was pasted or typed), the change is REFUSED and the previous value stays: the first four digits of a full number are
 * not its last four.
 */
export function sanitizeLastFour(previous: string, next: string): string {
  const digits = next.replace(/\D/g, '');
  return digits.length > 4 ? previous : digits;
}

/** What is sent as the account reference: six X and the four digits. Null unless exactly four digits were given. */
export function maskedAccountRef(lastFour: string): string | null {
  return /^\d{4}$/.test(lastFour) ? `XXXXXX${lastFour}` : null;
}

// ---------------------------------------------------------------------------------------------------------------
// The mandate id (chosen by the app before the step-up code is asked for)
// ---------------------------------------------------------------------------------------------------------------
const draftIds = new Map<string, string>();

/**
 * One id per loan for the request being prepared, kept in memory only. The step-up code is bound to this id, so the id must
 * survive a visit to the code screen and back. It is forgotten after the mandate was created, or when it can no longer be used.
 */
export function mandateDraftId(loanId: string, make: () => string = newUuid): string {
  const known = draftIds.get(loanId);
  if (known !== undefined) return known;
  const fresh = make();
  draftIds.set(loanId, fresh);
  return fresh;
}
export function forgetMandateDraftId(loanId: string): void {
  draftIds.delete(loanId);
}

// ---------------------------------------------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------------------------------------------
const RAIL_TITLE: Readonly<Record<string, MessageKey>> = {
  enach_api: 'mandate.rail.enach_api',
  upi_autopay: 'mandate.rail.upi_autopay',
};
const RAIL_EFFECT: Readonly<Record<string, MessageKey>> = {
  enach_api: 'mandate.rail.effect.enach_api',
  upi_autopay: 'mandate.rail.effect.upi_autopay',
};
export const railTitle = (rail: string): Word => word(RAIL_TITLE[rail] ?? 'mandate.rail.unknown');

const UNAVAILABLE_WORD: Readonly<Record<string, MessageKey>> = {
  loan_not_active: 'mandate.unavailable.loan_not_active',
  collection_target_invalid: 'mandate.unavailable.collection_target_invalid',
  config_ambiguous: 'mandate.unavailable.config_ambiguous',
  provider_not_mandate_capable: 'mandate.unavailable.provider_not_mandate_capable',
  rail_not_configured: 'mandate.unavailable.rail_not_configured',
  mandate_exists: 'mandate.unavailable.mandate_exists',
};

export interface RailView {
  rail: Rail;
  title: Word;
  effect: Word;
  max: Word;
  maxNote: Word;
  /** Said only when the API says the rail may ask the bank to authenticate every debit. */
  afa: Word | null;
}

export interface MandateSetupView {
  lender: string;
  requirement: Word | null;
  lead: Word;
  unavailable: Word | null;
  existingMandateId: string | null;
  rails: RailView[];
}

export function mandateSetupView(o: BpMandateOptions, ctx: Pick<Ctx, 'rupees'>): MandateSetupView {
  const lender = o.lenderDisplayName;
  const requirement =
    o.requirement === 'optional'
      ? word('mandate.setup.requirement.optional', { lender })
      : o.requirement === 'before_first_due'
        ? word('mandate.setup.requirement.before_first_due', { lender })
        : null;
  return {
    lender,
    requirement,
    lead: word('mandate.setup.lead', { hours: o.preDebitLeadHours }),
    unavailable: o.available
      ? null
      : word(
          (o.unavailableKey !== null ? UNAVAILABLE_WORD[o.unavailableKey] : undefined) ??
            'mandate.unavailable.unknown',
          { lender },
        ),
    existingMandateId: o.existingMandateId,
    // Nothing is offered when the API says nothing is available, even if it listed rails.
    rails: o.available
      ? o.rails.map((r) => ({
          rail: r.rail,
          title: railTitle(r.rail),
          effect: word(RAIL_EFFECT[r.rail] ?? 'mandate.rail.effect.unknown', { lender }),
          max: word('mandate.rail.max', { amount: ctx.rupees(r.maxAmountMinor) }),
          maxNote: word('mandate.rail.maxNote', { lender }),
          afa: r.needsAfaEachDebit ? word('mandate.rail.afa') : null,
        }))
      : [],
  };
}

/**
 * The API refuses a mandate request unless the borrower's device-integrity level is 'device' or 'strong'
 * (payments.request_mandate), and the level is raised only by a verified platform attestation. This version of the app cannot
 * obtain one (no verifier exists yet; owner decision D-24), so for every borrower the request would be answered with
 * `integrity_insufficient`. The setup form is therefore offered only at those levels, and the screen says plainly that auto-pay
 * setup is not available in this version of the app. It never says that a check was run on the phone or that the phone failed.
 */
export function canOfferMandateSetup(level: BorrowerMe['integrityLevel'] | null): boolean {
  return level === 'device' || level === 'strong';
}

/** The sentence shown instead of the setup form while it cannot be offered; null when the form may be offered or the level is unknown. */
export function mandateSetupNotice(level: BorrowerMe['integrityLevel'] | null): Word | null {
  if (level === null || canOfferMandateSetup(level)) return null;
  return word('mandate.setup.notInThisVersion');
}

export interface MandateDraft {
  rail: Rail | null;
  startText: string;
  endText: string;
  lastFour: string;
  /** The Idempotency-Key of the current attempt; renewed whenever the content changes. */
  attemptKey: string | null;
}
export const emptyMandateDraft = (): MandateDraft => ({
  rail: null,
  startText: '',
  endText: '',
  lastFour: '',
  attemptKey: null,
});

export type MandateDraftAction =
  | { type: 'rail'; rail: Rail }
  | { type: 'start'; text: string }
  | { type: 'end'; text: string }
  | { type: 'account'; text: string }
  | { type: 'key'; key: string }
  | { type: 'reset' };

export function mandateDraftReducer(state: MandateDraft, action: MandateDraftAction): MandateDraft {
  switch (action.type) {
    case 'rail':
      return { ...state, rail: action.rail, attemptKey: null };
    case 'start':
      return { ...state, startText: action.text, attemptKey: null };
    case 'end':
      return { ...state, endText: action.text, attemptKey: null };
    case 'account':
      return {
        ...state,
        lastFour: sanitizeLastFour(state.lastFour, action.text),
        attemptKey: null,
      };
    case 'key':
      return { ...state, attemptKey: action.key };
    case 'reset':
      return emptyMandateDraft();
  }
}

export interface MandateFieldErrors {
  rail?: Word;
  start?: Word;
  end?: Word;
  account?: Word;
}
export type MandateResolution =
  { ok: true; body: BpMandateRequest } | { ok: false; errors: MandateFieldErrors };

/**
 * The request body, or what is wrong with each field. The maximum amount is left out on purpose: the database then uses the
 * lower of the rail limit and the lender's ceiling, the figure shown on the rail. The account reference is built here from the
 * four digits; no field can carry a full account number.
 */
export function resolveMandateRequest(
  draft: MandateDraft,
  mandateId: string,
  offered: readonly Rail[],
): MandateResolution {
  const errors: MandateFieldErrors = {};
  const rail = offered.find((r) => r === draft.rail);
  if (rail === undefined) errors.rail = word('mandate.chooseRail');
  const startDate = parseDayMonthYear(draft.startText);
  if (startDate === null) errors.start = word('mandate.date.invalid');
  const endDate = parseDayMonthYear(draft.endText);
  if (endDate === null) errors.end = word('mandate.date.invalid');
  const masked = maskedAccountRef(draft.lastFour);
  if (masked === null) errors.account = word('mandate.account.invalid');
  if (
    rail === undefined ||
    startDate === null ||
    endDate === null ||
    masked === null ||
    Object.keys(errors).length > 0
  ) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    body: { mandateId, rail, startDate, endDate, maskedAccountRef: masked },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Mandate status
// ---------------------------------------------------------------------------------------------------------------
const STATUS: Readonly<Record<string, { headline: MessageKey; explain: MessageKey; tone: Tone }>> =
  {
    draft: { headline: 'mandate.status.draft', explain: 'mandate.explain.draft', tone: 'info' },
    registration_pending: {
      headline: 'mandate.status.registration_pending',
      explain: 'mandate.explain.registration_pending',
      tone: 'info',
    },
    active: { headline: 'mandate.status.active', explain: 'mandate.explain.active', tone: 'info' },
    paused: {
      headline: 'mandate.status.paused',
      explain: 'mandate.explain.paused',
      tone: 'warning',
    },
    rejected: {
      headline: 'mandate.status.rejected',
      explain: 'mandate.explain.rejected',
      tone: 'warning',
    },
    failed: {
      headline: 'mandate.status.failed',
      explain: 'mandate.explain.failed',
      tone: 'warning',
    },
    expired: {
      headline: 'mandate.status.expired',
      explain: 'mandate.explain.expired',
      tone: 'warning',
    },
    cancelled: {
      headline: 'mandate.status.cancelled',
      explain: 'mandate.explain.cancelled',
      tone: 'info',
    },
    revoked: {
      headline: 'mandate.status.revoked',
      explain: 'mandate.explain.revoked',
      tone: 'warning',
    },
    requires_reconciliation: {
      headline: 'mandate.status.requires_reconciliation',
      explain: 'mandate.explain.requires_reconciliation',
      tone: 'warning',
    },
  };

export interface MandateHeadline {
  headline: Word;
  explain: Word;
  tone: Tone;
}
export function mandateHeadline(status: string, lender: string): MandateHeadline {
  const known = STATUS[status];
  if (known) {
    return {
      headline: word(known.headline),
      explain: word(known.explain, { lender }),
      tone: known.tone,
    };
  }
  return {
    headline: word('mandate.status.unknown'),
    explain: word('mandate.explain.unknown', { lender }),
    tone: 'warning',
  };
}

/** Statuses from which the provider is still expected to move the mandate, so a cancellation request can still mean something. */
const CANCELLABLE_STATUSES: ReadonlySet<string> = new Set([
  'draft',
  'registration_pending',
  'active',
  'paused',
  'requires_reconciliation',
]);

/** The button is offered unless the mandate is finished (the API refuses with `mandate_finished` anyway) or a request is already open. */
export const canRequestCancellation = (m: Pick<BpMandate, 'status' | 'cancelRequested'>): boolean =>
  CANCELLABLE_STATUSES.has(m.status) && !m.cancelRequested;

/** The authorisation page can be opened only while the status is `registration_pending`. */
export const canOpenAuthorisation = (m: Pick<BpMandate, 'status'>): boolean =>
  m.status === 'registration_pending';

export interface MandateView {
  lender: string;
  headline: Word;
  explain: Word;
  tone: Tone;
  lines: Word[];
  afa: Word | null;
  /** Said after a cancellation was requested; the status above has not changed. */
  cancelRequested: Word | null;
  next: { title: Word; line: Word | null; notice: Word | null; note: Word };
  wait: Word | null;
  openAuthorisation: boolean;
  canCancel: boolean;
}

export interface MandateStateContext {
  /** The borrower opened the provider's page during this visit. */
  linkOpened: boolean;
  /** Automatic checking is not running. */
  pollStopped: boolean;
}

export function mandateView(m: BpMandate, state: MandateStateContext, ctx: Ctx): MandateView {
  const lender = m.lenderDisplayName;
  const head = mandateHeadline(m.status, lender);
  const masked = safeMaskedRef(m.maskedAccountRef);
  const lines: Word[] = [word('mandate.lender', { lender }), railTitle(m.rail)];
  if (masked !== null) lines.push(word('mandate.account', { account: masked }));
  lines.push(
    word('mandate.max', { amount: ctx.rupees(m.maxAmountMinor) }),
    word('mandate.period', { start: ctx.date(m.startDate), end: ctx.date(m.endDate) }),
  );

  let nextLine: Word | null = null;
  if (m.nextDebitOn !== null) {
    nextLine =
      m.nextDebitMinor !== null
        ? word('mandate.next.line', {
            date: ctx.date(m.nextDebitOn),
            amount: ctx.rupees(m.nextDebitMinor),
          })
        : word('mandate.next.noAmount', { date: ctx.date(m.nextDebitOn) });
  }
  const notice =
    nextLine === null || m.nextDebitNotified === null
      ? null
      : word(m.nextDebitNotified ? 'mandate.next.noticeSent' : 'mandate.next.noticeNot');

  const waitingForDraft = m.status === 'draft';
  const waitingAfterReturn = m.status === 'registration_pending' && state.linkOpened;
  let wait: Word | null = null;
  if ((waitingForDraft || waitingAfterReturn) && state.pollStopped) {
    wait = word('mandate.wait.stopped');
  } else if (waitingAfterReturn) wait = word('mandate.wait.afterReturn');

  return {
    lender,
    headline: head.headline,
    explain: head.explain,
    tone: head.tone,
    lines,
    afa: m.needsAfaEachDebit ? word('mandate.rail.afa') : null,
    cancelRequested: m.cancelRequested ? word('mandate.cancelRequested') : null,
    next: {
      title: word('mandate.next.title'),
      line: nextLine ?? null,
      notice,
      note: word('mandate.next.note', { lender }),
    },
    wait,
    openAuthorisation: canOpenAuthorisation(m),
    canCancel: canRequestCancellation(m),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Debits
// ---------------------------------------------------------------------------------------------------------------
const DEBIT_STATUS: Readonly<Record<string, MessageKey>> = {
  scheduled: 'mandate.debit.status.scheduled',
  notified: 'mandate.debit.status.notified',
  presented: 'mandate.debit.status.presented',
  unknown: 'mandate.debit.status.unknown',
  settled: 'mandate.debit.status.settled',
  returned: 'mandate.debit.status.returned',
  cancelled: 'mandate.debit.status.cancelled',
};
const RETURN_CLASS: Readonly<Record<string, MessageKey>> = {
  insufficient_funds: 'mandate.debit.class.insufficient_funds',
  account_issue: 'mandate.debit.class.account_issue',
  mandate_issue: 'mandate.debit.class.mandate_issue',
  technical: 'mandate.debit.class.technical',
  other: 'mandate.debit.class.other',
};
const NOTICE_STATUS: Readonly<Record<string, MessageKey>> = {
  planned: 'mandate.notice.planned',
  sent: 'mandate.notice.sent',
  late: 'mandate.notice.late',
  not_needed: 'mandate.notice.not_needed',
};

export interface DebitView {
  id: string;
  /** The scheduled date, formatted. */
  date: string;
  origin: Word;
  amount: Word;
  status: Word;
  /** The class of the provider's return code, only when the lender's configuration classified it. Never a guessed reason. */
  returned: Word | null;
  notice: Word | null;
}

/**
 * The provider's own return code is deliberately NOT shown: it is provider text, and only its classified class is meaningful to
 * the borrower. When a debit is returned and no class exists, the screen says so instead of guessing a reason.
 */
export function debitView(d: BpMandateDebit, ctx: Ctx): DebitView {
  let returned: Word | null = null;
  if (d.returnClass !== null) {
    returned = word(RETURN_CLASS[d.returnClass] ?? 'mandate.debit.noClass');
  } else if (d.status === 'returned') {
    returned = word('mandate.debit.noClass');
  }
  let notice: Word | null = null;
  if (d.notice !== null) {
    const when =
      d.notice.status === 'sent' && d.notice.sentAt !== null ? d.notice.sentAt : d.notice.dueAt;
    notice = word(NOTICE_STATUS[d.notice.status] ?? 'mandate.debit.status.other', {
      date: ctx.dateTime(when),
    });
  }
  return {
    id: d.id,
    date: ctx.date(d.scheduledOn),
    origin: word(d.planned ? 'mandate.debit.planned' : 'mandate.debit.reported'),
    amount:
      d.amountMinor !== null
        ? word('mandate.debit.amount', { amount: ctx.rupees(d.amountMinor) })
        : word('mandate.debit.noAmount'),
    status: word(DEBIT_STATUS[d.status] ?? 'mandate.debit.status.other'),
    returned,
    notice,
  };
}

export interface MandateListItemView {
  id: string;
  lender: string;
  rail: Word;
  headline: Word;
  account: Word | null;
  open: Word;
}
export function mandateListItemView(m: BpMandate): MandateListItemView {
  const masked = safeMaskedRef(m.maskedAccountRef);
  return {
    id: m.id,
    lender: m.lenderDisplayName,
    rail: railTitle(m.rail),
    headline: mandateHeadline(m.status, m.lenderDisplayName).headline,
    account: masked !== null ? word('mandate.account', { account: masked }) : null,
    open: word('mandate.open', { lender: m.lenderDisplayName }),
  };
}
