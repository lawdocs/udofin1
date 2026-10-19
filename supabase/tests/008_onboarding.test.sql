-- Phase 04 (addendum A): lender onboarding, accounting framework / Ind AS status, engagement scope,
-- requirements register and activation gates. Synthetic data only.
begin;
create extension if not exists pgtap with schema extensions;
select plan(137);

create function pg_temp.as_user(uid uuid, aal text default 'aal2') returns void language plpgsql as $fn$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated', 'aal', aal)::text, true);
  execute 'set local role authenticated';
end
$fn$;
create function pg_temp.as_owner() returns void language plpgsql as $fn$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
end
$fn$;
-- Runs a statement as the current role and reports 'ok' or SQLSTATE|hint, so a test can check which rule fired.
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
create function pg_temp.keep(k text, v anyelement) returns void language plpgsql as $fn$
begin perform set_config('t.' || k, v::text, true); end
$fn$;
create function pg_temp.got(k text) returns uuid language sql as $fn$ select current_setting('t.' || k)::uuid $fn$;
grant execute on all functions in schema pg_temp to public;

-- Fixture ---------------------------------------------------------------------------------------
insert into auth.users (id, phone, raw_app_meta_data)
select ('d1000000-0000-4000-8000-00000000000' || n)::uuid, null, '{"actor_type":"staff"}'::jsonb from generate_series(1, 8) n;
-- 1 platform manager, 2 platform approver, 3 platform manager+approver, 4 compliance officer,
-- 5 lender A admin, 6 lender B admin, 7 lender A viewer (no onboarding rights), 8 drafter of synthetic product versions

select pg_temp.as_owner();
insert into tenancy.organizations (id, kind, legal_name, display_name, regulator_registration_no, status) values
  ('d0000000-0000-4000-8000-000000000000', 'platform', 'Udofin Platform (test)', 'Udofin', null, 'active'),
  ('d2000000-0000-4000-8000-000000000000', 'lender', 'Onboard Alpha Finance (test)', 'Alpha', 'TEST-ONB-0001', 'onboarding'),
  ('d3000000-0000-4000-8000-000000000000', 'lender', 'Onboard Beta Finance (test)', 'Beta', 'TEST-ONB-0002', 'onboarding'),
  ('d4000000-0000-4000-8000-000000000000', 'lender', 'Onboard Gamma Bank (test)', 'Gamma', 'TEST-ONB-0003', 'onboarding');
insert into tenancy.memberships (id, org_id, user_id, status) values
  ('d1c10000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000000', 'd1000000-0000-4000-8000-000000000001', 'active'),
  ('d1c10000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000000', 'd1000000-0000-4000-8000-000000000002', 'active'),
  ('d1c10000-0000-4000-8000-000000000003', 'd0000000-0000-4000-8000-000000000000', 'd1000000-0000-4000-8000-000000000003', 'active'),
  ('d1c10000-0000-4000-8000-000000000004', 'd0000000-0000-4000-8000-000000000000', 'd1000000-0000-4000-8000-000000000004', 'active'),
  ('d1c10000-0000-4000-8000-000000000005', 'd2000000-0000-4000-8000-000000000000', 'd1000000-0000-4000-8000-000000000005', 'active'),
  ('d1c10000-0000-4000-8000-000000000006', 'd3000000-0000-4000-8000-000000000000', 'd1000000-0000-4000-8000-000000000006', 'active'),
  ('d1c10000-0000-4000-8000-000000000007', 'd2000000-0000-4000-8000-000000000000', 'd1000000-0000-4000-8000-000000000007', 'active'),
  ('d1c10000-0000-4000-8000-000000000008', 'd2000000-0000-4000-8000-000000000000', 'd1000000-0000-4000-8000-000000000008', 'active');
insert into tenancy.membership_roles (membership_id, role_id)
select m.mid::uuid, r.id from (values
  ('d1c10000-0000-4000-8000-000000000001', 'platform', 'onboarding_manager'),
  ('d1c10000-0000-4000-8000-000000000002', 'platform', 'onboarding_approver'),
  ('d1c10000-0000-4000-8000-000000000003', 'platform', 'onboarding_manager'),
  ('d1c10000-0000-4000-8000-000000000003', 'platform', 'onboarding_approver'),
  ('d1c10000-0000-4000-8000-000000000004', 'platform', 'compliance_officer'),
  ('d1c10000-0000-4000-8000-000000000005', 'lender', 'lender_admin'),
  ('d1c10000-0000-4000-8000-000000000006', 'lender', 'lender_admin'),
  ('d1c10000-0000-4000-8000-000000000007', 'lender', 'viewer'),
  ('d1c10000-0000-4000-8000-000000000008', 'lender', 'product_approver')
) as m (mid, kind, rkey)
join tenancy.roles r on r.org_id is null and r.applies_to = m.kind::tenancy.organization_kind and r.key = m.rkey;

-- 1. Reference data: several institution types, no duplicated lender module -----------------------
select is((select count(distinct institution_type)::int from onboarding.institution_categories), 5,
  'categories cover NBFCs, HFCs, banks, urban co-operative banks and other regulated entities');
select is((select count(*)::int from onboarding.institution_categories where regime_status = 'unverified' and activation_allowed), 0,
  'no unverified category is activation-allowed by default');
select is(pg_temp.err($$insert into onboarding.institution_categories (key, label, institution_type, regulator, regime_status, regime_note, activation_allowed)
  values ('x_cat', 'Test category', 'bank', 'RBI', 'unverified', 'no primary source on file', true)$$), '23514|',
  'a category cannot be enabled without confirmed sources or a compliance sign-off');
select cmp_ok((select count(*)::int from onboarding.service_categories), '>=', 21, 'all service categories are seeded');

-- 2. Profile creation: authorised admins only -----------------------------------------------------
select pg_temp.as_user('d1000000-0000-4000-8000-000000000005');
select is(pg_temp.err($$select onboarding.profile_create('d2000000-0000-4000-8000-000000000000', 'nbfc_icc')$$), '42501|',
  'a lender cannot create its own onboarding profile');
