// Phase 05 integration tests: the borrower API over HTTP against a REAL migrated Postgres, with the
// labelled mock SMS and integrity adapters. Runs only when the INTEGRATION_* URLs are set (see
// docs/testing/strategy.md). The database must be disposable: fixtures are not cleaned up.
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { createMockIntegrityVerifier, createMockSmsSender } from '@udofin/adapters';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { TokenError, type TokenVerifier } from '../../src/auth/token-verifier.js';
import { loadConfig } from '../../src/config.js';
import { createUserContext } from '../../src/db/user-context.js';
import { createMockLenderConnector } from '@udofin/adapters';
import { createRoutingProcessor } from '../../src/system/routing.js';
import { createConnectorResolver } from '../../src/workers/routing-handlers.js';
import { createBorrowerProcessor } from '../../src/system/borrower.js';
import { createChangeRequestApplier } from '../../src/system/change-requests.js';
import { createSystemPool, type SystemPool } from '../../src/system/pool.js';
import { createHandlers } from '../../src/workers/handlers.js';
import { type OutboxEvent } from '../../src/workers/outbox-worker.js';

const ADMIN = process.env.INTEGRATION_ADMIN_URL;
const API = process.env.INTEGRATION_API_URL;
const SYSTEM = process.env.INTEGRATION_SYSTEM_URL;
const enabled = Boolean(ADMIN && API && SYSTEM);

const fakeVerifier: TokenVerifier = {
  verify(header) {
    const match = /^Bearer test\.([0-9a-f-]{36})\.(aal1|aal2)$/.exec(header ?? '');
    if (!match?.[1] || !match[2]) return Promise.reject(new TokenError('invalid'));
    return Promise.resolve({ sub: match[1], aal: match[2] as 'aal1' | 'aal2', sessionId: null });
  },
};
const token = (user: string) => ({ authorization: `Bearer test.${user}.aal1` });
let nextAddress = 1;
const freshAddress = () => `10.7.${(nextAddress >> 8) & 255}.${nextAddress++ & 255}`;
const letters = (n: number) =>
  Array.from(randomBytes(n), (b) => String.fromCharCode(97 + (b % 26))).join('');
const phone = () => `91${Math.floor(1_000_000_000 + Math.random() * 8_999_999_999)}`;

const HOOK_SECRET = `v1,whsec_${randomBytes(24).toString('base64')}`;
const PEPPER = randomBytes(24).toString('hex');

