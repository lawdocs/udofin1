-- Phase 08a review fixes for reminders (migration 20261018000923): findings A10/M35/U39 (wording screen), A11/M43 (hold note limits), A23/M37 (claim scan),
-- A57 (releasing a hold resumes), M33 (no pre-due or due-day wording for a past day), M34 (overdue anchor), M36 (retry re-checks wording and figures),
-- M38 (guards that no test covered), M39 (daily cap by latest claim), M40 (claim token, hold after claim), M41 (quiet period), M42 (planner starvation).
-- Synthetic data only (labelled SAMPLE). Error codes are reported as SQLSTATE|hint. The wrappers rec() and backdate() swallow errors on purpose: run against a
-- database WITHOUT the migration this file then fails assertion by assertion instead of aborting at the first statement that needs the new objects.
begin;
create extension if not exists pgtap with schema extensions;
select plan(101);

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
create function pg_temp.u(n integer) returns uuid language sql as $fn$ select ('fc000000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid $fn$;
create function pg_temp.sha(k text) returns text language sql as $fn$ select encode(sha256(convert_to('SAMPLE-027-' || k, 'UTF8')), 'hex') $fn$;
create function pg_temp.lx() returns uuid language sql as $fn$ select 'fcb00000-0000-4000-8000-000000000001'::uuid $fn$;
create function pg_temp.ly() returns uuid language sql as $fn$ select 'fcb00000-0000-4000-8000-000000000002'::uuid $fn$;
create function pg_temp.lid(n integer) returns uuid language sql as $fn$ select ('fc400000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid $fn$;
create function pg_temp.d() returns date language sql as $fn$ select (now() at time zone 'Asia/Kolkata')::date $fn$;
-- Judge the window at a fixed IST time of day (the seam only the window check reads; allowed in non-production sessions).
create function pg_temp.at_ist(p_time text) returns void language plpgsql as $fn$
begin
  perform set_config('udofin.allow_mock_providers', 'on', true);
  perform set_config('udofin.test_clock', '2026-03-10 ' || p_time || '+05:30', true);
end
$fn$;
-- 'status[:reason]' of one message of a loan, and its id.
create function pg_temp.st(p_loan integer, p_seq integer, p_off integer, p_ch text default 'in_app') returns text language sql as $fn$
  select r.status || coalesce(':' || r.suppress_reason, '') from servicing.reminders r
   where r.loan_account_id = pg_temp.lid(p_loan) and r.installment_seq = p_seq and r.offset_days = p_off and r.channel = p_ch order by r.created_at desc limit 1
$fn$;
create function pg_temp.rid(p_loan integer, p_seq integer, p_off integer, p_ch text default 'in_app') returns uuid language sql as $fn$
  select r.id from servicing.reminders r
   where r.loan_account_id = pg_temp.lid(p_loan) and r.installment_seq = p_seq and r.offset_days = p_off and r.channel = p_ch order by r.created_at desc limit 1
$fn$;
-- The approved policy of lender X.
create function pg_temp.pol() returns uuid language sql as $fn$
  select id from servicing.reminder_policies where lender_org_id = pg_temp.lx() and status = 'approved'
$fn$;
-- A planned message for installment p_seq (due p_due days from today) of loan p_loan, due p_ago ago (a negative interval is in the future).
create function pg_temp.mk_rem(p_loan integer, p_seq integer, p_due integer, p_off integer, p_ch text, p_ago interval default interval '1 hour') returns void language sql as $fn$
  insert into servicing.reminders (lender_org_id, loan_account_id, borrower_id, policy_id, installment_seq, due_date, offset_days, channel, scheduled_for)
  select la.lender_org_id, la.id, la.borrower_id, pg_temp.pol(), p_seq, pg_temp.d() + p_due, p_off, p_ch, now() - p_ago
  from servicing.loan_accounts la where la.id = pg_temp.lid(p_loan)
$fn$;
-- A loan with its newest report and a two-installment schedule: installment 1 due p_d1 days from today, installment 2 p_d2; the report says next due p_next
-- (null = none), p_dpd days past due, p_overdue paise overdue, and is p_age old.
create function pg_temp.mk_loan(n integer, p_lender uuid, p_borrower uuid, p_d1 integer, p_d2 integer, p_next integer, p_next_minor bigint, p_dpd integer, p_overdue bigint,
                                p_age interval default interval '1 minute', p_status text default 'active') returns void language plpgsql as $fn$
declare
  v_nn text := lpad(n::text, 2, '0');
  v_sched uuid := ('fc500000-0000-4000-8000-0000000000' || v_nn)::uuid;
begin
  insert into lending.loan_requests (id, borrower_id, category_key, requested_amount_minor, requested_tenure_days, purpose_code, status)
  values (('fc700000-0000-4000-8000-0000000000' || v_nn)::uuid, p_borrower, 'personal', 5000000, 365, 'education', 'submitted');
  insert into lending.applications (id, lender_org_id, loan_request_id, borrower_id, product_version_id, status, requested_amount_minor, requested_tenure_days, lender_reference)
  values (('fc200000-0000-4000-8000-0000000000' || v_nn)::uuid, p_lender, ('fc700000-0000-4000-8000-0000000000' || v_nn)::uuid, p_borrower,
          case when p_lender = pg_temp.ly() then 'fc910000-0000-4000-8000-000000000002' else 'fc910000-0000-4000-8000-000000000001' end::uuid, 'disbursed', 5000000, 365, 'SAMPLE-APP-' || n);
  insert into servicing.loan_accounts (id, lender_org_id, application_id, borrower_id, source_system, lms_loan_ref, status, sanctioned_amount_minor)
  values (pg_temp.lid(n), p_lender, ('fc200000-0000-4000-8000-0000000000' || v_nn)::uuid, p_borrower, 'lender_lms', 'SAMPLE-LN-' || n, 'active', 5000000);
  insert into servicing.balance_snapshots (lender_org_id, loan_account_id, version, status, outstanding_principal_minor, overdue_principal_minor, overdue_interest_minor,
    penal_charges_minor, other_charges_minor, total_overdue_minor, next_due_on, next_due_minor, days_past_due, source_system, source_record_id, reported_as_of, content_sha256)
  values (p_lender, pg_temp.lid(n), 1, p_status::servicing.loan_status, 4000000, p_overdue, 0, 0, 0, p_overdue, case when p_next is null then null else pg_temp.d() + p_next end,
          p_next_minor, p_dpd, 'file_import', 'SRC-SAMPLE-LN-' || n, clock_timestamp() - p_age, pg_temp.sha('snap-' || n));
  insert into servicing.schedule_snapshots (id, lender_org_id, loan_account_id, version) values (v_sched, p_lender, pg_temp.lid(n), 1);
  insert into servicing.schedule_installments (snapshot_id, lender_org_id, seq, due_date, principal_minor, interest_minor) values
    (v_sched, p_lender, 1, pg_temp.d() + p_d1, 400000, 75000), (v_sched, p_lender, 2, pg_temp.d() + p_d2, 400000, 75000);
end
$fn$;
-- Take the messages that are due and count them.
create function pg_temp.claim(p_limit integer default 100) returns bigint language sql as $fn$ select count(*) from servicing.claim_due_reminders(p_limit) $fn$;
-- Report a send attempt for one claim (token = the attempt number the claim returned), whatever happens.
create function pg_temp.rec(p_id uuid, p_state text, p_token integer, p_class text default null) returns text language plpgsql as $fn$
declare v_state text; v_hint text;
begin
  return (select servicing.record_reminder_attempt(p_id, p_state, 'send', null, p_class, p_token));
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_hint = pg_exception_hint;
  return v_state || '|' || coalesce(v_hint, '');
end
$fn$;
-- Pretend a message was claimed p_ago ago (the daily cap counts by the latest claim).
create function pg_temp.backdate(p_id uuid, p_ago interval) returns void language plpgsql as $fn$
begin
  begin
    update servicing.reminders set claimed_at = now() - p_ago, last_claimed_at = now() - p_ago where id = p_id;
  exception when undefined_column then
    update servicing.reminders set claimed_at = now() - p_ago where id = p_id;
  end;
end
$fn$;
-- Put every planned message aside so that each scenario sees only its own.
create function pg_temp.clear_planned() returns void language sql as $fn$
  update servicing.reminders set status = 'suppressed', suppress_reason = 'expired' where status = 'planned'
$fn$;
grant execute on all functions in schema pg_temp to public;

-- Fixture -----------------------------------------------------------------------------------------------------------------------
-- Users: 01 borrower b1, 02 borrower b2 (Hindi), 03 lender X communications admin, 04 lender X communications approver, 05 lender X servicing operator,
-- 06 lender Y communications admin, 07 and 08 platform users (switch fixture), 09 lender X second approver, 10 and 11 lender admin and product approver.
insert into auth.users (id, phone, raw_app_meta_data)
select pg_temp.u(n), case when n in (1, 2) then '9100000019' || n end, case when n in (1, 2) then '{}'::jsonb else '{"actor_type":"staff"}'::jsonb end from generate_series(1, 11) n;
select pg_temp.keep('b1', (select id::text from identity.borrowers where user_id = pg_temp.u(1)));
select pg_temp.keep('b2', (select id::text from identity.borrowers where user_id = pg_temp.u(2)));

select pg_temp.as_owner();
update identity.borrowers set preferred_language = 'hi' where id = pg_temp.got('b2')::uuid;
insert into tenancy.organizations (id, kind, legal_name, display_name, regulator_registration_no, status) values
  ('fca00000-0000-4000-8000-000000000000', 'platform', 'Udofin Platform (test)', 'Udofin', null, 'active'),
  (pg_temp.lx(), 'lender', 'Alpha Finance Ltd (test)', 'Alpha', 'TEST-FC-0001', 'active'),
  (pg_temp.ly(), 'lender', 'Beta Capital Ltd (test)', 'Beta', 'TEST-FC-0002', 'active');
insert into onboarding.lender_gates (lender_org_id, stage) values (pg_temp.lx(), 'activated'), (pg_temp.ly(), 'activated');
insert into tenancy.memberships (id, org_id, user_id, status) values
  ('fcc10000-0000-4000-8000-000000000003', pg_temp.lx(), pg_temp.u(3), 'active'),
  ('fcc10000-0000-4000-8000-000000000004', pg_temp.lx(), pg_temp.u(4), 'active'),
  ('fcc10000-0000-4000-8000-000000000005', pg_temp.lx(), pg_temp.u(5), 'active'),
  ('fcc10000-0000-4000-8000-000000000006', pg_temp.ly(), pg_temp.u(6), 'active'),
  ('fcc10000-0000-4000-8000-000000000009', pg_temp.lx(), pg_temp.u(9), 'active'),
  ('fcc10000-0000-4000-8000-000000000019', pg_temp.lx(), pg_temp.u(10), 'active'),
  ('fcc10000-0000-4000-8000-000000000020', pg_temp.lx(), pg_temp.u(11), 'active'),
  ('fcc10000-0000-4000-8000-000000000021', pg_temp.ly(), pg_temp.u(10), 'active'),
  ('fcc10000-0000-4000-8000-000000000022', pg_temp.ly(), pg_temp.u(11), 'active');
insert into tenancy.membership_roles (membership_id, role_id)
select g.mid::uuid, r.id from (values
  ('fcc10000-0000-4000-8000-000000000003', 'communications_admin'), ('fcc10000-0000-4000-8000-000000000004', 'communications_approver'),
  ('fcc10000-0000-4000-8000-000000000005', 'servicing_operator'), ('fcc10000-0000-4000-8000-000000000006', 'communications_admin'),
  ('fcc10000-0000-4000-8000-000000000009', 'communications_approver'),
  ('fcc10000-0000-4000-8000-000000000019', 'lender_admin'), ('fcc10000-0000-4000-8000-000000000020', 'product_approver'),
  ('fcc10000-0000-4000-8000-000000000021', 'lender_admin'), ('fcc10000-0000-4000-8000-000000000022', 'product_approver')) as g (mid, rkey)
join tenancy.roles r on r.org_id is null and r.applies_to = 'lender' and r.key = g.rkey;

-- Switches: lender X runs servicing_sync and reminders; lender Y only servicing_sync.
insert into servicing.feature_change_requests (lender_org_id, feature, enable, mode, status, evidence, requested_by, idempotency_key, decided_by, decided_at, applied_at)
select o.lender, f.feature, true, 'two_person', 'applied', '{"contract_ref":"SAMPLE-FC"}', pg_temp.u(7), 'fc-req-' || f.feature || '-' || right(o.lender::text, 1) || '-0001', pg_temp.u(8), now(), now()
from (values (pg_temp.lx()), (pg_temp.ly())) o (lender)
cross join (values ('servicing_sync'), ('reminders')) f (feature)
where not (o.lender = pg_temp.ly() and f.feature <> 'servicing_sync');
insert into servicing.lender_features (lender_org_id, feature, enabled, evidence, enabled_by, enabled_at, last_change_request_id)
select r.lender_org_id, r.feature, true, r.evidence, pg_temp.u(8), now(), r.id from servicing.feature_change_requests r;

insert into lending.loan_products (id, lender_org_id, category_key, code, name, status) values
  ('fc900000-0000-4000-8000-000000000001', pg_temp.lx(), 'personal', 'PL-FC', 'X Personal Loan', 'active'),
  ('fc900000-0000-4000-8000-000000000002', pg_temp.ly(), 'personal', 'PL-FC', 'Y Personal Loan', 'active');
insert into lending.loan_product_versions (id, product_id, lender_org_id, version, status, min_amount_minor, max_amount_minor, min_tenure_days, max_tenure_days,
  rate_type, min_annual_rate_bps, max_annual_rate_bps, drafted_by, approved_by, approved_at, effective_from)
select ('fc910000-0000-4000-8000-00000000000' || n)::uuid, ('fc900000-0000-4000-8000-00000000000' || n)::uuid, ('fcb00000-0000-4000-8000-00000000000' || n)::uuid, 1, 'approved',
       1000000, 50000000, 180, 1825, 'fixed', 1400, 2400, pg_temp.u(10), pg_temp.u(11), now(), now()
from generate_series(1, 2) n;

-- Loans 1 (main path), 2 (overdue, Hindi borrower), 3 (hold note limits), 4 (hold note screen).
select pg_temp.mk_loan(1, pg_temp.lx(), pg_temp.got('b1')::uuid, 1, 31, 1, 475000, 0, 0);
select pg_temp.mk_loan(2, pg_temp.lx(), pg_temp.got('b2')::uuid, -4, 26, 26, 475000, 4, 100000);
select pg_temp.mk_loan(3, pg_temp.lx(), pg_temp.got('b1')::uuid, 1, 31, 1, 475000, 0, 0);
select pg_temp.mk_loan(4, pg_temp.lx(), pg_temp.got('b1')::uuid, 1, 31, 1, 475000, 0, 0);

-- ============================================================================================================================
-- 1. The wording screen (A10, M35, U39): links, short links, domains, phone numbers, Devanagari digits, PAN shapes
-- ============================================================================================================================
select pg_temp.as_owner();
select is(private.reminder_text_ok('Reminder from {{lender_name}}: your installment of {{amount}} is due on {{due_date}}.', true), true, 'a plain service message with the allowed variables still passes');
select is(private.reminder_text_ok('Please pay by 5 p.m. today. A charge of Rs 500 plus 2 percent per month applies as per clause 4.2 of your agreement.', false), true,
  'abbreviations, amounts, percentages and clause numbers are not mistaken for links or phone numbers');
select is(private.reminder_text_ok('Pay your dues at rzp.io/l/AbCd before {{due_date}} please', true), false, 'a payment short link (rzp.io/l/AbCd) is refused');
select is(private.reminder_text_ok('Pay your dues at bit.ly/x7Kq2 before {{due_date}} please', true), false, 'a bit.ly short link is refused');
select is(private.reminder_text_ok('Write to us on t.me/lenderhelp about your account', true), false, 'a t.me link is refused');
select is(private.reminder_text_ok('Visit example.xyz for your account details', true), false, 'a domain with an unlisted top-level domain (.xyz) is refused');
select is(private.reminder_text_ok('Visit udofin.in/pay for your account details', true), false, 'a .in domain is refused (the earlier test of .in could never match)');
select is(private.reminder_text_ok('Pay at pay.example.link/abc or call now please', true), false, 'a dotted host name with a path is refused');
select is(private.reminder_text_ok('Please call 98765 43210 about the installment due {{due_date}}', true), false, 'a ten-digit phone number written with a space is refused');
select is(private.reminder_text_ok('Please call 1800-123-4567 about the installment due {{due_date}}', true), false, 'a toll-free number written with hyphens is refused');
select is(private.reminder_text_ok('Please call 98.765.43210 about the installment due', true), false, 'a phone number written with dots is refused');
select is(private.reminder_text_ok('कृपया ' || chr(2409) || chr(2414) || chr(2407) || chr(2406) || chr(2413) || chr(2412) || chr(2411) || chr(2408) || chr(2415) || chr(2406) || ' पर संपर्क करें', true), false,
  'a ten-digit number written in Devanagari digits is refused');
select is((select bool_and(not private.reminder_text_ok('भुगतान संख्या ' || repeat(chr(2406 + g), 8), false)) from generate_series(0, 9) g), true,
  'a run of eight of any Devanagari digit is refused (every digit is mapped)');
select is(private.reminder_text_ok('Reference abcde 1234 f is on file for you', true), false, 'a PAN-shaped token written lower case with spaces is refused');
select is(private.reminder_text_ok('Reference abcde1234f is on file for you', true), false, 'a PAN-shaped token written lower case is refused');
select is(private.reminder_text_ok('Reference ABCDE 1234 F is on file for you', true), false, 'a PAN-shaped token written upper case with spaces is refused');

select pg_temp.as_user(pg_temp.u(3));
select is(pg_temp.err($$select servicing.draft_reminder_template(pg_temp.lx(), 'pre_due', 'en', 'Pay your dues at rzp.io/l/AbCd before {{due_date}} please')$$), '22023|wording_invalid',
  'a template with a short link cannot be drafted');
select is(pg_temp.err($$select servicing.draft_reminder_template(pg_temp.lx(), 'pre_due', 'en', 'Please call 98765 43210 about the installment due {{due_date}}')$$), '22023|wording_invalid',
  'a template with a spaced phone number cannot be drafted');
select is(pg_temp.err($$select servicing.draft_penal_charge_text(pg_temp.lx(), 'flat', 50000, null, true, true, 'Charge as per the loan agreement', 'Pay at pay.example.link/abc or call 1800-123-4567 now.')$$), '22023|wording_invalid',
  'a penal-charge sentence with a link and a toll-free number cannot be drafted');
select is(pg_temp.err($$select servicing.draft_penal_charge_text(pg_temp.lx(), 'flat', 50000, null, true, true, 'Charge as per the loan agreement', 'A separate penal charge applies to the overdue amount.', 'कृपया ९८७६५४३२१० पर संपर्क करें और भुगतान करें')$$), '22023|wording_invalid',
  'a Hindi penal-charge sentence with a Devanagari phone number cannot be drafted');
select is(pg_temp.err($$select servicing.draft_penal_charge_text(pg_temp.lx(), 'flat', 50000, null, true, true, 'See bit.ly/x7Kq2 for the reason', 'A separate penal charge applies to the overdue amount.')$$), '22023|wording_invalid',
  'a penal-charge reason with a short link cannot be drafted');
select is(pg_temp.err(format($$select servicing.place_communication_hold(%L, 'complaint', 'Call 98765 43210 about this loan')$$, pg_temp.lid(4))), '22023|hold_invalid', 'a hold note with a spaced phone number is refused');
select pg_temp.as_owner();
select is(pg_temp.err(format($$insert into servicing.communication_holds (lender_org_id, loan_account_id, reason, note, placed_by) values (%L, %L, 'complaint', 'Call 98765 43210 about this loan', %L)$$,
  pg_temp.lx(), pg_temp.lid(4), pg_temp.u(3))), '23514|', 'and the table check refuses the same note written around the function');

-- ============================================================================================================================
-- 2. Hold notes: one limit (10 to 200 characters), refused by the function with hold_invalid (A11, M43)
-- ============================================================================================================================
select pg_temp.as_user(pg_temp.u(3));
select is(pg_temp.err(format($$select servicing.place_communication_hold(%L, 'complaint', %L)$$, pg_temp.lid(3), left(repeat('Borrower raised a complaint with the lender. ', 10), 250))), '22023|hold_invalid',
  'a 250-character plain note answers hold_invalid, not a raw check violation');
select is(pg_temp.err(format($$select servicing.place_communication_hold(%L, 'complaint', %L)$$, pg_temp.lid(3), left(repeat('Borrower raised a complaint with the lender. ', 10), 201))), '22023|hold_invalid',
  'a 201-character note is refused');
select is(pg_temp.err(format($$select servicing.place_communication_hold(%L, 'complaint', 'Too short')$$, pg_temp.lid(3))), '22023|hold_invalid', 'a 9-character note is refused (the floor is 10)');
select pg_temp.keep('hold3', servicing.place_communication_hold(pg_temp.lid(3), 'complaint', left(repeat('Borrower raised a complaint with the lender. ', 10), 200))::text);
select is((select length(note) from servicing.communication_holds where id = pg_temp.got('hold3')::uuid), 200, 'a 200-character note is accepted and stored whole');
select is(pg_temp.err(format($$select servicing.release_communication_hold(%L, %L)$$, pg_temp.got('hold3'), left(repeat('Complaint closed by the lender. ', 10), 250))), '22023|hold_invalid',
  'a 250-character release note answers hold_invalid');
select is(pg_temp.err(format($$select servicing.release_communication_hold(%L, 'see bit.ly/x7Kq2 for details of the closure')$$, pg_temp.got('hold3'))), '22023|hold_invalid', 'a release note with a short link is refused');
select is(pg_temp.err(format($$select servicing.release_communication_hold(%L, %L)$$, pg_temp.got('hold3'), left(repeat('Complaint closed by the lender. ', 10), 200))), 'ok', 'a 200-character release note is accepted');
select is((select length(release_note) from servicing.communication_holds where id = pg_temp.got('hold3')::uuid), 200, 'and stored whole');
select pg_temp.as_owner();
select is(pg_temp.err(format($$insert into servicing.communication_holds (lender_org_id, loan_account_id, reason, note, placed_by) values (%L, %L, 'complaint', %L, %L)$$,
  pg_temp.lx(), pg_temp.lid(3), left(repeat('Borrower raised a complaint with the lender. ', 10), 250), pg_temp.u(3))), '23514|', 'the table still limits a note to 200 characters: function and table now agree');

-- Policy, wording and penal-charge text for lender X (drafted by one person, approved by another).
select pg_temp.as_user(pg_temp.u(3));
select pg_temp.keep('pol1', servicing.draft_reminder_policy(pg_temp.lx(), array[-1, 0, 3], true, array['in_app', 'push', 'sms'], time '09:00', time '18:00', 2)::text);
select pg_temp.keep('t_pre', servicing.draft_reminder_template(pg_temp.lx(), 'pre_due', 'en', 'Reminder from {{lender_name}}: your installment of {{amount}} is due on {{due_date}}.')::text);
select pg_temp.keep('t_due', servicing.draft_reminder_template(pg_temp.lx(), 'due_day', 'en', 'Reminder from {{lender_name}}: your installment of {{amount}} is due today, {{due_date}}.')::text);
select pg_temp.keep('t_over', servicing.draft_reminder_template(pg_temp.lx(), 'overdue', 'en', '{{lender_name}} reminder: {{amount}} is overdue since {{due_date}}. {{penal_text}}')::text);
select pg_temp.keep('t_over_hi', servicing.draft_reminder_template(pg_temp.lx(), 'overdue', 'hi', 'आपका {{amount}} का भुगतान बकाया है। {{penal_text}}')::text);
select pg_temp.keep('pen1', servicing.draft_penal_charge_text(pg_temp.lx(), 'flat', 50000, null, true, true, 'Charge as per the loan agreement', 'A separate penal charge applies to the overdue amount as per your loan agreement.')::text);
select pg_temp.as_user(pg_temp.u(4));
select servicing.approve_reminder_policy(pg_temp.got('pol1')::uuid);
select servicing.approve_reminder_template(pg_temp.got('t_pre')::uuid);
select servicing.approve_reminder_template(pg_temp.got('t_due')::uuid);
select servicing.approve_reminder_template(pg_temp.got('t_over')::uuid);
select servicing.approve_reminder_template(pg_temp.got('t_over_hi')::uuid);
select servicing.approve_penal_charge_text(pg_temp.got('pen1')::uuid);

-- ============================================================================================================================
-- 3. Structure and grants of the redefined system functions
-- ============================================================================================================================
select pg_temp.as_owner();
select is(to_regprocedure('servicing.record_reminder_attempt(uuid, text, text, text, text)') is null and to_regprocedure('servicing.record_reminder_attempt(uuid, text, text, text, text, integer)') is not null, true,
  'record_reminder_attempt exists once, with the claim token parameter');
select ok(coalesce(has_function_privilege('service_role', to_regprocedure('servicing.claim_due_reminders(integer, interval)')::oid, 'execute'), false)
          and coalesce(has_function_privilege('service_role', to_regprocedure('servicing.record_reminder_attempt(uuid, text, text, text, text, integer)')::oid, 'execute'), false),
  'the system role can run both after they were created again');
select ok((select bool_and(not coalesce(has_function_privilege(r, to_regprocedure(f)::oid, 'execute'), false))
           from unnest(array['anon', 'authenticated', 'public']) r
           cross join unnest(array['servicing.claim_due_reminders(integer, interval)', 'servicing.record_reminder_attempt(uuid, text, text, text, text, integer)']) f),
  'and neither anon, signed-in users nor public can');
select pg_temp.as_system();
select is(pg_temp.err($$select claim_token from servicing.claim_due_reminders(1)$$), 'ok', 'claim_due_reminders returns a claim_token column');

-- ============================================================================================================================
-- 4. Planning: no starvation behind existing rows (M42), no pre-due or due-day message for a day that has passed (M33), the guards that were untested (M38)
-- ============================================================================================================================
select pg_temp.as_system();
select is(servicing.plan_reminders(interval '10 days') > 0, true, 'the planner runs for loans 1 to 3');
select pg_temp.as_owner();
select pg_temp.mk_loan(12, pg_temp.lx(), pg_temp.got('b1')::uuid, 1, 31, 1, 475000, 0, 0);
select pg_temp.as_system();
select is(servicing.plan_reminders(interval '10 days', 1), 1, 'with a limit of 1 the planner still adds a new message although older suppressed placeholders (sms) exist');
select servicing.plan_reminders(interval '10 days', 1);
select servicing.plan_reminders(interval '10 days', 1);
select servicing.plan_reminders(interval '10 days', 1);
select servicing.plan_reminders(interval '10 days', 1);
select servicing.plan_reminders(interval '10 days', 1);
select is((select count(*) from servicing.reminders where loan_account_id = pg_temp.lid(12)), 6::bigint, 'six small runs plan all six messages of the new loan (two offsets on three channels)');
select is(servicing.plan_reminders(interval '10 days', 1), 0, 'and a further run plans nothing: existing rows are not candidates');

select pg_temp.as_owner();
select pg_temp.mk_loan(5, pg_temp.lx(), pg_temp.got('b1')::uuid, -1, 29, -1, 475000, 1, 475000);
select pg_temp.mk_loan(30, pg_temp.lx(), pg_temp.got('b1')::uuid, -7, 23, 23, 475000, 4, 100000, interval '3 days');
select pg_temp.mk_loan(31, pg_temp.lx(), pg_temp.got('b1')::uuid, -4, 26, 26, 475000, 4, 100000);
insert into servicing.sync_anomalies (lender_org_id, loan_account_id, kind, severity, snapshot_id, source_system, source_record_id, content_sha256, reported_as_of)
select s.lender_org_id, s.loan_account_id, 'outstanding_rise_without_charge', 'warning', s.id, 'file_import', s.source_record_id, s.content_sha256, s.reported_as_of
from servicing.balance_snapshots s where s.loan_account_id = pg_temp.lid(31);
select pg_temp.mk_loan(34, pg_temp.lx(), pg_temp.got('b1')::uuid, 1, 31, 1, 475000, 0, 0);
update servicing.loan_accounts set status = 'closed' where id = pg_temp.lid(34);
select pg_temp.as_system();
select servicing.plan_reminders(interval '10 days');
select is((select count(*) from servicing.reminders where loan_account_id = pg_temp.lid(5) and offset_days <= 0), 0::bigint,
  'loan 5 (installment due yesterday, one day past due): no pre-due or due-day message is planned for the day that has passed');
select is((select count(*) from servicing.reminders where loan_account_id = pg_temp.lid(5) and offset_days > 0 and channel = 'in_app'), 2::bigint,
  'but its overdue messages are (the configured offset and the weekly tail), for its oldest overdue installment');
select is((select count(*) from servicing.reminders where loan_account_id in (pg_temp.lid(30), pg_temp.lid(31))), 0::bigint,
  'no overdue message is planned from a stale report (loan 30) or from a report with a warning flag (loan 31)');
select is((select count(*) from servicing.reminders where loan_account_id = pg_temp.lid(34)), 0::bigint, 'nothing is planned for a loan that is closed');

-- ============================================================================================================================
-- 5. Claiming
-- ============================================================================================================================
select pg_temp.as_owner();
select pg_temp.clear_planned();
select pg_temp.as_system();
select pg_temp.at_ist('11:00');

-- 5.1 The limit applies to claimable messages (A23, M37): older rows that are held back do not use it up.
select pg_temp.as_owner();
select pg_temp.mk_loan(8, pg_temp.lx(), pg_temp.got('b1')::uuid, 1, 31, 1, 475000, 0, 0, interval '3 days');
select pg_temp.mk_loan(9, pg_temp.lx(), pg_temp.got('b1')::uuid, 1, 31, 1, 475000, 0, 0);
select pg_temp.mk_loan(7, pg_temp.ly(), pg_temp.got('b1')::uuid, 1, 31, 1, 475000, 0, 0);
-- 205 rows of the stale-report loan (more than one page of the scan), all older than the claimable row.
insert into servicing.reminders (lender_org_id, loan_account_id, borrower_id, policy_id, installment_seq, due_date, offset_days, channel, scheduled_for)
select la.lender_org_id, la.id, la.borrower_id, pg_temp.pol(), g, pg_temp.d() + 1, 0, 'in_app', now() - interval '3 hours' - g * interval '1 second'
from servicing.loan_accounts la, generate_series(1, 205) g where la.id = pg_temp.lid(8);
set local session_replication_role = replica;
insert into servicing.reminder_policies (lender_org_id, version, status, offsets_days, channels, window_from, window_to, max_per_day, drafted_by, approved_by, approved_at)
values (pg_temp.ly(), 1, 'approved', array[0], array['in_app'], time '09:00', time '18:00', 2, pg_temp.u(6), pg_temp.u(10), now());
insert into servicing.reminders (lender_org_id, loan_account_id, borrower_id, policy_id, installment_seq, due_date, offset_days, channel, scheduled_for)
select pg_temp.ly(), pg_temp.lid(7), pg_temp.got('b1')::uuid, p.id, 1, pg_temp.d() + 1, o.off, c.ch, now() - interval '4 hours'
from servicing.reminder_policies p cross join (values (0), (-1)) o (off) cross join (values ('in_app'), ('push')) c (ch) where p.lender_org_id = pg_temp.ly();
set local session_replication_role = origin;
select pg_temp.mk_rem(9, 1, 1, 0, 'in_app', interval '1 hour');
select pg_temp.as_system();
select is(pg_temp.claim(3), 1::bigint, 'with a limit of 3, four rows of a lender whose reminders switch is off and 205 rows (more than one page of the scan) held back by a stale report come before the one claimable row: it is still claimed');
select is(pg_temp.st(9, 1, 0), 'claimed', 'the claimable message is the one that was claimed');
select is((select count(*) from servicing.reminders where loan_account_id = pg_temp.lid(8) and status = 'planned'), 205::bigint, 'the 205 rows held back by the stale report stay planned (not claimed, not suppressed, not dropped)');
select is((select count(*) from servicing.reminders where loan_account_id = pg_temp.lid(7) and status = 'planned'), 4::bigint, 'and so do the four rows of the lender whose reminders switch is off');

-- 5.2 A pre-due or due-day message is never claimed for an installment whose day has passed (M33).
select pg_temp.as_owner();
select pg_temp.clear_planned();
select pg_temp.mk_rem(5, 3, -1, -1, 'in_app', interval '2 hours');
select pg_temp.mk_rem(5, 3, -1, 0, 'in_app', interval '90 minutes');
select pg_temp.mk_rem(5, 3, -1, 3, 'in_app', interval '30 minutes');
select pg_temp.as_system();
select pg_temp.claim();
select is(pg_temp.st(5, 3, -1), 'suppressed:expired', 'loan 5: the pre-due message for an installment due yesterday is not sent ("could not be sent in time")');
select is(pg_temp.st(5, 3, 0), 'suppressed:expired', 'and neither is the due-day message ("is due today" would be false)');
select is(pg_temp.st(5, 3, 3), 'claimed', 'only the overdue message goes, with the lender''s penal-charge sentence');
select is((select (variables ->> 'due_date' = (pg_temp.d() - 1)::text and variables ->> 'amount_minor' = '475000' and penal_text_id = pg_temp.got('pen1')::uuid and penal_text_sha256 is not null)
           from servicing.reminders where id = pg_temp.rid(5, 3, 3)), true, 'it carries the overdue date, the lender''s overdue figure and the approved penal-charge sentence');

-- 5.3 While the report shows an overdue amount, a later installment's pre-due message waits (M33).
select pg_temp.as_owner();
select pg_temp.clear_planned();
select pg_temp.mk_loan(14, pg_temp.lx(), pg_temp.got('b1')::uuid, -15, 15, 15, 475000, 15, 475000);
select pg_temp.mk_rem(14, 2, 15, -1, 'in_app', interval '1 hour');
select pg_temp.as_system();
select pg_temp.claim();
select is(pg_temp.st(14, 2, -1), 'planned', 'loan 14 is 15 days past due: the pre-due message of its next installment waits (planned), only the overdue path speaks');

-- 5.4 An overdue message must still be about the oldest overdue installment (M34).
select pg_temp.as_owner();
select pg_temp.clear_planned();
select pg_temp.mk_loan(6, pg_temp.lx(), pg_temp.got('b1')::uuid, -45, -15, -15, 475000, 15, 475000);
select pg_temp.mk_rem(6, 1, -45, 3, 'in_app', interval '2 hours');
select pg_temp.mk_rem(6, 2, -15, 3, 'in_app', interval '1 hour');
select pg_temp.as_system();
select pg_temp.claim();
select is(pg_temp.st(6, 1, 3), 'suppressed:paid', 'loan 6: installment 1 was paid, so the overdue message planned for it is stopped (it would show a later installment''s amount under its date)');
select is((select (status, variables ->> 'due_date' = (pg_temp.d() - 15)::text, variables ->> 'amount_minor')::text from servicing.reminders where id = pg_temp.rid(6, 2, 3)), '(claimed,t,475000)',
  'and the message for the oldest overdue installment (installment 2) is claimed with its own date and the lender''s overdue figure');

-- 5.5 A retry re-checks the wording, the figures and the penal-charge text (M36).
-- (a) The wording was replaced by newer approved wording between the attempts.
select pg_temp.as_owner();
select pg_temp.clear_planned();
select pg_temp.mk_loan(15, pg_temp.lx(), pg_temp.got('b1')::uuid, 1, 31, 1, 475000, 0, 0);
select pg_temp.mk_rem(15, 1, 1, -1, 'in_app');
select pg_temp.as_system();
select pg_temp.claim();
select pg_temp.keep('hash15', (select content_sha256 from servicing.reminders where id = pg_temp.rid(15, 1, -1)));
select is(pg_temp.rec(pg_temp.rid(15, 1, -1), 'failed', 1, 'provider_timeout'), 'failed', 'loan 15: the first attempt fails and the message is planned again');
select pg_temp.as_owner();
update servicing.reminders set scheduled_for = now() - interval '1 minute' where id = pg_temp.rid(15, 1, -1);
select pg_temp.as_user(pg_temp.u(3));
select pg_temp.keep('t_pre3', servicing.draft_reminder_template(pg_temp.lx(), 'pre_due', 'en', 'Reminder from {{lender_name}}: {{amount}} falls due on {{due_date}}.')::text);
select pg_temp.as_user(pg_temp.u(4));
select servicing.approve_reminder_template(pg_temp.got('t_pre3')::uuid);
select pg_temp.as_system();
select pg_temp.claim();
select is((select (status, attempts, template_id = pg_temp.got('t_pre3')::uuid, content_sha256 <> pg_temp.got('hash15'))::text from servicing.reminders where id = pg_temp.rid(15, 1, -1)), '(claimed,2,t,t)',
  'the retry does not reuse the retired wording: it is frozen again with the newer approved wording (new hash)');
select is((select content_sha256 from servicing.reminders where id = pg_temp.rid(15, 1, -1)),
  encode(sha256(convert_to('Reminder from Alpha: Rs 4,750.00 falls due on ' || to_char(pg_temp.d() + 1, 'DD Mon YYYY') || '.', 'UTF8')), 'hex'), 'and the hash is that of the newer wording as it will be shown');
select is((select count(*) from servicing.reminder_deliveries where reminder_id = pg_temp.rid(15, 1, -1) and content_sha256 = pg_temp.got('hash15')), 1::bigint, 'the delivery log keeps the hash of the first attempt');

-- (b) A newer report changed the amount between the attempts.
select pg_temp.as_owner();
select pg_temp.clear_planned();
select pg_temp.mk_loan(16, pg_temp.lx(), pg_temp.got('b1')::uuid, 1, 31, 1, 475000, 0, 0);
select pg_temp.mk_rem(16, 1, 1, -1, 'in_app');
select pg_temp.as_system();
select pg_temp.claim();
select pg_temp.rec(pg_temp.rid(16, 1, -1), 'failed', 1, 'provider_timeout');
select pg_temp.as_owner();
insert into servicing.balance_snapshots (lender_org_id, loan_account_id, version, status, outstanding_principal_minor, total_overdue_minor, next_due_on, next_due_minor, days_past_due,
  source_system, source_record_id, reported_as_of, content_sha256)
values (pg_temp.lx(), pg_temp.lid(16), 2, 'active', 4000000, 0, pg_temp.d() + 1, 300000, 0, 'file_import', 'SRC-SAMPLE-LN-16-B', clock_timestamp(), pg_temp.sha('snap-16b'));
update servicing.reminders set scheduled_for = now() - interval '1 minute' where id = pg_temp.rid(16, 1, -1);
select pg_temp.as_system();
select pg_temp.claim();
select is((select (status, attempts, variables ->> 'amount_minor')::text from servicing.reminders where id = pg_temp.rid(16, 1, -1)), '(claimed,2,300000)', 'loan 16: a retry after the lender reported a new amount is frozen again with the new amount');
select is((select content_sha256 from servicing.reminders where id = pg_temp.rid(16, 1, -1)),
  encode(sha256(convert_to('Reminder from Alpha: Rs 3,000.00 falls due on ' || to_char(pg_temp.d() + 1, 'DD Mon YYYY') || '.', 'UTF8')), 'hex'), 'and its hash is that of the message with the new amount');

-- (c) The wording was withdrawn and nothing replaced it.
select pg_temp.as_owner();
select pg_temp.clear_planned();
select pg_temp.mk_loan(17, pg_temp.lx(), pg_temp.got('b1')::uuid, 1, 31, 1, 475000, 0, 0);
select pg_temp.mk_rem(17, 1, 1, 0, 'in_app');
select pg_temp.as_system();
select pg_temp.claim();
select pg_temp.rec(pg_temp.rid(17, 1, 0), 'failed', 1, 'provider_error');
select pg_temp.as_owner();
update servicing.reminders set scheduled_for = now() - interval '1 minute' where id = pg_temp.rid(17, 1, 0);
select pg_temp.as_user(pg_temp.u(3));
select servicing.retire_reminder_template(pg_temp.got('t_due')::uuid);
select pg_temp.as_system();
select pg_temp.claim();
select is(pg_temp.st(17, 1, 0), 'suppressed:template_missing', 'loan 17: a retry after the lender withdrew the wording and approved none is stopped, not sent with the retired wording');
select pg_temp.as_user(pg_temp.u(3));
select pg_temp.keep('t_due2', servicing.draft_reminder_template(pg_temp.lx(), 'due_day', 'en', 'Reminder from {{lender_name}}: your installment of {{amount}} is due today, {{due_date}}. Thank you.')::text);
select pg_temp.as_user(pg_temp.u(4));
select servicing.approve_reminder_template(pg_temp.got('t_due2')::uuid);

-- (d) A newer approved penal-charge sentence replaced the frozen one: no false exception, the message carries the current sentence.
select pg_temp.as_owner();
select pg_temp.clear_planned();
select pg_temp.mk_loan(18, pg_temp.lx(), pg_temp.got('b1')::uuid, -4, 26, 26, 475000, 4, 100000);
select pg_temp.mk_rem(18, 1, -4, 3, 'in_app');
select pg_temp.as_system();
select pg_temp.claim();
select pg_temp.rec(pg_temp.rid(18, 1, 3), 'failed', 1, 'provider_timeout');
select pg_temp.as_owner();
update servicing.reminders set scheduled_for = now() - interval '1 minute' where id = pg_temp.rid(18, 1, 3);
select pg_temp.as_user(pg_temp.u(3));
select pg_temp.keep('pen2', servicing.draft_penal_charge_text(pg_temp.lx(), 'flat', 50000, null, true, true, 'Charge as per the loan agreement',
  'A separate penal charge, as stated in your loan agreement, applies to the overdue amount.')::text);
select pg_temp.as_user(pg_temp.u(9));
select servicing.approve_penal_charge_text(pg_temp.got('pen2')::uuid);
select pg_temp.as_system();
select pg_temp.claim();
select is((select (status, penal_text_id = pg_temp.got('pen2')::uuid,
                   penal_text_sha256 = encode(sha256(convert_to('A separate penal charge, as stated in your loan agreement, applies to the overdue amount.', 'UTF8')), 'hex'))::text
           from servicing.reminders where id = pg_temp.rid(18, 1, 3)), '(claimed,t,t)', 'loan 18: the retried overdue message is frozen again with the lender''s current approved sentence');
select is((select count(*) from payments.reconciliation_exceptions where lender_org_id = pg_temp.lx() and class = 'penal_text_missing'), 0::bigint,
  'and no penal_text_missing exception was raised: the lender has an approved sentence');

-- 5.6 The daily cap counts by the latest claim, so a retry that crosses midnight does not add a third message (M39).
select pg_temp.as_owner();
select pg_temp.clear_planned();
select pg_temp.mk_loan(10, pg_temp.lx(), pg_temp.got('b1')::uuid, 2, 32, 2, 475000, 0, 0);
select pg_temp.mk_rem(10, 1, 2, -2, 'in_app', interval '3 hours');
select pg_temp.mk_rem(10, 1, 2, -1, 'in_app', interval '150 minutes');
select pg_temp.mk_rem(10, 1, 2, 0, 'in_app', interval '1 hour');
select pg_temp.as_system();
select pg_temp.claim();
select is(pg_temp.st(10, 1, -2) || ',' || pg_temp.st(10, 1, -1) || ',' || pg_temp.st(10, 1, 0), 'claimed,claimed,planned', 'loan 10, day one: the first two messages are claimed and the third waits (cap of two a day)');
select pg_temp.rec(pg_temp.rid(10, 1, -2), 'failed', 1, 'provider_timeout');
select pg_temp.rec(pg_temp.rid(10, 1, -1), 'failed', 1, 'provider_timeout');
select pg_temp.as_owner();
select pg_temp.backdate(pg_temp.rid(10, 1, -2), interval '1 day');
select pg_temp.backdate(pg_temp.rid(10, 1, -1), interval '1 day');
update servicing.reminders set scheduled_for = now() - interval '3 hours' where id = pg_temp.rid(10, 1, -2);
update servicing.reminders set scheduled_for = now() - interval '150 minutes' where id = pg_temp.rid(10, 1, -1);
select pg_temp.as_system();
select pg_temp.claim();
select is(pg_temp.st(10, 1, -2) || ',' || pg_temp.st(10, 1, -1) || ',' || pg_temp.st(10, 1, 0), 'claimed,claimed,planned',
  'day two: the two retried messages are claimed again and count for today, so the third still waits: at most two distinct messages are claimed in one IST day');

-- 5.7 A stale worker cannot corrupt a live claim (M40).
select pg_temp.as_owner();
select pg_temp.clear_planned();
select pg_temp.mk_loan(19, pg_temp.lx(), pg_temp.got('b1')::uuid, 1, 31, 1, 475000, 0, 0);
select pg_temp.mk_rem(19, 1, 1, -1, 'in_app');
select pg_temp.mk_rem(19, 1, 1, -1, 'push');
select pg_temp.as_system();
select pg_temp.claim();
select pg_temp.as_owner();
update servicing.reminders set claimed_until = now() - interval '1 minute' where id = pg_temp.rid(19, 1, -1);
select pg_temp.as_system();
select pg_temp.claim();
select is((select (status, attempts)::text from servicing.reminders where id = pg_temp.rid(19, 1, -1)), '(claimed,2)', 'loan 19: worker A''s lease ran out and worker B claimed the message again (attempt 2)');
select is(pg_temp.rec(pg_temp.rid(19, 1, -1), 'failed', 1, 'provider_timeout'), '55000|not_claimed', 'worker A''s late report (token 1) is refused: it is not this claim');
select is((select (status, attempts)::text from servicing.reminders where id = pg_temp.rid(19, 1, -1)), '(claimed,2)', 'and it changed nothing: the message is still worker B''s claim');
select is(pg_temp.rec(pg_temp.rid(19, 1, -1), 'accepted', 2), 'accepted', 'worker B''s report (token 2) is accepted');
select is(pg_temp.st(19, 1, -1), 'sent', 'and the message is sent');
select is(pg_temp.err(format($$select servicing.record_reminder_attempt(%L, 'accepted', 'send')$$, pg_temp.rid(19, 1, -1, 'push'))), 'ok', 'a report with no token is still accepted (the stale-claim check applies when a token is given)');
select is(pg_temp.err(format($$select servicing.record_reminder_attempt(%L, 'delivered', 'delivery_report', 'SAMPLE-PUSH-REF-19', null, 1)$$, pg_temp.rid(19, 1, -1, 'push'))), '22023|bad_request', 'a claim token makes no sense on a delivery report');

-- 5.8 A hold placed after the claim stops the message (M40).
select pg_temp.as_owner();
select pg_temp.clear_planned();
select pg_temp.mk_loan(20, pg_temp.lx(), pg_temp.got('b1')::uuid, 1, 31, 1, 475000, 0, 0);
select pg_temp.mk_rem(20, 1, 1, -1, 'in_app');
select pg_temp.as_system();
select pg_temp.claim();
select is(pg_temp.st(20, 1, -1), 'claimed', 'loan 20: the message is claimed');
select pg_temp.as_user(pg_temp.u(3));
select servicing.place_communication_hold(pg_temp.lid(20), 'complaint', 'Borrower raised a complaint with the lender');
select pg_temp.as_system();
select is(pg_temp.st(20, 1, -1), 'suppressed:hold', 'a hold placed after the claim stops the message that was claimed but not yet sent');
select is(pg_temp.rec(pg_temp.rid(20, 1, -1), 'accepted', 1), '55000|not_claimed', 'and the worker''s report that it was sent is refused');
select pg_temp.as_user(pg_temp.u(1));
select is((select count(*) from servicing.my_reminders() where loan_account_id = pg_temp.lid(20)), 0::bigint, 'the borrower is shown no message for the held loan');

-- 5.9 The quiet period after a payment (M41, M38).
select pg_temp.as_owner();
select pg_temp.clear_planned();
select pg_temp.mk_loan(21, pg_temp.lx(), pg_temp.got('b1')::uuid, 1, 31, 1, 475000, 0, 0);
select pg_temp.mk_loan(22, pg_temp.lx(), pg_temp.got('b1')::uuid, 1, 31, 1, 475000, 0, 0);
select pg_temp.mk_loan(23, pg_temp.lx(), pg_temp.got('b1')::uuid, 1, 31, 1, 475000, 0, 0);
select pg_temp.mk_loan(24, pg_temp.lx(), pg_temp.got('b1')::uuid, 1, 31, 1, 475000, 0, 0);
select pg_temp.mk_loan(25, pg_temp.lx(), pg_temp.got('b1')::uuid, 1, 31, 1, 475000, 0, 0);
select pg_temp.mk_loan(26, pg_temp.lx(), pg_temp.got('b1')::uuid, 1, 31, 1, 475000, 0, 0);
select pg_temp.mk_loan(27, pg_temp.lx(), pg_temp.got('b1')::uuid, 1, 31, 1, 475000, 0, 0);
-- 21: a receipt for a payment made five days ago, reported just now. 22: the same, reported ten days ago. 23: a receipt dated in the future, reported ten days ago.
insert into servicing.lms_receipts (lender_org_id, loan_account_id, kind, lms_receipt_ref, amount_minor, value_date, source_system, source_record_id, reported_as_of, received_at, content_sha256) values
  (pg_temp.lx(), pg_temp.lid(21), 'receipt', 'SAMPLE-RCPT-21', 475000, pg_temp.d() - 5, 'file_import', 'SRC-RCPT-21', clock_timestamp() - interval '2 minutes', clock_timestamp(), pg_temp.sha('rcpt21')),
  (pg_temp.lx(), pg_temp.lid(22), 'receipt', 'SAMPLE-RCPT-22', 475000, pg_temp.d() - 5, 'file_import', 'SRC-RCPT-22', clock_timestamp() - interval '10 days', clock_timestamp() - interval '10 days', pg_temp.sha('rcpt22')),
  (pg_temp.lx(), pg_temp.lid(23), 'receipt', 'SAMPLE-RCPT-23', 475000, pg_temp.d() + 30, 'file_import', 'SRC-RCPT-23', clock_timestamp() - interval '10 days', clock_timestamp() - interval '10 days', pg_temp.sha('rcpt23')),
  (pg_temp.lx(), pg_temp.lid(27), 'receipt', 'SAMPLE-RCPT-27', 475000, pg_temp.d(), 'file_import', 'SRC-RCPT-27', clock_timestamp() - interval '2 hours', clock_timestamp() - interval '2 hours', pg_temp.sha('rcpt27'));
-- 27: that receipt was reversed by the lender.
insert into servicing.lms_receipts (lender_org_id, loan_account_id, kind, lms_receipt_ref, reverses_receipt_id, reverses_receipt_ref, amount_minor, value_date, source_system, source_record_id, reported_as_of,
  received_at, content_sha256)
select pg_temp.lx(), pg_temp.lid(27), 'reversal', 'SAMPLE-RV-27', r.id, r.lms_receipt_ref, 475000, pg_temp.d(), 'file_import', 'SRC-RV-27', clock_timestamp() - interval '1 hour', clock_timestamp() - interval '1 hour', pg_temp.sha('rv27')
from servicing.lms_receipts r where r.loan_account_id = pg_temp.lid(27) and r.kind = 'receipt';
set local session_replication_role = replica;
-- 24: a mandate debit settled just now. 25: one settled ten days ago.
insert into payments.mandate_debits (lender_org_id, mandate_id, loan_account_id, planned, scheduled_on, amount_minor, status, rank, provider_debit_ref, created_at, updated_at) values
  (pg_temp.lx(), gen_random_uuid(), pg_temp.lid(24), false, pg_temp.d(), 475000, 'settled', 40, 'SAMPLE-DEBIT-24', now(), now()),
  (pg_temp.lx(), gen_random_uuid(), pg_temp.lid(25), false, pg_temp.d() - 10, 475000, 'settled', 40, 'SAMPLE-DEBIT-25', now() - interval '10 days', now() - interval '10 days');
-- 26: a verified provider payment captured just now.
insert into payments.provider_payments (lender_org_id, config_id, provider, provider_payment_ref, order_ref, intent_id, loan_account_id, status, rank, amount_minor, currency, captured_at, first_event_id, last_event_id)
values (pg_temp.lx(), gen_random_uuid(), 'mock_gateway', 'SAMPLE-PAY-26', 'SAMPLE-ORDER-26', gen_random_uuid(), pg_temp.lid(26), 'captured', 30, 475000, 'INR', now(), gen_random_uuid(), gen_random_uuid());
set local session_replication_role = origin;
select pg_temp.mk_rem(21, 1, 1, -1, 'in_app');
select pg_temp.mk_rem(22, 1, 1, -1, 'in_app');
select pg_temp.mk_rem(23, 1, 1, -1, 'in_app');
select pg_temp.mk_rem(24, 1, 1, -1, 'in_app');
select pg_temp.mk_rem(25, 1, 1, -1, 'in_app');
select pg_temp.mk_rem(26, 1, 1, -1, 'in_app');
select pg_temp.mk_rem(27, 1, 1, -1, 'in_app');
select pg_temp.as_system();
select pg_temp.claim();
select is(pg_temp.st(21, 1, -1), 'suppressed:recent_payment', 'loan 21: a receipt the lender reported just now for a payment dated five days ago stops the reminder (by when it was received, not only its value date)');
select is(pg_temp.st(22, 1, -1), 'claimed', 'loan 22: the same receipt reported ten days ago does not');
select is(pg_temp.st(23, 1, -1), 'claimed', 'loan 23: a receipt dated in the future, reported ten days ago, does not suppress reminders for ever');
select is(pg_temp.st(24, 1, -1), 'suppressed:recent_payment', 'loan 24: a mandate debit settled just now stops the reminder');
select is(pg_temp.st(25, 1, -1), 'claimed', 'loan 25: a mandate debit settled ten days ago does not');
select is(pg_temp.st(26, 1, -1), 'suppressed:recent_payment', 'loan 26: a verified provider payment captured just now stops the reminder');
select is(pg_temp.st(27, 1, -1), 'claimed', 'loan 27: a receipt that the lender reversed does not count as a payment');

-- 5.10 Guards that no test covered (M38).
select pg_temp.as_owner();
select pg_temp.clear_planned();
select pg_temp.mk_loan(28, pg_temp.lx(), pg_temp.got('b1')::uuid, 1, 31, 1, 475000, 0, 0);
insert into servicing.sync_anomalies (lender_org_id, loan_account_id, kind, severity, snapshot_id, source_system, source_record_id, content_sha256, reported_as_of)
select s.lender_org_id, s.loan_account_id, 'outstanding_rise_without_charge', 'warning', s.id, 'file_import', s.source_record_id, s.content_sha256, s.reported_as_of
from servicing.balance_snapshots s where s.loan_account_id = pg_temp.lid(28);
select pg_temp.mk_loan(29, pg_temp.lx(), pg_temp.got('b1')::uuid, 1, 31, 1, 475000, 0, 0);
insert into servicing.sync_conflicts (lender_org_id, loan_account_id, record_type, conflict_reason, source_record_id, existing_content_sha256, existing_reported_as_of, incoming_content_sha256, incoming_reported_as_of,
  incoming_report, source_system)
values (pg_temp.lx(), pg_temp.lid(29), 'loan', 'same_record_different_content', 'SRC-SAMPLE-LN-29', pg_temp.sha('c29a'), now() - interval '2 hours', pg_temp.sha('c29b'), now() - interval '1 hour', '{}'::jsonb, 'file_import');
select pg_temp.mk_loan(32, pg_temp.lx(), pg_temp.got('b1')::uuid, 1, 31, 1, 475000, 0, 0, interval '1 minute', 'closed');
select pg_temp.mk_loan(33, pg_temp.lx(), pg_temp.got('b1')::uuid, 1, 31, 1, 475000, 0, 0);
select pg_temp.mk_loan(35, pg_temp.lx(), pg_temp.got('b1')::uuid, 1, 31, 1, 475000, 0, 0);
select pg_temp.mk_rem(28, 1, 1, -1, 'in_app');
select pg_temp.mk_rem(29, 1, 1, -1, 'in_app');
select pg_temp.mk_rem(32, 1, 1, -1, 'in_app');
select pg_temp.mk_rem(33, 2, 31, -1, 'in_app');
select pg_temp.mk_rem(35, 1, 1, -1, 'in_app', interval '49 hours');
select pg_temp.as_system();
select pg_temp.claim();
select is(pg_temp.st(28, 1, -1), 'planned', 'loan 28: a warning flag on the newest report holds the message back (planned, not claimed)');
select is(pg_temp.st(29, 1, -1), 'planned', 'loan 29: an open conflict about the loan record holds the message back');
select is(pg_temp.st(32, 1, -1), 'suppressed:loan_closed', 'loan 32: a report that says the loan is closed stops the message of a loan still marked active');
select is(pg_temp.st(33, 2, -1), 'planned', 'loan 33: the message of a later installment waits while the lender reports an earlier one as next due');
select is(pg_temp.st(35, 1, -1), 'suppressed:expired', 'loan 35: a planned message more than 48 hours late is suppressed (expired)');
select pg_temp.as_owner();
select is(pg_temp.err(format($$update servicing.reminders set status = 'planned', suppress_reason = null where id = %L$$, pg_temp.rid(35, 1, -1))), 'P0001|', 'a message suppressed as expired does not come back');

-- 5.11 The borrower sees a lender's messages only while its reminders switch is on (M38).
select pg_temp.as_user(pg_temp.u(1));
select is((select count(*) from servicing.my_reminders() where loan_account_id = pg_temp.lid(19)), 1::bigint, 'borrower b1 sees the message that was sent for loan 19');
select pg_temp.as_owner();
set local session_replication_role = replica;
update servicing.lender_features set enabled = false where lender_org_id = pg_temp.lx() and feature = 'reminders';
set local session_replication_role = origin;
select pg_temp.as_user(pg_temp.u(1));
select is((select count(*) from servicing.my_reminders()), 0::bigint, 'with the lender''s reminders switch off the borrower is shown none of its messages');
select pg_temp.as_owner();
set local session_replication_role = replica;
update servicing.lender_features set enabled = true where lender_org_id = pg_temp.lx() and feature = 'reminders';
set local session_replication_role = origin;

-- ============================================================================================================================
-- 6. Releasing a hold resumes the messages it stopped that are still to come (A57)
-- ============================================================================================================================
select pg_temp.as_owner();
select pg_temp.clear_planned();
select pg_temp.mk_loan(11, pg_temp.lx(), pg_temp.got('b1')::uuid, 1, 31, 1, 475000, 0, 0);
select pg_temp.mk_rem(11, 1, 1, -1, 'in_app', interval '-1 day');
select pg_temp.mk_rem(11, 1, 1, 0, 'in_app', interval '2 hours');
select pg_temp.as_user(pg_temp.u(3));
select pg_temp.keep('pol_ret', servicing.draft_reminder_policy(pg_temp.lx(), array[0], true, array['in_app'], time '09:00', time '18:00', 2)::text);
select servicing.retire_reminder_policy(pg_temp.got('pol_ret')::uuid);
select pg_temp.keep('hold11', servicing.place_communication_hold(pg_temp.lid(11), 'complaint', 'Borrower raised a complaint with the lender')::text);
select pg_temp.as_owner();
insert into servicing.reminders (lender_org_id, loan_account_id, borrower_id, policy_id, installment_seq, due_date, offset_days, channel, scheduled_for, status, suppress_reason)
values (pg_temp.lx(), pg_temp.lid(11), pg_temp.got('b1')::uuid, pg_temp.got('pol_ret')::uuid, 2, pg_temp.d() + 31, -3, 'in_app', now() + interval '2 days', 'suppressed', 'hold');
select is(pg_temp.st(11, 1, -1) || ',' || pg_temp.st(11, 1, 0) || ',' || pg_temp.st(11, 2, -3), 'suppressed:hold,suppressed:hold,suppressed:hold', 'loan 11: the hold stopped both planned messages (and a third one under a retired policy exists)');
select pg_temp.as_user(pg_temp.u(3));
select is(servicing.release_communication_hold(pg_temp.got('hold11')::uuid, 'Complaint closed by the lender'), 'released', 'the hold is released');
select pg_temp.as_owner();
select is(pg_temp.st(11, 1, -1), 'planned', 'the message scheduled for after the release resumes (planned again)');
select is(pg_temp.st(11, 1, 0), 'suppressed:hold', 'a message whose time passed during the hold stays stopped: nothing is sent late because a hold ended');
select is(pg_temp.st(11, 2, -3), 'suppressed:hold', 'and a message of a policy that is no longer approved does not resume');
select is((select (metadata ->> 'resumed')::integer from audit.events where action = 'reminder.hold.released' and metadata ->> 'hold_id' = pg_temp.got('hold11')), 1, 'the audit event counts how many messages resumed (a number, no text)');
update servicing.reminders set scheduled_for = now() - interval '1 hour' where id = pg_temp.rid(11, 1, -1);
select pg_temp.as_system();
select pg_temp.claim();
select is(pg_temp.st(11, 1, -1), 'claimed', 'the resumed message is claimed in its window like any other');

-- ============================================================================================================================
-- 7. A new approved policy retires the old one and stops what was planned under it (M38)
-- ============================================================================================================================
select pg_temp.as_owner();
select pg_temp.clear_planned();
select pg_temp.mk_rem(9, 2, 31, 0, 'in_app', interval '-1 day');
select pg_temp.as_user(pg_temp.u(3));
select pg_temp.keep('pol3', servicing.draft_reminder_policy(pg_temp.lx(), array[0], true, array['in_app'], time '09:00', time '18:00', 2)::text);
select pg_temp.as_user(pg_temp.u(9));
select servicing.approve_reminder_policy(pg_temp.got('pol3')::uuid);
select pg_temp.as_owner();
select is(pg_temp.st(9, 2, 0), 'suppressed:policy_retired', 'approving a new policy suppresses the messages still planned under the old one');
insert into servicing.reminders (lender_org_id, loan_account_id, borrower_id, policy_id, installment_seq, due_date, offset_days, channel, scheduled_for)
values (pg_temp.lx(), pg_temp.lid(9), pg_temp.got('b1')::uuid, pg_temp.got('pol1')::uuid, 1, pg_temp.d() + 1, -1, 'in_app', now() - interval '1 hour');
select pg_temp.as_system();
select pg_temp.claim();
select is(pg_temp.st(9, 1, -1), 'suppressed:policy_retired', 'a message that is still planned under a retired policy is stopped at the claim');

select * from finish();
rollback;
