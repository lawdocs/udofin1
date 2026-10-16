-- =============================================================================================
-- Tenancy and access control.
--
-- Model: one shared database, shared tables, every tenant-owned row carries `lender_org_id`.
-- Organisations are the platform operator (Udofin), partner lenders (regulated entities) and
-- service partners (e.g. a collection agency engaged by a lender). Staff belong to organisations
-- through memberships; memberships carry roles; roles carry permissions.
--
-- Platform (Udofin) staff can act inside a lender's data only through permissions explicitly
-- marked `platform_grantable` — e.g. support staff reading an application to resolve an
-- exception — and every such access is audited by the API.
-- =============================================================================================

create type tenancy.organization_kind as enum ('platform', 'lender', 'service_partner');
create type tenancy.organization_status as enum ('onboarding', 'active', 'suspended', 'offboarded');
create type tenancy.membership_status as enum ('invited', 'active', 'suspended', 'revoked');

create table tenancy.organizations (
  id uuid primary key default private.uuid_v7(),
  kind tenancy.organization_kind not null,
  legal_name text not null check (length(legal_name) between 2 and 300),
  display_name text not null check (length(display_name) between 2 and 120),
  -- Regulated lenders: RBI certificate of registration / licence number. Verified during onboarding.
  regulator_registration_no text,
  -- Corporate Identification Number (MCA), where applicable.
  cin text check (cin is null or cin ~ '^[A-Z0-9]{21}$'),
  status tenancy.organization_status not null default 'onboarding',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint lender_needs_registration check (
    kind <> 'lender' or status = 'onboarding' or regulator_registration_no is not null
  )
);
comment on table tenancy.organizations is
  'Udofin (platform), partner lenders (regulated entities) and service partners. Owner: tenancy module.';

-- Exactly one platform organisation may exist.
create unique index organizations_single_platform on tenancy.organizations ((kind)) where kind = 'platform';

create trigger organizations_set_updated_at before update on tenancy.organizations
  for each row execute function private.set_updated_at();

create table tenancy.permissions (
  key text primary key check (key ~ '^[a-z_]+(\.[a-z_]+)+$'),
  description text not null,
  -- Whether a role in the platform organisation may hold this permission across all lenders.
  platform_grantable boolean not null default false,
  -- Permissions that only make sense for platform staff (tenant roles may never hold them).
  platform_only boolean not null default false
);
comment on table tenancy.permissions is 'Permission catalogue. Reference data managed by migrations only.';

create table tenancy.roles (
  id uuid primary key default private.uuid_v7(),
  -- NULL for system roles available to every organisation of the matching kind.
  org_id uuid references tenancy.organizations (id) on delete cascade,
  applies_to tenancy.organization_kind not null,
  key text not null check (key ~ '^[a-z_]+$'),
  name text not null,
  description text not null default '',
  created_at timestamptz not null default now()
);
create unique index roles_system_key on tenancy.roles (applies_to, key) where org_id is null;
create unique index roles_org_key on tenancy.roles (org_id, key) where org_id is not null;

create table tenancy.role_permissions (
  role_id uuid not null references tenancy.roles (id) on delete cascade,
  permission_key text not null references tenancy.permissions (key),
  primary key (role_id, permission_key)
);
create index role_permissions_permission on tenancy.role_permissions (permission_key);

create table tenancy.memberships (
  id uuid primary key default private.uuid_v7(),
  org_id uuid not null references tenancy.organizations (id) on delete restrict,
  user_id uuid not null references auth.users (id) on delete restrict,
  status tenancy.membership_status not null default 'invited',
  invited_by uuid references auth.users (id),
  valid_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, user_id)
);
create index memberships_user on tenancy.memberships (user_id) where status = 'active';
create trigger memberships_set_updated_at before update on tenancy.memberships
  for each row execute function private.set_updated_at();

create table tenancy.membership_roles (
  membership_id uuid not null references tenancy.memberships (id) on delete cascade,
  role_id uuid not null references tenancy.roles (id) on delete restrict,
  granted_by uuid references auth.users (id),
  granted_at timestamptz not null default now(),
  primary key (membership_id, role_id)
);
create index membership_roles_role on tenancy.membership_roles (role_id);

-- A role may only be granted to members of an organisation of the kind it applies to, and a
-- tenant role may never carry a platform-only permission. Enforced here so no code path can skip it.
create or replace function private.check_membership_role()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  member_org_kind tenancy.organization_kind;
  member_org_id uuid;
  role_kind tenancy.organization_kind;
  role_org uuid;