select pg_temp.as_user('d1000000-0000-4000-8000-000000000001', 'aal1');
select is(pg_temp.err($$select onboarding.profile_create('d2000000-0000-4000-8000-000000000000', 'nbfc_icc')$$), '42501|mfa_required',
  'platform onboarding writes require a second-factor session');
select pg_temp.as_user('d1000000-0000-4000-8000-000000000001');
select is(pg_temp.err($$select onboarding.profile_create('d2000000-0000-4000-8000-000000000000', 'no_such_category')$$), '22023|',
  'an unknown institution category is rejected');
select is(pg_temp.err($$select onboarding.profile_create('d2000000-0000-4000-8000-000000000000', 'nbfc_icc', '{"is_approved": true}')$$), '22023|',
  'unknown profile fields (including an "approved" flag) are rejected');
select is(pg_temp.err($$select onboarding.profile_create('d2000000-0000-4000-8000-000000000000', 'nbfc_icc',
  '{"registration_no": "TEST-REG-0001", "licence_status": "active", "licence_type": "NBFC-ICC (synthetic)"}')$$), 'ok',
  'a platform onboarding manager creates a profile for Alpha');
select is(pg_temp.err($$select onboarding.profile_create('d3000000-0000-4000-8000-000000000000', 'nbfc_icc', '{"registration_no": "TEST-REG-0002"}')$$), 'ok',
  'and for Beta (a second lender uses the same module)');
select is(pg_temp.err($$select onboarding.profile_create('d4000000-0000-4000-8000-000000000000', 'bank_commercial', '{"registration_no": "TEST-REG-0003"}')$$), 'ok',
  'and for Gamma, a commercial bank, in the same tables');
select is((select verification_status from onboarding.lender_profiles where lender_org_id = 'd2000000-0000-4000-8000-000000000000'), 'unverified',
  'a new profile is unverified: a profile never implies approval');
select is((select stage from onboarding.lender_gates where lender_org_id = 'd2000000-0000-4000-8000-000000000000'), 'profile_created',
  'the gate starts at profile_created');

-- 3. Tenant isolation on reads ---------------------------------------------------------------------
select pg_temp.as_user('d1000000-0000-4000-8000-000000000005');
select is((select count(*)::int from onboarding.lender_profiles), 1, 'lender A sees only its own profile');
select pg_temp.as_user('d1000000-0000-4000-8000-000000000006');
select is((select count(*)::int from onboarding.lender_profiles where lender_org_id = 'd2000000-0000-4000-8000-000000000000'), 0,
  'lender B cannot see lender A''s profile');
select is((select count(*)::int from onboarding.lender_gates where lender_org_id = 'd2000000-0000-4000-8000-000000000000'), 0,
  'lender B cannot see lender A''s gate');
select pg_temp.as_user('d1000000-0000-4000-8000-000000000007');
select is((select count(*)::int from onboarding.lender_profiles), 0, 'a lender user without onboarding.read sees nothing');
select pg_temp.as_user('d1000000-0000-4000-8000-000000000001');
select is((select count(*)::int from onboarding.lender_profiles), 3, 'platform onboarding staff see every lender');

-- 4. Direct table writes are impossible for users --------------------------------------------------
select pg_temp.as_user('d1000000-0000-4000-8000-000000000005');
select is(pg_temp.err($$update onboarding.lender_profiles set verification_status = 'verified'$$) like '42501|%', true, 'a lender cannot update a profile directly');
select is(pg_temp.err($$update onboarding.lender_gates set stage = 'activated'$$) like '42501|%', true, 'a lender cannot move its own gate directly');
select is(pg_temp.err($$insert into onboarding.documents (lender_org_id, purpose, label, storage_key, sha256, size_bytes, mime_type, uploaded_by)
  values ('d2000000-0000-4000-8000-000000000000', 'other', 'x', 'dev/aaaaaaaaaaaa', repeat('a', 64), 10, 'application/pdf', 'd1000000-0000-4000-8000-000000000005')$$) like '42501|%', true,
  'documents cannot be inserted directly');

-- 5. Institution verification: evidence, independence, history -----------------------------------
select is(pg_temp.err($$select onboarding.verification_submit('d3000000-0000-4000-8000-000000000000', gen_random_uuid())$$), '42501|',
  'lender A cannot submit verification for lender B');
select pg_temp.keep('doc_a1', onboarding.register_document('d2000000-0000-4000-8000-000000000000', 'licence', 'Licence copy (synthetic)',
  'dev/d2/lic-0001', repeat('1', 64), 1200, 'application/pdf'));
select is(pg_temp.err($$select onboarding.register_document('d2000000-0000-4000-8000-000000000000', 'licence', 'Bad', 'dev/d2/lic-0002', repeat('2', 64), 10, 'text/html')$$),
  '23514|', 'only whitelisted document types are accepted');
select is(pg_temp.err(format($$select onboarding.verification_submit('d2000000-0000-4000-8000-000000000000', %L)$$, pg_temp.got('doc_a1'))), 'ok',
  'the lender submits its licence evidence for verification');
select is((select verification_status from onboarding.lender_profiles where lender_org_id = 'd2000000-0000-4000-8000-000000000000'), 'submitted',
  'submitted is not verified');
select is(pg_temp.err($$select onboarding.verification_decide('d2000000-0000-4000-8000-000000000000', true, 'ok')$$), '42501|',
  'the lender cannot verify itself');
select pg_temp.as_user('d1000000-0000-4000-8000-000000000001');
select is(pg_temp.err($$select onboarding.verification_decide('d2000000-0000-4000-8000-000000000000', true, 'ok')$$), '42501|',
  'a manager without onboarding.approve cannot verify');
select pg_temp.as_user('d1000000-0000-4000-8000-000000000003');
select pg_temp.keep('doc_b3', (select id from onboarding.documents limit 1));
select is(pg_temp.err($$select onboarding.profile_update('d2000000-0000-4000-8000-000000000000', '{"notes": "contributed by the reviewer"}')$$), 'ok',
  'a manager+approver edits the profile (and becomes a contributor)');
