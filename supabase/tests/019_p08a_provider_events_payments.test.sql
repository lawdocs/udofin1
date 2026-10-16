-- Phase 08a provider callbacks, verified events, payments, adjustments, the exception queue and the borrower payment request
-- (migration 20261018000913). Forged, tampered, stale, unmatched and replayed deliveries leave a receipt and nothing else; a verified
-- delivery is applied exactly once; money is only ever moved by the existing guard; exceptions are annotations. Synthetic data only
-- (labelled SAMPLE). Error codes are reported as SQLSTATE|hint.
begin;
create extension if not exists pgtap with schema extensions;
select plan(321);

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
create function pg_temp.u(n integer) returns uuid language sql as $fn$ select ('f9000000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid $fn$;
create function pg_temp.sha(k text) returns text language sql as $fn$ select encode(sha256(convert_to('SAMPLE-019-' || k, 'UTF8')), 'hex') $fn$;
-- The routing token hash the sample configuration of a lender carries (see sample_collection_config).
create function pg_temp.tok(p_lender uuid) returns text language sql as $fn$ select encode(sha256(convert_to('SAMPLE-TOKEN-' || p_lender::text, 'UTF8')), 'hex') $fn$;
create function pg_temp.lx() returns uuid language sql as $fn$ select 'f9b00000-0000-4000-8000-000000000001'::uuid $fn$;
create function pg_temp.ly() returns uuid language sql as $fn$ select 'f9b00000-0000-4000-8000-000000000002'::uuid $fn$;

-- A SAMPLE payment configuration (see 002_tenant_isolation): synthetic provider, merchant, verified registry entry, settlement account
-- and an active mock-mode configuration. Call as the owner.
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

-- A delivery as the callback receiver hands it over. p_outcome is the verifier's outcome; the event is attached only for 'verified'.
create function pg_temp.dlv(
  p_outcome text, p_delivery text, p_event text, p_kind text, p_status text, p_order text, p_amount bigint,
  p_obj text default 'pay_1', p_merchant text default null, p_rank integer default null, p_reason text default 'none', p_sha text default null,
  p_currency text default 'INR', p_provider text default 'mock_gateway'
) returns jsonb language sql as $fn$
  select jsonb_strip_nulls(jsonb_build_object(
    'provider', p_provider, 'outcome', p_outcome, 'reason_class', p_reason, 'delivery_id', p_delivery,
    'payload_sha256', coalesce(p_sha, pg_temp.sha('body-' || p_delivery)), 'scheme', 'mock-standard-webhooks-v1', 'signature_present', true,
    'timestamp_skew_seconds', 3, 'body_bytes', 420, 'ip_hmac', repeat('a', 64),
    'event', case when p_outcome = 'verified' then jsonb_build_object(
      'provider', p_provider, 'deliveryId', p_delivery, 'eventId', p_event, 'objectKind', p_kind, 'objectRef', p_obj, 'orderRef', p_order, 'status', p_status,
      'rank', coalesce(p_rank, case p_status when 'created' then 10 when 'pending' then 15 when 'authorized' then 20 when 'failed' then 25 when 'captured' then 30
                                       when 'paid' then 30 when 'succeeded' then 30 when 'refunded' then 40 when 'disputed' then 50 when 'cancelled' then 45 else 0 end),
      'amountMinor', p_amount::text, 'currency', case when p_amount is null then null else p_currency end,
      'occurredAt', '2026-10-15T10:00:00Z', 'merchantRef', p_merchant) end));
$fn$;
create function pg_temp.ing(p_token text, p_d jsonb) returns jsonb language sql as $fn$ select payments.ingest_provider_delivery(p_token, p_d) $fn$;
create function pg_temp.out(p_token text, p_d jsonb) returns text language sql as $fn$ select (payments.ingest_provider_delivery(p_token, p_d) ->> 'outcome') $fn$;
create function pg_temp.rc(p_delivery text) returns text language sql as $fn$
  select string_agg(outcome || ':' || reason_class, ',' order by received_at, id) from payments.webhook_receipts where delivery_id = p_delivery
$fn$;
create function pg_temp.ev(p_event text) returns uuid language sql as $fn$ select id from payments.provider_events where provider_event_id = p_event $fn$;
create function pg_temp.cnt(t text) returns bigint language plpgsql as $fn$ declare n bigint; begin execute 'select count(*) from ' || t into n; return n; end $fn$;
-- A fingerprint of everything the payment truth is made of, except the event store and the exception tables: used to prove that an exception resolution or an ignored event changes nothing.
create function pg_temp.truth() returns text language sql as $fn$
  select md5(coalesce((select string_agg(to_jsonb(i)::text, '|' order by i.id) from payments.payment_intents i), '') || '#' ||
             coalesce((select string_agg(to_jsonb(p)::text, '|' order by p.id) from payments.provider_payments p), '') || '#' ||
             coalesce((select string_agg(to_jsonb(a)::text, '|' order by a.id) from payments.payment_adjustments a), '') || '#' ||
             coalesce((select string_agg(to_jsonb(c)::text, '|' order by c.id) from payments.lender_payment_configs c), '') || '#' ||
             coalesce((select string_agg(to_jsonb(l)::text, '|' order by l.id) from servicing.loan_accounts l), ''))
$fn$;
grant execute on all functions in schema pg_temp to public;

-- Fixture -----------------------------------------------------------------------------------------------------------------------
-- Users: 01 borrower b1 (loan LX), 02 borrower b2, 03 lender X reconciler (payment.read, payment.reconcile), 04 lender X viewer (payment.read),
-- 05 lender X payments admin (payment.configure), 06 lender Y reconciler, 07 platform payments admin (providers.manage), 08 platform user without a role,
-- 09 lender admin and 10 product approver in both lenders (only so that the loan product fixture passes its maker-checker triggers).
insert into auth.users (id, phone, raw_app_meta_data)
select pg_temp.u(n), case when n in (1, 2) then '9100000009' || n end, case when n in (1, 2) then '{}'::jsonb else '{"actor_type":"staff"}'::jsonb end from generate_series(1, 10) n;
select pg_temp.keep('b1', (select id::text from identity.borrowers where user_id = pg_temp.u(1)));
select pg_temp.keep('b2', (select id::text from identity.borrowers where user_id = pg_temp.u(2)));

select pg_temp.as_owner();
select set_config('udofin.allow_mock_providers', 'on', true);
insert into tenancy.organizations (id, kind, legal_name, display_name, regulator_registration_no, status) values
  ('f9a00000-0000-4000-8000-000000000000', 'platform', 'Udofin Platform (test)', 'Udofin', null, 'active'),
  (pg_temp.lx(), 'lender', 'Alpha Finance Ltd (test)', 'Alpha', 'TEST-F9-0001', 'active'),
  (pg_temp.ly(), 'lender', 'Beta Capital Ltd (test)', 'Beta', 'TEST-F9-0002', 'active');
insert into tenancy.memberships (id, org_id, user_id, status) values
  ('f9c10000-0000-4000-8000-000000000003', pg_temp.lx(), pg_temp.u(3), 'active'),
  ('f9c10000-0000-4000-8000-000000000004', pg_temp.lx(), pg_temp.u(4), 'active'),
  ('f9c10000-0000-4000-8000-000000000005', pg_temp.lx(), pg_temp.u(5), 'active'),
  ('f9c10000-0000-4000-8000-000000000006', pg_temp.ly(), pg_temp.u(6), 'active'),
  ('f9c10000-0000-4000-8000-000000000007', 'f9a00000-0000-4000-8000-000000000000', pg_temp.u(7), 'active'),
  ('f9c10000-0000-4000-8000-000000000008', 'f9a00000-0000-4000-8000-000000000000', pg_temp.u(8), 'active'),
  ('f9c10000-0000-4000-8000-000000000019', pg_temp.lx(), pg_temp.u(9), 'active'),
  ('f9c10000-0000-4000-8000-000000000020', pg_temp.lx(), pg_temp.u(10), 'active'),
  ('f9c10000-0000-4000-8000-000000000021', pg_temp.ly(), pg_temp.u(9), 'active'),
  ('f9c10000-0000-4000-8000-000000000022', pg_temp.ly(), pg_temp.u(10), 'active');
insert into tenancy.membership_roles (membership_id, role_id)
select g.mid::uuid, r.id from (values
  ('f9c10000-0000-4000-8000-000000000003', 'lender', 'reconciler'), ('f9c10000-0000-4000-8000-000000000004', 'lender', 'viewer'),
  ('f9c10000-0000-4000-8000-000000000005', 'lender', 'payments_admin'), ('f9c10000-0000-4000-8000-000000000006', 'lender', 'reconciler'),
  ('f9c10000-0000-4000-8000-000000000007', 'platform', 'platform_payments_admin'),
  ('f9c10000-0000-4000-8000-000000000019', 'lender', 'lender_admin'), ('f9c10000-0000-4000-8000-000000000020', 'lender', 'product_approver'),
  ('f9c10000-0000-4000-8000-000000000021', 'lender', 'lender_admin'), ('f9c10000-0000-4000-8000-000000000022', 'lender', 'product_approver')) as g (mid, kind, rkey)
join tenancy.roles r on r.org_id is null and r.applies_to = g.kind::tenancy.organization_kind and r.key = g.rkey;
select pg_temp.sample_collection_config(pg_temp.lx(), 'f9e10000-0000-4000-8000-000000000001', 'Alpha collections (test)', 'XXXXXX1111');
select pg_temp.sample_collection_config(pg_temp.ly(), 'f9e10000-0000-4000-8000-000000000002', 'Beta collections (test)', 'XXXXXX2222');
select pg_temp.keep('cx', (select id::text from payments.lender_payment_configs where lender_org_id = pg_temp.lx()));
select pg_temp.keep('cy', (select id::text from payments.lender_payment_configs where lender_org_id = pg_temp.ly()));
select pg_temp.keep('tx', pg_temp.tok(pg_temp.lx()));
select pg_temp.keep('ty', pg_temp.tok(pg_temp.ly()));
select pg_temp.keep('mx', 'SAMPLE-MERCHANT-' || left(md5(pg_temp.lx()::text), 12));

-- Switches (an applied request and the switch, as 018 does) for lender X: payments, servicing_sync, statements_noc. Lender Y has payments and servicing_sync.
insert into servicing.feature_change_requests (lender_org_id, feature, enable, mode, status, evidence, requested_by, idempotency_key, decided_by, decided_at, applied_at)
select o.lender, f.feature, true, 'two_person', 'applied', '{"contract_ref":"SAMPLE-F9"}', pg_temp.u(7), 'f9-req-' || f.feature || '-' || right(o.lender::text, 1) || '-0001', pg_temp.u(8), now(), now()
from (values (pg_temp.lx()), (pg_temp.ly())) o (lender)
cross join (values ('payments'), ('servicing_sync'), ('statements_noc')) f (feature)
where not (o.lender = pg_temp.ly() and f.feature not in ('payments', 'servicing_sync'));
insert into servicing.lender_features (lender_org_id, feature, enabled, evidence, enabled_by, enabled_at, last_change_request_id)
select r.lender_org_id, r.feature, true, r.evidence, pg_temp.u(8), now(), r.id from servicing.feature_change_requests r;

-- Loans: LX1 (borrower b1, active), LX2 (borrower b2, active), LY1 (borrower b1, lender Y).
insert into lending.loan_products (id, lender_org_id, category_key, code, name, status) values
  ('f9900000-0000-4000-8000-000000000001', pg_temp.lx(), 'personal', 'PL-F9', 'X Personal Loan', 'active'),
  ('f9900000-0000-4000-8000-000000000002', pg_temp.ly(), 'personal', 'PL-F9', 'Y Personal Loan', 'active');
insert into lending.loan_product_versions (id, product_id, lender_org_id, version, status, min_amount_minor, max_amount_minor, min_tenure_days, max_tenure_days,
  rate_type, min_annual_rate_bps, max_annual_rate_bps, drafted_by, approved_by, approved_at, effective_from)
select ('f9910000-0000-4000-8000-00000000000' || n)::uuid, ('f9900000-0000-4000-8000-00000000000' || n)::uuid, ('f9b00000-0000-4000-8000-00000000000' || n)::uuid, 1, 'approved',
       1000000, 50000000, 180, 1825, 'fixed', 1400, 2400, pg_temp.u(9), pg_temp.u(10), now(), now()
from generate_series(1, 2) n;
insert into lending.loan_requests (id, borrower_id, category_key, requested_amount_minor, requested_tenure_days, purpose_code, status)
select ('f9700000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, case when n = 2 then pg_temp.got('b2')::uuid else pg_temp.got('b1')::uuid end, 'personal', 5000000, 365, 'education', 'submitted'
from generate_series(1, 3) n;
insert into lending.applications (id, lender_org_id, loan_request_id, borrower_id, product_version_id, status, requested_amount_minor, requested_tenure_days, lender_reference)
select ('f9200000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, case when n = 3 then pg_temp.ly() else pg_temp.lx() end,
       ('f9700000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, case when n = 2 then pg_temp.got('b2')::uuid else pg_temp.got('b1')::uuid end,
       case when n = 3 then 'f9910000-0000-4000-8000-000000000002' else 'f9910000-0000-4000-8000-000000000001' end::uuid, 'disbursed', 5000000, 365, 'SAMPLE-APP-' || n
from generate_series(1, 3) n;
insert into servicing.loan_accounts (id, lender_org_id, application_id, borrower_id, source_system, lms_loan_ref, status, sanctioned_amount_minor)
select ('f9400000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, a.lender_org_id, a.id, a.borrower_id, 'lender_lms', 'SAMPLE-LN-' || n, 'active', 5000000
from lending.applications a, generate_series(1, 3) n where right(a.id::text, 2)::int = n;
select pg_temp.keep('l1', 'f9400000-0000-4000-8000-000000000001');
select pg_temp.keep('l2', 'f9400000-0000-4000-8000-000000000002');
select pg_temp.keep('l3', 'f9400000-0000-4000-8000-000000000003');

-- The lender-reported figures (fresh): LX1 has an installment of 4,750.00 due in ten days and nothing overdue; LX2 the same plus 1,000.00 overdue; LY1 like LX1.
insert into servicing.balance_snapshots (lender_org_id, loan_account_id, version, status, outstanding_principal_minor, overdue_principal_minor, overdue_interest_minor,
  penal_charges_minor, other_charges_minor, total_overdue_minor, next_due_on, next_due_minor, days_past_due, source_system, source_record_id, reported_as_of, content_sha256)
select l.lender_org_id, l.id, 1, 'active', 4000000, case when l.lms_loan_ref = 'SAMPLE-LN-2' then 80000 else 0 end, case when l.lms_loan_ref = 'SAMPLE-LN-2' then 20000 else 0 end,
       0, 0, case when l.lms_loan_ref = 'SAMPLE-LN-2' then 100000 else 0 end, current_date + 10, 475000, 0, 'file_import', 'SRC-' || l.lms_loan_ref, clock_timestamp() - interval '1 hour',
       pg_temp.sha('snap-' || l.lms_loan_ref)
from servicing.loan_accounts l;
insert into servicing.schedule_snapshots (id, lender_org_id, loan_account_id, version)
select ('f9500000-0000-4000-8000-0000000000' || lpad(right(l.id::text, 2)::int::text, 2, '0'))::uuid, l.lender_org_id, l.id, 1 from servicing.loan_accounts l;
insert into servicing.schedule_installments (snapshot_id, lender_org_id, seq, due_date, principal_minor, interest_minor)
select s.id, s.lender_org_id, 4, current_date + 10, 400000, 75000 from servicing.schedule_snapshots s;
select pg_temp.as_system();

-- ============================================================================================================================
-- 1. Structure, grants, catalogue
-- ============================================================================================================================
select is((select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'payments' and c.relname in ('webhook_receipts', 'event_processing', 'provider_payments', 'payment_adjustments', 'reconciliation_exceptions',
             'reconciliation_exception_events', 'lender_payment_policies') and c.relrowsecurity and c.relforcerowsecurity), 7::bigint, 'row level security is enabled and forced on all seven new tables');
select is((select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'payments' and c.relname in ('webhook_receipts', 'event_processing', 'provider_payments', 'payment_adjustments', 'reconciliation_exceptions',
             'reconciliation_exception_events', 'lender_payment_policies') and obj_description(c.oid, 'pg_class') like '%Owner: %module.'), 7::bigint, 'every new table has a comment naming its owner module');
select is((select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'payments' and t.tgname = 'no_truncate' and not t.tgisinternal
             and c.relname in ('webhook_receipts', 'event_processing', 'provider_payments', 'payment_adjustments', 'reconciliation_exceptions', 'reconciliation_exception_events', 'lender_payment_policies')),
  7::bigint, 'a no_truncate trigger is on every new table');
select is((select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'payments' and t.tgname = 'append_only' and not t.tgisinternal
             and c.relname in ('webhook_receipts', 'event_processing', 'payment_adjustments', 'reconciliation_exception_events')), 4::bigint, 'an append-only trigger is on receipts, processing, adjustments and exception history');
select is((select array_agg(column_name::text order by ordinal_position) from information_schema.columns where table_schema = 'payments' and table_name = 'webhook_receipts'),
  array['id', 'received_at', 'provider', 'lender_org_id', 'config_id', 'delivery_id', 'payload_sha256', 'outcome', 'reason_class', 'scheme', 'signature_present', 'timestamp_skew_seconds',
        'body_bytes', 'source_ip_hmac', 'event_id'],
  'a receipt holds investigation metadata only: no body, signature, header, token or personal data column exists');
select is((select count(*) from information_schema.columns where table_schema = 'payments' and table_name in ('webhook_receipts', 'provider_events', 'event_processing')
             and column_name ~* '(body|raw|signature_value|header|secret|token|phone|name|email|pan|aadhaar|ip_address)$'), 0::bigint, 'and no such column hides in the event or processing tables either');
select ok((select bool_and(has_table_privilege('service_role', t, 'select') and not has_table_privilege('service_role', t, 'insert') and not has_table_privilege('service_role', t, 'update')
                           and not has_table_privilege('service_role', t, 'delete'))
           from unnest(array['payments.webhook_receipts', 'payments.event_processing', 'payments.provider_payments', 'payments.payment_adjustments', 'payments.reconciliation_exceptions',
                             'payments.reconciliation_exception_events', 'payments.lender_payment_policies', 'payments.provider_events', 'payments.payment_intents']) t),
  'the system role can only READ the payment tables: every write goes through a definer function');
select ok((select bool_and(not has_table_privilege('authenticated', t, 'insert') and not has_table_privilege('authenticated', t, 'delete'))
           from unnest(array['payments.webhook_receipts', 'payments.event_processing', 'payments.provider_payments', 'payments.payment_adjustments', 'payments.reconciliation_exceptions',
                             'payments.reconciliation_exception_events', 'payments.lender_payment_policies', 'payments.provider_events', 'payments.payment_intents']) t),
  'no signed-in role can insert or delete in them, the borrower included (an intent comes only from payments.request_payment)');
select ok((select bool_and(has_function_privilege('service_role', f, 'execute') and not has_function_privilege('authenticated', f, 'execute') and not has_function_privilege('anon', f, 'execute'))
           from unnest(array['payments.ingest_provider_delivery(text,jsonb)', 'payments.apply_provider_event(uuid)', 'payments.raise_exception(uuid,text,text,text,jsonb)',
                             'payments.record_order_created(uuid,text,timestamptz)', 'payments.record_order_failed(uuid,text)', 'payments.expire_stale_intents(interval)']) f),
  'the system functions are callable by the system role only');
select ok((select bool_and(has_function_privilege('authenticated', f, 'execute') and not has_function_privilege('service_role', f, 'execute') and not has_function_privilege('anon', f, 'execute'))
           from unnest(array['payments.request_payment(uuid,payments.intent_purpose,bigint,text,uuid)', 'payments.my_payment(uuid)', 'payments.acknowledge_exception(uuid)',
                             'payments.assign_exception(uuid,uuid)', 'payments.resolve_exception(uuid,text,jsonb,text)', 'payments.reopen_exception(uuid,text,text)',
                             'payments.set_payment_policy(uuid,boolean,bigint,boolean,bigint,integer)', 'payments.lender_webhook_summary(uuid)']) f),
  'the people-facing functions are callable by signed-in users only (the checks are inside)');
select ok((select bool_and(p.prosecdef and exists (select 1 from unnest(p.proconfig) c where c = 'search_path=""'))
           from pg_proc p where p.oid in ('payments.ingest_provider_delivery(text,jsonb)'::regprocedure, 'payments.apply_provider_event(uuid)'::regprocedure,
             'payments.request_payment(uuid,payments.intent_purpose,bigint,text,uuid)'::regprocedure, 'payments.my_payment(uuid)'::regprocedure, 'payments.resolve_exception(uuid,text,jsonb,text)'::regprocedure)),
  'the definer functions pin an empty search_path');
select pg_temp.as_owner();
select is(pg_temp.err($$insert into payments.provider_events (provider, provider_event_id, event_type, payload_sha256, signature_verified) values ('mock_gateway', 'evt_unsigned', 'payment.captured', repeat('a', 64), false)$$),
  '23514|', 'provider_events is VERIFIED ONLY: an unverified row is refused by a check, for every writer');
select pg_temp.as_system();
select is(pg_temp.err($$truncate payments.webhook_receipts$$), '42501|', 'the system role cannot truncate the receipts');
select pg_temp.as_owner();
select is(pg_temp.err($$truncate payments.webhook_receipts$$), 'P0001|', 'nor can the owner');
select pg_temp.as_system();

-- ============================================================================================================================
-- 2. The borrower asks to pay: the amount comes from the lender's REPORTED figures (spec 7.2)
-- ============================================================================================================================
select pg_temp.as_user(pg_temp.u(1));
select pg_temp.keep('i1', payments.request_payment(pg_temp.got('l1')::uuid, 'installment', 475000, 'f9-pay-key-000000001')::text);
select is((select (status::text, amount_minor, purpose::text, lender_org_id = pg_temp.lx(), config_id = pg_temp.got('cx')::uuid, provider_mode::text, target_installment_seq,
                   link_expires_at > now() and link_expires_at < now() + interval '2 hours', provider_order_ref is null, settlement_account_ref is null)::text
           from payments.payment_intents where id = pg_temp.got('i1')::uuid),
  '(created,475000,installment,t,t,mock,4,t,t,t)', 'the intent is created for the exact reported installment, on the lender''s active configuration, for installment 4 of the schedule, with a provisional link expiry');
select is(payments.request_payment(pg_temp.got('l1')::uuid, 'installment', 475000, 'f9-pay-key-000000001')::text, pg_temp.got('i1'), 'a replay with the same key returns the same intent');
select is(pg_temp.err(format($$select payments.request_payment(%L, 'installment', 470000, 'f9-pay-key-000000001')$$, pg_temp.got('l1'))), '23505|idempotency_conflict', 'the same key with another amount is a conflict');
select is(pg_temp.err(format($$select payments.request_payment(%L, 'installment', 475000, 'f9-pay-key-000000002')$$, pg_temp.got('l1'))), '23505|open_intent_exists', 'a second open intent for the same installment and purpose is refused');
select is(pg_temp.err(format($$select payments.request_payment(%L, 'installment', 474999, 'f9-pay-key-000000003')$$, pg_temp.got('l1'))), '22023|amount_not_allowed', 'one paisa less than the reported figure is refused (no partial payment is enabled)');
select is(pg_temp.err(format($$select payments.request_payment(%L, 'installment', 475001, 'f9-pay-key-000000004')$$, pg_temp.got('l1'))), '22023|amount_not_allowed', 'one paisa more is refused');
select is(pg_temp.err(format($$select payments.request_payment(%L, 'overdue', 100000, 'f9-pay-key-000000005')$$, pg_temp.got('l1'))), '55000|nothing_due', 'an overdue payment on a loan with nothing overdue is refused');
select is(pg_temp.err(format($$select payments.request_payment(%L, 'charges', 100, 'f9-pay-key-000000006')$$, pg_temp.got('l1'))), '55000|purpose_not_supported', 'charges are not payable through the app yet');
select is(pg_temp.err(format($$select payments.request_payment(%L, 'foreclosure', 4100000, 'f9-pay-key-000000007')$$, pg_temp.got('l1'))), '55000|quote_required', 'a foreclosure payment needs an unexpired lender quotation');
select is(pg_temp.err(format($$select payments.request_payment(%L, 'part_prepayment', 600000, 'f9-pay-key-000000008')$$, pg_temp.got('l1'))), '55000|purpose_not_enabled', 'a part-prepayment is refused while the lender has not enabled it');
select is(pg_temp.err(format($$select payments.request_payment(%L, 'installment', 475000, 'short')$$, pg_temp.got('l1'))), '22023|bad_request', 'a short idempotency key is refused');
select is(pg_temp.err(format($$select payments.request_payment(%L, 'installment', 0, 'f9-pay-key-000000009')$$, pg_temp.got('l1'))), '22023|bad_request', 'a zero amount is refused');
select is(pg_temp.err(format($$select payments.request_payment(%L, 'installment', 475000, 'f9-pay-key-000000010', gen_random_uuid())$$, pg_temp.got('l1'))), '22023|bad_request', 'only a foreclosure payment names a quotation');
select is(pg_temp.err(format($$select payments.request_payment(%L, 'installment', 475000, 'f9-pay-key-000000011')$$, pg_temp.got('l2'))), 'P0002|', 'another borrower''s loan is not found');
select is(pg_temp.err(format($$select payments.request_payment(%L, 'installment', 475000, 'f9-pay-key-000000012')$$, gen_random_uuid())), 'P0002|', 'nor is an unknown one');
select is(pg_temp.err(format($$insert into payments.payment_intents (lender_org_id, loan_account_id, borrower_id, purpose, amount_minor, provider, idempotency_key, config_id, created_by)
  values (%L, %L, %L, 'installment', 1, 'mock_gateway', 'f9-direct-key-0000001', %L, %L)$$, pg_temp.lx(), pg_temp.got('l1'), pg_temp.got('b1'), pg_temp.got('cx'), pg_temp.u(1))), '42501|',
  'a borrower cannot insert an intent directly: there is one door and it checks the amount');
select pg_temp.as_owner();
select is((select count(*) from ops.outbox_events where event_type = 'payment.create_order' and payload ->> 'intent_id' = pg_temp.got('i1')), 1::bigint, 'exactly one payment.create_order event was enqueued, with the intent id only');
select is((select array_agg(k) from ops.outbox_events e, jsonb_object_keys(e.payload) k where e.event_type = 'payment.create_order' and e.payload ->> 'intent_id' = pg_temp.got('i1')), array['intent_id'], 'and nothing else');
select pg_temp.as_anon();
select is(pg_temp.err(format($$select payments.request_payment(%L, 'installment', 475000, 'f9-pay-key-000000013')$$, pg_temp.got('l1'))), '42501|', 'anon cannot ask to pay');
select pg_temp.as_user(pg_temp.u(5));
select is(pg_temp.err(format($$select payments.request_payment(%L, 'installment', 475000, 'f9-pay-key-000000014')$$, pg_temp.got('l1'))), '42501|', 'a lender user is not a borrower: refused');
select pg_temp.as_owner();
select is((select count(*) from audit.events where action = 'payments.intent.requested' and entity_id = pg_temp.got('i1')), 1::bigint, 'the request is audited');
select is((select metadata::text from audit.events where action = 'payments.intent.requested' and entity_id = pg_temp.got('i1')), '{"purpose": "installment", "provider_mode": "mock"}', 'with the purpose and mode only: no amount, no name');

-- The lender's policy: what it accepts beyond the exact figure.
select pg_temp.as_user(pg_temp.u(5));
select is(payments.set_payment_policy(pg_temp.lx(), true, 100000, true, 500000, 90), 'set', 'a payments administrator sets the lender''s policy');
select is((select (allow_partial_payments, min_partial_amount_minor, allow_part_prepayment, min_part_prepayment_minor, link_validity_minutes)::text from payments.lender_payment_policies where lender_org_id = pg_temp.lx()),
  '(t,100000,t,500000,90)', 'recorded');
select is(pg_temp.err($$select payments.set_payment_policy(pg_temp.lx(), true, null, false, null, 60)$$), '22023|policy_invalid', 'partial payments need a minimum');
select is(pg_temp.err($$select payments.set_payment_policy(pg_temp.lx(), false, null, true, 0, 60)$$), '22023|policy_invalid', 'a part-prepayment needs a positive minimum');
select is(pg_temp.err($$select payments.set_payment_policy(pg_temp.lx(), false, null, false, null, 2)$$), '22023|policy_invalid', 'a link must stay valid at least five minutes');
select is(pg_temp.err($$select payments.set_payment_policy(pg_temp.ly(), true, 1, false, null, 60)$$), '42501|', 'a payments administrator of lender X cannot set lender Y''s policy');
select pg_temp.as_user(pg_temp.u(4));
select is(pg_temp.err($$select payments.set_payment_policy(pg_temp.lx(), true, 1, false, null, 60)$$), '42501|', 'a viewer cannot set a policy');
select is((select count(*) from payments.lender_payment_policies), 1::bigint, 'but a viewer (payment.read) can read the policy of its own lender');
select pg_temp.as_user(pg_temp.u(5), 'aal1');
select is(pg_temp.err($$select payments.set_payment_policy(pg_temp.lx(), true, 1, false, null, 60)$$), '42501|mfa_required', 'setting a policy needs a second factor');
select pg_temp.as_user(pg_temp.u(2));
-- With the policy in place (lender X): borrower b2 on loan LX2 (1,000.00 overdue, 4,750.00 due).
select pg_temp.keep('i2', payments.request_payment(pg_temp.got('l2')::uuid, 'installment', 200000, 'f9-pay-key-000000020')::text);
select is((select amount_minor from payments.payment_intents where id = pg_temp.got('i2')::uuid), 200000::bigint, 'a part payment at or above the lender''s minimum is accepted');
select is(pg_temp.err(format($$select payments.request_payment(%L, 'overdue', 99999, 'f9-pay-key-000000021')$$, pg_temp.got('l2'))), '22023|amount_not_allowed', 'below the minimum is refused (overdue part)');
select is(pg_temp.err(format($$select payments.request_payment(%L, 'overdue', 100001, 'f9-pay-key-000000022')$$, pg_temp.got('l2'))), '22023|amount_not_allowed', 'above the reported overdue figure is refused');
select pg_temp.keep('i3', payments.request_payment(pg_temp.got('l2')::uuid, 'overdue', 100000, 'f9-pay-key-000000023')::text);
select pg_temp.keep('i4', payments.request_payment(pg_temp.got('l2')::uuid, 'part_prepayment', 600000, 'f9-pay-key-000000024')::text);
select is(pg_temp.err(format($$select payments.request_payment(%L, 'part_prepayment', 499999, 'f9-pay-key-000000025')$$, pg_temp.got('l2'))), '22023|amount_not_allowed', 'a part-prepayment below the minimum is refused');
select is(pg_temp.err(format($$select payments.request_payment(%L, 'part_prepayment', 4000001, 'f9-pay-key-000000026')$$, pg_temp.got('l2'))), '22023|amount_not_allowed', 'or above the reported outstanding principal');

-- Foreclosure: exactly an unexpired lender quotation, never a flagged one.
select pg_temp.as_owner();
insert into servicing.foreclosure_quotes (lender_org_id, loan_account_id, lender_quote_ref, as_of, valid_until, principal_minor, interest_minor, charges_minor, prepayment_charge_minor, total_minor, source, reported_by)
values (pg_temp.lx(), pg_temp.got('l2')::uuid, 'SAMPLE-Q-1', now() - interval '1 hour', now() + interval '3 days', 4000000, 75000, 5000, 20000, 4100000, 'lender_portal', pg_temp.u(5));
select pg_temp.keep('q1', (select id::text from servicing.foreclosure_quotes where lender_quote_ref = 'SAMPLE-Q-1'));
select pg_temp.as_user(pg_temp.u(2));
select is(pg_temp.err(format($$select payments.request_payment(%L, 'foreclosure', 4099999, 'f9-pay-key-000000030')$$, pg_temp.got('l2'))), '22023|amount_not_allowed', 'a foreclosure payment one paisa below the quotation is refused');
select is(pg_temp.err(format($$select payments.request_payment(%L, 'foreclosure', 4100000, 'f9-pay-key-000000031', gen_random_uuid())$$, pg_temp.got('l2'))), '55000|quote_not_current', 'naming another quotation is refused');
select pg_temp.keep('i5', payments.request_payment(pg_temp.got('l2')::uuid, 'foreclosure', 4100000, 'f9-pay-key-000000032', pg_temp.got('q1')::uuid)::text);
select is((select (quote_id = pg_temp.got('q1')::uuid, amount_minor, link_expires_at < now() + interval '3 days 1 minute')::text from payments.payment_intents where id = pg_temp.got('i5')::uuid), '(t,4100000,t)',
  'the intent carries the quotation and exactly its total; the link cannot outlive the quotation');
select pg_temp.as_owner();
insert into servicing.foreclosure_quotes (lender_org_id, loan_account_id, lender_quote_ref, as_of, valid_until, principal_minor, interest_minor, charges_minor, prepayment_charge_minor, total_minor, source, reported_by)
values (pg_temp.lx(), pg_temp.got('l2')::uuid, 'SAMPLE-Q-2', now() - interval '1 minute', now() + interval '3 days', 4000000, 75000, 5000, 20000, 4100001, 'lender_portal', pg_temp.u(5));
select pg_temp.as_user(pg_temp.u(2));
select is(pg_temp.err(format($$select payments.request_payment(%L, 'foreclosure', 4100001, 'f9-pay-key-000000033')$$, pg_temp.got('l2'))), '55000|quote_flagged', 'a quotation whose parts do not add up to its total is never payable');
select pg_temp.as_owner();
insert into servicing.foreclosure_quotes (lender_org_id, loan_account_id, lender_quote_ref, as_of, valid_until, principal_minor, interest_minor, charges_minor, prepayment_charge_minor, total_minor, source, reported_by)
values (pg_temp.lx(), pg_temp.got('l1')::uuid, 'SAMPLE-Q-3', now() - interval '3 days', now() - interval '1 day', 4000000, 75000, 5000, 20000, 4100000, 'lender_portal', pg_temp.u(5));
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err(format($$select payments.request_payment(%L, 'foreclosure', 4100000, 'f9-pay-key-000000034')$$, pg_temp.got('l1'))), '55000|quote_required', 'an expired quotation is no quotation');

-- Stale or disputed figures block every amount-dependent purpose.
select pg_temp.as_owner();
insert into servicing.lms_connections (lender_org_id, kind, status, capabilities, staleness_threshold_minutes) values (pg_temp.lx(), 'manual', 'active', '{}', 5);
select pg_temp.as_user(pg_temp.u(2));
select is(pg_temp.err(format($$select payments.request_payment(%L, 'part_prepayment', 700000, 'f9-pay-key-000000040')$$, pg_temp.got('l2'))), '55000|stale_data', 'figures older than the lender''s staleness threshold block the payment');
select pg_temp.as_owner();
update servicing.lms_connections set staleness_threshold_minutes = 1440 where lender_org_id = pg_temp.lx();
-- Lender Y: servicing_sync on, payments on; borrower b1 has loan LY1.
select pg_temp.as_user(pg_temp.u(1));
select pg_temp.keep('iy', payments.request_payment(pg_temp.got('l3')::uuid, 'installment', 475000, 'f9-pay-key-000000050')::text);
select is((select lender_org_id = pg_temp.ly() from payments.payment_intents where id = pg_temp.got('iy')::uuid), true, 'lender Y''s intent is under lender Y');
-- Feature switches.
select pg_temp.as_owner();
set local session_replication_role = replica;
update servicing.lender_features set enabled = false where lender_org_id = pg_temp.ly() and feature = 'payments';
set local session_replication_role = origin;
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err(format($$select payments.request_payment(%L, 'part_prepayment', 700000, 'f9-pay-key-000000051')$$, pg_temp.got('l3'))), '55000|feature_disabled', 'with the payments switch off the request is refused');
select pg_temp.as_owner();
set local session_replication_role = replica;
update servicing.lender_features set enabled = true where lender_org_id = pg_temp.ly() and feature = 'payments';
set local session_replication_role = origin;
-- Figures the lender's own report flags (a warning anomaly on the newest report) are not offered for payment.
select pg_temp.as_owner();
insert into servicing.sync_anomalies (lender_org_id, loan_account_id, kind, severity, snapshot_id, source_system, source_record_id, content_sha256, reported_as_of)
select s.lender_org_id, s.loan_account_id, 'outstanding_rise_without_charge', 'warning', s.id, 'file_import', s.source_record_id, s.content_sha256, s.reported_as_of
from servicing.balance_snapshots s where s.loan_account_id = pg_temp.got('l3')::uuid;
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err(format($$select payments.request_payment(%L, 'installment', 475000, 'f9-pay-key-000000053')$$, pg_temp.got('l3'))), '55000|figures_unavailable', 'a newest report with a warning flag withholds the figures: no amount is offered for payment');
-- A closed loan cannot be paid through the app.
select pg_temp.as_owner();
update servicing.loan_accounts set status = 'closed' where id = pg_temp.got('l3')::uuid;
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err(format($$select payments.request_payment(%L, 'part_prepayment', 700000, 'f9-pay-key-000000052')$$, pg_temp.got('l3'))), '55000|loan_not_active', 'a closed loan is refused');
select pg_temp.as_owner();
update servicing.loan_accounts set status = 'active' where id = pg_temp.got('l3')::uuid;
select pg_temp.as_system();

-- ============================================================================================================================
-- 3. Orders: the system records what the provider created (i2 stays without an order for now: its event will arrive early)
-- ============================================================================================================================
select pg_temp.as_system();
select is(payments.record_order_created(pg_temp.got('i1')::uuid, 'order_A1', now() + interval '1 hour'), 'pending', 'the system records the provider order: created -> pending');
select is((select (status::text, provider_order_ref, link_expires_at > now() + interval '50 minutes')::text from payments.payment_intents where id = pg_temp.got('i1')::uuid), '(pending,order_A1,t)', 'with the provider''s order reference and real link expiry');
select is(payments.record_order_created(pg_temp.got('i1')::uuid, 'order_A1', now() + interval '1 hour'), 'pending', 'recording the same order again is idempotent');
select is(pg_temp.err(format($$select payments.record_order_created(%L, 'order_OTHER', null)$$, pg_temp.got('i1'))), '55000|intent_state_invalid', 'another order for the same intent is refused');
select is(pg_temp.err(format($$select payments.record_order_created(%L, 'bad ref!', null)$$, pg_temp.got('i3'))), '22023|order_ref_invalid', 'an order reference with spaces is refused');
select is(pg_temp.err(format($$select payments.record_order_created(%L, 'order_A3', now() - interval '1 minute')$$, pg_temp.got('i3'))), '22023|link_expiry_invalid', 'a link expiry in the past is refused');
select is(pg_temp.err(format($$select payments.record_order_created(%L, 'order_A1', null)$$, pg_temp.got('i3'))), '23505|', 'a provider order reference cannot be shared by two intents');
select is(pg_temp.err($$select payments.record_order_created(gen_random_uuid(), 'order_ZZ', null)$$), 'P0002|', 'an unknown intent is not found');
select pg_temp.keep('o3', payments.record_order_created(pg_temp.got('i3')::uuid, 'order_A3', now() + interval '1 hour'));
select pg_temp.keep('o4', payments.record_order_created(pg_temp.got('i4')::uuid, 'order_A4', now() + interval '1 hour'));
select pg_temp.keep('o5', payments.record_order_created(pg_temp.got('i5')::uuid, 'order_A5', now() + interval '1 hour'));
select pg_temp.keep('oy', payments.record_order_created(pg_temp.got('iy')::uuid, 'order_Y1', now() + interval '1 hour'));
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err(format($$select payments.record_order_created(%L, 'order_B1', null)$$, pg_temp.got('i2'))), '42501|', 'a borrower cannot record an order');
select is(pg_temp.err(format($$update payments.payment_intents set status = 'succeeded' where id = %L$$, pg_temp.got('i1'))), '42501|', 'a borrower cannot mark their own payment as succeeded (no write privilege on the column)');
select is(pg_temp.err(format($$update payments.payment_intents set provider_order_ref = 'order_X' where id = %L$$, pg_temp.got('i1'))), '42501|', 'nor change its order reference');
select pg_temp.as_system();
select is(pg_temp.err(format($$update payments.payment_intents set status = 'succeeded' where id = %L$$, pg_temp.got('i1'))), '42501|', 'and the system role has no table-level way to do it either: it uses the worker function');

