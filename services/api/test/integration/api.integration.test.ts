// Integration tests against a REAL migrated Postgres through the real HTTP app. They run only when
// INTEGRATION_ADMIN_URL (owner, used for fixtures), INTEGRATION_API_URL (udofin_api) and
// INTEGRATION_SYSTEM_URL (udofin_system) are set; see docs/testing/strategy.md. The database must be
// disposable: fixtures are not cleaned up.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { TokenError, type TokenVerifier } from '../../src/auth/token-verifier.js';
import { loadConfig } from '../../src/config.js';
import { assertUserLoginPosture, LoginPostureError } from '../../src/db/login-posture.js';
import { createUserContext } from '../../src/db/user-context.js';
import { createSystemServices } from '../../src/system/index.js';

const ADMIN = process.env.INTEGRATION_ADMIN_URL;
const API = process.env.INTEGRATION_API_URL;
const SYSTEM = process.env.INTEGRATION_SYSTEM_URL;
const enabled = Boolean(ADMIN && API && SYSTEM);

/** Test tokens look like `test.<user uuid>.<aal>`; the real verifier is covered separately. */
const fakeVerifier: TokenVerifier = {
  verify(header) {
    const match = /^Bearer test\.([0-9a-f-]{36})\.(aal1|aal2)$/.exec(header ?? '');
    if (!match?.[1] || !match[2]) return Promise.reject(new TokenError('invalid'));
    return Promise.resolve({ sub: match[1], aal: match[2] as 'aal1' | 'aal2', sessionId: null });
  },
};
const token = (user: string, aal: 'aal1' | 'aal2' = 'aal2') => ({
  authorization: `Bearer test.${user}.${aal}`,
});

