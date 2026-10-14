-- Remediation of the database findings in the Phase 01 audit and the Phase 02 review (migration 20261017000905):
--   outbox operations, foreign-key index coverage, payment-success guard (R-01), loan-account history (R-05),
--   Phase 07 leftovers (per-lender proposal numbers, idempotent e-mail notice, template engine check, register_upload,
--   self-approval toggle, KFS projection) and the Phase 06 tests the security review asked for (retired-notice
--   withdrawal, stale-transmitting sweep, borrower name hidden after withdrawal).
-- Synthetic data only.
begin;
create extension if not exists pgtap with schema extensions;
select plan(142);

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

-- A declared-facts package for a lender that issues its own KFS file (kfs_declared_v1).
create function pg_temp.mkdecl(p_no text, p_until_days numeric default 14, p_apr integer default 1707) returns jsonb language sql as $fn$
  select jsonb_build_object('schema', 'kfs_declared_v1', 'proposalNo', p_no, 'sanctionedAmountMinor', 2000000, 'tenureDays', 720, 'aprBps', p_apr,
    'kfsValidFrom', to_char((now() at time zone 'utc') - interval '1 minute', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'kfsValidUntil', to_char((now() at time zone 'utc') + make_interval(secs => p_until_days * 86400), 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
$fn$;
grant execute on all functions in schema pg_temp to public;

-- Users ---------------------------------------------------------------------------------------------------------------------
insert into auth.users (id, phone, raw_app_meta_data) values
  ('11111111-1111-4111-8111-111111111111', '910000000001', '{}'),
  ('22222222-2222-4222-8222-222222222222', '910000000002', '{}'),
  ('aaaaaaaa-0000-4000-8000-000000000001', null, '{"actor_type":"staff"}'),
  ('aaaaaaaa-0000-4000-8000-000000000002', null, '{"actor_type":"staff"}'),
  ('bbbbbbbb-0000-4000-8000-000000000001', null, '{"actor_type":"staff"}'),
  ('0e0e0e0e-0000-4000-8000-000000000001', null, '{"actor_type":"staff"}'),
  ('0f0f0f0f-0000-4000-8000-000000000001', null, '{"actor_type":"staff"}'),
  ('d0000000-0000-4000-8000-000000000001', null, '{"actor_type":"staff"}'),
  ('d0000000-0000-4000-8000-000000000002', null, '{"actor_type":"staff"}');

select pg_temp.as_system();
select set_config('udofin.change_apply', 'on', true);
insert into tenancy.organizations (id, kind, legal_name, display_name, regulator_registration_no, status) values
  ('a0000000-0000-4000-8000-000000000000', 'platform', 'Udofin Platform (test)', 'Udofin', null, 'active'),
  ('a1000000-0000-4000-8000-000000000000', 'lender', 'Alpha Finance Ltd (test)', 'Alpha Finance', 'TEST-NBFC-0001', 'active'),
  ('b1000000-0000-4000-8000-000000000000', 'lender', 'Beta Capital Ltd (test)', 'Beta Capital', 'TEST-NBFC-0002', 'active');
insert into tenancy.memberships (id, org_id, user_id, status) values
  ('a1a10000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000000', 'aaaaaaaa-0000-4000-8000-000000000001', 'active'),
  ('a1a10000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000000', 'aaaaaaaa-0000-4000-8000-000000000002', 'active'),
  ('b1b10000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000000', 'bbbbbbbb-0000-4000-8000-000000000001', 'active'),
  ('a0a00000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000000', '0e0e0e0e-0000-4000-8000-000000000001', 'active'),
  ('a0a00000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000000', '0f0f0f0f-0000-4000-8000-000000000001', 'active');
insert into tenancy.membership_roles (membership_id, role_id)
select m, (select id from tenancy.roles where org_id is null and applies_to = k::tenancy.organization_kind and key = r)
from (values
  ('a1a10000-0000-4000-8000-000000000001'::uuid, 'lender', 'credit_officer'),
  ('a1a10000-0000-4000-8000-000000000002'::uuid, 'lender', 'lender_admin'),
  ('b1b10000-0000-4000-8000-000000000001'::uuid, 'lender', 'credit_officer'),
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
from (values ('a1000000-0000-4000-8000-000000000000'::uuid, 'Alpha Personal Loan'), ('b1000000-0000-4000-8000-000000000000', 'Beta Personal Loan')) as t (l, n);
insert into lending.loan_product_versions (id, product_id, lender_org_id, version, status, min_amount_minor, max_amount_minor, min_tenure_days, max_tenure_days,
  rate_type, min_annual_rate_bps, max_annual_rate_bps, drafted_by, approved_by, approved_at, effective_from)
select md5('ver' || p.lender_org_id::text)::uuid, p.id, p.lender_org_id, 1, 'approved', 1000000, 50000000, 180, 1825,
       'fixed', 1400, 2400, 'd0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000002', now(), now()
from lending.loan_products p;
select pg_temp.make_live('a1000000-0000-4000-8000-000000000000', 'aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000001');
select pg_temp.make_live('b1000000-0000-4000-8000-000000000000', 'aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000001');
-- Alpha works manually in the portal; Beta through an API connector (a real one does not exist yet).
insert into lending.lender_connectors (lender_org_id, kind, status, kfs_allowed_hosts, signing_secret_ref) values
  ('a1000000-0000-4000-8000-000000000000', 'manual', 'active', array['kfs.alpha.example'], null),
  ('b1000000-0000-4000-8000-000000000000', 'api', 'active', array['kfs.beta.example'], 'BETA_CALLBACK_SECRET');
insert into consent.notices (id, purpose, version, language, lender_org_id, title, body_markdown, status, published_at, drafted_by, approved_by, review_status) values
  ('f1000000-0000-4000-8000-00000000000a', 'share_with_lender', 1, 'en', 'a1000000-0000-4000-8000-000000000000', 'Share with Alpha', 'Alpha wording v1', 'published', now(), 'aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000001', 'approved'),
  ('f1000000-0000-4000-8000-00000000000b', 'share_with_lender', 1, 'en', 'b1000000-0000-4000-8000-000000000000', 'Share with Beta', 'Beta wording v1', 'published', now(), 'aaaaaaaa-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000001', 'approved');
-- Four requests: 1 and 2 go through the Phase 06 routing functions; 3 and 4 carry directly inserted applications for the document tests.
insert into lending.loan_requests (id, borrower_id, category_key, requested_amount_minor, requested_tenure_days, purpose_code, status, submission_reference)
select ('70000000-0000-4000-8000-00000000000' || n)::uuid, (select id from identity.borrowers where user_id = u::uuid), 'personal', 2000000, 720, 'home_renovation', 'submitted', 'UR-CCCCCCCCC' || n
from (values (1, '11111111-1111-4111-8111-111111111111'), (2, '22222222-2222-4222-8222-222222222222'),
             (3, '11111111-1111-4111-8111-111111111111'), (4, '22222222-2222-4222-8222-222222222222')) as x (n, u);
insert into lending.applications (id, lender_org_id, loan_request_id, borrower_id, product_version_id, status, requested_amount_minor, requested_tenure_days)
select a, l, r, (select borrower_id from lending.loan_requests where id = r), md5('ver' || l::text)::uuid, 'submitted', 2000000, 720
from (values ('a2000000-0000-4000-8000-000000000001'::uuid, 'a1000000-0000-4000-8000-000000000000'::uuid, '70000000-0000-4000-8000-000000000003'::uuid),
             ('a2000000-0000-4000-8000-000000000002', 'b1000000-0000-4000-8000-000000000000', '70000000-0000-4000-8000-000000000003'),
             ('a2000000-0000-4000-8000-000000000003', 'a1000000-0000-4000-8000-000000000000', '70000000-0000-4000-8000-000000000004')) as t (a, l, r);
update lending.applications set status = 'under_review' where id::text like 'a2000000%';
update lending.applications set status = 'approved' where id::text like 'a2000000%';
insert into lending.offers (id, lender_org_id, application_id, status, principal_minor, tenure_days, installment_frequency, installment_count, installment_amount_minor,
  annual_interest_rate_bps, apr_bps, processing_fee_minor, other_charges, total_repayable_minor, penal_charges_summary, valid_until, monthly_repayment_minor,
  kfs_url, lender_offer_ref, revision, lender_issued_at, source)
select ('0f000000-0000-4000-8000-00000000000' || n)::uuid, l, a, 'issued', 2000000, 720, 'monthly', 24, 97000, 1500, 1707, 24000, '[]', 2327400,
       '2% per annum on the overdue amount', now() + interval '30 days', 97000, 'https://kfs.alpha.example/k/' || n, 'OFFER-' || n, 1, now(), 'manual'
from (values (1, 'a1000000-0000-4000-8000-000000000000'::uuid, 'a2000000-0000-4000-8000-000000000001'::uuid),
             (2, 'b1000000-0000-4000-8000-000000000000', 'a2000000-0000-4000-8000-000000000002'),
             (3, 'a1000000-0000-4000-8000-000000000000', 'a2000000-0000-4000-8000-000000000003')) as t (n, l, a);

-- ============================================================================================================================
-- 1. Outbox operations: ops.outbox_health() and ops.requeue_dead_event(id, operator). (First, so the counts are not disturbed.)
-- ============================================================================================================================
select pg_temp.as_system();
select pg_temp.keep('ob_base_dead', (ops.outbox_health() -> 'byStatus' ->> 'dead'));
select pg_temp.keep('ev_dead', ops.enqueue_event('test.requeue', '{"ref":"payload-must-not-leak"}', null, 'dedupe-test-requeue-0001')::text);
select is((select count(*) from ops.claim_outbox_events('worker-test', 100, interval '1 minute') where id = pg_temp.get('ev_dead')::uuid), 1::bigint, 'a worker claims the event');
select is(ops.fail_outbox_event(pg_temp.get('ev_dead')::uuid, 'worker-test', 'test_failure', true)::text, 'dead', 'a permanent failure makes it dead');
select pg_temp.keep('ev_ready', ops.enqueue_event('test.ready', '{"ref":"r"}', null, 'dedupe-test-ready-00001', now() - interval '2 minutes')::text);
select pg_temp.keep('ev_later', ops.enqueue_event('test.later', '{"ref":"l"}', null, 'dedupe-test-later-00001', now() + interval '1 hour')::text);

select is((ops.outbox_health() -> 'byStatus' ->> 'dead')::bigint, pg_temp.get('ob_base_dead')::bigint + 1, 'health counts the dead event');
select is((ops.outbox_health() ->> 'deadCount')::bigint, (ops.outbox_health() -> 'byStatus' ->> 'dead')::bigint, 'and reports the number of dead events separately');
select is((select array_agg(k order by k) from jsonb_object_keys(ops.outbox_health() -> 'byStatus') k), array['completed', 'dead', 'pending', 'processing'], 'counts exist for every status');
select ok((ops.outbox_health() ->> 'oldestPendingAgeSeconds')::bigint >= 120, 'the oldest ready pending event is at least two minutes old');
select ok((ops.outbox_health() ->> 'oldestDeadAgeSeconds') is not null, 'the age of the oldest dead event is reported');
select is(ops.outbox_health()::text ~ 'payload-must-not-leak', false, 'health output contains no payload content');
select pg_temp.as_owner();
delete from ops.outbox_events where id = pg_temp.get('ev_ready')::uuid;
select pg_temp.as_system();
select is((ops.outbox_health() ->> 'oldestPendingAgeSeconds'), null, 'an event waiting for a future retry time is not counted as stuck (no ready event: null)');

select is(ops.requeue_dead_event(pg_temp.get('ev_later')::uuid, 'operator.test'), false, 'a pending event is not replayed');
select is(ops.requeue_dead_event('00000000-0000-4000-8000-0000000000ff', 'operator.test'), false, 'an unknown event is not replayed');
select is(pg_temp.err(format($$select ops.requeue_dead_event(%L, 'someone@example.com')$$, pg_temp.get('ev_dead'))), '22023|', 'an e-mail address is not accepted as the operator identifier');
select is(pg_temp.err(format($$select ops.requeue_dead_event(%L, null)$$, pg_temp.get('ev_dead'))), '22023|', 'an operator identifier is required');
select is((select status::text from ops.outbox_events where id = pg_temp.get('ev_dead')::uuid), 'dead', 'and the event is still dead after those refusals');
select is(ops.requeue_dead_event(pg_temp.get('ev_dead')::uuid, 'operator.test'), true, 'a dead event is replayed by a named operator');
select is((select (status::text, attempts, last_error_code, locked_by is null)::text from ops.outbox_events where id = pg_temp.get('ev_dead')::uuid), '(pending,0,test_failure,t)',
  'it is pending again with a fresh attempt budget; the last error code stays visible on the row');
select is(ops.requeue_dead_event(pg_temp.get('ev_dead')::uuid, 'operator.test'), false, 'replaying it twice does nothing');
select pg_temp.as_owner();
select is((select count(*) from audit.events where action = 'ops.outbox.requeued' and entity_id = pg_temp.get('ev_dead')), 1::bigint, 'the replay left exactly one audit record');
select is((select array_agg(k order by k) from audit.events e, jsonb_object_keys(e.metadata) k where e.action = 'ops.outbox.requeued' and e.entity_id = pg_temp.get('ev_dead')),
  array['event_type', 'operator', 'previous_attempts', 'previous_error_code'], 'which holds the operator, type, previous attempts and error code only');
select is((select e.metadata::text ~ 'payload-must-not-leak' from audit.events e where e.action = 'ops.outbox.requeued' and e.entity_id = pg_temp.get('ev_dead')), false, 'and no payload content');
select is((select e.metadata ->> 'previous_attempts' from audit.events e where e.action = 'ops.outbox.requeued' and e.entity_id = pg_temp.get('ev_dead')), '1', 'previous attempts are kept in the record although the counter was reset');
-- The older one-argument form still works and is audited too.
update ops.outbox_events set status = 'dead', attempts = 8, last_error_code = 'second_failure' where id = pg_temp.get('ev_dead')::uuid;
select pg_temp.as_system();
select is(ops.requeue_dead_event(pg_temp.get('ev_dead')::uuid), true, 'the one-argument form still replays');
select pg_temp.as_owner();
select is((select count(*) from audit.events where action = 'ops.outbox.requeued' and entity_id = pg_temp.get('ev_dead') and metadata ->> 'operator' = 'unspecified'), 1::bigint, 'and is audited with an unspecified operator');
select is((select bool_or(has_function_privilege(r, 'ops.requeue_dead_event(uuid, text)', 'EXECUTE') or has_function_privilege(r, 'ops.outbox_health()', 'EXECUTE'))
           from unnest(array['anon', 'authenticated', 'public']) r), false, 'neither anon, authenticated nor PUBLIC may execute the replay or health functions');
select is((has_function_privilege('service_role', 'ops.requeue_dead_event(uuid, text)', 'EXECUTE') and has_function_privilege('service_role', 'ops.outbox_health()', 'EXECUTE')), true, 'the system role may');
select pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001');
select is(pg_temp.err(format($$select ops.requeue_dead_event(%L, 'operator.test')$$, pg_temp.get('ev_dead'))), '42501|', 'a signed-in lender user cannot replay events');
select is(pg_temp.err($$select ops.outbox_health()$$), '42501|', 'nor read the outbox health');
select pg_temp.as_owner();
set local role anon;
select throws_ok($$select ops.outbox_health()$$, '42501', null, 'anon is refused');
select pg_temp.as_owner();

-- ============================================================================================================================
-- 2. Foreign keys without a supporting index: the deliberate exceptions are exactly this list (see the migration header).
--    A new foreign key without an index fails here until it is indexed or consciously added with a reason.
-- ============================================================================================================================
create temp table fk_unindexed as
with fks as (
  select con.conrelid, con.conkey, con.confdeltype,
         n.nspname || '.' || c.relname as tbl,
         (select string_agg(a.attname, ', ' order by k.ord) from unnest(con.conkey) with ordinality k (attnum, ord)
            join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum) as cols,
         (select a.attname from pg_attribute a where a.attrelid = con.conrelid and a.attnum = con.conkey[1]) as first_col,
         con.confrelid::regclass::text as ref
  from pg_constraint con
  join pg_class c on c.oid = con.conrelid
  join pg_namespace n on n.oid = c.relnamespace
  where con.contype = 'f'
    and n.nspname in ('tenancy', 'identity', 'consent', 'audit', 'lending', 'servicing', 'payments', 'onboarding', 'documents', 'ops')
)
select f.tbl || '(' || f.cols || ')' as fk, f.ref, f.confdeltype, f.first_col, cardinality(f.conkey) as width
from fks f
where not exists (
  select 1 from pg_index i
  where i.indrelid = f.conrelid and i.indisvalid and i.indnkeyatts >= 1
    and (
      -- a plain index whose leading columns are the key columns, in any order
      (i.indpred is null and i.indnkeyatts >= cardinality(f.conkey)
        and (select array_agg(x order by x) from unnest((i.indkey::int2[])[0:cardinality(f.conkey) - 1]) x) = (select array_agg(x order by x) from unnest(f.conkey) x))
      -- a composite key (id, lender_org_id): an index led by the parent's id identifies the parent row
      or (i.indpred is null and cardinality(f.conkey) > 1 and i.indkey[0] = f.conkey[1])
      -- a single-column key with a partial index "where <column> is not null"
      or (cardinality(f.conkey) = 1 and i.indkey[0] = f.conkey[1] and pg_get_expr(i.indpred, i.indrelid) = '(' || f.first_col || ' IS NOT NULL)')
    )
);
select is(
  (select array_agg(fk order by fk) from fk_unindexed
    -- Actor-attribution columns to auth.users (created_by, approved_by, ..., actor_id; ON DELETE NO ACTION) are exempt as a rule.
    where not (ref = 'auth.users' and confdeltype = 'a' and width = 1 and first_col ~ '(_by|actor_id)$')),
  (select array_agg(x order by x) from unnest(array[
    'consent.records(notice_id)',
    'documents.acceptances(acknowledgement_id)',
    'documents.acknowledgements(rule_id)',
    'documents.acknowledgements(template_id)',
    'documents.acknowledgements(wording_notice_id)',
    'documents.applicability_rules(document_type)',
    'documents.generation_jobs(document_type)',
    'documents.generation_jobs(kfs_input_id, offer_id)',
    'documents.generation_jobs(template_id)',
    'documents.items(document_type)',
    'documents.items(kfs_calendar_id)',
    'documents.items(kfs_input_id, offer_id)',
    'documents.items(rule_id)',
    'documents.items(superseded_by_id)',
    'documents.items(supersedes_id)',
    'documents.items(template_id)',
    'documents.templates(document_type)',
    'lending.application_routing(consent_record_id)',
    'lending.application_routing(selection_item_id)',
    'lending.comparison_runs(rule_version_id)',
    'lending.lender_selection_items(consent_record_id)',
    'lending.lender_selection_items(product_version_id, lender_org_id)',
    'lending.loan_requests(category_key)',
    'lending.loan_requests(product_version_id)',
    'lending.matching_rule_proposals(resulting_version_id)',
    'lending.panel_views(lender_org_id)',
    'onboarding.accounting_profiles(evidence_document_id, lender_org_id)',
    'onboarding.integrations(service_id, lender_org_id)',
    'onboarding.integrations(test_evidence_document_id, lender_org_id)',
    'onboarding.lender_contracts(document_id, lender_org_id)',
    'onboarding.lender_profiles(category_key)',
    'onboarding.lender_profiles(verification_evidence_id, lender_org_id)',
    'onboarding.lender_requirements(evidence_document_id, lender_org_id)',
    'onboarding.lender_requirements(integration_id, lender_org_id)',
    'onboarding.lender_requirements(product_id, lender_org_id)',
    'onboarding.lender_requirements(service_id, lender_org_id)',
    'onboarding.lender_requirements(template_key)',
    'onboarding.lender_services(category_key)',
    'onboarding.requirement_dependencies(depends_on_id, lender_org_id)',
    'onboarding.requirement_templates(applies_to_service_category)',
    'onboarding.verification_history(evidence_document_id, lender_org_id)',
    'tenancy.memberships(user_id)'
  ]) x),
  'the foreign keys without a supporting index are exactly the documented exceptions');
select is((select count(*) from fk_unindexed where ref = 'auth.users' and not (confdeltype = 'a' and width = 1 and first_col ~ '(_by|actor_id)$')), 1::bigint,
  'the only other unindexed key to auth.users is tenancy.memberships(user_id), served by a partial index for active members');
select is((select count(*) from pg_indexes where schemaname = 'tenancy' and indexname = 'memberships_user'), 1::bigint, 'that partial index exists');

-- ============================================================================================================================
-- 3. R-01: a payment intent succeeds only on a matching, verified, successful provider event; R-05: loan-account history
-- ============================================================================================================================
select pg_temp.as_system();
insert into servicing.loan_accounts (id, lender_org_id, application_id, borrower_id, source_system, lms_loan_ref, status, sanctioned_amount_minor)
values ('a4000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000000', 'a2000000-0000-4000-8000-000000000001',
        (select id from identity.borrowers where user_id = '11111111-1111-4111-8111-111111111111'), 'lender_lms', 'ALPHA-LN-1', 'active', 2000000),
       ('b4000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000000', 'a2000000-0000-4000-8000-000000000002',
        (select id from identity.borrowers where user_id = '11111111-1111-4111-8111-111111111111'), 'lender_lms', 'BETA-LN-1', 'active', 8000000);
insert into payments.payment_intents (id, lender_org_id, loan_account_id, borrower_id, purpose, amount_minor, settlement_account_ref, provider, idempotency_key) values
  ('a6000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000000', 'a4000000-0000-4000-8000-000000000001',
   (select id from identity.borrowers where user_id = '11111111-1111-4111-8111-111111111111'), 'installment', 475000, 'alpha-collections', 'mock_gateway', 'idem-pi-0000000000001'),
  ('a6000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000000', 'a4000000-0000-4000-8000-000000000001',
   (select id from identity.borrowers where user_id = '11111111-1111-4111-8111-111111111111'), 'installment', 500000, 'alpha-collections', 'mock_gateway', 'idem-pi-0000000000002'),
  ('a6000000-0000-4000-8000-000000000003', 'a1000000-0000-4000-8000-000000000000', 'a4000000-0000-4000-8000-000000000001',
   (select id from identity.borrowers where user_id = '11111111-1111-4111-8111-111111111111'), 'installment', 100000, 'alpha-collections', 'mock_gateway', 'idem-pi-0000000000003'),
  ('b6000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000000', 'b4000000-0000-4000-8000-000000000001',
   (select id from identity.borrowers where user_id = '11111111-1111-4111-8111-111111111111'), 'installment', 300000, 'beta-collections', 'mock_gateway', 'idem-pi-0000000000004');
update payments.payment_intents set status = 'pending' where id::text like '%6000000-0000-4000-8000-00000000000_';

select is(private.payment_success_statuses(), array['captured', 'paid', 'succeeded'], 'the success statuses are an explicit list');
select throws_ok($$update payments.payment_intents set status = 'succeeded' where id = 'a6000000-0000-4000-8000-000000000001'$$, 'P0001', null, 'no provider event at all: success refused');

insert into payments.provider_events (provider, provider_event_id, event_type, lender_org_id, payment_intent_id, amount_minor, provider_status, payload_sha256, signature_verified) values
  ('mock_gateway', 'evt_unverified', 'payment.captured', 'a1000000-0000-4000-8000-000000000000', 'a6000000-0000-4000-8000-000000000001', 475000, 'captured', repeat('1', 64), false);
select throws_ok($$update payments.payment_intents set status = 'succeeded' where id = 'a6000000-0000-4000-8000-000000000001'$$, 'P0001', null, 'an event whose signature was not verified proves nothing');

insert into payments.provider_events (provider, provider_event_id, event_type, lender_org_id, payment_intent_id, amount_minor, provider_status, payload_sha256, signature_verified) values
  ('mock_gateway', 'evt_failed', 'payment.failed', 'a1000000-0000-4000-8000-000000000000', 'a6000000-0000-4000-8000-000000000001', 475000, 'failed', repeat('2', 64), true),
  ('mock_gateway', 'evt_created', 'order.created', 'a1000000-0000-4000-8000-000000000000', 'a6000000-0000-4000-8000-000000000001', 475000, 'created', repeat('3', 64), true),
  ('mock_gateway', 'evt_nostatus', 'payment.captured', 'a1000000-0000-4000-8000-000000000000', 'a6000000-0000-4000-8000-000000000001', 475000, null, repeat('4', 64), true);
select throws_ok($$update payments.payment_intents set status = 'succeeded' where id = 'a6000000-0000-4000-8000-000000000001'$$, 'P0001', null, 'verified events with a failed, created or missing status do not authorise success');

insert into payments.provider_events (provider, provider_event_id, event_type, lender_org_id, payment_intent_id, amount_minor, provider_status, payload_sha256, signature_verified) values
  ('mock_gateway', 'evt_higher', 'payment.captured', 'a1000000-0000-4000-8000-000000000000', 'a6000000-0000-4000-8000-000000000001', 475001, 'captured', repeat('5', 64), true),
  ('mock_gateway', 'evt_lower', 'payment.captured', 'a1000000-0000-4000-8000-000000000000', 'a6000000-0000-4000-8000-000000000001', 474999, 'captured', repeat('6', 64), true);
select throws_ok($$update payments.payment_intents set status = 'succeeded' where id = 'a6000000-0000-4000-8000-000000000001'$$, 'P0001', null, 'a captured event for a different amount (higher or lower) is refused');

insert into payments.provider_events (provider, provider_event_id, event_type, lender_org_id, payment_intent_id, amount_minor, provider_status, payload_sha256, signature_verified) values
  ('mock_gateway', 'evt_noamount', 'payment.captured', 'a1000000-0000-4000-8000-000000000000', 'a6000000-0000-4000-8000-000000000001', null, 'captured', repeat('7', 64), true);
select throws_ok($$update payments.payment_intents set status = 'succeeded' where id = 'a6000000-0000-4000-8000-000000000001'$$, 'P0001', null, 'a captured event without an amount is refused');

insert into payments.provider_events (provider, provider_event_id, event_type, lender_org_id, payment_intent_id, amount_minor, provider_status, payload_sha256, signature_verified) values
  ('mock_gateway', 'evt_other_intent', 'payment.captured', 'a1000000-0000-4000-8000-000000000000', 'a6000000-0000-4000-8000-000000000002', 475000, 'captured', repeat('8', 64), true),
  ('mock_gateway', 'evt_other_lender', 'payment.captured', 'b1000000-0000-4000-8000-000000000000', 'b6000000-0000-4000-8000-000000000001', 475000, 'captured', repeat('9', 64), true),
  ('other_gateway', 'evt_other_provider', 'payment.captured', 'a1000000-0000-4000-8000-000000000000', 'a6000000-0000-4000-8000-000000000001', 475000, 'captured', repeat('a', 64), true);
select throws_ok($$update payments.payment_intents set status = 'succeeded' where id = 'a6000000-0000-4000-8000-000000000001'$$, 'P0001', null,
  'a perfect event for another intent, another lender or another provider does not count');
select throws_ok(
  $$insert into payments.provider_events (provider, provider_event_id, event_type, lender_org_id, payment_intent_id, amount_minor, provider_status, payload_sha256, signature_verified)
    values ('mock_gateway', 'evt_wrong_tenant', 'payment.captured', 'b1000000-0000-4000-8000-000000000000', 'a6000000-0000-4000-8000-000000000001', 475000, 'captured', repeat('b', 64), true)$$,
  '23503', null, 'an event cannot even be filed under another lender than the intent''s');
select throws_ok(
  $$insert into payments.provider_events (provider, provider_event_id, event_type, payload_sha256, signature_verified, amount_minor)
    values ('mock_gateway', 'evt_negative', 'payment.captured', repeat('c', 64), true, -1)$$,
  '23514', null, 'a negative event amount is refused by a check constraint');
select throws_ok(
  $$insert into payments.provider_events (provider, provider_event_id, event_type, payload_sha256, signature_verified, amount_minor)
    values ('mock_gateway', 'evt_huge', 'payment.captured', repeat('d', 64), true, 100000000000001)$$,
  '23514', null, 'and so is an absurd one');

insert into payments.provider_events (provider, provider_event_id, event_type, lender_org_id, payment_intent_id, amount_minor, provider_status, payload_sha256, signature_verified) values
  ('mock_gateway', 'evt_good', 'payment.captured', 'a1000000-0000-4000-8000-000000000000', 'a6000000-0000-4000-8000-000000000001', 475000, 'captured', repeat('e', 64), true),
  ('mock_gateway', 'evt_good_b', 'payment.captured', 'b1000000-0000-4000-8000-000000000000', 'b6000000-0000-4000-8000-000000000001', 300000, 'paid', repeat('f', 64), true),
  ('mock_gateway', 'evt_good_3', 'payment.captured', 'a1000000-0000-4000-8000-000000000000', 'a6000000-0000-4000-8000-000000000003', 100000, 'captured', repeat('0', 64), true);
select lives_ok($$update payments.payment_intents set status = 'succeeded' where id = 'a6000000-0000-4000-8000-000000000001'$$, 'with the matching verified captured event the system records success');
select lives_ok($$update payments.payment_intents set status = 'succeeded' where id = 'b6000000-0000-4000-8000-000000000001'$$, 'and for another lender''s intent with its own matching event (status paid)');
select throws_ok($$update payments.payment_intents set status = 'succeeded' where id = 'a6000000-0000-4000-8000-000000000002'$$, 'P0001', null, 'an intent whose only event is for another intent is still pending');
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
select throws_ok($$update payments.payment_intents set status = 'succeeded' where id = 'a6000000-0000-4000-8000-000000000003'$$, '42501', null, 'a borrower cannot mark success even when a perfect event exists');
select pg_temp.as_system();

-- R-05: loan-account history (written by a trigger; the system role writes the loan account, never the history)
select is((select (event_type, new_status::text, actor)::text from servicing.loan_account_events where loan_account_id = 'a4000000-0000-4000-8000-000000000001'), '(created,active,system)',
  'creating a loan account leaves a created event with the actor');
update servicing.loan_accounts set last_synced_at = now() + interval '1 minute' where id = 'a4000000-0000-4000-8000-000000000001';
select is((select count(*) from servicing.loan_account_events where loan_account_id = 'a4000000-0000-4000-8000-000000000001'), 1::bigint, 'a sync that changes nothing tracked leaves no event');
update servicing.loan_accounts set status = 'closed' where id = 'a4000000-0000-4000-8000-000000000001';
select is((select (event_type, old_status::text, new_status::text)::text from servicing.loan_account_events where loan_account_id = 'a4000000-0000-4000-8000-000000000001' and event_type = 'status_changed'),
  '(status_changed,active,closed)', 'a status change records the old and the new status');
update servicing.loan_accounts set disbursed_amount_minor = 5000000, disbursed_at = now(), disbursement_reference = 'UTR-REM-0001' where id = 'b4000000-0000-4000-8000-000000000001';
select is((select (event_type, old_disbursed_amount_minor is null, new_disbursed_amount_minor, new_disbursement_reference)::text from servicing.loan_account_events
           where loan_account_id = 'b4000000-0000-4000-8000-000000000001' and event_type = 'disbursement_recorded'),
  '(disbursement_recorded,t,5000000,UTR-REM-0001)', 'recording the disbursement evidence leaves an event with old (empty) and new values');
update servicing.loan_accounts set sanctioned_amount_minor = 9000000 where id = 'b4000000-0000-4000-8000-000000000001';
select is((select (event_type, old_sanctioned_amount_minor, new_sanctioned_amount_minor)::text from servicing.loan_account_events
           where loan_account_id = 'b4000000-0000-4000-8000-000000000001' and event_type = 'amount_changed'), '(amount_changed,8000000,9000000)', 'a sanctioned-amount correction is recorded too');
select throws_ok($$update servicing.loan_accounts set disbursed_amount_minor = 1 where id = 'b4000000-0000-4000-8000-000000000001'$$, 'P0001', null, 'a refused change (disbursement evidence is permanent) leaves no event');
select is((select count(*) from servicing.loan_account_events where loan_account_id = 'b4000000-0000-4000-8000-000000000001'), 3::bigint, 'so the Beta account has exactly its three events');
select throws_ok(
  $$insert into servicing.loan_account_events (lender_org_id, loan_account_id, event_type, new_status, new_sanctioned_amount_minor, source_system, actor)
    values ('a1000000-0000-4000-8000-000000000000', 'b4000000-0000-4000-8000-000000000001', 'created', 'active', 1, 'lender_lms', 'system')$$,
  '23503', null, 'a history row cannot be filed under another lender than its loan account (composite key)');
select pg_temp.as_owner();
select throws_ok($$update servicing.loan_account_events set new_status = 'active'$$, 'P0001', null, 'history cannot be rewritten, even by the owner');
select throws_ok($$delete from servicing.loan_account_events$$, 'P0001', null, 'nor deleted');
select throws_ok($$truncate servicing.loan_account_events$$, 'P0001', null, 'nor truncated');
select pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001');
select is((select array_agg(distinct lender_org_id) from servicing.loan_account_events), array['a1000000-0000-4000-8000-000000000000'::uuid], 'a lender officer sees its own loan accounts'' history only');
select pg_temp.as_user('bbbbbbbb-0000-4000-8000-000000000001');
select is((select count(*) from servicing.loan_account_events where lender_org_id = 'a1000000-0000-4000-8000-000000000000'), 0::bigint, 'and another lender''s officer sees none of it');
select pg_temp.as_owner();

-- ============================================================================================================================
-- 4. Template engine check and the KFS projection
-- ============================================================================================================================
select pg_temp.as_user('0e0e0e0e-0000-4000-8000-000000000001');
select is(pg_temp.err($$select documents.propose_template('x.test', 'kfs', 'en', null, '{}'::jsonb)$$), '22023|template_engine_unknown', 'a platform template without an engine is refused');
select is(pg_temp.err($$select documents.propose_template('x.test', 'kfs', 'en', null, '{"labels":{"title":"t"}}'::jsonb)$$), '22023|template_engine_unknown', 'also with other keys but no engine');
select is(pg_temp.err($$select documents.propose_template('x.test', 'kfs', 'en', null, '{"engine":null}'::jsonb)$$), '22023|template_engine_unknown', 'a null engine is refused');
select is(pg_temp.err($$select documents.propose_template('x.test', 'kfs', 'en', null, '{"engine":"html_v1"}'::jsonb)$$), '22023|template_engine_unknown', 'an unknown engine is refused');
select is(pg_temp.err($$select documents.propose_template('x.test', 'kfs', 'en', null, '[]'::jsonb)$$), '22023|template_engine_unknown', 'a body that is not an object is refused');
select is(pg_temp.err($$select documents.propose_template('x.test', 'kfs', 'en', null, '{"engine":"annex_i_v1"}'::jsonb)$$), 'ok', 'a known engine is accepted');
select pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001');
select is(pg_temp.err($$select documents.propose_template('x.alpha', 'kfs', 'en', 'a1000000-0000-4000-8000-000000000000', '{}'::jsonb)$$), '22023|template_engine_unknown', 'a lender''s own template without an engine is refused too');
select pg_temp.as_owner();
select is((select count(*) from documents.templates where template_key in ('x.test', 'x.alpha')), 1::bigint, 'and only the template with a known engine was stored');

select is(private.kfs_project('[1]'::jsonb), null, 'the KFS projection of something that is not an object is null');
create temp table kfs_probe as
select private.kfs_project('{
  "schema":"kfs_data_v1","proposalNo":"PROP-1234","loanType":"Personal loan","evil":"top","sanctionedAmountMinor":1,"tenureDays":10,"aprBps":2,"noFees":true,
  "disbursal":{"mode":"upfront","hiddenNote":"internal"},
  "loanTerm":{"value":1,"unit":"months","x":1},
  "instalments":{"type":"epi","frequency":"monthly","count":1,"amountMinor":1,"commencementDaysAfterSanction":0,"margin":3},
  "interest":{"rateBps":1,"type":"floating","x":1},
  "floating":{"referenceBenchmark":"r","benchmarkRateBps":1,"spreadBps":1,"finalRateBps":2,"resetPeriodicityMonths":3,"junk":1,
              "impactOf25bps":{"epiOnBenchmarkMinor":1,"epiOnSpreadMinor":1,"epiCountOnBenchmark":1,"epiCountOnSpread":1,"junk":2}},
  "fees":[{"category":"processing","label":"p","payee":"lender","timing":"one_time","amountMinor":1,"internalMargin":9}],
  "contingent":{"penalDelayed":{"text":"t","extra":1},"otherPenal":{"notApplicable":true},"foreclosure":{"percentBps":5},"switching":{"amountMinor":1},"x":1,"other":[{"text":"o","y":1}]},
  "computation":{"totalInterestMinor":1,"feesTotalMinor":1,"feesToLenderMinor":1,"feesToThirdPartyMinor":0,"netDisbursedMinor":1,"totalPayableMinor":1,"scheduleOfDisbursement":"s","roundingNote":"rounding note","z":1},
  "schedule":[{"no":1,"dueDate":"2027-01-01","outstandingPrincipalMinor":1,"principalMinor":1,"interestMinor":1,"instalmentMinor":2,"hidden":true}],
  "part2":{"recoveryAgentClauseRef":"c1","grievanceClauseRef":"c2","nodalOfficerPhone":"+91 0","nodalOfficerEmail":"a@b.c","transferOrSecuritisation":false,"other":1,
           "collaborativeLending":{"originatingRe":"o","originatingFundingPercentBps":1,"partnerRe":"p","partnerFundingPercentBps":1,"blendedRateBps":1,"q":1},
           "digital":{"coolingOffDays":3,"coolingOffNote":"n","lspRecoveryAgent":"l","secretNote":"s"}}
}'::jsonb) as p;
select is((select p ? 'evil' from kfs_probe), false, 'an unknown top-level field is dropped');
select is((select p -> 'disbursal' from kfs_probe), '{"mode":"upfront"}'::jsonb, 'nested objects keep only validated keys (disbursal)');
select is((select (p -> 'fees' -> 0) ? 'internalMargin' from kfs_probe), false, 'and so do array elements (fees)');
select is((select p -> 'fees' -> 0 ->> 'amountMinor' from kfs_probe), '1', 'while the validated fee fields are kept');
select is((select (p -> 'contingent' ? 'x') or (p -> 'contingent' -> 'penalDelayed' ? 'extra') or (p -> 'contingent' -> 'other' -> 0 ? 'y') from kfs_probe), false, 'contingent charges are cut to their fields');
select is((select p -> 'contingent' -> 'foreclosure' ->> 'percentBps' from kfs_probe), '5', 'but their values are kept');
select is((select (p -> 'floating' ? 'junk') or (p -> 'floating' -> 'impactOf25bps' ? 'junk') from kfs_probe), false, 'the floating-rate table is cut at both levels');
select is((select (p -> 'part2' ? 'other') or (p -> 'part2' -> 'digital' ? 'secretNote') or (p -> 'part2' -> 'collaborativeLending' ? 'q') from kfs_probe), false, 'Part 2 is cut at every level');
select is((select p -> 'part2' -> 'digital' ->> 'coolingOffDays' from kfs_probe), '3', 'with the cooling-off period kept');
select is((select (p -> 'schedule' -> 0) ? 'hidden' from kfs_probe), false, 'schedule rows are cut');
select is((select p -> 'schedule' -> 0 ->> 'dueDate' from kfs_probe), '2027-01-01', 'but keep their dates');
select is((select private.kfs_project(p) = p from kfs_probe), true, 'projecting twice changes nothing');
select is((select private.kfs_project('{"schema":"kfs_data_v1","fees":[],"noFees":true}'::jsonb)), '{"schema":"kfs_data_v1","fees":[],"noFees":true}'::jsonb, 'an empty fee list and the no-fees flag survive');

-- ============================================================================================================================
-- 5. Documents: register_upload, per-lender proposal numbers, self-approval toggle, idempotent e-mail notice
-- ============================================================================================================================
select pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001');
select pg_temp.keep('decl_a1', documents.submit_kfs_data('0f000000-0000-4000-8000-000000000001', pg_temp.mkdecl('PROP-0001'), 'declared_for_upload') ->> 'inputId');
select pg_temp.keep('decl_a1_held', documents.submit_kfs_data('0f000000-0000-4000-8000-000000000001', pg_temp.mkdecl('PROP-0001', 14, 1800), 'declared_for_upload') ->> 'inputId');
select pg_temp.keep('decl_a1_data', documents.submit_kfs_data('0f000000-0000-4000-8000-000000000001', '{"schema":"kfs_data_v1"}', 'data') ->> 'inputId');
select is((select validation from documents.kfs_inputs where id = pg_temp.get('decl_a1_held')::uuid), 'held', 'declared facts that contradict the offer are held');
select is(pg_temp.err(format($$select documents.register_upload('0f000000-0000-4000-8000-000000000001', %L, 'kfs/test/a1', %L, 1000)$$, pg_temp.get('decl_a1_data'), repeat('1', 64))), '55000|kfs_input_missing',
  'the input must be declared facts for an uploaded file, not generated KFS data');
select is(pg_temp.err(format($$select documents.register_upload('0f000000-0000-4000-8000-000000000001', %L, 'kfs/test/a1', %L, 1000)$$, pg_temp.get('decl_a1_held'), repeat('1', 64))), '55000|kfs_input_held',
  'held declared facts cannot back an upload');
select is(pg_temp.err(format($$select documents.register_upload('0f000000-0000-4000-8000-000000000001', %L, 'kfs/test/a1', %L, 1000)$$, pg_temp.get('decl_a1'), repeat('1', 64))), '55000|kfs_input_stale',
  'an older declared package is stale once a newer one exists');
select pg_temp.keep('decl_a1', documents.submit_kfs_data('0f000000-0000-4000-8000-000000000001', pg_temp.mkdecl('PROP-0001'), 'declared_for_upload') ->> 'inputId');
select is(pg_temp.err(format($$select documents.register_upload('0f000000-0000-4000-8000-000000000001', %L, 'kfs/test/a1', %L, 1000)$$, pg_temp.get('decl_a1'), repeat('1', 64))), '55000|applicability_unresolved',
  'while the NBFC rule is only a draft nothing can be registered');
select pg_temp.as_user('0e0e0e0e-0000-4000-8000-000000000001');
select documents.decide_rule((select id from documents.applicability_rules where rule_key = 'kfs.nbfc.retail_msme_term'), true, 'Test compliance reviewer');
select pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001');
select is(pg_temp.err(format($$select documents.register_upload('0f000000-0000-4000-8000-000000000001', %L, 'kfs/test/a1', %L, 1000)$$, pg_temp.get('decl_a1'), repeat('1', 64))), '55000|calendar_missing',
  'with an approved rule but no approved working-day calendar it stops with calendar_missing');
select pg_temp.as_user('0e0e0e0e-0000-4000-8000-000000000001');
select pg_temp.keep('cal_a', documents.propose_calendar('a1000000-0000-4000-8000-000000000000', 'Alpha calendar', array[0, 6], current_date - 5, current_date + 120, '[]')::text);
select pg_temp.keep('cal_b', documents.propose_calendar('b1000000-0000-4000-8000-000000000000', 'Beta calendar', array[0, 6], current_date - 5, current_date + 120, '[]')::text);
select pg_temp.as_user('0f0f0f0f-0000-4000-8000-000000000001');
select documents.decide_calendar(pg_temp.get('cal_a')::uuid, true, 'ALPHA-CAL-CONF');
select documents.decide_calendar(pg_temp.get('cal_b')::uuid, true, 'BETA-CAL-CONF');

select pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001', 'aal1');
select is(pg_temp.err(format($$select documents.register_upload('0f000000-0000-4000-8000-000000000001', %L, 'kfs/test/a1', %L, 1000)$$, pg_temp.get('decl_a1'), repeat('1', 64))) like '42501|%', true, 'registering needs a second factor');
select pg_temp.as_user('bbbbbbbb-0000-4000-8000-000000000001');
select is(pg_temp.err(format($$select documents.register_upload('0f000000-0000-4000-8000-000000000001', %L, 'kfs/test/a1', %L, 1000)$$, pg_temp.get('decl_a1'), repeat('1', 64))), 'P0002|', 'another lender''s officer cannot register an upload for this offer');
select pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001');
select pg_temp.keep('decl_short', documents.submit_kfs_data('0f000000-0000-4000-8000-000000000001', pg_temp.mkdecl('PROP-0001', 1), 'declared_for_upload') ->> 'inputId');
select is(pg_temp.err(format($$select documents.register_upload('0f000000-0000-4000-8000-000000000001', %L, 'kfs/test/a1', %L, 1000)$$, pg_temp.get('decl_short'), repeat('1', 64))), '55000|validity_below_minimum',
  'a validity shorter than three working days is refused');
select pg_temp.keep('decl_long', documents.submit_kfs_data('0f000000-0000-4000-8000-000000000001', pg_temp.mkdecl('PROP-0001', 60), 'declared_for_upload') ->> 'inputId');
select is(pg_temp.err(format($$select documents.register_upload('0f000000-0000-4000-8000-000000000001', %L, 'kfs/test/a1', %L, 1000)$$, pg_temp.get('decl_long'), repeat('1', 64))), '55000|offer_validity_shorter_than_kfs',
  'and one that outlasts the offer is refused');
select pg_temp.keep('decl_a1', documents.submit_kfs_data('0f000000-0000-4000-8000-000000000001', pg_temp.mkdecl('PROP-0001'), 'declared_for_upload') ->> 'inputId');
select pg_temp.keep('doc_a1', documents.register_upload('0f000000-0000-4000-8000-000000000001', pg_temp.get('decl_a1')::uuid, 'kfs/test/a1', repeat('1', 64), 1000)::text);
select pg_temp.as_owner();
select is((select (document_type, version, source_mode, approval_status, issuance_status, proposal_no, supersedes_id is null)::text from documents.items where id = pg_temp.get('doc_a1')::uuid),
  '(kfs,1,lender_uploaded,draft,not_issued,PROP-0001,t)', 'the registered file is an unapproved, unissued draft that carries the declared proposal number');
select is((select prepared_by from documents.items where id = pg_temp.get('doc_a1')::uuid), 'aaaaaaaa-0000-4000-8000-000000000001'::uuid, 'and names the person who prepared it');
select is((select count(*) from documents.item_events where document_id = pg_temp.get('doc_a1')::uuid and event = 'uploaded_by_lender'), 1::bigint, 'with a history entry');

-- Proposal numbers: unique per lender
select pg_temp.as_user('bbbbbbbb-0000-4000-8000-000000000001');
select pg_temp.keep('decl_b1', documents.submit_kfs_data('0f000000-0000-4000-8000-000000000002', pg_temp.mkdecl('PROP-0001'), 'declared_for_upload') ->> 'inputId');
select is(pg_temp.err(format($$select documents.register_upload('0f000000-0000-4000-8000-000000000002', %L, 'kfs/test/b1', %L, 1000)$$, pg_temp.get('decl_b1'), repeat('2', 64))), 'ok',
  'another lender may use a proposal number that Alpha already uses (no error, nothing revealed)');
select pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001');
select pg_temp.keep('decl_a3', documents.submit_kfs_data('0f000000-0000-4000-8000-000000000003', pg_temp.mkdecl('PROP-0001'), 'declared_for_upload') ->> 'inputId');
select is(pg_temp.err(format($$select documents.register_upload('0f000000-0000-4000-8000-000000000003', %L, 'kfs/test/a3', %L, 1000)$$, pg_temp.get('decl_a3'), repeat('3', 64))), '55000|proposal_no_taken',
  'but a second offer of the same lender cannot reuse it');
select pg_temp.as_owner();
select is((select count(*) from documents.proposals where proposal_no = 'PROP-0001'), 2::bigint, 'two lenders hold the same number, one each');
select is((select count(*) from pg_constraint where conrelid = 'documents.proposals'::regclass and contype = 'u' and conname = 'proposals_lender_proposal_no_key'), 1::bigint, 'uniqueness is declared per lender');
select is((select count(*) from pg_constraint where conrelid = 'documents.proposals'::regclass and contype = 'u' and conname = 'proposals_proposal_no_key'), 0::bigint, 'and the global constraint is gone');
select pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001');
select pg_temp.keep('decl_a3', documents.submit_kfs_data('0f000000-0000-4000-8000-000000000003', pg_temp.mkdecl('PROP-0002'), 'declared_for_upload') ->> 'inputId');
select pg_temp.keep('doc_a3', documents.register_upload('0f000000-0000-4000-8000-000000000003', pg_temp.get('decl_a3')::uuid, 'kfs/test/a3', repeat('3', 64), 1000)::text);
select is((select version from documents.items where id = pg_temp.get('doc_a3')::uuid), 1, 'a distinct number registers normally');
select pg_temp.keep('decl_a1b', documents.submit_kfs_data('0f000000-0000-4000-8000-000000000001', pg_temp.mkdecl('PROP-0001'), 'declared_for_upload') ->> 'inputId');
select pg_temp.keep('doc_a1b', documents.register_upload('0f000000-0000-4000-8000-000000000001', pg_temp.get('decl_a1b')::uuid, 'kfs/test/a1b', repeat('4', 64), 1000)::text);
select pg_temp.as_owner();
select is((select (version, supersedes_id = pg_temp.get('doc_a1')::uuid, proposal_no)::text from documents.items where id = pg_temp.get('doc_a1b')::uuid), '(2,t,PROP-0001)',
  'a new version of the same offer keeps the offer''s proposal number and points at the version it replaces');

-- Self-approval toggle (platform setting; default off)
select pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001');
select is(pg_temp.err(format($$select documents.approve_document(%L, %L)$$, pg_temp.get('doc_a3'), repeat('3', 64))), '42501|segregation_of_duties', 'by default the preparer cannot approve their own document');
select is(pg_temp.err($$select documents.set_self_approval('a1000000-0000-4000-8000-000000000000', true)$$), '42501|', 'a lender user cannot switch the setting on');
select pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000002');
select is(pg_temp.err($$select documents.set_self_approval('a1000000-0000-4000-8000-000000000000', true)$$), '42501|', 'nor a lender administrator');
select pg_temp.as_user('0e0e0e0e-0000-4000-8000-000000000001', 'aal1');
select is(pg_temp.err($$select documents.set_self_approval('a1000000-0000-4000-8000-000000000000', true)$$) like '42501|%', true, 'the platform needs a second factor to change it');
select pg_temp.as_user('0e0e0e0e-0000-4000-8000-000000000001');
select is(pg_temp.err($$select documents.set_self_approval('c1000000-0000-4000-8000-000000000000', true)$$), 'P0002|', 'a lender without a connector row is not found');
select is(pg_temp.err($$select documents.set_self_approval('a1000000-0000-4000-8000-000000000000', true)$$), 'ok', 'platform staff switch it on for Alpha');
select pg_temp.as_owner();
select is((select document_self_approval from lending.lender_connectors where lender_org_id = 'a1000000-0000-4000-8000-000000000000'), true, 'and it is recorded');
select is((select document_self_approval from lending.lender_connectors where lender_org_id = 'b1000000-0000-4000-8000-000000000000'), false, 'without touching another lender');
select is((select count(*) from audit.events where action = 'documents.self_approval.set' and entity_id = 'a1000000-0000-4000-8000-000000000000'), 1::bigint, 'the change is audited');
select pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001');
select is(pg_temp.err(format($$select documents.approve_document(%L, %L)$$, pg_temp.get('doc_a3'), repeat('3', 64))), 'ok', 'with the setting on, the preparer may approve their own document');
select pg_temp.as_user('0e0e0e0e-0000-4000-8000-000000000001');
select documents.set_self_approval('a1000000-0000-4000-8000-000000000000', false);
select pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001');
select is(pg_temp.err(format($$select documents.approve_document(%L, %L)$$, pg_temp.get('doc_a1b'), repeat('4', 64))), '42501|segregation_of_duties', 'switched off again, the next document needs a different person');
select pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000002');
select is(pg_temp.err(format($$select documents.approve_document(%L, %L)$$, pg_temp.get('doc_a1b'), repeat('4', 64))), 'ok', 'a second person approves it');
select is(pg_temp.err(format($$select documents.issue_document(%L)$$, pg_temp.get('doc_a1b'))), 'ok', 'and issues it');

-- E-mail notice requests are idempotent; the SMS path is unchanged
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
select pg_temp.keep('mail1', documents.request_delivery(pg_temp.get('doc_a1b')::uuid, 'email_notice') ->> 'deliveryId');
select is(documents.request_delivery(pg_temp.get('doc_a1b')::uuid, 'email_notice') ->> 'deliveryId', pg_temp.get('mail1'), 'a repeated e-mail notice request returns the same delivery');
select is(documents.request_delivery(pg_temp.get('doc_a1b')::uuid, 'email_notice') ->> 'status', 'not_configured', 'which says honestly that nothing can be sent (no verified e-mail address)');
select is((documents.request_delivery(pg_temp.get('doc_a1b')::uuid, 'email_notice') ->> 'replayed')::boolean, true, 'and is marked as a replay');
select is((select count(*) from documents.deliveries where document_id = pg_temp.get('doc_a1b')::uuid and channel = 'email_notice'), 1::bigint, 'so only one e-mail row exists however often it is asked for');
select pg_temp.keep('sms1', documents.request_delivery(pg_temp.get('doc_a1b')::uuid, 'sms_notice') ->> 'deliveryId');
select is((documents.request_delivery(pg_temp.get('doc_a1b')::uuid, 'sms_notice') ->> 'replayed')::boolean, true, 'an SMS notice request is still de-duplicated while one is open');
select is(documents.request_delivery(pg_temp.get('doc_a1b')::uuid, 'sms_notice') ->> 'deliveryId', pg_temp.get('sms1'), 'with the same delivery id');
select is(pg_temp.err(format($$select documents.request_delivery(%L, 'whatsapp')$$, pg_temp.get('doc_a1b'))), '22023|', 'an unknown channel is refused');
select pg_temp.as_owner();
select is((select count(*) from ops.outbox_events where event_type = 'document.deliver' and payload ->> 'delivery_id' = pg_temp.get('sms1')), 1::bigint, 'the SMS notice produced one job, carrying an id only');
select pg_temp.as_user('22222222-2222-4222-8222-222222222222');
select is(pg_temp.err(format($$select documents.request_delivery(%L, 'email_notice')$$, pg_temp.get('doc_a1b'))), 'P0002|', 'another borrower cannot request a notice for this document');
select pg_temp.as_owner();

-- ============================================================================================================================
-- 6. Phase 06 tests the security review asked for
-- ============================================================================================================================
update identity.borrowers set display_name = 'Test Borrower One' where user_id = '11111111-1111-4111-8111-111111111111';
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
select pg_temp.keep('sel1', lending.select_lenders('70000000-0000-4000-8000-000000000001',
  '[{"lenderId":"a1000000-0000-4000-8000-000000000000"},{"lenderId":"b1000000-0000-4000-8000-000000000000"}]')::text);
select consent.record_lender_decision('70000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-00000000000a', 'granted', '1.0.0', 'consent');
select consent.record_lender_decision('70000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-00000000000b', 'granted', '1.0.0', 'consent');
select lending.route_selection(pg_temp.get('sel1')::uuid);
select pg_temp.as_user('22222222-2222-4222-8222-222222222222');
select pg_temp.keep('sel2', lending.select_lenders('70000000-0000-4000-8000-000000000002', '[{"lenderId":"b1000000-0000-4000-8000-000000000000"}]')::text);
select consent.record_lender_decision('70000000-0000-4000-8000-000000000002', 'b1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-00000000000b', 'granted', '1.0.0', 'consent');
select lending.route_selection(pg_temp.get('sel2')::uuid);
select pg_temp.as_owner();
select pg_temp.keep('appA1', (select application_id::text from lending.application_routing where loan_request_id = '70000000-0000-4000-8000-000000000001' and lender_org_id = 'a1000000-0000-4000-8000-000000000000'));
select pg_temp.keep('appB1', (select application_id::text from lending.application_routing where loan_request_id = '70000000-0000-4000-8000-000000000001' and lender_org_id = 'b1000000-0000-4000-8000-000000000000'));
select pg_temp.keep('appB2', (select application_id::text from lending.application_routing where loan_request_id = '70000000-0000-4000-8000-000000000002' and lender_org_id = 'b1000000-0000-4000-8000-000000000000'));

-- 6a. A send that never recorded its result is treated as unknown after five minutes (never resent blindly)
select pg_temp.as_system();
select is(lending.begin_transmission(pg_temp.get('appB1')::uuid) ->> 'attempt', '1', 'two sends start (the API lender''s applications of borrowers 1 and 2)');
select is(lending.begin_transmission(pg_temp.get('appB2')::uuid) ->> 'attempt', '1', 'the second is a fresh send');
select pg_temp.as_owner();
alter table lending.application_routing disable trigger user;
update lending.application_routing set updated_at = now() - interval '10 minutes' where application_id = pg_temp.get('appB1')::uuid;
alter table lending.application_routing enable trigger user;
select pg_temp.as_system();
select is(lending.process_deadlines() ->> 'noResponse', '0', 'the deadline job runs');
select is((select transmission_status from lending.application_routing where application_id = pg_temp.get('appB1')::uuid), 'uncertain', 'a send stuck for ten minutes becomes uncertain');
select is((select last_error_class from lending.application_routing where application_id = pg_temp.get('appB1')::uuid), 'worker_interrupted', 'with the reason recorded');
select is((select transmission_status from lending.application_routing where application_id = pg_temp.get('appB2')::uuid), 'transmitting', 'a send that is only seconds old is left alone');
select pg_temp.as_owner();
select is((select count(*) from lending.routing_events where application_id = pg_temp.get('appB1')::uuid and event = 'uncertain'), 1::bigint, 'the change is recorded as a routing event');
select is((select count(*) from ops.outbox_events where event_type = 'application.reconcile' and payload ->> 'application_id' = pg_temp.get('appB1')), 1::bigint, 'and a reconcile job (not a resend) is queued');
select is((select count(*) from ops.outbox_events where event_type = 'application.reconcile' and payload ->> 'application_id' = pg_temp.get('appB2')), 0::bigint, 'none for the fresh send');
select pg_temp.as_system();
select lending.process_deadlines();
select pg_temp.as_owner();
select is((select count(*) from ops.outbox_events where event_type = 'application.reconcile' and payload ->> 'application_id' = pg_temp.get('appB1')), 1::bigint, 'running the sweep again queues nothing more');

-- 6b. The borrower's name disappears from the lender's list once consent is withdrawn, and withdrawal works with retired wording
select pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001');
select is((select r ->> 'displayName' from jsonb_array_elements(lending.lender_applications(20, null, null)) r where r ->> 'applicationId' = pg_temp.get('appA1')), 'Test Borrower One', 'the lender sees the borrower''s name while consent stands');
select pg_temp.as_owner();
update consent.notices set status = 'retired' where id = 'f1000000-0000-4000-8000-00000000000a';
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
select is(pg_temp.err($$select consent.record_lender_decision('70000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-00000000000a', 'granted', '1.0.0', 'consent')$$), 'P0002|', 'consent cannot be granted on retired wording');
select is(pg_temp.err($$select consent.record_lender_decision('70000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000000', 'f1000000-0000-4000-8000-00000000000a', 'withdrawn', '1.0.0', 'settings')$$), 'ok', 'but it can still be withdrawn against it');
select pg_temp.as_owner();
select throws_ok(
  $$insert into consent.records (borrower_id, notice_id, lender_org_id, decision, channel)
    values ((select id from identity.borrowers where user_id = '11111111-1111-4111-8111-111111111111'), 'f1000000-0000-4000-8000-00000000000a', 'a1000000-0000-4000-8000-000000000000', 'granted', 'mobile_app')$$,
  '23514', null, 'at table level too, a grant against retired wording is refused');
insert into consent.notices (id, purpose, version, language, lender_org_id, title, body_markdown, status, drafted_by)
values ('f1000000-0000-4000-8000-0000000000dd', 'share_with_lender', 9, 'en', 'a1000000-0000-4000-8000-000000000000', 'Draft', 'draft wording', 'draft', 'aaaaaaaa-0000-4000-8000-000000000001');
select throws_ok(
  $$insert into consent.records (borrower_id, notice_id, lender_org_id, decision, channel)
    values ((select id from identity.borrowers where user_id = '11111111-1111-4111-8111-111111111111'), 'f1000000-0000-4000-8000-0000000000dd', 'a1000000-0000-4000-8000-000000000000', 'withdrawn', 'mobile_app')$$,
  '23514', null, 'and a withdrawal still cannot reference a draft');
select is((select count(*) from lending.routing_events where application_id = pg_temp.get('appA1')::uuid and event = 'consent_withdrawn_after_transmission'), 1::bigint, 'the withdrawal after sending is recorded for the lender-side process');
select is((select consent_withdrawn_at is not null from lending.application_routing where application_id = pg_temp.get('appA1')::uuid), true, 'and marked on the routing row');
select pg_temp.as_user('aaaaaaaa-0000-4000-8000-000000000001');
select is((select r ->> 'displayName' from jsonb_array_elements(lending.lender_applications(20, null, null)) r where r ->> 'applicationId' = pg_temp.get('appA1')), null, 'the lender''s list no longer shows the borrower''s name');
select is((select (r ->> 'consentWithdrawn')::boolean from jsonb_array_elements(lending.lender_applications(20, null, null)) r where r ->> 'applicationId' = pg_temp.get('appA1')), true, 'and says why');
select is(pg_temp.err(format($$select lending.lender_contact(%L)$$, pg_temp.get('appA1'))), '55000|consent_required', 'the contact detail is closed to the lender as well');
select pg_temp.as_owner();

select * from finish();
rollback;
