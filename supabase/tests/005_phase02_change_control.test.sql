-- Phase 02: login roles, two-person change control, collections/DLG segregation, new tables.
-- Synthetic data only.
begin;
create extension if not exists pgtap with schema extensions;
select plan(39);

create function pg_temp.as_staff(uid uuid, aal text default 'aal2') returns void language plpgsql as $fn$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated', 'aal', aal)::text, true);
  execute 'set local role authenticated';
end
$fn$;
create function pg_temp.as_system() returns void language plpgsql as $fn$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
  execute 'set local role service_role';
end
$fn$;
create function pg_temp.as_owner() returns void language plpgsql as $fn$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
end
$fn$;
grant execute on function pg_temp.as_staff(uuid, text), pg_temp.as_system(), pg_temp.as_owner() to public;

insert into auth.users (id, phone, raw_app_meta_data) values
  ('c1000000-0000-4000-8000-000000000001', null, '{"actor_type":"staff"}'),  -- platform admin 1
  ('c1000000-0000-4000-8000-000000000002', null, '{"actor_type":"staff"}'),  -- platform admin 2
  ('c1000000-0000-4000-8000-000000000003', null, '{"actor_type":"staff"}'),  -- lender A admin
  ('c1000000-0000-4000-8000-000000000004', null, '{"actor_type":"staff"}'),  -- lender A viewer
  ('c1000000-0000-4000-8000-000000000005', null, '{"actor_type":"staff"}'),  -- lender B admin
  ('c1000000-0000-4000-8000-000000000006', null, '{"actor_type":"staff"}'),  -- new person to invite
  ('c1000000-0000-4000-8000-000000000007', null, '{"actor_type":"staff"}');  -- platform staff for segregation

-- Owner-run fixture (the database owner is exempt from change control, as in a break-glass bootstrap).
select pg_temp.as_owner();
insert into tenancy.organizations (id, kind, legal_name, display_name, regulator_registration_no, status) values
  ('c0000000-0000-4000-8000-000000000000', 'platform', 'Udofin Platform (test)', 'Udofin', null, 'active'),
  ('c2000000-0000-4000-8000-000000000000', 'lender', 'Gamma Finance Ltd (test)', 'Gamma', 'TEST-NBFC-0010', 'active'),
  ('c3000000-0000-4000-8000-000000000000', 'lender', 'Delta Capital Ltd (test)', 'Delta', 'TEST-NBFC-0011', 'active');
insert into tenancy.memberships (id, org_id, user_id, status) values
  ('c1c10000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000000', 'c1000000-0000-4000-8000-000000000001', 'active'),
  ('c1c10000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-000000000000', 'c1000000-0000-4000-8000-000000000002', 'active'),
  ('c1c10000-0000-4000-8000-000000000003', 'c2000000-0000-4000-8000-000000000000', 'c1000000-0000-4000-8000-000000000003', 'active'),
  ('c1c10000-0000-4000-8000-000000000004', 'c2000000-0000-4000-8000-000000000000', 'c1000000-0000-4000-8000-000000000004', 'active'),
  ('c1c10000-0000-4000-8000-000000000005', 'c3000000-0000-4000-8000-000000000000', 'c1000000-0000-4000-8000-000000000005', 'active'),
  ('c1c10000-0000-4000-8000-000000000007', 'c0000000-0000-4000-8000-000000000000', 'c1000000-0000-4000-8000-000000000007', 'active');
insert into tenancy.membership_roles (membership_id, role_id)
select m.mid::uuid, r.id from (values
  ('c1c10000-0000-4000-8000-000000000001', 'platform', 'platform_admin'),
  ('c1c10000-0000-4000-8000-000000000002', 'platform', 'platform_admin'),
  ('c1c10000-0000-4000-8000-000000000003', 'lender', 'lender_admin'),
  ('c1c10000-0000-4000-8000-000000000004', 'lender', 'viewer'),
  ('c1c10000-0000-4000-8000-000000000005', 'lender', 'lender_admin')
) as m (mid, kind, rkey)
join tenancy.roles r on r.org_id is null and r.applies_to = m.kind::tenancy.organization_kind and r.key = m.rkey;

