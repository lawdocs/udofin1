-- Structural guarantees that must hold for every table and function in the domain schemas.
begin;
create extension if not exists pgtap with schema extensions;
select plan(7);

select is(
  (select array_agg(n.nspname || '.' || c.relname order by 1)
   from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where c.relkind = 'r'
     and n.nspname in ('tenancy', 'identity', 'consent', 'audit', 'lending', 'servicing', 'payments')
     and not c.relrowsecurity),
  null,
  'every domain table has row level security enabled'
);

select is(
  (select array_agg(n.nspname || '.' || c.relname order by 1)
   from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where c.relkind = 'r'
     and n.nspname in ('identity', 'consent', 'audit', 'lending', 'servicing', 'payments')
     and c.relrowsecurity and not c.relforcerowsecurity
     and c.relname not in ('notices', 'product_categories', 'application_transitions')),
  null,
  'tables holding borrower or tenant data force row level security'
);

select is(
  (select array_agg(table_schema || '.' || table_name || ':' || privilege_type order by 1)
   from information_schema.role_table_grants
   where grantee in ('anon', 'public', 'PUBLIC')
     and table_schema in ('tenancy', 'identity', 'consent', 'audit', 'lending', 'servicing', 'payments')),
  null,
  'anon and public have no table privileges in domain schemas'
);

select is(
  (select array_agg(n.nspname || '.' || c.relname order by 1)
   from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where c.relkind in ('r', 'v')
     and n.nspname in ('tenancy', 'identity', 'consent', 'audit', 'lending', 'servicing', 'payments')
     and has_table_privilege('authenticated', c.oid, 'DELETE')),
  null,
  'authenticated users cannot DELETE from any domain table'
);

select is(
  (select array_agg(p.oid::regprocedure::text order by 1)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'private' and p.prosecdef
     and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) cfg where cfg like 'search_path=%')),
  null,
  'security definer functions pin their search_path'
);

select is(
  (select array_agg(p.oid::regprocedure::text order by 1)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'private' and p.prosecdef and has_function_privilege('anon', p.oid, 'EXECUTE')),
  null,
  'anon cannot execute security definer helpers'
);

select ok(
  not has_schema_privilege('anon', 'private', 'USAGE')
    and not has_schema_privilege('anon', 'lending', 'USAGE')
    and not has_schema_privilege('anon', 'payments', 'USAGE'),
  'anon has no access to private or domain schemas'
);

select * from finish();
rollback;
