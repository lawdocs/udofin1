import { LenderApplicationDetail, LenderApplicationPage } from '@udofin/contracts';
import { type OnboardingApi } from '../onboarding/api.js';

export const loadApplications = (api: OnboardingApi, cursor?: string) =>
  api.get(
    `/v1/lender/applications?limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    LenderApplicationPage,
  );

export const loadApplication = (api: OnboardingApi, id: string) =>
  api.get(`/v1/lender/applications/${id}`, LenderApplicationDetail);