-- the edit above is not a material change, so the lender''s submission stands
select is(pg_temp.err($$select onboarding.verification_decide('d2000000-0000-4000-8000-000000000000', true, 'checked against evidence')$$), '42501|self_approval',
  'a contributor cannot verify the record they edited');
select pg_temp.as_user('d1000000-0000-4000-8000-000000000002');
select is(pg_temp.err($$select onboarding.verification_decide('d2000000-0000-4000-8000-000000000000', false, 'no')$$), '22023|',
  'a rejection needs a reason');
select is(pg_temp.err($$select onboarding.verification_decide('d2000000-0000-4000-8000-000000000000', true, 'Checked licence copy against regulator list (synthetic)')$$), 'ok',
  'an independent approver verifies with evidence');
select is((select verification_status from onboarding.lender_profiles where lender_org_id = 'd2000000-0000-4000-8000-000000000000'), 'verified', 'the profile is verified');
select pg_temp.as_user('d1000000-0000-4000-8000-000000000005');
select is(pg_temp.err($$select onboarding.profile_update('d2000000-0000-4000-8000-000000000000', '{"category_key": "hfc"}')$$), '22023|',
  'a lender cannot change its own institution category');
select is(pg_temp.err($$select onboarding.profile_update('d2000000-0000-4000-8000-000000000000', '{"registration_no": "TEST-REG-0001B"}')$$), 'ok',
  'a lender can correct its registration number');
select pg_temp.as_user('d1000000-0000-4000-8000-000000000001');
select is((select verification_status from onboarding.lender_profiles where lender_org_id = 'd2000000-0000-4000-8000-000000000000'), 'unverified',
  'changing identity facts voids the earlier verification');
select cmp_ok((select count(*)::int from onboarding.verification_history where lender_org_id = 'd2000000-0000-4000-8000-000000000000' and subject = 'institution'),
  '>=', 4, 'every verification state is retained in the history');
-- re-verify with fresh evidence so the sequence can continue
select pg_temp.as_user('d1000000-0000-4000-8000-000000000005');
select pg_temp.keep('doc_a2', onboarding.register_document('d2000000-0000-4000-8000-000000000000', 'licence', 'Licence copy 2 (synthetic)',
  'dev/d2/lic-0003', repeat('3', 64), 1300, 'application/pdf'));
select onboarding.verification_submit('d2000000-0000-4000-8000-000000000000', pg_temp.got('doc_a2'));
select pg_temp.as_user('d1000000-0000-4000-8000-000000000002');
select onboarding.verification_decide('d2000000-0000-4000-8000-000000000000', true, 'Checked the corrected registration number (synthetic)');
select is((select verification_status from onboarding.lender_profiles where lender_org_id = 'd2000000-0000-4000-8000-000000000000'), 'verified', 're-verified after the correction');

-- 6. Accounting framework and Ind AS status --------------------------------------------------------
select pg_temp.as_user('d1000000-0000-4000-8000-000000000005');
select is(pg_temp.err($$select onboarding.accounting_save_draft('d2000000-0000-4000-8000-000000000000', '{"auto_conclusion": "ind_as"}')$$), '22023|',
  'unknown accounting fields are rejected');
select pg_temp.keep('acc_a1', onboarding.accounting_save_draft('d2000000-0000-4000-8000-000000000000',
  '{"ind_as_applicability": "applicable", "ind_as_implementation_status": "not_implemented", "net_worth_paise": 50000000000, "net_worth_measured_on": "2026-03-31", "net_worth_fy": "2025-26", "listed_status": "unlisted"}'));
select is((select ind_as_applicability || '/' || ind_as_implementation_status from onboarding.accounting_profiles where id = pg_temp.got('acc_a1')),
  'applicable/not_implemented', 'applicability and implementation status are separate fields');
select is((select accounting_framework from onboarding.accounting_profiles where id = pg_temp.got('acc_a1')), 'to_be_confirmed',
  'the framework is not inferred from applicability, net worth or lender type');
select is(pg_temp.err($$select onboarding.accounting_save_draft('d2000000-0000-4000-8000-000000000000', '{"ind_as_applicability": "not_applicable", "ind_as_implementation_status": "implemented"}')$$), '23514|',
  'not-applicable together with implemented is rejected as inconsistent');
select is(pg_temp.err($$select onboarding.accounting_save_draft('d2000000-0000-4000-8000-000000000000', '{"net_worth_paise": -5, "net_worth_measured_on": "2026-03-31"}')$$), '23514|',
  'net worth is non-negative integer paise');
select is(pg_temp.err(format($$select onboarding.accounting_submit(%L)$$, pg_temp.got('acc_a1'))), 'ok', 'the lender submits its declaration');
select pg_temp.as_user('d1000000-0000-4000-8000-000000000002');
select is(pg_temp.err(format($$select onboarding.accounting_decide(%L, true, 'looks right')$$, pg_temp.got('acc_a1'))), '55000|evidence_required',
  'without evidence a declaration cannot be verified');
select is(pg_temp.err(format($$select onboarding.accounting_decide(%L, false, 'Evidence is missing; please upload the auditor confirmation')$$, pg_temp.got('acc_a1'))), 'ok',
  'the reviewer rejects it with a reason');
select pg_temp.as_user('d1000000-0000-4000-8000-000000000005');
select pg_temp.keep('doc_acc', onboarding.register_document('d2000000-0000-4000-8000-000000000000', 'accounting_evidence', 'Auditor confirmation (synthetic)',
  'dev/d2/acc-0001', repeat('4', 64), 2200, 'application/pdf'));
select pg_temp.keep('acc_a2', onboarding.accounting_save_draft('d2000000-0000-4000-8000-000000000000',
  format('{"evidence_document_id": "%s", "accounting_framework": "ind_as", "confirmation_source": "management_declaration"}', pg_temp.got('doc_acc'))::jsonb));
select is((select version_no from onboarding.accounting_profiles where id = pg_temp.got('acc_a2')), 2, 'the next draft is version 2 (history is kept)');
select is((select ind_as_applicability from onboarding.accounting_profiles where id = pg_temp.got('acc_a2')), 'applicable',
  'a new version starts from the previous values, without its evidence');
