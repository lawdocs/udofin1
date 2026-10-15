-- Hardening (migration 0600): history cannot be truncated; "system" means a trusted backend role;
-- borrower, lender-staff and platform-staff logins stay separate; consent, products, offers and
-- audit writes are bound to the right lender and people.
begin;
create extension if not exists pgtap with schema extensions;
select plan(35);

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

-- Phase 08a: a SAMPLE payment configuration (synthetic provider, merchant, verified registry entry, settlement account and an
-- active mock-mode configuration) so that fixtures can create payment intents, which now require one. Call as the owner.
-- In mock mode the helper switches the mock-provider guard on for this transaction. Identical in 002, 003, 004, 009 and 013; keep in sync.
create function pg_temp.sample_collection_config(
  p_lender uuid, p_settlement uuid default gen_random_uuid(), p_label text default 'SAMPLE collections', p_masked text default 'XXXXXX0000',
  p_provider text default 'mock_gateway', p_mode text default 'mock'
) returns uuid language plpgsql as $fn$
declare
  v_tag text := left(md5(p_lender::text), 12);
  u1 uuid := md5(p_lender::text || 'sample-maker')::uuid;
  u2 uuid := md5(p_lender::text || 'sample-checker')::uuid;
  u3 uuid := md5(p_lender::text || 'sample-submitter')::uuid;
  v_rule uuid; v_reg uuid; v_mer uuid; v_cfg uuid;
begin
  if p_mode = 'mock' then
    perform set_config('udofin.allow_mock_providers', 'on', true);
  end if;
  insert into auth.users (id, raw_app_meta_data) values (u1, '{"actor_type":"staff"}'), (u2, '{"actor_type":"staff"}'), (u3, '{"actor_type":"staff"}')
    on conflict (id) do nothing;
  insert into onboarding.lender_gates (lender_org_id, stage) values (p_lender, 'activated')
    on conflict (lender_org_id) do update set stage = 'activated';
  insert into payments.account_format_rules (country, account_type, version, min_digits, max_digits, ifsc_required, status, evidence_label, source_note,
                                             effective_from, drafted_by, submitted_by, submitted_at, approved_by, approved_at)
    values ('IN', 'sample_fixture', 1, 9, 18, true, 'approved', 'unverified', 'SAMPLE fixture rule, not a real source', date '2026-01-01', u1, u1, now(), u2, now())
    on conflict (country, account_type, version) do nothing;
  select id into v_rule from payments.account_format_rules where country = 'IN' and account_type = 'sample_fixture' and version = 1;
  insert into payments.account_registry (fingerprint, key_version, masked_ref, country, account_type, format_rule_id, format_validated, owner_kind, owner_org_id,
                                         legal_owner_name, permitted_purposes, verification_status, evidence_ref, effective_from, registered_by,
                                         idempotency_key, verified_by, verified_at)
    values (encode(sha256(convert_to('SAMPLE-FIXTURE-' || p_lender::text, 'UTF8')), 'hex'), 1, p_masked, 'IN', 'sample_fixture', v_rule, true, 'lender', p_lender,
            'SAMPLE Lender Ltd (fixture)', array['repayment_settlement'], 'verified', 'SAMPLE-EVIDENCE-1', current_date - 30, u1,
            'sample-fixture-registry-' || v_tag, u2, now())
    returning id into v_reg;
  insert into tenancy.lender_settlement_accounts (id, lender_org_id, label, bank_name, masked_account_ref, status, registry_id, verified_by, verified_at)
    values (p_settlement, p_lender, p_label, 'Test Bank', p_masked, 'verified', v_reg, u1, now());
  insert into payments.provider_register (provider, display_name, kind, status, authorisation_evidence_ref) values (p_provider, 'SAMPLE provider (fixture)', 'payment', 'approved', 'SAMPLE-AUTH-EVIDENCE-1')
    on conflict (provider) do nothing;
  insert into payments.merchant_registry (provider, merchant_ref, owner_kind, owner_org_id, purpose, claimed_by)
    values (p_provider, 'SAMPLE-MERCHANT-' || v_tag, 'lender', p_lender, 'repayment', u1) returning id into v_mer;
  insert into payments.lender_payment_configs (lender_org_id, provider, provider_mode, merchant_registry_id, settlement_account_id, secret_ref, webhook_secret_ref,
                                               endpoint_token_hash, evidence_ref, contract_section_ref, idempotency_key, drafted_by)
    values (p_lender, p_provider, p_mode, v_mer, p_settlement, 'SAMPLE_SECRET', 'SAMPLE_WEBHOOK_SECRET',
            encode(sha256(convert_to('SAMPLE-TOKEN-' || p_lender::text, 'UTF8')), 'hex'), 'SAMPLE-EVIDENCE-2', 'SAMPLE-CONTRACT-1',
            'sample-fixture-config-' || v_tag, u1) returning id into v_cfg;
  update payments.lender_payment_configs set status = 'pending_approval', submitted_by = u3, submitted_at = now(), status_changed_by = u3 where id = v_cfg;
  update payments.lender_payment_configs set status = 'active', approved_by = u2, approved_at = now(), status_changed_by = u2 where id = v_cfg;
  return v_cfg;
