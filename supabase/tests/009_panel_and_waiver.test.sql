-- Phase 04: lender transactions panel (view isolation, saved views, export audit) and the accounting waiver (D-33).
begin;
create extension if not exists pgtap with schema extensions;
select plan(27);

-- ---------------------------------------------------------------------------------------------
-- Shared fixture (identical in 002 and 003; keep in sync). Synthetic data only.
--   Orgs:  platform P, lender A (Alpha), lender B (Beta)
--   Users: borrowers b1, b2; A officer, A approver, A admin (drafter), A viewer;
--          B officer, B approver, B admin (drafter); platform ops agent; staff user with no role
-- ---------------------------------------------------------------------------------------------
create function pg_temp.as_user(uid uuid) returns void language plpgsql as $fn$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
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

-- The migrations revoke default EXECUTE from PUBLIC; test helpers must be callable after role switches.
grant execute on function pg_temp.as_user(uuid), pg_temp.as_system(), pg_temp.as_owner() to public;

insert into auth.users (id, phone, raw_app_meta_data) values
  ('11111111-1111-4111-8111-111111111111', '910000000001', '{}'),
  ('22222222-2222-4222-8222-222222222222', '910000000002', '{}'),
  ('aaaaaaaa-0000-4000-8000-000000000001', null, '{"actor_type":"staff"}'),
  ('aaaaaaaa-0000-4000-8000-000000000002', null, '{"actor_type":"staff"}'),
  ('aaaaaaaa-0000-4000-8000-000000000003', null, '{"actor_type":"staff"}'),
  ('aaaaaaaa-0000-4000-8000-000000000004', null, '{"actor_type":"staff"}'),
  ('bbbbbbbb-0000-4000-8000-000000000001', null, '{"actor_type":"staff"}'),
  ('bbbbbbbb-0000-4000-8000-000000000002', null, '{"actor_type":"staff"}'),
  ('bbbbbbbb-0000-4000-8000-000000000003', null, '{"actor_type":"staff"}'),
  ('0e0e0e0e-0000-4000-8000-000000000001', null, '{"actor_type":"staff"}'),
  ('0f0f0f0f-0000-4000-8000-000000000001', null, '{"actor_type":"staff"}');

select pg_temp.as_system();
-- Fixture rows are created directly; production code may only do this through change requests.
select set_config('udofin.change_apply', 'on', true);

insert into tenancy.organizations (id, kind, legal_name, display_name, regulator_registration_no, status) values
  ('a0000000-0000-4000-8000-000000000000', 'platform', 'Udofin Platform (test)', 'Udofin', null, 'active'),
  ('a1000000-0000-4000-8000-000000000000', 'lender', 'Alpha Finance Ltd (test)', 'Alpha Finance', 'TEST-NBFC-0001', 'active'),
  ('b1000000-0000-4000-8000-000000000000', 'lender', 'Beta Capital Ltd (test)', 'Beta Capital', 'TEST-NBFC-0002', 'active');

insert into tenancy.memberships (id, org_id, user_id, status) values
  ('a1a10000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000000', 'aaaaaaaa-0000-4000-8000-000000000001', 'active'),
  ('a1a10000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000000', 'aaaaaaaa-0000-4000-8000-000000000002', 'active'),
  ('a1a10000-0000-4000-8000-000000000003', 'a1000000-0000-4000-8000-000000000000', 'aaaaaaaa-0000-4000-8000-000000000003', 'active'),
  ('a1a10000-0000-4000-8000-000000000004', 'a1000000-0000-4000-8000-000000000000', 'aaaaaaaa-0000-4000-8000-000000000004', 'active'),
  ('b1b10000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000000', 'bbbbbbbb-0000-4000-8000-000000000001', 'active'),
  ('b1b10000-0000-4000-8000-000000000002', 'b1000000-0000-4000-8000-000000000000', 'bbbbbbbb-0000-4000-8000-000000000002', 'active'),
  ('b1b10000-0000-4000-8000-000000000003', 'b1000000-0000-4000-8000-000000000000', 'bbbbbbbb-0000-4000-8000-000000000003', 'active'),
  ('a0a00000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000000', '0e0e0e0e-0000-4000-8000-000000000001', 'active'),
  ('a0a00000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000000', '0f0f0f0f-0000-4000-8000-000000000001', 'active');

