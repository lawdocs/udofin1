-- Phase 08a accounts and payment configuration (migration 20261018000910): account format rules, fail-closed account
-- registry and classification, settlement-account proof, merchant registry, provider register, payment configurations
-- (maker-checker, kill switch, nightly revalidation), payment intents that require a valid configuration, the `payments`
-- feature prerequisite. Synthetic data only (labelled SAMPLE). Error codes are reported as SQLSTATE|hint.
begin;
create extension if not exists pgtap with schema extensions;
select plan(550);

create function pg_temp.as_user(uid uuid, aal text default 'aal2') returns void language plpgsql as $fn$
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
create function pg_temp.as_anon() returns void language plpgsql as $fn$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
  execute 'set local role anon';
end
$fn$;
create function pg_temp.as_owner() returns void language plpgsql as $fn$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
end
$fn$;
-- Error helper. The Supabase Postgres 17 image adds the hint 'Grant the required privileges ...' to privilege errors (42501);
-- it is blanked here, so privilege errors compare the SQLSTATE only. Hints raised by OUR functions are asserted as they are.
create function pg_temp.err(q text) returns text language plpgsql as $fn$
declare v_state text; v_hint text;
begin
  execute q;
  return 'ok';
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_hint = pg_exception_hint;
  if v_hint like 'Grant the required privileges%' then v_hint := null; end if;
  return v_state || '|' || coalesce(v_hint, '');
end
$fn$;
create function pg_temp.msg(q text) returns text language plpgsql as $fn$
begin
  execute q;
  return 'ok';
exception when others then
  return sqlerrm;
end
$fn$;
create function pg_temp.keep(k text, v text) returns text language sql as $fn$ select set_config('t.' || k, v, true) $fn$;
create function pg_temp.got(k text) returns text language sql as $fn$ select current_setting('t.' || k) $fn$;
create function pg_temp.u(n integer) returns uuid language sql as $fn$ select ('f6000000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid $fn$;
create function pg_temp.fp(n integer) returns text language sql as $fn$ select encode(sha256(convert_to('SAMPLE-016-ACCOUNT-' || n, 'UTF8')), 'hex') $fn$;
create function pg_temp.token(k text) returns text language sql as $fn$ select encode(sha256(convert_to('SAMPLE-016-TOKEN-' || k, 'UTF8')), 'hex') $fn$;

-- Calls through the real API-facing functions, with defaults for the boring parameters.
create function pg_temp.register(n integer, k text, rule uuid, validated boolean default true, kind text default 'lender',
  org uuid default 'f6b00000-0000-4000-8000-000000000001', purposes text[] default array['repayment_settlement'],
  masked text default 'XXXXXX1001', kv integer default 1, lname text default 'Alpha Finance Ltd (test)', eff_from date default null,
  eff_to date default null, country text default 'IN', atype text default 'bank_account', fp text default null,
  others jsonb default '{}'::jsonb, rekeys uuid default null)
returns uuid language sql as $fn$
  select payments.register_account(coalesce(fp, pg_temp.fp(n)), kv, masked, country, atype, rule, validated, kind, org, lname, purposes, eff_from, eff_to, k, others, rekeys)
$fn$;
create function pg_temp.draft(lender uuid, k text, provider text default 'sample_provider', mode text default 'production', merchant uuid default null,
  settle uuid default null, secret text default 'SAMPLE_SECRET_REF', hook text default 'SAMPLE_WEBHOOK_REF', token text default null,
  limits jsonb default null, lsource text default null, evidence text default 'SAMPLE-EVIDENCE-CFG', contract text default 'SAMPLE-CONTRACT-CFG')
returns uuid language sql as $fn$
  select payments.draft_payment_config(lender, provider, mode, merchant, settle, secret, hook, coalesce(token, pg_temp.token(k)), limits, lsource, evidence, contract, k)
$fn$;
-- Registry row written directly as the owner (fixtures for classification and linking): status, offsets in days from today (IST).
create function pg_temp.regrow(n integer, kind text, org uuid, purposes text[], st text default 'verified', from_off integer default -30,
  to_off integer default null, kv integer default 1) returns uuid language plpgsql as $fn$
declare
  v_id uuid;
begin
  insert into payments.account_registry (fingerprint, key_version, masked_ref, country, account_type, format_rule_id, format_validated, owner_kind, owner_org_id,
    legal_owner_name, permitted_purposes, verification_status, evidence_ref, effective_from, effective_to, registered_by, idempotency_key,
    verified_by, verified_at, rejected_by, rejected_at, rejection_reason, revoked_by, revoked_at, revoked_reason)
  values (pg_temp.fp(n), kv, 'XXXXXX' || lpad(n::text, 4, '0'), 'IN', 'bank_account', pg_temp.got('rule2')::uuid, true, kind, org,
    'SAMPLE Entity Ltd (fixture)', purposes, st, case when st in ('verified', 'revoked') then 'SAMPLE-EVIDENCE-016' end,
    private.today_ist() + from_off, case when to_off is null then null else private.today_ist() + to_off end, pg_temp.u(1), 'fixture-key-' || n || '-' || kv || '-0000',
    case when st in ('verified', 'revoked') then pg_temp.u(3) end, case when st in ('verified', 'revoked') then now() end,
    case when st = 'rejected' then pg_temp.u(3) end, case when st = 'rejected' then now() end, case when st = 'rejected' then 'SAMPLE rejection reason' end,
    case when st = 'revoked' then pg_temp.u(3) end, case when st = 'revoked' then now() end, case when st = 'revoked' then 'SAMPLE revocation reason' end)
  returning id into v_id;
  return v_id;
end
$fn$;
-- A settlement account row as the system creates it (unverified).
create function pg_temp.mk_sa(p_id uuid, p_lender uuid, p_masked text) returns void language sql as $fn$
  insert into tenancy.lender_settlement_accounts (id, lender_org_id, label, bank_name, masked_account_ref) values (p_id, p_lender, 'SAMPLE account', 'Test Bank', p_masked)
$fn$;
create function pg_temp.sa(n integer) returns uuid language sql as $fn$ select ('f6e10000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid $fn$;
-- Submit as one configure holder and approve as one approver; returns the final status. Leaves the session as the approver.
create function pg_temp.live(p_cfg uuid, p_submitter integer, p_approver integer) returns text language plpgsql as $fn$
begin
  perform pg_temp.as_user(pg_temp.u(p_submitter));
  perform payments.submit_payment_config(p_cfg);
  perform pg_temp.as_user(pg_temp.u(p_approver));
  return payments.decide_payment_config(p_cfg, true, 'SAMPLE approval');
end
$fn$;
-- Owner-level builder of a complete lender setup (organisation, gate, verified registry entry, settlement account, merchant, active
-- configuration in the given mode), for scenarios that need MANY lenders. Everything is synthetic.
create function pg_temp.build(p_lender uuid, p_mode text, p_provider text, p_n integer) returns uuid language plpgsql as $fn$
declare
  v_reg uuid; v_mer uuid; v_cfg uuid; v_sa uuid := pg_temp.sa(p_n);
begin
  insert into tenancy.organizations (id, kind, legal_name, display_name, regulator_registration_no, status)
    values (p_lender, 'lender', 'Builder Finance ' || p_n || ' (test)', 'Builder ' || p_n, 'TEST-F6-B' || p_n, 'active') on conflict (id) do nothing;
  insert into onboarding.lender_gates (lender_org_id, stage) values (p_lender, 'activated') on conflict (lender_org_id) do update set stage = 'activated';
  if p_mode = 'mock' then perform set_config('udofin.allow_mock_providers', 'on', true); end if;
  if p_mode = 'sandbox' then perform set_config('udofin.allow_sandbox_providers', 'on', true); end if;
  v_reg := pg_temp.regrow(200 + p_n, 'lender', p_lender, array['repayment_settlement']);
  insert into tenancy.lender_settlement_accounts (id, lender_org_id, label, bank_name, masked_account_ref, status, registry_id, verified_by, verified_at)
    values (v_sa, p_lender, 'SAMPLE account', 'Test Bank', 'XXXXXX' || lpad((200 + p_n)::text, 4, '0'), 'verified', v_reg, pg_temp.u(1), now());
  insert into payments.merchant_registry (provider, merchant_ref, owner_kind, owner_org_id, purpose, claimed_by, verification_status, verification_evidence_ref,
      verified_by, verified_at)
    values (p_provider, 'SAMPLE-BUILD-MERCHANT-' || p_n, 'lender', p_lender, 'repayment', pg_temp.u(1), 'verified', 'SAMPLE-EVIDENCE-B2', pg_temp.u(3), now()) returning id into v_mer;
  insert into payments.lender_payment_configs (lender_org_id, provider, provider_mode, merchant_registry_id, settlement_account_id, secret_ref, webhook_secret_ref,
      endpoint_token_hash, evidence_ref, contract_section_ref, idempotency_key, drafted_by)
    values (p_lender, p_provider, p_mode, v_mer, v_sa, 'SAMPLE_BUILD_SECRET', 'SAMPLE_BUILD_HOOK', pg_temp.token('build-' || p_n), 'SAMPLE-EVIDENCE-B', 'SAMPLE-CONTRACT-B',
      'build-fixture-key-' || p_n || '-0000', pg_temp.u(1)) returning id into v_cfg;
  update payments.lender_payment_configs set status = 'pending_approval', submitted_by = pg_temp.u(9), submitted_at = now(), status_changed_by = pg_temp.u(9) where id = v_cfg;
  update payments.lender_payment_configs set status = 'active', approved_by = pg_temp.u(10), approved_at = now(), status_changed_by = pg_temp.u(10) where id = v_cfg;
  return v_cfg;
end
$fn$;
grant execute on all functions in schema pg_temp to public;

-- Fixture --------------------------------------------------------------------------------------------------------------------
-- Users: 01 R1 and 02 R2 platform registry managers (also providers.manage), 03 V1 and 04 V2 platform account verifiers,
-- 05 F1 and 06 F2 platform features admins, 07 PN platform user without a role, 08 X_ADM and 09 X_ADM2 lender X payments admins,
-- 10 X_APR and 11 X_APR2 lender X payments approvers, 12 Y_ADM and 13 Y_APR lender Y, 14 X_VIEW lender X viewer (payment.read),
-- 15 borrower, 16 platform operations agent (payment.read).
insert into auth.users (id, phone, raw_app_meta_data)
select pg_temp.u(n), case when n = 15 then '910000000099' end, case when n = 15 then '{}'::jsonb else '{"actor_type":"staff"}'::jsonb end from generate_series(1, 16) n;
select pg_temp.keep('borrower', (select id::text from identity.borrowers where user_id = pg_temp.u(15)));

select pg_temp.as_owner();
insert into tenancy.organizations (id, kind, legal_name, display_name, regulator_registration_no, status) values
  ('f6a00000-0000-4000-8000-000000000000', 'platform', 'Udofin Platform (test)', 'Udofin', null, 'active'),
  ('f6b00000-0000-4000-8000-000000000001', 'lender', 'Alpha Finance Ltd (test)', 'Alpha', 'TEST-F6-0001', 'active'),
  ('f6b00000-0000-4000-8000-000000000002', 'lender', 'Beta Capital Ltd (test)', 'Beta', 'TEST-F6-0002', 'active'),
  ('f6b00000-0000-4000-8000-000000000003', 'lender', 'Gamma Credit Ltd (test)', 'Gamma', 'TEST-F6-0003', 'onboarding'),
  ('f6b00000-0000-4000-8000-000000000004', 'service_partner', 'Delta Services Ltd (test)', 'Delta', null, 'active');
insert into onboarding.lender_gates (lender_org_id, stage) values
  ('f6b00000-0000-4000-8000-000000000001', 'activated'),
  ('f6b00000-0000-4000-8000-000000000002', 'activated'),
  ('f6b00000-0000-4000-8000-000000000003', 'contract_onboarded');
insert into tenancy.memberships (id, org_id, user_id, status)
select ('f6c10000-0000-4000-8000-0000000000' || lpad(m.n::text, 2, '0'))::uuid, m.org::uuid, pg_temp.u(m.n), 'active'
from (values
  (1, 'f6a00000-0000-4000-8000-000000000000'), (2, 'f6a00000-0000-4000-8000-000000000000'), (3, 'f6a00000-0000-4000-8000-000000000000'),
  (4, 'f6a00000-0000-4000-8000-000000000000'), (5, 'f6a00000-0000-4000-8000-000000000000'), (6, 'f6a00000-0000-4000-8000-000000000000'),
  (7, 'f6a00000-0000-4000-8000-000000000000'), (8, 'f6b00000-0000-4000-8000-000000000001'), (9, 'f6b00000-0000-4000-8000-000000000001'),
  (10, 'f6b00000-0000-4000-8000-000000000001'), (11, 'f6b00000-0000-4000-8000-000000000001'), (12, 'f6b00000-0000-4000-8000-000000000002'),
  (13, 'f6b00000-0000-4000-8000-000000000002'), (14, 'f6b00000-0000-4000-8000-000000000001'), (16, 'f6a00000-0000-4000-8000-000000000000')) as m (n, org);
insert into tenancy.membership_roles (membership_id, role_id)
select ('f6c10000-0000-4000-8000-0000000000' || lpad(g.n::text, 2, '0'))::uuid, r.id
from (values
  (1, 'platform', 'platform_payments_admin'), (2, 'platform', 'platform_payments_admin'), (3, 'platform', 'platform_account_verifier'),
  (4, 'platform', 'platform_account_verifier'), (5, 'platform', 'platform_features_admin'), (6, 'platform', 'platform_features_admin'),
  (8, 'lender', 'payments_admin'), (9, 'lender', 'payments_admin'), (10, 'lender', 'payments_approver'), (11, 'lender', 'payments_approver'),
  (12, 'lender', 'payments_admin'), (13, 'lender', 'payments_approver'), (14, 'lender', 'viewer'), (16, 'platform', 'operations_agent'),
  -- only so that the loan-product fixture below passes the product maker-checker triggers; neither role adds a payment permission
  (8, 'lender', 'lender_admin'), (10, 'lender', 'product_approver')) as g (n, kind, rkey)
join tenancy.roles r on r.org_id is null and r.applies_to = g.kind::tenancy.organization_kind and r.key = g.rkey;

-- Loan fixture for the payment intents (lender X, one borrower).
insert into lending.loan_products (id, lender_org_id, category_key, code, name, status)
  values (md5('f6prod')::uuid, 'f6b00000-0000-4000-8000-000000000001', 'personal', 'PL-STD', 'Alpha Personal Loan', 'active');
insert into lending.loan_product_versions (id, product_id, lender_org_id, version, status, min_amount_minor, max_amount_minor, min_tenure_days, max_tenure_days,
  rate_type, min_annual_rate_bps, max_annual_rate_bps, drafted_by, approved_by, approved_at, effective_from)
  values (md5('f6ver')::uuid, md5('f6prod')::uuid, 'f6b00000-0000-4000-8000-000000000001', 1, 'approved', 1000000, 50000000, 180, 1825, 'fixed', 1400, 2400,
          pg_temp.u(8), pg_temp.u(10), now(), now());
insert into lending.loan_requests (id, borrower_id, category_key, requested_amount_minor, requested_tenure_days, purpose_code, status)
  values ('f6d00000-0000-4000-8000-000000000001', pg_temp.got('borrower')::uuid, 'personal', 2000000, 720, 'home_renovation', 'submitted');
insert into lending.applications (id, lender_org_id, loan_request_id, borrower_id, product_version_id, status, requested_amount_minor, requested_tenure_days)
  values ('f6d10000-0000-4000-8000-000000000001', 'f6b00000-0000-4000-8000-000000000001', 'f6d00000-0000-4000-8000-000000000001', pg_temp.got('borrower')::uuid,
          md5('f6ver')::uuid, 'submitted', 2000000, 720);
update lending.applications set status = 'under_review' where id = 'f6d10000-0000-4000-8000-000000000001';
update lending.applications set status = 'approved' where id = 'f6d10000-0000-4000-8000-000000000001';
select pg_temp.as_system();
select pg_temp.as_owner();
insert into servicing.loan_accounts (id, lender_org_id, application_id, borrower_id, source_system, lms_loan_ref, status, sanctioned_amount_minor)
  values ('f6d20000-0000-4000-8000-000000000001', 'f6b00000-0000-4000-8000-000000000001', 'f6d10000-0000-4000-8000-000000000001', pg_temp.got('borrower')::uuid,
          'lender_lms', 'SAMPLE-LN-F6', 'active', 2000000);
select pg_temp.as_system();
select pg_temp.as_owner();

-- ============================================================================================================================
-- 1. Structure, seeds, grants
-- ============================================================================================================================
select is((select count(*) from payments.account_registry), 0::bigint, 'the account registry starts EMPTY: no account, fingerprint or owner is seeded');
select is((select count(*) from payments.account_registry_events), 0::bigint, 'and so does its history');
select is((select count(*) from payments.fingerprint_key_versions), 0::bigint,
  'no fingerprint key version is seeded: the registry accepts nothing until one is proposed and approved by two different people');
select is((select count(*) from payments.merchant_registry), 0::bigint, 'the merchant registry starts empty');
select is((select count(*) from payments.provider_register), 0::bigint, 'the provider register starts empty: no provider has been chosen');
select is((select count(*) from payments.lender_payment_configs), 0::bigint, 'no payment configuration is seeded');
select is((select count(*) from payments.account_format_rules), 1::bigint, 'exactly ONE account format rule is seeded');
select is((select (country, account_type, version, min_digits, max_digits, ifsc_required, status, evidence_label, source_note, drafted_by is null, approved_by is null)::text
           from payments.account_format_rules),
  '(IN,bank_account,1,9,18,t,draft,unverified,"initial assumption, no source on file",t,t)', 'the seeded rule is the owner''s initial assumption: draft, unverified, no source on file, nobody has approved it');
select is((select count(*) from payments.account_format_rule_events where event_kind = 'drafted' and actor_id is null and note like 'seeded by migration%'), 1::bigint,
  'the seed left a history row saying it was seeded as a draft');
select pg_temp.keep('rule1', (select id::text from payments.account_format_rules));

select is((select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'payments' and c.relname in ('account_format_rules', 'account_format_rule_events', 'account_registry', 'account_registry_events',
             'provider_register', 'merchant_registry', 'lender_payment_configs', 'lender_payment_config_events', 'fingerprint_key_versions') and c.relrowsecurity and c.relforcerowsecurity), 9::bigint,
  'row level security is enabled and forced on all nine new tables');
select is((select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'payments' and c.relname in ('account_format_rules', 'account_format_rule_events', 'account_registry', 'account_registry_events',
             'provider_register', 'merchant_registry', 'lender_payment_configs', 'lender_payment_config_events', 'fingerprint_key_versions')
             and obj_description(c.oid, 'pg_class') like '%Owner: payments module.'), 9::bigint, 'every new table has a comment naming its owner module');
select is((select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'payments' and t.tgname = 'no_truncate' and not t.tgisinternal
             and c.relname in ('account_format_rules', 'account_format_rule_events', 'account_registry', 'account_registry_events',
               'provider_register', 'merchant_registry', 'lender_payment_configs', 'lender_payment_config_events', 'fingerprint_key_versions')), 9::bigint, 'a no_truncate trigger is on every new table');
select is((select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'payments' and t.tgname = 'append_only' and not t.tgisinternal
             and c.relname in ('account_format_rule_events', 'account_registry_events', 'lender_payment_config_events')), 3::bigint, 'an append-only trigger is on the three history tables');
select is(pg_temp.err($$truncate payments.account_registry cascade$$), 'P0001|', 'TRUNCATE is refused even for the owner (registry)');
select is(pg_temp.err($$truncate payments.lender_payment_configs cascade$$), 'P0001|', 'TRUNCATE is refused even for the owner (configurations)');
select is(pg_temp.err($$truncate payments.merchant_registry cascade$$), 'P0001|', 'TRUNCATE is refused even for the owner (merchants)');
select has_index('payments', 'account_registry', 'account_registry_format_rule', 'the registry''s rule foreign key is indexed');
select has_index('payments', 'account_registry', 'account_registry_owner_org', 'the registry''s owner foreign key is indexed');
select has_index('payments', 'lender_payment_configs', 'lender_payment_configs_merchant', 'the configuration''s merchant foreign key is indexed');
select has_index('payments', 'lender_payment_configs', 'lender_payment_configs_settlement', 'the configuration''s settlement account foreign key is indexed');
select has_index('payments', 'payment_intents', 'payment_intents_config', 'the intent''s configuration foreign key is indexed');
select has_index('tenancy', 'lender_settlement_accounts', 'lender_settlement_accounts_registry', 'the settlement account''s registry link is indexed (and unique)');
select ok((select bool_and(has_table_privilege('authenticated', t, 'select') and not has_table_privilege('authenticated', t, 'insert')
                           and not has_table_privilege('authenticated', t, 'update') and not has_table_privilege('authenticated', t, 'delete'))
           from unnest(array['payments.account_format_rules', 'payments.account_format_rule_events', 'payments.account_registry', 'payments.account_registry_events',
                             'payments.provider_register', 'payments.merchant_registry', 'payments.lender_payment_configs', 'payments.lender_payment_config_events',
                             'payments.fingerprint_key_versions']) t),
  'authenticated users can only read the new tables');
select ok((select bool_and(not has_any_column_privilege('service_role', t, 'select') and not has_table_privilege('service_role', t, 'insert')
                           and not has_table_privilege('service_role', t, 'update') and not has_table_privilege('service_role', t, 'delete'))
           from unnest(array['payments.account_format_rules', 'payments.account_format_rule_events', 'payments.account_registry', 'payments.account_registry_events',
                             'payments.lender_payment_config_events', 'payments.fingerprint_key_versions']) t),
  'the system role has NO privilege at all on the registry, the rules, the key versions and the two histories (the default ALL was revoked)');
select ok((select bool_and(has_table_privilege('service_role', t, 'select') and not has_table_privilege('service_role', t, 'insert')
                           and not has_table_privilege('service_role', t, 'update') and not has_table_privilege('service_role', t, 'delete'))
           from unnest(array['payments.provider_register', 'payments.merchant_registry', 'payments.lender_payment_configs']) t),
  'the system role can only read the provider register, the merchants and the configurations');
select ok((select bool_and(not has_function_privilege('anon', p, 'execute') and not has_function_privilege('public', p, 'execute')
                           and has_function_privilege('service_role', p, 'execute') and not has_function_privilege('authenticated', p, 'execute'))
           from unnest(array['payments.classify_destination(text,integer,uuid,text)', 'payments.validate_collection_target(uuid)',
                             'payments.system_suspend_payment_config(uuid,text)', 'payments.revalidate_payment_configs(uuid)']) p),
  'the four system-only functions are executable by service_role only');
select ok((select bool_and(not has_function_privilege('anon', p, 'execute') and not has_function_privilege('public', p, 'execute')
                           and has_function_privilege('authenticated', p, 'execute') and not has_function_privilege('service_role', p, 'execute'))
           from unnest(array['payments.draft_account_format_rule(text,text,integer,integer,boolean,text,text,date,date)', 'payments.submit_account_format_rule(uuid)',
                             'payments.approve_account_format_rule(uuid,text)', 'payments.retire_account_format_rule(uuid,text)',
                             'payments.register_account(text,integer,text,text,text,uuid,boolean,text,uuid,text,text[],date,date,text,jsonb,uuid)',
                             'payments.propose_fingerprint_key_version(integer,text)', 'payments.approve_fingerprint_key_version(integer,text)', 'payments.verify_merchant(uuid,text)',
                             'payments.verify_account(uuid,text,text)', 'payments.reject_account(uuid,text)', 'payments.revoke_account(uuid,text)',
                             'payments.link_settlement_account(uuid,uuid)', 'payments.my_settlement_account_registry_status()',
                             'payments.set_payment_provider(text,text,text,text,text,text,text)', 'payments.claim_merchant(uuid,text,text)',
                             'payments.register_udofin_fee_merchant(text,text)', 'payments.revoke_merchant(uuid,text)',
                             'payments.draft_payment_config(uuid,text,text,uuid,uuid,text,text,text,jsonb,text,text,text,text)',
                             'payments.submit_payment_config(uuid)', 'payments.decide_payment_config(uuid,boolean,text)',
                             'payments.withdraw_payment_config(uuid,text)', 'payments.suspend_payment_config(uuid,text)',
                             'payments.retire_payment_config(uuid,text)']) p),
  'the user-facing workflow functions are executable by authenticated users only (the permission checks are inside)');

-- ============================================================================================================================
-- 1b. The registry is closed until a fingerprint key version has been proposed and approved by two different logins
-- ============================================================================================================================
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err(format($$select pg_temp.register(1, 'reg-key-000000000', %L::uuid)$$, pg_temp.got('rule1'))), '55000|key_version_not_allowed',
  'nothing can be registered while no key version is in the register (fail closed)');
select is(pg_temp.err($$select payments.propose_fingerprint_key_version(2)$$), '22023|key_version_invalid', 'the first version must be 1');
select is(pg_temp.err($$select payments.propose_fingerprint_key_version(1, repeat('x', 1001))$$), '22023|reason_invalid', 'a note is at most 1000 characters');
select is(payments.propose_fingerprint_key_version(1, 'SAMPLE first key'), 1, 'a registry manager proposes version 1');
select is(pg_temp.err($$select payments.propose_fingerprint_key_version(2)$$), '55000|proposal_open', 'one proposal at a time');
select is(pg_temp.err(format($$select pg_temp.register(1, 'reg-key-000000000', %L::uuid)$$, pg_temp.got('rule1'))), '55000|key_version_not_active',
  'a proposed version takes no registration (only the re-key of an existing entry, which needs an active predecessor)');
select is(pg_temp.err($$select payments.approve_fingerprint_key_version(1)$$), '42501|', 'the proposer cannot approve it: a registry manager does not hold the verify permission');
select pg_temp.as_user(pg_temp.u(3));
select is(pg_temp.err($$select payments.approve_fingerprint_key_version(7)$$), 'P0002|', 'an unknown version is not found');
select is(payments.approve_fingerprint_key_version(1, 'SAMPLE approval'), 'active', 'a different login (registry verifier) approves it');
select is(pg_temp.err($$select payments.approve_fingerprint_key_version(1)$$), '55000|not_proposed', 'approving twice is refused');
select is((select (status, proposed_by = pg_temp.u(1), approved_by = pg_temp.u(3), retired_by is null)::text from payments.fingerprint_key_versions where key_version = 1),
  '(active,t,t,t)', 'version 1 is active, proposed by the manager and approved by the verifier');
select is(pg_temp.err($$update payments.fingerprint_key_versions set status = 'retired' where key_version = 1$$), '42501|', 'a platform user cannot retire a version directly');
select pg_temp.as_owner();
select is(pg_temp.err($$update payments.fingerprint_key_versions set status = 'proposed' where key_version = 1$$), 'P0001|', 'even the owner cannot move a version back to proposed');
select is(pg_temp.err($$delete from payments.fingerprint_key_versions$$), 'P0001|Record a compensating entry instead.', 'a key version record is never deleted');

-- ============================================================================================================================
-- 2. Account format rules: until the platform approves a rule through the two-person flow NO account can be registered
-- ============================================================================================================================
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err(format($$select pg_temp.register(1, 'reg-key-000000001', %L::uuid)$$, pg_temp.got('rule1'))), '55000|account_format_unvalidated',
  'FAIL CLOSED: registration is refused while the only rule is the unapproved draft');
