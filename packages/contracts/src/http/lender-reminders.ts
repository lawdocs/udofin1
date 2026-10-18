// Phase 08a wire contracts, lender side: reminder policy, reminder wording, the lender's penal-charge text, communication holds and
// the reminders themselves. Every export carries the prefix `Lr` (lender reminders) so it cannot collide with another module's names.
//
// Conventions: money is integer paise as a JSON number (`Paise`); dates are `YYYY-MM-DD`; timestamps are ISO 8601 with an offset;
// responses are strict objects, so a field that is not declared here cannot leave the API.
//
// What these contracts do NOT do: they compute, suggest, translate or fill in nothing. A policy, a wording, a penal-charge figure and
// a penal-charge sentence are the LENDER's words and numbers, carried through unchanged. The database owns every rule (the
// allowed window, the daily cap, the closed variable set, the refusal of links, contact details and promotional wording, the
// two-person approval); where this file bounds a field it only protects the shape of the request, and the database's own refusal
// (the SQL hint, returned as the problem `code`) is the answer a client sees for a value that is well-formed but not acceptable.
//
// Reminders are IN-APP and PUSH only. `sms` appears in the closed lists because the database accepts it in a policy as an inert
// placeholder: no SMS provider exists, a planned sms message is written as suppressed (`sms_not_configured`), nothing can claim
// it, and it is never reported as sent. There is no mock SMS in any environment.
import { z } from 'zod';
import { DateOnly, Paise, Timestamp } from '../primitives.js';

const Id = z.uuid();
const Limit = z.coerce.number().int().min(1).max(100).default(25);
const CursorText = z.string().min(1).max(300);
const Page = <T extends z.ZodType>(item: T) =>
  z.strictObject({ items: z.array(item), nextCursor: z.string().nullable() });

// ---------------------------------------------------------------------------------------------------------------
// Closed vocabularies. The database owns every list below (check constraints); these mirror them so a client can
// render them, and the integration tests fail if one drifts.
// ---------------------------------------------------------------------------------------------------------------
/** Policy, wording and penal-charge text all start as a draft, are approved by a DIFFERENT person, and end retired. */
export const LR_ARTEFACT_STATUSES = ['draft', 'approved', 'retired'] as const;
/**
 * Channels a policy may name. `sms` is an INERT PLACEHOLDER: no SMS provider exists, so a message planned for it is written as
 * suppressed (`sms_not_configured`) and is never sent, accepted or reported as delivered. In-app and push are the channels.
 */
export const LR_CHANNELS = ['in_app', 'push', 'sms'] as const;
/** The channels that can carry a message today. */
export const LR_LIVE_CHANNELS = ['in_app', 'push'] as const;
/** The channels that are inert placeholders (never sent). */
export const LR_INERT_CHANNELS = ['sms'] as const;
export const LR_REMINDER_KINDS = ['pre_due', 'due_day', 'overdue'] as const;
export const LR_TEMPLATE_LANGUAGES = ['en', 'hi'] as const;
/** The only placeholders a wording may use (`{{name}}`); anything else is refused (`wording_invalid`). */
export const LR_TEMPLATE_VARIABLES = ['lender_name', 'due_date', 'amount', 'penal_text'] as const;
/** The placeholder every overdue wording must contain: the lender's own approved penal-charge sentence goes there, verbatim. */
export const LR_PENAL_TEXT_VARIABLE = '{{penal_text}}';
export const LR_CHARGE_KINDS = ['flat', 'percentage'] as const;
/** The only basis of a penal charge the database accepts. */
export const LR_CHARGE_BASES = ['overdue_amount'] as const;
export const LR_REMINDER_STATUSES = ['planned', 'claimed', 'sent', 'failed', 'suppressed'] as const;
export const LR_SUPPRESS_REASONS = [
  'loan_closed',
  'paid',
  'recent_payment',
  'hold',
  'penal_text_missing',
  'template_missing',
  'nothing_due',
  'nothing_overdue',
  'sms_not_configured',
  'channel_not_configured',
  'policy_retired',
  'expired',
  'figures_unavailable',
] as const;
export const LR_HOLD_REASONS = [
  'complaint',
  'hardship',
  'dispute',
  'lender_instruction',
  'borrower_request',
  'legal',
] as const;
export const LR_HOLD_STATUSES = ['active', 'released'] as const;
/** `accepted` means the channel took the message, NOT that it was delivered; `delivered` exists only from a delivery report. */
export const LR_DELIVERY_STATES = [
  'accepted',
  'not_configured',
  'failed',
  'delivered',
  'read',
] as const;
export const LR_DELIVERY_SOURCES = ['send', 'delivery_report', 'app'] as const;
export const LR_DELIVERY_ERROR_CLASSES = [
  'provider_error',
  'provider_timeout',
  'invalid_target',
  'no_consent',
  'rate_limited',
  'unknown',
] as const;

