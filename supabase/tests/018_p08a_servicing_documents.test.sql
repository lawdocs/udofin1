-- Phase 08a lender-issued documents, foreclosure quotes and closure (migration 20261018000912).
-- Requests, lender-issued document registry and access log, quotes (flagged, never corrected), closure records opened by a trigger,
-- security-release tasks and the lien prompt, rule-driven due dates, the statements_noc switch, tenant and borrower isolation.
-- Synthetic data only (SAMPLE). Error codes are reported as SQLSTATE|hint.
begin;
create extension if not exists pgtap with schema extensions;
select plan(302);

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
  -- The Supabase image adds 'Grant the required privileges ...' to privilege errors; our own hints are kept.
  if v_hint like 'Grant the required privileges%' then v_hint := null; end if;
  return v_state || '|' || coalesce(v_hint, '');
end
$fn$;
-- SQLSTATE only (for errors raised by table privileges or by checks whose hint text is not part of the contract).
create function pg_temp.st(q text) returns text language sql as $fn$ select left(pg_temp.err(q), 5) $fn$;
create function pg_temp.keep(k text, v text) returns text language sql as $fn$ select set_config('t.' || k, v, true) $fn$;
create function pg_temp.got(k text) returns text language sql as $fn$ select current_setting('t.' || k) $fn$;
create function pg_temp.sk(label text) returns text language sql as $fn$ select 'servicing/test/' || md5(label) || '/doc' $fn$;
create function pg_temp.sha(label text) returns text language sql as $fn$ select encode(sha256(convert_to('sample-doc-' || label, 'UTF8')), 'hex') $fn$;
-- Loan account id by the lender's loan reference.
create function pg_temp.lid(ref text) returns uuid language sql security definer as $fn$ select id from servicing.loan_accounts where lms_loan_ref = ref $fn$;
-- Runs a query as the table owner (the test session's login) and returns its first column as text: for assertions about table state made while
-- the session is acting as a borrower or another restricted role.
create function pg_temp.q(sql text) returns text language plpgsql security definer as $fn$
declare v text;
begin
  execute sql into v;
  return v;
end
$fn$;
-- Registers a SAMPLE lender-issued PDF record for a loan (the bytes are not stored in these tests).
create function pg_temp.reg(p_loan uuid, p_kind text, p_label text, p_from date default null, p_to date default null, p_supersedes uuid default null,
                            p_request uuid default null, p_source text default 'lender_upload') returns uuid language sql as $fn$
  select servicing.register_loan_document(p_loan, p_kind, pg_temp.sk(p_label), pg_temp.sha(p_label), 12345, 'application/pdf', 'SAMPLE-REF-' || p_label,
                                          clock_timestamp() - interval '1 minute', p_from, p_to, p_supersedes, p_request, p_source)
$fn$;
-- Records a SAMPLE quotation (parts 10000.00 + 500.00 + 100.00 + 200.00 = 10800.00 unless changed).
create function pg_temp.quote(p_loan uuid, p_ref text, p_valid_hours numeric default 24, p_p text default '10000.00', p_i text default '500.00',
                              p_c text default '100.00', p_pp text default '200.00', p_t text default '10800.00', p_req uuid default null,
                              p_source text default 'lender_portal', p_letter uuid default null) returns uuid language sql as $fn$
  select servicing.record_foreclosure_quote(p_loan, p_ref, clock_timestamp() - interval '1 hour', clock_timestamp() + make_interval(secs => (p_valid_hours * 3600)::integer),
                                            p_p, p_i, p_c, p_pp, p_t, p_source, p_req, p_letter)
$fn$;
grant execute on all functions in schema pg_temp to public;

-- Fixture -------------------------------------------------------------------------------------------------------------
-- u01 platform admin, u02 X servicing operator, u03 X viewer (loan.read only), u04 Y servicing operator, u05 borrower b1,
-- u06 borrower b2, u07 Z servicing operator (switch off), u08 platform auditor, u09/u10 rule proposer and approver (not members),
-- u11/u12 feature requester and decider (not members), u13 X second operator
insert into auth.users (id, phone, raw_app_meta_data)
select ('ea000000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
       case n when 5 then '910000000081' when 6 then '910000000082' end,
       case when n in (5, 6) then '{}'::jsonb else '{"actor_type":"staff"}'::jsonb end
from generate_series(1, 13) n;

select pg_temp.as_owner();
insert into tenancy.organizations (id, kind, legal_name, display_name, regulator_registration_no, status) values
  ('eaa00000-0000-4000-8000-000000000000', 'platform', 'Udofin Platform (test)', 'Udofin', null, 'active'),
  ('eab00000-0000-4000-8000-000000000001', 'lender', 'Docs X Finance (test)', 'Docs X', 'TEST-EA-0001', 'active'),
  ('eab00000-0000-4000-8000-000000000002', 'lender', 'Docs Y Finance (test)', 'Docs Y', 'TEST-EA-0002', 'active'),
  ('eab00000-0000-4000-8000-000000000003', 'lender', 'Docs Z Finance (test)', 'Docs Z', 'TEST-EA-0003', 'active');
insert into onboarding.lender_gates (lender_org_id, stage) values
  ('eab00000-0000-4000-8000-000000000001', 'activated'), ('eab00000-0000-4000-8000-000000000002', 'activated'), ('eab00000-0000-4000-8000-000000000003', 'activated');
insert into onboarding.lender_profiles (lender_org_id, category_key, regulator, created_by) values
  ('eab00000-0000-4000-8000-000000000001', 'nbfc_icc', 'Reserve Bank of India', 'ea000000-0000-4000-8000-000000000009'),
  ('eab00000-0000-4000-8000-000000000002', 'nbfc_icc', 'Reserve Bank of India', 'ea000000-0000-4000-8000-000000000009'),
  ('eab00000-0000-4000-8000-000000000003', 'nbfc_icc', 'Reserve Bank of India', 'ea000000-0000-4000-8000-000000000009');
insert into tenancy.memberships (id, org_id, user_id, status) values
  ('eac10000-0000-4000-8000-000000000001', 'eaa00000-0000-4000-8000-000000000000', 'ea000000-0000-4000-8000-000000000001', 'active'),
  ('eac10000-0000-4000-8000-000000000002', 'eab00000-0000-4000-8000-000000000001', 'ea000000-0000-4000-8000-000000000002', 'active'),
  ('eac10000-0000-4000-8000-000000000003', 'eab00000-0000-4000-8000-000000000001', 'ea000000-0000-4000-8000-000000000003', 'active'),
  ('eac10000-0000-4000-8000-000000000004', 'eab00000-0000-4000-8000-000000000002', 'ea000000-0000-4000-8000-000000000004', 'active'),
  ('eac10000-0000-4000-8000-000000000007', 'eab00000-0000-4000-8000-000000000003', 'ea000000-0000-4000-8000-000000000007', 'active'),
  ('eac10000-0000-4000-8000-000000000008', 'eaa00000-0000-4000-8000-000000000000', 'ea000000-0000-4000-8000-000000000008', 'active'),
  ('eac10000-0000-4000-8000-000000000013', 'eab00000-0000-4000-8000-000000000001', 'ea000000-0000-4000-8000-000000000013', 'active'),
  ('eac10000-0000-4000-8000-000000000019', 'eab00000-0000-4000-8000-000000000001', 'ea000000-0000-4000-8000-000000000009', 'active'),
  ('eac10000-0000-4000-8000-000000000020', 'eab00000-0000-4000-8000-000000000002', 'ea000000-0000-4000-8000-000000000009', 'active'),
  ('eac10000-0000-4000-8000-000000000021', 'eab00000-0000-4000-8000-000000000003', 'ea000000-0000-4000-8000-000000000009', 'active'),
  ('eac10000-0000-4000-8000-000000000022', 'eab00000-0000-4000-8000-000000000001', 'ea000000-0000-4000-8000-000000000010', 'active'),
  ('eac10000-0000-4000-8000-000000000023', 'eab00000-0000-4000-8000-000000000002', 'ea000000-0000-4000-8000-000000000010', 'active'),
  ('eac10000-0000-4000-8000-000000000024', 'eab00000-0000-4000-8000-000000000003', 'ea000000-0000-4000-8000-000000000010', 'active');
insert into tenancy.membership_roles (membership_id, role_id)
select m.mid::uuid, r.id from (values
  ('eac10000-0000-4000-8000-000000000001', 'platform', 'platform_admin'),
  ('eac10000-0000-4000-8000-000000000002', 'lender', 'servicing_operator'),
  ('eac10000-0000-4000-8000-000000000003', 'lender', 'viewer'),
  ('eac10000-0000-4000-8000-000000000004', 'lender', 'servicing_operator'),
  ('eac10000-0000-4000-8000-000000000007', 'lender', 'servicing_operator'),
  ('eac10000-0000-4000-8000-000000000008', 'platform', 'auditor'),
  ('eac10000-0000-4000-8000-000000000013', 'lender', 'servicing_operator'),
  ('eac10000-0000-4000-8000-000000000019', 'lender', 'lender_admin'),
  ('eac10000-0000-4000-8000-000000000020', 'lender', 'lender_admin'),
  ('eac10000-0000-4000-8000-000000000021', 'lender', 'lender_admin'),
  ('eac10000-0000-4000-8000-000000000022', 'lender', 'product_approver'),
  ('eac10000-0000-4000-8000-000000000023', 'lender', 'product_approver'),
  ('eac10000-0000-4000-8000-000000000024', 'lender', 'product_approver')
) as m (mid, kind, rkey)
join tenancy.roles r on r.org_id is null and r.applies_to = m.kind::tenancy.organization_kind and r.key = m.rkey;

-- The statements_noc switch for X and Y (an applied two-person request and the switch in ONE transaction). Z stays off.
insert into servicing.feature_change_requests (id, lender_org_id, feature, enable, mode, status, evidence, requested_by, idempotency_key, decided_by, decided_at, applied_at)
values ('eae00000-0000-4000-8000-000000000001', 'eab00000-0000-4000-8000-000000000001', 'statements_noc', true, 'two_person', 'applied', '{"contract_ref":"SAMPLE-EA-1"}',
        'ea000000-0000-4000-8000-000000000011', 'ea-req-key-00000001', 'ea000000-0000-4000-8000-000000000012', now(), now()),
       ('eae00000-0000-4000-8000-000000000002', 'eab00000-0000-4000-8000-000000000002', 'statements_noc', true, 'two_person', 'applied', '{"contract_ref":"SAMPLE-EA-2"}',
        'ea000000-0000-4000-8000-000000000011', 'ea-req-key-00000002', 'ea000000-0000-4000-8000-000000000012', now(), now());
insert into servicing.lender_features (lender_org_id, feature, enabled, evidence, enabled_by, enabled_at, last_change_request_id) values
  ('eab00000-0000-4000-8000-000000000001', 'statements_noc', true, '{"contract_ref":"SAMPLE-EA-1"}', 'ea000000-0000-4000-8000-000000000012', now(), 'eae00000-0000-4000-8000-000000000001'),
  ('eab00000-0000-4000-8000-000000000002', 'statements_noc', true, '{"contract_ref":"SAMPLE-EA-2"}', 'ea000000-0000-4000-8000-000000000012', now(), 'eae00000-0000-4000-8000-000000000002');

-- Products, requests, applications and loans. Applications: 1 X/b1, 2 X/b2, 3 Y/b1, 4 X/b1 (the test-only fixture whose lender reports a mutual_fund_lien
-- collateral type: the platform refuses a loan_against_securities request, so no real secured product exists), 5 X/b1, 6 Z/b1, 7 X/b1, 8 X/b1.
insert into lending.loan_products (id, lender_org_id, category_key, code, name, status) values
  ('ea900000-0000-4000-8000-000000000001', 'eab00000-0000-4000-8000-000000000001', 'personal', 'PL-EA', 'X Personal Loan', 'active'),
  ('ea900000-0000-4000-8000-000000000002', 'eab00000-0000-4000-8000-000000000002', 'personal', 'PL-EA', 'Y Personal Loan', 'active'),
  ('ea900000-0000-4000-8000-000000000003', 'eab00000-0000-4000-8000-000000000003', 'personal', 'PL-EA', 'Z Personal Loan', 'active');
insert into lending.loan_product_versions (id, product_id, lender_org_id, version, status, min_amount_minor, max_amount_minor,
  min_tenure_days, max_tenure_days, rate_type, min_annual_rate_bps, max_annual_rate_bps, drafted_by, approved_by, approved_at, effective_from)
select ('ea910000-0000-4000-8000-00000000000' || n)::uuid, ('ea900000-0000-4000-8000-00000000000' || n)::uuid, ('eab00000-0000-4000-8000-00000000000' || n)::uuid, 1, 'approved',
       1000000, 50000000, 180, 1825, 'fixed', 1400, 2400, 'ea000000-0000-4000-8000-000000000009', 'ea000000-0000-4000-8000-000000000010', now(), now()
from generate_series(1, 3) n;
insert into lending.loan_requests (id, borrower_id, category_key, requested_amount_minor, requested_tenure_days, purpose_code, status)
select ('ea700000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
       (select id from identity.borrowers where user_id = (case when n = 2 then 'ea000000-0000-4000-8000-000000000006' else 'ea000000-0000-4000-8000-000000000005' end)::uuid),
       'personal', 5000000, 365, 'education', 'submitted'
from generate_series(1, 8) n;
insert into lending.applications (id, lender_org_id, loan_request_id, borrower_id, product_version_id, status, requested_amount_minor, requested_tenure_days, lender_reference)
select ('ea200000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
       ('eab00000-0000-4000-8000-00000000000' || case n when 3 then 2 when 6 then 3 else 1 end)::uuid,
       ('ea700000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
       (select id from identity.borrowers where user_id = (case when n = 2 then 'ea000000-0000-4000-8000-000000000006' else 'ea000000-0000-4000-8000-000000000005' end)::uuid),
       ('ea910000-0000-4000-8000-00000000000' || case n when 3 then 2 when 6 then 3 else 1 end)::uuid,
       'disbursement_pending', 5000000, 365, 'SAMPLE-APP-' || n
from generate_series(1, 8) n;
-- Loans 1 to 4, 6 and 7 start active; loan 5 and 8 are inserted later (closed straight away).
insert into servicing.loan_accounts (lender_org_id, application_id, borrower_id, source_system, lms_loan_ref, sanctioned_amount_minor)
select a.lender_org_id, a.id, a.borrower_id, 'lender_lms', 'SAMPLE-LN-' || right(a.id::text, 2)::int, 5000000
from lending.applications a where right(a.id::text, 2)::int in (1, 2, 3, 4, 6, 7);

select pg_temp.keep('b1', (select id::text from identity.borrowers where user_id = 'ea000000-0000-4000-8000-000000000005'));
select pg_temp.keep('b2', (select id::text from identity.borrowers where user_id = 'ea000000-0000-4000-8000-000000000006'));
select pg_temp.keep('ruleX', (select string_agg(rule_key || '=' || id::text, ',') from documents.applicability_rules where rule_key like 'servicing.%'));

-- ============================================================================================================================
-- 1. Structure, grants, seeds
-- ============================================================================================================================
select is((select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'servicing' and c.relname in ('loan_documents', 'loan_document_access', 'foreclosure_quotes', 'document_requests', 'closure_records', 'security_release_tasks')
             and c.relrowsecurity and c.relforcerowsecurity), 6::bigint, 'row level security is enabled and forced on the six new tables');
select is((select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'servicing' and c.relname in ('loan_documents', 'loan_document_access', 'foreclosure_quotes', 'document_requests', 'closure_records', 'security_release_tasks')
             and obj_description(c.oid, 'pg_class') like '%Owner: servicing module.'), 6::bigint, 'each table has a comment that names its owner module');
select is((select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'servicing' and c.relname in ('loan_documents', 'loan_document_access', 'foreclosure_quotes', 'document_requests', 'closure_records', 'security_release_tasks')
             and t.tgname = 'no_truncate' and not t.tgisinternal), 6::bigint, 'a no_truncate trigger is on each table');
select is((select string_agg(t || '=' || pg_temp.err(format('truncate servicing.%I cascade', t)), ',' order by t)
           from unnest(array['closure_records', 'document_requests', 'foreclosure_quotes', 'loan_document_access', 'loan_documents', 'security_release_tasks']) t),
  'closure_records=P0001|,document_requests=P0001|,foreclosure_quotes=P0001|,loan_document_access=P0001|,loan_documents=P0001|,security_release_tasks=P0001|',
  'TRUNCATE is refused even for the owner on every table');
select is((select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'servicing' and c.relname in ('loan_documents', 'loan_document_access', 'foreclosure_quotes') and t.tgname = 'append_only' and not t.tgisinternal),
  3::bigint, 'the document registry, its access log and the quotes are append-only');
select ok((select bool_and(i.found) from (values
    (exists (select 1 from pg_indexes where schemaname = 'servicing' and indexname = 'loan_documents_loan')),
    (exists (select 1 from pg_indexes where schemaname = 'servicing' and indexname = 'loan_documents_supersedes')),
    (exists (select 1 from pg_indexes where schemaname = 'servicing' and indexname = 'loan_document_access_document')),
    (exists (select 1 from pg_indexes where schemaname = 'servicing' and indexname = 'foreclosure_quotes_loan')),
    (exists (select 1 from pg_indexes where schemaname = 'servicing' and indexname = 'foreclosure_quotes_letter')),
    (exists (select 1 from pg_indexes where schemaname = 'servicing' and indexname = 'document_requests_loan')),
    (exists (select 1 from pg_indexes where schemaname = 'servicing' and indexname = 'document_requests_due_rule')),
    (exists (select 1 from pg_indexes where schemaname = 'servicing' and indexname = 'document_requests_document')),
    (exists (select 1 from pg_indexes where schemaname = 'servicing' and indexname = 'document_requests_quote')),
    (exists (select 1 from pg_indexes where schemaname = 'servicing' and indexname = 'closure_records_due_rule')),
    (exists (select 1 from pg_indexes where schemaname = 'servicing' and indexname = 'closure_records_noc_document')),
    (exists (select 1 from pg_indexes where schemaname = 'servicing' and indexname = 'security_release_tasks_closure')),
    (exists (select 1 from pg_indexes where schemaname = 'servicing' and indexname = 'security_release_tasks_due_rule'))) as i (found)),
  'every foreign key of the new tables has its index');
select ok((select bool_and(has_table_privilege('authenticated', t, 'select') and not has_table_privilege('authenticated', t, 'insert')
                           and not has_table_privilege('authenticated', t, 'update') and not has_table_privilege('authenticated', t, 'delete')
                           and not has_table_privilege('authenticated', t, 'truncate'))
           from unnest(array['servicing.loan_document_access', 'servicing.foreclosure_quotes', 'servicing.document_requests', 'servicing.closure_records',
                             'servicing.security_release_tasks']) t),
  'authenticated users can only read the tables (no write privilege at all)');
select ok((select bool_and(has_table_privilege('service_role', t, 'select') and not has_table_privilege('service_role', t, 'insert')
                           and not has_table_privilege('service_role', t, 'update') and not has_table_privilege('service_role', t, 'delete')
                           and not has_table_privilege('service_role', t, 'truncate'))
           from unnest(array['servicing.loan_document_access', 'servicing.foreclosure_quotes', 'servicing.document_requests', 'servicing.closure_records',
                             'servicing.security_release_tasks']) t),
  'the system role can only read them: it can never forge a quote, a document access, a request outcome or a release confirmation');
select ok(not has_table_privilege('authenticated', 'servicing.loan_documents', 'select') and has_column_privilege('authenticated', 'servicing.loan_documents', 'sha256', 'select')
          and not has_column_privilege('authenticated', 'servicing.loan_documents', 'storage_key', 'select')
          and not has_column_privilege('service_role', 'servicing.loan_documents', 'storage_key', 'select')
          and not has_table_privilege('authenticated', 'servicing.loan_documents', 'insert') and not has_table_privilege('service_role', 'servicing.loan_documents', 'insert')
          and not has_table_privilege('authenticated', 'servicing.loan_documents', 'update') and not has_table_privilege('service_role', 'servicing.loan_documents', 'update'),
  'the storage key of a document can be selected by no role (only the open functions return it) and nobody can write the registry directly');
select ok((select bool_and(not has_table_privilege('anon', t, 'select') and not has_table_privilege('anon', t, 'insert'))
           from unnest(array['servicing.loan_documents', 'servicing.loan_document_access', 'servicing.foreclosure_quotes', 'servicing.document_requests',
                             'servicing.closure_records', 'servicing.security_release_tasks']) t), 'anon has no privilege on any of them');
select is((select array_agg(c.table_name || '.' || c.column_name order by c.table_name, c.column_name)
           from information_schema.columns c
           where c.table_schema = 'servicing'
             and c.table_name in ('loan_documents', 'loan_document_access', 'foreclosure_quotes', 'document_requests', 'closure_records', 'security_release_tasks')
             and c.column_name ~ '(phone|mobile|pan|aadhaar|aadhar|name|email|address|birth|dob|passport|ifsc|account_no|account_number|otp|biometric)'),
  null, 'no column is shaped like personal data (no phone, PAN, Aadhaar, name, e-mail, address, account number or OTP)');
select is((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname in ('servicing', 'documents', 'private') and p.proname ~* '(generate|render|compose|draft)_(statement|quote|quotation|noc|closure|letter)'), 0::bigint,
  'no function generates or renders a statement, quotation, NOC or closure letter: Udofin issues none of them');
select is((select array_agg(rule_key || ':' || approval_status || ':' || evidence_status order by rule_key) from documents.applicability_rules where rule_key like 'servicing.%'),
  array['servicing.noc_sla_days_default:draft:unverified', 'servicing.security_release_sla_days:draft:confirmed', 'servicing.statement_sla_days_default:draft:unverified'],
  'the three servicing rules are seeded as draft with their evidence label (NOC and statement defaults unverified platform settings; security release confirmed in text)');
select is((select paragraph_refs from documents.applicability_rules where rule_key = 'servicing.security_release_sla_days'), array['35', '36'], 'the security-release rule cites RBC paras 35 and 36');
select ok((select direction_ref like '%NOT a regulatory deadline%' and exclusions like '%PLATFORM SETTING, NOT A REGULATORY CLAIM%' from documents.applicability_rules where rule_key = 'servicing.noc_sla_days_default'),
  'the NOC default says in its citation that it is a platform setting and not a regulatory deadline');
select is((select array_agg(rule_key || '=' || (validity_rule ->> 'days') order by rule_key) from documents.applicability_rules where rule_key like 'servicing.%'),
  array['servicing.noc_sla_days_default=30', 'servicing.security_release_sla_days=30', 'servicing.statement_sla_days_default=7'], 'the periods are data in the rules, not code');
select is((select array_agg(key order by key) from documents.document_types where data_source = 'lender_issued' and issuing_authority = 'lender'),
  array['noc', 'security_release', 'statement_of_account'], 'the lender-issued document types exist with the lender as the only issuing authority');
select is((select availability from lending.product_categories where key = 'loan_against_securities'), 'feasibility_review',
  'no LAMF product is enabled: loan_against_securities stays in feasibility review, so the lien prompt is exercised with a test-only fixture');
select ok((select bool_and(not has_function_privilege('anon', f, 'execute') and not has_function_privilege('public', f, 'execute'))
           from unnest(array[
             'servicing.request_document(uuid, text, text, date, date)', 'servicing.cancel_document_request(uuid)', 'servicing.my_document_requests(uuid)',
             'servicing.my_loan_documents(uuid)', 'servicing.open_loan_document(uuid, text)', 'servicing.my_closure(uuid)',
             'servicing.decline_document_request(uuid, text)', 'servicing.lender_loan_documents(uuid)', 'servicing.lender_open_loan_document(uuid, text)',
             'servicing.confirm_security_release(uuid, text)', 'servicing.set_security_release_delay_reason(uuid, text)',
             'servicing.register_loan_document(uuid, text, text, text, bigint, text, text, timestamptz, date, date, uuid, uuid, text)',
             'servicing.record_foreclosure_quote(uuid, text, timestamptz, timestamptz, text, text, text, text, text, text, uuid, uuid)',
             'servicing.open_security_release_tasks(uuid, text[])', 'servicing.latest_valid_quote(uuid)', 'servicing.expire_document_requests(timestamptz)']) f),
  'neither anon nor PUBLIC can execute any of the sixteen functions');
select ok(has_function_privilege('service_role', 'servicing.expire_document_requests(timestamptz)', 'execute')
          and not has_function_privilege('authenticated', 'servicing.expire_document_requests(timestamptz)', 'execute')
          and has_function_privilege('service_role', 'servicing.latest_valid_quote(uuid)', 'execute')
          and has_function_privilege('authenticated', 'servicing.latest_valid_quote(uuid)', 'execute')
          and not has_function_privilege('service_role', 'servicing.confirm_security_release(uuid, text)', 'execute')
          and not has_function_privilege('service_role', 'servicing.request_document(uuid, text, text, date, date)', 'execute'),
  'the expiry job is system-only, the quote lookup is open to both, and the system role can neither confirm a release nor file a borrower request');

-- ============================================================================================================================
-- 2. The statements_noc switch is OFF for lender Z: everything refuses or hides (the closure fact is still recorded)
-- ============================================================================================================================
select pg_temp.as_system();
select pg_temp.as_owner();
update servicing.loan_accounts set status = 'closed' where lms_loan_ref = 'SAMPLE-LN-6';
select pg_temp.as_system();
select pg_temp.as_owner();
select is((select count(*) from servicing.closure_records where loan_account_id = pg_temp.lid('SAMPLE-LN-6')), 1::bigint,
  'a closure record opens even when the lender''s statements_noc switch is off (reminders and mandates must stop regardless)');
insert into servicing.document_requests (lender_org_id, loan_account_id, kind, requested_by, idempotency_key)
values ('eab00000-0000-4000-8000-000000000003', pg_temp.lid('SAMPLE-LN-6'), 'noc', 'ea000000-0000-4000-8000-000000000005', 'z-off-key-00000001');
insert into servicing.loan_documents (lender_org_id, loan_account_id, kind, lender_reference, issued_at, storage_key, sha256, size_bytes, source, uploaded_by)
values ('eab00000-0000-4000-8000-000000000003', pg_temp.lid('SAMPLE-LN-6'), 'noc', 'SAMPLE-Z-NOC', now() - interval '1 day', pg_temp.sk('z-noc'), pg_temp.sha('z-noc'), 1000, 'lender_upload',
        'ea000000-0000-4000-8000-000000000007');
insert into servicing.foreclosure_quotes (lender_org_id, loan_account_id, lender_quote_ref, as_of, valid_until, principal_minor, interest_minor, charges_minor, prepayment_charge_minor, total_minor, source, reported_by)
values ('eab00000-0000-4000-8000-000000000003', pg_temp.lid('SAMPLE-LN-6'), 'SAMPLE-Z-Q', now() - interval '1 hour', now() + interval '1 day', 100, 0, 0, 0, 100, 'lender_portal',
        'ea000000-0000-4000-8000-000000000007');
insert into servicing.security_release_tasks (lender_org_id, loan_account_id, closure_id, collateral_type)
values ('eab00000-0000-4000-8000-000000000003', pg_temp.lid('SAMPLE-LN-6'), (select id from servicing.closure_records where loan_account_id = pg_temp.lid('SAMPLE-LN-6')), 'mutual_fund_lien');
select pg_temp.keep('z_doc', (select id::text from servicing.loan_documents where lender_reference = 'SAMPLE-Z-NOC'));
select pg_temp.keep('z_req', (select id::text from servicing.document_requests where idempotency_key = 'z-off-key-00000001'));
select pg_temp.keep('z_task', (select id::text from servicing.security_release_tasks where lender_org_id = 'eab00000-0000-4000-8000-000000000003'));

select pg_temp.as_user('ea000000-0000-4000-8000-000000000005');
select is(pg_temp.err(format($$select servicing.request_document(%L, 'statement', 'z-off-key-00000002')$$, pg_temp.lid('SAMPLE-LN-6'))), '55000|feature_disabled', 'a borrower request is refused while the switch is off');
select is(pg_temp.err(format($$select servicing.cancel_document_request(%L)$$, pg_temp.got('z_req'))), '55000|feature_disabled', 'cancelling is refused too');
select is(pg_temp.err(format($$select servicing.open_loan_document(%L)$$, pg_temp.got('z_doc'))), '55000|feature_disabled', 'opening a document is refused');
select is(pg_temp.err(format($$select servicing.my_closure(%L)$$, pg_temp.lid('SAMPLE-LN-6'))), '55000|feature_disabled', 'the closure screen is hidden');
select is((select count(*) from servicing.my_loan_documents(pg_temp.lid('SAMPLE-LN-6'))), 0::bigint, 'the document list is empty');
select is((select count(*) from servicing.my_document_requests(pg_temp.lid('SAMPLE-LN-6'))), 0::bigint, 'the request list is empty');
select is((select count(*) from servicing.latest_valid_quote(pg_temp.lid('SAMPLE-LN-6'))), 0::bigint, 'a stored unexpired quotation is not offered while the switch is off');
select pg_temp.as_system();
select is((select count(*) from servicing.latest_valid_quote(pg_temp.lid('SAMPLE-LN-6'))), 0::bigint, 'nor to the system (a foreclosure payment cannot match it)');
select pg_temp.as_user('ea000000-0000-4000-8000-000000000007');
select is(pg_temp.err(format($$select pg_temp.reg(%L, 'noc', 'z-new')$$, pg_temp.lid('SAMPLE-LN-6'))), '55000|feature_disabled', 'a lender with the permission cannot register a document while the switch is off');
select is(pg_temp.err(format($$select pg_temp.quote(%L, 'SAMPLE-Z-Q2')$$, pg_temp.lid('SAMPLE-LN-6'))), '55000|feature_disabled', 'nor record a quotation');
select is(pg_temp.err(format($$select servicing.decline_document_request(%L, 'Cannot be issued for now')$$, pg_temp.got('z_req'))), '55000|feature_disabled', 'nor decline a request');
select is(pg_temp.err(format($$select servicing.open_security_release_tasks(%L, array['other'])$$, pg_temp.lid('SAMPLE-LN-6'))), '55000|feature_disabled', 'nor open release tasks');
select is(pg_temp.err(format($$select servicing.confirm_security_release(%L, 'SAMPLE-CONF-1')$$, pg_temp.got('z_task'))), '55000|feature_disabled', 'nor confirm a release');
select is(pg_temp.err(format($$select servicing.set_security_release_delay_reason(%L, 'Waiting for the depository to act')$$, pg_temp.got('z_task'))), '55000|feature_disabled', 'nor record a delay reason');
select is(pg_temp.err(format($$select servicing.lender_open_loan_document(%L)$$, pg_temp.got('z_doc'))), '55000|feature_disabled', 'nor open a document');
select pg_temp.as_system();
select is(pg_temp.err(format($$select pg_temp.reg(%L, 'noc', 'z-new2', null, null, null, null, 'lms')$$, pg_temp.lid('SAMPLE-LN-6'))), '55000|feature_disabled', 'the system role is refused too');
select is(pg_temp.err(format($$select servicing.open_security_release_tasks(%L, array['other'])$$, pg_temp.lid('SAMPLE-LN-6'))), '55000|feature_disabled', 'the system cannot open tasks for a lender whose switch is off');

-- ============================================================================================================================
-- 3. Document requests (lender X)
-- ============================================================================================================================
select pg_temp.as_user('ea000000-0000-4000-8000-000000000005');
select pg_temp.keep('r1', servicing.request_document(pg_temp.lid('SAMPLE-LN-1'), 'statement', 'sample-key-0001')::text);
select is(pg_temp.q(format($$select (due_by is null and due_rule_id is null)::text || ':' || status from servicing.document_requests where id = %L$$, pg_temp.got('r1'))), 'true:requested',
  'with no APPROVED rule the due date is empty (rule unresolved: a draft rule is never used) and the request is still recorded');
select is(servicing.request_document(pg_temp.lid('SAMPLE-LN-1'), 'statement', 'sample-key-0001')::text, pg_temp.got('r1'), 'the same key and the same content return the same request (idempotent)');
select is(pg_temp.err(format($$select servicing.request_document(%L, 'foreclosure_quote', 'sample-key-0001')$$, pg_temp.lid('SAMPLE-LN-1'))), '23505|idempotency_conflict', 'the same key with different content is a conflict');
select is(pg_temp.err(format($$select servicing.request_document(%L, 'statement', 'sample-key-0002')$$, pg_temp.lid('SAMPLE-LN-1'))), '23505|open_request_exists', 'one open request per loan and kind');
select is(pg_temp.err(format($$select servicing.request_document(%L, 'statement', 'short')$$, pg_temp.lid('SAMPLE-LN-1'))), '22023|idempotency_key_invalid', 'a malformed idempotency key is refused');
select is(pg_temp.err(format($$select servicing.request_document(%L, 'balance_sheet', 'sample-key-0003')$$, pg_temp.lid('SAMPLE-LN-1'))), '22023|kind_invalid', 'an unknown kind is refused');
select is(pg_temp.err(format($$select servicing.request_document(%L, 'noc', 'sample-key-0004')$$, pg_temp.lid('SAMPLE-LN-1'))), '55000|loan_not_closed', 'a no-dues letter cannot be requested for a loan the lender reports active');
select is(pg_temp.err(format($$select servicing.request_document(%L, 'foreclosure_quote', 'sample-key-0005', current_date - 3, current_date - 1)$$, pg_temp.lid('SAMPLE-LN-1'))), '22023|period_not_allowed', 'a period applies to statements only');
select is(pg_temp.err(format($$select servicing.request_document(%L, 'statement', 'sample-key-0006', current_date - 1, current_date - 5)$$, pg_temp.lid('SAMPLE-LN-1'))), '22023|period_invalid', 'a statement period must run forward');
select is(pg_temp.err(format($$select servicing.request_document(%L, 'statement', 'sample-key-0007', current_date - 5, current_date + 30)$$, pg_temp.lid('SAMPLE-LN-1'))), '22023|period_invalid', 'a statement period cannot end in the future');
select is(pg_temp.err(format($$select servicing.request_document(%L, 'statement', 'sample-key-0008', current_date - 5)$$, pg_temp.lid('SAMPLE-LN-1'))), '22023|period_invalid', 'a statement period needs both ends');
select is(pg_temp.err(format($$select servicing.request_document(%L, 'statement', 'sample-key-0009')$$, pg_temp.lid('SAMPLE-LN-2'))), 'P0002|', 'a borrower cannot request on another borrower''s loan (not found)');
select is(pg_temp.err(format($$select servicing.request_document(%L, 'statement', 'sample-key-0009')$$, pg_temp.lid('SAMPLE-LN-3'))), 'ok', 'the same borrower can request on their loan at another lender (switch on there too)');
select is((select count(*) from servicing.my_document_requests(pg_temp.lid('SAMPLE-LN-1'))), 1::bigint, 'the borrower lists the request');
select is(pg_temp.err(format($$select servicing.my_document_requests(%L)$$, pg_temp.lid('SAMPLE-LN-2'))), 'P0002|', 'another borrower''s loan has no request list for them');
select is(servicing.cancel_document_request(pg_temp.got('r1')::uuid), 'cancelled', 'the borrower cancels the open request');
select is(pg_temp.err(format($$select servicing.cancel_document_request(%L)$$, pg_temp.got('r1'))), '55000|request_not_open', 'a cancelled request cannot be cancelled again');
select pg_temp.keep('r2', servicing.request_document(pg_temp.lid('SAMPLE-LN-1'), 'statement', 'sample-key-0010')::text);
select isnt(pg_temp.got('r2'), pg_temp.got('r1'), 'after the cancellation a new request of the same kind is possible');
select pg_temp.as_user('ea000000-0000-4000-8000-000000000006');
select is(pg_temp.err(format($$select servicing.cancel_document_request(%L)$$, pg_temp.got('r2'))), 'P0002|', 'another borrower cannot cancel the request (not found)');
select is((select count(*) from servicing.document_requests), 0::bigint, 'and sees no request row at all: borrowers have no table access');
select pg_temp.as_user('ea000000-0000-4000-8000-000000000002');
select is(pg_temp.err(format($$select servicing.request_document(%L, 'statement', 'sample-key-0011')$$, pg_temp.lid('SAMPLE-LN-1'))), 'P0002|', 'a lender user is not a borrower: not found');
select pg_temp.as_anon();
select is(pg_temp.st(format($$select servicing.request_document(%L, 'statement', 'sample-key-0012')$$, pg_temp.lid('SAMPLE-LN-1'))), '42501', 'anon cannot call it');
select pg_temp.as_system();
select is(pg_temp.st(format($$select servicing.request_document(%L, 'statement', 'sample-key-0012')$$, pg_temp.lid('SAMPLE-LN-1'))), '42501', 'the system role cannot file a borrower request');

-- Lender X reads (loan.read) and fulfils/declines.
select pg_temp.as_user('ea000000-0000-4000-8000-000000000003');
select is((select count(*) from servicing.document_requests where lender_org_id = 'eab00000-0000-4000-8000-000000000001'), 2::bigint, 'the lender''s viewer reads the requests of its own loans (one cancelled, one open)');
select is(pg_temp.err(format($$select servicing.decline_document_request(%L, 'We cannot issue this right now')$$, pg_temp.got('r2'))), '42501|', 'a viewer (loan.read, no issue permission) cannot decline');
select pg_temp.as_user('ea000000-0000-4000-8000-000000000002', 'aal1');
select is(pg_temp.err(format($$select servicing.decline_document_request(%L, 'We cannot issue this right now')$$, pg_temp.got('r2'))), '42501|mfa_required', 'the issuing user needs aal2');
select pg_temp.as_user('ea000000-0000-4000-8000-000000000004');
select is(pg_temp.err(format($$select servicing.decline_document_request(%L, 'We cannot issue this right now')$$, pg_temp.got('r2'))), 'P0002|', 'a user of another lender gets not found (no oracle)');
select pg_temp.as_user('ea000000-0000-4000-8000-000000000001');
select is(pg_temp.err(format($$select servicing.decline_document_request(%L, 'We cannot issue this right now')$$, pg_temp.got('r2'))), 'P0002|', 'platform staff cannot decline a lender''s request');
select pg_temp.as_user('ea000000-0000-4000-8000-000000000002');
select is(pg_temp.err(format($$select servicing.decline_document_request(%L, 'short')$$, pg_temp.got('r2'))), '22023|note_invalid', 'a decline needs a reason of 10 or more characters');
select is(pg_temp.err(format($$select servicing.decline_document_request(%L, 'Call the borrower on 9100000081 soon')$$, pg_temp.got('r2'))), '22023|note_invalid', 'a reason with a phone-number-like run of digits is refused');
select is(pg_temp.err(format($$select servicing.decline_document_request(%L, 'Write to someone@example.invalid today')$$, pg_temp.got('r2'))), '22023|note_invalid', 'a reason with an e-mail address is refused');
select is(servicing.decline_document_request(pg_temp.got('r2')::uuid, 'The period requested is not yet closed'), 'declined', 'the issuing user declines with a reason');
select is(pg_temp.err(format($$select servicing.decline_document_request(%L, 'The period requested is not yet closed')$$, pg_temp.got('r2'))), '55000|request_not_open', 'a declined request is final');
select pg_temp.as_owner();
select is(pg_temp.err(format($$update servicing.document_requests set status = 'requested', decided_at = null where id = %L$$, pg_temp.got('r2'))), 'P0001|request_final', 'even the owner cannot reopen a declined request');
select is(pg_temp.err(format($$update servicing.document_requests set kind = 'noc' where id = %L$$, pg_temp.got('r2'))), 'P0001|request_immutable', 'the content of a request never changes');
select is(pg_temp.err(format($$delete from servicing.document_requests where id = %L$$, pg_temp.got('r2'))), 'P0001|Record a compensating entry instead.', 'a request cannot be deleted');
select is((select count(*) from audit.events where action in ('servicing.document_request.created', 'servicing.document_request.cancelled', 'servicing.document_request.declined')
            and entity_id in (pg_temp.got('r1'), pg_temp.got('r2'))), 4::bigint, 'creation, cancellation and decline are audited (two creations, a cancellation and a decline)');
select is((select count(*) from audit.events e where e.entity_id in (pg_temp.got('r1'), pg_temp.got('r2'))
            and exists (select 1 from jsonb_object_keys(e.metadata) k where k not in ('loan_account_id', 'kind', 'due_rule_resolved'))), 0::bigint,
  'the audit metadata carries identifiers and codes only');
select pg_temp.as_user('ea000000-0000-4000-8000-000000000005');
select is((select lender_note || ':' || status from servicing.my_document_requests(pg_temp.lid('SAMPLE-LN-1')) where request_id = pg_temp.got('r2')::uuid), 'The period requested is not yet closed:declined',
  'the borrower sees the lender''s reason and the status');

-- Rules approved (the owner stands in for the two-person Phase 07 flow): the due dates now come from the rules.
select pg_temp.as_owner();
update documents.applicability_rules set approval_status = 'approved', reviewer_ref = 'SAMPLE compliance reviewer', approved_by = 'ea000000-0000-4000-8000-000000000010',
  approved_at = now(), proposed_by = 'ea000000-0000-4000-8000-000000000009'
 where rule_key in ('servicing.statement_sla_days_default', 'servicing.noc_sla_days_default');
select pg_temp.as_user('ea000000-0000-4000-8000-000000000005');
select pg_temp.keep('r3', servicing.request_document(pg_temp.lid('SAMPLE-LN-1'), 'statement', 'sample-key-0020', current_date - 60, current_date - 30)::text);
select is(pg_temp.q(format($$select (due_by - requested_at = interval '7 days')::text from servicing.document_requests where id = %L$$, pg_temp.got('r3'))), 'true',
  'the due date is the request time plus the days of the approved statement rule');
select is(pg_temp.q(format($$select due_rule_id::text from servicing.document_requests where id = %L$$, pg_temp.got('r3'))), pg_temp.q($$select id::text from documents.applicability_rules where rule_key = 'servicing.statement_sla_days_default'$$),
  'and it names the rule it came from');
select is((select due_rule_key || ':' || due_evidence_status from servicing.my_document_requests(pg_temp.lid('SAMPLE-LN-1')) where request_id = pg_temp.got('r3')::uuid), 'servicing.statement_sla_days_default:unverified',
  'the borrower view carries the rule and its evidence label, so the app can say this is a platform default and not a regulatory deadline');
select pg_temp.keep('rq1', servicing.request_document(pg_temp.lid('SAMPLE-LN-1'), 'foreclosure_quote', 'sample-key-0021')::text);
select is(pg_temp.q(format($$select (due_by is null and due_rule_id is null)::text from servicing.document_requests where id = %L$$, pg_temp.got('rq1'))), 'true', 'a quotation request has no SLA rule: its due date stays empty');

-- Fulfilment of the statement request.
select pg_temp.as_user('ea000000-0000-4000-8000-000000000002');
select is(pg_temp.err(format($$select pg_temp.reg(%L, 'statement', 'stmt-narrow', current_date - 40, current_date - 30, null, %L)$$, pg_temp.lid('SAMPLE-LN-1'), pg_temp.got('r3'))), '55000|period_does_not_cover_request',
  'a statement that does not cover the period requested cannot fulfil the request');
select is(pg_temp.err(format($$select pg_temp.reg(%L, 'noc', 'stmt-wrongkind', null, null, null, %L)$$, pg_temp.lid('SAMPLE-LN-1'), pg_temp.got('r3'))), '55000|request_kind_mismatch', 'a document of another kind cannot fulfil it');
select is(pg_temp.err(format($$select pg_temp.reg(%L, 'statement', 'stmt-other-loan', current_date - 60, current_date - 30, null, %L)$$, pg_temp.lid('SAMPLE-LN-2'), pg_temp.got('r3'))), '55000|request_not_open',
  'a request is fulfilled only by a document of the loan it was made on');
select pg_temp.keep('d1', pg_temp.reg(pg_temp.lid('SAMPLE-LN-1'), 'statement', 'stmt-1', current_date - 90, current_date - 30, null, pg_temp.got('r3')::uuid)::text);
select is(pg_temp.q(format($$select status || ':' || (fulfilled_document_id = %L)::text || ':' || (decided_by = 'ea000000-0000-4000-8000-000000000002')::text from servicing.document_requests where id = %L$$, pg_temp.got('d1')::uuid, pg_temp.got('r3'))), 'fulfilled:true:true', 'the request is fulfilled by the document, atomically, by the issuing user');
select is(pg_temp.err(format($$select pg_temp.reg(%L, 'statement', 'stmt-2', current_date - 90, current_date - 30, null, %L)$$, pg_temp.lid('SAMPLE-LN-1'), pg_temp.got('r3'))), '55000|request_not_open', 'a fulfilled request cannot be fulfilled again');
select pg_temp.as_owner();
select is(pg_temp.err(format($$update servicing.document_requests set status = 'cancelled' where id = %L$$, pg_temp.got('r3'))), 'P0001|request_final', 'a fulfilled request is final');

-- Expiry (system only; the cutoff is supplied, no age is hard-coded).
select pg_temp.as_owner();
insert into servicing.document_requests (lender_org_id, loan_account_id, kind, requested_by, requested_at, idempotency_key)
values ('eab00000-0000-4000-8000-000000000001', pg_temp.lid('SAMPLE-LN-2'), 'statement', 'ea000000-0000-4000-8000-000000000006', now() - interval '200 days', 'old-req-key-00000001'),
       ('eab00000-0000-4000-8000-000000000003', pg_temp.lid('SAMPLE-LN-6'), 'statement', 'ea000000-0000-4000-8000-000000000005', now() - interval '200 days', 'old-req-key-00000002');
select pg_temp.as_user('ea000000-0000-4000-8000-000000000002');
select is(pg_temp.err($$select servicing.expire_document_requests(now() - interval '100 days')$$), '42501|', 'a person cannot run the expiry job');
select pg_temp.as_system();
select is(pg_temp.err($$select servicing.expire_document_requests(now() + interval '1 day')$$), '22023|cutoff_invalid', 'the cutoff must be in the past');
select is(servicing.expire_document_requests(now() - interval '100 days'), 1, 'one stale request expires (the one of the lender whose switch is on)');
select is((select string_agg(status, ',' order by status) from servicing.document_requests where idempotency_key like 'old-req-key-%'), 'expired,requested',
  'the stale request of the lender whose switch is off is left as it is');
select is(servicing.expire_document_requests(now() - interval '100 days'), 0, 'running it again expires nothing');

-- ============================================================================================================================
-- 4. The lender-issued document registry
-- ============================================================================================================================
select pg_temp.as_owner();
select is(pg_temp.err(format($$insert into servicing.loan_documents (lender_org_id, loan_account_id, kind, issuer, lender_reference, issued_at, storage_key, sha256, size_bytes, source, uploaded_by)
  values ('eab00000-0000-4000-8000-000000000001', %L, 'noc', 'udofin', 'SAMPLE-ISS-1', now(), %L, %L, 10, 'lender_upload', 'ea000000-0000-4000-8000-000000000002')$$,
  pg_temp.lid('SAMPLE-LN-1'), pg_temp.sk('iss1'), pg_temp.sha('iss1'))), '23514|', 'the owner cannot insert a document whose issuer is Udofin (check constraint)');
select pg_temp.as_system();
select is(pg_temp.st(format($$insert into servicing.loan_documents (lender_org_id, loan_account_id, kind, issuer, lender_reference, issued_at, storage_key, sha256, size_bytes, source)
  values ('eab00000-0000-4000-8000-000000000001', %L, 'noc', 'udofin', 'SAMPLE-ISS-2', now(), %L, %L, 10, 'lms')$$, pg_temp.lid('SAMPLE-LN-1'), pg_temp.sk('iss2'), pg_temp.sha('iss2'))), '42501', 'the system role has no insert privilege at all');
select pg_temp.as_user('ea000000-0000-4000-8000-000000000002');
select is(pg_temp.st(format($$insert into servicing.loan_documents (lender_org_id, loan_account_id, kind, issuer, lender_reference, issued_at, storage_key, sha256, size_bytes, source, uploaded_by)
  values ('eab00000-0000-4000-8000-000000000001', %L, 'noc', 'udofin', 'SAMPLE-ISS-3', now(), %L, %L, 10, 'lender_upload', 'ea000000-0000-4000-8000-000000000002')$$,
  pg_temp.lid('SAMPLE-LN-1'), pg_temp.sk('iss3'), pg_temp.sha('iss3'))), '42501', 'a lender user has none either');
select pg_temp.as_anon();
select is(pg_temp.st(format($$insert into servicing.loan_documents (lender_org_id, loan_account_id, kind, issuer, lender_reference, issued_at, storage_key, sha256, size_bytes, source)
  values ('eab00000-0000-4000-8000-000000000001', %L, 'noc', 'udofin', 'SAMPLE-ISS-4', now(), %L, %L, 10, 'lms')$$, pg_temp.lid('SAMPLE-LN-1'), pg_temp.sk('iss4'), pg_temp.sha('iss4'))), '42501', 'nor does anon');
select pg_temp.as_owner();
select is(pg_temp.err(format($$insert into servicing.loan_documents (lender_org_id, loan_account_id, kind, lender_reference, issued_at, storage_key, sha256, size_bytes, mime_type, source, uploaded_by)
  values ('eab00000-0000-4000-8000-000000000001', %L, 'noc', 'SAMPLE-MIME-1', now(), %L, %L, 10, 'image/png', 'lender_upload', 'ea000000-0000-4000-8000-000000000002')$$,
  pg_temp.lid('SAMPLE-LN-1'), pg_temp.sk('mime1'), pg_temp.sha('mime1'))), '23514|', 'the table accepts only application/pdf');
select pg_temp.as_user('ea000000-0000-4000-8000-000000000002');
select is(pg_temp.err(format($$select servicing.register_loan_document(%L, 'noc', %L, %L, 100, 'text/html', 'SAMPLE-REF-x', now(), null, null, null, null, 'lender_upload')$$,
  pg_temp.lid('SAMPLE-LN-1'), pg_temp.sk('x'), pg_temp.sha('x'))), '22023|mime_not_allowed', 'the function accepts only application/pdf');
select is(pg_temp.err(format($$select servicing.register_loan_document(%L, 'noc', 'plain/key-key-key-key', %L, 100, 'application/pdf', 'SAMPLE-REF-x', now(), null, null, null, null, 'lender_upload')$$,
  pg_temp.lid('SAMPLE-LN-1'), pg_temp.sha('x'))), '22023|storage_key_invalid', 'a storage key outside the servicing namespace is refused');
select is(pg_temp.err(format($$select servicing.register_loan_document(%L, 'noc', %L, 'ABC', 100, 'application/pdf', 'SAMPLE-REF-x', now(), null, null, null, null, 'lender_upload')$$,
  pg_temp.lid('SAMPLE-LN-1'), pg_temp.sk('x'))), '22023|sha256_invalid', 'a malformed hash is refused');
select is(pg_temp.err(format($$select servicing.register_loan_document(%L, 'noc', %L, %L, 0, 'application/pdf', 'SAMPLE-REF-x', now(), null, null, null, null, 'lender_upload')$$,
  pg_temp.lid('SAMPLE-LN-1'), pg_temp.sk('x'), pg_temp.sha('x'))), '22023|size_invalid', 'an empty file is refused');
select is(pg_temp.err(format($$select servicing.register_loan_document(%L, 'noc', %L, %L, 26214401, 'application/pdf', 'SAMPLE-REF-x', now(), null, null, null, null, 'lender_upload')$$,
  pg_temp.lid('SAMPLE-LN-1'), pg_temp.sk('x'), pg_temp.sha('x'))), '22023|size_invalid', 'a file over 25 MB is refused');
select is(pg_temp.err(format($$select servicing.register_loan_document(%L, 'noc', %L, %L, 100, 'application/pdf', 'bad ref!', now(), null, null, null, null, 'lender_upload')$$,
  pg_temp.lid('SAMPLE-LN-1'), pg_temp.sk('x'), pg_temp.sha('x'))), '22023|reference_invalid', 'a lender reference with spaces or symbols is refused');
select is(pg_temp.err(format($$select servicing.register_loan_document(%L, 'noc', %L, %L, 100, 'application/pdf', 'SAMPLE-REF-x', now() + interval '2 days', null, null, null, null, 'lender_upload')$$,
  pg_temp.lid('SAMPLE-LN-1'), pg_temp.sk('x'), pg_temp.sha('x'))), '22023|issued_at_invalid', 'a document issued in the future is refused');
select is(pg_temp.err(format($$select pg_temp.reg(%L, 'statement', 'stmt-noperiod')$$, pg_temp.lid('SAMPLE-LN-1'))), '22023|period_invalid', 'a statement needs its period');
select is(pg_temp.err(format($$select pg_temp.reg(%L, 'noc', 'noc-period', current_date - 3, current_date - 1)$$, pg_temp.lid('SAMPLE-LN-1'))), '22023|period_not_allowed', 'a period on a NOC is refused');
select is(pg_temp.err(format($$select pg_temp.reg(%L, 'balance', 'x')$$, pg_temp.lid('SAMPLE-LN-1'))), '22023|kind_invalid', 'an unknown kind is refused');
select is(pg_temp.err(format($$select pg_temp.reg(%L, 'noc', 'x', null, null, null, null, 'lms')$$, pg_temp.lid('SAMPLE-LN-1'))), '22023|source_invalid', 'a person cannot claim the lms source');
select is(pg_temp.err(format($$select pg_temp.reg(%L, 'noc', 'x')$$, '00000000-0000-4000-8000-000000000000')), 'P0002|', 'an unknown loan is not found');
select is(pg_temp.err(format($$select pg_temp.reg(%L, 'noc', 'x')$$, pg_temp.lid('SAMPLE-LN-3'))), 'P0002|', 'a loan of another lender is not found for this lender''s user');
select pg_temp.as_user('ea000000-0000-4000-8000-000000000003');
select is(pg_temp.err(format($$select pg_temp.reg(%L, 'noc', 'x')$$, pg_temp.lid('SAMPLE-LN-1'))), '42501|', 'a viewer cannot register a document');
select pg_temp.as_user('ea000000-0000-4000-8000-000000000008');
select is(pg_temp.err(format($$select pg_temp.reg(%L, 'noc', 'x')$$, pg_temp.lid('SAMPLE-LN-1'))), '42501|', 'a platform auditor, who can read loans, cannot register a document');
select pg_temp.as_user('ea000000-0000-4000-8000-000000000001');
select is(pg_temp.err(format($$select pg_temp.reg(%L, 'noc', 'x')$$, pg_temp.lid('SAMPLE-LN-1'))), 'P0002|', 'platform staff without loan access cannot register a document (not found)');
select pg_temp.as_user('ea000000-0000-4000-8000-000000000005');
select is(pg_temp.err(format($$select pg_temp.reg(%L, 'noc', 'x')$$, pg_temp.lid('SAMPLE-LN-1'))), 'P0002|', 'a borrower cannot register a document (not found)');
select pg_temp.as_system();
select is(pg_temp.err(format($$select pg_temp.reg(%L, 'noc', 'x', null, null, null, null, 'lender_upload')$$, pg_temp.lid('SAMPLE-LN-1'))), '22023|source_invalid', 'the system role cannot claim a lender upload');

-- Idempotency, supersession, the mock guard.
select pg_temp.as_user('ea000000-0000-4000-8000-000000000002');
select is(pg_temp.reg(pg_temp.lid('SAMPLE-LN-1'), 'statement', 'stmt-1', current_date - 90, current_date - 30)::text, pg_temp.got('d1'), 'registering the same lender reference with the same bytes returns the same row');
select is(pg_temp.err(format($$select servicing.register_loan_document(%L, 'statement', %L, %L, 99, 'application/pdf', 'SAMPLE-REF-stmt-1', now() - interval '1 minute', current_date - 90, current_date - 30, null, null, 'lender_upload')$$,
  pg_temp.lid('SAMPLE-LN-1'), pg_temp.sk('stmt-other'), pg_temp.sha('stmt-other'))), '23505|lender_reference_reused', 'the same reference with different bytes is a conflict, never an overwrite');
select is(pg_temp.err(format($$select servicing.register_loan_document(%L, 'statement', %L, %L, 99, 'application/pdf', 'SAMPLE-REF-new', now() - interval '1 minute', current_date - 90, current_date - 30, null, null, 'lender_upload')$$,
  pg_temp.lid('SAMPLE-LN-1'), pg_temp.sk('stmt-1'), pg_temp.sha('stmt-new'))), '23505|storage_key_in_use', 'a storage key cannot be used twice');
select pg_temp.keep('d2', pg_temp.reg(pg_temp.lid('SAMPLE-LN-1'), 'statement', 'stmt-1b', current_date - 90, current_date - 30, pg_temp.got('d1')::uuid)::text);
select is((select superseded_by_id from servicing.lender_loan_documents(pg_temp.lid('SAMPLE-LN-1')) where document_id = pg_temp.got('d1')::uuid), pg_temp.got('d2')::uuid, 'a corrected statement supersedes the earlier one; the earlier stays on record');
select is(pg_temp.err(format($$select pg_temp.reg(%L, 'statement', 'stmt-1c', current_date - 90, current_date - 30, %L)$$, pg_temp.lid('SAMPLE-LN-1'), pg_temp.got('d1'))), '23505|already_superseded', 'a document is superseded at most once');
select is(pg_temp.err(format($$select pg_temp.reg(%L, 'noc', 'noc-wrong-super', null, null, %L)$$, pg_temp.lid('SAMPLE-LN-1'), pg_temp.got('d2'))), '22023|supersedes_invalid', 'it can only supersede a document of the same kind');
select is(pg_temp.err(format($$select pg_temp.reg(%L, 'statement', 'stmt-other-super', current_date - 90, current_date - 30, %L)$$, pg_temp.lid('SAMPLE-LN-2'), pg_temp.got('d2'))), '22023|supersedes_invalid', 'nor one of another loan');
select pg_temp.as_system();
-- Review finding F4: the system role registers a lender-issued record only for an ACTIVE machine feed with the capability.
select is(pg_temp.err(format($$select pg_temp.reg(%L, 'noc', 'mock-doc', null, null, null, null, 'mock')$$, pg_temp.lid('SAMPLE-LN-1'))), '55000|feed_not_active',
  'the system role cannot register a document while the lender has no active machine feed (not even a mock one)');
select is(pg_temp.err(format($$select pg_temp.reg(%L, 'closure_letter', 'lms-doc', null, null, null, null, 'lms')$$, pg_temp.lid('SAMPLE-LN-1'))), '55000|feed_not_active',
  'nor an lms document: no real LMS connector exists, so none can be active');
select is(pg_temp.err(format($$select pg_temp.quote(%L, 'SAMPLE-Q-SYS', 24, '1.00', '0', '0', '0', '1.00', null, 'mock')$$, pg_temp.lid('SAMPLE-LN-1'))), '55000|feed_not_active', 'nor a quotation');
select pg_temp.as_owner();
select set_config('udofin.allow_mock_providers', 'on', true);
insert into servicing.lms_connections (lender_org_id, kind, status, provider_mode, capabilities)
values ('eab00000-0000-4000-8000-000000000001', 'mock', 'active', 'mock', '{"statement":true,"closure_documents":true,"foreclosure_quote":true}');
select set_config('udofin.allow_mock_providers', 'off', true);
select pg_temp.as_system();
select is(pg_temp.err(format($$select pg_temp.reg(%L, 'noc', 'mock-doc', null, null, null, null, 'mock')$$, pg_temp.lid('SAMPLE-LN-1'))), '42501|mock_provider_blocked', 'a mock document is refused unless the session allows mock providers');
select pg_temp.keep('mockon', set_config('udofin.allow_mock_providers', 'on', true));
select pg_temp.keep('d_mock', pg_temp.reg(pg_temp.lid('SAMPLE-LN-1'), 'noc', 'mock-doc', null, null, null, null, 'mock')::text);
select is((select source from servicing.loan_documents where id = pg_temp.got('d_mock')::uuid), 'mock', 'with mocks allowed and an active mock feed the system registers one, labelled mock');
select pg_temp.keep('mockoff', set_config('udofin.allow_mock_providers', 'off', true));
select is(pg_temp.err(format($$select pg_temp.reg(%L, 'closure_letter', 'lms-doc', null, null, null, null, 'lms')$$, pg_temp.lid('SAMPLE-LN-1'))), '55000|feed_not_active',
  'a mock feed does not stand in for an lms feed: an lms document is still refused');
select pg_temp.as_owner();
select set_config('udofin.allow_mock_providers', 'on', true);
update servicing.lms_connections set capabilities = '{"statement":true}' where lender_org_id = 'eab00000-0000-4000-8000-000000000001';
select set_config('udofin.allow_mock_providers', 'off', true);
select pg_temp.as_system();
select is(pg_temp.err(format($$select pg_temp.reg(%L, 'noc', 'mock-doc-2', null, null, null, null, 'mock')$$, pg_temp.lid('SAMPLE-LN-1'))), '55000|feed_not_active', 'the feed must declare the capability for the kind of record (closure_documents for a NOC)');
select pg_temp.as_owner();
select set_config('udofin.allow_mock_providers', 'on', true);
update servicing.lms_connections set capabilities = '{"statement":true,"closure_documents":true,"foreclosure_quote":true}', status = 'paused' where lender_org_id = 'eab00000-0000-4000-8000-000000000001';
select set_config('udofin.allow_mock_providers', 'off', true);
select pg_temp.as_system();
select is(pg_temp.err(format($$select pg_temp.reg(%L, 'noc', 'mock-doc-3', null, null, null, null, 'mock')$$, pg_temp.lid('SAMPLE-LN-1'))), '55000|feed_not_active', 'a paused feed registers nothing');
select pg_temp.as_owner();
select set_config('udofin.allow_mock_providers', 'on', true);
update servicing.lms_connections set status = 'active' where lender_org_id = 'eab00000-0000-4000-8000-000000000001';
select set_config('udofin.allow_mock_providers', 'off', true);
select pg_temp.as_owner();
select is((select count(*) from servicing.loan_documents where lender_reference = 'SAMPLE-REF-mock-doc' and issuer = 'lender'), 1::bigint, 'every stored document has the lender as issuer');
select is(pg_temp.err(format($$update servicing.loan_documents set sha256 = %L where id = %L$$, pg_temp.sha('tamper'), pg_temp.got('d1'))), 'P0001|Record a compensating entry instead.', 'a registered document cannot be edited');
select is(pg_temp.err(format($$delete from servicing.loan_documents where id = %L$$, pg_temp.got('d1'))), 'P0001|Record a compensating entry instead.', 'nor deleted');
select is((select count(*) from audit.events where action = 'servicing.loan_document.registered' and (metadata::text like '%SAMPLE-REF%' or metadata::text like '%servicing/test%' or metadata::text ~ '[0-9a-f]{64}')), 0::bigint,
  'registrations are audited without the storage key, the hash or the lender reference');

-- Reads: the borrower sees own documents only, the content path writes the access log.
select pg_temp.as_user('ea000000-0000-4000-8000-000000000005');
select is((select string_agg(kind, ',' order by kind) from servicing.my_loan_documents(pg_temp.lid('SAMPLE-LN-1'))), 'statement,statement', 'the borrower lists the lender-issued documents of their loan; the mock one is hidden while mocks are off');
select is(pg_temp.err(format($$select servicing.my_loan_documents(%L)$$, pg_temp.lid('SAMPLE-LN-2'))), 'P0002|', 'the document list of another borrower''s loan is not found');
select is((servicing.open_loan_document(pg_temp.got('d1')::uuid) ->> 'sha256'), pg_temp.sha('stmt-1'), 'opening returns the recorded hash for the API to verify the bytes against');
select is((servicing.open_loan_document(pg_temp.got('d1')::uuid, 'view') ->> 'storage_key'), pg_temp.sk('stmt-1'), 'and the opaque storage key');
select is(pg_temp.err(format($$select servicing.open_loan_document(%L, 'print')$$, pg_temp.got('d1'))), '22023|purpose_invalid', 'an unknown purpose is refused');
select is(pg_temp.err(format($$select servicing.open_loan_document(%L)$$, pg_temp.got('d_mock'))), 'P0002|', 'a mock document cannot be opened while mocks are off');
select is(pg_temp.err(format($$select storage_key from servicing.loan_documents$$)), '42501|', 'a borrower cannot select the storage key column');
select is((select count(*) from servicing.loan_documents), 0::bigint, 'and sees no registry row: borrowers have no table access');
select is((select count(*) from servicing.loan_document_access), 0::bigint, 'nor any access-log row');
select pg_temp.as_user('ea000000-0000-4000-8000-000000000006');
select is(pg_temp.err(format($$select servicing.open_loan_document(%L)$$, pg_temp.got('d1'))), 'P0002|', 'another borrower cannot open the document (not found)');
select is((select count(*) from servicing.loan_document_access), 0::bigint, 'and cannot read the access log');
select pg_temp.as_user('ea000000-0000-4000-8000-000000000003');
select is((servicing.lender_open_loan_document(pg_temp.got('d1')::uuid) ->> 'sha256'), pg_temp.sha('stmt-1'), 'a lender user with loan.read opens a document of its own loan');
select pg_temp.as_user('ea000000-0000-4000-8000-000000000004');
select is(pg_temp.err(format($$select servicing.lender_open_loan_document(%L)$$, pg_temp.got('d1'))), 'P0002|', 'a user of another lender cannot open it (not found)');
select is(pg_temp.err(format($$select servicing.lender_loan_documents(%L)$$, pg_temp.lid('SAMPLE-LN-1'))), 'P0002|', 'nor list it');
select pg_temp.as_user('ea000000-0000-4000-8000-000000000008');
select is(pg_temp.err(format($$select servicing.lender_open_loan_document(%L)$$, pg_temp.got('d1'))), 'P0002|', 'a platform auditor cannot open lender-issued content (membership of the lender is required)');
select pg_temp.as_user('ea000000-0000-4000-8000-000000000005');
select is(pg_temp.err(format($$select servicing.lender_open_loan_document(%L)$$, pg_temp.got('d1'))), 'P0002|', 'a borrower cannot use the lender function');
select pg_temp.as_system();
select is(pg_temp.st(format($$select servicing.lender_open_loan_document(%L)$$, pg_temp.got('d1'))), '42501', 'the system role cannot open lender content');
select is(pg_temp.st(format($$select servicing.open_loan_document(%L)$$, pg_temp.got('d1'))), '42501', 'nor borrower content');
select pg_temp.as_owner();
select is((select actor_type || ':' || purpose from servicing.loan_document_access where document_id = pg_temp.got('d1')::uuid order by accessed_at limit 1), 'borrower:download', 'the first access was the borrower''s download');
select is((select string_agg(actor_type || ':' || purpose, ',' order by accessed_at) from servicing.loan_document_access where document_id = pg_temp.got('d1')::uuid), 'borrower:download,borrower:view,lender:view',
  'the access log records who opened what (two borrower opens, one lender open) and nothing else');
select is(pg_temp.err(format($$update servicing.loan_document_access set purpose = 'view' where document_id = %L$$, pg_temp.got('d1'))), 'P0001|Record a compensating entry instead.', 'the access log is append-only');
select is((select count(*) from information_schema.columns where table_schema = 'servicing' and table_name = 'loan_document_access' and column_name ~ '(content|body|bytes|text)'), 0::bigint, 'the access log has no content column');

-- ============================================================================================================================
-- 5. Foreclosure quotations
-- ============================================================================================================================
select pg_temp.as_user('ea000000-0000-4000-8000-000000000002', 'aal2');
select pg_temp.keep('q1', pg_temp.quote(pg_temp.lid('SAMPLE-LN-1'), 'SAMPLE-Q-1', 24, '10000.00', '500.00', '100.00', '200.00', '10800.00', pg_temp.got('rq1')::uuid)::text);
select is((select (principal_minor, interest_minor, charges_minor, prepayment_charge_minor, total_minor, total_mismatch)::text from servicing.foreclosure_quotes where id = pg_temp.got('q1')::uuid),
  '(1000000,50000,10000,20000,1080000,f)', 'the quotation is stored in paise exactly as reported; parts and total agree so the flag is false');
select is((select status || ':' || (fulfilled_quote_id = pg_temp.got('q1')::uuid)::text from servicing.document_requests where id = pg_temp.got('rq1')::uuid), 'fulfilled:true', 'recording it fulfils the borrower''s quotation request');
select pg_temp.keep('q2', pg_temp.quote(pg_temp.lid('SAMPLE-LN-1'), 'SAMPLE-Q-2', 24, '10000.00', '500.00', '100.00', '200.00', '10850.00')::text);
select is((select (total_minor, total_mismatch)::text from servicing.foreclosure_quotes where id = pg_temp.got('q2')::uuid), '(1085000,t)',
  'a total that differs from the sum of the parts is FLAGGED and stored as reported: nothing is corrected');
select is((select (principal_minor + interest_minor + charges_minor + prepayment_charge_minor)::text from servicing.foreclosure_quotes where id = pg_temp.got('q2')::uuid), '1080000',
  'the reported parts were not touched to match the total');
select is(pg_temp.err(format($$select pg_temp.quote(%L, 'SAMPLE-Q-3', 24, '1e3')$$, pg_temp.lid('SAMPLE-LN-1'))), '22023|money_invalid', 'an amount in exponent form is refused by the one strict parser');
select is(pg_temp.err(format($$select pg_temp.quote(%L, 'SAMPLE-Q-3', 24, '100.001')$$, pg_temp.lid('SAMPLE-LN-1'))), '22023|money_invalid', 'more than two decimals is refused');
select is(pg_temp.err(format($$select pg_temp.quote(%L, 'SAMPLE-Q-3', 24, '-5.00')$$, pg_temp.lid('SAMPLE-LN-1'))), '22023|money_invalid', 'a negative amount is refused');
select is(pg_temp.err(format($$select pg_temp.quote(%L, 'SAMPLE-Q-3', 24, null)$$, pg_temp.lid('SAMPLE-LN-1'))), '22023|money_invalid', 'a missing part is refused');
select is(pg_temp.err(format($$select servicing.record_foreclosure_quote(%L, 'SAMPLE-Q-3', now() - interval '1 hour', now() - interval '2 hours', '1.00', '0', '0', '0', '1.00', 'lender_portal', null, null)$$, pg_temp.lid('SAMPLE-LN-1'))),
  '22023|validity_order', 'the validity must end after the as-of time');
select is(pg_temp.err(format($$select servicing.record_foreclosure_quote(%L, 'SAMPLE-Q-3', now() - interval '1 hour', now() - interval '1 hour', '1.00', '0', '0', '0', '1.00', 'lender_portal', null, null)$$, pg_temp.lid('SAMPLE-LN-1'))),
  '22023|validity_order', 'a validity that ends exactly at the as-of time is refused');
select is(pg_temp.err(format($$select servicing.record_foreclosure_quote(%L, 'SAMPLE-Q-3', now() + interval '1 day', now() + interval '2 days', '1.00', '0', '0', '0', '1.00', 'lender_portal', null, null)$$, pg_temp.lid('SAMPLE-LN-1'))),
  '22023|as_of_invalid', 'an as-of time in the future is refused');
select is(pg_temp.err(format($$select pg_temp.quote(%L, 'bad ref')$$, pg_temp.lid('SAMPLE-LN-1'))), '22023|reference_invalid', 'a malformed quotation reference is refused');
select is(pg_temp.err(format($$select pg_temp.quote(%L, 'SAMPLE-Q-3', 24, '1.00', '0', '0', '0', '1.00', null, 'lms')$$, pg_temp.lid('SAMPLE-LN-1'))), '22023|source_invalid', 'a person cannot claim the lms source for a quotation');
select is(servicing.record_foreclosure_quote(pg_temp.lid('SAMPLE-LN-1'), 'SAMPLE-Q-1',
    pg_temp.q(format($$select as_of::text from servicing.foreclosure_quotes where id = %L$$, pg_temp.got('q1')))::timestamptz,
    pg_temp.q(format($$select valid_until::text from servicing.foreclosure_quotes where id = %L$$, pg_temp.got('q1')))::timestamptz,
    '10000.00', '500.00', '100.00', '200.00', '10800.00')::text, pg_temp.got('q1'), 'the same reference with the same figures is idempotent');
select is(pg_temp.err(format($$select pg_temp.quote(%L, 'SAMPLE-Q-1', 24, '10000.00', '500.00', '100.00', '200.00', '10801.00')$$, pg_temp.lid('SAMPLE-LN-1'))), '23505|quote_ref_reused', 'the same reference with different figures is a conflict, never an overwrite');
select is(pg_temp.err(format($$select pg_temp.quote(%L, 'SAMPLE-Q-3', 24, '1.00', '0', '0', '0', '1.00', %L)$$, pg_temp.lid('SAMPLE-LN-1'), pg_temp.got('r3'))), '55000|request_not_open', 'a closed request cannot be fulfilled by a quotation');
select is(pg_temp.err(format($$select pg_temp.quote(%L, 'SAMPLE-Q-3', 24, '1.00', '0', '0', '0', '1.00', %L)$$, pg_temp.lid('SAMPLE-LN-1'), '00000000-0000-4000-8000-000000000000')), '55000|request_not_open', 'an unknown request is refused');
-- A letter attached to a quotation must be a foreclosure_quote document of the same loan.
select pg_temp.keep('d_letter', pg_temp.reg(pg_temp.lid('SAMPLE-LN-1'), 'foreclosure_quote', 'quote-letter-1')::text);
select is(pg_temp.err(format($$select pg_temp.quote(%L, 'SAMPLE-Q-4', 24, '1.00', '0', '0', '0', '1.00', null, 'lender_portal', %L)$$, pg_temp.lid('SAMPLE-LN-1'), pg_temp.got('d1'))), '22023|letter_invalid', 'a statement cannot be the letter of a quotation');
select pg_temp.keep('q4', pg_temp.quote(pg_temp.lid('SAMPLE-LN-1'), 'SAMPLE-Q-4', 24, '1.00', '0', '0', '0', '1.00', null, 'lender_portal', pg_temp.got('d_letter')::uuid)::text);
select is((select letter_document_id from servicing.foreclosure_quotes where id = pg_temp.got('q4')::uuid), pg_temp.got('d_letter')::uuid, 'the lender''s quotation letter can be attached');
select is(pg_temp.err(format($$select pg_temp.reg(%L, 'foreclosure_quote', 'quote-letter-2', null, null, null, %L)$$, pg_temp.lid('SAMPLE-LN-1'), pg_temp.got('rq1'))), '55000|request_not_open', 'a quotation request is closed once fulfilled');
select pg_temp.as_user('ea000000-0000-4000-8000-000000000005');
select pg_temp.keep('rq2', servicing.request_document(pg_temp.lid('SAMPLE-LN-1'), 'foreclosure_quote', 'sample-key-0022')::text);
select pg_temp.as_user('ea000000-0000-4000-8000-000000000002');
select is(pg_temp.err(format($$select pg_temp.reg(%L, 'foreclosure_quote', 'quote-letter-3', null, null, null, %L)$$, pg_temp.lid('SAMPLE-LN-1'), pg_temp.got('rq2'))), '55000|request_kind_mismatch',
  'a quotation request is fulfilled only by recording a quotation, not by a document');
select is(pg_temp.err(format($$select servicing.record_foreclosure_quote(%L, 'SAMPLE-Q-5', now() - interval '3 hours', now() - interval '1 hour', '1.00', '0', '0', '0', '1.00', 'lender_portal', %L, null)$$, pg_temp.lid('SAMPLE-LN-1'), pg_temp.got('rq2'))),
  '55000|quote_already_expired', 'an already-expired quotation cannot fulfil a request');
select pg_temp.as_user('ea000000-0000-4000-8000-000000000005');
select pg_temp.keep('rs4', servicing.request_document(pg_temp.lid('SAMPLE-LN-1'), 'statement', 'sample-key-0023')::text);
select pg_temp.as_user('ea000000-0000-4000-8000-000000000002');
select is(pg_temp.err(format($$select pg_temp.quote(%L, 'SAMPLE-Q-5', 24, '1.00', '0', '0', '0', '1.00', %L)$$, pg_temp.lid('SAMPLE-LN-1'), pg_temp.got('rs4'))), '55000|request_kind_mismatch', 'a statement request cannot be fulfilled by a quotation');
-- Latest valid quotation.
select pg_temp.as_owner();
insert into servicing.foreclosure_quotes (lender_org_id, loan_account_id, lender_quote_ref, as_of, valid_until, principal_minor, interest_minor, charges_minor, prepayment_charge_minor, total_minor, source, reported_by)
values ('eab00000-0000-4000-8000-000000000001', pg_temp.lid('SAMPLE-LN-1'), 'SAMPLE-Q-EXPIRED', now() - interval '10 minutes', now() - interval '1 minute', 1, 0, 0, 0, 1, 'lender_portal', 'ea000000-0000-4000-8000-000000000002'),
       ('eab00000-0000-4000-8000-000000000001', pg_temp.lid('SAMPLE-LN-2'), 'SAMPLE-Q-OTHER-LOAN', now() - interval '5 minutes', now() + interval '1 day', 5, 0, 0, 0, 5, 'lender_portal', 'ea000000-0000-4000-8000-000000000002');
select pg_temp.as_user('ea000000-0000-4000-8000-000000000005');
select is((select lender_quote_ref from servicing.latest_valid_quote(pg_temp.lid('SAMPLE-LN-1'))), 'SAMPLE-Q-4',
  'the newest unexpired quotation of the loan is returned (not the expired one that is newer, and not another loan''s)');
select is((select count(*) from servicing.latest_valid_quote(pg_temp.lid('SAMPLE-LN-1'))), 1::bigint, 'exactly one row');
select is((select count(*) from servicing.latest_valid_quote(pg_temp.lid('SAMPLE-LN-2'))), 0::bigint, 'another borrower''s loan returns nothing to this borrower');
select is((select count(*) from servicing.latest_valid_quote('00000000-0000-4000-8000-000000000000')), 0::bigint, 'an unknown loan returns nothing');
select pg_temp.as_user('ea000000-0000-4000-8000-000000000006');
select is((select lender_quote_ref from servicing.latest_valid_quote(pg_temp.lid('SAMPLE-LN-2'))), 'SAMPLE-Q-OTHER-LOAN', 'the other borrower gets the quotation of their own loan');
select is((select count(*) from servicing.latest_valid_quote(pg_temp.lid('SAMPLE-LN-1'))), 0::bigint, 'and nothing for the first borrower''s loan');
select pg_temp.as_user('ea000000-0000-4000-8000-000000000003');
select is((select lender_quote_ref from servicing.latest_valid_quote(pg_temp.lid('SAMPLE-LN-1'))), 'SAMPLE-Q-4', 'a lender user with loan.read gets it for the lender''s own loan');
select pg_temp.as_user('ea000000-0000-4000-8000-000000000004');
select is((select count(*) from servicing.latest_valid_quote(pg_temp.lid('SAMPLE-LN-1'))), 0::bigint, 'a user of another lender gets nothing');
select pg_temp.as_system();
select is((select lender_quote_ref || ':' || total_mismatch::text from servicing.latest_valid_quote(pg_temp.lid('SAMPLE-LN-1'))), 'SAMPLE-Q-4:false', 'the system (a foreclosure payment) gets it, with the flag');
select is((select count(*) from servicing.latest_valid_quote(pg_temp.lid('SAMPLE-LN-4'))), 0::bigint, 'a loan with no quotation returns nothing');
select pg_temp.as_anon();
select is(pg_temp.st(format($$select * from servicing.latest_valid_quote(%L)$$, pg_temp.lid('SAMPLE-LN-1'))), '42501', 'anon cannot call it');
select pg_temp.as_owner();
insert into servicing.foreclosure_quotes (lender_org_id, loan_account_id, lender_quote_ref, as_of, valid_until, principal_minor, interest_minor, charges_minor, prepayment_charge_minor, total_minor, source, reported_by)
values ('eab00000-0000-4000-8000-000000000001', pg_temp.lid('SAMPLE-LN-1'), 'SAMPLE-Q-NEWEST-FLAGGED', now() - interval '1 minute', now() + interval '2 days', 100, 100, 0, 0, 999, 'lender_portal', 'ea000000-0000-4000-8000-000000000002');
select pg_temp.as_system();
select is((select lender_quote_ref || ':' || total_mismatch::text from servicing.latest_valid_quote(pg_temp.lid('SAMPLE-LN-1'))), 'SAMPLE-Q-NEWEST-FLAGGED:true',
  'a newer quotation replaces the older one even when it is flagged; the flag travels with the row for the consumer to refuse');
select pg_temp.as_owner();
select is(pg_temp.err(format($$insert into servicing.foreclosure_quotes (lender_org_id, loan_account_id, lender_quote_ref, as_of, valid_until, principal_minor, interest_minor, charges_minor, prepayment_charge_minor, total_minor, source, reported_by)
  values ('eab00000-0000-4000-8000-000000000001', %L, 'SAMPLE-Q-BAD-ORDER', now() - interval '2 hours', now() - interval '2 hours', 1, 0, 0, 0, 1, 'lender_portal', 'ea000000-0000-4000-8000-000000000002')$$, pg_temp.lid('SAMPLE-LN-1'))),
  '23514|', 'the table itself refuses a validity that does not end after the as-of time');
select is(pg_temp.err(format($$insert into servicing.foreclosure_quotes (lender_org_id, loan_account_id, lender_quote_ref, as_of, valid_until, principal_minor, interest_minor, charges_minor, prepayment_charge_minor, total_minor, source, reported_by)
  values ('eab00000-0000-4000-8000-000000000001', %L, 'SAMPLE-Q-NEG', now() - interval '2 hours', now() + interval '2 hours', -1, 0, 0, 0, -1, 'lender_portal', 'ea000000-0000-4000-8000-000000000002')$$, pg_temp.lid('SAMPLE-LN-1'))),
  '23514|', 'and a negative amount');
select is(pg_temp.err(format($$insert into servicing.foreclosure_quotes (lender_org_id, loan_account_id, lender_quote_ref, as_of, valid_until, principal_minor, interest_minor, charges_minor, prepayment_charge_minor, total_minor, source, reported_by)
  values ('eab00000-0000-4000-8000-000000000001', %L, 'SAMPLE-Q-MOCK', now() - interval '2 hours', now() + interval '2 hours', 1, 0, 0, 0, 1, 'mock', null)$$, pg_temp.lid('SAMPLE-LN-1'))),
  '42501|mock_provider_blocked', 'a mock quotation is refused unless the session allows mock providers (even for the owner)');
select pg_temp.keep('mockon2', set_config('udofin.allow_mock_providers', 'on', true));
insert into servicing.foreclosure_quotes (lender_org_id, loan_account_id, lender_quote_ref, as_of, valid_until, principal_minor, interest_minor, charges_minor, prepayment_charge_minor, total_minor, source)
values ('eab00000-0000-4000-8000-000000000001', pg_temp.lid('SAMPLE-LN-1'), 'SAMPLE-Q-MOCK', now() - interval '30 seconds', now() + interval '3 days', 1, 0, 0, 0, 1, 'mock');
select pg_temp.as_system();
select is((select lender_quote_ref from servicing.latest_valid_quote(pg_temp.lid('SAMPLE-LN-1'))), 'SAMPLE-Q-MOCK', 'while mocks are allowed the mock quotation is the newest');
select pg_temp.keep('mockoff2', set_config('udofin.allow_mock_providers', 'off', true));
select is((select lender_quote_ref from servicing.latest_valid_quote(pg_temp.lid('SAMPLE-LN-1'))), 'SAMPLE-Q-NEWEST-FLAGGED', 'when mocks are not allowed the mock quotation is ignored: a mock record can never satisfy a production gate');
select pg_temp.as_owner();
select is(pg_temp.err(format($$update servicing.foreclosure_quotes set total_minor = 1 where id = %L$$, pg_temp.got('q1'))), 'P0001|Record a compensating entry instead.', 'a quotation cannot be edited');
select is(pg_temp.err(format($$delete from servicing.foreclosure_quotes where id = %L$$, pg_temp.got('q1'))), 'P0001|Record a compensating entry instead.', 'nor deleted');
select is((select count(*) from audit.events where action = 'servicing.foreclosure_quote.recorded' and entity_id = pg_temp.got('q2') and metadata ->> 'total_mismatch' = 'true'), 1::bigint,
  'the audit event of a flagged quotation says so without carrying any amount');
select is((select count(*) from audit.events e where e.action = 'servicing.foreclosure_quote.recorded'
            and exists (select 1 from jsonb_object_keys(e.metadata) k where k not in ('loan_account_id', 'source', 'request_id', 'total_mismatch'))), 0::bigint,
  'no quotation audit event carries anything but identifiers, the source and the flag (no amount)');
select pg_temp.as_user('ea000000-0000-4000-8000-000000000003');
select is((select count(*) from servicing.foreclosure_quotes), 7::bigint, 'the lender''s viewer reads every quotation of its loans through row level security');
select pg_temp.as_user('ea000000-0000-4000-8000-000000000004');
select is((select count(*) from servicing.foreclosure_quotes), 0::bigint, 'the other lender reads none of them');

-- ============================================================================================================================
-- 6. Closure
-- ============================================================================================================================
select pg_temp.as_owner();
select is((select count(*) from servicing.closure_records where loan_account_id = pg_temp.lid('SAMPLE-LN-4')), 0::bigint, 'an active loan has no closure record');
select is((select count(*) from ops.outbox_events where event_type = 'servicing.loan_closed' and payload ->> 'loan_account_id' = pg_temp.lid('SAMPLE-LN-4')::text), 0::bigint, 'and no closure event');
select pg_temp.as_system();
select pg_temp.as_owner();
update servicing.loan_accounts set status = 'closed' where lms_loan_ref = 'SAMPLE-LN-4';
select pg_temp.as_system();
select pg_temp.as_owner();
select is((select count(*) from servicing.closure_records where loan_account_id = pg_temp.lid('SAMPLE-LN-4')), 1::bigint, 'the lender''s report of closure opens exactly one closure record');
select is((select closure_kind || ':' || (noc_due_by is null and noc_due_rule_id is null)::text from servicing.closure_records where loan_account_id = pg_temp.lid('SAMPLE-LN-4')), 'closed:false',
  'the NOC rule was approved above, so the closure record has a due date and a rule ');
select is((select count(*) from ops.outbox_events where event_type = 'servicing.loan_closed' and payload ->> 'loan_account_id' = pg_temp.lid('SAMPLE-LN-4')::text), 1::bigint, 'exactly one servicing.loan_closed event is enqueued');
select is((select array_agg(k order by k) from ops.outbox_events e, jsonb_object_keys(e.payload) k where e.event_type = 'servicing.loan_closed' and e.payload ->> 'loan_account_id' = pg_temp.lid('SAMPLE-LN-4')::text),
  array['closure_id', 'lender_org_id', 'loan_account_id'], 'the event carries ids only');
select is((select dedupe_key from ops.outbox_events where event_type = 'servicing.loan_closed' and payload ->> 'loan_account_id' = pg_temp.lid('SAMPLE-LN-4')::text), 'servicing.loan_closed:' || pg_temp.lid('SAMPLE-LN-4')::text, 'with a per-loan dedupe key');
select is((select count(*) from audit.events where action = 'servicing.closure.opened' and metadata ->> 'loan_account_id' = pg_temp.lid('SAMPLE-LN-4')::text), 1::bigint, 'and an audit event');
select pg_temp.as_system();
select pg_temp.as_owner();
update servicing.loan_accounts set status = 'foreclosed' where lms_loan_ref = 'SAMPLE-LN-4';
select pg_temp.as_system();
select pg_temp.as_owner();
update servicing.loan_accounts set status = 'active' where lms_loan_ref = 'SAMPLE-LN-4';
select pg_temp.as_system();
select pg_temp.as_owner();
update servicing.loan_accounts set status = 'closed' where lms_loan_ref = 'SAMPLE-LN-4';
select pg_temp.as_system();
select pg_temp.as_owner();
select is((select count(*) from servicing.closure_records where loan_account_id = pg_temp.lid('SAMPLE-LN-4')), 1::bigint, 'further status changes (foreclosed, a reversal, closed again) never open a second record');
select is((select count(*) from ops.outbox_events where event_type = 'servicing.loan_closed' and payload ->> 'loan_account_id' = pg_temp.lid('SAMPLE-LN-4')::text), 1::bigint, 'nor a second event');
select pg_temp.as_system();
select pg_temp.as_owner();
update servicing.loan_accounts set status = 'written_off' where lms_loan_ref = 'SAMPLE-LN-7';
select pg_temp.as_system();
select pg_temp.as_owner();
select is((select count(*) from servicing.closure_records where loan_account_id = pg_temp.lid('SAMPLE-LN-7')), 0::bigint, 'a write-off is not a closure');
select pg_temp.as_system();
select pg_temp.as_owner();
update servicing.loan_accounts set status = 'active' where lms_loan_ref = 'SAMPLE-LN-7';
select pg_temp.as_system();
select pg_temp.as_owner();

-- Due dates from the rules. The security-release rule is still a draft: tasks get no due date yet.
select is((select (noc_due_by - closed_at = interval '30 days')::text from servicing.closure_records where loan_account_id = pg_temp.lid('SAMPLE-LN-4')), 'true',
  'the NOC due date is the recording time plus the days of the approved NOC rule');
select is((select noc_due_rule_id from servicing.closure_records where loan_account_id = pg_temp.lid('SAMPLE-LN-4')), (select id from documents.applicability_rules where rule_key = 'servicing.noc_sla_days_default'),
  'and it names the rule');
select is(pg_temp.err(format($$update servicing.closure_records set closed_at = now() where loan_account_id = %L$$, pg_temp.lid('SAMPLE-LN-4'))), 'P0001|closure_immutable', 'a closure record cannot be edited');
select is(pg_temp.err(format($$delete from servicing.closure_records where loan_account_id = %L$$, pg_temp.lid('SAMPLE-LN-4'))), 'P0001|Record a compensating entry instead.', 'nor deleted');

-- The NOC: requests, issuing, the closure record learns the reference once.
select pg_temp.as_user('ea000000-0000-4000-8000-000000000005');
select pg_temp.keep('rn1', servicing.request_document(pg_temp.lid('SAMPLE-LN-4'), 'noc', 'sample-key-0030')::text);
select is(pg_temp.q(format($$select (due_by - requested_at = interval '30 days')::text from servicing.document_requests where id = %L$$, pg_temp.got('rn1'))), 'true', 'a NOC request is due after the days of the approved NOC rule');
select is(pg_temp.err(format($$select servicing.request_document(%L, 'foreclosure_quote', 'sample-key-0031')$$, pg_temp.lid('SAMPLE-LN-4'))), '55000|loan_not_active', 'a quotation cannot be requested for a closed loan');
select is((select noc_status || ':' || noc_prompt_key from (select servicing.my_closure(pg_temp.lid('SAMPLE-LN-4')) j) s, jsonb_to_record(s.j) as x (noc_status text, noc_prompt_key text)),
  'pending:closure.noc.lender_to_issue', 'before the lender issues anything the closure screen says the lender is to issue the NOC');
select pg_temp.as_user('ea000000-0000-4000-8000-000000000002');
select pg_temp.keep('d_noc', pg_temp.reg(pg_temp.lid('SAMPLE-LN-4'), 'noc', 'noc-4', null, null, null, pg_temp.got('rn1')::uuid)::text);
select is((select (noc_document_id = pg_temp.got('d_noc')::uuid)::text || ':' || (noc_issued_at is not null)::text from servicing.closure_records where loan_account_id = pg_temp.lid('SAMPLE-LN-4')), 'true:true',
  'the closure record learns the NOC document when the lender registers it');
select is((select status from servicing.document_requests where id = pg_temp.got('rn1')::uuid), 'fulfilled', 'and the NOC request is fulfilled');
select pg_temp.keep('d_cl', pg_temp.reg(pg_temp.lid('SAMPLE-LN-4'), 'closure_letter', 'cl-4')::text);
select is((select (noc_document_id = pg_temp.got('d_noc')::uuid)::text from servicing.closure_records where loan_account_id = pg_temp.lid('SAMPLE-LN-4')), 'true', 'a later closure letter does not replace the NOC reference');
select pg_temp.as_user('ea000000-0000-4000-8000-000000000005');
select is((select noc_status || ':' || noc_prompt_key || ':' || noc_status_source from (select servicing.my_closure(pg_temp.lid('SAMPLE-LN-4')) j) s, jsonb_to_record(s.j) as x (noc_status text, noc_prompt_key text, noc_status_source text)),
  'issued:closure.noc.issued_by_lender:lender', 'afterwards it says the lender issued it');
select is(pg_temp.err(format($$select servicing.my_closure(%L)$$, pg_temp.lid('SAMPLE-LN-1'))), 'ok', 'an open loan has a closure call that answers');
select ok(servicing.my_closure(pg_temp.lid('SAMPLE-LN-1')) is null, 'but with nothing in it (the loan is not closed)');
select pg_temp.as_user('ea000000-0000-4000-8000-000000000006');
select is(pg_temp.err(format($$select servicing.my_closure(%L)$$, pg_temp.lid('SAMPLE-LN-4'))), 'P0002|', 'another borrower cannot read the closure (not found)');
select pg_temp.as_user('ea000000-0000-4000-8000-000000000002');
select is(pg_temp.err(format($$select servicing.my_closure(%L)$$, pg_temp.lid('SAMPLE-LN-4'))), 'P0002|', 'a lender user is not a borrower: not found');

-- A loan that arrives already closed (insert path), after the NOC rule exists: opened once.
select pg_temp.as_owner();
insert into servicing.loan_accounts (lender_org_id, application_id, borrower_id, source_system, lms_loan_ref, status, sanctioned_amount_minor)
select a.lender_org_id, a.id, a.borrower_id, 'lender_lms', 'SAMPLE-LN-5', 'closed', 5000000 from lending.applications a where right(a.id::text, 2)::int = 5;
select is((select count(*) from servicing.closure_records where loan_account_id = pg_temp.lid('SAMPLE-LN-5')), 1::bigint, 'a loan inserted already closed also opens exactly one record');
select is((select count(*) from ops.outbox_events where event_type = 'servicing.loan_closed' and payload ->> 'loan_account_id' = pg_temp.lid('SAMPLE-LN-5')::text), 1::bigint, 'with one event');

-- Review finding F5: a NOC registered BEFORE the closure was reported is linked when the closure record opens.
insert into servicing.loan_accounts (lender_org_id, application_id, borrower_id, source_system, lms_loan_ref, status, sanctioned_amount_minor)
select a.lender_org_id, a.id, a.borrower_id, 'lender_lms', 'SAMPLE-LN-8', 'active', 5000000 from lending.applications a where right(a.id::text, 2)::int = 8;
select pg_temp.as_user('ea000000-0000-4000-8000-000000000002');
select pg_temp.keep('d_early', pg_temp.reg(pg_temp.lid('SAMPLE-LN-8'), 'noc', 'noc-early')::text);
select pg_temp.as_owner();
select is((select count(*) from servicing.closure_records where loan_account_id = pg_temp.lid('SAMPLE-LN-8')), 0::bigint, 'the loan is still active: no closure record yet');
update servicing.loan_accounts set status = 'closed' where lms_loan_ref = 'SAMPLE-LN-8';
select is((select (noc_document_id = pg_temp.got('d_early')::uuid and noc_issued_at is not null)::text from servicing.closure_records where loan_account_id = pg_temp.lid('SAMPLE-LN-8')), 'true',
  'the NOC the lender registered earlier is linked to the closure record when it opens');
select pg_temp.as_user('ea000000-0000-4000-8000-000000000005');
select is((servicing.my_closure(pg_temp.lid('SAMPLE-LN-8')) ->> 'noc_status'), 'issued', 'and the borrower sees the NOC as issued by the lender');
select pg_temp.as_owner();

-- Fail closed: an approved newest version that is malformed resolves nothing (no fallback to the older version).
insert into documents.applicability_rules (rule_key, version, lender_category_keys, regulator, direction_ref, paragraph_refs, product_category_keys, exclusions, document_type,
  required_template_key, required_fields_version, validity_rule, effective_from, approval_status, evidence_status, reviewer_ref, proposed_by, approved_by, approved_at)
values ('servicing.noc_sla_days_default', 2, array['nbfc_icc'], 'Udofin platform setting (not a regulator)', 'SAMPLE malformed version for a test', '{}', array['personal'], 'SAMPLE', 'noc',
  'none.lender_issued', 'none', '{"kind":"calendar_days","days":"abc"}'::jsonb, date '2026-10-01', 'approved', 'unverified', 'SAMPLE reviewer', 'ea000000-0000-4000-8000-000000000009',
  'ea000000-0000-4000-8000-000000000010', now());
select pg_temp.as_system();
select pg_temp.as_owner();
update servicing.loan_accounts set status = 'closed' where lms_loan_ref = 'SAMPLE-LN-7';
select pg_temp.as_system();
select pg_temp.as_owner();
select is((select (noc_due_by is null and noc_due_rule_id is null)::text from servicing.closure_records where loan_account_id = pg_temp.lid('SAMPLE-LN-7')), 'true',
  'a malformed newest approved rule resolves nothing: the due date is empty rather than taken from an older version');
update documents.applicability_rules set approval_status = 'retired' where rule_key = 'servicing.noc_sla_days_default' and version = 2;

-- ============================================================================================================================
-- 7. Security release and the lien prompt
-- ============================================================================================================================
select pg_temp.as_user('ea000000-0000-4000-8000-000000000005');
select is(pg_temp.err(format($$select servicing.open_security_release_tasks(%L, array['mutual_fund_lien'])$$, pg_temp.lid('SAMPLE-LN-4'))), 'P0002|', 'a borrower cannot open release tasks (not found)');
select pg_temp.as_user('ea000000-0000-4000-8000-000000000003');
select is(pg_temp.err(format($$select servicing.open_security_release_tasks(%L, array['mutual_fund_lien'])$$, pg_temp.lid('SAMPLE-LN-4'))), '42501|', 'a viewer cannot');
select pg_temp.as_user('ea000000-0000-4000-8000-000000000008');
select is(pg_temp.err(format($$select servicing.open_security_release_tasks(%L, array['mutual_fund_lien'])$$, pg_temp.lid('SAMPLE-LN-4'))), '42501|', 'nor a platform auditor');
select pg_temp.as_user('ea000000-0000-4000-8000-000000000004');
select is(pg_temp.err(format($$select servicing.open_security_release_tasks(%L, array['mutual_fund_lien'])$$, pg_temp.lid('SAMPLE-LN-4'))), 'P0002|', 'nor another lender''s operator (not found)');
select pg_temp.as_user('ea000000-0000-4000-8000-000000000002');
select is(pg_temp.err(format($$select servicing.open_security_release_tasks(%L, array['mutual_fund_lien'])$$, pg_temp.lid('SAMPLE-LN-1'))), '55000|loan_not_closed', 'tasks need a loan the lender has reported closed');
select is(pg_temp.err(format($$select servicing.open_security_release_tasks(%L, array['gold_bar'])$$, pg_temp.lid('SAMPLE-LN-4'))), '22023|collateral_types_invalid', 'an unknown collateral type is refused');
select is(pg_temp.err(format($$select servicing.open_security_release_tasks(%L, array['other', 'other'])$$, pg_temp.lid('SAMPLE-LN-4'))), '22023|collateral_types_invalid', 'duplicate types are refused');
select is(pg_temp.err(format($$select servicing.open_security_release_tasks(%L, '{}'::text[])$$, pg_temp.lid('SAMPLE-LN-4'))), '22023|collateral_types_invalid', 'an empty list is refused');
select is(pg_temp.err(format($$select servicing.open_security_release_tasks(%L, null)$$, pg_temp.lid('SAMPLE-LN-4'))), '22023|collateral_types_invalid', 'a null list is refused');
select is(servicing.open_security_release_tasks(pg_temp.lid('SAMPLE-LN-4'), array['mutual_fund_lien']), 1, 'the lender''s operator opens a release task for the test-only mutual_fund_lien fixture');
select is(servicing.open_security_release_tasks(pg_temp.lid('SAMPLE-LN-4'), array['mutual_fund_lien']), 0, 'repeating it creates nothing (idempotent)');
select is(servicing.open_security_release_tasks(pg_temp.lid('SAMPLE-LN-4'), array['mutual_fund_lien', 'demat_pledge']), 1, 'a new collateral type adds one task');
select pg_temp.keep('t_mf', (select id::text from servicing.security_release_tasks where loan_account_id = pg_temp.lid('SAMPLE-LN-4') and collateral_type = 'mutual_fund_lien'));
select pg_temp.keep('t_dp', (select id::text from servicing.security_release_tasks where loan_account_id = pg_temp.lid('SAMPLE-LN-4') and collateral_type = 'demat_pledge'));
select pg_temp.as_owner();
select is((select (status = 'open' and due_by is null and due_rule_id is null and confirmed_by is null and opened_by = 'ea000000-0000-4000-8000-000000000002')::text from servicing.security_release_tasks where id = pg_temp.got('t_mf')::uuid), 'true',
  'a task starts open, unconfirmed, with no due date while the security-release rule is still a draft (rule unresolved)');
update documents.applicability_rules set approval_status = 'approved', reviewer_ref = 'SAMPLE compliance reviewer', approved_by = 'ea000000-0000-4000-8000-000000000010',
  approved_at = now(), proposed_by = 'ea000000-0000-4000-8000-000000000009'
 where rule_key = 'servicing.security_release_sla_days';
select pg_temp.as_system();
select is(servicing.open_security_release_tasks(pg_temp.lid('SAMPLE-LN-4'), array['other']), 1, 'the system role may open tasks from the collateral types the lender reported');
select pg_temp.as_owner();
select is((select (due_by - (select closed_at from servicing.closure_records where loan_account_id = pg_temp.lid('SAMPLE-LN-4')) = interval '30 days')::text
           from servicing.security_release_tasks where loan_account_id = pg_temp.lid('SAMPLE-LN-4') and collateral_type = 'other'), 'true',
  'once the rule is approved a new task is due the rule''s days after the closure was recorded');
select is((select due_rule_id from servicing.security_release_tasks where loan_account_id = pg_temp.lid('SAMPLE-LN-4') and collateral_type = 'other'),
  (select id from documents.applicability_rules where rule_key = 'servicing.security_release_sla_days'), 'and it names the rule');
select is((select count(*) from servicing.security_release_tasks where loan_account_id = pg_temp.lid('SAMPLE-LN-4')), 3::bigint, 'three tasks exist for the loan');
select is(pg_temp.err(format($$insert into servicing.security_release_tasks (lender_org_id, loan_account_id, closure_id, collateral_type, status, lender_confirmation_ref, confirmed_by, confirmed_at)
  values ('eab00000-0000-4000-8000-000000000001', %L, %L, 'property_documents', 'confirmed_by_lender', 'SAMPLE-CONF-X', 'ea000000-0000-4000-8000-000000000002', now())$$,
  pg_temp.lid('SAMPLE-LN-4'), (select id from servicing.closure_records where loan_account_id = pg_temp.lid('SAMPLE-LN-4')))), '55000|lender_confirmation_only', 'a task cannot even be inserted as confirmed');
select is(pg_temp.err(format($$insert into servicing.security_release_tasks (lender_org_id, loan_account_id, closure_id, collateral_type)
  values ('eab00000-0000-4000-8000-000000000002', %L, %L, 'vehicle_hypothecation')$$, pg_temp.lid('SAMPLE-LN-4'), (select id from servicing.closure_records where loan_account_id = pg_temp.lid('SAMPLE-LN-4')))),
  '23503|', 'a task cannot name a lender other than the loan''s (composite tenant key)');

-- Who can confirm.
select is(pg_temp.err(format($$update servicing.security_release_tasks set status = 'confirmed_by_lender', lender_confirmation_ref = 'SAMPLE-CONF-1', confirmed_by = 'ea000000-0000-4000-8000-000000000001', confirmed_at = now() where id = %L$$, pg_temp.got('t_mf'))),
  '42501|lender_confirmation_only', 'even the table owner cannot record a platform user as the confirmer');
select is(pg_temp.err(format($$update servicing.security_release_tasks set status = 'confirmed_by_lender', lender_confirmation_ref = 'SAMPLE-CONF-1', confirmed_by = 'ea000000-0000-4000-8000-000000000004', confirmed_at = now() where id = %L$$, pg_temp.got('t_mf'))),
  '42501|lender_confirmation_only', 'nor a user of another lender');
select is(pg_temp.err(format($$update servicing.security_release_tasks set status = 'confirmed_by_lender', lender_confirmation_ref = 'SAMPLE-CONF-1', confirmed_by = 'ea000000-0000-4000-8000-000000000003', confirmed_at = now() where id = %L$$, pg_temp.got('t_mf'))),
  '42501|lender_confirmation_only', 'nor a lender user without the issue permission');
select is(pg_temp.err(format($$update servicing.security_release_tasks set status = 'confirmed_by_lender', confirmed_by = 'ea000000-0000-4000-8000-000000000002', confirmed_at = now() where id = %L$$, pg_temp.got('t_mf'))), '23514|',
  'a confirmation without the lender''s reference is refused by the table');
select is(pg_temp.err(format($$update servicing.security_release_tasks set status = 'confirmed_by_lender' where id = %L$$, pg_temp.got('t_mf'))), '42501|lender_confirmation_only', 'and one without any person is refused by the guard');
select is(pg_temp.err(format($$update servicing.security_release_tasks set collateral_type = 'other' where id = %L$$, pg_temp.got('t_mf'))), 'P0001|task_immutable', 'the content of a task never changes');
select pg_temp.as_user('ea000000-0000-4000-8000-000000000005');
select is(pg_temp.err(format($$select servicing.confirm_security_release(%L, 'SAMPLE-CONF-1')$$, pg_temp.got('t_mf'))), 'P0002|', 'a borrower cannot confirm (not found)');
select pg_temp.as_user('ea000000-0000-4000-8000-000000000001');
select is(pg_temp.err(format($$select servicing.confirm_security_release(%L, 'SAMPLE-CONF-1')$$, pg_temp.got('t_mf'))), 'P0002|', 'platform staff cannot confirm');
select pg_temp.as_user('ea000000-0000-4000-8000-000000000008');
select is(pg_temp.err(format($$select servicing.confirm_security_release(%L, 'SAMPLE-CONF-1')$$, pg_temp.got('t_mf'))), '42501|', 'nor a platform auditor');
select pg_temp.as_user('ea000000-0000-4000-8000-000000000003');
select is(pg_temp.err(format($$select servicing.confirm_security_release(%L, 'SAMPLE-CONF-1')$$, pg_temp.got('t_mf'))), '42501|', 'nor a lender viewer');
select pg_temp.as_user('ea000000-0000-4000-8000-000000000004');
select is(pg_temp.err(format($$select servicing.confirm_security_release(%L, 'SAMPLE-CONF-1')$$, pg_temp.got('t_mf'))), 'P0002|', 'nor another lender''s operator (not found)');
select pg_temp.as_system();
select is(pg_temp.st(format($$select servicing.confirm_security_release(%L, 'SAMPLE-CONF-1')$$, pg_temp.got('t_mf'))), '42501', 'Udofin''s system role can never confirm');
select is(pg_temp.st(format($$update servicing.security_release_tasks set status = 'confirmed_by_lender' where id = %L$$, pg_temp.got('t_mf'))), '42501', 'and has no write privilege on the table');
select pg_temp.as_anon();
select is(pg_temp.st(format($$select servicing.confirm_security_release(%L, 'SAMPLE-CONF-1')$$, pg_temp.got('t_mf'))), '42501', 'anon cannot');
select pg_temp.as_user('ea000000-0000-4000-8000-000000000002', 'aal1');
select is(pg_temp.err(format($$select servicing.confirm_security_release(%L, 'SAMPLE-CONF-1')$$, pg_temp.got('t_mf'))), '42501|mfa_required', 'the lender''s operator needs aal2');
select pg_temp.as_user('ea000000-0000-4000-8000-000000000002');
select is(pg_temp.err(format($$select servicing.confirm_security_release(%L, 'x')$$, pg_temp.got('t_mf'))), '22023|confirmation_ref_invalid', 'the lender''s confirmation reference is required');
select is(pg_temp.err(format($$select servicing.confirm_security_release(%L, null)$$, pg_temp.got('t_mf'))), '22023|confirmation_ref_invalid', 'a null reference is refused');

-- The lien prompt never says released unless the lender confirmed.
select pg_temp.as_user('ea000000-0000-4000-8000-000000000005');
select is((select string_agg(t ->> 'collateral_type' || ':' || (t ->> 'status') || ':' || (t ->> 'prompt_key') || ':' || (t ->> 'lender_confirmed'), ' | ' order by t ->> 'collateral_type')
           from jsonb_array_elements(servicing.my_closure(pg_temp.lid('SAMPLE-LN-4')) -> 'security_release_tasks') t),
  'demat_pledge:open:closure.security_release.demat_pledge.lender_to_release:false | mutual_fund_lien:open:closure.security_release.mutual_fund_lien.lender_to_release:false | other:open:closure.security_release.other.lender_to_release:false',
  'with nothing confirmed every prompt says the lender is to release, with the lender-reported status open and lender_confirmed false');
select ok(servicing.my_closure(pg_temp.lid('SAMPLE-LN-4'))::text !~* 'released' and servicing.my_closure(pg_temp.lid('SAMPLE-LN-4'))::text !~* 'confirmed_by_lender',
  'and the closure answer never contains the word released or a confirmed status while nothing is confirmed');
select is((servicing.my_closure(pg_temp.lid('SAMPLE-LN-4')) -> 'security_release_tasks' -> 2 -> 'due_basis' ->> 'rule_key'), 'servicing.security_release_sla_days', 'the due date of a task carries the rule it came from');
select is((servicing.my_closure(pg_temp.lid('SAMPLE-LN-4')) -> 'security_release_tasks' -> 2 -> 'due_basis' ->> 'evidence_status'), 'confirmed', 'and its evidence label');
select is(servicing.my_closure(pg_temp.lid('SAMPLE-LN-4')) ->> 'lender_display_name', 'Docs X', 'the prompt names the lender');
select pg_temp.as_user('ea000000-0000-4000-8000-000000000002');
select is(servicing.set_security_release_delay_reason(pg_temp.got('t_mf')::uuid, 'Waiting for the depository to process the lien request'), 'recorded', 'the lender records a delay reason');
select is(pg_temp.err(format($$select servicing.set_security_release_delay_reason(%L, 'too short')$$, pg_temp.got('t_mf'))), '22023|reason_invalid', 'a short reason is refused');
select is(pg_temp.err(format($$select servicing.set_security_release_delay_reason(%L, 'Reference 123456789012 pending at depository')$$, pg_temp.got('t_mf'))), '22023|reason_invalid', 'a reason with a long digit run is refused');
select pg_temp.as_user('ea000000-0000-4000-8000-000000000003');
select is(pg_temp.err(format($$select servicing.set_security_release_delay_reason(%L, 'Waiting for the depository to process the request')$$, pg_temp.got('t_mf'))), '42501|', 'a viewer cannot record a delay reason');
select pg_temp.as_user('ea000000-0000-4000-8000-000000000005');
select is((select t ->> 'delay_reason' from jsonb_array_elements(servicing.my_closure(pg_temp.lid('SAMPLE-LN-4')) -> 'security_release_tasks') t where t ->> 'collateral_type' = 'mutual_fund_lien'),
  'Waiting for the depository to process the lien request', 'the borrower sees the lender-supplied delay reason');
select pg_temp.as_user('ea000000-0000-4000-8000-000000000002');
select is(servicing.confirm_security_release(pg_temp.got('t_mf')::uuid, 'SAMPLE-CONF-LIEN-1'), 'confirmed_by_lender', 'the lender''s operator confirms the release with the lender''s own reference');
select is(pg_temp.err(format($$select servicing.confirm_security_release(%L, 'SAMPLE-CONF-LIEN-2')$$, pg_temp.got('t_mf'))), '55000|already_confirmed', 'a confirmation is final');
select is(pg_temp.err(format($$select servicing.set_security_release_delay_reason(%L, 'Waiting for the depository to process the request')$$, pg_temp.got('t_mf'))), '55000|already_confirmed', 'and no delay reason follows it');
select pg_temp.as_owner();
select is((select (status = 'confirmed_by_lender' and lender_confirmation_ref = 'SAMPLE-CONF-LIEN-1' and confirmed_by = 'ea000000-0000-4000-8000-000000000002' and confirmed_at is not null)::text
           from servicing.security_release_tasks where id = pg_temp.got('t_mf')::uuid), 'true', 'the task records the lender''s person, reference and time');
select is(pg_temp.err(format($$update servicing.security_release_tasks set status = 'open', lender_confirmation_ref = null, confirmed_by = null, confirmed_at = null where id = %L$$, pg_temp.got('t_mf'))), 'P0001|task_final', 'a confirmed task cannot be reopened');
select is(pg_temp.err(format($$delete from servicing.security_release_tasks where id = %L$$, pg_temp.got('t_mf'))), 'P0001|Record a compensating entry instead.', 'nor deleted');
select is((select count(*) from audit.events where action = 'servicing.security_release.confirmed' and entity_id = pg_temp.got('t_mf') and metadata::text !~ 'SAMPLE-CONF'), 1::bigint, 'the confirmation is audited without the reference');
select pg_temp.as_user('ea000000-0000-4000-8000-000000000005');
select is((select t ->> 'collateral_type' || ':' || (t ->> 'status') || ':' || (t ->> 'prompt_key') || ':' || (t ->> 'lender_confirmed')
           from jsonb_array_elements(servicing.my_closure(pg_temp.lid('SAMPLE-LN-4')) -> 'security_release_tasks') t where t ->> 'collateral_type' = 'mutual_fund_lien'),
  'mutual_fund_lien:confirmed_by_lender:closure.security_release.mutual_fund_lien.lender_confirmed:true', 'after the lender''s confirmation the prompt says the lender confirmed it');
select is((select t ->> 'prompt_key' from jsonb_array_elements(servicing.my_closure(pg_temp.lid('SAMPLE-LN-4')) -> 'security_release_tasks') t where t ->> 'collateral_type' = 'demat_pledge'),
  'closure.security_release.demat_pledge.lender_to_release', 'the other tasks are untouched');
select pg_temp.as_user('ea000000-0000-4000-8000-000000000006');
select is(pg_temp.err(format($$select servicing.my_closure(%L)$$, pg_temp.lid('SAMPLE-LN-4'))), 'P0002|', 'another borrower cannot see the release status');

-- ============================================================================================================================
-- 8. Isolation on every table: lenders, borrowers, platform, anon, direct writes
-- ============================================================================================================================
select pg_temp.as_owner();
insert into servicing.document_requests (lender_org_id, loan_account_id, kind, requested_by, idempotency_key)
values ('eab00000-0000-4000-8000-000000000002', pg_temp.lid('SAMPLE-LN-3'), 'noc', 'ea000000-0000-4000-8000-000000000005', 'y-open-key-00000001');
insert into servicing.loan_documents (lender_org_id, loan_account_id, kind, lender_reference, issued_at, storage_key, sha256, size_bytes, source, uploaded_by)
values ('eab00000-0000-4000-8000-000000000002', pg_temp.lid('SAMPLE-LN-3'), 'noc', 'SAMPLE-Y-NOC', now() - interval '1 day', pg_temp.sk('y-noc'), pg_temp.sha('y-noc'), 1000, 'lender_upload', 'ea000000-0000-4000-8000-000000000004');
select pg_temp.as_user('ea000000-0000-4000-8000-000000000004');
select is((select string_agg(t || '=' || n, ',' order by t) from (
    select 'closure_records' t, count(*) filter (where lender_org_id <> 'eab00000-0000-4000-8000-000000000002')::text n from servicing.closure_records union all
    select 'document_requests', count(*) filter (where lender_org_id <> 'eab00000-0000-4000-8000-000000000002')::text from servicing.document_requests union all
    select 'foreclosure_quotes', count(*) filter (where lender_org_id <> 'eab00000-0000-4000-8000-000000000002')::text from servicing.foreclosure_quotes union all
    select 'loan_document_access', count(*) filter (where lender_org_id <> 'eab00000-0000-4000-8000-000000000002')::text from servicing.loan_document_access union all
    select 'loan_documents', count(*) filter (where lender_org_id <> 'eab00000-0000-4000-8000-000000000002')::text from servicing.loan_documents union all
    select 'security_release_tasks', count(*) filter (where lender_org_id <> 'eab00000-0000-4000-8000-000000000002')::text from servicing.security_release_tasks) x),
  'closure_records=0,document_requests=0,foreclosure_quotes=0,loan_document_access=0,loan_documents=0,security_release_tasks=0',
  'a user of lender Y reads no row of lender X in any of the six tables');
select is((select count(*) from servicing.document_requests) + (select count(*) from servicing.loan_documents), 3::bigint, 'and reads its own rows (two requests, one document)');
select pg_temp.as_user('ea000000-0000-4000-8000-000000000003');
select is((select string_agg(t || '=' || n, ',' order by t) from (
    select 'closure_records' t, count(*) filter (where lender_org_id <> 'eab00000-0000-4000-8000-000000000001')::text n from servicing.closure_records union all
    select 'document_requests', count(*) filter (where lender_org_id <> 'eab00000-0000-4000-8000-000000000001')::text from servicing.document_requests union all
    select 'foreclosure_quotes', count(*) filter (where lender_org_id <> 'eab00000-0000-4000-8000-000000000001')::text from servicing.foreclosure_quotes union all
    select 'loan_document_access', count(*) filter (where lender_org_id <> 'eab00000-0000-4000-8000-000000000001')::text from servicing.loan_document_access union all
    select 'loan_documents', count(*) filter (where lender_org_id <> 'eab00000-0000-4000-8000-000000000001')::text from servicing.loan_documents union all
    select 'security_release_tasks', count(*) filter (where lender_org_id <> 'eab00000-0000-4000-8000-000000000001')::text from servicing.security_release_tasks) x),
  'closure_records=0,document_requests=0,foreclosure_quotes=0,loan_document_access=0,loan_documents=0,security_release_tasks=0',
  'and a user of lender X reads no row of lenders Y or Z');
select is((select count(*) from servicing.security_release_tasks), 3::bigint, 'lender X''s viewer reads the three release tasks of its own loan');
select pg_temp.as_user('ea000000-0000-4000-8000-000000000005');
select is((select string_agg(t || '=' || pg_temp.err(format('select count(*) from servicing.%I', t)) || '/' || (case t
              when 'closure_records' then (select count(*) from servicing.closure_records) when 'document_requests' then (select count(*) from servicing.document_requests)
              when 'foreclosure_quotes' then (select count(*) from servicing.foreclosure_quotes) when 'loan_document_access' then (select count(*) from servicing.loan_document_access)
              when 'loan_documents' then (select count(*) from servicing.loan_documents) else (select count(*) from servicing.security_release_tasks) end)::text, ',' order by t)
           from unnest(array['closure_records', 'document_requests', 'foreclosure_quotes', 'loan_document_access', 'loan_documents', 'security_release_tasks']) t),
  'closure_records=ok/0,document_requests=ok/0,foreclosure_quotes=ok/0,loan_document_access=ok/0,loan_documents=ok/0,security_release_tasks=ok/0',
  'a borrower reads no row of any of the six tables (borrowers use the functions only)');
select pg_temp.as_user('ea000000-0000-4000-8000-000000000001');
select is((select count(*) from servicing.closure_records) + (select count(*) from servicing.document_requests) + (select count(*) from servicing.foreclosure_quotes)
          + (select count(*) from servicing.loan_document_access) + (select count(*) from servicing.loan_documents) + (select count(*) from servicing.security_release_tasks), 0::bigint,
  'platform staff without loan.read read nothing');
select pg_temp.as_anon();
select is((select string_agg(t || '=' || pg_temp.st(format('select count(*) from servicing.%I', t)), ',' order by t)
           from unnest(array['closure_records', 'document_requests', 'foreclosure_quotes', 'loan_document_access', 'loan_documents', 'security_release_tasks']) t),
  'closure_records=42501,document_requests=42501,foreclosure_quotes=42501,loan_document_access=42501,loan_documents=42501,security_release_tasks=42501', 'anon is refused on all six');
select pg_temp.as_user('ea000000-0000-4000-8000-000000000002');
select is((select string_agg(t || '=' || pg_temp.st(format('insert into servicing.%I default values', t)) || '/' || pg_temp.st(format('update servicing.%I set id = id', t)) || '/' || pg_temp.st(format('delete from servicing.%I', t)), ',' order by t)
           from unnest(array['closure_records', 'document_requests', 'foreclosure_quotes', 'loan_document_access', 'loan_documents', 'security_release_tasks']) t),
  'closure_records=42501/42501/42501,document_requests=42501/42501/42501,foreclosure_quotes=42501/42501/42501,loan_document_access=42501/42501/42501,loan_documents=42501/42501/42501,security_release_tasks=42501/42501/42501',
  'a lender operator, even with the permission, cannot insert, update or delete any of the six tables directly');
select pg_temp.as_system();
select is((select string_agg(t || '=' || pg_temp.st(format('insert into servicing.%I default values', t)) || '/' || pg_temp.st(format('update servicing.%I set id = id', t)) || '/' || pg_temp.st(format('delete from servicing.%I', t)), ',' order by t)
           from unnest(array['closure_records', 'document_requests', 'foreclosure_quotes', 'loan_document_access', 'loan_documents', 'security_release_tasks']) t),
  'closure_records=42501/42501/42501,document_requests=42501/42501/42501,foreclosure_quotes=42501/42501/42501,loan_document_access=42501/42501/42501,loan_documents=42501/42501/42501,security_release_tasks=42501/42501/42501',
  'nor can the system role: every write goes through a function');
select pg_temp.as_owner();
-- Composite tenant keys: a row cannot name a lender other than the loan's, whoever writes it.
select is((select string_agg(k || '=' || pg_temp.st(q), ',' order by k) from (values
  ('document_requests', format($$insert into servicing.document_requests (lender_org_id, loan_account_id, kind, requested_by, idempotency_key)
      values ('eab00000-0000-4000-8000-000000000002', %L, 'statement', 'ea000000-0000-4000-8000-000000000005', 'tenant-key-00000001')$$, pg_temp.lid('SAMPLE-LN-2'))),
  ('foreclosure_quotes', format($$insert into servicing.foreclosure_quotes (lender_org_id, loan_account_id, lender_quote_ref, as_of, valid_until, principal_minor, interest_minor, charges_minor, prepayment_charge_minor, total_minor, source, reported_by)
      values ('eab00000-0000-4000-8000-000000000002', %L, 'SAMPLE-Q-TENANT', now() - interval '1 hour', now() + interval '1 hour', 1, 0, 0, 0, 1, 'lender_portal', 'ea000000-0000-4000-8000-000000000004')$$, pg_temp.lid('SAMPLE-LN-2'))),
  ('loan_documents', format($$insert into servicing.loan_documents (lender_org_id, loan_account_id, kind, lender_reference, issued_at, storage_key, sha256, size_bytes, source, uploaded_by)
      values ('eab00000-0000-4000-8000-000000000002', %L, 'noc', 'SAMPLE-TENANT', now() - interval '1 hour', %L, %L, 10, 'lender_upload', 'ea000000-0000-4000-8000-000000000004')$$, pg_temp.lid('SAMPLE-LN-2'), pg_temp.sk('tenant'), pg_temp.sha('tenant'))),
  ('closure_records', format($$insert into servicing.closure_records (lender_org_id, loan_account_id, closure_kind) values ('eab00000-0000-4000-8000-000000000002', %L, 'closed')$$, pg_temp.lid('SAMPLE-LN-2'))),
  ('loan_document_access', format($$insert into servicing.loan_document_access (document_id, lender_org_id, actor_type, actor_user_id, purpose)
      values (%L, 'eab00000-0000-4000-8000-000000000002', 'lender', 'ea000000-0000-4000-8000-000000000004', 'view')$$, pg_temp.got('d1')))) as v (k, q)),
  'closure_records=23503,document_requests=23503,foreclosure_quotes=23503,loan_document_access=23503,loan_documents=23503',
  'a row cannot name a lender other than the loan''s lender (composite tenant keys), even for the table owner');
select is((select count(*) from servicing.closure_records where lender_org_id <> (select lender_org_id from servicing.loan_accounts la where la.id = closure_records.loan_account_id)), 0::bigint,
  'every closure record belongs to the lender of its loan');
select is((select count(*) from servicing.document_requests r join servicing.loan_accounts la on la.id = r.loan_account_id where la.lender_org_id <> r.lender_org_id), 0::bigint, 'and so does every request');
select finish();
rollback;
