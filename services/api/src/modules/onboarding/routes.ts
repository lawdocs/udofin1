import { createHash, randomUUID } from 'node:crypto';
import {
  AccountingDraftInput,
  AccountingProfileList,
  ContractList,
  Created,
  DocumentContent,
  DocumentList,
  DocumentRecord,
  DocumentUploadInput,
  Done,
  GATE_SEQUENCE,
  GATE_STAGES,
  GateConditions,
  GateRequest,
  GateRequestList,
  InstitutionCategoryList,
  IntegrationList,
  LenderOverview,
  LenderServiceList,
  type LenderSummary,
  LenderSummaryList,
  RequirementList,
  ServiceCategoryList,
  ServiceCreateInput,
  ServiceReviseInput,
  StageResult,
  VerificationHistory,
  CONTRACT_TYPES,
  INTEGRATION_KINDS,
  LICENCE_STATUSES,
} from '@udofin/contracts';
import { type DocumentStore } from '@udofin/adapters';
import { z } from 'zod';
import { ApiError } from '../../http/api-error.js';
import { userRoute, type RouteDefinition } from '../../http/routes.js';
import { assertUploadAllowed } from '../../http/upload-safety.js';
import { columns } from '../../db/columns.js';
import { assertCan, lenderOf, scalar, toSnake } from './sql.js';

const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;
const WRITE_LIMIT = { max: 40, timeWindow: '1 minute' };
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const note = z.string().trim().min(1).max(2000);

const Lender = z.strictObject({ lenderId: z.uuid() });
const Id = z.strictObject({ id: z.uuid() });
const Key = z.strictObject({ key: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/) });
const Decision = z.strictObject({ approve: z.boolean(), note: note.optional() });

const ProfileFields = {
  regulator: z.string().trim().min(2).max(80).optional(),
  registrationNo: z.string().trim().min(3).max(60).optional(),
  cin: z
    .string()
    .regex(/^[A-Z0-9]{8,25}$/)
    .optional(),
  licenceType: z.string().trim().min(2).max(120).optional(),
  licenceIssuedOn: day.optional(),
  licenceValidUntil: day.optional(),
  licenceStatus: z.enum(LICENCE_STATUSES).optional(),
  notes: z.string().trim().min(1).max(2000).optional(),
};
const ProfileCreate = z.strictObject({
  lenderOrgId: z.uuid(),
  categoryKey: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/),
  ...ProfileFields,
});
const ProfileUpdate = z.strictObject({
  categoryKey: z
    .string()
    .regex(/^[a-z][a-z0-9_]{1,40}$/)
    .optional(),
  ...ProfileFields,
});

const ok = { status: 200, body: { ok: true as const } };

const PROFILE_COLUMNS = columns({
  lenderOrgId: 'lender_org_id',
  categoryKey: 'category_key',
  regulator: 'regulator',
  registrationNo: 'registration_no',
  cin: 'cin',
  licenceType: 'licence_type',
  licenceIssuedOn: 'licence_issued_on::text',
  licenceValidUntil: 'licence_valid_until::text',
  licenceStatus: 'licence_status',
  notes: 'notes',
  verificationStatus: 'verification_status',
  verificationEvidenceId: 'verification_evidence_id',
  verifiedAt: 'verified_at::text',
  lastVerifiedOn: 'last_verified_on::text',
  reverifyBy: 'reverify_by::text',
  verificationNote: 'verification_note',
  updatedAt: 'updated_at::text',
});

const ACCOUNTING_COLUMNS = columns({
  id: 'id',
  lenderOrgId: 'lender_org_id',
  versionNo: 'version_no',
  status: 'status',
  accountingFramework: 'accounting_framework',
  indAsApplicability: 'ind_as_applicability',
  indAsImplementationStatus: 'ind_as_implementation_status',
  applicabilityBasis: 'applicability_basis',
  applicabilityBasisNote: 'applicability_basis_note',
  effectiveFy: 'effective_fy',
  effectiveDate: 'effective_date::text',
  statementScope: 'statement_scope',
  listedStatus: 'listed_status',
  groupRelationships: 'group_relationships',
  netWorthPaise: 'net_worth_paise::text',
  netWorthMeasuredOn: 'net_worth_measured_on::text',
  netWorthFy: 'net_worth_fy',
  confirmationSource: 'confirmation_source',
  evidenceDocumentId: 'evidence_document_id',
  notes: 'notes',
  nextReviewOn: 'next_review_on::text',
  submittedAt: 'submitted_at::text',
  reviewedAt: 'reviewed_at::text',
  reviewNote: 'review_note',
  lastVerifiedOn: 'last_verified_on::text',
  createdAt: 'created_at::text',
});

const VERSION_COLUMNS = columns({
  id: 'id',
  serviceId: 'service_id',
  versionNo: 'version_no',
  status: 'status',
  requestedScope: 'requested_scope',
  proposedScope: 'proposed_scope',
  agreedScope: 'agreed_scope',
  responsibleParty: 'responsible_party',
  accountableParty: 'accountable_party',
  supportingParties: 'supporting_parties',
  sharedAllocation: 'shared_allocation',
  prerequisites: 'prerequisites',
  dataExchanged: 'data_exchanged',
  permittedPurpose: 'permitted_purpose',
  systemOfRecord: 'system_of_record',
  integrationRequirements: 'integration_requirements',
  slaSummary: 'sla_summary',
  escalationPath: 'escalation_path',
  contractReference: 'contract_reference',
  effectiveFrom: 'effective_from::text',
  reviewOn: 'review_on::text',
  statusNote: 'status_note',
  lenderAgreedAt: 'lender_agreed_at::text',
  udofinAgreedAt: 'udofin_agreed_at::text',
  activatedAt: 'activated_at::text',
  createdAt: 'created_at::text',
});

const REQUIREMENT_COLUMNS = columns({
  id: 'r.id',
  lenderOrgId: 'r.lender_org_id',
  templateKey: 'r.template_key',
  title: 'r.title',
  description: 'r.description',
  serviceId: 'r.service_id',
  productId: 'r.product_id',
  integrationId: 'r.integration_id',
  mandatory: 'r.mandatory',
  evidenceRequired: 'r.evidence_required',
  status: 'r.status',
  requestedOn: 'r.requested_on::text',
  dueOn: 'r.due_on::text',
  receivedOn: 'r.received_on::text',
  evidenceDocumentId: 'r.evidence_document_id',
  reviewedAt: 'r.reviewed_at::text',
  comments: 'r.comments',
  dependsOn: `coalesce(array(select d.depends_on_id from onboarding.requirement_dependencies d where d.requirement_id = r.id), '{}')`,
});

