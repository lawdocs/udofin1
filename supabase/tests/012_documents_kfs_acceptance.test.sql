-- Phase 07: applicability, templates, working-day calendars, KFS data, generation, approval and issuance, versioning,
-- acknowledgement, offer acceptance, agreement, signing boundary, delivery and access evidence.
-- Synthetic data only. The KFS example uses the RBI illustration (RBC Directions 2025, para 29(3)) figures in paise.
begin;
create extension if not exists pgtap with schema extensions;
select plan(178);

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
  return v_state || '|' || coalesce(v_hint, '');
end
$fn$;
create function pg_temp.errs(q text) returns text language plpgsql as $fn$
begin
  execute q;
  return 'ok';
exception when others then
  return sqlstate;
end
$fn$;
create function pg_temp.sstat(p uuid) returns text language sql security definer as $fn$ select status from identity.stepup_challenges where id = p $fn$;
create function pg_temp.keep(k text, v text) returns text language sql as $fn$ select set_config('t.' || k, v, true) $fn$;
create function pg_temp.get(k text) returns text language sql as $fn$ select current_setting('t.' || k) $fn$;

create function pg_temp.make_live(p_lender uuid, p_maker uuid, p_checker uuid, p_category text default 'nbfc_icc') returns void language plpgsql as $fn$
declare
  d1 uuid := gen_random_uuid();
  d2 uuid := gen_random_uuid();
begin
  insert into onboarding.documents (id, lender_org_id, purpose, label, storage_key, sha256, size_bytes, mime_type, uploaded_by) values
    (d1, p_lender, 'registration', 'evidence', 'test/' || replace(d1::text, '-', ''), repeat('a', 64), 1000, 'application/pdf', p_maker),
    (d2, p_lender, 'contract', 'agreement', 'test/' || replace(d2::text, '-', ''), repeat('b', 64), 1000, 'application/pdf', p_maker);
  insert into onboarding.lender_gates (lender_org_id, stage) values (p_lender, 'activated') on conflict (lender_org_id) do update set stage = 'activated';
  insert into onboarding.lender_profiles (lender_org_id, category_key, regulator, registration_no, licence_status, verification_status, verification_evidence_id,
                                          verified_by, verified_at, last_verified_on, created_by)
  values (p_lender, p_category, 'RBI', 'TEST-REG-' || left(p_lender::text, 8), 'active', 'verified', d1, p_checker, now(), current_date, p_maker)
  on conflict (lender_org_id) do nothing;
  insert into onboarding.lender_contracts (lender_org_id, contract_type, reference, executed_on, effective_from, document_id, status, recorded_by, verified_by, verified_at)
  values (p_lender, 'lsp_agreement', 'TEST-LSP-1', current_date, current_date, d2, 'executed', p_maker, p_checker, now());
end
$fn$;

-- The RBI illustration (para 29(3)), in paise. Whole-rupee rounding makes its own schedule differ from its totals by a few
-- rupees, which the lender explains in a rounding note, as the RBI text does.
create function pg_temp.mkkfs(p_amount bigint default 2000000, p_apr integer default 1707) returns jsonb language sql as $fn$
  select jsonb_build_object(
    'schema', 'kfs_data_v1', 'loanType', 'Personal loan (sample)', 'sanctionedAmountMinor', p_amount,
    'disbursal', jsonb_build_object('mode', 'upfront'),
    'loanTerm', jsonb_build_object('value', 24, 'unit', 'months'), 'tenureDays', 720,
    'instalments', jsonb_build_object('type', 'epi', 'frequency', 'monthly', 'count', 24, 'amountMinor', 97000, 'commencementDaysAfterSanction', 30),
    'interest', jsonb_build_object('rateBps', 1500, 'type', 'fixed'),
    'fees', jsonb_build_array(
      jsonb_build_object('category', 'processing', 'label', 'Processing fee', 'payee', 'lender', 'timing', 'one_time', 'amountMinor', 24000),
      jsonb_build_object('category', 'insurance', 'label', 'Insurance (third party)', 'payee', 'third_party', 'timing', 'one_time', 'amountMinor', 16000)),
    'aprBps', p_apr,
    'contingent', jsonb_build_object('penalDelayed', jsonb_build_object('percentBps', 200, 'text', '2% per annum on the overdue amount'),
      'otherPenal', jsonb_build_object('notApplicable', true), 'foreclosure', jsonb_build_object('notApplicable', true), 'switching', jsonb_build_object('notApplicable', true)),
    'computation', jsonb_build_object('totalInterestMinor', 327400, 'feesTotalMinor', 40000, 'feesToLenderMinor', 24000, 'feesToThirdPartyMinor', 16000,
      'netDisbursedMinor', 1960000, 'totalPayableMinor', 2327400, 'scheduleOfDisbursement', 'Single disbursement after signing',
      'roundingNote', 'Instalments are rounded to the nearest rupee.'),
    'schedule', (select jsonb_agg(jsonb_build_object('no', n, 'dueDate', to_char(date '2026-12-01' + (n - 1) * interval '1 month', 'YYYY-MM-DD'),
        'outstandingPrincipalMinor', o * 100, 'principalMinor', pr * 100, 'interestMinor', i * 100, 'instalmentMinor', 97000) order by n)
      from (values (1,20000,720,250),(2,19280,729,241),(3,18552,738,232),(4,17814,747,223),(5,17067,756,213),(6,16310,766,204),(7,15544,775,194),(8,14769,785,185),
        (9,13984,795,175),(10,13189,805,165),(11,12384,815,155),(12,11569,825,145),(13,10744,835,134),(14,9909,846,124),(15,9063,856,113),(16,8206,867,103),
        (17,7339,878,92),(18,6461,889,81),(19,5572,900,70),(20,4672,911,58),(21,3761,923,47),(22,2838,934,35),(23,1904,946,24),(24,958,958,12)) as t (n, o, pr, i)),
    'part2', jsonb_build_object('recoveryAgentClauseRef', 'Clause 14', 'grievanceClauseRef', 'Clause 18', 'nodalOfficerPhone', '+91-00000-00000',
      'nodalOfficerEmail', 'grievance@lender.example', 'transferOrSecuritisation', false, 'digital', jsonb_build_object('coolingOffDays', 3)))
$fn$;
grant execute on all functions in schema pg_temp to public;

-- Users and organisations ---------------------------------------------------------------------------------------------------
insert into auth.users (id, phone, raw_app_meta_data) values
  ('11111111-1111-4111-8111-111111111111', '910000000001', '{}'),
  ('22222222-2222-4222-8222-222222222222', '910000000002', '{}'),
  ('aaaaaaaa-0000-4000-8000-000000000001', null, '{"actor_type":"staff"}'),
  ('aaaaaaaa-0000-4000-8000-000000000002', null, '{"actor_type":"staff"}'),
  ('aaaaaaaa-0000-4000-8000-000000000004', null, '{"actor_type":"staff"}'),
  ('bbbbbbbb-0000-4000-8000-000000000001', null, '{"actor_type":"staff"}'),
  ('bbbbbbbb-0000-4000-8000-000000000002', null, '{"actor_type":"staff"}'),
  ('0e0e0e0e-0000-4000-8000-000000000001', null, '{"actor_type":"staff"}'),
  ('0f0f0f0f-0000-4000-8000-000000000001', null, '{"actor_type":"staff"}'),
  ('d0000000-0000-4000-8000-000000000001', null, '{"actor_type":"staff"}'),
  ('d0000000-0000-4000-8000-000000000002', null, '{"actor_type":"staff"}');

select pg_temp.as_system();
select set_config('udofin.change_apply', 'on', true);
insert into tenancy.organizations (id, kind, legal_name, display_name, regulator_registration_no, status) values
  ('a0000000-0000-4000-8000-000000000000', 'platform', 'Udofin Platform (test)', 'Udofin', null, 'active'),
  ('a1000000-0000-4000-8000-000000000000', 'lender', 'Alpha Finance Ltd (test)', 'Alpha Finance', 'TEST-NBFC-0001', 'active'),
  ('b1000000-0000-4000-8000-000000000000', 'lender', 'Beta Capital Ltd (test)', 'Beta Capital', 'TEST-NBFC-0002', 'active'),
  ('c1000000-0000-4000-8000-000000000000', 'lender', 'Gamma Microfinance Ltd (test)', 'Gamma MFI', 'TEST-NBFC-0003', 'active');
insert into tenancy.memberships (id, org_id, user_id, status) values
  ('a1a10000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000000', 'aaaaaaaa-0000-4000-8000-000000000001', 'active'),
  ('a1a10000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000000', 'aaaaaaaa-0000-4000-8000-000000000002', 'active'),
  ('a1a10000-0000-4000-8000-000000000004', 'a1000000-0000-4000-8000-000000000000', 'aaaaaaaa-0000-4000-8000-000000000004', 'active'),
  ('b1b10000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000000', 'bbbbbbbb-0000-4000-8000-000000000001', 'active'),
  ('b1b10000-0000-4000-8000-000000000002', 'b1000000-0000-4000-8000-000000000000', 'bbbbbbbb-0000-4000-8000-000000000002', 'active'),
  ('a0a00000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000000', '0e0e0e0e-0000-4000-8000-000000000001', 'active'),
  ('a0a00000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000000', '0f0f0f0f-0000-4000-8000-000000000001', 'active');
