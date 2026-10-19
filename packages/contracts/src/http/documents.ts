import { z } from 'zod';

/**
 * Wire contracts for Phase 07: lender KFS data, documents, acknowledgement, offer acceptance, signing and delivery.
 *
 * The lender's figures are carried exactly as supplied (integer paise, basis points, whole days). Nothing in this
 * file calculates, rounds or corrects them; the database checks structure and flags differences for the lender.
 */
const id = z.uuid();
const minor = z.number().int().min(0).max(100_000_000_000_000);
const bps = z.number().int().min(0).max(100_000);
const text = (max: number) => z.string().trim().min(1).max(max);

export const DOCUMENT_TYPES = [
  'kfs',
  'loan_agreement',
  'sanction_letter',
  'repayment_schedule',
  'terms_and_conditions',
  'privacy_and_data_use',
] as const;
export const KFS_ACK_SECTIONS = ['part1', 'apr_sheet', 'schedule', 'part2'] as const;
export const SIGNING_STATES = [
  'not_required',
  'awaiting_initiation',
  'ready_for_signing',
  'initiated',
  'awaiting_borrower',
  'executed',
  'failed',
  'expired',
  'cancelled',
  'requires_reconciliation',
] as const;
export const DELIVERY_STATUSES = [
  'requested',
  'available_in_app',
  'accepted_by_provider',
  'delivered',
  'failed',
  'not_configured',
] as const;

const Charge = z.strictObject({
  amountMinor: minor.optional(),
  percentBps: bps.optional(),
  text: text(500).optional(),
  notApplicable: z.literal(true).optional(),
});
export type Charge = z.infer<typeof Charge>;

/** kfs_data_v1: the facts of Annex I (RBC Directions 2025), the APR computation sheet and the amortisation schedule. */
export const KfsDataV1 = z.strictObject({
  schema: z.literal('kfs_data_v1'),
  proposalNo: z
    .string()
    .regex(/^[A-Za-z0-9._/-]{4,60}$/)
    .optional(),
  loanType: text(80),
  borrowerNameAsPerLender: text(120).optional(),
  sanctionedAmountMinor: minor.min(1),
  disbursal: z.strictObject({
    mode: z.enum(['upfront', 'staged']),
    stagedClauseRef: text(100).optional(),
  }),
  loanTerm: z.strictObject({
    value: z.number().int().min(1).max(10_000),
    unit: z.enum(['days', 'months', 'years']),
  }),
  tenureDays: z.number().int().min(1).max(10_950),
  instalments: z.strictObject({
    type: z.enum(['epi', 'non_equated']),
    frequency: z.enum(['monthly', 'fortnightly', 'weekly']),
    count: z.number().int().min(1).max(1200),
    amountMinor: minor.min(1).optional(),
    commencementDaysAfterSanction: z.number().int().min(0).max(3650),
    principalInstalments: z.number().int().min(0).max(1200).optional(),
    capitalisedInterestInstalments: z.number().int().min(0).max(1200).optional(),
  }),
  interest: z.strictObject({
    rateBps: z.number().int().min(0).max(10_000),
    type: z.enum(['fixed', 'floating', 'hybrid']),
  }),
  floating: z
    .strictObject({
      referenceBenchmark: text(80),
      benchmarkRateBps: z.number().int().min(0).max(100_000),
      spreadBps: z.number().int().min(0).max(100_000),
      finalRateBps: z.number().int().min(0).max(100_000),
      resetPeriodicityMonths: z.number().int().min(1).max(120),
      impactOf25bps: z.strictObject({
        epiOnBenchmarkMinor: minor,
        epiOnSpreadMinor: minor,
        epiCountOnBenchmark: z.number().int().min(0).max(1200),
        epiCountOnSpread: z.number().int().min(0).max(1200),
      }),
    })
    .optional(),
  fees: z.array(
    z.strictObject({
      category: z.enum(['processing', 'insurance', 'valuation', 'other']),
      label: text(120),
      payee: z.enum(['lender', 'third_party']),
      timing: z.enum(['one_time', 'recurring']),
      frequency: text(60).optional(),
      amountMinor: minor.optional(),
      percentBps: bps.optional(),
    }),
  ),
  noFees: z.literal(true).optional(),
  aprBps: z.number().int().min(0).max(20_000),
  contingent: z.strictObject({
    penalDelayed: Charge,
    otherPenal: Charge,
    foreclosure: Charge,
    switching: Charge,
    other: z.array(Charge).max(10).optional(),
  }),
  computation: z.strictObject({
    totalInterestMinor: minor,
    feesTotalMinor: minor,
    feesToLenderMinor: minor,
    feesToThirdPartyMinor: minor,
    netDisbursedMinor: minor.min(1),
    totalPayableMinor: minor.min(1),
    scheduleOfDisbursement: text(500),
    roundingNote: text(500).optional(),
  }),
  schedule: z
    .array(
      z.strictObject({
        no: z.number().int().min(1),
        dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        outstandingPrincipalMinor: minor,
        principalMinor: minor,
        interestMinor: minor,
        instalmentMinor: minor,
      }),
    )
    .min(1)
    .max(1200),
  part2: z.strictObject({
    recoveryAgentClauseRef: text(100),
    grievanceClauseRef: text(100),
    nodalOfficerPhone: z.string().regex(/^[0-9+() -]{5,20}$/),
    nodalOfficerEmail: z.string().min(3).max(250),
    transferOrSecuritisation: z.boolean(),
    collaborativeLending: z
      .strictObject({
        originatingRe: text(200),
        originatingFundingPercentBps: bps,
        partnerRe: text(200),
        partnerFundingPercentBps: bps,
        blendedRateBps: bps,
      })
      .optional(),
    digital: z.strictObject({
      coolingOffDays: z.number().int().min(1).max(365),
      coolingOffNote: text(500).optional(),
      lspRecoveryAgent: text(300).optional(),
    }),
  }),
});
export type KfsDataV1 = z.infer<typeof KfsDataV1>;

