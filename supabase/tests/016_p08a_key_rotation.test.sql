-- Phase 08a fingerprint key versions and rotation (migration 20261018000910, review finding FC-1): the registry keeps its
-- one-entry-per-real-account guarantee across a key rotation. A fingerprint is a keyed hash, so the same account has a different
-- fingerprint under every key; a rotation therefore needs every live entry re-registered under the new key (rekeyed_from_id)
-- before the new key can become active, and the old key is retired in the same step. Synthetic data only (labelled SAMPLE).
-- Error codes are reported as SQLSTATE|hint.
begin;
create extension if not exists pgtap with schema extensions;
select plan(58);

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
create function pg_temp.u(n integer) returns uuid language sql as $fn$ select ('f7000000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid $fn$;
-- The fingerprint of "real account n" under key version kv (a stand-in for the backend's keyed HMAC: different key, different value).
create function pg_temp.fp(n integer, kv integer) returns text language sql as $fn$ select encode(sha256(convert_to('SAMPLE-ROT-ACCOUNT-' || n || '-KEY-' || kv, 'UTF8')), 'hex') $fn$;
-- Registers real account n under key version kv; others = the same account under the other live versions.
create function pg_temp.reg(n integer, k text, kv integer, rule uuid, kind text default 'lender', org uuid default 'f7b00000-0000-4000-8000-000000000001',
  purposes text[] default array['repayment_settlement'], others jsonb default '{}'::jsonb, rekeys uuid default null) returns uuid language sql as $fn$
  select payments.register_account(pg_temp.fp(n, kv), kv, 'XXXXXX' || lpad(n::text, 4, '0'), 'IN', 'bank_account', rule, true, kind, org, 'SAMPLE Entity Ltd (fixture)',
                                   purposes, null, null, k, others, rekeys)
$fn$;
create function pg_temp.cls(n integer, kv integer, lender integer default 1, purpose text default 'repayment_settlement') returns text language sql as $fn$
  select (payments.classify_destination(pg_temp.fp(n, kv), kv, ('f7b00000-0000-4000-8000-00000000000' || lender)::uuid, purpose) ->> 'decision') || ':' ||
         coalesce((select string_agg(r, ',' order by r) from jsonb_array_elements_text(payments.classify_destination(pg_temp.fp(n, kv), kv, ('f7b00000-0000-4000-8000-00000000000' || lender)::uuid, purpose) -> 'reasons') r), '')
$fn$;
grant execute on all functions in schema pg_temp to public;

-- Fixture: users 1 and 2 registry managers, 3 and 4 registry verifiers (platform); lenders X and Y.
insert into auth.users (id, raw_app_meta_data) select pg_temp.u(n), '{"actor_type":"staff"}'::jsonb from generate_series(1, 6) n;
insert into tenancy.organizations (id, kind, legal_name, display_name, regulator_registration_no, status) values
  ('f7a00000-0000-4000-8000-000000000000', 'platform', 'Udofin Platform (test)', 'Udofin', null, 'active'),
  ('f7b00000-0000-4000-8000-000000000001', 'lender', 'Alpha Finance Ltd (test)', 'Alpha', 'TEST-F7-0001', 'active'),
  ('f7b00000-0000-4000-8000-000000000002', 'lender', 'Beta Capital Ltd (test)', 'Beta', 'TEST-F7-0002', 'active');
insert into tenancy.memberships (id, org_id, user_id, status)
select ('f7c10000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, 'f7a00000-0000-4000-8000-000000000000', pg_temp.u(n), 'active' from generate_series(1, 5) n;
insert into tenancy.membership_roles (membership_id, role_id)
select ('f7c10000-0000-4000-8000-0000000000' || lpad(g.n::text, 2, '0'))::uuid, r.id
from (values (1, 'platform_payments_admin'), (2, 'platform_payments_admin'), (3, 'platform_account_verifier'), (4, 'platform_account_verifier')) as g (n, rkey)
join tenancy.roles r on r.org_id is null and r.applies_to = 'platform' and r.key = g.rkey;
-- An approved format rule, written directly (fixtures only): the rule workflow is tested in 016_p08a_accounts_config.
insert into payments.account_format_rules (country, account_type, version, min_digits, max_digits, ifsc_required, status, evidence_label, source_note, effective_from,
                                           drafted_by, submitted_by, submitted_at, approved_by, approved_at)
  values ('IN', 'bank_account', 2, 9, 18, true, 'approved', 'unverified', 'SAMPLE fixture rule, not a real source', date '2026-01-01',
          pg_temp.u(1), pg_temp.u(1), now(), pg_temp.u(3), now());
select pg_temp.keep('rule', (select id::text from payments.account_format_rules where version = 2));

-- ---------------------------------------------------------------------------------------------------------------------------
-- 1. Closed until the first version is approved
-- ---------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err(format($$select pg_temp.reg(1, 'rot-key-000000001', 1, %L::uuid)$$, pg_temp.got('rule'))), '55000|key_version_not_allowed', 'with no key version in the register nothing can be registered');
select is(payments.propose_fingerprint_key_version(1, 'SAMPLE first key'), 1, 'version 1 is proposed');
select pg_temp.as_user(pg_temp.u(3));
select is(payments.approve_fingerprint_key_version(1), 'active', 'and approved by a different login: nothing to cover on the first version');
select is((select count(*) from payments.fingerprint_key_versions where status = 'active'), 1::bigint, 'exactly one version is active');

-- ---------------------------------------------------------------------------------------------------------------------------
-- 2. Entries under version 1: an Udofin fee account, two lender accounts (one verified), a revoked one and a rejected one
-- ---------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user(pg_temp.u(1));
select pg_temp.keep('rA', pg_temp.reg(1, 'rot-key-000000010', 1, pg_temp.got('rule')::uuid, kind => 'udofin', org => null, purposes => array['fee_collection'])::text);
select pg_temp.keep('rB', pg_temp.reg(2, 'rot-key-000000011', 1, pg_temp.got('rule')::uuid)::text);
select pg_temp.keep('rC', pg_temp.reg(3, 'rot-key-000000012', 1, pg_temp.got('rule')::uuid)::text);
select pg_temp.keep('rD', pg_temp.reg(4, 'rot-key-000000013', 1, pg_temp.got('rule')::uuid)::text);
select pg_temp.keep('rE', pg_temp.reg(5, 'rot-key-000000014', 1, pg_temp.got('rule')::uuid)::text);
select pg_temp.as_user(pg_temp.u(3));
select payments.verify_account(pg_temp.got('rA')::uuid, 'SAMPLE-ROT-EVIDENCE-A');
select payments.verify_account(pg_temp.got('rB')::uuid, 'SAMPLE-ROT-EVIDENCE-B');
select payments.verify_account(pg_temp.got('rD')::uuid, 'SAMPLE-ROT-EVIDENCE-D');
select payments.revoke_account(pg_temp.got('rD')::uuid, 'ownership changed, entry withdrawn for good');
select payments.reject_account(pg_temp.got('rE')::uuid, 'the owner could not be established');
select is((select string_agg(verification_status, ',' order by id) from payments.account_registry where key_version = 1), 'verified,verified,unverified,revoked,rejected', 'five entries under version 1: verified, verified, unverified, revoked, rejected');
select pg_temp.as_system();
select is(pg_temp.cls(2, 1), 'permitted:', 'the verified lender entry is permitted under the active key');
select is(pg_temp.cls(3, 1), 'hold:account_unverified', 'the unverified one is held');

-- ---------------------------------------------------------------------------------------------------------------------------
-- 3. Proposing version 2 and the evasion attempts while it is only proposed
-- ---------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err($$select payments.propose_fingerprint_key_version(3)$$), '22023|key_version_invalid', 'versions follow on one by one (3 cannot follow 1)');
select is(payments.propose_fingerprint_key_version(2, 'SAMPLE rotation'), 2, 'version 2 is proposed');
-- Registering the fee account A under the proposed key as a LENDER account (the evasion): refused, a proposed key takes only a re-key.
select is(pg_temp.err(format($$select pg_temp.reg(1, 'rot-key-000000020', 2, %L::uuid, others => jsonb_build_object('1', pg_temp.fp(1, 1)))$$, pg_temp.got('rule'))), '55000|key_version_not_active',
  'EVASION 1: the Udofin account cannot be registered as a lender account under the proposed key');
-- Under the active key the same real account is already registered, whoever the new owner would be.
select is(pg_temp.err(format($$select pg_temp.reg(1, 'rot-key-000000021', 1, %L::uuid, others => jsonb_build_object('2', pg_temp.fp(1, 2)))$$, pg_temp.got('rule'))), '23505|account_already_registered',
  'EVASION 2: nor under the active key (same fingerprint and key)');
select is(pg_temp.err(format($$select pg_temp.reg(6, 'rot-key-000000022', 1, %L::uuid)$$, pg_temp.got('rule'))), '22023|other_fingerprints_incomplete',
  'a registration must carry the account''s fingerprint under every other live key, or it could slip through under the other key');
select is(pg_temp.err(format($$select pg_temp.reg(6, 'rot-key-000000023', 1, %L::uuid, others => '{"2":"abc"}'::jsonb)$$, pg_temp.got('rule'))), '22023|other_fingerprints_incomplete', 'a malformed fingerprint does not count');
select is(pg_temp.err(format($$select pg_temp.reg(6, 'rot-key-000000024', 1, %L::uuid, others => jsonb_build_object('2', pg_temp.fp(6, 2), '3', pg_temp.fp(6, 3)))$$, pg_temp.got('rule'))), '22023|other_fingerprints_invalid',
  'a version that is not live is refused');
select is(pg_temp.err(format($$select pg_temp.reg(6, 'rot-key-000000025', 1, %L::uuid, others => '[]'::jsonb)$$, pg_temp.got('rule'))), '22023|other_fingerprints_invalid', 'the other fingerprints are an object');
-- A new account under the active key while a proposal is open: fine, with both fingerprints. (Its re-key comes later.)
select pg_temp.keep('rF', pg_temp.reg(6, 'rot-key-000000026', 1, pg_temp.got('rule')::uuid, others => jsonb_build_object('2', pg_temp.fp(6, 2)))::text);
select is((select verification_status from payments.account_registry where id = pg_temp.got('rF')::uuid), 'unverified', 'a new account is registered under the active key with both fingerprints; it is unverified');
-- A registration under version 1 whose version-2 fingerprint is already on the register is the evasion from the other side.
select is(pg_temp.err(format($$select pg_temp.reg(6, 'rot-key-000000027', 1, %L::uuid, others => jsonb_build_object('2', pg_temp.fp(6, 2)))$$, pg_temp.got('rule'))), '23505|account_already_registered', 'registering the same account again is refused');

-- ---------------------------------------------------------------------------------------------------------------------------
-- 4. The rotation cannot complete until every live entry has a successor
-- ---------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user(pg_temp.u(3));
select is(pg_temp.err($$select payments.approve_fingerprint_key_version(2)$$), '55000|rotation_incomplete', 'with live entries not yet re-keyed, version 2 cannot become active');
select pg_temp.as_user(pg_temp.u(1));
-- Wrong re-keys.
select is(pg_temp.err(format($$select pg_temp.reg(1, 'rot-key-000000030', 2, %L::uuid, kind => 'lender', purposes => array['repayment_settlement'], others => jsonb_build_object('1', pg_temp.fp(1, 1)), rekeys => %L::uuid)$$, pg_temp.got('rule'), pg_temp.got('rA'))),
  '22023|rekey_owner_mismatch', 'EVASION 3: a re-key cannot change the owner (Udofin to lender)');
select is(pg_temp.err(format($$select pg_temp.reg(1, 'rot-key-000000031', 2, %L::uuid, kind => 'udofin', org => null, purposes => array['fee_collection'], others => jsonb_build_object('1', pg_temp.fp(1, 1)))$$, pg_temp.got('rule'))),
  '55000|key_version_not_active', 'a re-key must say so (p_rekeys)');
select is(pg_temp.err(format($$select pg_temp.reg(1, 'rot-key-000000032', 2, %L::uuid, kind => 'udofin', org => null, purposes => array['fee_collection'], others => jsonb_build_object('1', pg_temp.fp(1, 1)), rekeys => %L::uuid)$$, pg_temp.got('rule'), pg_temp.got('rB'))),
  '23505|account_registered_under_other_key', 'a re-key must name the entry the other fingerprint belongs to (naming another entry is the evasion, refused)');
select is(pg_temp.err(format($$select pg_temp.reg(7, 'rot-key-000000033', 2, %L::uuid, kind => 'udofin', org => null, purposes => array['fee_collection'], others => jsonb_build_object('1', pg_temp.fp(7, 1)), rekeys => %L::uuid)$$, pg_temp.got('rule'), pg_temp.got('rA'))),
  '22023|rekey_invalid', 'a different real account cannot be passed off as the re-key of an entry');
select is(pg_temp.err(format($$select pg_temp.reg(4, 'rot-key-000000034', 2, %L::uuid, others => jsonb_build_object('1', pg_temp.fp(4, 1)), rekeys => %L::uuid)$$, pg_temp.got('rule'), pg_temp.got('rD'))),
  '22023|rekey_invalid', 'a revoked entry cannot be re-keyed: it stays refused');
select is(pg_temp.err(format($$select pg_temp.reg(2, 'rot-key-000000035', 1, %L::uuid, others => jsonb_build_object('2', pg_temp.fp(2, 2)), rekeys => %L::uuid)$$, pg_temp.got('rule'), pg_temp.got('rB'))),
  '22023|rekey_invalid', 're-keying targets the proposed version only');
-- Right re-keys: A (Udofin, verified), B (lender, verified), C (lender, unverified), F (lender, unverified).
select pg_temp.keep('sA', pg_temp.reg(1, 'rot-key-000000040', 2, pg_temp.got('rule')::uuid, kind => 'udofin', org => null, purposes => array['fee_collection'], others => jsonb_build_object('1', pg_temp.fp(1, 1)), rekeys => pg_temp.got('rA')::uuid)::text);
select pg_temp.keep('sB', pg_temp.reg(2, 'rot-key-000000041', 2, pg_temp.got('rule')::uuid, others => jsonb_build_object('1', pg_temp.fp(2, 1)), rekeys => pg_temp.got('rB')::uuid)::text);
select pg_temp.keep('sC', pg_temp.reg(3, 'rot-key-000000042', 2, pg_temp.got('rule')::uuid, others => jsonb_build_object('1', pg_temp.fp(3, 1)), rekeys => pg_temp.got('rC')::uuid)::text);
select is((select rekeyed_from_id from payments.account_registry where id = pg_temp.got('sA')::uuid), pg_temp.got('rA')::uuid, 'the successor records which entry it re-keys');
select is(pg_temp.err(format($$select pg_temp.reg(1, 'rot-key-000000043', 2, %L::uuid, kind => 'udofin', org => null, purposes => array['fee_collection'], others => jsonb_build_object('1', pg_temp.fp(1, 1)), rekeys => %L::uuid)$$, pg_temp.got('rule'), pg_temp.got('rA'))),
  '23505|account_already_registered', 'an entry is re-keyed once');
select pg_temp.as_user(pg_temp.u(3));
select is(pg_temp.err($$select payments.approve_fingerprint_key_version(2)$$), '55000|rotation_incomplete', 'still incomplete: entry F has no successor');
select pg_temp.as_user(pg_temp.u(1));
select pg_temp.keep('sF', pg_temp.reg(6, 'rot-key-000000044', 2, pg_temp.got('rule')::uuid, others => jsonb_build_object('1', pg_temp.fp(6, 1)), rekeys => pg_temp.got('rF')::uuid)::text);
select pg_temp.as_user(pg_temp.u(3));
select is(pg_temp.err($$select payments.approve_fingerprint_key_version(2)$$), '55000|rotation_incomplete',
  'still incomplete: A and B were VERIFIED under the old key, their successors are not yet verified (the successor must be at least as strong)');
select payments.verify_account(pg_temp.got('sA')::uuid, 'SAMPLE-ROT-EVIDENCE-SA');
select pg_temp.as_user(pg_temp.u(4));
select payments.verify_account(pg_temp.got('sB')::uuid, 'SAMPLE-ROT-EVIDENCE-SB');
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err($$select payments.approve_fingerprint_key_version(2)$$), '42501|', 'a registry manager cannot approve a key version');
select pg_temp.as_owner();
select is(pg_temp.err(format($$update payments.fingerprint_key_versions set status = 'active', approved_by = proposed_by, approved_at = now() where key_version = 2$$)), '23514|',
  'even the owner cannot activate a version on the proposer''s own approval (check)');

