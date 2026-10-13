-- Phase 05: borrower profile, consent, loan requests, step-up, integrity, deletion. Synthetic data only.
begin;
create extension if not exists pgtap with schema extensions;
select plan(83);

create function pg_temp.as_user(uid uuid) returns void language plpgsql as $fn$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated', 'aal', 'aal1')::text, true);
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
grant execute on all functions in schema pg_temp to public;

insert into auth.users (id, phone, raw_app_meta_data) values
  ('e1000000-0000-4000-8000-000000000001', '910000010001', '{}'),
  ('e1000000-0000-4000-8000-000000000002', '910000010002', '{}'),
  ('e1000000-0000-4000-8000-000000000008', null, '{"actor_type":"staff"}'),
  ('e1000000-0000-4000-8000-000000000009', null, '{"actor_type":"staff"}');

select pg_temp.as_owner();
insert into lending.loan_purposes (key, label_en, label_hi, hi_review_status) values
  ('test_purpose_a', 'Test purpose A', 'परीक्षण उद्देश्य ए', 'requires_review'),
  ('test_purpose_b', 'Test purpose B', 'परीक्षण उद्देश्य बी', 'approved');
-- Published notices (fixture; production notices go through the two-person publishing workflow).
insert into consent.notices (id, purpose, version, language, title, body_markdown, status, published_at, drafted_by, approved_by, review_status) values
  ('e2000000-0000-4000-8000-000000000001', 'terms_of_use', 1, 'en', 'Terms', 'Terms text v1', 'published', now(), 'e1000000-0000-4000-8000-000000000008', 'e1000000-0000-4000-8000-000000000009', 'approved'),
  ('e2000000-0000-4000-8000-000000000002', 'privacy_notice', 1, 'en', 'Privacy', 'Privacy text v1', 'published', now(), 'e1000000-0000-4000-8000-000000000008', 'e1000000-0000-4000-8000-000000000009', 'approved'),
  ('e2000000-0000-4000-8000-000000000003', 'share_with_lenders', 1, 'en', 'Sharing', 'Sharing text v1', 'published', now(), 'e1000000-0000-4000-8000-000000000008', 'e1000000-0000-4000-8000-000000000009', 'approved'),
  ('e2000000-0000-4000-8000-000000000004', 'marketing', 1, 'en', 'Marketing', 'Marketing text v1', 'published', now(), 'e1000000-0000-4000-8000-000000000008', 'e1000000-0000-4000-8000-000000000009', 'approved'),
  ('e2000000-0000-4000-8000-000000000005', 'terms_of_use', 1, 'hi', 'शर्तें', 'शर्तें पाठ', 'published', now(), 'e1000000-0000-4000-8000-000000000008', 'e1000000-0000-4000-8000-000000000009', 'requires_review'),
  ('e2000000-0000-4000-8000-000000000006', 'terms_of_use', 2, 'en', 'Terms', 'Terms text v2', 'published', now(), 'e1000000-0000-4000-8000-000000000008', 'e1000000-0000-4000-8000-000000000009', 'approved');

-- 1. Profile ------------------------------------------------------------------------------------
select pg_temp.as_user('e1000000-0000-4000-8000-000000000001');
select is((select onboarding_status from identity.borrowers), 'account_created', 'a new borrower starts as account_created (nothing implies KYC or eligibility)');
select is(pg_temp.err($$select identity.update_profile(null, false, 'fr')$$), '22023|language_unsupported', 'only English and Hindi are accepted');
select is(pg_temp.err($$select identity.update_profile(null, false, 'hi')$$), 'ok', 'language can be set without a display name');
select is((select preferred_language || '/' || onboarding_status from identity.borrowers), 'hi/profile_started', 'the preference persists and the status moves to profile_started');
select is(pg_temp.err($$select identity.update_profile('<b>x</b>', false, null)$$), '23514|', 'markup in a display name is refused');
select is(pg_temp.err($$select identity.update_profile('Asha', false, null)$$), 'ok', 'a display name is optional but accepted');
select is(pg_temp.err($$select identity.complete_profile()$$), 'ok', 'the profile can be completed without any KYC data');
select is((select onboarding_status from identity.borrowers), 'profile_completed', 'profile_completed is a distinct state');
select pg_temp.as_user('e1000000-0000-4000-8000-000000000002');
select is((select count(*) from identity.borrowers), 1::bigint, 'borrower 2 sees only their own profile');
select is((select display_name from identity.borrowers), null, 'and not borrower 1''s display name');

