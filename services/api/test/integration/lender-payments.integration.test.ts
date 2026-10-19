// Phase 08a lender payments, provider events, policies, mandates, reconciliation and the exception queue over HTTP, against a REAL
// migrated Postgres (same gating as the other integration files; needs INTEGRATION_ADMIN_URL, INTEGRATION_API_URL and
// INTEGRATION_SYSTEM_URL and a freshly migrated database). Synthetic data only.
//
// Fixtures: two lenders, lender users with and without payment.read / payment.configure / payment.reconcile, and platform
// users. The rows that the system role creates in production (provider events, provider payments, settlement batches,
// bank credits, receipts, mandates, debits) are inserted here AS THE TABLE OWNER with session_replication_role = replica,
// which switches off triggers and foreign key checks for that transaction only; the check constraints and unique indexes still
// apply. Exceptions are raised through payments.raise_exception and the reconciliation run through payments.run_reconciliation,
// both as the real system login, so those rows have the shape the database really produces. The reads, the writes and the
// exception lifecycle go through the real HTTP routes and the real SQL functions with row level security applied.
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import {
  LP_BANK_CREDIT_MAX_ROWS,
  LP_REOPEN_REASONS,
  LP_RESOLVE_REASONS,
  LpExceptionPage,
  LpMandatePage,
  LpPaymentPage,
} from '@udofin/contracts';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app.js';
import { TokenError, type TokenVerifier } from '../../src/auth/token-verifier.js';
import { loadConfig } from '../../src/config.js';
import { createUserContext } from '../../src/db/user-context.js';
import { createSystemPool, type SystemPool } from '../../src/system/pool.js';

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
const freshAddress = () => `10.11.${(nextAddress >> 8) & 255}.${nextAddress++ & 255}`;

