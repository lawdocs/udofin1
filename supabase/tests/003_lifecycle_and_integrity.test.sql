-- Lifecycle rules and financial-record integrity, enforced by the database itself.
begin;
create extension if not exists pgtap with schema extensions;
select plan(69);

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

-- Fixture rows are created directly, as the database owner; production code may only do this through change requests. (The system role can no
-- longer do it by setting udofin.change_apply: migration 20261018000924, finding U53.)
select pg_temp.as_owner();
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
select pg_temp.sample_collection_config('a1000000-0000-4000-8000-000000000000', gen_random_uuid(), 'SAMPLE collections', 'XXXXXX1234');
select pg_temp.sample_collection_config('b1000000-0000-4000-8000-000000000000', gen_random_uuid(), 'SAMPLE collections', 'XXXXXX5678');
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

-- ============================== Offers (terms, expiry, decline) ==============================
select pg_temp.as_user('bbbbbbbb-0000-4000-8000-000000000001');
select throws_ok($$update lending.offers set principal_minor = 1 where id = 'b3000000-0000-4000-8000-000000000001'$$,
  '42501', null, 'offer terms are not updatable by users (column privileges)');
select throws_ok(
  $$insert into lending.offers (lender_org_id, application_id, principal_minor, tenure_days, installment_frequency, installment_count,
      installment_amount_minor, annual_interest_rate_bps, apr_bps, total_repayable_minor, penal_charges_summary, valid_until)
    values ('b1000000-0000-4000-8000-000000000000', 'b2000000-0000-4000-8000-000000000001', 1000000, 30, 'monthly', 1, 1100000, 1800, 19000,
      1100000, 'n/a', now() + interval '1 day')$$,
  '23514', null, 'an offer cannot go below the product''s minimum tenure');
select throws_ok(
  $$insert into lending.offers (lender_org_id, application_id, principal_minor, tenure_days, installment_frequency, installment_count,
      installment_amount_minor, annual_interest_rate_bps, apr_bps, total_repayable_minor, penal_charges_summary, valid_until)
    values ('b1000000-0000-4000-8000-000000000000', 'b2000000-0000-4000-8000-000000000001', 1000000, 365, 'monthly', 12, 100000, 9000, 9500,
      1200000, 'n/a', now() + interval '1 day')$$,
  '23514', null, 'an offer cannot exceed the product''s approved maximum rate');
select pg_temp.as_system();
select throws_ok($$update lending.offers set apr_bps = 100 where id = 'b3000000-0000-4000-8000-000000000001'$$,
  'P0001', null, 'offer terms are immutable even for the system');
select pg_temp.as_owner();
alter table lending.offers disable trigger offers_protect;
update lending.offers set valid_until = now() - interval '1 minute' where id = 'b3000000-0000-4000-8000-000000000001';
alter table lending.offers enable trigger offers_protect;
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
select throws_ok($$update lending.offers set status = 'accepted' where id = 'b3000000-0000-4000-8000-000000000001'$$,
  'P0001', 'offer has expired', 'an expired offer cannot be accepted');
select lives_ok($$update lending.offers set status = 'declined' where id = 'b3000000-0000-4000-8000-000000000001'$$,
  'the borrower can decline an offer');
select throws_ok($$update lending.offers set status = 'accepted' where id = 'b3000000-0000-4000-8000-000000000001'$$,
  'P0001', null, 'a declined offer is final');

-- ============================== Application lifecycle ========================================
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
select throws_ok($$update lending.offers set status = 'accepted' where id = 'a3000000-0000-4000-8000-000000000001'$$,
  'P0001', 'an offer can only be accepted on an approved application', 'an offer cannot be accepted before the lender approves');
select pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001');
select set_config('udofin.transition_reason', 'meets policy', true);
select lives_ok($$update lending.applications set status = 'approved' where id = 'a2000000-0000-4000-8000-000000000001'$$,
  'lender officer approves an application under review');
select set_config('udofin.transition_reason', '', true);
select is(
  (select row(from_status::text, to_status::text, actor, reason)::text from lending.application_events
   where application_id = 'a2000000-0000-4000-8000-000000000001' order by occurred_at desc, id desc limit 1),
  row('under_review', 'approved', 'lender', 'meets policy')::text,
  'the transition is recorded with actor and reason in the same transaction');