-- ============================================================================================================================
-- 4. Forged, tampered, stale, invalid and unknown-route deliveries leave a receipt and NOTHING else
-- ============================================================================================================================
select pg_temp.as_system();
select pg_temp.keep('seen0', (select count(*)::text from ops.seen_webhooks where source like 'provider\_%'));
select pg_temp.keep('ev0', pg_temp.cnt('payments.provider_events')::text);
select pg_temp.keep('truth0', pg_temp.truth());
-- These carry the REAL event id and delivery id of the genuine capture that arrives later.
select is(pg_temp.ing(pg_temp.got('tx'), pg_temp.dlv('unverified', 'dlv_cap_1', 'evt_cap_1', 'payment', 'captured', 'order_A1', 475000, p_reason => 'signature_mismatch')),
  '{"accepted": false, "outcome": "rejected"}'::jsonb, 'a forged (bad signature) delivery is answered with a plain rejection');
select is(pg_temp.rc('dlv_cap_1'), 'unverified:signature_mismatch', 'and leaves an unverified receipt');
select is(pg_temp.out(pg_temp.got('tx'), pg_temp.dlv('stale_timestamp', 'dlv_cap_1', 'evt_cap_1', 'payment', 'captured', 'order_A1', 475000, p_reason => 'timestamp_outside_tolerance')), 'rejected', 'a replay of an old capture (stale timestamp) is rejected');
select is(pg_temp.out(pg_temp.got('tx'), pg_temp.dlv('invalid', 'dlv_cap_1', 'evt_cap_1', 'payment', 'captured', 'order_A1', 475000, p_reason => 'malformed_body')), 'rejected', 'an unusable body is rejected');
select is(pg_temp.out(pg_temp.got('tx'), pg_temp.dlv('invalid', 'dlv_cap_1', 'evt_cap_1', 'payment', 'captured', 'order_A1', 475000, p_reason => 'provider_scheme_not_configured')), 'rejected', 'a provider whose scheme is not implemented is rejected');
select is(pg_temp.out(pg_temp.got('tx'), pg_temp.dlv('unverified', 'dlv_cap_1', 'evt_cap_1', 'payment', 'captured', 'order_A1', 475000, p_reason => 'something_new')), 'rejected', 'an unknown reason class from the verifier is still just a receipt');
select is(pg_temp.out(pg_temp.got('tx'), pg_temp.dlv('wat', 'dlv_cap_1', 'evt_cap_1', 'payment', 'captured', 'order_A1', 475000)), 'rejected', 'and so is an outcome the verifier never produces');
select is(pg_temp.rc('dlv_cap_1'), 'unverified:signature_mismatch,stale_timestamp:timestamp_outside_tolerance,invalid:malformed_body,scheme_not_configured:provider_scheme_not_configured,unverified:verifier_outcome_unknown,invalid:verifier_outcome_unknown',
  'each one has its own receipt with the right outcome and a closed-list reason class');
