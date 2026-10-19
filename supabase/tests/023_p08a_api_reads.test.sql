-- Phase 08a: what the borrower apps read (migration 20261018000917) and the vault for provider hand-off links. Every function answers only for the signed-in borrower's
-- own loan, payment or mandate (P0002 otherwise); a lender switch that is off hides the feature; the vault holds only ciphertext and is reachable only through definer
-- functions. Synthetic data only (labelled SAMPLE). Error codes are reported as SQLSTATE|hint.
begin;
create extension if not exists pgtap with schema extensions;
select plan(147);

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
  if v_hint like 'Grant the required privileges%' then v_hint := null; end if;
  return v_state || '|' || coalesce(v_hint, '');
end
$fn$;
create function pg_temp.keep(k text, v text) returns text language sql as $fn$ select set_config('t.' || k, v, true) $fn$;
create function pg_temp.got(k text) returns text language sql as $fn$ select current_setting('t.' || k) $fn$;
create function pg_temp.u(n integer) returns uuid language sql as $fn$ select ('fc000000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid $fn$;
create function pg_temp.sha(k text) returns text language sql as $fn$ select encode(sha256(convert_to('SAMPLE-021-' || k, 'UTF8')), 'hex') $fn$;
create function pg_temp.tok(p_lender uuid) returns text language sql as $fn$ select encode(sha256(convert_to('SAMPLE-TOKEN-' || p_lender::text, 'UTF8')), 'hex') $fn$;
create function pg_temp.lx() returns uuid language sql as $fn$ select 'fcb00000-0000-4000-8000-000000000001'::uuid $fn$;
create function pg_temp.ly() returns uuid language sql as $fn$ select 'fcb00000-0000-4000-8000-000000000002'::uuid $fn$;
create function pg_temp.lid(n integer) returns uuid language sql as $fn$ select ('fc400000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid $fn$;
create function pg_temp.mid(n integer) returns uuid language sql as $fn$ select ('fcd00000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid $fn$;
create function pg_temp.lz() returns uuid language sql as $fn$ select 'fcb00000-0000-4000-8000-000000000003'::uuid $fn$;
create function pg_temp.d() returns date language sql as $fn$ select (now() at time zone 'Asia/Kolkata')::date $fn$;
-- A SAMPLE collection configuration with rail limits (copied from "provider documentation" by a fixture). Call as the owner.
create function pg_temp.sample_config(p_lender uuid, p_settlement uuid, p_masked text, p_provider text, p_kind text, p_rail_limits jsonb) returns uuid language plpgsql as $fn$
declare
  v_tag text := left(md5(p_lender::text), 12);
  u1 uuid := md5(p_lender::text || 'sample-maker')::uuid;
  u2 uuid := md5(p_lender::text || 'sample-checker')::uuid;
  u3 uuid := md5(p_lender::text || 'sample-submitter')::uuid;
  v_rule uuid; v_reg uuid; v_mer uuid; v_cfg uuid;
begin
  perform set_config('udofin.allow_mock_providers', 'on', true);
  insert into auth.users (id, raw_app_meta_data) values (u1, '{"actor_type":"staff"}'), (u2, '{"actor_type":"staff"}'), (u3, '{"actor_type":"staff"}') on conflict (id) do nothing;
  insert into onboarding.lender_gates (lender_org_id, stage) values (p_lender, 'activated') on conflict (lender_org_id) do update set stage = 'activated';
  insert into payments.account_format_rules (country, account_type, version, min_digits, max_digits, ifsc_required, status, evidence_label, source_note, effective_from, drafted_by, submitted_by,
                                             submitted_at, approved_by, approved_at)
    values ('IN', 'sample_fixture', 1, 9, 18, true, 'approved', 'unverified', 'SAMPLE fixture rule, not a real source', date '2026-01-01', u1, u1, now(), u2, now())
    on conflict (country, account_type, version) do nothing;
  select id into v_rule from payments.account_format_rules where country = 'IN' and account_type = 'sample_fixture' and version = 1;
  insert into payments.fingerprint_key_versions (key_version, proposed_by) values (1, u1) on conflict (key_version) do nothing;
  update payments.fingerprint_key_versions set status = 'active', approved_by = u2, approved_at = now() where key_version = 1 and status = 'proposed';
  insert into payments.account_registry (fingerprint, key_version, masked_ref, country, account_type, format_rule_id, format_validated, owner_kind, owner_org_id, legal_owner_name,
                                         permitted_purposes, verification_status, evidence_ref, effective_from, registered_by, idempotency_key, verified_by, verified_at)
    values (encode(sha256(convert_to('SAMPLE-FIXTURE-' || p_lender::text, 'UTF8')), 'hex'), 1, p_masked, 'IN', 'sample_fixture', v_rule, true, 'lender', p_lender,
            'SAMPLE Lender Ltd (fixture)', array['repayment_settlement'], 'verified', 'SAMPLE-EVIDENCE-1', current_date - 30, u1, 'sample-fixture-registry-' || v_tag, u2, now())
    returning id into v_reg;
  insert into tenancy.lender_settlement_accounts (id, lender_org_id, label, bank_name, masked_account_ref, status, registry_id, verified_by, verified_at)
    values (p_settlement, p_lender, 'SAMPLE collections', 'Test Bank', p_masked, 'verified', v_reg, u1, now());
  insert into payments.provider_register (provider, display_name, kind, status, authorisation_evidence_ref)
    values (p_provider, 'SAMPLE provider (fixture)', p_kind, 'approved', 'SAMPLE-AUTH-EVIDENCE-1') on conflict (provider) do nothing;
  insert into payments.merchant_registry (provider, merchant_ref, owner_kind, owner_org_id, purpose, claimed_by, verification_status, verification_evidence_ref, verified_by, verified_at)
    values (p_provider, 'SAMPLE-MERCHANT-' || v_tag, 'lender', p_lender, 'repayment', u1, 'verified', 'SAMPLE-EVIDENCE-3', u2, now()) returning id into v_mer;
  insert into payments.lender_payment_configs (lender_org_id, provider, provider_mode, merchant_registry_id, settlement_account_id, secret_ref, webhook_secret_ref, endpoint_token_hash,
                                               rail_limits, rail_limits_source, evidence_ref, contract_section_ref, idempotency_key, drafted_by)
    values (p_lender, p_provider, 'mock', v_mer, p_settlement, 'SAMPLE_SECRET', 'SAMPLE_WEBHOOK_SECRET', encode(sha256(convert_to('SAMPLE-TOKEN-' || p_lender::text, 'UTF8')), 'hex'),
            p_rail_limits, case when p_rail_limits = '{}'::jsonb then null else 'SAMPLE copy of provider documentation (fixture)' end, 'SAMPLE-EVIDENCE-2', 'SAMPLE-CONTRACT-1',
            'sample-fixture-config-' || v_tag, u1) returning id into v_cfg;
  update payments.lender_payment_configs set status = 'pending_approval', submitted_by = u3, submitted_at = now(), status_changed_by = u3 where id = v_cfg;
  update payments.lender_payment_configs set status = 'active', approved_by = u2, approved_at = now(), status_changed_by = u2 where id = v_cfg;
  return v_cfg;
end
$fn$;

create function pg_temp.stepup(p_borrower text, p_mandate uuid) returns void language sql as $fn$
  insert into identity.stepup_challenges (id, borrower_id, action, context_ref, code_hash, status, delivery_status, expires_at, verified_at, verified_until)
  values (gen_random_uuid(), p_borrower::uuid, 'mandate_creation', p_mandate::text, repeat('a', 64), 'verified', 'accepted', now() + interval '10 minutes', now(), now() + interval '10 minutes')
$fn$;
create function pg_temp.integrity(p_borrower text, p_level text) returns void language sql as $fn$
  insert into identity.device_attestations (borrower_id, level, provider, verified_at, expires_at) values (p_borrower::uuid, p_level, 'sample_attest', clock_timestamp(), clock_timestamp() + interval '1 hour')
$fn$;
-- Helpers specific to this file ------------------------------------------------------------------------------------------------
create function pg_temp.opts(p_fn text, p_loan uuid) returns jsonb language plpgsql as $fn$
declare v jsonb;
begin
  execute format('select %s(%L)', p_fn, p_loan) into v;
  return v;
end
$fn$;
create function pg_temp.cfg(p_lender uuid) returns uuid language sql as $fn$ select id from payments.lender_payment_configs where lender_org_id = p_lender and status = 'active' $fn$;
create function pg_temp.bytes(p_n integer) returns bytea language sql as $fn$ select decode(repeat('ab', p_n), 'hex') $fn$;
grant execute on all functions in schema pg_temp to public;

-- Fixture -----------------------------------------------------------------------------------------------------------------------
-- Users: 01 borrower b1, 02 borrower b2, 03 lender X payments admin (payment.configure, payment.read), 04 lender X reader (payment.read only), 05 lender Y reader,
-- 06 platform payments admin, 07 and 08 switch fixture users, 09 and 10 loan product maker and checker.
insert into auth.users (id, phone, raw_app_meta_data)
select pg_temp.u(n), case when n in (1, 2) then '9100000009' || n end, case when n in (1, 2) then '{}'::jsonb else '{"actor_type":"staff"}'::jsonb end from generate_series(1, 10) n;
select pg_temp.keep('b1', (select id::text from identity.borrowers where user_id = pg_temp.u(1)));
select pg_temp.keep('b2', (select id::text from identity.borrowers where user_id = pg_temp.u(2)));

select pg_temp.as_owner();
select set_config('udofin.allow_mock_providers', 'on', true);
insert into tenancy.organizations (id, kind, legal_name, display_name, regulator_registration_no, status) values
  ('fca00000-0000-4000-8000-000000000000', 'platform', 'Udofin Platform (test)', 'Udofin', null, 'active'),
  (pg_temp.lx(), 'lender', 'Alpha Finance Ltd (test)', 'Alpha', 'TEST-FC-0001', 'active'),
  (pg_temp.ly(), 'lender', 'Beta Capital Ltd (test)', 'Beta', 'TEST-FC-0002', 'active'),
  (pg_temp.lz(), 'lender', 'Gamma Credit Ltd (test)', 'Gamma', 'TEST-FC-0003', 'active');
insert into tenancy.memberships (id, org_id, user_id, status) values
  ('fcc10000-0000-4000-8000-000000000003', pg_temp.lx(), pg_temp.u(3), 'active'),
  ('fcc10000-0000-4000-8000-000000000004', pg_temp.lx(), pg_temp.u(4), 'active'),
  ('fcc10000-0000-4000-8000-000000000005', pg_temp.ly(), pg_temp.u(5), 'active'),
  ('fcc10000-0000-4000-8000-000000000006', 'fca00000-0000-4000-8000-000000000000', pg_temp.u(6), 'active'),
  ('fcc10000-0000-4000-8000-000000000019', pg_temp.lx(), pg_temp.u(9), 'active'),
  ('fcc10000-0000-4000-8000-000000000020', pg_temp.lx(), pg_temp.u(10), 'active'),
  ('fcc10000-0000-4000-8000-000000000021', pg_temp.ly(), pg_temp.u(9), 'active'),
  ('fcc10000-0000-4000-8000-000000000022', pg_temp.ly(), pg_temp.u(10), 'active'),
  ('fcc10000-0000-4000-8000-000000000023', pg_temp.lz(), pg_temp.u(9), 'active'),
  ('fcc10000-0000-4000-8000-000000000024', pg_temp.lz(), pg_temp.u(10), 'active');
insert into tenancy.membership_roles (membership_id, role_id)
select g.mid::uuid, r.id from (values
  ('fcc10000-0000-4000-8000-000000000003', 'lender', 'payments_admin'), ('fcc10000-0000-4000-8000-000000000004', 'lender', 'viewer'), ('fcc10000-0000-4000-8000-000000000005', 'lender', 'viewer'),
  ('fcc10000-0000-4000-8000-000000000006', 'platform', 'platform_payments_admin'),
  ('fcc10000-0000-4000-8000-000000000019', 'lender', 'lender_admin'), ('fcc10000-0000-4000-8000-000000000020', 'lender', 'product_approver'),
  ('fcc10000-0000-4000-8000-000000000021', 'lender', 'lender_admin'), ('fcc10000-0000-4000-8000-000000000022', 'lender', 'product_approver'),
  ('fcc10000-0000-4000-8000-000000000023', 'lender', 'lender_admin'), ('fcc10000-0000-4000-8000-000000000024', 'lender', 'product_approver')) as g (mid, kind, rkey)
join tenancy.roles r on r.org_id is null and r.applies_to = g.kind::tenancy.organization_kind and r.key = g.rkey;
-- Lender X: a provider that offers mandates and both rails configured. Lender Y: a payment-only provider and no rail limits.
select pg_temp.sample_config(pg_temp.lx(), 'fce10000-0000-4000-8000-000000000001', 'XXXXXX1111', 'mock_gateway', 'payment_and_mandate',
  '{"enach_api": {"max_mandate_amount_minor": 5000000, "needs_afa_each_debit": false}, "upi_autopay": {"max_mandate_amount_minor": 1500000, "needs_afa_each_debit": true}}'::jsonb);
select pg_temp.sample_config(pg_temp.ly(), 'fce10000-0000-4000-8000-000000000002', 'XXXXXX2222', 'mock_gateway_pay', 'payment', '{}'::jsonb);
-- Lender Z: the SAME provider as lender X, with only one rail fully configured (UPI AutoPay has no "needs authentication" flag).
select pg_temp.sample_config(pg_temp.lz(), 'fce10000-0000-4000-8000-000000000003', 'XXXXXX3333', 'mock_gateway', 'payment_and_mandate',
  '{"enach_api": {"max_mandate_amount_minor": 5000000}, "upi_autopay": {"max_mandate_amount_minor": 1500000}}'::jsonb);

insert into servicing.feature_change_requests (lender_org_id, feature, enable, mode, status, evidence, requested_by, idempotency_key, decided_by, decided_at, applied_at)
select o.lender, f.feature, true, 'two_person', 'applied', '{"contract_ref":"SAMPLE-FC"}', pg_temp.u(7), 'fc-req-' || f.feature || '-' || right(o.lender::text, 1) || '-0001', pg_temp.u(8), now(), now()
from (values (pg_temp.lx()), (pg_temp.ly()), (pg_temp.lz())) o (lender) cross join (values ('servicing_sync'), ('mandates'), ('payments'), ('statements_noc')) f (feature);
insert into servicing.lender_features (lender_org_id, feature, enabled, evidence, enabled_by, enabled_at, last_change_request_id)
select r.lender_org_id, r.feature, true, r.evidence, pg_temp.u(8), now(), r.id from servicing.feature_change_requests r;

-- Loans: 1 (b1, X), 2 (b2, X), 3 (b1, X), 4 (b1, Y).
insert into lending.loan_products (id, lender_org_id, category_key, code, name, status) values
  ('fc900000-0000-4000-8000-000000000001', pg_temp.lx(), 'personal', 'PL-FC', 'X Personal Loan', 'active'),
  ('fc900000-0000-4000-8000-000000000002', pg_temp.ly(), 'personal', 'PL-FC', 'Y Personal Loan', 'active'),
  ('fc900000-0000-4000-8000-000000000003', pg_temp.lz(), 'personal', 'PL-FC', 'Z Personal Loan', 'active');
insert into lending.loan_product_versions (id, product_id, lender_org_id, version, status, min_amount_minor, max_amount_minor, min_tenure_days, max_tenure_days,
  rate_type, min_annual_rate_bps, max_annual_rate_bps, drafted_by, approved_by, approved_at, effective_from)
select ('fc910000-0000-4000-8000-00000000000' || n)::uuid, ('fc900000-0000-4000-8000-00000000000' || n)::uuid, ('fcb00000-0000-4000-8000-00000000000' || n)::uuid, 1, 'approved',
       1000000, 50000000, 180, 1825, 'fixed', 1400, 2400, pg_temp.u(9), pg_temp.u(10), now(), now()
from generate_series(1, 3) n;
insert into lending.loan_requests (id, borrower_id, category_key, requested_amount_minor, requested_tenure_days, purpose_code, status)
select ('fc700000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, case when n = 2 then pg_temp.got('b2')::uuid else pg_temp.got('b1')::uuid end, 'personal', 5000000, 365, 'education', 'submitted'
from generate_series(1, 5) n;
insert into lending.applications (id, lender_org_id, loan_request_id, borrower_id, product_version_id, status, requested_amount_minor, requested_tenure_days, lender_reference)
select ('fc200000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, case n when 4 then pg_temp.ly() when 5 then pg_temp.lz() else pg_temp.lx() end,
       ('fc700000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, case when n = 2 then pg_temp.got('b2')::uuid else pg_temp.got('b1')::uuid end,
       case n when 4 then 'fc910000-0000-4000-8000-000000000002' when 5 then 'fc910000-0000-4000-8000-000000000003' else 'fc910000-0000-4000-8000-000000000001' end::uuid, 'disbursed', 5000000, 365, 'SAMPLE-APP-' || n
from generate_series(1, 5) n;
insert into servicing.loan_accounts (id, lender_org_id, application_id, borrower_id, source_system, lms_loan_ref, status, sanctioned_amount_minor)
select pg_temp.lid(n), a.lender_org_id, a.id, a.borrower_id, 'lender_lms', 'SAMPLE-LN-' || n, 'active', 5000000
from lending.applications a, generate_series(1, 5) n where right(a.id::text, 2)::int = n;
-- The lender-reported figures (fresh): 4,750.00 due in three days. The schedule: installment 1 in three days (4,750.00), 2 in thirty-three days (4,750.00), 3 in sixty-three days (60,000.00 - above any mandate).
insert into servicing.balance_snapshots (lender_org_id, loan_account_id, version, status, outstanding_principal_minor, total_overdue_minor, next_due_on, next_due_minor, days_past_due,
  source_system, source_record_id, reported_as_of, content_sha256)
select l.lender_org_id, l.id, 1, 'active', 4000000, 0, pg_temp.d() + 3, 475000, 0, 'file_import', 'SRC-' || l.lms_loan_ref, clock_timestamp() - interval '1 hour', pg_temp.sha('snap-' || l.lms_loan_ref)
from servicing.loan_accounts l;
insert into servicing.schedule_snapshots (id, lender_org_id, loan_account_id, version)
select ('fc500000-0000-4000-8000-0000000000' || lpad(right(l.id::text, 2)::int::text, 2, '0'))::uuid, l.lender_org_id, l.id, 1 from servicing.loan_accounts l;
insert into servicing.schedule_installments (snapshot_id, lender_org_id, seq, due_date, principal_minor, interest_minor)
select s.id, s.lender_org_id, x.seq, pg_temp.d() + x.days, x.principal, x.interest
from servicing.schedule_snapshots s cross join (values (1, 3, 400000::bigint, 75000::bigint), (2, 33, 400000::bigint, 75000::bigint), (3, 63, 5900000::bigint, 100000::bigint)) x (seq, days, principal, interest);

select pg_temp.as_system();

-- ============================================================================================================================
-- 1. Structure and grants
-- ============================================================================================================================
select is((select (c.relrowsecurity and c.relforcerowsecurity) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'payments' and c.relname = 'handoff_links'), true,
  'row level security is enabled and forced on the hand-off vault');
select ok((select obj_description(c.oid, 'pg_class') like '%Owner: payments module.' from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'payments' and c.relname = 'handoff_links'),
  'the vault has a comment naming its owner module');
select ok((select bool_and(not has_table_privilege(r, 'payments.handoff_links', p))
           from unnest(array['anon', 'authenticated', 'service_role']) r cross join unnest(array['select', 'insert', 'update', 'delete', 'truncate']) p),
  'no API role has any privilege on the vault: it is reachable only through the three definer functions');
select is((select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'payments' and c.relname = 'handoff_links' and t.tgname in ('protect', 'no_truncate') and not t.tgisinternal), 2::bigint, 'the vault is protected against changes and truncation');
select is((select count(*) from information_schema.columns where table_schema = 'payments' and table_name = 'handoff_links'
             and column_name ~* '(link|url|token|secret|plain|account|ifsc|phone|name)'), 0::bigint, 'no vault column can hold a link in clear, an account number, a name or a phone number: only ciphertext');
select ok((select bool_and(has_function_privilege('authenticated', f, 'execute') and not has_function_privilege('anon', f, 'execute') and not has_function_privilege('service_role', f, 'execute'))
           from unnest(array['servicing.my_loan_schedule(uuid)', 'servicing.my_loan_activity(uuid, timestamptz, uuid, integer)', 'payments.take_handoff_link(text, uuid)',
                             'payments.my_payment_detail(uuid)', 'payments.cancel_my_payment(uuid)', 'payments.my_payment_options(uuid)', 'payments.my_mandate_options(uuid)',
                             'payments.my_mandate_debits(uuid)']) f), 'the eight borrower functions are for signed-in users only (not anon, not the system role)');
select ok((select bool_and(has_function_privilege('service_role', f, 'execute') and not has_function_privilege('anon', f, 'execute') and not has_function_privilege('authenticated', f, 'execute'))
           from unnest(array['payments.store_handoff_link(text, uuid, text, bytea, timestamptz)', 'payments.purge_handoff_links()']) f), 'storing and purging a link are for the system role only');
select ok((select bool_and(p.prosecdef and p.proconfig @> array['search_path=""'])
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where (n.nspname, p.proname) in (('payments', 'store_handoff_link'), ('payments', 'take_handoff_link'), ('payments', 'purge_handoff_links'), ('servicing', 'my_loan_schedule'),
                                            ('servicing', 'my_loan_activity'), ('payments', 'my_payment_detail'), ('payments', 'cancel_my_payment'), ('payments', 'my_payment_options'),
                                            ('payments', 'my_mandate_options'), ('payments', 'my_mandate_debits'))), 'every function is a definer with an empty search path');

-- ============================================================================================================================
-- 2. Fixtures
-- ============================================================================================================================
select pg_temp.as_owner();
insert into payments.lender_payment_policies (lender_org_id, allow_partial_payments, min_partial_amount_minor, allow_part_prepayment, min_part_prepayment_minor, updated_by)
values (pg_temp.lx(), true, 100000, true, 200000, pg_temp.u(3));
insert into servicing.foreclosure_quotes (lender_org_id, loan_account_id, lender_quote_ref, as_of, valid_until, principal_minor, interest_minor, charges_minor, prepayment_charge_minor, total_minor, source, reported_by)
values (pg_temp.lx(), pg_temp.lid(1), 'SAMPLE-Q-23', now() - interval '1 hour', now() + interval '1 day', 4000000, 100000, 0, 0, 4100000, 'lender_portal', pg_temp.u(3));
select pg_temp.keep('q1', (select id::text from servicing.foreclosure_quotes where lender_quote_ref = 'SAMPLE-Q-23'));
-- A lender quotation whose parts do not add up to its total (flagged, never corrected).
insert into servicing.foreclosure_quotes (lender_org_id, loan_account_id, lender_quote_ref, as_of, valid_until, principal_minor, interest_minor, charges_minor, prepayment_charge_minor, total_minor, source, reported_by)
values (pg_temp.lx(), pg_temp.lid(3), 'SAMPLE-Q-23B', now() - interval '1 hour', now() + interval '1 day', 4000000, 100000, 0, 0, 4000000, 'lender_portal', pg_temp.u(3));
-- Loan 3 is overdue: 6,000.00 reported 10 minutes ago.
insert into servicing.balance_snapshots (lender_org_id, loan_account_id, version, status, outstanding_principal_minor, overdue_principal_minor, overdue_interest_minor, penal_charges_minor, other_charges_minor,
  total_overdue_minor, next_due_on, next_due_minor, days_past_due, source_system, source_record_id, reported_as_of, content_sha256)
values (pg_temp.lx(), pg_temp.lid(3), 2, 'active', 4000000, 500000, 100000, 0, 0, 600000, pg_temp.d() + 3, 475000, 12, 'file_import', 'SRC-OVERDUE-3', clock_timestamp() - interval '10 minutes', pg_temp.sha('overdue-3'));
select pg_temp.as_user(pg_temp.u(3));
select is(payments.set_mandate_policy(pg_temp.lx(), 'before_first_due', 4000000, 48), 'set', 'fixture: lender X sets its mandate policy (ceiling 40,000.00, 48 hours)');

-- ============================================================================================================================
-- 3. One payment, and cancelling it
-- ============================================================================================================================
select pg_temp.as_user(pg_temp.u(1));
select pg_temp.keep('i1', payments.request_payment(pg_temp.lid(1), 'installment', 475000, 'f23-pay-key-000000001')::text);
select is((select (loan_account_id = pg_temp.lid(1), lender_display_name, purpose, amount_minor, intent_status, stage, cancellable, link_available, destination_masked_ref)::text
           from payments.my_payment_detail(pg_temp.got('i1')::uuid)), '(t,Alpha,installment,475000,created,started,t,f,XXXXXX1111)',
  'the borrower sees the payment: lender, purpose, amount, honest stage "started", cancellable, no link yet, the lender''s masked destination account');
select pg_temp.as_user(pg_temp.u(2));
select is(pg_temp.err(format($$select * from payments.my_payment_detail(%L)$$, pg_temp.got('i1'))), 'P0002|', 'another borrower cannot see it');
select is(pg_temp.err(format($$select payments.cancel_my_payment(%L)$$, pg_temp.got('i1'))), 'P0002|', 'nor cancel it');
select pg_temp.as_user(pg_temp.u(3));
select is(pg_temp.err(format($$select * from payments.my_payment_detail(%L)$$, pg_temp.got('i1'))), '42501|', 'a lender user is not a borrower: refused');
select is(pg_temp.err(format($$select payments.cancel_my_payment(%L)$$, pg_temp.got('i1'))), '42501|', 'a lender user cannot cancel a borrower''s payment');
select pg_temp.as_anon();
select is(pg_temp.err(format($$select * from payments.my_payment_detail(%L)$$, pg_temp.got('i1'))), '42501|', 'anon cannot read it');
select is(pg_temp.err(format($$select payments.cancel_my_payment(%L)$$, pg_temp.got('i1'))), '42501|', 'nor cancel it');
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err(format($$select * from payments.my_payment_detail(%L)$$, gen_random_uuid())), 'P0002|', 'an unknown payment is not found');
select is(payments.cancel_my_payment(pg_temp.got('i1')::uuid), 'cancelled', 'the owner cancels a payment that has no order at the provider');
select is(payments.cancel_my_payment(pg_temp.got('i1')::uuid), 'cancelled', 'cancelling again answers the same and writes nothing more');
select is((select (intent_status, cancellable)::text from payments.my_payment_detail(pg_temp.got('i1')::uuid)), '(cancelled,f)', 'the payment now reads as cancelled and can no longer be cancelled');
select pg_temp.as_owner();
select is((select count(*) from audit.events where action = 'payments.intent.cancelled' and entity_id = pg_temp.got('i1')), 1::bigint, 'one audit event for the cancellation (the repeat wrote none)');
select pg_temp.as_user(pg_temp.u(1));
select pg_temp.keep('i2', payments.request_payment(pg_temp.lid(1), 'installment', 475000, 'f23-pay-key-000000002')::text);
select isnt(pg_temp.got('i2'), pg_temp.got('i1'), 'a new payment for the same installment is allowed once the first is cancelled');
select pg_temp.as_system();
select is(payments.record_order_created(pg_temp.got('i2')::uuid, 'SAMPLE-ORDER-I2', now() + interval '1 hour'), 'pending', 'the worker records the order: the payment is pending');
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err(format($$select payments.cancel_my_payment(%L)$$, pg_temp.got('i2'))), '55000|intent_not_cancellable', 'a payment that has an order at the provider cannot be cancelled in the app');
select is((select (intent_status, cancellable, link_available)::text from payments.my_payment_detail(pg_temp.got('i2')::uuid)), '(pending,f,f)', 'it reads as pending, not cancellable, and no link has been stored yet');

-- ============================================================================================================================
-- 4. The vault: a payment link
-- ============================================================================================================================
select pg_temp.as_system();
select is(pg_temp.err(format($$select payments.store_handoff_link('cheque', %L, 'k1', pg_temp.bytes(40), now() + interval '1 hour')$$, pg_temp.got('i2'))), '22023|bad_request', 'an unknown kind is refused');
select is(pg_temp.err(format($$select payments.store_handoff_link('payment_intent', %L, 'k1', pg_temp.bytes(28), now() + interval '1 hour')$$, pg_temp.got('i2'))), '22023|bad_request', 'a blob too short to be authenticated ciphertext is refused');
select is(pg_temp.err(format($$select payments.store_handoff_link('payment_intent', %L, 'bad key!', pg_temp.bytes(40), now() + interval '1 hour')$$, pg_temp.got('i2'))), '22023|bad_request', 'a key version with odd characters is refused');
select is(pg_temp.err(format($$select payments.store_handoff_link('payment_intent', %L, 'k1', pg_temp.bytes(40), now() - interval '1 minute')$$, pg_temp.got('i2'))), '22023|bad_request', 'an expiry in the past is refused');
select is(pg_temp.err(format($$select payments.store_handoff_link('payment_intent', %L, 'k1', pg_temp.bytes(40), now() + interval '32 days')$$, pg_temp.got('i2'))), '22023|bad_request', 'an expiry more than 31 days away is refused');
select is(pg_temp.err(format($$select payments.store_handoff_link('payment_intent', %L, 'k1', pg_temp.bytes(40), now() + interval '1 hour')$$, gen_random_uuid())), 'P0002|', 'an unknown payment is not found');
select is(pg_temp.err(format($$select payments.store_handoff_link('payment_intent', %L, 'k1', pg_temp.bytes(40), now() + interval '1 hour')$$, pg_temp.got('i1'))), '55000|intent_state_invalid', 'a cancelled payment keeps no link');
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err(format($$select payments.store_handoff_link('payment_intent', %L, 'k1', pg_temp.bytes(40), now() + interval '1 hour')$$, pg_temp.got('i2'))), '42501|', 'a borrower cannot store a link');
select pg_temp.as_anon();
select is(pg_temp.err(format($$select payments.store_handoff_link('payment_intent', %L, 'k1', pg_temp.bytes(40), now() + interval '1 hour')$$, pg_temp.got('i2'))), '42501|', 'anon cannot store a link');
select pg_temp.as_system();
select is(payments.store_handoff_link('payment_intent', pg_temp.got('i2')::uuid, 'k1', pg_temp.bytes(40), now() + interval '1 hour'), 'stored', 'the worker stores the encrypted link of the pending payment');
select pg_temp.as_owner();
select is((select (count(*), min(read_count), bool_and(lender_org_id = pg_temp.lx()), bool_and(borrower_id = pg_temp.got('b1')::uuid))::text from payments.handoff_links), '(1,0,t,t)',
  'one row; the lender and the borrower come from the payment, not from the caller');
select pg_temp.as_user(pg_temp.u(1));
select is((select (link_available)::text from payments.my_payment_detail(pg_temp.got('i2')::uuid)), 'true', 'the payment detail now says a link can be fetched');
select is((select (key_version, alg, octet_length(ciphertext), expires_at > now(), lender_org_id = pg_temp.lx())::text from payments.take_handoff_link('payment_intent', pg_temp.got('i2')::uuid)),
  '(k1,aes-256-gcm,40,t,t)', 'the owner takes the ciphertext (and the lender id for the associated data), never a link in clear');
select is((select count(*) from payments.take_handoff_link('payment_intent', pg_temp.got('i2')::uuid)), 1::bigint, 'and can take it again until it expires');
select pg_temp.as_owner();
select is((select read_count from payments.handoff_links), 2, 'every read is counted');
select pg_temp.as_user(pg_temp.u(2));
select is(pg_temp.err(format($$select * from payments.take_handoff_link('payment_intent', %L)$$, pg_temp.got('i2'))), 'P0002|link_unavailable', 'another borrower gets nothing');
select pg_temp.as_user(pg_temp.u(3));
select is(pg_temp.err(format($$select * from payments.take_handoff_link('payment_intent', %L)$$, pg_temp.got('i2'))), '42501|', 'a lender user gets nothing: the link is the borrower''s');
select pg_temp.as_anon();
select is(pg_temp.err(format($$select * from payments.take_handoff_link('payment_intent', %L)$$, pg_temp.got('i2'))), '42501|', 'anon gets nothing');
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err(format($$select * from payments.take_handoff_link('mandate', %L)$$, pg_temp.got('i2'))), 'P0002|link_unavailable', 'the kind is part of the key: a payment id asked for as a mandate finds nothing');
select is(pg_temp.err(format($$select * from payments.take_handoff_link('cheque', %L)$$, pg_temp.got('i2'))), '22023|bad_request', 'an unknown kind is refused');
select is(pg_temp.err($$select count(*) from payments.handoff_links$$), '42501|', 'the borrower cannot read the table');
select pg_temp.as_user(pg_temp.u(3));
select is(pg_temp.err($$select count(*) from payments.handoff_links$$), '42501|', 'nor can a lender user');
select pg_temp.as_system();
select is(pg_temp.err($$select count(*) from payments.handoff_links$$), '42501|', 'nor the system role: only the definer functions touch it');
select is(payments.store_handoff_link('payment_intent', pg_temp.got('i2')::uuid, 'k2', pg_temp.bytes(48), now() + interval '2 hours'), 'stored', 'storing again replaces the earlier row (a retry of the worker)');
select pg_temp.as_owner();
select is((select (count(*), min(key_version), min(octet_length(ciphertext)), min(read_count))::text from payments.handoff_links), '(1,k2,48,0)', 'still one row, with the new key version and the new blob');
select is(pg_temp.err($$update payments.handoff_links set ciphertext = pg_temp.bytes(40)$$), 'P0001|', 'a stored link can only be read, never changed');
select is((select count(*) from audit.events where action = 'payments.handoff.stored' and metadata::text !~ 'abab|ciphertext|link'), 2::bigint, 'the audit events of both stores name the key version and carry no ciphertext');
select pg_temp.as_owner();
set local session_replication_role = replica;
update servicing.lender_features set enabled = false where lender_org_id = pg_temp.lx() and feature = 'payments';
set local session_replication_role = origin;
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err(format($$select * from payments.take_handoff_link('payment_intent', %L)$$, pg_temp.got('i2'))), 'P0002|link_unavailable', 'a lender whose payments switch is off hands out no link');
select is(pg_temp.err(format($$select * from payments.my_payment_detail(%L)$$, pg_temp.got('i2'))), 'P0002|', 'and shows no payment');
select pg_temp.as_owner();
set local session_replication_role = replica;
update servicing.lender_features set enabled = true where lender_org_id = pg_temp.lx() and feature = 'payments';
set local session_replication_role = origin;
select pg_temp.as_owner();
set local session_replication_role = replica;
update payments.handoff_links set created_at = now() - interval '2 hours', expires_at = now() - interval '1 minute';
set local session_replication_role = origin;
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err(format($$select * from payments.take_handoff_link('payment_intent', %L)$$, pg_temp.got('i2'))), 'P0002|link_unavailable', 'an expired link is not handed out');
select is((select link_available from payments.my_payment_detail(pg_temp.got('i2')::uuid)), false, 'and the payment detail says so');
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err($$select payments.purge_handoff_links()$$), '42501|', 'a borrower cannot purge');
select pg_temp.as_system();
select is(payments.purge_handoff_links(), 1, 'the purge deletes the expired link');
select is(payments.store_handoff_link('payment_intent', pg_temp.got('i2')::uuid, 'k3', pg_temp.bytes(40), now() + interval '1 hour'), 'stored', 'a fresh link is stored');
select pg_temp.as_owner();
set local session_replication_role = replica;
update payments.payment_intents set status = 'failed' where id = pg_temp.got('i2')::uuid;
set local session_replication_role = origin;
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err(format($$select * from payments.take_handoff_link('payment_intent', %L)$$, pg_temp.got('i2'))), 'P0002|link_unavailable', 'once the payment is no longer pending its link is not handed out');
select pg_temp.as_system();
select is(payments.purge_handoff_links(), 1, 'and the purge deletes it');
select is(payments.purge_handoff_links(), 0, 'a second purge finds nothing');

