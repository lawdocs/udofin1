-- =============================================================================================
-- Phase 02 foundations (spec: docs/specs/02-database-security.md, W1).
--
-- 1. Audit actor values for platform staff.
-- 2. Matching rule versions and offer display log (Chapter III para 7; ADR 0022).
-- 3. Lender settlement accounts (masked reference only; full numbers arrive with envelope
--    encryption in Phase 06).
-- 4. Permission catalogue additions for collections and DLG, with a segregation-of-duties rule:
--    the same login cannot hold both `collections.work` and `dlg.manage`
--    (docs/architecture/collections-and-dlg.md, section 4.3).
-- All changes are additive; no existing data depends on them.
-- =============================================================================================

-- 1. Audit actors --------------------------------------------------------------------------------
-- 'platform' = Udofin staff. (A new enum value cannot be used in the transaction that adds it;
-- the functions that write it run later.)
alter type audit.actor_type add value if not exists 'platform';

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
  v_actor text := private.current_actor();
  v_actor_org uuid;
  v_id uuid;
begin
  if v_actor in ('none', 'system') or v_user is null then
    raise exception 'record_audit_event requires an authenticated end user; the system writes audit rows directly'
      using errcode = '42501';
  end if;

  if v_actor = 'borrower' then
    if p_tenant_org_id is not null and not exists (
      select 1 from lending.applications a join identity.borrowers b on b.id = a.borrower_id
      where b.user_id = v_user and a.lender_org_id = p_tenant_org_id
    ) then
      raise exception 'borrowers can only record events about lenders they applied to' using errcode = '42501';
    end if;
  else
    select m.org_id into v_actor_org
    from tenancy.memberships m join tenancy.organizations o on o.id = m.org_id
    where m.user_id = v_user and m.status = 'active'
    order by (m.org_id = p_tenant_org_id) desc, (o.kind = 'platform') desc
    limit 1;
    if p_tenant_org_id is not null and v_actor = 'lender' and p_tenant_org_id not in (select private.my_org_ids()) then
      raise exception 'staff can only record events in their own organisation' using errcode = '42501';
    end if;
  end if;

  insert into audit.events (actor_type, actor_user_id, actor_org_id, tenant_org_id, action, entity_type,
                            entity_id, outcome, request_id, correlation_id, metadata)
  values (case v_actor when 'borrower' then 'borrower' when 'platform' then 'platform' else 'staff' end::audit.actor_type,
          v_user, v_actor_org, p_tenant_org_id, p_action, p_entity_type, p_entity_id, p_outcome, p_request_id,
          p_correlation_id, coalesce(p_metadata, '{}'::jsonb))
  returning id into v_id;
  return v_id;
end
$$;

-- 2. Matching rule versions and offer displays ---------------------------------------------------
-- The comparison screen must disclose how offers are ordered and be able to prove, later, what each
-- borrower was shown and under which rule. Rule versions are public reference data and append-only.
create table lending.matching_rule_versions (
  id uuid primary key default private.uuid_v7(),
  version integer not null unique check (version > 0),
  mechanism_summary text not null check (length(mechanism_summary) between 20 and 4000),
  -- The disclosed ranking metric, e.g. "total cost to the borrower (APR), lowest first".
  disclosed_metric text not null check (length(disclosed_metric) between 5 and 500),
  effective_from timestamptz not null,
  approved_by uuid not null references auth.users (id),
  created_at timestamptz not null default now()
);
comment on table lending.matching_rule_versions is
  'Versioned, publicly disclosed offer-ranking rules (Chapter III para 7). Append-only. Owner: lending module.';
create trigger matching_rule_versions_append_only before update or delete on lending.matching_rule_versions
  for each row execute function private.forbid_mutation();
create trigger no_truncate before truncate on lending.matching_rule_versions
  for each statement execute function private.forbid_truncate();
alter table lending.matching_rule_versions enable row level security;
alter table lending.matching_rule_versions force row level security;
create policy matching_rule_versions_read on lending.matching_rule_versions for select to authenticated using (true);
grant select on lending.matching_rule_versions to authenticated;

