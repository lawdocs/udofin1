-- =============================================================================================
-- Lending core: product catalogue, loan requests, lender applications, lifecycle and offers.
--
-- Flow: a borrower creates ONE loan request (what they need). With consent, Udofin shares it with
-- matching lenders, creating ONE application per lender (lender-scoped, lender_org_id). Each lender
-- decides and may issue an offer. The borrower accepts at most one offer per request.
-- The lender — not Udofin — makes the credit decision; Udofin records it.
--
-- Cross-tenant references are impossible by construction: child rows reference parents through
-- composite foreign keys (id, lender_org_id), so a row can never point at another lender's data.
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- Product categories: platform reference data. `availability` gates what lenders may configure;
-- `min_tenure_days` is a platform floor no lender configuration can go below (app-store policy
-- prohibits personal loans requiring full repayment within 60 days).
-- ---------------------------------------------------------------------------------------------
create table lending.product_categories (
  key text primary key check (key ~ '^[a-z_]+$'),
  name text not null,
  secured boolean not null,
  availability text not null check (availability in ('enabled', 'feasibility_review', 'not_supported')),
  min_tenure_days integer not null check (min_tenure_days >= 61),
  notes text not null default ''
);
comment on table lending.product_categories is 'Platform product categories. Changes require a reviewed migration.';

insert into lending.product_categories (key, name, secured, availability, min_tenure_days, notes) values
  ('personal', 'Personal loan', false, 'enabled', 91, 'Unsecured; minimum tenure kept above app-store short-term-loan thresholds.'),
  ('loan_against_securities', 'Loan against securities (shares / mutual funds)', true, 'feasibility_review', 61,
   'Pledge / lien is created by the lender as pledgee via depository or RTA systems; Udofin orchestrates only.'),
  ('vehicle', 'Vehicle loan (new / used, two-wheeler)', true, 'feasibility_review', 180, 'Hypothecation registered by the lender.'),
  ('home', 'Home loan', true, 'feasibility_review', 365, 'Mortgage documents cannot be executed by eSign; physical / registered execution needed.'),
  ('loan_against_property', 'Loan against property', true, 'feasibility_review', 365, 'As for home loans; title and valuation workflows required.'),
  ('medical', 'Medical and insurance finance', false, 'feasibility_review', 91, 'Requires institutional partnerships and end-use routing to providers.'),
  ('legal_expense', 'Legal expense / award enforcement finance', false, 'feasibility_review', 91, 'Ordinary repayable loans only; non-recourse funding is out of scope.'),
  ('resolution_finance', 'Resolution (settlement) finance', false, 'feasibility_review', 91,
   'Conflict of interest with an affiliated ADR platform must be resolved before launch.'),
  ('debt_reset', 'Debt consolidation / reset', false, 'feasibility_review', 180,
   'Needs an approved affordability model; lenders must not evergreen stressed accounts.'),
  ('payday', 'Payday / very short-tenor loan', false, 'not_supported', 61,
   'Not supported: Google Play and Apple prohibit apps offering loans repayable in full within 60 days.');

-- ---------------------------------------------------------------------------------------------
-- Lender products and versioned terms. Applications pin the exact version they were made under.
-- ---------------------------------------------------------------------------------------------
create type lending.product_status as enum ('draft', 'active', 'suspended', 'retired');
create type lending.product_version_status as enum ('draft', 'pending_approval', 'approved', 'retired');

create table lending.loan_products (
  id uuid primary key default private.uuid_v7(),
  lender_org_id uuid not null references tenancy.organizations (id) on delete restrict,
  category_key text not null references lending.product_categories (key),
  code text not null check (code ~ '^[A-Z0-9_-]{2,40}$'),
  name text not null,
  status lending.product_status not null default 'draft',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (lender_org_id, code),
  unique (id, lender_org_id)
);
create index loan_products_category on lending.loan_products (category_key);
create trigger loan_products_set_updated_at before update on lending.loan_products
  for each row execute function private.set_updated_at();

