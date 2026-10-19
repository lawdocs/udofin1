// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type z, type ZodType } from 'zod';
import {
  capabilitiesFrom,
  DocumentsSection,
  type OnboardingApi,
  type OnboardingResult,
  runOperation,
  type ViewContext,
} from '../src/index.js';

afterEach(cleanup);

const ID = '0f1e2d3c-4b5a-4c6d-8e7f-0a1b2c3d4e5f';
const OFFER = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const KEY = 'ui-0f1e2d3c-4b5a-4c6d-8e7f-0a1b2c3d4e5f';
const SHA = 'ab'.repeat(32);

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

const form = (fields: Record<string, string>): FormData => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

const doc = (over: Record<string, unknown> = {}) => ({
  id: ID,
  documentType: 'kfs',
  version: 1,
  language: 'en',
  sourceMode: 'generated',
  approvalStatus: 'draft',
  issuanceStatus: 'not_issued',
  proposalNo: null,
  kfsValidUntil: null,
  sha256: SHA,
  ...over,
});

const ctx = (perms: string[]): ViewContext => ({
  portal: 'lender',
  caps: capabilitiesFrom(perms),
  action: vi.fn(() => Promise.resolve()),
  returnTo: '/applications/x',
  userId: ID,
});

const section = (perms: string[], items: unknown[]) =>
  render(
    <DocumentsSection
      applicationId={ID}
      offer={{ offerId: OFFER, revision: 1, status: 'issued' }}
      documents={{ ok: true, data: { items: items as never } }}
      inputs={{ ok: true, data: { items: [] } }}
      ctx={ctx(perms)}
    />,
  );

describe('document operations', () => {
  it('approves only with the review tick and a full file hash, sending the hash', async () => {
    const { api, calls } = recordingApi();
    const base = { op: 'document.approve', key: KEY, id: ID };
    expect((await runOperation(api, form({ ...base, sha256: SHA }), 'lender')).ok).toBe(false);
    expect(
      (await runOperation(api, form({ ...base, sha256: 'short', reviewed: 'on' }), 'lender')).ok,
    ).toBe(false);
    expect(calls).toHaveLength(0);
    expect(
      (await runOperation(api, form({ ...base, sha256: SHA, reviewed: 'on' }), 'lender')).ok,
    ).toBe(true);
    expect(calls[0]).toMatchObject({
      path: `/v1/lender/documents/${ID}/approve`,
      body: { sha256: SHA },
    });
  });

  it('is not available to the operations portal', async () => {
    const { api, calls } = recordingApi();
    const result = await runOperation(api, form({ op: 'document.issue', key: KEY, id: ID }), 'ops');
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('rejects malformed KFS JSON without calling the API and sends valid JSON untouched', async () => {
    const { api, calls } = recordingApi();
    const bad = await runOperation(
      api,
      form({ op: 'document.kfs_data', key: KEY, offerId: OFFER, mode: 'data', data: '{nope' }),
      'lender',
    );
    expect(bad.ok).toBe(false);
    expect(calls).toHaveLength(0);
    await runOperation(
      api,
      form({
        op: 'document.kfs_data',
        key: KEY,
        offerId: OFFER,
        mode: 'data',
        data: '{"apr":1234}',
      }),
      'lender',
    );
    expect(calls[0]?.body).toEqual({ mode: 'data', data: { apr: 1234 } });
  });

  it('requires a known reason and language', async () => {
    const { api, calls } = recordingApi();
    expect(
      (
        await runOperation(
          api,
          form({ op: 'document.withdraw', key: KEY, id: ID, reason: 'because' }),
          'lender',
        )
      ).ok,
    ).toBe(false);
    expect(
      (
        await runOperation(
          api,
          form({
            op: 'document.generate',
            key: KEY,
            offerId: OFFER,
            inputId: ID,
            language: 'fr',
            documentType: 'kfs',
          }),
          'lender',
        )
      ).ok,
    ).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('DocumentsSection', () => {
  it('offers approval of the exact file to a role that may approve, with the hash in the form', () => {
    const { container } = section(['document.approve', 'document.prepare'], [doc()]);
    expect(screen.getByRole('button', { name: 'Approve this exact file' })).toBeTruthy();
    expect(container.querySelector(`input[name="sha256"][value="${SHA}"]`)).toBeTruthy();
    expect(screen.getByText(/I opened and reviewed this file/)).toBeTruthy();
  });

  it('shows no write forms to a read-only role', () => {
    section([], [doc()]);
    expect(screen.queryByRole('button', { name: 'Approve this exact file' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Submit KFS data' })).toBeNull();
    expect(screen.getByText(/does not include preparing documents/)).toBeTruthy();
  });

  it('offers issuing only after lender approval', () => {
    section(['document.approve'], [doc({ approvalStatus: 'lender_approved' })]);
    expect(screen.getByRole('button', { name: 'Issue to the borrower' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve this exact file' })).toBeNull();
  });
});