select onboarding.accounting_submit(pg_temp.got('acc_a2'));
select pg_temp.as_user('d1000000-0000-4000-8000-000000000002');
select is(pg_temp.err(format($$select onboarding.accounting_decide(%L, true, 'Auditor confirmation reviewed (synthetic)')$$, pg_temp.got('acc_a2'))), 'ok',
  'with evidence and confirmed values an independent reviewer verifies');
select is((select status from onboarding.accounting_profiles where id = pg_temp.got('acc_a2')), 'verified', 'version 2 is verified');
select is((select count(*)::int from onboarding.accounting_profiles where lender_org_id = 'd2000000-0000-4000-8000-000000000000'), 2, 'both versions are retained');
select pg_temp.as_user('d1000000-0000-4000-8000-000000000005');
select pg_temp.keep('acc_a3', onboarding.accounting_save_draft('d2000000-0000-4000-8000-000000000000', '{"ind_as_applicability": "to_be_confirmed"}'));
select onboarding.accounting_submit(pg_temp.got('acc_a3'));
select pg_temp.as_user('d1000000-0000-4000-8000-000000000002');
select is(pg_temp.err(format($$select onboarding.accounting_decide(%L, true, 'try to verify unconfirmed')$$, pg_temp.got('acc_a3'))), '55000|evidence_required',
  'a version without evidence is not verifiable');
select is((select status from onboarding.accounting_profiles where id = pg_temp.got('acc_a2')), 'verified', 'the earlier verified version stays verified until replaced');
select pg_temp.as_owner();
select is(pg_temp.err(format($$update onboarding.accounting_profiles set ind_as_applicability = 'not_applicable' where id = %L$$, pg_temp.got('acc_a2'))), '55000|version_immutable',
  'a verified accounting profile is immutable');
select is(pg_temp.err($$insert into onboarding.accounting_profiles (lender_org_id, version_no, status, confirmation_source, ind_as_applicability, accounting_framework,
  reviewed_by, reviewed_at, last_verified_on, created_by) values ('d3000000-0000-4000-8000-000000000000', 1, 'verified', 'to_be_confirmed', 'applicable', 'ind_as',
  'd1000000-0000-4000-8000-000000000002', now(), current_date, 'd1000000-0000-4000-8000-000000000006')$$), '23514|',
  'the database itself refuses a verified row whose confirmation is still "to be confirmed"');
select cmp_ok((select count(*)::int from onboarding.verification_history where subject = 'accounting' and lender_org_id = 'd2000000-0000-4000-8000-000000000000'), '>=', 5,
  'accounting verification history is retained');

-- 7. Free text guard -------------------------------------------------------------------------------
select pg_temp.as_user('d1000000-0000-4000-8000-000000000005');
select is(pg_temp.err($$select onboarding.service_create('d2000000-0000-4000-8000-000000000000', 'lead_generation', 'Leads', '{"requested_scope": "use api_key = sk_live_abcdef123456"}')$$), '22023|unsafe_free_text',
  'secret-like text is refused');
select is(pg_temp.err($$select onboarding.service_create('d2000000-0000-4000-8000-000000000000', 'lead_generation', 'Leads', '{"requested_scope": "borrower 2345 6789 0123 asked"}')$$), '22023|unsafe_free_text',
  'Aadhaar-like numbers are refused');

-- 8. Services: requested is not agreed is not active; shared must be allocated ---------------------
select pg_temp.keep('svc_a1', onboarding.service_create('d2000000-0000-4000-8000-000000000000', 'lead_generation', 'Lead generation for personal loans',
  '{"requested_scope": "Send us qualified personal loan leads"}'));
select pg_temp.keep('ver_a1', (select id from onboarding.service_versions where service_id = pg_temp.got('svc_a1') and version_no = 1));
select is((select status from onboarding.service_versions where id = pg_temp.got('ver_a1')), 'proposed', 'a new service is only proposed');
select is((select agreed_scope from onboarding.service_versions where id = pg_temp.got('ver_a1')), null, 'the requested scope is not the agreed scope');
select is(pg_temp.err(format($$select onboarding.service_revise(%L, '{"proposed_scope": "x"}')$$, pg_temp.got('svc_a1'))), '22023|',
  'a lender cannot write Udofin''s proposed scope');
select is(pg_temp.err(format($$select onboarding.service_agree(%L)$$, pg_temp.got('ver_a1'))), '55000|agreed_scope_required',
  'neither side can agree before the final scope is written');
select pg_temp.as_user('d1000000-0000-4000-8000-000000000001');
select is(pg_temp.err(format($$select onboarding.service_revise(%L, '{"proposed_scope": "Udofin sources and pre-screens leads", "agreed_scope": "Udofin sources leads; the lender decides on every application", "responsible_party": "shared"}')$$, pg_temp.got('svc_a1'))),
  '23514|', 'shared responsibility without a written allocation is rejected');
select is(pg_temp.err(format($$select onboarding.service_revise(%L, '{"proposed_scope": "Udofin sources and pre-screens leads", "agreed_scope": "Udofin sources leads; the lender decides on every application", "responsible_party": "shared", "shared_allocation": "Udofin runs the journey and consent; the lender owns eligibility and decisions", "system_of_record": "lender_system"}')$$, pg_temp.got('svc_a1'))),
  'ok', 'with an explicit allocation it is accepted');
select pg_temp.as_user('d1000000-0000-4000-8000-000000000005');
select is(pg_temp.err(format($$select onboarding.service_agree(%L)$$, pg_temp.got('ver_a1'))), 'ok', 'the lender agrees');
select is((select status from onboarding.service_versions where id = pg_temp.got('ver_a1')), 'under_discussion', 'one side''s agreement does not make it agreed');
select pg_temp.as_user('d1000000-0000-4000-8000-000000000001');
select is(pg_temp.err(format($$select onboarding.service_agree(%L)$$, pg_temp.got('ver_a1'))), '42501|', 'a manager without onboarding.approve cannot agree for Udofin');
select pg_temp.as_user('d1000000-0000-4000-8000-000000000003');
select is(pg_temp.err(format($$select onboarding.service_agree(%L)$$, pg_temp.got('ver_a1'))), 'ok', 'an approver who did not draft the version can agree for Udofin');
select is((select status from onboarding.service_versions where id = pg_temp.got('ver_a1')), 'agreed', 'both sides agreed: the version is agreed, not yet active');
select is(pg_temp.err(format($$select onboarding.service_activate(%L)$$, pg_temp.got('ver_a1'))), '42501|self_approval', 'the person who agreed cannot also activate');
select pg_temp.as_user('d1000000-0000-4000-8000-000000000002');
select is(pg_temp.err(format($$select onboarding.service_activate(%L)$$, pg_temp.got('ver_a1'))), '55000|gate_not_met',
  'a service cannot go live before the lender has completed contractual onboarding');
