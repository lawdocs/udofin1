import {
  CHANNELS,
  ELIGIBILITY_FIELDS,
  ELIGIBILITY_OPERATORS,
  FEE_KINDS,
  FEE_TIMINGS,
  INSTALLMENT_TYPES,
  type PRODUCT_STATUSES,
  type Product,
  ProductConfigCatalogue,
  ProductConfigV1,
  ProductCreateInput,
  ProductList,
  ProductVersionInput,
  REPAYMENT_FREQUENCIES,
  REPAYMENT_METHODS,
  type VERSION_STATUSES,
  Created,
  Done,
} from '@udofin/contracts';
import { z } from 'zod';
import { ApiError } from '../../http/api-error.js';
import { userRoute, type RouteDefinition } from '../../http/routes.js';
import { type UserTx } from '../../db/user-context.js';
import { columns } from '../onboarding/sql.js';

const WRITE_LIMIT = { max: 40, timeWindow: '1 minute' };
const Id = z.strictObject({ id: z.uuid() });

interface ProductRow {
  id: string;
  lenderOrgId: string;
  categoryKey: string;
  code: string;
  name: string;
  status: (typeof PRODUCT_STATUSES)[number];
  createdAt: string;
}
interface VersionRow {
  id: string;
  productId: string;
  lenderOrgId: string;
  version: number;
  status: (typeof VERSION_STATUSES)[number];
  minAmount: string;
  maxAmount: string;
  minTenure: number;
  maxTenure: number;
  rateType: 'fixed' | 'floating';
  minRate: number;
  maxRate: number;
  config: unknown;
  configSchemaVersion: number;
  draftedBy: string;
  approvedBy: string | null;
  approvedAt: string | null;
  effectiveFrom: string | null;
  createdAt: string;
}

const PRODUCT_COLUMNS = columns({
  id: 'id',
  lenderOrgId: 'lender_org_id',
  categoryKey: 'category_key',
  code: 'code',
  name: 'name',
  status: 'status::text',
  createdAt: 'created_at::text',
});
const VERSION_COLUMNS = columns({
  id: 'id',
  productId: 'product_id',
  lenderOrgId: 'lender_org_id',
  version: 'version',
  status: 'status::text',
  minAmount: 'min_amount_minor::text',
  maxAmount: 'max_amount_minor::text',
  minTenure: 'min_tenure_days',
  maxTenure: 'max_tenure_days',
  rateType: 'rate_type',
  minRate: 'min_annual_rate_bps',
  maxRate: 'max_annual_rate_bps',
  config: 'config',
  configSchemaVersion: 'config_schema_version',
  draftedBy: 'drafted_by',
  approvedBy: 'approved_by',
  approvedAt: 'approved_at::text',
  effectiveFrom: 'effective_from::text',
  createdAt: 'created_at::text',
});

function toVersion(row: VersionRow): z.infer<typeof Product>['versions'][number] {
  const config = ProductConfigV1.safeParse(row.config ?? {});
  return {
    id: row.id,
    productId: row.productId,
    lenderOrgId: row.lenderOrgId,
    version: row.version,
    status: row.status,
    terms: {
      minAmountMinor: Number(row.minAmount),
      maxAmountMinor: Number(row.maxAmount),
      minTenureDays: row.minTenure,
      maxTenureDays: row.maxTenure,
      rateType: row.rateType,
      minAnnualRateBps: row.minRate,
      maxAnnualRateBps: row.maxRate,
    },
    // A stored configuration that no longer parses is shown as empty rather than guessed at.
    config: config.success ? config.data : ProductConfigV1.parse({}),
    configSchemaVersion: row.configSchemaVersion,
    draftedBy: row.draftedBy,
    approvedBy: row.approvedBy,
    approvedAt: row.approvedAt,
    effectiveFrom: row.effectiveFrom,
    createdAt: row.createdAt,
  };
}

