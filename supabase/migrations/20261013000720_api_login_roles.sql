-- =============================================================================================
-- Application login roles (spec: docs/specs/02-database-security.md, W3 and W5).
--
-- The API connects with one of two logins, each able to assume exactly one role:
--   udofin_api     -> may only `SET ROLE authenticated`   (every user-initiated request; RLS applies)
--   udofin_system  -> may only `SET ROLE service_role`     (workers and the narrow admin module)
-- Neither is a superuser, neither can bypass row-level security itself, and neither owns any object.
-- NO PASSWORD is set here: passwords are created out of band and held in the secrets manager
-- (docs/operations/supabase-setup.md). Until a password is set neither login can connect.
-- =============================================================================================

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'udofin_api') then
    create role udofin_api login nosuperuser nocreatedb nocreaterole noinherit nobypassrls noreplication connection limit 40;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'udofin_system') then
    create role udofin_system login nosuperuser nocreatedb nocreaterole noinherit nobypassrls noreplication connection limit 10;
  end if;
end
$$;

-- SET only: the login cannot use the privileges of the role without switching to it explicitly.
-- On a managed Supabase project the migration role may not be allowed to grant the platform roles. The
-- migration then warns instead of failing, and the owner runs the two GRANT statements once as the
-- project owner (docs/operations/supabase-setup.md, step 3). Tests prove the result either way.
do $$
begin
  grant authenticated to udofin_api with inherit false, set true;
  grant service_role to udofin_system with inherit false, set true;
exception when insufficient_privilege then
  raise warning 'could not grant platform roles to the application logins; run docs/operations/supabase-setup.md step 3 as the project owner';
end
$$;

alter role udofin_api set statement_timeout = '30s';
alter role udofin_api set idle_in_transaction_session_timeout = '30s';
alter role udofin_system set statement_timeout = '120s';
alter role udofin_system set idle_in_transaction_session_timeout = '60s';

-- The logins can reach the schemas only through the roles they assume.
revoke all on schema public from udofin_api, udofin_system;

comment on role udofin_api is 'API login for user-initiated requests: SET ROLE authenticated only. No password in migrations.';
comment on role udofin_system is 'Worker/admin login: SET ROLE service_role only. No password in migrations.';
