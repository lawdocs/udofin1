import { type MatchingLender, type SelectionView } from '@udofin/contracts';
import { describe, expect, it } from 'vitest';
import {
  formatAprBps,
  groupByLender,
  isSafeKfsUrl,
  routeReadiness,
  selectionPayload,
  setProduct,
  stageKey,
  toggleLender,
  type Chosen,
} from '../src/borrower/routing';
import { en } from '../src/i18n/en';

const product = (lenderId: string, versionId: string, name = 'Loan'): MatchingLender => ({
  lenderId,
  lenderName: `Lender ${lenderId}`,
  versionId,
  productName: name,
  minAmountMinor: 1_000_000,
  maxAmountMinor: 50_000_000,
  minTenureDays: 180,
  maxTenureDays: 1825,
});

describe('choosing lenders', () => {
  it('starts with nobody chosen and never chooses for the borrower', () => {
    expect(groupByLender([product('a', 'v1')]).length).toBe(1);
    const chosen: Chosen = {};
    expect(Object.keys(chosen)).toEqual([]);
  });

  it('groups several products of one lender and keeps one product per lender', () => {
    const groups = groupByLender([
      product('b', 'v2', 'Two'),
      product('a', 'v1'),
      product('b', 'v3', 'Three'),
    ]);
    expect(groups.map((g) => g.lenderId)).toEqual(['a', 'b']);
    expect(groups[1]?.products).toHaveLength(2);
  });

  it('toggles a lender on and off and stops at five', () => {
    let chosen: Chosen = {};
    for (const id of ['a', 'b', 'c', 'd', 'e']) chosen = toggleLender(chosen, id);
    expect(Object.keys(chosen)).toHaveLength(5);
    expect(toggleLender(chosen, 'f')).toBe(chosen); // refused, same object
    expect(Object.keys(toggleLender(chosen, 'c'))).toEqual(['a', 'b', 'd', 'e']);
  });

  it('only sets a product for a lender that is chosen', () => {
    expect(setProduct({}, 'a', 'v1')).toEqual({});
    expect(setProduct({ a: null }, 'a', 'v1')).toEqual({ a: 'v1' });
  });

  it('builds the request: a single-product lender needs no pick, a multi-product lender does', () => {
    const groups = groupByLender([product('a', 'v1'), product('b', 'v2'), product('b', 'v3')]);
    expect(selectionPayload({}, groups)).toEqual({ ok: false, reason: 'empty' });
    expect(selectionPayload({ a: null }, groups)).toEqual({ ok: true, items: [{ lenderId: 'a' }] });
    expect(selectionPayload({ a: null, b: null }, groups)).toEqual({
      ok: false,
      reason: 'product_required',
    });
    expect(selectionPayload({ a: null, b: 'v3' }, groups)).toEqual({
      ok: true,
      items: [{ lenderId: 'a' }, { lenderId: 'b', productVersionId: 'v3' }],
    });
  });
});

describe("sending needs each lender's own consent", () => {
  const notice = (reviewStatus: 'approved' | 'requires_review') => ({
    id: '00000000-0000-4000-8000-000000000001',
    version: 1,
    title: 'x',
    bodyMarkdown: 'x',
    bodySha256: 'x',
    language: 'en',
    reviewStatus,
    languageFallback: false,
  });
  const item = (
    lenderId: string,
    over: Partial<SelectionView['items'][number]>,
  ): SelectionView['items'][number] => ({
    lenderId,
    lenderName: lenderId,
    productVersionId: '00000000-0000-4000-8000-000000000002',
    productName: 'p',
    status: 'selected',
    consentInForce: false,
    notice: notice('approved'),
    ...over,
  });
  const view = (items: SelectionView['items']): SelectionView => ({
    maxLenders: 5,
    routedCount: 0,
    selectionId: '00000000-0000-4000-8000-000000000003',
    items,
  });

  it('is not ready until every chosen lender has current consent on approved wording', () => {
    expect(routeReadiness(view([])).ready).toBe(false);
    expect(routeReadiness(view([item('a', { consentInForce: true })])).ready).toBe(true);
    const mixed = routeReadiness(view([item('a', { consentInForce: true }), item('b', {})]));
    expect(mixed).toEqual({
      ready: false,
      blockers: [{ lenderId: 'b', blocker: 'consent_missing' }],
    });
  });

  it('names what blocks: missing wording and unapproved wording are different', () => {
    const r = routeReadiness(
      view([item('a', { notice: null }), item('b', { notice: notice('requires_review') })]),
    );
    expect(r.blockers).toEqual([
      { lenderId: 'a', blocker: 'wording_missing' },
      { lenderId: 'b', blocker: 'wording_unapproved' },
    ]);
  });

  it('ignores removed lenders', () => {
    expect(
      routeReadiness(view([item('a', { consentInForce: true }), item('b', { status: 'removed' })]))
        .ready,
    ).toBe(true);
  });
});

describe('showing what a lender reported', () => {
  it('has a message for every stage the server can report', () => {
    for (const stage of [
      'sending',
      'sent',
      'acknowledged',
      'processing',
      'info_requested',
      'approved_awaiting_offer',
      'offer_received',
      'declined',
      'no_response',
      'technical_failure',
      'stopped',
      'withdrawn',
    ] as const)
      expect(stageKey(stage) in en, stage).toBe(true);
  });

  it('keeps "no response" distinct from "declined" in the words shown', () => {
    expect(en['stage.no_response']).not.toBe(en['stage.declined']);
    expect(en['stage.no_response']).not.toMatch(/declin/i);
    expect(en['offers.reason.no_response']).not.toMatch(/declin/i);
    expect(en['offers.reason.technical_failure']).not.toMatch(/declin/i);
  });

  it('formats a lender-supplied APR for display without calculating anything', () => {
    expect(formatAprBps(2050)).toBe('20.50%');
    expect(formatAprBps(3600)).toBe('36.00%');
    expect(formatAprBps(905)).toBe('9.05%');
    expect(formatAprBps(0)).toBe('0.00%');
  });

  it('does not use urgency or recommendation wording in the comparison text', () => {
    const text = Object.entries(en)
      .filter(([k]) => k.startsWith('offers.') || k.startsWith('apps.'))
      .map(([, v]) => v)
      .join(' ');
    expect(text).not.toMatch(/best|recommended|top pick|hurry|expires in|limited time|countdown/i);
  });
});

describe('Key Facts Statement links', () => {
  it('opens only https links without credentials or odd characters', () => {
    expect(isSafeKfsUrl('https://kfs.lender.example/kfs/123')).toBe(true);
    for (const bad of [
      'http://kfs.lender.example/x',
      'javascript:alert(1)',
      'https://user:pw@kfs.lender.example/x',
      'https://kfs.lender.example/a b',
      'https://kfs.lender.example\\evil',
      'https://localhost/x',
      'ftp://kfs.lender.example/x',
      'kfs.lender.example/x',
      '',
      `https://kfs.lender.example/${'a'.repeat(2100)}`,
    ])
      expect(isSafeKfsUrl(bad), bad.slice(0, 40)).toBe(false);
  });
});
