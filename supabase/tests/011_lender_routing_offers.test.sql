-- Phase 06: lender selection, per-lender consent, routing, transmission, lender-reported statuses, decisions, offers, comparison.
-- Synthetic data only. Lenders are made genuinely "live" through the same facts private.lender_is_live reads.
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
create function pg_temp.keep(k text, v text) returns text language sql as $fn$ select set_config('t.' || k, v, true) $fn$;
create function pg_temp.get(k text) returns text language sql as $fn$ select current_setting('t.' || k) $fn$;

create function pg_temp.make_live(p_lender uuid, p_maker uuid, p_checker uuid) returns void language plpgsql as $fn$
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
  values (p_lender, 'nbfc_icc', 'RBI', 'TEST-REG-' || left(p_lender::text, 8), 'active', 'verified', d1, p_checker, now(), current_date, p_maker)
  on conflict (lender_org_id) do nothing;
  insert into onboarding.lender_contracts (lender_org_id, contract_type, reference, executed_on, effective_from, document_id, status, recorded_by, verified_by, verified_at)
  values (p_lender, 'lsp_agreement', 'TEST-LSP-1', current_date, current_date, d2, 'executed', p_maker, p_checker, now());
end
$fn$;

create function pg_temp.mkoffer(p_ref text, p_host text, p_apr integer, p_monthly bigint, p_total bigint, p_valid_days integer default 8) returns jsonb language sql as $fn$
  select jsonb_build_object('lenderOfferRef', p_ref, 'principalMinor', 20000000, 'tenureDays', 720, 'installmentFrequency', 'monthly', 'installmentCount', 24,
    'installmentAmountMinor', p_monthly, 'monthlyRepaymentMinor', p_monthly, 'annualInterestRateBps', 1800, 'aprBps', p_apr, 'processingFeeMinor', 200000,
    'otherCharges', '[]'::jsonb, 'totalRepayableMinor', p_total, 'penalChargesSummary', '2% p.a. on the overdue instalment amount',
    'kfsUrl', 'https://' || p_host || '/kfs/' || p_ref,
    'issuedAt', to_char((now() at time zone 'utc') - interval '1 minute', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'validUntil', to_char((now() at time zone 'utc') + make_interval(days => p_valid_days), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
$fn$;
grant execute on all functions in schema pg_temp to public;

-- Users ---------------------------------------------------------------------------------------------
insert into auth.users (id, phone, raw_app_meta_data) values
  ('11111111-1111-4111-8111-111111111111', '910000000001', '{}'),
  ('22222222-2222-4222-8222-222222222222', '910000000002', '{}'),
  ('33333333-3333-4333-8333-333333333333', '910000000003', '{}'),
  ('44444444-4444-4444-8444-444444444444', '910000000004', '{}'),
  ('aaaaaaaa-0000-4000-8000-000000000001', null, '{"actor_type":"staff"}'),
  ('aaaaaaaa-0000-4000-8000-000000000004', null, '{"actor_type":"staff"}'),
  ('bbbbbbbb-0000-4000-8000-000000000001', null, '{"actor_type":"staff"}'),
  ('cccccccc-0000-4000-8000-000000000001', null, '{"actor_type":"staff"}'),
  ('0e0e0e0e-0000-4000-8000-000000000001', null, '{"actor_type":"staff"}'),
  ('0f0f0f0f-0000-4000-8000-000000000001', null, '{"actor_type":"staff"}'),
  ('0d0d0d0d-0000-4000-8000-000000000001', null, '{"actor_type":"staff"}'),
  ('0c0c0c0c-0000-4000-8000-000000000001', null, '{"actor_type":"staff"}'),
  ('d0000000-0000-4000-8000-000000000001', null, '{"actor_type":"staff"}'),
  ('d0000000-0000-4000-8000-000000000002', null, '{"actor_type":"staff"}');

select pg_temp.as_system();
select set_config('udofin.change_apply', 'on', true);
insert into tenancy.organizations (id, kind, legal_name, display_name, regulator_registration_no, status) values
  ('a0000000-0000-4000-8000-000000000000', 'platform', 'Udofin Platform (test)', 'Udofin', null, 'active'),
  ('a1000000-0000-4000-8000-000000000000', 'lender', 'Alpha Finance Ltd (test)', 'Alpha Finance', 'TEST-NBFC-0001', 'active'),
  ('b1000000-0000-4000-8000-000000000000', 'lender', 'Beta Capital Ltd (test)', 'Beta Capital', 'TEST-NBFC-0002', 'active'),
  ('c1000000-0000-4000-8000-000000000000', 'lender', 'Gamma Credit Ltd (test)', 'Gamma Credit', 'TEST-NBFC-0003', 'active'),
  ('e1000000-0000-4000-8000-000000000001', 'lender', 'Extra One Ltd (test)', 'Extra One', 'TEST-NBFC-0011', 'active'),
  ('e1000000-0000-4000-8000-000000000002', 'lender', 'Extra Two Ltd (test)', 'Extra Two', 'TEST-NBFC-0012', 'active'),
  ('e1000000-0000-4000-8000-000000000003', 'lender', 'Extra Three Ltd (test)', 'Extra Three', 'TEST-NBFC-0013', 'active'),
  ('e1000000-0000-4000-8000-000000000004', 'lender', 'Extra Four Ltd (test)', 'Extra Four', 'TEST-NBFC-0014', 'active');
insert into tenancy.memberships (id, org_id, user_id, status) values
  ('a1a10000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000000', 'aaaaaaaa-0000-4000-8000-000000000001', 'active'),
  ('a1a10000-0000-4000-8000-000000000004', 'a1000000-0000-4000-8000-000000000000', 'aaaaaaaa-0000-4000-8000-000000000004', 'active'),
  ('b1b10000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000000', 'bbbbbbbb-0000-4000-8000-000000000001', 'active'),
  ('c1c10000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000000', 'cccccccc-0000-4000-8000-000000000001', 'active'),
  ('a0a00000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000000', '0e0e0e0e-0000-4000-8000-000000000001', 'active'),
  ('a0a00000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000000', '0f0f0f0f-0000-4000-8000-000000000001', 'active'),
  ('a0a00000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000000', '0c0c0c0c-0000-4000-8000-000000000001', 'active');
insert into tenancy.membership_roles (membership_id, role_id)
select m, (select id from tenancy.roles where org_id is null and applies_to = k::tenancy.organization_kind and key = r)
from (values
  ('a1a10000-0000-4000-8000-000000000001'::uuid, 'lender', 'credit_officer'),
  ('a1a10000-0000-4000-8000-000000000004'::uuid, 'lender', 'viewer'),
  ('b1b10000-0000-4000-8000-000000000001'::uuid, 'lender', 'credit_officer'),
  ('c1c10000-0000-4000-8000-000000000001'::uuid, 'lender', 'credit_officer'),
  ('a0a00000-0000-4000-8000-000000000001'::uuid, 'platform', 'platform_admin'),
  ('a0a00000-0000-4000-8000-000000000002'::uuid, 'platform', 'platform_admin'),
  ('a0a00000-0000-4000-8000-000000000003'::uuid, 'platform', 'operations_agent')
) as g (m, k, r);

-- A product drafter (lender_admin) and approver (product_approver) in every lender, as the product rules require.
insert into tenancy.memberships (org_id, user_id, status)
select o.id, u, 'active' from tenancy.organizations o, (values ('d0000000-0000-4000-8000-000000000001'::uuid), ('d0000000-0000-4000-8000-000000000002')) x (u) where o.kind = 'lender';
insert into tenancy.membership_roles (membership_id, role_id)
select m.id, (select id from tenancy.roles where org_id is null and applies_to = 'lender' and key = case m.user_id when 'd0000000-0000-4000-8000-000000000001' then 'lender_admin' else 'product_approver' end)
from tenancy.memberships m where m.user_id in ('d0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000002');

-- Products and live lenders ------------------------------------------------------------------------------
insert into lending.loan_products (id, lender_org_id, category_key, code, name, status)
select md5('prod' || l::text)::uuid, l, 'personal', 'PL-STD', n, 'active'
from (values ('a1000000-0000-4000-8000-000000000000'::uuid, 'Alpha Personal Loan'), ('b1000000-0000-4000-8000-000000000000', 'Beta Personal Loan'),
             ('c1000000-0000-4000-8000-000000000000', 'Gamma Personal Loan'), ('e1000000-0000-4000-8000-000000000001', 'Extra One Loan'),
             ('e1000000-0000-4000-8000-000000000002', 'Extra Two Loan'), ('e1000000-0000-4000-8000-000000000003', 'Extra Three Loan'),
             ('e1000000-0000-4000-8000-000000000004', 'Extra Four Loan')) as t (l, n);
insert into lending.loan_product_versions (id, product_id, lender_org_id, version, status, min_amount_minor, max_amount_minor, min_tenure_days, max_tenure_days,
  rate_type, min_annual_rate_bps, max_annual_rate_bps, drafted_by, approved_by, approved_at, effective_from)
select md5('ver' || p.lender_org_id::text)::uuid, p.id, p.lender_org_id, 1, 'approved', 1000000, 50000000, 180, 1825,
       'fixed', 1400, 2400, 'd0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000002', now(), now()
from lending.loan_products p;
select pg_temp.make_live(l, 'aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000001')
from (values ('a1000000-0000-4000-8000-000000000000'::uuid), ('b1000000-0000-4000-8000-000000000000'), ('c1000000-0000-4000-8000-000000000000')) as t (l);

-- Connectors: Alpha and Gamma work manually in the portal, Beta through an API connector (a real one does not exist yet).
insert into lending.lender_connectors (lender_org_id, kind, status, kfs_allowed_hosts, signing_secret_ref) values
  ('a1000000-0000-4000-8000-000000000000', 'manual', 'active', array['kfs.alpha.example'], null),
  ('b1000000-0000-4000-8000-000000000000', 'api', 'active', array['kfs.beta.example'], 'BETA_CALLBACK_SECRET'),
  ('c1000000-0000-4000-8000-000000000000', 'manual', 'active', array['kfs.gamma.example'], null);

-- Lender-specific wording. Beta's first version is unapproved.
insert into consent.notices (id, purpose, version, language, lender_org_id, title, body_markdown, status, published_at, drafted_by, approved_by, review_status) values
  ('f1000000-0000-4000-8000-00000000000a', 'share_with_lender', 1, 'en', 'a1000000-0000-4000-8000-000000000000', 'Share with Alpha', 'Alpha wording v1', 'published', now(), 'aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000001', 'approved'),
  ('f1000000-0000-4000-8000-00000000000b', 'share_with_lender', 1, 'en', 'b1000000-0000-4000-8000-000000000000', 'Share with Beta', 'Beta wording v1', 'published', now(), 'aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000001', 'requires_review'),
  ('f1000000-0000-4000-8000-00000000000c', 'share_with_lender', 1, 'en', 'c1000000-0000-4000-8000-000000000000', 'Share with Gamma', 'Gamma wording v1', 'published', now(), 'aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000001', 'approved');

-- Requests (already submitted through the Phase 05 flow) ----------------------------------------------------------
insert into lending.loan_requests (id, borrower_id, category_key, requested_amount_minor, requested_tenure_days, purpose_code, status, submission_reference)
select ('70000000-0000-4000-8000-00000000000' || n)::uuid, (select id from identity.borrowers where user_id = u::uuid), 'personal', a, t, 'home_renovation', 'submitted', 'UR-AAAAAAAAA' || n
from (values (1, '11111111-1111-4111-8111-111111111111', 20000000, 720), (2, '22222222-2222-4222-8222-222222222222', 10000000, 365),
             (3, '33333333-3333-4333-8333-333333333333', 10000000, 365), (4, '44444444-4444-4444-8444-444444444444', 10000000, 365)) as x (n, u, a, t);
-- Four earlier applications for request 2 (other lenders), so the five-lender cap can be tested without five live lenders.
insert into lending.applications (lender_org_id, loan_request_id, borrower_id, product_version_id, status, requested_amount_minor, requested_tenure_days)
select o, '70000000-0000-4000-8000-000000000002', (select id from identity.borrowers where user_id = '22222222-2222-4222-8222-222222222222'),
       md5('ver' || o::text)::uuid, 'submitted', 10000000, 365
from (values ('e1000000-0000-4000-8000-000000000001'::uuid), ('e1000000-0000-4000-8000-000000000002'), ('e1000000-0000-4000-8000-000000000003'), ('e1000000-0000-4000-8000-000000000004')) t (o);

-- 1. Connectors and platform staff ------------------------------------------------------------------------
select pg_temp.as_user('0e0e0e0e-0000-4000-8000-000000000001');
select is(pg_temp.err($$select lending.set_lender_connector('e1000000-0000-4000-8000-000000000001', 'mock', 'active', 48, 7, '{}', null)$$), '22023|connector_kind_invalid', 'a mock connector cannot be configured through the function');
select is(pg_temp.err($$select lending.set_lender_connector('e1000000-0000-4000-8000-000000000001', 'api', 'active', 48, 7, '{}', null)$$), '22023|signing_secret_required', 'an api connector must name its signing secret');
select is(pg_temp.err($$select lending.set_lender_connector('e1000000-0000-4000-8000-000000000001', 'manual', 'draft', 48, 3, '{}', null)$$) like '23514|%', true, 'an offer-validity floor below seven days is refused');
select is(pg_temp.err($$select lending.set_lender_connector('e1000000-0000-4000-8000-000000000001', 'manual', 'draft', 48, 7, array['Bad Host/x'], null)$$) like '23514|%', true, 'a malformed KFS host is refused');
select is(pg_temp.err($$select lending.set_lender_connector('e1000000-0000-4000-8000-000000000001', 'manual', 'draft', 48, 7, array['kfs.extra.example'], null)$$), 'ok', 'platform staff configure a manual connector');
select is((select response_hours from lending.lender_connectors where lender_org_id = 'e1000000-0000-4000-8000-000000000001'), 48, 'the response window defaults to 48 hours');
select pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001');
select is(pg_temp.err($$select lending.set_lender_connector('a1000000-0000-4000-8000-000000000000', 'manual', 'active', 48, 7, '{}', null)$$), '42501|', 'a lender cannot configure its own connector');
select pg_temp.as_owner();
select is(pg_temp.err($$insert into lending.lender_connectors (lender_org_id, kind, status) values ('e1000000-0000-4000-8000-000000000002', 'mock', 'active')$$), '42501|mock_connector_blocked', 'a mock connector cannot be stored unless the session allows it (tests only)');

-- 2. Selection: nothing is preselected, limits are enforced by the database ---------------------------------------
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
select is((select count(*) from lending.lender_selections), 0::bigint, 'no lender is selected before the borrower chooses');
select is((select count(*) from lending.matching_products('70000000-0000-4000-8000-000000000001')), 3::bigint, 'only live lenders with an active connector and a matching approved product are offered');
select is(pg_temp.err($$select lending.select_lenders('70000000-0000-4000-8000-000000000001', '[{"lenderId":"a1000000-0000-4000-8000-000000000000"},{"lenderId":"b1000000-0000-4000-8000-000000000000"},{"lenderId":"c1000000-0000-4000-8000-000000000000"},{"lenderId":"e1000000-0000-4000-8000-000000000001"},{"lenderId":"e1000000-0000-4000-8000-000000000002"},{"lenderId":"e1000000-0000-4000-8000-000000000003"}]')$$), '22023|too_many_lenders', 'more than five lenders are refused');
select is(pg_temp.err($$select lending.select_lenders('70000000-0000-4000-8000-000000000001', '[{"lenderId":"a1000000-0000-4000-8000-000000000000"},{"lenderId":"a1000000-0000-4000-8000-000000000000"}]')$$), '22023|duplicate_lender', 'the same lender twice is refused');
select is(pg_temp.err($$select lending.select_lenders('70000000-0000-4000-8000-000000000001', '[{"lenderId":"e1000000-0000-4000-8000-000000000003"}]')$$), '55000|lender_not_available', 'a lender that is not live with an active connector cannot be selected');
select is(pg_temp.err(format($$select lending.select_lenders('70000000-0000-4000-8000-000000000001', '[{"lenderId":"a1000000-0000-4000-8000-000000000000","productVersionId":"%s"}]')$$, md5('ver' || 'b1000000-0000-4000-8000-000000000000')::uuid)), '55000|product_unavailable', 'another lender''s product cannot be attached');
select is(pg_temp.err($$select lending.select_lenders('70000000-0000-4000-8000-000000000001', '[]')$$), '22023|selection_empty', 'an empty selection is refused');
select is(pg_temp.err($$select lending.select_lenders('70000000-0000-4000-8000-000000000001', '[{"lenderId":"not-a-uuid"}]')$$), '22023|invalid_selection', 'malformed input is refused');
select pg_temp.keep('sel1', lending.select_lenders('70000000-0000-4000-8000-000000000001',
  '[{"lenderId":"a1000000-0000-4000-8000-000000000000"},{"lenderId":"b1000000-0000-4000-8000-000000000000"},{"lenderId":"c1000000-0000-4000-8000-000000000000"}]')::text);
select is((select count(*) from lending.lender_selection_items where selection_id = pg_temp.get('sel1')::uuid and status = 'selected'), 3::bigint, 'the selection records each lender and its product');
select is((select count(*) from lending.applications where loan_request_id = '70000000-0000-4000-8000-000000000001'), 0::bigint, 'selecting creates no application');

-- 3. Per-lender consent ------------------------------------------------------------------------------------------
select is(jsonb_array_length(lending.selection_view('70000000-0000-4000-8000-000000000001', 'en') -> 'items'), 3, 'the selection screen lists the three chosen lenders');
select is((select i -> 'notice' ->> 'reviewStatus' from jsonb_array_elements(lending.selection_view('70000000-0000-4000-8000-000000000001', 'en') -> 'items') i where i ->> 'lenderName' = 'Beta Capital'), 'requires_review', 'unapproved lender wording is shown as such');
select is((select i -> 'notice' ->> 'languageFallback' from jsonb_array_elements(lending.selection_view('70000000-0000-4000-8000-000000000001', 'hi') -> 'items') i where i ->> 'lenderName' = 'Alpha Finance'), 'true', 'a language without published wording falls back to English and says so');
select is(pg_temp.err($$select lending.route_selection(pg_temp.get('sel1')::uuid)$$), '55000|consent_required', 'routing is refused without consent');
select is(pg_temp.err($$select consent.record_lender_decision('70000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-00000000000b', 'granted', '1.0.0', 'consent')$$), 'P0002|', 'another lender''s wording cannot authorise sharing with this lender');
select is(pg_temp.err($$select consent.record_lender_decision('70000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-00000000000b', 'granted', '1.0.0', 'consent')$$), '55000|wording_not_approved', 'unapproved lender wording cannot be the basis of consent');
select is(pg_temp.err($$select consent.record_decision('f1000000-0000-4000-8000-00000000000a', 'granted', '1.0.0', 'consent')$$), '22023|purpose_unsupported', 'the platform consent function does not record lender consent');
select is(pg_temp.err($$select consent.record_lender_decision('70000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-00000000000a', 'granted', '1.0.0', 'consent')$$), 'ok', 'consent for Alpha is recorded against Alpha''s wording');
select is((select evidence ->> 'scope' from consent.records where lender_org_id = 'a1000000-0000-4000-8000-000000000000'), 'minimum_payload_v1', 'the evidence names the sharing scope');
select is((select evidence ->> 'loan_request_id' from consent.records where lender_org_id = 'a1000000-0000-4000-8000-000000000000'), '70000000-0000-4000-8000-000000000001', 'and the request');
select is(pg_temp.err($$select lending.route_selection(pg_temp.get('sel1')::uuid)$$), '55000|consent_required', 'consent for one lender does not cover the others (all or nothing)');
select pg_temp.as_owner();
-- Beta publishes approved wording (version 2); the unapproved version 1 is no longer the latest.
insert into consent.notices (id, purpose, version, language, lender_org_id, title, body_markdown, status, published_at, drafted_by, approved_by, review_status)
values ('f2000000-0000-4000-8000-00000000000b', 'share_with_lender', 2, 'en', 'b1000000-0000-4000-8000-000000000000', 'Share with Beta', 'Beta wording v2', 'published', now(),
        'aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000001', 'approved');
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
select is(pg_temp.err($$select consent.record_lender_decision('70000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-00000000000b', 'granted', '1.0.0', 'consent')$$), '55000|wording_not_approved', 'the old version is still refused');
select consent.record_lender_decision('70000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000000', 'f2000000-0000-4000-8000-00000000000b', 'granted', '1.0.0', 'consent');
select consent.record_lender_decision('70000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-00000000000c', 'granted', '1.0.0', 'consent');
select is((select count(*) from consent.records where borrower_id = (select id from identity.borrowers where user_id = '11111111-1111-4111-8111-111111111111') and lender_org_id is not null), 3::bigint, 'each lender has its own consent record');

-- 4. Routing: applications exist only after consent; payload never stored ---------------------------------------------
select pg_temp.keep('routed1', lending.route_selection(pg_temp.get('sel1')::uuid)::text);
select is(jsonb_array_length(pg_temp.get('routed1')::jsonb), 3, 'three applications are created, one per consented lender');
select is((select count(*) from lending.applications where loan_request_id = '70000000-0000-4000-8000-000000000001' and status = 'submitted'), 3::bigint, 'each follows the existing lifecycle (submitted)');
select is((select string_agg(transmission_status, ',' order by lender_org_id) from lending.application_routing where loan_request_id = '70000000-0000-4000-8000-000000000001'), 'transmitted,queued,transmitted', 'manual lenders see the application in their portal at once; the API lender is queued');
select is((select count(*) from lending.application_routing where loan_request_id = '70000000-0000-4000-8000-000000000001' and response_due_at - created_at between interval '47 hours 59 minutes' and interval '48 hours 1 minute'), 3::bigint, 'the default response deadline is 48 hours');
select pg_temp.as_owner();
select is((select count(*) from ops.outbox_events where event_type = 'application.routed' and payload ? 'application_id'), 1::bigint, 'only the API lender produces a transmission job');
select is((select payload::text from ops.outbox_events where event_type = 'application.routed') ~ '9100000000', false, 'the job carries no phone number');
select is((select count(*) from lending.application_routing r where to_jsonb(r)::text like '%910000000001%'), 0::bigint, 'no phone number in the routing table');
select is((select count(*) from lending.routing_events e where to_jsonb(e)::text like '%910000000001%'), 0::bigint, 'nor in routing events');
select is((select count(*) from audit.events e where to_jsonb(e)::text like '%910000000001%'), 0::bigint, 'nor in the audit trail');
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
select is(pg_temp.err($$select lending.route_selection(pg_temp.get('sel1')::uuid)$$), '55000|selection_closed', 'routing the same selection again creates nothing');
select is(pg_temp.err($$select lending.select_lenders('70000000-0000-4000-8000-000000000001', '[{"lenderId":"a1000000-0000-4000-8000-000000000000"}]')$$), '55000|already_routed', 'a lender already routed is no longer offered for this request');
select is(pg_temp.errs($$insert into lending.applications (lender_org_id, loan_request_id, borrower_id, product_version_id, requested_amount_minor, requested_tenure_days) select lender_org_id, loan_request_id, borrower_id, product_version_id, 1, 1 from lending.applications limit 1$$), '42501', 'a borrower cannot create an application directly');
select is(pg_temp.errs($$update lending.application_routing set transmission_status = 'acknowledged'$$), '42501', 'nor change routing state');
select is(pg_temp.errs($$select lending.begin_transmission((select application_id from lending.application_routing limit 1))$$), '42501', 'nor run the transmission step');

select pg_temp.as_owner();
select pg_temp.keep('appB1', (select application_id::text from lending.application_routing where loan_request_id = '70000000-0000-4000-8000-000000000001' and lender_org_id = 'b1000000-0000-4000-8000-000000000000'));
select pg_temp.keep('appA1', (select application_id::text from lending.application_routing where loan_request_id = '70000000-0000-4000-8000-000000000001' and lender_org_id = 'a1000000-0000-4000-8000-000000000000'));
select pg_temp.keep('appC1', (select application_id::text from lending.application_routing where loan_request_id = '70000000-0000-4000-8000-000000000001' and lender_org_id = 'c1000000-0000-4000-8000-000000000000'));
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');

-- 5. Five-lender cap counts everything ever routed for the request ------------------------------------------------------
select pg_temp.as_user('22222222-2222-4222-8222-222222222222');
select is(pg_temp.err($$select lending.select_lenders('70000000-0000-4000-8000-000000000002', '[{"lenderId":"a1000000-0000-4000-8000-000000000000"},{"lenderId":"b1000000-0000-4000-8000-000000000000"}]')$$), '22023|too_many_lenders', 'earlier applications count towards the cap of five');
select pg_temp.keep('sel2', lending.select_lenders('70000000-0000-4000-8000-000000000002', '[{"lenderId":"a1000000-0000-4000-8000-000000000000"}]')::text);
select consent.record_lender_decision('70000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-00000000000a', 'granted', '1.0.0', 'consent');
select is(jsonb_array_length(lending.route_selection(pg_temp.get('sel2')::uuid)), 1, 'the fifth lender can still be added');
select is(pg_temp.err($$select lending.select_lenders('70000000-0000-4000-8000-000000000002', '[{"lenderId":"b1000000-0000-4000-8000-000000000000"}]')$$), '22023|too_many_lenders', 'a sixth cannot, however the calls are repeated');

-- 6. Isolation between borrowers ------------------------------------------------------------------------------------------
select is(pg_temp.err($$select lending.select_lenders('70000000-0000-4000-8000-000000000001', '[{"lenderId":"a1000000-0000-4000-8000-000000000000"}]')$$), 'P0002|', 'borrower 2 cannot use borrower 1''s request');
select is(pg_temp.err($$select lending.my_applications('70000000-0000-4000-8000-000000000001')$$), 'P0002|', 'nor read its applications');
select is(pg_temp.err($$select lending.compare_offers('70000000-0000-4000-8000-000000000001', null, 'android', 'en')$$), 'P0002|', 'nor compare its offers');
select is((select count(*) from lending.application_routing where loan_request_id = '70000000-0000-4000-8000-000000000001'), 0::bigint, 'routing rows of another borrower are invisible');
select pg_temp.as_user('22222222-2222-4222-8222-222222222222');
select is(pg_temp.err(format($$select lending.withdraw_application(%L)$$, pg_temp.get('appA1'))), 'P0002|', 'and so is withdrawing it');

-- 7. Transmission (the worker) ---------------------------------------------------------------------------------------------
select pg_temp.as_system();
select pg_temp.keep('tx1', lending.begin_transmission(pg_temp.get('appB1')::uuid)::text);
select is((select array_agg(k order by k collate "C") from jsonb_object_keys(pg_temp.get('tx1')::jsonb -> 'payload') k), array['displayName', 'language', 'phone', 'productVersionId', 'request', 'udofinReference'], 'the lender payload has exactly the approved fields');
select is((select array_agg(k order by k collate "C") from jsonb_object_keys(pg_temp.get('tx1')::jsonb -> 'payload' -> 'request') k), array['amountMinor', 'categoryKey', 'purposeCode', 'tenureDays'], 'and the request has exactly the approved fields');
select is(pg_temp.get('tx1')::jsonb -> 'payload' ->> 'phone', '910000000001', 'the phone number comes from the authentication record at send time');
select is(pg_temp.get('tx1') ~ '(?i)pan|aadhaar|birth|income|account', false, 'nothing sensitive can appear in the payload');
select is(lending.begin_transmission(pg_temp.get('appB1')::uuid) ->> 'skip', 'transmitting', 'a second pickup does nothing (no duplicate send)');
select is(lending.record_transmission_result(pg_temp.get('appB1')::uuid, 'unknown', null, 'timeout'), 'uncertain', 'a timeout leaves the outcome uncertain, not failed');
select is(lending.begin_transmission(pg_temp.get('appB1')::uuid) ->> 'skip', 'uncertain', 'an uncertain application is not sent blindly again');
select is(lending.resolve_uncertain(pg_temp.get('appB1')::uuid, 'unknown', null), 'uncertain', 'still unknown after checking: stays uncertain');
select is(lending.resolve_uncertain(pg_temp.get('appB1')::uuid, 'not_found', null), 'queued', 'confirmed absent: one more send is allowed');
select pg_temp.as_owner();
select is((select count(*) from ops.outbox_events where event_type = 'application.routed' and payload ->> 'application_id' = pg_temp.get('appB1')), 2::bigint, 'with a new job (distinct de-duplication key)');
select pg_temp.as_system();
select is(lending.begin_transmission(pg_temp.get('appB1')::uuid) ->> 'attempt', '2', 'the second attempt is counted');
select is(lending.record_transmission_result(pg_temp.get('appB1')::uuid, 'accepted', 'BETA-APP-77', null), 'acknowledged', 'accepted with the lender reference: acknowledged');
select is(lending.record_transmission_result(pg_temp.get('appB1')::uuid, 'rejected', null, 'x'), 'acknowledged', 'a repeat result changes nothing');
select is((select lender_application_ref from lending.application_routing where application_id = pg_temp.get('appB1')::uuid), 'BETA-APP-77', 'the lender''s own reference is stored only when given');

-- 8. Lender portal: isolation and permissions ------------------------------------------------------------------------------------
select pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001');
select is(jsonb_array_length(lending.lender_applications(20, null, null)), 2, 'Alpha sees its two applications (borrowers 1 and 2) and no other lender''s');
select is(lending.lender_applications(20, null, null)::text ~ '(borrowerId|borrower_id|910000)', false, 'the queue carries no borrower id or phone number');
select is(pg_temp.err(format($$select lending.lender_application_detail(%L)$$, pg_temp.get('appB1'))), 'P0002|', 'Alpha cannot open Beta''s application');
select is(pg_temp.err(format($$select lending.lender_record_decision(%L, 'processing', null, null)$$, pg_temp.get('appB1'))), 'P0002|', 'nor decide on it');
select is(pg_temp.err(format($$select lending.lender_contact(%L)$$, pg_temp.get('appB1'))), 'P0002|', 'nor read its contact detail');
select pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000004');
select is(pg_temp.err(format($$select lending.lender_ack_application(%L, 'A-1')$$, pg_temp.get('appA1'))), '42501|', 'a read-only lender user cannot act');
select pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001', 'aal1');
select is(pg_temp.err(format($$select lending.lender_ack_application(%L, 'A-1')$$, pg_temp.get('appA1'))) like '42501|%', true, 'acting requires a second factor (aal2)');
select pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001');
select is(pg_temp.err(format($$select lending.lender_ack_application(%L, 'ALPHA-APP-1')$$, pg_temp.get('appA1'))), 'ok', 'the credit officer acknowledges receipt');
select is(pg_temp.err(format($$select lending.lender_ack_application(%L, 'OTHER-REF')$$, pg_temp.get('appA1'))), '55000|reference_conflict', 'a different reference is refused, not silently replaced');
select is(pg_temp.err(format($$select lending.lender_report_check(%L, 'kyc', 'in_progress', 'KYC-1', null)$$, pg_temp.get('appA1'))), 'ok', 'a KYC status is recorded as reported by the lender');
select is(pg_temp.err(format($$select lending.lender_report_check(%L, 'kyc', 'verified', null, null)$$, pg_temp.get('appA1'))), '22023|status_unknown', 'only the controlled status values are accepted');
select is(pg_temp.err(format($$select lending.lender_report_check(%L, 'pan_number', 'completed', null, null)$$, pg_temp.get('appA1'))), '22023|status_unknown', 'and only the three verification kinds');
select is(pg_temp.err(format($$select lending.lender_report_check(%L, 'bureau', 'completed', null, now() + interval '1 day')$$, pg_temp.get('appA1'))), '22023|time_invalid', 'a reported time in the future is refused');
select lending.lender_report_check(pg_temp.get('appA1')::uuid, 'kyc', 'completed', 'KYC-2', null);
select is((select status from lending.application_check_status where application_id = pg_temp.get('appA1')::uuid and kind = 'kyc'), 'completed', 'the latest report is the current one');
select is((select count(*) from lending.application_checks where application_id = pg_temp.get('appA1')::uuid), 2::bigint, 'and history is kept');
select is(pg_temp.errs($$insert into lending.application_checks (application_id, lender_org_id, kind, status, source, reported_at) select application_id, lender_org_id, 'kyc', 'completed', 'manual', now() from lending.application_routing limit 1$$), '42501', 'a lender cannot write check rows directly');
select is(pg_temp.err(format($$select lending.lender_submit_offer(%L, %L::jsonb)$$, pg_temp.get('appA1'), pg_temp.mkoffer('A-OFFER-0', 'kfs.alpha.example', 2050, 1000000, 24000000))), '55000|application_not_approved', 'an offer cannot be entered before the lender reports an approval');
select is(pg_temp.err(format($$select lending.lender_record_decision(%L, 'maybe', null, null)$$, pg_temp.get('appA1'))), '22023|decision_unknown', 'unknown decisions are refused');
select lending.lender_record_decision(pg_temp.get('appA1')::uuid, 'processing', null, null);
select is((select status::text from lending.applications where id = pg_temp.get('appA1')::uuid), 'under_review', 'processing moves the application to under review');
select is(pg_temp.err(format($$select lending.lender_contact(%L)$$, pg_temp.get('appA1'))), 'ok', 'the lender reads the contact detail while consent is in force');
select lending.lender_record_decision(pg_temp.get('appA1')::uuid, 'approved', null, null);
select is((select status::text from lending.applications where id = pg_temp.get('appA1')::uuid), 'approved', 'an approval reported by the lender is recorded');
select is(pg_temp.err(format($$select lending.lender_record_decision(%L, 'processing', null, null)$$, pg_temp.get('appA1'))), '55000|invalid_transition', 'a decision that does not fit the lifecycle is refused');

-- 9. Offers: structural checks only, nothing recalculated ---------------------------------------------------------------------------
select is(lending.lender_submit_offer(pg_temp.get('appA1')::uuid, (pg_temp.mkoffer('A-OFFER-1', 'kfs.alpha.example', 2050, 1000000, 24000000) - 'kfsUrl'))::jsonb -> 'issues' ? 'kfs_url_missing', true, 'an offer without a KFS link is held');
select is(lending.lender_submit_offer(pg_temp.get('appA1')::uuid, pg_temp.mkoffer('A-OFFER-1', 'evil.example', 2050, 1000000, 24000000)) -> 'issues' ? 'kfs_host_not_allowed', true, 'a KFS link on a host the lender has not registered is held');
select is(lending.lender_submit_offer(pg_temp.get('appA1')::uuid, pg_temp.mkoffer('A-OFFER-1', 'kfs.alpha.example', 2050, 1000000, 24000000, 6)) -> 'issues' ? 'validity_too_short', true, 'validity under seven days is held');
select is(lending.lender_submit_offer(pg_temp.get('appA1')::uuid, jsonb_set(pg_temp.mkoffer('A-OFFER-1', 'kfs.alpha.example', 2050, 1000000, 24000000), '{principalMinor}', '1000.5'::jsonb)) -> 'issues' ? 'principal_invalid', true, 'a fractional amount is held, not rounded');
select is(lending.lender_submit_offer(pg_temp.get('appA1')::uuid, jsonb_set(pg_temp.mkoffer('A-OFFER-1', 'kfs.alpha.example', 2050, 1000000, 24000000), '{kfsUrl}', '"http://kfs.alpha.example/x"')) -> 'issues' ? 'kfs_url_invalid', true, 'a non-https KFS link is held');
select is(lending.lender_submit_offer(pg_temp.get('appA1')::uuid, jsonb_set(pg_temp.mkoffer('A-OFFER-1', 'kfs.alpha.example', 2050, 1000000, 24000000), '{kfsUrl}', '"https://user:pw@kfs.alpha.example/x"')) -> 'issues' ? 'kfs_url_invalid', true, 'a KFS link with embedded credentials is held');
select is(lending.lender_submit_offer(pg_temp.get('appA1')::uuid, pg_temp.mkoffer('A-OFFER-1', 'kfs.alpha.example', 2050, 1000000, 24000000) || '{"pan":"ABCDE1234F"}') -> 'issues' ? 'unknown_field', true, 'an unknown field is flagged');
select pg_temp.as_owner();
select is((select submitted ? 'pan' from lending.offer_intake where issues @> array['unknown_field'] limit 1), false, 'and is never stored');
select is((select count(*) from lending.offers where application_id = pg_temp.get('appA1')::uuid), 0::bigint, 'held offers create no offer');
select pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001');
select is(lending.lender_submit_offer(pg_temp.get('appA1')::uuid, pg_temp.mkoffer('A-OFFER-1', 'kfs.alpha.example', 2050, 1000000, 24000000)) ->> 'status', 'accepted', 'a complete offer is accepted');
select pg_temp.as_owner();
select is((select row(apr_bps, monthly_repayment_minor, total_repayable_minor, installment_amount_minor, principal_minor)::text from lending.offers where lender_offer_ref = 'A-OFFER-1'),
          '(2050,1000000,24000000,1000000,20000000)', 'the stored values are exactly the lender''s');
select pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001');
select lending.lender_submit_offer(pg_temp.get('appA1')::uuid, pg_temp.mkoffer('A-OFFER-1', 'kfs.alpha.example', 2050, 1000000, 23900000));
select pg_temp.as_owner();
select is((select string_agg(revision::text || ':' || status::text, ',' order by revision) from lending.offers where application_id = pg_temp.get('appA1')::uuid), '1:withdrawn,2:issued', 'a corrected offer is a new revision; the old one is kept as withdrawn');
select is((select count(*) from lending.offers where application_id = pg_temp.get('appA1')::uuid and supersedes_offer_id is not null), 1::bigint, 'and points at what it replaces');

-- 10. Callbacks (Beta) ---------------------------------------------------------------------------------------------------------------
select pg_temp.keep('corrB1', (select correlation_ref::text from lending.application_routing where application_id = pg_temp.get('appB1')::uuid));
select pg_temp.keep('corrA1', (select correlation_ref::text from lending.application_routing where application_id = pg_temp.get('appA1')::uuid));
select pg_temp.as_system();
select is(lending.ingest_lender_event('b1000000-0000-4000-8000-000000000000', 'msg-b-0001', 'decision', pg_temp.get('corrB1')::uuid, '{"decision":"approved"}') ->> 'outcome', 'applied', 'a decision callback is applied');
select is(lending.ingest_lender_event('b1000000-0000-4000-8000-000000000000', 'msg-b-0001', 'decision', pg_temp.get('corrB1')::uuid, '{"decision":"declined"}') ->> 'outcome', 'duplicate', 'the same message id is never applied twice');
select is((select status::text from lending.applications where id = pg_temp.get('appB1')::uuid), 'approved', 'so the first meaning stands');
select is(lending.ingest_lender_event('a1000000-0000-4000-8000-000000000000', 'msg-a-0001', 'decision', pg_temp.get('corrB1')::uuid, '{"decision":"declined"}') ->> 'reason', 'unknown_application', 'one lender cannot touch another lender''s application');
select is(lending.ingest_lender_event('b1000000-0000-4000-8000-000000000000', 'msg-b-0002', 'decision', gen_random_uuid(), '{"decision":"declined"}') ->> 'reason', 'unknown_application', 'an unknown application reference is rejected');
select is(lending.ingest_lender_event('b1000000-0000-4000-8000-000000000000', 'msg-b-0003', 'mystery', pg_temp.get('corrB1')::uuid, '{}') ->> 'outcome', 'quarantined', 'an unrecognised event type is quarantined, not forced in');
select is(lending.ingest_lender_event('b1000000-0000-4000-8000-000000000000', 'msg-b-0004', 'decision', pg_temp.get('corrB1')::uuid, '{"decision":"processing"}') ->> 'reason', 'invalid_transition', 'a state change the lifecycle forbids is rejected');
select is(lending.ingest_lender_event('b1000000-0000-4000-8000-000000000000', 'msg-b-0005', 'decision', pg_temp.get('corrB1')::uuid, '{"decision":"maybe"}') ->> 'reason', 'decision_unknown', 'an unknown decision value is rejected');
select is(pg_temp.err($$select lending.ingest_lender_event('b1000000-0000-4000-8000-000000000000', 'x', 'ack', gen_random_uuid(), '{}')$$) like '23514|%', true, 'a malformed message id is refused');
select is(lending.ingest_lender_event('b1000000-0000-4000-8000-000000000000', 'msg-b-0006', 'check', pg_temp.get('corrB1')::uuid, '{"kind":"bureau","status":"completed","lenderEventRef":"BUR-9"}') ->> 'outcome', 'applied', 'a verification status arrives as status only');
select pg_temp.keep('offerB', pg_temp.mkoffer('B-OFFER-1', 'kfs.beta.example', 2050, 1010000, 23500000)::text);
select is(lending.ingest_lender_event('b1000000-0000-4000-8000-000000000000', 'msg-b-0007', 'offer', pg_temp.get('corrB1')::uuid, jsonb_build_object('offer', pg_temp.get('offerB')::jsonb)) ->> 'outcome', 'applied', 'an offer callback is validated and stored');
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
select is(pg_temp.errs($$select lending.ingest_lender_event('b1000000-0000-4000-8000-000000000000', 'msg-b-0099', 'ack', gen_random_uuid(), '{}')$$), '42501', 'only the system can ingest callbacks');
select is(pg_temp.errs($$select lending.process_deadlines()$$), '42501', 'nor run the deadline job');

-- 11. Decline and the non-offer classes; the comparison ----------------------------------------------------------------------------------------
select pg_temp.as_user('cccccccc-0000-4000-8000-000000000001');
select lending.lender_record_decision(pg_temp.get('appC1')::uuid, 'declined', null, null);
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
select is(pg_temp.err($$select lending.compare_offers('70000000-0000-4000-8000-000000000001', null, 'android', 'en')$$), '55000|ranking_rule_not_approved', 'without an approved ordering rule the comparison is not served (D-16 open)');
select pg_temp.as_user('0e0e0e0e-0000-4000-8000-000000000001');
select pg_temp.keep('prop', lending.propose_matching_rule('Offers are ordered by the lender-supplied APR, lowest first, then by the lender-supplied monthly repayment.', 'Lender-supplied APR, then monthly repayment', array['apr_bps', 'monthly_repayment_minor'], array['monthly_repayment_minor', 'total_repayable_minor'], now())::text);
select is(pg_temp.err($$select lending.decide_matching_rule(pg_temp.get('prop')::uuid, true)$$), '42501|segregation_of_duties', 'the proposer cannot approve their own rule');
select pg_temp.as_user('0c0c0c0c-0000-4000-8000-000000000001');
select is(pg_temp.err($$select lending.decide_matching_rule(pg_temp.get('prop')::uuid, true)$$), '42501|', 'staff without the permission cannot approve');
select pg_temp.as_user('0f0f0f0f-0000-4000-8000-000000000001');
select is(lending.decide_matching_rule(pg_temp.get('prop')::uuid, true) is not null, true, 'a different platform administrator approves');
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
select pg_temp.keep('cmp1', lending.compare_offers('70000000-0000-4000-8000-000000000001', null, 'android', 'en')::text);
select is(jsonb_array_length(pg_temp.get('cmp1')::jsonb -> 'offers'), 2, 'both valid offers are shown');
select is((select array_agg(o ->> 'lenderName' order by (o ->> 'rank')::int) from jsonb_array_elements(pg_temp.get('cmp1')::jsonb -> 'offers') o), array['Alpha Finance', 'Beta Capital'], 'equal APR: the lower lender-supplied monthly repayment ranks first');
select is((select array_agg(k order by k collate "C") from jsonb_object_keys((pg_temp.get('cmp1')::jsonb -> 'offers' -> 0)) k),
          array['applicationId', 'aprBps', 'kfsUrl', 'lenderId', 'lenderName', 'monthlyRepaymentMinor', 'offerId', 'penalChargesSummary', 'principalMinor', 'productName', 'rank', 'revised', 'revision', 'tenureDays', 'validUntil'],
          'each offer carries the six required fields and the KFS link (plus identifiers), and nothing derived');
select is((pg_temp.get('cmp1')::jsonb -> 'nonOffers' -> 0 ->> 'reason'), 'declined', 'the lender that declined is named with the truthful reason');
select is(jsonb_array_length(pg_temp.get('cmp1')::jsonb -> 'nonOffers'), 1, 'and only that lender');
select is((pg_temp.get('cmp1')::jsonb -> 'rule' ->> 'version'), '1', 'the rule version is part of the answer');
select is((pg_temp.get('cmp1')::text ~* '(recommend|best|countdown|expires in)'), false, 'no recommendation, badge or countdown text exists in the data');
select pg_temp.keep('cmp2', lending.compare_offers('70000000-0000-4000-8000-000000000001', 'total_repayable_minor', 'android', 'en')::text);
select is((select array_agg(o ->> 'lenderName' order by (o ->> 'rank')::int) from jsonb_array_elements(pg_temp.get('cmp2')::jsonb -> 'offers') o), array['Beta Capital', 'Alpha Finance'], 'the borrower can re-sort by an approved alternative (total repayable)');
select is(pg_temp.err($$select lending.compare_offers('70000000-0000-4000-8000-000000000001', 'borrower_score', 'android', 'en')$$), '22023|sort_unsupported', 'other sorts are refused');
select pg_temp.as_owner();
select is((select count(*) from lending.comparison_runs where borrower_id = (select id from identity.borrowers where user_id = '11111111-1111-4111-8111-111111111111')), 2::bigint, 'every comparison served is logged');
select is((select count(*) from lending.offer_displays where run_id = (pg_temp.get('cmp1')::jsonb ->> 'runId')::uuid and rule_version_id is not null and rank_position in (1, 2)), 2::bigint, 'with each offer''s rank and rule version');
select is((select count(*) from lending.comparison_nonoffers where run_id = (pg_temp.get('cmp1')::jsonb ->> 'runId')::uuid and reason_class = 'declined'), 1::bigint, 'and the lenders that did not offer');
select is((select count(*) from audit.events where action = 'lending.comparison.viewed'), 2::bigint, 'plus an audit event per view');
select is(pg_temp.err($$update lending.comparison_runs set sort_key = 'x'$$) like 'P0001|%', true, 'the log cannot be rewritten');

-- 12. iOS filter (D-19) stays off unless switched on; it never alters the APR ------------------------------------------------------------------
select pg_temp.as_user('bbbbbbbb-0000-4000-8000-000000000001');
select lending.lender_submit_offer(pg_temp.get('appB1')::uuid, pg_temp.mkoffer('B-OFFER-1', 'kfs.beta.example', 3700, 1010000, 23500000));
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
select is(jsonb_array_length(lending.compare_offers('70000000-0000-4000-8000-000000000001', null, 'ios', 'en') -> 'offers'), 2, 'iOS shows every offer while the filter is off');
select pg_temp.as_owner();
update onboarding.platform_settings set bool_value = true where key = 'ios_apr_filter_enabled';
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
select pg_temp.keep('ios', lending.compare_offers('70000000-0000-4000-8000-000000000001', null, 'ios', 'en')::text);
select is(jsonb_array_length(pg_temp.get('ios')::jsonb -> 'offers'), 1, 'with the filter on, an iOS comparison omits an offer above 36% APR');
select is((pg_temp.get('ios')::jsonb ->> 'filteredCount'), '1', 'and records that it did');
select is(jsonb_array_length(pg_temp.get('ios')::jsonb -> 'nonOffers'), 1, 'the filtered lender is not mislabelled as a non-offer (only the decliner is listed)');
select is(jsonb_array_length(lending.compare_offers('70000000-0000-4000-8000-000000000001', null, 'android', 'en') -> 'offers'), 2, 'Android is unaffected');
select pg_temp.as_owner();
update onboarding.platform_settings set bool_value = false where key = 'ios_apr_filter_enabled';

-- 13. Expiry and withdrawal are never shown as available ------------------------------------------------------------------------------------------
alter table lending.offers disable trigger offers_protect;
update lending.offers set valid_until = now() - interval '1 minute' where application_id = pg_temp.get('appB1')::uuid and status = 'issued';
alter table lending.offers enable trigger offers_protect;
select pg_temp.as_system();
select is((lending.process_deadlines() ->> 'offersExpired'), '1', 'an offer past its validity is marked expired by the job');
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
select pg_temp.keep('cmp3', lending.compare_offers('70000000-0000-4000-8000-000000000001', null, 'android', 'en')::text);
select is(jsonb_array_length(pg_temp.get('cmp3')::jsonb -> 'offers'), 1, 'an expired offer is not shown');
select is((select o ->> 'reason' from jsonb_array_elements(pg_temp.get('cmp3')::jsonb -> 'nonOffers') o where o ->> 'lenderName' = 'Beta Capital'), 'offer_unavailable', 'its lender is named with an accurate reason');
select pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001');
select lending.lender_withdraw_offer(pg_temp.get('appA1')::uuid, 'A-OFFER-1');
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
select is(jsonb_array_length(lending.compare_offers('70000000-0000-4000-8000-000000000001', null, 'android', 'en') -> 'offers'), 0, 'a withdrawn offer is not shown, and an empty comparison is simply empty');

-- 14. Response deadline: silence is not a decline; late answers are held ---------------------------------------------------------------------------------
select pg_temp.as_owner();
update lending.application_routing set response_due_at = now() - interval '1 hour' where loan_request_id = '70000000-0000-4000-8000-000000000002' and lender_org_id = 'a1000000-0000-4000-8000-000000000000';
select pg_temp.as_system();
select is((lending.process_deadlines() ->> 'noResponse'), '1', 'the job marks a lender that has not answered by the deadline');
select is((lending.process_deadlines() ->> 'noResponse'), '0', 'and is safe to repeat');
select pg_temp.as_owner();
select is((select status::text from lending.applications where loan_request_id = '70000000-0000-4000-8000-000000000002' and lender_org_id = 'a1000000-0000-4000-8000-000000000000'), 'submitted', 'the application is not declined or deleted');
select pg_temp.as_user('22222222-2222-4222-8222-222222222222');
select is((select o ->> 'reason' from jsonb_array_elements(lending.compare_offers('70000000-0000-4000-8000-000000000002', null, 'android', 'en') -> 'nonOffers') o), 'no_response', 'the borrower sees "no response", not "declined"');
select pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001');
select is(lending.lender_record_decision((select application_id from lending.application_routing where loan_request_id = '70000000-0000-4000-8000-000000000002'), 'declined', null, null) ->> 'note', 'late_response_policy_pending', 'a late decision is recorded and flagged, not silently applied');
select pg_temp.as_owner();
select is((select status::text from lending.applications where loan_request_id = '70000000-0000-4000-8000-000000000002' and lender_org_id = 'a1000000-0000-4000-8000-000000000000'), 'submitted', 'it changes nothing until a late-response policy exists (D-40)');

-- 15. Withdrawing consent: before sending, and after sending begins --------------------------------------------------------------------------------------
select pg_temp.as_user('33333333-3333-4333-8333-333333333333');
select pg_temp.keep('sel3', lending.select_lenders('70000000-0000-4000-8000-000000000003', '[{"lenderId":"b1000000-0000-4000-8000-000000000000"}]')::text);
select consent.record_lender_decision('70000000-0000-4000-8000-000000000003', 'b1000000-0000-4000-8000-000000000000', 'f2000000-0000-4000-8000-00000000000b', 'granted', '1.0.0', 'consent');
select pg_temp.keep('routed3', lending.route_selection(pg_temp.get('sel3')::uuid)::text);
select consent.record_lender_decision('70000000-0000-4000-8000-000000000003', 'b1000000-0000-4000-8000-000000000000', 'f2000000-0000-4000-8000-00000000000b', 'withdrawn', '1.0.0', 'settings');
select pg_temp.as_system();
select pg_temp.keep('appB3', (pg_temp.get('routed3')::jsonb -> 0 ->> 'applicationId'));
select is(lending.begin_transmission(pg_temp.get('appB3')::uuid) ->> 'skip', 'stopped_consent', 'consent withdrawn before sending: nothing is sent and no contact detail is read');
select pg_temp.as_owner();
select is((select status::text from lending.applications where id = pg_temp.get('appB3')::uuid), 'withdrawn', 'and the application is withdrawn');
select pg_temp.as_user('44444444-4444-4444-8444-444444444444');
select pg_temp.keep('sel4', lending.select_lenders('70000000-0000-4000-8000-000000000004', '[{"lenderId":"b1000000-0000-4000-8000-000000000000"}]')::text);
select consent.record_lender_decision('70000000-0000-4000-8000-000000000004', 'b1000000-0000-4000-8000-000000000000', 'f2000000-0000-4000-8000-00000000000b', 'granted', '1.0.0', 'consent');
select pg_temp.keep('routed4', lending.route_selection(pg_temp.get('sel4')::uuid)::text);
select pg_temp.as_owner();
-- Beta publishes new approved wording before the job runs: the earlier consent no longer covers a NEW transmission.
insert into consent.notices (id, purpose, version, language, lender_org_id, title, body_markdown, status, published_at, drafted_by, approved_by, review_status)
values ('f3000000-0000-4000-8000-00000000000b', 'share_with_lender', 3, 'en', 'b1000000-0000-4000-8000-000000000000', 'Share with Beta', 'Beta wording v3', 'published', now(),
        'aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000001', 'approved');
select pg_temp.as_system();
select is(lending.begin_transmission((pg_temp.get('routed4')::jsonb -> 0 ->> 'applicationId')::uuid) ->> 'skip', 'stopped_consent', 'consent given on superseded wording does not authorise a new transmission');

-- A worker that died after beginning to send: after five minutes the outcome counts as unknown, never as "not sent".
select pg_temp.as_owner();
alter table lending.application_routing disable trigger application_routing_updated;
update lending.application_routing set transmission_status = 'transmitting', updated_at = now() - interval '6 minutes' where application_id = pg_temp.get('appB1')::uuid;
alter table lending.application_routing enable trigger application_routing_updated;
select pg_temp.as_system();
select is(lending.begin_transmission(pg_temp.get('appB1')::uuid) ->> 'skip', 'uncertain', 'an interrupted send is treated as uncertain, not as unsent');
select is((select last_error_class from lending.application_routing where application_id = pg_temp.get('appB1')::uuid), 'worker_interrupted', 'and the reason is kept');
select is(lending.reconcile_context(pg_temp.get('appB1')::uuid) ->> 'connectorKind', 'api', 'the worker can ask the lender about an uncertain application');
select is(lending.reconcile_context(pg_temp.get('appA1')::uuid), null, 'and nothing is returned for an application that is not uncertain');

-- Consent withdrawn after the data was sent: recorded, not pretended undone; the lender can no longer read the contact detail.
select pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001');
select is(pg_temp.err(format($$select lending.lender_contact(%L)$$, pg_temp.get('appA1'))), 'ok', 'while consent holds, Alpha can read the contact detail');
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
select consent.record_lender_decision('70000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-00000000000a', 'withdrawn', '1.0.0', 'settings');
select pg_temp.as_owner();
select is((select count(*) from lending.routing_events where application_id = pg_temp.get('appA1')::uuid and event = 'consent_withdrawn_after_transmission'), 1::bigint, 'withdrawal after sending leaves an event for the lender-side process (D-41)');
select pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001');
select is(pg_temp.err(format($$select lending.lender_contact(%L)$$, pg_temp.get('appA1'))), '55000|consent_required', 'after withdrawal the lender can no longer read the contact detail');
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
select is((select count(*) from jsonb_array_elements(lending.compare_offers('70000000-0000-4000-8000-000000000001', null, 'android', 'en') -> 'nonOffers') o where o ->> 'lenderName' = 'Alpha Finance'), 0::bigint, 'a lender whose consent was withdrawn is no longer named or shown');

select * from finish();
rollback;