-- 2. Consent --------------------------------------------------------------------------------------
select pg_temp.as_user('e1000000-0000-4000-8000-000000000001');
select is(pg_temp.err($$select consent.record_decision('e2000000-0000-4000-8000-000000000006', 'granted', '1.0.0', 'consent')$$), 'ok', 'terms acceptance is recorded against the exact notice version');
select is(pg_temp.err($$select consent.record_decision('e2000000-0000-4000-8000-000000000006', 'granted', '1.0.0', 'consent')$$), 'ok', 'a repeat is another ledger row, never an overwrite');
select is((select count(*) from consent.records), 2::bigint, 'both rows are kept');
select is(pg_temp.err($$select consent.record_decision('e2000000-0000-4000-8000-000000000004', 'granted', '1.0.0', 'consent')$$), '55000|marketing_disabled', 'marketing consent cannot be recorded while marketing is disabled');
select is(pg_temp.err($$select consent.record_decision('e2000000-0000-4000-8000-000000000005', 'granted', '1.0.0', 'consent')$$), '55000|wording_not_approved', 'unreviewed wording cannot be the basis of a required consent');
select is(pg_temp.err($$select consent.record_decision('e2000000-0000-4000-8000-000000000001', 'granted', '1.0.0', 'consent')$$), '55000|notice_superseded', 'an older version of the wording can no longer be accepted');
select is((select notice_version from consent.current_decisions where purpose = 'terms_of_use'), 2, 'the current decision points at the version the borrower accepted');
select is((select evidence ->> 'notice_sha256' from consent.records order by captured_at desc, id desc limit 1), encode(sha256(convert_to('Terms text v2', 'UTF8')), 'hex'), 'the evidence holds the hash of the exact wording shown');
select pg_temp.as_owner();
select is(pg_temp.err($$update consent.notices set review_status = 'approved' where id = 'e2000000-0000-4000-8000-000000000005'$$), 'P0001|', 'published wording (and its review status) is immutable');
select is(pg_temp.err($$update consent.records set decision = 'denied'$$), 'P0001|Record a compensating entry instead.', 'consent history cannot be rewritten');
select pg_temp.as_user('e1000000-0000-4000-8000-000000000001');
select is(pg_temp.err($$select consent.record_decision('e2000000-0000-4000-8000-000000000006', 'withdrawn', '1.0.0', 'settings')$$), 'ok', 'withdrawal is a new event');
select is((select decision::text from consent.current_decisions where purpose = 'terms_of_use'), 'withdrawn', 'and becomes the current decision');
select pg_temp.as_user('e1000000-0000-4000-8000-000000000002');
select is((select count(*) from consent.records), 0::bigint, 'borrower 2 cannot see borrower 1''s consent records');

-- 3. Loan requests ------------------------------------------------------------------------------------
select pg_temp.as_user('e1000000-0000-4000-8000-000000000001');

