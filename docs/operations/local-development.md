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
PGHOST=/tmp PGPORT=5432 PGUSER=postgres bash scripts/db-test-local.sh   # throwaway database; 236 assertions
# or, on the Supabase stack (CI does this):  supabase db start && supabase test db
```

## API integration tests (real HTTP app + real database + real worker store)

Needs a migrated, **disposable** database and the two application logins (they have no password in migrations; local trust authentication is fine, never do this on a shared database):

```bash
export INTEGRATION_ADMIN_URL=postgresql://postgres@localhost:5432/udofin_test
export INTEGRATION_API_URL=postgresql://udofin_api@localhost:5432/udofin_test
export INTEGRATION_SYSTEM_URL=postgresql://udofin_system@localhost:5432/udofin_test
pnpm --filter @udofin/api test          # without these variables the 26 integration tests are skipped
```

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
