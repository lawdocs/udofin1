# Restore drill (local)

|        |                                                                                                                                                                          |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Script | [`scripts/restore-drill.sh`](../../scripts/restore-drill.sh)                                                                                                             |
| Status | Implemented and run locally on 14 October 2026 (PostgreSQL 16, throwaway databases, synthetic data). **No managed restore has been rehearsed.**                          |
| Origin | Architecture verification, [`docs/architecture/phase-02-architecture-verification.md`](../architecture/phase-02-architecture-verification.md), item Q: "Restore tested". |

## What this proves, and what it does not

**Plain English.** The drill shows that the way we dump and restore our database brings back exactly what we
put in: the same tables, rows, security switches (row-level security enabled and forced), policies, grants,
function bodies and settings, and that the whole database test suite passes on the restored copy. It
catches a restore step that silently drops a grant or a row-level-security flag.

It does **not** prove any of the following. Each is still open and must be rehearsed on the real platform
before the first real borrower or lender data (see [`deployment.md`](deployment.md) and
[`../testing/strategy.md`](../testing/strategy.md) section 3.10):

| Not proven                                                                    | Why not                                                                                                                        |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Supabase point-in-time recovery (PITR) works, and how far back it reaches     | The drill uses `pg_dump` and `pg_restore` on a local server. PITR is a platform feature that was not used.                     |
| Where Supabase keeps backups and platform logs (region, India residency)      | Unverified; the written confirmation from Supabase is still outstanding (ADR 0010, `docs/data/ownership.md`).                  |
| Recovery point objective (RPO) and recovery time objective (RTO)              | Nothing was timed against a realistic data volume; no targets are decided (open decision D-28).                                |
| A managed restore into a new Supabase project, including `auth.*`             | The `auth` schema is created by a local stand-in (`scripts/db/local-supabase-shim.sql`), not by Supabase Auth.                 |
| Restore into an empty cluster                                                 | Roles are cluster-wide. The drill reuses the roles of the local server and does not drop or restore them (see below).          |
| Documents in object storage, secrets, DNS, application configuration, workers | Out of scope: the database only. The production document store does not exist yet ([spec](document-store-production-spec.md)). |
| Disaster recovery to another region                                           | Not designed (ADR 0010: later; D-28).                                                                                          |

Do not cite this drill as evidence of backup, recovery or business-continuity capability to a lender, auditor or
regulator. It is evidence of one local procedure and of our catalogue invariants.

## Running it

```bash
export PGHOST=/var/run/postgresql PGPORT=5432 PGUSER=postgres   # a local server only
UDOFIN_TEST_DB=udofin_drill bash scripts/restore-drill.sh --self-test
```

- `UDOFIN_TEST_DB` is the source database (default `udofin_drill`); `UDOFIN_RESTORE_DB` is the restored copy
  (default `<source>_restore`). Both are **dropped and recreated**. Names must start with `udofin_`.
- The script refuses a `PGHOST` that is not a local socket, `localhost`, `127.0.0.1` or `::1`.
- The dump is written to a temporary directory and deleted on exit (`UDOFIN_DRILL_KEEP=1` keeps it; it holds only
  synthetic data). It takes about 10 to 20 seconds on a laptop-class machine.
- Needs PostgreSQL 16 or newer with pgTAP, `psql`, `pg_dump`, `pg_restore` and `pg_prove`, as for
  `scripts/db-test-local.sh`.
- Never point it at a shared, staging or production database.

## What it does

1. **Build the source.** Creates the database, applies the local Supabase stand-in and every file in
   `supabase/migrations/` in order, and records each one in a ledger table
   (`supabase_migrations.schema_migrations`, the same name the Supabase CLI uses, created by the drill because the
   local path has no ledger). Then loads a small synthetic seed through the normal database functions: three
   organisations, three scheduled outbox events, two audit events (hash-chained by the existing trigger) and one
   idempotency record. The outbox events are scheduled far in the future so that the outbox tests, which claim
   ready events, are not disturbed.
2. **Baseline.** Runs the pgTAP suite on the source. If it fails the drill stops: a restore must not be blamed for a
   failure that was already there.
3. **Dump and restore.** `pg_dump --format=custom`, then `pg_restore --exit-on-error --single-transaction` into a
   second database created from `template0`. Any error aborts the restore. Database-level settings (the search
   path) are not part of a dump, so the script re-applies them exactly as `scripts/db-test-local.sh` does; on Supabase
   the platform provides them.
4. **Compare.** The same catalogue queries run on both databases and the outputs are diffed (table below). The
   migration ledger must hold one row per migration file, with the same versions, in both.
5. **Test the restored copy.** Runs the whole pgTAP suite on the restored database, including the structure
   (`001`), authorisation-matrix (`006`) and tenant-isolation (`002`) files.
6. **Self-test (`--self-test`).** Damages the restored copy in four ways and requires the drill to notice each:
   forced row-level security switched off on a table, `EXECUTE` on a system function granted to `PUBLIC`, one row
   changed, and the pgTAP suite run against the damaged copy. A drill that cannot fail proves nothing.

### What is compared

