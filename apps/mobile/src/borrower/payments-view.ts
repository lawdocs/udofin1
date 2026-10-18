import {
  type BpPaymentDetail,
  type BpPaymentOption,
  type BpPaymentOptions,
  type BpPaymentRequest,
} from '@udofin/contracts';
import { translate, type Language, type MessageKey } from '../i18n';
import { formatDate, formatDateTime } from './format';
import { formatRupees, parseRupees } from './money';

/**
 * What the payment screens show, as plain data. Nothing here computes, rounds, totals or infers a figure, and nothing derives a
 * stage: every amount, date and stage is the one the API returned, put into a sentence. The screens only draw these structures.
 * Closed vocabularies go through the tables below; a value a table does not know becomes a generic sentence, never the raw value.
 */
export type Vars = Record<string, string | number>;
export interface Word {
  readonly key: MessageKey;
  readonly vars?: Vars;
}
export type Tone = 'info' | 'warning';

export const word = (key: MessageKey, vars?: Vars): Word => (vars ? { key, vars } : { key });

/** Formatting and wording for one language. `say` turns a Word into text. */
export interface Ctx {
  language: Language;
  rupees: (paise: number) => string;
  dateTime: (iso: string) => string;
  date: (dateOnly: string) => string;
  say: (w: Word) => string;
}

/** A calendar date (YYYY-MM-DD) shown in India time without letting the device's time zone move it. */
export function formatDateOnly(value: string, language: Language): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return '';
  return formatDate(`${value}T00:00:00+05:30`, language);
}

export function ctxFor(language: Language): Ctx {
  return {
    language,
    rupees: formatRupees,
    dateTime: (iso) => formatDateTime(iso, language),
    date: (d) => formatDateOnly(d, language),
    say: (w) => translate(language, w.key, w.vars),
  };
}

/**
 * A masked account reference is shown only if it LOOKS masked (X or * then 2 to 4 digits). Anything else, for example a full
 * number from a faulty source, is not shown at all.
 */
