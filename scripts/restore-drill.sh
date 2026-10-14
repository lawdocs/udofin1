#!/usr/bin/env bash
# Restore drill, local only. Proves the dump/restore PROCEDURE and our catalogue invariants on a
# throwaway PostgreSQL server. It does NOT prove Supabase point-in-time recovery, the backup region,
# RPO/RTO, or a managed restore: see docs/operations/restore-drill.md.
#
#   1. builds a source database (local Supabase shim + every migration + a small synthetic seed)
#   2. runs the pgTAP suite on it (the baseline: a restore cannot be blamed for a failure that was already there)
#   3. pg_dump (custom format) to a temp file, restores into a second database created from template0
#   4. asserts the restored database matches the source: per-table row counts and content digests, the
#      migration ledger, RLS enabled + forced flags, policies, table/column/function/schema grants,
#      function bodies and search_path pins, constraints, indexes, triggers, enums, comments, settings
#   5. runs the pgTAP suite on the restored database
#
# Usage:  PGHOST=/var/run/postgresql PGPORT=5432 PGUSER=postgres \
#           UDOFIN_TEST_DB=udofin_drill [UDOFIN_RESTORE_DB=udofin_drill_restore] \
#           bash scripts/restore-drill.sh [--self-test]
#   --self-test   afterwards damages the restored copy in three ways (forced RLS off, a PUBLIC execute
#                 grant, a changed row) and requires the comparison and the pgTAP suite to notice.
# Requires: PostgreSQL 16+ server with pgTAP, psql, pg_dump, pg_restore, pg_prove.
# Safety: refuses a non-local PGHOST and any database name not starting with "udofin_". It DROPS and
# recreates the two databases. Roles are cluster-wide and are neither dropped nor restored.
# Never point this at a shared, staging or production database. Synthetic data only.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="${UDOFIN_TEST_DB:-udofin_drill}"
DST="${UDOFIN_RESTORE_DB:-${SRC}_restore}"
export PGHOST="${PGHOST:-localhost}" PGPORT="${PGPORT:-5432}" PGUSER="${PGUSER:-postgres}"
# Make row text and catalogue output independent of the caller's session defaults.
export PGOPTIONS="-c TimeZone=UTC -c DateStyle=ISO,MDY -c IntervalStyle=postgres -c extra_float_digits=1"
SELF_TEST=0
case "${1:-}" in
  "") ;;
  --self-test) SELF_TEST=1 ;;
  *) echo "Unknown argument: $1" >&2; exit 2 ;;
esac

