import {
  LR_ARTEFACT_STATUSES,
  LR_CHANNELS,
  LR_HOLD_STATUSES,
  LR_REMINDER_KINDS,
  LR_REMINDER_STATUSES,
  LR_SUPPRESS_REASONS,
  LR_TEMPLATE_LANGUAGES,
  LrDeliveryLog,
  LrHoldPage,
  LrPenalTextPage,
  LrPolicyPage,
  LrReminderPage,
  LrReminderSummary,
  LrTemplatePage,
} from '@udofin/contracts';
import { type OnboardingApi } from '../onboarding/api.js';

// ---------------------------------------------------------------------------------------------------------------
// What the signed-in person may do, per lender. Hiding a form is a convenience: the API and the database decide.
// ---------------------------------------------------------------------------------------------------------------
export interface MembershipLike {
  organizationId: string;
  organizationKind: string;
  organizationName: string;
  permissions: readonly string[];
}

export interface RemindersGrant {
  lenderId: string;
  name: string;
  /** May read loans, holds, reminders and the summary (loan.read). */
  read: boolean;
  /** May draft and retire policy, wording and penal-charge text, and place and release holds (reminder.policy.manage). */
  manage: boolean;
  /** May approve a draft that ANOTHER person made (reminder.template.approve). */
  approve: boolean;
}

export type RemindersAbility = 'read' | 'manage' | 'approve';

/** One grant per lender organisation the person belongs to. Platform memberships hold no lender grant, so they get no write form. */
export function reminderGrants(memberships: readonly MembershipLike[]): RemindersGrant[] {
  return memberships
    .filter((m) => m.organizationKind === 'lender')
    .map((m) => ({
      lenderId: m.organizationId,
      name: m.organizationName,
      read: m.permissions.includes('loan.read'),
      manage: m.permissions.includes('reminder.policy.manage'),
      approve: m.permissions.includes('reminder.template.approve'),
    }));
}

/** Whether the person holds an ability in that lender. An unknown lender gives false. */
export const mayIn = (
  grants: readonly RemindersGrant[],
  lenderId: string,
  ability: RemindersAbility,
): boolean => grants.some((g) => g.lenderId === lenderId && g[ability]);

/** The policy, wording and penal-charge lists open to loan.read, reminder.policy.manage or reminder.template.approve. */
export const mayViewArtefacts = (grant: RemindersGrant): boolean =>
  grant.read || grant.manage || grant.approve;

/**
 * Whether an approve form may be drawn for a draft: the person holds the approve permission in that lender, the artefact is a
 * draft, and the person is NOT the one who drafted it. The API and the database refuse self-approval again; this only hides the form.
 */
export const mayApprove = (
  grants: readonly RemindersGrant[],
  lenderId: string,
  artefact: { status: string; draftedBy: string },
  userId: string,
): boolean =>
  artefact.status === 'draft' &&
  artefact.draftedBy !== userId &&
  mayIn(grants, lenderId, 'approve');

/** Whether a retire form may be drawn: the person manages reminders in that lender and the artefact is not retired yet. */
export const mayRetire = (
  grants: readonly RemindersGrant[],
  lenderId: string,
  artefact: { status: string },
): boolean => artefact.status !== 'retired' && mayIn(grants, lenderId, 'manage');

/** The lender a page is about: the one asked for if the person belongs to it, else the first that fits. Null when none fits. */
export function chooseLender(
  grants: readonly RemindersGrant[],
  asked: string | undefined,
  fits: (grant: RemindersGrant) => boolean,
): RemindersGrant | null {
  const candidates = grants.filter(fits);
  return candidates.find((g) => g.lenderId === asked) ?? candidates[0] ?? null;
}

// ---------------------------------------------------------------------------------------------------------------
// Page queries (from the URL). Anything that does not look right is dropped, never passed on.
// ---------------------------------------------------------------------------------------------------------------
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CURSOR = /^[A-Za-z0-9_-]{1,300}$/;

export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && UUID.test(value);

const one = (value: string | string[] | undefined): string | undefined =>
  typeof value === 'string' ? value : undefined;
const oneOf = <T extends string>(allowed: readonly T[], value: string | undefined) =>
  allowed.find((candidate) => candidate === value);

export interface RemindersQuery {
  cursor?: string;
  lenderId?: string;
  loanAccountId?: string;
  status?: string;
  kind?: string;
  language?: string;
  channel?: string;
  suppressReason?: string;
}

/**
 * Reads the filters a reminders page understands from its URL. `statuses` names the closed values of the status filter of that
 * page (artefact statuses, hold statuses or reminder statuses); a value outside the list is dropped.
 */
