// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ApplicationDetailView,
  ApplicationsList,
  runOperation,
  safeReturnPath,
  type OnboardingApi,
} from '../src/index.js';

afterEach(cleanup);

const ID = '0f1e2d3c-4b5a-4c6d-8e7f-0a1b2c3d4e5f';
const KEY = 'ui-0f1e2d3c-4b5a-4c6d-8e7f-0a1b2c3d4e5f';

function form(fields: [string, string][]): FormData {
  const f = new FormData();
  for (const [k, v] of fields) f.append(k, v);
  return f;
}

function recorder() {
  const calls: { path: string; body: unknown }[] = [];
  const api: OnboardingApi = {
    get: () => Promise.resolve({ ok: false, status: 500, code: 'x' }),
    post: (path, _schema, body) => {
      calls.push({ path, body });
      return Promise.resolve({ ok: true, status: 200, data: {} as never });
    },
  };
  return { api, calls };
}

const offerFields: [string, string][] = [
  ['op', 'application.offer'],
  ['key', KEY],
  ['id', ID],
  ['lenderOfferRef', 'OF-1'],
  ['principalMinor', '5000000'],
  ['tenureDays', '360'],
  ['installmentFrequency', 'monthly'],
  ['installmentCount', '12'],
  ['installmentAmountMinor', '450000'],
  ['monthlyRepaymentMinor', '450000'],
  ['annualInterestRateBps', '1800'],
  ['aprBps', '2140'],
  ['processingFeeMinor', '0'],
  ['totalRepayableMinor', '5400000'],
  ['penalChargesSummary', 'As in the KFS'],
  ['kfsUrl', 'https://lender.example/kfs/1'],
  ['issuedAt', '2026-10-13T10:00'],
  ['validUntil', '2026-10-25T10:00'],
];

describe('lender application operations', () => {
  it('sends an offer exactly as typed, with India-time instants and no calculation', async () => {
    const { api, calls } = recorder();
    const outcome = await runOperation(api, form(offerFields), 'lender');
    expect(outcome.ok).toBe(true);
    expect(calls[0]?.path).toBe(`/v1/lender/applications/${ID}/offers`);
    expect(calls[0]?.body).toMatchObject({
      aprBps: 2140,
      monthlyRepaymentMinor: 450000,
      totalRepayableMinor: 5400000,
      issuedAt: '2026-10-13T10:00:00+05:30',
      validUntil: '2026-10-25T10:00:00+05:30',
    });
  });

  it('rejects an offer with a missing or non-numeric amount before calling the API', async () => {
    const { api, calls } = recorder();
    const bad = offerFields.map(([k, v]): [string, string] =>
      k === 'aprBps' ? [k, '21.4'] : [k, v],
    );
    expect((await runOperation(api, form(bad), 'lender')).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('is not available from the operations portal and ignores unknown values', async () => {
    const { api, calls } = recorder();
    expect((await runOperation(api, form(offerFields), 'ops')).ok).toBe(false);
    const decision = form([
      ['op', 'application.decision'],
      ['key', KEY],
      ['id', ID],
      ['decision', 'auto_approved'],
    ]);
    expect((await runOperation(api, decision, 'lender')).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('reports a check status and a decision to the right endpoints', async () => {
    const { api, calls } = recorder();
    await runOperation(
      api,
      form([
        ['op', 'application.check'],
        ['key', KEY],
        ['id', ID],
        ['kind', 'kyc'],
        ['status', 'completed'],
      ]),
      'lender',
    );
    await runOperation(
      api,
      form([
        ['op', 'application.decision'],
        ['key', KEY],
        ['id', ID],
        ['decision', 'approved'],
      ]),
      'lender',
    );
    expect(calls.map((c) => c.path)).toEqual([
      `/v1/lender/applications/${ID}/checks`,
      `/v1/lender/applications/${ID}/decision`,
    ]);
  });

  it('only returns to application pages of this portal', () => {
    expect(safeReturnPath('/applications')).toBe('/applications');
    expect(safeReturnPath(`/applications/${ID}`)).toBe(`/applications/${ID}`);
    expect(safeReturnPath('/applications/../../x')).toBe('/onboarding');
    expect(safeReturnPath('//evil.example')).toBe('/onboarding');
  });
});

const row = {
  applicationId: ID,
  udofinReference: 'UDF-1',
  status: 'submitted',
  transmission: 'delivered',
  responseDueAt: '2026-10-15T10:00:00Z',
  noResponseAt: null,
  lenderApplicationRef: null,
  request: {
    categoryKey: 'personal_loan',
    amountMinor: 5000000,
    tenureDays: 360,
    purposeCode: 'medical',
  },
  productName: 'Personal loan',
  displayName: null,
  language: 'en',
  consentWithdrawn: false,
  checks: [],
  offer: null,
  createdAt: '2026-10-13T10:00:00Z',
};
const noop = () => undefined;
const caps = (decide: boolean) => ({
  manage: false,
  approve: false,
  compliance: false,
  submit: false,
  read: false,
  applicationRead: true,
  applicationDecide: decide,
});

describe('lender application screens', () => {
  it('lists applications without any borrower identifier', () => {
    render(
      <ApplicationsList
        result={{ ok: true, data: { items: [row], nextCursor: null } }}
        nextHref={() => '/'}
      />,
    );
    expect(screen.getByText('UDF-1')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\+91|\d{10}/);
  });

  it('hides write forms from read-only users and when consent is withdrawn', () => {
    const ctx = (decide: boolean) => ({
      portal: 'lender' as const,
      caps: caps(decide),
      action: noop,
      returnTo: `/applications/${ID}`,
    });
    const detail = {
      ok: true as const,
      data: { decisions: [], offerIntake: [], offers: [], events: [] },
    };
    const { rerender } = render(
      <ApplicationDetailView
        application={row}
        detail={detail}
        ctx={ctx(false)}
        contact={<span />}
      />,
    );
    expect(screen.queryByText('Record decision')).toBeNull();
    rerender(
      <ApplicationDetailView
        application={row}
        detail={detail}
        ctx={ctx(true)}
        contact={<span />}
      />,
    );
    expect(screen.getByText('Record decision')).toBeTruthy();
    expect(screen.getByText(/Record an approved decision before submitting an offer/)).toBeTruthy();
    rerender(
      <ApplicationDetailView
        application={{ ...row, consentWithdrawn: true }}
        detail={detail}
        ctx={ctx(true)}
        contact={<span>reveal</span>}
      />,
    );
    expect(screen.queryByText('Record decision')).toBeNull();
    expect(screen.queryByText('reveal')).toBeNull();
  });
});