select is(pg_temp.cnt('payments.provider_events')::text, pg_temp.got('ev0'), 'NO provider event was created by any of them');
select is((select count(*)::text from ops.seen_webhooks where source like 'provider\_%'), pg_temp.got('seen0'), 'the replay store was not touched: a forged delivery cannot reserve a delivery id');
select is(pg_temp.truth(), pg_temp.got('truth0'), 'and no intent, payment, adjustment or configuration changed');
select is((select count(*) from payments.webhook_receipts where delivery_id = 'dlv_cap_1' and (config_id is null or lender_org_id <> pg_temp.lx())), 0::bigint, 'the receipts are tied to the lender whose token routed them');
select is((select (signature_present, scheme, timestamp_skew_seconds, body_bytes, source_ip_hmac = repeat('a', 64))::text from payments.webhook_receipts where delivery_id = 'dlv_cap_1' order by received_at limit 1),
  '(t,mock-standard-webhooks-v1,3,420,t)', 'a receipt keeps the investigation facts: scheme, whether a signature was present, skew, size and a keyed address hash');
-- Unknown routes look like a bad signature.
select is(pg_temp.ing(pg_temp.sha('no-such-token'), pg_temp.dlv('verified', 'dlv_cap_9', 'evt_cap_9', 'payment', 'captured', 'order_A1', 475000)), '{"accepted": false, "outcome": "rejected"}'::jsonb,
  'an unknown token gets exactly the answer a bad signature gets');
