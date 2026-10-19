import { z } from 'zod';

/**
 * Wire contracts for lender onboarding (Phase 04, addendum A). Enumerations here mirror the CHECK
 * constraints in supabase/migrations/…0740_onboarding_tables.sql; the database is the source of
 * truth and a test keeps them aligned.
 */

export const INSTITUTION_TYPES = [
  'nbfc',
  'housing_finance_company',
  'bank',
  'urban_co_operative_bank',
  'other_regulated_entity',
] as const;
export const REGIME_STATUSES = ['confirmed_primary', 'likely', 'unverified'] as const;
export const LICENCE_STATUSES = [
  'unknown',
  'active',
  'suspended',
  'cancelled',
  'expired',
  'surrendered',
] as const;
export const VERIFICATION_STATUSES = [
  'unverified',
  'submitted',
  'verified',
  'rejected',
  'expired',
] as const;

export const ACCOUNTING_FRAMEWORKS = [
  'ind_as',
  'companies_as_rules_or_other_corporate',
  'banking_sector_framework',
  'other',
  'to_be_confirmed',
] as const;
export const IND_AS_APPLICABILITY = [
  'applicable',
  'not_applicable',
  'under_assessment',
  'to_be_confirmed',
] as const;
export const IND_AS_IMPLEMENTATION = [
  'implemented',
  'in_progress',
  'not_implemented',
  'not_applicable',
  'to_be_confirmed',
] as const;
export const APPLICABILITY_BASES = [
  'statutory_requirement',
  'entity_criteria',
  'group_relationship',
  'professional_assessment',
  'other',
  'to_be_confirmed',
] as const;
export const STATEMENT_SCOPES = [
  'standalone',
  'consolidated',
  'both',
  'not_applicable',
  'to_be_confirmed',
] as const;
export const LISTED_STATUSES = ['listed', 'unlisted', 'to_be_confirmed'] as const;
export const CONFIRMATION_SOURCES = [
  'audited_financial_statements',
  'auditor_confirmation',
  'management_declaration',
  'regulatory_reference',
  'other',
  'to_be_confirmed',
] as const;
export const ACCOUNTING_STATUSES = [
  'draft',
  'submitted',
  'verified',
  'rejected',
  'superseded',
] as const;

export const SERVICE_STATUSES = [
  'proposed',
  'under_discussion',
  'agreed',
  'active',
  'suspended',
  'terminated',
  'superseded',
] as const;
export const RESPONSIBLE_PARTIES = ['lender', 'udofin', 'shared', 'third_party'] as const;
export const ACCOUNTABLE_PARTIES = ['lender', 'udofin', 'third_party'] as const;
export const SYSTEMS_OF_RECORD = [
  'lender_system',
  'udofin',
  'third_party',
  'to_be_confirmed',
] as const;

export const REQUIREMENT_STATUSES = [
  'not_requested',
  'requested',
  'in_progress',
  'submitted',
  'under_review',
  'accepted',
  'rejected',
  'expired',
  'waived',
  'not_applicable',
] as const;
export const INTEGRATION_KINDS = ['rest_api', 'file_transfer', 'manual_process', 'other'] as const;
export const INTEGRATION_STATUSES = [
  'planned',
  'in_progress',
  'tested',
  'failed',
  'manual_exception',
] as const;
export const CONTRACT_TYPES = [
  'master_services_agreement',
  'lsp_agreement',
  'dlg_agreement',
  'data_processing_agreement',
  'sla',
  'commercial_terms',
  'amendment',
  'other',
] as const;
export const CONTRACT_STATUSES = ['draft', 'executed', 'expired', 'terminated'] as const;
export const DOCUMENT_PURPOSES = [
  'licence',
  'registration',
  'accounting_evidence',
  'contract',
  'requirement_evidence',
  'integration_evidence',
  'verification_evidence',
  'other',
] as const;
export const DOCUMENT_MIME_TYPES = ['application/pdf', 'image/png', 'image/jpeg'] as const;

/** The activation sequence, in order. Side states follow. */
export const GATE_SEQUENCE = [
  'profile_created',
  'institution_verified',
  'approved_for_onboarding',
  'contract_onboarded',
  'service_scope_agreed',
  'product_config_completed',
  'product_config_approved',
  'integration_tested',
  'production_ready_approved',
  'activated',
] as const;
export const GATE_STAGES = [...GATE_SEQUENCE, 'suspended', 'deactivated', 'terminated'] as const;
export const GATE_REQUEST_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const timestamp = z.string();
const fy = z.string().regex(/^20\d{2}-\d{2}$/);
const text = (max: number) => z.string().trim().min(1).max(max);