/** A channel. `sms` is an inert placeholder (no SMS provider exists): it is never sent, accepted or reported as delivered. */
const Channel = z
  .enum(LR_CHANNELS)
  .describe(
    'in_app and push carry messages. sms is an inert placeholder: no SMS provider exists, so an sms message is suppressed (sms_not_configured) and never sent.',
  );

/** A wall-clock time of day in IST, `HH:MM`. */
const ClockTime = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/);

/**
 * Whether the lender's overdue reminders can be sent, DERIVED from the lender's penal-charge text rows (nothing sets it):
 * while the lender has no APPROVED penal-charge text, every overdue reminder is suppressed (`penal_text_missing`) and never
 * sent. Pre-due and due-day reminders do not depend on it. An approved text that is later retired makes this false again.
 */
export const LrOverdueReminders = z.strictObject({
  penalTextApproved: z.boolean(),
  overdueRemindersWithheld: z.boolean(),
});
export type LrOverdueReminders = z.infer<typeof LrOverdueReminders>;

/** The query of the three artefact lists: the lender is always named (the answer is about one lender). */
const ArtefactQuery = {
  lenderId: Id,
  status: z.enum(LR_ARTEFACT_STATUSES).optional(),
  limit: Limit,
  cursor: CursorText.optional(),
};

// ---------------------------------------------------------------------------------------------------------------
// Reminder policy
// ---------------------------------------------------------------------------------------------------------------
export const LrPolicyListQuery = z.strictObject(ArtefactQuery);

/**
 * One version of a lender's reminder policy: offsets in days from each due date (negative before, 0 the due day, positive
 * after), the channels, the daily window in IST and the cap per loan per day. The platform window, cap and quiet period can
 * only narrow what the lender wrote here; nothing in this record is a Udofin decision.
 */
export const LrPolicy = z.strictObject({
  id: Id,
  lenderId: Id,
  version: z.number().int().min(1),
  status: z.enum(LR_ARTEFACT_STATUSES),
  offsetsDays: z.array(z.number().int()),
  overdueWeekly: z.boolean(),
  channels: z.array(Channel),
  windowFrom: ClockTime,
  windowTo: ClockTime,
  maxPerDay: z.number().int(),
  draftedBy: Id,
  draftedAt: Timestamp,
  approvedBy: Id.nullable(),
  approvedAt: Timestamp.nullable(),
  retiredBy: Id.nullable(),
  retiredAt: Timestamp.nullable(),
});
export type LrPolicy = z.infer<typeof LrPolicy>;
export const LrPolicyPage = z.strictObject({
  items: z.array(LrPolicy),
  nextCursor: z.string().nullable(),
  overdueReminders: LrOverdueReminders,
});

/**
 * The shape of a policy draft. The ranges here only keep the request small and well-formed: the database decides what is
 * acceptable (1 to 12 distinct offsets between -30 and 90, no repeated channel, a window inside 08:00 to 19:00 IST, a cap of 1 or
 * 2) and answers `offsets_invalid`, `channels_invalid`, `window_invalid` or `policy_invalid` with 422.
 */