/** What a lender that issues its own KFS file declares so the evidence can be bound to the offer. */
export const KfsDeclaredV1 = z.strictObject({
  schema: z.literal('kfs_declared_v1'),
  proposalNo: z.string().regex(/^[A-Za-z0-9._/-]{4,60}$/),
  sanctionedAmountMinor: minor.min(1),
  tenureDays: z.number().int().min(1).max(10_950),
  aprBps: z.number().int().min(0).max(20_000),
  kfsValidFrom: z.iso.datetime({ offset: true }),
  kfsValidUntil: z.iso.datetime({ offset: true }),
});

// ---- What the worker renders from (produced by documents.begin_generation) ---------------------------------------------
export const RenderTemplateBody = z.object({
  engine: z.enum(['annex_i_v1', 'agreement_v1']),
  labels: z.record(z.string(), z.string()).optional(),
  labels2: z.record(z.string(), z.string()).optional(),
  title: z.string().optional(),
  status_note: z.string().optional(),
  sections: z.array(z.object({ heading: z.string(), text: z.string() })).optional(),
});
export type RenderTemplateBody = z.infer<typeof RenderTemplateBody>;

export const RenderModel = z.object({
  jobId: id,
  documentType: z.enum(['kfs', 'loan_agreement']),
  language: z.enum(['en', 'hi']),
  version: z.number().int().min(1),
  proposalNo: z.string(),
  offerId: id,
  applicationId: id,
  lender: z.object({ id, legalName: z.string(), displayName: z.string() }),
  udofinReference: z.string().nullable(),
  template: z.object({
    id,
    key: z.string(),
    version: z.number().int(),
    body: RenderTemplateBody,
  }),
  data: KfsDataV1,
  contentDigest: z.string().regex(/^[0-9a-f]{64}$/),
  offer: z.object({
    issuedAt: z.string(),
    validUntil: z.string(),
    revision: z.number().int(),
  }),
  validity: z
    .object({
      from: z.string(),
      until: z.string(),
      minWorkingDays: z.number().int(),
      issueDeadline: z.string(),
    })
    .nullable(),
  kfsDocument: z
    .object({
      id,
      sha256: z.string(),
      contentDigest: z.string(),
      proposalNo: z.string().optional(),
    })
    .nullable(),
  kfsTemplate: RenderTemplateBody.nullable().optional(),
});
export type RenderModel = z.infer<typeof RenderModel>;

export const GenerationBegun = z.union([
  RenderModel,
  z.object({ done: z.literal(true), documentId: id }),
  z.object({ failed: z.string() }),
]);

