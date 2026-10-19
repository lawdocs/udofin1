import { type OnboardingApi } from '../onboarding/api.js';
import { isUuid, loadDocumentContent, verifiedDocumentBytes } from './data.js';

const plain = (status: number, text: string): Response =>
  new Response(text, { status, headers: { 'cache-control': 'no-store' } });

/**
 * The answer to "open this lender document": the exact stored PDF, or a short plain refusal. The API has already
 * authorised the caller, recorded the access and compared the stored bytes with the SHA-256 recorded when the document was
 * registered; the size and the SHA-256 are compared once more here, so a damaged or substituted answer is never passed on.
 * Nothing the API said (code or message) is repeated in a refusal.
 */
export async function openLenderDocument(
  api: OnboardingApi,
  loanId: string,
  documentId: string,
): Promise<Response> {
  if (!isUuid(loanId) || !isUuid(documentId)) return plain(404, 'Not found');
  const result = await loadDocumentContent(api, loanId, documentId, 'view');
  if (!result.ok) {
    if (result.status === 404) return plain(404, 'Not found');
    if (result.status === 401 || result.status === 403) return plain(403, 'Not available');
    if (result.status === 409 || result.status === 503)
      return plain(result.status, 'Not available');
    return plain(502, 'Not available');
  }
  const bytes = await verifiedDocumentBytes(result.data);
  if (!bytes) return plain(502, 'Not available');
  return new Response(bytes, {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `inline; filename="document-${documentId.slice(0, 8)}.pdf"`,
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
      'content-security-policy': "sandbox; default-src 'none'",
    },
  });
}
