// Browser end-to-end tests. Run: pnpm --filter @udofin/ops-portal build && pnpm --filter @udofin/lender-portal build
// then E2E=1 pnpm --filter @udofin/e2e test. They drive real Chromium against the built portals, with
// fake Supabase Auth and API servers (src/fakes.ts), so they prove the portals' behaviour only.
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createWorld,
  startFakeApi,
  startFakeAuth,
  type FakeUser,
  type FakeWorld,
} from '../src/fakes.js';
import { freePort, startPortal, type RunningPortal } from '../src/portal-process.js';

const enabled = process.env.E2E === '1';
const CHROMIUM = process.env.PLAYWRIGHT_CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';

const opsUser: FakeUser = {
  id: '0a0a0a0a-0000-4000-8000-000000000001',
  email: 'ops@udofin.example',
  password: 'correct horse battery',
  actor: 'platform',
  orgName: 'Udofin Platform',
  permissions: ['platform.organizations.manage', 'platform.organizations.read'],
};
const lenderUser: FakeUser = {
  id: '0b0b0b0b-0000-4000-8000-000000000001',
  email: 'admin@alpha.example',
  password: 'another long passphrase',
  actor: 'lender',
  orgName: 'Alpha Finance (test)',
  permissions: ['org.members.read'],
};

// Sign-in is rate-limited per account (8 per 15 minutes), so tests that sign in repeatedly use their own staff accounts.
const extraOps = (n: number): FakeUser => ({
  ...opsUser,
  id: `0a0a0a0a-0000-4000-8000-00000000010${String(n)}`,
  email: `ops${String(n)}@udofin.example`,
});
const ops2 = extraOps(2);
const ops3 = extraOps(3);
const ops4 = extraOps(4);
const ops5 = extraOps(5);