select ok((select decided_at is not null from lending.applications where id = 'a2000000-0000-4000-8000-000000000001'),
  'decision time is stamped');
select throws_ok($$update lending.applications set status = 'disbursement_pending' where id = 'a2000000-0000-4000-8000-000000000001'$$,
  'P0001', null, 'skipping lifecycle steps is rejected');
select throws_ok($$update lending.applications set status = 'offer_accepted' where id = 'a2000000-0000-4000-8000-000000000001'$$,
  '42501', null, 'lender staff cannot accept an offer on the borrower''s behalf');

select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
select throws_ok($$update lending.applications set status = 'approved' where id = 'b2000000-0000-4000-8000-000000000001'$$,
  '42501', null, 'a borrower cannot approve their own application');
select throws_ok($$update lending.applications set status = 'offer_accepted' where id = 'a2000000-0000-4000-8000-000000000001'$$,
  'P0001', null, 'an application cannot be accepted without accepting the lender''s offer');
select lives_ok($$update lending.offers set status = 'accepted' where id = 'a3000000-0000-4000-8000-000000000001'$$,
  'borrower accepts lender A''s offer');
select lives_ok($$update lending.applications set status = 'offer_accepted' where id = 'a2000000-0000-4000-8000-000000000001'$$,
  'and then accepts lender A''s approved application');

select pg_temp.as_user('bbbbbbbb-0000-4000-8000-000000000001');
select lives_ok($$update lending.applications set status = 'approved' where id = 'b2000000-0000-4000-8000-000000000001'$$,
  'lender B approves the same request independently');
select lives_ok(
  $$insert into lending.offers (id, lender_org_id, application_id, principal_minor, tenure_days, installment_frequency, installment_count,
      installment_amount_minor, annual_interest_rate_bps, apr_bps, total_repayable_minor, penal_charges_summary, valid_until, created_by, issued_at)
    values ('b3000000-0000-4000-8000-000000000002', 'b1000000-0000-4000-8000-000000000000', 'b2000000-0000-4000-8000-000000000001',
      20000000, 720, 'monthly', 24, 1010000, 1900, 2150, 24240000, '2% p.a. on overdue instalment amount', now() + interval '7 days',
      '0e0e0e0e-0000-4000-8000-000000000001', now() - interval '30 days')$$,
  'lender B issues a fresh offer');
select ok(
  (select created_by = 'bbbbbbbb-0000-4000-8000-000000000001' and issued_at = now()
   from lending.offers where id = 'b3000000-0000-4000-8000-000000000002'),
  'the database records the real issuer and time, ignoring forged values');
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
select throws_ok($$update lending.offers set status = 'accepted' where id = 'b3000000-0000-4000-8000-000000000002'$$,
  'P0001', null, 'a borrower cannot accept competing offers from two lenders for one request');
select throws_ok($$update lending.applications set status = 'offer_accepted' where id = 'b2000000-0000-4000-8000-000000000001'$$,
  'P0001', null, 'and cannot move lender B''s application forward without an accepted offer');

select pg_temp.as_system();
update lending.applications set status = 'agreement_pending' where id = 'a2000000-0000-4000-8000-000000000001';
update lending.applications set status = 'agreement_executed' where id = 'a2000000-0000-4000-8000-000000000001';
update lending.applications set status = 'disbursement_pending' where id = 'a2000000-0000-4000-8000-000000000001';
select throws_ok($$update lending.applications set status = 'disbursed' where id = 'a2000000-0000-4000-8000-000000000001'$$,
  'P0001', 'cannot mark application disbursed without recorded disbursement evidence',
  'approval and agreement alone never make an application disbursed');
select pg_temp.as_owner();
select throws_ok(
  $$insert into servicing.loan_accounts (lender_org_id, application_id, borrower_id, source_system, lms_loan_ref, sanctioned_amount_minor, disbursed_at)
    values ('a1000000-0000-4000-8000-000000000000', 'a2000000-0000-4000-8000-000000000001',
      (select id from identity.borrowers where user_id = '11111111-1111-4111-8111-111111111111'), 'finbyx', 'ALPHA-LN-0002', 20000000, now())$$,
  '23514', null, 'disbursement evidence must be complete (date, amount and bank reference together)');