create table lending.loan_product_versions (
  id uuid primary key default private.uuid_v7(),
  product_id uuid not null,
  lender_org_id uuid not null,
  version integer not null check (version > 0),
  status lending.product_version_status not null default 'draft',
  min_amount_minor bigint not null check (min_amount_minor > 0),
  max_amount_minor bigint not null check (max_amount_minor <= 100000000000000),
  min_tenure_days integer not null check (min_tenure_days > 0),
  max_tenure_days integer not null check (max_tenure_days <= 10950),
  rate_type text not null check (rate_type in ('fixed', 'floating')),
  min_annual_rate_bps integer not null check (min_annual_rate_bps >= 0),
  max_annual_rate_bps integer not null check (max_annual_rate_bps <= 10000),
  -- Fees, eligibility rules, document checklist etc. Validated against a versioned JSON schema by
  -- the API before saving; stored here so the exact approved terms are reproducible.
  config jsonb not null default '{}'::jsonb,
  config_schema_version integer not null default 1,
  drafted_by uuid not null references auth.users (id),
  approved_by uuid references auth.users (id),
  approved_at timestamptz,
  effective_from timestamptz,
  created_at timestamptz not null default now(),
  foreign key (product_id, lender_org_id) references lending.loan_products (id, lender_org_id) on delete restrict,
  unique (product_id, version),
  unique (id, lender_org_id),
  check (min_amount_minor <= max_amount_minor),
  check (min_tenure_days <= max_tenure_days),
  check (min_annual_rate_bps <= max_annual_rate_bps),
  constraint maker_checker check (approved_by is null or approved_by <> drafted_by),
  constraint approved_has_metadata check (
    status not in ('approved', 'retired') or (approved_by is not null and approved_at is not null and effective_from is not null)
  )
);
create index loan_product_versions_lender on lending.loan_product_versions (lender_org_id, status);

-- Approved versions are immutable (only approved -> retired); configuration cannot go below the
-- platform's tenure floor or be built on a category that is not enabled.
create or replace function private.protect_product_version()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_category lending.product_categories;
begin
  select c.* into v_category
  from lending.loan_products p join lending.product_categories c on c.key = p.category_key
  where p.id = new.product_id;

  if new.min_tenure_days < v_category.min_tenure_days then
    raise exception 'min tenure % days is below the platform floor of % days for category %',
      new.min_tenure_days, v_category.min_tenure_days, v_category.key using errcode = '23514';
  end if;

  if tg_op = 'UPDATE' and old.status in ('approved', 'retired') then
    if not (old.status = 'approved' and new.status = 'retired')
       or (to_jsonb(new) - 'status') is distinct from (to_jsonb(old) - 'status') then
      raise exception 'approved product versions are immutable; create a new version' using errcode = 'P0001';
    end if;
  end if;

  if new.status = 'approved' and (tg_op = 'INSERT' or old.status <> 'approved') then
    if v_category.availability <> 'enabled' then
      raise exception 'category % is not enabled on the platform (%)', v_category.key, v_category.availability
        using errcode = '23514';
    end if;
    -- In user context the approver must be the current user and must hold product.approve.
    if (select auth.uid()) is not null then
      if new.approved_by is distinct from (select auth.uid())
         or new.lender_org_id not in (select private.orgs_with_permission('product.approve')) then
        raise exception 'approval must be recorded by a user holding product.approve' using errcode = '42501';
      end if;
    end if;
  end if;
  return new;
end
$$;
create trigger loan_product_versions_protect before insert or update on lending.loan_product_versions
  for each row execute function private.protect_product_version();

-- ---------------------------------------------------------------------------------------------
-- Loan requests (borrower-owned, not yet tied to a lender).
-- ---------------------------------------------------------------------------------------------
create type lending.loan_request_status as enum ('draft', 'submitted', 'offer_selected', 'withdrawn', 'expired', 'closed');

