-- =============================================================================================
-- Two-person change control (spec: docs/specs/02-database-security.md, W2; ADR 0025).
--
-- Changes that decide who may act for whom — creating or activating an organisation, adding or
-- suspending a staff member, granting or revoking a role, publishing consent wording — happen only
-- through a change request: one person requests, a DIFFERENT person who also holds the relevant
-- permission approves, and the system applies it in one transaction together with its audit event.
-- Direct writes to organisations, memberships and role grants by application code are refused.
-- =============================================================================================

create type tenancy.change_request_type as enum (
  'organization.create', 'organization.activate', 'membership.invite', 'membership.suspend',
  'role.grant', 'role.revoke', 'consent_notice.publish'
);
create type tenancy.change_request_status as enum ('pending', 'approved', 'rejected', 'applied', 'expired');

create table tenancy.change_requests (
  id uuid primary key default private.uuid_v7(),
  request_type tenancy.change_request_type not null,
  target_org_id uuid references tenancy.organizations (id) on delete restrict,
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  status tenancy.change_request_status not null default 'pending',
  requested_by uuid not null references auth.users (id),
  idempotency_key text not null check (length(idempotency_key) between 16 and 128),
  decided_by uuid references auth.users (id),
  decided_at timestamptz,
  decision_note text check (decision_note is null or length(decision_note) <= 1000),
  applied_at timestamptz,
  result jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days',
  unique (requested_by, idempotency_key),
  constraint approver_is_not_requester check (decided_by is null or decided_by <> requested_by),
  constraint decision_matches_status check (
    (status = 'pending' and decided_by is null)
    or status = 'expired'
    or (status in ('approved', 'rejected', 'applied') and decided_by is not null and decided_at is not null)
  ),
  constraint applied_has_time check (status <> 'applied' or applied_at is not null),
  constraint target_required check (
    request_type in ('organization.create', 'consent_notice.publish') or target_org_id is not null
  )
);
create index change_requests_target on tenancy.change_requests (target_org_id);
create index change_requests_status on tenancy.change_requests (status, created_at);
create index change_requests_decided_by on tenancy.change_requests (decided_by);
comment on table tenancy.change_requests is
  'Two-person approval records for administrative changes. Writes only through private.request_change, '
  'private.decide_change_request and private.apply_change_request. Owner: tenancy module.';

-- Immutable except for the allowed status flow.
create or replace function private.protect_change_request()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'change requests cannot be deleted' using errcode = 'P0001';
  end if;
  if (new.id, new.request_type, new.target_org_id, new.payload, new.requested_by, new.idempotency_key, new.created_at)
     is distinct from
     (old.id, old.request_type, old.target_org_id, old.payload, old.requested_by, old.idempotency_key, old.created_at) then
    raise exception 'a change request cannot be edited after it is filed' using errcode = 'P0001';
  end if;
  if not (
    (old.status = 'pending' and new.status in ('approved', 'rejected', 'expired'))
    or (old.status = 'approved' and new.status in ('applied', 'expired'))
    or old.status = new.status
  ) then
    raise exception 'invalid change request status change % -> %', old.status, new.status using errcode = 'P0001';
  end if;
  if old.status <> 'pending' and old.decided_by is distinct from new.decided_by then
    raise exception 'the decision on a change request cannot be changed' using errcode = 'P0001';
  end if;
  return new;
end
$$;
create trigger change_requests_protect before update or delete on tenancy.change_requests
  for each row execute function private.protect_change_request();
create trigger no_truncate before truncate on tenancy.change_requests
  for each statement execute function private.forbid_truncate();