describe.skipIf(!enabled)('portals in a real browser', () => {
  let world: FakeWorld;
  let browser: Browser;
  let ops: RunningPortal;
  let lender: RunningPortal;
  const closers: (() => void)[] = [];

  beforeAll(async () => {
    world = createWorld([opsUser, lenderUser, ops2, ops3, ops4, ops5]);
    const auth = await startFakeAuth(world);
    const api = await startFakeApi(world);
    closers.push(
      () => auth.server.close(),
      () => api.server.close(),
    );
    const opsPort = await freePort();
    const lenderPort = await freePort();
    const common = {
      SUPABASE_URL: auth.url,
      SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_0123456789abcdef',
      API_BASE_URL: api.url,
      COOKIE_SECURE: 'false',
    };
    ops = await startPortal('ops-portal', opsPort, {
      ...common,
      PORTAL_ORIGIN: `http://127.0.0.1:${String(opsPort)}`,
    });
    lender = await startPortal('lender-portal', lenderPort, {
      ...common,
      PORTAL_ORIGIN: `http://127.0.0.1:${String(lenderPort)}`,
    });
    browser = await chromium.launch({ executablePath: CHROMIUM, args: ['--no-sandbox'] });
  });

  afterAll(async () => {
    await browser?.close();
    await ops?.stop();
    await lender?.stop();
    for (const close of closers) close();
  });

  async function fresh(): Promise<{ context: BrowserContext; page: Page; problems: string[] }> {
    const context = await browser.newContext();
    const page = await context.newPage();
    const problems: string[] = [];
    page.on('console', (m) => {
      // A missing favicon is cosmetic; every other failed resource or console error is a problem.
      if (m.type() === 'error' && !m.text().startsWith('Failed to load resource'))
        problems.push(m.text());
    });
    page.on('response', (r) => {
      if (
        r.status() >= 400 &&
        !r.url().endsWith('/favicon.ico') &&
        r.request().resourceType() !== 'fetch'
      ) {
        problems.push(`${String(r.status())} ${r.url()}`);
      }
    });
    page.on('pageerror', (e) => problems.push(e.message));
    return { context, page, problems };
  }

  async function signIn(page: Page, origin: string, user: FakeUser, code = '123456') {
    await page.goto(`${origin}/`);
    await page.waitForURL(`${origin}/login`);
    await page.getByLabel('Work email').fill(user.email);
    await page.getByLabel('Password').fill(user.password);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByLabel('6-digit code').fill(code);
    await page.getByRole('button', { name: 'Verify and continue' }).click();
  }

  it('redirects a visitor without a session to sign-in, with a nonce-based CSP', async () => {
    const { page, problems } = await fresh();
    const response = await page.goto(`${ops.origin}/`);
    expect(page.url()).toBe(`${ops.origin}/login`);
    const csp =
      response?.headers()['content-security-policy'] ??
      (await page.request.get(`${ops.origin}/login`)).headers()['content-security-policy'];
    expect(csp).toMatch(/script-src 'self' 'nonce-/);
    expect(csp).toContain("frame-ancestors 'none'");
    await page.getByRole('heading', { name: 'Sign in to Udofin Operations' }).waitFor();
    expect(problems).toEqual([]);
  });

  it('shows a generic error for wrong credentials and sets no cookies', async () => {
    const { context, page } = await fresh();
    await page.goto(`${ops.origin}/login`);
    await page.getByLabel('Work email').fill(opsUser.email);
    await page.getByLabel('Password').fill('wrong password');
    await page.getByRole('button', { name: 'Continue' }).click();
    expect(await page.locator('[role=alert].form-error').textContent()).toBe(
      'The email or password is not correct.',
    );
    expect(await context.cookies()).toEqual([]);
    await page.getByLabel('Work email').fill('nobody@udofin.example');
    await page.getByRole('button', { name: 'Continue' }).click();
    expect(await page.locator('[role=alert].form-error').textContent()).toBe(
      'The email or password is not correct.',
    );
  });

  it("first sign-in enrols the second factor, then lands on the home page with the user's access", async () => {
    const { context, page, problems } = await fresh();
    await page.goto(`${ops.origin}/login`);
    await page.getByLabel('Work email').fill(opsUser.email);
    await page.getByLabel('Password').fill(opsUser.password);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('heading', { name: 'Set up your authenticator app' }).waitFor();
    expect(await page.getByAltText('QR code for your authenticator app').isVisible()).toBe(true);
    await page.getByLabel('6-digit code').fill('000000');
    await page.getByRole('button', { name: 'Verify and continue' }).click();
    expect(await page.locator('[role=alert].form-error').textContent()).toContain(
      'That code is not correct',
    );
    await page.getByLabel('6-digit code').fill('123456');
    await page.getByRole('button', { name: 'Verify and continue' }).click();
    await page.waitForURL(`${ops.origin}/`);
    await page.getByRole('heading', { name: 'Your access' }).waitFor();
    expect(await page.getByText('platform.organizations.manage').isVisible()).toBe(true);

    // Tokens exist only in HttpOnly, SameSite=Strict cookies that page scripts cannot read.
    const cookies = await context.cookies();
    expect(cookies.map((c) => c.name).sort()).toEqual(['udofin_at', 'udofin_rt']);
    for (const c of cookies) {
      expect(c.httpOnly).toBe(true);
      expect(c.sameSite).toBe('Strict');
      expect(c.expires).toBe(-1); // session cookie
    }
    expect(await page.evaluate(() => document.cookie)).toBe('');
    expect(
      await page.evaluate(() => JSON.stringify([localStorage.length, sessionStorage.length])),
    ).toBe('[0,0]');
    expect(problems).toEqual([]);
  });

  it('a returning user is asked for the code only, and a lender account is refused in the operations portal', async () => {
    const lenderCtx = await fresh();
    await signIn(lenderCtx.page, lender.origin, lenderUser); // enrols (first time) and lands on the lender home
    await lenderCtx.page.getByRole('heading', { name: 'Udofin Lender Portal' }).waitFor();
    expect(
      await lenderCtx.page.getByRole('heading', { name: 'Alpha Finance (test)' }).isVisible(),
    ).toBe(true);
    await lenderCtx.context.close();

    const wrong = await fresh();
    await wrong.page.goto(`${ops.origin}/login`);
    await wrong.page.getByLabel('Work email').fill(lenderUser.email);
    await wrong.page.getByLabel('Password').fill(lenderUser.password);
    await wrong.page.getByRole('button', { name: 'Continue' }).click();
    await wrong.page.getByRole('heading', { name: 'Enter your authentication code' }).waitFor(); // already enrolled
    await wrong.page.getByLabel('6-digit code').fill('123456');
    await wrong.page.getByRole('button', { name: 'Verify and continue' }).click();
    expect(await wrong.page.locator('[role=alert].form-error').textContent()).toContain(
      'not set up for this portal',
    );
    expect(await wrong.context.cookies()).toEqual([]);
    await wrong.page.goto(`${ops.origin}/`);
    expect(wrong.page.url()).toBe(`${ops.origin}/login`);
  });

  it('lists change requests and approves one exactly once, even if the form is sent twice', async () => {
    const { page, problems } = await fresh();
    await signIn(page, ops.origin, ops2);
    await page.waitForURL(`${ops.origin}/`);
    await page.getByRole('link', { name: 'Change requests' }).click();
    await page.getByRole('heading', { name: 'Change requests' }).waitFor();
    expect(await page.getByRole('row', { name: /organization\.create/ }).isVisible()).toBe(true);

    const key = await page.locator('input[name="key"]').first().inputValue();
    const before = world.counters.approvals;
    await page.getByRole('button', { name: 'Approve' }).click();
    await page.getByRole('status').filter({ hasText: 'Request approved.' }).waitFor();
    expect(world.counters.approvals).toBe(before + 1);
    expect(world.approvalKeys.at(-1)).toBe(key);
    expect(problems).toEqual([]);
  });

  it('keeps the session alive by refreshing a nearly expired token, once per navigation', async () => {
    world.tokenLifetimeSeconds = 40; // always inside the 60-second refresh window
    try {
      const { page } = await fresh();
      await signIn(page, ops.origin, ops3);
      await page.waitForURL(`${ops.origin}/`);
      const before = world.counters.refresh;
      await page.goto(`${ops.origin}/`);
      await page.getByRole('heading', { name: 'Your access' }).waitFor();
      expect(world.counters.refresh).toBeGreaterThan(before);
    } finally {
      world.tokenLifetimeSeconds = 900;
    }
  });

  it('shows the signed-out state when the access token has expired and the refresh token is revoked', async () => {
    world.tokenLifetimeSeconds = 3;
    try {
      const { context, page } = await fresh();
      await signIn(page, ops.origin, ops4);
      await page.waitForURL(`${ops.origin}/`);
      world.revokeAllRefresh();
      await page.waitForTimeout(4000); // the access token in the cookie is now past its expiry
      await page.goto(`${ops.origin}/`);
      await page.waitForURL(`${ops.origin}/login`);
      expect(await context.cookies()).toEqual([]);
    } finally {
      world.tokenLifetimeSeconds = 900;
    }
  });

  it('signs out: cookies cleared, session revoked server-side, protected pages redirect', async () => {
    const { context, page } = await fresh();
    await signIn(page, ops.origin, ops5);
    await page.waitForURL(`${ops.origin}/`);
    const logoutsBefore = world.counters.logout;
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.waitForURL(`${ops.origin}/login`);
    expect(await context.cookies()).toEqual([]);
    expect(world.counters.logout).toBe(logoutsBefore + 1);
    await page.goto(`${ops.origin}/change-requests`);
    expect(page.url()).toBe(`${ops.origin}/login`);
  });

  it('rejects cross-origin and non-JSON posts to the auth endpoints', async () => {
    const { page } = await fresh();
    const evil = await page.request.post(`${ops.origin}/auth/sign-in`, {
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      data: { email: opsUser.email, password: opsUser.password },
    });
    expect(evil.status()).toBe(403);
    const form = await page.request.post(`${ops.origin}/auth/sign-in`, {
      headers: { origin: ops.origin },
      form: { email: opsUser.email, password: opsUser.password },
    });
    expect(form.status()).toBe(415);
    expect(evil.headers()['set-cookie']).toBeUndefined();
  });

  it('never leaks tokens or the Supabase URL into page source', async () => {
    const { page } = await fresh();
    await signIn(page, ops.origin, ops2);
    await page.waitForURL(`${ops.origin}/`);
    const html = await page.content();
    for (const session of world.sessions.values()) {
      expect(html).not.toContain(session.accessToken);
      expect(html).not.toContain(session.refreshToken);
    }
    expect(html).not.toContain('sb_publishable_');
  });
});