export const InstitutionCategory = z.object({
  key: z.string(),
  label: z.string(),
  institutionType: z.enum(INSTITUTION_TYPES),
  regulator: z.string(),
  regimeStatus: z.enum(REGIME_STATUSES),
  regimeNote: z.string(),
  activationAllowed: z.boolean(),
  signoffSourceRef: z.string().nullable(),
  signoffAt: timestamp.nullable(),
});
export type InstitutionCategory = z.infer<typeof InstitutionCategory>;
export const InstitutionCategoryList = z.object({ items: z.array(InstitutionCategory) });

export const ServiceCategory = z.object({
  key: z.string(),
  label: z.string(),
  description: z.string(),
  active: z.boolean(),
});
export type ServiceCategory = z.infer<typeof ServiceCategory>;
export const ServiceCategoryList = z.object({ items: z.array(ServiceCategory) });

export const LenderProfile = z.object({
  lenderOrgId: z.uuid(),
  categoryKey: z.string(),
  regulator: z.string(),
  registrationNo: z.string().nullable(),
  cin: z.string().nullable(),
  licenceType: z.string().nullable(),
  licenceIssuedOn: day.nullable(),
  licenceValidUntil: day.nullable(),
  licenceStatus: z.enum(LICENCE_STATUSES),
  notes: z.string().nullable(),
  verificationStatus: z.enum(VERIFICATION_STATUSES),
  verificationEvidenceId: z.uuid().nullable(),
  verifiedAt: timestamp.nullable(),
  lastVerifiedOn: day.nullable(),
  reverifyBy: day.nullable(),
  verificationNote: z.string().nullable(),
  updatedAt: timestamp,
});
export type LenderProfile = z.infer<typeof LenderProfile>;

export const GateState = z.object({
  lenderOrgId: z.uuid(),
  stage: z.enum(GATE_STAGES),
  stageChangedAt: timestamp,
});
export type GateState = z.infer<typeof GateState>;

export const LenderSummary = z.object({
  lenderOrgId: z.uuid(),
  legalName: z.string(),
  displayName: z.string(),
  organizationStatus: z.string(),
  categoryKey: z.string().nullable(),
  categoryLabel: z.string().nullable(),
  stage: z.enum(GATE_STAGES).nullable(),
  verificationStatus: z.enum(VERIFICATION_STATUSES).nullable(),
  accountingStatus: z.enum(ACCOUNTING_STATUSES).nullable(),
});
export type LenderSummary = z.infer<typeof LenderSummary>;
export const LenderSummaryList = z.object({ items: z.array(LenderSummary) });

export const LenderOverview = z.object({
  summary: LenderSummary,
  profile: LenderProfile.nullable(),
  gate: GateState.nullable(),
  /** Whether compliance has signed off the lender's category for activation. */
  categoryActivationAllowed: z.boolean().nullable(),
});
export type LenderOverview = z.infer<typeof LenderOverview>;

export const AccountingProfile = z.object({
  id: z.uuid(),
  lenderOrgId: z.uuid(),
  versionNo: z.number().int(),
  status: z.enum(ACCOUNTING_STATUSES),
  accountingFramework: z.enum(ACCOUNTING_FRAMEWORKS),
  indAsApplicability: z.enum(IND_AS_APPLICABILITY),
  indAsImplementationStatus: z.enum(IND_AS_IMPLEMENTATION),
  applicabilityBasis: z.enum(APPLICABILITY_BASES),
  applicabilityBasisNote: z.string().nullable(),
  effectiveFy: fy.nullable(),
  effectiveDate: day.nullable(),
  statementScope: z.enum(STATEMENT_SCOPES),
  listedStatus: z.enum(LISTED_STATUSES),
  groupRelationships: z.string().nullable(),
  /** Integer paise, serialised as a decimal string so no precision is lost. */
  netWorthPaise: z.string().nullable(),
  netWorthMeasuredOn: day.nullable(),
  netWorthFy: fy.nullable(),
  confirmationSource: z.enum(CONFIRMATION_SOURCES),
  evidenceDocumentId: z.uuid().nullable(),
  notes: z.string().nullable(),
  nextReviewOn: day.nullable(),
  submittedAt: timestamp.nullable(),
  reviewedAt: timestamp.nullable(),
  reviewNote: z.string().nullable(),
  lastVerifiedOn: day.nullable(),
  createdAt: timestamp,
});
export type AccountingProfile = z.infer<typeof AccountingProfile>;
export const AccountingProfileList = z.object({ items: z.array(AccountingProfile) });

