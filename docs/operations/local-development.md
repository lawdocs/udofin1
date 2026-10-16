# Running and testing locally

Prerequisites: Node 22.13+ (24 recommended, see `.nvmrc`), pnpm 10, PostgreSQL 16+ with pgTAP for the database tests (or Docker + the Supabase CLI), Chromium for the browser tests. Nothing here needs a cloud account.

## Install and build

```bash
pnpm install
pnpm build            # builds packages, API, both portals (portal builds need no secrets)
```

## Checks

```bash
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test      # unit + component tests, no database needed
APP_ENV=production pnpm --filter @udofin/mobile config:check       # mobile permission policy
```

## Database tests (migrations + pgTAP)

```bash
PGHOST=/tmp PGPORT=5432 PGUSER=postgres bash scripts/db-test-local.sh   # throwaway database; current counts: docs/testing/strategy.md
# or, on the Supabase stack (CI does this):  supabase db start && supabase test db
```

## API integration tests (real HTTP app + real database + real worker store)

Needs a migrated, **disposable** database and the two application logins (they have no password in migrations; local trust authentication is fine, never do this on a shared database):

```bash
export INTEGRATION_ADMIN_URL=postgresql://postgres@localhost:5432/udofin_test
export INTEGRATION_API_URL=postgresql://udofin_api@localhost:5432/udofin_test
export INTEGRATION_SYSTEM_URL=postgresql://udofin_system@localhost:5432/udofin_test
pnpm --filter @udofin/api test          # without these variables the integration tests are skipped
```

Integration tests run through Turborepo are skipped unless the variables reach the task. Turborepo's strict environment mode passes only the variables listed in `turbo.json`; unless `turbo.json` lists the `INTEGRATION_*` variables, `pnpm test` at the repository root reports the integration tests as skipped (audit finding F-10). Run `pnpm --filter @udofin/api test` with the variables set, on a freshly migrated database (the tests are not repeatable on a reused one).

## Browser tests (portals, fake Supabase Auth and API)

```bash
pnpm --filter @udofin/ops-portal build && pnpm --filter @udofin/lender-portal build
E2E=1 PLAYWRIGHT_CHROMIUM_PATH=/path/to/chrome pnpm --filter @udofin/e2e test
```

## Start the pieces

```bash
# API (needs DATABASE_URL = the udofin_api login; SUPABASE_URL for token verification)
cp services/api/.env.example services/api/.env   # fill placeholders; never commit
pnpm --filter @udofin/api dev
# Worker (needs SYSTEM_DATABASE_URL = the udofin_system login)
pnpm --filter @udofin/api worker

# Phase 08a, labelled mock payment providers (local and test only): the database refuses to move a mock mandate or use a mock
# configuration in a session that does not allow mock providers, so the worker's system login must start with the setting
#   PGOPTIONS='-c udofin.allow_mock_providers=on' pnpm --filter @udofin/api worker
# (the integration tests set it as a connection option). Staging and production must leave it unset: a mock configuration cannot exist there.
# Hand-off links need HANDOFF_ENCRYPTION_KEYS and HANDOFF_ACTIVE_KEY_VERSION in both the worker and the API (see services/api/.env.example);
# without them an order or mandate is recorded and the borrower is told no link is available.

# Lender callback receiver (Phase 06; separate process, same system login; PORT/HOST as usual).
# Signing secrets are referenced by NAME (the connector's signing_secret_ref is an environment variable name
# set in the deployment); only the labelled mock scheme exists and it is refused in staging and production.
pnpm --filter @udofin/api callbacks
# Portals (copy each .env.example to .env.local first)
pnpm --filter @udofin/ops-portal dev      # http://localhost:3001
pnpm --filter @udofin/lender-portal dev   # http://localhost:3002
# Mobile (copy apps/mobile/.env.example to .env.local)
pnpm --filter @udofin/mobile dev
```

For plain-http local development of the portals set `COOKIE_SECURE=false` and an `http://localhost` `PORTAL_ORIGIN`; this is refused for any non-loopback address.

## OpenAPI

```bash
pnpm --filter @udofin/api openapi        # regenerates docs/api/openapi.json after you change a route
```

A test fails if the committed file is out of date. `GET /v1/openapi.json` serves it outside production only.

## Migrations

Forward-only files in `supabase/migrations/`. Add a migration, add pgTAP tests, update the authorisation matrix test (`006`) if a table, role or permission changes, run the database tests, then the API integration tests.

## Documents and signing (Phase 07)

- `SIGNING_PROVIDER=none` (default) or `mock`. `mock` is refused when the API is deployed (staging or production) and the database refuses a mock signing request unless the session sets `udofin.allow_mock_signing=on` (integration tests do this). It produces no signature and no legal effect.
- Sample (fixture) templates need `udofin.allow_sample_documents=on` in the database session; without it document preparation reports `sample_blocked`.
- PDF text tests call `pdftotext` (poppler-utils). Install it locally (`apt install poppler-utils`). Without it those assertions are skipped on your machine, but they **fail** whenever the environment variable `CI` is set (CI installs poppler-utils), so a missing tool can no longer make them pass silently.

## Other checks CI runs that you can run locally

```bash
node scripts/check-audit-ignores.mjs         # the two accepted audit advisories (RA-001, RA-002) must stay out of server-side code; needs `pnpm install`
UDOFIN_TEST_DB=udofin_drill bash scripts/restore-drill.sh --self-test   # dump, restore and compare; see docs/operations/restore-drill.md (local server only)
docker run --rm -v "$PWD:/repo" ghcr.io/gitleaks/gitleaks:v8.30.1 git --redact --verbose /repo   # secret scan, as CI does
```

`.gitleaks.toml` allows a few synthetic placeholder keys that tests feed to "refuse a secret-shaped value" checks. Each allowance is limited to the exact test files that need it; a new test file that uses one of those values must be added to its list, and any other file containing the value fails the scan.

Operations documents that describe things which are **not built**: [`runbook-outbox.md`](runbook-outbox.md), [`observability-spec.md`](observability-spec.md), [`document-store-production-spec.md`](document-store-production-spec.md).
