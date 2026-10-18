-- Phase 08a review fixes, stream SA (migration 20261018000924): accounts registry, merchants, payment configurations, feature switches.
-- Each section names the finding it covers. Synthetic data only (labelled SAMPLE). Error codes are reported as SQLSTATE|hint.
-- Every behaviour asserted here FAILED before the migration (the file was run against a database without it before it was kept).
begin;
create extension if not exists pgtap with schema extensions;
select plan(304);

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
create function pg_temp.got(k text) returns text language sql as $fn$ select current_setting('t.' || k) $fn$;
create function pg_temp.u(n integer) returns uuid language sql as $fn$ select ('f9000000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid $fn$;
create function pg_temp.lx() returns uuid language sql as $fn$ select 'f9b00000-0000-4000-8000-000000000001'::uuid $fn$;
create function pg_temp.ly() returns uuid language sql as $fn$ select 'f9b00000-0000-4000-8000-000000000002'::uuid $fn$;
create function pg_temp.lz() returns uuid language sql as $fn$ select 'f9b00000-0000-4000-8000-000000000003'::uuid $fn$;
create function pg_temp.lw() returns uuid language sql as $fn$ select 'f9b00000-0000-4000-8000-000000000004'::uuid $fn$;
-- A stand-in for the backend's keyed fingerprint: real account n under key version kv.
create function pg_temp.fp(n integer, kv integer default 1) returns text language sql as $fn$
  select encode(sha256(convert_to('SAMPLE-028-ACCOUNT-' || n || '-KEY-' || kv, 'UTF8')), 'hex') $fn$;
create function pg_temp.token(k text) returns text language sql as $fn$ select encode(sha256(convert_to('SAMPLE-028-TOKEN-' || k, 'UTF8')), 'hex') $fn$;
-- The registry's own masked form for real account n.
create function pg_temp.mask(n integer) returns text language sql as $fn$ select 'XXXXXX' || lpad(n::text, 4, '0') $fn$;
create function pg_temp.register(n integer, k text, rule uuid, kind text default 'lender', org uuid default 'f9b00000-0000-4000-8000-000000000001',
  purposes text[] default array['repayment_settlement'], kv integer default 1, lname text default 'Alpha Finance Ltd (test)', others jsonb default '{}'::jsonb,
  rekeys uuid default null, eff_from date default null, eff_to date default null)
returns uuid language sql as $fn$
  select payments.register_account(pg_temp.fp(n, kv), kv, pg_temp.mask(n), 'IN', 'bank_account', rule, true, kind, org, lname, purposes, eff_from, eff_to, k, others, rekeys)
$fn$;
-- A configuration draft with secret names in the lender's own namespace.
create function pg_temp.draft(lender uuid, k text, merchant uuid, settle uuid, provider text default 'sample_provider', mode text default 'production',
  secret text default null, hook text default null, limits jsonb default null, lsource text default null, evidence text default 'SAMPLE-EVIDENCE-CFG',
  contract text default 'SAMPLE-CONTRACT-CFG')
returns uuid language plpgsql as $fn$
begin
  return payments.draft_payment_config(lender, provider, mode, merchant, settle, coalesce(secret, private.secret_ref_prefix(lender) || 'SAMPLE_SECRET'),
    coalesce(hook, private.secret_ref_prefix(lender) || 'SAMPLE_WEBHOOK'), pg_temp.token(k), limits, lsource, evidence, contract, k);
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
-- Does THIS transaction hold the advisory lock taken for the key k (hashtextextended(k, 0))?
create function pg_temp.holds_advisory(k text) returns boolean language sql as $fn$
  select exists (select 1 from pg_locks l where l.locktype = 'advisory' and l.pid = pg_backend_pid()
                  and ((l.classid::bigint << 32) | l.objid::bigint) = hashtextextended(k, 0))
$fn$;
grant execute on all functions in schema pg_temp to public;

-- Fixture --------------------------------------------------------------------------------------------------------------------
-- Users: 01 R1 and 02 R2 platform registry managers (also providers.manage), 03 V1 and 04 V2 platform account verifiers, 05 F1 and 06 F2
-- platform features admins, 07 PN platform user without a role, 08 X_ADM and 09 X_ADM2 lender X payments admins, 10 X_APR and 11 X_APR2
-- lender X payments approvers, 12 Y_ADM and 13 Y_APR lender Y, 14 X_VIEW lender X viewer, 15 X_SVC lender X servicing operator,
-- 16 W_ADM and 17 W_ADM2 payments admins, 18 W_APR payments approver, 19 W_SVC servicing operator, 20 W_CA communications admin and
-- 21 W_CB communications approver of lender W (the activation-order lender), 22 Z_SVC servicing operator of lender Z.
insert into auth.users (id, raw_app_meta_data) select pg_temp.u(n), '{"actor_type":"staff"}'::jsonb from generate_series(1, 24) n;
select pg_temp.as_owner();
insert into tenancy.organizations (id, kind, legal_name, display_name, regulator_registration_no, status) values
  ('f9a00000-0000-4000-8000-000000000000', 'platform', 'Udofin Platform (test)', 'Udofin', null, 'active'),
  ('f9b00000-0000-4000-8000-000000000001', 'lender', 'Alpha Finance Ltd (test)', 'Alpha', 'TEST-F9-0001', 'active'),
  ('f9b00000-0000-4000-8000-000000000002', 'lender', 'Beta Capital Ltd (test)', 'Beta', 'TEST-F9-0002', 'active'),
  ('f9b00000-0000-4000-8000-000000000003', 'lender', 'Gamma Credit Ltd (test)', 'Gamma', 'TEST-F9-0003', 'active'),
  ('f9b00000-0000-4000-8000-000000000004', 'lender', 'Delta Lending Ltd (test)', 'Delta', 'TEST-F9-0004', 'active');
insert into onboarding.lender_gates (lender_org_id, stage) values
  (pg_temp.lx(), 'activated'), (pg_temp.ly(), 'activated'), (pg_temp.lz(), 'contract_onboarded'), (pg_temp.lw(), 'activated');
insert into tenancy.memberships (id, org_id, user_id, status)
select ('f9c10000-0000-4000-8000-0000000000' || lpad(m.n::text, 2, '0'))::uuid, m.org::uuid, pg_temp.u(m.n), 'active'
from (values
  (1, 'f9a00000-0000-4000-8000-000000000000'), (2, 'f9a00000-0000-4000-8000-000000000000'), (3, 'f9a00000-0000-4000-8000-000000000000'),
  (4, 'f9a00000-0000-4000-8000-000000000000'), (5, 'f9a00000-0000-4000-8000-000000000000'), (6, 'f9a00000-0000-4000-8000-000000000000'),
  (7, 'f9a00000-0000-4000-8000-000000000000'),
  (8, 'f9b00000-0000-4000-8000-000000000001'), (9, 'f9b00000-0000-4000-8000-000000000001'), (10, 'f9b00000-0000-4000-8000-000000000001'),
  (11, 'f9b00000-0000-4000-8000-000000000001'), (12, 'f9b00000-0000-4000-8000-000000000002'), (13, 'f9b00000-0000-4000-8000-000000000002'),
  (14, 'f9b00000-0000-4000-8000-000000000001'), (15, 'f9b00000-0000-4000-8000-000000000001'),
  (16, 'f9b00000-0000-4000-8000-000000000004'), (17, 'f9b00000-0000-4000-8000-000000000004'), (18, 'f9b00000-0000-4000-8000-000000000004'),
  (19, 'f9b00000-0000-4000-8000-000000000004'), (20, 'f9b00000-0000-4000-8000-000000000004'), (21, 'f9b00000-0000-4000-8000-000000000004'),
  (22, 'f9b00000-0000-4000-8000-000000000003')) as m (n, org);
insert into tenancy.membership_roles (membership_id, role_id)
select ('f9c10000-0000-4000-8000-0000000000' || lpad(g.n::text, 2, '0'))::uuid, r.id
from (values
  (1, 'platform', 'platform_payments_admin'), (2, 'platform', 'platform_payments_admin'), (3, 'platform', 'platform_account_verifier'),
  (4, 'platform', 'platform_account_verifier'), (5, 'platform', 'platform_features_admin'), (6, 'platform', 'platform_features_admin'),
  (8, 'lender', 'payments_admin'), (9, 'lender', 'payments_admin'), (10, 'lender', 'payments_approver'), (11, 'lender', 'payments_approver'),
  (12, 'lender', 'payments_admin'), (13, 'lender', 'payments_approver'), (14, 'lender', 'viewer'), (15, 'lender', 'servicing_operator'),
  (16, 'lender', 'payments_admin'), (17, 'lender', 'payments_admin'), (18, 'lender', 'payments_approver'), (19, 'lender', 'servicing_operator'),
  (20, 'lender', 'communications_admin'), (21, 'lender', 'communications_approver'), (22, 'lender', 'servicing_operator')) as g (n, kind, rkey)
join tenancy.roles r on r.org_id is null and r.applies_to = g.kind::tenancy.organization_kind and r.key = g.rkey;

-- Key version 1, one approved account format rule and the provider, all through the real functions.
select pg_temp.as_user(pg_temp.u(1));
select payments.propose_fingerprint_key_version(1, 'SAMPLE first key');
select pg_temp.keep('rule', payments.draft_account_format_rule('IN', 'bank_account', 9, 18, true, 'likely', 'SAMPLE source note for the fixture rule', private.today_ist() - 1)::text);
select payments.set_payment_provider('sample_provider', 'SAMPLE Provider', 'payment_and_mandate', 'approved', 'SAMPLE-AUTH-EVIDENCE-028', 'likely');
select pg_temp.as_user(pg_temp.u(3));
select payments.approve_fingerprint_key_version(1, 'SAMPLE approval');
select payments.approve_account_format_rule(pg_temp.got('rule')::uuid);

-- ============================================================================================================================
-- 1. A17: the own-account list (accounts owned by Udofin and its group) must be attested complete first
-- ============================================================================================================================
select pg_temp.as_owner();
select is((select count(*) from payments.own_account_attestations), 0::bigint, 'nothing is seeded: no attestation exists');
select is(private.own_account_list_attested(), false, 'so the own-account list is not attested');
select pg_temp.as_user(pg_temp.u(1));
select pg_temp.keep('reg1', pg_temp.register(1, 'reg-key-028-0000001', pg_temp.got('rule')::uuid)::text);
select pg_temp.keep('regu', pg_temp.register(900, 'reg-key-028-0000900', pg_temp.got('rule')::uuid, kind => 'udofin', org => null, purposes => array['fee_collection'],
  lname => 'Udofin SAMPLE Ltd (fixture)')::text);
select pg_temp.keep('regg', pg_temp.register(901, 'reg-key-028-0000901', pg_temp.got('rule')::uuid, kind => 'group_company', org => null, purposes => array['operational'],
  lname => 'Udofin Group SAMPLE Ltd (fixture)')::text);
select pg_temp.as_user(pg_temp.u(3));
select is(pg_temp.err(format($$select payments.verify_account(%L, 'SAMPLE-EVIDENCE-028-L1')$$, pg_temp.got('reg1'))), '55000|own_account_list_not_attested',
  'a LENDER account cannot be verified while the own-account list is not attested (the guard "this account belongs to Udofin" could be vacuous)');
select is(payments.verify_account(pg_temp.got('regu')::uuid, 'SAMPLE-EVIDENCE-028-U'), 'verified', 'an Udofin account builds the list and needs no attestation to be verified');
select is(pg_temp.err(format($$select payments.attest_own_account_list('SAMPLE-OWN-LIST-1')$$)), '55000|own_account_list_incomplete',
  'attesting is refused while a group account is still waiting for verification');
select is(payments.verify_account(pg_temp.got('regg')::uuid, 'SAMPLE-EVIDENCE-028-G'), 'verified', 'the group account is verified');
select pg_temp.as_user(pg_temp.u(4), 'aal1');
select is(pg_temp.err($$select payments.attest_own_account_list('SAMPLE-OWN-LIST-1')$$), '42501|mfa_required', 'attesting needs a second factor');
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err($$select payments.attest_own_account_list('SAMPLE-OWN-LIST-1')$$), '42501|', 'a registry manager cannot attest: it needs registry.verify');
select pg_temp.as_user(pg_temp.u(8));
select is(pg_temp.err($$select payments.attest_own_account_list('SAMPLE-OWN-LIST-1')$$), '42501|', 'a lender user cannot attest');
select pg_temp.as_anon();
select is(pg_temp.err($$select payments.attest_own_account_list('SAMPLE-OWN-LIST-1')$$), '42501|', 'anon cannot attest');
select pg_temp.as_system();
select is(pg_temp.err($$select payments.attest_own_account_list('SAMPLE-OWN-LIST-1')$$), '42501|', 'the system role cannot attest');
select pg_temp.as_user(pg_temp.u(4));
select is(pg_temp.err($$select payments.attest_own_account_list('x')$$), '22023|evidence_invalid', 'an evidence reference label is required');
select is(pg_temp.err($$select payments.attest_own_account_list('50100123456789')$$), '22023|unsafe_free_text', 'an evidence reference that is an account number is refused');
select is(pg_temp.err($$select payments.attest_own_account_list('SAMPLE-OWN-LIST-1', repeat('n', 1001))$$), '22023|reason_invalid', 'a long note is refused');
select is(payments.attest_own_account_list('SAMPLE-OWN-LIST-1'), 'attested', 'a registry verifier attests the list: a verified Udofin account exists and nothing is pending');
select is(payments.attest_own_account_list('SAMPLE-OWN-LIST-1'), 'attested', 'attesting again with the same evidence is idempotent');
select is((select count(*) from payments.own_account_attestations), 1::bigint, 'and wrote no second record');
select is((select (event_kind, evidence_ref, entries_counted, actor_id = pg_temp.u(4))::text from payments.own_account_attestations), '(attested,SAMPLE-OWN-LIST-1,2,t)',
  'the attestation records the evidence reference, how many verified accounts it covers and who attested');
