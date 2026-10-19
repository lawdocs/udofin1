import { createHash, randomUUID } from 'node:crypto';
import { type DocumentStore } from '@udofin/adapters';
import {
  AcceptInput,
  AcceptResult,
  AcknowledgeInput,
  AcknowledgeResult,
  ApplicabilityRuleList,
  ApplicationDocuments,
  ApproveInput,
  CalendarDecision,
  CalendarList,
  CalendarProposal,
  Created,
  DeliveryInput,
  DeliveryList,
  DeliveryRequested,
  DocumentDone,
  DocumentEventList,
  GenerationRequest,
  GenerationResult,
  IssueResult,
  IssuedDocumentContent,
  KfsDataResult,
  KfsDataSubmission,
  KfsUploadInput,
  KfsView,
  LenderDocumentList,
  LenderKfsInputList,
  ReasonInput,
  RuleDecision,
  RuleProposal,
  SelfApprovalInput,
  SigningStarted,
  SigningStatusView,
  TemplateComplianceDecision,
  TemplateList,
  TemplateProposal,
} from '@udofin/contracts';
import { z } from 'zod';
import { ApiError } from '../../http/api-error.js';
import { userRoute, type RouteDefinition } from '../../http/routes.js';
import { assertUploadAllowed } from '../../http/upload-safety.js';

/** Which signing provider mode the API asks the database to start; the database decides whether it is allowed. */
export interface SigningMode {
  providerKey: string;
  mode: 'mock' | 'sandbox' | 'live';
}