insert into tenancy.membership_roles (membership_id, role_id)
select m, (select id from tenancy.roles where org_id is null and applies_to = k::tenancy.organization_kind and key = r)
from (values
  ('a1a10000-0000-4000-8000-000000000001'::uuid, 'lender', 'credit_officer'),
  ('a1a10000-0000-4000-8000-000000000002'::uuid, 'lender', 'product_approver'),
  ('a1a10000-0000-4000-8000-000000000003'::uuid, 'lender', 'lender_admin'),
  ('a1a10000-0000-4000-8000-000000000004'::uuid, 'lender', 'viewer'),
  ('b1b10000-0000-4000-8000-000000000001'::uuid, 'lender', 'credit_officer'),
  ('b1b10000-0000-4000-8000-000000000002'::uuid, 'lender', 'product_approver'),
  ('b1b10000-0000-4000-8000-000000000003'::uuid, 'lender', 'lender_admin'),
  ('a0a00000-0000-4000-8000-000000000001'::uuid, 'platform', 'operations_agent')
) as g (m, k, r);

insert into lending.loan_products (id, lender_org_id, category_key, code, name, status) values
  ('a1900000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000000', 'personal', 'PL-STD', 'Alpha Personal Loan', 'active'),
  ('b1900000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000000', 'personal', 'PL-STD', 'Beta Personal Loan', 'active');

insert into lending.loan_product_versions (id, product_id, lender_org_id, version, status, min_amount_minor, max_amount_minor,
  min_tenure_days, max_tenure_days, rate_type, min_annual_rate_bps, max_annual_rate_bps, drafted_by, approved_by, approved_at, effective_from) values
  ('a1910000-0000-4000-8000-000000000001', 'a1900000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000000', 1, 'approved',
   1000000, 50000000, 180, 1825, 'fixed', 1400, 2400, 'aaaaaaaa-0000-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-000000000002', now(), now()),
  ('b1910000-0000-4000-8000-000000000001', 'b1900000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000000', 1, 'approved',
   1000000, 50000000, 180, 1825, 'fixed', 1500, 2600, 'bbbbbbbb-0000-4000-8000-000000000003', 'bbbbbbbb-0000-4000-8000-000000000002', now(), now());

insert into lending.loan_requests (id, borrower_id, category_key, requested_amount_minor, requested_tenure_days, purpose_code, status) values
  ('70000000-0000-4000-8000-000000000001', (select id from identity.borrowers where user_id = '11111111-1111-4111-8111-111111111111'), 'personal', 20000000, 720, 'home_renovation', 'submitted'),
  ('70000000-0000-4000-8000-000000000002', (select id from identity.borrowers where user_id = '22222222-2222-4222-8222-222222222222'), 'personal', 10000000, 365, 'medical', 'submitted'),
  ('70000000-0000-4000-8000-000000000003', (select id from identity.borrowers where user_id = '11111111-1111-4111-8111-111111111111'), 'personal', 5000000, 365, 'education', 'offer_selected');

insert into lending.applications (id, lender_org_id, loan_request_id, borrower_id, product_version_id, status, requested_amount_minor, requested_tenure_days)
select a.id::uuid, a.org::uuid, a.req::uuid, (select id from identity.borrowers where user_id = a.usr::uuid), a.ver::uuid,
       a.st::lending.application_status, 20000000, 720
