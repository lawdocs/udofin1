# Udofin

Udofin is a digital Lending Service Provider (LSP) platform for India. Borrowers use a mobile app
to request a loan, compare offers from several partner lenders (NBFCs, banks), complete the
lender's verification and documentation, and manage repayments and complaints. Partner lenders and
Udofin's operations team use separate web portals. **The regulated lender makes every credit
decision and holds the loan; Udofin provides the technology and service layer.**

> **Status: foundation baseline (Phase 01).** The repository structure, tooling, security
> scaffolding, core database schema with row-level security and tests, and the architecture and
> regulatory documentation exist. No borrower or lender features are implemented yet, and nothing
> is deployed. See [`docs/product/module-status.md`](docs/product/module-status.md) and
> [`docs/product/roadmap.md`](docs/product/roadmap.md).

## Repository layout

```
apps/
  mobile/            Borrower app (Expo SDK 57, React Native, TypeScript)
  ops-portal/        Udofin operations & platform administration (Next.js 16)
  lender-portal/     Partner-lender portal (Next.js 16)
services/
  api/               Modular-monolith API (Fastify 5, Node 24) — business rules & integrations
packages/
  domain/            Pure business rules: money in paise, lifecycle state machines
  contracts/         Wire contracts: event envelope (CloudEvents), RFC 9457 errors, primitives
  adapters/          Provider ports, mock/sandbox/production guard
  design-tokens/     Themes and lender-branding rules (WCAG contrast enforced)
supabase/
  migrations/        SQL schema — the source of truth (RLS, lifecycle guards, append-only history)
  tests/             pgTAP tests (structure, tenant isolation, lifecycle & integrity)
infra/docker/        API container image
scripts/             Local database test runner
docs/                Architecture, ADRs, data, API, integrations, regulatory, security, testing,
                     operations, product, research
```

## Getting started

Prerequisites: Node.js 24 LTS (≥ 22.13 works), pnpm 10 (`corepack enable`), and either the
Supabase CLI with Docker, or a local PostgreSQL 16+ with pgTAP for database tests.

```bash
pnpm install
pnpm build          # compiles shared packages, API and portals
pnpm lint
pnpm typecheck
pnpm test           # unit and API tests
```

Database (choose one):

```bash
# Supabase local stack (needs Docker) — same as CI
supabase db start
supabase test db

# Plain PostgreSQL with pgTAP (uses a local-only stand-in for Supabase's auth schema)
PGHOST=/tmp PGPORT=5432 PGUSER=postgres bash scripts/db-test-local.sh
```

Run things locally:

```bash
cp services/api/.env.example services/api/.env          # placeholders only
pnpm --filter @udofin/api dev                            # http://localhost:8080/health/live
pnpm --filter @udofin/ops-portal dev                     # http://localhost:3001
pnpm --filter @udofin/lender-portal dev                  # http://localhost:3002
pnpm --filter @udofin/mobile dev                         # Expo dev server
```

## Ground rules

- Never commit secrets or real borrower data. Only `.env.example` files with placeholders.
- Work on feature branches; `main` changes only through reviewed pull requests.
- Read [`CLAUDE.md`](CLAUDE.md) (engineering rules) and [`docs/README.md`](docs/README.md) (documentation index).

## Documentation

Start with [`docs/README.md`](docs/README.md).