select is(private.own_account_list_attested(), true, 'the list is now attested');
select pg_temp.as_user(pg_temp.u(3));
select is(payments.verify_account(pg_temp.got('reg1')::uuid, 'SAMPLE-EVIDENCE-028-L1'), 'verified', 'a lender account can now be verified');
-- Linking needs the attestation too.
select pg_temp.as_user(pg_temp.u(8));
select pg_temp.keep('sa1', payments.request_settlement_account(pg_temp.lx(), 'SAMPLE collections', 'Sample Bank', pg_temp.mask(1))::text);
select pg_temp.as_user(pg_temp.u(3));
select is(payments.withdraw_own_account_list_attestation('the list is being reviewed after a new account was found'), 'withdrawn', 'a registry verifier withdraws the attestation');
select is(private.own_account_list_attested(), false, 'the list is no longer attested');
select is(payments.withdraw_own_account_list_attestation('the list is being reviewed after a new account was found'), 'withdrawn', 'withdrawing again is not an error');
select is((select count(*) from payments.own_account_attestations), 2::bigint, 'and wrote no third record');
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err(format($$select payments.link_settlement_account(%L, %L)$$, pg_temp.got('sa1'), pg_temp.got('reg1'))), '55000|own_account_list_not_attested',
  'a settlement account cannot be linked while the list is not attested');
select is(pg_temp.err($$select payments.withdraw_own_account_list_attestation('short')$$), '22023|reason_required', 'a withdrawal needs a reason');
select pg_temp.as_owner();
select is(private.feature_prerequisites_unmet(pg_temp.lx(), 'payments') @> array['own_account_list_not_attested'], true, 'payments cannot be switched on: own_account_list_not_attested');
select is(private.feature_prerequisites_unmet(pg_temp.lx(), 'mandates') @> array['own_account_list_not_attested'], true, 'nor mandates');
select is(private.feature_prerequisites_unmet(pg_temp.lx(), 'reminders') @> array['own_account_list_not_attested'], false, 'other features are not held back by it');
select pg_temp.as_user(pg_temp.u(4));
select is(payments.attest_own_account_list('SAMPLE-OWN-LIST-2', 'attested again after the review'), 'attested', 'a verifier attests again, on new evidence');
select pg_temp.as_user(pg_temp.u(1));
select is(payments.link_settlement_account(pg_temp.got('sa1')::uuid, pg_temp.got('reg1')::uuid), 'verified', 'the settlement account is linked once the list is attested');
select pg_temp.as_owner();
select is(private.feature_prerequisites_unmet(pg_temp.lx(), 'payments') @> array['own_account_list_not_attested'], false, 'and the payments gate no longer names it');
select is((select array_agg(event_kind order by occurred_at) from payments.own_account_attestations), array['attested', 'withdrawn', 'attested'], 'the history keeps all three events');
select is(pg_temp.err($$update payments.own_account_attestations set evidence_ref = 'REWRITTEN-EVIDENCE'$$), 'P0001|Record a compensating entry instead.', 'the history is append-only');
select is(pg_temp.err($$truncate payments.own_account_attestations$$), 'P0001|', 'and cannot be truncated');
select pg_temp.as_user(pg_temp.u(1));
select is((select count(*) from payments.own_account_attestations), 3::bigint, 'registry users read the history');
select pg_temp.as_user(pg_temp.u(8));
select is((select count(*) from payments.own_account_attestations), 0::bigint, 'a lender user sees none of it');
select is(pg_temp.err($$insert into payments.own_account_attestations (event_kind, key_version, evidence_ref, entries_counted, actor_id) values ('attested', 1, 'FORGED-EVIDENCE', 1, auth.uid())$$), '42501|', 'and cannot forge a record');
select pg_temp.as_system();
select is(pg_temp.err($$select count(*) from payments.own_account_attestations$$), '42501|', 'the system role has no privilege on the table');
select pg_temp.as_anon();
select is(pg_temp.err($$select count(*) from payments.own_account_attestations$$), '42501|', 'anon neither');

-- ============================================================================================================================
-- 2. A19, M2, U52: merchant claims reveal nothing, can be withdrawn, are capped; only one claim of an id is verified
-- ============================================================================================================================
select pg_temp.as_user(pg_temp.u(8));
select pg_temp.keep('mx1', payments.claim_merchant(pg_temp.lx(), 'sample_provider', 'SAMPLE-MERCH-X1')::text);
select is(payments.claim_merchant(pg_temp.lx(), 'sample_provider', 'SAMPLE-MERCH-X1')::text, pg_temp.got('mx1'), 'claiming your own live claim again is idempotent');
select pg_temp.as_user(pg_temp.u(12));
select pg_temp.keep('my_squat', payments.claim_merchant(pg_temp.ly(), 'sample_provider', 'SAMPLE-MERCH-X1')::text);
select isnt(pg_temp.got('my_squat'), pg_temp.got('mx1'),
  'lender Y claims the id that lender X holds and the claim SUCCEEDS as a separate unverified claim: the answer does not reveal who holds an id');
select is((select count(*) from payments.merchant_registry where owner_org_id = pg_temp.lx()), 0::bigint, 'and lender Y sees nothing of lender X''s claim');
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err(format($$select payments.verify_merchant(%L, 'SAMPLE-MERCH-EVID-1')$$, pg_temp.got('mx1'))), 'ok', 'the platform verifies the claim of the lender that really holds the id');
select is(pg_temp.err(format($$select payments.verify_merchant(%L, 'SAMPLE-MERCH-EVID-Y')$$, pg_temp.got('my_squat'))), '55000|merchant_already_claimed',
  'the competing claim cannot be verified while the first is verified and active (only the platform learns of the conflict)');
select pg_temp.as_user(pg_temp.u(9));
select is(pg_temp.err(format($$select payments.withdraw_merchant_claim(%L, %L)$$, pg_temp.lx(), pg_temp.got('my_squat'))), 'P0002|', 'lender X cannot withdraw lender Y''s claim (it reads as not found)');
select is(pg_temp.err(format($$select payments.withdraw_merchant_claim(%L, %L)$$, pg_temp.lx(), pg_temp.got('mx1'))), '55000|already_verified', 'a VERIFIED claim cannot be withdrawn: the platform revokes it');
select pg_temp.as_user(pg_temp.u(13));
select is(pg_temp.err(format($$select payments.withdraw_merchant_claim(%L, %L)$$, pg_temp.ly(), pg_temp.got('my_squat'))), '42501|', 'an approver (no payment.configure) cannot withdraw a claim');
select pg_temp.as_user(pg_temp.u(12), 'aal1');
select is(pg_temp.err(format($$select payments.withdraw_merchant_claim(%L, %L)$$, pg_temp.ly(), pg_temp.got('my_squat'))), '42501|mfa_required', 'withdrawing needs a second factor');
select pg_temp.as_anon();
select is(pg_temp.err(format($$select payments.withdraw_merchant_claim(%L, %L)$$, pg_temp.ly(), pg_temp.got('my_squat'))), '42501|', 'anon cannot withdraw');
select pg_temp.as_user(pg_temp.u(12));
select is(payments.withdraw_merchant_claim(pg_temp.ly(), pg_temp.got('my_squat')::uuid), 'revoked', 'lender Y withdraws its own UNVERIFIED claim');
select is(payments.withdraw_merchant_claim(pg_temp.ly(), pg_temp.got('my_squat')::uuid), 'revoked', 'withdrawing again is idempotent');
select pg_temp.as_owner();
select is((select (status, verification_status, revoked_by = pg_temp.u(12), revoked_reason)::text from payments.merchant_registry where id = pg_temp.got('my_squat')::uuid),
  '(revoked,unverified,t,"withdrawn by the lender before verification")', 'the withdrawn claim stays as history with who withdrew it');
select pg_temp.as_user(pg_temp.u(12));
select pg_temp.keep('my_again', payments.claim_merchant(pg_temp.ly(), 'sample_provider', 'SAMPLE-MERCH-X1')::text);
select isnt(pg_temp.got('my_again'), pg_temp.got('my_squat'), 'claiming again after a withdrawal creates a new claim (the old one is history)');
-- The cap: at most 20 unverified live claims per lender.
select is((select count(payments.claim_merchant(pg_temp.ly(), 'sample_provider', 'SAMPLE-CAP-' || lpad(g::text, 2, '0'))) from generate_series(1, 19) g), 19::bigint,
  'a lender can hold up to twenty unverified live claims (nineteen new ones plus the re-claim above)');
select is(pg_temp.err($$select payments.claim_merchant('f9b00000-0000-4000-8000-000000000002', 'sample_provider', 'SAMPLE-CAP-20')$$), '22023|too_many_claims', 'the twenty-first is refused');
select is(payments.claim_merchant(pg_temp.ly(), 'sample_provider', 'SAMPLE-CAP-01')::text, (select id::text from payments.merchant_registry where merchant_ref = 'SAMPLE-CAP-01'),
  'but repeating a live claim still answers it');
select is(payments.withdraw_merchant_claim(pg_temp.ly(), (select id from payments.merchant_registry where merchant_ref = 'SAMPLE-CAP-19')), 'revoked', 'a withdrawal frees a slot');
select is(pg_temp.err($$select payments.claim_merchant('f9b00000-0000-4000-8000-000000000002', 'sample_provider', 'SAMPLE-CAP-20')$$), 'ok', 'and the next claim goes through');
-- A platform revocation of the verified claim releases the id for another verification.
select pg_temp.as_user(pg_temp.u(8));
select pg_temp.keep('mrel_x', payments.claim_merchant(pg_temp.lx(), 'sample_provider', 'SAMPLE-MERCH-REL')::text);
select pg_temp.as_user(pg_temp.u(2));
select payments.verify_merchant(pg_temp.got('mrel_x')::uuid, 'SAMPLE-MERCH-EVID-R1');
select pg_temp.as_user(pg_temp.u(12));
select payments.withdraw_merchant_claim(pg_temp.ly(), (select id from payments.merchant_registry where merchant_ref = 'SAMPLE-CAP-01'));
select pg_temp.keep('mrel_y', payments.claim_merchant(pg_temp.ly(), 'sample_provider', 'SAMPLE-MERCH-REL')::text);
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err(format($$select payments.verify_merchant(%L, 'SAMPLE-MERCH-EVID-R2')$$, pg_temp.got('mrel_y'))), '55000|merchant_already_claimed', 'lender Y''s claim of the released-to-be id cannot be verified yet');
select is(payments.revoke_merchant(pg_temp.got('mrel_x')::uuid, 'the first lender no longer uses this merchant id'), 'revoked', 'the platform revokes the verified claim');
select is(payments.verify_merchant(pg_temp.got('mrel_y')::uuid, 'SAMPLE-MERCH-EVID-R2'), 'verified', 'and the id can now be verified for the other claimant: nothing is stuck for good');
-- Udofin's own fee merchant.
select pg_temp.as_user(pg_temp.u(2));
select pg_temp.keep('mfee', payments.register_udofin_fee_merchant('sample_provider', 'SAMPLE-UDOFIN-FEES')::text);
select is(payments.register_udofin_fee_merchant('sample_provider', 'SAMPLE-UDOFIN-FEES')::text, pg_temp.got('mfee'), 'registering the fee merchant again is idempotent');
select is(pg_temp.err($$select payments.register_udofin_fee_merchant('sample_provider', 'SAMPLE-MERCH-X1')$$), '23505|merchant_already_claimed', 'an id verified for a lender cannot be registered as Udofin''s fee merchant');
select pg_temp.as_user(pg_temp.u(8));
select pg_temp.keep('mx_fee_squat', payments.claim_merchant(pg_temp.lx(), 'sample_provider', 'SAMPLE-UDOFIN-FEES')::text);
select isnt(pg_temp.got('mx_fee_squat'), pg_temp.got('mfee'), 'a lender''s claim of Udofin''s fee merchant id succeeds as an ordinary claim (no oracle) ...');
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err(format($$select payments.verify_merchant(%L, 'SAMPLE-MERCH-EVID-F')$$, pg_temp.got('mx_fee_squat'))), '55000|merchant_already_claimed', '... and can never be verified');
select pg_temp.as_owner();
select is(pg_temp.err($$insert into payments.merchant_registry (provider, merchant_ref, owner_kind, owner_org_id, purpose, claimed_by, verification_status, verification_evidence_ref, verified_by, verified_at)
  values ('sample_provider', 'SAMPLE-MERCH-X1', 'lender', 'f9b00000-0000-4000-8000-000000000002', 'repayment', 'f9000000-0000-4000-8000-000000000012', 'verified', 'SAMPLE-EVID-DIRECT', 'f9000000-0000-4000-8000-000000000001', now())$$),
  '23505|', 'table level: two verified active claims of one id are refused for every writer (unique partial index)');
