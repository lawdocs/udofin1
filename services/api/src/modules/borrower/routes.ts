import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
  randomUUID,
} from 'node:crypto';
import {
  BorrowerCategoryList,
  BorrowerMe,
  BorrowerProductList,
  ConsentDecisionInput,
  Created,
  DeletionCurrent,
  DeletionRequest,
  Done,
  IntegrityNonce,
  IntegrityResult,
  IntegrityVerifyInput,
  LoanPurposeList,
  LoanRequestDetail,
  LoanRequestInput,
  LoanRequestPage,
  LoanRequestPatch,
  LoanRequestVersion,
  NoticeList,
  PreferencesUpdate,
  ProfileUpdate,
  StepUpStart,
  StepUpStarted,
  StepUpVerified,
  StepUpVerify,
  SubmitResult,
  VersionedAction,
  CONSENT_PURPOSES_REQUIRED,
  LANGUAGES,
} from '@udofin/contracts';
import { createUnconfiguredSmsSender, withSmsTimeout } from '@udofin/adapters';
import { z } from 'zod';
import { ApiError } from '../../http/api-error.js';
import { decodeCursor, encodeCursor, PageQuerySchema } from '../../http/pagination.js';
import { publicRoute, userRoute, type RouteDefinition } from '../../http/routes.js';
import { columns } from '../../db/columns.js';
import { type BorrowerDeps } from './deps.js';

const WRITE_LIMIT = { max: 60, timeWindow: '1 minute' };
const STEPUP_LIMIT = { max: 8, timeWindow: '10 minutes' };
const Id = z.strictObject({ id: z.uuid() });
const Language = z.enum(LANGUAGES).default('en');

const REQUEST_COLUMNS = columns({
  id: 'id',
  categoryKey: 'category_key',
  amountMinor: 'requested_amount_minor::text',
  tenureDays: 'requested_tenure_days',
  purposeCode: 'purpose_code',
  status: 'status',
  version: 'version',
  expiresAt: 'expires_at::text',
  submissionReference: 'submission_reference',
  submittedAt: 'submitted_at::text',
  productVersionId: 'product_version_id',
  createdAt: 'created_at::text',
  updatedAt: 'updated_at::text',
});
interface RequestRow {
  id: string;
  categoryKey: string;
  amountMinor: string;
  tenureDays: number;
  purposeCode: string;
  status: string;
  version: number;
  expiresAt: string | null;
  submissionReference: string | null;
  submittedAt: string | null;
  productVersionId: string | null;
  createdAt: string;
  updatedAt: string;
}
const toRequest = (r: RequestRow) => ({ ...r, amountMinor: Number(r.amountMinor) });