-- Who may handle (request or approve) which type of change.
create or replace function private.can_handle_change(p_user uuid, p_type tenancy.change_request_type, p_target_org uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_type = 'consent_notice.publish' then exists (
      select 1 from tenancy.memberships m
      join tenancy.organizations o on o.id = m.org_id and o.kind = 'platform' and o.status = 'active'
      join tenancy.membership_roles mr on mr.membership_id = m.id
      join tenancy.role_permissions rp on rp.role_id = mr.role_id
      where m.user_id = p_user and m.status = 'active' and (m.valid_until is null or m.valid_until > now())
        and rp.permission_key = 'platform.consent_notices.manage')
    else
      exists (
        select 1 from tenancy.memberships m
        join tenancy.organizations o on o.id = m.org_id and o.kind = 'platform' and o.status = 'active'
        join tenancy.membership_roles mr on mr.membership_id = m.id
        join tenancy.role_permissions rp on rp.role_id = mr.role_id
        where m.user_id = p_user and m.status = 'active' and (m.valid_until is null or m.valid_until > now())
          and rp.permission_key = 'platform.organizations.manage')
      or (p_type in ('membership.invite', 'membership.suspend', 'role.grant', 'role.revoke')
          and p_target_org is not null
          and private.user_has_permission_in_org(p_user, p_target_org, 'org.members.manage'))
  end
$$;
revoke all on function private.can_handle_change(uuid, tenancy.change_request_type, uuid) from public;
grant execute on function private.can_handle_change(uuid, tenancy.change_request_type, uuid) to authenticated, service_role;

alter table tenancy.change_requests enable row level security;
alter table tenancy.change_requests force row level security;
create policy change_requests_read on tenancy.change_requests for select to authenticated
  using (
    requested_by = (select auth.uid())
    or (select private.can_handle_change((select auth.uid()), request_type, target_org_id))
  );
grant select on tenancy.change_requests to authenticated;

-- Writes to audit made inside these functions (the caller has no insert right on audit.events).
create or replace function private.write_admin_audit(
  p_actor_type audit.actor_type,
  p_actor_user uuid,
  p_tenant uuid,
  p_action text,
  p_entity_id uuid,
  p_metadata jsonb,
  p_outcome audit.outcome default 'success'
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into audit.events (actor_type, actor_user_id, tenant_org_id, action, entity_type, entity_id, outcome, metadata)
  values (p_actor_type, p_actor_user, p_tenant, p_action, 'change_request', p_entity_id::text, p_outcome, p_metadata)
$$;
revoke all on function private.write_admin_audit(audit.actor_type, uuid, uuid, text, uuid, jsonb, audit.outcome) from public;

-- Administrative functions need a staff session that completed the second factor. Supabase puts
-- `aal` in the JWT; the API checks it too, this is the database's own backstop.
create or replace function private.require_aal2()
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if coalesce((select auth.jwt()) ->> 'aal', 'aal1') <> 'aal2' then
    raise exception 'multi-factor authentication required' using errcode = '42501', hint = 'mfa_required';
  end if;
end
$$;
grant execute on function private.require_aal2() to authenticated, service_role;

-- Payload checks happen when the request is filed so reviewers never approve a malformed request.
create or replace function private.validate_change_payload(p_type tenancy.change_request_type, p_target uuid, p_payload jsonb)
returns void
language plpgsql
immutable
set search_path = ''
as $$
declare
  k text;
  required_keys text[];
  allowed_keys text[];
begin
  case p_type
    when 'organization.create' then
      required_keys := array['kind', 'legal_name', 'display_name'];
      allowed_keys := array['kind', 'legal_name', 'display_name', 'regulator_registration_no', 'cin'];
      if p_payload ->> 'kind' not in ('lender', 'service_partner') then
        raise exception 'organization.create can only create lender or service_partner organisations' using errcode = '22023';
      end if;
    when 'organization.activate' then required_keys := '{}'; allowed_keys := '{}';
    when 'membership.invite' then required_keys := array['user_id']; allowed_keys := array['user_id'];
    when 'membership.suspend' then required_keys := array['membership_id']; allowed_keys := array['membership_id'];
    when 'role.grant', 'role.revoke' then
      required_keys := array['membership_id', 'role_key']; allowed_keys := array['membership_id', 'role_key'];
    when 'consent_notice.publish' then required_keys := array['notice_id']; allowed_keys := array['notice_id'];
  end case;
  foreach k in array required_keys loop
    if not (p_payload ? k) then
      raise exception 'payload is missing %', k using errcode = '22023';
    end if;
  end loop;
  for k in select jsonb_object_keys(p_payload) loop
    if not (k = any (allowed_keys)) then
      raise exception 'payload has unexpected field %', k using errcode = '22023';
    end if;
  end loop;
end
$$;

create or replace function private.request_change(
  p_type tenancy.change_request_type,
  p_target_org uuid,
  p_payload jsonb,
  p_idempotency_key text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_actor text := private.current_actor();
  v_existing tenancy.change_requests;
  v_id uuid;
begin
  perform private.require_aal2();
  if v_actor not in ('platform', 'lender') then
    raise exception 'only staff can file change requests' using errcode = '42501';
  end if;
  if not private.can_handle_change(v_user, p_type, p_target_org) then
    raise exception 'you do not hold the permission needed for this change' using errcode = '42501';
  end if;
  p_payload := coalesce(p_payload, '{}'::jsonb);
  perform private.validate_change_payload(p_type, p_target_org, p_payload);

  select * into v_existing from tenancy.change_requests
  where requested_by = v_user and idempotency_key = p_idempotency_key;
  if found then
    if (v_existing.request_type, v_existing.target_org_id, v_existing.payload)
       is distinct from (p_type, p_target_org, p_payload) then
      raise exception 'idempotency key was already used for a different request' using errcode = '23505';
    end if;
    return v_existing.id;
  end if;

  insert into tenancy.change_requests (request_type, target_org_id, payload, requested_by, idempotency_key)
  values (p_type, p_target_org, p_payload, v_user, p_idempotency_key)
  returning id into v_id;
  perform private.write_admin_audit(case v_actor when 'platform' then 'platform' else 'staff' end::audit.actor_type,
    v_user, p_target_org, 'change_request.filed', v_id, jsonb_build_object('type', p_type));
  return v_id;
end
$$;
revoke all on function private.request_change(tenancy.change_request_type, uuid, jsonb, text) from public;
grant execute on function private.request_change(tenancy.change_request_type, uuid, jsonb, text) to authenticated;

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
    -- Do not reveal whether the request exists to people who cannot handle it.
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
  return v_new;
end
$$;
revoke all on function private.decide_change_request(uuid, boolean, text) from public;
grant execute on function private.decide_change_request(uuid, boolean, text) to authenticated;

-- Applying an approved request: system role only, re-validates, one transaction.
create or replace function private.apply_change_request(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_req tenancy.change_requests;
  v_result jsonb := '{}'::jsonb;
  v_org_id uuid;
  v_role_id uuid;
  v_member_org uuid;
  v_member_kind tenancy.organization_kind;
  v_rows integer;
begin
  if private.invoking_role() <> 'service_role' then
    raise exception 'only the system role can apply change requests' using errcode = '42501';
  end if;
  select * into v_req from tenancy.change_requests where id = p_id for update;
  if not found then
    raise exception 'change request not found' using errcode = 'P0002';
  end if;
  if v_req.status <> 'approved' then
    raise exception 'change request is %, not approved', v_req.status using errcode = '55000';
  end if;
  if v_req.expires_at <= now() then
    update tenancy.change_requests set status = 'expired' where id = p_id;
    return jsonb_build_object('status', 'expired');
  end if;
  -- Both people must still be entitled at the moment of application.
  if not private.can_handle_change(v_req.requested_by, v_req.request_type, v_req.target_org_id)
     or not private.can_handle_change(v_req.decided_by, v_req.request_type, v_req.target_org_id) then
    raise exception 'requester or approver no longer holds the required permission' using errcode = '42501';
  end if;

  perform set_config('udofin.change_apply', 'on', true);

  case v_req.request_type
    when 'organization.create' then
      insert into tenancy.organizations (kind, legal_name, display_name, regulator_registration_no, cin)
      values ((v_req.payload ->> 'kind')::tenancy.organization_kind, v_req.payload ->> 'legal_name',
              v_req.payload ->> 'display_name', v_req.payload ->> 'regulator_registration_no', v_req.payload ->> 'cin')
      returning id into v_org_id;
      v_result := jsonb_build_object('organization_id', v_org_id);

    when 'organization.activate' then
      update tenancy.organizations set status = 'active'
      where id = v_req.target_org_id and status = 'onboarding';
      get diagnostics v_rows = row_count;
      if v_rows <> 1 then
        raise exception 'organisation is not in onboarding' using errcode = '55000';
      end if;

    when 'membership.invite' then
      insert into tenancy.memberships (org_id, user_id, status, invited_by)
      values (v_req.target_org_id, (v_req.payload ->> 'user_id')::uuid, 'active', v_req.requested_by)
      returning id into v_org_id;
      v_result := jsonb_build_object('membership_id', v_org_id);

    when 'membership.suspend' then
      update tenancy.memberships set status = 'suspended'
      where id = (v_req.payload ->> 'membership_id')::uuid and org_id = v_req.target_org_id
        and status in ('invited', 'active');
      get diagnostics v_rows = row_count;
      if v_rows <> 1 then
        raise exception 'membership not found in this organisation or not suspendable' using errcode = 'P0002';
      end if;

    when 'role.grant', 'role.revoke' then
      select m.org_id, o.kind into v_member_org, v_member_kind
      from tenancy.memberships m join tenancy.organizations o on o.id = m.org_id
      where m.id = (v_req.payload ->> 'membership_id')::uuid;
      if v_member_org is distinct from v_req.target_org_id then
        raise exception 'membership not found in this organisation' using errcode = 'P0002';
      end if;
      select r.id into v_role_id from tenancy.roles r
      where r.org_id is null and r.applies_to = v_member_kind and r.key = v_req.payload ->> 'role_key';
      if v_role_id is null then
        raise exception 'unknown role for this kind of organisation' using errcode = 'P0002';
      end if;
      if v_req.request_type = 'role.grant' then
        insert into tenancy.membership_roles (membership_id, role_id, granted_by)
        values ((v_req.payload ->> 'membership_id')::uuid, v_role_id, v_req.requested_by);
      else
        delete from tenancy.membership_roles
        where membership_id = (v_req.payload ->> 'membership_id')::uuid and role_id = v_role_id;
        get diagnostics v_rows = row_count;
        if v_rows <> 1 then
          raise exception 'role is not granted to this membership' using errcode = 'P0002';
        end if;
      end if;

    when 'consent_notice.publish' then
      update consent.notices
      set status = 'published', published_at = now(), approved_by = v_req.decided_by
      where id = (v_req.payload ->> 'notice_id')::uuid and status = 'draft';
      get diagnostics v_rows = row_count;
      if v_rows <> 1 then
        raise exception 'consent notice is not a draft' using errcode = '55000';
      end if;
  end case;

  update tenancy.change_requests
  set status = 'applied', applied_at = now(), result = v_result
  where id = p_id;

  perform set_config('udofin.change_apply', 'off', true);
  perform private.write_admin_audit('system', null, v_req.target_org_id, 'change_request.applied', p_id,
    jsonb_build_object('type', v_req.request_type, 'requested_by', v_req.requested_by,
                       'decided_by', v_req.decided_by) || v_result);
  return v_result;
end
$$;
revoke all on function private.apply_change_request(uuid) from public;
grant execute on function private.apply_change_request(uuid) to service_role;

-- ---------------------------------------------------------------------------------------------
-- Guards: organisations, memberships and role grants change only inside apply_change_request.
-- The database owner (migrations, break-glass bootstrap run by a named human) is exempt.
-- ---------------------------------------------------------------------------------------------
create or replace function private.require_change_context()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_setting('udofin.change_apply', true) = 'on'
     or private.invoking_role() in ('postgres', 'supabase_admin') then
    return coalesce(new, old);
  end if;
  raise exception '% on %.% is only allowed through an approved change request', tg_op, tg_table_schema, tg_table_name
    using errcode = '42501', hint = 'Use private.request_change and an independent approver.';
end
$$;

create trigger organizations_change_control before insert or delete on tenancy.organizations
  for each row execute function private.require_change_context();
create trigger memberships_change_control before insert or delete on tenancy.memberships
  for each row execute function private.require_change_context();
create trigger membership_roles_change_control before insert or update or delete on tenancy.membership_roles
  for each row execute function private.require_change_context();

-- Status and registration changes on organisations and memberships are guarded column by column so
-- harmless maintenance (updated_at) still works.
create or replace function private.guard_status_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_setting('udofin.change_apply', true) = 'on'
     or private.invoking_role() in ('postgres', 'supabase_admin') then
    return new;
  end if;
  raise exception 'changing status or ownership of %.% rows is only allowed through an approved change request',
    tg_table_schema, tg_table_name using errcode = '42501';
end
$$;
create trigger organizations_status_control before update of status, kind, regulator_registration_no
  on tenancy.organizations for each row
  when (old.status is distinct from new.status or old.kind is distinct from new.kind
        or old.regulator_registration_no is distinct from new.regulator_registration_no)
  execute function private.guard_status_change();
create trigger memberships_status_control before update of status, org_id, user_id on tenancy.memberships
  for each row
  when (old.status is distinct from new.status or old.org_id is distinct from new.org_id
        or old.user_id is distinct from new.user_id)
  execute function private.guard_status_change();