-- ---------------------------------------------------------------------------------------------------------------------------
-- 5. Activation: version 2 becomes active, version 1 is retired, in one step
-- ---------------------------------------------------------------------------------------------------------------------------
select pg_temp.as_user(pg_temp.u(4));
select is(payments.approve_fingerprint_key_version(2, 'SAMPLE rotation approved'), 'active', 'with every live entry re-keyed (and the verified ones re-verified) version 2 is approved by a verifier other than the proposer');
select pg_temp.as_owner();
select is((select string_agg(key_version || ':' || status, ',' order by key_version) from payments.fingerprint_key_versions), '1:retired,2:active', 'version 1 is retired and version 2 is active');
select is((select (retired_by = pg_temp.u(4), approved_by = pg_temp.u(4))::text from payments.fingerprint_key_versions where key_version = 1), '(t,f)', 'the retirement is attributed to the approver');
select is((select count(*) from audit.events where action in ('payments.fingerprint_key.proposed', 'payments.fingerprint_key.activated')), 4::bigint, 'proposals and activations are audited');
select is(pg_temp.err($$update payments.fingerprint_key_versions set status = 'active', retired_by = null, retired_at = null where key_version = 1$$), 'P0001|', 'a retired version is never brought back');
select pg_temp.as_system();
select is(pg_temp.cls(2, 1), 'refused:key_version_not_active', 'the old entry of a verified lender account no longer counts, however verified it was');
select is(pg_temp.cls(1, 1, 1, 'fee_collection'), 'refused:key_version_not_active,owner_mismatch', 'nor does the old Udofin entry');
select is(pg_temp.cls(2, 2), 'permitted:', 'its successor, verified under the new key, is permitted');
select is(pg_temp.cls(3, 2), 'hold:account_unverified', 'the unverified one stays held under the new key');
select is(pg_temp.cls(1, 2, 1, 'repayment_settlement'), 'refused:owner_mismatch,owner_prohibited,purpose_not_permitted', 'and the Udofin account is still refused for repayments under the new key');
select pg_temp.as_user(pg_temp.u(1));
select is(pg_temp.err(format($$select pg_temp.reg(8, 'rot-key-000000050', 1, %L::uuid)$$, pg_temp.got('rule'))), '55000|key_version_not_allowed', 'nothing can be registered under the retired key any more');
select is(pg_temp.err(format($$select pg_temp.reg(1, 'rot-key-000000051', 2, %L::uuid, kind => 'lender', purposes => array['repayment_settlement'])$$, pg_temp.got('rule'))), '23505|account_already_registered',
  'EVASION 4: the Udofin account cannot be registered as a lender account under the new key: its re-keyed entry holds the fingerprint');