select is(pg_temp.err($$select pg_temp.register(1, 'reg-key-000000001', null)$$), '55000|account_format_unvalidated', 'a registration with no format rule is refused');
select is(pg_temp.err($$select pg_temp.register(1, 'reg-key-000000001', null, false)$$), '55000|account_format_unvalidated', 'and so is one without the format attestation');
select is((select count(*) from payments.account_registry), 0::bigint, 'nothing was registered');

select pg_temp.as_user(pg_temp.u(3));
select is(pg_temp.err(format($$select payments.approve_account_format_rule(%L, 'approved by the second person')$$, pg_temp.got('rule1'))), '55000|not_submitted',
  'a rule nobody has proposed cannot be approved (the seed has no proposer)');
select is(pg_temp.err(format($$select payments.submit_account_format_rule(%L)$$, pg_temp.got('rule1'))), '42501|', 'a verifier cannot propose a rule (registry.manage is the proposer permission)');
select pg_temp.as_user(pg_temp.u(8));
select is(pg_temp.err(format($$select payments.submit_account_format_rule(%L)$$, pg_temp.got('rule1'))), '42501|', 'a lender user cannot propose a rule');
select pg_temp.as_user(pg_temp.u(1), 'aal1');
select is(pg_temp.err(format($$select payments.submit_account_format_rule(%L)$$, pg_temp.got('rule1'))), '42501|mfa_required', 'proposing needs a second factor');
select pg_temp.as_user(pg_temp.u(1));
select is(payments.submit_account_format_rule(pg_temp.got('rule1')::uuid), 'draft', 'a registry manager proposes the seeded rule (it stays a draft)');
select is(payments.submit_account_format_rule(pg_temp.got('rule1')::uuid), 'draft', 'proposing again is idempotent');
select is(pg_temp.err(format($$select payments.approve_account_format_rule(%L)$$, pg_temp.got('rule1'))), '42501|', 'the proposer cannot approve: approval needs registry.verify');
select pg_temp.as_user(pg_temp.u(2));
select is(pg_temp.err(format($$select payments.submit_account_format_rule(%L)$$, pg_temp.got('rule1'))), '55000|already_submitted', 'a second manager cannot take over a proposal');
select pg_temp.as_owner();
select is(pg_temp.err(format($$update payments.account_format_rules set status = 'approved', approved_by = submitted_by, approved_at = now() where id = %L$$, pg_temp.got('rule1'))), '23514|',
  'table level: approval by the proposer is refused by a check, whoever writes');
select is(pg_temp.err(format($$update payments.account_format_rules set min_digits = 6 where id = %L$$, pg_temp.got('rule1'))), 'P0001|', 'the content of a rule never changes: draft a new version');
select pg_temp.as_user(pg_temp.u(3), 'aal1');
select is(pg_temp.err(format($$select payments.approve_account_format_rule(%L)$$, pg_temp.got('rule1'))), '42501|mfa_required', 'approval needs a second factor');
select pg_temp.as_user(pg_temp.u(3));
select is(payments.approve_account_format_rule(pg_temp.got('rule1')::uuid, 'approved as the initial rule'), 'approved', 'a DIFFERENT person with registry.verify approves it');
select is((select (status, approved_by = pg_temp.u(3), submitted_by = pg_temp.u(1), evidence_label)::text from payments.account_format_rules where id = pg_temp.got('rule1')::uuid),
  '(approved,t,t,unverified)', 'approved, by the verifier, proposed by the manager; the evidence label stays unverified (an approval is a decision, not evidence)');
select is(payments.approve_account_format_rule(pg_temp.got('rule1')::uuid), 'approved', 'approving again is idempotent');
select pg_temp.as_user(pg_temp.u(4));
select is(pg_temp.err(format($$select payments.approve_account_format_rule(%L)$$, pg_temp.got('rule1'))), '55000|rule_not_draft', 'another verifier cannot approve an approved rule');
select is((select array_agg(event_kind order by occurred_at) from payments.account_format_rule_events where rule_id = pg_temp.got('rule1')::uuid),
  array['drafted', 'submitted', 'approved'], 'the rule history records drafted, submitted, approved');

-- A new version supersedes the approved one in the same transaction; its content is data.
select pg_temp.as_user(pg_temp.u(3));
select is(pg_temp.err($$select payments.draft_account_format_rule('IN', 'bank_account', 9, 18, true, 'likely', 'SAMPLE source note v2')$$), '42501|', 'a verifier cannot draft a rule');
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err($$select payments.draft_account_format_rule('in', 'bank_account', 9, 18, true, 'likely', 'SAMPLE source note v2')$$), '22023|rule_invalid', 'a lower-case country is refused');
select is(pg_temp.err($$select payments.draft_account_format_rule('IN', 'bank_account', 19, 18, true, 'likely', 'SAMPLE source note v2')$$), '22023|rule_invalid', 'a maximum below the minimum is refused');
select is(pg_temp.err($$select payments.draft_account_format_rule('IN', 'bank_account', 9, 18, true, 'certain', 'SAMPLE source note v2')$$), '22023|rule_invalid', 'an unknown evidence label is refused');
select is(pg_temp.err($$select payments.draft_account_format_rule('IN', 'bank_account', 9, 18, true, 'likely', 'short')$$), '22023|source_note_required', 'a rule needs a source note');
select is(pg_temp.err($$select payments.draft_account_format_rule('IN', 'bank_account', 9, 18, true, 'likely', 'SAMPLE source note v2', current_date, current_date)$$), '22023|dates_invalid', 'effective_to must be after effective_from');
select pg_temp.keep('rule2', payments.draft_account_format_rule('IN', 'bank_account', 9, 18, true, 'likely', 'SAMPLE source note v2', private.today_ist() - 1)::text);
select is((select (version, status, drafted_by = pg_temp.u(1), submitted_by = pg_temp.u(1))::text from payments.account_format_rules where id = pg_temp.got('rule2')::uuid), '(2,draft,t,t)', 'version 2 is a draft, proposed by its drafter');
select is(pg_temp.err(format($$select payments.approve_account_format_rule(%L)$$, pg_temp.got('rule2'))), '42501|', 'the drafter cannot approve it');
select pg_temp.as_user(pg_temp.u(4));
select is(payments.approve_account_format_rule(pg_temp.got('rule2')::uuid), 'approved', 'a second verifier approves version 2');
select is((select (status, retired_reason)::text from payments.account_format_rules where id = pg_temp.got('rule1')::uuid), '(retired,"superseded by version 2")', 'version 1 was retired in the same transaction');
select is((select count(*) from payments.account_format_rules where status = 'approved' and country = 'IN' and account_type = 'bank_account'), 1::bigint, 'only one approved rule per country and account type');
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err(format($$select pg_temp.register(1, 'reg-key-000000001', %L::uuid)$$, pg_temp.got('rule1'))), '55000|account_format_unvalidated', 'a RETIRED rule cannot be used for a registration either');
select is(pg_temp.err(format($$select pg_temp.register(1, 'reg-key-000000001', %L::uuid, false)$$, pg_temp.got('rule2'))), '55000|account_format_unvalidated', 'format_validated = false is refused even under an approved rule');
select is(pg_temp.err(format($$select pg_temp.register(1, 'reg-key-000000001', %L::uuid, country => 'GB')$$, pg_temp.got('rule2'))), '55000|account_format_unvalidated', 'a rule for another country is refused');
select is(pg_temp.err(format($$select pg_temp.register(1, 'reg-key-000000001', %L::uuid, atype => 'savings_account')$$, pg_temp.got('rule2'))), '55000|account_format_unvalidated', 'a rule for another account type is refused');
-- A rule that is approved but not effective yet cannot be used (relative dates: no clock assumption).
select pg_temp.keep('rule_future', payments.draft_account_format_rule('IN', 'sample_future', 9, 18, true, 'unverified', 'SAMPLE future rule for the test', private.today_ist() + 30)::text);
select pg_temp.as_user(pg_temp.u(3));
select is(payments.approve_account_format_rule(pg_temp.got('rule_future')::uuid), 'approved', 'a future-dated rule can be approved');
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err(format($$select pg_temp.register(1, 'reg-key-000000001', %L::uuid, atype => 'sample_future')$$, pg_temp.got('rule_future'))), '55000|account_format_unvalidated', 'but a rule that is not effective yet is refused');
-- Retiring is fail closed: either permission, with a reason.
select pg_temp.keep('rule_x', payments.draft_account_format_rule('IN', 'sample_retire', 9, 18, false, 'unverified', 'SAMPLE rule to retire in the test')::text);
select is(pg_temp.err(format($$select payments.retire_account_format_rule(%L, 'short')$$, pg_temp.got('rule_x'))), '22023|reason_required', 'retiring needs a reason');
select pg_temp.as_user(pg_temp.u(4));
select is(payments.retire_account_format_rule(pg_temp.got('rule_x')::uuid, 'withdrawn before approval, wrong digits'), 'retired', 'a verifier can retire (fail closed)');
select is(payments.retire_account_format_rule(pg_temp.got('rule_x')::uuid, 'withdrawn before approval, wrong digits'), 'retired', 'retiring again is idempotent');
select is(pg_temp.err(format($$select payments.approve_account_format_rule(%L)$$, pg_temp.got('rule_x'))), '55000|rule_not_draft', 'a retired rule cannot be approved');
select is(pg_temp.err($$select payments.retire_account_format_rule('00000000-0000-4000-8000-000000000000', 'a reason that is long enough')$$), 'P0002|', 'an unknown rule is not found');
select pg_temp.as_owner();
select is(pg_temp.err(format($$update payments.account_format_rules set status = 'draft' where id = %L$$, pg_temp.got('rule_x'))), 'P0001|', 'a retired rule is final');
select is(pg_temp.err(format($$delete from payments.account_format_rules where id = %L$$, pg_temp.got('rule_x'))), 'P0001|', 'rules are never deleted');
select is(pg_temp.err(format($$update payments.account_format_rule_events set note = 'x' where rule_id = %L$$, pg_temp.got('rule_x'))), 'P0001|Record a compensating entry instead.', 'rule history is append-only');
select pg_temp.as_system();
select is(pg_temp.err($$insert into payments.account_format_rules (country, account_type, version, min_digits, max_digits, ifsc_required, evidence_label, source_note, effective_from)
  values ('IN', 'forged', 1, 1, 40, false, 'confirmed', 'forged by the system role at runtime', current_date)$$), '42501|', 'the system role cannot write rules');
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err($$insert into payments.account_format_rules (country, account_type, version, min_digits, max_digits, ifsc_required, evidence_label, source_note, effective_from)
  values ('IN', 'forged', 1, 1, 40, false, 'confirmed', 'forged by a platform user directly', current_date)$$), '42501|', 'a platform user cannot write rules directly');

-- ============================================================================================================================
-- 3. Registry workflow: register -> verify (a different person) -> revoke; one entry per real account
-- ============================================================================================================================
select pg_temp.as_user(pg_temp.u(1));
select pg_temp.keep('reg1', pg_temp.register(1, 'reg-key-000000001', pg_temp.got('rule2')::uuid)::text);
select is((select (verification_status, masked_ref, owner_kind, owner_org_id = 'f6b00000-0000-4000-8000-000000000001', registered_by = pg_temp.u(1), format_validated, key_version,
                   verified_by is null, evidence_ref is null)::text from payments.account_registry where id = pg_temp.got('reg1')::uuid),
  '(unverified,XXXXXX1001,lender,t,t,t,1,t,t)', 'registered: unverified, masked reference only, owned by lender X, registered by manager 1');
select is((select (event_kind, to_status, actor_id = pg_temp.u(1))::text from payments.account_registry_events where registry_id = pg_temp.got('reg1')::uuid), '(registered,unverified,t)', 'the history shows who registered it');
select is(pg_temp.register(1, 'reg-key-000000001', pg_temp.got('rule2')::uuid)::text, pg_temp.got('reg1'), 'a replay with the same key returns the same entry');
select is((select count(*) from payments.account_registry), 1::bigint, 'and creates nothing');
select is(pg_temp.err(format($$select pg_temp.register(1, 'reg-key-000000001', %L::uuid, kind => 'other', org => null, purposes => array['operational'])$$, pg_temp.got('rule2'))), '23505|idempotency_conflict',
  'the same key with different content is refused');
select is(pg_temp.err(format($$select pg_temp.register(1, 'reg-key-000000002', %L::uuid)$$, pg_temp.got('rule2'))), '23505|account_already_registered',
  'THE SAME ACCOUNT cannot be registered twice (same fingerprint and key version)');
select is(pg_temp.err(format($$select pg_temp.register(1, 'reg-key-000000003', %L::uuid, org => 'f6b00000-0000-4000-8000-000000000002')$$, pg_temp.got('rule2'))), '23505|account_already_registered',
  'nor under a second lender');
select is(pg_temp.err(format($$select pg_temp.register(1, 'reg-key-000000004', %L::uuid, kind => 'udofin', org => null, purposes => array['fee_collection'])$$, pg_temp.got('rule2'))), '23505|account_already_registered',
  'nor as an account owned by Udofin: one entry per real account, so it cannot sit under two owners');
select is(pg_temp.err(format($$select pg_temp.register(1, 'reg-key-000000005', %L::uuid, kv => 2)$$, pg_temp.got('rule2'))), '55000|key_version_not_allowed',
  'a key version that is not in the register cannot take a registration (the same account under an unregistered key would evade the one-entry rule)');
select is((select count(*) from payments.account_registry), 1::bigint, 'still one entry');
-- Input validation.
select is(pg_temp.err(format($$select payments.register_account(upper(pg_temp.fp(2)), 1, 'XXXXXX1002', 'IN', 'bank_account', %L, true, 'lender', 'f6b00000-0000-4000-8000-000000000001', 'Alpha Finance Ltd (test)', array['repayment_settlement'], null, null, 'reg-key-000000010')$$, pg_temp.got('rule2'))),
  '22023|fingerprint_invalid', 'an upper-case fingerprint is refused');
select is(pg_temp.err(format($$select payments.register_account('abc', 1, 'XXXXXX1002', 'IN', 'bank_account', %L, true, 'lender', 'f6b00000-0000-4000-8000-000000000001', 'Alpha Finance Ltd (test)', array['repayment_settlement'], null, null, 'reg-key-000000011')$$, pg_temp.got('rule2'))),
  '22023|fingerprint_invalid', 'a short fingerprint is refused');
select is(pg_temp.err(format($$select pg_temp.register(2, 'reg-key-000000012', %L::uuid, kv => 0)$$, pg_temp.got('rule2'))), '22023|key_version_invalid', 'key version 0 is refused');
select is(pg_temp.err(format($$select pg_temp.register(2, 'reg-key-000000013', %L::uuid, masked => 'XXXXXX123456')$$, pg_temp.got('rule2'))), '22023|masked_ref_invalid', 'a masked reference showing more than four digits is refused');
select is(pg_temp.err(format($$select pg_temp.register(2, 'reg-key-000000014', %L::uuid, masked => '123456781002')$$, pg_temp.got('rule2'))), '22023|masked_ref_invalid', 'a full number is refused as a masked reference');
select is(pg_temp.err(format($$select pg_temp.register(2, 'reg-key-000000015', %L::uuid, kind => 'bank')$$, pg_temp.got('rule2'))), '22023|owner_invalid', 'an unknown owner kind is refused');
select is(pg_temp.err(format($$select pg_temp.register(2, 'reg-key-000000016', %L::uuid, org => null)$$, pg_temp.got('rule2'))), '22023|owner_invalid', 'a lender-owned account needs the lender organisation');
select is(pg_temp.err(format($$select pg_temp.register(2, 'reg-key-000000017', %L::uuid, kind => 'udofin', purposes => array['fee_collection'])$$, pg_temp.got('rule2'))), '22023|owner_invalid', 'a non-lender owner must not name a lender organisation');
select is(pg_temp.err(format($$select pg_temp.register(2, 'reg-key-000000018', %L::uuid, org => 'f6a00000-0000-4000-8000-000000000000')$$, pg_temp.got('rule2'))), '22023|owner_invalid', 'the platform organisation is not a lender owner');
select is(pg_temp.err(format($$select pg_temp.register(2, 'reg-key-000000019', %L::uuid, org => 'f6b00000-0000-4000-8000-000000000004')$$, pg_temp.got('rule2'))), '22023|owner_invalid', 'a service partner is not a lender owner');
select is(pg_temp.err(format($$select pg_temp.register(2, 'reg-key-000000020', %L::uuid, kind => 'udofin', org => null, purposes => array['repayment_settlement'])$$, pg_temp.got('rule2'))), '22023|purposes_invalid', 'an Udofin account can never be permitted for repayment settlement');
select is(pg_temp.err(format($$select pg_temp.register(2, 'reg-key-000000021', %L::uuid, kind => 'group_company', org => null, purposes => array['fee_collection', 'repayment_settlement'])$$, pg_temp.got('rule2'))), '22023|purposes_invalid', 'nor a group company account');
select is(pg_temp.err(format($$select pg_temp.register(2, 'reg-key-000000022', %L::uuid, purposes => array[]::text[])$$, pg_temp.got('rule2'))), '22023|purposes_invalid', 'an empty purpose list is refused');
select is(pg_temp.err(format($$select pg_temp.register(2, 'reg-key-000000023', %L::uuid, purposes => array['repayment_settlement', 'repayment_settlement'])$$, pg_temp.got('rule2'))), '22023|purposes_invalid', 'duplicate purposes are refused');
select is(pg_temp.err(format($$select pg_temp.register(2, 'reg-key-000000024', %L::uuid, purposes => array['anything'])$$, pg_temp.got('rule2'))), '22023|purposes_invalid', 'an unknown purpose is refused');
select is(pg_temp.err(format($$select pg_temp.register(2, 'reg-key-000000025', %L::uuid, lname => 'Al')$$, pg_temp.got('rule2'))), '22023|legal_owner_name_invalid', 'a legal owner name under three characters is refused');
select is(pg_temp.err(format($$select pg_temp.register(2, 'reg-key-000000026', %L::uuid, eff_from => current_date, eff_to => current_date)$$, pg_temp.got('rule2'))), '22023|dates_invalid', 'effective_to must be after effective_from');
select is(pg_temp.err(format($$select pg_temp.register(2, 'short', %L::uuid)$$, pg_temp.got('rule2'))), '22023|bad_request', 'a short idempotency key is refused');
select is(pg_temp.err(format($$select pg_temp.register(2, 'reg-key-000000027', %L::uuid, lname => 'Contact 9000000001 Ltd')$$, pg_temp.got('rule2'))), '22023|unsafe_free_text', 'a legal owner name that looks like a phone number is refused by the free-text guard');
select is((select count(*) from payments.account_registry), 1::bigint, 'none of the refused calls registered anything');
-- Who may register.
select pg_temp.as_user(pg_temp.u(3));
select is(pg_temp.err(format($$select pg_temp.register(3, 'reg-key-000000030', %L::uuid)$$, pg_temp.got('rule2'))), '42501|', 'a verifier cannot register');
select pg_temp.as_user(pg_temp.u(8));
select is(pg_temp.err(format($$select pg_temp.register(3, 'reg-key-000000031', %L::uuid)$$, pg_temp.got('rule2'))), '42501|', 'a LENDER user can never write the registry');
select pg_temp.as_user(pg_temp.u(7));
select is(pg_temp.err(format($$select pg_temp.register(3, 'reg-key-000000032', %L::uuid)$$, pg_temp.got('rule2'))), '42501|', 'a platform user without a role cannot register');
select pg_temp.as_user(pg_temp.u(15));
select is(pg_temp.err(format($$select pg_temp.register(3, 'reg-key-000000033', %L::uuid)$$, pg_temp.got('rule2'))), '42501|', 'a borrower cannot register');
select pg_temp.as_anon();
select is(pg_temp.err(format($$select pg_temp.register(3, 'reg-key-000000034', %L::uuid)$$, pg_temp.got('rule2'))), '42501|', 'anon cannot register');
select pg_temp.as_user(pg_temp.u(1), 'aal1');
select is(pg_temp.err(format($$select pg_temp.register(3, 'reg-key-000000035', %L::uuid)$$, pg_temp.got('rule2'))), '42501|mfa_required', 'registering needs a second factor');

