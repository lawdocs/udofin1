-- Phase 08a review-fix wave, area SM (migration 20261018000921): mandates, debits and pre-debit notices.
-- Each section names the finding it pins down. Every assertion here fails against the migrations before 921 (or errors out), except the
-- negative controls that say so. Synthetic data only (labelled SAMPLE). Error codes are reported as SQLSTATE|hint.
begin;
create extension if not exists pgtap with schema extensions;
select plan(228);

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
create function pg_temp.keep(k text, v text) returns text language sql as $fn$ select set_config('t.' || k, v, true) $fn$;
create function pg_temp.got(k text) returns text language sql as $fn$ select current_setting('t.' || k) $fn$;
create function pg_temp.u(n integer) returns uuid language sql as $fn$ select ('fd000000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid $fn$;
create function pg_temp.sha(k text) returns text language sql as $fn$ select encode(sha256(convert_to('SAMPLE-025-' || k, 'UTF8')), 'hex') $fn$;
create function pg_temp.tok(p_lender uuid) returns text language sql as $fn$ select encode(sha256(convert_to('SAMPLE-TOKEN-' || p_lender::text, 'UTF8')), 'hex') $fn$;
create function pg_temp.lx() returns uuid language sql as $fn$ select 'fdb00000-0000-4000-8000-000000000001'::uuid $fn$;
create function pg_temp.lz() returns uuid language sql as $fn$ select 'fdb00000-0000-4000-8000-000000000002'::uuid $fn$;
create function pg_temp.lid(n integer) returns uuid language sql as $fn$ select ('fd400000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid $fn$;
create function pg_temp.mid(n integer) returns uuid language sql as $fn$ select ('fdd00000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid $fn$;
create function pg_temp.d() returns date language sql as $fn$ select (now() at time zone 'Asia/Kolkata')::date $fn$;
-- A definer function that moves a mandate while called as whoever: the trigger must still check who is asking.
create function pg_temp.try_move(p uuid) returns void language plpgsql security definer as $fn$
begin
  update payments.mandates set status = 'registration_pending', provider_mandate_ref = 'SAMPLE-SNEAKY' where id = p;
end
$fn$;

-- A SAMPLE collection configuration with rail limits. Call as the owner.
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
create function pg_temp.at(m integer) returns text language sql as $fn$ select to_char((clock_timestamp() + make_interval(secs => m * 20)) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') $fn$;
create function pg_temp.dlv(p_delivery text, p_event text, p_kind text, p_status text, p_obj text, p_order text default null, p_amount bigint default null,
  p_occurred text default '2026-10-15T10:00:00Z', p_provider text default 'mock_gateway') returns jsonb language sql as $fn$
  select jsonb_strip_nulls(jsonb_build_object(
    'provider', p_provider, 'outcome', 'verified', 'reason_class', 'none', 'delivery_id', p_delivery, 'payload_sha256', pg_temp.sha('body-' || p_delivery),
    'scheme', 'mock-standard-webhooks-v1', 'signature_present', true, 'timestamp_skew_seconds', 3, 'body_bytes', 420, 'ip_hmac', repeat('a', 64),
    'event', jsonb_build_object('provider', p_provider, 'deliveryId', p_delivery, 'eventId', p_event, 'objectKind', p_kind, 'objectRef', p_obj, 'orderRef', p_order, 'status', p_status,
      'rank', case p_status when 'created' then 10 when 'pending' then 15 when 'active' then 30 when 'returned' then 40 when 'paused' then 35 when 'revoked' then 45 else 30 end,
      'amountMinor', p_amount::text, 'currency', case when p_amount is null then null else 'INR' end, 'occurredAt', p_occurred)));
$fn$;
create function pg_temp.ing(p_lender uuid, p_d jsonb) returns text language sql as $fn$ select (payments.ingest_provider_delivery(pg_temp.tok(p_lender), p_d) ->> 'outcome') $fn$;
create function pg_temp.ev(p_event text) returns uuid language sql security definer as $fn$ select id from payments.provider_events where provider_event_id = p_event $fn$;
-- Deliver, then apply: returns the outcome the worker would record.
create function pg_temp.deliver(p_lender uuid, p_delivery text, p_event text, p_kind text, p_status text, p_obj text, p_order text default null, p_amount bigint default null,
  p_occurred text default '2026-10-15T10:00:00Z') returns text language plpgsql as $fn$
declare v_in text;
begin
  v_in := pg_temp.ing(p_lender, pg_temp.dlv(p_delivery, p_event, p_kind, p_status, p_obj, p_order, p_amount, p_occurred));
  if v_in <> 'ok' then return 'ingest:' || v_in; end if;
  return payments.apply_provider_event(pg_temp.ev(p_event)) ->> 'outcome';
end
$fn$;
create function pg_temp.mstatus(p_mandate uuid) returns text language sql security definer as $fn$ select status from payments.mandates where id = p_mandate $fn$;
create function pg_temp.mhist(p_mandate uuid) returns text language sql security definer as $fn$
  select string_agg(coalesce(from_status, '-') || '>' || to_status || '/' || source, ',' order by created_at, id) from payments.mandate_events where mandate_id = p_mandate
$fn$;
create function pg_temp.dstatus(p_ref text) returns text language sql security definer as $fn$ select (planned, status, amount_minor)::text from payments.mandate_debits where provider_debit_ref = p_ref $fn$;
-- The open exception of a class about a debit (severity), and how many open exceptions of a class name a mandate.
create function pg_temp.dsev(p_debit uuid, p_class text default 'mandate_debit_unresolved') returns text language sql security definer as $fn$
  select string_agg(severity, ',') from payments.reconciliation_exceptions where class = p_class and subject ->> 'debit_id' = p_debit::text and status <> 'resolved'
$fn$;
create function pg_temp.dsev_ref(p_ref text, p_class text default 'mandate_debit_unresolved') returns text language sql security definer as $fn$
  select pg_temp.dsev((select id from payments.mandate_debits where provider_debit_ref = p_ref), p_class)
$fn$;
create function pg_temp.mexc(p_mandate uuid, p_class text) returns bigint language sql security definer as $fn$
  select count(*) from payments.reconciliation_exceptions where class = p_class and subject ->> 'mandate_id' = p_mandate::text and status <> 'resolved'
$fn$;
create function pg_temp.set_replica(p boolean) returns void language plpgsql security definer as $fn$
begin
  perform set_config('session_replication_role', case when p then 'replica' else 'origin' end, true);
end
$fn$;
-- A mandate row in any state, written directly (as the owner, without the lifecycle triggers) with its own provider reference.
create function pg_temp.mk_mandate(p_id uuid, p_loan uuid, p_status text, p_ref text, p_max bigint default 4000000, p_start integer default -1, p_end integer default 400) returns void language plpgsql security definer as $fn$
begin
  perform pg_temp.set_replica(true);
  insert into payments.mandates (id, lender_org_id, config_id, borrower_id, loan_account_id, rail, status, provider, provider_mode, creditor_ref, provider_mandate_ref, max_amount_minor,
                                 start_date, end_date, masked_account_ref, needs_afa_each_debit, created_by)
  select p_id, l.lender_org_id, c.id, l.borrower_id, l.id, 'enach_api', p_status, c.provider, 'mock', 'SAMPLE-CREDITOR', p_ref, p_max,
         pg_temp.d() + p_start, pg_temp.d() + p_end, 'XXXXXX9999', false, pg_temp.u(1)
  from servicing.loan_accounts l join payments.lender_payment_configs c on c.lender_org_id = l.lender_org_id and c.status = 'active' where l.id = p_loan;
  perform pg_temp.set_replica(false);
end
$fn$;
-- A planned debit of a mandate's loan (newest schedule snapshot) and its notice. Returns the debit id.
create function pg_temp.mk_debit(p_mandate uuid, p_seq integer, p_days integer, p_amount bigint, p_status text default 'scheduled', p_ref text default null,
                                 p_notice_due_min integer default -60, p_notice boolean default true) returns uuid language plpgsql security definer as $fn$
declare
  m payments.mandates;
  v_id uuid;
begin
  select * into m from payments.mandates where id = p_mandate;
  insert into payments.mandate_debits (lender_org_id, mandate_id, loan_account_id, planned, schedule_snapshot_id, installment_seq, scheduled_on, amount_minor, status, rank, provider_debit_ref)
  select m.lender_org_id, m.id, m.loan_account_id, true, (select s.id from servicing.schedule_snapshots s where s.loan_account_id = m.loan_account_id order by s.version desc limit 1),
         p_seq, pg_temp.d() + p_days, p_amount, p_status, case p_status when 'scheduled' then 10 when 'notified' then 20 when 'presented' then 30 else 40 end, p_ref
  returning id into v_id;
  if p_notice then
    insert into payments.pre_debit_notices (lender_org_id, debit_id, mandate_id, borrower_id, notice_due_at, status)
    values (m.lender_org_id, v_id, m.id, m.borrower_id, clock_timestamp() + make_interval(mins => p_notice_due_min), 'planned');
  end if;
  return v_id;
end
$fn$;
create function pg_temp.nstatus(p_debit uuid) returns text language sql security definer as $fn$ select status from payments.pre_debit_notices where debit_id = p_debit $fn$;
create function pg_temp.dst(p_debit uuid) returns text language sql security definer as $fn$ select status from payments.mandate_debits where id = p_debit $fn$;
create function pg_temp.claimed(p_mandate uuid) returns bigint language sql as $fn$ select count(*) from payments.claim_pre_debit_notices(1000) c where c.mandate_id = p_mandate $fn$;
create function pg_temp.next_debit(p_borrower_user uuid, p_mandate uuid) returns text language plpgsql as $fn$
declare v text;
begin
  perform pg_temp.as_user(p_borrower_user);
  select coalesce(next_debit_on::text, 'none') || '/' || coalesce(next_debit_minor::text, '-') into v from payments.my_mandates() where mandate_id = p_mandate;
  perform pg_temp.as_system();
  return coalesce(v, 'unlisted');
end
$fn$;
create function pg_temp.outbox(p_prefix text) returns bigint language sql security definer as $fn$ select count(*) from ops.outbox_events where dedupe_key like p_prefix || '%' $fn$;
create function pg_temp.dcount(p_debit uuid, p_class text) returns bigint language sql security definer as $fn$
  select count(*) from payments.reconciliation_exceptions where class = p_class and subject ->> 'debit_id' = p_debit::text
$fn$;
create function pg_temp.audn(p_action text, p_entity uuid, p_count text) returns bigint language sql security definer as $fn$
  select count(*) from audit.events where action = p_action and entity_id = p_entity::text and (metadata ->> 'count') = p_count
$fn$;
-- A draft in a given hand-off state: the outbox row of its hand-off, whether the borrower asked to cancel, then one sweep. Returns what became of it.
create function pg_temp.draft_case(p_id uuid, p_loan uuid, p_cancel boolean, p_h text, p_attempts integer, p_grace interval) returns text language plpgsql as $fn$
declare v_h uuid;
begin
  perform pg_temp.as_owner();
  perform pg_temp.mk_mandate(p_id, p_loan, 'draft', null);
  v_h := ops.enqueue_event('mandate.handoff', jsonb_build_object('mandate_id', p_id), null, 'mandate.handoff:' || p_id::text);
  perform pg_temp.set_replica(true);
  update ops.outbox_events set status = p_h::ops.outbox_status, attempts = p_attempts,
         locked_by = case when p_h = 'processing' then 'sample-worker' end, locked_until = case when p_h = 'processing' then now() + interval '10 minutes' end,
         completed_at = case when p_h = 'completed' then now() end where id = v_h;
  if p_cancel then
    update payments.mandates set cancel_requested_at = clock_timestamp(), cancel_reason = 'borrower', cancel_attempts = 1, cancel_enqueued_at = clock_timestamp() where id = p_id;
  end if;
  perform pg_temp.set_replica(false);
  perform pg_temp.as_system();
  perform payments.sweep_mandates(p_grace);
  return pg_temp.mstatus(p_id);
end
$fn$;
-- Frees the loan again: a mandate left in a live state is closed by hand (as the owner, without the lifecycle triggers).
create function pg_temp.free(p_id uuid) returns void language plpgsql security definer as $fn$
begin
  perform pg_temp.set_replica(true);
  update payments.mandates set status = 'cancelled' where id = p_id;
  perform pg_temp.set_replica(false);
end
$fn$;
create function pg_temp.stepup(p_borrower text, p_mandate uuid) returns void language sql as $fn$
  insert into identity.stepup_challenges (id, borrower_id, action, context_ref, code_hash, status, delivery_status, expires_at, verified_at, verified_until)
  values (gen_random_uuid(), p_borrower::uuid, 'mandate_creation', p_mandate::text, repeat('a', 64), 'verified', 'accepted', now() + interval '10 minutes', now(), now() + interval '10 minutes')
$fn$;
create function pg_temp.integrity(p_borrower text, p_level text) returns void language sql as $fn$
  insert into identity.device_attestations (borrower_id, level, provider, verified_at, expires_at) values (p_borrower::uuid, p_level, 'sample_attest', clock_timestamp(), clock_timestamp() + interval '1 hour')
$fn$;
grant execute on all functions in schema pg_temp to public;

-- Fixture -----------------------------------------------------------------------------------------------------------------------
-- Users: 01 borrower b1, 02 borrower b2, 03 lender X reader, 04 lender Z reader, 07 and 08 switch fixture users, 09 and 10 product maker and checker.
insert into auth.users (id, phone, raw_app_meta_data)
select pg_temp.u(n), case when n in (1, 2) then '9100000009' || n end, case when n in (1, 2) then '{}'::jsonb else '{"actor_type":"staff"}'::jsonb end from generate_series(1, 10) n;
select pg_temp.keep('b1', (select id::text from identity.borrowers where user_id = pg_temp.u(1)));
select pg_temp.keep('b2', (select id::text from identity.borrowers where user_id = pg_temp.u(2)));

select pg_temp.as_owner();
select set_config('udofin.allow_mock_providers', 'on', true);
insert into tenancy.organizations (id, kind, legal_name, display_name, regulator_registration_no, status) values
  ('fda00000-0000-4000-8000-000000000000', 'platform', 'Udofin Platform (test)', 'Udofin', null, 'active'),
  (pg_temp.lx(), 'lender', 'Alpha Finance Ltd (test)', 'Alpha', 'TEST-FD-0001', 'active'),
  (pg_temp.lz(), 'lender', 'Gamma Credit Ltd (test)', 'Gamma', 'TEST-FD-0002', 'active');
insert into tenancy.memberships (id, org_id, user_id, status) values
  ('fdc10000-0000-4000-8000-000000000003', pg_temp.lx(), pg_temp.u(3), 'active'),
  ('fdc10000-0000-4000-8000-000000000004', pg_temp.lz(), pg_temp.u(4), 'active'),
  ('fdc10000-0000-4000-8000-000000000019', pg_temp.lx(), pg_temp.u(9), 'active'),
  ('fdc10000-0000-4000-8000-000000000020', pg_temp.lx(), pg_temp.u(10), 'active'),
  ('fdc10000-0000-4000-8000-000000000023', pg_temp.lz(), pg_temp.u(9), 'active'),
  ('fdc10000-0000-4000-8000-000000000024', pg_temp.lz(), pg_temp.u(10), 'active');
insert into tenancy.membership_roles (membership_id, role_id)
select g.mid::uuid, r.id from (values
  ('fdc10000-0000-4000-8000-000000000003', 'lender', 'viewer'), ('fdc10000-0000-4000-8000-000000000004', 'lender', 'viewer'),
  ('fdc10000-0000-4000-8000-000000000019', 'lender', 'lender_admin'), ('fdc10000-0000-4000-8000-000000000020', 'lender', 'product_approver'),
  ('fdc10000-0000-4000-8000-000000000023', 'lender', 'lender_admin'), ('fdc10000-0000-4000-8000-000000000024', 'lender', 'product_approver')) as g (mid, kind, rkey)
join tenancy.roles r on r.org_id is null and r.applies_to = g.kind::tenancy.organization_kind and r.key = g.rkey;
-- Lender X and lender Z use the SAME provider; both offer mandates with both rails configured.
select pg_temp.sample_config(pg_temp.lx(), 'fde10000-0000-4000-8000-000000000001', 'XXXXXX1111', 'mock_gateway', 'payment_and_mandate',
  '{"enach_api": {"max_mandate_amount_minor": 5000000, "needs_afa_each_debit": false}, "upi_autopay": {"max_mandate_amount_minor": 1500000, "needs_afa_each_debit": true}}'::jsonb);
select pg_temp.sample_config(pg_temp.lz(), 'fde10000-0000-4000-8000-000000000002', 'XXXXXX3333', 'mock_gateway', 'payment_and_mandate',
  '{"enach_api": {"max_mandate_amount_minor": 5000000, "needs_afa_each_debit": false}, "upi_autopay": {"max_mandate_amount_minor": 1500000, "needs_afa_each_debit": true}}'::jsonb);

insert into servicing.feature_change_requests (lender_org_id, feature, enable, mode, status, evidence, requested_by, idempotency_key, decided_by, decided_at, applied_at)
select o.lender, f.feature, true, 'two_person', 'applied', '{"contract_ref":"SAMPLE-FD"}', pg_temp.u(7), 'fd-req-' || f.feature || '-' || right(o.lender::text, 1) || '-0001', pg_temp.u(8), now(), now()
from (values (pg_temp.lx()), (pg_temp.lz())) o (lender) cross join (values ('servicing_sync'), ('mandates'), ('payments')) f (feature);
insert into servicing.lender_features (lender_org_id, feature, enabled, evidence, enabled_by, enabled_at, last_change_request_id)
select r.lender_org_id, r.feature, true, r.evidence, pg_temp.u(8), now(), r.id from servicing.feature_change_requests r;

-- Loans 1 to 14. Lender X owns all but loan 6 (lender Z); borrower b2 owns loan 5, borrower b1 the rest.
insert into lending.loan_products (id, lender_org_id, category_key, code, name, status) values
  ('fd900000-0000-4000-8000-000000000001', pg_temp.lx(), 'personal', 'PL-FD', 'X Personal Loan', 'active'),
  ('fd900000-0000-4000-8000-000000000002', pg_temp.lz(), 'personal', 'PL-FD', 'Z Personal Loan', 'active');
insert into lending.loan_product_versions (id, product_id, lender_org_id, version, status, min_amount_minor, max_amount_minor, min_tenure_days, max_tenure_days,
  rate_type, min_annual_rate_bps, max_annual_rate_bps, drafted_by, approved_by, approved_at, effective_from)
select ('fd910000-0000-4000-8000-00000000000' || n)::uuid, ('fd900000-0000-4000-8000-00000000000' || n)::uuid, ('fdb00000-0000-4000-8000-00000000000' || n)::uuid, 1, 'approved',
       1000000, 50000000, 180, 1825, 'fixed', 1400, 2400, pg_temp.u(9), pg_temp.u(10), now(), now()
from generate_series(1, 2) n;
insert into lending.loan_requests (id, borrower_id, category_key, requested_amount_minor, requested_tenure_days, purpose_code, status)
select ('fd700000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, case when n = 5 then pg_temp.got('b2')::uuid else pg_temp.got('b1')::uuid end, 'personal', 5000000, 365, 'education', 'submitted'
from generate_series(1, 14) n;
insert into lending.applications (id, lender_org_id, loan_request_id, borrower_id, product_version_id, status, requested_amount_minor, requested_tenure_days, lender_reference)
select ('fd200000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, case when n = 6 then pg_temp.lz() else pg_temp.lx() end,
       ('fd700000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, case when n = 5 then pg_temp.got('b2')::uuid else pg_temp.got('b1')::uuid end,
       case when n = 6 then 'fd910000-0000-4000-8000-000000000002' else 'fd910000-0000-4000-8000-000000000001' end::uuid, 'disbursed', 5000000, 365, 'SAMPLE-APP-' || n
from generate_series(1, 14) n;
insert into servicing.loan_accounts (id, lender_org_id, application_id, borrower_id, source_system, lms_loan_ref, status, sanctioned_amount_minor)
select pg_temp.lid(n), a.lender_org_id, a.id, a.borrower_id, 'lender_lms', 'SAMPLE-LN-' || n, 'active', 5000000
from lending.applications a, generate_series(1, 14) n where right(a.id::text, 2)::int = n;
-- The lender-reported figures (fresh): 4,750.00 due in three days; loan 12's report is old (stale) and says the next due date is in 40 days.
insert into servicing.balance_snapshots (lender_org_id, loan_account_id, version, status, outstanding_principal_minor, total_overdue_minor, next_due_on, next_due_minor, days_past_due,
  source_system, source_record_id, reported_as_of, content_sha256)
select l.lender_org_id, l.id, 1, 'active', 4000000, 0, case when l.id = pg_temp.lid(12) then pg_temp.d() + 40 else pg_temp.d() + 3 end, 475000, 0, 'file_import', 'SRC-' || l.lms_loan_ref,
       case when l.id = pg_temp.lid(12) then clock_timestamp() - interval '3 days' else clock_timestamp() - interval '1 hour' end, pg_temp.sha('snap-' || l.lms_loan_ref)
from servicing.loan_accounts l;
-- The schedule: installment 1 in three days (4,750.00), 2 in thirty-three days (4,750.00), 3 in sixty-three days (60,000.00, above any mandate).
insert into servicing.schedule_snapshots (id, lender_org_id, loan_account_id, version)
select ('fd500000-0000-4000-8000-0000000000' || lpad(right(l.id::text, 2)::int::text, 2, '0'))::uuid, l.lender_org_id, l.id, 1 from servicing.loan_accounts l;
insert into servicing.schedule_installments (snapshot_id, lender_org_id, seq, due_date, principal_minor, interest_minor)
select s.id, s.lender_org_id, x.seq, pg_temp.d() + x.days, x.principal, x.interest
from servicing.schedule_snapshots s cross join (values (1, 3, 400000::bigint, 75000::bigint), (2, 33, 400000::bigint, 75000::bigint), (3, 63, 5900000::bigint, 100000::bigint)) x (seq, days, principal, interest);
select pg_temp.integrity(pg_temp.got('b1'), 'device');
select pg_temp.integrity(pg_temp.got('b2'), 'device');
select pg_temp.as_system();

-- ============================================================================================================================
-- 1. A22: dead notices must not hide live ones (and are closed by the sweep)
-- ============================================================================================================================
-- Mandate K (lender X) has 120 notices for debits that were cancelled, all older than anything else; mandate F (lender Z) has one live notice.
select pg_temp.as_owner();
select pg_temp.mk_mandate(pg_temp.mid(11), pg_temp.lid(11), 'active', 'SAMPLE-PM-K');
insert into payments.mandate_debits (lender_org_id, mandate_id, loan_account_id, planned, schedule_snapshot_id, installment_seq, scheduled_on, amount_minor, status, rank)
select pg_temp.lx(), pg_temp.mid(11), pg_temp.lid(11), true, ('fd500000-0000-4000-8000-0000000000' || '11')::uuid, g, pg_temp.d() + 5, 475000, 'cancelled', 40 from generate_series(1, 120) g;
insert into payments.pre_debit_notices (lender_org_id, debit_id, mandate_id, borrower_id, notice_due_at, status)
select d.lender_org_id, d.id, d.mandate_id, pg_temp.got('b1')::uuid, clock_timestamp() - interval '2 hours' - make_interval(secs => d.installment_seq), 'planned'
from payments.mandate_debits d where d.mandate_id = pg_temp.mid(11);
select pg_temp.mk_mandate(pg_temp.mid(6), pg_temp.lid(6), 'active', 'SAMPLE-PM-F');
select pg_temp.keep('f_debit', pg_temp.mk_debit(pg_temp.mid(6), 1, 3, 475000, 'scheduled', null, -1)::text);
select pg_temp.keep('f_notice', (select id::text from payments.pre_debit_notices where debit_id = pg_temp.got('f_debit')::uuid));
select pg_temp.as_system();
select is((select count(*) from payments.pre_debit_notices where mandate_id = pg_temp.mid(11) and status = 'planned'), 120::bigint, '120 dead notices wait at the head of the queue');
select is((select count(*) from payments.claim_pre_debit_notices(100) c where c.notice_id = pg_temp.got('f_notice')::uuid), 1::bigint,
  'the worker''s own call (100 at a time) still claims the one live notice of another lender behind them');
select is((select count(*) from payments.claim_pre_debit_notices(100) c where c.notice_id = pg_temp.got('f_notice')::uuid), 0::bigint, 'and it is leased: not claimed again at once');
select is((select count(*) from payments.pre_debit_notices where mandate_id = pg_temp.mid(11) and status = 'planned'), 120::bigint, 'claiming does not touch the dead ones');
select is((payments.sweep_mandates() ->> 'notices_closed')::integer, 120, 'the sweep closes the 120 dead notices');
select is((select count(*) from payments.pre_debit_notices where mandate_id = pg_temp.mid(11) and status = 'not_needed'), 120::bigint, 'as not needed (nothing deleted)');
select is((select status from payments.pre_debit_notices where id = pg_temp.got('f_notice')::uuid), 'planned', 'while the live notice is untouched');
select is((payments.sweep_mandates() ->> 'notices_closed')::integer, 0, 'a second sweep closes nothing');
-- A debit already past its date is dead too (the debit date passed while the worker was down).
select pg_temp.as_owner();
select pg_temp.keep('k_late', pg_temp.mk_debit(pg_temp.mid(11), 200, -1, 475000, 'scheduled', null, -30)::text);
select pg_temp.as_system();
select is(pg_temp.claimed(pg_temp.mid(11)), 0::bigint, 'a notice for a debit dated yesterday is never claimed');
select is((payments.sweep_mandates() ->> 'notices_closed')::integer, 1, 'and the sweep closes it');
select is(pg_temp.nstatus(pg_temp.got('k_late')::uuid), 'not_needed', 'as not needed');
-- Cross-tenant: the other lender's reader sees none of lender X's cancelled debits or closed notices; X's reader sees them.
select pg_temp.as_user(pg_temp.u(4));
select is((select count(*) from payments.mandate_debits where lender_org_id = pg_temp.lx()), 0::bigint, 'lender Z''s reader sees none of lender X''s debits');
select is((select count(*) from payments.pre_debit_notices where lender_org_id = pg_temp.lx()), 0::bigint, 'nor its notices');
select pg_temp.as_user(pg_temp.u(3));
select is((select count(*) from payments.pre_debit_notices where mandate_id = pg_temp.mid(11) and status = 'not_needed'), 121::bigint, 'lender X''s reader sees its own closed notices');
select pg_temp.as_system();

-- ============================================================================================================================
-- 2. A53 and U3: the planner and the lender's own report
-- ============================================================================================================================
-- Mandate A on loan 1: the report (fresh) names installment 1 (due in 3 days) as the next one due.
select pg_temp.as_owner();
select pg_temp.mk_mandate(pg_temp.mid(1), pg_temp.lid(1), 'active', 'SAMPLE-PM-A');
select pg_temp.as_system();
select is(payments.plan_mandate_debits(interval '40 days') ->> 'planned' is not null, true, 'the planner runs');
select is((select count(*) from payments.mandate_debits where mandate_id = pg_temp.mid(1) and planned and status = 'scheduled'), 2::bigint, 'installments 1 and 2 are planned (3 and 33 days)');
select pg_temp.keep('a_d1', (select id::text from payments.mandate_debits where mandate_id = pg_temp.mid(1) and installment_seq = 1));
select pg_temp.keep('a_d2', (select id::text from payments.mandate_debits where mandate_id = pg_temp.mid(1) and installment_seq = 2));
-- The lender reports installment 1 paid: its next due date is installment 2's, and it names its own figure (4,800.00).
select pg_temp.as_owner();
insert into servicing.balance_snapshots (lender_org_id, loan_account_id, version, status, outstanding_principal_minor, total_overdue_minor, next_due_on, next_due_minor, days_past_due,
  source_system, source_record_id, reported_as_of, content_sha256)
values (pg_temp.lx(), pg_temp.lid(1), 2, 'active', 3600000, 0, pg_temp.d() + 33, 480000, 0, 'file_import', 'SRC2-SAMPLE-LN-1', clock_timestamp(), pg_temp.sha('snap2-ln1'));
select pg_temp.as_system();
select is(payments.plan_mandate_debits(interval '40 days') - 'skipped_over_max' - 'notices_late' - 'planned', jsonb_build_object('cancelled_paid', 1, 'cancelled_restated', 1),
  'a later report shows installment 1 paid (its planned debit is cancelled) and names a new figure for installment 2 (its planned debit is replaced)');
select is(pg_temp.dst(pg_temp.got('a_d1')::uuid), 'cancelled', 'the debit of the paid installment is cancelled');
select is(pg_temp.nstatus(pg_temp.got('a_d1')::uuid), 'not_needed', 'and its notice is closed');
select is(pg_temp.dst(pg_temp.got('a_d2')::uuid), 'cancelled', 'the old debit of installment 2 is cancelled');
select is((select (status, amount_minor)::text from payments.mandate_debits where mandate_id = pg_temp.mid(1) and installment_seq = 2 and status = 'scheduled'), '(scheduled,480000)',
  'and installment 2 is planned again at the lender''s own figure');
select is((select count(*) from payments.pre_debit_notices n join payments.mandate_debits d on d.id = n.debit_id where d.mandate_id = pg_temp.mid(1) and n.status = 'planned'), 1::bigint,
  'with a notice of its own');
select is((select count(*) from payments.mandate_debits where mandate_id = pg_temp.mid(1) and installment_seq = 1 and status <> 'cancelled'), 0::bigint, 'no live debit remains for the paid installment');
select is(payments.plan_mandate_debits(interval '40 days') - 'skipped_over_max' - 'notices_late', jsonb_build_object('planned', 0, 'cancelled_paid', 0, 'cancelled_restated', 0),
  'another run changes nothing (no flapping, no re-planning of the paid installment)');
-- A debit planned for a shorter horizon earlier is not cancelled just because the horizon is shorter now.
select is(payments.plan_mandate_debits(interval '10 days') ->> 'cancelled_restated', '0', 'a shorter horizon cancels nothing that is already planned');
select is((select count(*) from payments.mandate_debits where mandate_id = pg_temp.mid(1) and installment_seq = 2 and status = 'scheduled'), 1::bigint, 'the planned debit stays');
-- The lender restates its schedule: installment 2 moves two days later.
select pg_temp.as_owner();
insert into servicing.schedule_snapshots (id, lender_org_id, loan_account_id, version) values ('fd500000-0000-4000-8000-0000000001a1', pg_temp.lx(), pg_temp.lid(1), 2);
insert into servicing.schedule_installments (snapshot_id, lender_org_id, seq, due_date, principal_minor, interest_minor)
values ('fd500000-0000-4000-8000-0000000001a1', pg_temp.lx(), 1, pg_temp.d() + 3, 400000, 75000), ('fd500000-0000-4000-8000-0000000001a1', pg_temp.lx(), 2, pg_temp.d() + 35, 400000, 75000),
       ('fd500000-0000-4000-8000-0000000001a1', pg_temp.lx(), 3, pg_temp.d() + 63, 5900000, 100000);
select pg_temp.as_system();
select is(payments.plan_mandate_debits(interval '40 days') - 'skipped_over_max' - 'notices_late', jsonb_build_object('planned', 1, 'cancelled_paid', 0, 'cancelled_restated', 1),
  'a restated schedule replaces the planned debit that moved');
select is((select (scheduled_on = pg_temp.d() + 35, schedule_snapshot_id = 'fd500000-0000-4000-8000-0000000001a1', amount_minor)::text from payments.mandate_debits
            where mandate_id = pg_temp.mid(1) and installment_seq = 2 and status = 'scheduled'), '(t,t,475000)', 'the new one carries the new date, the new schedule and the installment as stated');
select is((select count(*) from payments.mandate_debits where mandate_id = pg_temp.mid(1) and installment_seq = 2), 3::bigint, 'history is kept: two cancelled debits and the live one, nothing deleted');
-- A debit the provider already knows (it carries the provider reference) is never cancelled by the planner.
select pg_temp.as_owner();
select pg_temp.keep('a_known', pg_temp.mk_debit(pg_temp.mid(1), 9, 9, 475000, 'scheduled', 'SAMPLE-DB-A9', 1000)::text);
select pg_temp.as_system();
select is(payments.plan_mandate_debits(interval '40 days') ->> 'cancelled_restated', '0', 'a debit that carries the provider''s reference is left alone (the schedule has no installment 9)');
select is(pg_temp.dst(pg_temp.got('a_known')::uuid), 'scheduled', 'and stays scheduled');
-- The claim itself also looks at the lender's report: a notice due now for an installment the fresh report shows as paid is not claimed.
select pg_temp.as_owner();
select pg_temp.keep('a_paid', pg_temp.mk_debit(pg_temp.mid(1), 7, 5, 475000, 'scheduled', null, -10)::text);
select pg_temp.as_system();
select is(pg_temp.claimed(pg_temp.mid(1)), 0::bigint, 'a notice for a debit dated before the reported next due date (5 days against 33) is not claimed');
select is(pg_temp.nstatus(pg_temp.got('a_paid')::uuid), 'planned', 'and is left open (the planner cancels it)');
-- A prepaid installment is never planned in the first place; a stale report says nothing, so the installment is planned from the schedule.
select pg_temp.as_owner();
select pg_temp.mk_mandate(pg_temp.mid(12), pg_temp.lid(12), 'active', 'SAMPLE-PM-S');
select pg_temp.as_system();
select payments.plan_mandate_debits(interval '40 days');
select is((select count(*) from payments.mandate_debits where mandate_id = pg_temp.mid(12) and planned), 2::bigint, 'a STALE report (even one saying the next due date is in 40 days) revises and skips nothing');
select pg_temp.as_owner();
select pg_temp.mk_mandate(pg_temp.mid(13), pg_temp.lid(13), 'active', 'SAMPLE-PM-P');
insert into servicing.balance_snapshots (lender_org_id, loan_account_id, version, status, outstanding_principal_minor, total_overdue_minor, next_due_on, next_due_minor, days_past_due,
  source_system, source_record_id, reported_as_of, content_sha256)
values (pg_temp.lx(), pg_temp.lid(13), 2, 'active', 3600000, 0, pg_temp.d() + 33, 475000, 0, 'file_import', 'SRC2-SAMPLE-LN-13', clock_timestamp(), pg_temp.sha('snap2-ln13'));
select pg_temp.as_system();
select payments.plan_mandate_debits(interval '40 days');
select is((select array_agg(installment_seq order by installment_seq) from payments.mandate_debits where mandate_id = pg_temp.mid(13)), array[2], 'a FRESH report showing installment 1 paid: only installment 2 is planned');
select is((select count(*) from payments.pre_debit_notices where mandate_id = pg_temp.mid(13)), 1::bigint, 'and only one notice exists');
-- The loan fully paid: nothing outstanding and nothing due.
select pg_temp.as_owner();
select pg_temp.mk_mandate(pg_temp.mid(14), pg_temp.lid(14), 'active', 'SAMPLE-PM-FP');
insert into servicing.balance_snapshots (lender_org_id, loan_account_id, version, status, outstanding_principal_minor, total_overdue_minor, next_due_on, next_due_minor, days_past_due,
  source_system, source_record_id, reported_as_of, content_sha256)
values (pg_temp.lx(), pg_temp.lid(14), 2, 'active', 0, 0, null, null, 0, 'file_import', 'SRC2-SAMPLE-LN-14', clock_timestamp(), pg_temp.sha('snap2-ln14'));
select pg_temp.as_system();
select payments.plan_mandate_debits(interval '70 days');
select is((select count(*) from payments.mandate_debits where mandate_id = pg_temp.mid(14)), 0::bigint, 'a loan the report shows as fully paid gets no debit at all');
select pg_temp.free(pg_temp.mid(14));
select pg_temp.free(pg_temp.mid(13));

-- ============================================================================================================================
-- 3. A52 M45: planned debits and notices end with the mandate
-- ============================================================================================================================
-- Mandate B on loan 2: a planned debit due in three days with its notice already due, and a debit the provider already knows.
select pg_temp.as_owner();
select pg_temp.mk_mandate(pg_temp.mid(2), pg_temp.lid(2), 'active', 'SAMPLE-PM-B');
select pg_temp.keep('b_d1', pg_temp.mk_debit(pg_temp.mid(2), 1, 3, 475000, 'scheduled', null, -60)::text);
select pg_temp.keep('b_d2', pg_temp.mk_debit(pg_temp.mid(2), 2, 33, 475000, 'scheduled', 'SAMPLE-DB-B2', 1000)::text);
select pg_temp.as_system();
select is(pg_temp.next_debit(pg_temp.u(1), pg_temp.mid(2)), (pg_temp.d() + 3)::text || '/475000', 'before the provider reports anything the borrower is shown the next debit');
select is(pg_temp.deliver(pg_temp.lx(), 'SAMPLE-D-201', 'SAMPLE-E-201', 'mandate', 'revoked', 'SAMPLE-PM-B', null, null, pg_temp.at(1)), 'applied', 'the provider reports that the borrower revoked the mandate at the bank');
select is(pg_temp.mstatus(pg_temp.mid(2)), 'revoked', 'the mandate is revoked');
select is(pg_temp.dst(pg_temp.got('b_d1')::uuid), 'cancelled', 'its planned debit nobody presented is cancelled');
select is(pg_temp.nstatus(pg_temp.got('b_d1')::uuid), 'not_needed', 'and its notice is closed');
select is(pg_temp.dst(pg_temp.got('b_d2')::uuid), 'scheduled', 'a debit the provider already knows is left as it is (the provider''s to settle or cancel)');
select is(pg_temp.claimed(pg_temp.mid(2)), 0::bigint, 'no notice is claimed for the revoked mandate');
select is(pg_temp.next_debit(pg_temp.u(1), pg_temp.mid(2)), 'none/-', 'the borrower is shown no next debit for it (the mandate is listed as revoked)');
select pg_temp.as_user(pg_temp.u(1));
select is((select status from payments.my_mandates() where mandate_id = pg_temp.mid(2)), 'revoked', 'with its status as the provider left it');
select pg_temp.as_system();
select is(pg_temp.audn('payments.mandate.debits_cancelled', pg_temp.mid(2), '1'), 1::bigint,
  'the cancellation of the planned debit is audited (a count and a reason, nothing personal)');
select is(pg_temp.mhist(pg_temp.mid(2)), 'active>revoked/provider_event', 'and the history of the mandate carries the end');
-- Cancelled by a status lookup: the same.
select pg_temp.as_owner();
select pg_temp.mk_mandate(pg_temp.mid(15), pg_temp.lid(3), 'active', 'SAMPLE-PM-CL');
select pg_temp.keep('cl_d1', pg_temp.mk_debit(pg_temp.mid(15), 1, 3, 475000, 'notified', null, -60)::text);
select pg_temp.as_system();
select is(payments.apply_mandate_lookup(pg_temp.mid(15), 'cancelled', null, clock_timestamp()), 'applied', 'a lookup finds the mandate cancelled');
select is(pg_temp.dst(pg_temp.got('cl_d1')::uuid) || '/' || pg_temp.nstatus(pg_temp.got('cl_d1')::uuid), 'cancelled/not_needed', 'a notified debit is cancelled with it and its notice closed');
-- Expired by the sweep (the end date passed): the same.
select pg_temp.as_owner();
select pg_temp.mk_mandate(pg_temp.mid(16), pg_temp.lid(3), 'active', 'SAMPLE-PM-EX', 4000000, -100, -1);
select pg_temp.keep('ex_d1', pg_temp.mk_debit(pg_temp.mid(16), 1, 3, 475000, 'scheduled', null, -60)::text);
select pg_temp.as_system();
select is((payments.sweep_mandates() ->> 'expired')::integer >= 1, true, 'the sweep expires a mandate past its end date');
select is(pg_temp.mstatus(pg_temp.mid(16)) || '/' || pg_temp.dst(pg_temp.got('ex_d1')::uuid) || '/' || pg_temp.nstatus(pg_temp.got('ex_d1')::uuid), 'expired/cancelled/not_needed', 'and its planned debit and notice end with it');
-- Paused: the debit stays planned (the mandate may resume) but nothing is shown or sent while it is paused.
select pg_temp.as_owner();
select pg_temp.mk_mandate(pg_temp.mid(3), pg_temp.lid(7), 'active', 'SAMPLE-PM-G');
select pg_temp.keep('g_d1', pg_temp.mk_debit(pg_temp.mid(3), 1, 3, 475000, 'scheduled', null, -60)::text);
select pg_temp.as_system();
select is(pg_temp.deliver(pg_temp.lx(), 'SAMPLE-D-202', 'SAMPLE-E-202', 'mandate', 'paused', 'SAMPLE-PM-G', null, null, pg_temp.at(1)), 'applied', 'the provider pauses a mandate');
select is(pg_temp.next_debit(pg_temp.u(1), pg_temp.mid(3)), 'none/-', 'no next debit is shown for a paused mandate');
select is(pg_temp.claimed(pg_temp.mid(3)), 0::bigint, 'and no notice is claimed');
select is(pg_temp.dst(pg_temp.got('g_d1')::uuid) || '/' || pg_temp.nstatus(pg_temp.got('g_d1')::uuid), 'scheduled/planned', 'the debit and its notice stay open (a pause is not an end)');
select payments.sweep_mandates();
select is(pg_temp.nstatus(pg_temp.got('g_d1')::uuid), 'planned', 'the sweep does not close the notice of a paused mandate');
-- Debit news while paused is flagged (M44): the provider presents the planned debit anyway.
select is(pg_temp.deliver(pg_temp.lx(), 'SAMPLE-D-203', 'SAMPLE-E-203', 'debit', 'pending', 'SAMPLE-DB-G1', 'SAMPLE-PM-G', 475000, pg_temp.at(0)), 'applied', 'the provider presents a debit while the mandate is paused');
select is(pg_temp.dstatus('SAMPLE-DB-G1'), '(t,presented,475000)', 'it is attached to the planned debit');
select is(pg_temp.dsev(pg_temp.got('g_d1')::uuid), 'critical', 'and flagged to the lender as critical');
select is(pg_temp.deliver(pg_temp.lx(), 'SAMPLE-D-204', 'SAMPLE-E-204', 'mandate', 'active', 'SAMPLE-PM-G', null, null, pg_temp.at(2)), 'applied', 'the provider resumes the mandate');
-- A cancellation request: the mandate is still active until the provider confirms, but no next debit and no notice meanwhile.
select pg_temp.as_owner();
select pg_temp.mk_mandate(pg_temp.mid(4), pg_temp.lid(4), 'active', 'SAMPLE-PM-D');
select pg_temp.keep('d_d1', pg_temp.mk_debit(pg_temp.mid(4), 1, 3, 475000, 'scheduled', null, -60)::text);
select pg_temp.as_system();
select is(pg_temp.next_debit(pg_temp.u(1), pg_temp.mid(4)), (pg_temp.d() + 3)::text || '/475000', 'an active mandate shows its next debit');
select pg_temp.as_user(pg_temp.u(1));
select is(payments.request_mandate_cancellation(pg_temp.mid(4)), 'cancel_requested', 'the borrower asks to cancel');
select pg_temp.as_system();
select is(pg_temp.next_debit(pg_temp.u(1), pg_temp.mid(4)), 'none/-', 'the next debit disappears at once');
select is(pg_temp.claimed(pg_temp.mid(4)), 0::bigint, 'and no notice is claimed for it');
select is(pg_temp.mstatus(pg_temp.mid(4)), 'active', 'the mandate itself is still active (a request is not a cancellation)');
select is(pg_temp.dst(pg_temp.got('d_d1')::uuid), 'scheduled', 'and the planned debit stays until the provider confirms');
-- Debit presented while a cancellation is requested: attached and flagged.
select is(pg_temp.deliver(pg_temp.lx(), 'SAMPLE-D-205', 'SAMPLE-E-205', 'debit', 'pending', 'SAMPLE-DB-D1', 'SAMPLE-PM-D', 475000, pg_temp.at(0)), 'applied', 'a debit is presented although the borrower asked to cancel');
select is(pg_temp.dsev(pg_temp.got('d_d1')::uuid), 'critical', 'it is flagged critical');
-- A loan the lender closed: the planned debit is cancelled at once, the mandate waits for the provider.
select pg_temp.as_owner();
select pg_temp.mk_mandate(pg_temp.mid(5), pg_temp.lid(8), 'active', 'SAMPLE-PM-H');
select pg_temp.keep('h_d1', pg_temp.mk_debit(pg_temp.mid(5), 1, 3, 475000, 'scheduled', null, -60)::text);
update servicing.loan_accounts set status = 'closed' where id = pg_temp.lid(8);
select pg_temp.as_system();
select is(pg_temp.next_debit(pg_temp.u(1), pg_temp.mid(5)), 'none/-', 'a closed loan shows no next debit');
select is(pg_temp.claimed(pg_temp.mid(5)), 0::bigint, 'and no notice is claimed for it');
select is((payments.request_cancel_for_closed_loans() >= 1), true, 'the closure job requests the cancellation');
select is(pg_temp.dst(pg_temp.got('h_d1')::uuid) || '/' || pg_temp.nstatus(pg_temp.got('h_d1')::uuid), 'cancelled/not_needed', 'and cancels the planned debit and closes its notice (the loan is closed whatever the provider confirms)');
select is(pg_temp.mstatus(pg_temp.mid(5)), 'active', 'the mandate stays active until the provider confirms');
select is(payments.request_cancel_for_closed_loans(), 0, 'the job is idempotent');

-- ============================================================================================================================
-- 4. M44: a debit after the mandate ended is flagged, never a quiet normal debit
-- ============================================================================================================================
-- Mandate B was revoked: the provider presents and settles a debit of the planned amount and date anyway.
select is(pg_temp.deliver(pg_temp.lx(), 'SAMPLE-D-301', 'SAMPLE-E-301', 'debit', 'succeeded', 'SAMPLE-DB-B1', 'SAMPLE-PM-B', 475000, pg_temp.at(0)), 'applied', 'a debit settles after the mandate was revoked');
select is(pg_temp.dstatus('SAMPLE-DB-B1'), '(f,settled,475000)', 'it is recorded as what it is, an unplanned debit, not attached to the cancelled plan');
select is(pg_temp.dsev_ref('SAMPLE-DB-B1'), 'critical', 'and flagged to the lender as critical');
select is(pg_temp.dst(pg_temp.got('b_d1')::uuid), 'cancelled', 'the cancelled plan stays cancelled');
-- Expired and cancelled mandates: the same.
select is(pg_temp.deliver(pg_temp.lx(), 'SAMPLE-D-302', 'SAMPLE-E-302', 'debit', 'succeeded', 'SAMPLE-DB-EX1', 'SAMPLE-PM-EX', 475000, pg_temp.at(0)), 'applied', 'a debit settles after the mandate expired');
select is(pg_temp.dsev_ref('SAMPLE-DB-EX1'), 'critical', 'critical');
select is(pg_temp.deliver(pg_temp.lx(), 'SAMPLE-D-303', 'SAMPLE-E-303', 'debit', 'pending', 'SAMPLE-DB-CL1', 'SAMPLE-PM-CL', 475000, pg_temp.at(0)), 'applied', 'a debit is presented after the mandate was cancelled');
select is(pg_temp.dsev_ref('SAMPLE-DB-CL1'), 'critical', 'critical');
-- Loan closed, mandate still active (waiting for the provider): the debit is flagged because the loan is closed.
select is(pg_temp.deliver(pg_temp.lx(), 'SAMPLE-D-304', 'SAMPLE-E-304', 'debit', 'succeeded', 'SAMPLE-DB-H1', 'SAMPLE-PM-H', 475000, pg_temp.at(0)), 'applied', 'a debit settles after the loan was closed');
select is(pg_temp.dstatus('SAMPLE-DB-H1'), '(f,settled,475000)', 'it is recorded');
select is(pg_temp.dsev_ref('SAMPLE-DB-H1'), 'critical', 'and flagged critical although the mandate is still active');
-- A debit that is not yet in force: the mandate has not been registered (registration pending).
select pg_temp.as_owner();
select pg_temp.mk_mandate(pg_temp.mid(17), pg_temp.lid(9), 'registration_pending', 'SAMPLE-PM-RP');
select pg_temp.as_system();
select is(pg_temp.deliver(pg_temp.lx(), 'SAMPLE-D-305', 'SAMPLE-E-305', 'debit', 'pending', 'SAMPLE-DB-RP1', 'SAMPLE-PM-RP', 100000, pg_temp.at(0)), 'applied', 'a debit is presented before the mandate is registered');
select is(pg_temp.dsev_ref('SAMPLE-DB-RP1'), 'critical', 'critical (nothing was authorised yet)');
select pg_temp.free(pg_temp.mid(17));
-- Negative control: a debit on an active mandate in force, attached to its plan, raises nothing.
select pg_temp.as_owner();
select pg_temp.mk_mandate(pg_temp.mid(7), pg_temp.lid(5), 'active', 'SAMPLE-PM-E');
select pg_temp.keep('e_d1', pg_temp.mk_debit(pg_temp.mid(7), 1, 3, 475000, 'scheduled', null, 1000)::text);
select pg_temp.as_system();
select is(pg_temp.deliver(pg_temp.lx(), 'SAMPLE-D-306', 'SAMPLE-E-306', 'debit', 'pending', 'SAMPLE-DB-E1', 'SAMPLE-PM-E', 475000, pg_temp.at(0)), 'applied', 'CONTROL: a debit on a mandate in force');
select is(pg_temp.dstatus('SAMPLE-DB-E1'), '(t,presented,475000)', 'is attached to its planned debit');
select is(pg_temp.dsev(pg_temp.got('e_d1')::uuid), null, 'and raises no exception');

-- ============================================================================================================================
-- 5. A51 U1 M46: a cancellation request is not lost; a draft is not closed under the hand-off
-- ============================================================================================================================
-- The borrower asks to cancel a draft while the hand-off is in flight (a worker holds the outbox row).
select pg_temp.as_owner();
select pg_temp.mk_mandate(pg_temp.mid(8), pg_temp.lid(10), 'draft', null);
select pg_temp.keep('c_h', ops.enqueue_event('mandate.handoff', jsonb_build_object('mandate_id', pg_temp.mid(8)), null, 'mandate.handoff:' || pg_temp.mid(8)::text)::text);
select pg_temp.set_replica(true);
update ops.outbox_events set status = 'processing', attempts = 1, locked_by = 'sample-worker', locked_until = now() + interval '10 minutes' where id = pg_temp.got('c_h')::uuid;
select pg_temp.set_replica(false);
select pg_temp.as_user(pg_temp.u(1));
select is(payments.request_mandate_cancellation(pg_temp.mid(8)), 'cancel_requested', 'the borrower cancels a draft whose hand-off is in flight');
select pg_temp.as_system();
select is((payments.sweep_mandates() ->> 'drafts_closed')::integer, 0, 'the sweep does not close it under the worker');
select is(pg_temp.mstatus(pg_temp.mid(8)), 'draft', 'it is still a draft');
select is(payments.record_mandate_handoff(pg_temp.mid(8), 'handoff', 'SAMPLE-PM-C', now() + interval '1 hour'), 'registration_pending', 'the provider call returns: the hand-off is recorded with its reference');
select is((select (provider_mandate_ref, cancel_attempts)::text from payments.mandates where id = pg_temp.mid(8)), '(SAMPLE-PM-C,2)', 'the reference is stored (nothing is dropped) and the cancellation is counted twice');
select is(pg_temp.outbox('mandate.cancel:' || pg_temp.mid(8)::text), 2::bigint, 'the cancellation is queued again under a fresh dedupe key (the first one found no reference)');
select is((select count(*) from ops.outbox_events where dedupe_key = 'mandate.cancel:' || pg_temp.mid(8)::text || ':2' and payload::text ~ '^\{"mandate_id": "[0-9a-f-]{36}"\}$'), 1::bigint, 'naming the mandate by id only');
select pg_temp.free(pg_temp.mid(8));
-- The sweep queues an unacknowledged cancellation again, bounded.
select pg_temp.as_user(pg_temp.u(1));
select pg_temp.as_system();
select is((payments.sweep_mandates() ->> 'cancel_resent')::integer, 0, 'a cancellation queued a moment ago is not queued again');
select pg_temp.as_owner();
select pg_temp.set_replica(true);
update payments.mandates set cancel_enqueued_at = clock_timestamp() - interval '1 hour' where id = pg_temp.mid(4);
select pg_temp.set_replica(false);
select pg_temp.as_system();
select is((payments.sweep_mandates() ->> 'cancel_resent')::integer, 1, 'one that the provider has not acknowledged for half an hour is queued again');
select is(pg_temp.outbox('mandate.cancel:' || pg_temp.mid(4)::text), 2::bigint, 'as a second queue entry under a fresh key');
select is((payments.sweep_mandates() ->> 'cancel_resent')::integer, 0, 'and not again at once');
select pg_temp.as_owner();
select pg_temp.set_replica(true);
update payments.mandates set cancel_enqueued_at = clock_timestamp() - interval '1 hour', cancel_attempts = 48 where id = pg_temp.mid(4);
select pg_temp.set_replica(false);
select pg_temp.as_system();
select is((payments.sweep_mandates() ->> 'cancel_resent')::integer, 0, 'after 48 attempts it is not queued again (the 24-hour exception takes over)');
select pg_temp.as_owner();
select pg_temp.set_replica(true);
update payments.mandates set cancel_enqueued_at = clock_timestamp() - interval '1 hour', cancel_attempts = 3 where id = pg_temp.mid(4);
select pg_temp.set_replica(false);
select pg_temp.as_system();
select is(payments.mark_mandate_cancel_sent(pg_temp.mid(4)), 'ok', 'the worker records that the provider acknowledged it');
select is((payments.sweep_mandates() ->> 'cancel_resent')::integer, 0, 'an acknowledged cancellation is not queued again');
-- A cancellation without a provider reference cannot be sent: not queued again.
select pg_temp.as_owner();
select pg_temp.mk_mandate(pg_temp.mid(9), pg_temp.lid(10), 'requires_reconciliation', null);
select pg_temp.set_replica(true);
update payments.mandates set cancel_requested_at = clock_timestamp() - interval '2 hours', cancel_reason = 'borrower', cancel_attempts = 1, cancel_enqueued_at = clock_timestamp() - interval '2 hours' where id = pg_temp.mid(9);
select pg_temp.set_replica(false);
select pg_temp.as_system();
select is((payments.sweep_mandates() ->> 'cancel_resent')::integer, 0, 'with no provider reference there is nothing to send: not queued');
select is(payments.apply_mandate_lookup(pg_temp.mid(9), 'registration_pending', 'SAMPLE-PM-LK', clock_timestamp()), 'applied', 'a lookup finds the registration and supplies the reference');
select is(pg_temp.outbox('mandate.cancel:' || pg_temp.mid(9)::text), 1::bigint, 'and queues the pending cancellation request (it had never been queued under a key)');
select pg_temp.free(pg_temp.mid(9));

-- The sweep and a draft: what the hand-off row of the outbox says decides.
select is(pg_temp.draft_case(pg_temp.mid(20), pg_temp.lid(10), true, 'pending', 0, interval '1 hour'), 'cancelled', 'cancelled by the borrower and never claimed by a worker: closed (the provider was never asked)');
select is(pg_temp.draft_case(pg_temp.mid(21), pg_temp.lid(10), true, 'processing', 1, interval '1 hour'), 'draft', 'cancelled by the borrower while a worker holds the hand-off: left alone');
select pg_temp.free(pg_temp.mid(21));
select is(pg_temp.draft_case(pg_temp.mid(22), pg_temp.lid(10), true, 'pending', 2, interval '1 hour'), 'requires_reconciliation', 'claimed twice and waiting for a retry: an earlier attempt may have reached the provider');
select is(pg_temp.mexc(pg_temp.mid(22), 'mandate_unresolved'), 1::bigint, 'the platform is told');
select is(payments.record_mandate_handoff(pg_temp.mid(22), 'handoff', 'SAMPLE-PM-R22', null), 'registration_pending', 'the retry comes back with the reference: the unknown outcome is resolved');
select is((select provider_mandate_ref from payments.mandates where id = pg_temp.mid(22)), 'SAMPLE-PM-R22', 'and the reference is stored');
select pg_temp.free(pg_temp.mid(22));
select is(pg_temp.draft_case(pg_temp.mid(23), pg_temp.lid(10), true, 'completed', 1, interval '1 hour'), 'cancelled', 'completed once without a call (it saw the cancellation): closed');
select is(pg_temp.draft_case(pg_temp.mid(24), pg_temp.lid(10), true, 'completed', 3, interval '1 hour'), 'requires_reconciliation', 'completed after several attempts: may have reached the provider');
select pg_temp.free(pg_temp.mid(24));
select is(pg_temp.draft_case(pg_temp.mid(25), pg_temp.lid(10), true, 'dead', 8, interval '1 hour'), 'requires_reconciliation', 'a hand-off that died: may have reached the provider');
select pg_temp.free(pg_temp.mid(25));
select is(pg_temp.draft_case(pg_temp.mid(26), pg_temp.lid(10), false, 'pending', 0, interval '0 seconds'), 'draft', 'an old draft whose hand-off is still queued (an outbox backlog) is NOT closed by age alone');
select pg_temp.free(pg_temp.mid(26));
select is(pg_temp.draft_case(pg_temp.mid(27), pg_temp.lid(10), false, 'processing', 1, interval '0 seconds'), 'draft', 'nor one a worker is holding');
select pg_temp.free(pg_temp.mid(27));
select is(pg_temp.draft_case(pg_temp.mid(28), pg_temp.lid(10), false, 'dead', 8, interval '0 seconds'), 'requires_reconciliation', 'an old draft whose hand-off died: reconciliation, not "cancelled"');
select pg_temp.free(pg_temp.mid(28));
-- A reference arriving for a mandate that was closed meanwhile is kept and flagged (set once), never dropped.
select is(pg_temp.mstatus(pg_temp.mid(20)), 'cancelled', 'mandate 20 was cancelled by the sweep');
select is(payments.record_mandate_handoff(pg_temp.mid(20), 'handoff', 'SAMPLE-PM-LATE', null), 'cancelled', 'the provider''s late answer names the mandate''s state');
select is((select provider_mandate_ref from payments.mandates where id = pg_temp.mid(20)), 'SAMPLE-PM-LATE', 'the provider''s reference is stored, so it can be looked up and matched');
select is(pg_temp.mexc(pg_temp.mid(20), 'mandate_unresolved'), 1::bigint, 'and the platform is told that the provider holds a registration Udofin closed');
select is(payments.record_mandate_handoff(pg_temp.mid(20), 'handoff', 'SAMPLE-PM-LATE', null), 'cancelled', 'a repeat of the same answer changes nothing');
select is(pg_temp.mexc(pg_temp.mid(20), 'mandate_unresolved'), 1::bigint, 'and raises nothing more');
select is(pg_temp.deliver(pg_temp.lx(), 'SAMPLE-D-501', 'SAMPLE-E-501', 'mandate', 'active', 'SAMPLE-PM-LATE', null, null, pg_temp.at(1)), 'exception', 'a later "active" event for that reference is correlated and flagged, not lost as unmatched');
select is(pg_temp.err(format($$select payments.record_mandate_handoff(%L, 'handoff', 'SAMPLE-PM-OTHER', null)$$, pg_temp.mid(20))), 'ok', 'a different reference for a mandate that already has one does not fail the worker');
select is((select provider_mandate_ref from payments.mandates where id = pg_temp.mid(20)), 'SAMPLE-PM-LATE', 'and never replaces it');

-- ============================================================================================================================
-- 6. U2: active and paused mandates are looked up now and then
-- ============================================================================================================================
select is((select count(*) from payments.mandates_needing_lookup() where mandate_id = pg_temp.mid(7)), 0::bigint, 'a mandate looked at a moment ago is not listed');
select pg_temp.as_owner();
select pg_temp.set_replica(true);
update payments.mandates set last_event_at = clock_timestamp() - interval '30 hours', created_at = clock_timestamp() - interval '30 hours' where id = pg_temp.mid(7);
select pg_temp.set_replica(false);
select pg_temp.as_system();
select is((select reason from payments.mandates_needing_lookup() where mandate_id = pg_temp.mid(7)), 'periodic_check', 'an active mandate not looked up for a day is listed for a lookup');
select is(payments.apply_mandate_lookup(pg_temp.mid(7), 'revoked', null, clock_timestamp()), 'applied', 'the lookup finds a revoke whose event never arrived');
select is(pg_temp.mstatus(pg_temp.mid(7)), 'revoked', 'and the mandate is repaired');
select is(pg_temp.dst(pg_temp.got('e_d1')::uuid), 'presented', 'the debit the provider presented keeps its state');
select pg_temp.as_owner();
select pg_temp.mk_mandate(pg_temp.mid(18), pg_temp.lid(5), 'paused', 'SAMPLE-PM-PZ');
select pg_temp.set_replica(true);
update payments.mandates set last_event_at = clock_timestamp() - interval '30 hours', created_at = clock_timestamp() - interval '30 hours' where id = pg_temp.mid(18);
select pg_temp.set_replica(false);
select pg_temp.as_system();
select is((select count(*) from payments.mandates_needing_lookup() where mandate_id = pg_temp.mid(18)), 1::bigint, 'a paused mandate is listed too');
select is(payments.apply_mandate_lookup(pg_temp.mid(18), 'paused', null, clock_timestamp()), 'ignored_stale', 'a lookup that finds nothing new changes nothing');
select is((select count(*) from payments.mandates_needing_lookup() where mandate_id = pg_temp.mid(18)), 0::bigint, 'but it records that the mandate was looked up: not listed again for a day');
select is((select status_checked_at is not null from payments.mandates where id = pg_temp.mid(18)), true, 'the time of the lookup is recorded');
select pg_temp.free(pg_temp.mid(18));
select pg_temp.as_user(pg_temp.u(3));
select is(pg_temp.err($$select * from payments.mandates_needing_lookup()$$), '42501|', 'the list stays for the system only');
select pg_temp.as_system();

-- ============================================================================================================================
-- 7. U4 U5 U7 A58: debit reports (mandate I on loan 9)
-- ============================================================================================================================
select pg_temp.as_owner();
select pg_temp.free(pg_temp.mid(17));
select pg_temp.mk_mandate(pg_temp.mid(10), pg_temp.lid(9), 'active', 'SAMPLE-PM-I');
select pg_temp.as_system();
-- U4 (a): the amount of a debit is recorded once; a later, different amount is an exception, not silence.
select is(pg_temp.deliver(pg_temp.lx(), 'SAMPLE-D-401', 'SAMPLE-E-401', 'debit', 'pending', 'SAMPLE-DB-I1', 'SAMPLE-PM-I', 100000, pg_temp.at(0)), 'applied', 'an unplanned debit is reported pending for 1,000.00');
select is(pg_temp.deliver(pg_temp.lx(), 'SAMPLE-D-402', 'SAMPLE-E-402', 'debit', 'succeeded', 'SAMPLE-DB-I1', 'SAMPLE-PM-I', 3900000, pg_temp.at(0)), 'exception', 'it is then reported settled for 39,000.00');
select is(pg_temp.dstatus('SAMPLE-DB-I1'), '(f,presented,100000)', 'nothing advances on a contradicting amount (the recorded amount never changes)');
select is(pg_temp.dsev_ref('SAMPLE-DB-I1', 'amount_mismatch'), 'critical', 'and the lender has a critical amount mismatch to look at');
-- U4 (b): an event without an amount attaches to the single planned debit in its date window.
select pg_temp.as_owner();
select pg_temp.keep('i_d1', pg_temp.mk_debit(pg_temp.mid(10), 1, 1, 475000, 'scheduled', null, 1000)::text);
select pg_temp.as_system();
select is(pg_temp.deliver(pg_temp.lx(), 'SAMPLE-D-403', 'SAMPLE-E-403', 'debit', 'created', 'SAMPLE-DB-I2', 'SAMPLE-PM-I', null, pg_temp.at(0)), 'ignored_stale', 'the provider says a debit was created, with no amount');
select is((select provider_debit_ref from payments.mandate_debits where id = pg_temp.got('i_d1')::uuid), 'SAMPLE-DB-I2', 'it is attached to the planned debit of that date window');
select is((select count(*) from payments.mandate_debits where mandate_id = pg_temp.mid(10) and provider_debit_ref = 'SAMPLE-DB-I2'), 1::bigint, 'and no duplicate unplanned debit appears');
select is(pg_temp.deliver(pg_temp.lx(), 'SAMPLE-D-404', 'SAMPLE-E-404', 'debit', 'succeeded', 'SAMPLE-DB-I2', 'SAMPLE-PM-I', 475000, pg_temp.at(0)), 'applied', 'when the amount arrives it is the planned one: the debit settles');
select is(pg_temp.dstatus('SAMPLE-DB-I2'), '(t,settled,475000)', 'one debit, planned and settled');
-- U5: statuses the table never knew.
select is(pg_temp.deliver(pg_temp.lx(), 'SAMPLE-D-405', 'SAMPLE-E-405', 'debit', 'rejected', 'SAMPLE-DB-I3', 'SAMPLE-PM-I', 475000, pg_temp.at(0)), 'applied', 'a debit the provider REJECTED');
select is(pg_temp.dstatus('SAMPLE-DB-I3'), '(f,returned,475000)', 'is recorded as returned');
select is(pg_temp.deliver(pg_temp.lx(), 'SAMPLE-D-406', 'SAMPLE-E-406', 'debit', 'expired', 'SAMPLE-DB-I4', 'SAMPLE-PM-I', 100000, pg_temp.at(0)), 'applied', 'a debit that EXPIRED');
select is(pg_temp.dstatus('SAMPLE-DB-I4'), '(f,cancelled,100000)', 'is recorded as cancelled');
select is(pg_temp.deliver(pg_temp.lx(), 'SAMPLE-D-407', 'SAMPLE-E-407', 'debit', 'refunded', 'SAMPLE-DB-I2', 'SAMPLE-PM-I', 475000, pg_temp.at(0)), 'exception', 'a REFUND of a settled debit is an exception, not "stale"');
select is(pg_temp.dstatus('SAMPLE-DB-I2'), '(t,settled,475000)', 'the debit stays as it was');
select is(pg_temp.dsev_ref('SAMPLE-DB-I2'), 'critical', 'and the lender has a critical exception to look at');
select is(pg_temp.deliver(pg_temp.lx(), 'SAMPLE-D-408', 'SAMPLE-E-408', 'debit', 'disputed', 'SAMPLE-DB-I2', 'SAMPLE-PM-I', 475000, pg_temp.at(0)), 'exception', 'so is a DISPUTE');
select is(pg_temp.deliver(pg_temp.lx(), 'SAMPLE-D-409', 'SAMPLE-E-409', 'debit', 'refunded', 'SAMPLE-DB-I9', 'SAMPLE-PM-I', 5000, pg_temp.at(0)), 'exception', 'a refund of a debit nobody knows');
select is(pg_temp.dstatus('SAMPLE-DB-I9'), '(f,unknown,5000)', 'is recorded as an unknown debit and flagged');
select is(pg_temp.dsev_ref('SAMPLE-DB-I9'), 'critical', 'critical');
-- U7: an amount of zero, or above the limit, never makes the whole update fail.
select is(pg_temp.err($$select pg_temp.deliver(pg_temp.lx(), 'SAMPLE-D-410', 'SAMPLE-E-410', 'debit', 'failed', 'SAMPLE-DB-I5', 'SAMPLE-PM-I', 0, pg_temp.at(0))$$), 'ok', 'a failed attempt reported with amount 0 is processed (it used to fail for ever)');
select is(pg_temp.dstatus('SAMPLE-DB-I5'), '(f,returned,)', 'recorded as returned, the amount unknown');
select is(pg_temp.dsev_ref('SAMPLE-DB-I5'), 'warning', 'with a warning for the lender');
select is(pg_temp.err($$select pg_temp.deliver(pg_temp.lx(), 'SAMPLE-D-411', 'SAMPLE-E-411', 'debit', 'succeeded', 'SAMPLE-DB-I6', 'SAMPLE-PM-I', 0, pg_temp.at(0))$$), 'ok', 'a SETTLED debit with amount 0 is processed too');
select is(pg_temp.dstatus('SAMPLE-DB-I6'), '(f,scheduled,)', 'but nothing is settled on an amount that cannot be one');
select is(pg_temp.dsev_ref('SAMPLE-DB-I6'), 'critical', 'and the lender has a critical exception');
select is((select count(*) from payments.event_processing p join payments.provider_events e on e.id = p.event_id where e.provider_event_id in ('SAMPLE-E-410', 'SAMPLE-E-411')), 2::bigint, 'each of the two events has its processing row (none is retried to death)');
-- A58: a return code that is not a code does not fail the report.
select is(pg_temp.err(format($$select payments.apply_debit_lookup(%L, 'SAMPLE-DB-I8', %L, 475000, 'returned', 'Insufficient funds / try later')$$, pg_temp.mid(10), pg_temp.d() + 20)), 'ok', 'a debit report whose return code has spaces and a slash is applied');
select is((select (status, return_code is null, return_class is null)::text from payments.mandate_debits where provider_debit_ref = 'SAMPLE-DB-I8'), '(returned,t,t)', 'the debit is recorded as returned without the code');
select is(pg_temp.dsev_ref('SAMPLE-DB-I8'), 'warning', 'and the lender is told about it');
select is(pg_temp.err(format($$select payments.apply_debit_lookup(%L, 'SAMPLE-DB-I10', %L, 475000, 'returned', %L)$$, pg_temp.mid(10), pg_temp.d() + 21, repeat('R', 80))), 'ok', 'so is one longer than 40 characters');
select is(pg_temp.err(format($$select payments.apply_debit_lookup(%L, 'SAMPLE-DB-I11', %L, 475000, 'settled', 'R01')$$, pg_temp.mid(10), pg_temp.d() + 22)), '22023|bad_request', 'a code on a debit that was not returned is still refused (the caller got it wrong)');
select is(payments.apply_debit_lookup(pg_temp.mid(10), 'SAMPLE-DB-I12', pg_temp.d() + 23, 475000, 'returned', 'SAMPLE-R05'), 'applied', 'a well-formed code is stored verbatim as before');
select is((select return_code from payments.mandate_debits where provider_debit_ref = 'SAMPLE-DB-I12'), 'SAMPLE-R05', 'verbatim');

-- ============================================================================================================================
-- 8. U6: one wrong timestamp cannot freeze a mandate
-- ============================================================================================================================
select pg_temp.as_owner();
select pg_temp.mk_mandate(pg_temp.mid(19), pg_temp.lid(10), 'active', 'SAMPLE-PM-J');
select pg_temp.as_system();
select is(pg_temp.deliver(pg_temp.lx(), 'SAMPLE-D-601', 'SAMPLE-E-601', 'mandate', 'paused', 'SAMPLE-PM-J', null, null, '2126-10-18T10:00:00Z'), 'applied', 'an event dated a century ahead is applied');
select is((select last_event_at < clock_timestamp() + interval '16 minutes' from payments.mandates where id = pg_temp.mid(19)), true, 'but its time is replaced by the clock: it does not move the mandate''s last-event time into the future');
select is(pg_temp.mexc(pg_temp.mid(19), 'mandate_status_conflict'), 1::bigint, 'and the platform is told that a provider sent an impossible time');
select is(pg_temp.deliver(pg_temp.lx(), 'SAMPLE-D-602', 'SAMPLE-E-602', 'mandate', 'active', 'SAMPLE-PM-J', null, null, pg_temp.at(1)), 'applied', 'the next genuine event is applied (the mandate is not frozen)');
select is(pg_temp.deliver(pg_temp.lx(), 'SAMPLE-D-603', 'SAMPLE-E-603', 'mandate', 'revoked', 'SAMPLE-PM-J', null, null, pg_temp.at(2)), 'applied', 'including a revoke');
select is(pg_temp.mstatus(pg_temp.mid(19)), 'revoked', 'which the mandate follows');
-- A lookup with a time in the future is bounded in the same way.
select pg_temp.as_owner();
select pg_temp.mk_mandate(pg_temp.mid(30), pg_temp.lid(10), 'active', 'SAMPLE-PM-J3');
select pg_temp.as_system();
select is(payments.apply_mandate_lookup(pg_temp.mid(30), 'paused', null, clock_timestamp() + interval '2 days'), 'applied', 'a lookup stamped two days ahead is applied');
select is(payments.apply_mandate_lookup(pg_temp.mid(30), 'active', null, clock_timestamp() + interval '1 minute'), 'applied', 'and does not make every later lookup stale');
select pg_temp.free(pg_temp.mid(30));
-- An OLDER report of a revoke or a cancellation for a mandate in force is an exception, not silence.
select pg_temp.as_owner();
select pg_temp.mk_mandate(pg_temp.mid(32), pg_temp.lid(10), 'active', 'SAMPLE-PM-J4');
select pg_temp.as_system();
select is(pg_temp.deliver(pg_temp.lx(), 'SAMPLE-D-604', 'SAMPLE-E-604', 'mandate', 'paused', 'SAMPLE-PM-J4', null, null, pg_temp.at(1)), 'applied', 'the provider pauses a mandate');
select is(pg_temp.deliver(pg_temp.lx(), 'SAMPLE-D-605', 'SAMPLE-E-605', 'mandate', 'revoked', 'SAMPLE-PM-J4', null, null, '2026-10-15T10:00:00Z'), 'exception', 'an older "revoked" report for a mandate in force is an exception');
select is(pg_temp.mstatus(pg_temp.mid(32)), 'paused', 'the mandate does not move on an old report');
select is(pg_temp.mexc(pg_temp.mid(32), 'mandate_status_conflict'), 1::bigint, 'and a person has the conflict to look at');
select is(pg_temp.deliver(pg_temp.lx(), 'SAMPLE-D-606', 'SAMPLE-E-606', 'mandate', 'rejected', 'SAMPLE-PM-J4', null, null, '2026-10-15T10:00:00Z'), 'ignored_stale', 'CONTROL: an older report of any other status is still just stale');
select pg_temp.free(pg_temp.mid(32));

-- ============================================================================================================================
-- 9. Notices after the sweep closed them
-- ============================================================================================================================
select pg_temp.as_owner();
select pg_temp.keep('n_d1', pg_temp.mk_debit(pg_temp.mid(10), 31, 3, 475000, 'scheduled', null, -60)::text);
select pg_temp.as_system();
select is((select count(*) from payments.claim_pre_debit_notices(1000) c where c.debit_id = pg_temp.got('n_d1')::uuid), 1::bigint, 'a live notice is claimed');
select pg_temp.as_owner();
select pg_temp.set_replica(true);
update payments.mandates set status = 'revoked' where id = pg_temp.mid(10);
select pg_temp.set_replica(false);
select pg_temp.as_system();
select is((payments.sweep_mandates() ->> 'notices_closed')::integer >= 1, true, 'the mandate ended without the hook (a hand edit): the sweep still closes the notice');
select is(payments.record_pre_debit_notice((select id from payments.pre_debit_notices where debit_id = pg_temp.got('n_d1')::uuid), 'not_configured'), 'not_configured', 'the worker had leased it and finds no channel');
select is(pg_temp.nstatus(pg_temp.got('n_d1')::uuid), 'not_needed', 'a closed notice is not reopened as "late"');
select is(pg_temp.dcount(pg_temp.got('n_d1')::uuid, 'mandate_notice_late'), 0::bigint, 'and the lender gets no "notice late" for a debit that will never happen');
select is(payments.record_pre_debit_notice((select id from payments.pre_debit_notices where debit_id = pg_temp.got('n_d1')::uuid), 'accepted'), 'accepted', 'a notice that WAS sent is recorded as sent even if it was closed meanwhile');
select is(pg_temp.nstatus(pg_temp.got('n_d1')::uuid), 'sent', 'the truth: the borrower was told');

-- ============================================================================================================================
-- 10. U9: a live mandate stays visible when the lender's mandates switch is off
-- ============================================================================================================================
select pg_temp.as_owner();
select pg_temp.mk_mandate(pg_temp.mid(31), pg_temp.lid(5), 'active', 'SAMPLE-PM-E2');
select pg_temp.keep('e2_d1', pg_temp.mk_debit(pg_temp.mid(31), 1, 3, 475000, 'scheduled', null, -60)::text);
select pg_temp.set_replica(true);
update servicing.lender_features set enabled = false where lender_org_id = pg_temp.lx() and feature = 'mandates';
select pg_temp.set_replica(false);
select pg_temp.as_user(pg_temp.u(2));
select is((select count(*) from payments.my_mandates() where mandate_id = pg_temp.mid(31)), 1::bigint, 'the borrower still sees a live mandate when the lender''s mandates switch is off');
select is((select count(*) from payments.my_mandates() where mandate_id = pg_temp.mid(7)), 0::bigint, 'but not a finished one of that lender');
select is((select next_debit_on is null from payments.my_mandates() where mandate_id = pg_temp.mid(31)), true, 'no next debit is shown (nothing is planned or sent while the switch is off)');
select is(pg_temp.err(format($$select * from payments.my_mandate_debits(%L)$$, pg_temp.mid(31))), 'ok', 'the debits of the live mandate can be read');
select is(pg_temp.err(format($$select * from payments.my_mandate_debits(%L)$$, pg_temp.mid(7))), 'P0002|', 'those of a finished one cannot');
select is(pg_temp.err(format($$select payments.request_mandate(gen_random_uuid(), %L, 'enach_api', 100000, %L, %L, 'XXXXXX9999')$$, pg_temp.lid(5), pg_temp.d() + 1, pg_temp.d() + 100)), '55000|feature_disabled', 'a NEW mandate cannot be asked for while the switch is off');
select is(payments.request_mandate_cancellation(pg_temp.mid(31)), 'cancel_requested', 'the borrower can cancel the live mandate');
select pg_temp.as_system();
select is(pg_temp.claimed(pg_temp.mid(31)), 0::bigint, 'no notice is claimed while the switch is off');
select payments.sweep_mandates();
select is(pg_temp.nstatus(pg_temp.got('e2_d1')::uuid), 'planned', 'and the sweep keeps its notice open (the switch may come back on)');
select pg_temp.as_owner();
select pg_temp.set_replica(true);
update servicing.lender_features set enabled = true where lender_org_id = pg_temp.lx() and feature = 'mandates';
select pg_temp.set_replica(false);
select pg_temp.as_user(pg_temp.u(1));
select is((select count(*) from payments.my_mandates() where mandate_id = pg_temp.mid(2)), 1::bigint, 'with the switch back on, finished mandates are listed again');
select pg_temp.as_system();

-- ============================================================================================================================
-- 11. U8: composite keys and the planned-amount trigger
-- ============================================================================================================================
select pg_temp.as_owner();
select is(pg_temp.err(format($$insert into payments.mandates (id, lender_org_id, config_id, borrower_id, loan_account_id, rail, provider, provider_mode, creditor_ref, max_amount_minor,
    start_date, end_date, masked_account_ref, needs_afa_each_debit, created_by)
  select gen_random_uuid(), l.lender_org_id, c.id, %L::uuid, l.id, 'enach_api', c.provider, 'mock', 'SAMPLE-CREDITOR', 100000, current_date + 1, current_date + 100, 'XXXXXX9999', false, %L::uuid
  from servicing.loan_accounts l join payments.lender_payment_configs c on c.lender_org_id = l.lender_org_id and c.status = 'active' where l.id = %L$$,
  pg_temp.got('b2'), pg_temp.u(1), pg_temp.lid(14))), '23503|', 'a mandate cannot name another borrower than the loan''s own');
select is(pg_temp.err(format($$insert into payments.mandate_debits (lender_org_id, mandate_id, loan_account_id, planned, schedule_snapshot_id, installment_seq, scheduled_on, amount_minor)
  values (%L, %L, %L, true, 'fd500000-0000-4000-8000-000000000002', 50, current_date + 3, 1000)$$, pg_temp.lx(), pg_temp.mid(1), pg_temp.lid(2))), '23503|', 'a debit cannot name another loan than its mandate''s');
select is(pg_temp.err(format($$insert into payments.mandate_debits (lender_org_id, mandate_id, loan_account_id, planned, schedule_snapshot_id, installment_seq, scheduled_on, amount_minor)
  values (%L, %L, %L, true, 'fd500000-0000-4000-8000-000000000002', 51, current_date + 3, 1000)$$, pg_temp.lx(), pg_temp.mid(1), pg_temp.lid(1))), '23503|', 'nor a schedule of another loan');
select is(pg_temp.err(format($$insert into payments.mandate_debits (lender_org_id, mandate_id, loan_account_id, planned, schedule_snapshot_id, installment_seq, scheduled_on, amount_minor)
  values (%L, %L, %L, true, 'fd500000-0000-4000-8000-000000000001', 52, current_date + 3, 4000001)$$, pg_temp.lx(), pg_temp.mid(1), pg_temp.lid(1))), '23514|', 'a PLANNED debit above the mandate maximum (40,000.00) is refused by the database');
select is(pg_temp.err(format($$insert into payments.mandate_debits (lender_org_id, mandate_id, loan_account_id, planned, scheduled_on, amount_minor, exceeds_mandate_max)
  values (%L, %L, %L, false, current_date + 3, 4000001, true)$$, pg_temp.lx(), pg_temp.mid(1), pg_temp.lid(1))), 'ok', 'CONTROL: an UNPLANNED debit above it is recorded (the provider''s debit is flagged, not refused)');
select pg_temp.keep('u8_debit', pg_temp.mk_debit(pg_temp.mid(1), 60, 20, 475000, 'scheduled', null, 1000, false)::text);
select is(pg_temp.err(format($$insert into payments.pre_debit_notices (lender_org_id, debit_id, mandate_id, borrower_id, notice_due_at)
  values (%L, %L, %L, %L, now())$$, pg_temp.lx(), pg_temp.got('u8_debit')::uuid, pg_temp.mid(1), pg_temp.got('b2'))), '23503|', 'a notice cannot name another borrower than its mandate''s');
select is(pg_temp.err(format($$insert into payments.pre_debit_notices (lender_org_id, debit_id, mandate_id, borrower_id, notice_due_at)
  values (%L, %L, %L, %L, now())$$, pg_temp.lx(), pg_temp.got('u8_debit')::uuid, pg_temp.mid(2), pg_temp.got('b1'))), '23503|', 'nor a debit of another mandate');
select is(pg_temp.err(format($$insert into payments.pre_debit_notices (lender_org_id, debit_id, mandate_id, borrower_id, notice_due_at)
  values (%L, %L, %L, %L, now())$$, pg_temp.lx(), pg_temp.got('u8_debit')::uuid, pg_temp.mid(1), pg_temp.got('b1'))), 'ok', 'CONTROL: the right borrower and mandate are accepted');
-- A provider event of another lender (lender Z's mandate F) cannot be pointed at by lender X's rows.
select pg_temp.as_system();
select is(pg_temp.deliver(pg_temp.lz(), 'SAMPLE-D-701', 'SAMPLE-E-701', 'mandate', 'paused', 'SAMPLE-PM-F', null, null, pg_temp.at(1)), 'applied', 'lender Z gets an event for its own mandate');
select pg_temp.as_owner();
select is(pg_temp.err(format($$insert into payments.mandate_events (mandate_id, lender_org_id, from_status, to_status, source, provider_event_id)
  values (%L, %L, 'active', 'paused', 'provider_event', %L)$$, pg_temp.mid(1), pg_temp.lx(), pg_temp.ev('SAMPLE-E-701'))), '23503|', 'a history row of lender X cannot cite lender Z''s provider event');
select is(pg_temp.err(format($$update payments.mandate_debits set last_event_id = %L where id = %L$$, pg_temp.ev('SAMPLE-E-701'), pg_temp.got('u8_debit')::uuid)), '23503|', 'nor can a debit of lender X');
select is(pg_temp.err(format($$update payments.mandate_debits set last_event_id = %L where id = %L$$, pg_temp.ev('SAMPLE-E-201'), pg_temp.got('u8_debit')::uuid)), 'ok', 'CONTROL: its own lender''s event can be cited');

-- ============================================================================================================================
-- 12. U10: the guards of a new mandate, the actor check, and "a returned debit creates no charge"
-- ============================================================================================================================
select pg_temp.as_owner();
select pg_temp.stepup(pg_temp.got('b1'), pg_temp.mid(40));
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err(format($$select payments.request_mandate(%L, %L, 'enach_api', 100000, %L, %L, 'XXXXXX9999')$$, pg_temp.mid(40), pg_temp.lid(8), pg_temp.d() + 1, pg_temp.d() + 100)), '55000|loan_not_active',
  'a mandate cannot be asked for on a closed loan');
select pg_temp.as_owner();
-- config_ambiguous: a second ACTIVE configuration of lender X (a copy of the first with its own keys).
create temp table sm_cfg_copy as select * from payments.lender_payment_configs where lender_org_id = pg_temp.lx() and status = 'active';
update sm_cfg_copy set id = gen_random_uuid(), endpoint_token_hash = encode(sha256(convert_to('SAMPLE-TOKEN-SECOND', 'UTF8')), 'hex'), idempotency_key = 'sample-second-config-0001';
select pg_temp.set_replica(true);
insert into payments.lender_payment_configs select * from sm_cfg_copy;
select pg_temp.set_replica(false);
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err(format($$select payments.request_mandate(%L, %L, 'enach_api', 100000, %L, %L, 'XXXXXX9999')$$, pg_temp.mid(40), pg_temp.lid(9), pg_temp.d() + 1, pg_temp.d() + 100)), '55000|config_ambiguous',
  'two active payment configurations of one lender: refused (config_ambiguous)');
select pg_temp.as_owner();
select pg_temp.set_replica(true);
update payments.lender_payment_configs set status = 'suspended', status_reason = 'SAMPLE: second fixture configuration', status_changed_at = now() where idempotency_key = 'sample-second-config-0001';
-- creditor_not_lender is defence in depth behind the collection-target check, which refuses a merchant of another organisation first.
update payments.merchant_registry set owner_org_id = pg_temp.lz() where owner_org_id = pg_temp.lx();
select pg_temp.set_replica(false);
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err(format($$select payments.request_mandate(%L, %L, 'enach_api', 100000, %L, %L, 'XXXXXX9999')$$, pg_temp.mid(40), pg_temp.lid(9), pg_temp.d() + 1, pg_temp.d() + 100)), '55000|collection_target_invalid',
  'a merchant that is not the lender''s own cannot be the creditor: refused');
select pg_temp.as_owner();
select pg_temp.set_replica(true);
update payments.merchant_registry set owner_org_id = pg_temp.lx() where provider = 'mock_gateway' and merchant_ref = 'SAMPLE-MERCHANT-' || left(md5(pg_temp.lx()::text), 12);
select pg_temp.set_replica(false);
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err(format($$select payments.request_mandate(%L, %L, 'enach_api', 100000, %L, %L, 'XXXXXX9999')$$, pg_temp.mid(40), pg_temp.lid(9), pg_temp.d() + 1, pg_temp.d() + 100)), 'ok',
  'CONTROL: with the lender''s own merchant and one configuration the same request is accepted');
-- The actor check of the protect trigger (the table grants are not what stops these): the new draft is moved by a function with the owner's rights.
select pg_temp.as_user(pg_temp.u(3));
select is(pg_temp.err(format($$select pg_temp.try_move(%L)$$, pg_temp.mid(40))), '42501|', 'even a function with the owner''s rights cannot move a mandate when a lender user is the caller');
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err(format($$select pg_temp.try_move(%L)$$, pg_temp.mid(40))), '42501|', 'nor when the borrower is');
select pg_temp.as_owner();
-- A returned debit creates no charge: the rows of every other table are counted before and after.
create temp table sm_counts_before as
  select t.table_schema, t.table_name, (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', t.table_schema, t.table_name), false, true, '')))[1]::text::bigint as n
  from information_schema.tables t
  where t.table_schema in ('payments', 'servicing', 'lending') and t.table_type = 'BASE TABLE'
    and t.table_name not in ('mandates', 'mandate_events', 'mandate_debits', 'pre_debit_notices', 'reconciliation_exceptions', 'reconciliation_exception_events',
                             'provider_events', 'event_processing', 'webhook_receipts', 'mandate_return_codes');
select pg_temp.mk_mandate(pg_temp.mid(41), pg_temp.lid(2), 'active', 'SAMPLE-PM-Q');
select pg_temp.as_system();
select is(pg_temp.deliver(pg_temp.lx(), 'SAMPLE-D-801', 'SAMPLE-E-801', 'debit', 'pending', 'SAMPLE-DB-Q1', 'SAMPLE-PM-Q', 475000, pg_temp.at(0)), 'applied', 'a debit is presented');
select is(pg_temp.deliver(pg_temp.lx(), 'SAMPLE-D-802', 'SAMPLE-E-802', 'debit', 'returned', 'SAMPLE-DB-Q1', 'SAMPLE-PM-Q', 475000, pg_temp.at(0)), 'applied', 'and returned');
select is(payments.apply_debit_lookup(pg_temp.mid(41), 'SAMPLE-DB-Q1', pg_temp.d(), 475000, 'returned', 'SAMPLE-R77'), 'applied', 'the provider''s return code arrives');
select pg_temp.as_owner();
select is((select count(*) from payments.mandate_debits where provider_debit_ref = 'SAMPLE-DB-Q1' and status = 'returned' and return_code = 'SAMPLE-R77'), 1::bigint, 'the debit is returned with its code');
create temp table sm_counts_after as
  select t.table_schema, t.table_name, (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', t.table_schema, t.table_name), false, true, '')))[1]::text::bigint as n
  from information_schema.tables t
  where t.table_schema in ('payments', 'servicing', 'lending') and t.table_type = 'BASE TABLE'
    and t.table_name not in ('mandates', 'mandate_events', 'mandate_debits', 'pre_debit_notices', 'reconciliation_exceptions', 'reconciliation_exception_events',
                             'provider_events', 'event_processing', 'webhook_receipts', 'mandate_return_codes');
select is((select count(*) from sm_counts_before), (select count(*) from sm_counts_after), 'the same set of tables is counted before and after');
select is((select count(*) > 20 from sm_counts_before), true, 'and it is a real set (every payments, servicing and lending table that is not part of mandate processing)');
select is((select array_agg(b.table_schema || '.' || b.table_name order by b.table_name) from sm_counts_before b join sm_counts_after a using (table_schema, table_name) where a.n <> b.n), null,
  'no other table changed: a returned debit creates no payment, adjustment, charge or any other row (processing only writes the mandate tables, the exception queue and the event log)');

select * from finish();
rollback;
