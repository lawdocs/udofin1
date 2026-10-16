import { z } from 'zod';

/** Wire contracts for Phase 06: lender routing, lender-reported status, decisions, offers and comparison. */
export const MAX_LENDERS_PER_REQUEST = 5;
export const CHECK_KINDS = ['kyc', 'bureau', 'account_aggregator'] as const;
export const CHECK_STATUSES = ['not_started', 'in_progress', 'completed', 'failed'] as const;
export const LENDER_DECISIONS = [
  'pending',
  'processing',
  'info_needed',
  'declined',
  'approved',
] as const;
export const COMPARISON_SORTS = [
  'apr_bps',
  'monthly_repayment_minor',
  'total_repayable_minor',
] as const;
export const NON_OFFER_REASONS = [
  'declined',
  'no_response',
  'processing',
  'technical_failure',
  'offer_unavailable',
] as const;
export const APPLICATION_STAGES = [
  'sending',
  'sent',
  'acknowledged',
  'processing',
  'info_requested',
  'approved_awaiting_offer',
  'offer_received',
  'declined',
  'no_response',
  'technical_failure',
  'stopped',
  'withdrawn',
] as const;
export const PLATFORMS = ['android', 'ios', 'web'] as const;

const id = z.uuid();
const moneyInt = z.number().int().min(0).max(100_000_000_000_000);

export const MatchingLender = z.object({
  lenderId: id,
  lenderName: z.string(),
  versionId: id,
  productName: z.string(),
  minAmountMinor: moneyInt,
  maxAmountMinor: moneyInt,
  minTenureDays: z.number().int(),
  maxTenureDays: z.number().int(),
});
export type MatchingLender = z.infer<typeof MatchingLender>;
export const MatchingLenderList = z.object({
  items: z.array(MatchingLender),
  maxLenders: z.literal(MAX_LENDERS_PER_REQUEST),
});

export const SelectionInput = z.strictObject({
  items: z
    .array(z.strictObject({ lenderId: id, productVersionId: id.optional() }))
    .min(1)
    .max(MAX_LENDERS_PER_REQUEST),
});
export const SelectionCreated = z.object({ selectionId: id });

export const LenderNotice = z.object({
  id,
  version: z.number().int(),
  title: z.string(),
  bodyMarkdown: z.string(),
  bodySha256: z.string(),
  language: z.string(),
  /** `requires_review`: wording counsel has not approved. It cannot be the basis of consent. */
  reviewStatus: z.enum(['approved', 'requires_review']),
  languageFallback: z.boolean(),
});
export type LenderNotice = z.infer<typeof LenderNotice>;
export const SelectionItem = z.object({
  lenderId: id,
  lenderName: z.string(),
  productVersionId: id,
  productName: z.string(),
  status: z.enum(['selected', 'consented', 'routed', 'removed']),
  consentInForce: z.boolean(),
  /** null: no wording is published for this lender, so sharing with it is blocked. */
  notice: LenderNotice.nullable(),
});
export type SelectionItem = z.infer<typeof SelectionItem>;
export const SelectionView = z.object({
  maxLenders: z.literal(MAX_LENDERS_PER_REQUEST),
  routedCount: z.number().int(),
  selectionId: id.nullable(),
  items: z.array(SelectionItem),
});
export type SelectionView = z.infer<typeof SelectionView>;

export const LenderConsentInput = z.strictObject({
  lenderId: id,
  noticeId: id,
  decision: z.enum(['granted', 'denied', 'withdrawn']),
  screen: z
    .string()
    .regex(/^[a-z_]{2,40}$/)
    .default('lender_consent'),
  appVersion: z
    .string()
    .regex(/^[0-9A-Za-z.+-]{1,40}$/)
    .default('unknown'),
});
export const RouteResult = z.object({
  items: z.array(z.object({ applicationId: id, lenderId: id })),
});

export const CheckStatus = z.object({
  kind: z.enum(CHECK_KINDS),
  status: z.enum(CHECK_STATUSES),
  reportedAt: z.string(),
});
export const BorrowerApplication = z.object({
  applicationId: id,
  lenderId: id,
  lenderName: z.string(),
  productName: z.string(),
  status: z.string(),
  transmission: z.string(),
  responseDueAt: z.string(),
  stage: z.enum(APPLICATION_STAGES),
  /** Reported by the lender. Udofin has not performed or verified any of these checks. */
  checks: z.array(CheckStatus),
  consentWithdrawn: z.boolean(),
  createdAt: z.string(),
});
export type BorrowerApplication = z.infer<typeof BorrowerApplication>;
export const BorrowerApplicationList = z.object({ items: z.array(BorrowerApplication) });