select is(pg_temp.ing('not-a-hash', pg_temp.dlv('verified', 'dlv_cap_9', 'evt_cap_9', 'payment', 'captured', 'order_A1', 475000)), '{"accepted": false, "outcome": "rejected"}'::jsonb, 'a malformed token the same');
select is(pg_temp.rc('dlv_cap_9'), 'unmatched:token_unknown_or_inactive,unmatched:token_unknown_or_inactive', 'it is recorded, tied to no lender');
select is((select count(*) from payments.webhook_receipts where delivery_id = 'dlv_cap_9' and config_id is null and lender_org_id is null), 2::bigint, 'with no configuration and no lender');
select is(pg_temp.cnt('payments.provider_events')::text, pg_temp.got('ev0'), 'and no event');
select is(pg_temp.err($$select payments.ingest_provider_delivery(null, '[]'::jsonb)$$), '22023|bad_request', 'a delivery that is not an object is refused outright');
select pg_temp.as_user(pg_temp.u(3));
select is(pg_temp.err(format($$select payments.ingest_provider_delivery(%L, '{}'::jsonb)$$, pg_temp.got('tx'))), '42501|', 'only the system role can ingest');
select pg_temp.as_anon();
select is(pg_temp.err(format($$select payments.ingest_provider_delivery(%L, '{}'::jsonb)$$, pg_temp.got('tx'))), '42501|', 'anon cannot');
select pg_temp.as_system();

-- ============================================================================================================================
-- 5. The genuine delivery: verified, correlated, business-valid; then applied exactly once
-- ============================================================================================================================
select is(pg_temp.ing(pg_temp.got('tx'), pg_temp.dlv('verified', 'dlv_cap_1', 'evt_cap_1', 'payment', 'captured', 'order_A1', 475000, 'pay_1', pg_temp.got('mx'))),
  '{"accepted": true, "outcome": "ok"}'::jsonb, 'the genuine delivery that the forgeries imitated is accepted: they did not squat its event id or its delivery id');
select is((select (provider_status, amount_minor, currency::text, object_kind, object_ref, order_ref, rank, processing_class, signature_verified, payment_intent_id = pg_temp.got('i1')::uuid, config_id = pg_temp.got('cx')::uuid, lender_org_id = pg_temp.lx())::text
           from payments.provider_events where provider_event_id = 'evt_cap_1'),
  '(captured,475000,INR,payment,pay_1,order_A1,30,actionable,t,t,t,t)', 'the verified event is stored, correlated to the intent, lender and configuration');
select is((select verification_stages::text from payments.provider_events where provider_event_id = 'evt_cap_1'), '{"business": "passed", "integrity": "matched", "correlation": "matched", "authentication": "matched"}', 'with all four verification stages recorded');
select is(pg_temp.rc('dlv_cap_1'), 'unverified:signature_mismatch,stale_timestamp:timestamp_outside_tolerance,invalid:malformed_body,scheme_not_configured:provider_scheme_not_configured,unverified:verifier_outcome_unknown,invalid:verifier_outcome_unknown,verified:none',
  'the genuine delivery has a verified receipt after the forged ones');
select is((select event_id = pg_temp.ev('evt_cap_1') from payments.webhook_receipts where delivery_id = 'dlv_cap_1' and outcome = 'verified'), true, 'which points at the event');
select is((select count(*) from ops.seen_webhooks where source like 'provider\_%'), pg_temp.got('seen0')::bigint + 1, 'the delivery id is now in the replay store, once');
select is((select count(*) from ops.outbox_events where event_type = 'payment.apply_event' and payload ->> 'event_id' = pg_temp.ev('evt_cap_1')::text), 1::bigint, 'one payment.apply_event was enqueued for it');
select is((select array_agg(k) from ops.outbox_events e, jsonb_object_keys(e.payload) k where e.event_type = 'payment.apply_event' and e.payload ->> 'event_id' = pg_temp.ev('evt_cap_1')::text), array['event_id'], 'carrying the event id only');
select is((select status::text from payments.payment_intents where id = pg_temp.got('i1')::uuid), 'pending', 'ingest alone changes no payment: the intent is still pending');
select is((select count(*) from payments.event_processing where event_id = pg_temp.ev('evt_cap_1')), 0::bigint, 'and nothing has been applied yet');
select pg_temp.keep('truth1', pg_temp.truth());
select is((payments.apply_provider_event(pg_temp.ev('evt_cap_1')) ->> 'outcome') || ':' || (payments.apply_provider_event(pg_temp.ev('evt_cap_1')) ->> 'outcome'), 'applied:already_applied', 'the worker applies the event once; the second call does nothing');
select is((select status::text from payments.payment_intents where id = pg_temp.got('i1')::uuid), 'succeeded', 'the intent is succeeded, through the existing guard (verified event, same intent, lender, provider, equal amount and currency)');
select is((select (status, amount_minor, rank, duplicate_capture, captured_at is not null, intent_id = pg_temp.got('i1')::uuid, loan_account_id = pg_temp.got('l1')::uuid)::text from payments.provider_payments where provider_payment_ref = 'pay_1'),
  '(captured,475000,30,f,t,t,t)', 'the provider payment is recorded with the provider''s figures');
select is((select count(*) || ':' || min(outcome) || ':' || min(reason_class) from payments.event_processing where event_id = pg_temp.ev('evt_cap_1')), '1:applied:intent_succeeded', 'exactly one processing row says what happened');