-- Verify: a different person, with evidence.
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err(format($$select payments.verify_account(%L, 'SAMPLE-EVIDENCE-016')$$, pg_temp.got('reg1'))), '42501|', 'the registrant cannot verify (no registry.verify permission)');
select pg_temp.as_owner();
select is(pg_temp.err(format($$update payments.account_registry set verification_status = 'verified', verified_by = registered_by, verified_at = now(), evidence_ref = 'SAMPLE-EVIDENCE-016' where id = %L$$, pg_temp.got('reg1'))), '23514|',
  'table level: verification by the registrant is refused by a check, whoever writes');
select is(pg_temp.err(format($$update payments.account_registry set verification_status = 'verified', verified_by = %L, verified_at = now() where id = %L$$, pg_temp.u(3), pg_temp.got('reg1'))), '23514|',
  'table level: verification without an evidence reference is refused');
select pg_temp.as_user(pg_temp.u(3), 'aal1');
select is(pg_temp.err(format($$select payments.verify_account(%L, 'SAMPLE-EVIDENCE-016')$$, pg_temp.got('reg1'))), '42501|mfa_required', 'verifying needs a second factor');
select pg_temp.as_user(pg_temp.u(3));
select is(pg_temp.err(format($$select payments.verify_account(%L, null)$$, pg_temp.got('reg1'))), '22023|evidence_invalid', 'verification needs an evidence reference');
select is(pg_temp.err(format($$select payments.verify_account(%L, '<script>')$$, pg_temp.got('reg1'))), '22023|evidence_invalid', 'which must be a plain label');
select is(pg_temp.err(format($$select payments.verify_account(%L, 'SAMPLE-EVIDENCE-016', %L)$$, pg_temp.got('reg1'), repeat('n', 1001))), '22023|reason_invalid', 'a long note is refused');
select is(pg_temp.err($$select payments.verify_account('00000000-0000-4000-8000-000000000000', 'SAMPLE-EVIDENCE-016')$$), 'P0002|', 'an unknown entry is not found');
select is(payments.verify_account(pg_temp.got('reg1')::uuid, 'SAMPLE-EVIDENCE-016', 'SAMPLE note'), 'verified', 'a different person with registry.verify verifies it');
select is((select (verification_status, verified_by = pg_temp.u(3), evidence_ref)::text from payments.account_registry where id = pg_temp.got('reg1')::uuid), '(verified,t,SAMPLE-EVIDENCE-016)', 'verified by verifier 1 on the evidence reference');
select is(payments.verify_account(pg_temp.got('reg1')::uuid, 'SAMPLE-EVIDENCE-016'), 'verified', 'verifying again with the same evidence is idempotent');
select pg_temp.as_user(pg_temp.u(4));
select is(pg_temp.err(format($$select payments.verify_account(%L, 'SAMPLE-EVIDENCE-016')$$, pg_temp.got('reg1'))), '55000|not_unverified', 'another verifier cannot verify it again');
select is((select array_agg(event_kind order by occurred_at) from payments.account_registry_events where registry_id = pg_temp.got('reg1')::uuid), array['registered', 'verified'], 'history: registered, verified');
-- The registrant must still be entitled when the verifier acts.
select pg_temp.as_user(pg_temp.u(2));
select pg_temp.keep('reg2', pg_temp.register(2, 'reg-key-000000040', pg_temp.got('rule2')::uuid, masked => 'XXXXXX1002')::text);
select pg_temp.as_owner();
delete from tenancy.membership_roles where membership_id = 'f6c10000-0000-4000-8000-000000000002';
select pg_temp.as_user(pg_temp.u(3));
select is(pg_temp.err(format($$select payments.verify_account(%L, 'SAMPLE-EVIDENCE-016')$$, pg_temp.got('reg2'))), '42501|requester_not_entitled', 'a registration whose registrant lost registry.manage cannot be verified');
select pg_temp.as_owner();
insert into tenancy.membership_roles (membership_id, role_id)
  select 'f6c10000-0000-4000-8000-000000000002', r.id from tenancy.roles r where r.org_id is null and r.applies_to = 'platform' and r.key = 'platform_payments_admin';
-- Reject.
select pg_temp.as_user(pg_temp.u(3));
select is(pg_temp.err(format($$select payments.reject_account(%L, 'short')$$, pg_temp.got('reg2'))), '22023|reason_required', 'a rejection needs a reason');
select is(payments.reject_account(pg_temp.got('reg2')::uuid, 'evidence does not show the stated owner'), 'rejected', 'a verifier rejects an unverified entry');
select is(payments.reject_account(pg_temp.got('reg2')::uuid, 'evidence does not show the stated owner'), 'rejected', 'rejecting again is idempotent');
select is(pg_temp.err(format($$select payments.verify_account(%L, 'SAMPLE-EVIDENCE-016')$$, pg_temp.got('reg2'))), '55000|not_unverified', 'a rejected entry cannot be verified');
select is(pg_temp.err(format($$select payments.revoke_account(%L, 'a reason that is long enough')$$, pg_temp.got('reg2'))), '55000|not_revocable', 'nor revoked');
select is(pg_temp.err(format($$select payments.reject_account(%L, 'a reason that is long enough')$$, pg_temp.got('reg1'))), '55000|not_unverified', 'a verified entry cannot be rejected (revoke it)');
select is(pg_temp.err(format($$select pg_temp.register(2, 'reg-key-000000041', %L::uuid, masked => 'XXXXXX1002')$$, pg_temp.got('rule2'))), '42501|', 'a verifier cannot re-register');
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err(format($$select pg_temp.register(2, 'reg-key-000000042', %L::uuid, masked => 'XXXXXX1002')$$, pg_temp.got('rule2'))), '23505|account_already_registered',
  'a rejected entry keeps its fingerprint: the account cannot be registered again under this key version');
-- Revoke: either permission, one person, a reason (fail-closed).
select pg_temp.keep('reg7', pg_temp.register(7, 'reg-key-000000043', pg_temp.got('rule2')::uuid, masked => 'XXXXXX0007')::text);
select is(pg_temp.err(format($$select payments.revoke_account(%L, 'short')$$, pg_temp.got('reg7'))), '22023|reason_required', 'a revocation needs a reason');
select is(pg_temp.err(format($$select payments.revoke_account(%L, %L)$$, pg_temp.got('reg7'), repeat('r', 1001))), '22023|reason_invalid', 'a very long reason is refused');
select is(payments.revoke_account(pg_temp.got('reg7')::uuid, 'registered in error, wrong owner entered'), 'revoked', 'the registrant (registry.manage) can revoke an unverified entry on their own');
select is(payments.revoke_account(pg_temp.got('reg7')::uuid, 'registered in error, wrong owner entered'), 'revoked', 'revoking again is idempotent');
select is((select (verification_status, revoked_by = pg_temp.u(1), revoked_reason)::text from payments.account_registry where id = pg_temp.got('reg7')::uuid), '(revoked,t,"registered in error, wrong owner entered")', 'who, when and why are recorded');
select is((select array_agg(event_kind order by occurred_at) from payments.account_registry_events where registry_id = pg_temp.got('reg7')::uuid), array['registered', 'revoked'], 'and in the history');
select pg_temp.as_user(pg_temp.u(8));
select is(pg_temp.err(format($$select payments.revoke_account(%L, 'a lender user must not revoke this')$$, pg_temp.got('reg1'))), '42501|', 'a lender user cannot revoke');
select pg_temp.as_user(pg_temp.u(15));
select is(pg_temp.err(format($$select payments.revoke_account(%L, 'a borrower must not revoke this')$$, pg_temp.got('reg1'))), '42501|', 'a borrower cannot revoke');
select pg_temp.as_anon();
select is(pg_temp.err(format($$select payments.revoke_account(%L, 'anon must not revoke this at all')$$, pg_temp.got('reg1'))), '42501|', 'anon cannot revoke');
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err($$select payments.revoke_account('00000000-0000-4000-8000-000000000000', 'a reason that is long enough')$$), 'P0002|', 'an unknown entry is not found');
-- No other way to write: grants and triggers.
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err(format($$update payments.account_registry set verification_status = 'verified' where id = %L$$, pg_temp.got('reg7'))), '42501|', 'a platform user cannot update registry rows directly');
select is(pg_temp.err(format($$delete from payments.account_registry where id = %L$$, pg_temp.got('reg7'))), '42501|', 'nor delete them');
select is(pg_temp.err(format($$insert into payments.account_registry_events (registry_id, event_kind, to_status) values (%L, 'verified', 'verified')$$, pg_temp.got('reg7'))), '42501|', 'nor forge history');
select pg_temp.as_system();
select is(pg_temp.err(format($$update payments.account_registry set verification_status = 'verified' where id = %L$$, pg_temp.got('reg7'))), '42501|', 'the system role cannot update registry rows');
select is(pg_temp.err($$select count(*) from payments.account_registry$$), '42501|', 'or even read the registry (the validation functions do)');
select is(pg_temp.err(format($$insert into payments.account_registry_events (registry_id, event_kind, to_status) values (%L, 'verified', 'verified')$$, pg_temp.got('reg7'))), '42501|', 'or forge history');
select pg_temp.as_owner();
select is(pg_temp.err(format($$delete from payments.account_registry where id = %L$$, pg_temp.got('reg7'))), 'P0001|Record a compensating entry instead.', 'rows are never deleted, not even by the owner');
select is(pg_temp.err(format($$update payments.account_registry set fingerprint = %L where id = %L$$, pg_temp.fp(99), pg_temp.got('reg1'))), 'P0001|', 'the fingerprint of an entry never changes');
select is(pg_temp.err(format($$update payments.account_registry set owner_kind = 'udofin', owner_org_id = null, permitted_purposes = array['operational'] where id = %L$$, pg_temp.got('reg1'))), 'P0001|', 'nor its owner or purposes');
select is(pg_temp.err(format($$update payments.account_registry set verification_status = 'unverified', verified_by = null, verified_at = null, evidence_ref = null where id = %L$$, pg_temp.got('reg1'))), 'P0001|', 'a verified entry cannot go back to unverified');
select is(pg_temp.err(format($$update payments.account_registry set verification_status = 'verified', verified_by = %L, verified_at = now(), evidence_ref = 'SAMPLE-EVIDENCE-016' where id = %L$$, pg_temp.u(3), pg_temp.got('reg7'))), 'P0001|', 'a revoked entry is final');
select is(pg_temp.err(format($$update payments.account_registry_events set note = 'rewritten' where registry_id = %L$$, pg_temp.got('reg1'))), 'P0001|Record a compensating entry instead.', 'registry history is append-only');
select is(pg_temp.err(format($$delete from payments.account_registry_events where registry_id = %L$$, pg_temp.got('reg1'))), 'P0001|Record a compensating entry instead.', 'and cannot be deleted');
-- Table-level constraints (the owner writes directly: the checks must hold for every writer).
select pg_temp.keep('rule2_', pg_temp.got('rule2'));
select is(pg_temp.err(format($$insert into payments.account_registry (fingerprint, key_version, masked_ref, country, account_type, format_rule_id, format_validated, owner_kind, owner_org_id, legal_owner_name, permitted_purposes, effective_from, registered_by, idempotency_key)
  values (%L, 1, 'XXXXXX0301', 'IN', 'bank_account', %L, true, 'udofin', null, 'Udofin SAMPLE Ltd', array['repayment_settlement'], current_date, %L, 'check-key-0000000001')$$, pg_temp.fp(301), pg_temp.got('rule2'), pg_temp.u(1))), '23514|',
  'a non-lender account can never carry the repayment_settlement purpose (check constraint)');
select is(pg_temp.err(format($$insert into payments.account_registry (fingerprint, key_version, masked_ref, country, account_type, format_rule_id, format_validated, owner_kind, owner_org_id, legal_owner_name, permitted_purposes, effective_from, registered_by, idempotency_key)
  values (%L, 1, 'XXXXXX0302', 'IN', 'bank_account', %L, false, 'other', null, 'Other SAMPLE Ltd', array['operational'], current_date, %L, 'check-key-0000000002')$$, pg_temp.fp(302), pg_temp.got('rule2'), pg_temp.u(1))), '23514|',
  'format_validated must be true for every row');
select is(pg_temp.err(format($$insert into payments.account_registry (fingerprint, key_version, masked_ref, country, account_type, format_rule_id, format_validated, owner_kind, owner_org_id, legal_owner_name, permitted_purposes, effective_from, effective_to, registered_by, idempotency_key)
  values (%L, 1, 'XXXXXX0303', 'IN', 'bank_account', %L, true, 'other', null, 'Other SAMPLE Ltd', array['operational'], current_date, current_date, %L, 'check-key-0000000003')$$, pg_temp.fp(303), pg_temp.got('rule2'), pg_temp.u(1))), '23514|',
  'effective_to must be after effective_from (check constraint)');
select is(pg_temp.err(format($$insert into payments.account_registry (fingerprint, key_version, masked_ref, country, account_type, format_rule_id, format_validated, owner_kind, owner_org_id, legal_owner_name, permitted_purposes, effective_from, registered_by, idempotency_key)
  values (%L, 1, 'XXXXXX0304', 'IN', 'bank_account', %L, true, 'lender', null, 'Alpha SAMPLE Ltd', array['repayment_settlement'], current_date, %L, 'check-key-0000000004')$$, pg_temp.fp(304), pg_temp.got('rule2'), pg_temp.u(1))), '23514|',
  'a lender-owned account needs its lender organisation (check constraint)');
select is(pg_temp.err(format($$insert into payments.account_registry (fingerprint, key_version, masked_ref, country, account_type, format_rule_id, format_validated, owner_kind, owner_org_id, legal_owner_name, permitted_purposes, effective_from, registered_by, idempotency_key)
  values (%L, 1, 'XXXXXX0305', 'IN', 'bank_account', %L, true, 'lender', 'f6a00000-0000-4000-8000-000000000000', 'Udofin SAMPLE Ltd', array['repayment_settlement'], current_date, %L, 'check-key-0000000005')$$, pg_temp.fp(305), pg_temp.got('rule2'), pg_temp.u(1))), '23503|',
  'the composite key proves the owner of a lender account is a LENDER organisation (the platform organisation is refused)');
select is(pg_temp.err(format($$insert into payments.account_registry (fingerprint, key_version, masked_ref, country, account_type, format_rule_id, format_validated, owner_kind, owner_org_id, legal_owner_name, permitted_purposes, effective_from, registered_by, idempotency_key)
  values (%L, 1, 'XXXXXX0306', 'GB', 'bank_account', %L, true, 'other', null, 'Other SAMPLE Ltd', array['operational'], current_date, %L, 'check-key-0000000006')$$, pg_temp.fp(306), pg_temp.got('rule2'), pg_temp.u(1))), '23503|',
  'the composite key ties the entry to a rule of the same country and account type');
select is(pg_temp.err(format($$insert into payments.account_registry (fingerprint, key_version, masked_ref, country, account_type, format_rule_id, format_validated, owner_kind, legal_owner_name, permitted_purposes, effective_from, registered_by, idempotency_key)
  values (%L, 1, 'XXXXXX0307', 'IN', 'bank_account', null, true, 'other', 'Other SAMPLE Ltd', array['operational'], current_date, %L, 'check-key-0000000007')$$, pg_temp.fp(307), pg_temp.u(1))), '23502|',
  'a registry row cannot exist without a format rule (not null)');
select is(pg_temp.err(format($$insert into payments.account_registry (fingerprint, key_version, masked_ref, country, account_type, format_rule_id, format_validated, owner_kind, legal_owner_name, permitted_purposes, effective_from, registered_by, idempotency_key)
  values ('not-a-fingerprint', 1, 'XXXXXX0308', 'IN', 'bank_account', %L, true, 'other', 'Other SAMPLE Ltd', array['operational'], current_date, %L, 'check-key-0000000008')$$, pg_temp.got('rule2'), pg_temp.u(1))), '23514|', 'the fingerprint shape is a check');
select is(pg_temp.err(format($$insert into payments.account_registry (fingerprint, key_version, masked_ref, country, account_type, format_rule_id, format_validated, owner_kind, legal_owner_name, permitted_purposes, effective_from, registered_by, idempotency_key)
  values (%L, 1, '1234567890', 'IN', 'bank_account', %L, true, 'other', 'Other SAMPLE Ltd', array['operational'], current_date, %L, 'check-key-0000000009')$$, pg_temp.fp(309), pg_temp.got('rule2'), pg_temp.u(1))), '23514|', 'the masked reference pattern is a check: a full number never fits');
select is(pg_temp.err(format($$insert into payments.account_registry (fingerprint, key_version, masked_ref, country, account_type, format_rule_id, format_validated, owner_kind, legal_owner_name, permitted_purposes, effective_from, registered_by, idempotency_key)
  values (%L, 1, 'XXXXXX0310', 'IN', 'bank_account', %L, true, 'other', 'Other SAMPLE Ltd', array['operational'], current_date, %L, 'check-key-0000000010')$$, pg_temp.fp(1), pg_temp.got('rule2'), pg_temp.u(1))), '23505|',
  'the unique key (fingerprint, key version) also holds for a direct insert');

-- ============================================================================================================================
-- 4. classify_destination: every branch (system only)
-- ============================================================================================================================
select pg_temp.as_owner();
select pg_temp.keep('c_ok', pg_temp.regrow(101, 'lender', 'f6b00000-0000-4000-8000-000000000001', array['repayment_settlement'])::text);
select pg_temp.regrow(102, 'lender', 'f6b00000-0000-4000-8000-000000000001', array['repayment_settlement'], 'unverified');
select pg_temp.regrow(103, 'lender', 'f6b00000-0000-4000-8000-000000000001', array['repayment_settlement'], 'rejected');
select pg_temp.regrow(104, 'lender', 'f6b00000-0000-4000-8000-000000000001', array['repayment_settlement'], 'revoked');
select pg_temp.regrow(105, 'udofin', null, array['fee_collection']);
select pg_temp.regrow(106, 'group_company', null, array['operational']);
select pg_temp.regrow(107, 'other', null, array['operational', 'disbursement_source']);
select pg_temp.regrow(108, 'lender', 'f6b00000-0000-4000-8000-000000000001', array['operational']);
select pg_temp.regrow(109, 'lender', 'f6b00000-0000-4000-8000-000000000001', array['repayment_settlement'], 'verified', 5, null);
select pg_temp.regrow(110, 'lender', 'f6b00000-0000-4000-8000-000000000001', array['repayment_settlement'], 'verified', -30, -1);
select pg_temp.regrow(111, 'lender', 'f6b00000-0000-4000-8000-000000000001', array['repayment_settlement'], 'verified', -30, 0);
select pg_temp.regrow(112, 'lender', 'f6b00000-0000-4000-8000-000000000001', array['repayment_settlement'], 'verified', -30, 1);
select pg_temp.regrow(113, 'udofin', null, array['fee_collection'], 'unverified');
select pg_temp.regrow(114, 'lender', 'f6b00000-0000-4000-8000-000000000001', array['repayment_settlement'], 'verified', 0, null);
select pg_temp.regrow(115, 'lender', 'f6b00000-0000-4000-8000-000000000001', array['repayment_settlement', 'fee_collection', 'disbursement_source', 'operational']);
select pg_temp.as_system();
create function pg_temp.cls(n integer, lender integer default 1, purpose text default 'repayment_settlement', kv integer default 1) returns text language sql as $fn$
  select (payments.classify_destination(pg_temp.fp(n), kv, ('f6b00000-0000-4000-8000-00000000000' || lender)::uuid, purpose) ->> 'decision') || ':' ||
         coalesce((select string_agg(r, ',' order by r) from jsonb_array_elements_text(payments.classify_destination(pg_temp.fp(n), kv, ('f6b00000-0000-4000-8000-00000000000' || lender)::uuid, purpose) -> 'reasons') r), '')