select is(pg_temp.err($$insert into payments.merchant_registry (provider, merchant_ref, owner_kind, owner_org_id, purpose, claimed_by)
  values ('sample_provider', 'SAMPLE-MERCH-X1', 'lender', 'f9b00000-0000-4000-8000-000000000001', 'repayment', 'f9000000-0000-4000-8000-000000000008')$$),
  '23505|', 'table level: one live claim of an id per lender');
select has_index('payments', 'merchant_registry', 'merchant_registry_one_verified', 'the verified-claim index exists');
select pg_temp.as_user(pg_temp.u(8));
select pg_temp.keep('mx2', payments.claim_merchant(pg_temp.lx(), 'sample_provider', 'SAMPLE-MERCH-X2')::text);
select pg_temp.as_user(pg_temp.u(1));
select payments.verify_merchant(pg_temp.got('mx2')::uuid, 'SAMPLE-MERCH-EVID-2');

-- ============================================================================================================================
-- 3. A14, A15, A16, M3, M4, U37: settlement-account requests (canonical reference, personal-data screen, serialised, withdrawable)
-- ============================================================================================================================
select pg_temp.as_user(pg_temp.u(8));
select is(pg_temp.err($$select payments.request_settlement_account('f9b00000-0000-4000-8000-000000000001', 'SAMPLE account', 'Sample Bank', 'XXXX1234')$$), '22023|settlement_account_invalid',
  'A15: a masked reference with four X is refused (the registry''s form is six X and four digits: it could never be linked)');
select is(pg_temp.err($$select payments.request_settlement_account('f9b00000-0000-4000-8000-000000000001', 'SAMPLE account', 'Sample Bank', '******1234')$$), '22023|settlement_account_invalid', 'nor stars');
select is(pg_temp.err($$select payments.request_settlement_account('f9b00000-0000-4000-8000-000000000001', 'SAMPLE account', 'Sample Bank', 'XXXXXX34')$$), '22023|settlement_account_invalid', 'nor only two digits');
select is(pg_temp.err($$select payments.request_settlement_account('f9b00000-0000-4000-8000-000000000001', 'SAMPLE account', 'Sample Bank', 'XXXXXX12345')$$), '22023|settlement_account_invalid', 'nor five digits');
select is(pg_temp.err($$select payments.request_settlement_account('f9b00000-0000-4000-8000-000000000001', 'SAMPLE account', 'Sample Bank', 'xxxxxx1234')$$), '22023|settlement_account_invalid', 'nor lower case');
select is(pg_temp.err($$select payments.request_settlement_account('f9b00000-0000-4000-8000-000000000001', 'HDFC current a/c 5010 0123 4567 89', 'HDFC Bank', 'XXXXXX6789')$$), '22023|settlement_account_invalid',
  'A16/U37: a full account number typed with SPACES in the label is refused');
select is(pg_temp.err($$select payments.request_settlement_account('f9b00000-0000-4000-8000-000000000001', 'SBI 5010-0123-4567-89', 'HDFC Bank', 'XXXXXX6789')$$), '22023|settlement_account_invalid', 'and with HYPHENS');
select is(pg_temp.err($$select payments.request_settlement_account('f9b00000-0000-4000-8000-000000000001', 'SAMPLE account', 'Bank a/c 5010-0123-4567-89 SBIN0ABC123', 'XXXXXX6789')$$), '22023|settlement_account_invalid',
  'M3: nor in the bank name, with an IFSC-shaped token next to it');
select is(pg_temp.err($$select payments.request_settlement_account('f9b00000-0000-4000-8000-000000000001', 'SAMPLE account', 'HDFC0001234', 'XXXXXX6789')$$), '22023|settlement_account_invalid', 'an IFSC-shaped bank name is refused');
select is(pg_temp.err($$select payments.request_settlement_account('f9b00000-0000-4000-8000-000000000001', 'owner abcde1234f', 'Sample Bank', 'XXXXXX6789')$$), '22023|settlement_account_invalid', 'a PAN-shaped label is refused in any letter case');
select is(pg_temp.err($$select payments.request_settlement_account('f9b00000-0000-4000-8000-000000000001', 'see https://pay.example.test/x', 'Sample Bank', 'XXXXXX6789')$$), '22023|settlement_account_invalid', 'a link in the label is refused');
select is(pg_temp.err($$select payments.request_settlement_account('f9b00000-0000-4000-8000-000000000001', 'someone@example.test', 'Sample Bank', 'XXXXXX6789')$$), '22023|settlement_account_invalid', 'an e-mail address in the label is refused');
select is(pg_temp.err($$select payments.request_settlement_account('f9b00000-0000-4000-8000-000000000001', 'SAMPLE account 2026', 'Sample Bank', 'XXXXXX6789')$$), 'ok', 'a label with a few digits is fine');
select pg_temp.keep('sa2', payments.request_settlement_account(pg_temp.lx(), 'SAMPLE second account', 'Sample Bank', pg_temp.mask(2))::text);
select is(payments.request_settlement_account(pg_temp.lx(), 'SAMPLE second account', 'SAMPLE BANK', pg_temp.mask(2))::text, pg_temp.got('sa2'), 'the same bank (any letter case) and masked reference is idempotent');
select is(pg_temp.err(format($$select payments.request_settlement_account(%L, 'Another label', 'Sample Bank', %L)$$, pg_temp.lx(), pg_temp.mask(2))), '23505|settlement_account_exists', 'another label for the same pair is refused');
select is(payments.request_settlement_account(pg_temp.lx(), 'SAMPLE collections', 'Sample Bank', pg_temp.mask(1))::text, pg_temp.got('sa1'),
  'A15: a request that matches an existing VERIFIED account answers that account (the caller reads its real status from the row)');
select is((select status::text from tenancy.lender_settlement_accounts where id = pg_temp.got('sa1')::uuid), 'verified', 'which is verified, not "unverified"');
select is((select pg_temp.holds_advisory('settlement_request:' || pg_temp.lx()::text)), true, 'M4: the request serialised itself with a per-lender transaction lock');
select has_index('tenancy', 'lender_settlement_accounts', 'lender_settlement_accounts_live', 'M4: a unique index over live rows (lender, bank, masked reference) backs the lock');
-- Withdrawal.
select pg_temp.as_user(pg_temp.u(12));
select is(pg_temp.err(format($$select payments.withdraw_settlement_account(%L, %L)$$, pg_temp.ly(), pg_temp.got('sa2'))), 'P0002|', 'A15: lender Y cannot withdraw lender X''s account (it reads as not found)');
select pg_temp.as_user(pg_temp.u(10));
select is(pg_temp.err(format($$select payments.withdraw_settlement_account(%L, %L)$$, pg_temp.lx(), pg_temp.got('sa2'))), '42501|', 'an approver cannot withdraw');
select pg_temp.as_user(pg_temp.u(8), 'aal1');
select is(pg_temp.err(format($$select payments.withdraw_settlement_account(%L, %L)$$, pg_temp.lx(), pg_temp.got('sa2'))), '42501|mfa_required', 'withdrawing needs a second factor');
select pg_temp.as_anon();
select is(pg_temp.err(format($$select payments.withdraw_settlement_account(%L, %L)$$, pg_temp.lx(), pg_temp.got('sa2'))), '42501|', 'anon cannot');
select pg_temp.as_user(pg_temp.u(8));
select is(pg_temp.err(format($$select payments.withdraw_settlement_account(%L, %L)$$, pg_temp.lx(), pg_temp.got('sa1'))), '55000|already_linked', 'a linked, verified account cannot be withdrawn: the platform revokes it');
select is(payments.withdraw_settlement_account(pg_temp.lx(), pg_temp.got('sa2')::uuid), 'revoked', 'A15: the maker withdraws an unlinked request');
select is(payments.withdraw_settlement_account(pg_temp.lx(), pg_temp.got('sa2')::uuid), 'revoked', 'withdrawing again is idempotent');
select pg_temp.keep('sa2b', payments.request_settlement_account(pg_temp.lx(), 'SAMPLE second account', 'Sample Bank', pg_temp.mask(2))::text);
select isnt(pg_temp.got('sa2b'), pg_temp.got('sa2'), 'A14/M4: after the withdrawal the same bank and masked reference can be requested again, as a NEW row (the revoked one is history, not returned as success)');
select is((select status::text from tenancy.lender_settlement_accounts where id = pg_temp.got('sa2b')::uuid), 'unverified', 'and it starts unverified');
-- The cap counts live rows only.
select pg_temp.as_owner();
insert into tenancy.lender_settlement_accounts (lender_org_id, label, bank_name, masked_account_ref)
select pg_temp.lx(), 'SAMPLE filler ' || g, 'Filler Bank', 'XXXXXX' || lpad((500 + g)::text, 4, '0')
  from generate_series(1, 20 - (select count(*)::int from tenancy.lender_settlement_accounts where lender_org_id = pg_temp.lx() and status <> 'revoked')) g;
select is((select count(*) from tenancy.lender_settlement_accounts where lender_org_id = pg_temp.lx() and status <> 'revoked'), 20::bigint, 'fixture: the lender holds twenty live settlement accounts and one revoked');
select pg_temp.as_user(pg_temp.u(8));
select is(pg_temp.err($$select payments.request_settlement_account('f9b00000-0000-4000-8000-000000000001', 'SAMPLE one too many', 'Sample Bank', 'XXXXXX9999')$$), '22023|too_many_settlement_accounts', 'the twenty-first live account is refused (the revoked one did not count)');
select is(payments.withdraw_settlement_account(pg_temp.lx(), (select id from tenancy.lender_settlement_accounts where label = 'SAMPLE filler 1')), 'revoked', 'withdrawing one frees a slot ...');
select is(pg_temp.err($$select payments.request_settlement_account('f9b00000-0000-4000-8000-000000000001', 'SAMPLE one too many', 'Sample Bank', 'XXXXXX9999')$$), 'ok', '... and the request goes through');
select pg_temp.as_owner();
select is(pg_temp.err($$insert into tenancy.lender_settlement_accounts (lender_org_id, label, bank_name, masked_account_ref) values ('f9b00000-0000-4000-8000-000000000001', 'SAMPLE duplicate', 'SAMPLE BANK', 'XXXXXX0001')$$), '23505|',
  'M4: table level: a second LIVE row for the same lender, bank (any case) and masked reference is refused for every writer');
select is(pg_temp.err($$insert into tenancy.lender_settlement_accounts (lender_org_id, label, bank_name, masked_account_ref, status) values ('f9b00000-0000-4000-8000-000000000001', 'SAMPLE history', 'Sample Bank', 'XXXXXX0002', 'revoked')$$), 'ok',
  'but a revoked row for a live pair is allowed (history)');
select is(pg_temp.err($$insert into tenancy.lender_settlement_accounts (lender_org_id, label, bank_name, masked_account_ref) values ('f9b00000-0000-4000-8000-000000000001', 'Collections 5010 0123 4567 89', 'Other Bank', 'XXXXXX0003')$$), '22023|unsafe_free_text',
  'A16: table level: a spaced account number in the label is refused for every writer');
select is(pg_temp.err(format($$update tenancy.lender_settlement_accounts set bank_name = 'HDFC0001234' where id = %L$$, pg_temp.got('sa2b'))), '22023|unsafe_free_text', 'and so is an IFSC-shaped bank name on update');

-- ============================================================================================================================
-- 4. A13, M0, U11, U49: a platform or system hold on a payment configuration is not the lender's to undo
--    M5, U54: one active configuration per lender.  M6: long notes raise the stable hint.
-- ============================================================================================================================
-- Lender X: verified merchant mx2, linked settlement account sa1, provider sample_provider.
create function pg_temp.draft_x(k text, provider text default 'sample_provider') returns uuid language plpgsql as $fn$
declare v_id uuid;
begin
  perform pg_temp.as_user(pg_temp.u(8));
  v_id := pg_temp.draft(pg_temp.lx(), k, pg_temp.got('mx2')::uuid, pg_temp.got('sa1')::uuid, provider);
  return v_id;
end
$fn$;
-- Drafted by 8, submitted by 9: pending approval.
create function pg_temp.pending_x(k text) returns uuid language plpgsql as $fn$
declare v_id uuid;
begin
  v_id := pg_temp.draft_x(k);
  perform pg_temp.as_user(pg_temp.u(9));
  perform payments.submit_payment_config(v_id);
  return v_id;
end
$fn$;
select pg_temp.as_owner();
grant execute on all functions in schema pg_temp to public;

select pg_temp.keep('c1', pg_temp.draft_x('cfg-key-028-000000001')::text);
select is(pg_temp.live(pg_temp.got('c1')::uuid, 9, 10), 'active', 'fixture: lender X''s first configuration is active');
-- M5: one active configuration per lender.
select pg_temp.keep('c2', pg_temp.pending_x('cfg-key-028-000000002')::text);
select pg_temp.as_user(pg_temp.u(11));
select is(pg_temp.err(format($$select payments.decide_payment_config(%L, true, 'SAMPLE approval')$$, pg_temp.got('c2'))), '55000|active_config_exists',
  'M5: approving a second configuration while the first is active is refused with a stable reason (payments would refuse the lender with config_ambiguous)');