export function parseRemindersQuery(
  raw: Record<string, string | string[] | undefined>,
  statuses: readonly string[] = [],
): RemindersQuery {
  const cursor = one(raw.cursor);
  const lenderId = one(raw.lenderId);
  const loanAccountId = one(raw.loanAccountId);
  const status = oneOf(statuses, one(raw.status));
  const kind = oneOf(LR_REMINDER_KINDS, one(raw.kind));
  const language = oneOf(LR_TEMPLATE_LANGUAGES, one(raw.language));
  const channel = oneOf(LR_CHANNELS, one(raw.channel));
  const suppressReason = oneOf(LR_SUPPRESS_REASONS, one(raw.suppressReason));
  return {
    ...(cursor && CURSOR.test(cursor) ? { cursor } : {}),
    ...(isUuid(lenderId) ? { lenderId } : {}),
    ...(isUuid(loanAccountId) ? { loanAccountId } : {}),
    ...(status ? { status } : {}),
    ...(kind ? { kind } : {}),
    ...(language ? { language } : {}),
    ...(channel ? { channel } : {}),
    ...(suppressReason ? { suppressReason } : {}),
  };
}

/** The status values each page accepts in its URL. */
export const STATUS_FILTERS = {
  artefact: LR_ARTEFACT_STATUSES,
  hold: LR_HOLD_STATUSES,
  reminder: LR_REMINDER_STATUSES,
} as const;

const qs = (params: Record<string, string | number | undefined>): string => {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
  return parts.length > 0 ? `?${parts.join('&')}` : '';
};

/** The query string for a link back to a list page with some filters (used for "older" links and filter links). */
export const remindersHref = (base: string, query: RemindersQuery): string =>
  `${base}${qs({
    lenderId: query.lenderId,
    loanAccountId: query.loanAccountId,
    status: query.status,
    kind: query.kind,
    language: query.language,
    channel: query.channel,
    suppressReason: query.suppressReason,
    cursor: query.cursor,
  })}`;

/** The same filters without the page position (for a link back to the first page). */
export const withoutCursor = (query: RemindersQuery): RemindersQuery => {
  const { cursor: _cursor, ...rest } = query;
  return rest;
};

// ---------------------------------------------------------------------------------------------------------------
// Loaders. Every response is checked against the contract by the API client; a failure is a code, never server text.
// ---------------------------------------------------------------------------------------------------------------
export const loadPolicies = (api: OnboardingApi, lenderId: string, query: RemindersQuery) =>
  api.get(
    `/v1/lender/reminder-policies${qs({ lenderId, limit: 25, cursor: query.cursor, status: oneOf(LR_ARTEFACT_STATUSES, query.status) })}`,
    LrPolicyPage,
  );

export const loadTemplates = (api: OnboardingApi, lenderId: string, query: RemindersQuery) =>
  api.get(
    `/v1/lender/reminder-templates${qs({
      lenderId,
      limit: 25,
      cursor: query.cursor,
      status: oneOf(LR_ARTEFACT_STATUSES, query.status),
      kind: oneOf(LR_REMINDER_KINDS, query.kind),
      language: oneOf(LR_TEMPLATE_LANGUAGES, query.language),
    })}`,
    LrTemplatePage,
  );

export const loadPenalTexts = (
  api: OnboardingApi,
  lenderId: string,
  query: RemindersQuery,
  limit = 25,
) =>
  api.get(
    `/v1/lender/penal-charge-texts${qs({ lenderId, limit, cursor: query.cursor, status: oneOf(LR_ARTEFACT_STATUSES, query.status) })}`,
    LrPenalTextPage,
  );

export const loadHolds = (api: OnboardingApi, query: RemindersQuery) =>
  api.get(
    `/v1/lender/communication-holds${qs({
      limit: 25,
      cursor: query.cursor,
      lenderId: query.lenderId,
      loanAccountId: query.loanAccountId,
      status: oneOf(LR_HOLD_STATUSES, query.status),
    })}`,
    LrHoldPage,
  );

export const loadReminders = (api: OnboardingApi, query: RemindersQuery) =>
  api.get(
    `/v1/lender/reminders${qs({
      limit: 25,
      cursor: query.cursor,
      lenderId: query.lenderId,
      loanAccountId: query.loanAccountId,
      status: oneOf(LR_REMINDER_STATUSES, query.status),
      suppressReason: oneOf(LR_SUPPRESS_REASONS, query.suppressReason),
      kind: oneOf(LR_REMINDER_KINDS, query.kind),
      channel: oneOf(LR_CHANNELS, query.channel),
    })}`,
    LrReminderPage,
  );

export const loadSummary = (api: OnboardingApi, lenderId: string) =>
  api.get(`/v1/lender/reminders/summary${qs({ lenderId })}`, LrReminderSummary);

export const loadDeliveries = (api: OnboardingApi, reminderId: string) =>
  api.get(`/v1/lender/reminders/${reminderId}/deliveries`, LrDeliveryLog);