select set_config('t.r1', lending.request_create('personal', 5000000, 365, 'test_purpose_a', null)::text, true);
select is((select status from lending.my_loan_requests where id = current_setting('t.r1')::uuid), 'draft', 'a draft is created');
select is((select expires_at - created_at from lending.loan_requests where id = current_setting('t.r1')::uuid), interval '30 days', 'the draft expires exactly 30 days after creation');
select is(pg_temp.err($$select lending.request_create('personal', 5000000, 365, 'no_such_purpose', null)$$), '22023|purpose_unknown', 'a purpose outside the fixed list is refused by the database');
select is(pg_temp.err($$select lending.request_create('personal', 5000000, 10, 'test_purpose_a', null)$$), '22023|tenure_out_of_range', 'tenure below the category floor is refused');
select is(pg_temp.err($$select lending.request_create('payday', 5000000, 365, 'test_purpose_a', null)$$), '22023|category_unavailable', 'a category that is not enabled is refused');
select is(pg_temp.err(format($$select lending.request_create('personal', 5000000, 365, 'test_purpose_a', %L)$$, gen_random_uuid())), '55000|product_unavailable', 'a product that is not available (not live) cannot be attached');
select is(lending.request_update(current_setting('t.r1')::uuid, 1, 6000000, null, 'test_purpose_b', null, false), 2, 'an edit bumps the version');
select is(pg_temp.err(format($$select lending.request_update(%L, 1, 7000000, null, null, null, false)$$, current_setting('t.r1'))), '55000|version_conflict', 'a stale edit is refused (no lost update)');
select is((select expires_at - created_at from lending.loan_requests where id = current_setting('t.r1')::uuid), interval '30 days', 'editing does not extend the expiry');
select is(pg_temp.err(format($$update lending.loan_requests set expires_at = now() + interval '90 days' where id = %L$$, current_setting('t.r1'))), '42501|', 'the borrower cannot change the expiry directly');
select is(pg_temp.err(format($$select lending.request_submit(%L, 2)$$, current_setting('t.r1'))), '55000|consent_required', 'submission needs the required consents (terms was withdrawn)');
select consent.record_decision('e2000000-0000-4000-8000-000000000006', 'granted', '1.0.0', 'consent');
select consent.record_decision('e2000000-0000-4000-8000-000000000002', 'granted', '1.0.0', 'consent');
select is(pg_temp.err(format($$select lending.request_submit(%L, 2)$$, current_setting('t.r1'))), '55000|consent_required', 'sharing consent is also required');
select consent.record_decision('e2000000-0000-4000-8000-000000000003', 'granted', '1.0.0', 'consent');
select set_config('t.ref', lending.request_submit(current_setting('t.r1')::uuid, 2), true);
select matches(current_setting('t.ref'), '^UR-[0-9A-F]{10}$', 'submission returns a stable reference');
select is(lending.request_submit(current_setting('t.r1')::uuid, 2), current_setting('t.ref'), 'a repeated submission returns the same reference and creates nothing new');
select is((select count(*) from lending.loan_requests where status = 'submitted'), 1::bigint, 'exactly one submitted request');
select is(pg_temp.err(format($$select lending.request_update(%L, 3, 1, null, null, null, false)$$, current_setting('t.r1'))), '55000|not_editable', 'a submitted request is no longer editable');
select is((select string_agg(event, ',' order by occurred_at) from lending.loan_request_events where loan_request_id = current_setting('t.r1')::uuid), 'created,submitted', 'borrower-visible history lists created and submitted');
select is((select count(*) from lending.loan_requests where product_snapshot is not null), 0::bigint, 'no product snapshot when no product was selected');
-- Expiry is enforced on read and on write, whether or not a job ran.
select set_config('t.r2', lending.request_create('personal', 5000000, 365, 'test_purpose_a', null)::text, true);
select pg_temp.as_owner();
update lending.loan_requests set expires_at = now() - interval '1 minute' where id = current_setting('t.r2')::uuid;
select pg_temp.as_user('e1000000-0000-4000-8000-000000000001');
select is((select status from lending.my_loan_requests where id = current_setting('t.r2')::uuid), 'expired', 'an overdue draft reads as expired before any job runs');
select is(pg_temp.err(format($$select lending.request_submit(%L, %s)$$, current_setting('t.r2'), (select version from lending.my_loan_requests where id = current_setting('t.r2')::uuid))), '55000|draft_expired', 'an expired draft cannot be submitted');
select is(pg_temp.err(format($$select lending.request_update(%L, %s, 7000000, null, null, null, false)$$, current_setting('t.r2'), (select version from lending.my_loan_requests where id = current_setting('t.r2')::uuid))), '55000|draft_expired', 'nor edited');
select is(pg_temp.err(format($$update lending.loan_requests set status = 'submitted' where id = %L$$, current_setting('t.r2'))), '55000|draft_expired', 'nor bypassed by a direct update (database rule)');
select pg_temp.as_system();
select is(lending.expire_drafts(), 1, 'the cleanup marks it expired');
select is(lending.expire_drafts(), 0, 'and is safe to repeat');
select pg_temp.as_user('e1000000-0000-4000-8000-000000000001');
select is(pg_temp.err($$select lending.expire_drafts()$$), '42501|', 'a borrower cannot run the cleanup');
select pg_temp.as_user('e1000000-0000-4000-8000-000000000002');
select is((select count(*) from lending.my_loan_requests), 0::bigint, 'borrower 2 sees none of borrower 1''s requests');
select is((select count(*) from lending.loan_request_events), 0::bigint, 'nor their history');
select is(pg_temp.err(format($$select lending.request_withdraw(%L)$$, current_setting('t.r1'))), 'P0002|', 'nor can they withdraw it (not found, no leak)');
select is(pg_temp.err(format($$select lending.request_submit(%L, 1)$$, current_setting('t.r1'))), 'P0002|', 'nor submit it');
select pg_temp.as_user('e1000000-0000-4000-8000-000000000001');
select is(pg_temp.err(format($$select lending.request_withdraw(%L)$$, current_setting('t.r1'))), 'ok', 'the owner can withdraw a submitted request');
select is((select status from lending.my_loan_requests where id = current_setting('t.r1')::uuid), 'withdrawn', 'and sees it withdrawn');
-- Too many open drafts.
select lending.request_create('personal', 5000000, 365, 'test_purpose_a', null) from generate_series(1, 5);
select is(pg_temp.err($$select lending.request_create('personal', 5000000, 365, 'test_purpose_a', null)$$), '55000|too_many_drafts', 'the number of open drafts is bounded');