const INTEGRATION_COLUMNS = columns({
  id: 'id',
  lenderOrgId: 'lender_org_id',
  serviceId: 'service_id',
  kind: 'kind',
  name: 'name',
  purpose: 'purpose',
  status: 'status',
  testedOn: 'tested_on::text',
  manualExceptionReason: 'manual_exception_reason',
  exceptionApproved: 'exception_approved_by is not null',
  notes: 'notes',
  createdAt: 'created_at::text',
});

const CONTRACT_COLUMNS = columns({
  id: 'id',
  lenderOrgId: 'lender_org_id',
  contractType: 'contract_type',
  reference: 'reference',
  executedOn: 'executed_on::text',
  effectiveFrom: 'effective_from::text',
  effectiveUntil: 'effective_until::text',
  documentId: 'document_id',
  status: 'status',
  verified: 'verified_by is not null',
  verifiedAt: 'verified_at::text',
  note: 'note',
  createdAt: 'created_at::text',
});

const DOCUMENT_COLUMNS = columns({
  id: 'id',
  lenderOrgId: 'lender_org_id',
  purpose: 'purpose',
  label: 'label',
  mimeType: 'mime_type',
  sizeBytes: 'size_bytes::int',
  sha256: 'sha256',
  scanStatus: 'scan_status',
  uploadedAt: 'uploaded_at::text',
});

const GATE_REQUEST_COLUMNS = columns({
  id: 'id',
  lenderOrgId: 'lender_org_id',
  fromStage: 'from_stage',
  targetStage: 'target_stage',
  status: 'status',
  requestedBy: 'requested_by',
  requestedAt: 'requested_at::text',
  requestNote: 'request_note',
  decidedBy: 'decided_by',
  decidedAt: 'decided_at::text',
  decisionNote: 'decision_note',
});

/**
 * Lender onboarding, accounting framework / Ind AS status, engagement scope, requirements and
 * activation gates. Reads rely on row-level security; writes call the checked SQL functions, which
 * are the authority on permissions, two-person rules and gate order. These routes also check the
 * caller's permission first (assertCan) so the two layers stay aligned and a 403 is clean.
 */