select pg_temp.as_owner();
select is(pg_temp.err(format($$update onboarding.service_versions set agreed_scope = 'something else' where id = %L$$, pg_temp.got('ver_a1'))), '55000|version_immutable',
  'an agreed scope cannot be rewritten');

-- 9. Two lenders, different scopes ----------------------------------------------------------------
select pg_temp.as_user('d1000000-0000-4000-8000-000000000006');
select pg_temp.keep('svc_b1', onboarding.service_create('d3000000-0000-4000-8000-000000000000', 'servicing_integration', 'Servicing read-back',
  '{"requested_scope": "Show loan status in the app"}'));
select pg_temp.as_owner();
select is((select count(distinct category_key)::int from onboarding.lender_services where lender_org_id in ('d2000000-0000-4000-8000-000000000000', 'd3000000-0000-4000-8000-000000000000')), 2,
  'different lenders hold different service scopes');
select pg_temp.as_user('d1000000-0000-4000-8000-000000000006');
select is((select count(*)::int from onboarding.lender_services where lender_org_id = 'd2000000-0000-4000-8000-000000000000'), 0, 'lender B cannot read lender A''s services');
select is(pg_temp.err(format($$select onboarding.service_agree(%L)$$, pg_temp.got('ver_a1'))), '55000|', 'lender B cannot act on lender A''s service version');
select is(pg_temp.err(format($$select onboarding.service_revise(%L, '{"requested_scope": "hijack"}')$$, pg_temp.got('svc_a1'))), '42501|', 'nor revise it');
select is(pg_temp.err(format($$select onboarding.document_for_download(%L)$$, pg_temp.got('doc_a1'))), 'P0002|', 'nor download its documents');
select is(pg_temp.err($$select * from onboarding.gate_conditions('d2000000-0000-4000-8000-000000000000', 'activated')$$), '42501|', 'nor read its gate conditions');

-- 10. Requirements register ----------------------------------------------------------------------
select pg_temp.as_user('d1000000-0000-4000-8000-000000000005');
select is(pg_temp.err($$select onboarding.requirements_generate('d2000000-0000-4000-8000-000000000000')$$), '42501|', 'a lender cannot generate its own checklist');
select pg_temp.as_user('d1000000-0000-4000-8000-000000000001');
select cmp_ok(onboarding.requirements_generate('d2000000-0000-4000-8000-000000000000'), '>=', 6, 'the checklist is generated from templates for the lender''s category');
select is(onboarding.requirements_generate('d2000000-0000-4000-8000-000000000000'), 0, 'generating twice creates no duplicates');
select pg_temp.keep('req_1', (select id from onboarding.lender_requirements where lender_org_id = 'd2000000-0000-4000-8000-000000000000' and template_key = 'certificate_of_registration'));
select pg_temp.keep('req_2', (select id from onboarding.lender_requirements where lender_org_id = 'd2000000-0000-4000-8000-000000000000' and template_key = 'latest_audited_financials'));
select is(pg_temp.err(format($$select onboarding.requirement_set_status(%L, 'requested')$$, pg_temp.got('req_1'))), 'ok', 'Udofin requests an item');
select is(pg_temp.err(format($$select onboarding.requirement_add_dependency(%L, %L)$$, pg_temp.got('req_1'), pg_temp.got('req_2'))), 'ok', 'a dependency can be recorded');
select is(pg_temp.err(format($$select onboarding.requirement_add_dependency(%L, %L)$$, pg_temp.got('req_2'), pg_temp.got('req_1'))), '55000|', 'dependency cycles are refused');
select pg_temp.as_user('d1000000-0000-4000-8000-000000000005');
select pg_temp.keep('doc_req', onboarding.register_document('d2000000-0000-4000-8000-000000000000', 'requirement_evidence', 'Certificate (synthetic)',
  'dev/d2/req-0001', repeat('5', 64), 900, 'application/pdf'));
select is(pg_temp.err(format($$select onboarding.requirement_set_status(%L, 'accepted')$$, pg_temp.got('req_1'))), '42501|', 'the lender cannot accept its own submission');
select is(pg_temp.err(format($$select onboarding.requirement_set_status(%L, 'submitted', null, %L)$$, pg_temp.got('req_1'), pg_temp.got('doc_req'))), 'ok', 'the lender submits evidence');
select pg_temp.as_user('d1000000-0000-4000-8000-000000000001');
select is(pg_temp.err(format($$select onboarding.requirement_set_status(%L, 'under_review')$$, pg_temp.got('req_1'))), 'ok', 'Udofin starts the review');
select pg_temp.as_user('d1000000-0000-4000-8000-000000000002');
select is(pg_temp.err(format($$select onboarding.requirement_set_status(%L, 'accepted')$$, pg_temp.got('req_1'))), '55000|dependency_open',
  'an item cannot be accepted while something it depends on is open');
select is(pg_temp.err(format($$select onboarding.requirement_set_status(%L, 'waived')$$, pg_temp.got('req_2'))), '22023|', 'a waiver needs a reason');
select is(pg_temp.err(format($$select onboarding.requirement_set_status(%L, 'waived', 'Not needed for this synthetic fixture')$$, pg_temp.got('req_2'))), 'ok', 'a documented waiver closes the dependency');
select is(pg_temp.err(format($$select onboarding.requirement_set_status(%L, 'accepted')$$, pg_temp.got('req_1'))), 'ok', 'now the item is accepted');