-- 4. Step-up verification -----------------------------------------------------------------------------------
select pg_temp.as_user('e1000000-0000-4000-8000-000000000002');
select identity.stepup_start('e3000000-0000-4000-8000-000000000001', 'bank_account_change', 'acct1', repeat('a', 64));
select is(identity.stepup_verify('e3000000-0000-4000-8000-000000000001', repeat('b', 64)), 'invalid', 'a wrong code is refused');
select is(pg_temp.err($$select identity.stepup_consume('bank_account_change', 'acct1')$$), '42501|stepup_required', 'an unverified challenge cannot authorise the action');
select is(identity.stepup_verify('e3000000-0000-4000-8000-000000000001', repeat('a', 64)), 'verified', 'the right code verifies');
select is(pg_temp.err($$select identity.stepup_consume('mandate_creation', 'acct1')$$), '42501|stepup_required', 'a code verified for one action cannot authorise another');
select is(pg_temp.err($$select identity.stepup_consume('bank_account_change', 'acct2')$$), '42501|stepup_required', 'nor the same action on a different object');
select is(pg_temp.err($$select identity.stepup_consume('bank_account_change', 'acct1')$$), 'ok', 'the matching action consumes it');
select is(pg_temp.err($$select identity.stepup_consume('bank_account_change', 'acct1')$$), '42501|stepup_required', 'and it cannot be replayed');
select identity.stepup_start('e3000000-0000-4000-8000-000000000002', 'esign', 'doc1', repeat('c', 64));
select identity.stepup_verify('e3000000-0000-4000-8000-000000000002', repeat('0', 64));
select identity.stepup_verify('e3000000-0000-4000-8000-000000000002', repeat('0', 64));
select identity.stepup_verify('e3000000-0000-4000-8000-000000000002', repeat('0', 64));
select identity.stepup_verify('e3000000-0000-4000-8000-000000000002', repeat('0', 64));
select is(identity.stepup_verify('e3000000-0000-4000-8000-000000000002', repeat('0', 64)), 'locked', 'five wrong attempts lock the challenge');
select is(identity.stepup_verify('e3000000-0000-4000-8000-000000000002', repeat('c', 64)), 'locked', 'even the right code is refused once locked');
select identity.stepup_start('e3000000-0000-4000-8000-000000000003', 'esign', 'doc2', repeat('e', 64));
select identity.stepup_verify('e3000000-0000-4000-8000-000000000003', repeat('0', 64)) from generate_series(1, 5);
select is(pg_temp.err($$select identity.stepup_start('e3000000-0000-4000-8000-000000000004', 'esign', 'doc3', repeat('f', 64))$$), '55000|rate_limited', 'two locked challenges in a day stop further codes (overall guess budget)');
select pg_temp.as_user('e1000000-0000-4000-8000-000000000001');
select is(identity.stepup_verify('e3000000-0000-4000-8000-000000000001', repeat('a', 64)), 'not_found', 'another borrower cannot touch the challenge');

