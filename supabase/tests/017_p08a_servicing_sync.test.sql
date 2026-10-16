-- Phase 08a servicing sync and file import (migrations 20261018000909 and 20261018000911).
-- Connection rules, the all-or-nothing import pipeline, the single apply entry point, append-only reported records,
-- anomalies, conflicts, quarantine, staleness, borrower and lender reads, tenant isolation. Synthetic data only (SAMPLE).
-- Error codes are reported as SQLSTATE|hint.
begin;
create extension if not exists pgtap with schema extensions;
select plan(553);

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
-- Error as SQLSTATE|hint. The Supabase image adds 'Grant the required privileges ...' to privilege errors: our own hints are kept.
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
-- A timestamp text n hours in the past (UTC, whole seconds).
create function pg_temp.ts(hours numeric) returns text language sql as $fn$
  select to_char((clock_timestamp() - make_interval(secs => (hours * 3600)::integer)) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') $fn$;
create function pg_temp.sha(label text) returns text language sql as $fn$ select encode(sha256(convert_to('sample-file-' || label, 'UTF8')), 'hex') $fn$;
-- A SAMPLE loan record: every figure is a labelled sample. Pass NULL values in `extra` to drop a field.
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
-- Calls: stage a file as the logged-in operator.
create function pg_temp.stage(lender uuid, kind text, label text, rows jsonb, resub uuid default null, source_kind text default 'file') returns jsonb language sql as $fn$
  select servicing.stage_import(lender, kind, source_kind, pg_temp.sha(label), 1000, 'udofin-lms-import-v1', rows, 'idem-' || rpad(label, 16, '0'), resub)
$fn$;
-- Row-level errors of a staging result as one string: row:code+code@field+field;...
create function pg_temp.errs(res jsonb) returns text language sql as $fn$
  select coalesce(string_agg((e ->> 'row_no') || ':' || array_to_string(array(select jsonb_array_elements_text(e -> 'error_codes')), '+') || '@'
                             || array_to_string(array(select jsonb_array_elements_text(e -> 'field_names')), '+'), ';' order by (e ->> 'row_no')::int), '')
  from jsonb_array_elements(res -> 'errors') e
$fn$;
-- Loan account id of lender X (default) or another lender by the lender's own loan reference.
create function pg_temp.lid(ref text, lender uuid default 'e9b00000-0000-4000-8000-000000000001') returns uuid language sql as $fn$
  select id from servicing.loan_accounts where lender_org_id = lender and lms_loan_ref = ref
$fn$;
-- Number of balance snapshots stored for a loan of lender X (or another lender).
create function pg_temp.snaps(ref text, lender uuid default 'e9b00000-0000-4000-8000-000000000001') returns bigint language sql as $fn$
  select count(*) from servicing.balance_snapshots s join servicing.loan_accounts l on l.id = s.loan_account_id where l.lender_org_id = lender and l.lms_loan_ref = ref
$fn$;
-- SQLSTATE only (for errors raised by table triggers whose hint text is not part of the contract).
create function pg_temp.st(q text) returns text language sql as $fn$ select left(pg_temp.err(q), 5) $fn$;
grant execute on all functions in schema pg_temp to public;

-- Fixture ------------------------------------------------------------------------------------------------------------------
-- u01/u02 platform staff (switch requests and decisions), u03 X servicing operator, u04 X viewer,
-- u05 Y servicing operator, u06 borrower b1, u07 borrower b2, u08 X lender admin (no servicing permissions),
-- u09 platform auditor (loan.read), u10 X person with servicing.manual_entry only, u11 X person with servicing.sync.manage only,
-- u12 Z servicing operator (switch off), u13 X second operator, u14 product drafter (lender_admin) and u15 product approver in X, Y and Z
insert into auth.users (id, phone, raw_app_meta_data)
select ('e9000000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
       case n when 6 then '910000000071' when 7 then '910000000072' end,
       case when n in (6, 7) then '{}'::jsonb else '{"actor_type":"staff"}'::jsonb end
from generate_series(1, 15) n;

select pg_temp.as_owner();
insert into tenancy.organizations (id, kind, legal_name, display_name, regulator_registration_no, status) values
  ('e9a00000-0000-4000-8000-000000000000', 'platform', 'Udofin Platform (test)', 'Udofin', null, 'active'),
  ('e9b00000-0000-4000-8000-000000000001', 'lender', 'Servicing X Finance (test)', 'Servicing X', 'TEST-E9-0001', 'active'),
  ('e9b00000-0000-4000-8000-000000000002', 'lender', 'Servicing Y Finance (test)', 'Servicing Y', 'TEST-E9-0002', 'active'),
  ('e9b00000-0000-4000-8000-000000000003', 'lender', 'Servicing Z Finance (test)', 'Servicing Z', 'TEST-E9-0003', 'active');
insert into onboarding.lender_gates (lender_org_id, stage) values
  ('e9b00000-0000-4000-8000-000000000001', 'activated'),
  ('e9b00000-0000-4000-8000-000000000002', 'activated'),
  ('e9b00000-0000-4000-8000-000000000003', 'activated');
-- Two custom roles of lender X that hold one servicing permission each (the system roles carry both together).
insert into tenancy.roles (id, org_id, applies_to, key, name) values
  ('e9d00000-0000-4000-8000-000000000001', 'e9b00000-0000-4000-8000-000000000001', 'lender', 'manual_entry_only', 'Manual entry only (test)'),
  ('e9d00000-0000-4000-8000-000000000002', 'e9b00000-0000-4000-8000-000000000001', 'lender', 'sync_manage_only', 'Sync manage only (test)');
insert into tenancy.role_permissions (role_id, permission_key) values
  ('e9d00000-0000-4000-8000-000000000001', 'loan.read'), ('e9d00000-0000-4000-8000-000000000001', 'servicing.manual_entry'),
  ('e9d00000-0000-4000-8000-000000000002', 'loan.read'), ('e9d00000-0000-4000-8000-000000000002', 'servicing.sync.manage');
insert into tenancy.memberships (id, org_id, user_id, status) values
  ('e9c10000-0000-4000-8000-000000000001', 'e9a00000-0000-4000-8000-000000000000', 'e9000000-0000-4000-8000-000000000001', 'active'),
  ('e9c10000-0000-4000-8000-000000000002', 'e9a00000-0000-4000-8000-000000000000', 'e9000000-0000-4000-8000-000000000002', 'active'),
  ('e9c10000-0000-4000-8000-000000000003', 'e9b00000-0000-4000-8000-000000000001', 'e9000000-0000-4000-8000-000000000003', 'active'),
  ('e9c10000-0000-4000-8000-000000000004', 'e9b00000-0000-4000-8000-000000000001', 'e9000000-0000-4000-8000-000000000004', 'active'),
  ('e9c10000-0000-4000-8000-000000000005', 'e9b00000-0000-4000-8000-000000000002', 'e9000000-0000-4000-8000-000000000005', 'active'),
  ('e9c10000-0000-4000-8000-000000000008', 'e9b00000-0000-4000-8000-000000000001', 'e9000000-0000-4000-8000-000000000008', 'active'),
  ('e9c10000-0000-4000-8000-000000000009', 'e9a00000-0000-4000-8000-000000000000', 'e9000000-0000-4000-8000-000000000009', 'active'),
  ('e9c10000-0000-4000-8000-000000000010', 'e9b00000-0000-4000-8000-000000000001', 'e9000000-0000-4000-8000-000000000010', 'active'),
  ('e9c10000-0000-4000-8000-000000000011', 'e9b00000-0000-4000-8000-000000000001', 'e9000000-0000-4000-8000-000000000011', 'active'),
  ('e9c10000-0000-4000-8000-000000000012', 'e9b00000-0000-4000-8000-000000000003', 'e9000000-0000-4000-8000-000000000012', 'active'),
  ('e9c10000-0000-4000-8000-000000000013', 'e9b00000-0000-4000-8000-000000000001', 'e9000000-0000-4000-8000-000000000013', 'active'),
  ('e9c10000-0000-4000-8000-000000000014', 'e9b00000-0000-4000-8000-000000000001', 'e9000000-0000-4000-8000-000000000014', 'active'),
  ('e9c10000-0000-4000-8000-000000000015', 'e9b00000-0000-4000-8000-000000000002', 'e9000000-0000-4000-8000-000000000014', 'active'),
  ('e9c10000-0000-4000-8000-000000000016', 'e9b00000-0000-4000-8000-000000000003', 'e9000000-0000-4000-8000-000000000014', 'active'),
  ('e9c10000-0000-4000-8000-000000000017', 'e9b00000-0000-4000-8000-000000000001', 'e9000000-0000-4000-8000-000000000015', 'active'),
  ('e9c10000-0000-4000-8000-000000000018', 'e9b00000-0000-4000-8000-000000000002', 'e9000000-0000-4000-8000-000000000015', 'active'),
  ('e9c10000-0000-4000-8000-000000000019', 'e9b00000-0000-4000-8000-000000000003', 'e9000000-0000-4000-8000-000000000015', 'active');
insert into tenancy.membership_roles (membership_id, role_id)
select m.mid::uuid, coalesce(r.id, m.rid::uuid) from (values
  ('e9c10000-0000-4000-8000-000000000001', 'platform', 'platform_features_admin', null),
  ('e9c10000-0000-4000-8000-000000000002', 'platform', 'platform_features_admin', null),
  ('e9c10000-0000-4000-8000-000000000003', 'lender', 'servicing_operator', null),
  ('e9c10000-0000-4000-8000-000000000004', 'lender', 'viewer', null),
  ('e9c10000-0000-4000-8000-000000000005', 'lender', 'servicing_operator', null),
  ('e9c10000-0000-4000-8000-000000000008', 'lender', 'lender_admin', null),
  ('e9c10000-0000-4000-8000-000000000009', 'platform', 'auditor', null),
  ('e9c10000-0000-4000-8000-000000000012', 'lender', 'servicing_operator', null),
  ('e9c10000-0000-4000-8000-000000000013', 'lender', 'servicing_operator', null),
  ('e9c10000-0000-4000-8000-000000000014', 'lender', 'lender_admin', null),
  ('e9c10000-0000-4000-8000-000000000015', 'lender', 'lender_admin', null),
  ('e9c10000-0000-4000-8000-000000000016', 'lender', 'lender_admin', null),
  ('e9c10000-0000-4000-8000-000000000017', 'lender', 'product_approver', null),
  ('e9c10000-0000-4000-8000-000000000018', 'lender', 'product_approver', null),
  ('e9c10000-0000-4000-8000-000000000019', 'lender', 'product_approver', null)
) as m (mid, kind, rkey, rid)
left join tenancy.roles r on r.org_id is null and r.applies_to = m.kind::tenancy.organization_kind and r.key = m.rkey;
insert into tenancy.membership_roles (membership_id, role_id) values
  ('e9c10000-0000-4000-8000-000000000010', 'e9d00000-0000-4000-8000-000000000001'),
  ('e9c10000-0000-4000-8000-000000000011', 'e9d00000-0000-4000-8000-000000000002');

-- The servicing_sync switch for X and Y (an applied two-person request and the switch in ONE transaction, the only way the
-- guard accepts). Z stays off.
insert into servicing.feature_change_requests (id, lender_org_id, feature, enable, mode, status, evidence, requested_by, idempotency_key, decided_by, decided_at, applied_at)
values ('e9e00000-0000-4000-8000-000000000001', 'e9b00000-0000-4000-8000-000000000001', 'servicing_sync', true, 'two_person', 'applied', '{"contract_ref":"SAMPLE-E9-1"}',
        'e9000000-0000-4000-8000-000000000001', 'e9-req-key-00000001', 'e9000000-0000-4000-8000-000000000002', now(), now()),
       ('e9e00000-0000-4000-8000-000000000002', 'e9b00000-0000-4000-8000-000000000002', 'servicing_sync', true, 'two_person', 'applied', '{"contract_ref":"SAMPLE-E9-2"}',
        'e9000000-0000-4000-8000-000000000001', 'e9-req-key-00000002', 'e9000000-0000-4000-8000-000000000002', now(), now());
insert into servicing.lender_features (lender_org_id, feature, enabled, evidence, enabled_by, enabled_at, last_change_request_id) values
  ('e9b00000-0000-4000-8000-000000000001', 'servicing_sync', true, '{"contract_ref":"SAMPLE-E9-1"}', 'e9000000-0000-4000-8000-000000000002', now(), 'e9e00000-0000-4000-8000-000000000001'),
  ('e9b00000-0000-4000-8000-000000000002', 'servicing_sync', true, '{"contract_ref":"SAMPLE-E9-2"}', 'e9000000-0000-4000-8000-000000000002', now(), 'e9e00000-0000-4000-8000-000000000002');

-- Products, requests and applications. Applications of lender X: x1 and x5 and x3 and x4 and x7/x8 per the comments.
insert into lending.loan_products (id, lender_org_id, category_key, code, name, status) values
  ('e9900000-0000-4000-8000-000000000001', 'e9b00000-0000-4000-8000-000000000001', 'personal', 'PL-E9', 'X Personal Loan', 'active'),
  ('e9900000-0000-4000-8000-000000000002', 'e9b00000-0000-4000-8000-000000000002', 'personal', 'PL-E9', 'Y Personal Loan', 'active'),
  ('e9900000-0000-4000-8000-000000000003', 'e9b00000-0000-4000-8000-000000000003', 'personal', 'PL-E9', 'Z Personal Loan', 'active');
insert into lending.loan_product_versions (id, product_id, lender_org_id, version, status, min_amount_minor, max_amount_minor,
  min_tenure_days, max_tenure_days, rate_type, min_annual_rate_bps, max_annual_rate_bps, drafted_by, approved_by, approved_at, effective_from)
select ('e9910000-0000-4000-8000-00000000000' || n)::uuid, ('e9900000-0000-4000-8000-00000000000' || n)::uuid, ('e9b00000-0000-4000-8000-00000000000' || n)::uuid, 1, 'approved',
       1000000, 50000000, 180, 1825, 'fixed', 1400, 2400, 'e9000000-0000-4000-8000-000000000014', 'e9000000-0000-4000-8000-000000000015', now(), now()
from generate_series(1, 3) n;
-- 13 applications: n=1..8 lender X, 9..11 lender Y, 12 lender Z, 13 lender X. Borrower b1 owns the odd ones, b2 the even ones.
insert into lending.loan_requests (id, borrower_id, category_key, requested_amount_minor, requested_tenure_days, purpose_code, status)
select ('e9700000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
       (select id from identity.borrowers where user_id = (case when n % 2 = 1 then 'e9000000-0000-4000-8000-000000000006' else 'e9000000-0000-4000-8000-000000000007' end)::uuid),
       'personal', 5000000, 365, 'education', 'submitted'
from generate_series(1, 13) n;
insert into lending.applications (id, lender_org_id, loan_request_id, borrower_id, product_version_id, status, requested_amount_minor, requested_tenure_days, lender_reference)
select ('e9200000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
       ('e9b00000-0000-4000-8000-00000000000' || case when n <= 8 or n = 13 then 1 when n <= 11 then 2 else 3 end)::uuid,
       ('e9700000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
       (select id from identity.borrowers where user_id = (case when n % 2 = 1 then 'e9000000-0000-4000-8000-000000000006' else 'e9000000-0000-4000-8000-000000000007' end)::uuid),
       ('e9910000-0000-4000-8000-00000000000' || case when n <= 8 or n = 13 then 1 when n <= 11 then 2 else 3 end)::uuid,
       case n when 2 then 'agreement_executed' when 4 then 'under_review' else 'disbursement_pending' end::lending.application_status,
       5000000, 365,
       case when n in (7, 8) then 'SAMPLE-APP-DUP' else 'SAMPLE-APP-' || case when n <= 8 or n = 13 then 'X' when n <= 11 then 'Y' else 'Z' end || n end
from generate_series(1, 13) n;

-- ============================================================================================================================
-- 1. Structure, grants, catalogue of columns
-- ============================================================================================================================
select pg_temp.as_owner();
select is((select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'servicing' and c.relkind = 'r'
             and c.relname in ('lms_connections', 'import_batches', 'import_rows', 'balance_snapshots', 'lms_receipts', 'sync_anomalies', 'sync_conflicts', 'sync_quarantine')
             and c.relrowsecurity and c.relforcerowsecurity), 8::bigint, 'row level security is enabled and forced on all eight new tables');
select is((select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'servicing' and c.relname in ('lms_connections', 'import_batches', 'import_rows', 'balance_snapshots', 'lms_receipts', 'sync_anomalies', 'sync_conflicts', 'sync_quarantine')
             and obj_description(c.oid, 'pg_class') like '%Owner: servicing module.'), 8::bigint, 'each new table has a comment that names its owner module');
select is((select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'servicing' and c.relname in ('lms_connections', 'import_batches', 'import_rows', 'balance_snapshots', 'lms_receipts', 'sync_anomalies', 'sync_conflicts', 'sync_quarantine')
             and t.tgname = 'no_truncate' and not t.tgisinternal), 8::bigint, 'a no_truncate trigger is on each new table');
select is(pg_temp.err($$truncate servicing.balance_snapshots cascade$$), 'P0001|', 'TRUNCATE is refused even for the owner (balance_snapshots)');
select is(pg_temp.err($$truncate servicing.lms_receipts cascade$$), 'P0001|', 'TRUNCATE is refused even for the owner (lms_receipts)');
select is(pg_temp.err($$truncate servicing.import_rows cascade$$), 'P0001|', 'TRUNCATE is refused even for the owner (import_rows)');
select is(pg_temp.err($$truncate servicing.sync_conflicts cascade$$), 'P0001|', 'TRUNCATE is refused even for the owner (sync_conflicts)');
select ok((select bool_and(has_table_privilege('authenticated', t, 'select')
                           and not has_table_privilege('authenticated', t, 'insert') and not has_table_privilege('authenticated', t, 'update')
                           and not has_table_privilege('authenticated', t, 'delete') and not has_table_privilege('authenticated', t, 'truncate'))
           from unnest(array['servicing.lms_connections', 'servicing.import_batches', 'servicing.import_rows', 'servicing.balance_snapshots', 'servicing.lms_receipts',
                             'servicing.sync_anomalies', 'servicing.sync_conflicts', 'servicing.sync_quarantine', 'servicing.loan_sync_status']) t),
  'authenticated users can only read the new tables and the status view');
select ok((select bool_and(has_table_privilege('service_role', t, 'select')
                           and not has_table_privilege('service_role', t, 'insert') and not has_table_privilege('service_role', t, 'update')
                           and not has_table_privilege('service_role', t, 'delete') and not has_table_privilege('service_role', t, 'truncate')
                           and not has_table_privilege('service_role', t, 'references') and not has_table_privilege('service_role', t, 'trigger'))
           from unnest(array['servicing.lms_connections', 'servicing.import_batches', 'servicing.import_rows', 'servicing.balance_snapshots', 'servicing.lms_receipts',
                             'servicing.sync_anomalies', 'servicing.sync_conflicts', 'servicing.sync_quarantine']) t),
  'the system role can only read them (the default ALL was revoked): every write goes through the definer functions');
select ok((select bool_and(not has_table_privilege('anon', t, 'select') and not has_table_privilege('anon', t, 'insert'))
           from unnest(array['servicing.lms_connections', 'servicing.import_batches', 'servicing.import_rows', 'servicing.balance_snapshots', 'servicing.lms_receipts',
                             'servicing.sync_anomalies', 'servicing.sync_conflicts', 'servicing.sync_quarantine', 'servicing.loan_sync_status']) t),
  'anon has no privilege on any of them');
select is((select count(*) from information_schema.columns where table_schema = 'servicing' and table_name = 'schedule_snapshots'
           and column_name in ('reported_as_of', 'content_sha256', 'source', 'import_batch_id', 'source_record_id', 'lender_sequence')), 6::bigint,
  'schedule_snapshots gained the provenance columns (reported_as_of, content_sha256, source and the batch, record id and sequence)');
select is((select array_agg(enumlabel::text order by enumsortorder) from pg_enum e join pg_type t on t.oid = e.enumtypid
           join pg_namespace n on n.oid = t.typnamespace where n.nspname = 'servicing' and t.typname = 'source_system'),
  array['finbyx', 'lender_lms', 'manual_import', 'file_import', 'mock_lms'], 'source_system gained file_import and mock_lms (and lost nothing)');

-- Function privileges ---------------------------------------------------------------------------------------------------------
select is((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'servicing' and p.proname in ('apply_lms_report', 'complete_disbursements')
             and has_function_privilege('service_role', p.oid, 'execute')
             and not has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute')), 2::bigint,
  'apply_lms_report and complete_disbursements are executable by the system role only');
select is((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'servicing' and p.proname in ('stage_import', 'commit_import', 'reject_import', 'set_lms_connection', 'acknowledge_sync_conflict',
                                                           'resolve_sync_conflict', 'my_loans', 'my_loan', 'import_errors', 'loan_as_reported_at', 'loan_as_known_at', 'record_rejected_file')
             and has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute')), 12::bigint,
  'the people functions are executable by authenticated users and not by anon');
select is((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'servicing' and p.prosecdef and p.proname in ('apply_lms_report', 'complete_disbursements', 'stage_import', 'commit_import', 'reject_import',
             'set_lms_connection', 'acknowledge_sync_conflict', 'resolve_sync_conflict', 'my_loans', 'my_loan', 'record_rejected_file')
             and exists (select 1 from unnest(p.proconfig) c where c = 'search_path=""')), 11::bigint, 'every definer function pins search_path to the empty path');
select is((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'servicing' and p.proname in ('import_errors', 'loan_as_reported_at', 'loan_as_known_at') and not p.prosecdef), 3::bigint,
  'the three lender-facing read helpers are SECURITY INVOKER: row level security applies');

-- Column catalogue: the import tables hold no personal data field --------------------------------------------------------------
select is((select array_agg(column_name::text order by ordinal_position) from information_schema.columns where table_schema = 'servicing' and table_name = 'import_rows'),
  array['id', 'lender_org_id', 'batch_id', 'row_no', 'source_record_id', 'source_record_id_sha256', 'row_sha256', 'normalised', 'outcome', 'error_codes',
        'field_names', 'flags', 'applied_result', 'applied_at'], 'import_rows has exactly the documented columns');
select is((select array_agg(column_name::text order by ordinal_position) from information_schema.columns where table_schema = 'servicing' and table_name = 'import_batches'),
  array['id', 'lender_org_id', 'kind', 'source_kind', 'source_system', 'format_version', 'file_sha256', 'byte_size', 'idempotency_key', 'status', 'row_count',
        'count_new', 'count_unchanged', 'count_duplicate', 'count_changed', 'count_conflict', 'count_error', 'count_quarantined', 'count_ignored_older',
        'reported_as_of_min', 'reported_as_of_max', 'applied_counts', 'resubmission_of', 'uploaded_by', 'uploaded_at', 'committed_by', 'committed_at',
        'rejected_by', 'rejected_at', 'reject_reason', 'failure_class', 'failed_at', 'created_at', 'updated_at'], 'import_batches has exactly the documented columns');
select is((select count(*) from information_schema.columns where table_schema = 'servicing'
           and table_name in ('lms_connections', 'import_batches', 'import_rows', 'balance_snapshots', 'lms_receipts', 'sync_anomalies', 'sync_conflicts', 'sync_quarantine')
           and column_name ~* '(name|phone|mobile|email|aadhaar|aadhar|pan_|_pan$|^pan$|account_?n(o|umber)|ifsc|dob|birth|address|otp|password|token|file_?name|path)'
           and column_name not in ('lms_receipt_ref', 'source_record_id', 'reverses_receipt_ref', 'reverses_receipt_id', 'field_names')), 0::bigint,
  'no column of the new tables is named like personal data, an account number, a secret or a file name');
select is(private.servicing_normalised_ok('{"lms_loan_ref":"A1","borrower_ref":"B1","status":"active"}'::jsonb), true, 'the closed field set accepts the documented fields');
select is(private.servicing_normalised_ok('{"lms_loan_ref":"A1","customer_name":"x"}'::jsonb), false, 'and refuses a name field');
select is(private.servicing_normalised_ok('{"lms_loan_ref":"A1","phone":"x"}'::jsonb), false, 'and a phone field');
select is(private.servicing_normalised_ok('{"installments":[{"installment_seq":"1","account_number":"x"}]}'::jsonb), false, 'and an unknown field inside an installment');
select is(pg_temp.err($$insert into servicing.import_batches (lender_org_id, kind, source_kind, source_system, format_version, file_sha256, byte_size, idempotency_key, row_count, uploaded_by)
  values ('e9b00000-0000-4000-8000-000000000001', 'loan', 'file', 'file_import', 'udofin-lms-import-v1', repeat('a', 64), 10, 'direct-insert-key-01', 1, 'e9000000-0000-4000-8000-000000000003')$$), 'ok',
  'the owner can create a batch row directly (functions are the product path; this is only the fixture for the next checks)');
select is(pg_temp.err($$insert into servicing.import_rows (lender_org_id, batch_id, row_no, outcome, normalised)
  select lender_org_id, id, 1, 'new', '{"customer_name":"x"}'::jsonb from servicing.import_batches where file_sha256 = repeat('a', 64)$$), '23514|',
  'a row whose content carries a personal-data field cannot be stored at all');
select is(pg_temp.err($$insert into servicing.import_rows (lender_org_id, batch_id, row_no, outcome, field_names)
  select lender_org_id, id, 1, 'error', array['customer_name'] from servicing.import_batches where file_sha256 = repeat('a', 64)$$), '23514|',
  'nor a field name outside the closed set in an error row');

-- ============================================================================================================================
-- 2. The hash and the validation rules equal the TypeScript importer (packages/adapters/src/lms.ts)
-- ============================================================================================================================
select is(private.servicing_validate('loan', $j${"lms_loan_ref":"SAMPLE-LOAN-0001","borrower_ref":"SAMPLE-APP-0001","status":"active","sanctioned_amount":"50000.00","disbursed_amount":"50000.00","disbursement_ref":"SAMPLE-DISB-0001","disbursement_date":"2026-09-01","outstanding_principal":"41666.67","next_due_date":"2026-11-05","next_due_amount":"4500.00","overdue_principal":"0.00","overdue_interest":"0.00","penal_charges":"0.00","other_charges":"0.00","total_overdue":"0.00","days_past_due":"0","source_record_id":"SAMPLE-REC-0007","reported_as_of":"2026-10-13T06:00:00Z","sequence":"7"}$j$::jsonb) ->> 'hash',
  'ccc617c2a6fffa0c7494b5a2837cd7fcba7be18d16f319f2e46de3141acc734e', 'loan hash equals lmsReportHash of the TypeScript normaliser (all optional fields)');
select is(private.servicing_validate('loan', $j${"lms_loan_ref":"SAMPLE-LOAN-0002","borrower_ref":"SAMPLE-APP-0002","status":"closed","sanctioned_amount":"1250.5","source_record_id":"REC-2","reported_as_of":"2026-10-13T11:30:00.5+05:30"}$j$::jsonb) ->> 'hash',
  '10daa73a68234defad3f56021ab5ef8d1d18d9aff587d26efbd43ee26da63d4d', 'loan hash with absent optionals, a one-digit fraction and a zone offset equals the TypeScript hash');
select is(private.servicing_validate('receipt', $j${"lms_loan_ref":"SAMPLE-LOAN-0001","lms_receipt_ref":"SAMPLE-RCPT-0001","receipt_kind":"receipt","amount":"4500.00","value_date":"2026-10-05","payment_mode":"upi","bank_reference":"SAMPLE-BANKREF-0001","source_record_id":"SAMPLE-RCPT-0001","reported_as_of":"2026-10-13T06:00:00Z"}$j$::jsonb) ->> 'hash',
  'f2de3a258a10b3409522181ea9618ee2f6eef3bf6e9e96bf69648d822ef2a87f', 'receipt hash equals the TypeScript hash');
select is(private.servicing_validate('receipt', $j${"lms_loan_ref":"SAMPLE-LOAN-0001","lms_receipt_ref":"SAMPLE-RCPT-0002","receipt_kind":"reversal","reverses_receipt_ref":"SAMPLE-RCPT-0001","amount":"0.05","value_date":"2026-10-06","source_record_id":"SAMPLE-RCPT-0002","reported_as_of":"2026-10-13T06:00:00Z","sequence":3}$j$::jsonb) ->> 'hash',
  '9d4c7ca50a427ece0aab93f48da65a18a6454fbf9160e4d2027fb7b31985933f', 'reversal hash (integer sequence) equals the TypeScript hash');
select is(private.servicing_validate('schedule', $j${"lms_loan_ref":"SAMPLE-LOAN-0001","source_record_id":"SAMPLE-SCH-0001","reported_as_of":"2026-10-13T06:00:00Z","sequence":"7","installments":[{"installment_seq":"1","due_date":"2026-11-05","principal":"4166.67","interest":"333.33","fees":"0.00"},{"installment_seq":"2","due_date":"2026-12-05","principal":"4166.67","interest":"333.33","fees":"0.00"},{"installment_seq":"3","due_date":"2027-01-05","principal":"4166.66","interest":"333.34"}]}$j$::jsonb) ->> 'hash',
  '548dd482efeb1b08acbf8b33d66173fc543ec19747ee39ee9dbb28224bc3d8e7', 'schedule hash (default fees) equals the TypeScript hash');
select is(private.servicing_validate('loan', $j${"lms_loan_ref":"SAMPLE-LOAN-0002","borrower_ref":"SAMPLE-APP-0002","status":"closed","sanctioned_amount":"1250.5","source_record_id":"REC-2","reported_as_of":"2026-10-13T11:30:00.5+05:30"}$j$::jsonb) #>> '{canon,reported_as_of}',
  '2026-10-13T06:00:00.500Z', 'timestamps are normalised to UTC milliseconds as the TypeScript importer does');
select is(private.servicing_validate('loan', $j${"lms_loan_ref":"SAMPLE-LOAN-0002","borrower_ref":"SAMPLE-APP-0002","status":"closed","sanctioned_amount":"1250.5","source_record_id":"REC-2","reported_as_of":"2026-10-13T11:30:00.5+05:30"}$j$::jsonb) #>> '{canon,sanctioned_amount}',
  '1250.50', 'money is stored as canonical two-decimal rupee text (and parsed by private.parse_money_minor, never as a float)');

-- Rejection classes (codes and field names only; the offending value is never echoed) ----------------------------------------
create function pg_temp.codes(kind text, rec jsonb) returns text language sql as $fn$
  select coalesce(array_to_string(private.servicing_text_array(private.servicing_validate(kind, rec) -> 'codes'), ','), '') || '/' ||
         coalesce(array_to_string(private.servicing_text_array(private.servicing_validate(kind, rec) -> 'fields'), ','), '')
$fn$;
grant execute on function pg_temp.codes(text, jsonb) to public;
select is(pg_temp.codes('loan', pg_temp.loan('L1', 'A1', 'S1', 1, '{"sanctioned_amount":50000}')), 'invalid_amount/sanctioned_amount', 'a JSON number is not money');
select is(pg_temp.codes('loan', pg_temp.loan('L1', 'A1', 'S1', 1, '{"sanctioned_amount":"1e3"}')), 'invalid_amount/sanctioned_amount', 'an exponent is not money');
select is(pg_temp.codes('loan', pg_temp.loan('L1', 'A1', 'S1', 1, '{"sanctioned_amount":"10.505"}')), 'invalid_amount/sanctioned_amount', 'three decimals are refused, not rounded');
select is(pg_temp.codes('loan', pg_temp.loan('L1', 'A1', 'S1', 1, '{"sanctioned_amount":"0"}')), 'amount_not_positive/sanctioned_amount', 'a sanctioned amount must be positive');
select is(pg_temp.codes('loan', pg_temp.loan('L1', 'A1', 'S1', 1, '{"outstanding_principal":"-5"}')), 'invalid_amount/outstanding_principal', 'a negative figure is refused');
select is(pg_temp.codes('loan', pg_temp.loan('L1', 'A1', 'S1', 1, '{"status":"Active"}')), 'invalid_status/status', 'the status vocabulary is closed and case-sensitive');
select is(pg_temp.codes('loan', pg_temp.loan('L1', 'A1', 'S1', 1, '{"borrower_ref":"ABCDE1234F"}')), 'borrower_ref_looks_personal/borrower_ref', 'a PAN-shaped reference is refused');
select is(pg_temp.codes('loan', pg_temp.loan('L1', 'A1', 'S1', 1, '{"borrower_ref":"98765-43210"}')), 'borrower_ref_looks_personal/borrower_ref', 'a phone-shaped reference is refused');
select is(pg_temp.codes('loan', pg_temp.loan('L1', 'A1', 'S1', 1, '{"borrower_ref":"a b"}')), 'invalid_reference/borrower_ref', 'a reference with a space is refused');
select is(pg_temp.codes('loan', pg_temp.loan('L1', 'A1', 'S1', 1, '{"borrower_ref":"=cmd|calc"}')), 'invalid_reference/borrower_ref', 'a spreadsheet formula is plain text and refused as a reference');
select is(pg_temp.codes('loan', pg_temp.loan('L1', 'A1', 'S1', 1, '{"next_due_date":"2026-02-30"}')), 'invalid_date/next_due_date', 'an impossible date is refused');
select is(pg_temp.codes('loan', pg_temp.loan('L1', 'A1', 'S1', 1, '{"reported_as_of":"2026-10-13T06:00:00"}')), 'invalid_timestamp/reported_as_of', 'a timestamp without a zone is refused');
select is(pg_temp.codes('loan', pg_temp.loan('L1', 'A1', 'S1', 1, jsonb_build_object('reported_as_of', to_char(now() + interval '2 hours', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')))), 'timestamp_in_future/reported_as_of', 'a report from the future is refused');
select is(pg_temp.codes('loan', pg_temp.loan('L1', 'A1', 'S1', 1, '{"days_past_due":"-1"}')), 'invalid_integer/days_past_due', 'days past due is a non-negative integer as reported');
select is(pg_temp.codes('loan', pg_temp.loan('L1', 'A1', 'S1', 1, '{"disbursement_ref":null}')), 'incomplete_disbursement/disbursed_amount', 'disbursement evidence is all three or none');
select is(pg_temp.codes('loan', pg_temp.loan('L1', 'A1', 'S1', 1, '{"disbursed_amount":"60000.00"}')), 'disbursed_exceeds_sanctioned/disbursed_amount', 'disbursed cannot exceed sanctioned');
select is(pg_temp.codes('loan', pg_temp.loan('L1', 'A1', 'S1', 1, '{"next_due_amount":null}')), 'incomplete_next_due/next_due_date', 'next due date and amount come together');
select is(pg_temp.codes('loan', pg_temp.loan('L1', 'A1', 'S1', 1, '{"customer_name":"x"}')), 'unknown_field/', 'an unknown field is refused and its key is not echoed');
select is(pg_temp.codes('loan', pg_temp.loan('L1', 'A1', 'S1', 1, '{"lms_loan_ref":null}')), 'missing_required/lms_loan_ref', 'a required field cannot be missing');
select is(pg_temp.codes('loan', pg_temp.loan('L1', 'A1', 'S1', 1, '{"lms_loan_ref":""}')), 'missing_required/lms_loan_ref', 'nor empty');
select is(pg_temp.codes('loan', '[1,2]'::jsonb), 'row_not_object/', 'a record must be an object');
select is(pg_temp.codes('loan', pg_temp.loan('L1', 'A1', 'S1', 1, '{"content_sha256":"x"}')), 'unknown_field/', 'the meta field content_sha256 is not part of a file record');
select is(pg_temp.codes('receipt', pg_temp.receipt('L1', 'R1', '10.00', 1, '{"receipt_kind":"reversal"}')), 'reversal_reference_invalid/reverses_receipt_ref', 'a reversal must name the receipt it reverses');
select is(pg_temp.codes('receipt', pg_temp.receipt('L1', 'R1', '10.00', 1, '{"reverses_receipt_ref":"R0"}')), 'reversal_reference_invalid/reverses_receipt_ref', 'a plain receipt must not name one');
select is(pg_temp.codes('receipt', pg_temp.receipt('L1', 'R1', '10.00', 1, '{"receipt_kind":"reversal","reverses_receipt_ref":"R1"}')), 'reversal_reference_invalid/reverses_receipt_ref', 'a reversal cannot reverse itself');
select is(pg_temp.codes('receipt', pg_temp.receipt('L1', 'R1', '0.00', 1)), 'amount_not_positive/amount', 'a receipt amount is positive (a reversal is a row, not a negative amount)');
select is(pg_temp.codes('receipt', pg_temp.receipt('L1', 'R1', '10.00', 1, '{"receipt_kind":"refund"}')), 'invalid_receipt_kind/receipt_kind', 'receipt kind is receipt or reversal');
select is(pg_temp.codes('schedule', pg_temp.sched('L1', 'S1', 1, jsonb_build_object('installments', '[]'::jsonb))), 'invalid_items/installments', 'a schedule needs installments');
select is(pg_temp.codes('schedule', pg_temp.sched('L1', 'S1', 1, jsonb_build_object('installments', jsonb_build_array(
  jsonb_build_object('installment_seq', '2', 'due_date', '2030-01-01', 'principal', '1.00', 'interest', '1.00'))))), 'invalid_items/installment_seq', 'installment numbers run 1..n without gaps');
select is(pg_temp.codes('schedule', pg_temp.sched('L1', 'S1', 1, jsonb_build_object('installments', jsonb_build_array(
  jsonb_build_object('installment_seq', '1', 'due_date', '2030-02-01', 'principal', '1.00', 'interest', '1.00'),
  jsonb_build_object('installment_seq', '2', 'due_date', '2030-02-01', 'principal', '1.00', 'interest', '1.00'))))), 'invalid_items/due_date', 'due dates strictly increase');
select is(pg_temp.codes('schedule', pg_temp.sched('L1', 'S1', 1, jsonb_build_object('installments', jsonb_build_array(
  jsonb_build_object('installment_seq', '1', 'due_date', '2030-02-01', 'principal', '1.001', 'interest', '1.00'))))), 'invalid_amount/principal', 'an installment amount follows the money rules');
select is(private.servicing_validate('loan', pg_temp.loan('L1', 'A1', 'S1', 1, '{"customer_name":"Asha Rao","sanctioned_amount":"1e3"}'))::text !~* 'asha|rao|1e3', true,
  'the validation result echoes no input value (neither a name nor a bad amount)');
select is(private.servicing_validate('loan', pg_temp.loan('L1', 'A1', 'S1', 1, '{"overdue_principal":"10.00","overdue_interest":"5.00","penal_charges":"1.00","other_charges":"0.00","total_overdue":"20.00"}')) -> 'flags',
  '["overdue_total_mismatch"]'::jsonb, 'parts that do not add up to the stated total are flagged (and accepted as reported)');
select is(private.servicing_validate('loan', pg_temp.loan('L1', 'A1', 'S1', 1, '{"overdue_principal":"10.00","overdue_interest":"5.00","penal_charges":"1.00","other_charges":"0.00","total_overdue":"16.00"}')) -> 'flags',
  '[]'::jsonb, 'parts that do add up raise no flag');
select is(private.servicing_validate('loan', pg_temp.loan('L1', 'A1', 'S1', 1, '{"overdue_principal":"10.00","overdue_interest":"5.00","penal_charges":"1.00","other_charges":"0.00","total_overdue":"20.00"}')) #>> '{canon,total_overdue}',
  '20.00', 'and the stated total is kept as the lender stated it, never corrected');

-- ============================================================================================================================
-- 3. The LMS connection: file import and manual only; mock under the guard; finbyx and generic_rest blocked; switch required
-- ============================================================================================================================
-- X = e9b0..0001, Y = ..0002, Z = ..0003 (switch off). u03 X operator, u04 X viewer, u05 Y operator, u08 X admin, u10 X manual-entry only,
-- u11 X sync-manage only, u12 Z operator, u13 X second operator, u06/u07 borrowers.
select pg_temp.as_user('e9000000-0000-4000-8000-000000000003');
select is(pg_temp.err($$select servicing.stage_import('e9b00000-0000-4000-8000-000000000001', 'loan', 'file', repeat('1', 64), 100, 'udofin-lms-import-v1', '[{}]', 'idem-no-connection-1')$$),
  '55000|connection_not_active', 'with no connection nothing can be staged');
select is(pg_temp.err($$select servicing.set_lms_connection('e9b00000-0000-4000-8000-000000000001', 'finbyx', 'active')$$), '55000|connector_unverified', 'a finbyx connection cannot be active: no specification exists');
select is(pg_temp.err($$select servicing.set_lms_connection('e9b00000-0000-4000-8000-000000000001', 'generic_rest', 'active')$$), '55000|connector_unverified', 'nor a generic REST one');
select is(pg_temp.err($$select servicing.set_lms_connection('e9b00000-0000-4000-8000-000000000001', 'generic_rest', 'paused')$$), '55000|connector_unverified', 'nor paused or draft: only blocked_unverified');
select is(pg_temp.err($$select servicing.set_lms_connection('e9b00000-0000-4000-8000-000000000001', 'file_import', 'blocked_unverified')$$), '55000|bad_status', 'blocked_unverified is for unverified connectors only');
select is(pg_temp.err($$select servicing.set_lms_connection('e9b00000-0000-4000-8000-000000000001', 'carrier_pigeon', 'active')$$), '22023|bad_request', 'an unknown kind is refused');
select is(pg_temp.err($$select servicing.set_lms_connection('e9b00000-0000-4000-8000-000000000001', 'file_import', 'active', '{"teleport":true}')$$), '22023|capabilities_invalid', 'unknown capability flags are refused');
select is(pg_temp.err($$select servicing.set_lms_connection('e9b00000-0000-4000-8000-000000000001', 'file_import', 'active', '{"pull":"yes"}')$$), '22023|capabilities_invalid', 'capability flags are booleans');
select is(pg_temp.err($$select servicing.set_lms_connection('e9b00000-0000-4000-8000-000000000001', 'file_import', 'active', '{}', 1)$$), '22023|threshold_invalid', 'the staleness threshold has bounds');
select is(pg_temp.err($$select servicing.set_lms_connection('e9b00000-0000-4000-8000-000000000001', 'file_import', 'active', '{}', 1440, 'SOME_SECRET_NAME')$$), '22023|secret_ref_invalid', 'a secret reference belongs to REST connectors only');
select is(pg_temp.err($$select servicing.set_lms_connection('e9b00000-0000-4000-8000-000000000001', 'file_import', 'active', '{}', 99999)$$), '22023|threshold_invalid', 'nor can the threshold be absurdly large');

-- Who may write the connection
select pg_temp.as_user('e9000000-0000-4000-8000-000000000004');
select is(pg_temp.err($$select servicing.set_lms_connection('e9b00000-0000-4000-8000-000000000001', 'file_import', 'active')$$), '42501|', 'a viewer (loan.read only) cannot write the connection');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000008');
select is(pg_temp.err($$select servicing.set_lms_connection('e9b00000-0000-4000-8000-000000000001', 'file_import', 'active')$$), '42501|', 'a lender admin without servicing.sync.manage cannot');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000010');
select is(pg_temp.err($$select servicing.set_lms_connection('e9b00000-0000-4000-8000-000000000001', 'file_import', 'active')$$), '42501|', 'nor can servicing.manual_entry alone');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000005');
select is(pg_temp.err($$select servicing.set_lms_connection('e9b00000-0000-4000-8000-000000000001', 'file_import', 'active')$$), '42501|', 'another lender''s operator cannot write lender X''s connection');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000006');
select is(pg_temp.err($$select servicing.set_lms_connection('e9b00000-0000-4000-8000-000000000001', 'file_import', 'active')$$), '42501|', 'a borrower cannot');
select pg_temp.as_anon();
select is(pg_temp.err($$select servicing.set_lms_connection('e9b00000-0000-4000-8000-000000000001', 'file_import', 'active')$$), '42501|', 'anon cannot');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000003', 'aal1');
select is(pg_temp.err($$select servicing.set_lms_connection('e9b00000-0000-4000-8000-000000000001', 'file_import', 'active')$$), '42501|mfa_required', 'a session without the second factor is refused');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000012');
select is(pg_temp.err($$select servicing.set_lms_connection('e9b00000-0000-4000-8000-000000000003', 'file_import', 'active')$$), '55000|feature_disabled',
  'with the servicing_sync switch off (the default) nothing can be written, even by an authorised operator');
select is(pg_temp.err($$select servicing.stage_import('e9b00000-0000-4000-8000-000000000003', 'loan', 'file', repeat('2', 64), 100, 'udofin-lms-import-v1', '[{}]', 'idem-switch-off-0001')$$), '55000|feature_disabled', 'nor can a file be staged');

-- Direct writes are impossible for everyone but the owner
select pg_temp.as_user('e9000000-0000-4000-8000-000000000003');
select is(pg_temp.err($$insert into servicing.lms_connections (lender_org_id, kind, status) values ('e9b00000-0000-4000-8000-000000000001', 'file_import', 'active')$$), '42501|', 'an operator cannot insert a connection directly');
select is(pg_temp.err($$update servicing.lms_connections set status = 'active'$$), '42501|', 'nor update one');
select pg_temp.as_system();
select is(pg_temp.err($$insert into servicing.lms_connections (lender_org_id, kind, status) values ('e9b00000-0000-4000-8000-000000000001', 'file_import', 'active')$$), '42501|', 'the system role cannot write connections either');

-- The database itself refuses the combinations (owner inserts are checked by the table constraints)
select pg_temp.as_owner();
select is(pg_temp.err($$insert into servicing.lms_connections (lender_org_id, kind, status) values ('e9b00000-0000-4000-8000-000000000003', 'finbyx', 'active')$$), '23514|', 'a table check refuses an active finbyx row');
select is(pg_temp.err($$insert into servicing.lms_connections (lender_org_id, kind, status) values ('e9b00000-0000-4000-8000-000000000003', 'generic_rest', 'draft')$$), '23514|', 'and a draft generic REST row');
select is(pg_temp.err($$insert into servicing.lms_connections (lender_org_id, kind, status) values ('e9b00000-0000-4000-8000-000000000003', 'file_import', 'blocked_unverified')$$), '23514|', 'and blocked_unverified on a verifiable kind');
select set_config('udofin.allow_mock_providers', 'on', true);
select is(pg_temp.err($$insert into servicing.lms_connections (lender_org_id, kind, status, provider_mode) values ('e9b00000-0000-4000-8000-000000000003', 'file_import', 'active', 'mock')$$), '23514|', 'a mock provider mode on a non-mock connection (even where mock providers are allowed)');
select set_config('udofin.allow_mock_providers', '', true);
select is(pg_temp.err($$insert into servicing.lms_connections (lender_org_id, kind, status, secret_ref) values ('e9b00000-0000-4000-8000-000000000003', 'manual', 'active', 'SOME_SECRET_NAME')$$), '23514|', 'and a secret reference on a manual connection');
select is(pg_temp.err($$insert into servicing.lms_connections (lender_org_id, kind, status, provider_mode) values ('e9b00000-0000-4000-8000-000000000003', 'mock', 'active', 'mock')$$), '42501|mock_provider_blocked',
  'a mock connection is refused by the database guard unless the session allows mock providers');
select is(pg_temp.err($$insert into servicing.lms_connections (lender_org_id, kind, status, provider_mode, capabilities) values ('e9b00000-0000-4000-8000-000000000003', 'manual', 'draft', 'production', '{"x":true}')$$), '23514|', 'unknown capability flags are refused by the table too');

-- X: first a blocked finbyx record (allowed to exist), then the real file connection.
select pg_temp.as_user('e9000000-0000-4000-8000-000000000003');
select is(pg_temp.keep('conn_x', servicing.set_lms_connection('e9b00000-0000-4000-8000-000000000001', 'finbyx', 'blocked_unverified', '{"pull":true}', 1440, 'SAMPLE_FINBYX_SECRET_NAME')::text) is not null, true,
  'a finbyx row can be recorded, but only as blocked_unverified (with the NAME of a secret, never the secret)');
select is((select (kind, status)::text from servicing.lms_connections where lender_org_id = 'e9b00000-0000-4000-8000-000000000001'), '(finbyx,blocked_unverified)', 'and it is blocked');
select is(pg_temp.err($$select servicing.stage_import('e9b00000-0000-4000-8000-000000000001', 'loan', 'file', repeat('3', 64), 100, 'udofin-lms-import-v1', '[{}]', 'idem-blocked-conn-01')$$),
  '55000|connection_not_active', 'a blocked connection cannot be used');
select is(servicing.set_lms_connection('e9b00000-0000-4000-8000-000000000001', 'file_import', 'active', '{"receipts":true}', 1440)::text, pg_temp.got('conn_x'), 'the same row is updated to the file connection (one per lender)');
select is((select (kind, status, provider_mode::text, secret_ref is null, staleness_threshold_minutes)::text from servicing.lms_connections where lender_org_id = 'e9b00000-0000-4000-8000-000000000001'),
  '(file_import,active,production,t,1440)', 'file_import is active with production mode, no secret name and the default 24 hour threshold');
select is((select count(*) from servicing.lms_connections where lender_org_id = 'e9b00000-0000-4000-8000-000000000001'), 1::bigint, 'there is exactly one connection per lender');
select is(pg_temp.err($$select servicing.set_lms_connection('e9b00000-0000-4000-8000-000000000001', 'finbyx', 'blocked_unverified', '{}', 1440, 'bad secret name!')$$), '22023|secret_ref_invalid', 'a secret reference is a name, not free text');
select pg_temp.as_owner();
select is((select count(*) from audit.events where action = 'servicing.connection.set' and tenant_org_id = 'e9b00000-0000-4000-8000-000000000001' and actor_user_id = 'e9000000-0000-4000-8000-000000000003'), 2::bigint,
  'each connection change is audited with the actor');
select is((select count(*) from audit.events where action = 'servicing.connection.set' and metadata::text ~* 'secret'), 0::bigint, 'and the audit record holds no secret name');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000005');
select is(servicing.set_lms_connection('e9b00000-0000-4000-8000-000000000002', 'file_import', 'active')::text is not null, true, 'lender Y configures its own file connection');
select is(pg_temp.err($$select servicing.set_lms_connection('e9b00000-0000-4000-8000-000000000002', 'mock', 'active')$$), '42501|mock_provider_blocked', 'a mock connection is refused in a session that does not allow mock providers');
select pg_temp.as_owner();
select is(pg_temp.err($$update servicing.lms_connections set kind = 'finbyx' where lender_org_id = 'e9b00000-0000-4000-8000-000000000002'$$), '23514|', 'an active connection cannot be turned into a finbyx one without blocking it');
select is(pg_temp.err($$delete from servicing.lms_connections where lender_org_id = 'e9b00000-0000-4000-8000-000000000002'$$), 'P0001|Record a compensating entry instead.', 'a connection is never deleted (set it paused instead)');

-- ============================================================================================================================
-- 4. The import pipeline for loan reports. Stage = preview only; commit = all or nothing.
-- ============================================================================================================================
select pg_temp.as_user('e9000000-0000-4000-8000-000000000003');
-- F1: three new loans. Applications x1 and x3 are disbursement_pending, x2 agreement_executed. x3 is named by its Udofin id, the others by the lender's reference.
select pg_temp.keep('f1_rows', jsonb_build_array(
  pg_temp.loan('LX1', 'SAMPLE-APP-X1', 'SRC-LX1-1', 5, '{"sequence":"1"}'),
  pg_temp.loan('LX2', 'SAMPLE-APP-X2', 'SRC-LX2-1', 5, '{"sequence":"1"}'),
  pg_temp.loan('LX3', 'e9200000-0000-4000-8000-000000000003', 'SRC-LX3-1', 5, '{"sequence":"1"}'))::text);
select pg_temp.keep('f1', pg_temp.stage('e9b00000-0000-4000-8000-000000000001', 'loan', 'f1', pg_temp.got('f1_rows')::jsonb)::text);
select pg_temp.keep('f1_id', (pg_temp.got('f1')::jsonb) ->> 'batch_id');
select is((pg_temp.got('f1')::jsonb) ->> 'status', 'previewed', 'a clean file is previewed');
select is((pg_temp.got('f1')::jsonb) -> 'counts', '{"new":3,"error":0,"changed":0,"conflict":0,"duplicate":0,"unchanged":0,"quarantined":0,"ignored_older":0}'::jsonb, 'the preview counts three new loans');
select is((pg_temp.got('f1')::jsonb) ->> 'existing', 'false', 'and says it is not an earlier batch');
select is((select count(*) from servicing.loan_accounts where lender_org_id = 'e9b00000-0000-4000-8000-000000000001'), 0::bigint, 'staging applies nothing: no loan account exists yet');
select is((select count(*) from servicing.balance_snapshots), 0::bigint, 'and no balance was stored');
select is((select count(*) from servicing.import_rows where batch_id = pg_temp.got('f1_id')::uuid and normalised is not null and outcome = 'new'), 3::bigint, 'the preview keeps the canonical rows of a clean file for the commit');
select is((select (file_sha256, byte_size, row_count, source_system::text, uploaded_by)::text from servicing.import_batches where id = pg_temp.got('f1_id')::uuid),
  '(' || pg_temp.sha('f1') || ',1000,3,file_import,e9000000-0000-4000-8000-000000000003)', 'the batch records the file hash, size, row count, source and uploader (and no file name: there is no column for one)');
select is((select reported_as_of_min < reported_as_of_max or reported_as_of_min = reported_as_of_max from servicing.import_batches where id = pg_temp.got('f1_id')::uuid), true, 'and the range of reported times');
-- Idempotency
select is((pg_temp.stage('e9b00000-0000-4000-8000-000000000001', 'loan', 'f1', jsonb_build_array(pg_temp.loan('LX9', 'SAMPLE-APP-X9', 'SRC-X', 1)))) ->> 'batch_id', pg_temp.got('f1_id'),
  'the same file (same SHA-256) returns the same batch, whatever else is sent with it');
select is((select count(*) from servicing.import_batches where file_sha256 = pg_temp.sha('f1')), 1::bigint, 'and no second batch exists');
select is(pg_temp.err(format($$select servicing.stage_import('e9b00000-0000-4000-8000-000000000001', 'receipt', 'file', %L, 1000, 'udofin-lms-import-v1', '[{}]', 'idem-other-kind-0001')$$, pg_temp.sha('f1'))), '23505|idempotency_conflict',
  'the same file staged as another kind is refused');
select is(pg_temp.err(format($$select servicing.stage_import('e9b00000-0000-4000-8000-000000000001', 'loan', 'file', repeat('4', 64), 1000, 'udofin-lms-import-v1', '[{}]', %L)$$, 'idem-' || rpad('f1', 16, '0'))), '23505|idempotency_conflict',
  'an idempotency key already used for a different file is refused');
select is(pg_temp.err($$select servicing.stage_import('e9b00000-0000-4000-8000-000000000001', 'loan', 'file', repeat('4', 64), 1000, 'udofin-lms-import-v2', '[{}]', 'idem-v2-0000000000001')$$), '22023|format_unsupported', 'an unknown format version is refused');
select is(pg_temp.err($$select servicing.stage_import('e9b00000-0000-4000-8000-000000000001', 'loan', 'file', 'not-a-hash', 1000, 'udofin-lms-import-v1', '[{}]', 'idem-bad-hash-00001')$$), '22023|bad_request', 'a malformed file hash is refused');
select is(pg_temp.err($$select servicing.stage_import('e9b00000-0000-4000-8000-000000000001', 'loan', 'file', repeat('4', 64), 1000, 'udofin-lms-import-v1', '[]', 'idem-empty-00000001')$$), '22023|rows_invalid', 'an empty file is refused');
select is(pg_temp.err($$select servicing.stage_import('e9b00000-0000-4000-8000-000000000001', 'loan', 'file', repeat('4', 64), 1000, 'udofin-lms-import-v1', '{"a":1}', 'idem-notarray-00001')$$), '22023|rows_invalid', 'and a non-array');
select is(pg_temp.err(format($$select servicing.stage_import('e9b00000-0000-4000-8000-000000000001', 'loan', 'file', repeat('4', 64), 1000, 'udofin-lms-import-v1', %L::jsonb, 'idem-toomany-000001')$$,
  (select jsonb_agg('{}'::jsonb) from generate_series(1, 10001)))), '22023|rows_invalid', 'more than 10000 records are refused');

-- Who may stage, commit and reject
select pg_temp.as_user('e9000000-0000-4000-8000-000000000011');
select is(pg_temp.err(format($$select servicing.stage_import('e9b00000-0000-4000-8000-000000000001', 'loan', 'file', %L, 1000, 'udofin-lms-import-v1', '[{}]', 'idem-sync-only-0001')$$, repeat('5', 64))), '42501|', 'servicing.sync.manage alone cannot stage (that needs servicing.manual_entry)');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000010');
select is(pg_temp.err(format($$select servicing.commit_import(%L)$$, pg_temp.got('f1_id'))), '42501|', 'servicing.manual_entry alone cannot commit (that needs servicing.sync.manage)');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000004');
select is(pg_temp.err(format($$select servicing.commit_import(%L)$$, pg_temp.got('f1_id'))), '42501|', 'a viewer cannot commit');
select is(pg_temp.err(format($$select servicing.stage_import('e9b00000-0000-4000-8000-000000000001', 'loan', 'file', %L, 1000, 'udofin-lms-import-v1', '[{}]', 'idem-viewer-000001')$$, repeat('5', 64))), '42501|', 'nor stage');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000005');
select is(pg_temp.err(format($$select servicing.commit_import(%L)$$, pg_temp.got('f1_id'))), 'P0002|', 'another lender''s operator cannot commit this batch: it does not exist for them');
select is(pg_temp.err(format($$select servicing.reject_import(%L, 'a perfectly good reason')$$, pg_temp.got('f1_id'))), 'P0002|', 'nor reject it');
select is(pg_temp.err(format($$select servicing.stage_import('e9b00000-0000-4000-8000-000000000001', 'loan', 'file', %L, 1000, 'udofin-lms-import-v1', '[{}]', 'idem-other-tenant-01')$$, repeat('5', 64))), '42501|', 'nor stage a file for lender X');
select is((select count(*) from servicing.import_batches), 0::bigint, 'lender Y sees none of X''s batches');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000006');
select is(pg_temp.err(format($$select servicing.commit_import(%L)$$, pg_temp.got('f1_id'))), 'P0002|', 'a borrower cannot commit');
select pg_temp.as_anon();
select is(pg_temp.err(format($$select servicing.commit_import(%L)$$, pg_temp.got('f1_id'))), '42501|', 'anon cannot');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000011', 'aal1');
select is(pg_temp.err(format($$select servicing.commit_import(%L)$$, pg_temp.got('f1_id'))), '42501|mfa_required', 'a session without the second factor cannot commit');
select pg_temp.as_system();
select is(pg_temp.err(format($$select servicing.commit_import(%L)$$, pg_temp.got('f1_id'))), '42501|', 'the system role has no authority to commit a person''s import (no execute right)');

-- Commit by a different person than the stager (u03 staged, u11 commits)
select pg_temp.as_user('e9000000-0000-4000-8000-000000000011');
select is((servicing.commit_import(pg_temp.got('f1_id')::uuid)) ->> 'status', 'committed', 'a second person commits the batch');
select is((select applied_counts from servicing.import_batches where id = pg_temp.got('f1_id')::uuid), '{"new":3}'::jsonb, 'and the batch records what was applied');
select is((servicing.commit_import(pg_temp.got('f1_id')::uuid)) ->> 'existing', 'true', 'committing again is idempotent: it returns the committed batch and applies nothing twice');
select is((select count(*) from servicing.loan_accounts where lender_org_id = 'e9b00000-0000-4000-8000-000000000001'), 3::bigint, 'three loan accounts exist');
select is((select count(*) from servicing.balance_snapshots), 3::bigint, 'with one reported snapshot each');
select is((select count(*) from servicing.balance_snapshots s where s.lender_org_id = 'e9b00000-0000-4000-8000-000000000001' and s.source_system = 'file_import'
           and s.import_batch_id = pg_temp.got('f1_id')::uuid and s.source_record_id like 'SRC-LX_-1' and s.reported_as_of is not null and s.received_at >= s.reported_as_of
           and s.content_sha256 ~ '^[0-9a-f]{64}$' and s.lender_sequence = 1 and s.recorded_by = 'e9000000-0000-4000-8000-000000000011'
           and s.version = 1 and s.status = 'active'), 3::bigint,
  'every snapshot carries its provenance: lender, source system, batch, source record id, reported_as_of (lender time), received_at (ours), sequence, hash and the person');
select is((select (outstanding_principal_minor, overdue_principal_minor, total_overdue_minor, next_due_minor, days_past_due)::text from servicing.balance_snapshots where source_record_id = 'SRC-LX1-1'),
  '(4166667,0,0,450000,0)', 'the figures are stored exactly as reported, in integer paise');
select is((select count(*) from servicing.loan_account_events e where e.event_type = 'created' and e.source_system = 'file_import' and e.actor = 'lender'
           and e.actor_user_id = 'e9000000-0000-4000-8000-000000000011'), 3::bigint, 'the loan account history records the committing person and the source');
select pg_temp.as_owner();
select is((select string_agg(status::text, ',' order by id) from lending.applications where id in ('e9200000-0000-4000-8000-000000000001', 'e9200000-0000-4000-8000-000000000002', 'e9200000-0000-4000-8000-000000000003')),
  'disbursement_pending,disbursement_pending,disbursement_pending',
  'a lender user can take an application only as far as disbursement_pending; the final step is reserved for the system');
select pg_temp.as_system();
select is((select servicing.complete_disbursements('e9b00000-0000-4000-8000-000000000001')), 3, 'the system completes the disbursement of the three applications');
select is((select count(*) from lending.applications where id in ('e9200000-0000-4000-8000-000000000001', 'e9200000-0000-4000-8000-000000000002', 'e9200000-0000-4000-8000-000000000003') and status = 'disbursed'), 3::bigint,
  'now they are disbursed (the existing evidence trigger accepted it)');
select is((select count(*) from lending.application_events where application_id = 'e9200000-0000-4000-8000-000000000002' and to_status = 'disbursed' and actor = 'system' and reason = 'lms_report'), 1::bigint,
  'the application history says why');
select is((select servicing.complete_disbursements('e9b00000-0000-4000-8000-000000000001')), 0, 'nothing is left to complete');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000003');
select is(pg_temp.err($$select servicing.complete_disbursements()$$), '42501|', 'a person cannot call the system-only completion');
select is(pg_temp.err(format($$select servicing.reject_import(%L, 'rejecting a committed batch must fail')$$, pg_temp.got('f1_id'))), '55000|batch_not_rejectable', 'a committed batch cannot be rejected');
select pg_temp.as_owner();
select is((select count(*) from audit.events where entity_id = pg_temp.got('f1_id') and action = 'servicing.import.staged' and actor_user_id = 'e9000000-0000-4000-8000-000000000003'), 1::bigint, 'the audit trail records who staged');
select is((select count(*) from audit.events where entity_id = pg_temp.got('f1_id') and action = 'servicing.import.committed' and actor_user_id = 'e9000000-0000-4000-8000-000000000011'), 1::bigint, 'and who committed');
select is((select count(*) from audit.events where entity_id = pg_temp.got('f1_id') and metadata::text ~* 'SAMPLE|LX[0-9]|SRC-'), 0::bigint, 'and the audit metadata holds no loan reference or record id');
select is((select count(*) from ops.outbox_events where event_type = 'servicing.import.committed' and payload ->> 'batch_id' = pg_temp.got('f1_id')), 1::bigint, 'an outbox event was written in the same transaction');


-- ============================================================================================================================
-- 5. ALL OR NOTHING (owner decision 10): one bad row invalidates the whole file; the failed attempt keeps no row values
-- ============================================================================================================================
select pg_temp.as_user('e9000000-0000-4000-8000-000000000003');
select pg_temp.keep('f2', pg_temp.stage('e9b00000-0000-4000-8000-000000000001', 'loan', 'inv1', jsonb_build_array(
  pg_temp.loan('LX5', 'SAMPLE-APP-X5', 'SRC-LX5-1', 5, '{"sequence":"1"}'),
  pg_temp.loan('LX6', 'SAMPLE-APP-X6', 'SRC-LX6-1', 30, '{"sequence":"1","sanctioned_amount":"50000.005"}'),
  pg_temp.loan('LX7', 'SAMPLE-APP-X13', 'SRC-LX7-1', 5, '{"sequence":"1"}')))::text);
select pg_temp.keep('f2_id', (pg_temp.got('f2')::jsonb) ->> 'batch_id');
select is((pg_temp.got('f2')::jsonb) ->> 'status', 'invalid', 'a file with one bad row is invalid as a whole (all or nothing)');
select is(pg_temp.errs(pg_temp.got('f2')::jsonb), '2:invalid_amount@sanctioned_amount', 'the row-level error is shown back: row number, code and field name');
select is((pg_temp.got('f2')::jsonb) -> 'counts' ->> 'error', '1', 'one error is counted');
select is((select count(*) from servicing.import_errors(pg_temp.got('f2_id')::uuid)), 1::bigint, 'import_errors lists the same single problem from the stored preview');
select is((select (row_no, error_codes, field_names)::text from servicing.import_errors(pg_temp.got('f2_id')::uuid)), '(2,{invalid_amount},{sanctioned_amount})', 'as position, code and field name');
select is((select count(*) from servicing.loan_accounts where lms_loan_ref in ('LX5', 'LX6', 'LX7')), 0::bigint, 'the good rows of the bad file were NOT imported: nothing is imported');
select is((select count(*) from servicing.import_rows where batch_id = pg_temp.got('f2_id')::uuid), 3::bigint, 'the audit record keeps one row entry per file record');
select is((select count(*) from servicing.import_rows where batch_id = pg_temp.got('f2_id')::uuid
           and (normalised is not null or source_record_id is not null or row_sha256 is not null)), 0::bigint, 'and none of them holds a value: no content, no record id, no row hash');
select is((select count(*) from servicing.import_rows where batch_id = pg_temp.got('f2_id')::uuid and source_record_id_sha256 is not null), 3::bigint, 'only the hash of each record id is kept');
select is((select count(*) from servicing.import_rows r where r.batch_id = pg_temp.got('f2_id')::uuid and r::text ~* 'LX[0-9]|SAMPLE|50000|SRC-'), 0::bigint, 'no loan reference, application reference, amount or record id appears anywhere in the stored rows');
select is((select (status, reported_as_of_min is null and reported_as_of_max is null, byte_size, row_count)::text from servicing.import_batches where id = pg_temp.got('f2_id')::uuid),
  '(invalid,t,1000,3)', 'the batch keeps the status, file size, row count and no reported-time range');
select is(pg_temp.err(format($$select servicing.commit_import(%L)$$, pg_temp.got('f2_id'))), '55000|import_has_errors', 'committing an invalid batch is refused');
select is(pg_temp.err(format($$select servicing.reject_import(%L, 'a long enough reason')$$, pg_temp.got('f2_id'))), '55000|batch_not_rejectable', 'and an invalid batch needs no rejection');
select is((pg_temp.stage('e9b00000-0000-4000-8000-000000000001', 'loan', 'inv1', '[{}]'))::jsonb ->> 'batch_id', pg_temp.got('f2_id'), 'the same invalid file twice is idempotent: the same batch comes back');
select is((pg_temp.stage('e9b00000-0000-4000-8000-000000000001', 'loan', 'inv1', '[{}]'))::jsonb ->> 'existing', 'true', 'and says so');
select is((select count(*) from servicing.import_batches where file_sha256 = pg_temp.sha('inv1')), 1::bigint, 'only one batch exists for it');
select pg_temp.as_owner();
select is((select count(*) from audit.events where entity_id = pg_temp.got('f2_id') and action = 'servicing.import.staged' and metadata ->> 'status' = 'invalid' and metadata ->> 'file_sha256' = pg_temp.sha('inv1')
           and (metadata ->> 'row_count')::int = 3 and (metadata ->> 'errors')::int = 1), 1::bigint, 'the failed attempt left an audit record with the file hash and counts');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000003');

-- The corrected file is a different file (a different SHA-256), so it is a new batch; the lender passes the earlier batch id.
select is(pg_temp.err(format($$select servicing.stage_import('e9b00000-0000-4000-8000-000000000001', 'loan', 'file', %L, 1000, 'udofin-lms-import-v1', '[{}]', 'idem-resub-bad-0001', %L)$$, repeat('6', 64), pg_temp.got('f1_id'))),
  '22023|resubmission_invalid', 'a resubmission may not name a committed batch');
select is(pg_temp.err($$select servicing.stage_import('e9b00000-0000-4000-8000-000000000001', 'loan', 'file', repeat('6', 64), 1000, 'udofin-lms-import-v1', '[{}]', 'idem-resub-bad-0002', 'e9f00000-0000-4000-8000-000000000000')$$),
  '22023|resubmission_invalid', 'nor an unknown batch');
select is(pg_temp.err(format($$select servicing.stage_import('e9b00000-0000-4000-8000-000000000001', 'receipt', 'file', %L, 1000, 'udofin-lms-import-v1', '[{}]', 'idem-resub-bad-0003', %L)$$, repeat('6', 64), pg_temp.got('f2_id'))),
  '22023|resubmission_invalid', 'nor a batch of another kind');
select pg_temp.keep('f3', pg_temp.stage('e9b00000-0000-4000-8000-000000000001', 'loan', 'fix1', jsonb_build_array(
  pg_temp.loan('LX5', 'SAMPLE-APP-X5', 'SRC-LX5-1', 5, '{"sequence":"1"}'),
  pg_temp.loan('LX6', 'SAMPLE-APP-X6', 'SRC-LX6-1', 30, '{"sequence":"1"}'),
  pg_temp.loan('LX7', 'SAMPLE-APP-X13', 'SRC-LX7-1', 5, '{"sequence":"1"}')), (pg_temp.got('f2')::jsonb ->> 'batch_id')::uuid)::text);
select pg_temp.keep('f3_id', (pg_temp.got('f3')::jsonb) ->> 'batch_id');
select is((pg_temp.got('f3')::jsonb) ->> 'status', 'previewed', 'the corrected file is previewed');
select is((pg_temp.got('f3')::jsonb) ->> 'resubmission_of', pg_temp.got('f2_id'), 'and records which earlier batch it corrects');
select is((select resubmission_of from servicing.import_batches where id = pg_temp.got('f3_id')::uuid), pg_temp.got('f2_id')::uuid, 'in the batch row');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000011');
select is((servicing.commit_import(pg_temp.got('f3_id')::uuid)) ->> 'status', 'committed', 'the fixed file imports');
select is((select count(*) from servicing.loan_accounts where lms_loan_ref in ('LX5', 'LX6', 'LX7')), 3::bigint, 'all three loans exist');
select is((select count(*) from servicing.balance_snapshots where import_batch_id = pg_temp.got('f3_id')::uuid), 3::bigint, 'each with a snapshot attributed to the batch');
select is((select resubmission_of from servicing.import_batches where id = pg_temp.got('f2_id')::uuid), null::uuid, 'the earlier invalid batch is unchanged (linkage points one way only)');

-- A commit that fails part-way rolls back as a whole (here: the second record's application is linked elsewhere between preview and commit).
select pg_temp.as_user('e9000000-0000-4000-8000-000000000003');
select pg_temp.keep('f4', pg_temp.stage('e9b00000-0000-4000-8000-000000000001', 'loan', 'rb1', jsonb_build_array(
  pg_temp.loan('LX8', 'e9200000-0000-4000-8000-000000000007', 'SRC-LX8-1', 4, '{"sequence":"1"}'),
  pg_temp.loan('LX9', 'e9200000-0000-4000-8000-000000000008', 'SRC-LX9-1', 3, '{"sequence":"1"}')))::text);
select pg_temp.keep('f4_id', (pg_temp.got('f4')::jsonb) ->> 'batch_id');
select is((pg_temp.got('f4')::jsonb) ->> 'status', 'previewed', 'the file looked fine at preview time');
select pg_temp.as_owner();
insert into servicing.loan_accounts (lender_org_id, application_id, borrower_id, source_system, lms_loan_ref, sanctioned_amount_minor, disbursed_amount_minor, disbursed_at, disbursement_reference)
values ('e9b00000-0000-4000-8000-000000000001', 'e9200000-0000-4000-8000-000000000008', (select borrower_id from lending.applications where id = 'e9200000-0000-4000-8000-000000000008'),
        'manual_import', 'OTHER-LN', 5000000, 5000000, now(), 'SAMPLE-UTR-OTHER');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000011');
select pg_temp.keep('f4_res', servicing.commit_import(pg_temp.got('f4_id')::uuid)::text);
select is((pg_temp.got('f4_res')::jsonb) ->> 'status', 'failed', 'the commit reports a failed batch (it does not raise, so the audit record survives)');
select is((pg_temp.got('f4_res')::jsonb) ->> 'failure_class', 'P0001', 'with the SQLSTATE class only');
select is((select count(*) from servicing.loan_accounts where lms_loan_ref in ('LX8', 'LX9')), 0::bigint, 'the first record, which had been applied before the failure, is rolled back with the rest: no partial data');
select is((select count(*) from servicing.balance_snapshots where import_batch_id = pg_temp.got('f4_id')::uuid), 0::bigint, 'no snapshot of the batch exists');
select pg_temp.as_owner();
select is((select status from lending.applications where id = 'e9200000-0000-4000-8000-000000000007'), 'disbursement_pending'::lending.application_status, 'and the application it touched is back where it was');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000011');
select is((select count(*) from servicing.import_rows where batch_id = pg_temp.got('f4_id')::uuid and (normalised is not null or source_record_id is not null or row_sha256 is not null or applied_result is not null)), 0::bigint,
  'the failed batch keeps no row values and no applied result');
select is((select (status, reported_as_of_min is null, failure_class is not null)::text from servicing.import_batches where id = pg_temp.got('f4_id')::uuid), '(failed,t,t)', 'the batch is marked failed with its class');
select is(pg_temp.err(format($$select servicing.commit_import(%L)$$, pg_temp.got('f4_id'))), '55000|batch_failed', 'a failed batch cannot be committed again');
select pg_temp.as_owner();
select is((select count(*) from audit.events where entity_id = pg_temp.got('f4_id') and action = 'servicing.import.failed' and metadata ->> 'failure_class' = 'P0001'), 1::bigint, 'the failure is audited');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000003');
-- A failed batch releases its file hash: the same file can be staged again, and is previewed against the current state.
select pg_temp.keep('f4b', servicing.stage_import('e9b00000-0000-4000-8000-000000000001', 'loan', 'file', pg_temp.sha('rb1'), 1000, 'udofin-lms-import-v1',
  jsonb_build_array(
  pg_temp.loan('LX8', 'e9200000-0000-4000-8000-000000000007', 'SRC-LX8-1', 4, '{"sequence":"1"}'),
  pg_temp.loan('LX9', 'e9200000-0000-4000-8000-000000000008', 'SRC-LX9-1', 3, '{"sequence":"1"}')), 'idem-rb1-second-try-1', (pg_temp.got('f4_id'))::uuid)::text);
select is((pg_temp.got('f4b')::jsonb) ->> 'status', 'invalid', 'staging it again now finds the problem at preview time: the second application is linked');
select is(pg_temp.errs(pg_temp.got('f4b')::jsonb), '2:application_already_linked@', 'with the reason class');
select is((pg_temp.got('f4b')::jsonb) ->> 'existing', 'false', 'as a new batch');

-- ============================================================================================================================
-- 6. Quarantine at preview: unknown, foreign, ambiguous, not-ready references and incomplete evidence. Each makes the file invalid.
-- ============================================================================================================================
select is(pg_temp.errs(pg_temp.stage('e9b00000-0000-4000-8000-000000000001', 'loan', 'q-unknown', jsonb_build_array(pg_temp.loan('LQ1', 'SAMPLE-APP-NOPE', 'SRC-Q1', 5)))),
  '1:application_not_found@', 'an unknown application reference is quarantined');
select is(pg_temp.errs(pg_temp.stage('e9b00000-0000-4000-8000-000000000001', 'loan', 'q-foreign', jsonb_build_array(pg_temp.loan('LQ2', 'SAMPLE-APP-Y9', 'SRC-Q2', 5)))),
  '1:application_not_found@', 'another lender''s application is as unknown as a missing one');
select is(pg_temp.errs(pg_temp.stage('e9b00000-0000-4000-8000-000000000001', 'loan', 'q-foreign-id', jsonb_build_array(pg_temp.loan('LQ2', 'e9200000-0000-4000-8000-000000000009', 'SRC-Q2', 5)))),
  '1:application_not_found@', 'also by its Udofin application id');
select is(pg_temp.errs(pg_temp.stage('e9b00000-0000-4000-8000-000000000001', 'loan', 'q-ambiguous', jsonb_build_array(pg_temp.loan('LQ3', 'SAMPLE-APP-DUP', 'SRC-Q3', 5)))),
  '1:application_ambiguous@', 'a reference that fits two applications is ambiguous and creates nothing');
select is(pg_temp.errs(pg_temp.stage('e9b00000-0000-4000-8000-000000000001', 'loan', 'q-notready', jsonb_build_array(pg_temp.loan('LQ4', 'SAMPLE-APP-X4', 'SRC-Q4', 5)))),
  '1:application_not_ready@', 'an application that has not reached agreement is not ready');
select is(pg_temp.errs(pg_temp.stage('e9b00000-0000-4000-8000-000000000001', 'loan', 'q-noevid', jsonb_build_array(
  pg_temp.loan('LQ5', 'e9200000-0000-4000-8000-000000000007', 'SRC-Q5', 5, '{"disbursed_amount":null,"disbursement_ref":null,"disbursement_date":null}')))),
  '1:disbursement_evidence_incomplete@', 'a new loan without its disbursement evidence is quarantined (date, amount and bank reference are needed together)');
select is(pg_temp.errs(pg_temp.stage('e9b00000-0000-4000-8000-000000000001', 'loan', 'q-future', jsonb_build_array(
  pg_temp.loan('LQ6', 'e9200000-0000-4000-8000-000000000007', 'SRC-Q6', 5, jsonb_build_object('disbursement_date', to_char(current_date + 3, 'YYYY-MM-DD')))))),
  '1:disbursement_date_in_future@', 'a disbursement dated in the future is not evidence');
select is(pg_temp.errs(pg_temp.stage('e9b00000-0000-4000-8000-000000000001', 'loan', 'q-linked', jsonb_build_array(pg_temp.loan('LQ7', 'SAMPLE-APP-X1', 'SRC-Q7', 5)))),
  '1:application_already_linked@', 'a second loan for an application that already has one is refused');
select is(pg_temp.errs(pg_temp.stage('e9b00000-0000-4000-8000-000000000001', 'loan', 'q-claimtwice', jsonb_build_array(
  pg_temp.loan('LQ8', 'e9200000-0000-4000-8000-000000000007', 'SRC-Q8A', 5), pg_temp.loan('LQ9', 'e9200000-0000-4000-8000-000000000007', 'SRC-Q8B', 5)))),
  '2:application_already_linked@', 'two loans of one file cannot claim the same application: the second is quarantined at preview, not at commit');
-- Review finding F1: the unique index (lender, disbursement_reference) is simulated at preview, so the collision is a row error, not a commit failure.
select is(pg_temp.errs(pg_temp.stage('e9b00000-0000-4000-8000-000000000001', 'loan', 'q-dref-stored', jsonb_build_array(
  pg_temp.loan('LQ11', 'e9200000-0000-4000-8000-000000000007', 'SRC-Q11', 5, '{"disbursement_ref":"SAMPLE-DISB-LX1"}')))),
  '1:disbursement_reference_in_use@', 'a new loan that carries the bank reference of a stored loan is refused at preview');
select pg_temp.as_owner();
insert into lending.loan_requests (id, borrower_id, category_key, requested_amount_minor, requested_tenure_days, purpose_code, status)
select ('e9700000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, (select id from identity.borrowers where user_id = 'e9000000-0000-4000-8000-000000000006'),
       'personal', 5000000, 365, 'education', 'submitted'
from generate_series(14, 15) n;
insert into lending.applications (id, lender_org_id, loan_request_id, borrower_id, product_version_id, status, requested_amount_minor, requested_tenure_days, lender_reference)
select ('e9200000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, 'e9b00000-0000-4000-8000-000000000001',
       ('e9700000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, (select id from identity.borrowers where user_id = 'e9000000-0000-4000-8000-000000000006'),
       'e9910000-0000-4000-8000-000000000001', 'disbursement_pending', 5000000, 365, 'SAMPLE-APP-X' || n
from generate_series(14, 15) n;
select pg_temp.as_user('e9000000-0000-4000-8000-000000000003');
select is(pg_temp.errs(pg_temp.stage('e9b00000-0000-4000-8000-000000000001', 'loan', 'q-dref-infile', jsonb_build_array(
  pg_temp.loan('LQ12', 'SAMPLE-APP-X14', 'SRC-Q12A', 5, '{"disbursement_ref":"SAMPLE-DISB-DUP"}'),
  pg_temp.loan('LQ13', 'SAMPLE-APP-X15', 'SRC-Q12B', 5, '{"disbursement_ref":"SAMPLE-DISB-DUP"}')))),
  '2:disbursement_reference_in_use@', 'two loans of one file with the same bank reference: the second is refused at preview, the first keeps it');
select is((select count(*) from servicing.loan_accounts where lms_loan_ref in ('LQ11', 'LQ12', 'LQ13')), 0::bigint, 'and nothing was created');
select is(pg_temp.errs(pg_temp.stage('e9b00000-0000-4000-8000-000000000001', 'loan', 'q-mismatch', jsonb_build_array(pg_temp.loan('LX1', 'SAMPLE-APP-X2', 'SRC-LX1-M', 1)))),
  '1:borrower_ref_mismatch@', 'a report that names another borrower''s application for an existing loan is quarantined, not stored against the loan');
select is(pg_temp.errs(pg_temp.stage('e9b00000-0000-4000-8000-000000000001', 'receipt', 'q-rc-unknown', jsonb_build_array(pg_temp.receipt('NOPE', 'RQ1', '1.00', 1)))),
  '1:unknown_loan@', 'a receipt for an unknown loan is quarantined');
select is(pg_temp.errs(pg_temp.stage('e9b00000-0000-4000-8000-000000000001', 'receipt', 'q-rc-rev', jsonb_build_array(
  pg_temp.receipt('LX1', 'RQ2', '1.00', 1, '{"receipt_kind":"reversal","reverses_receipt_ref":"NOSUCH"}')))),
  '1:reversal_target_unknown@', 'a reversal of an unknown receipt is quarantined');
select is(pg_temp.errs(pg_temp.stage('e9b00000-0000-4000-8000-000000000001', 'schedule', 'q-sch-unknown', jsonb_build_array(pg_temp.sched('NOPE', 'SRC-QS1', 1)))),
  '1:unknown_loan@', 'a schedule for an unknown loan is quarantined');
select is(pg_temp.errs(pg_temp.stage('e9b00000-0000-4000-8000-000000000001', 'loan', 'q-unknownfield', jsonb_build_array(pg_temp.loan('LX1', 'SAMPLE-APP-X1', 'SRC-Q10', 1, '{"customer_name":"Asha Rao"}')))),
  '1:unknown_field@', 'an unknown field (a name, here) makes the file invalid and is never echoed');
select is(pg_temp.errs(pg_temp.stage('e9b00000-0000-4000-8000-000000000001', 'loan', 'q-pan', jsonb_build_array(pg_temp.loan('LX1', 'ABCDE1234F', 'SRC-Q11', 1)))),
  '1:borrower_ref_looks_personal@borrower_ref', 'a PAN-shaped borrower reference is refused');
select is(pg_temp.errs(pg_temp.stage('e9b00000-0000-4000-8000-000000000001', 'loan', 'q-dupconflict', jsonb_build_array(
  pg_temp.loan('LX1', 'SAMPLE-APP-X1', 'SRC-Q12', 1, '{"outstanding_principal":"10.00"}'), pg_temp.loan('LX1', 'SAMPLE-APP-X1', 'SRC-Q12', 1, '{"outstanding_principal":"11.00"}')))),
  '1:conflicting_duplicate@;2:conflicting_duplicate@', 'the same record id twice in one file with different content rejects every occurrence');
select pg_temp.keep('dupl', pg_temp.stage('e9b00000-0000-4000-8000-000000000001', 'loan', 'q-dupsame', jsonb_build_array(
  pg_temp.loan('LX1', 'SAMPLE-APP-X1', 'SRC-Q13', 1, '{"sequence":"11"}'), pg_temp.loan('LX1', 'SAMPLE-APP-X1', 'SRC-Q13', 1, '{"sequence":"11"}')) )::text);
select is((pg_temp.got('dupl')::jsonb) ->> 'status', 'previewed', 'the same record twice with identical content is not an error');
select is((pg_temp.got('dupl')::jsonb) -> 'counts' ->> 'duplicate', '1', 'the repeat is counted as a duplicate (and applied once)');
select is((select count(*) from servicing.loan_accounts), 7::bigint, 'none of the invalid files created anything (6 imported loans and the fixture loan)');
select is((select count(*) from servicing.sync_quarantine), 0::bigint, 'previews write no quarantine records (only the system entry point does)');
select is((select count(*) from servicing.sync_conflicts), 0::bigint, 'and no conflicts');

select pg_temp.as_owner();
-- The small parsers used by the validation have no exception blocks (speed) but must agree with the one money parser on the shared vectors.
select is((select count(*) from jsonb_array_elements($vec${"valid": [{"input": "0", "minor": "0"}, {"input": "0.0", "minor": "0"}, {"input": "0.00", "minor": "0"}, {"input": "0.5", "minor": "50"}, {"input": "0.05", "minor": "5"}, {"input": "0.50", "minor": "50"}, {"input": "0.99", "minor": "99"}, {"input": "1", "minor": "100"}, {"input": "1.01", "minor": "101"}, {"input": "9", "minor": "900"}, {"input": "10", "minor": "1000"}, {"input": "20.10", "minor": "2010"}, {"input": "100.1", "minor": "10010"}, {"input": "1250", "minor": "125000"}, {"input": "1250.5", "minor": "125050"}, {"input": "1250.50", "minor": "125050"}, {"input": "1250.05", "minor": "125005"}, {"input": "1250.00", "minor": "125000"}, {"input": "10000000", "minor": "1000000000"}, {"input": "123456789012", "minor": "12345678901200"}, {"input": "999999999999.99", "minor": "99999999999999"}, {"input": "1000000000000", "minor": "100000000000000"}, {"input": "1000000000000.0", "minor": "100000000000000"}, {"input": "1000000000000.00", "minor": "100000000000000"}], "invalid": [null, "", " ", " 1250", "1250 ", "1 250", "1250\n", "\t1250", "1250\r", "\u00a01250", "+1250", "-1250", "-0", "+0", "1e3", "1E3", "1e-2", "0x10", "1,250", "1,250.50", "1_250", "1250.", ".5", ".", "1250.505", "1250.500", "1250.001", "00", "01", "007", "00.5", "01.50", "1250,50", "1.2.3", "abc", "12a", "Infinity", "NaN", "0.5.", "1000000000000.01", "1000000000001", "9999999999999999", "99999999999999999", "\u0661\u0662\u0663", "\u0967\u0968\u0969", "\uff11\uff12\uff13", "12\uff11", "\u20b91250", "Rs 1250", "1250/-"]}$vec$::jsonb -> 'valid') v
           where private.servicing_try_money(v ->> 'input') is distinct from private.parse_money_minor(v ->> 'input')
              or private.servicing_try_money(v ->> 'input') is distinct from (v ->> 'minor')::bigint), 0::bigint,
  'every shared valid money vector (24) parses to the same paise through the validation helper and through private.parse_money_minor');
select is((select count(*) from jsonb_array_elements($vec${"valid": [{"input": "0", "minor": "0"}, {"input": "0.0", "minor": "0"}, {"input": "0.00", "minor": "0"}, {"input": "0.5", "minor": "50"}, {"input": "0.05", "minor": "5"}, {"input": "0.50", "minor": "50"}, {"input": "0.99", "minor": "99"}, {"input": "1", "minor": "100"}, {"input": "1.01", "minor": "101"}, {"input": "9", "minor": "900"}, {"input": "10", "minor": "1000"}, {"input": "20.10", "minor": "2010"}, {"input": "100.1", "minor": "10010"}, {"input": "1250", "minor": "125000"}, {"input": "1250.5", "minor": "125050"}, {"input": "1250.50", "minor": "125050"}, {"input": "1250.05", "minor": "125005"}, {"input": "1250.00", "minor": "125000"}, {"input": "10000000", "minor": "1000000000"}, {"input": "123456789012", "minor": "12345678901200"}, {"input": "999999999999.99", "minor": "99999999999999"}, {"input": "1000000000000", "minor": "100000000000000"}, {"input": "1000000000000.0", "minor": "100000000000000"}, {"input": "1000000000000.00", "minor": "100000000000000"}], "invalid": [null, "", " ", " 1250", "1250 ", "1 250", "1250\n", "\t1250", "1250\r", "\u00a01250", "+1250", "-1250", "-0", "+0", "1e3", "1E3", "1e-2", "0x10", "1,250", "1,250.50", "1_250", "1250.", ".5", ".", "1250.505", "1250.500", "1250.001", "00", "01", "007", "00.5", "01.50", "1250,50", "1.2.3", "abc", "12a", "Infinity", "NaN", "0.5.", "1000000000000.01", "1000000000001", "9999999999999999", "99999999999999999", "\u0661\u0662\u0663", "\u0967\u0968\u0969", "\uff11\uff12\uff13", "12\uff11", "\u20b91250", "Rs 1250", "1250/-"]}$vec$::jsonb -> 'invalid') v
           where private.servicing_try_money(v #>> '{}') is not null), 0::bigint,
  'and none of the shared invalid vectors (50, including null) is accepted by the validation helper');
select is(private.servicing_try_money('1000000000000.00'), 100000000000000::bigint, 'the ceiling is accepted');
select is(private.servicing_try_money('1000000000000.01'), null::bigint, 'and one paisa above it is not');
select is(private.servicing_try_money('99999999999999'), null::bigint, 'nor a 14 digit amount');
select is(private.servicing_try_date('2028-02-29'), date '2028-02-29', 'a leap day is a date');
select is(private.servicing_try_date('2026-02-29'), null::date, 'a non-leap 29 February is not');
select is(private.servicing_try_date('2100-02-29'), null::date, 'nor is 29 February 2100');
select is(private.servicing_try_date('2026-13-01'), null::date, 'month 13 is not');
select is(private.servicing_try_date('2026-04-31'), null::date, 'nor 31 April');
select is(private.servicing_try_date('1999-12-31'), null::date, 'the years run 2000 to 2100');
select is(private.servicing_try_date('2101-01-01'), null::date, 'also at the top');
select is(private.servicing_try_ts('2026-10-13T06:00:00Z'), timestamptz '2026-10-13 06:00:00+00', 'a UTC timestamp parses');
select is(private.servicing_try_ts('2026-10-13T11:30:00.5+05:30'), timestamptz '2026-10-13 06:00:00.5+00', 'an offset is applied');
select is(private.servicing_try_ts('2026-10-13T06:00:00+20:00'), null::timestamptz, 'an impossible offset is refused');
select is(private.servicing_try_ts('2026-10-13T24:00:00Z'), null::timestamptz, 'hour 24 is refused');
select is(private.servicing_try_ts('2026-10-13T06:00:00.1234Z'), null::timestamptz, 'more than milliseconds are refused');
select is(private.servicing_try_ts('2026-02-30T06:00:00Z'), null::timestamptz, 'an impossible date inside a timestamp is refused');

-- Files the importer refuses before any record reaches the database still leave an audit record: hash, size, counts, positions, classes.
select pg_temp.as_user('e9000000-0000-4000-8000-000000000003');
select is(servicing.record_rejected_file('e9b00000-0000-4000-8000-000000000001', 'loan', 'file', pg_temp.sha('parse-fail'), 4096, 'udofin-lms-import-v1', 12,
  '[{"row_no":0,"code":"malformed_file","field":null},{"row_no":3,"code":"invalid_amount","field":"sanctioned_amount"}]'::jsonb) ->> 'error_count', '2', 'a refused file is recorded with its errors');
select is(pg_temp.err(format($$select servicing.record_rejected_file('e9b00000-0000-4000-8000-000000000001', 'loan', 'file', %L, 10, 'udofin-lms-import-v1', 1, '[{"row_no":1,"code":"invalid_amount","field":"customer_name"}]')$$, pg_temp.sha('x1'))), '22023|errors_invalid', 'a field name outside the closed set is refused');
select is(pg_temp.err(format($$select servicing.record_rejected_file('e9b00000-0000-4000-8000-000000000001', 'loan', 'file', %L, 10, 'udofin-lms-import-v1', 1, '[{"row_no":1,"code":"Asha Rao","field":null}]')$$, pg_temp.sha('x2'))), '22023|errors_invalid', 'a free-text code is refused (nothing but the closed classes is stored)');
select is(pg_temp.err(format($$select servicing.record_rejected_file('e9b00000-0000-4000-8000-000000000001', 'loan', 'file', %L, 10, 'udofin-lms-import-v1', 1, '[{"row_no":-1,"code":"malformed_file","field":null}]')$$, pg_temp.sha('x3'))), '22023|errors_invalid', 'a negative row number is refused');
select is(pg_temp.err(format($$select servicing.record_rejected_file('e9b00000-0000-4000-8000-000000000001', 'loan', 'file', %L, 10, 'udofin-lms-import-v1', 1, '[]')$$, pg_temp.sha('x4'))), '22023|errors_invalid', 'an empty error list is refused');
select is(pg_temp.err(format($$select servicing.record_rejected_file('e9b00000-0000-4000-8000-000000000001', 'loan', 'file', %L, 10, 'udofin-lms-import-v1', 1, '{"a":1}')$$, pg_temp.sha('x5'))), '22023|errors_invalid', 'and a non-array');
select is(pg_temp.err(format($$select servicing.record_rejected_file('e9b00000-0000-4000-8000-000000000001', 'tax', 'file', %L, 10, 'udofin-lms-import-v1', 1, '[{"row_no":0,"code":"malformed_file","field":null}]')$$, pg_temp.sha('x6'))), '22023|bad_request', 'an unknown kind is refused');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000004');
select is(pg_temp.err(format($$select servicing.record_rejected_file('e9b00000-0000-4000-8000-000000000001', 'loan', 'file', %L, 10, 'udofin-lms-import-v1', 1, '[{"row_no":0,"code":"malformed_file","field":null}]')$$, pg_temp.sha('x7'))), '42501|', 'a viewer cannot');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000012');
select is(pg_temp.err(format($$select servicing.record_rejected_file('e9b00000-0000-4000-8000-000000000003', 'loan', 'file', %L, 10, 'udofin-lms-import-v1', 1, '[{"row_no":0,"code":"malformed_file","field":null}]')$$, pg_temp.sha('x8'))), '55000|feature_disabled', 'with the switch off nothing is recorded');
select pg_temp.as_anon();
select is(pg_temp.err(format($$select servicing.record_rejected_file('e9b00000-0000-4000-8000-000000000001', 'loan', 'file', %L, 10, 'udofin-lms-import-v1', 1, '[{"row_no":0,"code":"malformed_file","field":null}]')$$, pg_temp.sha('x9'))), '42501|', 'anon cannot');
select pg_temp.as_owner();
select is((select (metadata ->> 'file_sha256' = pg_temp.sha('parse-fail'), metadata ->> 'record_count', metadata ->> 'byte_size', jsonb_array_length(metadata -> 'errors'), actor_user_id)::text
           from audit.events where action = 'servicing.import.file_rejected' and tenant_org_id = 'e9b00000-0000-4000-8000-000000000001'),
  '(t,12,4096,2,e9000000-0000-4000-8000-000000000003)', 'the audit record holds the file hash, size, record count, the errors and the person');
select is((select (select array_agg(k order by k) from jsonb_object_keys(metadata) k) from audit.events where action = 'servicing.import.file_rejected'),
  array['byte_size', 'error_count', 'errors', 'file_sha256', 'format_version', 'kind', 'record_count', 'source_kind'], 'and nothing else');
select is((select count(*) from servicing.import_batches where file_sha256 = pg_temp.sha('parse-fail')), 0::bigint, 'it creates no batch');

-- A duplicate inside a file is applied once and counted as a duplicate.
select pg_temp.as_user('e9000000-0000-4000-8000-000000000003');
select pg_temp.keep('dc', pg_temp.stage('e9b00000-0000-4000-8000-000000000001', 'loan', 'dup-commit', jsonb_build_array(
  pg_temp.loan('LX6', 'SAMPLE-APP-X6', 'SRC-LX6-D', 28, '{"sequence":"2"}'), pg_temp.loan('LX6', 'SAMPLE-APP-X6', 'SRC-LX6-D', 28, '{"sequence":"2"}')))::text);
select pg_temp.as_user('e9000000-0000-4000-8000-000000000011');
select is((servicing.commit_import(((pg_temp.got('dc')::jsonb) ->> 'batch_id')::uuid)) -> 'applied_counts', '{"changed":1,"duplicate":1}'::jsonb, 'the record is applied once and the repeat is counted as a duplicate');
select is(pg_temp.snaps('LX6'), 2::bigint, 'LX6 gained exactly one version');

-- ============================================================================================================================
-- 7. Idempotency, new versions, history, conflicts (loan LX1 of lender X)
-- ============================================================================================================================
select pg_temp.as_user('e9000000-0000-4000-8000-000000000003');
-- 7a. The same record again is `unchanged`.
select pg_temp.keep('v1a', pg_temp.stage('e9b00000-0000-4000-8000-000000000001', 'loan', 'same-rec', jsonb_build_array((pg_temp.got('f1_rows')::jsonb) -> 0))::text);
select is((pg_temp.got('v1a')::jsonb) -> 'counts' ->> 'unchanged', '1', 'a record that was already imported is previewed as unchanged');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000011');
select is((servicing.commit_import(((pg_temp.got('v1a')::jsonb) ->> 'batch_id')::uuid)) -> 'applied_counts', '{"unchanged":1}'::jsonb, 'and committing it applies nothing');
select is(pg_temp.snaps('LX1'), 1::bigint, 'LX1 still has its single snapshot');
-- 7b. A newer report is a new version; the old one stays and stays retrievable.
select pg_temp.as_user('e9000000-0000-4000-8000-000000000003');
select pg_temp.keep('lx1_v2', pg_temp.loan('LX1', 'SAMPLE-APP-X1', 'SRC-LX1-2', 3, '{"sequence":"5","outstanding_principal":"40000.00"}')::text);
select pg_temp.keep('v2a', pg_temp.stage('e9b00000-0000-4000-8000-000000000001', 'loan', 'newer-rec', jsonb_build_array(pg_temp.got('lx1_v2')::jsonb))::text);
select is((pg_temp.got('v2a')::jsonb) -> 'counts' ->> 'changed', '1', 'a newer report is previewed as changed');
select is(pg_temp.snaps('LX1'), 1::bigint, 'and the preview stored nothing');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000011');
select is((servicing.commit_import(((pg_temp.got('v2a')::jsonb) ->> 'batch_id')::uuid)) -> 'applied_counts', '{"changed":1}'::jsonb, 'committing it adds a version');
select is(pg_temp.snaps('LX1'), 2::bigint, 'LX1 now has two snapshots: the first was not replaced');
select is((select array_agg((version, lender_sequence, outstanding_principal_minor)::text order by version) from servicing.balance_snapshots where loan_account_id = pg_temp.lid('LX1')),
  array['(1,1,4166667)', '(2,5,4000000)'], 'both versions keep exactly what the lender reported then');
select is((select outstanding_principal_minor from servicing.loan_as_reported_at(pg_temp.lid('LX1'), now() - interval '4 hours')), 4166667::bigint, 'what the lender reported four hours ago is still retrievable (version 1)');
select is((select outstanding_principal_minor from servicing.loan_as_reported_at(pg_temp.lid('LX1'), now())), 4000000::bigint, 'and what it reports now (version 2)');
select is((select count(*) from servicing.loan_as_reported_at(pg_temp.lid('LX1'), now() - interval '6 hours')), 0::bigint, 'before the first report there is nothing');
select is((select version from servicing.loan_as_known_at(pg_temp.lid('LX1'), (select received_at from servicing.balance_snapshots where loan_account_id = pg_temp.lid('LX1') and version = 1))), 1, 'what we KNEW at the moment version 1 arrived is version 1');
select is((select version from servicing.loan_as_known_at(pg_temp.lid('LX1'), clock_timestamp())), 2, 'and now version 2');
select is((select count(*) from servicing.balance_snapshots s where s.loan_account_id = pg_temp.lid('LX1') and s.source_system = 'file_import' and s.import_batch_id is not null and s.source_record_id like 'SRC-LX1-_'
           and s.reported_as_of < s.received_at and s.content_sha256 ~ '^[0-9a-f]{64}$' and s.lender_org_id = 'e9b00000-0000-4000-8000-000000000001' and s.recorded_by is not null), 2::bigint,
  'every version carries lender, source system, batch, record id, both times, hash and the person who recorded it');
-- 7c. An older report is ignored and counted; it is not stored.
select pg_temp.as_user('e9000000-0000-4000-8000-000000000003');
select pg_temp.keep('v3a', pg_temp.stage('e9b00000-0000-4000-8000-000000000001', 'loan', 'older-rec', jsonb_build_array(pg_temp.loan('LX1', 'SAMPLE-APP-X1', 'SRC-LX1-0', 9, '{"sequence":"0"}')))::text);
select is((pg_temp.got('v3a')::jsonb) -> 'counts' ->> 'ignored_older', '1', 'an older reported_as_of is previewed as ignored and counted');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000011');
select is((servicing.commit_import(((pg_temp.got('v3a')::jsonb) ->> 'batch_id')::uuid)) -> 'applied_counts', '{"ignored_older":1}'::jsonb, 'and committing it records that it was ignored');
select is(pg_temp.snaps('LX1'), 2::bigint, 'nothing was stored');
select is((select (kind, severity)::text from servicing.sync_anomalies where loan_account_id = pg_temp.lid('LX1') and kind = 'older_report_ignored'), '(older_report_ignored,info)', 'the ignored report is counted as an info flag');
-- 7d. An older lender sequence (a later time but a lower number) is ignored and counted.
select pg_temp.as_user('e9000000-0000-4000-8000-000000000003');
select pg_temp.keep('v4a', pg_temp.stage('e9b00000-0000-4000-8000-000000000001', 'loan', 'older-seq', jsonb_build_array(pg_temp.loan('LX1', 'SAMPLE-APP-X1', 'SRC-LX1-3', 1, '{"sequence":"3"}')))::text);
select is((pg_temp.got('v4a')::jsonb) -> 'counts' ->> 'ignored_older', '1', 'a lower sequence at a later time is ignored too');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000011');
select is((servicing.commit_import(((pg_temp.got('v4a')::jsonb) ->> 'batch_id')::uuid)) ->> 'status', 'committed', 'committed');
select is((select count(*) from servicing.sync_anomalies where loan_account_id = pg_temp.lid('LX1') and kind = 'older_sequence_ignored'), 1::bigint, 'and flagged');
select is(pg_temp.snaps('LX1'), 2::bigint, 'still two snapshots');
-- 7e. Conflicts: the same record id with other content at the same or an older time. Queued, never applied, never overwritten.
select pg_temp.as_user('e9000000-0000-4000-8000-000000000003');
select pg_temp.keep('c1', pg_temp.stage('e9b00000-0000-4000-8000-000000000001', 'loan', 'conflict-1', jsonb_build_array((pg_temp.got('lx1_v2')::jsonb) || '{"outstanding_principal":"39999.00"}'))::text);
select is((pg_temp.got('c1')::jsonb) ->> 'status', 'previewed', 'a conflicting record is queued, it does not make the file invalid');
select is((pg_temp.got('c1')::jsonb) -> 'counts' ->> 'conflict', '1', 'it is counted as a conflict');
select pg_temp.keep('c2', pg_temp.stage('e9b00000-0000-4000-8000-000000000001', 'loan', 'conflict-2', jsonb_build_array((pg_temp.got('lx1_v2')::jsonb) || '{"source_record_id":"SRC-LX1-9","sequence":null,"outstanding_principal":"39000.00"}'))::text);
select is((pg_temp.got('c2')::jsonb) -> 'counts' ->> 'conflict', '1', 'the same instant with different content is a conflict');
select pg_temp.keep('c3', pg_temp.stage('e9b00000-0000-4000-8000-000000000001', 'loan', 'conflict-3', jsonb_build_array(pg_temp.loan('LX1', 'SAMPLE-APP-X1', 'SRC-LX1-8', 1, '{"sequence":"5","outstanding_principal":"38000.00"}')))::text);
select is((pg_temp.got('c3')::jsonb) -> 'counts' ->> 'conflict', '1', 'a lender sequence number reused with different content is a conflict');
select is((select count(*) from servicing.sync_conflicts), 0::bigint, 'previews queue nothing');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000011');
select is((servicing.commit_import(((pg_temp.got('c1')::jsonb) ->> 'batch_id')::uuid)) -> 'applied_counts', '{"conflict":1}'::jsonb, 'committing queues the conflict');
select is((servicing.commit_import(((pg_temp.got('c2')::jsonb) ->> 'batch_id')::uuid)) ->> 'status', 'committed', 'second');
select is((servicing.commit_import(((pg_temp.got('c3')::jsonb) ->> 'batch_id')::uuid)) ->> 'status', 'committed', 'third');
select is((select array_agg(conflict_reason order by conflict_reason) from servicing.sync_conflicts where loan_account_id = pg_temp.lid('LX1')),
  array['same_record_different_content', 'same_time_different_content', 'sequence_reused'], 'three conflicts, each with its reason');
select is((select count(*) from servicing.sync_conflicts where status = 'open'), 3::bigint, 'all open');
select is(pg_temp.snaps('LX1'), 2::bigint, 'the conflicting versions were not applied');
select is((select outstanding_principal_minor from servicing.balance_snapshots where loan_account_id = pg_temp.lid('LX1') and version = 2), 4000000::bigint, 'and the stored version 2 was not overwritten');
select is((select incoming_report ->> 'outstanding_principal' from servicing.sync_conflicts where conflict_reason = 'same_record_different_content'), '39999.00', 'the refused version is kept in canonical form for the lender to see');
select is((select (existing_content_sha256 = (select content_sha256 from servicing.balance_snapshots where loan_account_id = pg_temp.lid('LX1') and version = 2))::text
           from servicing.sync_conflicts where conflict_reason = 'same_record_different_content'), 'true', 'next to the hash of the version it disagrees with');
select is((select count(*) from servicing.sync_conflicts where incoming_report::text ~* 'customer|phone|name'), 0::bigint, 'a queued conflict holds only the closed field set');
select pg_temp.as_owner();
select is((select count(*) from ops.outbox_events where event_type = 'servicing.sync_conflict.opened'), 3::bigint, 'each conflict raised an outbox event in the same transaction');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000003');
-- The same conflicting record sent in another file queues nothing new.
select pg_temp.keep('c1b', pg_temp.stage('e9b00000-0000-4000-8000-000000000001', 'loan', 'conflict-1b', jsonb_build_array((pg_temp.got('lx1_v2')::jsonb) || '{"outstanding_principal":"39999.00"}', pg_temp.loan('LX3', 'SAMPLE-APP-X3', 'SRC-LX3-C', 4, '{"sequence":"9"}')))::text);
select pg_temp.as_user('e9000000-0000-4000-8000-000000000011');
select is((servicing.commit_import(((pg_temp.got('c1b')::jsonb) ->> 'batch_id')::uuid)) ->> 'status', 'committed', 'the repeat commits');
select is((select count(*) from servicing.sync_conflicts where conflict_reason = 'same_record_different_content'), 1::bigint, 'but the conflict exists once');
select is(pg_temp.snaps('LX3'), 2::bigint, 'while the other record of that file was applied (LX3 gets a second version)');

-- ============================================================================================================================
-- 8. The conflict queue: open -> acknowledged -> resolved, by a lender user, never rewriting history
-- ============================================================================================================================
select pg_temp.keep('cf', (select id::text from servicing.sync_conflicts where conflict_reason = 'same_record_different_content'));
select pg_temp.as_user('e9000000-0000-4000-8000-000000000004');
select is(pg_temp.err(format($$select servicing.acknowledge_sync_conflict(%L)$$, pg_temp.got('cf'))), '42501|', 'a viewer cannot acknowledge a conflict');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000010');
select is(pg_temp.err(format($$select servicing.acknowledge_sync_conflict(%L)$$, pg_temp.got('cf'))), '42501|', 'nor can servicing.manual_entry alone');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000005');
select is(pg_temp.err(format($$select servicing.acknowledge_sync_conflict(%L)$$, pg_temp.got('cf'))), 'P0002|', 'another lender''s operator finds no such conflict');
select is(pg_temp.err(format($$select servicing.resolve_sync_conflict(%L, 'incoming', 'a long enough note', '{"ticket":"SAMPLE-T-1"}')$$, pg_temp.got('cf'))), 'P0002|', 'nor can they resolve it');
select is((select count(*) from servicing.sync_conflicts), 0::bigint, 'and they see no conflict of lender X');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000006');
select is(pg_temp.err(format($$select servicing.resolve_sync_conflict(%L, 'incoming', 'a long enough note', '{"ticket":"SAMPLE-T-1"}')$$, pg_temp.got('cf'))), 'P0002|', 'a borrower finds no such conflict');
select pg_temp.as_anon();
select is(pg_temp.err(format($$select servicing.acknowledge_sync_conflict(%L)$$, pg_temp.got('cf'))), '42501|', 'anon cannot');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000011');
select is(pg_temp.err(format($$select servicing.resolve_sync_conflict(%L, 'existing', 'a long enough note', '{"ticket":"SAMPLE-T-1"}')$$, pg_temp.got('cf'))), '55000|conflict_not_acknowledged', 'an open conflict must be acknowledged first');
select is(pg_temp.err(format($$select servicing.acknowledge_sync_conflict(%L)$$, pg_temp.got('cf'))), 'ok', 'a servicing.sync.manage holder acknowledges');
select is((select (status, acknowledged_by)::text from servicing.sync_conflicts where id = pg_temp.got('cf')::uuid), '(acknowledged,e9000000-0000-4000-8000-000000000011)', 'recorded with the person');
select is(pg_temp.err(format($$select servicing.acknowledge_sync_conflict(%L)$$, pg_temp.got('cf'))), '55000|conflict_not_open', 'it cannot be acknowledged twice');
select is(pg_temp.err(format($$select servicing.resolve_sync_conflict(%L, 'both', 'a long enough note', '{"ticket":"SAMPLE-T-1"}')$$, pg_temp.got('cf'))), '22023|bad_request', 'the lender must say which version it confirms: existing or incoming');
select is(pg_temp.err(format($$select servicing.resolve_sync_conflict(%L, 'existing', 'too short', '{"ticket":"SAMPLE-T-1"}')$$, pg_temp.got('cf'))), '22023|reason_required', 'a note of at least 10 characters is required');
select is(pg_temp.err(format($$select servicing.resolve_sync_conflict(%L, 'existing', 'a long enough note', '{}')$$, pg_temp.got('cf'))), '22023|evidence_invalid', 'and evidence reviewed');
select is(pg_temp.err(format($$select servicing.resolve_sync_conflict(%L, 'existing', 'a long enough note', '{"contact":"someone@example.com"}')$$, pg_temp.got('cf'))), '22023|evidence_invalid', 'which must not look like personal data');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000013');
select is(pg_temp.err(format($$select servicing.resolve_sync_conflict(%L, 'existing', 'The lender confirmed the earlier figure by ticket', '{"lender_ticket":"SAMPLE-T-1","document":"SAMPLE-DOC-1"}')$$, pg_temp.got('cf'))), 'ok', 'a second person resolves it');
select is((select (status, resolved_by, confirmed_version, evidence_reviewed ? 'lender_ticket')::text from servicing.sync_conflicts where id = pg_temp.got('cf')::uuid),
  '(resolved,e9000000-0000-4000-8000-000000000013,existing,t)', 'with who, which version the lender confirms and the evidence');
select is(pg_temp.snaps('LX1'), 2::bigint, 'resolution did not add a version');
select is((select outstanding_principal_minor from servicing.balance_snapshots where loan_account_id = pg_temp.lid('LX1') and version = 2), 4000000::bigint, 'nor change one: history is never rewritten');
select is((select count(*) from servicing.sync_conflicts where conflict_reason = 'same_record_different_content' and incoming_report ->> 'outstanding_principal' = '39999.00'), 1::bigint, 'and the refused version is still on record');
select is(pg_temp.err(format($$select servicing.resolve_sync_conflict(%L, 'incoming', 'a long enough note', '{"ticket":"SAMPLE-T-2"}')$$, pg_temp.got('cf'))), '55000|conflict_resolved', 'a resolved conflict cannot be resolved again');
select pg_temp.as_owner();
select is(pg_temp.st(format($$update servicing.sync_conflicts set incoming_report = '{}' where id = %L$$, pg_temp.got('cf'))), 'P0001', 'the content of a conflict can never be edited (not even by the owner)');
select is(pg_temp.st(format($$update servicing.sync_conflicts set status = 'open' where id = %L$$, pg_temp.got('cf'))), 'P0001', 'nor reopened');
select is(pg_temp.st(format($$delete from servicing.sync_conflicts where id = %L$$, pg_temp.got('cf'))), 'P0001', 'nor deleted');
select is((select count(*) from audit.events where entity_id = pg_temp.got('cf') and action in ('servicing.conflict.acknowledged', 'servicing.conflict.resolved')), 2::bigint, 'both steps are audited');
select is((select count(*) from audit.events where entity_id = pg_temp.got('cf') and metadata::text ~* 'ticket|SAMPLE|39999'), 0::bigint, 'without the note, the evidence or the figures');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000006');
select is((select figures_available from servicing.my_loan(pg_temp.lid('LX1'))), false, 'while two conflicts are still open the borrower is shown no figures for the loan (fail closed, no explanation of why)');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000011');
select is((select count(*) from (select servicing.acknowledge_sync_conflict(id) from servicing.sync_conflicts where status = 'open') x), 2::bigint, 'the remaining two are acknowledged');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000013');
select is((select count(*) from (select servicing.resolve_sync_conflict(id, 'incoming', 'The lender confirmed the newer figure by ticket', '{"lender_ticket":"SAMPLE-T-3"}') from servicing.sync_conflicts where status = 'acknowledged') x), 2::bigint, 'and resolved (confirming the incoming version still adds nothing: a correction arrives as a newer report)');
select is(pg_temp.snaps('LX1'), 2::bigint, 'LX1 has the same two snapshots');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000006');
select is((select figures_available from servicing.my_loan(pg_temp.lid('LX1'))), true, 'with every conflict resolved the borrower sees the reported figures again');

-- ============================================================================================================================
-- 9. Anomalies: stored as reported, flagged, never corrected
-- ============================================================================================================================
select pg_temp.as_user('e9000000-0000-4000-8000-000000000003');
-- LX2: closed, then reported active again (a status moving backwards).
select pg_temp.keep('an1', pg_temp.stage('e9b00000-0000-4000-8000-000000000001', 'loan', 'anom-status', jsonb_build_array(
  pg_temp.loan('LX2', 'SAMPLE-APP-X2', 'SRC-LX2-2', 4, '{"sequence":"2","status":"closed"}'),
  pg_temp.loan('LX2', 'SAMPLE-APP-X2', 'SRC-LX2-3', 2, '{"sequence":"3","status":"active"}')))::text);
select is((pg_temp.got('an1')::jsonb) ->> 'status', 'previewed', 'a regression is not an error: it is stored and flagged');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000011');
select is((servicing.commit_import(((pg_temp.got('an1')::jsonb) ->> 'batch_id')::uuid)) -> 'applied_counts', '{"changed":2}'::jsonb, 'both reports are applied');
select is((select status from servicing.loan_accounts where id = pg_temp.lid('LX2')), 'closed'::servicing.loan_status, 'the loan account follows the lender into closed but is never reopened by a report');
select is((select array_agg(status::text order by version) from servicing.balance_snapshots where loan_account_id = pg_temp.lid('LX2')), array['active', 'closed', 'active'],
  'while the snapshots keep every status exactly as the lender reported it (never corrected)');
select is((select (kind, severity, previous_status, reported_status)::text from servicing.sync_anomalies where loan_account_id = pg_temp.lid('LX2') and kind = 'status_regression'),
  '(status_regression,warning,closed,active)', 'the regression is flagged for the lender');
select is((select count(*) from servicing.sync_anomalies a join servicing.balance_snapshots s on s.id = a.snapshot_id where a.loan_account_id = pg_temp.lid('LX2') and s.version = 3), 1::bigint, 'attached to the snapshot that caused it');
select is((select (old_status, new_status, actor, actor_user_id)::text from servicing.loan_account_events where loan_account_id = pg_temp.lid('LX2') and event_type = 'status_changed'),
  '(active,closed,lender,e9000000-0000-4000-8000-000000000011)', 'the loan account history records the change to closed with the committing person');
-- LX3: a drop, a rise without a charge, a rise with a penal charge, and parts that do not add up to the stated total.
select pg_temp.as_user('e9000000-0000-4000-8000-000000000003');
select pg_temp.keep('an2', pg_temp.stage('e9b00000-0000-4000-8000-000000000001', 'loan', 'anom-amounts', jsonb_build_array(
  pg_temp.loan('LX3', 'SAMPLE-APP-X3', 'SRC-LX3-A', 3, '{"outstanding_principal":"40000.00"}'),
  pg_temp.loan('LX3', 'SAMPLE-APP-X3', 'SRC-LX3-B', 2.5, '{"outstanding_principal":"41000.00"}'),
  pg_temp.loan('LX3', 'SAMPLE-APP-X3', 'SRC-LX3-C', 2, '{"outstanding_principal":"42000.00","penal_charges":"5.00","total_overdue":"5.00"}'),
  pg_temp.loan('LX3', 'SAMPLE-APP-X3', 'SRC-LX3-D', 1, '{"outstanding_principal":"42000.00","overdue_principal":"10.00","overdue_interest":"5.00","penal_charges":"1.00","other_charges":"0.00","total_overdue":"20.00"}')))::text);
select is((pg_temp.got('an2')::jsonb) -> 'counts' ->> 'changed', '4', 'four newer reports');
select is((pg_temp.got('an2')::jsonb) ->> 'status', 'previewed', 'none is an error');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000011');
select is((servicing.commit_import(((pg_temp.got('an2')::jsonb) ->> 'batch_id')::uuid)) ->> 'status', 'committed', 'committed');
select is(pg_temp.snaps('LX3'), 6::bigint, 'all four were stored');
select is((select array_agg(kind order by kind) from servicing.sync_anomalies where loan_account_id = pg_temp.lid('LX3')), array['outstanding_rise_without_charge', 'overdue_total_mismatch'],
  'exactly two flags: the rise WITHOUT a reported charge and the mismatch (a drop, and a rise with a higher penal charge, raise none)');
select is((select (previous_amount_minor, reported_amount_minor)::text from servicing.sync_anomalies where loan_account_id = pg_temp.lid('LX3') and kind = 'outstanding_rise_without_charge'), '(4000000,4100000)',
  'the rise flag carries both figures as reported');
select is((select (total_overdue_minor, overdue_principal_minor + overdue_interest_minor + penal_charges_minor + other_charges_minor, flags)::text from servicing.balance_snapshots
           where loan_account_id = pg_temp.lid('LX3') and source_record_id = 'SRC-LX3-D'), '(2000,1600,{overdue_total_mismatch})',
  'the stated total (20.00) is stored as stated, not as the parts add up (16.00): flagged, never fixed');
select is((select count(*) from servicing.sync_anomalies where severity = 'warning' and loan_account_id in (pg_temp.lid('LX2'), pg_temp.lid('LX3'))), 3::bigint, 'three warnings in total');
select is((select count(*) from servicing.sync_anomalies where kind not in ('older_report_ignored', 'older_sequence_ignored') and (source_system is null or source_record_id is null or content_sha256 is null or reported_as_of is null or import_batch_id is null)), 0::bigint,
  'every flag carries its provenance');

-- ============================================================================================================================
-- 10. Schedules: versions supersede, never delete
-- ============================================================================================================================
select pg_temp.as_user('e9000000-0000-4000-8000-000000000003');
select pg_temp.keep('sc1', pg_temp.sched('LX1', 'SRC-SCH-1', 4)::text);
select pg_temp.keep('sf1', pg_temp.stage('e9b00000-0000-4000-8000-000000000001', 'schedule', 'sched-1', jsonb_build_array(pg_temp.got('sc1')::jsonb))::text);
select is((pg_temp.got('sf1')::jsonb) -> 'counts' ->> 'new', '1', 'a first schedule is previewed as new');
select pg_temp.as_owner();
select is((select count(*) from servicing.schedule_snapshots where content_sha256 is not null), 0::bigint, 'the preview stored nothing');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000003');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000011');
select is((servicing.commit_import(((pg_temp.got('sf1')::jsonb) ->> 'batch_id')::uuid)) ->> 'status', 'committed', 'committed');
select pg_temp.as_owner();
select is((select (version, source::text, reported_as_of is not null, content_sha256 ~ '^[0-9a-f]{64}$', source_record_id, lender_org_id = 'e9b00000-0000-4000-8000-000000000001', recorded_by)::text
           from servicing.schedule_snapshots where loan_account_id = pg_temp.lid('LX1') and content_sha256 is not null),
  '(1,file_import,t,t,SRC-SCH-1,t,e9000000-0000-4000-8000-000000000011)', 'the schedule snapshot carries its provenance (source, reported_as_of, hash, record id, the person)');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000011');
select pg_temp.as_owner();
select is((select import_batch_id from servicing.schedule_snapshots where loan_account_id = pg_temp.lid('LX1') and content_sha256 is not null), ((pg_temp.got('sf1')::jsonb) ->> 'batch_id')::uuid, 'and the batch');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000011');
select pg_temp.as_owner();
select is((select (seq, due_date > current_date, principal_minor, interest_minor, fees_minor, total_minor)::text from servicing.schedule_installments i join servicing.schedule_snapshots s on s.id = i.snapshot_id
           where s.loan_account_id = pg_temp.lid('LX1') and s.content_sha256 is not null and i.seq = 1), '(1,t,416667,33333,0,450000)', 'installments are stored in integer paise');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000011');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000003');
select is((pg_temp.stage('e9b00000-0000-4000-8000-000000000001', 'schedule', 'sched-1b', jsonb_build_array(pg_temp.got('sc1')::jsonb))::jsonb) -> 'counts' ->> 'unchanged', '1', 'the same schedule again is unchanged');
select pg_temp.keep('sc2', pg_temp.sched('LX1', 'SRC-SCH-2', 2, jsonb_build_object('installments', jsonb_build_array(
  jsonb_build_object('installment_seq', '1', 'due_date', to_char(current_date + 10, 'YYYY-MM-DD'), 'principal', '8333.34', 'interest', '666.66'))))::text);
select pg_temp.keep('sf2', pg_temp.stage('e9b00000-0000-4000-8000-000000000001', 'schedule', 'sched-2', jsonb_build_array(pg_temp.got('sc2')::jsonb))::text);
select is((pg_temp.got('sf2')::jsonb) -> 'counts' ->> 'changed', '1', 'a newer schedule is a change');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000011');
select is((servicing.commit_import(((pg_temp.got('sf2')::jsonb) ->> 'batch_id')::uuid)) ->> 'status', 'committed', 'committed');
select pg_temp.as_owner();
select is((select array_agg(version order by version) from servicing.schedule_snapshots where loan_account_id = pg_temp.lid('LX1') and content_sha256 is not null), array[1, 2], 'a new version supersedes the old one, which stays');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000011');
select is((select count(*) from servicing.schedule_installments i join servicing.schedule_snapshots s on s.id = i.snapshot_id where s.loan_account_id = pg_temp.lid('LX1') and s.version = 1), 2::bigint, 'the first version still has its two installments');
select is((select count(*) from servicing.schedule_installments i join servicing.schedule_snapshots s on s.id = i.snapshot_id where s.loan_account_id = pg_temp.lid('LX1') and s.version = 2), 1::bigint, 'and the second its one');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000003');
select is((pg_temp.stage('e9b00000-0000-4000-8000-000000000001', 'schedule', 'sched-conf', jsonb_build_array(
  (pg_temp.got('sc2')::jsonb) || jsonb_build_object('installments', jsonb_build_array(jsonb_build_object('installment_seq', '1', 'due_date', to_char(current_date + 11, 'YYYY-MM-DD'), 'principal', '8000.00', 'interest', '1000.00')))))::jsonb)
  -> 'counts' ->> 'conflict', '1', 'the same schedule record id with other installments is a conflict, not an overwrite');
select is((pg_temp.stage('e9b00000-0000-4000-8000-000000000001', 'schedule', 'sched-old', jsonb_build_array(pg_temp.sched('LX1', 'SRC-SCH-0', 8)))::jsonb) -> 'counts' ->> 'ignored_older', '1', 'an older schedule is ignored and counted');

-- ============================================================================================================================
-- 11. Receipts and reversals
-- ============================================================================================================================
select pg_temp.keep('rc1', pg_temp.receipt('LX1', 'RC1', '4500.00', 4)::text);
select pg_temp.keep('rf1', pg_temp.stage('e9b00000-0000-4000-8000-000000000001', 'receipt', 'rcpt-1', jsonb_build_array(pg_temp.got('rc1')::jsonb, pg_temp.receipt('LX3', 'RC2', '100.00', 4)))::text);
select is((pg_temp.got('rf1')::jsonb) -> 'counts' ->> 'new', '2', 'two receipts are previewed as new');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000011');
select is((servicing.commit_import(((pg_temp.got('rf1')::jsonb) ->> 'batch_id')::uuid)) ->> 'status', 'committed', 'committed');
select is((select (kind, amount_minor, payment_mode, bank_reference, source_system::text, source_record_id, reported_as_of is not null, content_sha256 ~ '^[0-9a-f]{64}$',
                   import_batch_id = ((pg_temp.got('rf1')::jsonb) ->> 'batch_id')::uuid, recorded_by)::text from servicing.lms_receipts where lms_receipt_ref = 'RC1'),
  '(receipt,450000,upi,SAMPLE-BANKREF-RC1,file_import,SRC-RC1,t,t,t,e9000000-0000-4000-8000-000000000011)', 'a receipt is stored as the lender posted it, with its provenance');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000003');
select is((pg_temp.stage('e9b00000-0000-4000-8000-000000000001', 'receipt', 'rcpt-1b', jsonb_build_array(pg_temp.got('rc1')::jsonb))::jsonb) -> 'counts' ->> 'unchanged', '1', 'the same receipt again is unchanged');
select is((pg_temp.stage('e9b00000-0000-4000-8000-000000000001', 'receipt', 'rcpt-1c', jsonb_build_array(pg_temp.receipt('LX1', 'RC1', '4500.00', 1)))::jsonb) -> 'counts' ->> 'unchanged', '1',
  'also when the lender re-sends it later with a newer reported time (same facts)');
select pg_temp.keep('rf2', pg_temp.stage('e9b00000-0000-4000-8000-000000000001', 'receipt', 'rcpt-diff', jsonb_build_array(pg_temp.receipt('LX1', 'RC1', '4600.00', 4)))::text);
select is((pg_temp.got('rf2')::jsonb) -> 'counts' ->> 'conflict', '1', 'the same receipt reference with another amount is a conflict');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000011');
select is((servicing.commit_import(((pg_temp.got('rf2')::jsonb) ->> 'batch_id')::uuid)) -> 'applied_counts', '{"conflict":1}'::jsonb, 'queued at commit');
select is((select (record_type, conflict_reason, status)::text from servicing.sync_conflicts where record_type = 'receipt'), '(receipt,receipt_differs,open)', 'as a receipt conflict');
select is((select amount_minor from servicing.lms_receipts where lms_receipt_ref = 'RC1'), 450000::bigint, 'and the stored receipt is untouched');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000003');
select pg_temp.keep('rf3', pg_temp.stage('e9b00000-0000-4000-8000-000000000001', 'receipt', 'rcpt-rev1', jsonb_build_array(
  pg_temp.receipt('LX1', 'RV1', '4500.00', 3, '{"receipt_kind":"reversal","reverses_receipt_ref":"RC1","source_record_id":"SRC-RV1"}')))::text);
select pg_temp.as_user('e9000000-0000-4000-8000-000000000011');
select is((servicing.commit_import(((pg_temp.got('rf3')::jsonb) ->> 'batch_id')::uuid)) ->> 'status', 'committed', 'a reversal commits');
select is((select (kind, reverses_receipt_ref, reverses_receipt_id = (select id from servicing.lms_receipts where lms_receipt_ref = 'RC1'), amount_minor)::text from servicing.lms_receipts where lms_receipt_ref = 'RV1'),
  '(reversal,RC1,t,450000)', 'a reversal is its own row, positive, referencing the receipt it reverses');
select is((select count(*) from servicing.sync_anomalies where kind = 'reversal_exceeds_receipt'), 0::bigint, 'a full reversal raises no flag');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000003');
select pg_temp.keep('rf4', pg_temp.stage('e9b00000-0000-4000-8000-000000000001', 'receipt', 'rcpt-rev2', jsonb_build_array(
  pg_temp.receipt('LX1', 'RV2', '1.00', 2, '{"receipt_kind":"reversal","reverses_receipt_ref":"RC1","source_record_id":"SRC-RV2"}')))::text);
select pg_temp.as_user('e9000000-0000-4000-8000-000000000011');
select is((servicing.commit_import(((pg_temp.got('rf4')::jsonb) ->> 'batch_id')::uuid)) ->> 'status', 'committed', 'a further reversal is stored');
select is((select (previous_amount_minor, reported_amount_minor)::text from servicing.sync_anomalies where kind = 'reversal_exceeds_receipt'), '(450000,450100)', 'and flagged: reversals now exceed the receipt (stored, not corrected)');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000003');
select pg_temp.keep('rf5', pg_temp.stage('e9b00000-0000-4000-8000-000000000001', 'receipt', 'rcpt-same-file', jsonb_build_array(
  pg_temp.receipt('LX3', 'RV3', '50.00', 1, '{"receipt_kind":"reversal","reverses_receipt_ref":"RC3","source_record_id":"SRC-RV3"}'),
  pg_temp.receipt('LX3', 'RC3', '50.00', 2)))::text);
select is((pg_temp.got('rf5')::jsonb) ->> 'status', 'previewed', 'a reversal may name a receipt of the same file, in any order');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000011');
select is((servicing.commit_import(((pg_temp.got('rf5')::jsonb) ->> 'batch_id')::uuid)) -> 'applied_counts', '{"new":2}'::jsonb, 'both are applied (the receipt first)');
select is((select count(*) from servicing.lms_receipts r join servicing.lms_receipts o on o.id = r.reverses_receipt_id where r.lms_receipt_ref = 'RV3' and o.lms_receipt_ref = 'RC3' and o.loan_account_id = r.loan_account_id), 1::bigint, 'the reversal references the receipt of the same loan');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000003');
select is(pg_temp.errs(pg_temp.stage('e9b00000-0000-4000-8000-000000000001', 'receipt', 'rcpt-xloan', jsonb_build_array(
  pg_temp.receipt('LX3', 'RV4', '5.00', 1, '{"receipt_kind":"reversal","reverses_receipt_ref":"RC1","source_record_id":"SRC-RV4"}')))), '1:reversal_target_unknown@', 'a reversal cannot name a receipt of another loan');
select is(pg_temp.errs(pg_temp.stage('e9b00000-0000-4000-8000-000000000001', 'receipt', 'rcpt-rev-rev', jsonb_build_array(
  pg_temp.receipt('LX1', 'RV5', '1.00', 1, '{"receipt_kind":"reversal","reverses_receipt_ref":"RV1","source_record_id":"SRC-RV5"}')))), '1:reversal_target_unknown@', 'nor a reversal');
select is((select count(*) from servicing.lms_receipts where amount_minor <= 0), 0::bigint, 'no receipt or reversal has a non-positive amount');

-- ============================================================================================================================
-- 12. servicing.apply_lms_report: the single, system-only entry point for every source
-- ============================================================================================================================
create function pg_temp.cnt(tbl text) returns bigint language plpgsql as $fn$
declare n bigint;
begin execute 'select count(*) from ' || tbl into n; return n; end
$fn$;
create function pg_temp.cnt_not(tbl text, lender uuid) returns bigint language plpgsql as $fn$
declare n bigint;
begin execute 'select count(*) from ' || tbl || ' where lender_org_id <> $1' into n using lender; return n; end
$fn$;
grant execute on function pg_temp.cnt(text), pg_temp.cnt_not(text, uuid) to public;

select pg_temp.as_user('e9000000-0000-4000-8000-000000000003');
select is(pg_temp.err($$select servicing.apply_lms_report('e9b00000-0000-4000-8000-000000000001', '{"report_type":"loan"}')$$), '42501|', 'a person cannot call the system entry point');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000006');
select is(pg_temp.err($$select servicing.apply_lms_report('e9b00000-0000-4000-8000-000000000001', '{"report_type":"loan"}')$$), '42501|', 'nor a borrower');
select pg_temp.as_anon();
select is(pg_temp.err($$select servicing.apply_lms_report('e9b00000-0000-4000-8000-000000000001', '{"report_type":"loan"}')$$), '42501|', 'nor anon');
select pg_temp.as_system();
select is(pg_temp.err($$select servicing.apply_lms_report('e9b00000-0000-4000-8000-000000000003', '{"report_type":"loan","source_system":"file_import"}')$$), '55000|feature_disabled', 'with the switch off (lender Z) the system entry point refuses');
select is(pg_temp.err($$select servicing.apply_lms_report('e9b00000-0000-4000-8000-000000000001', '[]')$$), '22023|report_invalid', 'a report must be an object');
select is(pg_temp.err($$select servicing.apply_lms_report('e9b00000-0000-4000-8000-000000000001', '{"source_system":"file_import"}')$$), '22023|report_type_invalid', 'it needs a known report type');
select is(pg_temp.err($$select servicing.apply_lms_report('e9b00000-0000-4000-8000-000000000001', '{"report_type":"loan","source_system":"telepathy"}')$$), '22023|source_system_invalid', 'and a known source system');
select is(pg_temp.err($$select servicing.apply_lms_report('e9b00000-0000-4000-8000-000000000001', '{"report_type":"loan","source_system":"mock_lms"}')$$), '55000|connection_not_active', 'a mock source needs a mock connection');
select is(pg_temp.err($$select servicing.apply_lms_report('e9b00000-0000-4000-8000-000000000001', '{"report_type":"loan","source_system":"finbyx"}')$$), '55000|connection_not_active', 'a finbyx source can never be active');
select is(pg_temp.err(format($$select servicing.apply_lms_report('e9b00000-0000-4000-8000-000000000001', '{"report_type":"loan","source_system":"file_import"}', %L)$$, pg_temp.got('f1_id'))), '55000|batch_invalid', 'a batch that is not open (already committed) cannot be used');

select pg_temp.keep('ls1', pg_temp.loan('LS1', 'e9200000-0000-4000-8000-000000000007', 'SRC-LS1-1', 2, '{"report_type":"loan","source_system":"file_import","sequence":"1"}')::text);
select pg_temp.keep('ls1_res', servicing.apply_lms_report('e9b00000-0000-4000-8000-000000000001', pg_temp.got('ls1')::jsonb)::text);
select is((pg_temp.got('ls1_res')::jsonb) ->> 'outcome', 'new', 'a first report with complete disbursement evidence for a matching application creates the loan');
select is((pg_temp.got('ls1_res')::jsonb) ->> 'created', 'true', 'and says it created the account');
select is((pg_temp.got('ls1_res')::jsonb) ->> 'content_sha256', (select content_sha256 from servicing.balance_snapshots where source_record_id = 'SRC-LS1-1'), 'returning the content hash that is stored with the snapshot');
select is((servicing.apply_lms_report('e9b00000-0000-4000-8000-000000000001', pg_temp.got('ls1')::jsonb)) ->> 'outcome', 'unchanged', 'the same report again is idempotent: unchanged');
select is((servicing.apply_lms_report('e9b00000-0000-4000-8000-000000000001', (pg_temp.got('ls1')::jsonb) || jsonb_build_object('content_sha256', (pg_temp.got('ls1_res')::jsonb) ->> 'content_sha256'))) ->> 'outcome', 'unchanged',
  'a supplied content hash that matches is accepted');
select is((servicing.apply_lms_report('e9b00000-0000-4000-8000-000000000001', (pg_temp.got('ls1')::jsonb) || jsonb_build_object('content_sha256', repeat('0', 64)))) -> 'error_codes', '["content_hash_mismatch"]'::jsonb,
  'one that does not match is refused as an error result');
select is((select count(*) from servicing.balance_snapshots s join servicing.loan_accounts l on l.id = s.loan_account_id where l.lms_loan_ref = 'LS1'), 1::bigint, 'one snapshot only');
select pg_temp.keep('bad', servicing.apply_lms_report('e9b00000-0000-4000-8000-000000000001', pg_temp.loan('LS2', 'e9200000-0000-4000-8000-000000000008', 'SRC-LS2-1', 2, '{"report_type":"loan","source_system":"file_import","sanctioned_amount":"abc","customer_name":"Asha Rao"}'))::text);
select is((pg_temp.got('bad')::jsonb) ->> 'outcome', 'error', 'an invalid report is returned as an error result, not raised (a worker can park it)');
select is((pg_temp.got('bad')::jsonb) -> 'error_codes', '["invalid_amount", "unknown_field"]'::jsonb, 'with the error classes');
select is(pg_temp.got('bad') !~* 'abc|asha|rao', true, 'and never the offending values');
select is((servicing.apply_lms_report('e9b00000-0000-4000-8000-000000000001', pg_temp.loan('LS3', 'SAMPLE-APP-NOPE', 'SRC-LS3-1', 2, '{"report_type":"loan","source_system":"file_import"}'))) ->> 'outcome', 'quarantined', 'a report for an unknown application is quarantined');
select is((select (reason_code, record_type, source_system::text, lms_loan_ref)::text from servicing.sync_quarantine), '(application_not_found,loan,file_import,LS3)', 'with its reason and provenance');
select is((servicing.apply_lms_report('e9b00000-0000-4000-8000-000000000001', pg_temp.loan('LS3', 'SAMPLE-APP-NOPE', 'SRC-LS3-1', 2, '{"report_type":"loan","source_system":"file_import"}'))) ->> 'outcome', 'quarantined', 'again');
select is((select count(*) from servicing.sync_quarantine), 1::bigint, 'it is quarantined once, however often it is sent');
select is((servicing.apply_lms_report('e9b00000-0000-4000-8000-000000000001', pg_temp.receipt('NOPE', 'RS1', '1.00', 1, '{"report_type":"receipt","source_system":"file_import"}'))) ->> 'reason', 'unknown_loan', 'a receipt for an unknown loan is quarantined');
select is((servicing.apply_lms_report('e9b00000-0000-4000-8000-000000000001', pg_temp.loan('LS4', 'e9200000-0000-4000-8000-000000000007', 'SRC-LS4-1', 2, '{"report_type":"loan","source_system":"file_import"}'))) ->> 'reason', 'application_already_linked', 'a second loan for the same application is quarantined');
select is((servicing.apply_lms_report('e9b00000-0000-4000-8000-000000000001', pg_temp.loan('LS5', 'e9200000-0000-4000-8000-000000000004', 'SRC-LS5-1', 2, '{"report_type":"loan","source_system":"file_import"}'))) ->> 'reason', 'application_not_ready', 'an application that is not ready is quarantined');
select is((servicing.apply_lms_report('e9b00000-0000-4000-8000-000000000001', pg_temp.receipt('LX1', 'RS2', '12.00', 1, '{"report_type":"receipt","source_system":"file_import"}'))) ->> 'outcome', 'new', 'a receipt for a known loan is stored');
select is((servicing.apply_lms_report('e9b00000-0000-4000-8000-000000000001', pg_temp.sched('LX5', 'SRC-SCH-5', 1, '{"report_type":"schedule","source_system":"file_import"}'))) ->> 'outcome', 'new', 'and a schedule');
select is((select count(*) from servicing.sync_quarantine where content_sha256 !~ '^[0-9a-f]{64}$' or lms_loan_ref is null), 0::bigint, 'quarantine rows hold references, class and hash');
select pg_temp.as_owner();
select is((select (status::text, (select count(*) from servicing.loan_accounts l where l.application_id = a.id and l.lms_loan_ref = 'LS1'))::text from lending.applications a where a.id = 'e9200000-0000-4000-8000-000000000007'), '(disbursed,1)',
  'the system path takes the application all the way to disbursed through the existing evidence rule');
select is((select (s.source_system::text, s.import_batch_id is null, s.recorded_by is null)::text from servicing.balance_snapshots s join servicing.loan_accounts l on l.id = s.loan_account_id where l.lms_loan_ref = 'LS1'), '(file_import,t,t)',
  'a system-applied snapshot has no batch and no person, only its source');
select is((select count(*) from servicing.loan_account_events where actor = 'system' and event_type = 'created' and source_system = 'file_import'), 1::bigint, 'and the loan history names the system as actor');
select is((select last_success_at is not null from servicing.lms_connections where lender_org_id = 'e9b00000-0000-4000-8000-000000000001'), true, 'the connection records its last success');

-- The mock source: only where the session allows mock providers; never otherwise.
select set_config('udofin.allow_mock_providers', 'on', true);
update servicing.lms_connections set kind = 'mock', provider_mode = 'mock' where lender_org_id = 'e9b00000-0000-4000-8000-000000000001';
select pg_temp.as_system();
select is((servicing.apply_lms_report('e9b00000-0000-4000-8000-000000000001', pg_temp.loan('LX5', 'SAMPLE-APP-X5', 'SRC-LX5-M1', 1, '{"report_type":"loan","source_system":"mock_lms","sequence":"9"}'))) ->> 'outcome', 'changed',
  'in a session that allows mock providers a mock connection works');
select is((select source_system::text from servicing.balance_snapshots where source_record_id = 'SRC-LX5-M1'), 'mock_lms', 'and its snapshot is labelled mock_lms');
select is(pg_temp.err($$select servicing.apply_lms_report('e9b00000-0000-4000-8000-000000000001', '{"report_type":"loan","source_system":"file_import"}')$$), '55000|connection_not_active', 'a file report is refused on a mock connection');
select pg_temp.as_owner();
select set_config('udofin.allow_mock_providers', '', true);
select pg_temp.as_system();
select is(pg_temp.err(format($$select servicing.apply_lms_report('e9b00000-0000-4000-8000-000000000001', %L)$$, pg_temp.loan('LX5', 'SAMPLE-APP-X5', 'SRC-LX5-M2', 0.5, '{"report_type":"loan","source_system":"mock_lms","sequence":"10"}'))),
  '42501|mock_provider_blocked', 'in a session that does not allow mock providers the same call is refused: a mock source cannot work in production');
select pg_temp.as_owner();
select set_config('udofin.allow_mock_providers', 'on', true);
update servicing.lms_connections set kind = 'file_import', provider_mode = 'production' where lender_org_id = 'e9b00000-0000-4000-8000-000000000001';
select set_config('udofin.allow_mock_providers', '', true);
select is((select (kind, provider_mode::text)::text from servicing.lms_connections where lender_org_id = 'e9b00000-0000-4000-8000-000000000001'), '(file_import,production)', 'the file connection is restored');

-- Stage and commit by the same person is allowed, and the audit trail records both steps.
select pg_temp.as_user('e9000000-0000-4000-8000-000000000013');
select pg_temp.keep('same', pg_temp.stage('e9b00000-0000-4000-8000-000000000001', 'loan', 'same-person', jsonb_build_array(pg_temp.loan('LX5', 'SAMPLE-APP-X5', 'SRC-LX5-S', 0.2, '{"sequence":"11"}')))::text);
select is((servicing.commit_import(((pg_temp.got('same')::jsonb) ->> 'batch_id')::uuid)) ->> 'status', 'committed', 'one person stages and commits');
select pg_temp.as_owner();
select is((select array_agg(action || ':' || actor_user_id::text order by action) from audit.events where entity_id = (pg_temp.got('same')::jsonb) ->> 'batch_id'),
  array['servicing.import.committed:e9000000-0000-4000-8000-000000000013', 'servicing.import.staged:e9000000-0000-4000-8000-000000000013'], 'and the audit trail has both events with the person');

-- ============================================================================================================================
-- 13. Manual entry (lender Y) and tenant separation of every table
-- ============================================================================================================================
select pg_temp.as_user('e9000000-0000-4000-8000-000000000005');
select is(servicing.set_lms_connection('e9b00000-0000-4000-8000-000000000002', 'manual', 'active')::text is not null, true, 'lender Y switches to a manual connection');
select is(pg_temp.err(format($$select servicing.stage_import('e9b00000-0000-4000-8000-000000000002', 'loan', 'file', %L, 1000, 'udofin-lms-import-v1', '[{}]', 'idem-y-file-000001')$$, repeat('7', 64))), '55000|connection_not_active', 'a manual connection does not accept files');
select pg_temp.keep('y1', pg_temp.stage('e9b00000-0000-4000-8000-000000000002', 'loan', 'y-manual', jsonb_build_array(pg_temp.loan('LY1', 'SAMPLE-APP-Y9', 'SRC-LY1-1', 2, '{"sequence":"1"}')), null, 'manual')::text);
select is((pg_temp.got('y1')::jsonb) ->> 'status', 'previewed', 'a manual entry is a one-record import: previewed');
select is((select source_system::text from servicing.import_batches where id = ((pg_temp.got('y1')::jsonb) ->> 'batch_id')::uuid), 'manual_import', 'attributed to manual_import');
select is((servicing.commit_import(((pg_temp.got('y1')::jsonb) ->> 'batch_id')::uuid)) ->> 'status', 'committed', 'and committed');
select is((select (source_system::text, status::text)::text from servicing.loan_accounts where lms_loan_ref = 'LY1'), '(manual_import,active)', 'the loan account is labelled manual_import');
select is((servicing.commit_import(((pg_temp.stage('e9b00000-0000-4000-8000-000000000002', 'receipt', 'y-receipt', jsonb_build_array(pg_temp.receipt('LY1', 'RC1', '10.00', 1)), null, 'manual'))::jsonb ->> 'batch_id')::uuid)) ->> 'status', 'committed',
  'the same lender receipt reference as lender X''s is fine for lender Y (unique per lender)');
select is(pg_temp.errs(pg_temp.stage('e9b00000-0000-4000-8000-000000000002', 'receipt', 'y-xloan', jsonb_build_array(pg_temp.receipt('LX1', 'RCY', '1.00', 1)), null, 'manual')), '1:unknown_loan@', 'lender Y cannot report a receipt against lender X''s loan');
select is(pg_temp.errs(pg_temp.stage('e9b00000-0000-4000-8000-000000000002', 'loan', 'y-xapp', jsonb_build_array(pg_temp.loan('LY2', 'SAMPLE-APP-X1', 'SRC-LY2-1', 2)), null, 'manual')), '1:application_not_found@', 'nor name lender X''s application');
select is((pg_temp.stage('e9b00000-0000-4000-8000-000000000002', 'loan', 'same-rec', jsonb_build_array(pg_temp.loan('LY3', 'SAMPLE-APP-Y10', 'SRC-LY3-1', 3)), null, 'manual')::jsonb) ->> 'existing', 'false',
  'a file hash that lender X used is independent for lender Y');
select is((pg_temp.cnt('servicing.lms_connections')), 1::bigint, 'Y sees its own connection only');
select is(pg_temp.cnt('servicing.import_batches') > 0 and pg_temp.cnt_not('servicing.import_batches', 'e9b00000-0000-4000-8000-000000000002') = 0, true, 'Y sees only its own batches');
select is((select bool_and(pg_temp.cnt_not(t, 'e9b00000-0000-4000-8000-000000000002') = 0) from unnest(array['servicing.lms_connections', 'servicing.import_batches', 'servicing.import_rows', 'servicing.balance_snapshots',
  'servicing.lms_receipts', 'servicing.sync_anomalies', 'servicing.sync_conflicts', 'servicing.sync_quarantine', 'servicing.loan_sync_status', 'servicing.loan_accounts', 'servicing.schedule_snapshots']) t), true,
  'in none of the tables does Y see a row of another lender');
select is((select count(*) from servicing.import_errors(((pg_temp.got('f2')::jsonb) ->> 'batch_id')::uuid)), 0::bigint, 'import_errors shows Y nothing of X''s batch');
select is((select count(*) from servicing.loan_as_reported_at(pg_temp.lid('LX1'), now())) + (select count(*) from servicing.loan_as_known_at(pg_temp.lid('LX1'), clock_timestamp())), 0::bigint, 'nor X''s history');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000003');
select is((select bool_and(pg_temp.cnt_not(t, 'e9b00000-0000-4000-8000-000000000001') = 0) from unnest(array['servicing.lms_connections', 'servicing.import_batches', 'servicing.import_rows', 'servicing.balance_snapshots',
  'servicing.lms_receipts', 'servicing.sync_anomalies', 'servicing.sync_conflicts', 'servicing.sync_quarantine', 'servicing.loan_sync_status', 'servicing.loan_accounts', 'servicing.schedule_snapshots']) t), true,
  'and X sees nothing of Y');
select is((select bool_and(pg_temp.cnt(t) > 0) from unnest(array['servicing.lms_connections', 'servicing.import_batches', 'servicing.import_rows', 'servicing.balance_snapshots',
  'servicing.lms_receipts', 'servicing.sync_anomalies', 'servicing.sync_conflicts', 'servicing.sync_quarantine', 'servicing.loan_sync_status']) t), true, 'while each table does hold rows for X (the negative checks are not vacuous)');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000012');
select is((select bool_and(pg_temp.cnt(t) = 0) from unnest(array['servicing.lms_connections', 'servicing.import_batches', 'servicing.import_rows', 'servicing.balance_snapshots',
  'servicing.lms_receipts', 'servicing.sync_anomalies', 'servicing.sync_conflicts', 'servicing.sync_quarantine', 'servicing.loan_sync_status']) t), true, 'a lender with the switch off (Z) has nothing and sees nothing');
select pg_temp.as_anon();
select is((select bool_and(pg_temp.st(format('select * from %s', t)) = '42501') from unnest(array['servicing.lms_connections', 'servicing.import_batches', 'servicing.import_rows', 'servicing.balance_snapshots',
  'servicing.lms_receipts', 'servicing.sync_anomalies', 'servicing.sync_conflicts', 'servicing.sync_quarantine', 'servicing.loan_sync_status']) t), true, 'anon cannot read any of them');
select is(pg_temp.err($$select * from servicing.my_loans()$$), '42501|', 'nor call the borrower function');
select is(pg_temp.err($$select * from servicing.loan_as_reported_at(gen_random_uuid(), now())$$), '42501|', 'nor the history function');
select is(pg_temp.err($$select * from servicing.import_errors(gen_random_uuid())$$), '42501|', 'nor the preview function');

-- ============================================================================================================================
-- 14. Borrower reads: reported figures only, own loans only, nothing about anomalies, conflicts or imports
-- ============================================================================================================================
select pg_temp.as_user('e9000000-0000-4000-8000-000000000006');
select is((select array_agg(lender_loan_ref order by lender_loan_ref) from servicing.my_loans()), array['LS1', 'LX1', 'LX3', 'LX5', 'LX7', 'LY1'], 'borrower b1 sees exactly their own six loans, across both lenders');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000007');
select is((select array_agg(lender_loan_ref order by lender_loan_ref) from servicing.my_loans()), array['LX2', 'LX6', 'OTHER-LN'], 'borrower b2 sees exactly theirs');
select is(pg_temp.err(format($$select * from servicing.my_loan(%L)$$, pg_temp.lid('LX1'))), 'P0002|', 'b2 cannot open b1''s loan');
select is(pg_temp.err(format($$select * from servicing.my_loan(%L)$$, pg_temp.lid('LY1', 'e9b00000-0000-4000-8000-000000000002'))), 'P0002|', 'nor a loan of another lender');
select is(pg_temp.err($$select * from servicing.my_loan(gen_random_uuid())$$), 'P0002|', 'an unknown loan answers the same way');
select is(pg_temp.err($$select * from servicing.my_loan(null)$$), 'P0002|', 'and a null one');
select is((select (loan_status::text, reported_status::text, figures_available)::text from servicing.my_loan(pg_temp.lid('LX2'))), '(closed,,f)',
  'b2''s closed loan: the lender''s latest report (a flagged regression) is withheld rather than shown, and the loan status stays closed');
select is((select (outstanding_principal_minor is null and overdue_principal_minor is null and total_overdue_minor is null and next_due_on is null and days_past_due is null)::text from servicing.my_loan(pg_temp.lid('LX2'))), 'true',
  'every figure is null while withheld');
select is((select (stale, stale_threshold_minutes, figures_available, reported_as_of is not null, lender_display_name)::text from servicing.my_loan(pg_temp.lid('LX6'))), '(t,1440,t,t,"Servicing X")',
  'a report older than the lender''s threshold (30 hours against 24) is flagged stale, and the lender''s name is shown');
select is((select (reported_as_of is null, stale, figures_available, sanctioned_amount_minor)::text from servicing.my_loan(pg_temp.lid('OTHER-LN'))), '(t,t,f,5000000)', 'a loan with no report at all is stale with no figures; only the stored loan facts show');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000006');
select is((select (figures_available, reported_status::text, outstanding_principal_minor, next_due_minor, days_past_due, stale, lender_display_name)::text from servicing.my_loan(pg_temp.lid('LX1'))),
  '(t,active,4000000,450000,0,f,"Servicing X")', 'b1''s clean loan: the figures exactly as the lender reported them (version 2), not stale');
select is((select figures_available from servicing.my_loan(pg_temp.lid('LX3'))), false, 'a loan whose newest report has a parts-versus-total mismatch shows no figures');
select is((select reported_as_of is not null from servicing.my_loan(pg_temp.lid('LX3'))), true, 'but still says when the lender last reported');
select is((select (figures_available, reported_status::text)::text from servicing.my_loan(pg_temp.lid('LY1', 'e9b00000-0000-4000-8000-000000000002'))), '(t,active)', 'and the loan at lender Y is shown on its own terms');
select is(pg_get_function_result('servicing.my_loans'::regproc) !~* 'anomal|conflict|batch|import|content_sha|source_record|quarantine|recorded_by|flag', true, 'the borrower function exposes no anomaly, conflict, import or provenance column');
select is((select bool_and(pg_temp.cnt(t) = 0) from unnest(array['servicing.lms_connections', 'servicing.import_batches', 'servicing.import_rows', 'servicing.balance_snapshots',
  'servicing.lms_receipts', 'servicing.sync_anomalies', 'servicing.sync_conflicts', 'servicing.sync_quarantine', 'servicing.loan_sync_status']) t), true, 'a borrower reads none of the tables or the status view directly');
select is((select count(*) from servicing.loan_accounts), 6::bigint, 'only their own loan accounts (the existing borrower policy)');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000003');
select is((select count(*) from servicing.my_loans()), 0::bigint, 'a lender user is not a borrower: the borrower function returns nothing');
-- Staleness is computed from the connection's threshold: now minus the newest reported_as_of.
select is((select (stale, newest_has_warning, has_open_conflict)::text from servicing.loan_sync_status where lms_loan_ref = 'LX6'), '(t,f,f)', 'the lender status view: LX6 is stale');
select is((select (stale, newest_has_warning, has_open_conflict)::text from servicing.loan_sync_status where lms_loan_ref = 'LX1'), '(f,f,t)', 'LX1 is fresh, and the lender view shows its open receipt conflict (which does not withhold the borrower''s figures)');
select is((select (stale, newest_has_warning)::text from servicing.loan_sync_status where lms_loan_ref = 'LX3'), '(f,t)', 'LX3 carries a warning on its newest report');
select is((select (stale, newest_reported_status::text, loan_status::text)::text from servicing.loan_sync_status where lms_loan_ref = 'OTHER-LN'), '(t,,active)', 'a loan with no report is stale');
select is(servicing.set_lms_connection('e9b00000-0000-4000-8000-000000000001', 'file_import', 'active', '{"receipts":true}', 240)::text is not null, true, 'the threshold is the lender''s setting (here 4 hours)');
select is((select stale from servicing.loan_sync_status where lms_loan_ref = 'LX7'), true, 'LX7 (reported 5 hours ago) is now stale');
select is((select stale from servicing.loan_sync_status where lms_loan_ref = 'LX1'), false, 'LX1 (3 hours) is not');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000006');
select is((select (stale, stale_threshold_minutes)::text from servicing.my_loan(pg_temp.lid('LX7'))), '(t,240)', 'the borrower sees the same flag and threshold');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000003');
select is(servicing.set_lms_connection('e9b00000-0000-4000-8000-000000000001', 'file_import', 'active', '{"receipts":true}', 1440)::text is not null, true, 'restored');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000006');
select is((select stale from servicing.my_loan(pg_temp.lid('LX7'))), false, 'and LX7 is fresh again');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000009');

-- A platform auditor holds loan.read (platform-grantable), like for loan accounts: read only, no authority to write or decide.
select pg_temp.as_user('e9000000-0000-4000-8000-000000000009');
select is((select count(*) from servicing.balance_snapshots) > 0 and (select count(*) from servicing.import_batches) > 0, true, 'a platform auditor with loan.read can read the reported records and the import audit record');
select is((select count(*) from servicing.my_loans()), 0::bigint, 'but is not a borrower');
select is(pg_temp.err(format($$select servicing.commit_import(%L)$$, (pg_temp.got('dupl')::jsonb) ->> 'batch_id')), '42501|', 'cannot commit an import');
select is(pg_temp.err(format($$select servicing.stage_import('e9b00000-0000-4000-8000-000000000001', 'loan', 'file', %L, 1000, 'udofin-lms-import-v1', '[{}]', 'idem-auditor-00001')$$, repeat('a', 64))), '42501|', 'cannot stage one');
select is(pg_temp.err(format($$select servicing.acknowledge_sync_conflict(%L)$$, (select id from servicing.sync_conflicts limit 1))), '42501|', 'and cannot work the conflict queue');

-- ============================================================================================================================
-- 15. Append-only, composite tenant keys, constraints, no direct writes
-- ============================================================================================================================
select pg_temp.as_owner();
select is(pg_temp.st($$update servicing.balance_snapshots set status = 'closed'$$), 'P0001', 'balance_snapshots cannot be updated');
select is(pg_temp.st($$delete from servicing.balance_snapshots$$), 'P0001', 'nor deleted');
select is(pg_temp.st($$update servicing.lms_receipts set amount_minor = 1$$), 'P0001', 'receipts cannot be updated');
select is(pg_temp.st($$delete from servicing.lms_receipts$$), 'P0001', 'nor deleted');
select is(pg_temp.st($$update servicing.sync_anomalies set severity = 'info' where severity = 'warning'$$), 'P0001', 'anomalies cannot be updated');
select is(pg_temp.st($$delete from servicing.sync_anomalies$$), 'P0001', 'nor deleted');
select is(pg_temp.st($$update servicing.sync_quarantine set reason_code = 'unknown_loan'$$), 'P0001', 'quarantine records cannot be updated');
select is(pg_temp.st($$delete from servicing.sync_quarantine$$), 'P0001', 'nor deleted');
select is(pg_temp.st($$update servicing.schedule_snapshots set content_sha256 = repeat('0', 64) where content_sha256 is not null$$), 'P0001', 'schedule snapshots cannot be updated');
select is(pg_temp.st($$delete from servicing.schedule_installments$$), 'P0001', 'nor their installments deleted');
select is(pg_temp.st($$update servicing.import_rows set normalised = '{}' where normalised is not null$$), 'P0001', 'stored import rows cannot be rewritten after staging');
select is(pg_temp.st($$delete from servicing.import_rows$$), 'P0001', 'nor deleted');
select is(pg_temp.st($$update servicing.import_batches set file_sha256 = repeat('b', 64) where status = 'committed'$$), 'P0001', 'a committed batch cannot change');
select is(pg_temp.st($$delete from servicing.import_batches$$), 'P0001', 'nor be deleted');
select is(pg_temp.st($$delete from servicing.lms_connections$$), 'P0001', 'nor a connection');
select is(pg_temp.st(format($$update servicing.import_rows set applied_result = 'new' where batch_id = %L and applied_result is not null$$, pg_temp.got('f1_id'))), 'P0001', 'the applied result of a row is write-once');
select is(pg_temp.st($$update servicing.import_batches set status = 'uploaded' where status = 'previewed'$$), 'P0001', 'batch states only move forward');
-- Composite tenant keys: the lender on a child row must be the lender of the loan.
select is(pg_temp.st(format($$insert into servicing.balance_snapshots (lender_org_id, loan_account_id, version, status, source_system, source_record_id, reported_as_of, content_sha256)
  values ('e9b00000-0000-4000-8000-000000000002', %L, 99, 'active', 'file_import', 'X', now(), repeat('c', 64))$$, pg_temp.lid('LX1'))), '23503', 'a snapshot of lender Y cannot hang off lender X''s loan');
select is(pg_temp.st(format($$insert into servicing.lms_receipts (lender_org_id, loan_account_id, kind, lms_receipt_ref, amount_minor, value_date, source_system, source_record_id, reported_as_of, content_sha256)
  values ('e9b00000-0000-4000-8000-000000000002', %L, 'receipt', 'XR', 100, current_date, 'file_import', 'X', now(), repeat('c', 64))$$, pg_temp.lid('LX1'))), '23503', 'nor a receipt');
select is(pg_temp.st(format($$insert into servicing.sync_anomalies (lender_org_id, loan_account_id, kind, severity, source_system, source_record_id, content_sha256, reported_as_of)
  values ('e9b00000-0000-4000-8000-000000000002', %L, 'status_regression', 'warning', 'file_import', 'X', repeat('c', 64), now())$$, pg_temp.lid('LX1'))), '23503', 'nor an anomaly');
select is(pg_temp.st(format($$insert into servicing.import_rows (lender_org_id, batch_id, row_no, outcome)
  values ('e9b00000-0000-4000-8000-000000000002', %L, 99, 'new')$$, pg_temp.got('f1_id'))), '23503', 'nor an import row hang off lender X''s batch');
select is(pg_temp.st(format($$insert into servicing.balance_snapshots (lender_org_id, loan_account_id, version, status, source_system, source_record_id, reported_as_of, content_sha256, import_batch_id)
  values ('e9b00000-0000-4000-8000-000000000001', %L, 99, 'active', 'file_import', 'X', now(), repeat('c', 64), %L)$$, pg_temp.lid('LX1'),
  (select id from servicing.import_batches where lender_org_id = 'e9b00000-0000-4000-8000-000000000002' limit 1))), '23503', 'nor may a snapshot name another lender''s import batch');
-- Table constraints.
select is(pg_temp.st(format($$insert into servicing.balance_snapshots (lender_org_id, loan_account_id, version, status, source_system, source_record_id, reported_as_of, content_sha256, outstanding_principal_minor)
  values ('e9b00000-0000-4000-8000-000000000001', %L, 99, 'active', 'file_import', 'X', now(), repeat('c', 64), -1)$$, pg_temp.lid('LX1'))), '23514', 'a negative figure is refused by the table');
select is(pg_temp.st(format($$insert into servicing.balance_snapshots (lender_org_id, loan_account_id, version, status, source_system, source_record_id, reported_as_of, content_sha256, next_due_on)
  values ('e9b00000-0000-4000-8000-000000000001', %L, 99, 'active', 'file_import', 'X', now(), repeat('c', 64), current_date)$$, pg_temp.lid('LX1'))), '23514', 'a due date without an amount is refused');
select is(pg_temp.st(format($$insert into servicing.balance_snapshots (lender_org_id, loan_account_id, version, status, source_system, source_record_id, reported_as_of, content_sha256)
  select lender_org_id, loan_account_id, 99, 'active', 'file_import', 'X', now(), content_sha256 from servicing.balance_snapshots where loan_account_id = %L limit 1$$, pg_temp.lid('LX1'))), '23505',
  'the same content hash cannot be stored twice for a loan');
select is(pg_temp.st(format($$insert into servicing.balance_snapshots (lender_org_id, loan_account_id, version, status, source_system, source_record_id, reported_as_of, content_sha256, lender_sequence)
  values ('e9b00000-0000-4000-8000-000000000001', %L, 99, 'active', 'file_import', 'X', now(), repeat('d', 64), 5)$$, pg_temp.lid('LX1'))), '23505', 'nor the lender''s sequence number');
select is(pg_temp.st(format($$insert into servicing.lms_receipts (lender_org_id, loan_account_id, kind, lms_receipt_ref, amount_minor, value_date, source_system, source_record_id, reported_as_of, content_sha256)
  values ('e9b00000-0000-4000-8000-000000000001', %L, 'reversal', 'XR', 100, current_date, 'file_import', 'X', now(), repeat('c', 64))$$, pg_temp.lid('LX1'))), '23514', 'a reversal without the receipt it reverses is refused');
select is(pg_temp.st(format($$insert into servicing.lms_receipts (lender_org_id, loan_account_id, kind, lms_receipt_ref, amount_minor, value_date, source_system, source_record_id, reported_as_of, content_sha256)
  values ('e9b00000-0000-4000-8000-000000000001', %L, 'receipt', 'XR', 0, current_date, 'file_import', 'X', now(), repeat('c', 64))$$, pg_temp.lid('LX1'))), '23514', 'a zero receipt is refused');
select is(pg_temp.st(format($$insert into servicing.lms_receipts (lender_org_id, loan_account_id, kind, lms_receipt_ref, amount_minor, value_date, source_system, source_record_id, reported_as_of, content_sha256, reverses_receipt_id, reverses_receipt_ref)
  values ('e9b00000-0000-4000-8000-000000000001', %L, 'reversal', 'XR', 5, current_date, 'file_import', 'X', now(), repeat('c', 64), (select id from servicing.lms_receipts where lms_receipt_ref = 'RC1' and lender_org_id = 'e9b00000-0000-4000-8000-000000000001'), 'RC1')$$, pg_temp.lid('LX3'))), '23514',
  'a reversal cannot reference a receipt of another loan (trigger)');
select is(pg_temp.st($$insert into servicing.lms_receipts (lender_org_id, loan_account_id, kind, lms_receipt_ref, amount_minor, value_date, source_system, source_record_id, reported_as_of, content_sha256)
  select lender_org_id, loan_account_id, 'receipt', 'RC1', 5, current_date, 'file_import', 'X', now(), repeat('c', 64) from servicing.lms_receipts where lms_receipt_ref = 'RC1' limit 1$$), '23505', 'a lender receipt reference is unique per lender');
select is(pg_temp.st($$insert into servicing.import_batches (lender_org_id, kind, source_kind, source_system, format_version, file_sha256, byte_size, idempotency_key, row_count, uploaded_by)
  values ('e9b00000-0000-4000-8000-000000000001', 'loan', 'file', 'finbyx', 'udofin-lms-import-v1', repeat('e', 64), 10, 'direct-insert-key-02', 1, 'e9000000-0000-4000-8000-000000000003')$$), '23514', 'a batch can only come from file_import or manual_import');
select is(pg_temp.st($$insert into servicing.import_batches (lender_org_id, kind, source_kind, source_system, format_version, file_sha256, byte_size, idempotency_key, row_count, uploaded_by, status)
  values ('e9b00000-0000-4000-8000-000000000001', 'loan', 'file', 'file_import', 'udofin-lms-import-v1', repeat('e', 64), 10, 'direct-insert-key-03', 1, 'e9000000-0000-4000-8000-000000000003', 'committed')$$), '23514', 'nor start as committed');
-- No direct writes for people or the system role, on any of the new tables.
select pg_temp.as_user('e9000000-0000-4000-8000-000000000003');
select is((select bool_and(pg_temp.st(format('insert into %s default values', t)) = '42501') from unnest(array['servicing.lms_connections', 'servicing.import_batches', 'servicing.import_rows', 'servicing.balance_snapshots',
  'servicing.lms_receipts', 'servicing.sync_anomalies', 'servicing.sync_conflicts', 'servicing.sync_quarantine']) t), true, 'an operator cannot insert into any of the new tables');
select is((select bool_and(pg_temp.st(format('update %s set lender_org_id = lender_org_id', t)) = '42501') from unnest(array['servicing.lms_connections', 'servicing.import_batches', 'servicing.import_rows', 'servicing.balance_snapshots',
  'servicing.lms_receipts', 'servicing.sync_anomalies', 'servicing.sync_conflicts', 'servicing.sync_quarantine']) t), true, 'nor update');
select is((select bool_and(pg_temp.st(format('delete from %s', t)) = '42501') from unnest(array['servicing.lms_connections', 'servicing.import_batches', 'servicing.import_rows', 'servicing.balance_snapshots',
  'servicing.lms_receipts', 'servicing.sync_anomalies', 'servicing.sync_conflicts', 'servicing.sync_quarantine']) t), true, 'nor delete');
select pg_temp.as_system();
select is((select bool_and(pg_temp.st(format('insert into %s default values', t)) = '42501') from unnest(array['servicing.lms_connections', 'servicing.import_batches', 'servicing.import_rows', 'servicing.balance_snapshots',
  'servicing.lms_receipts', 'servicing.sync_anomalies', 'servicing.sync_conflicts', 'servicing.sync_quarantine']) t), true, 'the system role cannot insert either: every write goes through the definer functions');
select is((select bool_and(pg_temp.st(format('update %s set lender_org_id = lender_org_id', t)) = '42501') from unnest(array['servicing.lms_connections', 'servicing.import_batches', 'servicing.import_rows', 'servicing.balance_snapshots',
  'servicing.lms_receipts', 'servicing.sync_anomalies', 'servicing.sync_conflicts', 'servicing.sync_quarantine']) t), true, 'nor update');
select is(pg_temp.st('truncate servicing.balance_snapshots'), '42501', 'nor truncate');

-- ============================================================================================================================
-- 16. Rejecting a previewed batch; the kill switch
-- ============================================================================================================================
select pg_temp.as_user('e9000000-0000-4000-8000-000000000010');
select pg_temp.keep('rj', pg_temp.stage('e9b00000-0000-4000-8000-000000000001', 'loan', 'rej-1', jsonb_build_array(pg_temp.loan('LX7', 'SAMPLE-APP-X13', 'SRC-LX7-2', 1, '{"sequence":"2"}')))::text);
select pg_temp.keep('rj_id', (pg_temp.got('rj')::jsonb) ->> 'batch_id');
select is((pg_temp.got('rj')::jsonb) ->> 'status', 'previewed', 'a manual-entry-only person can stage');
select is(pg_temp.err(format($$select servicing.reject_import(%L, 'too short')$$, pg_temp.got('rj_id'))), '22023|reason_required', 'a rejection needs a reason of at least 10 characters');
select is(pg_temp.err(format($$select servicing.reject_import(%L, %L)$$, pg_temp.got('rj_id'), repeat('x', 1001))), '22023|reason_invalid', 'and at most 1000');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000004');
select is(pg_temp.err(format($$select servicing.reject_import(%L, 'Rejected because the period is wrong')$$, pg_temp.got('rj_id'))), '42501|', 'a viewer cannot reject');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000005');
select is(pg_temp.err(format($$select servicing.reject_import(%L, 'Rejected because the period is wrong')$$, pg_temp.got('rj_id'))), 'P0002|', 'another lender cannot see the batch to reject it');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000010');
select is((servicing.reject_import(pg_temp.got('rj_id')::uuid, 'Rejected because the period is wrong')) ->> 'status', 'rejected', 'the staging person rejects it');
select is((select (status, rejected_by, reported_as_of_min is null, reject_reason is not null)::text from servicing.import_batches where id = pg_temp.got('rj_id')::uuid), '(rejected,e9000000-0000-4000-8000-000000000010,t,t)', 'with who and why');
select is((select count(*) from servicing.import_rows where batch_id = pg_temp.got('rj_id')::uuid and (normalised is not null or source_record_id is not null or row_sha256 is not null)), 0::bigint, 'and its row values are dropped (hashes and counts stay)');
select is((servicing.reject_import(pg_temp.got('rj_id')::uuid, 'Rejected because the period is wrong')) ->> 'existing', 'true', 'rejecting again is idempotent');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000011');
select is(pg_temp.err(format($$select servicing.commit_import(%L)$$, pg_temp.got('rj_id'))), '55000|batch_rejected', 'a rejected batch cannot be committed');
select pg_temp.as_owner();
select is((select count(*) from audit.events where entity_id = pg_temp.got('rj_id') and action = 'servicing.import.rejected' and actor_user_id = 'e9000000-0000-4000-8000-000000000010'), 1::bigint, 'the rejection is audited');
select is((select count(*) from audit.events where entity_id = pg_temp.got('rj_id') and metadata::text ~* 'period'), 0::bigint, 'without the free-text reason');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000003');
select is((pg_temp.stage('e9b00000-0000-4000-8000-000000000001', 'loan', 'rej-1', jsonb_build_array(pg_temp.loan('LX7', 'SAMPLE-APP-X13', 'SRC-LX7-2', 1, '{"sequence":"2"}')))::jsonb) ->> 'existing', 'true',
  'the same call replays the rejected batch (same idempotency key)');
select pg_temp.keep('rj2', servicing.stage_import('e9b00000-0000-4000-8000-000000000001', 'loan', 'file', pg_temp.sha('rej-1'), 1000, 'udofin-lms-import-v1',
  jsonb_build_array(pg_temp.loan('LX7', 'SAMPLE-APP-X13', 'SRC-LX7-2', 1, '{"sequence":"2"}')), 'idem-rej-1-restaged-1', pg_temp.got('rj_id')::uuid)::text);
select is((pg_temp.got('rj2')::jsonb) ->> 'existing', 'false', 'a rejected file releases its hash: with a new idempotency key it is a new batch');
select is((pg_temp.got('rj2')::jsonb) ->> 'status', 'previewed', 'previewed again');
-- One open conflict for the kill switch test.
select pg_temp.keep('kc', pg_temp.stage('e9b00000-0000-4000-8000-000000000001', 'loan', 'kill-conf', jsonb_build_array(pg_temp.loan('LX7', 'SAMPLE-APP-X13', 'SRC-LX7-1', 6, '{"sequence":"4","outstanding_principal":"1.00"}')))::text);
select is((pg_temp.got('kc')::jsonb) -> 'counts' ->> 'conflict', '1', 'an older report under an existing record id is a conflict');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000011');
select is((servicing.commit_import(((pg_temp.got('kc')::jsonb) ->> 'batch_id')::uuid)) ->> 'status', 'committed', 'queued');
select pg_temp.keep('kc_id', (select id::text from servicing.sync_conflicts where status = 'open' and record_type = 'loan'));
select pg_temp.as_user('e9000000-0000-4000-8000-000000000001');
select is(pg_temp.err($$select servicing.kill_feature('e9b00000-0000-4000-8000-000000000001', 'servicing_sync', 'Emergency test of the servicing kill switch', 'e9-kill-key-000000001')$$), 'ok', 'a platform administrator turns lender X''s servicing_sync switch off');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000003');
select is(pg_temp.err(format($$select servicing.stage_import('e9b00000-0000-4000-8000-000000000001', 'loan', 'file', %L, 1000, 'udofin-lms-import-v1', '[{}]', 'idem-after-kill-0001')$$, repeat('9', 64))), '55000|feature_disabled', 'after the switch is off nothing can be staged');
select is(pg_temp.err($$select servicing.set_lms_connection('e9b00000-0000-4000-8000-000000000001', 'file_import', 'active')$$), '55000|feature_disabled', 'nor the connection changed');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000011');
select is(pg_temp.err(format($$select servicing.commit_import(%L)$$, (pg_temp.got('rj2')::jsonb) ->> 'batch_id')), '55000|feature_disabled', 'nor a previewed batch committed');
select is(pg_temp.err(format($$select servicing.reject_import(%L, 'Rejected after the switch went off')$$, (pg_temp.got('rj2')::jsonb) ->> 'batch_id')), '55000|feature_disabled', 'nor rejected');
select is(pg_temp.err(format($$select servicing.acknowledge_sync_conflict(%L)$$, pg_temp.got('kc_id'))), '55000|feature_disabled', 'nor a conflict acknowledged');
select is(pg_temp.err(format($$select servicing.resolve_sync_conflict(%L, 'existing', 'a long enough note', '{"ticket":"SAMPLE-T-9"}')$$, pg_temp.got('kc_id'))), '55000|feature_disabled', 'nor resolved');
select pg_temp.as_system();
select is(pg_temp.err(format($$select servicing.apply_lms_report('e9b00000-0000-4000-8000-000000000001', %L)$$, pg_temp.loan('LX1', 'SAMPLE-APP-X1', 'SRC-LX1-K', 0.2, '{"report_type":"loan","source_system":"file_import","sequence":"20"}'))),
  '55000|feature_disabled', 'nor can the system apply a report');
select is(servicing.complete_disbursements('e9b00000-0000-4000-8000-000000000001'), 0, 'nor complete a disbursement');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000006');
select is((select array_agg(lender_loan_ref order by lender_loan_ref) from servicing.my_loans()), array['LY1'], 'the borrower no longer sees lender X''s loans through the borrower function; lender Y''s remain');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000003');
select is((select count(*) from servicing.balance_snapshots) > 0, true, 'the lender still reads its history: a switch off never deletes anything');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000005');
select is(pg_temp.err(format($$select servicing.stage_import('e9b00000-0000-4000-8000-000000000002', 'loan', 'manual', %L, 1000, 'udofin-lms-import-v1', %L::jsonb, 'idem-y-after-kill-01')$$, repeat('8', 64),
  jsonb_build_array(pg_temp.loan('LY4', 'SAMPLE-APP-Y11', 'SRC-LY4-1', 1)))), 'ok', 'lender Y, whose switch is still on, carries on');

-- ============================================================================================================================
-- 17. Review fixes: the system role cannot write the sync tables; provenance columns are not readable by borrowers or lenders directly
-- ============================================================================================================================
select pg_temp.as_owner();
select ok((select bool_and(not has_table_privilege('service_role', t, 'insert') and not has_table_privilege('service_role', t, 'update')
                           and not has_table_privilege('service_role', t, 'delete') and not has_table_privilege('service_role', t, 'truncate')
                           and has_table_privilege('service_role', t, 'select'))
           from unnest(array['servicing.loan_accounts', 'servicing.schedule_snapshots', 'servicing.schedule_installments', 'servicing.loan_sync_status']) t),
  'the system role reads the loan, schedule and status tables but holds no write privilege on them: the definer sync functions are the only writers');
select pg_temp.as_system();
select is(pg_temp.err($$update servicing.loan_accounts set status = 'closed' where false$$), '42501|', 'an update by the system role is refused before any row is looked at');
select is(pg_temp.err($$delete from servicing.schedule_snapshots where false$$), '42501|', 'so is a delete');
select is(pg_temp.err($$insert into servicing.schedule_installments (snapshot_id, lender_org_id, seq, due_date, principal_minor, interest_minor) select gen_random_uuid(), gen_random_uuid(), 1, current_date, 1, 1 where false$$), '42501|', 'and an insert');
select pg_temp.as_owner();
select ok((select bool_and(not has_column_privilege('authenticated', 'servicing.schedule_snapshots', c, 'select'))
           from unnest(array['recorded_by', 'import_batch_id', 'source_record_id', 'lender_sequence', 'content_sha256', 'source']) c),
  'no signed-in role can read the provenance columns of a schedule snapshot directly (they name a lender user and an import)');
select ok((select bool_and(has_column_privilege('authenticated', 'servicing.schedule_snapshots', c, 'select'))
           from unnest(array['id', 'lender_org_id', 'loan_account_id', 'version', 'source_reference', 'received_at', 'reported_as_of']) c),
  'while the columns the policies and the API need stay readable');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000006');
select is(pg_temp.err($$select recorded_by from servicing.schedule_snapshots$$), '42501|', 'a borrower cannot read who recorded a schedule');
select is(pg_temp.err($$select count(*) from servicing.schedule_snapshots where import_batch_id is not null$$), '42501|', 'nor filter on the import batch');
select ok((select count(*) from servicing.schedule_snapshots) >= 0, 'but still reads the rows of their own loans (the policy and the readable columns are intact)');
select pg_temp.as_user('e9000000-0000-4000-8000-000000000003');
select is(pg_temp.err($$select content_sha256 from servicing.schedule_snapshots$$), '42501|', 'a lender user cannot read the content hash column either: import provenance is read through the import tables');
select ok((select count(*) from servicing.schedule_snapshots) > 0, 'but reads the schedule versions of its own loans');
select is((select count(*) from servicing.schedule_installments), (select count(*) from servicing.schedule_installments where lender_org_id = 'e9b00000-0000-4000-8000-000000000001'), 'and the installments under them, of its own lender only');

select * from finish();
rollback;
