// Phase 08a wire contracts: payment providers, the account registry, merchants, payment configurations and feature switches.
// Platform operations live under /v1/platform/, lender administration under /v1/lender/. Every rule is in the database; these
// schemas only describe the SHAPE of requests and responses. No schema here carries an account fingerprint, an endpoint token
// hash or a secret value: the registry answers with the masked reference only, and a configuration holds NAMES of secrets.
import { z } from 'zod';
import { DateOnly, Paise, Timestamp } from '../primitives.js';

// ---- shared building blocks ----------------------------------------------------------------------------------------

/** The provider key as the register spells it. */
export const AccountsProviderKey = z.string().regex(/^[a-z][a-z0-9_]{2,49}$/);

/**
 * Free text written by a person: refused when it holds a run of nine or more digits (an account, phone or identity number) or
 * a PAN-shaped token, so a reason or a note cannot become a second copy of a personal number. The database stays the authority
 * on length and wording; this is the shape check.
 */
const looksPersonal = (text: string): boolean =>
  /[0-9]{9,}/.test(text.replace(/[\s-]/g, '')) || /\b[A-Z]{5}[0-9]{4}[A-Z]\b/.test(text);

/**
 * A plain reference label (a document title, an evidence tag): no file contents, no account details. The pattern mirrors the
 * database check; the digit-run rule is added here so a label cannot carry a number either.
 */
export const AccountsEvidenceLabel = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9 ._:/#,()-]{2,199}$/)
  .refine((text) => !looksPersonal(text), { message: 'unsafe_free_text' });
export const AccountsReason = z
  .string()
  .trim()
  .min(10)
  .max(1000)
  .refine((text) => !looksPersonal(text), { message: 'unsafe_free_text' });
export const AccountsNote = z
  .string()
  .trim()
  .min(1)
  .max(1000)
  .refine((text) => !looksPersonal(text), { message: 'unsafe_free_text' });

/** `{ id, status }` after a state change: the status is the one the database function returned. */
export const AccountsActionResult = z.object({
  id: z.uuid(),
  status: z.string().regex(/^[a-z_]{2,40}$/),
});
export type AccountsActionResult = z.infer<typeof AccountsActionResult>;

const pageOf = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().max(300).nullable() });

const PageFields = {
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(300).optional(),
};

// ---- payment providers and return codes (platform) ----------------------------------------------------------------

export const PaymentProviderKind = z.enum(['payment', 'mandate', 'payment_and_mandate']);
export const PaymentProviderStatus = z.enum(['draft', 'approved', 'suspended']);
export const AccountsEvidenceStatus = z.enum(['unverified', 'likely', 'confirmed']);

export const PaymentProviderInput = z.strictObject({
  provider: AccountsProviderKey,
  displayName: z.string().trim().min(2).max(120),
  kind: PaymentProviderKind,
  status: PaymentProviderStatus,
  authorisationEvidenceRef: AccountsEvidenceLabel.nullable().default(null),
  evidenceLabel: AccountsEvidenceStatus,
  reason: AccountsReason.optional(),
});
export type PaymentProviderInput = z.infer<typeof PaymentProviderInput>;

export const PaymentProviderEntry = z.object({
  provider: z.string(),
  displayName: z.string(),
  kind: PaymentProviderKind,
  status: PaymentProviderStatus,
  authorisationEvidenceRef: z.string().nullable(),
  evidenceLabel: AccountsEvidenceStatus,
  statusReason: z.string().nullable(),
  updatedAt: Timestamp,
});
export type PaymentProviderEntry = z.infer<typeof PaymentProviderEntry>;
export const PaymentProviderList = z.object({ items: z.array(PaymentProviderEntry) });

/** What a lender needs to choose a provider when drafting a configuration: no evidence reference, no reason. */
export const PaymentProviderChoice = z.object({
  provider: z.string(),
  displayName: z.string(),
  kind: PaymentProviderKind,
  status: PaymentProviderStatus,
});
export const PaymentProviderChoiceList = z.object({ items: z.array(PaymentProviderChoice) });

