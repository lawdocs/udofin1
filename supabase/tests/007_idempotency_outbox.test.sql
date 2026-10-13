-- Phase 03: durable idempotency store and transactional outbox. Synthetic data only.
-- Concurrency across real connections is tested through the API integration tests; this file proves
-- the single-connection semantics, privileges and the atomic enqueue.
begin;
create extension if not exists pgtap with schema extensions;
select plan(44);

create function pg_temp.as_staff(uid uuid, aal text default 'aal2') returns void language plpgsql as $fn$
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
grant execute on function pg_temp.as_staff(uuid, text), pg_temp.as_system(), pg_temp.as_owner() to public;

insert into auth.users (id, phone, raw_app_meta_data) values
  ('d1000000-0000-4000-8000-000000000001', null, '{"actor_type":"staff"}'),
  ('d1000000-0000-4000-8000-000000000002', null, '{"actor_type":"staff"}'),
  ('d1000000-0000-4000-8000-000000000003', null, '{"actor_type":"staff"}');
select pg_temp.as_owner();
insert into tenancy.organizations (id, kind, legal_name, display_name, regulator_registration_no, status) values
  ('d0000000-0000-4000-8000-000000000000', 'platform', 'Udofin Platform (test)', 'Udofin', null, 'active'),
  ('d2000000-0000-4000-8000-000000000000', 'lender', 'Eta Finance Ltd (test)', 'Eta', 'TEST-NBFC-0030', 'active');
insert into tenancy.memberships (id, org_id, user_id, status) values
  ('d1d10000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000000', 'd1000000-0000-4000-8000-000000000001', 'active'),
  ('d1d10000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000000', 'd1000000-0000-4000-8000-000000000002', 'active'),
  ('d1d10000-0000-4000-8000-000000000003', 'd2000000-0000-4000-8000-000000000000', 'd1000000-0000-4000-8000-000000000003', 'active');
insert into tenancy.membership_roles (membership_id, role_id)
select m.mid::uuid, r.id from (values
  ('d1d10000-0000-4000-8000-000000000001', 'platform', 'platform_admin'),
  ('d1d10000-0000-4000-8000-000000000002', 'platform', 'platform_admin'),
  ('d1d10000-0000-4000-8000-000000000003', 'lender', 'lender_admin')
) as m (mid, kind, rkey)
join tenancy.roles r on r.org_id is null and r.applies_to = m.kind::tenancy.organization_kind and r.key = m.rkey;

-- Idempotency -------------------------------------------------------------------------------------------
select pg_temp.as_staff('d1000000-0000-4000-8000-000000000001');
select is((select outcome from private.idempotency_begin('POST /v1/test', 'key-aaaaaaaaaaaaaaaa', repeat('a', 64))), 'proceed',
  'a first request proceeds');
select lives_ok($$select private.idempotency_complete('POST /v1/test', 'key-aaaaaaaaaaaaaaaa', 201, '{"id":"x"}')$$,
  'the response is stored in the same transaction');
select is((select outcome from private.idempotency_begin('POST /v1/test', 'key-aaaaaaaaaaaaaaaa', repeat('a', 64))), 'replay',
  'an identical repeat is a replay');
select is((select response_body ->> 'id' from private.idempotency_begin('POST /v1/test', 'key-aaaaaaaaaaaaaaaa', repeat('a', 64))), 'x',
  'the stored response is returned');
select is((select response_status from private.idempotency_begin('POST /v1/test', 'key-aaaaaaaaaaaaaaaa', repeat('a', 64))), 201,
  'the stored status is returned');
select throws_ok($$select * from private.idempotency_begin('POST /v1/test', 'key-aaaaaaaaaaaaaaaa', repeat('b', 64))$$,
  'IK409', null, 'the same key with a different request is refused');
select is((select outcome from private.idempotency_begin('POST /v1/other', 'key-aaaaaaaaaaaaaaaa', repeat('a', 64))), 'proceed',
  'the same key on another route is independent');

select pg_temp.as_staff('d1000000-0000-4000-8000-000000000002');
select is((select outcome from private.idempotency_begin('POST /v1/test', 'key-aaaaaaaaaaaaaaaa', repeat('a', 64))), 'proceed',
  'the same key from another principal is independent (no cross-user replay)');
select pg_temp.as_staff('d1000000-0000-4000-8000-000000000003');
select is((select outcome from private.idempotency_begin('POST /v1/test', 'key-aaaaaaaaaaaaaaaa', repeat('a', 64), 'd2000000-0000-4000-8000-000000000000')), 'proceed',
  'the same key from a user in another tenant is independent');

