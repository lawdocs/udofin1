# Database migrations: practice and review checklist

Status: working draft, 2026-10-10. Applies to every change under `supabase/migrations/` and
`supabase/tests/`. The deployment steps that apply migrations to shared environments are in
`docs/operations/deployment.md` §5; this document covers how migrations are written, reviewed and
tested, and how database, backend and mobile versions stay compatible.

---

## 1. Principles

1. **SQL-first.** The files in `supabase/migrations/` are the schema's source of truth. They are
   hand-written SQL, reviewed like code. No ORM-generated migrations, and no schema changes made through
   Supabase Studio or a SQL console on any shared environment (they would create drift that the files
   do not describe).
2. **The database enforces the rules that matter**, not only the API: tenant isolation (RLS and composite
   foreign keys), lifecycles (transition tables and triggers), immutability (append-only triggers),
   maker-checker and money invariants. A migration that weakens one of these needs an explicit reason in
   the pull request.
3. **Every migration ships with tests** in `supabase/tests/` (pgTAP), run locally and in CI.
4. **Forward-only once shared.** After a migration has been applied to any shared environment, it is never
   edited, renamed or reordered; mistakes are corrected by a new migration (§8).
5. **Typed access follows the schema.** Kysely types are generated from the migrated schema (planned,
   Phase 02); a stale type file fails the build.

---

## 2. Naming and layout

| Item           | Rule                                                                                                                                                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Migration file | `supabase/migrations/<UTC timestamp YYYYMMDDHHMMSS>_<snake_case_description>.sql`, for example `20261105093000_add_offer_display_log.sql`. Create it with `supabase migration new <description>` or by hand in the same format.                   |
| Ordering       | Files apply in filename order. A new file must sort after every file already applied anywhere. The baseline uses synthetic timestamps on 2026-10-10 spaced by 100 (`…000100` to `…000500`); new files use the real UTC time of creation.          |
| Scope          | One logical change per file. Schema changes and data backfills are never mixed in one file.                                                                                                                                                       |
| Header         | A comment block stating the purpose, the owning module, any personal-data columns (with their entry in `docs/data/ownership.md`), and the regulatory reason with its research status label where one applies.                                     |
| Tests          | `supabase/tests/NNN_<topic>.test.sql`. Each file runs in one transaction: `begin; … select plan(n); … select * from finish(); rollback;`. Synthetic data only. Files 002 and 003 share a fixture that must stay identical (stated in both files). |
| Reference data | Permission catalogue, system roles, product categories and transition tables are inserted by migrations, never by seeds.                                                                                                                          |
| Seeds          | `supabase/seed.sql` (none yet): synthetic data only, ever. `scripts/db-test-local.sh` applies it if it exists; `supabase/config.toml` has `[db.seed] enabled = false`, so the CLI does not. Keep tests independent of seeds.                      |

---

## 3. Conventions every new object follows

These are the patterns already used in the five baseline migrations.

| Object             | Convention                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema             | Domain schemas are not exposed through PostgREST (`supabase/config.toml` exposes only `public` and `graphql_public`). A new schema repeats the foundation steps: revoke all from `public` and `anon`, grant usage to `authenticated` and `service_role`, and revoke default table and function privileges. Add it to the schema lists in `supabase/tests/001_structure.test.sql`. |
| Primary key        | `uuid primary key default private.uuid_v7()`.                                                                                                                                                                                                                                                                                                                                     |
| Tenant-owned table | `lender_org_id uuid not null`, `unique (id, lender_org_id)` on parents, composite foreign keys `(x_id, lender_org_id)` on children, and `lender_org_id` inside any uniqueness rule that is per lender.                                                                                                                                                                            |
| Money and rates    | `*_minor bigint` with range checks; rates in basis points (`*_bps integer`); currency `INR` only unless a decision says otherwise.                                                                                                                                                                                                                                                |
| Timestamps         | `timestamptz`; `created_at default now()`; `updated_at` maintained by `private.set_updated_at()`.                                                                                                                                                                                                                                                                                 |
| History            | Tables whose rows are evidence are append-only (`private.forbid_mutation()` on UPDATE and DELETE).                                                                                                                                                                                                                                                                                |
| Lifecycles         | Status changes are checked by a transition table or trigger and mirrored in `packages/domain`, with a sync test.                                                                                                                                                                                                                                                                  |
| Functions          | `set search_path = ''`, schema-qualified names, `security definer` only when needed, `revoke all … from public`, explicit `grant execute`.                                                                                                                                                                                                                                        |
| RLS                | `enable` and `force` row level security on every table holding borrower or tenant data; policies use the `private` helpers in the `(select private.fn(...))` form so they evaluate once per statement.                                                                                                                                                                            |
| Grants             | Explicit and minimal: `select` to `authenticated` only where a policy allows reading; column-level `update` grants; no grants to `anon`; no `delete` to `authenticated` (checked by the structure test).                                                                                                                                                                          |
| Comments           | `comment on table` naming the owning module and anything a reviewer must know (for example "read model of the lender's LMS").                                                                                                                                                                                                                                                     |