insert into tenancy.membership_roles (membership_id, role_id)
select m, (select id from tenancy.roles where org_id is null and applies_to = k::tenancy.organization_kind and key = r)
from (values
  ('a1a10000-0000-4000-8000-000000000001'::uuid, 'lender', 'credit_officer'),
  ('a1a10000-0000-4000-8000-000000000002'::uuid, 'lender', 'lender_admin'),
  ('a1a10000-0000-4000-8000-000000000004'::uuid, 'lender', 'viewer'),
  ('b1b10000-0000-4000-8000-000000000001'::uuid, 'lender', 'credit_officer'),
  ('b1b10000-0000-4000-8000-000000000002'::uuid, 'lender', 'lender_admin'),
  ('a0a00000-0000-4000-8000-000000000001'::uuid, 'platform', 'platform_admin'),
  ('a0a00000-0000-4000-8000-000000000002'::uuid, 'platform', 'platform_admin')
) as g (m, k, r);
insert into tenancy.memberships (org_id, user_id, status)
select o.id, u, 'active' from tenancy.organizations o, (values ('d0000000-0000-4000-8000-000000000001'::uuid), ('d0000000-0000-4000-8000-000000000002')) x (u) where o.kind = 'lender';
insert into tenancy.membership_roles (membership_id, role_id)
select m.id, (select id from tenancy.roles where org_id is null and applies_to = 'lender' and key = case m.user_id when 'd0000000-0000-4000-8000-000000000001' then 'lender_admin' else 'product_approver' end)
from tenancy.memberships m where m.user_id in ('d0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000002');

insert into lending.loan_products (id, lender_org_id, category_key, code, name, status)
select md5('prod' || l::text)::uuid, l, 'personal', 'PL-STD', n, 'active'
from (values ('a1000000-0000-4000-8000-000000000000'::uuid, 'Alpha Personal Loan'), ('b1000000-0000-4000-8000-000000000000', 'Beta Personal Loan'),
             ('c1000000-0000-4000-8000-000000000000', 'Gamma Personal Loan')) as t (l, n);
insert into lending.loan_product_versions (id, product_id, lender_org_id, version, status, min_amount_minor, max_amount_minor, min_tenure_days, max_tenure_days,
  rate_type, min_annual_rate_bps, max_annual_rate_bps, drafted_by, approved_by, approved_at, effective_from)
select md5('ver' || p.lender_org_id::text)::uuid, p.id, p.lender_org_id, 1, 'approved', 1000000, 50000000, 180, 1825,
       'fixed', 1400, 2400, 'd0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000002', now(), now()
from lending.loan_products p;
select pg_temp.make_live('a1000000-0000-4000-8000-000000000000', 'aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000001');
select pg_temp.make_live('b1000000-0000-4000-8000-000000000000', 'aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000001');
select pg_temp.make_live('c1000000-0000-4000-8000-000000000000', 'aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000001', 'nbfc_mfi');
insert into lending.lender_connectors (lender_org_id, kind, status, kfs_allowed_hosts) values
  ('a1000000-0000-4000-8000-000000000000', 'manual', 'active', array['kfs.alpha.example']),
  ('b1000000-0000-4000-8000-000000000000', 'manual', 'active', array['kfs.beta.example']),
  ('c1000000-0000-4000-8000-000000000000', 'manual', 'active', array['kfs.gamma.example']);

-- Consent wording and the acknowledgement wording (platform level; Hindi is not approved) ---------------------------------------------------
insert into consent.notices (id, purpose, version, language, lender_org_id, title, body_markdown, status, published_at, drafted_by, approved_by, review_status) values
  ('f1000000-0000-4000-8000-00000000000a', 'share_with_lender', 1, 'en', 'a1000000-0000-4000-8000-000000000000', 'Share with Alpha', 'Alpha wording v1', 'published', now(), 'aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000001', 'approved'),
  ('f1000000-0000-4000-8000-00000000000b', 'share_with_lender', 1, 'en', 'b1000000-0000-4000-8000-000000000000', 'Share with Beta', 'Beta wording v1', 'published', now(), 'aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000001', 'approved'),
  ('f3000000-0000-4000-8000-000000000001', 'kfs_acknowledgement', 1, 'en', null, 'Key Facts Statement acknowledgement (SAMPLE WORDING)', 'SAMPLE: I have read the Key Facts Statement and its contents were explained to me; I understand them.', 'published', now(), 'aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000001', 'approved'),
  ('f3000000-0000-4000-8000-000000000002', 'kfs_acknowledgement', 1, 'hi', null, 'KFS acknowledgement (Hindi, unreviewed)', 'अनुवाद समीक्षा के लिए लंबित', 'published', now(), 'aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000001', 'requires_review');

-- Requests, applications and offers (as the Phase 06 flow leaves them: approved by the lender, one issued offer) ------------------------------------
insert into lending.loan_requests (id, borrower_id, category_key, requested_amount_minor, requested_tenure_days, purpose_code, status, submission_reference)
select ('70000000-0000-4000-8000-00000000000' || n)::uuid, (select id from identity.borrowers where user_id = u::uuid), 'personal', 2000000, 720, 'home_renovation', 'submitted', 'UR-BBBBBBBBB' || n
from (values (1, '11111111-1111-4111-8111-111111111111'), (2, '22222222-2222-4222-8222-222222222222')) as x (n, u);
insert into lending.applications (id, lender_org_id, loan_request_id, borrower_id, product_version_id, status, requested_amount_minor, requested_tenure_days)
select a, l, r, (select borrower_id from lending.loan_requests where id = r), md5('ver' || l::text)::uuid, 'submitted', 2000000, 720
from (values ('a2000000-0000-4000-8000-000000000001'::uuid, 'a1000000-0000-4000-8000-000000000000'::uuid, '70000000-0000-4000-8000-000000000001'::uuid),
             ('a2000000-0000-4000-8000-000000000002', 'b1000000-0000-4000-8000-000000000000', '70000000-0000-4000-8000-000000000001'),
             ('a2000000-0000-4000-8000-000000000003', 'a1000000-0000-4000-8000-000000000000', '70000000-0000-4000-8000-000000000002'),
             ('a2000000-0000-4000-8000-000000000004', 'c1000000-0000-4000-8000-000000000000', '70000000-0000-4000-8000-000000000002')) as t (a, l, r);
update lending.applications set status = 'under_review' where id::text like 'a2000000%';
update lending.applications set status = 'approved' where id::text like 'a2000000%';
-- Each borrower consented to the lenders of their applications (same evidence the routing function writes).
insert into consent.records (borrower_id, notice_id, lender_org_id, decision, channel, app_version, evidence)
select a.borrower_id, case a.lender_org_id when 'a1000000-0000-4000-8000-000000000000' then 'f1000000-0000-4000-8000-00000000000a'::uuid else 'f1000000-0000-4000-8000-00000000000b'::uuid end,
       a.lender_org_id, 'granted', 'mobile_app', '1.0.0', jsonb_build_object('loan_request_id', a.loan_request_id, 'scope', 'minimum_payload_v1')
from lending.applications a where a.id::text like 'a2000000%' and a.lender_org_id <> 'c1000000-0000-4000-8000-000000000000';
insert into lending.offers (id, lender_org_id, application_id, status, principal_minor, tenure_days, installment_frequency, installment_count, installment_amount_minor,
  annual_interest_rate_bps, apr_bps, processing_fee_minor, other_charges, total_repayable_minor, penal_charges_summary, valid_until, monthly_repayment_minor,
  kfs_url, lender_offer_ref, revision, lender_issued_at, source)
select ('0f000000-0000-4000-8000-00000000000' || n)::uuid, l, a, 'issued', 2000000, 720, 'monthly', 24, 97000, 1500, 1707, 24000, '[]', 2327400,
       '2% per annum on the overdue amount', now() + interval '30 days', 97000, 'https://kfs.alpha.example/k/' || n, 'OFFER-' || n, 1, now(), 'manual'
from (values (1, 'a1000000-0000-4000-8000-000000000000'::uuid, 'a2000000-0000-4000-8000-000000000001'::uuid),
             (2, 'b1000000-0000-4000-8000-000000000000', 'a2000000-0000-4000-8000-000000000002'),
             (3, 'a1000000-0000-4000-8000-000000000000', 'a2000000-0000-4000-8000-000000000003')) as t (n, l, a);

