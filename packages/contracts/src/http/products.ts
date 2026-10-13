import { z } from 'zod';

/**
 * Lender product configuration (Phase 04). The lender defines its own terms; Udofin stores and
 * shows them. Nothing here is checked against regulatory limits: the lender decides, the lender's
 * own approver (a different person from the drafter) approves, and a product is shown to borrowers
 * only once the lender is live (see lending.borrower_visible_product_versions).
 */

export const PRODUCT_STATUSES = ['draft', 'active', 'suspended', 'retired'] as const;
export const VERSION_STATUSES = ['draft', 'pending_approval', 'approved', 'retired'] as const;
export const RATE_TYPES = ['fixed', 'floating'] as const;

const money = z.number().int().min(0).max(100_000_000_000_000);
const bps = z.number().int().min(0).max(10_000);
const code = z.string().regex(/^[a-z][a-z0-9_]{1,39}$/);
const label = z.string().trim().min(1).max(120);
const shortText = z.string().trim().min(1).max(500);

export const FEE_KINDS = ['flat', 'percent_of_principal', 'percent_of_outstanding'] as const;
export const FEE_TIMINGS = ['at_disbursement', 'with_installment', 'on_event'] as const;
export const REPAYMENT_FREQUENCIES = [
  'weekly',
  'fortnightly',
  'monthly',
  'quarterly',
  'bullet',
] as const;
export const REPAYMENT_METHODS = [
  'upi_autopay',
  'enach',
  'upi_collect',
  'netbanking',
  'manual_transfer',
] as const;
export const INSTALLMENT_TYPES = [
  'equated',
  'reducing_balance',
  'flat_rate',
  'interest_only_then_bullet',
] as const;
export const ELIGIBILITY_FIELDS = [
  'age_years',
  'monthly_income_minor',
  'employment_type',
  'work_experience_months',
  'residence_state',
  'residence_pincode_prefix',
  'credit_score',
  'existing_obligations_to_income_bps',
  'requested_amount_minor',
  'requested_tenure_days',
] as const;
export const ELIGIBILITY_OPERATORS = [
  'eq',
  'neq',
  'gte',
  'lte',
  'between',
  'in',
  'not_in',
] as const;
export const CHANNELS = ['mobile_app'] as const;

const eligibilityValue = z.union([
  z.number().int(),
  z.string().trim().min(1).max(60),
  z
    .array(z.union([z.number().int(), z.string().trim().min(1).max(60)]))
    .min(1)
    .max(50),
]);

export const ProductFee = z
  .strictObject({
    code,
    label,
    kind: z.enum(FEE_KINDS),
    amountMinor: money.optional(),
    rateBps: bps.optional(),
    minMinor: money.optional(),
    maxMinor: money.optional(),
    taxIncluded: z.boolean(),
    timing: z.enum(FEE_TIMINGS),
    refundable: z.boolean().default(false),
  })
  .superRefine((fee, ctx) => {
    if (fee.kind === 'flat' && fee.amountMinor === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['amountMinor'],
        message: 'a flat fee needs an amount',
      });
    }
    if (fee.kind !== 'flat' && fee.rateBps === undefined) {
      ctx.addIssue({ code: 'custom', path: ['rateBps'], message: 'a percentage fee needs a rate' });
    }
    if (fee.minMinor !== undefined && fee.maxMinor !== undefined && fee.minMinor > fee.maxMinor) {
      ctx.addIssue({ code: 'custom', path: ['maxMinor'], message: 'maximum is below minimum' });
    }
  });

export const EligibilityRule = z
  .strictObject({
    field: z.enum(ELIGIBILITY_FIELDS),
    operator: z.enum(ELIGIBILITY_OPERATORS),
    value: eligibilityValue,
    note: shortText.optional(),
  })
  .superRefine((rule, ctx) => {
    const list = Array.isArray(rule.value);
    if (
      (rule.operator === 'in' || rule.operator === 'not_in') !== list &&
      rule.operator !== 'between'
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['value'],
        message: 'in / not_in take a list; other operators a single value',
      });
    }
    const v = rule.value;
    if (
      rule.operator === 'between' &&
      !(Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === 'number'))
    ) {
      ctx.addIssue({ code: 'custom', path: ['value'], message: 'between takes two numbers' });
    }
  });

export const ProductDocument = z.strictObject({
  code,
  label,
  mandatory: z.boolean(),
  acceptedMimeTypes: z
    .array(z.enum(['application/pdf', 'image/png', 'image/jpeg']))
    .min(1)
    .max(3),
});

