-- Phase 08a review-fix wave, builder SS (migration 20261018000925): servicing sync, import, receipts, lender documents, quotations and closure.
-- Each section names the review findings it proves. Every assertion about a corrected behaviour fails on a database WITHOUT that migration; the
-- assertions about guards that already existed (M20, M21) fail when the named guard is removed (mutation-checked, see docs/specs/08a-notes/fixes-SS.md).
-- Synthetic data only (SAMPLE). Error codes are reported as SQLSTATE|hint.
begin;
create extension if not exists pgtap with schema extensions;
select plan(281);

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
create function pg_temp.st(q text) returns text language sql as $fn$ select left(pg_temp.err(q), 5) $fn$;
create function pg_temp.keep(k text, v text) returns text language sql as $fn$ select set_config('t.' || k, v, true) $fn$;
create function pg_temp.got(k text) returns text language sql as $fn$ select current_setting('t.' || k) $fn$;
-- A timestamp text n hours in the past (UTC, whole seconds).
create function pg_temp.ts(hours numeric) returns text language sql as $fn$
  select to_char((clock_timestamp() - make_interval(secs => (hours * 3600)::integer)) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') $fn$;
create function pg_temp.sha(label text) returns text language sql as $fn$ select encode(sha256(convert_to('sample-file-' || label, 'UTF8')), 'hex') $fn$;
create function pg_temp.sk(label text) returns text language sql as $fn$ select 'servicing/test/' || md5(label) || '/doc' $fn$;
create function pg_temp.loan(loan_ref text, app_ref text, srid text, hours_ago numeric, extra jsonb default '{}'::jsonb) returns jsonb language sql as $fn$
  select jsonb_strip_nulls(jsonb_build_object(
    'lms_loan_ref', loan_ref, 'borrower_ref', app_ref, 'status', 'active', 'sanctioned_amount', '50000.00',
    'disbursed_amount', '50000.00', 'disbursement_ref', 'SAMPLE-DISB-' || loan_ref, 'disbursement_date', to_char(current_date - 30, 'YYYY-MM-DD'),
    'outstanding_principal', '41666.67', 'next_due_date', to_char(current_date + 10, 'YYYY-MM-DD'), 'next_due_amount', '4500.00',
    'overdue_principal', '0.00', 'overdue_interest', '0.00', 'penal_charges', '0.00', 'other_charges', '0.00', 'total_overdue', '0.00',
    'days_past_due', '0', 'source_record_id', srid, 'reported_as_of', pg_temp.ts(hours_ago)) || extra)
$fn$;
create function pg_temp.receipt(loan_ref text, receipt_ref text, amount text, hours_ago numeric, extra jsonb default '{}'::jsonb) returns jsonb language sql as $fn$
  select jsonb_strip_nulls(jsonb_build_object(
    'lms_loan_ref', loan_ref, 'lms_receipt_ref', receipt_ref, 'receipt_kind', 'receipt', 'amount', amount,
    'value_date', to_char(current_date - 3, 'YYYY-MM-DD'), 'payment_mode', 'upi', 'bank_reference', 'SAMPLE-BANKREF-' || receipt_ref,
    'source_record_id', 'SRC-' || receipt_ref, 'reported_as_of', pg_temp.ts(hours_ago)) || extra)
$fn$;
create function pg_temp.sched(loan_ref text, srid text, hours_ago numeric, extra jsonb default '{}'::jsonb) returns jsonb language sql as $fn$
  select jsonb_strip_nulls(jsonb_build_object(
    'lms_loan_ref', loan_ref, 'source_record_id', srid, 'reported_as_of', pg_temp.ts(hours_ago),
    'installments', jsonb_build_array(
      jsonb_build_object('installment_seq', '1', 'due_date', to_char(current_date + 10, 'YYYY-MM-DD'), 'principal', '4166.67', 'interest', '333.33', 'fees', '0.00'),
      jsonb_build_object('installment_seq', '2', 'due_date', to_char(current_date + 40, 'YYYY-MM-DD'), 'principal', '4166.67', 'interest', '333.33'))) || extra)
$fn$;
create function pg_temp.stage(lender uuid, kind text, label text, rows jsonb, resub uuid default null, source_kind text default 'file') returns jsonb language sql as $fn$
  select servicing.stage_import(lender, kind, source_kind, pg_temp.sha(label), 1000, 'udofin-lms-import-v1', rows, 'idem-' || rpad(label, 16, '0'), resub)
$fn$;
-- Stage a file and commit it (the logged-in operator does both); returns the commit result.
create function pg_temp.imp(lender uuid, kind text, label text, rows jsonb) returns jsonb language plpgsql as $fn$
declare v jsonb;
begin
  v := pg_temp.stage(lender, kind, label, rows);
  if v ->> 'status' <> 'previewed' then return v; end if;
  return servicing.commit_import((v ->> 'batch_id')::uuid);
end
$fn$;
create function pg_temp.errs(res jsonb) returns text language sql as $fn$
  select coalesce(string_agg((e ->> 'row_no') || ':' || array_to_string(array(select jsonb_array_elements_text(e -> 'error_codes')), '+') || '@'
                             || array_to_string(array(select jsonb_array_elements_text(e -> 'field_names')), '+'), ';' order by (e ->> 'row_no')::int), '')
  from jsonb_array_elements(res -> 'errors') e
$fn$;
create function pg_temp.codes(kind text, rec jsonb) returns text language sql as $fn$
  select coalesce(array_to_string(private.servicing_text_array(private.servicing_validate(kind, rec) -> 'codes'), ','), '') || '/' ||
         coalesce(array_to_string(private.servicing_text_array(private.servicing_validate(kind, rec) -> 'fields'), ','), '')
$fn$;
-- Loan account id by the lender's own loan reference (all lenders; the references are distinct in this file).
create function pg_temp.lid(ref text) returns uuid language sql security definer as $fn$ select id from servicing.loan_accounts where lms_loan_ref = ref $fn$;
-- Runs a query as the table owner and returns its first column as text (for assertions made while acting as a restricted role).
create function pg_temp.q(sql text) returns text language plpgsql security definer as $fn$
declare v text;
begin
  execute sql into v;
  return v;
end
$fn$;
-- Registers a SAMPLE lender-issued PDF record (the bytes are not stored in these tests).
create function pg_temp.reg(p_loan uuid, p_kind text, p_label text, p_from date default null, p_to date default null, p_supersedes uuid default null,
                            p_request uuid default null, p_source text default 'lender_upload', p_issued interval default interval '1 minute') returns uuid language sql as $fn$
  select servicing.register_loan_document(p_loan, p_kind, pg_temp.sk(p_label), pg_temp.sha(p_label), 12345, 'application/pdf', 'SAMPLE-REF-' || p_label,
                                          clock_timestamp() - p_issued, p_from, p_to, p_supersedes, p_request, p_source)
$fn$;
-- Records a SAMPLE quotation (parts 10000.00 + 500.00 + 100.00 + 200.00 = 10800.00 unless changed), as of one hour ago.
create function pg_temp.quote(p_loan uuid, p_ref text, p_valid_hours numeric default 24, p_p text default '10000.00', p_i text default '500.00',
                              p_c text default '100.00', p_pp text default '200.00', p_t text default '10800.00', p_req uuid default null,
                              p_source text default 'lender_portal', p_letter uuid default null, p_as_of_hours numeric default 1) returns uuid language sql as $fn$
  select servicing.record_foreclosure_quote(p_loan, p_ref, clock_timestamp() - make_interval(secs => (p_as_of_hours * 3600)::integer),
                                            clock_timestamp() + make_interval(secs => (p_valid_hours * 3600)::integer), p_p, p_i, p_c, p_pp, p_t, p_source, p_req, p_letter)
$fn$;
grant execute on all functions in schema pg_temp to public;

-- Fixture ------------------------------------------------------------------------------------------------------------------
-- u01 X servicing operator, u02 X second operator, u03 X viewer (loan.read only), u04 Y operator, u05 borrower b1, u06 borrower b2,
-- u07 Z operator, u08 platform auditor, u09/u10 product and rule proposer / approver (not members), u11/u12 feature requester / decider (not members)
insert into auth.users (id, phone, raw_app_meta_data)
select ('ec000000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
       case n when 5 then '910000000091' when 6 then '910000000092' end,
       case when n in (5, 6) then '{}'::jsonb else '{"actor_type":"staff"}'::jsonb end
from generate_series(1, 12) n;

select pg_temp.as_owner();
insert into tenancy.organizations (id, kind, legal_name, display_name, regulator_registration_no, status) values
  ('eca00000-0000-4000-8000-000000000000', 'platform', 'Udofin Platform (test)', 'Udofin', null, 'active'),
  ('ecb00000-0000-4000-8000-000000000001', 'lender', 'Fix X Finance (test)', 'Fix X', 'TEST-EC-0001', 'active'),
  ('ecb00000-0000-4000-8000-000000000002', 'lender', 'Fix Y Finance (test)', 'Fix Y', 'TEST-EC-0002', 'active'),
  ('ecb00000-0000-4000-8000-000000000003', 'lender', 'Fix Z Finance (test)', 'Fix Z', 'TEST-EC-0003', 'active');
insert into onboarding.lender_gates (lender_org_id, stage) values
  ('ecb00000-0000-4000-8000-000000000001', 'activated'), ('ecb00000-0000-4000-8000-000000000002', 'activated'), ('ecb00000-0000-4000-8000-000000000003', 'activated');
insert into onboarding.lender_profiles (lender_org_id, category_key, regulator, created_by) values
  ('ecb00000-0000-4000-8000-000000000001', 'nbfc_icc', 'Reserve Bank of India', 'ec000000-0000-4000-8000-000000000009'),
  ('ecb00000-0000-4000-8000-000000000002', 'nbfc_icc', 'Reserve Bank of India', 'ec000000-0000-4000-8000-000000000009'),
  ('ecb00000-0000-4000-8000-000000000003', 'nbfc_mfi', 'Reserve Bank of India', 'ec000000-0000-4000-8000-000000000009');
insert into tenancy.memberships (id, org_id, user_id, status) values
  ('ecc10000-0000-4000-8000-000000000001', 'ecb00000-0000-4000-8000-000000000001', 'ec000000-0000-4000-8000-000000000001', 'active'),
  ('ecc10000-0000-4000-8000-000000000002', 'ecb00000-0000-4000-8000-000000000001', 'ec000000-0000-4000-8000-000000000002', 'active'),
  ('ecc10000-0000-4000-8000-000000000003', 'ecb00000-0000-4000-8000-000000000001', 'ec000000-0000-4000-8000-000000000003', 'active'),
  ('ecc10000-0000-4000-8000-000000000004', 'ecb00000-0000-4000-8000-000000000002', 'ec000000-0000-4000-8000-000000000004', 'active'),
  ('ecc10000-0000-4000-8000-000000000007', 'ecb00000-0000-4000-8000-000000000003', 'ec000000-0000-4000-8000-000000000007', 'active'),
  ('ecc10000-0000-4000-8000-000000000008', 'eca00000-0000-4000-8000-000000000000', 'ec000000-0000-4000-8000-000000000008', 'active'),
  ('ecc10000-0000-4000-8000-000000000019', 'ecb00000-0000-4000-8000-000000000001', 'ec000000-0000-4000-8000-000000000009', 'active'),
  ('ecc10000-0000-4000-8000-000000000020', 'ecb00000-0000-4000-8000-000000000002', 'ec000000-0000-4000-8000-000000000009', 'active'),
  ('ecc10000-0000-4000-8000-000000000021', 'ecb00000-0000-4000-8000-000000000003', 'ec000000-0000-4000-8000-000000000009', 'active'),
  ('ecc10000-0000-4000-8000-000000000022', 'ecb00000-0000-4000-8000-000000000001', 'ec000000-0000-4000-8000-000000000010', 'active'),
  ('ecc10000-0000-4000-8000-000000000023', 'ecb00000-0000-4000-8000-000000000002', 'ec000000-0000-4000-8000-000000000010', 'active'),
  ('ecc10000-0000-4000-8000-000000000024', 'ecb00000-0000-4000-8000-000000000003', 'ec000000-0000-4000-8000-000000000010', 'active');
insert into tenancy.membership_roles (membership_id, role_id)
select m.mid::uuid, r.id from (values
  ('ecc10000-0000-4000-8000-000000000001', 'lender', 'servicing_operator'),
  ('ecc10000-0000-4000-8000-000000000002', 'lender', 'servicing_operator'),
  ('ecc10000-0000-4000-8000-000000000003', 'lender', 'viewer'),
  ('ecc10000-0000-4000-8000-000000000004', 'lender', 'servicing_operator'),
  ('ecc10000-0000-4000-8000-000000000007', 'lender', 'servicing_operator'),
  ('ecc10000-0000-4000-8000-000000000008', 'platform', 'auditor'),
  ('ecc10000-0000-4000-8000-000000000019', 'lender', 'lender_admin'),
  ('ecc10000-0000-4000-8000-000000000020', 'lender', 'lender_admin'),
  ('ecc10000-0000-4000-8000-000000000021', 'lender', 'lender_admin'),
  ('ecc10000-0000-4000-8000-000000000022', 'lender', 'product_approver'),
  ('ecc10000-0000-4000-8000-000000000023', 'lender', 'product_approver'),
  ('ecc10000-0000-4000-8000-000000000024', 'lender', 'product_approver')
) as m (mid, kind, rkey)
join tenancy.roles r on r.org_id is null and r.applies_to = m.kind::tenancy.organization_kind and r.key = m.rkey;

-- Switches servicing_sync and statements_noc for X, Y and Z (an applied two-person request and the switch in ONE transaction, the only way the guard accepts).
insert into servicing.feature_change_requests (id, lender_org_id, feature, enable, mode, status, evidence, requested_by, idempotency_key, decided_by, decided_at, applied_at)
select ('ece00000-0000-4000-8000-0000000000' || lpad((l * 10 + f)::text, 2, '0'))::uuid, ('ecb00000-0000-4000-8000-00000000000' || l)::uuid,
       case f when 1 then 'servicing_sync' else 'statements_noc' end, true, 'two_person', 'applied', '{"contract_ref":"SAMPLE-EC-1"}',
       'ec000000-0000-4000-8000-000000000011', 'ec-req-key-' || lpad((l * 10 + f)::text, 8, '0'), 'ec000000-0000-4000-8000-000000000012', now(), now()
from generate_series(1, 3) l, generate_series(1, 2) f;
insert into servicing.lender_features (lender_org_id, feature, enabled, evidence, enabled_by, enabled_at, last_change_request_id)
select ('ecb00000-0000-4000-8000-00000000000' || l)::uuid, case f when 1 then 'servicing_sync' else 'statements_noc' end, true, '{"contract_ref":"SAMPLE-EC-1"}',
       'ec000000-0000-4000-8000-000000000012', now(), ('ece00000-0000-4000-8000-0000000000' || lpad((l * 10 + f)::text, 2, '0'))::uuid
from generate_series(1, 3) l, generate_series(1, 2) f;
-- Active file connections (the owner stands in for servicing.set_lms_connection, which is the accounts builder's).
insert into servicing.lms_connections (lender_org_id, kind, status, capabilities) values
  ('ecb00000-0000-4000-8000-000000000001', 'file_import', 'active', '{}'),
  ('ecb00000-0000-4000-8000-000000000002', 'file_import', 'active', '{}'),
  ('ecb00000-0000-4000-8000-000000000003', 'file_import', 'active', '{}');

-- Products, requests and applications: n = 1..30 lender X, 31..32 lender Y, 33..34 lender Z. Borrower b1 owns the odd ones, b2 the even ones.
insert into lending.loan_products (id, lender_org_id, category_key, code, name, status) values
  ('ec900000-0000-4000-8000-000000000001', 'ecb00000-0000-4000-8000-000000000001', 'personal', 'PL-EC', 'X Personal Loan', 'active'),
  ('ec900000-0000-4000-8000-000000000002', 'ecb00000-0000-4000-8000-000000000002', 'personal', 'PL-EC', 'Y Personal Loan', 'active'),
  ('ec900000-0000-4000-8000-000000000003', 'ecb00000-0000-4000-8000-000000000003', 'personal', 'PL-EC', 'Z Personal Loan', 'active');
insert into lending.loan_product_versions (id, product_id, lender_org_id, version, status, min_amount_minor, max_amount_minor,
  min_tenure_days, max_tenure_days, rate_type, min_annual_rate_bps, max_annual_rate_bps, drafted_by, approved_by, approved_at, effective_from)
select ('ec910000-0000-4000-8000-00000000000' || n)::uuid, ('ec900000-0000-4000-8000-00000000000' || n)::uuid, ('ecb00000-0000-4000-8000-00000000000' || n)::uuid, 1, 'approved',
       1000000, 50000000, 180, 1825, 'fixed', 1400, 2400, 'ec000000-0000-4000-8000-000000000009', 'ec000000-0000-4000-8000-000000000010', now(), now()
from generate_series(1, 3) n;
insert into lending.loan_requests (id, borrower_id, category_key, requested_amount_minor, requested_tenure_days, purpose_code, status)
select ('ec700000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
       (select id from identity.borrowers where user_id = (case when n % 2 = 1 then 'ec000000-0000-4000-8000-000000000005' else 'ec000000-0000-4000-8000-000000000006' end)::uuid),
       'personal', 5000000, 365, 'education', 'submitted'
from generate_series(1, 34) n;
insert into lending.applications (id, lender_org_id, loan_request_id, borrower_id, product_version_id, status, requested_amount_minor, requested_tenure_days, lender_reference)
select ('ec200000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
       ('ecb00000-0000-4000-8000-00000000000' || case when n <= 30 then 1 when n <= 32 then 2 else 3 end)::uuid,
       ('ec700000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
       (select id from identity.borrowers where user_id = (case when n % 2 = 1 then 'ec000000-0000-4000-8000-000000000005' else 'ec000000-0000-4000-8000-000000000006' end)::uuid),
       ('ec910000-0000-4000-8000-00000000000' || case when n <= 30 then 1 when n <= 32 then 2 else 3 end)::uuid,
       'disbursement_pending', 5000000, 365, 'SAMPLE-APP-' || n
from generate_series(1, 34) n;
-- Loans of the document sections are inserted directly (the owner stands in for an import): DL-11 to DL-30 (lender X), DL-33 (lender Z).
insert into servicing.loan_accounts (lender_org_id, application_id, borrower_id, source_system, lms_loan_ref, sanctioned_amount_minor)
select a.lender_org_id, a.id, a.borrower_id, 'lender_lms', 'DL-' || right(a.id::text, 2)::int, 5000000
from lending.applications a where right(a.id::text, 2)::int between 11 and 30 or right(a.id::text, 2)::int = 33;

select pg_temp.keep('b1', (select id::text from identity.borrowers where user_id = 'ec000000-0000-4000-8000-000000000005'));
select pg_temp.keep('b2', (select id::text from identity.borrowers where user_id = 'ec000000-0000-4000-8000-000000000006'));

-- ============================================================================================================================
-- 1. Structure: the objects of the migration, and the grants that create-or-replace must have kept
-- ============================================================================================================================
select pg_temp.as_owner();
select is((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'private' and p.proname in ('servicing_ascii_digits', 'servicing_text_safe', 'servicing_reject_unsafe_text', 'servicing_ref_looks_personal',
                                                         'servicing_receipt_reversed_minor', 'servicing_receipt_is_reversed')), 6::bigint,
  'the six helpers of the migration exist');
select ok((select bool_and(not has_function_privilege('anon', f, 'execute') and not has_function_privilege('public', f, 'execute'))
           from unnest(array['private.servicing_ascii_digits(text)', 'private.servicing_text_safe(text)', 'private.servicing_reject_unsafe_text()',
                             'private.servicing_ref_looks_personal(text, text)', 'private.servicing_receipt_reversed_minor(uuid)', 'private.servicing_receipt_is_reversed(uuid)',
                             'private.servicing_apply_one(uuid, text, jsonb, text, servicing.source_system, uuid, boolean)']) f),
  'neither anon nor PUBLIC can execute any helper');
select ok(has_function_privilege('authenticated', 'private.servicing_text_safe(text)', 'execute') and has_function_privilege('service_role', 'private.servicing_text_safe(text)', 'execute')
          and has_function_privilege('authenticated', 'private.servicing_ascii_digits(text)', 'execute') and has_function_privilege('service_role', 'private.servicing_ascii_digits(text)', 'execute'),
  'the text screen stays executable for the roles whose writes evaluate the table checks that call it');
select ok((select bool_and(has_function_privilege('authenticated', f, 'execute') and not has_function_privilege('anon', f, 'execute') and not has_function_privilege('public', f, 'execute'))
           from unnest(array[
             'servicing.stage_import(uuid, text, text, text, bigint, text, jsonb, text, uuid)', 'servicing.reject_import(uuid, text)', 'servicing.resolve_sync_conflict(uuid, text, text, jsonb)',
             'servicing.request_document(uuid, text, text, date, date)', 'servicing.decline_document_request(uuid, text)', 'servicing.confirm_security_release(uuid, text)',
             'servicing.set_security_release_delay_reason(uuid, text)',
             'servicing.register_loan_document(uuid, text, text, text, bigint, text, text, timestamptz, date, date, uuid, uuid, text)',
             'servicing.record_foreclosure_quote(uuid, text, timestamptz, timestamptz, text, text, text, text, text, text, uuid, uuid)', 'servicing.latest_valid_quote(uuid)']) f)
          and has_function_privilege('service_role', 'servicing.register_loan_document(uuid, text, text, text, bigint, text, text, timestamptz, date, date, uuid, uuid, text)', 'execute')
          and has_function_privilege('service_role', 'servicing.record_foreclosure_quote(uuid, text, timestamptz, timestamptz, text, text, text, text, text, text, uuid, uuid)', 'execute')
          and has_function_privilege('service_role', 'servicing.latest_valid_quote(uuid)', 'execute')
          and not has_function_privilege('service_role', 'servicing.stage_import(uuid, text, text, text, bigint, text, jsonb, text, uuid)', 'execute')
          and not has_function_privilege('service_role', 'servicing.confirm_security_release(uuid, text)', 'execute'),
  'the redefined functions keep their grants: people and the system exactly as before, never anon or PUBLIC');
select ok(has_function_privilege('service_role', 'servicing.apply_lms_report(uuid, jsonb, uuid)', 'execute') and not has_function_privilege('authenticated', 'servicing.apply_lms_report(uuid, jsonb, uuid)', 'execute')
          and not has_function_privilege('anon', 'servicing.apply_lms_report(uuid, jsonb, uuid)', 'execute'), 'apply_lms_report stays executable by the system role only');
select is((select c.reloptions from pg_class c where c.oid = 'servicing.lms_receipts_net'::regclass), array['security_invoker=true'], 'the net-receipts view runs with the caller''s rights (row level security applies)');
select ok(has_table_privilege('authenticated', 'servicing.lms_receipts_net', 'select') and has_table_privilege('service_role', 'servicing.lms_receipts_net', 'select')
          and not has_table_privilege('anon', 'servicing.lms_receipts_net', 'select') and not has_table_privilege('authenticated', 'servicing.lms_receipts_net', 'insert'),
  'it is readable by people and the system, not by anon, and not writable');
select is((select count(*) from pg_trigger t where t.tgrelid in ('servicing.import_batches'::regclass, 'servicing.sync_conflicts'::regclass) and t.tgname = 'unsafe_text' and not t.tgisinternal), 2::bigint,
  'the two lender-typed columns that had no screening (reject reason, resolution note) now have an unsafe-text trigger');
select is((select convalidated from pg_constraint where conname = 'validity_bound' and conrelid = 'servicing.foreclosure_quotes'::regclass), false,
  'the quotation validity bound is a NOT VALID check: it governs every new row and does not re-check history');
select ok((select pg_get_indexdef('servicing.import_batches_live_file'::regclass) !~ 'invalid' and pg_get_indexdef('servicing.import_batches_live_file'::regclass) ~ 'committed'),
  'the live-file index no longer covers invalid batches');
select ok((select pg_get_constraintdef(c.oid) like '%ref_looks_personal%' and pg_get_constraintdef(c.oid) like '%receipt_date_in_future%'
           from pg_constraint c where c.conname = 'import_rows_error_codes_check' and c.conrelid = 'servicing.import_rows'::regclass),
  'a stored import row may carry the two new error codes');

-- ============================================================================================================================
-- 2. Free-text screen (A3, U39, U40, U58): the shared function, then every lender-typed route
-- ============================================================================================================================
select is(private.servicing_text_safe('Aadhaar 1234 5678 9012 on file'), false, 'a spaced 12-digit number (an Aadhaar) is refused');
select is(private.servicing_text_safe('Please call 98765 43210 about this'), false, 'a spaced mobile number is refused');
select is(private.servicing_text_safe('Phone +91 98765-43210 please'), false, 'a mobile number with a country code and a hyphen is refused');
select is(private.servicing_text_safe('Her pan is abcde1234f'), false, 'a lower-case PAN is refused');
select is(private.servicing_text_safe('Her pan is abcde 1234 f'), false, 'and one written with spaces');
select is(private.servicing_text_safe('Her PAN is ABCDE1234F'), false, 'an upper-case PAN stays refused');
select is(private.servicing_text_safe('See https://evil.example/pay now'), false, 'a link with a scheme is refused');
select is(private.servicing_text_safe('Pay at bit.ly/x7Kq2 today'), false, 'a short link without a scheme is refused');
select is(private.servicing_text_safe('Pay at udofin.in/pay today'), false, 'a domain-like token is refused');
select is(private.servicing_text_safe('Mail someone@example.com'), false, 'an e-mail address stays refused');
select is(private.servicing_text_safe('Number ' || convert_from('\xe0a5afe0a5aee0a5ade0a5ace0a5abe0a5aae0a5abe0a5ace0a5aae0a5a6', 'UTF8')), false, 'a ten-digit number written in Devanagari digits is a number');
select is(private.servicing_text_safe('Reference 12345678 pending'), false, 'eight digits in a row stay refused');
select is(private.servicing_text_safe('Waiting for the depository to act'), true, 'an ordinary sentence is accepted');
select is(private.servicing_text_safe('Closed on 12 Oct 2026, release expected by 20 Oct 2026'), true, 'dates written with the month in letters are accepted');
select is(private.servicing_text_safe('Rs 4,750.00 is due on 17 Oct 2026. Please wait.'), true, 'an amount and a sentence end are accepted');
select is(private.servicing_text_safe(null), true, 'a null has nothing to refuse');

-- 2a. The decline note of a document request (borrower b1 asks for a statement; the lender declines).
select pg_temp.as_user('ec000000-0000-4000-8000-000000000005');
select pg_temp.keep('rq_decl', servicing.request_document(pg_temp.lid('DL-11'), 'statement', 'ec-req-key-0001')::text);
select pg_temp.keep('rq_chk', servicing.request_document(pg_temp.lid('DL-13'), 'statement', 'ec-req-key-0002')::text);
select pg_temp.as_user('ec000000-0000-4000-8000-000000000001');
select is(pg_temp.err(format($$select servicing.decline_document_request(%L, 'Aadhaar 1234 5678 9012 on file')$$, pg_temp.got('rq_decl'))), '22023|note_invalid', 'decline note: a spaced Aadhaar number is refused');
select is(pg_temp.err(format($$select servicing.decline_document_request(%L, 'Please call 98765 43210 about this')$$, pg_temp.got('rq_decl'))), '22023|note_invalid', 'decline note: a spaced mobile number is refused');
select is(pg_temp.err(format($$select servicing.decline_document_request(%L, 'Phone +91 98765-43210 please')$$, pg_temp.got('rq_decl'))), '22023|note_invalid', 'decline note: a mobile number with country code and hyphen is refused');
select is(pg_temp.err(format($$select servicing.decline_document_request(%L, 'Her pan is abcde1234f here')$$, pg_temp.got('rq_decl'))), '22023|note_invalid', 'decline note: a lower-case PAN is refused');
select is((select array_agg(v) from unnest(array['See https://evil.example/pay now', 'Pay at bit.ly/x7Kq2 today', 'Mail someone@example.com please',
             'Number ' || convert_from('\xe0a5afe0a5aee0a5ade0a5ace0a5abe0a5aae0a5abe0a5ace0a5aae0a5a6', 'UTF8') || ' given']) v
           where pg_temp.err(format($$select servicing.decline_document_request(%L, %L)$$, pg_temp.got('rq_decl'), v)) <> '22023|note_invalid'), null,
  'decline note: a link, a short link, an e-mail address and Devanagari digits are all refused');
select is(pg_temp.err(format($$select servicing.decline_document_request(%L, 'The period requested is not yet closed')$$, pg_temp.got('rq_decl'))), 'ok', 'decline note: an ordinary reason is accepted');
select is((select status from servicing.document_requests where id = pg_temp.got('rq_decl')::uuid), 'declined', 'and the request is declined');

-- 2b. The delay reason of a security-release task (the loan DL-12 is reported closed; the lender reports a collateral type).
select pg_temp.as_owner();
update servicing.loan_accounts set status = 'closed' where lms_loan_ref = 'DL-12';
select pg_temp.as_user('ec000000-0000-4000-8000-000000000001');
select is(servicing.open_security_release_tasks(pg_temp.lid('DL-12'), array['other']), 1, 'a release task is opened for the closed loan');
select pg_temp.keep('task1', (select id::text from servicing.security_release_tasks where loan_account_id = pg_temp.lid('DL-12')));
select is(pg_temp.err(format($$select servicing.set_security_release_delay_reason(%L, 'Aadhaar 1234 5678 9012 on file')$$, pg_temp.got('task1'))), '22023|reason_invalid', 'delay reason: a spaced Aadhaar number is refused');
select is(pg_temp.err(format($$select servicing.set_security_release_delay_reason(%L, 'Please call 98765 43210 about this')$$, pg_temp.got('task1'))), '22023|reason_invalid', 'delay reason: a spaced mobile number is refused');
select is(pg_temp.err(format($$select servicing.set_security_release_delay_reason(%L, 'Phone +91 98765-43210 please')$$, pg_temp.got('task1'))), '22023|reason_invalid', 'delay reason: a mobile number with country code and hyphen is refused');
select is(pg_temp.err(format($$select servicing.set_security_release_delay_reason(%L, 'Her pan is abcde1234f here')$$, pg_temp.got('task1'))), '22023|reason_invalid', 'delay reason: a lower-case PAN is refused');
select is((select array_agg(v) from unnest(array['See https://evil.example/pay now', 'Pay at bit.ly/x7Kq2 today', 'Mail someone@example.com please',
             'Number ' || convert_from('\xe0a5afe0a5aee0a5ade0a5ace0a5abe0a5aae0a5abe0a5ace0a5aae0a5a6', 'UTF8') || ' given']) v
           where pg_temp.err(format($$select servicing.set_security_release_delay_reason(%L, %L)$$, pg_temp.got('task1'), v)) <> '22023|reason_invalid'), null,
  'delay reason: a link, a short link, an e-mail address and Devanagari digits are all refused');
select is(pg_temp.err(format($$select servicing.set_security_release_delay_reason(%L, 'Waiting for the depository to act')$$, pg_temp.got('task1'))), 'ok', 'delay reason: an ordinary reason is accepted');

-- 2c. The reject reason of an import batch (U40, U58): a previewed loan file is rejected.
select pg_temp.keep('rj', pg_temp.stage('ecb00000-0000-4000-8000-000000000001', 'loan', 'rej-text', jsonb_build_array(
  pg_temp.loan('LXR', 'SAMPLE-APP-8', 'SRC-LXR-1', 3, '{"sequence":"1"}')))::text);
select is((pg_temp.got('rj')::jsonb) ->> 'status', 'previewed', 'a clean file is previewed');
select pg_temp.keep('rj_id', (pg_temp.got('rj')::jsonb) ->> 'batch_id');
select is(pg_temp.err(format($$select servicing.reject_import(%L, 'Row for Aadhaar 1234 5678 9012 is wrong')$$, pg_temp.got('rj_id'))), '22023|reason_invalid', 'reject reason: a spaced Aadhaar number is refused');
select is(pg_temp.err(format($$select servicing.reject_import(%L, 'Row for 98765 43210 is wrong')$$, pg_temp.got('rj_id'))), '22023|reason_invalid', 'reject reason: a spaced mobile number is refused');
select is(pg_temp.err(format($$select servicing.reject_import(%L, 'Row for +91 98765-43210 is wrong')$$, pg_temp.got('rj_id'))), '22023|reason_invalid', 'reject reason: a mobile number with country code and hyphen is refused');
select is(pg_temp.err(format($$select servicing.reject_import(%L, 'Row for abcde1234f is wrong')$$, pg_temp.got('rj_id'))), '22023|reason_invalid', 'reject reason: a lower-case PAN is refused');
select is((select array_agg(v) from unnest(array['Row is wrong, see https://evil.example/x', 'Row is wrong, see bit.ly/x7Kq2', 'Row is wrong, mail someone@example.com',
             'Row is wrong ' || convert_from('\xe0a5afe0a5aee0a5ade0a5ace0a5abe0a5aae0a5abe0a5ace0a5aae0a5a6', 'UTF8')]) v
           where pg_temp.err(format($$select servicing.reject_import(%L, %L)$$, pg_temp.got('rj_id'), v)) <> '22023|reason_invalid'), null,
  'reject reason: a link, a short link, an e-mail address and Devanagari digits are all refused');
select is((select status from servicing.import_batches where id = pg_temp.got('rj_id')::uuid), 'previewed', 'and the batch is still previewed after every refusal');
select is(pg_temp.err(format($$select servicing.reject_import(%L, 'The reporting period in the file is wrong')$$, pg_temp.got('rj_id'))), 'ok', 'reject reason: an ordinary reason is accepted');
select is((select status from servicing.import_batches where id = pg_temp.got('rj_id')::uuid), 'rejected', 'and the batch is rejected');

-- 2d. The resolution note of a sync conflict (U40, A3): loan LXC gets a report, then a different report for the same record at the same time.
select pg_temp.keep('lxc1', pg_temp.imp('ecb00000-0000-4000-8000-000000000001', 'loan', 'lxc-1', jsonb_build_array(
  pg_temp.loan('LXC', 'SAMPLE-APP-7', 'SRC-LXC-1', 4, '{"sequence":"1"}')))::text);
select pg_temp.keep('lxc_v1', (select to_char(reported_as_of at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') from servicing.balance_snapshots where loan_account_id = pg_temp.lid('LXC') and version = 1));
select pg_temp.keep('lxc2', pg_temp.imp('ecb00000-0000-4000-8000-000000000001', 'loan', 'lxc-2', jsonb_build_array(
  pg_temp.loan('LXC', 'SAMPLE-APP-7', 'SRC-LXC-1', 4, jsonb_build_object('sequence', '1', 'outstanding_principal', '39999.00', 'reported_as_of', pg_temp.got('lxc_v1')))))::text);
select pg_temp.keep('cf_text', (select id::text from servicing.sync_conflicts where loan_account_id = pg_temp.lid('LXC')));
select is((select count(*) from servicing.sync_conflicts where loan_account_id = pg_temp.lid('LXC')), 1::bigint, 'the disagreeing report is queued as one conflict');
select pg_temp.as_user('ec000000-0000-4000-8000-000000000002');
select is(pg_temp.err(format($$select servicing.acknowledge_sync_conflict(%L)$$, pg_temp.got('cf_text'))), 'ok', 'a servicing.sync.manage holder acknowledges it');
select is(pg_temp.err(format($$select servicing.resolve_sync_conflict(%L, 'existing', 'Aadhaar 1234 5678 9012 was quoted', '{"lender_ticket":"SAMPLE-T-1"}')$$, pg_temp.got('cf_text'))), '22023|reason_invalid', 'resolution note: a spaced Aadhaar number is refused');
select is(pg_temp.err(format($$select servicing.resolve_sync_conflict(%L, 'existing', 'Borrower phone 98765 43210 was quoted', '{"lender_ticket":"SAMPLE-T-1"}')$$, pg_temp.got('cf_text'))), '22023|reason_invalid', 'resolution note: a spaced mobile number is refused');
select is(pg_temp.err(format($$select servicing.resolve_sync_conflict(%L, 'existing', 'Borrower phone +91 98765-43210 was quoted', '{"lender_ticket":"SAMPLE-T-1"}')$$, pg_temp.got('cf_text'))), '22023|reason_invalid', 'resolution note: a mobile number with country code and hyphen is refused');
select is(pg_temp.err(format($$select servicing.resolve_sync_conflict(%L, 'existing', 'Her pan is abcde1234f here', '{"lender_ticket":"SAMPLE-T-1"}')$$, pg_temp.got('cf_text'))), '22023|reason_invalid', 'resolution note: a lower-case PAN is refused');
select is((select array_agg(v) from unnest(array['Confirmed, see https://evil.example/x', 'Confirmed, see bit.ly/x7Kq2', 'Confirmed, mail someone@example.com',
             'Confirmed ' || convert_from('\xe0a5afe0a5aee0a5ade0a5ace0a5abe0a5aae0a5abe0a5ace0a5aae0a5a6', 'UTF8')]) v
           where pg_temp.err(format($$select servicing.resolve_sync_conflict(%L, 'existing', %L, '{"lender_ticket":"SAMPLE-T-1"}')$$, pg_temp.got('cf_text'), v)) <> '22023|reason_invalid'), null,
  'resolution note: a link, a short link, an e-mail address and Devanagari digits are all refused');
select is((select status from servicing.sync_conflicts where id = pg_temp.got('cf_text')::uuid), 'acknowledged', 'and the conflict is still acknowledged after every refusal');
select is(pg_temp.err(format($$select servicing.resolve_sync_conflict(%L, 'existing', 'The lender confirmed the stored figure by ticket', '{"lender_ticket":"SAMPLE-T-1"}')$$, pg_temp.got('cf_text'))), 'ok',
  'resolution note: an ordinary note is accepted (confirming the existing version needs nothing else)');

-- 2e. The tables themselves: the two new triggers (U40, U42) and the existing checks that call the screen (A3).
select pg_temp.as_owner();
select is(pg_temp.err($$insert into servicing.import_batches (reject_reason) values ('Row for ABCDE1234F is wrong')$$), '22023|unsafe_free_text', 'import_batches.reject_reason: the trigger refuses a PAN even from the table owner');
select is(pg_temp.err($$insert into servicing.import_batches (reject_reason) values ('Row for 98765 43210 is wrong')$$), '22023|unsafe_free_text', 'and a spaced mobile number');
select is(pg_temp.st($$insert into servicing.import_batches (reject_reason) values ('An ordinary reason for the table')$$), '23502', 'while an ordinary text gets past the trigger and meets the next constraint (not null)');
select is(pg_temp.err($$insert into servicing.sync_conflicts (resolution_note) values ('Borrower phone 98765 43210 was quoted')$$), '22023|unsafe_free_text', 'sync_conflicts.resolution_note: the trigger refuses a spaced mobile number');
select is(pg_temp.err($$insert into servicing.sync_conflicts (resolution_note) values ('Her pan is abcde1234f here')$$), '22023|unsafe_free_text', 'and a lower-case PAN');
select is(pg_temp.st($$insert into servicing.sync_conflicts (resolution_note) values ('An ordinary note for the table')$$), '23502', 'while an ordinary text meets the next constraint (not null)');
select is(pg_temp.st(format($$update servicing.document_requests set status = 'declined', lender_note = 'Call 98765 43210 now please', decided_by = 'ec000000-0000-4000-8000-000000000001', decided_at = now() where id = %L$$, pg_temp.got('rq_chk'))), '23514',
  'document_requests.lender_note: the table check uses the new screen (a spaced mobile number is refused even from the owner)');
select is(pg_temp.st(format($$update servicing.security_release_tasks set delay_reason = 'Her pan is abcde1234f here', delay_reason_by = 'ec000000-0000-4000-8000-000000000001', delay_reason_at = now() where id = %L$$, pg_temp.got('task1'))), '23514',
  'security_release_tasks.delay_reason: the table check uses the new screen (a lower-case PAN is refused even from the owner)');

-- ============================================================================================================================
-- 3. References that look personal (M13, U38) and a receipt dated in the future (M17)
-- ============================================================================================================================
select pg_temp.as_owner();
-- M13: the borrower reference is tested as a whole, so a reference that merely CONTAINS a PAN-like run is no longer taken for a PAN.
select is(pg_temp.codes('loan', pg_temp.loan('L1', 'abcde123-4f00-4000-8000-000000000001', 'S1', 1)), '/', 'a UUID that happens to read like a PAN inside (abcde123-4f00...) is a valid borrower reference');
select is(pg_temp.codes('loan', pg_temp.loan('L1', 'ABCDE123-4F00-4000-8000-000000000001', 'S1', 1)), '/', 'in upper case too');
select is(pg_temp.codes('loan', pg_temp.loan('L1', 'LOANX2026B7', 'S1', 1)), '/', 'a lender reference with a PAN-like run and more after it (LOANX2026B7) is valid');
select is((select count(*) from generate_series(1, 3000) g
           where private.servicing_validate('loan', pg_temp.loan('L1', private.uuid_v7()::text, 'S1', 1)) -> 'codes' @> '["borrower_ref_looks_personal"]'::jsonb), 0::bigint,
  'none of 3000 generated Udofin application ids is refused as personal (about 0.5 percent were before)');
select is(pg_temp.codes('loan', pg_temp.loan('L1', 'ABCDE1234F', 'S1', 1)), 'borrower_ref_looks_personal/borrower_ref', 'a PAN as the whole borrower reference is refused');
select is(pg_temp.codes('loan', pg_temp.loan('L1', 'abcde1234f', 'S1', 1)), 'borrower_ref_looks_personal/borrower_ref', 'in lower case too');
select is(pg_temp.codes('loan', pg_temp.loan('L1', 'PAN-ABCDE1234F', 'S1', 1)), 'borrower_ref_looks_personal/borrower_ref', 'a PAN as one part of the reference is refused');
select is(pg_temp.codes('loan', pg_temp.loan('L1', 'ABCDE-1234-F', 'S1', 1)), 'borrower_ref_looks_personal/borrower_ref', 'a PAN written with separators is refused');
select is(pg_temp.codes('loan', pg_temp.loan('L1', '9876543210', 'S1', 1)), 'borrower_ref_looks_personal/borrower_ref', 'a mobile number is refused');
select is(pg_temp.codes('loan', pg_temp.loan('L1', '98765-43210', 'S1', 1)), 'borrower_ref_looks_personal/borrower_ref', 'a mobile number with a separator is refused');
select is(pg_temp.codes('loan', pg_temp.loan('L1', '123456789012', 'S1', 1)), 'borrower_ref_looks_personal/borrower_ref', 'a 12-digit number (an Aadhaar, an account number) is refused');
select is(pg_temp.codes('loan', pg_temp.loan('L1', 'SAMPLE-APP-1234', 'S1', 1)), '/', 'an ordinary reference with digits in it is valid');

-- U38: the other references of the import format get the PAN-shape test, and the fields that can carry a phone or an account number their own.
select is(pg_temp.codes('loan', pg_temp.loan('ABCDE1234F', 'A1', 'S1', 1, '{"disbursement_ref":"SAMPLE-DISB-1"}')), 'ref_looks_personal/lms_loan_ref', 'a PAN as the lender''s loan reference is refused');
select is(pg_temp.codes('loan', pg_temp.loan('L1', 'A1', 'abcde1234f', 1)), 'ref_looks_personal/source_record_id', 'a PAN as a source record id is refused (lower case too)');
select is(pg_temp.codes('loan', pg_temp.loan('L1', 'A1', 'S1', 1, '{"disbursement_ref":"ABCDE1234F"}')), 'ref_looks_personal/disbursement_ref', 'a PAN as a disbursement reference is refused');
select is(pg_temp.codes('loan', pg_temp.loan('9876543210', 'A1', 'S1', 1)), '/', 'a numeric loan number is a valid loan reference (lenders number loans that way)');
select is(pg_temp.codes('receipt', pg_temp.receipt('L1', 'ABCDE1234F', '10.00', 1, '{"bank_reference":"BANKREF-1","source_record_id":"SRC-1"}')), 'ref_looks_personal/lms_receipt_ref', 'a PAN as a receipt reference is refused');
select is(pg_temp.codes('receipt', pg_temp.receipt('L1', 'R2', '10.00', 1, '{"receipt_kind":"reversal","reverses_receipt_ref":"ABCDE1234F"}')), 'ref_looks_personal/reverses_receipt_ref', 'a PAN as the reference of the receipt reversed is refused');
select is(pg_temp.codes('receipt', pg_temp.receipt('L1', 'R1', '10.00', 1, '{"payment_mode":"9876543210"}')), 'ref_looks_personal/payment_mode', 'a mobile number as the payment mode is refused');
select is(pg_temp.codes('receipt', pg_temp.receipt('L1', 'R1', '10.00', 1, '{"payment_mode":"UPI/9876543210"}')), 'ref_looks_personal/payment_mode', 'also behind a mode name');
select is(pg_temp.codes('receipt', pg_temp.receipt('L1', 'R1', '10.00', 1, '{"payment_mode":"NEFT"}')), '/', 'a payment mode that is a name is valid');
select is(pg_temp.codes('receipt', pg_temp.receipt('L1', 'R1', '10.00', 1, '{"bank_reference":"ABCDE1234F"}')), 'ref_looks_personal/bank_reference', 'a PAN as the bank reference is refused');
select is(pg_temp.codes('receipt', pg_temp.receipt('L1', 'R1', '10.00', 1, '{"bank_reference":"9876543210"}')), 'ref_looks_personal/bank_reference', 'a 10-digit mobile number as the bank reference is refused');
select is(pg_temp.codes('receipt', pg_temp.receipt('L1', 'R1', '10.00', 1, '{"bank_reference":"12345678901234"}')), 'ref_looks_personal/bank_reference', 'a 14-digit number (an account number) as the bank reference is refused');
select is(pg_temp.codes('receipt', pg_temp.receipt('L1', 'R1', '10.00', 1, '{"bank_reference":"512345678901"}')), '/', 'a 12-digit UPI RRN is a valid bank reference');
select is(pg_temp.codes('receipt', pg_temp.receipt('L1', 'R1', '10.00', 1, '{"bank_reference":"SBIN425012345678"}')), '/', 'so is an alphanumeric UTR');
select is(pg_temp.codes('schedule', pg_temp.sched('ABCDE1234F', 'S1', 1)), 'ref_looks_personal/lms_loan_ref', 'the schedule head follows the same rule');

-- M17: a receipt cannot be dated after the day (India time) of the report that carries it.
select is(pg_temp.codes('receipt', pg_temp.receipt('L1', 'R1', '10.00', 1, jsonb_build_object('value_date', to_char((now() at time zone 'Asia/Kolkata')::date + 1, 'YYYY-MM-DD')))),
  'receipt_date_in_future/value_date', 'a value date after the day of the report is an error');
select is(pg_temp.codes('receipt', pg_temp.receipt('L1', 'R1', '10.00', 1, '{"value_date":"2099-01-01"}')), 'receipt_date_in_future/value_date', 'a value date in 2099 is an error (it would silence a loan''s reminders for decades)');
select is(pg_temp.codes('receipt', pg_temp.receipt('L1', 'R1', '10.00', 1, jsonb_build_object('value_date', to_char((now() at time zone 'Asia/Kolkata')::date, 'YYYY-MM-DD')))), '/', 'a value date on the day of the report is valid');
select is(pg_temp.codes('receipt', pg_temp.receipt('L1', 'R1', '10.00', 1, '{"value_date":"2026-01-05"}')), '/', 'and an earlier one');
select is(pg_temp.codes('receipt', pg_temp.receipt('L1', 'R1', '10.00', 60, jsonb_build_object('value_date', to_char((now() at time zone 'Asia/Kolkata')::date - 1, 'YYYY-MM-DD')))),
  'receipt_date_in_future/value_date', 'a late-arriving report cannot carry a value date after its own report day (a 60 hours old report, yesterday''s value date)');

-- ============================================================================================================================
-- 4. The import pipeline: an invalid batch releases its hash (A4) and guards that no test exercised (M20 a, b, c)
-- ============================================================================================================================
select pg_temp.as_user('ec000000-0000-4000-8000-000000000001');
-- Six loans of lender X that the later sections work on (one file, one commit).
select pg_temp.keep('six', pg_temp.imp('ecb00000-0000-4000-8000-000000000001', 'loan', 'six-loans', jsonb_build_array(
  pg_temp.loan('LX1', 'SAMPLE-APP-1', 'SRC-LX1-1', 6, '{"sequence":"1"}'), pg_temp.loan('LX2', 'SAMPLE-APP-2', 'SRC-LX2-1', 6, '{"sequence":"1"}'),
  pg_temp.loan('LX3', 'SAMPLE-APP-3', 'SRC-LX3-1', 6, '{"sequence":"1"}'), pg_temp.loan('LX4', 'SAMPLE-APP-4', 'SRC-LX4-1', 6, '{"sequence":"1"}'),
  pg_temp.loan('LX5', 'SAMPLE-APP-5', 'SRC-LX5-1', 6, '{"sequence":"1"}'), pg_temp.loan('LX6', 'SAMPLE-APP-6', 'SRC-LX6-1', 6, '{"sequence":"1"}')))::text);
select is((pg_temp.got('six')::jsonb) ->> 'status', 'committed', 'six loans are imported');

-- 4a. A4: a receipts file staged BEFORE its loan is invalid (unknown_loan); once the loan exists, the same bytes can be staged again.
select pg_temp.keep('a4_rows', jsonb_build_array(pg_temp.receipt('LATE', 'RC-A4', '10.00', 1))::text);
select pg_temp.keep('a4_1', pg_temp.stage('ecb00000-0000-4000-8000-000000000001', 'receipt', 'a4-rcpt', pg_temp.got('a4_rows')::jsonb)::text);
select is((pg_temp.got('a4_1')::jsonb) ->> 'status', 'invalid', 'a receipts file staged before its loan is invalid');
select is(pg_temp.errs(pg_temp.got('a4_1')::jsonb), '1:unknown_loan@', 'with the verdict unknown_loan');
select is(pg_temp.err(format($$select servicing.commit_import(%L)$$, (pg_temp.got('a4_1')::jsonb) ->> 'batch_id')), '55000|import_has_errors', 'and it cannot be committed');
select pg_temp.keep('late', pg_temp.imp('ecb00000-0000-4000-8000-000000000001', 'loan', 'a4-loan', jsonb_build_array(
  pg_temp.loan('LATE', 'SAMPLE-APP-9', 'SRC-LATE-1', 5, '{"sequence":"1"}')))::text);
select is((pg_temp.got('late')::jsonb) ->> 'status', 'committed', 'the loan arrives');
select is(((pg_temp.stage('ecb00000-0000-4000-8000-000000000001', 'receipt', 'a4-rcpt', pg_temp.got('a4_rows')::jsonb))::jsonb) ->> 'batch_id', (pg_temp.got('a4_1')::jsonb) ->> 'batch_id',
  'staging with the SAME idempotency key is a replay: the original (invalid) batch comes back');
select pg_temp.keep('a4_2', servicing.stage_import('ecb00000-0000-4000-8000-000000000001', 'receipt', 'file', pg_temp.sha('a4-rcpt'), 1000, 'udofin-lms-import-v1',
  pg_temp.got('a4_rows')::jsonb, 'idem-a4-newkey-0001', null)::text);
select is((pg_temp.got('a4_2')::jsonb) ->> 'existing', 'false', 'the same bytes under a NEW idempotency key are a new batch: the invalid one no longer holds the hash');
select is((pg_temp.got('a4_2')::jsonb) ->> 'status', 'previewed', 'and are classified afresh: the loan exists now, so the file is previewed');
select isnt((pg_temp.got('a4_2')::jsonb) ->> 'batch_id', (pg_temp.got('a4_1')::jsonb) ->> 'batch_id', 'under its own batch id');
select is((select count(*) from servicing.import_batches where lender_org_id = 'ecb00000-0000-4000-8000-000000000001' and file_sha256 = pg_temp.sha('a4-rcpt')), 2::bigint, 'both batches are kept (history is never deleted)');
select is(servicing.commit_import(((pg_temp.got('a4_2')::jsonb) ->> 'batch_id')::uuid) ->> 'status', 'committed', 'the corrected situation commits');
select is((select count(*) from servicing.lms_receipts where lms_receipt_ref = 'RC-A4'), 1::bigint, 'and the receipt is stored');
select is(((pg_temp.stage('ecb00000-0000-4000-8000-000000000001', 'receipt', 'a4-rcpt', pg_temp.got('a4_rows')::jsonb))::jsonb) ->> 'status', 'invalid',
  'replaying the first key still returns the first answer (an idempotent replay never recomputes)');

-- 4b. M20 (a): rejecting an import needs the second factor.
select pg_temp.keep('aal', pg_temp.stage('ecb00000-0000-4000-8000-000000000001', 'receipt', 'aal-rcpt', jsonb_build_array(pg_temp.receipt('LX1', 'RC-AAL', '10.00', 1)))::text);
select is((pg_temp.got('aal')::jsonb) ->> 'status', 'previewed', 'a clean receipts file is previewed');
select pg_temp.as_user('ec000000-0000-4000-8000-000000000001', 'aal1');
select is(pg_temp.err(format($$select servicing.reject_import(%L, 'The reporting period in the file is wrong')$$, (pg_temp.got('aal')::jsonb) ->> 'batch_id')), '42501|mfa_required',
  'a session without the second factor cannot reject an import');
select pg_temp.as_user('ec000000-0000-4000-8000-000000000001');
select is((select status from servicing.import_batches where id = ((pg_temp.got('aal')::jsonb) ->> 'batch_id')::uuid), 'previewed', 'and the batch is untouched');

-- 4c. M20 (b): a resubmission may only name an earlier batch of the SAME lender; another lender''s batch answers exactly like an unknown id (no existence oracle).
select pg_temp.as_user('ec000000-0000-4000-8000-000000000004');
select pg_temp.keep('ybad', servicing.stage_import('ecb00000-0000-4000-8000-000000000002', 'loan', 'file', pg_temp.sha('y-bad'), 1000, 'udofin-lms-import-v1', '[{}]', 'idem-y-bad-00000001', null)::text);
select is((pg_temp.got('ybad')::jsonb) ->> 'status', 'invalid', 'lender Y has an invalid batch of its own');
select pg_temp.keep('yprev', servicing.stage_import('ecb00000-0000-4000-8000-000000000002', 'loan', 'file', pg_temp.sha('y-prev'), 1000, 'udofin-lms-import-v1',
  jsonb_build_array(pg_temp.loan('LY1', 'SAMPLE-APP-31', 'SRC-LY1-1', 3, '{"sequence":"1"}')), 'idem-y-prev-0000001', null)::text);
select is((pg_temp.got('yprev')::jsonb) ->> 'status', 'previewed', 'and a previewed one');
select pg_temp.as_user('ec000000-0000-4000-8000-000000000001');
select is(pg_temp.err(format($$select servicing.stage_import('ecb00000-0000-4000-8000-000000000001', 'loan', 'file', %L, 1000, 'udofin-lms-import-v1', %L, 'idem-x-resub-000001', %L)$$,
  pg_temp.sha('x-resub-1'), jsonb_build_array(pg_temp.loan('LRS1', 'SAMPLE-APP-10', 'SRC-LRS1-1', 3)), (pg_temp.got('ybad')::jsonb) ->> 'batch_id')), '22023|resubmission_invalid',
  'lender X cannot name lender Y''s batch as the file it corrects');
select is(pg_temp.err(format($$select servicing.stage_import('ecb00000-0000-4000-8000-000000000001', 'loan', 'file', %L, 1000, 'udofin-lms-import-v1', %L, 'idem-x-resub-000002', %L)$$,
  pg_temp.sha('x-resub-2'), jsonb_build_array(pg_temp.loan('LRS1', 'SAMPLE-APP-10', 'SRC-LRS1-1', 3)), '00000000-0000-4000-8000-0000000000aa')), '22023|resubmission_invalid',
  'an unknown batch id answers the same way');
select is(pg_temp.err(format($$select servicing.stage_import('ecb00000-0000-4000-8000-000000000001', 'loan', 'file', %L, 1000, 'udofin-lms-import-v1', %L, 'idem-x-resub-000003', %L)$$,
  pg_temp.sha('x-resub-3'), jsonb_build_array(pg_temp.loan('LRS1', 'SAMPLE-APP-10', 'SRC-LRS1-1', 3)), (pg_temp.got('a4_2')::jsonb) ->> 'batch_id')), '22023|resubmission_invalid',
  'a batch of the same lender that is committed is no resubmission target either');
select is(pg_temp.err(format($$select servicing.stage_import('ecb00000-0000-4000-8000-000000000001', 'loan', 'file', %L, 1000, 'udofin-lms-import-v1', %L, 'idem-x-resub-000004', %L)$$,
  pg_temp.sha('x-resub-4'), jsonb_build_array(pg_temp.loan('LRS1', 'SAMPLE-APP-10', 'SRC-LRS1-1', 3)), (pg_temp.got('a4_1')::jsonb) ->> 'batch_id')), '22023|resubmission_invalid',
  'nor a batch of another kind (here a receipts batch named for a loan file)');
select is(((pg_temp.stage('ecb00000-0000-4000-8000-000000000001', 'receipt', 'resub-ok', jsonb_build_array(pg_temp.receipt('LX1', 'RC-RESUB', '10.00', 1)), ((pg_temp.got('a4_1')::jsonb) ->> 'batch_id')::uuid))::jsonb) ->> 'resubmission_of',
  (pg_temp.got('a4_1')::jsonb) ->> 'batch_id', 'while an earlier invalid batch of the same lender and kind is a valid target (the control for the refusals above)');

-- 4d. M20 (c): the connection is checked again at commit (it may have been paused between the preview and the commit).
select pg_temp.keep('paus', pg_temp.stage('ecb00000-0000-4000-8000-000000000001', 'receipt', 'paus-rcpt', jsonb_build_array(pg_temp.receipt('LX2', 'RC-PAUS', '10.00', 1)))::text);
select is((pg_temp.got('paus')::jsonb) ->> 'status', 'previewed', 'a receipts file is previewed');
select pg_temp.as_owner();
update servicing.lms_connections set status = 'paused' where lender_org_id = 'ecb00000-0000-4000-8000-000000000001';
select pg_temp.as_user('ec000000-0000-4000-8000-000000000001');
select is(pg_temp.err(format($$select servicing.commit_import(%L)$$, (pg_temp.got('paus')::jsonb) ->> 'batch_id')), '55000|connection_not_active', 'with the connection paused the commit is refused');
select is((select count(*) from servicing.lms_receipts where lms_receipt_ref = 'RC-PAUS'), 0::bigint, 'and nothing was applied');
select pg_temp.as_owner();
update servicing.lms_connections set status = 'active' where lender_org_id = 'ecb00000-0000-4000-8000-000000000001';
select pg_temp.as_user('ec000000-0000-4000-8000-000000000001');
select is(servicing.commit_import(((pg_temp.got('paus')::jsonb) ->> 'batch_id')::uuid) ->> 'status', 'committed', 'with the connection active again the same batch commits');

-- ============================================================================================================================
-- 5. The apply path: the system role cannot author file or manual-import records (M10), and the guards that no test exercised (M20 g)
-- ============================================================================================================================
select pg_temp.as_system();
select is(pg_temp.err(format($$select servicing.apply_lms_report('ecb00000-0000-4000-8000-000000000001', %L)$$,
  pg_temp.loan('LSYS', 'SAMPLE-APP-10', 'SRC-LSYS-1', 2, '{"report_type":"loan","source_system":"file_import","sequence":"1"}'))), '42501|source_system_invalid',
  'M10: the system role cannot apply a loan report labelled file_import, even for a lender with an active file connection');
select is(pg_temp.err(format($$select servicing.apply_lms_report('ecb00000-0000-4000-8000-000000000001', %L)$$,
  pg_temp.receipt('LX1', 'RC-SYS', '10.00', 1, '{"report_type":"receipt","source_system":"manual_import"}'))), '42501|source_system_invalid', 'nor a receipt labelled manual_import');
select is(pg_temp.err(format($$select servicing.apply_lms_report('ecb00000-0000-4000-8000-000000000001', %L)$$,
  pg_temp.sched('LX1', 'SRC-SCH-SYS', 1, '{"report_type":"schedule","source_system":"file_import"}'))), '42501|source_system_invalid', 'nor a schedule');
select pg_temp.as_owner();
select is((select count(*) from servicing.loan_accounts where lms_loan_ref = 'LSYS') + (select count(*) from servicing.lms_receipts where lms_receipt_ref = 'RC-SYS')
          + (select count(*) from servicing.schedule_snapshots where source_record_id = 'SRC-SCH-SYS'), 0::bigint, 'and nothing was written');
-- The private implementation refuses the same combinations whatever the entry point (the record, batch and person are what make a file import).
select pg_temp.keep('v_lsys', private.servicing_validate('loan', pg_temp.loan('LSYS', 'SAMPLE-APP-10', 'SRC-LSYS-1', 2, '{"sequence":"1"}'))::text);
select is(pg_temp.err(format($$select private.servicing_apply_one('ecb00000-0000-4000-8000-000000000001', 'loan', %L::jsonb -> 'canon', %L::jsonb ->> 'hash', 'file_import', %L, true)$$,
  pg_temp.got('v_lsys'), pg_temp.got('v_lsys'), (pg_temp.got('paus')::jsonb) ->> 'batch_id')), '42501|source_system_invalid',
  'M10: with a batch but no signed-in person (the system) a file-import record is refused');
select set_config('request.jwt.claims', json_build_object('sub', 'ec000000-0000-4000-8000-000000000001', 'role', 'authenticated', 'aal', 'aal2')::text, true);
select is(pg_temp.err(format($$select private.servicing_apply_one('ecb00000-0000-4000-8000-000000000001', 'loan', %L::jsonb -> 'canon', %L::jsonb ->> 'hash', 'file_import', null, true)$$,
  pg_temp.got('v_lsys'), pg_temp.got('v_lsys'))), '42501|source_system_invalid', 'with a person but no batch it is refused too');
select is(pg_temp.err(format($$select private.servicing_apply_one('ecb00000-0000-4000-8000-000000000001', 'loan', %L::jsonb -> 'canon', %L::jsonb ->> 'hash', 'manual_import', null, true)$$,
  pg_temp.got('v_lsys'), pg_temp.got('v_lsys'))), '42501|source_system_invalid', 'a manual import record needs a batch as well');
select is(pg_temp.err(format($$select private.servicing_apply_one('ecb00000-0000-4000-8000-000000000001', 'loan', %L::jsonb -> 'canon', %L::jsonb ->> 'hash', 'file_import', %L, true)$$,
  pg_temp.got('v_lsys'), pg_temp.got('v_lsys'), (pg_temp.got('paus')::jsonb) ->> 'batch_id')), 'ok', 'while a person with a batch (a preview) is accepted: the control');
select pg_temp.as_owner();

-- M20 (g) and the machine path: lender Y switches to a MOCK connection (the only machine source that can be active), in a session that allows mock providers.
select set_config('udofin.allow_mock_providers', 'on', true);
update servicing.lms_connections set kind = 'mock', provider_mode = 'mock' where lender_org_id = 'ecb00000-0000-4000-8000-000000000002';
select pg_temp.as_system();
select is(pg_temp.err(format($$select servicing.apply_lms_report('ecb00000-0000-4000-8000-000000000002', %L, %L)$$,
  pg_temp.loan('LY1', 'SAMPLE-APP-31', 'SRC-LY1-1', 3, '{"report_type":"loan","source_system":"mock_lms","sequence":"1"}'), (pg_temp.got('yprev')::jsonb) ->> 'batch_id')), '55000|batch_invalid',
  'M20 g: a report cannot ride on a previewed batch of its own lender (the batch is a file batch, the report a mock one)');
select is(pg_temp.err(format($$select servicing.apply_lms_report('ecb00000-0000-4000-8000-000000000002', %L, %L)$$,
  pg_temp.loan('LY1', 'SAMPLE-APP-31', 'SRC-LY1-1', 3, '{"report_type":"loan","source_system":"mock_lms","sequence":"1"}'), (pg_temp.got('aal')::jsonb) ->> 'batch_id')), '55000|batch_invalid',
  'nor on a previewed batch of ANOTHER lender');
select is(pg_temp.err(format($$select servicing.apply_lms_report('ecb00000-0000-4000-8000-000000000002', %L, %L)$$,
  pg_temp.loan('LY1', 'SAMPLE-APP-31', 'SRC-LY1-1', 3, '{"report_type":"loan","source_system":"mock_lms","sequence":"1"}'), '00000000-0000-4000-8000-0000000000bb')), '55000|batch_invalid', 'nor on an unknown batch');
select pg_temp.keep('ly1', servicing.apply_lms_report('ecb00000-0000-4000-8000-000000000002', pg_temp.loan('LY1', 'SAMPLE-APP-31', 'SRC-LY1-1', 3, '{"report_type":"loan","source_system":"mock_lms","sequence":"1"}'))::text);
select is((pg_temp.got('ly1')::jsonb) ->> 'outcome', 'new', 'a mock report for lender Y creates its loan');
select pg_temp.as_owner();
select is((select (s.source_system::text, s.import_batch_id is null, s.recorded_by is null)::text from servicing.balance_snapshots s join servicing.loan_accounts l on l.id = s.loan_account_id where l.lms_loan_ref = 'LY1'),
  '(mock_lms,t,t)', 'the snapshot says it came from the mock feed, with no batch and no person: it cannot pass for a lender''s file');
select is((select count(*) from audit.events where action = 'servicing.report.applied' and entity_id = (pg_temp.got('ly1')::jsonb) ->> 'content_sha256'), 1::bigint, 'M10: the applied report leaves an audit event');
select is((select array_agg(k order by k) from audit.events e, jsonb_object_keys(e.metadata) k where e.action = 'servicing.report.applied' and e.entity_id = (pg_temp.got('ly1')::jsonb) ->> 'content_sha256'),
  array['outcome', 'reason', 'report_type', 'source_system'], 'whose metadata holds classes only (no figure, no reference)');
select pg_temp.as_system();
select is((servicing.apply_lms_report('ecb00000-0000-4000-8000-000000000002', pg_temp.loan('LY1', 'SAMPLE-APP-31', 'SRC-LY1-1', 3, '{"report_type":"loan","source_system":"mock_lms","sequence":"1"}'))) ->> 'outcome', 'unchanged',
  'the same report again is unchanged');
select pg_temp.as_owner();
select is((select count(*) from audit.events where action = 'servicing.report.applied' and metadata ->> 'source_system' = 'mock_lms'), 1::bigint, 'and an unchanged report writes no second audit event');

-- 5b. M19: a report that cannot be tied to an application is quarantined, and the lender''s queue is told (ids only), once.
select pg_temp.as_system();
select pg_temp.keep('q1', servicing.apply_lms_report('ecb00000-0000-4000-8000-000000000002', pg_temp.loan('LY9', 'SAMPLE-APP-NOPE', 'SRC-LY9-1', 2, '{"report_type":"loan","source_system":"mock_lms"}'))::text);
select is((pg_temp.got('q1')::jsonb) ->> 'outcome', 'quarantined', 'a report for an unknown application is quarantined');
select pg_temp.as_owner();
select is((select count(*) from ops.outbox_events where event_type = 'servicing.sync_quarantine.opened' and payload ->> 'lender_org_id' = 'ecb00000-0000-4000-8000-000000000002'), 1::bigint,
  'M19: the quarantine raises one servicing.sync_quarantine.opened event for the lender');
select is((select array_agg(k order by k) from ops.outbox_events e, jsonb_object_keys(e.payload) k where e.event_type = 'servicing.sync_quarantine.opened'),
  array['lender_org_id', 'quarantine_id'], 'carrying ids only');
select is((select e.dedupe_key from ops.outbox_events e where e.event_type = 'servicing.sync_quarantine.opened'), 'sync-quarantine:' || (select id::text from servicing.sync_quarantine where lms_loan_ref = 'LY9'),
  'with a per-quarantine dedupe key');
select pg_temp.as_system();
select is((servicing.apply_lms_report('ecb00000-0000-4000-8000-000000000002', pg_temp.loan('LY9', 'SAMPLE-APP-NOPE', 'SRC-LY9-1', 2, '{"report_type":"loan","source_system":"mock_lms"}'))) ->> 'outcome', 'quarantined', 'the same report again is quarantined again');
select pg_temp.as_owner();
select is((select count(*) from ops.outbox_events where event_type = 'servicing.sync_quarantine.opened'), 1::bigint, 'but is announced once (it is the same quarantine row)');
select is((select count(*) from audit.events where action = 'servicing.report.applied' and metadata ->> 'outcome' = 'quarantined'), 2::bigint, 'while each arrival leaves its audit event');
select pg_temp.as_user('ec000000-0000-4000-8000-000000000001');
select pg_temp.keep('qprev', pg_temp.stage('ecb00000-0000-4000-8000-000000000001', 'loan', 'q-preview', jsonb_build_array(pg_temp.loan('LQP', 'SAMPLE-APP-NOPE', 'SRC-LQP-1', 2, '{"sequence":"1"}')))::text);
select is((pg_temp.got('qprev')::jsonb) ->> 'status', 'invalid', 'a file with a quarantined record is invalid');
select pg_temp.as_owner();
select is((select count(*) from ops.outbox_events where event_type = 'servicing.sync_quarantine.opened'), 1::bigint, 'and a preview (a dry run) announces nothing');
select is((select count(*) from servicing.sync_quarantine where lender_org_id = 'ecb00000-0000-4000-8000-000000000001'), 0::bigint, 'nor stores a quarantine row');
-- The lender reads its quarantine queue through row level security; the other lender and the viewer-less outsider do not.
select pg_temp.as_user('ec000000-0000-4000-8000-000000000004');
select is((select count(*) from servicing.sync_quarantine), 1::bigint, 'lender Y reads its quarantine row');
select pg_temp.as_user('ec000000-0000-4000-8000-000000000001');
select is((select count(*) from servicing.sync_quarantine), 0::bigint, 'lender X reads none of it');
select pg_temp.as_owner();
select set_config('udofin.allow_mock_providers', '', true);

-- ============================================================================================================================
-- 6. Conflicts confirmed as 'incoming' (M8): the figures the lender disowned do not come back by a status change
-- ============================================================================================================================
select pg_temp.as_user('ec000000-0000-4000-8000-000000000001');
select pg_temp.keep('lx1_ts', (select to_char(reported_as_of at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') from servicing.balance_snapshots where loan_account_id = pg_temp.lid('LX1') and version = 1));
-- The lender re-sends the SAME record at the SAME time with other figures (next due 2500.00 instead of 4500.00): a conflict.
select pg_temp.keep('m8_c', pg_temp.imp('ecb00000-0000-4000-8000-000000000001', 'loan', 'm8-conflict', jsonb_build_array(
  pg_temp.loan('LX1', 'SAMPLE-APP-1', 'SRC-LX1-1', 6, jsonb_build_object('sequence', '1', 'next_due_amount', '2500.00', 'reported_as_of', pg_temp.got('lx1_ts')))))::text);
select pg_temp.keep('c_m8', (select id::text from servicing.sync_conflicts where loan_account_id = pg_temp.lid('LX1') and record_type = 'loan'));
select is((select status from servicing.sync_conflicts where id = pg_temp.got('c_m8')::uuid), 'open', 'the loan record is in conflict');
select pg_temp.as_user('ec000000-0000-4000-8000-000000000005');
select is((select (figures_available, next_due_minor)::text from servicing.my_loan(pg_temp.lid('LX1'))), '(f,)', 'the borrower is shown no figures while the loan record is in conflict');
select pg_temp.as_user('ec000000-0000-4000-8000-000000000002');
select is(pg_temp.err(format($$select servicing.acknowledge_sync_conflict(%L)$$, pg_temp.got('c_m8'))), 'ok', 'a lender user acknowledges the conflict');
select is(pg_temp.err(format($$select servicing.resolve_sync_conflict(%L, 'incoming', 'The lender says the lower figure is the right one', '{"lender_ticket":"SAMPLE-T-M8"}')$$, pg_temp.got('c_m8'))), '55000|incoming_not_stored',
  'M8: the same user cannot confirm the incoming version while it was never stored as a newer report');
select is((select status from servicing.sync_conflicts where id = pg_temp.got('c_m8')::uuid), 'acknowledged', 'the conflict stays acknowledged, not resolved');
select pg_temp.as_user('ec000000-0000-4000-8000-000000000005');
select is((select figures_available from servicing.my_loan(pg_temp.lid('LX1'))), false, 'and the borrower is still shown no figures (the stored 4500.00 is not brought back)');
select pg_temp.as_user('ec000000-0000-4000-8000-000000000001');
select is(pg_temp.imp('ecb00000-0000-4000-8000-000000000001', 'loan', 'm8-newer', jsonb_build_array(
  pg_temp.loan('LX1', 'SAMPLE-APP-1', 'SRC-LX1-2', 1, '{"sequence":"2","next_due_amount":"2500.00","outstanding_principal":"39000.00"}'))) ->> 'status', 'committed', 'the lender sends the corrected figures as a NEWER report');
select pg_temp.as_user('ec000000-0000-4000-8000-000000000005');
select is((select figures_available from servicing.my_loan(pg_temp.lid('LX1'))), false, 'the open conflict still withholds the figures');
select pg_temp.as_user('ec000000-0000-4000-8000-000000000002');
select is(pg_temp.err(format($$select servicing.resolve_sync_conflict(%L, 'incoming', 'The lender says the lower figure is the right one', '{"lender_ticket":"SAMPLE-T-M8"}')$$, pg_temp.got('c_m8'))), 'ok',
  'with the incoming version stored as a newer report the lender can confirm it');
select pg_temp.as_user('ec000000-0000-4000-8000-000000000005');
select is((select (figures_available, next_due_minor, outstanding_principal_minor)::text from servicing.my_loan(pg_temp.lid('LX1'))), '(t,250000,3900000)',
  'and the borrower sees the corrected figures (never the disowned 4500.00)');

-- The existing version needs no newer report (the lender stands by what is stored): the figures return as they were.
select pg_temp.as_user('ec000000-0000-4000-8000-000000000001');
select pg_temp.keep('lx3_ts', (select to_char(reported_as_of at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') from servicing.balance_snapshots where loan_account_id = pg_temp.lid('LX3') and version = 1));
select pg_temp.imp('ecb00000-0000-4000-8000-000000000001', 'loan', 'm8-ctrl', jsonb_build_array(
  pg_temp.loan('LX3', 'SAMPLE-APP-3', 'SRC-LX3-1', 6, jsonb_build_object('sequence', '1', 'next_due_amount', '2500.00', 'reported_as_of', pg_temp.got('lx3_ts')))));
select pg_temp.keep('c_m8b', (select id::text from servicing.sync_conflicts where loan_account_id = pg_temp.lid('LX3') and record_type = 'loan'));
select pg_temp.as_user('ec000000-0000-4000-8000-000000000002');
select servicing.acknowledge_sync_conflict(pg_temp.got('c_m8b')::uuid);
select is(pg_temp.err(format($$select servicing.resolve_sync_conflict(%L, 'existing', 'The lender confirmed the stored figure by ticket', '{"lender_ticket":"SAMPLE-T-M8B"}')$$, pg_temp.got('c_m8b'))), 'ok', 'confirming the existing version needs no newer report');
select pg_temp.as_user('ec000000-0000-4000-8000-000000000005');
select is((select (figures_available, next_due_minor)::text from servicing.my_loan(pg_temp.lid('LX3'))), '(t,450000)', 'and the borrower sees the stored figures again');

-- A schedule conflict behaves the same way.
select pg_temp.as_user('ec000000-0000-4000-8000-000000000001');
select is(pg_temp.imp('ecb00000-0000-4000-8000-000000000001', 'schedule', 'm8-sched-1', jsonb_build_array(pg_temp.sched('LX1', 'SRC-SCH-1', 3))) ->> 'status', 'committed', 'a schedule is reported for LX1');
select pg_temp.keep('sch_ts', pg_temp.q(format($$select to_char(reported_as_of at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') from servicing.schedule_snapshots where loan_account_id = %L and version = 1$$, pg_temp.lid('LX1'))));
select pg_temp.as_user('ec000000-0000-4000-8000-000000000005');
select is((select count(*) from servicing.my_loan_schedule(pg_temp.lid('LX1'))), 2::bigint, 'the borrower sees its two installments');
select pg_temp.as_user('ec000000-0000-4000-8000-000000000001');
select pg_temp.imp('ecb00000-0000-4000-8000-000000000001', 'schedule', 'm8-sched-2', jsonb_build_array(
  pg_temp.sched('LX1', 'SRC-SCH-1', 3, jsonb_build_object('reported_as_of', pg_temp.got('sch_ts'), 'installments', jsonb_build_array(
    jsonb_build_object('installment_seq', '1', 'due_date', to_char(current_date + 10, 'YYYY-MM-DD'), 'principal', '9999.99', 'interest', '333.33'))))));
select pg_temp.keep('c_sch', (select id::text from servicing.sync_conflicts where loan_account_id = pg_temp.lid('LX1') and record_type = 'schedule'));
select is((select status from servicing.sync_conflicts where id = pg_temp.got('c_sch')::uuid), 'open', 'a different schedule for the same record and time is a conflict');
select pg_temp.as_user('ec000000-0000-4000-8000-000000000005');
select is((select count(*) from servicing.my_loan_schedule(pg_temp.lid('LX1'))), 0::bigint, 'the borrower is shown no schedule while it is in conflict');
select pg_temp.as_user('ec000000-0000-4000-8000-000000000002');
select servicing.acknowledge_sync_conflict(pg_temp.got('c_sch')::uuid);
select is(pg_temp.err(format($$select servicing.resolve_sync_conflict(%L, 'incoming', 'The lender says the other schedule is the right one', '{"lender_ticket":"SAMPLE-T-SCH"}')$$, pg_temp.got('c_sch'))), '55000|incoming_not_stored',
  'M8: confirming the incoming schedule needs it stored as a newer report as well');
select pg_temp.as_user('ec000000-0000-4000-8000-000000000001');
select pg_temp.imp('ecb00000-0000-4000-8000-000000000001', 'schedule', 'm8-sched-3', jsonb_build_array(
  pg_temp.sched('LX1', 'SRC-SCH-2', 1, jsonb_build_object('installments', jsonb_build_array(
    jsonb_build_object('installment_seq', '1', 'due_date', to_char(current_date + 10, 'YYYY-MM-DD'), 'principal', '9999.99', 'interest', '333.33'))))));
select pg_temp.as_user('ec000000-0000-4000-8000-000000000002');
select is(pg_temp.err(format($$select servicing.resolve_sync_conflict(%L, 'incoming', 'The lender says the other schedule is the right one', '{"lender_ticket":"SAMPLE-T-SCH"}')$$, pg_temp.got('c_sch'))), 'ok', 'once the newer schedule is stored it can be confirmed');
select pg_temp.as_user('ec000000-0000-4000-8000-000000000005');
select is((select string_agg(schedule_version::text || ':' || principal_minor::text, ',' order by seq) from servicing.my_loan_schedule(pg_temp.lid('LX1'))), '2:999999', 'and the borrower sees the newer schedule (version 2), not the disowned one');

-- A receipt conflict is a record the lender already posted: nothing is withheld, so confirming either version needs no newer report (documented).
select pg_temp.as_user('ec000000-0000-4000-8000-000000000001');
select pg_temp.imp('ecb00000-0000-4000-8000-000000000001', 'receipt', 'm8-rc-1', jsonb_build_array(pg_temp.receipt('LX1', 'RC-M8', '100.00', 2)));
select pg_temp.imp('ecb00000-0000-4000-8000-000000000001', 'receipt', 'm8-rc-2', jsonb_build_array(pg_temp.receipt('LX1', 'RC-M8', '200.00', 1)));
select pg_temp.keep('c_rc', (select id::text from servicing.sync_conflicts where loan_account_id = pg_temp.lid('LX1') and record_type = 'receipt'));
select pg_temp.as_user('ec000000-0000-4000-8000-000000000002');
select servicing.acknowledge_sync_conflict(pg_temp.got('c_rc')::uuid);
select is(pg_temp.err(format($$select servicing.resolve_sync_conflict(%L, 'incoming', 'The lender says the larger receipt is the right one', '{"lender_ticket":"SAMPLE-T-RC"}')$$, pg_temp.got('c_rc'))), 'ok',
  'a receipt conflict can be confirmed either way (the gate applies to the figures and the schedule only)');

-- ============================================================================================================================
-- 7. Receipts net of reversals (M9)
-- ============================================================================================================================
select pg_temp.as_user('ec000000-0000-4000-8000-000000000001');
select pg_temp.imp('ecb00000-0000-4000-8000-000000000001', 'receipt', 'm9-rc', jsonb_build_array(pg_temp.receipt('LX2', 'RC-9', '4500.00', 5)));
select pg_temp.imp('ecb00000-0000-4000-8000-000000000001', 'receipt', 'm9-rv1', jsonb_build_array(
  pg_temp.receipt('LX2', 'RV-9A', '0.01', 4, '{"receipt_kind":"reversal","reverses_receipt_ref":"RC-9","source_record_id":"SRC-RV-9A"}')));
select is((select (amount_minor, reversed_minor, net_minor, fully_reversed, over_reversed)::text from servicing.lms_receipts_net where lms_receipt_ref = 'RC-9'), '(450000,1,449999,f,f)',
  'M9: a reversal of 0.01 leaves a net amount of 4499.99 and the receipt is NOT fully reversed');
select pg_temp.as_owner();
select is(private.servicing_receipt_is_reversed((select id from servicing.lms_receipts where lms_receipt_ref = 'RC-9')), false, 'the helper agrees: a partial reversal does not reverse the receipt');
select is((select count(*) > 0 from servicing.lms_receipts rv where rv.reverses_receipt_id = (select id from servicing.lms_receipts where lms_receipt_ref = 'RC-9')), true,
  'whereas the predicate "a reversal row exists" (what other consumers used) says it is reversed: that is the defect they must stop using');
select is(private.servicing_receipt_reversed_minor((select id from servicing.lms_receipts where lms_receipt_ref = 'RC-9')), 1::bigint, 'the reversed amount is 1 paisa');
select is(private.servicing_receipt_is_reversed((select id from servicing.lms_receipts where lms_receipt_ref = 'RV-9A')), null, 'the helper answers null for a reversal row (it is not a receipt)');
select is((select count(*) from servicing.sync_anomalies where kind = 'reversal_exceeds_receipt' and loan_account_id = pg_temp.lid('LX2')), 0::bigint, 'nothing exceeds the receipt yet');
select pg_temp.as_user('ec000000-0000-4000-8000-000000000001');
select pg_temp.imp('ecb00000-0000-4000-8000-000000000001', 'receipt', 'm9-rv2', jsonb_build_array(
  pg_temp.receipt('LX2', 'RV-9B', '4499.99', 3, '{"receipt_kind":"reversal","reverses_receipt_ref":"RC-9","source_record_id":"SRC-RV-9B"}')));
select is((select (reversed_minor, net_minor, fully_reversed, over_reversed)::text from servicing.lms_receipts_net where lms_receipt_ref = 'RC-9'), '(450000,0,t,f)', 'the second reversal completes it: net zero, fully reversed');
select pg_temp.as_owner();
select is(private.servicing_receipt_is_reversed((select id from servicing.lms_receipts where lms_receipt_ref = 'RC-9')), true, 'the helper agrees');
select pg_temp.as_user('ec000000-0000-4000-8000-000000000001');
select pg_temp.imp('ecb00000-0000-4000-8000-000000000001', 'receipt', 'm9-rv3', jsonb_build_array(
  pg_temp.receipt('LX2', 'RV-9C', '0.01', 2, '{"receipt_kind":"reversal","reverses_receipt_ref":"RC-9","source_record_id":"SRC-RV-9C"}')));
select is((select (reversed_minor, net_minor, fully_reversed, over_reversed)::text from servicing.lms_receipts_net where lms_receipt_ref = 'RC-9'), '(450001,0,t,t)', 'a reversal beyond the receipt keeps the net at zero and says so');
select is((select count(*) from servicing.sync_anomalies where kind = 'reversal_exceeds_receipt' and loan_account_id = pg_temp.lid('LX2')), 1::bigint, 'and is flagged for the lender, as before');
select is((select count(*) from servicing.lms_receipts_net where lms_receipt_ref in ('RV-9A', 'RV-9B', 'RV-9C')), 0::bigint, 'the view lists receipts only');
select pg_temp.as_user('ec000000-0000-4000-8000-000000000003');
select is((select count(*) from servicing.lms_receipts_net where lms_receipt_ref = 'RC-9'), 1::bigint, 'a viewer of lender X (loan.read) reads it');
select pg_temp.as_user('ec000000-0000-4000-8000-000000000004');
select is((select count(*) from servicing.lms_receipts_net), 0::bigint, 'the other lender reads none of it (row level security through the invoker view)');

-- ============================================================================================================================
-- 8. Guards that no test exercised (M20 d, e, f): anomalies that withhold figures, the sanctioned-amount floor, a receipt reference reused on another loan
-- ============================================================================================================================
select pg_temp.as_user('ec000000-0000-4000-8000-000000000001');
-- d1. A terminal status that changes to another terminal status (LX4: closed, then written off).
select is(pg_temp.imp('ecb00000-0000-4000-8000-000000000001', 'loan', 'm20-term', jsonb_build_array(
  pg_temp.loan('LX4', 'SAMPLE-APP-4', 'SRC-LX4-2', 3, '{"sequence":"2","status":"closed"}'),
  pg_temp.loan('LX4', 'SAMPLE-APP-4', 'SRC-LX4-3', 2, '{"sequence":"3","status":"written_off"}'))) ->> 'status', 'committed', 'LX4 is reported closed, then written off');
select is((select (kind, severity, previous_status, reported_status)::text from servicing.sync_anomalies where loan_account_id = pg_temp.lid('LX4') and kind = 'terminal_status_changed'),
  '(terminal_status_changed,warning,closed,written_off)', 'a terminal status changing to another one is flagged');
select pg_temp.as_user('ec000000-0000-4000-8000-000000000006');
select is((select figures_available from servicing.my_loan(pg_temp.lid('LX4'))), false, 'and the borrower is shown no figures for the loan');
-- d2 and e. The sanctioned amount (LX5): a change is applied only while it covers the disbursement, and is flagged either way.
select pg_temp.as_user('ec000000-0000-4000-8000-000000000001');
select is(pg_temp.imp('ecb00000-0000-4000-8000-000000000001', 'loan', 'm20-sanct-up', jsonb_build_array(
  pg_temp.loan('LX5', 'SAMPLE-APP-5', 'SRC-LX5-2', 2, '{"sequence":"2","sanctioned_amount":"60000.00"}'))) ->> 'status', 'committed', 'LX5 is reported with a higher sanctioned amount');
select is((select sanctioned_amount_minor from servicing.loan_accounts where id = pg_temp.lid('LX5')), 6000000::bigint, 'the loan account follows (the new amount covers the disbursement)');
select is((select count(*) from servicing.sync_anomalies where loan_account_id = pg_temp.lid('LX5') and kind = 'sanctioned_amount_changed'), 1::bigint, 'and the change is flagged');
select pg_temp.as_user('ec000000-0000-4000-8000-000000000005');
select is((select figures_available from servicing.my_loan(pg_temp.lid('LX5'))), false, 'the borrower is shown no figures while the report carries that warning');
select pg_temp.as_user('ec000000-0000-4000-8000-000000000001');
select is(pg_temp.imp('ecb00000-0000-4000-8000-000000000001', 'loan', 'm20-sanct-down', jsonb_build_array(
  pg_temp.loan('LX5', 'SAMPLE-APP-5', 'SRC-LX5-3', 1, '{"sequence":"3","sanctioned_amount":"40000.00","disbursed_amount":null,"disbursement_ref":null,"disbursement_date":null}'))) ->> 'status', 'committed',
  'LX5 is then reported with a sanctioned amount BELOW what was disbursed (50000.00)');
select is((select sanctioned_amount_minor from servicing.loan_accounts where id = pg_temp.lid('LX5')), 6000000::bigint, 'M20 e: the loan account keeps the amount that covers the disbursement');
select is((select count(*) from servicing.sync_anomalies where loan_account_id = pg_temp.lid('LX5') and kind = 'sanctioned_amount_changed'), 2::bigint, 'and the change is flagged as well');
-- d3. Disbursement evidence that differs from what the loan account holds (LX6).
select is(pg_temp.imp('ecb00000-0000-4000-8000-000000000001', 'loan', 'm20-disb', jsonb_build_array(
  pg_temp.loan('LX6', 'SAMPLE-APP-6', 'SRC-LX6-2', 2, '{"sequence":"2","disbursement_ref":"SAMPLE-DISB-OTHER"}'))) ->> 'status', 'committed', 'LX6 is reported with another disbursement reference');
select is((select count(*) from servicing.sync_anomalies where loan_account_id = pg_temp.lid('LX6') and kind = 'disbursement_evidence_differs'), 1::bigint, 'the difference is flagged');
select is((select disbursement_reference from servicing.loan_accounts where id = pg_temp.lid('LX6')), 'SAMPLE-DISB-LX6', 'and the evidence on the loan account is never rewritten');
select pg_temp.as_user('ec000000-0000-4000-8000-000000000006');
select is((select figures_available from servicing.my_loan(pg_temp.lid('LX6'))), false, 'the borrower is shown no figures for it');
-- f. The same lender receipt reference sent for ANOTHER loan is a conflict, not "unchanged".
select pg_temp.as_user('ec000000-0000-4000-8000-000000000001');
select pg_temp.imp('ecb00000-0000-4000-8000-000000000001', 'receipt', 'm20-rcf-1', jsonb_build_array(pg_temp.receipt('LX1', 'RC-F', '10.00', 1)));
select pg_temp.keep('rcf', pg_temp.stage('ecb00000-0000-4000-8000-000000000001', 'receipt', 'm20-rcf-2', jsonb_build_array(pg_temp.receipt('LX6', 'RC-F', '10.00', 1)))::text);
select is((pg_temp.got('rcf')::jsonb) -> 'counts' ->> 'conflict', '1', 'M20 f: the preview counts the receipt reference reused on another loan as a conflict');
select is((pg_temp.got('rcf')::jsonb) -> 'counts' ->> 'unchanged', '0', 'not as an unchanged repeat');
select is(servicing.commit_import(((pg_temp.got('rcf')::jsonb) ->> 'batch_id')::uuid) -> 'applied_counts', '{"conflict":1}'::jsonb, 'committing queues the conflict');
select is((select (conflict_reason, loan_account_id = pg_temp.lid('LX6'))::text from servicing.sync_conflicts where record_type = 'receipt' and source_record_id = 'SRC-RC-F'), '(receipt_differs,t)', 'as receipt_differs on the loan that sent it');
select is((select count(*) from servicing.lms_receipts where lms_receipt_ref = 'RC-F' and loan_account_id = pg_temp.lid('LX1')), 1::bigint, 'while the stored receipt stays on its own loan');

-- ============================================================================================================================
-- 9. Rule filters and due dates (M21 a, M14)
-- ============================================================================================================================
select pg_temp.as_owner();
-- Three more APPROVED versions of the statement rule that must NOT apply to a personal loan of lender X today: one not yet effective (v2, 55 days), one for another
-- product category (v3, 66 days) and one that has expired (v4, 77 days). The draft v1 (7 days) is still unapproved.
insert into documents.applicability_rules (rule_key, version, lender_category_keys, regulator, direction_ref, paragraph_refs, product_category_keys, exclusions, document_type,
  required_template_key, required_fields_version, validity_rule, effective_from, effective_to, approval_status, evidence_status, reviewer_ref, proposed_by, approved_by, approved_at)
select 'servicing.statement_sla_days_default', v.ver, array['nbfc_icc'], 'Udofin platform setting (not a regulator)', 'SAMPLE rule version for a filter test', '{}', v.prods, 'SAMPLE', 'statement_of_account',
  'none.lender_issued', 'none', jsonb_build_object('kind', 'calendar_days', 'days', v.days, 'basis', 'request_received'), v.eff_from, v.eff_to, 'approved', 'unverified', 'SAMPLE reviewer',
  'ec000000-0000-4000-8000-000000000009', 'ec000000-0000-4000-8000-000000000010', now()
from (values (2, array['personal'], 55, current_date + 10, null::date), (3, array['vehicle'], 66, current_date - 5, null::date), (4, array['personal'], 77, current_date - 40, current_date - 1)) v (ver, prods, days, eff_from, eff_to);
select pg_temp.as_user('ec000000-0000-4000-8000-000000000006');
select pg_temp.keep('rq14', servicing.request_document(pg_temp.lid('DL-14'), 'statement', 'ec-req-key-0014')::text);
select is(pg_temp.q(format($$select (due_by is null and due_rule_id is null)::text from servicing.document_requests where id = %L$$, pg_temp.got('rq14'))), 'true',
  'M21: a rule that is not yet effective, one for another product category and one that has expired resolve nothing (the rule is unresolved: no due date)');
select pg_temp.as_owner();
update documents.applicability_rules set approval_status = 'approved', reviewer_ref = 'SAMPLE compliance reviewer', approved_by = 'ec000000-0000-4000-8000-000000000010', approved_at = now(),
  proposed_by = 'ec000000-0000-4000-8000-000000000009'
 where rule_key in ('servicing.statement_sla_days_default', 'servicing.noc_sla_days_default', 'servicing.security_release_sla_days') and version = 1;
select pg_temp.as_user('ec000000-0000-4000-8000-000000000006');
select pg_temp.keep('rq16', servicing.request_document(pg_temp.lid('DL-16'), 'statement', 'ec-req-key-0016')::text);
select is(pg_temp.q(format($$select (due_by - requested_at)::text || ':' || (select version::text from documents.applicability_rules where id = due_rule_id) from servicing.document_requests where id = %L$$, pg_temp.got('rq16'))), '7 days:1',
  'M21: with version 1 approved the request is due after ITS 7 days, never after the 55, 66 or 77 days of the three versions that do not apply');
select pg_temp.as_user('ec000000-0000-4000-8000-000000000005');
select pg_temp.keep('rq33', servicing.request_document(pg_temp.lid('DL-33'), 'statement', 'ec-req-key-0033')::text);
select is(pg_temp.q(format($$select (due_by is null and due_rule_id is null)::text from servicing.document_requests where id = %L$$, pg_temp.got('rq33'))), 'true',
  'M21: a lender of another category (nbfc_mfi) gets no due date from rules written for nbfc_icc and nbfc_d');

-- M14: the NOC clock starts at the recorded closure (the rule''s basis), a statement''s at the request.
select pg_temp.as_owner();
set local session_replication_role = replica;
update servicing.loan_accounts set status = 'closed' where lms_loan_ref = 'DL-17';
insert into servicing.closure_records (lender_org_id, loan_account_id, closure_kind, closed_at, noc_due_by, noc_due_rule_id)
select 'ecb00000-0000-4000-8000-000000000001', pg_temp.lid('DL-17'), 'closed', now() - interval '40 days', now() - interval '10 days', r.id
from documents.applicability_rules r where r.rule_key = 'servicing.noc_sla_days_default' and r.version = 1;
set local session_replication_role = origin;
select pg_temp.as_user('ec000000-0000-4000-8000-000000000005');
select pg_temp.keep('rq17', servicing.request_document(pg_temp.lid('DL-17'), 'noc', 'ec-req-key-0017')::text);
select is(pg_temp.q(format($$select (r.due_by - c.closed_at)::text from servicing.document_requests r join servicing.closure_records c on c.loan_account_id = r.loan_account_id where r.id = %L$$, pg_temp.got('rq17'))), '30 days',
  'M14: a NOC requested 40 days after the closure is due 30 days after the CLOSURE');
select is(pg_temp.q(format($$select (r.due_by = c.noc_due_by and r.due_by < r.requested_at)::text from servicing.document_requests r join servicing.closure_records c on c.loan_account_id = r.loan_account_id where r.id = %L$$, pg_temp.got('rq17'))),
  'true', 'which is the date the closure record already shows, and already past (not 30 days from today)');

-- M21 (c): no statement exists for a cancelled loan.
select pg_temp.as_owner();
update servicing.loan_accounts set status = 'cancelled' where lms_loan_ref = 'DL-18';
select pg_temp.as_user('ec000000-0000-4000-8000-000000000006');
select is(pg_temp.err(format($$select servicing.request_document(%L, 'statement', 'ec-req-key-0018')$$, pg_temp.lid('DL-18'))), '55000|loan_status_not_eligible', 'M21: a statement cannot be requested for a cancelled loan');

-- ============================================================================================================================
-- 10. Replaying a document or a quotation still answers the request (A6, M11)
-- ============================================================================================================================
select pg_temp.as_user('ec000000-0000-4000-8000-000000000001');
select pg_temp.keep('s19', pg_temp.reg(pg_temp.lid('DL-19'), 'statement', 's-19', current_date - 90, current_date - 30)::text);
select pg_temp.keep('s19old', pg_temp.reg(pg_temp.lid('DL-19'), 'statement', 's-19-old', current_date - 180, current_date - 91)::text);
select pg_temp.as_user('ec000000-0000-4000-8000-000000000005');
select pg_temp.keep('rq19', servicing.request_document(pg_temp.lid('DL-19'), 'statement', 'ec-req-key-0019', current_date - 60, current_date - 40)::text);
select pg_temp.keep('rq19b', servicing.request_document(pg_temp.lid('DL-19'), 'foreclosure_quote', 'ec-req-key-0020')::text);
select pg_temp.as_user('ec000000-0000-4000-8000-000000000001');
select is(pg_temp.err(format($$select pg_temp.reg(%L, 'statement', 's-19', current_date - 90, current_date - 30, %L::uuid, null)$$, pg_temp.lid('DL-19'), pg_temp.got('s19old'))), '23505|lender_reference_reused',
  'M11: the same reference and bytes naming another document to supersede is not a replay');
select is(pg_temp.err(format($$select pg_temp.reg(%L, 'statement', 's-19', current_date - 91, current_date - 30)$$, pg_temp.lid('DL-19'))), '23505|lender_reference_reused', 'nor with another period');
select is(pg_temp.err(format($$select pg_temp.reg(%L, 'statement', 's-19', current_date - 90, current_date - 30, null, %L::uuid)$$, pg_temp.lid('DL-19'), pg_temp.got('rq_chk'))), '55000|request_not_open',
  'a request of ANOTHER loan is not open for this one');
select is(pg_temp.err(format($$select pg_temp.reg(%L, 'statement', 's-19', current_date - 90, current_date - 30, null, %L::uuid)$$, pg_temp.lid('DL-19'), pg_temp.got('rq19b'))), '55000|request_kind_mismatch',
  'a request for a quotation is not answered by a statement');
select is(pg_temp.err(format($$select pg_temp.reg(%L, 'statement', 's-19', current_date - 90, current_date - 30, null, %L::uuid)$$, pg_temp.lid('DL-19'), pg_temp.got('rq19'))), 'ok',
  'A6: the same document sent again WITH the open request answers it');
select is(pg_temp.err(format($$select pg_temp.reg(%L, 'statement', 's-19', current_date - 90, current_date - 30, null, %L::uuid)$$, pg_temp.lid('DL-19'), pg_temp.got('rq19'))), 'ok', 'and sending it once more is still a replay, not an error');
select is(pg_temp.q(format($$select status || ':' || (fulfilled_document_id = %L)::text from servicing.document_requests where id = %L$$, pg_temp.got('s19'), pg_temp.got('rq19'))), 'fulfilled:true',
  'the request is fulfilled with the document that already existed (no second document)');
select is((select count(*) from servicing.loan_documents where lender_reference = 'SAMPLE-REF-s-19'), 1::bigint, 'one document under that reference');
select is(pg_temp.q(format($$select count(*)::text from audit.events where action = 'servicing.loan_document.replay_fulfilled_request' and entity_id = %L$$, pg_temp.got('s19'))), '1', 'the replay that fulfilled the request is audited once');
select pg_temp.as_user('ec000000-0000-4000-8000-000000000005');
select pg_temp.keep('rq19c', servicing.request_document(pg_temp.lid('DL-19'), 'statement', 'ec-req-key-0021', current_date - 400, current_date - 300)::text);
select pg_temp.as_user('ec000000-0000-4000-8000-000000000001');
select is(pg_temp.err(format($$select pg_temp.reg(%L, 'statement', 's-19', current_date - 90, current_date - 30, null, %L::uuid)$$, pg_temp.lid('DL-19'), pg_temp.got('rq19c'))), '55000|period_does_not_cover_request',
  'a replay that does not cover the period the borrower asked for does not fulfil that request');
select pg_temp.as_user('ec000000-0000-4000-8000-000000000005');
select servicing.cancel_document_request(pg_temp.got('rq19c')::uuid);
select pg_temp.as_user('ec000000-0000-4000-8000-000000000001');
select is(pg_temp.err(format($$select pg_temp.reg(%L, 'statement', 's-19', current_date - 90, current_date - 30, null, %L::uuid)$$, pg_temp.lid('DL-19'), pg_temp.got('rq19c'))), '55000|request_not_open', 'nor a request the borrower cancelled');

-- Quotations: the same quotation sent again with an open quotation request.
select pg_temp.as_user('ec000000-0000-4000-8000-000000000001');
select pg_temp.keep('q20_as_of', to_char(clock_timestamp() - interval '1 hour', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
select pg_temp.keep('q20_until', to_char(clock_timestamp() + interval '1 day', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
select pg_temp.keep('q20', servicing.record_foreclosure_quote(pg_temp.lid('DL-20'), 'q-20', pg_temp.got('q20_as_of')::timestamptz, pg_temp.got('q20_until')::timestamptz,
  '10000.00', '500.00', '100.00', '200.00', '10800.00', 'lender_portal', null, null)::text);
select pg_temp.as_user('ec000000-0000-4000-8000-000000000006');
select pg_temp.keep('rq20', servicing.request_document(pg_temp.lid('DL-20'), 'foreclosure_quote', 'ec-req-key-0030')::text);
select pg_temp.as_user('ec000000-0000-4000-8000-000000000005');
select pg_temp.keep('rq21', servicing.request_document(pg_temp.lid('DL-21'), 'foreclosure_quote', 'ec-req-key-0031')::text);
select pg_temp.as_user('ec000000-0000-4000-8000-000000000001');
select is(pg_temp.err(format($$select servicing.record_foreclosure_quote(%L, 'q-20', %L, %L, '10000.00', '500.00', '100.00', '200.00', '10801.00', 'lender_portal', %L, null)$$,
  pg_temp.lid('DL-20'), pg_temp.got('q20_as_of')::timestamptz, pg_temp.got('q20_until')::timestamptz, pg_temp.got('rq20'))), '23505|quote_ref_reused', 'M11: other figures under the same reference are a conflict');
select pg_temp.keep('ld20', pg_temp.reg(pg_temp.lid('DL-20'), 'foreclosure_quote', 'ld-20')::text);
select is(pg_temp.err(format($$select servicing.record_foreclosure_quote(%L, 'q-20', %L, %L, '10000.00', '500.00', '100.00', '200.00', '10800.00', 'lender_portal', %L, %L)$$,
  pg_temp.lid('DL-20'), pg_temp.got('q20_as_of')::timestamptz, pg_temp.got('q20_until')::timestamptz, pg_temp.got('rq20'), pg_temp.got('ld20'))), '23505|quote_ref_reused', 'and so is the same quotation naming a letter it did not have');
select is(pg_temp.err(format($$select servicing.record_foreclosure_quote(%L, 'q-20', %L, %L, '10000.00', '500.00', '100.00', '200.00', '10800.00', 'lender_portal', %L, null)$$,
  pg_temp.lid('DL-20'), pg_temp.got('q20_as_of')::timestamptz, pg_temp.got('q20_until')::timestamptz, pg_temp.got('rq21'))), '55000|request_not_open',
  'M21: the request of ANOTHER loan is not open for this one (the scope guard)');
select is(pg_temp.err(format($$select servicing.record_foreclosure_quote(%L, 'q-20-new', clock_timestamp() - interval '1 hour', clock_timestamp() + interval '1 day', '1.00', '0', '0', '0', '1.00', 'lender_portal', %L, null)$$,
  pg_temp.lid('DL-20'), pg_temp.got('rq21'))), '55000|request_not_open', 'M21: a NEW quotation naming the request of another loan is refused as well (the scope of the request lookup)');
select is(pg_temp.err(format($$select servicing.record_foreclosure_quote(%L, 'q-20', %L, %L, '10000.00', '500.00', '100.00', '200.00', '10800.00', 'lender_portal', %L, null)$$,
  pg_temp.lid('DL-20'), pg_temp.got('q20_as_of')::timestamptz, pg_temp.got('q20_until')::timestamptz, pg_temp.got('rq20'))), 'ok', 'A6: the same quotation sent again WITH the open request answers it');
select is(pg_temp.q(format($$select status || ':' || (fulfilled_quote_id = %L)::text from servicing.document_requests where id = %L$$, pg_temp.got('q20'), pg_temp.got('rq20'))), 'fulfilled:true', 'the request is fulfilled with the quotation that already existed');
select is(pg_temp.err(format($$select servicing.record_foreclosure_quote(%L, 'q-20', %L, %L, '10000.00', '500.00', '100.00', '200.00', '10800.00', 'lender_portal', %L, null)$$,
  pg_temp.lid('DL-20'), pg_temp.got('q20_as_of')::timestamptz, pg_temp.got('q20_until')::timestamptz, pg_temp.got('rq20'))), 'ok', 'and once more is still a replay');
-- An expired quotation cannot fulfil a request, replay or not.
select pg_temp.keep('q22', servicing.record_foreclosure_quote(pg_temp.lid('DL-22'), 'q-22', clock_timestamp() - interval '3 hours', clock_timestamp() - interval '1 hour',
  '10000.00', '500.00', '100.00', '200.00', '10800.00', 'lender_portal', null, null)::text);
select pg_temp.as_user('ec000000-0000-4000-8000-000000000006');
select pg_temp.keep('rq22', servicing.request_document(pg_temp.lid('DL-22'), 'foreclosure_quote', 'ec-req-key-0032')::text);
select pg_temp.as_user('ec000000-0000-4000-8000-000000000001');
select is(pg_temp.err(format($$select servicing.record_foreclosure_quote(%L, 'q-22', (select as_of from servicing.foreclosure_quotes where id = %L), (select valid_until from servicing.foreclosure_quotes where id = %L), '10000.00', '500.00', '100.00', '200.00', '10800.00', 'lender_portal', %L, null)$$,
  pg_temp.lid('DL-22'), pg_temp.got('q22'), pg_temp.got('q22'), pg_temp.got('rq22'))), '55000|quote_already_expired', 'M11: a replay of an expired quotation cannot fulfil the request either');
select is(pg_temp.q(format($$select status from servicing.document_requests where id = %L$$, pg_temp.got('rq22'))), 'requested', 'and the request stays open');

-- ============================================================================================================================
-- 11. The closure's NOC pointer follows corrections (A2, M12)
-- ============================================================================================================================
select pg_temp.as_owner();
update servicing.loan_accounts set status = 'closed' where lms_loan_ref in ('DL-23', 'DL-24');
select pg_temp.as_user('ec000000-0000-4000-8000-000000000001');
select pg_temp.keep('noc_a', pg_temp.reg(pg_temp.lid('DL-23'), 'noc', 'noc-23-a', p_issued => interval '3 hours')::text);
select is((select noc_document_id::text from servicing.closure_records where loan_account_id = pg_temp.lid('DL-23')), pg_temp.got('noc_a'), 'the first NOC becomes the closure''s NOC');
select pg_temp.keep('noc_b', pg_temp.reg(pg_temp.lid('DL-23'), 'noc', 'noc-23-b', null, null, pg_temp.got('noc_a')::uuid, null, 'lender_upload', interval '2 hours')::text);
select is((select (noc_document_id = pg_temp.got('noc_b')::uuid and noc_issued_at = (select issued_at from servicing.loan_documents where id = pg_temp.got('noc_b')::uuid))::text from servicing.closure_records where loan_account_id = pg_temp.lid('DL-23')),
  'true', 'A2: a NOC that supersedes it replaces the pointer, and the issue time moves with it');
select pg_temp.keep('noc_c', pg_temp.reg(pg_temp.lid('DL-23'), 'noc', 'noc-23-c', null, null, pg_temp.got('noc_b')::uuid, null, 'lender_upload', interval '1 hour')::text);
select is((select noc_document_id::text from servicing.closure_records where loan_account_id = pg_temp.lid('DL-23')), pg_temp.got('noc_c'), 'and a correction of the correction does too');
select pg_temp.keep('noc_d', pg_temp.reg(pg_temp.lid('DL-23'), 'noc', 'noc-23-d', p_issued => interval '30 minutes')::text);
select is((select noc_document_id::text from servicing.closure_records where loan_account_id = pg_temp.lid('DL-23')), pg_temp.got('noc_c'), 'a further NOC that corrects nothing does not take the pointer');
select pg_temp.keep('cl_x', pg_temp.reg(pg_temp.lid('DL-23'), 'closure_letter', 'cl-23', p_issued => interval '20 minutes')::text);
select is((select noc_document_id::text from servicing.closure_records where loan_account_id = pg_temp.lid('DL-23')), pg_temp.got('noc_c'), 'nor does a closure letter');
select pg_temp.as_user('ec000000-0000-4000-8000-000000000005');
select is((servicing.my_closure(pg_temp.lid('DL-23')) ->> 'noc_document_id'), pg_temp.got('noc_c'), 'the borrower''s closure screen offers the corrected NOC, not the superseded ones');
select is((select superseded_by_id::text from servicing.my_loan_documents(pg_temp.lid('DL-23')) where document_id = pg_temp.got('noc_a')::uuid), pg_temp.got('noc_b'), 'while the superseded one is still listed as superseded');
select pg_temp.as_user('ec000000-0000-4000-8000-000000000003');
select is((select noc_document_id::text from servicing.closure_records where loan_account_id = pg_temp.lid('DL-23')), pg_temp.got('noc_c'), 'the lender''s closure list (a table read) shows the corrected NOC as well');
-- A closure letter first, then the NOC proper.
select pg_temp.as_user('ec000000-0000-4000-8000-000000000001');
select pg_temp.keep('cl_24', pg_temp.reg(pg_temp.lid('DL-24'), 'closure_letter', 'cl-24', p_issued => interval '3 hours')::text);
select is((select noc_document_id::text from servicing.closure_records where loan_account_id = pg_temp.lid('DL-24')), pg_temp.got('cl_24'), 'a closure letter registered first is the pointer');
select pg_temp.keep('noc_24', pg_temp.reg(pg_temp.lid('DL-24'), 'noc', 'noc-24', p_issued => interval '2 hours')::text);
select is((select noc_document_id::text from servicing.closure_records where loan_account_id = pg_temp.lid('DL-24')), pg_temp.got('noc_24'), 'A2: the NOC proper replaces a closure letter');
select pg_temp.keep('cl_24b', pg_temp.reg(pg_temp.lid('DL-24'), 'closure_letter', 'cl-24b', p_issued => interval '1 hour')::text);
select is((select noc_document_id::text from servicing.closure_records where loan_account_id = pg_temp.lid('DL-24')), pg_temp.got('noc_24'), 'while a later closure letter does not replace the NOC');
-- The table itself: only a document that corrects the current one, with its own issue time.
select pg_temp.as_owner();
select is(pg_temp.err(format($$update servicing.closure_records set noc_document_id = %L, noc_issued_at = (select issued_at from servicing.loan_documents where id = %L) where loan_account_id = %L$$,
  pg_temp.got('noc_d'), pg_temp.got('noc_d'), pg_temp.lid('DL-23'))), 'P0001|closure_immutable', 'the pointer cannot be moved to a document that does not correct the current one, even by the owner');
select is(pg_temp.err(format($$update servicing.closure_records set noc_issued_at = now() where loan_account_id = %L$$, pg_temp.lid('DL-23'))), 'P0001|closure_immutable', 'nor the issue time changed on its own');
select is(pg_temp.err(format($$update servicing.closure_records set noc_document_id = null, noc_issued_at = null where loan_account_id = %L$$, pg_temp.lid('DL-23'))), 'P0001|closure_immutable', 'nor the pointer removed');
select is(pg_temp.err(format($$update servicing.closure_records set noc_document_id = %L where loan_account_id = %L$$, pg_temp.got('cl_24b'), pg_temp.lid('DL-24'))), 'P0001|closure_immutable', 'nor moved without its issue time, nor to a closure letter that corrects nothing');
select is(pg_temp.err(format($$update servicing.closure_records set noc_document_id = %L, noc_issued_at = (select issued_at from servicing.loan_documents where id = %L) where loan_account_id = %L$$,
  pg_temp.got('noc_a'), pg_temp.got('noc_a'), pg_temp.lid('DL-24'))), 'P0001|closure_immutable', 'nor to a document of another loan');

-- ============================================================================================================================
-- 12. Quotations: bounded validity, no payable quotation after a later receipt or report, and no lender user id for the borrower (M15, M18)
-- ============================================================================================================================
create function pg_temp.snap(loan_ref text, ver integer, st text, principal bigint, hours_ago numeric) returns void language sql as $fn$
  insert into servicing.balance_snapshots (lender_org_id, loan_account_id, version, status, outstanding_principal_minor, source_system, source_record_id, reported_as_of, content_sha256)
  select l.lender_org_id, l.id, ver, st::servicing.loan_status, principal, 'lender_lms', 'SNAP-' || loan_ref || '-' || ver,
         clock_timestamp() - make_interval(secs => (hours_ago * 3600)::integer), encode(sha256(convert_to(loan_ref || ':' || ver::text, 'UTF8')), 'hex')
  from servicing.loan_accounts l where l.lms_loan_ref = loan_ref
$fn$;
create function pg_temp.rcpt(loan_ref text, ref text, hours_ago numeric) returns void language sql as $fn$
  insert into servicing.lms_receipts (lender_org_id, loan_account_id, kind, lms_receipt_ref, amount_minor, value_date, source_system, source_record_id, reported_as_of, content_sha256)
  select l.lender_org_id, l.id, 'receipt', ref, 10000, current_date, 'lender_lms', 'SRC-' || ref, clock_timestamp() - make_interval(secs => (hours_ago * 3600)::integer),
         encode(sha256(convert_to(ref, 'UTF8')), 'hex')
  from servicing.loan_accounts l where l.lms_loan_ref = loan_ref
$fn$;
grant execute on function pg_temp.snap(text, integer, text, bigint, numeric), pg_temp.rcpt(text, text, numeric) to public;

select pg_temp.as_user('ec000000-0000-4000-8000-000000000001');
select is(pg_temp.err(format($$select pg_temp.quote(%L, 'q-long', 800)$$, pg_temp.lid('DL-25'))), '22023|validity_too_long', 'M15: a quotation valid for more than 31 days after its as-of time is refused');
select is(pg_temp.err(format($$select pg_temp.quote(%L, 'q-ok-long', 696)$$, pg_temp.lid('DL-30'))), 'ok', 'while one valid for 29 days is accepted');
select pg_temp.as_owner();
select is(pg_temp.st($$insert into servicing.foreclosure_quotes (lender_org_id, loan_account_id, lender_quote_ref, as_of, valid_until, principal_minor, interest_minor, charges_minor, prepayment_charge_minor, total_minor, source, reported_by)
  values ('ecb00000-0000-4000-8000-000000000001', (select id from servicing.loan_accounts where lms_loan_ref = 'DL-30'), 'q-table-long', now() - interval '1 hour', now() + interval '40 days', 1, 0, 0, 0, 1, 'lender_portal', 'ec000000-0000-4000-8000-000000000001')$$),
  '23514', 'the table refuses a 40-day validity as well (the new check governs every writer, even the owner)');
select is(pg_temp.st($$insert into servicing.foreclosure_quotes (lender_org_id, loan_account_id, lender_quote_ref, as_of, valid_until, principal_minor, interest_minor, charges_minor, prepayment_charge_minor, total_minor, source, reported_by)
  values ('ecb00000-0000-4000-8000-000000000001', (select id from servicing.loan_accounts where lms_loan_ref = 'DL-30'), 'q-table-ok', now() - interval '1 hour', now() + interval '20 days', 1, 0, 0, 0, 1, 'lender_portal', 'ec000000-0000-4000-8000-000000000001')$$),
  'ok', 'and accepts 20 days');

-- Staleness. DL-25: a report older than the quotation changes nothing; a later one with the same principal changes nothing; one with LESS principal does.
select pg_temp.as_user('ec000000-0000-4000-8000-000000000001');
select pg_temp.keep('q25', pg_temp.quote(pg_temp.lid('DL-25'), 'q-25', 48, '10000.00', '500.00', '100.00', '200.00', '10800.00', null, 'lender_portal', null, 2)::text);
select pg_temp.as_system();
select is((select lender_quote_ref from servicing.latest_valid_quote(pg_temp.lid('DL-25'))), 'q-25', 'a fresh quotation is offered');
select pg_temp.as_owner();
select pg_temp.snap('DL-25', 1, 'active', 900000, 3);
select pg_temp.snap('DL-25', 2, 'active', 1000000, 1);
select pg_temp.as_system();
select is((select lender_quote_ref from servicing.latest_valid_quote(pg_temp.lid('DL-25'))), 'q-25', 'a report from before its as-of time, and a later one with the same principal, leave it payable');
select pg_temp.as_owner();
select pg_temp.snap('DL-25', 3, 'active', 900000, 0.5);
select pg_temp.as_system();
select is((select count(*) from servicing.latest_valid_quote(pg_temp.lid('DL-25'))), 0::bigint, 'M15: a later report showing LESS principal outstanding makes it stale: nothing is offered');
-- DL-26: a receipt reported after the as-of time.
select pg_temp.as_user('ec000000-0000-4000-8000-000000000001');
select pg_temp.quote(pg_temp.lid('DL-26'), 'q-26', 48, '10000.00', '500.00', '100.00', '200.00', '10800.00', null, 'lender_portal', null, 2);
select pg_temp.as_owner();
select pg_temp.rcpt('DL-26', 'RC-26-OLD', 3);
select pg_temp.as_system();
select is((select lender_quote_ref from servicing.latest_valid_quote(pg_temp.lid('DL-26'))), 'q-26', 'a receipt reported BEFORE the as-of time leaves the quotation payable');
select pg_temp.as_owner();
select pg_temp.rcpt('DL-26', 'RC-26-NEW', 1);
select pg_temp.as_system();
select is((select count(*) from servicing.latest_valid_quote(pg_temp.lid('DL-26'))), 0::bigint, 'M15: a receipt reported AFTER it makes it stale (the borrower would pay the instalment twice)');
-- DL-27: the loan is no longer active.
select pg_temp.as_user('ec000000-0000-4000-8000-000000000001');
select pg_temp.quote(pg_temp.lid('DL-27'), 'q-27', 48, '10000.00', '500.00', '100.00', '200.00', '10800.00', null, 'lender_portal', null, 2);
select pg_temp.as_owner();
select pg_temp.snap('DL-27', 1, 'closed', 0, 1);
select pg_temp.as_system();
select is((select count(*) from servicing.latest_valid_quote(pg_temp.lid('DL-27'))), 0::bigint, 'M15: a later report that the loan is closed makes it stale');
-- DL-28: the NEWEST quotation decides; an older one never takes its place when the newer one goes stale.
select pg_temp.as_user('ec000000-0000-4000-8000-000000000001');
select pg_temp.quote(pg_temp.lid('DL-28'), 'q-28-old', 48, '9000.00', '500.00', '100.00', '200.00', '9800.00', null, 'lender_portal', null, 3);
select pg_temp.quote(pg_temp.lid('DL-28'), 'q-28-new', 48, '10000.00', '500.00', '100.00', '200.00', '10800.00', null, 'lender_portal', null, 2);
select pg_temp.as_system();
select is((select lender_quote_ref from servicing.latest_valid_quote(pg_temp.lid('DL-28'))), 'q-28-new', 'the newer quotation is the one offered');
select pg_temp.as_owner();
select pg_temp.snap('DL-28', 1, 'active', 950000, 1);
select pg_temp.as_system();
select is((select count(*) from servicing.latest_valid_quote(pg_temp.lid('DL-28'))), 0::bigint, 'M15: when the newer quotation goes stale the older one (still consistent with the report) is NOT offered in its place');

-- M18: the lender user who reported a quotation is not handed to the borrower or the system.
select pg_temp.as_user('ec000000-0000-4000-8000-000000000001');
select pg_temp.quote(pg_temp.lid('DL-29'), 'q-29', 48);
select pg_temp.as_user('ec000000-0000-4000-8000-000000000005');
select is((select (lender_quote_ref, reported_by is null)::text from servicing.latest_valid_quote(pg_temp.lid('DL-29'))), '(q-29,t)', 'M18: the borrower gets the quotation without the id of the lender user who reported it');
select pg_temp.as_system();
select is((select (lender_quote_ref, reported_by is null)::text from servicing.latest_valid_quote(pg_temp.lid('DL-29'))), '(q-29,t)', 'nor does the system');
select pg_temp.as_user('ec000000-0000-4000-8000-000000000003');
select is((select reported_by::text from servicing.latest_valid_quote(pg_temp.lid('DL-29'))), 'ec000000-0000-4000-8000-000000000001', 'the lender''s own readers (loan.read) still see who reported it');
select pg_temp.as_user('ec000000-0000-4000-8000-000000000004');
select is((select count(*) from servicing.latest_valid_quote(pg_temp.lid('DL-29'))), 0::bigint, 'another lender sees nothing');
select pg_temp.as_user('ec000000-0000-4000-8000-000000000006');
select is((select count(*) from servicing.latest_valid_quote(pg_temp.lid('DL-29'))), 0::bigint, 'nor another borrower');

-- ============================================================================================================================
-- 13. The machine-feed gate at use time (M16) and the system role without a feed (M21 b)
-- ============================================================================================================================
-- Lender Y has an ACTIVE mock connection (section 5) declaring the closure-documents capability, and a loan the lender reported closed.
select pg_temp.as_owner();
select set_config('udofin.allow_mock_providers', 'on', true);
update servicing.lms_connections set capabilities = '{"closure_documents":true}' where lender_org_id = 'ecb00000-0000-4000-8000-000000000002';
update servicing.loan_accounts set status = 'closed' where lms_loan_ref = 'LY1';
select set_config('udofin.allow_mock_providers', '', true);
select pg_temp.as_system();
select is(pg_temp.err(format($$select servicing.open_security_release_tasks(%L, array['other'])$$, pg_temp.lid('LY1'))), '42501|mock_provider_blocked',
  'M16: a mock feed left active in a session that does not allow mock providers opens no release task');
select is(pg_temp.err(format($$select pg_temp.reg(%L, 'noc', 'mock-ly1', null, null, null, null, 'mock')$$, pg_temp.lid('LY1'))), '42501|mock_provider_blocked', 'and registers no document');
select pg_temp.as_owner();
select set_config('udofin.allow_mock_providers', 'on', true);
select pg_temp.as_system();
select is(pg_temp.err(format($$select servicing.open_security_release_tasks(%L, array['other'])$$, pg_temp.lid('LY1'))), 'ok', 'the same call in a session that allows mock providers works (the control)');
select pg_temp.as_owner();
select set_config('udofin.allow_mock_providers', '', true);
select pg_temp.as_system();
select is(pg_temp.err(format($$select servicing.open_security_release_tasks(%L, array['mutual_fund_lien'])$$, pg_temp.lid('DL-12'))), '55000|feed_not_active',
  'M21: for a lender without a machine feed (file connection) the system role cannot open release tasks');
select is(pg_temp.err(format($$select pg_temp.reg(%L, 'noc', 'mock-dl12', null, null, null, null, 'mock')$$, pg_temp.lid('DL-12'))), '55000|feed_not_active', 'nor register a mock document');

-- ============================================================================================================================
-- 14. Concurrency: the row is locked before its status is read (A7)
-- ============================================================================================================================
select pg_temp.as_owner();
select ok((select bool_and(pg_get_functiondef(f::regprocedure) like '%for update%')
           from unnest(array['servicing.confirm_security_release(uuid, text)', 'servicing.set_security_release_delay_reason(uuid, text)', 'servicing.decline_document_request(uuid, text)']) f),
  'A7: confirm, delay reason and decline lock the task or request row before they read its status (a concurrent loser reaches the already_confirmed / request_not_open branch)');
select pg_temp.as_user('ec000000-0000-4000-8000-000000000001');
select is(pg_temp.err(format($$select servicing.confirm_security_release(%L, 'SAMPLE-CONF-A7')$$, pg_temp.got('task1'))), 'ok', 'the lender confirms the release task');
select is(pg_temp.err(format($$select servicing.confirm_security_release(%L, 'SAMPLE-CONF-A7')$$, pg_temp.got('task1'))), '55000|already_confirmed', 'a second confirmation gets already_confirmed');
select is(pg_temp.err(format($$select servicing.set_security_release_delay_reason(%L, 'Waiting for the depository to act')$$, pg_temp.got('task1'))), '55000|already_confirmed', 'and so does a delay reason after the confirmation');
select is(pg_temp.err(format($$select servicing.decline_document_request(%L, 'The period requested is not yet closed')$$, pg_temp.got('rq_decl'))), '55000|request_not_open', 'a second decision on a request gets request_not_open');

-- ============================================================================================================================
-- 15. The security-release evidence label (U44)
-- ============================================================================================================================
select pg_temp.as_owner();
select is((select evidence_status from documents.applicability_rules where rule_key = 'servicing.security_release_sla_days' and version = 1), 'likely',
  'U44: the security-release rule is labelled likely, not confirmed (its application to the product categories rests on a cross-reference that was not read)');
select ok((select exclusions like '%Evidence label: likely%' and exclusions like '%para 6(11)%' and exclusions like '%NOT confirmed%' and exclusions not like '%confirmed in text%'
           from documents.applicability_rules where rule_key = 'servicing.security_release_sla_days' and version = 1), 'and its text says so');
select is((select array_agg(rule_key || '=' || evidence_status order by rule_key) from documents.applicability_rules where rule_key in ('servicing.noc_sla_days_default', 'servicing.statement_sla_days_default') and version = 1),
  array['servicing.noc_sla_days_default=unverified', 'servicing.statement_sla_days_default=unverified'], 'the two platform defaults stay unverified');

-- ============================================================================================================================
-- 16. Unsafe-text triggers across the phase (U42): one refusal per guarded column, and a control that an ordinary text is not what stops the insert
-- ============================================================================================================================
select pg_temp.as_owner();
select is((select array_agg(p) from unnest(array[
    'servicing.feature_change_requests|reason', 'servicing.feature_change_requests|decision_note',
    'payments.account_format_rules|source_note', 'payments.account_format_rules|approval_note', 'payments.account_format_rules|retired_reason',
    'payments.provider_register|display_name', 'payments.provider_register|authorisation_evidence_ref', 'payments.provider_register|status_reason',
    'payments.fingerprint_key_versions|note',
    'payments.account_registry|legal_owner_name', 'payments.account_registry|evidence_ref', 'payments.account_registry|verification_note',
    'payments.account_registry|rejection_reason', 'payments.account_registry|revoked_reason',
    'payments.merchant_registry|revoked_reason',
    'payments.lender_payment_configs|evidence_ref', 'payments.lender_payment_configs|contract_section_ref', 'payments.lender_payment_configs|status_reason',
    'payments.lender_payment_configs|rail_limits_source',
    'payments.reconciliation_exception_events|note',
    'servicing.reminder_templates|body',
    'servicing.penal_charge_texts|reason', 'servicing.penal_charge_texts|sentence_en', 'servicing.penal_charge_texts|sentence_hi',
    'servicing.communication_holds|note', 'servicing.communication_holds|release_note',
    'servicing.import_batches|reject_reason', 'servicing.sync_conflicts|resolution_note']) p
  where pg_temp.err(format('insert into %s (' || case when split_part(p, '|', 1) = 'payments.lender_payment_configs' then 'provider_mode, ' else '' end || '%I) values (' ||
           case when split_part(p, '|', 1) = 'payments.lender_payment_configs' then '''production'', ' else '' end || '%L)', split_part(p, '|', 1), split_part(p, '|', 2), 'Call 98765 43210 or use ABCDE1234F')) <> '22023|unsafe_free_text'), null,
  'U42: every guarded free-text column of the phase refuses a text with a mobile number and a PAN with the hint unsafe_free_text, even from the table owner (28 columns)');
select is((select array_agg(p) from unnest(array[
    'servicing.feature_change_requests|reason', 'payments.account_registry|evidence_ref', 'payments.provider_register|status_reason', 'payments.lender_payment_configs|rail_limits_source',
    'servicing.communication_holds|note', 'servicing.penal_charge_texts|sentence_en', 'servicing.import_batches|reject_reason', 'servicing.sync_conflicts|resolution_note']) p
  where pg_temp.err(format('insert into %s (' || case when split_part(p, '|', 1) = 'payments.lender_payment_configs' then 'provider_mode, ' else '' end || '%I) values (' ||
           case when split_part(p, '|', 1) = 'payments.lender_payment_configs' then '''production'', ' else '' end || '%L)', split_part(p, '|', 1), split_part(p, '|', 2), 'An ordinary text without identifiers')) = '22023|unsafe_free_text'), null,
  'and an ordinary text is not refused by the guard (the control: the refusal above comes from the trigger, not from another constraint)');

select * from finish();
rollback;
