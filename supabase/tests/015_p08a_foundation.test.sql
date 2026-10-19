-- Phase 08a foundation (migration 20261018000908): activation switches (fail closed, two-person, kill switch),
-- mock/sandbox provider guard, new permissions and separation of duties, strict money parser.
-- Synthetic data only. Error codes are reported as SQLSTATE|hint.
begin;
create extension if not exists pgtap with schema extensions;
select plan(221);

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
create function pg_temp.err(q text) returns text language plpgsql as $fn$
declare v_state text; v_hint text;
begin
  execute q;
  return 'ok';
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_hint = pg_exception_hint;
  -- The Supabase image adds 'Grant the required privileges ...' to privilege errors; our own hints are kept.
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
-- Phase 08a: a SAMPLE payment configuration (synthetic provider, merchant, verified registry entry, settlement account and an
-- active mock-mode configuration) so that fixtures can create payment intents, which now require one. Call as the owner.
-- In mock mode the helper switches the mock-provider guard on for this transaction. Identical in 002, 003, 004, 009, 013 and 015; keep in sync.
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

grant execute on all functions in schema pg_temp to public;

-- Fixture -------------------------------------------------------------------------------------------------------------
-- u01 features admin A, u02 features admin B, u03 platform admin without the features permission, u04 lender X viewer,
-- u05 lender Y viewer, u06 borrower, u07 X payments admin, u08 X payments approver, u09 platform payments admin,
-- u10 platform account verifier, u11 lender Z viewer
insert into auth.users (id, phone, raw_app_meta_data)
select ('f8000000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, case when n = 6 then '910000000098' end, '{"actor_type":"staff"}'::jsonb
from generate_series(1, 11) n;

select pg_temp.as_owner();
insert into tenancy.organizations (id, kind, legal_name, display_name, regulator_registration_no, status) values
  ('f8a00000-0000-4000-8000-000000000000', 'platform', 'Udofin Platform (test)', 'Udofin', null, 'active'),
  ('f8b00000-0000-4000-8000-000000000001', 'lender', 'Foundation X Finance (test)', 'Found X', 'TEST-F8-0001', 'active'),
  ('f8b00000-0000-4000-8000-000000000002', 'lender', 'Foundation Y Finance (test)', 'Found Y', 'TEST-F8-0002', 'onboarding'),
  ('f8b00000-0000-4000-8000-000000000003', 'lender', 'Foundation Z Finance (test)', 'Found Z', 'TEST-F8-0003', 'active');
insert into onboarding.lender_gates (lender_org_id, stage) values
  ('f8b00000-0000-4000-8000-000000000001', 'activated'),
  ('f8b00000-0000-4000-8000-000000000002', 'contract_onboarded'),
  ('f8b00000-0000-4000-8000-000000000003', 'activated');
insert into tenancy.memberships (id, org_id, user_id, status) values
  ('f8c10000-0000-4000-8000-000000000001', 'f8a00000-0000-4000-8000-000000000000', 'f8000000-0000-4000-8000-000000000001', 'active'),
  ('f8c10000-0000-4000-8000-000000000002', 'f8a00000-0000-4000-8000-000000000000', 'f8000000-0000-4000-8000-000000000002', 'active'),
  ('f8c10000-0000-4000-8000-000000000003', 'f8a00000-0000-4000-8000-000000000000', 'f8000000-0000-4000-8000-000000000003', 'active'),
  ('f8c10000-0000-4000-8000-000000000004', 'f8b00000-0000-4000-8000-000000000001', 'f8000000-0000-4000-8000-000000000004', 'active'),
  ('f8c10000-0000-4000-8000-000000000005', 'f8b00000-0000-4000-8000-000000000002', 'f8000000-0000-4000-8000-000000000005', 'active'),
  ('f8c10000-0000-4000-8000-000000000007', 'f8b00000-0000-4000-8000-000000000001', 'f8000000-0000-4000-8000-000000000007', 'active'),
  ('f8c10000-0000-4000-8000-000000000008', 'f8b00000-0000-4000-8000-000000000001', 'f8000000-0000-4000-8000-000000000008', 'active'),
  ('f8c10000-0000-4000-8000-000000000009', 'f8a00000-0000-4000-8000-000000000000', 'f8000000-0000-4000-8000-000000000009', 'active'),
  ('f8c10000-0000-4000-8000-000000000010', 'f8a00000-0000-4000-8000-000000000000', 'f8000000-0000-4000-8000-000000000010', 'active'),
  ('f8c10000-0000-4000-8000-000000000011', 'f8b00000-0000-4000-8000-000000000003', 'f8000000-0000-4000-8000-000000000011', 'active');
insert into tenancy.membership_roles (membership_id, role_id)
select m.mid::uuid, r.id from (values
  ('f8c10000-0000-4000-8000-000000000001', 'platform', 'platform_features_admin'),
  ('f8c10000-0000-4000-8000-000000000002', 'platform', 'platform_features_admin'),
  ('f8c10000-0000-4000-8000-000000000003', 'platform', 'platform_admin'),
  ('f8c10000-0000-4000-8000-000000000004', 'lender', 'viewer'),
  ('f8c10000-0000-4000-8000-000000000005', 'lender', 'viewer'),
  ('f8c10000-0000-4000-8000-000000000007', 'lender', 'payments_admin'),
  ('f8c10000-0000-4000-8000-000000000008', 'lender', 'payments_approver'),
  ('f8c10000-0000-4000-8000-000000000009', 'platform', 'platform_payments_admin'),
  ('f8c10000-0000-4000-8000-000000000010', 'platform', 'platform_account_verifier'),
  ('f8c10000-0000-4000-8000-000000000011', 'lender', 'viewer')
) as m (mid, kind, rkey)
join tenancy.roles r on r.org_id is null and r.applies_to = m.kind::tenancy.organization_kind and r.key = m.rkey;

select pg_temp.keep('borrower', (select id::text from auth.users where phone = '910000000098'));

-- The `payments` switch now also needs an ACTIVE PRODUCTION payment configuration (migration 20261018000910; tested in 016):
-- lenders X and Z get a SAMPLE one (production mode, so no mock guard is switched on here). Lender Y is left without.
select pg_temp.as_owner();
select pg_temp.sample_collection_config('f8b00000-0000-4000-8000-000000000001', gen_random_uuid(), 'SAMPLE collections', 'XXXXXX0001', 'sample_provider', 'production');
select pg_temp.sample_collection_config('f8b00000-0000-4000-8000-000000000003', gen_random_uuid(), 'SAMPLE collections', 'XXXXXX0003', 'sample_provider', 'production');

-- ============================================================================================================================
-- 1. Structure, catalogue, grants
-- ============================================================================================================================
select is((select count(*) from servicing.lender_features), 0::bigint, 'the migration seeds no switch for any lender: everything is off by absence');
select is((select count(*) from servicing.feature_catalog), 7::bigint, 'the catalogue names the seven Phase 08 features');
select is((select array_agg(feature order by feature) from servicing.feature_catalog where enableable),
  array['mandates', 'payments', 'reminders', 'servicing_sync', 'statements_noc'], 'exactly the five Phase 08a features are enableable');
select is((select array_agg(feature order by feature) from servicing.feature_catalog where not enableable),
  array['collections', 'dlg'], 'collections and dlg are not enableable');
select is((select count(*) from servicing.feature_catalog where not enableable and locked_reason is not null), 2::bigint, 'each locked feature states why');
select is((select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'servicing' and c.relname in ('feature_catalog', 'feature_change_requests', 'lender_features')
             and c.relrowsecurity and c.relforcerowsecurity), 3::bigint, 'row level security is enabled and forced on the three switch tables');
select is((select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'servicing' and c.relname in ('feature_catalog', 'feature_change_requests', 'lender_features')
             and obj_description(c.oid, 'pg_class') like '%Owner: servicing module.'), 3::bigint, 'each table has a comment naming its owner module');
select ok(obj_description('servicing.lender_features'::regclass, 'pg_class') like '%later owner-approved migration%'
          and obj_description('servicing.feature_catalog'::regclass, 'pg_class') like '%later, owner-approved migration%',
  'the table comments say that only a later owner-approved migration can lift the collections and dlg lock');
select is((select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'servicing' and c.relname in ('feature_catalog', 'feature_change_requests', 'lender_features')
             and t.tgname = 'no_truncate' and not t.tgisinternal), 3::bigint, 'a no_truncate trigger is on each table');
select is(pg_temp.err($$truncate servicing.lender_features$$), 'P0001|', 'TRUNCATE is refused even for the owner (lender_features)');
select is(pg_temp.err($$truncate servicing.feature_change_requests cascade$$), 'P0001|', 'TRUNCATE is refused even for the owner (feature_change_requests)');
select is(pg_temp.err($$truncate servicing.feature_catalog cascade$$), 'P0001|', 'TRUNCATE is refused even for the owner (feature_catalog)');
select has_index('servicing', 'lender_features', 'lender_features_feature', 'the feature foreign key is indexed');
select has_index('servicing', 'lender_features', 'lender_features_last_change', 'the last-change foreign key is indexed');
select has_index('servicing', 'feature_change_requests', 'feature_change_requests_lender', 'the lender foreign key is indexed on requests');
select has_index('servicing', 'feature_change_requests', 'feature_change_requests_feature', 'the feature foreign key is indexed on requests');
select ok((select bool_and(has_table_privilege('authenticated', t, 'select')
                           and not has_table_privilege('authenticated', t, 'insert') and not has_table_privilege('authenticated', t, 'update')
                           and not has_table_privilege('authenticated', t, 'delete') and not has_table_privilege('authenticated', t, 'truncate'))
           from unnest(array['servicing.feature_catalog', 'servicing.feature_change_requests', 'servicing.lender_features']) t),
  'authenticated users can only read the three tables');
select ok((select bool_and(has_table_privilege('service_role', t, 'select')
                           and not has_table_privilege('service_role', t, 'insert') and not has_table_privilege('service_role', t, 'update')
                           and not has_table_privilege('service_role', t, 'delete') and not has_table_privilege('service_role', t, 'truncate'))
           from unnest(array['servicing.feature_catalog', 'servicing.feature_change_requests', 'servicing.lender_features']) t),
  'the system role can only read them: system code can never switch a feature on or forge a request');
select ok((select bool_and(not has_table_privilege('anon', t, 'select') and not has_table_privilege('anon', t, 'insert'))
           from unnest(array['servicing.feature_catalog', 'servicing.feature_change_requests', 'servicing.lender_features']) t),
  'anon has no privilege on the three tables');

-- Catalogue is migration-only ---------------------------------------------------------------------------------------------
select pg_temp.as_user('f8000000-0000-4000-8000-000000000001');
select is(pg_temp.err($$update servicing.feature_catalog set enableable = true where feature = 'collections'$$), '42501|', 'a platform user cannot write the catalogue');
select pg_temp.as_system();
select is(pg_temp.err($$update servicing.feature_catalog set enableable = true where feature = 'dlg'$$), '42501|', 'the system role cannot write the catalogue (no privilege)');
select is(pg_temp.err($$insert into servicing.feature_catalog (feature, enableable, introduced_in, description) values ('extra_feature', true, 'phase_08a', 'an extra feature that must not exist')$$), '42501|', 'nor add to it');
select pg_temp.as_owner();
grant update on servicing.feature_catalog to service_role;
select pg_temp.as_system();
select is(pg_temp.err($$update servicing.feature_catalog set enableable = true where feature = 'collections'$$), '42501|catalog_is_migration_only',
  'even with the privilege granted by mistake, the catalogue trigger refuses every role but the migration role');
select pg_temp.as_owner();
revoke update on servicing.feature_catalog from service_role;
-- Documented bypass: the migration role can change the catalogue (that is what "a later approved migration" does). Reverted at once.
select is(pg_temp.err($$update servicing.feature_catalog set enableable = true, locked_reason = null where feature = 'collections'$$), 'ok', 'the migration role (owner) is the only role that can change the catalogue');
update servicing.feature_catalog set enableable = false, locked_reason = 'Phase 08b is not authorised. Only a later owner-approved migration may change this row.' where feature = 'collections';
select is((select enableable from servicing.feature_catalog where feature = 'collections'), false, 'and the lock is restored for the rest of this test');

-- ============================================================================================================================
-- 2. Fail closed: everything is off, helpers refuse
-- ============================================================================================================================
select pg_temp.as_system();
select is((select count(*) from servicing.feature_catalog c where private.feature_enabled('f8b00000-0000-4000-8000-000000000001', c.feature)), 0::bigint,
  'with no rows every feature reads as disabled');
select is(private.feature_enabled('f8b00000-0000-4000-8000-000000000001', 'no_such_feature'), false, 'an unknown feature reads as disabled');
select is(private.feature_enabled('f8b00000-0000-4000-8000-0000000000ff', 'payments'), false, 'an unknown lender reads as disabled');
select is(pg_temp.err($$select private.require_feature('f8b00000-0000-4000-8000-000000000001', 'payments')$$), '55000|feature_disabled', 'require_feature raises 55000 with the hint feature_disabled');
select is(pg_temp.msg($$select private.require_feature('f8b00000-0000-4000-8000-000000000001', 'payments')$$), 'this feature is not enabled for the lender', 'the message names no person or account');
select pg_temp.as_user('f8000000-0000-4000-8000-000000000004');
select is(pg_temp.err($$select private.feature_enabled('f8b00000-0000-4000-8000-000000000001', 'payments')$$), '42501|', 'a lender user cannot call the feature helpers (no cross-tenant probing)');
select pg_temp.as_anon();
select is(pg_temp.err($$select private.feature_enabled('f8b00000-0000-4000-8000-000000000001', 'payments')$$), '42501|', 'anon cannot call them either');

-- ============================================================================================================================
-- 3. Who may ask, and what is refused before anything is stored
-- ============================================================================================================================
select pg_temp.as_user('f8000000-0000-4000-8000-000000000003');
select is(pg_temp.err($$select servicing.request_feature_change('f8b00000-0000-4000-8000-000000000001', 'payments', true, '{"contract_ref":"SAMPLE-MSA-1"}', 'req-key-0000000001')$$), '42501|',
  'a platform user without platform.features.manage cannot request');
select pg_temp.as_user('f8000000-0000-4000-8000-000000000004');
select is(pg_temp.err($$select servicing.request_feature_change('f8b00000-0000-4000-8000-000000000001', 'payments', true, '{"contract_ref":"SAMPLE-MSA-1"}', 'req-key-0000000002')$$), '42501|',
  'a lender user cannot request, even for their own lender');
select is(pg_temp.err($$select servicing.kill_feature('f8b00000-0000-4000-8000-000000000001', 'payments', 'lender staff must not use this', 'kill-key-0000000001')$$), '42501|', 'nor use the kill switch');
select pg_temp.as_user(pg_temp.got('borrower')::uuid);
select is(pg_temp.err($$select servicing.request_feature_change('f8b00000-0000-4000-8000-000000000001', 'payments', true, '{"contract_ref":"SAMPLE-MSA-1"}', 'req-key-0000000003')$$), '42501|', 'a borrower cannot request');
select pg_temp.as_anon();
select is(pg_temp.err($$select servicing.request_feature_change('f8b00000-0000-4000-8000-000000000001', 'payments', true, '{"contract_ref":"SAMPLE-MSA-1"}', 'req-key-0000000004')$$), '42501|', 'anon cannot request');
select pg_temp.as_user('f8000000-0000-4000-8000-000000000001', 'aal1');
select is(pg_temp.err($$select servicing.request_feature_change('f8b00000-0000-4000-8000-000000000001', 'payments', true, '{"contract_ref":"SAMPLE-MSA-1"}', 'req-key-0000000005')$$), '42501|mfa_required', 'a session without the second factor is refused');
select is(pg_temp.err($$select servicing.kill_feature('f8b00000-0000-4000-8000-000000000001', 'payments', 'the second factor is missing here', 'kill-key-0000000002')$$), '42501|mfa_required', 'also for the kill switch');

select pg_temp.as_user('f8000000-0000-4000-8000-000000000001');
select is(pg_temp.err($$select servicing.request_feature_change('f8b00000-0000-4000-8000-000000000001', 'payments', true, '{}', 'req-key-0000000006')$$), '55000|evidence_missing', 'turning on without evidence is refused');
select is(pg_temp.err($$select servicing.request_feature_change('f8b00000-0000-4000-8000-000000000001', 'payments', true, null, 'req-key-0000000007')$$), '55000|evidence_missing', 'null evidence counts as missing');
select is(pg_temp.err($$select servicing.request_feature_change('f8b00000-0000-4000-8000-000000000001', 'payments', true, '["x"]', 'req-key-0000000008')$$), '22023|evidence_invalid', 'evidence must be an object');
select is(pg_temp.err($$select servicing.request_feature_change('f8b00000-0000-4000-8000-000000000001', 'payments', true, '{"contract":{"ref":"x"}}', 'req-key-0000000009')$$), '22023|evidence_invalid', 'evidence must be flat');
select is(pg_temp.err($$select servicing.request_feature_change('f8b00000-0000-4000-8000-000000000001', 'payments', true, '{"contact":"9000000001"}', 'req-key-0000000010')$$), '22023|evidence_invalid', 'evidence that looks like a phone number is refused');
select is(pg_temp.err($$select servicing.request_feature_change('f8b00000-0000-4000-8000-000000000001', 'payments', true, '{"contact":"someone@example.test"}', 'req-key-0000000011')$$), '22023|evidence_invalid', 'evidence that looks like an e-mail address is refused');
select is(pg_temp.err($$select servicing.request_feature_change('f8b00000-0000-4000-8000-000000000001', 'payments', true, '{"contract_ref":"SAMPLE-MSA-1"}', 'short')$$), '22023|bad_request', 'a short idempotency key is refused');
select is(pg_temp.err($$select servicing.request_feature_change('f8b00000-0000-4000-8000-000000000001', 'unknown_feat', true, '{"contract_ref":"SAMPLE-MSA-1"}', 'req-key-0000000012')$$), '22023|unknown_feature', 'an unknown feature is refused');
select is(pg_temp.err($$select servicing.request_feature_change('f8a00000-0000-4000-8000-000000000000', 'payments', true, '{"contract_ref":"SAMPLE-MSA-1"}', 'req-key-0000000013')$$), 'P0002|', 'a switch can only be requested for a lender organisation');
select is(pg_temp.err($$select servicing.request_feature_change('f8b00000-0000-4000-8000-000000000001', 'payments', false, '{}', 'req-key-0000000014')$$), '22023|reason_required', 'turning off needs a reason');
select is(pg_temp.err($$select servicing.request_feature_change('f8b00000-0000-4000-8000-000000000001', 'payments', false, '{}', 'req-key-0000000015', 'too short')$$), '22023|reason_required', 'a reason must be meaningful');
select is(pg_temp.err($$select servicing.request_feature_change('f8b00000-0000-4000-8000-000000000001', 'payments', true, '{"contract_ref":"SAMPLE-MSA-1"}', 'req-key-0000000310', 'x')$$), '22023|reason_invalid', 'a reason given when turning on must be 10 to 1000 characters (too short)');
select is(pg_temp.err(format($$select servicing.request_feature_change('f8b00000-0000-4000-8000-000000000001', 'payments', true, '{"contract_ref":"SAMPLE-MSA-1"}', 'req-key-0000000311', %L)$$, repeat('r', 1001))), '22023|reason_invalid', 'and too long: a stable hint, not a raw check violation');
select is(pg_temp.err(format($$select servicing.request_feature_change('f8b00000-0000-4000-8000-000000000001', 'payments', false, '{}', 'req-key-0000000312', %L)$$, repeat('r', 1001))), '22023|reason_invalid', 'a too long reason is refused when turning off too');
select is(pg_temp.err($$select servicing.request_feature_change('f8b00000-0000-4000-8000-000000000001', 'payments', false, '{}', 'req-key-0000000016', 'already off, nothing to do')$$), '55000|no_change', 'turning off what is already off is a no-op and is refused');

-- Collections and DLG can never be enabled ------------------------------------------------------------------------------
select is(pg_temp.err($$select servicing.request_feature_change('f8b00000-0000-4000-8000-000000000001', 'collections', true, '{"contract_ref":"SAMPLE-MSA-1"}', 'req-key-0000000017')$$), '55000|feature_not_enableable', 'collections cannot be requested');
select is(pg_temp.err($$select servicing.request_feature_change('f8b00000-0000-4000-8000-000000000001', 'dlg', true, '{"contract_ref":"SAMPLE-MSA-1"}', 'req-key-0000000018')$$), '55000|feature_not_enableable', 'dlg cannot be requested');
select pg_temp.as_system();
select is(pg_temp.err($$insert into servicing.lender_features (lender_org_id, feature, enabled, enabled_by, enabled_at) values ('f8b00000-0000-4000-8000-000000000001', 'collections', true, 'f8000000-0000-4000-8000-000000000001', now())$$), '42501|', 'the system role cannot write a switch (no privilege)');
select pg_temp.as_owner();
select is(pg_temp.err($$insert into servicing.lender_features (lender_org_id, feature, enabled, enabled_by, enabled_at) values ('f8b00000-0000-4000-8000-000000000001', 'collections', true, 'f8000000-0000-4000-8000-000000000001', now())$$), '55000|feature_not_enableable',
  'the owner role cannot switch collections on either: the row trigger consults the catalogue');
select is(pg_temp.err($$insert into servicing.lender_features (lender_org_id, feature, enabled, enabled_by, enabled_at) values ('f8b00000-0000-4000-8000-000000000001', 'dlg', true, 'f8000000-0000-4000-8000-000000000001', now())$$), '55000|feature_not_enableable', 'nor dlg');
-- A forged, already-applied request does not help either.
insert into servicing.feature_change_requests (id, lender_org_id, feature, enable, mode, status, evidence, requested_by, idempotency_key, decided_by, decided_at, applied_at)
values ('f8e00000-0000-4000-8000-000000000001', 'f8b00000-0000-4000-8000-000000000001', 'collections', true, 'two_person', 'applied', '{"contract_ref":"SAMPLE-FORGED-1"}',
        'f8000000-0000-4000-8000-000000000001', 'forged-key-00000001', 'f8000000-0000-4000-8000-000000000002', now(), now());
select is(pg_temp.err($$insert into servicing.lender_features (lender_org_id, feature, enabled, enabled_by, enabled_at, last_change_request_id)
  values ('f8b00000-0000-4000-8000-000000000001', 'collections', true, 'f8000000-0000-4000-8000-000000000002', now(), 'f8e00000-0000-4000-8000-000000000001')$$), '55000|feature_not_enableable',
  'a forged applied request does not lift the lock on collections');
select is(pg_temp.err($$insert into servicing.lender_features (lender_org_id, feature, enabled, enabled_by, enabled_at) values ('f8b00000-0000-4000-8000-000000000001', 'mandates', true, 'f8000000-0000-4000-8000-000000000001', now())$$), '55000|two_person_required',
  'turning an enableable feature on without a request is refused for the owner as well');
select is(pg_temp.err($$insert into servicing.lender_features (lender_org_id, feature, enabled, enabled_by, enabled_at, last_change_request_id)
  values ('f8b00000-0000-4000-8000-000000000001', 'mandates', true, 'f8000000-0000-4000-8000-000000000002', now(), 'f8e00000-0000-4000-8000-000000000001')$$), '55000|two_person_required',
  'a request for another feature cannot be reused');
select is(pg_temp.err($$delete from servicing.feature_change_requests where id = 'f8e00000-0000-4000-8000-000000000001'$$), 'P0001|', 'requests cannot be deleted');
select is(pg_temp.err($$update servicing.feature_change_requests set evidence = '{"contract_ref":"SAMPLE-EDITED-1"}' where id = 'f8e00000-0000-4000-8000-000000000001'$$), 'P0001|', 'a filed request cannot be edited');
select is((select count(*) from servicing.lender_features), 0::bigint, 'none of those attempts left a switch behind');

-- ============================================================================================================================
-- 4. Prerequisites
-- ============================================================================================================================
select pg_temp.as_system();
select is(private.feature_prerequisites_unmet('f8b00000-0000-4000-8000-000000000002', 'payments'),
  array['evidence_missing', 'lender_organisation_not_active', 'onboarding_gate_not_activated', 'own_account_list_not_attested', 'payment_config_missing'],
  'an onboarding lender short of its gate and without evidence, an attested own-account list or a payment configuration has five unmet reasons');
select is(private.feature_prerequisites_unmet('f8b00000-0000-4000-8000-000000000001', 'payments'), array['evidence_missing', 'own_account_list_not_attested'],
  'an active, activated lender with a valid configuration lacks only evidence and the attested own-account list until they are given');
select ok('feature_not_enableable' = any (private.feature_prerequisites_unmet('f8b00000-0000-4000-8000-000000000001', 'collections')), 'collections reports feature_not_enableable');
select ok('feature_unknown' = any (private.feature_prerequisites_unmet('f8b00000-0000-4000-8000-000000000001', 'nope')), 'an unknown feature reports feature_unknown');
select pg_temp.as_user('f8000000-0000-4000-8000-000000000001');
select is(pg_temp.err($$select servicing.request_feature_change('f8b00000-0000-4000-8000-000000000002', 'payments', true, '{"contract_ref":"SAMPLE-MSA-2"}', 'req-key-0000000020')$$), '55000|prerequisites_unmet',
  'a lender that is not active and not past its gate cannot be switched on');
select is(pg_temp.msg($$select servicing.request_feature_change('f8b00000-0000-4000-8000-000000000002', 'payments', true, '{"contract_ref":"SAMPLE-MSA-2"}', 'req-key-0000000020')$$),
  'prerequisites not met: lender_organisation_not_active, onboarding_gate_not_activated, own_account_list_not_attested, payment_config_missing', 'the message lists the unmet reasons (generic ones and the payments configuration), never a value');
select pg_temp.as_owner();
select is((select count(*) from servicing.feature_change_requests where lender_org_id = 'f8b00000-0000-4000-8000-000000000002'), 0::bigint, 'the refused request left nothing behind');

-- ============================================================================================================================
-- 5. The two-person flow
-- ============================================================================================================================
-- The own-account list is attested complete (migration 20261018000924, A17). Written directly here; the function that records it
-- (payments.attest_own_account_list) and its refusals are tested in 028_p08a_fix_accounts.test.sql.
select pg_temp.as_owner();
insert into payments.own_account_attestations (event_kind, key_version, evidence_ref, entries_counted, actor_id)
  values ('attested', 1, 'SAMPLE-OWN-ACCOUNT-LIST', 1, 'f8000000-0000-4000-8000-000000000001');
select pg_temp.as_user('f8000000-0000-4000-8000-000000000001');
select pg_temp.keep('req1', servicing.request_feature_change('f8b00000-0000-4000-8000-000000000001', 'payments', true, '{"contract_ref":"SAMPLE-MSA-1", "provider_evidence":"SAMPLE-DOC-7"}', 'req-key-0000000100')::text);
select is(servicing.request_feature_change('f8b00000-0000-4000-8000-000000000001', 'payments', true, '{"contract_ref":"SAMPLE-MSA-1", "provider_evidence":"SAMPLE-DOC-7"}', 'req-key-0000000100')::text,
  pg_temp.got('req1'), 'replaying the request with the same key returns the same request');
select is(pg_temp.err($$select servicing.request_feature_change('f8b00000-0000-4000-8000-000000000001', 'payments', true, '{"contract_ref":"SAMPLE-OTHER"}', 'req-key-0000000100')$$), '23505|idempotency_conflict', 'the same key with different content is refused');
select is((select count(*) from servicing.feature_change_requests where lender_org_id = 'f8b00000-0000-4000-8000-000000000001' and feature = 'payments'), 1::bigint, 'the replay created no second request');
select is(pg_temp.err($$select servicing.request_feature_change('f8b00000-0000-4000-8000-000000000001', 'payments', true, '{"contract_ref":"SAMPLE-MSA-9"}', 'req-key-0000000101')$$), '23505|pending_request_exists', 'a second pending request for the same switch is refused');
select pg_temp.as_system();
select is(private.feature_enabled('f8b00000-0000-4000-8000-000000000001', 'payments'), false, 'a pending request changes nothing');
select pg_temp.as_user('f8000000-0000-4000-8000-000000000001');
select is((select count(*) from servicing.feature_change_requests), 2::bigint, 'the requester sees their own request (and the forged fixture row, as a features administrator)');
select pg_temp.as_user('f8000000-0000-4000-8000-000000000003');
select is((select count(*) from servicing.feature_change_requests), 0::bigint, 'a platform user without the permission sees no requests');
select pg_temp.as_user('f8000000-0000-4000-8000-000000000004');
select is((select count(*) from servicing.feature_change_requests), 0::bigint, 'a lender user sees no requests');

select pg_temp.as_user('f8000000-0000-4000-8000-000000000001');
select is(pg_temp.err(format($$select servicing.decide_feature_change(%L, true)$$, pg_temp.got('req1'))), '42501|self_approval', 'the requester cannot decide their own request');
select pg_temp.as_user('f8000000-0000-4000-8000-000000000003');
select is(pg_temp.err(format($$select servicing.decide_feature_change(%L, true)$$, pg_temp.got('req1'))), '42501|', 'a platform user without the permission cannot decide');
select pg_temp.as_user('f8000000-0000-4000-8000-000000000004');
select is(pg_temp.err(format($$select servicing.decide_feature_change(%L, true)$$, pg_temp.got('req1'))), '42501|', 'a lender user cannot decide');
select pg_temp.as_anon();
select is(pg_temp.err(format($$select servicing.decide_feature_change(%L, true)$$, pg_temp.got('req1'))), '42501|', 'anon cannot decide');
select pg_temp.as_user('f8000000-0000-4000-8000-000000000002', 'aal1');
select is(pg_temp.err(format($$select servicing.decide_feature_change(%L, true)$$, pg_temp.got('req1'))), '42501|mfa_required', 'a decider without the second factor is refused');
select pg_temp.as_user('f8000000-0000-4000-8000-000000000002');
select is(pg_temp.err(format($$select servicing.decide_feature_change(%L, false)$$, pg_temp.got('req1'))), '22023|reason_required', 'a rejection needs a reason');
select is(pg_temp.err(format($$select servicing.decide_feature_change(%L, true, %L)$$, pg_temp.got('req1'), repeat('n', 1001))), '22023|reason_invalid', 'an approval note over 1000 characters is refused with a stable hint');
select is(pg_temp.err(format($$select servicing.decide_feature_change(%L, false, %L)$$, pg_temp.got('req1'), repeat('n', 1001))), '22023|reason_invalid', 'and so is a rejection note');
select is(pg_temp.err($$select servicing.decide_feature_change('f8e00000-0000-4000-8000-0000000000aa', true)$$), 'P0002|', 'an unknown request is not found');
select is(servicing.decide_feature_change(pg_temp.got('req1')::uuid, true, 'evidence reviewed'), 'applied', 'a different platform user approves and the change is applied');
select pg_temp.as_system();
select is(private.feature_enabled('f8b00000-0000-4000-8000-000000000001', 'payments'), true, 'the feature is now enabled');
select is(pg_temp.err($$select private.require_feature('f8b00000-0000-4000-8000-000000000001', 'payments')$$), 'ok', 'require_feature passes for an enabled feature');
select is((select count(*) from servicing.feature_catalog c where c.feature <> 'payments' and private.feature_enabled('f8b00000-0000-4000-8000-000000000001', c.feature)), 0::bigint, 'no other feature changed');
select is(private.feature_enabled('f8b00000-0000-4000-8000-000000000003', 'payments'), false, 'another lender is unaffected');
select pg_temp.as_owner();
select is((select (enabled, enabled_by, last_change_request_id) from servicing.lender_features where lender_org_id = 'f8b00000-0000-4000-8000-000000000001' and feature = 'payments')::text,
  format('(t,f8000000-0000-4000-8000-000000000002,%s)', pg_temp.got('req1')), 'the switch records who applied it and which request');
select is((select (status, requested_by, decided_by)::text from servicing.feature_change_requests where id = pg_temp.got('req1')::uuid),
  '(applied,f8000000-0000-4000-8000-000000000001,f8000000-0000-4000-8000-000000000002)', 'the request records both people');
select is((select count(*) from audit.events where action like 'servicing.feature_change.%' and tenant_org_id = 'f8b00000-0000-4000-8000-000000000001' and actor_type = 'platform'), 2::bigint,
  'a requested event and an enabled event were written to the audit trail');
select is((select count(*) from audit.events e, jsonb_object_keys(e.metadata) k where e.action like 'servicing.feature_change.%'
           and k not in ('feature', 'enable', 'mode', 'evidence_keys', 'requested_by', 'decided_by', 'pending_requests_cancelled')), 0::bigint,
  'audit metadata holds only feature names, flags and user ids: no evidence values');
select pg_temp.as_user('f8000000-0000-4000-8000-000000000002');
select is(pg_temp.err(format($$select servicing.decide_feature_change(%L, true)$$, pg_temp.got('req1'))), '55000|request_not_pending', 'a decided request cannot be decided again');
select is(pg_temp.err($$select servicing.request_feature_change('f8b00000-0000-4000-8000-000000000001', 'payments', true, '{"contract_ref":"SAMPLE-MSA-1"}', 'req-key-0000000102')$$), '55000|no_change', 'enabling what is already enabled is refused');

-- Direct writes cannot flip an existing switch --------------------------------------------------------------------------
select pg_temp.as_owner();
select is(pg_temp.err(format($$update servicing.lender_features set enabled = false, disabled_by = 'f8000000-0000-4000-8000-000000000001', disabled_at = now(), last_change_request_id = %L
  where lender_org_id = 'f8b00000-0000-4000-8000-000000000001' and feature = 'payments'$$, pg_temp.got('req1'))), '55000|two_person_required',
  'the owner cannot flip a switch with a request that says the opposite');
select is(pg_temp.err($$update servicing.lender_features set enabled = false where lender_org_id = 'f8b00000-0000-4000-8000-000000000001' and feature = 'payments'$$), '55000|two_person_required', 'nor with no request at all');
select is(pg_temp.err($$delete from servicing.lender_features where lender_org_id = 'f8b00000-0000-4000-8000-000000000001' and feature = 'payments'$$), 'P0001|Record a compensating entry instead.', 'switch rows cannot be deleted');
select is(pg_temp.err(format($$update servicing.feature_change_requests set status = 'pending' where id = %L$$, pg_temp.got('req1'))), 'P0001|', 'a decided request is final');

-- Tenant isolation and visibility ---------------------------------------------------------------------------------------
select pg_temp.as_user('f8000000-0000-4000-8000-000000000001');
select pg_temp.keep('reqz', servicing.request_feature_change('f8b00000-0000-4000-8000-000000000003', 'payments', true, '{"contract_ref":"SAMPLE-MSA-3"}', 'req-key-0000000103')::text);
select pg_temp.as_user('f8000000-0000-4000-8000-000000000002');
select is(servicing.decide_feature_change(pg_temp.got('reqz')::uuid, true, null), 'applied', 'lender Z gets its own switch');
select pg_temp.as_user('f8000000-0000-4000-8000-000000000004');
select is((select count(*) from servicing.lender_features), 1::bigint, 'a lender X user sees exactly one switch row');
select is((select count(*) from servicing.lender_features where lender_org_id = 'f8b00000-0000-4000-8000-000000000003'), 0::bigint, 'and none of lender Z''s');
select is((select count(*) from servicing.feature_catalog), 7::bigint, 'staff can read the catalogue');
select pg_temp.as_user('f8000000-0000-4000-8000-000000000011');
select is((select array_agg(lender_org_id) from servicing.lender_features), array['f8b00000-0000-4000-8000-000000000003']::uuid[], 'a lender Z user sees only Z''s switch');
select pg_temp.as_user('f8000000-0000-4000-8000-000000000005');
select is((select count(*) from servicing.lender_features), 0::bigint, 'a lender Y user sees none');
select pg_temp.as_user('f8000000-0000-4000-8000-000000000004');
select is(pg_temp.err($$insert into servicing.lender_features (lender_org_id, feature, enabled) values ('f8b00000-0000-4000-8000-000000000001', 'mandates', false)$$), '42501|', 'a lender cannot write a switch');
select is(pg_temp.err($$update servicing.lender_features set enabled = false where lender_org_id = 'f8b00000-0000-4000-8000-000000000001'$$), '42501|', 'nor change one');
select is(pg_temp.err($$delete from servicing.lender_features where lender_org_id = 'f8b00000-0000-4000-8000-000000000001'$$), '42501|', 'nor delete one');
select is(pg_temp.err($$update servicing.feature_catalog set enableable = true where feature = 'dlg'$$), '42501|', 'nor touch the catalogue');
select pg_temp.as_user(pg_temp.got('borrower')::uuid);
select is((select count(*) from servicing.lender_features), 0::bigint, 'a borrower sees no switch rows');
select is((select count(*) from servicing.feature_catalog), 0::bigint, 'nor the catalogue');
select is((select count(*) from servicing.feature_change_requests), 0::bigint, 'nor any request');
select pg_temp.as_anon();
select is(pg_temp.err($$select count(*) from servicing.lender_features$$), '42501|', 'anon cannot read switch rows');
select pg_temp.as_user('f8000000-0000-4000-8000-000000000001');
select is((select count(*) from servicing.lender_features), 2::bigint, 'a features administrator sees every switch');
select pg_temp.as_system();
select is(pg_temp.err($$update servicing.lender_features set enabled = false$$), '42501|', 'the system role cannot update switches');
select is(pg_temp.err($$delete from servicing.lender_features$$), '42501|', 'nor delete them');
select is(pg_temp.err($$insert into servicing.feature_change_requests (lender_org_id, feature, enable, evidence, requested_by, idempotency_key)
  values ('f8b00000-0000-4000-8000-000000000001', 'mandates', true, '{"a_ref":"x1"}', 'f8000000-0000-4000-8000-000000000001', 'sys-forged-key-0001')$$), '42501|', 'nor forge a request');

-- ============================================================================================================================
-- 6. Fail closed when the lender stops being live, and when the decision meets changed facts
-- ============================================================================================================================
select pg_temp.as_owner();
update tenancy.organizations set status = 'suspended' where id = 'f8b00000-0000-4000-8000-000000000001';
select pg_temp.as_system();
select is(private.feature_enabled('f8b00000-0000-4000-8000-000000000001', 'payments'), false, 'a suspended lender organisation turns every feature off');
select pg_temp.as_owner();
update tenancy.organizations set status = 'active' where id = 'f8b00000-0000-4000-8000-000000000001';
update onboarding.lender_gates set stage = 'suspended', stage_before_suspension = 'activated' where lender_org_id = 'f8b00000-0000-4000-8000-000000000001';
select pg_temp.as_system();
select is(private.feature_enabled('f8b00000-0000-4000-8000-000000000001', 'payments'), false, 'a gate that is no longer activated turns every feature off');
select pg_temp.as_owner();
update onboarding.lender_gates set stage = 'activated', stage_before_suspension = null where lender_org_id = 'f8b00000-0000-4000-8000-000000000001';
update servicing.feature_catalog set enableable = false, locked_reason = 'temporarily locked for this test' where feature = 'payments';
select pg_temp.as_system();
select is(private.feature_enabled('f8b00000-0000-4000-8000-000000000001', 'payments'), false, 'a catalogue that says not enableable overrides a stored switch');
select pg_temp.as_owner();
update servicing.feature_catalog set enableable = true, locked_reason = null where feature = 'payments';
select pg_temp.as_system();
select is(private.feature_enabled('f8b00000-0000-4000-8000-000000000001', 'payments'), true, 'everything restored: enabled again');

-- Fixture (owner, triggers off for these inserts only): the lender already runs servicing_sync and has an approved reminder policy and approved
-- English wording, so the generic request flow below meets the feature-specific prerequisites of reminders and statements_noc.
select pg_temp.as_owner();
set local session_replication_role = replica;
insert into servicing.lender_features (lender_org_id, feature, enabled, evidence, enabled_by, enabled_at)
values ('f8b00000-0000-4000-8000-000000000001', 'servicing_sync', true, '{"lms_ref":"SAMPLE-LMS-1"}', 'f8000000-0000-4000-8000-000000000001', now());
insert into servicing.reminder_policies (lender_org_id, version, status, offsets_days, channels, window_from, window_to, max_per_day, drafted_by, approved_by, approved_at)
values ('f8b00000-0000-4000-8000-000000000001', 1, 'approved', array[-3, 0, 3], array['in_app'], time '09:00', time '18:00', 1,
        'f8000000-0000-4000-8000-000000000001', 'f8000000-0000-4000-8000-000000000002', now());
insert into servicing.reminder_templates (lender_org_id, kind, language, version, status, body, body_sha256, drafted_by, approved_by, approved_at)
select 'f8b00000-0000-4000-8000-000000000001', k.kind, 'en', 1, 'approved', k.body, encode(sha256(convert_to(k.body, 'UTF8')), 'hex'),
       'f8000000-0000-4000-8000-000000000001', 'f8000000-0000-4000-8000-000000000002', now()
from (values ('pre_due', 'Your installment of {{amount}} to {{lender_name}} is due on {{due_date}}.'),
             ('due_day', 'Your installment of {{amount}} to {{lender_name}} is due today, {{due_date}}.'),
             ('overdue', 'Your payment of {{amount}} to {{lender_name}} is overdue. {{penal_text}}')) as k (kind, body);
set local session_replication_role = origin;
select pg_temp.as_user('f8000000-0000-4000-8000-000000000001');
select pg_temp.keep('req_rem', servicing.request_feature_change('f8b00000-0000-4000-8000-000000000001', 'reminders', true, '{"policy_ref":"SAMPLE-POLICY-1"}', 'req-key-0000000200')::text);
select pg_temp.as_owner();
update onboarding.lender_gates set stage = 'suspended', stage_before_suspension = 'activated' where lender_org_id = 'f8b00000-0000-4000-8000-000000000001';
select pg_temp.as_user('f8000000-0000-4000-8000-000000000002');
select is(pg_temp.err(format($$select servicing.decide_feature_change(%L, true)$$, pg_temp.got('req_rem'))), '55000|prerequisites_unmet', 'approval re-checks the prerequisites at decision time');
select is((select status from servicing.feature_change_requests where id = pg_temp.got('req_rem')::uuid), 'pending', 'the request stays pending');
select is(servicing.decide_feature_change(pg_temp.got('req_rem')::uuid, false, 'the lender gate was suspended meanwhile'), 'rejected', 'but it can be rejected with a reason');
select pg_temp.as_owner();
update onboarding.lender_gates set stage = 'activated', stage_before_suspension = null where lender_org_id = 'f8b00000-0000-4000-8000-000000000001';
select is((select (status, decided_by, applied_at is null)::text from servicing.feature_change_requests where id = pg_temp.got('req_rem')::uuid), '(rejected,f8000000-0000-4000-8000-000000000002,t)', 'a rejection applies nothing');

-- A request whose requester lost the permission before the decision is not applied
select pg_temp.as_user('f8000000-0000-4000-8000-000000000001');
select pg_temp.keep('req_lost', servicing.request_feature_change('f8b00000-0000-4000-8000-000000000001', 'reminders', true, '{"rail_ref":"SAMPLE-RAIL-1"}', 'req-key-0000000201')::text);
select pg_temp.as_owner();
delete from tenancy.membership_roles where membership_id = 'f8c10000-0000-4000-8000-000000000001';
select pg_temp.as_user('f8000000-0000-4000-8000-000000000002');
select is(pg_temp.err(format($$select servicing.decide_feature_change(%L, true)$$, pg_temp.got('req_lost'))), '42501|requester_not_entitled', 'a request from someone who no longer holds the permission cannot be approved');
select pg_temp.as_owner();
insert into tenancy.membership_roles (membership_id, role_id)
select 'f8c10000-0000-4000-8000-000000000001', r.id from tenancy.roles r where r.org_id is null and r.applies_to = 'platform' and r.key = 'platform_features_admin';

-- Expiry ------------------------------------------------------------------------------------------------------------------
insert into servicing.feature_change_requests (id, lender_org_id, feature, enable, mode, status, evidence, requested_by, idempotency_key, requested_at, expires_at)
values ('f8e00000-0000-4000-8000-000000000002', 'f8b00000-0000-4000-8000-000000000003', 'servicing_sync', true, 'two_person', 'pending', '{"lms_ref":"SAMPLE-LMS-1"}',
        'f8000000-0000-4000-8000-000000000001', 'expired-key-0000001', now() - interval '9 days', now() - interval '2 days');
select pg_temp.as_user('f8000000-0000-4000-8000-000000000002');
select is(servicing.decide_feature_change('f8e00000-0000-4000-8000-000000000002', true, null), 'expired', 'a request past its expiry is marked expired, not applied');
select is((select status from servicing.feature_change_requests where id = 'f8e00000-0000-4000-8000-000000000002'), 'expired', 'and stays expired');

-- Cancel --------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('f8000000-0000-4000-8000-000000000001');
select pg_temp.keep('req_cancel', servicing.request_feature_change('f8b00000-0000-4000-8000-000000000001', 'statements_noc', true, '{"store_ref":"SAMPLE-STORE-1"}', 'req-key-0000000202')::text);
select pg_temp.as_user('f8000000-0000-4000-8000-000000000002');
select is(pg_temp.err(format($$select servicing.cancel_feature_change(%L)$$, pg_temp.got('req_cancel'))), 'P0002|', 'only the requester can cancel');
select pg_temp.as_user('f8000000-0000-4000-8000-000000000001');
select is(pg_temp.err(format($$select servicing.cancel_feature_change(%L)$$, pg_temp.got('req_cancel'))), 'ok', 'the requester cancels');
select is(pg_temp.err(format($$select servicing.cancel_feature_change(%L)$$, pg_temp.got('req_cancel'))), 'P0002|', 'a cancelled request cannot be cancelled again');
select pg_temp.as_user('f8000000-0000-4000-8000-000000000002');
select is(pg_temp.err(format($$select servicing.decide_feature_change(%L, true)$$, pg_temp.got('req_cancel'))), '55000|request_not_pending', 'nor decided');

-- ============================================================================================================================
-- 7. Turning off: two-person and the emergency kill switch
-- ============================================================================================================================
select pg_temp.as_user('f8000000-0000-4000-8000-000000000002');
select pg_temp.keep('req_off', servicing.request_feature_change('f8b00000-0000-4000-8000-000000000001', 'payments', false, '{}', 'req-key-0000000300', 'planned retirement of the provider')::text);
select pg_temp.as_user('f8000000-0000-4000-8000-000000000001');
select is(servicing.decide_feature_change(pg_temp.got('req_off')::uuid, true, null), 'applied', 'turning off also goes through two people');
select pg_temp.as_system();
select is(private.feature_enabled('f8b00000-0000-4000-8000-000000000001', 'payments'), false, 'and takes effect');
select pg_temp.as_owner();
select is((select (enabled, disabled_by is not null, enabled_by is not null)::text from servicing.lender_features where lender_org_id = 'f8b00000-0000-4000-8000-000000000001' and feature = 'payments'), '(f,t,t)', 'the row keeps who enabled and who disabled it');

-- Enable again (two people), then the kill switch.
select pg_temp.as_user('f8000000-0000-4000-8000-000000000002');
select pg_temp.keep('req_on2', servicing.request_feature_change('f8b00000-0000-4000-8000-000000000001', 'payments', true, '{"contract_ref":"SAMPLE-MSA-1b"}', 'req-key-0000000301')::text);
select pg_temp.as_user('f8000000-0000-4000-8000-000000000001');
select is(servicing.decide_feature_change(pg_temp.got('req_on2')::uuid, true, null), 'applied', 'switched on again by a different pair');
select pg_temp.as_user('f8000000-0000-4000-8000-000000000003');
select is(pg_temp.err($$select servicing.kill_feature('f8b00000-0000-4000-8000-000000000001', 'payments', 'a user without the permission', 'kill-key-0000000010')$$), '42501|', 'the kill switch needs platform.features.manage');
select pg_temp.as_user('f8000000-0000-4000-8000-000000000001');
select is(pg_temp.err($$select servicing.kill_feature('f8b00000-0000-4000-8000-000000000001', 'payments', 'short', 'kill-key-0000000011')$$), '22023|reason_required', 'the kill switch needs a reason');
select is(pg_temp.err($$select servicing.kill_feature('f8b00000-0000-4000-8000-000000000001', 'payments', null, 'kill-key-0000000012')$$), '22023|reason_required', 'null reason is refused');
select is(pg_temp.err(format($$select servicing.kill_feature('f8b00000-0000-4000-8000-000000000001', 'payments', %L, 'kill-key-0000000312')$$, repeat('r', 1001))), '22023|reason_invalid', 'a kill switch reason over 1000 characters is refused with a stable hint');
select is(pg_temp.err($$select servicing.kill_feature('f8b00000-0000-4000-8000-000000000001', 'nothing_here', 'a long enough reason here', 'kill-key-0000000013')$$), '22023|unknown_feature', 'unknown feature');
select is(pg_temp.err($$select servicing.kill_feature('f8b00000-0000-4000-8000-000000000001', 'payments', 'a long enough reason here', 'k')$$), '22023|bad_request', 'idempotency key required');
-- A pending enable request for the same switch must not survive a kill.
select pg_temp.as_user('f8000000-0000-4000-8000-000000000002');
select pg_temp.keep('req_pending_off', servicing.request_feature_change('f8b00000-0000-4000-8000-000000000001', 'payments', false, '{}', 'req-key-0000000302', 'a normal two-person disable')::text);
select pg_temp.as_user('f8000000-0000-4000-8000-000000000001');
select pg_temp.keep('kill1', servicing.kill_feature('f8b00000-0000-4000-8000-000000000001', 'payments', 'provider incident under investigation', 'kill-key-0000000014')::text);
select pg_temp.as_system();
select is(private.feature_enabled('f8b00000-0000-4000-8000-000000000001', 'payments'), false, 'one person turned it off at once');
select pg_temp.as_owner();
select is((select (mode, status, enable, decided_by is null, reason)::text from servicing.feature_change_requests where id = pg_temp.got('kill1')::uuid),
  '(emergency,applied,f,t,"provider incident under investigation")', 'the kill is recorded as an emergency request with its reason');
select is((select status from servicing.feature_change_requests where id = pg_temp.got('req_pending_off')::uuid), 'cancelled', 'a pending request for the same switch was cancelled so it cannot undo the kill');
select is((select count(*) from audit.events where action = 'servicing.feature_change.emergency_disabled' and entity_id = pg_temp.got('kill1')), 1::bigint, 'the kill is in the audit trail');
select pg_temp.as_user('f8000000-0000-4000-8000-000000000001');
select is(servicing.kill_feature('f8b00000-0000-4000-8000-000000000001', 'payments', 'provider incident under investigation', 'kill-key-0000000014')::text, pg_temp.got('kill1'), 'replay with the same key returns the same record');
select is(pg_temp.err($$select servicing.kill_feature('f8b00000-0000-4000-8000-000000000001', 'mandates', 'provider incident under investigation', 'kill-key-0000000014')$$), '23505|idempotency_conflict', 'the same key for another switch is refused');
select pg_temp.as_owner();
select is(pg_temp.err(format($$update servicing.lender_features set enabled = true, enabled_by = 'f8000000-0000-4000-8000-000000000001', enabled_at = now(), last_change_request_id = %L
  where lender_org_id = 'f8b00000-0000-4000-8000-000000000001' and feature = 'payments'$$, pg_temp.got('kill1'))), '55000|two_person_required', 'the kill record can never be used to turn a feature on');
select pg_temp.as_user('f8000000-0000-4000-8000-000000000002');
select is(pg_temp.err($$select servicing.request_feature_change('f8b00000-0000-4000-8000-000000000001', 'payments', true, '{"contract_ref":"SAMPLE-MSA-1c"}', 'req-key-0000000303')$$), 'ok', 'after a kill, turning on needs a fresh request');
select pg_temp.as_user('f8000000-0000-4000-8000-000000000001');
select is(pg_temp.err($$select servicing.kill_feature('f8b00000-0000-4000-8000-000000000003', 'dlg', 'precautionary kill of a locked feature', 'kill-key-0000000015')$$), 'ok', 'the kill switch works on any feature, even a locked one');

-- ============================================================================================================================
-- 8. Provider mode and the mock/sandbox guard
-- ============================================================================================================================
select pg_temp.as_owner();
select set_config('udofin.allow_mock_providers', '', true);
select set_config('udofin.allow_sandbox_providers', '', true);
select is(private.mock_providers_allowed(), false, 'mock providers are off by default');
select is(private.sandbox_providers_allowed(), false, 'sandbox providers are off by default');
select is(pg_temp.err($$select private.assert_provider_mode_allowed('mock')$$), '42501|mock_provider_blocked', 'mock is blocked');
select is(pg_temp.err($$select private.assert_provider_mode_allowed('sandbox')$$), '42501|sandbox_provider_blocked', 'sandbox is blocked');
select is(pg_temp.err($$select private.assert_provider_mode_allowed('production')$$), 'ok', 'production passes');
select is(pg_temp.err($$select private.assert_provider_mode_allowed(null)$$), '22023|provider_mode_invalid', 'null is invalid');
select is(pg_temp.err($$select private.assert_provider_mode_allowed('live')$$), '22023|provider_mode_invalid', 'an unknown mode is invalid');
select set_config('udofin.allow_mock_providers', 'ON', true);
select is(private.mock_providers_allowed(), false, 'only the exact value on allows mock providers');
select set_config('udofin.allow_mock_providers', 'on', true);
select is(private.mock_providers_allowed(), true, 'on allows mock providers');
select is(pg_temp.err($$select private.assert_provider_mode_allowed('mock')$$), 'ok', 'mock passes when the session allows it');
select is(pg_temp.err($$select private.assert_provider_mode_allowed('sandbox')$$), '42501|sandbox_provider_blocked', 'allowing mock does not allow sandbox');
select set_config('udofin.allow_mock_providers', '', true);
select set_config('udofin.allow_sandbox_providers', 'on', true);
select is(pg_temp.err($$select private.assert_provider_mode_allowed('sandbox')$$), 'ok', 'sandbox passes when the session allows it');
select is(pg_temp.err($$select private.assert_provider_mode_allowed('mock')$$), '42501|mock_provider_blocked', 'allowing sandbox does not allow mock');
select set_config('udofin.allow_mock_providers', 'on', true);
select is((select array_agg(private.provider_mode_satisfies_production_gate(m) order by m) from unnest(array['mock', 'production', 'sandbox']) m), array[false, true, false],
  'with every session setting on, only production satisfies a production gate');
select is(private.provider_mode_satisfies_production_gate(null), false, 'null does not satisfy it either');
select set_config('udofin.allow_mock_providers', '', true);
select set_config('udofin.allow_sandbox_providers', '', true);
select is(private.is_provider_mode('sandbox'), true, 'the vocabulary accepts sandbox');
select is(private.is_provider_mode('live'), false, 'and refuses others');
select is(pg_temp.err($$select 'mock'::private.provider_mode$$), 'ok', 'the domain accepts the three modes');
select is(pg_temp.err($$select 'live'::private.provider_mode$$), '23514|', 'and refuses others');
create temp table pg_temp.guarded (id serial primary key, provider_mode private.provider_mode not null);
create trigger guard before insert or update on pg_temp.guarded for each row execute function private.guard_provider_mode('provider_mode');
select is(pg_temp.err($$insert into pg_temp.guarded (provider_mode) values ('mock')$$), '42501|mock_provider_blocked', 'the generic row trigger refuses a mock row');
select is(pg_temp.err($$insert into pg_temp.guarded (provider_mode) values ('sandbox')$$), '42501|sandbox_provider_blocked', 'and a sandbox row');
select is(pg_temp.err($$insert into pg_temp.guarded (provider_mode) values ('production')$$), 'ok', 'but not a production row');
select set_config('udofin.allow_mock_providers', 'on', true);
select is(pg_temp.err($$insert into pg_temp.guarded (provider_mode) values ('mock')$$), 'ok', 'a session that allows mock can store one (tests)');
select set_config('udofin.allow_mock_providers', '', true);
select is(pg_temp.err($$update pg_temp.guarded set provider_mode = 'mock' where provider_mode = 'production'$$), '42501|mock_provider_blocked', 'and an update to mock is refused again');
select pg_temp.as_user('f8000000-0000-4000-8000-000000000004');
select is(pg_temp.err($$select private.assert_provider_mode_allowed('production')$$), 'ok', 'the guard functions are usable by end-user sessions (they leak nothing)');

-- ============================================================================================================================
-- 9. Permissions, roles and separation of duties
-- ============================================================================================================================
select pg_temp.as_owner();
select is((select count(*) from tenancy.permissions where key in ('payment.configure', 'payment.config.approve', 'payment.reconcile', 'servicing.sync.manage',
  'servicing.manual_entry', 'servicing.document.issue', 'reminder.policy.manage', 'reminder.template.approve', 'platform.payments.providers.manage',
  'platform.accounts.registry.manage', 'platform.accounts.registry.verify', 'platform.features.manage')), 12::bigint, 'all twelve new permissions exist');
select is((select count(*) from tenancy.permissions where key like 'platform.%' and key in ('platform.payments.providers.manage', 'platform.accounts.registry.manage',
  'platform.accounts.registry.verify', 'platform.features.manage') and platform_only and not platform_grantable), 4::bigint, 'the platform-side ones are platform-only and not grantable across lenders');
select is((select count(*) from tenancy.permissions where key in ('payment.configure', 'payment.config.approve', 'payment.reconcile', 'servicing.sync.manage',
  'servicing.manual_entry', 'servicing.document.issue', 'reminder.policy.manage', 'reminder.template.approve') and (platform_only or platform_grantable)), 0::bigint,
  'the lender-side ones are held inside a lender only');
select is((select string_agg(r.applies_to || '.' || r.key || '=' || p.keys, '; ' order by r.applies_to::text, r.key)
           from tenancy.roles r join lateral (select string_agg(rp.permission_key, ',' order by rp.permission_key) keys from tenancy.role_permissions rp where rp.role_id = r.id) p on true
           where r.org_id is null and r.key in ('servicing_operator', 'payments_admin', 'payments_approver', 'reconciler', 'communications_admin', 'communications_approver',
             'platform_payments_admin', 'platform_account_verifier', 'platform_features_admin')),
  'lender.communications_admin=loan.read,reminder.policy.manage; lender.communications_approver=loan.read,reminder.template.approve; lender.payments_admin=payment.configure,payment.read; '
  'lender.payments_approver=payment.config.approve,payment.read; lender.reconciler=payment.read,payment.reconcile; '
  'lender.servicing_operator=loan.read,servicing.document.issue,servicing.manual_entry,servicing.sync.manage; platform.platform_account_verifier=platform.accounts.registry.verify; '
  'platform.platform_features_admin=platform.features.manage; platform.platform_payments_admin=platform.accounts.registry.manage,platform.payments.providers.manage',
  'the nine new roles carry exactly the intended permissions');
select is((select count(*) from tenancy.role_permissions rp join tenancy.roles r on r.id = rp.role_id
           where r.key in ('lender_admin', 'platform_admin') and r.org_id is null
             and rp.permission_key in ('payment.configure', 'payment.config.approve', 'platform.accounts.registry.manage', 'platform.accounts.registry.verify', 'platform.features.manage')), 0::bigint,
  'the existing admin roles did not gain the maker-checker permissions');

-- Login level: payment.configure vs payment.config.approve
select is(pg_temp.err($$insert into tenancy.membership_roles (membership_id, role_id)
  select 'f8c10000-0000-4000-8000-000000000007', r.id from tenancy.roles r where r.org_id is null and r.applies_to = 'lender' and r.key = 'payments_approver'$$), '23514|segregation_of_duties',
  'one login cannot hold payment.configure and payment.config.approve');
insert into tenancy.memberships (id, org_id, user_id, status) values
  ('f8c10000-0000-4000-8000-000000000012', 'f8b00000-0000-4000-8000-000000000003', 'f8000000-0000-4000-8000-000000000007', 'active');
select is(pg_temp.err($$insert into tenancy.membership_roles (membership_id, role_id)
  select 'f8c10000-0000-4000-8000-000000000012', r.id from tenancy.roles r where r.org_id is null and r.applies_to = 'lender' and r.key = 'payments_approver'$$), '23514|segregation_of_duties',
  'also across two lenders: the rule is per login');
select is(pg_temp.err($$insert into tenancy.membership_roles (membership_id, role_id)
  select 'f8c10000-0000-4000-8000-000000000008', r.id from tenancy.roles r where r.org_id is null and r.applies_to = 'lender' and r.key = 'reconciler'$$), 'ok',
  'the approver may also reconcile: only the named pairs are segregated');
-- Role level
select is(pg_temp.err($$insert into tenancy.role_permissions (role_id, permission_key)
  select r.id, 'payment.config.approve' from tenancy.roles r where r.org_id is null and r.applies_to = 'lender' and r.key = 'payments_admin'$$), '23514|segregation_of_duties', 'a role cannot carry both (approve added to the drafting role)');
select is(pg_temp.err($$insert into tenancy.role_permissions (role_id, permission_key)
  select r.id, 'payment.configure' from tenancy.roles r where r.org_id is null and r.applies_to = 'lender' and r.key = 'payments_approver'$$), '23514|segregation_of_duties', 'nor the other way round');
-- Role level, when the role already has holders: u08 holds payments_approver and reconciler.
select is(pg_temp.err($$insert into tenancy.role_permissions (role_id, permission_key)
  select r.id, 'payment.configure' from tenancy.roles r where r.org_id is null and r.applies_to = 'lender' and r.key = 'reconciler'$$), '23514|segregation_of_duties',
  'a permission cannot be added to a system role if a login holding that role already holds the other half through another role');
insert into tenancy.roles (id, org_id, applies_to, key, name) values
  ('f8d00000-0000-4000-8000-000000000001', 'f8b00000-0000-4000-8000-000000000001', 'lender', 'custom_payments_reader', 'Custom payments reader (test)'),
  ('f8d00000-0000-4000-8000-000000000002', 'f8b00000-0000-4000-8000-000000000001', 'lender', 'custom_unassigned', 'Custom role without holders (test)');
insert into tenancy.role_permissions (role_id, permission_key) values
  ('f8d00000-0000-4000-8000-000000000001', 'payment.read'),
  ('f8d00000-0000-4000-8000-000000000002', 'payment.read');
insert into tenancy.membership_roles (membership_id, role_id) values ('f8c10000-0000-4000-8000-000000000007', 'f8d00000-0000-4000-8000-000000000001');
select is(pg_temp.err($$insert into tenancy.role_permissions (role_id, permission_key) values ('f8d00000-0000-4000-8000-000000000001', 'payment.config.approve')$$), '23514|segregation_of_duties',
  'and for a custom lender role: u07 drafts configurations and holds it, so it cannot gain the approve permission');
select is(pg_temp.err($$insert into tenancy.role_permissions (role_id, permission_key) values ('f8d00000-0000-4000-8000-000000000002', 'payment.config.approve')$$), 'ok',
  'a role nobody holds can gain it (control: only the real conflict is refused)');
-- Platform pair
select is(pg_temp.err($$insert into tenancy.membership_roles (membership_id, role_id)
  select 'f8c10000-0000-4000-8000-000000000009', r.id from tenancy.roles r where r.org_id is null and r.applies_to = 'platform' and r.key = 'platform_account_verifier'$$), '23514|segregation_of_duties',
  'one login cannot both register and verify an account');
select is(pg_temp.err($$insert into tenancy.membership_roles (membership_id, role_id)
  select 'f8c10000-0000-4000-8000-000000000010', r.id from tenancy.roles r where r.org_id is null and r.applies_to = 'platform' and r.key = 'platform_payments_admin'$$), '23514|segregation_of_duties',
  'nor the verifier register');
select is(pg_temp.err($$insert into tenancy.role_permissions (role_id, permission_key)
  select r.id, 'platform.accounts.registry.verify' from tenancy.roles r where r.org_id is null and r.applies_to = 'platform' and r.key = 'platform_payments_admin'$$), '23514|segregation_of_duties', 'a platform role cannot carry both registry permissions');
select is(pg_temp.err($$insert into tenancy.membership_roles (membership_id, role_id)
  select 'f8c10000-0000-4000-8000-000000000009', r.id from tenancy.roles r where r.org_id is null and r.applies_to = 'platform' and r.key = 'platform_features_admin'$$), 'ok',
  'a payments administrator may also hold the features role: only the named pairs are segregated');
select is(pg_temp.err($$insert into tenancy.role_permissions (role_id, permission_key)
  select r.id, 'platform.accounts.registry.verify' from tenancy.roles r where r.org_id is null and r.applies_to = 'platform' and r.key = 'platform_features_admin'$$), '23514|segregation_of_duties',
  'the same for the platform pair (u09 registers accounts and holds the features role)');
-- The existing rule still works.
select is(pg_temp.err($$insert into tenancy.membership_roles (membership_id, role_id)
  select 'f8c10000-0000-4000-8000-000000000010', r.id from tenancy.roles r where r.org_id is null and r.applies_to = 'platform' and r.key = 'collections_agent'$$), 'ok', 'collections work is unrelated to the new pairs');
select is(pg_temp.err($$insert into tenancy.membership_roles (membership_id, role_id)
  select 'f8c10000-0000-4000-8000-000000000010', r.id from tenancy.roles r where r.org_id is null and r.applies_to = 'platform' and r.key = 'dlg_finance'$$), '23514|',
  'and the collections.work vs dlg.manage rule still holds');

-- Review finding FC-4: the pair triggers above fire on role grants; a membership can also change under roles it already holds.
insert into auth.users (id, raw_app_meta_data) values
  ('f8000000-0000-4000-8000-000000000031', '{"actor_type":"staff"}'), ('f8000000-0000-4000-8000-000000000032', '{"actor_type":"staff"}'),
  ('f8000000-0000-4000-8000-000000000033', '{"actor_type":"staff"}'), ('f8000000-0000-4000-8000-000000000034', '{"actor_type":"staff"}'),
  ('f8000000-0000-4000-8000-000000000035', '{"actor_type":"staff"}');
insert into tenancy.memberships (id, org_id, user_id, status) values
  ('f8c10000-0000-4000-8000-000000000031', 'f8b00000-0000-4000-8000-000000000001', 'f8000000-0000-4000-8000-000000000031', 'active'),
  ('f8c10000-0000-4000-8000-000000000032', 'f8b00000-0000-4000-8000-000000000002', 'f8000000-0000-4000-8000-000000000032', 'active'),
  ('f8c10000-0000-4000-8000-000000000033', 'f8b00000-0000-4000-8000-000000000001', 'f8000000-0000-4000-8000-000000000033', 'active'),
  ('f8c10000-0000-4000-8000-000000000034', 'f8a00000-0000-4000-8000-000000000000', 'f8000000-0000-4000-8000-000000000034', 'active');
insert into tenancy.membership_roles (membership_id, role_id)
select m.mid::uuid, r.id from (values
  ('f8c10000-0000-4000-8000-000000000031', 'lender', 'payments_admin'), ('f8c10000-0000-4000-8000-000000000032', 'lender', 'payments_approver'),
  ('f8c10000-0000-4000-8000-000000000033', 'lender', 'payments_admin'), ('f8c10000-0000-4000-8000-000000000034', 'platform', 'collections_agent')) as m (mid, kind, rkey)
join tenancy.roles r on r.org_id is null and r.applies_to = m.kind::tenancy.organization_kind and r.key = m.rkey;
select is(pg_temp.err($$update tenancy.memberships set user_id = 'f8000000-0000-4000-8000-000000000031' where id = 'f8c10000-0000-4000-8000-000000000032'$$), '23514|segregation_of_duties',
  'a membership cannot be moved to a login that already holds the other half (payment.configure and payment.config.approve)');
select is((select user_id from tenancy.memberships where id = 'f8c10000-0000-4000-8000-000000000032'), 'f8000000-0000-4000-8000-000000000032'::uuid, 'and the move did not happen');
-- A revoked membership holding the other half is brought back: built with the role trigger off, as a historic state.
alter table tenancy.membership_roles disable trigger membership_roles_segregation_payments;
insert into tenancy.memberships (id, org_id, user_id, status) values
  ('f8c10000-0000-4000-8000-000000000035', 'f8b00000-0000-4000-8000-000000000002', 'f8000000-0000-4000-8000-000000000033', 'revoked');
insert into tenancy.membership_roles (membership_id, role_id)
select 'f8c10000-0000-4000-8000-000000000035', r.id from tenancy.roles r where r.org_id is null and r.applies_to = 'lender' and r.key = 'payments_approver';
alter table tenancy.membership_roles enable trigger membership_roles_segregation_payments;
select is(pg_temp.err($$update tenancy.memberships set status = 'active' where id = 'f8c10000-0000-4000-8000-000000000035'$$), '23514|segregation_of_duties',
  'a revoked membership holding the other half cannot be reactivated');
select is(pg_temp.err($$update tenancy.memberships set status = 'invited' where id = 'f8c10000-0000-4000-8000-000000000035'$$), '23514|segregation_of_duties', 'nor invited again');
select is((select status::text from tenancy.memberships where id = 'f8c10000-0000-4000-8000-000000000035'), 'revoked', 'it stays revoked');
select is(pg_temp.err($$update tenancy.memberships set valid_until = now() + interval '30 days' where id = 'f8c10000-0000-4000-8000-000000000035'$$), 'ok', 'changing anything else on a revoked membership is not a segregation question');
select is(pg_temp.err($$insert into tenancy.memberships (org_id, user_id, status) values ('f8b00000-0000-4000-8000-000000000003', 'f8000000-0000-4000-8000-000000000031', 'active')$$), 'ok',
  'a new membership without roles is fine (control: only a real conflict is refused)');

-- ============================================================================================================================
-- 10. Function privileges
-- ============================================================================================================================
select ok((select bool_and(has_function_privilege('authenticated', f, 'execute') and not has_function_privilege('anon', f, 'execute') and not has_function_privilege('service_role', f, 'execute'))
           from unnest(array['servicing.request_feature_change(uuid,text,boolean,jsonb,text,text)', 'servicing.decide_feature_change(uuid,boolean,text)',
                             'servicing.cancel_feature_change(uuid)', 'servicing.kill_feature(uuid,text,text,text)']) f),
  'the switch functions are callable by signed-in users only (the system role has no business changing a switch)');
select ok((select bool_and(has_function_privilege('service_role', f, 'execute') and not has_function_privilege('authenticated', f, 'execute') and not has_function_privilege('anon', f, 'execute'))
           from unnest(array['private.feature_enabled(uuid,text)', 'private.require_feature(uuid,text)', 'private.feature_prerequisites_unmet(uuid,text)']) f),
  'the switch readers are callable by the system role only');
select ok((select bool_and(p.prosecdef and exists (select 1 from unnest(p.proconfig) c where c = 'search_path=""'))
           from pg_proc p where p.oid in ('servicing.request_feature_change(uuid,text,boolean,jsonb,text,text)'::regprocedure, 'servicing.decide_feature_change(uuid,boolean,text)'::regprocedure,
             'servicing.cancel_feature_change(uuid)'::regprocedure, 'servicing.kill_feature(uuid,text,text,text)'::regprocedure, 'private.feature_enabled(uuid,text)'::regprocedure,
             'private.feature_prerequisites_unmet(uuid,text)'::regprocedure, 'private.require_feature(uuid,text)'::regprocedure)),
  'the new definer functions pin an empty search_path');
select ok(obj_description('private.feature_prerequisites_unmet(uuid,text)'::regprocedure, 'pg_proc') like '%PRESERVE every earlier check%',
  'the prerequisites function documents that later migrations must preserve earlier checks');

-- ============================================================================================================================
-- 11. Strict money parser
-- ============================================================================================================================
select pg_temp.as_owner();
create temp table money_valid (input text, minor bigint);
insert into money_valid values
  ('0', 0), ('0.0', 0), ('0.00', 0), ('0.5', 50), ('0.05', 5), ('0.50', 50), ('0.99', 99), ('1', 100), ('1.01', 101), ('9', 900), ('10', 1000),
  ('20.10', 2010), ('100.1', 10010), ('1250', 125000), ('1250.5', 125050), ('1250.50', 125050), ('1250.05', 125005), ('1250.00', 125000),
  ('10000000', 1000000000), ('123456789012', 12345678901200), ('999999999999.99', 99999999999999),
  ('1000000000000', 100000000000000), ('1000000000000.0', 100000000000000), ('1000000000000.00', 100000000000000);
create temp table money_invalid (input text);
insert into money_invalid values
  (null), (''), (' '), (' 1250'), ('1250 '), ('1 250'), (E'1250\n'), (E'\t1250'), (E'1250\r'), (chr(160) || '1250'), ('+1250'), ('-1250'), ('-0'), ('+0'),
  ('1e3'), ('1E3'), ('1e-2'), ('0x10'), ('1,250'), ('1,250.50'), ('1_250'), ('1250.'), ('.5'), ('.'), ('1250.505'), ('1250.500'), ('1250.001'),
  ('00'), ('01'), ('007'), ('00.5'), ('01.50'), ('1250,50'), ('1.2.3'), ('abc'), ('12a'), ('Infinity'), ('NaN'), ('0.5.'),
  ('1000000000000.01'), ('1000000000001'), ('9999999999999999'), ('99999999999999999'),
  (chr(1633) || chr(1634) || chr(1635)), (chr(2407) || chr(2408) || chr(2409)), (chr(65297) || chr(65298) || chr(65299)), ('12' || chr(65297)),
  (chr(8377) || '1250'), ('Rs 1250'), ('1250/-');
select is((select count(*) from money_valid), 24::bigint, 'there are 24 valid vectors');
select is((select count(*) from money_invalid), 50::bigint, 'and 50 invalid vectors (see docs/specs/08a-notes/foundation.md)');
select is((select coalesce(string_agg(input || ' -> ' || coalesce(private.parse_money_minor(input)::text, 'null') || ' (want ' || minor || ')', '; '), '')
           from money_valid where private.parse_money_minor(input) is distinct from minor), '', 'every valid vector parses to the expected paise');
select is((select coalesce(string_agg(coalesce(input, '<null>'), '; '), '') from money_invalid
           where pg_temp.err(format('select private.parse_money_minor(%L)', input)) <> '22023|money_invalid'), '', 'every invalid vector raises 22023 with the hint money_invalid');
select is(pg_temp.err($$select private.parse_money_minor(null)$$), '22023|money_invalid', 'null raises instead of returning null (the function is not STRICT)');
select is((select provolatile::text || '/' || proisstrict::text || '/' || prorettype::regtype::text from pg_proc where oid = 'private.parse_money_minor(text)'::regprocedure), 'i/false/bigint',
  'the parser is immutable, not strict and returns bigint');
select is(pg_temp.msg($$select private.parse_money_minor('12345abc')$$), 'invalid money amount', 'the error message does not echo the input');
select pg_temp.as_system();
select is(private.parse_money_minor('1250.5'), 125050::bigint, 'the system role can use the parser');
select pg_temp.as_user('f8000000-0000-4000-8000-000000000004');
select is(private.parse_money_minor('0.05'), 5::bigint, 'so can signed-in users');

select * from finish();
rollback;