-- Login roles ------------------------------------------------------------------------------------
select is((select rolsuper or rolbypassrls or rolcreaterole from pg_roles where rolname = 'udofin_api'), false,
  'udofin_api is not a superuser, cannot bypass RLS, cannot create roles');
select is((select rolsuper or rolbypassrls or rolcreaterole from pg_roles where rolname = 'udofin_system'), false,
  'udofin_system is not a superuser, cannot bypass RLS, cannot create roles');
select is(pg_has_role('udofin_api', 'service_role', 'member'), false, 'udofin_api cannot assume service_role');
select is(pg_has_role('udofin_api', 'authenticated', 'member'), true, 'udofin_api can assume authenticated');
select is(pg_has_role('udofin_system', 'authenticated', 'member'), false, 'udofin_system cannot assume authenticated');
select is((select rolpassword is null from pg_authid where rolname = 'udofin_api'), true, 'no password is set by migrations');

-- Direct writes are refused outside change control ------------------------------------------------
select pg_temp.as_system();
select throws_ok($$insert into tenancy.organizations (kind, legal_name, display_name) values ('lender', 'Rogue Ltd', 'Rogue')$$,
  '42501', null, 'system code cannot create an organisation directly');
select throws_ok($$update tenancy.organizations set status = 'suspended' where id = 'c2000000-0000-4000-8000-000000000000'$$,
  '42501', null, 'system code cannot change an organisation status directly');
select throws_ok($$insert into tenancy.memberships (org_id, user_id, status) values ('c2000000-0000-4000-8000-000000000000', 'c1000000-0000-4000-8000-000000000006', 'active')$$,
  '42501', null, 'system code cannot add a member directly');
select throws_ok($$insert into tenancy.membership_roles (membership_id, role_id) select 'c1c10000-0000-4000-8000-000000000004', id from tenancy.roles where key = 'lender_admin' and org_id is null$$,
  '42501', null, 'system code cannot grant a role directly');

-- Filing a request ---------------------------------------------------------------------------------
select pg_temp.as_staff('c1000000-0000-4000-8000-000000000001', 'aal1');
select throws_ok($$select private.request_change('organization.create', null,
  '{"kind":"lender","legal_name":"Epsilon Finance Ltd (test)","display_name":"Epsilon","regulator_registration_no":"TEST-NBFC-0020"}', 'key-epsilon-0000001')$$,
  '42501', null, 'a staff session without the second factor cannot file a request');

select pg_temp.as_staff('c1000000-0000-4000-8000-000000000004');
select throws_ok($$select private.request_change('membership.suspend', 'c2000000-0000-4000-8000-000000000000',
  '{"membership_id":"c1c10000-0000-4000-8000-000000000003"}', 'key-viewer-00000001')$$,
  '42501', null, 'a viewer without org.members.manage cannot file a request');

select pg_temp.as_staff('c1000000-0000-4000-8000-000000000003');
select throws_ok($$select private.request_change('membership.suspend', 'c3000000-0000-4000-8000-000000000000',
  '{"membership_id":"c1c10000-0000-4000-8000-000000000005"}', 'key-crosstenant-0001')$$,
  '42501', null, 'a lender admin cannot file a change for another lender');
select throws_ok($$select private.request_change('organization.create', null, '{"kind":"platform","legal_name":"X","display_name":"X"}', 'key-platform-0000001')$$,
  '42501', null, 'a lender admin cannot create organisations');

select pg_temp.as_staff('c1000000-0000-4000-8000-000000000001');
select throws_ok($$select private.request_change('organization.create', null, '{"kind":"platform","legal_name":"Second Platform","display_name":"P2"}', 'key-platform-0000002')$$,
  '22023', null, 'a second platform organisation cannot be requested');
select throws_ok($$select private.request_change('organization.create', null, '{"kind":"lender","legal_name":"Zeta Ltd (test)","display_name":"Zeta","owner":"x"}', 'key-unexpected-000001')$$,
  '22023', null, 'unexpected payload fields are rejected');

