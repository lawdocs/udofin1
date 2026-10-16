import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';

/**
 * Fake Supabase Auth (GoTrue) and Udofin API for browser tests. These are test doubles: they exist
 * only here and prove the portals' behaviour, not Supabase's. TOTP codes are accepted when equal to
 * "123456".
 */
export interface FakeUser {
  id: string;
  email: string;
  password: string;
  actor: 'platform' | 'lender';
  orgName: string;
  permissions: string[];
}

interface Session {
  userId: string;
  accessToken: string;
  refreshToken: string;
  aal: 'aal1' | 'aal2';
}

const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (claims: Record<string, unknown>) => `${enc({ alg: 'ES256' })}.${enc(claims)}.c2ln`;

export interface FakeWorld {
  users: FakeUser[];
  tokenLifetimeSeconds: number;
  sessions: Map<string, Session>; // by access token
  refreshTokens: Map<string, Session>;
  verifiedFactors: Set<string>; // user ids
  counters: { signIn: number; refresh: number; logout: number; approvals: number };
  approvalKeys: string[];
  revokeAllRefresh(): void;
}

export function createWorld(users: FakeUser[]): FakeWorld {
  const world: FakeWorld = {
    users,
    tokenLifetimeSeconds: 900,
    sessions: new Map(),
    refreshTokens: new Map(),
    verifiedFactors: new Set(),
    counters: { signIn: 0, refresh: 0, logout: 0, approvals: 0 },
    approvalKeys: [],
    revokeAllRefresh() {
      world.refreshTokens.clear();
    },
  };
  return world;
}

function issue(world: FakeWorld, userId: string, aal: 'aal1' | 'aal2'): Session {
  const accessToken = jwt({
    sub: userId,
    aal,
    exp: Math.floor(Date.now() / 1000) + world.tokenLifetimeSeconds,
    role: 'authenticated',
    n: randomUUID(),
  });
  const session: Session = { userId, accessToken, refreshToken: `rt-${randomUUID()}`, aal };
  world.sessions.set(accessToken, session);
  world.refreshTokens.set(session.refreshToken, session);
  return session;
}

const sessionBody = (world: FakeWorld, s: Session) => ({
  access_token: s.accessToken,
  refresh_token: s.refreshToken,
  expires_at: Math.floor(Date.now() / 1000) + world.tokenLifetimeSeconds,
  user: { id: s.userId },
});

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  contentType = 'application/json',
) {
  res.writeHead(status, { 'content-type': contentType });
  res.end(JSON.stringify(body));
}

const bearer = (req: IncomingMessage) => /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];

export function startFakeAuth(world: FakeWorld): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://x');
      const path = url.pathname + url.search;
      if (req.method === 'POST' && path === '/auth/v1/token?grant_type=password') {
        const body = await readJson(req);
        world.counters.signIn += 1;
        const user = world.users.find(
          (u) => u.email === body.email && u.password === body.password,
        );
        if (!user)
          return send(res, 400, {
            error_code: 'invalid_credentials',
            msg: 'Invalid login credentials',
          });
        return send(res, 200, sessionBody(world, issue(world, user.id, 'aal1')));
      }
      if (req.method === 'POST' && path === '/auth/v1/token?grant_type=refresh_token') {
        const body = await readJson(req);
        const old = world.refreshTokens.get(String(body.refresh_token));
        if (!old) return send(res, 400, { error_code: 'refresh_token_not_found' });
        world.refreshTokens.delete(old.refreshToken); // rotation: a refresh token works once
        world.counters.refresh += 1;
        return send(res, 200, sessionBody(world, issue(world, old.userId, old.aal)));
      }
      if (req.method === 'POST' && path === '/auth/v1/logout?scope=local') {
        world.counters.logout += 1;
        const s = world.sessions.get(bearer(req) ?? '');
        if (s) {
          world.sessions.delete(s.accessToken);
          world.refreshTokens.delete(s.refreshToken);
        }
        res.writeHead(204);
        return res.end();
      }
      const session = world.sessions.get(bearer(req) ?? '');
      if (!session) return send(res, 401, { error_code: 'bad_jwt' });
      if (req.method === 'GET' && path === '/auth/v1/user') {
        return send(res, 200, {
          id: session.userId,
          factors: world.verifiedFactors.has(session.userId)
            ? [{ id: `f-${session.userId}`, factor_type: 'totp', status: 'verified' }]
            : [],
        });
      }
      if (req.method === 'POST' && path === '/auth/v1/factors') {
        return send(res, 200, {
          id: `f-${session.userId}`,
          type: 'totp',
          totp: {
            qr_code: `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>').toString('base64')}`,
            secret: 'JBSWY3DPEHPK3PXP',
            uri: 'otpauth://totp/Udofin',
          },
        });
      }
      if (req.method === 'POST' && path.endsWith('/challenge'))
        return send(res, 200, { id: 'challenge-1' });
      if (req.method === 'POST' && path.endsWith('/verify')) {
        const body = await readJson(req);
        if (body.code !== '123456')
          return send(res, 400, { error_code: 'mfa_verification_failed' });
        world.verifiedFactors.add(session.userId);
        return send(res, 200, sessionBody(world, issue(world, session.userId, 'aal2')));
      }
      return send(res, 404, {});
    })().catch(() => send(res, 500, {}));
  });
  return listen(server);
}