-- A. Applicability: nothing is usable until counsel's rule is approved; no rule exists for other lender types ---------------------------------------
select pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001');
select is((select count(*) from documents.applicability_rules), 0::bigint, 'a lender cannot read platform rules');
select pg_temp.as_user('0e0e0e0e-0000-4000-8000-000000000001');
select is((select string_agg(rule_key || ':' || approval_status, ',' order by rule_key) from documents.applicability_rules), 'agreement.nbfc.kfs_summary_box:draft,kfs.nbfc.retail_msme_term:draft,servicing.noc_sla_days_default:draft,servicing.security_release_sla_days:draft,servicing.statement_sla_days_default:draft',
  'the seeded rules (NBFC document rules and the Phase 08a servicing SLA rules) are drafts, not approved');
select is((select count(*) from documents.applicability_rules where approval_status = 'approved'), 0::bigint, 'nothing is approved by default');
select is((select reviewer_ref from documents.applicability_rules where rule_key = 'kfs.nbfc.retail_msme_term'), null, 'the reviewer is unassigned');
select is((select lender_category_keys from documents.applicability_rules where rule_key = 'kfs.nbfc.retail_msme_term'), array['nbfc_icc', 'nbfc_d'], 'only NBFC categories are named (no bank, UCB or HFC rule is seeded)');
select is((select count(*) from documents.templates where status = 'approved'), 0::bigint, 'the Annex I layout is a draft template');
select pg_temp.keep('rule_kfs', (select id::text from documents.applicability_rules where rule_key = 'kfs.nbfc.retail_msme_term'));
select pg_temp.keep('rule_agr', (select id::text from documents.applicability_rules where rule_key = 'agreement.nbfc.kfs_summary_box'));
select pg_temp.keep('tpl_kfs', (select id::text from documents.templates where template_key = 'kfs.rbi_annex_i'));

select pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001');
select pg_temp.keep('input0', (documents.submit_kfs_data('0f000000-0000-4000-8000-000000000001', pg_temp.mkkfs()) ->> 'inputId'));
select is(pg_temp.err(format($$select documents.request_generation('0f000000-0000-4000-8000-000000000001', 'en', %L)$$, pg_temp.get('input0'))), '55000|applicability_unresolved', 'a draft rule is never used: preparation stops with applicability_unresolved');
select pg_temp.as_user('0e0e0e0e-0000-4000-8000-000000000001');
select is(pg_temp.err(format($$select documents.decide_rule(%L, true, '')$$, pg_temp.get('rule_kfs'))), '22023|reviewer_required', 'a rule cannot be approved without naming the reviewer');
select is(pg_temp.err(format($$select documents.decide_rule(%L, true, 'Test compliance reviewer')$$, pg_temp.get('rule_kfs'))), 'ok', 'a platform administrator approves it, naming the reviewer');
select is(pg_temp.err(format($$select documents.decide_rule(%L, true, 'Test compliance reviewer')$$, pg_temp.get('rule_agr'))), 'ok', 'the agreement summary-box rule is approved the same way');
select is(pg_temp.errs(format($$update documents.applicability_rules set exclusions = 'changed' where id = %L$$, pg_temp.get('rule_kfs'))), '42501', 'rules cannot be edited by staff directly');
select pg_temp.as_owner();
select is(pg_temp.err(format($$update documents.applicability_rules set exclusions = 'changed' where id = %L$$, pg_temp.get('rule_kfs'))), 'P0001|', 'an approved rule is immutable even for the owner');
select pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001');
select is(pg_temp.err(format($$select documents.request_generation('0f000000-0000-4000-8000-000000000001', 'en', %L)$$, pg_temp.get('input0'))), '55000|template_not_ready', 'with an approved rule but only a draft template, preparation stops with template_not_ready');
select pg_temp.as_user('0e0e0e0e-0000-4000-8000-000000000001');
select is(pg_temp.err(format($$select documents.approve_template_compliance(%L, 'Test compliance reviewer')$$, pg_temp.get('tpl_kfs'))), 'ok', 'compliance approves the regulator-format layout');
select pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001');
select is(pg_temp.err(format($$select documents.request_generation('0f000000-0000-4000-8000-000000000001', 'hi', %L)$$, pg_temp.get('input0'))), '55000|template_not_ready', 'Hindi has no approved template: no automatic translation, no fallback');
select is(pg_temp.err(format($$select documents.request_generation('0f000000-0000-4000-8000-000000000001', 'en', %L)$$, pg_temp.get('input0'))), '55000|calendar_missing', 'without an approved working-day calendar the KFS validity cannot be computed (no calendar days are substituted)');
select pg_temp.as_owner();
select is(pg_temp.err($$insert into documents.templates (template_key, document_type, language, lender_org_id, version, body, is_sample) values ('x.sample', 'kfs', 'en', null, 1, '{"engine":"annex_i_v1"}', true)$$), '42501|sample_blocked', 'a sample template cannot be stored unless the session allows it (tests only)');

-- B. Working-day calendar: approval and the day arithmetic ------------------------------------------------------------------------------------------
select pg_temp.as_user('0e0e0e0e-0000-4000-8000-000000000001');
select pg_temp.keep('cal_fixed', documents.propose_calendar('a1000000-0000-4000-8000-000000000000', 'Fixed test calendar', array[0, 6], date '2026-11-01', date '2027-03-31',
  '[{"day":"2026-11-10","isWorking":false,"reason":"test holiday"}]')::text);
