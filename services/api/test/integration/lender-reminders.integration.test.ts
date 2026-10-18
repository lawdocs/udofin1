// Phase 08a lender reminders over HTTP: the reminder policy, the reminder wording, the lender's penal-charge text, communication
// holds, the reminders themselves, their summary and their attempt log, against a REAL migrated Postgres (same gating as the
// other integration files; needs INTEGRATION_ADMIN_URL, INTEGRATION_API_URL and INTEGRATION_SYSTEM_URL and a freshly migrated
// database). Synthetic data only.
//
// Fixtures: two lenders; per lender a communications administrator (reminder.policy.manage, loan.read), a communications
// approver (reminder.template.approve, loan.read) and, for lender A, a viewer (loan.read only), a user with no reminder or loan
// permission at all and one login that holds BOTH reminder permissions (inserted past the segregation trigger on purpose, to prove
// the database refuses self-approval); a platform operations user (loan.read across lenders); a borrower login. The rows the
// reminder worker writes in production (the reminders and their delivery attempts) are inserted here AS THE TABLE OWNER with
// session_replication_role = replica, which switches off triggers and foreign key checks for that transaction only (the check
// constraints and unique indexes still apply). Everything else goes through the real HTTP routes and the real SQL functions with
// row level security applied.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import {
  LR_ARTEFACT_STATUSES,
  LR_CHANNELS,
  LR_CHARGE_BASES,
  LR_CHARGE_KINDS,
  LR_DELIVERY_ERROR_CLASSES,
  LR_DELIVERY_SOURCES,
  LR_DELIVERY_STATES,
  LR_HOLD_REASONS,
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
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app.js';
import { TokenError, type TokenVerifier } from '../../src/auth/token-verifier.js';
import { loadConfig } from '../../src/config.js';
import { createUserContext } from '../../src/db/user-context.js';

const ADMIN = process.env.INTEGRATION_ADMIN_URL;
const API = process.env.INTEGRATION_API_URL;
const SYSTEM = process.env.INTEGRATION_SYSTEM_URL;
const enabled = Boolean(ADMIN && API && SYSTEM);

const fakeVerifier: TokenVerifier = {
  verify(header) {
    const match = /^Bearer test\.([0-9a-f-]{36})\.(aal1|aal2)$/.exec(header ?? '');
    if (!match?.[1] || !match[2]) return Promise.reject(new TokenError('invalid'));
    return Promise.resolve({ sub: match[1], aal: match[2] as 'aal1' | 'aal2', sessionId: null });
  },
};
let nextAddress = 1;
const freshAddress = () => `10.14.${(nextAddress >> 8) & 255}.${nextAddress++ & 255}`;

const TAG = randomUUID().slice(0, 8);
// Values that must never come back in a response or a log line. They are planted in the columns that hold personal-looking
// values, content hashes and the lender's display name, and in refused requests, and every response of this file is scanned for
// them at the end.
const CANARY = {
  phone: `91${Math.floor(7_000_000_000 + Math.random() * 2_999_999_999)}`,
  account: `ACCTNO${Math.floor(100_000_000 + Math.random() * 899_999_999)}`,
  link: `https://pay.example.test/checkout/CANARYLINK${TAG}`,
  lenderName: `CANARY-LENDER-NAME-${TAG}`,
  remindersHash: 'ab'.repeat(32),
  remindersPenalHash: 'cd'.repeat(32),
  deliveryHash: 'ef'.repeat(32),
  deliveryPenalHash: '12'.repeat(32),
  marker: `CANARYNOTE${TAG}`,
};

interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
interface Problem {
  code?: string;
  status?: number;
  detail?: string;
}

// ---------------------------------------------------------------------------------------------------------------------------
// The lender's words used in the tests (all synthetic, all plain service text)
// ---------------------------------------------------------------------------------------------------------------------------
const POLICY_OK = {
  offsetsDays: [-3, 0, 1, 7],
  overdueWeekly: true,
  channels: ['in_app', 'push'],
  windowFrom: '09:00',
  windowTo: '18:00',
  maxPerDay: 2,
};
const WORDING = {
  pre_due: `Your installment of {{amount}} with {{lender_name}} is due on {{due_date}}. Please keep your account ready. ${TAG}`,
  due_day: 'Your installment of {{amount}} with {{lender_name}} is due today, {{due_date}}.',
  overdue:
    'Your installment with {{lender_name}} due on {{due_date}} is overdue by {{amount}}. {{penal_text}}',
  overdue_hi:
    'आपकी {{lender_name}} की किस्त {{due_date}} को देय थी और {{amount}} बकाया है। {{penal_text}}',
};
const PENAL_FLAT = {
  chargeKind: 'flat',
  flatAmountMinor: 50_000,
  percentBps: null,
  separateFromInterest: true,
  notCompounded: true,
  reason: 'Late payment charge stated in the loan agreement',
  sentenceEn: 'A late payment charge of Rs 500 applies as stated in your loan agreement.',
  sentenceHi: 'आपके ऋण अनुबंध के अनुसार विलंब शुल्क लागू है।',
};
const PENAL_PERCENT = {
  chargeKind: 'percentage',
  flatAmountMinor: null,
  percentBps: 200,
  separateFromInterest: true,
  notCompounded: true,
  reason: 'Charge on the overdue amount stated in the loan agreement',
  sentenceEn:
    'A charge of 2 percent of the overdue amount applies as stated in your loan agreement.',
  sentenceHi: null,
};