select pg_temp.keep('rG', pg_temp.reg(8, 'rot-key-000000052', 2, pg_temp.got('rule')::uuid)::text);
select is((select key_version from payments.account_registry where id = pg_temp.got('rG')::uuid), 2, 'new accounts are registered under the active key, with nothing else to carry');

-- ---------------------------------------------------------------------------------------------------------------------------
-- 6. Who can see and write what
-- ---------------------------------------------------------------------------------------------------------------------------
select is((select count(*) from payments.fingerprint_key_versions), 2::bigint, 'a registry manager reads the key versions');
select pg_temp.as_user(pg_temp.u(6));
select is((select count(*) from payments.fingerprint_key_versions), 0::bigint, 'a user with no registry permission reads none');
select is(pg_temp.err($$insert into payments.fingerprint_key_versions (key_version, proposed_by) values (3, auth.uid())$$), '42501|', 'and cannot write');
select pg_temp.as_system();
select is(pg_temp.err($$select count(*) from payments.fingerprint_key_versions$$), '42501|', 'the system role cannot read the key table (the classification functions do)');
select is(pg_temp.err($$insert into payments.fingerprint_key_versions (key_version, proposed_by) values (3, gen_random_uuid())$$), '42501|', 'nor write it');
select is(pg_temp.err($$select payments.propose_fingerprint_key_version(3)$$), '42501|', 'nor propose a version');
select is(pg_temp.err($$select payments.approve_fingerprint_key_version(2)$$), '42501|', 'nor approve one');
select pg_temp.as_owner();
select is(pg_temp.err($$insert into payments.fingerprint_key_versions (key_version, status, proposed_by, approved_by, approved_at) values (3, 'active', gen_random_uuid(), gen_random_uuid(), now())$$), 'P0001|',
  'a version cannot be inserted already active, even by the owner');