create table lending.loan_requests (
  id uuid primary key default private.uuid_v7(),
  borrower_id uuid not null references identity.borrowers (id) on delete restrict,
  category_key text not null references lending.product_categories (key),
  requested_amount_minor bigint not null check (requested_amount_minor > 0 and requested_amount_minor <= 100000000000000),
  requested_tenure_days integer not null check (requested_tenure_days between 1 and 10950),
  purpose_code text not null check (purpose_code ~ '^[a-z_]+$'),
  status lending.loan_request_status not null default 'draft',
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index loan_requests_borrower on lending.loan_requests (borrower_id, created_at desc);
create trigger loan_requests_set_updated_at before update on lending.loan_requests
  for each row execute function private.set_updated_at();

-- Borrowers may only submit or withdraw their own request, and edit terms while it is a draft.
-- Every other change (offer selection, expiry, closure) is made by the system.
create or replace function private.protect_loan_request()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if private.current_actor() = 'system' then
    return new;
  end if;
  if old.status <> 'draft'
     and (new.requested_amount_minor, new.requested_tenure_days, new.purpose_code, new.category_key)
         is distinct from (old.requested_amount_minor, old.requested_tenure_days, old.purpose_code, old.category_key) then
    raise exception 'loan request terms can only change while in draft' using errcode = 'P0001';
  end if;
  if new.status is distinct from old.status
     and not ((old.status = 'draft' and new.status in ('submitted', 'withdrawn'))
              or (old.status = 'submitted' and new.status = 'withdrawn')) then
    raise exception 'loan request transition % -> % is not allowed for this actor', old.status, new.status
      using errcode = '42501';
  end if;
  return new;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Applications (one per lender per loan request) and their lifecycle.
-- ---------------------------------------------------------------------------------------------
create type lending.application_status as enum (
  'draft', 'submitted', 'under_review', 'info_requested', 'approved', 'rejected', 'offer_accepted',
  'agreement_pending', 'agreement_executed', 'disbursement_pending', 'disbursed',
  'withdrawn', 'expired', 'cancelled'
);

create table lending.applications (
  id uuid primary key default private.uuid_v7(),
  lender_org_id uuid not null references tenancy.organizations (id) on delete restrict,
  loan_request_id uuid not null references lending.loan_requests (id) on delete restrict,
  borrower_id uuid not null references identity.borrowers (id) on delete restrict,
  product_version_id uuid not null,
  status lending.application_status not null default 'draft',
  requested_amount_minor bigint not null check (requested_amount_minor > 0),
  requested_tenure_days integer not null check (requested_tenure_days > 0),
  -- The lender's own reference (LOS/LMS id) once the lender has accepted the application.
  lender_reference text,
  submitted_at timestamptz,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (product_version_id, lender_org_id) references lending.loan_product_versions (id, lender_org_id),
  unique (loan_request_id, lender_org_id),
  unique (id, lender_org_id)
);
create index applications_lender_queue on lending.applications (lender_org_id, status, created_at);
create index applications_borrower on lending.applications (borrower_id, created_at desc);
-- Only one lender can proceed past offer acceptance for a given loan request.
create unique index applications_one_accepted_per_request on lending.applications (loan_request_id)
  where status in ('offer_accepted', 'agreement_pending', 'agreement_executed', 'disbursement_pending', 'disbursed');
create trigger applications_set_updated_at before update on lending.applications
  for each row execute function private.set_updated_at();

-- Allowed transitions and WHO may perform them. 'system' means a trusted backend process with no
-- end-user session (service_role), e.g. an LMS callback or a verified eSign webhook.
create table lending.application_transitions (
  from_status lending.application_status not null,
  to_status lending.application_status not null,
  allowed_actors text[] not null check (allowed_actors <@ array['borrower', 'lender', 'system']),
  primary key (from_status, to_status)
);
comment on table lending.application_transitions is
  'Application lifecycle. Mirrors packages/domain applicationLifecycle; both are tested.';

insert into lending.application_transitions (from_status, to_status, allowed_actors) values
  ('draft', 'submitted', array['borrower']),
  ('draft', 'withdrawn', array['borrower']),
  ('draft', 'expired', array['system']),
  ('submitted', 'under_review', array['lender', 'system']),
  ('submitted', 'rejected', array['lender', 'system']),
  ('submitted', 'withdrawn', array['borrower']),
  ('submitted', 'expired', array['system']),
  ('under_review', 'info_requested', array['lender', 'system']),
  ('under_review', 'approved', array['lender', 'system']),
  ('under_review', 'rejected', array['lender', 'system']),
  ('under_review', 'withdrawn', array['borrower']),
  ('info_requested', 'under_review', array['borrower', 'lender', 'system']),
  ('info_requested', 'withdrawn', array['borrower']),
  ('info_requested', 'expired', array['system']),
  ('approved', 'offer_accepted', array['borrower']),
  ('approved', 'withdrawn', array['borrower']),
  ('approved', 'expired', array['system']),
  ('approved', 'cancelled', array['lender', 'system']),
  ('offer_accepted', 'agreement_pending', array['system']),
  ('offer_accepted', 'withdrawn', array['borrower']),
  ('offer_accepted', 'cancelled', array['lender', 'system']),
  ('agreement_pending', 'agreement_executed', array['system']),
  ('agreement_pending', 'withdrawn', array['borrower']),
  ('agreement_pending', 'expired', array['system']),
  ('agreement_pending', 'cancelled', array['lender', 'system']),
  ('agreement_executed', 'disbursement_pending', array['lender', 'system']),
  ('agreement_executed', 'withdrawn', array['borrower']),
  ('agreement_executed', 'cancelled', array['lender', 'system']),
  ('disbursement_pending', 'disbursed', array['system']),
  ('disbursement_pending', 'cancelled', array['lender', 'system']);

create table lending.application_events (
  id uuid primary key default private.uuid_v7(),
  application_id uuid not null,
  lender_org_id uuid not null,
  from_status lending.application_status,
  to_status lending.application_status not null,
  actor text not null check (actor in ('borrower', 'lender', 'system')),
  actor_user_id uuid,
  reason text,
  occurred_at timestamptz not null default clock_timestamp(),
  foreign key (application_id, lender_org_id) references lending.applications (id, lender_org_id) on delete restrict
);
create index application_events_application on lending.application_events (application_id, occurred_at);
create trigger application_events_append_only before update or delete on lending.application_events
  for each row execute function private.forbid_mutation();

-- Who is acting in the current transaction: a borrower, lender/platform staff, or the system.
create or replace function private.current_actor()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when (select auth.uid()) is null then 'system'
    when exists (select 1 from identity.borrowers b where b.user_id = (select auth.uid())) then 'borrower'
    else 'lender'
  end
$$;
revoke all on function private.current_actor() from public;
grant execute on function private.current_actor() to authenticated, service_role;

-- Enforces the transition table and actor rules, and writes the lifecycle event in the same
-- transaction, so no status change can happen without a trace.
create or replace function private.enforce_application_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor text := private.current_actor();
  v_allowed text[];
  v_reason text := nullif(current_setting('udofin.transition_reason', true), '');
begin
  if v_actor = 'borrower' and new.lender_reference is distinct from old.lender_reference then
    raise exception 'borrowers cannot change the lender reference' using errcode = '42501';
  end if;
  if new.status is distinct from old.status then
    select t.allowed_actors into v_allowed
    from lending.application_transitions t
    where t.from_status = old.status and t.to_status = new.status;

    if v_allowed is null then
      raise exception 'application transition % -> % is not allowed', old.status, new.status using errcode = 'P0001';
    end if;
    if not (v_actor = any (v_allowed)) then
      raise exception 'actor % may not move an application % -> %', v_actor, old.status, new.status
        using errcode = '42501';
    end if;
    if new.status = 'submitted' then new.submitted_at := coalesce(new.submitted_at, now()); end if;
    if new.status in ('approved', 'rejected') then new.decided_at := coalesce(new.decided_at, now()); end if;
  else
    return new;
  end if;

  insert into lending.application_events (application_id, lender_org_id, from_status, to_status, actor, actor_user_id, reason)
  values (new.id, new.lender_org_id, case when tg_op = 'UPDATE' then old.status end, new.status, v_actor,
          (select auth.uid()), v_reason);
  return new;
end
$$;
-- BEFORE-update can log directly; insert logging runs AFTER insert because the event's FK needs the row.
create trigger loan_requests_protect before update on lending.loan_requests
  for each row execute function private.protect_loan_request();

create trigger applications_lifecycle_update before update on lending.applications
  for each row execute function private.enforce_application_lifecycle();

create or replace function private.log_application_created()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status <> 'draft' and private.current_actor() <> 'system' then
    raise exception 'applications must start in draft' using errcode = '23514';
  end if;
  insert into lending.application_events (application_id, lender_org_id, from_status, to_status, actor, actor_user_id, reason)
  values (new.id, new.lender_org_id, null, new.status, private.current_actor(), (select auth.uid()),
          nullif(current_setting('udofin.transition_reason', true), ''));
  return new;
end
$$;
create trigger applications_lifecycle_insert after insert on lending.applications
  for each row execute function private.log_application_created();

revoke all on function private.enforce_application_lifecycle() from public;
revoke all on function private.log_application_created() from public;

-- ---------------------------------------------------------------------------------------------
-- Offers. Terms are frozen once issued; only the status may change afterwards.
-- ---------------------------------------------------------------------------------------------
create type lending.offer_status as enum ('issued', 'accepted', 'declined', 'expired', 'withdrawn');
create type lending.installment_frequency as enum ('monthly', 'fortnightly', 'weekly');

create table lending.offers (
  id uuid primary key default private.uuid_v7(),
  lender_org_id uuid not null,
  application_id uuid not null,
  status lending.offer_status not null default 'issued',
  principal_minor bigint not null check (principal_minor > 0),
  tenure_days integer not null check (tenure_days > 0),
  installment_frequency lending.installment_frequency not null,
  installment_count integer not null check (installment_count > 0),
  installment_amount_minor bigint not null check (installment_amount_minor > 0),
  annual_interest_rate_bps integer not null check (annual_interest_rate_bps between 0 and 10000),
  -- Annual Percentage Rate including all fees and charges, as disclosed in the KFS.
  apr_bps integer not null check (apr_bps between 0 and 20000),
  processing_fee_minor bigint not null default 0 check (processing_fee_minor >= 0),
  other_charges jsonb not null default '[]'::jsonb,
  total_repayable_minor bigint not null check (total_repayable_minor >= principal_minor),
  penal_charges_summary text not null,
  -- Set once the Key Facts Statement document is generated and stored (Phase 7).
  kfs_document_id uuid,
  valid_until timestamptz not null,
  issued_at timestamptz not null default now(),
  responded_at timestamptz,
  created_by uuid references auth.users (id),
  foreign key (application_id, lender_org_id) references lending.applications (id, lender_org_id) on delete restrict
);
create index offers_application on lending.offers (application_id);
create index offers_lender on lending.offers (lender_org_id, status);
create unique index offers_one_live_per_application on lending.offers (application_id) where status in ('issued', 'accepted');

create or replace function private.protect_offer()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (to_jsonb(new) - array['status', 'responded_at']) is distinct from (to_jsonb(old) - array['status', 'responded_at']) then
    raise exception 'offer terms are immutable once issued; withdraw and issue a new offer' using errcode = 'P0001';
  end if;
  if old.status <> 'issued' and new.status is distinct from old.status then
    raise exception 'offer status % is final', old.status using errcode = 'P0001';
  end if;
  if new.status = 'accepted' and old.status = 'issued' then
    if new.valid_until < now() then
      raise exception 'offer has expired' using errcode = 'P0001';
    end if;
    if private.current_actor() <> 'borrower' then
      raise exception 'only the borrower can accept an offer' using errcode = '42501';
    end if;
  end if;
  if new.status is distinct from old.status then
    new.responded_at := coalesce(new.responded_at, now());
  end if;
  return new;
end
$$;
create trigger offers_protect before update on lending.offers
  for each row execute function private.protect_offer();
create trigger offers_no_delete before delete on lending.offers
  for each row execute function private.forbid_mutation();

-- ---------------------------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------------------------
alter table lending.product_categories enable row level security;
alter table lending.application_transitions enable row level security;
alter table lending.loan_products enable row level security;
alter table lending.loan_products force row level security;
alter table lending.loan_product_versions enable row level security;
alter table lending.loan_product_versions force row level security;
alter table lending.loan_requests enable row level security;
alter table lending.loan_requests force row level security;
alter table lending.applications enable row level security;
alter table lending.applications force row level security;
alter table lending.application_events enable row level security;
alter table lending.application_events force row level security;
alter table lending.offers enable row level security;
alter table lending.offers force row level security;

create policy categories_read on lending.product_categories for select to authenticated using (true);
create policy transitions_read on lending.application_transitions for select to authenticated using (true);

-- Products: lender staff (and platform staff with grantable permissions).
create policy products_read on lending.loan_products for select to authenticated
  using (lender_org_id in (select private.orgs_with_permission('product.read')));
create policy products_insert on lending.loan_products for insert to authenticated
  with check (lender_org_id in (select private.orgs_with_permission('product.configure')));
create policy products_update on lending.loan_products for update to authenticated
  using (lender_org_id in (select private.orgs_with_permission('product.configure')))
  with check (lender_org_id in (select private.orgs_with_permission('product.configure')));

create policy versions_read on lending.loan_product_versions for select to authenticated
  using (lender_org_id in (select private.orgs_with_permission('product.read')));
create policy versions_insert on lending.loan_product_versions for insert to authenticated
  with check (
    lender_org_id in (select private.orgs_with_permission('product.configure'))
    and status = 'draft' and drafted_by = (select auth.uid())
  );
create policy versions_update on lending.loan_product_versions for update to authenticated
  using (
    lender_org_id in (select private.orgs_with_permission('product.configure'))
    or lender_org_id in (select private.orgs_with_permission('product.approve'))
  )
  with check (
    lender_org_id in (select private.orgs_with_permission('product.configure'))
    or lender_org_id in (select private.orgs_with_permission('product.approve'))
  );

-- Loan requests: the borrower's own; platform operations staff for exception handling.
create policy requests_borrower_read on lending.loan_requests for select to authenticated
  using (borrower_id = (select private.my_borrower_id()));
create policy requests_platform_read on lending.loan_requests for select to authenticated
  using ((select private.has_platform_permission('application.read')));
create policy requests_borrower_insert on lending.loan_requests for insert to authenticated
  with check (borrower_id = (select private.my_borrower_id()) and status = 'draft');
create policy requests_borrower_update on lending.loan_requests for update to authenticated
  using (borrower_id = (select private.my_borrower_id()))
  with check (borrower_id = (select private.my_borrower_id()));

-- Applications: the borrower's own; staff of the lender it was routed to.
create policy applications_borrower_read on lending.applications for select to authenticated
  using (borrower_id = (select private.my_borrower_id()));
create policy applications_lender_read on lending.applications for select to authenticated
  using (lender_org_id in (select private.orgs_with_permission('application.read')));
create policy applications_borrower_update on lending.applications for update to authenticated
  using (borrower_id = (select private.my_borrower_id()))
  with check (borrower_id = (select private.my_borrower_id()));
create policy applications_lender_update on lending.applications for update to authenticated
  using (lender_org_id in (select private.orgs_with_permission('application.decide')))
  with check (lender_org_id in (select private.orgs_with_permission('application.decide')));

create policy application_events_borrower_read on lending.application_events for select to authenticated
  using (application_id in (select a.id from lending.applications a where a.borrower_id = (select private.my_borrower_id())));
create policy application_events_lender_read on lending.application_events for select to authenticated
  using (lender_org_id in (select private.orgs_with_permission('application.read')));

create policy offers_borrower_read on lending.offers for select to authenticated
  using (application_id in (select a.id from lending.applications a where a.borrower_id = (select private.my_borrower_id())));
create policy offers_lender_read on lending.offers for select to authenticated
  using (lender_org_id in (select private.orgs_with_permission('application.read')));
create policy offers_lender_insert on lending.offers for insert to authenticated
  with check (lender_org_id in (select private.orgs_with_permission('application.decide')) and status = 'issued');
create policy offers_borrower_respond on lending.offers for update to authenticated
  using (application_id in (select a.id from lending.applications a where a.borrower_id = (select private.my_borrower_id())))
  with check (status in ('accepted', 'declined'));
create policy offers_lender_withdraw on lending.offers for update to authenticated
  using (lender_org_id in (select private.orgs_with_permission('application.decide')))
  with check (status = 'withdrawn');

-- Column-level grants: tenant keys, borrower ids and amounts can never be rewritten by users.
grant select on lending.product_categories, lending.application_transitions to authenticated;
grant select, insert on lending.loan_products to authenticated;
grant update (name, status) on lending.loan_products to authenticated;
grant select, insert on lending.loan_product_versions to authenticated;
grant update (status, min_amount_minor, max_amount_minor, min_tenure_days, max_tenure_days, rate_type,
  min_annual_rate_bps, max_annual_rate_bps, config, approved_by, approved_at, effective_from)
  on lending.loan_product_versions to authenticated;
grant select, insert on lending.loan_requests to authenticated;
grant update (status, requested_amount_minor, requested_tenure_days, purpose_code) on lending.loan_requests to authenticated;
-- Applications are created by the API/system when a consented request is routed to a lender.
grant select on lending.applications to authenticated;
grant update (status, lender_reference) on lending.applications to authenticated;
grant select on lending.application_events to authenticated;
grant select, insert on lending.offers to authenticated;
grant update (status) on lending.offers to authenticated;