end
$fn$;

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

-- Intents need an active payment configuration (Phase 08a); the SAMPLE helper builds one per lender.
select pg_temp.as_owner();
select pg_temp.sample_collection_config('a1000000-0000-4000-8000-000000000000', gen_random_uuid(), 'SAMPLE collections', 'XXXXXX1234');
select pg_temp.sample_collection_config('b1000000-0000-4000-8000-000000000000', gen_random_uuid(), 'SAMPLE collections', 'XXXXXX5678');
select pg_temp.as_system();
insert into payments.payment_intents (id, lender_org_id, loan_account_id, borrower_id, purpose, amount_minor, config_id, provider, idempotency_key) values
  ('a6000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000000', 'a4000000-0000-4000-8000-000000000001',
   (select id from identity.borrowers where user_id = '11111111-1111-4111-8111-111111111111'), 'installment', 475000, (select id from payments.lender_payment_configs where lender_org_id = 'a1000000-0000-4000-8000-000000000000'), 'mock_gateway', 'idem-a-0000000000001'),
  ('b6000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000000', 'b4000000-0000-4000-8000-000000000001',
   (select id from identity.borrowers where user_id = '22222222-2222-4222-8222-222222222222'), 'installment', 960000, (select id from payments.lender_payment_configs where lender_org_id = 'b1000000-0000-4000-8000-000000000000'), 'mock_gateway', 'idem-b-0000000000001');

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

-- ============================== TRUNCATE =====================================================
select ok(not has_table_privilege('service_role', 'audit.events', 'TRUNCATE'), 'service_role cannot truncate the audit trail');
select is(
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where c.relkind = 'r' and n.nspname in ('tenancy', 'identity', 'consent', 'audit', 'lending', 'servicing', 'payments')
     and (has_table_privilege('service_role', c.oid, 'TRUNCATE') or has_table_privilege('authenticated', c.oid, 'TRUNCATE'))),
  0::bigint, 'no application role can truncate any domain table');
select throws_ok('truncate audit.events cascade', 'P0001', null, 'even the owner cannot truncate the audit trail');
select throws_ok('truncate payments.provider_events cascade', 'P0001', null, 'even the owner cannot truncate provider events');
select throws_ok('truncate consent.records cascade', 'P0001', null, 'even the owner cannot truncate the consent ledger');

-- ============================== Actor detection ==============================================
select pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001');
select is(private.current_actor(), 'lender', 'active lender staff act as lender');
select pg_temp.as_user('0e0e0e0e-0000-4000-8000-000000000001');
select is(private.current_actor(), 'platform', 'Udofin platform staff are not treated as lender staff');
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
select is(private.current_actor(), 'borrower', 'borrower acts as borrower');
select pg_temp.as_owner();
select set_config('request.jwt.claims', '', true);
set local role authenticated;
select is(private.current_actor(), 'none', 'an end-user role with no claims is nobody, never the system');
select pg_temp.as_owner();
create role udofin_test_login_role nologin inherit;
grant authenticated to udofin_test_login_role;
-- On Supabase the test user is not a superuser: it must be allowed to SET ROLE to a role it created.
grant udofin_test_login_role to current_user with set true;
set local role udofin_test_login_role;
select is(private.current_actor(), 'none', 'an application role that forgot SET ROLE is not the system (fail closed)');
select pg_temp.as_system();
select is(private.current_actor(), 'system', 'only a trusted backend role is the system');