export const PaymentProviderSet = z.object({ provider: z.string(), status: PaymentProviderStatus });

export const ReturnCodeClass = z.enum([
  'insufficient_funds',
  'account_issue',
  'mandate_issue',
  'technical',
  'other',
]);
export const ReturnCodeClassInput = z.strictObject({
  provider: AccountsProviderKey,
  code: z.string().regex(/^[A-Za-z0-9._:-]{1,40}$/),
  class: ReturnCodeClass,
  evidenceRef: AccountsEvidenceLabel,
});
export type ReturnCodeClassInput = z.infer<typeof ReturnCodeClassInput>;
export const ReturnCodeClassSet = z.object({
  provider: z.string(),
  code: z.string(),
  class: ReturnCodeClass,
  status: z.literal('set'),
});
export const ReturnCodeClassEntry = z.object({
  id: z.uuid(),
  provider: z.string(),
  code: z.string(),
  class: ReturnCodeClass,
  evidenceRef: z.string(),
  status: z.enum(['active', 'retired']),
  setBy: z.uuid(),
  setAt: Timestamp,
});
export const ReturnCodeClassQuery = z.strictObject({
  provider: AccountsProviderKey.optional(),
  status: z.enum(['active', 'retired']).default('active'),
});
export const ReturnCodeClassList = z.object({ items: z.array(ReturnCodeClassEntry) });

// ---- account format rules and fingerprint key versions (platform) -------------------------------------------------

export const AccountFormatRuleStatus = z.enum(['draft', 'approved', 'retired']);

export const AccountFormatRuleDraftInput = z.strictObject({
  country: z.string().regex(/^[A-Z]{2}$/),
  accountType: z.string().regex(/^[a-z][a-z0-9_]{2,40}$/),
  minDigits: z.number().int().min(1).max(40),
  maxDigits: z.number().int().min(1).max(40),
  ifscRequired: z.boolean(),
  evidenceLabel: AccountsEvidenceStatus,
  sourceNote: z
    .string()
    .trim()
    .min(10)
    .max(500)
    .refine((text) => !looksPersonal(text), { message: 'unsafe_free_text' }),
  effectiveFrom: DateOnly.optional(),
  effectiveTo: DateOnly.optional(),
});
export type AccountFormatRuleDraftInput = z.infer<typeof AccountFormatRuleDraftInput>;

export const AccountFormatRuleEntry = z.object({
  id: z.uuid(),
  country: z.string(),
  accountType: z.string(),
  version: z.number().int(),
  minDigits: z.number().int(),
  maxDigits: z.number().int(),
  ifscRequired: z.boolean(),
  status: AccountFormatRuleStatus,
  evidenceLabel: AccountsEvidenceStatus,
  sourceNote: z.string(),
  effectiveFrom: DateOnly,
  effectiveTo: DateOnly.nullable(),
  draftedBy: z.uuid().nullable(),
  submittedBy: z.uuid().nullable(),
  approvedBy: z.uuid().nullable(),
  approvedAt: Timestamp.nullable(),
  retiredAt: Timestamp.nullable(),
  retiredReason: z.string().nullable(),
  createdAt: Timestamp,
});
export type AccountFormatRuleEntry = z.infer<typeof AccountFormatRuleEntry>;
export const AccountFormatRuleQuery = z.strictObject({
  status: AccountFormatRuleStatus.optional(),
  country: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .optional(),
  accountType: z
    .string()
    .regex(/^[a-z][a-z0-9_]{2,40}$/)
    .optional(),
});
export const AccountFormatRuleList = z.object({ items: z.array(AccountFormatRuleEntry) });
export const AccountFormatRuleCreated = z.object({ id: z.uuid(), status: z.literal('draft') });
export const AccountFormatRuleApproveInput = z.strictObject({ note: AccountsNote.optional() });
export const AccountsReasonInput = z.strictObject({ reason: AccountsReason });
export type AccountsReasonInput = z.infer<typeof AccountsReasonInput>;