select pg_temp.as_owner();
select is((select count(*) from payments.lender_payment_configs where lender_org_id = pg_temp.lx() and status = 'active'), 1::bigint, 'and the lender still has exactly one active configuration');
select is(pg_temp.err(format($$update payments.lender_payment_configs set status = 'active', approved_by = %L, approved_at = now() where id = %L$$, pg_temp.u(11), pg_temp.got('c2'))), '23505|',
  'M5: table level: a second ACTIVE row for one lender is refused by the unique partial index for every writer');
select has_index('payments', 'lender_payment_configs', 'lender_payment_configs_one_active', 'the unique index exists');
select pg_temp.as_user(pg_temp.u(10));
select is(payments.retire_payment_config(pg_temp.got('c1')::uuid, 'replaced by the second configuration'), 'retired', 'the approver retires the first configuration ...');
select pg_temp.as_user(pg_temp.u(11));
select is(payments.decide_payment_config(pg_temp.got('c2')::uuid, true, 'SAMPLE approval'), 'active', '... and then approves the second');

-- A13: the platform kill switch is not undone by the lender's maker and checker.
select pg_temp.as_user(pg_temp.u(1));
select is(payments.suspend_payment_config(pg_temp.got('c2')::uuid, 'provider reported a settlement incident today'), 'suspended', 'a platform person suspends the active configuration');
select pg_temp.as_owner();
select is((select (status, hold_kind, hold_set_by = pg_temp.u(1), hold_set_at is not null)::text from payments.lender_payment_configs where id = pg_temp.got('c2')::uuid), '(suspended,platform,t,t)',
  'the suspension is a HOLD: who set it and when is recorded');
select pg_temp.as_user(pg_temp.u(9));
select is(pg_temp.err(format($$select payments.submit_payment_config(%L)$$, pg_temp.got('c2'))), '55000|platform_hold', 'the lender''s maker cannot re-submit it');
select pg_temp.as_user(pg_temp.u(8));
select pg_temp.keep('c3', pg_temp.draft_x('cfg-key-028-000000003')::text);
select pg_temp.as_user(pg_temp.u(9));
select is(pg_temp.err(format($$select payments.submit_payment_config(%L)$$, pg_temp.got('c3'))), '55000|platform_hold',
  'nor submit a NEW configuration of the same lender while the hold stands (a new draft must not undo the kill switch)');
select pg_temp.as_user(pg_temp.u(10));
select is(pg_temp.err(format($$select payments.retire_payment_config(%L, 'the approver must not retire a held configuration')$$, pg_temp.got('c2'))), '55000|platform_hold', 'the lender''s approver cannot retire the held configuration');
select pg_temp.as_owner();
select is(pg_temp.err(format($$update payments.lender_payment_configs set status = 'pending_approval', submitted_by = %L, submitted_at = now() where id = %L$$, pg_temp.u(9), pg_temp.got('c3'))), '55000|platform_hold',
  'table level: another configuration of the lender cannot become pending while a hold stands, whoever writes');
select is(pg_temp.err(format($$update payments.lender_payment_configs set status = 'pending_approval', submitted_by = %L, submitted_at = now() where id = %L$$, pg_temp.u(9), pg_temp.got('c2'))), '55000|platform_hold',
  'table level: the held configuration itself cannot become pending');
select is(pg_temp.err(format($$update payments.lender_payment_configs set status = 'active', approved_by = %L, approved_at = now() where id = %L$$, pg_temp.u(11), pg_temp.got('c2'))), 'P0001|',
  'M7: table level: suspended -> active is not a transition at all');
select is(pg_temp.err(format($$update payments.lender_payment_configs set hold_kind = 'platform', hold_set_by = null where id = %L$$, pg_temp.got('c2'))), '23514|', 'a platform hold needs the person who set it (check)');
select is(pg_temp.err(format($$update payments.lender_payment_configs set hold_kind = 'system', hold_set_by = %L, hold_set_at = now() where id = %L$$, pg_temp.u(1), pg_temp.got('c2'))), '23514|', 'a system hold has no person (check)');
select is(pg_temp.err(format($$update payments.lender_payment_configs set hold_kind = null where id = %L$$, pg_temp.got('c2'))), '23514|', 'a hold is set and cleared whole (check)');
select is(pg_temp.err(format($$update payments.lender_payment_configs set secret_ref = 'OTHER_SECRET_NAME' where id = %L$$, pg_temp.got('c2'))), 'P0001|', 'content stays immutable');
-- Who may lift it.
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err(format($$select payments.release_payment_config_hold(%L, 'the suspending person must not lift the hold')$$, pg_temp.got('c2'))), '42501|self_approval', 'the platform person who set the hold cannot lift it');
select pg_temp.as_user(pg_temp.u(7));
select is(pg_temp.err(format($$select payments.release_payment_config_hold(%L, 'a platform user without a role must not lift it')$$, pg_temp.got('c2'))), '42501|', 'a platform user without the permission cannot');
select pg_temp.as_user(pg_temp.u(3));
select is(pg_temp.err(format($$select payments.release_payment_config_hold(%L, 'an account verifier must not lift the hold')$$, pg_temp.got('c2'))), '42501|', 'nor a registry verifier (providers.manage is needed)');
select pg_temp.as_user(pg_temp.u(10));
select is(pg_temp.err(format($$select payments.release_payment_config_hold(%L, 'the lender''s own approver must not lift it')$$, pg_temp.got('c2'))), '42501|', 'nor the lender''s approver');
select pg_temp.as_user(pg_temp.u(12));
select is(pg_temp.err(format($$select payments.release_payment_config_hold(%L, 'another lender must not lift it either')$$, pg_temp.got('c2'))), '42501|', 'nor another lender');
select pg_temp.as_anon();
select is(pg_temp.err(format($$select payments.release_payment_config_hold(%L, 'anon must not lift the hold at all')$$, pg_temp.got('c2'))), '42501|', 'nor anon');
select pg_temp.as_system();
select is(pg_temp.err(format($$select payments.release_payment_config_hold(%L, 'the system role must not lift the hold')$$, pg_temp.got('c2'))), '42501|', 'nor the system role');
select pg_temp.as_user(pg_temp.u(2), 'aal1');
select is(pg_temp.err(format($$select payments.release_payment_config_hold(%L, 'lifting needs a second factor')$$, pg_temp.got('c2'))), '42501|mfa_required', 'lifting needs a second factor');
select pg_temp.as_user(pg_temp.u(2));
select is(pg_temp.err(format($$select payments.release_payment_config_hold(%L, 'short')$$, pg_temp.got('c2'))), '22023|reason_required', 'and a reason');
select is(pg_temp.err($$select payments.release_payment_config_hold('00000000-0000-4000-8000-000000000000', 'an unknown configuration here')$$), 'P0002|', 'an unknown configuration is not found');
select is(payments.release_payment_config_hold(pg_temp.got('c2')::uuid, 'incident closed, evidence reviewed by a second person'), 'suspended', 'a DIFFERENT platform person lifts the hold; the configuration stays suspended');
select is(payments.release_payment_config_hold(pg_temp.got('c2')::uuid, 'incident closed, evidence reviewed by a second person'), 'suspended', 'lifting again is idempotent');
select pg_temp.as_owner();
select is((select (hold_kind is null, hold_set_by is null, hold_set_at is null)::text from payments.lender_payment_configs where id = pg_temp.got('c2')::uuid), '(t,t,t)', 'the hold is cleared');
select is((select (event_kind, actor_kind, actor_id = pg_temp.u(2), note)::text from payments.lender_payment_config_events where config_id = pg_temp.got('c2')::uuid and event_kind = 'hold_released'),
  '(hold_released,platform,t,"incident closed, evidence reviewed by a second person")', 'the history records who lifted it and why');
select is((select count(*) from audit.events where action = 'payments.config.hold_released' and entity_id = pg_temp.got('c2') and tenant_org_id = pg_temp.lx() and metadata = '{"hold_kind": "platform"}'::jsonb), 1::bigint, 'and so does the audit trail, with no free text');
select pg_temp.as_user(pg_temp.u(9));
select is(payments.submit_payment_config(pg_temp.got('c2')::uuid), 'pending_approval', 'now the lender re-submits it (validated again) ...');
select pg_temp.as_user(pg_temp.u(11));
select is(payments.decide_payment_config(pg_temp.got('c2')::uuid, true, 'SAMPLE re-approval'), 'active', '... and a different approver approves it again');
-- A suspended configuration without a hold receives one from the platform / the system.
select pg_temp.as_owner();
update payments.lender_payment_configs set status = 'suspended' where id = pg_temp.got('c2')::uuid;
select pg_temp.as_user(pg_temp.u(1));
select is(payments.suspend_payment_config(pg_temp.got('c2')::uuid, 'the platform puts its own hold on it now'), 'suspended', 'a platform call on a configuration that is already suspended (without a hold) ...');
select is((select hold_kind from payments.lender_payment_configs where id = pg_temp.got('c2')::uuid), 'platform', '... puts the platform hold on it');
-- The platform itself may retire a held configuration.
select is(payments.retire_payment_config(pg_temp.got('c2')::uuid, 'retired by the platform while it was held'), 'retired', 'the platform retires a held configuration');
select pg_temp.as_owner();
select is((select (status, hold_kind)::text from payments.lender_payment_configs where id = pg_temp.got('c2')::uuid), '(retired,platform)', 'the hold stays on the retired row as history');

-- System holds: the system suspension and the nightly run.
select pg_temp.keep('c4', pg_temp.draft_x('cfg-key-028-000000004')::text);
select is(pg_temp.live(pg_temp.got('c4')::uuid, 9, 10), 'active', 'fixture: a new configuration is active (the earlier hold was on a retired one)');
select pg_temp.as_system();
select is(payments.system_suspend_payment_config(pg_temp.got('c4')::uuid, 'settlement_account_mismatch'), 'suspended', 'U11: the system suspends a configuration (money reported settled to another account)');
select pg_temp.as_owner();
select is((select (hold_kind, hold_set_by is null, status_reasons)::text from payments.lender_payment_configs where id = pg_temp.got('c4')::uuid), '(system,t,{settlement_account_mismatch})', 'it is a system hold with the reason code');
select pg_temp.as_user(pg_temp.u(9));
select is(pg_temp.err(format($$select payments.submit_payment_config(%L)$$, pg_temp.got('c4'))), '55000|platform_hold', 'U11: the lender''s maker cannot re-submit it, although the registry, the merchant and the provider are all still valid');
select pg_temp.as_system();
select is(payments.system_suspend_payment_config(pg_temp.got('c4')::uuid, 'settlement_account_mismatch'), 'suspended', 'the system call is idempotent');
select pg_temp.as_user(pg_temp.u(1));
select is(payments.release_payment_config_hold(pg_temp.got('c4')::uuid, 'settlement reviewed with the provider, no loss found'), 'suspended', 'any platform person holding providers.manage lifts a SYSTEM hold');
select is(pg_temp.live(pg_temp.got('c4')::uuid, 9, 10), 'active', 'and the lender''s pair re-approves it');
select pg_temp.as_owner();
update payments.lender_payment_configs set status = 'suspended' where id = pg_temp.got('c4')::uuid;
select pg_temp.as_system();
select is(payments.system_suspend_payment_config(pg_temp.got('c4')::uuid, 'merchant_mismatch'), 'suspended', 'a system call on a suspended configuration without a hold ...');
select pg_temp.as_owner();
select is((select hold_kind from payments.lender_payment_configs where id = pg_temp.got('c4')::uuid), 'system', '... puts the system hold on it');
select pg_temp.as_user(pg_temp.u(2));
select payments.release_payment_config_hold(pg_temp.got('c4')::uuid, 'merchant mismatch explained by the provider');
select is(pg_temp.live(pg_temp.got('c4')::uuid, 9, 10), 'active', 'fixture: active again');
-- The nightly run.
select pg_temp.as_owner();
update onboarding.lender_gates set stage = 'suspended' where lender_org_id = pg_temp.lx();
select pg_temp.as_system();
select is((select count(*) from payments.revalidate_payment_configs(pg_temp.lx()) where suspended), 1::bigint, 'the nightly run suspends the configuration whose validation fails');
select pg_temp.as_owner();
update onboarding.lender_gates set stage = 'activated' where lender_org_id = pg_temp.lx();
select is((select (hold_kind, status_reason)::text from payments.lender_payment_configs where id = pg_temp.got('c4')::uuid), '(system,"system hold: validation failed")', 'and the suspension is a system hold');
select pg_temp.as_user(pg_temp.u(9));
select is(pg_temp.err(format($$select payments.submit_payment_config(%L)$$, pg_temp.got('c4'))), '55000|platform_hold', 'the lender cannot re-submit it, even though the cause has gone');
select pg_temp.as_user(pg_temp.u(1));
select payments.release_payment_config_hold(pg_temp.got('c4')::uuid, 'gate restored, nightly hold reviewed by the platform');
select is(pg_temp.live(pg_temp.got('c4')::uuid, 9, 10), 'active', 'once a platform person lifts it, the pair re-approves it');