-- ============================== Separate logins ==============================================
-- (These exercise the separation triggers themselves, so the change-control guard is lifted.)
select set_config('udofin.change_apply', 'on', true);
select throws_ok(
  $$insert into tenancy.memberships (org_id, user_id, status)
    values ('a1000000-0000-4000-8000-000000000000', '11111111-1111-4111-8111-111111111111', 'active')$$,
  '23514', null, 'a borrower login cannot be made lender staff');
select throws_ok(
  $$insert into identity.borrowers (user_id) values ('aaaaaaaa-0000-4000-8000-000000000001')$$,
  '23514', null, 'a staff login cannot become a borrower');
select throws_ok(
  $$insert into tenancy.memberships (org_id, user_id, status)
    values ('a1000000-0000-4000-8000-000000000000', '0e0e0e0e-0000-4000-8000-000000000001', 'active')$$,
  '23514', null, 'segregation of duties: platform staff cannot also be lender staff');
select set_config('udofin.change_apply', 'off', true);

-- ============================== Consent ======================================================
insert into consent.notices (id, purpose, version, language, lender_org_id, title, body_markdown, status, published_at, drafted_by, approved_by)
values ('c0000000-0000-4000-8000-000000000002', 'bureau_enquiry', 1, 'en', 'a1000000-0000-4000-8000-000000000000',
  'Alpha bureau consent', 'Alpha may obtain your credit report.', 'published', now(),
  '0f0f0f0f-0000-4000-8000-000000000001', '0e0e0e0e-0000-4000-8000-000000000001');
select throws_ok(
  $$insert into consent.notices (purpose, version, language, title, body_markdown, status, published_at, drafted_by, approved_by)
    values ('marketing', 1, 'en', 'Offers', 'We may send offers.', 'published', now(),
      '0e0e0e0e-0000-4000-8000-000000000001', '0e0e0e0e-0000-4000-8000-000000000001')$$,
  '23514', null, 'maker-checker: whoever drafted a notice cannot also approve it');
select throws_ok($$update consent.notices set drafted_by = '0e0e0e0e-0000-4000-8000-000000000001' where id = 'c0000000-0000-4000-8000-000000000002'$$,
  'P0001', null, 'the recorded drafter of a published notice cannot be rewritten');
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
select throws_ok(
  $$insert into consent.records (borrower_id, notice_id, lender_org_id, decision, channel)
    values ((select private.my_borrower_id()), 'c0000000-0000-4000-8000-000000000002', 'b1000000-0000-4000-8000-000000000000', 'granted', 'mobile_app')$$,
  '23514', null, 'lender A''s consent wording cannot authorise lender B');
select throws_ok(
  $$insert into consent.records (borrower_id, notice_id, lender_org_id, decision, channel)
    values ((select private.my_borrower_id()), 'c0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000000', 'granted', 'mobile_app')$$,
  '23514', null, 'consent to share with a lender must name a lender organisation');

-- ============================== Products, applications, offers ===============================
select pg_temp.as_system();
select throws_ok(
  $$insert into lending.loan_products (lender_org_id, category_key, code, name) values ('a1000000-0000-4000-8000-000000000000', 'payday', 'PAYDAY', 'Payday')$$,
  '23514', null, 'no lender can create a product in an unsupported category');
select throws_ok(
  $$insert into lending.applications (lender_org_id, loan_request_id, borrower_id, product_version_id, requested_amount_minor, requested_tenure_days)
    values ('b1000000-0000-4000-8000-000000000000', '70000000-0000-4000-8000-000000000003',
      (select id from identity.borrowers where user_id = '22222222-2222-4222-8222-222222222222'), 'b1910000-0000-4000-8000-000000000001', 1000000, 365)$$,
  '23503', null, 'an application cannot name a different borrower than its loan request');
select throws_ok(
  $$insert into lending.offers (lender_org_id, application_id, principal_minor, tenure_days, installment_frequency, installment_count,
      installment_amount_minor, annual_interest_rate_bps, apr_bps, total_repayable_minor, penal_charges_summary, valid_until)
    values ('a1000000-0000-4000-8000-000000000000', 'a2000000-0000-4000-8000-000000000002', 1000000, 365, 'monthly', 12, 92000, 1800, 2000,
      1104000, 'n/a', now() + interval '1 day')$$,
  'P0001', null, 'no offer before the lender has started reviewing the application');