async function permitted(
  tx: UserTx,
  permission: 'product.configure' | 'product.approve',
  lender: string,
): Promise<boolean> {
  const r = await tx.query<{ ok: boolean }>(
    'select $1::uuid in (select private.orgs_with_permission($2)) as ok',
    [lender, permission],
  );
  return r.rows[0]?.ok === true;
}
async function require(
  tx: UserTx,
  permission: 'product.configure' | 'product.approve',
  lender: string,
): Promise<void> {
  if (!(await permitted(tx, permission, lender))) throw new ApiError(403, 'forbidden', 'Forbidden');
}

async function audit(
  tx: UserTx,
  action: string,
  entity: string,
  id: string,
  lender: string,
  meta: Record<string, unknown> = {},
) {
  await tx.query(`select private.record_audit_event($1, $2, $3, $4::uuid, 'success', $5::jsonb)`, [
    action,
    entity,
    id,
    lender,
    JSON.stringify(meta),
  ]);
}

async function loadVersion(tx: UserTx, id: string): Promise<VersionRow> {
  const r = await tx.query<VersionRow>(
    `select ${VERSION_COLUMNS} from lending.loan_product_versions where id = $1::uuid`,
    [id],
  );
  const row = r.rows[0];
  if (!row) throw new ApiError(404, 'not_found', 'Not Found');
  return row;
}

/**
 * Lender product configuration. The lender's own people configure and approve (maker-checker is
 * enforced by the database as well); Udofin staff can read. Terms are stored exactly as approved and
 * approved versions are immutable - a change is a new version.
 */