-- M6: a long note raises reason_invalid, never a raw check violation (and no row in an error message).
select pg_temp.keep('c_r1', pg_temp.pending_x('cfg-key-028-000000011')::text);
select pg_temp.keep('c_r2', pg_temp.pending_x('cfg-key-028-000000012')::text);
select pg_temp.as_user(pg_temp.u(11));
select is(pg_temp.err(format($$select payments.decide_payment_config(%L, false, repeat('n', 991))$$, pg_temp.got('c_r1'))), '22023|reason_invalid', 'M6: a rejection note of 991 characters (the prefix "rejected: " would exceed 1000) is refused with the stable hint');
select is(pg_temp.msg(format($$select payments.decide_payment_config(%L, false, repeat('n', 991))$$, pg_temp.got('c_r1'))) !~* 'Failing row|endpoint_token', true, 'and the message carries no row');
select is(payments.decide_payment_config(pg_temp.got('c_r1')::uuid, false, repeat('n', 990)), 'retired', 'a note of 990 characters is accepted');
select is((select length(status_reason) from payments.lender_payment_configs where id = pg_temp.got('c_r1')::uuid), 1000, 'and fills the column exactly');
select pg_temp.as_user(pg_temp.u(8));
select is(pg_temp.err(format($$select payments.withdraw_payment_config(%L, repeat('w', 990))$$, pg_temp.got('c_r2'))), '22023|reason_invalid', 'a withdrawal reason of 990 characters (prefix "withdrawn: ") is refused with the stable hint');
select is(payments.withdraw_payment_config(pg_temp.got('c_r2')::uuid, repeat('w', 989)), 'retired', 'one of 989 characters is accepted');
select pg_temp.as_user(pg_temp.u(10), 'aal1');
select is(pg_temp.err(format($$select payments.retire_payment_config(%L, 'a lender approver needs a second factor to retire')$$, pg_temp.got('c4'))), '42501|mfa_required', 'M7: retiring as the lender''s approver needs a second factor');
select pg_temp.as_user(pg_temp.u(10));
select is(pg_temp.err(format($$select payments.retire_payment_config(%L, repeat('r', 992))$$, pg_temp.got('c4'))), '22023|reason_invalid', 'a retirement reason of 992 characters (prefix "retired: ") is refused with the stable hint');
select is(payments.retire_payment_config(pg_temp.got('c4')::uuid, repeat('r', 991)), 'retired', 'one of 991 characters is accepted');

-- ============================================================================================================================
-- 5. M1, U50: a key rotation keeps the linked settlement accounts and the active configuration valid
-- ============================================================================================================================
select pg_temp.keep('c5', pg_temp.draft_x('cfg-key-028-000000005')::text);
select is(pg_temp.live(pg_temp.got('c5')::uuid, 9, 10), 'active', 'fixture: lender X has an active configuration settling into account sa1 (linked to registry entry reg1, key version 1)');
select pg_temp.as_system();
select is(payments.validate_collection_target(pg_temp.got('c5')::uuid) ->> 'ok', 'true', 'and it is valid before the rotation');
select pg_temp.as_user(pg_temp.u(1));
select is(payments.propose_fingerprint_key_version(2, 'SAMPLE rotation'), 2, 'a registry manager proposes key version 2');
select pg_temp.keep('s_u', pg_temp.register(900, 'rot-key-028-0000900', pg_temp.got('rule')::uuid, kind => 'udofin', org => null, purposes => array['fee_collection'], kv => 2,
  lname => 'Udofin SAMPLE Ltd (fixture)', others => jsonb_build_object('1', pg_temp.fp(900, 1)), rekeys => pg_temp.got('regu')::uuid)::text);
select pg_temp.keep('s_g', pg_temp.register(901, 'rot-key-028-0000901', pg_temp.got('rule')::uuid, kind => 'group_company', org => null, purposes => array['operational'], kv => 2,
  lname => 'Udofin Group SAMPLE Ltd (fixture)', others => jsonb_build_object('1', pg_temp.fp(901, 1)), rekeys => pg_temp.got('regg')::uuid)::text);
select pg_temp.keep('s_1', pg_temp.register(1, 'rot-key-028-0000001', pg_temp.got('rule')::uuid, kv => 2, others => jsonb_build_object('1', pg_temp.fp(1, 1)), rekeys => pg_temp.got('reg1')::uuid)::text);
select pg_temp.as_user(pg_temp.u(3));
select payments.verify_account(pg_temp.got('s_u')::uuid, 'SAMPLE-EVIDENCE-028-SU');
select payments.verify_account(pg_temp.got('s_g')::uuid, 'SAMPLE-EVIDENCE-028-SG');
select pg_temp.as_user(pg_temp.u(4));
select is(payments.verify_account(pg_temp.got('s_1')::uuid, 'SAMPLE-EVIDENCE-028-S1'), 'verified', 'every live entry is re-keyed and its successor verified (a lender entry can be verified: the list is attested under the active key)');
select is(payments.approve_fingerprint_key_version(2, 'SAMPLE approval of the rotation'), 'active', 'a different verifier approves key version 2: it becomes active, version 1 is retired');
select pg_temp.as_owner();
select is((select registry_id from tenancy.lender_settlement_accounts where id = pg_temp.got('sa1')::uuid), pg_temp.got('s_1')::uuid,
  'M1: the settlement account now points at the verified SUCCESSOR of its registry entry (re-linked in the same transaction)');
select is((select status::text from tenancy.lender_settlement_accounts where id = pg_temp.got('sa1')::uuid), 'verified', 'and is still verified');
select is((select count(*) from audit.events where action = 'payments.settlement_account.relinked' and entity_id = pg_temp.got('sa1') and tenant_org_id = pg_temp.lx()), 1::bigint, 'the re-link is audited for the lender');
select pg_temp.as_system();
select is(payments.validate_collection_target(pg_temp.got('c5')::uuid) ->> 'ok', 'true', 'the configuration is still valid (before the fix: destination_key_version_not_active)');
select is((select count(*) from payments.revalidate_payment_configs(pg_temp.lx()) where suspended), 0::bigint, 'and the nightly run does not suspend it: collections do not stop');
select pg_temp.as_owner();
select is((select status from payments.lender_payment_configs where id = pg_temp.got('c5')::uuid), 'active', 'the configuration is active');
select is(private.own_account_list_attested(), false, 'the own-account list needs a fresh attestation under the new key version');
select pg_temp.as_user(pg_temp.u(4));
select is(payments.attest_own_account_list('SAMPLE-OWN-LIST-3'), 'attested', 'a verifier attests it again (the re-keyed Udofin account is verified)');
-- The manual fallback: an account whose successor could not be taken over at the rotation is re-linked by a registry manager.
select pg_temp.as_owner();
alter table tenancy.lender_settlement_accounts disable trigger guard;
update tenancy.lender_settlement_accounts set registry_id = pg_temp.got('reg1')::uuid where id = pg_temp.got('sa1')::uuid;
alter table tenancy.lender_settlement_accounts enable trigger guard;
select pg_temp.as_system();
select is(payments.validate_collection_target(pg_temp.got('c5')::uuid) ->> 'ok', 'false', 'fixture: with the account back on the entry of the retired key the configuration would fail (destination_key_version_not_active)');
select pg_temp.as_user(pg_temp.u(3));
select is(pg_temp.err(format($$select payments.link_settlement_account(%L, %L)$$, pg_temp.got('sa1'), pg_temp.got('s_1'))), '42501|', 'a verifier cannot re-link (registry.manage is the linking permission)');
select pg_temp.as_user(pg_temp.u(2));
select is(pg_temp.err(format($$select payments.link_settlement_account(%L, %L)$$, pg_temp.got('sa1'), pg_temp.got('s_g'))), '55000|already_linked', 'an entry that is not the successor of the current link is refused');
select is(payments.link_settlement_account(pg_temp.got('sa1')::uuid, pg_temp.got('s_1')::uuid), 'verified', 'a registry manager re-links the account to the verified successor of its entry');
select pg_temp.as_owner();
select is((select registry_id from tenancy.lender_settlement_accounts where id = pg_temp.got('sa1')::uuid), pg_temp.got('s_1')::uuid, 'the link moved');
select is(pg_temp.err(format($$update tenancy.lender_settlement_accounts set registry_id = %L where id = %L$$, pg_temp.got('s_g'), pg_temp.got('sa1'))), 'P0001|', 'the guard still refuses any other move of the link (an entry that is not its successor)');
select is(pg_temp.err(format($$update tenancy.lender_settlement_accounts set registry_id = %L where id = %L$$, pg_temp.got('reg1'), pg_temp.got('sa1'))), 'P0001|', 'or a move back to the retired entry');
select pg_temp.as_system();
select is(payments.validate_collection_target(pg_temp.got('c5')::uuid) ->> 'ok', 'true', 'the configuration is valid again');
-- From here on everything is registered under key version 2.
create function pg_temp.reg2(n integer, k text, rule uuid, kind text default 'lender', org uuid default 'f9b00000-0000-4000-8000-000000000001',
  purposes text[] default array['repayment_settlement'], lname text default 'Alpha Finance Ltd (test)', eff_from date default null, eff_to date default null,
  others jsonb default '{}'::jsonb, rekeys uuid default null)
returns uuid language sql as $fn$ select pg_temp.register(n, k, rule, kind, org, purposes, 2, lname, others, rekeys, eff_from, eff_to) $fn$;
select pg_temp.as_owner();
grant execute on all functions in schema pg_temp to public;

-- ============================================================================================================================
-- 6. A14: a rejected or revoked LENDER entry releases its fingerprint; a non-lender entry never does
-- ============================================================================================================================
select pg_temp.as_user(pg_temp.u(1));
select pg_temp.keep('e10a', pg_temp.reg2(10, 'reg-key-028-0000010', pg_temp.got('rule')::uuid)::text);
select is(pg_temp.err(format($$select pg_temp.reg2(10, 'reg-key-028-0000011', %L::uuid)$$, pg_temp.got('rule'))), '23505|account_already_registered', 'a live entry occupies its fingerprint: the same account cannot be registered twice');
select is(pg_temp.err(format($$select pg_temp.reg2(10, 'reg-key-028-0000012', %L::uuid, org => %L::uuid)$$, pg_temp.got('rule'), pg_temp.ly())), '23505|account_already_registered', 'nor under a second lender');
select pg_temp.as_user(pg_temp.u(3));
select is(payments.reject_account(pg_temp.got('e10a')::uuid, 'wrong owner entered by mistake'), 'rejected', 'the entry is rejected (a mistaken registration)');
select pg_temp.as_user(pg_temp.u(1));
select pg_temp.keep('e10b', pg_temp.reg2(10, 'reg-key-028-0000013', pg_temp.got('rule')::uuid, org => pg_temp.ly(), lname => 'Beta Capital Ltd (test)')::text);
select isnt(pg_temp.got('e10b'), pg_temp.got('e10a'), 'A14: the same account can be registered again for the RIGHT owner (the rejected entry released its fingerprint)');
select is((select verification_status from payments.account_registry where id = pg_temp.got('e10a')::uuid), 'rejected', 'the rejected entry stays as history');
select is(pg_temp.err(format($$select pg_temp.reg2(10, 'reg-key-028-0000014', %L::uuid)$$, pg_temp.got('rule'))), '23505|account_already_registered', 'and the new live entry occupies the fingerprint again');
select is(payments.revoke_account(pg_temp.got('e10b')::uuid, 'registered in error, wrong owner entered'), 'revoked', 'the second entry is revoked');
select pg_temp.keep('e10c', pg_temp.reg2(10, 'reg-key-028-0000015', pg_temp.got('rule')::uuid)::text);
select isnt(pg_temp.got('e10c'), pg_temp.got('e10b'), 'and the account is registered a third time, now correctly');
select pg_temp.as_system();
select is(payments.classify_destination(pg_temp.fp(10, 2), 2, pg_temp.lx(), 'repayment_settlement') ->> 'decision', 'hold', 'classification reads the entry that COUNTS (the live one), not the rejected and revoked history');
select pg_temp.as_user(pg_temp.u(1));
select payments.revoke_account(pg_temp.got('e10c')::uuid, 'registered in error, wrong owner entered');
select pg_temp.as_system();
select is(payments.classify_destination(pg_temp.fp(10, 2), 2, pg_temp.lx(), 'repayment_settlement') ->> 'reasons', '["account_revoked"]', 'with nothing live, a released entry still reads as revoked (not as unknown)');
select pg_temp.as_user(pg_temp.u(1));
select pg_temp.keep('u11', pg_temp.reg2(11, 'reg-key-028-0000021', pg_temp.got('rule')::uuid, kind => 'udofin', org => null, purposes => array['fee_collection'], lname => 'Udofin SAMPLE Ltd (fixture)')::text);
select pg_temp.as_user(pg_temp.u(3));
select payments.reject_account(pg_temp.got('u11')::uuid, 'wrong purposes entered by mistake');
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err(format($$select pg_temp.reg2(11, 'reg-key-028-0000022', %L::uuid)$$, pg_temp.got('rule'))), '23505|account_already_registered',
  'a rejected UDOFIN entry keeps its fingerprint: the account cannot afterwards be registered as a lender''s (the guard that recognises Udofin accounts cannot be erased by a revocation)');
select is(pg_temp.err(format($$select pg_temp.reg2(11, 'reg-key-028-0000023', %L::uuid, kind => 'udofin', org => null, purposes => array['fee_collection'], lname => 'Udofin SAMPLE Ltd (fixture)')$$, pg_temp.got('rule'))), '23505|account_already_registered',
  'nor registered again as Udofin''s');