select pg_temp.as_system();
select pg_temp.as_owner();
select throws_ok(
  $$insert into servicing.loan_accounts (lender_org_id, application_id, borrower_id, source_system, lms_loan_ref, sanctioned_amount_minor,
      disbursed_amount_minor, disbursed_at, disbursement_reference)
    values ('a1000000-0000-4000-8000-000000000000', 'a2000000-0000-4000-8000-000000000001',
      (select id from identity.borrowers where user_id = '22222222-2222-4222-8222-222222222222'), 'finbyx', 'ALPHA-LN-0002', 20000000, 20000000, now(), 'UTR-TEST-0003')$$,
  '23503', null, 'a loan account cannot name a different borrower than its application');
select pg_temp.as_system();
select pg_temp.as_owner();
select throws_ok(
  $$insert into servicing.loan_accounts (lender_org_id, application_id, borrower_id, source_system, lms_loan_ref, sanctioned_amount_minor,
      disbursed_amount_minor, disbursed_at, disbursement_reference)
    values ('a1000000-0000-4000-8000-000000000000', 'a2000000-0000-4000-8000-000000000001',
      (select id from identity.borrowers where user_id = '11111111-1111-4111-8111-111111111111'), 'finbyx', 'ALPHA-LN-0002', 20000000, 20000000, now(), 'UTR-TEST-0001')$$,
  '23505', null, 'a bank reference already used as disbursement evidence cannot be reused');
select pg_temp.as_system();
select pg_temp.as_owner();
insert into servicing.loan_accounts (lender_org_id, application_id, borrower_id, source_system, lms_loan_ref, sanctioned_amount_minor,
  disbursed_amount_minor, disbursed_at, disbursement_reference)
values ('a1000000-0000-4000-8000-000000000000', 'a2000000-0000-4000-8000-000000000001',
  (select id from identity.borrowers where user_id = '11111111-1111-4111-8111-111111111111'), 'finbyx', 'ALPHA-LN-0002', 20000000, 20000000, now(), 'UTR-TEST-0003');
select pg_temp.as_system();
select lives_ok($$update lending.applications set status = 'disbursed' where id = 'a2000000-0000-4000-8000-000000000001'$$,
  'with the lender''s disbursement evidence recorded, the system marks it disbursed');
select pg_temp.as_owner();
select throws_ok($$update servicing.loan_accounts set disbursement_reference = 'UTR-OTHER' where lms_loan_ref = 'ALPHA-LN-0002'$$,
  'P0001', null, 'recorded disbursement evidence cannot be rewritten');
select pg_temp.as_system();
select throws_ok($$update lending.applications set status = 'cancelled' where id = 'a2000000-0000-4000-8000-000000000001'$$,
  'P0001', null, 'disbursed is terminal');
select is((select count(*) from lending.application_events where application_id = 'a2000000-0000-4000-8000-000000000001'), 7::bigint,
  'every status change left exactly one lifecycle event');

-- ============================== Loan requests ================================================
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
select throws_ok($$update lending.loan_requests set requested_amount_minor = 99999999 where id = '70000000-0000-4000-8000-000000000001'$$,
  'P0001', null, 'terms of a submitted request cannot be edited');
select throws_ok($$update lending.loan_requests set status = 'offer_selected' where id = '70000000-0000-4000-8000-000000000001'$$,
  '42501', null, 'only the system records offer selection');
select throws_ok(
  $$insert into lending.loan_requests (borrower_id, category_key, requested_amount_minor, requested_tenure_days, purpose_code)
    values ((select private.my_borrower_id()), 'payday', 500000, 15, 'other')$$,
  '23514', null, 'payday loans cannot be requested');
select throws_ok(
  $$insert into lending.loan_requests (borrower_id, category_key, requested_amount_minor, requested_tenure_days, purpose_code)
    values ((select private.my_borrower_id()), 'personal', 500000, 30, 'other')$$,
  '23514', null, 'a personal loan cannot be requested below the platform''s minimum tenure');
select lives_ok($$update lending.loan_requests set status = 'withdrawn' where id = '70000000-0000-4000-8000-000000000001'$$,
  'a borrower can withdraw a submitted request');

