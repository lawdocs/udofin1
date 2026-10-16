-- Phase 08a repayment mandates (migration 20261018000915). The lender is the creditor; a mandate is created in draft by the borrower (step-up code
-- bound to the mandate, device integrity, rail limits from the configuration) and moves ONLY on a verified provider event or an authenticated status
-- lookup, by the system. Debits are planned from the lender's reported schedule and never exceed the mandate maximum. Synthetic data only (labelled
-- SAMPLE). Error codes are reported as SQLSTATE|hint.
begin;
create extension if not exists pgtap with schema extensions;
select plan(223);

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
-- A definer function that tries to move a mandate while called as a borrower: the trigger must still refuse (defence in depth for any future function).
create function pg_temp.try_move(p uuid) returns void language plpgsql security definer as $fn$
begin
  update payments.mandates set status = 'registration_pending', provider_mandate_ref = 'SAMPLE-SNEAKY' where id = p;
end
$fn$;

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

-- A delivery as the callback receiver hands it over (verified by the verifier).
create function pg_temp.at(m integer) returns text language sql as $fn$ select to_char((clock_timestamp() + make_interval(mins => m)) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') $fn$;
create function pg_temp.dlv(p_delivery text, p_event text, p_kind text, p_status text, p_obj text, p_order text default null, p_amount bigint default null,
  p_occurred text default '2026-10-15T10:00:00Z', p_provider text default 'mock_gateway', p_merchant text default null) returns jsonb language sql as $fn$
  select jsonb_strip_nulls(jsonb_build_object(
    'provider', p_provider, 'outcome', 'verified', 'reason_class', 'none', 'delivery_id', p_delivery, 'payload_sha256', pg_temp.sha('body-' || p_delivery),
    'scheme', 'mock-standard-webhooks-v1', 'signature_present', true, 'timestamp_skew_seconds', 3, 'body_bytes', 420, 'ip_hmac', repeat('a', 64),
    'event', jsonb_build_object('provider', p_provider, 'deliveryId', p_delivery, 'eventId', p_event, 'objectKind', p_kind, 'objectRef', p_obj, 'orderRef', p_order, 'status', p_status,
      'rank', case p_status when 'created' then 10 when 'pending' then 15 when 'active' then 30 when 'returned' then 40 when 'paused' then 35 when 'revoked' then 45 else 30 end,
      'amountMinor', p_amount::text, 'currency', case when p_amount is null then null else 'INR' end, 'occurredAt', p_occurred, 'merchantRef', p_merchant)));
$fn$;
create function pg_temp.ing(p_lender uuid, p_d jsonb) returns text language sql as $fn$ select (payments.ingest_provider_delivery(pg_temp.tok(p_lender), p_d) ->> 'outcome') $fn$;
create function pg_temp.ev(p_event text) returns uuid language sql as $fn$ select id from payments.provider_events where provider_event_id = p_event $fn$;
-- Deliver, then apply: returns the outcome the worker would record.
create function pg_temp.deliver(p_lender uuid, p_delivery text, p_event text, p_kind text, p_status text, p_obj text, p_order text default null, p_amount bigint default null,
  p_occurred text default '2026-10-15T10:00:00Z', p_provider text default 'mock_gateway') returns text language plpgsql as $fn$
declare v_in text; v_out text;
begin
  v_in := pg_temp.ing(p_lender, pg_temp.dlv(p_delivery, p_event, p_kind, p_status, p_obj, p_order, p_amount, p_occurred, p_provider));
  if v_in <> 'ok' then return 'ingest:' || v_in; end if;
  v_out := payments.apply_provider_event(pg_temp.ev(p_event)) ->> 'outcome';
  return v_out;
end
$fn$;
create function pg_temp.mstatus(p_mandate uuid) returns text language sql as $fn$ select status from payments.mandates where id = p_mandate $fn$;
create function pg_temp.mhist(p_mandate uuid) returns text language sql as $fn$
  select string_agg(coalesce(from_status, '-') || '>' || to_status || '/' || source, ',' order by created_at, id) from payments.mandate_events where mandate_id = p_mandate
$fn$;
create function pg_temp.exc(p_class text) returns bigint language sql as $fn$ select count(*) from payments.reconciliation_exceptions where class = p_class and status <> 'resolved' $fn$;
-- Step-up codes (verified, bound to a mandate id) and device-integrity results, as the identity module would have recorded them.
create function pg_temp.stepup(p_borrower text, p_mandate uuid) returns void language sql as $fn$
  insert into identity.stepup_challenges (id, borrower_id, action, context_ref, code_hash, status, delivery_status, expires_at, verified_at, verified_until)
  values (gen_random_uuid(), p_borrower::uuid, 'mandate_creation', p_mandate::text, repeat('a', 64), 'verified', 'accepted', now() + interval '10 minutes', now(), now() + interval '10 minutes')
$fn$;
create function pg_temp.integrity(p_borrower text, p_level text) returns void language sql as $fn$
  insert into identity.device_attestations (borrower_id, level, provider, verified_at, expires_at) values (p_borrower::uuid, p_level, 'sample_attest', clock_timestamp(), clock_timestamp() + interval '1 hour')
$fn$;
create function pg_temp.atd(days integer) returns text language sql as $fn$ select to_char(pg_temp.d() + days, 'YYYY-MM-DD') || 'T10:00:00Z' $fn$;
create function pg_temp.debit(p_mandate uuid, p_seq integer) returns uuid language sql as $fn$ select id from payments.mandate_debits where mandate_id = p_mandate and planned and installment_seq = p_seq $fn$;
create function pg_temp.notice(p_mandate uuid, p_seq integer) returns uuid language sql as $fn$ select n.id from payments.pre_debit_notices n where n.debit_id = pg_temp.debit(p_mandate, p_seq) $fn$;
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
  '{"enach_api": {"max_mandate_amount_minor": 5000000, "needs_afa_each_debit": false}, "upi_autopay": {"max_mandate_amount_minor": 1500000}}'::jsonb);

insert into servicing.feature_change_requests (lender_org_id, feature, enable, mode, status, evidence, requested_by, idempotency_key, decided_by, decided_at, applied_at)
select o.lender, f.feature, true, 'two_person', 'applied', '{"contract_ref":"SAMPLE-FC"}', pg_temp.u(7), 'fc-req-' || f.feature || '-' || right(o.lender::text, 1) || '-0001', pg_temp.u(8), now(), now()
from (values (pg_temp.lx()), (pg_temp.ly()), (pg_temp.lz())) o (lender) cross join (values ('servicing_sync'), ('mandates'), ('payments')) f (feature);
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
select is((select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'payments' and c.relname in ('lender_mandate_policies', 'mandate_transitions', 'mandates', 'mandate_events', 'mandate_return_codes', 'mandate_debits', 'pre_debit_notices')
             and c.relrowsecurity and c.relforcerowsecurity), 7::bigint, 'row level security is enabled and forced on all seven new tables');
select is((select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'payments' and c.relname in ('lender_mandate_policies', 'mandate_transitions', 'mandates', 'mandate_events', 'mandate_return_codes', 'mandate_debits', 'pre_debit_notices')
             and obj_description(c.oid, 'pg_class') like '%Owner: payments module.'), 7::bigint, 'every new table has a comment naming its owner module');
select is((select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'payments' and t.tgname = 'no_truncate' and not t.tgisinternal
             and c.relname in ('lender_mandate_policies', 'mandates', 'mandate_events', 'mandate_return_codes', 'mandate_debits', 'pre_debit_notices')), 6::bigint, 'a no_truncate trigger is on every new data table');
select ok((select bool_and(has_table_privilege('service_role', t, 'select') and not has_table_privilege('service_role', t, 'insert') and not has_table_privilege('service_role', t, 'update')
                           and not has_table_privilege('service_role', t, 'delete'))
           from unnest(array['payments.lender_mandate_policies', 'payments.mandate_transitions', 'payments.mandates', 'payments.mandate_events', 'payments.mandate_return_codes',
                             'payments.mandate_debits', 'payments.pre_debit_notices']) t), 'the system role can only READ the mandate tables: every write goes through a definer function');
