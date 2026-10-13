import { z } from 'zod';

/** Wire contracts for the borrower app (Phase 05). */
export const LANGUAGES = ['en', 'hi'] as const;
export const ONBOARDING_STATUSES = [
  'account_created',
  'profile_started',
  'profile_completed',
  'deletion_requested',
  'anonymised',
] as const;
export const CONSENT_PURPOSES_REQUIRED = [
  'terms_of_use',
  'privacy_notice',
  'share_with_lenders',
] as const;
export const REQUEST_STATUSES = [
  'draft',
  'submitted',
  'offer_selected',
  'withdrawn',
  'expired',
  'closed',
] as const;
export const STEPUP_ACTIONS = [
  'offer_acceptance',
  'esign',
  'bank_account_change',
  'mandate_creation',
] as const;
export const INTEGRITY_LEVELS = ['none', 'basic', 'device', 'strong'] as const;
export const DELETION_STATUSES = ['requested', 'blocked', 'anonymised', 'cancelled'] as const;

const money = z.number().int().min(1).max(100_000_000_000_000);

export const ConsentState = z.object({
  purpose: z.string(),
  decision: z.enum(['granted', 'denied', 'withdrawn']),
  noticeVersion: z.number().int(),
  capturedAt: z.string(),
});

export const BorrowerMe = z.object({
  profile: z.object({
    displayName: z.string().nullable(),
    preferredLanguage: z.enum(LANGUAGES),
    onboardingStatus: z.enum(ONBOARDING_STATUSES),
  }),
  /**
   * Separate facts, none of which means KYC or eligibility. `lenderKyc` and `eligibility` are always
   * "not_started": they belong to the lender in Phase 06.
   */
  journey: z.object({
    accountCreated: z.literal(true),
    profileStarted: z.boolean(),
    profileCompleted: z.boolean(),
    consentsCompleted: z.boolean(),
    draftRequests: z.number().int(),
    submittedRequests: z.number().int(),
    lenderKyc: z.literal('not_started'),
    eligibility: z.literal('not_assessed'),
  }),
  consents: z.array(ConsentState),
  preferences: z.object({ serviceUpdatesSms: z.boolean() }),
  /** Marketing is switched off at launch; a separate consent will be offered only after approval. */
  marketing: z.object({ available: z.boolean() }),
  integrityLevel: z.enum(INTEGRITY_LEVELS),
});
export type BorrowerMe = z.infer<typeof BorrowerMe>;

export const ProfileUpdate = z.strictObject({
  displayName: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .regex(/^[^<>]+$/)
    .nullable()
    .optional(),
  preferredLanguage: z.enum(LANGUAGES).optional(),
});
export const PreferencesUpdate = z.strictObject({ serviceUpdatesSms: z.boolean() });

export const Notice = z.object({
  id: z.uuid(),
  purpose: z.string(),
  version: z.number().int(),
  language: z.string(),
  title: z.string(),
  bodyMarkdown: z.string(),
  bodySha256: z.string(),
  /** `requires_review`: wording counsel has not approved. Shown with a label; cannot be the basis of a required consent. */
  reviewStatus: z.enum(['approved', 'requires_review']),
  /** True when the requested language was not published and English is shown instead. */
  languageFallback: z.boolean(),
  required: z.boolean(),
});
export const NoticeList = z.object({ items: z.array(Notice), marketingAvailable: z.boolean() });
export const ConsentDecisionInput = z.strictObject({
  noticeId: z.uuid(),
  decision: z.enum(['granted', 'denied', 'withdrawn']),
  screen: z
    .string()
    .regex(/^[a-z_]{2,40}$/)
    .default('consent'),
  appVersion: z
    .string()
    .regex(/^[0-9A-Za-z.+-]{1,40}$/)
    .default('unknown'),
});

export const LoanPurpose = z.object({
  key: z.string(),
  label: z.string(),
  labelStatus: z.enum(['approved', 'requires_review']),
});
export const LoanPurposeList = z.object({ items: z.array(LoanPurpose) });
export const BorrowerCategory = z.object({
  key: z.string(),
  name: z.string(),
  minTenureDays: z.number().int(),
});
export const BorrowerCategoryList = z.object({ items: z.array(BorrowerCategory) });
export const BorrowerProduct = z.object({
  versionId: z.uuid(),
  categoryKey: z.string(),
  name: z.string(),
  minAmountMinor: z.number().int(),
  maxAmountMinor: z.number().int(),
  minTenureDays: z.number().int(),
  maxTenureDays: z.number().int(),
});
export const BorrowerProductList = z.object({ items: z.array(BorrowerProduct), note: z.string() });