-- ============================================================================================================================
-- 5. What a mandate can be (before any exists)
-- ============================================================================================================================
select pg_temp.as_user(pg_temp.u(1));
select is((select (o ->> 'available', o ->> 'unavailable_key', o ->> 'requirement', o ->> 'pre_debit_lead_hours', o ->> 'existing_mandate_id', o ->> 'lender_display_name')::text
           from (select pg_temp.opts('payments.my_mandate_options', pg_temp.lid(1)) o) x), '(true,,before_first_due,48,,Alpha)',
  'lender X offers mandates on loan 1: its own policy, 48 hours of notice, no mandate yet');
select is((select pg_temp.opts('payments.my_mandate_options', pg_temp.lid(1)) -> 'rails'),
  '[{"rail": "enach_api", "max_amount_minor": 4000000, "needs_afa_each_debit": false}, {"rail": "upi_autopay", "max_amount_minor": 1500000, "needs_afa_each_debit": true}]'::jsonb,
  'the rails with the lower of the rail limit and the lender''s ceiling (40,000.00 and 15,000.00), and whether a bank prompt may appear on every debit');
select is((select pg_temp.opts('payments.my_mandate_options', pg_temp.lid(4)) ->> 'unavailable_key'), 'provider_not_mandate_capable', 'lender Y''s provider does not offer mandates');
select is((select (pg_temp.opts('payments.my_mandate_options', pg_temp.lid(5)) ->> 'unavailable_key', pg_temp.opts('payments.my_mandate_options', pg_temp.lid(5)) -> 'rails', pg_temp.opts('payments.my_mandate_options', pg_temp.lid(5)) ->> 'requirement')::text),
  '(rail_not_configured,[],)', 'lender Z has a mandate-capable provider but no complete rail limits: nothing is assumed, and it has no policy');