export const ComparisonInput = z.strictObject({
  sort: z.enum(COMPARISON_SORTS).optional(),
  platform: z.enum(PLATFORMS).default('android'),
  language: z.enum(['en', 'hi']).default('en'),
});
export const ComparisonOffer = z.object({
  offerId: id,
  applicationId: id,
  lenderId: id,
  lenderName: z.string(),
  productName: z.string(),
  rank: z.number().int(),
  principalMinor: moneyInt,
  tenureDays: z.number().int(),
  aprBps: z.number().int(),
  monthlyRepaymentMinor: moneyInt,
  penalChargesSummary: z.string(),
  kfsUrl: z.string(),
  validUntil: z.string(),
  revision: z.number().int(),
  revised: z.boolean(),
});
export type ComparisonOffer = z.infer<typeof ComparisonOffer>;
export const ComparisonNonOffer = z.object({
  lenderId: id,
  lenderName: z.string(),
  applicationId: id,
  reason: z.enum(NON_OFFER_REASONS),
});
export type ComparisonNonOffer = z.infer<typeof ComparisonNonOffer>;
export const Comparison = z.object({
  runId: id,
  rule: z.object({
    version: z.number().int(),
    metric: z.string(),
    summary: z.string(),
    defaultSort: z.array(z.enum(COMPARISON_SORTS)),
    alternativeSorts: z.array(z.enum(COMPARISON_SORTS)),
  }),
  sort: z.string(),
  offers: z.array(ComparisonOffer),
  nonOffers: z.array(ComparisonNonOffer),
  filteredCount: z.number().int(),
});
export type Comparison = z.infer<typeof Comparison>;

// ---- lender portal ---------------------------------------------------------------------------
export const LenderApplicationRow = z.object({
  applicationId: id,
  udofinReference: z.string().nullable(),
  status: z.string(),
  transmission: z.string(),
  responseDueAt: z.string(),
  noResponseAt: z.string().nullable(),
  lenderApplicationRef: z.string().nullable(),
  request: z.object({
    categoryKey: z.string(),
    amountMinor: moneyInt,
    tenureDays: z.number().int(),
    purposeCode: z.string(),
  }),
  productName: z.string(),
  displayName: z.string().nullable(),
  language: z.string(),
  consentWithdrawn: z.boolean(),
  checks: z.array(CheckStatus),
  offer: z
    .object({ offerId: id, status: z.string(), validUntil: z.string(), revision: z.number().int() })
    .nullable(),
  createdAt: z.string(),
});
export type LenderApplicationRow = z.infer<typeof LenderApplicationRow>;
export const LenderApplicationPage = z.object({
  items: z.array(LenderApplicationRow),
  nextCursor: z.string().nullable(),
});
export const LenderApplicationDetail = z.object({
  decisions: z.array(
    z.object({
      decision: z.string(),
      source: z.string(),
      reportedAt: z.string(),
      late: z.boolean(),
      applied: z.boolean(),
      note: z.string().nullable(),
      recordedAt: z.string(),
    }),
  ),
  offerIntake: z.array(
    z.object({
      intakeId: id,
      validation: z.enum(['accepted', 'held']),
      issues: z.array(z.string()),
      offerId: id.nullable(),
      submittedAt: z.string(),
      submitted: z.record(z.string(), z.unknown()),
    }),
  ),
  offers: z.array(
    z.object({
      offerId: id,
      status: z.string(),
      revision: z.number().int(),
      lenderOfferRef: z.string().nullable(),
      validUntil: z.string(),
      kfsUrl: z.string().nullable(),
      aprBps: z.number().int(),
    }),
  ),
  events: z.array(z.object({ event: z.string(), occurredAt: z.string() })),
});
export type LenderApplicationDetail = z.infer<typeof LenderApplicationDetail>;

