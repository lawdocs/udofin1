-- Phase 08a review-fix wave, final pass across the six areas (key SX, migration 20261018000926).
--   M9      a receipt is reversed only when its reversals reach its amount: every consumer (section 1 and flow D).
--   SP      an amount above the table limit is an invalid receipt (section 2); a live mandate of a configuration that is not active is raised
--           to the platform by the sweep (section 3).
--   U46/A3  feature evidence uses the accounts area's personal-data screen (section 4).   U44  the reminder window rule's evidence position (section 5).
--   FLOWS   A activation, payment and suspension; B mandate; C reminders; D partial reversal: public functions only, as the API and the workers call them,
--           with the roles authenticated and the system login. Every flow asserts the borrower-visible words, the lender-visible rows and that
--           another lender sees nothing.
-- Synthetic data only (labelled SAMPLE). Error codes are reported as SQLSTATE|hint.
begin;
create extension if not exists pgtap with schema extensions;
select plan(159);

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
create function pg_temp.msg(q text) returns text language plpgsql as $fn$
begin
  execute q;
  return 'ok';
exception when others then
  return sqlerrm;
end
$fn$;
create function pg_temp.keep(k text, v text) returns text language sql as $fn$ select set_config('t.' || k, v, true) $fn$;
create function pg_temp.got(k text) returns text language sql as $fn$ select nullif(current_setting('t.' || k, true), '') $fn$;
-- Cast of people: pg_temp.u(n) is user n (see the fixture).
create function pg_temp.u(n integer) returns uuid language sql as $fn$ select ('fa000000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid $fn$;
create function pg_temp.pl() returns uuid language sql as $fn$ select 'fab00000-0000-4000-8000-000000000000'::uuid $fn$;
create function pg_temp.lx() returns uuid language sql as $fn$ select 'fab00000-0000-4000-8000-000000000001'::uuid $fn$;
create function pg_temp.ly() returns uuid language sql as $fn$ select 'fab00000-0000-4000-8000-000000000002'::uuid $fn$;
create function pg_temp.sha(k text) returns text language sql as $fn$ select encode(sha256(convert_to('SAMPLE-030-' || k, 'UTF8')), 'hex') $fn$;
create function pg_temp.bytes(p_n integer) returns bytea language sql as $fn$ select decode(repeat('ab', p_n), 'hex') $fn$;
-- A timestamp text n hours in the past (UTC, whole seconds).
create function pg_temp.ts(hours numeric) returns text language sql as $fn$
  select to_char((clock_timestamp() - make_interval(secs => (hours * 3600)::integer)) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') $fn$;
-- Today and a day offset in Indian calendar days, as text.
create function pg_temp.d(n integer default 0) returns date language sql as $fn$ select private.today_ist() + n $fn$;
create function pg_temp.dt(n integer) returns text language sql as $fn$ select to_char(private.today_ist() + n, 'YYYY-MM-DD') $fn$;
grant execute on all functions in schema pg_temp to public;

-- Fixture ------------------------------------------------------------------------------------------------------------------------
-- Users: 01 and 02 platform registry/provider managers, 03 and 04 platform account verifiers, 05 and 06 platform features admins.
-- Lender X (Alpha) is 10 to 19, lender Y (Beta) is 20 to 29: +0 servicing operator, +1 communications admin, +2 communications approver, +3 and +4
-- payments admins, +5 payments approver, +6 reconciler, +7 viewer, +8 lender admin (product maker), +9 product approver.
-- 40 and 41 are borrowers b1 and b2.
insert into auth.users (id, phone, raw_app_meta_data)
select pg_temp.u(n), case when n >= 40 then '9100000040' || lpad((n - 39)::text, 2, '0') end, case when n >= 40 then '{}'::jsonb else '{"actor_type":"staff"}'::jsonb end
from (select generate_series(1, 29) union all select 40 union all select 41) s (n);
select pg_temp.keep('b1', (select id::text from identity.borrowers where user_id = pg_temp.u(40)));
select pg_temp.keep('b2', (select id::text from identity.borrowers where user_id = pg_temp.u(41)));
select pg_temp.as_owner();
insert into tenancy.organizations (id, kind, legal_name, display_name, regulator_registration_no, status) values
  (pg_temp.pl(), 'platform', 'Udofin Platform (test)', 'Udofin', null, 'active'),
  (pg_temp.lx(), 'lender', 'Alpha Finance Ltd (test)', 'Alpha', 'TEST-FA-0001', 'active'),
  (pg_temp.ly(), 'lender', 'Beta Capital Ltd (test)', 'Beta', 'TEST-FA-0002', 'active');
insert into onboarding.lender_gates (lender_org_id, stage) values (pg_temp.lx(), 'activated'), (pg_temp.ly(), 'activated');
insert into tenancy.memberships (id, org_id, user_id, status)
select ('fac10000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
       case when n <= 9 then pg_temp.pl() when n < 20 then pg_temp.lx() else pg_temp.ly() end, pg_temp.u(n), 'active'
from generate_series(1, 29) n where n not in (7, 8, 9) and n not between 0 and 0;
insert into tenancy.membership_roles (membership_id, role_id)
select ('fac10000-0000-4000-8000-0000000000' || lpad(g.n::text, 2, '0'))::uuid, r.id
from (values
  (1, 'platform', 'platform_payments_admin'), (2, 'platform', 'platform_payments_admin'), (3, 'platform', 'platform_account_verifier'),
  (4, 'platform', 'platform_account_verifier'), (5, 'platform', 'platform_features_admin'), (6, 'platform', 'platform_features_admin')) as g (n, kind, rkey)
join tenancy.roles r on r.org_id is null and r.applies_to = g.kind::tenancy.organization_kind and r.key = g.rkey;
insert into tenancy.membership_roles (membership_id, role_id)
select ('fac10000-0000-4000-8000-0000000000' || lpad((b.base + g.off)::text, 2, '0'))::uuid, r.id
from (values (10), (20)) b (base)
cross join (values (0, 'servicing_operator'), (1, 'communications_admin'), (2, 'communications_approver'), (3, 'payments_admin'), (4, 'payments_admin'),
                   (5, 'payments_approver'), (6, 'reconciler'), (7, 'viewer'), (8, 'lender_admin'), (9, 'product_approver')) g (off, rkey)
join tenancy.roles r on r.org_id is null and r.applies_to = 'lender' and r.key = g.rkey;

-- Registry and configuration helpers (the platform-side setup of the accounts area, all through public functions) --------------------
-- A stand-in for the backend's keyed fingerprint: real account n under key version kv. The registry's own masked form for real account n.
create function pg_temp.fp(n integer, kv integer default 1) returns text language sql as $fn$
  select encode(sha256(convert_to('SAMPLE-030-ACCOUNT-' || n || '-KEY-' || kv, 'UTF8')), 'hex') $fn$;
create function pg_temp.mask(n integer) returns text language sql as $fn$ select 'XXXXXX' || lpad(n::text, 4, '0') $fn$;
create function pg_temp.token(k text) returns text language sql as $fn$ select encode(sha256(convert_to('SAMPLE-030-TOKEN-' || k, 'UTF8')), 'hex') $fn$;
create function pg_temp.register(n integer, k text, rule uuid, kind text default 'lender', org uuid default null, purposes text[] default array['repayment_settlement'],
  lname text default 'Alpha Finance Ltd (test)') returns uuid language sql as $fn$
  select payments.register_account(pg_temp.fp(n), 1, pg_temp.mask(n), 'IN', 'bank_account', rule, true, kind, org, lname, purposes, null, null, k, '{}'::jsonb, null)
$fn$;
-- A configuration draft with secret names in the lender's own namespace.
create function pg_temp.draft(lender uuid, k text, merchant uuid, settle uuid, limits jsonb default null, lsource text default null) returns uuid language plpgsql as $fn$
begin
  return payments.draft_payment_config(lender, 'sample_provider', 'production', merchant, settle, private.secret_ref_prefix(lender) || 'SAMPLE_SECRET',
    private.secret_ref_prefix(lender) || 'SAMPLE_WEBHOOK', pg_temp.token(k), limits, lsource, 'SAMPLE-EVIDENCE-CFG', 'SAMPLE-CONTRACT-CFG', k);
end
$fn$;
-- Submit as one configure holder and approve as one approver; returns the final status. Leaves the session as the approver.
create function pg_temp.live(p_cfg uuid, p_submitter integer, p_approver integer) returns text language plpgsql as $fn$
begin
  perform pg_temp.as_user(pg_temp.u(p_submitter));
  perform payments.submit_payment_config(p_cfg);
  perform pg_temp.as_user(pg_temp.u(p_approver));
  return payments.decide_payment_config(p_cfg, true, 'SAMPLE approval');
end
$fn$;
grant execute on all functions in schema pg_temp to public;

-- Platform setup: key version 1, one account format rule, the provider, the own-account list (Udofin and a group company) attested.
select pg_temp.as_user(pg_temp.u(1));
select payments.propose_fingerprint_key_version(1, 'SAMPLE first key');
select pg_temp.keep('rule', payments.draft_account_format_rule('IN', 'bank_account', 9, 18, true, 'likely', 'SAMPLE source note for the fixture rule', pg_temp.d(-1))::text);
select payments.set_payment_provider('sample_provider', 'SAMPLE Provider', 'payment_and_mandate', 'approved', 'SAMPLE-AUTH-EVIDENCE-030', 'likely');
select pg_temp.as_user(pg_temp.u(3));
select payments.approve_fingerprint_key_version(1, 'SAMPLE approval');
select payments.approve_account_format_rule(pg_temp.got('rule')::uuid);
select pg_temp.as_user(pg_temp.u(1));
select pg_temp.keep('regu', pg_temp.register(900, 'reg-key-030-0000900', pg_temp.got('rule')::uuid, kind => 'udofin', purposes => array['fee_collection'], lname => 'Udofin SAMPLE Ltd (fixture)')::text);
select pg_temp.keep('regg', pg_temp.register(901, 'reg-key-030-0000901', pg_temp.got('rule')::uuid, kind => 'group_company', purposes => array['operational'], lname => 'Udofin Group SAMPLE Ltd (fixture)')::text);
select pg_temp.as_user(pg_temp.u(3));
select payments.verify_account(pg_temp.got('regu')::uuid, 'SAMPLE-EVIDENCE-030-U');
select payments.verify_account(pg_temp.got('regg')::uuid, 'SAMPLE-EVIDENCE-030-G');
select pg_temp.as_user(pg_temp.u(4));
select payments.attest_own_account_list('SAMPLE-OWN-LIST-030');

-- ============================================================================================================================
-- FLOW A.1  The activation order for lender X, public functions and two platform people only (SA notes section 5):
--           connection -> servicing_sync -> statements_noc -> reminders -> own-account attestation (done above) -> payments -> mandates
-- ============================================================================================================================
select pg_temp.as_user(pg_temp.u(5));
select is(pg_temp.msg(format($$select servicing.request_feature_change(%L, 'servicing_sync', true, '{"contract_ref":"SAMPLE-MSA-X"}', 'feature-key-030-0000001')$$, pg_temp.lx())),
  'prerequisites not met: lms_connection_not_active', 'A: without an active connection servicing_sync is refused, and says why');
select pg_temp.as_user(pg_temp.u(10));
select is(pg_temp.err(format($$select servicing.set_lms_connection(%L, 'file_import', 'active', '{"receipts": true}'::jsonb)$$, pg_temp.lx())), 'ok',
  'A: lender X''s servicing operator records its file-import connection BEFORE the switch is on (receipts reported)');
select pg_temp.as_user(pg_temp.u(5));
select pg_temp.keep('rq_sync', servicing.request_feature_change(pg_temp.lx(), 'servicing_sync', true, '{"contract_ref":"SAMPLE-MSA-X"}', 'feature-key-030-0000001')::text);
select is(pg_temp.err(format($$select servicing.decide_feature_change(%L, true, 'the requester cannot decide his own request')$$, pg_temp.got('rq_sync'))), '42501|self_approval', 'A: the person who asked cannot decide');
select pg_temp.as_user(pg_temp.u(6));
select is(servicing.decide_feature_change(pg_temp.got('rq_sync')::uuid, true, 'connection recorded, evidence reviewed'), 'applied', 'A: a second platform person turns servicing_sync on');
select pg_temp.as_user(pg_temp.u(5));
select pg_temp.keep('rq_noc', servicing.request_feature_change(pg_temp.lx(), 'statements_noc', true, '{"contract_ref":"SAMPLE-MSA-X"}', 'feature-key-030-0000002')::text);
select pg_temp.as_user(pg_temp.u(6));
select is(servicing.decide_feature_change(pg_temp.got('rq_noc')::uuid, true, 'statements and no-dues letters reviewed'), 'applied', 'A: statements_noc is turned on');
-- reminders: a policy and the three English wordings, drafted by one communications person and approved by another.
select pg_temp.as_user(pg_temp.u(5));
select is(pg_temp.msg(format($$select servicing.request_feature_change(%L, 'reminders', true, '{"contract_ref":"SAMPLE-MSA-X"}', 'feature-key-030-0000003')$$, pg_temp.lx())),
  'prerequisites not met: reminder_policy_missing, reminder_templates_missing', 'A: reminders are refused until a policy and the wording are approved');
select pg_temp.as_user(pg_temp.u(11));
select pg_temp.keep('pol', servicing.draft_reminder_policy(pg_temp.lx(), array[-1, 0, 3], true, array['in_app', 'push'], time '09:00', time '18:00', 2)::text);
select pg_temp.keep('t_pre', servicing.draft_reminder_template(pg_temp.lx(), 'pre_due', 'en', 'Reminder from {{lender_name}}: your installment of {{amount}} is due on {{due_date}}.')::text);
select pg_temp.keep('t_due', servicing.draft_reminder_template(pg_temp.lx(), 'due_day', 'en', 'Reminder from {{lender_name}}: your installment of {{amount}} is due today, {{due_date}}.')::text);
select pg_temp.keep('t_over', servicing.draft_reminder_template(pg_temp.lx(), 'overdue', 'en', '{{lender_name}} reminder: {{amount}} is overdue since {{due_date}}. {{penal_text}}')::text);
select pg_temp.as_user(pg_temp.u(12));
select servicing.approve_reminder_policy(pg_temp.got('pol')::uuid);
select servicing.approve_reminder_template(pg_temp.got('t_pre')::uuid);
select servicing.approve_reminder_template(pg_temp.got('t_due')::uuid);
select servicing.approve_reminder_template(pg_temp.got('t_over')::uuid);
select pg_temp.as_user(pg_temp.u(5));
select pg_temp.keep('rq_rem', servicing.request_feature_change(pg_temp.lx(), 'reminders', true, '{"contract_ref":"SAMPLE-MSA-X"}', 'feature-key-030-0000004')::text);
select pg_temp.as_user(pg_temp.u(6));
select is(servicing.decide_feature_change(pg_temp.got('rq_rem')::uuid, true, 'wording and policy reviewed'), 'applied', 'A: reminders are turned on');
-- payments: the registry chain for lender X, a configuration with a mandate rail, two lender people and one approver.
select pg_temp.as_user(pg_temp.u(5));
select is(pg_temp.msg(format($$select servicing.request_feature_change(%L, 'payments', true, '{"contract_ref":"SAMPLE-MSA-X"}', 'feature-key-030-0000005')$$, pg_temp.lx())),
  'prerequisites not met: payment_config_missing', 'A: payments are refused until a configuration is active (the own-account list is attested)');
select pg_temp.as_user(pg_temp.u(1));
select pg_temp.keep('rx', pg_temp.register(40, 'reg-key-030-0000040', pg_temp.got('rule')::uuid, org => pg_temp.lx())::text);
select pg_temp.as_user(pg_temp.u(3));
select payments.verify_account(pg_temp.got('rx')::uuid, 'SAMPLE-EVIDENCE-030-X');
select pg_temp.as_user(pg_temp.u(13));
select pg_temp.keep('sax', payments.request_settlement_account(pg_temp.lx(), 'SAMPLE collections X', 'Sample Bank', pg_temp.mask(40))::text);
select pg_temp.keep('mx', payments.claim_merchant(pg_temp.lx(), 'sample_provider', 'SAMPLE-MERCH-X1')::text);
select pg_temp.as_user(pg_temp.u(2));
select payments.link_settlement_account(pg_temp.got('sax')::uuid, pg_temp.got('rx')::uuid);
select payments.verify_merchant(pg_temp.got('mx')::uuid, 'SAMPLE-MERCH-EVID-X');
select pg_temp.as_user(pg_temp.u(13));
select pg_temp.keep('cx', pg_temp.draft(pg_temp.lx(), 'cfg-key-030-000000001', pg_temp.got('mx')::uuid, pg_temp.got('sax')::uuid,
  '{"enach_api":{"max_mandate_amount_minor":5000000,"needs_afa_each_debit":false}}', 'SAMPLE provider documentation section 4')::text);
select is(pg_temp.live(pg_temp.got('cx')::uuid, 14, 15), 'active', 'A: the lender''s pair activates a production configuration (mandate rail included)');
select pg_temp.as_user(pg_temp.u(5));
select pg_temp.keep('rq_pay', servicing.request_feature_change(pg_temp.lx(), 'payments', true, '{"contract_ref":"SAMPLE-MSA-X"}', 'feature-key-030-0000006')::text);
select pg_temp.as_user(pg_temp.u(6));
select is(servicing.decide_feature_change(pg_temp.got('rq_pay')::uuid, true, 'configuration and registry reviewed'), 'applied', 'A: payments are turned on');
-- mandates.
select pg_temp.as_user(pg_temp.u(5));
select is(pg_temp.msg(format($$select servicing.request_feature_change(%L, 'mandates', true, '{"contract_ref":"SAMPLE-MSA-X"}', 'feature-key-030-0000007')$$, pg_temp.lx())),
  'prerequisites not met: mandate_policy_missing', 'A: mandates are refused until the lender sets its mandate settings');
select pg_temp.as_user(pg_temp.u(13));
select is(payments.set_mandate_policy(pg_temp.lx(), 'before_first_due', 4000000, 48), 'set', 'A: the lender sets its mandate settings (ceiling 40,000.00, 48 hours notice)');
select pg_temp.as_user(pg_temp.u(5));
select pg_temp.keep('rq_man', servicing.request_feature_change(pg_temp.lx(), 'mandates', true, '{"contract_ref":"SAMPLE-MSA-X"}', 'feature-key-030-0000008')::text);
select pg_temp.as_user(pg_temp.u(6));
select is(servicing.decide_feature_change(pg_temp.got('rq_man')::uuid, true, 'mandate settings and rails reviewed'), 'applied', 'A: mandates are turned on');
select pg_temp.as_owner();
select is((select array_agg(feature order by feature) from servicing.lender_features where lender_org_id = pg_temp.lx() and enabled),
  array['mandates', 'payments', 'reminders', 'servicing_sync', 'statements_noc'], 'A: all five Phase 08a features are on for lender X, reached with public functions and two platform people only');
select is((select count(*) from servicing.feature_change_requests where lender_org_id = pg_temp.lx() and status = 'applied' and decided_by = requested_by), 0::bigint,
  'A: and never decided by the person who asked');

-- ============================================================================================================================
-- Lender Y is activated with the same order (a helper without assertions), so that the negative checks compare real data of two lenders.
-- ============================================================================================================================
create function pg_temp.switch_on(p_lender uuid, p_feature text, p_tag text) returns text language plpgsql as $fn$
declare v_rq uuid;
begin
  perform pg_temp.as_user(pg_temp.u(5));
  v_rq := servicing.request_feature_change(p_lender, p_feature, true, jsonb_build_object('contract_ref', 'SAMPLE-MSA-' || p_tag), 'feature-key-030-' || p_tag || '-' || p_feature);
  perform pg_temp.as_user(pg_temp.u(6));
  return servicing.decide_feature_change(v_rq, true, 'reviewed in the fixture');
end
$fn$;
create function pg_temp.activate(p_lender uuid, p_base integer, p_tag text, p_n integer) returns uuid language plpgsql as $fn$
declare
  v_pol uuid; v_t1 uuid; v_t2 uuid; v_t3 uuid; v_reg uuid; v_sa uuid; v_mer uuid; v_cfg uuid;
begin
  perform pg_temp.as_user(pg_temp.u(p_base));
  perform servicing.set_lms_connection(p_lender, 'file_import', 'active', '{"receipts": true}'::jsonb);
  perform pg_temp.switch_on(p_lender, 'servicing_sync', p_tag);
  perform pg_temp.switch_on(p_lender, 'statements_noc', p_tag);
  perform pg_temp.as_user(pg_temp.u(p_base + 1));
  v_pol := servicing.draft_reminder_policy(p_lender, array[-1, 0, 3], true, array['in_app', 'push'], time '09:00', time '18:00', 2);
  v_t1 := servicing.draft_reminder_template(p_lender, 'pre_due', 'en', 'Reminder from {{lender_name}}: your installment of {{amount}} is due on {{due_date}}.');
  v_t2 := servicing.draft_reminder_template(p_lender, 'due_day', 'en', 'Reminder from {{lender_name}}: your installment of {{amount}} is due today, {{due_date}}.');
  v_t3 := servicing.draft_reminder_template(p_lender, 'overdue', 'en', '{{lender_name}} reminder: {{amount}} is overdue since {{due_date}}. {{penal_text}}');
  perform pg_temp.as_user(pg_temp.u(p_base + 2));
  perform servicing.approve_reminder_policy(v_pol);
  perform servicing.approve_reminder_template(v_t1);
  perform servicing.approve_reminder_template(v_t2);
  perform servicing.approve_reminder_template(v_t3);
  perform pg_temp.switch_on(p_lender, 'reminders', p_tag);
  perform pg_temp.as_user(pg_temp.u(1));
  v_reg := pg_temp.register(p_n, 'reg-key-030-' || lpad(p_n::text, 7, '0'), pg_temp.got('rule')::uuid, org => p_lender);
  perform pg_temp.as_user(pg_temp.u(3));
  perform payments.verify_account(v_reg, 'SAMPLE-EVIDENCE-030-' || p_tag);
  perform pg_temp.as_user(pg_temp.u(p_base + 3));
  v_sa := payments.request_settlement_account(p_lender, 'SAMPLE collections ' || p_tag, 'Sample Bank', pg_temp.mask(p_n));
  v_mer := payments.claim_merchant(p_lender, 'sample_provider', 'SAMPLE-MERCH-' || p_tag || '1');
  perform pg_temp.as_user(pg_temp.u(2));
  perform payments.link_settlement_account(v_sa, v_reg);
  perform payments.verify_merchant(v_mer, 'SAMPLE-MERCH-EVID-' || p_tag);
  perform pg_temp.as_user(pg_temp.u(p_base + 3));
  v_cfg := pg_temp.draft(p_lender, 'cfg-key-030-' || p_tag || '00001', v_mer, v_sa, '{"enach_api":{"max_mandate_amount_minor":5000000,"needs_afa_each_debit":false}}', 'SAMPLE provider documentation section 4');
  perform pg_temp.live(v_cfg, p_base + 4, p_base + 5);
  perform pg_temp.switch_on(p_lender, 'payments', p_tag);
  perform pg_temp.as_user(pg_temp.u(p_base + 3));
  perform payments.set_mandate_policy(p_lender, 'before_first_due', 4000000, 48);
  perform pg_temp.switch_on(p_lender, 'mandates', p_tag);
  return v_cfg;
end
$fn$;
grant execute on all functions in schema pg_temp to public;
select pg_temp.keep('cy', pg_temp.activate(pg_temp.ly(), 20, 'Y', 41)::text);
select pg_temp.as_owner();
select is((select array_agg(feature order by feature) from servicing.lender_features where lender_org_id = pg_temp.ly() and enabled),
  array['mandates', 'payments', 'reminders', 'servicing_sync', 'statements_noc'], 'A: lender Y went through the same order: five features on');

-- ============================================================================================================================
-- Loans (applications are an earlier phase's rows: fixtures), then the lenders' files through stage_import and commit_import.
-- Applications 1 to 9, 13 and 14 are borrower b1 at lender X, 10 is b2 at X, 11 is b2 at Y, 12 is b1 at Y.
-- ============================================================================================================================
select pg_temp.as_owner();
insert into lending.loan_products (id, lender_org_id, category_key, code, name, status) values
  ('fa900000-0000-4000-8000-000000000001', pg_temp.lx(), 'personal', 'PL-FA', 'X Personal Loan', 'active'),
  ('fa900000-0000-4000-8000-000000000002', pg_temp.ly(), 'personal', 'PL-FA', 'Y Personal Loan', 'active');
insert into lending.loan_product_versions (id, product_id, lender_org_id, version, status, min_amount_minor, max_amount_minor, min_tenure_days, max_tenure_days,
  rate_type, min_annual_rate_bps, max_annual_rate_bps, drafted_by, approved_by, approved_at, effective_from)
values ('fa910000-0000-4000-8000-000000000001', 'fa900000-0000-4000-8000-000000000001', pg_temp.lx(), 1, 'approved', 1000000, 50000000, 180, 1825, 'fixed', 1400, 2400, pg_temp.u(18), pg_temp.u(19), now(), now()),
       ('fa910000-0000-4000-8000-000000000002', 'fa900000-0000-4000-8000-000000000002', pg_temp.ly(), 1, 'approved', 1000000, 50000000, 180, 1825, 'fixed', 1400, 2400, pg_temp.u(28), pg_temp.u(29), now(), now());
insert into lending.loan_requests (id, borrower_id, category_key, requested_amount_minor, requested_tenure_days, purpose_code, status)
select ('fa700000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, case when n in (10, 11) then pg_temp.got('b2')::uuid else pg_temp.got('b1')::uuid end, 'personal', 5000000, 365, 'education', 'submitted'
from generate_series(1, 14) n;
insert into lending.applications (id, lender_org_id, loan_request_id, borrower_id, product_version_id, status, requested_amount_minor, requested_tenure_days, lender_reference)
select ('fa200000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, case when n in (11, 12) then pg_temp.ly() else pg_temp.lx() end,
       ('fa700000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, case when n in (10, 11) then pg_temp.got('b2')::uuid else pg_temp.got('b1')::uuid end,
       case when n in (11, 12) then 'fa910000-0000-4000-8000-000000000002' else 'fa910000-0000-4000-8000-000000000001' end::uuid, 'disbursement_pending', 5000000, 365, 'SAMPLE-APP-' || n
from generate_series(1, 14) n;

-- Row builders for the lenders' files (labelled SAMPLE figures; 4,750.00 due is 4,000.00 principal and 750.00 interest).
create function pg_temp.lrow(p_ref text, p_app text, p_due_days integer, p_srid text, p_hours numeric default 1, p_extra jsonb default '{}'::jsonb) returns jsonb language sql as $fn$
  select jsonb_strip_nulls(jsonb_build_object(
    'lms_loan_ref', p_ref, 'borrower_ref', p_app, 'status', 'active', 'sanctioned_amount', '50000.00',
    'disbursed_amount', '50000.00', 'disbursement_ref', 'SAMPLE-DISB-' || p_ref, 'disbursement_date', pg_temp.dt(-30),
    'outstanding_principal', '40000.00', 'next_due_date', pg_temp.dt(p_due_days), 'next_due_amount', '4750.00',
    'overdue_principal', '0.00', 'overdue_interest', '0.00', 'penal_charges', '0.00', 'other_charges', '0.00', 'total_overdue', '0.00',
    'days_past_due', '0', 'source_record_id', p_srid, 'reported_as_of', pg_temp.ts(p_hours)) || p_extra)
$fn$;
create function pg_temp.srow(p_ref text, p_due_days integer, p_srid text, p_hours numeric default 1) returns jsonb language sql as $fn$
  select jsonb_build_object('lms_loan_ref', p_ref, 'source_record_id', p_srid, 'reported_as_of', pg_temp.ts(p_hours),
    'installments', jsonb_build_array(
      jsonb_build_object('installment_seq', '1', 'due_date', pg_temp.dt(p_due_days), 'principal', '4000.00', 'interest', '750.00', 'fees', '0.00'),
      jsonb_build_object('installment_seq', '2', 'due_date', pg_temp.dt(p_due_days + 30), 'principal', '4000.00', 'interest', '750.00', 'fees', '0.00')))
$fn$;
create function pg_temp.rrow(p_ref text, p_receipt text, p_amount text, p_bank text, p_hours numeric default 1, p_extra jsonb default '{}'::jsonb) returns jsonb language sql as $fn$
  select jsonb_strip_nulls(jsonb_build_object(
    'lms_loan_ref', p_ref, 'lms_receipt_ref', p_receipt, 'receipt_kind', 'receipt', 'amount', p_amount, 'value_date', pg_temp.dt(0), 'payment_mode', 'upi',
    'bank_reference', p_bank, 'source_record_id', 'SRC-' || p_receipt, 'reported_as_of', pg_temp.ts(p_hours)) || p_extra)
$fn$;
-- A lender's file: stage it and commit it as the lender's servicing operator; returns the committed status and counts, or the row errors.
create function pg_temp.imp(p_lender uuid, p_op integer, p_kind text, p_label text, p_rows jsonb) returns text language plpgsql as $fn$
declare v jsonb; v_done jsonb;
begin
  perform pg_temp.as_user(pg_temp.u(p_op));
  v := servicing.stage_import(p_lender, p_kind, 'file', pg_temp.sha(p_label), 1000, 'udofin-lms-import-v1', p_rows, 'idem-030-' || rpad(p_label, 20, '0'), null);
  if coalesce((v -> 'counts' ->> 'error')::int, 0) > 0 then
    return 'refused:' || (v -> 'errors')::text;
  end if;
  v_done := servicing.commit_import((v ->> 'batch_id')::uuid);
  return (v_done ->> 'status') || ':' || (v_done -> 'applied_counts')::text;
end
$fn$;
grant execute on all functions in schema pg_temp to public;
select is(pg_temp.imp(pg_temp.lx(), 10, 'loan', 'x-loans', jsonb_build_array(
  pg_temp.lrow('SAMPLE-LN-1', 'SAMPLE-APP-1', 3, 'SRC-L1'), pg_temp.lrow('SAMPLE-LN-2', 'SAMPLE-APP-2', 3, 'SRC-L2'), pg_temp.lrow('SAMPLE-LN-3', 'SAMPLE-APP-3', 3, 'SRC-L3'),
  pg_temp.lrow('SAMPLE-LN-4', 'SAMPLE-APP-4', 3, 'SRC-L4'), pg_temp.lrow('SAMPLE-LN-5', 'SAMPLE-APP-5', 3, 'SRC-L5'), pg_temp.lrow('SAMPLE-LN-6', 'SAMPLE-APP-6', 3, 'SRC-L6'),
  pg_temp.lrow('SAMPLE-LN-7', 'SAMPLE-APP-7', 3, 'SRC-L7'), pg_temp.lrow('SAMPLE-LN-8', 'SAMPLE-APP-8', 2, 'SRC-L8'), pg_temp.lrow('SAMPLE-LN-9', 'SAMPLE-APP-9', 0, 'SRC-L9'),
  pg_temp.lrow('SAMPLE-LN-10', 'SAMPLE-APP-10', 3, 'SRC-L10'),
  pg_temp.lrow('SAMPLE-LN-11', 'SAMPLE-APP-13', 26, 'SRC-L11', 0, '{"overdue_principal":"4000.00","overdue_interest":"750.00","total_overdue":"4750.00","days_past_due":"4"}'),
  pg_temp.lrow('SAMPLE-LN-12', 'SAMPLE-APP-14', 26, 'SRC-L12', 0, '{"overdue_principal":"4000.00","overdue_interest":"750.00","total_overdue":"4750.00","days_past_due":"4"}'))), 'committed:{"new": 12}', 'A: lender X''s servicing operator imports twelve loans (stage, then commit)');
select is(pg_temp.imp(pg_temp.lx(), 10, 'schedule', 'x-sched', jsonb_build_array(
  pg_temp.srow('SAMPLE-LN-1', 3, 'SRC-S1'), pg_temp.srow('SAMPLE-LN-2', 3, 'SRC-S2'), pg_temp.srow('SAMPLE-LN-3', 3, 'SRC-S3'), pg_temp.srow('SAMPLE-LN-4', 3, 'SRC-S4'),
  pg_temp.srow('SAMPLE-LN-5', 3, 'SRC-S5'), pg_temp.srow('SAMPLE-LN-6', 3, 'SRC-S6'), pg_temp.srow('SAMPLE-LN-7', 3, 'SRC-S7'), pg_temp.srow('SAMPLE-LN-8', 2, 'SRC-S8'),
  pg_temp.srow('SAMPLE-LN-9', 0, 'SRC-S9'), pg_temp.srow('SAMPLE-LN-10', 3, 'SRC-S10'),
  pg_temp.srow('SAMPLE-LN-11', -4, 'SRC-S11', 0), pg_temp.srow('SAMPLE-LN-12', -4, 'SRC-S12', 0))), 'committed:{"new": 12}', 'A: and their repayment schedules (loans 11 and 12 are four days overdue)');
select is(pg_temp.imp(pg_temp.ly(), 20, 'loan', 'y-loans', jsonb_build_array(
  pg_temp.lrow('SAMPLE-LN-Y1', 'SAMPLE-APP-11', 3, 'SRC-LY1'), pg_temp.lrow('SAMPLE-LN-Y2', 'SAMPLE-APP-12', 3, 'SRC-LY2'))), 'committed:{"new": 2}', 'A: lender Y imports its two loans');
select is(pg_temp.imp(pg_temp.ly(), 20, 'schedule', 'y-sched', jsonb_build_array(
  pg_temp.srow('SAMPLE-LN-Y1', 3, 'SRC-SY1'), pg_temp.srow('SAMPLE-LN-Y2', 3, 'SRC-SY2'))), 'committed:{"new": 2}', 'A: and their schedules');
select pg_temp.as_system();
select servicing.complete_disbursements(pg_temp.lx());
select servicing.complete_disbursements(pg_temp.ly());
select pg_temp.as_owner();
create function pg_temp.lid(p_ref text) returns uuid language sql as $fn$ select id from servicing.loan_accounts where lms_loan_ref = p_ref $fn$;
grant execute on all functions in schema pg_temp to public;
select is((select count(*) from servicing.loan_accounts where status = 'active' and last_synced_at is not null), 14::bigint, 'A: fourteen loan accounts exist, lender-reported and active');

-- ============================================================================================================================
-- FLOW A.2  A payment from the borrower's request to a bank-confirmed, lender-posted payment, and what each side and every other party sees.
--           request -> order -> hand-off link -> captured event -> applied -> settlement report -> bank credit -> run -> lender receipt -> run
-- ============================================================================================================================
-- A verified delivery as the callback receiver hands it over (the verifier outcome is 'verified').
create function pg_temp.dlv(p_delivery text, p_event text, p_kind text, p_status text, p_obj text, p_order text, p_amount bigint, p_parent text default null,
  p_occurred text default null) returns jsonb language sql as $fn$
  select jsonb_strip_nulls(jsonb_build_object(
    'provider', 'sample_provider', 'outcome', 'verified', 'reason_class', 'none', 'delivery_id', p_delivery, 'payload_sha256', pg_temp.sha('body-' || p_delivery),
    'scheme', 'mock-standard-webhooks-v1', 'signature_present', true, 'timestamp_skew_seconds', 3, 'body_bytes', 420, 'ip_hmac', repeat('a', 64),
    'event', jsonb_build_object('provider', 'sample_provider', 'deliveryId', p_delivery, 'eventId', p_event, 'objectKind', p_kind, 'objectRef', p_obj, 'orderRef', p_order, 'status', p_status,
      'rank', case p_status when 'created' then 10 when 'pending' then 15 when 'authorized' then 20 when 'failed' then 25 when 'rejected' then 25 when 'captured' then 30
                            when 'paid' then 30 when 'succeeded' then 30 when 'active' then 30 when 'paused' then 35 when 'refunded' then 40 when 'returned' then 40
                            when 'cancelled' then 45 when 'revoked' then 45 when 'disputed' then 50 else 0 end,
      'amountMinor', p_amount::text, 'currency', case when p_amount is null then null else 'INR' end,
      'occurredAt', coalesce(p_occurred, to_char((clock_timestamp() + interval '2 seconds') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')), 'parentPaymentRef', p_parent)));
$fn$;
create function pg_temp.ev(p_event text) returns uuid language sql as $fn$ select id from payments.provider_events where provider_event_id = p_event $fn$;
create function pg_temp.cfgx() returns uuid language sql as $fn$ select id from payments.lender_payment_configs where lender_org_id = 'fab00000-0000-4000-8000-000000000001' and status = 'active' $fn$;
create function pg_temp.cfgy() returns uuid language sql as $fn$ select id from payments.lender_payment_configs where lender_org_id = 'fab00000-0000-4000-8000-000000000002' and status = 'active' $fn$;
-- The borrower asks to pay the installment of loan p_ref (as borrower p_borrower): returns the intent id.
create function pg_temp.ask(p_borrower integer, p_ref text, p_key text, p_amount bigint default 475000) returns uuid language plpgsql as $fn$
begin
  perform pg_temp.as_user(pg_temp.u(p_borrower));
  return payments.request_payment(pg_temp.lid(p_ref), 'installment', p_amount, p_key);
end
$fn$;
-- The worker records the order and the provider's verified event captures it; the worker applies it. Returns the provider payment id.
create function pg_temp.capture(p_token text, p_intent uuid, p_tag text, p_amount bigint default 475000) returns uuid language plpgsql as $fn$
begin
  perform pg_temp.as_system();
  perform payments.record_order_created(p_intent, 'ORD-' || p_tag);
  perform payments.ingest_provider_delivery(p_token, pg_temp.dlv('DLV-' || p_tag, 'EVT-' || p_tag, 'payment', 'captured', 'PAY-' || p_tag, 'ORD-' || p_tag, p_amount));
  perform payments.apply_provider_event(pg_temp.ev('EVT-' || p_tag));
  return (select id from payments.provider_payments where provider_payment_ref = 'PAY-' || p_tag);
end
$fn$;
grant execute on all functions in schema pg_temp to public;

select pg_temp.keep('tokx', pg_temp.token('cfg-key-030-000000001'));
select pg_temp.keep('toky', pg_temp.token('cfg-key-030-Y00001'));
-- 1. The borrower asks.
select pg_temp.as_user(pg_temp.u(40));
select is((select options -> 'purposes' -> 0 ->> 'amount_minor' from (select payments.my_payment_options(pg_temp.lid('SAMPLE-LN-1')) as options) o), '475000', 'A: the borrower is offered the installment the lender reported (4,750.00)');
select pg_temp.keep('i1', pg_temp.ask(40, 'SAMPLE-LN-1', 'pay-key-030-A1-0000001')::text);
select is((select (intent_status, stage, provider_received_at is null, lender_posted_on is null)::text from payments.my_payment(pg_temp.got('i1')::uuid)), '(created,started,t,t)', 'A: stage words: started (nothing has been paid)');
select is((select (lender_display_name, purpose, amount_minor, link_available, destination_masked_ref)::text from payments.my_payment_detail(pg_temp.got('i1')::uuid)), '(Alpha,installment,475000,f,XXXXXX0040)',
  'A: the borrower sees the lender, the purpose, the amount and the lender''s masked destination account; no link yet');
-- 2. The worker records the order and stores the sealed hand-off link; the borrower fetches it.
select pg_temp.as_system();
select is(payments.record_order_created(pg_temp.got('i1')::uuid, 'ORD-A1'), 'pending', 'A: the worker records the order created at the provider');
select is(payments.store_handoff_link('payment_intent', pg_temp.got('i1')::uuid, 'v1', pg_temp.bytes(40), now() + interval '1 hour'), 'stored', 'A: and keeps the sealed hand-off link');
select pg_temp.as_user(pg_temp.u(40));
select is((select link_available from payments.my_payment_detail(pg_temp.got('i1')::uuid)), true, 'A: the borrower''s detail now says a link is available');
select is((select count(*) from payments.take_handoff_link('payment_intent', pg_temp.got('i1')::uuid)), 1::bigint, 'A: and the borrower fetches it');
select pg_temp.as_user(pg_temp.u(41));
select is(pg_temp.err(format($$select * from payments.take_handoff_link('payment_intent', %L)$$, pg_temp.got('i1'))), 'P0002|link_unavailable', 'A: another borrower cannot');
-- 3. The provider's verified event captures the payment; the worker applies it.
select pg_temp.as_system();
select is(payments.ingest_provider_delivery(pg_temp.got('tokx'), pg_temp.dlv('DLV-A1', 'EVT-A1', 'payment', 'captured', 'PAY-A1', 'ORD-A1', 475000)) ->> 'outcome', 'ok', 'A: the receiver hands over the verified captured event');
select is(payments.apply_provider_event(pg_temp.ev('EVT-A1')) ->> 'outcome', 'applied', 'A: the worker applies it');
select pg_temp.as_user(pg_temp.u(40));
select is((select (intent_status, stage, provider_received_at is not null, lender_posted_on is null)::text from payments.my_payment(pg_temp.got('i1')::uuid)), '(succeeded,provider_received,t,t)',
  'A: stage words: provider_received (a verified provider event reports the payment; the lender has not posted it)');
select is((select state from servicing.my_loan_activity(pg_temp.lid('SAMPLE-LN-1')) where entry_kind = 'payment_attempt'), 'provider_received', 'A: the loan activity says the same');
select is((select link_available from payments.my_payment_detail(pg_temp.got('i1')::uuid)), false, 'A: money has been reported, so the link is withdrawn');
-- 4. What the lender sees, and what nobody else sees.
select pg_temp.as_user(pg_temp.u(17));
select is((select (stage, provider_captured, provider_settled, bank_confirmed, lender_posted)::text from payments.payment_stages where intent_id = pg_temp.got('i1')::uuid), '(provider_captured,t,f,f,f)',
  'A: lender X''s viewer sees the stage: provider_captured only');
select is((select count(*) from payments.provider_payments), 1::bigint, 'A: and its provider payment');
select pg_temp.as_user(pg_temp.u(27));
select is((select count(*) from payments.payment_stages) + (select count(*) from payments.provider_payments) + (select count(*) from payments.payment_intents) + (select count(*) from payments.provider_events), 0::bigint,
  'A: lender Y''s viewer sees none of lender X''s payment, stage, intent or provider event');
select pg_temp.as_user(pg_temp.u(41));
select is(pg_temp.err(format($$select * from payments.my_payment(%L)$$, pg_temp.got('i1'))), 'P0002|', 'A: another borrower cannot read the payment');
select is(pg_temp.err(format($$select * from servicing.my_loan_activity(%L)$$, pg_temp.lid('SAMPLE-LN-1'))), 'P0002|', 'A: nor the loan''s activity');
-- 5. What the provider settled, what the bank credited, the reconciliation run.
select pg_temp.as_system();
select is(payments.record_settlement_report(pg_temp.cfgx(), pg_temp.d(), jsonb_build_array(jsonb_build_object('batchRef', 'B-A1', 'settlementRef', 'SAMP000000000101',
    'periodFrom', pg_temp.dt(0), 'periodTo', pg_temp.dt(0), 'destinationMaskedRef', 'XXXXXX0040', 'grossMinor', '475000', 'feeMinor', '0', 'taxMinor', '0', 'netMinor', '475000',
    'items', jsonb_build_array(jsonb_build_object('providerPaymentRef', 'PAY-A1', 'grossMinor', '475000', 'feeMinor', '0', 'taxMinor', '0', 'netMinor', '475000'))))),
  jsonb_build_object('recorded', 1, 'duplicates', 0, 'conflicts', 0), 'A: the worker records the provider''s settlement report (to the lender''s own account)');
select pg_temp.as_user(pg_temp.u(17));
select is((select (stage, provider_settled, bank_confirmed)::text from payments.payment_stages where intent_id = pg_temp.got('i1')::uuid), '(provider_settled,t,f)', 'A: the stage moves to provider_settled');
select pg_temp.as_user(pg_temp.u(16));
select is(payments.import_bank_credits(pg_temp.lx(), pg_temp.got('sax')::uuid, jsonb_build_array(jsonb_build_object('valueDate', pg_temp.dt(0), 'amountMinor', '475000', 'utr', 'SAMP000000000101'))),
  jsonb_build_object('inserted', 1, 'duplicates', 0), 'A: the lender''s reconciler uploads the bank credit (its own statement)');
select pg_temp.as_system();
select is(payments.run_reconciliation(pg_temp.lx(), pg_temp.d()) ->> 'unchanged', 'false', 'A: the nightly run reconciles');
select pg_temp.as_user(pg_temp.u(16));
select is((select (counts ->> 'matched_to_settlement', counts ->> 'matched_to_bank', counts ->> 'matched_to_receipt')::text from payments.reconciliation_summary(pg_temp.lx(), pg_temp.d())), '(1,1,0)',
  'A: one payment matched to its settlement item and one batch to its bank credit; no receipt yet');
select is((select (stage, bank_confirmed, bank_confirmation_basis, settlement_destination_ok)::text from payments.payment_stages where intent_id = pg_temp.got('i1')::uuid), '(bank_confirmed,t,lender_reported_credit,t)',
  'A: stage: bank_confirmed, resting on the lender''s own statement of the credit');
-- 6. The lender posts the receipt.
select is(pg_temp.imp(pg_temp.lx(), 10, 'receipt', 'x-receipts-a1', jsonb_build_array(pg_temp.rrow('SAMPLE-LN-1', 'RC-A1', '4750.00', 'PAY-A1'))), 'committed:{"new": 1}',
  'A: the lender''s servicing operator imports the receipt that carries the provider''s payment reference');
select pg_temp.as_user(pg_temp.u(17));
select is((select (stage, lender_posted)::text from payments.payment_stages where intent_id = pg_temp.got('i1')::uuid), '(lender_posted,t)', 'A: stage: lender_posted');
select pg_temp.as_user(pg_temp.u(40));
select is((select (stage, lender_posted_on = pg_temp.d())::text from payments.my_payment(pg_temp.got('i1')::uuid)), '(lender_posted,t)', 'A: stage words for the borrower: lender_posted, with the date the lender posted it');
select is((select state from servicing.my_loan_activity(pg_temp.lid('SAMPLE-LN-1')) where entry_kind = 'lender_receipt'), 'posted', 'A: and the lender receipt is listed as posted');
select pg_temp.as_system();
select is(payments.run_reconciliation(pg_temp.lx(), pg_temp.d()) ->> 'unchanged', 'false', 'A: the next run sees the new receipt (changed inputs, a new run number)');
select pg_temp.as_user(pg_temp.u(16));
select is((select (run_no, counts ->> 'matched_to_receipt')::text from payments.reconciliation_summary(pg_temp.lx(), pg_temp.d()) order by run_no desc limit 1), '(2,1)', 'A: run 2 matched the payment to the lender''s receipt');
select is((select count(*) from payments.reconciliation_exceptions where status <> 'resolved'), 0::bigint, 'A: and nothing is open: a clean end-to-end payment raises no exception');
-- 7. Lender Y and the other borrower see none of it.
select pg_temp.as_user(pg_temp.u(27));
select is((select count(*) from servicing.lms_receipts) + (select count(*) from payments.settlement_batches) + (select count(*) from payments.bank_credits) + (select count(*) from payments.reconciliation_runs)
          + (select count(*) from payments.reconciliation_matches), 0::bigint, 'A: lender Y''s viewer sees none of lender X''s receipts, settlement batches, bank credits or reconciliation runs');
select pg_temp.as_user(pg_temp.u(26));
select is((select count(*) from payments.reconciliation_summary(pg_temp.lx(), pg_temp.d())), 0::bigint, 'A: lender Y''s reconciler reads no run summary of lender X (row level security)');
select is(pg_temp.err(format($$select payments.import_bank_credits(%L, %L, '[{"valueDate":"%s","amountMinor":"1","utr":"SAMP000000000199"}]'::jsonb)$$, pg_temp.lx(), pg_temp.got('sax'), pg_temp.dt(0))), '42501|', 'A: nor upload a bank credit for lender X');
select pg_temp.as_user(pg_temp.u(41));
select is((select count(*) from payments.provider_payments) + (select count(*) from servicing.lms_receipts), 0::bigint, 'A: another borrower reads no payment tables at all (the borrower reads through functions only)');

-- ============================================================================================================================
-- FLOW D  M9: a partial reversal of the lender's receipt flows through the stage view, the quiet period and the reconciliation run.
--         Four payments of lender X on loans 3 to 6 (captured five days ago), one of lender Y; each receipt of 4,750.00 is posted by the lender:
--           D3 no reversal | D4 a reversal of 0.01 | D5 one reversal of 4,750.00 | D6 two reversals (1,000.00 and 3,750.00) summing to the receipt
-- ============================================================================================================================
create function pg_temp.dpay(p_borrower integer, p_loan text, p_tag text, p_token text) returns uuid language plpgsql as $fn$
declare v_intent uuid;
begin
  v_intent := pg_temp.ask(p_borrower, p_loan, 'pay-key-030-' || p_tag || '-0000001');
  perform pg_temp.as_system();
  perform payments.record_order_created(v_intent, 'ORD-' || p_tag);
  perform payments.ingest_provider_delivery(p_token, pg_temp.dlv('DLV-' || p_tag, 'EVT-' || p_tag, 'payment', 'captured', 'PAY-' || p_tag, 'ORD-' || p_tag, 475000, null,
    to_char((clock_timestamp() - interval '5 days') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')));
  perform payments.apply_provider_event(pg_temp.ev('EVT-' || p_tag));
  return v_intent;
end
$fn$;
-- The borrower's stage word of an intent, and the lender viewer's stage flag of the same payment.
create function pg_temp.bst(p_borrower integer, p_intent text) returns text language plpgsql as $fn$
declare v text;
begin
  perform pg_temp.as_user(pg_temp.u(p_borrower));
  select stage into v from payments.my_payment(p_intent::uuid);
  return v;
end
$fn$;
create function pg_temp.lst(p_viewer integer, p_intent text) returns text language plpgsql as $fn$
declare v text;
begin
  perform pg_temp.as_user(pg_temp.u(p_viewer));
  select lender_posted::text into v from payments.payment_stages where intent_id = p_intent::uuid;
  return v;
end
$fn$;
-- The state of the receipt that carries p_receipt's reference, as the borrower's loan activity lists it.
create function pg_temp.act(p_borrower integer, p_loan text, p_receipt text) returns text language plpgsql as $fn$
declare v text; v_id uuid;
begin
  perform pg_temp.as_owner();
  select id into v_id from servicing.lms_receipts where lms_receipt_ref = p_receipt;
  perform pg_temp.as_user(pg_temp.u(p_borrower));
  select a.state into v from servicing.my_loan_activity(pg_temp.lid(p_loan)) a where a.entry_kind = 'lender_receipt' and a.entry_id = v_id;
  return v;
end
$fn$;
-- Is the quiet period after a payment in force for the loan (the reminders' view of "just paid")?
create function pg_temp.quiet(p_loan text) returns boolean language plpgsql as $fn$
declare v boolean;
begin
  perform pg_temp.as_owner();
  select private.reminder_recent_payment(pg_temp.lid(p_loan), 48) into v;
  return v;
end
$fn$;
grant execute on all functions in schema pg_temp to public;

select pg_temp.keep('i3', pg_temp.dpay(40, 'SAMPLE-LN-3', 'D3', pg_temp.got('tokx'))::text);
select pg_temp.keep('i4', pg_temp.dpay(40, 'SAMPLE-LN-4', 'D4', pg_temp.got('tokx'))::text);
select pg_temp.keep('i5', pg_temp.dpay(40, 'SAMPLE-LN-5', 'D5', pg_temp.got('tokx'))::text);
select pg_temp.keep('i6', pg_temp.dpay(40, 'SAMPLE-LN-6', 'D6', pg_temp.got('tokx'))::text);
select pg_temp.keep('iy', pg_temp.dpay(41, 'SAMPLE-LN-Y1', 'DY', pg_temp.got('toky'))::text);
select is(array[pg_temp.bst(40, pg_temp.got('i3')), pg_temp.bst(40, pg_temp.got('i4')), pg_temp.bst(40, pg_temp.got('i5')), pg_temp.bst(40, pg_temp.got('i6'))],
  array['provider_received', 'provider_received', 'provider_received', 'provider_received'], 'D: before the lender posts anything, the borrower''s four payments are provider_received');
select is(pg_temp.imp(pg_temp.lx(), 10, 'receipt', 'x-receipts-d', jsonb_build_array(pg_temp.rrow('SAMPLE-LN-3', 'RC-D3', '4750.00', 'PAY-D3', 3), pg_temp.rrow('SAMPLE-LN-4', 'RC-D4', '4750.00', 'PAY-D4', 3),
  pg_temp.rrow('SAMPLE-LN-5', 'RC-D5', '4750.00', 'PAY-D5', 3), pg_temp.rrow('SAMPLE-LN-6', 'RC-D6', '4750.00', 'PAY-D6', 3))), 'committed:{"new": 4}', 'D: lender X posts the four receipts (4,750.00 each, carrying the provider''s payment references)');
select is(pg_temp.imp(pg_temp.ly(), 20, 'receipt', 'y-receipts-d', jsonb_build_array(pg_temp.rrow('SAMPLE-LN-Y1', 'RC-DY', '4750.00', 'PAY-DY', 3))), 'committed:{"new": 1}', 'D: and lender Y posts its own');
select is(array[pg_temp.bst(40, pg_temp.got('i3')), pg_temp.bst(40, pg_temp.got('i4')), pg_temp.bst(40, pg_temp.got('i5')), pg_temp.bst(40, pg_temp.got('i6')), pg_temp.bst(41, pg_temp.got('iy'))],
  array['lender_posted', 'lender_posted', 'lender_posted', 'lender_posted', 'lender_posted'], 'D: the borrowers see lender_posted for all five');
-- The reversals, a later file each: 0.01 on D4, the whole receipt on D5, two parts adding up to the receipt on D6, 0.01 on lender Y's receipt.
select is(pg_temp.imp(pg_temp.lx(), 10, 'receipt', 'x-reversals-d', jsonb_build_array(
  pg_temp.rrow('SAMPLE-LN-4', 'RV-D4A', '0.01', 'REV-D4A', 2, '{"receipt_kind":"reversal","reverses_receipt_ref":"RC-D4"}'),
  pg_temp.rrow('SAMPLE-LN-5', 'RV-D5A', '4750.00', 'REV-D5A', 2, '{"receipt_kind":"reversal","reverses_receipt_ref":"RC-D5"}'),
  pg_temp.rrow('SAMPLE-LN-6', 'RV-D6A', '1000.00', 'REV-D6A', 2, '{"receipt_kind":"reversal","reverses_receipt_ref":"RC-D6"}'),
  pg_temp.rrow('SAMPLE-LN-6', 'RV-D6B', '3750.00', 'REV-D6B', 2, '{"receipt_kind":"reversal","reverses_receipt_ref":"RC-D6"}'))), 'committed:{"new": 4}', 'D: lender X reports the four reversals');
select is(pg_temp.imp(pg_temp.ly(), 20, 'receipt', 'y-reversal-d', jsonb_build_array(
  pg_temp.rrow('SAMPLE-LN-Y1', 'RV-DYA', '0.01', 'REV-DYA', 2, '{"receipt_kind":"reversal","reverses_receipt_ref":"RC-DY"}'))), 'committed:{"new": 1}', 'D: and lender Y one of 0.01');
select pg_temp.as_owner();
select is((select array_agg(reversed_minor order by lms_receipt_ref) from servicing.lms_receipts_net where lms_receipt_ref in ('RC-D3', 'RC-D4', 'RC-D5', 'RC-D6')), array[0::bigint, 1, 475000, 475000],
  'D: the lender''s own net view agrees: reversed 0, 1, 475000 and 475000 paise');

-- 1. The borrower's words.
select is(array[pg_temp.bst(40, pg_temp.got('i3')), pg_temp.bst(40, pg_temp.got('i4')), pg_temp.bst(40, pg_temp.got('i5')), pg_temp.bst(40, pg_temp.got('i6'))],
  array['lender_posted', 'lender_posted', 'provider_received', 'provider_received'],
  'D: stage words after the reversals: a receipt reversed by 0.01 is STILL lender_posted; reversed in one piece or in two parts it is provider_received again');
select is(array[pg_temp.act(40, 'SAMPLE-LN-3', 'RC-D3'), pg_temp.act(40, 'SAMPLE-LN-4', 'RC-D4'), pg_temp.act(40, 'SAMPLE-LN-5', 'RC-D5'), pg_temp.act(40, 'SAMPLE-LN-6', 'RC-D6')],
  array['posted', 'posted', 'reversed', 'reversed'], 'D: the loan activity lists a partly reversed receipt as posted, and a fully reversed one (one reversal or two) as reversed');
select is((select state from servicing.my_loan_activity(pg_temp.lid('SAMPLE-LN-4')) where entry_kind = 'lender_reversal'), 'recorded', 'D: the 0.01 reversal is listed as its own recorded entry');
select is(pg_temp.bst(41, pg_temp.got('iy')), 'lender_posted', 'D: lender Y''s borrower: a reversal of 0.01 leaves the receipt posted too');
-- 2. The lender's stage view.
select is(array[pg_temp.lst(17, pg_temp.got('i3')), pg_temp.lst(17, pg_temp.got('i4')), pg_temp.lst(17, pg_temp.got('i5')), pg_temp.lst(17, pg_temp.got('i6'))], array['true', 'true', 'false', 'false'],
  'D: the stage view (lender X''s viewer): lender_posted stays true after a reversal of 0.01 and turns false only when the reversals reach the receipt');
select is(pg_temp.lst(27, pg_temp.got('iy')), 'true', 'D: lender Y''s viewer sees its own payment as lender_posted');
select is(pg_temp.lst(27, pg_temp.got('i3')), null, 'D: and none of lender X''s payments (the view shows only the caller''s lender)');
-- 3. The quiet period (the reminders' "just paid"): captured five days ago, so only the lender's receipt can count.
select is(array[pg_temp.quiet('SAMPLE-LN-3'), pg_temp.quiet('SAMPLE-LN-4'), pg_temp.quiet('SAMPLE-LN-5'), pg_temp.quiet('SAMPLE-LN-6'), pg_temp.quiet('SAMPLE-LN-Y1')],
  array[true, true, false, false, true], 'D: the quiet period after a payment is kept for a receipt reversed by 0.01 and lifted only when it is reversed in full');
-- 4. The reconciliation run.
select pg_temp.as_system();
select is(payments.run_reconciliation(pg_temp.lx(), pg_temp.d()) ->> 'unchanged', 'false', 'D: the nightly run for lender X');
select pg_temp.as_user(pg_temp.u(16));
select is((select (report #>> '{matched,receipt}')::int from payments.reconciliation_summary(pg_temp.lx(), pg_temp.d())), 3,
  'D: three payments are matched to a receipt (the first payment of flow A, D3 and D4): a receipt reversed by 0.01 still explains its payment');
select is((select array_agg(p.provider_payment_ref order by p.provider_payment_ref) from payments.reconciliation_exceptions e join payments.provider_payments p on p.id::text = e.subject ->> 'provider_payment_id'
            where e.class = 'lender_receipt_missing' and e.status <> 'resolved'), array['PAY-D5', 'PAY-D6'],
  'D: lender_receipt_missing is raised for D5 and D6 only: no false exception for the receipt that was reversed by 0.01');
select pg_temp.as_system();
select is(payments.run_reconciliation(pg_temp.ly(), pg_temp.d()) ->> 'unchanged', 'false', 'D: and for lender Y');
select pg_temp.as_user(pg_temp.u(26));
select is((select (report #>> '{matched,receipt}')::int from payments.reconciliation_summary(pg_temp.ly(), pg_temp.d())), 1, 'D: lender Y''s payment is matched to its receipt (reversed by 0.01)');
select is((select count(*) from payments.reconciliation_exceptions where class = 'lender_receipt_missing'), 0::bigint, 'D: and lender Y has no lender_receipt_missing exception');
select pg_temp.as_user(pg_temp.u(27));
select is((select count(*) from payments.reconciliation_exceptions where lender_org_id = pg_temp.lx()), 0::bigint, 'D: lender Y''s viewer sees none of lender X''s exceptions');
select pg_temp.as_user(pg_temp.u(17));
select is((select count(*) from payments.reconciliation_exceptions where lender_org_id = pg_temp.ly()), 0::bigint, 'D: and lender X''s viewer none of lender Y''s');

-- D, cross-tenant: a reversal row of ANOTHER lender never counts. The keys refuse such a row (a reversal must name a receipt of its own lender); the
-- consumers refuse it as well, which is shown with the key and the trigger taken away inside a block that is rolled back: lender Y's row reverses the
-- WHOLE of lender X's receipt RC-D3, and every consumer still reads RC-D3 as posted.
select pg_temp.as_owner();
select is(pg_temp.err(format($$insert into servicing.lms_receipts (lender_org_id, loan_account_id, kind, lms_receipt_ref, reverses_receipt_id, reverses_receipt_ref, amount_minor, value_date, source_system,
  source_record_id, reported_as_of, content_sha256) select %L, %L, 'reversal', 'RV-FOREIGN', r.id, r.lms_receipt_ref, 475000, current_date, 'file_import', 'SRC-RV-FOREIGN', clock_timestamp(), %L
  from servicing.lms_receipts r where r.lms_receipt_ref = 'RC-D3'$$, pg_temp.ly(), pg_temp.lid('SAMPLE-LN-Y1'), pg_temp.sha('foreign'))), '23514|reversal_target_invalid',
  'D: another lender''s reversal of lender X''s receipt is refused at the table (a reversal must name a receipt of its own lender)');
create function pg_temp.foreign_reversal() returns text language plpgsql as $fn$
declare v_res text; v_run uuid;
begin
  begin
    perform pg_temp.as_owner();
    alter table servicing.lms_receipts drop constraint lms_receipts_reverses_receipt_id_lender_org_id_fkey;
    alter table servicing.lms_receipts disable trigger check_reversal;
    insert into servicing.lms_receipts (lender_org_id, loan_account_id, kind, lms_receipt_ref, reverses_receipt_id, reverses_receipt_ref, amount_minor, value_date, source_system,
      source_record_id, reported_as_of, content_sha256)
    select pg_temp.ly(), pg_temp.lid('SAMPLE-LN-Y1'), 'reversal', 'RV-FOREIGN', r.id, r.lms_receipt_ref, 475000, pg_temp.d(), 'file_import', 'SRC-RV-FOREIGN', clock_timestamp(), pg_temp.sha('foreign')
      from servicing.lms_receipts r where r.lms_receipt_ref = 'RC-D3';
    -- A pad receipt of lender X, so that its inputs change and the run is evaluated afresh.
    insert into servicing.lms_receipts (lender_org_id, loan_account_id, kind, lms_receipt_ref, amount_minor, value_date, source_system, source_record_id, reported_as_of, content_sha256)
    values (pg_temp.lx(), pg_temp.lid('SAMPLE-LN-10'), 'receipt', 'RC-PAD', 1, pg_temp.d(), 'file_import', 'SRC-RC-PAD', clock_timestamp(), pg_temp.sha('pad'));
    v_res := array_to_string(array[pg_temp.bst(40, pg_temp.got('i3')), pg_temp.lst(17, pg_temp.got('i3')), pg_temp.act(40, 'SAMPLE-LN-3', 'RC-D3'), pg_temp.quiet('SAMPLE-LN-3')::text], ',');
    perform pg_temp.as_system();
    v_run := (payments.run_reconciliation(pg_temp.lx(), pg_temp.d()) ->> 'run_id')::uuid;
    perform pg_temp.as_owner();
    v_res := v_res || ',' || (select count(*) from payments.reconciliation_matches m where m.run_id = v_run and m.kind = 'payment_receipt'
                                 and m.receipt_id = (select id from servicing.lms_receipts where lms_receipt_ref = 'RC-D3'))::text;
    raise exception using errcode = 'P0099', message = v_res;
  exception when sqlstate 'P0099' then
    return sqlerrm;
  end;
end
$fn$;
grant execute on all functions in schema pg_temp to public;
select is(pg_temp.foreign_reversal(), 'lender_posted,true,posted,true,1',
  'D: with that guard taken away, lender Y''s full reversal of lender X''s receipt changes nothing: stage lender_posted, view true, activity posted, quiet period kept, run match kept');
select pg_temp.as_owner();
select is((select count(*) from servicing.lms_receipts where lms_receipt_ref in ('RV-FOREIGN', 'RC-PAD')), 0::bigint, 'D: and the block left no row behind');
select is((select count(*) from pg_constraint where conname = 'lms_receipts_reverses_receipt_id_lender_org_id_fkey'), 1::bigint, 'D: nor changed the table (the key is back)');

-- ============================================================================================================================
-- FLOW A.3  A platform suspension in the middle of a payment: the link is withdrawn, the lender cannot undo the hold, a DIFFERENT platform person
--           releases it, the lender's pair activates the configuration again, the payment completes.
-- ============================================================================================================================
select pg_temp.keep('i2', pg_temp.ask(40, 'SAMPLE-LN-2', 'pay-key-030-A2-0000001')::text);
select pg_temp.as_system();
select payments.record_order_created(pg_temp.got('i2')::uuid, 'ORD-A2');
select payments.store_handoff_link('payment_intent', pg_temp.got('i2')::uuid, 'v1', pg_temp.bytes(40), now() + interval '2 hours');
select pg_temp.as_user(pg_temp.u(40));
select is((select count(*) from payments.take_handoff_link('payment_intent', pg_temp.got('i2')::uuid)), 1::bigint, 'A3: before the suspension the borrower can fetch the hand-off link');
-- The suspension.
select pg_temp.as_user(pg_temp.u(41));
select is(pg_temp.err(format($$select payments.suspend_payment_config(%L, 'a borrower must not be able to do this')$$, pg_temp.cfgx())), '42501|', 'A3: a borrower cannot suspend a configuration');
select pg_temp.as_user(pg_temp.u(25));
select is(pg_temp.err(format($$select payments.suspend_payment_config(%L, 'another lender''s approver must not do this')$$, pg_temp.cfgx())), '42501|', 'A3: nor can another lender''s approver');
select pg_temp.as_user(pg_temp.u(1));
select is(payments.suspend_payment_config(pg_temp.cfgx(), 'provider reported a settlement incident today'), 'suspended', 'A3: a platform person suspends lender X''s configuration');
select pg_temp.as_user(pg_temp.u(40));
select is(pg_temp.err(format($$select * from payments.take_handoff_link('payment_intent', %L)$$, pg_temp.got('i2'))), 'P0002|link_unavailable', 'A3: the hand-off link is withdrawn at once (the borrower is not sent to pay into a destination the platform has just stopped)');
select is((select link_available from payments.my_payment_detail(pg_temp.got('i2')::uuid)), false, 'A3: the borrower''s detail says so: no link is available (the order is pending at the provider, so it is not cancellable either: it lapses with its link period)');
select is(pg_temp.err(format($$select payments.request_payment(%L, 'installment', 475000, 'pay-key-030-A3-0000001')$$, pg_temp.lid('SAMPLE-LN-7'))), '55000|collection_target_invalid', 'A3: a new payment on another loan of the lender is refused while the configuration is suspended');
select pg_temp.as_system();
select is(payments.ingest_provider_delivery(pg_temp.got('tokx'), pg_temp.dlv('DLV-A2', 'EVT-A2', 'payment', 'captured', 'PAY-A2', 'ORD-A2', 475000)) ->> 'outcome', 'rejected',
  'A3: a delivery for the suspended configuration is rejected at the door (the receiver verifies against active configurations only)');
select pg_temp.as_owner();
select is((select count(*) from payments.provider_events where provider_event_id = 'EVT-A2'), 0::bigint, 'A3: and stores no event');
select is((select count(*) from payments.webhook_receipts where delivery_id = 'DLV-A2' and reason_class = 'token_unknown_or_inactive'), 1::bigint, 'A3: only a receipt (the database cannot tell it from garbage)');
-- The lender cannot undo it.
select pg_temp.as_user(pg_temp.u(14));
select is(pg_temp.err(format($$select payments.submit_payment_config(%L)$$, pg_temp.got('cx')::uuid)), '55000|platform_hold', 'A3: the lender''s maker cannot re-submit the held configuration');
select pg_temp.as_user(pg_temp.u(13));
select pg_temp.keep('cx2', pg_temp.draft(pg_temp.lx(), 'cfg-key-030-000000002', pg_temp.got('mx')::uuid, pg_temp.got('sax')::uuid)::text);
select pg_temp.as_user(pg_temp.u(14));
select is(pg_temp.err(format($$select payments.submit_payment_config(%L)$$, pg_temp.got('cx2'))), '55000|platform_hold', 'A3: nor submit a NEW configuration while the hold stands (a new draft must not undo the kill switch)');
select pg_temp.as_user(pg_temp.u(15));
select is(pg_temp.err(format($$select payments.retire_payment_config(%L, 'the approver must not retire a held configuration')$$, pg_temp.got('cx')::uuid)), '55000|platform_hold', 'A3: nor retire it');
-- Release by a DIFFERENT platform person.
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err(format($$select payments.release_payment_config_hold(%L, 'the suspending person must not lift the hold')$$, pg_temp.got('cx')::uuid)), '42501|self_approval', 'A3: the person who suspended cannot release');
select pg_temp.as_user(pg_temp.u(2));
select is(payments.release_payment_config_hold(pg_temp.got('cx')::uuid, 'incident closed, evidence reviewed by a second person'), 'suspended', 'A3: a different platform person releases the hold (the configuration stays suspended)');
select pg_temp.as_user(pg_temp.u(14));
select is(payments.submit_payment_config(pg_temp.got('cx')::uuid), 'pending_approval', 'A3: now the lender''s maker re-submits the configuration (validated again) ...');
select pg_temp.as_user(pg_temp.u(15));
select is(payments.decide_payment_config(pg_temp.got('cx')::uuid, true, 'SAMPLE re-approval'), 'active', 'A3: ... and the approver approves it again');
-- The payment completes.
select pg_temp.as_system();
select is(payments.ingest_provider_delivery(pg_temp.got('tokx'), pg_temp.dlv('DLV-A2B', 'EVT-A2B', 'payment', 'captured', 'PAY-A2', 'ORD-A2', 475000)) ->> 'outcome', 'ok', 'A3: the provider''s event now reaches the database');
select is(payments.apply_provider_event(pg_temp.ev('EVT-A2B')) ->> 'outcome', 'applied', 'A3: and is applied');
select pg_temp.as_user(pg_temp.u(40));
select is((select stage from payments.my_payment(pg_temp.got('i2')::uuid)), 'provider_received', 'A3: the borrower''s stage: provider_received');
-- Lender Y was never affected.
select pg_temp.as_user(pg_temp.u(41));
select pg_temp.keep('iy2', pg_temp.ask(41, 'SAMPLE-LN-Y1', 'pay-key-030-Y2-0000001')::text);
select is((select intent_status from payments.my_payment(pg_temp.got('iy2')::uuid)), 'created', 'A3: lender Y''s borrower could ask for a payment while lender X''s configuration was held ... ');
select pg_temp.as_user(pg_temp.u(27));
select is((select count(*) from payments.lender_payment_config_events where config_id = pg_temp.cfgx()), 0::bigint, 'A3: ... and lender Y''s viewer sees nothing of lender X''s configuration history (suspension, release, re-approval)');

-- ============================================================================================================================
-- FLOW B  A mandate from the borrower's request (with step-up) to the provider's registration, a planned debit, its pre-debit notice, the debit itself,
--         a borrower's cancellation the provider has not acknowledged (the sweep queues it again) and an ended mandate that takes its planned debits
--         and notices with it. Loan 7 of lender X falls due in three days, loan 8 in two (so its 48-hour notice is late from the start).
-- ============================================================================================================================
create function pg_temp.mid(n integer) returns uuid language sql as $fn$ select ('faa00000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid $fn$;
-- Step-up codes (verified, bound to a mandate id) and device-integrity results, as the identity module would have recorded them (an earlier phase's rows).
create function pg_temp.stepup(p_borrower text, p_mandate uuid) returns void language plpgsql as $fn$
begin
  perform pg_temp.as_owner();
  insert into identity.stepup_challenges (id, borrower_id, action, context_ref, code_hash, status, delivery_status, expires_at, verified_at, verified_until)
  values (gen_random_uuid(), p_borrower::uuid, 'mandate_creation', p_mandate::text, repeat('a', 64), 'verified', 'accepted', now() + interval '10 minutes', now(), now() + interval '10 minutes');
end
$fn$;
create function pg_temp.integrity(p_borrower text, p_level text) returns void language plpgsql as $fn$
begin
  perform pg_temp.as_owner();
  insert into identity.device_attestations (borrower_id, level, provider, verified_at, expires_at) values (p_borrower::uuid, p_level, 'sample_attest', clock_timestamp(), clock_timestamp() + interval '1 hour');
end
$fn$;
-- The provider event for a mandate or a debit: delivered by the receiver and applied by the worker; returns the apply outcome (or ingest:<outcome>).
create function pg_temp.mdeliver(p_token text, p_tag text, p_kind text, p_status text, p_obj text, p_order text default null, p_amount bigint default null, p_occurred text default null)
returns text language plpgsql as $fn$
declare v_in text;
begin
  perform pg_temp.as_system();
  v_in := payments.ingest_provider_delivery(p_token, pg_temp.dlv('DLV-' || p_tag, 'EVT-' || p_tag, p_kind, p_status, p_obj, p_order, p_amount, null, p_occurred)) ->> 'outcome';
  if v_in <> 'ok' then return 'ingest:' || v_in; end if;
  return payments.apply_provider_event(pg_temp.ev('EVT-' || p_tag)) ->> 'outcome';
end
$fn$;
-- A mandate up to ACTIVE through the public functions: step-up, request, the worker's hand-off, the provider's registration event.
create function pg_temp.mandate_up(p_borrower integer, p_bkey text, p_loan text, p_mid uuid, p_ref text, p_token text, p_tag text) returns text language plpgsql as $fn$
declare v text;
begin
  perform pg_temp.stepup(pg_temp.got(p_bkey), p_mid);
  perform pg_temp.as_user(pg_temp.u(p_borrower));
  perform payments.request_mandate(p_mid, pg_temp.lid(p_loan), 'enach_api', 4000000, pg_temp.d() + 1, pg_temp.d() + 365, 'XXXXXX9999');
  perform pg_temp.as_system();
  perform payments.record_mandate_handoff(p_mid, 'handoff', p_ref, now() + interval '1 hour');
  v := pg_temp.mdeliver(p_token, 'M' || p_tag, 'mandate', 'active', p_ref);
  return v;
end
$fn$;
grant execute on all functions in schema pg_temp to public;

-- 1. The request: a verified step-up code bound to THIS mandate and a device-integrity result are needed.
select pg_temp.integrity(pg_temp.got('b1'), 'strong');
select pg_temp.integrity(pg_temp.got('b2'), 'strong');
select pg_temp.as_user(pg_temp.u(40));
select is(pg_temp.err(format($$select payments.request_mandate(%L, %L, 'enach_api', 4000000, %L, %L, 'XXXXXX9999')$$, pg_temp.mid(1), pg_temp.lid('SAMPLE-LN-7'), pg_temp.d() + 1, pg_temp.d() + 365)), '42501|stepup_required',
  'B: without a verified step-up code bound to this mandate nothing is created');
select pg_temp.stepup(pg_temp.got('b1'), pg_temp.mid(1));
select pg_temp.as_user(pg_temp.u(40));
select is(payments.request_mandate(pg_temp.mid(1), pg_temp.lid('SAMPLE-LN-7'), 'enach_api', 4000000, pg_temp.d() + 1, pg_temp.d() + 365, 'XXXXXX9999'), pg_temp.mid(1), 'B: with the step-up, the borrower''s request creates the mandate');
select is((select (status, rail, max_amount_minor, cancel_requested, next_debit_on is null)::text from payments.my_mandates()), '(draft,enach_api,4000000,f,t)', 'B: the borrower sees: draft, the rail, the maximum, nothing to cancel, no debit yet');
-- 2. The worker hands the request to the provider and keeps the sealed authorisation link.
select pg_temp.as_system();
select is(payments.record_mandate_handoff(pg_temp.mid(1), 'handoff', 'SAMPLE-PM-B1', now() + interval '1 hour'), 'registration_pending', 'B: the provider took the request: registration_pending (not active)');
select is(payments.store_handoff_link('mandate', pg_temp.mid(1), 'v1', pg_temp.bytes(40), now() + interval '2 hours'), 'stored', 'B: the worker keeps the sealed authorisation link');
select pg_temp.as_user(pg_temp.u(40));
select is((select status from payments.my_mandates()), 'registration_pending', 'B: the borrower sees: registration_pending');
select is((select count(*) from payments.take_handoff_link('mandate', pg_temp.mid(1))), 1::bigint, 'B: and can fetch the authorisation link');
select pg_temp.as_user(pg_temp.u(41));
select is(pg_temp.err(format($$select * from payments.take_handoff_link('mandate', %L)$$, pg_temp.mid(1))), 'P0002|link_unavailable', 'B: another borrower cannot');
-- 3. The provider's registered event.
select is(pg_temp.mdeliver(pg_temp.got('tokx'), 'MB1', 'mandate', 'active', 'SAMPLE-PM-B1'), 'applied', 'B: the provider''s verified "active" event is applied');
select pg_temp.as_user(pg_temp.u(40));
select is((select status from payments.my_mandates()), 'active', 'B: the borrower sees: active');
select is(pg_temp.err(format($$select * from payments.take_handoff_link('mandate', %L)$$, pg_temp.mid(1))), 'P0002|link_unavailable', 'B: once registered, the authorisation link is no longer handed out');
-- 4. The planner plans the installment that falls due within ten days; the notice is due 48 hours before the debit day.
select pg_temp.as_system();
select is((payments.plan_mandate_debits() ->> 'planned')::int >= 1, true, 'B: the planner plans the debit for the installment due in three days');
select pg_temp.as_user(pg_temp.u(40));
select is((select (next_debit_on = pg_temp.d() + 3, next_debit_minor, next_debit_notified)::text from payments.my_mandates()), '(t,475000,f)', 'B: the borrower sees the next debit: in three days, 4,750.00, not yet notified');
select is((select (status, planned, notice_status)::text from payments.my_mandate_debits(pg_temp.mid(1))), '(scheduled,t,planned)', 'B: with a pre-debit notice planned');
-- 5. The notice is claimed by the worker, sent, and recorded (once it is due: a day passes, which the fixture states by moving the due time).
select pg_temp.as_system();
select is((select count(*) from payments.claim_pre_debit_notices(100) where mandate_id = pg_temp.mid(1)), 0::bigint, 'B: the notice is not claimed before it is due');
select pg_temp.as_owner();
update payments.pre_debit_notices set notice_due_at = clock_timestamp() - interval '1 minute' where mandate_id = pg_temp.mid(1);
select pg_temp.as_system();
select pg_temp.keep('nb1', (select notice_id::text from payments.claim_pre_debit_notices(100) where mandate_id = pg_temp.mid(1)));
select isnt(pg_temp.got('nb1'), null, 'B: the notice is due and is claimed');
select is((select count(*) from payments.claim_pre_debit_notices(100) where mandate_id = pg_temp.mid(1)), 0::bigint, 'B: it is leased: not claimed again at once');
select is(payments.record_pre_debit_notice(pg_temp.got('nb1')::uuid, 'accepted'), 'accepted', 'B: the channel accepts it');
select pg_temp.as_user(pg_temp.u(40));
select is((select (status, notice_status, notice_sent_at is not null)::text from payments.my_mandate_debits(pg_temp.mid(1))), '(notified,sent,t)', 'B: the debit is notified and the notice sent');
select is((select next_debit_notified from payments.my_mandates()), true, 'B: the mandate list says the next debit was notified');
-- 6. The debit is presented and settled (provider events on the debit day).
select is(pg_temp.mdeliver(pg_temp.got('tokx'), 'DB1P', 'debit', 'pending', 'SAMPLE-DB-B1', 'SAMPLE-PM-B1', 475000, pg_temp.dt(3) || 'T10:00:00Z'), 'applied', 'B: the provider presents the debit: matched to the planned debit');
select is(pg_temp.mdeliver(pg_temp.got('tokx'), 'DB1S', 'debit', 'succeeded', 'SAMPLE-DB-B1', 'SAMPLE-PM-B1', 475000, pg_temp.dt(3) || 'T10:00:00Z'), 'applied', 'B: and settles it');
select pg_temp.as_user(pg_temp.u(40));
select is((select (status, planned)::text from payments.my_mandate_debits(pg_temp.mid(1))), '(settled,t)', 'B: the borrower sees the debit as settled');
select pg_temp.as_owner();
select is(private.reminder_recent_payment(pg_temp.lid('SAMPLE-LN-7'), 48), true, 'B: a settled debit is a payment for the reminders'' quiet period');
select is((select count(*) from payments.reconciliation_exceptions where subject ->> 'mandate_id' = pg_temp.mid(1)::text or subject ->> 'debit_id' in (select id::text from payments.mandate_debits where mandate_id = pg_temp.mid(1))), 0::bigint,
  'B: and nothing is raised for a clean mandate cycle');

-- 7. A second mandate (loan 8, due in two days: its notice is late from the start) and a third at lender Y.
select is(pg_temp.mandate_up(40, 'b1', 'SAMPLE-LN-8', pg_temp.mid(2), 'SAMPLE-PM-B2', pg_temp.got('tokx'), 'B2'), 'applied', 'B: the borrower''s second mandate (loan 8) is registered');
select is(pg_temp.mandate_up(41, 'b2', 'SAMPLE-LN-Y1', pg_temp.mid(3), 'SAMPLE-PM-Y1', pg_temp.got('toky'), 'Y1'), 'applied', 'B: and lender Y''s borrower registers a mandate at lender Y');
select pg_temp.as_system();
select is((payments.plan_mandate_debits() ->> 'notices_late')::int >= 1, true, 'B: planning a debit inside its notice lead time marks its notice late at once');
select pg_temp.as_user(pg_temp.u(40));
select is((select (status, planned, notice_status)::text from payments.my_mandate_debits(pg_temp.mid(2))), '(scheduled,t,late)', 'B: the borrower sees the second debit with a late notice');
select pg_temp.as_user(pg_temp.u(17));
select is((select (class, severity, owner)::text from payments.reconciliation_exceptions where class = 'mandate_notice_late' and subject ->> 'debit_id' in
            (select id::text from payments.mandate_debits where mandate_id = pg_temp.mid(2))), '(mandate_notice_late,warning,lender)', 'B: the lender''s viewer sees the late notice raised as a lender exception');
select pg_temp.as_user(pg_temp.u(27));
select is((select count(*) from payments.mandates where lender_org_id = pg_temp.lx()) + (select count(*) from payments.mandate_debits where lender_org_id = pg_temp.lx())
          + (select count(*) from payments.pre_debit_notices where lender_org_id = pg_temp.lx()) + (select count(*) from payments.mandate_events where lender_org_id = pg_temp.lx()), 0::bigint,
  'B: lender Y''s viewer sees none of lender X''s mandates, debits, notices or mandate history');
select is((select count(*) from payments.mandates), 1::bigint, 'B: and exactly its own mandate');
select pg_temp.as_user(pg_temp.u(17));
select is((select count(*) from payments.mandates), 2::bigint, 'B: lender X''s viewer sees its two mandates and not lender Y''s');
select pg_temp.as_user(pg_temp.u(41));
select is(pg_temp.err(format($$select payments.request_mandate_cancellation(%L)$$, pg_temp.mid(2))), 'P0002|', 'B: another borrower cannot cancel the mandate');
select is((select array_agg(mandate_id) from payments.my_mandates()), array[pg_temp.mid(3)], 'B: and sees only her own mandate');
-- 8. The borrower cancels; the provider has not acknowledged it.
select pg_temp.as_user(pg_temp.u(40));
select is((select array_agg(mandate_id order by mandate_id) from payments.my_mandates()), array[pg_temp.mid(1), pg_temp.mid(2)], 'B: the first borrower sees her two mandates');
select is(payments.request_mandate_cancellation(pg_temp.mid(2)), 'cancel_requested', 'B: the borrower asks to cancel the second mandate');
select is((select (cancel_requested, next_debit_on is null)::text from payments.my_mandates() where mandate_id = pg_temp.mid(2)), '(t,t)', 'B: she sees the request, and no next debit is shown for a mandate she asked to cancel');
select pg_temp.as_system();
select is((select count(*) from payments.claim_pre_debit_notices(100) where mandate_id = pg_temp.mid(2)), 0::bigint, 'B: no pre-debit notice is sent for a mandate with a cancellation request');
select pg_temp.as_owner();
select is((select count(*) from ops.outbox_events where dedupe_key like 'mandate.cancel:' || pg_temp.mid(2)::text || '%'), 1::bigint, 'B: one cancellation is queued for the provider');
select pg_temp.as_system();
select is((payments.sweep_mandates() ->> 'cancel_resent')::int, 0, 'B: the sweep does not queue it again a moment later');
select pg_temp.as_owner();
update payments.mandates set cancel_enqueued_at = clock_timestamp() - interval '1 hour' where id = pg_temp.mid(2);
select pg_temp.as_system();
select is((payments.sweep_mandates() ->> 'cancel_resent')::int, 1, 'B: an hour later, with no acknowledgement, the sweep queues the cancellation again');
select pg_temp.as_owner();
select is((select count(*) from ops.outbox_events where dedupe_key like 'mandate.cancel:' || pg_temp.mid(2)::text || '%'), 2::bigint, 'B: a second cancellation is in the queue');
select pg_temp.as_system();
select is(payments.mark_mandate_cancel_sent(pg_temp.mid(2)), 'ok', 'B: the worker sends it and records that the provider took it');
select is((payments.sweep_mandates() ->> 'cancel_resent')::int, 0, 'B: an acknowledged cancellation is not queued again');
-- 9. The provider confirms; the mandate is over and takes its planned debit and its notice with it.
select is(pg_temp.mdeliver(pg_temp.got('tokx'), 'MB2C', 'mandate', 'cancelled', 'SAMPLE-PM-B2'), 'applied', 'B: the provider''s verified "cancelled" event is applied');
select pg_temp.as_user(pg_temp.u(40));
select is((select (status, next_debit_on is null)::text from payments.my_mandates() where mandate_id = pg_temp.mid(2)), '(cancelled,t)', 'B: the borrower sees: cancelled, no next debit');
select is((select (status, planned)::text from payments.my_mandate_debits(pg_temp.mid(2))), '(cancelled,t)', 'B: the planned debit nobody presented is cancelled');
select pg_temp.as_owner();
select is((select array_agg(status) from payments.pre_debit_notices where mandate_id = pg_temp.mid(2)), array['not_needed'], 'B: and its unsent notice is closed as not needed');
-- A debit the provider presents after the end is recorded and raised, never silently attached.
select is(pg_temp.mdeliver(pg_temp.got('tokx'), 'DB2P', 'debit', 'pending', 'SAMPLE-DB-B2', 'SAMPLE-PM-B2', 475000, pg_temp.dt(2) || 'T10:00:00Z'), 'applied', 'B: the provider presents a debit after the end');
select pg_temp.as_owner();
select is((select (planned, status)::text from payments.mandate_debits where provider_debit_ref = 'SAMPLE-DB-B2'), '(f,presented)', 'B: it is recorded as an unplanned debit (the planned one was cancelled)');
select pg_temp.as_user(pg_temp.u(17));
select is((select (class, severity)::text from payments.reconciliation_exceptions where class = 'mandate_debit_unresolved' and subject ->> 'debit_id' in
            (select id::text from payments.mandate_debits where provider_debit_ref = 'SAMPLE-DB-B2')), '(mandate_debit_unresolved,critical)', 'B: the lender''s viewer sees a critical mandate_debit_unresolved for it');
select pg_temp.as_user(pg_temp.u(27));
select is((select count(*) from payments.reconciliation_exceptions where class in ('mandate_notice_late', 'mandate_debit_unresolved')), 0::bigint, 'B: and lender Y sees none of those exceptions');
select pg_temp.as_user(pg_temp.u(41));
select is((select (status)::text from payments.my_mandates()), 'active', 'B: lender Y''s mandate is untouched by lender X''s cancellation (still active)');

select * from finish();
rollback;