-- 11. Contract, product and integration, then the gates in order -------------------------------------
select pg_temp.as_user('d1000000-0000-4000-8000-000000000001');
select is(pg_temp.err($$select onboarding.gate_request('d2000000-0000-4000-8000-000000000000', 'contract_onboarded')$$), '55000|gate_order', 'gates cannot be skipped');
select is(pg_temp.err($$select onboarding.gate_request('d2000000-0000-4000-8000-000000000000', 'activated')$$), '55000|gate_order', 'activation cannot be requested directly');
select pg_temp.keep('gr_1', onboarding.gate_request('d2000000-0000-4000-8000-000000000000', 'institution_verified'));
select is(pg_temp.err(format($$select onboarding.gate_decide(%L, true)$$, pg_temp.got('gr_1'))), '42501|', 'a manager cannot decide a gate');
select pg_temp.as_user('d1000000-0000-4000-8000-000000000003');
select is(pg_temp.err($$select onboarding.gate_request('d2000000-0000-4000-8000-000000000000', 'approved_for_onboarding')$$), '55000|gate_order', 'only one gate request at a time, in order');
select pg_temp.as_user('d1000000-0000-4000-8000-000000000002');
select is(pg_temp.err(format($$select onboarding.gate_decide(%L, true)$$, pg_temp.got('gr_1'))), 'ok', 'an independent approver decides');
select is((select stage from onboarding.lender_gates where lender_org_id = 'd2000000-0000-4000-8000-000000000000'), 'institution_verified', 'stage advanced exactly one step');
select pg_temp.as_user('d1000000-0000-4000-8000-000000000003');
select pg_temp.keep('gr_2', onboarding.gate_request('d2000000-0000-4000-8000-000000000000', 'approved_for_onboarding', 'Accounting record exists, may still be unconfirmed'));
select is(pg_temp.err(format($$select onboarding.gate_decide(%L, true)$$, pg_temp.got('gr_2'))), '42501|self_approval', 'nobody approves their own gate request');
select pg_temp.as_user('d1000000-0000-4000-8000-000000000002');
select onboarding.gate_decide(pg_temp.got('gr_2'), true);
select pg_temp.as_user('d1000000-0000-4000-8000-000000000001');
select is(pg_temp.err($$select onboarding.gate_request('d2000000-0000-4000-8000-000000000000', 'contract_onboarded')$$), '55000|gate_not_met', 'contractual onboarding needs a verified contract');
select pg_temp.keep('doc_con', onboarding.register_document('d2000000-0000-4000-8000-000000000000', 'contract', 'MSA (synthetic)', 'dev/d2/con-0001', repeat('6', 64), 5000, 'application/pdf'));
select pg_temp.keep('con_1', onboarding.contract_record('d2000000-0000-4000-8000-000000000000',
  format('{"contract_type": "master_services_agreement", "reference": "MSA-SYN-001", "executed_on": "2026-10-01", "document_id": "%s", "status": "executed"}', pg_temp.got('doc_con'))::jsonb));
select is(pg_temp.err(format($$select onboarding.contract_verify(%L, true)$$, pg_temp.got('con_1'))), '42501|', 'a manager cannot verify a contract');
select pg_temp.as_user('d1000000-0000-4000-8000-000000000002');
select is(pg_temp.err(format($$select onboarding.contract_verify(%L, true)$$, pg_temp.got('con_1'))), 'ok', 'an independent approver verifies the contract');
select pg_temp.as_user('d1000000-0000-4000-8000-000000000001');
select pg_temp.keep('gr_3', onboarding.gate_request('d2000000-0000-4000-8000-000000000000', 'contract_onboarded'));
select pg_temp.as_user('d1000000-0000-4000-8000-000000000002');
select onboarding.gate_decide(pg_temp.got('gr_3'), true);
-- the service can now be activated by a person who did not draft or agree it
select is(pg_temp.err(format($$select onboarding.service_activate(%L)$$, pg_temp.got('ver_a1'))), 'ok', 'after contractual onboarding an independent approver activates the agreed service');
select is((select status from onboarding.service_versions where id = pg_temp.got('ver_a1')), 'active', 'the service is active');
-- a change to a live service is a new version; the live one keeps running
select pg_temp.as_user('d1000000-0000-4000-8000-000000000001');
select pg_temp.keep('ver_a2', onboarding.service_revise(pg_temp.got('svc_a1'), '{"sla_summary": "Leads delivered within 1 business day"}'));
select is((select status from onboarding.service_versions where id = pg_temp.got('ver_a2')), 'proposed', 'a change to a live service starts a new proposed version');
select is((select status from onboarding.service_versions where id = pg_temp.got('ver_a1')), 'active', 'the live version is untouched until the change is agreed and activated');

select pg_temp.as_user('d1000000-0000-4000-8000-000000000001');
select pg_temp.keep('gr_4', onboarding.gate_request('d2000000-0000-4000-8000-000000000000', 'service_scope_agreed'));
select pg_temp.as_user('d1000000-0000-4000-8000-000000000002');
select onboarding.gate_decide(pg_temp.got('gr_4'), true);

select pg_temp.as_user('d1000000-0000-4000-8000-000000000001');
select is(pg_temp.err($$select onboarding.gate_request('d2000000-0000-4000-8000-000000000000', 'product_config_completed')$$), '55000|gate_not_met', 'product configuration must exist first');
select pg_temp.as_owner();
insert into lending.loan_products (id, lender_org_id, category_key, code, name, status) values
  ('d2900000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000000', 'personal', 'PL-ONB', 'Alpha onboarding loan', 'active');
insert into lending.loan_product_versions (id, product_id, lender_org_id, version, status, min_amount_minor, max_amount_minor,
  min_tenure_days, max_tenure_days, rate_type, min_annual_rate_bps, max_annual_rate_bps, drafted_by) values
  ('d2910000-0000-4000-8000-000000000001', 'd2900000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000000', 1, 'draft',
   1000000, 50000000, 180, 1825, 'fixed', 1400, 2400, 'd1000000-0000-4000-8000-000000000005');