select ok((select bool_and(not has_table_privilege('authenticated', t, 'insert') and not has_table_privilege('authenticated', t, 'update') and not has_table_privilege('authenticated', t, 'delete'))
           from unnest(array['payments.lender_mandate_policies', 'payments.mandate_transitions', 'payments.mandates', 'payments.mandate_events', 'payments.mandate_return_codes',
                             'payments.mandate_debits', 'payments.pre_debit_notices']) t), 'no signed-in role can write them directly, the borrower included');
select ok((select bool_and(not has_function_privilege('anon', f, 'execute'))
           from unnest(array['payments.request_mandate(uuid, uuid, text, bigint, date, date, text)', 'payments.my_mandates()', 'payments.request_mandate_cancellation(uuid)',
                             'payments.record_mandate_handoff(uuid, text, text, timestamptz)', 'payments.apply_mandate_lookup(uuid, text, text, timestamptz)',
                             'payments.plan_mandate_debits(interval)', 'payments.set_mandate_policy(uuid, text, bigint, integer)']) f), 'anon can execute none of the mandate functions');
select ok((select bool_and(not has_function_privilege('authenticated', f, 'execute'))
           from unnest(array['payments.record_mandate_handoff(uuid, text, text, timestamptz)', 'payments.apply_mandate_lookup(uuid, text, text, timestamptz)',
                             'payments.apply_debit_lookup(uuid, text, date, bigint, text, text, timestamptz)', 'payments.sweep_mandates(interval, interval, interval)',
                             'payments.plan_mandate_debits(interval)', 'payments.claim_pre_debit_notices(integer, interval)', 'payments.record_pre_debit_notice(uuid, text, text)',
                             'payments.request_cancel_for_closed_loans()', 'payments.mark_mandate_cancel_sent(uuid)']) f), 'a signed-in user cannot run the system functions');
select ok((select bool_and(not has_function_privilege('service_role', f, 'execute'))
           from unnest(array['payments.request_mandate(uuid, uuid, text, bigint, date, date, text)', 'payments.request_mandate_cancellation(uuid)', 'payments.my_mandates()',
                             'payments.set_mandate_policy(uuid, text, bigint, integer)', 'payments.set_return_code_class(text, text, text, text)']) f), 'the system role cannot act as a borrower, a lender or the platform');
select is((select count(*) from information_schema.columns where table_schema = 'payments' and table_name in ('mandates', 'mandate_events', 'mandate_debits', 'pre_debit_notices')
             and column_name ~* '(account_number|account_no|ifsc|phone|mobile|name|email|handoff_link|link|token|secret|otp|aadhaar|pan)$'), 0::bigint,
  'no mandate column can hold an account number, IFSC, name, phone number, hand-off link or secret: only the masked reference');
select is((select count(*) from payments.mandate_return_codes), 0::bigint, 'no return-code class is seeded: the code list comes from configuration only');
select is((select count(*) from payments.lender_mandate_policies), 0::bigint, 'no lender mandate policy is seeded');
select is((select count(*) from payments.mandate_transitions), 24::bigint, 'the lifecycle table has its 24 transitions');
select is((select count(*) from payments.mandate_transitions where allowed_actors <> array['system']), 0::bigint, 'and the system is the only actor in every one of them');

-- ============================================================================================================================
-- 2. The lender's settings
-- ============================================================================================================================
select pg_temp.as_user(pg_temp.u(4));
select is(pg_temp.err($$select payments.set_mandate_policy(pg_temp.lx(), 'optional', null, 48)$$), '42501|', 'a reader without payment.configure cannot set the policy');
select pg_temp.as_user(pg_temp.u(3), 'aal1');
select is(pg_temp.err($$select payments.set_mandate_policy(pg_temp.lx(), 'optional', null, 48)$$), '42501|mfa_required', 'nor without the second factor');
select pg_temp.as_user(pg_temp.u(3));
select is(pg_temp.err($$select payments.set_mandate_policy(pg_temp.ly(), 'optional', null, 48)$$), '42501|', 'nor for another lender');
select is(pg_temp.err($$select payments.set_mandate_policy(pg_temp.lx(), 'before_disbursal', null, 48)$$), '22023|policy_invalid', 'a mandate required before disbursal cannot be stored: the journey does not support it yet');
select is(pg_temp.err($$select payments.set_mandate_policy(pg_temp.lx(), 'optional', null, 12)$$), '22023|policy_invalid', 'a notice lead time under 24 hours is refused');
select is(pg_temp.err($$select payments.set_mandate_policy(pg_temp.lx(), 'optional', 0, 48)$$), '22023|policy_invalid', 'a zero ceiling is refused');
select is(payments.set_mandate_policy(pg_temp.lx(), 'before_first_due', 4000000, 48), 'set', 'the lender sets its mandate settings (ceiling 40,000.00)');
select is((select (requirement, max_amount_cap_minor, pre_debit_lead_hours)::text from payments.lender_mandate_policies where lender_org_id = pg_temp.lx()), '(before_first_due,4000000,48)', 'and they are stored');
select pg_temp.as_user(pg_temp.u(5));
select is((select count(*) from payments.lender_mandate_policies), 0::bigint, 'another lender''s user cannot read them');

-- ============================================================================================================================
-- 3. Asking for a mandate
-- ============================================================================================================================
select pg_temp.as_owner();
select pg_temp.integrity(pg_temp.got('b1'), 'basic');
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err(format($$select payments.request_mandate(%L, %L, 'enach_api', 4000000, %L, %L, 'XXXXXX9999')$$, pg_temp.mid(1), pg_temp.lid(1), pg_temp.d() + 1, pg_temp.d() + 365)),
  '42501|integrity_insufficient', 'a device with only "basic" integrity cannot create a mandate');
select pg_temp.as_owner();
select pg_temp.integrity(pg_temp.got('b1'), 'device');
select pg_temp.as_anon();
select is(pg_temp.err(format($$select payments.request_mandate(%L, %L, 'enach_api', 4000000, %L, %L, 'XXXXXX9999')$$, pg_temp.mid(1), pg_temp.lid(1), pg_temp.d() + 1, pg_temp.d() + 365)), '42501|', 'anon cannot ask for a mandate');
select pg_temp.as_user(pg_temp.u(3));
select is(pg_temp.err(format($$select payments.request_mandate(%L, %L, 'enach_api', 4000000, %L, %L, 'XXXXXX9999')$$, pg_temp.mid(1), pg_temp.lid(1), pg_temp.d() + 1, pg_temp.d() + 365)), '42501|', 'a lender user cannot ask for a mandate (borrowers only)');
select pg_temp.as_user(pg_temp.u(2));
select is(pg_temp.err(format($$select payments.request_mandate(%L, %L, 'enach_api', 4000000, %L, %L, 'XXXXXX9999')$$, pg_temp.mid(1), pg_temp.lid(1), pg_temp.d() + 1, pg_temp.d() + 365)), 'P0002|', 'a borrower cannot ask for a mandate on someone else''s loan');
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err(format($$select payments.request_mandate(%L, %L, 'cheque', 4000000, %L, %L, 'XXXXXX9999')$$, pg_temp.mid(1), pg_temp.lid(1), pg_temp.d() + 1, pg_temp.d() + 365)), '22023|bad_request', 'an unknown rail is refused');
select is(pg_temp.err(format($$select payments.request_mandate(%L, %L, 'enach_api', 4000000, %L, %L, '123456789012')$$, pg_temp.mid(1), pg_temp.lid(1), pg_temp.d() + 1, pg_temp.d() + 365)), '22023|account_ref_invalid', 'a full account number is refused: only a masked reference is accepted');
select is(pg_temp.err(format($$select payments.request_mandate(%L, %L, 'enach_api', 4000000, %L, %L, 'XXXXXX9999')$$, pg_temp.mid(1), pg_temp.lid(1), pg_temp.d() - 1, pg_temp.d() + 365)), '22023|dates_invalid', 'a start date in the past is refused');
select is(pg_temp.err(format($$select payments.request_mandate(%L, %L, 'enach_api', 4000000, %L, %L, 'XXXXXX9999')$$, pg_temp.mid(1), pg_temp.lid(1), pg_temp.d() + 10, pg_temp.d() + 5)), '22023|dates_invalid', 'an end date before the start is refused');
select is(pg_temp.err(format($$select payments.request_mandate(%L, %L, 'upi_autopay', 2000000, %L, %L, 'XXXXXX9999')$$, pg_temp.mid(1), pg_temp.lid(1), pg_temp.d() + 1, pg_temp.d() + 365)), '22023|amount_not_allowed', 'a maximum above the rail limit (15,000.00 for UPI AutoPay) is refused');
select is(pg_temp.err(format($$select payments.request_mandate(%L, %L, 'enach_api', 4500000, %L, %L, 'XXXXXX9999')$$, pg_temp.mid(1), pg_temp.lid(1), pg_temp.d() + 1, pg_temp.d() + 365)), '22023|amount_not_allowed', 'a maximum above the lender''s own ceiling (40,000.00) is refused although the rail allows more');
select is(pg_temp.err(format($$select payments.request_mandate(%L, %L, 'enach_api', 4000000, %L, %L, 'XXXXXX9999')$$, pg_temp.mid(1), pg_temp.lid(1), pg_temp.d() + 1, pg_temp.d() + 365)), '42501|stepup_required', 'without a verified step-up code bound to this mandate nothing is created');
select pg_temp.as_owner();
select pg_temp.stepup(pg_temp.got('b1'), pg_temp.mid(99));
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err(format($$select payments.request_mandate(%L, %L, 'enach_api', 4000000, %L, %L, 'XXXXXX9999')$$, pg_temp.mid(1), pg_temp.lid(1), pg_temp.d() + 1, pg_temp.d() + 365)), '42501|stepup_required',
  'a verified step-up code bound to ANOTHER mandate id does not count');