-- ============================== Payment intents ==============================================
select pg_temp.as_system();
select pg_temp.as_owner();
select lives_ok(
  $$insert into payments.payment_intents (id, lender_org_id, loan_account_id, borrower_id, purpose, amount_minor, config_id,
      provider, idempotency_key)
    values ('a6000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000000', 'a4000000-0000-4000-8000-000000000001',
      (select id from identity.borrowers where user_id = '11111111-1111-4111-8111-111111111111'), 'overdue', 475000, (select id from payments.lender_payment_configs where lender_org_id = 'a1000000-0000-4000-8000-000000000000'),
      'mock_gateway', 'idem-a-0000000000002')$$,
  'the system creates a repayment instruction on the borrower''s loan');
select pg_temp.as_system();
select pg_temp.as_owner();
select throws_ok(
  $$insert into payments.payment_intents (lender_org_id, loan_account_id, borrower_id, purpose, amount_minor, config_id,
      provider, idempotency_key)
    values ('a1000000-0000-4000-8000-000000000000', 'a4000000-0000-4000-8000-000000000001',
      (select id from identity.borrowers where user_id = '11111111-1111-4111-8111-111111111111'), 'installment', 475000, (select id from payments.lender_payment_configs where lender_org_id = 'a1000000-0000-4000-8000-000000000000'),
      'mock_gateway', 'idem-a-0000000000002')$$,
  '23505', null, 'a replayed request with the same idempotency key cannot create a second payment');
select pg_temp.as_system();
select pg_temp.as_owner();
select throws_ok(
  $$insert into payments.payment_intents (lender_org_id, loan_account_id, borrower_id, purpose, amount_minor, config_id,
      provider, idempotency_key)
    values ('a1000000-0000-4000-8000-000000000000', 'a4000000-0000-4000-8000-000000000001',
      (select id from identity.borrowers where user_id = '22222222-2222-4222-8222-222222222222'), 'installment', 1, (select id from payments.lender_payment_configs where lender_org_id = 'a1000000-0000-4000-8000-000000000000'),
      'mock_gateway', 'idem-a-0000000000099')$$,
  '23514', null, 'a payment cannot name a borrower other than the loan''s borrower');
select pg_temp.as_system();
select pg_temp.as_owner();
select throws_ok($$update payments.payment_intents set status = 'succeeded' where id = 'a6000000-0000-4000-8000-000000000002'$$,
  'P0001', null, 'created -> succeeded skips the provider round-trip and is rejected');
select pg_temp.as_system();
select pg_temp.as_owner();
update payments.payment_intents set status = 'pending', provider_order_ref = 'order_test_1' where id = 'a6000000-0000-4000-8000-000000000002';
select pg_temp.as_system();
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
select throws_ok($$update payments.payment_intents set status = 'succeeded' where id = 'a6000000-0000-4000-8000-000000000002'$$,
  '42501', null, 'a borrower cannot mark their own payment as succeeded');
select pg_temp.as_system();
select pg_temp.as_owner();
select throws_ok($$update payments.payment_intents set status = 'succeeded' where id = 'a6000000-0000-4000-8000-000000000002'$$,
  'P0001', null, 'even the system cannot mark success without a signature-verified provider event');
select pg_temp.as_system();
select pg_temp.as_owner();
select throws_ok(
  $$insert into payments.provider_events (provider, provider_event_id, event_type, lender_org_id, payment_intent_id, payload_sha256, signature_verified)
    values ('mock_gateway', 'evt_x', 'payment.captured', 'b1000000-0000-4000-8000-000000000000', 'a6000000-0000-4000-8000-000000000002', repeat('c', 64), true)$$,
  '23503', null, 'a provider event cannot be filed under a different lender than its payment');
select pg_temp.as_system();
-- Success needs a verified event with a success status and the intent's exact amount (475000); see 013_remediation_db for the negatives.
select pg_temp.as_owner();
insert into payments.provider_events (provider, provider_event_id, event_type, lender_org_id, payment_intent_id, payload_sha256, signature_verified, provider_status, amount_minor, currency)
values ('mock_gateway', 'evt_1', 'payment.captured', 'a1000000-0000-4000-8000-000000000000', 'a6000000-0000-4000-8000-000000000002', repeat('a', 64), true, 'captured', 475000, 'INR');
select pg_temp.as_system();
select pg_temp.as_owner();
select lives_ok($$update payments.payment_intents set status = 'succeeded' where id = 'a6000000-0000-4000-8000-000000000002'$$,
  'the system records success after a verified provider event');
