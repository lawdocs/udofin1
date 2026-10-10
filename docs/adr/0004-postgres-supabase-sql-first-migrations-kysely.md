# ADR-0004: Postgres on Supabase, SQL-first migrations, Kysely for queries

- **Status:** Accepted (baseline, pending owner approval)
- **Date:** 2026-10-10
- **Related:** ADR-0005, ADR-0006, ADR-0010, ADR-0013, ADR-0015

## Context

- Lending data needs strong integrity: amounts that cannot be edited, lifecycles that cannot skip steps, histories that cannot be rewritten, and tenant isolation that holds even if application code has a bug.
- The Supabase project `Udofin-app` runs in AWS ap-south-1 (Mumbai) on Postgres 17.6 (research: confirmed via the Supabase Management API, `docs/research/2026-10-10/infra-stack.md`).
- Supabase supplies managed Postgres plus Supabase Auth. It also exposes tables through PostgREST, which we do not want for domain data.
- Research: Prisma makes per-transaction RLS context awkward; Drizzle 1.0 was in release candidate with API churn; Kysely 0.29.6 suits typed SQL (`infra-stack.md` §7, interpretation). `SET LOCAL` / `set_config(..., true)` are transaction-scoped and work through transaction poolers (interpretation); transaction-mode pooling does not support prepared statements (confirmed).

## Decision

1. **Operational store:** Postgres on Supabase, project in ap-south-1 (Mumbai). Residency details are in ADR-0010.
2. **Schema source of truth:** plain SQL migrations in `supabase/migrations/`, applied in order. No ORM-generated migrations. Invariants are enforced in the database with constraints and triggers where possible, not only in application code.
3. **Domain schemas** (`tenancy`, `identity`, `consent`, `audit`, `lending`, `servicing`, `payments`) and the `private` helper schema are **not exposed via PostgREST**. Clients (mobile app, portals) never query them; they call the API.
4. **Defaults that fail closed:** `anon` and `public` get no privileges; new tables are unreadable until a migration grants access; function `EXECUTE` is revoked from `PUBLIC` by default; security-definer helpers pin `search_path = ''`.
5. **Keys:** time-ordered UUID v7 (`private.uuid_v7()`). **Money:** integer minor units (`*_minor bigint`, paise), never floats.
6. **API database access:** the API connects with a restricted role. Each user request runs in one transaction that executes `SET LOCAL ROLE authenticated` and `set_config('request.jwt.claims', <verified claims>, true)`, so RLS applies to the API as a second layer (ADR-0005). The `service_role` (which bypasses RLS) is used only in worker/system code paths, never in request handlers.
7. **Typed queries:** Kysely, with types generated from the migrated schema. Raw SQL for reports. (Planned; not yet added.)
8. **Authentication:** Supabase Auth issues sessions — phone OTP for borrowers; email with MFA for staff, SAML SSO later. The API verifies access tokens with asymmetric keys from the JWKS endpoint using `jose`, with no shared secret.
9. **Tests:** pgTAP tests in `supabase/tests/` prove the database rules.

## Implementation state

- Done: five migrations and three pgTAP files (88 assertions) passing locally on PostgreSQL 16 via `scripts/db-test-local.sh` and the local-only auth shim `scripts/db/local-supabase-shim.sql`.
- Not yet built: the per-request transaction wrapper, JWKS verification (`jose` is a dependency but unused), Kysely, the CI job that runs the tests on the Supabase CLI stack (Postgres 17), and `supabase/config.toml` (referred to in the foundation migration).

## Alternatives considered

| Option                                                           | Why rejected                                                                                                                                 |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Clients use Supabase PostgREST directly, RLS as the only control | Business rules, audit and provider calls belong in the API; one bug in a policy would expose data with no second layer.                      |
| Prisma                                                           | Per-transaction RLS context is awkward (research interpretation); migrations generated from a model hide SQL constraints and triggers.       |
| Drizzle                                                          | Acceptable, but 1.0 was in release candidate with API churn at research time.                                                                |
| AWS Aurora / RDS now                                             | Would also mean replacing Supabase Auth (GoTrue is bound to the Supabase database). Kept as a later option, e.g. for in-India DR (ADR-0010). |
| Enforce invariants only in application code                      | A bug, a script or a future service could bypass them; database constraints hold for every client.                                           |

## Consequences

**Positive**

- Integrity rules hold regardless of which code path writes (API, worker, admin script), and are proven by tests.
- RLS gives a second, independent check on every user request.
- SQL migrations are reviewable by a non-engineer with help, and portable to other Postgres hosts.

**Negative**

- Coupling to Supabase specifics: the `auth` schema, `auth.uid()`, the `authenticated` / `service_role` roles. Moving off Supabase needs replacements.
- Business rules exist in two places for some lifecycles (SQL triggers and `packages/domain`); kept in sync by tests (ADR-0015).
- Local tests run on PostgreSQL 16 with a shim, while production is Postgres 17 on Supabase; differences are caught only once CI runs on the real stack.

**Risks**

- `service_role` bypasses RLS. Misuse in request handlers would remove the second layer. Mitigation: restrict its use to worker code paths and log each use (research recommendation).
- The database treats a transaction with **no** JWT claims as the trusted "system" actor (`private.current_actor()` returns `system` when `auth.uid()` is null). Code that forgets to set claims while using a privileged role would act as the system. Mitigation: the request wrapper must always set claims and use `authenticated`.

## Compliance and security notes

- Storing data in Mumbai supports the reported requirement that borrower data be stored only on servers in India (research: confirmed (secondary) in `rbi-digital-lending.md` DL-15, likely in `infra-stack.md` INF-01). The backup and platform-log locations are **unverified**; see ADR-0010.
- Primary-source verification gate applies (README).

## Verification

- `supabase/tests/001_structure.test.sql`: RLS enabled on every domain table; forced on borrower/tenant tables; no `anon`/`public` privileges; no DELETE for `authenticated`; security-definer functions pin `search_path`; `anon` cannot execute them or use domain schemas.
- `supabase/tests/002_tenant_isolation.test.sql` and `003_lifecycle_and_integrity.test.sql` (ADR-0005, ADR-0015).
- Planned: an API integration test proving a request runs as `authenticated` with the caller's claims and cannot see another tenant's rows.

## Revisit triggers

- Need for in-country disaster recovery that Supabase cannot provide in India (research: Supabase lists only ap-south-1 for India, likely).
- Supabase Auth limits (plan features such as MFA hooks, SAML pricing) or a move of the database to AWS.
- Kysely becomes unmaintained, or the type-generation path breaks.