$fn$;
grant execute on function pg_temp.cls(integer, integer, text, integer) to public;
select is(pg_temp.cls(101), 'permitted:', 'verified, owned by the lender, permitted, effective: PERMITTED with no reasons');
select is(pg_temp.cls(999), 'refused:account_unknown', 'an unknown fingerprint is refused (account_unknown)');
select is(pg_temp.cls(102), 'hold:account_unverified', 'an unverified entry is HELD (account_unverified)');
select is(pg_temp.cls(103), 'refused:account_rejected', 'a rejected entry is refused');
select is(pg_temp.cls(104), 'refused:account_revoked', 'a revoked entry is refused');
select is(pg_temp.cls(101, 2), 'refused:owner_mismatch', 'an account owned by lender X is refused for lender Y (owner_mismatch)');
select is(pg_temp.cls(105), 'refused:owner_mismatch,owner_prohibited,purpose_not_permitted', 'an Udofin-owned account is refused for repayment settlement (owner_prohibited)');
select is(pg_temp.cls(106), 'refused:owner_mismatch,owner_prohibited,purpose_not_permitted', 'a group-company account is refused (owner_prohibited)');
select is(pg_temp.cls(107), 'refused:owner_mismatch,owner_prohibited,purpose_not_permitted', 'an account owned by anyone else is refused (owner_prohibited)');
select is(pg_temp.cls(105, 1, 'fee_collection'), 'refused:owner_mismatch', 'a non-lender-owned account is never permitted in a lender context, whatever the purpose');
select is(pg_temp.cls(108), 'refused:purpose_not_permitted', 'a purpose the entry does not list is refused (purpose_not_permitted)');
select is(pg_temp.cls(108, 1, 'operational'), 'permitted:', 'the same entry is permitted for its listed purpose');
select is(pg_temp.cls(109), 'refused:not_effective', 'an entry that is not effective yet is refused (not_effective)');
select is(pg_temp.cls(110), 'refused:not_effective', 'an entry that ended yesterday is refused');
select is(pg_temp.cls(111), 'refused:not_effective', 'effective_to is exclusive: an entry ending today is refused');
select is(pg_temp.cls(112), 'permitted:', 'an entry ending tomorrow is still effective');
select is(pg_temp.cls(113), 'refused:account_unverified,owner_mismatch,owner_prohibited,purpose_not_permitted', 'an unverified Udofin-owned account is refused outright, not held');
select is(pg_temp.cls(114), 'permitted:', 'effective from today counts as effective');
select is(pg_temp.cls(115, 1, 'disbursement_source'), 'permitted:', 'every listed purpose of a lender-owned account is permitted');
select is(pg_temp.cls(101, 1, 'repayment_settlement', 2), 'refused:account_unknown', 'classification looks up by (fingerprint, key version): the same fingerprint under another key version is unknown');
-- Only an entry under the ACTIVE key can be relied on (FC-1). Tried in a savepoint so the proposed version 2 leaves nothing behind.
savepoint sp_kv2;
select pg_temp.as_owner();
insert into payments.fingerprint_key_versions (key_version, proposed_by) values (2, pg_temp.u(1));
select pg_temp.regrow(101, 'lender', 'f6b00000-0000-4000-8000-000000000002', array['repayment_settlement'], 'verified', -30, null, 2);
select pg_temp.as_system();
select is(pg_temp.cls(101, 2, 'repayment_settlement', 2), 'refused:key_version_not_active', 'an entry under a key version that is only PROPOSED is refused, however verified it is');
select is(pg_temp.cls(101, 1, 'repayment_settlement', 1), 'permitted:', 'while the version 1 entry, under the active key, is untouched');
rollback to savepoint sp_kv2;
select pg_temp.as_owner();
select is((select count(*) from payments.fingerprint_key_versions), 1::bigint, 'the savepoint left no trace: only version 1 exists');
select pg_temp.as_system();
select is((payments.classify_destination('ABC', 1, 'f6b00000-0000-4000-8000-000000000001', 'repayment_settlement') ->> 'reasons'), '["input_invalid"]', 'a malformed fingerprint is refused (input_invalid)');
select is((payments.classify_destination(upper(pg_temp.fp(101)), 1, 'f6b00000-0000-4000-8000-000000000001', 'repayment_settlement') ->> 'decision'), 'refused', 'an upper-case fingerprint is refused');
select is((payments.classify_destination(pg_temp.fp(101), 0, 'f6b00000-0000-4000-8000-000000000001', 'repayment_settlement') ->> 'reasons'), '["input_invalid"]', 'key version 0 is refused');
select is((payments.classify_destination(pg_temp.fp(101), 1, null, 'repayment_settlement') ->> 'reasons'), '["input_invalid"]', 'a null lender is refused');
select is((payments.classify_destination(pg_temp.fp(101), 1, 'f6b00000-0000-4000-8000-000000000001', 'anything') ->> 'reasons'), '["input_invalid"]', 'an unknown purpose is refused');
select is((payments.classify_destination(pg_temp.fp(101), 1, 'f6b00000-0000-4000-8000-000000000001', null) ->> 'decision'), 'refused', 'a null purpose is refused');
select is((select count(*) from jsonb_object_keys(payments.classify_destination(pg_temp.fp(101), 1, 'f6b00000-0000-4000-8000-000000000001', 'repayment_settlement'))), 2::bigint, 'the answer carries exactly a decision and reasons: no registry id, owner or fingerprint');
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err($$select payments.classify_destination(repeat('a', 64), 1, 'f6b00000-0000-4000-8000-000000000001', 'repayment_settlement')$$), '42501|', 'a platform user cannot call classify_destination (system only)');
select pg_temp.as_user(pg_temp.u(8));
select is(pg_temp.err($$select payments.classify_destination(repeat('a', 64), 1, 'f6b00000-0000-4000-8000-000000000001', 'repayment_settlement')$$), '42501|', 'a lender user cannot probe the registry');
select pg_temp.as_anon();
select is(pg_temp.err($$select payments.classify_destination(repeat('a', 64), 1, 'f6b00000-0000-4000-8000-000000000001', 'repayment_settlement')$$), '42501|', 'anon cannot call it');
select pg_temp.as_owner();
select is(pg_temp.err($$select payments.classify_destination(repeat('a', 64), 1, 'f6b00000-0000-4000-8000-000000000001', 'repayment_settlement')$$), '42501|', 'even the owner role is refused: the check is on the invoking role (service_role only)');

-- ============================================================================================================================
-- 5. Settlement accounts: verified only with proof from the registry, read live
-- ============================================================================================================================
select pg_temp.as_system();
select lives_ok($$select pg_temp.mk_sa(pg_temp.sa(1), 'f6b00000-0000-4000-8000-000000000001', 'XXXXXX1001')$$, 'the system can still create an UNVERIFIED settlement account row (as before)');
select is(pg_temp.err($$insert into tenancy.lender_settlement_accounts (lender_org_id, label, bank_name, masked_account_ref, status, verified_by, verified_at)
  values ('f6b00000-0000-4000-8000-000000000001', 'SAMPLE forged', 'Test Bank', 'XXXXXX7777', 'verified', 'f6000000-0000-4000-8000-000000000003', now())$$), '55000|settlement_account_unproven',
  'the system cannot create a VERIFIED settlement account: no registry proof');
select is(pg_temp.err($$update tenancy.lender_settlement_accounts set status = 'verified' where id = 'f6e10000-0000-4000-8000-000000000001'$$), '42501|', 'the system can no longer update settlement accounts');
select is(pg_temp.err($$delete from tenancy.lender_settlement_accounts where id = 'f6e10000-0000-4000-8000-000000000001'$$), '42501|', 'or delete them');
select pg_temp.as_owner();
select is(pg_temp.err($$update tenancy.lender_settlement_accounts set status = 'verified', verified_by = 'f6000000-0000-4000-8000-000000000003', verified_at = now() where id = 'f6e10000-0000-4000-8000-000000000001'$$),
  '55000|settlement_account_unproven', 'not even the owner can verify one without a registry link');
select pg_temp.as_system();
select pg_temp.mk_sa(pg_temp.sa(2), 'f6b00000-0000-4000-8000-000000000001', 'XXXXXX0102');
select pg_temp.mk_sa(pg_temp.sa(3), 'f6b00000-0000-4000-8000-000000000001', 'XXXXXX0105');
select pg_temp.mk_sa(pg_temp.sa(4), 'f6b00000-0000-4000-8000-000000000001', 'XXXXXX0108');
select pg_temp.mk_sa(pg_temp.sa(5), 'f6b00000-0000-4000-8000-000000000001', 'XXXXXX0109');
select pg_temp.mk_sa(pg_temp.sa(6), 'f6b00000-0000-4000-8000-000000000001', 'XXXXXX0110');
select pg_temp.mk_sa(pg_temp.sa(7), 'f6b00000-0000-4000-8000-000000000001', 'XXXXXX9999');
select pg_temp.mk_sa(pg_temp.sa(8), 'f6b00000-0000-4000-8000-000000000002', 'XXXXXX0101');
select pg_temp.as_user(pg_temp.u(1));
select pg_temp.keep('r102', (select id::text from payments.account_registry where fingerprint = pg_temp.fp(102)));
select pg_temp.keep('r105', (select id::text from payments.account_registry where fingerprint = pg_temp.fp(105)));
select pg_temp.keep('r108', (select id::text from payments.account_registry where fingerprint = pg_temp.fp(108)));
select pg_temp.keep('r109', (select id::text from payments.account_registry where fingerprint = pg_temp.fp(109)));
select pg_temp.keep('r110', (select id::text from payments.account_registry where fingerprint = pg_temp.fp(110)));
select pg_temp.keep('r101', (select id::text from payments.account_registry where fingerprint = pg_temp.fp(101) and key_version = 1));
select is(pg_temp.err(format($$select payments.link_settlement_account(%L, %L)$$, pg_temp.sa(2), pg_temp.got('r102'))), '55000|registry_not_permitted', 'an UNVERIFIED registry entry cannot verify a settlement account');
select is(pg_temp.err(format($$select payments.link_settlement_account(%L, %L)$$, pg_temp.sa(8), pg_temp.got('r101'))), '55000|registry_not_permitted', 'an entry owned by ANOTHER lender cannot verify this lender''s account');
select is(pg_temp.err(format($$select payments.link_settlement_account(%L, %L)$$, pg_temp.sa(3), pg_temp.got('r105'))), '55000|registry_not_permitted', 'an Udofin-owned entry cannot verify a lender''s settlement account');
select is(pg_temp.err(format($$select payments.link_settlement_account(%L, %L)$$, pg_temp.sa(4), pg_temp.got('r108'))), '55000|registry_not_permitted', 'an entry without the repayment_settlement purpose cannot');
select is(pg_temp.err(format($$select payments.link_settlement_account(%L, %L)$$, pg_temp.sa(5), pg_temp.got('r109'))), '55000|registry_not_permitted', 'an entry that is not effective yet cannot');
select is(pg_temp.err(format($$select payments.link_settlement_account(%L, %L)$$, pg_temp.sa(6), pg_temp.got('r110'))), '55000|registry_not_permitted', 'an expired entry cannot');
select is(pg_temp.err(format($$select payments.link_settlement_account(%L, %L)$$, pg_temp.sa(7), pg_temp.got('r101'))), '55000|masked_ref_mismatch', 'a masked reference that differs from the registry entry is refused');
select is((select count(*) from tenancy.lender_settlement_accounts where status = 'verified' or registry_id is not null), 0::bigint, 'none of those refusals changed an account');
select pg_temp.as_user(pg_temp.u(3));
select is(pg_temp.err(format($$select payments.link_settlement_account(%L, %L)$$, pg_temp.sa(1), pg_temp.got('reg1'))), '42501|', 'a verifier cannot link (registry.manage is the linking permission)');
select pg_temp.as_user(pg_temp.u(8));
select is(pg_temp.err(format($$select payments.link_settlement_account(%L, %L)$$, pg_temp.sa(1), pg_temp.got('reg1'))), '42501|', 'a lender user cannot link their own account to anything');
select pg_temp.as_user(pg_temp.u(1), 'aal1');
select is(pg_temp.err(format($$select payments.link_settlement_account(%L, %L)$$, pg_temp.sa(1), pg_temp.got('reg1'))), '42501|mfa_required', 'linking needs a second factor');
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err(format($$select payments.link_settlement_account(%L, '00000000-0000-4000-8000-000000000000')$$, pg_temp.sa(1))), 'P0002|', 'an unknown registry entry is not found');
select is(pg_temp.err(format($$select payments.link_settlement_account('00000000-0000-4000-8000-000000000000', %L)$$, pg_temp.got('reg1'))), 'P0002|', 'an unknown settlement account is not found');
select is(payments.link_settlement_account(pg_temp.sa(1), pg_temp.got('reg1')::uuid), 'verified', 'a verified entry owned by this lender, permitted, effective, same masked reference: the account becomes verified');
select is((select (status, registry_id = pg_temp.got('reg1')::uuid, verified_by = pg_temp.u(1))::text from tenancy.lender_settlement_accounts where id = pg_temp.sa(1)), '(verified,t,t)', 'verified through the registry link');
select is(payments.link_settlement_account(pg_temp.sa(1), pg_temp.got('reg1')::uuid), 'verified', 'linking again is idempotent');
select is(pg_temp.err(format($$select payments.link_settlement_account(%L, %L)$$, pg_temp.sa(1), pg_temp.got('r101'))), '55000|already_linked', 'a linked account cannot be re-linked to another entry');
select pg_temp.as_owner();
select is(pg_temp.err(format($$update tenancy.lender_settlement_accounts set registry_id = %L where id = %L$$, pg_temp.got('r101'), pg_temp.sa(1))), 'P0001|', 'the registry link is permanent');
select is(pg_temp.err(format($$update tenancy.lender_settlement_accounts set masked_account_ref = 'XXXXXX5555' where id = %L$$, pg_temp.sa(1))), 'P0001|', 'and so is the masked reference of a registered account');
select is(pg_temp.err(format($$update tenancy.lender_settlement_accounts set registry_id = %L where id = %L$$, pg_temp.got('r101'), pg_temp.sa(8))), '23503|',
  'composite key: lender Y''s settlement account cannot point at an entry owned by lender X');
select is(pg_temp.err(format($$update tenancy.lender_settlement_accounts set registry_id = %L where id = %L$$, pg_temp.got('r105'), pg_temp.sa(3))), '23503|',
  'and no settlement account can point at an entry NOT owned by a lender (Udofin, group company, other)');
select is(pg_temp.err(format($$update tenancy.lender_settlement_accounts set registry_id = %L where id = %L$$, pg_temp.got('reg1'), pg_temp.sa(7))), '23505|',
  'one settlement account per registry entry: a second account cannot point at the same entry');
-- A revoked entry makes the account unusable at once.
select pg_temp.as_user(pg_temp.u(2));
select pg_temp.keep('reg30', pg_temp.register(30, 'reg-key-000000050', pg_temp.got('rule2')::uuid, masked => 'XXXXXX0030')::text);
select pg_temp.as_user(pg_temp.u(4));
select payments.verify_account(pg_temp.got('reg30')::uuid, 'SAMPLE-EVIDENCE-030');
select pg_temp.as_system();
select pg_temp.mk_sa(pg_temp.sa(30), 'f6b00000-0000-4000-8000-000000000001', 'XXXXXX0030');
select pg_temp.as_user(pg_temp.u(2));
select is(payments.link_settlement_account(pg_temp.sa(30), pg_temp.got('reg30')::uuid), 'verified', 'a second account is verified through its own entry');
select is(payments.revoke_account(pg_temp.got('reg30')::uuid, 'ownership changed, entry withdrawn for good'), 'revoked', 'the entry is revoked');
select is((select status::text from tenancy.lender_settlement_accounts where id = pg_temp.sa(30)), 'revoked', 'the settlement account linked to it is revoked in the same transaction');
select pg_temp.as_owner();
select is(pg_temp.err(format($$update tenancy.lender_settlement_accounts set status = 'verified' where id = %L$$, pg_temp.sa(30))), 'P0001|', 'and a revoked settlement account is final');
select pg_temp.as_user(pg_temp.u(14));
select is((select count(*) from payments.my_settlement_account_registry_status()), 2::bigint, 'a lender viewer (payment.read) sees the registry status of its OWN linked accounts only');
select is((select (masked_ref, verification_status, usable)::text from payments.my_settlement_account_registry_status() where settlement_account_id = pg_temp.sa(1)), '(XXXXXX1001,verified,t)', 'masked reference, status, and usable now');
select is((select (verification_status, usable)::text from payments.my_settlement_account_registry_status() where settlement_account_id = pg_temp.sa(30)), '(revoked,f)', 'a revoked entry reads as revoked and not usable');
select is((select proargnames from pg_proc where oid = 'payments.my_settlement_account_registry_status()'::regprocedure), array['settlement_account_id', 'lender_org_id', 'masked_ref', 'verification_status', 'effective_from', 'effective_to', 'usable'],
  'the lender view exposes exactly these seven columns and nothing else');
select is((select string_agg(x, ',') from unnest((select proargnames from pg_proc where oid = 'payments.my_settlement_account_registry_status()'::regprocedure)) x where x ~ 'finger|owner|reason'), null,
  'the lender view has no fingerprint, owner or reason column');
select is((select count(*) from payments.account_registry), 0::bigint, 'the same lender user cannot read the registry itself (row level security)');
select pg_temp.as_user(pg_temp.u(12));
select is((select count(*) from payments.my_settlement_account_registry_status()), 0::bigint, 'another lender sees none of lender X''s accounts');
select pg_temp.as_user(pg_temp.u(15));
select is((select count(*) from payments.my_settlement_account_registry_status()), 0::bigint, 'a borrower sees nothing');
select pg_temp.as_anon();
select is(pg_temp.err($$select * from payments.my_settlement_account_registry_status()$$), '42501|', 'anon is refused');

-- ============================================================================================================================
-- 6. Provider register and merchant registry
-- ============================================================================================================================
select pg_temp.as_user(pg_temp.u(3));
select is(pg_temp.err($$select payments.set_payment_provider('sample_provider', 'SAMPLE Provider', 'payment', 'approved', 'SAMPLE-AUTH-EVIDENCE-016', 'unverified')$$), '42501|', 'a verifier cannot maintain the provider register');
select pg_temp.as_user(pg_temp.u(8));
select is(pg_temp.err($$select payments.set_payment_provider('sample_provider', 'SAMPLE Provider', 'payment', 'approved', 'SAMPLE-AUTH-EVIDENCE-016', 'unverified')$$), '42501|', 'a lender user cannot');
select pg_temp.as_user(pg_temp.u(1), 'aal1');
select is(pg_temp.err($$select payments.set_payment_provider('sample_provider', 'SAMPLE Provider', 'payment', 'approved', 'SAMPLE-AUTH-EVIDENCE-016', 'unverified')$$), '42501|mfa_required', 'it needs a second factor');
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err($$select payments.set_payment_provider('Bad Key', 'SAMPLE Provider', 'payment', 'approved', null, 'unverified')$$), '22023|provider_invalid', 'a provider key must be a lower-case identifier');
select is(pg_temp.err($$select payments.set_payment_provider('sample_provider', 'SAMPLE Provider', 'bank', 'approved', null, 'unverified')$$), '22023|provider_invalid', 'a provider kind must be known');
select is(pg_temp.err($$select payments.set_payment_provider('sample_provider', 'SAMPLE Provider', 'payment', 'approved', 'bad evidence ref <', 'unverified')$$), '22023|evidence_invalid', 'the evidence is a label');
select is(pg_temp.err($$select payments.set_payment_provider('sample_provider', 'SAMPLE Provider', 'payment', 'suspended', null, 'unverified', 'short')$$), '22023|reason_required', 'suspending a provider needs a reason');
select is(payments.set_payment_provider('sample_provider', 'SAMPLE Provider', 'payment', 'approved', 'SAMPLE-AUTH-EVIDENCE-016', 'unverified'), 'approved', 'a platform user registers an approved provider with authorisation evidence');
select is(payments.set_payment_provider('sample_noevidence', 'SAMPLE Provider without evidence', 'payment', 'approved', null, 'unverified'), 'approved', 'a provider can be approved without evidence (only PRODUCTION use needs it)');
select is(payments.set_payment_provider('sample_provider2', 'SAMPLE Provider two', 'payment', 'approved', 'SAMPLE-AUTH-EVIDENCE-016B', 'likely'), 'approved', 'a second provider with evidence');
select is(payments.set_payment_provider('mock_gateway', 'SAMPLE mock gateway', 'payment', 'approved', null, 'unverified'), 'approved', 'the mock gateway is registered like any other provider (no evidence)');
select is((select count(*) from payments.provider_register), 4::bigint, 'four providers');
select pg_temp.as_user(pg_temp.u(8));
select is((select count(*) from payments.provider_register), 4::bigint, 'any staff member reads the provider register');
select pg_temp.as_user(pg_temp.u(15));
select is((select count(*) from payments.provider_register), 0::bigint, 'a borrower does not');
select pg_temp.as_system();
select is((select count(*) from payments.provider_register), 4::bigint, 'the system reads it');
select is(pg_temp.err($$update payments.provider_register set status = 'approved' where provider = 'sample_noevidence'$$), '42501|', 'but cannot write it');

