-- =============================================================================================
-- Phase 03: durable idempotency store and transactional outbox (spec: docs/specs/03-application-foundation.md).
--
-- Schema `ops` holds platform plumbing, not business data. Only the system role touches the tables
-- directly. End users reach idempotency only through two SECURITY DEFINER functions that use the
-- caller's own identity (auth.uid()), never a caller-supplied principal.
--
-- Delivery is AT LEAST ONCE. Handlers must be idempotent. Nothing here claims exactly-once.
-- =============================================================================================

create schema if not exists ops;
revoke all on schema ops from public, anon, authenticated;
grant usage on schema ops to service_role;
alter default privileges in schema ops revoke all on tables from public, anon, authenticated;
alter default privileges in schema ops grant all on tables to service_role;
alter default privileges in schema ops revoke truncate on tables from service_role;
alter default privileges in schema ops revoke all on functions from public, anon, authenticated;

-- 1. Idempotency ----------------------------------------------------------------------------------
-- A row exists only for requests whose domain write COMMITTED (the row is inserted and completed in
-- the same transaction as the write). A concurrent duplicate blocks on the unique index until the
-- first transaction ends, then replays the stored result; if the first rolled back, it proceeds.
create table ops.idempotency_keys (
  id uuid primary key default private.uuid_v7(),
  principal_id uuid not null,
  route text not null check (length(route) between 3 and 200),
  idem_key text not null check (length(idem_key) between 16 and 128 and idem_key ~ '^[A-Za-z0-9._:-]+$'),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  tenant_org_id uuid,
  response_status integer check (response_status between 200 and 299),
  -- Replayed verbatim. Responses stored here must never contain personal data (documented rule).
  response_body jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  unique (principal_id, route, idem_key)
);
create index idempotency_keys_expiry on ops.idempotency_keys (expires_at);
comment on table ops.idempotency_keys is
  'Durable idempotency records scoped by principal and route. Written only by private.idempotency_*; purged after expiry.';
alter table ops.idempotency_keys enable row level security;
alter table ops.idempotency_keys force row level security;

-- A row must be completed before its transaction commits; otherwise the key would be stuck forever.
create or replace function ops.require_idempotency_completed()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.response_status is null then
    raise exception 'idempotency record committed without a stored response' using errcode = '55000';
  end if;
  return null;
end
$$;
create constraint trigger idempotency_completed after insert on ops.idempotency_keys
  deferrable initially deferred for each row execute function ops.require_idempotency_completed();
create trigger no_truncate before truncate on ops.idempotency_keys
  for each statement execute function private.forbid_truncate();

create or replace function private.idempotency_begin(
  p_route text,
  p_key text,
  p_request_hash text,
  p_tenant uuid default null,
  p_ttl interval default interval '24 hours'
)
returns table (outcome text, response_status integer, response_body jsonb)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_principal uuid := (select auth.uid());
  v_id uuid;
  v_row ops.idempotency_keys;
begin
  if v_principal is null or private.is_system_role() then
    raise exception 'idempotency requires an authenticated end user' using errcode = '42501';
  end if;
  if p_ttl < interval '1 minute' or p_ttl > interval '7 days' then
    raise exception 'invalid idempotency retention' using errcode = '22023';
  end if;

  -- An expired record no longer protects anything.
  delete from ops.idempotency_keys k
  where k.principal_id = v_principal and k.route = p_route and k.idem_key = p_key and k.expires_at <= now();

  insert into ops.idempotency_keys as k (principal_id, route, idem_key, request_hash, tenant_org_id, expires_at)
  values (v_principal, p_route, p_key, p_request_hash, p_tenant, now() + p_ttl)
  on conflict (principal_id, route, idem_key) do nothing
  returning k.id into v_id;
  if v_id is not null then
    return query select 'proceed'::text, null::integer, null::jsonb;
    return;
  end if;

  select * into v_row from ops.idempotency_keys k
  where k.principal_id = v_principal and k.route = p_route and k.idem_key = p_key;
  if v_row.request_hash <> p_request_hash then
    raise exception 'idempotency key was already used with a different request' using errcode = 'IK409';
  end if;
  return query select 'replay'::text, v_row.response_status, v_row.response_body;