begin
  select o.kind, o.id into member_org_kind, member_org_id
  from tenancy.memberships m join tenancy.organizations o on o.id = m.org_id
  where m.id = new.membership_id;

  select r.applies_to, r.org_id into role_kind, role_org from tenancy.roles r where r.id = new.role_id;

  if role_kind is distinct from member_org_kind then
    raise exception 'role applies to % organisations, member belongs to a % organisation', role_kind, member_org_kind
      using errcode = '23514';
  end if;
  if role_org is not null and role_org <> member_org_id then
    raise exception 'custom role belongs to a different organisation' using errcode = '23514';
  end if;
  return new;
end
$$;
create trigger membership_roles_check before insert or update on tenancy.membership_roles
  for each row execute function private.check_membership_role();

create or replace function private.check_role_permission()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (
    select 1 from tenancy.roles r join tenancy.permissions p on p.key = new.permission_key
    where r.id = new.role_id and r.applies_to <> 'platform' and p.platform_only
  ) then
    raise exception 'permission % is platform-only', new.permission_key using errcode = '23514';
  end if;
  return new;
end
$$;
create trigger role_permissions_check before insert or update on tenancy.role_permissions
  for each row execute function private.check_role_permission();

-- ---------------------------------------------------------------------------------------------
-- Authorisation helpers used by RLS policies. SECURITY DEFINER so policies can consult the
-- membership tables without granting users direct access to them; search_path pinned to ''.
-- They return SETS of organisation ids so policies can use `lender_org_id in (select ...)`,
-- which Postgres evaluates once per statement rather than once per row.
-- ---------------------------------------------------------------------------------------------

-- Organisations the current user is an active member of.
create or replace function private.my_org_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.org_id
  from tenancy.memberships m
  join tenancy.organizations o on o.id = m.org_id
  where m.user_id = (select auth.uid())
    and m.status = 'active'
    and (m.valid_until is null or m.valid_until > now())
    and o.status in ('onboarding', 'active')
$$;

-- Organisations in which the current user holds `permission`, either through a role in that
-- organisation, or (for platform-grantable permissions) through a role in the platform org.
create or replace function private.orgs_with_permission(permission text)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  with my_grants as (
    select m.org_id, o.kind, p.key, p.platform_grantable
    from tenancy.memberships m
    join tenancy.organizations o on o.id = m.org_id
    join tenancy.membership_roles mr on mr.membership_id = m.id
    join tenancy.role_permissions rp on rp.role_id = mr.role_id
    join tenancy.permissions p on p.key = rp.permission_key
    where m.user_id = (select auth.uid())
      and m.status = 'active'
      and (m.valid_until is null or m.valid_until > now())
      and o.status in ('onboarding', 'active')
      and p.key = permission
  )
  select g.org_id from my_grants g where g.kind <> 'platform'
  union
  select o.id
  from tenancy.organizations o
  where exists (select 1 from my_grants g where g.kind = 'platform' and g.platform_grantable)
$$;

-- Whether the current user holds `permission` through the platform organisation.
create or replace function private.has_platform_permission(permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from tenancy.memberships m
    join tenancy.organizations o on o.id = m.org_id and o.kind = 'platform' and o.status = 'active'
    join tenancy.membership_roles mr on mr.membership_id = m.id
    join tenancy.role_permissions rp on rp.role_id = mr.role_id
    where m.user_id = (select auth.uid())
      and m.status = 'active'
      and (m.valid_until is null or m.valid_until > now())
      and rp.permission_key = permission
  )
$$;

revoke all on function private.my_org_ids() from public;
revoke all on function private.orgs_with_permission(text) from public;
revoke all on function private.has_platform_permission(text) from public;
grant execute on function private.my_org_ids() to authenticated, service_role;
grant execute on function private.orgs_with_permission(text) to authenticated, service_role;
grant execute on function private.has_platform_permission(text) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Row Level Security. Writes to tenancy tables happen through the API under service_role after
-- explicit permission checks (organisation onboarding is a platform workflow with maker-checker).
-- Users can read what they are entitled to see.
-- ---------------------------------------------------------------------------------------------
alter table tenancy.organizations enable row level security;
alter table tenancy.organizations force row level security;
alter table tenancy.permissions enable row level security;
alter table tenancy.roles enable row level security;
alter table tenancy.role_permissions enable row level security;
alter table tenancy.memberships enable row level security;
alter table tenancy.memberships force row level security;
alter table tenancy.membership_roles enable row level security;
alter table tenancy.membership_roles force row level security;

create policy organizations_read on tenancy.organizations for select to authenticated
  using (
    id in (select private.my_org_ids())
    or (select private.has_platform_permission('platform.organizations.read'))
  );

create policy permissions_read on tenancy.permissions for select to authenticated using (true);

create policy roles_read on tenancy.roles for select to authenticated
  using (org_id is null or org_id in (select private.my_org_ids()));

create policy role_permissions_read on tenancy.role_permissions for select to authenticated
  using (
    exists (
      select 1 from tenancy.roles r
      where r.id = role_id and (r.org_id is null or r.org_id in (select private.my_org_ids()))
    )
  );