create temp table t_req (name text primary key, id uuid);
grant all on t_req to public;
insert into t_req select 'org', private.request_change('organization.create', null,
  '{"kind":"lender","legal_name":"Epsilon Finance Ltd (test)","display_name":"Epsilon","regulator_registration_no":"TEST-NBFC-0020"}', 'key-epsilon-0000001');
select is(private.request_change('organization.create', null,
  '{"kind":"lender","legal_name":"Epsilon Finance Ltd (test)","display_name":"Epsilon","regulator_registration_no":"TEST-NBFC-0020"}', 'key-epsilon-0000001'),
  (select id from t_req where name = 'org'), 'repeating the same request with the same key returns the original');
select throws_ok($$select private.request_change('organization.create', null,
  '{"kind":"lender","legal_name":"Different Ltd (test)","display_name":"Different"}', 'key-epsilon-0000001')$$,
  '23505', null, 'the same key with different content is refused');

-- Deciding -------------------------------------------------------------------------------------------
select throws_ok($$select private.decide_change_request((select id from t_req where name = 'org'), true)$$,
  '42501', null, 'a requester cannot approve their own request');
select pg_temp.as_staff('c1000000-0000-4000-8000-000000000003');
select throws_ok($$select private.decide_change_request((select id from t_req where name = 'org'), true)$$,
  'P0002', null, 'staff who cannot handle this type of request cannot see it');
select pg_temp.as_staff('c1000000-0000-4000-8000-000000000002', 'aal1');
select throws_ok($$select private.decide_change_request((select id from t_req where name = 'org'), true)$$,
  '42501', null, 'approval needs the second factor');
select pg_temp.as_staff('c1000000-0000-4000-8000-000000000002');
select is(private.decide_change_request((select id from t_req where name = 'org'), true), 'approved'::tenancy.change_request_status,
  'a different platform admin approves');
select throws_ok($$select private.decide_change_request((select id from t_req where name = 'org'), false)$$,
  '55000', null, 'a decided request cannot be decided again');

-- Applying ---------------------------------------------------------------------------------------------
select throws_ok($$select private.apply_change_request((select id from t_req where name = 'org'))$$,
  '42501', null, 'end users cannot apply a request');
select pg_temp.as_system();
select is((private.apply_change_request((select id from t_req where name = 'org')) ->> 'organization_id') is not null, true,
  'the system applies the approved request and gets the new organisation id');
select is((select status::text from tenancy.change_requests where id = (select id from t_req where name = 'org')), 'applied',
  'the request is marked applied');
select is((select count(*)::int from audit.events where action = 'change_request.applied'
           and entity_id = (select id::text from t_req where name = 'org')), 1,
  'applying wrote one audit event');
select is((select status::text from tenancy.organizations where legal_name = 'Epsilon Finance Ltd (test)'), 'onboarding',
  'a new organisation starts in onboarding');
select throws_ok($$select private.apply_change_request((select id from t_req where name = 'org'))$$,
  '55000', null, 'an applied request cannot be applied twice');
select throws_ok($$update tenancy.change_requests set payload = '{}' where id = (select id from t_req where name = 'org')$$,
  'P0001', null, 'a filed request cannot be edited');

-- Rejected and expired requests change nothing -------------------------------------------------------------
select pg_temp.as_staff('c1000000-0000-4000-8000-000000000001');
insert into t_req select 'reject', private.request_change('membership.invite', 'c2000000-0000-4000-8000-000000000000',
  '{"user_id":"c1000000-0000-4000-8000-000000000006"}', 'key-invite-reject-001');
select pg_temp.as_staff('c1000000-0000-4000-8000-000000000002');
select is(private.decide_change_request((select id from t_req where name = 'reject'), false, 'not needed'),
  'rejected'::tenancy.change_request_status, 'a request can be rejected');
select pg_temp.as_system();
select throws_ok($$select private.apply_change_request((select id from t_req where name = 'reject'))$$,
  '55000', null, 'a rejected request cannot be applied');
select is((select count(*)::int from tenancy.memberships where user_id = 'c1000000-0000-4000-8000-000000000006'), 0,
  'rejected invitation created no membership');

