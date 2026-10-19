import {
  AckInput,
  BorrowerApplicationList,
  CheckInput,
  Comparison,
  ComparisonInput,
  ConnectorInput,
  ConnectorList,
  ContactResult,
  Created,
  DecisionInput,
  DecisionResult,
  Done,
  LenderApplicationDetail,
  LenderApplicationPage,
  LenderConsentInput,
  MatchingLenderList,
  OfferInput,
  OfferResult,
  OfferWithdrawInput,
  OfferWithdrawn,
  RouteResult,
  RuleDecided,
  RuleDecisionInput,
  RuleList,
  RuleProposalInput,
  SelectionCreated,
  SelectionInput,
  SelectionView,
} from '@udofin/contracts';
import { z } from 'zod';
import { decodeCursor, encodeCursor } from '../../http/pagination.js';
import { userRoute, type RouteDefinition } from '../../http/routes.js';

const WRITE_LIMIT = { max: 60, timeWindow: '1 minute' };
const COMPARE_LIMIT = { max: 120, timeWindow: '1 minute' };
const Id = z.strictObject({ id: z.uuid() });
const SelectionItemParams = z.strictObject({ id: z.uuid(), lenderId: z.uuid() });
const LanguageQuery = z.strictObject({ language: z.enum(['en', 'hi']).default('en') });
const PageParams = z.strictObject({
  limit: z.coerce.number().int().min(1).max(49).default(20),
  cursor: z.string().max(300).optional(),
});

const first = <T>(rows: { r: T }[]): T => {
  const row = rows[0];
  if (!row) throw new Error('database function returned nothing');
  return row.r;
};

/**
 * Lender routing, lender-reported progress, decisions, offers and the comparison. Every rule (consent, the five-lender cap,
 * offer checks, ordering) lives in the database functions; routes validate shape, take the caller from the token and
 * pass identifiers. Lender-side routes require a signed-in lender or platform member with a second factor.
 */
