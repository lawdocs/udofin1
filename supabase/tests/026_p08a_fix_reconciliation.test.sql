-- Phase 08a review fixes, area SR (migration 20261018000922): reconciliation, settlement and the stage view.
-- Each group names the finding it covers (A44, U12 to U26, U57). Every assertion here fails without the migration (checked against a database built
-- without it). Synthetic data only (labelled SAMPLE). Error codes are reported as SQLSTATE|hint.
begin;
create extension if not exists pgtap with schema extensions;
select plan(150);

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
-- Everything an error says (message and detail), to prove that no value of the input is echoed.
create function pg_temp.errtext(q text) returns text language plpgsql as $fn$
declare v_msg text; v_detail text;
begin
  execute q;
  return 'ok';
exception when others then
  get stacked diagnostics v_msg = message_text, v_detail = pg_exception_detail;
  return coalesce(v_msg, '') || ' / ' || coalesce(v_detail, '');
end
$fn$;
-- One scalar as text, or ERR:<sqlstate> (so a statement that fails answers an assertion instead of ending the file).
create function pg_temp.val(q text) returns text language plpgsql as $fn$
declare v text;
begin
  execute q into v;
  return v;
exception when others then
  return 'ERR:' || sqlstate;
end
$fn$;
create function pg_temp.keep(k text, v text) returns text language sql as $fn$ select set_config('t.' || k, v, true) $fn$;
create function pg_temp.got(k text) returns text language sql as $fn$ select current_setting('t.' || k) $fn$;
create function pg_temp.u(n integer) returns uuid language sql as $fn$ select ('fd000000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid $fn$;
create function pg_temp.sha(k text) returns text language sql as $fn$ select encode(sha256(convert_to('SAMPLE-026-' || k, 'UTF8')), 'hex') $fn$;
create function pg_temp.tok(p_lender uuid) returns text language sql as $fn$ select encode(sha256(convert_to('SAMPLE-TOKEN-' || p_lender::text, 'UTF8')), 'hex') $fn$;
create function pg_temp.lx() returns uuid language sql as $fn$ select 'fdb00000-0000-4000-8000-000000000001'::uuid $fn$;
create function pg_temp.ly() returns uuid language sql as $fn$ select 'fdb00000-0000-4000-8000-000000000002'::uuid $fn$;
create function pg_temp.lz() returns uuid language sql as $fn$ select 'fdb00000-0000-4000-8000-000000000004'::uuid $fn$;
create function pg_temp.lid(n integer) returns uuid language sql as $fn$ select ('fd400000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid $fn$;
create function pg_temp.d() returns date language sql as $fn$ select (now() at time zone 'Asia/Kolkata')::date $fn$;
create function pg_temp.exc_for(p_class text, p_key text, p_id uuid) returns bigint language sql as $fn$
  select count(*) from payments.reconciliation_exceptions where class = p_class and subject ->> p_key = p_id::text
$fn$;
create function pg_temp.exc_open_for(p_class text, p_key text, p_id uuid) returns bigint language sql as $fn$
  select count(*) from payments.reconciliation_exceptions where class = p_class and subject ->> p_key = p_id::text and status <> 'resolved'
$fn$;
create function pg_temp.exc_sev_owner(p_class text, p_key text, p_id uuid) returns text language sql as $fn$
  select string_agg(severity || '/' || owner, ',' order by opened_at) from payments.reconciliation_exceptions where class = p_class and subject ->> p_key = p_id::text
$fn$;
create function pg_temp.ago(p_days integer) returns text language sql as $fn$
  select to_char((clock_timestamp() - make_interval(days => p_days)) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
$fn$;
create function pg_temp.utr(n integer) returns text language sql as $fn$ select 'SAMP' || lpad(n::text, 12, '0') $fn$;

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
  v_intent := payments.request_payment(pg_temp.lid(p_n), 'installment', 475000, 'sr-request-' || lpad(p_n::text, 6, '0'));
  perform pg_temp.as_system();
  perform payments.record_order_created(v_intent, 'ORD-' || p_n);
  perform payments.ingest_provider_delivery(pg_temp.tok(pg_temp.lx()), pg_temp.dlv('SAMPLE-D-' || p_n, v_ev, 'captured', 'PAY-' || p_n, 'ORD-' || p_n, 475000, pg_temp.ago(p_days_ago)));
  perform payments.apply_provider_event((select id from payments.provider_events where provider_event_id = v_ev));
end
$fn$;
create function pg_temp.pp(p_n integer) returns uuid language sql as $fn$ select id from payments.provider_payments where provider_payment_ref = 'PAY-' || p_n $fn$;
create function pg_temp.report(p_batches jsonb) returns jsonb language sql as $fn$ select payments.record_settlement_report(pg_temp.got('cfg')::uuid, pg_temp.d(), p_batches) $fn$;
create function pg_temp.report_z(p_batches jsonb) returns jsonb language sql as $fn$ select payments.record_settlement_report(pg_temp.got('cfgz')::uuid, pg_temp.d(), p_batches) $fn$;
-- A batch with gross = net, no fee and no tax.
create function pg_temp.batch(p_ref text, p_utr text, p_days_ago integer, p_net bigint, p_items jsonb, p_dest text default 'XXXXXX1111') returns jsonb language sql as $fn$
  select jsonb_strip_nulls(jsonb_build_object('batchRef', p_ref, 'settlementRef', p_utr, 'periodFrom', to_char(pg_temp.d() - p_days_ago, 'YYYY-MM-DD'), 'periodTo', to_char(pg_temp.d() - p_days_ago, 'YYYY-MM-DD'),
    'destinationMaskedRef', p_dest, 'grossMinor', p_net::text, 'feeMinor', '0', 'taxMinor', '0', 'netMinor', p_net::text, 'items', p_items))
$fn$;
create function pg_temp.item(p_ref text, p_gross bigint) returns jsonb language sql as $fn$
  select jsonb_build_object('providerPaymentRef', p_ref, 'grossMinor', p_gross::text, 'feeMinor', '0', 'taxMinor', '0', 'netMinor', p_gross::text)
$fn$;
create function pg_temp.itemx(p_ref text, p_gross bigint, p_fee bigint, p_tax bigint, p_net bigint) returns jsonb language sql as $fn$
  select jsonb_build_object('providerPaymentRef', p_ref, 'grossMinor', p_gross::text, 'feeMinor', p_fee::text, 'taxMinor', p_tax::text, 'netMinor', p_net::text)
$fn$;
create function pg_temp.run(p_date date default null) returns jsonb language sql as $fn$ select payments.run_reconciliation(pg_temp.lx(), coalesce(p_date, pg_temp.d())) $fn$;
create function pg_temp.run_z() returns jsonb language sql as $fn$ select payments.run_reconciliation(pg_temp.lz(), pg_temp.d()) $fn$;
create function pg_temp.report_of(p_run jsonb) returns jsonb language sql as $fn$ select report from payments.reconciliation_runs where id = (p_run ->> 'run_id')::uuid $fn$;
create function pg_temp.counts_of(p_run jsonb) returns jsonb language sql as $fn$ select counts from payments.reconciliation_runs where id = (p_run ->> 'run_id')::uuid $fn$;
create function pg_temp.credits(p_account text, p_rows text) returns jsonb language sql as $fn$
  select payments.import_bank_credits(pg_temp.lx(), p_account::uuid, p_rows::jsonb)
$fn$;
-- Everything the run could touch, hashed.
create function pg_temp.truth() returns text language sql as $fn$
  select md5(coalesce((select string_agg(to_jsonb(i)::text, '|' order by i.id) from payments.payment_intents i), '') || '#' ||
             coalesce((select string_agg(to_jsonb(p)::text, '|' order by p.id) from payments.provider_payments p), '') || '#' ||
             coalesce((select string_agg(to_jsonb(a)::text, '|' order by a.id) from payments.payment_adjustments a), '') || '#' ||
             coalesce((select string_agg(to_jsonb(r)::text, '|' order by r.id) from servicing.lms_receipts r), '') || '#' ||
             coalesce((select string_agg(to_jsonb(s)::text, '|' order by s.id) from payments.settlement_items s), '') || '#' ||
             coalesce((select string_agg(to_jsonb(b)::text, '|' order by b.id) from payments.settlement_batches b), '') || '#' ||
             coalesce((select string_agg(to_jsonb(c)::text, '|' order by c.id) from payments.bank_credits c), '') || '#' ||
             coalesce((select string_agg(to_jsonb(s2)::text, '|' order by s2.id) from servicing.balance_snapshots s2), '') || '#' ||
             coalesce((select string_agg(to_jsonb(g)::text, '|' order by g.id) from payments.lender_payment_configs g), ''))
$fn$;
grant execute on all functions in schema pg_temp to public;

-- Fixture -----------------------------------------------------------------------------------------------------------------------
-- Users: 01 borrower, 03 lender X reconciler (payment.read, payment.reconcile; NO loan.read), 04 lender X payments admin (payment.configure, payment.read), 05 lender X viewer
-- (payment.read, loan.read), 06 lender Y viewer, 07 platform payments admin, 08 and 09 switch fixture, 10 and 11 loan product maker and checker.
insert into auth.users (id, phone, raw_app_meta_data)
select pg_temp.u(n), case when n = 1 then '91000000091' end, case when n = 1 then '{}'::jsonb else '{"actor_type":"staff"}'::jsonb end from generate_series(1, 11) n;
select pg_temp.keep('b1', (select id::text from identity.borrowers where user_id = pg_temp.u(1)));

select pg_temp.as_owner();
select set_config('udofin.allow_mock_providers', 'on', true);
insert into tenancy.organizations (id, kind, legal_name, display_name, regulator_registration_no, status) values
  ('fda00000-0000-4000-8000-000000000000', 'platform', 'Udofin Platform (test)', 'Udofin', null, 'active'),
  (pg_temp.lx(), 'lender', 'Alpha Finance Ltd (test)', 'Alpha', 'TEST-FD-0001', 'active'),
  (pg_temp.ly(), 'lender', 'Beta Capital Ltd (test)', 'Beta', 'TEST-FD-0002', 'active'),
  (pg_temp.lz(), 'lender', 'Delta Credit Ltd (test)', 'Delta', 'TEST-FD-0004', 'active');
insert into tenancy.memberships (id, org_id, user_id, status) values
  ('fdc10000-0000-4000-8000-000000000003', pg_temp.lx(), pg_temp.u(3), 'active'),
  ('fdc10000-0000-4000-8000-000000000004', pg_temp.lx(), pg_temp.u(4), 'active'),
  ('fdc10000-0000-4000-8000-000000000005', pg_temp.lx(), pg_temp.u(5), 'active'),
  ('fdc10000-0000-4000-8000-000000000006', pg_temp.ly(), pg_temp.u(6), 'active'),
  ('fdc10000-0000-4000-8000-000000000007', 'fda00000-0000-4000-8000-000000000000', pg_temp.u(7), 'active'),
  ('fdc10000-0000-4000-8000-000000000019', pg_temp.lx(), pg_temp.u(10), 'active'),
  ('fdc10000-0000-4000-8000-000000000020', pg_temp.lx(), pg_temp.u(11), 'active');
insert into tenancy.membership_roles (membership_id, role_id)
select g.mid::uuid, r.id from (values
  ('fdc10000-0000-4000-8000-000000000003', 'lender', 'reconciler'), ('fdc10000-0000-4000-8000-000000000004', 'lender', 'payments_admin'),
  ('fdc10000-0000-4000-8000-000000000005', 'lender', 'viewer'), ('fdc10000-0000-4000-8000-000000000006', 'lender', 'viewer'),
  ('fdc10000-0000-4000-8000-000000000007', 'platform', 'platform_payments_admin'),
  ('fdc10000-0000-4000-8000-000000000019', 'lender', 'lender_admin'), ('fdc10000-0000-4000-8000-000000000020', 'lender', 'product_approver')) as g (mid, kind, rkey)
join tenancy.roles r on r.org_id is null and r.applies_to = g.kind::tenancy.organization_kind and r.key = g.rkey;
select pg_temp.keep('cfg', pg_temp.sample_config(pg_temp.lx(), 'fde10000-0000-4000-8000-000000000001', 'XXXXXX1111', 'mock_gateway')::text);
select pg_temp.sample_config(pg_temp.ly(), 'fde10000-0000-4000-8000-000000000002', 'XXXXXX2222', 'mock_gateway_pay');
select pg_temp.keep('cfgz', pg_temp.sample_config(pg_temp.lz(), 'fde10000-0000-4000-8000-00000000000a', 'XXXXXX3333', 'mock_gw_z')::text);
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

-- Loans 1 to 16 (lender X, the borrower), each with fresh lender-reported figures: 4,750.00 due in three days.
insert into lending.loan_products (id, lender_org_id, category_key, code, name, status) values
  ('fd900000-0000-4000-8000-000000000001', pg_temp.lx(), 'personal', 'PL-FD', 'X Personal Loan', 'active');
insert into lending.loan_product_versions (id, product_id, lender_org_id, version, status, min_amount_minor, max_amount_minor, min_tenure_days, max_tenure_days,
  rate_type, min_annual_rate_bps, max_annual_rate_bps, drafted_by, approved_by, approved_at, effective_from)
values ('fd910000-0000-4000-8000-000000000001', 'fd900000-0000-4000-8000-000000000001', pg_temp.lx(), 1, 'approved', 1000000, 50000000, 180, 1825, 'fixed', 1400, 2400, pg_temp.u(10), pg_temp.u(11), now(), now());
insert into lending.loan_requests (id, borrower_id, category_key, requested_amount_minor, requested_tenure_days, purpose_code, status)
select ('fd700000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, pg_temp.got('b1')::uuid, 'personal', 5000000, 365, 'education', 'submitted' from generate_series(1, 16) n;
insert into lending.applications (id, lender_org_id, loan_request_id, borrower_id, product_version_id, status, requested_amount_minor, requested_tenure_days, lender_reference)
select ('fd200000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, pg_temp.lx(), ('fd700000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, pg_temp.got('b1')::uuid,
       'fd910000-0000-4000-8000-000000000001', 'disbursed', 5000000, 365, 'SAMPLE-APP-' || n from generate_series(1, 16) n;
insert into servicing.loan_accounts (id, lender_org_id, application_id, borrower_id, source_system, lms_loan_ref, status, sanctioned_amount_minor)
select pg_temp.lid(n), pg_temp.lx(), a.id, a.borrower_id, 'lender_lms', 'SAMPLE-LN-' || n, 'active', 5000000
from lending.applications a, generate_series(1, 16) n where right(a.id::text, 2)::int = n;
insert into servicing.balance_snapshots (lender_org_id, loan_account_id, version, status, outstanding_principal_minor, total_overdue_minor, next_due_on, next_due_minor, days_past_due,
  source_system, source_record_id, reported_as_of, content_sha256)
select l.lender_org_id, l.id, 1, 'active', 4000000, 0, pg_temp.d() + 3, 475000, 0, 'file_import', 'SRC-' || l.lms_loan_ref, clock_timestamp() - interval '1 hour', pg_temp.sha('snap-' || l.lms_loan_ref)
from servicing.loan_accounts l;
insert into servicing.schedule_snapshots (id, lender_org_id, loan_account_id, version)
select ('fd500000-0000-4000-8000-0000000000' || lpad(right(l.id::text, 2)::int::text, 2, '0'))::uuid, l.lender_org_id, l.id, 1 from servicing.loan_accounts l;
insert into servicing.schedule_installments (snapshot_id, lender_org_id, seq, due_date, principal_minor, interest_minor)
select s.id, s.lender_org_id, 1, pg_temp.d() + 3, 400000, 75000 from servicing.schedule_snapshots s;

-- Captured payments through the real path (the scenarios are named in the sections below). PAY-14 also gets a second capture on the same order.
select pg_temp.captured(1, 5);
select pg_temp.captured(2, 5);
select pg_temp.captured(3, 10);
select pg_temp.captured(4, 10);
select pg_temp.captured(5, 10);
select pg_temp.captured(6, 10);
select pg_temp.captured(7, 10);
select pg_temp.captured(8, 10);
select pg_temp.captured(9, 10);
select pg_temp.captured(10, 10);
select pg_temp.captured(11, 5);
select pg_temp.captured(12, 5);
select pg_temp.captured(13, 5);
select pg_temp.captured(14, 5);
select pg_temp.captured(15, 5);
select pg_temp.captured(16, 5);
select pg_temp.as_system();
select payments.ingest_provider_delivery(pg_temp.tok(pg_temp.lx()), pg_temp.dlv('SAMPLE-D-14B', 'SAMPLE-E-14B', 'captured', 'PAY-14B', 'ORD-14', 475000, pg_temp.ago(5)));
select payments.apply_provider_event((select id from payments.provider_events where provider_event_id = 'SAMPLE-E-14B'));
select pg_temp.as_owner();
select is((select duplicate_capture from payments.provider_payments where provider_payment_ref = 'PAY-14B'), true, 'fixture: the second capture on the order of payment 14 is a duplicate capture');

-- ============================================================================================================================
-- 1. Structure (U14, U19, U57, U20, U25)
-- ============================================================================================================================
select is((select count(*) from pg_indexes where schemaname = 'payments' and tablename = 'settlement_batches' and indexdef like 'CREATE UNIQUE INDEX%' and indexdef like '%(lender_org_id, config_id, settlement_ref)%'), 1::bigint,
  'U14: a settlement reference (UTR) is unique per lender and payment configuration');
select is((select count(*) from pg_indexes where schemaname = 'payments' and tablename = 'reconciliation_matches' and indexdef like 'CREATE UNIQUE INDEX%' and indexdef like '%run_id%'), 6::bigint,
  'U17: one match per payment, item, credit, batch and receipt within a run is a table rule');
select ok((select coalesce(reloptions, '{}') @> array['security_invoker=true', 'security_barrier=true'] from pg_class where oid = 'payments.payment_stages'::regclass),
  'U19, U57: payment_stages runs with the caller''s rights and as a security barrier');
select ok(to_regprocedure('private.payment_lender_posted(uuid)') is not null and not has_function_privilege('anon', to_regprocedure('private.payment_lender_posted(uuid)'), 'execute')
          and has_function_privilege('authenticated', to_regprocedure('private.payment_lender_posted(uuid)'), 'execute')
          and not has_function_privilege('service_role', to_regprocedure('private.payment_lender_posted(uuid)'), 'execute'),
  'U19: the posted-by-lender helper is executable by signed-in users only');
select ok((select count(*) = 4 and bool_and(not has_function_privilege('anon', f.oid, 'execute') and not has_function_privilege('authenticated', f.oid, 'execute') and not has_function_privilege('service_role', f.oid, 'execute'))
           from (select to_regprocedure(x) as oid from unnest(array['private.recon_raise(uuid, text, text, text, jsonb, text, uuid)', 'private.recon_utr_ok(text)', 'private.recon_paise_ok(text, bigint)',
                             'private.recon_destination_ok(text, text)']) x where to_regprocedure(x) is not null) f), 'the other new helpers exist and are internal: no role can execute them directly');
select is((select count(*) from payments.reconciliation_exceptions), 1::bigint, 'fixture: the duplicate capture opened exactly its own exception so far');

-- ============================================================================================================================
-- 2. The waiting times (U25)
-- ============================================================================================================================
select pg_temp.as_user(pg_temp.u(4));
select is(pg_temp.err(format($$select payments.set_reconciliation_settings(%L, 8, 72)$$, pg_temp.lx())), '22023|settings_invalid', 'U25: eight days to settle is above the platform ceiling of seven');
select is(pg_temp.err(format($$select payments.set_reconciliation_settings(%L, 30, 720)$$, pg_temp.lx())), '22023|settings_invalid', 'U25: thirty days and 720 hours (the old limits) can no longer mute the missing-item exceptions');
select is(pg_temp.err(format($$select payments.set_reconciliation_settings(%L, 3, 169)$$, pg_temp.lx())), '22023|settings_invalid', 'U25: and 169 hours is above the ceiling of 168');
select is(payments.set_reconciliation_settings(pg_temp.lx(), 7, 168), 'set', 'the ceilings themselves are allowed');
select is(payments.set_reconciliation_settings(pg_temp.lx(), 3, 72), 'set', 'and the lender returns to the platform defaults');
select pg_temp.as_owner();
select is((select metadata ->> 'previous_settlement_lag_days' || '/' || (metadata ->> 'previous_receipt_lag_hours') from audit.events where action = 'payments.reconciliation_settings.set' order by occurred_at desc, id desc limit 1),
  '7/168', 'U25: the audit event keeps the values that were replaced');

-- ============================================================================================================================
-- 3. Recording what the provider settled: limits answer 22023 and echo nothing (U22, U23)
-- ============================================================================================================================
select pg_temp.as_system();
select is(pg_temp.err($$select pg_temp.report(jsonb_build_array(jsonb_set(pg_temp.batch('B-LIM', 'UTR-LIM1', 1, 100, '[]'::jsonb), '{grossMinor}', '"100000000000001"')))$$), '22023|bad_request',
  'U22: a gross amount one paisa above the table limit is refused with 22023, not a raw check failure');
select is(pg_temp.err($$select pg_temp.report(jsonb_build_array(jsonb_set(pg_temp.batch('B-LIM', 'UTR-LIM1', 1, 100, '[]'::jsonb), '{netMinor}', '"999999999999999"')))$$), '22023|bad_request',
  'U22: so is the largest 15-digit net amount');
select is(pg_temp.err($$select pg_temp.report(jsonb_build_array(pg_temp.batch('B-LIM', 'UTR-LIM1', 1, 100, jsonb_build_array(pg_temp.item('PAY-LIM', 100000000000001)))))$$), '22023|bad_request',
  'U22: and an item above the limit');
select is(pg_temp.errtext($$select pg_temp.report(jsonb_build_array(jsonb_set(pg_temp.batch('B-LIM', 'UTR-LIM1', 1, 100, '[]'::jsonb), '{grossMinor}', '"100000000000001"')))$$) ~ '(100000000000001|UTR-LIM1|B-LIM)', false,
  'U22: and the error repeats no value of the report (neither message nor detail)');
select is(pg_temp.err($$select pg_temp.report(jsonb_build_array(pg_temp.batch('B-DUP', 'UTR-DUP1', 1, 200, jsonb_build_array(pg_temp.item('PAY-D1', 100), pg_temp.item('PAY-D1', 100)))))$$), '22023|bad_request',
  'U22: one payment twice in a batch is refused with 22023 (not a raw unique violation)');
select is(pg_temp.err($$select pg_temp.report(jsonb_build_array(pg_temp.batch('B-FUT', 'UTR-FUT1', -400, 100, '[]'::jsonb)))$$), '22023|bad_request',
  'U23: a settlement period that ends after the report date is refused');
select is(pg_temp.err(format($$select payments.record_settlement_report(%L, current_date + 3, '[]'::jsonb)$$, pg_temp.got('cfg'))), '22023|bad_request', 'U23: so is a report dated in the future');
select is((select count(*) from payments.settlement_batches), 0::bigint, 'and nothing was recorded by any of them');
-- Body-level guards (the table owner has EXECUTE but is not the system role: the guard in the function body answers, not a missing grant).
select pg_temp.as_owner();
select is(pg_temp.err(format($$select payments.record_settlement_report(%L, current_date, '[]'::jsonb)$$, pg_temp.got('cfg'))), '42501|', 'U26: record_settlement_report refuses any caller but the system role, in its body');
select is(pg_temp.err(format($$select payments.run_reconciliation(%L, current_date)$$, pg_temp.lx())), '42501|', 'U26: run_reconciliation refuses any caller but the system role, in its body');
select pg_temp.as_system();

-- ============================================================================================================================
-- 4. The lender's bank credits: the shape of a bank reference (U20) and the limits (U22)
-- ============================================================================================================================
select pg_temp.as_user(pg_temp.u(3));
select is(pg_temp.err(format($$select pg_temp.credits('fde10000-0000-4000-8000-000000000001', '[{"valueDate":"%s","amountMinor":"100","utr":"ABCDE1234F"}]')$$, pg_temp.d())), '22023|row_invalid',
  'U20: a PAN-shaped token is not a bank reference');
select is(pg_temp.err(format($$select pg_temp.credits('fde10000-0000-4000-8000-000000000001', '[{"valueDate":"%s","amountMinor":"100","utr":"234567890123"}]')$$, pg_temp.d())), '22023|row_invalid',
  'U20: nor is a 12-digit number that looks like an Aadhaar number');
select is(pg_temp.err(format($$select pg_temp.credits('fde10000-0000-4000-8000-000000000001', '[{"valueDate":"%s","amountMinor":"100","utr":"9100000009100"}]')$$, pg_temp.d())), '22023|row_invalid',
  'U20: nor a phone number with its country code');
select is(pg_temp.err(format($$select pg_temp.credits('fde10000-0000-4000-8000-000000000001', '[{"valueDate":"%s","amountMinor":"100","utr":"NEFT-RAMESH.KUMAR-EMI/HDFC00012345678"}]')$$, pg_temp.d())), '22023|row_invalid',
  'U20: nor a narration without spaces');
select is(pg_temp.err(format($$select pg_temp.credits('fde10000-0000-4000-8000-000000000001', '[{"valueDate":"%s","amountMinor":"100","utr":"UPI/CR/412345678901/RAMESHKUMAR"}]')$$, pg_temp.d())), '22023|row_invalid',
  'U20: nor a statement line with separators');
select is(pg_temp.err(format($$select pg_temp.credits('fde10000-0000-4000-8000-000000000001', '[{"valueDate":"%s","amountMinor":"100","utr":"RAMESHKUMARSHARMA"}]')$$, pg_temp.d())), '22023|row_invalid',
  'U20: nor a name run together');
select is(pg_temp.err(format($$select pg_temp.credits('fde10000-0000-4000-8000-000000000001', '[{"valueDate":"%s","amountMinor":"100","utr":"ABCDE1234FXYZ12345"}]')$$, pg_temp.d())), '22023|row_invalid',
  'U20: nor a value with a PAN inside');
select is(pg_temp.err(format($$select pg_temp.credits('fde10000-0000-4000-8000-000000000001', '[{"valueDate":"%s","amountMinor":"100","utr":"sbin523185012345"}]')$$, pg_temp.d())), '22023|row_invalid',
  'U20: nor lower case (the reference is compared exactly, never normalised)');
select is(pg_temp.err(format($$select pg_temp.credits('fde10000-0000-4000-8000-000000000001', '[{"valueDate":"%s","amountMinor":"100","utr":"SAMP000000000099"},{"valueDate":"%s","amountMinor":"100","utr":"ABCDE1234F"}]')$$, pg_temp.d(), pg_temp.d())), '22023|row_invalid',
  'U20: one bad row among good ones refuses the whole upload');
select is(pg_temp.errtext(format($$select pg_temp.credits('fde10000-0000-4000-8000-000000000001', '[{"valueDate":"%s","amountMinor":"100","utr":"ABCDE1234F"}]')$$, pg_temp.d())) ~ 'ABCDE1234F', false,
  'U20: and the refusal does not echo the value');
select is(pg_temp.err(format($$select pg_temp.credits('fde10000-0000-4000-8000-000000000001', '[{"valueDate":"%s","amountMinor":"100000000000001","utr":"SAMP000000000099"}]')$$, pg_temp.d())), '22023|row_invalid',
  'U22: a credit one paisa above the table limit is refused with 22023');
select is(pg_temp.err(format($$select pg_temp.credits('fde10000-0000-4000-8000-000000000001', '[{"valueDate":"%s","amountMinor":"500000000000000","utr":"SAMP000000000099"}]')$$, pg_temp.d())), '22023|row_invalid',
  'U22: so is a 15-digit amount (it used to fail the table check and echo the row)');
select is(pg_temp.errtext(format($$select pg_temp.credits('fde10000-0000-4000-8000-000000000001', '[{"valueDate":"%s","amountMinor":"500000000000000","utr":"SAMP000000000099"}]')$$, pg_temp.d())) ~ '(500000000000000|SAMP000000000099|Failing row)', false,
  'U22: and the message and detail show no value and no row');
select pg_temp.as_owner();
select is((select count(*) from payments.bank_credits), 0::bigint, 'nothing was stored by any refused upload');
select pg_temp.as_user(pg_temp.u(3));
select is(pg_temp.err(format($$select pg_temp.credits('fde10000-0000-4000-8000-000000000001', '[{"valueDate":"%1$s","amountMinor":"100","utr":"SBIN523185012345"},{"valueDate":"%1$s","amountMinor":"100","utr":"HDFCR52020010612345"},{"valueDate":"%1$s","amountMinor":"100","utr":"ICICN52020040612"}]')$$, pg_temp.d())), 'ok',
  'U20: NEFT-like (16) and RTGS-like (19) bank references are accepted');
select pg_temp.as_system();

-- ============================================================================================================================
-- 5. The scenarios (lender X): batches, credits and receipts
-- ============================================================================================================================
-- Batch 1: the control. Batch 2 (U13): the batch says 100000 but its item says 475000. Batch 3A and 3B (U14): two batches under ONE bank reference.
-- Batches 6A and 6B (U17): payment 6 settled twice. Batches 7A and 7B (U17): payment 7 settled for 475000 and again for 400000.
-- Batch 11 (U21): credit of another amount in another account. Batch 12 (U15): no destination. Batch 13: its own parts do not add up.
-- Batch 15: credit of another amount. Batch 16: credit in another account, same amount.
select is(pg_temp.report(jsonb_build_array(
    pg_temp.batch('B-1', pg_temp.utr(1), 4, 475000, jsonb_build_array(pg_temp.item('PAY-1', 475000))),
    pg_temp.batch('B-2', pg_temp.utr(2), 4, 100000, jsonb_build_array(pg_temp.item('PAY-2', 475000))),
    pg_temp.batch('B-3A', pg_temp.utr(3), 4, 475000, jsonb_build_array(pg_temp.item('PAY-3', 475000))),
    pg_temp.batch('B-3B', pg_temp.utr(3), 4, 475000, jsonb_build_array(pg_temp.item('PAY-4', 475000))),
    pg_temp.batch('B-6A', pg_temp.utr(61), 9, 475000, jsonb_build_array(pg_temp.item('PAY-6', 475000))),
    pg_temp.batch('B-6B', pg_temp.utr(62), 8, 475000, jsonb_build_array(pg_temp.item('PAY-6', 475000))),
    pg_temp.batch('B-7A', pg_temp.utr(71), 9, 475000, jsonb_build_array(pg_temp.item('PAY-7', 475000))),
    pg_temp.batch('B-7B', pg_temp.utr(72), 8, 400000, jsonb_build_array(pg_temp.item('PAY-7', 400000))),
    pg_temp.batch('B-11', pg_temp.utr(11), 4, 475000, jsonb_build_array(pg_temp.item('PAY-11', 475000))),
    pg_temp.batch('B-12', pg_temp.utr(12), 4, 475000, jsonb_build_array(pg_temp.item('PAY-12', 475000)), null),
    jsonb_build_object('batchRef', 'B-13', 'settlementRef', pg_temp.utr(13), 'periodFrom', to_char(pg_temp.d() - 4, 'YYYY-MM-DD'), 'periodTo', to_char(pg_temp.d() - 4, 'YYYY-MM-DD'),
      'destinationMaskedRef', 'XXXXXX1111', 'grossMinor', '475000', 'feeMinor', '1000', 'taxMinor', '0', 'netMinor', '475000',
      'items', jsonb_build_array(pg_temp.itemx('PAY-13', 475000, 1000, 0, 475000))),
    pg_temp.batch('B-15', pg_temp.utr(15), 4, 475000, jsonb_build_array(pg_temp.item('PAY-15', 475000))),
    pg_temp.batch('B-16', pg_temp.utr(16), 4, 475000, jsonb_build_array(pg_temp.item('PAY-16', 475000))))),
  jsonb_build_object('recorded', 12, 'duplicates', 0, 'conflicts', 1), 'U14: a provider report is recorded; the second batch under bank reference 3 is a conflict and is not stored');
select pg_temp.as_owner();
select is((select count(*) from payments.settlement_batches where settlement_ref = pg_temp.utr(3)), 1::bigint, 'U14: only one batch holds the bank reference');
select is((select string_agg(batch_ref, ',' order by batch_ref) from payments.settlement_batches where settlement_ref = pg_temp.utr(3)), 'B-3A', 'the first one');
select is(pg_temp.exc_sev_owner('event_payload_conflict', 'settlement_batch_id', (select id from payments.settlement_batches where batch_ref = 'B-3A')), 'critical/platform',
  'U14: and the platform gets a CRITICAL event_payload_conflict against the batch that holds the reference');
select is((select to_jsonb(b) ->> 'items_total_mismatch' from payments.settlement_batches b where batch_ref = 'B-1'), 'false', 'U13: a batch whose items add up to its totals is tied');
select is((select to_jsonb(b) ->> 'items_total_mismatch' from payments.settlement_batches b where batch_ref = 'B-2'), 'true', 'U13: a batch of 1,000.00 with an item of 4,750.00 is NOT tied');
select is(pg_temp.exc_sev_owner('event_payload_conflict', 'settlement_batch_id', (select id from payments.settlement_batches where batch_ref = 'B-2')), 'warning/platform',
  'U13: and the platform is told that the provider''s report does not add up');
select is((select (parts_mismatch, to_jsonb(b) ->> 'items_total_mismatch')::text from payments.settlement_batches b where batch_ref = 'B-13'), '(t,false)',
  'the parts of batch 13 do not add up (net is not gross less fee less tax), although its items match its totals');
select is(pg_temp.exc_sev_owner('event_payload_conflict', 'settlement_batch_id', (select id from payments.settlement_batches where batch_ref = 'B-13')), 'warning/platform',
  'U26: parts_mismatch is consumed: a batch whose parts do not add up opens a platform exception');
select is((select count(*)::text || '/' || coalesce(max(destination_ok::text), 'null') from payments.settlement_batches where batch_ref = 'B-12'), '1/null', 'U15: a batch with no destination is recorded and is not the lender''s account: destination_ok stays null');
select is(pg_temp.exc_sev_owner('settlement_account_mismatch', 'settlement_batch_id', (select id from payments.settlement_batches where batch_ref = 'B-12')), 'warning/platform',
  'U15: and the platform is told (a warning: nothing proves the money went elsewhere)');
select is((select status from payments.lender_payment_configs where id = pg_temp.got('cfg')::uuid), 'active', 'U15: a missing destination does not stop the lender''s payments');
select pg_temp.as_user(pg_temp.u(3));
select is(pg_temp.credits('fde10000-0000-4000-8000-000000000001', format('[
  {"valueDate":"%1$s","amountMinor":"475000","utr":"%2$s"}, {"valueDate":"%1$s","amountMinor":"100000","utr":"%3$s"}, {"valueDate":"%1$s","amountMinor":"475000","utr":"%4$s"},
  {"valueDate":"%1$s","amountMinor":"475000","utr":"%5$s"}, {"valueDate":"%1$s","amountMinor":"475000","utr":"%6$s"}, {"valueDate":"%1$s","amountMinor":"400000","utr":"%7$s"}]',
  pg_temp.d() - 3, pg_temp.utr(1), pg_temp.utr(2), pg_temp.utr(3), pg_temp.utr(12), pg_temp.utr(13), pg_temp.utr(15))),
  jsonb_build_object('inserted', 6, 'duplicates', 0), 'the lender uploads credits into the configured account for batches 1, 2, 3, 12, 13 and 15');
select is(pg_temp.credits('fde10000-0000-4000-8000-000000000009', format('[
  {"valueDate":"%1$s","amountMinor":"474999","utr":"%2$s"}, {"valueDate":"%1$s","amountMinor":"475000","utr":"%3$s"}]', pg_temp.d() - 3, pg_temp.utr(11), pg_temp.utr(16))),
  jsonb_build_object('inserted', 2, 'duplicates', 0), 'and credits into the lender''s OTHER account for batches 11 (another amount) and 16 (the right amount)');
select pg_temp.as_owner();
-- The lender's receipts. Payment 1 is posted on its own loan. Payment 5 is posted on ANOTHER loan (6). Payment 8 is posted twice.
insert into servicing.lms_receipts (lender_org_id, loan_account_id, kind, lms_receipt_ref, amount_minor, value_date, bank_reference, source_system, source_record_id, reported_as_of, content_sha256)
values (pg_temp.lx(), pg_temp.lid(1), 'receipt', 'SR-RCPT-1', 475000, pg_temp.d() - 3, 'PAY-1', 'file_import', 'SRC-R1', clock_timestamp() - interval '1 hour', pg_temp.sha('r1')),
       (pg_temp.lx(), pg_temp.lid(6), 'receipt', 'SR-RCPT-5X', 475000, pg_temp.d() - 3, 'PAY-5', 'file_import', 'SRC-R5X', clock_timestamp() - interval '1 hour', pg_temp.sha('r5x')),
       (pg_temp.lx(), pg_temp.lid(8), 'receipt', 'SR-RCPT-8A', 475000, pg_temp.d() - 3, 'PAY-8', 'file_import', 'SRC-R8A', clock_timestamp() - interval '1 hour', pg_temp.sha('r8a')),
       (pg_temp.lx(), pg_temp.lid(8), 'receipt', 'SR-RCPT-8B', 475000, pg_temp.d() - 2, 'PAY-8', 'file_import', 'SRC-R8B', clock_timestamp() - interval '1 hour', pg_temp.sha('r8b'));
-- A batch from before the period check existed (inserted directly, as an old row would be): it ends far in the future and lists payment 9.
insert into payments.settlement_batches (lender_org_id, config_id, provider, batch_ref, settlement_ref, period_from, period_to, destination_masked_ref, destination_ok, gross_minor, fee_minor, tax_minor, net_minor,
                                         parts_mismatch, item_count, content_sha256, report_date)
values (pg_temp.lx(), pg_temp.got('cfg')::uuid, 'mock_gateway', 'B-FUTL', pg_temp.utr(90), pg_temp.d() + 400, pg_temp.d() + 400, 'XXXXXX1111', true, 475000, 0, 0, 475000, false, 1, pg_temp.sha('b-futl'), pg_temp.d());
insert into payments.settlement_items (batch_id, lender_org_id, provider_payment_ref, gross_minor, fee_minor, tax_minor, net_minor, parts_mismatch)
select id, lender_org_id, 'PAY-9', 475000, 0, 0, 475000, false from payments.settlement_batches where batch_ref = 'B-FUTL';
select pg_temp.keep('truth', pg_temp.truth());
select pg_temp.as_system();

-- ============================================================================================================================
-- 6. The run
-- ============================================================================================================================
select pg_temp.keep('run1', (pg_temp.run() ->> 'run_id'));
select pg_temp.as_owner();
select is((select counts from payments.reconciliation_runs where id = pg_temp.got('run1')::uuid), '{"matched_to_bank": 2, "matched_to_receipt": 2, "matched_to_settlement": 10, "payments_considered": 16}'::jsonb,
  'the run considered 16 payments (the duplicate capture is left out), matched 10 to settlement items, 2 batches to bank credits and 2 payments to the lender''s receipts');
select is((select array_agg(b.batch_ref order by b.batch_ref) from payments.reconciliation_matches m join payments.settlement_batches b on b.id = m.settlement_batch_id
            where m.run_id = pg_temp.got('run1')::uuid and m.kind = 'settlement_bank'), array['B-1', 'B-3A'],
  'U13, U15, U21: only batches 1 and 3A are confirmed by a credit: not 2 (items do not add up), 11 (another amount and account), 12 (no destination), 13 (parts), 15 or 16');
select is((select count(*) from payments.reconciliation_matches where run_id = pg_temp.got('run1')::uuid and kind = 'payment_settlement' and provider_payment_id = pg_temp.pp(6)), 1::bigint,
  'U17: payment 6 settled twice is matched to ONE item');
select is((select count(*) from payments.reconciliation_matches where run_id = pg_temp.got('run1')::uuid and kind = 'payment_receipt' and provider_payment_id = pg_temp.pp(8)), 1::bigint,
  'U17: payment 8 posted twice is matched to ONE receipt');
select is((select count(*) from payments.reconciliation_matches where run_id = pg_temp.got('run1')::uuid and kind = 'payment_receipt' and provider_payment_id = pg_temp.pp(5)), 0::bigint,
  'U16: payment 5 is NOT matched to a receipt that sits on another borrower''s loan');
-- U17: over-settlement and over-posting.
select is(pg_temp.exc_for('duplicate_payment', 'settlement_item_id', (select i.id from payments.settlement_items i join payments.settlement_batches b on b.id = i.batch_id where b.batch_ref = 'B-6B')), 1::bigint,
  'U17: the second settlement of payment 6 is an exception');
select is(pg_temp.exc_for('duplicate_payment', 'settlement_item_id', (select i.id from payments.settlement_items i join payments.settlement_batches b on b.id = i.batch_id where b.batch_ref = 'B-6A')), 0::bigint,
  'U17: the first is not');
select is(pg_temp.exc_for('amount_mismatch', 'provider_payment_id', pg_temp.pp(7)), 1::bigint,
  'U17: payment 7 has an item of the right amount AND an item of another amount: amount_mismatch');
select is(pg_temp.exc_for('duplicate_payment', 'receipt_id', (select id from servicing.lms_receipts where lms_receipt_ref = 'SR-RCPT-8B')), 1::bigint, 'U17: the second receipt of payment 8 is an exception');
select is(pg_temp.exc_for('duplicate_payment', 'receipt_id', (select id from servicing.lms_receipts where lms_receipt_ref = 'SR-RCPT-8A')), 0::bigint, 'U17: the first is not');
-- U16: the receipt on the wrong loan.
select is(pg_temp.exc_for('lender_receipt_missing', 'provider_payment_id', pg_temp.pp(5)), 1::bigint, 'U16: payment 5 has no receipt on its own loan: lender_receipt_missing');
select is(pg_temp.exc_for('lender_receipt_no_intent', 'receipt_id', (select id from servicing.lms_receipts where lms_receipt_ref = 'SR-RCPT-5X')), 1::bigint,
  'U16: and the receipt that carries our reference on another loan is an exception of its own');
select is(pg_temp.exc_for('lender_receipt_missing', 'provider_payment_id', pg_temp.pp(1)), 0::bigint, 'payment 1, posted on its own loan, is not missing');
-- U21: amount and account are judged independently.
select is(pg_temp.exc_sev_owner('amount_mismatch', 'settlement_batch_id', (select id from payments.settlement_batches where batch_ref = 'B-11')), 'warning/lender', 'U21: batch 11: the credit is one paisa short: amount_mismatch (the lender''s)');
select is(pg_temp.exc_sev_owner('settlement_account_mismatch', 'settlement_batch_id', (select id from payments.settlement_batches where batch_ref = 'B-11')), 'critical/platform',
  'U21: AND the credit is in another account: a CRITICAL settlement_account_mismatch that belongs to the platform');
select is(pg_temp.exc_sev_owner('settlement_account_mismatch', 'settlement_batch_id', (select id from payments.settlement_batches where batch_ref = 'B-16')), 'critical/platform',
  'U21: batch 16 (right amount, other account): critical, platform-owned (it used to be lender-owned and lender-resolvable)');
select is(pg_temp.exc_for('amount_mismatch', 'settlement_batch_id', (select id from payments.settlement_batches where batch_ref = 'B-16')), 0::bigint, 'U21: and no amount_mismatch for it');
select is(pg_temp.exc_sev_owner('amount_mismatch', 'settlement_batch_id', (select id from payments.settlement_batches where batch_ref = 'B-15')), 'warning/lender', 'batch 15: another amount in the right account: amount_mismatch only');
select is(pg_temp.exc_for('settlement_account_mismatch', 'settlement_batch_id', (select id from payments.settlement_batches where batch_ref = 'B-15')), 0::bigint, 'and no account exception');
-- U13: nothing is confirmed by a credit that covers only part of the batch.
select is(pg_temp.exc_for('amount_mismatch', 'settlement_batch_id', (select id from payments.settlement_batches where batch_ref = 'B-2')), 0::bigint,
  'U13: batch 2: the credit equals the batch total, so it is not an amount problem: the problem is the items (the platform exception above)');
-- U23: a batch that ends in the future hides nothing.
select is(pg_temp.exc_for('provider_success_no_settlement', 'provider_payment_id', pg_temp.pp(9)), 1::bigint,
  'U23: payment 9 is listed only in a batch that ends in the future: it is NOT hidden, provider_success_no_settlement');
select is((select count(*) from payments.reconciliation_matches where run_id = pg_temp.got('run1')::uuid and provider_payment_id = pg_temp.pp(9)), 0::bigint, 'U23: and the batch is no evidence for this date');
select is(pg_temp.exc_for('provider_success_no_settlement', 'provider_payment_id', pg_temp.pp(4)), 1::bigint,
  'U14: payment 4 was listed only in the batch that was not stored: it is not settled (provider_success_no_settlement)');
-- U15 and A44: the standing line and the evidence flag.
select is((select report -> 'settled_to_non_lender' from payments.reconciliation_runs where id = pg_temp.got('run1')::uuid), '{"items": 0, "minor": 0}'::jsonb, 'the standing line is zero for lender X');
select is((select report -> 'settlement_evidence' from payments.reconciliation_runs where id = pg_temp.got('run1')::uuid),
  '{"zero_is_evidence": false, "off_account_batches": 0, "destination_unstated_batches": 1, "destination_unstated_minor": 475000, "settlement_report_exists": true}'::jsonb,
  'A44, U15: but zero is NOT evidence: one batch of 4,750.00 has no stated destination');
select is((select report -> 'settings' from payments.reconciliation_runs where id = pg_temp.got('run1')::uuid), '{"receipt_lag_hours": 72, "settlement_lag_days": 3, "above_platform_default": false}'::jsonb,
  'U25: the run reports the waiting times it used and that they are not above the platform defaults');
select is(pg_temp.truth(), pg_temp.got('truth'), 'U26: the run changed no payment, intent, adjustment, receipt, batch, item, credit, balance snapshot or payment configuration');
select pg_temp.as_system();
select is(pg_temp.run() ->> 'run_id', pg_temp.got('run1'), 'a run on unchanged inputs returns the same run');

-- ============================================================================================================================
-- 7. The derived stage (U13, U14, U15, U16, U19, U21, U23, U24, U26) and who sees it (U19, U57)
-- ============================================================================================================================
select pg_temp.as_user(pg_temp.u(5));
select is((select stage from payments.payment_stages where provider_payment_id = pg_temp.pp(1)), 'lender_posted', 'payment 1: the full chain');
select is((select stage from payments.payment_stages where provider_payment_id = pg_temp.pp(2)), 'provider_settled', 'U13: payment 2: a credit that covers only part of the batch does not confirm it');
select is((select stage from payments.payment_stages where provider_payment_id = pg_temp.pp(3)), 'bank_confirmed', 'payment 3: the one batch that holds its bank reference is confirmed');
select is((select stage from payments.payment_stages where provider_payment_id = pg_temp.pp(11)), 'provider_settled', 'U21, U26: payment 11: the credit has another amount and is in another account: not confirmed');
select is((select stage from payments.payment_stages where provider_payment_id = pg_temp.pp(16)), 'provider_settled', 'U26: payment 16: the right amount in another account: not confirmed (the account check of the view)');
select is((select stage from payments.payment_stages where provider_payment_id = pg_temp.pp(15)), 'provider_settled', 'U26: payment 15: another amount in the right account: not confirmed (the amount check of the view)');
select is((select (stage, settlement_destination_ok)::text from payments.payment_stages where provider_payment_id = pg_temp.pp(12)), '(provider_settled,)',
  'U15, U26: payment 12: no destination stated: settled by the provider, NEVER bank confirmed, and the destination shows as unknown (null)');
select is((select stage from payments.payment_stages where provider_payment_id = pg_temp.pp(13)), 'provider_settled', 'U26: payment 13: the parts of its batch do not add up: not confirmed');
select is((select stage from payments.payment_stages where provider_payment_id = pg_temp.pp(9)), 'provider_captured', 'U23: payment 9: a batch that ends in the future is not "provider settled"');
select is((select lender_posted from payments.payment_stages where provider_payment_id = pg_temp.pp(5)), false, 'U16, U26: payment 5: a receipt on another loan is not "posted by the lender"');
select is((select lender_posted from payments.payment_stages where provider_payment_id = pg_temp.pp(8)), true, 'payment 8: posted (twice: the exception is the run''s)');
select is((select to_jsonb(s) ->> 'bank_confirmation_basis' from payments.payment_stages s where provider_payment_id = pg_temp.pp(3)), 'lender_reported_credit', 'U24: a bank confirmation says it rests on a credit the LENDER reported');
select is((select to_jsonb(s) ->> 'bank_confirmation_basis' from payments.payment_stages s where provider_payment_id = pg_temp.pp(2)), null, 'U24: and only a confirmation does');
select is((select count(*) from payments.payment_stages), 16::bigint, 'a reader of lender X sees the 16 successful payments of the lender (the duplicate capture is not a stage row)');
-- A reconciler holds payment.read but not loan.read: the stage is the same, and the lender's receipts stay closed to them.
select pg_temp.as_user(pg_temp.u(3));
select is((select count(*) from servicing.lms_receipts), 0::bigint, 'U19: fixture: a reconciler cannot read the lender''s receipts directly (no loan.read)');
select is((select lender_posted from payments.payment_stages where provider_payment_id = pg_temp.pp(1)), true, 'U19: and still sees that payment 1 was posted (the stage view needs only payment.read)');
-- Another lender.
select pg_temp.as_user(pg_temp.u(6));
select is((select count(*) from payments.payment_stages), 0::bigint, 'U19: lender Y''s viewer sees no stage row of lender X');
select is(pg_temp.err($$select count(*) from payments.payment_stages where 1 / (amount_minor - 475000) > 0$$), 'ok',
  'U19, U57: and a predicate crafted to raise on lender X''s amounts is never evaluated against lender X''s rows (no division by zero)');
select is(pg_temp.err($$select count(*) from payments.payment_stages where provider_payment_id::text::integer > 0$$), 'ok', 'U57: nor a cast of lender X''s identifiers');
select is((select count(*) from payments.payment_stages where amount_minor = 475000), 0::bigint, 'U19: and the amount cannot be probed through the view (no existence oracle)');
select is(pg_temp.val(format('select private.payment_lender_posted(%L::uuid)', pg_temp.pp(1))), 'false', 'U19: the posted helper answers false for another lender''s payment (no oracle either)');
select pg_temp.as_user(pg_temp.u(1));
select is((select count(*) from payments.payment_stages), 0::bigint, 'a borrower sees no stage');
select pg_temp.as_system();
select is(pg_temp.err($$select count(*) from payments.payment_stages$$), '42501|', 'the system role cannot read the view: stages are for people');

-- ============================================================================================================================
-- 8. A resolved condition that returns is raised again (U18)
-- ============================================================================================================================
select pg_temp.as_owner();
select is(pg_temp.exc_open_for('lender_receipt_missing', 'provider_payment_id', pg_temp.pp(10)), 1::bigint, 'payment 10 has no receipt: lender_receipt_missing is open');
select pg_temp.keep('x10', (select id::text from payments.reconciliation_exceptions where class = 'lender_receipt_missing' and subject ->> 'provider_payment_id' = pg_temp.pp(10)::text));
select pg_temp.as_user(pg_temp.u(3));
select is(payments.resolve_exception(pg_temp.got('x10')::uuid, 'posted_by_lender', '["SR-RCPT-10"]'::jsonb, 'posted'), 'resolved', 'the lender''s reconciler resolves it: posted by the lender');
select pg_temp.as_owner();
insert into servicing.lms_receipts (lender_org_id, loan_account_id, kind, lms_receipt_ref, amount_minor, value_date, bank_reference, source_system, source_record_id, reported_as_of, content_sha256)
values (pg_temp.lx(), pg_temp.lid(10), 'receipt', 'SR-RCPT-10', 475000, pg_temp.d() - 2, 'PAY-10', 'file_import', 'SRC-R10', clock_timestamp() - interval '1 hour', pg_temp.sha('r10'));
select pg_temp.as_system();
select pg_temp.keep('run2', pg_temp.run() ->> 'run_id');
select pg_temp.as_owner();
select is((select count(*) from payments.reconciliation_matches where run_id = pg_temp.got('run2')::uuid and kind = 'payment_receipt' and provider_payment_id = pg_temp.pp(10)), 1::bigint, 'the next run matches the receipt');
select is(pg_temp.exc_for('lender_receipt_missing', 'provider_payment_id', pg_temp.pp(10)), 1::bigint, 'and opens nothing new');
-- The LMS then reverses that receipt: the repayment is un-posted.
insert into servicing.lms_receipts (lender_org_id, loan_account_id, kind, lms_receipt_ref, reverses_receipt_id, reverses_receipt_ref, amount_minor, value_date, bank_reference, source_system, source_record_id, reported_as_of, content_sha256)
select pg_temp.lx(), pg_temp.lid(10), 'reversal', 'SR-RCPT-10R', r.id, 'SR-RCPT-10', 475000, pg_temp.d() - 1, 'PAY-10', 'file_import', 'SRC-R10R', clock_timestamp() - interval '1 hour', pg_temp.sha('r10r')
from servicing.lms_receipts r where r.lms_receipt_ref = 'SR-RCPT-10';
select pg_temp.as_system();
select pg_temp.keep('run3', pg_temp.run() ->> 'run_id');
select pg_temp.as_owner();
select is((select count(*) from payments.reconciliation_matches where run_id = pg_temp.got('run3')::uuid and kind = 'payment_receipt' and provider_payment_id = pg_temp.pp(10)), 0::bigint, 'the run after the reversal no longer matches it');
select is(pg_temp.exc_for('lender_receipt_missing', 'provider_payment_id', pg_temp.pp(10)) || '/' || pg_temp.exc_open_for('lender_receipt_missing', 'provider_payment_id', pg_temp.pp(10)), '2/1',
  'U18: the condition came back after the resolution, so a NEW exception is open (the resolved one stays as history)');
-- A resolved exception whose condition never cleared is NOT opened again by later runs.
select pg_temp.keep('x10b', (select id::text from payments.reconciliation_exceptions where class = 'lender_receipt_missing' and subject ->> 'provider_payment_id' = pg_temp.pp(10)::text and status <> 'resolved'));
select pg_temp.as_user(pg_temp.u(3));
select is(pg_temp.val(format($$select payments.resolve_exception(%L::uuid, 'timing_difference', '["SR-RCPT-10R"]'::jsonb, 'looked at')$$, coalesce(nullif(pg_temp.got('x10b'), ''), gen_random_uuid()::text))), 'resolved',
  'the reconciler resolves it again');
select pg_temp.as_user(pg_temp.u(3));
select pg_temp.credits('fde10000-0000-4000-8000-000000000001', format('[{"valueDate":"%s","amountMinor":"123456","utr":"%s"}]', pg_temp.d(), pg_temp.utr(88)));
select pg_temp.as_system();
select is(pg_temp.run() ->> 'run_no', '4', 'a new input makes a new run');
select pg_temp.as_owner();
select is(pg_temp.exc_for('lender_receipt_missing', 'provider_payment_id', pg_temp.pp(10)) || '/' || pg_temp.exc_open_for('lender_receipt_missing', 'provider_payment_id', pg_temp.pp(10)), '2/0',
  'U18: and since nothing cleared and returned in between, the second resolution stands (no new exception every day)');
select is(pg_temp.exc_for('lender_receipt_missing', 'provider_payment_id', pg_temp.pp(5)), 1::bigint, 'U18: the other missing receipts were never resolved: still one exception each');

-- A settings change is an input of the run (U26): a lender that lengthens the waiting time gets a NEW run, reporting it.
select pg_temp.as_user(pg_temp.u(4));
select payments.set_reconciliation_settings(pg_temp.lx(), 4, 72);
select pg_temp.as_system();
select pg_temp.keep('run5', pg_temp.run() ->> 'run_id');
select pg_temp.as_owner();
select is((select run_no from payments.reconciliation_runs where id = pg_temp.got('run5')::uuid), 5, 'U26: a change of the waiting time only makes a new run (the settings are part of the input hash)');
select is((select report -> 'settings' from payments.reconciliation_runs where id = pg_temp.got('run5')::uuid), '{"receipt_lag_hours": 72, "settlement_lag_days": 4, "above_platform_default": true}'::jsonb,
  'U25: and the run says that the waiting time is above the platform default');
-- A row written before the ceilings existed is capped when a run reads it.
alter table payments.reconciliation_settings drop constraint if exists reconciliation_settings_settlement_lag_ceiling;
update payments.reconciliation_settings set settlement_lag_days = 30 where lender_org_id = pg_temp.lx();
select pg_temp.as_system();
select pg_temp.keep('run6', pg_temp.run() ->> 'run_id');
select pg_temp.as_owner();
select is((select report -> 'settings' ->> 'settlement_lag_days' from payments.reconciliation_runs where id = pg_temp.got('run6')::uuid), '7', 'U25: a legacy waiting time of 30 days is capped at the platform ceiling of 7');

-- ============================================================================================================================
-- 9. The standing line and the evidence flag (A44, U12, U15)
-- ============================================================================================================================
select pg_temp.as_system();
select pg_temp.keep('rz0', pg_temp.run_z() ->> 'run_id');
select is(pg_temp.report_of(jsonb_build_object('run_id', pg_temp.got('rz0'))) -> 'settlement_evidence' ->> 'zero_is_evidence', 'false', 'A44: with no settlement report at all, zero is not evidence');
select is(pg_temp.report_of(jsonb_build_object('run_id', pg_temp.got('rz0'))) -> 'settled_to_non_lender', '{"items": 0, "minor": 0}'::jsonb, 'the line itself is zero');
-- A mask with stars and a different length is still the same last four digits.
select is(pg_temp.val($$select pg_temp.report_z(jsonb_build_array(pg_temp.batch('ZB1', pg_temp.utr(201), 3, 0, '[]'::jsonb, '****3333')))$$), jsonb_build_object('recorded', 1, 'duplicates', 0, 'conflicts', 0)::text,
  'a settlement report with a differently padded mask of the same account is recorded');
select pg_temp.keep('rz1', pg_temp.run_z() ->> 'run_id');
select is((select count(*)::text || '/' || coalesce(max(destination_ok::text), 'null') from payments.settlement_batches where batch_ref = 'ZB1'), '1/true', 'A44: destinations are compared by their last four digits: ****3333 is XXXXXX3333');
select is((select status from payments.lender_payment_configs where id = pg_temp.got('cfgz')::uuid), 'active', 'A44: so the configuration is not suspended by a padding difference');
select is(pg_temp.report_of(jsonb_build_object('run_id', pg_temp.got('rz1'))) -> 'settlement_evidence', '{"zero_is_evidence": true, "off_account_batches": 0, "destination_unstated_batches": 0, "destination_unstated_minor": 0, "settlement_report_exists": true}'::jsonb,
  'A44: with a settlement report whose destinations are all verified, zero IS evidence');
-- A batch with no destination.
select pg_temp.val($$select pg_temp.report_z(jsonb_build_array(pg_temp.batch('ZB2', pg_temp.utr(202), 3, 125000, jsonb_build_array(pg_temp.item('PAY-ZB2', 125000)), null)))$$);
select pg_temp.keep('rz2', pg_temp.run_z() ->> 'run_id');
select is(pg_temp.report_of(jsonb_build_object('run_id', pg_temp.got('rz2'))) -> 'settlement_evidence', '{"zero_is_evidence": false, "off_account_batches": 0, "destination_unstated_batches": 1, "destination_unstated_minor": 125000, "settlement_report_exists": true}'::jsonb,
  'A44, U15: a batch with no stated destination is counted, and zero is no longer evidence');
select is(pg_temp.report_of(jsonb_build_object('run_id', pg_temp.got('rz2'))) -> 'settled_to_non_lender', '{"items": 0, "minor": 0}'::jsonb, 'while the standing line itself stays zero');
-- Too few digits to compare, and an unreadable destination (it must not refuse the report, and it must not be stored).
select is(pg_temp.val($$select pg_temp.report_z(jsonb_build_array(pg_temp.batch('ZB3', pg_temp.utr(203), 3, 75000, jsonb_build_array(pg_temp.item('PAY-ZB3', 75000)), 'XXXXXX33'),
                                             pg_temp.batch('ZB5', pg_temp.utr(205), 3, 0, '[]'::jsonb, 'HDFC BANK ACCOUNT')))$$),
  jsonb_build_object('recorded', 2, 'duplicates', 0, 'conflicts', 0)::text, 'U15: a destination with only two digits, and one that is not a mask at all, are recorded (the report is not refused)');
select is((select count(*)::text || '/' || coalesce(max(destination_ok::text), 'null') from payments.settlement_batches where batch_ref = 'ZB3'), '1/null', 'U15: two digits that agree prove nothing: destination_ok stays null');
select is((select count(*)::text || '/' || coalesce(max(destination_masked_ref), 'null') from payments.settlement_batches where batch_ref = 'ZB5'), '1/null', 'U15: an unreadable destination is recorded without it (it could be an account number)');
select is((select count(*)::text || '/' || coalesce(max(destination_ok::text), 'null') from payments.settlement_batches where batch_ref = 'ZB5'), '1/null', 'and is not the lender''s account either');
select pg_temp.keep('rz3', pg_temp.run_z() ->> 'run_id');
select is(pg_temp.report_of(jsonb_build_object('run_id', pg_temp.got('rz3'))) -> 'settlement_evidence' ->> 'destination_unstated_batches', '3', 'U15: three batches have no confirmed destination (none, two digits, unreadable)');
select is(pg_temp.report_of(jsonb_build_object('run_id', pg_temp.got('rz3'))) -> 'settlement_evidence' ->> 'destination_unstated_minor', '200000', 'and 2,000.00 of net settlement is not yet attributed to the lender''s account');
-- Two digits that DIFFER prove it is another account.
select is(pg_temp.val($$select pg_temp.report_z(jsonb_build_array(pg_temp.batch('ZB4', pg_temp.utr(204), 3, 250000, jsonb_build_array(pg_temp.item('PAY-ZB4', 250000)), 'XXXXXX44')))$$),
  jsonb_build_object('recorded', 1, 'duplicates', 0, 'conflicts', 0)::text, 'a destination whose last two digits differ from the lender''s account is recorded');
select is((select count(*)::text || '/' || coalesce(max(destination_ok::text), 'null') from payments.settlement_batches where batch_ref = 'ZB4'), '1/false', 'A44: visible digits that differ are enough to say it is another account');
select is((select status from payments.lender_payment_configs where id = pg_temp.got('cfgz')::uuid), 'suspended', 'and the configuration is suspended at once');
-- U12: off-account batches with no items, and with fewer items than their total.
select pg_temp.val($$select pg_temp.report_z(jsonb_build_array(pg_temp.batch('OFF1', pg_temp.utr(211), 2, 300000, '[]'::jsonb, 'XXXXXX9999'),
                                          pg_temp.batch('OFF2', pg_temp.utr(212), 2, 900000, jsonb_build_array(pg_temp.item('PAY-OFF2', 10000)), 'XXXXXX9999')))$$);
select pg_temp.keep('rz4', pg_temp.run_z() ->> 'run_id');
select is(pg_temp.report_of(jsonb_build_object('run_id', pg_temp.got('rz4'))) -> 'settled_to_non_lender', '{"items": 2, "minor": 1450000}'::jsonb,
  'U12: the standing line counts the BATCHES that went elsewhere: 2,500.00 + 3,000.00 + 9,000.00 = 14,500.00, not the 1,000.00 + 2,500.00 of the items that happen to be listed');
select is(pg_temp.report_of(jsonb_build_object('run_id', pg_temp.got('rz4'))) -> 'settlement_evidence' ->> 'off_account_batches', '3', 'U12: three batches went to another account');
select is(pg_temp.report_of(jsonb_build_object('run_id', pg_temp.got('rz4'))) -> 'settlement_evidence' ->> 'zero_is_evidence', 'false', 'and zero is of course not evidence');

-- ============================================================================================================================
-- 10. Guards that must hold even if the function is wrong
-- ============================================================================================================================
-- Old rows (no tie flag): the items are added up when the batch is read. A batch recorded before the check existed whose items do NOT add up is never
-- confirmed by a matching credit; one whose items do add up is (payment 10, listed in a legacy batch with a credit of 4,750.00).
select pg_temp.as_owner();
insert into payments.settlement_batches (lender_org_id, config_id, provider, batch_ref, settlement_ref, period_from, period_to, destination_masked_ref, destination_ok, gross_minor, fee_minor, tax_minor, net_minor,
                                         parts_mismatch, item_count, content_sha256, report_date)
values (pg_temp.lx(), pg_temp.got('cfg')::uuid, 'mock_gateway', 'B-OLD', pg_temp.utr(95), pg_temp.d() - 4, pg_temp.d() - 4, 'XXXXXX1111', true, 123456, 0, 0, 123456, false, 0, pg_temp.sha('b-old'), pg_temp.d()),
       (pg_temp.lx(), pg_temp.got('cfg')::uuid, 'mock_gateway', 'B-LEGACY', pg_temp.utr(94), pg_temp.d() - 4, pg_temp.d() - 4, 'XXXXXX1111', true, 475000, 0, 0, 475000, false, 1, pg_temp.sha('b-legacy'), pg_temp.d());
insert into payments.settlement_items (batch_id, lender_org_id, provider_payment_ref, gross_minor, fee_minor, tax_minor, net_minor, parts_mismatch)
select id, lender_org_id, 'PAY-10', 475000, 0, 0, 475000, false from payments.settlement_batches where batch_ref = 'B-LEGACY';
-- Two more rows written without the function (as a row of an older version, or a direct write, would be): no stated destination, and a tie flag of true.
select is(pg_temp.err(format($i$insert into payments.settlement_batches (lender_org_id, config_id, provider, batch_ref, settlement_ref, period_from, period_to, destination_masked_ref, destination_ok, gross_minor, fee_minor, tax_minor, net_minor,
                                         parts_mismatch, item_count, content_sha256, report_date, items_total_mismatch)
  values (%1$L, %2$L, 'mock_gateway', 'B-NULLD', %3$L, %5$L, %5$L, null, null, 1000, 0, 0, 1000, false, 0, %6$L, %7$L, false),
         (%1$L, %2$L, 'mock_gateway', 'B-BADT', %4$L, %5$L, %5$L, 'XXXXXX1111', true, 1000, 0, 0, 1000, false, 0, %8$L, %7$L, true)$i$,
  pg_temp.lx(), pg_temp.got('cfg'), pg_temp.utr(97), pg_temp.utr(98), pg_temp.d() - 4, pg_temp.sha('b-nulld'), pg_temp.d(), pg_temp.sha('b-badt'))), 'ok',
  'fixture: a batch with no stated destination and a batch flagged as not tied, written without the function');
select pg_temp.as_user(pg_temp.u(3));
select pg_temp.credits('fde10000-0000-4000-8000-000000000001', format('[{"valueDate":"%1$s","amountMinor":"123456","utr":"%2$s"},{"valueDate":"%1$s","amountMinor":"475000","utr":"%3$s"}]', pg_temp.d() - 3, pg_temp.utr(95), pg_temp.utr(94)));
select pg_temp.as_system();
select pg_temp.keep('run7', pg_temp.run() ->> 'run_id');
select pg_temp.as_owner();
select is((select count(*) from payments.reconciliation_matches m join payments.settlement_batches b on b.id = m.settlement_batch_id where m.run_id = pg_temp.got('run7')::uuid and b.batch_ref = 'B-OLD'), 0::bigint,
  'a batch recorded before the tie was checked whose items do not add up is never confirmed by a credit');
select is((select count(*) from payments.reconciliation_matches m join payments.settlement_batches b on b.id = m.settlement_batch_id where m.run_id = pg_temp.got('run7')::uuid and b.batch_ref = 'B-LEGACY'), 1::bigint,
  'while a legacy batch whose items do add up is confirmed by its credit');
select is(pg_temp.exc_sev_owner('event_payload_conflict', 'settlement_batch_id', (select id from payments.settlement_batches where batch_ref = 'B-OLD')), 'warning/platform',
  'U13: the run tells the platform that the legacy batch does not add up');
select pg_temp.as_user(pg_temp.u(5));
select is((select stage from payments.payment_stages where provider_payment_id = pg_temp.pp(10)), 'bank_confirmed', 'and the stage view agrees: payment 10 is bank confirmed through the legacy batch (its receipt was reversed)');
select pg_temp.as_owner();
select is(pg_temp.exc_sev_owner('settlement_account_mismatch', 'settlement_batch_id', (select id from payments.settlement_batches where batch_ref = 'B-NULLD')), 'warning/platform',
  'U15: the run itself tells the platform about a batch with no verified destination, whoever wrote the row');
select is(pg_temp.exc_sev_owner('event_payload_conflict', 'settlement_batch_id', (select id from payments.settlement_batches where batch_ref = 'B-BADT')), 'warning/platform',
  'U13: the run itself tells the platform about a batch whose items do not add up, whoever wrote the row');
-- The run's own guard against one bank reference on two batches (here with the table rule removed inside this transaction, to prove the run and the view do
-- not rely on it). Two batches carry bank reference 96; payment 14 is listed in the first; ONE credit of 4,750.00 arrived for that reference.
select is(pg_temp.err('drop index payments.settlement_batches_config_utr'), 'ok', 'fixture: the table rule is removed inside this transaction (rolled back at the end)');
select is(pg_temp.err(format($i$insert into payments.settlement_batches (lender_org_id, config_id, provider, batch_ref, settlement_ref, period_from, period_to, destination_masked_ref, destination_ok, gross_minor, fee_minor, tax_minor, net_minor,
                                         parts_mismatch, item_count, content_sha256, report_date, items_total_mismatch)
  values (%1$L, %2$L, 'mock_gateway', 'B-DUP1', %3$L, %4$L, %4$L, 'XXXXXX1111', true, 475000, 0, 0, 475000, false, 1, %5$L, %6$L, false),
         (%1$L, %2$L, 'mock_gateway', 'B-DUP2', %3$L, %4$L, %4$L, 'XXXXXX1111', true, 475000, 0, 0, 475000, false, 0, %7$L, %6$L, false)$i$,
  pg_temp.lx(), pg_temp.got('cfg'), pg_temp.utr(96), pg_temp.d() - 4, pg_temp.sha('b-dup1'), pg_temp.d(), pg_temp.sha('b-dup2'))), 'ok',
  'fixture: two batches under the same bank reference, each with a tie flag of false');
insert into payments.settlement_items (batch_id, lender_org_id, provider_payment_ref, gross_minor, fee_minor, tax_minor, net_minor, parts_mismatch)
select id, lender_org_id, 'PAY-14', 475000, 0, 0, 475000, false from payments.settlement_batches where batch_ref = 'B-DUP1';
select pg_temp.as_user(pg_temp.u(3));
select pg_temp.credits('fde10000-0000-4000-8000-000000000001', format('[{"valueDate":"%s","amountMinor":"475000","utr":"%s"}]', pg_temp.d() - 3, pg_temp.utr(96)));
select pg_temp.as_system();
select pg_temp.keep('run8', pg_temp.run() ->> 'run_id');
select pg_temp.as_owner();
select is((select count(*) from payments.reconciliation_matches m join payments.settlement_batches b on b.id = m.settlement_batch_id where m.run_id = pg_temp.got('run8')::uuid and b.settlement_ref = pg_temp.utr(96)), 0::bigint,
  'U14: a bank credit is never matched to two batches: when more than one batch carries the reference, none is confirmed');
select is((select count(*) from payments.reconciliation_exceptions where class = 'event_payload_conflict' and severity = 'critical' and owner = 'platform'
            and subject ->> 'settlement_batch_id' in (select id::text from payments.settlement_batches where settlement_ref = pg_temp.utr(96))), 2::bigint,
  'U14: each of the two batches under that reference opens a critical platform exception');
select pg_temp.as_user(pg_temp.u(5));
select is((select stage from payments.payment_stages where provider_payment_id = pg_temp.pp(14)), 'provider_settled', 'U14: and the stage view does not confirm a payment whose batch shares its bank reference with another batch');
select pg_temp.as_owner();
-- A direct write cannot slip a bad bank reference past the function either.
select is(pg_temp.err(format($$insert into payments.bank_credits (lender_org_id, settlement_account_id, value_date, amount_minor, utr, recorded_by) values (%L, 'fde10000-0000-4000-8000-000000000001', current_date, 100, 'ABCDE1234F', %L)$$,
  pg_temp.lx(), pg_temp.u(3))), '23514|', 'U20: the table itself refuses a bank reference of the wrong shape');
select is(pg_temp.err(format($$insert into payments.reconciliation_matches (run_id, lender_org_id, kind, provider_payment_id, settlement_item_id, amount_minor)
  select m.run_id, m.lender_org_id, m.kind, m.provider_payment_id, m.settlement_item_id, m.amount_minor from payments.reconciliation_matches m where m.run_id = %L and m.kind = 'payment_settlement' limit 1$$, pg_temp.got('run1'))), '23505|',
  'U17: a second match of the same payment in a run is impossible, whatever writes it');

select * from finish();
rollback;