export const LrPolicyDraftInput = z.strictObject({
  lenderId: Id,
  offsetsDays: z.array(z.number().int().min(-1000).max(1000)).min(1).max(30),
  overdueWeekly: z.boolean(),
  channels: z.array(Channel).min(1).max(6),
  windowFrom: ClockTime,
  windowTo: ClockTime,
  maxPerDay: z.number().int().min(0).max(1000),
});
export type LrPolicyDraftInput = z.infer<typeof LrPolicyDraftInput>;

// ---------------------------------------------------------------------------------------------------------------
// Reminder wording (templates)
// ---------------------------------------------------------------------------------------------------------------
export const LrTemplateListQuery = z.strictObject({
  ...ArtefactQuery,
  kind: z.enum(LR_REMINDER_KINDS).optional(),
  language: z.enum(LR_TEMPLATE_LANGUAGES).optional(),
});

/**
 * One version of the lender's wording for a kind and language. The body is exactly the text the lender submitted (the approver
 * must read it); it can only use the closed placeholders in `LR_TEMPLATE_VARIABLES`. An overdue wording carries `{{penal_text}}`.
 */
export const LrTemplate = z.strictObject({
  id: Id,
  lenderId: Id,
  kind: z.enum(LR_REMINDER_KINDS),
  language: z.enum(LR_TEMPLATE_LANGUAGES),
  version: z.number().int().min(1),
  status: z.enum(LR_ARTEFACT_STATUSES),
  body: z.string(),
  draftedBy: Id,
  draftedAt: Timestamp,
  approvedBy: Id.nullable(),
  approvedAt: Timestamp.nullable(),
  retiredBy: Id.nullable(),
  retiredAt: Timestamp.nullable(),
});
export type LrTemplate = z.infer<typeof LrTemplate>;
export const LrTemplatePage = Page(LrTemplate);

/**
 * A wording draft. The text is the lender's; the API passes it through and the database refuses anything that is not a plain
 * service message (a link, an address, a phone-like number, a promotional word, a placeholder outside the closed set:
 * `wording_invalid`; an overdue wording without `{{penal_text}}`: `penal_text_variable_missing`).
 */
export const LrTemplateDraftInput = z.strictObject({
  lenderId: Id,
  kind: z.enum(LR_REMINDER_KINDS),
  language: z.enum(LR_TEMPLATE_LANGUAGES),
  body: z.string().min(1).max(4000),
});
export type LrTemplateDraftInput = z.infer<typeof LrTemplateDraftInput>;

// ---------------------------------------------------------------------------------------------------------------
// The lender's penal-charge text
// ---------------------------------------------------------------------------------------------------------------
export const LrPenalTextListQuery = z.strictObject(ArtefactQuery);

/**
 * The lender's penal-charge disclosure, exactly as the lender submitted it: the structured figure (a flat amount in paise OR a
 * percentage in basis points of the overdue amount), the lender's two attestations (a separate charge, not compounded), the
 * reason and the sentence in English and optionally Hindi. Udofin never computes, suggests, translates or fills in any of it,
 * and shows the sentence verbatim in an overdue reminder. This is the lender's statement, not a regulatory quotation.
 */
export const LrPenalText = z.strictObject({
  id: Id,
  lenderId: Id,
  version: z.number().int().min(1),
  status: z.enum(LR_ARTEFACT_STATUSES),
  chargeKind: z.enum(LR_CHARGE_KINDS),
  flatAmountMinor: Paise.nullable(),
  percentBps: z.number().int().nullable(),
  basis: z.enum(LR_CHARGE_BASES),
  separateFromInterest: z.boolean(),
  notCompounded: z.boolean(),
  reason: z.string(),
  sentenceEn: z.string(),
  sentenceHi: z.string().nullable(),
  draftedBy: Id,
  draftedAt: Timestamp,
  approvedBy: Id.nullable(),
  approvedAt: Timestamp.nullable(),
  retiredBy: Id.nullable(),
  retiredAt: Timestamp.nullable(),
});
export type LrPenalText = z.infer<typeof LrPenalText>;
export const LrPenalTextPage = z.strictObject({
  items: z.array(LrPenalText),
  nextCursor: z.string().nullable(),
  overdueReminders: LrOverdueReminders,
});