export const routingRoutes: RouteDefinition[] = [
  // ---- borrower: choose lenders, consent per lender, route ----------------------------------------------------
  userRoute({
    method: 'get',
    path: '/v1/loan-requests/:id/lenders',
    operationId: 'listMatchingLenders',
    summary:
      'Live lenders with an approved product that fits this request (visibility only, not an offer)',
    tags: ['Lender routing'],
    auth: 'borrower',
    params: Id,
    responses: { 200: MatchingLenderList },
    errors: [401, 403, 404],
    handler: async ({ tx, params }) => {
      const r = await tx.query(
        `select lender_org_id as "lenderId", lender_name as "lenderName", version_id as "versionId", product_name as "productName",
                min_amount_minor::bigint::float8 as "minAmountMinor", max_amount_minor::bigint::float8 as "maxAmountMinor",
                min_tenure_days as "minTenureDays", max_tenure_days as "maxTenureDays"
           from lending.matching_products($1::uuid)`,
        [params.id],
      );
      return { status: 200, body: { items: r.rows, maxLenders: 5 as const } };
    },
  }),
  userRoute({
    method: 'post',
    path: '/v1/loan-requests/:id/selection',
    operationId: 'selectLenders',
    summary: 'Choose up to five lenders for this request (nothing is sent yet)',
    description:
      'No lender is preselected. The limit counts every lender ever routed for the request. Each chosen lender needs its own consent before anything is sent.',
    tags: ['Lender routing'],
    auth: 'borrower',
    idempotent: true,
    params: Id,
    body: SelectionInput,
    responses: { 201: SelectionCreated },
    errors: [400, 401, 403, 404, 409, 422],
    rateLimit: WRITE_LIMIT,
    handler: async ({ tx, params, body }) => {
      const r = await tx.query<{ r: string }>(
        'select lending.select_lenders($1::uuid, $2::jsonb) as r',
        [params.id, JSON.stringify(body.items)],
      );
      return { status: 201, body: { selectionId: first(r.rows) } };
    },
  }),
  userRoute({
    method: 'get',
    path: '/v1/loan-requests/:id/selection',
    operationId: 'getLenderSelection',
    summary:
      "The lenders chosen so far, with each lender's own consent wording and whether consent is in force",
    description:
      'A lender with no published wording shows `notice: null`: sharing with it is blocked until wording is approved. Nothing is invented.',
    tags: ['Lender routing'],
    auth: 'borrower',
    params: Id,
    query: LanguageQuery,
    responses: { 200: SelectionView },
    errors: [401, 403, 404, 422],
    handler: async ({ tx, params, query }) => {
      const r = await tx.query<{ r: unknown }>('select lending.selection_view($1::uuid, $2) as r', [
        params.id,
        query.language,
      ]);
      return { status: 200, body: first(r.rows) };
    },
  }),
  userRoute({
    method: 'post',
    path: '/v1/selections/:id/items/:lenderId/remove',
    operationId: 'removeSelectedLender',
    summary: 'Take a lender out of the selection before sending',
    tags: ['Lender routing'],
    auth: 'borrower',
    idempotent: true,
    params: SelectionItemParams,
    responses: { 200: Done },
    errors: [400, 401, 403, 404],
    rateLimit: WRITE_LIMIT,
    handler: async ({ tx, params }) => {
      await tx.query('select lending.remove_selection_item($1::uuid, $2::uuid)', [
        params.id,
        params.lenderId,
      ]);
      return { status: 200, body: { ok: true as const } };
    },
  }),
  userRoute({
    method: 'post',
    path: '/v1/loan-requests/:id/lender-consents',
    operationId: 'recordLenderConsent',
    summary: 'Accept, decline or withdraw consent to share this request with ONE named lender',
    description:
      "One record per lender, against that lender's own wording. Withdrawing before sending stops the transmission; withdrawing after is recorded for the lender-side process. A consent for one lender never covers another.",
    tags: ['Lender routing'],
    auth: 'borrower',
    idempotent: true,
    params: Id,
    body: LenderConsentInput,
    responses: { 201: Created },
    errors: [400, 401, 403, 404, 409, 422],
    rateLimit: WRITE_LIMIT,
    handler: async ({ tx, params, body }) => {
      const r = await tx.query<{ r: string }>(
        'select consent.record_lender_decision($1::uuid, $2::uuid, $3::uuid, $4::consent.decision, $5, $6) as r',
        [params.id, body.lenderId, body.noticeId, body.decision, body.appVersion, body.screen],
      );
      return { status: 201, body: { id: first(r.rows) } };
    },
  }),
  userRoute({
    method: 'post',
    path: '/v1/selections/:id/route',
    operationId: 'routeSelection',
    summary: 'Send the request to the chosen lenders (all need current consent)',
    description:
      'Creates one application per chosen lender, or none. Each lender then receives only the fixed minimum payload, read at send time after consent is checked again.',
    tags: ['Lender routing'],
    auth: 'borrower',
    idempotent: true,
    params: Id,
    responses: { 201: RouteResult },
    errors: [400, 401, 403, 404, 409, 422],
    rateLimit: WRITE_LIMIT,
    handler: async ({ tx, params }) => {
      const r = await tx.query<{ r: unknown[] }>('select lending.route_selection($1::uuid) as r', [
        params.id,
      ]);
      return { status: 201, body: { items: first(r.rows) } };
    },
  }),
  userRoute({
    method: 'get',
    path: '/v1/loan-requests/:id/applications',
    operationId: 'listBorrowerApplications',
    summary: 'Where each lender application stands, as reported by the lender',
    description:
      'Check statuses are reported by the lender; Udofin has not performed or verified them. "No response" is not a decline.',
    tags: ['Lender routing'],
    auth: 'borrower',
    params: Id,
    responses: { 200: BorrowerApplicationList },
    errors: [401, 403, 404],
    handler: async ({ tx, params }) => {
      const r = await tx.query<{ r: unknown }>('select lending.my_applications($1::uuid) as r', [
        params.id,
      ]);
      return { status: 200, body: { items: first(r.rows) } };
    },
  }),
  userRoute({
    method: 'post',
    path: '/v1/applications/:id/withdraw',
    operationId: 'withdrawBorrowerApplication',
    summary: 'Withdraw one lender application',
    tags: ['Lender routing'],
    auth: 'borrower',
    idempotent: true,
    params: Id,
    responses: { 200: Done },
    errors: [400, 401, 403, 404, 409],
    rateLimit: WRITE_LIMIT,
    handler: async ({ tx, params }) => {
      await tx.query('select lending.withdraw_application($1::uuid)', [params.id]);
      return { status: 200, body: { ok: true as const } };
    },
  }),
  userRoute({
    method: 'post',
    path: '/v1/loan-requests/:id/comparison',
    operationId: 'compareOffers',
    summary:
      'Every valid offer for this request, in the approved order, and the lenders that did not offer',
    description:
      'Serving the comparison writes the display log (offers, ranks, rule version, lenders that did not offer). Without an approved ordering rule it answers 409 ranking_rule_not_approved. Offers are shown exactly as the lenders stated them.',
    tags: ['Lender routing'],
    auth: 'borrower',
    idempotent: true,
    params: Id,
    body: ComparisonInput,
    responses: { 200: Comparison },
    errors: [400, 401, 403, 404, 409, 422],
    rateLimit: COMPARE_LIMIT,
    handler: async ({ tx, params, body }) => {
      const r = await tx.query<{ r: unknown }>(
        'select lending.compare_offers($1::uuid, $2, $3, $4) as r',
        [params.id, body.sort ?? null, body.platform, body.language],
      );
      return { status: 200, body: first(r.rows) };
    },
  }),

  // ---- lender portal ---------------------------------------------------------------------------------------------
  userRoute({
    method: 'get',
    path: '/v1/lender/applications',
    operationId: 'listLenderApplications',
    summary: 'Applications routed to your organisation (approved payload only)',
    description:
      'No borrower identifier and no phone number appear here. The contact detail is a separate, audited call.',
    tags: ['Lender applications'],
    auth: 'staff',
    query: PageParams,
    responses: { 200: LenderApplicationPage },
    errors: [400, 401, 403, 422],
    handler: async ({ tx, query }) => {
      const cursor = decodeCursor(query.cursor);
      const r = await tx.query<{ r: { applicationId: string; createdAt: string }[] }>(
        'select lending.lender_applications($1, $2::timestamptz, $3::uuid) as r',
        [query.limit + 1, cursor?.t ?? null, cursor?.id ?? null],
      );
      const rows = first(r.rows);
      const items = rows.slice(0, query.limit);
      const last = items.at(-1);
      return {
        status: 200,
        body: {
          items,
          nextCursor:
            rows.length > query.limit && last
              ? encodeCursor({ t: last.createdAt, id: last.applicationId })
              : null,
        },
      };
    },
  }),
  userRoute({
    method: 'get',
    path: '/v1/lender/applications/:id',
    operationId: 'getLenderApplication',
    summary:
      'Decisions, offers (with held-for-correction submissions) and events for one application',
    tags: ['Lender applications'],
    auth: 'staff',
    params: Id,
    responses: { 200: LenderApplicationDetail },
    errors: [401, 403, 404],
    handler: async ({ tx, params }) => {
      const r = await tx.query<{ r: unknown }>(
        'select lending.lender_application_detail($1::uuid) as r',
        [params.id],
      );
      return { status: 200, body: first(r.rows) };
    },
  }),
  userRoute({
    method: 'post',
    path: '/v1/lender/applications/:id/acknowledge',
    operationId: 'acknowledgeLenderApplication',
    summary:
      'Confirm that your organisation received the application (optionally with your own reference)',
    tags: ['Lender applications'],
    auth: 'staff',
    idempotent: true,
    params: Id,
    body: AckInput,
    responses: { 200: Done },
    errors: [400, 401, 403, 404, 409, 422],
    rateLimit: WRITE_LIMIT,
    handler: async ({ tx, params, body }) => {
      await tx.query('select lending.lender_ack_application($1::uuid, $2)', [
        params.id,
        body.lenderApplicationRef ?? null,
      ]);
      return { status: 200, body: { ok: true as const } };
    },
  }),
  userRoute({
    method: 'post',
    path: '/v1/lender/applications/:id/checks',
    operationId: 'reportLenderCheck',
    summary: 'Report the status of a KYC, bureau or account-aggregator check you performed',
    description:
      'Status only. Do not send documents, identity numbers, reports or scores; none can be stored. The status is shown to the borrower as reported by you.',
    tags: ['Lender applications'],
    auth: 'staff',
    idempotent: true,
    params: Id,
    body: CheckInput,
    responses: { 200: Done },
    errors: [400, 401, 403, 404, 409, 422],
    rateLimit: WRITE_LIMIT,
    handler: async ({ tx, params, body }) => {
      await tx.query('select lending.lender_report_check($1::uuid, $2, $3, $4, $5::timestamptz)', [
        params.id,
        body.kind,
        body.status,
        body.lenderEventRef ?? null,
        body.reportedAt ?? null,
      ]);
      return { status: 200, body: { ok: true as const } };
    },
  }),
  userRoute({
    method: 'post',
    path: '/v1/lender/applications/:id/decision',
    operationId: 'recordLenderDecision',
    summary: 'Record your credit decision status',
    description:
      'Udofin records what you report and never decides. A decision that arrives after your response deadline is recorded and flagged, not applied, until a late-response policy exists.',
    tags: ['Lender applications'],
    auth: 'staff',
    idempotent: true,
    params: Id,
    body: DecisionInput,
    responses: { 200: DecisionResult },
    errors: [400, 401, 403, 404, 409, 422],
    rateLimit: WRITE_LIMIT,
    handler: async ({ tx, params, body }) => {
      const r = await tx.query<{ r: unknown }>(
        'select lending.lender_record_decision($1::uuid, $2, $3, $4::timestamptz) as r',
        [params.id, body.decision, body.lenderEventRef ?? null, body.reportedAt ?? null],
      );
      return { status: 200, body: first(r.rows) };
    },
  }),
  userRoute({
    method: 'post',
    path: '/v1/lender/applications/:id/offers',
    operationId: 'submitLenderOffer',
    summary: 'Submit your offer exactly as you state it',
    description:
      'Needs a recorded approval first. Udofin validates the shape and your KFS link (registered host, https) and stores your values without recalculating or rounding. An offer that fails a check is held for correction and never shown. Sending the same reference again creates a new revision; the old one stays on record as withdrawn.',
    tags: ['Lender applications'],
    auth: 'staff',
    idempotent: true,
    params: Id,
    body: OfferInput,
    responses: { 200: OfferResult },
    errors: [400, 401, 403, 404, 409, 422],
    rateLimit: WRITE_LIMIT,
    handler: async ({ tx, params, body }) => {
      const r = await tx.query<{ r: unknown }>(
        'select lending.lender_submit_offer($1::uuid, $2::jsonb) as r',
        [params.id, JSON.stringify(body)],
      );
      return { status: 200, body: first(r.rows) };
    },
  }),
  userRoute({
    method: 'post',
    path: '/v1/lender/applications/:id/offers/withdraw',
    operationId: 'withdrawLenderOffer',
    summary: 'Withdraw an open offer by your reference',
    tags: ['Lender applications'],
    auth: 'staff',
    idempotent: true,
    params: Id,
    body: OfferWithdrawInput,
    responses: { 200: OfferWithdrawn },
    errors: [400, 401, 403, 404, 409, 422],
    rateLimit: WRITE_LIMIT,
    handler: async ({ tx, params, body }) => {
      const r = await tx.query<{ r: unknown }>(
        'select lending.lender_withdraw_offer($1::uuid, $2) as r',
        [params.id, body.lenderOfferRef],
      );
      return { status: 200, body: first(r.rows) };
    },
  }),
  userRoute({
    method: 'get',
    path: '/v1/lender/applications/:id/contact',
    operationId: 'getLenderApplicationContact',
    summary:
      "The borrower's phone number, while consent is in force (audited; not stored by Udofin)",
    description:
      'Refused after consent is withdrawn. The response is not cached and the call is recorded without the number.',
    tags: ['Lender applications'],
    auth: 'staff',
    params: Id,
    responses: { 200: ContactResult },
    errors: [401, 403, 404, 409],
    rateLimit: { max: 30, timeWindow: '1 minute' },
    handler: async ({ tx, params }) => {
      const r = await tx.query<{ r: unknown }>('select lending.lender_contact($1::uuid) as r', [
        params.id,
      ]);
      return { status: 200, body: first(r.rows) };
    },
  }),

  // ---- platform staff ----------------------------------------------------------------------------------------------
  userRoute({
    method: 'get',
    path: '/v1/platform/lender-connectors',
    operationId: 'listLenderConnectors',
    summary:
      'How each lender is reached (manual, api; mock only in tests) and its response and validity settings',
    tags: ['Lender routing administration'],
    auth: 'staff',
    responses: { 200: ConnectorList },
    errors: [401, 403],
    handler: async ({ tx }) => {
      const r = await tx.query(
        `select lender_org_id as "lenderId", kind, status, response_hours as "responseHours", offer_min_validity_days as "offerMinValidityDays",
                kfs_allowed_hosts as "kfsAllowedHosts", signing_secret_ref as "signingSecretRef"
           from lending.lender_connectors order by lender_org_id`,
      );
      return { status: 200, body: { items: r.rows } };
    },
  }),
  userRoute({
    method: 'post',
    path: '/v1/platform/lenders/:id/connector',
    operationId: 'configureLenderConnector',
    summary:
      'Set how a lender is reached, its response window (default 48 hours), offer-validity floor (7 days) and KFS hosts',
    description:
      'Holds the NAME of a signing secret, never its value. A mock connector cannot be configured here.',
    tags: ['Lender routing administration'],
    auth: 'staff',
    idempotent: true,
    params: Id,
    body: ConnectorInput,
    responses: { 200: Done },
    errors: [400, 401, 403, 404, 422],
    rateLimit: WRITE_LIMIT,
    handler: async ({ tx, params, body }) => {
      await tx.query(
        'select lending.set_lender_connector($1::uuid, $2, $3, $4, $5, $6::text[], $7)',
        [
          params.id,
          body.kind,
          body.status,
          body.responseHours,
          body.offerMinValidityDays,
          body.kfsAllowedHosts,
          body.signingSecretRef ?? null,
        ],
      );
      return { status: 200, body: { ok: true as const } };
    },
  }),
  userRoute({
    method: 'get',
    path: '/v1/platform/matching-rules',
    operationId: 'listMatchingRules',
    summary: 'Approved offer-ordering rule versions and open proposals',
    tags: ['Lender routing administration'],
    auth: 'staff',
    responses: { 200: RuleList },
    errors: [401, 403],
    handler: async ({ tx }) => {
      const versions = await tx.query(
        `select id, version, disclosed_metric as "disclosedMetric", mechanism_summary as "mechanismSummary", sort_keys as "sortKeys",
                alternative_sorts as "alternativeSorts", effective_from::text as "effectiveFrom"
           from lending.matching_rule_versions order by version desc`,
      );
      const proposals = await tx.query(
        `select id, status, disclosed_metric as "disclosedMetric", created_at::text as "createdAt"
           from lending.matching_rule_proposals order by created_at desc limit 50`,
      );
      return { status: 200, body: { versions: versions.rows, proposals: proposals.rows } };
    },
  }),
  userRoute({
    method: 'post',
    path: '/v1/platform/matching-rules',
    operationId: 'proposeMatchingRule',
    summary: 'Propose an offer-ordering rule (a different administrator must approve it)',
    tags: ['Lender routing administration'],
    auth: 'staff',
    idempotent: true,
    body: RuleProposalInput,
    responses: { 201: Created },
    errors: [400, 401, 403, 422],
    rateLimit: WRITE_LIMIT,
    handler: async ({ tx, body }) => {
      const r = await tx.query<{ r: string }>(
        'select lending.propose_matching_rule($1, $2, $3::text[], $4::text[], $5::timestamptz) as r',
        [
          body.mechanismSummary,
          body.disclosedMetric,
          body.sortKeys,
          body.alternativeSorts,
          body.effectiveFrom,
        ],
      );
      return { status: 201, body: { id: first(r.rows) } };
    },
  }),
  userRoute({
    method: 'post',
    path: '/v1/platform/matching-rules/:id/decision',
    operationId: 'decideMatchingRule',
    summary: 'Approve or reject a proposed ordering rule (not the proposer)',
    tags: ['Lender routing administration'],
    auth: 'staff',
    idempotent: true,
    params: Id,
    body: RuleDecisionInput,
    responses: { 200: RuleDecided },
    errors: [400, 401, 403, 404, 409, 422],
    rateLimit: WRITE_LIMIT,
    handler: async ({ tx, params, body }) => {
      const r = await tx.query<{ r: string | null }>(
        'select lending.decide_matching_rule($1::uuid, $2) as r',
        [params.id, body.approve],
      );
      return { status: 200, body: { versionId: first(r.rows) } };
    },
  }),
];
