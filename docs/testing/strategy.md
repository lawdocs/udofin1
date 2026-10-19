# Testing strategy

- **Date:** 2026-10-10. **Owner:** engineering lead (not yet appointed). **Approver:** product owner.
- **Related:** [`../security/checklist.md`](../security/checklist.md) (PR and release gates),
  [`../security/threat-model.md`](../security/threat-model.md) (abuse cases AC-01 to AC-21 and gaps
  G-01 to G-25), [`../product/roadmap.md`](../product/roadmap.md) (phases),
  `.github/workflows/ci.yml`.

Tests in Udofin are evidence. A lender's auditor, a regulator's inspector or the product owner
should be able to read a test name and understand which rule it proves. So:

1. Every business rule is tested at the layer that enforces it, and money, tenancy and consent
   rules are enforced (and tested) in the database as well as in the API.
2. Every feature has negative tests: what must be refused, for whom, across tenants.
3. Tests use synthetic data only. No real borrower, lender or provider data in any test, fixture
   or non-production environment, ever.
4. Automated tests use mocks only; provider sandboxes are exercised in separate, labelled suites
   (section 7).
5. We report only tests that actually ran.

---

## 1. What exists today

Counted on 2026-10-13 (end of Phase 03) by running each suite. All pass. (The 2026-10-10 baseline had 81 vitest tests and 145 pgTAP assertions.)

| Area                                       | Tool                                        | Tests / assertions   | What they prove                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------ | ------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Database (`supabase/tests`)                | pgTAP                                       | **239**              | Phase 01 structure, tenant isolation, lifecycle and hardening (145); change control, login roles, collections/DLG segregation (39); **authorisation matrix** (8: every domain table and role, every permission grant); idempotency and outbox (47).                                                                |
| API (`services/api/test`)                  | vitest + Fastify `inject`                   | **65** unit/contract | Token verification, `withUserContext` handle lifetime, login posture, import boundary, idempotency helpers, outbox worker logic, OpenAPI contract (every route declared, responses validated, committed document current), config, logging.                                                                        |
| API integration                            | vitest, real HTTP app + real database       | **27**               | Authentication and authorisation, cross-tenant refusal, idempotency (concurrent duplicates, retry after failure, key reuse, expiry), atomic outbox, duplicate delivery, abandoned worker, concurrent workers, retry limits, safe logging. Skipped unless the `INTEGRATION_*_URL` variables are set (CI sets them). |
| Auth client (`packages/auth-client`)       | vitest                                      | **59**               | Auth server client, session manager (single-flight refresh, revoked sessions), web BFF handlers (cookies, CSRF, rate limits, MFA, refresh), portal and key configuration.                                                                                                                                          |
| Portal kit (`packages/portal-kit`)         | vitest + Testing Library (jsdom)            | **10**               | Sign-in and second-factor flows, error messages, accessible names, landmarks.                                                                                                                                                                                                                                      |
| Browser (`tests/e2e`)                      | Playwright (Chromium) against built portals | **10**               | Redirects, CSP, sign-in and enrolment, wrong credentials, wrong portal, cookie flags, nothing in storage or page source, refresh, revoked session, sign-out, CSRF, idempotent approval. Fake Supabase Auth and API. Run with `E2E=1`.                                                                              |
| Mobile (`apps/mobile`)                     | vitest (pure modules)                       | **16**               | Configuration refuses privileged keys, keystore chunking and torn writes, phone normalisation, OTP guard rails. UI is type-checked, linted and bundled (`expo export`) but **not run on a device**; `config:check` asserts the permission policy.                                                                  |
| Domain, contracts, design tokens, adapters | vitest                                      | 36 + 12 + 8 + 3      | As before.                                                                                                                                                                                                                                                                                                         |

Total (counted 2026-10-13, Phase 04 addendum A): **248 vitest tests** run by default, plus **56 API integration tests** (when a database is configured), **10 browser tests** (`E2E=1`; none cover the onboarding, product or transactions screens yet) and **403 pgTAP assertions** (376 + 27 in `009_panel_and_waiver`).

**Phase 05 (13 Oct 2026, borrower onboarding):** **308 vitest tests** run by default across the workspaces (domain 36, contracts 12, adapters 22, auth-client 72, mobile 53, portal-kit 38, design-tokens 8, API 67), **77 API integration tests** against a real migrated database (of which 21 are the borrower flows over HTTP), **10 browser tests** (`E2E=1`, portals only; re-run as a regression check) and **486 pgTAP assertions** (83 in `010_borrower_onboarding`). The mobile tests cover pure modules (translation parity, money, tenure, expiry, journey, form state, step-up states, API client); **no screen has been rendered or run on a device**, and no mobile UI test exists.

