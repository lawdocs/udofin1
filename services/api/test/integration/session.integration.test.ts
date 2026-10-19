// F-01 against a REAL migrated Postgres: an access token is honoured only while its session still exists in
// auth.sessions. Runs only with INTEGRATION_ADMIN_URL / INTEGRATION_API_URL (see api.integration.test.ts).
// The token verifier is faked (signature checking has its own tests); everything else is real: the HTTP app,
// the per-request transaction as role `authenticated`, private.session_is_active and auth.sessions.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { TokenError, type TokenVerifier } from '../../src/auth/token-verifier.js';
import { loadConfig, sessionIdRequired } from '../../src/config.js';
import { createUserContext } from '../../src/db/user-context.js';

const ADMIN = process.env.INTEGRATION_ADMIN_URL;
const API = process.env.INTEGRATION_API_URL;
const enabled = Boolean(ADMIN && API);

/** Tokens look like `test.<user>.<aal>.<session uuid | none>`. */
const fakeVerifier: TokenVerifier = {
  verify(header) {
    const match = /^Bearer test\.([0-9a-f-]{36})\.(aal1|aal2)\.([0-9a-f-]{36}|none)$/.exec(
      header ?? '',
    );
    if (!match?.[1] || !match[2] || !match[3]) return Promise.reject(new TokenError('invalid'));
    return Promise.resolve({
      sub: match[1],
      aal: match[2] as 'aal1' | 'aal2',
      sessionId: match[3] === 'none' ? null : match[3],
    });
  },
};
const token = (user: string, session: string | null, aal: 'aal1' | 'aal2' = 'aal2') => ({
  authorization: `Bearer test.${user}.${aal}.${session ?? 'none'}`,
});

let nextAddress = 1;
const freshAddress = () => `10.77.${(nextAddress >> 8) & 255}.${nextAddress++ & 255}`;