-- What the borrower may see: an honest stage.
select pg_temp.as_user(pg_temp.u(1));
select is((select (intent_status, stage, lender_posted_on is null)::text from payments.my_payment(pg_temp.got('i1')::uuid)), '(succeeded,provider_received,t)', 'the borrower sees "received by the payment provider", not "paid"');
select pg_temp.as_owner();
insert into servicing.lms_receipts (lender_org_id, loan_account_id, kind, lms_receipt_ref, amount_minor, value_date, payment_mode, bank_reference, source_system, source_record_id, reported_as_of, content_sha256)
values (pg_temp.lx(), pg_temp.got('l1')::uuid, 'receipt', 'RC-SAMPLE-1', 475000, current_date, 'upi', 'pay_OTHER', 'file_import', 'SRC-RC-1', clock_timestamp(), pg_temp.sha('rc1'));
select pg_temp.as_user(pg_temp.u(1));
select is((select stage from payments.my_payment(pg_temp.got('i1')::uuid)), 'provider_received', 'a lender receipt that does not carry the provider reference does not count as posted');
select pg_temp.as_owner();
insert into servicing.lms_receipts (lender_org_id, loan_account_id, kind, lms_receipt_ref, amount_minor, value_date, payment_mode, bank_reference, source_system, source_record_id, reported_as_of, content_sha256)
values (pg_temp.lx(), pg_temp.got('l1')::uuid, 'receipt', 'RC-SAMPLE-2', 474999, current_date, 'upi', 'pay_1', 'file_import', 'SRC-RC-2', clock_timestamp(), pg_temp.sha('rc2'));
select pg_temp.as_user(pg_temp.u(1));
select is((select stage from payments.my_payment(pg_temp.got('i1')::uuid)), 'provider_received', 'nor does one for a different amount');
select pg_temp.as_owner();
insert into servicing.lms_receipts (lender_org_id, loan_account_id, kind, lms_receipt_ref, amount_minor, value_date, payment_mode, bank_reference, source_system, source_record_id, reported_as_of, content_sha256)
values (pg_temp.lx(), pg_temp.got('l1')::uuid, 'receipt', 'RC-SAMPLE-3', 475000, current_date, 'upi', 'pay_1', 'file_import', 'SRC-RC-3', clock_timestamp(), pg_temp.sha('rc3'));
select pg_temp.as_user(pg_temp.u(1));
select is((select (stage, lender_posted_on = current_date)::text from payments.my_payment(pg_temp.got('i1')::uuid)), '(lender_posted,t)', 'the stage is "posted by the lender" only when the lender''s own receipt carries the provider reference for the same amount');
select pg_temp.as_owner();
insert into servicing.lms_receipts (lender_org_id, loan_account_id, kind, lms_receipt_ref, reverses_receipt_id, reverses_receipt_ref, amount_minor, value_date, payment_mode, bank_reference, source_system, source_record_id, reported_as_of, content_sha256)
select pg_temp.lx(), pg_temp.got('l1')::uuid, 'reversal', 'RC-SAMPLE-3R', r.id, r.lms_receipt_ref, 475000, current_date, 'upi', 'pay_1', 'file_import', 'SRC-RC-3R', clock_timestamp(), pg_temp.sha('rc3r')
from servicing.lms_receipts r where r.lms_receipt_ref = 'RC-SAMPLE-3';
select pg_temp.as_user(pg_temp.u(1));
select is((select stage from payments.my_payment(pg_temp.got('i1')::uuid)), 'provider_received', 'a reversed lender receipt no longer counts as posted');
select pg_temp.as_user(pg_temp.u(2));
select is(pg_temp.err(format($$select * from payments.my_payment(%L)$$, pg_temp.got('i1'))), 'P0002|', 'another borrower cannot see it');
select pg_temp.as_user(pg_temp.u(3));
select is(pg_temp.err(format($$select * from payments.my_payment(%L)$$, pg_temp.got('i1'))), '42501|', 'a lender user is not a borrower');
select pg_temp.as_anon();
select is(pg_temp.err(format($$select * from payments.my_payment(%L)$$, pg_temp.got('i1'))), '42501|', 'anon is refused');
select pg_temp.as_system();

-- Replays and conflicts.
select is((pg_temp.ing(pg_temp.got('tx'), pg_temp.dlv('verified', 'dlv_cap_1', 'evt_cap_1', 'payment', 'captured', 'order_A1', 475000, 'pay_1', pg_temp.got('mx')))) ->> 'accepted', 'true', 'the same delivery again is acknowledged');
select is(pg_temp.rc('dlv_cap_1'), 'unverified:signature_mismatch,stale_timestamp:timestamp_outside_tolerance,invalid:malformed_body,scheme_not_configured:provider_scheme_not_configured,unverified:verifier_outcome_unknown,invalid:verifier_outcome_unknown,verified:none,duplicate:replayed_delivery',
  'as a duplicate receipt');
select is(pg_temp.cnt('payments.provider_events')::text, (pg_temp.got('ev0')::bigint + 1)::text, 'and no second event');
select is((pg_temp.ing(pg_temp.got('tx'), pg_temp.dlv('verified', 'dlv_cap_1b', 'evt_cap_1', 'payment', 'captured', 'order_A1', 475000, 'pay_1', pg_temp.got('mx'), p_sha => pg_temp.sha('body-dlv_cap_1')))) ->> 'accepted', 'true',
  'the same event id carried by another delivery with the same payload is a duplicate too');
select is(pg_temp.rc('dlv_cap_1b'), 'duplicate:replayed_delivery', 'with a duplicate receipt');
select is((select count(*) from payments.reconciliation_exceptions where class = 'event_payload_conflict'), 0::bigint, 'and no exception');
select is((pg_temp.ing(pg_temp.got('tx'), pg_temp.dlv('verified', 'dlv_cap_1c', 'evt_cap_1', 'payment', 'captured', 'order_A1', 475000, 'pay_1', pg_temp.got('mx'), p_sha => pg_temp.sha('another-body')))) ->> 'accepted', 'true',
  'the same event id with a DIFFERENT payload is also acknowledged ...');
select is(pg_temp.rc('dlv_cap_1c'), 'duplicate:event_payload_conflict', '... but flagged on its receipt');
select is((select (severity, owner, status, subject ->> 'event_id' = pg_temp.ev('evt_cap_1')::text)::text from payments.reconciliation_exceptions where class = 'event_payload_conflict'), '(warning,platform,open,t)', 'and an event_payload_conflict exception is opened for the platform, with the event id only');
select is(pg_temp.cnt('payments.provider_events')::text, (pg_temp.got('ev0')::bigint + 1)::text, 'the stored event was not replaced');
select is((select payload_sha256 from payments.provider_events where provider_event_id = 'evt_cap_1'), pg_temp.sha('body-dlv_cap_1'), 'its payload hash is still the original one');
select is(pg_temp.err($$update payments.provider_events set amount_minor = 1 where provider_event_id = 'evt_cap_1'$$), '42501|', 'and nobody can edit it (the system has no privilege; the table is append-only for the owner)');
select pg_temp.as_owner();
select is(pg_temp.err($$update payments.provider_events set amount_minor = 1 where provider_event_id = 'evt_cap_1'$$), 'P0001|Record a compensating entry instead.', 'even the owner cannot');
select pg_temp.as_system();

-- ============================================================================================================================
-- 6. Authentic but unsupported: stored verified-and-ignored, changing nothing
-- ============================================================================================================================
select pg_temp.keep('truth2', pg_temp.truth());
select pg_temp.keep('cnt2', pg_temp.cnt('payments.provider_payments')::text || ',' || pg_temp.cnt('payments.payment_adjustments')::text || ',' || pg_temp.cnt('payments.event_processing')::text);
select is((pg_temp.ing(pg_temp.got('tx'), pg_temp.dlv('verified', 'dlv_uns_1', 'evt_uns_1', 'unsupported', 'unmapped', null, null, 'obj_u1'))) ->> 'accepted', 'true', 'an authentic delivery of an unsupported kind is accepted');
select is(pg_temp.rc('dlv_uns_1'), 'verified_ignored:none', 'recorded as verified_ignored, not as an unverified receipt');
select is((select (object_kind, processing_class, provider_status, signature_verified, payment_intent_id is null)::text from payments.provider_events where provider_event_id = 'evt_uns_1'), '(unsupported,ignored,unmapped,t,t)', 'the event is stored as ignored');
select is((select outcome || ':' || reason_class from payments.event_processing where event_id = pg_temp.ev('evt_uns_1')), 'ignored_unsupported:unsupported_kind', 'with its processing row');
select is((select count(*) from ops.outbox_events where event_type = 'payment.apply_event' and payload ->> 'event_id' = pg_temp.ev('evt_uns_1')::text), 0::bigint, 'nothing was queued for it');
select is(payments.apply_provider_event(pg_temp.ev('evt_uns_1')) ->> 'outcome', 'already_applied', 'applying it does nothing');
select is(pg_temp.truth(), pg_temp.got('truth2'), 'no intent, payment, adjustment, event or configuration changed');
select is((pg_temp.ing(pg_temp.got('tx'), pg_temp.dlv('verified', 'dlv_uns_2', 'evt_uns_2', 'payment', 'unmapped', 'order_A1', 475000, 'pay_1'))) ->> 'accepted', 'true', 'a known kind with a status the platform cannot map is ignored too');
select is(pg_temp.rc('dlv_uns_2'), 'verified_ignored:none', 'also verified_ignored');
select is((select outcome || ':' || reason_class from payments.event_processing where event_id = pg_temp.ev('evt_uns_2')), 'ignored_unsupported:unmapped_status', 'with the reason unmapped_status');
select is(pg_temp.truth(), pg_temp.got('truth2'), 'and still nothing changed');
select is((pg_temp.ing(pg_temp.got('tx'), pg_temp.dlv('verified', 'dlv_uns_1', 'evt_uns_1', 'unsupported', 'unmapped', null, null, 'obj_u1'))) ->> 'accepted', 'true', 'a replay of the ignored delivery is a duplicate');
select is(pg_temp.rc('dlv_uns_1'), 'verified_ignored:none,duplicate:replayed_delivery', 'with a duplicate receipt');

-- ============================================================================================================================
-- 7. Authentic but not matched, or not business-valid: a receipt only, and the delivery id is NOT consumed (the provider may retry)
-- ============================================================================================================================
select pg_temp.keep('seen3', (select count(*)::text from ops.seen_webhooks where source like 'provider\_%'));
select pg_temp.keep('ev3', pg_temp.cnt('payments.provider_events')::text);
select pg_temp.keep('truth3', pg_temp.truth());
select is(pg_temp.ing(pg_temp.got('tx'), pg_temp.dlv('verified', 'dlv_m_1', 'evt_m_1', 'payment', 'captured', 'order_Y1', 475000, 'pay_y1')), '{"accepted": false, "outcome": "unmatched"}'::jsonb,
  'an authentic event for ANOTHER lender''s order (lender Y''s reference under lender X''s token) is not matched');