export const FingerprintKeyVersionStatus = z.enum(['proposed', 'active', 'retired']);
export const FingerprintKeyVersionProposalInput = z.strictObject({
  version: z.number().int().min(1).max(1000),
  note: AccountsNote.optional(),
});
export const FingerprintKeyVersionApproveInput = z.strictObject({ note: AccountsNote.optional() });
export const FingerprintKeyVersionEntry = z.object({
  keyVersion: z.number().int(),
  status: FingerprintKeyVersionStatus,
  proposedBy: z.uuid(),
  proposedAt: Timestamp,
  approvedBy: z.uuid().nullable(),
  approvedAt: Timestamp.nullable(),
  retiredAt: Timestamp.nullable(),
  note: z.string().nullable(),
});
export const FingerprintKeyVersionList = z.object({ items: z.array(FingerprintKeyVersionEntry) });
export const FingerprintKeyVersionResult = z.object({
  keyVersion: z.number().int(),
  status: FingerprintKeyVersionStatus,
});

// ---- the account registry (platform) -------------------------------------------------------------------------------

export const AccountOwnerKind = z.enum(['lender', 'udofin', 'group_company', 'other']);
export const AccountPurpose = z.enum([
  'repayment_settlement',
  'fee_collection',
  'disbursement_source',
  'operational',
]);
export const RegistryVerificationStatus = z.enum(['unverified', 'verified', 'rejected', 'revoked']);

/**
 * The only request that carries an account number. The number and the IFSC are used once, in memory, to compute a keyed
 * fingerprint and the masked reference, and are then dropped: they are never stored, logged, echoed, put in an error, an audit
 * event or a database column. The length range comes from the approved format rule, not from this schema.
 */
export const RegistryAccountRegisterInput = z.strictObject({
  accountNumber: z.string().regex(/^[0-9]{1,34}$/),
  ifsc: z.string().regex(/^[A-Za-z]{4}0[A-Za-z0-9]{6}$/),
  country: z.string().regex(/^[A-Z]{2}$/),
  accountType: z.string().regex(/^[a-z][a-z0-9_]{2,40}$/),
  ownerKind: AccountOwnerKind,
  /** Required exactly when the owner is a lender. */
  ownerOrgId: z.uuid().optional(),
  /** A legal entity, never an individual. */
  legalOwnerName: z
    .string()
    .trim()
    .min(3)
    .max(200)
    .refine((text) => !looksPersonal(text), { message: 'unsafe_free_text' }),
  permittedPurposes: z.array(AccountPurpose).min(1).max(4),
  effectiveFrom: DateOnly.optional(),
  effectiveTo: DateOnly.optional(),
  /** Rotation only: the entry under the active key version that this registration re-keys under the proposed version. */
  rekeysRegistryId: z.uuid().optional(),
});
export type RegistryAccountRegisterInput = z.infer<typeof RegistryAccountRegisterInput>;

/** The whole answer to a registration: the registry id, the masked reference and the status. Nothing else. */
export const RegistryAccountRegistered = z.object({
  id: z.uuid(),
  maskedRef: z.string().regex(/^[X*]{2,}[0-9]{4}$/),
  status: RegistryVerificationStatus,
});
export type RegistryAccountRegistered = z.infer<typeof RegistryAccountRegistered>;