/**
 * A penal-charge text draft, every field the lender's own. Exactly one of `flatAmountMinor` and `percentBps` goes with the kind
 * (`charge_invalid` otherwise); both attestations must be true (`attestation_missing` otherwise: the attestations are typed as
 * booleans, not as `true`, so the database's refusal is reachable and the same for every client); the reason and the sentences
 * are checked as plain service text (`wording_invalid`).
 */
export const LrPenalTextDraftInput = z.strictObject({
  lenderId: Id,
  chargeKind: z.enum(LR_CHARGE_KINDS),
  flatAmountMinor: Paise.nullable().optional(),
  percentBps: z.number().int().min(0).max(10_000_000).nullable().optional(),
  separateFromInterest: z.boolean(),
  notCompounded: z.boolean(),
  reason: z.string().min(1).max(2000),
  sentenceEn: z.string().min(1).max(4000),
  sentenceHi: z.string().min(1).max(4000).nullable().optional(),
});
export type LrPenalTextDraftInput = z.infer<typeof LrPenalTextDraftInput>;

// ---------------------------------------------------------------------------------------------------------------
// Approve / retire (policy, wording and penal-charge text share the answer)
// ---------------------------------------------------------------------------------------------------------------
/** The id of the artefact and the status it has now. */
export const LrArtefactAction = z.strictObject({ id: Id, status: z.enum(LR_ARTEFACT_STATUSES) });
export type LrArtefactAction = z.infer<typeof LrArtefactAction>;

// ---------------------------------------------------------------------------------------------------------------
// Communication holds
// ---------------------------------------------------------------------------------------------------------------
export const LrHoldListQuery = z.strictObject({
  lenderId: Id.optional(),
  loanAccountId: Id.optional(),
  status: z.enum(LR_HOLD_STATUSES).optional(),
  limit: Limit,
  cursor: CursorText.optional(),
});

/**
 * A pause on reminders for one loan. A hold NEVER blocks the borrower from paying. The notes are the lender's own words,
 * checked as plain service text by the database; they are not written to the audit log.
 */
export const LrHold = z.strictObject({
  id: Id,
  lenderId: Id,
  loanAccountId: Id,
  reason: z.enum(LR_HOLD_REASONS),
  note: z.string().nullable(),
  placedBy: Id,
  placedAt: Timestamp,
  releasedBy: Id.nullable(),
  releasedAt: Timestamp.nullable(),
  releaseNote: z.string().nullable(),
  /** True until the hold is released; derived from `releasedAt` by the database. */
  active: z.boolean(),
});
export type LrHold = z.infer<typeof LrHold>;
export const LrHoldPage = Page(LrHold);

/**
 * Places a hold on one loan. `lenderId` is optional: the loan decides the lender. When it is sent it is an assertion that
 * the loan belongs to that lender (a mismatch answers 404, as does a loan the caller cannot see); the caller needs
 * `loan.read` for the assertion to be checkable.
 */
export const LrHoldPlaceInput = z.strictObject({
  lenderId: Id.optional(),
  reason: z.enum(LR_HOLD_REASONS),
  note: z.string().min(1).max(1000).optional(),
});
export type LrHoldPlaceInput = z.infer<typeof LrHoldPlaceInput>;
export const LrHoldReleaseInput = z.strictObject({
  note: z.string().min(1).max(1000).optional(),
});
export type LrHoldReleaseInput = z.infer<typeof LrHoldReleaseInput>;

export const LrHoldPlaced = z.strictObject({
  id: Id,
  loanAccountId: Id,
  reason: z.enum(LR_HOLD_REASONS),
  active: z.literal(true),
});
export const LrHoldReleased = z.strictObject({ id: Id, active: z.literal(false) });