select is(pg_temp.rc('dlv_m_1'), 'unmatched:order_ref_unknown', 'it is a receipt with the reason order_ref_unknown (no hint that the order exists elsewhere)');
select is(pg_temp.out(pg_temp.got('tx'), pg_temp.dlv('verified', 'dlv_m_2', 'evt_m_2', 'payment', 'captured', 'order_NOPE', 475000, 'pay_x')), 'unmatched', 'an unknown order reference is not matched');
select is(pg_temp.out(pg_temp.got('tx'), pg_temp.dlv('verified', 'dlv_m_3', 'evt_m_3', 'payment', 'captured', null, 475000, 'pay_x')), 'unmatched', 'a payment event with no order reference is not matched');
select is(pg_temp.rc('dlv_m_3'), 'unmatched:order_ref_missing', 'reason order_ref_missing');
select is(pg_temp.out(pg_temp.got('tx'), pg_temp.dlv('verified', 'dlv_m_4', 'evt_m_4', 'payment', 'captured', 'order_A1', 475000, 'pay_x', p_provider => 'other_gateway')), 'rejected', 'an event whose provider is not the configuration''s is rejected as a provider mismatch');
select is(pg_temp.rc('dlv_m_4'), 'unmatched:provider_mismatch', 'and recorded as such');
select is(pg_temp.out(pg_temp.got('tx'), pg_temp.dlv('verified', 'dlv_m_5', 'evt_m_5', 'mandate', 'active', 'order_A1', null, 'mdt_1')), 'unmatched', 'a mandate event is unmatched until mandates exist (the correlation hook finds nothing)');
select is(pg_temp.rc('dlv_m_5'), 'unmatched:mandate_unknown', 'reason mandate_unknown');
-- Business validation.
select is(pg_temp.out(pg_temp.got('tx'), pg_temp.dlv('verified', 'dlv_b_1', 'evt_b_1', 'payment', 'captured', 'order_A1', null, 'pay_b')), 'invalid', 'a capture that states no amount is invalid');
select is(pg_temp.rc('dlv_b_1'), 'invalid:amount_missing', 'amount_missing');
select is(pg_temp.out(pg_temp.got('tx'), pg_temp.dlv('verified', 'dlv_b_2', 'evt_b_2', 'refund', 'refunded', 'order_A1', 0, 'rfd_b')), 'invalid', 'a refund of nothing is invalid');
select is(pg_temp.out(pg_temp.got('tx'), pg_temp.dlv('verified', 'dlv_b_3', 'evt_b_3', 'payment', 'captured', 'order_A1', 475000, 'pay_b', p_currency => 'USD')), 'invalid', 'a currency other than INR is invalid');
select is(pg_temp.rc('dlv_b_3'), 'invalid:malformed_event', 'malformed_event');
select is(pg_temp.out(pg_temp.got('tx'), pg_temp.dlv('verified', 'dlv_b_4', 'evt_b_4', 'payment', 'weird', 'order_A1', 475000, 'pay_b')), 'invalid', 'a status outside the vocabulary is invalid');
select is(pg_temp.out(pg_temp.got('tx'), jsonb_set(pg_temp.dlv('verified', 'dlv_b_5', 'evt_b_5', 'payment', 'captured', 'order_A1', 475000, 'pay_b'), '{event,amountMinor}', '"-5"')), 'invalid', 'a negative amount is invalid');
select is(pg_temp.out(pg_temp.got('tx'), jsonb_set(pg_temp.dlv('verified', 'dlv_b_6', 'evt_b_6', 'payment', 'captured', 'order_A1', 475000, 'pay_b'), '{event,amountMinor}', '"10.5"')), 'invalid', 'a fractional amount is invalid');
select is(pg_temp.out(pg_temp.got('tx'), jsonb_set(pg_temp.dlv('verified', 'dlv_b_7', 'evt_b_7', 'payment', 'captured', 'order_A1', 475000, 'pay_b'), '{event,rank}', '101')), 'invalid', 'a rank outside 0 to 100 is invalid');
select is(pg_temp.out(pg_temp.got('tx'), jsonb_set(pg_temp.dlv('verified', 'dlv_b_8', 'evt_b_8', 'payment', 'captured', 'order_A1', 475000, 'pay_b'), '{event,deliveryId}', '"dlv_other"')), 'invalid', 'an event whose delivery id differs from the delivery''s own is invalid');
select is(pg_temp.out(pg_temp.got('tx'), jsonb_set(pg_temp.dlv('verified', 'dlv_b_9', 'evt_b_9', 'payment', 'captured', 'order_A1', 475000, 'pay_b'), '{event,eventId}', '"a b"')), 'invalid', 'an event id with spaces is invalid');
select is(pg_temp.out(pg_temp.got('tx'), pg_temp.dlv('verified', 'dlv_b_10', 'evt_b_10', 'payment', 'captured', 'order_A1', 475000, 'pay_b', p_sha => 'xyz')), 'invalid', 'a payload hash that is not a SHA-256 is invalid');
select is(pg_temp.out(pg_temp.got('tx'), (pg_temp.dlv('verified', 'dlv_b_11', 'evt_b_11', 'payment', 'captured', 'order_A1', 475000, 'pay_b')) - 'event'), 'invalid', 'a verified delivery with no event is invalid');
select is(pg_temp.cnt('payments.provider_events')::text, pg_temp.got('ev3'), 'none of the unmatched or invalid deliveries created an event');
select is((select count(*)::text from ops.seen_webhooks where source like 'provider\_%'), pg_temp.got('seen3'), 'and none consumed a delivery id');
select is(pg_temp.truth(), pg_temp.got('truth3'), 'and nothing changed');
-- A delivery that arrives BEFORE the order is recorded can be retried and then matches.
select is(pg_temp.out(pg_temp.got('tx'), pg_temp.dlv('verified', 'dlv_early', 'evt_early', 'payment', 'captured', 'order_A2', 200000, 'pay_2')), 'unmatched', 'a capture that arrives before the system has recorded the order is unmatched ...');
select pg_temp.keep('o2', payments.record_order_created(pg_temp.got('i2')::uuid, 'order_A2', now() + interval '1 hour'));
select is(pg_temp.out(pg_temp.got('tx'), pg_temp.dlv('verified', 'dlv_early', 'evt_early', 'payment', 'captured', 'order_A2', 200000, 'pay_2')), 'ok', '... and the provider''s retry of the SAME delivery, once the order exists, is accepted');
select is(pg_temp.rc('dlv_early'), 'unmatched:order_ref_unknown,verified:none', 'the first attempt did not consume the delivery id');

-- Merchant mismatch: an authentic event naming another merchant stops that lender's payments and tells the platform (lender Y).
select is(pg_temp.out(pg_temp.got('ty'), pg_temp.dlv('verified', 'dlv_mm_1', 'evt_mm_1', 'payment', 'captured', 'order_Y1', 475000, 'pay_y1', 'SAMPLE-WRONG-MERCHANT')), 'unmatched', 'an authentic event that names a different merchant than the lender''s configuration is not matched');
select is(pg_temp.rc('dlv_mm_1'), 'unmatched:merchant_mismatch', 'reason merchant_mismatch');
select is((select status from payments.lender_payment_configs where id = pg_temp.got('cy')::uuid), 'suspended', 'and the lender''s payment configuration is suspended at once');
select is((select (severity, owner, status)::text from payments.reconciliation_exceptions where class = 'merchant_mismatch' and lender_org_id = pg_temp.ly()), '(critical,platform,open)', 'with a critical exception for the platform');
select is(pg_temp.out(pg_temp.got('ty'), pg_temp.dlv('unverified', 'dlv_mm_2', 'evt_mm_2', 'payment', 'captured', 'order_Y1', 475000, p_reason => 'signature_mismatch')), 'rejected', 'a suspended configuration''s token answers exactly like an unknown one');
select is(pg_temp.rc('dlv_mm_2'), 'unmatched:token_unknown_or_inactive', 'it is recorded against no lender');
select pg_temp.as_user(pg_temp.u(1));
select pg_temp.as_system();

-- ============================================================================================================================
-- 8. Applying events: amounts, duplicates, order, refunds, adjustments (spec 9 step 6, 7.3)
-- ============================================================================================================================
-- i3: overdue 100000 (order_A3). A capture one paisa too high or too low never makes it succeed.
select is(pg_temp.out(pg_temp.got('tx'), pg_temp.dlv('verified', 'dlv_a3a', 'evt_a3a', 'payment', 'captured', 'order_A3', 100001, 'pay_3a')), 'ok', 'a capture of 100001 against an intent of 100000 is a verified event ...');
select is(payments.apply_provider_event(pg_temp.ev('evt_a3a')) ->> 'reason', 'amount_differs', '... and applying it records the payment but does not succeed the intent');
select is((select status::text from payments.payment_intents where id = pg_temp.got('i3')::uuid), 'pending', 'the intent stays pending (+1 paisa)');
select is((select (class, severity, owner, status, subject ? 'intent_id', subject ? 'provider_payment_id')::text from payments.reconciliation_exceptions where class = 'amount_mismatch' and subject ->> 'intent_id' = pg_temp.got('i3')),
  '(amount_mismatch,warning,lender,open,t,t)', 'an amount_mismatch exception is open for the lender');
select is(pg_temp.out(pg_temp.got('tx'), pg_temp.dlv('verified', 'dlv_a4a', 'evt_a4a', 'payment', 'captured', 'order_A4', 599999, 'pay_4a')), 'ok', 'one paisa too LOW against 600000 ...');
select is(payments.apply_provider_event(pg_temp.ev('evt_a4a')) ->> 'reason', 'amount_differs', '... is the same');
select is((select status::text from payments.payment_intents where id = pg_temp.got('i4')::uuid), 'pending', 'the intent stays pending (-1 paisa)');
select is(pg_temp.err(format($$update payments.payment_intents set status = 'succeeded' where id = %L$$, pg_temp.got('i3'))), '42501|', 'the system role cannot force it');
select pg_temp.as_owner();
select is(pg_temp.err(format($$update payments.payment_intents set status = 'succeeded' where id = %L$$, pg_temp.got('i3'))), 'P0001|', 'and even the owner is stopped by the guard: the only event on file has another amount');
select pg_temp.as_system();
-- A second capture on a paid order.
select is(pg_temp.out(pg_temp.got('tx'), pg_temp.dlv('verified', 'dlv_d1', 'evt_d1', 'payment', 'captured', 'order_A1', 475000, 'pay_1b')), 'ok', 'the customer paid twice: a second capture arrives for the paid order ...');
select is(payments.apply_provider_event(pg_temp.ev('evt_d1')) ->> 'reason', 'duplicate_capture', '... it is recorded as a SEPARATE flagged payment');
select is((select (count(*), count(*) filter (where duplicate_capture))::text from payments.provider_payments where intent_id = pg_temp.got('i1')::uuid), '(2,1)', 'two provider payments for the order, one flagged');
select is((select count(*) from payments.reconciliation_exceptions where class = 'duplicate_payment' and subject ->> 'intent_id' = pg_temp.got('i1')), 1::bigint, 'a duplicate_payment exception is open');
select is((select status::text from payments.payment_intents where id = pg_temp.got('i1')::uuid), 'succeeded', 'the intent is unchanged');
-- Out of order on i2 (partial 200000, order_A2): the early capture 'dlv_early' arrived first; now lower-ranked events follow it.
select is(payments.apply_provider_event(pg_temp.ev('evt_early')) ->> 'reason', 'intent_succeeded', 'the early capture is applied when the worker gets to it: the intent succeeds');
select is(pg_temp.out(pg_temp.got('tx'), pg_temp.dlv('verified', 'dlv_o1', 'evt_o1', 'payment', 'authorized', 'order_A2', null, 'pay_2')), 'ok', 'an "authorized" event for the same payment arrives LATE ...');
select is(payments.apply_provider_event(pg_temp.ev('evt_o1')) ->> 'outcome', 'ignored_stale', '... it is ignored as stale, never reverting anything');
select is(pg_temp.out(pg_temp.got('tx'), pg_temp.dlv('verified', 'dlv_o2', 'evt_o2', 'payment', 'failed', 'order_A2', null, 'pay_2', p_rank => 25)), 'ok', 'a "failed" event for a payment already captured ...');
select is(payments.apply_provider_event(pg_temp.ev('evt_o2')) ->> 'reason', 'failure_after_success', '... opens a payment_status_conflict exception');
select is((select status::text from payments.payment_intents where id = pg_temp.got('i2')::uuid), 'succeeded', 'and never reverts the intent');
select is((select status || ':' || rank from payments.provider_payments where provider_payment_ref = 'pay_2'), 'captured:30', 'nor the provider payment');
select is((select count(*) from payments.reconciliation_exceptions where class = 'payment_status_conflict'), 1::bigint, 'one exception');
-- Same event applied twice, event with a higher rank.
select is(pg_temp.out(pg_temp.got('tx'), pg_temp.dlv('verified', 'dlv_o3', 'evt_o3', 'payment', 'paid', 'order_A2', 200000, 'pay_2')), 'ok', 'a "paid" event (same rank as captured) arrives ...');
select is(payments.apply_provider_event(pg_temp.ev('evt_o3')) ->> 'outcome', 'already_applied', '... it adds nothing (same rank, both success statuses)');

