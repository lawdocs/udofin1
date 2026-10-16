// SQL wrappers for the scheduled work and the servicing event handlers (Phase 08a, wave 5). Every statement runs as the system role
// (service_role) through SystemPool, one transaction per call. No provider is called from here and no rule is decided here: each wrapper
// passes ids to one database function (or reads a candidate list the system role is allowed to read) and maps the answer.
// Import boundary: only src/system and src/workers may import the system pool, and so this module.
import { type SystemPool } from './pool.js';

export type ReminderChannelName = 'in_app' | 'push' | 'sms';

export interface ClaimedReminder {
  readonly reminderId: string;
  readonly borrowerId: string;
  readonly channel: ReminderChannelName;
}

/** The states servicing.record_reminder_attempt accepts for source `send`. */
export type ReminderSendState = 'accepted' | 'failed' | 'not_configured';
/** The error classes the delivery log allows (a check constraint). */
export type ReminderErrorClass =
  | 'provider_error'
  | 'provider_timeout'
  | 'invalid_target'
  | 'no_consent'
  | 'rate_limited'
  | 'unknown';

/** An intent past its link expiry plus the grace, with no provider payment on file, whose lender runs payments. */
export interface ExpiryCandidate {
  readonly intentId: string;
  readonly lenderOrgId: string;
  readonly configId: string | undefined;
  readonly providerOrderRef: string | undefined;
  /** Exact text of the database timestamp (microseconds kept); handed back to the database unchanged. */
  readonly linkExpiresAt: string;
  /** How long ago the link expired, by the database clock. */
  readonly ageSeconds: number;
}

export interface ExpiryCandidates {
  /** The database instant (as text) the candidate list was cut at: link expiry minus grace. */
  readonly cutoff: string;
  readonly candidates: readonly ExpiryCandidate[];
}

export interface ExpiryBoundary {
  /** The cutoff of the candidate list. Nothing newer than this was looked at. */
  readonly cutoff: string;
  /** Set when the list was truncated: the link expiry of the last candidate that was looked at. */
  readonly truncatedAt: string | undefined;
  /** The link expiry of the oldest intent that must not be expired now. */
  readonly oldestHeld: string | undefined;
}

export interface MandateLookupCandidate {
  readonly mandateId: string;
  readonly lenderOrgId: string;
  readonly configId: string;
  readonly providerMandateRef: string | undefined;
  readonly status: string;
}

export interface ActiveMandate {
  readonly mandateId: string;
  readonly lenderOrgId: string;
  readonly configId: string;
  readonly providerMandateRef: string;
}

export interface ClaimedNotice {
  readonly noticeId: string;
  readonly borrowerId: string;
}

export type NoticeState = 'accepted' | 'delivered' | 'failed' | 'not_configured';

/** The payment configuration facts a provider port is resolved from (names of secrets, never values). */
export interface PaymentConfigFacts {
  readonly configId: string;
  readonly lenderOrgId: string;
  readonly provider: string;
  /** The database vocabulary: `production` is a live configuration. */
  readonly providerMode: 'mock' | 'sandbox' | 'production';
  readonly merchantRef: string;
  readonly secretRef: string;
  readonly webhookSecretRef: string;
}

export interface ExceptionRequest {
  readonly lenderOrgId: string;
  readonly class: 'webhook_gap';
  readonly severity: 'info' | 'warning' | 'critical';
  readonly owner: 'lender' | 'platform';
  /** Ids only: the database refuses anything else. */
  readonly subject: Readonly<Record<string, string>>;
}

