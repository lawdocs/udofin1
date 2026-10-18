import {
  LR_CHARGE_KINDS,
  LR_HOLD_REASONS,
  LR_LIVE_CHANNELS,
  LR_REMINDER_KINDS,
  LR_TEMPLATE_LANGUAGES,
} from '@udofin/contracts';
import { z } from 'zod';
import { type OnboardingApi } from '../onboarding/api.js';
import { parseRupeesToPaise } from '../servicing/format.js';
import { safeErrorCode } from '../servicing/wording.js';
import { parsePercentToBps } from './wording.js';

/**
 * The only writes the lender reminder screens can make. A form names one operation; this table maps it to exactly one API
 * route with the fields checked again here. Anything not listed cannot be invoked from the portal, and the API and the
 * database authorise and validate every call again (including who may approve and that the approver is not the drafter), so
 * this list narrows the surface, it is not the authority.
 *
 * Nothing here suggests, generates, translates or calculates. The wording, the penal-charge sentence and the reason go to the
 * API exactly as the lender typed them; the charge figure is parsed into whole paise or whole basis points exactly as typed and
 * is never applied to any amount.
 */

type Fail = { ok: false; status: number; code: string };
export type RemindersResult = { ok: true; status: number; data: unknown } | Fail;
export interface RemindersOperation {
  run(api: OnboardingApi, form: FormData, key: string): Promise<RemindersResult>;
}

const bad = (code = 'validation_failed'): Promise<Fail> =>
  Promise.resolve({ ok: false, status: 422, code });
const anyResponse = z.unknown();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CLOCK = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

/** A trimmed, non-empty value of a field, or undefined. */
const str = (form: FormData, name: string): string | undefined => {
  const v = form.get(name);
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
};
/** The text exactly as typed (no trimming, no changing), or undefined when it is blank. */
const exact = (form: FormData, name: string, max: number): string | undefined => {
  const v = form.get(name);
  return typeof v === 'string' && v.trim() !== '' && v.length <= max ? v : undefined;
};
const uuid = (form: FormData, name: string): string | undefined => {
  const v = str(form, name);
  return v && UUID.test(v) ? v : undefined;
};
const oneOf = <T extends string>(allowed: readonly T[], value: string | undefined): T | undefined =>
  allowed.find((candidate) => candidate === value);

/** Whole numbers separated by commas ("-3, -1, 0, 7"), 1 to 30 of them; null for anything else. The database decides the range. */
export function parseOffsets(text: string | undefined): number[] | null {
  if (!text) return null;
  const parts = text.split(',').map((part) => part.trim());
  if (parts.length < 1 || parts.length > 30) return null;
  const numbers: number[] = [];
  for (const part of parts) {
    if (!/^(0|-?[1-9][0-9]{0,3})$/.test(part)) return null;
    numbers.push(Number(part));
  }
  return numbers;
}

const post = (api: OnboardingApi, path: string, body: unknown, key: string) =>
  api.post(path, anyResponse, body, key);

/**
 * An action on one existing version by its id. Approving needs the approver to tick that they read it (`reviewed`): the box
 * is never ticked for them, and nothing is sent without it.
 */
const idAction = (route: (id: string) => string, needsReview = false): RemindersOperation => ({
  run: (api, form, key) => {
    const id = uuid(form, 'id');
    if (!id) return bad();
    if (needsReview && form.get('reviewed') !== 'on') return bad('review_required');
    return post(api, route(id), {}, key);
  },
});