-- Merchants.
select pg_temp.as_user(pg_temp.u(8));
select pg_temp.keep('mx1', payments.claim_merchant('f6b00000-0000-4000-8000-000000000001', 'sample_provider', 'SAMPLE-MERCHANT-X1')::text);
select is(payments.claim_merchant('f6b00000-0000-4000-8000-000000000001', 'sample_provider', 'SAMPLE-MERCHANT-X1')::text, pg_temp.got('mx1'), 'claiming your own merchant again is idempotent');
select is((select (owner_kind, purpose, status, owner_org_id = 'f6b00000-0000-4000-8000-000000000001')::text from payments.merchant_registry where id = pg_temp.got('mx1')::uuid), '(lender,repayment,active,t)', 'a lender claims its own repayment merchant');
select is(pg_temp.err($$select payments.claim_merchant('f6b00000-0000-4000-8000-000000000002', 'sample_provider', 'SAMPLE-MERCHANT-X9')$$), '42501|', 'a user cannot claim a merchant for ANOTHER lender');
select is(pg_temp.err($$select payments.claim_merchant('f6b00000-0000-4000-8000-000000000001', 'unknown_provider', 'SAMPLE-MERCHANT-X9')$$), '22023|provider_invalid', 'an unregistered provider is refused');
select is(pg_temp.err($$select payments.claim_merchant('f6b00000-0000-4000-8000-000000000001', 'sample_provider', 'x')$$), '22023|merchant_ref_invalid', 'a merchant reference must be a plain identifier');
select pg_temp.as_user(pg_temp.u(10));
select is(pg_temp.err($$select payments.claim_merchant('f6b00000-0000-4000-8000-000000000001', 'sample_provider', 'SAMPLE-MERCHANT-X9')$$), '42501|', 'an approver (no payment.configure) cannot claim');
select pg_temp.as_user(pg_temp.u(14));
select is(pg_temp.err($$select payments.claim_merchant('f6b00000-0000-4000-8000-000000000001', 'sample_provider', 'SAMPLE-MERCHANT-X9')$$), '42501|', 'a read-only user cannot claim');
select pg_temp.as_user(pg_temp.u(12));
select is(pg_temp.err($$select payments.claim_merchant('f6b00000-0000-4000-8000-000000000002', 'sample_provider', 'SAMPLE-MERCHANT-X1')$$), '23505|merchant_already_claimed', 'a merchant id claimed by lender X cannot be claimed by lender Y');
select pg_temp.keep('my1', payments.claim_merchant('f6b00000-0000-4000-8000-000000000002', 'sample_provider', 'SAMPLE-MERCHANT-Y1')::text);
select pg_temp.as_user(pg_temp.u(15));
select is(pg_temp.err($$select payments.claim_merchant('f6b00000-0000-4000-8000-000000000001', 'sample_provider', 'SAMPLE-MERCHANT-X9')$$), '42501|', 'a borrower cannot claim');
select pg_temp.as_anon();
select is(pg_temp.err($$select payments.claim_merchant('f6b00000-0000-4000-8000-000000000001', 'sample_provider', 'SAMPLE-MERCHANT-X9')$$), '42501|', 'anon cannot claim');
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err($$select payments.claim_merchant('f6b00000-0000-4000-8000-000000000001', 'sample_provider', 'SAMPLE-MERCHANT-X9')$$), '42501|', 'a platform user cannot claim a merchant for a lender (they do not hold payment.configure)');
select pg_temp.keep('mfee', payments.register_udofin_fee_merchant('sample_provider', 'SAMPLE-UDOFIN-FEES')::text);
select is(payments.register_udofin_fee_merchant('sample_provider', 'SAMPLE-UDOFIN-FEES')::text, pg_temp.got('mfee'), 'registering Udofin''s fee merchant again is idempotent');
select is((select (owner_kind, purpose, owner_org_id is null)::text from payments.merchant_registry where id = pg_temp.got('mfee')::uuid), '(udofin_fees,fee_collection,t)', 'Udofin''s own fee merchant is a different record type');
select is(pg_temp.err($$select payments.register_udofin_fee_merchant('sample_provider', 'SAMPLE-MERCHANT-X1')$$), '23505|merchant_already_claimed', 'a merchant claimed by a lender cannot be registered as Udofin''s');
select is(pg_temp.err($$select payments.register_udofin_fee_merchant('unknown_provider', 'SAMPLE-UDOFIN-FEES')$$), '22023|provider_invalid', 'an unregistered provider is refused');
select pg_temp.as_user(pg_temp.u(8));
select is(pg_temp.err($$select payments.claim_merchant('f6b00000-0000-4000-8000-000000000001', 'sample_provider', 'SAMPLE-UDOFIN-FEES')$$), '23505|merchant_already_claimed', 'and Udofin''s fee merchant cannot be claimed by a lender');
select is(pg_temp.err($$select payments.register_udofin_fee_merchant('sample_provider', 'SAMPLE-UDOFIN-FEES-2')$$), '42501|', 'a lender cannot register an Udofin merchant');
select pg_temp.keep('mx2', payments.claim_merchant('f6b00000-0000-4000-8000-000000000001', 'mock_gateway', 'SAMPLE-MERCHANT-X2')::text);
select pg_temp.keep('mx3', payments.claim_merchant('f6b00000-0000-4000-8000-000000000001', 'sample_noevidence', 'SAMPLE-MERCHANT-X3')::text);
select pg_temp.keep('mx4', payments.claim_merchant('f6b00000-0000-4000-8000-000000000001', 'sample_provider2', 'SAMPLE-MERCHANT-X4')::text);
select pg_temp.keep('mx5', payments.claim_merchant('f6b00000-0000-4000-8000-000000000001', 'sample_provider', 'SAMPLE-MERCHANT-X5')::text);
select pg_temp.keep('mx6', payments.claim_merchant('f6b00000-0000-4000-8000-000000000001', 'sample_provider', 'SAMPLE-MERCHANT-X6')::text);
select pg_temp.keep('mx7', payments.claim_merchant('f6b00000-0000-4000-8000-000000000001', 'sample_provider', 'SAMPLE-MERCHANT-X7')::text);
select is((select count(*) from payments.merchant_registry), 7::bigint, 'lender X sees exactly its own seven merchants (not lender Y''s, not Udofin''s fee merchant)');
select is((select count(*) from payments.merchant_registry where owner_org_id = 'f6b00000-0000-4000-8000-000000000002'), 0::bigint, 'lender X sees none of lender Y''s merchants');
select pg_temp.as_owner();
select is((select count(*) from payments.merchant_registry), 9::bigint, 'nine merchants exist: lender X (seven), lender Y (one), Udofin fees (one)');
select is(pg_temp.err($$insert into payments.merchant_registry (provider, merchant_ref, owner_kind, owner_org_id, purpose, claimed_by) values ('sample_provider', 'SAMPLE-MERCHANT-X1', 'lender', 'f6b00000-0000-4000-8000-000000000002', 'repayment', 'f6000000-0000-4000-8000-000000000001')$$), '23505|',
  'the unique key (provider, merchant ref) holds for every writer, across ALL organisations');
select is(pg_temp.err($$insert into payments.merchant_registry (provider, merchant_ref, owner_kind, owner_org_id, purpose, claimed_by) values ('sample_provider', 'SAMPLE-CHECK-1', 'udofin_fees', null, 'repayment', 'f6000000-0000-4000-8000-000000000001')$$), '23514|',
  'an Udofin fee merchant can never carry the repayment purpose (check)');
select is(pg_temp.err($$insert into payments.merchant_registry (provider, merchant_ref, owner_kind, owner_org_id, purpose, claimed_by) values ('sample_provider', 'SAMPLE-CHECK-2', 'lender', null, 'repayment', 'f6000000-0000-4000-8000-000000000001')$$), '23514|',
  'a lender merchant needs its lender organisation (check)');
select is(pg_temp.err($$insert into payments.merchant_registry (provider, merchant_ref, owner_kind, owner_org_id, purpose, claimed_by) values ('sample_provider', 'SAMPLE-CHECK-3', 'lender', 'f6a00000-0000-4000-8000-000000000000', 'repayment', 'f6000000-0000-4000-8000-000000000001')$$), '23503|',
  'a lender merchant of a NON-lender organisation is refused by the composite key');
select is(pg_temp.err($$update payments.merchant_registry set merchant_ref = 'SAMPLE-RENAMED' where provider = 'sample_provider' and merchant_ref = 'SAMPLE-MERCHANT-X1'$$), 'P0001|', 'a merchant registration cannot be edited');
select is(pg_temp.err($$delete from payments.merchant_registry where merchant_ref = 'SAMPLE-MERCHANT-X1'$$), 'P0001|Record a compensating entry instead.', 'or deleted');
select pg_temp.as_system();
select is(pg_temp.err($$insert into payments.merchant_registry (provider, merchant_ref, owner_kind, owner_org_id, purpose, claimed_by) values ('sample_provider', 'SAMPLE-CHECK-4', 'lender', 'f6b00000-0000-4000-8000-000000000001', 'repayment', 'f6000000-0000-4000-8000-000000000001')$$), '42501|', 'the system role cannot write merchants');

-- Merchant verification (review finding FC-2): a lender CLAIMS a merchant id; only a platform user who has seen evidence VERIFIES it.
select is((select (verification_status, verified_by is null)::text from payments.merchant_registry where id = pg_temp.got('mx1')::uuid), '(unverified,t)',
  'a claimed merchant starts unverified');
select is((select (verification_status, verification_evidence_ref, verified_by = pg_temp.u(1))::text from payments.merchant_registry where id = pg_temp.got('mfee')::uuid),
  '(verified,platform-registered,t)', 'Udofin''s own fee merchant is registered verified by the platform');
select pg_temp.as_user(pg_temp.u(8));
select is(pg_temp.err(format($$select payments.verify_merchant(%L, 'SAMPLE-MERCHANT-EVIDENCE')$$, pg_temp.got('mx1'))), '42501|', 'the claiming lender cannot verify its own merchant');
select pg_temp.as_user(pg_temp.u(3));
select is(pg_temp.err(format($$select payments.verify_merchant(%L, 'SAMPLE-MERCHANT-EVIDENCE')$$, pg_temp.got('mx1'))), '42501|', 'an account verifier without providers.manage cannot verify a merchant');
select pg_temp.as_user(pg_temp.u(1), 'aal1');
select is(pg_temp.err(format($$select payments.verify_merchant(%L, 'SAMPLE-MERCHANT-EVIDENCE')$$, pg_temp.got('mx1'))), '42501|mfa_required', 'verifying needs a second factor');
select pg_temp.as_anon();
select is(pg_temp.err(format($$select payments.verify_merchant(%L, 'SAMPLE-MERCHANT-EVIDENCE')$$, pg_temp.got('mx1'))), '42501|', 'anon cannot verify');
select pg_temp.as_user(pg_temp.u(15));
select is(pg_temp.err(format($$select payments.verify_merchant(%L, 'SAMPLE-MERCHANT-EVIDENCE')$$, pg_temp.got('mx1'))), '42501|', 'a borrower cannot verify');
select pg_temp.as_system();
select is(pg_temp.err(format($$select payments.verify_merchant(%L, 'SAMPLE-MERCHANT-EVIDENCE')$$, pg_temp.got('mx1'))), '42501|', 'the system role cannot verify');
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err($$select payments.verify_merchant(gen_random_uuid(), 'SAMPLE-MERCHANT-EVIDENCE')$$), 'P0002|', 'an unknown merchant is not found');
select is(pg_temp.err(format($$select payments.verify_merchant(%L, 'x')$$, pg_temp.got('mx1'))), '22023|evidence_ref_invalid', 'an evidence reference label is required');
select is(pg_temp.err(format($$select payments.verify_merchant(%L, 'SAMPLE-MERCHANT-EVIDENCE')$$, pg_temp.got('mfee'))), '55000|already_verified',
  'Udofin''s fee merchant was verified when the platform registered it; it is not re-verified');
select is(payments.verify_merchant(pg_temp.got('mx1')::uuid, 'SAMPLE-MERCHANT-EVIDENCE'), 'verified', 'a platform user verifies the claim against evidence');
select is(payments.verify_merchant(pg_temp.got('mx1')::uuid, 'SAMPLE-MERCHANT-EVIDENCE'), 'verified', 'the same verification again is idempotent');
select is(pg_temp.err(format($$select payments.verify_merchant(%L, 'SAMPLE-OTHER-EVIDENCE')$$, pg_temp.got('mx1'))), '55000|already_verified', 'but cannot be re-verified on other evidence');
select is((select (verification_status, verification_evidence_ref, verified_by = pg_temp.u(1), verified_at is not null)::text from payments.merchant_registry where id = pg_temp.got('mx1')::uuid),
  '(verified,SAMPLE-MERCHANT-EVIDENCE,t,t)', 'the proof is recorded');
select pg_temp.keep('v2', payments.verify_merchant(pg_temp.got('mx2')::uuid, 'SAMPLE-MERCHANT-EVIDENCE-2'));
select pg_temp.keep('v3', payments.verify_merchant(pg_temp.got('mx3')::uuid, 'SAMPLE-MERCHANT-EVIDENCE-3'));
select pg_temp.keep('v4', payments.verify_merchant(pg_temp.got('mx4')::uuid, 'SAMPLE-MERCHANT-EVIDENCE-4'));
select pg_temp.keep('v5', payments.verify_merchant(pg_temp.got('mx5')::uuid, 'SAMPLE-MERCHANT-EVIDENCE-5'));
select pg_temp.keep('v6', payments.verify_merchant(pg_temp.got('mx6')::uuid, 'SAMPLE-MERCHANT-EVIDENCE-6'));
select pg_temp.keep('v7', payments.verify_merchant(pg_temp.got('mx7')::uuid, 'SAMPLE-MERCHANT-EVIDENCE-7'));
select is((select count(*) from payments.merchant_registry where verification_status = 'verified' and owner_kind = 'lender'), 7::bigint,
  'lender X''s seven merchants are verified; lender Y''s claim is left unverified for the negative tests');
select pg_temp.as_owner();
select is(pg_temp.err(format($$update payments.merchant_registry set verification_status = 'unverified', verified_by = null, verified_at = null, verification_evidence_ref = null where id = %L$$, pg_temp.got('mx1'))),
  'P0001|', 'a verification is never taken back (even by the owner): a wrong claim is revoked instead');
select is(pg_temp.err(format($$update payments.merchant_registry set verification_status = 'verified', verified_by = claimed_by, verified_at = now(), verification_evidence_ref = 'SAMPLE-SELF' where id = %L$$, pg_temp.got('my1'))),
  '23514|', 'the claimant cannot be the verifier, whoever writes the row (check)');
select is(pg_temp.err(format($$update payments.merchant_registry set verification_status = 'verified' where id = %L$$, pg_temp.got('my1'))),
  '23514|', 'verified without a verifier, a time and evidence is refused (check)');

-- ============================================================================================================================
-- 7. Payment configuration: draft, submit, approve (maker-checker), validation (spec 7.1), kill switch, revalidation
-- ============================================================================================================================
-- X's production-grade pieces: provider sample_provider (evidence), merchant mx1, settlement account sa(1) (verified through reg1).
select pg_temp.as_user(pg_temp.u(8));
select pg_temp.keep('c1', pg_temp.draft('f6b00000-0000-4000-8000-000000000001', 'cfg-key-0000000001', merchant => pg_temp.got('mx1')::uuid, settle => pg_temp.sa(1))::text);
select is((select (status, provider_mode::text, drafted_by = pg_temp.u(8), submitted_by is null, approved_by is null, evidence_ref, contract_section_ref)::text
           from payments.lender_payment_configs where id = pg_temp.got('c1')::uuid), '(draft,production,t,t,t,SAMPLE-EVIDENCE-CFG,SAMPLE-CONTRACT-CFG)', 'a lender drafts a configuration');
select is((select (event_kind, to_status, actor_kind)::text from payments.lender_payment_config_events where config_id = pg_temp.got('c1')::uuid), '(drafted,draft,lender)', 'the history records the draft by a lender actor');
select is(pg_temp.draft('f6b00000-0000-4000-8000-000000000001', 'cfg-key-0000000001', merchant => pg_temp.got('mx1')::uuid, settle => pg_temp.sa(1))::text, pg_temp.got('c1'), 'a replay with the same key returns the same configuration');
select is(pg_temp.err(format($$select pg_temp.draft('f6b00000-0000-4000-8000-000000000001', 'cfg-key-0000000001', provider => 'sample_provider2', merchant => %L::uuid, settle => %L::uuid)$$, pg_temp.got('mx4'), pg_temp.sa(1))), '23505|idempotency_conflict',
  'the same key with different content is refused');
select is(pg_temp.err(format($$select pg_temp.draft('f6b00000-0000-4000-8000-000000000001', 'cfg-key-0000000002', merchant => %L::uuid, settle => %L::uuid, token => pg_temp.token('cfg-key-0000000001'))$$, pg_temp.got('mx5'), pg_temp.sa(1))), '23505|endpoint_token_in_use',
  'an endpoint token hash cannot be used twice');
select is(pg_temp.err(format($$select pg_temp.draft('f6b00000-0000-4000-8000-000000000001', 'cfg-key-0000000003', provider => 'unknown_provider', merchant => %L::uuid, settle => %L::uuid)$$, pg_temp.got('mx1'), pg_temp.sa(1))), '22023|provider_invalid', 'an unregistered provider is refused');
select is(pg_temp.err(format($$select pg_temp.draft('f6b00000-0000-4000-8000-000000000001', 'cfg-key-0000000004', mode => 'staging', merchant => %L::uuid, settle => %L::uuid)$$, pg_temp.got('mx1'), pg_temp.sa(1))), '22023|provider_mode_invalid', 'an unknown provider mode is refused');
select is(pg_temp.err(format($$select pg_temp.draft('f6b00000-0000-4000-8000-000000000001', 'cfg-key-0000000005', mode => 'mock', provider => 'mock_gateway', merchant => %L::uuid, settle => %L::uuid)$$, pg_temp.got('mx2'), pg_temp.sa(1))), '42501|mock_provider_blocked',
  'a MOCK configuration is refused where the session does not allow mocks');
select is(pg_temp.err(format($$select pg_temp.draft('f6b00000-0000-4000-8000-000000000001', 'cfg-key-0000000006', mode => 'sandbox', merchant => %L::uuid, settle => %L::uuid)$$, pg_temp.got('mx1'), pg_temp.sa(1))), '42501|sandbox_provider_blocked',
  'and so is a SANDBOX configuration');
select is(pg_temp.err(format($$select pg_temp.draft('f6b00000-0000-4000-8000-000000000001', 'cfg-key-0000000007', secret => 'sk_live_abcdef0123456789', merchant => %L::uuid, settle => %L::uuid)$$, pg_temp.got('mx1'), pg_temp.sa(1))), '22023|secret_ref_invalid',
  'a secret VALUE (not an UPPER_CASE name) is refused as a secret reference');
select is(pg_temp.err(format($$select pg_temp.draft('f6b00000-0000-4000-8000-000000000001', 'cfg-key-0000000008', secret => 'SAME_REF', hook => 'SAME_REF', merchant => %L::uuid, settle => %L::uuid)$$, pg_temp.got('mx1'), pg_temp.sa(1))), '22023|secret_ref_invalid',
  'the provider secret and the webhook secret must be different names');
select is(pg_temp.err(format($$select pg_temp.draft('f6b00000-0000-4000-8000-000000000001', 'cfg-key-0000000009', token => 'abc', merchant => %L::uuid, settle => %L::uuid)$$, pg_temp.got('mx1'), pg_temp.sa(1))), '22023|endpoint_token_hash_invalid',
  'the endpoint token hash must be a SHA-256 hex digest (never the token)');
select is(pg_temp.err(format($$select pg_temp.draft('f6b00000-0000-4000-8000-000000000001', 'cfg-key-0000000010', limits => '{"upi_autopay":{"max_amount_minor":1500000}}', merchant => %L::uuid, settle => %L::uuid)$$, pg_temp.got('mx1'), pg_temp.sa(1))), '22023|rail_limits_invalid',
  'rail limits need a source note');
select is(pg_temp.err(format($$select pg_temp.draft('f6b00000-0000-4000-8000-000000000001', 'cfg-key-0000000011', limits => '{"upi_autopay":{"max_amount_minor":1500.5}}', lsource => 'SAMPLE provider documentation section 4', merchant => %L::uuid, settle => %L::uuid)$$, pg_temp.got('mx1'), pg_temp.sa(1))), '22023|rail_limits_invalid',
  'a fractional (floating-point) limit is refused');
select is(pg_temp.err(format($$select pg_temp.draft('f6b00000-0000-4000-8000-000000000001', 'cfg-key-0000000012', limits => '{"upi_autopay":{"a":{"b":1}}}', lsource => 'SAMPLE provider documentation section 4', merchant => %L::uuid, settle => %L::uuid)$$, pg_temp.got('mx1'), pg_temp.sa(1))), '22023|rail_limits_invalid',
  'nested limits are refused');
select is(pg_temp.err(format($$select pg_temp.draft('f6b00000-0000-4000-8000-000000000001', 'cfg-key-0000000013', merchant => %L::uuid, settle => %L::uuid)$$, pg_temp.got('my1'), pg_temp.sa(1))), '22023|merchant_invalid',
  'a merchant registered to ANOTHER lender cannot be used');
select is(pg_temp.err(format($$select pg_temp.draft('f6b00000-0000-4000-8000-000000000001', 'cfg-key-0000000014', merchant => %L::uuid, settle => %L::uuid)$$, pg_temp.got('mfee'), pg_temp.sa(1))), '22023|merchant_invalid',
  'Udofin''s own fee merchant can never be used for repayments');
select is(pg_temp.err(format($$select pg_temp.draft('f6b00000-0000-4000-8000-000000000001', 'cfg-key-0000000015', merchant => %L::uuid, settle => %L::uuid)$$, pg_temp.got('mx1'), pg_temp.sa(8))), '22023|settlement_account_invalid',
  'another lender''s settlement account cannot be used');
