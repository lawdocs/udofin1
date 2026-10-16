import { LenderDocumentList, LenderKfsInputList } from '@udofin/contracts';
import { type OnboardingApi } from '../onboarding/api.js';

/** The KFS data submissions for one offer revision and every document of the application (drafts included). */
export const loadDocumentSection = async (
  api: OnboardingApi,
  applicationId: string,
  offerId: string | null,
) => {
  const [documents, inputs] = await Promise.all([
    api.get(`/v1/lender/documents?applicationId=${applicationId}&limit=100`, LenderDocumentList),
    offerId
      ? api.get(`/v1/lender/offers/${offerId}/kfs-data`, LenderKfsInputList)
      : Promise.resolve(undefined),
  ]);
  return { documents, inputs };
};
