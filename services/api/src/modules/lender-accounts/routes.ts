import { createHash, randomBytes } from 'node:crypto';
import {
  AccountFingerprintError,
  fingerprintAccount,
  type AccountFingerprint,
  type AccountFormatRule,
} from '@udofin/adapters';
import {
  AccountFormatRuleApproveInput,
  AccountFormatRuleCreated,
  AccountFormatRuleDraftInput,
  AccountFormatRuleList,
  AccountFormatRuleQuery,
  AccountsActionResult,
  AccountsReasonInput,
  FeatureCatalogList,
  FeatureChangeCancelled,
  FeatureChangeDecided,
  FeatureChangeDecisionInput,
  FeatureChangeRequestInput,
  FeatureChangeRequestPage,
  FeatureChangeRequestQuery,
  FeatureChangeRequested,
  FeatureKillInput,
  FeatureKilled,
  FeatureSwitchList,
  FingerprintKeyVersionApproveInput,
  FingerprintKeyVersionList,
  FingerprintKeyVersionProposalInput,
  FingerprintKeyVersionResult,
  LenderFeatureQuery,
  MerchantClaimInput,
  MerchantClaimed,
  MerchantPage,
  MerchantQuery,
  MerchantRegistered,
  MerchantVerifyInput,
  PaymentConfigDecisionInput,
  PaymentConfigDraftInput,
  PaymentConfigDrafted,
  PaymentConfigEntry,
  PaymentConfigHistory,
  PaymentConfigPage,
  PaymentConfigQuery,
  PaymentProviderChoiceList,
  PaymentProviderInput,
  PaymentProviderList,
  PaymentProviderSet,
  RegistryAccountEntry,
  RegistryAccountPage,
  RegistryAccountQuery,
  RegistryAccountRegisterInput,
  RegistryAccountRegistered,
  RegistryAccountVerifyInput,
  ReturnCodeClassInput,
  ReturnCodeClassList,
  ReturnCodeClassQuery,
  ReturnCodeClassSet,
  SettlementAccountLinkInput,
  SettlementAccountPage,
  SettlementAccountQuery,
  SettlementAccountRequestInput,
  SettlementAccountRequested,
  LenderSettlementAccountQuery,
  SettlementAccountRegistryStatusList,
  UdofinFeeMerchantInput,
} from '@udofin/contracts';
import { type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { columns } from '../../db/columns.js';
import { type UserTx } from '../../db/user-context.js';
import { ApiError } from '../../http/api-error.js';
import { decodeCursor, encodeCursor } from '../../http/pagination.js';
import { userRoute, type RouteDefinition } from '../../http/routes.js';
import { AccountSecret, type FingerprintKeySource } from './fingerprint-keys.js';

/** What the routes of this module need from the process. Absent keys: registering an account answers 503 (fail closed). */
export interface LenderAccountsDeps {
  fingerprintKeys?: FingerprintKeySource;
}

const WRITE_LIMIT = { max: 40, timeWindow: '1 minute' };
const READ_LIMIT = { max: 120, timeWindow: '1 minute' };
/** The one request that carries an account number is kept deliberately scarce. */
const REGISTER_LIMIT = { max: 12, timeWindow: '1 minute' };

const Id = z.strictObject({ id: z.uuid() });
const KeyVersionParam = z.strictObject({ version: z.coerce.number().int().min(1).max(1000) });
const LenderParam = z.strictObject({ lenderId: z.uuid() });

const PLATFORM_PROVIDERS = 'platform.payments.providers.manage';
const PLATFORM_REGISTRY_MANAGE = 'platform.accounts.registry.manage';
const PLATFORM_REGISTRY_VERIFY = 'platform.accounts.registry.verify';
const PLATFORM_FEATURES = 'platform.features.manage';
const LENDER_PAYMENT_ROLES = ['payment.configure', 'payment.config.approve', 'payment.read'];

// ---- small helpers ------------------------------------------------------------------------------------------------

/** ISO text (with offset) of a timestamp column. */
const ts = (column: string): string => `(to_jsonb(${column}) #>> '{}')`;
/** Calendar date as text; the driver would otherwise hand back a JavaScript Date. */
const day = (column: string): string => `${column}::text`;

async function one<T>(tx: UserTx, sql: string, values: readonly unknown[]): Promise<T> {
  const result = await tx.query<{ r: T }>(sql, values);
  const row = result.rows[0];
  if (!row) throw new Error('database function returned nothing');
  return row.r;
}

/** The caller must hold at least one of these platform permissions; otherwise 403 (reads would otherwise answer an empty list). */
async function requirePlatform(tx: UserTx, permissions: readonly string[]): Promise<void> {
  const result = await tx.query<{ ok: boolean }>(
    'select coalesce(bool_or(private.has_platform_permission(p)), false) as ok from unnest($1::text[]) as p',
    [permissions],
  );
  if (!result.rows[0]?.ok) throw new ApiError(403, 'forbidden', 'Forbidden');
}

/** The caller must hold at least one of these permissions in a lender (the given one, or any); otherwise 403. */
async function requireLenderPermission(
  tx: UserTx,
  permissions: readonly string[],
  lenderId: string | undefined,
): Promise<void> {
  const result = await tx.query<{ ok: boolean }>(
    `select exists (
       select 1 from unnest($1::text[]) as p, lateral private.orgs_with_permission(p) as o
        where $2::uuid is null or o = $2::uuid) as ok`,
    [permissions, lenderId ?? null],
  );
  if (!result.rows[0]?.ok) throw new ApiError(403, 'forbidden', 'Forbidden');
}

const notFound = (): ApiError => new ApiError(404, 'not_found', 'Not Found');

/** The response goes through its schema so a column that is not declared can never reach the client. */
const out = <T extends z.ZodType>(schema: T, value: unknown): z.output<T> => schema.parse(value);

interface PgLike {
  code?: string;
  hint?: string;
  message?: string;
}

/**
 * Two refusals carry the list of reasons (stable identifiers only, never data) in the database message: a configuration whose
 * collection target does not validate, and a feature whose prerequisites are not met. Show the identifiers so the person can fix
 * what is missing; everything else is mapped by the shared error mapper.
 */
async function withReasons<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const e = error as PgLike | null;
    if (
      e?.code === '55000' &&
      (e.hint === 'collection_target_invalid' || e.hint === 'prerequisites_unmet') &&
      typeof e.message === 'string'
    ) {
      const reasons = e.message
        .slice(e.message.indexOf(':') + 1)
        .split(',')
        .map((part) => part.trim())
        .filter((part) => /^[a-z][a-z0-9_]{1,63}$/.test(part))
        .slice(0, 10);
      throw new ApiError(
        409,
        e.hint,
        'Conflict',
        reasons.length > 0 ? `Reasons: ${reasons.join(', ')}` : undefined,
      );
    }
    throw error;
  }
}

interface PageSpec {
  columns: string;
  from: string;
  sortColumn: string;
  where: string[];
  values: unknown[];
}

/** Keyset page over (sortColumn, id), newest first. Row-level security still decides what is visible. */
async function keysetPage<R extends { id: string }>(
  tx: UserTx,
  spec: PageSpec,
  query: { limit: number; cursor?: string | undefined },
): Promise<{ items: R[]; nextCursor: string | null }> {
  const values = [...spec.values];
  const where = [...spec.where];
  const cursor = decodeCursor(query.cursor);
  if (cursor) {
    values.push(cursor.t, cursor.id);
    where.push(
      `(${spec.sortColumn}, id) < ($${String(values.length - 1)}::timestamptz, $${String(values.length)}::uuid)`,
    );
  }
  values.push(query.limit + 1);
  const result = await tx.query<R & { sortAt: string }>(
    `select ${spec.columns}, ${ts(spec.sortColumn)} as "sortAt" from ${spec.from}
      ${where.length > 0 ? `where ${where.join(' and ')}` : ''}
      order by ${spec.sortColumn} desc, id desc limit $${String(values.length)}`,
    values,
  );
  const rows = result.rows.slice(0, query.limit);
  const last = result.rows.length > query.limit ? rows[rows.length - 1] : undefined;
  return {
    items: rows,
    nextCursor: last ? encodeCursor({ t: last.sortAt, id: last.id }) : null,
  };
}