create policy memberships_read on tenancy.memberships for select to authenticated
  using (
    user_id = (select auth.uid())
    or org_id in (select private.orgs_with_permission('org.members.read'))
  );

create policy membership_roles_read on tenancy.membership_roles for select to authenticated
  using (
    exists (
      select 1 from tenancy.memberships m
      where m.id = membership_id
        and (m.user_id = (select auth.uid()) or m.org_id in (select private.orgs_with_permission('org.members.read')))
    )
  );

grant select on tenancy.organizations, tenancy.permissions, tenancy.roles, tenancy.role_permissions,
  tenancy.memberships, tenancy.membership_roles to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Reference data: permission catalogue and system roles. Changes require a reviewed migration.
-- ---------------------------------------------------------------------------------------------
insert into tenancy.permissions (key, description, platform_grantable, platform_only) values
  ('org.members.read', 'View members and their roles', true, false),
  ('org.members.manage', 'Invite, suspend and assign roles to members of own organisation', false, false),
  ('product.read', 'View loan products and their versions', true, false),
  ('product.configure', 'Draft loan product versions (requires separate approval to publish)', false, false),
  ('product.approve', 'Approve and publish loan product versions (maker-checker)', false, false),
  ('application.read', 'View loan applications routed to the organisation', true, false),
  ('application.decide', 'Record credit decisions and offers (lender staff only)', false, false),
  ('loan.read', 'View loan accounts and schedules', true, false),
  ('payment.read', 'View payment instructions and provider events', true, false),
  ('audit.read', 'View the audit trail for the organisation', true, false),
  ('platform.organizations.read', 'View all organisations on the platform', false, true),
  ('platform.organizations.manage', 'Onboard, suspend and offboard organisations', false, true),
  ('platform.consent_notices.manage', 'Draft and publish consent notice versions', false, true);

insert into tenancy.roles (org_id, applies_to, key, name, description) values
  (null, 'lender', 'lender_admin', 'Lender administrator', 'Manages members, products and settings of the lender'),
  (null, 'lender', 'credit_officer', 'Credit officer', 'Reviews applications and records credit decisions'),
  (null, 'lender', 'product_approver', 'Product approver', 'Approves product versions drafted by another user'),
  (null, 'lender', 'viewer', 'Viewer', 'Read-only access to the lender''s records'),
  (null, 'platform', 'platform_admin', 'Platform administrator', 'Manages organisations on the platform'),
  (null, 'platform', 'operations_agent', 'Operations agent', 'Handles exceptions across lenders (read access, audited)'),
  (null, 'platform', 'auditor', 'Auditor', 'Read-only access to records and the audit trail');

insert into tenancy.role_permissions (role_id, permission_key)
select r.id, p.key
from tenancy.roles r
join (values
  ('lender', 'lender_admin', 'org.members.read'),
  ('lender', 'lender_admin', 'org.members.manage'),
  ('lender', 'lender_admin', 'product.read'),
  ('lender', 'lender_admin', 'product.configure'),
  ('lender', 'lender_admin', 'application.read'),
  ('lender', 'lender_admin', 'loan.read'),
  ('lender', 'lender_admin', 'payment.read'),
  ('lender', 'lender_admin', 'audit.read'),
  ('lender', 'credit_officer', 'product.read'),
  ('lender', 'credit_officer', 'application.read'),
  ('lender', 'credit_officer', 'application.decide'),
  ('lender', 'credit_officer', 'loan.read'),
  ('lender', 'product_approver', 'product.read'),
  ('lender', 'product_approver', 'product.approve'),
  ('lender', 'viewer', 'product.read'),
  ('lender', 'viewer', 'application.read'),
  ('lender', 'viewer', 'loan.read'),
  ('lender', 'viewer', 'payment.read'),
  ('platform', 'platform_admin', 'platform.organizations.read'),
  ('platform', 'platform_admin', 'platform.organizations.manage'),
  ('platform', 'platform_admin', 'platform.consent_notices.manage'),
  ('platform', 'platform_admin', 'org.members.read'),
  ('platform', 'operations_agent', 'platform.organizations.read'),
  ('platform', 'operations_agent', 'product.read'),
  ('platform', 'operations_agent', 'application.read'),
  ('platform', 'operations_agent', 'loan.read'),
  ('platform', 'operations_agent', 'payment.read'),
  ('platform', 'auditor', 'platform.organizations.read'),
  ('platform', 'auditor', 'product.read'),
  ('platform', 'auditor', 'application.read'),
  ('platform', 'auditor', 'loan.read'),
  ('platform', 'auditor', 'payment.read'),
  ('platform', 'auditor', 'audit.read')
) as g (applies_to, role_key, permission_key)
  on r.org_id is null and r.applies_to = g.applies_to::tenancy.organization_kind and r.key = g.role_key
join tenancy.permissions p on p.key = g.permission_key;