select pg_temp.as_owner();
select pg_temp.stepup(pg_temp.got('b1'), pg_temp.mid(1));
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err(format($$select payments.request_mandate(%L, %L, 'enach_api', 4000000, %L, %L, 'XXXXXX9999')$$, pg_temp.mid(1), pg_temp.lid(1), pg_temp.d() + 1, pg_temp.d() + 365)), 'ok',
  'with a step-up code bound to this mandate id the request is accepted');
select pg_temp.as_owner();
select is((select (status, rail, max_amount_minor, creditor_ref = 'SAMPLE-MERCHANT-' || left(md5(pg_temp.lx()::text), 12), masked_account_ref, needs_afa_each_debit, provider, lender_org_id = pg_temp.lx())::text
           from payments.mandates where id = pg_temp.mid(1)), '(draft,enach_api,4000000,t,XXXXXX9999,f,mock_gateway,t)',
  'a DRAFT is created: the lender is the creditor, the figures are the rail''s and the lender''s, the account is masked');
select pg_temp.as_owner();
select is((select count(*) from identity.stepup_challenges where context_ref = pg_temp.mid(1)::text and status = 'consumed'), 1::bigint, 'the step-up code was consumed (single use)');
select pg_temp.as_user(pg_temp.u(1));
select is(payments.request_mandate(pg_temp.mid(1), pg_temp.lid(1), 'enach_api', 4000000, pg_temp.d() + 1, pg_temp.d() + 365, 'XXXXXX9999'), pg_temp.mid(1), 'the same request again returns the same mandate and needs no new code');
select pg_temp.as_owner();
select is((select count(*) from ops.outbox_events where event_type = 'mandate.handoff' and dedupe_key = 'mandate.handoff:' || pg_temp.mid(1)::text and payload::text ~ '^\{"mandate_id": "[0-9a-f-]{36}"\}$'), 1::bigint,
  'the provider hand-off is queued once for the worker, naming the mandate by id and nothing else (a replay queues no second one)');
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err(format($$select payments.request_mandate(%L, %L, 'enach_api', 3000000, %L, %L, 'XXXXXX9999')$$, pg_temp.mid(1), pg_temp.lid(1), pg_temp.d() + 1, pg_temp.d() + 365)), '23505|idempotency_conflict', 'the same id with a different amount is a conflict');
select is(pg_temp.err(format($$select payments.request_mandate(%L, %L, 'enach_api', 4000000, %L, %L, 'XXXXXX1111')$$, pg_temp.mid(1), pg_temp.lid(1), pg_temp.d() + 1, pg_temp.d() + 365)), '23505|idempotency_conflict', 'and so is the same id with a different account');
select pg_temp.as_owner();
select is((select count(*) from payments.mandates), 1::bigint, 'and only one mandate exists');
select is(pg_temp.mhist(pg_temp.mid(1)), '->draft/request', 'its history starts with the request');
select pg_temp.stepup(pg_temp.got('b1'), pg_temp.mid(2));
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err(format($$select payments.request_mandate(%L, %L, 'enach_api', null, %L, %L, 'XXXXXX9999')$$, pg_temp.mid(2), pg_temp.lid(1), pg_temp.d() + 1, pg_temp.d() + 365)), '23505|mandate_exists', 'a loan has at most one mandate in progress');
select pg_temp.as_owner();
select pg_temp.integrity(pg_temp.got('b1'), 'strong');
select pg_temp.stepup(pg_temp.got('b1'), pg_temp.mid(3));
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err(format($$select payments.request_mandate(%L, %L, 'enach_api', 4000000, %L, %L, 'XXXXXX9999')$$, pg_temp.mid(3), pg_temp.lid(4), pg_temp.d() + 1, pg_temp.d() + 365)), '55000|provider_not_mandate_capable',
  'a lender whose provider offers payments but not mandates cannot have one');
select pg_temp.as_owner();
select pg_temp.stepup(pg_temp.got('b2'), pg_temp.mid(4));
select pg_temp.integrity(pg_temp.got('b2'), 'strong');
select pg_temp.as_user(pg_temp.u(2));
select is(pg_temp.err(format($$select payments.request_mandate(%L, %L, 'upi_autopay', 100, %L, %L, 'XXXXXX9999')$$, pg_temp.mid(4), pg_temp.lid(2), pg_temp.d() + 1, pg_temp.d() + 365)), 'ok', 'a second borrower asks for a UPI AutoPay mandate on their own loan');
select pg_temp.as_owner();
select is((select needs_afa_each_debit from payments.mandates where id = pg_temp.mid(4)), true, 'and the rail''s "needs authentication on every debit" flag is carried to the mandate, so the app can say so');
select pg_temp.as_owner();
select pg_temp.stepup(pg_temp.got('b1'), pg_temp.mid(12));
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err(format($$select payments.request_mandate(%L, %L, 'upi_autopay', 100000, %L, %L, 'XXXXXX9999')$$, pg_temp.mid(12), pg_temp.lid(5), pg_temp.d() + 1, pg_temp.d() + 365)), '55000|rail_not_configured',
  'a rail whose limits are incomplete in the lender''s configuration (no "needs authentication" flag) is not available: nothing is assumed');
select is(pg_temp.err(format($$select payments.request_mandate(%L, %L, 'enach_api', 100000, %L, %L, 'XXXXXX9999')$$, pg_temp.mid(12), pg_temp.lid(5), pg_temp.d() + 1, pg_temp.d() + 365)), 'ok',
  'while the fully configured rail of the same lender works (and the unspent code is used here)');
select pg_temp.as_owner();
set local session_replication_role = replica;
update payments.lender_payment_configs set status = 'suspended', status_reason = 'SAMPLE: test of a suspended configuration', status_changed_at = now() where lender_org_id = pg_temp.lx();
set local session_replication_role = origin;
select pg_temp.stepup(pg_temp.got('b1'), pg_temp.mid(5));
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err(format($$select payments.request_mandate(%L, %L, 'enach_api', null, %L, %L, 'XXXXXX9999')$$, pg_temp.mid(5), pg_temp.lid(3), pg_temp.d() + 1, pg_temp.d() + 365)), '55000|collection_target_invalid', 'with the lender''s configuration suspended no mandate can be created');
select pg_temp.as_owner();
set local session_replication_role = replica;
update payments.lender_payment_configs set status = 'active', status_reason = null, status_changed_at = now() where lender_org_id = pg_temp.lx();
set local session_replication_role = origin;
select pg_temp.as_system();