-- 5. Device integrity ---------------------------------------------------------------------------------------
select is(identity.current_integrity_level(), 'none', 'with no assessment the level is none');
select identity.issue_integrity_nonce(repeat('d', 64));
select is(identity.consume_integrity_nonce(repeat('d', 64)), true, 'a nonce works once');
select is(identity.consume_integrity_nonce(repeat('d', 64)), false, 'and not again (replay)');
select identity.record_attestation('device', 'mock_integrity');
select is(identity.current_integrity_level(), 'device', 'a recorded assessment sets the level, separately from any OTP');
select is(pg_temp.err($$select identity.record_attestation('perfect', 'mock_integrity')$$), '23514|', 'unknown levels are refused');

-- 6. Deletion and anonymisation -------------------------------------------------------------------------------------
select pg_temp.as_user('e1000000-0000-4000-8000-000000000002');
select identity.update_profile('Ravi', false, 'hi');
select set_config('t.del', identity.request_deletion()::text, true);
select is(identity.request_deletion()::text, current_setting('t.del'), 'a repeated request returns the same one');
select is((select status::text from identity.borrowers), 'closure_requested', 'the account shows as closing');
select is(pg_temp.err($$select lending.request_create('personal', 5000000, 365, 'test_purpose_a', null)$$), '55000|account_closing', 'no new request can start while closing');
select pg_temp.as_system();
select is(identity.process_deletion(current_setting('t.del')::uuid), 'anonymised', 'the worker anonymises the profile');
select is(identity.process_deletion(current_setting('t.del')::uuid), 'anonymised', 'processing is idempotent');
select pg_temp.as_owner();
select is((select display_name || '' from identity.borrowers where user_id = 'e1000000-0000-4000-8000-000000000002'), null, 'the display name is gone');
select is((select status::text || '/' || onboarding_status from identity.borrowers where user_id = 'e1000000-0000-4000-8000-000000000002'), 'closed/anonymised', 'the profile is closed and anonymised, not reactivated');
select cmp_ok((select count(*)::int from audit.events where action like 'identity.deletion.%'), '>=', 2, 'the deletion trail is kept');
select pg_temp.as_user('e1000000-0000-4000-8000-000000000002');
select is(pg_temp.err($$select identity.update_profile('Back again', false, null)$$), '42501|account_closed', 'a closed account cannot be revived through the profile');
select is(private.my_borrower_id() is null, true, 'a closed borrower has no borrower access');
-- Retained consent evidence of borrower 1 is untouched by anything above; blocked case:
select pg_temp.as_owner();
insert into tenancy.organizations (id, kind, legal_name, display_name, regulator_registration_no, status) values
  ('e4000000-0000-4000-8000-000000000001', 'lender', 'Deletion Lender (test)', 'DL', 'TEST-DEL-1', 'active')
  on conflict do nothing;
select pg_temp.as_user('e1000000-0000-4000-8000-000000000001');
select set_config('t.del1', identity.request_deletion()::text, true);
select pg_temp.as_owner();
select is((select count(*) from consent.records where borrower_id = (select id from identity.borrowers where user_id = 'e1000000-0000-4000-8000-000000000001')), 6::bigint, 'consent records are retained through a deletion request');
select pg_temp.as_user('e1000000-0000-4000-8000-000000000001');
select identity.cancel_deletion();
select is((select status::text from identity.borrowers), 'active', 'a deletion request can be cancelled before processing');

select * from finish();
rollback;
