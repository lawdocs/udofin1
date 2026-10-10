-- =============================================================================================
-- Borrower identity (minimal), consent ledger and tamper-evident audit trail.
--
-- Data minimisation: RBI's digital lending rules allow an LSP to retain only basic minimal data
-- (e.g. name, address, contact details) needed for its operations, and prohibit storing biometric
-- data. Identity documents, KYC results and bureau reports are the LENDER's records: they will live
-- in lender-scoped tables (lender_org_id) with per-lender encryption keys (Phase 5/6), not here.
-- The borrower's phone number stays in auth.users (Supabase Auth); this table holds no identifiers.
-- =============================================================================================

create type identity.borrower_status as enum ('active', 'locked', 'closure_requested', 'closed');

create table identity.borrowers (
  id uuid primary key default private.uuid_v7(),
  user_id uuid not null unique references auth.users (id) on delete restrict,
  status identity.borrower_status not null default 'active',
  preferred_language text not null default 'en' check (preferred_language ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table identity.borrowers is
  'Borrower account. Deliberately holds no PAN, Aadhaar, DOB or document data. Owner: identity module.';
create trigger borrowers_set_updated_at before update on identity.borrowers
  for each row execute function private.set_updated_at();

-- Returns the borrower id of the current user, or NULL for staff/anonymous callers.
create or replace function private.my_borrower_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select b.id from identity.borrowers b where b.user_id = (select auth.uid())
$$;
revoke all on function private.my_borrower_id() from public;
grant execute on function private.my_borrower_id() to authenticated, service_role;

-- Every new Supabase Auth user becomes a borrower unless the server created it as staff.
-- `app_metadata` (raw_app_meta_data) can only be set with the service key, never by the client.
create or replace function private.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(new.raw_app_meta_data ->> 'actor_type', 'borrower') = 'borrower' then
    insert into identity.borrowers (user_id) values (new.id) on conflict (user_id) do nothing;
  end if;
  return new;
end
$$;
revoke all on function private.handle_new_auth_user() from public;

-- Named distinctly from Supabase's quick-start trigger (`on_auth_user_created`) so it cannot
-- collide with a pre-existing prototype trigger on the same project.
create trigger udofin_create_borrower_on_signup
  after insert on auth.users
  for each row execute function private.handle_new_auth_user();

alter table identity.borrowers enable row level security;
alter table identity.borrowers force row level security;

create policy borrowers_self_read on identity.borrowers for select to authenticated
  using (user_id = (select auth.uid()));
-- Borrowers may change only their language preference; status changes are server-side workflows.
create policy borrowers_self_update on identity.borrowers for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

grant select on identity.borrowers to authenticated;
grant update (preferred_language) on identity.borrowers to authenticated;

-- =============================================================================================
-- Consent ledger.
-- A notice is the exact text shown to the borrower, versioned and immutable once published.
-- A consent record is an append-only fact: who decided what, for which purpose and lender, when,
-- through which channel, against which notice version. Withdrawal is a new record, never an edit.
-- =============================================================================================

create type consent.notice_status as enum ('draft', 'published', 'retired');
create type consent.decision as enum ('granted', 'denied', 'withdrawn');
create type consent.channel as enum ('mobile_app', 'web', 'assisted');

create table consent.notices (
  id uuid primary key default private.uuid_v7(),
  -- Purpose key, e.g. 'bureau_enquiry', 'kyc_verification', 'share_with_lenders', 'marketing'.
  purpose text not null check (purpose ~ '^[a-z_]+$'),
  version integer not null check (version > 0),
  language text not null check (language ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  -- NULL for platform notices; set when the wording is specific to one lender.
  lender_org_id uuid references tenancy.organizations (id),
  title text not null,
  body_markdown text not null,
  -- SHA-256 of body_markdown (set by trigger), so evidence can prove exactly which words were shown.
  body_sha256 text not null default '',
  data_categories text[] not null default '{}',
  retention_summary text not null default '',
  status consent.notice_status not null default 'draft',
  published_at timestamptz,
  approved_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  constraint published_has_metadata check (status = 'draft' or (published_at is not null and approved_by is not null))
);
create unique index notices_version on consent.notices (purpose, language, coalesce(lender_org_id, '00000000-0000-0000-0000-000000000000'::uuid), version);

-- Published notice text can never change; only the draft -> published -> retired status flow.
create or replace function private.protect_published_notice()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception 'published consent notices cannot be deleted' using errcode = 'P0001';
    end if;
    return old;
  end if;
  new.body_sha256 := encode(sha256(convert_to(new.body_markdown, 'UTF8')), 'hex');
  if tg_op = 'INSERT' then
    return new;
  end if;
  if old.status <> 'draft' then
    if (new.purpose, new.version, new.language, new.lender_org_id, new.title, new.body_markdown,
        new.data_categories, new.retention_summary, new.published_at, new.approved_by)
       is distinct from
       (old.purpose, old.version, old.language, old.lender_org_id, old.title, old.body_markdown,
        old.data_categories, old.retention_summary, old.published_at, old.approved_by) then
      raise exception 'published consent notices are immutable; create a new version' using errcode = 'P0001';
    end if;
    if not (old.status = 'published' and new.status in ('published', 'retired'))
       and not (old.status = 'retired' and new.status = 'retired') then
      raise exception 'invalid notice status change % -> %', old.status, new.status using errcode = 'P0001';
    end if;
  end if;
  return new;
end
$$;
create trigger notices_protect before insert or update or delete on consent.notices
  for each row execute function private.protect_published_notice();

create table consent.records (
  id uuid primary key default private.uuid_v7(),
  borrower_id uuid not null references identity.borrowers (id) on delete restrict,
  notice_id uuid not null references consent.notices (id) on delete restrict,
  -- The lender this consent authorises data sharing with, when the purpose is lender-specific.
  lender_org_id uuid references tenancy.organizations (id),
  decision consent.decision not null,
  channel consent.channel not null,
  captured_at timestamptz not null default now(),
  app_version text,
  -- Context needed to prove the consent (screen id, request id). Never identity numbers.
  evidence jsonb not null default '{}'::jsonb,
  -- Assisted journeys: the staff member who captured the borrower's decision.
  captured_by uuid references auth.users (id)
);
create index records_borrower_notice on consent.records (borrower_id, notice_id, captured_at desc);
create index records_lender on consent.records (lender_org_id) where lender_org_id is not null;
comment on table consent.records is 'Append-only consent ledger. Owner: consent module.';

-- Consent can only be recorded against a published notice.
create or replace function private.check_consent_notice_published()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (select 1 from consent.notices n where n.id = new.notice_id and n.status = 'published') then
    raise exception 'consent must reference a published notice' using errcode = '23514';
  end if;
  return new;
end
$$;
create trigger records_require_published before insert on consent.records
  for each row execute function private.check_consent_notice_published();
create trigger records_append_only before update or delete on consent.records
  for each row execute function private.forbid_mutation();

-- Latest decision per (borrower, purpose, lender) — what the system must honour right now.
create view consent.current_decisions with (security_invoker = true) as
select distinct on (r.borrower_id, n.purpose, r.lender_org_id)
  r.borrower_id, n.purpose, r.lender_org_id, r.decision, r.captured_at, r.notice_id, n.version as notice_version
from consent.records r
join consent.notices n on n.id = r.notice_id
order by r.borrower_id, n.purpose, r.lender_org_id, r.captured_at desc, r.id desc;

alter table consent.notices enable row level security;
alter table consent.records enable row level security;
alter table consent.records force row level security;

create policy notices_read_published on consent.notices for select to authenticated
  using (status <> 'draft' or (select private.has_platform_permission('platform.consent_notices.manage')));

create policy records_borrower_read on consent.records for select to authenticated
  using (borrower_id = (select private.my_borrower_id()));
create policy records_lender_read on consent.records for select to authenticated
  using (lender_org_id in (select private.orgs_with_permission('application.read')));
create policy records_borrower_insert on consent.records for insert to authenticated
  with check (borrower_id = (select private.my_borrower_id()) and channel <> 'assisted' and captured_by is null);

grant select on consent.notices to authenticated;
grant select, insert on consent.records to authenticated;
grant select on consent.current_decisions to authenticated;

-- =============================================================================================
-- Audit trail.
-- Append-only. Each row stores a SHA-256 hash of its own content; periodic anchors store a digest
-- over ordered ranges of row hashes and are exported outside the database (write-once storage /
-- LawDocsComply), so deletion or alteration — even by a database superuser — becomes detectable.
-- Metadata must never contain personal data or identity numbers.
-- =============================================================================================

create type audit.actor_type as enum ('borrower', 'staff', 'system', 'partner');
create type audit.outcome as enum ('success', 'denied', 'failure');

create table audit.events (
  id uuid primary key default private.uuid_v7(),
  occurred_at timestamptz not null default clock_timestamp(),
  actor_type audit.actor_type not null,
  actor_user_id uuid,
  actor_org_id uuid,
  tenant_org_id uuid,
  action text not null check (action ~ '^[a-z_]+(\.[a-z_]+)+$'),
  entity_type text not null,
  entity_id text,
  outcome audit.outcome not null default 'success',
  request_id text,
  correlation_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  row_hash text not null
);
create index events_tenant_time on audit.events (tenant_org_id, occurred_at desc);
create index events_entity on audit.events (entity_type, entity_id);
create index events_time on audit.events (occurred_at, id);
comment on table audit.events is 'Append-only, hash-stamped audit trail. Owner: audit module.';

create or replace function private.audit_row_hash(e audit.events)
returns text
language sql
stable
set search_path = ''
as $$
  select encode(sha256(convert_to(concat_ws('|',
    e.id::text, to_char(e.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
    e.actor_type::text, e.actor_user_id::text, e.actor_org_id::text, e.tenant_org_id::text,
    e.action, e.entity_type, e.entity_id, e.outcome::text, e.request_id, e.correlation_id::text,
    e.metadata::text), 'UTF8')), 'hex')
$$;

grant execute on function private.audit_row_hash(audit.events) to authenticated, service_role;

create or replace function private.stamp_audit_row()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.row_hash := private.audit_row_hash(new);
  return new;
end
$$;
create trigger events_stamp before insert on audit.events
  for each row execute function private.stamp_audit_row();
create trigger events_append_only before update or delete on audit.events
  for each row execute function private.forbid_mutation();

create table audit.anchors (
  id uuid primary key default private.uuid_v7(),
  range_start timestamptz not null,
  range_end timestamptz not null,
  event_count bigint not null,
  digest text not null,
  created_at timestamptz not null default now(),
  -- Where the digest was exported (e.g. object-lock bucket key); filled by the anchoring job.
  exported_ref text,
  check (range_end > range_start)
);
create trigger anchors_append_only before update or delete on audit.anchors
  for each row execute function private.forbid_mutation();

-- Recomputes the digest over [p_from, p_to). Verification compares it with the stored anchor.
-- Each row's hash is recomputed from its content, so editing a row is detected even if the
-- attacker also rewrote row_hash.
create or replace function private.audit_digest(p_from timestamptz, p_to timestamptz)
returns table (event_count bigint, digest text)
language sql
stable
set search_path = ''
as $$
  select count(*),
         encode(sha256(convert_to(coalesce(string_agg(private.audit_row_hash(e), '' order by e.occurred_at, e.id), ''), 'UTF8')), 'hex')
  from audit.events e
  where e.occurred_at >= p_from and e.occurred_at < p_to
$$;
revoke all on function private.audit_digest(timestamptz, timestamptz) from public;
grant execute on function private.audit_digest(timestamptz, timestamptz) to service_role;

-- The only way user-context code writes audit events: the actor is derived from the session,
-- so a caller cannot forge who did something.
create or replace function private.record_audit_event(
  p_action text,
  p_entity_type text,
  p_entity_id text,
  p_tenant_org_id uuid default null,
  p_outcome audit.outcome default 'success',
  p_metadata jsonb default '{}'::jsonb,
  p_request_id text default null,
  p_correlation_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_actor audit.actor_type;
  v_actor_org uuid;
  v_id uuid;
begin
  if v_user is null then
    raise exception 'record_audit_event requires an authenticated user' using errcode = '42501';
  end if;
  if exists (select 1 from identity.borrowers b where b.user_id = v_user) then
    v_actor := 'borrower';
  else
    v_actor := 'staff';
    -- Attribute to the platform org if the user is platform staff, else to the tenant org itself.
    select m.org_id into v_actor_org
    from tenancy.memberships m join tenancy.organizations o on o.id = m.org_id
    where m.user_id = v_user and m.status = 'active'
    order by (o.kind = 'platform') desc, (m.org_id = p_tenant_org_id) desc
    limit 1;
  end if;

  insert into audit.events (actor_type, actor_user_id, actor_org_id, tenant_org_id, action, entity_type,
                            entity_id, outcome, request_id, correlation_id, metadata)
  values (v_actor, v_user, v_actor_org, p_tenant_org_id, p_action, p_entity_type, p_entity_id, p_outcome,
          p_request_id, p_correlation_id, coalesce(p_metadata, '{}'::jsonb))
  returning id into v_id;
  return v_id;
end
$$;
revoke all on function private.record_audit_event(text, text, text, uuid, audit.outcome, jsonb, text, uuid) from public;
grant execute on function private.record_audit_event(text, text, text, uuid, audit.outcome, jsonb, text, uuid)
  to authenticated, service_role;

alter table audit.events enable row level security;
alter table audit.events force row level security;
alter table audit.anchors enable row level security;
alter table audit.anchors force row level security;

create policy events_read on audit.events for select to authenticated
  using (
    tenant_org_id in (select private.orgs_with_permission('audit.read'))
    or (tenant_org_id is null and (select private.has_platform_permission('audit.read')))
  );
create policy anchors_read on audit.anchors for select to authenticated
  using ((select private.has_platform_permission('audit.read')));

-- No INSERT/UPDATE/DELETE grants: user-context writes go through private.record_audit_event().
grant select on audit.events, audit.anchors to authenticated;