-- ============================================================================================================================
-- 4. The hand-off to the provider
-- ============================================================================================================================
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err(format($$select pg_temp.try_move(%L)$$, pg_temp.mid(1))), '42501|', 'even a function that runs with the owner''s rights cannot move a mandate when called as a borrower: the trigger checks who is asking');
select is(pg_temp.err(format($$select payments.record_mandate_handoff(%L, 'handoff', 'SAMPLE-PM-1')$$, pg_temp.mid(1))), '42501|', 'a borrower cannot record a hand-off (and so cannot register or activate a mandate)');
select pg_temp.as_user(pg_temp.u(3));
select is(pg_temp.err(format($$select payments.record_mandate_handoff(%L, 'handoff', 'SAMPLE-PM-1')$$, pg_temp.mid(1))), '42501|', 'nor a lender user');
select pg_temp.as_anon();
select is(pg_temp.err(format($$select payments.record_mandate_handoff(%L, 'handoff', 'SAMPLE-PM-1')$$, pg_temp.mid(1))), '42501|', 'nor anon');
select pg_temp.as_system();
select is(pg_temp.err(format($$select payments.record_mandate_handoff(%L, 'bogus')$$, pg_temp.mid(1))), '22023|bad_request', 'an unknown outcome is refused');
select is(pg_temp.err(format($$select payments.record_mandate_handoff(%L, 'handoff')$$, pg_temp.mid(1))), '22023|bad_request', 'a hand-off without the provider reference is refused');
select is(pg_temp.err(format($$select payments.record_mandate_handoff(%L, 'handoff', 'has spaces and ; ')$$, pg_temp.mid(1))), '22023|bad_request', 'and so is a malformed reference');
select is(pg_temp.err($$select payments.record_mandate_handoff(gen_random_uuid(), 'rejected')$$), 'P0002|', 'an unknown mandate answers not found');
select is(payments.record_mandate_handoff(pg_temp.mid(1), 'handoff', 'SAMPLE-PM-1', now() + interval '1 hour'), 'registration_pending', 'the provider took the request: registration pending (NOT active)');
select is(payments.record_mandate_handoff(pg_temp.mid(1), 'handoff', 'SAMPLE-PM-1'), 'registration_pending', 'a repeat answers the current status and changes nothing');
select is(payments.record_mandate_handoff(pg_temp.mid(4), 'unknown'), 'requires_reconciliation', 'an unknown outcome (timeout) is not a failure and not a success: requires reconciliation');
select pg_temp.as_owner();
select is(pg_temp.exc('mandate_unresolved'), 1::bigint, 'and the platform gets an exception to work');
select is(pg_temp.mhist(pg_temp.mid(1)), '->draft/request,draft>registration_pending/handoff', 'the history records who moved it: the hand-off');
select is(pg_temp.err(format($$update payments.mandates set status = 'draft' where id = %L$$, pg_temp.mid(1))), 'P0001|', 'a mandate cannot go back to a draft');
select is(pg_temp.err(format($$update payments.mandates set status = 'paused' where id = %L$$, pg_temp.mid(4))), 'P0001|', 'nor jump from "requires reconciliation" to anything the table does not list');
select is(pg_temp.err(format($$update payments.mandates set status = 'active' where id = %L$$, pg_temp.mid(4))), '23514|', 'and a mandate cannot be active without the provider''s own reference');
select is(pg_temp.err(format($$update payments.mandates set max_amount_minor = 1 where id = %L$$, pg_temp.mid(1))), 'P0001|', 'the limits of a mandate cannot change');
select is(pg_temp.err(format($$update payments.mandates set provider_mandate_ref = 'SAMPLE-OTHER' where id = %L$$, pg_temp.mid(1))), 'P0001|', 'nor its provider reference once set');
select is(pg_temp.err($$delete from payments.mandates$$), 'P0001|Record a compensating entry instead.', 'a mandate is never deleted');
select pg_temp.as_system();
select is(pg_temp.err(format($$update payments.mandates set status = 'active' where id = %L$$, pg_temp.mid(1))), '42501|', 'the system role cannot write a status either: only the definer functions can');
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err(format($$update payments.mandates set status = 'active' where id = %L$$, pg_temp.mid(1))), '42501|', 'and a borrower certainly cannot: "active" is never a client flag');

-- ============================================================================================================================
-- 5. Verified provider events move a mandate; stale and contradictory ones do not
-- ============================================================================================================================
select pg_temp.as_system();
select is(pg_temp.deliver(pg_temp.lx(), 'SAMPLE-D-001', 'SAMPLE-E-001', 'mandate', 'pending', 'SAMPLE-PM-NOPE', null, null, pg_temp.at(1)), 'ingest:unmatched', 'an event for a mandate nobody has is unmatched at the door and changes nothing');
select is(pg_temp.deliver(pg_temp.ly(), 'SAMPLE-D-002', 'SAMPLE-E-002', 'mandate', 'active', 'SAMPLE-PM-1', null, null, pg_temp.at(1), 'mock_gateway_pay'), 'ingest:unmatched',
  'lender Y''s callback cannot touch lender X''s mandate even with X''s mandate reference');
select is(pg_temp.deliver(pg_temp.lz(), 'SAMPLE-D-002B', 'SAMPLE-E-002B', 'mandate', 'active', 'SAMPLE-PM-1', null, null, pg_temp.at(1)), 'ingest:unmatched',
  'and so cannot a lender on the SAME provider: the reference is looked up within the callback''s own lender');
select is(pg_temp.mstatus(pg_temp.mid(1)), 'registration_pending', 'the mandate has not moved');
select is(pg_temp.deliver(pg_temp.lx(), 'SAMPLE-D-003', 'SAMPLE-E-003', 'mandate', 'pending', 'SAMPLE-PM-1', null, null, pg_temp.at(1)), 'ignored_stale', 'a "pending" event for a pending mandate changes nothing');
select is(pg_temp.deliver(pg_temp.lx(), 'SAMPLE-D-004', 'SAMPLE-E-004', 'mandate', 'active', 'SAMPLE-PM-1', null, null, pg_temp.at(2)), 'applied', 'a verified "active" event activates the mandate');
select is(pg_temp.mstatus(pg_temp.mid(1)), 'active', 'now it is active');
select is(pg_temp.deliver(pg_temp.lx(), 'SAMPLE-D-005', 'SAMPLE-E-005', 'mandate', 'rejected', 'SAMPLE-PM-1', null, null, pg_temp.at(1)), 'ignored_stale', 'an older "rejected" event arriving late is stale and ignored');
select is(pg_temp.deliver(pg_temp.lx(), 'SAMPLE-D-006', 'SAMPLE-E-006', 'mandate', 'rejected', 'SAMPLE-PM-1', null, null, pg_temp.at(3)), 'exception', 'a newer "rejected" for an active mandate contradicts it: an exception, not a change');
select is(pg_temp.mstatus(pg_temp.mid(1)), 'active', 'the mandate stays active');
select pg_temp.as_owner();
select is(pg_temp.exc('mandate_status_conflict'), 1::bigint, 'and the lender is told of the contradiction');
select pg_temp.as_system();
select is(pg_temp.deliver(pg_temp.lx(), 'SAMPLE-D-007', 'SAMPLE-E-007', 'mandate', 'paused', 'SAMPLE-PM-1', null, null, pg_temp.at(4)), 'applied', 'the provider pauses it');
select is(pg_temp.deliver(pg_temp.lx(), 'SAMPLE-D-008', 'SAMPLE-E-008', 'mandate', 'active', 'SAMPLE-PM-1', null, null, pg_temp.at(5)), 'applied', 'and resumes it');
select is(pg_temp.deliver(pg_temp.lx(), 'SAMPLE-D-009', 'SAMPLE-E-009', 'mandate', 'cancelled', 'SAMPLE-PM-1', null, null, pg_temp.at(6)), 'applied', 'the provider confirms the cancellation');
select is(pg_temp.deliver(pg_temp.lx(), 'SAMPLE-D-010', 'SAMPLE-E-010', 'mandate', 'active', 'SAMPLE-PM-1', null, null, pg_temp.at(7)), 'exception', 'nothing brings a cancelled mandate back');
select is(pg_temp.mstatus(pg_temp.mid(1)), 'cancelled', 'it stays cancelled');
select pg_temp.as_owner();
select is(pg_temp.mhist(pg_temp.mid(1)),
  '->draft/request,draft>registration_pending/handoff,registration_pending>active/provider_event,active>paused/provider_event,paused>active/provider_event,active>cancelled/provider_event',
  'the history shows every move with its source: each one a verified provider event');