end
$$;
revoke all on function private.idempotency_begin(text, text, text, uuid, interval) from public;
grant execute on function private.idempotency_begin(text, text, text, uuid, interval) to authenticated;

create or replace function private.idempotency_complete(p_route text, p_key text, p_status integer, p_body jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_principal uuid := (select auth.uid());
  v_rows integer;
begin
  if v_principal is null or private.is_system_role() then
    raise exception 'idempotency requires an authenticated end user' using errcode = '42501';
  end if;
  update ops.idempotency_keys k set response_status = p_status, response_body = p_body
  where k.principal_id = v_principal and k.route = p_route and k.idem_key = p_key and k.response_status is null;
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception 'no open idempotency record to complete' using errcode = '55000';
  end if;
end
$$;
revoke all on function private.idempotency_complete(text, text, integer, jsonb) from public;
grant execute on function private.idempotency_complete(text, text, integer, jsonb) to authenticated;

create or replace function ops.purge_expired_idempotency(p_limit integer default 1000)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_rows integer;
begin
  with doomed as (
    select id from ops.idempotency_keys where expires_at <= now() order by expires_at limit least(greatest(p_limit, 1), 10000)
    for update skip locked
  )
  delete from ops.idempotency_keys k using doomed where k.id = doomed.id;
  get diagnostics v_rows = row_count;
  return v_rows;
end
$$;
revoke all on function ops.purge_expired_idempotency(integer) from public;
grant execute on function ops.purge_expired_idempotency(integer) to service_role;

-- 2. Outbox ---------------------------------------------------------------------------------------
create type ops.outbox_status as enum ('pending', 'processing', 'completed', 'dead');

-- Payloads carry references (ids), never secrets or personal data. The check below is a backstop
-- against the commonest mistakes, not a substitute for review.
create or replace function ops.payload_is_safe(p jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(p) = 'object'
     and length(p::text) <= 4096
     and not exists (
       select 1 from jsonb_object_keys(p) k
       where lower(k) ~ '(otp|password|passwd|secret|token|aadhaar|aadhar|pan|account_?number|phone|mobile|email|name|dob|address|card)'
     )
$$;

grant execute on function ops.payload_is_safe(jsonb) to service_role;

create table ops.outbox_events (
  id uuid primary key default private.uuid_v7(),
  event_type text not null check (event_type ~ '^[a-z0-9_]+(\.[a-z0-9_]+)+$' and length(event_type) <= 100),
  payload jsonb not null default '{}'::jsonb check (ops.payload_is_safe(payload)),
  payload_version integer not null default 1 check (payload_version > 0),
  correlation_id uuid,
  -- Enqueue-side deduplication: the same business fact enqueued twice yields one event.
  dedupe_key text unique check (dedupe_key is null or length(dedupe_key) between 8 and 200),
  status ops.outbox_status not null default 'pending',
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 8 check (max_attempts between 1 and 50),
  available_at timestamptz not null default now(),
  locked_by text check (locked_by is null or locked_by ~ '^[A-Za-z0-9._:-]{1,80}$'),
  locked_until timestamptz,
  last_error_code text check (last_error_code is null or last_error_code ~ '^[a-z0-9_.-]{1,64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint processing_has_lease check (status <> 'processing' or (locked_by is not null and locked_until is not null)),
  constraint completed_has_time check (status <> 'completed' or completed_at is not null)
);
create index outbox_events_ready on ops.outbox_events (available_at, id) where status = 'pending';
create index outbox_events_leases on ops.outbox_events (locked_until) where status = 'processing';
create index outbox_events_dead on ops.outbox_events (updated_at) where status = 'dead';
comment on table ops.outbox_events is
  'Transactional outbox: rows are created in the same transaction as the business change. At-least-once delivery; handlers must be idempotent.';
alter table ops.outbox_events enable row level security;
alter table ops.outbox_events force row level security;
create trigger outbox_events_set_updated_at before update on ops.outbox_events
  for each row execute function private.set_updated_at();
create trigger no_truncate before truncate on ops.outbox_events
  for each statement execute function private.forbid_truncate();

create or replace function ops.enqueue_event(
  p_type text,
  p_payload jsonb,
  p_correlation uuid default null,
  p_dedupe_key text default null,
  p_available_at timestamptz default null,
  p_payload_version integer default 1
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into ops.outbox_events (event_type, payload, payload_version, correlation_id, dedupe_key, available_at)
  values (p_type, coalesce(p_payload, '{}'::jsonb), p_payload_version, p_correlation, p_dedupe_key, coalesce(p_available_at, now()))
  on conflict (dedupe_key) do nothing
  returning id into v_id;
  if v_id is null then
    select e.id into v_id from ops.outbox_events e where e.dedupe_key = p_dedupe_key;
  end if;
  return v_id;
end
$$;
revoke all on function ops.enqueue_event(text, jsonb, uuid, text, timestamptz, integer) from public;
grant execute on function ops.enqueue_event(text, jsonb, uuid, text, timestamptz, integer) to service_role;

-- Claims up to p_batch ready events for p_worker for p_lease. Events whose lease expired (the
-- worker died) are claimed again; ones that have used all attempts become dead instead.
create or replace function ops.claim_outbox_events(p_worker text, p_batch integer, p_lease interval)
returns setof ops.outbox_events
language plpgsql
set search_path = ''
as $$
begin
  if p_batch < 1 or p_batch > 100 or p_lease < interval '5 seconds' or p_lease > interval '1 hour' then
    raise exception 'invalid claim parameters' using errcode = '22023';
  end if;
  update ops.outbox_events e
  set status = 'dead', last_error_code = 'lease_expired', locked_by = null, locked_until = null
  where e.status = 'processing' and e.locked_until < now() and e.attempts >= e.max_attempts;

  return query
  with picked as (
    select e.id from ops.outbox_events e
    where (e.status = 'pending' and e.available_at <= now())
       or (e.status = 'processing' and e.locked_until < now())
    order by e.available_at, e.id
    limit p_batch
    for update skip locked
  )
  update ops.outbox_events e
  set status = 'processing', attempts = e.attempts + 1, locked_by = p_worker, locked_until = now() + p_lease
  from picked where e.id = picked.id
  returning e.*;
end
$$;
revoke all on function ops.claim_outbox_events(text, integer, interval) from public;
grant execute on function ops.claim_outbox_events(text, integer, interval) to service_role;

-- Only the worker that still holds the lease may finish an event; a worker that lost its lease
-- gets false and must not assume its work counted.
create or replace function ops.complete_outbox_event(p_id uuid, p_worker text)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_rows integer;
begin
  update ops.outbox_events e
  set status = 'completed', completed_at = now(), locked_by = null, locked_until = null, last_error_code = null
  where e.id = p_id and e.status = 'processing' and e.locked_by = p_worker and e.locked_until >= now();
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end
$$;
revoke all on function ops.complete_outbox_event(uuid, text) from public;
grant execute on function ops.complete_outbox_event(uuid, text) to service_role;

-- Exponential backoff (5s, 10s, 20s, ... capped at 1h) with +/-20% jitter. A permanent failure, or the
-- last attempt, makes the event dead (the dead-letter state, kept for inspection and manual replay).
create or replace function ops.fail_outbox_event(p_id uuid, p_worker text, p_error_code text, p_permanent boolean default false)
returns ops.outbox_status
language plpgsql
set search_path = ''
as $$
declare
  v_e ops.outbox_events;
  v_delay double precision;
  v_new ops.outbox_status;
begin
  select * into v_e from ops.outbox_events e
  where e.id = p_id and e.status = 'processing' and e.locked_by = p_worker for update;
  if not found then
    return null;
  end if;
  if p_permanent or v_e.attempts >= v_e.max_attempts then
    v_new := 'dead';
    update ops.outbox_events e set status = 'dead', last_error_code = p_error_code, locked_by = null, locked_until = null
    where e.id = p_id;
  else
    v_new := 'pending';
    v_delay := least(3600, 5 * power(2, v_e.attempts - 1)) * (0.8 + random() * 0.4);
    update ops.outbox_events e
    set status = 'pending', last_error_code = p_error_code, locked_by = null, locked_until = null,
        available_at = now() + make_interval(secs => v_delay)
    where e.id = p_id;
  end if;
  return v_new;
end
$$;
revoke all on function ops.fail_outbox_event(uuid, text, text, boolean) from public;
grant execute on function ops.fail_outbox_event(uuid, text, text, boolean) to service_role;

-- Manual replay of a dead event after the cause is fixed (operations runbook).
create or replace function ops.requeue_dead_event(p_id uuid)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_rows integer;
begin
  update ops.outbox_events e
  set status = 'pending', attempts = 0, available_at = now(), last_error_code = null
  where e.id = p_id and e.status = 'dead';
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end
$$;
revoke all on function ops.requeue_dead_event(uuid) from public;
grant execute on function ops.requeue_dead_event(uuid) to service_role;

create or replace function ops.purge_completed_events(p_older interval default interval '30 days', p_limit integer default 1000)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_rows integer;
begin
  with doomed as (
    select id from ops.outbox_events where status = 'completed' and completed_at < now() - p_older
    order by completed_at limit least(greatest(p_limit, 1), 10000) for update skip locked
  )
  delete from ops.outbox_events e using doomed where e.id = doomed.id;
  get diagnostics v_rows = row_count;
  return v_rows;
end
$$;
revoke all on function ops.purge_completed_events(interval, integer) from public;
grant execute on function ops.purge_completed_events(interval, integer) to service_role;

-- 3. Approving a change request now enqueues its application in the SAME transaction --------------
-- (Phase 02 applied it from the request handler; a crash between decision and application left it
-- approved but unapplied. The outbox event makes application durable and retryable.)
create or replace function private.decide_change_request(p_id uuid, p_approve boolean, p_note text default null)
returns tenancy.change_request_status
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_actor text := private.current_actor();
  v_req tenancy.change_requests;
  v_new tenancy.change_request_status;
begin
  perform private.require_aal2();
  if v_actor not in ('platform', 'lender') then
    raise exception 'only staff can decide change requests' using errcode = '42501';
  end if;
  select * into v_req from tenancy.change_requests where id = p_id for update;
  if not found then
    raise exception 'change request not found' using errcode = 'P0002';
  end if;
  if not private.can_handle_change(v_user, v_req.request_type, v_req.target_org_id) then
    raise exception 'change request not found' using errcode = 'P0002';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'change request is already %', v_req.status using errcode = '55000';
  end if;
  if v_req.requested_by = v_user then
    raise exception 'segregation of duties: you cannot decide your own request' using errcode = '42501';
  end if;
  if v_req.expires_at <= now() then
    update tenancy.change_requests set status = 'expired' where id = p_id;
    return 'expired';
  end if;

  v_new := case when p_approve then 'approved' else 'rejected' end;
  update tenancy.change_requests
  set status = v_new, decided_by = v_user, decided_at = now(), decision_note = p_note
  where id = p_id;
  perform private.write_admin_audit(case v_actor when 'platform' then 'platform' else 'staff' end::audit.actor_type,
    v_user, v_req.target_org_id, 'change_request.' || v_new::text, p_id,
    jsonb_build_object('type', v_req.request_type, 'requested_by', v_req.requested_by));
  if p_approve then
    perform ops.enqueue_event('change_request.approved', jsonb_build_object('change_request_id', p_id),
      null, 'change_request.approved:' || p_id::text);
  end if;
  return v_new;
end
$$;
