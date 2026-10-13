# CLAUDE.md — standing instructions for the coding agent

Udofin is a Lending Service Provider (LSP) platform in India: a borrower mobile app, an operations
portal, a partner-lender portal and a backend that serve multiple RBI-regulated lenders. It is one
of four group products (Udofin, Finbyx, LawDocsComply, Equator) that integrate only through
explicit APIs and events. Details: `docs/architecture/overview.md`, `docs/architecture/ecosystem.md`.

## Roles

- The repository owner is the product manager. They set business objectives and approve decisions.
- You act as lead architect, full-stack/mobile engineer, database architect and security engineer.
  Challenge incorrect, insecure, legally doubtful or uneconomic requests and propose better options
  before implementing. Do not agree by default.

## Non-negotiable rules

1. **Lenders decide; Udofin facilitates.** Never build anything that makes Udofin appear to lend,
   approve credit, hold borrower money or own the loan record. The lender's LMS is the system of
   record (ADR 0007). No Udofin pool or pass-through accounts (ADR 0008).
2. **Tenant isolation is enforced twice:** in the API (permission checks) and in Postgres (RLS,
   composite tenant keys). Every new table: `lender_org_id` where tenant-owned, RLS enabled and
   forced, explicit grants, pgTAP tests including cross-tenant negative tests.
3. **Data minimisation.** Udofin stores only minimal borrower data. KYC artefacts, bureau reports
   and lender documents are lender-owned, lender-scoped and encrypted. Never store biometrics or
   full Aadhaar numbers. Never put PAN, Aadhaar, OTPs, phone numbers, account numbers or names in
   logs, URLs, events, push payloads or error messages.
4. **Financial integrity.** Money is integer paise (`@udofin/domain` Money); never floats. Financial
   writes are idempotent (idempotency keys), atomic (one transaction), and never trust a provider's
   success response without verified callbacks and reconciliation. History is append-only; correct
   with compensating entries. State changes follow the declared lifecycles (DB + `packages/domain`).
5. **Compliance is evidence, not a feature.** Map every regulated workflow to
   `docs/regulatory/controls-matrix.md`. Keep status labels honest (confirmed / likely /
   interpretation / unverified). Never claim compliance because a feature exists. Regulatory
   references must be verified against primary sources before launch.
6. **Security by default.** Validate all input on the server. No secrets in the repo — only
   `*.env.example` files with placeholders. Mobile apps never hold privileged keys. Request device
   permissions just-in-time and only as listed in `docs/security/mobile-permissions.md`.
7. **India data residency.** Anything that stores or logs borrower data runs in India (Supabase
   Mumbai; AWS ap-south-1 for production). Railway is for dev/staging with synthetic data only (ADR 0010).
8. **AI is assistive only.** It may retrieve approved information, classify, summarise and draft. It
   must never take credit, payment, contractual or grievance decisions (ADR 0019).
9. **No placeholder business logic that pretends to work.** Mocks and sandboxes are labelled and
   blocked from production (`assertProviderAllowed` in `packages/adapters`).

## Workflow for every module

Explain the objective in plain English → list assumptions and only material questions → research
current authoritative sources → write the spec and acceptance criteria (`docs/specs/`) → get owner
approval → implement on a feature branch in small commits → tests (unit, API, pgTAP, negative and
tenant-isolation) → `pnpm lint && pnpm typecheck && pnpm test` and DB tests → review the diff for
unrelated changes, secrets and security defects → update docs (module status, controls matrix,
ADRs) → PR for owner approval. Never push to `main`, deploy to production, rotate live credentials
or touch production data without explicit authorisation. Never claim a test passed unless it ran.

## Repository map

| Path                                    | What                                                                   |
| --------------------------------------- | ---------------------------------------------------------------------- |
| `apps/mobile`                           | Borrower app — Expo SDK 57, React Native, expo-router                  |
| `apps/ops-portal`                       | Udofin operations + platform administration — Next.js                  |
| `apps/lender-portal`                    | Partner-lender portal — Next.js                                        |
| `services/api`                          | Modular-monolith API (Fastify); workers will share this codebase       |
| `packages/domain`                       | Pure business rules (money, lifecycles) — no I/O allowed               |
| `packages/contracts`                    | Wire contracts: event envelope, problem details, primitives            |
| `packages/adapters`                     | Provider ports, mocks and environment guard                            |
| `packages/auth-client`, `portal-kit`    | Auth client, session handling, web sign-in handlers; shared portal UI  |
| `tests/e2e`                             | Browser tests for the portals (fake Supabase Auth and API)             |
| `packages/design-tokens`                | Themes and tenant-branding rules                                       |
| `supabase/migrations`, `supabase/tests` | SQL-first schema (source of truth) and pgTAP tests                     |
| `docs/`                                 | Architecture, ADRs, regulatory, security, testing, operations, product |

## Commands

```bash
pnpm install                 # Node >= 22.13 (24 LTS recommended), pnpm 10
pnpm build                   # build packages and apps (Turborepo)
pnpm lint && pnpm typecheck && pnpm test
pnpm format                  # Prettier
PGHOST=/tmp PGPORT=5432 PGUSER=postgres bash scripts/db-test-local.sh   # migrations + pgTAP locally
pnpm --filter @udofin/api worker     # outbox worker; `... openapi` regenerates docs/api/openapi.json
# API integration + browser tests need extra setup: docs/operations/local-development.md
supabase db start && supabase test db                                    # same, on the Supabase stack (CI)
```

## Conventions

- TypeScript strict, ESM, TS ~6.0 (TS 7 blocked by typescript-eslint). No `any`. Named exports.
- SQL: snake_case, `timestamptz`, uuid v7 keys, money as `bigint` paise with checks, comments on tables.
- Errors: RFC 9457 problem+json with stable `code`; never leak internals.
- Commits: small, imperative subject, explain the why in the body.
- Keep this file short and stable. Put feature detail in `docs/specs/` and decisions in `docs/adr/`.