---

## 4. Review checklist

Every migration pull request answers each item. "N/A" needs a reason.

| Area                        | Check                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Locking**                 | Which lock does each statement take on which table, and for how long? Add `set lock_timeout = '5s';` at the top of migrations that touch busy tables, so a blocked migration fails instead of queueing all traffic behind it.                                                                                                                                                   |
|                             | Adding a column with a constant default is a metadata change; a volatile default, a column type change or most `alter column … type` statements rewrite the table.                                                                                                                                                                                                              |
|                             | New `check` or foreign-key constraints on existing tables: add as `not valid`, then `validate constraint` in a later step, so the long scan does not hold a strong lock.                                                                                                                                                                                                        |
|                             | New indexes on existing large tables: `create index concurrently`, which cannot run inside a transaction block; check how the migration runner executes the file and put it in its own file if needed.                                                                                                                                                                          |
|                             | `alter type … add value`: the new enum value cannot be used in the same transaction; use it in a later migration.                                                                                                                                                                                                                                                               |
| **Data loss**               | No `drop table`, `drop column`, narrowing type change or destructive update on shared environments except as the planned "contract" step of an expand/contract change, after the code that used the old structure is gone and a restore point is recorded. Append-only tables are never "fixed" by editing rows; corrections are compensating rows.                             |
| **Backward compatibility**  | The API and worker version currently deployed (N−1) must keep working against the new schema during and after the deploy. Use expand → migrate → switch → contract: add new tables, columns or functions; backfill in a separate, idempotent, resumable job; switch the code; remove the old structure in a later release. Renames are done as add-new, copy, switch, drop-old. |
|                             | Functions used by RLS policies or triggers: create the new version, switch the policies, then drop the old one; never change a signature in place.                                                                                                                                                                                                                              |
|                             | Lifecycle or enum changes: update `packages/domain` and its sync test in the same pull request. Note that `packages/domain/test/lifecycle-sync.test.ts` reads `20261010000400_lending_core.sql` directly, so a lifecycle change in a later file also requires changing that test.                                                                                               |
| **Rollback or forward-fix** | Supabase migrations have no down scripts. The pull request states the forward-fix (the migration that would undo or correct the change) and, for any destructive step, the recovery path: the point-in-time restore point recorded before production (PITR is a paid add-on; plan decision D-07).                                                                               |
| **RLS on new tables**       | Enabled and forced; policies for each actor (borrower, lender staff by permission, platform staff only through `platform_grantable` permissions, system through the service role); tests prove both access and denial, including cross-tenant denial.                                                                                                                           |
| **Grants**                  | Explicit, minimal, column-level for updates; nothing to `anon`; no `delete` for `authenticated`; new functions revoked from `PUBLIC`; security-definer functions pin `search_path`.                                                                                                                                                                                             |
| **Personal data**           | Every new personal-data column has an entry (classification, retention, access) in `docs/data/ownership.md`. No restricted data in core schemas: no Aadhaar numbers, KYC images, bureau reports or raw provider payloads; these belong in lender-scoped encrypted storage (Phase 06). No biometrics anywhere.                                                                   |
| **Tenancy**                 | Tenant key present; composite foreign keys; per-lender uniqueness includes `lender_org_id`; no reference that could point at another lender's row.                                                                                                                                                                                                                              |
| **Audit and integrity**     | Status changes leave an append-only trace in the same transaction; configuration that affects borrowers is maker-checker; reference data changes only by migration.                                                                                                                                                                                                             |
| **Tests**                   | pgTAP tests added or updated, including negative and cross-tenant cases; `plan(n)` counts updated; `scripts/db-test-local.sh` and the CI database job both pass.                                                                                                                                                                                                                |
| **Performance**             | Indexes exist for RLS predicates (`lender_org_id`, `borrower_id`) and for foreign keys used in joins; `explain` checked for queries on large tables.                                                                                                                                                                                                                            |
| **Documentation**           | `docs/data/entity-model.md` and `docs/data/ownership.md` updated; an ADR updated if a recorded decision changes.                                                                                                                                                                                                                                                                |

---

## 5. Running the database tests locally

Prerequisites: a PostgreSQL 16 or later server, the pgTAP extension and `pg_prove` on the path.

```bash
PGHOST=localhost PGPORT=5432 PGUSER=postgres bash scripts/db-test-local.sh
# or
pnpm db:test:local
```

What `scripts/db-test-local.sh` does:

1. Drops and recreates a throwaway database (`udofin_test`, or `UDOFIN_TEST_DB`) and sets its
   `search_path`. **It destroys that database: never point it at a shared server or database.**