export const AccountingDraftInput = z.strictObject({
  accountingFramework: z.enum(ACCOUNTING_FRAMEWORKS).optional(),
  indAsApplicability: z.enum(IND_AS_APPLICABILITY).optional(),
  indAsImplementationStatus: z.enum(IND_AS_IMPLEMENTATION).optional(),
  applicabilityBasis: z.enum(APPLICABILITY_BASES).optional(),
  applicabilityBasisNote: text(2000).nullable().optional(),
  effectiveFy: fy.nullable().optional(),
  effectiveDate: day.nullable().optional(),
  statementScope: z.enum(STATEMENT_SCOPES).optional(),
  listedStatus: z.enum(LISTED_STATUSES).optional(),
  groupRelationships: text(2000).nullable().optional(),
  netWorthPaise: z
    .string()
    .regex(/^\d{1,18}$/)
    .nullable()
    .optional(),
  netWorthMeasuredOn: day.nullable().optional(),
  netWorthFy: fy.nullable().optional(),
  confirmationSource: z.enum(CONFIRMATION_SOURCES).optional(),
  evidenceDocumentId: z.uuid().nullable().optional(),
  notes: text(4000).nullable().optional(),
  nextReviewOn: day.nullable().optional(),
});
export type AccountingDraftInput = z.infer<typeof AccountingDraftInput>;

export const ServiceVersion = z.object({
  id: z.uuid(),
  serviceId: z.uuid(),
  versionNo: z.number().int(),
  status: z.enum(SERVICE_STATUSES),
  requestedScope: z.string().nullable(),
  proposedScope: z.string().nullable(),
  agreedScope: z.string().nullable(),
  responsibleParty: z.enum(RESPONSIBLE_PARTIES),
  accountableParty: z.enum(ACCOUNTABLE_PARTIES),
  supportingParties: z.array(z.string()),
  sharedAllocation: z.string().nullable(),
  prerequisites: z.string().nullable(),
  dataExchanged: z.string().nullable(),
  permittedPurpose: z.string().nullable(),
  systemOfRecord: z.enum(SYSTEMS_OF_RECORD),
  integrationRequirements: z.string().nullable(),
  slaSummary: z.string().nullable(),
  escalationPath: z.string().nullable(),
  contractReference: z.string().nullable(),
  effectiveFrom: day.nullable(),
  reviewOn: day.nullable(),
  statusNote: z.string().nullable(),
  lenderAgreedAt: timestamp.nullable(),
  udofinAgreedAt: timestamp.nullable(),
  activatedAt: timestamp.nullable(),
  createdAt: timestamp,
});
export type ServiceVersion = z.infer<typeof ServiceVersion>;

export const LenderService = z.object({
  id: z.uuid(),
  lenderOrgId: z.uuid(),
  categoryKey: z.string(),
  title: z.string(),
  createdAt: timestamp,
  versions: z.array(ServiceVersion),
});
export type LenderService = z.infer<typeof LenderService>;
export const LenderServiceList = z.object({ items: z.array(LenderService) });

const serviceFields = {
  requestedScope: text(4000).optional(),
  proposedScope: text(4000).optional(),
  agreedScope: text(4000).optional(),
  responsibleParty: z.enum(RESPONSIBLE_PARTIES).optional(),
  accountableParty: z.enum(ACCOUNTABLE_PARTIES).optional(),
  supportingParties: z.array(z.enum(ACCOUNTABLE_PARTIES)).max(3).optional(),
  sharedAllocation: text(4000).optional(),
  prerequisites: text(4000).optional(),
  dataExchanged: text(4000).optional(),
  permittedPurpose: text(2000).optional(),
  systemOfRecord: z.enum(SYSTEMS_OF_RECORD).optional(),
  integrationRequirements: text(4000).optional(),
  slaSummary: text(2000).optional(),
  escalationPath: text(2000).optional(),
  contractReference: text(120).optional(),
  effectiveFrom: day.optional(),
  reviewOn: day.optional(),
};
export const ServiceCreateInput = z.strictObject({
  categoryKey: z.string().regex(/^[a-z][a-z0-9_]{1,50}$/),
  title: text(160),
  ...serviceFields,
});
export type ServiceCreateInput = z.infer<typeof ServiceCreateInput>;
export const ServiceReviseInput = z.strictObject(serviceFields);
export type ServiceReviseInput = z.infer<typeof ServiceReviseInput>;

export const Requirement = z.object({
  id: z.uuid(),
  lenderOrgId: z.uuid(),
  templateKey: z.string().nullable(),
  title: z.string(),
  description: z.string().nullable(),
  serviceId: z.uuid().nullable(),
  productId: z.uuid().nullable(),
  integrationId: z.uuid().nullable(),
  mandatory: z.boolean(),
  evidenceRequired: z.boolean(),
  status: z.enum(REQUIREMENT_STATUSES),
  requestedOn: day.nullable(),
  dueOn: day.nullable(),
  receivedOn: day.nullable(),
  evidenceDocumentId: z.uuid().nullable(),
  reviewedAt: timestamp.nullable(),
  comments: z.string().nullable(),
  dependsOn: z.array(z.uuid()),
});
export type Requirement = z.infer<typeof Requirement>;
export const RequirementList = z.object({ items: z.array(Requirement) });

