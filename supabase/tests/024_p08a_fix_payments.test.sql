-- Phase 08a review-fix wave, payments (key SP), migration 20261018000920. Every assertion here fails without the fix it covers.
--   1. Identity is scoped to the lender: delivery ids, event ids, provider payment and order references (A28, M28, U0, U56, A31).
--   2. Money integrity of apply_provider_event: second capture whenever it arrives, late capture after a higher-ranked non-success, a captured
--      payment is never overwritten, statuses a table cannot store, refunds booked against the payment they name (M22, M24, M25, A50, M26, M30).
--   3. request_payment guards, expiry, foreclosure link and quotation, closed loan, refund-aware stage (M23, M27, M31, M32, A56).
--   4. Hand-off links: withdrawn on a suspended configuration, a cancelled mandate, money on the intent, a closed loan; the vault (A0, U27-U29, U33-U35).
--   5. The cancel race (U31), the penal-charge sentence (U32), options (U30), disputed receipts (U36), evidence and note screening (A9, M29).
-- Synthetic data only (labelled SAMPLE). Error codes are reported as SQLSTATE|hint.
begin;
create extension if not exists pgtap with schema extensions;
select plan(204);

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
-- Runs a single-value select and returns its value as text, or error:SQLSTATE|hint (so one failing step never aborts the file).
create function pg_temp.try(q text) returns text language plpgsql as $fn$
declare v text; v_state text; v_hint text;
begin
  execute q into v;
  return v;
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_hint = pg_exception_hint;
  return 'error:' || v_state || '|' || coalesce(v_hint, '');
end
$fn$;
-- Runs a command that returns nothing; an error is swallowed.
create function pg_temp.run(q text) returns void language plpgsql as $fn$
begin
  execute q;
exception when others then
  null;