select is(pg_temp.err(format($$select pg_temp.opts('payments.my_mandate_options', %L)$$, pg_temp.lid(2))), 'P0002|', 'another borrower''s loan is not found');
select pg_temp.as_user(pg_temp.u(3));
select is(pg_temp.err(format($$select pg_temp.opts('payments.my_mandate_options', %L)$$, pg_temp.lid(1))), 'P0002|', 'a lender user is not a borrower: not found');
select pg_temp.as_anon();
select is(pg_temp.err(format($$select pg_temp.opts('payments.my_mandate_options', %L)$$, pg_temp.lid(1))), '42501|', 'anon is refused');
select pg_temp.as_owner();
set local session_replication_role = replica;
update servicing.lender_features set enabled = false where lender_org_id = pg_temp.lz() and feature = 'mandates';
set local session_replication_role = origin;
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err(format($$select pg_temp.opts('payments.my_mandate_options', %L)$$, pg_temp.lid(5))), 'P0002|', 'when the lender''s mandates switch is off the loan reports nothing');
select pg_temp.as_owner();
set local session_replication_role = replica;
update servicing.lender_features set enabled = true where lender_org_id = pg_temp.lz() and feature = 'mandates';
set local session_replication_role = origin;

-- ============================================================================================================================
-- 6. A mandate: draft, hand-off, its link
-- ============================================================================================================================
select pg_temp.as_owner();
select pg_temp.integrity(pg_temp.got('b1'), 'device');
select pg_temp.stepup(pg_temp.got('b1'), pg_temp.mid(1));
select pg_temp.as_user(pg_temp.u(1));
select is(payments.request_mandate(pg_temp.mid(1), pg_temp.lid(1), 'enach_api', 4000000, pg_temp.d() + 1, pg_temp.d() + 365, 'XXXXXX9999'), pg_temp.mid(1), 'fixture: the borrower requests a mandate (a draft)');
select is((select (o ->> 'available', o ->> 'unavailable_key', o ->> 'existing_mandate_id' = pg_temp.mid(1)::text)::text from (select pg_temp.opts('payments.my_mandate_options', pg_temp.lid(1)) o) x),
  '(false,mandate_exists,t)', 'with a live mandate on the loan nothing more is offered and the existing one is named');