/** Best effort: the parsed request keeps the raw JSON until it ends; empty the two secret fields and the raw text. */
function scrubAccountRequest(request: FastifyRequest): void {
  try {
    const holder = request as { body?: unknown; rawBody?: string };
    if (holder.body && typeof holder.body === 'object') {
      const raw = holder.body as Record<string, unknown>;
      for (const field of ['accountNumber', 'ifsc']) if (field in raw) raw[field] = '';
    }
    holder.rawBody = '';
  } catch {
    // The values are also dropped by AccountSecret.wipe(); a frozen request object must not break the request.
  }
}

/** The endpoint token is 32 random bytes, URL-safe; only its SHA-256 (hex) is stored. Matches the callback receiver's hash. */
function newEndpointToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: createHash('sha256').update(token, 'utf8').digest('hex') };
}

// ---- column lists (explicit: a column that is not named here cannot leave the database) ---------------------------------

const PROVIDER_COLUMNS = columns({
  provider: 'provider',
  displayName: 'display_name',
  kind: 'kind',
  status: 'status',
  authorisationEvidenceRef: 'authorisation_evidence_ref',
  evidenceLabel: 'evidence_label',
  statusReason: 'status_reason',
  updatedAt: ts('updated_at'),
});
const RULE_COLUMNS = columns({
  id: 'id',
  country: 'country::text',
  accountType: 'account_type',
  version: 'version',
  minDigits: 'min_digits',
  maxDigits: 'max_digits',
  ifscRequired: 'ifsc_required',
  status: 'status',
  evidenceLabel: 'evidence_label',
  sourceNote: 'source_note',
  effectiveFrom: day('effective_from'),
  effectiveTo: day('effective_to'),
  draftedBy: 'drafted_by',
  submittedBy: 'submitted_by',
  approvedBy: 'approved_by',
  approvedAt: ts('approved_at'),
  retiredAt: ts('retired_at'),
  retiredReason: 'retired_reason',
  createdAt: ts('created_at'),
});
const KEY_VERSION_COLUMNS = columns({
  keyVersion: 'key_version',
  status: 'status',
  proposedBy: 'proposed_by',
  proposedAt: ts('proposed_at'),
  approvedBy: 'approved_by',
  approvedAt: ts('approved_at'),
  retiredAt: ts('retired_at'),
  note: 'note',
});
/** Never `fingerprint`: the registry answers with the masked reference only. */
const REGISTRY_COLUMNS = columns({
  id: 'id',
  maskedRef: 'masked_ref',
  keyVersion: 'key_version',
  rekeyedFromId: 'rekeyed_from_id',
  country: 'country::text',
  accountType: 'account_type',
  formatRuleId: 'format_rule_id',
  ownerKind: 'owner_kind',
  ownerOrgId: 'owner_org_id',
  legalOwnerName: 'legal_owner_name',
  permittedPurposes: 'permitted_purposes',
  verificationStatus: 'verification_status',
  evidenceRef: 'evidence_ref',
  effectiveFrom: day('effective_from'),
  effectiveTo: day('effective_to'),
  registeredBy: 'registered_by',
  registeredAt: ts('registered_at'),
  verifiedBy: 'verified_by',
  verifiedAt: ts('verified_at'),
  rejectedAt: ts('rejected_at'),
  rejectionReason: 'rejection_reason',
  revokedAt: ts('revoked_at'),
  revokedReason: 'revoked_reason',
});
const SETTLEMENT_COLUMNS = columns({
  id: 'id',
  lenderId: 'lender_org_id',
  label: 'label',
  bankName: 'bank_name',
  maskedRef: 'masked_account_ref',
  status: 'status::text',
  registryId: 'registry_id',
  createdAt: ts('created_at'),
});
const MERCHANT_COLUMNS = columns({
  id: 'id',
  provider: 'provider',
  merchantRef: 'merchant_ref',
  ownerKind: 'owner_kind',
  ownerOrgId: 'owner_org_id',
  purpose: 'purpose',
  status: 'status',
  verificationStatus: 'verification_status',
  verificationEvidenceRef: 'verification_evidence_ref',
  claimedAt: ts('claimed_at'),
  verifiedAt: ts('verified_at'),
  revokedAt: ts('revoked_at'),
  revokedReason: 'revoked_reason',
});
/** Never `endpoint_token_hash` or `idempotency_key`. */
const CONFIG_COLUMNS = columns({
  id: 'id',
  lenderId: 'lender_org_id',
  provider: 'provider',
  providerMode: 'provider_mode',
  merchantRegistryId: 'merchant_registry_id',
  settlementAccountId: 'settlement_account_id',
  secretRef: 'secret_ref',
  webhookSecretRef: 'webhook_secret_ref',
  railLimits: 'rail_limits',
  railLimitsSource: 'rail_limits_source',
  evidenceRef: 'evidence_ref',
  contractSectionRef: 'contract_section_ref',
  status: 'status',
  draftedBy: 'drafted_by',
  draftedAt: ts('drafted_at'),
  submittedBy: 'submitted_by',
  submittedAt: ts('submitted_at'),
  approvedBy: 'approved_by',
  approvedAt: ts('approved_at'),
  statusReason: 'status_reason',
  statusReasons: "coalesce(status_reasons, '{}'::text[])",
  lastValidatedAt: ts('last_validated_at'),
  lastValidationOk: 'last_validation_ok',
  updatedAt: ts('updated_at'),
});
const CHANGE_REQUEST_COLUMNS = columns({
  id: 'id',
  lenderId: 'lender_org_id',
  feature: 'feature',
  enable: 'enable',
  mode: 'mode',
  status: 'status',
  evidence: "coalesce(evidence, '{}'::jsonb)",
  reason: 'reason',
  requestedBy: 'requested_by',
  requestedAt: ts('requested_at'),
  expiresAt: ts('expires_at'),
  decidedBy: 'decided_by',
  decidedAt: ts('decided_at'),
  decisionNote: 'decision_note',
  appliedAt: ts('applied_at'),
});

/** The approved, effective format rule of the database for a country and account type (at most one: approving retires the older). */
async function approvedRule(
  tx: UserTx,
  country: string,
  accountType: string,
): Promise<AccountFormatRule> {
  const result = await tx.query<{
    id: string;
    country: string;
    accountType: string;
    minDigits: number;
    maxDigits: number;
    evidenceLabel: string;
    sourceNote: string;
  }>(
    `select id, country::text as country, account_type as "accountType", min_digits as "minDigits", max_digits as "maxDigits",
            evidence_label as "evidenceLabel", source_note as "sourceNote"
       from payments.account_format_rules
      where country = $1 and account_type = $2 and status = 'approved'
        and effective_from <= (now() at time zone 'Asia/Kolkata')::date
        and (effective_to is null or effective_to > (now() at time zone 'Asia/Kolkata')::date)
      order by version desc limit 1`,
    [country, accountType],
  );
  const row = result.rows[0];
  if (!row) throw new ApiError(409, 'account_format_unvalidated', 'Conflict');
  // The adapter's `status` is the EVIDENCE label (a source is on file), not the database approval state: that was checked above.
  const sourced = row.evidenceLabel === 'confirmed';
  return {
    ruleId: row.id,
    country: row.country,
    accountType: row.accountType,
    minDigits: row.minDigits,
    maxDigits: row.maxDigits,
    status: sourced ? 'verified' : 'unverified',
    source: sourced ? row.sourceNote : null,
  };
}

/** One row per (lender, catalogue feature): the stored switch, off when there is no row or the catalogue says it cannot be enabled. */
/**
 * One row per catalogue feature: the stored switch, off when there is no row or the catalogue says it cannot be enabled. The
 * platform view takes the lender id as given (a features administrator cannot read organisations, so an unknown lender looks like
 * one with every switch off; requests and kills for it answer 404). The lender view lists the lenders the caller may read.
 */
const SWITCH_COLUMNS = `
  (coalesce(f.enabled, false) and c.enableable) as enabled, c.enableable,
  ${ts('f.enabled_at')} as "enabledAt", ${ts('f.disabled_at')} as "disabledAt"`;
const PLATFORM_SWITCH_SQL = `
  select $1::uuid as "lenderId", c.feature, ${SWITCH_COLUMNS}
    from servicing.feature_catalog c
    left join servicing.lender_features f on f.lender_org_id = $1::uuid and f.feature = c.feature
   order by c.feature`;
const LENDER_SWITCH_SQL = `
  with mine as (
    select o as lender from private.orgs_with_permission('loan.read') o
    union select o from private.orgs_with_permission('payment.read') o)
  select m.lender as "lenderId", c.feature, ${SWITCH_COLUMNS}
    from mine m
    join tenancy.organizations org on org.id = m.lender and org.kind = 'lender'
   cross join servicing.feature_catalog c
    left join servicing.lender_features f on f.lender_org_id = m.lender and f.feature = c.feature
   where $1::uuid is null or m.lender = $1::uuid
   order by m.lender, c.feature`;

