-- Phase 08a reconciliation (migration 20261018000916). Provider settlement reports, the lender's bank credits and the lender's own LMS receipts are matched
-- EXACTLY (never fuzzy); a missing input is "not reconcilable", never "reconciled"; every difference becomes an exception raised once; the run changes no money
-- row; the settlement stage of a payment is derived, never set. Synthetic data only (labelled SAMPLE). Error codes are reported as SQLSTATE|hint.
begin;
create extension if not exists pgtap with schema extensions;
select plan(115);

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
create function pg_temp.u(n integer) returns uuid language sql as $fn$ select ('fd000000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid $fn$;
create function pg_temp.sha(k text) returns text language sql as $fn$ select encode(sha256(convert_to('SAMPLE-022-' || k, 'UTF8')), 'hex') $fn$;
create function pg_temp.tok(p_lender uuid) returns text language sql as $fn$ select encode(sha256(convert_to('SAMPLE-TOKEN-' || p_lender::text, 'UTF8')), 'hex') $fn$;
create function pg_temp.lx() returns uuid language sql as $fn$ select 'fdb00000-0000-4000-8000-000000000001'::uuid $fn$;
create function pg_temp.ly() returns uuid language sql as $fn$ select 'fdb00000-0000-4000-8000-000000000002'::uuid $fn$;
create function pg_temp.lid(n integer) returns uuid language sql as $fn$ select ('fd400000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid $fn$;
create function pg_temp.d() returns date language sql as $fn$ select (now() at time zone 'Asia/Kolkata')::date $fn$;
create function pg_temp.exc(p_class text) returns bigint language sql as $fn$ select count(*) from payments.reconciliation_exceptions where class = p_class and status <> 'resolved' $fn$;
create function pg_temp.exc_for(p_class text, p_key text, p_id uuid) returns bigint language sql as $fn$
  select count(*) from payments.reconciliation_exceptions where class = p_class and subject ->> p_key = p_id::text
$fn$;
create function pg_temp.ago(p_days integer) returns text language sql as $fn$
  select to_char((clock_timestamp() - make_interval(days => p_days)) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
$fn$;

-- A SAMPLE collection configuration (mock mode, verified registry entry, active). Call as the owner.
create function pg_temp.sample_config(p_lender uuid, p_settlement uuid, p_masked text, p_provider text) returns uuid language plpgsql as $fn$
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
    values (p_provider, 'SAMPLE provider (fixture)', 'payment', 'approved', 'SAMPLE-AUTH-EVIDENCE-1') on conflict (provider) do nothing;
  insert into payments.merchant_registry (provider, merchant_ref, owner_kind, owner_org_id, purpose, claimed_by, verification_status, verification_evidence_ref, verified_by, verified_at)
    values (p_provider, 'SAMPLE-MERCHANT-' || v_tag, 'lender', p_lender, 'repayment', u1, 'verified', 'SAMPLE-EVIDENCE-3', u2, now()) returning id into v_mer;
  insert into payments.lender_payment_configs (lender_org_id, provider, provider_mode, merchant_registry_id, settlement_account_id, secret_ref, webhook_secret_ref, endpoint_token_hash,
                                               evidence_ref, contract_section_ref, idempotency_key, drafted_by)
    values (p_lender, p_provider, 'mock', v_mer, p_settlement, 'SAMPLE_SECRET', 'SAMPLE_WEBHOOK_SECRET', encode(sha256(convert_to('SAMPLE-TOKEN-' || p_lender::text, 'UTF8')), 'hex'),
            'SAMPLE-EVIDENCE-2', 'SAMPLE-CONTRACT-1', 'sample-fixture-config-' || v_tag, u1) returning id into v_cfg;
  update payments.lender_payment_configs set status = 'pending_approval', submitted_by = u3, submitted_at = now(), status_changed_by = u3 where id = v_cfg;
  update payments.lender_payment_configs set status = 'active', approved_by = u2, approved_at = now(), status_changed_by = u2 where id = v_cfg;
  return v_cfg;
end
$fn$;

create function pg_temp.dlv(p_delivery text, p_event text, p_status text, p_obj text, p_order text, p_amount bigint, p_occurred text) returns jsonb language sql as $fn$
  select jsonb_build_object(
    'provider', 'mock_gateway', 'outcome', 'verified', 'reason_class', 'none', 'delivery_id', p_delivery, 'payload_sha256', pg_temp.sha('body-' || p_delivery),
    'scheme', 'mock-standard-webhooks-v1', 'signature_present', true, 'timestamp_skew_seconds', 3, 'body_bytes', 420, 'ip_hmac', repeat('a', 64),
    'event', jsonb_build_object('provider', 'mock_gateway', 'deliveryId', p_delivery, 'eventId', p_event, 'objectKind', 'payment', 'objectRef', p_obj, 'orderRef', p_order, 'status', p_status,
      'rank', 30, 'amountMinor', p_amount::text, 'currency', 'INR', 'occurredAt', p_occurred));
$fn$;
-- One captured payment for loan n: the borrower asks, the worker records the order, the provider's verified event captures it, the worker applies it.
create function pg_temp.captured(p_n integer, p_days_ago integer) returns void language plpgsql as $fn$
declare v_intent uuid; v_ev text := 'SAMPLE-E-' || p_n;
begin
  perform pg_temp.as_user(pg_temp.u(1));
  v_intent := payments.request_payment(pg_temp.lid(p_n), 'installment', 475000, 'fd-request-key-' || lpad(p_n::text, 6, '0'));
  perform pg_temp.as_system();
  perform payments.record_order_created(v_intent, 'ORD-' || p_n);
  perform payments.ingest_provider_delivery(pg_temp.tok(pg_temp.lx()), pg_temp.dlv('SAMPLE-D-' || p_n, v_ev, 'captured', 'PAY-' || p_n, 'ORD-' || p_n, 475000, pg_temp.ago(p_days_ago)));
  perform payments.apply_provider_event((select id from payments.provider_events where provider_event_id = v_ev));
  perform set_config('t.intent' || p_n, v_intent::text, true);
end
$fn$;
create function pg_temp.pp(p_n integer) returns uuid language sql as $fn$ select id from payments.provider_payments where provider_payment_ref = 'PAY-' || p_n $fn$;
create function pg_temp.report(p_batches jsonb) returns jsonb language sql as $fn$ select payments.record_settlement_report(pg_temp.got('cfg')::uuid, pg_temp.d(), p_batches) $fn$;
create function pg_temp.batch(p_ref text, p_utr text, p_days_ago integer, p_net bigint, p_items jsonb, p_dest text default 'XXXXXX1111') returns jsonb language sql as $fn$
  select jsonb_strip_nulls(jsonb_build_object('batchRef', p_ref, 'settlementRef', p_utr, 'periodFrom', to_char(pg_temp.d() - p_days_ago, 'YYYY-MM-DD'), 'periodTo', to_char(pg_temp.d() - p_days_ago, 'YYYY-MM-DD'),
    'destinationMaskedRef', p_dest, 'grossMinor', p_net::text, 'feeMinor', '0', 'taxMinor', '0', 'netMinor', p_net::text, 'items', p_items))
$fn$;
create function pg_temp.item(p_ref text, p_gross bigint) returns jsonb language sql as $fn$
  select jsonb_build_object('providerPaymentRef', p_ref, 'grossMinor', p_gross::text, 'feeMinor', '0', 'taxMinor', '0', 'netMinor', p_gross::text)
$fn$;
create function pg_temp.run(p_date date default null) returns jsonb language sql as $fn$ select payments.run_reconciliation(pg_temp.lx(), coalesce(p_date, pg_temp.d())) $fn$;
create function pg_temp.truth() returns text language sql as $fn$
  select md5(coalesce((select string_agg(to_jsonb(i)::text, '|' order by i.id) from payments.payment_intents i), '') || '#' ||
             coalesce((select string_agg(to_jsonb(p)::text, '|' order by p.id) from payments.provider_payments p), '') || '#' ||
             coalesce((select string_agg(to_jsonb(r)::text, '|' order by r.id) from servicing.lms_receipts r), '') || '#' ||
             coalesce((select string_agg(to_jsonb(s)::text, '|' order by s.id) from payments.settlement_items s), '') || '#' ||
             coalesce((select string_agg(to_jsonb(c)::text, '|' order by c.id) from payments.bank_credits c), ''))
$fn$;
grant execute on all functions in schema pg_temp to public;

-- Fixture -----------------------------------------------------------------------------------------------------------------------
-- Users: 01 borrower, 03 lender X reconciler (payment.read, payment.reconcile), 04 lender X payments admin (payment.configure, payment.read), 05 lender X viewer,
-- 06 lender Y viewer, 07 platform payments admin, 08 and 09 switch fixture, 10 and 11 loan product maker and checker.
insert into auth.users (id, phone, raw_app_meta_data)
select pg_temp.u(n), case when n = 1 then '91000000091' end, case when n = 1 then '{}'::jsonb else '{"actor_type":"staff"}'::jsonb end from generate_series(1, 11) n;
select pg_temp.keep('b1', (select id::text from identity.borrowers where user_id = pg_temp.u(1)));

select pg_temp.as_owner();
select set_config('udofin.allow_mock_providers', 'on', true);
insert into tenancy.organizations (id, kind, legal_name, display_name, regulator_registration_no, status) values
  ('fda00000-0000-4000-8000-000000000000', 'platform', 'Udofin Platform (test)', 'Udofin', null, 'active'),
  (pg_temp.lx(), 'lender', 'Alpha Finance Ltd (test)', 'Alpha', 'TEST-FD-0001', 'active'),
  (pg_temp.ly(), 'lender', 'Beta Capital Ltd (test)', 'Beta', 'TEST-FD-0002', 'active');
insert into tenancy.memberships (id, org_id, user_id, status) values
  ('fdc10000-0000-4000-8000-000000000003', pg_temp.lx(), pg_temp.u(3), 'active'),
  ('fdc10000-0000-4000-8000-000000000004', pg_temp.lx(), pg_temp.u(4), 'active'),
  ('fdc10000-0000-4000-8000-000000000005', pg_temp.lx(), pg_temp.u(5), 'active'),
  ('fdc10000-0000-4000-8000-000000000006', pg_temp.ly(), pg_temp.u(6), 'active'),
  ('fdc10000-0000-4000-8000-000000000007', 'fda00000-0000-4000-8000-000000000000', pg_temp.u(7), 'active'),
  ('fdc10000-0000-4000-8000-000000000019', pg_temp.lx(), pg_temp.u(10), 'active'),
  ('fdc10000-0000-4000-8000-000000000020', pg_temp.lx(), pg_temp.u(11), 'active'),
  ('fdc10000-0000-4000-8000-000000000021', pg_temp.ly(), pg_temp.u(10), 'active'),
  ('fdc10000-0000-4000-8000-000000000022', pg_temp.ly(), pg_temp.u(11), 'active');
insert into tenancy.membership_roles (membership_id, role_id)
select g.mid::uuid, r.id from (values
  ('fdc10000-0000-4000-8000-000000000003', 'lender', 'reconciler'), ('fdc10000-0000-4000-8000-000000000004', 'lender', 'payments_admin'),
  ('fdc10000-0000-4000-8000-000000000005', 'lender', 'viewer'), ('fdc10000-0000-4000-8000-000000000006', 'lender', 'viewer'),
  ('fdc10000-0000-4000-8000-000000000007', 'platform', 'platform_payments_admin'),
  ('fdc10000-0000-4000-8000-000000000019', 'lender', 'lender_admin'), ('fdc10000-0000-4000-8000-000000000020', 'lender', 'product_approver'),
  ('fdc10000-0000-4000-8000-000000000021', 'lender', 'lender_admin'), ('fdc10000-0000-4000-8000-000000000022', 'lender', 'product_approver')) as g (mid, kind, rkey)
join tenancy.roles r on r.org_id is null and r.applies_to = g.kind::tenancy.organization_kind and r.key = g.rkey;
select pg_temp.keep('cfg', pg_temp.sample_config(pg_temp.lx(), 'fde10000-0000-4000-8000-000000000001', 'XXXXXX1111', 'mock_gateway')::text);
select pg_temp.sample_config(pg_temp.ly(), 'fde10000-0000-4000-8000-000000000002', 'XXXXXX2222', 'mock_gateway_pay');
-- A second account of lender X (not the configured settlement account).
insert into tenancy.lender_settlement_accounts (id, lender_org_id, label, bank_name, masked_account_ref, status) values
  ('fde10000-0000-4000-8000-000000000009', pg_temp.lx(), 'SAMPLE other account', 'Test Bank', 'XXXXXX7777', 'unverified');
-- The LMS feed of lender X reports receipts.
insert into servicing.lms_connections (lender_org_id, kind, status, provider_mode, capabilities) values (pg_temp.lx(), 'file_import', 'active', 'production', '{"receipts": true}'::jsonb);

insert into servicing.feature_change_requests (lender_org_id, feature, enable, mode, status, evidence, requested_by, idempotency_key, decided_by, decided_at, applied_at)
select o.lender, f.feature, true, 'two_person', 'applied', '{"contract_ref":"SAMPLE-FD"}', pg_temp.u(8), 'fd-req-' || f.feature || '-' || right(o.lender::text, 1) || '-0001', pg_temp.u(9), now(), now()
from (values (pg_temp.lx()), (pg_temp.ly())) o (lender) cross join (values ('payments'), ('servicing_sync')) f (feature);
insert into servicing.lender_features (lender_org_id, feature, enabled, evidence, enabled_by, enabled_at, last_change_request_id)
select r.lender_org_id, r.feature, true, r.evidence, pg_temp.u(9), now(), r.id from servicing.feature_change_requests r;

-- Loans 1 to 8 (lender X, the borrower), each with fresh lender-reported figures: 4,750.00 due in three days.
insert into lending.loan_products (id, lender_org_id, category_key, code, name, status) values
  ('fd900000-0000-4000-8000-000000000001', pg_temp.lx(), 'personal', 'PL-FD', 'X Personal Loan', 'active');
insert into lending.loan_product_versions (id, product_id, lender_org_id, version, status, min_amount_minor, max_amount_minor, min_tenure_days, max_tenure_days,
  rate_type, min_annual_rate_bps, max_annual_rate_bps, drafted_by, approved_by, approved_at, effective_from)
values ('fd910000-0000-4000-8000-000000000001', 'fd900000-0000-4000-8000-000000000001', pg_temp.lx(), 1, 'approved', 1000000, 50000000, 180, 1825, 'fixed', 1400, 2400, pg_temp.u(10), pg_temp.u(11), now(), now());
insert into lending.loan_requests (id, borrower_id, category_key, requested_amount_minor, requested_tenure_days, purpose_code, status)
select ('fd700000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, pg_temp.got('b1')::uuid, 'personal', 5000000, 365, 'education', 'submitted' from generate_series(1, 8) n;
insert into lending.applications (id, lender_org_id, loan_request_id, borrower_id, product_version_id, status, requested_amount_minor, requested_tenure_days, lender_reference)
select ('fd200000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, pg_temp.lx(), ('fd700000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, pg_temp.got('b1')::uuid,
       'fd910000-0000-4000-8000-000000000001', 'disbursed', 5000000, 365, 'SAMPLE-APP-' || n from generate_series(1, 8) n;
insert into servicing.loan_accounts (id, lender_org_id, application_id, borrower_id, source_system, lms_loan_ref, status, sanctioned_amount_minor)
select pg_temp.lid(n), pg_temp.lx(), a.id, a.borrower_id, 'lender_lms', 'SAMPLE-LN-' || n, 'active', 5000000
from lending.applications a, generate_series(1, 8) n where right(a.id::text, 2)::int = n;
insert into servicing.balance_snapshots (lender_org_id, loan_account_id, version, status, outstanding_principal_minor, total_overdue_minor, next_due_on, next_due_minor, days_past_due,
  source_system, source_record_id, reported_as_of, content_sha256)
select l.lender_org_id, l.id, 1, 'active', 4000000, 0, pg_temp.d() + 3, 475000, 0, 'file_import', 'SRC-' || l.lms_loan_ref, clock_timestamp() - interval '1 hour', pg_temp.sha('snap-' || l.lms_loan_ref)
from servicing.loan_accounts l;
insert into servicing.schedule_snapshots (id, lender_org_id, loan_account_id, version)
select ('fd500000-0000-4000-8000-0000000000' || lpad(right(l.id::text, 2)::int::text, 2, '0'))::uuid, l.lender_org_id, l.id, 1 from servicing.loan_accounts l;
insert into servicing.schedule_installments (snapshot_id, lender_org_id, seq, due_date, principal_minor, interest_minor)
select s.id, s.lender_org_id, 1, pg_temp.d() + 3, 400000, 75000 from servicing.schedule_snapshots s;

-- Eight captured payments through the real path: 1 (full chain), 2 (the provider settles another amount), 3 (never settled), 4 (settled, never credited),
-- 5 (credited; the lender posted it and then reversed the receipt), 6 and 7 (6 is used for the destination check), 8 (captured yesterday: still inside every waiting time).
select pg_temp.captured(1, 5);
select pg_temp.captured(2, 5);
select pg_temp.captured(3, 10);
select pg_temp.captured(4, 10);
select pg_temp.captured(5, 10);
select pg_temp.captured(6, 5);
select pg_temp.captured(7, 5);
select pg_temp.captured(8, 1);
select pg_temp.as_system();

-- ============================================================================================================================
-- 1. Structure and grants
-- ============================================================================================================================
select is((select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'payments' and c.relname in ('reconciliation_settings', 'settlement_batches', 'settlement_items', 'bank_credits', 'reconciliation_runs', 'reconciliation_matches')
             and c.relrowsecurity and c.relforcerowsecurity), 6::bigint, 'row level security is enabled and forced on all six new tables');
select is((select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'payments' and c.relname in ('reconciliation_settings', 'settlement_batches', 'settlement_items', 'bank_credits', 'reconciliation_runs', 'reconciliation_matches')
             and obj_description(c.oid, 'pg_class') like '%Owner: payments module.'), 6::bigint, 'every new table has a comment naming its owner module');
select is((select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'payments' and t.tgname = 'no_truncate' and not t.tgisinternal
             and c.relname in ('reconciliation_settings', 'settlement_batches', 'settlement_items', 'bank_credits', 'reconciliation_runs', 'reconciliation_matches')), 6::bigint, 'a no_truncate trigger is on every new table');
select ok((select bool_and(has_table_privilege('service_role', t, 'select') and not has_table_privilege('service_role', t, 'insert') and not has_table_privilege('service_role', t, 'update')
                           and not has_table_privilege('service_role', t, 'delete'))
           from unnest(array['payments.reconciliation_settings', 'payments.settlement_batches', 'payments.settlement_items', 'payments.bank_credits', 'payments.reconciliation_runs',
                             'payments.reconciliation_matches']) t), 'the system role can only READ the reconciliation tables');
select ok((select bool_and(not has_table_privilege('authenticated', t, 'insert') and not has_table_privilege('authenticated', t, 'update') and not has_table_privilege('authenticated', t, 'delete'))
           from unnest(array['payments.reconciliation_settings', 'payments.settlement_batches', 'payments.settlement_items', 'payments.bank_credits', 'payments.reconciliation_runs',
                             'payments.reconciliation_matches']) t), 'and no signed-in role can write them directly');
select ok((select bool_and(not has_function_privilege('anon', f, 'execute'))
           from unnest(array['payments.record_settlement_report(uuid, date, jsonb)', 'payments.import_bank_credits(uuid, uuid, jsonb)', 'payments.run_reconciliation(uuid, date)',
                             'payments.set_reconciliation_settings(uuid, integer, integer)', 'payments.reconciliation_summary(uuid, date)']) f), 'anon can execute none of the reconciliation functions');
select ok((select bool_and(not has_function_privilege('authenticated', f, 'execute'))
           from unnest(array['payments.record_settlement_report(uuid, date, jsonb)', 'payments.run_reconciliation(uuid, date)']) f), 'a signed-in user cannot record a provider report or run a reconciliation: only the system can');
select ok((select bool_and(not has_function_privilege('service_role', f, 'execute'))
           from unnest(array['payments.import_bank_credits(uuid, uuid, jsonb)', 'payments.set_reconciliation_settings(uuid, integer, integer)']) f), 'and the system cannot upload a lender''s bank credits or change its settings');
select is((select count(*) from information_schema.columns where table_schema = 'payments' and table_name in ('bank_credits', 'settlement_batches', 'settlement_items', 'reconciliation_matches', 'reconciliation_runs')
             and column_name ~* '(narration|remark|description|name|account_number|account_no|ifsc|phone|email|text)$'), 0::bigint, 'no column can hold a narration, a name or an account number: value date, amount and UTR only');
select is((select count(*) from payments.reconciliation_runs) + (select count(*) from payments.settlement_batches) + (select count(*) from payments.bank_credits), 0::bigint, 'nothing is seeded');

-- ============================================================================================================================
-- 2. The lender's waiting times
-- ============================================================================================================================
select pg_temp.as_user(pg_temp.u(5));
select is(pg_temp.err(format($$select payments.set_reconciliation_settings(%L, 3, 72)$$, pg_temp.lx())), '42501|', 'a reader cannot set the waiting times');
select pg_temp.as_user(pg_temp.u(4), 'aal1');
select is(pg_temp.err(format($$select payments.set_reconciliation_settings(%L, 3, 72)$$, pg_temp.lx())), '42501|mfa_required', 'nor without the second factor');
select pg_temp.as_user(pg_temp.u(4));
select is(pg_temp.err(format($$select payments.set_reconciliation_settings(%L, 3, 72)$$, pg_temp.ly())), '42501|', 'nor for another lender');
select is(pg_temp.err(format($$select payments.set_reconciliation_settings(%L, 0, 72)$$, pg_temp.lx())), '22023|settings_invalid', 'zero days is refused');
select is(pg_temp.err(format($$select payments.set_reconciliation_settings(%L, 3, 1000)$$, pg_temp.lx())), '22023|settings_invalid', 'and so is a month and a half of hours');
select is(payments.set_reconciliation_settings(pg_temp.lx(), 3, 72), 'set', 'the lender states the platform defaults explicitly');
select pg_temp.as_system();

-- ============================================================================================================================
-- 3. What the provider settled
-- ============================================================================================================================
select is(pg_temp.err(format($$select payments.record_settlement_report(%L, current_date, '[]'::jsonb)$$, pg_temp.got('cfg'))), 'ok', 'an empty report is accepted (nothing settled that day)');
select pg_temp.as_user(pg_temp.u(3));
select is(pg_temp.err(format($$select payments.record_settlement_report(%L, current_date, '[]'::jsonb)$$, pg_temp.got('cfg'))), '42501|', 'a lender user cannot record a provider report');
select pg_temp.as_system();
select is(pg_temp.err(format($$select payments.record_settlement_report(%L, current_date, '{}'::jsonb)$$, pg_temp.got('cfg'))), '22023|bad_request', 'a report that is not a list is refused');
select is(pg_temp.err(format($$select payments.record_settlement_report(gen_random_uuid(), current_date, '[]'::jsonb)$$)), 'P0002|', 'an unknown configuration answers not found');
select is(pg_temp.err(format($$select pg_temp.report(jsonb_build_array(pg_temp.batch('B-BAD', 'UTR-BAD', 1, 100, '[]'::jsonb) - 'netMinor'))$$)), '22023|bad_request', 'a batch without its net amount is refused');
select is(pg_temp.err($$select pg_temp.report(jsonb_build_array(jsonb_set(pg_temp.batch('B-BAD', 'UTR-BAD', 1, 100, '[]'::jsonb), '{grossMinor}', '"12.50"')))$$), '22023|bad_request', 'money must be a digit string of paise: a decimal is refused');
select is(pg_temp.err($$select pg_temp.report(jsonb_build_array(jsonb_set(pg_temp.batch('B-BAD', 'UTR-BAD', 1, 100, '[]'::jsonb), '{periodFrom}', '"2026-02-30"')))$$), '22023|bad_request', 'an impossible date is refused');
select is(pg_temp.err($$select pg_temp.report(jsonb_build_array(pg_temp.batch('B-BAD', 'UTR-BAD', 1, 100, jsonb_build_array(jsonb_build_object('providerPaymentRef', 'has space', 'grossMinor', '1', 'feeMinor', '0', 'taxMinor', '0', 'netMinor', '1')))))$$),
  '22023|bad_request', 'a malformed item reference is refused');
select is((select count(*) from payments.settlement_batches), 0::bigint, 'and nothing was recorded by any refused report (all or nothing)');
select is(pg_temp.report(jsonb_build_array(
    pg_temp.batch('B-1', 'SAMP000000000001', 4, 475000, jsonb_build_array(pg_temp.item('PAY-1', 475000))),
    pg_temp.batch('B-2', 'SAMP000000000002', 4, 470000, jsonb_build_array(pg_temp.item('PAY-2', 470000))),
    pg_temp.batch('B-4', 'SAMP000000000004', 9, 475000, jsonb_build_array(pg_temp.item('PAY-4', 475000))),
    pg_temp.batch('B-5', 'SAMP000000000005', 9, 475000, jsonb_build_array(pg_temp.item('PAY-5', 475000))),
    pg_temp.batch('B-6', 'SAMP000000000006', 9, 300000, '[]'::jsonb),
    pg_temp.batch('B-8', 'SAMP000000000008', 9, 200000, '[]'::jsonb),
    pg_temp.batch('B-G', 'SAMP000000000007', 4, 100000, jsonb_build_array(pg_temp.item('PAY-GHOST', 100000))))),
  jsonb_build_object('recorded', 7, 'duplicates', 0, 'conflicts', 0), 'a provider report is recorded');
select is(pg_temp.report(jsonb_build_array(pg_temp.batch('B-1', 'SAMP000000000001', 4, 475000, jsonb_build_array(pg_temp.item('PAY-1', 475000))))),
  jsonb_build_object('recorded', 0, 'duplicates', 1, 'conflicts', 0), 'the same batch again is a duplicate and writes nothing');
select is(pg_temp.report(jsonb_build_array(pg_temp.batch('B-1', 'SAMP000000000001', 4, 475001, jsonb_build_array(pg_temp.item('PAY-1', 475001))))),
  jsonb_build_object('recorded', 0, 'duplicates', 0, 'conflicts', 1), 'the same batch with different content is a conflict and changes nothing');
select pg_temp.as_owner();
select is((select net_minor from payments.settlement_batches where batch_ref = 'B-1'), 475000::bigint, 'the original batch is untouched');
select is(pg_temp.exc('event_payload_conflict'), 3::bigint, 'and the platform is told: the conflicting batch, and the two item-less batches 6 and 8 whose stated totals no item supports (fix SR: items are tied to the batch totals)');
select is((select (destination_ok, parts_mismatch, item_count)::text from payments.settlement_batches where batch_ref = 'B-1'), '(t,f,1)', 'the reported destination is the lender''s verified account');
select is(pg_temp.err($$update payments.settlement_batches set net_minor = 1$$), 'P0001|Record a compensating entry instead.', 'a recorded batch is append-only');
select is(pg_temp.err($$delete from payments.settlement_items$$), 'P0001|Record a compensating entry instead.', 'and so are its items');
select pg_temp.as_system();

-- ============================================================================================================================
-- 4. The lender's bank credits
-- ============================================================================================================================
select pg_temp.as_user(pg_temp.u(5));
select is(pg_temp.err(format($$select payments.import_bank_credits(%L, %L, '[]'::jsonb)$$, pg_temp.lx(), 'fde10000-0000-4000-8000-000000000001')), '42501|', 'a reader cannot upload bank credits');
select pg_temp.as_user(pg_temp.u(3), 'aal1');
select is(pg_temp.err(format($$select payments.import_bank_credits(%L, %L, '[]'::jsonb)$$, pg_temp.lx(), 'fde10000-0000-4000-8000-000000000001')), '42501|mfa_required', 'nor without the second factor');
select pg_temp.as_user(pg_temp.u(3));
select is(pg_temp.err(format($$select payments.import_bank_credits(%L, %L, '[]'::jsonb)$$, pg_temp.lx(), 'fde10000-0000-4000-8000-000000000001')), '22023|bad_request', 'an empty upload is refused');
select is(pg_temp.err(format($$select payments.import_bank_credits(%L, %L, '[{"valueDate":"%s","amountMinor":"100","utr":"SAMPX00000000001"}]'::jsonb)$$, pg_temp.lx(), 'fde10000-0000-4000-8000-000000000002', pg_temp.d())), 'P0002|', 'an account that is not the lender''s own is refused');
select is(pg_temp.err(format($$select payments.import_bank_credits(%L, %L, '[{"valueDate":"%s","amountMinor":"100","utr":"SAMPX00000000001","narration":"Ramesh Kumar EMI"}]'::jsonb)$$, pg_temp.lx(), 'fde10000-0000-4000-8000-000000000001', pg_temp.d())), '22023|unexpected_field',
  'a narration (it can carry a name) refuses the whole upload');
select is(pg_temp.err(format($$select payments.import_bank_credits(%L, %L, '[{"valueDate":"%s","amountMinor":"12.50","utr":"SAMPX00000000001"}]'::jsonb)$$, pg_temp.lx(), 'fde10000-0000-4000-8000-000000000001', pg_temp.d())), '22023|row_invalid', 'a decimal amount is refused');
select is(pg_temp.err(format($$select payments.import_bank_credits(%L, %L, '[{"valueDate":"%s","amountMinor":"100","utr":"SAMPX00000000001"}]'::jsonb)$$, pg_temp.lx(), 'fde10000-0000-4000-8000-000000000001', pg_temp.d() + 30)), '22023|row_invalid', 'a value date in the future is refused');
select is(pg_temp.err(format($$select payments.import_bank_credits(%L, %L, '[{"valueDate":"%s","amountMinor":"100","utr":"SAMPX00000000001"},{"valueDate":"%s","amountMinor":"200","utr":"SAMPX00000000001"}]'::jsonb)$$, pg_temp.lx(), 'fde10000-0000-4000-8000-000000000001', pg_temp.d(), pg_temp.d())),
  '22023|utr_conflict', 'one bank reference twice with different amounts refuses the upload');
select pg_temp.as_owner();
select is((select count(*) from payments.bank_credits), 0::bigint, 'and nothing was written by any refused upload');
select pg_temp.as_user(pg_temp.u(3));
select is(payments.import_bank_credits(pg_temp.lx(), 'fde10000-0000-4000-8000-000000000001'::uuid, format('[
  {"valueDate":"%1$s","amountMinor":"475000","utr":"SAMP000000000001"},
  {"valueDate":"%1$s","amountMinor":"475000","utr":"SAMP000000000005"},
  {"valueDate":"%1$s","amountMinor":"299999","utr":"SAMP000000000006"},
  {"valueDate":"%1$s","amountMinor":"100000","utr":"SAMP000000000007"}]', pg_temp.d() - 3)::jsonb),
  jsonb_build_object('inserted', 4, 'duplicates', 0), 'the lender uploads its credits in the configured account');
select is(payments.import_bank_credits(pg_temp.lx(), 'fde10000-0000-4000-8000-000000000009'::uuid, format('[{"valueDate":"%s","amountMinor":"200000","utr":"SAMP000000000008"}]', pg_temp.d() - 3)::jsonb),
  jsonb_build_object('inserted', 1, 'duplicates', 0), 'and one in its other account');
select is(payments.import_bank_credits(pg_temp.lx(), 'fde10000-0000-4000-8000-000000000001'::uuid, format('[{"valueDate":"%s","amountMinor":"475000","utr":"SAMP000000000001"}]', pg_temp.d() - 3)::jsonb),
  jsonb_build_object('inserted', 0, 'duplicates', 1), 'the same credit again is a duplicate');
select is(pg_temp.err(format($$select payments.import_bank_credits(%L, %L, '[{"valueDate":"%s","amountMinor":"475001","utr":"SAMP000000000001"}]'::jsonb)$$, pg_temp.lx(), 'fde10000-0000-4000-8000-000000000001', pg_temp.d() - 3)), '22023|utr_conflict',
  'the same bank reference with another amount is refused');
select pg_temp.as_owner();
-- The lender's receipts: payment 1 is posted; one receipt names an intent that does not exist.
insert into servicing.lms_receipts (lender_org_id, loan_account_id, kind, lms_receipt_ref, amount_minor, value_date, bank_reference, source_system, source_record_id, reported_as_of, content_sha256)
values (pg_temp.lx(), pg_temp.lid(1), 'receipt', 'SAMPLE-RCPT-1', 475000, pg_temp.d() - 3, 'PAY-1', 'file_import', 'SRC-R1', clock_timestamp() - interval '1 hour', pg_temp.sha('r1')),
       (pg_temp.lx(), pg_temp.lid(2), 'receipt', 'SAMPLE-RCPT-9', 475000, pg_temp.d() - 3, 'fd00dead-0000-4000-8000-000000000001', 'file_import', 'SRC-R9', clock_timestamp() - interval '1 hour', pg_temp.sha('r9')),
       (pg_temp.lx(), pg_temp.lid(5), 'receipt', 'SAMPLE-RCPT-5', 475000, pg_temp.d() - 3, 'PAY-5', 'file_import', 'SRC-R5', clock_timestamp() - interval '1 hour', pg_temp.sha('r5'));
insert into servicing.lms_receipts (lender_org_id, loan_account_id, kind, lms_receipt_ref, reverses_receipt_id, reverses_receipt_ref, amount_minor, value_date, bank_reference, source_system, source_record_id, reported_as_of, content_sha256)
select pg_temp.lx(), pg_temp.lid(5), 'reversal', 'SAMPLE-RCPT-5R', r.id, 'SAMPLE-RCPT-5', 475000, pg_temp.d() - 2, 'PAY-5', 'file_import', 'SRC-R5R', clock_timestamp() - interval '1 hour', pg_temp.sha('r5r')
from servicing.lms_receipts r where r.lms_receipt_ref = 'SAMPLE-RCPT-5';
-- Payments 3 to 5 were captured ten days ago; the clock of the fixture is the event time the provider reported.
select pg_temp.keep('truth', pg_temp.truth());
select pg_temp.as_system();

-- ============================================================================================================================
-- 5. The run
-- ============================================================================================================================
select pg_temp.as_user(pg_temp.u(3));
select is(pg_temp.err($$select pg_temp.run()$$), '42501|', 'a lender user cannot run a reconciliation (a daily system job does)');
select pg_temp.as_system();
select is(pg_temp.err($$select payments.run_reconciliation(gen_random_uuid(), current_date)$$), '22023|bad_request', 'an unknown lender is refused');
select is(pg_temp.err($$select payments.run_reconciliation((select lender_org_id from payments.lender_payment_configs limit 1), current_date + 5)$$), '22023|bad_request', 'a date in the future is refused');
select pg_temp.keep('run1', (pg_temp.run() ->> 'run_id'));
select pg_temp.as_owner();
select is((select counts from payments.reconciliation_runs where id = pg_temp.got('run1')::uuid), '{"matched_to_bank": 3, "matched_to_receipt": 1, "matched_to_settlement": 3, "payments_considered": 8}'::jsonb,
  'the run counted 8 successful payments, 3 exact matches to settlement items, 3 batches matched to bank credits and 1 payment matched to the lender''s own receipt');
select is((select count(*) from payments.reconciliation_matches where run_id = pg_temp.got('run1')::uuid and kind = 'payment_settlement'), 3::bigint, 'payments are matched to a settlement item by reference and amount');
select is((select array_agg(p.provider_payment_ref order by p.provider_payment_ref) from payments.reconciliation_matches m join payments.provider_payments p on p.id = m.provider_payment_id
            where m.run_id = pg_temp.got('run1')::uuid and m.kind = 'payment_settlement'), array['PAY-1', 'PAY-4', 'PAY-5'], 'the matched payments are 1, 4 and 5: payment 2 (another amount) is not matched');
select is((select array_agg(b.batch_ref order by b.batch_ref) from payments.reconciliation_matches m join payments.settlement_batches b on b.id = m.settlement_batch_id
            where m.run_id = pg_temp.got('run1')::uuid and m.kind = 'settlement_bank'), array['B-1', 'B-5', 'B-G'], 'batches 1, 5 and G are matched to a bank credit (UTR and net amount to the paisa)');
select is(pg_temp.exc_for('amount_mismatch', 'provider_payment_id', pg_temp.pp(2)), 1::bigint, 'payment 2: the provider settled another amount: amount_mismatch');
select is(pg_temp.exc_for('provider_success_no_settlement', 'provider_payment_id', pg_temp.pp(3)), 1::bigint, 'payment 3: captured ten days ago and never settled: provider_success_no_settlement');
select is(pg_temp.exc_for('provider_success_no_settlement', 'provider_payment_id', pg_temp.pp(1)), 0::bigint, 'payment 1 is settled: no exception');
select is(pg_temp.exc_for('late_settlement', 'settlement_batch_id', (select id from payments.settlement_batches where batch_ref = 'B-4')), 1::bigint, 'batch 4: settled by the provider nine days ago and never credited: late_settlement');
select is(pg_temp.exc_for('lender_receipt_missing', 'provider_payment_id', pg_temp.pp(5)), 1::bigint, 'payment 5: credited, and the lender posted a receipt but then REVERSED it, so it is not posted: lender_receipt_missing');
select is(pg_temp.exc_for('provider_success_no_settlement', 'provider_payment_id', pg_temp.pp(8)) + pg_temp.exc_for('lender_receipt_missing', 'provider_payment_id', pg_temp.pp(8)), 0::bigint,
  'payment 8, captured yesterday, is still inside every waiting time: no exception');
select is(pg_temp.exc_for('lender_receipt_missing', 'provider_payment_id', pg_temp.pp(1)), 0::bigint, 'payment 1 was posted by the lender (its receipt carries our reference): no exception');
select is(pg_temp.exc_for('settlement_no_intent', 'settlement_item_id', (select id from payments.settlement_items where provider_payment_ref = 'PAY-GHOST')), 1::bigint, 'a settlement item no payment of the lender explains: settlement_no_intent');
select is(pg_temp.exc_for('amount_mismatch', 'settlement_batch_id', (select id from payments.settlement_batches where batch_ref = 'B-6')), 1::bigint, 'batch 6: the bank credit is one paisa short: amount_mismatch');
select is((select severity from payments.reconciliation_exceptions where class = 'settlement_account_mismatch' and subject ->> 'settlement_batch_id' = (select id::text from payments.settlement_batches where batch_ref = 'B-8')), 'critical',
  'batch 8: credited into another account than the configured one: a CRITICAL settlement_account_mismatch');
select is(pg_temp.exc_for('lender_receipt_no_intent', 'receipt_id', (select id from servicing.lms_receipts where lms_receipt_ref = 'SAMPLE-RCPT-9')), 1::bigint, 'a receipt that names an intent that does not exist: lender_receipt_no_intent');
select is((select report -> 'not_reconcilable' from payments.reconciliation_runs where id = pg_temp.got('run1')::uuid), '[]'::jsonb, 'every input source exists for this lender, so nothing is "not reconcilable"');
select is((select report -> 'settled_to_non_lender' from payments.reconciliation_runs where id = pg_temp.got('run1')::uuid), '{"items": 0, "minor": 0}'::jsonb, 'the standing line: nothing settled to a non-lender account');
select is(pg_temp.truth(), pg_temp.got('truth'), 'the run changed no payment, intent, receipt, settlement item or bank credit: reconciliation only reads');
select pg_temp.as_system();
select is(pg_temp.run() ->> 'unchanged', 'true', 'a run on unchanged inputs returns the same run');
select is(pg_temp.run() ->> 'run_id', pg_temp.got('run1'), 'the very same run');
select pg_temp.as_owner();
select is((select count(*) from payments.reconciliation_runs where run_date = pg_temp.d()), 1::bigint, 'and no second run was stored');
select is((select string_agg(class || ':' || n, ',' order by class) from (select class, count(*) n from payments.reconciliation_exceptions where class in ('amount_mismatch', 'provider_success_no_settlement', 'late_settlement',
    'lender_receipt_missing', 'settlement_no_intent', 'settlement_account_mismatch', 'lender_receipt_no_intent') group by class) x),
  'amount_mismatch:2,late_settlement:2,lender_receipt_missing:6,lender_receipt_no_intent:1,provider_success_no_settlement:3,settlement_account_mismatch:1,settlement_no_intent:1',
  'every difference is exactly one exception, raised once (payments 6 and 7 are waiting too: nothing settled them within three days, and the lender posted none of payments 2 to 7)');
select is(pg_temp.err($$update payments.reconciliation_runs set report = '{"x": 1}'$$), 'P0001|', 'a finished run does not change');
select is(pg_temp.err($$delete from payments.reconciliation_matches$$), 'P0001|Record a compensating entry instead.', 'matches are append-only');

-- A resolved exception is an annotation: the next run does not open it again.
select pg_temp.keep('exc_ghost', (select id::text from payments.reconciliation_exceptions where class = 'settlement_no_intent'));
select pg_temp.as_user(pg_temp.u(3));
select pg_temp.as_system();
select pg_temp.as_owner();
update payments.reconciliation_exceptions set status = 'resolved', resolved_at = clock_timestamp() where id = pg_temp.got('exc_ghost')::uuid;
select pg_temp.as_system();
-- New input: a bank credit for batch 4 arrives late. The next run is a NEW run of the same date.
select pg_temp.as_user(pg_temp.u(3));
select payments.import_bank_credits(pg_temp.lx(), 'fde10000-0000-4000-8000-000000000001'::uuid, format('[{"valueDate":"%s","amountMinor":"475000","utr":"SAMP000000000004"}]', pg_temp.d())::jsonb);
select pg_temp.as_system();
select is(pg_temp.run() ->> 'run_no', '2', 'changed inputs make a new run number for the same date');
select pg_temp.as_owner();
select is((select counts ->> 'matched_to_bank' from payments.reconciliation_runs where run_date = pg_temp.d() and run_no = 2), '4', 'batch 4 is now matched to its credit');
select is((select count(*) from payments.reconciliation_exceptions where class = 'settlement_no_intent'), 1::bigint, 'the resolved exception was NOT opened again (a person reopens it if needed)');
select is((select status from payments.reconciliation_exceptions where id = pg_temp.got('exc_ghost')::uuid), 'resolved', 'it stays resolved');
select is((select count(*) from payments.reconciliation_exceptions where class = 'late_settlement' and subject ->> 'settlement_batch_id' = (select id::text from payments.settlement_batches where batch_ref = 'B-4') and status <> 'resolved'), 1::bigint,
  'and the earlier late-settlement exception of batch 4 stays open until a person resolves it (the run annotates nothing and closes nothing)');

-- ============================================================================================================================
-- 6. The derived stage of each payment
-- ============================================================================================================================
select pg_temp.as_user(pg_temp.u(5));
select is((select string_agg(stage, ',' order by provider_payment_id::text) from (select provider_payment_id, stage from payments.payment_stages order by provider_payment_id) s) is not null, true, 'a reader sees the stages of the lender''s payments');
select is((select stage from payments.payment_stages where provider_payment_id = pg_temp.pp(1)), 'lender_posted', 'payment 1: captured, settled, credited and posted by the lender');
select is((select stage from payments.payment_stages where provider_payment_id = pg_temp.pp(5)), 'bank_confirmed', 'payment 5: credited but not posted');
select is((select stage from payments.payment_stages where provider_payment_id = pg_temp.pp(4)), 'bank_confirmed', 'payment 4: its credit arrived with the second upload');
select is((select stage from payments.payment_stages where provider_payment_id = pg_temp.pp(2)), 'provider_captured', 'payment 2: the provider settled another amount, so it is not "settled"');
select is((select stage from payments.payment_stages where provider_payment_id = pg_temp.pp(3)), 'provider_captured', 'payment 3: only captured');
select is((select (provider_captured, provider_settled, bank_confirmed, lender_posted)::text from payments.payment_stages where provider_payment_id = pg_temp.pp(3)), '(t,f,f,f)', 'each stage is a fact about the tables, not a flag');
select pg_temp.as_user(pg_temp.u(6));
select is((select count(*) from payments.payment_stages), 0::bigint, 'another lender sees none');
select pg_temp.as_user(pg_temp.u(1));
select is((select count(*) from payments.payment_stages), 0::bigint, 'a borrower sees none');
select pg_temp.as_anon();
select is(pg_temp.err($$select count(*) from payments.payment_stages$$), '42501|', 'anon cannot read the view');
select pg_temp.as_system();
select is(pg_temp.err($$select count(*) from payments.payment_stages$$), '42501|', 'nor can the system role: stages are for people');
select pg_temp.as_owner();
select is((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('payments', 'private') and p.proname ~ '(set|mark|force)_.*(settled|settlement_stage|stage|posted|reconciled)'), 0::bigint,
  'no function exists that sets a settlement stage or marks anything "settled" or "reconciled"');

-- ============================================================================================================================
-- 7. Settled somewhere else
-- ============================================================================================================================
select pg_temp.as_system();
select is(pg_temp.report(jsonb_build_array(pg_temp.batch('B-9', 'SAMP000000000009', 1, 475000, jsonb_build_array(pg_temp.item('PAY-6', 475000)), 'XXXXXX9999'))), jsonb_build_object('recorded', 1, 'duplicates', 0, 'conflicts', 0),
  'the provider reports a batch whose destination is not the lender''s verified account');
select pg_temp.as_owner();
select is((select destination_ok from payments.settlement_batches where batch_ref = 'B-9'), false, 'it is marked as not the lender''s account');
select is((select status from payments.lender_payment_configs where id = pg_temp.got('cfg')::uuid), 'suspended', 'the lender''s payment configuration is suspended at once');
select is((select (severity, owner)::text from payments.reconciliation_exceptions where class = 'settlement_account_mismatch' and subject ->> 'settlement_batch_id' = (select id::text from payments.settlement_batches where batch_ref = 'B-9')), '(critical,platform)',
  'with a critical exception for the platform');
select pg_temp.as_user(pg_temp.u(3));
select payments.import_bank_credits(pg_temp.lx(), 'fde10000-0000-4000-8000-000000000001'::uuid, format('[{"valueDate":"%s","amountMinor":"475000","utr":"SAMP000000000009"}]', pg_temp.d())::jsonb);
select pg_temp.as_system();
select is(pg_temp.run() ->> 'run_no', '3', 'the next run is a new run');
select pg_temp.as_owner();
select is((select report -> 'settled_to_non_lender' from payments.reconciliation_runs where run_date = pg_temp.d() and run_no = 3), '{"items": 1, "minor": 475000}'::jsonb,
  'and its standing line is no longer zero: one item, 4,750.00');
select is((select count(*) from payments.reconciliation_matches m join payments.settlement_batches b on b.id = m.settlement_batch_id where b.batch_ref = 'B-9'), 0::bigint, 'a batch that went to the wrong account is never matched to a credit');
select pg_temp.as_user(pg_temp.u(5));
select is((select stage from payments.payment_stages where provider_payment_id = pg_temp.pp(6)), 'provider_settled', 'payment 6: the provider says it settled it, and a credit with that UTR exists, but the reported destination is not the lender''s account, so it is never "bank confirmed"');

-- ============================================================================================================================
-- 8. Missing inputs are "not reconcilable", never "reconciled"
-- ============================================================================================================================
select pg_temp.as_owner();
insert into tenancy.organizations (id, kind, legal_name, display_name, regulator_registration_no, status) values
  ('fdb00000-0000-4000-8000-000000000003', 'lender', 'Gamma Credit Ltd (test)', 'Gamma', 'TEST-FD-0003', 'active');
select pg_temp.as_system();
select pg_temp.keep('rz', payments.run_reconciliation('fdb00000-0000-4000-8000-000000000003', pg_temp.d()) ->> 'run_id');
select pg_temp.as_owner();
select is((select report -> 'not_reconcilable' from payments.reconciliation_runs where id = pg_temp.got('rz')::uuid), '["settlement_reports", "bank_credits", "lms_receipts"]'::jsonb,
  'a lender with no settlement report, no bank credits and no receipts feed has all three listed as not reconcilable');
select is((select counts from payments.reconciliation_runs where id = pg_temp.got('rz')::uuid), '{"matched_to_bank": 0, "matched_to_receipt": 0, "matched_to_settlement": 0, "payments_considered": 0}'::jsonb, 'and nothing is reported as matched');
select is((select count(*) from payments.reconciliation_exceptions where lender_org_id = 'fdb00000-0000-4000-8000-000000000003'), 0::bigint, 'and no exception is raised for what could not be checked');

-- ============================================================================================================================
-- 9. Who sees what
-- ============================================================================================================================
select pg_temp.as_user(pg_temp.u(3));
select is((select count(*) > 0 from payments.settlement_batches), true, 'a reconciler sees the lender''s settlement batches');
select is((select count(*) > 0 from payments.bank_credits), true, 'bank credits');
select is((select count(*) > 0 from payments.reconciliation_runs), true, 'runs');
select is((select count(*) > 0 from payments.reconciliation_matches), true, 'matches');
select is((select run_no from payments.reconciliation_summary(pg_temp.lx(), pg_temp.d())), 3, 'and the newest run of a date through the summary');
select pg_temp.as_user(pg_temp.u(6));
select is((select count(*) from payments.settlement_batches), 0::bigint, 'lender Y''s user sees none of lender X''s batches');
select is((select count(*) from payments.bank_credits), 0::bigint, 'credits');
select is((select count(*) from payments.reconciliation_runs), 0::bigint, 'or runs');
select is((select count(*) from payments.reconciliation_summary(pg_temp.lx(), pg_temp.d())), 0::bigint, 'nor the summary');
select pg_temp.as_user(pg_temp.u(1));
select is((select count(*) from payments.settlement_batches) + (select count(*) from payments.bank_credits) + (select count(*) from payments.reconciliation_runs), 0::bigint, 'a borrower sees none of it');
select pg_temp.as_anon();
select is(pg_temp.err($$select count(*) from payments.bank_credits$$), '42501|', 'anon cannot read bank credits');
select pg_temp.as_owner();
select is((select count(*) > 0 from audit.events where action like 'payments.bank_credits%'), true, 'uploads are audited');
select is((select count(*) from audit.events where action like 'payments.bank_credits%' and (metadata::text ~ 'UTR' or metadata::text ~ '[0-9]{6,}')), 0::bigint, 'with counts only: no UTR and no amount');
select is((select count(*) from payments.reconciliation_exceptions where subject::text !~ '^\{"[a-z_]+": "[0-9a-f-]{36}"\}$'), 0::bigint, 'every exception subject is a single id');

select * from finish();
rollback;