select is((select (o ->> 'available')::text from (select pg_temp.opts('payments.my_mandate_options', pg_temp.lid(3)) o) x), 'true', 'another loan of the same borrower is unaffected');
select pg_temp.as_system();
select is(pg_temp.err(format($$select payments.store_handoff_link('mandate', %L, 'k1', pg_temp.bytes(40), now() + interval '1 hour')$$, pg_temp.mid(1))), '55000|mandate_state_invalid', 'a draft mandate has no authorisation link yet');
select is(pg_temp.err(format($$select payments.store_handoff_link('mandate', %L, 'k1', pg_temp.bytes(40), now() + interval '1 hour')$$, gen_random_uuid())), 'P0002|', 'an unknown mandate is not found');
select is(payments.record_mandate_handoff(pg_temp.mid(1), 'handoff', 'SAMPLE-PM-1', now() + interval '2 hours'), 'registration_pending', 'fixture: the provider takes the hand-off (the mandate waits for the borrower)');
select is(payments.store_handoff_link('mandate', pg_temp.mid(1), 'k1', pg_temp.bytes(40), now() + interval '2 hours'), 'stored', 'the worker stores the encrypted authorisation link');
select pg_temp.as_user(pg_temp.u(1));
select is((select (key_version, octet_length(ciphertext), lender_org_id = pg_temp.lx())::text from payments.take_handoff_link('mandate', pg_temp.mid(1))), '(k1,40,t)', 'the owner takes it');
select pg_temp.as_user(pg_temp.u(2));
select is(pg_temp.err(format($$select * from payments.take_handoff_link('mandate', %L)$$, pg_temp.mid(1))), 'P0002|link_unavailable', 'another borrower gets nothing');
select pg_temp.as_system();
select is(payments.purge_handoff_links(), 0, 'the purge keeps the link of a mandate that is still waiting for the borrower');
select pg_temp.as_owner();
set local session_replication_role = replica;
update payments.mandates set status = 'active' where id = pg_temp.mid(1);
set local session_replication_role = origin;
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err(format($$select * from payments.take_handoff_link('mandate', %L)$$, pg_temp.mid(1))), 'P0002|link_unavailable', 'once the mandate is active its link is not handed out');
select pg_temp.as_system();
select is(payments.purge_handoff_links(), 1, 'and the purge deletes it');