export const REMINDERS_OPERATIONS: Readonly<Record<string, RemindersOperation>> = {
  // ---- Policy ------------------------------------------------------------------------------------------------------
  'reminders.policy.draft': {
    run: (api, form, key) => {
      const lenderId = uuid(form, 'lenderId');
      if (!lenderId) return bad();
      const offsetsDays = parseOffsets(str(form, 'offsets'));
      if (!offsetsDays) return bad('offsets_format');
      // Only the channels that can carry a message are offered. SMS is an inert placeholder (never sent) and is not accepted here.
      const chosen = form.getAll('channels').filter((v): v is string => typeof v === 'string');
      const channels = [...new Set(chosen)];
      if (channels.length === 0) return bad('channels_required');
      if (channels.some((c) => oneOf(LR_LIVE_CHANNELS, c) === undefined))
        return bad('channels_invalid');
      const windowFrom = str(form, 'windowFrom');
      const windowTo = str(form, 'windowTo');
      if (!windowFrom || !windowTo || !CLOCK.test(windowFrom) || !CLOCK.test(windowTo))
        return bad('time_invalid');
      const capText = str(form, 'maxPerDay');
      const maxPerDay = capText && /^[0-9]{1,4}$/.test(capText) ? Number(capText) : NaN;
      if (!(maxPerDay >= 0 && maxPerDay <= 1000)) return bad('cap_invalid');
      return post(
        api,
        '/v1/lender/reminder-policies',
        {
          lenderId,
          offsetsDays,
          overdueWeekly: form.get('overdueWeekly') === 'on',
          channels,
          windowFrom,
          windowTo,
          maxPerDay,
        },
        key,
      );
    },
  },
  'reminders.policy.approve': idAction(
    (id) => `/v1/lender/reminder-policies/${id}/approve`,
    true,
  ),
  'reminders.policy.retire': idAction((id) => `/v1/lender/reminder-policies/${id}/retire`),

  // ---- Wording -----------------------------------------------------------------------------------------------------
  'reminders.template.draft': {
    run: (api, form, key) => {
      const lenderId = uuid(form, 'lenderId');
      const kind = oneOf(LR_REMINDER_KINDS, str(form, 'kind'));
      const language = oneOf(LR_TEMPLATE_LANGUAGES, str(form, 'language'));
      if (!lenderId || !kind || !language) return bad();
      // The wording is the lender's own. It goes through byte for byte; the API and the database decide whether it is acceptable.
      const body = exact(form, 'body', 4000);
      if (!body) return bad('body_required');
      return post(api, '/v1/lender/reminder-templates', { lenderId, kind, language, body }, key);
    },
  },
  'reminders.template.approve': idAction(
    (id) => `/v1/lender/reminder-templates/${id}/approve`,
    true,
  ),
  'reminders.template.retire': idAction(
    (id) => `/v1/lender/reminder-templates/${id}/retire`,
  ),

  // ---- The lender's penal-charge text -------------------------------------------------------------------------------
  'reminders.penal.draft': {
    run: (api, form, key) => {
      const lenderId = uuid(form, 'lenderId');
      const chargeKind = oneOf(LR_CHARGE_KINDS, str(form, 'chargeKind'));
      if (!lenderId || !chargeKind) return bad();
      // The figure is the lender's. A flat amount is whole paise exactly as typed; a percentage is whole basis points exactly as
      // typed. Neither is ever applied to an amount, rounded or compared here.
      const flatText = str(form, 'flatAmount');
      const percentText = str(form, 'percent');
      let figure: { flatAmountMinor: number } | { percentBps: number };
      if (chargeKind === 'flat') {
        if (percentText !== undefined) return bad('charge_choice');
        const flatAmountMinor = parseRupeesToPaise(flatText ?? '');
        if (flatAmountMinor === null) return bad('amount_invalid');
        figure = { flatAmountMinor };
      } else {
        if (flatText !== undefined) return bad('charge_choice');
        const percentBps = parsePercentToBps(percentText ?? '');
        if (percentBps === null) return bad('percent_invalid');
        figure = { percentBps };
      }
      // Both statements are the lender's own and must be ticked; they are never ticked for the lender.
      if (form.get('separateFromInterest') !== 'on' || form.get('notCompounded') !== 'on')
        return bad('attestation_missing');
      const reason = exact(form, 'reason', 2000);
      const sentenceEn = exact(form, 'sentenceEn', 4000);
      if (!reason || !sentenceEn) return bad('text_required');
      const hiRaw = form.get('sentenceHi');
      const sentenceHi = typeof hiRaw === 'string' && hiRaw.trim() !== '' ? hiRaw : undefined;
      if (sentenceHi !== undefined && sentenceHi.length > 4000) return bad('validation_failed');
      return post(
        api,
        '/v1/lender/penal-charge-texts',
        {
          lenderId,
          chargeKind,
          ...figure,
          separateFromInterest: true,
          notCompounded: true,
          reason,
          sentenceEn,
          ...(sentenceHi !== undefined ? { sentenceHi } : {}),
        },
        key,
      );
    },
  },
  'reminders.penal.approve': idAction(
    (id) => `/v1/lender/penal-charge-texts/${id}/approve`,
    true,
  ),
  'reminders.penal.retire': idAction((id) => `/v1/lender/penal-charge-texts/${id}/retire`),

  // ---- Holds -------------------------------------------------------------------------------------------------------
  'reminders.hold.place': {
    run: (api, form, key) => {
      const loanId = uuid(form, 'loanAccountId');
      const reason = oneOf(LR_HOLD_REASONS, str(form, 'reason'));
      if (!loanId) return bad('id_invalid');
      if (!reason) return bad();
      const noteText = str(form, 'note');
      if (noteText !== undefined && noteText.length > 1000) return bad('note_invalid');
      return post(
        api,
        `/v1/lender/loans/${loanId}/communication-hold`,
        { reason, ...(noteText !== undefined ? { note: noteText } : {}) },
        key,
      );
    },
  },
  'reminders.hold.release': {
    run: (api, form, key) => {
      const id = uuid(form, 'id');
      if (!id) return bad();
      const noteText = str(form, 'note');
      if (noteText !== undefined && noteText.length > 1000) return bad('note_invalid');
      return post(
        api,
        `/v1/lender/communication-holds/${id}/release`,
        noteText !== undefined ? { note: noteText } : {},
        key,
      );
    },
  },
};