export const RegistryAccountEntry = z.object({
  id: z.uuid(),
  maskedRef: z.string(),
  keyVersion: z.number().int(),
  rekeyedFromId: z.uuid().nullable(),
  country: z.string(),
  accountType: z.string(),
  formatRuleId: z.uuid(),
  ownerKind: AccountOwnerKind,
  ownerOrgId: z.uuid().nullable(),
  legalOwnerName: z.string(),
  permittedPurposes: z.array(AccountPurpose),
  verificationStatus: RegistryVerificationStatus,
  evidenceRef: z.string().nullable(),
  effectiveFrom: DateOnly,
  effectiveTo: DateOnly.nullable(),
  registeredBy: z.uuid(),
  registeredAt: Timestamp,
  verifiedBy: z.uuid().nullable(),
  verifiedAt: Timestamp.nullable(),
  rejectedAt: Timestamp.nullable(),
  rejectionReason: z.string().nullable(),
  revokedAt: Timestamp.nullable(),
  revokedReason: z.string().nullable(),
});
export type RegistryAccountEntry = z.infer<typeof RegistryAccountEntry>;
export const RegistryAccountQuery = z.strictObject({
  ...PageFields,
  status: RegistryVerificationStatus.optional(),
  ownerOrgId: z.uuid().optional(),
});
export const RegistryAccountPage = pageOf(RegistryAccountEntry);
export const RegistryAccountVerifyInput = z.strictObject({
  evidenceRef: AccountsEvidenceLabel,
  note: AccountsNote.optional(),
});

export const SettlementAccountLinkInput = z.strictObject({ registryId: z.uuid() });
export const SettlementAccountForLinking = z.object({
  id: z.uuid(),
  lenderId: z.uuid(),
  label: z.string(),
  bankName: z.string().nullable(),
  maskedRef: z.string(),
  status: z.string(),
  registryId: z.uuid().nullable(),
  createdAt: Timestamp,
});
export const SettlementAccountQuery = z.strictObject({
  ...PageFields,
  lenderId: z.uuid().optional(),
  linked: z.enum(['true', 'false']).optional(),
});
export const SettlementAccountPage = pageOf(SettlementAccountForLinking);

// ---- merchants ----------------------------------------------------------------------------------------------------

export const MerchantClaimInput = z.strictObject({
  lenderId: z.uuid(),
  provider: AccountsProviderKey,
  merchantRef: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{2,99}$/),
});
export const MerchantClaimed = z.object({ id: z.uuid(), status: z.literal('active') });
export const MerchantEntry = z.object({
  id: z.uuid(),
  provider: z.string(),
  merchantRef: z.string(),
  ownerKind: z.enum(['lender', 'udofin_fees']),
  ownerOrgId: z.uuid().nullable(),
  purpose: z.string(),
  status: z.enum(['active', 'revoked']),
  verificationStatus: z.enum(['unverified', 'verified']),
  verificationEvidenceRef: z.string().nullable(),
  claimedAt: Timestamp,
  verifiedAt: Timestamp.nullable(),
  revokedAt: Timestamp.nullable(),
  revokedReason: z.string().nullable(),
});
export type MerchantEntry = z.infer<typeof MerchantEntry>;
export const MerchantQuery = z.strictObject({
  ...PageFields,
  lenderId: z.uuid().optional(),
  verification: z.enum(['unverified', 'verified']).optional(),
  status: z.enum(['active', 'revoked']).optional(),
});
export const MerchantPage = pageOf(MerchantEntry);
export const MerchantVerifyInput = z.strictObject({ evidenceRef: AccountsEvidenceLabel });
export const UdofinFeeMerchantInput = z.strictObject({
  provider: AccountsProviderKey,
  merchantRef: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{2,99}$/),
});
export const MerchantRegistered = z.object({ id: z.uuid(), status: z.literal('active') });

// ---- payment configurations ---------------------------------------------------------------------------------------

export const PaymentConfigMode = z.enum(['mock', 'sandbox', 'production']);
export const PaymentConfigStatus = z.enum([
  'draft',
  'pending_approval',
  'active',
  'suspended',
  'retired',
]);

/** Rail limits copied from the provider's documentation: rail -> limit name -> a short string, a flag or an integer (paise for amounts). */
export const PaymentConfigRailLimits = z
  .record(
    z.string().regex(/^[a-z][a-z0-9_]{1,40}$/),
    z
      .record(
        z.string().regex(/^[a-z][a-z0-9_]{1,40}$/),
        z.union([z.string().min(1).max(100), z.boolean(), Paise]),
      )
      .refine((leaf) => Object.keys(leaf).length <= 20, { message: 'too_many_limits' }),
  )
  .refine((rails) => Object.keys(rails).length <= 10, { message: 'too_many_rails' });