const keyUnavailable = (): ApiError =>
  new ApiError(
    503,
    'key_management_unavailable',
    'Service Unavailable',
    'No account fingerprint key is available in this environment.',
  );

/**
 * Providers, the account registry, merchants, payment configurations and per-lender feature switches. Every rule is in the
 * database functions (permissions, aal2, two-person approval, tenant isolation, the fail-closed registry, the switches that can
 * never turn on). These routes validate the shape of a request, take the caller from the token, pass identifiers and map the
 * answer; the only work done here is what the database cannot do: computing the keyed fingerprint of an account number it must
 * never see, and generating the opaque callback token whose hash it stores.
 */
export function lenderAccountsRoutes(deps: LenderAccountsDeps = {}): RouteDefinition[] {
  const keys = deps.fingerprintKeys;

  // The registration body: the number and IFSC are sealed into an AccountSecret as the body is parsed, so the idempotency layer
  // hashes only the bank code, the length and the last four digits, and nothing can print or serialise the number afterwards.
  const RegisterBody = RegistryAccountRegisterInput.transform(
    ({ accountNumber, ifsc, ...rest }) => ({
      ...rest,
      account: new AccountSecret(accountNumber, ifsc),
    }),
  );

  const configList = (path: string, operationId: string, platform: boolean): RouteDefinition =>
    userRoute({
      method: 'get',
      path,
      operationId,
      summary: platform
        ? 'Payment configurations of every lender (platform)'
        : "The lender's payment configurations, newest first",
      description:
        'The callback token hash and the idempotency key are never returned; secrets appear only as the NAMES of secrets. Keyset pagination.',
      tags: [platform ? 'Platform payments' : 'Lender payments'],
      auth: 'staff',
      query: PaymentConfigQuery,
      responses: { 200: PaymentConfigPage },
      errors: [401, 403, 422],
      rateLimit: READ_LIMIT,
      handler: async ({ tx, query }) => {
        if (platform) await requirePlatform(tx, [PLATFORM_PROVIDERS]);
        else await requireLenderPermission(tx, LENDER_PAYMENT_ROLES, query.lenderId);
        const where: string[] = [];
        const values: unknown[] = [];
        if (query.lenderId) {
          values.push(query.lenderId);
          where.push(`lender_org_id = $${String(values.length)}::uuid`);
        }
        if (query.status) {
          values.push(query.status);
          where.push(`status = $${String(values.length)}`);
        }
        const page = await keysetPage(
          tx,
          {
            columns: CONFIG_COLUMNS,
            from: 'payments.lender_payment_configs',
            sortColumn: 'created_at',
            where,
            values,
          },
          query,
        );
        return { status: 200, body: out(PaymentConfigPage, page) };
      },
    });

  const configOne = (path: string, operationId: string, platform: boolean): RouteDefinition =>
    userRoute({
      method: 'get',
      path,
      operationId,
      summary: platform
        ? 'One payment configuration (platform)'
        : 'One payment configuration of the lender',
      tags: [platform ? 'Platform payments' : 'Lender payments'],
      auth: 'staff',
      params: Id,
      responses: { 200: PaymentConfigEntry },
      errors: [401, 403, 404],
      rateLimit: READ_LIMIT,
      handler: async ({ tx, params }) => {
        if (platform) await requirePlatform(tx, [PLATFORM_PROVIDERS]);
        else await requireLenderPermission(tx, LENDER_PAYMENT_ROLES, undefined);
        const result = await tx.query(
          `select ${CONFIG_COLUMNS} from payments.lender_payment_configs where id = $1::uuid`,
          [params.id],
        );
        if (!result.rows[0]) throw notFound();
        return { status: 200, body: out(PaymentConfigEntry, result.rows[0]) };
      },
    });

  /** The platform kill switch. Also reachable under the lender path (same function, same permission: a lender user is refused). */
  const suspendRoute = (path: string, operationId: string, tag: string): RouteDefinition =>
    userRoute({
      method: 'post',
      path,
      operationId,
      summary:
        'Platform kill switch: suspend an active configuration (platform.payments.providers.manage, aal2, one person)',
      description:
        'A suspended configuration needs a fresh two-person approval before it can be used again. Only a platform person with the provider permission can do this; a lender user is refused.',
      tags: [tag],
      auth: 'staff',
      idempotent: true,
      params: Id,
      body: AccountsReasonInput,
      responses: { 200: AccountsActionResult },
      errors: [400, 401, 403, 404, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params, body }) => {
        const status = await one<string>(
          tx,
          'select payments.suspend_payment_config($1::uuid, $2) as r',
          [params.id, body.reason],
        );
        return { status: 200, body: out(AccountsActionResult, { id: params.id, status }) };
      },
    });

  return [
    // ---- payment providers and return-code classes (platform) -------------------------------------------------------
    userRoute({
      method: 'get',
      path: '/v1/platform/payment-providers',
      operationId: 'listPaymentProviders',
      summary:
        'The provider register: who may be used for payments or mandates, and the evidence behind it',
      tags: ['Platform payments'],
      auth: 'staff',
      responses: { 200: PaymentProviderList },
      errors: [401, 403],
      rateLimit: READ_LIMIT,
      handler: async ({ tx }) => {
        await requirePlatform(tx, [PLATFORM_PROVIDERS]);
        const result = await tx.query(
          `select ${PROVIDER_COLUMNS} from payments.provider_register order by provider`,
        );
        return { status: 200, body: out(PaymentProviderList, { items: result.rows }) };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/platform/payment-providers',
      operationId: 'setPaymentProvider',
      summary:
        'Register or update a payment or mandate provider (platform.payments.providers.manage, aal2)',
      description:
        'An upsert by provider key. Nothing is seeded: until a provider is registered and approved no configuration can validate. A provider used in production mode needs an authorisation evidence reference.',
      tags: ['Platform payments'],
      auth: 'staff',
      idempotent: true,
      body: PaymentProviderInput,
      responses: { 200: PaymentProviderSet },
      errors: [400, 401, 403, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, body }) => {
        const status = await one<string>(
          tx,
          'select payments.set_payment_provider($1, $2, $3, $4, $5, $6, $7) as r',
          [
            body.provider,
            body.displayName,
            body.kind,
            body.status,
            body.authorisationEvidenceRef,
            body.evidenceLabel,
            body.reason ?? null,
          ],
        );
        return { status: 200, body: out(PaymentProviderSet, { provider: body.provider, status }) };
      },
    }),
    userRoute({
      method: 'get',
      path: '/v1/lender/payment-providers',
      operationId: 'listPaymentProviderChoices',
      summary: 'The approved providers a lender can draft a payment configuration for',
      description:
        'Name, kind and status only; the authorisation evidence stays with the platform.',
      tags: ['Lender payments'],
      auth: 'staff',
      responses: { 200: PaymentProviderChoiceList },
      errors: [401, 403],
      rateLimit: READ_LIMIT,
      handler: async ({ tx }) => {
        await requireLenderPermission(tx, LENDER_PAYMENT_ROLES, undefined);
        const result = await tx.query(
          `select provider, display_name as "displayName", kind, status from payments.provider_register where status = 'approved' order by provider`,
        );
        return { status: 200, body: out(PaymentProviderChoiceList, { items: result.rows }) };
      },
    }),
    userRoute({
      method: 'get',
      path: '/v1/platform/return-code-classes',
      operationId: 'listReturnCodeClasses',
      summary: 'How each provider return code is classified, with the evidence it comes from',
      tags: ['Platform payments'],
      auth: 'staff',
      query: ReturnCodeClassQuery,
      responses: { 200: ReturnCodeClassList },
      errors: [401, 403, 422],
      rateLimit: READ_LIMIT,
      handler: async ({ tx, query }) => {
        await requirePlatform(tx, [PLATFORM_PROVIDERS]);
        const result = await tx.query(
          `select id, provider, code, class, evidence_ref as "evidenceRef", status, set_by as "setBy", ${ts('set_at')} as "setAt"
             from payments.mandate_return_codes
            where status = $1 and ($2::text is null or provider = $2)
            order by provider, code, set_at desc limit 500`,
          [query.status, query.provider ?? null],
        );
        return { status: 200, body: out(ReturnCodeClassList, { items: result.rows }) };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/platform/return-code-classes',
      operationId: 'setReturnCodeClass',
      summary:
        'Classify one provider return code, with its evidence (platform.payments.providers.manage, aal2)',
      description:
        'Applies to debits recorded afterwards; a debit already recorded keeps its class. The previous classification of the same code is retired.',
      tags: ['Platform payments'],
      auth: 'staff',
      idempotent: true,
      body: ReturnCodeClassInput,
      responses: { 200: ReturnCodeClassSet },
      errors: [400, 401, 403, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, body }) => {
        await one<string>(tx, 'select payments.set_return_code_class($1, $2, $3, $4) as r', [
          body.provider,
          body.code,
          body.class,
          body.evidenceRef,
        ]);
        return {
          status: 200,
          body: out(ReturnCodeClassSet, {
            provider: body.provider,
            code: body.code,
            class: body.class,
            status: 'set',
          }),
        };
      },
    }),

    // ---- account format rules (platform) -------------------------------------------------------------------------------
    userRoute({
      method: 'get',
      path: '/v1/platform/account-format-rules',
      operationId: 'listAccountFormatRules',
      summary:
        'Account-number format rules by country and account type, with their evidence label and approval state',
      description:
        'The initial 9 to 18 digit range is an unverified assumption; a rule governs registrations only once a different person has approved it.',
      tags: ['Platform accounts'],
      auth: 'staff',
      query: AccountFormatRuleQuery,
      responses: { 200: AccountFormatRuleList },
      errors: [401, 403, 422],
      rateLimit: READ_LIMIT,
      handler: async ({ tx, query }) => {
        await requirePlatform(tx, [PLATFORM_REGISTRY_MANAGE, PLATFORM_REGISTRY_VERIFY]);
        const result = await tx.query(
          `select ${RULE_COLUMNS} from payments.account_format_rules
            where ($1::text is null or status = $1) and ($2::text is null or country = $2) and ($3::text is null or account_type = $3)
            order by country, account_type, version desc limit 200`,
          [query.status ?? null, query.country ?? null, query.accountType ?? null],
        );
        return { status: 200, body: out(AccountFormatRuleList, { items: result.rows }) };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/platform/account-format-rules',
      operationId: 'draftAccountFormatRule',
      summary:
        'Draft a new version of an account-number format rule (platform.accounts.registry.manage, aal2)',
      description:
        'The drafter is also the proposer, so a different registry verifier must approve it. A source note is required.',
      tags: ['Platform accounts'],
      auth: 'staff',
      idempotent: true,
      body: AccountFormatRuleDraftInput,
      responses: { 201: AccountFormatRuleCreated },
      errors: [400, 401, 403, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, body }) => {
        const id = await one<string>(
          tx,
          'select payments.draft_account_format_rule($1, $2, $3, $4, $5, $6, $7, $8::date, $9::date) as r',
          [
            body.country,
            body.accountType,
            body.minDigits,
            body.maxDigits,
            body.ifscRequired,
            body.evidenceLabel,
            body.sourceNote,
            body.effectiveFrom ?? null,
            body.effectiveTo ?? null,
          ],
        );
        return { status: 201, body: out(AccountFormatRuleCreated, { id, status: 'draft' }) };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/platform/account-format-rules/:id/submit',
      operationId: 'submitAccountFormatRule',
      summary:
        'Take responsibility for proposing a draft rule that has no proposer (the seeded one)',
      tags: ['Platform accounts'],
      auth: 'staff',
      idempotent: true,
      params: Id,
      responses: { 200: AccountsActionResult },
      errors: [400, 401, 403, 404, 409],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params }) => {
        const status = await one<string>(
          tx,
          'select payments.submit_account_format_rule($1::uuid) as r',
          [params.id],
        );
        return { status: 200, body: out(AccountsActionResult, { id: params.id, status }) };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/platform/account-format-rules/:id/approve',
      operationId: 'approveAccountFormatRule',
      summary:
        'Approve a proposed rule (platform.accounts.registry.verify, aal2, a different person than the proposer)',
      description:
        'Approving retires the previously approved version of the same country and account type. Approving a rule whose evidence label is unverified is a recorded platform decision, not evidence.',
      tags: ['Platform accounts'],
      auth: 'staff',
      idempotent: true,
      params: Id,
      body: AccountFormatRuleApproveInput,
      responses: { 200: AccountsActionResult },
      errors: [400, 401, 403, 404, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params, body }) => {
        const status = await one<string>(
          tx,
          'select payments.approve_account_format_rule($1::uuid, $2) as r',
          [params.id, body.note ?? null],
        );
        return { status: 200, body: out(AccountsActionResult, { id: params.id, status }) };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/platform/account-format-rules/:id/retire',
      operationId: 'retireAccountFormatRule',
      summary:
        'Retire a rule (either registry permission, one person, a reason of 10 or more characters)',
      tags: ['Platform accounts'],
      auth: 'staff',
      idempotent: true,
      params: Id,
      body: AccountsReasonInput,
      responses: { 200: AccountsActionResult },
      errors: [400, 401, 403, 404, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params, body }) => {
        const status = await one<string>(
          tx,
          'select payments.retire_account_format_rule($1::uuid, $2) as r',
          [params.id, body.reason],
        );
        return { status: 200, body: out(AccountsActionResult, { id: params.id, status }) };
      },
    }),

    // ---- fingerprint key versions (platform) --------------------------------------------------------------------------
    userRoute({
      method: 'get',
      path: '/v1/platform/fingerprint-key-versions',
      operationId: 'listFingerprintKeyVersions',
      summary:
        'The versions of the account fingerprint key (proposed, active, retired); never the key',
      tags: ['Platform accounts'],
      auth: 'staff',
      responses: { 200: FingerprintKeyVersionList },
      errors: [401, 403],
      rateLimit: READ_LIMIT,
      handler: async ({ tx }) => {
        await requirePlatform(tx, [PLATFORM_REGISTRY_MANAGE, PLATFORM_REGISTRY_VERIFY]);
        const result = await tx.query(
          `select ${KEY_VERSION_COLUMNS} from payments.fingerprint_key_versions order by key_version desc`,
        );
        return { status: 200, body: out(FingerprintKeyVersionList, { items: result.rows }) };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/platform/fingerprint-key-versions',
      operationId: 'proposeFingerprintKeyVersion',
      summary: 'Propose the next fingerprint key version (platform.accounts.registry.manage, aal2)',
      description:
        'Exactly the highest version plus one, and at most one open proposal. Nothing is registered under it until a different registry verifier approves it. The key material itself is provisioned outside the API.',
      tags: ['Platform accounts'],
      auth: 'staff',
      idempotent: true,
      body: FingerprintKeyVersionProposalInput,
      responses: { 201: FingerprintKeyVersionResult },
      errors: [400, 401, 403, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, body }) => {
        const keyVersion = await one<number>(
          tx,
          'select payments.propose_fingerprint_key_version($1::integer, $2) as r',
          [body.version, body.note ?? null],
        );
        return {
          status: 201,
          body: out(FingerprintKeyVersionResult, { keyVersion, status: 'proposed' }),
        };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/platform/fingerprint-key-versions/:version/approve',
      operationId: 'approveFingerprintKeyVersion',
      summary:
        'Approve a proposed key version (platform.accounts.registry.verify, aal2, a different login than the proposer)',
      description:
        'Refused (rotation_incomplete) while any live registry entry under the current version has no re-keyed successor under the proposed one.',
      tags: ['Platform accounts'],
      auth: 'staff',
      idempotent: true,
      params: KeyVersionParam,
      body: FingerprintKeyVersionApproveInput,
      responses: { 200: FingerprintKeyVersionResult },
      errors: [400, 401, 403, 404, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params, body }) => {
        const status = await one<string>(
          tx,
          'select payments.approve_fingerprint_key_version($1::integer, $2) as r',
          [params.version, body.note ?? null],
        );
        return {
          status: 200,
          body: out(FingerprintKeyVersionResult, { keyVersion: params.version, status }),
        };
      },
    }),

    // ---- the account registry (platform) ------------------------------------------------------------------------------
    userRoute({
      method: 'post',
      path: '/v1/platform/accounts',
      operationId: 'registerAccount',
      summary:
        'Register an account under an owner and permitted purposes (platform.accounts.registry.manage, aal2)',
      description:
        'The only request that carries an account number, entered once. The API validates it against the approved format rule, computes a keyed fingerprint and the masked reference, and drops the number: it is never stored, logged, echoed, put in an error, an audit event or a database column. The answer is the registry id, the masked reference and the status. Answers 503 key_management_unavailable where no fingerprint key is available. The entry starts unverified; a different person verifies it.',
      tags: ['Platform accounts'],
      auth: 'staff',
      idempotent: true,
      body: RegisterBody,
      responses: { 201: RegistryAccountRegistered },
      errors: [400, 401, 403, 409, 422, 503],
      rateLimit: REGISTER_LIMIT,
      handler: async ({ request, tx, body, idempotencyKey }) => {
        const secret = body.account;
        try {
          scrubAccountRequest(request);
          await requirePlatform(tx, [PLATFORM_REGISTRY_MANAGE]);
          if (!keys) throw keyUnavailable();
          if (!idempotencyKey) throw new Error('registerAccount is idempotent');

          // The live key versions (the active one, and the proposed one during a rotation). An account is registered under the
          // active version, or, for a re-key, under the proposed one; the database also needs its fingerprint under every other
          // live version, which only this process (the holder of the keys) can compute.
          const live = (
            await tx.query<{ keyVersion: number; status: string }>(
              `select key_version as "keyVersion", status from payments.fingerprint_key_versions where status <> 'retired' order by key_version`,
            )
          ).rows;
          const target = live.find(
            (v) => v.status === (body.rekeysRegistryId ? 'proposed' : 'active'),
          );
          if (!target) {
            throw body.rekeysRegistryId
              ? new ApiError(409, 'rekey_invalid', 'Conflict')
              : new ApiError(409, 'key_version_not_active', 'Conflict');
          }
          const rule = await approvedRule(tx, body.country, body.accountType);

          const fingerprints = new Map<number, AccountFingerprint>();
          try {
            for (const version of live) {
              const key = await keys.keyFor(version.keyVersion);
              if (!key) throw keyUnavailable();
              fingerprints.set(version.keyVersion, fingerprintAccount(key, secret.reveal(), rule));
            }
          } catch (error) {
            if (!(error instanceof AccountFingerprintError)) throw error;
            if (error.reason === 'invalid_account_number')
              throw new ApiError(
                422,
                'account_number_invalid',
                'Unprocessable Content',
                'The account number does not match the approved format.',
              );
            if (error.reason === 'invalid_ifsc')
              throw new ApiError(
                422,
                'ifsc_invalid',
                'Unprocessable Content',
                'The IFSC is not valid.',
              );
            if (error.reason === 'invalid_rule')
              throw new ApiError(409, 'account_format_unvalidated', 'Conflict');
            throw keyUnavailable();
          }
          const main = fingerprints.get(target.keyVersion);
          if (!main) throw keyUnavailable();
          const others = Object.fromEntries(
            [...fingerprints]
              .filter(([version]) => version !== target.keyVersion)
              .map(([version, f]) => [String(version), f.fingerprint]),
          );

          const id = await one<string>(
            tx,
            `select payments.register_account($1, $2::integer, $3, $4, $5, $6::uuid, $7::boolean, $8, $9::uuid, $10, $11::text[],
                                              $12::date, $13::date, $14, $15::jsonb, $16::uuid) as r`,
            [
              main.fingerprint,
              target.keyVersion,
              main.maskedRef,
              body.country,
              body.accountType,
              rule.ruleId,
              main.formatValidated,
              body.ownerKind,
              body.ownerOrgId ?? null,
              body.legalOwnerName,
              body.permittedPurposes,
              body.effectiveFrom ?? null,
              body.effectiveTo ?? null,
              idempotencyKey,
              JSON.stringify(others),
              body.rekeysRegistryId ?? null,
            ],
          );
          const stored = await tx.query(
            `select id, masked_ref as "maskedRef", verification_status as status from payments.account_registry where id = $1::uuid`,
            [id],
          );
          if (!stored.rows[0]) throw new Error('registry entry not readable after registration');
          return { status: 201, body: out(RegistryAccountRegistered, stored.rows[0]) };
        } finally {
          secret.wipe();
        }
      },
    }),
    userRoute({
      method: 'get',
      path: '/v1/platform/accounts',
      operationId: 'listRegistryAccounts',
      summary:
        'Registered accounts, masked: owner, purposes, dates and verification state (never the fingerprint)',
      tags: ['Platform accounts'],
      auth: 'staff',
      query: RegistryAccountQuery,
      responses: { 200: RegistryAccountPage },
      errors: [401, 403, 422],
      rateLimit: READ_LIMIT,
      handler: async ({ tx, query }) => {
        await requirePlatform(tx, [PLATFORM_REGISTRY_MANAGE, PLATFORM_REGISTRY_VERIFY]);
        const where: string[] = [];
        const values: unknown[] = [];
        if (query.status) {
          values.push(query.status);
          where.push(`verification_status = $${String(values.length)}`);
        }
        if (query.ownerOrgId) {
          values.push(query.ownerOrgId);
          where.push(`owner_org_id = $${String(values.length)}::uuid`);
        }
        const page = await keysetPage(
          tx,
          {
            columns: REGISTRY_COLUMNS,
            from: 'payments.account_registry',
            sortColumn: 'registered_at',
            where,
            values,
          },
          query,
        );
        return { status: 200, body: out(RegistryAccountPage, page) };
      },
    }),
    userRoute({
      method: 'get',
      path: '/v1/platform/accounts/:id',
      operationId: 'getRegistryAccount',
      summary: 'One registered account, masked',
      tags: ['Platform accounts'],
      auth: 'staff',
      params: Id,
      responses: { 200: RegistryAccountEntry },
      errors: [401, 403, 404],
      rateLimit: READ_LIMIT,
      handler: async ({ tx, params }) => {
        await requirePlatform(tx, [PLATFORM_REGISTRY_MANAGE, PLATFORM_REGISTRY_VERIFY]);
        const result = await tx.query(
          `select ${REGISTRY_COLUMNS} from payments.account_registry where id = $1::uuid`,
          [params.id],
        );
        if (!result.rows[0]) throw notFound();
        return { status: 200, body: out(RegistryAccountEntry, result.rows[0]) };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/platform/accounts/:id/verify',
      operationId: 'verifyRegistryAccount',
      summary:
        'Verify a registered account (platform.accounts.registry.verify, aal2, a different person than the registrant)',
      description: 'Needs an evidence reference label (no file contents, no account details).',
      tags: ['Platform accounts'],
      auth: 'staff',
      idempotent: true,
      params: Id,
      body: RegistryAccountVerifyInput,
      responses: { 200: AccountsActionResult },
      errors: [400, 401, 403, 404, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params, body }) => {
        const status = await one<string>(
          tx,
          'select payments.verify_account($1::uuid, $2, $3) as r',
          [params.id, body.evidenceRef, body.note ?? null],
        );
        return { status: 200, body: out(AccountsActionResult, { id: params.id, status }) };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/platform/accounts/:id/reject',
      operationId: 'rejectRegistryAccount',
      summary:
        'Reject an unverified registration (either registry permission, one person, a reason)',
      tags: ['Platform accounts'],
      auth: 'staff',
      idempotent: true,
      params: Id,
      body: AccountsReasonInput,
      responses: { 200: AccountsActionResult },
      errors: [400, 401, 403, 404, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params, body }) => {
        const status = await one<string>(tx, 'select payments.reject_account($1::uuid, $2) as r', [
          params.id,
          body.reason,
        ]);
        return { status: 200, body: out(AccountsActionResult, { id: params.id, status }) };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/platform/accounts/:id/revoke',
      operationId: 'revokeRegistryAccount',
      summary: 'Revoke a registration for good (either registry permission, one person, a reason)',
      description:
        'Linked settlement accounts are revoked and active payment configurations that settle into the account are suspended in the same transaction.',
      tags: ['Platform accounts'],
      auth: 'staff',
      idempotent: true,
      params: Id,
      body: AccountsReasonInput,
      responses: { 200: AccountsActionResult },
      errors: [400, 401, 403, 404, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params, body }) => {
        const status = await one<string>(tx, 'select payments.revoke_account($1::uuid, $2) as r', [
          params.id,
          body.reason,
        ]);
        return { status: 200, body: out(AccountsActionResult, { id: params.id, status }) };
      },
    }),
    userRoute({
      method: 'get',
      path: '/v1/platform/settlement-accounts',
      operationId: 'listSettlementAccountsForLinking',
      summary:
        'Lenders settlement accounts (masked) that a registry manager can link to a verified registry entry',
      tags: ['Platform accounts'],
      auth: 'staff',
      query: SettlementAccountQuery,
      responses: { 200: SettlementAccountPage },
      errors: [401, 403, 422],
      rateLimit: READ_LIMIT,
      handler: async ({ tx, query }) => {
        await requirePlatform(tx, [PLATFORM_REGISTRY_MANAGE, PLATFORM_REGISTRY_VERIFY]);
        const where: string[] = [];
        const values: unknown[] = [];
        if (query.lenderId) {
          values.push(query.lenderId);
          where.push(`lender_org_id = $${String(values.length)}::uuid`);
        }
        if (query.linked)
          where.push(query.linked === 'true' ? 'registry_id is not null' : 'registry_id is null');
        const page = await keysetPage(
          tx,
          {
            columns: SETTLEMENT_COLUMNS,
            from: 'tenancy.lender_settlement_accounts',
            sortColumn: 'created_at',
            where,
            values,
          },
          query,
        );
        return { status: 200, body: out(SettlementAccountPage, page) };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/platform/settlement-accounts/:id/link',
      operationId: 'linkSettlementAccount',
      summary:
        "Link a lender's settlement account to its verified registry entry (platform.accounts.registry.manage, aal2)",
      description:
        'The only way a settlement account becomes verified: the entry must be verified, owned by this lender, permitted for repayment settlement, effective now, and carry the same masked reference.',
      tags: ['Platform accounts'],
      auth: 'staff',
      idempotent: true,
      params: Id,
      body: SettlementAccountLinkInput,
      responses: { 200: AccountsActionResult },
      errors: [400, 401, 403, 404, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params, body }) => {
        const status = await one<string>(
          tx,
          'select payments.link_settlement_account($1::uuid, $2::uuid) as r',
          [params.id, body.registryId],
        );
        return { status: 200, body: out(AccountsActionResult, { id: params.id, status }) };
      },
    }),

    // ---- merchants -------------------------------------------------------------------------------------------------------
    userRoute({
      method: 'post',
      path: '/v1/lender/merchants',
      operationId: 'claimMerchant',
      summary: "Claim the lender's merchant identifier at a provider (payment.configure, aal2)",
      description:
        'A claim starts unverified: the platform confirms against evidence that the identifier belongs to the lender. An identifier already claimed by anyone else (including Udofin) is refused.',
      tags: ['Lender payments'],
      auth: 'staff',
      idempotent: true,
      idempotencyTenant: ({ body }) => (body as { lenderId?: string }).lenderId ?? null,
      body: MerchantClaimInput,
      responses: { 201: MerchantClaimed },
      errors: [400, 401, 403, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, body }) => {
        const id = await one<string>(tx, 'select payments.claim_merchant($1::uuid, $2, $3) as r', [
          body.lenderId,
          body.provider,
          body.merchantRef,
        ]);
        return { status: 201, body: out(MerchantClaimed, { id, status: 'active' }) };
      },
    }),
    userRoute({
      method: 'get',
      path: '/v1/lender/merchants',
      operationId: 'listLenderMerchants',
      summary: "The lender's merchant identifiers and their verification state",
      tags: ['Lender payments'],
      auth: 'staff',
      query: MerchantQuery,
      responses: { 200: MerchantPage },
      errors: [401, 403, 422],
      rateLimit: READ_LIMIT,
      handler: async ({ tx, query }) => {
        await requireLenderPermission(tx, LENDER_PAYMENT_ROLES, query.lenderId);
        const where: string[] = ["owner_kind = 'lender'"];
        const values: unknown[] = [];
        if (query.lenderId) {
          values.push(query.lenderId);
          where.push(`owner_org_id = $${String(values.length)}::uuid`);
        }
        if (query.verification) {
          values.push(query.verification);
          where.push(`verification_status = $${String(values.length)}`);
        }
        if (query.status) {
          values.push(query.status);
          where.push(`status = $${String(values.length)}`);
        }
        const page = await keysetPage(
          tx,
          {
            columns: MERCHANT_COLUMNS,
            from: 'payments.merchant_registry',
            sortColumn: 'claimed_at',
            where,
            values,
          },
          query,
        );
        return { status: 200, body: out(MerchantPage, page) };
      },
    }),
    // ---- settlement accounts (the lender's own; masked reference only) -------------------------------------------------------
    userRoute({
      method: 'post',
      path: '/v1/lender/settlement-accounts',
      operationId: 'requestSettlementAccount',
      summary:
        "Ask for one of the lender's own settlement accounts to be set up (payment.configure, aal2)",
      description:
        'Label, bank and MASKED reference only. The account starts unverified and can be used for a payment only after a platform user links it to a verified registry entry with the same masked reference. A full account number is never accepted here.',
      tags: ['Lender payments'],
      auth: 'staff',
      idempotent: true,
      idempotencyTenant: ({ body }) => (body as { lenderId?: string }).lenderId ?? null,
      body: SettlementAccountRequestInput,
      responses: { 201: SettlementAccountRequested },
      errors: [400, 401, 403, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, body }) => {
        const id = await one<string>(
          tx,
          'select payments.request_settlement_account($1::uuid, $2, $3, $4) as r',
          [body.lenderId, body.label, body.bankName, body.maskedRef],
        );
        return { status: 201, body: out(SettlementAccountRequested, { id, status: 'unverified' }) };
      },
    }),
    userRoute({
      method: 'get',
      path: '/v1/lender/settlement-accounts',
      operationId: 'listLenderSettlementAccounts',
      summary:
        "The lender's own settlement accounts (masked) and whether each is linked to the registry",
      tags: ['Lender payments'],
      auth: 'staff',
      query: LenderSettlementAccountQuery,
      responses: { 200: SettlementAccountPage },
      errors: [401, 403, 422],
      rateLimit: READ_LIMIT,
      handler: async ({ tx, query }) => {
        await requireLenderPermission(tx, LENDER_PAYMENT_ROLES, query.lenderId);
        const where: string[] = [];
        const values: unknown[] = [];
        if (query.lenderId) {
          values.push(query.lenderId);
          where.push(`lender_org_id = $${String(values.length)}::uuid`);
        }
        const page = await keysetPage(
          tx,
          {
            columns: SETTLEMENT_COLUMNS,
            from: 'tenancy.lender_settlement_accounts',
            sortColumn: 'created_at',
            where,
            values,
          },
          query,
        );
        return { status: 200, body: out(SettlementAccountPage, page) };
      },
    }),
    userRoute({
      method: 'get',
      path: '/v1/platform/merchants',
      operationId: 'listPlatformMerchants',
      summary: 'Every merchant claim, so the platform can verify or revoke it',
      tags: ['Platform payments'],
      auth: 'staff',
      query: MerchantQuery,
      responses: { 200: MerchantPage },
      errors: [401, 403, 422],
      rateLimit: READ_LIMIT,
      handler: async ({ tx, query }) => {
        await requirePlatform(tx, [PLATFORM_PROVIDERS]);
        const where: string[] = [];
        const values: unknown[] = [];
        if (query.lenderId) {
          values.push(query.lenderId);
          where.push(`owner_org_id = $${String(values.length)}::uuid`);
        }
        if (query.verification) {
          values.push(query.verification);
          where.push(`verification_status = $${String(values.length)}`);
        }
        if (query.status) {
          values.push(query.status);
          where.push(`status = $${String(values.length)}`);
        }
        const page = await keysetPage(
          tx,
          {
            columns: MERCHANT_COLUMNS,
            from: 'payments.merchant_registry',
            sortColumn: 'claimed_at',
            where,
            values,
          },
          query,
        );
        return { status: 200, body: out(MerchantPage, page) };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/platform/merchants/:id/verify',
      operationId: 'verifyMerchant',
      summary:
        "Confirm, against evidence, that a lender's claimed merchant identifier is its own (platform.payments.providers.manage, aal2)",
      description: 'Not by the person who claimed it; once.',
      tags: ['Platform payments'],
      auth: 'staff',
      idempotent: true,
      params: Id,
      body: MerchantVerifyInput,
      responses: { 200: AccountsActionResult },
      errors: [400, 401, 403, 404, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params, body }) => {
        const status = await one<string>(tx, 'select payments.verify_merchant($1::uuid, $2) as r', [
          params.id,
          body.evidenceRef,
        ]);
        return { status: 200, body: out(AccountsActionResult, { id: params.id, status }) };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/platform/merchants/:id/revoke',
      operationId: 'revokeMerchant',
      summary: 'Revoke a merchant (platform.payments.providers.manage, aal2)',
      description:
        'The identifier stays taken. Active payment configurations that use it are suspended in the same transaction.',
      tags: ['Platform payments'],
      auth: 'staff',
      idempotent: true,
      params: Id,
      body: AccountsReasonInput,
      responses: { 200: AccountsActionResult },
      errors: [400, 401, 403, 404, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params, body }) => {
        const status = await one<string>(tx, 'select payments.revoke_merchant($1::uuid, $2) as r', [
          params.id,
          body.reason,
        ]);
        return { status: 200, body: out(AccountsActionResult, { id: params.id, status }) };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/platform/udofin-fee-merchants',
      operationId: 'registerUdofinFeeMerchant',
      summary: "Register Udofin's own fee merchant (platform.payments.providers.manage, aal2)",
      description:
        'Registered verified, for fee collection only. A payment configuration can never reference it.',
      tags: ['Platform payments'],
      auth: 'staff',
      idempotent: true,
      body: UdofinFeeMerchantInput,
      responses: { 201: MerchantRegistered },
      errors: [400, 401, 403, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, body }) => {
        const id = await one<string>(
          tx,
          'select payments.register_udofin_fee_merchant($1, $2) as r',
          [body.provider, body.merchantRef],
        );
        return { status: 201, body: out(MerchantRegistered, { id, status: 'active' }) };
      },
    }),

    // ---- payment configurations -----------------------------------------------------------------------------------------
    configList('/v1/lender/payment-configs', 'listLenderPaymentConfigs', false),
    configOne('/v1/lender/payment-configs/:id', 'getLenderPaymentConfig', false),
    configList('/v1/platform/payment-configs', 'listPlatformPaymentConfigs', true),
    configOne('/v1/platform/payment-configs/:id', 'getPlatformPaymentConfig', true),
    userRoute({
      method: 'get',
      path: '/v1/lender/payment-configs/:id/history',
      operationId: 'getLenderPaymentConfigHistory',
      summary:
        'The append-only history of one payment configuration (status changes and their reason codes)',
      tags: ['Lender payments'],
      auth: 'staff',
      params: Id,
      responses: { 200: PaymentConfigHistory },
      errors: [401, 403, 404],
      rateLimit: READ_LIMIT,
      handler: async ({ tx, params }) => {
        await requireLenderPermission(tx, LENDER_PAYMENT_ROLES, undefined);
        const visible = await tx.query(
          'select 1 from payments.lender_payment_configs where id = $1::uuid',
          [params.id],
        );
        if (!visible.rows[0]) throw notFound();
        const result = await tx.query(
          `select id, event_kind as "eventKind", from_status as "fromStatus", to_status as "toStatus", actor_kind as "actorKind",
                  ${ts('occurred_at')} as "occurredAt", coalesce(reasons, '{}'::text[]) as reasons
             from payments.lender_payment_config_events where config_id = $1::uuid order by occurred_at, id`,
          [params.id],
        );
        return { status: 200, body: out(PaymentConfigHistory, { items: result.rows }) };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/lender/payment-configs',
      operationId: 'draftPaymentConfig',
      summary: 'Draft a payment configuration (payment.configure, aal2)',
      description:
        'Secrets are given as the NAMES of secrets in the secrets manager, never values. The API generates the opaque callback token, stores only its SHA-256 and returns the token once, here: configure it at the provider as the callback path. It is not returned again and is not logged. Content cannot change after drafting.',
      tags: ['Lender payments'],
      auth: 'staff',
      idempotent: true,
      idempotencyTenant: ({ body }) => (body as { lenderId?: string }).lenderId ?? null,
      body: PaymentConfigDraftInput,
      responses: { 201: PaymentConfigDrafted },
      errors: [400, 401, 403, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, body, idempotencyKey }) => {
        if (!idempotencyKey) throw new Error('draftPaymentConfig is idempotent');
        const { token, hash } = newEndpointToken();
        const id = await one<string>(
          tx,
          'select payments.draft_payment_config($1::uuid, $2, $3, $4::uuid, $5::uuid, $6, $7, $8, $9::jsonb, $10, $11, $12, $13) as r',
          [
            body.lenderId,
            body.provider,
            body.providerMode,
            body.merchantRegistryId,
            body.settlementAccountId,
            body.secretRef,
            body.webhookSecretRef,
            hash,
            JSON.stringify(body.railLimits),
            body.railLimitsSource ?? null,
            body.evidenceRef ?? null,
            body.contractSectionRef ?? null,
            idempotencyKey,
          ],
        );
        return {
          status: 201,
          body: out(PaymentConfigDrafted, {
            id,
            status: 'draft',
            endpointToken: token,
            callbackPath: `/v1/hooks/provider/${token}`,
          }),
        };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/lender/payment-configs/:id/submit',
      operationId: 'submitPaymentConfig',
      summary:
        'Submit a draft (or a suspended) configuration for approval (payment.configure, aal2)',
      description:
        'Validates the collection target now. A refusal names the first reason code (settlement account, merchant, provider, evidence).',
      tags: ['Lender payments'],
      auth: 'staff',
      idempotent: true,
      params: Id,
      responses: { 200: AccountsActionResult },
      errors: [400, 401, 403, 404, 409],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params }) => {
        const status = await withReasons(() =>
          one<string>(tx, 'select payments.submit_payment_config($1::uuid) as r', [params.id]),
        );
        return { status: 200, body: out(AccountsActionResult, { id: params.id, status }) };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/lender/payment-configs/:id/decide',
      operationId: 'decidePaymentConfig',
      summary:
        'Approve or reject a submitted configuration (payment.config.approve, aal2, a different person than the drafter and submitter)',
      description:
        'Approval re-runs the collection-target validation. Rejection retires the configuration and needs a note of 10 or more characters.',
      tags: ['Lender payments'],
      auth: 'staff',
      idempotent: true,
      params: Id,
      body: PaymentConfigDecisionInput,
      responses: { 200: AccountsActionResult },
      errors: [400, 401, 403, 404, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params, body }) => {
        const status = await withReasons(() =>
          one<string>(tx, 'select payments.decide_payment_config($1::uuid, $2::boolean, $3) as r', [
            params.id,
            body.approve,
            body.note ?? null,
          ]),
        );
        return { status: 200, body: out(AccountsActionResult, { id: params.id, status }) };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/lender/payment-configs/:id/withdraw',
      operationId: 'withdrawPaymentConfig',
      summary: 'Withdraw a draft or pending configuration (payment.configure, aal2)',
      tags: ['Lender payments'],
      auth: 'staff',
      idempotent: true,
      params: Id,
      body: AccountsReasonInput,
      responses: { 200: AccountsActionResult },
      errors: [400, 401, 403, 404, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params, body }) => {
        const status = await one<string>(
          tx,
          'select payments.withdraw_payment_config($1::uuid, $2) as r',
          [params.id, body.reason],
        );
        return { status: 200, body: out(AccountsActionResult, { id: params.id, status }) };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/lender/payment-configs/:id/retire',
      operationId: 'retirePaymentConfig',
      summary: 'Retire an active or suspended configuration (the lender approver, aal2)',
      tags: ['Lender payments'],
      auth: 'staff',
      idempotent: true,
      params: Id,
      body: AccountsReasonInput,
      responses: { 200: AccountsActionResult },
      errors: [400, 401, 403, 404, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params, body }) => {
        const status = await one<string>(
          tx,
          'select payments.retire_payment_config($1::uuid, $2) as r',
          [params.id, body.reason],
        );
        return { status: 200, body: out(AccountsActionResult, { id: params.id, status }) };
      },
    }),
    suspendRoute(
      '/v1/platform/payment-configs/:id/suspend',
      'suspendPaymentConfig',
      'Platform payments',
    ),
    suspendRoute(
      '/v1/lender/payment-configs/:id/suspend',
      'suspendPaymentConfigOnLenderPath',
      'Lender payments',
    ),
    userRoute({
      method: 'post',
      path: '/v1/platform/payment-configs/:id/retire',
      operationId: 'retirePaymentConfigAsPlatform',
      summary:
        'Retire an active or suspended configuration (platform.payments.providers.manage, aal2)',
      tags: ['Platform payments'],
      auth: 'staff',
      idempotent: true,
      params: Id,
      body: AccountsReasonInput,
      responses: { 200: AccountsActionResult },
      errors: [400, 401, 403, 404, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params, body }) => {
        const status = await one<string>(
          tx,
          'select payments.retire_payment_config($1::uuid, $2) as r',
          [params.id, body.reason],
        );
        return { status: 200, body: out(AccountsActionResult, { id: params.id, status }) };
      },
    }),
    userRoute({
      method: 'get',
      path: '/v1/lender/settlement-accounts/registry-status',
      operationId: 'getSettlementAccountRegistryStatus',
      summary:
        "Registry state of the lender's own settlement accounts: masked reference, status, dates and whether usable now",
      description: 'Never the fingerprint, the owner details or the reasons.',
      tags: ['Lender payments'],
      auth: 'staff',
      responses: { 200: SettlementAccountRegistryStatusList },
      errors: [401, 403],
      rateLimit: READ_LIMIT,
      handler: async ({ tx }) => {
        await requireLenderPermission(tx, ['payment.read'], undefined);
        const result = await tx.query(
          `select settlement_account_id as "settlementAccountId", lender_org_id as "lenderId", masked_ref as "maskedRef",
                  verification_status as "verificationStatus", ${day('effective_from')} as "effectiveFrom",
                  ${day('effective_to')} as "effectiveTo", usable
             from payments.my_settlement_account_registry_status() order by lender_org_id, settlement_account_id`,
        );
        return {
          status: 200,
          body: out(SettlementAccountRegistryStatusList, { items: result.rows }),
        };
      },
    }),

    // ---- feature switches -----------------------------------------------------------------------------------------------
    userRoute({
      method: 'get',
      path: '/v1/platform/features',
      operationId: 'listFeatureCatalogue',
      summary:
        'The feature catalogue: which switches exist, which can be enabled, and why the others cannot',
      tags: ['Platform features'],
      auth: 'staff',
      responses: { 200: FeatureCatalogList },
      errors: [401, 403],
      rateLimit: READ_LIMIT,
      handler: async ({ tx }) => {
        await requirePlatform(tx, [PLATFORM_FEATURES]);
        const result = await tx.query(
          `select feature, enableable, introduced_in as "introducedIn", description, locked_reason as "lockedReason"
             from servicing.feature_catalog order by feature`,
        );
        return { status: 200, body: out(FeatureCatalogList, { items: result.rows }) };
      },
    }),
    userRoute({
      method: 'get',
      path: '/v1/platform/lenders/:lenderId/features',
      operationId: 'listLenderFeatureSwitches',
      summary:
        'The switch state of one lender, for every feature in the catalogue (off unless a two-person change turned it on)',
      tags: ['Platform features'],
      auth: 'staff',
      params: LenderParam,
      responses: { 200: FeatureSwitchList },
      errors: [401, 403],
      rateLimit: READ_LIMIT,
      handler: async ({ tx, params }) => {
        await requirePlatform(tx, [PLATFORM_FEATURES]);
        const result = await tx.query(PLATFORM_SWITCH_SQL, [params.lenderId]);
        return { status: 200, body: out(FeatureSwitchList, { items: result.rows }) };
      },
    }),
    userRoute({
      method: 'get',
      path: '/v1/lender/features',
      operationId: 'listOwnFeatureSwitches',
      summary:
        "The lender's own switch state (read-only; the platform changes switches through a two-person flow)",
      tags: ['Lender features'],
      auth: 'staff',
      query: LenderFeatureQuery,
      responses: { 200: FeatureSwitchList },
      errors: [401, 403, 422],
      rateLimit: READ_LIMIT,
      handler: async ({ tx, query }) => {
        await requireLenderPermission(tx, ['loan.read', 'payment.read'], query.lenderId);
        const result = await tx.query(LENDER_SWITCH_SQL, [query.lenderId ?? null]);
        return { status: 200, body: out(FeatureSwitchList, { items: result.rows }) };
      },
    }),
    userRoute({
      method: 'get',
      path: '/v1/platform/feature-change-requests',
      operationId: 'listFeatureChangeRequests',
      summary: 'Requests to turn a switch on or off, newest first',
      tags: ['Platform features'],
      auth: 'staff',
      query: FeatureChangeRequestQuery,
      responses: { 200: FeatureChangeRequestPage },
      errors: [401, 403, 422],
      rateLimit: READ_LIMIT,
      handler: async ({ tx, query }) => {
        await requirePlatform(tx, [PLATFORM_FEATURES]);
        const where: string[] = [];
        const values: unknown[] = [];
        if (query.lenderId) {
          values.push(query.lenderId);
          where.push(`lender_org_id = $${String(values.length)}::uuid`);
        }
        if (query.status) {
          values.push(query.status);
          where.push(`status = $${String(values.length)}`);
        }
        const page = await keysetPage(
          tx,
          {
            columns: CHANGE_REQUEST_COLUMNS,
            from: 'servicing.feature_change_requests',
            sortColumn: 'requested_at',
            where,
            values,
          },
          query,
        );
        return { status: 200, body: out(FeatureChangeRequestPage, page) };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/platform/feature-change-requests',
      operationId: 'requestFeatureChange',
      summary: 'Ask for a per-lender switch to change (platform.features.manage, aal2)',
      description:
        'Enabling needs evidence references and every prerequisite; disabling needs a reason. A DIFFERENT platform person decides it. Collections and DLG can never be enabled in this phase: the database refuses.',
      tags: ['Platform features'],
      auth: 'staff',
      idempotent: true,
      idempotencyTenant: ({ body }) => (body as { lenderId?: string }).lenderId ?? null,
      body: FeatureChangeRequestInput,
      responses: { 201: FeatureChangeRequested },
      errors: [400, 401, 403, 404, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, body, idempotencyKey }) => {
        if (!idempotencyKey) throw new Error('requestFeatureChange is idempotent');
        const id = await withReasons(() =>
          one<string>(
            tx,
            'select servicing.request_feature_change($1::uuid, $2, $3::boolean, $4::jsonb, $5, $6) as r',
            [
              body.lenderId,
              body.feature,
              body.enable,
              JSON.stringify(body.evidence),
              idempotencyKey,
              body.reason ?? null,
            ],
          ),
        );
        return { status: 201, body: out(FeatureChangeRequested, { id, status: 'pending' }) };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/platform/feature-change-requests/:id/decide',
      operationId: 'decideFeatureChange',
      summary:
        'Approve or reject a pending switch change (platform.features.manage, aal2, a different person than the requester)',
      description:
        'Approval re-checks the prerequisites and applies the change and its audit event atomically. A request past its expiry answers expired.',
      tags: ['Platform features'],
      auth: 'staff',
      idempotent: true,
      params: Id,
      body: FeatureChangeDecisionInput,
      responses: { 200: FeatureChangeDecided },
      errors: [400, 401, 403, 404, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params, body }) => {
        const status = await withReasons(() =>
          one<string>(
            tx,
            'select servicing.decide_feature_change($1::uuid, $2::boolean, $3) as r',
            [params.id, body.approve, body.note ?? null],
          ),
        );
        return { status: 200, body: out(FeatureChangeDecided, { id: params.id, status }) };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/platform/feature-change-requests/:id/cancel',
      operationId: 'cancelFeatureChange',
      summary: 'Cancel your own pending switch change request (platform.features.manage, aal2)',
      tags: ['Platform features'],
      auth: 'staff',
      idempotent: true,
      params: Id,
      responses: { 200: FeatureChangeCancelled },
      errors: [400, 401, 403, 404],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params }) => {
        await tx.query('select servicing.cancel_feature_change($1::uuid)', [params.id]);
        return {
          status: 200,
          body: out(FeatureChangeCancelled, { id: params.id, status: 'cancelled' }),
        };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/platform/features/kill',
      operationId: 'killFeature',
      summary:
        'Emergency kill switch: turn a feature off at once, for one lender (platform.features.manage, aal2, one person)',
      description:
        'A reason is required. Any pending request for the same switch is cancelled so it cannot undo the kill. It cannot turn anything on; re-enabling always needs a fresh two-person request.',
      tags: ['Platform features'],
      auth: 'staff',
      idempotent: true,
      idempotencyTenant: ({ body }) => (body as { lenderId?: string }).lenderId ?? null,
      body: FeatureKillInput,
      responses: { 201: FeatureKilled },
      errors: [400, 401, 403, 404, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, body, idempotencyKey }) => {
        if (!idempotencyKey) throw new Error('killFeature is idempotent');
        const id = await one<string>(
          tx,
          'select servicing.kill_feature($1::uuid, $2, $3, $4) as r',
          [body.lenderId, body.feature, body.reason, idempotencyKey],
        );
        return { status: 201, body: out(FeatureKilled, { id, status: 'applied' }) };
      },
    }),
  ];
}