select pg_temp.as_system();
select pg_temp.as_owner();
select throws_ok($$update payments.payment_intents set status = 'failed' where id = 'a6000000-0000-4000-8000-000000000002'$$,
  'P0001', null, 'a succeeded payment cannot be flipped to failed');
select pg_temp.as_system();
select pg_temp.as_owner();
select throws_ok($$update payments.payment_intents set amount_minor = 1 where id = 'a6000000-0000-4000-8000-000000000001'$$,
  'P0001', null, 'payment amounts are immutable');
select pg_temp.as_system();
select pg_temp.as_owner();
select throws_ok(
  $$insert into payments.provider_events (provider, provider_event_id, event_type, lender_org_id, payload_sha256, signature_verified)
    values ('mock_gateway', 'evt_1', 'payment.captured', 'a1000000-0000-4000-8000-000000000000', repeat('b', 64), true)$$,
  '23505', null, 'a replayed provider webhook of the same lender is rejected as a duplicate (event ids are unique per provider and lender)');
select pg_temp.as_system();

-- ============================== Append-only records ==========================================
select pg_temp.as_owner();
select throws_ok($$update audit.events set action = 'x.y' where true$$, 'P0001', null, 'audit events cannot be edited');
select throws_ok($$delete from consent.records where true$$, 'P0001', null, 'consent records cannot be deleted');
select throws_ok($$update lending.application_events set reason = 'rewritten' where true$$, 'P0001', null,
  'application history cannot be rewritten');
select throws_ok($$update servicing.schedule_installments set interest_minor = 0 where true$$, 'P0001', null,
  'received schedules cannot be edited');

-- ============================== Product configuration ========================================
select pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000003');
select throws_ok(
  $$insert into lending.loan_product_versions (product_id, lender_org_id, version, min_amount_minor, max_amount_minor, min_tenure_days,
      max_tenure_days, rate_type, min_annual_rate_bps, max_annual_rate_bps, drafted_by)
    values ('a1900000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000000', 2, 100000, 1000000, 30, 90, 'fixed', 2000, 3000,
      'aaaaaaaa-0000-4000-8000-000000000003')$$,
  '23514', null, 'a lender cannot configure a personal loan below the platform''s minimum tenure');
insert into lending.loan_product_versions (id, product_id, lender_org_id, version, min_amount_minor, max_amount_minor, min_tenure_days,
  max_tenure_days, rate_type, min_annual_rate_bps, max_annual_rate_bps, drafted_by)
values ('a1910000-0000-4000-8000-000000000002', 'a1900000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000000', 2,
  100000, 1000000, 180, 720, 'fixed', 2000, 3000, 'aaaaaaaa-0000-4000-8000-000000000003');
update lending.loan_product_versions set status = 'pending_approval' where id = 'a1910000-0000-4000-8000-000000000002';
select throws_ok(
  $$update lending.loan_product_versions set status = 'approved', approved_by = 'aaaaaaaa-0000-4000-8000-000000000003', approved_at = now(),
      effective_from = now() where id = 'a1910000-0000-4000-8000-000000000002'$$,
  '23514', null, 'a user without product.approve cannot approve');
select pg_temp.as_system();
select throws_ok(
  $$update lending.loan_product_versions set status = 'approved', approved_by = 'aaaaaaaa-0000-4000-8000-000000000003', approved_at = now(),
      effective_from = now() where id = 'a1910000-0000-4000-8000-000000000002'$$,
  '23514', null, 'maker-checker: the drafter can never be recorded as the approver, even by the system');
select throws_ok(
  $$update lending.loan_product_versions set status = 'approved', approved_by = 'bbbbbbbb-0000-4000-8000-000000000002', approved_at = now(),
      effective_from = now() where id = 'a1910000-0000-4000-8000-000000000002'$$,
  '23514', null, 'another lender''s approver cannot approve this lender''s product');
select pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000002');
select throws_ok(
  $$update lending.loan_product_versions set status = 'approved', max_annual_rate_bps = 4800, approved_by = 'aaaaaaaa-0000-4000-8000-000000000002',
      effective_from = now() where id = 'a1910000-0000-4000-8000-000000000002'$$,
  'P0001', null, 'the approver cannot change terms in the approving statement');