| Section                         | Compared                                                                                                                           |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `rowcounts`                     | Per table: row count and an MD5 digest of every row's text (so a changed value is caught, not only a missing row)                  |
| `rls`                           | Per table: row-level security enabled, forced, owner                                                                               |
| `policies`                      | Name, command, roles, `USING` and `WITH CHECK` expressions                                                                         |
| `table_grants`, `column_grants` | Every grantee and privilege on tables, views and sequences; column-level grants. A table with no explicit ACL shows its default    |
| `function_grants`               | Per function: kind, `SECURITY DEFINER`, owner, volatility, pinned `search_path` and other settings, MD5 of the body, `EXECUTE` ACL |
| `schema_acls`, `default_acls`   | Schema privileges and default privileges                                                                                           |
| `constraints`                   | Name, type, validated flag, definition (see the note on `CHECK` below)                                                             |
| `indexes`, `triggers`           | Full definitions; triggers also their enabled state                                                                                |
| `sequences`, `extensions`       | Last values; installed extensions and versions                                                                                     |
| `enums`, `comments`             | Enum labels in order; every object comment (CLAUDE.md requires comments on tables)                                                 |
| `db_settings`                   | Database-level settings                                                                                                            |

**Note on `CHECK` constraints.** The first run found that `pg_dump` writes a `CHECK` constraint back as deparsed
text and that re-reading it can regroup a chain of `AND`s: `((a AND b) AND c)` came back as `(a AND b AND c)`. The meaning is
identical, but the text differs, so a literal comparison failed on three constraints. `CHECK` definitions are
therefore compared with grouping parentheses removed (every column, operator and constant must still match). A
regrouping of mixed `AND` and `OR` would not be seen by that comparison. All other constraint kinds, and policies
(which matter more for security), are compared exactly. If a future policy differs only in grouping, the drill
will fail and an engineer must judge it; the rule is not loosened for policies.

## Result of the run

Run on 14 October 2026 against PostgreSQL 16.15, with the repository as it stood during the remediation
work (27 migration files, 14 pgTAP files). Counts change as migrations are added; the drill reads them from
the repository each time.

| Check                                       | Result                                                                           |
| ------------------------------------------- | -------------------------------------------------------------------------------- |
| pgTAP on the source (baseline)              | 14 files, 1025 tests, passed                                                     |
| `pg_dump` and `pg_restore --exit-on-error`  | About 1.07 MB archive, 1820 entries, restored without error                      |
| Catalogue sections compared                 | 16 of 16 identical                                                               |
| Restored database                           | 88 tables, 237 rows (reference data plus the seed), 155 policies, 1327 functions |
| Row-level security on the restored database | Enabled on 85 tables, forced on 79; identical to the source                      |
| Migration ledger                            | 27 of 27 migration files in both databases, versions identical                   |
| pgTAP on the restored database              | 14 files, 1025 tests, passed                                                     |
| Self-test                                   | All four kinds of damage detected                                                |

The 88 tables include three that are not Udofin domain tables (the two stand-in `auth` tables and the drill's ledger);
the 85 domain tables are all row-level-security enabled. These counts describe this run; they are not a
claim about any other environment.

## Limits of the drill itself

- **Roles are not restored.** Role definitions, passwords and memberships live outside a database dump. The drill
  reuses the local server's roles (`anon`, `authenticated`, `service_role`, `udofin_api`, `udofin_system`) and never
  drops them, because other work shares the server. A restore into an empty cluster would fail at the first
  `GRANT` (by design, `--exit-on-error`). The role bootstrap (migration `20261013000720_api_login_roles.sql` and the
  one-off grants in [`supabase-setup.md`](supabase-setup.md)) is therefore part of any real restore runbook and
  was not exercised.
- **Role-level settings** (for example the statement timeouts set on `udofin_api`) are cluster-wide and are not compared.
- **The restoring user is a superuser.** Row-level security does not apply to it, which is why row counts and digests
  can be read from every table. On a managed platform the restoring role has fewer rights; that difference is not
  exercised.
- **The seed is small.** It proves the mechanism and detects changes; it does not test volume, restore duration or
  bloat.
- **One server version.** Local PostgreSQL 16; CI and Supabase use 17. A dump from 17 restored into 17 was not tried.
- **Timing was not measured for any claim.** The wall-clock figure above is a convenience, not an RTO.

## What a real restore drill must still cover

To be agreed with the owner (decisions D-28 and the backup-region confirmation) and then rehearsed, quarterly
as recommended in [`../testing/strategy.md`](../testing/strategy.md) section 3.10:

1. Restore a Supabase backup or a PITR point into a **new** project in ap-south-1 (a project's region cannot be changed),
   re-create the application logins, re-apply the platform grants, and run `supabase test db` and
   `scripts/restore-drill.sh`'s comparison queries against it.
2. Record the measured recovery point and recovery time with a realistic data volume.
3. Verify the audit hash chain (`private.audit_digest()`) against exported anchors once the anchoring job exists (ADR 0013).
4. Confirm in writing where Supabase stores backups and platform logs, and keep that confirmation with the evidence.
5. Rehearse the application side: rotate the database credentials, repoint the API, workers and portals, and run the
   integration suite against the restored project.
6. Decide and rehearse restore of document storage once it exists (versioning, Object Lock, key availability).