select is(pg_temp.err($$insert into payments.account_registry (fingerprint, key_version, masked_ref, country, account_type, format_rule_id, format_validated, owner_kind, owner_org_id, legal_owner_name, permitted_purposes, effective_from, registered_by, idempotency_key)
  values (repeat('a', 64), 9, 'XXXXXX9999', 'IN', 'bank_account', gen_random_uuid(), true, 'lender', 'f7b00000-0000-4000-8000-000000000001', 'SAMPLE Entity Ltd', array['repayment_settlement'], current_date, gen_random_uuid(), 'direct-rot-key-0001')$$), '23503|',
  'a registry entry under a key version that is not in the register is refused by the foreign key, for every writer');
select is(pg_temp.err(format($$update payments.account_registry set rekeyed_from_id = null where id = %L$$, pg_temp.got('sA'))), 'P0001|', 'the re-key link of an entry cannot be edited');
select is(pg_temp.err(format($$update payments.account_registry set rekeyed_from_id = id where id = %L$$, pg_temp.got('rG'))), 'P0001|', 'nor added afterwards');
select is(pg_temp.err(format($$insert into payments.account_registry (fingerprint, key_version, rekeyed_from_id, masked_ref, country, account_type, format_rule_id, format_validated, owner_kind, owner_org_id, legal_owner_name, permitted_purposes, effective_from, registered_by, idempotency_key)
  select repeat('b', 64), 2, %L::uuid, 'XXXXXX9998', country, account_type, format_rule_id, true, owner_kind, owner_org_id, legal_owner_name, permitted_purposes, current_date, registered_by, 'direct-rot-key-0002' from payments.account_registry where id = %L::uuid$$, pg_temp.got('rA'), pg_temp.got('rA'))),
  '23505|', 'two successors for one entry are refused by a unique index, for every writer');
select ok(exists (select 1 from pg_indexes where schemaname = 'payments' and indexname = 'account_registry_key_version'), 'the registry''s key version foreign key is indexed');
select ok(obj_description('payments.fingerprint_key_versions'::regclass, 'pg_class') like '%Owner: payments module.', 'the table comment names its owner module');
select is((select count(*) from payments.account_registry where key_version = 2 and rekeyed_from_id is not null), 4::bigint, 'four entries were re-keyed (A, B, C, F); the revoked and rejected ones were not');

select * from finish();
rollback;