/** NAMES of secrets held in the secrets manager, never the values. */
export const PaymentConfigSecretName = z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/);

export const PaymentConfigDraftInput = z.strictObject({
  lenderId: z.uuid(),
  provider: AccountsProviderKey,
  providerMode: PaymentConfigMode,
  merchantRegistryId: z.uuid(),
  settlementAccountId: z.uuid(),
  secretRef: PaymentConfigSecretName,
  webhookSecretRef: PaymentConfigSecretName,
  railLimits: PaymentConfigRailLimits.default({}),
  railLimitsSource: z
    .string()
    .trim()
    .min(10)
    .max(500)
    .refine((text) => !looksPersonal(text), { message: 'unsafe_free_text' })
    .optional(),
  evidenceRef: AccountsEvidenceLabel.optional(),
  contractSectionRef: AccountsEvidenceLabel.optional(),
});
export type PaymentConfigDraftInput = z.infer<typeof PaymentConfigDraftInput>;

/**
 * The answer to a draft. `endpointToken` is the opaque callback-routing token: it is generated by the API, only its SHA-256 is
 * stored, and it is shown here and nowhere else. The lender configures `callbackPath` at the provider. Treat both as secrets.
 */
export const PaymentConfigDrafted = z.object({
  id: z.uuid(),
  status: z.literal('draft'),
  endpointToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  callbackPath: z.string().regex(/^\/v1\/hooks\/provider\/[A-Za-z0-9_-]{43}$/),
});
export type PaymentConfigDrafted = z.infer<typeof PaymentConfigDrafted>;

export const PaymentConfigEntry = z.object({
  id: z.uuid(),
  lenderId: z.uuid(),
  provider: z.string(),
  providerMode: PaymentConfigMode,
  merchantRegistryId: z.uuid(),
  settlementAccountId: z.uuid(),
  secretRef: z.string(),
  webhookSecretRef: z.string(),
  railLimits: z.record(
    z.string(),
    z.record(z.string(), z.union([z.string(), z.boolean(), z.number()])),
  ),
  railLimitsSource: z.string().nullable(),
  evidenceRef: z.string().nullable(),
  contractSectionRef: z.string().nullable(),
  status: PaymentConfigStatus,
  draftedBy: z.uuid(),
  draftedAt: Timestamp,
  submittedBy: z.uuid().nullable(),
  submittedAt: Timestamp.nullable(),
  approvedBy: z.uuid().nullable(),
  approvedAt: Timestamp.nullable(),
  statusReason: z.string().nullable(),
  statusReasons: z.array(z.string()),
  lastValidatedAt: Timestamp.nullable(),
  lastValidationOk: z.boolean().nullable(),
  updatedAt: Timestamp,
});
export type PaymentConfigEntry = z.infer<typeof PaymentConfigEntry>;
export const PaymentConfigQuery = z.strictObject({
  ...PageFields,
  lenderId: z.uuid().optional(),
  status: PaymentConfigStatus.optional(),
});
export const PaymentConfigPage = pageOf(PaymentConfigEntry);
export const PaymentConfigDecisionInput = z.strictObject({
  approve: z.boolean(),
  note: AccountsNote.optional(),
});
export type PaymentConfigDecisionInput = z.infer<typeof PaymentConfigDecisionInput>;

export const PaymentConfigHistoryEntry = z.object({
  id: z.uuid(),
  eventKind: z.string(),
  fromStatus: z.string().nullable(),
  toStatus: z.string().nullable(),
  actorKind: z.string(),
  occurredAt: Timestamp,
  reasons: z.array(z.string()),
});
export const PaymentConfigHistory = z.object({ items: z.array(PaymentConfigHistoryEntry) });