select pg_temp.as_user('d1000000-0000-4000-8000-000000000001');
select pg_temp.keep('gr_5', onboarding.gate_request('d2000000-0000-4000-8000-000000000000', 'product_config_completed'));
select pg_temp.as_user('d1000000-0000-4000-8000-000000000002');
select onboarding.gate_decide(pg_temp.got('gr_5'), true);
select pg_temp.as_user('d1000000-0000-4000-8000-000000000001');
select is(pg_temp.err($$select onboarding.gate_request('d2000000-0000-4000-8000-000000000000', 'product_config_approved')$$), '55000|gate_not_met',
  'a draft product version does not satisfy the "product approved" gate');
select is((select count(*)::int from lending.borrower_visible_product_versions where lender_org_id = 'd2000000-0000-4000-8000-000000000000'), 0,
  'no product of the lender is borrower-visible yet');
select pg_temp.as_owner();
update lending.loan_product_versions set status = 'pending_approval' where id = 'd2910000-0000-4000-8000-000000000001';
update lending.loan_product_versions set status = 'approved', approved_by = 'd1000000-0000-4000-8000-000000000008', approved_at = now(), effective_from = now()
where id = 'd2910000-0000-4000-8000-000000000001';
select is((select count(*)::int from lending.borrower_visible_product_versions where lender_org_id = 'd2000000-0000-4000-8000-000000000000'), 0,
  'an approved product stays hidden from borrowers until every gate is met');
select pg_temp.as_user('d1000000-0000-4000-8000-000000000001');
select pg_temp.keep('gr_6', onboarding.gate_request('d2000000-0000-4000-8000-000000000000', 'product_config_approved'));
select pg_temp.as_user('d1000000-0000-4000-8000-000000000002');
select onboarding.gate_decide(pg_temp.got('gr_6'), true);

-- integration: a failed test blocks; a documented, independently approved exception unblocks
select pg_temp.as_user('d1000000-0000-4000-8000-000000000001');
select pg_temp.keep('int_1', onboarding.integration_create('d2000000-0000-4000-8000-000000000000', '{"kind": "rest_api", "name": "Lead hand-off API", "purpose": "Send leads to Udofin"}'));
select is(pg_temp.err(format($$select onboarding.integration_record_result(%L, 'failed', null, null, 'contract test failed in sandbox')$$, pg_temp.got('int_1'))), 'ok', 'a failed test is recorded');
select is(pg_temp.err($$select onboarding.gate_request('d2000000-0000-4000-8000-000000000000', 'integration_tested')$$), '55000|gate_not_met', 'a failed integration does not pass the gate');
select is(pg_temp.err(format($$select onboarding.integration_request_exception(%L, 'short')$$, pg_temp.got('int_1'))), '22023|', 'a manual exception must be documented');
select is(pg_temp.err(format($$select onboarding.integration_request_exception(%L, 'Lender submits files by secure e-mail until its API is ready (synthetic)')$$, pg_temp.got('int_1'))), 'ok', 'a manual exception is requested');
select is(pg_temp.err(format($$select onboarding.integration_decide_exception(%L, true)$$, pg_temp.got('int_1'))), '42501|', 'the requester (a manager) cannot approve it');
select pg_temp.as_user('d1000000-0000-4000-8000-000000000002');
select is(pg_temp.err(format($$select onboarding.integration_decide_exception(%L, true)$$, pg_temp.got('int_1'))), 'ok', 'an independent approver approves the exception');
select pg_temp.as_user('d1000000-0000-4000-8000-000000000001');
select pg_temp.keep('gr_7', onboarding.gate_request('d2000000-0000-4000-8000-000000000000', 'integration_tested'));
select pg_temp.as_user('d1000000-0000-4000-8000-000000000002');
select onboarding.gate_decide(pg_temp.got('gr_7'), true);

-- production readiness: all mandatory requirements closed, accounting verified, category signed off
select pg_temp.as_user('d1000000-0000-4000-8000-000000000001');
select is(pg_temp.err($$select onboarding.gate_request('d2000000-0000-4000-8000-000000000000', 'production_ready_approved')$$), '55000|gate_not_met',
  'open mandatory requirements block production readiness');
select pg_temp.as_user('d1000000-0000-4000-8000-000000000002');
select onboarding.requirement_set_status(id, 'waived', 'Closed for the synthetic fixture')
from onboarding.lender_requirements where lender_org_id = 'd2000000-0000-4000-8000-000000000000' and mandatory and status not in ('accepted', 'waived', 'not_applicable');
select pg_temp.as_user('d1000000-0000-4000-8000-000000000001');
select pg_temp.keep('gr_8', onboarding.gate_request('d2000000-0000-4000-8000-000000000000', 'production_ready_approved'));
select pg_temp.as_user('d1000000-0000-4000-8000-000000000002');
select onboarding.gate_decide(pg_temp.got('gr_8'), true);

select pg_temp.as_user('d1000000-0000-4000-8000-000000000001');
select pg_temp.keep('gr_9', onboarding.gate_request('d2000000-0000-4000-8000-000000000000', 'activated'));
select pg_temp.as_user('d1000000-0000-4000-8000-000000000002');
select is(pg_temp.err(format($$select onboarding.gate_decide(%L, true)$$, pg_temp.got('gr_9'))), 'ok', 'with every gate met an independent approver activates the lender');
select is((select stage from onboarding.lender_gates where lender_org_id = 'd2000000-0000-4000-8000-000000000000'), 'activated', 'the lender is activated');
select is((select count(*)::int from lending.borrower_visible_product_versions where lender_org_id = 'd2000000-0000-4000-8000-000000000000'), 1,
  'only now is the approved product borrower-visible');

-- suspension takes the lender out of borrower view again
select pg_temp.as_user('d1000000-0000-4000-8000-000000000001');
select pg_temp.keep('gr_10', onboarding.gate_request('d2000000-0000-4000-8000-000000000000', 'suspended', 'Synthetic suspension test'));
select pg_temp.as_user('d1000000-0000-4000-8000-000000000002');
select onboarding.gate_decide(pg_temp.got('gr_10'), true);
select is((select count(*)::int from lending.borrower_visible_product_versions where lender_org_id = 'd2000000-0000-4000-8000-000000000000'), 0,
  'a suspended lender''s products disappear from borrower view');