2. Applies `scripts/db/local-supabase-shim.sql`, which emulates the parts of Supabase the migrations and
   tests rely on: the roles `anon`, `authenticated`, `service_role` (with `bypassrls`) and
   `supabase_auth_admin`; the `auth` and `extensions` schemas; a minimal `auth.users` table; and
   `auth.jwt()`, `auth.uid()` and `auth.role()` reading `request.jwt.claims`. The shim is for local tests
   only and is never applied to Supabase or any shared environment.
3. Creates the pgTAP extension, applies every migration in filename order, applies `supabase/seed.sql`
   if it exists, and runs `pg_prove` over `supabase/tests/*.test.sql`.

Today the suite has 88 assertions (7 in `001_structure`, 34 in `002_tenant_isolation`, 47 in
`003_lifecycle_and_integrity`).

Limits of the local run: it uses PostgreSQL 16 while Supabase and CI use 17, and the shim's `auth.users`
is not Supabase Auth, so behaviour that depends on the real Auth service is only covered in CI.

Tests switch identity with helpers defined in the test files (`pg_temp.as_user(uid)` sets
`request.jwt.claims` and `set local role authenticated`; `pg_temp.as_system()` uses `service_role`),
which is the same pattern the API will use per request (`docs/api/README.md` §4.2).

---

## 6. Continuous integration

The `database` job in `.github/workflows/ci.yml` runs `supabase db start` and `supabase test db` on the
Supabase CLI stack with Postgres 17 (`major_version = 17` in `supabase/config.toml`). It runs on every
pull request and on pushes to `main`; a failure blocks the merge.

Planned additions (roadmap Phase 03): a migration lint step that checks the file-name format, refuses
edits to files already applied to a shared environment, and requires a test change alongside each
migration.

---

## 7. Applying migrations to shared environments

Summary of `docs/operations/deployment.md` §5: migrations are applied only by the pipeline, in the order
dev → staging → production; before production a PITR restore point is confirmed and recorded; the
expand migration is applied before the code that needs it; after applying, structural checks (RLS status,
grants) and the `private.audit_digest()` tamper check are run. A destructive mistake in production is
handled as an incident with a point-in-time restore.

---

## 8. Pre-production squash policy

| Period                                                                                                          | Rule                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Before the first deployment to any shared environment (dev, staging or production used by more than one person) | Migrations may be edited, renumbered or squashed into a new baseline, provided the whole test suite passes, `docs/data/entity-model.md` is updated, and the pull request says so.                                                                                                                     |
| From the first shared deployment onwards                                                                        | Applied migrations are immutable. Every change is a new file. A squashed baseline may be produced only for creating brand-new environments, and only if it yields exactly the same schema as replaying the history (verified by a schema comparison in CI); existing environments keep their history. |

Status today: nothing has been deployed (roadmap Phase 01), so the five baseline files may still be
corrected or squashed. The roadmap's Phase 02 plans forward-only corrective migrations for the schema
review findings, which is also allowed; the choice must be recorded in the Phase 02 specification.

---

## 9. Keeping database, backend and mobile versions compatible

| Boundary                  | How compatibility is kept                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database ↔ API and worker | Expand/contract (§4). Migrations are applied before the code that needs them; the contract step runs only after the previous code version is retired. The API and the worker are deployed from the same commit, worker first, so both run against the same schema version. Kysely types are regenerated from the schema in CI (planned, Phase 02).                                                                                                                                                                                                       |
| API ↔ mobile app          | The app never touches the database; it depends only on `/v1` (`docs/api/README.md` §10). Changes within `/v1` are additive. The API enforces a minimum supported app version with `426 app_version_unsupported`. Over-the-air updates are disabled (`apps/mobile/app.config.ts`), so every app change is a store release and older versions stay in use for weeks: the API must keep serving them until the minimum version is raised. Legal text, consent wording, loan terms and product rules come from the API, versioned, never bundled in the app. |
| API ↔ portals             | Portals are deployed with the API but still call versioned routes and ignore unknown fields, so either can be rolled back alone.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Shared packages           | `packages/contracts` and `packages/domain` are compiled into the API, portals and app. A breaking change to a contract is a coordinated major change, and the lifecycle in `packages/domain` must match the database (sync test).                                                                                                                                                                                                                                                                                                                        |
| Events                    | Event types carry a major version; producers publish old and new majors in parallel until consumers move (`docs/api/integration-contracts.md` §7). The outbox stores the type with its version, so replays stay readable.                                                                                                                                                                                                                                                                                                                                |
| Database ↔ evidence       | Append-only tables keep history under the schema version that wrote it; new columns on such tables are nullable or have defaults so old rows stay valid, and evidence hashes (consent notices, audit rows) are never recomputed over changed definitions.                                                                                                                                                                                                                                                                                                |
