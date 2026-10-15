-- Tenant isolation and least privilege: who can see and change what, across lenders and borrowers.
begin;
create extension if not exists pgtap with schema extensions;
select plan(52);

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
  insert into payments.fingerprint_key_versions (key_version, proposed_by) values (1, u1) on conflict (key_version) do nothing;
  update payments.fingerprint_key_versions set status = 'active', approved_by = u2, approved_at = now() where key_version = 1 and status = 'proposed';
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
  insert into payments.merchant_registry (provider, merchant_ref, owner_kind, owner_org_id, purpose, claimed_by, verification_status, verification_evidence_ref,
                                          verified_by, verified_at)
    values (p_provider, 'SAMPLE-MERCHANT-' || v_tag, 'lender', p_lender, 'repayment', u1, 'verified', 'SAMPLE-EVIDENCE-3', u2, now()) returning id into v_mer;
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

select pg_temp.as_owner();
insert into servicing.loan_accounts (id, lender_org_id, application_id, borrower_id, source_system, lms_loan_ref, sanctioned_amount_minor,
  disbursed_amount_minor, disbursed_at, disbursement_reference) values
  ('a4000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000000', 'a2000000-0000-4000-8000-000000000003',
   (select id from identity.borrowers where user_id = '11111111-1111-4111-8111-111111111111'), 'finbyx', 'ALPHA-LN-0001', 5000000, 5000000, now(), 'UTR-TEST-0001'),
  ('b4000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000000', 'b2000000-0000-4000-8000-000000000002',
   (select id from identity.borrowers where user_id = '22222222-2222-4222-8222-222222222222'), 'lender_lms', 'BETA-LN-0001', 10000000, 10000000, now(), 'UTR-TEST-0002');
select pg_temp.as_system();

select pg_temp.as_owner();
insert into servicing.schedule_snapshots (id, lender_org_id, loan_account_id, version) values
  ('a5000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000000', 'a4000000-0000-4000-8000-000000000001', 1),
  ('b5000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000000', 'b4000000-0000-4000-8000-000000000001', 1);
select pg_temp.as_system();
select pg_temp.as_owner();
insert into servicing.schedule_installments (snapshot_id, lender_org_id, seq, due_date, principal_minor, interest_minor) values
  ('a5000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000000', 1, current_date + 30, 400000, 75000),
  ('b5000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000000', 1, current_date + 30, 800000, 160000);
select pg_temp.as_system();

-- Intents need an active payment configuration (Phase 08a); the SAMPLE helper builds one per lender.
select pg_temp.as_owner();
select pg_temp.sample_collection_config('a1000000-0000-4000-8000-000000000000', 'a7000000-0000-4000-8000-000000000001', 'Alpha collections (test)', 'XXXXXX1234');
select pg_temp.sample_collection_config('b1000000-0000-4000-8000-000000000000', 'b7000000-0000-4000-8000-000000000001', 'Beta collections (test)', 'XXXXXX5678');
select pg_temp.as_system();
select pg_temp.as_owner();
insert into payments.payment_intents (id, lender_org_id, loan_account_id, borrower_id, purpose, amount_minor, config_id, provider, idempotency_key) values
  ('a6000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000000', 'a4000000-0000-4000-8000-000000000001',
   (select id from identity.borrowers where user_id = '11111111-1111-4111-8111-111111111111'), 'installment', 475000, (select id from payments.lender_payment_configs where lender_org_id = 'a1000000-0000-4000-8000-000000000000'), 'mock_gateway', 'idem-a-0000000000001'),
  ('b6000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000000', 'b4000000-0000-4000-8000-000000000001',
   (select id from identity.borrowers where user_id = '22222222-2222-4222-8222-222222222222'), 'installment', 960000, (select id from payments.lender_payment_configs where lender_org_id = 'b1000000-0000-4000-8000-000000000000'), 'mock_gateway', 'idem-b-0000000000001');
select pg_temp.as_system();

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
  '42501', null, 'borrowers cannot create payment instructions at all (the system resolves the lender''s account)');
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

-- ============================== Settlement accounts (tenancy.lender_settlement_accounts) ======================
-- Visible to members holding payment.read in the owning lender and to platform staff holding payment.read; never to
-- another lender, a borrower or anon; nobody can write through the API role.
-- The two settlement accounts (a7..., b7...) are created, verified through the registry, by the shared fixture above.
select pg_temp.as_owner();

select pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000003');
select is((select array_agg(label) from tenancy.lender_settlement_accounts), array['Alpha collections (test)'], 'lender A admin sees only lender A''s settlement account');
select is((select count(*) from tenancy.lender_settlement_accounts where lender_org_id = 'b1000000-0000-4000-8000-000000000000'), 0::bigint,
  'lender A admin sees no settlement account of lender B');
select throws_ok($$insert into tenancy.lender_settlement_accounts (lender_org_id, label, bank_name, masked_account_ref)
    values ('a1000000-0000-4000-8000-000000000000', 'Mine', 'Test Bank', 'XXXXXX9999')$$, '42501', null, 'a lender cannot create settlement accounts through the API role');
select throws_ok($$update tenancy.lender_settlement_accounts set status = 'verified' where id = 'a7000000-0000-4000-8000-000000000001'$$,
  '42501', null, 'nor change one (verification is an operator action outside the API role)');
select pg_temp.as_user('bbbbbbbb-0000-4000-8000-000000000003');
select is((select array_agg(label) from tenancy.lender_settlement_accounts), array['Beta collections (test)'], 'lender B admin sees only lender B''s settlement account');
select pg_temp.as_user('bbbbbbbb-0000-4000-8000-000000000001');
select is((select count(*) from tenancy.lender_settlement_accounts), 0::bigint, 'a credit officer without payment.read sees no settlement account, not even the lender''s own');
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
select is((select count(*) from tenancy.lender_settlement_accounts), 0::bigint, 'a borrower sees no settlement account');
select pg_temp.as_user('0e0e0e0e-0000-4000-8000-000000000001');
select is((select count(*) from tenancy.lender_settlement_accounts), 2::bigint, 'platform operations (payment.read) can read both lenders'' accounts, as designed');
select throws_ok($$delete from tenancy.lender_settlement_accounts$$, '42501', null, 'but cannot delete them');
select pg_temp.as_user('0f0f0f0f-0000-4000-8000-000000000001');
select is((select count(*) from tenancy.lender_settlement_accounts), 0::bigint, 'platform staff without a role see none');
select pg_temp.as_owner();
set local role anon;
select throws_ok($$select count(*) from tenancy.lender_settlement_accounts$$, '42501', null, 'anon is refused outright');
select pg_temp.as_owner();
select throws_ok(
  $$insert into payments.payment_intents (lender_org_id, loan_account_id, borrower_id, purpose, amount_minor, config_id, settlement_account_id, provider, idempotency_key)
    values ('a1000000-0000-4000-8000-000000000000', 'a4000000-0000-4000-8000-000000000001',
      (select id from identity.borrowers where user_id = '11111111-1111-4111-8111-111111111111'), 'installment', 100, (select id from payments.lender_payment_configs where lender_org_id = 'a1000000-0000-4000-8000-000000000000'),
      'b7000000-0000-4000-8000-000000000001', 'mock_gateway', 'idem-cross-0000000001')$$,
  '23503', null, 'a payment instruction cannot point at another lender''s settlement account (composite key)');

-- ============================== Loan-account history (servicing.loan_account_events) ===========================
select pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000003');
select is((select array_agg(distinct lender_org_id) from servicing.loan_account_events), array['a1000000-0000-4000-8000-000000000000'::uuid],
  'lender A admin sees the history of lender A''s loan account only');
select pg_temp.as_user('bbbbbbbb-0000-4000-8000-000000000003');
select is((select count(*) from servicing.loan_account_events where lender_org_id = 'a1000000-0000-4000-8000-000000000000'), 0::bigint, 'lender B admin sees none of lender A''s loan-account history');
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
select is((select count(*) from servicing.loan_account_events), 0::bigint, 'borrower 1 cannot read the loan-account audit trail (it can hold staff user ids)');
select pg_temp.as_user('22222222-2222-4222-8222-222222222222');
select is((select count(*) from servicing.loan_account_events where lender_org_id = 'a1000000-0000-4000-8000-000000000000'), 0::bigint, 'borrower 2 cannot read it either');
select throws_ok($$insert into servicing.loan_account_events (lender_org_id, loan_account_id, event_type, new_status, new_sanctioned_amount_minor, source_system, actor)
    values ('b1000000-0000-4000-8000-000000000000', 'b4000000-0000-4000-8000-000000000001', 'created', 'active', 1, 'lender_lms', 'system')$$,
  '42501', null, 'nobody can write loan-account history through the API role');
select pg_temp.as_owner();
set local role anon;
select throws_ok($$select count(*) from servicing.loan_account_events$$, '42501', null, 'anon is refused outright');
select pg_temp.as_owner();

select pg_temp.as_owner();
select * from finish();
rollback;