**Phase 01/02 remediation (14 Oct 2026, commit `40e2c32`):** **1025 pgTAP assertions** in 14 files (013 remediation database: 142; 014 remediation runtime: 37), **vitest** domain 36, contracts 12, design-tokens 8, auth-client 90, mobile 80, portal-kit 52, adapters 53 and **290 API tests with none skipped when the `INTEGRATION_*` variables are set** (the root `pnpm test` now passes them through Turborepo), the 10 browser tests (`E2E=1`), `scripts/check-audit-ignores.mjs`, and CI green on all five jobs for that commit. PDF text tests now fail instead of skipping when `CI` is set and `pdftotext` is missing. Not covered: hosted Supabase settings, restore of a managed project (the local drill in `scripts/restore-drill.sh` proves only dump/restore and catalogue invariants), a real provider, device runs.

**Phase 07 (14 Oct 2026, KFS, documents, acceptance):** **387 vitest tests** run by default (domain 36, contracts 12, adapters 52, auth-client 80, mobile 80, portal-kit 52, design-tokens 8, API 67), **130 API integration tests** against a real migrated database (23 on documents: unapproved rule/calendar refusal, named reviewer, approval of the exact hash, acknowledgement, offer-bound step-up acceptance, mock-only signing, delivery), run on a freshly migrated database twice, **825 pgTAP assertions** (178 in `012_documents_kfs_acceptance`, with cross-tenant negative tests) and the 10 existing browser tests (re-run; none cover the new screens). English and Hindi PDF rendering tests depend on `pdftotext` (they return silently when it is absent). Not covered: any real signing or SMS provider, any device run of the mobile screens, browser tests of the document screens, pgTAP for `register_upload`, the self-approval toggle and retired-notice withdrawal, an integration test of active-content PDF rejection.

