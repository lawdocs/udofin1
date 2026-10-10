-- Tenant isolation and least privilege: who can see and change what, across lenders and borrowers.
begin;
create extension if not exists pgtap with schema extensions;
select plan(34);

-- ---------------------------------------------------------------------------------------------
-- Shared fixture (identical in 002 and 003; keep in sync). Synthetic data only.
--   Orgs:  platform P, lender A (Alpha), lender B (Beta)
--   Users: borrowers b1, b2; A officer, A approver, A admin (drafter), A viewer;
--          B officer; platform ops agent; staff user with no role
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
  ('0e0e0e0e-0000-4000-8000-000000000001', null, '{"actor_type":"staff"}'),
  ('0f0f0f0f-0000-4000-8000-000000000001', null, '{"actor_type":"staff"}');

select pg_temp.as_system();

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
   1000000, 50000000, 180, 1825, 'fixed', 1500, 2600, 'bbbbbbbb-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000002', now(), now());

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

insert into consent.notices (id, purpose, version, language, title, body_markdown, status, published_at, approved_by) values
  ('c0000000-0000-4000-8000-000000000001', 'share_with_lenders', 1, 'en', 'Share my request with lenders', 'Test notice body.', 'published', now(),
   '0e0e0e0e-0000-4000-8000-000000000001');
insert into consent.records (borrower_id, notice_id, lender_org_id, decision, channel) values
  ((select id from identity.borrowers where user_id = '11111111-1111-4111-8111-111111111111'), 'c0000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000000', 'granted', 'mobile_app'),
  ((select id from identity.borrowers where user_id = '22222222-2222-4222-8222-222222222222'), 'c0000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000000', 'granted', 'mobile_app');

insert into audit.events (actor_type, tenant_org_id, action, entity_type, entity_id) values
  ('system', 'a1000000-0000-4000-8000-000000000000', 'application.routed', 'application', 'a2000000-0000-4000-8000-000000000001'),
  ('system', 'b1000000-0000-4000-8000-000000000000', 'application.routed', 'application', 'b2000000-0000-4000-8000-000000000001');

select pg_temp.as_owner();
-- ------------------------------- end of shared fixture ---------------------------------------

-- ============================== Lender A credit officer ======================================
select pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001');

select is((select count(*) from lending.applications), 3::bigint, 'A officer sees exactly lender A''s three applications');
select is((select count(*) from lending.applications where lender_org_id <> 'a1000000-0000-4000-8000-000000000000'), 0::bigint,
  'A officer sees no application of another lender');
select is((select count(*) from lending.offers), 1::bigint, 'A officer sees only lender A''s offer');
select is((select count(*) from lending.application_events where lender_org_id = 'b1000000-0000-4000-8000-000000000000'), 0::bigint,
  'A officer sees no lifecycle events of lender B');
select is((select count(*) from servicing.loan_accounts), 1::bigint, 'A officer sees only lender A''s loan account');
select is((select count(*) from servicing.schedule_installments), 1::bigint, 'A officer sees only lender A''s schedule');
select is((select count(*) from lending.loan_requests), 0::bigint, 'lender staff cannot browse borrowers'' loan requests');
select is((select count(*) from payments.payment_intents), 0::bigint, 'credit officer without payment.read sees no payments');
select is((select count(*) from audit.events), 0::bigint, 'credit officer without audit.read sees no audit events');
select is((select count(*) from consent.records), 1::bigint, 'A officer sees only consents granted to lender A');
select is((select array_agg(display_name) from tenancy.organizations), array['Alpha Finance'], 'A officer sees only own organisation');
select is((select count(*) from identity.borrowers), 0::bigint, 'lender staff cannot list borrower accounts');

with u as (update lending.applications set lender_reference = 'X' where id = 'b2000000-0000-4000-8000-000000000001' returning 1)
select is(count(*), 0::bigint, 'A officer cannot update lender B''s application') from u;
select throws_ok(
  $$insert into lending.offers (lender_org_id, application_id, principal_minor, tenure_days, installment_frequency, installment_count,
      installment_amount_minor, annual_interest_rate_bps, apr_bps, total_repayable_minor, penal_charges_summary, valid_until)
    values ('b1000000-0000-4000-8000-000000000000', 'b2000000-0000-4000-8000-000000000001', 1000000, 365, 'monthly', 12, 90000, 1800, 2000,
      1080000, 'n/a', now() + interval '1 day')$$,
  '42501', null, 'A officer cannot issue an offer under lender B''s tenant id');