select pg_temp.as_system();
select is(payments.classify_destination(pg_temp.fp(11, 2), 2, pg_temp.lx(), 'repayment_settlement') ->> 'decision', 'refused', 'and it is refused for a lender');

-- ============================================================================================================================
-- 7. A16, M3, U37, U46, U47: one personal-data screen for the free-text columns of the stream
-- ============================================================================================================================
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err(format($$select pg_temp.reg2(20, 'reg-key-028-0000030', %L::uuid, lname => 'Alpha Finance A/c 50100123456789 IFSC HDFC0001234 Ravi Kumar')$$, pg_temp.got('rule'))), '22023|unsafe_free_text',
  'M3: a legal owner name with an account number and an IFSC code is refused');
select is(pg_temp.err(format($$select pg_temp.reg2(20, 'reg-key-028-0000031', %L::uuid, lname => 'Alpha Finance owner abcde1234f')$$, pg_temp.got('rule'))), '22023|unsafe_free_text', 'or a PAN-shaped token in lower case');
select pg_temp.keep('e20', pg_temp.reg2(20, 'reg-key-028-0000032', pg_temp.got('rule')::uuid)::text);
select pg_temp.as_user(pg_temp.u(3));
select is(pg_temp.err(format($$select payments.verify_account(%L, '50100123456789')$$, pg_temp.got('e20'))), '22023|unsafe_free_text', 'M3: an evidence reference that is an account number is refused (it would be copied to the append-only history)');
select is(pg_temp.err(format($$select payments.verify_account(%L, 'SAMPLE-EVIDENCE-028-20', 'see account 5010 0123 4567 89 for details')$$, pg_temp.got('e20'))), '22023|unsafe_free_text', 'and so is a note holding a spaced number');
select is(pg_temp.err(format($$select payments.reject_account(%L, 'the account 5010-0123-4567-89 is not theirs')$$, pg_temp.got('e20'))), '22023|unsafe_free_text', 'a rejection reason with a hyphenated number');
select is(pg_temp.err(format($$select payments.revoke_account(%L, 'closed account 50100123456789 withdrawn now')$$, pg_temp.got('e20'))), '22023|unsafe_free_text', 'a revocation reason with a number');
select is(payments.verify_account(pg_temp.got('e20')::uuid, 'SAMPLE-EVIDENCE-028-20', 'checked against the register extract'), 'verified', 'a plain label and a plain note are accepted');
select is((select count(*) from payments.account_registry_events where registry_id = pg_temp.got('e20')::uuid and (evidence_ref ~ '[0-9]{9}' or note ~ '[0-9]{9}')), 0::bigint, 'the history holds no long number');
select has_trigger('payments', 'account_registry_events', 'unsafe_text_acct', 'the history copies are screened too');
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err($$select payments.set_payment_provider('sample_text', 'Name 5010 0123 4567 89', 'payment', 'draft', null, 'unverified')$$), '22023|unsafe_free_text', 'a provider display name with a number is refused');
-- Configuration free text and rail limits.
select pg_temp.as_user(pg_temp.u(8));
select is(pg_temp.err(format($$select pg_temp.draft(%L, 'cfg-key-028-000000101', %L::uuid, %L::uuid, evidence => '50100123456789')$$, pg_temp.lx(), pg_temp.got('mx2'), pg_temp.got('sa1'))), '22023|unsafe_free_text', 'M3: a configuration evidence reference that is an account number is refused');
select is(pg_temp.err(format($$select pg_temp.draft(%L, 'cfg-key-028-000000102', %L::uuid, %L::uuid, limits => '{"upi":{"max_amount_minor":1500000}}', lsource => 'copied from account 5010 0123 4567 89 sheet')$$, pg_temp.lx(), pg_temp.got('mx2'), pg_temp.got('sa1'))),
  '22023|unsafe_free_text', 'a rail-limits source note with a number is refused');
select is(pg_temp.err(format($$select pg_temp.draft(%L, 'cfg-key-028-000000103', %L::uuid, %L::uuid, limits => '{"upi":{"note":"a/c 50100123456789"}}', lsource => 'SAMPLE provider documentation section 4')$$, pg_temp.lx(), pg_temp.got('mx2'), pg_temp.got('sa1'))),
  '22023|rail_limits_invalid', 'M3: a rail limit with an account number as a string value is refused');
select is(pg_temp.err(format($$select pg_temp.draft(%L, 'cfg-key-028-000000104', %L::uuid, %L::uuid, limits => '{"upi":{"limit":"50100123456789"}}', lsource => 'SAMPLE provider documentation section 4')$$, pg_temp.lx(), pg_temp.got('mx2'), pg_temp.got('sa1'))),
  '22023|rail_limits_invalid', 'nor a long digit string under a key that is not an amount in paise');
select is(pg_temp.err(format($$select pg_temp.draft(%L, 'cfg-key-028-000000105', %L::uuid, %L::uuid, limits => '{"upi":{"a9876543210":1}}', lsource => 'SAMPLE provider documentation section 4')$$, pg_temp.lx(), pg_temp.got('mx2'), pg_temp.got('sa1'))),
  '22023|rail_limits_invalid', 'nor a limit key that carries a phone number');
select is(pg_temp.err(format($$select pg_temp.draft(%L, 'cfg-key-028-000000106', %L::uuid, %L::uuid, limits => '{"upi":{"max_amount_minor":"500000000","needs_afa_each_debit":false,"channel":"collect"}}', lsource => 'SAMPLE provider documentation section 4')$$, pg_temp.lx(), pg_temp.got('mx2'), pg_temp.got('sa1'))),
  'ok', 'but a big amount in paise under a *_minor key, a boolean and a plain word are accepted');
select pg_temp.as_owner();
select is(pg_temp.err(format($$update payments.lender_payment_configs set status_reason = 'approved, ticket 5010 0123 4567 89' where id = %L$$, pg_temp.got('c5'))), '22023|unsafe_free_text', 'table level: a status reason with a number is refused for every writer');
-- U46: evidence keys are fixed labels.
select pg_temp.as_user(pg_temp.u(5));
select is(pg_temp.err($$select servicing.request_feature_change('f9b00000-0000-4000-8000-000000000001', 'payments', true, '{"a9876543210":"x1234"}', 'feature-key-028-0000001')$$), '22023|evidence_invalid',
  'U46: an evidence KEY shaped like a phone number is refused (it would be copied into audit metadata the lender reads)');
select is(pg_temp.err($$select servicing.request_feature_change('f9b00000-0000-4000-8000-000000000001', 'payments', true, '{"ref_2026":"x1234"}', 'feature-key-028-0000002')$$), '22023|evidence_invalid', 'a key with four digits is refused');
select is(pg_temp.err($$select servicing.request_feature_change('f9b00000-0000-4000-8000-000000000001', 'payments', true, '{"contract_ref2":"SAMPLE-MSA-1"}', 'feature-key-028-0000003')$$) <> '22023|evidence_invalid', true,
  'a label key with a digit or two passes the evidence check (the request is then judged on its prerequisites)');
-- U47: the comments no longer claim a canonical fingerprint.
select pg_temp.as_owner();
select ok(obj_description('payments.account_registry'::regclass, 'pg_class') like '%BEST EFFORT%' and obj_description('payments.account_registry'::regclass, 'pg_class') not like '%means one entry per real account%',
  'U47: the registry comment says the one-entry guarantee is best effort');
select ok(obj_description('payments.register_account(text,integer,text,text,text,uuid,boolean,text,uuid,text,text[],date,date,text,jsonb,uuid)'::regprocedure, 'pg_proc') like '%BEST EFFORT%',
  'and so does the registration function');

-- ============================================================================================================================
-- 8. M7: guards that no test covered (removal of any of them used to leave the whole suite green)
-- ============================================================================================================================
select pg_temp.as_user(pg_temp.u(1));
select payments.set_payment_provider('sample_provider2', 'SAMPLE Provider two', 'payment', 'approved', 'SAMPLE-AUTH-EVIDENCE-028B', 'likely');
select pg_temp.as_user(pg_temp.u(8));
select pg_temp.keep('c_pm', pg_temp.draft(pg_temp.lx(), 'cfg-key-028-000000201', pg_temp.got('mx2')::uuid, pg_temp.got('sa1')::uuid, provider => 'sample_provider2')::text);
select pg_temp.keep('c_ev', pg_temp.draft(pg_temp.lx(), 'cfg-key-028-000000202', pg_temp.got('mx2')::uuid, pg_temp.got('sa1')::uuid, evidence => null, contract => null)::text);
create function pg_temp.reasons(p_cfg text) returns text language sql as $fn$
  select coalesce((select string_agg(r, ',' order by r) from jsonb_array_elements_text(payments.validate_collection_target(p_cfg::uuid) -> 'reasons') r), '') $fn$;
grant execute on function pg_temp.reasons(text) to public;
select pg_temp.as_system();
select is(pg_temp.reasons(pg_temp.got('c_pm')), 'merchant_provider_mismatch', 'a merchant claimed at one provider used by a configuration at another is invalid (merchant_provider_mismatch)');
select is(pg_temp.reasons(pg_temp.got('c_ev')), 'config_evidence_missing,contract_section_missing', 'a configuration without evidence or contract section reference is invalid');
select pg_temp.as_user(pg_temp.u(9));
select is(pg_temp.msg(format($$select payments.submit_payment_config(%L)$$, pg_temp.got('c_pm'))), 'collection target invalid: merchant_provider_mismatch', 'and cannot be submitted: a merchant id would be sent to a provider it does not belong to');
select is(pg_temp.err(format($$select payments.submit_payment_config(%L)$$, pg_temp.got('c_ev'))), '55000|collection_target_invalid', 'nor can one without its evidence');
-- decide_payment_config: the submitter must still be entitled; the function itself refuses the drafter and the submitter.
select pg_temp.keep('c_d', pg_temp.pending_x('cfg-key-028-000000211')::text);
select pg_temp.as_owner();
delete from tenancy.membership_roles where membership_id = 'f9c10000-0000-4000-8000-000000000009';
select pg_temp.as_user(pg_temp.u(11));
select is(pg_temp.err(format($$select payments.decide_payment_config(%L, true, 'SAMPLE approval')$$, pg_temp.got('c_d'))), '42501|requester_not_entitled', 'an approval is refused when the submitter no longer holds payment.configure');
select pg_temp.as_owner();
insert into tenancy.membership_roles (membership_id, role_id)
  select 'f9c10000-0000-4000-8000-000000000009', r.id from tenancy.roles r where r.org_id is null and r.applies_to = 'lender' and r.key = 'payments_admin';
alter table tenancy.membership_roles disable trigger membership_roles_segregation_payments;
insert into tenancy.membership_roles (membership_id, role_id)
  select m.id, r.id from tenancy.roles r, tenancy.memberships m
   where r.org_id is null and r.applies_to = 'lender' and r.key = 'payments_approver' and m.id in ('f9c10000-0000-4000-8000-000000000008', 'f9c10000-0000-4000-8000-000000000009');
alter table tenancy.membership_roles enable trigger membership_roles_segregation_payments;
select pg_temp.as_user(pg_temp.u(8));
select is(pg_temp.err(format($$select payments.decide_payment_config(%L, true, 'SAMPLE approval')$$, pg_temp.got('c_d'))), '42501|self_approval',
  'the function itself refuses the DRAFTER even when a login has been given both halves (the trigger that normally prevents it was lifted for this test)');
select pg_temp.as_user(pg_temp.u(9));
select is(pg_temp.err(format($$select payments.decide_payment_config(%L, true, 'SAMPLE approval')$$, pg_temp.got('c_d'))), '42501|self_approval', 'and the SUBMITTER');
select pg_temp.as_owner();
delete from tenancy.membership_roles mr using tenancy.roles r
 where mr.role_id = r.id and r.key = 'payments_approver' and mr.membership_id in ('f9c10000-0000-4000-8000-000000000008', 'f9c10000-0000-4000-8000-000000000009');
select pg_temp.as_user(pg_temp.u(8));
select payments.withdraw_payment_config(pg_temp.got('c_d')::uuid, 'withdrawn after the guard tests were run');
-- approve_account_format_rule: the proposer must still hold registry.manage.
select pg_temp.as_user(pg_temp.u(2));
select pg_temp.keep('rule_p', payments.draft_account_format_rule('IN', 'sample_proposer', 9, 18, true, 'unverified', 'SAMPLE rule for the proposer test')::text);
select pg_temp.as_owner();
delete from tenancy.membership_roles where membership_id = 'f9c10000-0000-4000-8000-000000000002';
select pg_temp.as_user(pg_temp.u(3));
select is(pg_temp.err(format($$select payments.approve_account_format_rule(%L)$$, pg_temp.got('rule_p'))), '42501|requester_not_entitled', 'a rule whose proposer no longer holds registry.manage cannot be approved');
select pg_temp.as_owner();
insert into tenancy.membership_roles (membership_id, role_id)
  select 'f9c10000-0000-4000-8000-000000000002', r.id from tenancy.roles r where r.org_id is null and r.applies_to = 'platform' and r.key = 'platform_payments_admin';
