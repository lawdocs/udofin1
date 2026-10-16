-- Phase 08a reminders and service communications (migration 20261018000914). In-app and push only: sms is a suppressed placeholder, never sent. Wording is
-- the lender's, approved by a second person, and never marketing. Overdue reminders carry the lender's approved penal-charge sentence or are not sent
-- (nothing is invented). The window, the daily cap, the quiet period after a payment and holds all stop a message with a recorded reason. Synthetic data only
-- (labelled SAMPLE). Error codes are reported as SQLSTATE|hint.
begin;
create extension if not exists pgtap with schema extensions;
select plan(205);

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
create function pg_temp.u(n integer) returns uuid language sql as $fn$ select ('fa000000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid $fn$;
create function pg_temp.sha(k text) returns text language sql as $fn$ select encode(sha256(convert_to('SAMPLE-020-' || k, 'UTF8')), 'hex') $fn$;
create function pg_temp.lx() returns uuid language sql as $fn$ select 'fab00000-0000-4000-8000-000000000001'::uuid $fn$;
create function pg_temp.ly() returns uuid language sql as $fn$ select 'fab00000-0000-4000-8000-000000000002'::uuid $fn$;
create function pg_temp.lid(n integer) returns uuid language sql as $fn$ select ('fa400000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid $fn$;
create function pg_temp.d() returns date language sql as $fn$ select (now() at time zone 'Asia/Kolkata')::date $fn$;
-- Judge the window at a fixed IST time of day (the seam only the window check reads; allowed in non-production sessions).
create function pg_temp.at_ist(p_time text) returns void language plpgsql as $fn$
begin
  perform set_config('udofin.allow_mock_providers', 'on', true);
  perform set_config('udofin.test_clock', '2026-03-10 ' || p_time || '+05:30', true);
end
$fn$;
-- Reminders of a loan as 'status:suppress_reason:channel:offset', in a stable order.
create function pg_temp.rems(p_loan uuid) returns text language sql as $fn$
  select string_agg(r.status || coalesce(':' || r.suppress_reason, '') || ':' || r.channel || ':' || r.offset_days, ',' order by r.offset_days, r.channel)
  from servicing.reminders r where r.loan_account_id = p_loan
$fn$;
-- Make every planned reminder of a loan due (an hour ago) so a test does not depend on the time of day it runs.
create function pg_temp.due_now(p_loan uuid) returns void language sql as $fn$
  update servicing.reminders set scheduled_for = now() - interval '1 hour' + offset_days * interval '1 minute' where loan_account_id = p_loan and status = 'planned'
$fn$;
grant execute on all functions in schema pg_temp to public;

-- Fixture -----------------------------------------------------------------------------------------------------------------------
-- Users: 01 borrower b1, 02 borrower b2 (Hindi), 03 lender X communications admin, 04 lender X communications approver, 05 lender X servicing operator
-- (reads loans only), 06 lender Y communications admin, 07 and 08 platform users (switch fixture), 09 lender X second approver, 10 and 11 lender admin and
-- product approver (only so that the loan product fixture passes its maker-checker triggers).
insert into auth.users (id, phone, raw_app_meta_data)
select pg_temp.u(n), case when n in (1, 2) then '9100000009' || n end, case when n in (1, 2) then '{}'::jsonb else '{"actor_type":"staff"}'::jsonb end from generate_series(1, 11) n;
select pg_temp.keep('b1', (select id::text from identity.borrowers where user_id = pg_temp.u(1)));
select pg_temp.keep('b2', (select id::text from identity.borrowers where user_id = pg_temp.u(2)));

select pg_temp.as_owner();
update identity.borrowers set preferred_language = 'hi' where id = pg_temp.got('b2')::uuid;
insert into tenancy.organizations (id, kind, legal_name, display_name, regulator_registration_no, status) values
  ('faa00000-0000-4000-8000-000000000000', 'platform', 'Udofin Platform (test)', 'Udofin', null, 'active'),
  (pg_temp.lx(), 'lender', 'Alpha Finance Ltd (test)', 'Alpha', 'TEST-FA-0001', 'active'),
  (pg_temp.ly(), 'lender', 'Beta Capital Ltd (test)', 'Beta', 'TEST-FA-0002', 'active');
insert into onboarding.lender_gates (lender_org_id, stage) values (pg_temp.lx(), 'activated'), (pg_temp.ly(), 'activated');
insert into tenancy.memberships (id, org_id, user_id, status) values
  ('fac10000-0000-4000-8000-000000000003', pg_temp.lx(), pg_temp.u(3), 'active'),
  ('fac10000-0000-4000-8000-000000000004', pg_temp.lx(), pg_temp.u(4), 'active'),
  ('fac10000-0000-4000-8000-000000000005', pg_temp.lx(), pg_temp.u(5), 'active'),
  ('fac10000-0000-4000-8000-000000000006', pg_temp.ly(), pg_temp.u(6), 'active'),
  ('fac10000-0000-4000-8000-000000000009', pg_temp.lx(), pg_temp.u(9), 'active'),
  ('fac10000-0000-4000-8000-000000000019', pg_temp.lx(), pg_temp.u(10), 'active'),
  ('fac10000-0000-4000-8000-000000000020', pg_temp.lx(), pg_temp.u(11), 'active'),
  ('fac10000-0000-4000-8000-000000000021', pg_temp.ly(), pg_temp.u(10), 'active'),
  ('fac10000-0000-4000-8000-000000000022', pg_temp.ly(), pg_temp.u(11), 'active');
insert into tenancy.membership_roles (membership_id, role_id)
select g.mid::uuid, r.id from (values
  ('fac10000-0000-4000-8000-000000000003', 'communications_admin'), ('fac10000-0000-4000-8000-000000000004', 'communications_approver'),
  ('fac10000-0000-4000-8000-000000000005', 'servicing_operator'), ('fac10000-0000-4000-8000-000000000006', 'communications_admin'),
  ('fac10000-0000-4000-8000-000000000009', 'communications_approver'),
  ('fac10000-0000-4000-8000-000000000019', 'lender_admin'), ('fac10000-0000-4000-8000-000000000020', 'product_approver'),
  ('fac10000-0000-4000-8000-000000000021', 'lender_admin'), ('fac10000-0000-4000-8000-000000000022', 'product_approver')) as g (mid, rkey)
join tenancy.roles r on r.org_id is null and r.applies_to = 'lender' and r.key = g.rkey;

-- Switches (an applied request and the switch, as 019 does): lender X runs servicing_sync, reminders and statements_noc; lender Y only servicing_sync.
insert into servicing.feature_change_requests (lender_org_id, feature, enable, mode, status, evidence, requested_by, idempotency_key, decided_by, decided_at, applied_at)
select o.lender, f.feature, true, 'two_person', 'applied', '{"contract_ref":"SAMPLE-FA"}', pg_temp.u(7), 'fa-req-' || f.feature || '-' || right(o.lender::text, 1) || '-0001', pg_temp.u(8), now(), now()
from (values (pg_temp.lx()), (pg_temp.ly())) o (lender)
cross join (values ('servicing_sync'), ('reminders'), ('statements_noc')) f (feature)
where not (o.lender = pg_temp.ly() and f.feature <> 'servicing_sync');
insert into servicing.lender_features (lender_org_id, feature, enabled, evidence, enabled_by, enabled_at, last_change_request_id)
select r.lender_org_id, r.feature, true, r.evidence, pg_temp.u(8), now(), r.id from servicing.feature_change_requests r;

-- Loans: 1 main path (b1), 2 overdue (b2, Hindi), 3 hold (b1), 4 recent payment (b1), 5 already paid (b1), 6 closed later (b1), 7 lender Y (b1).
insert into lending.loan_products (id, lender_org_id, category_key, code, name, status) values
  ('fa900000-0000-4000-8000-000000000001', pg_temp.lx(), 'personal', 'PL-FA', 'X Personal Loan', 'active'),
  ('fa900000-0000-4000-8000-000000000002', pg_temp.ly(), 'personal', 'PL-FA', 'Y Personal Loan', 'active');
insert into lending.loan_product_versions (id, product_id, lender_org_id, version, status, min_amount_minor, max_amount_minor, min_tenure_days, max_tenure_days,
  rate_type, min_annual_rate_bps, max_annual_rate_bps, drafted_by, approved_by, approved_at, effective_from)
select ('fa910000-0000-4000-8000-00000000000' || n)::uuid, ('fa900000-0000-4000-8000-00000000000' || n)::uuid, ('fab00000-0000-4000-8000-00000000000' || n)::uuid, 1, 'approved',
       1000000, 50000000, 180, 1825, 'fixed', 1400, 2400, pg_temp.u(10), pg_temp.u(11), now(), now()
from generate_series(1, 2) n;
insert into lending.loan_requests (id, borrower_id, category_key, requested_amount_minor, requested_tenure_days, purpose_code, status)
select ('fa700000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, case when n = 2 then pg_temp.got('b2')::uuid else pg_temp.got('b1')::uuid end, 'personal', 5000000, 365, 'education', 'submitted'
from generate_series(1, 7) n;
insert into lending.applications (id, lender_org_id, loan_request_id, borrower_id, product_version_id, status, requested_amount_minor, requested_tenure_days, lender_reference)
select ('fa200000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, case when n = 7 then pg_temp.ly() else pg_temp.lx() end,
       ('fa700000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, case when n = 2 then pg_temp.got('b2')::uuid else pg_temp.got('b1')::uuid end,
       case when n = 7 then 'fa910000-0000-4000-8000-000000000002' else 'fa910000-0000-4000-8000-000000000001' end::uuid, 'disbursed', 5000000, 365, 'SAMPLE-APP-' || n
from generate_series(1, 7) n;
insert into servicing.loan_accounts (id, lender_org_id, application_id, borrower_id, source_system, lms_loan_ref, status, sanctioned_amount_minor)
select pg_temp.lid(n), a.lender_org_id, a.id, a.borrower_id, 'lender_lms', 'SAMPLE-LN-' || n, 'active', 5000000
from lending.applications a, generate_series(1, 7) n where right(a.id::text, 2)::int = n;

-- The lender-reported figures (fresh, an hour old). Every loan but 2: 4,750.00 due tomorrow, nothing overdue. Loan 2: 1,000.00 overdue, 4 days past due.
insert into servicing.balance_snapshots (lender_org_id, loan_account_id, version, status, outstanding_principal_minor, overdue_principal_minor, overdue_interest_minor,
  penal_charges_minor, other_charges_minor, total_overdue_minor, next_due_on, next_due_minor, days_past_due, source_system, source_record_id, reported_as_of, content_sha256)
select l.lender_org_id, l.id, 1, 'active', 4000000, case when l.lms_loan_ref = 'SAMPLE-LN-2' then 80000 else 0 end, case when l.lms_loan_ref = 'SAMPLE-LN-2' then 20000 else 0 end,
       0, 0, case when l.lms_loan_ref = 'SAMPLE-LN-2' then 100000 else 0 end,
       case when l.lms_loan_ref = 'SAMPLE-LN-2' then pg_temp.d() + 26 else pg_temp.d() + 1 end, 475000,
       case when l.lms_loan_ref = 'SAMPLE-LN-2' then 4 else 0 end, 'file_import', 'SRC-' || l.lms_loan_ref, clock_timestamp() - interval '1 hour', pg_temp.sha('snap-' || l.lms_loan_ref)
from servicing.loan_accounts l;
-- Loan 5 pays: a newer report moves the next due date past the installment.
insert into servicing.balance_snapshots (lender_org_id, loan_account_id, version, status, outstanding_principal_minor, total_overdue_minor, next_due_on, next_due_minor,
  days_past_due, source_system, source_record_id, reported_as_of, content_sha256)
values (pg_temp.lx(), pg_temp.lid(5), 2, 'active', 3600000, 0, pg_temp.d() + 31, 475000, 0, 'file_import', 'SRC-SAMPLE-LN-5-B', clock_timestamp() - interval '30 minutes', pg_temp.sha('snap-5b'));
insert into servicing.schedule_snapshots (id, lender_org_id, loan_account_id, version)
select ('fa500000-0000-4000-8000-0000000000' || lpad(right(l.id::text, 2)::int::text, 2, '0'))::uuid, l.lender_org_id, l.id, 1 from servicing.loan_accounts l;
-- Schedule: loan 2's oldest overdue installment fell due 4 days before the report; the others have installments due tomorrow and in a month.
insert into servicing.schedule_installments (snapshot_id, lender_org_id, seq, due_date, principal_minor, interest_minor)
select s.id, s.lender_org_id, 1,
       case when s.loan_account_id = pg_temp.lid(2)
            then (select (b.reported_as_of at time zone 'Asia/Kolkata')::date - 4 from servicing.balance_snapshots b where b.loan_account_id = s.loan_account_id and b.version = 1)
            else pg_temp.d() + 1 end, 400000, 75000
from servicing.schedule_snapshots s;
insert into servicing.schedule_installments (snapshot_id, lender_org_id, seq, due_date, principal_minor, interest_minor)
select s.id, s.lender_org_id, 2,
       case when s.loan_account_id = pg_temp.lid(2)
            then (select (b.reported_as_of at time zone 'Asia/Kolkata')::date + 26 from servicing.balance_snapshots b where b.loan_account_id = s.loan_account_id and b.version = 1)
            else pg_temp.d() + 31 end, 400000, 75000
from servicing.schedule_snapshots s;
select pg_temp.as_system();

-- ============================================================================================================================
-- 1. Structure, grants, vocabulary
-- ============================================================================================================================
select is((select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'servicing' and c.relname in ('reminder_policies', 'reminder_templates', 'penal_charge_texts', 'communication_holds', 'reminders', 'reminder_deliveries')
             and c.relrowsecurity and c.relforcerowsecurity), 6::bigint, 'row level security is enabled and forced on all six new tables');
select is((select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'servicing' and c.relname in ('reminder_policies', 'reminder_templates', 'penal_charge_texts', 'communication_holds', 'reminders', 'reminder_deliveries')
             and obj_description(c.oid, 'pg_class') like '%Owner: servicing module.'), 6::bigint, 'every new table has a comment naming its owner module');
select is((select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'servicing' and t.tgname = 'no_truncate' and not t.tgisinternal
             and c.relname in ('reminder_policies', 'reminder_templates', 'penal_charge_texts', 'communication_holds', 'reminders', 'reminder_deliveries')), 6::bigint, 'a no_truncate trigger is on every new table');
select ok((select bool_and(has_table_privilege('service_role', t, 'select') and not has_table_privilege('service_role', t, 'insert') and not has_table_privilege('service_role', t, 'update')
                           and not has_table_privilege('service_role', t, 'delete'))
           from unnest(array['servicing.reminder_policies', 'servicing.reminder_templates', 'servicing.penal_charge_texts', 'servicing.communication_holds', 'servicing.reminders',
                             'servicing.reminder_deliveries']) t), 'the system role can only READ the reminder tables: every write goes through a definer function');
select ok((select bool_and(not has_table_privilege('authenticated', t, 'insert') and not has_table_privilege('authenticated', t, 'update') and not has_table_privilege('authenticated', t, 'delete'))
           from unnest(array['servicing.reminder_policies', 'servicing.reminder_templates', 'servicing.penal_charge_texts', 'servicing.communication_holds', 'servicing.reminders',
                             'servicing.reminder_deliveries']) t), 'no signed-in role can write them directly');
select ok((select bool_and(not has_function_privilege('anon', f, 'execute'))
           from unnest(array['servicing.draft_reminder_policy(uuid, integer[], boolean, text[], time, time, integer)', 'servicing.approve_reminder_policy(uuid)',
                             'servicing.plan_reminders(interval, integer)', 'servicing.claim_due_reminders(integer, interval)', 'servicing.my_reminders()',
                             'servicing.record_reminder_attempt(uuid, text, text, text, text)', 'servicing.place_communication_hold(uuid, text, text)']) f), 'anon can execute none of the reminder functions');
select ok((select bool_and(not has_function_privilege('authenticated', f, 'execute'))
           from unnest(array['servicing.plan_reminders(interval, integer)', 'servicing.claim_due_reminders(integer, interval)', 'servicing.record_reminder_attempt(uuid, text, text, text, text)',
                             'servicing.suppress_reminders_for_loan(uuid, text)']) f), 'a signed-in user cannot run the system functions');
select ok((select bool_and(not has_function_privilege('service_role', f, 'execute'))
           from unnest(array['servicing.draft_reminder_policy(uuid, integer[], boolean, text[], time, time, integer)', 'servicing.approve_reminder_template(uuid)',
                             'servicing.draft_penal_charge_text(uuid, text, bigint, integer, boolean, boolean, text, text, text)', 'servicing.my_reminders()']) f), 'the system role cannot author, approve or act as a borrower');
select is((select count(*) from information_schema.columns where table_schema = 'servicing' and table_name in ('reminders', 'reminder_deliveries')
             and column_name ~* '(phone|mobile|\mpan\M|aadhaar|name|email|address|token|otp|body|message)'), 0::bigint, 'no reminder or delivery column can hold personal data, a token or message text (only hashes and references)');
select is((select array_agg(distinct kind order by kind) from servicing.reminders), null, 'nothing is planned before the planner runs');
select pg_temp.as_owner();
select is(private.format_inr_minor(0) || '|' || private.format_inr_minor(99) || '|' || private.format_inr_minor(100000) || '|' || private.format_inr_minor(12345678) || '|' || private.format_inr_minor(123456789012),
  'Rs 0.00|Rs 0.99|Rs 1,000.00|Rs 1,23,456.78|Rs 1,23,45,67,890.12', 'amounts are shown in rupees with Indian digit grouping, from paise');
select is(array(select (private.reminder_params()).window_from::text || '-' || (private.reminder_params()).window_to::text || ',' || (private.reminder_params()).max_per_day || ',' || (private.reminder_params()).suppress_hours),
  array['08:00:00-19:00:00,2,48'], 'with only draft rules the conservative defaults apply: 08:00 to 19:00 IST, 2 a day, 48 hours after a payment');
select is(private.reminder_in_window('2026-03-10 07:59:59+05:30', time '08:00', time '19:00') || '|' || private.reminder_in_window('2026-03-10 08:00:00+05:30', time '08:00', time '19:00') || '|'
          || private.reminder_in_window('2026-03-10 18:59:59+05:30', time '08:00', time '19:00') || '|' || private.reminder_in_window('2026-03-10 19:00:00+05:30', time '08:00', time '19:00'),
  'false|true|true|false', 'the window starts at 08:00 inclusive and ends at 19:00 exclusive, judged in IST');
select is(private.reminder_in_window('2026-03-10 02:45:00+00', time '08:00', time '19:00'), true, 'the window is judged in Indian time, not UTC (02:45 UTC is 08:15 IST)');

-- ============================================================================================================================
-- 2. Wording: service messages only
-- ============================================================================================================================
select is(private.reminder_text_ok('Reminder from {{lender_name}}: {{amount}} is due on {{due_date}}.', true), true, 'a plain service message with the allowed variables passes');
select is(private.reminder_text_ok('Reminder: see https://example.test/pay for details', true), false, 'a link is refused');
select is(private.reminder_text_ok('Reminder: write to someone@example.test about this', true), false, 'an e-mail address is refused');
select is(private.reminder_text_ok('Reminder: call 9000000001 about this instalment', true), false, 'a run of eight or more digits (a phone number) is refused');
select is(private.reminder_text_ok('Reminder for ABCDE1234F about this instalment', true), false, 'a PAN-shaped token is refused');
select is(private.reminder_text_ok('Special offer: pay today and win a cashback reward', true), false, 'promotional wording is refused');
select is(private.reminder_text_ok('You are pre-approved for a new loan, apply now', true), false, 'cross-sell wording is refused');
select is(private.reminder_text_ok('Reminder: {{borrower_name}} owes {{amount}} soon', true), false, 'a variable outside the closed set is refused');
select is(private.reminder_text_ok('Reminder: {{amount}} is due soon', false), false, 'placeholders are refused where none are allowed (a stored sentence)');
select is(private.reminder_text_ok('Short', true), false, 'a message that is too short is refused');
select is(private.reminder_text_ok(repeat('a ', 500), true), false, 'a message that is too long is refused');
select is(private.reminder_text_ok('Your payment is due. <script>alert(1)</script>', true), false, 'markup is refused');
select is(private.reminder_text_ok('आपकी किस्त {{amount}} देय है। कृपया समय पर भुगतान करें।', true), true, 'Hindi wording of the same shape passes');

-- ============================================================================================================================
-- 3. Policy, wording and penal-charge text: draft by one person, approve by another
-- ============================================================================================================================
select pg_temp.as_user(pg_temp.u(3));
select pg_temp.keep('pol1', servicing.draft_reminder_policy(pg_temp.lx(), array[-1, 0, 3], true, array['in_app', 'push', 'sms'], time '09:00', time '18:00', 2)::text);
select is((select (version, status, window_from, window_to, max_per_day)::text from servicing.reminder_policies where id = pg_temp.got('pol1')::uuid), '(1,draft,09:00:00,18:00:00,2)', 'a policy starts as a draft');
select is(pg_temp.err($$select servicing.draft_reminder_policy(pg_temp.lx(), array[-1, -1], true, array['in_app'], time '09:00', time '18:00', 2)$$), '22023|offsets_invalid', 'repeated offsets are refused');
select is(pg_temp.err($$select servicing.draft_reminder_policy(pg_temp.lx(), array[120], true, array['in_app'], time '09:00', time '18:00', 2)$$), '22023|offsets_invalid', 'an offset beyond 90 days is refused');
select is(pg_temp.err($$select servicing.draft_reminder_policy(pg_temp.lx(), array[1], true, array['email'], time '09:00', time '18:00', 2)$$), '22023|channels_invalid', 'an unknown channel (e-mail) is refused');
select is(pg_temp.err($$select servicing.draft_reminder_policy(pg_temp.lx(), array[1], true, array['in_app'], time '07:00', time '18:00', 2)$$), '22023|window_invalid', 'a window opening before 08:00 is refused');
select is(pg_temp.err($$select servicing.draft_reminder_policy(pg_temp.lx(), array[1], true, array['in_app'], time '09:00', time '21:00', 2)$$), '22023|window_invalid', 'a window closing after 19:00 is refused');
select is(pg_temp.err($$select servicing.draft_reminder_policy(pg_temp.lx(), array[1], true, array['in_app'], time '09:00', time '18:00', 3)$$), '22023|policy_invalid', 'more than two messages a day is refused');
select pg_temp.as_user(pg_temp.u(3), 'aal1');
select is(pg_temp.err($$select servicing.draft_reminder_policy(pg_temp.lx(), array[1], true, array['in_app'], time '09:00', time '18:00', 2)$$), '42501|mfa_required', 'a session without the second factor cannot draft');
select pg_temp.as_user(pg_temp.u(5));
select is(pg_temp.err($$select servicing.draft_reminder_policy(pg_temp.lx(), array[1], true, array['in_app'], time '09:00', time '18:00', 2)$$), '42501|', 'a user who only reads loans cannot draft');
select pg_temp.as_user(pg_temp.u(4));
select is(pg_temp.err($$select servicing.draft_reminder_policy(pg_temp.lx(), array[1], true, array['in_app'], time '09:00', time '18:00', 2)$$), '42501|', 'the approver cannot draft');
select is(pg_temp.err(format($$select servicing.approve_reminder_policy(%L)$$, pg_temp.got('pol1'))), 'ok', 'a different person with the approval permission approves the draft');
select pg_temp.as_owner();
select is((select (status, approved_by = pg_temp.u(4))::text from servicing.reminder_policies where id = pg_temp.got('pol1')::uuid), '(approved,t)', 'the approval is attributed to the approver');
select is(pg_temp.err($$update servicing.reminder_policies set offsets_days = array[5] where version = 1$$), 'P0001|', 'an approved policy keeps its content: a change is a new version');
select is(pg_temp.err($$update servicing.reminder_policies set status = 'draft' where version = 1$$), 'P0001|', 'and cannot go back to a draft');
select is(pg_temp.err($$delete from servicing.reminder_policies$$), 'P0001|Record a compensating entry instead.', 'nor be deleted');
select pg_temp.as_user(pg_temp.u(3));
select pg_temp.keep('pol2', servicing.draft_reminder_policy(pg_temp.lx(), array[-1, 0, 3], true, array['in_app'], time '10:00', time '17:00', 1)::text);
select is((select version from servicing.reminder_policies where id = pg_temp.got('pol2')::uuid), 2, 'the next draft is version 2');
select pg_temp.as_user(pg_temp.u(6));
select is(pg_temp.err(format($$select servicing.approve_reminder_policy(%L)$$, pg_temp.got('pol2'))), 'P0002|', 'another lender''s user cannot approve (the policy looks unknown to them)');
select is(pg_temp.err(format($$select servicing.retire_reminder_policy(%L)$$, pg_temp.got('pol2'))), 'P0002|', 'nor retire it');
select pg_temp.as_user(pg_temp.u(3));
select is(pg_temp.err(format($$select servicing.approve_reminder_policy(%L)$$, pg_temp.got('pol2'))), 'P0002|', 'the drafter cannot approve: without the approval permission the policy looks unknown');
select pg_temp.as_owner();
-- A draft written by someone who also holds the approval permission (only possible by direct fixture) still cannot approve its own.
insert into servicing.reminder_policies (lender_org_id, version, offsets_days, channels, window_from, window_to, max_per_day, drafted_by)
values (pg_temp.lx(), 3, array[0], array['in_app'], time '09:00', time '18:00', 2, pg_temp.u(4));
select pg_temp.as_user(pg_temp.u(4));
select is(pg_temp.err($$select servicing.approve_reminder_policy((select id from servicing.reminder_policies where version = 3 and lender_org_id = pg_temp.lx()))$$), '42501|self_approval', 'the person who drafted it cannot approve it');
select pg_temp.as_owner();
delete from servicing.reminder_policies where version = 3 and false;
select is(pg_temp.err($$select servicing.approve_reminder_policy(gen_random_uuid())$$), 'P0002|', 'a policy that does not exist answers not found');
select pg_temp.as_user(pg_temp.u(3));
select is(servicing.retire_reminder_policy(pg_temp.got('pol2')::uuid), 'retired', 'a draft can be retired');
select is(pg_temp.err(format($$select servicing.retire_reminder_policy(%L)$$, pg_temp.got('pol2'))), '55000|already_retired', 'but not twice');
select is((select count(*) from servicing.reminder_policies where lender_org_id = pg_temp.lx() and status = 'approved'), 1::bigint, 'exactly one approved policy is in force');

-- Wording ---------------------------------------------------------------------------------------------------------------------
select is(pg_temp.err($$select servicing.draft_reminder_template(pg_temp.lx(), 'pre_due', 'en', 'Visit https://example.test now to pay')$$), '22023|wording_invalid', 'wording with a link is refused');
select is(pg_temp.err($$select servicing.draft_reminder_template(pg_temp.lx(), 'pre_due', 'en', 'Special offer on your next loan if you pay today')$$), '22023|wording_invalid', 'promotional wording is refused');
select is(pg_temp.err($$select servicing.draft_reminder_template(pg_temp.lx(), 'overdue', 'en', '{{lender_name}} reminder: {{amount}} is overdue since {{due_date}}.')$$), '22023|penal_text_variable_missing', 'an overdue wording without the penal-charge variable is refused');
select is(pg_temp.err($$select servicing.draft_reminder_template(pg_temp.lx(), 'late', 'en', '{{lender_name}} reminder: {{amount}} is overdue since {{due_date}}.')$$), '22023|template_invalid', 'an unknown kind is refused');
select is(pg_temp.err($$select servicing.draft_reminder_template(pg_temp.lx(), 'pre_due', 'ta', '{{lender_name}} reminder: {{amount}} is due on {{due_date}}.')$$), '22023|template_invalid', 'an unsupported language is refused');
select pg_temp.keep('t_pre', servicing.draft_reminder_template(pg_temp.lx(), 'pre_due', 'en', 'Reminder from {{lender_name}}: your installment of {{amount}} is due on {{due_date}}.')::text);
select pg_temp.keep('t_due', servicing.draft_reminder_template(pg_temp.lx(), 'due_day', 'en', 'Reminder from {{lender_name}}: your installment of {{amount}} is due today, {{due_date}}.')::text);
select pg_temp.keep('t_over', servicing.draft_reminder_template(pg_temp.lx(), 'overdue', 'en', '{{lender_name}} reminder: {{amount}} is overdue since {{due_date}}. {{penal_text}}')::text);
select pg_temp.keep('t_over_hi', servicing.draft_reminder_template(pg_temp.lx(), 'overdue', 'hi', 'आपका {{amount}} का भुगतान बकाया है। {{penal_text}}')::text);
select is((select body_sha256 from servicing.reminder_templates where id = pg_temp.got('t_pre')::uuid), encode(sha256(convert_to('Reminder from {{lender_name}}: your installment of {{amount}} is due on {{due_date}}.', 'UTF8')), 'hex'), 'the hash of the wording is stored');
select pg_temp.as_user(pg_temp.u(4));
select is(pg_temp.err(format($$select servicing.draft_reminder_template(%L, 'pre_due', 'en', 'Reminder from {{lender_name}}: {{amount}} due {{due_date}}.')$$, pg_temp.lx())), '42501|', 'the approver cannot draft wording');
select servicing.approve_reminder_template(pg_temp.got('t_pre')::uuid);
select servicing.approve_reminder_template(pg_temp.got('t_due')::uuid);
select servicing.approve_reminder_template(pg_temp.got('t_over')::uuid);
select servicing.approve_reminder_template(pg_temp.got('t_over_hi')::uuid);
select is((select count(*) from servicing.reminder_templates where status = 'approved' and lender_org_id = pg_temp.lx()), 4::bigint, 'four wordings are approved by a second person');
select pg_temp.as_user(pg_temp.u(3));
select is(pg_temp.err(format($$select servicing.approve_reminder_template(%L)$$, pg_temp.got('t_pre'))), 'P0002|', 'the drafter cannot approve wording');
select pg_temp.keep('t_pre2', servicing.draft_reminder_template(pg_temp.lx(), 'pre_due', 'en', 'Reminder from {{lender_name}}: {{amount}} falls due on {{due_date}}.')::text);
select pg_temp.as_user(pg_temp.u(9));
select servicing.approve_reminder_template(pg_temp.got('t_pre2')::uuid);
select is((select array_agg(version || ':' || status order by version) from servicing.reminder_templates where kind = 'pre_due' and language = 'en' and lender_org_id = pg_temp.lx()), array['1:retired', '2:approved'], 'approving a new version retires the old one');
select pg_temp.as_owner();
select is(pg_temp.err($$update servicing.reminder_templates set body = 'Reminder from {{lender_name}}: pay {{amount}} now.' where kind = 'due_day'$$), 'P0001|', 'approved wording cannot be edited in place');
select is(pg_temp.err($$insert into servicing.reminder_templates (lender_org_id, kind, language, version, status, body, drafted_by)
  values (pg_temp.lx(), 'due_day', 'en', 9, 'approved', 'Reminder from {{lender_name}}: {{amount}} due {{due_date}}.', pg_temp.u(3))$$), 'P0001|', 'wording cannot be inserted as already approved');
select is(pg_temp.err($$insert into servicing.reminder_templates (lender_org_id, kind, language, version, body, drafted_by)
  values (pg_temp.lx(), 'due_day', 'en', 9, 'Reminder from {{lender_name}}: {{amount}} due {{due_date}} and a [link](https://x.test).', pg_temp.u(3))$$), '23514|', 'a database constraint also refuses unsafe wording written around the functions');
select is(pg_temp.err($$insert into servicing.reminder_templates (lender_org_id, kind, language, version, body, drafted_by)
  values (pg_temp.lx(), 'overdue', 'en', 9, '{{lender_name}} reminder: {{amount}} is overdue since {{due_date}}.', pg_temp.u(3))$$), '23514|', 'and so does an overdue wording without the penal-charge variable');

-- Penal-charge text -----------------------------------------------------------------------------------------------------------
select pg_temp.as_user(pg_temp.u(3));
select is(pg_temp.err($$select servicing.draft_penal_charge_text(pg_temp.lx(), 'flat', 50000, null, false, true, 'Charge as per the loan agreement', 'A separate penal charge applies to the overdue amount.')$$), '22023|attestation_missing', 'the lender must attest that the charge is separate from interest');
select is(pg_temp.err($$select servicing.draft_penal_charge_text(pg_temp.lx(), 'flat', 50000, null, true, false, 'Charge as per the loan agreement', 'A separate penal charge applies to the overdue amount.')$$), '22023|attestation_missing', 'and not compounded');
select is(pg_temp.err($$select servicing.draft_penal_charge_text(pg_temp.lx(), 'flat', 50000, 200, true, true, 'Charge as per the loan agreement', 'A separate penal charge applies to the overdue amount.')$$), '22023|charge_invalid', 'a charge is a flat amount or a percentage, not both');
select is(pg_temp.err($$select servicing.draft_penal_charge_text(pg_temp.lx(), 'flat', 50000, null, true, true, 'Charge as per the loan agreement', 'Pay now and get a special offer on the penal charge.')$$), '22023|wording_invalid', 'the sentence is checked like any service message');
select pg_temp.keep('pen1', servicing.draft_penal_charge_text(pg_temp.lx(), 'flat', 50000, null, true, true, 'Charge as per the loan agreement', 'A separate penal charge applies to the overdue amount as per your loan agreement.')::text);
select is((select (version, status, charge_kind, flat_amount_minor)::text from servicing.penal_charge_texts where id = pg_temp.got('pen1')::uuid), '(1,draft,flat,50000)', 'a penal-charge text starts as a draft with the lender''s structured figure');
select is((select count(*) from servicing.penal_charge_texts where status = 'approved'), 0::bigint, 'no penal-charge text is approved before the lender''s second person approves one: nothing is seeded or invented');
select is(pg_temp.err(format($$select servicing.approve_penal_charge_text(%L)$$, pg_temp.got('pen1'))), 'P0002|', 'the drafter cannot approve it');

-- Segregation of duties: one login cannot hold both halves ---------------------------------------------------------------------
select pg_temp.as_owner();
select is(pg_temp.err($$insert into tenancy.membership_roles (membership_id, role_id)
  select 'fac10000-0000-4000-8000-000000000003', r.id from tenancy.roles r where r.org_id is null and r.applies_to = 'lender' and r.key = 'communications_approver'$$), '23514|segregation_of_duties', 'a drafter cannot also be given the approval role');
select is(pg_temp.err($$insert into tenancy.role_permissions (role_id, permission_key)
  select r.id, 'reminder.template.approve' from tenancy.roles r where r.org_id is null and r.applies_to = 'lender' and r.key = 'communications_admin'$$), '23514|segregation_of_duties', 'nor can the drafting role carry the approval permission');


-- ============================================================================================================================
-- 4. Planning
-- ============================================================================================================================
select pg_temp.as_system();
select is(servicing.plan_reminders(interval '10 days') > 0, true, 'the planner runs and plans reminders');
select is(pg_temp.rems(pg_temp.lid(1)), 'planned:in_app:-1,planned:push:-1,suppressed:sms_not_configured:sms:-1,planned:in_app:0,planned:push:0,suppressed:sms_not_configured:sms:0',
  'loan 1 gets a pre-due and a due-day reminder on in-app and push, and the sms rows exist only as suppressed placeholders');
select is(pg_temp.rems(pg_temp.lid(2)), 'planned:in_app:3,planned:push:3,suppressed:sms_not_configured:sms:3,planned:in_app:10,planned:push:10,suppressed:sms_not_configured:sms:10',
  'loan 2 gets overdue reminders for its oldest overdue installment: the configured offset and the weekly tail');
select is((select count(*) from servicing.reminders where lender_org_id = pg_temp.ly()), 0::bigint, 'lender Y has the reminders switch off and no policy: nothing is planned for it');
select is((select count(*) from servicing.reminders where channel = 'sms' and status <> 'suppressed'), 0::bigint, 'no sms reminder is ever planned as sendable');
select is((select scheduled_for = ((due_date + offset_days)::timestamp + time '09:00') at time zone 'Asia/Kolkata' from servicing.reminders where loan_account_id = pg_temp.lid(1) and offset_days = -1 and channel = 'in_app'),
  true, 'a message is scheduled at the start of the window, in Indian time');
select is(servicing.plan_reminders(interval '10 days'), 0, 'a second run plans nothing: the planner is idempotent');
select is((select count(*) from servicing.reminders where loan_account_id = pg_temp.lid(2) and installment_seq <> 1), 0::bigint, 'overdue messages are planned only for the oldest overdue installment, not for later ones');
select is(pg_temp.err($$select servicing.plan_reminders(interval '0 seconds')$$), '22023|bad_request', 'a nonsense horizon is refused');
select pg_temp.as_user(pg_temp.u(3));
select is(pg_temp.err($$select servicing.plan_reminders()$$), '42501|', 'a lender user cannot run the planner');
select pg_temp.as_anon();
select is(pg_temp.err($$select servicing.plan_reminders()$$), '42501|', 'nor anon');

-- Activation prerequisites ------------------------------------------------------------------------------------------------------
select pg_temp.as_owner();
select is(private.feature_prerequisites_unmet(pg_temp.ly(), 'reminders'), array['evidence_missing', 'reminder_policy_missing', 'reminder_templates_missing'], 'a lender without a policy or wording cannot turn reminders on');
select is(private.feature_prerequisites_unmet(pg_temp.lx(), 'reminders'), array['evidence_missing'], 'a lender with an approved policy and approved English wording for each kind lacks only evidence');
select is(private.feature_prerequisites_unmet(pg_temp.ly(), 'servicing_sync'), array['evidence_missing', 'lms_connection_not_active'], 'servicing_sync needs an active LMS connection');
select is(private.feature_prerequisites_unmet(pg_temp.lx(), 'statements_noc'), array['evidence_missing'], 'statements_noc needs servicing_sync on (it is)');
select is(private.feature_prerequisites_unmet(pg_temp.lx(), 'collections') && array['feature_not_enableable'], true, 'collections still cannot be enabled');

-- ============================================================================================================================
-- 5. The window
-- ============================================================================================================================
select pg_temp.as_owner();
select pg_temp.due_now(pg_temp.lid(1));
update servicing.reminders set scheduled_for = now() - interval '1 hour' where loan_account_id = pg_temp.lid(2) and offset_days = 3 and status = 'planned';
select pg_temp.keep('planned_before', (select count(*) from servicing.reminders where status = 'planned')::text);
select pg_temp.as_system();
select pg_temp.at_ist('21:00');
select is((select count(*) from servicing.claim_due_reminders(100)), 0::bigint, 'outside the window (21:00 IST) nothing is claimed');
select pg_temp.at_ist('08:30');
select is((select count(*) from servicing.claim_due_reminders(100)), 0::bigint, 'before the lender''s own window opens (08:30, policy 09:00 to 18:00) nothing is claimed: a policy can only narrow the platform window');
select pg_temp.at_ist('18:00');
select is((select count(*) from servicing.claim_due_reminders(100)), 0::bigint, 'at the moment the window closes (18:00) nothing is claimed');
select is((select count(*) from servicing.reminders where status = 'planned')::text, pg_temp.got('planned_before'), 'a deferred message stays planned: it is not dropped, not suppressed and not marked');
select is(pg_temp.err($$select * from servicing.claim_due_reminders(0)$$), '22023|bad_request', 'a nonsense batch size is refused');
select pg_temp.as_user(pg_temp.u(3));
select is(pg_temp.err($$select * from servicing.claim_due_reminders(10)$$), '42501|', 'a lender user cannot claim');
select pg_temp.as_owner();
select is((select count(*) from servicing.reminders where scheduled_for < now() - interval '48 hours'), 0::bigint, 'no planned message is older than the 48 hours after which it would expire');

-- Platform rules narrow, never widen ---------------------------------------------------------------------------------------------
create function pg_temp.rule(p_key text, p_version integer, p_rule jsonb) returns void language sql as $fn$
  insert into documents.applicability_rules (rule_key, version, lender_category_keys, regulator, direction_ref, product_category_keys, document_type, required_template_key,
    required_fields_version, validity_rule, effective_from, approval_status, evidence_status, reviewer_ref, reviewed_on, proposed_by, approved_by, approved_at)
  values (p_key, p_version, array['nbfc_icc'], 'SAMPLE', 'SAMPLE rule for a test', array['personal'], 'service_reminder', 'none.lender_issued', 'none', p_rule, date '2026-01-01',
          'approved', 'unverified', 'SAMPLE-REVIEWER', current_date, pg_temp.u(7), pg_temp.u(8), now())
$fn$;
grant execute on function pg_temp.rule(text, integer, jsonb) to public;
select pg_temp.rule('servicing.reminder_max_per_day', 2, '{"kind":"count_per_day","count":1}');
select is((select max_per_day from private.reminder_params()), 1, 'an approved rule lowers the daily cap');
select pg_temp.rule('servicing.reminder_max_per_day', 3, '{"kind":"count_per_day","count":5}');
select is((select max_per_day from private.reminder_params()), 2, 'a newer approved rule cannot widen the cap beyond the default');
select pg_temp.rule('servicing.reminder_max_per_day', 4, '{"kind":"count_per_day","count":"many"}');
select is((select max_per_day from private.reminder_params()), 2, 'a malformed approved rule is ignored: the default stays');
update documents.applicability_rules set approval_status = 'retired' where rule_key = 'servicing.reminder_max_per_day' and version in (3, 4);
select is((select max_per_day from private.reminder_params()), 1, 'retiring them brings the narrower rule back');
select pg_temp.rule('servicing.reminder_window.default', 2, '{"kind":"daily_window","from":"09:30","to":"17:30","tz":"Asia/Kolkata"}');
select is((select window_from::text || '-' || window_to::text from private.reminder_params()), '09:30:00-17:30:00', 'an approved rule narrows the window');
select pg_temp.rule('servicing.reminder_window.default', 3, '{"kind":"daily_window","from":"06:00","to":"22:00","tz":"Asia/Kolkata"}');
select is((select window_from::text || '-' || window_to::text from private.reminder_params()), '08:00:00-19:00:00', 'a newer rule that tries to widen it cannot go beyond 08:00 to 19:00');
update documents.applicability_rules set approval_status = 'retired' where rule_key = 'servicing.reminder_window.default' and version in (2, 3);
select pg_temp.rule('servicing.suppress_after_payment_hours', 2, '{"kind":"hours_after_payment","hours":24}');
select is((select suppress_hours from private.reminder_params()), 48, 'the quiet period after a payment cannot be shortened below the default');
select pg_temp.rule('servicing.suppress_after_payment_hours', 3, '{"kind":"hours_after_payment","hours":72}');
select is((select suppress_hours from private.reminder_params()), 72, 'but it can be lengthened');
update documents.applicability_rules set approval_status = 'retired' where rule_key = 'servicing.suppress_after_payment_hours' and version in (2, 3);

-- ============================================================================================================================
-- 6. Holds, payments, closure and stale reports
-- ============================================================================================================================
select pg_temp.as_user(pg_temp.u(5));
select is(pg_temp.err(format($$select servicing.place_communication_hold(%L, 'complaint', null)$$, pg_temp.lid(3))), 'P0002|', 'a user who cannot manage reminders cannot place a hold (the loan looks unknown to them)');
select pg_temp.as_user(pg_temp.u(6));
select is(pg_temp.err(format($$select servicing.place_communication_hold(%L, 'complaint', null)$$, pg_temp.lid(3))), 'P0002|', 'another lender''s user cannot place one on this loan');
select pg_temp.as_user(pg_temp.u(3));
select is(pg_temp.err(format($$select servicing.place_communication_hold(%L, 'marketing', null)$$, pg_temp.lid(3))), '22023|hold_invalid', 'a hold has a reason from a closed list');
select is(pg_temp.err(format($$select servicing.place_communication_hold(%L, 'complaint', 'see https://example.test')$$, pg_temp.lid(3))), '22023|hold_invalid', 'and a note that is not a plain sentence is refused');
select pg_temp.keep('hold3', servicing.place_communication_hold(pg_temp.lid(3), 'complaint', 'Borrower raised a complaint with the lender')::text);
select is(pg_temp.err(format($$select servicing.place_communication_hold(%L, 'dispute', null)$$, pg_temp.lid(3))), '23505|hold_active', 'a loan has at most one active hold');
select is(pg_temp.rems(pg_temp.lid(3)), 'suppressed:hold:in_app:-1,suppressed:hold:push:-1,suppressed:sms_not_configured:sms:-1,suppressed:hold:in_app:0,suppressed:hold:push:0,suppressed:sms_not_configured:sms:0',
  'placing a hold suppresses what was planned for the loan, with the reason');
select pg_temp.as_owner();
-- A message planned while the hold is active (the planner does not look at holds; the claim does).
insert into servicing.reminders (lender_org_id, loan_account_id, borrower_id, policy_id, installment_seq, due_date, offset_days, channel, scheduled_for)
values (pg_temp.lx(), pg_temp.lid(3), pg_temp.got('b1')::uuid, pg_temp.got('pol1')::uuid, 2, pg_temp.d() + 31, 0, 'in_app', now() - interval '2 hours');
select is((select count(*) from audit.events where action = 'reminder.hold.placed' and tenant_org_id = pg_temp.lx()), 1::bigint, 'the hold is audited');
select is((select count(*) from audit.events where action like 'reminder.%' and metadata::text ~* '(complaint with the lender|Reminder from|falls due on|penal charge applies)'), 0::bigint, 'and no audit event carries wording or a free-text note');
select is(pg_temp.err($$update servicing.communication_holds set reason = 'legal'$$), 'P0001|', 'a hold keeps its reason and loan');
select is(pg_temp.err($$delete from servicing.communication_holds$$), 'P0001|Record a compensating entry instead.', 'and is never deleted');

-- Loan 4: a payment the lender posted today. Loan 5: the lender reports the installment paid. Loan 6: closed.
insert into servicing.lms_receipts (lender_org_id, loan_account_id, kind, lms_receipt_ref, amount_minor, value_date, source_system, source_record_id, reported_as_of, content_sha256)
values (pg_temp.lx(), pg_temp.lid(4), 'receipt', 'SAMPLE-RCPT-4', 475000, pg_temp.d(), 'file_import', 'SRC-RCPT-4', clock_timestamp() - interval '2 hours', pg_temp.sha('rcpt4'));
update servicing.loan_accounts set status = 'closed' where id = pg_temp.lid(6);
select pg_temp.due_now(pg_temp.lid(4));
select pg_temp.due_now(pg_temp.lid(5));
select pg_temp.due_now(pg_temp.lid(6));

-- Loan 8: a stale report (three days old) with a due-day message, and no other sign of trouble.
insert into lending.loan_requests (id, borrower_id, category_key, requested_amount_minor, requested_tenure_days, purpose_code, status)
values ('fa700000-0000-4000-8000-000000000008', pg_temp.got('b1')::uuid, 'personal', 5000000, 365, 'education', 'submitted');
insert into lending.applications (id, lender_org_id, loan_request_id, borrower_id, product_version_id, status, requested_amount_minor, requested_tenure_days, lender_reference)
values ('fa200000-0000-4000-8000-000000000008', pg_temp.lx(), 'fa700000-0000-4000-8000-000000000008', pg_temp.got('b1')::uuid, 'fa910000-0000-4000-8000-000000000001', 'disbursed', 5000000, 365, 'SAMPLE-APP-8');
insert into servicing.loan_accounts (id, lender_org_id, application_id, borrower_id, source_system, lms_loan_ref, status, sanctioned_amount_minor)
values (pg_temp.lid(8), pg_temp.lx(), 'fa200000-0000-4000-8000-000000000008', pg_temp.got('b1')::uuid, 'lender_lms', 'SAMPLE-LN-8', 'active', 5000000);
insert into servicing.balance_snapshots (lender_org_id, loan_account_id, version, status, outstanding_principal_minor, total_overdue_minor, next_due_on, next_due_minor, days_past_due,
  source_system, source_record_id, reported_as_of, content_sha256)
values (pg_temp.lx(), pg_temp.lid(8), 1, 'active', 4000000, 0, pg_temp.d() + 1, 475000, 0, 'file_import', 'SRC-SAMPLE-LN-8', clock_timestamp() - interval '3 days', pg_temp.sha('snap-8'));
insert into servicing.reminders (lender_org_id, loan_account_id, borrower_id, policy_id, installment_seq, due_date, offset_days, channel, scheduled_for)
values (pg_temp.lx(), pg_temp.lid(8), pg_temp.got('b1')::uuid, pg_temp.got('pol1')::uuid, 1, pg_temp.d() + 1, 0, 'in_app', now() - interval '3 hours');

-- ============================================================================================================================
-- 7. Claiming, the daily cap and freezing
-- ============================================================================================================================
select pg_temp.as_system();
select pg_temp.at_ist('11:00');
select is((select count(*) from servicing.claim_due_reminders(100)), 2::bigint,
  'inside the window, with the platform cap at one message a day, loan 1''s first message is claimed on both channels and its second waits (the same message on two channels counts once)');
select is(pg_temp.rems(pg_temp.lid(1)), 'claimed:in_app:-1,claimed:push:-1,suppressed:sms_not_configured:sms:-1,planned:in_app:0,planned:push:0,suppressed:sms_not_configured:sms:0', 'loan 1: the first message claimed, the second still planned');
select is(pg_temp.rems(pg_temp.lid(2)), 'suppressed:penal_text_missing:in_app:3,suppressed:penal_text_missing:push:3,suppressed:sms_not_configured:sms:3,planned:in_app:10,planned:push:10,suppressed:sms_not_configured:sms:10',
  'loan 2: an overdue reminder is NOT sent while the lender has no approved penal-charge text, and says why');
select is(pg_temp.rems(pg_temp.lid(4)), 'suppressed:recent_payment:in_app:-1,suppressed:recent_payment:push:-1,suppressed:sms_not_configured:sms:-1,suppressed:recent_payment:in_app:0,suppressed:recent_payment:push:0,suppressed:sms_not_configured:sms:0',
  'loan 4: a payment the lender posted today stops its reminders');
select is(pg_temp.rems(pg_temp.lid(5)), 'suppressed:paid:in_app:-1,suppressed:paid:push:-1,suppressed:sms_not_configured:sms:-1,suppressed:paid:in_app:0,suppressed:paid:push:0,suppressed:sms_not_configured:sms:0',
  'loan 5: when the lender reports the installment paid its reminders stop');
select is(pg_temp.rems(pg_temp.lid(6)), 'suppressed:loan_closed:in_app:-1,suppressed:loan_closed:push:-1,suppressed:sms_not_configured:sms:-1,suppressed:loan_closed:in_app:0,suppressed:loan_closed:push:0,suppressed:sms_not_configured:sms:0',
  'loan 6: a closed loan sends nothing');
select is((select status || ':' || suppress_reason from servicing.reminders where loan_account_id = pg_temp.lid(3) and installment_seq = 2), 'suppressed:hold',
  'loan 3: a message that was planned after the hold was placed is stopped at the claim');
select is(pg_temp.rems(pg_temp.lid(8)), 'planned:in_app:0', 'loan 8: a stale lender report holds a message back (planned, not sent, not dropped)');
select is((select count(*) from payments.reconciliation_exceptions where lender_org_id = pg_temp.lx() and class = 'penal_text_missing' and status <> 'resolved'), 1::bigint,
  'the lender gets exactly one open exception for the missing penal-charge text, however many messages it stopped');
select is((select subject::text from payments.reconciliation_exceptions where class = 'penal_text_missing'), format('{"lender_org_id": "%s"}', pg_temp.lx()), 'and it names no borrower, loan or amount');
select is((select (status, template_id is not null, language_used, language_fallback, penal_text_id is null, variables ->> 'amount_minor', variables ->> 'lender_name', variables ->> 'due_date' = (pg_temp.d() + 1)::text, attempts)::text
           from servicing.reminders where loan_account_id = pg_temp.lid(1) and offset_days = -1 and channel = 'in_app'), '(claimed,t,en,f,t,475000,Alpha,t,1)', 'a claim freezes the wording, the language and the figures the lender reported');
select is((select content_sha256 from servicing.reminders where loan_account_id = pg_temp.lid(1) and offset_days = -1 and channel = 'in_app'),
  encode(sha256(convert_to('Reminder from Alpha: Rs 4,750.00 falls due on ' || to_char(pg_temp.d() + 1, 'DD Mon YYYY') || '.', 'UTF8')), 'hex'), 'the stored hash is the hash of the exact message (the approved wording, the lender name, the amount and the due date)');
select is((select count(*) from servicing.claim_due_reminders(100)), 0::bigint, 'nothing is claimed twice while a lease runs, and the capped message still waits');
select pg_temp.as_owner();
update documents.applicability_rules set approval_status = 'retired' where rule_key = 'servicing.reminder_max_per_day' and version = 2;
select pg_temp.keep('hash_b', (select content_sha256 from servicing.reminders where loan_account_id = pg_temp.lid(1) and offset_days = -1 and channel = 'in_app'));
select pg_temp.as_system();
select is((select count(*) from servicing.claim_due_reminders(100)), 2::bigint, 'with the cap lifted the second message is claimed on both channels');

-- A worker that died: its lease runs out and the row is taken again with the same frozen wording; after three attempts it fails.
select pg_temp.as_owner();
update servicing.reminders set claimed_until = now() - interval '1 minute' where loan_account_id = pg_temp.lid(1) and offset_days = 0 and channel = 'in_app';
update servicing.reminders set claimed_until = now() - interval '1 minute', attempts = 3 where loan_account_id = pg_temp.lid(1) and offset_days = 0 and channel = 'push';
select pg_temp.keep('hash_b0', (select content_sha256 from servicing.reminders where loan_account_id = pg_temp.lid(1) and offset_days = 0 and channel = 'in_app'));
select pg_temp.as_system();
select is((select count(*) from servicing.claim_due_reminders(100)), 1::bigint, 'a row whose lease ran out is taken again');
select is((select (status, attempts, content_sha256 = pg_temp.got('hash_b0'))::text from servicing.reminders where loan_account_id = pg_temp.lid(1) and offset_days = 0 and channel = 'in_app'), '(claimed,2,t)', 'with the same frozen wording');
select is((select status from servicing.reminders where loan_account_id = pg_temp.lid(1) and offset_days = 0 and channel = 'push'), 'failed', 'and one that already used its three attempts is marked failed, not tried again');

-- ============================================================================================================================
-- 8. What the worker reports
-- ============================================================================================================================
select pg_temp.keep('a_in', (select id::text from servicing.reminders where loan_account_id = pg_temp.lid(1) and offset_days = -1 and channel = 'in_app'));
select pg_temp.keep('a_push', (select id::text from servicing.reminders where loan_account_id = pg_temp.lid(1) and offset_days = -1 and channel = 'push'));
select pg_temp.keep('b_in', (select id::text from servicing.reminders where loan_account_id = pg_temp.lid(1) and offset_days = 0 and channel = 'in_app'));
select pg_temp.keep('sms1', (select id::text from servicing.reminders where loan_account_id = pg_temp.lid(1) and channel = 'sms' limit 1));
select is(servicing.record_reminder_attempt(pg_temp.got('a_in')::uuid, 'accepted', 'send'), 'accepted', 'an in-app message is accepted into the inbox');
select is(servicing.record_reminder_attempt(pg_temp.got('a_push')::uuid, 'accepted', 'send', 'SAMPLE-PUSH-REF-1'), 'accepted', 'a push message is accepted by the push provider');
select is((select status from servicing.reminders where id = pg_temp.got('a_push')::uuid), 'sent', 'and the reminder is sent');
select is(servicing.record_reminder_attempt(pg_temp.got('a_push')::uuid, 'delivered', 'delivery_report', 'SAMPLE-PUSH-REF-1'), 'delivered', 'a delivery report marks it delivered');
select is(servicing.record_reminder_attempt(pg_temp.got('a_push')::uuid, 'delivered', 'delivery_report', 'SAMPLE-PUSH-REF-1'), 'duplicate', 'a repeated report is a duplicate and writes nothing');
select is((select count(*) from servicing.reminder_deliveries where reminder_id = pg_temp.got('a_push')::uuid), 2::bigint, 'the push message has two log rows: accepted and delivered');
select is(pg_temp.err(format($$select servicing.record_reminder_attempt(%L, 'delivered', 'send')$$, pg_temp.got('b_in'))), '22023|bad_request', '"delivered" cannot be claimed by the sender: only a delivery report says so');
select is(pg_temp.err(format($$select servicing.record_reminder_attempt(%L, 'failed', 'send')$$, pg_temp.got('b_in'))), '22023|bad_request', 'a failure needs an error class');
select is(pg_temp.err(format($$select servicing.record_reminder_attempt(%L, 'accepted', 'send')$$, pg_temp.got('sms1'))), '55000|not_claimed', 'an sms row is never claimed, so nothing can be recorded as sent for it');
select is(pg_temp.err(format($$select servicing.record_reminder_attempt(%L, 'delivered', 'delivery_report', 'X-1')$$, pg_temp.got('b_in'))), '55000|not_sent', 'a delivery report for a message that was not sent is refused');
select is(servicing.record_reminder_attempt(pg_temp.got('b_in')::uuid, 'failed', 'send', null, 'provider_timeout'), 'failed', 'a failed attempt is recorded');
select is((select (status, claimed_until is null, scheduled_for > now() + interval '10 minutes')::text from servicing.reminders where id = pg_temp.got('b_in')::uuid), '(planned,t,t)', 'and the message is retried later (not at once)');
select is(pg_temp.err(format($$select servicing.record_reminder_attempt(%L, 'accepted', 'send')$$, pg_temp.got('b_in'))), '55000|not_claimed', 'a result for a message that is not claimed is refused');
select pg_temp.as_owner();
update servicing.reminders set scheduled_for = now() - interval '1 minute' where id = pg_temp.got('b_in')::uuid;
select pg_temp.as_system();
select is((select count(*) from servicing.claim_due_reminders(100)), 1::bigint, 'the failed message is taken again when its retry time comes');
select is(servicing.record_reminder_attempt(pg_temp.got('b_in')::uuid, 'failed', 'send', null, 'provider_error'), 'failed', 'it fails again');
select is((select (status, attempts)::text from servicing.reminders where id = pg_temp.got('b_in')::uuid), '(failed,3)', 'and after the third attempt it is marked failed for good: it is not retried again and not reported as sent');
select pg_temp.as_owner();
select is(pg_temp.err($$insert into servicing.reminder_deliveries (reminder_id, lender_org_id, channel, state, source, content_sha256)
  select id, lender_org_id, channel, 'delivered', 'send', content_sha256 from servicing.reminders where status = 'sent' limit 1$$), '23514|', 'the database itself refuses "delivered" from a send, even written around the functions');
select is(pg_temp.err($$insert into servicing.reminder_deliveries (reminder_id, lender_org_id, channel, state, source, content_sha256)
  select id, lender_org_id, 'sms', 'accepted', 'send', content_sha256 from servicing.reminders where status = 'sent' limit 1$$), '23514|', 'and an sms attempt can only ever be not_configured');
select is(pg_temp.err($$update servicing.reminder_deliveries set state = 'failed'$$), 'P0001|Record a compensating entry instead.', 'the delivery log is append-only');
select is(pg_temp.err($$update servicing.reminders set content_sha256 = repeat('0', 64) where status = 'sent'$$), 'P0001|', 'a claimed message''s content cannot be changed');
select is(pg_temp.err($$update servicing.reminders set status = 'planned' where status = 'sent'$$), 'P0001|', 'and a finished message does not come back');
select is(pg_temp.err($$update servicing.reminders set offset_days = 5 where status = 'planned'$$), 'P0001|', 'a reminder keeps its loan, offset and channel');
select is((select count(*) from servicing.reminder_deliveries where channel = 'sms'), 0::bigint, 'no sms attempt exists at all: there is no sms provider');
select is((select count(*) from servicing.reminders where channel = 'sms' and status <> 'suppressed'), 0::bigint, 'and no sms reminder was ever claimed or sent');

-- ============================================================================================================================
-- 9. Overdue messages and the lender's penal-charge sentence
-- ============================================================================================================================
select pg_temp.as_user(pg_temp.u(4));
select servicing.approve_penal_charge_text(pg_temp.got('pen1')::uuid);
select pg_temp.as_owner();
select pg_temp.due_now(pg_temp.lid(2));
select pg_temp.as_system();
select is((select count(*) from servicing.claim_due_reminders(100)), 2::bigint, 'once the lender has an approved penal-charge text its overdue reminders are claimed');
select is((select (language_used, language_fallback, penal_text_id = pg_temp.got('pen1')::uuid, penal_text_sha256 = encode(sha256(convert_to('A separate penal charge applies to the overdue amount as per your loan agreement.', 'UTF8')), 'hex'))::text
           from servicing.reminders where loan_account_id = pg_temp.lid(2) and offset_days = 10 and channel = 'in_app'), '(en,t,t,t)',
  'a Hindi-speaking borrower falls back to English when the lender''s sentence has no Hindi version, and the message says so (language_fallback)');
select servicing.record_reminder_attempt(id, 'accepted', 'send') from servicing.reminders where loan_account_id = pg_temp.lid(2) and offset_days = 10 and channel = 'in_app';

-- A new approved sentence with a Hindi version retires the old one: a message still claimed under the old one is not sent.
select pg_temp.as_user(pg_temp.u(3));
select pg_temp.keep('pen2', servicing.draft_penal_charge_text(pg_temp.lx(), 'flat', 50000, null, true, true, 'Charge as per the loan agreement',
  'A separate penal charge applies to the overdue amount as per your loan agreement.', 'बकाया राशि पर ऋणदाता द्वारा बताया गया अलग दंडात्मक शुल्क लागू है।')::text);
select pg_temp.as_user(pg_temp.u(9));
select servicing.approve_penal_charge_text(pg_temp.got('pen2')::uuid);
select is((select array_agg(version || ':' || status order by version) from servicing.penal_charge_texts where lender_org_id = pg_temp.lx()), array['1:retired', '2:approved'], 'approving a new text retires the old one');
select pg_temp.as_owner();
insert into servicing.reminders (lender_org_id, loan_account_id, borrower_id, policy_id, installment_seq, due_date, offset_days, channel, scheduled_for)
select r.lender_org_id, r.loan_account_id, r.borrower_id, r.policy_id, r.installment_seq, r.due_date, 17, c.ch, now() - interval '30 minutes'
from servicing.reminders r cross join (values ('in_app'), ('push')) c (ch)
where r.loan_account_id = pg_temp.lid(2) and r.offset_days = 10 and r.channel = 'in_app';
update servicing.reminders set claimed_until = now() - interval '1 minute' where loan_account_id = pg_temp.lid(2) and offset_days = 10 and channel = 'push';
select pg_temp.as_system();
select is((select count(*) from servicing.claim_due_reminders(100)), 2::bigint, 'the new messages are claimed; the retried one is not (its sentence was retired)');
select is((select (status, suppress_reason)::text from servicing.reminders where loan_account_id = pg_temp.lid(2) and offset_days = 10 and channel = 'push'), '(suppressed,penal_text_missing)',
  'a claimed message whose approved sentence was retired is stopped, not sent with the old text');
select is((select (language_used, language_fallback, penal_text_id = pg_temp.got('pen2')::uuid)::text from servicing.reminders where loan_account_id = pg_temp.lid(2) and offset_days = 17 and channel = 'in_app'), '(hi,f,t)',
  'with a Hindi sentence available the Hindi wording is used');
select is(servicing.record_reminder_attempt(id, 'accepted', 'send'), 'accepted', 'the Hindi in-app message is accepted') from servicing.reminders where loan_account_id = pg_temp.lid(2) and offset_days = 17 and channel = 'in_app';
select is(servicing.record_reminder_attempt(id, 'not_configured', 'send'), 'not_configured', 'a channel with no provider reports not_configured') from servicing.reminders where loan_account_id = pg_temp.lid(2) and offset_days = 17 and channel = 'push';
select is((select (status, suppress_reason)::text from servicing.reminders where loan_account_id = pg_temp.lid(2) and offset_days = 17 and channel = 'push'), '(suppressed,channel_not_configured)', 'and the message is suppressed, never reported as sent');
select is((select (state, source)::text from servicing.reminder_deliveries d join servicing.reminders r on r.id = d.reminder_id where r.loan_account_id = pg_temp.lid(2) and r.offset_days = 17 and r.channel = 'push'), '(not_configured,send)', 'the log records not_configured');

-- Wording withdrawn: a due-day message finds no approved wording.
select pg_temp.as_user(pg_temp.u(3));
select is(servicing.retire_reminder_template(pg_temp.got('t_due')::uuid), 'retired', 'a lender can withdraw its due-day wording');
select pg_temp.as_owner();
insert into servicing.balance_snapshots (lender_org_id, loan_account_id, version, status, outstanding_principal_minor, total_overdue_minor, next_due_on, next_due_minor, days_past_due,
  source_system, source_record_id, reported_as_of, content_sha256)
values (pg_temp.lx(), pg_temp.lid(8), 2, 'active', 4000000, 0, pg_temp.d() + 1, 475000, 0, 'file_import', 'SRC-SAMPLE-LN-8-B', clock_timestamp() - interval '1 minute', pg_temp.sha('snap-8b'));
select pg_temp.as_system();
select is((select count(*) from servicing.claim_due_reminders(100)), 0::bigint, 'a fresh report arrives; the message finds no wording and is not claimed');
select is((select (status, suppress_reason)::text from servicing.reminders where loan_account_id = pg_temp.lid(8)), '(suppressed,template_missing)', 'it is suppressed with the reason template_missing');

-- A lender whose reminders switch is off: nothing is claimed, whatever exists.
select pg_temp.as_owner();
set local session_replication_role = replica;
insert into servicing.reminder_policies (lender_org_id, version, status, offsets_days, channels, window_from, window_to, max_per_day, drafted_by, approved_by, approved_at)
values (pg_temp.ly(), 1, 'approved', array[0], array['in_app'], time '09:00', time '18:00', 2, pg_temp.u(6), pg_temp.u(10), now());
insert into servicing.reminders (lender_org_id, loan_account_id, borrower_id, policy_id, installment_seq, due_date, offset_days, channel, scheduled_for)
select pg_temp.ly(), pg_temp.lid(7), pg_temp.got('b1')::uuid, p.id, 1, pg_temp.d() + 1, 0, 'in_app', now() - interval '1 hour' from servicing.reminder_policies p where p.lender_org_id = pg_temp.ly();
set local session_replication_role = origin;
select pg_temp.as_system();
select is((select count(*) from servicing.claim_due_reminders(100)), 0::bigint, 'a lender whose reminders switch is off has nothing claimed');
select is((select status from servicing.reminders where lender_org_id = pg_temp.ly()), 'planned', 'and its message stays planned');
select servicing.plan_reminders(interval '10 days');
select is((select count(*) from servicing.reminders where lender_org_id = pg_temp.ly()), 1::bigint, 'the planner adds nothing for it either');

-- ============================================================================================================================
-- 10. What the borrower and the lender see
-- ============================================================================================================================
select pg_temp.as_user(pg_temp.u(1));
select is((select count(*) from servicing.my_reminders()), 1::bigint, 'borrower b1 sees one message for loan 1''s first reminder, although it went out on two channels');
select is((select message from servicing.my_reminders()), 'Reminder from Alpha: Rs 4,750.00 falls due on ' || to_char(pg_temp.d() + 1, 'DD Mon YYYY') || '.', 'and the exact wording that was frozen and hashed');
select is((select read_at is null from servicing.my_reminders()), true, 'it is unread');
select pg_temp.keep('read1', (select reminder_id::text from servicing.my_reminders()));
select is(servicing.mark_reminder_read(pg_temp.got('read1')::uuid), 'read', 'the borrower marks it read');
select is(servicing.mark_reminder_read(pg_temp.got('read1')::uuid), 'read', 'again, harmlessly');
select is((select read_at is not null from servicing.my_reminders()), true, 'it now shows as read');
select is((select count(*) from servicing.reminder_deliveries where state = 'read' and source = 'app'), 0::bigint, 'the borrower cannot read the delivery log directly');
select is((select count(*) from servicing.reminders), 0::bigint, 'nor the reminders table');
select is(pg_temp.err($$select servicing.mark_reminder_read(gen_random_uuid())$$), 'P0002|', 'an unknown reminder answers not found');
select pg_temp.as_user(pg_temp.u(2));
select is((select count(*) from servicing.my_reminders()), 2::bigint, 'borrower b2 sees the two overdue messages');
select is((select message from servicing.my_reminders() where due_date is not null order by sent_at desc limit 1) like 'आपका Rs 1,000.00 का भुगतान बकाया है। बकाया राशि पर ऋणदाता द्वारा बताया गया अलग दंडात्मक शुल्क लागू है।', true, 'the newest one is in Hindi and carries the lender''s Hindi sentence verbatim');
select is((select message from servicing.my_reminders() order by sent_at limit 1) like 'Alpha reminder: Rs 1,000.00 is overdue since % A separate penal charge applies to the overdue amount as per your loan agreement.', true, 'the other one is in English with the lender''s English sentence verbatim');
select is(pg_temp.err(format($$select servicing.mark_reminder_read(%L)$$, pg_temp.got('read1'))), 'P0002|', 'b2 cannot mark b1''s reminder');
select pg_temp.as_user(pg_temp.u(3));
select is((select count(*) from servicing.my_reminders()), 0::bigint, 'a lender user is not a borrower: nothing');
select is(pg_temp.err(format($$select servicing.mark_reminder_read(%L)$$, pg_temp.got('read1'))), '42501|', 'and cannot mark anything read');
select is((select count(*) > 10 from servicing.reminders), true, 'a lender user reads its own reminders');
select is((select count(*) from servicing.reminders where lender_org_id = pg_temp.ly()), 0::bigint, 'but not another lender''s');
select is((select count(*) > 0 from servicing.reminder_deliveries), true, 'and its own delivery log');
select is((select count(*) from servicing.reminder_policies), 3::bigint, 'and its policy versions');
select is((select count(*) > 0 from servicing.reminder_summary(pg_temp.lx())), true, 'the summary counts the lender''s reminders by status');
select is((select count(*) from servicing.reminder_summary(pg_temp.ly())), 0::bigint, 'another lender''s summary is empty');
select is((select sum(n)::bigint from servicing.reminder_summary(pg_temp.lx()) where suppress_reason = 'penal_text_missing'), 3::bigint, 'the summary shows how many messages the missing penal-charge text stopped');
select pg_temp.as_user(pg_temp.u(6));
select is((select count(*) from servicing.reminders where lender_org_id = pg_temp.lx()), 0::bigint, 'lender Y''s user sees none of lender X''s reminders');
select is((select count(*) from servicing.reminder_templates where lender_org_id = pg_temp.lx()), 0::bigint, 'nor its wording');
select is((select count(*) from servicing.penal_charge_texts where lender_org_id = pg_temp.lx()), 0::bigint, 'nor its penal-charge texts');
select is((select count(*) from servicing.communication_holds where lender_org_id = pg_temp.lx()), 0::bigint, 'nor its holds');
select pg_temp.as_anon();
select is(pg_temp.err($$select count(*) from servicing.reminders$$), '42501|', 'anon cannot read reminders');
select is(pg_temp.err($$select * from servicing.my_reminders()$$), '42501|', 'nor call the borrower function');

-- Defensive: a message whose stored hash no longer matches what would be shown is not shown.
select pg_temp.as_owner();
set local session_replication_role = replica;
update servicing.reminders set content_sha256 = repeat('0', 64) where id in (pg_temp.got('a_in')::uuid, pg_temp.got('a_push')::uuid);
set local session_replication_role = origin;
select pg_temp.as_user(pg_temp.u(1));
select is((select count(*) from servicing.my_reminders()), 0::bigint, 'a reminder whose wording no longer matches its hash is hidden from the borrower');

-- Hold released.
select pg_temp.as_user(pg_temp.u(5));
select is(pg_temp.err(format($$select servicing.release_communication_hold(%L)$$, pg_temp.got('hold3'))), 'P0002|', 'a user who cannot manage reminders cannot release a hold');
select pg_temp.as_user(pg_temp.u(3));
select is(servicing.release_communication_hold(pg_temp.got('hold3')::uuid, 'Complaint closed by the lender'), 'released', 'a hold is released by an authorised user');
select is(pg_temp.err(format($$select servicing.release_communication_hold(%L)$$, pg_temp.got('hold3'))), '55000|already_released', 'but only once');
select is(pg_temp.err(format($$select servicing.place_communication_hold(%L, 'hardship', null)$$, pg_temp.lid(3))) , 'ok', 'and a new hold can follow');

select * from finish();
rollback;