select throws_ok(
  $$insert into lending.offers (lender_org_id, application_id, principal_minor, tenure_days, installment_frequency, installment_count,
      installment_amount_minor, annual_interest_rate_bps, apr_bps, total_repayable_minor, penal_charges_summary, valid_until)
    values ('a1000000-0000-4000-8000-000000000000', 'b2000000-0000-4000-8000-000000000002', 1000000, 365, 'monthly', 12, 90000, 1800, 2000,
      1080000, 'n/a', now() + interval '1 day')$$,
  '23503', null, 'composite keys make an offer on another lender''s application impossible');

-- ============================== Lender A viewer ==============================================
select pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000004');
select is((select count(*) from payments.payment_intents), 1::bigint, 'A viewer with payment.read sees lender A''s payment only');
with u as (update lending.applications set lender_reference = 'X' where lender_org_id = 'a1000000-0000-4000-8000-000000000000' returning 1)
select is(count(*), 0::bigint, 'viewer cannot modify applications') from u;

-- ============================== Lender B credit officer ======================================
select pg_temp.as_user('bbbbbbbb-0000-4000-8000-000000000001');
select is((select count(*) from lending.applications), 2::bigint, 'B officer sees exactly lender B''s two applications');
select is((select count(*) from servicing.loan_accounts where lender_org_id = 'a1000000-0000-4000-8000-000000000000'), 0::bigint,
  'B officer sees no loan account of lender A');

-- ============================== Borrower 1 ===================================================
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
select is((select count(*) from lending.loan_requests), 2::bigint, 'borrower 1 sees own two loan requests');
select is((select count(*) from lending.applications), 3::bigint, 'borrower 1 sees own applications across lenders');
select is((select count(*) from lending.offers), 2::bigint, 'borrower 1 sees offers made to them by both lenders');
select is((select count(*) from payments.payment_intents), 1::bigint, 'borrower 1 sees only own payment');
select is((select count(*) from identity.borrowers), 1::bigint, 'borrower 1 sees only own account');
select is((select count(*) from tenancy.memberships), 0::bigint, 'borrowers see no staff memberships');
select throws_ok(
  $$insert into lending.loan_requests (borrower_id, category_key, requested_amount_minor, requested_tenure_days, purpose_code)
    values ((select id from identity.borrowers b where b.user_id = '22222222-2222-4222-8222-222222222222'), 'personal', 100000, 365, 'other')$$,
  '42501', null, 'borrower 1 cannot create a request for borrower 2');
select throws_ok(
  $$insert into payments.payment_intents (lender_org_id, loan_account_id, borrower_id, purpose, amount_minor, settlement_account_ref,
      provider, idempotency_key, created_by)
    values ('b1000000-0000-4000-8000-000000000000', 'b4000000-0000-4000-8000-000000000001',
      (select id from identity.borrowers b where b.user_id = '11111111-1111-4111-8111-111111111111'), 'installment', 100, 'x', 'mock_gateway',
      'idem-attack-000000001', '11111111-1111-4111-8111-111111111111')$$,
  '23514', null, 'borrower 1 cannot create a payment against borrower 2''s loan');
select throws_ok(
  $$update lending.applications set lender_reference = 'forged' where id = 'a2000000-0000-4000-8000-000000000001'$$,
  '42501', null, 'borrower cannot rewrite the lender reference on own application');

-- ============================== Borrower 2 ===================================================
select pg_temp.as_user('22222222-2222-4222-8222-222222222222');
select is((select count(*) from lending.offers), 0::bigint, 'borrower 2 cannot see offers made to borrower 1');
select is((select count(*) from consent.records), 1::bigint, 'borrower 2 sees only own consent records');

-- ============================== Platform operations agent ====================================
select pg_temp.as_user('0e0e0e0e-0000-4000-8000-000000000001');
select is((select count(*) from lending.applications), 5::bigint, 'ops agent can read applications across lenders (audited by API)');
with u as (update lending.applications set lender_reference = 'X' returning 1)
select is(count(*), 0::bigint, 'ops agent cannot change any lender''s application') from u;

-- ============================== Staff with no role / suspended ===============================
select pg_temp.as_user('0f0f0f0f-0000-4000-8000-000000000001');
select is((select count(*) from lending.applications), 0::bigint, 'platform staff without a role see nothing');

select pg_temp.as_owner();
update tenancy.memberships set status = 'suspended' where id = 'a1a10000-0000-4000-8000-000000000001';
select pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001');
select is((select count(*) from lending.applications), 0::bigint, 'suspended membership loses all access immediately');

select pg_temp.as_owner();
select * from finish();
rollback;