select is((select count(*) from payments.lender_payment_configs), 1::bigint, 'none of the refused drafts left a row');
select pg_temp.as_user(pg_temp.u(12));
select is(pg_temp.err(format($$select pg_temp.draft('f6b00000-0000-4000-8000-000000000001', 'cfg-key-0000000016', merchant => %L::uuid, settle => %L::uuid)$$, pg_temp.got('mx1'), pg_temp.sa(1))), '42501|', 'a user of lender Y cannot draft a configuration for lender X');
select pg_temp.as_user(pg_temp.u(10));
select is(pg_temp.err(format($$select pg_temp.draft('f6b00000-0000-4000-8000-000000000001', 'cfg-key-0000000017', merchant => %L::uuid, settle => %L::uuid)$$, pg_temp.got('mx1'), pg_temp.sa(1))), '42501|', 'an approver cannot draft');
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err(format($$select pg_temp.draft('f6b00000-0000-4000-8000-000000000001', 'cfg-key-0000000018', merchant => %L::uuid, settle => %L::uuid)$$, pg_temp.got('mx1'), pg_temp.sa(1))), '42501|', 'a platform user cannot draft a lender''s configuration');
select is(pg_temp.err(format($$select pg_temp.draft('f6a00000-0000-4000-8000-000000000000', 'cfg-key-0000000019', merchant => %L::uuid, settle => %L::uuid)$$, pg_temp.got('mx1'), pg_temp.sa(1))), '42501|', 'a configuration cannot be drafted for a NON-lender organisation');
select pg_temp.as_user(pg_temp.u(15));
select is(pg_temp.err(format($$select pg_temp.draft('f6b00000-0000-4000-8000-000000000001', 'cfg-key-0000000020', merchant => %L::uuid, settle => %L::uuid)$$, pg_temp.got('mx1'), pg_temp.sa(1))), '42501|', 'a borrower cannot draft');
select pg_temp.as_anon();
select is(pg_temp.err(format($$select pg_temp.draft('f6b00000-0000-4000-8000-000000000001', 'cfg-key-0000000021', merchant => %L::uuid, settle => %L::uuid)$$, pg_temp.got('mx1'), pg_temp.sa(1))), '42501|', 'anon cannot draft');
select pg_temp.as_user(pg_temp.u(8), 'aal1');
select is(pg_temp.err(format($$select pg_temp.draft('f6b00000-0000-4000-8000-000000000001', 'cfg-key-0000000022', merchant => %L::uuid, settle => %L::uuid)$$, pg_temp.got('mx1'), pg_temp.sa(1))), '42501|mfa_required', 'drafting needs a second factor');

-- Validation (system only), the healthy case and every refusal of spec 7.1.
select pg_temp.as_system();
create function pg_temp.vr(p_cfg text) returns text language sql as $fn$
  select (payments.validate_collection_target(p_cfg::uuid) ->> 'ok') || ':' || coalesce((select string_agg(r, ',' order by o) from jsonb_array_elements_text(payments.validate_collection_target(p_cfg::uuid) -> 'reasons') with ordinality x (r, o)), '')
$fn$;
grant execute on function pg_temp.vr(text) to public;
select is(pg_temp.vr(pg_temp.got('c1')), 'true:', 'a lender''s own verified account, own active merchant, approved production provider with evidence: valid');
select is(pg_temp.vr('00000000-0000-4000-8000-000000000000'), 'false:config_not_found', 'an unknown configuration is not valid');
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err(format($$select payments.validate_collection_target(%L)$$, pg_temp.got('c1'))), '42501|', 'a platform user cannot call the validation (system only)');
select pg_temp.as_user(pg_temp.u(8));
select is(pg_temp.err(format($$select payments.validate_collection_target(%L)$$, pg_temp.got('c1'))), '42501|', 'a lender user cannot call it');
select pg_temp.as_anon();
select is(pg_temp.err(format($$select payments.validate_collection_target(%L)$$, pg_temp.got('c1'))), '42501|', 'anon cannot call it');
-- Submit and approve (two people), then the attacks on approval.
select pg_temp.as_user(pg_temp.u(10));
select is(pg_temp.err(format($$select payments.submit_payment_config(%L)$$, pg_temp.got('c1'))), 'P0002|', 'an approver cannot submit (no payment.configure)');
select pg_temp.as_user(pg_temp.u(12));
select is(pg_temp.err(format($$select payments.submit_payment_config(%L)$$, pg_temp.got('c1'))), 'P0002|', 'another lender cannot even see that the configuration exists');
select pg_temp.as_user(pg_temp.u(9), 'aal1');
select is(pg_temp.err(format($$select payments.submit_payment_config(%L)$$, pg_temp.got('c1'))), '42501|mfa_required', 'submitting needs a second factor');
select pg_temp.as_user(pg_temp.u(9));
select is(payments.submit_payment_config(pg_temp.got('c1')::uuid), 'pending_approval', 'a second configure holder submits it (validation passes)');
select is(payments.submit_payment_config(pg_temp.got('c1')::uuid), 'pending_approval', 'submitting again is idempotent');
select is((select (status, submitted_by = pg_temp.u(9), last_validation_ok)::text from payments.lender_payment_configs where id = pg_temp.got('c1')::uuid), '(pending_approval,t,t)', 'pending approval, submitted by user 9');
select pg_temp.as_user(pg_temp.u(8));
select is(pg_temp.err(format($$select payments.decide_payment_config(%L, true)$$, pg_temp.got('c1'))), 'P0002|', 'the drafter cannot decide (no payment.config.approve)');
select pg_temp.as_user(pg_temp.u(12));
select is(pg_temp.err(format($$select payments.decide_payment_config(%L, true)$$, pg_temp.got('c1'))), 'P0002|', 'an approver of ANOTHER lender cannot decide');
select pg_temp.as_user(pg_temp.u(13));
select is(pg_temp.err(format($$select payments.decide_payment_config(%L, true)$$, pg_temp.got('c1'))), 'P0002|', 'nor can lender Y''s approver find it');
select pg_temp.as_user(pg_temp.u(15));
select is(pg_temp.err(format($$select payments.decide_payment_config(%L, true)$$, pg_temp.got('c1'))), 'P0002|', 'a borrower cannot decide (the same not-found answer as for any non-holder: no existence oracle)');
select pg_temp.as_anon();
select is(pg_temp.err(format($$select payments.decide_payment_config(%L, true)$$, pg_temp.got('c1'))), '42501|', 'anon cannot decide');
select pg_temp.as_owner();
select is(pg_temp.err(format($$update payments.lender_payment_configs set status = 'active', approved_by = drafted_by, approved_at = now() where id = %L$$, pg_temp.got('c1'))), '23514|',
  'table level: approval by the drafter is refused by a check, whoever writes');
select is(pg_temp.err(format($$update payments.lender_payment_configs set status = 'active', approved_by = submitted_by, approved_at = now() where id = %L$$, pg_temp.got('c1'))), '23514|',
  'and so is approval by the submitter');
select pg_temp.as_user(pg_temp.u(10), 'aal1');
select is(pg_temp.err(format($$select payments.decide_payment_config(%L, true)$$, pg_temp.got('c1'))), '42501|mfa_required', 'approving needs a second factor');
select pg_temp.as_user(pg_temp.u(10));
select is(pg_temp.err(format($$select payments.decide_payment_config(%L, null)$$, pg_temp.got('c1'))), '22023|bad_request', 'approve must be true or false');
select is(payments.decide_payment_config(pg_temp.got('c1')::uuid, true, 'SAMPLE approval'), 'active', 'a different person with payment.config.approve approves it: active');
select is((select (status, approved_by = pg_temp.u(10), drafted_by <> approved_by, submitted_by <> approved_by)::text from payments.lender_payment_configs where id = pg_temp.got('c1')::uuid), '(active,t,t,t)', 'drafter, submitter and approver are three different people');
select is(payments.decide_payment_config(pg_temp.got('c1')::uuid, true), 'active', 'approving again is idempotent');
select is((select array_agg(event_kind order by occurred_at) from payments.lender_payment_config_events where config_id = pg_temp.got('c1')::uuid), array['drafted', 'submitted', 'approved'], 'history: drafted, submitted, approved');
select pg_temp.as_user(pg_temp.u(11));
select is(pg_temp.err(format($$select payments.decide_payment_config(%L, false, 'a second approver rejects it now')$$, pg_temp.got('c1'))), '55000|config_state_invalid', 'an active configuration cannot be decided again');
-- Reject path and withdraw.
select pg_temp.as_user(pg_temp.u(8));
select pg_temp.keep('c2', pg_temp.draft('f6b00000-0000-4000-8000-000000000001', 'cfg-key-0000000030', merchant => pg_temp.got('mx5')::uuid, settle => pg_temp.sa(1))::text);
select pg_temp.as_user(pg_temp.u(9));
select payments.submit_payment_config(pg_temp.got('c2')::uuid);
select pg_temp.as_user(pg_temp.u(10));
select is(pg_temp.err(format($$select payments.decide_payment_config(%L, false, 'short')$$, pg_temp.got('c2'))), '22023|reason_required', 'a rejection needs a reason');
select is(payments.decide_payment_config(pg_temp.got('c2')::uuid, false, 'the merchant reference does not match the contract'), 'retired', 'a rejection retires the configuration');
select is(pg_temp.err(format($$select payments.decide_payment_config(%L, true)$$, pg_temp.got('c2'))), '55000|config_state_invalid', 'a retired configuration cannot be approved');
select pg_temp.as_user(pg_temp.u(8));
select pg_temp.keep('c3', pg_temp.draft('f6b00000-0000-4000-8000-000000000001', 'cfg-key-0000000031', merchant => pg_temp.got('mx6')::uuid, settle => pg_temp.sa(1))::text);
select is(pg_temp.err(format($$select payments.withdraw_payment_config(%L, 'short')$$, pg_temp.got('c3'))), '22023|reason_required', 'withdrawing needs a reason');
select is(payments.withdraw_payment_config(pg_temp.got('c3')::uuid, 'drafted by mistake, wrong merchant chosen'), 'retired', 'the maker withdraws a draft');
select is(payments.withdraw_payment_config(pg_temp.got('c3')::uuid, 'drafted by mistake, wrong merchant chosen'), 'retired', 'withdrawing again is idempotent');
select is(pg_temp.err(format($$select payments.withdraw_payment_config(%L, 'trying to withdraw an active configuration')$$, pg_temp.got('c1'))), '55000|config_state_invalid', 'an ACTIVE configuration cannot be withdrawn (it is suspended or retired)');
select pg_temp.as_user(pg_temp.u(12));
select is(pg_temp.err(format($$select payments.withdraw_payment_config(%L, 'another lender must not withdraw it')$$, pg_temp.got('c1'))), 'P0002|', 'another lender cannot withdraw');

-- Spec 7.1 refusals, one by one (the configuration being validated is shown in the assertion).
-- (1) organisation and onboarding gate.
select pg_temp.as_owner();
update tenancy.organizations set status = 'suspended' where id = 'f6b00000-0000-4000-8000-000000000001';
select pg_temp.as_system();
select is(pg_temp.vr(pg_temp.got('c1')), 'false:lender_organisation_not_active', 'refused when the lender organisation is not active');
select pg_temp.as_owner();
update tenancy.organizations set status = 'active' where id = 'f6b00000-0000-4000-8000-000000000001';
update onboarding.lender_gates set stage = 'suspended' where lender_org_id = 'f6b00000-0000-4000-8000-000000000001';
select pg_temp.as_system();
select is(pg_temp.vr(pg_temp.got('c1')), 'false:onboarding_gate_not_activated', 'refused when the onboarding gate is not activated');
select pg_temp.as_owner();
update onboarding.lender_gates set stage = 'activated' where lender_org_id = 'f6b00000-0000-4000-8000-000000000001';
-- (2) settlement account: unverified.
select pg_temp.as_user(pg_temp.u(8));
select pg_temp.keep('c_unv', pg_temp.draft('f6b00000-0000-4000-8000-000000000001', 'cfg-key-0000000040', merchant => pg_temp.got('mx5')::uuid, settle => pg_temp.sa(2))::text);
select pg_temp.as_system();
select is(pg_temp.vr(pg_temp.got('c_unv')), 'false:settlement_account_not_verified,settlement_account_unregistered', 'refused: an UNVERIFIED settlement account with no registry entry');
select pg_temp.as_user(pg_temp.u(9));
select is(pg_temp.msg(format($$select payments.submit_payment_config(%L)$$, pg_temp.got('c_unv'))), 'collection target invalid: settlement_account_not_verified', 'submitting it is refused with the first reason code in the message');
select is(pg_temp.err(format($$select payments.submit_payment_config(%L)$$, pg_temp.got('c_unv'))), '55000|collection_target_invalid', 'with the hint collection_target_invalid');
select pg_temp.as_owner();
select is(pg_temp.err(format($$update payments.lender_payment_configs set status = 'pending_approval', submitted_by = %L, submitted_at = now() where id = %L$$, pg_temp.u(9), pg_temp.got('c_unv'))), 'ok', 'the table itself lets a configuration be PENDING (submission is checked by the function) ...');
select is(pg_temp.err(format($$update payments.lender_payment_configs set status = 'active', approved_by = %L, approved_at = now() where id = %L$$, pg_temp.u(10), pg_temp.got('c_unv'))), '55000|collection_target_invalid',
  '... but ACTIVATION is refused by the table for every writer while the target is invalid');
-- (2b) other lender's account / (3) other lender's merchant, udofin fee merchant: composite keys.
select is(pg_temp.err(format($$insert into payments.lender_payment_configs (lender_org_id, provider, provider_mode, merchant_registry_id, settlement_account_id, secret_ref, webhook_secret_ref, endpoint_token_hash, idempotency_key, drafted_by)
  values ('f6b00000-0000-4000-8000-000000000001', 'sample_provider', 'production', %L, %L, 'SAMPLE_A', 'SAMPLE_B', %L, 'direct-key-000000000001', %L)$$, pg_temp.got('mx1'), pg_temp.sa(8), pg_temp.token('d1'), pg_temp.u(8))), '23503|',
  'composite key: another lender''s settlement account cannot be referenced by a configuration');
select is(pg_temp.err(format($$insert into payments.lender_payment_configs (lender_org_id, provider, provider_mode, merchant_registry_id, settlement_account_id, secret_ref, webhook_secret_ref, endpoint_token_hash, idempotency_key, drafted_by)
  values ('f6b00000-0000-4000-8000-000000000001', 'sample_provider', 'production', %L, %L, 'SAMPLE_A', 'SAMPLE_B', %L, 'direct-key-000000000002', %L)$$, pg_temp.got('my1'), pg_temp.sa(1), pg_temp.token('d2'), pg_temp.u(8))), '23503|',
  'composite key: a merchant claimed by ANOTHER organisation cannot be referenced');
select is(pg_temp.err(format($$insert into payments.lender_payment_configs (lender_org_id, provider, provider_mode, merchant_registry_id, settlement_account_id, secret_ref, webhook_secret_ref, endpoint_token_hash, idempotency_key, drafted_by)
  values ('f6b00000-0000-4000-8000-000000000001', 'sample_provider', 'production', %L, %L, 'SAMPLE_A', 'SAMPLE_B', %L, 'direct-key-000000000003', %L)$$, pg_temp.got('mfee'), pg_temp.sa(1), pg_temp.token('d3'), pg_temp.u(8))), '23503|',
  'composite key: Udofin''s fee merchant can NEVER be referenced by a lender configuration');
select is(pg_temp.err(format($$insert into payments.lender_payment_configs (lender_org_id, provider, provider_mode, merchant_registry_id, settlement_account_id, secret_ref, webhook_secret_ref, endpoint_token_hash, idempotency_key, drafted_by)
  values ('f6b00000-0000-4000-8000-000000000001', 'sample_provider', 'production', %L, %L, 'a_real_looking_secret_value', 'SAMPLE_B', %L, 'direct-key-000000000004', %L)$$, pg_temp.got('mx1'), pg_temp.sa(1), pg_temp.token('d4'), pg_temp.u(8))), '23514|',
  'a lower-case string cannot be stored as a secret reference (check)');
select is(pg_temp.err(format($$insert into payments.lender_payment_configs (lender_org_id, provider, provider_mode, merchant_registry_id, settlement_account_id, secret_ref, webhook_secret_ref, endpoint_token_hash, rail_limits, idempotency_key, drafted_by)
  values ('f6b00000-0000-4000-8000-000000000001', 'sample_provider', 'production', %L, %L, 'SAMPLE_A', 'SAMPLE_B', %L, '{"upi":{"max":1.5}}', 'direct-key-000000000005', %L)$$, pg_temp.got('mx1'), pg_temp.sa(1), pg_temp.token('d5'), pg_temp.u(8))), '23514|',
  'a fractional rail limit is refused by a check for every writer');
select is(pg_temp.err(format($$insert into payments.lender_payment_configs (lender_org_id, provider, provider_mode, merchant_registry_id, settlement_account_id, secret_ref, webhook_secret_ref, endpoint_token_hash, status, idempotency_key, drafted_by)
  values ('f6b00000-0000-4000-8000-000000000001', 'sample_provider', 'production', %L, %L, 'SAMPLE_A', 'SAMPLE_B', %L, 'active', 'direct-key-000000000006', %L)$$, pg_temp.got('mx1'), pg_temp.sa(1), pg_temp.token('d6'), pg_temp.u(8))), '23514|',
  'a configuration cannot be born active (it starts as a draft)');
-- (3) provider register: evidence and approval.
select pg_temp.as_user(pg_temp.u(8));
select pg_temp.keep('c_noev', pg_temp.draft('f6b00000-0000-4000-8000-000000000001', 'cfg-key-0000000041', provider => 'sample_noevidence', merchant => pg_temp.got('mx3')::uuid, settle => pg_temp.sa(1))::text);
select pg_temp.keep('c_p2', pg_temp.draft('f6b00000-0000-4000-8000-000000000001', 'cfg-key-0000000042', provider => 'sample_provider2', merchant => pg_temp.got('mx4')::uuid, settle => pg_temp.sa(1))::text);
select pg_temp.as_system();
select is(pg_temp.vr(pg_temp.got('c_noev')), 'false:provider_evidence_missing', 'refused: a PRODUCTION configuration at a provider with no authorisation evidence on the register');
select is(pg_temp.vr(pg_temp.got('c_p2')), 'true:', 'the same setup at a provider WITH evidence is valid');
select pg_temp.as_user(pg_temp.u(1));
select payments.set_payment_provider('sample_provider2', 'SAMPLE Provider two', 'payment', 'suspended', 'SAMPLE-AUTH-EVIDENCE-016B', 'likely', 'suspended after a provider incident');
select pg_temp.as_system();
select is(pg_temp.vr(pg_temp.got('c_p2')), 'false:provider_not_approved', 'refused: the provider is suspended on the register');
select pg_temp.as_user(pg_temp.u(1));
select payments.set_payment_provider('sample_provider2', 'SAMPLE Provider two', 'payment', 'approved', 'SAMPLE-AUTH-EVIDENCE-016B', 'likely');
-- (3b) the merchant must be platform-VERIFIED (FC-2): mx7 was claimed by the lender and never verified.
select pg_temp.as_user(pg_temp.u(8));
select pg_temp.keep('mxu', payments.claim_merchant('f6b00000-0000-4000-8000-000000000001', 'sample_provider', 'SAMPLE-MERCHANT-XU')::text);
select pg_temp.keep('c_unvm', pg_temp.draft('f6b00000-0000-4000-8000-000000000001', 'cfg-key-0000000090', merchant => pg_temp.got('mxu')::uuid, settle => pg_temp.sa(1))::text);
select pg_temp.as_system();
select is(pg_temp.vr(pg_temp.got('c_unvm')), 'false:merchant_not_verified', 'refused: a claimed but UNVERIFIED merchant (a lender cannot self-assert a merchant id)');
select pg_temp.as_user(pg_temp.u(9));
select is(pg_temp.err(format($$select payments.submit_payment_config(%L)$$, pg_temp.got('c_unvm'))), '55000|collection_target_invalid', 'and it cannot be submitted for approval');
-- (3c) the provider must be registered for PAYMENTS (FC-3): a mandate-only provider carries no payment authorisation.
select pg_temp.as_user(pg_temp.u(1));
select payments.set_payment_provider('sample_provider2', 'SAMPLE Provider two', 'mandate', 'approved', 'SAMPLE-AUTH-EVIDENCE-016B', 'likely');
select pg_temp.as_system();
select is(pg_temp.vr(pg_temp.got('c_p2')), 'false:provider_kind_not_payment', 'refused: the provider is on the register for mandates only');
select pg_temp.as_user(pg_temp.u(8));
select is(pg_temp.err(format($$select pg_temp.draft('f6b00000-0000-4000-8000-000000000001', 'cfg-key-0000000091', provider => 'sample_provider2', merchant => %L::uuid, settle => %L::uuid)$$, pg_temp.got('mx4'), pg_temp.sa(1))),
  '22023|provider_invalid', 'and a new configuration cannot be drafted at a mandate-only provider');