/** What the periodic jobs and the servicing handlers may ask of the database. */
export interface JobsStore {
  // Reminders
  planReminders(): Promise<number>;
  claimDueReminders(limit: number): Promise<readonly ClaimedReminder[]>;
  recordReminderAttempt(
    reminderId: string,
    state: ReminderSendState,
    providerRef: string | null,
    errorClass: ReminderErrorClass | null,
  ): Promise<string>;
  // Payments upkeep
  expiryCandidates(graceSeconds: number, limit: number): Promise<ExpiryCandidates>;
  paymentConfig(configId: string): Promise<PaymentConfigFacts | undefined>;
  raiseException(request: ExceptionRequest): Promise<void>;
  /** Expires intents past the boundary. Returns undefined when the boundary needs a grace the database refuses. */
  expireStaleIntents(boundary: ExpiryBoundary): Promise<number | undefined>;
  expireDocumentRequests(cutoff: Date): Promise<number>;
  completeDisbursements(lenderOrgId: string | null): Promise<number>;
  // Mandates
  mandatesNeedingLookup(): Promise<readonly MandateLookupCandidate[]>;
  applyMandateLookup(input: {
    mandateId: string;
    status: string;
    providerMandateRef: string;
    observedAt: string;
  }): Promise<string>;
  activeMandates(): Promise<readonly ActiveMandate[]>;
  applyDebitLookup(input: {
    mandateId: string;
    providerDebitRef: string;
    scheduledOn: string;
    amountMinor: bigint;
    status: string;
    returnCode: string | null;
    observedAt: string;
  }): Promise<string>;
  sweepMandates(): Promise<Readonly<Record<string, number>>>;
  requestCancelForClosedLoans(): Promise<number>;
  planMandateDebits(): Promise<Readonly<Record<string, number>>>;
  claimPreDebitNotices(limit: number): Promise<readonly ClaimedNotice[]>;
  recordPreDebitNotice(
    noticeId: string,
    state: NoticeState,
    providerRef: string | null,
  ): Promise<string>;
  // Configuration, links
  revalidatePaymentConfigs(): Promise<{ checked: number; notOk: number; suspended: number }>;
  purgeHandoffLinks(): Promise<number>;
  // Reconciliation
  activeCollectionConfigs(): Promise<readonly PaymentConfigFacts[]>;
  reconciledDates(lenderOrgId: string, dates: readonly string[]): Promise<ReadonlySet<string>>;
  recordSettlementReport(
    configId: string,
    reportDate: string,
    batches: readonly SettlementBatchJson[],
  ): Promise<Readonly<Record<string, number>>>;
  runReconciliation(
    lenderOrgId: string,
    date: string,
  ): Promise<{ runNo: number | undefined; unchanged: boolean }>;
  // Servicing events
  suppressAndCancelForClosedLoan(
    loanAccountId: string,
  ): Promise<{ suppressed: number; cancelRequested: number }>;
}

/** The JSON payments.record_settlement_report reads: money as digit strings of paise. */
export interface SettlementBatchJson {
  readonly batchRef: string;
  readonly settlementRef: string;
  readonly periodFrom: string;
  readonly periodTo: string;
  readonly destinationMaskedRef: string | null;
  readonly grossMinor: string;
  readonly feeMinor: string;
  readonly taxMinor: string;
  readonly netMinor: string;
  readonly items: readonly {
    readonly providerPaymentRef: string;
    readonly orderRef: string | null;
    readonly grossMinor: string;
    readonly feeMinor: string;
    readonly taxMinor: string;
    readonly netMinor: string;
  }[];
}

const REMINDER_CHANNELS: readonly ReminderChannelName[] = ['in_app', 'push', 'sms'];
const PROVIDER_MODES: readonly PaymentConfigFacts['providerMode'][] = [
  'mock',
  'sandbox',
  'production',
];

function reminderChannel(value: string): ReminderChannelName {
  const found = REMINDER_CHANNELS.find((channel) => channel === value);
  if (found === undefined) throw new TypeError('unknown reminder channel');
  return found;
}

function providerMode(value: string): PaymentConfigFacts['providerMode'] {
  const found = PROVIDER_MODES.find((mode) => mode === value);
  if (found === undefined) throw new TypeError('unknown provider mode');
  return found;
}

function count(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new TypeError('count out of range');
  return n;
}

/** Counts out of a jsonb object of integers (the sweep and planning functions return these). */
function countsOf(value: unknown): Readonly<Record<string, number>> {
  const out: Record<string, number> = {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return out;
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'number' && Number.isSafeInteger(entry) && entry >= 0) out[key] = entry;
  }
  return out;
}