const WRITE_LIMIT = { max: 60, timeWindow: '1 minute' };
const READ_LIMIT = { max: 120, timeWindow: '1 minute' };
const OPEN_LIMIT = { max: 60, timeWindow: '1 minute' };
const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;
const Id = z.strictObject({ id: z.uuid() });
const LanguageQuery = z.strictObject({ language: z.enum(['en', 'hi']).default('en') });
const OpenQuery = z.strictObject({ purpose: z.enum(['view', 'download']).default('view') });
const ListQuery = z.strictObject({
  applicationId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

type Tx = Parameters<Parameters<typeof userRoute>[0]['handler']>[0]['tx'];

/** Row-level security hides other people's rows; these make "not yours" an explicit 404 or 403 rather than an empty list. */
async function requireDocumentVisible(tx: Tx, id: string): Promise<void> {
  const r = await tx.query('select 1 from documents.items where id = $1::uuid', [id]);
  if (r.rows.length === 0) throw new ApiError(404, 'not_found', 'Not Found');
}
async function requirePlatform(tx: Tx): Promise<void> {
  const r = await tx.query<{ ok: boolean }>(
    "select private.has_platform_permission('platform.documents.manage') as ok",
  );
  if (!r.rows[0]?.ok) throw new ApiError(403, 'forbidden', 'Forbidden');
}

const first = <T>(rows: { r: T }[]): T => {
  const row = rows[0];
  if (!row) throw new Error('database function returned nothing');
  return row.r;
};

/** ISO text of a timestamp column, for JSON responses. */
const ts = (column: string) => `(to_jsonb(${column}) #>> '{}')`;

const LENDER_DOCUMENT_COLUMNS = `
  id, document_type as "documentType", version, language, application_id as "applicationId", offer_id as "offerId",
  proposal_no as "proposalNo", source_mode as "sourceMode", approval_status as "approvalStatus", issuance_status as "issuanceStatus",
  sha256, ${ts('generated_at')} as "generatedAt", ${ts('kfs_valid_until')} as "kfsValidUntil", ${ts('issued_at')} as "issuedAt",
  supersedes_id as "supersedesId"`;

/**
 * KFS data, lender-approved documents, acknowledgement, offer acceptance, signing and delivery. Every rule lives in the
 * database functions: routes validate shape, take the caller from the token and pass identifiers. Documents are returned
 * only after the database has authorised the caller, and each retrieval is recorded without its content.
 */
export function documentRoutes(
  documents: DocumentStore | undefined,
  signing: SigningMode | undefined,
): RouteDefinition[] {
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

  const open = async (
    tx: Parameters<Parameters<typeof userRoute>[0]['handler']>[0]['tx'],
    id: string,
    purpose: 'view' | 'download',
  ) => {
    const store = requireStore();
    const r = await tx.query<{
      r: {
        documentId: string;
        storageKey: string;
        sha256: string;
        documentType: string;
        version: number;
      };
    }>('select documents.open_document($1::uuid, $2) as r', [id, purpose]);
    const meta = first(r.rows);
    const object = await store.get(meta.storageKey);
    if (!object) throw new ApiError(404, 'not_found', 'Not Found');
    const actual = createHash('sha256').update(object.bytes).digest('hex');
    if (actual !== meta.sha256)
      throw new Error('stored document does not match its recorded checksum');
    return {
      status: 200,
      headers: { 'cache-control': 'no-store' },
      body: {
        documentId: meta.documentId,
        documentType: meta.documentType,
        version: meta.version,
        mimeType: 'application/pdf' as const,
        sha256: meta.sha256,
        contentBase64: Buffer.from(object.bytes).toString('base64'),
      },
    };
  };

  return [
    // ---- borrower ---------------------------------------------------------------------------------------------------
    userRoute({
      method: 'get',
      path: '/v1/applications/:id/documents',
      operationId: 'getApplicationDocuments',
      summary:
        'The current offer, its KFS, acknowledgement, acceptance, agreement, signing state and every issued document',
      description:
        'Only documents the lender has issued are listed; drafts are never visible to the borrower. Offer validity and KFS validity are separate fields.',
      tags: ['Documents'],
      auth: 'borrower',
      params: Id,
      responses: { 200: ApplicationDocuments },
      errors: [401, 403, 404],
      rateLimit: READ_LIMIT,
      handler: async ({ tx, params }) => {
        const r = await tx.query<{ r: unknown }>(
          'select documents.application_documents($1::uuid) as r',
          [params.id],
        );
        return { status: 200, body: first(r.rows) };
      },
    }),
    userRoute({
      method: 'get',
      path: '/v1/documents/:id/kfs',
      operationId: 'getKfsView',
      summary:
        "The KFS as readable sections (the lender's own figures, unchanged) and the current acknowledgement wording",
      description:
        "The wording is offered in the borrower's language only if an approved translation exists; otherwise the approved English wording is returned and labelled as a fallback.",
      tags: ['Documents'],
      auth: 'borrower',
      params: Id,
      query: LanguageQuery,
      responses: { 200: KfsView },
      errors: [401, 403, 404],
      rateLimit: READ_LIMIT,
      handler: async ({ tx, params, query }) => {
        const r = await tx.query<{ r: unknown }>('select documents.kfs_view($1::uuid, $2) as r', [
          params.id,
          query.language,
        ]);
        return { status: 200, body: first(r.rows) };
      },
    }),
    userRoute({
      method: 'get',
      path: '/v1/documents/:id/content',
      operationId: 'downloadDocument',
      summary: 'Retrieve an issued document (the exact stored file; every retrieval is recorded)',
      description:
        'Authorised owners only. The response is not cached. There is no permanent or public link to a document.',
      tags: ['Documents'],
      auth: 'borrower',
      params: Id,
      query: OpenQuery,
      responses: { 200: IssuedDocumentContent },
      errors: [401, 403, 404, 503],
      rateLimit: OPEN_LIMIT,
      handler: ({ tx, params, query }) => open(tx, params.id, query.purpose),
    }),
    userRoute({
      method: 'post',
      path: '/v1/documents/:id/acknowledge',
      operationId: 'acknowledgeKfs',
      summary: "Record the borrower's explicit acknowledgement of the KFS",
      description:
        'Needs an explicit action on approved, current wording, after the file was opened and every required section was shown. A download or a screen change is not an acknowledgement.',
      tags: ['Documents'],
      auth: 'borrower',
      idempotent: true,
      params: Id,
      body: AcknowledgeInput,
      responses: { 200: AcknowledgeResult },
      errors: [400, 401, 403, 404, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params, body, idempotencyKey }) => {
        const r = await tx.query<{ r: unknown }>(
          'select documents.acknowledge($1::uuid, $2::uuid, $3::text[], $4, $5, $6, $7, $8) as r',
          [
            params.id,
            body.noticeId,
            body.sections,
            body.action,
            body.explanationVersion,
            body.channel,
            body.appVersion ?? null,
            idempotencyKey ?? null,
          ],
        );
        return { status: 200, body: first(r.rows) };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/offers/:id/accept',
      operationId: 'acceptOffer',
      summary: 'Accept this offer revision (needs a verified one-time code for this offer)',
      description:
        'Acceptance is not a signature and not a disbursement. The agreement is prepared afterwards as a separate step. A code verified for another offer, revision or action is refused.',
      tags: ['Documents'],
      auth: 'borrower',
      idempotent: true,
      params: Id,
      body: AcceptInput,
      responses: { 200: AcceptResult },
      errors: [400, 401, 403, 404, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params, body, idempotencyKey }) => {
        const r = await tx.query<{ r: unknown }>(
          'select documents.accept_offer($1::uuid, $2::uuid, $3::uuid, $4) as r',
          [params.id, body.kfsDocumentId, body.acknowledgementId, idempotencyKey ?? null],
        );
        return { status: 200, body: first(r.rows) };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/agreements/:id/signing',
      operationId: 'startSigning',
      summary:
        'Start electronic signing of the agreement (unavailable until a provider and legal method are approved)',
      description:
        'Needs a verified one-time code for this agreement. The code only authorises the start; it is not the signature. Without an approved provider the answer is signing_not_available.',
      tags: ['Documents'],
      auth: 'borrower',
      idempotent: true,
      params: Id,
      responses: { 200: SigningStarted },
      errors: [400, 401, 403, 404, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params, idempotencyKey }) => {
        const r = await tx.query<{ r: unknown }>(
          'select documents.start_signing($1::uuid, $2, $3, $4) as r',
          [
            params.id,
            signing?.providerKey ?? 'none',
            signing?.mode ?? 'none',
            idempotencyKey ?? null,
          ],
        );
        return { status: 200, body: first(r.rows) };
      },
    }),
    userRoute({
      method: 'get',
      path: '/v1/agreements/:id/signing',
      operationId: 'getSigningStatus',
      summary: 'Where signing of this agreement stands, as the provider reported it',
      tags: ['Documents'],
      auth: 'borrower',
      params: Id,
      responses: { 200: SigningStatusView },
      errors: [401, 403, 404],
      rateLimit: READ_LIMIT,
      handler: async ({ tx, params }) => {
        const r = await tx.query(
          `select s.id as "requestId", s.state, s.provider_mode as "providerMode", ${ts('s.updated_at')} as "updatedAt", ${ts('s.executed_at')} as "executedAt",
                  coalesce((select jsonb_agg(jsonb_build_object('toState', e.to_state, 'occurredAt', ${ts('e.occurred_at')}) order by e.occurred_at)
                              from documents.signing_events e where e.request_id = s.id), '[]'::jsonb) as events
             from documents.signing_requests s where s.document_id = $1::uuid order by s.requested_at desc limit 1`,
          [params.id],
        );
        if (!r.rows[0]) throw new ApiError(404, 'not_found', 'Not Found');
        return { status: 200, body: r.rows[0] };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/documents/:id/delivery',
      operationId: 'requestDocumentDelivery',
      summary: 'Ask for a content-free notice that the documents are ready',
      description:
        'The notice carries no document, amount or link. Provider acceptance is recorded as exactly that, never as delivery. Email is not configured: no verified address is held.',
      tags: ['Documents'],
      auth: 'borrower',
      idempotent: true,
      params: Id,
      body: DeliveryInput,
      responses: { 200: DeliveryRequested },
      errors: [400, 401, 403, 404, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params, body }) => {
        const r = await tx.query<{ r: unknown }>(
          'select documents.request_delivery($1::uuid, $2) as r',
          [params.id, body.channel],
        );
        return { status: 200, body: first(r.rows) };
      },
    }),
    userRoute({
      method: 'get',
      path: '/v1/documents/:id/deliveries',
      operationId: 'listDocumentDeliveries',
      summary: 'Delivery attempts and their recorded results for one document',
      tags: ['Documents'],
      auth: 'borrower',
      params: Id,
      responses: { 200: DeliveryList },
      errors: [401, 403, 404],
      rateLimit: READ_LIMIT,
      handler: async ({ tx, params }) => {
        await requireDocumentVisible(tx, params.id);
        const r = await tx.query(
          `select id as "deliveryId", channel, status, failure_class as "failureClass", ${ts('requested_at')} as "requestedAt", ${ts('updated_at')} as "updatedAt"
             from documents.deliveries where document_id = $1::uuid order by requested_at desc, id desc`,
          [params.id],
        );
        return { status: 200, body: { items: r.rows } };
      },
    }),

    // ---- lender -----------------------------------------------------------------------------------------------------
    userRoute({
      method: 'post',
      path: '/v1/lender/offers/:id/kfs-data',
      operationId: 'submitKfsData',
      summary:
        'Submit the KFS facts for an offer revision (or declare the facts of a KFS file you issued yourself)',
      description:
        'Udofin checks structure and flags figures that differ from your offer; it never changes, rounds or recalculates anything. A held submission is never rendered.',
      tags: ['Documents (lender)'],
      auth: 'staff',
      idempotent: true,
      params: Id,
      body: KfsDataSubmission,
      responses: { 201: KfsDataResult },
      errors: [400, 401, 403, 404, 409, 422],
      rateLimit: WRITE_LIMIT,
      bodyLimit: 1_000_000,
      handler: async ({ tx, params, body }) => {
        const r = await tx.query<{ r: unknown }>(
          'select documents.submit_kfs_data($1::uuid, $2::jsonb, $3) as r',
          [params.id, JSON.stringify(body.data), body.mode],
        );
        return { status: 201, body: first(r.rows) };
      },
    }),
    userRoute({
      method: 'get',
      path: '/v1/lender/offers/:id/kfs-data',
      operationId: 'listKfsData',
      summary: 'KFS data submissions for an offer revision and their validation outcome',
      tags: ['Documents (lender)'],
      auth: 'staff',
      params: Id,
      responses: { 200: LenderKfsInputList },
      errors: [401, 403, 404],
      rateLimit: READ_LIMIT,
      handler: async ({ tx, params }) => {
        const r = await tx.query(
          `select id, offer_id as "offerId", package_version as "packageVersion", mode, validation, issues, ${ts('submitted_at')} as "submittedAt"
             from documents.kfs_inputs where offer_id = $1::uuid order by package_version desc`,
          [params.id],
        );
        return { status: 200, body: { items: r.rows } };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/lender/offers/:id/generation',
      operationId: 'requestDocumentGeneration',
      summary:
        'Prepare a draft document from accepted KFS data (the same request returns the same job)',
      description:
        'The draft is not approved and not issued. Preconditions (lender and product active, offer current, approved rule and template, working-day calendar) are checked now and again when the job runs.',
      tags: ['Documents (lender)'],
      auth: 'staff',
      idempotent: true,
      params: Id,
      body: GenerationRequest,
      responses: { 202: GenerationResult },
      errors: [400, 401, 403, 404, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params, body }) => {
        const r = await tx.query<{ r: unknown }>(
          'select documents.request_generation($1::uuid, $2, $3::uuid, $4) as r',
          [params.id, body.language, body.inputId, body.documentType],
        );
        return { status: 202, body: first(r.rows) };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/lender/offers/:id/kfs-upload',
      operationId: 'uploadKfsFile',
      summary:
        'Register a KFS file you produced yourself (PDF, at most 8 MiB) against facts you declared',
      description:
        'The file is stored privately under an opaque key and hashed. It still needs approval and issuance, and the same acknowledgement and acceptance rules apply.',
      tags: ['Documents (lender)'],
      auth: 'staff',
      idempotent: true,
      params: Id,
      body: KfsUploadInput,
      responses: { 201: Created },
      errors: [400, 401, 403, 404, 409, 413, 422, 503],
      rateLimit: { max: 20, timeWindow: '1 minute' },
      bodyLimit: 12_000_000,
      handler: async ({ tx, params, body }) => {
        const store = requireStore();
        const bytes = Buffer.from(body.contentBase64, 'base64');
        if (bytes.length === 0 || bytes.length > MAX_DOCUMENT_BYTES)
          throw new ApiError(413, 'document_too_large', 'Content Too Large');
        // A file that is not a PDF, or whose PDF names active content, is never stored: the second
        // approver and the borrower would open it. Same check as the onboarding evidence upload.
        assertUploadAllowed(bytes, 'application/pdf');
        // Authorise (tenant, permission, step-up) before any byte is written to the store.
        await tx.query('select documents.assert_can_prepare($1::uuid)', [params.id]);
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        const key = `documents/${randomUUID()}`;
        await store.put(key, bytes, { mimeType: 'application/pdf', sha256 });
        try {
          const r = await tx.query<{ r: string }>(
            'select documents.register_upload($1::uuid, $2::uuid, $3, $4, $5::bigint) as r',
            [params.id, body.inputId, key, sha256, bytes.length],
          );
          return { status: 201, body: { id: first(r.rows) } };
        } catch (error) {
          // An orphan is possible only if this delete also fails; the key is random and unreferenced, never served.
          await store.delete(key).catch(() => undefined);
          throw error;
        }
      },
    }),
    userRoute({
      method: 'get',
      path: '/v1/lender/documents',
      operationId: 'listLenderDocuments',
      summary: 'Documents of your applications (drafts included), newest first',
      tags: ['Documents (lender)'],
      auth: 'staff',
      query: ListQuery,
      responses: { 200: LenderDocumentList },
      errors: [400, 401, 403, 422],
      rateLimit: READ_LIMIT,
      handler: async ({ tx, query }) => {
        const r = await tx.query(
          `select ${LENDER_DOCUMENT_COLUMNS} from documents.items
            where ($1::uuid is null or application_id = $1::uuid) order by generated_at desc, id desc limit $2`,
          [query.applicationId ?? null, query.limit],
        );
        return { status: 200, body: { items: r.rows } };
      },
    }),
    userRoute({
      method: 'get',
      path: '/v1/lender/documents/:id/content',
      operationId: 'downloadLenderDocument',
      summary: 'Retrieve the exact file of a document of your application (recorded)',
      tags: ['Documents (lender)'],
      auth: 'staff',
      params: Id,
      query: OpenQuery,
      responses: { 200: IssuedDocumentContent },
      errors: [401, 403, 404, 503],
      rateLimit: OPEN_LIMIT,
      handler: ({ tx, params, query }) => open(tx, params.id, query.purpose),
    }),
    userRoute({
      method: 'get',
      path: '/v1/lender/documents/:id/history',
      operationId: 'getLenderDocumentHistory',
      summary: 'Every step recorded for one document',
      tags: ['Documents (lender)'],
      auth: 'staff',
      params: Id,
      responses: { 200: DocumentEventList },
      errors: [401, 403, 404],
      rateLimit: READ_LIMIT,
      handler: async ({ tx, params }) => {
        await requireDocumentVisible(tx, params.id);
        const r = await tx.query(
          `select event, actor, ${ts('occurred_at')} as "occurredAt" from documents.item_events where document_id = $1::uuid order by occurred_at, id`,
          [params.id],
        );
        return { status: 200, body: { items: r.rows } };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/lender/documents/:id/approve',
      operationId: 'approveLenderDocument',
      summary: 'Approve the exact file you reviewed (by its SHA-256)',
      description:
        'Nothing is issued without this. The person who prepared the document cannot approve it unless platform staff allowed that for your organisation.',
      tags: ['Documents (lender)'],
      auth: 'staff',
      idempotent: true,
      params: Id,
      body: ApproveInput,
      responses: { 200: DocumentDone },
      errors: [400, 401, 403, 404, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params, body }) => {
        await tx.query('select documents.approve_document($1::uuid, $2)', [params.id, body.sha256]);
        return { status: 200, body: { ok: true as const } };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/lender/documents/:id/reject',
      operationId: 'rejectLenderDocument',
      summary: 'Reject a draft document',
      tags: ['Documents (lender)'],
      auth: 'staff',
      idempotent: true,
      params: Id,
      body: ReasonInput,
      responses: { 200: DocumentDone },
      errors: [400, 401, 403, 404, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params, body }) => {
        await tx.query('select documents.reject_document($1::uuid, $2)', [params.id, body.reason]);
        return { status: 200, body: { ok: true as const } };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/lender/documents/:id/issue',
      operationId: 'issueLenderDocument',
      summary: 'Issue an approved document to the borrower',
      description:
        'A KFS can be issued only while its window still covers the minimum counted from now; otherwise prepare it again. The previous issued version is superseded and stays on record.',
      tags: ['Documents (lender)'],
      auth: 'staff',
      idempotent: true,
      params: Id,
      responses: { 200: IssueResult },
      errors: [400, 401, 403, 404, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params }) => {
        const r = await tx.query<{ r: unknown }>('select documents.issue_document($1::uuid) as r', [
          params.id,
        ]);
        return { status: 200, body: first(r.rows) };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/lender/documents/:id/withdraw',
      operationId: 'withdrawLenderDocument',
      summary: 'Withdraw a draft or issued document (not after the offer was accepted)',
      tags: ['Documents (lender)'],
      auth: 'staff',
      idempotent: true,
      params: Id,
      body: ReasonInput,
      responses: { 200: DocumentDone },
      errors: [400, 401, 403, 404, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params, body }) => {
        await tx.query('select documents.withdraw_document($1::uuid, $2)', [
          params.id,
          body.reason,
        ]);
        return { status: 200, body: { ok: true as const } };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/lender/templates',
      operationId: 'proposeLenderTemplate',
      summary: 'Propose your own approved wording (agreement text, terms) as a template',
      description:
        'Udofin writes no lender legal text. A template needs your approval and compliance approval before it can be used.',
      tags: ['Documents (lender)'],
      auth: 'staff',
      idempotent: true,
      body: TemplateProposal,
      responses: { 201: Created },
      errors: [400, 401, 403, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, body }) => {
        if (!body.lenderId)
          throw new ApiError(
            422,
            'validation_failed',
            'Unprocessable Content',
            'lenderId: required',
          );
        const r = await tx.query<{ r: string }>(
          'select documents.propose_template($1, $2, $3, $4::uuid, $5::jsonb, false) as r',
          [
            body.templateKey,
            body.documentType,
            body.language,
            body.lenderId,
            JSON.stringify(body.body),
          ],
        );
        return { status: 201, body: { id: first(r.rows) } };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/lender/templates/:id/approve',
      operationId: 'approveLenderTemplate',
      summary: 'Approve the wording that carries your name (a different person from the proposer)',
      tags: ['Documents (lender)'],
      auth: 'staff',
      idempotent: true,
      params: Id,
      responses: { 200: DocumentDone },
      errors: [400, 401, 403, 404, 409],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params }) => {
        await tx.query('select documents.approve_template_lender($1::uuid)', [params.id]);
        return { status: 200, body: { ok: true as const } };
      },
    }),

    // ---- platform (compliance) ----------------------------------------------------------------------------------------
    userRoute({
      method: 'get',
      path: '/v1/platform/document-rules',
      operationId: 'listApplicabilityRules',
      summary: 'Regulatory applicability rules and their approval status',
      description:
        'A draft rule is never used. No rule exists for banks, UCBs or other lender types until their own text is read and approved.',
      tags: ['Documents (platform)'],
      auth: 'staff',
      responses: { 200: ApplicabilityRuleList },
      errors: [401, 403],
      rateLimit: READ_LIMIT,
      handler: async ({ tx }) => {
        await requirePlatform(tx);
        const r = await tx.query(
          `select id, rule_key as "ruleKey", version, lender_category_keys as "lenderCategoryKeys", regulator, direction_ref as "directionRef",
                  paragraph_refs as "paragraphRefs", product_category_keys as "productCategoryKeys", exclusions, document_type as "documentType",
                  required_template_key as "requiredTemplateKey", approval_status as "approvalStatus", evidence_status as "evidenceStatus",
                  reviewer_ref as "reviewerRef", ${ts('effective_from')} as "effectiveFrom", ${ts('effective_to')} as "effectiveTo"
             from documents.applicability_rules order by rule_key, version desc`,
        );
        return { status: 200, body: { items: r.rows } };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/platform/document-rules',
      operationId: 'proposeApplicabilityRule',
      summary: 'Propose a rule version (for review; it is not usable until approved)',
      tags: ['Documents (platform)'],
      auth: 'staff',
      idempotent: true,
      body: RuleProposal,
      responses: { 201: Created },
      errors: [400, 401, 403, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, body }) => {
        const r = await tx.query<{ r: string }>('select documents.propose_rule($1::jsonb) as r', [
          JSON.stringify(body),
        ]);
        return { status: 201, body: { id: first(r.rows) } };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/platform/document-rules/:id/decision',
      operationId: 'decideApplicabilityRule',
      summary:
        'Approve or reject a rule (a different person from the proposer; the reviewer is named, never invented)',
      tags: ['Documents (platform)'],
      auth: 'staff',
      idempotent: true,
      params: Id,
      body: RuleDecision,
      responses: { 200: DocumentDone },
      errors: [400, 401, 403, 404, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params, body }) => {
        await tx.query('select documents.decide_rule($1::uuid, $2, $3)', [
          params.id,
          body.approve,
          body.reviewerRef ?? null,
        ]);
        return { status: 200, body: { ok: true as const } };
      },
    }),
    userRoute({
      method: 'get',
      path: '/v1/platform/document-templates',
      operationId: 'listDocumentTemplates',
      summary: 'Templates and their approval status',
      tags: ['Documents (platform)'],
      auth: 'staff',
      responses: { 200: TemplateList },
      errors: [401, 403],
      rateLimit: READ_LIMIT,
      handler: async ({ tx }) => {
        await requirePlatform(tx);
        const r = await tx.query(
          `select id, template_key as "templateKey", document_type as "documentType", language, lender_org_id as "lenderId", version, status,
                  is_sample as "isSample", ${ts('lender_approved_at')} as "lenderApprovedAt", ${ts('compliance_approved_at')} as "complianceApprovedAt",
                  compliance_reviewer_ref as "complianceReviewerRef"
             from documents.templates order by template_key, language, version desc limit 200`,
        );
        return { status: 200, body: { items: r.rows } };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/platform/document-templates/:id/compliance-approval',
      operationId: 'approveTemplateCompliance',
      summary:
        'Compliance approval of a template (the reviewer is named; a different person from the proposer)',
      tags: ['Documents (platform)'],
      auth: 'staff',
      idempotent: true,
      params: Id,
      body: TemplateComplianceDecision,
      responses: { 200: DocumentDone },
      errors: [400, 401, 403, 404, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params, body }) => {
        await tx.query('select documents.approve_template_compliance($1::uuid, $2)', [
          params.id,
          body.reviewerRef,
        ]);
        return { status: 200, body: { ok: true as const } };
      },
    }),
    userRoute({
      method: 'get',
      path: '/v1/platform/document-calendars',
      operationId: 'listWorkingDayCalendars',
      summary: 'Working-day calendars per lender and their approval status',
      tags: ['Documents (platform)'],
      auth: 'staff',
      responses: { 200: CalendarList },
      errors: [401, 403],
      rateLimit: READ_LIMIT,
      handler: async ({ tx }) => {
        await requirePlatform(tx);
        const r = await tx.query(
          `select id, lender_org_id as "lenderId", name, weekly_off as "weeklyOff", ${ts('covered_from')} as "coveredFrom", ${ts('covered_to')} as "coveredTo",
                  status, lender_confirmation_ref as "lenderConfirmationRef"
             from documents.calendars order by lender_org_id, created_at desc limit 200`,
        );
        return { status: 200, body: { items: r.rows } };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/platform/document-calendars',
      operationId: 'proposeWorkingDayCalendar',
      summary: "Propose a lender's working-day calendar",
      tags: ['Documents (platform)'],
      auth: 'staff',
      idempotent: true,
      body: CalendarProposal,
      responses: { 201: Created },
      errors: [400, 401, 403, 404, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, body }) => {
        const r = await tx.query<{ r: string }>(
          'select documents.propose_calendar($1::uuid, $2, $3::int[], $4::date, $5::date, $6::jsonb) as r',
          [
            body.lenderId,
            body.name,
            body.weeklyOff,
            body.coveredFrom,
            body.coveredTo,
            JSON.stringify(body.exceptions),
          ],
        );
        return { status: 201, body: { id: first(r.rows) } };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/platform/document-calendars/:id/decision',
      operationId: 'decideWorkingDayCalendar',
      summary:
        "Approve or retire a calendar (needs the lender's confirmation reference; a different person from the proposer)",
      tags: ['Documents (platform)'],
      auth: 'staff',
      idempotent: true,
      params: Id,
      body: CalendarDecision,
      responses: { 200: DocumentDone },
      errors: [400, 401, 403, 404, 409, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params, body }) => {
        await tx.query('select documents.decide_calendar($1::uuid, $2, $3)', [
          params.id,
          body.approve,
          body.lenderConfirmationRef ?? null,
        ]);
        return { status: 200, body: { ok: true as const } };
      },
    }),
    userRoute({
      method: 'post',
      path: '/v1/platform/lenders/:id/document-self-approval',
      operationId: 'setDocumentSelfApproval',
      summary: 'Allow or forbid the preparer of a document to approve it too (default: forbidden)',
      tags: ['Documents (platform)'],
      auth: 'staff',
      idempotent: true,
      params: Id,
      body: SelfApprovalInput,
      responses: { 200: DocumentDone },
      errors: [400, 401, 403, 404, 422],
      rateLimit: WRITE_LIMIT,
      handler: async ({ tx, params, body }) => {
        await tx.query('select documents.set_self_approval($1::uuid, $2)', [
          params.id,
          body.allowed,
        ]);
        return { status: 200, body: { ok: true as const } };
      },
    }),
  ];
}
