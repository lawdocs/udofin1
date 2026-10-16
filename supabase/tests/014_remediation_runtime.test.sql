-- Remediation (audit F-01, F-06): session liveness check and durable webhook de-duplication.
-- Synthetic data only. The tables here are platform plumbing (not tenant-owned), so the negative cases
-- are "every other principal": a signed-in lender user, a signed-in borrower, anon and PUBLIC.
begin;
create extension if not exists pgtap with schema extensions;
select plan(37);

create function pg_temp.as_user(uid uuid) returns void language plpgsql as $fn$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  execute 'set local role authenticated';
end
$fn$;
-- The Send-SMS hook has no user: the API uses role `authenticated` with no claims.
create function pg_temp.as_claimless() returns void language plpgsql as $fn$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
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
grant execute on function pg_temp.as_user(uuid), pg_temp.as_claimless(), pg_temp.as_system(), pg_temp.as_owner() to public;

insert into auth.users (id, phone, raw_app_meta_data) values
  ('e1000000-0000-4000-8000-000000000001', null, '{"actor_type":"staff"}'),
  ('e1000000-0000-4000-8000-000000000002', null, '{"actor_type":"staff"}');
insert into auth.sessions (id, user_id, not_after) values
  ('e5000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001', null),
  ('e5000000-0000-4000-8000-000000000002', 'e1000000-0000-4000-8000-000000000001', now() + interval '1 hour'),
  ('e5000000-0000-4000-8000-000000000003', 'e1000000-0000-4000-8000-000000000001', now() - interval '1 minute'),
  ('e5000000-0000-4000-8000-000000000004', 'e1000000-0000-4000-8000-000000000001', null),
  ('e5000000-0000-4000-8000-000000000005', 'e1000000-0000-4000-8000-000000000002', null);

-- Session liveness -----------------------------------------------------------------------------------------
select pg_temp.as_user('e1000000-0000-4000-8000-000000000001');
select is(private.session_is_active('e5000000-0000-4000-8000-000000000001'), true,
  'an existing session without a time-box is active');
select is(private.session_is_active('e5000000-0000-4000-8000-000000000002'), true,
  'a session whose time-box is in the future is active');
select is(private.session_is_active('e5000000-0000-4000-8000-000000000003'), false,
  'a session past its time-box is not active');
select is(private.session_is_active('e5000000-0000-4000-8000-000000000005'), false,
  'another user''s session is not active for this caller (no cross-user oracle)');
select is(private.session_is_active('e5000000-0000-4000-8000-0000000000ff'), false,
  'an unknown session id is not active');
select is(private.session_is_active(null), false, 'a missing session id is not active');

select pg_temp.as_owner();
delete from auth.sessions where id = 'e5000000-0000-4000-8000-000000000004';
select pg_temp.as_user('e1000000-0000-4000-8000-000000000001');
select is(private.session_is_active('e5000000-0000-4000-8000-000000000004'), false,
  'a session deleted by sign-out or revocation is no longer active');

select pg_temp.as_user('e1000000-0000-4000-8000-000000000002');
select is(private.session_is_active('e5000000-0000-4000-8000-000000000001'), false,
  'the other user cannot see the first user''s live session either');
select is(private.session_is_active('e5000000-0000-4000-8000-000000000005'), true,
  'each user sees their own session');

select pg_temp.as_claimless();
select is(private.session_is_active('e5000000-0000-4000-8000-000000000001'), false,
  'a call without any user identity gets false for every session');

select ok(not has_function_privilege('anon', 'private.session_is_active(uuid)', 'EXECUTE'),
  'anon cannot execute the session check');
select ok(has_function_privilege('authenticated', 'private.session_is_active(uuid)', 'EXECUTE'),
  'authenticated can execute the session check');
select ok(not has_function_privilege('public', 'private.session_is_active(uuid)', 'EXECUTE'),
  'PUBLIC cannot execute the session check');