// ---------------------------------------------------------------------------------------------------------------
// Reminders (what was planned, sent or suppressed) and their attempt log
// ---------------------------------------------------------------------------------------------------------------
export const LrReminderListQuery = z.strictObject({
  lenderId: Id.optional(),
  loanAccountId: Id.optional(),
  status: z.enum(LR_REMINDER_STATUSES).optional(),
  suppressReason: z.enum(LR_SUPPRESS_REASONS).optional(),
  kind: z.enum(LR_REMINDER_KINDS).optional(),
  channel: Channel.optional(),
  /** Scheduled at or after this instant (ISO 8601 with an offset; write `Z` or encode `+` as `%2B` in a URL). */
  from: Timestamp.optional(),
  /** Scheduled before this instant. */
  to: Timestamp.optional(),
  limit: Limit,
  cursor: CursorText.optional(),
});

/**
 * One planned, sent or suppressed message. The rendered wording is NOT stored anywhere the lender can read (the borrower's app
 * rebuilds it from the frozen references), so it is not returned. What is returned is what the table holds for the lender:
 * which message (loan, installment, offset, channel), when it was due to go, where it stands, the closed reason when it was
 * suppressed, and the references frozen when it was claimed (`templateId`, `penalTextId`, the language used and whether Hindi
 * fell back to English). `amountMinor` is the figure the LENDER reported, frozen with the message at claim (null before); the
 * due date is `dueDate`. The borrower is not named: the loan account is the link. No content hash is returned.
 */
export const LrReminder = z.strictObject({
  id: Id,
  lenderId: Id,
  loanAccountId: Id,
  installmentSeq: z.number().int(),
  dueDate: DateOnly,
  offsetDays: z.number().int(),
  channel: Channel,
  kind: z.enum(LR_REMINDER_KINDS),
  scheduledFor: Timestamp,
  status: z.enum(LR_REMINDER_STATUSES),
  suppressReason: z.enum(LR_SUPPRESS_REASONS).nullable(),
  attempts: z.number().int(),
  claimedAt: Timestamp.nullable(),
  templateId: Id.nullable(),
  penalTextId: Id.nullable(),
  languageUsed: z.enum(LR_TEMPLATE_LANGUAGES).nullable(),
  languageFallback: z.boolean(),
  amountMinor: Paise.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type LrReminder = z.infer<typeof LrReminder>;
export const LrReminderPage = Page(LrReminder);

/** Counts of the lender's reminders by status, suppression reason and channel. No borrower, loan or message is named. */
export const LrReminderSummaryQuery = z.strictObject({
  lenderId: Id,
  /** Counts messages scheduled at or after this instant; the database default (the last 30 days) applies when omitted. */
  since: Timestamp.optional(),
});
export const LrReminderSummary = z.strictObject({
  lenderId: Id,
  /** The instant that was asked for, or null when the database default applied. */
  since: Timestamp.nullable(),
  items: z.array(
    z.strictObject({
      status: z.enum(LR_REMINDER_STATUSES),
      suppressReason: z.enum(LR_SUPPRESS_REASONS).nullable(),
      channel: Channel,
      count: z.number().int().min(0),
    }),
  ),
});

/**
 * One attempt in the append-only delivery log. `accepted` means the channel took the message (for in-app: it is in the inbox),
 * NOT that it was delivered; `delivered` appears only from a delivery report; an `sms` attempt can only ever be
 * `not_configured`. The hashes identify the wording that was sent and the penal-charge sentence it carried, as evidence; the
 * wording itself is not stored here.
 */
export const LrDelivery = z.strictObject({
  id: Id,
  channel: Channel,
  state: z.enum(LR_DELIVERY_STATES),
  source: z.enum(LR_DELIVERY_SOURCES),
  providerRef: z.string().nullable(),
  errorClass: z.enum(LR_DELIVERY_ERROR_CLASSES).nullable(),
  contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
  penalTextSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  occurredAt: Timestamp,
});
export const LrDeliveryLog = z.strictObject({ reminderId: Id, items: z.array(LrDelivery) });