-- ============================== Platform access scope ========================================
select pg_temp.as_owner();
update tenancy.organizations set status = 'offboarded' where id = 'b1000000-0000-4000-8000-000000000000';
select pg_temp.as_user('0e0e0e0e-0000-4000-8000-000000000001');
select is((select count(*) from lending.applications where lender_org_id = 'b1000000-0000-4000-8000-000000000000'), 0::bigint,
  'platform read access no longer reaches an offboarded lender');
select is((select count(*) from lending.applications where lender_org_id = 'a1000000-0000-4000-8000-000000000000'), 3::bigint,
  'but still reaches active lenders');

-- ============================== Audit hashing ================================================
select pg_temp.as_owner();
select isnt(
  private.audit_row_hash(row('01928c6e-7c1a-7d3e-9a4b-1f2e3d4c5b6a', '2026-10-10 00:00:00+00', 'system', null, null, null,
    'x.y', 'entity', 'abc', 'success', null, null, '{}', '')::audit.events),
  private.audit_row_hash(row('01928c6e-7c1a-7d3e-9a4b-1f2e3d4c5b6a', '2026-10-10 00:00:00+00', 'system', null, null, null,
    'x.y', 'entity', null, 'success', 'abc', null, '{}', '')::audit.events),
  'moving a value between neighbouring nullable fields changes the audit hash');
select is(
  private.audit_row_hash(row('01928c6e-7c1a-7d3e-9a4b-1f2e3d4c5b6a', '2026-10-10 00:00:00+00', 'system', null, null, null,
    'x.y', 'entity', 'a|b', 'success', null, null, '{}', '')::audit.events),
  private.audit_row_hash(row('01928c6e-7c1a-7d3e-9a4b-1f2e3d4c5b6a', '2026-10-10 00:00:00+00', 'system', null, null, null,
    'x.y', 'entity', 'a|b', 'success', null, null, '{}', '')::audit.events),
  'the audit hash is deterministic');
select pg_temp.as_user('0e0e0e0e-0000-4000-8000-000000000001');
select lives_ok($$select private.record_audit_event('organization.viewed', 'organization', 'a1000000-0000-4000-8000-000000000000',
  'a1000000-0000-4000-8000-000000000000')$$, 'platform staff can record events about any lender they support');

-- ============================== Offer responses ==============================================
select pg_temp.as_owner();
update tenancy.organizations set status = 'active' where id = 'b1000000-0000-4000-8000-000000000000';
select pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001');
select throws_ok($$update lending.offers set status = 'declined' where id = 'a3000000-0000-4000-8000-000000000001'$$,
  '42501', null, 'lender staff cannot decline an offer on the borrower''s behalf');
select lives_ok($$update lending.offers set status = 'withdrawn' where id = 'a3000000-0000-4000-8000-000000000001'$$,
  'lender staff can withdraw their own offer');
select pg_temp.as_system();
select throws_ok($$delete from servicing.loan_accounts where lms_loan_ref = 'ALPHA-LN-0001'$$,
  'P0001', null, 'a loan account with disbursement evidence cannot be deleted');

-- ============================== Consent notice visibility ====================================
select pg_temp.as_user('bbbbbbbb-0000-4000-8000-000000000001');
select is((select count(*) from consent.notices where lender_org_id = 'a1000000-0000-4000-8000-000000000000'), 0::bigint,
  'lender B staff cannot read lender A''s consent wording');
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
select is((select count(*) from consent.notices where status = 'published'), 2::bigint,
  'a borrower can read every published notice');
select pg_temp.as_owner();

-- ============================== Indexes behind RLS filters ===================================
select ok(exists(select 1 from pg_indexes where schemaname = 'payments' and tablename = 'payment_intents' and indexdef like '%(borrower_id, created_at DESC)%'),
  'borrower payment lookups are indexed');
select ok(exists(select 1 from pg_indexes where schemaname = 'payments' and tablename = 'provider_events' and indexdef like '%(lender_org_id, received_at DESC)%'),
  'lender provider-event lookups are indexed');
select ok(exists(select 1 from pg_indexes where schemaname = 'consent' and tablename = 'notices' and indexdef like '%(lender_org_id)%'),
  'lender consent-notice lookups are indexed');
select ok(exists(select 1 from pg_indexes where schemaname = 'lending' and tablename = 'applications' and indexdef like '%(product_version_id)%'),
  'applications by product version are indexed');

select * from finish();
rollback;