select throws_ok(
  $$update lending.loan_product_versions set status = 'approved', approved_by = 'aaaaaaaa-0000-4000-8000-000000000002',
      effective_from = now() - interval '30 days' where id = 'a1910000-0000-4000-8000-000000000002'$$,
  '23514', null, 'an approval cannot be backdated');
select lives_ok(
  $$update lending.loan_product_versions set status = 'approved', approved_by = 'aaaaaaaa-0000-4000-8000-000000000002',
      effective_from = now() where id = 'a1910000-0000-4000-8000-000000000002'$$,
  'a separate approver in the same lender publishes the version');
select throws_ok($$update lending.loan_product_versions set max_annual_rate_bps = 3600 where id = 'a1910000-0000-4000-8000-000000000002'$$,
  'P0001', null, 'approved product terms are immutable');

-- ============================== Consent ======================================================
select pg_temp.as_owner();
select throws_ok($$update consent.notices set body_markdown = 'changed' where id = 'c0000000-0000-4000-8000-000000000001'$$,
  'P0001', null, 'published consent wording can never change');
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
insert into consent.records (borrower_id, notice_id, lender_org_id, decision, channel, captured_at)
values ((select private.my_borrower_id()), 'c0000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000000', 'withdrawn',
  'mobile_app', now() - interval '10 days');
select is((select decision::text from consent.current_decisions where lender_org_id = 'a1000000-0000-4000-8000-000000000000'),
  'withdrawn', 'withdrawal is a new record and becomes the current decision');
select ok((select bool_and(captured_at = now()) from consent.records where decision = 'withdrawn'),
  'the capture time is set by the server, not the caller');

-- ============================== Audit trail ==================================================
select pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001');
select set_config('test.audit_id', private.record_audit_event('application.viewed', 'application',
  'a2000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000000')::text, true);
select throws_ok($$select private.record_audit_event('loan.approved', 'application', 'x', 'b1000000-0000-4000-8000-000000000000')$$,
  '42501', null, 'lender staff cannot write audit events into another lender''s scope');
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
select throws_ok($$select private.record_audit_event('loan.approved', 'application', 'x', 'a0000000-0000-4000-8000-000000000000')$$,
  '42501', null, 'a borrower cannot write audit events about an organisation they have no application with');
select pg_temp.as_owner();
select ok(
  (select e.actor_type = 'staff' and e.actor_user_id = 'aaaaaaaa-0000-4000-8000-000000000001'
      and e.actor_org_id = 'a1000000-0000-4000-8000-000000000000' and length(e.row_hash) = 64
   from audit.events e where e.id = current_setting('test.audit_id')::uuid),
  'audit actor is derived from the session, not supplied by the caller');
select pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001');
select throws_ok($$insert into audit.events (actor_type, action, entity_type, row_hash) values ('system', 'forged.event', 'x', 'x')$$,
  '42501', null, 'users cannot insert audit rows directly (no forged actors)');
select pg_temp.as_owner();
create temp table digest_before as select * from private.audit_digest(now() - interval '1 day', now() + interval '1 day');
alter table audit.events disable trigger events_append_only;
update audit.events set metadata = '{"tampered":true}' where action = 'application.routed' and tenant_org_id = 'b1000000-0000-4000-8000-000000000000';
alter table audit.events enable trigger events_append_only;
select isnt((select digest from private.audit_digest(now() - interval '1 day', now() + interval '1 day')),
  (select digest from digest_before), 'tampering with an audit row (even as superuser) changes the recomputed digest');

-- ============================== Accounts and roles ===========================================
select is((select count(*) from identity.borrowers b join auth.users u on u.id = b.user_id
           where u.raw_app_meta_data ->> 'actor_type' = 'staff'), 0::bigint,
  'staff accounts created by the server never become borrower accounts');
select throws_ok(
  $$insert into tenancy.membership_roles (membership_id, role_id)
    values ('a1a10000-0000-4000-8000-000000000004', (select id from tenancy.roles where org_id is null and applies_to = 'platform' and key = 'platform_admin'))$$,
  '23514', null, 'a lender member can never be given a platform role');
select throws_ok(
  $$insert into tenancy.role_permissions (role_id, permission_key)
    values ((select id from tenancy.roles where org_id is null and applies_to = 'lender' and key = 'viewer'), 'platform.organizations.manage')$$,
  '23514', null, 'a lender role can never carry a platform-only permission');

select * from finish();
rollback;
