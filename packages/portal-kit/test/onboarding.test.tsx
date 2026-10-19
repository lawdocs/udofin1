// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type z, type ZodType } from 'zod';
import {
  AccountingTab,
  type Capabilities,
  capabilitiesFrom,
  errorMessage,
  formatRupees,
  GatesTab,
  OPERATIONS,
  type OnboardingApi,
  type OnboardingResult,
  runOperation,
  safeReturnPath,
  ServicesTab,
  type TabData,
  type ViewContext,
} from '../src/index.js';

afterEach(cleanup);

const ID = '0f1e2d3c-4b5a-4c6d-8e7f-0a1b2c3d4e5f';
const LENDER = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const KEY = 'ui-0f1e2d3c-4b5a-4c6d-8e7f-0a1b2c3d4e5f';

function recordingApi() {
  const calls: { path: string; body: unknown; key: string }[] = [];
  const api: OnboardingApi = {
    get: vi.fn(() => Promise.resolve({ ok: false as const, status: 500, code: 'unused' })),
    post: <T,>(path: string, _schema: ZodType<T>, body: unknown, key: string) => {
      calls.push({ path, body, key });
      return Promise.resolve({
        ok: true,
        status: 200,
        data: {} as z.infer<ZodType<T>>,
      } as OnboardingResult<T>);
    },
  };
  return { api, calls };
}

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