-- Refunds and chargebacks are compensating rows. i5: foreclosure 4100000 (order_A5).
select pg_temp.keep('truth4', pg_temp.truth());
select is(pg_temp.out(pg_temp.got('tx'), pg_temp.dlv('verified', 'dlv_r1', 'evt_r1', 'refund', 'refunded', 'order_A5', 1000, 'rfd_1')), 'ok', 'a refund arrives BEFORE the capture it refunds ...');
select is(payments.apply_provider_event(pg_temp.ev('evt_r1')) ->> 'outcome', 'deferred', '... it is deferred');
select is((select (outcome, attempt, deferred_until > now())::text from payments.event_processing where event_id = pg_temp.ev('evt_r1')), '(deferred,1,t)', 'with a retry time in the future');
select is((select count(*) from ops.outbox_events where event_type = 'payment.apply_event' and payload ->> 'event_id' = pg_temp.ev('evt_r1')::text and available_at > now()), 1::bigint, 'and a retry queued for then');
select is(payments.apply_provider_event(pg_temp.ev('evt_r1')) ->> 'outcome', 'deferred', 'applying it again while the capture is still missing defers again');
select is((select max(attempt) from payments.event_processing where event_id = pg_temp.ev('evt_r1')), 2, 'counting the attempts');
select is(pg_temp.out(pg_temp.got('tx'), pg_temp.dlv('verified', 'dlv_c5', 'evt_c5', 'payment', 'captured', 'order_A5', 4100000, 'pay_5')), 'ok', 'now the capture of the foreclosure payment arrives');
select is(payments.apply_provider_event(pg_temp.ev('evt_c5')) ->> 'reason', 'intent_succeeded', 'and succeeds the intent');
select pg_temp.keep('intent5', (select to_jsonb(i)::text from payments.payment_intents i where id = pg_temp.got('i5')::uuid));
select is(payments.apply_provider_event(pg_temp.ev('evt_r1')) ->> 'reason', 'adjustment_recorded', 'the deferred refund is applied as a compensating row');
select is((select (kind, amount_minor, object_ref, currency::text, source_event_id = pg_temp.ev('evt_r1'))::text from payments.payment_adjustments), '(refund,1000,rfd_1,INR,t)', 'positive amount, the provider''s refund id, the source event');
select is((select to_jsonb(i)::text from payments.payment_intents i where id = pg_temp.got('i5')::uuid), pg_temp.got('intent5'), 'the intent row is exactly as it was: amount, parties and status are never edited');
select is((select amount_minor from payments.provider_payments where provider_payment_ref = 'pay_5'), 4100000::bigint, 'and so is the captured amount of the provider payment');
select is(payments.apply_provider_event(pg_temp.ev('evt_r1')) ->> 'outcome', 'already_applied', 'applying the refund again does nothing');
select is(pg_temp.out(pg_temp.got('tx'), pg_temp.dlv('verified', 'dlv_r1b', 'evt_r1b', 'refund', 'refunded', 'order_A5', 1000, 'rfd_1')), 'ok', 'the provider repeats the same refund under a new event id ...');
select is(payments.apply_provider_event(pg_temp.ev('evt_r1b')) ->> 'reason', 'adjustment_exists', '... no second adjustment: one per refund object');
select is((select count(*) from payments.payment_adjustments), 1::bigint, 'one adjustment');
select is(pg_temp.out(pg_temp.got('tx'), pg_temp.dlv('verified', 'dlv_r2', 'evt_r2', 'refund', 'pending', 'order_A5', null, 'rfd_2')), 'ok', 'a refund that is still pending ...');
select is(payments.apply_provider_event(pg_temp.ev('evt_r2')) ->> 'reason', 'no_adjustment_for_status', '... records nothing yet');
select is(pg_temp.out(pg_temp.got('tx'), pg_temp.dlv('verified', 'dlv_r3', 'evt_r3', 'chargeback', 'disputed', 'order_A5', 500000, 'cbk_1')), 'ok', 'a chargeback ...');
select is(payments.apply_provider_event(pg_temp.ev('evt_r3')) ->> 'reason', 'adjustment_recorded', '... is a second compensating row of its own kind');
select is((select string_agg(kind || ':' || amount_minor, ',' order by kind) from payments.payment_adjustments), 'chargeback:500000,refund:1000', 'both are positive amounts');
select is(pg_temp.out(pg_temp.got('tx'), pg_temp.dlv('verified', 'dlv_r4', 'evt_r4', 'refund', 'refunded', 'order_A5', 4100000, 'rfd_4')), 'ok', 'a refund that would take the adjustments above the captured amount ...');
select is(payments.apply_provider_event(pg_temp.ev('evt_r4')) ->> 'reason', 'adjustments_exceed_payment', '... is stored and flagged, not hidden');
select is((select count(*) from payments.reconciliation_exceptions where class = 'amount_mismatch' and subject ->> 'provider_payment_id' = (select id::text from payments.provider_payments where provider_payment_ref = 'pay_5')), 1::bigint, 'with an amount_mismatch exception');
select is(pg_temp.err(format($$update payments.payment_adjustments set amount_minor = 1 where object_ref = 'rfd_1'$$)), '42501|', 'an adjustment cannot be edited by the system role');
select pg_temp.as_owner();
select is(pg_temp.err($$update payments.payment_adjustments set amount_minor = 1 where object_ref = 'rfd_1'$$), 'P0001|Record a compensating entry instead.', 'nor by the owner');
select is(pg_temp.err($$insert into payments.payment_adjustments (lender_org_id, provider_payment_id, kind, object_ref, amount_minor, source_event_id)
  select lender_org_id, id, 'refund', 'rfd_neg', -5, first_event_id from payments.provider_payments limit 1$$), '23514|', 'a negative adjustment cannot be stored');
select pg_temp.as_system();
-- A refund whose capture never comes: bounded retries, then an exception. i9: a fresh installment on LX2 (i2 is finished), never paid.
select pg_temp.as_user(pg_temp.u(2));
select pg_temp.keep('i9', payments.request_payment(pg_temp.got('l2')::uuid, 'installment', 475000, 'f9-pay-key-000000074')::text);
select pg_temp.as_system();
select pg_temp.keep('o9', payments.record_order_created(pg_temp.got('i9')::uuid, 'order_A9', now() + interval '1 hour'));
select is(pg_temp.out(pg_temp.got('tx'), pg_temp.dlv('verified', 'dlv_r9', 'evt_r9', 'refund', 'refunded', 'order_A9', 100, 'rfd_9')), 'ok', 'a refund for an order that was never captured ...');
select is((select string_agg(payments.apply_provider_event(pg_temp.ev('evt_r9')) ->> 'outcome', ',') from generate_series(1, 6)), 'deferred,deferred,deferred,deferred,deferred,deferred', '... is deferred for six attempts');
select is(payments.apply_provider_event(pg_temp.ev('evt_r9')) ->> 'reason', 'no_capture_found', 'and then becomes an exception');
select is((select count(*) from payments.reconciliation_exceptions where class = 'refund_unmatched' and subject ->> 'intent_id' = pg_temp.got('i9')), 1::bigint, 'a refund_unmatched exception is open');
select is(payments.apply_provider_event(pg_temp.ev('evt_r9')) ->> 'outcome', 'already_applied', 'which is final for that event');
-- Settlement events change nothing but the log.
select pg_temp.keep('truth5', pg_temp.truth());
select is(pg_temp.out(pg_temp.got('tx'), pg_temp.dlv('verified', 'dlv_s1', 'evt_s1', 'settlement', 'succeeded', null, 123456, 'stl_1')), 'ok', 'a settlement event is accepted (it needs no intent)');
select is(payments.apply_provider_event(pg_temp.ev('evt_s1')) ->> 'outcome', 'recorded_for_reconciliation', 'and recorded for reconciliation');
select is(pg_temp.truth(), pg_temp.got('truth5'), 'with no effect on any payment');
-- Late money on a closed intent. i6: a fresh installment request for LX1 (i1 is finished), its link expired.
select pg_temp.as_user(pg_temp.u(1));
select pg_temp.keep('i6', payments.request_payment(pg_temp.got('l1')::uuid, 'installment', 475000, 'f9-pay-key-000000070')::text);
select pg_temp.as_system();
select pg_temp.keep('o6', payments.record_order_created(pg_temp.got('i6')::uuid, 'order_A6', now() + interval '10 minutes'));
select pg_temp.as_owner();
set local session_replication_role = replica;
update payments.payment_intents set link_expires_at = now() - interval '2 hours' where id = pg_temp.got('i6')::uuid;
set local session_replication_role = origin;
select pg_temp.as_system();
select is(payments.expire_stale_intents(interval '15 minutes'), 1, 'the system expires the one intent whose link ended more than the grace period ago');
select is((select status::text from payments.payment_intents where id = pg_temp.got('i6')::uuid), 'expired', 'it is expired');
select is((select status::text from payments.payment_intents where id = pg_temp.got('i3')::uuid), 'pending', 'while an intent with a provider payment on file is left for a person to look at');
select is(payments.expire_stale_intents(interval '15 minutes'), 0, 'expiring again does nothing');
select is(pg_temp.err($$select payments.expire_stale_intents(interval '30 days')$$), '22023|bad_request', 'an absurd grace period is refused');
select is(pg_temp.out(pg_temp.got('tx'), pg_temp.dlv('verified', 'dlv_l1', 'evt_l1', 'payment', 'captured', 'order_A6', 475000, 'pay_6')), 'ok', 'a capture then arrives for the expired intent ...');
select is(payments.apply_provider_event(pg_temp.ev('evt_l1')) ->> 'reason', 'intent_closed', '... the money is on record and an exception says so');
select is((select status::text from payments.payment_intents where id = pg_temp.got('i6')::uuid), 'expired', 'the intent is not revived');
select is((select count(*) from payments.reconciliation_exceptions where class = 'payment_on_closed_intent'), 1::bigint, 'payment_on_closed_intent is open for the lender');
-- Order failure.
select pg_temp.as_user(pg_temp.u(1));
select pg_temp.keep('i7', payments.request_payment(pg_temp.got('l1')::uuid, 'part_prepayment', 600000, 'f9-pay-key-000000071')::text);
select pg_temp.as_system();
select is(payments.record_order_failed(pg_temp.got('i7')::uuid, 'provider_rejected'), 'failed', 'a provider that refuses to create the order fails the intent');
select is(payments.record_order_failed(pg_temp.got('i7')::uuid, 'provider_rejected'), 'failed', 'idempotently');
select is(pg_temp.err(format($$select payments.record_order_failed(%L, 'whatever')$$, pg_temp.got('i7'))), '22023|reason_invalid', 'the failure class is a closed list');
select is(pg_temp.err(format($$select payments.record_order_failed(%L, 'provider_rejected')$$, pg_temp.got('i1'))), '55000|intent_state_invalid', 'only a created intent can fail at order creation');
select pg_temp.as_user(pg_temp.u(1));
select pg_temp.keep('i8', payments.request_payment(pg_temp.got('l1')::uuid, 'part_prepayment', 600000, 'f9-pay-key-000000072')::text);
select pg_temp.as_system();
select is(payments.record_order_failed(pg_temp.got('i8')::uuid, 'merchant_mismatch'), 'failed', 'a provider response that names another merchant fails the intent ...');
select is((select status from payments.lender_payment_configs where id = pg_temp.got('cx')::uuid), 'suspended', '... suspends the lender''s payment configuration ...');
select is((select (severity, owner)::text from payments.reconciliation_exceptions where class = 'merchant_mismatch' and lender_org_id = pg_temp.lx()), '(critical,platform)', '... and opens a critical exception for the platform');
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err(format($$select payments.request_payment(%L, 'installment', 475000, 'f9-pay-key-000000073')$$, pg_temp.got('l1'))), '55000|collection_target_invalid', 'no new payment can be requested while the configuration is suspended');
select pg_temp.as_system();