describe.skipIf(!enabled)('borrower API against a real database', () => {
  const ids = {
    b1: randomUUID(),
    b2: randomUUID(),
    b3: randomUUID(),
    staff: randomUUID(),
    drafter: randomUUID(),
    approver: randomUUID(),
  };
  const phones = { b1: phone(), b2: phone(), b3: phone() };
  const purposeA = `it${letters(8)}`;
  const purposeB = `it${letters(8)}`;
  const notice: Record<string, string> = {};
  const sms = createMockSmsSender('test');
  let admin: pg.Pool;
  let apiPool: pg.Pool;
  let systemPool: SystemPool;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let handlers: ReturnType<typeof createHandlers>;

  const req = (
    method: 'GET' | 'POST',
    url: string,
    user: string | null,
    payload?: unknown,
    key: string | null = method === 'POST' ? `it-${randomUUID()}` : null,
  ) =>
    app.inject({
      method,
      url,
      remoteAddress: freshAddress(),
      headers: {
        ...(user ? token(user) : {}),
        ...(key ? { 'idempotency-key': key } : {}),
      },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  const get = (url: string, user: string | null) => req('GET', url, user);
  const post = (url: string, user: string | null, payload?: unknown, key?: string | null) =>
    req('POST', url, user, payload ?? {}, key);
  const problemCode = (res: { json: () => unknown }) => (res.json() as { code?: string }).code;

  const grantRequired = async (user: string) => {
    for (const purpose of ['terms_of_use', 'privacy_notice', 'share_with_lenders']) {
      const res = await post('/v1/consent/decisions', user, {
        noticeId: notice[purpose],
        decision: 'granted',
      });
      expect(res.statusCode, `consent ${purpose}`).toBeLessThan(300);
    }
  };
  const newDraft = async (user: string, body: object = {}) => {
    const res = await post('/v1/loan-requests', user, {
      categoryKey: 'personal',
      amountMinor: 5_000_000,
      tenureDays: 365,
      purposeCode: purposeA,
      ...body,
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ id: string; version: number }>();
  };

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: ADMIN, max: 2 });
    apiPool = new pg.Pool({ connectionString: API, max: 10 });
    systemPool = createSystemPool(SYSTEM ?? '');
    for (const [id, p] of [
      [ids.b1, phones.b1],
      [ids.b2, phones.b2],
      [ids.b3, phones.b3],
    ] as const) {
      await admin.query(
        `insert into auth.users (id, phone, raw_app_meta_data) values ($1, $2, '{}')`,
        [id, p],
      );
    }
    for (const id of [ids.staff, ids.drafter, ids.approver]) {
      await admin.query(
        `insert into auth.users (id, phone, raw_app_meta_data) values ($1, null, '{"actor_type":"staff"}')`,
        [id],
      );
    }
    await admin.query(
      `insert into lending.loan_purposes (key, label_en, label_hi, hi_review_status) values
        ($1, 'IT purpose A', 'आईटी उद्देश्य ए', 'requires_review'), ($2, 'IT purpose B', 'आईटी उद्देश्य बी', 'approved')`,
      [purposeA, purposeB],
    );
    // Fixture notices at a version above any seeded one so they are the current wording.
    for (const purpose of ['terms_of_use', 'privacy_notice', 'share_with_lenders']) {
      const id = randomUUID();
      notice[purpose] = id;
      await admin.query(
        `insert into consent.notices (id, purpose, version, language, title, body_markdown, status, published_at, drafted_by, approved_by, review_status)
         values ($1, $2, (select coalesce(max(version), 0) + 1 from consent.notices where purpose = $2 and language = 'en'), 'en', $2, $3, 'published', now(), $4, $5, 'approved')`,
        [id, purpose, `fixture text for ${purpose}`, ids.drafter, ids.approver],
      );
    }

    const borrower = {
      sms,
      integrity: createMockIntegrityVerifier('test'),
      stepUpPepper: PEPPER,
      sendSmsHookSecret: HOOK_SECRET,
      smsTimeoutMs: 2000,
    };
    app = await buildApp(loadConfig({ APP_ENV: 'test' }), {
      auth: { verifier: fakeVerifier, context: createUserContext(apiPool) },
      borrower,
    });
    handlers = createHandlers({
      applier: createChangeRequestApplier(systemPool),
      borrower: createBorrowerProcessor(systemPool),
      routing: createRoutingProcessor(systemPool),
      connectors: createConnectorResolver({
        environment: 'test',
        createMock: () => createMockLenderConnector('test'),
      }),
      changeRequestStatus: () => Promise.resolve(undefined),
    });
  });

  afterAll(async () => {
    await app?.close();
    await apiPool?.end();
    await systemPool?.end();
    await admin?.end();
  });

  describe('access', () => {
    it('requires a token, and refuses staff identities', async () => {
      expect((await get('/v1/borrower/me', null)).statusCode).toBe(401);
      const res = await get('/v1/borrower/me', ids.staff);
      expect(res.statusCode).toBe(403);
      expect(['borrower_only', 'no_active_access']).toContain(problemCode(res));
    });

    it('shows a new borrower as account_created and never as KYC-verified or eligible', async () => {
      const res = await get('/v1/borrower/me', ids.b1);
      expect(res.statusCode).toBe(200);
      const body = res.json<{
        profile: { onboardingStatus: string };
        journey: { lenderKyc: string; eligibility: string; consentsCompleted: boolean };
        marketing: { available: boolean };
      }>();
      expect(body.profile.onboardingStatus).toBe('account_created');
      expect(body.journey.lenderKyc).toBe('not_started');
      expect(body.journey.eligibility).toBe('not_assessed');
      expect(body.journey.consentsCompleted).toBe(false);
      expect(body.marketing.available).toBe(false);
    });
  });

  describe('profile and language', () => {
    it('stores a display name and a language preference; both are optional', async () => {
      const res = await post('/v1/borrower/profile', ids.b1, { preferredLanguage: 'hi' });
      expect(res.statusCode).toBe(200);
      const me = (await get('/v1/borrower/me', ids.b1)).json<{
        profile: {
          preferredLanguage: string;
          onboardingStatus: string;
          displayName: string | null;
        };
      }>();
      expect(me.profile.preferredLanguage).toBe('hi');
      expect(me.profile.onboardingStatus).toBe('profile_started');
      expect(me.profile.displayName).toBeNull();
    });

    it('rejects unsupported languages, markup and unknown fields', async () => {
      expect(
        (await post('/v1/borrower/profile', ids.b1, { preferredLanguage: 'fr' })).statusCode,
      ).toBe(422);
      expect(
        (await post('/v1/borrower/profile', ids.b1, { displayName: '<b>x</b>' })).statusCode,
      ).toBe(422);
      expect(
        (await post('/v1/borrower/profile', ids.b1, { dateOfBirth: '2000-01-01' })).statusCode,
      ).toBe(422);
    });

    it('serves the loan-purpose list in the requested language, marking unapproved wording', async () => {
      const res = await get('/v1/loan-purposes?language=hi', ids.b1);
      expect(res.statusCode).toBe(200);
      const items = res.json<{ items: { key: string; label: string; labelStatus: string }[] }>()
        .items;
      const a = items.find((i) => i.key === purposeA);
      expect(a?.label).toBe('आईटी उद्देश्य ए');
      expect(a?.labelStatus).toBe('requires_review');
    });
  });

  describe('consent', () => {
    it('lists notices, records each decision as its own ledger row, and refuses marketing', async () => {
      const list = await get('/v1/consent/notices?language=en', ids.b1);
      expect(list.statusCode).toBe(200);
      expect(list.json<{ marketingAvailable: boolean }>().marketingAvailable).toBe(false);
      await grantRequired(ids.b1);
      const rows = await admin.query<{ n: string }>(
        `select count(*) n from consent.records r join identity.borrowers b on b.id = r.borrower_id where b.user_id = $1`,
        [ids.b1],
      );
      expect(Number(rows.rows[0]?.n)).toBe(3);
      const me = (await get('/v1/borrower/me', ids.b1)).json<{
        journey: { consentsCompleted: boolean };
      }>();
      expect(me.journey.consentsCompleted).toBe(true);

      const marketing = await admin.query<{ id: string }>(
        `insert into consent.notices (id, purpose, version, language, title, body_markdown, status, published_at, drafted_by, approved_by, review_status)
         values (gen_random_uuid(), 'marketing', (select coalesce(max(version), 0) + 1 from consent.notices where purpose = 'marketing' and language = 'en'), 'en', 'm', 'm', 'published', now(), $1, $2, 'approved') returning id`,
        [ids.drafter, ids.approver],
      );
      const refused = await post('/v1/consent/decisions', ids.b1, {
        noticeId: marketing.rows[0]?.id,
        decision: 'granted',
      });
      expect(refused.statusCode).toBeGreaterThanOrEqual(400);
      expect(problemCode(refused)).toBe('marketing_disabled');
    });

    it('withdrawal is a new event, and the current state follows it', async () => {
      await grantRequired(ids.b3);
      const res = await post('/v1/consent/decisions', ids.b3, {
        noticeId: notice.share_with_lenders,
        decision: 'withdrawn',
      });
      expect(res.statusCode).toBeLessThan(300);
      const me = (await get('/v1/borrower/me', ids.b3)).json<{
        journey: { consentsCompleted: boolean };
        consents: { purpose: string; decision: string }[];
      }>();
      expect(me.journey.consentsCompleted).toBe(false);
      expect(me.consents.find((c) => c.purpose === 'share_with_lenders')?.decision).toBe(
        'withdrawn',
      );
    });
  });

  describe('loan requests', () => {
    it('refuses submission without the required consents', async () => {
      const draft = await newDraft(ids.b2);
      const res = await post(`/v1/loan-requests/${draft.id}/submit`, ids.b2, {
        expectedVersion: draft.version,
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(problemCode(res)).toBe('consent_required');
    });

    it('rejects a purpose outside the fixed list and amounts that are not whole paise', async () => {
      const bad = await post('/v1/loan-requests', ids.b1, {
        categoryKey: 'personal',
        amountMinor: 5_000_000,
        tenureDays: 365,
        purposeCode: 'notonthelist',
      });
      expect(bad.statusCode).toBeGreaterThanOrEqual(400);
      expect(problemCode(bad)).toBe('purpose_unknown');
      const fractional = await post('/v1/loan-requests', ids.b1, {
        categoryKey: 'personal',
        amountMinor: 1000.5,
        tenureDays: 365,
        purposeCode: purposeA,
      });
      expect(fractional.statusCode).toBe(422);
    });

    it('edits with optimistic concurrency, never extends expiry, and submits once', async () => {
      const draft = await newDraft(ids.b1);
      const before = await admin.query<{ e: string }>(
        'select expires_at::text e from lending.loan_requests where id = $1',
        [draft.id],
      );
      const edit = await post(`/v1/loan-requests/${draft.id}/draft`, ids.b1, {
        expectedVersion: draft.version,
        amountMinor: 6_000_000,
        purposeCode: purposeB,
      });
      expect(edit.statusCode).toBe(200);
      const stale = await post(`/v1/loan-requests/${draft.id}/draft`, ids.b1, {
        expectedVersion: draft.version,
        amountMinor: 7_000_000,
      });
      expect(stale.statusCode).toBe(409);
      expect(problemCode(stale)).toBe('version_conflict');
      const after = await admin.query<{ e: string }>(
        'select expires_at::text e from lending.loan_requests where id = $1',
        [draft.id],
      );
      expect(after.rows[0]?.e).toBe(before.rows[0]?.e);

      const detail = (await get(`/v1/loan-requests/${draft.id}`, ids.b1)).json<{
        request: { version: number };
      }>();
      const key = `it-${randomUUID()}`;
      const body = { expectedVersion: detail.request.version };
      const first = await post(`/v1/loan-requests/${draft.id}/submit`, ids.b1, body, key);
      expect(first.statusCode, first.body).toBe(200);
      const reference = first.json<{ submissionReference: string }>().submissionReference;
      expect(reference).toMatch(/^UR-[0-9A-F]{10}$/);
      const replay = await post(`/v1/loan-requests/${draft.id}/submit`, ids.b1, body, key);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      // A concurrent or repeated submission with a new key resolves to the same request, not a second one.
      const again = await post(`/v1/loan-requests/${draft.id}/submit`, ids.b1, body);
      expect(again.json<{ submissionReference: string }>().submissionReference).toBe(reference);
      const events = (await get(`/v1/loan-requests/${draft.id}`, ids.b1)).json<{
        request: { status: string };
        events: { event: string }[];
      }>();
      expect(events.request.status).toBe('submitted');
      expect(events.events.map((e) => e.event)).toEqual(['created', 'submitted']);
      const edited = await post(`/v1/loan-requests/${draft.id}/draft`, ids.b1, {
        expectedVersion: detail.request.version + 1,
        amountMinor: 1,
      });
      expect(edited.statusCode).toBeGreaterThanOrEqual(400);
    });

    it('enforces draft expiry on read and write without any job having run', async () => {
      const draft = await newDraft(ids.b1);
      await admin.query(
        `update lending.loan_requests set expires_at = now() - interval '1 minute' where id = $1`,
        [draft.id],
      );
      const read = await get(`/v1/loan-requests/${draft.id}`, ids.b1);
      const seen = read.json<{ request: { status: string; version: number } }>().request;
      expect(seen.status).toBe('expired');
      const submit = await post(`/v1/loan-requests/${draft.id}/submit`, ids.b1, {
        expectedVersion: seen.version,
      });
      expect(submit.statusCode).toBeGreaterThanOrEqual(400);
      expect(problemCode(submit)).toBe('draft_expired');
      const edit = await post(`/v1/loan-requests/${draft.id}/draft`, ids.b1, {
        expectedVersion: seen.version,
        amountMinor: 2,
      });
      expect(problemCode(edit)).toBe('draft_expired');
    });

    it('keeps one borrower out of another borrower’s requests', async () => {
      const draft = await newDraft(ids.b1);
      expect((await get(`/v1/loan-requests/${draft.id}`, ids.b2)).statusCode).toBe(404);
      expect(
        (
          await post(`/v1/loan-requests/${draft.id}/withdraw`, ids.b2, {
            expectedVersion: draft.version,
          })
        ).statusCode,
      ).toBe(404);
      const list = (await get('/v1/loan-requests', ids.b2)).json<{ items: { id: string }[] }>();
      expect(list.items.some((i) => i.id === draft.id)).toBe(false);
    });
  });

  describe('step-up one-time code', () => {
    const start = (user: string, action = 'offer_acceptance', contextRef = 'offer1') =>
      post('/v1/stepup/challenges', user, { action, contextRef });

    it('sends a code, stores only a hash, verifies once and locks after repeated failures', async () => {
      const before = sms.sent.length;
      const started = await start(ids.b1);
      expect(started.statusCode, started.body).toBe(201);
      const { challengeId, delivery } = started.json<{ challengeId: string; delivery: string }>();
      expect(delivery).toBe('accepted');
      const message = sms.sent[before];
      expect(message?.template).toBe('stepup_otp');
      const code = message?.variables.otp ?? '';
      expect(code).toMatch(/^[0-9]{6}$/);

      const stored = await admin.query<Record<string, unknown>>(
        'select * from identity.stepup_challenges where id = $1',
        [challengeId],
      );
      expect(Object.values(stored.rows[0] ?? {}).map(String)).not.toContain(code);

      const wrong = code === '000000' ? '111111' : '000000';
      expect(
        (await post(`/v1/stepup/challenges/${challengeId}/verify`, ids.b1, { code: wrong })).json<{
          result: string;
        }>().result,
      ).toBe('invalid');
      // Another borrower cannot touch it.
      expect(
        (await post(`/v1/stepup/challenges/${challengeId}/verify`, ids.b2, { code })).json<{
          result: string;
        }>().result,
      ).toBe('not_found');
      expect(
        (await post(`/v1/stepup/challenges/${challengeId}/verify`, ids.b1, { code })).json<{
          result: string;
        }>().result,
      ).toBe('verified');
    });

    it('locks a challenge after five wrong codes, even for the right one', async () => {
      const before = sms.sent.length;
      const { challengeId } = (await start(ids.b1, 'esign', 'doc1')).json<{
        challengeId: string;
      }>();
      const code = sms.sent[before]?.variables.otp ?? '';
      const wrong = code === '000000' ? '111111' : '000000';
      let last = '';
      for (let i = 0; i < 5; i += 1)
        last = (
          await post(`/v1/stepup/challenges/${challengeId}/verify`, ids.b1, { code: wrong })
        ).json<{ result: string }>().result;
      expect(last).toBe('locked');
      expect(
        (await post(`/v1/stepup/challenges/${challengeId}/verify`, ids.b1, { code })).json<{
          result: string;
        }>().result,
      ).toBe('locked');
    });

    it('does not leak the code or the number into audit records', async () => {
      const rows = await admin.query<{ t: string }>(
        `select e::text t from audit.events e where e.action like 'identity.stepup%'`,
      );
      for (const row of rows.rows) expect(row.t).not.toContain(phones.b1);
    });
  });

  describe('Send SMS auth hook', () => {
    const sign = (id: string, timestamp: number, body: string, secret = HOOK_SECRET) =>
      `v1,${createHmac('sha256', Buffer.from(secret.replace('v1,whsec_', ''), 'base64'))
        .update(`${id}.${timestamp}.${body}`)
        .digest('base64')}`;
    const call = (body: string, headers: Record<string, string>) =>
      app.inject({
        method: 'POST',
        url: '/v1/hooks/send-sms',
        remoteAddress: freshAddress(),
        headers: { 'content-type': 'application/json', ...headers },
        payload: body,
      });
    const body = JSON.stringify({ user: { phone: '+919000000001' }, sms: { otp: '482913' } });

    it('sends the sign-in code when the signature is valid', async () => {
      const before = sms.sent.length;
      const ts = Math.floor(Date.now() / 1000);
      const res = await call(body, {
        'webhook-id': 'msg_1',
        'webhook-timestamp': String(ts),
        'webhook-signature': sign('msg_1', ts, body),
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(sms.sent.length).toBe(before + 1);
      expect(sms.sent[before]?.template).toBe('login_otp');
      // The same signed message delivered again is refused and sends nothing more.
      const replay = await call(body, {
        'webhook-id': 'msg_1',
        'webhook-timestamp': String(ts),
        'webhook-signature': sign('msg_1', ts, body),
      });
      expect(replay.statusCode).toBe(401);
      expect(sms.sent.length).toBe(before + 1);
    });

    it('answers malformed JSON with a fixed message that echoes none of the body', async () => {
      const res = await call('{"user":{"phone":"+919000000009"', {});
      expect(res.statusCode).toBe(400);
      expect(res.body).not.toContain('919000000009');
    });

    it('refuses a bad signature, a wrong secret and a stale timestamp, sending nothing', async () => {
      const before = sms.sent.length;
      const ts = Math.floor(Date.now() / 1000);
      const bad = await call(body, {
        'webhook-id': 'msg_2',
        'webhook-timestamp': String(ts),
        'webhook-signature': 'v1,AAAA',
      });
      expect(bad.statusCode).toBe(401);
      const other = await call(body, {
        'webhook-id': 'msg_3',
        'webhook-timestamp': String(ts),
        'webhook-signature': sign(
          'msg_3',
          ts,
          body,
          `v1,whsec_${randomBytes(24).toString('base64')}`,
        ),
      });
      expect(other.statusCode).toBe(401);
      const old = ts - 3600;
      const stale = await call(body, {
        'webhook-id': 'msg_4',
        'webhook-timestamp': String(old),
        'webhook-signature': sign('msg_4', old, body),
      });
      expect(stale.statusCode).toBe(401);
      expect((await call(body, {})).statusCode).toBe(401);
      expect(sms.sent.length).toBe(before);
    });
  });

  describe('slow or failing SMS provider', () => {
    it('fails the hook cleanly within the budget and reports no code as sent', async () => {
      const slow = {
        descriptor: sms.descriptor,
        send: () => new Promise<never>(() => undefined),
      };
      const slowApp = await buildApp(loadConfig({ APP_ENV: 'test' }), {
        auth: { verifier: fakeVerifier, context: createUserContext(apiPool) },
        borrower: {
          sms: slow,
          integrity: createMockIntegrityVerifier('test'),
          stepUpPepper: PEPPER,
          sendSmsHookSecret: HOOK_SECRET,
          smsTimeoutMs: 150,
        },
      });
      const body = JSON.stringify({ user: { phone: '+919000000002' }, sms: { otp: '123456' } });
      const ts = Math.floor(Date.now() / 1000);
      const signature = `v1,${createHmac(
        'sha256',
        Buffer.from(HOOK_SECRET.replace('v1,whsec_', ''), 'base64'),
      )
        .update(`msg_slow.${ts}.${body}`)
        .digest('base64')}`;
      const started = Date.now();
      const res = await slowApp.inject({
        method: 'POST',
        url: '/v1/hooks/send-sms',
        remoteAddress: freshAddress(),
        headers: {
          'content-type': 'application/json',
          'webhook-id': 'msg_slow',
          'webhook-timestamp': String(ts),
          'webhook-signature': signature,
        },
        payload: body,
      });
      expect(res.statusCode).toBe(500);
      expect(Date.now() - started).toBeLessThan(2000);
      expect(res.body).not.toContain('123456');
      // A step-up with the slow provider records "timeout", never "accepted".
      const challenge = await slowApp.inject({
        method: 'POST',
        url: '/v1/stepup/challenges',
        remoteAddress: freshAddress(),
        headers: { ...token(ids.b2), 'idempotency-key': `it-${randomUUID()}` },
        payload: { action: 'esign', contextRef: 'slow1' },
      });
      expect(challenge.statusCode, challenge.body).toBe(201);
      expect(challenge.json<{ delivery: string }>().delivery).toBe('timeout');
      await slowApp.close();
    });
  });

  describe('device integrity', () => {
    it('records the level the server verified, once per nonce, and ignores client claims', async () => {
      const { nonce } = (await post('/v1/integrity/nonce', ids.b1)).json<{ nonce: string }>();
      const res = await post('/v1/integrity/verify', ids.b1, {
        token: `mock:device:${nonce}`,
        nonce,
      });
      expect(res.json<{ status: string; level: string }>()).toEqual({
        status: 'verified',
        level: 'device',
      });
      const replay = await post('/v1/integrity/verify', ids.b1, {
        token: `mock:device:${nonce}`,
        nonce,
      });
      expect(replay.statusCode).toBe(409);
      const me = (await get('/v1/borrower/me', ids.b1)).json<{ integrityLevel: string }>();
      expect(me.integrityLevel).toBe('device');
      const strict = await post('/v1/integrity/verify', ids.b2, {
        token: 'mock:strong:other-nonce-value-1234',
        nonce: 'a-nonce-that-was-never-issued',
      });
      expect(strict.statusCode).toBe(409);
      expect(
        (await get('/v1/borrower/me', ids.b2)).json<{ integrityLevel: string }>().integrityLevel,
      ).toBe('none');
    });
  });

  describe('account deletion', () => {
    it('anonymises through the worker, keeps consent evidence, and is safe to repeat', async () => {
      await post('/v1/borrower/profile', ids.b3, { displayName: 'Temp Name' });
      const requested = await post('/v1/borrower/deletion-requests', ids.b3);
      expect(requested.statusCode, requested.body).toBeLessThan(300);
      const deletionId = requested.json<{ id: string }>().id;
      const queued = await admin.query<{ n: string }>(
        `select count(*) n from ops.outbox_events where event_type = 'borrower.deletion_requested' and payload ->> 'deletion_request_id' = $1`,
        [deletionId],
      );
      expect(Number(queued.rows[0]?.n)).toBe(1);
      // Run the handler directly: the shared outbox queue is also used by other test files running in parallel.
      await handlers['borrower.deletion_requested']?.run(
        { deletion_request_id: deletionId },
        {} as OutboxEvent,
      );
      await handlers['borrower.deletion_requested']?.run(
        { deletion_request_id: deletionId },
        {} as OutboxEvent,
      );
      const request = await admin.query<{ status: string; removed: boolean }>(
        `select d.status::text, (d.auth_identity_removed_at is not null) removed
           from identity.deletion_requests d join identity.borrowers b on b.id = d.borrower_id where b.user_id = $1`,
        [ids.b3],
      );
      expect(request.rows[0]?.status).toBe('anonymised');
      // The sign-in identity lives with the auth provider; its removal is not claimed until done.
      expect(request.rows[0]?.removed).toBe(false);
      const row = await admin.query<{
        display_name: string | null;
        onboarding_status: string;
        n: string;
      }>(
        `select display_name, onboarding_status,
                (select count(*) from consent.records r where r.borrower_id = b.id)::text n
           from identity.borrowers b where user_id = $1`,
        [ids.b3],
      );
      expect(row.rows[0]?.display_name).toBeNull();
      expect(row.rows[0]?.onboarding_status).toBe('anonymised');
      expect(Number(row.rows[0]?.n)).toBeGreaterThan(0);
      const repeat = await post('/v1/borrower/deletion-requests', ids.b3);
      expect(repeat.statusCode).toBe(403);
      expect(problemCode(repeat)).toBeDefined();
    });
  });
});