/** Standard Webhooks signature check (used by Supabase auth hooks). */
export function verifyWebhookSignature(input: {
  secret: string;
  id: string | undefined;
  timestamp: string | undefined;
  signatureHeader: string | undefined;
  body: string;
  now?: number;
}): boolean {
  const { secret, id, timestamp, signatureHeader, body } = input;
  if (!id || !timestamp || !signatureHeader) return false;
  const ts = Number(timestamp);
  const now = input.now ?? Math.floor(Date.now() / 1000);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > 300) return false;
  const key = Buffer.from(secret.replace(/^v1,whsec_/, '').replace(/^whsec_/, ''), 'base64');
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest();
  return signatureHeader.split(' ').some((part) => {
    const [version, signature] = part.split(',');
    if (version !== 'v1' || !signature) return false;
    const given = Buffer.from(signature, 'base64');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

/** Source name under which the Send-SMS hook's message ids are recorded (ops.seen_webhooks). */
const HOOK_SOURCE = 'send_sms_hook';
/** Same shape the database accepts (ops.seen_webhooks check); a signed id outside it is refused, not stored. */
const HOOK_MESSAGE_ID = /^[A-Za-z0-9._:=+/-]{4,200}$/;

const hashCode = (pepper: string, challengeId: string, code: string): string =>
  createHmac('sha256', pepper).update(`${challengeId}:${code}`).digest('hex');
const toE164 = (phone: string): string => `+${phone.replace(/\D/g, '')}`;

const HookBody = z.object({
  user: z.object({ phone: z.string().min(8).max(20) }),
  sms: z.object({ otp: z.string().min(4).max(10) }),
});

/**
 * Borrower-facing API. Every route takes the borrower from the verified token (never from the request),
 * reads under row-level security, and writes through the checked database functions.
 */
/** Remembers message ids for ten minutes (longer than the signature window). Bounded so it cannot grow without limit. */
export function createSeenIds(ttlMs = 600_000, max = 10_000, now: () => number = Date.now) {
  const seen = new Map<string, number>();
  return {
    /** True the first time an id is seen; false for a repeat. */
    claim(id: string): boolean {
      const t = now();
      for (const [key, at] of seen) {
        if (t - at > ttlMs || seen.size > max) seen.delete(key);
        else break;
      }
      if (!id || seen.has(id)) return false;
      seen.set(id, t);
      return true;
    },
  };
}

export function borrowerRoutes(deps?: BorrowerDeps): RouteDefinition[] {
  // Every provider call is bounded: the Supabase hook has a 5 s budget and a slow provider must not hang a request.
  const seenHookIds = createSeenIds();
  const sms = withSmsTimeout(
    deps?.sms ?? createUnconfiguredSmsSender(),
    deps?.smsTimeoutMs ?? 4000,
  );
  const unavailable = (what: string) =>
    new ApiError(
      503,
      `${what}_unavailable`,
      'Service Unavailable',
      `${what} is not configured in this environment.`,
    );

  return [
    // ---- profile and journey ------------------------------------------------------------------
    userRoute({
      method: 'get',
      path: '/v1/borrower/me',
      operationId: 'getBorrowerMe',
      summary: 'Your profile, consents, preferences and where you are in the journey',
      description:
        "The journey lists separate facts. Account created, profile completed and consents completed do not mean KYC or eligibility: those are the lender's, in a later phase.",
      tags: ['Borrower'],
      auth: 'borrower',
      responses: { 200: BorrowerMe },
      errors: [401, 403],
      handler: async ({ tx }) => {
        const p = await tx.query<{
          displayName: string | null;
          preferredLanguage: 'en' | 'hi';
          onboardingStatus: z.infer<typeof BorrowerMe>['profile']['onboardingStatus'];
        }>(
          `select display_name as "displayName", preferred_language as "preferredLanguage", onboarding_status as "onboardingStatus" from identity.borrowers limit 1`,
        );
        const profile = p.rows[0];
        if (!profile) throw new ApiError(403, 'no_active_access', 'Forbidden');
        const consents = await tx.query(
          `select purpose, decision::text as decision, notice_version as "noticeVersion", captured_at::text as "capturedAt"
             from consent.current_decisions where lender_org_id is null order by purpose`,
        );
        const prefs = await tx.query<{ v: boolean }>(
          `select service_updates_sms as v from identity.communication_preferences limit 1`,
        );
        const counts = await tx.query<{ drafts: string; submitted: string }>(
          `select count(*) filter (where status = 'draft')::text as drafts, count(*) filter (where status = 'submitted')::text as submitted from lending.my_loan_requests`,
        );
        const marketing = await tx.query<{ v: boolean }>('select consent.marketing_enabled() as v');
        const level = await tx.query<{ v: z.infer<typeof BorrowerMe>['integrityLevel'] }>(
          'select identity.current_integrity_level() as v',
        );
        const granted = new Set(
          (consents.rows as { purpose: string; decision: string }[])
            .filter((c) => c.decision === 'granted')
            .map((c) => c.purpose),
        );
        return {
          status: 200,
          body: {
            profile,
            journey: {
              accountCreated: true as const,
              profileStarted: profile.onboardingStatus !== 'account_created',
              profileCompleted: profile.onboardingStatus === 'profile_completed',
              consentsCompleted: CONSENT_PURPOSES_REQUIRED.every((purpose) => granted.has(purpose)),
              draftRequests: Number(counts.rows[0]?.drafts ?? 0),
              submittedRequests: Number(counts.rows[0]?.submitted ?? 0),
              lenderKyc: 'not_started' as const,
              eligibility: 'not_assessed' as const,
            },
            consents: consents.rows,
            preferences: { serviceUpdatesSms: prefs.rows[0]?.v ?? true },
            marketing: { available: marketing.rows[0]?.v === true },
            integrityLevel: level.rows[0]?.v ?? 'none',
          },
        };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/borrower/profile',
      operationId: 'updateBorrowerProfile',
      summary: 'Set the optional display name and the language (English or Hindi)',
      tags: ['Borrower'],
      auth: 'borrower',
      idempotent: true,
      body: ProfileUpdate,
      responses: { 200: Done },
      errors: [400, 401, 403, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, body }) => {
        await tx.query('select identity.update_profile($1, $2::boolean, $3)', [
          body.displayName ?? null,
          body.displayName === null,
          body.preferredLanguage ?? null,
        ]);
        return { status: 200, body: { ok: true as const } };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/borrower/profile/complete',
      operationId: 'completeBorrowerProfile',
      summary: 'Mark the profile complete (the display name stays optional)',
      tags: ['Borrower'],
      auth: 'borrower',
      idempotent: true,
      responses: { 200: Done },
      errors: [401, 403, 409],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx }) => {
        await tx.query('select identity.complete_profile()');
        return { status: 200, body: { ok: true as const } };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/borrower/preferences',
      operationId: 'updateCommunicationPreferences',
      summary: 'Choose whether optional service updates are sent by SMS',
      description:
        'Security and legally required messages are not controlled by this. Marketing is not offered at launch.',
      tags: ['Borrower'],
      auth: 'borrower',
      idempotent: true,
      body: PreferencesUpdate,
      responses: { 200: Done },
      errors: [400, 401, 403, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, body }) => {
        await tx.query('select identity.set_communication_preferences($1::boolean)', [
          body.serviceUpdatesSms,
        ]);
        return { status: 200, body: { ok: true as const } };
      },
    }),

    // ---- consent ---------------------------------------------------------------------------------
    userRoute({
      method: 'get',
      path: '/v1/consent/notices',
      operationId: 'listConsentNotices',
      summary: 'The current published wording for each consent, in your language',
      description:
        'Falls back to English per purpose when the language is not published (languageFallback). Wording flagged requires_review has not been approved by counsel. Marketing is listed only if enabled (it is not at launch).',
      tags: ['Consent'],
      auth: 'borrower',
      query: z.strictObject({ language: Language }),
      responses: { 200: NoticeList },
      errors: [401, 403, 422],
      handler: async ({ tx, query }) => {
        const marketing =
          (await tx.query<{ v: boolean }>('select consent.marketing_enabled() as v')).rows[0]?.v ===
          true;
        const r = await tx.query<{ purpose: string; language: string }>(
          `with latest as (
             select distinct on (purpose, language) id, purpose, version, language, title, body_markdown, body_sha256, review_status
               from consent.notices where status = 'published' and lender_org_id is null
              order by purpose, language, version desc)
           select id, purpose, version, language, title, body_markdown as "bodyMarkdown", body_sha256 as "bodySha256", review_status as "reviewStatus",
                  (language <> $1) as "languageFallback", purpose = any($2::text[]) as required
             from latest l
            where l.language = $1 or (l.language = 'en' and not exists (select 1 from latest x where x.purpose = l.purpose and x.language = $1))
            order by required desc, purpose`,
          [query.language, [...CONSENT_PURPOSES_REQUIRED]],
        );
        const items = (r.rows as unknown as { purpose: string }[]).filter(
          (n) => marketing || n.purpose !== 'marketing',
        );
        return { status: 200, body: { items, marketingAvailable: marketing } };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/consent/decisions',
      operationId: 'recordConsentDecision',
      summary:
        'Record accepting, declining or withdrawing one consent against the exact wording shown',
      description:
        'Each consent is its own record. Terms, privacy notice, sharing with lenders and (later) marketing are never combined. Marketing cannot be recorded while it is disabled.',
      tags: ['Consent'],
      auth: 'borrower',
      idempotent: true,
      body: ConsentDecisionInput,
      responses: { 201: Created },
      errors: [400, 401, 403, 404, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, body }) => {
        const r = await tx.query<{ id: string }>(
          'select consent.record_decision($1::uuid, $2::consent.decision, $3, $4) as id',
          [body.noticeId, body.decision, body.appVersion, body.screen],
        );
        const id = r.rows[0]?.id;
        if (!id) throw new Error('record_decision returned nothing');
        return { status: 201, body: { id } };
      },
    }),

    // ---- reference data -----------------------------------------------------------------------------
    userRoute({
      method: 'get',
      path: '/v1/loan-purposes',
      operationId: 'listLoanPurposes',
      summary: 'The fixed list of loan purposes, labelled in your language',
      tags: ['Borrower'],
      auth: 'borrower',
      query: z.strictObject({ language: Language }),
      responses: { 200: LoanPurposeList },
      errors: [401, 403, 422],
      handler: async ({ tx, query }) => {
        const r = await tx.query(
          `select key, case when $1 = 'hi' then label_hi else label_en end as label,
                  case when $1 = 'hi' then hi_review_status else 'approved' end as "labelStatus"
             from lending.loan_purposes where active order by sort_order, key`,
          [query.language],
        );
        return { status: 200, body: { items: r.rows } };
      },
    }),
    userRoute({
      method: 'get',
      path: '/v1/borrower/categories',
      operationId: 'listBorrowerCategories',
      summary: 'Loan categories the platform currently offers',
      tags: ['Borrower'],
      auth: 'borrower',
      responses: { 200: BorrowerCategoryList },
      errors: [401, 403],
      handler: async ({ tx }) => {
        const r = await tx.query(
          `select key, name, min_tenure_days as "minTenureDays" from lending.product_categories where availability = 'enabled' order by name`,
        );
        return { status: 200, body: { items: r.rows } };
      },
    }),
    userRoute({
      method: 'get',
      path: '/v1/borrower/products',
      operationId: 'listBorrowerProducts',
      summary: 'Approved products of lenders that are live (visibility only; not an offer)',
      description:
        'Reads the Phase 04 visibility view: a product appears only when its lender is activated and the product version is approved. Visibility does not mean you are eligible or approved.',
      tags: ['Borrower'],
      auth: 'borrower',
      responses: { 200: BorrowerProductList },
      errors: [401, 403],
      handler: async ({ tx }) => {
        const r = await tx.query<Record<string, string>>(
          `select version_id as "versionId", category_key as "categoryKey", name,
                  min_amount_minor::text as "minAmountMinor", max_amount_minor::text as "maxAmountMinor",
                  min_tenure_days as "minTenureDays", max_tenure_days as "maxTenureDays"
             from lending.borrower_visible_product_versions order by name limit 100`,
        );
        return {
          status: 200,
          body: {
            items: r.rows.map((x) => ({
              ...x,
              minAmountMinor: Number(x.minAmountMinor),
              maxAmountMinor: Number(x.maxAmountMinor),
            })),
            note: 'Seeing a product is not an approval or an offer. A lender decides after its own checks.',
          },
        };
      },
    }),

    // ---- loan requests ------------------------------------------------------------------------------
    userRoute({
      method: 'post',
      path: '/v1/loan-requests',
      operationId: 'createLoanRequest',
      summary: 'Start a loan request (a draft that expires 30 days after it is created)',
      tags: ['Loan requests'],
      auth: 'borrower',
      idempotent: true,
      body: LoanRequestInput,
      responses: { 201: LoanRequestVersion },
      errors: [400, 401, 403, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, body }) => {
        const r = await tx.query<{ id: string }>(
          'select lending.request_create($1, $2::bigint, $3, $4, $5::uuid) as id',
          [
            body.categoryKey,
            body.amountMinor,
            body.tenureDays,
            body.purposeCode,
            body.productVersionId ?? null,
          ],
        );
        const id = r.rows[0]?.id;
        if (!id) throw new Error('request_create returned nothing');
        return { status: 201, body: { id, version: 1 } };
      },
    }),
    userRoute({
      method: 'get',
      path: '/v1/loan-requests',
      operationId: 'listLoanRequests',
      summary: 'Your loan requests, newest first (an overdue draft shows as expired)',
      tags: ['Loan requests'],
      auth: 'borrower',
      query: PageQuerySchema,
      responses: { 200: LoanRequestPage },
      errors: [400, 401, 403, 422],
      handler: async ({ tx, query }) => {
        const cursor = decodeCursor(query.cursor);
        const r = await tx.query<RequestRow>(
          `select ${REQUEST_COLUMNS} from lending.my_loan_requests
            where ($1::timestamptz is null or (created_at, id) < ($1::timestamptz, $2::uuid))
            order by created_at desc, id desc limit $3`,
          [cursor?.t ?? null, cursor?.id ?? null, query.limit + 1],
        );
        const rows = r.rows.slice(0, query.limit);
        const last = rows.at(-1);
        return {
          status: 200,
          body: {
            items: rows.map(toRequest),
            nextCursor:
              r.rows.length > query.limit && last
                ? encodeCursor({ t: last.createdAt, id: last.id })
                : null,
          },
        };
      },
    }),
    userRoute({
      method: 'get',
      path: '/v1/loan-requests/:id',
      operationId: 'getLoanRequest',
      summary: 'One of your requests with its status history',
      description:
        'The history lists only events that happened. Nothing here implies lender acceptance, KYC, approval or disbursement.',
      tags: ['Loan requests'],
      auth: 'borrower',
      params: Id,
      responses: { 200: LoanRequestDetail },
      errors: [401, 403, 404],
      handler: async ({ tx, params }) => {
        const r = await tx.query<RequestRow>(
          `select ${REQUEST_COLUMNS} from lending.my_loan_requests where id = $1::uuid`,
          [params.id],
        );
        const row = r.rows[0];
        if (!row) throw new ApiError(404, 'not_found', 'Not Found');
        const events = await tx.query(
          `select event, from_status as "fromStatus", to_status as "toStatus", occurred_at::text as "occurredAt"
             from lending.loan_request_events where loan_request_id = $1::uuid order by occurred_at, id`,
          [params.id],
        );
        return { status: 200, body: { request: toRequest(row), events: events.rows } };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/loan-requests/:id/draft',
      operationId: 'updateLoanRequestDraft',
      summary: 'Change a draft (send the version you saw; a stale edit is refused)',
      description: 'Editing never extends the 30-day expiry.',
      tags: ['Loan requests'],
      auth: 'borrower',
      idempotent: true,
      params: Id,
      body: LoanRequestPatch,
      responses: { 200: LoanRequestVersion },
      errors: [400, 401, 403, 404, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params, body }) => {
        const r = await tx.query<{ v: number }>(
          'select lending.request_update($1::uuid, $2, $3::bigint, $4, $5, $6::uuid, $7::boolean) as v',
          [
            params.id,
            body.expectedVersion,
            body.amountMinor ?? null,
            body.tenureDays ?? null,
            body.purposeCode ?? null,
            body.productVersionId ?? null,
            body.clearProduct ?? false,
          ],
        );
        return {
          status: 200,
          body: { id: params.id, version: r.rows[0]?.v ?? body.expectedVersion + 1 },
        };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/loan-requests/:id/submit',
      operationId: 'submitLoanRequest',
      summary: 'Submit a draft',
      description:
        'Needs the three required consents, a valid purpose, an unexpired draft and (if one was chosen) a product that is still available. Repeating the call returns the same reference. A submitted request is not accepted, approved or sanctioned by anyone.',
      tags: ['Loan requests'],
      auth: 'borrower',
      idempotent: true,
      params: Id,
      body: VersionedAction,
      responses: { 200: SubmitResult },
      errors: [400, 401, 403, 404, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params, body }) => {
        const r = await tx.query<{ ref: string }>(
          'select lending.request_submit($1::uuid, $2) as ref',
          [params.id, body.expectedVersion],
        );
        const ref = r.rows[0]?.ref;
        if (!ref) throw new Error('request_submit returned nothing');
        return {
          status: 200,
          body: { id: params.id, submissionReference: ref, status: 'submitted' as const },
        };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/loan-requests/:id/withdraw',
      operationId: 'withdrawLoanRequest',
      summary: 'Withdraw a draft or a submitted request',
      tags: ['Loan requests'],
      auth: 'borrower',
      idempotent: true,
      params: Id,
      responses: { 200: Done },
      errors: [401, 403, 404, 409],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params }) => {
        await tx.query('select lending.request_withdraw($1::uuid)', [params.id]);
        return { status: 200, body: { ok: true as const } };
      },
    }),

    // ---- step-up verification --------------------------------------------------------------------------------
    userRoute({
      method: 'post',
      path: '/v1/stepup/challenges',
      operationId: 'startStepUp',
      summary: 'Send a one-time code to your number to confirm a sensitive action',
      description:
        'The code is tied to this action and this object, expires in 5 minutes and works once. `delivery: accepted` means the SMS provider took the message, not that it arrived. The sensitive actions themselves arrive in later phases.',
      tags: ['Security'],
      auth: 'borrower',
      idempotent: true,
      body: StepUpStart,
      responses: { 201: StepUpStarted },
      errors: [400, 401, 403, 409, 422, 503],
      rateLimit: STEPUP_LIMIT,
      handler: async ({ tx, body }) => {
        if (!deps?.stepUpPepper) throw unavailable('stepup');
        const phone = (await tx.query<{ p: string | null }>('select identity.my_phone() as p'))
          .rows[0]?.p;
        if (!phone) throw new ApiError(409, 'no_phone', 'Conflict');
        const lang =
          (
            await tx.query<{ l: 'en' | 'hi' }>(
              'select preferred_language as l from identity.borrowers limit 1',
            )
          ).rows[0]?.l ?? 'en';
        const challengeId = randomUUID();
        const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
        const started = await tx.query<{ e: string }>(
          'select identity.stepup_start($1::uuid, $2, $3, $4)::text as e',
          [
            challengeId,
            body.action,
            body.contextRef,
            hashCode(deps.stepUpPepper, challengeId, code),
          ],
        );
        const result = await sms.send({
          template: 'stepup_otp',
          to: toE164(phone),
          language: lang,
          variables: { otp: code },
          idempotencyKey: `stepup-${challengeId}`,
        });
        const delivery =
          result.status === 'accepted'
            ? 'accepted'
            : result.status === 'rejected'
              ? 'rejected'
              : result.status;
        await tx.query('select identity.stepup_record_delivery($1::uuid, $2, $3)', [
          challengeId,
          delivery,
          result.status === 'accepted' ? result.providerRef : null,
        ]);
        return {
          status: 201,
          body: { challengeId, expiresAt: started.rows[0]?.e ?? '', delivery },
        };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/stepup/challenges/:id/verify',
      operationId: 'verifyStepUp',
      summary: 'Check the code you received (five wrong tries lock the challenge)',
      tags: ['Security'],
      auth: 'borrower',
      idempotent: true,
      params: Id,
      body: StepUpVerify,
      responses: { 200: StepUpVerified },
      errors: [400, 401, 403, 422, 503],
      rateLimit: STEPUP_LIMIT,
      handler: async ({ tx, params, body }) => {
        if (!deps?.stepUpPepper) throw unavailable('stepup');
        const r = await tx.query<{ v: z.infer<typeof StepUpVerified>['result'] }>(
          'select identity.stepup_verify($1::uuid, $2) as v',
          [params.id, hashCode(deps.stepUpPepper, params.id, body.code)],
        );
        return { status: 200, body: { result: r.rows[0]?.v ?? 'not_found' } };
      },
    }),

    // ---- device integrity ------------------------------------------------------------------------------------------
    userRoute({
      method: 'post',
      path: '/v1/integrity/nonce',
      operationId: 'issueIntegrityNonce',
      summary: 'Get a single-use value to bind into a device-integrity token',
      tags: ['Security'],
      auth: 'borrower',
      idempotent: true,
      responses: { 201: IntegrityNonce },
      errors: [401, 403],
      rateLimit: STEPUP_LIMIT,
      handler: async ({ tx }) => {
        const nonce = randomBytes(24).toString('base64url');
        const r = await tx.query<{ e: string }>(
          'select identity.issue_integrity_nonce($1)::text as e',
          [createHash('sha256').update(nonce).digest('hex')],
        );
        return { status: 201, body: { nonce, expiresAt: r.rows[0]?.e ?? '' } };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/integrity/verify',
      operationId: 'verifyIntegrity',
      summary: 'Have the server check a device-integrity token; only the resulting level is kept',
      description:
        'The level is decided by the server\'s verifier, never by the client. It says nothing about who you are and does not replace the one-time code. With no verifier configured the answer is "unavailable" and the level stays "none".',
      tags: ['Security'],
      auth: 'borrower',
      idempotent: true,
      body: IntegrityVerifyInput,
      responses: { 200: IntegrityResult },
      errors: [400, 401, 403, 409, 422],
      rateLimit: STEPUP_LIMIT,
      handler: async ({ tx, body }) => {
        const fresh = await tx.query<{ ok: boolean }>(
          'select identity.consume_integrity_nonce($1) as ok',
          [createHash('sha256').update(body.nonce).digest('hex')],
        );
        if (fresh.rows[0]?.ok !== true) throw new ApiError(409, 'nonce_invalid', 'Conflict');
        if (!deps)
          return { status: 200, body: { status: 'unavailable' as const, level: 'none' as const } };
        const result = await deps.integrity.verify({ token: body.token, nonce: body.nonce });
        if (result.status !== 'verified')
          return { status: 200, body: { status: result.status, level: 'none' as const } };
        await tx.query('select identity.record_attestation($1, $2)', [
          result.level,
          deps.integrity.descriptor.key.replace(/[^a-z0-9_]/g, '_'),
        ]);
        return { status: 200, body: { status: 'verified' as const, level: result.level } };
      },
    }),

    // ---- account deletion -------------------------------------------------------------------------------------------
    userRoute({
      method: 'post',
      path: '/v1/borrower/deletion-requests',
      operationId: 'requestAccountDeletion',
      summary: 'Ask to close your account (your profile is anonymised; some records must be kept)',
      description:
        'We anonymise your profile. Consent and audit records are retained as required; the retention periods are not yet decided, so none is promised here. A request is refused while a loan account is active.',
      tags: ['Borrower'],
      auth: 'borrower',
      idempotent: true,
      responses: { 201: Created },
      errors: [401, 403],
      rateLimit: STEPUP_LIMIT,
      handler: async ({ tx }) => {
        const r = await tx.query<{ id: string }>('select identity.request_deletion() as id');
        const id = r.rows[0]?.id;
        if (!id) throw new Error('request_deletion returned nothing');
        return { status: 201, body: { id } };
      },
    }),
    userRoute({
      method: 'get',
      path: '/v1/borrower/deletion-requests/current',
      operationId: 'getAccountDeletionStatus',
      summary: 'The state of your latest closure request',
      tags: ['Borrower'],
      auth: 'user',
      responses: { 200: DeletionCurrent },
      errors: [401, 403],
      handler: async ({ tx }) => {
        const r = await tx.query(
          `select id, status, blocked_reason as "blockedReason", requested_at::text as "requestedAt", processed_at::text as "processedAt",
                  (auth_identity_removed_at is not null) as "signInIdentityRemoved"
             from identity.deletion_requests order by requested_at desc limit 1`,
        );
        return { status: 200, body: { item: r.rows[0] ? DeletionRequest.parse(r.rows[0]) : null } };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/borrower/deletion-requests/cancel',
      operationId: 'cancelAccountDeletion',
      summary: 'Cancel a closure request that has not been processed yet',
      tags: ['Borrower'],
      auth: 'borrower',
      idempotent: true,
      responses: { 200: Done },
      errors: [401, 403],
      rateLimit: STEPUP_LIMIT,
      handler: async ({ tx }) => {
        await tx.query('select identity.cancel_deletion()');
        return { status: 200, body: { ok: true as const } };
      },
    }),

    // ---- Supabase "Send SMS" auth hook -------------------------------------------------------------------------------------
    publicRoute({
      method: 'post',
      path: '/v1/hooks/send-sms',
      operationId: 'sendSmsAuthHook',
      summary: 'Called by Supabase Auth to deliver a sign-in code (signed; not for apps)',
      description:
        "Verifies the Standard Webhooks signature, then sends the code through the configured SMS adapter within the hook's time budget. The code is never logged or stored. 200 means the provider accepted the message, not that it arrived.",
      tags: ['Security'],
      auth: 'none',
      body: HookBody,
      responses: {
        200: z.object({}),
        500: z.object({ error: z.object({ http_code: z.literal(500), message: z.string() }) }),
      },
      errors: [401, 422, 503],
      rateLimit: { max: 600, timeWindow: '1 minute' },
      // First thing, before the body schema is applied and before any database work: the signature over the
      // exact bytes received. An unsigned caller gets 401 and learns nothing about the body rules.
      verifyRequest: (request) => {
        if (!deps?.sendSmsHookSecret) throw unavailable('sms_hook');
        const raw = (request as { rawBody?: string }).rawBody ?? '';
        const h = request.headers;
        const ok = verifyWebhookSignature({
          secret: deps.sendSmsHookSecret,
          id: typeof h['webhook-id'] === 'string' ? h['webhook-id'] : undefined,
          timestamp:
            typeof h['webhook-timestamp'] === 'string' ? h['webhook-timestamp'] : undefined,
          signatureHeader:
            typeof h['webhook-signature'] === 'string' ? h['webhook-signature'] : undefined,
          body: raw,
        });
        if (!ok) throw new ApiError(401, 'invalid_signature', 'Unauthorized');
      },
      handler: async ({ request, body }) => {
        const h = request.headers;
        // A signed request can be captured; refuse a second delivery of the same message id. With a
        // database-backed guard (always wired when deployed) this holds across every API instance; the
        // per-process map is only the fallback for a single local process without a database.
        const messageId = typeof h['webhook-id'] === 'string' ? h['webhook-id'] : '';
        if (!HOOK_MESSAGE_ID.test(messageId)) {
          throw new ApiError(401, 'invalid_message_id', 'Unauthorized');
        }
        let first: boolean;
        if (deps?.webhookDedup) {
          try {
            first = await deps.webhookDedup.claim(HOOK_SOURCE, messageId);
          } catch {
            // Fail closed: without the guard a replay could be accepted. The sender retries.
            throw new ApiError(503, 'dedup_unavailable', 'Service Unavailable');
          }
        } else {
          first = seenHookIds.claim(messageId);
        }
        if (!first) throw new ApiError(401, 'replayed', 'Unauthorized');
        const result = await sms.send({
          template: 'login_otp',
          to: toE164(body.user.phone),
          language: 'en',
          variables: { otp: body.sms.otp },
          idempotencyKey: `login-${typeof h['webhook-id'] === 'string' ? h['webhook-id'] : randomUUID()}`,
        });
        if (result.status === 'accepted') return { status: 200, body: {} };
        return {
          status: 500,
          body: { error: { http_code: 500 as const, message: 'sms_unavailable' } },
        };
      },
    }),
  ];
}