export type RemindersOutcome = { ok: true } | { ok: false; code: string };

const KEY = /^[A-Za-z0-9._:-]{16,128}$/;

/**
 * Runs the operation a form names. Unknown operations are refused without any call to the API, and so is a key of the wrong
 * shape (the key makes a retry safe: the API applies one request once).
 */
export async function runRemindersOperation(
  api: OnboardingApi,
  form: FormData,
): Promise<RemindersOutcome> {
  const name = form.get('op');
  const key = form.get('key');
  const operation =
    typeof name === 'string' && Object.hasOwn(REMINDERS_OPERATIONS, name)
      ? REMINDERS_OPERATIONS[name]
      : undefined;
  if (!operation) return { ok: false, code: 'path_not_allowed' };
  if (typeof key !== 'string' || !KEY.test(key)) return { ok: false, code: 'validation_failed' };
  const result = await operation.run(api, form, key);
  return result.ok ? { ok: true } : { ok: false, code: safeErrorCode(result.code) };
}

/** Where a form may return to: the lender reminder pages only (prevents an open redirect). */
export function safeRemindersReturnPath(value: unknown): string {
  const QUERY = String.raw`(?:\?[A-Za-z0-9=&_.%-]{1,700})?`;
  const ID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  const allowed = new RegExp(
    `^/reminders(?:/policy|/wording|/penal-text|/holds|/${ID})?${QUERY}$`,
  );
  return typeof value === 'string' && allowed.test(value) ? value : '/reminders';
}

/** The page address to go back to after an action, with the result as `done=1` or a short `error` code (nothing else). */
export function remindersNoticeUrl(returnTo: string, outcome: RemindersOutcome): string {
  const [path = '/reminders', query = ''] = returnTo.split('?', 2);
  const kept = query.split('&').filter((part) => part !== '' && !/^(done|error)=/.test(part));
  kept.push(outcome.ok ? 'done=1' : `error=${encodeURIComponent(safeErrorCode(outcome.code))}`);
  return `${path}?${kept.join('&')}`;
}