export const LoanRequestInput = z.strictObject({
  categoryKey: z.string().regex(/^[a-z_]+$/),
  amountMinor: money,
  tenureDays: z.number().int().min(1).max(10_950),
  purposeCode: z.string().regex(/^[a-z][a-z_]{1,39}$/),
  productVersionId: z.uuid().optional(),
});
export const LoanRequestPatch = z.strictObject({
  expectedVersion: z.number().int().min(1),
  amountMinor: money.optional(),
  tenureDays: z.number().int().min(1).max(10_950).optional(),
  purposeCode: z
    .string()
    .regex(/^[a-z][a-z_]{1,39}$/)
    .optional(),
  productVersionId: z.uuid().optional(),
  clearProduct: z.boolean().optional(),
});
export const VersionedAction = z.strictObject({ expectedVersion: z.number().int().min(1) });

export const LoanRequestEvent = z.object({
  event: z.string(),
  fromStatus: z.string().nullable(),
  toStatus: z.string(),
  occurredAt: z.string(),
});
export const LoanRequest = z.object({
  id: z.uuid(),
  categoryKey: z.string(),
  amountMinor: z.number().int(),
  tenureDays: z.number().int(),
  purposeCode: z.string(),
  status: z.enum(REQUEST_STATUSES),
  version: z.number().int(),
  expiresAt: z.string().nullable(),
  submissionReference: z.string().nullable(),
  submittedAt: z.string().nullable(),
  productVersionId: z.uuid().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type LoanRequest = z.infer<typeof LoanRequest>;
export const LoanRequestPage = z.object({
  items: z.array(LoanRequest),
  nextCursor: z.string().nullable(),
});
export const LoanRequestDetail = z.object({
  request: LoanRequest,
  events: z.array(LoanRequestEvent),
});
export const LoanRequestVersion = z.object({ id: z.uuid(), version: z.number().int() });
export const SubmitResult = z.object({
  id: z.uuid(),
  submissionReference: z.string(),
  status: z.literal('submitted'),
});

export const StepUpStart = z.strictObject({
  action: z.enum(STEPUP_ACTIONS),
  contextRef: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
});
export const StepUpStarted = z.object({
  challengeId: z.uuid(),
  expiresAt: z.string(),
  /** `accepted` means the SMS provider took the message; it is never a claim that it was delivered. */
  delivery: z.enum(['accepted', 'rejected', 'timeout', 'not_configured']),
});
export const StepUpVerify = z.strictObject({ code: z.string().regex(/^[0-9]{6}$/) });
export const StepUpVerified = z.object({
  result: z.enum(['verified', 'invalid', 'expired', 'locked', 'not_found', 'already_verified']),
});

export const IntegrityNonce = z.object({ nonce: z.string(), expiresAt: z.string() });
export const IntegrityVerifyInput = z.strictObject({
  token: z.string().min(1).max(8000),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
});
export const IntegrityResult = z.object({
  status: z.enum(['verified', 'invalid', 'unavailable']),
  level: z.enum(INTEGRITY_LEVELS),
});

export const DeletionRequest = z.object({
  id: z.uuid(),
  status: z.enum(DELETION_STATUSES),
  blockedReason: z.string().nullable(),
  requestedAt: z.string(),
  processedAt: z.string().nullable(),
  /** The sign-in identity lives in the authentication provider; its removal is tracked separately and not claimed until done. */
  signInIdentityRemoved: z.boolean(),
});
export const DeletionCurrent = z.object({ item: DeletionRequest.nullable() });

export type Notice = z.infer<typeof Notice>;
export type LoanPurpose = z.infer<typeof LoanPurpose>;
export type BorrowerCategory = z.infer<typeof BorrowerCategory>;
export type BorrowerProduct = z.infer<typeof BorrowerProduct>;
export type LoanRequestEvent = z.infer<typeof LoanRequestEvent>;
export type DeletionRequest = z.infer<typeof DeletionRequest>;
export type StepUpStarted = z.infer<typeof StepUpStarted>;
export type StepUpVerified = z.infer<typeof StepUpVerified>;