case "$PGHOST" in
  /* | localhost | 127.0.0.1 | ::1) ;;
  *) echo "Refusing: PGHOST=$PGHOST is not local. This drill drops and recreates databases." >&2; exit 2 ;;
esac
for name in "$SRC" "$DST"; do
  if [[ ! "$name" =~ ^udofin_[a-z0-9_]{1,40}$ ]]; then
    echo "Refusing database name '$name': it must match ^udofin_[a-z0-9_]+\$." >&2
    exit 2
  fi
done
if [[ "$SRC" == "$DST" ]]; then echo "Source and restore databases must differ." >&2; exit 2; fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/udofin-restore-drill.XXXXXX")"
trap '[[ "${UDOFIN_DRILL_KEEP:-0}" == 1 ]] || rm -rf "$WORK"' EXIT
mkdir -p "$WORK/sql" "$WORK/src" "$WORK/dst"

q() { psql -X -q -At -v ON_ERROR_STOP=1 "$@"; }
step() { echo; echo "==> $*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

# Database-level settings are not part of a dump. Provisioning must re-apply them, as the local
# scripts and (on Supabase) the platform do. Same statement as scripts/db-test-local.sh.
apply_db_settings() { q -d "$1" -c "alter database \"$1\" set search_path = \"\$user\", public, extensions;"; }

# ---------------------------------------------------------------------------------------------
# Catalogue queries. Each is deterministic (ordered, no OIDs) and run on both databases.
# ---------------------------------------------------------------------------------------------
SECTIONS=(rowcounts rls policies table_grants column_grants function_grants schema_acls default_acls
  constraints indexes triggers sequences extensions db_settings enums comments)

write_queries() {
  local d="$WORK/sql"
  local head="set search_path = pg_catalog;"
  local sys="n.nspname not in ('pg_catalog', 'information_schema') and n.nspname !~ '^pg_toast'"
  local grantee="case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end"

  cat > "$d/rowcounts.sql" <<SQL
$head
select n.nspname || '.' || c.relname,
       (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', n.nspname, c.relname), false, true, '')))[1]::text,
       (xpath('/row/d/text()', query_to_xml(format('select coalesce(md5(string_agg(t::text, E''\n'' order by t::text)), ''-'') as d from %I.%I as t', n.nspname, c.relname), false, true, '')))[1]::text
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('r', 'p') and $sys
order by 1;
SQL

  cat > "$d/rls.sql" <<SQL
$head
select n.nspname || '.' || c.relname, c.relkind, c.relrowsecurity, c.relforcerowsecurity, pg_get_userbyid(c.relowner)
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('r', 'p') and $sys
order by 1;
SQL

  cat > "$d/policies.sql" <<SQL
$head
select n.nspname || '.' || c.relname, p.polname, p.polcmd, p.polpermissive,
       coalesce((select string_agg(rn, ',' order by rn)
                 from (select case when r = 0 then 'PUBLIC' else pg_get_userbyid(r) end as rn from unnest(p.polroles) as r) s), ''),
       coalesce(pg_get_expr(p.polqual, p.polrelid), ''),
       coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace
order by 1, 2;
SQL

  cat > "$d/table_grants.sql" <<SQL
$head
select n.nspname || '.' || c.relname, c.relkind, $grantee, a.privilege_type, a.is_grantable
from pg_class c join pg_namespace n on n.oid = c.relnamespace
cross join lateral aclexplode(coalesce(c.relacl, acldefault((case c.relkind when 'S' then 's' else 'r' end)::"char", c.relowner))) a
where c.relkind in ('r', 'p', 'v', 'm', 'f', 'S') and $sys
order by 1, 3, 4;
SQL

  cat > "$d/column_grants.sql" <<SQL
$head
select n.nspname || '.' || c.relname || '.' || t.attname, $grantee, a.privilege_type, a.is_grantable
from pg_attribute t join pg_class c on c.oid = t.attrelid join pg_namespace n on n.oid = c.relnamespace
cross join lateral aclexplode(t.attacl) a
where t.attacl is not null and not t.attisdropped and $sys
order by 1, 2, 3;
SQL

  cat > "$d/function_grants.sql" <<SQL
$head
select n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
       p.prokind, p.prosecdef, pg_get_userbyid(p.proowner), p.provolatile,
       coalesce(array_to_string(p.proconfig, ';'), ''),
       md5(p.prosrc),
       coalesce((select string_agg($grantee || ':' || a.privilege_type, ',' order by $grantee, a.privilege_type)
                 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a), '')
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where p.prokind in ('f', 'p') and $sys
order by 1;
SQL

  cat > "$d/schema_acls.sql" <<SQL
$head
select n.nspname, pg_get_userbyid(n.nspowner), $grantee, a.privilege_type, a.is_grantable
from pg_namespace n
cross join lateral aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
where n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
order by 1, 3, 4;
SQL

  cat > "$d/default_acls.sql" <<SQL
$head
select pg_get_userbyid(d.defaclrole), coalesce(n.nspname, '*'), d.defaclobjtype, $grantee, a.privilege_type
from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace
cross join lateral aclexplode(d.defaclacl) a
order by 1, 2, 3, 4, 5;
SQL

  cat > "$d/constraints.sql" <<SQL
$head
-- pg_dump writes a CHECK back as deparsed text, and re-parsing it can regroup a chain of ANDs:
-- ((a AND b) AND c) becomes (a AND b AND c). The meaning is unchanged, so CHECK definitions are
-- compared without grouping parentheses (every column, operator and constant must still match).
-- All other constraint kinds are compared exactly.
select n.nspname || '.' || c.relname, k.conname, k.contype, k.convalidated,
       case when k.contype = 'c'
            then regexp_replace(regexp_replace(pg_get_constraintdef(k.oid), '[()]', '', 'g'), '\s+', ' ', 'g')
            else pg_get_constraintdef(k.oid) end
from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
where $sys
order by 1, 2;
SQL

  cat > "$d/indexes.sql" <<SQL
$head
select schemaname || '.' || tablename, indexname, indexdef
from pg_indexes
where schemaname not in ('pg_catalog', 'information_schema')
order by 1, 2;
SQL

  cat > "$d/triggers.sql" <<SQL
$head
select n.nspname || '.' || c.relname, t.tgname, t.tgenabled, pg_get_triggerdef(t.oid)
from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
where not t.tgisinternal and $sys
order by 1, 2;
SQL

  cat > "$d/sequences.sql" <<SQL
$head
select schemaname || '.' || sequencename, coalesce(last_value::text, 'unused')
from pg_sequences
where schemaname not in ('pg_catalog', 'information_schema')
order by 1;
SQL

  cat > "$d/extensions.sql" <<SQL
$head
select e.extname, e.extversion, n.nspname
from pg_extension e join pg_namespace n on n.oid = e.extnamespace
order by 1;
SQL

  cat > "$d/db_settings.sql" <<SQL
$head
select coalesce(pg_get_userbyid(nullif(s.setrole, 0)), '*'), unnest(s.setconfig)
from pg_db_role_setting s
where s.setdatabase = (select oid from pg_database where datname = current_database())
order by 1, 2;
SQL

  cat > "$d/enums.sql" <<SQL
$head
select t.typnamespace::regnamespace::text || '.' || t.typname, e.enumlabel,
       row_number() over (partition by e.enumtypid order by e.enumsortorder)
from pg_enum e join pg_type t on t.oid = e.enumtypid
where t.typnamespace::regnamespace::text not in ('pg_catalog', 'information_schema')
order by 1, 3;
SQL

  cat > "$d/comments.sql" <<SQL
$head
select pg_describe_object(d.classoid, d.objoid, d.objsubid), d.description
from pg_description d
where d.objoid >= 16384
order by 1;
SQL
}

report() { # report <database> <output dir>
  local s
  for s in "${SECTIONS[@]}"; do
    q -d "$1" -f "$WORK/sql/$s.sql" > "$2/$s.txt"
  done
}

# compare: prints one line per section; sets DIFFERING to the names that differ.
DIFFERING=()
compare() {
  DIFFERING=()
  local s lines
  printf '    %-16s %8s  %s\n' section lines result
  for s in "${SECTIONS[@]}"; do
    lines="$(wc -l < "$WORK/src/$s.txt")"
    if diff -u "$WORK/src/$s.txt" "$WORK/dst/$s.txt" > "$WORK/diff-$s.txt"; then
      printf '    %-16s %8s  identical\n' "$s" "$lines"
    else
      printf '    %-16s %8s  DIFFERENT\n' "$s" "$lines"
      DIFFERING+=("$s")
    fi
  done
}

run_pgtap() { # run_pgtap <database> <label> [files...]
  local db="$1" label="$2"; shift 2
  local tests=("$@")
  if (( ${#tests[@]} == 0 )); then tests=("$ROOT"/supabase/tests/*.test.sql); fi
  if (( ${#tests[@]} == 0 )); then fail "no pgTAP tests found"; fi
  if pg_prove -d "$db" --ext .sql "${tests[@]}" > "$WORK/pgtap-$label.log" 2>&1; then
    echo "    pgTAP on $label: $(grep -E '^Files=' "$WORK/pgtap-$label.log") $(grep -E '^Result:' "$WORK/pgtap-$label.log")"
    return 0
  fi
  echo "    pgTAP on $label FAILED (last lines of the log):" >&2
  tail -n 25 "$WORK/pgtap-$label.log" >&2
  return 1
}

write_queries
shopt -s nullglob
MIGRATIONS=("$ROOT"/supabase/migrations/*.sql)
if (( ${#MIGRATIONS[@]} == 0 )); then fail "no migrations found"; fi

# ---------------------------------------------------------------------------------------------
step "1/6 Source database '$SRC': shim, ${#MIGRATIONS[@]} migrations, synthetic seed"
q -d postgres -c "drop database if exists \"$SRC\" with (force);" -c "create database \"$SRC\";"
apply_db_settings "$SRC"
q -d "$SRC" -f "$ROOT/scripts/db/local-supabase-shim.sql"
q -d "$SRC" -c "create extension if not exists pgtap with schema extensions;"
# The Supabase CLI keeps a ledger of applied migrations; the local path does not, so the drill keeps
# one in the same place to prove the ledger survives a restore.
q -d "$SRC" -c "create schema supabase_migrations; create table supabase_migrations.schema_migrations (version text primary key, name text not null);"
for f in "${MIGRATIONS[@]}"; do
  base="$(basename "$f" .sql)"
  q -d "$SRC" -f "$f"
  q -d "$SRC" -c "insert into supabase_migrations.schema_migrations (version, name) values ('${base%%_*}', '${base#*_}');"
done
# Synthetic rows only, so that the row-count and digest checks compare something beyond reference data.
q -d "$SRC" > /dev/null <<'SQL'
insert into tenancy.organizations (kind, legal_name, display_name)
  values ('lender', 'Drill Lender One (synthetic)', 'Drill Lender One'),
         ('lender', 'Drill Lender Two (synthetic)', 'Drill Lender Two'),
         ('service_partner', 'Drill Partner (synthetic)', 'Drill Partner');
-- Scheduled far ahead so that the outbox pgTAP tests, which claim ready events, do not pick them up.
select ops.enqueue_event('drill.restore_check', '{"seq": 1}'::jsonb, null, 'drill-restore-dedupe-1', now() + interval '3650 days');
select ops.enqueue_event('drill.restore_check', '{"seq": 2}'::jsonb, null, 'drill-restore-dedupe-2', now() + interval '3650 days');
select ops.enqueue_event('drill.restore_check', '{"seq": 3}'::jsonb, null, 'drill-restore-dedupe-3', now() + interval '3650 days');
insert into audit.events (actor_type, action, entity_type, entity_id)
  values ('system', 'drill.seeded', 'restore_drill', '1'),
         ('system', 'drill.seeded', 'restore_drill', '2');
insert into ops.idempotency_keys (principal_id, route, idem_key, request_hash, response_status, response_body, expires_at)
  values ('00000000-0000-4000-8000-0000000000d1', 'POST /drill', 'drill-idempotency-key-0001', repeat('a', 64), 201, '{"ok": true}', now() + interval '1 day');
SQL

step "2/6 Baseline: pgTAP on the source"
run_pgtap "$SRC" source || fail "the pgTAP suite fails on the source database; fix that before judging a restore"

step "3/6 pg_dump (custom format) and restore into '$DST' (created from template0)"
DUMP="$WORK/drill.dump"
pg_dump --format=custom --file="$DUMP" "$SRC"
echo "    dump: $(wc -c < "$DUMP") bytes, $(pg_restore --list "$DUMP" | grep -vc '^;') archive entries"
q -d postgres -c "drop database if exists \"$DST\" with (force);" -c "create database \"$DST\" template template0;"
apply_db_settings "$DST"
pg_restore --exit-on-error --single-transaction --dbname="$DST" "$DUMP"
echo "    restored without error"

step "4/6 Compare the restored database with the source"
report "$SRC" "$WORK/src"
report "$DST" "$WORK/dst"
compare
RESULT=0
if (( ${#DIFFERING[@]} > 0 )); then
  RESULT=1
  for s in "${DIFFERING[@]}"; do echo "--- $s"; head -n 30 "$WORK/diff-$s.txt"; done
fi

files="$(printf '%s\n' "${MIGRATIONS[@]}" | xargs -n1 basename | sed 's/_.*//' | sort | paste -sd, -)"
for db in "$SRC" "$DST"; do
  ledger="$(q -d "$db" -c "select string_agg(version, ',' order by version) from supabase_migrations.schema_migrations;")"
  count="$(q -d "$db" -c "select count(*) from supabase_migrations.schema_migrations;")"
  if [[ "$ledger" == "$files" && "$count" == "${#MIGRATIONS[@]}" ]]; then
    echo "    migration ledger in $db: $count of ${#MIGRATIONS[@]} migration files, versions match"
  else
    echo "    migration ledger in $db: MISMATCH (ledger rows $count, files ${#MIGRATIONS[@]})" >&2
    RESULT=1
  fi