select is((select count(*) from payments.mandate_events where mandate_id = pg_temp.mid(1) and source = 'provider_event' and provider_event_id is not null), 4::bigint, 'and each of those points at the verified event row');
select is(pg_temp.err($$update payments.mandate_events set to_status = 'active'$$), 'P0001|Record a compensating entry instead.', 'the history is append-only');
select is((select count(*) from payments.webhook_receipts where reason_class = 'mandate_unknown'), 3::bigint, 'all three unmatched deliveries left a receipt and nothing else');
select pg_temp.as_system();

-- ============================================================================================================================
-- 6. An authenticated status lookup has the standing of a verified event
-- ============================================================================================================================
select is(pg_temp.err(format($$select payments.apply_mandate_lookup(%L, 'bogus')$$, pg_temp.mid(4))), '22023|bad_request', 'an unknown lookup status is refused');
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err(format($$select payments.apply_mandate_lookup(%L, 'active', 'SAMPLE-PM-4')$$, pg_temp.mid(4))), '42501|', 'a borrower cannot present a "lookup": only the system can');
select pg_temp.as_system();
select is(payments.apply_mandate_lookup(pg_temp.mid(4), 'registration_pending', 'SAMPLE-PM-4'), 'applied', 'a lookup resolves the unknown outcome and supplies the provider reference');
select is(pg_temp.err(format($$select payments.apply_mandate_lookup(%L, 'active', 'SAMPLE-DIFFERENT')$$, pg_temp.mid(4))), '55000|provider_ref_mismatch', 'a lookup that names another provider reference is refused');
select is(payments.apply_mandate_lookup(pg_temp.mid(4), 'active', null, clock_timestamp() + interval '1 minute'), 'applied', 'and a later lookup activates it');
select is(payments.apply_mandate_lookup(pg_temp.mid(4), 'active', null, clock_timestamp() + interval '2 minutes'), 'ignored_stale', 'a repeated lookup changes nothing');
select is(payments.apply_mandate_lookup(pg_temp.mid(4), 'registration_pending', null, clock_timestamp() - interval '1 hour'), 'ignored_stale', 'an old lookup result is stale');
select pg_temp.as_owner();
select is(pg_temp.mhist(pg_temp.mid(4)), '->draft/request,draft>requires_reconciliation/handoff,requires_reconciliation>registration_pending/status_lookup,registration_pending>active/status_lookup',
  'the history records the lookups as such');
select pg_temp.as_system();

-- ============================================================================================================================
-- 7. A second mandate on the same loan once the first is finished; debits are planned from the lender's reported schedule
-- ============================================================================================================================
select pg_temp.as_owner();
select pg_temp.stepup(pg_temp.got('b1'), pg_temp.mid(6));
select pg_temp.stepup(pg_temp.got('b1'), pg_temp.mid(7));
select pg_temp.as_user(pg_temp.u(1));
select is(payments.request_mandate(pg_temp.mid(6), pg_temp.lid(1), 'enach_api', null, pg_temp.d() + 1, pg_temp.d() + 400, 'XXXXXX9999'), pg_temp.mid(6), 'once the first mandate is finished the loan can have another (no maximum given: the lower of the rail limit and the lender''s ceiling applies)');
select is(payments.request_mandate(pg_temp.mid(7), pg_temp.lid(3), 'enach_api', 3000000, pg_temp.d() + 1, pg_temp.d() + 400, 'XXXXXX9999'), pg_temp.mid(7), 'and a second loan gets its own');
select pg_temp.as_owner();
select is((select max_amount_minor from payments.mandates where id = pg_temp.mid(6)), 4000000::bigint, 'the default maximum is the lender''s ceiling (40,000.00), below the rail''s 50,000.00');
select pg_temp.as_system();
select payments.record_mandate_handoff(pg_temp.mid(6), 'handoff', 'SAMPLE-PM-6');
select payments.record_mandate_handoff(pg_temp.mid(7), 'handoff', 'SAMPLE-PM-7');
-- A debit arrives for a mandate still pending registration: it is recorded and shown to the lender, never dropped.
select is(pg_temp.deliver(pg_temp.lx(), 'SAMPLE-D-020', 'SAMPLE-E-020', 'debit', 'pending', 'SAMPLE-DB-EARLY', 'SAMPLE-PM-7', 475000, pg_temp.at(1)), 'applied', 'a debit event for a mandate that is not yet active is recorded');
select pg_temp.as_owner();
select is((select (planned, status, amount_minor)::text from payments.mandate_debits where provider_debit_ref = 'SAMPLE-DB-EARLY'), '(f,presented,475000)', 'as an unplanned debit');
select is(pg_temp.exc('mandate_debit_unresolved'), 1::bigint, 'and the lender gets an exception to look at');
select pg_temp.as_system();
select is(pg_temp.deliver(pg_temp.lx(), 'SAMPLE-D-021', 'SAMPLE-E-021', 'mandate', 'active', 'SAMPLE-PM-6', null, null, pg_temp.at(2)), 'applied', 'the provider activates mandate 6');
select is(pg_temp.deliver(pg_temp.lx(), 'SAMPLE-D-022', 'SAMPLE-E-022', 'mandate', 'active', 'SAMPLE-PM-7', null, null, pg_temp.at(2)), 'applied', 'and mandate 7');

select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err($$select payments.plan_mandate_debits()$$), '42501|', 'a borrower cannot run the debit planner');
select pg_temp.as_system();
select is(payments.plan_mandate_debits() - 'skipped_over_max', jsonb_build_object('planned', 2, 'notices_late', 0),
  'the planner plans the one installment that falls due within ten days on mandates 6 and 7 (mandate 4''s maximum is one rupee, so nothing is planned for it)');
select pg_temp.as_owner();
select is((select (amount_minor, scheduled_on = pg_temp.d() + 3, planned, installment_seq, status)::text from payments.mandate_debits where mandate_id = pg_temp.mid(6) and planned), '(475000,t,t,1,scheduled)',
  'the amount is the lender''s reported figure for it (4,750.00), due on its date');
select is((select (n.status, n.notice_due_at = (((pg_temp.d() + 3)::timestamp at time zone 'Asia/Kolkata') - interval '48 hours'), n.borrower_id = pg_temp.got('b1')::uuid)::text
           from payments.pre_debit_notices n join payments.mandate_debits d on d.id = n.debit_id where d.mandate_id = pg_temp.mid(6)), '(planned,t,t)',
  'its notice is due 48 hours (the lender''s setting) before the start of the debit day');
select pg_temp.as_system();
select is(payments.plan_mandate_debits() ->> 'planned', '0', 'a second run plans nothing');
select is(payments.plan_mandate_debits(interval '40 days') ->> 'planned', '2', 'a longer horizon adds the next installment of each mandate');
select pg_temp.as_owner();
select is((select amount_minor from payments.mandate_debits where mandate_id = pg_temp.mid(6) and installment_seq = 2), 475000::bigint, 'taken from the lender''s own schedule when the newest report does not name it');
select pg_temp.as_system();
select is(payments.plan_mandate_debits(interval '70 days') ->> 'planned', '0', 'the third installment (60,000.00) is above every maximum and is NOT planned');
select pg_temp.as_owner();
select is(pg_temp.exc('mandate_debit_exceeds_max'), 5::bigint, 'the lender is told, once per mandate and installment (mandate 4: three, mandates 6 and 7: one each)');
select is((select count(*) from payments.mandate_debits where mandate_id = pg_temp.mid(4)), 0::bigint, 'nothing at all is planned for the one-rupee mandate');
select is((select count(*) from payments.mandate_debits where amount_minor > (select max_amount_minor from payments.mandates m where m.id = mandate_id)), 0::bigint, 'no debit anywhere is above its mandate maximum');
select is(pg_temp.err($$update payments.mandate_debits set amount_minor = 1 where planned$$), 'P0001|', 'the planned amount of a debit cannot be changed');
select is(pg_temp.err($$insert into payments.mandate_debits (lender_org_id, mandate_id, loan_account_id, planned, scheduled_on, amount_minor)
  select lender_org_id, id, loan_account_id, true, current_date, 1000 from payments.mandates where id = pg_temp.mid(6)$$), '23514|', 'a planned debit without its schedule is refused by the database');