describe.skipIf(!enabled)('lender reminders over HTTP', () => {
  const ids = {
    platformOrg: randomUUID() as string,
    lenderA: randomUUID(),
    lenderB: randomUUID(),
    aAdmin: randomUUID(), // communications_admin: reminder.policy.manage + loan.read
    aApprover: randomUUID(), // communications_approver: reminder.template.approve + loan.read
    aApprover2: randomUUID(),
    aViewer: randomUUID(), // viewer: loan.read, no reminder permission
    aNone: randomUUID(), // payments_admin: no loan.read and no reminder permission
    aBoth: randomUUID(), // holds BOTH reminder permissions (past the segregation trigger, on purpose)
    bAdmin: randomUUID(),
    bApprover: randomUUID(),
    pOps: randomUUID(), // operations_agent: loan.read across lenders
    borrower: randomUUID(),
    spammer: randomUUID(),
  };
  let admin: pg.Pool;
  let apiPool: pg.Pool;
  let app: Awaited<ReturnType<typeof buildApp>>;
  /** Every response body this file received, for the final scan. */
  const seen: string[] = [];
  /** Request bodies of REFUSED drafts: nothing of them may come back in a response or a log. */
  const refusedPayloads: string[] = [];
  /** Remembers a refused text for the final scan (short strings are not distinctive enough to scan for). */
  const refused = (text: string) => {
    if (text.length >= 16) refusedPayloads.push(text);
  };

  const call = (
    method: 'GET' | 'POST',
    url: string,
    user: string | null,
    payload?: unknown,
    options: { aal?: 'aal1' | 'aal2'; key?: string | null } = {},
  ) =>
    app
      .inject({
        method,
        url,
        remoteAddress: freshAddress(),
        headers: {
          ...(user ? { authorization: `Bearer test.${user}.${options.aal ?? 'aal2'}` } : {}),
          ...(method === 'POST' && options.key !== null
            ? { 'idempotency-key': options.key ?? `it-${randomUUID()}` }
            : {}),
        },
        ...(payload === undefined ? {} : { payload: payload as object }),
      })
      .then((res) => {
        seen.push(res.body);
        return res;
      });
  type Res = Awaited<ReturnType<typeof call>>;
  const get = (url: string, user: string | null) => call('GET', url, user);
  const post = (
    url: string,
    user: string | null,
    payload: unknown = {},
    options: { aal?: 'aal1' | 'aal2'; key?: string | null } = {},
  ) => call('POST', url, user, payload, options);
  const code = (res: { json: () => unknown }) => (res.json() as Problem).code;
  const outcome = (res: Res) => [res.statusCode, code(res)];
  const q = async <T extends pg.QueryResultRow>(sql: string, values: unknown[] = []) =>
    (await admin.query<T>(sql, values)).rows;
  const countOf = async (sql: string, values: unknown[] = []) =>
    Number((await q<{ n: string }>(sql, values))[0]?.n ?? -1);
  const rowsOf = <T>(res: Res): T[] => res.json<Page<T>>().items;
  const keys = (value: unknown) => Object.keys(value as Record<string, unknown>).sort();
  const idsOf = (rows: { id: string }[]) => rows.map((r) => r.id);

  /** Runs statements as the table owner with triggers and foreign keys switched off for this transaction only. */
  async function replica(work: (c: pg.PoolClient) => Promise<void>) {
    const c = await admin.connect();
    try {
      await c.query('begin');
      await c.query('set local session_replication_role = replica');
      await work(c);
      await c.query('commit');
    } catch (error) {
      await c.query('rollback');
      throw error;
    } finally {
      c.release();
    }
  }

  async function member(org: string, user: string, kind: 'lender' | 'platform', role: string) {
    const m = await admin.query<{ id: string }>(
      'insert into tenancy.memberships (org_id, user_id, status) values ($1, $2, $3) returning id',
      [org, user, 'active'],
    );
    await admin.query(
      `insert into tenancy.membership_roles (membership_id, role_id)
       select $1, r.id from tenancy.roles r where r.org_id is null and r.applies_to = $2::tenancy.organization_kind and r.key = $3`,
      [m.rows[0]?.id, kind, role],
    );
  }

  /** Calls a database function as a signed-in user (role authenticated, claims set) and rolls back. */
  async function asUser(user: string, aal: 'aal1' | 'aal2', sql: string, values: unknown[] = []) {
    const c = await admin.connect();
    try {
      await c.query('begin');
      await c.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: user, role: 'authenticated', aal }),
      ]);
      await c.query('set local role authenticated');
      const r = await c.query(sql, values);
      return { ok: true as const, rows: r.rows as unknown[] };
    } catch (error) {
      const { code: sqlstate, hint } = error as { code?: string; hint?: string };
      return { ok: false as const, code: sqlstate, hint };
    } finally {
      await c.query('rollback');
      c.release();
    }
  }

  /** The literals of a closed-list check constraint (`<table>_<column>_check`), in the database's own order. */
  async function checkList(table: string, column: string): Promise<string[]> {
    const rows = await q<{ def: string }>(
      `select pg_get_constraintdef(c.oid) as def from pg_constraint c
        where c.conrelid = ('servicing.' || $1)::regclass and c.conname = $2 and c.contype = 'c'`,
      [table, `${table}_${column}_check`],
    );
    const def = rows[0]?.def;
    if (!def) throw new Error(`no check constraint ${table}_${column}_check`);
    return [...def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1] ?? '');
  }

  // -------------------------------------------------------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------------------------------------------------------
  const loans = { a1: '', a2: '', a3: '', a4: '', b1: '' };
  const borrowers = { a: randomUUID(), b: randomUUID() };
  /** Reminders by label, per lender. */
  const rem: Record<string, string> = {};
  const policyRef = randomUUID();
  const templateRef = randomUUID();
  const penalRef = randomUUID();

  async function addLoan(lender: string, borrower: string, label: string): Promise<string> {
    const id = randomUUID();
    await replica(async (c) => {
      await c.query(
        `insert into servicing.loan_accounts (id, lender_org_id, application_id, borrower_id, source_system, lms_loan_ref, status, sanctioned_amount_minor)
         values ($1, $2, $3, $4, 'lender_lms', $5, 'active', 5000000)`,
        [id, lender, randomUUID(), borrower, `SAMPLE-${label}-${TAG}`],
      );
    });
    return id;
  }

  interface ReminderSeed {
    label: string;
    lender: string;
    loan: string;
    borrower: string;
    seq: number;
    offset: number;
    channel: 'in_app' | 'push' | 'sms';
    hoursAgo: number;
    status: 'planned' | 'claimed' | 'sent' | 'failed' | 'suppressed';
    reason?: string;
    attempts?: number;
    amount?: number;
    penal?: boolean;
    fallback?: boolean;
    language?: 'en' | 'hi';
  }
  async function addReminder(c: pg.PoolClient, s: ReminderSeed): Promise<string> {
    const id = randomUUID();
    rem[s.label] = id;
    const frozen = s.status === 'claimed' || s.status === 'sent' || s.status === 'failed';
    await c.query(
      `insert into servicing.reminders (id, lender_org_id, loan_account_id, borrower_id, policy_id, installment_seq, due_date, offset_days, channel,
                                       scheduled_for, status, suppress_reason, attempts, claimed_at, template_id, language_used, language_fallback,
                                       penal_text_id, variables, content_sha256, penal_text_sha256, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, current_date, $7, $8, now() - make_interval(hours => $9::int), $10, $11, $12,
               case when $13::boolean then now() - make_interval(hours => $9::int) else null end,
               case when $13::boolean then $14::uuid else null end, case when $13::boolean then $15 else null end, $16,
               case when $17::boolean then $18::uuid else null end,
               case when $13::boolean then $19::jsonb else null end,
               case when $13::boolean then $20 else null end, case when $17::boolean then $21 else null end,
               now() - make_interval(hours => $9::int + 1), now() - make_interval(hours => $9::int))`,
      [
        id,
        s.lender,
        s.loan,
        s.borrower,
        policyRef,
        s.seq,
        s.offset,
        s.channel,
        s.hoursAgo,
        s.status,
        s.reason ?? null,
        s.attempts ?? 0,
        frozen,
        templateRef,
        s.language ?? 'en',
        s.fallback ?? false,
        s.penal === true,
        penalRef,
        JSON.stringify({
          due_date: '2026-10-20',
          amount_minor: s.amount ?? 475_000,
          lender_name: CANARY.lenderName,
        }),
        CANARY.remindersHash,
        CANARY.remindersPenalHash,
      ],
    );
    return id;
  }
  async function addDelivery(
    c: pg.PoolClient,
    reminder: string,
    lender: string,
    channel: 'in_app' | 'push' | 'sms',
    state: string,
    source: string,
    minutesAgo: number,
    providerRef: string | null = null,
    errorClass: string | null = null,
    penal = false,
  ) {
    await c.query(
      `insert into servicing.reminder_deliveries (reminder_id, lender_org_id, channel, state, source, provider_ref, error_class, content_sha256,
                                                 penal_text_sha256, occurred_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() - make_interval(mins => $10::int))`,
      [
        reminder,
        lender,
        channel,
        state,
        source,
        providerRef,
        errorClass,
        CANARY.deliveryHash,
        penal ? CANARY.deliveryPenalHash : null,
        minutesAgo,
      ],
    );
  }

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: ADMIN, max: 4 });
    apiPool = new pg.Pool({ connectionString: API, max: 6 });

    for (const id of [
      ids.aAdmin,
      ids.aApprover,
      ids.aApprover2,
      ids.aViewer,
      ids.aNone,
      ids.aBoth,
      ids.bAdmin,
      ids.bApprover,
      ids.pOps,
      ids.spammer,
    ])
      await admin.query(
        `insert into auth.users (id, phone, raw_app_meta_data) values ($1, null, '{"actor_type":"staff"}')`,
        [id],
      );
    await admin.query(
      `insert into auth.users (id, phone, raw_app_meta_data) values ($1, $2, '{}')`,
      [ids.borrower, CANARY.phone],
    );
    const existing = await q<{ id: string }>(
      `select id from tenancy.organizations where kind = 'platform'`,
    );
    if (existing[0]) ids.platformOrg = existing[0].id;
    else
      await admin.query(
        `insert into tenancy.organizations (id, kind, legal_name, display_name, status) values ($1, 'platform', 'Udofin Platform (it)', 'Udofin', 'active')`,
        [ids.platformOrg],
      );
    for (const [lender, name] of [
      [ids.lenderA, 'Alpha Reminders'],
      [ids.lenderB, 'Beta Reminders'],
    ] as const)
      await admin.query(
        `insert into tenancy.organizations (id, kind, legal_name, display_name, regulator_registration_no, status) values ($1, 'lender', $2, $3, $4, 'active')`,
        [lender, `${name} Ltd (test)`, name, `IT-LR-${lender.slice(0, 8)}`],
      );
    await member(ids.lenderA, ids.aAdmin, 'lender', 'communications_admin');
    await member(ids.lenderA, ids.aApprover, 'lender', 'communications_approver');
    await member(ids.lenderA, ids.aApprover2, 'lender', 'communications_approver');
    await member(ids.lenderA, ids.aViewer, 'lender', 'viewer');
    await member(ids.lenderA, ids.aNone, 'lender', 'payments_admin');
    await member(ids.lenderA, ids.aBoth, 'lender', 'communications_admin');
    await member(ids.lenderA, ids.spammer, 'lender', 'viewer');
    await member(ids.lenderB, ids.bAdmin, 'lender', 'communications_admin');
    await member(ids.lenderB, ids.bApprover, 'lender', 'communications_approver');
    await member(ids.platformOrg, ids.pOps, 'platform', 'operations_agent');
    // The one login that holds both sides of the pair: only possible by switching the segregation trigger off, which is exactly
    // what proves the DATABASE refuses a person approving their own draft.
    await replica(async (c) => {
      await c.query(
        `insert into tenancy.membership_roles (membership_id, role_id)
         select m.id, r.id from tenancy.memberships m, tenancy.roles r
          where m.org_id = $1 and m.user_id = $2 and r.org_id is null and r.applies_to = 'lender' and r.key = 'communications_approver'`,
        [ids.lenderA, ids.aBoth],
      );
    });

    loans.a1 = await addLoan(ids.lenderA, borrowers.a, 'a1');
    loans.a2 = await addLoan(ids.lenderA, borrowers.a, 'a2');
    loans.a3 = await addLoan(ids.lenderA, borrowers.a, 'a3');
    loans.a4 = await addLoan(ids.lenderA, borrowers.a, 'a4');
    loans.b1 = await addLoan(ids.lenderB, borrowers.b, 'b1');

    const base = { lender: ids.lenderA, loan: loans.a1, borrower: borrowers.a };
    await replica(async (c) => {
      // Lender A, loan a1: eleven messages across every status, channel and kind. Newest first by hoursAgo (smallest = newest).
      await addReminder(c, {
        ...base,
        label: 'planned_future',
        seq: 3,
        offset: 3,
        channel: 'in_app',
        hoursAgo: -30,
        status: 'planned',
      });
      await addReminder(c, {
        ...base,
        label: 'planned_now',
        seq: 3,
        offset: 1,
        channel: 'in_app',
        hoursAgo: 1,
        status: 'planned',
      });
      await addReminder(c, {
        ...base,
        label: 'sent_inapp',
        seq: 1,
        offset: -3,
        channel: 'in_app',
        hoursAgo: 2,
        status: 'sent',
        attempts: 1,
        amount: 475_000,
      });
      await addReminder(c, {
        ...base,
        label: 'sent_push',
        seq: 1,
        offset: -3,
        channel: 'push',
        hoursAgo: 3,
        status: 'sent',
        attempts: 1,
        amount: 475_000,
      });
      await addReminder(c, {
        ...base,
        label: 'sms_placeholder',
        seq: 1,
        offset: -3,
        channel: 'sms',
        hoursAgo: 4,
        status: 'suppressed',
        reason: 'sms_not_configured',
      });
      await addReminder(c, {
        ...base,
        label: 'recent_payment',
        seq: 2,
        offset: 0,
        channel: 'in_app',
        hoursAgo: 5,
        status: 'suppressed',
        reason: 'recent_payment',
      });
      await addReminder(c, {
        ...base,
        label: 'penal_missing',
        seq: 2,
        offset: 1,
        channel: 'in_app',
        hoursAgo: 6,
        status: 'suppressed',
        reason: 'penal_text_missing',
      });
      await addReminder(c, {
        ...base,
        label: 'failed_push',
        seq: 2,
        offset: 0,
        channel: 'push',
        hoursAgo: 7,
        status: 'failed',
        attempts: 3,
        amount: 480_000,
      });
      await addReminder(c, {
        ...base,
        label: 'overdue_sent_hi',
        seq: 2,
        offset: 7,
        channel: 'in_app',
        hoursAgo: 8,
        status: 'sent',
        attempts: 1,
        amount: 950_000,
        penal: true,
        fallback: true,
        language: 'en',
      });
      await addReminder(c, {
        ...base,
        label: 'expired',
        seq: 2,
        offset: 3,
        channel: 'push',
        hoursAgo: 9,
        status: 'suppressed',
        reason: 'expired',
      });
      await addReminder(c, {
        ...base,
        label: 'claimed_overdue',
        seq: 2,
        offset: 7,
        channel: 'push',
        hoursAgo: 10,
        status: 'claimed',
        attempts: 1,
        amount: 950_000,
        penal: true,
      });
      // Older than the default 30 days of the summary.
      await addReminder(c, {
        ...base,
        label: 'old_paid',
        seq: 1,
        offset: 0,
        channel: 'in_app',
        hoursAgo: 40 * 24,
        status: 'suppressed',
        reason: 'paid',
      });
      // Lender A, loan a2: two planned messages (the hold test suppresses them) and one sent message (it stays).
      const a2 = { lender: ids.lenderA, loan: loans.a2, borrower: borrowers.a };
      await addReminder(c, {
        ...a2,
        label: 'a2_planned_1',
        seq: 1,
        offset: 1,
        channel: 'in_app',
        hoursAgo: -5,
        status: 'planned',
      });
      await addReminder(c, {
        ...a2,
        label: 'a2_planned_2',
        seq: 1,
        offset: 3,
        channel: 'push',
        hoursAgo: -6,
        status: 'planned',
      });
      await addReminder(c, {
        ...a2,
        label: 'a2_sent',
        seq: 1,
        offset: -3,
        channel: 'in_app',
        hoursAgo: 3,
        status: 'sent',
        attempts: 1,
      });
      // Lender B: a different mix.
      const b1 = { lender: ids.lenderB, loan: loans.b1, borrower: borrowers.b };
      await addReminder(c, {
        ...b1,
        label: 'b_sent',
        seq: 1,
        offset: -3,
        channel: 'in_app',
        hoursAgo: 2,
        status: 'sent',
        attempts: 1,
        amount: 111_100,
      });
      await addReminder(c, {
        ...b1,
        label: 'b_hold',
        seq: 1,
        offset: 0,
        channel: 'push',
        hoursAgo: 4,
        status: 'suppressed',
        reason: 'hold',
      });
      await addReminder(c, {
        ...b1,
        label: 'b_hold_2',
        seq: 1,
        offset: 1,
        channel: 'push',
        hoursAgo: 5,
        status: 'suppressed',
        reason: 'hold',
      });
      await addReminder(c, {
        ...b1,
        label: 'b_planned',
        seq: 1,
        offset: 3,
        channel: 'push',
        hoursAgo: -2,
        status: 'planned',
      });

      // The attempt log: what the worker would have recorded.
      await addDelivery(c, rem.sent_inapp ?? '', ids.lenderA, 'in_app', 'accepted', 'send', 120);
      await addDelivery(c, rem.sent_inapp ?? '', ids.lenderA, 'in_app', 'read', 'app', 30);
      await addDelivery(
        c,
        rem.sent_push ?? '',
        ids.lenderA,
        'push',
        'accepted',
        'send',
        180,
        'PRV-REF-1',
      );
      await addDelivery(
        c,
        rem.sent_push ?? '',
        ids.lenderA,
        'push',
        'delivered',
        'delivery_report',
        170,
        'PRV-REF-1',
      );
      await addDelivery(
        c,
        rem.failed_push ?? '',
        ids.lenderA,
        'push',
        'failed',
        'send',
        450,
        null,
        'provider_timeout',
      );
      await addDelivery(
        c,
        rem.failed_push ?? '',
        ids.lenderA,
        'push',
        'failed',
        'send',
        420,
        null,
        'provider_timeout',
      );
      await addDelivery(
        c,
        rem.failed_push ?? '',
        ids.lenderA,
        'push',
        'failed',
        'send',
        390,
        null,
        'provider_error',
      );
      await addDelivery(
        c,
        rem.sms_placeholder ?? '',
        ids.lenderA,
        'sms',
        'not_configured',
        'send',
        240,
      );
      await addDelivery(
        c,
        rem.overdue_sent_hi ?? '',
        ids.lenderA,
        'in_app',
        'accepted',
        'send',
        470,
        null,
        null,
        true,
      );
      await addDelivery(c, rem.b_sent ?? '', ids.lenderB, 'in_app', 'accepted', 'send', 100);

      // Lender B's own artefacts and hold, so cross-tenant checks have something to find.
    });

    app = await buildApp(loadConfig({ APP_ENV: 'test' }), {
      auth: { verifier: fakeVerifier, context: createUserContext(apiPool) },
    });
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await apiPool?.end();
    // The integration files share one database: this file leaves none of its reminder rows behind. Triggers and foreign keys are
    // off for this one transaction (the append-only triggers would refuse a delete) and every delete is scoped to its two lenders.
    if (admin) {
      const mine = [ids.lenderA, ids.lenderB];
      const c = await admin.connect();
      try {
        await c.query('begin');
        await c.query('set local session_replication_role = replica');
        for (const table of [
          'servicing.reminder_deliveries',
          'servicing.reminders',
          'servicing.communication_holds',
          'servicing.penal_charge_texts',
          'servicing.reminder_templates',
          'servicing.reminder_policies',
          'servicing.loan_accounts',
        ])
          await c.query(`delete from ${table} where lender_org_id = any($1::uuid[])`, [mine]);
        await c.query('commit');
      } catch (error) {
        await c.query('rollback');
        throw error;
      } finally {
        c.release();
      }
    }
    await admin?.end();
  });

  const policyBody = (over: Record<string, unknown> = {}) => ({
    lenderId: ids.lenderA,
    ...POLICY_OK,
    ...over,
  });
  const templateBody = (over: Record<string, unknown> = {}) => ({
    lenderId: ids.lenderA,
    kind: 'pre_due',
    language: 'en',
    body: WORDING.pre_due,
    ...over,
  });
  const penalBody = (over: Record<string, unknown> = {}) => ({
    lenderId: ids.lenderA,
    ...PENAL_FLAT,
    ...over,
  });

  /** Follows nextCursor to the end; returns every row and the size of each page. */
  async function pages<T extends { id: string }>(url: string, user: string, limit: number) {
    const all: T[] = [];
    const sizes: number[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 60; guard += 1) {
      const separator = url.includes('?') ? '&' : '?';
      const res: Res = await get(
        `${url}${separator}limit=${String(limit)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        user,
      );
      expect(res.statusCode).toBe(200);
      const page = res.json<Page<T>>();
      sizes.push(page.items.length);
      all.push(...page.items);
      cursor = page.nextCursor;
      if (!cursor) return { all, sizes };
    }
    throw new Error('pagination did not end');
  }

  /** Every read route for a lender, for the access checks. */
  const readRoutes = (lender: string) => [
    `/v1/lender/reminder-policies?lenderId=${lender}`,
    `/v1/lender/reminder-templates?lenderId=${lender}`,
    `/v1/lender/penal-charge-texts?lenderId=${lender}`,
    `/v1/lender/communication-holds?lenderId=${lender}`,
    `/v1/lender/reminders?lenderId=${lender}`,
    `/v1/lender/reminders/summary?lenderId=${lender}`,
  ];

  /** The artefacts the lifecycle tests create, kept for the later tests. */
  const art = {
    policyApproved: '',
    templateApproved: '',
    penalApproved: '',
    holdA: '',
    holdB: '',
    policyDraftV1: '',
    penalPercent: '',
  };

  // =========================================================================================================================
  // The contract mirrors the database
  // =========================================================================================================================
  describe('closed lists', () => {
    it('are the lists the database checks (a drift fails here)', async () => {
      const same = (a: readonly string[], b: readonly string[]) =>
        expect([...a].sort()).toEqual([...b].sort());
      same(LR_ARTEFACT_STATUSES, await checkList('reminder_policies', 'status'));
      same(LR_ARTEFACT_STATUSES, await checkList('reminder_templates', 'status'));
      same(LR_ARTEFACT_STATUSES, await checkList('penal_charge_texts', 'status'));
      same(LR_CHANNELS, await checkList('reminder_policies', 'channels'));
      same(LR_CHANNELS, await checkList('reminders', 'channel'));
      same(LR_CHANNELS, await checkList('reminder_deliveries', 'channel'));
      same(LR_REMINDER_KINDS, await checkList('reminder_templates', 'kind'));
      same(LR_TEMPLATE_LANGUAGES, await checkList('reminder_templates', 'language'));
      same(LR_TEMPLATE_LANGUAGES, await checkList('reminders', 'language_used'));
      same(LR_CHARGE_KINDS, await checkList('penal_charge_texts', 'charge_kind'));
      same(LR_CHARGE_BASES, await checkList('penal_charge_texts', 'basis'));
      same(LR_REMINDER_STATUSES, await checkList('reminders', 'status'));
      same(LR_SUPPRESS_REASONS, await checkList('reminders', 'suppress_reason'));
      same(LR_HOLD_REASONS, await checkList('communication_holds', 'reason'));
      same(LR_DELIVERY_STATES, await checkList('reminder_deliveries', 'state'));
      same(LR_DELIVERY_SOURCES, await checkList('reminder_deliveries', 'source'));
      same(LR_DELIVERY_ERROR_CLASSES, await checkList('reminder_deliveries', 'error_class'));
    });

    it('know that sms is an inert placeholder: the fixture sms message is suppressed and no sms attempt is anything but not_configured', async () => {
      const res = await get(
        `/v1/lender/reminders?lenderId=${ids.lenderA}&channel=sms&limit=100`,
        ids.aViewer,
      );
      expect(res.statusCode).toBe(200);
      const rows = rowsOf<{ status: string; suppressReason: string | null }>(res);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.status).toBe('suppressed');
        expect(row.suppressReason).toBe('sms_not_configured');
      }
      expect(
        await countOf(
          `select count(*) as n from servicing.reminder_deliveries where lender_org_id = $1 and channel = 'sms' and state <> 'not_configured'`,
          [ids.lenderA],
        ),
      ).toBe(0);
    });
  });

  // =========================================================================================================================
  // Who may call at all
  // =========================================================================================================================
  describe('access', () => {
    it('answers 401 to an anonymous caller, on a read and on a write', async () => {
      for (const url of readRoutes(ids.lenderA))
        expect((await get(url, null)).statusCode).toBe(401);
      expect((await post('/v1/lender/reminder-policies', null, policyBody())).statusCode).toBe(401);
      expect(
        (await post(`/v1/lender/reminder-policies/${randomUUID()}/approve`, null)).statusCode,
      ).toBe(401);
      expect(
        (await post(`/v1/lender/loans/${loans.a1}/communication-hold`, null, { reason: 'legal' }))
          .statusCode,
      ).toBe(401);
    });

    it('answers 401 mfa_required to a staff session without the second factor, on every read and write', async () => {
      for (const url of readRoutes(ids.lenderA)) {
        const res = await call('GET', url, ids.aAdmin, undefined, { aal: 'aal1' });
        expect([url, ...outcome(res)]).toEqual([url, 401, 'mfa_required']);
      }
      const writes: [string, unknown][] = [
        ['/v1/lender/reminder-policies', policyBody()],
        ['/v1/lender/reminder-templates', templateBody()],
        ['/v1/lender/penal-charge-texts', penalBody()],
        [`/v1/lender/reminder-policies/${randomUUID()}/approve`, {}],
        [`/v1/lender/reminder-templates/${randomUUID()}/retire`, {}],
        [`/v1/lender/penal-charge-texts/${randomUUID()}/approve`, {}],
        [`/v1/lender/loans/${loans.a1}/communication-hold`, { reason: 'legal' }],
        [`/v1/lender/communication-holds/${randomUUID()}/release`, {}],
      ];
      for (const [url, payload] of writes) {
        const res = await post(url, ids.aAdmin, payload, { aal: 'aal1' });
        expect([url, ...outcome(res)]).toEqual([url, 401, 'mfa_required']);
      }
      expect(
        await countOf(
          'select count(*) as n from servicing.communication_holds where lender_org_id = $1',
          [ids.lenderA],
        ),
      ).toBe(0);
    });

    it('also refuses the second factor inside the database, whatever the API layer does', async () => {
      const hold = await asUser(
        ids.aAdmin,
        'aal1',
        `select servicing.place_communication_hold($1::uuid, 'legal', null)`,
        [loans.a3],
      );
      expect(hold).toMatchObject({ ok: false, code: '42501', hint: 'mfa_required' });
      const draft = await asUser(
        ids.aAdmin,
        'aal1',
        `select servicing.draft_reminder_policy($1::uuid, array[1], true, array['in_app'], time '09:00', time '18:00', 1)`,
        [ids.lenderA],
      );
      expect(draft).toMatchObject({ ok: false, code: '42501', hint: 'mfa_required' });
      const ok = await asUser(
        ids.aAdmin,
        'aal2',
        `select servicing.place_communication_hold($1::uuid, 'legal', null)`,
        [loans.a3],
      );
      expect(ok.ok).toBe(true);
    });

    it('keeps a borrower out of every route', async () => {
      const read = await get(`/v1/lender/reminders?lenderId=${ids.lenderA}`, ids.borrower);
      expect([read.statusCode, code(read)]).toEqual([403, 'staff_only']);
      const write = await post('/v1/lender/reminder-policies', ids.borrower, policyBody());
      expect([write.statusCode, code(write)]).toEqual([403, 'staff_only']);
    });

    it('answers 403 on every read to a lender user who holds neither loan.read nor a reminder permission', async () => {
      for (const url of [
        ...readRoutes(ids.lenderA),
        `/v1/lender/reminders/${rem.sent_inapp ?? ''}/deliveries`,
        '/v1/lender/reminders',
        '/v1/lender/communication-holds',
      ]) {
        const res = await get(url, ids.aNone);
        expect([url, ...outcome(res)]).toEqual([url, 403, 'forbidden']);
      }
    });

    it('answers 403 when a lender user names another lender, on every read route', async () => {
      for (const url of readRoutes(ids.lenderB)) {
        const res = await get(url, ids.aAdmin);
        expect([url, ...outcome(res)]).toEqual([url, 403, 'forbidden']);
        const other = await get(url.replace(ids.lenderB, ids.lenderA), ids.bAdmin);
        expect([url, ...outcome(other)]).toEqual([url, 403, 'forbidden']);
      }
    });

    it('lets a platform operations user (loan.read across lenders) read, and not write', async () => {
      for (const lender of [ids.lenderA, ids.lenderB])
        for (const url of readRoutes(lender)) {
          const res = await get(url, ids.pOps);
          expect([url, res.statusCode]).toEqual([url, 200]);
        }
      const draft = await post('/v1/lender/reminder-policies', ids.pOps, policyBody());
      expect([draft.statusCode, code(draft)]).toEqual([403, 'forbidden']);
    });

    it('lets a viewer (loan.read only) read everything and write nothing', async () => {
      for (const url of readRoutes(ids.lenderA))
        expect([url, (await get(url, ids.aViewer)).statusCode]).toEqual([url, 200]);
      for (const [url, payload] of [
        ['/v1/lender/reminder-policies', policyBody()],
        ['/v1/lender/reminder-templates', templateBody()],
        ['/v1/lender/penal-charge-texts', penalBody()],
      ] as const) {
        const res = await post(url, ids.aViewer, payload);
        expect([url, ...outcome(res)]).toEqual([url, 403, 'forbidden']);
      }
      const hold = await post(`/v1/lender/loans/${loans.a1}/communication-hold`, ids.aViewer, {
        reason: 'legal',
      });
      expect(outcome(hold)).toEqual([404, 'not_found']);
    });

    it('requires the Idempotency-Key header on every write', async () => {
      const res = await post('/v1/lender/reminder-policies', ids.aAdmin, policyBody(), {
        key: null,
      });
      expect([res.statusCode, code(res)]).toEqual([400, 'idempotency_key_required']);
      const approve = await post(
        `/v1/lender/reminder-policies/${randomUUID()}/approve`,
        ids.aApprover,
        {},
        { key: null },
      );
      expect([approve.statusCode, code(approve)]).toEqual([400, 'idempotency_key_required']);
      const hold = await post(
        `/v1/lender/loans/${loans.a1}/communication-hold`,
        ids.aAdmin,
        { reason: 'legal' },
        { key: null },
      );
      expect([hold.statusCode, code(hold)]).toEqual([400, 'idempotency_key_required']);
    });

    it('limits how often one person can call a route (429 with a retry hint)', async () => {
      let last: Res | undefined;
      for (let n = 0; n < 125 && last?.statusCode !== 429; n += 1)
        last = await get(`/v1/lender/reminders?lenderId=${ids.lenderA}&limit=1`, ids.spammer);
      expect(last?.statusCode).toBe(429);
      expect(code(last as Res)).toBe('rate_limited');
      expect(last?.headers['retry-after']).toBeDefined();
    });
  });

  // =========================================================================================================================
  // The reminder policy: draft, approve (a different person), retire
  // =========================================================================================================================
  describe('reminder policy', () => {
    it('starts empty, and says the lender has no approved penal-charge text so overdue reminders are not sent', async () => {
      const res = await get(`/v1/lender/reminder-policies?lenderId=${ids.lenderA}`, ids.aAdmin);
      expect(res.statusCode).toBe(200);
      const body = LrPolicyPage.parse(res.json());
      expect(body.items).toEqual([]);
      expect(body.overdueReminders).toEqual({
        penalTextApproved: false,
        overdueRemindersWithheld: true,
      });
    });

    it('drafts a version exactly as submitted, as a draft, and a second draft is the next version', async () => {
      const res = await post('/v1/lender/reminder-policies', ids.aAdmin, policyBody());
      expect(res.statusCode).toBe(201);
      const first = res.json<Record<string, unknown>>();
      expect(keys(first)).toEqual(
        [
          'approvedAt',
          'approvedBy',
          'channels',
          'draftedAt',
          'draftedBy',
          'id',
          'lenderId',
          'maxPerDay',
          'offsetsDays',
          'overdueWeekly',
          'retiredAt',
          'retiredBy',
          'status',
          'version',
          'windowFrom',
          'windowTo',
        ].sort(),
      );
      expect(first).toMatchObject({
        lenderId: ids.lenderA,
        status: 'draft',
        offsetsDays: [-3, 0, 1, 7],
        overdueWeekly: true,
        channels: ['in_app', 'push'],
        windowFrom: '09:00',
        windowTo: '18:00',
        maxPerDay: 2,
        draftedBy: ids.aAdmin,
        approvedBy: null,
        approvedAt: null,
        retiredBy: null,
        retiredAt: null,
      });
      const second = await post(
        '/v1/lender/reminder-policies',
        ids.aAdmin,
        policyBody({ maxPerDay: 1 }),
      );
      expect(second.statusCode).toBe(201);
      expect(second.json<{ version: number }>().version).toBe((first.version as number) + 1);
      art.policyApproved = second.json<{ id: string }>().id; // approved further down
      art.policyDraftV1 = first.id as string;
    });

    it('accepts sms in the channels as an inert placeholder and returns it as sent', async () => {
      const res = await post(
        '/v1/lender/reminder-policies',
        ids.aAdmin,
        policyBody({ channels: ['in_app', 'sms'] }),
      );
      expect(res.statusCode).toBe(201);
      expect(res.json<{ channels: string[] }>().channels).toEqual(['in_app', 'sms']);
      // And it retires again so it can never be approved by mistake further down.
      const id = res.json<{ id: string }>().id;
      expect((await post(`/v1/lender/reminder-policies/${id}/retire`, ids.aAdmin)).statusCode).toBe(
        200,
      );
    });

    it('lists the versions newest first, filters by status and pages without gaps or repeats', async () => {
      const all = await pages<{ id: string; version: number }>(
        `/v1/lender/reminder-policies?lenderId=${ids.lenderA}`,
        ids.aApprover,
        2,
      );
      expect(all.all.length).toBeGreaterThanOrEqual(3);
      expect(all.sizes.every((n) => n <= 2)).toBe(true);
      expect(new Set(idsOf(all.all)).size).toBe(all.all.length);
      const versions = all.all.map((r) => r.version);
      expect(versions).toEqual([...versions].sort((a, b) => b - a));
      const drafts = await get(
        `/v1/lender/reminder-policies?lenderId=${ids.lenderA}&status=draft`,
        ids.aApprover,
      );
      for (const row of rowsOf<{ status: string }>(drafts)) expect(row.status).toBe('draft');
      const dbCount = await countOf(
        `select count(*) as n from servicing.reminder_policies where lender_org_id = $1`,
        [ids.lenderA],
      );
      expect(all.all.length).toBe(dbCount);
    });

    it('replays an idempotent draft: the same key and body give the same row and no second version', async () => {
      const key = `it-policy-${randomUUID()}`;
      const before = await countOf(
        'select count(*) as n from servicing.reminder_policies where lender_org_id = $1',
        [ids.lenderA],
      );
      const one = await post(
        '/v1/lender/reminder-policies',
        ids.aAdmin,
        policyBody({ offsetsDays: [-2, 0] }),
        { key },
      );
      const two = await post(
        '/v1/lender/reminder-policies',
        ids.aAdmin,
        policyBody({ offsetsDays: [-2, 0] }),
        { key },
      );
      expect([one.statusCode, two.statusCode]).toEqual([201, 201]);
      expect(two.json()).toEqual(one.json());
      expect(two.headers['idempotent-replayed']).toBe('true');
      expect(
        await countOf(
          'select count(*) as n from servicing.reminder_policies where lender_org_id = $1',
          [ids.lenderA],
        ),
      ).toBe(before + 1);
      const changed = await post(
        '/v1/lender/reminder-policies',
        ids.aAdmin,
        policyBody({ offsetsDays: [-5] }),
        { key },
      );
      expect([changed.statusCode, code(changed)]).toEqual([422, 'idempotency_key_reused']);
      // A fresh key is a new draft.
      const fresh = await post(
        '/v1/lender/reminder-policies',
        ids.aAdmin,
        policyBody({ offsetsDays: [-2, 0] }),
      );
      expect(fresh.json<{ id: string }>().id).not.toBe(one.json<{ id: string }>().id);
      await post(
        `/v1/lender/reminder-policies/${fresh.json<{ id: string }>().id}/retire`,
        ids.aAdmin,
      );
      await post(
        `/v1/lender/reminder-policies/${one.json<{ id: string }>().id}/retire`,
        ids.aAdmin,
      );
    });

    it('refuses what the database refuses, with the database hint as the code (422)', async () => {
      const cases: [string, Record<string, unknown>][] = [
        ['offsets_invalid', { offsetsDays: [1, 1] }],
        ['offsets_invalid', { offsetsDays: [-31] }],
        ['offsets_invalid', { offsetsDays: [91] }],
        ['offsets_invalid', { offsetsDays: Array.from({ length: 13 }, (_, i) => i) }],
        ['channels_invalid', { channels: ['push', 'push'] }],
        ['window_invalid', { windowFrom: '07:00' }],
        ['window_invalid', { windowTo: '20:00' }],
        ['window_invalid', { windowFrom: '18:00', windowTo: '09:00' }],
        ['policy_invalid', { maxPerDay: 3 }],
        ['policy_invalid', { maxPerDay: 0 }],
      ];
      const before = await countOf(
        'select count(*) as n from servicing.reminder_policies where lender_org_id = $1',
        [ids.lenderA],
      );
      for (const [expected, over] of cases) {
        const res = await post('/v1/lender/reminder-policies', ids.aAdmin, policyBody(over));
        expect([JSON.stringify(over), res.statusCode, code(res)]).toEqual([
          JSON.stringify(over),
          422,
          expected,
        ]);
      }
      expect(
        await countOf(
          'select count(*) as n from servicing.reminder_policies where lender_org_id = $1',
          [ids.lenderA],
        ),
      ).toBe(before);
    });

    it('refuses a malformed request before it reaches the database (422 validation_failed)', async () => {
      for (const over of [
        { channels: ['whatsapp'] },
        { channels: [] },
        { offsetsDays: [] },
        { offsetsDays: [1.5] },
        { windowFrom: '9am' },
        { maxPerDay: 'two' },
        { lenderId: 'not-a-uuid' },
        { surprise: true },
      ]) {
        const res = await post('/v1/lender/reminder-policies', ids.aAdmin, policyBody(over));
        expect([JSON.stringify(over), res.statusCode, code(res)]).toEqual([
          JSON.stringify(over),
          422,
          'validation_failed',
        ]);
      }
      const missing = await post('/v1/lender/reminder-policies', ids.aAdmin, { offsetsDays: [1] });
      expect(outcome(missing)).toEqual([422, 'validation_failed']);
    });

    it('does not let a user draft for a lender they do not belong to (403), nor read it back', async () => {
      const res = await post(
        '/v1/lender/reminder-policies',
        ids.aAdmin,
        policyBody({ lenderId: ids.lenderB }),
      );
      expect(outcome(res)).toEqual([403, 'forbidden']);
      expect(
        await countOf(
          'select count(*) as n from servicing.reminder_policies where lender_org_id = $1',
          [ids.lenderB],
        ),
      ).toBe(0);
    });

    it('refuses self-approval: a login holding both permissions cannot approve what it drafted (403 self_approval)', async () => {
      const draft = await post('/v1/lender/reminder-policies', ids.aBoth, policyBody());
      expect(draft.statusCode).toBe(201);
      const id = draft.json<{ id: string }>().id;
      const res = await post(`/v1/lender/reminder-policies/${id}/approve`, ids.aBoth);
      expect(outcome(res)).toEqual([403, 'self_approval']);
      expect(
        await countOf(
          `select count(*) as n from servicing.reminder_policies where id = $1 and status = 'draft'`,
          [id],
        ),
      ).toBe(1);
      // The segregation rule that normally keeps one login from holding both permissions is in force.
      const attempt = await admin
        .query(
          `insert into tenancy.membership_roles (membership_id, role_id)
           select m.id, r.id from tenancy.memberships m, tenancy.roles r
            where m.org_id = $1 and m.user_id = $2 and r.org_id is null and r.applies_to = 'lender' and r.key = 'communications_approver'`,
          [ids.lenderA, ids.aAdmin],
        )
        .then(() => 'inserted')
        .catch(
          (error: { code?: string; hint?: string }) => `${error.code ?? ''}|${error.hint ?? ''}`,
        );
      expect(attempt).toBe('23514|segregation_of_duties');
      await post(`/v1/lender/reminder-policies/${id}/retire`, ids.aBoth);
    });

    it('answers 404 to someone without the approve permission, the drafter included, and to another lender', async () => {
      const id = art.policyApproved;
      const names = new Map([
        [ids.aAdmin, 'drafter'],
        [ids.aViewer, 'viewer'],
        [ids.aNone, 'none'],
        [ids.bApprover, 'other lender approver'],
        [ids.bAdmin, 'other lender admin'],
        [ids.pOps, 'platform'],
      ]);
      for (const [user, name] of names) {
        const res = await post(`/v1/lender/reminder-policies/${id}/approve`, user);
        expect([name, ...outcome(res)]).toEqual([name, 404, 'not_found']);
      }
      expect(
        await countOf(
          `select count(*) as n from servicing.reminder_policies where id = $1 and status = 'draft'`,
          [id],
        ),
      ).toBe(1);
    });

    it('approves a draft as a different person; approving again is a conflict', async () => {
      const id = art.policyApproved;
      const res = await post(`/v1/lender/reminder-policies/${id}/approve`, ids.aApprover);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ id, status: 'approved' });
      const again = await post(`/v1/lender/reminder-policies/${id}/approve`, ids.aApprover2);
      expect(outcome(again)).toEqual([409, 'not_a_draft']);
      const list = LrPolicyPage.parse(
        (
          await get(
            `/v1/lender/reminder-policies?lenderId=${ids.lenderA}&status=approved`,
            ids.aViewer,
          )
        ).json(),
      );
      expect(list.items.map((r) => r.id)).toEqual([id]);
      expect(list.items[0]).toMatchObject({ approvedBy: ids.aApprover, draftedBy: ids.aAdmin });
      expect(list.items[0]?.approvedAt).not.toBeNull();
    });

    it('approving a newer version retires the one before; retire needs the manage permission', async () => {
      const draft = await post(
        '/v1/lender/reminder-policies',
        ids.aAdmin,
        policyBody({ maxPerDay: 1, offsetsDays: [0, 2] }),
      );
      const next = draft.json<{ id: string }>().id;
      const approved = await post(`/v1/lender/reminder-policies/${next}/approve`, ids.aApprover2);
      expect(approved.statusCode).toBe(200);
      const previous = await q<{ status: string; retired_by: string | null }>(
        'select status, retired_by from servicing.reminder_policies where id = $1',
        [art.policyApproved],
      );
      expect(previous[0]).toEqual({ status: 'retired', retired_by: ids.aApprover2 });
      expect(
        await countOf(
          `select count(*) as n from servicing.reminder_policies where lender_org_id = $1 and status = 'approved'`,
          [ids.lenderA],
        ),
      ).toBe(1);
      // The approver does not hold reminder.policy.manage: retiring is not theirs.
      const refused = await post(`/v1/lender/reminder-policies/${next}/retire`, ids.aApprover);
      expect(outcome(refused)).toEqual([404, 'not_found']);
      const other = await post(`/v1/lender/reminder-policies/${next}/retire`, ids.bAdmin);
      expect(outcome(other)).toEqual([404, 'not_found']);
      const retired = await post(`/v1/lender/reminder-policies/${next}/retire`, ids.aAdmin);
      expect(retired.statusCode).toBe(200);
      expect(retired.json()).toEqual({ id: next, status: 'retired' });
      const twice = await post(`/v1/lender/reminder-policies/${next}/retire`, ids.aAdmin);
      expect(outcome(twice)).toEqual([409, 'already_retired']);
      expect(
        await countOf(
          `select count(*) as n from servicing.reminder_policies where lender_org_id = $1 and status = 'approved'`,
          [ids.lenderA],
        ),
      ).toBe(0);
    });

    it('retires a draft that was never approved', async () => {
      const draftV1 = art.policyDraftV1;
      const res = await post(`/v1/lender/reminder-policies/${draftV1}/retire`, ids.aAdmin);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ id: draftV1, status: 'retired' });
    });

    it('answers 404 to an unknown id and 422 to a malformed one, on approve and retire', async () => {
      for (const action of ['approve', 'retire']) {
        const unknown = await post(
          `/v1/lender/reminder-policies/${randomUUID()}/${action}`,
          ids.aApprover2,
        );
        const retire = await post(
          `/v1/lender/reminder-policies/${randomUUID()}/${action}`,
          ids.aAdmin,
        );
        expect([action, unknown.statusCode, retire.statusCode]).toEqual([action, 404, 404]);
        const bad = await post(`/v1/lender/reminder-policies/not-a-uuid/${action}`, ids.aAdmin);
        expect(outcome(bad)).toEqual([422, 'validation_failed']);
      }
    });

    it("never shows one lender's policies to the other lender", async () => {
      const b = await post(
        '/v1/lender/reminder-policies',
        ids.bAdmin,
        policyBody({ lenderId: ids.lenderB, offsetsDays: [-1] }),
      );
      expect(b.statusCode).toBe(201);
      const a = await get(
        `/v1/lender/reminder-policies?lenderId=${ids.lenderA}&limit=100`,
        ids.aAdmin,
      );
      expect(idsOf(rowsOf(a))).not.toContain(b.json<{ id: string }>().id);
      for (const row of rowsOf<{ lenderId: string }>(a)) expect(row.lenderId).toBe(ids.lenderA);
      const own = await get(
        `/v1/lender/reminder-policies?lenderId=${ids.lenderB}&limit=100`,
        ids.bApprover,
      );
      expect(idsOf(rowsOf(own))).toEqual([b.json<{ id: string }>().id]);
    });

    it('writes the audit event without any figure of the policy', async () => {
      const rows = await q<{ metadata: unknown }>(
        `select metadata from audit.events where tenant_org_id = $1 and action = 'reminder.policy.drafted'`,
        [ids.lenderA],
      );
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(keys(row.metadata)).toEqual(['version']);
    });
  });

  // =========================================================================================================================
  // Reminder wording
  // =========================================================================================================================
  describe('reminder wording', () => {
    it("drafts the lender's own words and returns them unchanged; nothing is added", async () => {
      for (const [kind, language, body] of [
        ['pre_due', 'en', WORDING.pre_due],
        ['due_day', 'en', WORDING.due_day],
        ['overdue', 'en', WORDING.overdue],
        ['overdue', 'hi', WORDING.overdue_hi],
      ] as const) {
        const res = await post(
          '/v1/lender/reminder-templates',
          ids.aAdmin,
          templateBody({ kind, language, body }),
        );
        expect([kind, language, res.statusCode]).toEqual([kind, language, 201]);
        const row = res.json<Record<string, unknown>>();
        expect(row.body).toBe(body);
        expect(row).toMatchObject({
          lenderId: ids.lenderA,
          kind,
          language,
          status: 'draft',
          draftedBy: ids.aAdmin,
          approvedBy: null,
        });
        expect(keys(row)).toEqual(
          [
            'approvedAt',
            'approvedBy',
            'body',
            'draftedAt',
            'draftedBy',
            'id',
            'kind',
            'language',
            'lenderId',
            'retiredAt',
            'retiredBy',
            'status',
            'version',
          ].sort(),
        );
        const stored = await q<{ body: string }>(
          'select body from servicing.reminder_templates where id = $1',
          [row.id],
        );
        expect(stored[0]?.body).toBe(body);
      }
      // Wording never reaches the audit log.
      expect(
        await countOf(
          `select count(*) as n from audit.events where tenant_org_id = $1 and metadata::text like '%' || $2 || '%'`,
          [ids.lenderA, TAG],
        ),
      ).toBe(0);
      expect(
        await countOf(
          `select count(*) as n from audit.events where tenant_org_id = $1 and action = 'reminder.template.drafted'`,
          [ids.lenderA],
        ),
      ).toBeGreaterThanOrEqual(4);
    });

    it('lists with filters and pages', async () => {
      const all = LrTemplatePage.parse(
        (
          await get(
            `/v1/lender/reminder-templates?lenderId=${ids.lenderA}&limit=100`,
            ids.aApprover,
          )
        ).json(),
      );
      expect(all.items.length).toBeGreaterThanOrEqual(4);
      const overdue = rowsOf<{ kind: string; language: string }>(
        await get(
          `/v1/lender/reminder-templates?lenderId=${ids.lenderA}&kind=overdue`,
          ids.aApprover,
        ),
      );
      expect(overdue.length).toBe(2);
      for (const row of overdue) expect(row.kind).toBe('overdue');
      const hindi = rowsOf<{ language: string; body: string }>(
        await get(
          `/v1/lender/reminder-templates?lenderId=${ids.lenderA}&language=hi`,
          ids.aApprover,
        ),
      );
      expect(hindi.map((r) => r.body)).toEqual([WORDING.overdue_hi]);
      const walk = await pages<{ id: string }>(
        `/v1/lender/reminder-templates?lenderId=${ids.lenderA}`,
        ids.aViewer,
        2,
      );
      expect(new Set(idsOf(walk.all)).size).toBe(walk.all.length);
      expect(walk.all.length).toBe(all.items.length);
      expect(
        (
          await get(
            `/v1/lender/reminder-templates?lenderId=${ids.lenderA}&kind=sales`,
            ids.aApprover,
          )
        ).statusCode,
      ).toBe(422);
    });

    it('refuses wording that is not a plain service message, with the database hint (422) and nothing stored', async () => {
      const before = await countOf(
        'select count(*) as n from servicing.reminder_templates where lender_org_id = $1',
        [ids.lenderA],
      );
      const cases: [string, string][] = [
        ['a link', `Pay now at ${CANARY.link} to avoid problems on {{due_date}}`],
        ['a web address', 'Visit www.lender.example.test before {{due_date}} please'],
        ['an e-mail address', 'Write to help@lender.example.test about {{due_date}} dues'],
        [
          'a phone-like number',
          `Please call ${CANARY.phone} about the installment due {{due_date}}`,
        ],
        [
          'a short number run',
          'Please quote reference 12345678 for the installment on {{due_date}}',
        ],
        ['a PAN-shaped token', 'Reference ABCDE1234F for the installment due on {{due_date}}'],
        [
          'marketing wording',
          'Great offer: a pre-approved top-up awaits you, installment due {{due_date}}',
        ],
        [
          'promotional word reward',
          'Earn a reward when you pay the installment due on {{due_date}}',
        ],
        [
          'an unknown placeholder',
          'Dear {{borrower_name}}, your installment is due on {{due_date}}',
        ],
        ['markup', 'Your installment <b>is due</b> on {{due_date}} please pay'],
        ['too short', 'Pay now'],
        ['a stray brace', 'Your installment is due on {{due_date} please pay it soon'],
      ];
      for (const [label, text] of cases) {
        const payload = templateBody({ body: text });
        refused(text);
        const res = await post('/v1/lender/reminder-templates', ids.aAdmin, payload);
        expect([label, res.statusCode, code(res)]).toEqual([label, 422, 'wording_invalid']);
        expect(res.body).not.toContain(text);
      }
      const noPenal = await post(
        '/v1/lender/reminder-templates',
        ids.aAdmin,
        templateBody({
          kind: 'overdue',
          body: 'Your installment due on {{due_date}} is overdue. Please pay {{amount}} soon.',
        }),
      );
      expect([noPenal.statusCode, code(noPenal)]).toEqual([422, 'penal_text_variable_missing']);
      expect(
        await countOf(
          'select count(*) as n from servicing.reminder_templates where lender_org_id = $1',
          [ids.lenderA],
        ),
      ).toBe(before);
    });

    it('refuses an Aadhaar-shaped number that only the table trigger catches (422 unsafe_free_text), and a credential-shaped phrase', async () => {
      const before = await countOf(
        'select count(*) as n from servicing.reminder_templates where lender_org_id = $1',
        [ids.lenderA],
      );
      for (const text of [
        'Reference 2345 6789 0123 for the installment due on {{due_date}}.',
        // Built at run time so no credential-shaped phrase sits in the source for a secret scanner to find.
        `Your ${['pass', 'word'].join('')}: lowercase must be kept safe before {{due_date}} please.`,
      ]) {
        refused(text);
        const res = await post(
          '/v1/lender/reminder-templates',
          ids.aAdmin,
          templateBody({ body: text }),
        );
        expect([text, res.statusCode, code(res)]).toEqual([text, 422, 'unsafe_free_text']);
        expect(res.body).not.toContain(text);
      }
      expect(
        await countOf(
          'select count(*) as n from servicing.reminder_templates where lender_org_id = $1',
          [ids.lenderA],
        ),
      ).toBe(before);
    });

    it('refuses a kind or language outside the closed lists before the database (422 validation_failed) and an extra field', async () => {
      for (const over of [
        { kind: 'marketing' },
        { language: 'fr' },
        { surprise: 1 },
        { body: '' },
      ]) {
        const res = await post('/v1/lender/reminder-templates', ids.aAdmin, templateBody(over));
        expect([JSON.stringify(over), res.statusCode, code(res)]).toEqual([
          JSON.stringify(over),
          422,
          'validation_failed',
        ]);
      }
    });

    it('does not let the drafter approve, and approves as a different person, retiring the previous version of the same kind and language', async () => {
      const list = rowsOf<{ id: string; kind: string; language: string }>(
        await get(
          `/v1/lender/reminder-templates?lenderId=${ids.lenderA}&kind=pre_due&language=en`,
          ids.aApprover,
        ),
      );
      const v1 = list[0]?.id ?? '';
      expect(
        outcome(await post(`/v1/lender/reminder-templates/${v1}/approve`, ids.aAdmin)),
      ).toEqual([404, 'not_found']);
      expect(
        outcome(await post(`/v1/lender/reminder-templates/${v1}/approve`, ids.bApprover)),
      ).toEqual([404, 'not_found']);
      const approved = await post(`/v1/lender/reminder-templates/${v1}/approve`, ids.aApprover);
      expect(approved.json()).toEqual({ id: v1, status: 'approved' });
      expect(
        outcome(await post(`/v1/lender/reminder-templates/${v1}/approve`, ids.aApprover2)),
      ).toEqual([409, 'not_a_draft']);

      const second = await post(
        '/v1/lender/reminder-templates',
        ids.aAdmin,
        templateBody({ body: WORDING.due_day }),
      );
      const v2 = second.json<{ id: string; version: number }>();
      // A different kind, so it did not retire v1 on approval: a version for the SAME kind and language does.
      const same = await post('/v1/lender/reminder-templates', ids.aAdmin, templateBody());
      const v3 = same.json<{ id: string }>().id;
      expect(
        (await post(`/v1/lender/reminder-templates/${v3}/approve`, ids.aApprover2)).statusCode,
      ).toBe(200);
      const statuses = await q<{ id: string; status: string }>(
        'select id, status from servicing.reminder_templates where id = any($1::uuid[])',
        [[v1, v3]],
      );
      expect(Object.fromEntries(statuses.map((r) => [r.id, r.status]))).toEqual({
        [v1]: 'retired',
        [v3]: 'approved',
      });
      expect(v2.version).toBeGreaterThan(1);
      art.templateApproved = v3;
      await post(`/v1/lender/reminder-templates/${v2.id}/retire`, ids.aAdmin);
    });

    it('refuses self-approval of wording in the database (403 self_approval)', async () => {
      const draft = await post(
        '/v1/lender/reminder-templates',
        ids.aBoth,
        templateBody({ kind: 'due_day', body: WORDING.due_day }),
      );
      const id = draft.json<{ id: string }>().id;
      expect(outcome(await post(`/v1/lender/reminder-templates/${id}/approve`, ids.aBoth))).toEqual(
        [403, 'self_approval'],
      );
      expect(
        await countOf(
          `select count(*) as n from servicing.reminder_templates where id = $1 and status = 'draft'`,
          [id],
        ),
      ).toBe(1);
      await post(`/v1/lender/reminder-templates/${id}/retire`, ids.aBoth);
    });

    it('retires wording: needs the manage permission, is final, and another lender cannot', async () => {
      const draft = await post(
        '/v1/lender/reminder-templates',
        ids.aAdmin,
        templateBody({ kind: 'due_day', body: WORDING.due_day }),
      );
      const id = draft.json<{ id: string }>().id;
      expect(
        outcome(await post(`/v1/lender/reminder-templates/${id}/retire`, ids.aApprover)),
      ).toEqual([404, 'not_found']);
      expect(outcome(await post(`/v1/lender/reminder-templates/${id}/retire`, ids.bAdmin))).toEqual(
        [404, 'not_found'],
      );
      const retired = await post(`/v1/lender/reminder-templates/${id}/retire`, ids.aAdmin);
      expect(retired.json()).toEqual({ id, status: 'retired' });
      expect(outcome(await post(`/v1/lender/reminder-templates/${id}/retire`, ids.aAdmin))).toEqual(
        [409, 'already_retired'],
      );
      expect(
        outcome(await post(`/v1/lender/reminder-templates/${id}/approve`, ids.aApprover)),
      ).toEqual([409, 'not_a_draft']);
      expect(
        outcome(await post(`/v1/lender/reminder-templates/${randomUUID()}/retire`, ids.aAdmin)),
      ).toEqual([404, 'not_found']);
    });

    it("keeps one lender's wording from the other lender", async () => {
      const b = await post(
        '/v1/lender/reminder-templates',
        ids.bAdmin,
        templateBody({ lenderId: ids.lenderB, body: WORDING.due_day, kind: 'due_day' }),
      );
      expect(b.statusCode).toBe(201);
      const a = rowsOf<{ id: string; lenderId: string }>(
        await get(`/v1/lender/reminder-templates?lenderId=${ids.lenderA}&limit=100`, ids.aViewer),
      );
      expect(idsOf(a)).not.toContain(b.json<{ id: string }>().id);
      for (const row of a) expect(row.lenderId).toBe(ids.lenderA);
      expect(
        outcome(await post('/v1/lender/reminder-templates', ids.bAdmin, templateBody())),
      ).toEqual([403, 'forbidden']);
    });
  });

  // =========================================================================================================================
  // The lender's penal-charge text
  // =========================================================================================================================
  describe('penal-charge text', () => {
    const overdueFlag = async (lender: string, user: string) => {
      const penal = LrPenalTextPage.parse(
        (await get(`/v1/lender/penal-charge-texts?lenderId=${lender}&limit=100`, user)).json(),
      );
      const policy = LrPolicyPage.parse(
        (await get(`/v1/lender/reminder-policies?lenderId=${lender}&limit=100`, user)).json(),
      );
      expect(policy.overdueReminders).toEqual(penal.overdueReminders);
      return penal.overdueReminders;
    };

    it('shows, in the penal-text list and the policy list, that overdue reminders are withheld while there is no approved text', async () => {
      expect(await overdueFlag(ids.lenderA, ids.aApprover)).toEqual({
        penalTextApproved: false,
        overdueRemindersWithheld: true,
      });
      expect(await overdueFlag(ids.lenderB, ids.bApprover)).toEqual({
        penalTextApproved: false,
        overdueRemindersWithheld: true,
      });
    });

    it("drafts the lender's figure, attestations, reason and sentences exactly as submitted", async () => {
      const flat = await post('/v1/lender/penal-charge-texts', ids.aAdmin, penalBody());
      expect(flat.statusCode).toBe(201);
      const row = flat.json<Record<string, unknown>>();
      expect(row).toMatchObject({
        lenderId: ids.lenderA,
        status: 'draft',
        chargeKind: 'flat',
        flatAmountMinor: 50_000,
        percentBps: null,
        basis: 'overdue_amount',
        separateFromInterest: true,
        notCompounded: true,
        reason: PENAL_FLAT.reason,
        sentenceEn: PENAL_FLAT.sentenceEn,
        sentenceHi: PENAL_FLAT.sentenceHi,
        draftedBy: ids.aAdmin,
        approvedBy: null,
      });
      expect(keys(row)).toEqual(
        [
          'approvedAt',
          'approvedBy',
          'basis',
          'chargeKind',
          'draftedAt',
          'draftedBy',
          'flatAmountMinor',
          'id',
          'lenderId',
          'notCompounded',
          'percentBps',
          'reason',
          'retiredAt',
          'retiredBy',
          'sentenceEn',
          'sentenceHi',
          'separateFromInterest',
          'status',
          'version',
        ].sort(),
      );
      const stored = await q<Record<string, unknown>>(
        'select flat_amount_minor::text as flat, percent_bps, reason, sentence_en, sentence_hi from servicing.penal_charge_texts where id = $1',
        [row.id],
      );
      expect(stored[0]).toEqual({
        flat: '50000',
        percent_bps: null,
        reason: PENAL_FLAT.reason,
        sentence_en: PENAL_FLAT.sentenceEn,
        sentence_hi: PENAL_FLAT.sentenceHi,
      });
      const percent = await post(
        '/v1/lender/penal-charge-texts',
        ids.aAdmin,
        penalBody({ ...PENAL_PERCENT }),
      );
      expect(percent.statusCode).toBe(201);
      expect(percent.json()).toMatchObject({
        chargeKind: 'percentage',
        flatAmountMinor: null,
        percentBps: 200,
        sentenceHi: null,
        version: (row.version as number) + 1,
      });
      art.penalApproved = row.id as string;
      art.penalPercent = percent.json<{ id: string }>().id;
    });

    it('does not compute, convert or fill in anything: the percentage draft carries no amount and the flat draft no percentage', async () => {
      const rows = rowsOf<{
        chargeKind: string;
        flatAmountMinor: number | null;
        percentBps: number | null;
      }>(await get(`/v1/lender/penal-charge-texts?lenderId=${ids.lenderA}&limit=100`, ids.aViewer));
      for (const row of rows) {
        if (row.chargeKind === 'flat') expect(row.percentBps).toBeNull();
        else expect(row.flatAmountMinor).toBeNull();
      }
    });

    it('refuses the figure, the attestations and the text the way the database does (422, hint as code)', async () => {
      const cases: [string, Record<string, unknown>][] = [
        ['charge_invalid', { percentBps: 200 }], // flat with a percentage
        ['charge_invalid', { flatAmountMinor: null }], // flat with no amount
        ['charge_invalid', { flatAmountMinor: 200_000_000_000 }], // above the limit
        ['charge_invalid', { flatAmountMinor: 0 }],
        ['charge_invalid', { chargeKind: 'percentage', flatAmountMinor: null, percentBps: null }],
        ['charge_invalid', { chargeKind: 'percentage', flatAmountMinor: 50_000, percentBps: 200 }],
        ['charge_invalid', { chargeKind: 'percentage', flatAmountMinor: null, percentBps: 0 }],
        [
          'charge_invalid',
          { chargeKind: 'percentage', flatAmountMinor: null, percentBps: 100_001 },
        ],
        ['attestation_missing', { separateFromInterest: false }],
        ['attestation_missing', { notCompounded: false }],
        ['wording_invalid', { sentenceEn: `A charge applies. Pay at ${CANARY.link} please.` }],
        ['wording_invalid', { sentenceEn: `A charge applies. Call ${CANARY.phone} for details.` }],
        [
          'wording_invalid',
          { sentenceEn: 'A special offer: pay on time and win a reward this month.' },
        ],
        ['wording_invalid', { sentenceEn: 'Short' }],
        [
          'wording_invalid',
          { sentenceEn: 'A charge applies on {{amount}} as stated in your agreement.' },
        ],
        ['wording_invalid', { reason: `Reason mentions ${CANARY.phone} directly` }],
        ['wording_invalid', { reason: 'Too short' }],
        [
          'wording_invalid',
          { sentenceHi: 'Write to help@lender.example.test about the charge please' },
        ],
      ];
      const before = await countOf(
        'select count(*) as n from servicing.penal_charge_texts where lender_org_id = $1',
        [ids.lenderA],
      );
      for (const [expected, over] of cases) {
        refused(JSON.stringify(over));
        const res = await post('/v1/lender/penal-charge-texts', ids.aAdmin, penalBody(over));
        expect([JSON.stringify(over), res.statusCode, code(res)]).toEqual([
          JSON.stringify(over),
          422,
          expected,
        ]);
        for (const value of Object.values(over))
          if (typeof value === 'string') expect(res.body).not.toContain(value);
      }
      expect(
        await countOf(
          'select count(*) as n from servicing.penal_charge_texts where lender_org_id = $1',
          [ids.lenderA],
        ),
      ).toBe(before);
    });

    it('refuses an Aadhaar-shaped number in the reason or a sentence (422 unsafe_free_text)', async () => {
      const before = await countOf(
        'select count(*) as n from servicing.penal_charge_texts where lender_org_id = $1',
        [ids.lenderA],
      );
      for (const over of [
        { reason: 'Reference 2345 6789 0123 stated in the loan agreement' },
        { sentenceEn: 'A charge per reference 2345 6789 0123 applies as in your agreement.' },
        { sentenceHi: 'Reference 2345 6789 0123 applies as stated in your agreement.' },
      ]) {
        refused(JSON.stringify(over));
        const res = await post('/v1/lender/penal-charge-texts', ids.aAdmin, penalBody(over));
        expect([JSON.stringify(over), res.statusCode, code(res)]).toEqual([
          JSON.stringify(over),
          422,
          'unsafe_free_text',
        ]);
      }
      expect(
        await countOf(
          'select count(*) as n from servicing.penal_charge_texts where lender_org_id = $1',
          [ids.lenderA],
        ),
      ).toBe(before);
    });

    it('refuses a malformed request before the database (422 validation_failed)', async () => {
      for (const over of [
        { chargeKind: 'interest' },
        { flatAmountMinor: 12.5 },
        { flatAmountMinor: -1 },
        { separateFromInterest: 'yes' },
        { reason: '' },
        { sentenceEn: undefined },
        { surprise: true },
      ]) {
        const res = await post('/v1/lender/penal-charge-texts', ids.aAdmin, penalBody(over));
        expect([JSON.stringify(over), res.statusCode, code(res)]).toEqual([
          JSON.stringify(over),
          422,
          'validation_failed',
        ]);
      }
    });

    it('refuses self-approval (403 self_approval) and approval by anyone without the permission (404)', async () => {
      const draft = await post('/v1/lender/penal-charge-texts', ids.aBoth, penalBody());
      const own = draft.json<{ id: string }>().id;
      expect(
        outcome(await post(`/v1/lender/penal-charge-texts/${own}/approve`, ids.aBoth)),
      ).toEqual([403, 'self_approval']);
      await post(`/v1/lender/penal-charge-texts/${own}/retire`, ids.aBoth);
      for (const user of [ids.aAdmin, ids.aViewer, ids.aNone, ids.bApprover, ids.pOps])
        expect(
          outcome(await post(`/v1/lender/penal-charge-texts/${art.penalApproved}/approve`, user)),
        ).toEqual([404, 'not_found']);
    });

    it('approves as a different person: the flag flips to approved, and only for that lender', async () => {
      const id = art.penalApproved;
      const approved = await post(`/v1/lender/penal-charge-texts/${id}/approve`, ids.aApprover);
      expect(approved.json()).toEqual({ id, status: 'approved' });
      expect(
        outcome(await post(`/v1/lender/penal-charge-texts/${id}/approve`, ids.aApprover2)),
      ).toEqual([409, 'not_a_draft']);
      expect(await overdueFlag(ids.lenderA, ids.aApprover)).toEqual({
        penalTextApproved: true,
        overdueRemindersWithheld: false,
      });
      expect(await overdueFlag(ids.lenderA, ids.aViewer)).toEqual({
        penalTextApproved: true,
        overdueRemindersWithheld: false,
      });
      expect(await overdueFlag(ids.lenderB, ids.bAdmin)).toEqual({
        penalTextApproved: false,
        overdueRemindersWithheld: true,
      });
      const list = rowsOf<{ id: string; status: string; approvedBy: string | null }>(
        await get(
          `/v1/lender/penal-charge-texts?lenderId=${ids.lenderA}&status=approved`,
          ids.aViewer,
        ),
      );
      expect(list).toMatchObject([{ id, status: 'approved', approvedBy: ids.aApprover }]);
    });

    it('approving a newer text retires the earlier one; the flag stays true; retiring the approved one makes it false again', async () => {
      const pct = art.penalPercent;
      expect(
        (await post(`/v1/lender/penal-charge-texts/${pct}/approve`, ids.aApprover2)).statusCode,
      ).toBe(200);
      expect(
        await q('select status from servicing.penal_charge_texts where id = $1', [
          art.penalApproved,
        ]),
      ).toEqual([{ status: 'retired' }]);
      expect(await overdueFlag(ids.lenderA, ids.aViewer)).toEqual({
        penalTextApproved: true,
        overdueRemindersWithheld: false,
      });
      expect(
        outcome(await post(`/v1/lender/penal-charge-texts/${pct}/retire`, ids.aApprover)),
      ).toEqual([404, 'not_found']);
      expect(
        outcome(await post(`/v1/lender/penal-charge-texts/${pct}/retire`, ids.bAdmin)),
      ).toEqual([404, 'not_found']);
      expect(
        (await post(`/v1/lender/penal-charge-texts/${pct}/retire`, ids.aAdmin)).json(),
      ).toEqual({ id: pct, status: 'retired' });
      expect(
        outcome(await post(`/v1/lender/penal-charge-texts/${pct}/retire`, ids.aAdmin)),
      ).toEqual([409, 'already_retired']);
      expect(await overdueFlag(ids.lenderA, ids.aViewer)).toEqual({
        penalTextApproved: false,
        overdueRemindersWithheld: true,
      });
    });

    it('pages and filters the versions', async () => {
      const walk = await pages<{ id: string; version: number }>(
        `/v1/lender/penal-charge-texts?lenderId=${ids.lenderA}`,
        ids.aApprover,
        1,
      );
      expect(walk.all.length).toBe(
        await countOf(
          'select count(*) as n from servicing.penal_charge_texts where lender_org_id = $1',
          [ids.lenderA],
        ),
      );
      expect(new Set(idsOf(walk.all)).size).toBe(walk.all.length);
      const versions = walk.all.map((r) => r.version);
      expect(versions).toEqual([...versions].sort((a, b) => b - a));
      for (const row of rowsOf<{ status: string }>(
        await get(
          `/v1/lender/penal-charge-texts?lenderId=${ids.lenderA}&status=retired`,
          ids.aViewer,
        ),
      ))
        expect(row.status).toBe('retired');
    });

    it("keeps lender B's text from lender A and the other way round", async () => {
      const b = await post(
        '/v1/lender/penal-charge-texts',
        ids.bAdmin,
        penalBody({ lenderId: ids.lenderB }),
      );
      expect(b.statusCode).toBe(201);
      const bid = b.json<{ id: string }>().id;
      expect(
        idsOf(
          rowsOf(
            await get(
              `/v1/lender/penal-charge-texts?lenderId=${ids.lenderA}&limit=100`,
              ids.aViewer,
            ),
          ),
        ),
      ).not.toContain(bid);
      expect(
        outcome(await post(`/v1/lender/penal-charge-texts/${bid}/approve`, ids.aApprover)),
      ).toEqual([404, 'not_found']);
      expect(
        outcome(await post(`/v1/lender/penal-charge-texts/${bid}/retire`, ids.aAdmin)),
      ).toEqual([404, 'not_found']);
      expect(
        await countOf(
          `select count(*) as n from servicing.penal_charge_texts where id = $1 and status = 'draft'`,
          [bid],
        ),
      ).toBe(1);
      expect(
        outcome(await get(`/v1/lender/penal-charge-texts?lenderId=${ids.lenderB}`, ids.aAdmin)),
      ).toEqual([403, 'forbidden']);
      expect(
        (await post(`/v1/lender/penal-charge-texts/${bid}/approve`, ids.bApprover)).statusCode,
      ).toBe(200);
      expect(await overdueFlag(ids.lenderB, ids.bAdmin)).toEqual({
        penalTextApproved: true,
        overdueRemindersWithheld: false,
      });
      expect(await overdueFlag(ids.lenderA, ids.aAdmin)).toEqual({
        penalTextApproved: false,
        overdueRemindersWithheld: true,
      });
    });
  });

  // =========================================================================================================================
  // Communication holds
  // =========================================================================================================================
  describe('communication holds', () => {
    const plannedStatus = async (label: string) =>
      (
        await q<{ status: string; suppress_reason: string | null }>(
          'select status, suppress_reason from servicing.reminders where id = $1',
          [rem[label]],
        )
      )[0];
    const place = (
      user: string,
      loan: string,
      body: Record<string, unknown>,
      options: { key?: string | null } = {},
    ) => post(`/v1/lender/loans/${loan}/communication-hold`, user, body, options);

    it('lists nothing before any hold was placed', async () => {
      const res = await get(`/v1/lender/communication-holds?lenderId=${ids.lenderA}`, ids.aViewer);
      expect(res.statusCode).toBe(200);
      expect(rowsOf(res).length).toBe(
        await countOf(
          'select count(*) as n from servicing.communication_holds where lender_org_id = $1',
          [ids.lenderA],
        ),
      );
    });

    it('places a hold: the loan decides the lender, planned messages are suppressed, sent ones are not touched', async () => {
      expect(await plannedStatus('a2_planned_1')).toEqual({
        status: 'planned',
        suppress_reason: null,
      });
      const res = await place(ids.aAdmin, loans.a2, {
        reason: 'complaint',
        note: 'Customer asked for a pause while a complaint is reviewed',
      });
      expect(res.statusCode).toBe(201);
      const body = res.json<{
        id: string;
        loanAccountId: string;
        reason: string;
        active: boolean;
      }>();
      expect(body).toEqual({
        id: body.id,
        loanAccountId: loans.a2,
        reason: 'complaint',
        active: true,
      });
      art.holdA = body.id;
      expect(await plannedStatus('a2_planned_1')).toEqual({
        status: 'suppressed',
        suppress_reason: 'hold',
      });
      expect(await plannedStatus('a2_planned_2')).toEqual({
        status: 'suppressed',
        suppress_reason: 'hold',
      });
      expect(await plannedStatus('a2_sent')).toEqual({ status: 'sent', suppress_reason: null });
      // Messages of the other loan are untouched.
      expect(await plannedStatus('planned_now')).toEqual({
        status: 'planned',
        suppress_reason: null,
      });
      const row = (
        await q<{
          lender_org_id: string;
          loan_account_id: string;
          placed_by: string;
          note: string;
        }>(
          'select lender_org_id, loan_account_id, placed_by, note from servicing.communication_holds where id = $1',
          [body.id],
        )
      )[0];
      expect(row).toMatchObject({
        lender_org_id: ids.lenderA,
        loan_account_id: loans.a2,
        placed_by: ids.aAdmin,
      });
    });

    it('lists the hold with its reason and note, filters by status and loan, and shows it to a viewer', async () => {
      const res = await get(
        `/v1/lender/communication-holds?lenderId=${ids.lenderA}&status=active`,
        ids.aViewer,
      );
      const page = LrHoldPage.parse(res.json());
      expect(page.items.map((h) => h.id)).toEqual([art.holdA]);
      expect(page.items[0]).toMatchObject({
        lenderId: ids.lenderA,
        loanAccountId: loans.a2,
        reason: 'complaint',
        note: 'Customer asked for a pause while a complaint is reviewed',
        placedBy: ids.aAdmin,
        releasedBy: null,
        releasedAt: null,
        releaseNote: null,
        active: true,
      });
      expect(keys(page.items[0])).toEqual([
        'active',
        'id',
        'lenderId',
        'loanAccountId',
        'note',
        'placedAt',
        'placedBy',
        'reason',
        'releaseNote',
        'releasedAt',
        'releasedBy',
      ]);
      expect(
        rowsOf(
          await get(
            `/v1/lender/communication-holds?lenderId=${ids.lenderA}&loanAccountId=${loans.a1}`,
            ids.aViewer,
          ),
        ),
      ).toEqual([]);
      expect(
        rowsOf(
          await get(
            `/v1/lender/communication-holds?lenderId=${ids.lenderA}&status=released`,
            ids.aViewer,
          ),
        ),
      ).toEqual([]);
    });

    it('allows one active hold per loan (409 hold_active), whatever the key', async () => {
      const res = await place(ids.aAdmin, loans.a2, { reason: 'legal' });
      expect(outcome(res)).toEqual([409, 'hold_active']);
      expect(
        await countOf(
          'select count(*) as n from servicing.communication_holds where loan_account_id = $1',
          [loans.a2],
        ),
      ).toBe(1);
    });

    it('is idempotent: the same key places one hold, a different body under that key is refused', async () => {
      const key = `it-hold-${randomUUID()}`;
      const body = { reason: 'hardship' };
      const one = await place(ids.aAdmin, loans.a3, body, { key });
      const two = await place(ids.aAdmin, loans.a3, body, { key });
      expect([one.statusCode, two.statusCode]).toEqual([201, 201]);
      expect(two.json()).toEqual(one.json());
      expect(two.headers['idempotent-replayed']).toBe('true');
      expect(
        await countOf(
          'select count(*) as n from servicing.communication_holds where loan_account_id = $1',
          [loans.a3],
        ),
      ).toBe(1);
      const changed = await place(ids.aAdmin, loans.a3, { reason: 'dispute' }, { key });
      expect([changed.statusCode, code(changed)]).toEqual([422, 'idempotency_key_reused']);
      art.holdB = one.json<{ id: string }>().id;
    });

    it('refuses an unknown reason and a note the database does not accept (hold_invalid), and stores nothing', async () => {
      const before = await countOf(
        'select count(*) as n from servicing.communication_holds where lender_org_id = $1',
        [ids.lenderA],
      );
      expect(outcome(await place(ids.aAdmin, loans.a4, { reason: 'bored' }))).toEqual([
        422,
        'validation_failed',
      ]);
      expect(outcome(await place(ids.aAdmin, loans.a4, { reason: 'legal', surprise: 1 }))).toEqual([
        422,
        'validation_failed',
      ]);
      expect(outcome(await place(ids.aAdmin, loans.a4, { reason: 'legal', note: '' }))).toEqual([
        422,
        'validation_failed',
      ]);
      for (const note of [
        `Customer phone ${CANARY.phone} was noted for the file`,
        `See ${CANARY.link} for the case notes`,
        'Short',
        `Special offer reward for ${CANARY.marker} customers`,
      ]) {
        refused(note);
        const res = await place(ids.aAdmin, loans.a4, { reason: 'legal', note });
        expect([note, res.statusCode, code(res)]).toEqual([note, 422, 'hold_invalid']);
        expect(res.body).not.toContain(note);
      }
      expect(
        await countOf(
          'select count(*) as n from servicing.communication_holds where lender_org_id = $1',
          [ids.lenderA],
        ),
      ).toBe(before);
    });

    it('refuses an Aadhaar-shaped number in a note (422 unsafe_free_text) and stores nothing', async () => {
      const before = await countOf(
        'select count(*) as n from servicing.communication_holds where loan_account_id = $1',
        [loans.a4],
      );
      const note = 'Case reference 2345 6789 0123 was noted for the file';
      refused(note);
      const res = await place(ids.aAdmin, loans.a4, { reason: 'legal', note });
      expect([res.statusCode, code(res)]).toEqual([422, 'unsafe_free_text']);
      expect(res.body).not.toContain(note);
      expect(
        await countOf(
          'select count(*) as n from servicing.communication_holds where loan_account_id = $1',
          [loans.a4],
        ),
      ).toBe(before);
    });

    it('answers 404 for a loan of another lender, an unknown loan, and a caller without reminder.policy.manage', async () => {
      const mine = [ids.lenderA, ids.lenderB];
      const holds = () =>
        countOf(
          'select count(*) as n from servicing.communication_holds where lender_org_id = any($1::uuid[])',
          [mine],
        );
      const before = await holds();
      expect(outcome(await place(ids.aAdmin, loans.b1, { reason: 'legal' }))).toEqual([
        404,
        'not_found',
      ]);
      expect(outcome(await place(ids.bAdmin, loans.a4, { reason: 'legal' }))).toEqual([
        404,
        'not_found',
      ]);
      expect(outcome(await place(ids.aAdmin, randomUUID(), { reason: 'legal' }))).toEqual([
        404,
        'not_found',
      ]);
      for (const user of [ids.aViewer, ids.aApprover, ids.aNone, ids.pOps])
        expect(outcome(await place(user, loans.a4, { reason: 'legal' }))).toEqual([
          404,
          'not_found',
        ]);
      expect(outcome(await place(ids.aAdmin, 'not-a-uuid', { reason: 'legal' }))).toEqual([
        422,
        'validation_failed',
      ]);
      expect(await holds()).toBe(before);
    });

    it('checks lenderId when it is sent: it must be the lender of the loan', async () => {
      const before = await countOf(
        'select count(*) as n from servicing.communication_holds where loan_account_id = $1',
        [loans.a4],
      );
      // The wrong lender, one the caller does not belong to, and a made-up one: all 404, nothing placed.
      for (const lenderId of [ids.lenderB, randomUUID()]) {
        const res = await place(ids.aAdmin, loans.a4, { lenderId, reason: 'legal' });
        expect([lenderId === ids.lenderB ? 'other lender' : 'made up', ...outcome(res)]).toEqual([
          lenderId === ids.lenderB ? 'other lender' : 'made up',
          404,
          'not_found',
        ]);
      }
      expect(
        await countOf(
          'select count(*) as n from servicing.communication_holds where loan_account_id = $1',
          [loans.a4],
        ),
      ).toBe(before);
      const ok = await place(ids.aAdmin, loans.a4, {
        lenderId: ids.lenderA,
        reason: 'borrower_request',
      });
      expect(ok.statusCode).toBe(201);
      expect(
        await countOf(
          'select count(*) as n from servicing.communication_holds where loan_account_id = $1',
          [loans.a4],
        ),
      ).toBe(before + 1);
    });

    it('releases a hold; releasing again is a conflict; another lender, a viewer and an approver cannot', async () => {
      for (const user of [ids.bAdmin, ids.aViewer, ids.aApprover, ids.aNone, ids.pOps])
        expect(
          outcome(await post(`/v1/lender/communication-holds/${art.holdA}/release`, user, {})),
        ).toEqual([404, 'not_found']);
      expect(
        await countOf(
          'select count(*) as n from servicing.communication_holds where id = $1 and released_at is null',
          [art.holdA],
        ),
      ).toBe(1);
      const bad = await post(`/v1/lender/communication-holds/${art.holdA}/release`, ids.aAdmin, {
        note: `Reached ${CANARY.phone} again`,
      });
      refused(`Reached ${CANARY.phone} again`);
      expect(outcome(bad)).toEqual([422, 'hold_invalid']);
      const res = await post(`/v1/lender/communication-holds/${art.holdA}/release`, ids.aAdmin, {
        note: 'The complaint was closed by the lender',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ id: art.holdA, active: false });
      const stored = (
        await q<{ released_by: string; release_note: string }>(
          'select released_by, release_note from servicing.communication_holds where id = $1',
          [art.holdA],
        )
      )[0];
      expect(stored).toEqual({
        released_by: ids.aAdmin,
        release_note: 'The complaint was closed by the lender',
      });
      expect(
        outcome(await post(`/v1/lender/communication-holds/${art.holdA}/release`, ids.aAdmin, {})),
      ).toEqual([409, 'already_released']);
      // Messages suppressed during the hold stay suppressed.
      expect(await plannedStatus('a2_planned_1')).toEqual({
        status: 'suppressed',
        suppress_reason: 'hold',
      });
      const released = rowsOf<{
        id: string;
        active: boolean;
        releasedBy: string | null;
        releaseNote: string | null;
      }>(
        await get(
          `/v1/lender/communication-holds?lenderId=${ids.lenderA}&status=released`,
          ids.aViewer,
        ),
      );
      expect(released).toMatchObject([
        {
          id: art.holdA,
          active: false,
          releasedBy: ids.aAdmin,
          releaseNote: 'The complaint was closed by the lender',
        },
      ]);
      expect(
        outcome(
          await post(`/v1/lender/communication-holds/${randomUUID()}/release`, ids.aAdmin, {}),
        ),
      ).toEqual([404, 'not_found']);
      expect(
        outcome(
          await post(`/v1/lender/communication-holds/${art.holdA}/release`, ids.aAdmin, {
            surprise: 1,
          }),
        ),
      ).toEqual([422, 'validation_failed']);
    });

    it('lets a hold be placed again after it was released (a new hold)', async () => {
      const again = await place(ids.aAdmin, loans.a2, { reason: 'dispute' });
      expect(again.statusCode).toBe(201);
      expect(again.json<{ id: string }>().id).not.toBe(art.holdA);
      expect(
        await countOf(
          'select count(*) as n from servicing.communication_holds where loan_account_id = $1',
          [loans.a2],
        ),
      ).toBe(2);
    });

    it("keeps lender B's holds from lender A's lists and release route", async () => {
      const b = await place(ids.bAdmin, loans.b1, { reason: 'legal', lenderId: ids.lenderB });
      expect(b.statusCode).toBe(201);
      const bid = b.json<{ id: string }>().id;
      const mine = rowsOf<{ id: string; lenderId: string }>(
        await get(`/v1/lender/communication-holds?limit=100`, ids.aAdmin),
      );
      expect(idsOf(mine)).not.toContain(bid);
      for (const row of mine) expect(row.lenderId).toBe(ids.lenderA);
      expect(
        idsOf(
          rowsOf(
            await get(`/v1/lender/communication-holds?lenderId=${ids.lenderB}`, ids.bApprover),
          ),
        ),
      ).toEqual([bid]);
      expect(
        outcome(await post(`/v1/lender/communication-holds/${bid}/release`, ids.aAdmin, {})),
      ).toEqual([404, 'not_found']);
      const platform = idsOf(
        rowsOf(await get('/v1/lender/communication-holds?limit=100', ids.pOps)),
      );
      expect(platform).toContain(bid);
      expect(platform).toContain(art.holdA);
      // The pagination cursor of one lender shows the other lender nothing.
      const walk = await pages<{ id: string }>(
        `/v1/lender/communication-holds?lenderId=${ids.lenderA}`,
        ids.aAdmin,
        1,
      );
      expect(walk.all.length).toBe(
        await countOf(
          'select count(*) as n from servicing.communication_holds where lender_org_id = $1',
          [ids.lenderA],
        ),
      );
    });

    it('never blocks the borrower from paying: no payment function reads a hold', async () => {
      expect(
        await countOf(
          `select count(*) as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'payments' and p.prosrc ilike '%communication_holds%'`,
        ),
      ).toBe(0);
    });
  });

  // =========================================================================================================================
  // Reminders
  // =========================================================================================================================
  describe('reminders', () => {
    const aRows = () =>
      q<{ id: string }>(
        'select id from servicing.reminders where lender_org_id = $1 order by scheduled_for desc, id desc',
        [ids.lenderA],
      );

    it("lists the lender's reminders newest scheduled first, every row exactly the declared shape", async () => {
      const res = await get(`/v1/lender/reminders?lenderId=${ids.lenderA}&limit=100`, ids.aViewer);
      expect(res.statusCode).toBe(200);
      const page = LrReminderPage.parse(res.json());
      expect(idsOf(page.items)).toEqual(idsOf(await aRows()));
      expect(page.nextCursor).toBeNull();
      for (const row of page.items)
        expect(keys(row)).toEqual(
          [
            'amountMinor',
            'attempts',
            'channel',
            'claimedAt',
            'createdAt',
            'dueDate',
            'id',
            'installmentSeq',
            'kind',
            'languageFallback',
            'languageUsed',
            'lenderId',
            'loanAccountId',
            'offsetDays',
            'penalTextId',
            'scheduledFor',
            'status',
            'suppressReason',
            'templateId',
            'updatedAt',
          ].sort(),
        );
      const byId = new Map(page.items.map((r) => [r.id, r]));
      expect(byId.get(rem.sent_inapp ?? '')).toMatchObject({
        lenderId: ids.lenderA,
        loanAccountId: loans.a1,
        installmentSeq: 1,
        offsetDays: -3,
        channel: 'in_app',
        kind: 'pre_due',
        status: 'sent',
        suppressReason: null,
        attempts: 1,
        templateId: templateRef,
        penalTextId: null,
        languageUsed: 'en',
        languageFallback: false,
        amountMinor: 475_000,
      });
      expect(byId.get(rem.overdue_sent_hi ?? '')).toMatchObject({
        kind: 'overdue',
        penalTextId: penalRef,
        languageFallback: true,
        amountMinor: 950_000,
      });
      expect(byId.get(rem.planned_now ?? '')).toMatchObject({
        status: 'planned',
        templateId: null,
        languageUsed: null,
        claimedAt: null,
        amountMinor: null,
        suppressReason: null,
      });
      expect(byId.get(rem.penal_missing ?? '')).toMatchObject({
        status: 'suppressed',
        suppressReason: 'penal_text_missing',
        amountMinor: null,
      });
      expect(byId.get(rem.sms_placeholder ?? '')).toMatchObject({
        channel: 'sms',
        status: 'suppressed',
        suppressReason: 'sms_not_configured',
      });
      expect(byId.get(rem.failed_push ?? '')).toMatchObject({
        status: 'failed',
        attempts: 3,
        amountMinor: 480_000,
      });
    });

    it('returns no wording, no variables, no hash, no borrower, no lease and no lender display name', async () => {
      const text = (
        await get(`/v1/lender/reminders?lenderId=${ids.lenderA}&limit=100`, ids.aViewer)
      ).body;
      for (const forbidden of [
        CANARY.lenderName,
        CANARY.remindersHash,
        CANARY.remindersPenalHash,
        borrowers.a,
        borrowers.b,
        '"body"',
        '"variables"',
        'borrower',
        'Sha256',
        'claimedUntil',
        'lender_name',
        'sentence',
      ])
        expect([forbidden, text.includes(forbidden)]).toEqual([forbidden, false]);
    });

    it('pages without gaps or repeats, at any page size', async () => {
      const expected = idsOf(await aRows());
      for (const size of [1, 4, 7, 100]) {
        const walk = await pages<{ id: string }>(
          `/v1/lender/reminders?lenderId=${ids.lenderA}`,
          ids.aViewer,
          size,
        );
        expect([size, idsOf(walk.all)]).toEqual([size, expected]);
        expect(walk.sizes.every((n) => n <= size)).toBe(true);
      }
    });

    it('filters by status, suppress reason, kind, channel, loan and time', async () => {
      const filtered = async (query: string, sql: string, values: unknown[] = []) => {
        const got = idsOf(
          (
            await pages<{ id: string }>(
              `/v1/lender/reminders?lenderId=${ids.lenderA}&${query}`,
              ids.aViewer,
              5,
            )
          ).all,
        );
        const want = idsOf(
          await q<{ id: string }>(
            `select id from servicing.reminders where lender_org_id = $1 and ${sql} order by scheduled_for desc, id desc`,
            [ids.lenderA, ...values],
          ),
        );
        expect([query, got]).toEqual([query, want]);
        return got;
      };
      expect((await filtered('status=sent', `status = 'sent'`)).length).toBe(4);
      expect(
        await filtered(
          'status=suppressed&suppressReason=penal_text_missing',
          `suppress_reason = 'penal_text_missing'`,
        ),
      ).toEqual([rem.penal_missing]);
      expect(
        (
          await filtered(
            'suppressReason=sms_not_configured',
            `suppress_reason = 'sms_not_configured'`,
          )
        ).length,
      ).toBe(1);
      expect((await filtered('kind=overdue', `kind = 'overdue'`)).length).toBeGreaterThan(0);
      expect(
        (await filtered('kind=pre_due&channel=push', `kind = 'pre_due' and channel = 'push'`))
          .length,
      ).toBeGreaterThan(0);
      expect(
        (await filtered(`loanAccountId=${loans.a2}`, `loan_account_id = '${loans.a2}'`)).length,
      ).toBe(3);
      expect((await filtered('status=planned', `status = 'planned'`)).length).toBe(
        await countOf(
          `select count(*) as n from servicing.reminders where lender_org_id = $1 and status = 'planned'`,
          [ids.lenderA],
        ),
      );
      const from = new Date(Date.now() - 6.5 * 3_600_000).toISOString();
      const to = new Date(Date.now() - 2.5 * 3_600_000).toISOString();
      const window = await filtered(
        `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
        `scheduled_for >= $2::timestamptz and scheduled_for < $3::timestamptz`,
        [from, to],
      );
      expect(window.length).toBeGreaterThan(0);
      expect(window).not.toContain(rem.sent_inapp);
      expect(window).not.toContain(rem.planned_future);
    });

    it('refuses a filter outside the closed lists, a malformed time or limit, and a bad cursor', async () => {
      for (const query of [
        'status=queued',
        'suppressReason=bored',
        'kind=sales',
        'channel=whatsapp',
        'from=yesterday',
        'limit=0',
        'limit=101',
        'surprise=1',
        'loanAccountId=nope',
      ])
        expect([
          query,
          (await get(`/v1/lender/reminders?lenderId=${ids.lenderA}&${query}`, ids.aViewer))
            .statusCode,
        ]).toEqual([query, 422]);
      const bad = await get(
        `/v1/lender/reminders?lenderId=${ids.lenderA}&cursor=not-a-cursor`,
        ids.aViewer,
      );
      expect([bad.statusCode, code(bad)]).toEqual([400, 'invalid_cursor']);
    });

    it('shows a lender only its own reminders, with or without a lender filter, at any page', async () => {
      const mine = new Set(idsOf(await aRows()));
      const unfiltered = await pages<{ id: string; lenderId: string }>(
        '/v1/lender/reminders',
        ids.aViewer,
        3,
      );
      expect(new Set(idsOf(unfiltered.all))).toEqual(mine);
      for (const row of unfiltered.all) expect(row.lenderId).toBe(ids.lenderA);
      const other = await pages<{ id: string; lenderId: string }>(
        '/v1/lender/reminders',
        ids.bAdmin,
        3,
      );
      expect(other.all.length).toBe(
        await countOf('select count(*) as n from servicing.reminders where lender_org_id = $1', [
          ids.lenderB,
        ]),
      );
      for (const row of other.all) {
        expect(row.lenderId).toBe(ids.lenderB);
        expect(mine.has(row.id)).toBe(false);
      }
      // A cursor taken from lender A's list shows lender B nothing of A.
      const first = await get(`/v1/lender/reminders?lenderId=${ids.lenderA}&limit=2`, ids.aViewer);
      const cursor = first.json<Page<unknown>>().nextCursor ?? '';
      const replayed = await get(
        `/v1/lender/reminders?lenderId=${ids.lenderB}&limit=100&cursor=${encodeURIComponent(cursor)}`,
        ids.bAdmin,
      );
      for (const row of rowsOf<{ id: string }>(replayed)) expect(mine.has(row.id)).toBe(false);
      expect(
        outcome(await get(`/v1/lender/reminders?lenderId=${ids.lenderB}`, ids.aViewer)),
      ).toEqual([403, 'forbidden']);
      // Platform operations read across lenders.
      const platform = await pages<{ id: string }>('/v1/lender/reminders', ids.pOps, 50);
      for (const id of mine) expect(idsOf(platform.all)).toContain(id);
      expect(idsOf(platform.all)).toContain(rem.b_sent);
    });

    it("counts the lender's reminders by status, reason and channel (summary)", async () => {
      const expectedFor = async (lender: string, since?: string) =>
        (
          await q<{ status: string; suppress_reason: string | null; channel: string; n: string }>(
            `select status, suppress_reason, channel, count(*)::text as n from servicing.reminders
            where lender_org_id = $1 and scheduled_for >= coalesce($2::timestamptz, now() - interval '30 days')
            group by status, suppress_reason, channel order by status, suppress_reason nulls first, channel`,
            [lender, since ?? null],
          )
        ).map((r) => ({
          status: r.status,
          suppressReason: r.suppress_reason,
          channel: r.channel,
          count: Number(r.n),
        }));
      const res = await get(`/v1/lender/reminders/summary?lenderId=${ids.lenderA}`, ids.aViewer);
      expect(res.statusCode).toBe(200);
      const summary = LrReminderSummary.parse(res.json());
      expect(summary.lenderId).toBe(ids.lenderA);
      expect(summary.since).toBeNull();
      expect(summary.items).toEqual(await expectedFor(ids.lenderA));
      // The 40-day-old message is outside the default window.
      expect(summary.items.find((i) => i.suppressReason === 'paid')).toBeUndefined();
      const total = summary.items.reduce((sum, i) => sum + i.count, 0);
      expect(total).toBe(
        await countOf(
          `select count(*) as n from servicing.reminders where lender_org_id = $1 and scheduled_for >= now() - interval '30 days'`,
          [ids.lenderA],
        ),
      );
      expect(summary.items.find((i) => i.status === 'sent')?.count).toBeGreaterThan(0);
      expect(
        summary.items.some(
          (i) =>
            i.channel === 'sms' &&
            i.status === 'suppressed' &&
            i.suppressReason === 'sms_not_configured',
        ),
      ).toBe(true);
      // An explicit start brings the old message back.
      const since = new Date(Date.now() - 60 * 24 * 3_600_000).toISOString();
      const wide = LrReminderSummary.parse(
        (
          await get(
            `/v1/lender/reminders/summary?lenderId=${ids.lenderA}&since=${encodeURIComponent(since)}`,
            ids.aApprover,
          )
        ).json(),
      );
      expect(wide.since).toBe(since);
      expect(wide.items).toEqual(await expectedFor(ids.lenderA, since));
      expect(wide.items.find((i) => i.suppressReason === 'paid')?.count).toBe(1);
      // Lender B counts only its own.
      const b = LrReminderSummary.parse(
        (await get(`/v1/lender/reminders/summary?lenderId=${ids.lenderB}`, ids.bAdmin)).json(),
      );
      expect(b.items).toEqual(await expectedFor(ids.lenderB));
      expect(b.items.reduce((sum, i) => sum + i.count, 0)).toBe(4);
      expect(keys(summary.items[0])).toEqual(['channel', 'count', 'status', 'suppressReason']);
      // Missing lender, malformed time.
      expect((await get('/v1/lender/reminders/summary', ids.aViewer)).statusCode).toBe(422);
      expect(
        (
          await get(
            `/v1/lender/reminders/summary?lenderId=${ids.lenderA}&since=lately`,
            ids.aViewer,
          )
        ).statusCode,
      ).toBe(422);
    });

    it('answers a platform operations user for any lender', async () => {
      const b = LrReminderSummary.parse(
        (await get(`/v1/lender/reminders/summary?lenderId=${ids.lenderB}`, ids.pOps)).json(),
      );
      expect(b.items.reduce((sum, i) => sum + i.count, 0)).toBe(4);
    });

    it('returns the attempt log of a reminder, oldest first, with the states exactly as recorded', async () => {
      const read = LrDeliveryLog.parse(
        (await get(`/v1/lender/reminders/${rem.sent_inapp ?? ''}/deliveries`, ids.aViewer)).json(),
      );
      expect(read.reminderId).toBe(rem.sent_inapp);
      expect(read.items.map((d) => [d.channel, d.state, d.source])).toEqual([
        ['in_app', 'accepted', 'send'],
        ['in_app', 'read', 'app'],
      ]);
      const push = LrDeliveryLog.parse(
        (await get(`/v1/lender/reminders/${rem.sent_push ?? ''}/deliveries`, ids.aApprover)).json(),
      );
      expect(push.items.map((d) => [d.state, d.source, d.providerRef])).toEqual([
        ['accepted', 'send', 'PRV-REF-1'],
        ['delivered', 'delivery_report', 'PRV-REF-1'],
      ]);
      const failed = LrDeliveryLog.parse(
        (await get(`/v1/lender/reminders/${rem.failed_push ?? ''}/deliveries`, ids.aViewer)).json(),
      );
      expect(failed.items.map((d) => d.errorClass)).toEqual([
        'provider_timeout',
        'provider_timeout',
        'provider_error',
      ]);
      expect(failed.items.every((d) => d.state === 'failed' && d.source === 'send')).toBe(true);
      const sms = LrDeliveryLog.parse(
        (
          await get(`/v1/lender/reminders/${rem.sms_placeholder ?? ''}/deliveries`, ids.aViewer)
        ).json(),
      );
      expect(sms.items.map((d) => [d.channel, d.state])).toEqual([['sms', 'not_configured']]);
      const overdue = LrDeliveryLog.parse(
        (
          await get(`/v1/lender/reminders/${rem.overdue_sent_hi ?? ''}/deliveries`, ids.aViewer)
        ).json(),
      );
      expect(overdue.items[0]).toMatchObject({
        contentSha256: CANARY.deliveryHash,
        penalTextSha256: CANARY.deliveryPenalHash,
      });
      expect(keys(overdue.items[0])).toEqual([
        'channel',
        'contentSha256',
        'errorClass',
        'id',
        'occurredAt',
        'penalTextSha256',
        'providerRef',
        'source',
        'state',
      ]);
      // A reminder that has no attempt yet has an empty log, not a 404.
      const none = LrDeliveryLog.parse(
        (await get(`/v1/lender/reminders/${rem.planned_now ?? ''}/deliveries`, ids.aViewer)).json(),
      );
      expect(none.items).toEqual([]);
    });

    it("answers 404 to another lender's reminder and to an unknown one, 403 to someone who cannot read loans", async () => {
      expect(
        outcome(await get(`/v1/lender/reminders/${rem.b_sent ?? ''}/deliveries`, ids.aViewer)),
      ).toEqual([404, 'not_found']);
      expect(
        outcome(await get(`/v1/lender/reminders/${rem.sent_inapp ?? ''}/deliveries`, ids.bAdmin)),
      ).toEqual([404, 'not_found']);
      expect(
        outcome(await get(`/v1/lender/reminders/${randomUUID()}/deliveries`, ids.aViewer)),
      ).toEqual([404, 'not_found']);
      expect(
        outcome(await get(`/v1/lender/reminders/${rem.sent_inapp ?? ''}/deliveries`, ids.aNone)),
      ).toEqual([403, 'forbidden']);
      expect(
        (await get('/v1/lender/reminders/not-a-uuid/deliveries', ids.aViewer)).statusCode,
      ).toBe(422);
      expect(
        (await get(`/v1/lender/reminders/${rem.b_sent ?? ''}/deliveries`, ids.pOps)).statusCode,
      ).toBe(200);
    });
  });

  // =========================================================================================================================
  // Minimisation: nothing personal in a response, an error or a log line
  // =========================================================================================================================
  describe('minimisation', () => {
    it('keeps every personal-looking value, every content hash of the reminders table and every refused text out of every response', () => {
      const everything = seen.join('\n');
      expect(everything.length).toBeGreaterThan(10_000);
      // Identifiers are random and may contain long digit runs; the attempt log returns two SHA-256 values by design (the evidence of
      // what was sent), which the reminders list does not: both are removed before the scan, and the reminders-table hashes are
      // checked by name below.
      const noUuids = everything
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '')
        .replace(/"(contentSha256|penalTextSha256)":"[0-9a-f]{64}"/g, '');
      expect((noUuids.match(/.{0,30}[0-9]{9,}.{0,30}/g) ?? []).join(' | ')).toBe('');
      for (const value of [
        CANARY.phone,
        CANARY.account,
        CANARY.link,
        CANARY.lenderName,
        CANARY.remindersHash,
        CANARY.remindersPenalHash,
        CANARY.marker,
        borrowers.a,
        borrowers.b,
        ids.borrower,
        'https://',
        'www.',
        '@lender.example',
      ])
        expect([value, everything.includes(value)]).toEqual([value, false]);
      for (const text of refusedPayloads)
        expect([text, everything.includes(text)]).toEqual([text, false]);
      for (const name of [
        'borrowerId',
        'borrower_id',
        'variables',
        'lenderName',
        'accountNumber',
        'claimedUntil',
        'bodySha256',
        'payload',
        'phone',
      ])
        expect([name, everything.includes(`"${name}"`)]).toEqual([name, false]);
    });

    it('writes none of it to the request log either, whatever the outcome', async () => {
      const captured: string[] = [];
      const realWriteSync = fs.writeSync.bind(fs);
      const realWrite = fs.write.bind(fs);
      // pino writes to file descriptor 1; everything written there while this test runs is kept, the rest passes through.
      vi.spyOn(fs, 'writeSync').mockImplementation(
        (fd: number, data: unknown, ...rest: unknown[]) => {
          if (fd === 1) {
            captured.push(String(data));
            return String(data).length;
          }
          return (realWriteSync as (...a: unknown[]) => number)(fd, data, ...rest);
        },
      );
      vi.spyOn(fs, 'write').mockImplementation((fd: number, data: unknown, ...rest: unknown[]) => {
        if (fd === 1) {
          captured.push(String(data));
          const done = rest.at(-1);
          if (typeof done === 'function')
            (done as (e: null, n: number) => void)(null, String(data).length);
          return;
        }
        (realWrite as (...a: unknown[]) => void)(fd, data, ...rest);
      });
      const logged = await buildApp(loadConfig({ APP_ENV: 'local', LOG_LEVEL: 'trace' }), {
        auth: { verifier: fakeVerifier, context: createUserContext(apiPool) },
      });
      const logNote = `Customer asked ${CANARY.marker} for a pause on reminders`;
      const logWording = `Please note ${CANARY.marker} before {{due_date}} comes`;
      try {
        const send = (method: 'GET' | 'POST', url: string, user: string, payload?: unknown) =>
          logged.inject({
            method,
            url,
            remoteAddress: freshAddress(),
            headers: {
              authorization: `Bearer test.${user}.aal2`,
              ...(method === 'POST' ? { 'idempotency-key': `it-${randomUUID()}` } : {}),
            },
            ...(payload === undefined ? {} : { payload: payload as object }),
          });
        await send('GET', `/v1/lender/reminders?lenderId=${ids.lenderA}`, ids.aViewer);
        await send('GET', `/v1/lender/reminder-templates?lenderId=${ids.lenderA}`, ids.aApprover);
        await send('GET', `/v1/lender/reminders/${rem.b_sent ?? ''}/deliveries`, ids.aViewer);
        await send(
          'POST',
          '/v1/lender/reminder-templates',
          ids.aAdmin,
          templateBody({ body: logWording }),
        );
        await send(
          'POST',
          '/v1/lender/reminder-templates',
          ids.aAdmin,
          templateBody({ body: `${logWording} ${CANARY.phone}` }),
        );
        await send(
          'POST',
          '/v1/lender/penal-charge-texts',
          ids.aAdmin,
          penalBody({
            reason: `Reason ${CANARY.marker} for the file entry`,
            sentenceEn: `Sentence ${CANARY.marker} applies as in your agreement`,
          }),
        );
        await send('POST', `/v1/lender/loans/${loans.b1}/communication-hold`, ids.aAdmin, {
          reason: 'legal',
          note: logNote,
        });
        await send('POST', `/v1/lender/loans/${loans.a4}/communication-hold`, ids.aAdmin, {
          reason: 'legal',
          note: `${logNote} ${CANARY.phone}`,
        });
        await new Promise((resolve) => setTimeout(resolve, 300));
      } finally {
        await logged.close();
        vi.restoreAllMocks();
      }
      const log = captured.join('');
      expect(log).toContain('request completed');
      for (const value of [
        CANARY.marker,
        CANARY.phone,
        CANARY.account,
        CANARY.link,
        CANARY.lenderName,
        CANARY.remindersHash,
        CANARY.deliveryHash,
        borrowers.a,
        borrowers.b,
        TAG,
        'Customer asked',
        'Please note',
      ])
        expect([value, log.includes(value)]).toEqual([value, false]);
      // The path is logged, the query string and the body are not.
      expect(log).not.toContain('lenderId=');
      expect(log).not.toContain('"reason":"legal"');
    });
  });

  // =========================================================================================================================
  // The declared contract
  // =========================================================================================================================
  describe('contract', () => {
    it('declares every route in the OpenAPI document', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/openapi.json' });
      expect(res.statusCode).toBe(200);
      const paths = res.json<{ paths: Record<string, Record<string, unknown>> }>().paths;
      const declared = [
        ['/v1/lender/reminder-policies', ['get', 'post']],
        ['/v1/lender/reminder-policies/{id}/approve', ['post']],
        ['/v1/lender/reminder-policies/{id}/retire', ['post']],
        ['/v1/lender/reminder-templates', ['get', 'post']],
        ['/v1/lender/reminder-templates/{id}/approve', ['post']],
        ['/v1/lender/reminder-templates/{id}/retire', ['post']],
        ['/v1/lender/penal-charge-texts', ['get', 'post']],
        ['/v1/lender/penal-charge-texts/{id}/approve', ['post']],
        ['/v1/lender/penal-charge-texts/{id}/retire', ['post']],
        ['/v1/lender/communication-holds', ['get']],
        ['/v1/lender/loans/{id}/communication-hold', ['post']],
        ['/v1/lender/communication-holds/{id}/release', ['post']],
        ['/v1/lender/reminders', ['get']],
        ['/v1/lender/reminders/summary', ['get']],
        ['/v1/lender/reminders/{id}/deliveries', ['get']],
      ] as const;
      for (const [path, methods] of declared)
        for (const method of methods)
          expect([path, method, Boolean(paths[path]?.[method])]).toEqual([path, method, true]);
    });

    it('answers a method that is not declared with 404 or 405, never with data', async () => {
      for (const [method, url] of [
        ['POST', '/v1/lender/reminders'],
        ['POST', '/v1/lender/reminders/summary'],
        ['POST', '/v1/lender/communication-holds'],
      ] as const) {
        const res = await app.inject({
          method,
          url,
          remoteAddress: freshAddress(),
          headers: {
            authorization: `Bearer test.${ids.aAdmin}.aal2`,
            'idempotency-key': `it-${randomUUID()}`,
          },
          payload: {},
        });
        expect([url, [404, 405].includes(res.statusCode)]).toEqual([url, true]);
      }
    });
  });
});