select pg_temp.as_staff('d1000000-0000-4000-8000-000000000001');
select throws_ok($$select * from private.idempotency_begin('POST /v1/test', 'short', repeat('a', 64))$$,
  '23514', null, 'a too-short key is refused');
select throws_ok($$select * from private.idempotency_begin('POST /v1/test', 'key-bbbbbbbbbbbbbbbb', 'nothex')$$,
  '23514', null, 'a malformed request hash is refused');

-- expiry
select pg_temp.as_owner();
update ops.idempotency_keys set expires_at = now() - interval '1 minute' where idem_key = 'key-aaaaaaaaaaaaaaaa' and route = 'POST /v1/test' and principal_id = 'd1000000-0000-4000-8000-000000000001';
select pg_temp.as_staff('d1000000-0000-4000-8000-000000000001');
select is((select outcome from private.idempotency_begin('POST /v1/test', 'key-aaaaaaaaaaaaaaaa', repeat('c', 64))), 'proceed',
  'an expired key no longer protects anything, even with a different request');
select lives_ok($$select private.idempotency_complete('POST /v1/test', 'key-aaaaaaaaaaaaaaaa', 200, '{}')$$, 'it can be completed again');

-- system role and anon cannot use the end-user functions; users cannot touch the tables
select pg_temp.as_system();
select throws_ok($$select * from private.idempotency_begin('POST /v1/test', 'key-cccccccccccccccc', repeat('a', 64))$$,
  '42501', null, 'the system role cannot use the end-user idempotency functions');
select pg_temp.as_staff('d1000000-0000-4000-8000-000000000001');
select throws_ok($$select * from ops.idempotency_keys$$, '42501', null, 'end users cannot read the idempotency table');
select throws_ok($$select ops.enqueue_event('x.y', '{}')$$, '42501', null, 'end users cannot enqueue events directly');
select throws_ok($$select * from ops.claim_outbox_events('w', 1, interval '30 seconds')$$, '42501', null, 'end users cannot claim events');

-- Outbox ---------------------------------------------------------------------------------------------------
select pg_temp.as_system();
create temp table t_ev (name text primary key, id uuid);
grant all on t_ev to public;
insert into t_ev select 'a', ops.enqueue_event('test.thing_happened', '{"ref":"r1"}', null, 'dedupe-key-0001');
select is(ops.enqueue_event('test.thing_happened', '{"ref":"r1"}', null, 'dedupe-key-0001'), (select id from t_ev where name = 'a'),
  'enqueueing the same business fact twice yields one event');
select throws_ok($$select ops.enqueue_event('test.thing_happened', '{"phone":"x"}')$$, '23514', null, 'a payload with a personal-data key is refused');
select throws_ok($$select ops.enqueue_event('test.thing_happened', '{"otp":"1"}')$$, '23514', null, 'a payload with an OTP key is refused');
select throws_ok($$select ops.enqueue_event('Bad Type', '{}')$$, '23514', null, 'a malformed event type is refused');
select throws_ok($$select ops.enqueue_event('test.big', jsonb_build_object('ref', repeat('x', 5000)))$$, '23514', null, 'an oversized payload is refused');

select is((select count(*)::int from ops.claim_outbox_events('worker-1', 5, interval '30 seconds')), 1, 'a worker claims the ready event');
select is((select attempts from ops.outbox_events where id = (select id from t_ev where name = 'a')), 1, 'the claim counts an attempt');
select is((select count(*)::int from ops.claim_outbox_events('worker-2', 5, interval '30 seconds')), 0, 'a second worker cannot claim a leased event');
select is(ops.complete_outbox_event((select id from t_ev where name = 'a'), 'worker-2'), false, 'a worker without the lease cannot complete it');
select is(ops.fail_outbox_event((select id from t_ev where name = 'a'), 'worker-1', 'handler_error'), 'pending'::ops.outbox_status,
  'a transient failure schedules a retry');
select is((select count(*)::int from ops.claim_outbox_events('worker-1', 5, interval '30 seconds')), 0, 'the retry waits for its backoff');
select pg_temp.as_owner();
update ops.outbox_events set available_at = now() - interval '1 second' where id = (select id from t_ev where name = 'a');
select pg_temp.as_system();
select is((select attempts from ops.claim_outbox_events('worker-1', 5, interval '30 seconds')), 2, 'after the backoff it is claimed again with a higher attempt count');
select is(ops.complete_outbox_event((select id from t_ev where name = 'a'), 'worker-1'), true, 'the lease holder completes it');
select is(ops.complete_outbox_event((select id from t_ev where name = 'a'), 'worker-1'), false, 'completing twice has no effect');