export function startFakeApi(world: FakeWorld): Promise<{ server: Server; url: string }> {
  const replays = new Map<string, unknown>();
  const server = createServer((req, res) => {
    void (() => {
      const url = new URL(req.url ?? '/', 'http://x');
      const session = world.sessions.get(bearer(req) ?? '');
      const problem = (status: number, code: string) =>
        send(
          res,
          status,
          { type: 'about:blank', title: code, status, code, instance: 'req' },
          'application/problem+json',
        );
      if (!session) return problem(401, 'token_invalid');
      const exp = (
        JSON.parse(
          Buffer.from(session.accessToken.split('.')[1] ?? '', 'base64url').toString(),
        ) as { exp: number }
      ).exp;
      if (exp < Math.floor(Date.now() / 1000)) return problem(401, 'token_expired');
      const user = world.users.find((u) => u.id === session.userId);
      if (!user) return problem(403, 'no_active_access');
      if (session.aal !== 'aal2') return problem(401, 'mfa_required');
      if (req.method === 'GET' && url.pathname === '/v1/me') {
        return send(res, 200, {
          userId: user.id,
          actor: user.actor,
          memberships: [
            {
              membershipId: randomUUID(),
              organizationId: randomUUID(),
              organizationKind: user.actor,
              organizationName: user.orgName,
              permissions: user.permissions,
            },
          ],
        });
      }
      if (req.method === 'GET' && url.pathname === '/v1/admin/change-requests') {
        return send(res, 200, {
          items: [
            {
              id: '11111111-1111-4111-8111-111111111111',
              type: 'organization.create',
              targetOrganizationId: null,
              status: 'pending',
              requestedBy: '22222222-2222-4222-8222-222222222222',
              decidedBy: null,
              createdAt: '2026-10-13 10:00:00+00',
              expiresAt: '2026-10-20 10:00:00+00',
            },
          ],
          nextCursor: null,
        });
      }
      const decide = /^\/v1\/admin\/change-requests\/([0-9a-f-]{36})\/(approve|reject)$/.exec(
        url.pathname,
      );
      if (req.method === 'POST' && decide) {
        const key = req.headers['idempotency-key'];
        if (typeof key !== 'string') return problem(400, 'idempotency_key_required');
        const replay = replays.get(key);
        if (replay) return send(res, 200, replay);
        world.counters.approvals += 1;
        world.approvalKeys.push(key);
        const body = { id: decide[1], status: decide[2] === 'approve' ? 'approved' : 'rejected' };
        replays.set(key, body);
        return send(res, 200, body);
      }
      return problem(404, 'not_found');
    })();
  });
  return listen(server);
}

function listen(server: Server): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ server, url: `http://127.0.0.1:${String(port)}` });
    });
  });
}