from (values
  ('a2000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000000', '70000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'a1910000-0000-4000-8000-000000000001', 'under_review'),
  ('b2000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000000', '70000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'b1910000-0000-4000-8000-000000000001', 'under_review'),
  ('a2000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000000', '70000000-0000-4000-8000-000000000002', '22222222-2222-4222-8222-222222222222', 'a1910000-0000-4000-8000-000000000001', 'submitted'),
  ('b2000000-0000-4000-8000-000000000002', 'b1000000-0000-4000-8000-000000000000', '70000000-0000-4000-8000-000000000002', '22222222-2222-4222-8222-222222222222', 'b1910000-0000-4000-8000-000000000001', 'disbursed'),
  ('a2000000-0000-4000-8000-000000000003', 'a1000000-0000-4000-8000-000000000000', '70000000-0000-4000-8000-000000000003', '11111111-1111-4111-8111-111111111111', 'a1910000-0000-4000-8000-000000000001', 'disbursed')
) as a (id, org, req, usr, ver, st);

insert into lending.offers (id, lender_org_id, application_id, principal_minor, tenure_days, installment_frequency, installment_count,
  installment_amount_minor, annual_interest_rate_bps, apr_bps, processing_fee_minor, total_repayable_minor, penal_charges_summary, valid_until) values
  ('a3000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000000', 'a2000000-0000-4000-8000-000000000001',
   20000000, 720, 'monthly', 24, 1000000, 1800, 2050, 200000, 24000000, '2% p.a. on overdue instalment amount', now() + interval '7 days'),
  ('b3000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000000', 'b2000000-0000-4000-8000-000000000001',
   20000000, 720, 'monthly', 24, 1010000, 1900, 2150, 250000, 24240000, '2% p.a. on overdue instalment amount', now() + interval '7 days');

insert into servicing.loan_accounts (id, lender_org_id, application_id, borrower_id, source_system, lms_loan_ref, sanctioned_amount_minor,
  disbursed_amount_minor, disbursed_at, disbursement_reference) values
  ('a4000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000000', 'a2000000-0000-4000-8000-000000000003',
   (select id from identity.borrowers where user_id = '11111111-1111-4111-8111-111111111111'), 'finbyx', 'ALPHA-LN-0001', 5000000, 5000000, now(), 'UTR-TEST-0001'),
  ('b4000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000000', 'b2000000-0000-4000-8000-000000000002',
   (select id from identity.borrowers where user_id = '22222222-2222-4222-8222-222222222222'), 'lender_lms', 'BETA-LN-0001', 10000000, 10000000, now(), 'UTR-TEST-0002');

insert into servicing.schedule_snapshots (id, lender_org_id, loan_account_id, version) values
  ('a5000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000000', 'a4000000-0000-4000-8000-000000000001', 1),
  ('b5000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000000', 'b4000000-0000-4000-8000-000000000001', 1);
insert into servicing.schedule_installments (snapshot_id, lender_org_id, seq, due_date, principal_minor, interest_minor) values
  ('a5000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000000', 1, current_date + 30, 400000, 75000),
  ('b5000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000000', 1, current_date + 30, 800000, 160000);

insert into payments.payment_intents (id, lender_org_id, loan_account_id, borrower_id, purpose, amount_minor, settlement_account_ref, provider, idempotency_key) values
  ('a6000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000000', 'a4000000-0000-4000-8000-000000000001',
   (select id from identity.borrowers where user_id = '11111111-1111-4111-8111-111111111111'), 'installment', 475000, 'alpha-collections', 'mock_gateway', 'idem-a-0000000000001'),
  ('b6000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000000', 'b4000000-0000-4000-8000-000000000001',
   (select id from identity.borrowers where user_id = '22222222-2222-4222-8222-222222222222'), 'installment', 960000, 'beta-collections', 'mock_gateway', 'idem-b-0000000000001');

insert into consent.notices (id, purpose, version, language, title, body_markdown, status, published_at, drafted_by, approved_by) values
  ('c0000000-0000-4000-8000-000000000001', 'share_with_lenders', 1, 'en', 'Share my request with lenders', 'Test notice body.', 'published', now(),
   '0f0f0f0f-0000-4000-8000-000000000001', '0e0e0e0e-0000-4000-8000-000000000001');
insert into consent.records (borrower_id, notice_id, lender_org_id, decision, channel) values
  ((select id from identity.borrowers where user_id = '11111111-1111-4111-8111-111111111111'), 'c0000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000000', 'granted', 'mobile_app'),
  ((select id from identity.borrowers where user_id = '22222222-2222-4222-8222-222222222222'), 'c0000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000000', 'granted', 'mobile_app');

insert into audit.events (actor_type, tenant_org_id, action, entity_type, entity_id) values
  ('system', 'a1000000-0000-4000-8000-000000000000', 'application.routed', 'application', 'a2000000-0000-4000-8000-000000000001'),
  ('system', 'b1000000-0000-4000-8000-000000000000', 'application.routed', 'application', 'b2000000-0000-4000-8000-000000000001');

select pg_temp.as_owner();
select set_config('udofin.change_apply', 'off', true);
-- ------------------------------- end of shared fixture ---------------------------------------

create function pg_temp.as_aal2(uid uuid) returns void language plpgsql as $fn$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  execute 'set local role authenticated';
end
$fn$;
create function pg_temp.err(q text) returns text language plpgsql as $fn$
declare v_state text; v_hint text;
begin
  execute q;
  return 'ok';
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_hint = pg_exception_hint;
  return v_state || '|' || coalesce(v_hint, '');
end
$fn$;
grant execute on function pg_temp.as_aal2(uuid), pg_temp.err(text) to public;

-- Transactions panel: the view never widens access --------------------------------------------------
select pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000004');  -- A viewer: application.read, loan.read, payment.read
select is((select count(*) from lending.lender_transactions), 5::bigint, 'A viewer sees A''s 3 applications, 1 loan account and 1 payment');
select is((select count(*) from lending.lender_transactions where lender_org_id <> 'a1000000-0000-4000-8000-000000000000'), 0::bigint,
  'and nothing of lender B');
select pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001');  -- A credit officer: no payment.read
select is((select count(*) from lending.lender_transactions where kind = 'payment'), 0::bigint, 'a user without payment.read sees no payment rows');
select is((select count(*) from lending.lender_transactions where kind = 'application'), 3::bigint, 'but sees applications');
select pg_temp.as_user('bbbbbbbb-0000-4000-8000-000000000003');  -- B admin
select is((select count(*) from lending.lender_transactions where lender_org_id = 'a1000000-0000-4000-8000-000000000000'), 0::bigint,
  'lender B sees no lender A transactions');
select pg_temp.as_user('0e0e0e0e-0000-4000-8000-000000000001');  -- platform operations agent
select is((select count(distinct lender_org_id) from lending.lender_transactions), 2::bigint, 'platform operations staff see both lenders');
select pg_temp.as_user('0f0f0f0f-0000-4000-8000-000000000001');  -- platform staff with no role
select is((select count(*) from lending.lender_transactions), 0::bigint, 'staff with no role see nothing');
select pg_temp.as_owner();
select is((select count(*) from information_schema.columns where table_schema = 'lending' and table_name = 'lender_transactions'
           and column_name ~ 'borrower|phone|name|pan|aadhaar|account_ref'), 0::bigint, 'the feed exposes no borrower identity or account columns');

-- Saved views -----------------------------------------------------------------------------------------
select pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000003');  -- A admin
select is(pg_temp.err($$insert into lending.panel_views (lender_org_id, owner_user_id, name, config, shared)
  values ('a1000000-0000-4000-8000-000000000000', 'aaaaaaaa-0000-4000-8000-000000000003', 'Overdue payments', '{"kinds":["payment"]}', true)$$), 'ok',
  'a user saves a shared view for their lender');
select is(pg_temp.err($$insert into lending.panel_views (lender_org_id, owner_user_id, name, config)
  values ('b1000000-0000-4000-8000-000000000000', 'aaaaaaaa-0000-4000-8000-000000000003', 'Sneaky', '{}')$$), '42501|', 'nobody saves a view into another lender');
select is(pg_temp.err($$insert into lending.panel_views (lender_org_id, owner_user_id, name, config)
  values ('a1000000-0000-4000-8000-000000000000', 'aaaaaaaa-0000-4000-8000-000000000004', 'As someone else', '{}')$$), '42501|', 'nor under another person''s name');
select is(pg_temp.err($$insert into lending.panel_views (lender_org_id, owner_user_id, name, config)
  values ('a1000000-0000-4000-8000-000000000000', 'aaaaaaaa-0000-4000-8000-000000000003', 'Huge', jsonb_build_object('x', repeat('y', 5000)))$$), '23514|',
  'the stored configuration is size-bounded');
select pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000004');  -- A viewer
select is((select count(*) from lending.panel_views), 1::bigint, 'a colleague sees the shared view');
select is(pg_temp.err($$update lending.panel_views set name = 'Hijacked'$$), 'ok', 'an update by a non-owner is accepted by SQL but changes no row');
select is((select name from lending.panel_views), 'Overdue payments', 'the shared view was not changed by the colleague');
select is(pg_temp.err($$delete from lending.panel_views$$), '42501|', 'saved views cannot be deleted (archive instead)');
select pg_temp.as_user('bbbbbbbb-0000-4000-8000-000000000003');
select is((select count(*) from lending.panel_views), 0::bigint, 'lender B cannot see lender A''s views');

-- Export audit -------------------------------------------------------------------------------------------
select pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000004');
select is(pg_temp.err($$select lending.record_panel_export('a1000000-0000-4000-8000-000000000000', 'transactions', 12, array['status','from'])$$), 'ok',
  'an authorised reader records an export');
select pg_temp.as_user('bbbbbbbb-0000-4000-8000-000000000003');
select is(pg_temp.err($$select lending.record_panel_export('a1000000-0000-4000-8000-000000000000', 'transactions', 12, array['status'])$$), '42501|',
  'recording an export for another lender is refused');
select pg_temp.as_owner();
select is((select metadata ->> 'rows' from audit.events where action = 'lending.transactions.export' limit 1), '12', 'the export is audited with the row count');

-- Accounting waiver (D-33) -----------------------------------------------------------------------------------
insert into auth.users (id, phone, raw_app_meta_data) values
  ('0d000000-0000-4000-8000-000000000001', null, '{"actor_type":"staff"}'),
  ('0d000000-0000-4000-8000-000000000002', null, '{"actor_type":"staff"}'),
  ('0d000000-0000-4000-8000-000000000003', null, '{"actor_type":"staff"}');
select set_config('udofin.change_apply', 'on', true);
insert into tenancy.memberships (id, org_id, user_id, status) values
  ('0d0d0000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000000', '0d000000-0000-4000-8000-000000000001', 'active'),
  ('0d0d0000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000000', '0d000000-0000-4000-8000-000000000002', 'active'),
  ('0d0d0000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000000', '0d000000-0000-4000-8000-000000000003', 'active');
insert into tenancy.membership_roles (membership_id, role_id)
select m::uuid, (select id from tenancy.roles where org_id is null and applies_to = 'platform' and key = r)
from (values ('0d0d0000-0000-4000-8000-000000000001', 'onboarding_manager'),
             ('0d0d0000-0000-4000-8000-000000000002', 'onboarding_approver'),
             ('0d0d0000-0000-4000-8000-000000000003', 'compliance_officer')) as g (m, r);
select set_config('udofin.change_apply', 'off', true);
select pg_temp.as_aal2('0d000000-0000-4000-8000-000000000001');
select onboarding.profile_create('a1000000-0000-4000-8000-000000000000', 'nbfc_icc', '{"registration_no": "TEST-REG-W1"}');
select is(pg_temp.err($$select onboarding.waiver_request('a1000000-0000-4000-8000-000000000000', 'The accounting review will be completed after go-live under a plan.')$$), '55000|waiver_not_allowed',
  'by default the accounting record cannot be waived');
select pg_temp.as_aal2('0d000000-0000-4000-8000-000000000002');
select is(pg_temp.err($$select onboarding.set_setting('accounting_waiver_allowed', true, 'Approved by the owner for the pilot lenders')$$), '42501|',
  'only the compliance officer can switch the waiver option on');
select pg_temp.as_aal2('0d000000-0000-4000-8000-000000000003');
select is(pg_temp.err($$select onboarding.set_setting('accounting_waiver_allowed', true, 'short')$$), '22023|', 'switching it on needs a recorded reason');
select onboarding.set_setting('accounting_waiver_allowed', true, 'Owner decision: waiver permitted case by case with two-person approval');
select pg_temp.as_aal2('0d000000-0000-4000-8000-000000000001');
select set_config('t.w', onboarding.waiver_request('a1000000-0000-4000-8000-000000000000', 'The accounting review will be completed after go-live under a plan.')::text, true);
select is((select satisfied from onboarding.gate_conditions('a1000000-0000-4000-8000-000000000000', 'production_ready_approved') where key = 'accounting_profile_verified'), false,
  'a pending waiver does not satisfy the condition');
select is(pg_temp.err(format($$select onboarding.waiver_decide(%L, true)$$, current_setting('t.w'))), '42501|', 'the manager cannot approve the waiver (no approve permission)');
select pg_temp.as_aal2('0d000000-0000-4000-8000-000000000002');
select onboarding.waiver_decide(current_setting('t.w')::uuid, true, 'Accepted for the pilot');
select pg_temp.as_aal2('0d000000-0000-4000-8000-000000000001');
select is((select satisfied from onboarding.gate_conditions('a1000000-0000-4000-8000-000000000000', 'production_ready_approved') where key = 'accounting_profile_verified'), true,
  'an independently approved waiver satisfies the condition');
select pg_temp.as_aal2('0d000000-0000-4000-8000-000000000003');
select onboarding.set_setting('accounting_waiver_allowed', false, 'Pilot over: waivers are no longer permitted');
select pg_temp.as_aal2('0d000000-0000-4000-8000-000000000001');
select is((select satisfied from onboarding.gate_conditions('a1000000-0000-4000-8000-000000000000', 'production_ready_approved') where key = 'accounting_profile_verified'), false,
  'switching the option off ends the effect of existing waivers');

select * from finish();
rollback;