**Phase 06 (13 Oct 2026, lender routing and offers):** **337 vitest tests** run by default (domain 36, contracts 12, adapters 31, auth-client 72, mobile 66, portal-kit 45, design-tokens 8, API 67), **107 API integration tests** against a real migrated database (30 of them lender routing over HTTP, including a two-connection consent-withdrawal race and a canary scan proving the borrower's phone number is stored in no Udofin table), **647 pgTAP assertions** (161 in `011_lender_routing_offers`, with cross-tenant negative tests for every new table) and the 10 browser tests (see the Phase 06 report for whether they were re-run). Test categories A to K are mapped in `docs/specs/06-verification-offers.md` (implementation record). Not covered: a real lender, real SMS, any device run of the mobile screens, browser tests of the new lender-portal screens.

**Phase 08a (19 Oct 2026, servicing, payments, mandates, reconciliation, reminders; after two independent adversarial reviews and a fix wave):** **5,293 pgTAP assertions in 31 files** (015 to 030 are Phase 08a: foundation, accounts and configuration, servicing sync, documents, provider events and payments, reminders, mandates, reconciliation, API reads, and the fix-wave files 024 to 029 and the cross-area flows in 030, with cross-tenant negative tests for every new table) run on a freshly migrated local Postgres 16 and, in CI, on the Supabase stack (Postgres 17). **1,167 API tests in 49 files**, of which 683 are integration tests against a real migrated database and run with the `INTEGRATION_*` variables set; with `CI` set, the file that needs a pristine database (`lender-accounts`) is run first by a fixed file order and fails loudly instead of skipping. **Portal kit 1,228 tests in 15 files**, mobile 339 (pure modules; no screen was rendered on a device), adapters 434, auth-client 103, domain 43, contracts 21 and design tokens 8. The CI browser job (Chromium against the built portals, fake Supabase Auth and API) was green on the pushed head; none of its 10 tests drives the Phase 08a screens. The fix wave added mutation checks: a fix is counted only where its test fails once the guard is removed (30 mutations of the cross-area migration, 21 of 22 for the account screens). Not covered: any real payment provider, mandate rail, bank, lender system, push or SMS provider; any device or emulator run of the mobile screens; a browser test of the Phase 08a portal pages (the pages are thin and their logic is tested in the portal kit); load or timing tests; the hours just after India midnight for the reminder window (checked by reasoning only); and anything that depends on the unverified figures listed in `docs/operations/phase-08a-activation-gates.md`.

Not yet covered: screen-reader and axe scans, mobile component tests on a device, k6 performance, backup and DR drills, a true staging end-to-end run against a real Supabase project.

------------------------------------------------- | ------------------------- | ----- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API (`services/api/test`) | vitest + Fastify `inject` | 3 | **22** | Health endpoints (liveness never touches dependencies; readiness times out and never leaks errors); problem+json for unknown routes; security headers and `no-store`; request-id validation; rate limiting; 5xx hides internals; configuration fails fast and never echoes values; CORS rules when deployed; log redaction. |
| Domain (`packages/domain`) | vitest | 3 | **36** | Money in paise (27: exact parsing, arithmetic, loss-free allocation, Indian formatting); state-machine definitions (4); the application lifecycle matches the database enum and transition table, including who may act (5, `test/lifecycle-sync.test.ts`). |
| Contracts (`packages/contracts`) | vitest | 2 | **12** | Event envelope validation (type naming, timestamps with offset, data classification required); `MoneyMinor` wire format. |
| Design tokens (`packages/design-tokens`) | vitest | 1 | **8** | WCAG contrast calculation; base themes legible; lender branding limited to primary/onPrimary/accent, status colours locked, unreadable combinations refused. |
| Adapters (`packages/adapters`) | vitest | 1 | **3** | Provider mode guard: live providers only in production; mocks only in automated tests. |
| Database (`supabase/tests`) | pgTAP | 4 | **145 assertions** (7 + 34 + 69 + 35) | `001_structure`: RLS enabled/forced, no `anon`/`public` grants, no DELETE for `authenticated`, definer functions pinned. `002_tenant_isolation`: lender A vs B, borrower 1 vs 2, ops agent read-only, staff without role, suspended membership. `003_lifecycle_and_integrity`: lifecycle actors, disbursement evidence, offers, payment intents, idempotency, webhook de-duplication, append-only records, maker-checker, consent immutability, audit actor and tamper detection. |
| Portals (`apps/ops-portal`, `apps/lender-portal`) | — | 0 | 0 | Type-checked and linted only. |
| Mobile (`apps/mobile`) | — | 0 | 0 | Type-checked and linted; `config:check` asserts the permission block-list, no declared permissions, OTA off, backups off. |

Total: 81 vitest tests and 145 pgTAP assertions.

Note on the domain count: the baseline brief recorded 31 domain tests. That figure covers
`packages/domain/src` (27 money + 4 state machine). The 5 lifecycle-sync tests in
`packages/domain/test/lifecycle-sync.test.ts` were added afterwards, giving 36.

---

## 2. How to run what exists

### 2.1 Prerequisites

- Node 24 LTS (`.nvmrc`; `package.json` engines allow `>=22.13.0 <25`), pnpm 10 (`packageManager`).
- `pnpm install --frozen-lockfile` from the repository root.

### 2.2 Unit, API, lint and type checks

| Command                          | What it does                                                                                                                       |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm test`                      | Turborepo runs `test` in every workspace that has one (it builds dependencies first). Today: `services/api` and the four packages. |
| `pnpm typecheck`                 | `tsc --noEmit` in every workspace, including the portals and the mobile app.                                                       |
| `pnpm lint`                      | ESLint (flat config, type-aware) in every workspace.                                                                               |
| `pnpm format:check`              | Prettier check of the whole repository.                                                                                            |
| `pnpm check`                     | `format:check`, `lint`, `typecheck` and `test` in sequence: run this before every push.                                            |
| `pnpm --filter @udofin/api test` | One workspace only (replace the package name as needed).                                                                           |

### 2.3 Database tests (migrations + pgTAP)

**Locally on plain PostgreSQL** (needs PostgreSQL 16 or later, the pgTAP extension and `pg_prove`
on `PATH`):

```bash
PGHOST=/tmp PGPORT=5432 PGUSER=postgres bash scripts/db-test-local.sh
# or: pnpm db:test:local   (uses PGHOST/PGPORT/PGUSER from the environment)
```

The script drops and recreates a throwaway database (`udofin_test`, or the name in
`UDOFIN_TEST_DB`), applies `scripts/db/local-supabase-shim.sql` (a local-only imitation of the
Supabase roles, `auth.users` and `auth.uid()`; never applied to any shared environment), installs
pgTAP, applies every file in `supabase/migrations/` in order, applies `supabase/seed.sql` if one
exists, then runs `pg_prove` over `supabase/tests/*.test.sql`. Point it only at a local server: it
drops the target database.

**On the Supabase stack** (needs Docker and the Supabase CLI):

```bash
supabase db start      # local Supabase Postgres 17 (major_version in supabase/config.toml), applies migrations
supabase test db       # runs the pgTAP files in supabase/tests
```

### 2.4 Continuous integration

`.github/workflows/ci.yml` runs on every pull request and on pushes to `main`:

| Job           | Steps                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `quality`     | `pnpm install --frozen-lockfile`, installation of `poppler-utils` (the PDF tests need `pdftotext` and fail in CI without it), `format:check`, `build`, `lint`, `typecheck`, `test`; `config:check` of the mobile app with `APP_ENV=production`; `node scripts/check-audit-ignores.mjs` (the two accepted audit advisories must stay out of server-side code); `pnpm audit --prod --audit-level high`. |
| `database`    | Supabase CLI 2.120.0: `supabase db start` and `supabase test db` (Postgres 17), then the API integration tests against the migrated database.                                                                                                                                                                                                                                                         |
| `portals-e2e` | Builds both portals and runs the Playwright browser tests (`E2E=1`) against a fake Supabase Auth and API.                                                                                                                                                                                                                                                                                             |
| `secrets`     | gitleaks over the full git history. `.gitleaks.toml` allows a few synthetic test strings, each only in the exact test files that use it.                                                                                                                                                                                                                                                              |
| `api-image`   | Builds `infra/docker/api.Dockerfile`.                                                                                                                                                                                                                                                                                                                                                                 |

The local runner (Postgres 16 with the shim) and CI (Supabase Postgres 17) must both pass; a
difference between them is a defect to fix, not to ignore.

---

## 3. Test pyramid by layer

From most numerous and fastest (top) to fewest and slowest (bottom).

| Layer             | Tool                                                                    | Proves                                                                                                                      | Location                       | Runs                                                             | Status                                                          |
| ----------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ---------------------------------------------------------------- | --------------------------------------------------------------- |
| Domain unit       | vitest                                                                  | Pure rules: money, schedules display, state machines, eligibility helpers, APR display rules                                | `packages/domain/**/*.test.ts` | Every PR                                                         | Exists (36)                                                     |
| Contract schemas  | vitest + zod                                                            | Wire formats, event envelopes, problem details; later OpenAPI conformance                                                   | `packages/contracts`           | Every PR                                                         | Exists (12); OpenAPI checks planned (03)                        |
| Database          | pgTAP                                                                   | RLS and tenant isolation, grants, triggers, lifecycle actors, append-only, maker-checker, money invariants                  | `supabase/tests`               | Every PR (CI on Postgres 17; locally on 16+)                     | Exists (88); authorisation matrix planned (02)                  |
| API               | vitest + Fastify `inject`; integration against the local Supabase stack | Routing, validation, authentication, authorisation, idempotency, error shapes, RLS through the API                          | `services/api/test`            | Every PR                                                         | Exists for the skeleton (22); integration tests planned (02/03) |
| Provider contract | vitest against mocks; same suite against sandboxes                      | Each adapter honours its port: requests, responses, errors, retries, signatures, idempotency                                | `packages/adapters`            | Mocks every PR; sandboxes nightly in staging                     | Guard exists (3); ports from 04–08                              |
| Mobile component  | jest-expo + React Native Testing Library                                | Screens, consent screens, form validation, accessibility roles and labels, no permission request outside its step           | `apps/mobile`                  | Every PR                                                         | Planned (03, grows from 05)                                     |
| Mobile end-to-end | Maestro (recommended, section 3.7)                                      | Journeys on a release-like build: onboarding in ≤4 interactions, OTP autofill, resume, deny-all permissions still completes | `apps/mobile/e2e`              | Before staging promotion; nightly                                | Planned (05)                                                    |
| Portal end-to-end | Playwright (+ axe-core)                                                 | Staff sign-in with MFA, role-aware screens, maker-checker flows, CSP has no violations, accessibility                       | `apps/*/e2e`                   | Before staging promotion; nightly                                | Planned (03, grows from 04)                                     |
| Security          | pgTAP, vitest, Playwright, scanners                                     | Authorisation matrix, IDOR/BOLA, replay, webhook forgery, PII in logs, dependencies, secrets                                | Across the above               | Every PR (automated parts); per release                          | Partly exists (section 4)                                       |
| Performance       | k6                                                                      | Latency and error rates on OTP, offer comparison, payment intents, webhooks under load                                      | `tests/load`                   | Before launch and before major releases                          | Planned (11)                                                    |
| Resilience        | Restore and DR drills                                                   | Backups restore within the approved RPO/RTO; audit digest verifies; reconciliation recovers                                 | Runbook                        | Quarterly restore test; DR drill every 6 months (recommendation) | Planned (11)                                                    |
| Accessibility     | Contrast tests, axe-core, RNTL, manual screen-reader passes             | WCAG 2.2 AA (likely, app-store research §8)                                                                                 | Across the above               | Every PR (automated); per release (manual)                       | Contrast tests exist (design tokens)                            |

### 3.1 Domain unit tests (vitest)

- Pure functions only; the domain package may not import I/O, frameworks or vendors (ESLint
  `no-restricted-imports` in `eslint.config.mjs`).
- Money: integer paise, no floats, explicit rounding and allocation that never loses or invents a
  paisa.
- Every lifecycle defined in the domain package that the database also enforces gets a sync test
  like `test/lifecycle-sync.test.ts`, which reads the migration and fails if the two diverge.

### 3.2 API tests (Fastify `inject`)

- Build the app with `buildApp(config, deps)` and call it with `app.inject()`; no network port.
- Test configuration uses `APP_ENV=test`, which disables the logger (`services/api/src/app.ts`);
  once adapters are wired at start-up (03), it also allows only `mock` providers.
- From Phase 02/03, integration tests run the API against the local Supabase stack so that RLS is
  exercised through the real request path (`SET LOCAL ROLE authenticated` plus claims). Required
  cases per endpoint: unauthenticated (401), wrong role (403/404), other tenant's id (404), own
  resource (200), invalid body (400 problem+json), idempotent replay where relevant.
- Token tests (03): a token not signed by the project's keys, an expired token and a token for the
  wrong audience are rejected; key rotation works.

### 3.3 Database tests (pgTAP)

- **Structure (`001`)**: assertions that apply to every table and function, so a new table is
  checked automatically. Extend it rather than writing per-table copies (for example the planned
  TRUNCATE check for G-01).
- **Isolation (`002`)** and **lifecycle and integrity (`003`)**: one shared synthetic fixture
  (platform org, lenders Alpha and Beta, two borrowers, staff in each role, one staff user with no
  role). Switch actors with `pg_temp.as_user(uuid)`, `pg_temp.as_system()` and `pg_temp.as_owner()`.
- Every assertion has a description that reads as the rule it proves, for example
  "suspended membership loses all access immediately".
- Negative tests use `throws_ok` with the expected SQLSTATE (`42501` permission, `23514` check,
  `23503` foreign key, `23505` unique, `P0001` business rule).
- `select plan(n)` must equal the number of assertions; a mismatch fails the file.
- New in Phase 02: an **authorisation matrix**: for every system role, permission and tenant table,
  an explicit expected result for select, insert, update and delete, generated from the permission
  catalogue so that a new permission or table cannot be forgotten.

### 3.4 Provider contract tests

- Each capability (KYC, bureau, AA, eSign, payments, mandates, SMS, LMS, AI inference) gets a port
  interface in `packages/adapters` and at least two implementations: a mock and the real adapter.
- One contract test suite per port runs against the mock on every PR and against the provider's
  sandbox nightly in staging (where the provider offers one; for example Surepass has a sandbox at
  `sandbox.surepass.app`, confirmed from its README). The suite covers success, each documented
  error, timeouts, retries with the same idempotency key, and webhook signature verification.
- Sandbox responses may be recorded as fixtures only after checking they contain synthetic data.
- Lender LMS and ecosystem integrations (Finbyx, LawDocsComply) get consumer-driven contract tests
  on the CloudEvents envelope in `packages/contracts`: the producer's examples must parse with the
  consumer's schema, and versioned event types (`…v1`, `…v2`) are tested side by side during a
  migration.

### 3.5 Security tests

| Test                        | How                                                                                                                                     | Proves                     | Status                                                                                                                               |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Authorisation matrix        | pgTAP generated from the permission catalogue; the same matrix through the API                                                          | AC-01, AC-02               | Planned (02)                                                                                                                         |
| IDOR / BOLA                 | For every endpoint, swap ids between borrower 1 and 2 and between lender A and B; expect 404                                            | AC-04                      | Database part exists (T002); API part planned (03)                                                                                   |
| Replay / idempotency        | Repeat each financial POST with the same key (same result, no new row) and with a different body (422)                                  | AC-05                      | Database part exists (T003 "a replayed request with the same idempotency key cannot create a second payment"); API part planned (03) |
| Webhook forgery             | Bad signature, missing signature, stale timestamp, replayed event id, event for another lender's intent                                 | AC-06                      | De-duplication exists (T003); signature tests planned (05/08)                                                                        |
| PII in logs                 | Send canary values (synthetic PAN, Aadhaar-format number, phone, account number) through every route; regex-scan stored logs and traces | AC-16                      | Redaction unit test exists (depth ≤ 3 only, G-03); end-to-end scan planned (03)                                                      |
| Mobile permissions          | Merged-manifest allowlist check on the release build                                                                                    | AC-15                      | Planned (03)                                                                                                                         |
| Dependency and secret scans | `pnpm audit --prod --audit-level high`; gitleaks                                                                                        | Supply chain               | Exist in CI                                                                                                                          |
| SAST                        | CodeQL or Semgrep (recommendation)                                                                                                      | Code-level flaws           | Planned (03)                                                                                                                         |
| DAST                        | OWASP ZAP baseline scan against staging (recommendation)                                                                                | Headers, exposed endpoints | Planned (11)                                                                                                                         |
| VAPT                        | CERT-In-empanelled auditor before launch; VA every 6 months and PT every 12 months afterwards (likely, lender flow-down)                | Independent assurance      | Planned (11)                                                                                                                         |

### 3.6 Mobile component tests (jest-expo)

- `jest-expo` preset with React Native Testing Library. Query by accessibility role and label (this
  doubles as an accessibility check).
- Required cases: consent checkboxes are never pre-ticked; declining marketing consent never blocks
  a step; a permission request is only issued from the permission module at its step; amounts are
  formatted from integer paise; no personal data written to AsyncStorage.

### 3.7 Mobile end-to-end: Maestro recommended over Detox

Recommendation (not covered by the research notes; confirm tool versions and New Architecture
support when setting up in Phase 03):

| Criterion                                             | Maestro                                                                               | Detox                                                                                                 |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| How it drives the app                                 | Black-box, through the device UI and accessibility layer; no test code inside the app | Grey-box; synchronises with the React Native runtime through a native test harness built into the app |
| Can it test the release build that goes to the store? | Yes, it only needs the installed app                                                  | Needs a build that includes the Detox harness, so it tests a variant of the release build             |
| Writing tests                                         | Short YAML flows that a non-engineer can read and review                              | JavaScript/TypeScript with Jest                                                                       |
| Fit with Expo                                         | Works with any build (development or EAS release build)                               | Needs native configuration in the generated projects (via a config plugin)                            |
| Flakiness                                             | Built-in waiting and retries                                                          | Automatic synchronisation, usually fast and stable once configured                                    |

Why Maestro for Udofin: the most important mobile properties are build-specific and must be checked
on the artefact that ships: no prohibited permission dialog ever appears, OTP autofill works
without SMS permissions, the journey completes when every permission is denied, and onboarding
takes no more than 4 interactions (Phase 05 acceptance criterion). Black-box flows on the release
build test exactly that, and the product owner can read the flows. Revisit Detox only if grey-box
synchronisation becomes necessary for complex screens.

### 3.8 Portal end-to-end (Playwright)

- Staff sign-in with a second factor; a session without MFA is refused.
- Role-aware screens: each role sees only permitted actions, and the API refuses the action even if
  the button is forced visible (authorisation is not a UI concern).
- Maker-checker: the drafter cannot approve; a different approver can.
- Every page load listens for CSP violation reports and console errors and fails on any.
- axe-core accessibility scan on every page in the flow.

### 3.9 Performance (k6)

- Scripts in `tests/load`, run from a runner in ap-south-1 against staging with synthetic data and
  mock providers (never against live providers or production).
- Scenarios: OTP send and verify bursts (including abuse rates), offer comparison reads across
  several lenders, payment-intent creation with idempotency keys, webhook bursts including
  duplicates, lender-portal queue listing under concurrent staff.
- Pass/fail thresholds (latency percentiles, error rate) are agreed with the product owner before
  Phase 11; they are not fixed here.

### 3.10 Backup, restore and DR drills

- Restore the database to a point in time into a **new** Supabase project in ap-south-1 (a project's
  region cannot be changed: confirmed, infra research §3), apply the pgTAP suite, verify
  `private.audit_digest()` against exported anchors, run reconciliation, and record measured
  recovery point and recovery time.
- Cadence (recommendation, privacy research §11): restore test every quarter; full DR drill every
  6 months; targets proposed in the research (RTO ≤ 4 hours, RPO ≤ 15 minutes for borrower-facing
  services) are recommendations until the owner decides (D-28).
- Supabase point-in-time recovery is an add-on with 7, 14 or 28 days of history (confirmed, infra
  research §3); where backups are physically stored still needs written confirmation (unverified).
- A **local** drill exists: `scripts/restore-drill.sh` dumps and restores a throwaway database and compares row counts,
  row-level-security flags, grants, policies and function bodies, then runs the pgTAP suite on the copy
  ([`../operations/restore-drill.md`](../operations/restore-drill.md)). It proves the dump and restore procedure and our
  catalogue invariants only. It does **not** prove Supabase PITR, the backup region, RPO or RTO, or a managed restore,
  which are still to be rehearsed.

### 3.11 Accessibility

- Target WCAG 2.2 AA (likely; app-store research §8). Relevant criteria include target size
  (2.5.8), accessible authentication (3.3.8: allow OTP paste and autofill, no puzzle CAPTCHA),
  consistent help (3.2.6: grievance entry in the same place on every screen), redundant entry
  (3.3.7) and timing adjustable (2.2.1) for OTP and eSign timeouts.
- Automated: design-token contrast tests (exist); axe-core in Playwright; role and label queries in
  RNTL.
- Manual per release: TalkBack and VoiceOver passes in English and Hindi on the borrower journeys.

---

## 4. Test data

- Synthetic only. Identifiers must look obviously fake: lender names marked "(test)",
  registration numbers like `TEST-NBFC-0001`, bank references like `UTR-TEST-0001`, phone numbers
  like `910000000001` (as in the pgTAP fixtures).
- Values that look like real identifiers (PAN-format strings, 12-digit Aadhaar-format numbers) are
  used only as canaries in log-scan tests.
- No production data is ever copied into dev, staging, CI or a developer machine, including for
  debugging. Non-production environments hosted outside India (Railway) hold synthetic data only.
- Fixtures must not contain secrets; gitleaks runs on every PR.

---

## 5. Mock, sandbox and production providers

Every adapter declares its mode in its `ProviderDescriptor` (`packages/adapters/src/provider.ts`):

| Mode         | Meaning                                                                                             | Allowed in                 |
| ------------ | --------------------------------------------------------------------------------------------------- | -------------------------- |
| `mock`       | In-process fake written by Udofin. Deterministic, no network, no real data.                         | `local`, `test`, `staging` |
| `sandbox`    | The provider's own test environment with test credentials. Real network calls; synthetic data only. | `local`, `staging`         |
| `production` | The live provider with the lender's live credentials.                                               | `production` only          |

`assertProviderAllowed(provider, environment)` throws `ProviderNotAllowedError` for any other
combination. Proven by `packages/adapters/src/provider.test.ts`: "only allows live providers in
production", "never sends test or staging traffic to a live provider", "keeps automated tests on
mocks only".

Rules:

1. **Start-up check (Phase 03).** The API and worker call `assertProviderAllowed` for every wired
   adapter at start-up and refuse to start on a violation. Today the guard exists but nothing calls
   it yet.
2. **Visible labelling.** Non-production mobile builds already carry the environment in the app
   name and bundle id (`Udofin (staging)`, `com.udofin.app.staging`; `apps/mobile/app.config.ts`).
   Portals in non-production show an environment banner (03). Documents produced through a mock or
   sandbox provider are watermarked as test documents (07).
3. **Recorded on evidence.** Every record created from a provider call stores the provider key and
   mode, so evidence produced by a sandbox can never be mistaken for real evidence (from 05).
4. **Credentials separated.** Sandbox credentials never sit in the production secrets store and
   live credentials never sit in staging; secret names include the environment (03).
5. **Labelled suites.** Test names and CI job names say which mode they use ("contract: kyc
   (mock)", "contract: kyc (sandbox, nightly)").

---

## 6. Release gates

| Stage                      | Gate                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Merge to `main`            | All CI jobs green (`quality`, `database`, `secrets`, `api-image`); section A of the [security checklist](../security/checklist.md) complete; definition of done met (section 7); product owner approval on the PR.                                                                                                                                                                                                             |
| Deploy to dev (planned 03) | Automatic from `main`; smoke test of health endpoints and sign-in.                                                                                                                                                                                                                                                                                                                                                             |
| Promote to staging         | Same image digest as dev; migrations applied to staging; Playwright and Maestro journeys for changed areas green on a release-like build; provider sandbox contract suites green within the last 24 hours.                                                                                                                                                                                                                     |
| Production                 | Section B of the security checklist complete (merged-manifest permission audit, store-policy checks, residency, logging, restore drill in date, incident readiness, VAPT before launch, access review); k6 run for changed critical paths before launch and major releases; primary-source verification of regulatory references shipped in the release (release gate, owner decision D-05); product owner's written approval. |

A failing or skipped gate blocks the release unless the product owner accepts the risk in writing
in [`../security/risk-acceptances.md`](../security/risk-acceptances.md), with an owner and a review
date.

---

## 7. Definition of done

From the owner's brief: **a module is complete only when acceptance criteria are met, tests pass,
authorisation and tenant isolation are checked, failures are handled, documentation is updated, and
the work is reviewable.** In practice:

| Criterion                                  | Done means                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Acceptance criteria met                    | Every acceptance criterion in the approved spec (`docs/specs/NN-*.md`) is ticked in the PR, each with the test or evidence that shows it.                                                                                                                                                                                |
| Tests pass                                 | `pnpm check` and the database suite pass locally and in CI; new behaviour has unit, API and (for data changes) pgTAP tests, including negative cases; the PR lists only tests that actually ran.                                                                                                                         |
| Authorisation and tenant isolation checked | Every new endpoint and table is covered by the authorisation matrix; cross-tenant (lender A vs B) and cross-borrower tests exist and pass; platform-staff access is read-only unless a permission says otherwise, and is audited.                                                                                        |
| Failures handled                           | Timeouts, provider errors, duplicates and retries have defined behaviour and tests; financial operations are idempotent; errors are problem+json without internals; nothing is left half-done (transactions or outbox).                                                                                                  |
| Documentation updated                      | Spec, module status, controls matrix, ADRs where a decision changed, [threat model](../security/threat-model.md) (new flows, closed gaps), [mobile permission plan](../security/mobile-permissions.md) if permissions changed, and data ownership for new personal data. Regulatory statements keep their status labels. |
| Reviewable                                 | One module or phase per PR, small commits, no unrelated changes, PR template and security checklist completed, CI green.                                                                                                                                                                                                 |

---

## 8. Known weaknesses in the test setup today

| Weakness                                                                                                 | Effect                                                                                                                  | Fix                                                                                                                                        | Phase |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----- |
| `vitest run --passWithNoTests` in `packages/domain`, `contracts`, `design-tokens` and `adapters` (G-22)  | A package whose tests are deleted or misnamed still passes.                                                             | Remove the flag now that every package has tests.                                                                                          | 03    |
| Portals and mobile have no `test` script                                                                 | `pnpm test` silently skips them.                                                                                        | Add Playwright and jest-expo suites.                                                                                                       | 03    |
| The shared fixture is duplicated in `002` and `003` ("keep in sync")                                     | Drift between the two copies.                                                                                           | Single fixture file included by both (confirm the include mechanism works under `supabase test db`).                                       | 02    |
| `001_structure` checks DELETE but not TRUNCATE privileges                                                | G-01 is not caught.                                                                                                     | Add a structural TRUNCATE assertion.                                                                                                       | 02    |
| The log-redaction test name says "at any logged depth" but redaction covers depth 1–3 only (G-03)        | False confidence.                                                                                                       | Add depth-4, snake_case and error-`detail` cases; fix redaction.                                                                           | 03    |
| API tests run with the logger disabled (`APP_ENV=test`)                                                  | Redaction in the real request pipeline is not exercised.                                                                | Add a test that captures request logs with a test stream.                                                                                  | 03    |
| CI `config:check` does not inspect the merged manifest                                                   | Permission creep from libraries is not caught (AC-15).                                                                  | Merged-manifest check on the release build.                                                                                                | 03    |
| Local runner (Postgres 16 + shim) and CI (Supabase Postgres 17) differ                                   | A test may pass in one and fail in the other.                                                                           | Both must pass; differences fixed in the shim or the tests.                                                                                | 02    |
| PDF text assertions return early when `pdftotext` is missing (audit, section 11)                         | They could pass without checking anything.                                                                              | Fixed for CI: the tests fail when `CI` is set and the `quality` job installs `poppler-utils`. Local runs without the tool still skip them. | 02    |
| ~~Root `pnpm test` runs through Turborepo's strict environment mode (audit F-10)~~ **Fixed 14 Oct 2026** | `turbo.json` now passes `INTEGRATION_*` through, so the API integration tests run (not skip) when the variables are set | none                                                                                                                                       | 02    |
| Restore has only been rehearsed locally                                                                  | Backup, PITR, RPO and RTO are unproven.                                                                                 | Rehearse a managed restore before real data (`../operations/restore-drill.md`).                                                            | 11    |

### Tests to add for the gaps found in the baseline

Each gap in [`../security/threat-model.md`](../security/threat-model.md) section 9 gets a test that
fails before the fix and passes after it. The database ones belong in Phase 02:

| Gap  | Test to add (pgTAP unless stated)                                                                                                                                                   |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G-01 | No role has TRUNCATE on append-only tables; TRUNCATE on `audit.events` raises.                                                                                                      |
| G-02 | A borrower cannot record an audit event for a lender's tenant.                                                                                                                      |
| G-03 | (vitest) Depth-4, snake_case, upper-case keys and Postgres error `detail` are redacted.                                                                                             |
| G-04 | An approver cannot change terms in the approving statement; terms are frozen once submitted.                                                                                        |
| G-05 | An `authenticated` session without claims is not classified as `system`.                                                                                                            |
| G-06 | `pending → succeeded` fails without a signature-verified provider event of the same amount.                                                                                         |
| G-07 | A provider event cannot reference another lender's payment intent.                                                                                                                  |
| G-08 | An application's borrower must equal the request's borrower; a loan account's borrower must equal the application's.                                                                |
| G-09 | A bank reference cannot evidence two loans; disbursement evidence cannot change once recorded.                                                                                      |
| G-10 | A user cannot hold memberships in the platform and in a lender.                                                                                                                     |
| G-11 | A user with a borrower row cannot be given a staff membership (and the reverse).                                                                                                    |
| G-12 | An offer outside the product version's range, below the category tenure floor, or on a non-approved application is rejected; `created_by` and `issued_at` are set from the session. |
| G-13 | An application cannot reach `offer_accepted` without an accepted, unexpired offer.                                                                                                  |
| G-14 | A consent record's time is set by the database; a notice for lender A cannot be used for lender B.                                                                                  |
| G-16 | Requests and products in a `not_supported` category, or below the tenure floor, are rejected.                                                                                       |
| G-17 | (API) The same idempotency key with a different body returns 422.                                                                                                                   |