// ---- Lender routes ----------------------------------------------------------------------------------------------------
export const KfsDataSubmission = z.strictObject({
  mode: z.enum(['data', 'declared_for_upload']).default('data'),
  data: z.record(z.string(), z.unknown()),
});
export const KfsDataResult = z.object({
  inputId: id,
  packageVersion: z.number().int(),
  validation: z.enum(['accepted', 'held']),
  issues: z.array(z.string()),
});
export const GenerationRequest = z.strictObject({
  inputId: id,
  language: z.enum(['en', 'hi']).default('en'),
  documentType: z.enum(['kfs', 'loan_agreement']).default('kfs'),
});
export const GenerationResult = z.object({
  jobId: id,
  status: z.enum(['pending', 'running', 'succeeded', 'failed']),
  documentId: id.nullable(),
});
export const ReasonInput = z.strictObject({
  reason: z
    .string()
    .regex(/^[a-z_]{2,50}$/)
    .default('unspecified'),
});
export const ApproveInput = z.strictObject({ sha256: z.string().regex(/^[0-9a-f]{64}$/) });
export const IssueResult = z.object({
  documentId: id,
  issuedAt: z.string(),
  validUntil: z.string().nullable(),
});
export const DocumentDone = z.object({ ok: z.literal(true) });

export const LenderDocument = z.object({
  id,
  documentType: z.string(),
  version: z.number().int(),
  language: z.string(),
  applicationId: id,
  offerId: id,
  proposalNo: z.string().nullable(),
  sourceMode: z.enum(['generated', 'lender_uploaded']),
  approvalStatus: z.enum(['draft', 'lender_approved', 'rejected']),
  issuanceStatus: z.enum(['not_issued', 'issued', 'superseded', 'withdrawn', 'expired']),
  sha256: z.string(),
  generatedAt: z.string(),
  kfsValidUntil: z.string().nullable(),
  issuedAt: z.string().nullable(),
  supersedesId: id.nullable(),
});
export type LenderDocument = z.infer<typeof LenderDocument>;
export const LenderDocumentList = z.object({ items: z.array(LenderDocument) });
export const LenderKfsInput = z.object({
  id,
  offerId: id,
  packageVersion: z.number().int(),
  mode: z.string(),
  validation: z.string(),
  issues: z.array(z.string()),
  submittedAt: z.string(),
});
export const LenderKfsInputList = z.object({ items: z.array(LenderKfsInput) });

// ---- Platform routes ---------------------------------------------------------------------------------------------------
export const RuleProposal = z.strictObject({
  ruleKey: z.string().regex(/^[a-z0-9_.]{3,80}$/),
  lenderCategoryKeys: z.array(z.string().regex(/^[a-z_]{2,40}$/)).min(1),
  regulator: text(80),
  directionRef: text(300),
  paragraphRefs: z.array(text(40)).default([]),
  productCategoryKeys: z.array(z.string().regex(/^[a-z_]{2,40}$/)).min(1),
  exclusions: text(2000).optional(),
  documentType: z.enum(DOCUMENT_TYPES),
  requiredTemplateKey: z.string().regex(/^[a-z0-9_.]{3,80}$/),
  requiredFieldsVersion: z.string().regex(/^[a-z0-9_]{3,40}$/),
  requiredAcknowledgements: z.array(text(60)).default([]),
  ackSections: z.array(z.enum(KFS_ACK_SECTIONS)).default([]),
  validityRule: z.record(z.string(), z.unknown()).default({}),
  languagePolicy: z.record(z.string(), z.unknown()).default({}),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  effectiveTo: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  evidenceStatus: z
    .enum(['confirmed', 'likely', 'interpretation', 'unverified'])
    .default('unverified'),
});
export const RuleDecision = z.strictObject({
  approve: z.boolean(),
  /** The person or role that reviewed the rule. Supplied by the approver; never invented by the system. */
  reviewerRef: z.string().trim().max(100).optional(),
});
export const TemplateProposal = z.strictObject({
  templateKey: z.string().regex(/^[a-z0-9_.]{3,80}$/),
  documentType: z.enum(DOCUMENT_TYPES),
  language: z.enum(['en', 'hi']),
  lenderId: id.nullable(),
  body: RenderTemplateBody,
});
export const TemplateComplianceDecision = z.strictObject({
  reviewerRef: z.string().trim().min(2).max(100),
});
export const CalendarProposal = z.strictObject({
  lenderId: id,
  name: text(100),
  weeklyOff: z.array(z.number().int().min(0).max(6)).max(7),
  coveredFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  coveredTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  exceptions: z
    .array(
      z.strictObject({
        day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        isWorking: z.boolean(),
        reason: text(200).optional(),
      }),
    )
    .max(400)
    .default([]),
});
export const CalendarDecision = z.strictObject({
  approve: z.boolean(),
  lenderConfirmationRef: z.string().trim().max(200).optional(),
});
export const SelfApprovalInput = z.strictObject({ allowed: z.boolean() });