-- guard_settlement_account: the proof is demanded of every writer, the system role included.
select pg_temp.as_user(pg_temp.u(1));
select pg_temp.keep('e30', pg_temp.reg2(30, 'reg-key-028-0000040', pg_temp.got('rule')::uuid)::text);
select pg_temp.keep('e31', pg_temp.reg2(31, 'reg-key-028-0000041', pg_temp.got('rule')::uuid, purposes => array['operational'])::text);
select pg_temp.keep('e32', pg_temp.reg2(32, 'reg-key-028-0000042', pg_temp.got('rule')::uuid)::text);
select pg_temp.as_user(pg_temp.u(3));
select payments.verify_account(pg_temp.got('e31')::uuid, 'SAMPLE-EVIDENCE-028-31');
select payments.verify_account(pg_temp.got('e32')::uuid, 'SAMPLE-EVIDENCE-028-32');
select pg_temp.as_system();
select is(pg_temp.err(format($$insert into tenancy.lender_settlement_accounts (lender_org_id, label, bank_name, masked_account_ref, status, registry_id, verified_by, verified_at)
  values (%L, 'SAMPLE forged 1', 'Test Bank', %L, 'verified', %L, %L, now())$$, pg_temp.lx(), pg_temp.mask(30), pg_temp.got('e30'), pg_temp.u(3))), '55000|settlement_account_unproven',
  'the system role cannot insert a VERIFIED account that points at an UNVERIFIED registry entry');
select is(pg_temp.err(format($$insert into tenancy.lender_settlement_accounts (lender_org_id, label, bank_name, masked_account_ref, status, registry_id, verified_by, verified_at)
  values (%L, 'SAMPLE forged 2', 'Test Bank', %L, 'verified', %L, %L, now())$$, pg_temp.lx(), pg_temp.mask(31), pg_temp.got('e31'), pg_temp.u(3))), '55000|settlement_account_unproven',
  'nor one that points at a verified entry NOT permitted for repayment settlement');
select is(pg_temp.err(format($$insert into tenancy.lender_settlement_accounts (lender_org_id, label, bank_name, masked_account_ref, status, registry_id, verified_by, verified_at)
  values (%L, 'SAMPLE forged 3', 'Test Bank', 'XXXXXX7777', 'verified', %L, %L, now())$$, pg_temp.lx(), pg_temp.got('e32'), pg_temp.u(3))), '55000|masked_ref_mismatch',
  'nor a masked reference that differs from the entry''s');
-- verify_account past effective_to; register_account refusing p_rekeys under the active key.
select pg_temp.as_user(pg_temp.u(1));
select pg_temp.keep('e33', pg_temp.reg2(33, 'reg-key-028-0000043', pg_temp.got('rule')::uuid, eff_from => private.today_ist() - 10, eff_to => private.today_ist() - 1)::text);
select pg_temp.as_user(pg_temp.u(3));
select is(pg_temp.err(format($$select payments.verify_account(%L, 'SAMPLE-EVIDENCE-028-33')$$, pg_temp.got('e33'))), '55000|not_effective', 'an entry past its effective_to cannot be verified');
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err(format($$select pg_temp.reg2(34, 'reg-key-028-0000044', %L::uuid, rekeys => %L::uuid)$$, pg_temp.got('rule'), pg_temp.got('e30'))), '22023|rekey_invalid', 're-keying targets the proposed key version: a re-key under the ACTIVE key is refused');

-- ============================================================================================================================
-- 9. U41: lenders read the provider vocabulary only
-- ============================================================================================================================
select pg_temp.as_user(pg_temp.u(1));
select payments.set_payment_provider('sample_provider2', 'SAMPLE Provider two', 'payment', 'suspended', 'SAMPLE-AUTH-EVIDENCE-028B', 'likely', 'suspended after the settlement incident; lender X affected');
select pg_temp.as_user(pg_temp.u(14));
select ok((select count(*) >= 2 from payments.provider_register), 'a lender viewer (the lowest role) still reads the vocabulary of the providers');
select is(pg_temp.err($$select provider, display_name, kind, status from payments.provider_register$$), 'ok', 'provider, display_name, kind and status');
select is(pg_temp.err($$select status_reason from payments.provider_register$$), '42501|', 'but not the status reason (platform commentary about a lender''s incident)');
select is(pg_temp.err($$select authorisation_evidence_ref from payments.provider_register$$), '42501|', 'nor the authorisation evidence reference');
select is(pg_temp.err($$select updated_by from payments.provider_register$$), '42501|', 'nor who changed it');
select is(pg_temp.err($$select * from payments.provider_register$$), '42501|', 'and a select * is refused');
select is((select count(*) from payments.provider_register_platform), 0::bigint, 'the platform view returns no row to a lender user');
select pg_temp.as_user(pg_temp.u(3));
select is((select count(*) from payments.provider_register_platform), 0::bigint, 'nor to a registry verifier (providers.manage is needed)');
select pg_temp.as_user(pg_temp.u(1));
select is((select status_reason from payments.provider_register_platform where provider = 'sample_provider2'), 'suspended after the settlement incident; lender X affected', 'a user with providers.manage reads the whole register through the view');
select ok((select authorisation_evidence_ref is not null from payments.provider_register_platform where provider = 'sample_provider2'), 'including the authorisation evidence reference');
select pg_temp.as_anon();
select is(pg_temp.err($$select count(*) from payments.provider_register_platform$$), '42501|', 'anon is refused the view');
select pg_temp.as_system();
select is(pg_temp.err($$select count(*) from payments.provider_register_platform$$), '42501|', 'and so is the system role');
select is(has_column_privilege('service_role', 'payments.provider_register', 'status_reason', 'select'), true, 'while the system role still reads the register table itself (the worker needs the vocabulary)');

-- ============================================================================================================================
-- 10. U51: the secret names of a configuration live in the lender's own namespace
-- ============================================================================================================================
select pg_temp.as_user(pg_temp.u(8));
select is(payments.secret_ref_prefix(pg_temp.lx()), 'L000000000001_', 'the lender''s payment users can read their namespace prefix');
select pg_temp.as_user(pg_temp.u(1));
select is(payments.secret_ref_prefix(pg_temp.ly()), 'L000000000002_', 'and the platform can');
select pg_temp.as_user(pg_temp.u(12));
select is(pg_temp.err(format($$select payments.secret_ref_prefix(%L)$$, pg_temp.lx())), '42501|', 'another lender cannot');
select pg_temp.as_anon();
select is(pg_temp.err(format($$select payments.secret_ref_prefix(%L)$$, pg_temp.lx())), '42501|', 'anon cannot');
select pg_temp.as_user(pg_temp.u(8));
select is(pg_temp.err(format($$select pg_temp.draft(%L, 'cfg-key-028-000000301', %L::uuid, %L::uuid, secret => 'SYSTEM_DATABASE_URL', hook => 'L000000000001_SAMPLE_WEBHOOK')$$, pg_temp.lx(), pg_temp.got('mx2'), pg_temp.got('sa1'))), '22023|secret_ref_invalid',
  'a lender cannot name a PLATFORM secret as its provider credential');
select is(pg_temp.err(format($$select pg_temp.draft(%L, 'cfg-key-028-000000302', %L::uuid, %L::uuid, secret => 'L000000000002_PROVIDER_KEY', hook => 'L000000000001_SAMPLE_WEBHOOK')$$, pg_temp.lx(), pg_temp.got('mx2'), pg_temp.got('sa1'))), '22023|secret_ref_invalid',
  'nor another lender''s secret');
select is(pg_temp.err(format($$select pg_temp.draft(%L, 'cfg-key-028-000000303', %L::uuid, %L::uuid, hook => 'SYSTEM_DATABASE_URL')$$, pg_temp.lx(), pg_temp.got('mx2'), pg_temp.got('sa1'))), '22023|secret_ref_invalid', 'nor name a platform secret as the webhook secret');
select is(pg_temp.err(format($$select pg_temp.draft(%L, 'cfg-key-028-000000304', %L::uuid, %L::uuid, secret => 'L000000000001_', hook => 'L000000000001_SAMPLE_WEBHOOK')$$, pg_temp.lx(), pg_temp.got('mx2'), pg_temp.got('sa1'))), '22023|secret_ref_invalid', 'the prefix alone is not a name');
select is(pg_temp.err(format($$select pg_temp.draft(%L, 'cfg-key-028-000000305', %L::uuid, %L::uuid, secret => 'L000000000001_SAME', hook => 'L000000000001_SAME')$$, pg_temp.lx(), pg_temp.got('mx2'), pg_temp.got('sa1'))), '22023|secret_ref_invalid', 'the two names must still differ');
select pg_temp.keep('c_ns', pg_temp.draft(pg_temp.lx(), 'cfg-key-028-000000306', pg_temp.got('mx2')::uuid, pg_temp.got('sa1')::uuid)::text);
select pg_temp.as_owner();
select is((select (secret_namespace, secret_ref, webhook_secret_ref)::text from payments.lender_payment_configs where id = pg_temp.got('c_ns')::uuid), '(L000000000001_,L000000000001_SAMPLE_SECRET,L000000000001_SAMPLE_WEBHOOK)',
  'inside the namespace the draft is accepted and the namespace is stored on the configuration, for the resolvers to check');
select is(pg_temp.err(format($$insert into payments.lender_payment_configs (lender_org_id, provider, provider_mode, merchant_registry_id, settlement_account_id, secret_ref, webhook_secret_ref, secret_namespace,
    endpoint_token_hash, evidence_ref, contract_section_ref, idempotency_key, drafted_by)
  values (%L, 'sample_provider', 'production', %L, %L, 'OTHER_SECRET_NAME', 'L000000000001_SAMPLE_WEBHOOK', 'L000000000001_', %L, 'SAMPLE-EVIDENCE-CFG', 'SAMPLE-CONTRACT-CFG', 'direct-key-028-00000001', %L)$$,
  pg_temp.lx(), pg_temp.got('mx2'), pg_temp.got('sa1'), pg_temp.token('direct-1'), pg_temp.u(8))), '23514|', 'table level: a configuration that records a namespace cannot carry a name outside it (check)');
select ok(col_description('payments.lender_payment_configs'::regclass, (select attnum from pg_attribute where attrelid = 'payments.lender_payment_configs'::regclass and attname = 'secret_namespace')) like '%RESOLVERS%must read a secret only when%',
  'the column comment states what the resolvers must check');

-- ============================================================================================================================
-- 11. U55: the separation-of-duties triggers serialise per login
-- ============================================================================================================================
select pg_temp.as_owner();
select is(pg_temp.holds_advisory('sod:' || pg_temp.u(23)::text), false, 'before any grant the transaction holds no lock for login 23');
insert into tenancy.memberships (id, org_id, user_id, status) values ('f9c10000-0000-4000-8000-000000000023', pg_temp.lx(), pg_temp.u(23), 'active');
select is(pg_temp.holds_advisory('sod:' || pg_temp.u(23)::text), true, 'a membership of the login takes its separation-of-duties lock');
insert into tenancy.roles (id, org_id, applies_to, key, name, description) values ('f9d00000-0000-4000-8000-000000000001', pg_temp.lx(), 'lender', 'custom_locking_role', 'Custom role', 'A role to test locking');
insert into tenancy.memberships (id, org_id, user_id, status) values ('f9c10000-0000-4000-8000-000000000024', pg_temp.lx(), pg_temp.u(24), 'active');
insert into tenancy.membership_roles (membership_id, role_id) values ('f9c10000-0000-4000-8000-000000000024', 'f9d00000-0000-4000-8000-000000000001');
select is(pg_temp.holds_advisory('sod:' || pg_temp.u(24)::text), true, 'a role grant takes the lock of the login that receives it');
select is(pg_temp.holds_advisory('sod:' || pg_temp.u(25)::text), false, 'and only that login''s');
insert into tenancy.role_permissions (role_id, permission_key) values ('f9d00000-0000-4000-8000-000000000001', 'payment.read');
select is(pg_temp.holds_advisory('sod:' || pg_temp.u(24)::text), true, 'a permission added to a role locks every login that holds the role');
select is(pg_temp.err($$insert into tenancy.role_permissions (role_id, permission_key) values ('f9d00000-0000-4000-8000-000000000001', 'payment.configure')$$), 'ok', 'the pair rule itself is unchanged: one half is fine ...');
select is(pg_temp.err($$insert into tenancy.role_permissions (role_id, permission_key) values ('f9d00000-0000-4000-8000-000000000001', 'payment.config.approve')$$), '23514|segregation_of_duties', '... both halves in one role are refused');

-- ============================================================================================================================
-- 12. U53: the system role cannot lift tenancy change control by setting a session setting
-- ============================================================================================================================
select pg_temp.as_system();
select set_config('udofin.change_apply', 'on', true);
select is(pg_temp.err($$insert into tenancy.membership_roles (membership_id, role_id)
  select 'f9c10000-0000-4000-8000-000000000023', r.id from tenancy.roles r where r.org_id is null and r.applies_to = 'lender' and r.key = 'payments_admin'$$), '42501|Use private.request_change and an independent approver.',
  'the system role cannot grant a role by setting udofin.change_apply (before the fix the grant succeeded and so could a grant of payments_approver to a colluding login)');