describe.skipIf(!enabled)('API against a real database', () => {
  const ids = {
    platformOrg: randomUUID(),
    lenderA: randomUUID(),
    lenderB: randomUUID(),
    p1: randomUUID(),
    p2: randomUUID(),
    aAdmin: randomUUID(),
    aSuspended: randomUUID(),
    bAdmin: randomUUID(),
    nobody: randomUUID(),
    borrower: randomUUID(),
  };
  let admin: pg.Pool;
  let apiPool: pg.Pool;
  let system: ReturnType<typeof createSystemServices>;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: ADMIN, max: 2 });
    apiPool = new pg.Pool({ connectionString: API, max: 4 });
    system = createSystemServices(SYSTEM ?? '');

    const staff = [ids.p1, ids.p2, ids.aAdmin, ids.aSuspended, ids.bAdmin, ids.nobody];
    for (const id of staff) {
      await admin.query(
        `insert into auth.users (id, phone, raw_app_meta_data) values ($1, null, '{"actor_type":"staff"}')`,
        [id],
      );
    }
    await admin.query(
      `insert into auth.users (id, phone, raw_app_meta_data) values ($1, $2, '{}')`,
      [ids.borrower, `91${Math.floor(1_000_000_000 + Math.random() * 8_999_999_999)}`],
    );
    await admin.query(
      `insert into tenancy.organizations (id, kind, legal_name, display_name, regulator_registration_no, status) values
        ($1, 'platform', 'Udofin Platform (it)', 'Udofin', null, 'active'),
        ($2, 'lender', 'Alpha IT Ltd', 'Alpha IT', 'IT-NBFC-A', 'active'),
        ($3, 'lender', 'Beta IT Ltd', 'Beta IT', 'IT-NBFC-B', 'active')`,
      [ids.platformOrg, ids.lenderA, ids.lenderB],
    );
    const members: [string, string, string, string][] = [
      [ids.platformOrg, ids.p1, 'active', 'platform_admin'],
      [ids.platformOrg, ids.p2, 'active', 'platform_admin'],
      [ids.lenderA, ids.aAdmin, 'active', 'lender_admin'],
      [ids.lenderA, ids.aSuspended, 'suspended', 'lender_admin'],
      [ids.lenderB, ids.bAdmin, 'active', 'lender_admin'],
    ];
    for (const [org, user, status, role] of members) {
      const m = await admin.query<{ id: string }>(
        'insert into tenancy.memberships (org_id, user_id, status) values ($1, $2, $3) returning id',
        [org, user, status],
      );
      await admin.query(
        `insert into tenancy.membership_roles (membership_id, role_id)
         select $1, r.id from tenancy.roles r join tenancy.organizations o on o.kind = r.applies_to
          where o.id = $2 and r.org_id is null and r.key = $3`,
        [m.rows[0]?.id, org, role],
      );
    }

    app = await buildApp(loadConfig({ APP_ENV: 'test' }), {
      auth: { verifier: fakeVerifier, context: createUserContext(apiPool) },
      changeRequestApplier: system.changeRequestApplier,
    });
  });

  afterAll(async () => {
    await app?.close();
    await system?.close();
    await apiPool?.end();
    await admin?.end();
  });

  const me = (headers: Record<string, string>) =>
    app.inject({ method: 'GET', url: '/v1/me', headers });

  it('requires a token', async () => {
    expect((await me({})).statusCode).toBe(401);
    expect((await me({ authorization: 'Bearer garbage' })).statusCode).toBe(401);
  });

  it('returns identity, memberships and permissions resolved by the database', async () => {
    const res = await me(token(ids.aAdmin));
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      actor: string;
      memberships: { organizationId: string; permissions: string[] }[];
    }>();
    expect(body.actor).toBe('lender');
    expect(body.memberships).toHaveLength(1);
    expect(body.memberships[0]?.organizationId).toBe(ids.lenderA);
    expect(body.memberships[0]?.permissions).toContain('org.members.manage');
  });

  it('refuses staff without the second factor, but not borrowers', async () => {
    const staff = await me(token(ids.aAdmin, 'aal1'));
    expect(staff.statusCode).toBe(401);
    expect(staff.json<{ code: string }>().code).toBe('mfa_required');
    const borrower = await me(token(ids.borrower, 'aal1'));
    expect(borrower.statusCode).toBe(200);
    expect(borrower.json<{ actor: string }>().actor).toBe('borrower');
  });

  it('refuses a suspended membership and a user with no access on the next request', async () => {
    expect((await me(token(ids.aSuspended))).statusCode).toBe(403);
    expect((await me(token(ids.nobody))).statusCode).toBe(403);
  });

  it('does not let a borrower use staff routes', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/change-requests',
      headers: token(ids.borrower, 'aal1'),
    });
    expect(res.statusCode).toBe(403);
  });

  it('runs the two-person flow end to end and applies the change', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/v1/admin/change-requests',
      headers: { ...token(ids.p1), 'idempotency-key': `it-${randomUUID()}` },
      payload: {
        type: 'organization.create',
        payload: {
          kind: 'lender',
          legal_name: `Gamma IT ${ids.p1}`,
          display_name: 'Gamma IT',
          regulator_registration_no: 'IT-NBFC-C',
        },
      },
    });
    expect(create.statusCode).toBe(201);
    const id = create.json<{ id: string }>().id;

    const self = await app.inject({
      method: 'POST',
      url: `/v1/admin/change-requests/${id}/approve`,
      headers: token(ids.p1),
      payload: {},
    });
    expect(self.statusCode).toBe(403);

    const lenderTries = await app.inject({
      method: 'POST',
      url: `/v1/admin/change-requests/${id}/approve`,
      headers: token(ids.aAdmin),
      payload: {},
    });
    expect(lenderTries.statusCode).toBe(404);

    const approve = await app.inject({
      method: 'POST',
      url: `/v1/admin/change-requests/${id}/approve`,
      headers: token(ids.p2),
      payload: {},
    });
    expect(approve.statusCode).toBe(200);
    const done = approve.json<{ status: string; result: { organization_id: string } }>();
    expect(done.status).toBe('applied');
    const org = await admin.query<{ status: string }>(
      'select status::text from tenancy.organizations where id = $1',
      [done.result.organization_id],
    );
    expect(org.rows[0]?.status).toBe('onboarding');
  });

  it('keeps tenants apart on the change-request routes', async () => {
    const own = await app.inject({
      method: 'POST',
      url: '/v1/admin/change-requests',
      headers: { ...token(ids.aAdmin), 'idempotency-key': `it-${randomUUID()}` },
      payload: {
        type: 'membership.suspend',
        targetOrganizationId: ids.lenderB,
        payload: { membership_id: randomUUID() },
      },
    });
    expect(own.statusCode).toBe(403);
    const list = await app.inject({
      method: 'GET',
      url: '/v1/admin/change-requests',
      headers: token(ids.bAdmin),
    });
    const items = list.json<{ items: { targetOrganizationId: string | null }[] }>().items;
    expect(items.every((i) => i.targetOrganizationId === ids.lenderB)).toBe(true);
  });

  it('requires an Idempotency-Key on POST', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/change-requests',
      headers: token(ids.p1),
      payload: { type: 'organization.activate', targetOrganizationId: ids.lenderA },
    });
    expect(res.statusCode).toBe(400);
  });

  it('boot guard accepts the API login and refuses the system login', async () => {
    await expect(assertUserLoginPosture(apiPool)).resolves.toBeUndefined();
    const sysAsUser = new pg.Pool({ connectionString: SYSTEM, max: 1 });
    try {
      await expect(assertUserLoginPosture(sysAsUser)).rejects.toBeInstanceOf(LoginPostureError);
    } finally {
      await sysAsUser.end();
    }
  });

  it('the API login cannot read tables directly, only through the assumed role', async () => {
    await expect(
      apiPool.query('select 1 from tenancy.organizations limit 1'),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(apiPool.query('set role service_role')).rejects.toMatchObject({ code: '42501' });
  });
});