// ---- Borrower routes ---------------------------------------------------------------------------------------------------
export const ApplicationDocuments = z.object({
  applicationId: id,
  applicationStatus: z.string(),
  lenderName: z.string(),
  offer: z
    .object({
      offerId: id,
      revision: z.number().int(),
      status: z.string(),
      validUntil: z.string(),
      principalMinor: z.number().int(),
      tenureDays: z.number().int(),
      aprBps: z.number().int(),
      monthlyRepaymentMinor: z.number().int().nullable(),
      lenderOfferRef: z.string().nullable(),
    })
    .nullable(),
  kfs: z
    .object({
      documentId: id,
      version: z.number().int(),
      issuanceStatus: z.string(),
      proposalNo: z.string().nullable(),
      language: z.string(),
      sourceMode: z.string(),
      validFrom: z.string().nullable(),
      validUntil: z.string().nullable(),
      issuedAt: z.string().nullable(),
      sha256: z.string(),
      contentDigest: z.string().nullable(),
    })
    .nullable(),
  acknowledgement: z
    .object({ acknowledgementId: id, acknowledgedAt: z.string(), language: z.string() })
    .nullable(),
  acceptance: z
    .object({
      acceptedAt: z.string(),
      signatureStatus: z.literal('not_signed'),
      disbursementStatus: z.literal('not_started'),
    })
    .nullable(),
  agreement: z
    .object({
      documentId: id,
      version: z.number().int(),
      issuanceStatus: z.string(),
      issuedAt: z.string().nullable(),
    })
    .nullable(),
  signing: z
    .object({
      requestId: id,
      state: z.enum(SIGNING_STATES),
      providerMode: z.string(),
      updatedAt: z.string(),
    })
    .nullable(),
  documents: z.array(
    z.object({
      documentId: id,
      type: z.string(),
      version: z.number().int(),
      language: z.string(),
      issuanceStatus: z.string(),
      issuedAt: z.string().nullable(),
      validUntil: z.string().nullable(),
      supersededById: id.nullable(),
      proposalNo: z.string().nullable(),
      sha256: z.string(),
      acknowledged: z.boolean(),
      delivery: z.array(z.object({ channel: z.string(), status: z.enum(DELIVERY_STATUSES) })),
    }),
  ),
});
export type ApplicationDocuments = z.infer<typeof ApplicationDocuments>;

export const KfsView = z.object({
  documentId: id,
  version: z.number().int(),
  issuanceStatus: z.string(),
  proposalNo: z.string().nullable(),
  language: z.string(),
  sourceMode: z.string(),
  validFrom: z.string().nullable(),
  validUntil: z.string().nullable(),
  sha256: z.string(),
  lenderName: z.string(),
  /** Present for a generated KFS: the lender's own figures, unchanged. */
  data: KfsDataV1.nullable(),
  ackSections: z.array(z.string()),
  wording: z
    .object({
      noticeId: id,
      version: z.number().int(),
      language: z.string(),
      title: z.string(),
      body: z.string(),
      languageFallback: z.boolean(),
    })
    .nullable(),
  acknowledged: z.boolean(),
});
export type KfsView = z.infer<typeof KfsView>;