describe.skipIf(!enabled)('session revocation against a real database', () => {
  const ids = {
    lender: randomUUID(),
    staff: randomUUID(),
    otherStaff: randomUUID(),
    borrower: randomUUID(),
  };
  let admin: pg.Pool;
  let apiPool: pg.Pool;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let strictApp: Awaited<ReturnType<typeof buildApp>>;

  /** Creates a session row the way Supabase Auth would (id, user, optional time-box). */
  const newSession = async (user: string, notAfter: string | null = null) => {
    const id = randomUUID();
    await admin.query('insert into auth.sessions (id, user_id, not_after) values ($1, $2, $3)', [
      id,
      user,
      notAfter,
    ]);
    return id;
  };
  const endSession = (id: string) => admin.query('delete from auth.sessions where id = $1', [id]);

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: ADMIN, max: 2 });
    apiPool = new pg.Pool({ connectionString: API, max: 5 });
    for (const staff of [ids.staff, ids.otherStaff]) {
      await admin.query(
        `insert into auth.users (id, phone, raw_app_meta_data) values ($1, null, '{"actor_type":"staff"}')`,
        [staff],
      );
    }
    await admin.query(
      `insert into auth.users (id, phone, raw_app_meta_data) values ($1, $2, '{}')`,
      [ids.borrower, `91${Math.floor(1_000_000_000 + Math.random() * 8_999_999_999)}`],
    );
    await admin.query(
      `insert into tenancy.organizations (id, kind, legal_name, display_name, regulator_registration_no, status)
       values ($1, 'lender', 'Session IT Ltd', 'Session IT', $2, 'active')`,
      [ids.lender, `IT-SESSION-${randomUUID().slice(0, 8)}`],
    );
    const member = await admin.query<{ id: string }>(
      `insert into tenancy.memberships (org_id, user_id, status) values ($1, $2, 'active') returning id`,
      [ids.lender, ids.staff],
    );
    await admin.query(
      `insert into tenancy.membership_roles (membership_id, role_id)
       select $1, r.id from tenancy.roles r
        where r.org_id is null and r.applies_to = 'lender' and r.key = 'lender_admin'`,
      [member.rows[0]?.id],
    );
    const context = createUserContext(apiPool);
    // Local/test posture: a token without a session id is tolerated (fake verifiers).
    app = await buildApp(loadConfig({ APP_ENV: 'test' }), {
      auth: { verifier: fakeVerifier, context },
    });
    // Deployed posture: sessionIdRequired(config) is true, and server.ts passes exactly that.
    const deployedLike = { ...loadConfig({ APP_ENV: 'test' }), APP_ENV: 'staging' as const };
    expect(sessionIdRequired(deployedLike)).toBe(true);
    strictApp = await buildApp(loadConfig({ APP_ENV: 'test' }), {
      auth: { verifier: fakeVerifier, context, requireSessionId: sessionIdRequired(deployedLike) },
    });
  });

  afterAll(async () => {
    await app?.close();
    await strictApp?.close();
    await apiPool?.end();
    await admin?.end();
  });

  const get = (a: typeof app, url: string, headers: Record<string, string>) =>
    a.inject({ method: 'GET', url, remoteAddress: freshAddress(), headers });
  const startStepUp = (headers: Record<string, string>) =>
    app.inject({
      method: 'POST',
      url: '/v1/stepup/challenges',
      remoteAddress: freshAddress(),
      headers: { ...headers, 'idempotency-key': `it-${randomUUID()}` },
      payload: { action: 'esign', contextRef: 'session-it' },
    });

  it('accepts a token whose session is active, for staff and for borrowers', async () => {
    const staffSession = await newSession(ids.staff);
    const res = await get(app, '/v1/me', token(ids.staff, staffSession));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ actor: string }>().actor).toBe('lender');
    const borrowerSession = await newSession(ids.borrower);
    expect(
      (await get(app, '/v1/me', token(ids.borrower, borrowerSession, 'aal1'))).statusCode,
    ).toBe(200);
  });

  it('refuses the very next request after the session is ended (sign-out or revocation), on every kind of route', async () => {
    const staffSession = await newSession(ids.staff);
    const headers = token(ids.staff, staffSession);
    expect((await get(app, '/v1/admin/change-requests', headers)).statusCode).toBe(200);
    await endSession(staffSession);
    for (const url of ['/v1/me', '/v1/admin/change-requests']) {
      const res = await get(app, url, headers);
      expect(res.statusCode, url).toBe(401);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.json()).toMatchObject({ status: 401, code: 'session_revoked' });
      expect(res.headers['www-authenticate']).toContain('invalid_token');
    }

    // A borrower's step-up route (a sensitive action) is protected the same way.
    const borrowerSession = await newSession(ids.borrower);
    const borrowerHeaders = token(ids.borrower, borrowerSession, 'aal1');
    expect((await startStepUp(borrowerHeaders)).statusCode).not.toBe(401);
    await endSession(borrowerSession);
    const stepUp = await startStepUp(borrowerHeaders);
    expect(stepUp.statusCode).toBe(401);
    expect(stepUp.json()).toMatchObject({ code: 'session_revoked' });
  });

  it('leaves other sessions of the same user alone', async () => {
    const phone = await newSession(ids.staff);
    const laptop = await newSession(ids.staff);
    await endSession(phone);
    expect((await get(app, '/v1/me', token(ids.staff, phone))).statusCode).toBe(401);
    expect((await get(app, '/v1/me', token(ids.staff, laptop))).statusCode).toBe(200);
  });

  it('honours the session time-box: expired is refused, extended is accepted again', async () => {
    const session = await newSession(ids.staff, new Date(Date.now() - 60_000).toISOString());
    const headers = token(ids.staff, session);
    expect((await get(app, '/v1/me', headers)).json()).toMatchObject({ code: 'session_revoked' });
    await admin.query(
      `update auth.sessions set not_after = now() + interval '1 hour' where id = $1`,
      [session],
    );
    expect((await get(app, '/v1/me', headers)).statusCode).toBe(200);
  });

  it("refuses a token that names someone else's live session", async () => {
    const theirs = await newSession(ids.otherStaff);
    const res = await get(app, '/v1/me', token(ids.staff, theirs));
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'session_revoked' });
  });

  it('refuses an unknown session id', async () => {
    const res = await get(app, '/v1/me', token(ids.staff, randomUUID()));
    expect(res.json()).toMatchObject({ code: 'session_revoked' });
  });

  it('treats a missing session id as a config decision: tolerated locally, refused when deployed', async () => {
    expect((await get(app, '/v1/me', token(ids.staff, null))).statusCode).toBe(200);
    const strict = await get(strictApp, '/v1/me', token(ids.staff, null));
    expect(strict.statusCode).toBe(401);
    expect(strict.json()).toMatchObject({ code: 'token_invalid' });
    // With a live session the deployed-like app accepts the same user.
    const session = await newSession(ids.staff);
    expect((await get(strictApp, '/v1/me', token(ids.staff, session))).statusCode).toBe(200);
  });

  it('does not let the API login see auth.sessions directly (only the definer function does)', async () => {
    await expect(apiPool.query('select 1 from auth.sessions limit 1')).rejects.toMatchObject({
      code: '42501',
    });
  });
});