-- ============================================================================================================================
-- 7. The schedule
-- ============================================================================================================================
select pg_temp.as_user(pg_temp.u(1));
select is((select (count(*), min(schedule_version), sum(total_minor), bool_and(total_minor = principal_minor + interest_minor + fees_minor))::text from servicing.my_loan_schedule(pg_temp.lid(1))), '(3,1,6950000,t)',
  'loan 1: three installments exactly as the lender reported them; the total is the lender''s own sum of its parts');
select is((select (seq, due_date - pg_temp.d(), principal_minor, interest_minor, fees_minor)::text from servicing.my_loan_schedule(pg_temp.lid(1)) where seq = 1), '(1,3,400000,75000,0)', 'the first installment is due in three days');
select pg_temp.as_owner();
with s as (insert into servicing.schedule_snapshots (lender_org_id, loan_account_id, version, reported_as_of, content_sha256, source, source_record_id)
           values (pg_temp.lx(), pg_temp.lid(1), 2, clock_timestamp(), pg_temp.sha('sched-2'), 'file_import', 'SRC-SCHED-2') returning id)
insert into servicing.schedule_installments (snapshot_id, lender_org_id, seq, due_date, principal_minor, interest_minor) select id, pg_temp.lx(), 1, pg_temp.d() + 5, 100000, 5000 from s;
select pg_temp.as_user(pg_temp.u(1));
select is((select (count(*), min(schedule_version), sum(total_minor))::text from servicing.my_loan_schedule(pg_temp.lid(1))), '(1,2,105000)', 'a newer schedule from the lender supersedes the older one');
select pg_temp.as_owner();
insert into servicing.sync_conflicts (lender_org_id, loan_account_id, record_type, conflict_reason, source_record_id, existing_content_sha256, existing_reported_as_of, incoming_content_sha256, incoming_reported_as_of,
  incoming_report, source_system)
values (pg_temp.lx(), pg_temp.lid(1), 'receipt', 'receipt_differs', 'SRC-RC-X', pg_temp.sha('c1'), now() - interval '2 hours', pg_temp.sha('c2'), now() - interval '1 hour', '{}'::jsonb, 'file_import');
select pg_temp.as_user(pg_temp.u(1));
select is((select count(*) from servicing.my_loan_schedule(pg_temp.lid(1))), 1::bigint, 'an open conflict about a RECEIPT does not withhold the schedule');
select pg_temp.as_owner();
insert into servicing.sync_conflicts (lender_org_id, loan_account_id, record_type, conflict_reason, source_record_id, existing_content_sha256, existing_reported_as_of, incoming_content_sha256, incoming_reported_as_of,
  incoming_report, source_system)
