import {
  AccountingProfileList,
  ContractList,
  DocumentContent,
  DocumentList,
  GateConditions,
  GateRequestList,
  InstitutionCategoryList,
  IntegrationList,
  LenderOverview,
  LenderServiceList,
  LenderSummaryList,
  RequirementList,
  ServiceCategoryList,
  VerificationHistory,
} from '@udofin/contracts';
import { z } from 'zod';
import { type OnboardingApi, type OnboardingResult } from './api.js';

export const TABS = [
  'profile',
  'accounting',
  'services',
  'requirements',
  'integrations',
  'contracts',
  'documents',
  'gates',
] as const;
const WaiverList = z.object({
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
});
const SettingList = z.object({
  items: z.array(
    z.object({
      key: z.string(),
      value: z.boolean(),
      description: z.string(),
      reason: z.string().nullable(),
    }),
  ),
});

export type Tab = (typeof TABS)[number];

export const TAB_LABELS: Record<Tab, string> = {
  profile: 'Institution & verification',
  accounting: 'Accounting framework & Ind AS',
  services: 'Engagement scope & services',
  requirements: 'Requirements',
  integrations: 'Integrations',
  contracts: 'Contracts',
  documents: 'Documents',
  gates: 'Activation gates',
};

export const isTab = (value: unknown): value is Tab =>
  typeof value === 'string' && (TABS as readonly string[]).includes(value);

export type Loaded<S extends z.ZodType> = OnboardingResult<z.infer<S>>;

export interface TabData {
  overview: Loaded<typeof LenderOverview>;
  documents?: Loaded<typeof DocumentList>;
  history?: Loaded<typeof VerificationHistory>;
  accounting?: Loaded<typeof AccountingProfileList>;
  services?: Loaded<typeof LenderServiceList>;
  serviceCategories?: Loaded<typeof ServiceCategoryList>;
  requirements?: Loaded<typeof RequirementList>;
  integrations?: Loaded<typeof IntegrationList>;
  contracts?: Loaded<typeof ContractList>;
  conditions?: Loaded<typeof GateConditions>;
  gateRequests?: Loaded<typeof GateRequestList>;
  categories?: Loaded<typeof InstitutionCategoryList>;
  waivers?: Loaded<typeof WaiverList>;
  settings?: Loaded<typeof SettingList>;
}

/** Loads exactly what one tab shows. Each part succeeds or fails on its own. */
export async function loadLenderTab(
  api: OnboardingApi,
  lenderId: string,
  tab: Tab,
): Promise<TabData> {
  const base = `/v1/onboarding/lenders/${lenderId}`;
  const overview = api.get(base, LenderOverview);
  const docs = () => api.get(`${base}/documents`, DocumentList);
  switch (tab) {
    case 'profile': {
      const [o, documents, history, categories] = await Promise.all([
        overview,
        docs(),
        api.get(`${base}/verification-history`, VerificationHistory),
        api.get('/v1/onboarding/institution-categories', InstitutionCategoryList),
      ]);
      return { overview: o, documents, history, categories };
    }
    case 'accounting': {
      const [o, accounting, documents, waivers, settings] = await Promise.all([
        overview,
        api.get(`${base}/accounting-profiles`, AccountingProfileList),
        docs(),
        api.get(`${base}/accounting-waivers`, WaiverList),
        api.get('/v1/onboarding/settings', SettingList),
      ]);
      return { overview: o, accounting, documents, waivers, settings };
    }
    case 'services': {
      const [o, services, serviceCategories] = await Promise.all([
        overview,
        api.get(`${base}/services`, LenderServiceList),
        api.get('/v1/onboarding/service-categories', ServiceCategoryList),
      ]);
      return { overview: o, services, serviceCategories };
    }
    case 'requirements': {
      const [o, requirements, documents, services] = await Promise.all([
        overview,
        api.get(`${base}/requirements`, RequirementList),
        docs(),
        api.get(`${base}/services`, LenderServiceList),
      ]);
      return { overview: o, requirements, documents, services };
    }
    case 'integrations': {
      const [o, integrations, documents] = await Promise.all([
        overview,
        api.get(`${base}/integrations`, IntegrationList),
        docs(),
      ]);
      return { overview: o, integrations, documents };
    }
    case 'contracts': {
      const [o, contracts, documents] = await Promise.all([
        overview,
        api.get(`${base}/contracts`, ContractList),
        docs(),
      ]);
      return { overview: o, contracts, documents };
    }
    case 'documents': {
      const [o, documents] = await Promise.all([overview, docs()]);
      return { overview: o, documents };
    }
    case 'gates': {
      const [o, conditions, gateRequests] = await Promise.all([
        overview,
        api.get(`${base}/gate/conditions`, GateConditions),
        api.get(`${base}/gate-requests`, GateRequestList),
      ]);
      return { overview: o, conditions, gateRequests };
    }
  }
}

export const loadLenderList = (api: OnboardingApi) =>
  Promise.all([
    api.get('/v1/onboarding/lenders', LenderSummaryList),
    api.get('/v1/onboarding/institution-categories', InstitutionCategoryList),
  ]);

export const loadCategories = (api: OnboardingApi) =>
  api.get('/v1/onboarding/institution-categories', InstitutionCategoryList);

/** What the signed-in person may do, from the permissions the API reported. Hiding a form is a convenience only. */
export interface Capabilities {
  manage: boolean;
  approve: boolean;
  compliance: boolean;
  submit: boolean;
  read: boolean;
  productConfigure?: boolean;
  productApprove?: boolean;
  panel?: boolean;
  applicationRead?: boolean;
  applicationDecide?: boolean;
}

export function capabilitiesFrom(permissions: readonly string[]): Capabilities {
  const has = (p: string) => permissions.includes(p);
  return {
    manage: has('onboarding.manage'),
    approve: has('onboarding.approve'),
    compliance: has('onboarding.compliance_signoff'),
    submit: has('onboarding.submit'),
    read: has('onboarding.read'),
    productConfigure: has('product.configure'),
    productApprove: has('product.approve'),
    panel: has('application.read') || has('loan.read') || has('payment.read'),
    applicationRead: has('application.read'),
    applicationDecide: has('application.decide'),
  };
}

/** Fetches one document's bytes for a download response (authorised and audited by the API). */
export const loadDocument = (api: OnboardingApi, id: string) =>
  api.get(`/v1/onboarding/documents/${id}/content`, DocumentContent);