-- abandoned worker: the lease expires and another worker takes over
insert into t_ev select 'b', ops.enqueue_event('test.thing_happened', '{"ref":"r2"}', null, 'dedupe-key-0002');
select count(*) from ops.claim_outbox_events('worker-1', 5, interval '30 seconds');
select pg_temp.as_owner();
update ops.outbox_events set locked_until = now() - interval '1 second' where id = (select id from t_ev where name = 'b');
select pg_temp.as_system();
select is((select locked_by from ops.claim_outbox_events('worker-2', 5, interval '30 seconds')), 'worker-2', 'an abandoned event is taken over after its lease expires');
select pg_temp.as_owner();
update ops.outbox_events set locked_until = now() - interval '1 second' where id = (select id from t_ev where name = 'b');
select pg_temp.as_system();
select is(ops.complete_outbox_event((select id from t_ev where name = 'b'), 'worker-2'), false, 'a worker that lost its lease cannot complete the event');

-- retry limit and permanent failure
select pg_temp.as_owner();
update ops.outbox_events set max_attempts = 1 where id = (select id from t_ev where name = 'b');
select pg_temp.as_system();
select count(*) from ops.claim_outbox_events('worker-3', 5, interval '30 seconds');
select pg_temp.as_owner();
update ops.outbox_events set locked_until = now() - interval '1 second' where id = (select id from t_ev where name = 'b');
select pg_temp.as_system();
select count(*) from ops.claim_outbox_events('worker-4', 5, interval '30 seconds');
select is((select status::text from ops.outbox_events where id = (select id from t_ev where name = 'b')), 'dead',
  'an event that keeps being abandoned becomes dead after its last attempt');

insert into t_ev select 'c', ops.enqueue_event('test.thing_happened', '{"ref":"r3"}', null, 'dedupe-key-0003');
select count(*) from ops.claim_outbox_events('worker-1', 5, interval '30 seconds');
select throws_ok($$select ops.fail_outbox_event((select id from t_ev where name = 'c'), 'worker-1', 'Contains PII: 9876543210', true)$$,
  '23514', null, 'free-text error messages cannot be stored');
select is(ops.fail_outbox_event((select id from t_ev where name = 'c'), 'worker-1', 'invalid_payload', true), 'dead'::ops.outbox_status,
  'a permanent failure goes straight to the dead state');
select is((select last_error_code from ops.outbox_events where id = (select id from t_ev where name = 'c')), 'invalid_payload', 'only a short error code is kept');
select is(ops.requeue_dead_event((select id from t_ev where name = 'c')), true, 'a dead event can be replayed by an operator');
select is((select attempts from ops.outbox_events where id = (select id from t_ev where name = 'c')), 0, 'replay resets the attempts');

-- approving a change request enqueues its application in the same transaction
select pg_temp.as_staff('d1000000-0000-4000-8000-000000000001');
create temp table t_cr (id uuid);
grant all on t_cr to public;
insert into t_cr select private.request_change('membership.suspend', 'd2000000-0000-4000-8000-000000000000',
  '{"membership_id":"d1d10000-0000-4000-8000-000000000003"}', 'key-suspend-0000001');
select pg_temp.as_staff('d1000000-0000-4000-8000-000000000002');
select private.decide_change_request((select id from t_cr), true);
select pg_temp.as_system();
select is((select count(*)::int from ops.outbox_events where event_type = 'change_request.approved'
           and payload ->> 'change_request_id' = (select id::text from t_cr)), 1, 'approval enqueued exactly one application event');
select is((select dedupe_key from ops.outbox_events where event_type = 'change_request.approved'
           and payload ->> 'change_request_id' = (select id::text from t_cr)), 'change_request.approved:' || (select id::text from t_cr),
  'the event is deduplicated on the request id');

-- retention
select pg_temp.as_owner();
update ops.outbox_events set completed_at = now() - interval '40 days' where id = (select id from t_ev where name = 'a');
select pg_temp.as_system();
select is(ops.purge_completed_events(interval '30 days', 100), 1, 'old completed events are purged');
select is(ops.purge_expired_idempotency(100) >= 0, true, 'expired idempotency records can be purged');

-- A record left open at commit time is refused (deferred constraint)
select pg_temp.as_staff('d1000000-0000-4000-8000-000000000001');
select * from private.idempotency_begin('POST /v1/open', 'key-dddddddddddddddd', repeat('d', 64));
select pg_temp.as_owner();
select throws_ok($$set constraints all immediate$$, '55000', null, 'an idempotency record cannot commit without a stored response');

select * from finish();
rollback;