values (pg_temp.lx(), pg_temp.lid(1), 'schedule', 'same_record_different_content', 'SRC-SCHED-2', pg_temp.sha('c3'), now() - interval '2 hours', pg_temp.sha('c4'), now() - interval '1 hour', '{}'::jsonb, 'file_import');
select pg_temp.as_user(pg_temp.u(1));
select is((select count(*) from servicing.my_loan_schedule(pg_temp.lid(1))), 0::bigint, 'an open conflict about the SCHEDULE withholds it: the borrower sees nothing rather than a disputed schedule');
select pg_temp.as_owner();
set local session_replication_role = replica;
delete from servicing.sync_conflicts where loan_account_id = pg_temp.lid(1);
set local session_replication_role = origin;
select pg_temp.as_owner();
with s as (insert into servicing.schedule_snapshots (lender_org_id, loan_account_id, version, reported_as_of, content_sha256, source, source_record_id)
           values (pg_temp.lx(), pg_temp.lid(1), 3, clock_timestamp(), pg_temp.sha('sched-3'), 'mock_lms', 'SRC-SCHED-3') returning id)
insert into servicing.schedule_installments (snapshot_id, lender_org_id, seq, due_date, principal_minor, interest_minor) select id, pg_temp.lx(), 1, pg_temp.d() + 6, 1, 1 from s;
select pg_temp.as_user(pg_temp.u(1));
select is((select min(schedule_version) from servicing.my_loan_schedule(pg_temp.lid(1))), 3, 'where mock providers are allowed a mock-source schedule counts');
select set_config('udofin.allow_mock_providers', 'off', true);
select is((select min(schedule_version) from servicing.my_loan_schedule(pg_temp.lid(1))), 2, 'and where they are not it is ignored');
select set_config('udofin.allow_mock_providers', 'on', true);
select is(pg_temp.err(format($$select * from servicing.my_loan_schedule(%L)$$, pg_temp.lid(2))), 'P0002|', 'another borrower''s loan is not found');
select is(pg_temp.err(format($$select * from servicing.my_loan_schedule(%L)$$, gen_random_uuid())), 'P0002|', 'nor is an unknown one');
select pg_temp.as_owner();
set local session_replication_role = replica;
update servicing.lender_features set enabled = false where lender_org_id = pg_temp.lz() and feature = 'servicing_sync';
set local session_replication_role = origin;
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err(format($$select * from servicing.my_loan_schedule(%L)$$, pg_temp.lid(5))), 'P0002|', 'when the lender''s servicing_sync switch is off the schedule is not available');
select pg_temp.as_owner();
set local session_replication_role = replica;
update servicing.lender_features set enabled = true where lender_org_id = pg_temp.lz() and feature = 'servicing_sync';
set local session_replication_role = origin;
select pg_temp.as_user(pg_temp.u(3));
select is(pg_temp.err(format($$select * from servicing.my_loan_schedule(%L)$$, pg_temp.lid(1))), 'P0002|', 'a lender user is not a borrower: not found');
select pg_temp.as_anon();
select is(pg_temp.err(format($$select * from servicing.my_loan_schedule(%L)$$, pg_temp.lid(1))), '42501|', 'anon is refused');

-- ============================================================================================================================
-- 8. Activity
-- ============================================================================================================================
select pg_temp.as_owner();
insert into servicing.lms_receipts (lender_org_id, loan_account_id, kind, lms_receipt_ref, amount_minor, value_date, payment_mode, bank_reference, source_system, source_record_id, reported_as_of, received_at, content_sha256)
values (pg_temp.lx(), pg_temp.lid(1), 'receipt', 'RC-23-1', 475000, pg_temp.d() - 40, 'upi', 'UTR-SECRET-1', 'file_import', 'SRC-RC-23-1', now() - interval '40 days', now() - interval '40 days', pg_temp.sha('rc-23-1')),
       (pg_temp.lx(), pg_temp.lid(1), 'receipt', 'RC-23-2', 475000, pg_temp.d() - 10, 'upi', 'UTR-SECRET-2', 'file_import', 'SRC-RC-23-2', now() - interval '10 days', now() - interval '10 days', pg_temp.sha('rc-23-2')),
       (pg_temp.lx(), pg_temp.lid(1), 'receipt', 'RC-23-3', 1000, pg_temp.d() - 1, 'cash', null, 'mock_lms', 'SRC-RC-23-3', now() - interval '1 day', now() - interval '1 day', pg_temp.sha('rc-23-3'));
insert into servicing.lms_receipts (lender_org_id, loan_account_id, kind, lms_receipt_ref, reverses_receipt_id, reverses_receipt_ref, amount_minor, value_date, payment_mode, source_system, source_record_id, reported_as_of, received_at, content_sha256)
select pg_temp.lx(), pg_temp.lid(1), 'reversal', 'RC-23-2R', r.id, r.lms_receipt_ref, 475000, pg_temp.d() - 9, 'upi', 'file_import', 'SRC-RC-23-2R', now() - interval '9 days', now() - interval '9 days', pg_temp.sha('rc-23-2r')
from servicing.lms_receipts r where r.lms_receipt_ref = 'RC-23-2';
select pg_temp.as_user(pg_temp.u(1));
select pg_temp.keep('i3', payments.request_payment(pg_temp.lid(1), 'installment', 475000, 'f23-pay-key-000000003')::text);
select pg_temp.as_system();
select is(payments.record_order_created(pg_temp.got('i3')::uuid, 'SAMPLE-ORDER-I3', now() + interval '1 hour'), 'pending', 'fixture: a third payment is pending');
select pg_temp.as_owner();
set local session_replication_role = replica;
insert into payments.provider_payments (lender_org_id, config_id, provider, provider_payment_ref, order_ref, intent_id, loan_account_id, status, rank, amount_minor, currency, captured_at, first_event_id, last_event_id)
  values (pg_temp.lx(), pg_temp.cfg(pg_temp.lx()), 'mock_gateway', 'SAMPLE-PAY-I3', 'SAMPLE-ORDER-I3', pg_temp.got('i3')::uuid, pg_temp.lid(1), 'captured', 30, 475000, 'INR', now() - interval '2 hours', gen_random_uuid(), gen_random_uuid());
set local session_replication_role = origin;
select pg_temp.as_owner();
set local session_replication_role = replica;
insert into payments.payment_adjustments (lender_org_id, provider_payment_id, kind, object_ref, amount_minor, source_event_id, occurred_at)
  select pg_temp.lx(), id, 'refund', 'SAMPLE-REFUND-1', 100000, gen_random_uuid(), now() + interval '1 minute' from payments.provider_payments where provider_payment_ref = 'SAMPLE-PAY-I3';
set local session_replication_role = origin;
select pg_temp.as_user(pg_temp.u(1));
select is((select array_agg(entry_kind) from servicing.my_loan_activity(pg_temp.lid(1))),
  array['payment_adjustment', 'payment_attempt', 'payment_attempt', 'payment_attempt', 'lender_receipt', 'lender_reversal', 'lender_receipt', 'lender_receipt'],
  'newest first: the refund, the three payment attempts, then the lender''s receipts and its reversal');
select is((select array_agg(state) from servicing.my_loan_activity(pg_temp.lid(1))),
  array['refund', 'needs_attention', 'failed', 'cancelled', 'posted', 'recorded', 'reversed', 'posted'],
  'each with its honest state: the provider reported money for the third attempt and then refunded part of it (needs_attention, no longer "received"), the second failed and the first was cancelled, a reversed receipt says reversed');
select is((select array_agg(amount_minor) from servicing.my_loan_activity(pg_temp.lid(1))), array[100000, 475000, 475000, 475000, 1000, 475000, 475000, 475000]::bigint[], 'amounts are integer paise as reported');
select is((select array_agg(purpose) from servicing.my_loan_activity(pg_temp.lid(1)) where entry_kind = 'payment_attempt'), array['installment', 'installment', 'installment'], 'a payment attempt names its purpose');
select is((select count(*) from information_schema.columns where table_schema = 'servicing' and table_name = 'lms_receipts' and column_name in ('bank_reference', 'payment_mode')), 2::bigint,
  'the receipt table does hold the bank reference and the payment mode (so the next test is meaningful)');
select is((select count(*) from servicing.my_loan_activity(pg_temp.lid(1)) a where a::text ~* 'UTR-SECRET|upi|SAMPLE-PAY|SAMPLE-ORDER'), 0::bigint, 'but the activity carries none of them: no bank reference, payment mode or provider reference');
select pg_temp.keep('c_at', (select sort_at::text from servicing.my_loan_activity(pg_temp.lid(1), null, null, 3) order by sort_at, entry_id limit 1));
select pg_temp.keep('c_id', (select entry_id::text from servicing.my_loan_activity(pg_temp.lid(1), null, null, 3) order by sort_at, entry_id limit 1));
select is((select array_agg(entry_kind) from servicing.my_loan_activity(pg_temp.lid(1), null, null, 3)), array['payment_adjustment', 'payment_attempt', 'payment_attempt'], 'the first page of three');
select is((select array_agg(state) from servicing.my_loan_activity(pg_temp.lid(1), pg_temp.got('c_at')::timestamptz, pg_temp.got('c_id')::uuid, 3)),
  array['cancelled', 'posted', 'recorded'], 'the next page continues exactly after it, without repeating or skipping');
