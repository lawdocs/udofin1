// Unit tests for the lender reminder routes that need no database: every route is declared the way the platform requires (staff
// only, rate limited, every write idempotent and answered with a declared strict response) and the wire contracts keep the closed
// lists and the "the lender's words, passed through" shape. The database-backed behaviour is in
// test/integration/lender-reminders.integration.test.ts.
import {
  LR_CHANNELS,
  LR_INERT_CHANNELS,
  LR_LIVE_CHANNELS,
  LR_SUPPRESS_REASONS,
  LR_TEMPLATE_VARIABLES,
  LrHoldPlaceInput,
  LrOverdueReminders,
  LrPenalTextDraftInput,
  LrPolicyDraftInput,
  LrReminderListQuery,
  LrTemplateDraftInput,
} from '@udofin/contracts';
import { describe, expect, it } from 'vitest';
import { lenderRemindersRoutes } from '../src/modules/lender-reminders/routes.js';

const routes = lenderRemindersRoutes({});
const LENDER = '0192b5c0-0000-7000-8000-000000000001';

describe('lender reminder routes: declarations', () => {
  it('declares eighteen routes under /v1/lender with unique operation ids and unique method and path pairs', () => {
    expect(routes).toHaveLength(18);
    expect(new Set(routes.map((r) => r.operationId)).size).toBe(routes.length);
    expect(new Set(routes.map((r) => `${r.method} ${r.path}`)).size).toBe(routes.length);
    for (const route of routes) expect(route.path.startsWith('/v1/lender/')).toBe(true);
  });

  it('allows staff only, rate limits every route, and makes every write idempotent', () => {
    for (const route of routes) {
      expect([route.operationId, route.auth]).toEqual([route.operationId, 'staff']);
      expect([
        route.operationId,
        route.rateLimit !== undefined && route.rateLimit !== false,
      ]).toEqual([route.operationId, true]);
      if (route.method === 'post')
        expect([route.operationId, 'idempotent' in route && route.idempotent === true]).toEqual([
          route.operationId,
          true,
        ]);
    }
  });

  it('answers writes with 200 or 201 and reads with 200 only, each with a declared schema', () => {
    for (const route of routes) {
      const statuses = Object.keys(route.responses).map(Number);
      expect(statuses.length).toBe(1);
      if (route.method === 'get') expect(statuses).toEqual([200]);
      else expect([200, 201]).toContain(statuses[0]);
    }
  });

  it('puts every list of rows behind a query and every id behind a uuid path parameter', () => {
    for (const route of routes) {
      if (route.method === 'get' && !route.path.includes(':id') && !route.path.endsWith('/summary'))
        expect([route.operationId, route.query !== undefined]).toEqual([route.operationId, true]);
      if (route.path.includes(':id'))
        expect([route.operationId, route.params !== undefined]).toEqual([route.operationId, true]);
    }
  });
});