select is(pg_temp.err($$insert into tenancy.memberships (org_id, user_id, status) values ('f9b00000-0000-4000-8000-000000000002', 'f9000000-0000-4000-8000-000000000023', 'active')$$), '42501|Use private.request_change and an independent approver.',
  'nor create a membership');
select is(pg_temp.err($$update tenancy.organizations set status = 'suspended' where id = 'f9b00000-0000-4000-8000-000000000002'$$), '42501|', 'nor change the status of an organisation');
select is(pg_temp.err($$update tenancy.memberships set status = 'revoked' where id = 'f9c10000-0000-4000-8000-000000000023'$$), '42501|', 'nor of a membership');
select pg_temp.as_owner();
select is(pg_temp.err($$insert into tenancy.memberships (org_id, user_id, status) values ('f9b00000-0000-4000-8000-000000000002', 'f9000000-0000-4000-8000-000000000023', 'active')$$), 'ok', 'the database owner (a named human working as break glass) is unaffected');
select set_config('udofin.change_apply', 'off', true);

-- ============================================================================================================================
-- 13. A42, U48: the whole activation order through public functions only, with two platform people.
--     connection -> servicing_sync -> statements_noc -> reminders -> payments -> mandates   (no owner-level insert of any kind)
-- ============================================================================================================================
-- Without a connection the request is refused (lender Y: active, gate activated, no connection yet).
select pg_temp.as_user(pg_temp.u(5));
select is(pg_temp.err($$select servicing.request_feature_change('f9b00000-0000-4000-8000-000000000002', 'servicing_sync', true, '{"contract_ref":"SAMPLE-MSA-Y"}', 'feature-key-028-0000010')$$), '55000|prerequisites_unmet',
  'without an active connection the servicing_sync request is refused ...');
select is(pg_temp.msg($$select servicing.request_feature_change('f9b00000-0000-4000-8000-000000000002', 'servicing_sync', true, '{"contract_ref":"SAMPLE-MSA-Y"}', 'feature-key-028-0000010')$$), 'prerequisites not met: lms_connection_not_active', '... and says why');
-- The connection row can be recorded before the switch is on, by the lender, for file_import / manual only.
select pg_temp.as_user(pg_temp.u(22));
select is(pg_temp.err($$select servicing.set_lms_connection('f9b00000-0000-4000-8000-000000000003', 'file_import', 'active')$$), '55000|feature_disabled', 'a lender whose onboarding gate is not activated cannot record a connection');
select pg_temp.as_user(pg_temp.u(19));
select is(pg_temp.err($$select servicing.set_lms_connection('f9b00000-0000-4000-8000-000000000004', 'mock', 'draft')$$), '55000|feature_disabled', 'a mock connection still needs the switch');
select is(pg_temp.err($$select servicing.set_lms_connection('f9b00000-0000-4000-8000-000000000004', 'finbyx', 'blocked_unverified')$$), '55000|feature_disabled', 'so does a recorded REST connector');
select is(pg_temp.err($$select servicing.set_lms_connection('f9b00000-0000-4000-8000-000000000004', 'generic_rest', 'active')$$), '55000|feature_disabled', 'and an unverified connector cannot be made active');
select is(pg_temp.err($$select servicing.stage_import('f9b00000-0000-4000-8000-000000000004', 'loan', 'file', repeat('3', 64), 100, 'udofin-lms-import-v1', '[{}]', 'idem-028-0000001')$$), '55000|feature_disabled',
  'stage_import is still behind the switch');
select is(pg_temp.err($$select servicing.set_lms_connection(null, 'file_import', 'active')$$), '42501|', 'a missing lender is refused');
select pg_temp.as_user(pg_temp.u(15));
select is(pg_temp.err($$select servicing.set_lms_connection('f9b00000-0000-4000-8000-000000000004', 'file_import', 'active')$$), '42501|', 'another lender''s operator cannot record lender W''s connection');
select pg_temp.as_user(pg_temp.u(19), 'aal1');
select is(pg_temp.err($$select servicing.set_lms_connection('f9b00000-0000-4000-8000-000000000004', 'file_import', 'active')$$), '42501|mfa_required', 'recording it needs a second factor');
select pg_temp.as_user(pg_temp.u(20));
select is(pg_temp.err($$select servicing.set_lms_connection('f9b00000-0000-4000-8000-000000000004', 'file_import', 'active')$$), '42501|', 'and servicing.sync.manage (a communications administrator has none)');
select pg_temp.as_user(pg_temp.u(19));
select is(pg_temp.err($$select servicing.set_lms_connection('f9b00000-0000-4000-8000-000000000004', 'file_import', 'active')$$), 'ok', 'THE FIX: the lender''s servicing operator records the active file_import connection BEFORE the switch is on');
select pg_temp.as_owner();
select is((select (kind, status, provider_mode::text)::text from servicing.lms_connections where lender_org_id = pg_temp.lw()), '(file_import,active,production)', 'the connection is active in production mode');
select is((select count(*) from audit.events where action = 'servicing.connection.set' and tenant_org_id = pg_temp.lw()), 1::bigint, 'and the recording is audited');
-- servicing_sync: two platform people.
select pg_temp.as_user(pg_temp.u(5));
select pg_temp.keep('rq_sync', servicing.request_feature_change(pg_temp.lw(), 'servicing_sync', true, '{"contract_ref":"SAMPLE-MSA-W"}', 'feature-key-028-0000020')::text);
select pg_temp.as_user(pg_temp.u(6));
select is(servicing.decide_feature_change(pg_temp.got('rq_sync')::uuid, true, 'connection recorded, evidence reviewed'), 'applied', 'a different platform person turns servicing_sync on');
select pg_temp.as_owner();
select is(private.feature_enabled(pg_temp.lw(), 'servicing_sync'), true, 'servicing_sync is enabled for lender W');
-- The switch is on now: writes work, and the whole connection changes behave as before.
select pg_temp.as_user(pg_temp.u(19));
select is(pg_temp.err($$select servicing.set_lms_connection('f9b00000-0000-4000-8000-000000000004', 'file_import', 'paused')$$), 'ok', 'with the switch on the connection can be changed as before');
select is(pg_temp.err($$select servicing.set_lms_connection('f9b00000-0000-4000-8000-000000000004', 'file_import', 'active')$$), 'ok', 'and made active again');
-- statements_noc.
select pg_temp.as_user(pg_temp.u(5));
select pg_temp.keep('rq_noc', servicing.request_feature_change(pg_temp.lw(), 'statements_noc', true, '{"contract_ref":"SAMPLE-MSA-W"}', 'feature-key-028-0000021')::text);
select pg_temp.as_user(pg_temp.u(6));
select is(servicing.decide_feature_change(pg_temp.got('rq_noc')::uuid, true, 'statements and no-dues letters reviewed'), 'applied', 'statements_noc is turned on');
-- reminders: policy and wording by the lender's communications pair.
select pg_temp.as_user(pg_temp.u(5));
select is(pg_temp.msg($$select servicing.request_feature_change('f9b00000-0000-4000-8000-000000000004', 'reminders', true, '{"contract_ref":"SAMPLE-MSA-W"}', 'feature-key-028-0000022')$$),
  'prerequisites not met: reminder_policy_missing, reminder_templates_missing', 'reminders are refused until a policy and the wording are approved');
select pg_temp.as_user(pg_temp.u(20));
select pg_temp.keep('pol', servicing.draft_reminder_policy(pg_temp.lw(), array[-1, 0, 3], true, array['in_app', 'push'], time '09:00', time '18:00', 2)::text);
select pg_temp.keep('t_pre', servicing.draft_reminder_template(pg_temp.lw(), 'pre_due', 'en', 'Reminder from {{lender_name}}: your installment of {{amount}} is due on {{due_date}}.')::text);
select pg_temp.keep('t_due', servicing.draft_reminder_template(pg_temp.lw(), 'due_day', 'en', 'Reminder from {{lender_name}}: your installment of {{amount}} is due today, {{due_date}}.')::text);
select pg_temp.keep('t_over', servicing.draft_reminder_template(pg_temp.lw(), 'overdue', 'en', '{{lender_name}} reminder: {{amount}} is overdue since {{due_date}}. {{penal_text}}')::text);
select pg_temp.as_user(pg_temp.u(21));
select servicing.approve_reminder_policy(pg_temp.got('pol')::uuid);
select servicing.approve_reminder_template(pg_temp.got('t_pre')::uuid);
select servicing.approve_reminder_template(pg_temp.got('t_due')::uuid);
select servicing.approve_reminder_template(pg_temp.got('t_over')::uuid);
select pg_temp.as_user(pg_temp.u(5));
select pg_temp.keep('rq_rem', servicing.request_feature_change(pg_temp.lw(), 'reminders', true, '{"contract_ref":"SAMPLE-MSA-W"}', 'feature-key-028-0000023')::text);
select pg_temp.as_user(pg_temp.u(6));
select is(servicing.decide_feature_change(pg_temp.got('rq_rem')::uuid, true, 'wording and policy reviewed'), 'applied', 'reminders are turned on');
-- payments: the registry chain for lender W through the real functions.
select pg_temp.as_user(pg_temp.u(5));
select is(pg_temp.msg($$select servicing.request_feature_change('f9b00000-0000-4000-8000-000000000004', 'payments', true, '{"contract_ref":"SAMPLE-MSA-W"}', 'feature-key-028-0000024')$$),
  'prerequisites not met: payment_config_missing', 'payments are refused until a configuration is active (the own-account list is attested)');
select pg_temp.as_user(pg_temp.u(1));
select pg_temp.keep('rw', pg_temp.reg2(40, 'reg-key-028-0000050', pg_temp.got('rule')::uuid, org => pg_temp.lw(), lname => 'Delta Lending Ltd (test)')::text);
select pg_temp.as_user(pg_temp.u(3));
select payments.verify_account(pg_temp.got('rw')::uuid, 'SAMPLE-EVIDENCE-028-W');
select pg_temp.as_user(pg_temp.u(16));
select pg_temp.keep('saw', payments.request_settlement_account(pg_temp.lw(), 'SAMPLE collections W', 'Sample Bank', pg_temp.mask(40))::text);
select pg_temp.keep('mw', payments.claim_merchant(pg_temp.lw(), 'sample_provider', 'SAMPLE-MERCH-W1')::text);
select pg_temp.as_user(pg_temp.u(2));
select payments.link_settlement_account(pg_temp.got('saw')::uuid, pg_temp.got('rw')::uuid);
select payments.verify_merchant(pg_temp.got('mw')::uuid, 'SAMPLE-MERCH-EVID-W');
select pg_temp.as_user(pg_temp.u(16));
select pg_temp.keep('cw', pg_temp.draft(pg_temp.lw(), 'cfg-key-028-000000401', pg_temp.got('mw')::uuid, pg_temp.got('saw')::uuid,
  limits => '{"enach_api":{"max_mandate_amount_minor":5000000,"needs_afa_each_debit":false}}', lsource => 'SAMPLE provider documentation section 4')::text);
select is(pg_temp.live(pg_temp.got('cw')::uuid, 17, 18), 'active', 'the lender''s pair activates a production configuration (mandate rails included)');
select pg_temp.as_user(pg_temp.u(5));
select pg_temp.keep('rq_pay', servicing.request_feature_change(pg_temp.lw(), 'payments', true, '{"contract_ref":"SAMPLE-MSA-W"}', 'feature-key-028-0000025')::text);
select pg_temp.as_user(pg_temp.u(6));
select is(servicing.decide_feature_change(pg_temp.got('rq_pay')::uuid, true, 'configuration and registry reviewed'), 'applied', 'payments are turned on');
-- mandates.
select pg_temp.as_user(pg_temp.u(5));
select is(pg_temp.msg($$select servicing.request_feature_change('f9b00000-0000-4000-8000-000000000004', 'mandates', true, '{"contract_ref":"SAMPLE-MSA-W"}', 'feature-key-028-0000026')$$),
  'prerequisites not met: mandate_policy_missing', 'mandates are refused until the lender sets its mandate settings');
select pg_temp.as_user(pg_temp.u(16));
select is(payments.set_mandate_policy(pg_temp.lw(), 'before_first_due', 4000000, 48), 'set', 'the lender sets its mandate settings');
select pg_temp.as_user(pg_temp.u(5));
select pg_temp.keep('rq_man', servicing.request_feature_change(pg_temp.lw(), 'mandates', true, '{"contract_ref":"SAMPLE-MSA-W"}', 'feature-key-028-0000027')::text);
select pg_temp.as_user(pg_temp.u(6));
select is(servicing.decide_feature_change(pg_temp.got('rq_man')::uuid, true, 'mandate settings and rails reviewed'), 'applied', 'mandates are turned on');
select pg_temp.as_owner();
select is((select array_agg(feature order by feature) from servicing.lender_features where lender_org_id = pg_temp.lw() and enabled), array['mandates', 'payments', 'reminders', 'servicing_sync', 'statements_noc'],
  'all five Phase 08a features are on for the lender, reached with public functions and two platform people only');
select is((select count(distinct decided_by) from servicing.feature_change_requests where lender_org_id = pg_temp.lw() and status = 'applied'), 1::bigint, 'every switch was decided by the second platform person');
select is((select count(*) from servicing.feature_change_requests where lender_org_id = pg_temp.lw() and status = 'applied' and decided_by = requested_by), 0::bigint, 'and never by the person who asked');

select * from finish();
rollback;