export const SettlementAccountRegistryStatus = z.object({
  settlementAccountId: z.uuid(),
  lenderId: z.uuid(),
  maskedRef: z.string(),
  verificationStatus: RegistryVerificationStatus,
  effectiveFrom: DateOnly,
  effectiveTo: DateOnly.nullable(),
  usable: z.boolean(),
});
export const SettlementAccountRegistryStatusList = z.object({
  items: z.array(SettlementAccountRegistryStatus),
});

// ---- feature switches ---------------------------------------------------------------------------------------------

export const FeatureKey = z.string().regex(/^[a-z][a-z0-9_]{2,40}$/);
export const FeatureCatalogEntry = z.object({
  feature: z.string(),
  enableable: z.boolean(),
  introducedIn: z.string(),
  description: z.string(),
  lockedReason: z.string().nullable(),
});
export const FeatureCatalogList = z.object({ items: z.array(FeatureCatalogEntry) });

export const FeatureSwitchState = z.object({
  lenderId: z.uuid(),
  feature: z.string(),
  enabled: z.boolean(),
  enableable: z.boolean(),
  enabledAt: Timestamp.nullable(),
  disabledAt: Timestamp.nullable(),
});
export type FeatureSwitchState = z.infer<typeof FeatureSwitchState>;
export const FeatureSwitchList = z.object({ items: z.array(FeatureSwitchState) });
export const LenderFeatureQuery = z.strictObject({ lenderId: z.uuid().optional() });

/** A flat object of short reference labels (contract number, approval reference), never a document or a personal number. */
export const FeatureEvidence = z
  .record(z.string().regex(/^[a-z][a-z0-9_]{1,40}$/), z.string().min(1).max(200))
  .refine((evidence) => Object.keys(evidence).length <= 20, { message: 'too_many_references' });

export const FeatureChangeRequestInput = z.strictObject({
  lenderId: z.uuid(),
  feature: FeatureKey,
  enable: z.boolean(),
  evidence: FeatureEvidence.default({}),
  reason: AccountsReason.optional(),
});
export type FeatureChangeRequestInput = z.infer<typeof FeatureChangeRequestInput>;
export const FeatureChangeStatus = z.enum([
  'pending',
  'applied',
  'rejected',
  'cancelled',
  'expired',
]);
export const FeatureChangeRequested = z.object({ id: z.uuid(), status: z.literal('pending') });
export const FeatureChangeDecisionInput = z.strictObject({
  approve: z.boolean(),
  note: AccountsNote.optional(),
});
export const FeatureChangeDecided = z.object({
  id: z.uuid(),
  status: z.enum(['applied', 'rejected', 'expired']),
});
export const FeatureChangeCancelled = z.object({ id: z.uuid(), status: z.literal('cancelled') });
export const FeatureKillInput = z.strictObject({
  lenderId: z.uuid(),
  feature: FeatureKey,
  reason: AccountsReason,
});
export const FeatureKilled = z.object({ id: z.uuid(), status: z.literal('applied') });
export const FeatureChangeRequestEntry = z.object({
  id: z.uuid(),
  lenderId: z.uuid(),
  feature: z.string(),
  enable: z.boolean(),
  mode: z.enum(['two_person', 'emergency']),
  status: FeatureChangeStatus,
  evidence: z.record(z.string(), z.string()),
  reason: z.string().nullable(),
  requestedBy: z.uuid(),
  requestedAt: Timestamp,
  expiresAt: Timestamp,
  decidedBy: z.uuid().nullable(),
  decidedAt: Timestamp.nullable(),
  decisionNote: z.string().nullable(),
  appliedAt: Timestamp.nullable(),
});
export type FeatureChangeRequestEntry = z.infer<typeof FeatureChangeRequestEntry>;
export const FeatureChangeRequestQuery = z.strictObject({
  ...PageFields,
  lenderId: z.uuid().optional(),
  status: FeatureChangeStatus.optional(),
});
export const FeatureChangeRequestPage = pageOf(FeatureChangeRequestEntry);