select pg_temp.as_system();

-- ============================================================================================================================
-- 8. The notice before each debit
-- ============================================================================================================================
select is((select count(*) from payments.claim_pre_debit_notices(10)), 0::bigint, 'no notice is claimed before it is due');
select pg_temp.as_owner();
update payments.pre_debit_notices set notice_due_at = clock_timestamp() - interval '1 minute' where id in (pg_temp.notice(pg_temp.mid(6), 1), pg_temp.notice(pg_temp.mid(7), 1));
select pg_temp.as_system();
select is((select count(*) from payments.claim_pre_debit_notices(10)), 2::bigint, 'two notices are due now and are claimed');
select is((select count(*) from payments.claim_pre_debit_notices(10)), 0::bigint, 'and are leased: not claimed again at once');
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err(format($$select payments.record_pre_debit_notice(%L, 'accepted')$$, pg_temp.notice(pg_temp.mid(6), 1))), '42501|', 'a borrower cannot record a notice');
select pg_temp.as_system();
select is(pg_temp.err(format($$select payments.record_pre_debit_notice(%L, 'sent')$$, pg_temp.notice(pg_temp.mid(6), 1))), '22023|bad_request', 'an unknown notice state is refused');
select is(payments.record_pre_debit_notice(pg_temp.notice(pg_temp.mid(6), 1), 'accepted'), 'accepted', 'the channel accepts the notice for mandate 6');
select is((select (n.status, n.delivery_state, n.sent_at is not null, d.status, d.rank)::text from payments.pre_debit_notices n join payments.mandate_debits d on d.id = n.debit_id where n.id = pg_temp.notice(pg_temp.mid(6), 1)),
  '(sent,accepted,t,notified,20)', 'the notice is sent and the debit is notified');
select is(payments.record_pre_debit_notice(pg_temp.notice(pg_temp.mid(6), 1), 'delivered'), 'delivered', 'a delivery report marks it delivered');
select is(pg_temp.err(format($$select payments.record_pre_debit_notice(%L, 'delivered')$$, pg_temp.notice(pg_temp.mid(7), 1))), '55000|not_sent', '"delivered" is never recorded for a notice that was not sent');
select is(payments.record_pre_debit_notice(pg_temp.notice(pg_temp.mid(7), 1), 'failed'), 'failed', 'a failed send is recorded');
select is((select count(*) from payments.claim_pre_debit_notices(10)), 1::bigint, 'and the notice is claimed again for a retry');
select is(payments.record_pre_debit_notice(pg_temp.notice(pg_temp.mid(7), 1), 'not_configured'), 'not_configured', 'with no channel at all the notice cannot go out');
select pg_temp.as_owner();
select is((select (status, sent_at is null)::text from payments.pre_debit_notices where id = pg_temp.notice(pg_temp.mid(7), 1)), '(late,t)', 'it is marked late (never "sent")');
select is(pg_temp.exc('mandate_notice_late'), 1::bigint, 'and the lender is told that a debit would come without its notice');
-- An installment that falls due too soon for the full lead time: its notice is late from the start.
insert into servicing.schedule_installments (snapshot_id, lender_org_id, seq, due_date, principal_minor, interest_minor)
select s.id, s.lender_org_id, 4, pg_temp.d() + 2, 300000, 50000 from servicing.schedule_snapshots s where s.loan_account_id = pg_temp.lid(3);
select pg_temp.as_system();
select is(payments.plan_mandate_debits() - 'skipped_over_max', jsonb_build_object('planned', 1, 'notices_late', 1), 'a debit planned inside its lead time gets a notice marked late at once');
select pg_temp.as_owner();
select is(pg_temp.exc('mandate_notice_late'), 2::bigint, 'with an exception of its own');
select is((select (status, notice_due_at < clock_timestamp())::text from payments.pre_debit_notices where id = pg_temp.notice(pg_temp.mid(7), 4)), '(late,t)', 'the late notice is due immediately');
select pg_temp.as_system();

-- ============================================================================================================================
-- 9. Debits reported by the provider
-- ============================================================================================================================
select is(pg_temp.deliver(pg_temp.lx(), 'SAMPLE-D-030', 'SAMPLE-E-030', 'debit', 'pending', 'SAMPLE-DB-1', 'SAMPLE-PM-6', 475000, pg_temp.atd(3)), 'applied', 'the provider reports a debit: it is matched to the planned debit (same mandate, amount and date)');
select pg_temp.as_owner();
select is((select (planned, status, installment_seq)::text from payments.mandate_debits where provider_debit_ref = 'SAMPLE-DB-1'), '(t,presented,1)', 'the planned debit now carries the provider''s reference and is presented');
select is((select count(*) from payments.mandate_debits where mandate_id = pg_temp.mid(6)), 2::bigint, 'and no second row was created');
select pg_temp.as_system();
select is(pg_temp.deliver(pg_temp.lx(), 'SAMPLE-D-031', 'SAMPLE-E-031', 'debit', 'succeeded', 'SAMPLE-DB-1', 'SAMPLE-PM-6', 475000, pg_temp.atd(3)), 'applied', 'the debit is settled by a verified event');
select is(pg_temp.deliver(pg_temp.lx(), 'SAMPLE-D-032', 'SAMPLE-E-032', 'debit', 'pending', 'SAMPLE-DB-1', 'SAMPLE-PM-6', 475000, pg_temp.atd(3)), 'ignored_stale', 'a late "pending" never moves a settled debit back');
select is(pg_temp.deliver(pg_temp.lx(), 'SAMPLE-D-033', 'SAMPLE-E-033', 'debit', 'returned', 'SAMPLE-DB-1', 'SAMPLE-PM-6', 475000, pg_temp.atd(3)), 'exception', '"returned" after "settled" contradicts it: an exception and no change');
select pg_temp.as_owner();
select is((select status from payments.mandate_debits where provider_debit_ref = 'SAMPLE-DB-1'), 'settled', 'the debit stays settled');
select is(pg_temp.exc('mandate_debit_unresolved'), 2::bigint, 'and the lender has the contradiction to look at');
select pg_temp.as_system();
select pg_temp.deliver(pg_temp.lx(), 'SAMPLE-D-034', 'SAMPLE-E-034', 'debit', 'pending', 'SAMPLE-DB-2', 'SAMPLE-PM-6', 475000, pg_temp.atd(33));
select is(pg_temp.deliver(pg_temp.lx(), 'SAMPLE-D-035', 'SAMPLE-E-035', 'debit', 'returned', 'SAMPLE-DB-2', 'SAMPLE-PM-6', 475000, pg_temp.atd(33)), 'applied', 'a debit is returned');
select pg_temp.as_owner();
select is((select (status, return_code is null, return_class is null)::text from payments.mandate_debits where provider_debit_ref = 'SAMPLE-DB-2'), '(returned,t,t)', 'the event carries no return code, so none is recorded');
select pg_temp.as_system();
select is(pg_temp.err(format($$select payments.apply_debit_lookup(%L, 'SAMPLE-DB-2', %L, 475000, 'settled', 'SAMPLE-R01')$$, pg_temp.mid(6), pg_temp.d() + 33)), '22023|bad_request', 'a return code on a debit that was not returned is refused');
select is(payments.apply_debit_lookup(pg_temp.mid(6), 'SAMPLE-DB-2', pg_temp.d() + 33, 475000, 'returned', 'SAMPLE-R01'), 'applied', 'an authenticated debit report supplies the provider''s return code');
select pg_temp.as_owner();
select is((select (return_code, return_class is null)::text from payments.mandate_debits where provider_debit_ref = 'SAMPLE-DB-2'), '(SAMPLE-R01,t)', 'stored verbatim and unclassified: no code list is hard-coded and none is configured');
select is(pg_temp.err($$update payments.mandate_debits set return_code = 'SAMPLE-OTHER' where provider_debit_ref = 'SAMPLE-DB-2'$$), 'P0001|', 'the return code is set once');
select pg_temp.as_user(pg_temp.u(3));
select is(pg_temp.err($$select payments.set_return_code_class('mock_gateway', 'SAMPLE-R02', 'insufficient_funds', 'SAMPLE-DOC-9')$$), '42501|', 'a lender cannot classify return codes: that is the platform''s configuration');
select pg_temp.as_user(pg_temp.u(6));
select is(pg_temp.err($$select payments.set_return_code_class('mock_gateway', 'SAMPLE-R02', 'free_money', 'SAMPLE-DOC-9')$$), '22023|return_code_invalid', 'a class outside the closed list is refused');
select is(payments.set_return_code_class('mock_gateway', 'SAMPLE-R02', 'insufficient_funds', 'SAMPLE-DOC-9'), 'set', 'a platform user classifies a code, with its evidence');
select pg_temp.as_system();
select is(payments.apply_debit_lookup(pg_temp.mid(6), 'SAMPLE-DB-3', pg_temp.d() + 40, 123000, 'returned', 'SAMPLE-R02'), 'applied', 'a returned debit the provider reports and we did not plan is recorded');
select pg_temp.as_owner();
select is((select (planned, status, return_code, return_class)::text from payments.mandate_debits where provider_debit_ref = 'SAMPLE-DB-3'), '(f,returned,SAMPLE-R02,insufficient_funds)', 'as an UNPLANNED debit with the configured class');
select is(pg_temp.exc('mandate_debit_unresolved'), 3::bigint, 'and flagged to the lender');
select pg_temp.as_system();
select is(payments.apply_debit_lookup(pg_temp.mid(6), 'SAMPLE-DB-3', pg_temp.d() + 40, 123000, 'returned', 'SAMPLE-R02'), 'ignored_stale', 'the same report again changes nothing');
select is(pg_temp.deliver(pg_temp.lx(), 'SAMPLE-D-036', 'SAMPLE-E-036', 'debit', 'pending', 'SAMPLE-DB-4', 'SAMPLE-PM-6', 4000001, pg_temp.atd(10)), 'applied', 'a debit above the mandate maximum is recorded');
select pg_temp.as_owner();
select is((select (planned, exceeds_mandate_max)::text from payments.mandate_debits where provider_debit_ref = 'SAMPLE-DB-4'), '(f,t)', 'flagged as exceeding the maximum');
select is((select count(*) from payments.reconciliation_exceptions where class = 'amount_mismatch' and severity = 'critical' and status <> 'resolved'), 1::bigint, 'with a critical exception');
select pg_temp.as_system();
select is(pg_temp.deliver(pg_temp.lx(), 'SAMPLE-D-037', 'SAMPLE-E-037', 'debit', 'pending', 'SAMPLE-DB-9', 'SAMPLE-PM-NOPE', 475000, pg_temp.atd(3)), 'ingest:unmatched', 'a debit for a mandate nobody has is refused at the door');
select is(pg_temp.deliver(pg_temp.lx(), 'SAMPLE-D-038', 'SAMPLE-E-038', 'debit', 'pending', 'SAMPLE-DB-5', 'SAMPLE-PM-7', 475001, pg_temp.atd(33)), 'applied', 'a debit whose amount differs by one paisa from the only planned one near its date');
select pg_temp.as_owner();
select is((select (planned, status)::text from payments.mandate_debits where provider_debit_ref = 'SAMPLE-DB-5'), '(f,presented)', 'is NOT attached to the plan: it is recorded as unplanned (matching is exact, never fuzzy)');
select is((select provider_debit_ref is null from payments.mandate_debits where id = pg_temp.debit(pg_temp.mid(7), 2)), true, 'and the planned debit is untouched');
select is((select count(*) from payments.payment_intents) + (select count(*) from payments.payment_adjustments) + (select count(*) from payments.provider_payments), 0::bigint,
  'no returned or unplanned debit created a payment, an adjustment or a charge anywhere');
