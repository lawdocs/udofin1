-- =============================================================================================
-- Foundation: schemas, helper functions and default privileges.
--
-- Data lives in domain schemas that are NOT exposed through Supabase's REST API (PostgREST only
-- exposes `public` and `graphql_public`, see supabase/config.toml). Clients never query these
-- tables directly: every read/write goes through the Udofin API, which opens a transaction as the
-- `authenticated` role with the caller's JWT claims, so Row Level Security is a second, independent
-- enforcement layer behind the API's own authorisation checks.
-- =============================================================================================

-- Private helpers: never exposed, never granted to anon.
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;
-- Functions created by the migration role are not executable by PUBLIC unless a migration grants
-- it explicitly. (Per-schema defaults cannot revoke, so this is set globally for the role.)
-- Trigger functions need no EXECUTE grant to fire.
alter default privileges revoke execute on functions from public;

-- Domain schemas (bounded contexts). Ownership of each is documented in docs/data/ownership.md.
create schema if not exists tenancy;    -- organisations, memberships, roles, permissions
create schema if not exists identity;   -- borrower accounts (minimal data only)
create schema if not exists consent;    -- consent notices and the consent ledger
create schema if not exists audit;      -- tamper-evident audit trail
create schema if not exists lending;    -- products, loan requests, lender applications, offers
create schema if not exists servicing;  -- read-model of loans held in the lender's LMS
create schema if not exists payments;   -- payment instructions and provider events

do $$
declare
  s text;
begin
  foreach s in array array['tenancy', 'identity', 'consent', 'audit', 'lending', 'servicing', 'payments']
  loop
    execute format('revoke all on schema %I from public', s);
    execute format('revoke all on schema %I from anon', s);
    execute format('grant usage on schema %I to authenticated, service_role', s);
    -- New tables are not readable by anyone until a migration grants it explicitly.
    execute format('alter default privileges in schema %I revoke all on tables from public, anon, authenticated', s);
    execute format('alter default privileges in schema %I revoke all on functions from public, anon', s);
    execute format('alter default privileges in schema %I grant all on tables to service_role', s);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Time-ordered UUIDs (RFC 9562 version 7). Postgres 17 has no built-in uuidv7(); indexes stay
-- compact because new keys are always appended near the end of the B-tree.
-- ---------------------------------------------------------------------------------------------
create or replace function private.uuid_v7()
returns uuid
language plpgsql
volatile
set search_path = ''
as $$
declare
  unix_ms bigint := floor(extract(epoch from clock_timestamp()) * 1000);
  bytes bytea := uuid_send(gen_random_uuid());
begin
  bytes := set_byte(bytes, 0, ((unix_ms >> 40) & 255)::int);
  bytes := set_byte(bytes, 1, ((unix_ms >> 32) & 255)::int);
  bytes := set_byte(bytes, 2, ((unix_ms >> 24) & 255)::int);
  bytes := set_byte(bytes, 3, ((unix_ms >> 16) & 255)::int);
  bytes := set_byte(bytes, 4, ((unix_ms >> 8) & 255)::int);
  bytes := set_byte(bytes, 5, (unix_ms & 255)::int);
  bytes := set_byte(bytes, 6, (get_byte(bytes, 6) & 15) | 112);  -- version 7
  bytes := set_byte(bytes, 8, (get_byte(bytes, 8) & 63) | 128);  -- RFC 9562 variant
  return encode(bytes, 'hex')::uuid;
end
$$;
grant execute on function private.uuid_v7() to authenticated, service_role;

-- Maintains updated_at on mutable tables.
create or replace function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

-- Makes a table append-only: history is corrected by adding new rows, never by editing old ones.
create or replace function private.forbid_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% on %.% is not allowed: table is append-only', tg_op, tg_table_schema, tg_table_name
    using errcode = 'P0001', hint = 'Record a compensating entry instead.';
end
$$;