select is((select count(*) from servicing.my_loan_activity(pg_temp.lid(1), pg_temp.got('c_at')::timestamptz, pg_temp.got('c_id')::uuid, 100)), 5::bigint, 'and a larger page returns all that remains');
select is(pg_temp.err(format($$select * from servicing.my_loan_activity(%L, now(), null, 10)$$, pg_temp.lid(1))), '22023|bad_request', 'a cursor needs both parts');
select is(pg_temp.err(format($$select * from servicing.my_loan_activity(%L, null, null, 0)$$, pg_temp.lid(1))), '22023|bad_request', 'a page of zero is refused');
select is(pg_temp.err(format($$select * from servicing.my_loan_activity(%L, null, null, 101)$$, pg_temp.lid(1))), '22023|bad_request', 'and one over 100');
select set_config('udofin.allow_mock_providers', 'off', true);
select is((select count(*) from servicing.my_loan_activity(pg_temp.lid(1)) where entry_kind = 'lender_receipt'), 2::bigint, 'where mock providers are not allowed a mock-source receipt is hidden');
select set_config('udofin.allow_mock_providers', 'on', true);
select pg_temp.as_owner();
set local session_replication_role = replica;
update servicing.lender_features set enabled = false where lender_org_id = pg_temp.lx() and feature = 'payments';
set local session_replication_role = origin;
select pg_temp.as_user(pg_temp.u(1));
select is((select array_agg(distinct entry_kind) from servicing.my_loan_activity(pg_temp.lid(1))), array['lender_receipt', 'lender_reversal'], 'with the payments switch off only the lender''s receipts remain');
select pg_temp.as_owner();
set local session_replication_role = replica;
update servicing.lender_features set enabled = true where lender_org_id = pg_temp.lx() and feature = 'payments';
set local session_replication_role = origin;
select pg_temp.as_owner();
set local session_replication_role = replica;
update servicing.lender_features set enabled = false where lender_org_id = pg_temp.lx() and feature = 'servicing_sync';
set local session_replication_role = origin;
select pg_temp.as_user(pg_temp.u(1));
select is((select array_agg(distinct entry_kind) from servicing.my_loan_activity(pg_temp.lid(1))), array['payment_adjustment', 'payment_attempt'], 'and with servicing_sync off only the payments remain');
select pg_temp.as_owner();
set local session_replication_role = replica;
update servicing.lender_features set enabled = false where lender_org_id = pg_temp.lz() and feature = 'payments';
set local session_replication_role = origin;
select pg_temp.as_owner();
set local session_replication_role = replica;
update servicing.lender_features set enabled = false where lender_org_id = pg_temp.lz() and feature = 'servicing_sync';
set local session_replication_role = origin;
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err(format($$select * from servicing.my_loan_activity(%L)$$, pg_temp.lid(5))), 'P0002|', 'with both switches off the loan reports nothing');
select pg_temp.as_owner();
set local session_replication_role = replica;
update servicing.lender_features set enabled = true where lender_org_id = pg_temp.lz() and feature = 'payments';
set local session_replication_role = origin;
select pg_temp.as_owner();
set local session_replication_role = replica;
update servicing.lender_features set enabled = true where lender_org_id = pg_temp.lz() and feature = 'servicing_sync';
set local session_replication_role = origin;
select pg_temp.as_owner();
set local session_replication_role = replica;
update servicing.lender_features set enabled = true where lender_org_id = pg_temp.lx() and feature = 'servicing_sync';
set local session_replication_role = origin;
select pg_temp.as_user(pg_temp.u(2));
select is((select count(*) from servicing.my_loan_activity(pg_temp.lid(2))), 0::bigint, 'another borrower with no activity sees an empty list on their own loan');
select is(pg_temp.err(format($$select * from servicing.my_loan_activity(%L)$$, pg_temp.lid(1))), 'P0002|', 'and cannot read borrower 1''s loan');
select pg_temp.as_user(pg_temp.u(3));
select is(pg_temp.err(format($$select * from servicing.my_loan_activity(%L)$$, pg_temp.lid(1))), 'P0002|', 'a lender user is not a borrower: not found');
select pg_temp.as_anon();
select is(pg_temp.err(format($$select * from servicing.my_loan_activity(%L)$$, pg_temp.lid(1))), '42501|', 'anon is refused');

-- ============================================================================================================================
-- 9. What can be paid now
-- ============================================================================================================================
select pg_temp.as_user(pg_temp.u(1));
select is((select (o ->> 'available', o ->> 'unavailable_key', o ->> 'destination_masked_ref', o ->> 'figures_available', o ->> 'stale', o ->> 'lender_display_name')::text
           from (select pg_temp.opts('payments.my_payment_options', pg_temp.lid(1)) o) x), '(true,,XXXXXX1111,true,false,Alpha)', 'loan 1: payable, to the lender''s masked account, on fresh figures');
