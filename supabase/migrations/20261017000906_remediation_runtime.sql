-- =============================================================================================
-- Remediation (Phase 01 audit F-01, F-06): runtime hardening of the request path.
--
--   1. private.session_is_active(session)  Is the session behind an access token still alive?
--      The API calls it on every authenticated request, so a signed-out or revoked session is
--      refused immediately instead of living until the access token expires (audit F-01).
--   2. ops.seen_webhooks + private.mark_webhook_seen(source, id)  A durable "first delivery only"
--      guard for signed webhooks, shared by every API instance (audit F-06). The previous guard
--      was an in-process map, so a replay that reached another instance went through.
--   3. ops.purge_seen_webhooks(retention, limit)  Housekeeping for (2), called by the worker.
--
-- Forward-only. No data is migrated: both tables start empty.
-- =============================================================================================

-- 1. Session liveness ------------------------------------------------------------------------------
-- Reads Supabase Auth's own session table, which is the source of truth for sign-out and revocation.
-- The user is NOT a parameter: it is always the caller (auth.uid()), so this function cannot be used
-- to ask whether somebody else's session id exists. Lookup is by the primary key of auth.sessions.
-- `not_after` is the session time-box Supabase Auth maintains (null = no time-box).
create or replace function private.session_is_active(p_session uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from auth.sessions s
    where s.id = p_session
      and s.user_id = (select auth.uid())
      and (s.not_after is null or s.not_after > now())
  )
$$;
revoke all on function private.session_is_active(uuid) from public;
grant execute on function private.session_is_active(uuid) to authenticated;
comment on function private.session_is_active(uuid) is
  'True when the caller (auth.uid()) still has this unexpired session in auth.sessions. Called by the API on every authenticated request (audit F-01). Never reveals anyone else''s sessions.';

-- 2. Webhook de-duplication ------------------------------------------------------------------------
create table ops.seen_webhooks (
  source text not null check (source ~ '^[a-z][a-z0-9_]{2,39}$'),
  message_id text not null check (length(message_id) between 4 and 200 and message_id ~ '^[A-Za-z0-9._:=+/-]+$'),
  seen_at timestamptz not null default now(),
  primary key (source, message_id)
);
create index seen_webhooks_seen_at on ops.seen_webhooks (seen_at);
comment on table ops.seen_webhooks is
  'Message ids of signature-verified webhooks already accepted, per source (for example the Supabase Send-SMS hook), so a captured delivery cannot be replayed on another API instance. Holds ids only, never payloads. Written by private.mark_webhook_seen; purged by ops.purge_seen_webhooks. Platform plumbing: not tenant data.';
alter table ops.seen_webhooks enable row level security;
alter table ops.seen_webhooks force row level security;
create trigger no_truncate before truncate on ops.seen_webhooks
  for each statement execute function private.forbid_truncate();

-- Explicit grants. Only the system role can read or delete (housekeeping); nobody can write directly,
-- and the API reaches the table only through the definer function below.
revoke all on ops.seen_webhooks from public, anon, authenticated;
revoke insert, update, references, trigger on ops.seen_webhooks from service_role;
grant select, delete on ops.seen_webhooks to service_role;

-- Why this lives in `private` and is callable by `authenticated`: the public API process must not hold
-- the system login (src/system and src/workers only; boundary test), and the Send-SMS hook has no end
-- user. The API therefore runs this one call as role `authenticated` WITHOUT end-user claims. To keep
-- that narrow, the function refuses any call that carries a user identity: a signed-in user (or a stolen
-- token) can never use it to pre-mark a message id and so block a real delivery.
create or replace function private.mark_webhook_seen(p_source text, p_id text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rows integer;
begin
  if (select auth.uid()) is not null then
    raise exception 'webhook de-duplication is for unauthenticated hooks only' using errcode = '42501';
  end if;
  if p_source is null or p_source !~ '^[a-z][a-z0-9_]{2,39}$'
     or p_id is null or length(p_id) not between 4 and 200 or p_id !~ '^[A-Za-z0-9._:=+/-]+$' then
    raise exception 'invalid webhook source or message id' using errcode = '22023';
  end if;
  -- The primary key arbitrates concurrent deliveries across every instance: exactly one insert wins.
  insert into ops.seen_webhooks (source, message_id) values (p_source, p_id)
  on conflict (source, message_id) do nothing;
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end
$$;
revoke all on function private.mark_webhook_seen(text, text) from public;
grant execute on function private.mark_webhook_seen(text, text) to authenticated;
comment on function private.mark_webhook_seen(text, text) is
  'True only the first time a (source, message id) pair is seen; false for a repeat. Refuses calls that carry a user identity. Durable and shared by all API instances (audit F-06).';

-- 3. Retention -------------------------------------------------------------------------------------
-- The retention must stay longer than the signature timestamp window (5 minutes) or a replay inside the
-- window would be accepted again; 15 minutes is the floor.
create or replace function ops.purge_seen_webhooks(p_older_than interval default interval '1 day', p_limit integer default 1000)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_rows integer;
begin
  if p_older_than < interval '15 minutes' then
    raise exception 'webhook de-duplication retention must be at least 15 minutes' using errcode = '22023';
  end if;
  with doomed as (
    select source, message_id from ops.seen_webhooks
    where seen_at <= now() - p_older_than
    order by seen_at
    limit least(greatest(p_limit, 1), 10000)
  )
  delete from ops.seen_webhooks w using doomed d
  where w.source = d.source and w.message_id = d.message_id;
  get diagnostics v_rows = row_count;
  return v_rows;
end
$$;
revoke all on function ops.purge_seen_webhooks(interval, integer) from public;
grant execute on function ops.purge_seen_webhooks(interval, integer) to service_role;
comment on function ops.purge_seen_webhooks(interval, integer) is
  'Deletes webhook de-duplication rows older than the retention (minimum 15 minutes). Called by the worker housekeeping loop.';