end
$fn$;
create function pg_temp.keep(k text, v text) returns text language sql as $fn$ select set_config('t.' || k, v, true) $fn$;
create function pg_temp.got(k text) returns text language sql as $fn$ select nullif(current_setting('t.' || k, true), '') $fn$;
create function pg_temp.u(n integer) returns uuid language sql as $fn$ select ('fd000000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid $fn$;
create function pg_temp.sha(k text) returns text language sql as $fn$ select encode(sha256(convert_to('SAMPLE-024-' || k, 'UTF8')), 'hex') $fn$;
create function pg_temp.tok(p_lender uuid) returns text language sql as $fn$ select encode(sha256(convert_to('SAMPLE-TOKEN-' || p_lender::text, 'UTF8')), 'hex') $fn$;
create function pg_temp.lx() returns uuid language sql as $fn$ select 'fdb00000-0000-4000-8000-000000000001'::uuid $fn$;
create function pg_temp.ly() returns uuid language sql as $fn$ select 'fdb00000-0000-4000-8000-000000000002'::uuid $fn$;
create function pg_temp.lid(n integer) returns uuid language sql as $fn$ select ('fd400000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid $fn$;
create function pg_temp.mid(n integer) returns uuid language sql as $fn$ select ('fdd00000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid $fn$;
create function pg_temp.bytes(p_n integer) returns bytea language sql as $fn$ select decode(repeat('ab', p_n), 'hex') $fn$;
create function pg_temp.cfg(p_lender uuid) returns uuid language sql as $fn$ select id from payments.lender_payment_configs where lender_org_id = p_lender and status = 'active' $fn$;

-- A SAMPLE payment configuration (see 019): synthetic provider, merchant, verified registry entry, settlement account and an active mock configuration.
create function pg_temp.sample_collection_config(p_lender uuid, p_settlement uuid, p_label text, p_masked text) returns uuid language plpgsql as $fn$
declare
  v_tag text := left(md5(p_lender::text), 12);
  u1 uuid := md5(p_lender::text || 'sample-maker')::uuid;
  u2 uuid := md5(p_lender::text || 'sample-checker')::uuid;
  u3 uuid := md5(p_lender::text || 'sample-submitter')::uuid;
  v_rule uuid; v_reg uuid; v_mer uuid; v_cfg uuid;
begin
  perform set_config('udofin.allow_mock_providers', 'on', true);
  insert into auth.users (id, raw_app_meta_data) values (u1, '{"actor_type":"staff"}'), (u2, '{"actor_type":"staff"}'), (u3, '{"actor_type":"staff"}')
    on conflict (id) do nothing;
  insert into onboarding.lender_gates (lender_org_id, stage) values (p_lender, 'activated') on conflict (lender_org_id) do update set stage = 'activated';
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
  insert into payments.provider_register (provider, display_name, kind, status, authorisation_evidence_ref) values ('mock_gateway', 'SAMPLE provider (fixture)', 'payment_and_mandate', 'approved', 'SAMPLE-AUTH-EVIDENCE-1')
    on conflict (provider) do nothing;
  insert into payments.merchant_registry (provider, merchant_ref, owner_kind, owner_org_id, purpose, claimed_by, verification_status, verification_evidence_ref,
                                          verified_by, verified_at)
    values ('mock_gateway', 'SAMPLE-MERCHANT-' || v_tag, 'lender', p_lender, 'repayment', u1, 'verified', 'SAMPLE-EVIDENCE-3', u2, now()) returning id into v_mer;
  insert into payments.lender_payment_configs (lender_org_id, provider, provider_mode, merchant_registry_id, settlement_account_id, secret_ref, webhook_secret_ref,
                                               endpoint_token_hash, evidence_ref, contract_section_ref, idempotency_key, drafted_by)
    values (p_lender, 'mock_gateway', 'mock', v_mer, p_settlement, 'SAMPLE_SECRET', 'SAMPLE_WEBHOOK_SECRET',
            encode(sha256(convert_to('SAMPLE-TOKEN-' || p_lender::text, 'UTF8')), 'hex'), 'SAMPLE-EVIDENCE-2', 'SAMPLE-CONTRACT-1',
            'sample-fixture-config-' || v_tag, u1) returning id into v_cfg;
  update payments.lender_payment_configs set status = 'pending_approval', submitted_by = u3, submitted_at = now(), status_changed_by = u3 where id = v_cfg;
  update payments.lender_payment_configs set status = 'active', approved_by = u2, approved_at = now(), status_changed_by = u2 where id = v_cfg;
  return v_cfg;
end
$fn$;

-- A verified delivery as the callback receiver hands it over (the verifier outcome is always 'verified' here).
create function pg_temp.dlv(
  p_delivery text, p_event text, p_kind text, p_status text, p_order text, p_amount bigint, p_obj text, p_rank integer default null,
  p_sha text default null, p_parent text default null, p_occurred text default '2026-10-15T10:00:00Z'
) returns jsonb language sql as $fn$
  select jsonb_strip_nulls(jsonb_build_object(
    'provider', 'mock_gateway', 'outcome', 'verified', 'reason_class', 'none', 'delivery_id', p_delivery,
    'payload_sha256', coalesce(p_sha, pg_temp.sha('body-' || p_delivery)), 'scheme', 'mock-standard-webhooks-v1', 'signature_present', true,
    'timestamp_skew_seconds', 3, 'body_bytes', 420, 'ip_hmac', repeat('a', 64),
    'event', jsonb_build_object(
      'provider', 'mock_gateway', 'deliveryId', p_delivery, 'eventId', p_event, 'objectKind', p_kind, 'objectRef', p_obj, 'orderRef', p_order, 'status', p_status,
      'rank', coalesce(p_rank, case p_status when 'created' then 10 when 'pending' then 15 when 'authorized' then 20 when 'failed' then 25 when 'rejected' then 25
                                       when 'captured' then 30 when 'paid' then 30 when 'succeeded' then 30 when 'refunded' then 40 when 'returned' then 40
                                       when 'disputed' then 50 when 'cancelled' then 45 when 'expired' then 45 else 0 end),
      'amountMinor', p_amount::text, 'currency', case when p_amount is null then null else 'INR' end,
      'occurredAt', p_occurred, 'parentPaymentRef', p_parent)));
$fn$;
-- Ingest and, when the delivery was accepted as an actionable event, apply it. Returns "outcome:reason" of the application, or "ingest:<outcome>".
create function pg_temp.land(p_lender uuid, p_event text, p_kind text, p_status text, p_order text, p_amount bigint, p_obj text, p_rank integer default null,
                             p_parent text default null, p_occurred text default '2026-10-15T10:00:00Z', p_delivery text default null) returns text language plpgsql as $fn$
declare v_ing jsonb; v_id uuid; v_app jsonb; v_state text; v_hint text;
begin
  v_ing := payments.ingest_provider_delivery(pg_temp.tok(p_lender), pg_temp.dlv(coalesce(p_delivery, 'dlv_' || p_event), p_event, p_kind, p_status, p_order, p_amount, p_obj, p_rank, null, p_parent, p_occurred));
  if (v_ing ->> 'accepted') <> 'true' then return 'ingest:' || (v_ing ->> 'outcome'); end if;
  select id into v_id from payments.provider_events where lender_org_id = p_lender and provider_event_id = p_event;
  if v_id is null then return 'ingest:no_event'; end if;
  v_app := payments.apply_provider_event(v_id);
  return (v_app ->> 'outcome') || ':' || coalesce(v_app ->> 'reason', '');
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_hint = pg_exception_hint;
  return 'error:' || v_state || '|' || coalesce(v_hint, '');
end
$fn$;
-- A pending intent (borrower asks, the system records the order) kept under the tag.
create function pg_temp.mk(p_tag text, p_loan integer, p_purpose text, p_amount bigint, p_order text, p_borrower integer default 1) returns text language plpgsql as $fn$
declare v uuid;
begin
  perform pg_temp.as_user(pg_temp.u(p_borrower));
  v := payments.request_payment(pg_temp.lid(p_loan), p_purpose::payments.intent_purpose, p_amount, 'fd-key-' || p_tag || '-0000000000');
  perform pg_temp.as_system();
  perform pg_temp.keep(p_tag, v::text);
  perform payments.record_order_created(v, p_order, now() + interval '1 hour');
  return v::text;
exception when others then
  perform pg_temp.as_system();
  return 'error';
end
$fn$;
create function pg_temp.out_ing(p_token text, p_delivery text, p_event text, p_order text) returns text language sql as $fn$
  select payments.ingest_provider_delivery(p_token, pg_temp.dlv(p_delivery, p_event, 'payment', 'captured', p_order, 475000, 'pay_late')) ->> 'outcome'
$fn$;
create function pg_temp.exc(p_class text, p_intent text) returns bigint language sql as $fn$
  select count(*) from payments.reconciliation_exceptions where class = p_class and subject ->> 'intent_id' = p_intent
$fn$;
create function pg_temp.pp(p_lender uuid, p_ref text) returns payments.provider_payments language sql as $fn$
  select * from payments.provider_payments where lender_org_id = p_lender and provider_payment_ref = p_ref
$fn$;
grant execute on all functions in schema pg_temp to public;

-- Fixture -----------------------------------------------------------------------------------------------------------------------
-- Users: 01 borrower b1, 02 borrower b2, 03 lender X reconciler (payment.read, payment.reconcile), 04 lender X viewer (payment.read), 05 lender X payments admin,
-- 06 lender Y reconciler, 07 platform payments admin, 08 platform user without a role, 09 and 10 loan product maker and checker (both lenders).
insert into auth.users (id, phone, raw_app_meta_data)
select pg_temp.u(n), case when n in (1, 2) then '9100000009' || n end, case when n in (1, 2) then '{}'::jsonb else '{"actor_type":"staff"}'::jsonb end from generate_series(1, 10) n;
select pg_temp.keep('b1', (select id::text from identity.borrowers where user_id = pg_temp.u(1)));
select pg_temp.keep('b2', (select id::text from identity.borrowers where user_id = pg_temp.u(2)));

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
  ('fdc10000-0000-4000-8000-000000000008', 'fda00000-0000-4000-8000-000000000000', pg_temp.u(8), 'active'),
  ('fdc10000-0000-4000-8000-000000000019', pg_temp.lx(), pg_temp.u(9), 'active'),
  ('fdc10000-0000-4000-8000-000000000020', pg_temp.lx(), pg_temp.u(10), 'active'),
  ('fdc10000-0000-4000-8000-000000000021', pg_temp.ly(), pg_temp.u(9), 'active'),
  ('fdc10000-0000-4000-8000-000000000022', pg_temp.ly(), pg_temp.u(10), 'active');
insert into tenancy.membership_roles (membership_id, role_id)
select g.mid::uuid, r.id from (values
  ('fdc10000-0000-4000-8000-000000000003', 'lender', 'reconciler'), ('fdc10000-0000-4000-8000-000000000004', 'lender', 'viewer'),
  ('fdc10000-0000-4000-8000-000000000005', 'lender', 'payments_admin'), ('fdc10000-0000-4000-8000-000000000006', 'lender', 'reconciler'),
  ('fdc10000-0000-4000-8000-000000000007', 'platform', 'platform_payments_admin'),
  ('fdc10000-0000-4000-8000-000000000019', 'lender', 'lender_admin'), ('fdc10000-0000-4000-8000-000000000020', 'lender', 'product_approver'),
  ('fdc10000-0000-4000-8000-000000000021', 'lender', 'lender_admin'), ('fdc10000-0000-4000-8000-000000000022', 'lender', 'product_approver')) as g (mid, kind, rkey)
join tenancy.roles r on r.org_id is null and r.applies_to = g.kind::tenancy.organization_kind and r.key = g.rkey;
select pg_temp.sample_collection_config(pg_temp.lx(), 'fde10000-0000-4000-8000-000000000001', 'Alpha collections (test)', 'XXXXXX1111');
select pg_temp.sample_collection_config(pg_temp.ly(), 'fde10000-0000-4000-8000-000000000002', 'Beta collections (test)', 'XXXXXX2222');
select pg_temp.keep('cx', pg_temp.cfg(pg_temp.lx())::text);
select pg_temp.keep('cy', pg_temp.cfg(pg_temp.ly())::text);
select pg_temp.keep('tx', pg_temp.tok(pg_temp.lx()));
select pg_temp.keep('ty', pg_temp.tok(pg_temp.ly()));

-- Switches for both lenders: payments, servicing_sync, mandates, statements_noc (the foreclosure quotation).
insert into servicing.feature_change_requests (lender_org_id, feature, enable, mode, status, evidence, requested_by, idempotency_key, decided_by, decided_at, applied_at)
select o.lender, f.feature, true, 'two_person', 'applied', '{"contract_ref":"SAMPLE-FD"}', pg_temp.u(7), 'fd-req-' || f.feature || '-' || right(o.lender::text, 1) || '-0001', pg_temp.u(8), now(), now()
from (values (pg_temp.lx()), (pg_temp.ly())) o (lender) cross join (values ('payments'), ('servicing_sync'), ('mandates'), ('statements_noc')) f (feature);
insert into servicing.lender_features (lender_org_id, feature, enabled, evidence, enabled_by, enabled_at, last_change_request_id)
select r.lender_org_id, r.feature, true, r.evidence, pg_temp.u(8), now(), r.id from servicing.feature_change_requests r;
-- Lender X accepts a part of an installment (from 1,000.00) and a part-prepayment from 2,000.00.
insert into payments.lender_payment_policies (lender_org_id, allow_partial_payments, min_partial_amount_minor, allow_part_prepayment, min_part_prepayment_minor, updated_by)
values (pg_temp.lx(), true, 100000, true, 200000, pg_temp.u(5));

-- Loans 1..23: borrower b1 and lender X, except 21 (b2, X), 22 (b1, Y) and 23 (b2, Y). Every loan: 4,750.00 due in ten days and 1,000.00 overdue (loan 22: nothing overdue).
insert into lending.loan_products (id, lender_org_id, category_key, code, name, status) values
  ('fd900000-0000-4000-8000-000000000001', pg_temp.lx(), 'personal', 'PL-FD', 'X Personal Loan', 'active'),
  ('fd900000-0000-4000-8000-000000000002', pg_temp.ly(), 'personal', 'PL-FD', 'Y Personal Loan', 'active');
insert into lending.loan_product_versions (id, product_id, lender_org_id, version, status, min_amount_minor, max_amount_minor, min_tenure_days, max_tenure_days,
  rate_type, min_annual_rate_bps, max_annual_rate_bps, drafted_by, approved_by, approved_at, effective_from)
select ('fd910000-0000-4000-8000-00000000000' || n)::uuid, ('fd900000-0000-4000-8000-00000000000' || n)::uuid, ('fdb00000-0000-4000-8000-00000000000' || n)::uuid, 1, 'approved',
       1000000, 50000000, 180, 1825, 'fixed', 1400, 2400, pg_temp.u(9), pg_temp.u(10), now(), now()
from generate_series(1, 2) n;
insert into lending.loan_requests (id, borrower_id, category_key, requested_amount_minor, requested_tenure_days, purpose_code, status)
select ('fd700000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, case when n in (21, 23) then pg_temp.got('b2')::uuid else pg_temp.got('b1')::uuid end, 'personal', 5000000, 365, 'education', 'submitted'
from generate_series(1, 23) n;
insert into lending.applications (id, lender_org_id, loan_request_id, borrower_id, product_version_id, status, requested_amount_minor, requested_tenure_days, lender_reference)
select ('fd200000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, case when n in (22, 23) then pg_temp.ly() else pg_temp.lx() end,
       ('fd700000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, case when n in (21, 23) then pg_temp.got('b2')::uuid else pg_temp.got('b1')::uuid end,
       case when n in (22, 23) then 'fd910000-0000-4000-8000-000000000002' else 'fd910000-0000-4000-8000-000000000001' end::uuid, 'disbursed', 5000000, 365, 'SAMPLE-APP-' || n
from generate_series(1, 23) n;
insert into servicing.loan_accounts (id, lender_org_id, application_id, borrower_id, source_system, lms_loan_ref, status, sanctioned_amount_minor)
select pg_temp.lid(n), a.lender_org_id, a.id, a.borrower_id, 'lender_lms', 'SAMPLE-LN-' || n, 'active', 5000000
from lending.applications a, generate_series(1, 23) n where right(a.id::text, 2)::int = n;
insert into servicing.balance_snapshots (lender_org_id, loan_account_id, version, status, outstanding_principal_minor, overdue_principal_minor, overdue_interest_minor,
  penal_charges_minor, other_charges_minor, total_overdue_minor, next_due_on, next_due_minor, days_past_due, source_system, source_record_id, reported_as_of, content_sha256)
select l.lender_org_id, l.id, 1, 'active', 4000000, case when l.lms_loan_ref = 'SAMPLE-LN-22' then 0 else 80000 end, case when l.lms_loan_ref = 'SAMPLE-LN-22' then 0 else 20000 end,
       0, 0, case when l.lms_loan_ref = 'SAMPLE-LN-22' then 0 else 100000 end, current_date + 10, 475000, case when l.lms_loan_ref = 'SAMPLE-LN-22' then 0 else 5 end,
       'file_import', 'SRC-' || l.lms_loan_ref, now() - interval '1 hour', pg_temp.sha('snap-' || l.lms_loan_ref)
from servicing.loan_accounts l;
insert into servicing.schedule_snapshots (id, lender_org_id, loan_account_id, version)
select ('fd500000-0000-4000-8000-0000000000' || lpad(right(l.id::text, 2)::int::text, 2, '0'))::uuid, l.lender_org_id, l.id, 1 from servicing.loan_accounts l;
insert into servicing.schedule_installments (snapshot_id, lender_org_id, seq, due_date, principal_minor, interest_minor)
select s.id, s.lender_org_id, 4, current_date + 10, 400000, 75000 from servicing.schedule_snapshots s;
select pg_temp.as_system();

-- ============================================================================================================================
-- 1. Identity is scoped to the lender (A28, M28, U0, U56, A31)
-- ============================================================================================================================
-- Lender X and lender Y are on the SAME provider and may even receive the same order reference from it.
select pg_temp.mk('s1x', 1, 'installment', 475000, 'order_S1');
select pg_temp.mk('s1y', 22, 'installment', 475000, 'order_S1');
select is((select count(*) from payments.payment_intents where provider_order_ref = 'order_S1'), 2::bigint, 'two lenders on one provider can hold the same provider order reference (it is unique per provider, lender and reference)');
-- Lender Y sends a verified delivery of its own with ids that lender X's genuine capture will also carry.
select is(payments.ingest_provider_delivery(pg_temp.got('ty'), pg_temp.dlv('dlv_s1', 'evt_s1', 'unsupported', 'unmapped', null, null, 'obj_u1')) ->> 'accepted', 'true', 'lender Y''s own verified delivery (unsupported kind) is accepted');
select is(pg_temp.land(pg_temp.lx(), 'evt_s1', 'payment', 'captured', 'order_S1', 475000, 'pay_S1', null, null, '2026-10-15T10:00:00Z', 'dlv_s1'), 'applied:intent_succeeded',
  'lender X''s genuine capture with the SAME delivery id and event id is processed (not acknowledged as a replay and dropped)');
select is((select count(*) from payments.provider_events where provider_event_id = 'evt_s1'), 2::bigint, 'each lender has its own event row for the shared event id');
select is((select outcome || ':' || reason_class from payments.webhook_receipts where delivery_id = 'dlv_s1' and lender_org_id = pg_temp.lx()), 'verified:none', 'lender X''s receipt says verified, not duplicate');
select is((select status::text from payments.payment_intents where id = pg_temp.got('s1x')::uuid), 'succeeded', 'and its intent succeeded');
select is((select status::text from payments.payment_intents where id = pg_temp.got('s1y')::uuid), 'pending', 'while lender Y''s intent is untouched');
select is((select count(distinct source) from ops.seen_webhooks where message_id = 'dlv_s1' and source like 'pc\_%'), 2::bigint, 'the replay store keeps one namespace per payment configuration: the same delivery id is remembered once for each');
-- The same event id with another payload at the OTHER lender never exposes the first lender's event.
select is(pg_temp.land(pg_temp.lx(), 'evt_s3', 'unsupported', 'unmapped', null, null, 'obj_u3'), 'already_applied:finished_earlier', 'lender X stores an authentic ignored event evt_s3 (its processing row is written at ingest)');
select is(payments.ingest_provider_delivery(pg_temp.got('ty'), pg_temp.dlv('dlv_s3y', 'evt_s3', 'unsupported', 'unmapped', null, null, 'obj_u3', null, pg_temp.sha('another-body'))) ->> 'accepted', 'true',
  'lender Y re-using that event id with another payload is accepted');
select is((select count(*) from payments.provider_events where provider_event_id = 'evt_s3' and lender_org_id = pg_temp.ly()), 1::bigint, 'and gets its own event row');
select is((select count(*) from payments.reconciliation_exceptions x join payments.provider_events pe on pe.id::text = x.subject ->> 'event_id' where x.lender_org_id <> pe.lender_org_id), 0::bigint,
  'no exception of one lender names an event of another lender (no cross-tenant identifier in a subject)');
select is((select count(*) from payments.webhook_receipts r join payments.provider_events pe on pe.id = r.event_id where pe.lender_org_id is distinct from r.lender_org_id), 0::bigint, 'and no receipt points at another lender''s event');
select pg_temp.as_owner();
select is(pg_temp.err(format($$insert into payments.webhook_receipts (provider, lender_org_id, config_id, payload_sha256, outcome, reason_class, event_id)
  values ('mock_gateway', %L, %L, repeat('0', 64), 'duplicate', 'replayed_delivery', (select id from payments.provider_events where provider_event_id = 'evt_s1' and lender_org_id = %L))$$,
  pg_temp.ly(), pg_temp.got('cy'), pg_temp.lx())), '23503|', 'the database refuses a receipt of lender Y that points at lender X''s event (composite key)');
select is(pg_temp.err(format($$insert into payments.provider_events (provider, provider_event_id, event_type, lender_org_id, payload_sha256, signature_verified)
  values ('mock_gateway', 'evt_s1', 'payment.captured', %L, repeat('d', 64), true)$$, pg_temp.lx())), '23505|', 'the same event id twice for ONE lender is still a duplicate');
select pg_temp.as_system();
-- The same provider payment reference at both lenders: two payments, neither touches the other.
select is(pg_temp.land(pg_temp.ly(), 'evt_s1p', 'payment', 'captured', 'order_S1', 475000, 'pay_S1'), 'applied:intent_succeeded', 'lender Y captures a payment with the same provider payment reference as lender X''s');
select is((select count(*) from payments.provider_payments where provider_payment_ref = 'pay_S1'), 2::bigint, 'two provider payments, one per lender');
select is((select (status, amount_minor, intent_id = pg_temp.got('s1x')::uuid, duplicate_capture)::text from payments.provider_payments where provider_payment_ref = 'pay_S1' and lender_org_id = pg_temp.lx()), '(captured,475000,t,f)',
  'lender X''s payment row is exactly as it was');
-- The same payment reference under ANOTHER intent of the same lender is never merged.
select pg_temp.mk('c2', 2, 'installment', 475000, 'order_C2');
select pg_temp.mk('c3', 3, 'installment', 475000, 'order_C3');
select is(pg_temp.land(pg_temp.lx(), 'evt_c2a', 'payment', 'authorized', 'order_C2', null, 'pay_C'), 'applied:payment_status_recorded', 'a payment of intent 2 is authorised');
select is(pg_temp.land(pg_temp.lx(), 'evt_c3c', 'payment', 'captured', 'order_C3', 475000, 'pay_C'), 'exception:payment_ref_conflict', 'an event of intent 3 that names the same provider payment reference is an exception, not an update');
select is((select (status, rank, intent_id = pg_temp.got('c2')::uuid)::text from payments.provider_payments where provider_payment_ref = 'pay_C'), '(authorized,20,t)', 'the existing payment row is untouched');
select is((select (severity, owner, status)::text from payments.reconciliation_exceptions where class = 'payment_status_conflict' and subject ->> 'intent_id' = pg_temp.got('c3')), '(warning,platform,open)', 'a platform exception asks the provider which payment it is');
select is((select status::text from payments.payment_intents where id = pg_temp.got('c3')::uuid), 'pending', 'and intent 3 is not succeeded on another intent''s payment');

-- ============================================================================================================================
-- 2. Money integrity of apply_provider_event (M22, M24, M25, A50, M26, M30)
-- ============================================================================================================================
-- M22: a second payment that is authorised first and captured later is a duplicate capture.
select pg_temp.mk('d', 4, 'installment', 475000, 'order_D');
select is(pg_temp.land(pg_temp.lx(), 'evt_d1c', 'payment', 'captured', 'order_D', 475000, 'pay_D1'), 'applied:intent_succeeded', 'the first payment is captured: the intent succeeds');
select is(pg_temp.land(pg_temp.lx(), 'evt_d2a', 'payment', 'authorized', 'order_D', null, 'pay_D2'), 'applied:payment_status_recorded', 'the borrower pays again: the second payment is authorised first');
select is(pg_temp.land(pg_temp.lx(), 'evt_d2c', 'payment', 'captured', 'order_D', 475000, 'pay_D2'), 'exception:duplicate_capture', 'and when it is captured it is recognised as the second capture');
select is((select duplicate_capture from payments.provider_payments where provider_payment_ref = 'pay_D2'), true, 'the row is flagged');
select is(pg_temp.exc('duplicate_payment', pg_temp.got('d')), 1::bigint, 'one duplicate_payment exception is open for the lender');
-- M26: a refund is booked against the payment it names.
select is(pg_temp.land(pg_temp.lx(), 'evt_d2r', 'refund', 'refunded', 'order_D', 475000, 'rfd_D2', null, 'pay_D2'), 'applied:adjustment_recorded', 'the provider refunds the DUPLICATE payment (it names pay_D2)');
select is((select pp.provider_payment_ref from payments.payment_adjustments a join payments.provider_payments pp on pp.id = a.provider_payment_id where a.object_ref = 'rfd_D2'), 'pay_D2',
  'the adjustment is booked against the duplicate, not the payment the borrower meant to keep');
select is(pg_temp.land(pg_temp.lx(), 'evt_d1r', 'refund', 'refunded', 'order_D', 475000, 'rfd_D1', null, 'pay_D1'), 'applied:adjustment_recorded', 'a later full refund of the other payment is accepted: no false mismatch');
select is(pg_temp.land(pg_temp.lx(), 'evt_d9r', 'refund', 'refunded', 'order_D', 1000, 'rfd_D9'), 'exception:ambiguous_payment', 'a refund that names no payment, with two captured payments on the intent, is an exception: nothing is guessed');
select is(pg_temp.exc('refund_unmatched', pg_temp.got('d')), 1::bigint, 'a refund_unmatched exception is open');
select is(pg_temp.land(pg_temp.lx(), 'evt_d8r', 'refund', 'refunded', 'order_D', 1000, 'rfd_D8', null, 'pay_NOPE'), 'deferred:capture_not_seen_yet', 'a refund that names a payment not seen yet waits for it (bounded retries)');
-- M22 the other way round: the second payment is captured FIRST.
select pg_temp.mk('e', 5, 'installment', 475000, 'order_E');
select is(pg_temp.land(pg_temp.lx(), 'evt_e1a', 'payment', 'authorized', 'order_E', null, 'pay_E1'), 'applied:payment_status_recorded', 'payment 1 is only authorised');
select is(pg_temp.land(pg_temp.lx(), 'evt_e2c', 'payment', 'captured', 'order_E', 475000, 'pay_E2'), 'applied:intent_succeeded', 'payment 2 is captured first: it is the genuine capture');
select is(pg_temp.land(pg_temp.lx(), 'evt_e1c', 'payment', 'captured', 'order_E', 475000, 'pay_E1'), 'exception:duplicate_capture', 'payment 1 captured later is the duplicate');
select is((select string_agg(provider_payment_ref || ':' || duplicate_capture, ',' order by provider_payment_ref) from payments.provider_payments where intent_id = pg_temp.got('e')::uuid), 'pay_E1:true,pay_E2:false', 'flagged by order of capture, not by order of first sight');
-- M24: a genuine capture arriving after a higher-ranked non-success status is recorded.
select pg_temp.mk('f', 6, 'installment', 475000, 'order_F');
select is(pg_temp.land(pg_temp.lx(), 'evt_f1e', 'payment', 'expired', 'order_F', null, 'pay_F'), 'applied:payment_status_recorded', 'a payment is reported expired (rank 45)');
select is(pg_temp.land(pg_temp.lx(), 'evt_f1c', 'payment', 'captured', 'order_F', 475000, 'pay_F'), 'applied:intent_succeeded', 'and its late capture (rank 30) is recorded, not dropped as stale: the intent succeeds');
select is((select (status, rank, amount_minor, captured_at is not null)::text from payments.provider_payments where provider_payment_ref = 'pay_F'), '(captured,30,475000,t)', 'the row is captured');
select is(pg_temp.exc('payment_status_conflict', pg_temp.got('f')) + pg_temp.exc('amount_mismatch', pg_temp.got('f')), 0::bigint, 'with no exception: the capture is the truth');
-- M25 / A50: nothing moves a captured payment, whatever the rank.
select pg_temp.mk('g', 7, 'installment', 475000, 'order_G');
select is(pg_temp.land(pg_temp.lx(), 'evt_g1c', 'payment', 'captured', 'order_G', 475000, 'pay_G'), 'applied:intent_succeeded', 'a payment is captured');
select is(pg_temp.land(pg_temp.lx(), 'evt_g1e', 'payment', 'expired', 'order_G', null, 'pay_G'), 'exception:failure_after_success', 'an "expired" event (rank 45, above captured) after the capture is an exception ...');
select is(pg_temp.land(pg_temp.lx(), 'evt_g1x', 'payment', 'cancelled', 'order_G', null, 'pay_G'), 'exception:failure_after_success', '... so is "cancelled" (rank 45) ...');
select is(pg_temp.land(pg_temp.lx(), 'evt_g1r', 'payment', 'refunded', 'order_G', 100000, 'pay_G'), 'exception:reversal_on_payment_object', '... a payment-kind "refunded" for 1,000.00 (rank 40) ...');
select is(pg_temp.land(pg_temp.lx(), 'evt_g1d', 'payment', 'disputed', 'order_G', 475000, 'pay_G'), 'exception:reversal_on_payment_object', '... "disputed" (rank 50) ...');
select is(pg_temp.land(pg_temp.lx(), 'evt_g1t', 'payment', 'returned', 'order_G', 475000, 'pay_G'), 'exception:reversal_on_payment_object', '... and "returned" (a status the table cannot store).');
select is((select (status, rank, amount_minor)::text from payments.provider_payments where provider_payment_ref = 'pay_G'), '(captured,30,475000)', 'the captured payment keeps its status, rank and amount: nothing was overwritten');
select is((select count(*) from payments.payment_adjustments a join payments.provider_payments pp on pp.id = a.provider_payment_id where pp.provider_payment_ref = 'pay_G'), 0::bigint, 'and no adjustment was invented for a status whose amount is unknown');
select is((select count(*) from payments.reconciliation_exceptions where class = 'payment_status_conflict' and subject ->> 'intent_id' = pg_temp.got('g') and not (subject ? 'event_id')), 1::bigint, 'the two failure reports share one open exception for the payment');
select is((select count(*) from payments.reconciliation_exceptions where class = 'payment_status_conflict' and subject ->> 'intent_id' = pg_temp.got('g') and subject ? 'event_id'), 3::bigint, 'and each reversal event has its own, so a person sees every one of them');
select pg_temp.as_user(pg_temp.u(1));
select is((select (intent_status, stage)::text from payments.my_payment(pg_temp.got('g')::uuid)), '(succeeded,needs_attention)', 'the borrower''s stage is needs_attention, not "started"');
select pg_temp.as_system();
select is(pg_temp.land(pg_temp.lx(), 'evt_g1a', 'payment', 'authorized', 'order_G', null, 'pay_G'), 'ignored_stale:lower_rank', 'an earlier step of the same payment arriving late is simply stale');
-- M30: statuses the table cannot store never become a check violation.
select pg_temp.mk('h', 8, 'installment', 475000, 'order_H');
select is(pg_temp.err(format($$select payments.apply_provider_event((select id from payments.provider_events where provider_event_id = 'evt_h1r' and lender_org_id = %L))$$, pg_temp.lx())) || '/' || pg_temp.land(pg_temp.lx(), 'evt_h1r', 'payment', 'rejected', 'order_H', null, 'pay_H'),
  'P0002|/applied:payment_status_recorded', 'a payment the provider REJECTED is applied (recorded like a failure), not retried to death');
select is((select (status, rank)::text from payments.provider_payments where provider_payment_ref = 'pay_H'), '(rejected,25)', 'as a rejected attempt');
select is(pg_temp.land(pg_temp.lx(), 'evt_h1a', 'payment', 'active', 'order_H', null, 'pay_H'), 'already_applied:finished_earlier', 'a mandate-only status ("active") on a payment is stored verified-and-ignored ...');
select is((select outcome || ':' || reason_class from payments.event_processing ep join payments.provider_events pe on pe.id = ep.event_id where pe.provider_event_id = 'evt_h1a' and pe.lender_org_id = pg_temp.lx()), 'ignored_unsupported:unmapped_status', '... with a processing row that says so');
select is(pg_temp.land(pg_temp.lx(), 'evt_h1v', 'payment', 'revoked', 'order_H', null, 'pay_H'), 'already_applied:finished_earlier', '"revoked" the same');
select is(pg_temp.land(pg_temp.lx(), 'evt_h1p', 'refund', 'paused', 'order_H', null, 'rfd_H'), 'already_applied:finished_earlier', '"paused" on a refund the same');
select is((select count(*) from payments.webhook_receipts where delivery_id in ('dlv_evt_h1a', 'dlv_evt_h1v', 'dlv_evt_h1p') and outcome = 'verified_ignored'), 3::bigint, 'each has a verified_ignored receipt');
select is(pg_temp.land(pg_temp.lx(), 'evt_h1t', 'payment', 'returned', 'order_H', 475000, 'pay_Hx'), 'exception:reversal_on_payment_object', 'a "returned" payment with no payment on file opens an exception too (nothing is stored)');
select is((select count(*) from payments.provider_payments where provider_payment_ref = 'pay_Hx'), 0::bigint, 'and no row is stored for it');

-- ============================================================================================================================
-- 3. request_payment guards, expiry, quotation, closed loan, refund-aware stage (M23, M27, M31, M32, A56)
-- ============================================================================================================================
-- M23: an intent whose attempt failed expires and frees its slot.
select pg_temp.mk('i', 9, 'installment', 475000, 'order_I');
select is(pg_temp.land(pg_temp.lx(), 'evt_i1f', 'payment', 'failed', 'order_I', null, 'pay_I'), 'applied:payment_status_recorded', 'a UPI attempt fails');
select pg_temp.as_owner();
set local session_replication_role = replica;
update payments.payment_intents set link_expires_at = now() - interval '2 hours' where id = pg_temp.got('i')::uuid;
set local session_replication_role = origin;
select pg_temp.as_system();
select ok(payments.expire_stale_intents(interval '15 minutes') >= 1, 'the expiry sweep runs');
select is((select status::text from payments.payment_intents where id = pg_temp.got('i')::uuid), 'expired', 'the intent whose only attempt failed is expired once its link ended');
select pg_temp.as_user(pg_temp.u(1));
select ok(pg_temp.try(format($$select payments.request_payment(%L, 'installment', 475000, 'fd-key-i-retry-000000')::text$$, pg_temp.lid(9))) !~ '^error', 'and the borrower can ask to pay the installment again');
select is((select (intent_status, stage)::text from payments.my_payment(pg_temp.got('i')::uuid)), '(expired,started)', 'the expired intent with a failed attempt reads started, not needs_attention');
-- An attempt still in flight holds the intent for a day; a quiet one does not.
select pg_temp.mk('i2', 10, 'installment', 475000, 'order_I2');
select is(pg_temp.land(pg_temp.lx(), 'evt_i2a', 'payment', 'authorized', 'order_I2', null, 'pay_I2'), 'applied:payment_status_recorded', 'an attempt is authorised and its link ends');
select pg_temp.as_owner();
set local session_replication_role = replica;
update payments.payment_intents set link_expires_at = now() - interval '2 hours' where id = pg_temp.got('i2')::uuid;
set local session_replication_role = origin;
select pg_temp.as_system();
select ok(payments.expire_stale_intents(interval '15 minutes') >= 0, 'the sweep runs');
select is((select status::text from payments.payment_intents where id = pg_temp.got('i2')::uuid), 'pending', 'an intent with a recent in-flight attempt is left alone');
select pg_temp.as_owner();
set local session_replication_role = replica;
update payments.provider_payments set updated_at = now() - interval '2 days' where provider_payment_ref = 'pay_I2';
set local session_replication_role = origin;
select pg_temp.as_system();
select ok(payments.expire_stale_intents(interval '15 minutes') >= 1, 'the sweep runs again');
select is((select status::text from payments.payment_intents where id = pg_temp.got('i2')::uuid), 'expired', 'one nobody has heard of for two days expires');
-- M27: a payment the lender's figures cannot reflect yet blocks a second request.
select pg_temp.mk('j', 11, 'installment', 475000, 'order_J');
select is(pg_temp.land(pg_temp.lx(), 'evt_j1c', 'payment', 'captured', 'order_J', 475000, 'pay_J', null, null, to_char(now() - interval '5 minutes', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')), 'applied:intent_succeeded', 'the installment is paid (captured five minutes ago, after the lender''s last report)');
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err(format($$select payments.request_payment(%L, 'installment', 475000, 'fd-key-j-again-000000')$$, pg_temp.lid(11))), '55000|stale_data', 'asking to pay the same installment again is refused until the lender reports');
select is(pg_temp.err(format($$select payments.request_payment(%L, 'overdue', 100000, 'fd-key-j-over-0000000')$$, pg_temp.lid(11))), '55000|stale_data', 'so is the overdue amount that may include it');
select is(pg_temp.err(format($$select payments.request_payment(%L, 'part_prepayment', 300000, 'fd-key-j-prep-0000000')$$, pg_temp.lid(11))), '55000|stale_data', 'and a part-prepayment against a principal that does not show it');
select is((select (o ->> 'stale', jsonb_array_length(o -> 'purposes'))::text from (select payments.my_payment_options(pg_temp.lid(11)) o) x), '(true,0)', 'the options do not offer what request_payment refuses: the figures read as out of date and nothing is offered');
select pg_temp.as_owner();
insert into servicing.balance_snapshots (lender_org_id, loan_account_id, version, status, outstanding_principal_minor, overdue_principal_minor, overdue_interest_minor, penal_charges_minor, other_charges_minor,
  total_overdue_minor, next_due_on, next_due_minor, days_past_due, source_system, source_record_id, reported_as_of, content_sha256)
values (pg_temp.lx(), pg_temp.lid(11), 2, 'active', 3600000, 0, 0, 0, 0, 0, current_date + 40, 475000, 0, 'file_import', 'SRC-J-2', now() - interval '1 minute', pg_temp.sha('snap-j2'));
select pg_temp.as_user(pg_temp.u(1));
select ok(pg_temp.try(format($$select payments.request_payment(%L, 'installment', 475000, 'fd-key-j-after-0000000')::text$$, pg_temp.lid(11))) !~ '^error', 'after the lender''s newer report the next installment can be paid');
-- A fully refunded payment does not block.
select pg_temp.mk('k', 12, 'installment', 475000, 'order_K');
select pg_temp.as_system();
select is(pg_temp.land(pg_temp.lx(), 'evt_k1c', 'payment', 'captured', 'order_K', 475000, 'pay_K', null, null, to_char(now() - interval '5 minutes', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')), 'applied:intent_succeeded', 'a payment is captured ...');
select is(pg_temp.land(pg_temp.lx(), 'evt_k1r', 'refund', 'refunded', 'order_K', 475000, 'rfd_K', null, 'pay_K'), 'applied:adjustment_recorded', '... and refunded in full');
select pg_temp.as_user(pg_temp.u(1));
select is((select (intent_status, stage)::text from payments.my_payment(pg_temp.got('k')::uuid)), '(succeeded,needs_attention)', 'M32: the borrower no longer reads "received by the provider" for a payment that was refunded in full');
select ok(pg_temp.try(format($$select payments.request_payment(%L, 'installment', 475000, 'fd-key-k-again-0000000')::text$$, pg_temp.lid(12))) !~ '^error', 'and may pay again, because the money was returned');
-- A foreclosure quotation made before a payment no longer states what is owed.
select pg_temp.as_owner();
insert into servicing.foreclosure_quotes (lender_org_id, loan_account_id, lender_quote_ref, as_of, valid_until, principal_minor, interest_minor, charges_minor, prepayment_charge_minor, total_minor, source, reported_by)
values (pg_temp.lx(), pg_temp.lid(13), 'SAMPLE-Q-13', now() - interval '1 hour', now() + interval '3 days', 4000000, 75000, 5000, 20000, 4100000, 'lender_portal', pg_temp.u(5));
select pg_temp.mk('l', 13, 'installment', 475000, 'order_L');
select pg_temp.as_system();
select is(pg_temp.land(pg_temp.lx(), 'evt_l1c', 'payment', 'captured', 'order_L', 475000, 'pay_L', null, null, to_char(now() - interval '5 minutes', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')), 'applied:intent_succeeded', 'an installment is paid after the quotation was made');
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err(format($$select payments.request_payment(%L, 'foreclosure', 4100000, 'fd-key-l-forecl-00000')$$, pg_temp.lid(13))), '55000|quote_not_current', 'a foreclosure payment on that quotation is refused (it does not include the payment)');
select is((select count(*) from (select jsonb_array_elements(payments.my_payment_options(pg_temp.lid(13)) -> 'purposes') p) x where p ->> 'purpose' = 'foreclosure'), 0::bigint, 'and the options do not offer it');
-- Overlapping purposes.
select pg_temp.as_owner();
insert into servicing.foreclosure_quotes (lender_org_id, loan_account_id, lender_quote_ref, as_of, valid_until, principal_minor, interest_minor, charges_minor, prepayment_charge_minor, total_minor, source, reported_by)
values (pg_temp.lx(), pg_temp.lid(14), 'SAMPLE-Q-14', now() - interval '1 hour', now() + interval '3 days', 4000000, 75000, 5000, 20000, 4100000, 'lender_portal', pg_temp.u(5));
select pg_temp.as_user(pg_temp.u(1));
select pg_temp.keep('o1', payments.request_payment(pg_temp.lid(14), 'installment', 475000, 'fd-key-o-inst-00000000')::text);
select is(pg_temp.err(format($$select payments.request_payment(%L, 'overdue', 100000, 'fd-key-o-over-00000000')$$, pg_temp.lid(14))), '23505|open_intent_exists', 'an overdue payment is refused while an installment payment is open (the same money in the lender''s figures)');
select is(pg_temp.err(format($$select payments.request_payment(%L, 'foreclosure', 4100000, 'fd-key-o-forecl-000000')$$, pg_temp.lid(14))), '23505|open_intent_exists', 'a foreclosure payment is refused while any other payment of the loan is open');
select ok(pg_temp.try(format($$select payments.request_payment(%L, 'part_prepayment', 300000, 'fd-key-o-prep-00000000')::text$$, pg_temp.lid(14))) !~ '^error', 'a part-prepayment is not the same money and may be open next to an installment');
select pg_temp.as_system();
select pg_temp.as_owner();
set local session_replication_role = replica;
update payments.payment_intents set status = 'expired' where loan_account_id = pg_temp.lid(14);
set local session_replication_role = origin;
select pg_temp.as_user(pg_temp.u(1));
select pg_temp.keep('o2', payments.request_payment(pg_temp.lid(14), 'foreclosure', 4100000, 'fd-key-o-forecl2-00000')::text);
select is(pg_temp.err(format($$select payments.request_payment(%L, 'installment', 475000, 'fd-key-o-inst2-0000000')$$, pg_temp.lid(14))), '23505|open_intent_exists', 'and nothing else is accepted while a foreclosure payment is open');
-- M31: a foreclosure link never outlives its quotation.
select pg_temp.as_owner();
insert into servicing.foreclosure_quotes (lender_org_id, loan_account_id, lender_quote_ref, as_of, valid_until, principal_minor, interest_minor, charges_minor, prepayment_charge_minor, total_minor, source, reported_by)
values (pg_temp.lx(), pg_temp.lid(15), 'SAMPLE-Q-15', now() - interval '1 hour', now() + interval '2 minutes', 4000000, 75000, 5000, 20000, 4100000, 'lender_portal', pg_temp.u(5));
select pg_temp.as_user(pg_temp.u(1));
select pg_temp.keep('q15', payments.request_payment(pg_temp.lid(15), 'foreclosure', 4100000, 'fd-key-q15-0000000000')::text);
select pg_temp.as_system();
select is((select link_expires_at <= (select valid_until from servicing.foreclosure_quotes where lender_quote_ref = 'SAMPLE-Q-15') from payments.payment_intents where id = pg_temp.got('q15')::uuid), true,
  'the provisional link ends no later than the quotation (no five-minute floor)');
select is(payments.record_order_created(pg_temp.got('q15')::uuid, 'order_Q15', now() + interval '1 day'), 'pending', 'the provider offers a link of a whole day ...');
select is((select link_expires_at = (select valid_until from servicing.foreclosure_quotes where lender_quote_ref = 'SAMPLE-Q-15') from payments.payment_intents where id = pg_temp.got('q15')::uuid), true, '... and the intent keeps the quotation''s end instead');
select is(pg_temp.land(pg_temp.lx(), 'evt_q15c', 'payment', 'captured', 'order_Q15', 4100000, 'pay_Q15', null, null, to_char(now() + interval '1 day', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')), 'exception:quote_expired', 'a capture reported after the quotation lapsed is recorded and flagged for the lender');
select is(pg_temp.exc('amount_mismatch', pg_temp.got('q15')), 1::bigint, 'with an amount_mismatch exception: the figure has moved on');
select pg_temp.as_user(pg_temp.u(1));
select is((select stage from payments.my_payment(pg_temp.got('q15')::uuid)), 'needs_attention', 'and the borrower is not told the loan is settled');
-- A56: a closed loan.
select pg_temp.mk('n', 18, 'installment', 475000, 'order_N');
select pg_temp.as_owner();
set local session_replication_role = replica;
update servicing.loan_accounts set status = 'closed' where id = pg_temp.lid(18);
set local session_replication_role = origin;
select pg_temp.as_system();
select is(pg_temp.land(pg_temp.lx(), 'evt_n1c', 'payment', 'captured', 'order_N', 475000, 'pay_N'), 'exception:loan_not_active', 'money that lands on a loan the lender has closed is recorded and raises an exception');
select is(pg_temp.exc('payment_on_closed_intent', pg_temp.got('n')), 1::bigint, 'payment_on_closed_intent is open for the lender (a refund trigger)');
select is((select status::text from payments.payment_intents where id = pg_temp.got('n')::uuid), 'succeeded', 'the provider''s money is on record: the intent is not left pending forever');

-- ============================================================================================================================
-- 4. Hand-off links (A0, U27-U29, U33-U35)
-- ============================================================================================================================
select pg_temp.mk('m', 17, 'installment', 475000, 'order_M');
select pg_temp.as_system();
select is(payments.store_handoff_link('payment_intent', pg_temp.got('m')::uuid, 'v1', pg_temp.bytes(40), now() + interval '1 hour'), 'stored', 'the worker keeps the sealed link of a pending payment');
select pg_temp.as_user(pg_temp.u(1));
select is((select link_available from payments.my_payment_detail(pg_temp.got('m')::uuid)), true, 'control: the borrower can fetch it');
select is((select count(*) from payments.take_handoff_link('payment_intent', pg_temp.got('m')::uuid)), 1::bigint, 'control: and does');
-- U29: money reported on the order.
select pg_temp.mk('p', 19, 'installment', 475000, 'order_P');
select pg_temp.as_system();
select is(payments.store_handoff_link('payment_intent', pg_temp.got('p')::uuid, 'v1', pg_temp.bytes(40), now() + interval '1 hour'), 'stored', 'a link is kept for another payment');
select is(pg_temp.land(pg_temp.lx(), 'evt_p1c', 'payment', 'captured', 'order_P', 400000, 'pay_P'), 'exception:amount_differs', 'the provider reports money of another amount: the intent stays pending');
select pg_temp.as_user(pg_temp.u(1));
select is((select (intent_status, link_available)::text from payments.my_payment_detail(pg_temp.got('p')::uuid)), '(pending,f)', 'the payment detail no longer offers the link (money is on the order)');
select is(pg_temp.err(format($$select * from payments.take_handoff_link('payment_intent', %L)$$, pg_temp.got('p'))), 'P0002|link_unavailable', 'and the link is not handed out: the order could be paid twice');
-- Intent link expiry and the vault row's expiry are separate guards (U33).
select pg_temp.as_owner();
set local session_replication_role = replica;
update payments.payment_intents set link_expires_at = now() - interval '1 minute' where id = pg_temp.got('m')::uuid;
set local session_replication_role = origin;
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err(format($$select * from payments.take_handoff_link('payment_intent', %L)$$, pg_temp.got('m'))), 'P0002|link_unavailable', 'a payment whose own link period ended hands out nothing, even though the vault row has not expired');
select pg_temp.as_owner();
set local session_replication_role = replica;
update payments.payment_intents set link_expires_at = now() + interval '1 hour' where id = pg_temp.got('m')::uuid;
set local session_replication_role = origin;
-- A closed loan (A56).
select pg_temp.as_owner();
set local session_replication_role = replica;
update servicing.loan_accounts set status = 'closed' where id = pg_temp.lid(17);
set local session_replication_role = origin;
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err(format($$select * from payments.take_handoff_link('payment_intent', %L)$$, pg_temp.got('m'))), 'P0002|link_unavailable', 'once the lender reports the loan closed the payment link is withdrawn');
select is((select link_available from payments.my_payment_detail(pg_temp.got('m')::uuid)), false, 'and the detail says so');
select pg_temp.as_system();
select ok(payments.purge_handoff_links() >= 1, 'the purge deletes it');
select pg_temp.as_owner();
set local session_replication_role = replica;
update servicing.loan_accounts set status = 'active' where id = pg_temp.lid(17);
set local session_replication_role = origin;
-- Mandates: a registration-pending mandate with a stored link (rows are written by the owner: the mandate functions belong to another area).
select pg_temp.as_owner();
set local session_replication_role = replica;
insert into payments.mandates (id, lender_org_id, config_id, borrower_id, loan_account_id, rail, status, provider, provider_mode, creditor_ref, provider_mandate_ref, max_amount_minor,
                               start_date, end_date, masked_account_ref, needs_afa_each_debit, handoff_expires_at, created_by)
values (pg_temp.mid(1), pg_temp.lx(), pg_temp.got('cx')::uuid, pg_temp.got('b1')::uuid, pg_temp.lid(20), 'enach_api', 'registration_pending', 'mock_gateway', 'mock', 'SAMPLE-CREDITOR', 'SAMPLE-PM-1', 4000000,
        current_date + 1, current_date + 365, 'XXXXXX9999', false, now() + interval '2 hours', pg_temp.u(1));
set local session_replication_role = origin;
select pg_temp.as_system();
select is(payments.store_handoff_link('mandate', pg_temp.mid(1), 'v1', pg_temp.bytes(40), now() + interval '2 hours'), 'stored', 'the worker keeps the authorisation link of the mandate');
select pg_temp.as_user(pg_temp.u(1));
select is((select count(*) from payments.take_handoff_link('mandate', pg_temp.mid(1))), 1::bigint, 'control: the borrower can fetch it');
select pg_temp.as_user(pg_temp.u(2));
select is(pg_temp.err(format($$select * from payments.take_handoff_link('mandate', %L)$$, pg_temp.mid(1))), 'P0002|link_unavailable', 'another borrower cannot (cross-borrower negative)');
-- Mandate hand-off expiry (U33).
select pg_temp.as_owner();
set local session_replication_role = replica;
update payments.mandates set handoff_expires_at = now() - interval '1 minute' where id = pg_temp.mid(1);
set local session_replication_role = origin;
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err(format($$select * from payments.take_handoff_link('mandate', %L)$$, pg_temp.mid(1))), 'P0002|link_unavailable', 'a mandate whose hand-off period ended hands out nothing, though the vault row is still valid');
select pg_temp.as_owner();
set local session_replication_role = replica;
update payments.mandates set handoff_expires_at = now() + interval '2 hours' where id = pg_temp.mid(1);
set local session_replication_role = origin;
-- U28: the borrower asked to cancel the mandate.
select pg_temp.as_owner();
set local session_replication_role = replica;
update payments.mandates set cancel_requested_at = now(), cancel_reason = 'borrower' where id = pg_temp.mid(1);
set local session_replication_role = origin;
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err(format($$select * from payments.take_handoff_link('mandate', %L)$$, pg_temp.mid(1))), 'P0002|link_unavailable', 'after the borrower asked to cancel the mandate its authorisation link is withdrawn');
select pg_temp.as_system();
select ok(payments.purge_handoff_links() >= 1, 'and the purge deletes it');
-- U33: the switch that matters is the mandates switch for a mandate link, the payments switch for a payment link.
select pg_temp.as_owner();
set local session_replication_role = replica;
update payments.mandates set cancel_requested_at = null, cancel_reason = null where id = pg_temp.mid(1);
set local session_replication_role = origin;
select pg_temp.as_system();
select is(payments.store_handoff_link('mandate', pg_temp.mid(1), 'v1', pg_temp.bytes(40), now() + interval '2 hours'), 'stored', 'the mandate link is stored again');
select is(payments.store_handoff_link('payment_intent', pg_temp.got('m')::uuid, 'v1', pg_temp.bytes(40), now() + interval '2 hours'), 'stored', 'and so is the payment link');
select pg_temp.as_owner();
set local session_replication_role = replica;
update servicing.lender_features set enabled = false where lender_org_id = pg_temp.lx() and feature = 'mandates';
set local session_replication_role = origin;
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err(format($$select * from payments.take_handoff_link('mandate', %L)$$, pg_temp.mid(1))), 'P0002|link_unavailable', 'with the mandates switch off a mandate link is not handed out ...');
select is((select count(*) from payments.take_handoff_link('payment_intent', pg_temp.got('m')::uuid)), 1::bigint, '... while the payment link (payments switch on) still is');
select pg_temp.as_owner();
set local session_replication_role = replica;
update servicing.lender_features set enabled = true where lender_org_id = pg_temp.lx() and feature = 'mandates';
update servicing.lender_features set enabled = false where lender_org_id = pg_temp.lx() and feature = 'payments';
set local session_replication_role = origin;
select pg_temp.as_user(pg_temp.u(1));
select is((select count(*) from payments.take_handoff_link('mandate', pg_temp.mid(1))), 1::bigint, 'with the payments switch off the mandate link (mandates switch on) is still handed out ...');
select is(pg_temp.err(format($$select * from payments.take_handoff_link('payment_intent', %L)$$, pg_temp.got('m'))), 'P0002|link_unavailable', '... and the payment link is not');
select pg_temp.as_owner();
set local session_replication_role = replica;
update servicing.lender_features set enabled = true where lender_org_id = pg_temp.lx() and feature = 'payments';
set local session_replication_role = origin;
-- U33: the in-function system-role guard (the grant is added for the test, so only the guard can refuse).
select pg_temp.as_owner();
grant execute on function payments.store_handoff_link(text, uuid, text, bytea, timestamptz), payments.purge_handoff_links() to authenticated;
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err(format($$select payments.store_handoff_link('payment_intent', %L, 'v1', pg_temp.bytes(40), now() + interval '1 hour')$$, pg_temp.got('m'))), '42501|', 'a signed-in borrower who is allowed to EXECUTE store_handoff_link is still refused by the function''s own system-role check');
select is(pg_temp.err($$select payments.purge_handoff_links()$$), '42501|', 'and purge_handoff_links the same');
select pg_temp.as_owner();
revoke execute on function payments.store_handoff_link(text, uuid, text, bytea, timestamptz), payments.purge_handoff_links() from authenticated;
-- U34: no clear text in the vault.
select pg_temp.as_system();
select is(pg_temp.err(format($$select payments.store_handoff_link('payment_intent', %L, 'v1', convert_to('https://checkout.example.test/pay/abcdef123456', 'UTF8'), now() + interval '1 hour')$$, pg_temp.got('m'))), '22023|bad_request',
  'a clear link (a blob of printable characters) is refused by the vault');
select is(pg_temp.err(format($$select payments.store_handoff_link('payment_intent', %L, 'k1234567890123456789', pg_temp.bytes(40), now() + interval '1 hour')$$, pg_temp.got('m'))), '22023|bad_request', 'so is a key version longer than 16 characters (it is copied into the audit log)');
select is(pg_temp.err(format($$select payments.store_handoff_link('payment_intent', %L, 'ABCDEF123456789', pg_temp.bytes(40), now() + interval '1 hour')$$, pg_temp.got('m'))), '22023|bad_request', 'or one that carries a nine-digit number');
select is(pg_temp.err(format($$select payments.store_handoff_link('payment_intent', %L, 'v2', pg_temp.bytes(40), now() + interval '1 hour')$$, pg_temp.got('m'))), 'ok', 'while a normal sealed blob and key version are stored');
-- U35: the subject is a real key.
select pg_temp.as_owner();
select is(pg_temp.err(format($$insert into payments.handoff_links (lender_org_id, borrower_id, subject_kind, subject_id, key_version, ciphertext, expires_at)
  values (%L, %L, 'payment_intent', %L, 'v1', pg_temp.bytes(40), now() + interval '1 hour')$$, pg_temp.ly(), pg_temp.got('b1'), pg_temp.got('p'))), '23514|', 'a vault row naming lender Y for lender X''s payment is refused');
select is(pg_temp.err(format($$insert into payments.handoff_links (lender_org_id, borrower_id, subject_kind, subject_id, key_version, ciphertext, expires_at)
  values (%L, %L, 'payment_intent', %L, 'v1', pg_temp.bytes(40), now() + interval '1 hour')$$, pg_temp.lx(), pg_temp.got('b2'), pg_temp.got('p'))), '23514|', 'one naming another borrower for the payment is refused');
select is(pg_temp.err(format($$insert into payments.handoff_links (lender_org_id, borrower_id, subject_kind, subject_id, key_version, ciphertext, expires_at)
  values (%L, %L, 'mandate', %L, 'v1', pg_temp.bytes(40), now() + interval '1 hour')$$, pg_temp.ly(), pg_temp.got('b1'), pg_temp.mid(1))), '23514|', 'and so is one naming lender Y for lender X''s mandate');
select is(pg_temp.err(format($$insert into payments.handoff_links (lender_org_id, borrower_id, subject_kind, subject_id, key_version, ciphertext, expires_at)
  values (%L, %L, 'payment_intent', gen_random_uuid(), 'v1', pg_temp.bytes(40), now() + interval '1 hour')$$, pg_temp.lx(), pg_temp.got('b1'))), '23514|', 'a subject that does not exist is refused');
-- Without the trigger the composite keys alone still refuse the same rows.
select pg_temp.run('alter table payments.handoff_links disable trigger consistent');
delete from payments.handoff_links where subject_kind = 'mandate' and subject_id = pg_temp.mid(1);
select is(pg_temp.err(format($$insert into payments.handoff_links (lender_org_id, borrower_id, subject_kind, subject_id, key_version, ciphertext, expires_at)
  values (%L, %L, 'payment_intent', %L, 'v1', pg_temp.bytes(40), now() + interval '1 hour')$$, pg_temp.ly(), pg_temp.got('b1'), pg_temp.got('p'))), '23503|', 'the composite key (payment, lender) refuses lender Y for lender X''s payment on its own');
select is(pg_temp.err(format($$insert into payments.handoff_links (lender_org_id, borrower_id, subject_kind, subject_id, key_version, ciphertext, expires_at)
  values (%L, %L, 'mandate', %L, 'v1', pg_temp.bytes(40), now() + interval '1 hour')$$, pg_temp.ly(), pg_temp.got('b1'), pg_temp.mid(1))), '23503|', 'the composite key (mandate, lender) does the same for a mandate');
select is(pg_temp.err(format($$insert into payments.handoff_links (lender_org_id, borrower_id, subject_kind, subject_id, key_version, ciphertext, expires_at)
  values (%L, %L, 'payment_intent', gen_random_uuid(), 'v1', pg_temp.bytes(40), now() + interval '1 hour')$$, pg_temp.lx(), pg_temp.got('b1'))), '23503|', 'and a subject that does not exist');
select pg_temp.run('alter table payments.handoff_links enable trigger consistent');

-- U31: the borrower cancels while the worker is asking the provider for the order (lender X, loan 16).
select pg_temp.as_user(pg_temp.u(1));
select pg_temp.keep('r', payments.request_payment(pg_temp.lid(16), 'installment', 475000, 'fd-key-r-00000000000')::text);
select is(payments.cancel_my_payment(pg_temp.got('r')::uuid), 'cancelled', 'the borrower cancels a payment that has no order yet');
select pg_temp.as_system();
select is(pg_temp.try(format($$select payments.record_order_created(%L, 'order_R', now() + interval '1 hour')$$, pg_temp.got('r'))), 'cancelled', 'the worker, which had already created the order at the provider, records it: the intent stays cancelled');
select is((select (status::text, provider_order_ref)::text from payments.payment_intents where id = pg_temp.got('r')::uuid), '(cancelled,order_R)', 'the order reference is kept on the closed intent');
select is((select (severity, owner, status)::text from payments.reconciliation_exceptions where class = 'payment_status_conflict' and subject ->> 'intent_id' = pg_temp.got('r')), '(warning,platform,open)', 'a platform exception names the order that must be voided or ignored');
select is(pg_temp.try(format($$select payments.record_order_created(%L, 'order_R', now() + interval '1 hour')$$, pg_temp.got('r'))), 'cancelled', 'recording it again is idempotent');
select is(pg_temp.exc('payment_status_conflict', pg_temp.got('r')), 1::bigint, 'with a single exception');
select pg_temp.as_user(pg_temp.u(1));
select is((select (intent_status, stage)::text from payments.my_payment(pg_temp.got('r')::uuid)), '(cancelled,started)', 'the borrower, who cancelled, is not told that something needs attention');
select pg_temp.as_system();
select is(pg_temp.land(pg_temp.lx(), 'evt_r1c', 'payment', 'captured', 'order_R', 475000, 'pay_R'), 'exception:intent_closed', 'money paid on that orphan order finds the intent and raises payment_on_closed_intent');
select is(pg_temp.exc('payment_on_closed_intent', pg_temp.got('r')), 1::bigint, 'for the lender');

-- U36: a lender receipt the lender itself contradicts is not a posting (loan 21, borrower b2).
select pg_temp.mk('t', 21, 'installment', 475000, 'order_T', 2);
select is(pg_temp.land(pg_temp.lx(), 'evt_t1c', 'payment', 'captured', 'order_T', 475000, 'pay_T'), 'applied:intent_succeeded', 'a payment is captured');
select pg_temp.as_owner();
insert into servicing.lms_receipts (lender_org_id, loan_account_id, kind, lms_receipt_ref, amount_minor, value_date, payment_mode, bank_reference, source_system, source_record_id, reported_as_of, content_sha256)
values (pg_temp.lx(), pg_temp.lid(21), 'receipt', 'RC-FD-1', 475000, current_date, 'upi', 'pay_T', 'file_import', 'SRC-RC-FD-1', clock_timestamp(), pg_temp.sha('rc-fd-1'));
select pg_temp.as_user(pg_temp.u(2));
select is((select stage from payments.my_payment(pg_temp.got('t')::uuid)), 'lender_posted', 'control: the lender''s receipt carries the provider reference: lender_posted');
select is((select count(*) from servicing.my_loan_activity(pg_temp.lid(21)) where entry_kind = 'lender_receipt'), 1::bigint, 'control: the receipt is in the activity');
select pg_temp.as_owner();
set local session_replication_role = replica;
insert into servicing.sync_conflicts (lender_org_id, loan_account_id, record_type, conflict_reason, source_record_id, existing_ref_id, existing_content_sha256, existing_reported_as_of, incoming_content_sha256,
  incoming_reported_as_of, incoming_report, source_system)
select pg_temp.lx(), pg_temp.lid(21), 'receipt', 'receipt_differs', 'SRC-RC-FD-1', r.id, r.content_sha256, now() - interval '2 hours', pg_temp.sha('rc-fd-1-other'), now() - interval '1 hour', '{}'::jsonb, 'file_import'
from servicing.lms_receipts r where r.lms_receipt_ref = 'RC-FD-1';
set local session_replication_role = origin;
select pg_temp.as_user(pg_temp.u(2));
select is((select stage from payments.my_payment(pg_temp.got('t')::uuid)), 'provider_received', 'the lender then contradicts the receipt (an unresolved conflict): the stage is no longer lender_posted');
select is((select count(*) from servicing.my_loan_activity(pg_temp.lid(21)) where entry_kind = 'lender_receipt'), 0::bigint, 'and the activity withholds the receipt, like a disputed schedule');
select pg_temp.as_owner();
set local session_replication_role = replica;
delete from servicing.sync_conflicts where loan_account_id = pg_temp.lid(21);
set local session_replication_role = origin;
select pg_temp.as_user(pg_temp.u(2));
select is((select stage from payments.my_payment(pg_temp.got('t')::uuid)), 'lender_posted', 'once the conflict is gone the receipt counts again');

-- U32: the approved penal-charge sentence is the lender's own, approved only, and only when something is overdue (loans 21 X overdue, 23 Y overdue, 22 Y not overdue).
select pg_temp.as_owner();
set local session_replication_role = replica;
insert into servicing.penal_charge_texts (lender_org_id, version, status, charge_kind, flat_amount_minor, separate_from_interest, not_compounded, reason, sentence_en, drafted_by, approved_by, approved_at, retired_by, retired_at)
values (pg_temp.lx(), 1, 'retired', 'flat', 50000, true, true, 'Old charge as per the loan agreement', 'The old Alpha penal charge applies to the overdue amount.', pg_temp.u(3), pg_temp.u(4), now() - interval '2 days', pg_temp.u(4), now() - interval '1 day'),
       (pg_temp.lx(), 2, 'draft', 'flat', 60000, true, true, 'Draft charge as per the loan agreement', 'A draft Alpha penal charge applies to the overdue amount.', pg_temp.u(3), null, null, null, null),
       (pg_temp.ly(), 1, 'approved', 'flat', 70000, true, true, 'Charge as per the loan agreement', 'Beta adds a separate penal charge on the overdue amount as per your loan agreement.', pg_temp.u(3), pg_temp.u(4), now(), null, null);
set local session_replication_role = origin;
select pg_temp.as_user(pg_temp.u(2));
select is((select (o ->> 'penal_charge_text_missing', o ->> 'penal_charge')::text from (select payments.my_payment_options(pg_temp.lid(21)) o) x), '(true,)',
  'lender X has only a retired and a draft sentence: none is shown and the answer says the approved text is missing');
select is((select o #>> '{penal_charge,sentence_en}' from (select payments.my_payment_options(pg_temp.lid(23)) o) x), 'Beta adds a separate penal charge on the overdue amount as per your loan agreement.',
  'lender Y''s overdue loan shows lender Y''s approved sentence');
select pg_temp.as_owner();
set local session_replication_role = replica;
insert into servicing.penal_charge_texts (lender_org_id, version, status, charge_kind, flat_amount_minor, separate_from_interest, not_compounded, reason, sentence_en, drafted_by, approved_by, approved_at)
values (pg_temp.lx(), 3, 'approved', 'flat', 50000, true, true, 'Charge as per the loan agreement', 'A separate penal charge applies to the overdue amount as per your loan agreement.', pg_temp.u(3), pg_temp.u(4), now());
set local session_replication_role = origin;
select pg_temp.as_user(pg_temp.u(2));
select is((select o #>> '{penal_charge,sentence_en}' from (select payments.my_payment_options(pg_temp.lid(21)) o) x), 'A separate penal charge applies to the overdue amount as per your loan agreement.',
  'once lender X approves a sentence its overdue loan shows exactly that one (never the retired or draft text, never lender Y''s)');
select is((select o #>> '{penal_charge,version}' from (select payments.my_payment_options(pg_temp.lid(21)) o) x), '3', 'the approved version');
select is((select o #>> '{penal_charge,sentence_en}' from (select payments.my_payment_options(pg_temp.lid(23)) o) x), 'Beta adds a separate penal charge on the overdue amount as per your loan agreement.',
  'and lender Y''s loan still shows lender Y''s sentence, not lender X''s');
select pg_temp.as_user(pg_temp.u(1));
select is((select (o ->> 'penal_charge', o ->> 'penal_charge_text_missing')::text from (select payments.my_payment_options(pg_temp.lid(22)) o) x), '(,false)', 'a loan with nothing overdue shows no penal-charge sentence although its lender has an approved one');

-- U30: nothing is offered that request_payment can never accept. Lender X's part-prepayment minimum is raised above the reported principal (4,000,000).
select pg_temp.as_user(pg_temp.u(5));
select is(payments.set_payment_policy(pg_temp.lx(), true, 100000, true, 6000000, 90), 'set', 'lender X sets a part-prepayment minimum of 60,000.00 (above the reported outstanding principal of 40,000.00)');
select pg_temp.as_user(pg_temp.u(2));
select is((select count(*) from (select jsonb_array_elements(payments.my_payment_options(pg_temp.lid(21)) -> 'purposes') p) x where p ->> 'purpose' = 'part_prepayment'), 0::bigint, 'a part-prepayment whose minimum exceeds its maximum is not offered');
select is(pg_temp.err(format($$select payments.request_payment(%L, 'part_prepayment', 4000000, 'fd-key-u30-0000000000')$$, pg_temp.lid(21))), '22023|amount_not_allowed', 'and request_payment refuses every amount (the maximum is below the minimum)');
select pg_temp.as_user(pg_temp.u(5));
select is(payments.set_payment_policy(pg_temp.lx(), true, 100000, true, 200000, 90), 'set', 'the minimum is put back');
select pg_temp.as_user(pg_temp.u(2));
select is((select count(*) from (select jsonb_array_elements(payments.my_payment_options(pg_temp.lid(21)) -> 'purposes') p) x where p ->> 'purpose' = 'part_prepayment'), 1::bigint, 'and the part-prepayment is offered again');

-- The provider payment row cannot be edited out of success even by the owner (defence in depth).
select pg_temp.as_owner();
select is(pg_temp.err($$update payments.provider_payments set status = 'expired' where provider_payment_ref = 'pay_G'$$), 'P0001|', 'a captured provider payment cannot be moved off success');
select is(pg_temp.err($$update payments.provider_payments set amount_minor = 1 where provider_payment_ref = 'pay_G'$$), 'P0001|', 'its captured amount cannot change');
select is(pg_temp.err($$update payments.provider_payments set duplicate_capture = false where provider_payment_ref = 'pay_D2'$$), 'P0001|', 'and a duplicate flag cannot be removed');
select is((select count(*) from information_schema.columns where table_schema = 'payments' and table_name = 'provider_events' and column_name = 'parent_payment_ref'), 1::bigint, 'the event keeps the provider''s reference of the payment a refund concerns');

-- U27 / A0: the payment kill switch withdraws the links already issued (lender Y). Its intent and its mandate hold stored links.
select pg_temp.mk('y2', 22, 'installment', 475000, 'order_Y2');
select pg_temp.as_owner();
set local session_replication_role = replica;
insert into payments.mandates (id, lender_org_id, config_id, borrower_id, loan_account_id, rail, status, provider, provider_mode, creditor_ref, provider_mandate_ref, max_amount_minor,
                               start_date, end_date, masked_account_ref, needs_afa_each_debit, handoff_expires_at, created_by)
values (pg_temp.mid(2), pg_temp.ly(), pg_temp.got('cy')::uuid, pg_temp.got('b2')::uuid, pg_temp.lid(23), 'enach_api', 'registration_pending', 'mock_gateway', 'mock', 'SAMPLE-CREDITOR', 'SAMPLE-PM-2', 4000000,
        current_date + 1, current_date + 365, 'XXXXXX8888', false, now() + interval '2 hours', pg_temp.u(2));
set local session_replication_role = origin;
select pg_temp.as_system();
select is(payments.store_handoff_link('payment_intent', pg_temp.got('y2')::uuid, 'v1', pg_temp.bytes(40), now() + interval '1 hour'), 'stored', 'lender Y: the sealed link of a pending payment is kept');
select is(payments.store_handoff_link('mandate', pg_temp.mid(2), 'v1', pg_temp.bytes(40), now() + interval '1 hour'), 'stored', 'and the authorisation link of a registration-pending mandate');
select pg_temp.as_user(pg_temp.u(1));
select is((select count(*) from payments.take_handoff_link('payment_intent', pg_temp.got('y2')::uuid)), 1::bigint, 'control: the borrower can fetch the payment link');
select pg_temp.as_user(pg_temp.u(2));
select is((select count(*) from payments.take_handoff_link('mandate', pg_temp.mid(2))), 1::bigint, 'control: and the other borrower the mandate link');
select pg_temp.as_system();
select is(payments.system_suspend_payment_config(pg_temp.got('cy')::uuid, 'settlement_account_mismatch'), 'suspended', 'the platform suspends lender Y''s payment configuration (a kill switch)');
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err(format($$select payments.request_payment(%L, 'part_prepayment', 300000, 'fd-key-y-after-000000')$$, pg_temp.lid(22))), '55000|collection_target_invalid', 'new payments are refused (the existing kill switch)');
select is(pg_temp.err(format($$select * from payments.take_handoff_link('payment_intent', %L)$$, pg_temp.got('y2'))), 'P0002|link_unavailable', 'and the payment link already issued is no longer handed out');
select is((select link_available from payments.my_payment_detail(pg_temp.got('y2')::uuid)), false, 'the payment detail does not offer it either');
select pg_temp.as_user(pg_temp.u(2));
select is(pg_temp.err(format($$select * from payments.take_handoff_link('mandate', %L)$$, pg_temp.mid(2))), 'P0002|link_unavailable', 'nor the mandate authorisation link');
select pg_temp.as_system();
select is(payments.purge_handoff_links(), 2, 'the purge deletes both rows of the suspended configuration');
select is(pg_temp.out_ing(pg_temp.got('ty'), 'dlv_y_late', 'evt_y_late', 'order_Y2'), 'rejected', 'a verified delivery for the suspended configuration is answered like an unknown token (the database cannot tell it from garbage; it is only a receipt)');
select is((select outcome || ':' || reason_class from payments.webhook_receipts where delivery_id = 'dlv_y_late'), 'unmatched:token_unknown_or_inactive', 'recorded against no lender');
-- U27: a configuration that is still marked ACTIVE but is no longer a valid collection target (lender X: its settlement account is not verified any more) withdraws links too.
select is(payments.store_handoff_link('payment_intent', pg_temp.got('m')::uuid, 'v1', pg_temp.bytes(40), now() + interval '1 hour'), 'stored', 'lender X: the link of a pending payment is kept again');
select pg_temp.as_user(pg_temp.u(1));
select is((select count(*) from payments.take_handoff_link('payment_intent', pg_temp.got('m')::uuid)), 1::bigint, 'control: it is handed out');
select pg_temp.as_owner();
set local session_replication_role = replica;
update tenancy.lender_settlement_accounts set status = 'unverified' where id = 'fde10000-0000-4000-8000-000000000001';
set local session_replication_role = origin;
select is((select status from payments.lender_payment_configs where id = pg_temp.got('cx')::uuid), 'active', 'the configuration still reads active ...');
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err(format($$select * from payments.take_handoff_link('payment_intent', %L)$$, pg_temp.got('m'))), 'P0002|link_unavailable', '... but its settlement account is not verified, so it is not a valid collection target and the link is withdrawn');
select is((select link_available from payments.my_payment_detail(pg_temp.got('m')::uuid)), false, 'and the payment detail does not offer it');

-- A9 / M29: exception evidence and notes (lender X exceptions; reconciler u3 has payment.reconcile).
select pg_temp.as_system();
select pg_temp.keep('x1', payments.raise_exception(pg_temp.lx(), 'stale_sync', 'warning', 'lender', jsonb_build_object('loan_account_id', pg_temp.lid(1)))::text);
select pg_temp.as_user(pg_temp.u(3));
select is(pg_temp.err(format($$select payments.resolve_exception(%L, 'no_action_needed', '["ABCDE1234F"]'::jsonb)$$, pg_temp.got('x1'))), '22023|evidence_required', 'evidence that is a PAN is refused');
select is(pg_temp.err(format($$select payments.resolve_exception(%L, 'no_action_needed', '["9876543210"]'::jsonb)$$, pg_temp.got('x1'))), '22023|evidence_required', 'a phone number');
select is(pg_temp.err(format($$select payments.resolve_exception(%L, 'no_action_needed', '["234123412346"]'::jsonb)$$, pg_temp.got('x1'))), '22023|evidence_required', 'an Aadhaar-shaped number');
select is(pg_temp.err(format($$select payments.resolve_exception(%L, 'no_action_needed', '["50100123456789"]'::jsonb)$$, pg_temp.got('x1'))), '22023|evidence_required', 'an account number');
select is(pg_temp.err(format($$select payments.resolve_exception(%L, 'no_action_needed', '["Ramesh.Kumar.Sharma"]'::jsonb)$$, pg_temp.got('x1'))), '22023|evidence_required', 'a name written as a label (no number in it: not a reference code)');
select is(pg_temp.err(format($$select payments.resolve_exception(%L, 'no_action_needed', '["RC-1234-56789"]'::jsonb)$$, pg_temp.got('x1'))), '22023|evidence_required', 'a code that hides a long number behind separators');
select is(pg_temp.err(format($$select payments.resolve_exception(%L, 'no_action_needed', '["bit.ly/abc1"]'::jsonb)$$, pg_temp.got('x1'))), '22023|evidence_required', 'a web address');
select is(pg_temp.err(format($$select payments.resolve_exception(%L, 'no_action_needed', '["RC-SAMPLE-3", "ABCDE1234F"]'::jsonb)$$, pg_temp.got('x1'))), '22023|evidence_required', 'and one bad element among good ones');
select is(pg_temp.err(format($$select payments.resolve_exception(%L, 'no_action_needed', '["RC-SAMPLE-3"]'::jsonb, 'credit seen in account 50100123456789 today')$$, pg_temp.got('x1'))), '22023|unsafe_free_text', 'a note with an account number is refused');
select is(pg_temp.err(format($$select payments.resolve_exception(%L, 'no_action_needed', '["RC-SAMPLE-3"]'::jsonb, 'call 98765 43210 now')$$, pg_temp.got('x1'))), '22023|unsafe_free_text', 'a note with a phone number written with a space');
select is(pg_temp.err(format($$select payments.resolve_exception(%L, 'no_action_needed', '["RC-SAMPLE-3"]'::jsonb, 'open https://checkout/abc')$$, pg_temp.got('x1'))), '22023|unsafe_free_text', 'a note with a web address (https)');
select is(pg_temp.err(format($$select payments.resolve_exception(%L, 'no_action_needed', '["RC-SAMPLE-3"]'::jsonb, 'open www.checkout')$$, pg_temp.got('x1'))), '22023|unsafe_free_text', 'a note with a www address');
select is(pg_temp.err(format($$select payments.resolve_exception(%L, 'no_action_needed', '["RC-SAMPLE-3"]'::jsonb, 'visit example.com')$$, pg_temp.got('x1'))), '22023|unsafe_free_text', 'a note with a domain name');
select is(pg_temp.err(format($$select payments.resolve_exception(%L, 'no_action_needed', '["RC-SAMPLE-3"]'::jsonb, 'mail someone@host')$$, pg_temp.got('x1'))), '22023|unsafe_free_text', 'a note with an e-mail address');
select is(payments.resolve_exception(pg_temp.got('x1')::uuid, 'no_action_needed', jsonb_build_array('RC-SAMPLE-3', 'pay_1b', 'TKT-12345678', pg_temp.got('x1')), 'checked the receipt, 12 items'), 'resolved',
  'record ids, short codes (up to eight digits) and a short plain note are accepted');
select is(pg_temp.err(format($$select payments.reopen_exception(%L, 'new_information', 'again 9876543210')$$, pg_temp.got('x1'))), '22023|unsafe_free_text', 'a reopen note is screened too');
select is(payments.reopen_exception(pg_temp.got('x1')::uuid, 'new_information', 'the provider replied'), 'reopened', 'a plain reopen note is accepted');
select pg_temp.as_user(pg_temp.u(6));
select is(pg_temp.err(format($$select payments.resolve_exception(%L, 'no_action_needed', '["RC-SAMPLE-3"]'::jsonb)$$, pg_temp.got('x1'))), 'P0002|', 'lender Y''s reconciler cannot act on lender X''s exception (not found, no oracle)');
select is((select count(*) from payments.reconciliation_exceptions where lender_org_id = pg_temp.lx()), 0::bigint, 'and sees none of lender X''s exceptions');
select pg_temp.as_owner();
select is(pg_temp.err(format($$insert into payments.reconciliation_exception_events (exception_id, lender_org_id, action, actor_kind, actor_user_id, reason_code, evidence, authorised_by_permission)
  values (%L, %L, 'resolved', 'lender_user', %L, 'no_action_needed', '["ABCDE1234F"]', 'payment.reconcile')$$, pg_temp.got('x1'), pg_temp.lx(), pg_temp.u(3))), '23514|', 'the table itself refuses a PAN as evidence, whoever writes it');
select is(pg_temp.err(format($$insert into payments.reconciliation_exception_events (exception_id, lender_org_id, action, actor_kind, actor_user_id, reason_code, note, authorised_by_permission)
  values (%L, %L, 'reopened', 'lender_user', %L, 'new_information', 'account 50100123456789 again', 'payment.reconcile')$$, pg_temp.got('x1'), pg_temp.lx(), pg_temp.u(3))), '23514|', 'and a note with an account number');
select is((select bool_and(not convalidated) from pg_constraint where conname in ('reconciliation_exception_events_evidence_screened', 'reconciliation_exception_events_note_screened')), true,
  'the new checks are NOT VALID: they apply to new rows, and history stored under the old rule is neither rewritten nor made unreadable');

select * from finish();
rollback;
