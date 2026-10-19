// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildVersionBody,
  parsePanelState,
  ProductsPage,
  runOperation,
  safeReturnPath,
  stateToParams,
  TransactionsPanel,
  type Capabilities,
  type OnboardingApi,
  type ViewContext,
} from '../src/index.js';

afterEach(cleanup);

const ID = '0f1e2d3c-4b5a-4c6d-8e7f-0a1b2c3d4e5f';
const KEY = 'ui-0f1e2d3c-4b5a-4c6d-8e7f-0a1b2c3d4e5f';

function form(fields: [string, string][]): FormData {
  const f = new FormData();
  for (const [k, v] of fields) f.append(k, v);
  return f;
}
const terms: [string, string][] = [
  ['minAmountMinor', '1000000'],
  ['maxAmountMinor', '5000000'],
  ['minTenureDays', '180'],
  ['maxTenureDays', '720'],
  ['rateType', 'fixed'],
  ['minAnnualRateBps', '1400'],
  ['maxAnnualRateBps', '2400'],
];

describe('product configuration form', () => {
  it('turns indexed rows into the structured configuration', () => {
    const built = buildVersionBody(
      form([
        ...terms,
        ['fee_0_code', 'processing'],
        ['fee_0_label', 'Processing fee'],
        ['fee_0_kind', 'percent_of_principal'],
        ['fee_0_rateBps', '200'],
        ['fee_0_timing', 'at_disbursement'],
        ['fee_0_taxIncluded', 'on'],
        ['fee_1_code', ''],
        ['elig_0_field', 'age_years'],
        ['elig_0_operator', 'between'],
        ['elig_0_value', '21, 60'],
        ['elig_1_field', 'employment_type'],
        ['elig_1_operator', 'in'],
        ['elig_1_value', 'salaried,self_employed'],
        ['repay_frequencies', 'monthly'],
        ['repay_methods', 'upi_autopay'],
        ['repay_methods', 'enach'],
        ['attr_0_key', 'internal_code'],
        ['attr_0_value', 'PL-01'],
        ['attr_1_key', 'priority'],
        ['attr_1_value', '3'],
      ]),
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const body = built.body as { terms: Record<string, unknown>; config: Record<string, unknown> };
    expect(body.terms).toMatchObject({ minAmountMinor: 1_000_000, rateType: 'fixed' });
    expect(body.config.fees).toEqual([
      {
        code: 'processing',
        label: 'Processing fee',
        kind: 'percent_of_principal',
        amountMinor: undefined,
        rateBps: 200,
        taxIncluded: true,
        timing: 'at_disbursement',
        refundable: false,
      },
    ]);
    expect((body.config.eligibility as { rules: unknown[] }).rules).toEqual([
      { field: 'age_years', operator: 'between', value: [21, 60] },
      { field: 'employment_type', operator: 'in', value: ['salaried', 'self_employed'] },
    ]);
    expect(body.config.attributes).toEqual({ internal_code: 'PL-01', priority: 3 });
    expect((body.config.repayment as { methods: string[] }).methods).toEqual([
      'upi_autopay',
      'enach',
    ]);
  });

  it('uses the advanced JSON when given, and refuses malformed JSON', () => {
    const ok = buildVersionBody(
      form([...terms, ['advancedJson', '{"fees": [], "attributes": {"a_b": 1}}']]),
    );
    expect(ok).toEqual({
      ok: true,
      body: {
        terms: expect.objectContaining({ maxTenureDays: 720 }) as unknown,
        config: { fees: [], attributes: { a_b: 1 } },
      },
    });
    expect(buildVersionBody(form([...terms, ['advancedJson', '{nope']])).ok).toBe(false);
    expect(buildVersionBody(form([...terms, ['advancedJson', '[1,2]']])).ok).toBe(false);
  });

  it('is available to the lender portal only', async () => {
    const calls: string[] = [];
    const api: OnboardingApi = {
      get: () => Promise.resolve({ ok: false as const, status: 500, code: 'unused' }),
      post: (path) => {
        calls.push(path);
        return Promise.resolve({ ok: true as const, status: 200, data: {} as never });
      },
    };
    const f = form([['op', 'product.version.create'], ['key', KEY], ['id', ID], ...terms]);
    expect(await runOperation(api, f, 'ops')).toEqual({ ok: false, code: 'path_not_allowed' });
    expect(await runOperation(api, f, 'lender')).toEqual({ ok: true });
    expect(calls).toEqual([`/v1/lender/products/${ID}/versions`]);
  });
});

describe('transactions panel state', () => {
  const now = new Date('2026-10-13T10:00:00Z');
  it('drops invalid values and keeps valid ones', () => {
    const s = parsePanelState(
      {
        kinds: ['payment', 'bogus'],
        statuses: 'created,DROP TABLE',
        columns: 'kind,borrowerPhone,status',
        q: 'ab',
        minAmountMinor: '12x',
        order: 'asc',
        groupBy: 'month',
        lenderId: 'nope',
      },
      undefined,
      now,
    );
    expect(s.kinds).toEqual(['payment']);
    expect(s.statuses).toEqual(['created']);
    expect(s.columns).toEqual(['kind', 'status']);
    expect(s.q).toBeUndefined();
    expect(s.minAmountMinor).toBeUndefined();
    expect(s.lenderId).toBeUndefined();
    expect(s.order).toBe('asc');
    expect(s.groupBy).toBe('month');
  });

  it('applies a saved view as defaults, with a relative date range', () => {
    const s = parsePanelState(
      {},
      {
        kinds: ['payment'],
        columns: ['status', 'amountMinor'],
        range: 'last_7_days',
        order: 'asc',
      },
      now,
    );
    expect(s).toMatchObject({
      kinds: ['payment'],
      columns: ['status', 'amountMinor'],
      from: '2026-10-06',
      order: 'asc',
    });
  });

  it('round-trips through page parameters', () => {
    const s = parsePanelState(
      { kinds: 'payment', statuses: 'failed', from: '2026-10-01', q: 'abc' },
      undefined,
      now,
    );
    const again = parsePanelState(
      Object.fromEntries(new URLSearchParams(stateToParams(s))),
      undefined,
      now,
    );
    expect(again).toEqual(s);
  });

  it("only returns to this portal's pages", () => {
    expect(safeReturnPath('/transactions?kinds=payment&columns=kind%2Cstatus')).toBe(
      '/transactions?kinds=payment&columns=kind%2Cstatus',
    );
    expect(safeReturnPath('/products')).toBe('/products');
    expect(safeReturnPath('/transactions/../admin')).toBe('/onboarding');
    expect(safeReturnPath('//evil.example/transactions')).toBe('/onboarding');
  });
});

const lenderCaps: Capabilities = {
  manage: false,
  approve: false,
  compliance: false,
  submit: true,
  read: true,
  productConfigure: true,
  productApprove: false,
  panel: true,
};
const ctx = (caps: Capabilities, userId = ID): ViewContext => ({
  portal: 'lender',
  caps,
  action: () => undefined,
  returnTo: '/products',
  userId,
});
const version = (over: Record<string, unknown>) => ({
  id: ID,
  productId: ID,
  lenderOrgId: ID,
  version: 1,
  status: 'draft',
  terms: {
    minAmountMinor: 1_000_000,
    maxAmountMinor: 5_000_000,
    minTenureDays: 180,
    maxTenureDays: 720,
    rateType: 'fixed',
    minAnnualRateBps: 1400,
    maxAnnualRateBps: 2400,
  },
  config: { fees: [], documents: [], attributes: {}, channels: ['mobile_app'] },
  configSchemaVersion: 1,
  draftedBy: ID,
  approvedBy: null,
  approvedAt: null,
  effectiveFrom: null,
  createdAt: '2026-10-13T00:00:00Z',
  ...over,
});
const product = (v: Record<string, unknown>) => ({
  ok: true as const,
  data: {
    items: [
      {
        id: ID,
        lenderOrgId: ID,
        categoryKey: 'personal',
        code: 'PL-1',
        name: 'Personal',
        status: 'draft',
        createdAt: '2026-10-13T00:00:00Z',
        versions: [v],
      },
    ],
  },
});

describe('products page', () => {
  it('lets the drafter send a draft but not approve it', () => {
    render(
      <ProductsPage
        products={product(version({})) as never}
        categories={[]}
        lenderId={ID}
        ctx={ctx(lenderCaps)}
      />,
    );
    expect(screen.getByRole('button', { name: 'Send for approval' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('offers approval to a different approver and not to the drafter', () => {
    const pending = product(
      version({ status: 'pending_approval', draftedBy: '11111111-1111-4111-8111-111111111111' }),
    );
    render(
      <ProductsPage
        products={pending as never}
        categories={[]}
        lenderId={ID}
        ctx={ctx({ ...lenderCaps, productApprove: true })}
      />,
    );
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy();
    cleanup();
    const mine = product(version({ status: 'pending_approval', draftedBy: ID }));
    render(
      <ProductsPage
        products={mine as never}
        categories={[]}
        lenderId={ID}
        ctx={ctx({ ...lenderCaps, productApprove: true })}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.getByText(/Waiting for a different person/)).toBeTruthy();
  });

  it('is read-only for staff without product permissions', () => {
    render(
      <ProductsPage
        products={product(version({})) as never}
        categories={[]}
        lenderId={undefined}
        ctx={ctx({ ...lenderCaps, productConfigure: false })}
      />,
    );
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('transactions panel view', () => {
  it('shows only the chosen columns and an export link, without borrower columns', () => {
    const state = parsePanelState({ columns: 'kind,amountMinor' }, undefined, new Date());
    render(
      <TransactionsPanel
        state={state}
        data={{
          catalogue: {
            ok: true,
            data: {
              kinds: ['application', 'payment'],
              statusesByKind: { payment: ['created'] },
              columns: [],
              groupBy: [],
              maxExportRows: 5000,
            },
          },
          page: {
            ok: true,
            data: {
              items: [
                {
                  kind: 'payment',
                  id: ID,
                  lenderOrgId: ID,
                  occurredAt: '2026-10-13T10:00:00Z',
                  status: 'created',
                  amountMinor: '175000',
                  reference: null,
                  productId: null,
                  productCode: null,
                  purpose: 'installment',
                  applicationId: null,
                  loanAccountId: null,
                },
              ],
              nextCursor: null,
            },
          },
          summary: undefined,
          views: { ok: true, data: { items: [] } },
          products: { ok: true, data: { items: [] } },
        }}
        ctx={ctx(lenderCaps)}
        base="/transactions"
        exportBase="/transactions/export"
      />,
    );
    expect(screen.getByText('1,750.00')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Download CSV/ }).getAttribute('href')).toContain(
      '/transactions/export?',
    );
    expect(screen.queryByRole('columnheader', { name: /phone|borrower/i })).toBeNull();
  });
});