describe('lender reminder contracts', () => {
  it('names sms as an inert placeholder that is not a live channel', () => {
    expect(LR_CHANNELS).toContain('sms');
    expect(LR_INERT_CHANNELS).toEqual(['sms']);
    expect(LR_LIVE_CHANNELS).toEqual(['in_app', 'push']);
    for (const live of LR_LIVE_CHANNELS) expect(LR_INERT_CHANNELS).not.toContain(live);
    expect(LR_SUPPRESS_REASONS).toContain('sms_not_configured');
    expect(LR_SUPPRESS_REASONS).toContain('penal_text_missing');
  });

  it('keeps the placeholder set of a wording closed', () => {
    expect([...LR_TEMPLATE_VARIABLES].sort()).toEqual([
      'amount',
      'due_date',
      'lender_name',
      'penal_text',
    ]);
  });

  it('accepts a policy draft and rejects an extra field, a repeat-free channel list outside the closed set and a malformed time', () => {
    const ok = {
      lenderId: LENDER,
      offsetsDays: [-3, 0, 1],
      overdueWeekly: true,
      channels: ['in_app', 'push'],
      windowFrom: '09:00',
      windowTo: '18:00',
      maxPerDay: 2,
    };
    expect(LrPolicyDraftInput.safeParse(ok).success).toBe(true);
    expect(LrPolicyDraftInput.safeParse({ ...ok, extra: 1 }).success).toBe(false);
    expect(LrPolicyDraftInput.safeParse({ ...ok, channels: ['whatsapp'] }).success).toBe(false);
    expect(LrPolicyDraftInput.safeParse({ ...ok, windowFrom: '9:00' }).success).toBe(false);
    expect(LrPolicyDraftInput.safeParse({ ...ok, windowTo: '24:00' }).success).toBe(false);
    expect(LrPolicyDraftInput.safeParse({ ...ok, offsetsDays: [] }).success).toBe(false);
    // The database decides what is acceptable: a repeated offset or a cap of 3 passes the shape check and reaches it.
    expect(LrPolicyDraftInput.safeParse({ ...ok, offsetsDays: [1, 1], maxPerDay: 3 }).success).toBe(
      true,
    );
  });

  it('lets a draft with a false attestation or a figure the database will refuse reach the database, so its own refusal is the answer', () => {
    const ok = {
      lenderId: LENDER,
      chargeKind: 'flat',
      flatAmountMinor: 50_000,
      separateFromInterest: true,
      notCompounded: true,
      reason: 'Late payment charge stated in the loan agreement',
      sentenceEn: 'A late payment charge applies as stated in your agreement.',
    };
    expect(LrPenalTextDraftInput.safeParse(ok).success).toBe(true);
    expect(LrPenalTextDraftInput.safeParse({ ...ok, separateFromInterest: false }).success).toBe(
      true,
    );
    expect(
      LrPenalTextDraftInput.safeParse({ ...ok, flatAmountMinor: 200_000_000_000 }).success,
    ).toBe(true);
    expect(LrPenalTextDraftInput.safeParse({ ...ok, percentBps: 200 }).success).toBe(true);
    // Not a number of paise: never a float, never negative.
    expect(LrPenalTextDraftInput.safeParse({ ...ok, flatAmountMinor: 500.5 }).success).toBe(false);
    expect(LrPenalTextDraftInput.safeParse({ ...ok, flatAmountMinor: -1 }).success).toBe(false);
    expect(LrPenalTextDraftInput.safeParse({ ...ok, computedCharge: 1 }).success).toBe(false);
    expect(LrPenalTextDraftInput.safeParse({ ...ok, sentenceHi: null }).success).toBe(true);
    expect(LrPenalTextDraftInput.safeParse({ ...ok, sentenceEn: undefined }).success).toBe(false);
  });

  it("takes a wording as the lender's text and a kind and language from the closed lists only", () => {
    const ok = {
      lenderId: LENDER,
      kind: 'pre_due',
      language: 'en',
      body: 'Your installment is due on {{due_date}}.',
    };
    expect(LrTemplateDraftInput.safeParse(ok).success).toBe(true);
    expect(LrTemplateDraftInput.safeParse({ ...ok, kind: 'offer' }).success).toBe(false);
    expect(LrTemplateDraftInput.safeParse({ ...ok, language: 'fr' }).success).toBe(false);
    expect(LrTemplateDraftInput.safeParse({ ...ok, body: '' }).success).toBe(false);
    expect(LrTemplateDraftInput.safeParse({ ...ok, suggest: true }).success).toBe(false);
  });

  it('takes a hold with a reason from the closed list, an optional lender and an optional note', () => {
    expect(LrHoldPlaceInput.safeParse({ reason: 'complaint' }).success).toBe(true);
    expect(
      LrHoldPlaceInput.safeParse({
        reason: 'hardship',
        lenderId: LENDER,
        note: 'A short note here.',
      }).success,
    ).toBe(true);
    expect(LrHoldPlaceInput.safeParse({ reason: 'bored' }).success).toBe(false);
    expect(LrHoldPlaceInput.safeParse({ reason: 'legal', loan: LENDER }).success).toBe(false);
  });

  it('filters reminders by closed lists and times only, with a bounded page', () => {
    expect(LrReminderListQuery.safeParse({}).success).toBe(true);
    expect(LrReminderListQuery.parse({}).limit).toBe(25);
    expect(LrReminderListQuery.safeParse({ status: 'queued' }).success).toBe(false);
    expect(LrReminderListQuery.safeParse({ suppressReason: 'sms_not_configured' }).success).toBe(
      true,
    );
    expect(
      LrReminderListQuery.safeParse({
        from: '2026-10-18T00:00:00Z',
        to: '2026-10-19T00:00:00+05:30',
      }).success,
    ).toBe(true);
    expect(LrReminderListQuery.safeParse({ from: '2026-10-18' }).success).toBe(false);
    expect(LrReminderListQuery.safeParse({ limit: '101' }).success).toBe(false);
    expect(LrReminderListQuery.safeParse({ borrowerId: LENDER }).success).toBe(false);
  });

  it('keeps the derived overdue flag a strict pair of booleans', () => {
    expect(
      LrOverdueReminders.safeParse({ penalTextApproved: false, overdueRemindersWithheld: true })
        .success,
    ).toBe(true);
    expect(LrOverdueReminders.safeParse({ penalTextApproved: false }).success).toBe(false);
    expect(
      LrOverdueReminders.safeParse({
        penalTextApproved: false,
        overdueRemindersWithheld: true,
        text: 'x',
      }).success,
    ).toBe(false);
  });
});