select pg_temp.as_system();

-- ============================================================================================================================
-- 10. Cancellation is a request until the provider confirms it
-- ============================================================================================================================
select pg_temp.as_user(pg_temp.u(2));
select is(pg_temp.err(format($$select payments.request_mandate_cancellation(%L)$$, pg_temp.mid(6))), 'P0002|', 'another borrower cannot cancel this mandate (it looks unknown to them)');
select pg_temp.as_anon();
select is(pg_temp.err(format($$select payments.request_mandate_cancellation(%L)$$, pg_temp.mid(6))), '42501|', 'nor anon');
select pg_temp.as_user(pg_temp.u(3));
select is(pg_temp.err(format($$select payments.request_mandate_cancellation(%L)$$, pg_temp.mid(6))), '42501|', 'nor a lender user (it is the borrower''s mandate)');
select pg_temp.as_user(pg_temp.u(1));
select is(payments.request_mandate_cancellation(pg_temp.mid(6)), 'cancel_requested', 'the borrower asks to cancel their mandate');
select is(payments.request_mandate_cancellation(pg_temp.mid(6)), 'cancel_requested', 'asking twice is harmless');
select is((select (status, cancel_requested)::text from payments.my_mandates() where mandate_id = pg_temp.mid(6)), '(active,t)', 'the mandate is STILL active: a request is not a cancellation');
select pg_temp.as_owner();
select is((select count(*) from ops.outbox_events where event_type = 'mandate.cancel' and dedupe_key = 'mandate.cancel:' || pg_temp.mid(6)::text), 1::bigint, 'one request was queued for the provider (ids only)');
select is((select cancel_reason from payments.mandates where id = pg_temp.mid(6)), 'borrower', 'the reason is recorded');
select is(pg_temp.err(format($$update payments.mandates set cancel_reason = 'loan_closed' where id = %L$$, pg_temp.mid(6))), 'P0001|', 'and cannot be rewritten');
select pg_temp.as_system();
select is(payments.mark_mandate_cancel_sent(pg_temp.mid(6)), 'ok', 'the worker records that the request reached the provider');
select is((payments.sweep_mandates(interval '1 hour', interval '0 seconds', interval '1 hour') ->> 'cancel_unconfirmed')::integer >= 1, true, 'a cancellation the provider has not confirmed is reported by the sweep');
select pg_temp.as_owner();
select is(pg_temp.exc('mandate_cancel_unconfirmed'), 1::bigint, 'as an exception for the lender');
select is((select status from payments.mandates where id = pg_temp.mid(6)), 'active', 'and the mandate is still active');
select pg_temp.as_system();
select is(pg_temp.deliver(pg_temp.lx(), 'SAMPLE-D-040', 'SAMPLE-E-040', 'mandate', 'cancelled', 'SAMPLE-PM-6', null, null, pg_temp.at(30)), 'applied', 'the provider confirms the cancellation');
select pg_temp.as_user(pg_temp.u(1));
select is((select (status, cancel_requested)::text from payments.my_mandates() where mandate_id = pg_temp.mid(6)), '(cancelled,t)', 'now it is cancelled');
select is(pg_temp.err(format($$select payments.request_mandate_cancellation(%L)$$, pg_temp.mid(6))), '55000|mandate_finished', 'a finished mandate cannot be cancelled again');

-- Closure of a loan cancels its mandate (by request, confirmed by the provider).
select pg_temp.as_owner();
update servicing.loan_accounts set status = 'closed' where id = pg_temp.lid(3);
select pg_temp.as_system();
select is(payments.request_cancel_for_closed_loans(), 1, 'the closure job requests the cancellation of the closed loan''s mandate');
select is(payments.request_cancel_for_closed_loans(), 0, 'once');
select pg_temp.as_owner();
select is((select (status, cancel_reason)::text from payments.mandates where id = pg_temp.mid(7)), '(active,loan_closed)', 'still active until the provider confirms');
select is((select count(*) from ops.outbox_events where event_type = 'mandate.cancel' and dedupe_key = 'mandate.cancel:' || pg_temp.mid(7)::text), 1::bigint, 'and queued');
select pg_temp.as_system();
select is(pg_temp.deliver(pg_temp.lx(), 'SAMPLE-D-041', 'SAMPLE-E-041', 'mandate', 'cancelled', 'SAMPLE-PM-7', null, null, pg_temp.at(31)), 'applied', 'the provider confirms');