-- 12. Banks and unverified categories need compliance sign-off before activation ------------------
select pg_temp.as_user('d1000000-0000-4000-8000-000000000001');
select is((select satisfied from onboarding.gate_conditions('d4000000-0000-4000-8000-000000000000', 'production_ready_approved') where key = 'category_activation_allowed'), false,
  'a bank cannot be activated while its category lacks compliance sign-off');
select pg_temp.as_user('d1000000-0000-4000-8000-000000000002');
select is(pg_temp.err($$select onboarding.category_signoff('bank_commercial', 'RBI Master Direction (synthetic reference, 2026)')$$), '42501|', 'an approver is not the compliance officer');
select pg_temp.as_user('d1000000-0000-4000-8000-000000000004');
select is(pg_temp.err($$select onboarding.category_signoff('bank_commercial', 'short')$$), '22023|', 'the sign-off must cite the primary source reviewed');
select is(pg_temp.err($$select onboarding.category_signoff('bank_commercial', 'RBI Master Direction (synthetic reference, 2026)')$$), 'ok', 'the compliance officer signs off the category');
select pg_temp.as_user('d1000000-0000-4000-8000-000000000001');
select is((select satisfied from onboarding.gate_conditions('d4000000-0000-4000-8000-000000000000', 'production_ready_approved') where key = 'category_activation_allowed'), true,
  'after sign-off the category condition is met (the other gates still apply)');

-- 13. Audit trail and immutability ----------------------------------------------------------------
select pg_temp.as_user('d1000000-0000-4000-8000-000000000005');
select onboarding.document_for_download(pg_temp.got('doc_a1'));
select pg_temp.as_owner();
select cmp_ok((select count(*)::int from audit.events where tenant_org_id = 'd2000000-0000-4000-8000-000000000000' and action like 'onboarding.%'), '>=', 40,
  'onboarding changes are audited');
select is((select count(*)::int from audit.events where action = 'onboarding.documents.download' and tenant_org_id = 'd2000000-0000-4000-8000-000000000000'), 1,
  'document retrieval is audited');
select is((select count(*)::int from audit.events where action = 'onboarding.gate_requests.update' and metadata ->> 'status_to' = 'approved'
           and tenant_org_id = 'd2000000-0000-4000-8000-000000000000'), 10, 'every gate approval left an audit event');
select is((select count(*)::int from audit.events where tenant_org_id = 'd2000000-0000-4000-8000-000000000000'
           and (metadata::text ~* 'REG-0001|sk_live|licence copy')), 0, 'audit metadata carries column names and states, not content');
select is(pg_temp.err($$delete from onboarding.gate_requests$$), 'P0001|Record a compensating entry instead.', 'gate history cannot be deleted');
select is(pg_temp.err($$update onboarding.documents set label = 'renamed'$$), 'P0001|Record a compensating entry instead.', 'document records cannot be altered');
select is(pg_temp.err($$delete from audit.events$$), 'P0001|Record a compensating entry instead.', 'audit records cannot be deleted');
select is(pg_temp.err($$truncate onboarding.lender_gates$$), 'P0001|', 'truncate is blocked');

-- 14. Review-hardening rules ---------------------------------------------------------------------
-- A contributor cannot waive a requirement they created (manager+approver user 3).
select pg_temp.as_user('d1000000-0000-4000-8000-000000000003');
select pg_temp.keep('req_x', onboarding.requirement_create('d3000000-0000-4000-8000-000000000000', '{"title": "Contributor waiver test", "mandatory": true}'));
select is(pg_temp.err(format($$select onboarding.requirement_set_status(%L, 'waived', 'Trying to waive my own item')$$, pg_temp.got('req_x'))), '42501|self_approval',
  'the person who created a requirement cannot waive it');
select pg_temp.as_user('d1000000-0000-4000-8000-000000000002');
select is(pg_temp.err(format($$select onboarding.requirement_set_status(%L, 'waived', 'Independent approver waives with a reason')$$, pg_temp.got('req_x'))), 'ok',
  'an independent approver can waive with a reason');
-- The uploader of evidence cannot verify it (user 3 uploads, the lender submits, user 3 tries to verify).
select pg_temp.as_user('d1000000-0000-4000-8000-000000000003');
select pg_temp.keep('doc_b1', onboarding.register_document('d3000000-0000-4000-8000-000000000000', 'licence', 'Beta licence (synthetic)', 'dev/d3/lic-0001', repeat('7', 64), 800, 'application/pdf'));
select pg_temp.as_user('d1000000-0000-4000-8000-000000000006');
select onboarding.verification_submit('d3000000-0000-4000-8000-000000000000', pg_temp.got('doc_b1'));
select pg_temp.as_user('d1000000-0000-4000-8000-000000000003');
select is(pg_temp.err($$select onboarding.verification_decide('d3000000-0000-4000-8000-000000000000', true, 'Checked evidence I uploaded myself')$$), '42501|self_approval',
  'the uploader of the evidence cannot verify it');
-- Revoking the category sign-off takes a live lender out of borrower view without another request.
select pg_temp.as_owner();
update onboarding.institution_categories set activation_allowed = false where key = 'nbfc_icc';
select is(private.lender_is_live('d2000000-0000-4000-8000-000000000000'), false, 'revoking the category sign-off ends borrower visibility');
update onboarding.institution_categories set activation_allowed = true where key = 'nbfc_icc';
-- A stale pending request is cancelled by the decider and does not wedge the lender.
select pg_temp.as_owner();
insert into onboarding.gate_requests (id, lender_org_id, from_stage, target_stage, requested_by)
values ('d5000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000000', 'profile_created', 'institution_verified', 'd1000000-0000-4000-8000-000000000001');
select pg_temp.as_user('d1000000-0000-4000-8000-000000000002');
select onboarding.gate_decide('d5000000-0000-4000-8000-000000000001', true);
select is((select status from onboarding.gate_requests where id = 'd5000000-0000-4000-8000-000000000001'), 'cancelled', 'a stale gate request is cancelled and the cancellation is kept');

select * from finish();
rollback;