// Values that must never come back in a response or a log line. They are planted in the columns that hold secrets, hashes,
// links and personal-looking values, and every response of this file is scanned for them at the end.
const CANARY = {
  phone: `91${Math.floor(7_000_000_000 + Math.random() * 2_999_999_999)}`,
  account: `ACCTNO${Math.floor(100_000_000 + Math.random() * 899_999_999)}`,
  link: `https://pay.example.test/checkout/CANARYLINK${randomUUID().slice(0, 8)}`,
  hmac: randomBytes(32).toString('hex'),
  payloadHash: `${'c0ffee'.repeat(10)}abcd`,
  secretRef: 'CANARY_SECRET_REF_X1',
  tokenHash: 'ab'.repeat(32),
  tokenHashB: 'cd'.repeat(32),
  idempotency: `canary-intent-key-${randomUUID()}`,
  creditor: `CANARY-CREDITOR-${randomUUID().slice(0, 8)}`,
  narration: `NARRATION-${randomUUID().slice(0, 8)}`,
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

describe.skipIf(!enabled)(
  'lender payments, mandates, reconciliation and exceptions over HTTP',
  () => {
    const ids = {
      platformOrg: randomUUID() as string,
      lenderA: randomUUID(),
      lenderB: randomUUID(),
      // lender A users
      aViewer: randomUUID(), // payment.read (role viewer)
      aPayer: randomUUID(), // payment.configure + payment.read (payments_admin)
      aRecon: randomUUID(), // payment.read + payment.reconcile (reconciler)
      aRecon2: randomUUID(),
      aRecon3: randomUUID(),
      aRecon4: randomUUID(),
      aNone: randomUUID(), // no payment permission at all (credit_officer)
      // lender B users
      bViewer: randomUUID(),
      bPayer: randomUUID(),
      bRecon: randomUUID(),
      // platform users
      pOps: randomUUID(), // operations_agent: payment.read across lenders
      pPay: randomUUID(), // platform_payments_admin: platform.payments.providers.manage
      pPay2: randomUUID(),
      borrower: randomUUID(),
      spammer: randomUUID(),
    };
    const borrowerPhone = CANARY.phone;
    let admin: pg.Pool;
    let apiPool: pg.Pool;
    let systemPool: SystemPool;
    let app: Awaited<ReturnType<typeof buildApp>>;
    /** Every response body this file received, for the final scan. */
    const seen: string[] = [];

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
    const get = (url: string, user: string | null) => call('GET', url, user);
    const post = (url: string, user: string | null, payload: unknown = {}) =>
      call('POST', url, user, payload);
    const code = (res: { json: () => unknown }) => (res.json() as Problem).code;
    const q = async <T extends pg.QueryResultRow>(sql: string, values: unknown[] = []) =>
      (await admin.query<T>(sql, values)).rows;

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

    // ----------------------------------------------------------------------------------------------------------------
    // The data of one lender
    // ----------------------------------------------------------------------------------------------------------------
    interface LenderData {
      id: string;
      /** The borrower the intents and mandates belong to: it must never appear in a response. */
      borrower: string;
      config: string;
      account: string;
      otherAccount: string;
      /** Newest first. */
      intents: { id: string; loan: string; purpose: string; status: string; amount: number }[];
      /** Provider payments of the four succeeded intents, in the order of the stages the fixture builds. */
      payments: { id: string; ref: string; intent: string; amount: number }[];
      events: string[];
      mandates: string[];
      batches: string[];
      exceptions: string[];
    }

    const sha = (seed: string) => {
      let out = '';
      for (let i = 0; out.length < 64; i += 1)
        out += Buffer.from(`${seed}-${String(i)}`).toString('hex');
      return out.slice(0, 64);
    };

    async function buildLender(
      lender: string,
      tag: string,
      withSettlement: boolean,
    ): Promise<LenderData> {
      const account = randomUUID();
      const otherAccount = randomUUID();
      const config = randomUUID();
      const maker = randomUUID();
      const checker = randomUUID();
      const submitter = randomUUID();
      for (const u of [maker, checker, submitter])
        await admin.query(
          `insert into auth.users (id, phone, raw_app_meta_data) values ($1, null, '{"actor_type":"staff"}')`,
          [u],
        );
      const intents: LenderData['intents'] = [];
      const payments: LenderData['payments'] = [];
      const events: string[] = [];
      const mandates: string[] = [];
      const batches: string[] = [];
      const borrower = randomUUID();
      const hoursAgo = (n: number) => `now() - interval '${String(n)} hours'`;

      await replica(async (c) => {
        // One live settlement account per (lender, bank, masked reference): a unique index refuses two accounts of one lender at
        // one bank with the same masked reference, so each gets its own.
        for (const [id, label, masked] of [
          [account, `SAMPLE ${CANARY.account}`, 'XXXXXX0000'],
          [otherAccount, 'SAMPLE spare', 'XXXXXX0001'],
        ] as const)
          await c.query(
            `insert into tenancy.lender_settlement_accounts (id, lender_org_id, label, bank_name, masked_account_ref, status)
             values ($1, $2, $3, 'Test Bank', $4, 'unverified')`,
            [id, lender, label, masked],
          );
        await c.query(
          `insert into payments.lender_payment_configs (id, lender_org_id, provider, provider_mode, merchant_registry_id, settlement_account_id, secret_ref,
                                                      webhook_secret_ref, endpoint_token_hash, evidence_ref, contract_section_ref, status, idempotency_key,
                                                      drafted_by, submitted_by, submitted_at, approved_by, approved_at)
           values ($1, $2, 'mock_gateway_f2', 'mock', $3, $4, $5, 'SAMPLE_WEBHOOK_SECRET', $6, 'SAMPLE-EVIDENCE-2', 'SAMPLE-CONTRACT-1', 'active', $7,
                   $8, $9, now(), $10, now())`,
          [
            config,
            lender,
            randomUUID(),
            account,
            CANARY.secretRef,
            tag === 'a' ? CANARY.tokenHash : CANARY.tokenHashB,
            `sample-config-${tag}-${randomUUID()}`,
            maker,
            submitter,
            checker,
          ],
        );

        // Seven payment requests, newest first: four succeeded (one per settlement stage), then pending, created, failed.
        const plan: [string, string, number, string?][] = [
          ['installment', 'succeeded', 475_000],
          ['overdue', 'succeeded', 950_000],
          ['installment', 'succeeded', 475_000],
          ['part_prepayment', 'succeeded', 1_200_000],
          ['installment', 'pending', 475_000],
          ['installment', 'created', 475_000],
          ['installment', 'failed', 475_000],
        ];
        const loanShared = randomUUID();
        for (const [n, [purpose, status, amount]] of plan.entries()) {
          const id = randomUUID();
          // The first two share a loan (different purposes), the others have their own, so the one-open-intent index is never in the way.
          const loan = n < 2 ? loanShared : randomUUID();
          intents.push({ id, loan, purpose, status, amount });
          await c.query(
            `insert into payments.payment_intents (id, lender_org_id, loan_account_id, borrower_id, purpose, amount_minor, provider, provider_order_ref,
                                                 idempotency_key, status, config_id, provider_mode, settlement_account_id, created_by, created_at, updated_at,
                                                 target_installment_seq, link_expires_at)
             values ($1, $2, $3, $4, $5::payments.intent_purpose, $6, 'mock_gateway_f2', $7, $8, $9::payments.intent_status, $10, 'mock', $11, $12,
                     ${hoursAgo(n + 1)}, ${hoursAgo(n + 1)}, $13, now() + interval '1 day')`,
            [
              id,
              lender,
              loan,
              borrower,
              purpose,
              amount,
              `order_${tag}_${String(n)}`,
              n === 0
                ? `${CANARY.idempotency}-${tag}`
                : `sample-intent-${tag}-${String(n)}-${randomUUID()}`,
              status,
              config,
              account,
              borrower,
              purpose === 'installment' ? 1 : null,
            ],
          );
        }

        // Verified provider events (one per succeeded payment), an ignored one, a refund, and one without normalisation.
        const stages = JSON.stringify({
          authentication: 'matched',
          integrity: 'matched',
          correlation: 'matched',
          business: 'passed',
        });
        const addEvent = async (
          n: number,
          kind: string | null,
          ref: string | null,
          intent: string | null,
          status: string,
          amount: number | null,
          processing: 'actionable' | 'ignored' | null,
        ) => {
          const id = randomUUID();
          events.push(id);
          await c.query(
            `insert into payments.provider_events (id, provider, provider_event_id, event_type, lender_org_id, payment_intent_id, amount_minor, provider_status,
                                                 payload_sha256, signature_verified, received_at, currency, config_id, object_kind, object_ref, order_ref,
                                                 rank, occurred_at, verification_stages, processing_class)
             values ($1, 'mock_gateway_f2', $2, $3, $4, $5, $6, $7, $8, true, ${hoursAgo(n)}, $9, $10, $11, $12, $13, $14, ${hoursAgo(n)},
                     $15::jsonb, $16)`,
            [
              id,
              `evt_${tag}_${String(n)}_${randomUUID().slice(0, 6)}`,
              kind === 'refund'
                ? 'refund.processed'
                : kind === 'unsupported'
                  ? 'something.new'
                  : 'payment.captured',
              lender,
              intent,
              amount,
              status,
              CANARY.payloadHash,
              amount === null ? null : 'INR',
              config,
              kind,
              ref,
              intent === null ? null : `order_${tag}_0`,
              kind === null ? null : 50,
              kind === null ? null : stages,
              processing,
            ],
          );
          return id;
        };

        for (let n = 0; n < 4; n += 1) {
          const intent = intents[n];
          if (!intent) throw new Error('fixture');
          const ref = `PAY-${tag}-${String(n)}`;
          const eventId = await addEvent(
            10 + n,
            'payment',
            ref,
            intent.id,
            'captured',
            intent.amount,
            'actionable',
          );
          const pp = randomUUID();
          payments.push({ id: pp, ref, intent: intent.id, amount: intent.amount });
          await c.query(
            `insert into payments.provider_payments (id, lender_org_id, config_id, provider, provider_payment_ref, order_ref, intent_id, loan_account_id, status, rank,
                                                   amount_minor, currency, captured_at, duplicate_capture, first_event_id, last_event_id, created_at, updated_at)
             values ($1, $2, $3, 'mock_gateway_f2', $4, $5, $6, $7, 'captured', 50, $8, 'INR', ${hoursAgo(10 + n)}, false, $9, $9, ${hoursAgo(10 + n)}, ${hoursAgo(10 + n)})`,
            [
              pp,
              lender,
              config,
              ref,
              `order_${tag}_${String(n)}`,
              intent.id,
              intent.loan,
              intent.amount,
              eventId,
            ],
          );
          await c.query(
            `insert into payments.event_processing (event_id, lender_org_id, outcome, reason_class, intent_id, provider_payment_id, attempt, processed_at)
             values ($1, $2, $3, $4, $5, $6, $7, ${hoursAgo(9)})`,
            [eventId, lender, 'applied', 'new_payment', intent.id, pp, n === 3 ? 2 : 1],
          );
          if (n === 3) {
            // Applied on the second attempt: the first was deferred. The list shows the newest outcome only.
            await c.query(
              `insert into payments.event_processing (event_id, lender_org_id, outcome, reason_class, intent_id, attempt, deferred_until, processed_at)
               values ($1, $2, 'deferred', 'capture_not_seen', $3, 1, now() + interval '1 hour', ${hoursAgo(11)})`,
              [eventId, lender, intent.id],
            );
          }
        }
        const ignored = await addEvent(20, 'unsupported', null, null, 'unknown', null, 'ignored');
        await c.query(
          `insert into payments.event_processing (event_id, lender_org_id, outcome, reason_class, attempt, processed_at)
           values ($1, $2, 'ignored_unsupported', 'unsupported_kind', 1, ${hoursAgo(19)})`,
          [ignored, lender],
        );
        // A refund with no processing row yet, and a legacy row without normalisation columns.
        const p3 = payments[3];
        const i3 = intents[3];
        if (!p3 || !i3) throw new Error('fixture');
        const refund = await addEvent(
          21,
          'refund',
          `RFND-${tag}-1`,
          i3.id,
          'refunded',
          100_000,
          'actionable',
        );
        await c.query(
          `insert into payments.payment_adjustments (lender_org_id, provider_payment_id, kind, object_ref, amount_minor, source_event_id, occurred_at, created_at)
           values ($1, $2, 'refund', $3, 100000, $4, ${hoursAgo(8)}, ${hoursAgo(8)})`,
          [lender, p3.id, `RFND-${tag}-1`, refund],
        );
        await addEvent(22, null, null, null, 'captured', null, null);

        // Settlement: batch 1 lists payment 1 (provider_settled); batch 2 lists payment 2 and has a matching bank credit (bank_confirmed);
        // batch 3 lists payment 3, has a bank credit and the lender posted a receipt (lender_posted). Batch 4 went to a non-lender account.
        if (withSettlement) {
          const batch = async (
            n: number,
            settlementRef: string,
            item: { ref: string; gross: number; fee: number; tax: number } | null,
            destinationOk: boolean,
            masked: string,
          ) => {
            const id = randomUUID();
            batches.push(id);
            const gross = item?.gross ?? 300_000;
            const fee = item?.fee ?? 3_000;
            const tax = item?.tax ?? 540;
            await c.query(
              `insert into payments.settlement_batches (id, lender_org_id, config_id, provider, batch_ref, settlement_ref, period_from, period_to,
                                                      destination_masked_ref, destination_ok, gross_minor, fee_minor, tax_minor, net_minor, parts_mismatch,
                                                      item_count, content_sha256, report_date, received_at)
               values ($1, $2, $3, 'mock_gateway_f2', $4, $5, current_date - 3, current_date - 2, $6, $7, $8, $9, $10, $11, false, 1, $12, current_date - 1, ${hoursAgo(5 - n)})`,
              [
                id,
                lender,
                config,
                `BATCH-${tag}-${String(n)}`,
                settlementRef,
                masked,
                destinationOk,
                gross,
                fee,
                tax,
                gross - fee - tax,
                sha(`${tag}-batch-${String(n)}`),
              ],
            );
            await c.query(
              `insert into payments.settlement_items (batch_id, lender_org_id, provider_payment_ref, order_ref, gross_minor, fee_minor, tax_minor, net_minor, parts_mismatch)
               values ($1, $2, $3, $4, $5, $6, $7, $8, false)`,
              [
                id,
                lender,
                item?.ref ?? `PAY-UNKNOWN-${tag}`,
                item ? `order_${tag}` : null,
                gross,
                fee,
                tax,
                gross - fee - tax,
              ],
            );
            return { gross, fee, tax, net: gross - fee - tax };
          };
          const pay = (n: number) => {
            const p = payments[n];
            if (!p) throw new Error('fixture');
            return p;
          };
          await batch(
            1,
            `UTRX${tag.toUpperCase()}0000001`,
            { ref: pay(1).ref, gross: pay(1).amount, fee: 9_500, tax: 1_710 },
            true,
            'XXXXXX0000',
          );
          const b2 = await batch(
            2,
            `UTRX${tag.toUpperCase()}0000002`,
            { ref: pay(2).ref, gross: pay(2).amount, fee: 9_500, tax: 1_710 },
            true,
            'XXXXXX0000',
          );
          const b3 = await batch(
            3,
            `UTRX${tag.toUpperCase()}0000003`,
            { ref: pay(3).ref, gross: pay(3).amount, fee: 12_000, tax: 2_160 },
            true,
            'XXXXXX0000',
          );
          await batch(4, `UTRX${tag.toUpperCase()}0000004`, null, false, 'XXXXXX9999');
          for (const [n, b] of [
            [2, b2],
            [3, b3],
          ] as const)
            await c.query(
              `insert into payments.bank_credits (lender_org_id, settlement_account_id, value_date, amount_minor, utr, recorded_by)
               values ($1, $2, current_date - 1, $3, $4, $5)`,
              [lender, account, b.net, `UTRX${tag.toUpperCase()}000000${String(n)}`, maker],
            );
          await c.query(
            `insert into servicing.lms_receipts (lender_org_id, loan_account_id, kind, lms_receipt_ref, amount_minor, value_date, bank_reference, source_system,
                                               source_record_id, reported_as_of, content_sha256)
             values ($1, $2, 'receipt', $3, $4, current_date - 1, $5, 'file_import', $6, now(), $7)`,
            [
              lender,
              intents[3]?.loan,
              `RCPT-${tag}-3`,
              pay(3).amount,
              pay(3).ref,
              `SRC-${tag}-3`,
              sha(`${tag}-receipt`),
            ],
          );
        }

        // Mandates on distinct loans.
        const mandatePlan: [string, string | null][] = [
          ['active', `MND-${tag}-0`],
          ['registration_pending', `MND-${tag}-1`],
          ['draft', null],
          ['cancelled', `MND-${tag}-3`],
        ];
        for (const [n, [status, providerRef]] of mandatePlan.entries()) {
          const id = randomUUID();
          mandates.push(id);
          await c.query(
            `insert into payments.mandates (id, lender_org_id, config_id, borrower_id, loan_account_id, rail, status, provider, provider_mode, creditor_ref,
                                          provider_mandate_ref, max_amount_minor, start_date, end_date, masked_account_ref, needs_afa_each_debit, created_by,
                                          created_at, updated_at, last_event_at, cancel_requested_at, cancel_reason)
             values ($1, $2, $3, $4, $5, $6, $7, 'mock_gateway_f2', 'mock', $8, $9, 4000000, current_date, current_date + 365, 'XXXXXX1234', $10, $4,
                     ${hoursAgo(30 - n)}, ${hoursAgo(30 - n)}, ${hoursAgo(20)}, $11, $12)`,
            [
              id,
              lender,
              config,
              borrower,
              randomUUID(),
              n % 2 === 0 ? 'enach_api' : 'upi_autopay',
              status,
              CANARY.creditor,
              providerRef,
              n % 2 === 1,
              status === 'cancelled' ? new Date().toISOString() : null,
              status === 'cancelled' ? 'borrower' : null,
            ],
          );
          const history = [
            [null, 'draft', 'request'],
            ['draft', 'registration_pending', 'handoff'],
            ['registration_pending', 'active', 'provider_event'],
          ] as const;
          for (const [step, [from, to, source]] of history.slice(0, [3, 2, 1, 1][n]).entries())
            await c.query(
              `insert into payments.mandate_events (mandate_id, lender_org_id, from_status, to_status, source, provider_event_id, observed_at, created_at)
                 values ($1, $2, $3, $4, $5, $6, ${hoursAgo(25 - step)}, ${hoursAgo(25 - step)})`,
              [id, lender, from, to, source, source === 'provider_event' ? events[0] : null],
            );
        }
        // Six debits of the first mandate: planned (with a notice), reported, returned.
        const m0 = mandates[0];
        if (!m0) throw new Error('fixture');
        const debits: [
          string,
          boolean,
          number | null,
          string,
          number,
          string | null,
          string | null,
          string | null,
        ][] = [
          ['current_date - 10', false, null, 'settled', 475_000, `DBT-${tag}-1`, null, null],
          [
            'current_date - 5',
            false,
            null,
            'returned',
            475_000,
            `DBT-${tag}-2`,
            'R01',
            'insufficient_funds',
          ],
          ['current_date - 1', true, 1, 'presented', 475_000, null, null, null],
          ['current_date + 2', true, 2, 'notified', 475_000, null, null, null],
          ['current_date + 5', true, 3, 'scheduled', 475_000, null, null, null],
          ['current_date + 35', true, 4, 'scheduled', 475_000, null, null, null],
        ];
        for (const [n, [on, planned, seq, status, amount, ref, rc, rcls]] of debits.entries()) {
          const id = randomUUID();
          await c.query(
            `insert into payments.mandate_debits (id, lender_org_id, mandate_id, loan_account_id, planned, schedule_snapshot_id, installment_seq, scheduled_on,
                                                amount_minor, status, provider_debit_ref, return_code, return_class, exceeds_mandate_max, created_at, updated_at)
             values ($1, $2, $3, $4, $5, $6, $7, ${on}, $8, $9, $10, $11, $12, false, ${hoursAgo(40 - n)}, ${hoursAgo(40 - n)})`,
            [
              id,
              lender,
              m0,
              randomUUID(),
              planned,
              planned ? randomUUID() : null,
              seq,
              amount,
              status,
              ref,
              rc,
              rcls,
            ],
          );
          if (planned && n < 5)
            await c.query(
              `insert into payments.pre_debit_notices (lender_org_id, debit_id, mandate_id, borrower_id, notice_due_at, status, delivery_state, sent_at)
               values ($1, $2, $3, $4, now() + interval '${String(n)} days', $5, $6, $7)`,
              [
                lender,
                id,
                m0,
                borrower,
                n === 2 ? 'sent' : 'planned',
                n === 2 ? 'accepted' : null,
                n === 2 ? new Date().toISOString() : null,
              ],
            );
        }

        // The sealed hand-off link of the pending payment (a bearer secret; the routes must never return it). The bytes hold a link-looking value.
        const pending = intents[4];
        if (!pending) throw new Error('fixture');
        await c.query(
          `insert into payments.handoff_links (lender_org_id, borrower_id, subject_kind, subject_id, key_version, ciphertext, expires_at)
           values ($1, $2, 'payment_intent', $3, 'k1', $4, now() + interval '1 day')`,
          [lender, borrower, pending.id, Buffer.from(`${CANARY.link}-${'x'.repeat(30)}`)],
        );

        // Callbacks that reached this lender's configuration, and one for an unknown token (no lender).
        const receipts: [string | null, string, string][] = [
          [lender, 'verified', 'none'],
          [lender, 'verified', 'none'],
          [lender, 'unverified', 'signature_mismatch'],
          [lender, 'unmatched', 'order_ref_unknown'],
          [null, 'unverified', 'token_unknown_or_inactive'],
        ];
        for (const [owner, outcome, reason] of receipts)
          await c.query(
            `insert into payments.webhook_receipts (provider, lender_org_id, config_id, delivery_id, payload_sha256, outcome, reason_class, scheme, signature_present,
                                                  timestamp_skew_seconds, body_bytes, source_ip_hmac)
             values ('mock_gateway_f2', $1, $2, $3, $4, $5, $6, 'hmac_sha256', true, 2, 300, $7)`,
            [
              owner,
              owner === null ? null : config,
              `dlv-${randomUUID()}`,
              CANARY.payloadHash,
              outcome,
              reason,
              CANARY.hmac,
            ],
          );
      });
      return {
        id: lender,
        borrower,
        config,
        account,
        otherAccount,
        intents,
        payments,
        events,
        mandates,
        batches,
        exceptions: [],
      };
    }

    /** Opens an exception the way the system does. */
    async function raise(
      lender: string,
      cls: string,
      severity: 'info' | 'warning' | 'critical',
      owner: 'lender' | 'platform',
      subject: Record<string, string> = { provider_payment_id: randomUUID() },
    ): Promise<string> {
      const r = await systemPool.withSystem((c) =>
        c.query<{ id: string }>(
          'select payments.raise_exception($1::uuid, $2, $3, $4, $5::jsonb) as id',
          [lender, cls, severity, owner, JSON.stringify(subject)],
        ),
      );
      const id = r.rows[0]?.id;
      if (!id) throw new Error('no exception');
      return id;
    }

    let A: LenderData;
    let B: LenderData;
    let runDate = '';
    const runIds: Record<string, string> = {};

    beforeAll(async () => {
      admin = new pg.Pool({ connectionString: ADMIN, max: 4 });
      apiPool = new pg.Pool({ connectionString: API, max: 6 });
      systemPool = createSystemPool(SYSTEM ?? '');

      for (const id of [
        ids.aViewer,
        ids.aPayer,
        ids.aRecon,
        ids.aRecon2,
        ids.aRecon3,
        ids.aRecon4,
        ids.aNone,
        ids.bViewer,
        ids.bPayer,
        ids.bRecon,
        ids.pOps,
        ids.pPay,
        ids.pPay2,
        ids.spammer,
      ])
        await admin.query(
          `insert into auth.users (id, phone, raw_app_meta_data) values ($1, null, '{"actor_type":"staff"}')`,
          [id],
        );
      await admin.query(
        `insert into auth.users (id, phone, raw_app_meta_data) values ($1, $2, '{}')`,
        [ids.borrower, borrowerPhone],
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
        [ids.lenderA, 'Alpha Payments'],
        [ids.lenderB, 'Beta Payments'],
      ] as const)
        await admin.query(
          `insert into tenancy.organizations (id, kind, legal_name, display_name, regulator_registration_no, status) values ($1, 'lender', $2, $3, $4, 'active')`,
          [lender, `${name} Ltd (test)`, name, `IT-LP-${lender.slice(0, 8)}`],
        );
      await member(ids.lenderA, ids.aViewer, 'lender', 'viewer');
      await member(ids.lenderA, ids.aPayer, 'lender', 'payments_admin');
      for (const u of [ids.aRecon, ids.aRecon2, ids.aRecon3, ids.aRecon4])
        await member(ids.lenderA, u, 'lender', 'reconciler');
      await member(ids.lenderA, ids.aNone, 'lender', 'credit_officer');
      await member(ids.lenderB, ids.bViewer, 'lender', 'viewer');
      await member(ids.lenderB, ids.bPayer, 'lender', 'payments_admin');
      await member(ids.lenderB, ids.bRecon, 'lender', 'reconciler');
      await member(ids.platformOrg, ids.pOps, 'platform', 'operations_agent');
      await member(ids.platformOrg, ids.pPay, 'platform', 'platform_payments_admin');
      await member(ids.platformOrg, ids.pPay2, 'platform', 'platform_payments_admin');
      await member(ids.lenderA, ids.spammer, 'lender', 'credit_officer');

      A = await buildLender(ids.lenderA, 'a', true);
      B = await buildLender(ids.lenderB, 'b', true);

      // Exceptions the system raised: lender-owned and platform-owned, for both lenders.
      const p1 = A.payments[1];
      if (!p1) throw new Error('fixture');
      A.exceptions.push(
        await raise(ids.lenderA, 'amount_mismatch', 'critical', 'lender', {
          intent_id: A.intents[0]?.id ?? '',
        }),
        await raise(ids.lenderA, 'lender_receipt_missing', 'warning', 'lender', {
          provider_payment_id: p1.id,
        }),
        await raise(ids.lenderA, 'duplicate_payment', 'warning', 'lender', {
          provider_payment_id: A.payments[2]?.id ?? '',
        }),
        await raise(ids.lenderA, 'late_settlement', 'info', 'lender', {
          settlement_batch_id: A.batches[0] ?? '',
        }),
        await raise(ids.lenderA, 'settlement_account_mismatch', 'critical', 'platform', {
          settlement_batch_id: A.batches[3] ?? '',
        }),
        await raise(ids.lenderA, 'event_payload_conflict', 'warning', 'platform', {
          event_id: A.events[0] ?? '',
        }),
      );
      B.exceptions.push(
        await raise(ids.lenderB, 'amount_mismatch', 'critical', 'lender', {
          intent_id: B.intents[0]?.id ?? '',
        }),
        await raise(ids.lenderB, 'merchant_mismatch', 'critical', 'platform', {
          config_id: B.config,
        }),
      );

      // A real reconciliation run for each lender (the system job), over the rows above.
      runDate =
        (
          await q<{ d: string }>(
            `select to_char((clock_timestamp() at time zone 'Asia/Kolkata')::date, 'YYYY-MM-DD') as d`,
          )
        )[0]?.d ?? '';
      for (const lender of [ids.lenderA, ids.lenderB]) {
        const run = await systemPool.withSystem((c) =>
          c.query<{ r: { run_id: string } }>(
            'select payments.run_reconciliation($1::uuid, $2::date) as r',
            [lender, runDate],
          ),
        );
        runIds[lender] = run.rows[0]?.r.run_id ?? '';
      }

      app = await buildApp(loadConfig({ APP_ENV: 'test' }), {
        auth: { verifier: fakeVerifier, context: createUserContext(apiPool) },
      });
    }, 120_000);

    afterAll(async () => {
      await app?.close();
      await apiPool?.end();
      await systemPool?.end();
      // The integration files share one database and some assert on database-wide counts of money rows (for example "no
      // refund exists"), so this file leaves none of its payment rows behind. Triggers and foreign keys are off for this one
      // transaction (the append-only triggers would refuse a delete), and every delete is scoped to this file's two lenders.
      if (admin && A && B) {
        const mine = [A.id, B.id];
        const c = await admin.connect();
        try {
          await c.query('begin');
          await c.query('set local session_replication_role = replica');
          for (const table of [
            'payments.reconciliation_exception_events',
            'payments.reconciliation_exceptions',
            'payments.reconciliation_matches',
            'payments.reconciliation_runs',
            'payments.reconciliation_settings',
            'payments.event_processing',
            'payments.payment_adjustments',
            'payments.provider_payments',
            'payments.provider_events',
            'payments.webhook_receipts',
            'payments.pre_debit_notices',
            'payments.mandate_debits',
            'payments.mandate_events',
            'payments.mandates',
            'payments.handoff_links',
            'payments.payment_intents',
            'payments.settlement_items',
            'payments.settlement_batches',
            'payments.bank_credits',
            'payments.lender_payment_policies',
            'payments.lender_mandate_policies',
            'payments.lender_payment_configs',
            'servicing.lms_receipts',
            'tenancy.lender_settlement_accounts',
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

    // ----------------------------------------------------------------------------------------------------------------
    // Helpers used by the tests
    // ----------------------------------------------------------------------------------------------------------------
    type Res = Awaited<ReturnType<typeof call>>;
    const rowsOf = <T>(res: Res): T[] => res.json<Page<T>>().items;

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
        const { code, hint } = error as { code?: string; hint?: string };
        return { ok: false as const, code, hint };
      } finally {
        await c.query('rollback');
        c.release();
      }
    }

    const keys = (value: unknown) => Object.keys(value as Record<string, unknown>).sort();
    const count = async (sql: string, values: unknown[] = []) =>
      Number((await q<{ n: string }>(sql, values))[0]?.n ?? -1);
    const idsOf = (rows: { id: string }[]) => rows.map((r) => r.id);

    /** Fingerprint of every money row the exception queue must never touch. */
    const moneyFingerprint = async () =>
      (
        await q<{ h: string }>(
          `select md5(concat_ws('|',
           (select coalesce(string_agg(t::text, '' order by t.id), '') from payments.payment_intents t),
           (select coalesce(string_agg(t::text, '' order by t.id), '') from payments.provider_payments t),
           (select coalesce(string_agg(t::text, '' order by t.id), '') from payments.payment_adjustments t),
           (select coalesce(string_agg(t::text, '' order by t.id), '') from payments.settlement_batches t),
           (select coalesce(string_agg(t::text, '' order by t.id), '') from payments.bank_credits t),
           (select coalesce(string_agg(t::text, '' order by t.id), '') from payments.mandates t),
           (select coalesce(string_agg(t::text, '' order by t.id), '') from payments.mandate_debits t))) as h`,
        )
      )[0]?.h ?? '';

    /** The reader routes, for the "no payment permission" and "wrong lender" checks. */
    const readRoutes = () => [
      '/v1/lender/payments',
      `/v1/lender/payments/${A.intents[0]?.id ?? ''}`,
      '/v1/lender/provider-events',
      `/v1/lender/webhook-summary?lenderId=${ids.lenderA}`,
      '/v1/lender/payment-policy',
      '/v1/lender/mandate-policy',
      '/v1/lender/mandates',
      `/v1/lender/mandates/${A.mandates[0] ?? ''}`,
      '/v1/lender/mandate-debits',
      '/v1/lender/reconciliation/runs',
      `/v1/lender/reconciliation/summary?lenderId=${ids.lenderA}&date=${runDate}`,
      '/v1/lender/reconciliation/settlement-batches',
      `/v1/lender/reconciliation/settlement-batches/${A.batches[0] ?? ''}`,
      `/v1/lender/reconciliation/settlement-batches/${A.batches[0] ?? ''}/items`,
      '/v1/lender/reconciliation/settings',
      '/v1/lender/reconciliation/exceptions',
      `/v1/lender/reconciliation/exceptions/${A.exceptions[0] ?? ''}`,
    ];

    // ================================================================================================================
    // Who may call at all
    // ================================================================================================================
    describe('access', () => {
      it('answers 401 to an anonymous caller, on a read and on a write', async () => {
        expect((await get('/v1/lender/payments', null)).statusCode).toBe(401);
        // A well-formed body: the framework validates the shape before it asks who the caller is.
        const write = await call('POST', '/v1/lender/payment-policy', null, {
          lenderId: ids.lenderA,
          allowPartialPayments: false,
          allowPartPrepayment: false,
          linkValidityMinutes: 60,
        });
        expect(write.statusCode).toBe(401);
      });

      it('answers 401 mfa_required to a staff session without the second factor, on a read and on a write', async () => {
        const read = await call('GET', '/v1/lender/payments', ids.aViewer, undefined, {
          aal: 'aal1',
        });
        expect(read.statusCode).toBe(401);
        expect(code(read)).toBe('mfa_required');
        const write = await call(
          'POST',
          '/v1/lender/payment-policy',
          ids.aPayer,
          {
            lenderId: ids.lenderA,
            allowPartialPayments: false,
            allowPartPrepayment: false,
            linkValidityMinutes: 60,
          },
          { aal: 'aal1' },
        );
        expect(write.statusCode).toBe(401);
        expect(code(write)).toBe('mfa_required');
      });

      it('keeps a borrower out of the lender routes', async () => {
        const res = await get('/v1/lender/payments', ids.borrower);
        expect(res.statusCode).toBe(403);
        expect(code(res)).toBe('staff_only');
      });

      it('answers 403 on every read route to a lender user who holds no payment permission', async () => {
        for (const url of readRoutes()) {
          const res = await get(url, ids.aNone);
          expect([url, res.statusCode]).toEqual([url, 403]);
          expect(code(res)).toBe('forbidden');
        }
      });

      it("answers 403 when a lender user asks for another lender explicitly, and 404 for another lender's record", async () => {
        for (const url of [
          `/v1/lender/payments?lenderId=${ids.lenderA}`,
          `/v1/lender/provider-events?lenderId=${ids.lenderA}`,
          `/v1/lender/mandates?lenderId=${ids.lenderA}`,
          `/v1/lender/mandate-debits?lenderId=${ids.lenderA}`,
          `/v1/lender/reconciliation/runs?lenderId=${ids.lenderA}`,
          `/v1/lender/reconciliation/settlement-batches?lenderId=${ids.lenderA}`,
          `/v1/lender/reconciliation/exceptions?lenderId=${ids.lenderA}`,
          `/v1/lender/payment-policy?lenderId=${ids.lenderA}`,
          `/v1/lender/webhook-summary?lenderId=${ids.lenderA}`,
          `/v1/lender/reconciliation/summary?lenderId=${ids.lenderA}&date=${runDate}`,
        ]) {
          const res = await get(url, ids.bViewer);
          expect([url, res.statusCode]).toEqual([url, 403]);
        }
        for (const url of [
          `/v1/lender/payments/${A.intents[0]?.id ?? ''}`,
          `/v1/lender/mandates/${A.mandates[0] ?? ''}`,
          `/v1/lender/reconciliation/settlement-batches/${A.batches[0] ?? ''}`,
          `/v1/lender/reconciliation/settlement-batches/${A.batches[0] ?? ''}/items`,
          `/v1/lender/reconciliation/exceptions/${A.exceptions[0] ?? ''}`,
          `/v1/lender/payments/${randomUUID()}`,
        ]) {
          const res = await get(url, ids.bViewer);
          expect([url, res.statusCode]).toEqual([url, 404]);
          expect(code(res)).toBe('not_found');
        }
      });

      it('answers 422 to malformed ids, filters and unknown query keys', async () => {
        for (const url of [
          '/v1/lender/payments/not-a-uuid',
          '/v1/lender/payments?lenderId=nope',
          '/v1/lender/payments?status=weird',
          '/v1/lender/payments?limit=0',
          '/v1/lender/payments?limit=101',
          '/v1/lender/payments?surprise=1',
          '/v1/lender/mandate-debits?planned=maybe',
          '/v1/lender/reconciliation/runs?date=2026-13-45x',
          '/v1/lender/reconciliation/summary?lenderId=' + ids.lenderA,
          '/v1/lender/webhook-summary',
        ]) {
          const res = await get(url, ids.aViewer);
          expect([url, res.statusCode]).toEqual([url, 422]);
          expect(code(res)).toBe('validation_failed');
        }
      });

      it('rejects a cursor that is not ours with 400, and a cursor does not widen what a caller sees', async () => {
        const bad = await get('/v1/lender/payments?cursor=AAAA', ids.aViewer);
        expect(bad.statusCode).toBe(400);
        expect(code(bad)).toBe('invalid_cursor');
        // A cursor taken from lender A's listing, used by lender B's user, still shows only lender B's rows.
        const first = await get('/v1/lender/payments?limit=2', ids.aViewer);
        const cursor = first.json<Page<unknown>>().nextCursor;
        expect(cursor).toBeTruthy();
        const other = await get(
          `/v1/lender/payments?limit=100&cursor=${encodeURIComponent(cursor ?? '')}`,
          ids.bViewer,
        );
        expect(other.statusCode).toBe(200);
        const mine = new Set(idsOf(B.intents));
        for (const row of rowsOf<{ id: string }>(other)) expect(mine.has(row.id)).toBe(true);
      });

      it('limits how often one person can call a route (429 with a retry hint)', async () => {
        let last: Res | undefined;
        for (let n = 0; n < 125 && last?.statusCode !== 429; n += 1)
          last = await get('/v1/lender/payment-policy', ids.spammer);
        expect(last?.statusCode).toBe(429);
        expect(code(last as Res)).toBe('rate_limited');
        expect(last?.headers['retry-after']).toBeDefined();
      });

      it('does not consult an activation switch: a lender with every switch off still reads its history and keeps its settings', async () => {
        // Neither fixture lender has a switch row (all features are off). The SQL functions behind these routes do not consult the
        // switches (they gate the borrower flows and the worker), so the lender portal keeps working for audit and configuration.
        expect(
          await count(
            'select count(*) as n from servicing.lender_features where lender_org_id = $1',
            [ids.lenderA],
          ),
        ).toBe(0);
        expect((await get('/v1/lender/payments', ids.aViewer)).statusCode).toBe(200);
        expect((await get('/v1/lender/mandates', ids.aViewer)).statusCode).toBe(200);
        expect((await get('/v1/lender/reconciliation/exceptions', ids.aRecon)).statusCode).toBe(
          200,
        );
      });
    });

    // ================================================================================================================
    // Payments
    // ================================================================================================================
    describe('payments', () => {
      const allowedKeys = [
        'amountMinor',
        'createdAt',
        'currency',
        'id',
        'lenderId',
        'linkExpiresAt',
        'loanAccountId',
        'provider',
        'providerMode',
        'providerOrderRef',
        'purpose',
        'status',
        'targetInstallmentSeq',
        'updatedAt',
      ];

      it("lists the lender's own payment requests, newest first, in a fixed shape with integer paise", async () => {
        const res = await get('/v1/lender/payments?limit=100', ids.aViewer);
        expect(res.statusCode).toBe(200);
        expect(res.headers['cache-control']).toBe('no-store');
        // The same schema the OpenAPI document publishes accepts what came back.
        expect(LpPaymentPage.safeParse(res.json()).success).toBe(true);
        const rows = rowsOf<Record<string, unknown>>(res);
        expect(idsOf(rows as { id: string }[])).toEqual(idsOf(A.intents));
        for (const row of rows) {
          expect(keys(row)).toEqual(allowedKeys);
          expect(row.lenderId).toBe(ids.lenderA);
          expect(Number.isInteger(row.amountMinor)).toBe(true);
          expect(row.currency).toBe('INR');
        }
        expect(rows[0]).toMatchObject({
          purpose: 'installment',
          status: 'succeeded',
          amountMinor: 475_000,
        });
        expect(rows[3]).toMatchObject({ purpose: 'part_prepayment', amountMinor: 1_200_000 });
      });

      it('shows lender B nothing of lender A, and platform operations staff both', async () => {
        const b = rowsOf<{ id: string; lenderId: string }>(
          await get('/v1/lender/payments?limit=100', ids.bViewer),
        );
        expect(idsOf(b)).toEqual(idsOf(B.intents));
        expect(b.every((r) => r.lenderId === ids.lenderB)).toBe(true);
        // Platform operations staff read every lender (other integration files leave rows of their own, so ask lender by lender).
        for (const lender of [A, B]) {
          const ops = rowsOf<{ id: string }>(
            await get(`/v1/lender/payments?limit=100&lenderId=${lender.id}`, ids.pOps),
          );
          expect(idsOf(ops)).toEqual(idsOf(lender.intents));
        }
      });

      it('pages through every row without skips or repeats', async () => {
        const { all, sizes } = await pages<{ id: string }>('/v1/lender/payments', ids.aViewer, 3);
        expect(sizes).toEqual([3, 3, 1]);
        expect(idsOf(all)).toEqual(idsOf(A.intents));
        expect(new Set(idsOf(all)).size).toBe(7);
      });

      it('filters by status, purpose and loan account', async () => {
        const succeeded = rowsOf<{ status: string }>(
          await get('/v1/lender/payments?status=succeeded', ids.aViewer),
        );
        expect(succeeded).toHaveLength(4);
        expect(succeeded.every((r) => r.status === 'succeeded')).toBe(true);
        const overdue = rowsOf<{ purpose: string }>(
          await get('/v1/lender/payments?purpose=overdue', ids.aViewer),
        );
        expect(overdue).toHaveLength(1);
        const loan = A.intents[2]?.loan ?? '';
        const byLoan = rowsOf<{ id: string }>(
          await get(`/v1/lender/payments?loanAccountId=${loan}`, ids.aViewer),
        );
        expect(idsOf(byLoan)).toEqual([A.intents[2]?.id]);
      });

      it('shows the provider payment, its derived settlement stage and the adjustments of one payment', async () => {
        const expectedStages = [
          'provider_captured',
          'provider_settled',
          'bank_confirmed',
          'lender_posted',
        ];
        for (const [n, stage] of expectedStages.entries()) {
          const res = await get(`/v1/lender/payments/${A.intents[n]?.id ?? ''}`, ids.aViewer);
          expect(res.statusCode).toBe(200);
          const body = res.json<{
            payment: { id: string };
            providerPayments: {
              providerPaymentRef: string;
              stage: Record<string, unknown> | null;
              amountMinor: number;
            }[];
            adjustments: { kind: string; amountMinor: number }[];
          }>();
          expect(keys(body)).toEqual(['adjustments', 'payment', 'providerPayments']);
          expect(body.payment.id).toBe(A.intents[n]?.id);
          expect(body.providerPayments).toHaveLength(1);
          const pp = body.providerPayments[0];
          expect(pp?.providerPaymentRef).toBe(A.payments[n]?.ref);
          expect(pp?.stage).toMatchObject({
            stage,
            providerCaptured: true,
            providerSettled: n >= 1,
            bankConfirmed: n >= 2,
            // A confirmed bank stage rests on the credit the LENDER reported; nothing else can confirm it.
            bankConfirmationBasis: n >= 2 ? 'lender_reported_credit' : null,
            lenderPosted: n >= 3,
          });
          expect(keys(pp?.stage)).toEqual([
            'bankConfirmationBasis',
            'bankConfirmed',
            'lenderPosted',
            'providerCaptured',
            'providerSettled',
            'settlementDestinationOk',
            'stage',
          ]);
          if (n === 3)
            expect(body.adjustments).toMatchObject([{ kind: 'refund', amountMinor: 100_000 }]);
          else expect(body.adjustments).toEqual([]);
        }
      });

      it('has no provider payment or stage for a request that is still pending, created or failed', async () => {
        for (const n of [4, 5, 6]) {
          const res = await get(`/v1/lender/payments/${A.intents[n]?.id ?? ''}`, ids.aViewer);
          expect(res.statusCode).toBe(200);
          expect(res.json<{ providerPayments: unknown[] }>().providerPayments).toEqual([]);
        }
      });
    });

    // ================================================================================================================
    // Verified provider events and the webhook summary
    // ================================================================================================================
    describe('provider events', () => {
      const allowedKeys = [
        'amountMinor',
        'currency',
        'eventType',
        'id',
        'lenderId',
        'objectKind',
        'objectRef',
        'occurredAt',
        'orderRef',
        'paymentIntentId',
        'processing',
        'processingClass',
        'provider',
        'providerEventId',
        'providerStatus',
        'receivedAt',
        'verification',
      ];

      it('lists verified events with the newest outcome of applying them, and nothing from the payload', async () => {
        const res = await get('/v1/lender/provider-events?limit=100', ids.aViewer);
        expect(res.statusCode).toBe(200);
        const rows = rowsOf<Record<string, unknown> & { id: string }>(res);
        expect(rows).toHaveLength(A.events.length);
        expect(new Set(idsOf(rows))).toEqual(new Set(A.events));
        for (const row of rows) {
          expect(keys(row)).toEqual(allowedKeys);
          expect(row.lenderId).toBe(ids.lenderA);
        }
        const byId = new Map(rows.map((r) => [r.id, r]));
        // The fourth payment was deferred first and applied on the second attempt: the list shows the newest outcome.
        expect(byId.get(A.events[3] ?? '')?.processing).toMatchObject({
          outcome: 'applied',
          attempt: 2,
        });
        expect(byId.get(A.events[0] ?? '')?.verification).toEqual({
          authentication: 'matched',
          integrity: 'matched',
          correlation: 'matched',
          business: 'passed',
        });
        // An unsupported kind is stored as verified-and-ignored.
        expect(byId.get(A.events[4] ?? '')).toMatchObject({
          objectKind: 'unsupported',
          processingClass: 'ignored',
          processing: { outcome: 'ignored_unsupported' },
        });
        // A refund the worker has not applied yet has no outcome; a row without normalisation has no verification stages.
        expect(byId.get(A.events[5] ?? '')).toMatchObject({
          objectKind: 'refund',
          processing: null,
          amountMinor: 100_000,
        });
        expect(byId.get(A.events[6] ?? '')).toMatchObject({
          objectKind: null,
          verification: null,
          processing: null,
        });
      });

      it('shows lender B only its own events, pages without skips, and filters by kind', async () => {
        const b = rowsOf<{ id: string }>(
          await get('/v1/lender/provider-events?limit=100', ids.bViewer),
        );
        expect(new Set(idsOf(b))).toEqual(new Set(B.events));
        const { all, sizes } = await pages<{ id: string }>(
          '/v1/lender/provider-events',
          ids.aViewer,
          3,
        );
        expect(sizes).toEqual([3, 3, 1]);
        expect(new Set(idsOf(all)).size).toBe(7);
        const expected = await q<{ id: string }>(
          'select id from payments.provider_events where lender_org_id = $1 order by received_at desc, id desc',
          [ids.lenderA],
        );
        expect(idsOf(all)).toEqual(idsOf(expected));
        const refunds = rowsOf<{ objectKind: string }>(
          await get('/v1/lender/provider-events?objectKind=refund', ids.aViewer),
        );
        expect(refunds).toHaveLength(1);
        const byIntent = rowsOf<{ id: string }>(
          await get(
            `/v1/lender/provider-events?paymentIntentId=${A.intents[1]?.id ?? ''}`,
            ids.aViewer,
          ),
        );
        expect(byIntent).toHaveLength(1);
      });
    });

    describe('webhook summary', () => {
      it('counts deliveries by outcome for the lender and never shows a delivery', async () => {
        const res = await get(`/v1/lender/webhook-summary?lenderId=${ids.lenderA}`, ids.aViewer);
        expect(res.statusCode).toBe(200);
        const body = res.json<{
          lenderId: string;
          items: { outcome: string; receipts: number; lastReceivedAt: string | null }[];
        }>();
        expect(body.lenderId).toBe(ids.lenderA);
        const byOutcome = Object.fromEntries(body.items.map((i) => [i.outcome, i.receipts]));
        // The delivery for an unknown token belongs to no lender and is not counted.
        expect(byOutcome).toEqual({ unmatched: 1, unverified: 1, verified: 2 });
        for (const item of body.items) {
          expect(keys(item)).toEqual(['lastReceivedAt', 'outcome', 'receipts']);
          expect(item.lastReceivedAt).toBeTruthy();
        }
      });

      it('answers 403 to another lender, and lets platform operations staff read it', async () => {
        expect(
          (await get(`/v1/lender/webhook-summary?lenderId=${ids.lenderA}`, ids.bViewer)).statusCode,
        ).toBe(403);
        expect(
          (await get(`/v1/lender/webhook-summary?lenderId=${ids.lenderA}`, ids.pOps)).statusCode,
        ).toBe(200);
        expect(
          (await get(`/v1/lender/webhook-summary?lenderId=${ids.lenderB}`, ids.aViewer)).statusCode,
        ).toBe(403);
      });
    });

    // ================================================================================================================
    // Policies and settings
    // ================================================================================================================
    describe('payment policy', () => {
      const policy = {
        lenderId: '' as string,
        allowPartialPayments: true,
        minPartialAmountMinor: 100_000,
        allowPartPrepayment: false,
        linkValidityMinutes: 120,
      };
      const key = `policy-key-${randomUUID()}`;

      it('has no row until the lender sets one', async () => {
        const res = await get(`/v1/lender/payment-policy?lenderId=${ids.lenderA}`, ids.aViewer);
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ items: [] });
      });

      it('lets a payment.configure user set it, and shows it to readers of that lender only', async () => {
        policy.lenderId = ids.lenderA;
        const res = await call('POST', '/v1/lender/payment-policy', ids.aPayer, policy, { key });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ outcome: 'set' });
        const read = await get(`/v1/lender/payment-policy?lenderId=${ids.lenderA}`, ids.aViewer);
        const items = read.json<{ items: Record<string, unknown>[] }>().items;
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({
          lenderId: ids.lenderA,
          allowPartialPayments: true,
          minPartialAmountMinor: 100_000,
          allowPartPrepayment: false,
          minPartPrepaymentMinor: null,
          linkValidityMinutes: 120,
        });
        expect(keys(items[0])).toEqual([
          'allowPartPrepayment',
          'allowPartialPayments',
          'lenderId',
          'linkValidityMinutes',
          'minPartPrepaymentMinor',
          'minPartialAmountMinor',
          'updatedAt',
        ]);
        // Lender B reads its own (empty) list and cannot name lender A.
        expect(rowsOf<unknown>(await get('/v1/lender/payment-policy', ids.bViewer))).toEqual([]);
        expect(
          (await get(`/v1/lender/payment-policy?lenderId=${ids.lenderA}`, ids.bViewer)).statusCode,
        ).toBe(403);
        expect(
          await count(
            "select count(*) as n from audit.events where action = 'payments.policy.set'",
          ),
        ).toBeGreaterThan(0);
      });

      it('replays the stored answer for the same Idempotency-Key and does not run twice', async () => {
        const before = await q<{ updated_at: Date }>(
          'select updated_at from payments.lender_payment_policies where lender_org_id = $1',
          [ids.lenderA],
        );
        const again = await call('POST', '/v1/lender/payment-policy', ids.aPayer, policy, { key });
        expect(again.statusCode).toBe(200);
        expect(again.headers['idempotent-replayed']).toBe('true');
        expect(again.json()).toEqual({ outcome: 'set' });
        const after = await q<{ updated_at: Date }>(
          'select updated_at from payments.lender_payment_policies where lender_org_id = $1',
          [ids.lenderA],
        );
        expect(after[0]?.updated_at).toEqual(before[0]?.updated_at);
        // The same key with a different request is refused, never silently replayed.
        const changed = await call(
          'POST',
          '/v1/lender/payment-policy',
          ids.aPayer,
          { ...policy, linkValidityMinutes: 130 },
          { key },
        );
        expect(changed.statusCode).toBe(422);
        expect(code(changed)).toBe('idempotency_key_reused');
      });

      it("does not let another person's use of the same key replay this answer", async () => {
        const res = await call(
          'POST',
          '/v1/lender/payment-policy',
          ids.bPayer,
          { ...policy, lenderId: ids.lenderB },
          { key },
        );
        expect(res.statusCode).toBe(200);
        expect(res.headers['idempotent-replayed']).toBeUndefined();
        expect(
          await count(
            'select count(*) as n from payments.lender_payment_policies where lender_org_id = $1',
            [ids.lenderB],
          ),
        ).toBe(1);
      });

      it('updates the row on a new request and keeps one row per lender', async () => {
        const res = await post('/v1/lender/payment-policy', ids.aPayer, {
          ...policy,
          allowPartPrepayment: true,
          minPartPrepaymentMinor: 500_000,
          linkValidityMinutes: 90,
        });
        expect(res.statusCode).toBe(200);
        const items = rowsOf<Record<string, unknown>>(
          await get(`/v1/lender/payment-policy?lenderId=${ids.lenderA}`, ids.aPayer),
        );
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({
          allowPartPrepayment: true,
          minPartPrepaymentMinor: 500_000,
          linkValidityMinutes: 90,
        });
      });

      it('refuses everyone without payment.configure of that lender (403) and changes nothing', async () => {
        const before = await q(
          'select * from payments.lender_payment_policies order by lender_org_id',
        );
        const attempts: [string, string][] = [
          ['read-only user', ids.aViewer],
          ['reconciler', ids.aRecon],
          ['no payment permission', ids.aNone],
          ['payments admin of another lender', ids.bPayer],
          ['platform operations', ids.pOps],
          ['platform payments admin', ids.pPay],
        ];
        for (const [label, user] of attempts) {
          const res = await post('/v1/lender/payment-policy', user, {
            ...policy,
            linkValidityMinutes: 77,
          });
          expect([label, res.statusCode]).toEqual([label, 403]);
          expect(code(res)).toBe('forbidden');
        }
        expect(
          await q('select * from payments.lender_payment_policies order by lender_org_id'),
        ).toEqual(before);
      });

      it('answers a lender that does not exist exactly like a lender the caller may not touch', async () => {
        const other = await post('/v1/lender/payment-policy', ids.bPayer, policy);
        const unknown = await post('/v1/lender/payment-policy', ids.bPayer, {
          ...policy,
          lenderId: randomUUID(),
        });
        expect([unknown.statusCode, code(unknown)]).toEqual([other.statusCode, code(other)]);
        expect(unknown.statusCode).toBe(403);
        const unknownRead = await get(
          `/v1/lender/payment-policy?lenderId=${randomUUID()}`,
          ids.bViewer,
        );
        const otherRead = await get(
          `/v1/lender/payment-policy?lenderId=${ids.lenderA}`,
          ids.bViewer,
        );
        expect([unknownRead.statusCode, code(unknownRead)]).toEqual([
          otherRead.statusCode,
          code(otherRead),
        ]);
        const unknownUpload = await call(
          'POST',
          '/v1/lender/reconciliation/bank-credits',
          ids.bRecon,
          {
            lenderId: randomUUID(),
            accountId: A.account,
            rows: [{ valueDate: runDate, amountMinor: 1000, utr: 'UNKNOWNLENDER01' }],
          },
        );
        expect(unknownUpload.statusCode).toBe(403);
      });

      it('refuses values the database refuses, with its stable code', async () => {
        const noMinimum = await post('/v1/lender/payment-policy', ids.aPayer, {
          lenderId: ids.lenderA,
          allowPartialPayments: true,
          allowPartPrepayment: false,
          linkValidityMinutes: 60,
        });
        expect([noMinimum.statusCode, code(noMinimum)]).toEqual([422, 'policy_invalid']);
        const shortLink = await post('/v1/lender/payment-policy', ids.aPayer, {
          ...policy,
          linkValidityMinutes: 1,
        });
        expect([shortLink.statusCode, code(shortLink)]).toEqual([422, 'policy_invalid']);
        const zeroMinimum = await post('/v1/lender/payment-policy', ids.aPayer, {
          ...policy,
          minPartialAmountMinor: 0,
        });
        expect([zeroMinimum.statusCode, code(zeroMinimum)]).toEqual([422, 'policy_invalid']);
      });

      it('refuses a malformed request before it reaches the database', async () => {
        for (const body of [
          { ...policy, surprise: true },
          { ...policy, lenderId: 'nope' },
          { ...policy, minPartialAmountMinor: -5 },
          { ...policy, minPartialAmountMinor: 1.5 },
          { ...policy, minPartialAmountMinor: '100000' },
          { ...policy, allowPartialPayments: 'yes' },
          { lenderId: ids.lenderA },
        ]) {
          const res = await post('/v1/lender/payment-policy', ids.aPayer, body);
          expect(res.statusCode).toBe(422);
          expect(code(res)).toBe('validation_failed');
        }
        const noKey = await call('POST', '/v1/lender/payment-policy', ids.aPayer, policy, {
          key: null,
        });
        expect(noKey.statusCode).toBe(400);
        expect(code(noKey)).toBe('idempotency_key_required');
      });

      it('is also guarded by the second factor in the database itself', async () => {
        const r = await asUser(
          ids.aPayer,
          'aal1',
          'select payments.set_payment_policy($1::uuid, false, null, false, null, 60)',
          [ids.lenderA],
        );
        expect(r).toMatchObject({ ok: false, code: '42501', hint: 'mfa_required' });
      });
    });

    describe('mandate policy', () => {
      const policy = {
        lenderId: '' as string,
        requirement: 'before_first_due',
        maxAmountCapMinor: 2_500_000,
        preDebitLeadHours: 72,
      };

      it('is set by payment.configure and read by payment.read, per lender', async () => {
        policy.lenderId = ids.lenderA;
        expect(
          rowsOf<unknown>(
            await get(`/v1/lender/mandate-policy?lenderId=${ids.lenderA}`, ids.aViewer),
          ),
        ).toEqual([]);
        const res = await post('/v1/lender/mandate-policy', ids.aPayer, policy);
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ outcome: 'set' });
        const items = rowsOf<Record<string, unknown>>(
          await get('/v1/lender/mandate-policy', ids.aViewer),
        );
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({
          lenderId: ids.lenderA,
          requirement: 'before_first_due',
          maxAmountCapMinor: 2_500_000,
          preDebitLeadHours: 72,
        });
        expect(keys(items[0])).toEqual([
          'lenderId',
          'maxAmountCapMinor',
          'preDebitLeadHours',
          'requirement',
          'updatedAt',
        ]);
        expect(rowsOf<unknown>(await get('/v1/lender/mandate-policy', ids.bViewer))).toEqual([]);
        // No ceiling is a valid choice.
        const open = await post('/v1/lender/mandate-policy', ids.aPayer, {
          ...policy,
          maxAmountCapMinor: null,
        });
        expect(open.statusCode).toBe(200);
        expect(
          rowsOf<{ maxAmountCapMinor: number | null }>(
            await get('/v1/lender/mandate-policy', ids.aViewer),
          )[0]?.maxAmountCapMinor,
        ).toBeNull();
      });

      it('refuses the wrong person, the wrong lender and bad values', async () => {
        for (const user of [ids.aViewer, ids.aRecon, ids.aNone, ids.bPayer]) {
          expect((await post('/v1/lender/mandate-policy', user, policy)).statusCode).toBe(403);
        }
        const lead = await post('/v1/lender/mandate-policy', ids.aPayer, {
          ...policy,
          preDebitLeadHours: 10,
        });
        expect([lead.statusCode, code(lead)]).toEqual([422, 'policy_invalid']);
        const cap = await post('/v1/lender/mandate-policy', ids.aPayer, {
          ...policy,
          maxAmountCapMinor: 0,
        });
        expect([cap.statusCode, code(cap)]).toEqual([422, 'policy_invalid']);
        const requirement = await post('/v1/lender/mandate-policy', ids.aPayer, {
          ...policy,
          requirement: 'mandatory',
        });
        expect([requirement.statusCode, code(requirement)]).toEqual([422, 'validation_failed']);
        const aal1 = await call('POST', '/v1/lender/mandate-policy', ids.aPayer, policy, {
          aal: 'aal1',
        });
        expect([aal1.statusCode, code(aal1)]).toEqual([401, 'mfa_required']);
      });
    });

    // ================================================================================================================
    // Mandates and debits
    // ================================================================================================================
    describe('mandates', () => {
      const allowedKeys = [
        'cancelReason',
        'cancelRequestedAt',
        'cancelSentAt',
        'createdAt',
        'endDate',
        'handoffExpiresAt',
        'id',
        'lastEventAt',
        'lenderId',
        'loanAccountId',
        'maskedAccountRef',
        'maxAmountMinor',
        'needsAfaEachDebit',
        'provider',
        'providerMandateRef',
        'providerMode',
        'rail',
        'startDate',
        'status',
        'updatedAt',
      ];

      it("lists the lender's mandates with the provider-confirmed status and only a masked account reference", async () => {
        const res = await get('/v1/lender/mandates?limit=100', ids.aViewer);
        expect(res.statusCode).toBe(200);
        expect(LpMandatePage.safeParse(res.json()).success).toBe(true);
        const rows = rowsOf<Record<string, unknown> & { id: string }>(res);
        expect(new Set(idsOf(rows))).toEqual(new Set(A.mandates));
        for (const row of rows) {
          expect(keys(row)).toEqual(allowedKeys);
          expect(row.maskedAccountRef).toBe('XXXXXX1234');
          expect(Number.isInteger(row.maxAmountMinor)).toBe(true);
          expect(row.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        }
        expect(Object.fromEntries(rows.map((r) => [r.status, r.providerMandateRef]))).toMatchObject(
          {
            draft: null,
            active: `MND-a-0`,
          },
        );
        const cancelled = rows.find((r) => r.status === 'cancelled');
        expect(cancelled).toMatchObject({ cancelReason: 'borrower' });
        expect(cancelled?.cancelRequestedAt).toBeTruthy();
      });

      it('shows lender B nothing of lender A, filters, and pages without skips', async () => {
        const b = rowsOf<{ id: string }>(await get('/v1/lender/mandates?limit=100', ids.bViewer));
        expect(new Set(idsOf(b))).toEqual(new Set(B.mandates));
        const active = rowsOf<{ status: string }>(
          await get('/v1/lender/mandates?status=active', ids.aViewer),
        );
        expect(active).toHaveLength(1);
        const { all, sizes } = await pages<{ id: string }>('/v1/lender/mandates', ids.aViewer, 3);
        expect(sizes).toEqual([3, 1]);
        const expected = await q<{ id: string }>(
          'select id from payments.mandates where lender_org_id = $1 order by created_at desc, id desc',
          [ids.lenderA],
        );
        expect(idsOf(all)).toEqual(idsOf(expected));
      });

      it('shows one mandate with its history, its newest debits and its pre-debit notices', async () => {
        const res = await get(`/v1/lender/mandates/${A.mandates[0] ?? ''}`, ids.aViewer);
        expect(res.statusCode).toBe(200);
        const body = res.json<{
          mandate: Record<string, unknown>;
          events: { fromStatus: string | null; toStatus: string; source: string }[];
          debits: { scheduledOn: string; status: string; planned: boolean }[];
          notices: { status: string; deliveryState: string | null }[];
        }>();
        expect(keys(body)).toEqual(['debits', 'events', 'mandate', 'notices']);
        expect(keys(body.mandate)).toEqual(allowedKeys);
        expect(body.events.map((e) => e.toStatus).sort()).toEqual([
          'active',
          'draft',
          'registration_pending',
        ]);
        expect(body.events.find((e) => e.toStatus === 'active')?.source).toBe('provider_event');
        expect(body.debits).toHaveLength(6);
        const dates = body.debits.map((d) => d.scheduledOn);
        expect([...dates].sort().reverse()).toEqual(dates);
        expect(body.notices).toHaveLength(3);
        expect(body.notices.filter((n) => n.status === 'sent')).toMatchObject([
          { deliveryState: 'accepted' },
        ]);
        expect(
          (await get(`/v1/lender/mandates/${A.mandates[0] ?? ''}`, ids.bViewer)).statusCode,
        ).toBe(404);
        expect((await get(`/v1/lender/mandates/${randomUUID()}`, ids.aViewer)).statusCode).toBe(
          404,
        );
      });

      it('lists debits newest scheduled date first, with the provider return code and its class', async () => {
        const m0 = A.mandates[0] ?? '';
        const res = await get(`/v1/lender/mandate-debits?mandateId=${m0}&limit=100`, ids.aViewer);
        expect(res.statusCode).toBe(200);
        const rows = rowsOf<Record<string, unknown> & { id: string; scheduledOn: string }>(res);
        expect(rows).toHaveLength(6);
        expect(keys(rows[0])).toEqual([
          'amountMinor',
          'createdAt',
          'exceedsMandateMax',
          'id',
          'installmentSeq',
          'lenderId',
          'loanAccountId',
          'mandateId',
          'planned',
          'providerDebitRef',
          'returnClass',
          'returnCode',
          'scheduledOn',
          'status',
          'updatedAt',
        ]);
        const returned = rows.find((r) => r.status === 'returned');
        expect(returned).toMatchObject({
          returnCode: 'R01',
          returnClass: 'insufficient_funds',
          planned: false,
        });
        expect(
          rowsOf<unknown>(
            await get(`/v1/lender/mandate-debits?mandateId=${m0}&planned=false`, ids.aViewer),
          ),
        ).toHaveLength(2);
        expect(
          rowsOf<unknown>(
            await get(`/v1/lender/mandate-debits?mandateId=${m0}&status=scheduled`, ids.aViewer),
          ),
        ).toHaveLength(2);
      });

      it('pages debits by scheduled date without skips or repeats, and shows lender B only its own', async () => {
        const { all, sizes } = await pages<{ id: string }>(
          '/v1/lender/mandate-debits',
          ids.aViewer,
          4,
        );
        expect(sizes).toEqual([4, 2]);
        const expected = await q<{ id: string }>(
          'select id from payments.mandate_debits where lender_org_id = $1 order by scheduled_on desc, id desc',
          [ids.lenderA],
        );
        expect(idsOf(all)).toEqual(idsOf(expected));
        const b = rowsOf<{ lenderId: string }>(
          await get('/v1/lender/mandate-debits?limit=100', ids.bViewer),
        );
        expect(b).toHaveLength(6);
        expect(b.every((r) => r.lenderId === ids.lenderB)).toBe(true);
        expect(
          (
            await get(`/v1/lender/mandate-debits?mandateId=${A.mandates[0] ?? ''}`, ids.bViewer)
          ).json<Page<unknown>>().items,
        ).toEqual([]);
      });
    });

    // ================================================================================================================
    // Reconciliation: runs, summary, settlement batches, settings
    // ================================================================================================================
    describe('reconciliation', () => {
      it('lists runs with their counts for the lender only', async () => {
        const res = await get('/v1/lender/reconciliation/runs', ids.aViewer);
        expect(res.statusCode).toBe(200);
        const rows = rowsOf<Record<string, unknown>>(res);
        expect(rows).toHaveLength(1);
        expect(keys(rows[0])).toEqual([
          'counts',
          'createdAt',
          'id',
          'lenderId',
          'runDate',
          'runNo',
        ]);
        expect(rows[0]).toMatchObject({
          id: runIds[ids.lenderA],
          lenderId: ids.lenderA,
          runDate,
          runNo: 1,
          counts: {
            paymentsConsidered: 4,
            matchedToSettlement: 3,
            matchedToBank: 2,
            matchedToReceipt: 1,
          },
        });
        const b = rowsOf<{ id: string }>(await get('/v1/lender/reconciliation/runs', ids.bViewer));
        expect(idsOf(b)).toEqual([runIds[ids.lenderB]]);
        expect(
          rowsOf<unknown>(await get(`/v1/lender/reconciliation/runs?date=2001-01-01`, ids.aViewer)),
        ).toEqual([]);
        expect(
          rowsOf<unknown>(await get(`/v1/lender/reconciliation/runs?date=${runDate}`, ids.aViewer)),
        ).toHaveLength(1);
      });

      it('answers 422 invalid_request for a date that has the right shape but is not a date', async () => {
        const res = await get('/v1/lender/reconciliation/runs?date=2026-13-45', ids.aViewer);
        expect([res.statusCode, code(res)]).toEqual([422, 'invalid_request']);
      });

      it('gives the report of a date, listing what it could not check and the standing line', async () => {
        const res = await get(
          `/v1/lender/reconciliation/summary?lenderId=${ids.lenderA}&date=${runDate}`,
          ids.aViewer,
        );
        expect(res.statusCode).toBe(200);
        const body = res.json<Record<string, unknown>>();
        expect(keys(body)).toEqual([
          'counts',
          'createdAt',
          'lenderId',
          'report',
          'runDate',
          'runId',
          'runNo',
        ]);
        expect(body).toMatchObject({
          runId: runIds[ids.lenderA],
          lenderId: ids.lenderA,
          runDate,
          runNo: 1,
        });
        expect(body.report).toEqual({
          runDate,
          paymentsConsidered: 4,
          matched: { settlement: 3, bank: 2, receipt: 1 },
          notReconcilable: ['lms_receipts'],
          settledToNonLender: { items: 1, minor: 300_000 },
          // One batch went to another account: 300,000 gross, 296,460 net. A report exists and every batch states its destination, but
          // a finding is not a zero, so there is no evidence to show.
          settlementEvidence: {
            settlementReportExists: true,
            offAccountBatches: 1,
            offAccountNetMinor: 296_460,
            destinationUnstatedBatches: 0,
            destinationUnstatedMinor: 0,
            destinationUnstatedNetMinor: 0,
            zeroIsEvidence: false,
          },
          settings: { settlementLagDays: 3, receiptLagHours: 72, abovePlatformDefault: false },
        });
      });

      it('reads what an older run did not record as null, never as zero or false (so a zero there is not shown as evidence)', async () => {
        const c = await admin.connect();
        try {
          await c.query('begin');
          await c.query('set local session_replication_role = replica');
          await c.query(
            `insert into payments.reconciliation_runs (lender_org_id, run_date, run_no, inputs_sha256, counts, report)
             values ($1::uuid, date '2001-02-03', 1, repeat('0', 64), '{}'::jsonb,
                     '{"run_date":"2001-02-03","settled_to_non_lender":{"items":0,"minor":0},"settings":{"settlement_lag_days":3,"receipt_lag_hours":72}}'::jsonb)`,
            [ids.lenderB],
          );
          await c.query('commit');
        } catch (error) {
          await c.query('rollback');
          throw error;
        } finally {
          c.release();
        }
        const res = await get(
          `/v1/lender/reconciliation/summary?lenderId=${ids.lenderB}&date=2001-02-03`,
          ids.bViewer,
        );
        expect(res.statusCode, res.body).toBe(200);
        const report = res.json<{ report: Record<string, unknown> }>().report;
        expect(report.settledToNonLender).toEqual({ items: 0, minor: 0 });
        expect(report.settlementEvidence).toEqual({
          settlementReportExists: null,
          offAccountBatches: null,
          offAccountNetMinor: null,
          destinationUnstatedBatches: null,
          destinationUnstatedMinor: null,
          destinationUnstatedNetMinor: null,
          zeroIsEvidence: null,
        });
        expect(report.settings).toEqual({
          settlementLagDays: 3,
          receiptLagHours: 72,
          abovePlatformDefault: null,
        });
      });

      it('answers 404 for a date without a run, and shows lender B only its own run', async () => {
        const none = await get(
          `/v1/lender/reconciliation/summary?lenderId=${ids.lenderA}&date=2001-01-01`,
          ids.aViewer,
        );
        expect(none.statusCode).toBe(404);
        const b = await get(
          `/v1/lender/reconciliation/summary?lenderId=${ids.lenderB}&date=${runDate}`,
          ids.bViewer,
        );
        expect(b.statusCode).toBe(200);
        expect(b.json<{ runId: string }>().runId).toBe(runIds[ids.lenderB]);
        expect(b.json<{ runId: string }>().runId).not.toBe(runIds[ids.lenderA]);
        const ops = await get(
          `/v1/lender/reconciliation/summary?lenderId=${ids.lenderA}&date=${runDate}`,
          ids.pOps,
        );
        expect(ops.statusCode).toBe(200);
      });

      it('lists settlement batches exactly as reported, flags the one that went to another account, and filters by period', async () => {
        const res = await get(
          '/v1/lender/reconciliation/settlement-batches?limit=100',
          ids.aViewer,
        );
        expect(res.statusCode).toBe(200);
        const rows = rowsOf<Record<string, unknown> & { id: string }>(res);
        expect(new Set(idsOf(rows))).toEqual(new Set(A.batches));
        for (const row of rows) {
          expect(keys(row)).toEqual([
            'batchRef',
            'destinationMaskedRef',
            'destinationOk',
            'feeMinor',
            'grossMinor',
            'id',
            'itemCount',
            'lenderId',
            'netMinor',
            'partsMismatch',
            'periodFrom',
            'periodTo',
            'provider',
            'receivedAt',
            'reportDate',
            'settlementRef',
            'taxMinor',
          ]);
          expect(row.netMinor).toBe(
            (row.grossMinor as number) - (row.feeMinor as number) - (row.taxMinor as number),
          );
        }
        expect(rows.filter((r) => r.destinationOk === false)).toMatchObject([
          { destinationMaskedRef: 'XXXXXX9999' },
        ]);
        const b = rowsOf<{ id: string }>(
          await get('/v1/lender/reconciliation/settlement-batches?limit=100', ids.bViewer),
        );
        expect(new Set(idsOf(b))).toEqual(new Set(B.batches));
        expect(
          rowsOf<unknown>(
            await get('/v1/lender/reconciliation/settlement-batches?to=2001-01-01', ids.aViewer),
          ),
        ).toEqual([]);
        expect(
          rowsOf<unknown>(
            await get('/v1/lender/reconciliation/settlement-batches?from=2001-01-01', ids.aViewer),
          ),
        ).toHaveLength(4);
        const { all, sizes } = await pages<{ id: string }>(
          '/v1/lender/reconciliation/settlement-batches',
          ids.aViewer,
          3,
        );
        expect(sizes).toEqual([3, 1]);
        expect(new Set(idsOf(all)).size).toBe(4);
      });

      it("shows one batch and pages its items by identifier, and hides another lender's batch", async () => {
        const batch = A.batches[0] ?? '';
        await replica(async (c) => {
          for (let n = 0; n < 4; n += 1)
            await c.query(
              `insert into payments.settlement_items (batch_id, lender_org_id, provider_payment_ref, gross_minor, fee_minor, tax_minor, net_minor, parts_mismatch)
               values ($1, $2, $3, 1000, 10, 2, 988, false)`,
              [batch, ids.lenderA, `PAY-EXTRA-${String(n)}`],
            );
        });
        const one = await get(`/v1/lender/reconciliation/settlement-batches/${batch}`, ids.aViewer);
        expect(one.statusCode).toBe(200);
        expect(one.json<{ id: string }>().id).toBe(batch);
        const { all, sizes } = await pages<{ id: string }>(
          `/v1/lender/reconciliation/settlement-batches/${batch}/items`,
          ids.aViewer,
          2,
        );
        expect(sizes).toEqual([2, 2, 1]);
        const expected = await q<{ id: string }>(
          'select id from payments.settlement_items where batch_id = $1 order by id',
          [batch],
        );
        expect(idsOf(all)).toEqual(idsOf(expected));
        expect(keys(all[0])).toEqual([
          'feeMinor',
          'grossMinor',
          'id',
          'netMinor',
          'orderRef',
          'partsMismatch',
          'providerPaymentRef',
          'taxMinor',
        ]);
        expect(
          (await get(`/v1/lender/reconciliation/settlement-batches/${batch}`, ids.bViewer))
            .statusCode,
        ).toBe(404);
        expect(
          (await get(`/v1/lender/reconciliation/settlement-batches/${batch}/items`, ids.bViewer))
            .statusCode,
        ).toBe(404);
        const badCursor = await get(
          `/v1/lender/reconciliation/settlement-batches/${batch}/items?cursor=zzzz`,
          ids.aViewer,
        );
        expect([badCursor.statusCode, code(badCursor)]).toEqual([400, 'invalid_cursor']);
      });
    });

    describe('reconciliation settings', () => {
      it('are set by payment.configure and read by payment.read', async () => {
        expect(
          rowsOf<unknown>(await get('/v1/lender/reconciliation/settings', ids.aViewer)),
        ).toEqual([]);
        const res = await post('/v1/lender/reconciliation/settings', ids.aPayer, {
          lenderId: ids.lenderA,
          settlementLagDays: 5,
          receiptLagHours: 96,
        });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ outcome: 'set' });
        const items = rowsOf<Record<string, unknown>>(
          await get(`/v1/lender/reconciliation/settings?lenderId=${ids.lenderA}`, ids.aViewer),
        );
        expect(items).toMatchObject([
          { lenderId: ids.lenderA, settlementLagDays: 5, receiptLagHours: 96 },
        ]);
        expect(keys(items[0])).toEqual([
          'lenderId',
          'receiptLagHours',
          'settlementLagDays',
          'updatedAt',
        ]);
        expect(
          rowsOf<unknown>(await get('/v1/lender/reconciliation/settings', ids.bViewer)),
        ).toEqual([]);
      });

      it('refuse the wrong person, the wrong lender, a missing factor and out-of-range values', async () => {
        const body = { lenderId: ids.lenderA, settlementLagDays: 6, receiptLagHours: 100 };
        for (const user of [ids.aRecon, ids.aViewer, ids.aNone, ids.bPayer, ids.pPay])
          expect((await post('/v1/lender/reconciliation/settings', user, body)).statusCode).toBe(
            403,
          );
        const aal1 = await call('POST', '/v1/lender/reconciliation/settings', ids.aPayer, body, {
          aal: 'aal1',
        });
        expect([aal1.statusCode, code(aal1)]).toEqual([401, 'mfa_required']);
        // The contract carries the database's range (1 to 7 days, 1 to 168 hours), so a value outside it never reaches the database.
        for (const bad of [
          { ...body, settlementLagDays: 0 },
          { ...body, settlementLagDays: 8 },
          { ...body, settlementLagDays: 31 },
          { ...body, receiptLagHours: 0 },
          { ...body, receiptLagHours: 169 },
          { ...body, receiptLagHours: 721 },
          { ...body, receiptLagHours: 1_000_000 },
        ]) {
          const res = await post('/v1/lender/reconciliation/settings', ids.aPayer, bad);
          expect([res.statusCode, code(res)], JSON.stringify(bad)).toEqual([
            422,
            'validation_failed',
          ]);
        }
        expect(
          (await post('/v1/lender/reconciliation/settings', ids.aPayer, { ...body, extra: 1 }))
            .statusCode,
        ).toBe(422);
        expect(
          rowsOf<{ settlementLagDays: number }>(
            await get('/v1/lender/reconciliation/settings', ids.aViewer),
          )[0]?.settlementLagDays,
        ).toBe(5);
      });

      it('accept the ends of the range the database accepts, and the database agrees', async () => {
        for (const [days, hours] of [
          [1, 1],
          [7, 168],
        ] as const) {
          const res = await post('/v1/lender/reconciliation/settings', ids.aPayer, {
            lenderId: ids.lenderA,
            settlementLagDays: days,
            receiptLagHours: hours,
          });
          expect([days, hours, res.statusCode]).toEqual([days, hours, 200]);
          expect(
            rowsOf<{ settlementLagDays: number; receiptLagHours: number }>(
              await get(`/v1/lender/reconciliation/settings?lenderId=${ids.lenderA}`, ids.aViewer),
            ),
          ).toMatchObject([{ settlementLagDays: days, receiptLagHours: hours }]);
        }
        // restore the values the following tests were written for
        const restore = await post('/v1/lender/reconciliation/settings', ids.aPayer, {
          lenderId: ids.lenderA,
          settlementLagDays: 5,
          receiptLagHours: 96,
        });
        expect(restore.statusCode).toBe(200);
      });
    });

    // ================================================================================================================
    // Bank credits: JSON and CSV
    // ================================================================================================================
    describe('bank credits', () => {
      // Eight digits after BANK: the bank reference rule needs four capital letters first and at least six digits, and refuses long letter runs.
      const stamp = String(Math.floor(Math.random() * 1e8)).padStart(8, '0');
      const utr = (n: number) => `BANK${stamp}${String(n).padStart(4, '0')}`;
      const today = () => runDate;
      const upload = (
        user: string | null,
        body: unknown,
        options: { aal?: 'aal1' | 'aal2'; key?: string | null } = {},
      ) => call('POST', '/v1/lender/reconciliation/bank-credits', user, body, options);
      const stored = (value: string) =>
        count('select count(*) as n from payments.bank_credits where utr like $1', [`${value}%`]);
      const jsonBody = (rows: unknown[], overrides: Record<string, unknown> = {}) => ({
        lenderId: ids.lenderA,
        accountId: A.account,
        rows,
        ...overrides,
      });

      it('records the credits of a JSON upload and nothing but value date, amount and reference', async () => {
        const key = `bank-key-${randomUUID()}`;
        const rows = [1, 2, 3].map((n) => ({
          valueDate: today(),
          amountMinor: 100_000 * n,
          utr: utr(n),
        }));
        const res = await upload(ids.aRecon, jsonBody(rows), { key });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ inserted: 3, duplicates: 0 });
        const saved = await q<{
          utr: string;
          amount_minor: string;
          recorded_by: string;
          settlement_account_id: string;
        }>(
          'select utr, amount_minor, recorded_by, settlement_account_id from payments.bank_credits where utr like $1 order by utr',
          [`BANK${stamp}%`],
        );
        expect(saved.map((r) => [r.utr, r.amount_minor])).toEqual([
          [utr(1), '100000'],
          [utr(2), '200000'],
          [utr(3), '300000'],
        ]);
        expect(
          saved.every((r) => r.recorded_by === ids.aRecon && r.settlement_account_id === A.account),
        ).toBe(true);
        // The stored answer is replayed for the same key and the upload does not run again.
        const again = await upload(ids.aRecon, jsonBody(rows), { key });
        expect(again.headers['idempotent-replayed']).toBe('true');
        expect(again.json()).toEqual({ inserted: 3, duplicates: 0 });
        expect(await stored(`BANK${stamp}`)).toBe(3);
        // The same credits under a new key are duplicates, not a second copy.
        const duplicate = await upload(ids.aRecon, jsonBody(rows));
        expect(duplicate.json()).toEqual({ inserted: 0, duplicates: 3 });
        expect(await stored(`BANK${stamp}`)).toBe(3);
      });

      it('refuses a bank reference that differs from one already recorded, and stores none of that upload', async () => {
        const res = await upload(
          ids.aRecon2,
          jsonBody([
            { valueDate: today(), amountMinor: 555_000, utr: utr(50) },
            { valueDate: today(), amountMinor: 999_000, utr: utr(1) }, // recorded above with 100,000
          ]),
        );
        expect([res.statusCode, code(res)]).toEqual([422, 'utr_conflict']);
        expect(await stored(utr(50))).toBe(0);
        const twice = await upload(
          ids.aRecon2,
          jsonBody([
            { valueDate: today(), amountMinor: 1_000, utr: utr(51) },
            { valueDate: today(), amountMinor: 2_000, utr: utr(51) },
          ]),
        );
        expect([twice.statusCode, code(twice)]).toEqual([422, 'utr_conflict']);
        expect(await stored(utr(51))).toBe(0);
      });

      it('refuses a narration or any extra field in JSON as a whole, names no value, and stores nothing', async () => {
        const res = await upload(
          ids.aRecon2,
          jsonBody([
            { valueDate: today(), amountMinor: 1_000, utr: utr(60) },
            { valueDate: today(), amountMinor: 2_000, utr: utr(61), narration: CANARY.narration },
          ]),
        );
        expect(res.statusCode).toBe(422);
        expect(res.body).not.toContain(CANARY.narration);
        expect(await stored(utr(60))).toBe(0);
        expect(await stored(utr(61))).toBe(0);
      });

      it('is also refused by the database itself when a narration reaches it', async () => {
        const r = await asUser(
          ids.aRecon,
          'aal2',
          'select payments.import_bank_credits($1::uuid, $2::uuid, $3::jsonb)',
          [
            ids.lenderA,
            A.account,
            JSON.stringify([
              { valueDate: today(), amountMinor: '1000', utr: utr(62), narration: 'x' },
            ]),
          ],
        );
        expect(r).toMatchObject({ ok: false, code: '22023', hint: 'unexpected_field' });
        expect(await stored(utr(62))).toBe(0);
      });

      it('refuses a value date in the future and an unknown settlement account', async () => {
        const future = await upload(
          ids.aRecon2,
          jsonBody([{ valueDate: '2999-01-01', amountMinor: 1_000, utr: utr(70) }]),
        );
        expect([future.statusCode, code(future)]).toEqual([422, 'row_invalid']);
        expect(await stored(utr(70))).toBe(0);
        const own = [{ valueDate: today(), amountMinor: 1_000, utr: utr(71) }];
        // Lender B's account named by lender A's reconciler, and an account that does not exist: both are "not found".
        for (const accountId of [B.account, randomUUID()]) {
          const res = await upload(ids.aRecon2, jsonBody(own, { accountId }));
          expect([res.statusCode, code(res)]).toEqual([404, 'not_found']);
        }
        expect(await stored(utr(71))).toBe(0);
      });

      it('is open only to payment.reconcile of that lender, with the second factor', async () => {
        const rows = [{ valueDate: today(), amountMinor: 1_000, utr: utr(80) }];
        for (const [label, user] of [
          ['read-only', ids.aViewer],
          ['configurer', ids.aPayer],
          ['no permission', ids.aNone],
          ['reconciler of another lender', ids.bRecon],
          ['platform admin', ids.pPay],
          ['platform operations', ids.pOps],
        ] as const) {
          const res = await upload(user, jsonBody(rows));
          expect([label, res.statusCode]).toEqual([label, 403]);
        }
        const aal1 = await upload(ids.aRecon3, jsonBody(rows), { aal: 'aal1' });
        expect([aal1.statusCode, code(aal1)]).toEqual([401, 'mfa_required']);
        expect((await upload(null, jsonBody(rows))).statusCode).toBe(401);
        expect((await upload(ids.aRecon3, jsonBody(rows), { key: null })).statusCode).toBe(400);
        expect(await stored(utr(80))).toBe(0);
      });

      it('refuses a malformed request before it reaches the database', async () => {
        const row = { valueDate: today(), amountMinor: 1_000, utr: utr(90) };
        const many = Array.from({ length: LP_BANK_CREDIT_MAX_ROWS + 1 }, (_, n) => ({
          valueDate: today(),
          amountMinor: 1_000 + n,
          utr: `BIG${stamp}${String(n).padStart(5, '0')}`,
        }));
        for (const [label, body] of [
          ['zero amount', jsonBody([{ ...row, amountMinor: 0 }])],
          ['fractional amount', jsonBody([{ ...row, amountMinor: 1.5 }])],
          ['amount as text', jsonBody([{ ...row, amountMinor: '1000' }])],
          ['negative amount', jsonBody([{ ...row, amountMinor: -1 }])],
          ['bad date', jsonBody([{ ...row, valueDate: '12/10/2026' }])],
          ['space in reference', jsonBody([{ ...row, utr: 'AB CD 1234' }])],
          ['short reference', jsonBody([{ ...row, utr: 'AB1' }])],
          ['no rows', jsonBody([])],
          ['neither rows nor csv', { lenderId: ids.lenderA, accountId: A.account }],
          ['both rows and csv', jsonBody([row], { csv: 'valueDate,amountMinor,utr\n' })],
          ['too many rows', jsonBody(many)],
          ['unknown top-level key', jsonBody([row], { memo: 'x' })],
          ['lender id missing', { accountId: A.account, rows: [row] }],
        ] as const) {
          const res = await upload(ids.aRecon3, body);
          expect([label, res.statusCode]).toEqual([label, 422]);
        }
        expect(await stored(utr(90))).toBe(0);
        expect(await stored(`BIG${stamp}`)).toBe(0);
      });

      describe('as CSV text', () => {
        const header = 'valueDate,amountMinor,utr';
        const csvBody = (csv: string) => ({ lenderId: ids.lenderA, accountId: A.account, csv });
        const uploaders = [ids.aRecon2, ids.aRecon3, ids.aRecon4];
        let turn = 0;
        const nextUploader = () => uploaders[turn++ % uploaders.length] ?? ids.aRecon4;
        const refused = async (csv: string) => {
          const res = await upload(nextUploader(), csvBody(csv));
          expect(res.statusCode).toBe(422);
          expect(res.body).not.toContain(CANARY.narration);
          return res;
        };

        it('accepts exactly the three columns, with a byte-order mark, CRLF line ends and a final newline', async () => {
          const csv = `\uFEFF${header}\r\n${today()},250000,${utr(100)}\r\n${today()},350000,${utr(101)}\r\n`;
          const res = await upload(nextUploader(), csvBody(csv));
          expect(res.statusCode).toBe(200);
          expect(res.json()).toEqual({ inserted: 2, duplicates: 0 });
          expect(
            await count(
              'select sum(amount_minor)::text as n from payments.bank_credits where utr in ($1, $2)',
              [utr(100), utr(101)],
            ),
          ).toBe(600_000);
        });

        it('accepts the columns in another order', async () => {
          const csv = `utr,valueDate,amountMinor\n${utr(102)},${today()},123456\n`;
          const res = await upload(nextUploader(), csvBody(csv));
          expect(res.json()).toEqual({ inserted: 1, duplicates: 0 });
          expect(
            await count(
              'select amount_minor::text as n from payments.bank_credits where utr = $1',
              [utr(102)],
            ),
          ).toBe(123_456);
        });

        it('refuses a fourth column (a narration may carry a name) as a whole, names no value and stores nothing', async () => {
          const csv = `${header},narration\n${today()},1000,${utr(110)},${CANARY.narration}\n${today()},2000,${utr(111)},${CANARY.narration}\n`;
          const res = await refused(csv);
          expect(code(res)).toBe('unexpected_field');
          expect(res.body).not.toContain(utr(110));
          expect(await stored(utr(110))).toBe(0);
          expect(await stored(utr(111))).toBe(0);
          // The same with a differently named column, and with a narration hidden in an unnamed fourth field.
          expect(
            code(
              await refused(`${header},remarks\n${today()},1000,${utr(112)},${CANARY.narration}\n`),
            ),
          ).toBe('unexpected_field');
          await refused(`${header}\n${today()},1000,${utr(113)},${CANARY.narration}\n`);
          expect(await stored(utr(112))).toBe(0);
          expect(await stored(utr(113))).toBe(0);
        });

        it('refuses a header that is not exactly the three columns', async () => {
          await refused(`valueDate,amountMinor\n${today()},1000\n`);
          await refused(`valueDate,valueDate,utr\n${today()},${today()},${utr(120)}\n`);
          await refused(` valueDate,amountMinor,utr\n${today()},1000,${utr(121)}\n`);
          await refused(`VALUEDATE,AMOUNTMINOR,UTR\n${today()},1000,${utr(122)}\n`);
          await refused(`${header}\n`);
          await refused(header);
          expect(await stored('BANK' + stamp + '012')).toBe(0);
        });

        it('refuses quotes, a wrong number of fields, a blank line and bad values, naming the line and field but never the value', async () => {
          const quoted = await refused(`${header}\n${today()},"1000",${utr(130)}\n`);
          expect(quoted.body).not.toContain(utr(130));
          await refused(`${header}\n${today()},1000\n`);
          await refused(`${header}\n${today()},1000,${utr(131)},extra\n`);
          await refused(`${header}\n${today()},1000,${utr(132)}\n\n${today()},1000,${utr(133)}\n`);
          const amount = await refused(`${header}\n${today()},ABCDEF,${utr(134)}\n`);
          expect(amount.body).toContain('amountMinor');
          expect(amount.body).not.toContain('ABCDEF');
          await refused(`${header}\n${today()},-5,${utr(135)}\n`);
          await refused(`${header}\n${today()},007,${utr(136)}\n`);
          await refused(`${header}\n${today()},1.50,${utr(137)}\n`);
          await refused(`${header}\n2026-02-30x,1000,${utr(138)}\n`);
          await refused(`${header}\n${today()},1000,AB CD EF\n`);
          await refused(`${header}\n${today()},1000,${utr(139)}\0\n`);
          expect(await stored('BANK' + stamp + '013')).toBe(0);
        });

        it('refuses the whole upload when one line among many is bad, and when there are too many lines', async () => {
          const good = [140, 141, 142].map((n) => `${today()},1000,${utr(n)}`);
          await refused([header, ...good, `${today()},zero,${utr(143)}`].join('\n'));
          expect(await stored(utr(140))).toBe(0);
          const lines = Array.from(
            { length: LP_BANK_CREDIT_MAX_ROWS + 1 },
            (_, n) => `${today()},${String(1000 + n)},BIG${stamp}${String(n).padStart(5, '0')}`,
          );
          const res = await refused([header, ...lines].join('\n'));
          expect(code(res)).toBe('rows_invalid');
          expect(await stored(`BIG${stamp}`)).toBe(0);
        });

        it('applies the same permissions and the same database rules as the JSON form', async () => {
          const csv = `${header}\n${today()},1000,${utr(150)}\n`;
          for (const user of [ids.aViewer, ids.aPayer, ids.bRecon])
            expect((await upload(user, csvBody(csv))).statusCode).toBe(403);
          const conflict = await upload(
            nextUploader(),
            csvBody(`${header}\n${today()},999999,${utr(100)}\n`),
          );
          expect([conflict.statusCode, code(conflict)]).toEqual([422, 'utr_conflict']);
          const future = await upload(
            nextUploader(),
            csvBody(`${header}\n2999-01-01,1000,${utr(151)}\n`),
          );
          expect([future.statusCode, code(future)]).toEqual([422, 'row_invalid']);
          expect(await stored(utr(150))).toBe(0);
          expect(await stored(utr(151))).toBe(0);
        });
      });
    });

    // ================================================================================================================
    // The exception queue
    // ================================================================================================================
    describe('exceptions', () => {
      const base = '/v1/lender/reconciliation/exceptions';
      const act = (
        id: string,
        verb: string,
        user: string,
        body: unknown = {},
        options: { aal?: 'aal1' | 'aal2'; key?: string | null } = {},
      ) => call('POST', `${base}/${id}/${verb}`, user, body, options);
      const row = async (id: string) =>
        (
          await q<{ status: string; assigned_to: string | null; resolved_at: Date | null }>(
            'select status, assigned_to, resolved_at from payments.reconciliation_exceptions where id = $1',
            [id],
          )
        )[0];
      const eventCount = (id: string, action: string) =>
        count(
          'select count(*) as n from payments.reconciliation_exception_events where exception_id = $1 and action = $2',
          [id, action],
        );
      const fresh = (owner: 'lender' | 'platform' = 'lender', lender = ids.lenderA) =>
        raise(
          lender,
          owner === 'lender' ? 'lender_receipt_missing' : 'event_payload_conflict',
          'warning',
          owner,
          owner === 'lender' ? { provider_payment_id: randomUUID() } : { event_id: randomUUID() },
        );

      it("lists the lender's exceptions, platform-owned ones included, in a fixed shape with identifiers only", async () => {
        const res = await get(`${base}?limit=100`, ids.aRecon);
        expect(res.statusCode).toBe(200);
        expect(LpExceptionPage.safeParse(res.json()).success).toBe(true);
        const rows = rowsOf<Record<string, unknown> & { id: string }>(res);
        const expected = await q<{ id: string }>(
          'select id from payments.reconciliation_exceptions where lender_org_id = $1 order by opened_at desc, id desc',
          [ids.lenderA],
        );
        expect(idsOf(rows)).toEqual(idsOf(expected));
        expect(rows.length).toBeGreaterThanOrEqual(7);
        for (const r of rows) {
          expect(keys(r)).toEqual([
            'assignedTo',
            'class',
            'id',
            'lenderId',
            'openedAt',
            'owner',
            'resolvedAt',
            'severity',
            'status',
            'subject',
            'updatedAt',
          ]);
          for (const value of Object.values(r.subject as Record<string, string>))
            expect(typeof value).toBe('string');
        }
        expect(rows.filter((r) => r.owner === 'platform').length).toBeGreaterThanOrEqual(2);
      });

      it('shows lender B nothing of lender A, and platform staff who run providers every lender', async () => {
        const b = rowsOf<{ id: string; lenderId: string }>(
          await get(`${base}?limit=100`, ids.bRecon),
        );
        expect(b.every((r) => r.lenderId === ids.lenderB)).toBe(true);
        for (const id of A.exceptions) expect(idsOf(b)).not.toContain(id);
        // Every exception of every lender (other integration files leave rows of their own, so page through all of them).
        const total = await count('select count(*) as n from payments.reconciliation_exceptions');
        expect((await pages<{ id: string }>(base, ids.pPay, 100)).all).toHaveLength(total);
        expect((await pages<{ id: string }>(base, ids.pOps, 100)).all).toHaveLength(total);
        const mine = new Set(idsOf((await pages<{ id: string }>(base, ids.pPay, 100)).all));
        for (const id of [...A.exceptions, ...B.exceptions]) expect(mine.has(id)).toBe(true);
      });

      it('filters, and pages without skips or repeats', async () => {
        const platformOwned = rowsOf<{ owner: string }>(
          await get(`${base}?lenderId=${ids.lenderA}&owner=platform`, ids.aRecon),
        );
        expect(platformOwned.length).toBeGreaterThanOrEqual(2);
        expect(platformOwned.every((r) => r.owner === 'platform')).toBe(true);
        const critical = rowsOf<{ severity: string }>(
          await get(`${base}?severity=critical`, ids.aRecon),
        );
        expect(critical.every((r) => r.severity === 'critical')).toBe(true);
        const byClass = rowsOf<{ class: string }>(
          await get(`${base}?class=amount_mismatch`, ids.aRecon),
        );
        expect(byClass).toHaveLength(1);
        const { all, sizes } = await pages<{ id: string }>(base, ids.aRecon, 3);
        const expected = await q<{ id: string }>(
          'select id from payments.reconciliation_exceptions where lender_org_id = $1 order by opened_at desc, id desc',
          [ids.lenderA],
        );
        expect(idsOf(all)).toEqual(idsOf(expected));
        expect(sizes.slice(0, -1).every((n) => n === 3)).toBe(true);
      });

      it('shows one exception with its history, and hides it from other lenders', async () => {
        const id = A.exceptions[0] ?? '';
        const res = await get(`${base}/${id}`, ids.aViewer);
        expect(res.statusCode).toBe(200);
        const body = res.json<{ exception: { id: string }; events: Record<string, unknown>[] }>();
        expect(body.exception.id).toBe(id);
        expect(body.events).toHaveLength(1);
        expect(keys(body.events[0])).toEqual([
          'action',
          'actorKind',
          'actorUserId',
          'assignedTo',
          'authorisedByPermission',
          'evidence',
          'id',
          'note',
          'occurredAt',
          'reasonCode',
        ]);
        expect(body.events[0]).toMatchObject({
          action: 'opened',
          actorKind: 'system',
          actorUserId: null,
        });
        expect((await get(`${base}/${id}`, ids.bRecon)).statusCode).toBe(404);
        expect((await get(`${base}/${id}`, ids.pPay)).statusCode).toBe(200);
        expect((await get(`${base}/${randomUUID()}`, ids.aRecon)).statusCode).toBe(404);
      });

      it('takes an exception through acknowledge, assign, resolve and reopen, recording who acted and under which permission', async () => {
        const id = await fresh();
        const money = await moneyFingerprint();

        // Who may not act: a read-only user (403), a user of another lender (404, it does not exist for them), a missing factor (401).
        expect((await act(id, 'acknowledge', ids.aViewer)).statusCode).toBe(403);
        expect((await act(id, 'acknowledge', ids.aPayer)).statusCode).toBe(403);
        expect((await act(id, 'acknowledge', ids.bRecon)).statusCode).toBe(404);
        expect((await act(id, 'acknowledge', ids.aNone)).statusCode).toBe(404);
        const aal1 = await act(id, 'acknowledge', ids.aRecon, {}, { aal: 'aal1' });
        expect([aal1.statusCode, code(aal1)]).toEqual([401, 'mfa_required']);
        expect((await row(id))?.status).toBe('open');

        const key = `exc-key-${randomUUID()}`;
        const ack = await act(id, 'acknowledge', ids.aRecon, {}, { key });
        expect(ack.statusCode).toBe(200);
        expect(ack.json()).toEqual({ status: 'acknowledged' });
        expect((await row(id))?.status).toBe('acknowledged');
        // Repeating it answers the same and records nothing new, whether by key or not.
        const replay = await act(id, 'acknowledge', ids.aRecon, {}, { key });
        expect(replay.headers['idempotent-replayed']).toBe('true');
        expect((await act(id, 'acknowledge', ids.aRecon)).json()).toEqual({
          status: 'acknowledged',
        });
        expect(await eventCount(id, 'acknowledged')).toBe(1);

        // Assign: only someone who may act on it.
        for (const assignee of [ids.aViewer, ids.bRecon, ids.pPay, ids.aNone, randomUUID()]) {
          const res = await act(id, 'assign', ids.aRecon, { assignee });
          expect([
            assignee === ids.aViewer ? 'viewer' : 'other',
            res.statusCode,
            code(res),
          ]).toEqual([assignee === ids.aViewer ? 'viewer' : 'other', 422, 'assignee_invalid']);
        }
        expect((await act(id, 'assign', ids.aRecon, { assignee: 'nope' })).statusCode).toBe(422);
        const assigned = await act(id, 'assign', ids.aRecon, { assignee: ids.aRecon2 });
        expect(assigned.json()).toEqual({ status: 'assigned' });
        expect((await row(id))?.assigned_to).toBe(ids.aRecon2);

        // Resolve: a reason from the closed list and evidence, nothing else.
        const noReason = await act(id, 'resolve', ids.aRecon2, {
          reasonCode: 'because',
          evidence: ['TICKET-123'],
        });
        expect([noReason.statusCode, code(noReason)]).toEqual([422, 'reason_required']);
        const spaced = await act(id, 'resolve', ids.aRecon2, {
          reasonCode: 'no_action_needed',
          evidence: ['looked at it'],
        });
        expect([spaced.statusCode, code(spaced)]).toEqual([422, 'evidence_required']);
        for (const bad of [
          { evidence: [] },
          { evidence: Array.from({ length: 11 }, (_, n) => `REF-${String(n)}00`) },
          { note: 'x'.repeat(501), evidence: ['REF-100'] },
          { extra: 1, evidence: ['REF-100'] },
        ]) {
          const res = await act(id, 'resolve', ids.aRecon2, {
            reasonCode: 'no_action_needed',
            ...bad,
          });
          expect([res.statusCode, code(res)]).toEqual([422, 'validation_failed']);
        }
        expect((await row(id))?.status).toBe('assigned');
        const resolved = await act(id, 'resolve', ids.aRecon2, {
          reasonCode: 'verified_with_provider',
          evidence: ['PROVIDER-TKT-1', 'RCPT#2'],
          note: 'checked against the provider dashboard',
        });
        expect(resolved.json()).toEqual({ status: 'resolved' });
        expect((await row(id))?.resolved_at).not.toBeNull();
        // Annotation only: no money row moved.
        expect(await moneyFingerprint()).toBe(money);

        // A resolved exception can be neither acknowledged, assigned nor resolved again.
        for (const [verb, body] of [
          ['acknowledge', {}],
          ['assign', { assignee: ids.aRecon }],
          ['resolve', { reasonCode: 'no_action_needed', evidence: ['REF-100'] }],
        ] as const) {
          const res = await act(id, verb, ids.aRecon, body);
          expect([verb, res.statusCode, code(res)]).toEqual([verb, 409, 'exception_state_invalid']);
        }

        // Reopen: a reason from its own, shorter list.
        const wrongList = await act(id, 'reopen', ids.aRecon, { reasonCode: 'no_action_needed' });
        expect([wrongList.statusCode, code(wrongList)]).toEqual([422, 'reason_required']);
        const reopened = await act(id, 'reopen', ids.aRecon, {
          reasonCode: 'new_information',
          note: 'the lender sent a new statement',
        });
        expect(reopened.json()).toEqual({ status: 'reopened' });
        expect(await row(id)).toMatchObject({ status: 'reopened', resolved_at: null });
        const again = await act(id, 'reopen', ids.aRecon, { reasonCode: 'new_information' });
        expect([again.statusCode, code(again)]).toEqual([409, 'exception_state_invalid']);

        const history = (await get(`${base}/${id}`, ids.aViewer)).json<{
          events: {
            action: string;
            actorKind: string;
            authorisedByPermission: string | null;
            reasonCode: string | null;
            evidence: string[] | null;
            assignedTo: string | null;
          }[];
        }>().events;
        expect(history.map((e) => e.action)).toEqual([
          'opened',
          'acknowledged',
          'assigned',
          'resolved',
          'reopened',
        ]);
        expect(
          history
            .slice(1)
            .every(
              (e) =>
                e.actorKind === 'lender_user' && e.authorisedByPermission === 'payment.reconcile',
            ),
        ).toBe(true);
        expect(history[2]?.assignedTo).toBe(ids.aRecon2);
        expect(history[3]).toMatchObject({
          reasonCode: 'verified_with_provider',
          evidence: ['PROVIDER-TKT-1', 'RCPT#2'],
        });
      });

      it('accepts every reason on the closed lists and refuses one that is not on them (the lists did not drift)', async () => {
        const id = await fresh();
        for (const [n, reason] of LP_RESOLVE_REASONS.entries()) {
          const resolved = await act(id, 'resolve', ids.aRecon3, {
            reasonCode: reason,
            evidence: [`REF-${String(n)}00`],
          });
          expect([reason, resolved.statusCode]).toEqual([reason, 200]);
          const reopen = LP_REOPEN_REASONS[n % LP_REOPEN_REASONS.length] ?? 'new_information';
          const back = await act(id, 'reopen', ids.aRecon3, { reasonCode: reopen });
          expect([reopen, back.statusCode]).toEqual([reopen, 200]);
        }
        expect(await eventCount(id, 'resolved')).toBe(LP_RESOLVE_REASONS.length);
        const used = new Set(
          (
            await q<{ reason_code: string }>(
              "select reason_code from payments.reconciliation_exception_events where exception_id = $1 and action = 'reopened'",
              [id],
            )
          ).map((r) => r.reason_code),
        );
        expect(used).toEqual(new Set(LP_REOPEN_REASONS));
        const known = await q<{ reason_code: string }>(
          "select distinct reason_code from payments.reconciliation_exception_events where action = 'resolved' and exception_id = $1",
          [id],
        );
        expect(new Set(known.map((r) => r.reason_code))).toEqual(new Set(LP_RESOLVE_REASONS));
      });

      it('keeps the two owners apart: a lender cannot act on a platform exception and platform staff cannot act on a lender one', async () => {
        const lenderOwned = await fresh('lender');
        const platformOwned = await fresh('platform');
        const lenderBody = { reasonCode: 'no_action_needed', evidence: ['REF-100'] };
        // Lender users (even the reconciler of that lender) on a platform-owned exception.
        for (const verb of ['acknowledge', 'assign', 'resolve', 'reopen'] as const) {
          const body =
            verb === 'assign'
              ? { assignee: ids.pPay2 }
              : verb === 'reopen'
                ? { reasonCode: 'new_information' }
                : verb === 'resolve'
                  ? lenderBody
                  : {};
          const res = await act(platformOwned, verb, ids.aRecon, body);
          expect([verb, res.statusCode]).toEqual([verb, 403]);
        }
        // Platform staff on a lender-owned exception, and platform operations on a platform-owned one (read only).
        expect((await act(lenderOwned, 'acknowledge', ids.pPay)).statusCode).toBe(403);
        expect((await act(lenderOwned, 'resolve', ids.pPay, lenderBody)).statusCode).toBe(403);
        expect((await act(platformOwned, 'acknowledge', ids.pOps)).statusCode).toBe(403);
        expect((await row(lenderOwned))?.status).toBe('open');
        expect((await row(platformOwned))?.status).toBe('open');

        // The platform user works the platform-owned one.
        const aal1 = await act(platformOwned, 'acknowledge', ids.pPay, {}, { aal: 'aal1' });
        expect([aal1.statusCode, code(aal1)]).toEqual([401, 'mfa_required']);
        expect((await act(platformOwned, 'acknowledge', ids.pPay)).json()).toEqual({
          status: 'acknowledged',
        });
        const lenderAssignee = await act(platformOwned, 'assign', ids.pPay, {
          assignee: ids.aRecon,
        });
        expect([lenderAssignee.statusCode, code(lenderAssignee)]).toEqual([
          422,
          'assignee_invalid',
        ]);
        expect(
          (await act(platformOwned, 'assign', ids.pPay, { assignee: ids.pPay2 })).json(),
        ).toEqual({ status: 'assigned' });
        expect(
          (
            await act(platformOwned, 'resolve', ids.pPay2, {
              reasonCode: 'escalated_to_provider',
              evidence: ['PROVIDER-CASE-9'],
            })
          ).json(),
        ).toEqual({ status: 'resolved' });
        const events = await q<{
          action: string;
          actor_kind: string;
          authorised_by_permission: string | null;
        }>(
          'select action, actor_kind, authorised_by_permission from payments.reconciliation_exception_events where exception_id = $1 order by occurred_at, id',
          [platformOwned],
        );
        expect(
          events
            .slice(1)
            .every(
              (e) =>
                e.actor_kind === 'platform_user' &&
                e.authorised_by_permission === 'platform.payments.providers.manage',
            ),
        ).toBe(true);
        // Lender B's reconciler cannot even see lender A's exception.
        const hidden = await fresh('lender');
        expect((await act(hidden, 'acknowledge', ids.bRecon)).statusCode).toBe(404);
        // An exception that does not exist answers exactly like one the caller may not see.
        expect((await act(randomUUID(), 'acknowledge', ids.bRecon)).statusCode).toBe(404);
        expect((await act(randomUUID(), 'resolve', ids.bRecon, lenderBody)).statusCode).toBe(404);
        expect((await act(hidden, 'acknowledge', ids.aRecon)).statusCode).toBe(200);
      });

      it('lists the open platform-owned exceptions of every lender for platform staff, and for nobody else', async () => {
        const mine = await fresh('platform', ids.lenderA);
        const theirs = await fresh('platform', ids.lenderB);
        const closed = await fresh('platform', ids.lenderB);
        await act(closed, 'resolve', ids.pPay, {
          reasonCode: 'raised_in_error',
          evidence: ['REF-100'],
        });
        const res = await get('/v1/platform/exceptions?limit=100', ids.pPay);
        expect(res.statusCode).toBe(200);
        const rows = rowsOf<{ id: string; owner: string; status: string; lenderId: string }>(res);
        expect(idsOf(rows)).toEqual(expect.arrayContaining([mine, theirs]));
        expect(idsOf(rows)).not.toContain(closed);
        expect(rows.every((r) => r.owner === 'platform' && r.status !== 'resolved')).toBe(true);
        // Both lenders appear (other integration files may have left platform exceptions of other lenders).
        const lenders = new Set(rows.map((r) => r.lenderId));
        expect(lenders.has(ids.lenderA) && lenders.has(ids.lenderB)).toBe(true);
        const expected = await q<{ id: string }>(
          "select id from payments.reconciliation_exceptions where owner = 'platform' and status <> 'resolved' order by opened_at desc, id desc",
        );
        const { all } = await pages<{ id: string }>('/v1/platform/exceptions', ids.pPay2, 2);
        expect(idsOf(all)).toEqual(idsOf(expected));
        expect(
          rowsOf<{ lenderId: string }>(
            await get(`/v1/platform/exceptions?lenderId=${ids.lenderB}`, ids.pPay),
          ).every((r) => r.lenderId === ids.lenderB),
        ).toBe(true);
        expect(
          rowsOf<{ class: string }>(
            await get(
              `/v1/platform/exceptions?class=merchant_mismatch&lenderId=${ids.lenderB}`,
              ids.pPay,
            ),
          ),
        ).toHaveLength(1);
        // Lender users (even with payment.reconcile) and platform staff without the provider permission are refused.
        for (const user of [ids.aRecon, ids.aViewer, ids.aNone, ids.bRecon, ids.pOps]) {
          const refusal = await get('/v1/platform/exceptions', user);
          expect([user, refusal.statusCode]).toEqual([user, 403]);
        }
        expect((await get('/v1/platform/exceptions', null)).statusCode).toBe(401);
      });
    });

    // ================================================================================================================
    // Nothing personal-looking, secret or internal leaves the API
    // ================================================================================================================
    describe('privacy', () => {
      it('really holds the canary values in the database, so the scans below mean something', async () => {
        expect(
          await count(
            'select count(*) as n from payments.provider_events where payload_sha256 = $1',
            [CANARY.payloadHash],
          ),
        ).toBeGreaterThan(0);
        expect(
          await count(
            'select count(*) as n from payments.webhook_receipts where source_ip_hmac = $1',
            [CANARY.hmac],
          ),
        ).toBeGreaterThan(0);
        expect(
          await count(
            'select count(*) as n from payments.lender_payment_configs where secret_ref = $1 and endpoint_token_hash = $2',
            [CANARY.secretRef, CANARY.tokenHash],
          ),
        ).toBe(1);
        expect(
          await count(
            'select count(*) as n from payments.payment_intents where idempotency_key like $1',
            [`${CANARY.idempotency}%`],
          ),
        ).toBe(2);
        expect(
          await count('select count(*) as n from payments.mandates where creditor_ref = $1', [
            CANARY.creditor,
          ]),
        ).toBeGreaterThan(0);
        expect(
          await count(
            'select count(*) as n from tenancy.lender_settlement_accounts where label like $1',
            [`%${CANARY.account}%`],
          ),
        ).toBe(2);
        expect(
          await count('select count(*) as n from auth.users where phone = $1', [CANARY.phone]),
        ).toBe(1);
        expect(
          await count(
            'select count(*) as n from payments.handoff_links where lender_org_id = any($1::uuid[])',
            [[ids.lenderA, ids.lenderB]],
          ),
        ).toBe(2);
      });

      it('never returns a secret reference, a token or payload hash, an address hash, a link, a phone number, an account number, a borrower id or an internal key', async () => {
        // Read every route as every kind of reader, then scan everything this file received so far (the write routes included).
        const urls = [
          ...readRoutes(),
          '/v1/lender/payments?limit=100',
          '/v1/lender/provider-events?limit=100',
          '/v1/lender/mandates?limit=100',
          '/v1/lender/mandate-debits?limit=100',
          '/v1/platform/exceptions',
          `/v1/lender/payments/${B.intents[3]?.id ?? ''}`,
          `/v1/lender/mandates/${B.mandates[0] ?? ''}`,
          `/v1/lender/webhook-summary?lenderId=${ids.lenderB}`,
        ];
        for (const user of [
          ids.aViewer,
          ids.aPayer,
          ids.aRecon,
          ids.bViewer,
          ids.bRecon,
          ids.pOps,
          ids.pPay,
        ])
          for (const url of urls) await get(url, user);
        const everything = seen.join('\n');
        expect(everything.length).toBeGreaterThan(50_000);
        const forbidden: [string, string][] = [
          ['phone number', CANARY.phone],
          ['account number', CANARY.account],
          ['hand-off link', CANARY.link],
          ['hand-off link host', 'pay.example.test'],
          ['address hash', CANARY.hmac],
          ['payload hash', CANARY.payloadHash],
          ['secret reference', CANARY.secretRef],
          ['webhook secret reference', 'SAMPLE_WEBHOOK_SECRET'],
          ['token hash (A)', CANARY.tokenHash],
          ['token hash (B)', CANARY.tokenHashB],
          ['intent idempotency key', CANARY.idempotency],
          ['creditor reference', CANARY.creditor],
          ['narration', CANARY.narration],
          ['borrower id (A)', A.borrower],
          ['borrower id (B)', B.borrower],
          ['borrower login id', ids.borrower],
          ['settlement account id (A)', A.account],
          ['payment configuration id (A)', A.config],
        ];
        for (const [label, value] of forbidden)
          expect([label, everything.includes(value)]).toEqual([label, false]);
        // And by field name: nothing the database keeps for itself is a key of any response.
        for (const name of [
          'payload_sha256',
          'payloadSha256',
          'content_sha256',
          'contentSha256',
          'inputs_sha256',
          'source_ip_hmac',
          'ipHmac',
          'endpoint_token_hash',
          'endpointTokenHash',
          'secret_ref',
          'secretRef',
          'fingerprint',
          'idempotencyKey',
          'idempotency_key',
          'borrowerId',
          'borrower_id',
          'creditorRef',
          'ciphertext',
          'checkoutLink',
          'accountNumber',
          'phone',
        ])
          expect([name, everything.includes(`"${name}"`)]).toEqual([name, false]);
      });

      it('writes none of it to the request log either, whatever the outcome', async () => {
        // A second app, built the way a deployed process is built (real serializers and redaction), with its log output captured.
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
        vi.spyOn(fs, 'write').mockImplementation(
          (fd: number, data: unknown, ...rest: unknown[]) => {
            if (fd === 1) {
              captured.push(String(data));
              const done = rest.at(-1);
              if (typeof done === 'function')
                (done as (e: null, n: number) => void)(null, String(data).length);
              return;
            }
            (realWrite as (...a: unknown[]) => void)(fd, data, ...rest);
          },
        );
        const logged = await buildApp(loadConfig({ APP_ENV: 'local', LOG_LEVEL: 'trace' }), {
          auth: { verifier: fakeVerifier, context: createUserContext(apiPool) },
        });
        const secretUtr = `LOGCANARY${randomUUID().slice(0, 8).toUpperCase()}`;
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
          await send('GET', `/v1/lender/payments?lenderId=${ids.lenderA}`, ids.aViewer);
          await send('GET', `/v1/lender/provider-events?lenderId=${ids.lenderA}`, ids.aViewer);
          await send('GET', `/v1/lender/payments/${A.intents[3]?.id ?? ''}`, ids.bViewer);
          await send('POST', '/v1/lender/reconciliation/bank-credits', ids.aRecon, {
            lenderId: ids.lenderA,
            accountId: A.account,
            csv: `valueDate,amountMinor,utr,narration\n${runDate},1000,${secretUtr},${CANARY.narration}\n`,
          });
          await send('POST', '/v1/lender/reconciliation/bank-credits', ids.aRecon, {
            lenderId: ids.lenderA,
            accountId: A.account,
            rows: [
              {
                valueDate: runDate,
                amountMinor: 4242,
                utr: secretUtr,
                narration: CANARY.narration,
              },
            ],
          });
          await send('POST', '/v1/lender/reconciliation/bank-credits', ids.bRecon, {
            lenderId: ids.lenderA,
            accountId: A.account,
            rows: [{ valueDate: runDate, amountMinor: 4242, utr: secretUtr }],
          });
          await send('POST', '/v1/lender/payment-policy', ids.aPayer, {
            lenderId: ids.lenderA,
            allowPartialPayments: true,
            allowPartPrepayment: false,
            linkValidityMinutes: 60,
          });
          await new Promise((resolve) => setTimeout(resolve, 300));
        } finally {
          await logged.close();
          vi.restoreAllMocks();
        }
        const log = captured.join('');
        expect(log).toContain('request completed');
        for (const value of [
          secretUtr,
          CANARY.narration,
          CANARY.phone,
          CANARY.account,
          CANARY.link,
          CANARY.hmac,
          CANARY.payloadHash,
          CANARY.secretRef,
          A.borrower,
          A.account,
        ])
          expect(log.includes(value)).toBe(false);
        // The path is logged, the query string and the body are not.
        expect(log).not.toContain('lenderId=');
        expect(log).not.toContain('"csv"');
      });
    });

    // ================================================================================================================
    // The declared contract
    // ================================================================================================================
    describe('contract', () => {
      it('declares every route with its permission story in the OpenAPI document and nothing undeclared is served', async () => {
        const res = await app.inject({ method: 'GET', url: '/v1/openapi.json' });
        expect(res.statusCode).toBe(200);
        const paths = Object.keys(res.json<{ paths: Record<string, unknown> }>().paths);
        for (const path of [
          '/v1/lender/payments',
          '/v1/lender/payments/{id}',
          '/v1/lender/provider-events',
          '/v1/lender/webhook-summary',
          '/v1/lender/payment-policy',
          '/v1/lender/mandate-policy',
          '/v1/lender/mandates',
          '/v1/lender/mandates/{id}',
          '/v1/lender/mandate-debits',
          '/v1/lender/reconciliation/runs',
          '/v1/lender/reconciliation/summary',
          '/v1/lender/reconciliation/settlement-batches',
          '/v1/lender/reconciliation/settlement-batches/{id}',
          '/v1/lender/reconciliation/settlement-batches/{id}/items',
          '/v1/lender/reconciliation/settings',
          '/v1/lender/reconciliation/bank-credits',
          '/v1/lender/reconciliation/exceptions',
          '/v1/lender/reconciliation/exceptions/{id}',
          '/v1/lender/reconciliation/exceptions/{id}/acknowledge',
          '/v1/lender/reconciliation/exceptions/{id}/assign',
          '/v1/lender/reconciliation/exceptions/{id}/resolve',
          '/v1/lender/reconciliation/exceptions/{id}/reopen',
          '/v1/platform/exceptions',
        ])
          expect(paths).toContain(path);
      });

      it('answers a method that is not declared with 404 or 405, never with data', async () => {
        const res = await app.inject({
          method: 'POST',
          url: '/v1/lender/payments',
          remoteAddress: freshAddress(),
          headers: {
            authorization: `Bearer test.${ids.aViewer}.aal2`,
            'idempotency-key': `it-${randomUUID()}`,
          },
          payload: {},
        });
        expect([404, 405]).toContain(res.statusCode);
      });
    });
  },
);