-- Drafts the provider never saw, and mandates past their end date.
select pg_temp.as_owner();
select pg_temp.stepup(pg_temp.got('b1'), pg_temp.mid(8));
select pg_temp.as_user(pg_temp.u(1));
select payments.request_mandate(pg_temp.mid(8), pg_temp.lid(1), 'enach_api', 1000000, pg_temp.d() + 1, pg_temp.d() + 100, 'XXXXXX9999');
select is(payments.request_mandate_cancellation(pg_temp.mid(8)), 'cancel_requested', 'a borrower abandons a draft');
select pg_temp.as_system();
select is((payments.sweep_mandates() ->> 'drafts_closed')::integer, 1, 'the sweep closes it (it was never registered anywhere)');
select pg_temp.as_owner();
select is(pg_temp.mhist(pg_temp.mid(8)), '->draft/request,draft>cancelled/system', 'with the system as the source');
set local session_replication_role = replica;
insert into payments.mandates (id, lender_org_id, config_id, borrower_id, loan_account_id, rail, status, provider, provider_mode, creditor_ref, provider_mandate_ref, max_amount_minor,
                               start_date, end_date, masked_account_ref, needs_afa_each_debit, created_by)
select pg_temp.mid(10), pg_temp.ly(), c.id, pg_temp.got('b1')::uuid, pg_temp.lid(4), 'enach_api', 'active', c.provider, 'mock', 'SAMPLE-CREDITOR', 'SAMPLE-PM-Y', 100000,
       current_date - 400, current_date - 1, 'XXXXXX1234', false, pg_temp.u(1)
from payments.lender_payment_configs c where c.lender_org_id = pg_temp.ly();
set local session_replication_role = origin;
select pg_temp.as_system();
select is((payments.sweep_mandates() ->> 'expired')::integer, 1, 'a mandate past its end date is expired by the sweep');
select is(pg_temp.mstatus(pg_temp.mid(10)), 'expired', 'and is expired');
select pg_temp.as_owner();
select is(pg_temp.mhist(pg_temp.mid(10)), 'active>expired/system', 'with the system as the source');
select pg_temp.stepup(pg_temp.got('b1'), pg_temp.mid(9));
select pg_temp.as_user(pg_temp.u(1));
select payments.request_mandate(pg_temp.mid(9), pg_temp.lid(1), 'enach_api', 1000000, pg_temp.d() + 1, pg_temp.d() + 100, 'XXXXXX9999');
select pg_temp.as_system();
select is(payments.record_mandate_handoff(pg_temp.mid(9), 'unknown'), 'requires_reconciliation', 'another hand-off whose outcome is unknown');
select is((select count(*) from payments.mandates_needing_lookup(interval '0 seconds') where mandate_id = pg_temp.mid(9) and reason = 'unknown_outcome'), 1::bigint, 'is listed for a status lookup');
select pg_temp.as_user(pg_temp.u(3));
select is(pg_temp.err($$select * from payments.mandates_needing_lookup()$$), '42501|', 'the list is for the system only');
select pg_temp.as_system();
select is(payments.sweep_mandates(interval '1 hour', interval '1 hour', interval '0 seconds') ->> 'unresolved', '1', 'and an outcome nobody established is reported by the sweep (mandate 4 was resolved by its lookup, so only this one remains)');

-- ============================================================================================================================
-- 11. Activation prerequisites
-- ============================================================================================================================
select pg_temp.as_owner();
select is(private.feature_prerequisites_unmet(pg_temp.ly(), 'mandates'),
  array['evidence_missing', 'mandate_policy_missing', 'mandate_rail_not_configured', 'payment_config_missing', 'payment_config_mock_or_sandbox_only', 'provider_not_mandate_capable'],
  'a lender with a payment-only mock provider, no rail limits and no settings cannot turn mandates on');
select is(private.feature_prerequisites_unmet(pg_temp.lx(), 'mandates'),
  array['evidence_missing', 'mandate_rail_not_configured', 'payment_config_missing', 'payment_config_mock_or_sandbox_only', 'provider_not_mandate_capable'],
  'a MOCK configuration can never satisfy the mandates gate, however complete it is');
set local session_replication_role = replica;
update payments.lender_payment_configs set provider_mode = 'production' where lender_org_id = pg_temp.lx();
set local session_replication_role = origin;
select is(private.feature_prerequisites_unmet(pg_temp.lx(), 'mandates'), array['evidence_missing'], 'the same configuration in production mode, with rails, settings and servicing_sync, lacks only evidence');
select is(private.feature_prerequisites_unmet(pg_temp.lx(), 'payments') <@ array['evidence_missing'], true, 'and the payments gate is unchanged');

-- ============================================================================================================================
-- 12. Who sees what
-- ============================================================================================================================
select pg_temp.as_user(pg_temp.u(4));
select is((select count(*) > 0 from payments.mandates), true, 'a lender user with payment.read sees the lender''s mandates');
select is((select count(*) > 0 from payments.mandate_debits), true, 'debits');
select is((select count(*) > 0 from payments.mandate_events), true, 'history');
select is((select count(*) > 0 from payments.pre_debit_notices), true, 'notices');
select is((select count(*) > 0 from payments.mandate_return_codes), true, 'and the return-code classes');
select is((select count(*) from payments.mandates where lender_org_id = pg_temp.ly()), 0::bigint, 'but none of lender Y''s');
select is((select count(*) from payments.my_mandates()), 0::bigint, 'a lender user is not a borrower: no mandates of their own');
select pg_temp.as_user(pg_temp.u(5));
select is((select count(*) from payments.mandates where lender_org_id = pg_temp.lx()), 0::bigint, 'lender Y''s user sees none of lender X''s mandates');
select is((select count(*) from payments.mandate_debits), 0::bigint, 'nor its debits');
select is((select count(*) from payments.pre_debit_notices), 0::bigint, 'nor its notices');
select pg_temp.as_user(pg_temp.u(1));
select is((select count(*) from payments.mandates), 0::bigint, 'a borrower reads no mandate table directly');
select is((select count(*) from payments.mandate_debits), 0::bigint, 'not the debits either');
select is((select count(*) from payments.my_mandates()), 7::bigint, 'but sees their own mandates through the function');
select is((select string_agg(status, ',' order by status) from payments.my_mandates()), 'cancelled,cancelled,cancelled,cancelled,draft,expired,requires_reconciliation', 'each with its provider-confirmed status (four cancelled, one expired, one still unresolved, and the newest still only a draft)');
select pg_temp.as_user(pg_temp.u(2));
select is((select count(*) from payments.my_mandates()), 1::bigint, 'the other borrower sees exactly their own');
select is((select (status, max_amount_minor, masked_account_ref, needs_afa_each_debit)::text from payments.my_mandates()), '(active,100,XXXXXX9999,t)', 'with only the masked account');
select pg_temp.as_anon();
select is(pg_temp.err($$select count(*) from payments.mandates$$), '42501|', 'anon reads nothing');
select is(pg_temp.err($$select * from payments.my_mandates()$$), '42501|', 'nor calls the borrower function');

-- ============================================================================================================================
-- 13. Audit and privacy
-- ============================================================================================================================
select pg_temp.as_owner();
select is((select count(*) > 0 from audit.events where action like 'payments.mandate%'), true, 'mandate requests, cancellations and settings are audited');
select is((select count(*) from audit.events where action like 'payments.mandate%' and (metadata::text ~ 'XXXXXX' or metadata::text ~ 'SAMPLE-PM' or metadata::text ~ 'SAMPLE-MERCHANT')), 0::bigint, 'and no audit event carries an account reference, a provider reference or the creditor reference');
select is((select count(*) from payments.reconciliation_exceptions where subject::text ~ '[A-Za-z]{4,}' and not (subject::text ~ '^\{("[a-z_]+": "[0-9a-f-]+"(, )?)+\}$')), 0::bigint, 'exception subjects hold ids only');
select is((select count(*) from ops.outbox_events where event_type = 'mandate.cancel' and payload::text !~ '^\{"mandate_id": "[0-9a-f-]{36}"\}$'), 0::bigint, 'the queued cancellation names the mandate by id and nothing else');

select * from finish();
rollback;