interface ConfigRow {
  config_id: string;
  lender_org_id: string;
  provider: string;
  provider_mode: string;
  merchant_ref: string;
  secret_ref: string;
  webhook_secret_ref: string;
}

const CONFIG_SELECT = `
  select c.id as config_id, c.lender_org_id, c.provider, c.provider_mode::text as provider_mode, m.merchant_ref, c.secret_ref, c.webhook_secret_ref
    from payments.lender_payment_configs c
    join payments.merchant_registry m on m.id = c.merchant_registry_id and m.owner_org_id = c.lender_org_id`;

function configFacts(row: ConfigRow): PaymentConfigFacts {
  return {
    configId: row.config_id,
    lenderOrgId: row.lender_org_id,
    provider: row.provider,
    providerMode: providerMode(row.provider_mode),
    merchantRef: row.merchant_ref,
    secretRef: row.secret_ref,
    webhookSecretRef: row.webhook_secret_ref,
  };
}

export function createJobsStore(pool: SystemPool): JobsStore {
  const rows = <T extends object>(sql: string, values: unknown[] = []): Promise<T[]> =>
    pool.withSystem(async (tx) => (await tx.query<T>(sql, values)).rows);
  const scalar = async <T>(sql: string, values: unknown[] = []): Promise<T | undefined> => {
    const result = await rows<{ r: T }>(sql, values);
    return result[0]?.r;
  };

  return {
    // -- Reminders ------------------------------------------------------------------------------------------------------
    async planReminders() {
      return count(await scalar<number>('select servicing.plan_reminders() as r'));
    },
    async claimDueReminders(limit) {
      const claimed = await rows<{ reminder_id: string; borrower_id: string; channel: string }>(
        'select reminder_id, borrower_id, channel from servicing.claim_due_reminders($1::integer)',
        [limit],
      );
      return claimed.map((row) => ({
        reminderId: row.reminder_id,
        borrowerId: row.borrower_id,
        channel: reminderChannel(row.channel),
      }));
    },
    async recordReminderAttempt(reminderId, state, providerRef, errorClass) {
      const answer = await scalar<string>(
        `select servicing.record_reminder_attempt($1::uuid, $2, 'send', $3, $4) as r`,
        [reminderId, state, providerRef, errorClass],
      );
      return answer ?? 'unknown';
    },

    // -- Payments upkeep ------------------------------------------------------------------------------------------------
    async expiryCandidates(graceSeconds, limit) {
      return pool.withSystem(async (tx) => {
        const cut = await tx.query<{ cutoff: string }>(
          `select (clock_timestamp() - make_interval(secs => $1::double precision))::text as cutoff`,
          [graceSeconds],
        );
        const cutoff = cut.rows[0]?.cutoff;
        if (cutoff === undefined) throw new TypeError('no database clock');
        // Only lenders whose payments switch is on: no provider is looked up for any other (the database function that
        // expires intents does not look at the switch; see the notes for the consequence).
        const found = await tx.query<{
          intent_id: string;
          lender_org_id: string;
          config_id: string | null;
          provider_order_ref: string | null;
          link_expires_at: string;
          age_seconds: string;
        }>(
          `select i.id as intent_id, i.lender_org_id, i.config_id, i.provider_order_ref, i.link_expires_at::text as link_expires_at,
                  extract(epoch from (clock_timestamp() - i.link_expires_at))::text as age_seconds
             from payments.payment_intents i
            where i.status in ('created', 'pending') and i.link_expires_at is not null and i.link_expires_at < $1::timestamptz
              and not exists (select 1 from payments.provider_payments pp where pp.intent_id = i.id and pp.lender_org_id = i.lender_org_id)
              and private.feature_enabled(i.lender_org_id, 'payments')
            order by i.link_expires_at, i.id
            limit $2::integer`,
          [cutoff, limit],
        );
        return {
          cutoff,
          candidates: found.rows.map((row) => ({
            intentId: row.intent_id,
            lenderOrgId: row.lender_org_id,
            configId: row.config_id ?? undefined,
            providerOrderRef: row.provider_order_ref ?? undefined,
            linkExpiresAt: row.link_expires_at,
            ageSeconds: Number(row.age_seconds),
          })),
        };
      });
    },
    async paymentConfig(configId) {
      const found = await rows<ConfigRow>(`${CONFIG_SELECT} where c.id = $1::uuid`, [configId]);
      const row = found[0];
      return row ? configFacts(row) : undefined;
    },
    async raiseException(request) {
      await rows(`select payments.raise_exception($1::uuid, $2, $3, $4, $5::jsonb) as r`, [
        request.lenderOrgId,
        request.class,
        request.severity,
        request.owner,
        JSON.stringify(request.subject),
      ]);
    },
    async expireStaleIntents(boundary) {
      // payments.expire_stale_intents(grace) takes no list of intents to leave alone, so the boundary is expressed through the
      // grace: it expires an intent only if its link expired before (now - grace). The boundary is the oldest of: the cutoff of
      // the list that was looked at, the last intent looked at when the list was cut short, and the oldest intent held back; a
      // second of margin covers the time between this expression and the function's own clock reading. A grace the function
      // refuses (more than seven days) means nothing can be expired safely now.
      const margin = `interval '1 second'`;
      const answer = await scalar<string | null>(
        `with b as (
           select least($1::timestamptz - ${margin}, $2::timestamptz - ${margin}, $3::timestamptz - ${margin}) as boundary
         ), g as (
           select clock_timestamp() - b.boundary as grace from b
         )
         select case when g.grace between interval '0' and interval '7 days' then payments.expire_stale_intents(g.grace)::text end as r from g`,
        [boundary.cutoff, boundary.truncatedAt ?? null, boundary.oldestHeld ?? null],
      );
      return answer === null || answer === undefined ? undefined : count(answer);
    },
    async expireDocumentRequests(cutoff) {
      return count(
        await scalar<number>(`select servicing.expire_document_requests($1::timestamptz) as r`, [
          cutoff.toISOString(),
        ]),
      );
    },
    async completeDisbursements(lenderOrgId) {
      return count(
        await scalar<number>(`select servicing.complete_disbursements($1::uuid) as r`, [
          lenderOrgId,
        ]),
      );
    },

    // -- Mandates -------------------------------------------------------------------------------------------------------
    async mandatesNeedingLookup() {
      // payments.mandates_needing_lookup does not look at the lender's switch; the filter here keeps a provider from being
      // called for a lender whose mandates switch is off.
      const found = await rows<{
        mandate_id: string;
        lender_org_id: string;
        config_id: string;
        provider_mandate_ref: string | null;
        status: string;
      }>(
        `select n.mandate_id, n.lender_org_id, m.config_id, n.provider_mandate_ref, n.status
           from payments.mandates_needing_lookup() n
           join payments.mandates m on m.id = n.mandate_id and m.lender_org_id = n.lender_org_id
          where private.feature_enabled(n.lender_org_id, 'mandates')`,
      );
      return found.map((row) => ({
        mandateId: row.mandate_id,
        lenderOrgId: row.lender_org_id,
        configId: row.config_id,
        providerMandateRef: row.provider_mandate_ref ?? undefined,
        status: row.status,
      }));
    },
    async applyMandateLookup(input) {
      const answer = await scalar<string>(
        `select payments.apply_mandate_lookup($1::uuid, $2, $3, $4::timestamptz) as r`,
        [input.mandateId, input.status, input.providerMandateRef, input.observedAt],
      );
      return answer ?? 'unknown';
    },
    async activeMandates() {
      const found = await rows<{
        mandate_id: string;
        lender_org_id: string;
        config_id: string;
        provider_mandate_ref: string;
      }>(
        `select m.id as mandate_id, m.lender_org_id, m.config_id, m.provider_mandate_ref
           from payments.mandates m
          where m.status = 'active' and m.provider_mandate_ref is not null and private.feature_enabled(m.lender_org_id, 'mandates')
          order by m.id`,
      );
      return found.map((row) => ({
        mandateId: row.mandate_id,
        lenderOrgId: row.lender_org_id,
        configId: row.config_id,
        providerMandateRef: row.provider_mandate_ref,
      }));
    },
    async applyDebitLookup(input) {
      const answer = await scalar<string>(
        `select payments.apply_debit_lookup($1::uuid, $2, $3::date, $4::bigint, $5, $6, $7::timestamptz) as r`,
        [
          input.mandateId,
          input.providerDebitRef,
          input.scheduledOn,
          input.amountMinor.toString(),
          input.status,
          input.returnCode,
          input.observedAt,
        ],
      );
      return answer ?? 'unknown';
    },
    async sweepMandates() {
      return countsOf(await scalar<unknown>('select payments.sweep_mandates() as r'));
    },
    async requestCancelForClosedLoans() {
      return count(await scalar<number>('select payments.request_cancel_for_closed_loans() as r'));
    },
    async planMandateDebits() {
      return countsOf(await scalar<unknown>('select payments.plan_mandate_debits() as r'));
    },
    async claimPreDebitNotices(limit) {
      const claimed = await rows<{ notice_id: string; borrower_id: string }>(
        'select notice_id, borrower_id from payments.claim_pre_debit_notices($1::integer)',
        [limit],
      );
      return claimed.map((row) => ({ noticeId: row.notice_id, borrowerId: row.borrower_id }));
    },
    async recordPreDebitNotice(noticeId, state, providerRef) {
      const answer = await scalar<string>(
        'select payments.record_pre_debit_notice($1::uuid, $2, $3) as r',
        [noticeId, state, providerRef],
      );
      return answer ?? 'unknown';
    },

    // -- Configuration, links -------------------------------------------------------------------------------------------
    async revalidatePaymentConfigs() {
      const found = await rows<{ ok: boolean; suspended: boolean }>(
        'select ok, suspended from payments.revalidate_payment_configs()',
      );
      return {
        checked: found.length,
        notOk: found.filter((row) => !row.ok).length,
        suspended: found.filter((row) => row.suspended).length,
      };
    },
    async purgeHandoffLinks() {
      return count(await scalar<number>('select payments.purge_handoff_links() as r'));
    },

    // -- Reconciliation -------------------------------------------------------------------------------------------------
    async activeCollectionConfigs() {
      const found = await rows<ConfigRow>(
        `${CONFIG_SELECT} where c.status = 'active' and private.feature_enabled(c.lender_org_id, 'payments') order by c.lender_org_id, c.id`,
      );
      return found.map(configFacts);
    },
    async reconciledDates(lenderOrgId, dates) {
      const found = await rows<{ run_date: string }>(
        `select distinct run_date::text as run_date from payments.reconciliation_runs where lender_org_id = $1::uuid and run_date = any($2::date[])`,
        [lenderOrgId, [...dates]],
      );
      return new Set(found.map((row) => row.run_date));
    },
    async recordSettlementReport(configId, reportDate, batches) {
      return countsOf(
        await scalar<unknown>(
          `select payments.record_settlement_report($1::uuid, $2::date, $3::jsonb) as r`,
          [configId, reportDate, JSON.stringify(batches)],
        ),
      );
    },
    async runReconciliation(lenderOrgId, date) {
      const answer = await scalar<{ run_no?: unknown; unchanged?: unknown }>(
        `select payments.run_reconciliation($1::uuid, $2::date) as r`,
        [lenderOrgId, date],
      );
      return {
        runNo:
          typeof answer?.run_no === 'number' && Number.isSafeInteger(answer.run_no)
            ? answer.run_no
            : undefined,
        unchanged: answer?.unchanged === true,
      };
    },

    // -- Servicing events -----------------------------------------------------------------------------------------------
    async suppressAndCancelForClosedLoan(loanAccountId) {
      // One transaction: either both happen or the event is retried.
      return pool.withSystem(async (tx) => {
        const suppressed = await tx.query<{ r: number }>(
          `select servicing.suppress_reminders_for_loan($1::uuid, 'loan_closed') as r`,
          [loanAccountId],
        );
        const cancelled = await tx.query<{ r: number }>(
          'select payments.request_cancel_for_closed_loans() as r',
        );
        return {
          suppressed: count(suppressed.rows[0]?.r),
          cancelRequested: count(cancelled.rows[0]?.r),
        };
      });
    },
  };
}
