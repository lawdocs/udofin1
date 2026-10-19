import { createApiClient } from '@udofin/auth-client';
import { describe, expect, it } from 'vitest';
import { createBorrowerClient } from '../src/borrower/client';

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function setup(routes: Record<string, { status?: number; body: unknown }>) {
  const calls: Call[] = [];
  const fetchFake = ((url: string, init: RequestInit) => {
    const path = url.replace('https://api.example', '');
    calls.push({
      method: init.method ?? 'GET',
      url: path,
      headers: init.headers as Record<string, string>,
      body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    });
    const hit = routes[`${init.method ?? 'GET'} ${path}`];
    if (!hit) return Promise.resolve(new Response('{}', { status: 404 }));
    return Promise.resolve(
      new Response(JSON.stringify(hit.body), {
        status: hit.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as unknown as typeof fetch;
  const api = createApiClient({
    baseUrl: 'https://api.example',
    getAccessToken: () => Promise.resolve('tok'),
    fetch: fetchFake,
  });
  return { client: createBorrowerClient(api), calls };
}

const ID = '0f0f0f0f-0000-4000-8000-000000000001';

describe('borrower client', () => {
  it('reads purposes and notices in the chosen language', async () => {
    const { client, calls } = setup({
      'GET /v1/loan-purposes?language=hi': {
        body: { items: [{ key: 'medical', label: 'चिकित्सा', labelStatus: 'requires_review' }] },
      },
      'GET /v1/consent/notices?language=hi': { body: { items: [], marketingAvailable: false } },
    });
    const purposes = await client.purposes('hi');
    expect(purposes.ok && purposes.data.items[0]?.labelStatus).toBe('requires_review');
    expect((await client.notices('hi')).ok).toBe(true);
    expect(calls.every((c) => c.headers.authorization === 'Bearer tok')).toBe(true);
  });

  it('writes carry an idempotency key, and a caller can reuse one for a retry', async () => {
    const { client, calls } = setup({
      [`POST /v1/loan-requests/${ID}/submit`]: {
        body: { id: ID, submissionReference: 'UR-0123456789', status: 'submitted' },
      },
      'POST /v1/borrower/profile': { body: { ok: true } },
    });
    await client.submit(ID, 3, 'key-1');
    await client.submit(ID, 3, 'key-1');
    await client.updateProfile({ displayName: 'Asha' });
    const keys = calls.map((c) => c.headers['idempotency-key']);
    expect(keys[0]).toBe('key-1');
    expect(keys[1]).toBe('key-1');
    expect(keys[2]).toMatch(/^m-/);
    expect(calls[0]?.body).toEqual({ expectedVersion: 3 });
  });

  it('never puts personal data in a URL: ids only, encoded', async () => {
    const { client, calls } = setup({});
    await client.request('a/b?x=1');
    expect(calls[0]?.url).toBe('/v1/loan-requests/a%2Fb%3Fx%3D1');
  });

  it('turns a contract mismatch into bad_response and server problems into codes', async () => {
    const { client } = setup({
      'GET /v1/borrower/me': { body: { profile: 'nope' } },
      'GET /v1/borrower/categories': { status: 403, body: { code: 'borrower_only' } },
    });
    expect(await client.me()).toEqual({ ok: false, status: 200, code: 'bad_response' });
    expect(await client.categories()).toEqual({ ok: false, status: 403, code: 'borrower_only' });
  });
});