export function onboardingRoutes(documents: DocumentStore | undefined): RouteDefinition[] {
  const requireStore = (): DocumentStore => {
    if (!documents) {
      throw new ApiError(
        503,
        'document_store_unavailable',
        'Service Unavailable',
        'No private document store is configured in this environment.',
      );
    }
    return documents;
  };

  return [
    // ---- reference data -------------------------------------------------------------------
    userRoute({
      method: 'get',
      path: '/v1/onboarding/institution-categories',
      operationId: 'listInstitutionCategories',
      summary: 'Institution categories lenders can be onboarded under',
      description:
        'Banks, NBFC types, urban co-operative banks and other regulated entities are all categories of the same lender record. A category flagged activationAllowed=false cannot reach production until compliance signs it off.',
      tags: ['Onboarding'],
      auth: 'staff',
      responses: { 200: InstitutionCategoryList },
      errors: [401, 403],
      handler: async ({ tx }) => {
        const r = await tx.query(
          `select ${columns({
            key: 'key',
            label: 'label',
            institutionType: 'institution_type',
            regulator: 'regulator',
            regimeStatus: 'regime_status',
            regimeNote: 'regime_note',
            activationAllowed: 'activation_allowed',
            signoffSourceRef: 'signoff_source_ref',
            signoffAt: 'signoff_at::text',
          })} from onboarding.institution_categories where active order by sort_order, key`,
        );
        return { status: 200, body: { items: r.rows } };
      },
    }),
    userRoute({
      method: 'get',
      path: '/v1/onboarding/service-categories',
      operationId: 'listServiceCategories',
      summary: 'Categories of service Udofin can provide to a lender',
      tags: ['Onboarding'],
      auth: 'staff',
      responses: { 200: ServiceCategoryList },
      errors: [401, 403],
      handler: async ({ tx }) => {
        const r = await tx.query(
          `select key, label, description, active from onboarding.service_categories order by sort_order, key`,
        );
        return { status: 200, body: { items: r.rows } };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/onboarding/institution-categories/:key/signoff',
      operationId: 'signOffInstitutionCategory',
      summary: 'Compliance sign-off: allow lenders of this category to be activated',
      description:
        'Requires the compliance sign-off permission. The source reviewed must be cited. This records a human compliance decision; it is not an automated finding.',
      tags: ['Onboarding'],
      auth: 'staff',
      idempotent: true,
      params: Key,
      body: z.strictObject({ sourceRef: z.string().trim().min(10).max(500) }),
      responses: { 200: Done },
      errors: [400, 401, 403, 404, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params, body }) => {
        await assertCan(tx, 'compliance');
        await tx.query('select onboarding.category_signoff($1, $2)', [params.key, body.sourceRef]);
        return ok;
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/onboarding/institution-categories/:key/revoke-signoff',
      operationId: 'revokeInstitutionCategorySignoff',
      summary: 'Withdraw the compliance sign-off for a category',
      tags: ['Onboarding'],
      auth: 'staff',
      idempotent: true,
      params: Key,
      responses: { 200: Done },
      errors: [401, 403, 404],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params }) => {
        await assertCan(tx, 'compliance');
        await tx.query('select onboarding.category_revoke_signoff($1)', [params.key]);
        return ok;
      },
    }),

    // ---- lenders ---------------------------------------------------------------------------
    userRoute({
      method: 'get',
      path: '/v1/onboarding/lenders',
      operationId: 'listOnboardingLenders',
      summary: 'Lenders the caller can see in onboarding, with their stage',
      tags: ['Onboarding'],
      auth: 'staff',
      responses: { 200: LenderSummaryList },
      errors: [401, 403],
      handler: async ({ tx }) => {
        const r = await tx.query(
          `select ${columns({
            lenderOrgId: 'lender_org_id',
            legalName: 'legal_name',
            displayName: 'display_name',
            organizationStatus: 'organization_status',
            categoryKey: 'category_key',
            categoryLabel: 'category_label',
            stage: 'stage',
            verificationStatus: 'verification_status',
            accountingStatus: 'accounting_status',
          })} from onboarding.lender_directory()`,
        );
        return { status: 200, body: { items: r.rows } };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/onboarding/lenders',
      operationId: 'createLenderProfile',
      summary: 'Create the institution profile of an existing lender organisation',
      description:
        'Udofin onboarding managers only. The lender organisation itself is created through a two-person change request. A profile never marks the lender approved, verified or eligible.',
      tags: ['Onboarding'],
      auth: 'staff',
      idempotent: true,
      idempotencyTenant: ({ body }) => (body as { lenderOrgId: string }).lenderOrgId,
      body: ProfileCreate,
      responses: { 201: Created },
      errors: [400, 401, 403, 404, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, body }) => {
        await assertCan(tx, 'manage');
        const { lenderOrgId, categoryKey, ...rest } = body;
        await tx.query('select onboarding.profile_create($1::uuid, $2, $3::jsonb)', [
          lenderOrgId,
          categoryKey,
          toSnake(rest),
        ]);
        return { status: 201, body: { id: lenderOrgId } };
      },
    }),
    userRoute({
      method: 'get',
      path: '/v1/onboarding/lenders/:lenderId',
      operationId: 'getOnboardingLender',
      summary: 'Profile, stage and verification status of one lender',
      tags: ['Onboarding'],
      auth: 'staff',
      params: Lender,
      responses: { 200: LenderOverview },
      errors: [401, 403, 404],
      handler: async ({ tx, params }) => {
        const dir = await tx.query<z.infer<typeof LenderSummary>>(
          `select ${columns({
            lenderOrgId: 'lender_org_id',
            legalName: 'legal_name',
            displayName: 'display_name',
            organizationStatus: 'organization_status',
            categoryKey: 'category_key',
            categoryLabel: 'category_label',
            stage: 'stage',
            verificationStatus: 'verification_status',
            accountingStatus: 'accounting_status',
          })} from onboarding.lender_directory() where lender_org_id = $1::uuid`,
          [params.lenderId],
        );
        const summary = dir.rows[0];
        if (!summary) throw new ApiError(404, 'not_found', 'Not Found');
        const profile = await tx.query(
          `select ${PROFILE_COLUMNS} from onboarding.lender_profiles where lender_org_id = $1::uuid`,
          [params.lenderId],
        );
        const gate = await tx.query(
          `select ${columns({ lenderOrgId: 'lender_org_id', stage: 'stage', stageChangedAt: 'stage_changed_at::text' })}
             from onboarding.lender_gates where lender_org_id = $1::uuid`,
          [params.lenderId],
        );
        const allowed = await tx.query<{ allowed: boolean }>(
          `select c.activation_allowed as allowed from onboarding.lender_profiles p
             join onboarding.institution_categories c on c.key = p.category_key where p.lender_org_id = $1::uuid`,
          [params.lenderId],
        );
        return {
          status: 200,
          body: {
            summary,
            profile: profile.rows[0] ?? null,
            gate: gate.rows[0] ?? null,
            categoryActivationAllowed: allowed.rows[0]?.allowed ?? null,
          },
        };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/onboarding/lenders/:lenderId/profile',
      operationId: 'updateLenderProfile',
      summary: 'Update institution profile fields',
      description:
        'Lenders can correct their own identity details; only Udofin can change the category. Changing identity details withdraws an earlier verification.',
      tags: ['Onboarding'],
      auth: 'staff',
      idempotent: true,
      idempotencyTenant: ({ params }) => params.lenderId,
      params: Lender,
      body: ProfileUpdate,
      responses: { 200: Done },
      errors: [400, 401, 403, 404, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params, body }) => {
        await assertCan(tx, 'writer', params.lenderId);
        await tx.query('select onboarding.profile_update($1::uuid, $2::jsonb)', [
          params.lenderId,
          toSnake(body),
        ]);
        return ok;
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/onboarding/lenders/:lenderId/verification/submit',
      operationId: 'submitInstitutionVerification',
      summary: 'Submit evidence for institution verification',
      tags: ['Onboarding'],
      auth: 'staff',
      idempotent: true,
      idempotencyTenant: ({ params }) => params.lenderId,
      params: Lender,
      body: z.strictObject({ evidenceDocumentId: z.uuid() }),
      responses: { 200: Done },
      errors: [400, 401, 403, 404, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params, body }) => {
        await assertCan(tx, 'writer', params.lenderId);
        await tx.query('select onboarding.verification_submit($1::uuid, $2::uuid)', [
          params.lenderId,
          body.evidenceDocumentId,
        ]);
        return ok;
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/onboarding/lenders/:lenderId/verification/decision',
      operationId: 'decideInstitutionVerification',
      summary: 'Verify or reject the institution profile (independent reviewer)',
      description:
        'Requires onboarding.approve. Not allowed for anyone who contributed to the profile. Verification records that evidence was reviewed; it does not approve the lender.',
      tags: ['Onboarding'],
      auth: 'staff',
      idempotent: true,
      idempotencyTenant: ({ params }) => params.lenderId,
      params: Lender,
      body: z.strictObject({
        approve: z.boolean(),
        note: note.optional(),
        reverifyBy: day.optional(),
      }),
      responses: { 200: Done },
      errors: [400, 401, 403, 404, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params, body }) => {
        await assertCan(tx, 'approve');
        await tx.query(
          'select onboarding.verification_decide($1::uuid, $2::boolean, $3, $4::date)',
          [params.lenderId, body.approve, body.note ?? null, body.reverifyBy ?? null],
        );
        return ok;
      },
    }),
    userRoute({
      method: 'get',
      path: '/v1/onboarding/lenders/:lenderId/verification-history',
      operationId: 'listVerificationHistory',
      summary: 'Every verification state the institution and accounting profiles passed through',
      tags: ['Onboarding'],
      auth: 'staff',
      params: Lender,
      responses: { 200: VerificationHistory },
      errors: [401, 403, 404],
      handler: async ({ tx, params }) => {
        await assertCan(tx, 'read', params.lenderId);
        const r = await tx.query(
          `select ${columns({
            id: 'id',
            subject: 'subject',
            subjectRef: 'subject_ref',
            status: 'status',
            evidenceDocumentId: 'evidence_document_id',
            actorId: 'actor_id',
            note: 'note',
            recordedAt: 'recorded_at::text',
          })} from onboarding.verification_history where lender_org_id = $1::uuid order by recorded_at desc, id desc limit 200`,
          [params.lenderId],
        );
        return { status: 200, body: { items: r.rows } };
      },
    }),

    // ---- documents ---------------------------------------------------------------------------
    userRoute({
      method: 'get',
      path: '/v1/onboarding/lenders/:lenderId/documents',
      operationId: 'listOnboardingDocuments',
      summary: 'Evidence documents recorded for a lender (metadata only)',
      description: 'Newest first, at most 200.',
      tags: ['Onboarding'],
      auth: 'staff',
      params: Lender,
      responses: { 200: DocumentList },
      errors: [401, 403, 404],
      handler: async ({ tx, params }) => {
        await assertCan(tx, 'read', params.lenderId);
        const r = await tx.query(
          `select ${DOCUMENT_COLUMNS} from onboarding.documents where lender_org_id = $1::uuid order by uploaded_at desc, id desc limit 200`,
          [params.lenderId],
        );
        return { status: 200, body: { items: r.rows } };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/onboarding/lenders/:lenderId/documents',
      operationId: 'uploadOnboardingDocument',
      summary: 'Upload an evidence document (PDF, PNG or JPEG, at most 8 MiB)',
      description:
        'The file is checked against its declared type, hashed on the server and stored privately under an opaque key. Interim transfer format: base64 in JSON; streaming upload comes with the AWS deployment.',
      tags: ['Onboarding'],
      auth: 'staff',
      idempotent: true,
      idempotencyTenant: ({ params }) => params.lenderId,
      params: Lender,
      body: DocumentUploadInput,
      responses: { 201: DocumentRecord },
      errors: [400, 401, 403, 404, 413, 422, 503],
      rateLimit: { max: 20, timeWindow: '1 minute' },
      bodyLimit: 12_000_000,
      handler: async ({ tx, params, body }) => {
        await assertCan(tx, 'writer', params.lenderId);
        const store = requireStore();
        const bytes = Buffer.from(body.contentBase64, 'base64');
        if (bytes.length === 0 || bytes.length > MAX_DOCUMENT_BYTES) {
          throw new ApiError(413, 'document_too_large', 'Content Too Large');
        }
        // Same check as the KFS upload: real type by magic bytes, and no active content in a PDF.
        assertUploadAllowed(bytes, body.mimeType);
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        const storageKey = `onboarding/${randomUUID()}`;
        await store.put(storageKey, bytes, { mimeType: body.mimeType, sha256 });
        try {
          const id = await scalar<string>(
            tx,
            'select onboarding.register_document($1::uuid, $2, $3, $4, $5, $6::bigint, $7) as v',
            [
              params.lenderId,
              body.purpose,
              body.label,
              storageKey,
              sha256,
              bytes.length,
              body.mimeType,
            ],
          );
          const r = await tx.query(
            `select ${DOCUMENT_COLUMNS} from onboarding.documents where id = $1::uuid`,
            [id],
          );
          return { status: 201, body: r.rows[0] };
        } catch (error) {
          await store.delete(storageKey).catch(() => undefined); // do not leave an orphaned blob
          throw error;
        }
      },
    }),
    userRoute({
      method: 'get',
      path: '/v1/onboarding/documents/:id/content',
      operationId: 'downloadOnboardingDocument',
      summary: 'Retrieve a document (authorised readers only; every retrieval is audited)',
      tags: ['Onboarding'],
      auth: 'staff',
      params: Id,
      responses: { 200: DocumentContent },
      errors: [401, 403, 404, 409, 503],
      handler: async ({ tx, params }) => {
        const store = requireStore();
        const meta = await tx.query<{
          storageKey: string;
          mimeType: z.infer<typeof DocumentContent>['mimeType'];
          sha256: string;
          label: string;
        }>(
          `select storage_key as "storageKey", mime_type as "mimeType", sha256, label from onboarding.document_for_download($1::uuid)`,
          [params.id],
        );
        const m = meta.rows[0];
        if (!m) throw new ApiError(404, 'not_found', 'Not Found');
        const object = await store.get(m.storageKey);
        if (!object) throw new ApiError(404, 'not_found', 'Not Found');
        const actual = createHash('sha256').update(object.bytes).digest('hex');
        if (actual !== m.sha256)
          throw new Error('stored document does not match its recorded checksum');
        return {
          status: 200,
          body: {
            id: params.id,
            label: m.label,
            mimeType: m.mimeType,
            sha256: m.sha256,
            contentBase64: Buffer.from(object.bytes).toString('base64'),
          },
        };
      },
    }),

    // ---- accounting framework and Ind AS status ----------------------------------------------
    userRoute({
      method: 'get',
      path: '/v1/onboarding/lenders/:lenderId/accounting-profiles',
      operationId: 'listAccountingProfiles',
      summary: 'Accounting framework & Ind AS status: every version, newest first',
      description:
        'Applicability and implementation are separate fields. Nothing here is derived from lender type, net worth or listing, and a record is not an accounting opinion or proof of compliance.',
      tags: ['Onboarding'],
      auth: 'staff',
      params: Lender,
      responses: { 200: AccountingProfileList },
      errors: [401, 403, 404],
      handler: async ({ tx, params }) => {
        await assertCan(tx, 'read', params.lenderId);
        const r = await tx.query(
          `select ${ACCOUNTING_COLUMNS} from onboarding.accounting_profiles where lender_org_id = $1::uuid order by version_no desc`,
          [params.lenderId],
        );
        return { status: 200, body: { items: r.rows } };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/onboarding/lenders/:lenderId/accounting-profiles',
      operationId: 'saveAccountingDraft',
      summary:
        'Save the open draft of the accounting framework / Ind AS status (creates the next version if none is open)',
      tags: ['Onboarding'],
      auth: 'staff',
      idempotent: true,
      idempotencyTenant: ({ params }) => params.lenderId,
      params: Lender,
      body: AccountingDraftInput,
      responses: { 200: Created },
      errors: [400, 401, 403, 404, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params, body }) => {
        await assertCan(tx, 'writer', params.lenderId);
        const id = await scalar<string>(
          tx,
          'select onboarding.accounting_save_draft($1::uuid, $2::jsonb) as v',
          [params.lenderId, toSnake(body)],
        );
        return { status: 200, body: { id } };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/onboarding/accounting-profiles/:id/submit',
      operationId: 'submitAccountingProfile',
      summary: 'Submit a draft for independent review',
      tags: ['Onboarding'],
      auth: 'staff',
      idempotent: true,
      params: Id,
      responses: { 200: Done },
      errors: [401, 403, 404, 409],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params }) => {
        await assertCan(tx, 'writer', await lenderOf(tx, 'accounting', params.id));
        await tx.query('select onboarding.accounting_submit($1::uuid)', [params.id]);
        return ok;
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/onboarding/accounting-profiles/:id/decision',
      operationId: 'decideAccountingProfile',
      summary: 'Verify or reject an accounting profile (independent reviewer)',
      description:
        'Verification needs evidence and confirmed values; a value still "to be confirmed" can never be verified. Requires onboarding.approve and no earlier contribution to the record.',
      tags: ['Onboarding'],
      auth: 'staff',
      idempotent: true,
      params: Id,
      body: Decision,
      responses: { 200: Done },
      errors: [400, 401, 403, 404, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params, body }) => {
        await assertCan(tx, 'approve');
        await tx.query('select onboarding.accounting_decide($1::uuid, $2::boolean, $3)', [
          params.id,
          body.approve,
          body.note ?? null,
        ]);
        return ok;
      },
    }),

    // ---- accounting waiver (owner decision D-33) -------------------------------------------------
    userRoute({
      method: 'get',
      path: '/v1/onboarding/settings',
      operationId: 'getOnboardingSettings',
      summary:
        'Compliance-controlled onboarding switches (e.g. whether the accounting record may be waived)',
      tags: ['Onboarding'],
      auth: 'staff',
      responses: {
        200: z.object({
          items: z.array(
            z.object({
              key: z.string(),
              value: z.boolean(),
              description: z.string(),
              reason: z.string().nullable(),
            }),
          ),
        }),
      },
      errors: [401, 403],
      handler: async ({ tx }) => {
        const r = await tx.query(
          'select key, bool_value as value, description, reason from onboarding.platform_settings order by key',
        );
        return { status: 200, body: { items: r.rows } };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/onboarding/settings/:key',
      operationId: 'setOnboardingSetting',
      summary:
        'Switch an onboarding policy option on or off (compliance officer, with a recorded reason)',
      tags: ['Onboarding'],
      auth: 'staff',
      idempotent: true,
      params: Key,
      body: z.strictObject({ value: z.boolean(), reason: z.string().trim().min(20).max(1000) }),
      responses: { 200: Done },
      errors: [400, 401, 403, 404, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params, body }) => {
        await assertCan(tx, 'compliance');
        await tx.query('select onboarding.set_setting($1, $2::boolean, $3)', [
          params.key,
          body.value,
          body.reason,
        ]);
        return ok;
      },
    }),
    userRoute({
      method: 'get',
      path: '/v1/onboarding/lenders/:lenderId/accounting-waivers',
      operationId: 'listAccountingWaivers',
      summary: 'Waivers of the verified accounting record for a lender',
      tags: ['Onboarding'],
      auth: 'staff',
      params: Lender,
      responses: {
        200: z.object({
          items: z.array(
            z.object({
              id: z.uuid(),
              status: z.string(),
              reason: z.string(),
              requestedAt: z.string(),
              decidedAt: z.string().nullable(),
              decisionNote: z.string().nullable(),
            }),
          ),
        }),
      },
      errors: [401, 403, 404],
      handler: async ({ tx, params }) => {
        await assertCan(tx, 'read', params.lenderId);
        const r = await tx.query(
          `select ${columns({ id: 'id', status: 'status', reason: 'reason', requestedAt: 'requested_at::text', decidedAt: 'decided_at::text', decisionNote: 'decision_note' })}
             from onboarding.accounting_waivers where lender_org_id = $1::uuid order by requested_at desc`,
          [params.lenderId],
        );
        return { status: 200, body: { items: r.rows } };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/onboarding/lenders/:lenderId/accounting-waivers',
      operationId: 'requestAccountingWaiver',
      summary:
        'Ask to waive the verified accounting record for this lender (only when the option is on)',
      description:
        'Needs a written reason; a different approver decides. The waiver stops counting if the option is switched off.',
      tags: ['Onboarding'],
      auth: 'staff',
      idempotent: true,
      idempotencyTenant: ({ params }) => params.lenderId,
      params: Lender,
      body: z.strictObject({ reason: z.string().trim().min(30).max(2000) }),
      responses: { 201: Created },
      errors: [400, 401, 403, 404, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params, body }) => {
        await assertCan(tx, 'manage');
        const id = await scalar<string>(tx, 'select onboarding.waiver_request($1::uuid, $2) as v', [
          params.lenderId,
          body.reason,
        ]);
        return { status: 201, body: { id } };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/onboarding/accounting-waivers/:id/decision',
      operationId: 'decideAccountingWaiver',
      summary:
        'Approve or reject a waiver (not its requester); or revoke an approved one with revoke=true',
      tags: ['Onboarding'],
      auth: 'staff',
      idempotent: true,
      params: Id,
      body: z.strictObject({
        approve: z.boolean(),
        revoke: z.boolean().optional(),
        note: note.optional(),
      }),
      responses: { 200: Done },
      errors: [400, 401, 403, 404, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params, body }) => {
        await assertCan(tx, 'approve');
        if (body.revoke)
          await tx.query('select onboarding.waiver_revoke($1::uuid, $2)', [
            params.id,
            body.note ?? null,
          ]);
        else
          await tx.query('select onboarding.waiver_decide($1::uuid, $2::boolean, $3)', [
            params.id,
            body.approve,
            body.note ?? null,
          ]);
        return ok;
      },
    }),

    // ---- contracts ---------------------------------------------------------------------------
    userRoute({
      method: 'get',
      path: '/v1/onboarding/lenders/:lenderId/contracts',
      operationId: 'listLenderContracts',
      summary: 'Contract references and their verification',
      tags: ['Onboarding'],
      auth: 'staff',
      params: Lender,
      responses: { 200: ContractList },
      errors: [401, 403, 404],
      handler: async ({ tx, params }) => {
        await assertCan(tx, 'read', params.lenderId);
        const r = await tx.query(
          `select ${CONTRACT_COLUMNS} from onboarding.lender_contracts where lender_org_id = $1::uuid order by created_at desc, id desc`,
          [params.lenderId],
        );
        return { status: 200, body: { items: r.rows } };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/onboarding/lenders/:lenderId/contracts',
      operationId: 'recordLenderContract',
      summary: 'Record a contract and its execution evidence',
      description: 'Recording a contract never approves services, products or commercial terms.',
      tags: ['Onboarding'],
      auth: 'staff',
      idempotent: true,
      idempotencyTenant: ({ params }) => params.lenderId,
      params: Lender,
      body: z.strictObject({
        contractType: z.enum(CONTRACT_TYPES),
        reference: z.string().trim().min(3).max(120),
        executedOn: day.optional(),
        effectiveFrom: day.optional(),
        effectiveUntil: day.optional(),
        documentId: z.uuid().optional(),
        status: z.enum(['draft', 'executed']).optional(),
        note: note.optional(),
      }),
      responses: { 201: Created },
      errors: [400, 401, 403, 404, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params, body }) => {
        await assertCan(tx, 'manage');
        const id = await scalar<string>(
          tx,
          'select onboarding.contract_record($1::uuid, $2::jsonb) as v',
          [params.lenderId, toSnake(body)],
        );
        return { status: 201, body: { id } };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/onboarding/contracts/:id/decision',
      operationId: 'decideLenderContract',
      summary: 'Verify a recorded contract (not the person who recorded it)',
      tags: ['Onboarding'],
      auth: 'staff',
      idempotent: true,
      params: Id,
      body: Decision,
      responses: { 200: Done },
      errors: [400, 401, 403, 404, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params, body }) => {
        await assertCan(tx, 'approve');
        await tx.query('select onboarding.contract_verify($1::uuid, $2::boolean, $3)', [
          params.id,
          body.approve,
          body.note ?? null,
        ]);
        return ok;
      },
    }),

    // ---- engagement scope, services and responsibilities --------------------------------------
    userRoute({
      method: 'get',
      path: '/v1/onboarding/lenders/:lenderId/services',
      operationId: 'listLenderServices',
      summary: 'Udofin engagement scope: services with every version',
      tags: ['Onboarding'],
      auth: 'staff',
      params: Lender,
      responses: { 200: LenderServiceList },
      errors: [401, 403, 404],
      handler: async ({ tx, params }) => {
        await assertCan(tx, 'read', params.lenderId);
        const services = await tx.query<{
          id: string;
          lenderOrgId: string;
          categoryKey: string;
          title: string;
          createdAt: string;
        }>(
          `select ${columns({ id: 'id', lenderOrgId: 'lender_org_id', categoryKey: 'category_key', title: 'title', createdAt: 'created_at::text' })}
             from onboarding.lender_services where lender_org_id = $1::uuid order by created_at, id`,
          [params.lenderId],
        );
        const versions = await tx.query<{ serviceId: string }>(
          `select ${VERSION_COLUMNS} from onboarding.service_versions where lender_org_id = $1::uuid order by version_no desc`,
          [params.lenderId],
        );
        return {
          status: 200,
          body: {
            items: services.rows.map((s) => ({
              ...s,
              versions: versions.rows.filter((v) => v.serviceId === s.id),
            })),
          },
        };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/onboarding/lenders/:lenderId/services',
      operationId: 'createLenderService',
      summary: 'Propose a service (requested scope); nothing is agreed or active yet',
      description:
        'Lenders may state the requested scope and prerequisites; Udofin writes the proposed and agreed scope and the responsibility allocation. "Shared" responsibility requires a written allocation.',
      tags: ['Onboarding'],
      auth: 'staff',
      idempotent: true,
      idempotencyTenant: ({ params }) => params.lenderId,
      params: Lender,
      body: ServiceCreateInput,
      responses: { 201: Created },
      errors: [400, 401, 403, 404, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params, body }) => {
        await assertCan(tx, 'writer', params.lenderId);
        const { categoryKey, title, ...rest } = body;
        const id = await scalar<string>(
          tx,
          'select onboarding.service_create($1::uuid, $2, $3, $4::jsonb) as v',
          [params.lenderId, categoryKey, title, toSnake(rest)],
        );
        return { status: 201, body: { id } };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/onboarding/services/:id/revise',
      operationId: 'reviseLenderService',
      summary: 'Edit the open version, or start a new version of an agreed/live service',
      description:
        'Editing withdraws any acknowledgement. A change to an agreed or live service creates a new proposed version; the live version keeps running until the new one is agreed and activated by independent people.',
      tags: ['Onboarding'],
      auth: 'staff',
      idempotent: true,
      params: Id,
      body: ServiceReviseInput,
      responses: { 200: Created },
      errors: [400, 401, 403, 404, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params, body }) => {
        await assertCan(tx, 'writer', await lenderOf(tx, 'service', params.id));
        const id = await scalar<string>(
          tx,
          'select onboarding.service_revise($1::uuid, $2::jsonb) as v',
          [params.id, toSnake(body)],
        );
        return { status: 200, body: { id } };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/onboarding/service-versions/:id/agree',
      operationId: 'agreeServiceVersion',
      summary: "Record your side's agreement to the final scope",
      description:
        'The lender and Udofin must each agree; the version becomes "agreed" only when both have. Udofin\'s side needs onboarding.approve and no earlier contribution to the version. Agreement does not activate the service.',
      tags: ['Onboarding'],
      auth: 'staff',
      idempotent: true,
      params: Id,
      responses: { 200: z.object({ status: z.string() }) },
      errors: [401, 403, 404, 409],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params }) => {
        await assertCan(tx, 'agree', await lenderOf(tx, 'serviceVersion', params.id));
        const status = await scalar<string>(tx, 'select onboarding.service_agree($1::uuid) as v', [
          params.id,
        ]);
        return { status: 200, body: { status } };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/onboarding/service-versions/:id/activate',
      operationId: 'activateServiceVersion',
      summary: 'Activate an agreed service version (independent approver)',
      tags: ['Onboarding'],
      auth: 'staff',
      idempotent: true,
      params: Id,
      responses: { 200: Done },
      errors: [401, 403, 404, 409],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params }) => {
        await assertCan(tx, 'approve');
        await tx.query('select onboarding.service_activate($1::uuid)', [params.id]);
        return ok;
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/onboarding/service-versions/:id/state',
      operationId: 'changeServiceVersionState',
      summary: 'Suspend, resume or terminate a service version',
      tags: ['Onboarding'],
      auth: 'staff',
      idempotent: true,
      params: Id,
      body: z.strictObject({ to: z.enum(['suspended', 'active', 'terminated']), note }),
      responses: { 200: Done },
      errors: [400, 401, 403, 404, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params, body }) => {
        await assertCan(tx, 'approve');
        await tx.query('select onboarding.service_change_state($1::uuid, $2, $3)', [
          params.id,
          body.to,
          body.note,
        ]);
        return ok;
      },
    }),

    // ---- requirements and dependencies register ------------------------------------------------
    userRoute({
      method: 'get',
      path: '/v1/onboarding/lenders/:lenderId/requirements',
      operationId: 'listLenderRequirements',
      summary: 'What the lender must provide, with status and dependencies',
      tags: ['Onboarding'],
      auth: 'staff',
      params: Lender,
      responses: { 200: RequirementList },
      errors: [401, 403, 404],
      handler: async ({ tx, params }) => {
        await assertCan(tx, 'read', params.lenderId);
        const r = await tx.query(
          `select ${REQUIREMENT_COLUMNS} from onboarding.lender_requirements r where r.lender_org_id = $1::uuid order by r.created_at, r.id`,
          [params.lenderId],
        );
        return { status: 200, body: { items: r.rows } };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/onboarding/lenders/:lenderId/requirements/generate',
      operationId: 'generateLenderRequirements',
      summary: 'Generate the checklist from the templates that apply to this lender',
      description: 'Safe to repeat: existing items are kept and nothing is duplicated.',
      tags: ['Onboarding'],
      auth: 'staff',
      idempotent: true,
      idempotencyTenant: ({ params }) => params.lenderId,
      params: Lender,
      responses: { 200: z.object({ created: z.number().int() }) },
      errors: [401, 403, 404, 409],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params }) => {
        await assertCan(tx, 'manage');
        const created = await scalar<number>(
          tx,
          'select onboarding.requirements_generate($1::uuid) as v',
          [params.lenderId],
        );
        return { status: 200, body: { created } };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/onboarding/lenders/:lenderId/requirements',
      operationId: 'createLenderRequirement',
      summary:
        'Add a requirement for this lender (optionally tied to a service, product or integration)',
      tags: ['Onboarding'],
      auth: 'staff',
      idempotent: true,
      idempotencyTenant: ({ params }) => params.lenderId,
      params: Lender,
      body: z.strictObject({
        title: z.string().trim().min(3).max(200),
        description: z.string().trim().min(1).max(2000).optional(),
        serviceId: z.uuid().optional(),
        productId: z.uuid().optional(),
        integrationId: z.uuid().optional(),
        mandatory: z.boolean().optional(),
        evidenceRequired: z.boolean().optional(),
        dueOn: day.optional(),
      }),
      responses: { 201: Created },
      errors: [400, 401, 403, 404, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params, body }) => {
        await assertCan(tx, 'manage');
        const id = await scalar<string>(
          tx,
          'select onboarding.requirement_create($1::uuid, $2::jsonb) as v',
          [params.lenderId, toSnake(body)],
        );
        return { status: 201, body: { id } };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/onboarding/requirements/:id/status',
      operationId: 'setRequirementStatus',
      summary: 'Move a requirement along its workflow',
      description:
        'Lenders can start and submit their own items; Udofin requests and reviews; an independent approver accepts, rejects, waives or marks not applicable (with a reason). Acceptance is blocked while a dependency is open.',
      tags: ['Onboarding'],
      auth: 'staff',
      idempotent: true,
      params: Id,
      body: z.strictObject({
        to: z.enum([
          'requested',
          'in_progress',
          'submitted',
          'under_review',
          'accepted',
          'rejected',
          'expired',
          'waived',
          'not_applicable',
        ]),
        note: note.optional(),
        evidenceDocumentId: z.uuid().optional(),
      }),
      responses: { 200: Done },
      errors: [400, 401, 403, 404, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params, body }) => {
        await lenderOf(tx, 'requirement', params.id); // 404 unless visible
        await tx.query('select onboarding.requirement_set_status($1::uuid, $2, $3, $4::uuid)', [
          params.id,
          body.to,
          body.note ?? null,
          body.evidenceDocumentId ?? null,
        ]);
        return ok;
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/onboarding/requirements/:id/dependencies',
      operationId: 'addRequirementDependency',
      summary: 'Record that this requirement depends on another one',
      tags: ['Onboarding'],
      auth: 'staff',
      idempotent: true,
      params: Id,
      body: z.strictObject({ dependsOnId: z.uuid() }),
      responses: { 200: Done },
      errors: [400, 401, 403, 404, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params, body }) => {
        await assertCan(tx, 'manage');
        await tx.query('select onboarding.requirement_add_dependency($1::uuid, $2::uuid)', [
          params.id,
          body.dependsOnId,
        ]);
        return ok;
      },
    }),

    // ---- integrations ------------------------------------------------------------------------
    userRoute({
      method: 'get',
      path: '/v1/onboarding/lenders/:lenderId/integrations',
      operationId: 'listLenderIntegrations',
      summary: 'Technical integrations and their test status (no credentials are stored)',
      tags: ['Onboarding'],
      auth: 'staff',
      params: Lender,
      responses: { 200: IntegrationList },
      errors: [401, 403, 404],
      handler: async ({ tx, params }) => {
        await assertCan(tx, 'read', params.lenderId);
        const r = await tx.query(
          `select ${INTEGRATION_COLUMNS} from onboarding.integrations where lender_org_id = $1::uuid order by created_at, id`,
          [params.lenderId],
        );
        return { status: 200, body: { items: r.rows } };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/onboarding/lenders/:lenderId/integrations',
      operationId: 'createLenderIntegration',
      summary: 'Record an integration (API, file transfer or documented manual process)',
      tags: ['Onboarding'],
      auth: 'staff',
      idempotent: true,
      idempotencyTenant: ({ params }) => params.lenderId,
      params: Lender,
      body: z.strictObject({
        kind: z.enum(INTEGRATION_KINDS),
        name: z.string().trim().min(3).max(160),
        purpose: z.string().trim().min(1).max(2000).optional(),
        serviceId: z.uuid().optional(),
        notes: z.string().trim().min(1).max(2000).optional(),
      }),
      responses: { 201: Created },
      errors: [400, 401, 403, 404, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params, body }) => {
        await assertCan(tx, 'writer', params.lenderId);
        const id = await scalar<string>(
          tx,
          'select onboarding.integration_create($1::uuid, $2::jsonb) as v',
          [params.lenderId, toSnake(body)],
        );
        return { status: 201, body: { id } };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/onboarding/integrations/:id/result',
      operationId: 'recordIntegrationResult',
      summary: 'Record a test result (a passing test needs evidence)',
      tags: ['Onboarding'],
      auth: 'staff',
      idempotent: true,
      params: Id,
      body: z.strictObject({
        status: z.enum(['in_progress', 'tested', 'failed']),
        evidenceDocumentId: z.uuid().optional(),
        testedOn: day.optional(),
        note: z.string().trim().min(1).max(2000).optional(),
      }),
      responses: { 200: Done },
      errors: [400, 401, 403, 404, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params, body }) => {
        await assertCan(tx, 'manage');
        await tx.query(
          'select onboarding.integration_record_result($1::uuid, $2, $3::uuid, $4::date, $5)',
          [
            params.id,
            body.status,
            body.evidenceDocumentId ?? null,
            body.testedOn ?? null,
            body.note ?? null,
          ],
        );
        return ok;
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/onboarding/integrations/:id/exception',
      operationId: 'requestIntegrationException',
      summary: 'Request a documented manual exception in place of a passed integration test',
      tags: ['Onboarding'],
      auth: 'staff',
      idempotent: true,
      params: Id,
      body: z.strictObject({ reason: z.string().trim().min(20).max(2000) }),
      responses: { 200: Done },
      errors: [400, 401, 403, 404, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params, body }) => {
        await assertCan(tx, 'manage');
        await tx.query('select onboarding.integration_request_exception($1::uuid, $2)', [
          params.id,
          body.reason,
        ]);
        return ok;
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/onboarding/integrations/:id/exception/decision',
      operationId: 'decideIntegrationException',
      summary: 'Approve or decline a manual exception (not its requester)',
      tags: ['Onboarding'],
      auth: 'staff',
      idempotent: true,
      params: Id,
      body: z.strictObject({ approve: z.boolean() }),
      responses: { 200: Done },
      errors: [400, 401, 403, 404, 409],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params, body }) => {
        await assertCan(tx, 'approve');
        await tx.query('select onboarding.integration_decide_exception($1::uuid, $2::boolean)', [
          params.id,
          body.approve,
        ]);
        return ok;
      },
    }),

    // ---- activation gates --------------------------------------------------------------------
    userRoute({
      method: 'get',
      path: '/v1/onboarding/lenders/:lenderId/gate/conditions',
      operationId: 'getGateConditions',
      summary: 'Which conditions are met for the next gate (or a named target)',
      tags: ['Onboarding'],
      auth: 'staff',
      params: Lender,
      query: z.strictObject({ target: z.enum(GATE_STAGES).optional() }),
      responses: { 200: GateConditions },
      errors: [401, 403, 404, 422],
      handler: async ({ tx, params, query }) => {
        await assertCan(tx, 'read', params.lenderId);
        const gate = await tx.query<{ stage: (typeof GATE_STAGES)[number] }>(
          'select stage from onboarding.lender_gates where lender_org_id = $1::uuid',
          [params.lenderId],
        );
        const stage = gate.rows[0]?.stage;
        if (!stage) throw new ApiError(404, 'not_found', 'Not Found');
        const index = GATE_SEQUENCE.indexOf(stage as (typeof GATE_SEQUENCE)[number]);
        const next = index >= 0 ? GATE_SEQUENCE[index + 1] : undefined;
        const target = query.target ?? next ?? stage;
        const r = await tx.query(
          'select key, satisfied, detail from onboarding.gate_conditions($1::uuid, $2) order by key',
          [params.lenderId, target],
        );
        return {
          status: 200,
          body: {
            lenderOrgId: params.lenderId,
            currentStage: stage,
            targetStage: target,
            items: r.rows,
          },
        };
      },
    }),
    userRoute({
      method: 'get',
      path: '/v1/onboarding/lenders/:lenderId/gate-requests',
      operationId: 'listGateRequests',
      summary: 'The permanent history of gate requests and decisions',
      tags: ['Onboarding'],
      auth: 'staff',
      params: Lender,
      responses: { 200: GateRequestList },
      errors: [401, 403, 404],
      handler: async ({ tx, params }) => {
        await assertCan(tx, 'read', params.lenderId);
        const r = await tx.query(
          `select ${GATE_REQUEST_COLUMNS} from onboarding.gate_requests where lender_org_id = $1::uuid order by requested_at desc, id desc limit 200`,
          [params.lenderId],
        );
        return { status: 200, body: { items: r.rows } };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/onboarding/lenders/:lenderId/gate-requests',
      operationId: 'requestGate',
      summary: 'Ask for the lender to move to the next stage (or suspend, deactivate, terminate)',
      description:
        'One step at a time and only when the conditions are met. Another person with onboarding.approve must decide.',
      tags: ['Onboarding'],
      auth: 'staff',
      idempotent: true,
      idempotencyTenant: ({ params }) => params.lenderId,
      params: Lender,
      body: z.strictObject({
        targetStage: z.enum(
          GATE_STAGES.filter((s) => s !== 'profile_created') as [string, ...string[]],
        ),
        note: note.optional(),
      }),
      responses: { 201: GateRequest },
      errors: [400, 401, 403, 404, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params, body }) => {
        await assertCan(tx, 'manage');
        const id = await scalar<string>(
          tx,
          'select onboarding.gate_request($1::uuid, $2, $3) as v',
          [params.lenderId, body.targetStage, body.note ?? null],
        );
        const r = await tx.query(
          `select ${GATE_REQUEST_COLUMNS} from onboarding.gate_requests where id = $1::uuid`,
          [id],
        );
        return { status: 201, body: r.rows[0] };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/onboarding/gate-requests/:id/decision',
      operationId: 'decideGateRequest',
      summary: 'Approve or reject a gate request (not its requester)',
      description: 'The conditions are checked again at decision time.',
      tags: ['Onboarding'],
      auth: 'staff',
      idempotent: true,
      params: Id,
      body: Decision,
      responses: { 200: StageResult },
      errors: [400, 401, 403, 404, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params, body }) => {
        await assertCan(tx, 'approve');
        const stage = await scalar<(typeof GATE_STAGES)[number]>(
          tx,
          'select onboarding.gate_decide($1::uuid, $2::boolean, $3) as v',
          [params.id, body.approve, body.note ?? null],
        );
        return { status: 200, body: { stage } };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/onboarding/gate-requests/:id/cancel',
      operationId: 'cancelGateRequest',
      summary: 'Withdraw your own pending gate request',
      tags: ['Onboarding'],
      auth: 'staff',
      idempotent: true,
      params: Id,
      responses: { 200: Done },
      errors: [401, 403, 404],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params }) => {
        await assertCan(tx, 'manage');
        await tx.query('select onboarding.gate_cancel($1::uuid)', [params.id]);
        return ok;
      },
    }),
  ];
}