describe('onboarding operations', () => {
  it('runs only operations that are allow-listed for the portal', async () => {
    const { api, calls } = recordingApi();
    const gate = form({
      op: 'gate.request',
      key: KEY,
      lenderId: LENDER,
      targetStage: 'institution_verified',
    });
    expect(await runOperation(api, gate, 'lender')).toEqual({
      ok: false,
      code: 'path_not_allowed',
    });
    expect(calls).toHaveLength(0);
    expect(await runOperation(api, gate, 'ops')).toEqual({ ok: true });
    expect(calls[0]?.path).toBe(`/v1/onboarding/lenders/${LENDER}/gate-requests`);
    expect(calls[0]?.key).toBe(KEY);
  });

  it('refuses unknown operations, prototype names and malformed idempotency keys', async () => {
    const { api, calls } = recordingApi();
    expect((await runOperation(api, form({ op: 'drop.table', key: KEY }), 'ops')).ok).toBe(false);
    expect((await runOperation(api, form({ op: 'constructor', key: KEY }), 'ops')).ok).toBe(false);
    expect(
      (await runOperation(api, form({ op: 'gate.cancel', key: 'short', id: ID }), 'ops')).ok,
    ).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('validates fields before calling the API and never echoes values', async () => {
    const { api, calls } = recordingApi();
    const result = await runOperation(
      api,
      form({ op: 'gate.decide', key: KEY, id: 'not-a-uuid', approve: 'true' }),
      'ops',
    );
    expect(result).toEqual({ ok: false, code: 'validation_failed' });
    expect(calls).toHaveLength(0);
  });

  it('leaves blank fields out so an empty input never overwrites a stored value', async () => {
    const { api, calls } = recordingApi();
    await runOperation(
      api,
      form({
        op: 'accounting.save',
        key: KEY,
        lenderId: LENDER,
        indAsApplicability: 'under_assessment',
        notes: '   ',
        netWorthPaise: '',
      }),
      'lender',
    );
    expect(calls[0]?.body).toEqual({ indAsApplicability: 'under_assessment' });
  });

  it('rejects documents that are too large or of the wrong type before any upload', async () => {
    const { api, calls } = recordingApi();
    const big = form({
      op: 'document.upload',
      key: KEY,
      lenderId: LENDER,
      purpose: 'licence',
      label: 'Big',
    });
    big.set(
      'file',
      new File([new Uint8Array(8 * 1024 * 1024 + 1)], 'x.pdf', { type: 'application/pdf' }),
    );
    expect(await runOperation(api, big, 'lender')).toEqual({
      ok: false,
      code: 'document_too_large',
    });
    const html = form({
      op: 'document.upload',
      key: KEY,
      lenderId: LENDER,
      purpose: 'licence',
      label: 'Page',
    });
    html.set('file', new File(['<html>'], 'x.html', { type: 'text/html' }));
    expect(await runOperation(api, html, 'lender')).toEqual({
      ok: false,
      code: 'document_type_mismatch',
    });
    const ok = form({
      op: 'document.upload',
      key: KEY,
      lenderId: LENDER,
      purpose: 'licence',
      label: 'Licence',
    });
    const pdf = new File(['%PDF-1.4 x'], 'x.pdf', { type: 'application/pdf' });
    // jsdom's File has no arrayBuffer(); Node and the browser do.
    Object.defineProperty(pdf, 'arrayBuffer', {
      value: () => Promise.resolve(new TextEncoder().encode('%PDF-1.4 x').buffer),
    });
    ok.set('file', pdf);
    expect(await runOperation(api, ok, 'lender')).toEqual({ ok: true });
    expect((calls[0]?.body as { contentBase64: string }).contentBase64).toBe(btoa('%PDF-1.4 x'));
  });

  it('exposes no operation that approves, verifies or activates without the API deciding', () => {
    // Every decision operation maps to a POST the API authorises; the lender portal has none of the Udofin-only ones.
    const lenderOps = Object.entries(OPERATIONS)
      .filter(([, op]) => op.portals.includes('lender'))
      .map(([name]) => name);
    for (const forbidden of [
      'gate.request',
      'gate.decide',
      'service.activate',
      'category.signoff',
      'verification.decide',
      'accounting.decide',
    ]) {
      expect(lenderOps).not.toContain(forbidden);
    }
  });

  it('only returns to onboarding pages of this portal', () => {
    expect(safeReturnPath(`/onboarding/${LENDER}?tab=gates`)).toBe(
      `/onboarding/${LENDER}?tab=gates`,
    );
    expect(safeReturnPath('https://evil.example/onboarding')).toBe('/onboarding');
    expect(safeReturnPath('//evil.example')).toBe('/onboarding');
    expect(safeReturnPath('/onboarding/../admin')).toBe('/onboarding');
  });
});

describe('labels and formatting', () => {
  it('formats integer paise without floating point', () => {
    expect(formatRupees('50000000000')).toBe('500,000,000.00');
    expect(formatRupees('5')).toBe('0.05');
    expect(formatRupees('123456789012345678')).toBe('1,234,567,890,123,456.78');
  });
  it('gives a plain message for rule codes and a generic one for unknown codes', () => {
    expect(errorMessage('self_approval')).toMatch(/someone else/);
    expect(errorMessage('unconfirmed_not_verifiable')).toMatch(/to be confirmed/);
    expect(errorMessage('weird')).toBe('The action could not be completed.');
  });
  it('derives capabilities from permissions', () => {
    expect(capabilitiesFrom(['onboarding.read', 'onboarding.submit'])).toMatchObject({
      manage: false,
      approve: false,
      compliance: false,
      submit: true,
      read: true,
    });
  });
});

const ok = <T,>(data: T) => ({ ok: true as const, status: 200, data });
const lenderCaps: Capabilities = {
  manage: false,
  approve: false,
  compliance: false,
  submit: true,
  read: true,
};
const opsCaps: Capabilities = {
  manage: true,
  approve: true,
  compliance: false,
  submit: false,
  read: true,
};
const ctx = (caps: Capabilities, portal: 'ops' | 'lender'): ViewContext => ({
  portal,
  caps,
  action: () => undefined,
  returnTo: `/onboarding/${LENDER}?tab=accounting`,
});
const overview = ok({
  summary: {
    lenderOrgId: LENDER,
    legalName: 'Alpha Ltd',
    displayName: 'Alpha',
    organizationStatus: 'onboarding',
    categoryKey: 'nbfc_icc',
    categoryLabel: 'NBFC',
    stage: 'profile_created',
    verificationStatus: 'unverified',
    accountingStatus: 'draft',
  },
  profile: null,
  gate: { lenderOrgId: LENDER, stage: 'profile_created', stageChangedAt: '2026-10-13T00:00:00Z' },
  categoryActivationAllowed: true,
});
const profile = (over: Record<string, unknown>) => ({
  id: ID,
  lenderOrgId: LENDER,
  versionNo: 1,
  status: 'draft',
  accountingFramework: 'to_be_confirmed',
  indAsApplicability: 'applicable',
  indAsImplementationStatus: 'not_implemented',
  applicabilityBasis: 'to_be_confirmed',
  applicabilityBasisNote: null,
  effectiveFy: null,
  effectiveDate: null,
  statementScope: 'to_be_confirmed',
  listedStatus: 'unlisted',
  groupRelationships: null,
  netWorthPaise: '50000000000',
  netWorthMeasuredOn: '2026-03-31',
  netWorthFy: '2025-26',
  confirmationSource: 'to_be_confirmed',
  evidenceDocumentId: null,
  notes: null,
  nextReviewOn: null,
  submittedAt: null,
  reviewedAt: null,
  reviewNote: null,
  lastVerifiedOn: null,
  createdAt: '2026-10-13T00:00:00Z',
  ...over,
});

describe('accounting tab', () => {
  it('says plainly when nothing is verified and shows applicability and implementation separately', () => {
    const data = {
      overview,
      accounting: ok({ items: [profile({})] }),
      documents: ok({ items: [] }),
    } as unknown as TabData;
    render(<AccountingTab data={data} lenderId={LENDER} ctx={ctx(lenderCaps, 'lender')} />);
    expect(screen.getByText('No verified record.')).toBeTruthy();
    expect(screen.getAllByText('Ind AS applicability').length).toBeGreaterThan(1);
    expect(screen.getAllByText('Ind AS implementation status').length).toBeGreaterThan(1);
    expect(screen.getByText(/not an accounting opinion/i)).toBeTruthy();
    // The lender may edit its declaration but sees no verify / reject controls.
    expect(screen.queryByRole('button', { name: 'Verify' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeTruthy();
  });

  it('offers verification only to a person who may approve, once submitted', () => {
    const data = {
      overview,
      accounting: ok({ items: [profile({ status: 'submitted' })] }),
      documents: ok({ items: [] }),
    } as unknown as TabData;
    render(<AccountingTab data={data} lenderId={LENDER} ctx={ctx(opsCaps, 'ops')} />);
    expect(screen.getByRole('button', { name: 'Verify' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeTruthy();
  });
});

describe('services tab', () => {
  const version = (over: Record<string, unknown>) => ({
    id: ID,
    serviceId: ID,
    versionNo: 1,
    status: 'proposed',
    requestedScope: 'Send leads',
    proposedScope: null,
    agreedScope: null,
    responsibleParty: 'lender',
    accountableParty: 'lender',
    supportingParties: [],
    sharedAllocation: null,
    prerequisites: null,
    dataExchanged: null,
    permittedPurpose: null,
    systemOfRecord: 'to_be_confirmed',
    integrationRequirements: null,
    slaSummary: null,
    escalationPath: null,
    contractReference: null,
    effectiveFrom: null,
    reviewOn: null,
    statusNote: null,
    lenderAgreedAt: null,
    udofinAgreedAt: null,
    activatedAt: null,
    createdAt: '2026-10-13T00:00:00Z',
    ...over,
  });
  const services = (v: Record<string, unknown>) =>
    ok({
      items: [
        {
          id: ID,
          lenderOrgId: LENDER,
          categoryKey: 'lead_generation',
          title: 'Lead generation',
          createdAt: '2026-10-13T00:00:00Z',
          versions: [v],
        },
      ],
    });

  it('shows requested scope, an unagreed final scope, and no activation for a proposed service', () => {
    const data = {
      overview,
      services: services(version({})),
      serviceCategories: ok({ items: [] }),
    } as unknown as TabData;
    render(<ServicesTab data={data} lenderId={LENDER} ctx={ctx(opsCaps, 'ops')} />);
    expect(screen.getByText('Not yet agreed')).toBeTruthy();
    expect(screen.getAllByText('Send leads').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /Activate/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Agree to this scope' })).toBeNull();
  });

  it('offers activation only for an agreed version', () => {
    const data = {
      overview,
      services: services(version({ status: 'agreed', agreedScope: 'Final text' })),
      serviceCategories: ok({ items: [] }),
    } as unknown as TabData;
    render(<ServicesTab data={data} lenderId={LENDER} ctx={ctx(opsCaps, 'ops')} />);
    expect(screen.getByRole('button', { name: /Activate/ })).toBeTruthy();
  });

  it('keeps Udofin-only fields out of the lender view', () => {
    const data = {
      overview,
      services: services(version({})),
      serviceCategories: ok({ items: [] }),
    } as unknown as TabData;
    render(<ServicesTab data={data} lenderId={LENDER} ctx={ctx(lenderCaps, 'lender')} />);
    expect(screen.queryByLabelText('Udofin proposed scope')).toBeNull();
    expect(screen.queryByLabelText('Final agreed scope')).toBeNull();
  });
});

describe('gates tab', () => {
  const data = {
    overview,
    conditions: ok({
      lenderOrgId: LENDER,
      currentStage: 'profile_created',
      targetStage: 'institution_verified',
      items: [
        {
          key: 'institution_verified',
          satisfied: false,
          detail: 'institution profile verified with evidence',
        },
      ],
    }),
    gateRequests: ok({
      items: [
        {
          id: ID,
          lenderOrgId: LENDER,
          fromStage: 'profile_created',
          targetStage: 'institution_verified',
          status: 'pending',
          requestedBy: ID,
          requestedAt: '2026-10-13T00:00:00Z',
          requestNote: null,
          decidedBy: null,
          decidedAt: null,
          decisionNote: null,
        },
      ],
    }),
  } as unknown as TabData;

  it('shows unmet conditions and hides every control from a lender', () => {
    render(<GatesTab data={data} lenderId={LENDER} ctx={ctx(lenderCaps, 'lender')} />);
    const table = screen.getAllByRole('table')[0];
    expect(table ? within(table).getByText('No') : null).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('gives Udofin staff request, approve and reject controls', () => {
    render(<GatesTab data={data} lenderId={LENDER} ctx={ctx(opsCaps, 'ops')} />);
    expect(screen.getByRole('button', { name: /Request:/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy();
  });
});
