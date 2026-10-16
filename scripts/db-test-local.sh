#!/usr/bin/env bash
# Applies every migration to a throwaway local PostgreSQL database and runs the pgTAP suite.
# Usage: PGHOST=/tmp PGPORT=5432 PGUSER=postgres bash scripts/db-test-local.sh
# Requires: a running PostgreSQL 16+ server, the pgTAP extension and pg_prove on PATH.
# CI runs the same tests on the real Supabase stack (`supabase db start && supabase test db`).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB="${UDOFIN_TEST_DB:-udofin_test}"
export PGHOST="${PGHOST:-localhost}" PGPORT="${PGPORT:-5432}" PGUSER="${PGUSER:-postgres}"

psql -v ON_ERROR_STOP=1 -q -d postgres -c "drop database if exists \"$DB\" with (force);" -c "create database \"$DB\";"
psql -v ON_ERROR_STOP=1 -q -d "$DB" -c "alter database \"$DB\" set search_path = \"\$user\", public, extensions;"

echo "==> Applying local Supabase shim"
psql -v ON_ERROR_STOP=1 -q -d "$DB" -f "$ROOT/scripts/db/local-supabase-shim.sql"
psql -v ON_ERROR_STOP=1 -q -d "$DB" -c "create extension if not exists pgtap with schema extensions;"

echo "==> Applying migrations"
shopt -s nullglob
for f in "$ROOT"/supabase/migrations/*.sql; do
  echo "    $(basename "$f")"
  psql -v ON_ERROR_STOP=1 -q -d "$DB" -f "$f"
done

echo "==> Running pgTAP tests"
tests=("$ROOT"/supabase/tests/*.test.sql)
if (( ${#tests[@]} == 0 )); then
  echo "No tests found" >&2
  exit 1
fi
pg_prove -d "$DB" --ext .sql "${tests[@]}"