export function safeMaskedRef(ref: string | null): string | null {
  return ref !== null && /^[X*]{2,}[0-9]{2,4}$/.test(ref) ? ref : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Closed vocabularies
// ---------------------------------------------------------------------------------------------------------------
const PURPOSE_WORD: Readonly<Record<string, MessageKey>> = {
  installment: 'pay.purpose.installment',
  overdue: 'pay.purpose.overdue',
  part_prepayment: 'pay.purpose.part_prepayment',
  foreclosure: 'pay.purpose.foreclosure',
  charges: 'pay.purpose.charges',
};
export const purposeWord = (purpose: string): Word =>
  word(PURPOSE_WORD[purpose] ?? 'pay.purpose.unknown');

const STATUS_WORD: Readonly<Record<string, MessageKey>> = {
  created: 'pay.status.created',
  pending: 'pay.status.pending',
  succeeded: 'pay.status.succeeded',
  failed: 'pay.status.failed',
  expired: 'pay.status.expired',
  cancelled: 'pay.status.cancelled',
};
export const paymentStatusWord = (status: string): Word =>
  word(STATUS_WORD[status] ?? 'pay.status.unknown');

const UNAVAILABLE_WORD: Readonly<Record<string, MessageKey>> = {
  loan_not_active: 'pay.unavailable.loan_not_active',
  collection_target_invalid: 'pay.unavailable.collection_target_invalid',
  config_ambiguous: 'pay.unavailable.config_ambiguous',
};

// ---------------------------------------------------------------------------------------------------------------
// Payment options (the Pay screen)
// ---------------------------------------------------------------------------------------------------------------
export type OptionPurpose = BpPaymentOption['purpose'];

/**
 * How the amount of one option is decided. The numbers are the API's; the screen never works one out.
 * - fixed: exactly the stated amount.
 * - fixed_or_range: the stated amount, or (the lender accepts a part) any amount between the stated limits.
 * - range: the borrower types an amount between the stated limits.
 */
export type AmountRule =
  | { kind: 'fixed'; amountMinor: number }
  | { kind: 'fixed_or_range'; amountMinor: number; minMinor: number; maxMinor: number }
  | { kind: 'range'; minMinor: number; maxMinor: number };

export interface PenalView {
  label: Word;
  /** The lender's approved sentence, exactly as returned (no trimming, no rewording). */
  sentence: string;
  /** True when the app is in Hindi and the lender has no approved Hindi sentence: the English one is shown, and the screen says so. */
  shownInEnglish: boolean;
}

export interface OptionView {
  purpose: OptionPurpose;
  title: Word;
  /** Whose amount it is, in words, with the amount or the limits. */
  source: Word;
  due: Word | null;
  /** Said when a smaller amount is accepted. */
  partial: Word | null;
  rule: AmountRule;
  quote: { id: string; validUntil: Word; blocked: Word | null } | null;
  /** Only ever on the overdue option, and only when the lender has an approved sentence. */
  penal: PenalView | null;
}

export interface OpenPaymentView {
  id: string;
  title: Word;
  status: Word;
  open: Word;
}

export interface PayOptionsView {
  lender: string;
  destination: Word | null;
  reported: Word | null;
  /** Why the figures cannot be used: out of date, or being checked by the lender. */
  notice: { tone: Tone; word: Word } | null;
  /** Why nothing can be paid at all. */
  unavailable: Word | null;
  openPayments: OpenPaymentView[];
  options: OptionView[];
  noneOffered: Word | null;
}

const penalFor = (o: BpPaymentOptions, language: Language, lender: string): PenalView | null => {
  const p = o.penalCharge;
  if (p === null || p.sentenceEn.trim() === '') return null;
  const hindi = p.sentenceHi !== null && p.sentenceHi.trim() !== '' ? p.sentenceHi : null;
  const useHindi = language === 'hi' && hindi !== null;
  return {
    label: word('pay.penal.label', { lender }),
    sentence: language === 'hi' && hindi !== null ? hindi : p.sentenceEn,
    shownInEnglish: language === 'hi' && !useHindi,
  };
};

export function amountRuleFor(option: BpPaymentOption): AmountRule {
  switch (option.purpose) {
    case 'part_prepayment':
      return { kind: 'range', minMinor: option.minMinor, maxMinor: option.maxMinor };
    case 'foreclosure':
      return { kind: 'fixed', amountMinor: option.amountMinor };
    case 'installment':
    case 'overdue':
      return option.minMinor < option.maxMinor
        ? {
            kind: 'fixed_or_range',
            amountMinor: option.amountMinor,
            minMinor: option.minMinor,
            maxMinor: option.maxMinor,
          }
        : { kind: 'fixed', amountMinor: option.amountMinor };
  }
}

function optionView(
  option: BpPaymentOption,
  o: BpPaymentOptions,
  ctx: Ctx,
  lender: string,
): OptionView {
  const rule = amountRuleFor(option);
  const title = purposeWord(option.purpose);
  const partial =
    rule.kind === 'fixed_or_range'
      ? word('pay.partial', {
          lender,
          min: ctx.rupees(rule.minMinor),
          max: ctx.rupees(rule.maxMinor),
        })
      : null;
  switch (option.purpose) {
    case 'installment':
      return {
        purpose: option.purpose,
        title,
        source: word('pay.source.reported', { lender, amount: ctx.rupees(option.amountMinor) }),
        due: option.dueOn ? word('pay.due', { date: ctx.date(option.dueOn) }) : null,
        partial,
        rule,
        quote: null,
        penal: null,
      };
    case 'overdue':
      return {
        purpose: option.purpose,
        title,
        source: word('pay.source.reported', { lender, amount: ctx.rupees(option.amountMinor) }),
        due: null,
        partial,
        rule,
        quote: null,
        penal: penalFor(o, ctx.language, lender),
      };
    case 'part_prepayment':
      return {
        purpose: option.purpose,
        title,
        source: word('pay.source.limits', {
          lender,
          min: ctx.rupees(option.minMinor),
          max: ctx.rupees(option.maxMinor),
        }),
        due: null,
        partial: null,
        rule,
        quote: null,
        penal: null,
      };
    case 'foreclosure':
      return {
        purpose: option.purpose,
        title,
        source: word('pay.source.quote', { lender, amount: ctx.rupees(option.amountMinor) }),
        due: null,
        partial: null,
        rule,
        quote: {
          id: option.quoteId,
          validUntil: word('pay.quote.validUntil', { date: ctx.dateTime(option.validUntil) }),
          blocked: option.flagged ? word('pay.quote.flagged', { lender }) : null,
        },
        penal: null,
      };
  }
}

/**
 * The Pay screen. When the API says nothing is available, no option is drawn even if it sent some. A stale or withheld figure
 * explains itself in words and no amount that depends on it appears (the API sends none; this view adds none).
 */
export function payOptionsView(
  o: BpPaymentOptions,
  ctx: Ctx,
  /** The purpose the borrower came from (for example the quotation screen). It only moves that option first; it selects nothing. */
  hint?: string,
): PayOptionsView {
  const lender = o.lenderDisplayName;
  const masked = safeMaskedRef(o.destinationMaskedRef);
  let notice: PayOptionsView['notice'] = null;
  if (o.available) {
    if (!o.figuresAvailable) notice = { tone: 'warning', word: word('pay.withheld', { lender }) };
    else if (o.stale) {
      notice = {
        tone: 'warning',
        word:
          o.reportedAsOf !== null
            ? word('pay.stale', { lender, date: ctx.dateTime(o.reportedAsOf) })
            : word('pay.staleNoDate', { lender }),
      };
    }
  }
  const built = o.available ? o.purposes.map((p) => optionView(p, o, ctx, lender)) : [];
  const options = [
    ...built.filter((p) => p.purpose === hint),
    ...built.filter((p) => p.purpose !== hint),
  ];
  return {
    lender,
    destination: masked !== null ? word('pay.destination', { lender, account: masked }) : null,
    reported:
      o.reportedAsOf !== null
        ? word('pay.reportedAsOf', { lender, date: ctx.dateTime(o.reportedAsOf) })
        : null,
    notice,
    unavailable: o.available
      ? null
      : word(
          (o.unavailableKey !== null ? UNAVAILABLE_WORD[o.unavailableKey] : undefined) ??
            'pay.unavailable.unknown',
          { lender },
        ),
    openPayments: o.openPayments.map((p) => ({
      id: p.id,
      title: purposeWord(p.purpose),
      status: paymentStatusWord(p.status),
      open: word('pay.open.view', { purpose: ctx.say(purposeWord(p.purpose)) }),
    })),
    options,
    noneOffered:
      o.available && notice === null && options.length === 0
        ? word('pay.noneOffered', { lender })
        : null,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The borrower's choice (nothing is pre-selected) and the request it turns into
// ---------------------------------------------------------------------------------------------------------------
export type AmountMode = 'reported' | 'other';

export interface PayDraft {
  purpose: OptionPurpose | null;
  mode: AmountMode | null;
  amountText: string;
  /** The Idempotency-Key of the current attempt. It is renewed whenever the content changes; null until the first send. */
  attemptKey: string | null;
}
export const emptyPayDraft = (): PayDraft => ({
  purpose: null,
  mode: null,
  amountText: '',
  attemptKey: null,
});

export type PayDraftAction =
  | { type: 'purpose'; purpose: OptionPurpose }
  | { type: 'mode'; mode: AmountMode }
  | { type: 'amount'; text: string }
  | { type: 'key'; key: string }
  | { type: 'reset' };

/** Any edit starts a new intent: a key used for other content must not be reused. */
export function payDraftReducer(state: PayDraft, action: PayDraftAction): PayDraft {
  switch (action.type) {
    case 'purpose':
      return state.purpose === action.purpose
        ? state
        : { purpose: action.purpose, mode: null, amountText: '', attemptKey: null };
    case 'mode':
      return { ...state, mode: action.mode, attemptKey: null };
    case 'amount':
      return { ...state, amountText: action.text, attemptKey: null };
    case 'key':
      return { ...state, attemptKey: action.key };
    case 'reset':
      return emptyPayDraft();
  }
}

export type PayResolution =
  { ok: true; request: BpPaymentRequest; amountMinor: number } | { ok: false; reason: Word | null };

const NOT_YET = { ok: false, reason: null } as const;

/**
 * Turns the borrower's choice into the request body, or says why not (`reason` null means "nothing to say yet"). The typed rupees
 * go through the exact integer parser; the limits compared with are the ones the API showed. The API checks every amount again.
 */
export function resolvePayment(
  option: OptionView | undefined,
  draft: PayDraft,
  ctx: Pick<Ctx, 'rupees'>,
): PayResolution {
  if (option === undefined || draft.purpose !== option.purpose) return NOT_YET;
  if (option.quote?.blocked) return { ok: false, reason: option.quote.blocked };
  const body = (amountMinor: number): PayResolution => ({
    ok: true,
    amountMinor,
    request: {
      purpose: option.purpose,
      amountMinor,
      ...(option.quote ? { quoteId: option.quote.id } : {}),
    },
  });
  const rule = option.rule;
  if (rule.kind === 'fixed') return body(rule.amountMinor);
  if (rule.kind === 'fixed_or_range') {
    if (draft.mode === null) return NOT_YET;
    if (draft.mode === 'reported') return body(rule.amountMinor);
  }
  // A typed amount between the limits.
  if (draft.amountText.trim() === '') return NOT_YET;
  const parsed = parseRupees(draft.amountText);
  if (!parsed.ok) return { ok: false, reason: word('pay.amount.invalid') };
  if (parsed.paise < rule.minMinor) {
    return { ok: false, reason: word('pay.amount.tooLow', { min: ctx.rupees(rule.minMinor) }) };
  }
  if (parsed.paise > rule.maxMinor) {
    return { ok: false, reason: word('pay.amount.tooHigh', { max: ctx.rupees(rule.maxMinor) }) };
  }
  return body(parsed.paise);
}

// ---------------------------------------------------------------------------------------------------------------
// Payment status
// ---------------------------------------------------------------------------------------------------------------
const STAGE_WORD: Readonly<
  Record<string, { headline: MessageKey; explain: MessageKey; tone: Tone }>
> = {
  provider_received: {
    headline: 'pay.stage.provider_received',
    explain: 'pay.explain.provider_received',
    tone: 'info',
  },
  lender_posted: {
    headline: 'pay.stage.lender_posted',
    explain: 'pay.explain.lender_posted',
    tone: 'info',
  },
  needs_attention: {
    headline: 'pay.stage.needs_attention',
    explain: 'pay.explain.needs_attention',
    tone: 'warning',
  },
};
const ENDED_WORD: Readonly<
  Record<string, { headline: MessageKey; explain: MessageKey; tone: Tone }>
> = {
  cancelled: {
    headline: 'pay.stage.cancelled',
    explain: 'pay.explain.cancelled',
    tone: 'info',
  },
  failed: { headline: 'pay.stage.failed', explain: 'pay.explain.failed', tone: 'warning' },
  expired: { headline: 'pay.stage.expired', explain: 'pay.explain.expired', tone: 'warning' },
};

export interface Headline {
  headline: Word;
  explain: Word | null;
  tone: Tone;
}

/**
 * The words for where a payment stands, from the API's `stage` and `status` only. The stage decides first: once the provider has
 * reported money, or the lender has posted it, or something needs attention, those words win over the request's own status. Only a
 * payment still at stage `started` can read cancelled, failed or expired (the API says the provider never reported money for it).
 * "Received" is never written as "paid", and nothing here ever says "paid" or "successful".
 */
export function paymentHeadline(stage: string, status: string, lender: string): Headline {
  const vars = { lender };
  const staged = STAGE_WORD[stage];
  if (staged) {
    return {
      headline: word(staged.headline, vars),
      explain: word(staged.explain, vars),
      tone: staged.tone,
    };
  }
  if (stage === 'started') {
    const ended = ENDED_WORD[status];
    if (ended) {
      return {
        headline: word(ended.headline, vars),
        explain: word(ended.explain, vars),
        tone: ended.tone,
      };
    }
    return {
      headline: word('pay.stage.started', vars),
      explain: word('pay.explain.started', vars),
      tone: 'info',
    };
  }
  return { headline: word('pay.stage.unknown', vars), explain: null, tone: 'warning' };
}

/** True while the payment is still waiting for something the provider has to do (or for the borrower to open the page). */
export function isWaiting(
  d: Pick<BpPaymentDetail, 'status' | 'stage' | 'linkAvailable'>,
  linkOpened: boolean,
): boolean {
  if (d.stage !== 'started') return false;
  if (d.status === 'created') return true;
  if (d.status === 'pending') return !d.linkAvailable || linkOpened;
  return false;
}

export interface PaymentStatusView {
  headline: Word;
  explain: Word | null;
  tone: Tone;
  lines: Word[];
  wait: Word | null;
  /** A button to open the provider's page is shown: the API says an unexpired link can be fetched. */
  link: { until: Word | null } | null;
  /** Said when there is nothing to open although the payment is still with the provider. */
  linkMissing: Word | null;
  /** The API says it can still be cancelled. */
  cancellable: boolean;
  /** The payment ended without money being reported: a way back to the options is offered. */
  ended: boolean;
}

export interface StatusContext {
  /** The borrower opened the provider's page during this visit. */
  linkOpened: boolean;
  /** Automatic checking is not running (it ran out, or a read failed). */
  pollStopped: boolean;
}

export function paymentStatusView(
  d: BpPaymentDetail,
  state: StatusContext,
  ctx: Ctx,
): PaymentStatusView {
  const lender = d.lenderDisplayName;
  const head = paymentHeadline(d.stage, d.status, lender);
  const masked = safeMaskedRef(d.destinationMaskedRef);
  const lines: Word[] = [
    word('pay.detail.amount', { amount: ctx.rupees(d.amountMinor) }),
    word('pay.detail.purpose', { purpose: ctx.say(purposeWord(d.purpose)) }),
  ];
  if (masked !== null) lines.push(word('pay.destination', { lender, account: masked }));
  lines.push(word('pay.detail.started', { date: ctx.dateTime(d.createdAt) }));
  if (d.providerReceivedAt !== null) {
    lines.push(word('pay.detail.providerAt', { date: ctx.dateTime(d.providerReceivedAt) }));
  }
  if (d.lenderPostedOn !== null) {
    lines.push(word('pay.detail.postedOn', { lender, date: ctx.date(d.lenderPostedOn) }));
  }

  const waiting = isWaiting(d, state.linkOpened);
  let wait: Word | null = null;
  if (waiting && state.pollStopped) wait = word('pay.wait.stopped');
  else if (waiting && d.status === 'created' && !d.linkAvailable) wait = word('pay.wait.order');
  else if (waiting && state.linkOpened) wait = word('pay.wait.afterReturn', { lender });

  return {
    headline: head.headline,
    explain: head.explain,
    tone: head.tone,
    lines,
    wait,
    link: d.linkAvailable
      ? {
          until:
            d.linkExpiresAt !== null
              ? word('pay.link.until', { date: ctx.dateTime(d.linkExpiresAt) })
              : null,
        }
      : null,
    linkMissing:
      d.status === 'pending' && d.stage === 'started' && !d.linkAvailable
        ? word('pay.link.none')
        : null,
    cancellable: d.cancellable,
    ended:
      d.stage === 'started' &&
      (d.status === 'cancelled' || d.status === 'failed' || d.status === 'expired'),
  };
}
