-- =============================================================================================
-- Phase 04: lender transactions panel.
--
-- A read-only, tenant-scoped feed of what happened on a lender's business with Udofin:
-- applications, loan accounts (read-model of the lender's LMS) and payment intents. The view is
-- SECURITY INVOKER, so each underlying table's own row-level security (application.read,
-- loan.read, payment.read) decides what a user sees; it never widens access. No borrower names,
-- phone numbers, PAN or bank details are exposed - only opaque ids, references, states and amounts
-- in integer paise.
-- =============================================================================================

create view lending.lender_transactions with (security_invoker = true) as
select 'application'::text as kind,
       a.id,
       a.lender_org_id,
       a.created_at as occurred_at,
       a.status::text as status,
       a.requested_amount_minor as amount_minor,
       a.lender_reference as reference,
       p.id as product_id,
       p.code as product_code,
       null::text as purpose,
       a.id as application_id,
       null::uuid as loan_account_id
from lending.applications a
left join lending.loan_product_versions v on v.id = a.product_version_id and v.lender_org_id = a.lender_org_id
left join lending.loan_products p on p.id = v.product_id and p.lender_org_id = v.lender_org_id
union all
select 'loan_account',
       l.id,
       l.lender_org_id,
       coalesce(l.disbursed_at, l.created_at),
       l.status::text,
       coalesce(l.disbursed_amount_minor, l.sanctioned_amount_minor),
       l.lms_loan_ref,
       p.id,
       p.code,
       null::text,
       l.application_id,
       l.id
from servicing.loan_accounts l
left join lending.applications a on a.id = l.application_id and a.lender_org_id = l.lender_org_id
left join lending.loan_product_versions v on v.id = a.product_version_id and v.lender_org_id = a.lender_org_id
left join lending.loan_products p on p.id = v.product_id and p.lender_org_id = v.lender_org_id
union all
select 'payment',
       i.id,
       i.lender_org_id,
       i.created_at,
       i.status::text,
       i.amount_minor,
       i.provider_order_ref,
       p.id,
       p.code,
       i.purpose::text,
       l.application_id,
       i.loan_account_id
from payments.payment_intents i
left join servicing.loan_accounts l on l.id = i.loan_account_id and l.lender_org_id = i.lender_org_id
left join lending.applications a on a.id = l.application_id and a.lender_org_id = l.lender_org_id
left join lending.loan_product_versions v on v.id = a.product_version_id and v.lender_org_id = a.lender_org_id
left join lending.loan_products p on p.id = v.product_id and p.lender_org_id = v.lender_org_id;
comment on view lending.lender_transactions is
  'Unified read-only feed for the lender transactions panel. SECURITY INVOKER: row-level security of each source table applies. Owner: lending module.';
grant select on lending.lender_transactions to authenticated;

-- Saved views: a person's own filter / column / sort presets for the panel (and optionally shared with
-- colleagues who can already read applications). The config is validated by the API against a schema;
-- the database bounds its size and shape.
create table lending.panel_views (
  id uuid primary key default private.uuid_v7(),
  lender_org_id uuid not null references tenancy.organizations (id) on delete restrict,
  owner_user_id uuid not null references auth.users (id) on delete restrict,
  kind text not null default 'transactions' check (kind in ('transactions')),
  name text not null check (length(name) between 1 and 80),
  config jsonb not null check (jsonb_typeof(config) = 'object' and pg_column_size(config) <= 4096),
  shared boolean not null default false,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index panel_views_name on lending.panel_views (lender_org_id, owner_user_id, kind, name) where archived_at is null;
create index panel_views_lender on lending.panel_views (lender_org_id, kind) where archived_at is null;
comment on table lending.panel_views is 'Saved filter/column presets for the lender panels. Contains no borrower data. Owner: lending module.';
create trigger panel_views_set_updated_at before update on lending.panel_views
  for each row execute function private.set_updated_at();
create trigger panel_views_no_delete before delete on lending.panel_views
  for each row execute function private.forbid_mutation();
create trigger no_truncate before truncate on lending.panel_views
  for each statement execute function private.forbid_truncate();
alter table lending.panel_views enable row level security;
alter table lending.panel_views force row level security;

create policy panel_views_read on lending.panel_views for select to authenticated
  using (
    owner_user_id = (select auth.uid())
    or (shared and lender_org_id in (select private.orgs_with_permission('application.read')))
  );
create policy panel_views_insert on lending.panel_views for insert to authenticated
  with check (
    owner_user_id = (select auth.uid())
    and (lender_org_id in (select private.orgs_with_permission('application.read'))
         or lender_org_id in (select private.orgs_with_permission('loan.read'))
         or lender_org_id in (select private.orgs_with_permission('payment.read')))
  );
create policy panel_views_update on lending.panel_views for update to authenticated
  using (owner_user_id = (select auth.uid()))
  with check (owner_user_id = (select auth.uid()));
grant select, insert on lending.panel_views to authenticated;
grant update (name, config, shared, archived_at) on lending.panel_views to authenticated;

-- Exports leave the platform, so each one is recorded: who, which lender, how many rows, and which
-- filter names were used (never their values).
create or replace function lending.record_panel_export(p_lender uuid, p_kind text, p_rows integer, p_filter_names text[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor audit.actor_type;
begin
  if not (p_lender in (select private.orgs_with_permission('application.read'))
          or p_lender in (select private.orgs_with_permission('loan.read'))
          or p_lender in (select private.orgs_with_permission('payment.read'))) then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  v_actor := case when private.has_platform_permission('application.read') then 'platform' else 'staff' end::audit.actor_type;
  insert into audit.events (actor_type, actor_user_id, tenant_org_id, action, entity_type, entity_id, metadata)
  values (v_actor, (select auth.uid()), p_lender, 'lending.transactions.export', 'lender_transactions', p_kind,
          jsonb_build_object('rows', p_rows, 'filters', to_jsonb(coalesce(p_filter_names, '{}'))));
end
$$;
revoke all on function lending.record_panel_export(uuid, text, integer, text[]) from public;
grant execute on function lending.record_panel_export(uuid, text, integer, text[]) to authenticated;