export const ProductConfigV1 = z.strictObject({
  display: z
    .strictObject({
      marketingName: label.optional(),
      shortDescription: shortText.optional(),
    })
    .optional(),
  amounts: z.strictObject({ stepMinor: money.min(1).optional() }).optional(),
  tenure: z
    .strictObject({
      allowedTenureDays: z.array(z.number().int().min(1).max(10_950)).min(1).max(60).optional(),
      stepDays: z.number().int().min(1).max(3650).optional(),
    })
    .optional(),
  rate: z
    .strictObject({
      benchmarkName: label.optional(),
      spreadBps: bps.optional(),
      resetFrequency: z.enum(['monthly', 'quarterly', 'half_yearly', 'annually']).optional(),
    })
    .optional(),
  fees: z.array(ProductFee).max(20).default([]),
  penalCharges: z
    .strictObject({
      kind: z.enum(['flat', 'percent_of_overdue_amount']),
      amountMinor: money.optional(),
      rateBps: bps.optional(),
      gracePeriodDays: z.number().int().min(0).max(365).default(0),
      summary: shortText,
    })
    .optional(),
  prepayment: z
    .strictObject({
      allowed: z.boolean(),
      partPrepaymentAllowed: z.boolean(),
      minPartPrepaymentMinor: money.optional(),
      lockInDays: z.number().int().min(0).max(3650).default(0),
      chargeSummary: shortText.optional(),
    })
    .optional(),
  repayment: z
    .strictObject({
      frequencies: z.array(z.enum(REPAYMENT_FREQUENCIES)).min(1).max(5),
      methods: z.array(z.enum(REPAYMENT_METHODS)).min(1).max(5),
      installmentType: z.enum(INSTALLMENT_TYPES),
      gracePeriodDays: z.number().int().min(0).max(365).default(0),
      moratoriumDays: z.number().int().min(0).max(1095).default(0),
    })
    .optional(),
  eligibility: z
    .strictObject({
      match: z.enum(['all', 'any']).default('all'),
      rules: z.array(EligibilityRule).max(50),
    })
    .optional(),
  documents: z.array(ProductDocument).max(30).default([]),
  disclosures: z
    .strictObject({
      keyFactStatementTemplateRef: z.string().trim().min(1).max(120).optional(),
      termsDocumentRef: z.string().trim().min(1).max(120).optional(),
      grievanceContactRef: z.string().trim().min(1).max(120).optional(),
    })
    .optional(),
  channels: z.array(z.enum(CHANNELS)).min(1).max(1).default(['mobile_app']),
  /** Lender-defined extra attributes (e.g. internal codes). Keys snake_case, values scalar, never personal data. */
  attributes: z
    .record(
      z.string().regex(/^[a-z][a-z0-9_]{1,39}$/),
      z.union([z.string().max(200), z.number(), z.boolean()]),
    )
    .refine((r) => Object.keys(r).length <= 30, 'at most 30 attributes')
    .default({}),
});
export type ProductConfigV1 = z.infer<typeof ProductConfigV1>;

export const ProductTerms = z
  .strictObject({
    minAmountMinor: money.min(1),
    maxAmountMinor: money.min(1),
    minTenureDays: z.number().int().min(1).max(10_950),
    maxTenureDays: z.number().int().min(1).max(10_950),
    rateType: z.enum(RATE_TYPES),
    minAnnualRateBps: bps,
    maxAnnualRateBps: bps,
  })
  .superRefine((t, ctx) => {
    if (t.minAmountMinor > t.maxAmountMinor)
      ctx.addIssue({
        code: 'custom',
        path: ['maxAmountMinor'],
        message: 'maximum is below minimum',
      });
    if (t.minTenureDays > t.maxTenureDays)
      ctx.addIssue({
        code: 'custom',
        path: ['maxTenureDays'],
        message: 'maximum is below minimum',
      });
    if (t.minAnnualRateBps > t.maxAnnualRateBps)
      ctx.addIssue({
        code: 'custom',
        path: ['maxAnnualRateBps'],
        message: 'maximum is below minimum',
      });
  });

export const ProductVersionInput = z.strictObject({
  terms: ProductTerms,
  config: ProductConfigV1.default(() => ProductConfigV1.parse({})),
});
export type ProductVersionInput = z.infer<typeof ProductVersionInput>;

export const ProductVersion = z.object({
  id: z.uuid(),
  productId: z.uuid(),
  lenderOrgId: z.uuid(),
  version: z.number().int(),
  status: z.enum(VERSION_STATUSES),
  terms: ProductTerms,
  config: ProductConfigV1,
  configSchemaVersion: z.number().int(),
  draftedBy: z.uuid(),
  approvedBy: z.uuid().nullable(),
  approvedAt: z.string().nullable(),
  effectiveFrom: z.string().nullable(),
  createdAt: z.string(),
});
export type ProductVersion = z.infer<typeof ProductVersion>;

export const Product = z.object({
  id: z.uuid(),
  lenderOrgId: z.uuid(),
  categoryKey: z.string(),
  code: z.string(),
  name: z.string(),
  status: z.enum(PRODUCT_STATUSES),
  createdAt: z.string(),
  versions: z.array(ProductVersion),
});
export type Product = z.infer<typeof Product>;
export const ProductList = z.object({ items: z.array(Product) });

export const ProductCreateInput = z.strictObject({
  lenderId: z.uuid(),
  categoryKey: z.string().regex(/^[a-z_]+$/),
  code: z.string().regex(/^[A-Z0-9_-]{2,40}$/),
  name: z.string().trim().min(2).max(120),
});

export const ProductConfigCatalogue = z.object({
  schemaVersion: z.literal(1),
  eligibilityFields: z.array(z.string()),
  eligibilityOperators: z.array(z.string()),
  feeKinds: z.array(z.string()),
  feeTimings: z.array(z.string()),
  repaymentFrequencies: z.array(z.string()),
  repaymentMethods: z.array(z.string()),
  installmentTypes: z.array(z.string()),
  channels: z.array(z.string()),
  limits: z.object({
    fees: z.number(),
    eligibilityRules: z.number(),
    documents: z.number(),
    attributes: z.number(),
  }),
  notes: z.array(z.string()),
});