select is(pg_temp.err(format($$select documents.working_day_end(%L, timestamptz '2026-11-06 10:00+05:30', 3)$$, pg_temp.get('cal_fixed'))), '55000|calendar_missing', 'a calendar that is not approved is not used');
select is(pg_temp.err(format($$select documents.decide_calendar(%L, true, 'LENDER-CONF-1')$$, pg_temp.get('cal_fixed'))), '42501|segregation_of_duties', 'the proposer cannot approve the calendar');
select pg_temp.as_user('0f0f0f0f-0000-4000-8000-000000000001');
select is(pg_temp.err(format($$select documents.decide_calendar(%L, true, '')$$, pg_temp.get('cal_fixed'))), '22023|lender_confirmation_required', 'the lender''s confirmation reference is required');
select is(pg_temp.err(format($$select documents.decide_calendar(%L, true, 'LENDER-CONF-1')$$, pg_temp.get('cal_fixed'))), 'ok', 'a second administrator approves it with the lender''s confirmation reference');
select is(to_char(documents.working_day_end(pg_temp.get('cal_fixed')::uuid, timestamptz '2026-11-06 10:00+05:30', 3) at time zone 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI:SS'), '2026-11-12 23:59:59',
  'three working days after Friday 6 Nov skip the weekend and the holiday on the 10th: Thursday 12 Nov, end of day India time');
select is(to_char(documents.working_day_end(pg_temp.get('cal_fixed')::uuid, timestamptz '2026-11-06 23:30+05:30', 1) at time zone 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI:SS'), '2026-11-09 23:59:59',
  'one working day after a Friday night is Monday');
select is(to_char(documents.working_day_end(pg_temp.get('cal_fixed')::uuid, timestamptz '2026-11-06 19:00+00', 1) at time zone 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI:SS'), '2026-11-09 23:59:59',
  '19:00 UTC on Friday is already Saturday in India, so the count starts from Saturday');
select is(pg_temp.err(format($$select documents.working_day_end(%L, timestamptz '2027-03-30 10:00+05:30', 3)$$, pg_temp.get('cal_fixed'))), '55000|calendar_incomplete', 'a calendar that does not cover the whole span is refused, not guessed');
select is(pg_temp.err(format($$select documents.working_day_end(%L, timestamptz '2026-11-06 10:00+05:30', 0)$$, pg_temp.get('cal_fixed'))), '22023|', 'zero days is invalid');

-- The calendars used by the lenders (cover today and the next four months)
select pg_temp.as_user('0e0e0e0e-0000-4000-8000-000000000001');
select pg_temp.keep('cal_a', documents.propose_calendar('a1000000-0000-4000-8000-000000000000', 'Alpha calendar', array[0, 6], current_date - 5, current_date + 120, '[]')::text);
select pg_temp.keep('cal_b', documents.propose_calendar('b1000000-0000-4000-8000-000000000000', 'Beta calendar', array[0, 6], current_date - 5, current_date + 120, '[]')::text);
select pg_temp.keep('cal_c', documents.propose_calendar('c1000000-0000-4000-8000-000000000000', 'Gamma calendar', array[0, 6], current_date - 5, current_date + 120, '[]')::text);
select pg_temp.as_user('0f0f0f0f-0000-4000-8000-000000000001');
select documents.decide_calendar(pg_temp.get('cal_a')::uuid, true, 'ALPHA-CAL-CONF');
select documents.decide_calendar(pg_temp.get('cal_b')::uuid, true, 'BETA-CAL-CONF');
select documents.decide_calendar(pg_temp.get('cal_c')::uuid, true, 'GAMMA-CAL-CONF');

-- C. KFS data: structural checks only; the lender's figures are never altered ---------------------------------------------------------------------------
select pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000004');
select is(pg_temp.err($$select documents.submit_kfs_data('0f000000-0000-4000-8000-000000000001', '{}')$$), '42501|', 'a read-only lender user cannot submit KFS data');
select pg_temp.as_user('bbbbbbbb-0000-4000-8000-000000000001');
select is(pg_temp.err($$select documents.submit_kfs_data('0f000000-0000-4000-8000-000000000001', '{}')$$), 'P0002|', 'another lender cannot see or submit for this offer');
select pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001', 'aal1');
select is(pg_temp.err($$select documents.submit_kfs_data('0f000000-0000-4000-8000-000000000001', '{}')$$) like '42501|%', true, 'submitting needs a second factor');
select pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001');
select is(documents.submit_kfs_data('0f000000-0000-4000-8000-000000000001', '{"schema":"other"}') -> 'issues', '["schema_wrong"]'::jsonb, 'an unknown schema is held');
select is(documents.submit_kfs_data('0f000000-0000-4000-8000-000000000001', pg_temp.mkkfs() - 'aprBps') -> 'issues', '["apr_missing"]'::jsonb, 'a missing APR is held, not filled in');
select is(documents.submit_kfs_data('0f000000-0000-4000-8000-000000000001', pg_temp.mkkfs(2000000, 1800)) -> 'issues', '["apr_mismatch_offer"]'::jsonb, 'an APR that differs from the offer is flagged for the lender, never corrected');
select is(documents.submit_kfs_data('0f000000-0000-4000-8000-000000000001', pg_temp.mkkfs(2100000, 1707)) ->> 'validation', 'held', 'a sanctioned amount that differs from the offer is held');
select is(documents.submit_kfs_data('0f000000-0000-4000-8000-000000000001', pg_temp.mkkfs() - 'schedule') -> 'issues', '["schedule_missing"]'::jsonb, 'a missing repayment schedule is held, not fabricated');
select is(documents.submit_kfs_data('0f000000-0000-4000-8000-000000000001', jsonb_set(pg_temp.mkkfs(), '{schedule,3,dueDate}', '"2027-02-30"')) -> 'issues', '["schedule_date_invalid"]'::jsonb, 'an impossible date is held');
select is(documents.submit_kfs_data('0f000000-0000-4000-8000-000000000001', pg_temp.mkkfs() - 'part2') -> 'issues', '["part2_incomplete"]'::jsonb, 'missing qualitative information (Part 2) is held');
select is(documents.submit_kfs_data('0f000000-0000-4000-8000-000000000001', jsonb_set(pg_temp.mkkfs(), '{fees,0}', '{"category":"processing","label":"x","payee":"lender","timing":"one_time","amountMinor":24000,"percentBps":100}'))
  -> 'issues' ? 'fee_invalid', true, 'a fee with both an amount and a percentage is held');
select is(documents.submit_kfs_data('0f000000-0000-4000-8000-000000000001', jsonb_set(pg_temp.mkkfs(), '{interest,type}', '"floating"')) -> 'issues', '["floating_table_incomplete"]'::jsonb, 'a floating rate needs the reference-benchmark table');
select is(documents.submit_kfs_data('0f000000-0000-4000-8000-000000000001', pg_temp.mkkfs() || '{"extra":1}') -> 'issues', '["unknown_field"]'::jsonb, 'fields outside the approved structure are flagged');
select is(documents.submit_kfs_data('0f000000-0000-4000-8000-000000000001', jsonb_set(pg_temp.mkkfs(), '{computation,roundingNote}', 'null') #- '{computation,roundingNote}') -> 'issues', '["schedule_balance_broken", "schedule_row_inconsistent", "schedule_principal_sum_mismatch", "schedule_interest_sum_mismatch"]'::jsonb
  , 'without the lender''s rounding note the RBI illustration''s own rounding differences are reported (flagged, never repaired)');
select pg_temp.keep('input1', documents.submit_kfs_data('0f000000-0000-4000-8000-000000000001', pg_temp.mkkfs()) ->> 'inputId');
select is((select validation from documents.kfs_inputs where id = pg_temp.get('input1')::uuid), 'accepted', 'the RBI illustration, with the lender''s rounding note, is accepted');
select is((select data = pg_temp.mkkfs() from documents.kfs_inputs where id = pg_temp.get('input1')::uuid), true, 'the stored data is exactly what the lender sent');
select is((select (principal_minor, apr_bps, installment_amount_minor, total_repayable_minor)::text from lending.offers where id = '0f000000-0000-4000-8000-000000000001'), '(2000000,1707,97000,2327400)', 'the offer values are untouched');
select is(pg_temp.errs($$update documents.kfs_inputs set data = '{}'$$), '42501', 'KFS data cannot be edited');
select pg_temp.as_owner();
select is(pg_temp.err($$update documents.kfs_inputs set data = '{}'$$), 'P0001|Record a compensating entry instead.', 'nor by the owner (append-only)');

-- D. Generation (the worker's three steps) -----------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001');
select pg_temp.keep('job1', documents.request_generation('0f000000-0000-4000-8000-000000000001', 'en', pg_temp.get('input1')::uuid) ->> 'jobId');
select is(documents.request_generation('0f000000-0000-4000-8000-000000000001', 'en', pg_temp.get('input1')::uuid) ->> 'jobId', pg_temp.get('job1'), 'requesting the same document again returns the same job (no duplicates)');
select pg_temp.as_owner();
select is((select count(*) from ops.outbox_events where event_type = 'document.generate' and payload ->> 'job_id' = pg_temp.get('job1')), 1::bigint, 'one generation job is queued');
select is((select payload::text ~ '9100000|Alpha|2000000' from ops.outbox_events where event_type = 'document.generate' and payload ->> 'job_id' = pg_temp.get('job1')), false, 'the job carries an identifier only');
select pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001');
select is(pg_temp.errs(format($$select documents.begin_generation(%L)$$, pg_temp.get('job1'))), '42501', 'a lender user cannot run the system step');
select pg_temp.as_system();
select pg_temp.keep('model1', documents.begin_generation(pg_temp.get('job1')::uuid)::text);
select is(pg_temp.get('model1')::jsonb ->> 'documentType', 'kfs', 'the render model names the document type');
select is(pg_temp.get('model1')::jsonb -> 'lender' ->> 'legalName', 'Alpha Finance Ltd (test)', 'and the issuing lender');
select is((pg_temp.get('model1')::jsonb ->> 'proposalNo') ~ '^UDF-[0-9A-F]{12}$', true, 'a unique proposal number is allocated');
select is(pg_temp.get('model1')::jsonb -> 'data' = pg_temp.mkkfs(), true, 'the render model carries the lender''s data unchanged');
select is(pg_temp.get('model1')::jsonb ->> 'contentDigest', (select content_sha256 from documents.kfs_inputs where id = pg_temp.get('input1')::uuid), 'and its digest');
select is((pg_temp.get('model1')::jsonb -> 'validity' ->> 'minWorkingDays')::integer, 3, 'a tenor of seven days or more gives three working days');
select is(((pg_temp.get('model1')::jsonb -> 'validity' ->> 'until')::timestamptz) = documents.working_day_end(pg_temp.get('cal_a')::uuid, (pg_temp.get('model1')::jsonb -> 'validity' ->> 'issueDeadline')::timestamptz, 3), true,
  'the stamped KFS validity is computed from the issue deadline in the lender''s approved calendar');
select is(((pg_temp.get('model1')::jsonb -> 'validity' ->> 'until')::timestamptz) < (select valid_until from lending.offers where id = '0f000000-0000-4000-8000-000000000001'), true, 'KFS validity and offer validity are separate; the offer window covers the KFS window');
select is((pg_temp.get('model1')::jsonb -> 'validity' ->> 'until')::timestamptz <> (select valid_until from lending.offers where id = '0f000000-0000-4000-8000-000000000001'), true, 'they are different values');
select pg_temp.keep('doc1', documents.complete_generation(pg_temp.get('job1')::uuid, 'kfs/test/' || replace(pg_temp.get('job1'), '-', ''), repeat('1', 64), 12345)::text);
select is(documents.complete_generation(pg_temp.get('job1')::uuid, 'kfs/test/other', repeat('2', 64), 1)::text, pg_temp.get('doc1'), 'completing again returns the same document (no duplicate)');
select is(documents.begin_generation(pg_temp.get('job1')::uuid) ->> 'done', 'true', 'a finished job is not run twice');
select pg_temp.as_owner();
select is((select (approval_status, issuance_status, version, source_mode)::text from documents.items where id = pg_temp.get('doc1')::uuid), '(draft,not_issued,1,generated)', 'the document starts as an unapproved draft');
select is((select proposal_no from documents.items where id = pg_temp.get('doc1')::uuid), pg_temp.get('model1')::jsonb ->> 'proposalNo', 'and carries the allocated proposal number');
select is((select (select count(*) from documents.proposals where offer_id = '0f000000-0000-4000-8000-000000000001')), 1::bigint, 'one proposal number per offer');
select is(pg_temp.err(format($$update documents.items set sha256 = %L where id = %L$$, repeat('9', 64), pg_temp.get('doc1'))), 'P0001|document_immutable', 'the stored file hash cannot be changed');
select is(pg_temp.err(format($$update documents.items set issuance_status = 'issued' where id = %L$$, pg_temp.get('doc1'))) like 'P0001|%', true, 'a draft cannot be issued without lender approval');
select is(pg_temp.err(format($$delete from documents.items where id = %L$$, pg_temp.get('doc1'))), 'P0001|Record a compensating entry instead.', 'documents cannot be deleted');
-- Failure and retry: a failed attempt changes nothing else, and the retry re-uses the same job

-- E. Approval and issuance: only the lender, only the exact file, never the preparer alone ------------------------------------------------------------------
select pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001');
select is(pg_temp.err(format($$select documents.approve_document(%L, %L)$$, pg_temp.get('doc1'), repeat('1', 64))), '42501|segregation_of_duties', 'the person who prepared a document cannot approve it');
select pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000004');
select is(pg_temp.err(format($$select documents.approve_document(%L, %L)$$, pg_temp.get('doc1'), repeat('1', 64))), '42501|', 'a viewer cannot approve');
select pg_temp.as_user('bbbbbbbb-0000-4000-8000-000000000002');
select is(pg_temp.err(format($$select documents.approve_document(%L, %L)$$, pg_temp.get('doc1'), repeat('1', 64))), 'P0002|', 'another lender cannot approve it');
select pg_temp.as_owner();
select pg_temp.keep('orig_submitter', (select ki.submitted_by::text from documents.kfs_inputs ki join documents.items i on i.kfs_input_id = ki.id where i.id = pg_temp.get('doc1')::uuid));
alter table documents.kfs_inputs disable trigger user;
update documents.kfs_inputs ki set submitted_by = 'aaaaaaaa-0000-4000-8000-000000000002' from documents.items i where i.kfs_input_id = ki.id and i.id = pg_temp.get('doc1')::uuid;
alter table documents.kfs_inputs enable trigger user;
select pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000002');
select is(pg_temp.err(format($$select documents.approve_document(%L, %L)$$, pg_temp.get('doc1'), repeat('1', 64))), '42501|segregation_of_duties', 'the person who typed the figures cannot approve the document either, even if someone else pressed generate');
select pg_temp.as_owner();
alter table documents.kfs_inputs disable trigger user;
update documents.kfs_inputs ki set submitted_by = pg_temp.get('orig_submitter')::uuid from documents.items i where i.kfs_input_id = ki.id and i.id = pg_temp.get('doc1')::uuid;
alter table documents.kfs_inputs enable trigger user;
select pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000002');
select is(pg_temp.err(format($$select documents.issue_document(%L)$$, pg_temp.get('doc1'))), '55000|approval_required', 'nothing is issued before lender approval');
select is(pg_temp.err(format($$select documents.approve_document(%L, %L)$$, pg_temp.get('doc1'), repeat('0', 64))), '55000|hash_mismatch', 'approval names the exact file reviewed; another hash is refused');
select is(pg_temp.err(format($$select documents.approve_document(%L, %L)$$, pg_temp.get('doc1'), repeat('1', 64))), 'ok', 'a second lender user approves the exact file');
select is(pg_temp.err(format($$select documents.approve_document(%L, %L)$$, pg_temp.get('doc1'), repeat('1', 64))), '55000|already_decided', 'a document is approved once');
select is(pg_temp.err(format($$select documents.issue_document(%L)$$, pg_temp.get('doc1'))), 'ok', 'the lender issues it');
select pg_temp.as_owner();
select is((select (approval_status, issuance_status)::text from documents.items where id = pg_temp.get('doc1')::uuid), '(lender_approved,issued)', 'approved and issued are separate, recorded states');
select is((select count(*) from documents.deliveries where document_id = pg_temp.get('doc1')::uuid and channel = 'in_app' and status = 'available_in_app'), 1::bigint, 'issuing makes it available in the borrower''s app (not "delivered by message")');
select is((select string_agg(event, ',' order by occurred_at) from documents.item_events where document_id = pg_temp.get('doc1')::uuid), 'generated,lender_approved,issued', 'the history records each step');
select is(pg_temp.err(format($$update documents.items set approved_sha256 = %L where id = %L$$, repeat('3', 64), pg_temp.get('doc1'))) ~ '^(P0001|23514)', true, 'the approved hash cannot be changed after the fact');

-- F. Borrower access: own issued documents only; drafts are invisible; every open is logged ------------------------------------------------------------------
select pg_temp.as_user('22222222-2222-4222-8222-222222222222');
select is((select count(*) from documents.items), 0::bigint, 'another borrower sees no documents');
select is(pg_temp.err(format($$select documents.open_document(%L, 'view')$$, pg_temp.get('doc1'))), 'P0002|', 'and cannot open this one');
select is(pg_temp.err(format($$select documents.kfs_view(%L, 'en')$$, pg_temp.get('doc1'))), 'P0002|', 'nor read its content');
select pg_temp.as_user('bbbbbbbb-0000-4000-8000-000000000001');
select is(pg_temp.err(format($$select documents.open_document(%L, 'view')$$, pg_temp.get('doc1'))), 'P0002|', 'another lender cannot open it');
select is((select count(*) from documents.items), 0::bigint, 'nor see it');
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
select is(jsonb_array_length(documents.application_documents('a2000000-0000-4000-8000-000000000001') -> 'documents'), 1, 'the borrower sees the issued KFS for their application');
select is(documents.application_documents('a2000000-0000-4000-8000-000000000001') -> 'kfs' ->> 'proposalNo', (select proposal_no from documents.items where id = pg_temp.get('doc1')::uuid), 'with its proposal number');
select is(pg_temp.err(format($$select documents.acknowledge(%L, 'f3000000-0000-4000-8000-000000000001', array['part1','apr_sheet','schedule','part2'], 'checkbox_and_button', 'v1', 'mobile_app', '1.0.0', 'ack-1')$$, pg_temp.get('doc1'))),
  '55000|document_not_opened', 'a borrower who has not opened the file cannot acknowledge it');
select is(documents.open_document(pg_temp.get('doc1')::uuid, 'view') ->> 'storageKey', 'kfs/test/' || replace(pg_temp.get('job1'), '-', ''), 'opening returns the opaque key for the API to stream');
select is(pg_temp.err($$select documents.open_document(gen_random_uuid(), 'view')$$), 'P0002|', 'an unknown document is not found');
select pg_temp.as_owner();
select is((select count(*) from documents.access_log where document_id = pg_temp.get('doc1')::uuid and actor_type = 'borrower'), 1::bigint, 'the access is recorded');
select is(pg_temp.err(format($$update documents.access_log set purpose = 'download' where document_id = %L$$, pg_temp.get('doc1'))), 'P0001|Record a compensating entry instead.', 'the access log is append-only');
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
select is(documents.kfs_view(pg_temp.get('doc1')::uuid, 'hi') -> 'wording' ->> 'language', 'en', 'Hindi wording is not approved: the English wording is offered, labelled as a fallback');
select is(documents.kfs_view(pg_temp.get('doc1')::uuid, 'hi') -> 'wording' ->> 'languageFallback', 'true', 'and says so');
select is(documents.kfs_view(pg_temp.get('doc1')::uuid, 'en') -> 'data' = pg_temp.mkkfs(), true, 'the readable sections show the lender''s data unchanged');

-- G. Acknowledgement -------------------------------------------------------------------------------------------------------------------------------------------
select is(pg_temp.err(format($$select documents.acknowledge(%L, 'f3000000-0000-4000-8000-000000000001', array['part1'], 'button', 'v1', 'mobile_app', '1.0.0', 'ack-1')$$, pg_temp.get('doc1'))), '55000|sections_not_shown', 'every required section must have been shown');
select is(pg_temp.err(format($$select documents.acknowledge(%L, 'f3000000-0000-4000-8000-000000000001', array['part1','apr_sheet','schedule','part2'], 'navigated', 'v1', 'mobile_app', '1.0.0', 'ack-1')$$, pg_temp.get('doc1'))), '22023|explicit_action_required', 'merely moving on is not an acknowledgement');
select is(pg_temp.err(format($$select documents.acknowledge(%L, 'f3000000-0000-4000-8000-000000000002', array['part1','apr_sheet','schedule','part2'], 'button', 'v1', 'mobile_app', '1.0.0', 'ack-1')$$, pg_temp.get('doc1'))), '55000|wording_not_approved', 'unreviewed Hindi wording cannot be the basis of an acknowledgement');
select is(pg_temp.err(format($$select documents.acknowledge(%L, '00000000-0000-4000-8000-000000000000', array['part1','apr_sheet','schedule','part2'], 'button', 'v1', 'mobile_app', '1.0.0', 'ack-1')$$, pg_temp.get('doc1'))), 'P0002|wording_not_found', 'unknown wording is refused');
select pg_temp.as_user('22222222-2222-4222-8222-222222222222');
select is(pg_temp.err(format($$select documents.acknowledge(%L, 'f3000000-0000-4000-8000-000000000001', array['part1','apr_sheet','schedule','part2'], 'button', 'v1', 'mobile_app', '1.0.0', 'x')$$, pg_temp.get('doc1'))), 'P0002|', 'another borrower cannot acknowledge this document');
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
select pg_temp.keep('ack1', documents.acknowledge(pg_temp.get('doc1')::uuid, 'f3000000-0000-4000-8000-000000000001', array['part1','apr_sheet','schedule','part2'], 'checkbox_and_button', 'v1', 'mobile_app', '1.0.0', 'ack-1') ->> 'acknowledgementId');
select is(documents.acknowledge(pg_temp.get('doc1')::uuid, 'f3000000-0000-4000-8000-000000000001', array['part1','apr_sheet','schedule','part2'], 'checkbox_and_button', 'v1', 'mobile_app', '1.0.0', 'ack-1') ->> 'replayed', 'true', 'repeating the request returns the same acknowledgement');
select pg_temp.as_owner();
select is((select count(*) from documents.acknowledgements where document_id = pg_temp.get('doc1')::uuid), 1::bigint, 'only one acknowledgement exists');
select is((select (document_sha256 = (select sha256 from documents.items where id = pg_temp.get('doc1')::uuid) and language = 'en'
                   and wording_sha256 = (select body_sha256 from consent.notices where id = 'f3000000-0000-4000-8000-000000000001') and action = 'checkbox_and_button')
           from documents.acknowledgements where id = pg_temp.get('ack1')::uuid), true, 'it records the exact file hash, language, wording version hash and action');
select is(pg_temp.err(format($$update documents.acknowledgements set language = 'hi' where id = %L$$, pg_temp.get('ack1'))), 'P0001|Record a compensating entry instead.', 'acknowledgements are append-only');

-- H. Offer acceptance --------------------------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
select is(pg_temp.err(format($$select documents.accept_offer('0f000000-0000-4000-8000-000000000001', %L, %L, 'acc-1')$$, pg_temp.get('doc1'), pg_temp.get('ack1'))), '42501|stepup_required', 'acceptance needs a verified one-time code');
select identity.stepup_start('e7000000-0000-4000-8000-000000000001', 'offer_acceptance', '0f000000-0000-4000-8000-000000000002', repeat('a', 64));
select is(identity.stepup_verify('e7000000-0000-4000-8000-000000000001', repeat('a', 64)), 'verified', 'a code verified for ANOTHER offer');
select is(pg_temp.err(format($$select documents.accept_offer('0f000000-0000-4000-8000-000000000001', %L, %L, 'acc-1')$$, pg_temp.get('doc1'), pg_temp.get('ack1'))), '42501|stepup_required', 'cannot authorise this one');
select identity.stepup_start('e7000000-0000-4000-8000-000000000002', 'esign', '0f000000-0000-4000-8000-000000000001', repeat('b', 64));
select identity.stepup_verify('e7000000-0000-4000-8000-000000000002', repeat('b', 64));
select is(pg_temp.err(format($$select documents.accept_offer('0f000000-0000-4000-8000-000000000001', %L, %L, 'acc-1')$$, pg_temp.get('doc1'), pg_temp.get('ack1'))), '42501|stepup_required', 'nor can a code verified for a different action');
select pg_temp.as_user('22222222-2222-4222-8222-222222222222');
select is(pg_temp.err(format($$select documents.accept_offer('0f000000-0000-4000-8000-000000000001', %L, %L, 'x')$$, pg_temp.get('doc1'), pg_temp.get('ack1'))), 'P0002|', 'another borrower cannot accept this offer');
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
select identity.stepup_start('e7000000-0000-4000-8000-000000000003', 'offer_acceptance', '0f000000-0000-4000-8000-000000000001', repeat('c', 64));
select identity.stepup_verify('e7000000-0000-4000-8000-000000000003', repeat('c', 64));
select is(pg_temp.err(format($$select documents.accept_offer('0f000000-0000-4000-8000-000000000001', %L, %L, 'acc-1')$$, pg_temp.get('doc1'), gen_random_uuid())), '55000|acknowledgement_required', 'an acknowledgement of a different document does not count');
select is(pg_temp.sstat('e7000000-0000-4000-8000-000000000003'), 'verified', 'a refused acceptance does not spend the verified code');
select pg_temp.keep('acc1', documents.accept_offer('0f000000-0000-4000-8000-000000000001', pg_temp.get('doc1')::uuid, pg_temp.get('ack1')::uuid, 'acc-1') ->> 'acceptanceId');
select is((select status::text from lending.offers where id = '0f000000-0000-4000-8000-000000000001'), 'accepted', 'the offer is accepted');
select is((select status::text from lending.applications where id = 'a2000000-0000-4000-8000-000000000001'), 'offer_accepted', 'the application records "offer accepted", not an executed agreement');
select is(pg_temp.sstat('e7000000-0000-4000-8000-000000000003'), 'consumed', 'the one-time code is spent');
select is(documents.accept_offer('0f000000-0000-4000-8000-000000000001', pg_temp.get('doc1')::uuid, pg_temp.get('ack1')::uuid, 'acc-1') ->> 'replayed', 'true', 'repeating the same request returns the same acceptance');
select is(pg_temp.err(format($$select documents.accept_offer('0f000000-0000-4000-8000-000000000001', %L, %L, 'another-key')$$, pg_temp.get('doc1'), pg_temp.get('ack1'))), '55000|already_accepted', 'a second acceptance with another key is refused');
select pg_temp.as_owner();
select is((select (signature_status, disbursement_status)::text from documents.acceptances where id = pg_temp.get('acc1')::uuid), '(not_signed,not_started)', 'acceptance is recorded as neither signed nor disbursed');
select is((select count(*) from documents.acceptances where offer_id = '0f000000-0000-4000-8000-000000000001'), 1::bigint, 'one acceptance event per offer');
select is((select count(*) from documents.generation_jobs where offer_id = '0f000000-0000-4000-8000-000000000001' and document_type = 'loan_agreement' and status = 'pending'), 1::bigint, 'the agreement is queued as a separate step');

-- I. Another offer on the same request cannot also be accepted ----------------------------------------------------------------------------------------------
select pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001');
select pg_temp.as_owner();
select pg_temp.as_user('bbbbbbbb-0000-4000-8000-000000000001');
select pg_temp.keep('input_b', documents.submit_kfs_data('0f000000-0000-4000-8000-000000000002', pg_temp.mkkfs()) ->> 'inputId');
select pg_temp.keep('job_b', documents.request_generation('0f000000-0000-4000-8000-000000000002', 'en', pg_temp.get('input_b')::uuid) ->> 'jobId');
select pg_temp.as_system();
select documents.begin_generation(pg_temp.get('job_b')::uuid);
select pg_temp.keep('doc_b', documents.complete_generation(pg_temp.get('job_b')::uuid, 'kfs/test/beta1', repeat('4', 64), 100)::text);
select pg_temp.as_user('bbbbbbbb-0000-4000-8000-000000000002');
select documents.approve_document(pg_temp.get('doc_b')::uuid, repeat('4', 64));
select documents.issue_document(pg_temp.get('doc_b')::uuid);
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
select is(pg_temp.err(format($$select documents.accept_offer('0f000000-0000-4000-8000-000000000002', %L, %L, 'acc-b')$$, pg_temp.get('doc_b'), gen_random_uuid())), '55000|acknowledgement_required', 'Beta''s KFS also needs its own acknowledgement');
select documents.open_document(pg_temp.get('doc_b')::uuid, 'view');
select pg_temp.keep('ack_b', documents.acknowledge(pg_temp.get('doc_b')::uuid, 'f3000000-0000-4000-8000-000000000001', array['part1','apr_sheet','schedule','part2'], 'button', 'v1', 'mobile_app', '1.0.0', 'ack-b') ->> 'acknowledgementId');
select identity.stepup_start('e7000000-0000-4000-8000-000000000004', 'offer_acceptance', '0f000000-0000-4000-8000-000000000002', repeat('d', 64));
select identity.stepup_verify('e7000000-0000-4000-8000-000000000004', repeat('d', 64));
select is(pg_temp.err(format($$select documents.accept_offer('0f000000-0000-4000-8000-000000000002', %L, %L, 'acc-b')$$, pg_temp.get('doc_b'), pg_temp.get('ack_b'))), '55000|another_offer_accepted', 'only one offer per request can be accepted');
select is(pg_temp.sstat('e7000000-0000-4000-8000-000000000004'), 'verified', 'and the refusal rolls back, so the code is not spent');

-- J. Withdrawn, expired and stale: nothing is accepted, nothing is silently extended -------------------------------------------------------------------------------
select pg_temp.as_user('22222222-2222-4222-8222-222222222222');
select pg_temp.as_owner();
select pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001');
select pg_temp.keep('input3', documents.submit_kfs_data('0f000000-0000-4000-8000-000000000003', pg_temp.mkkfs()) ->> 'inputId');
select pg_temp.keep('job3', documents.request_generation('0f000000-0000-4000-8000-000000000003', 'en', pg_temp.get('input3')::uuid) ->> 'jobId');
select pg_temp.as_system();
select documents.begin_generation(pg_temp.get('job3')::uuid);
select pg_temp.as_owner();
-- Make the prepared window shorter than the minimum counted from now: issuing must refuse a stale draft.
update documents.generation_jobs set stamped = jsonb_set(stamped, '{validUntil}', to_jsonb(now() + interval '1 hour')) where id = pg_temp.get('job3')::uuid;
select pg_temp.as_system();
select pg_temp.keep('doc3', documents.complete_generation(pg_temp.get('job3')::uuid, 'kfs/test/alpha3', repeat('5', 64), 100)::text);
select pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000002');
select documents.approve_document(pg_temp.get('doc3')::uuid, repeat('5', 64));
select is(pg_temp.err(format($$select documents.issue_document(%L)$$, pg_temp.get('doc3'))), '55000|draft_stale', 'a prepared KFS whose window no longer covers the minimum is not issued; it must be prepared again');
select is(pg_temp.err(format($$select documents.withdraw_document(%L, 'prepared_in_error')$$, pg_temp.get('doc3'))), 'ok', 'a lender can withdraw a draft');
select pg_temp.as_owner();
select is((select issuance_status from documents.items where id = pg_temp.get('doc3')::uuid), 'withdrawn', 'withdrawal closes it without deleting it');
-- Withdrawn offer
select pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001');
select is(pg_temp.err(format($$select documents.request_generation('0f000000-0000-4000-8000-000000000003', 'en', %L)$$, pg_temp.get('input3'))), 'ok', 'a fresh request prepares the next version');
select pg_temp.as_owner();
update lending.offers set status = 'withdrawn' where id = '0f000000-0000-4000-8000-000000000003';
select pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001');
select is(pg_temp.err(format($$select documents.request_generation('0f000000-0000-4000-8000-000000000003', 'en', %L)$$, pg_temp.get('input3'))) like '55000|%', true, 'no document is prepared for a withdrawn offer');
select pg_temp.as_system();
select is(documents.begin_generation((select id from documents.generation_jobs where offer_id = '0f000000-0000-4000-8000-000000000003' and status = 'pending'))::text like '%offer_withdrawn%', true, 'a queued job stops at the worker when the offer was withdrawn meanwhile');
select pg_temp.as_owner();
select is((select failure_class from documents.generation_jobs where offer_id = '0f000000-0000-4000-8000-000000000003' and status = 'failed'), 'offer_withdrawn', 'the failure is recorded; the offer is untouched');
select is((select (principal_minor, apr_bps)::text from lending.offers where id = '0f000000-0000-4000-8000-000000000003'), '(2000000,1707)', 'failure leaves the offer values as they were');

-- K. Agreement: the KFS summary box must match the accepted KFS ------------------------------------------------------------------------------------------------
select pg_temp.as_system();
select is(documents.begin_generation((select id from documents.generation_jobs where offer_id = '0f000000-0000-4000-8000-000000000001' and document_type = 'loan_agreement')) ->> 'failed', 'template_not_ready',
  'without an approved agreement template the agreement is not ready (and Udofin supplies no legal text)');
select pg_temp.as_owner();
select set_config('udofin.allow_sample_documents', 'on', true);
select pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001');
select pg_temp.keep('tpl_agr', documents.propose_template('agreement.loan', 'loan_agreement', 'en', 'a1000000-0000-4000-8000-000000000000',
  '{"engine":"agreement_v1","title":"SAMPLE - NOT A LEGAL DOCUMENT","sections":[{"heading":"Sample clause","text":"This text is a test fixture only."}]}', true)::text);
select pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000002');
select is(pg_temp.err(format($$select documents.approve_template_lender(%L)$$, pg_temp.get('tpl_agr'))), 'ok', 'a second lender user approves the wording that carries the lender''s name');
select pg_temp.as_user('0e0e0e0e-0000-4000-8000-000000000001');
select is(pg_temp.err(format($$select documents.approve_template_compliance(%L, 'Test compliance reviewer')$$, pg_temp.get('tpl_agr'))), 'ok', 'and compliance approves it');
select pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001');
select is(pg_temp.err(format($$select documents.request_generation('0f000000-0000-4000-8000-000000000001', 'en', %L, 'loan_agreement')$$, pg_temp.get('input1'))), 'ok', 'a lender can retry the agreement; the same job is reused');
select pg_temp.as_system();
select pg_temp.keep('model_agr', documents.begin_generation((select id from documents.generation_jobs where offer_id = '0f000000-0000-4000-8000-000000000001' and document_type = 'loan_agreement'))::text);
select is(pg_temp.get('model_agr')::jsonb -> 'kfsDocument' ->> 'contentDigest', (select content_digest from documents.items where id = pg_temp.get('doc1')::uuid), 'the agreement is built from the same data as the accepted KFS (same digest)');
select pg_temp.keep('doc_agr', documents.complete_generation((select id from documents.generation_jobs where offer_id = '0f000000-0000-4000-8000-000000000001' and document_type = 'loan_agreement'), 'agr/test/alpha1', repeat('6', 64), 200)::text);
select pg_temp.as_owner();
select is((select status::text from lending.applications where id = 'a2000000-0000-4000-8000-000000000001'), 'agreement_pending', 'the application moves to agreement pending only now');
select is((select content_digest from documents.items where id = pg_temp.get('doc_agr')::uuid), (select content_digest from documents.items where id = pg_temp.get('doc1')::uuid), 'the agreement carries the KFS content digest for its summary box');
select pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000002');
select is(pg_temp.err(format($$select documents.approve_document(%L, %L)$$, pg_temp.get('doc_agr'), repeat('6', 64))), 'ok', 'a lender user with approve rights who neither prepared it nor submitted its figures can approve (the system prepared it)');
select is(pg_temp.err(format($$select documents.issue_document(%L)$$, pg_temp.get('doc_agr'))), 'ok', 'the agreement is issued after lender approval');

-- L. Signing boundary: no provider, only the labelled mock in tests; an OTP is not a signature ------------------------------------------------------------------
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
select is(pg_temp.err(format($$select documents.start_signing(%L, 'mock_esign', 'mock', 'sign-1')$$, pg_temp.get('doc_agr'))), '42501|mock_signing_blocked', 'the mock signer is refused unless the database explicitly allows it (tests only)');
select is(pg_temp.err(format($$select documents.start_signing(%L, 'some_provider', 'live', 'sign-1')$$, pg_temp.get('doc_agr'))), '55000|signing_not_available', 'no real provider is approved, so no live signing can start');
select pg_temp.as_owner();
select set_config('udofin.allow_mock_signing', 'on', true);
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
select is(pg_temp.err(format($$select documents.start_signing(%L, 'mock_esign', 'mock', 'sign-1')$$, pg_temp.get('doc_agr'))), '42501|stepup_required', 'starting needs a one-time code bound to this agreement');
select identity.stepup_start('e7000000-0000-4000-8000-000000000005', 'esign', pg_temp.get('doc_agr'), repeat('e', 64));
select identity.stepup_verify('e7000000-0000-4000-8000-000000000005', repeat('e', 64));
select pg_temp.keep('sign1', documents.start_signing(pg_temp.get('doc_agr')::uuid, 'mock_esign', 'mock', 'sign-1') ->> 'requestId');
select is(documents.start_signing(pg_temp.get('doc_agr')::uuid, 'mock_esign', 'mock', 'sign-1') ->> 'replayed', 'true', 'starting again returns the same request');
select pg_temp.as_owner();
select is((select (state, provider_mode)::text from documents.signing_requests where id = pg_temp.get('sign1')::uuid), '(ready_for_signing,mock)', 'the request is "ready for signing", labelled as a mock');
select is((select status::text from lending.applications where id = 'a2000000-0000-4000-8000-000000000001'), 'agreement_pending', 'verifying a code does not execute the agreement');
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
select is(pg_temp.errs(format($$select documents.record_signing_event(%L, 'executed', 'x', 'x', '{}')$$, pg_temp.get('sign1'))), '42501', 'a borrower cannot mark an agreement as signed');
select pg_temp.as_system();
select is(documents.record_signing_event(pg_temp.get('sign1')::uuid, 'initiated', 'MOCK-1', null, '{}') ->> 'state', 'initiated', 'the provider reports the signing started');
select is(pg_temp.err(format($$select documents.record_signing_event(%L, 'ready_for_signing', null, null, '{}')$$, pg_temp.get('sign1'))), '55000|invalid_transition', 'states only move forward');
select is(documents.record_signing_event(pg_temp.get('sign1')::uuid, 'requires_reconciliation', null, null, '{"reason":"timeout"}') ->> 'state', 'requires_reconciliation', 'an uncertain outcome is kept as uncertain');
select pg_temp.as_owner();
select is((select status::text from lending.applications where id = 'a2000000-0000-4000-8000-000000000001'), 'agreement_pending', 'uncertainty does not execute the agreement');
select pg_temp.as_system();
select is(documents.record_signing_event(pg_temp.get('sign1')::uuid, 'executed', 'MOCK-1', 'MOCK-EVIDENCE-1', '{}') ->> 'state', 'executed', 'only the provider''s executed report completes it');
select pg_temp.as_owner();
select is((select status::text from lending.applications where id = 'a2000000-0000-4000-8000-000000000001'), 'agreement_executed', 'and only then does the application become "agreement executed"');
select pg_temp.as_system();
select is(pg_temp.err(format($$select documents.record_signing_event(%L, 'failed', null, null, '{}')$$, pg_temp.get('sign1'))), '55000|invalid_transition', 'an executed agreement cannot become failed');
select pg_temp.as_owner();
select is((select status::text from lending.offers where id = '0f000000-0000-4000-8000-000000000001'), 'accepted', 'nothing here touches the offer values');
select is((select count(*) from servicing.loan_accounts), 0::bigint, 'and nothing starts a loan account or disbursement (Phase 08)');

-- M. Delivery: a provider''s acceptance is not delivery; no email address is held ------------------------------------------------------------------------------
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
select is(documents.request_delivery(pg_temp.get('doc_agr')::uuid, 'email_notice') ->> 'status', 'not_configured', 'no verified email exists, so an email notice is "not configured", never sent');
select pg_temp.keep('dl1', documents.request_delivery(pg_temp.get('doc_agr')::uuid, 'sms_notice') ->> 'deliveryId');
select is(documents.request_delivery(pg_temp.get('doc_agr')::uuid, 'sms_notice') ->> 'replayed', 'true', 'requesting the same notice twice does not create two');
select pg_temp.as_system();
select is(documents.begin_delivery(pg_temp.get('dl1')::uuid) ->> 'phone', '910000000001', 'the number is read at send time from the authentication record');
select pg_temp.as_owner();
select is((select count(*) from documents.deliveries d where to_jsonb(d)::text like '%910000000001%'), 0::bigint, 'and is never stored with the delivery');
select pg_temp.as_system();
select documents.record_delivery_result(pg_temp.get('dl1')::uuid, 'accepted_by_provider', 'SMS-REF-1', null);
select pg_temp.as_owner();
select is((select status from documents.deliveries where id = pg_temp.get('dl1')::uuid), 'accepted_by_provider', 'provider acceptance is recorded as exactly that');
select is((select count(*) from documents.deliveries where id = pg_temp.get('dl1')::uuid and status = 'delivered'), 0::bigint, 'not as delivered');
select pg_temp.as_system();
select documents.record_delivery_result(pg_temp.get('dl1')::uuid, 'delivered', null, null);
select documents.record_delivery_result(pg_temp.get('dl1')::uuid, 'failed', null, 'x');
select pg_temp.as_owner();
select is((select status from documents.deliveries where id = pg_temp.get('dl1')::uuid), 'delivered', 'once delivered, a late "failed" cannot overwrite it');

-- N. Expiry sweep, isolation and exposure ---------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_system();
select is(documents.process_expiry() ->> 'expired', '0', 'nothing that was accepted is expired by the sweep');
select pg_temp.as_owner();
select is((select issuance_status from documents.items where id = pg_temp.get('doc_b')::uuid), 'issued', 'Beta''s KFS is still issued (its window is open)');
alter table documents.items disable trigger items_protect;
update documents.items set kfs_valid_until = now() - interval '1 minute', kfs_valid_from = now() - interval '2 days' where id = pg_temp.get('doc_b')::uuid;
alter table documents.items enable trigger items_protect;
select pg_temp.as_system();
select is(documents.process_expiry() ->> 'expired', '1', 'a KFS whose validity has ended is expired by the sweep');
select pg_temp.as_owner();
select is((select issuance_status from documents.items where id = pg_temp.get('doc_b')::uuid), 'expired', 'it stays on record as expired');
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
select is(pg_temp.err(format($$select documents.accept_offer('0f000000-0000-4000-8000-000000000002', %L, %L, 'acc-b2')$$, pg_temp.get('doc_b'), pg_temp.get('ack_b'))), '55000|kfs_not_current', 'an expired KFS cannot be used to accept');
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
select is(pg_temp.errs($$insert into documents.items (document_type, version, lender_org_id, application_id, borrower_id, offer_id, kfs_input_id, language, storage_key, sha256, size_bytes) select document_type, 99, lender_org_id, application_id, borrower_id, offer_id, kfs_input_id, language, 'x/forged/key1', sha256, 1 from documents.items limit 1$$), '42501', 'a borrower cannot insert a document');
select is(pg_temp.errs($$update documents.items set storage_key = 'x/other/key1'$$), '42501', 'nor repoint one at another file');
select pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001');
select is(pg_temp.errs($$update documents.items set approval_status = 'lender_approved'$$), '42501', 'a lender cannot change a document row directly, only through the approval function');
select is(pg_temp.errs($$insert into documents.acknowledgements (borrower_id) select borrower_id from documents.items limit 1$$), '42501', 'nor write an acknowledgement for a borrower');
select is(pg_temp.errs($$select private.check_generation('0f000000-0000-4000-8000-000000000001', 'kfs', 'en', gen_random_uuid())$$), '42501', 'private helpers are not callable by signed-in users');
select is((select count(*) from documents.items), 3::bigint, 'Alpha sees its own three documents (two KFS versions, one agreement)');
select pg_temp.as_user('bbbbbbbb-0000-4000-8000-000000000001');
select is((select count(*) from documents.items), 1::bigint, 'Beta sees only its own');
select is((select count(*) from documents.acknowledgements), 1::bigint, 'and only its own acknowledgements');
select is((select count(*) from documents.kfs_inputs), 1::bigint, 'and its own KFS data');
select pg_temp.as_owner();
-- A category the draft rule does not name has no rule: nothing can be prepared for it, however complete the data is.
select pg_temp.as_system();
insert into tenancy.memberships (org_id, user_id, status) select 'c1000000-0000-4000-8000-000000000000', 'aaaaaaaa-0000-4000-8000-000000000001', 'active' on conflict do nothing;
insert into tenancy.membership_roles (membership_id, role_id)
select m.id, (select id from tenancy.roles where org_id is null and applies_to = 'lender' and key = 'credit_officer')
from tenancy.memberships m where m.org_id = 'c1000000-0000-4000-8000-000000000000' and m.user_id = 'aaaaaaaa-0000-4000-8000-000000000001';
insert into lending.offers (id, lender_org_id, application_id, status, principal_minor, tenure_days, installment_frequency, installment_count, installment_amount_minor,
  annual_interest_rate_bps, apr_bps, processing_fee_minor, other_charges, total_repayable_minor, penal_charges_summary, valid_until, monthly_repayment_minor,
  kfs_url, lender_offer_ref, revision, lender_issued_at, source)
values ('0f000000-0000-4000-8000-000000000004', 'c1000000-0000-4000-8000-000000000000', 'a2000000-0000-4000-8000-000000000004', 'issued', 2000000, 720, 'monthly', 24, 97000, 1500, 1707, 24000, '[]', 2327400,
        'x', now() + interval '30 days', 97000, 'https://kfs.gamma.example/k/4', 'OFFER-4', 1, now(), 'manual');
select pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001');
select pg_temp.keep('input_c', documents.submit_kfs_data('0f000000-0000-4000-8000-000000000004', pg_temp.mkkfs()) ->> 'inputId');
select is(pg_temp.err(format($$select documents.request_generation('0f000000-0000-4000-8000-000000000004', 'en', %L)$$, pg_temp.get('input_c'))), '55000|applicability_unresolved',
  'a lender category the rule does not name (here an NBFC-MFI; banks cannot go live yet) gets no KFS: preparation stops until its own rule is approved');
select pg_temp.as_owner();
select is((select count(*) from documents.items i where to_jsonb(i)::text like '%910000000001%'), 0::bigint, 'no phone number appears in any document row');
select is((select count(*) from audit.events e where e.action like 'documents.%' and to_jsonb(e)::text ~ '(910000000001|Alpha Finance Ltd|grievance@lender)'), 0::bigint, 'nor in the document audit entries, which carry identifiers only');

select * from finish();
rollback;