export const AcknowledgeInput = z.strictObject({
  noticeId: id,
  sections: z.array(z.enum(KFS_ACK_SECTIONS)).max(10),
  action: z.enum(['checkbox_and_button', 'button']),
  explanationVersion: z
    .string()
    .regex(/^[A-Za-z0-9._-]{1,40}$/)
    .default('v1'),
  channel: z.enum(['mobile_app', 'web']).default('mobile_app'),
  appVersion: z
    .string()
    .regex(/^[0-9A-Za-z.+-]{1,40}$/)
    .optional(),
});
export const AcknowledgeResult = z.object({
  acknowledgementId: id,
  acknowledgedAt: z.string(),
  replayed: z.boolean(),
});
export const AcceptInput = z.strictObject({ kfsDocumentId: id, acknowledgementId: id });
export const AcceptResult = z.object({
  acceptanceId: id,
  acceptedAt: z.string(),
  applicationStatus: z.string(),
  signatureStatus: z.literal('not_signed'),
  disbursementStatus: z.literal('not_started'),
  replayed: z.boolean(),
});
export const SigningStarted = z.object({
  requestId: id,
  state: z.enum(SIGNING_STATES),
  replayed: z.boolean(),
});
export const DeliveryInput = z.strictObject({ channel: z.enum(['sms_notice', 'email_notice']) });
export const DeliveryRequested = z.object({
  deliveryId: id,
  status: z.enum(DELIVERY_STATUSES),
  replayed: z.boolean().optional(),
});

// ---- Platform reads -----------------------------------------------------------------------------------------------------
export const ApplicabilityRuleView = z.object({
  id,
  ruleKey: z.string(),
  version: z.number().int(),
  lenderCategoryKeys: z.array(z.string()),
  regulator: z.string(),
  directionRef: z.string(),
  paragraphRefs: z.array(z.string()),
  productCategoryKeys: z.array(z.string()),
  exclusions: z.string().nullable(),
  documentType: z.string(),
  requiredTemplateKey: z.string(),
  approvalStatus: z.enum(['draft', 'in_review', 'approved', 'rejected', 'retired', 'unresolved']),
  evidenceStatus: z.enum(['confirmed', 'likely', 'interpretation', 'unverified']),
  reviewerRef: z.string().nullable(),
  effectiveFrom: z.string(),
  effectiveTo: z.string().nullable(),
});
export const ApplicabilityRuleList = z.object({ items: z.array(ApplicabilityRuleView) });
export const TemplateView = z.object({
  id,
  templateKey: z.string(),
  documentType: z.string(),
  language: z.string(),
  lenderId: id.nullable(),
  version: z.number().int(),
  status: z.enum(['draft', 'in_review', 'approved', 'retired']),
  isSample: z.boolean(),
  lenderApprovedAt: z.string().nullable(),
  complianceApprovedAt: z.string().nullable(),
  complianceReviewerRef: z.string().nullable(),
});
export const TemplateList = z.object({ items: z.array(TemplateView) });
export const CalendarView = z.object({
  id,
  lenderId: id,
  name: z.string(),
  weeklyOff: z.array(z.number().int()),
  coveredFrom: z.string(),
  coveredTo: z.string(),
  status: z.enum(['draft', 'approved', 'retired']),
  lenderConfirmationRef: z.string().nullable(),
});
export const CalendarList = z.object({ items: z.array(CalendarView) });
export const IssuedDocumentContent = z.object({
  documentId: id,
  documentType: z.string(),
  version: z.number().int(),
  mimeType: z.literal('application/pdf'),
  sha256: z.string(),
  contentBase64: z.string(),
});
export const KfsUploadInput = z.strictObject({
  inputId: id,
  contentBase64: z.string().min(8).max(11_200_000),
});
export const DocumentEvent = z.object({
  event: z.string(),
  actor: z.string(),
  occurredAt: z.string(),
});
export const DocumentEventList = z.object({ items: z.array(DocumentEvent) });
export const SigningStatusView = z.object({
  requestId: id,
  state: z.enum(SIGNING_STATES),
  providerMode: z.enum(['mock', 'sandbox', 'live']),
  updatedAt: z.string(),
  executedAt: z.string().nullable(),
  events: z.array(z.object({ toState: z.string(), occurredAt: z.string() })),
});
export const DeliveryList = z.object({
  items: z.array(
    z.object({
      deliveryId: id,
      channel: z.string(),
      status: z.enum(DELIVERY_STATUSES),
      failureClass: z.string().nullable(),
      requestedAt: z.string(),
      updatedAt: z.string(),
    }),
  ),
});