const ref = z.string().regex(/^[A-Za-z0-9._:-]{1,100}$/);
const reportedAt = z.iso.datetime({ offset: true }).optional();
export const AckInput = z.strictObject({ lenderApplicationRef: ref.optional() });
export const CheckInput = z.strictObject({
  kind: z.enum(CHECK_KINDS),
  status: z.enum(CHECK_STATUSES),
  lenderEventRef: ref.optional(),
  reportedAt,
});
export const DecisionInput = z.strictObject({
  decision: z.enum(LENDER_DECISIONS),
  lenderEventRef: ref.optional(),
  reportedAt,
});
export const DecisionResult = z.object({
  applied: z.boolean(),
  note: z.string().nullable().optional(),
});
/** The lender's offer exactly as it states it; Udofin validates the shape and stores it without recalculation. */
export const OfferInput = z.strictObject({
  lenderOfferRef: ref,
  principalMinor: z.number().int().min(1).max(100_000_000_000_000),
  tenureDays: z.number().int().min(1).max(10_950),
  installmentFrequency: z.enum(['monthly', 'fortnightly', 'weekly']),
  installmentCount: z.number().int().min(1).max(1200),
  installmentAmountMinor: z.number().int().min(1).max(100_000_000_000_000),
  monthlyRepaymentMinor: z.number().int().min(1).max(100_000_000_000_000),
  annualInterestRateBps: z.number().int().min(0).max(10_000),
  aprBps: z.number().int().min(0).max(20_000),
  processingFeeMinor: z.number().int().min(0).max(100_000_000_000_000),
  otherCharges: z.array(z.record(z.string(), z.unknown())).max(20).default([]),
  totalRepayableMinor: z.number().int().min(1).max(100_000_000_000_000),
  penalChargesSummary: z.string().trim().min(1).max(2000),
  kfsUrl: z.string().max(2048),
  issuedAt: z.iso.datetime({ offset: true }),
  validUntil: z.iso.datetime({ offset: true }),
});
export const OfferResult = z.object({
  applied: z.boolean(),
  status: z.enum(['accepted', 'held']),
  issues: z.array(z.string()),
  offerId: id.nullable(),
  intakeId: id,
  note: z.string().nullable().optional(),
});
export const OfferWithdrawInput = z.strictObject({ lenderOfferRef: ref });
export const OfferWithdrawn = z.object({ applied: z.literal(true), offerId: id });
export const ContactResult = z.object({ phone: z.string().nullable() });

// ---- platform staff --------------------------------------------------------------------------
export const ConnectorInput = z.strictObject({
  kind: z.enum(['manual', 'api']),
  status: z.enum(['draft', 'active', 'suspended']),
  responseHours: z.number().int().min(1).max(720).default(48),
  offerMinValidityDays: z.number().int().min(7).max(365).default(7),
  kfsAllowedHosts: z
    .array(z.string().regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/))
    .max(20)
    .default([]),
  signingSecretRef: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{2,63}$/)
    .optional(),
});
export const ConnectorView = z.object({
  lenderId: id,
  kind: z.enum(['manual', 'api', 'mock']),
  status: z.enum(['draft', 'active', 'suspended']),
  responseHours: z.number().int(),
  offerMinValidityDays: z.number().int(),
  kfsAllowedHosts: z.array(z.string()),
  signingSecretRef: z.string().nullable(),
});
export const ConnectorList = z.object({ items: z.array(ConnectorView) });
export const RuleProposalInput = z.strictObject({
  mechanismSummary: z.string().trim().min(20).max(4000),
  disclosedMetric: z.string().trim().min(5).max(500),
  sortKeys: z.array(z.enum(COMPARISON_SORTS)).min(1).max(2),
  alternativeSorts: z.array(z.enum(COMPARISON_SORTS)).max(3).default([]),
  effectiveFrom: z.iso.datetime({ offset: true }),
});
export const RuleDecisionInput = z.strictObject({ approve: z.boolean() });
export const RuleList = z.object({
  versions: z.array(
    z.object({
      id,
      version: z.number().int(),
      disclosedMetric: z.string(),
      mechanismSummary: z.string(),
      sortKeys: z.array(z.string()),
      alternativeSorts: z.array(z.string()),
      effectiveFrom: z.string(),
    }),
  ),
  proposals: z.array(
    z.object({
      id,
      status: z.enum(['proposed', 'approved', 'rejected']),
      disclosedMetric: z.string(),
      createdAt: z.string(),
    }),
  ),
});
export const RuleDecided = z.object({ versionId: id.nullable() });
export const RoutingCreated = z.object({ id });

// ---- signed callbacks from a lender's system ------------------------------------------------------
export const LenderEventInput = z.object({
  correlationRef: id,
  type: z.enum(['ack', 'check', 'decision', 'offer', 'offer_withdrawn']),
  body: z.record(z.string(), z.unknown()),
});
export const LenderEventResult = z.object({
  outcome: z.enum(['applied', 'duplicate', 'rejected', 'quarantined']),
  reason: z.string().optional(),
});