select pg_temp.as_user(pg_temp.u(1));
select payments.set_payment_provider('sample_provider2', 'SAMPLE Provider two', 'payment_and_mandate', 'approved', 'SAMPLE-AUTH-EVIDENCE-016B', 'likely');
select pg_temp.as_system();
select is(pg_temp.vr(pg_temp.got('c_p2')), 'true:', 'a provider registered for payment_and_mandate satisfies the payment check');
-- (4) mock and sandbox outside the guard.
select pg_temp.as_owner();
select set_config('udofin.allow_mock_providers', 'on', true);
select set_config('udofin.allow_sandbox_providers', 'on', true);
select pg_temp.as_user(pg_temp.u(8));
select pg_temp.keep('c_mock', pg_temp.draft('f6b00000-0000-4000-8000-000000000001', 'cfg-key-0000000043', provider => 'mock_gateway', mode => 'mock', merchant => pg_temp.got('mx2')::uuid, settle => pg_temp.sa(1))::text);
select pg_temp.keep('c_sbx', pg_temp.draft('f6b00000-0000-4000-8000-000000000001', 'cfg-key-0000000044', provider => 'sample_noevidence', mode => 'sandbox', merchant => pg_temp.got('mx3')::uuid, settle => pg_temp.sa(1), token => pg_temp.token('sbx'))::text);
select pg_temp.as_system();
select is(pg_temp.vr(pg_temp.got('c_mock')), 'true:', 'a MOCK configuration is valid while the session allows mocks (tests, local development)');
select is(pg_temp.vr(pg_temp.got('c_sbx')), 'true:', 'and a sandbox configuration while the session allows sandbox');
select pg_temp.as_owner();
select set_config('udofin.allow_mock_providers', 'off', true);
select set_config('udofin.allow_sandbox_providers', 'off', true);
select pg_temp.as_system();
select is(pg_temp.vr(pg_temp.got('c_mock')), 'false:provider_mode_mock_blocked', 'refused: a MOCK configuration where the session does not allow mocks (the database guard)');
select is(pg_temp.vr(pg_temp.got('c_sbx')), 'false:provider_mode_sandbox_blocked', 'refused: a sandbox configuration where sandbox is not allowed');
select pg_temp.as_user(pg_temp.u(9));
select is(pg_temp.err(format($$select payments.submit_payment_config(%L)$$, pg_temp.got('c_mock'))), '55000|collection_target_invalid', 'a mock configuration cannot be submitted where mocks are not allowed');
select pg_temp.as_owner();
select set_config('udofin.allow_mock_providers', 'on', true);
select pg_temp.as_user(pg_temp.u(9));
select payments.submit_payment_config(pg_temp.got('c_mock')::uuid);
select pg_temp.as_user(pg_temp.u(11));
select is(payments.decide_payment_config(pg_temp.got('c_mock')::uuid, true, 'SAMPLE approval of a mock configuration'), 'active', 'with mocks allowed, a MOCK configuration can be approved (for tests only)');
select pg_temp.as_owner();
select set_config('udofin.allow_mock_providers', 'off', true);
select is(pg_temp.err(format($$update payments.lender_payment_configs set provider_mode = 'production' where id = %L$$, pg_temp.got('c_mock'))), 'P0001|', 'the provider mode of a configuration never changes (a mock cannot be relabelled production)');
-- (5) merchant revoked: configurations that use it are put on hold.
select pg_temp.as_user(pg_temp.u(8));
select pg_temp.keep('c_mer', pg_temp.draft('f6b00000-0000-4000-8000-000000000001', 'cfg-key-0000000045', merchant => pg_temp.got('mx6')::uuid, settle => pg_temp.sa(1))::text);
select pg_temp.live(pg_temp.got('c_mer')::uuid, 9, 10);
select is((select status from payments.lender_payment_configs where id = pg_temp.got('c_mer')::uuid), 'active', 'a configuration on merchant 6 is active');
select pg_temp.as_user(pg_temp.u(8));
select is(pg_temp.err(format($$select payments.revoke_merchant(%L, 'the lender no longer uses this merchant')$$, pg_temp.got('mx6'))), '42501|', 'a lender user cannot revoke a merchant');
select pg_temp.as_user(pg_temp.u(3));
select is(pg_temp.err(format($$select payments.revoke_merchant(%L, 'the lender no longer uses this merchant')$$, pg_temp.got('mx6'))), '42501|', 'a verifier cannot revoke a merchant (providers.manage)');
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err(format($$select payments.revoke_merchant(%L, 'short')$$, pg_temp.got('mx6'))), '22023|reason_required', 'revoking needs a reason');
select is(payments.revoke_merchant(pg_temp.got('mx6')::uuid, 'the lender no longer uses this merchant'), 'revoked', 'a platform user revokes the merchant');
select is(payments.revoke_merchant(pg_temp.got('mx6')::uuid, 'the lender no longer uses this merchant'), 'revoked', 'revoking again is idempotent');
select is((select (status, status_reason, status_changed_by = pg_temp.u(1))::text from payments.lender_payment_configs where id = pg_temp.got('c_mer')::uuid), '(suspended,"merchant revoked",t)', 'the configuration that used it was suspended in the same transaction');
select pg_temp.as_system();
select is(pg_temp.vr(pg_temp.got('c_mer')), 'false:merchant_not_active', 'and its validation says merchant_not_active');
select pg_temp.as_owner();
select is(pg_temp.err(format($$update payments.merchant_registry set status = 'active', revoked_by = null, revoked_at = null, revoked_reason = null where id = %L$$, pg_temp.got('mx6'))), 'P0001|', 'a revoked merchant claim is final (and the merchant id stays taken)');
-- Revoked registry entry: configurations settling into it are suspended; validation reads the registry LIVE.
select pg_temp.as_user(pg_temp.u(2));
select pg_temp.keep('reg31', pg_temp.register(31, 'reg-key-000000051', pg_temp.got('rule2')::uuid, masked => 'XXXXXX0031')::text);
select pg_temp.keep('reg32', pg_temp.register(32, 'reg-key-000000052', pg_temp.got('rule2')::uuid, masked => 'XXXXXX0032')::text);
select pg_temp.as_user(pg_temp.u(4));
select payments.verify_account(pg_temp.got('reg31')::uuid, 'SAMPLE-EVIDENCE-031');
select payments.verify_account(pg_temp.got('reg32')::uuid, 'SAMPLE-EVIDENCE-032');
select pg_temp.as_system();
select pg_temp.mk_sa(pg_temp.sa(31), 'f6b00000-0000-4000-8000-000000000001', 'XXXXXX0031');
select pg_temp.mk_sa(pg_temp.sa(32), 'f6b00000-0000-4000-8000-000000000001', 'XXXXXX0032');
select pg_temp.as_user(pg_temp.u(2));
select payments.link_settlement_account(pg_temp.sa(31), pg_temp.got('reg31')::uuid);
select payments.link_settlement_account(pg_temp.sa(32), pg_temp.got('reg32')::uuid);
select pg_temp.as_user(pg_temp.u(8));
select pg_temp.keep('c_rev', pg_temp.draft('f6b00000-0000-4000-8000-000000000001', 'cfg-key-0000000046', merchant => pg_temp.got('mx7')::uuid, settle => pg_temp.sa(31))::text);
select pg_temp.live(pg_temp.got('c_rev')::uuid, 9, 10);
select is((select status from payments.lender_payment_configs where id = pg_temp.got('c_rev')::uuid), 'active', 'a configuration settling into account 31 is active');
select pg_temp.as_user(pg_temp.u(3));
select payments.revoke_account(pg_temp.got('reg31')::uuid, 'ownership changed, entry withdrawn for good');
select pg_temp.as_owner();
select is((select status from payments.lender_payment_configs where id = pg_temp.got('c_rev')::uuid), 'suspended', 'revoking the registry entry SUSPENDED the active configuration in the same transaction');
select is((select (status_reason, status_reasons)::text from payments.lender_payment_configs where id = pg_temp.got('c_rev')::uuid), '("registry entry revoked",{destination_account_revoked})', 'with the reason recorded');
select pg_temp.as_system();
select is(pg_temp.vr(pg_temp.got('c_rev')), 'false:settlement_account_not_verified,destination_account_revoked', 'and validation refuses it (revoked entry, account no longer verified)');
-- Live read, independent of the cascade: with the cascade switched off the cached settlement status stays verified, validation still fails.
select pg_temp.as_owner();
alter table payments.account_registry disable trigger cascade_withdrawal;
select pg_temp.as_user(pg_temp.u(8));
select pg_temp.keep('c_live', pg_temp.draft('f6b00000-0000-4000-8000-000000000001', 'cfg-key-0000000047', provider => 'sample_provider2', merchant => pg_temp.got('mx4')::uuid, settle => pg_temp.sa(32))::text);
select pg_temp.live(pg_temp.got('c_live')::uuid, 9, 10);
select pg_temp.as_user(pg_temp.u(4));
select pg_temp.as_owner();
select payments.revoke_account(pg_temp.got('reg32')::uuid, 'ownership changed, entry withdrawn for good') where false;
select pg_temp.as_user(pg_temp.u(3));
select is(payments.revoke_account(pg_temp.got('reg32')::uuid, 'ownership changed, entry withdrawn for good'), 'revoked', 'the registry entry of account 32 is revoked with the cascade switched off');
select pg_temp.as_owner();
select is((select (s.status::text, c.status)::text from tenancy.lender_settlement_accounts s, payments.lender_payment_configs c where s.id = pg_temp.sa(32) and c.id = pg_temp.got('c_live')::uuid), '(verified,active)',
  'the cached statuses did not move (the settlement account still says verified, the configuration active)');
select pg_temp.as_system();
select is(pg_temp.vr(pg_temp.got('c_live')), 'false:destination_account_revoked', 'but validation READS THE REGISTRY LIVE and refuses the configuration');
select pg_temp.keep('c_live_ok', 'x');
select pg_temp.as_owner();
-- (kept switched off for the intent and feature tests below; switched on again in section 9)

-- Intents (section 8) and feature tests (section 9) run before the cascade is restored.
select pg_temp.keep('cascade_off', 'yes');

-- ============================================================================================================================
-- 8. Payment intents need an ACTIVE, currently valid configuration
-- ============================================================================================================================
select pg_temp.as_system();
create function pg_temp.intent(p_key text, p_cfg text, p_extra text default '', p_provider text default 'sample_provider') returns text language plpgsql as $fn$
begin
  return pg_temp.err(format($q$insert into payments.payment_intents (lender_org_id, loan_account_id, borrower_id, purpose, amount_minor, config_id, provider, idempotency_key %s)
    values ('f6b00000-0000-4000-8000-000000000001', 'f6d20000-0000-4000-8000-000000000001', %L, 'installment', 475000, %s, %L, %L %s)$q$,
    case when p_extra = '' then '' else ', ' || split_part(p_extra, '=', 1) end, pg_temp.got('borrower')::uuid,
    case when p_cfg is null then 'null' else quote_literal(p_cfg) || '::uuid' end, p_provider, p_key,
    case when p_extra = '' then '' else ', ' || split_part(p_extra, '=', 2) end));
end
$fn$;
grant execute on function pg_temp.intent(text, text, text, text) to public;
create function pg_temp.imsg(p_key text, p_cfg text, p_provider text default 'sample_provider') returns text language plpgsql as $fn$
begin
  return pg_temp.msg(format($q$insert into payments.payment_intents (lender_org_id, loan_account_id, borrower_id, purpose, amount_minor, config_id, provider, idempotency_key)
    values ('f6b00000-0000-4000-8000-000000000001', 'f6d20000-0000-4000-8000-000000000001', %L, 'installment', 475000, %s, %L, %L)$q$,
    pg_temp.got('borrower')::uuid, case when p_cfg is null then 'null' else quote_literal(p_cfg) || '::uuid' end, p_provider, p_key));
end
$fn$;
grant execute on function pg_temp.imsg(text, text, text) to public;
select is(pg_temp.intent('intent-key-00000001', null), '55000|collection_target_invalid', 'an intent without a configuration is refused');
select is(pg_temp.imsg('intent-key-00000001', null), 'collection target invalid: config_required', 'with the reason config_required');
select is(pg_temp.intent('intent-key-00000002', pg_temp.got('c1'), 'settlement_account_ref=''alpha-collections'''), '22023|free_text_settlement_ref', 'a free-text settlement account reference is no longer accepted');
select is(pg_temp.imsg('intent-key-00000003', '00000000-0000-4000-8000-000000000000'), 'collection target invalid: config_not_found', 'an unknown configuration is refused');
select pg_temp.as_owner();
select pg_temp.keep('c_other', pg_temp.build('f6b00000-0000-4000-8000-000000000016', 'production', 'sample_provider', 16)::text);
select pg_temp.as_system();
select is(pg_temp.imsg('intent-key-00000004', pg_temp.got('c_other')), 'collection target invalid: config_not_found', 'another lender''s ACTIVE configuration is refused for lender X''s instruction (composite key: not found)');
select is(pg_temp.imsg('intent-key-00000005', pg_temp.got('c_unv')), 'collection target invalid: config_not_active', 'a PENDING configuration is refused (config_not_active)');
select is(pg_temp.imsg('intent-key-00000006', pg_temp.got('c3')), 'collection target invalid: config_not_active', 'a RETIRED configuration is refused');
select is(pg_temp.imsg('intent-key-00000007', pg_temp.got('c_mer')), 'collection target invalid: config_not_active', 'a SUSPENDED configuration is refused');
select is(pg_temp.imsg('intent-key-00000008', pg_temp.got('c_noev')), 'collection target invalid: config_not_active', 'a DRAFT configuration is refused');
select is(pg_temp.intent('intent-key-00000009', pg_temp.got('c1'), '', 'other_provider'), '55000|provider_mismatch', 'the intent''s provider must be the configuration''s');
select is(pg_temp.intent('intent-key-00000010', pg_temp.got('c1'), 'settlement_account_id=''' || pg_temp.sa(8) || ''''), '23503|settlement_account_mismatch', 'the intent''s settlement account must be the configuration''s (another account is refused)');
select is(pg_temp.intent('intent-key-00000011', pg_temp.got('c1'), 'provider_mode=''mock'''), '55000|provider_mismatch', 'and so must its provider mode');
select is(pg_temp.intent('intent-key-00000012', pg_temp.got('c1')), 'ok', 'an active, valid configuration: the intent is created');
select is((select (config_id = pg_temp.got('c1')::uuid, provider_mode::text, settlement_account_id = pg_temp.sa(1), settlement_account_ref is null, provider)::text from payments.payment_intents where idempotency_key = 'intent-key-00000012'),
  '(t,production,t,t,sample_provider)', 'it carries the configuration, the provider mode and the verified settlement account; the free-text reference is null');
select is(pg_temp.intent('intent-key-00000013', pg_temp.got('c1'), 'settlement_account_ref=''via_payment_config'''), 'ok', 'the fixed marker is accepted for the free-text column');
select is(pg_temp.intent('intent-key-00000013', pg_temp.got('c1')), '23505|', 'idempotency still holds');
select is(pg_temp.err(format($$update payments.payment_intents set config_id = %L where idempotency_key = 'intent-key-00000012'$$, pg_temp.got('c_p2'))), 'P0001|', 'the configuration of an intent is immutable');
select is(pg_temp.err($$update payments.payment_intents set provider_mode = 'mock' where idempotency_key = 'intent-key-00000012'$$), 'P0001|', 'and so is its provider mode');
-- Mock configuration: valid only while mocks are allowed.
select pg_temp.as_owner();
select set_config('udofin.allow_mock_providers', 'on', true);
select pg_temp.as_system();
select is(pg_temp.intent('intent-key-00000014', pg_temp.got('c_mock'), '', 'mock_gateway'), 'ok', 'with mocks allowed, an intent under the mock configuration is created');
select is((select provider_mode::text from payments.payment_intents where idempotency_key = 'intent-key-00000014'), 'mock', 'and is labelled mock');
select pg_temp.as_owner();
select set_config('udofin.allow_mock_providers', 'off', true);
select pg_temp.as_system();
select is(pg_temp.imsg('intent-key-00000015', pg_temp.got('c_mock'), 'mock_gateway'), 'collection target invalid: provider_mode_mock_blocked', 'where mocks are NOT allowed, the same configuration is refused: a mock can never take a payment');
-- Registry revoked while the configuration still says active (cascade switched off above): refused by the live read.
select is(pg_temp.imsg('intent-key-00000016', pg_temp.got('c_live'), 'sample_provider2'), 'collection target invalid: destination_account_revoked', 'revoked registry entry, configuration still marked active: the intent is refused (the registry is read live)');
select pg_temp.as_owner();
alter table payments.account_registry enable trigger cascade_withdrawal;
-- Revoke through the normal path (cascade on): the configuration is on hold, so new intents are refused.
select pg_temp.as_system();
select is(pg_temp.imsg('intent-key-00000017', pg_temp.got('c_rev')), 'collection target invalid: config_not_active', 'after the normal revocation (configuration suspended) new intents are refused');
-- Platform kill switch and its effect.
select pg_temp.as_user(pg_temp.u(8));
select is(pg_temp.err(format($$select payments.suspend_payment_config(%L, 'lender users must not use the kill switch')$$, pg_temp.got('c_p2'))), '42501|', 'a lender user cannot use the platform kill switch');
select pg_temp.as_user(pg_temp.u(3));
select is(pg_temp.err(format($$select payments.suspend_payment_config(%L, 'a verifier must not use the kill switch')$$, pg_temp.got('c_p2'))), '42501|', 'neither can a platform verifier (providers.manage is needed)');
select pg_temp.as_user(pg_temp.u(1), 'aal1');
select is(pg_temp.err(format($$select payments.suspend_payment_config(%L, 'the kill switch needs a second factor')$$, pg_temp.got('c1'))), '42501|mfa_required', 'the kill switch needs a second factor');
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err(format($$select payments.suspend_payment_config(%L, 'short')$$, pg_temp.got('c1'))), '22023|reason_required', 'it needs a reason');
select is(pg_temp.err(format($$select payments.suspend_payment_config(%L, 'cannot suspend a draft configuration')$$, pg_temp.got('c_noev'))), '55000|config_state_invalid', 'only an active configuration can be suspended');
select is(pg_temp.err($$select payments.suspend_payment_config('00000000-0000-4000-8000-000000000000', 'an unknown configuration here')$$), 'P0002|', 'an unknown configuration is not found');
select pg_temp.as_owner();
-- c1 is needed later: use the mock configuration as the kill-switch target.
select pg_temp.as_user(pg_temp.u(1));
select is(payments.suspend_payment_config(pg_temp.got('c_mock')::uuid, 'provider incident under investigation today'), 'suspended', 'one platform user (providers.manage) suspends an active configuration at once');
select is(payments.suspend_payment_config(pg_temp.got('c_mock')::uuid, 'provider incident under investigation today'), 'suspended', 'suspending again is idempotent');
select is((select (status, status_reason, status_reasons)::text from payments.lender_payment_configs where id = pg_temp.got('c_mock')::uuid), '(suspended,"provider incident under investigation today",{platform_suspension})', 'reason recorded');
select is((select (event_kind, actor_kind)::text from payments.lender_payment_config_events where config_id = pg_temp.got('c_mock')::uuid and event_kind = 'suspended'), '(suspended,platform)', 'in the history, by a platform actor');
-- Re-submission after a suspension needs a fresh two-person approval.
select pg_temp.as_owner();
select set_config('udofin.allow_mock_providers', 'on', true);
select pg_temp.as_user(pg_temp.u(9));
select is(payments.submit_payment_config(pg_temp.got('c_mock')::uuid), 'pending_approval', 'a suspended configuration is re-submitted (validated again)');
select is((select (status, approved_by is null, approved_at is null)::text from payments.lender_payment_configs where id = pg_temp.got('c_mock')::uuid), '(pending_approval,t,t)', 'the earlier approval is cleared: it needs approving again');
select pg_temp.as_user(pg_temp.u(10));
select is(payments.decide_payment_config(pg_temp.got('c_mock')::uuid, true), 'active', 'and is approved again by an approver');
select is((select array_agg(event_kind order by occurred_at) from payments.lender_payment_config_events where config_id = pg_temp.got('c_mock')::uuid),
  array['drafted', 'submitted', 'approved', 'suspended', 'submitted', 'approved'], 'the whole life of the configuration is in its history');
select pg_temp.as_owner();
select set_config('udofin.allow_mock_providers', 'off', true);
-- Retire.
select pg_temp.as_user(pg_temp.u(8));
select is(pg_temp.err(format($$select payments.retire_payment_config(%L, 'a configure holder must not retire it')$$, pg_temp.got('c_mock'))), 'P0002|', 'a configure-only user cannot retire an active configuration');
select pg_temp.as_user(pg_temp.u(12));
select is(pg_temp.err(format($$select payments.retire_payment_config(%L, 'another lender must not retire it')$$, pg_temp.got('c_mock'))), 'P0002|', 'another lender cannot');
select pg_temp.as_user(pg_temp.u(11));
select is(pg_temp.err(format($$select payments.retire_payment_config(%L, 'short')$$, pg_temp.got('c_mock'))), '22023|reason_required', 'retiring needs a reason');
select is(payments.retire_payment_config(pg_temp.got('c_mock')::uuid, 'the mock configuration is no longer needed'), 'retired', 'the lender''s approver retires an active configuration');
select is(pg_temp.err(format($$select payments.retire_payment_config(%L, 'a draft is withdrawn, not retired')$$, pg_temp.got('c_noev'))), '55000|config_state_invalid', 'a draft is withdrawn, not retired');
-- System functions.
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err(format($$select payments.system_suspend_payment_config(%L, 'merchant_mismatch')$$, pg_temp.got('c_p2'))), '42501|', 'a platform user cannot call the system suspension');
select is(pg_temp.err($$select payments.revalidate_payment_configs()$$), '42501|', 'nor the nightly revalidation');
select pg_temp.as_user(pg_temp.u(8));
select is(pg_temp.err($$select payments.revalidate_payment_configs()$$), '42501|', 'nor can a lender user');
select pg_temp.as_system();
select is(pg_temp.err(format($$select payments.system_suspend_payment_config(%L, 'Bad Code')$$, pg_temp.got('c_p2'))), '22023|reason_required', 'the system must give a stable reason code');
select is(pg_temp.err($$select payments.system_suspend_payment_config('00000000-0000-4000-8000-000000000000', 'merchant_mismatch')$$), 'P0002|', 'an unknown configuration is not found');
select pg_temp.as_user(pg_temp.u(8));
select pg_temp.keep('c_sys', pg_temp.draft('f6b00000-0000-4000-8000-000000000001', 'cfg-key-0000000048', provider => 'sample_provider2', merchant => pg_temp.got('mx4')::uuid, settle => pg_temp.sa(1), token => pg_temp.token('sys'))::text);
select pg_temp.as_system();
select is(payments.system_suspend_payment_config(pg_temp.got('c_sys')::uuid, 'merchant_mismatch'), 'draft', 'a configuration that is not active is not touched');
select pg_temp.as_user(pg_temp.u(9));
select pg_temp.as_user(pg_temp.u(9));
select payments.submit_payment_config(pg_temp.got('c_sys')::uuid);
select pg_temp.as_user(pg_temp.u(10));
select payments.decide_payment_config(pg_temp.got('c_sys')::uuid, true);
select pg_temp.as_system();
select is(payments.system_suspend_payment_config(pg_temp.got('c_sys')::uuid, 'merchant_mismatch'), 'suspended', 'the system puts an active configuration on hold for a reason code (spec 7.1 step 5, provider answered with another merchant)');
select is(payments.system_suspend_payment_config(pg_temp.got('c_sys')::uuid, 'merchant_mismatch'), 'suspended', 'idempotent');
select is((select (status, status_changed_by is null, status_reasons)::text from payments.lender_payment_configs where id = pg_temp.got('c_sys')::uuid), '(suspended,t,{merchant_mismatch})', 'recorded with no user and the reason code');
select pg_temp.as_owner();
select is((select (event_kind, actor_kind, actor_id is null)::text from payments.lender_payment_config_events where config_id = pg_temp.got('c_sys')::uuid and event_kind = 'suspended'), '(suspended,system,t)', 'and the history names the system as the actor');
select pg_temp.as_system();
-- Nightly revalidation: it suspends only what fails.
select pg_temp.as_owner();
select set_config('udofin.allow_mock_providers', 'on', true);
update onboarding.lender_gates set stage = 'suspended' where lender_org_id = 'f6b00000-0000-4000-8000-000000000001';
select pg_temp.as_system();
select is((select count(*) from payments.revalidate_payment_configs('f6b00000-0000-4000-8000-000000000001') where suspended), 2::bigint, 'the nightly run suspends every active configuration that fails validation (the two active ones, once the onboarding gate is gone)');
select is((select count(*) from payments.lender_payment_configs where lender_org_id = 'f6b00000-0000-4000-8000-000000000001' and last_validation_ok is false), 2::bigint, 'and records the failed validation on each');
select is((select count(*) from payments.lender_payment_configs where lender_org_id = 'f6b00000-0000-4000-8000-000000000001' and status = 'active'), 0::bigint, 'with the onboarding gate gone, no configuration of the lender is active any more');
select is((select reasons::text from payments.revalidate_payment_configs('f6b00000-0000-4000-8000-000000000002')), null, 'a lender with nothing active returns nothing');
select pg_temp.as_owner();
update onboarding.lender_gates set stage = 'activated' where lender_org_id = 'f6b00000-0000-4000-8000-000000000001';
select is((select (status_reason, status_reasons)::text from payments.lender_payment_configs where id = pg_temp.got('c1')::uuid), '("system hold: validation failed",{onboarding_gate_not_activated})', 'c1 was put on hold by the nightly run with the reason code');
select is((select (event_kind, actor_kind)::text from payments.lender_payment_config_events where config_id = pg_temp.got('c1')::uuid and event_kind = 'suspended'), '(suspended,system)', 'recorded as a system hold');
select pg_temp.as_user(pg_temp.u(9));
select is(payments.submit_payment_config(pg_temp.got('c1')::uuid), 'pending_approval', 'once the cause is fixed, the configuration is re-submitted ...');
select pg_temp.as_user(pg_temp.u(11));
select is(payments.decide_payment_config(pg_temp.got('c1')::uuid, true, 'SAMPLE re-approval'), 'active', '... and approved again by a different approver');
select pg_temp.as_system();
select is((select count(*) from payments.revalidate_payment_configs('f6b00000-0000-4000-8000-000000000001') where ok), 1::bigint, 'the nightly run leaves a valid configuration alone');
select is((select last_validation_ok from payments.lender_payment_configs where id = pg_temp.got('c1')::uuid), true, 'and records the result');