-- Webhook de-duplication -------------------------------------------------------------------------------------
select pg_temp.as_claimless();
select is(private.mark_webhook_seen('send_sms_hook', 'msg-aaaaaaaa-0001'), true, 'the first delivery of a message id is accepted');
select is(private.mark_webhook_seen('send_sms_hook', 'msg-aaaaaaaa-0001'), false, 'a repeat of the same message id is refused');
select is(private.mark_webhook_seen('other_hook', 'msg-aaaaaaaa-0001'), true, 'the same id from a different source is independent');
select is(private.mark_webhook_seen('send_sms_hook', 'msg-aaaaaaaa-0002'), true, 'a different id from the same source is accepted');
select throws_ok($$select private.mark_webhook_seen('Send SMS', 'msg-aaaaaaaa-0003')$$, '22023', null,
  'a malformed source is refused');
select throws_ok($$select private.mark_webhook_seen('send_sms_hook', 'abc')$$, '22023', null,
  'a too-short message id is refused');
select throws_ok($$select private.mark_webhook_seen('send_sms_hook', 'bad id with spaces')$$, '22023', null,
  'a message id with unsafe characters is refused');
select throws_ok($$select private.mark_webhook_seen('send_sms_hook', null)$$, '22023', null,
  'a missing message id is refused');

select pg_temp.as_user('e1000000-0000-4000-8000-000000000001');
select throws_ok($$select private.mark_webhook_seen('send_sms_hook', 'msg-aaaaaaaa-0004')$$, '42501', null,
  'a signed-in user cannot pre-mark a message id (the guard is for hooks without a user)');
select throws_ok($$select count(*) from ops.seen_webhooks$$, '42501', null,
  'a signed-in user cannot read the table');
select throws_ok($$insert into ops.seen_webhooks (source, message_id) values ('send_sms_hook', 'msg-aaaaaaaa-0005')$$, '42501', null,
  'a signed-in user cannot write the table directly');

select pg_temp.as_owner();
select is((select count(*)::int from ops.seen_webhooks where message_id = 'msg-aaaaaaaa-0004'), 0,
  'the refused user call left nothing behind');

select ok(not has_function_privilege('anon', 'private.mark_webhook_seen(text, text)', 'EXECUTE'),
  'anon cannot execute the de-duplication function');
select ok(not has_function_privilege('public', 'private.mark_webhook_seen(text, text)', 'EXECUTE'),
  'PUBLIC cannot execute the de-duplication function');
select ok(not has_table_privilege('anon', 'ops.seen_webhooks', 'SELECT')
          and not has_table_privilege('authenticated', 'ops.seen_webhooks', 'SELECT')
          and not has_table_privilege('authenticated', 'ops.seen_webhooks', 'INSERT'),
  'anon and authenticated hold no table privileges on ops.seen_webhooks');
select ok((select relrowsecurity and relforcerowsecurity from pg_class where oid = 'ops.seen_webhooks'::regclass),
  'row-level security is enabled and forced on ops.seen_webhooks');
select is((select count(*)::int from pg_policies where schemaname = 'ops' and tablename = 'seen_webhooks'), 0,
  'ops.seen_webhooks has no policy (only the owner and the system role can reach it)');
select ok(obj_description('ops.seen_webhooks'::regclass, 'pg_class') is not null
          and obj_description('private.mark_webhook_seen(text, text)'::regprocedure, 'pg_proc') is not null,
  'the table and the function carry comments');

-- Retention ---------------------------------------------------------------------------------------------------
insert into ops.seen_webhooks (source, message_id, seen_at) values
  ('send_sms_hook', 'msg-old-0000001', now() - interval '2 days');
select pg_temp.as_system();
select is(ops.purge_seen_webhooks(interval '1 day', 1000), 1, 'the system role purges rows older than the retention');
select is((select count(*)::int from ops.seen_webhooks where message_id = 'msg-old-0000001'), 0, 'the old row is gone');
select is((select count(*)::int from ops.seen_webhooks where source = 'send_sms_hook' and message_id = 'msg-aaaaaaaa-0001'), 1, 'a recent row survives the purge');
select throws_ok($$select ops.purge_seen_webhooks(interval '1 minute', 10)$$, '22023', null,
  'a retention shorter than the signature window is refused');
select throws_ok($$insert into ops.seen_webhooks (source, message_id) values ('send_sms_hook', 'msg-aaaaaaaa-0006')$$, '42501', null,
  'even the system role cannot insert directly (only the definer function writes)');

select pg_temp.as_claimless();
select throws_ok($$select ops.purge_seen_webhooks(interval '1 day', 10)$$, '42501', null,
  'the API role cannot purge');

select * from finish();
rollback;