select is((select pg_temp.opts('payments.my_payment_options', pg_temp.lid(1)) #> '{purposes}' -> 0 ->> 'purpose' || ',' || (pg_temp.opts('payments.my_payment_options', pg_temp.lid(1)) #> '{purposes}' -> 1 ->> 'purpose') || ',' ||
                 (pg_temp.opts('payments.my_payment_options', pg_temp.lid(1)) #> '{purposes}' -> 2 ->> 'purpose')), 'installment,part_prepayment,foreclosure', 'the installment, a part-prepayment (the lender enabled it) and the foreclosure quotation');
select is((select (o #>> '{purposes,0,amount_minor}', o #>> '{purposes,0,min_minor}', o #>> '{purposes,0,max_minor}', o #>> '{purposes,0,amount_source}', o #>> '{purposes,0,due_on}' = to_char(pg_temp.d() + 3, 'YYYY-MM-DD'))::text
           from (select pg_temp.opts('payments.my_payment_options', pg_temp.lid(1)) o) x), '(475000,100000,475000,lender_reported,t)',
  'the installment is the lender''s reported figure; the lender accepts a part from 1,000.00 (its minimum)');
select is((select (o #>> '{purposes,1,min_minor}', o #>> '{purposes,1,max_minor}', o #>> '{purposes,1,amount_source}')::text from (select pg_temp.opts('payments.my_payment_options', pg_temp.lid(1)) o) x), '(200000,4000000,borrower_within_lender_limits)',
  'a part-prepayment is bounded by the lender''s minimum and the reported outstanding principal');
select is((select (o #>> '{purposes,2,amount_minor}', o #>> '{purposes,2,amount_source}', o #>> '{purposes,2,flagged}', o #>> '{purposes,2,quote_id}' = pg_temp.got('q1'))::text
           from (select pg_temp.opts('payments.my_payment_options', pg_temp.lid(1)) o) x), '(4100000,lender_quote,false,t)', 'a foreclosure payment is exactly the lender''s unexpired quotation');
select is((select (o ->> 'penal_charge', o ->> 'penal_charge_text_missing', jsonb_array_length(o -> 'open_payments'), o #>> '{open_payments,0,intent_id}' = pg_temp.got('i3'), o #>> '{open_payments,0,status}')::text
           from (select pg_temp.opts('payments.my_payment_options', pg_temp.lid(1)) o) x), '(,false,1,t,pending)', 'nothing is overdue so no penal-charge text is needed; the open payment is listed');
select is((select (o ->> 'penal_charge_text_missing', o ->> 'penal_charge', o #>> '{purposes,1,purpose}', o #>> '{purposes,1,amount_minor}')::text from (select pg_temp.opts('payments.my_payment_options', pg_temp.lid(3)) o) x),
  '(true,,overdue,600000)', 'loan 3 is overdue: the reported 6,000.00 is offered and, with no approved penal-charge text, the answer says it is missing (the app shows nothing in its place)');
select pg_temp.as_owner();
set local session_replication_role = replica;
insert into servicing.penal_charge_texts (lender_org_id, version, status, charge_kind, flat_amount_minor, separate_from_interest, not_compounded, reason, sentence_en, drafted_by, approved_by, approved_at)
  values (pg_temp.lx(), 1, 'approved', 'flat', 50000, true, true, 'Charge as per the loan agreement', 'A separate penal charge applies to the overdue amount as per your loan agreement.', pg_temp.u(3), pg_temp.u(4), now());
set local session_replication_role = origin;
select pg_temp.as_user(pg_temp.u(1));
select is((select (o ->> 'penal_charge_text_missing', o #>> '{penal_charge,version}', o #>> '{penal_charge,sentence_en}', o #>> '{penal_charge,sentence_hi}')::text from (select pg_temp.opts('payments.my_payment_options', pg_temp.lid(3)) o) x),
  '(false,1,"A separate penal charge applies to the overdue amount as per your loan agreement.",)', 'with the lender''s approved sentence the app shows exactly that sentence (no Hindi text was approved, so none is offered)');
select is((select (o #>> '{purposes,3,purpose}', o #>> '{purposes,3,amount_minor}', o #>> '{purposes,3,flagged}')::text from (select pg_temp.opts('payments.my_payment_options', pg_temp.lid(3)) o) x), '(foreclosure,4000000,true)',
  'a lender quotation whose parts do not add up is offered as flagged, never corrected: the app must not let it be paid');
select is((select (o ->> 'unavailable_key', o ->> 'destination_masked_ref', jsonb_array_length(o -> 'purposes'))::text from (select pg_temp.opts('payments.my_payment_options', pg_temp.lid(4)) o) x), '(,XXXXXX2222,1)',
  'lender Y has its own destination account and, with no policy, only the exact installment (no partial amount)');
select is((select o #>> '{purposes,0,min_minor}' from (select pg_temp.opts('payments.my_payment_options', pg_temp.lid(4)) o) x), '475000', 'whose minimum equals its maximum');
select pg_temp.as_owner();
set local session_replication_role = replica;
update servicing.balance_snapshots set reported_as_of = now() - interval '3 days' where loan_account_id = pg_temp.lid(2);
set local session_replication_role = origin;
select pg_temp.as_user(pg_temp.u(2));
select is((select (o ->> 'available', o ->> 'figures_available', o ->> 'stale', jsonb_array_length(o -> 'purposes'))::text from (select pg_temp.opts('payments.my_payment_options', pg_temp.lid(2)) o) x), '(true,true,true,0)',
  'figures older than the staleness threshold are flagged and no amount-dependent purpose is offered');
select pg_temp.as_owner();
set local session_replication_role = replica;
update servicing.loan_accounts set status = 'closed' where id = pg_temp.lid(3);
set local session_replication_role = origin;
select pg_temp.as_user(pg_temp.u(1));
select is((select (o ->> 'available', o ->> 'unavailable_key', o ->> 'destination_masked_ref', jsonb_array_length(o -> 'purposes'))::text from (select pg_temp.opts('payments.my_payment_options', pg_temp.lid(3)) o) x),
  '(false,loan_not_active,,0)', 'a closed loan offers nothing');
select pg_temp.as_owner();
set local session_replication_role = replica;
update servicing.loan_accounts set status = 'active' where id = pg_temp.lid(3);
set local session_replication_role = origin;
select pg_temp.as_user(pg_temp.u(2));
select is(pg_temp.err(format($$select pg_temp.opts('payments.my_payment_options', %L)$$, pg_temp.lid(1))), 'P0002|', 'another borrower''s loan is not found');
select pg_temp.as_user(pg_temp.u(3));
select is(pg_temp.err(format($$select pg_temp.opts('payments.my_payment_options', %L)$$, pg_temp.lid(1))), 'P0002|', 'a lender user is not a borrower: not found');
select pg_temp.as_anon();
select is(pg_temp.err(format($$select pg_temp.opts('payments.my_payment_options', %L)$$, pg_temp.lid(1))), '42501|', 'anon is refused');
select pg_temp.as_owner();
set local session_replication_role = replica;
update servicing.lender_features set enabled = false where lender_org_id = pg_temp.lx() and feature = 'payments';
set local session_replication_role = origin;
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err(format($$select pg_temp.opts('payments.my_payment_options', %L)$$, pg_temp.lid(1))), 'P0002|', 'with the lender''s payments switch off the loan offers nothing');
select pg_temp.as_owner();
set local session_replication_role = replica;
update servicing.lender_features set enabled = true where lender_org_id = pg_temp.lx() and feature = 'payments';
set local session_replication_role = origin;
select pg_temp.as_user(pg_temp.u(1));
select is((select count(*) from (select jsonb_object_keys(pg_temp.opts('payments.my_payment_options', pg_temp.lid(1))) k) x where k ~* 'fingerprint|account_number|ifsc|secret|token|link'), 0::bigint,
  'the answer has no key that could carry an account number, a fingerprint, a secret or a link');

-- ============================================================================================================================
-- 10. Debits of a mandate
-- ============================================================================================================================
select pg_temp.as_owner();
set local session_replication_role = replica;
insert into payments.mandate_debits (lender_org_id, mandate_id, loan_account_id, planned, schedule_snapshot_id, installment_seq, scheduled_on, amount_minor, status, provider_debit_ref, return_code, return_class)
  select pg_temp.lx(), pg_temp.mid(1), pg_temp.lid(1), v.planned, case when v.planned then (select id from servicing.schedule_snapshots where loan_account_id = pg_temp.lid(1) and version = 1) end, v.seq, v.on_date, 475000, v.status, v.ref, v.code, v.class
  from (values (true, 1, pg_temp.d()::date + 3, 'notified', null, null, null), (true, 2, pg_temp.d()::date + 33, 'scheduled', null, null, null),
               (false, null::integer, pg_temp.d()::date - 30, 'returned', 'SAMPLE-DEBIT-1', 'R01', 'insufficient_funds'), (false, null::integer, pg_temp.d()::date - 60, 'settled', 'SAMPLE-DEBIT-0', null, null)) v (planned, seq, on_date, status, ref, code, class);
set local session_replication_role = origin;
select pg_temp.as_owner();
set local session_replication_role = replica;
insert into payments.pre_debit_notices (lender_org_id, debit_id, mandate_id, borrower_id, notice_due_at, status, delivery_state, sent_at)
  select pg_temp.lx(), d.id, d.mandate_id, pg_temp.got('b1')::uuid, now() + interval '1 day', case when d.installment_seq = 1 then 'sent' else 'planned' end,
         case when d.installment_seq = 1 then 'accepted' end, case when d.installment_seq = 1 then now() - interval '1 hour' end
  from payments.mandate_debits d where d.planned and d.mandate_id = pg_temp.mid(1);
set local session_replication_role = origin;
select pg_temp.as_user(pg_temp.u(1));
select is((select array_agg(status) from payments.my_mandate_debits(pg_temp.mid(1))), array['scheduled', 'notified', 'returned', 'settled'], 'the mandate''s debits, newest first, with their status');
select is((select array_agg(coalesce(notice_status, '-')) from payments.my_mandate_debits(pg_temp.mid(1))), array['planned', 'sent', '-', '-'], 'and the state of each pre-debit notice');
select is((select (planned, return_code, return_class, amount_minor)::text from payments.my_mandate_debits(pg_temp.mid(1)) where status = 'returned'), '(f,R01,insufficient_funds,475000)', 'a returned debit shows the provider''s code and the class the configuration gave it; it is unplanned');
select is((select notice_sent_at is not null from payments.my_mandate_debits(pg_temp.mid(1)) where status = 'notified'), true, 'a sent notice has its time');
select pg_temp.as_user(pg_temp.u(2));
select is(pg_temp.err(format($$select * from payments.my_mandate_debits(%L)$$, pg_temp.mid(1))), 'P0002|', 'another borrower cannot see them');
select pg_temp.as_user(pg_temp.u(3));
select is(pg_temp.err(format($$select * from payments.my_mandate_debits(%L)$$, pg_temp.mid(1))), '42501|', 'a lender user is not a borrower: refused');
select pg_temp.as_anon();
select is(pg_temp.err(format($$select * from payments.my_mandate_debits(%L)$$, pg_temp.mid(1))), '42501|', 'anon is refused');
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err(format($$select * from payments.my_mandate_debits(%L)$$, gen_random_uuid())), 'P0002|', 'an unknown mandate is not found');
select pg_temp.as_owner();
set local session_replication_role = replica;
update servicing.lender_features set enabled = false where lender_org_id = pg_temp.lx() and feature = 'mandates';
set local session_replication_role = origin;
select pg_temp.as_user(pg_temp.u(1));
-- A mandate that is not over stays readable to its borrower when the lender's switch is off (decision U9 of the review fixes); a finished one is hidden.
select is(pg_temp.err(format($$select * from payments.my_mandate_debits(%L)$$, pg_temp.mid(1))), 'ok', 'with the lender''s mandates switch off a live mandate stays readable');
select pg_temp.as_owner();
set local session_replication_role = replica;
update servicing.lender_features set enabled = true where lender_org_id = pg_temp.lx() and feature = 'mandates';
set local session_replication_role = origin;

-- ============================================================================================================================
-- 11. A configuration that is no longer valid
-- ============================================================================================================================
select pg_temp.as_owner();
set local session_replication_role = replica;
update tenancy.lender_settlement_accounts set status = 'unverified' where id = 'fce10000-0000-4000-8000-000000000003';
set local session_replication_role = origin;
select pg_temp.as_user(pg_temp.u(1));
select is((select (o ->> 'available', o ->> 'unavailable_key', o ->> 'destination_masked_ref')::text from (select pg_temp.opts('payments.my_payment_options', pg_temp.lid(5)) o) x), '(false,collection_target_invalid,)',
  'an ACTIVE configuration whose settlement account is no longer verified is not a valid collection target: nothing is offered');
select is((select o ->> 'unavailable_key' from (select pg_temp.opts('payments.my_mandate_options', pg_temp.lid(5)) o) x), 'collection_target_invalid', 'and no mandate either (this is checked before the rails)');
select pg_temp.as_system();
select is(payments.system_suspend_payment_config(pg_temp.cfg(pg_temp.lx()), 'merchant_mismatch'), 'suspended', 'fixture: the system suspends lender X''s payment configuration');
select pg_temp.as_user(pg_temp.u(1));
select is((select (o ->> 'available', o ->> 'unavailable_key', o ->> 'destination_masked_ref', jsonb_array_length(o -> 'purposes'))::text from (select pg_temp.opts('payments.my_payment_options', pg_temp.lid(1)) o) x),
  '(false,collection_target_invalid,,0)', 'with no valid collection target no payment is offered');
select is((select (o ->> 'available', o ->> 'unavailable_key')::text from (select pg_temp.opts('payments.my_mandate_options', pg_temp.lid(3)) o) x), '(false,collection_target_invalid)', 'and no mandate');

select * from finish();
rollback;