-- Composite key so tenant-owned children can reference an offer together with its lender.
alter table lending.offers add constraint offers_id_lender_key unique (id, lender_org_id);

create table lending.offer_displays (
  id uuid primary key default private.uuid_v7(),
  lender_org_id uuid not null,
  offer_id uuid not null,
  borrower_id uuid not null references identity.borrowers (id) on delete restrict,
  rank_position integer not null check (rank_position > 0),
  rule_version_id uuid not null references lending.matching_rule_versions (id),
  displayed_at timestamptz not null default now(),
  foreign key (offer_id, lender_org_id) references lending.offers (id, lender_org_id) on delete restrict
);
create index offer_displays_borrower on lending.offer_displays (borrower_id, displayed_at desc);
create index offer_displays_offer on lending.offer_displays (offer_id, lender_org_id);
create index offer_displays_rule on lending.offer_displays (rule_version_id);
comment on table lending.offer_displays is
  'Append-only log of which offer a borrower saw at which rank under which rule version. Owner: lending module.';
create trigger offer_displays_append_only before update or delete on lending.offer_displays
  for each row execute function private.forbid_mutation();
create trigger no_truncate before truncate on lending.offer_displays
  for each statement execute function private.forbid_truncate();
alter table lending.offer_displays enable row level security;
alter table lending.offer_displays force row level security;
create policy offer_displays_borrower_read on lending.offer_displays for select to authenticated
  using (borrower_id = (select private.my_borrower_id()));
create policy offer_displays_lender_read on lending.offer_displays for select to authenticated
  using (lender_org_id in (select private.orgs_with_permission('application.read')));
-- Rows are written by the system when the comparison list is served; no end-user write policy.
grant select on lending.offer_displays to authenticated;

-- 3. Lender settlement accounts ------------------------------------------------------------------
create type tenancy.settlement_account_status as enum ('unverified', 'verified', 'revoked');

create table tenancy.lender_settlement_accounts (
  id uuid primary key default private.uuid_v7(),
  lender_org_id uuid not null references tenancy.organizations (id) on delete restrict,
  label text not null check (length(label) between 2 and 80),
  bank_name text not null check (length(bank_name) between 2 and 120),
  -- Masked reference such as 'XXXXXX1234'. The full number is stored encrypted under the
  -- lender's key in Phase 06; it never appears in this table, in logs or in events.
  masked_account_ref text not null check (masked_account_ref ~ '^[X*]{2,}[0-9]{2,4}$'),
  status tenancy.settlement_account_status not null default 'unverified',
  verified_by uuid references auth.users (id),
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, lender_org_id),
  constraint verified_has_evidence check (status <> 'verified' or (verified_by is not null and verified_at is not null))
);
comment on table tenancy.lender_settlement_accounts is
  'Lender-owned accounts that borrower payments settle into (ADR 0008: no Udofin pool account). Owner: tenancy module.';
create trigger settlement_accounts_set_updated_at before update on tenancy.lender_settlement_accounts
  for each row execute function private.set_updated_at();
alter table tenancy.lender_settlement_accounts enable row level security;
alter table tenancy.lender_settlement_accounts force row level security;
create policy settlement_accounts_read on tenancy.lender_settlement_accounts for select to authenticated
  using (lender_org_id in (select private.orgs_with_permission('payment.read')));
grant select on tenancy.lender_settlement_accounts to authenticated;

alter table payments.payment_intents add column settlement_account_id uuid;
alter table payments.payment_intents add constraint payment_intents_settlement_account_fk
  foreign key (settlement_account_id, lender_org_id) references tenancy.lender_settlement_accounts (id, lender_org_id)
  on delete restrict;
create index payment_intents_settlement_account on payments.payment_intents (settlement_account_id, lender_org_id);

-- 4. Collections and DLG permissions -------------------------------------------------------------
insert into tenancy.permissions (key, description, platform_grantable, platform_only) values
  ('collections.work', 'Work assigned collection cases and log contact attempts', false, true),
  ('collections.manage', 'Assign recovery agents, set strategies and review conduct', false, true),
  ('collections.read', 'View collection cases and the contact log of the organisation', false, false),
  ('collections.policy', 'Configure recovery channels, contact hours and templates within platform limits', false, false),
  ('dlg.read', 'View default loss guarantee position and history', false, false),
  ('dlg.manage', 'Record DLG cover instruments and prepare disclosures', false, true),
  ('dlg.invoke', 'Record a DLG invocation (the lender invokes)', false, false);

