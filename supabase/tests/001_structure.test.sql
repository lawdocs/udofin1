-- Structural guarantees that must hold for every table and function in the domain schemas.
begin;
create extension if not exists pgtap with schema extensions;
select plan(10);

select is(
  (select array_agg(n.nspname || '.' || c.relname order by 1)
   from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where c.relkind = 'r'
     and n.nspname in ('tenancy', 'identity', 'consent', 'audit', 'lending', 'servicing', 'payments', 'onboarding', 'documents', 'ops')
     and not c.relrowsecurity),
  null,
  'every domain table has row level security enabled'
);

select is(
  (select array_agg(n.nspname || '.' || c.relname order by 1)
   from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where c.relkind = 'r'
     and n.nspname in ('identity', 'consent', 'audit', 'lending', 'servicing', 'payments', 'onboarding', 'documents', 'ops')
     and c.relrowsecurity and not c.relforcerowsecurity
     and c.relname not in ('notices', 'product_categories', 'application_transitions')),
  null,
  'tables holding borrower or tenant data force row level security'
);

select is(
  (select array_agg(table_schema || '.' || table_name || ':' || privilege_type order by 1)
   from information_schema.role_table_grants
   where grantee in ('anon', 'public', 'PUBLIC')
     and table_schema in ('tenancy', 'identity', 'consent', 'audit', 'lending', 'servicing', 'payments', 'onboarding', 'documents', 'ops')),
  null,
  'anon and public have no table privileges in domain schemas'
);

select is(
  (select array_agg(n.nspname || '.' || c.relname order by 1)
   from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where c.relkind in ('r', 'v')
     and n.nspname in ('tenancy', 'identity', 'consent', 'audit', 'lending', 'servicing', 'payments', 'onboarding', 'documents', 'ops')
     and has_table_privilege('authenticated', c.oid, 'DELETE')),
  null,
  'authenticated users cannot DELETE from any domain table'
);

select is(
  (select array_agg(p.oid::regprocedure::text order by 1)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('private', 'tenancy', 'identity', 'consent', 'audit', 'lending', 'servicing', 'payments', 'onboarding', 'documents', 'ops') and p.prosecdef
     and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) cfg where cfg like 'search_path=%')),
  null,
  'security definer functions pin their search_path (private and every domain schema)'
);

select is(
  (select array_agg(p.oid::regprocedure::text order by 1)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('private', 'tenancy', 'identity', 'consent', 'audit', 'lending', 'servicing', 'payments', 'onboarding', 'documents', 'ops') and p.prosecdef and has_function_privilege('anon', p.oid, 'EXECUTE')),
  null,
  'anon cannot execute security definer functions in private or any domain schema'
);

-- Neither anon nor PUBLIC may execute ANY function there (definer or not): every function is reachable only through an
-- explicit grant to authenticated or service_role. Functions that belong to extensions are not ours and are excluded.
select is(
  (select array_agg(p.oid::regprocedure::text order by 1)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('private', 'tenancy', 'identity', 'consent', 'audit', 'lending', 'servicing', 'payments', 'onboarding', 'documents', 'ops')
     and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
     and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('public', p.oid, 'EXECUTE'))),
  null,
  'neither anon nor PUBLIC can execute any function in private or any domain schema'
);

select is(
  (select array_agg(n.nspname order by 1)
   from pg_namespace n
   where n.nspname in ('private', 'tenancy', 'identity', 'consent', 'audit', 'lending', 'servicing', 'payments', 'onboarding', 'documents', 'ops')
     and (has_schema_privilege('anon', n.oid, 'USAGE') or has_schema_privilege('public', n.oid, 'USAGE'))),
  null,
  'anon and PUBLIC have no access to private or any domain schema'
);

-- PostgREST exposes only the `public` schema (supabase/config.toml). It must stay empty of our objects, so no domain
-- function or table can be reached over REST even if a grant regressed. (Extension-owned objects are excluded.
-- Nothing is asserted about pg_graphql here: the Supabase image may ship it.)
select is(
  (select array_agg(c.relname order by 1)
   from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
     and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')),
  null,
  'the public schema contains no tables, views or sequences'
);

select is(
  (select array_agg(p.oid::regprocedure::text order by 1)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')),
  null,
  'the public schema contains no functions'
);

select * from finish();
rollback;