export const productRoutes: RouteDefinition[] = [
  userRoute({
    method: 'get',
    path: '/v1/lender/product-config-schema',
    operationId: 'getProductConfigCatalogue',
    summary: 'The options available when configuring a product (for building forms)',
    description:
      'Self-describing catalogue of eligibility fields, fee kinds, repayment options and limits. Udofin does not check configured terms against regulatory limits: the lender decides and is responsible.',
    tags: ['Products'],
    auth: 'staff',
    responses: { 200: ProductConfigCatalogue },
    errors: [401, 403],
    handler: () =>
      Promise.resolve({
        status: 200,
        body: {
          schemaVersion: 1 as const,
          eligibilityFields: [...ELIGIBILITY_FIELDS],
          eligibilityOperators: [...ELIGIBILITY_OPERATORS],
          feeKinds: [...FEE_KINDS],
          feeTimings: [...FEE_TIMINGS],
          repaymentFrequencies: [...REPAYMENT_FREQUENCIES],
          repaymentMethods: [...REPAYMENT_METHODS],
          installmentTypes: [...INSTALLMENT_TYPES],
          channels: [...CHANNELS],
          limits: { fees: 20, eligibilityRules: 50, documents: 30, attributes: 30 },
          notes: [
            'Amounts are integer paise.',
            'Configured terms are not validated against regulatory limits; the lender is responsible for compliance.',
            'An approved version cannot be edited; create a new version.',
            'Attributes must never contain personal data or secrets.',
          ],
        },
      }),
  }),

  userRoute({
    method: 'get',
    path: '/v1/lender/product-categories',
    operationId: 'listProductCategories',
    summary: 'Product categories the platform currently supports',
    tags: ['Products'],
    auth: 'staff',
    responses: {
      200: z.object({
        items: z.array(
          z.object({
            key: z.string(),
            name: z.string(),
            availability: z.string(),
            minTenureDays: z.number().int(),
          }),
        ),
      }),
    },
    errors: [401, 403],
    handler: async ({ tx }) => {
      const r = await tx.query(
        `select key, name, availability, min_tenure_days as "minTenureDays" from lending.product_categories order by (availability = 'enabled') desc, name`,
      );
      return { status: 200, body: { items: r.rows } };
    },
  }),

  userRoute({
    method: 'get',
    path: '/v1/lender/products',
    operationId: 'listLenderProducts',
    summary: 'Products and all their versions for lenders the caller may see',
    tags: ['Products'],
    auth: 'staff',
    query: z.strictObject({ lenderId: z.uuid().optional() }),
    responses: { 200: ProductList },
    errors: [401, 403, 422],
    handler: async ({ tx, query }) => {
      const products = await tx.query<ProductRow>(
        `select ${PRODUCT_COLUMNS} from lending.loan_products
          where ($1::uuid is null or lender_org_id = $1::uuid) order by created_at, id limit 200`,
        [query.lenderId ?? null],
      );
      const ids = products.rows.map((p) => p.id);
      const versions = await tx.query<VersionRow>(
        `select ${VERSION_COLUMNS} from lending.loan_product_versions where product_id = any($1::uuid[]) order by version desc`,
        [ids],
      );
      return {
        status: 200,
        body: {
          items: products.rows.map((p) => ({
            ...p,
            versions: versions.rows.filter((v) => v.productId === p.id).map(toVersion),
          })),
        },
      };
    },
  }),

  userRoute({
    method: 'post',
    path: '/v1/lender/products',
    operationId: 'createLenderProduct',
    summary: 'Create a product (in draft); it has no versions and is not visible to borrowers',
    tags: ['Products'],
    auth: 'staff',
    idempotent: true,
    idempotencyTenant: ({ body }) => (body as { lenderId: string }).lenderId,
    body: ProductCreateInput,
    responses: { 201: Created },
    errors: [400, 401, 403, 409, 422],
    rateLimit: WRITE_LIMIT,
    handler: async ({ tx, body }) => {
      await require(tx, 'product.configure', body.lenderId);
      const r = await tx.query<{ id: string }>(
        `insert into lending.loan_products (lender_org_id, category_key, code, name) values ($1::uuid, $2, $3, $4) returning id`,
        [body.lenderId, body.categoryKey, body.code, body.name],
      );
      const id = r.rows[0]?.id;
      if (!id) throw new Error('insert returned nothing');
      await audit(tx, 'lending.product.created', 'loan_product', id, body.lenderId);
      return { status: 201, body: { id } };
    },
  }),

  userRoute({
    method: 'post',
    path: '/v1/lender/products/:id/status',
    operationId: 'setLenderProductStatus',
    summary: 'Activate, suspend or retire a product',
    description:
      'Activating needs at least one approved version. Activation by the lender does not make the product visible to borrowers: that also needs the lender itself to be live.',
    tags: ['Products'],
    auth: 'staff',
    idempotent: true,
    params: Id,
    body: z.strictObject({ to: z.enum(['active', 'suspended', 'retired']) }),
    responses: { 200: Done },
    errors: [400, 401, 403, 404, 409, 422],
    rateLimit: WRITE_LIMIT,
    handler: async ({ tx, params, body }) => {
      const p = await tx.query<ProductRow>(
        `select ${PRODUCT_COLUMNS} from lending.loan_products where id = $1::uuid`,
        [params.id],
      );
      const product = p.rows[0];
      if (!product) throw new ApiError(404, 'not_found', 'Not Found');
      await require(tx, 'product.approve', product.lenderOrgId);
      const allowed: Record<string, string[]> = {
        draft: ['active', 'retired'],
        active: ['suspended', 'retired'],
        suspended: ['active', 'retired'],
        retired: [],
      };
      if (!allowed[product.status]?.includes(body.to))
        throw new ApiError(409, 'conflict', 'Conflict');
      if (body.to === 'active') {
        const ok = await tx.query(
          `select 1 from lending.loan_product_versions where product_id = $1::uuid and status = 'approved' limit 1`,
          [params.id],
        );
        if (ok.rowCount === 0) throw new ApiError(409, 'no_approved_version', 'Conflict');
      }
      await tx.query(
        `update lending.loan_products set status = $2::lending.product_status where id = $1::uuid`,
        [params.id, body.to],
      );
      await audit(
        tx,
        'lending.product.status_changed',
        'loan_product',
        params.id,
        product.lenderOrgId,
        { from: product.status, to: body.to },
      );
      return { status: 200, body: { ok: true as const } };
    },
  }),

  userRoute({
    method: 'post',
    path: '/v1/lender/products/:id/versions',
    operationId: 'createProductVersion',
    summary: 'Draft a new version of a product (terms and configuration)',
    tags: ['Products'],
    auth: 'staff',
    idempotent: true,
    params: Id,
    body: ProductVersionInput,
    responses: { 201: Created },
    errors: [400, 401, 403, 404, 409, 422],
    rateLimit: WRITE_LIMIT,
    handler: async ({ tx, params, body }) => {
      const p = await tx.query<ProductRow>(
        `select ${PRODUCT_COLUMNS} from lending.loan_products where id = $1::uuid`,
        [params.id],
      );
      const product = p.rows[0];
      if (!product) throw new ApiError(404, 'not_found', 'Not Found');
      await require(tx, 'product.configure', product.lenderOrgId);
      const t = body.terms;
      const r = await tx.query<{ id: string }>(
        `insert into lending.loan_product_versions (product_id, lender_org_id, version, status, min_amount_minor, max_amount_minor,
            min_tenure_days, max_tenure_days, rate_type, min_annual_rate_bps, max_annual_rate_bps, config, config_schema_version, drafted_by)
         values ($1::uuid, $2::uuid, (select coalesce(max(version), 0) + 1 from lending.loan_product_versions where product_id = $1::uuid),
            'draft', $3::bigint, $4::bigint, $5, $6, $7, $8, $9, $10::jsonb, 1, (select auth.uid()))
         returning id`,
        [
          params.id,
          product.lenderOrgId,
          t.minAmountMinor,
          t.maxAmountMinor,
          t.minTenureDays,
          t.maxTenureDays,
          t.rateType,
          t.minAnnualRateBps,
          t.maxAnnualRateBps,
          JSON.stringify(body.config),
        ],
      );
      const id = r.rows[0]?.id;
      if (!id) throw new Error('insert returned nothing');
      await audit(
        tx,
        'lending.product_version.drafted',
        'loan_product_version',
        id,
        product.lenderOrgId,
      );
      return { status: 201, body: { id } };
    },
  }),

  userRoute({
    method: 'post',
    path: '/v1/lender/product-versions/:id/draft',
    operationId: 'updateProductVersionDraft',
    summary: 'Replace the terms and configuration of your own draft',
    tags: ['Products'],
    auth: 'staff',
    idempotent: true,
    params: Id,
    body: ProductVersionInput,
    responses: { 200: Done },
    errors: [400, 401, 403, 404, 409, 422],
    rateLimit: WRITE_LIMIT,
    handler: async ({ tx, params, body }) => {
      const v = await loadVersion(tx, params.id);
      await require(tx, 'product.configure', v.lenderOrgId);
      const t = body.terms;
      const r = await tx.query(
        `update lending.loan_product_versions set min_amount_minor = $2::bigint, max_amount_minor = $3::bigint, min_tenure_days = $4,
            max_tenure_days = $5, rate_type = $6, min_annual_rate_bps = $7, max_annual_rate_bps = $8, config = $9::jsonb
          where id = $1::uuid and status = 'draft' and drafted_by = (select auth.uid())`,
        [
          params.id,
          t.minAmountMinor,
          t.maxAmountMinor,
          t.minTenureDays,
          t.maxTenureDays,
          t.rateType,
          t.minAnnualRateBps,
          t.maxAnnualRateBps,
          JSON.stringify(body.config),
        ],
      );
      if (r.rowCount === 0) throw new ApiError(409, 'conflict', 'Conflict');
      await audit(
        tx,
        'lending.product_version.edited',
        'loan_product_version',
        params.id,
        v.lenderOrgId,
      );
      return { status: 200, body: { ok: true as const } };
    },
  }),

  userRoute({
    method: 'post',
    path: '/v1/lender/product-versions/:id/submit',
    operationId: 'submitProductVersion',
    summary: 'Send your draft for approval by a different person',
    tags: ['Products'],
    auth: 'staff',
    idempotent: true,
    params: Id,
    responses: { 200: Done },
    errors: [401, 403, 404, 409],
    rateLimit: WRITE_LIMIT,
    handler: async ({ tx, params }) => {
      const v = await loadVersion(tx, params.id);
      await require(tx, 'product.configure', v.lenderOrgId);
      const r = await tx.query(
        `update lending.loan_product_versions set status = 'pending_approval'
          where id = $1::uuid and status = 'draft' and drafted_by = (select auth.uid())`,
        [params.id],
      );
      if (r.rowCount === 0) throw new ApiError(409, 'conflict', 'Conflict');
      await audit(
        tx,
        'lending.product_version.submitted',
        'loan_product_version',
        params.id,
        v.lenderOrgId,
      );
      return { status: 200, body: { ok: true as const } };
    },
  }),

  userRoute({
    method: 'post',
    path: '/v1/lender/product-versions/:id/decision',
    operationId: 'decideProductVersion',
    summary: 'Approve a version, or send it back to draft with a reason',
    description:
      'Needs product.approve and a different person from the drafter. An approved version is immutable and effective immediately; it still is not shown to borrowers until the lender is live and the product is active.',
    tags: ['Products'],
    auth: 'staff',
    idempotent: true,
    params: Id,
    body: z.strictObject({
      approve: z.boolean(),
      note: z.string().trim().min(10).max(1000).optional(),
    }),
    responses: { 200: Done },
    errors: [400, 401, 403, 404, 409, 422],
    rateLimit: WRITE_LIMIT,
    handler: async ({ tx, params, body }) => {
      const v = await loadVersion(tx, params.id);
      await require(tx, 'product.approve', v.lenderOrgId);
      const me = await tx.query<{ uid: string }>('select (select auth.uid())::text as uid');
      if (v.draftedBy === me.rows[0]?.uid) throw new ApiError(403, 'self_approval', 'Forbidden');
      if (v.status !== 'pending_approval') throw new ApiError(409, 'conflict', 'Conflict');
      if (body.approve) {
        await tx.query(
          `update lending.loan_product_versions set status = 'approved', approved_by = (select auth.uid()), approved_at = now(), effective_from = now()
            where id = $1::uuid and status = 'pending_approval'`,
          [params.id],
        );
        await audit(
          tx,
          'lending.product_version.approved',
          'loan_product_version',
          params.id,
          v.lenderOrgId,
        );
      } else {
        if (!body.note)
          throw new ApiError(422, 'validation_failed', 'Unprocessable Content', 'note: required');
        await tx.query(
          `update lending.loan_product_versions set status = 'draft' where id = $1::uuid and status = 'pending_approval'`,
          [params.id],
        );
        await audit(
          tx,
          'lending.product_version.returned',
          'loan_product_version',
          params.id,
          v.lenderOrgId,
          { noted: true },
        );
      }
      return { status: 200, body: { ok: true as const } };
    },
  }),

  userRoute({
    method: 'post',
    path: '/v1/lender/product-versions/:id/retire',
    operationId: 'retireProductVersion',
    summary: 'Retire an approved version (it stays on record; new applications cannot use it)',
    tags: ['Products'],
    auth: 'staff',
    idempotent: true,
    params: Id,
    responses: { 200: Done },
    errors: [401, 403, 404, 409],
    rateLimit: WRITE_LIMIT,
    handler: async ({ tx, params }) => {
      const v = await loadVersion(tx, params.id);
      await require(tx, 'product.approve', v.lenderOrgId);
      const r = await tx.query(
        `update lending.loan_product_versions set status = 'retired' where id = $1::uuid and status = 'approved'`,
        [params.id],
      );
      if (r.rowCount === 0) throw new ApiError(409, 'conflict', 'Conflict');
      await audit(
        tx,
        'lending.product_version.retired',
        'loan_product_version',
        params.id,
        v.lenderOrgId,
      );
      return { status: 200, body: { ok: true as const } };
    },
  }),
];