-- Table protections.
select pg_temp.as_owner();
select is(pg_temp.err(format($$update payments.lender_payment_configs set secret_ref = 'OTHER_SECRET' where id = %L$$, pg_temp.got('c1'))), 'P0001|', 'a configuration''s content cannot be edited after drafting');
select is(pg_temp.err(format($$update payments.lender_payment_configs set status = 'active' where id = %L$$, pg_temp.got('c_noev'))), 'P0001|', 'a draft cannot jump to active');
select is(pg_temp.err(format($$update payments.lender_payment_configs set status = 'draft' where id = %L$$, pg_temp.got('c1'))), 'P0001|', 'an active configuration cannot go back to draft');
select is(pg_temp.err(format($$update payments.lender_payment_configs set status = 'active' where id = %L$$, pg_temp.got('c3'))), 'P0001|', 'a retired configuration is final');
select is(pg_temp.err(format($$delete from payments.lender_payment_configs where id = %L$$, pg_temp.got('c1'))), 'P0001|Record a compensating entry instead.', 'configurations are never deleted');
select is(pg_temp.err(format($$update payments.lender_payment_config_events set note = 'rewritten' where config_id = %L$$, pg_temp.got('c1'))), 'P0001|Record a compensating entry instead.', 'configuration history is append-only');
select is(pg_temp.err(format($$delete from payments.lender_payment_config_events where config_id = %L$$, pg_temp.got('c1'))), 'P0001|Record a compensating entry instead.', 'and cannot be deleted');
select pg_temp.as_user(pg_temp.u(8));
select is(pg_temp.err(format($$update payments.lender_payment_configs set status = 'active' where id = %L$$, pg_temp.got('c_noev'))), '42501|', 'a lender user cannot update configurations directly');
select is(pg_temp.err(format($$delete from payments.lender_payment_configs where id = %L$$, pg_temp.got('c_noev'))), '42501|', 'nor delete them');
select is(pg_temp.err(format($$insert into payments.lender_payment_config_events (config_id, lender_org_id, event_kind, to_status, actor_kind) values (%L, 'f6b00000-0000-4000-8000-000000000001', 'approved', 'active', 'lender')$$, pg_temp.got('c1'))), '42501|', 'nor forge history');
select pg_temp.as_system();
select is(pg_temp.err(format($$update payments.lender_payment_configs set status = 'active' where id = %L$$, pg_temp.got('c_noev'))), '42501|', 'the system role cannot update configurations (it uses the functions)');
select is(pg_temp.err($$insert into payments.lender_payment_configs (lender_org_id, provider, provider_mode, merchant_registry_id, settlement_account_id, secret_ref, webhook_secret_ref, endpoint_token_hash, idempotency_key, drafted_by)
  select lender_org_id, provider, provider_mode, merchant_registry_id, settlement_account_id, secret_ref, webhook_secret_ref, repeat('c', 64), 'system-key-0000000001', drafted_by from payments.lender_payment_configs limit 1$$), '42501|', 'nor insert one');
select ok((select count(*) > 0 from payments.lender_payment_configs), 'but it can read them (to call the provider and route callbacks)');

-- ============================================================================================================================
-- 9. The `payments` feature needs an ACTIVE PRODUCTION configuration (a mock or sandbox one can never satisfy it)
-- ============================================================================================================================
select pg_temp.as_owner();
-- U: an active lender with no configuration at all.
insert into tenancy.organizations (id, kind, legal_name, display_name, regulator_registration_no, status)
  values ('f6b00000-0000-4000-8000-000000000010', 'lender', 'Upsilon Credit Ltd (test)', 'Upsilon', 'TEST-F6-0010', 'active');
insert into onboarding.lender_gates (lender_org_id, stage) values ('f6b00000-0000-4000-8000-000000000010', 'activated');
select pg_temp.build('f6b00000-0000-4000-8000-000000000011', 'mock', 'mock_gateway', 11);
select pg_temp.build('f6b00000-0000-4000-8000-000000000012', 'sandbox', 'sample_noevidence', 12);
select pg_temp.build('f6b00000-0000-4000-8000-000000000013', 'production', 'sample_provider', 13);
select pg_temp.build('f6b00000-0000-4000-8000-000000000014', 'production', 'sample_provider', 14);
select pg_temp.build('f6b00000-0000-4000-8000-000000000015', 'production', 'sample_provider', 15);
select set_config('udofin.allow_mock_providers', 'off', true);
select set_config('udofin.allow_sandbox_providers', 'off', true);
select pg_temp.as_system();
select is(private.feature_prerequisites_unmet('f6b00000-0000-4000-8000-000000000010', 'payments'), array['evidence_missing', 'payment_config_missing'], 'no configuration at all: payment_config_missing (the earlier checks still run)');
select is(private.feature_prerequisites_unmet('f6b00000-0000-4000-8000-000000000011', 'payments'), array['evidence_missing', 'payment_config_missing', 'payment_config_mock_or_sandbox_only'],
  'an active MOCK configuration never satisfies the gate, and the reason says why');
select is(private.feature_prerequisites_unmet('f6b00000-0000-4000-8000-000000000012', 'payments'), array['evidence_missing', 'payment_config_missing', 'payment_config_mock_or_sandbox_only'],
  'an active SANDBOX configuration never satisfies it either');
select is(private.feature_prerequisites_unmet('f6b00000-0000-4000-8000-000000000013', 'payments'), array['evidence_missing'], 'an active PRODUCTION configuration with a valid target and a verified registry entry leaves only the evidence reason');
select is(private.feature_prerequisites_unmet('f6b00000-0000-4000-8000-000000000003', 'payments'),
  array['evidence_missing', 'lender_organisation_not_active', 'onboarding_gate_not_activated', 'payment_config_missing'], 'the generic checks of the foundation are preserved (an onboarding lender with no gate)');
select ok(not ('payment_config_missing' = any (private.feature_prerequisites_unmet('f6b00000-0000-4000-8000-000000000010', 'reminders'))), 'other features are not held back by the payments check');
select ok('feature_not_enableable' = any (private.feature_prerequisites_unmet('f6b00000-0000-4000-8000-000000000013', 'collections')), 'collections still reports feature_not_enableable (earlier check preserved)');
-- Production configuration that fails: the cascade is off here, so it stays "active".
select pg_temp.as_owner();
alter table payments.account_registry disable trigger cascade_withdrawal;
select pg_temp.as_user(pg_temp.u(3));
select payments.revoke_account((select id from payments.account_registry where fingerprint = pg_temp.fp(214)), 'ownership changed, entry withdrawn for good');
select pg_temp.as_owner();
select is((select status from payments.lender_payment_configs where lender_org_id = 'f6b00000-0000-4000-8000-000000000014'), 'active', 'fixture: the configuration is still marked active (cascade off)');
select pg_temp.as_system();
select is(private.feature_prerequisites_unmet('f6b00000-0000-4000-8000-000000000014', 'payments'), array['evidence_missing', 'payment_config_validation_failed', 'registry_entry_not_verified'],
  'a production configuration whose registry entry is no longer verified: registry_entry_not_verified and payment_config_validation_failed');
select pg_temp.as_owner();
alter table payments.account_registry enable trigger cascade_withdrawal;
-- Production configuration suspended by the platform: nothing left that counts.
select pg_temp.as_user(pg_temp.u(1));
select payments.suspend_payment_config((select id from payments.lender_payment_configs where lender_org_id = 'f6b00000-0000-4000-8000-000000000015'), 'provider incident under investigation today');
select pg_temp.as_system();
select is(private.feature_prerequisites_unmet('f6b00000-0000-4000-8000-000000000015', 'payments'), array['evidence_missing', 'payment_config_missing'], 'a suspended production configuration does not count');
-- End to end through the real functions: lender X (production configuration c1 is active and valid).
select pg_temp.as_user(pg_temp.u(5));
select is(pg_temp.err($$select servicing.request_feature_change('f6b00000-0000-4000-8000-000000000011', 'payments', true, '{"contract_ref":"SAMPLE-MSA-11"}', 'feature-key-0000000011')$$), '55000|prerequisites_unmet',
  'turning payments ON for a lender with only a mock configuration is refused (even if the session allowed mocks)');
select pg_temp.as_owner();
select set_config('udofin.allow_mock_providers', 'on', true);
select set_config('udofin.allow_sandbox_providers', 'on', true);
select pg_temp.as_user(pg_temp.u(5));
select is(pg_temp.err($$select servicing.request_feature_change('f6b00000-0000-4000-8000-000000000012', 'payments', true, '{"contract_ref":"SAMPLE-MSA-12"}', 'feature-key-0000000012')$$), '55000|prerequisites_unmet',
  'and even with mock and sandbox allowed in the session, a sandbox configuration is refused');
select is(pg_temp.msg($$select servicing.request_feature_change('f6b00000-0000-4000-8000-000000000011', 'payments', true, '{"contract_ref":"SAMPLE-MSA-11"}', 'feature-key-0000000011')$$),
  'prerequisites not met: payment_config_missing, payment_config_mock_or_sandbox_only', 'the message names the unmet payment prerequisites');
select pg_temp.as_owner();
select set_config('udofin.allow_mock_providers', 'off', true);
select set_config('udofin.allow_sandbox_providers', 'off', true);
select pg_temp.as_user(pg_temp.u(5));
select pg_temp.keep('freq', servicing.request_feature_change('f6b00000-0000-4000-8000-000000000013', 'payments', true, '{"contract_ref":"SAMPLE-MSA-13"}', 'feature-key-0000000013')::text);
select pg_temp.as_user(pg_temp.u(6));
select is(servicing.decide_feature_change(pg_temp.got('freq')::uuid, true, 'approved on production evidence'), 'applied', 'with an ACTIVE production configuration the two-person switch-on goes through');
select pg_temp.as_system();
select is(private.feature_enabled('f6b00000-0000-4000-8000-000000000013', 'payments'), true, 'and payments is enabled for that lender');
select is(private.feature_enabled('f6b00000-0000-4000-8000-000000000011', 'payments'), false, 'but not for the lender with only a mock configuration');

-- ============================================================================================================================
-- 10. Row level security: cross-tenant, borrower, anon and platform visibility for every new table
-- ============================================================================================================================
create function pg_temp.cnt(t text) returns bigint language plpgsql as $fn$
declare n bigint;
begin
  execute format('select count(*) from %s', t) into n;
  return n;
end
$fn$;
grant execute on function pg_temp.cnt(text) to public;
select pg_temp.as_anon();
select is(pg_temp.err($$select count(*) from payments.account_format_rules$$), '42501|', 'anon: account_format_rules refused');
select is(pg_temp.err($$select count(*) from payments.account_format_rule_events$$), '42501|', 'anon: account_format_rule_events refused');
select is(pg_temp.err($$select count(*) from payments.account_registry$$), '42501|', 'anon: account_registry refused');
select is(pg_temp.err($$select count(*) from payments.account_registry_events$$), '42501|', 'anon: account_registry_events refused');
select is(pg_temp.err($$select count(*) from payments.provider_register$$), '42501|', 'anon: provider_register refused');
select is(pg_temp.err($$select count(*) from payments.merchant_registry$$), '42501|', 'anon: merchant_registry refused');
select is(pg_temp.err($$select count(*) from payments.lender_payment_configs$$), '42501|', 'anon: lender_payment_configs refused');
select is(pg_temp.err($$select count(*) from payments.lender_payment_config_events$$), '42501|', 'anon: lender_payment_config_events refused');
select pg_temp.as_user(pg_temp.u(15));
select is((select pg_temp.cnt('payments.account_format_rules') + pg_temp.cnt('payments.account_format_rule_events') + pg_temp.cnt('payments.account_registry') + pg_temp.cnt('payments.account_registry_events')
                  + pg_temp.cnt('payments.provider_register') + pg_temp.cnt('payments.merchant_registry') + pg_temp.cnt('payments.lender_payment_configs') + pg_temp.cnt('payments.lender_payment_config_events')),
  0::bigint, 'a borrower sees nothing in any of the eight tables');
select pg_temp.as_owner();
select pg_temp.keep('x_m', (select count(*) from payments.merchant_registry where owner_org_id = 'f6b00000-0000-4000-8000-000000000001')::text);
select pg_temp.keep('x_c', (select count(*) from payments.lender_payment_configs where lender_org_id = 'f6b00000-0000-4000-8000-000000000001')::text);
select pg_temp.keep('x_e', (select count(*) from payments.lender_payment_config_events where lender_org_id = 'f6b00000-0000-4000-8000-000000000001')::text);
select pg_temp.keep('t_m', (select count(*) from payments.merchant_registry)::text);
select pg_temp.keep('t_c', (select count(*) from payments.lender_payment_configs)::text);
select pg_temp.keep('t_reg', (select count(*) from payments.account_registry)::text);
select pg_temp.keep('t_rege', (select count(*) from payments.account_registry_events)::text);
select pg_temp.keep('t_rule', (select count(*) from payments.account_format_rules)::text);
select pg_temp.keep('t_rulee', (select count(*) from payments.account_format_rule_events)::text);
select ok(pg_temp.got('x_m')::bigint > 0 and pg_temp.got('x_c')::bigint > 0 and pg_temp.got('x_e')::bigint > 0 and pg_temp.got('t_c')::bigint > pg_temp.got('x_c')::bigint and pg_temp.got('t_m')::bigint > pg_temp.got('x_m')::bigint,
  'the visibility checks below compare with real, non-empty totals (lender X owns some of the rows, other organisations the rest)');
select pg_temp.as_user(pg_temp.u(8));
select is((select pg_temp.cnt('payments.account_format_rules') + pg_temp.cnt('payments.account_format_rule_events') + pg_temp.cnt('payments.account_registry') + pg_temp.cnt('payments.account_registry_events')), 0::bigint,
  'lender X staff (even with payment.configure) see nothing of the rules and the registry');
select ok(pg_temp.cnt('payments.merchant_registry') = pg_temp.got('x_m')::bigint and pg_temp.cnt('payments.lender_payment_configs') = pg_temp.got('x_c')::bigint and pg_temp.cnt('payments.lender_payment_config_events') = pg_temp.got('x_e')::bigint, 'but see exactly their own merchants, configurations and history');
select is((select count(*) from payments.lender_payment_configs where lender_org_id <> 'f6b00000-0000-4000-8000-000000000001'), 0::bigint, 'and no configuration of another lender');
select is((select count(*) from payments.merchant_registry where owner_org_id is distinct from 'f6b00000-0000-4000-8000-000000000001'), 0::bigint, 'no merchant of another lender, and not even Udofin''s fee merchant');
select is((select count(*) from payments.lender_payment_config_events where lender_org_id <> 'f6b00000-0000-4000-8000-000000000001'), 0::bigint, 'and no history of another lender');
select pg_temp.as_user(pg_temp.u(10));
select is(pg_temp.cnt('payments.lender_payment_configs'), pg_temp.got('x_c')::bigint, 'a lender approver sees the lender''s configurations (payment.config.approve), and only those');
select pg_temp.as_user(pg_temp.u(14));
select ok(pg_temp.cnt('payments.lender_payment_configs') = pg_temp.got('x_c')::bigint and pg_temp.cnt('payments.merchant_registry') = pg_temp.got('x_m')::bigint, 'a read-only lender user (payment.read) sees them too');
select pg_temp.as_user(pg_temp.u(12));
select is((select pg_temp.cnt('payments.lender_payment_configs') + pg_temp.cnt('payments.lender_payment_config_events')), 0::bigint, 'lender Y sees none of lender X''s configurations or history');
select is((select count(*) from payments.merchant_registry where owner_org_id = 'f6b00000-0000-4000-8000-000000000001'), 0::bigint, 'nor lender X''s merchants');
select is((select count(*) from payments.merchant_registry), 1::bigint, 'only its own merchant');
select pg_temp.as_user(pg_temp.u(1));
select ok(pg_temp.cnt('payments.account_registry') = pg_temp.got('t_reg')::bigint and pg_temp.cnt('payments.account_registry_events') = pg_temp.got('t_rege')::bigint and pg_temp.cnt('payments.account_format_rules') = pg_temp.got('t_rule')::bigint and pg_temp.cnt('payments.account_format_rule_events') = pg_temp.got('t_rulee')::bigint and pg_temp.got('t_reg')::bigint > 10,
  'a registry manager sees the registry, the rules and their histories');
select ok(pg_temp.cnt('payments.lender_payment_configs') = pg_temp.got('t_c')::bigint and pg_temp.cnt('payments.merchant_registry') = pg_temp.got('t_m')::bigint, 'and, holding providers.manage, every lender''s configurations and merchants');
select pg_temp.as_user(pg_temp.u(3));
select ok(pg_temp.cnt('payments.account_registry') = pg_temp.got('t_reg')::bigint and pg_temp.cnt('payments.account_format_rules') = pg_temp.got('t_rule')::bigint, 'a verifier sees the registry and the rules');
select is((select pg_temp.cnt('payments.lender_payment_configs') + pg_temp.cnt('payments.merchant_registry') + pg_temp.cnt('payments.lender_payment_config_events')), 0::bigint, 'but no lender configuration or merchant (it holds no providers.manage or payment.read)');
select pg_temp.as_user(pg_temp.u(16));
select ok(pg_temp.cnt('payments.lender_payment_configs') = pg_temp.got('t_c')::bigint and pg_temp.cnt('payments.merchant_registry') = pg_temp.got('t_m')::bigint - 1, 'a platform operations agent (payment.read) sees all lenders'' configurations and merchants');
select is((select pg_temp.cnt('payments.account_registry') + pg_temp.cnt('payments.account_format_rules')), 0::bigint, 'but not the registry or the rules');
select pg_temp.as_user(pg_temp.u(7));
select is((select pg_temp.cnt('payments.account_format_rules') + pg_temp.cnt('payments.account_format_rule_events') + pg_temp.cnt('payments.account_registry') + pg_temp.cnt('payments.account_registry_events')
                  + pg_temp.cnt('payments.merchant_registry') + pg_temp.cnt('payments.lender_payment_configs') + pg_temp.cnt('payments.lender_payment_config_events')), 0::bigint,
  'platform staff without a role see none of it');
select pg_temp.as_system();
select is(pg_temp.err($$select count(*) from payments.account_format_rules$$), '42501|', 'the system role cannot read the rules');
select is(pg_temp.err($$select count(*) from payments.account_registry_events$$), '42501|', 'nor the registry history');
select is(pg_temp.err($$select count(*) from payments.lender_payment_config_events$$), '42501|', 'nor the configuration history');
select ok(pg_temp.cnt('payments.merchant_registry') > 0 and pg_temp.cnt('payments.provider_register') > 0, 'but reads merchants and the provider register');
select is(pg_temp.err($$insert into payments.provider_register (provider, display_name, kind) values ('forged_provider', 'forged', 'payment')$$), '42501|', 'and cannot write the provider register');

-- ============================================================================================================================
-- 11. Audit: identifiers and codes only
-- ============================================================================================================================
select pg_temp.as_owner();
select ok((select count(*) from audit.events where action = 'payments.account_registry.registered') >= 5, 'registrations are audited');
select ok((select count(*) from audit.events where action = 'payments.account_registry.verified') >= 3, 'verifications are audited');
select ok((select count(*) from audit.events where action = 'payments.account_registry.revoked') >= 3, 'revocations are audited');
select ok((select count(*) from audit.events where action = 'payments.merchant.verified') >= 7, 'merchant verifications are audited');
select ok((select count(*) from audit.events where action in ('payments.config.drafted', 'payments.config.submitted', 'payments.config.approved', 'payments.config.suspended', 'payments.config.retired', 'payments.config.withdrawn')) >= 15,
  'configuration changes are audited');
select ok((select count(*) from audit.events where action in ('payments.account_format_rule.drafted', 'payments.account_format_rule.submitted', 'payments.account_format_rule.approved', 'payments.account_format_rule.retired')) >= 5, 'rule changes are audited');
select is((select count(*) from audit.events where action like 'payments.%' and (regexp_replace(metadata::text, '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', '', 'g') ~ '[0-9a-f]{64}' or regexp_replace(metadata::text, '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', '', 'g') ~ '[0-9]{9,}')), 0::bigint, 'no audit record of these functions carries a fingerprint (64 hex), a token hash or a long number (identifiers excluded)');
select is((select count(*) from audit.events where action = 'payments.account_registry.registered' and actor_type = 'platform'), (select count(*) from audit.events where action = 'payments.account_registry.registered'), 'registrations are recorded with a platform actor');
select is((select count(*) from audit.events where action = 'payments.config.suspended' and actor_type = 'system'), (select count(*) from audit.events where action = 'payments.config.suspended' and metadata ->> 'by' = 'system'), 'system holds are recorded with a system actor');

select * from finish();
rollback;
