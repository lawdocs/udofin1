import {
  BorrowerCategoryList,
  BorrowerMe,
  BorrowerProductList,
  DeletionCurrent,
  IntegrityNonce,
  IntegrityResult,
  LoanPurposeList,
  LoanRequestDetail,
  LoanRequestPage,
  LoanRequestVersion,
  NoticeList,
  StepUpStarted,
  StepUpVerified,
  SubmitResult,
  type STEPUP_ACTIONS,
} from '@udofin/contracts';
import { type ApiClient, type ApiResult } from '@udofin/auth-client';
import {
  AcceptResult,
  AcknowledgeResult,
  ApplicationDocuments,
  BorrowerApplicationList,
  Comparison,
  DeliveryList,
  DeliveryRequested,
  IssuedDocumentContent,
  KfsView,
  SigningStarted,
  SigningStatusView,
  MatchingLenderList,
  RouteResult,
  SelectionCreated,
  SelectionView,
  type COMPARISON_SORTS,
  type PLATFORMS,
} from '@udofin/contracts';
import { z } from 'zod';
import { type Language } from '../i18n';
import { newIdempotencyKey } from './form';

const Ok = z.object({ ok: z.literal(true) });
const Created = z.object({ id: z.uuid() });

export interface RequestInput {
  categoryKey: string;
  amountMinor: number;
  tenureDays: number;
  purposeCode: string;
  productVersionId?: string;
}

/**
 * Typed borrower calls. Writes carry an Idempotency-Key; callers that may retry (submit) pass the same
 * key for the same intent. Nothing here contains personal data in a URL: identifiers are opaque ids.
 */