select pg_temp.as_staff('c1000000-0000-4000-8000-000000000001');
insert into t_req select 'stale', private.request_change('membership.invite', 'c2000000-0000-4000-8000-000000000000',
  '{"user_id":"c1000000-0000-4000-8000-000000000006"}', 'key-invite-stale-0001');
select pg_temp.as_owner();
update tenancy.change_requests set expires_at = now() - interval '1 minute' where id = (select id from t_req where name = 'stale');
select pg_temp.as_staff('c1000000-0000-4000-8000-000000000002');
select is(private.decide_change_request((select id from t_req where name = 'stale'), true),
  'expired'::tenancy.change_request_status, 'a stale request expires instead of being approved');

-- Invite, grant and the collections/DLG segregation rule ---------------------------------------------------------
select pg_temp.as_staff('c1000000-0000-4000-8000-000000000001');
insert into t_req select 'invite', private.request_change('membership.invite', 'c0000000-0000-4000-8000-000000000000',
  '{"user_id":"c1000000-0000-4000-8000-000000000006"}', 'key-invite-ok-000001');
select pg_temp.as_staff('c1000000-0000-4000-8000-000000000002');
select private.decide_change_request((select id from t_req where name = 'invite'), true);
select pg_temp.as_system();
create temp table t_member (id uuid);
grant all on t_member to public;
insert into t_member select (private.apply_change_request((select id from t_req where name = 'invite')) ->> 'membership_id')::uuid;

select pg_temp.as_staff('c1000000-0000-4000-8000-000000000001');
insert into t_req select 'grant_agent', private.request_change('role.grant', 'c0000000-0000-4000-8000-000000000000',
  json_build_object('membership_id', (select id from t_member), 'role_key', 'collections_agent')::jsonb, 'key-grant-agent-0001');
insert into t_req select 'grant_dlg', private.request_change('role.grant', 'c0000000-0000-4000-8000-000000000000',
  json_build_object('membership_id', (select id from t_member), 'role_key', 'dlg_finance')::jsonb, 'key-grant-dlg-000001');
select pg_temp.as_staff('c1000000-0000-4000-8000-000000000002');
select private.decide_change_request((select id from t_req where name = 'grant_agent'), true);
select private.decide_change_request((select id from t_req where name = 'grant_dlg'), true);
select pg_temp.as_system();
select private.apply_change_request((select id from t_req where name = 'grant_agent'));
select throws_ok($$select private.apply_change_request((select id from t_req where name = 'grant_dlg'))$$,
  '23514', null, 'one login cannot hold both collections.work and dlg.manage');
select is((select status::text from tenancy.change_requests where id = (select id from t_req where name = 'grant_dlg')), 'approved',
  'the refused grant was not applied');
select throws_ok($$insert into tenancy.role_permissions (role_id, permission_key)
  select r.id, 'dlg.manage' from tenancy.roles r where r.key = 'collections_agent' and r.org_id is null$$,
  '23514', null, 'a role cannot carry both collections.work and dlg.manage');

-- Visibility and loss of entitlement -------------------------------------------------------------------------------
select pg_temp.as_staff('c1000000-0000-4000-8000-000000000003');
select is((select count(*)::int from tenancy.change_requests where request_type = 'organization.create'), 0,
  'a lender admin cannot see platform-level change requests');

select pg_temp.as_staff('c1000000-0000-4000-8000-000000000001');
insert into t_req select 'revoke_agent', private.request_change('role.revoke', 'c0000000-0000-4000-8000-000000000000',
  json_build_object('membership_id', (select id from t_member), 'role_key', 'collections_agent')::jsonb, 'key-revoke-agent-001');
select pg_temp.as_staff('c1000000-0000-4000-8000-000000000002');
select private.decide_change_request((select id from t_req where name = 'revoke_agent'), true);
select pg_temp.as_owner();
delete from tenancy.membership_roles where membership_id = 'c1c10000-0000-4000-8000-000000000002';
select pg_temp.as_system();
select throws_ok($$select private.apply_change_request((select id from t_req where name = 'revoke_agent'))$$,
  '42501', null, 'an approval is void if the approver has since lost the permission');

select * from finish();
rollback;