insert into tenancy.roles (org_id, applies_to, key, name, description) values
  (null, 'platform', 'collections_agent', 'Collections agent', 'Works assigned cases as the lender''s recovery agent'),
  (null, 'platform', 'collections_head', 'Collections head', 'Assigns agents and reviews contact conduct'),
  (null, 'platform', 'dlg_finance', 'DLG finance officer', 'Maintains DLG cover instruments and disclosures'),
  (null, 'lender', 'recovery_policy_owner', 'Recovery policy owner', 'Sets recovery policy for the lender'),
  (null, 'lender', 'dlg_invoker', 'DLG invoker', 'Records invocations of the default loss guarantee');

insert into tenancy.role_permissions (role_id, permission_key)
select r.id, g.permission_key
from tenancy.roles r
join (values
  ('platform', 'collections_agent', 'collections.work'),
  ('platform', 'collections_head', 'collections.manage'),
  ('platform', 'dlg_finance', 'dlg.manage'),
  ('platform', 'dlg_finance', 'dlg.read'),
  ('lender', 'recovery_policy_owner', 'collections.policy'),
  ('lender', 'recovery_policy_owner', 'collections.read'),
  ('lender', 'dlg_invoker', 'dlg.invoke'),
  ('lender', 'dlg_invoker', 'dlg.read'),
  ('lender', 'lender_admin', 'collections.read'),
  ('lender', 'lender_admin', 'dlg.read')
) as g (applies_to, role_key, permission_key)
  on r.org_id is null and r.applies_to = g.applies_to::tenancy.organization_kind and r.key = g.role_key;

-- Segregation of duties. Collection pressure must never be driven by Udofin's own loss exposure
-- as guarantor, so no login may be able to both work collection cases and manage the DLG.
create or replace function private.user_permission_keys(p_user uuid)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(distinct rp.permission_key), '{}')
  from tenancy.memberships m
  join tenancy.membership_roles mr on mr.membership_id = m.id
  join tenancy.role_permissions rp on rp.role_id = mr.role_id
  where m.user_id = p_user and m.status <> 'revoked'
$$;
revoke all on function private.user_permission_keys(uuid) from public;
grant execute on function private.user_permission_keys(uuid) to service_role;

create or replace function private.enforce_collections_dlg_segregation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid;
  v_new_keys text[];
  v_keys text[];
begin
  if tg_table_name = 'membership_roles' then
    select m.user_id into v_user from tenancy.memberships m where m.id = new.membership_id;
    select coalesce(array_agg(rp.permission_key), '{}') into v_new_keys
    from tenancy.role_permissions rp where rp.role_id = new.role_id;
    v_keys := private.user_permission_keys(v_user) || v_new_keys;
    if 'collections.work' = any (v_keys) and 'dlg.manage' = any (v_keys) then
      raise exception 'segregation of duties: one login cannot hold both collections.work and dlg.manage'
        using errcode = '23514';
    end if;
  else
    -- A single role may not carry both permissions either.
    if new.permission_key in ('collections.work', 'dlg.manage') and exists (
      select 1 from tenancy.role_permissions rp
      where rp.role_id = new.role_id
        and rp.permission_key = case new.permission_key when 'collections.work' then 'dlg.manage' else 'collections.work' end
    ) then
      raise exception 'segregation of duties: a role cannot carry both collections.work and dlg.manage'
        using errcode = '23514';
    end if;
  end if;
  return new;
end
$$;
revoke all on function private.enforce_collections_dlg_segregation() from public;
create trigger membership_roles_segregation before insert or update on tenancy.membership_roles
  for each row execute function private.enforce_collections_dlg_segregation();
create trigger role_permissions_segregation before insert or update on tenancy.role_permissions
  for each row execute function private.enforce_collections_dlg_segregation();