export function createBorrowerClient(api: ApiClient) {
  const key = (explicit?: string) => explicit ?? newIdempotencyKey();
  return {
    me: (): Promise<ApiResult<BorrowerMe>> => api.get('/v1/borrower/me', BorrowerMe),
    updateProfile: (
      body: { displayName?: string | null; preferredLanguage?: Language },
      idempotencyKey?: string,
    ) => api.post('/v1/borrower/profile', Ok, body, key(idempotencyKey)),
    completeProfile: () => api.post('/v1/borrower/profile/complete', Ok, {}, key()),
    setServiceSms: (serviceUpdatesSms: boolean) =>
      api.post('/v1/borrower/preferences', Ok, { serviceUpdatesSms }, key()),

    notices: (language: Language) =>
      api.get(`/v1/consent/notices?language=${language}`, NoticeList),
    decide: (noticeId: string, decision: 'granted' | 'denied' | 'withdrawn', appVersion: string) =>
      api.post(
        '/v1/consent/decisions',
        Created,
        { noticeId, decision, screen: 'consent', appVersion },
        key(),
      ),

    purposes: (language: Language) =>
      api.get(`/v1/loan-purposes?language=${language}`, LoanPurposeList),
    categories: () => api.get('/v1/borrower/categories', BorrowerCategoryList),
    products: () => api.get('/v1/borrower/products', BorrowerProductList),

    createRequest: (input: RequestInput, idempotencyKey?: string) =>
      api.post('/v1/loan-requests', LoanRequestVersion, input, key(idempotencyKey)),
    updateDraft: (
      id: string,
      patch: {
        expectedVersion: number;
        amountMinor?: number;
        tenureDays?: number;
        purposeCode?: string;
        productVersionId?: string;
        clearProduct?: boolean;
      },
    ) =>
      api.post(
        `/v1/loan-requests/${encodeURIComponent(id)}/draft`,
        LoanRequestVersion,
        patch,
        key(),
      ),
    submit: (id: string, expectedVersion: number, idempotencyKey: string) =>
      api.post(
        `/v1/loan-requests/${encodeURIComponent(id)}/submit`,
        SubmitResult,
        { expectedVersion },
        idempotencyKey,
      ),
    withdraw: (id: string, expectedVersion: number) =>
      api.post(
        `/v1/loan-requests/${encodeURIComponent(id)}/withdraw`,
        Ok,
        { expectedVersion },
        key(),
      ),
    listRequests: (cursor?: string) =>
      api.get(
        `/v1/loan-requests?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        LoanRequestPage,
      ),
    request: (id: string) =>
      api.get(`/v1/loan-requests/${encodeURIComponent(id)}`, LoanRequestDetail),

    startStepUp: (action: (typeof STEPUP_ACTIONS)[number], contextRef: string) =>
      api.post('/v1/stepup/challenges', StepUpStarted, { action, contextRef }, key()),
    verifyStepUp: (challengeId: string, code: string) =>
      api.post(
        `/v1/stepup/challenges/${encodeURIComponent(challengeId)}/verify`,
        StepUpVerified,
        { code },
        key(),
      ),

    integrityNonce: () => api.post('/v1/integrity/nonce', IntegrityNonce, {}, key()),
    verifyIntegrity: (token: string, nonce: string) =>
      api.post('/v1/integrity/verify', IntegrityResult, { token, nonce }, key()),

    matchingLenders: (requestId: string) =>
      api.get(`/v1/loan-requests/${encodeURIComponent(requestId)}/lenders`, MatchingLenderList),
    selectLenders: (requestId: string, items: { lenderId: string; productVersionId?: string }[]) =>
      api.post(
        `/v1/loan-requests/${encodeURIComponent(requestId)}/selection`,
        SelectionCreated,
        { items },
        key(),
      ),
    selection: (requestId: string, language: Language) =>
      api.get(
        `/v1/loan-requests/${encodeURIComponent(requestId)}/selection?language=${language}`,
        SelectionView,
      ),
    removeSelected: (selectionId: string, lenderId: string) =>
      api.post(
        `/v1/selections/${encodeURIComponent(selectionId)}/items/${encodeURIComponent(lenderId)}/remove`,
        Ok,
        {},
        key(),
      ),
    lenderConsent: (
      requestId: string,
      input: {
        lenderId: string;
        noticeId: string;
        decision: 'granted' | 'denied' | 'withdrawn';
        appVersion: string;
      },
    ) =>
      api.post(
        `/v1/loan-requests/${encodeURIComponent(requestId)}/lender-consents`,
        Created,
        { ...input, screen: 'lender_consent' },
        key(),
      ),
    routeSelection: (selectionId: string, idempotencyKey?: string) =>
      api.post(
        `/v1/selections/${encodeURIComponent(selectionId)}/route`,
        RouteResult,
        {},
        key(idempotencyKey),
      ),
    applications: (requestId: string) =>
      api.get(
        `/v1/loan-requests/${encodeURIComponent(requestId)}/applications`,
        BorrowerApplicationList,
      ),
    withdrawApplication: (applicationId: string) =>
      api.post(`/v1/applications/${encodeURIComponent(applicationId)}/withdraw`, Ok, {}, key()),
    compare: (
      requestId: string,
      input: {
        sort?: (typeof COMPARISON_SORTS)[number];
        platform: (typeof PLATFORMS)[number];
        language: Language;
      },
      idempotencyKey?: string,
    ) =>
      api.post(
        `/v1/loan-requests/${encodeURIComponent(requestId)}/comparison`,
        Comparison,
        input,
        key(idempotencyKey),
      ),

    // ---- Phase 07: documents, acknowledgement, acceptance, signing, delivery ----------------------------------------
    applicationDocuments: (applicationId: string) =>
      api.get(
        `/v1/applications/${encodeURIComponent(applicationId)}/documents`,
        ApplicationDocuments,
      ),
    kfsView: (documentId: string, language: Language) =>
      api.get(`/v1/documents/${encodeURIComponent(documentId)}/kfs?language=${language}`, KfsView),
    documentContent: (documentId: string, purpose: 'view' | 'download' = 'view') =>
      api.get(
        `/v1/documents/${encodeURIComponent(documentId)}/content?purpose=${purpose}`,
        IssuedDocumentContent,
      ),
    acknowledgeKfs: (
      documentId: string,
      input: {
        noticeId: string;
        sections: ('part1' | 'apr_sheet' | 'schedule' | 'part2')[];
        action: 'checkbox_and_button' | 'button';
        explanationVersion: string;
        appVersion: string;
      },
      idempotencyKey?: string,
    ) =>
      api.post(
        `/v1/documents/${encodeURIComponent(documentId)}/acknowledge`,
        AcknowledgeResult,
        { ...input, channel: 'mobile_app' },
        key(idempotencyKey),
      ),
    acceptOffer: (
      offerId: string,
      input: { kfsDocumentId: string; acknowledgementId: string },
      idempotencyKey?: string,
    ) =>
      api.post(
        `/v1/offers/${encodeURIComponent(offerId)}/accept`,
        AcceptResult,
        input,
        key(idempotencyKey),
      ),
    startSigning: (agreementId: string, idempotencyKey?: string) =>
      api.post(
        `/v1/agreements/${encodeURIComponent(agreementId)}/signing`,
        SigningStarted,
        {},
        key(idempotencyKey),
      ),
    signingStatus: (agreementId: string) =>
      api.get(`/v1/agreements/${encodeURIComponent(agreementId)}/signing`, SigningStatusView),
    requestDelivery: (documentId: string, channel: 'sms_notice' | 'email_notice') =>
      api.post(
        `/v1/documents/${encodeURIComponent(documentId)}/delivery`,
        DeliveryRequested,
        { channel },
        key(),
      ),
    deliveries: (documentId: string) =>
      api.get(`/v1/documents/${encodeURIComponent(documentId)}/deliveries`, DeliveryList),

    requestDeletion: () => api.post('/v1/borrower/deletion-requests', Created, {}, key()),
    cancelDeletion: () => api.post('/v1/borrower/deletion-requests/cancel', Ok, {}, key()),
    deletionStatus: () => api.get('/v1/borrower/deletion-requests/current', DeletionCurrent),
  };
}
export type BorrowerClient = ReturnType<typeof createBorrowerClient>;