export const Integration = z.object({
  id: z.uuid(),
  lenderOrgId: z.uuid(),
  serviceId: z.uuid().nullable(),
  kind: z.enum(INTEGRATION_KINDS),
  name: z.string(),
  purpose: z.string().nullable(),
  status: z.enum(INTEGRATION_STATUSES),
  testedOn: day.nullable(),
  manualExceptionReason: z.string().nullable(),
  exceptionApproved: z.boolean(),
  notes: z.string().nullable(),
  createdAt: timestamp,
});
export type Integration = z.infer<typeof Integration>;
export const IntegrationList = z.object({ items: z.array(Integration) });

export const Contract = z.object({
  id: z.uuid(),
  lenderOrgId: z.uuid(),
  contractType: z.enum(CONTRACT_TYPES),
  reference: z.string(),
  executedOn: day.nullable(),
  effectiveFrom: day.nullable(),
  effectiveUntil: day.nullable(),
  documentId: z.uuid().nullable(),
  status: z.enum(CONTRACT_STATUSES),
  verified: z.boolean(),
  verifiedAt: timestamp.nullable(),
  note: z.string().nullable(),
  createdAt: timestamp,
});
export type Contract = z.infer<typeof Contract>;
export const ContractList = z.object({ items: z.array(Contract) });

export const DocumentRecord = z.object({
  id: z.uuid(),
  lenderOrgId: z.uuid(),
  purpose: z.enum(DOCUMENT_PURPOSES),
  label: z.string(),
  mimeType: z.enum(DOCUMENT_MIME_TYPES),
  sizeBytes: z.number().int(),
  sha256: z.string(),
  scanStatus: z.enum(['not_scanned', 'clean', 'infected']),
  uploadedAt: timestamp,
});
export type DocumentRecord = z.infer<typeof DocumentRecord>;
export const DocumentList = z.object({ items: z.array(DocumentRecord) });

export const DocumentUploadInput = z.strictObject({
  purpose: z.enum(DOCUMENT_PURPOSES),
  label: text(120),
  mimeType: z.enum(DOCUMENT_MIME_TYPES),
  /** Base64 of the file. Interim transfer format (see docs/api/onboarding.md): at most 8 MiB decoded. */
  contentBase64: z.string().min(8).max(11_200_000),
});
export type DocumentUploadInput = z.infer<typeof DocumentUploadInput>;
export const DocumentContent = z.object({
  id: z.uuid(),
  label: z.string(),
  mimeType: z.enum(DOCUMENT_MIME_TYPES),
  sha256: z.string(),
  contentBase64: z.string(),
});

export const GateCondition = z.object({
  key: z.string(),
  satisfied: z.boolean(),
  detail: z.string(),
});
export type GateCondition = z.infer<typeof GateCondition>;
export const GateConditions = z.object({
  lenderOrgId: z.uuid(),
  currentStage: z.enum(GATE_STAGES),
  targetStage: z.string(),
  items: z.array(GateCondition),
});
export type GateConditions = z.infer<typeof GateConditions>;

export const GateRequest = z.object({
  id: z.uuid(),
  lenderOrgId: z.uuid(),
  fromStage: z.string(),
  targetStage: z.string(),
  status: z.enum(GATE_REQUEST_STATUSES),
  requestedBy: z.uuid(),
  requestedAt: timestamp,
  requestNote: z.string().nullable(),
  decidedBy: z.uuid().nullable(),
  decidedAt: timestamp.nullable(),
  decisionNote: z.string().nullable(),
});
export type GateRequest = z.infer<typeof GateRequest>;
export const GateRequestList = z.object({ items: z.array(GateRequest) });

export const VerificationHistoryEntry = z.object({
  id: z.uuid(),
  subject: z.enum(['institution', 'accounting']),
  subjectRef: z.uuid().nullable(),
  status: z.string(),
  evidenceDocumentId: z.uuid().nullable(),
  actorId: z.uuid().nullable(),
  note: z.string().nullable(),
  recordedAt: timestamp,
});
export const VerificationHistory = z.object({ items: z.array(VerificationHistoryEntry) });

export const Created = z.object({ id: z.uuid() });
export const Done = z.object({ ok: z.literal(true) });
export const StageResult = z.object({ stage: z.enum(GATE_STAGES) });