-- ============================================================================================================================
-- 9. The exception queue: handled by people, resolved only as an annotation
-- ============================================================================================================================
select pg_temp.as_system();
select pg_temp.keep('x1', (select id::text from payments.reconciliation_exceptions where class = 'duplicate_payment' and lender_org_id = pg_temp.lx()));
select pg_temp.keep('x2', (select id::text from payments.reconciliation_exceptions where class = 'amount_mismatch' and subject ->> 'intent_id' = pg_temp.got('i3')));
select pg_temp.keep('xp', (select id::text from payments.reconciliation_exceptions where class = 'event_payload_conflict'));
select pg_temp.keep('xm', (select id::text from payments.reconciliation_exceptions where class = 'merchant_mismatch' and lender_org_id = pg_temp.lx()));
-- Raising: system only, ids only, idempotent, closed lists.
select pg_temp.keep('xs', payments.raise_exception(pg_temp.lx(), 'stale_sync', 'warning', 'lender', jsonb_build_object('loan_account_id', pg_temp.got('l1')))::text);
select is(payments.raise_exception(pg_temp.lx(), 'stale_sync', 'warning', 'lender', jsonb_build_object('loan_account_id', pg_temp.got('l1')))::text, pg_temp.got('xs'), 'raising the same exception again returns the open one');
select is(pg_temp.err(format($$select payments.raise_exception(%L, 'stale_sync', 'warning', 'lender', '{"loan_account_id":"Asha Rao"}')$$, pg_temp.lx())), '22023|subject_invalid', 'a subject that is not an id is refused');
select is(pg_temp.err(format($$select payments.raise_exception(%L, 'stale_sync', 'warning', 'lender', '{"amount":"100"}')$$, pg_temp.lx())), '22023|subject_invalid', 'a subject key outside the closed list is refused');
select is(pg_temp.err(format($$select payments.raise_exception(%L, 'made_up_class', 'warning', 'lender', %L::jsonb)$$, pg_temp.lx(), jsonb_build_object('loan_account_id', pg_temp.got('l1')))), '23514|', 'a class outside the closed list is refused by the table');
select is(pg_temp.err(format($$select payments.raise_exception(%L, 'stale_sync', 'catastrophic', 'lender', %L::jsonb)$$, pg_temp.lx(), jsonb_build_object('loan_account_id', pg_temp.got('l1')))), '22023|severity_invalid', 'so is a severity, even for an exception that is already open');
select is(pg_temp.err(format($$select payments.raise_exception(%L, 'stale_sync', 'warning', 'lender', %L::jsonb)$$, 'f9a00000-0000-4000-8000-000000000000', jsonb_build_object('loan_account_id', pg_temp.got('l1')))), 'P0002|', 'an exception can be raised for a lender only');
select pg_temp.as_user(pg_temp.u(3));
select is(pg_temp.err(format($$select payments.raise_exception(%L, 'stale_sync', 'warning', 'lender', %L::jsonb)$$, pg_temp.lx(), jsonb_build_object('loan_account_id', pg_temp.got('l1')))), '42501|', 'a person cannot raise one through the system door');
-- Reading.
select ok((select count(*) from payments.reconciliation_exceptions) >= 7 and (select count(*) from payments.reconciliation_exceptions where lender_org_id <> pg_temp.lx()) = 0, 'and only its own lender''s');
select pg_temp.as_user(pg_temp.u(6));
select is((select count(*) from payments.reconciliation_exceptions where lender_org_id = pg_temp.lx()), 0::bigint, 'another lender''s reconciler sees none of them');
select is(pg_temp.err(format($$select payments.acknowledge_exception(%L)$$, pg_temp.got('x1'))), 'P0002|', 'and cannot act on one (not found, not forbidden: no oracle)');
select pg_temp.as_user(pg_temp.u(4));
select is((select count(*) from payments.reconciliation_exceptions where lender_org_id = pg_temp.lx()), (select count(*) from payments.reconciliation_exceptions), 'a viewer (payment.read) can read them');
select is(pg_temp.err(format($$select payments.acknowledge_exception(%L)$$, pg_temp.got('x1'))), '42501|', 'but cannot act on them');
select pg_temp.as_user(pg_temp.u(3), 'aal1');
select is(pg_temp.err(format($$select payments.acknowledge_exception(%L)$$, pg_temp.got('x1'))), '42501|mfa_required', 'acting needs a second factor');
select pg_temp.as_user(pg_temp.u(1));
select is((select count(*) from payments.reconciliation_exceptions), 0::bigint, 'a borrower reads none');
select is(pg_temp.err(format($$select payments.acknowledge_exception(%L)$$, pg_temp.got('x1'))), 'P0002|', 'and cannot act (not found: no oracle)');
select pg_temp.as_anon();
select is(pg_temp.err($$select count(*) from payments.reconciliation_exceptions$$), '42501|', 'anon is refused');
-- Working one: acknowledge, assign, resolve (annotation only), reopen.
select pg_temp.as_user(pg_temp.u(3));
select is(payments.acknowledge_exception(pg_temp.got('x1')::uuid), 'acknowledged', 'a reconciler acknowledges an exception of its lender');
select is(payments.acknowledge_exception(pg_temp.got('x1')::uuid), 'acknowledged', 'idempotently');
select is(pg_temp.err(format($$select payments.assign_exception(%L, %L)$$, pg_temp.got('x1'), pg_temp.u(4))), '22023|assignee_invalid', 'it cannot be assigned to someone who may not act on it (the viewer)');
select is(pg_temp.err(format($$select payments.assign_exception(%L, %L)$$, pg_temp.got('x1'), pg_temp.u(6))), '22023|assignee_invalid', 'nor to another lender''s reconciler');
select is(payments.assign_exception(pg_temp.got('x1')::uuid, pg_temp.u(3)), 'assigned', 'but to a reconciler of the lender');
select is((select (status, assigned_to = pg_temp.u(3))::text from payments.reconciliation_exceptions where id = pg_temp.got('x1')::uuid), '(assigned,t)', 'recorded');
select is(pg_temp.err(format($$select payments.resolve_exception(%L, 'posted_by_lender', null, 'checked')$$, pg_temp.got('x1'))), '22023|evidence_required', 'resolving needs the evidence reviewed');
select is(pg_temp.err(format($$select payments.resolve_exception(%L, 'posted_by_lender', '[]'::jsonb, 'checked')$$, pg_temp.got('x1'))), '22023|evidence_required', 'an empty list of evidence is not evidence');
select is(pg_temp.err(format($$select payments.resolve_exception(%L, 'posted_by_lender', '["Asha Rao paid cash"]'::jsonb, 'checked')$$, pg_temp.got('x1'))), '22023|evidence_required', 'evidence is ids and short labels without spaces: a sentence (or a name) is refused');
select is(pg_temp.err(format($$select payments.resolve_exception(%L, 'because', '["RC-SAMPLE-3"]'::jsonb, 'checked')$$, pg_temp.got('x1'))), '22023|reason_required', 'the reason comes from a closed list');
select is(pg_temp.err(format($$select payments.resolve_exception(%L, 'posted_by_lender', '["RC-SAMPLE-3"]'::jsonb, %L)$$, pg_temp.got('x1'), repeat('x', 501))), '22023|reason_invalid', 'a note is at most 500 characters');
select is(pg_temp.err(format($$select payments.resolve_exception(%L, 'posted_by_lender', '["RC-SAMPLE-3"]'::jsonb, 'call 9876543210 for details')$$, pg_temp.got('x1'))), '22023|unsafe_free_text', 'and may not carry a phone number');
select pg_temp.as_owner();
select pg_temp.keep('truth6', pg_temp.truth());
select pg_temp.keep('cnt6', pg_temp.cnt('payments.provider_events')::text || ',' || pg_temp.cnt('payments.event_processing')::text || ',' || pg_temp.cnt('payments.webhook_receipts')::text);
select pg_temp.as_user(pg_temp.u(3));
select is(payments.resolve_exception(pg_temp.got('x1')::uuid, 'refunded_by_provider', '["RC-SAMPLE-3", "pay_1b"]'::jsonb, 'the duplicate was refunded by the provider'), 'resolved', 'resolved with a reason, the evidence reviewed and a note');
select pg_temp.as_owner();
select is(pg_temp.truth(), pg_temp.got('truth6'), 'RESOLUTION IS AN ANNOTATION: no intent, payment, adjustment, configuration or loan changed');
select is(pg_temp.cnt('payments.provider_events')::text || ',' || pg_temp.cnt('payments.event_processing')::text || ',' || pg_temp.cnt('payments.webhook_receipts')::text, pg_temp.got('cnt6'), 'and no event, processing row or receipt was written');
select is((select (status, resolved_at is not null)::text from payments.reconciliation_exceptions where id = pg_temp.got('x1')::uuid), '(resolved,t)', 'only the exception moved');
select is((select string_agg(action, ',' order by occurred_at, id) from payments.reconciliation_exception_events where exception_id = pg_temp.got('x1')::uuid), 'opened,acknowledged,assigned,resolved', 'its history is complete');
select is((select (actor_kind, reason_code, evidence::text, authorised_by_permission, actor_user_id = pg_temp.u(3))::text from payments.reconciliation_exception_events where exception_id = pg_temp.got('x1')::uuid and action = 'resolved'),
  '(lender_user,refunded_by_provider,"[""RC-SAMPLE-3"", ""pay_1b""]",payment.reconcile,t)', 'with the person, the reason, the evidence and the permission that authorised it');
select pg_temp.as_user(pg_temp.u(3));
select is(pg_temp.err(format($$select payments.resolve_exception(%L, 'refunded_by_provider', '["RC-SAMPLE-3"]'::jsonb)$$, pg_temp.got('x1'))), '55000|exception_state_invalid', 'a resolved exception cannot be resolved again');
select is(pg_temp.err(format($$select payments.reopen_exception(%L, 'because')$$, pg_temp.got('x1'))), '22023|reason_required', 'reopening needs a reason from the closed list');
select is(payments.reopen_exception(pg_temp.got('x1')::uuid, 'new_information', 'the provider later reversed the refund'), 'reopened', 'a resolved exception can be reopened');
select is((select (status, resolved_at is null)::text from payments.reconciliation_exceptions where id = pg_temp.got('x1')::uuid), '(reopened,t)', 'it is open again');
select is(pg_temp.err(format($$select payments.reopen_exception(%L, 'new_information')$$, pg_temp.got('x1'))), '55000|exception_state_invalid', 'only a resolved one can be reopened');
select is(pg_temp.err(format($$select payments.acknowledge_exception(%L)$$, pg_temp.got('xp'))), '42501|', 'a lender reconciler cannot act on a PLATFORM-owned exception (event_payload_conflict) ...');
select is((select count(*) from payments.reconciliation_exceptions where id = pg_temp.got('xp')::uuid), 1::bigint, '... though it can read it');
select pg_temp.as_user(pg_temp.u(8));
select is(pg_temp.err(format($$select payments.acknowledge_exception(%L)$$, pg_temp.got('xp'))), 'P0002|', 'a platform user with no role finds nothing');
select pg_temp.as_user(pg_temp.u(7), 'aal1');
select is(pg_temp.err(format($$select payments.acknowledge_exception(%L)$$, pg_temp.got('xp'))), '42501|mfa_required', 'the platform needs a second factor too');
select pg_temp.as_user(pg_temp.u(7));
select is(payments.acknowledge_exception(pg_temp.got('xp')::uuid), 'acknowledged', 'a platform payments administrator acknowledges it');
select is(pg_temp.err(format($$select payments.acknowledge_exception(%L)$$, pg_temp.got('x2'))), '42501|', 'but not a lender-owned one: those need payment.reconcile in that lender');
select is(payments.resolve_exception(pg_temp.got('xp')::uuid, 'escalated_to_provider', '["SAMPLE-TICKET-1"]'::jsonb), 'resolved', 'and resolves it with evidence');
select is((select authorised_by_permission from payments.reconciliation_exception_events where exception_id = pg_temp.got('xp')::uuid and action = 'resolved'), 'platform.payments.providers.manage', 'under the platform permission');
select is(payments.resolve_exception(pg_temp.got('xm')::uuid, 'verified_with_provider', '["SAMPLE-TICKET-2"]'::jsonb), 'resolved', 'the critical merchant_mismatch exception is the platform''s to resolve');
select pg_temp.as_system();
select is(pg_temp.err(format($$update payments.reconciliation_exceptions set status = 'resolved', resolved_at = now() where id = %L$$, pg_temp.got('x2'))), '42501|', 'the system role cannot resolve an exception directly');
select is(pg_temp.err(format($$select payments.resolve_exception(%L, 'no_action_needed', '["RC-SAMPLE-3"]'::jsonb)$$, pg_temp.got('x2'))), '42501|', 'nor through the people function');
select pg_temp.as_owner();
select is(pg_temp.err($$delete from payments.reconciliation_exceptions$$), 'P0001|Record a compensating entry instead.', 'an exception is never deleted');
select is(pg_temp.err($$update payments.reconciliation_exception_events set note = 'x'$$), 'P0001|Record a compensating entry instead.', 'nor its history edited');
select is(pg_temp.err($$insert into payments.reconciliation_exception_events (exception_id, lender_org_id, action, actor_kind) select id, lender_org_id, 'resolved', 'system' from payments.reconciliation_exceptions limit 1$$), '23514|',
  'a system actor cannot resolve (check): resolution needs a person, a reason and evidence');

-- ============================================================================================================================
-- 10. What each party sees of the callbacks and the payment tables
-- ============================================================================================================================
select pg_temp.as_user(pg_temp.u(3));
select ok((select count(*) from payments.lender_webhook_summary(pg_temp.lx())) >= 5, 'a lender sees counts of the deliveries for its own configuration, by outcome');
select is((select receipts from payments.lender_webhook_summary(pg_temp.lx()) where outcome = 'unverified'), 2::bigint, 'two unverified deliveries reached lender X''s endpoint');
select is(pg_temp.err(format($$select * from payments.lender_webhook_summary(%L)$$, pg_temp.ly())), '42501|', 'but not lender Y''s');
select is((select count(*) from payments.webhook_receipts), 0::bigint, 'and never a receipt row');
select pg_temp.as_user(pg_temp.u(7));
select ok((select count(*) from payments.webhook_receipts) >= 40, 'the platform reads every receipt (including the ones tied to no lender)');
select ok((select count(*) from payments.webhook_receipts where lender_org_id is null) >= 3, 'among them the deliveries for tokens nobody owns');
select pg_temp.as_user(pg_temp.u(1));
select is((select count(*) from payments.webhook_receipts) + (select count(*) from payments.provider_events) + (select count(*) from payments.event_processing), 0::bigint, 'a borrower reads no receipt, event or processing row');
select is((select count(*) from payments.provider_payments) + (select count(*) from payments.payment_adjustments), 0::bigint, 'nor any provider payment or adjustment');
select is((select count(*) from payments.payment_intents), (select count(*) from payments.payment_intents where borrower_id = pg_temp.got('b1')::uuid), 'only their own intents');
select pg_temp.as_user(pg_temp.u(6));
select is((select count(*) from payments.provider_payments) + (select count(*) from payments.payment_adjustments) + (select count(*) from payments.event_processing) + (select count(*) from payments.provider_events), 0::bigint,
  'lender Y''s reconciler sees none of lender X''s payments, adjustments, processing or events');
select is((select count(*) from payments.webhook_receipts), 0::bigint, 'and no receipts');
select pg_temp.as_user(pg_temp.u(3));
select ok((select count(*) from payments.provider_payments) >= 6 and (select count(*) from payments.provider_payments where lender_org_id <> pg_temp.lx()) = 0, 'lender X''s reconciler reads its own provider payments');
select ok((select count(*) from payments.event_processing) >= 20 and (select count(*) from payments.event_processing where lender_org_id is distinct from pg_temp.lx()) = 0, 'and its processing log');
select is((select count(*) from payments.lender_payment_policies where lender_org_id <> pg_temp.lx()), 0::bigint, 'and no policy of another lender');
select pg_temp.as_anon();
select is(pg_temp.err($$select count(*) from payments.provider_payments$$), '42501|', 'anon reads no provider payment');
select is(pg_temp.err($$select count(*) from payments.webhook_receipts$$), '42501|', 'no receipt');
select is(pg_temp.err($$select * from payments.lender_webhook_summary(gen_random_uuid())$$), '42501|', 'and no summary');
select pg_temp.as_system();
select * from finish();
rollback;