done
rows="$(awk -F'|' '{s += $2} END {print s + 0}' "$WORK/dst/rowcounts.txt")"
tables="$(wc -l < "$WORK/dst/rowcounts.txt")"
forced="$(awk -F'|' '$4 == "t"' "$WORK/dst/rls.txt" | wc -l)"
enabled="$(awk -F'|' '$3 == "t"' "$WORK/dst/rls.txt" | wc -l)"
echo "    restored: $tables tables, $rows rows, RLS enabled on $enabled, forced on $forced, $(wc -l < "$WORK/dst/policies.txt") policies, $(wc -l < "$WORK/dst/function_grants.txt") functions"
if (( rows == 0 )); then echo "    no rows were restored, the seed did not load" >&2; RESULT=1; fi

step "5/6 pgTAP on the restored database"
run_pgtap "$DST" restored || RESULT=1

step "6/6 Result"
if (( RESULT != 0 )); then
  echo "RESTORE DRILL FAILED"
  exit 1
fi
echo "Restore drill passed: the dump restored into '$DST' and every compared catalogue section and pgTAP file matches."
echo "Scope: local pg_dump/pg_restore only. Not evidence of Supabase PITR, backup region, RPO/RTO or a managed restore."

if (( SELF_TEST == 1 )); then
  step "Self-test: damage the restored copy and require the drill to notice"
  OK=1
  expect_diff() { # expect_diff <section> <what was done>
    report "$DST" "$WORK/dst"
    compare > /dev/null
    if [[ " ${DIFFERING[*]} " == *" $1 "* ]]; then
      echo "    detected: $2 (section $1 differs)"
    else
      echo "    NOT DETECTED: $2 (section $1 identical)" >&2; OK=0
    fi
  }
  q -d "$DST" -c "alter table tenancy.organizations no force row level security;"
  expect_diff rls "forced RLS switched off on tenancy.organizations"
  sig="$(q -d "$DST" -c "select n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'ops' and p.prosecdef order by 1 limit 1;")"
  q -d "$DST" -c "grant execute on function $sig to public;"
  expect_diff function_grants "EXECUTE on $sig granted to PUBLIC"
  q -d "$DST" -c "update tenancy.organizations set display_name = display_name || ' x' where legal_name = 'Drill Lender One (synthetic)';"
  expect_diff rowcounts "one row of tenancy.organizations changed"
  if run_pgtap "$DST" damaged > /dev/null 2>&1; then
    echo "    NOT DETECTED: the pgTAP suite still passes on the damaged copy" >&2; OK=0
  else
    echo "    detected: the pgTAP suite fails on the damaged copy"
  fi
  if (( OK != 1 )); then echo "SELF-TEST FAILED: the drill would have missed damage" >&2; exit 1; fi
  echo "Self-test passed: all four kinds of damage were detected."
fi
