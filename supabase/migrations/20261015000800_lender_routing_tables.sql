-- =============================================================================================
-- Phase 06: lender routing, lender-reported verification, decisions, offers and comparison.
-- Part 1: tables, columns and policies. Part 2 (…801) holds the functions.
--
-- Principles: the lender decides and owns every KYC, bureau and account-aggregator artefact; Udofin
-- records only lender-reported statuses. No phone number is ever stored here: the lender receives it
-- at transmission time from the authentication record, after consent is re-checked. Offer terms are
-- stored exactly as the lender supplied them and are never recalculated.
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- Permission for platform staff who configure lender connectors and offer-ordering rules.
-- ---------------------------------------------------------------------------------------------
insert into tenancy.permissions (key, description, platform_grantable, platform_only) values
  ('platform.lender_routing.manage', 'Configure lender connectors and propose or approve offer-ordering rules', false, true);
insert into tenancy.role_permissions (role_id, permission_key)
select r.id, 'platform.lender_routing.manage' from tenancy.roles r
where r.org_id is null and r.applies_to = 'platform' and r.key = 'platform_admin';

-- D-19: the iOS 36% APR filter exists but is off. Changed only through onboarding.set_setting (compliance).
insert into onboarding.platform_settings (key, bool_value, description) values
  ('ios_apr_filter_enabled', false,
   'When true, offers with a lender-supplied APR above 36% are not shown to borrowers on iOS. Off until D-19 is decided. Never changes the lender''s APR.');

-- ---------------------------------------------------------------------------------------------
-- Lender connector configuration (no secrets: only the NAME of the secret holding a signing key)
-- ---------------------------------------------------------------------------------------------
create or replace function private.valid_hosts(p_hosts text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(bool_and(h ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' and length(h) <= 253), true)
  from unnest(p_hosts) as h
$$;

revoke all on function private.valid_hosts(text[]) from public;
grant execute on function private.valid_hosts(text[]) to authenticated, service_role;

create table lending.lender_connectors (
  lender_org_id uuid primary key references tenancy.organizations (id) on delete restrict,
  -- manual: the lender works in the lender portal; api: a real connector (none exists yet); mock: tests only.
  kind text not null check (kind in ('manual', 'api', 'mock')),
  status text not null default 'draft' check (status in ('draft', 'active', 'suspended')),
  response_hours integer not null default 48 check (response_hours between 1 and 720),
  offer_min_validity_days integer not null default 7 check (offer_min_validity_days between 7 and 365),
  kfs_allowed_hosts text[] not null default '{}' check (cardinality(kfs_allowed_hosts) <= 20 and private.valid_hosts(kfs_allowed_hosts)),
  signing_secret_ref text check (signing_secret_ref is null or signing_secret_ref ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  updated_by uuid references auth.users (id),
  updated_at timestamptz not null default now()
);
comment on table lending.lender_connectors is
  'How Udofin reaches each lender (manual portal, real API connector, or test mock), its response window, offer-validity floor and the hosts its KFS links may use. Holds the NAME of a secret, never a secret. Owner: lending module.';

-- A mock connector can exist only where the database session explicitly allows it (tests); it can never be configured through the API.
create or replace function private.guard_mock_connector()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.kind = 'mock' and coalesce(current_setting('udofin.allow_mock_connectors', true), '') <> 'on' then
    raise exception 'mock connectors are for local development and tests only' using errcode = '42501', hint = 'mock_connector_blocked';
  end if;
  return new;
end
$$;
create trigger lender_connectors_guard before insert or update on lending.lender_connectors
  for each row execute function private.guard_mock_connector();

-- ---------------------------------------------------------------------------------------------
-- Offer-ordering rules: proposals need a second person; approved versions live in the existing append-only table.
-- ---------------------------------------------------------------------------------------------
alter table lending.matching_rule_versions
  add column sort_keys text[] not null default array['apr_bps', 'monthly_repayment_minor'],
  add column alternative_sorts text[] not null default array['monthly_repayment_minor', 'total_repayable_minor'],
  add constraint matching_sort_keys_known check (
    sort_keys <@ array['apr_bps', 'monthly_repayment_minor', 'total_repayable_minor'] and cardinality(sort_keys) between 1 and 2
    and alternative_sorts <@ array['apr_bps', 'monthly_repayment_minor', 'total_repayable_minor']);

create table lending.matching_rule_proposals (
  id uuid primary key default private.uuid_v7(),
  mechanism_summary text not null check (length(mechanism_summary) between 20 and 4000),
  disclosed_metric text not null check (length(disclosed_metric) between 5 and 500),
  sort_keys text[] not null check (sort_keys <@ array['apr_bps', 'monthly_repayment_minor', 'total_repayable_minor'] and cardinality(sort_keys) between 1 and 2),
  alternative_sorts text[] not null default '{}' check (alternative_sorts <@ array['apr_bps', 'monthly_repayment_minor', 'total_repayable_minor']),
  effective_from timestamptz not null,
  status text not null default 'proposed' check (status in ('proposed', 'approved', 'rejected')),
  proposed_by uuid not null references auth.users (id),
  decided_by uuid references auth.users (id),
  decided_at timestamptz,
  resulting_version_id uuid references lending.matching_rule_versions (id),
  created_at timestamptz not null default now(),
  check (decided_by is null or decided_by <> proposed_by)
);
comment on table lending.matching_rule_proposals is
  'Proposed offer-ordering rules. A different platform administrator must approve (D-16: the owner approves rule changes). Owner: lending module.';

-- ---------------------------------------------------------------------------------------------
-- Lender selection (what the borrower chose, with the product, before any consent or routing)
-- ---------------------------------------------------------------------------------------------
create table lending.lender_selections (
  id uuid primary key default private.uuid_v7(),
  loan_request_id uuid not null references lending.loan_requests (id) on delete restrict,
  borrower_id uuid not null references identity.borrowers (id) on delete restrict,
  status text not null default 'open' check (status in ('open', 'routed', 'cancelled')),
  created_at timestamptz not null default now(),
  closed_at timestamptz
);
create unique index lender_selections_one_open on lending.lender_selections (loan_request_id) where status = 'open';
create index lender_selections_borrower on lending.lender_selections (borrower_id, created_at desc);

create table lending.lender_selection_items (
  id uuid primary key default private.uuid_v7(),
  selection_id uuid not null references lending.lender_selections (id) on delete restrict,
  lender_org_id uuid not null references tenancy.organizations (id) on delete restrict,
  product_version_id uuid not null,
  status text not null default 'selected' check (status in ('selected', 'consented', 'routed', 'removed')),
  consent_record_id uuid references consent.records (id),
  created_at timestamptz not null default now(),
  unique (selection_id, lender_org_id),
  foreign key (product_version_id, lender_org_id) references lending.loan_product_versions (id, lender_org_id)
);
comment on table lending.lender_selection_items is
  'The lenders (and the product of each) a borrower chose for one request. At most five per request, enforced by the routing function and the application count. Owner: lending module.';

-- ---------------------------------------------------------------------------------------------
-- Routing: one row per lender application. Never holds contact details or the outbound payload.
-- ---------------------------------------------------------------------------------------------
create table lending.application_routing (
  application_id uuid primary key,
  lender_org_id uuid not null,
  loan_request_id uuid not null references lending.loan_requests (id) on delete restrict,
  selection_item_id uuid not null references lending.lender_selection_items (id),
  consent_record_id uuid not null references consent.records (id),
  -- Stable reference sent to the lender for correlation and de-duplication. Not the lender's own id.
  correlation_ref uuid not null unique default gen_random_uuid(),
  transmission_status text not null default 'queued' check (transmission_status in
    ('queued', 'transmitting', 'transmitted', 'acknowledged', 'uncertain', 'failed', 'stopped_consent', 'cancelled')),
  attempts integer not null default 0 check (attempts >= 0),
  response_due_at timestamptz not null,
  -- The lender's own application reference, set only when the lender gave one.
  lender_application_ref text check (lender_application_ref is null or length(lender_application_ref) between 1 and 100),
  transmitted_at timestamptz,
  acknowledged_at timestamptz,
  last_error_class text check (last_error_class is null or last_error_class ~ '^[a-z_]{2,40}$'),
  no_response_at timestamptz,
  consent_withdrawn_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (application_id, lender_org_id) references lending.applications (id, lender_org_id) on delete restrict
);
create index application_routing_due on lending.application_routing (response_due_at) where no_response_at is null;
create index application_routing_lender on lending.application_routing (lender_org_id, transmission_status);
create index application_routing_request on lending.application_routing (loan_request_id);
create trigger application_routing_updated before update on lending.application_routing
  for each row execute function private.set_updated_at();
comment on table lending.application_routing is
  'Transmission state of each lender application. No phone number, name or payload is stored here. Owner: lending module.';

create table lending.routing_events (
  id uuid primary key default private.uuid_v7(),
  application_id uuid not null,
  lender_org_id uuid not null,
  event text not null check (event ~ '^[a-z_]{2,50}$'),
  detail jsonb not null default '{}'::jsonb,
  actor text not null check (actor in ('borrower', 'lender', 'system')),
  occurred_at timestamptz not null default clock_timestamp(),
  foreign key (application_id, lender_org_id) references lending.applications (id, lender_org_id) on delete restrict
);
create index routing_events_application on lending.routing_events (application_id, occurred_at);

-- ---------------------------------------------------------------------------------------------
-- Lender-reported verification statuses (status only: no documents, numbers, reports or scores)
-- ---------------------------------------------------------------------------------------------
create table lending.application_checks (
  id uuid primary key default private.uuid_v7(),
  application_id uuid not null,
  lender_org_id uuid not null,
  kind text not null check (kind in ('kyc', 'bureau', 'account_aggregator')),
  -- Provisional vocabulary pending the lenders' own (D-39). Reported by the lender, not verified by Udofin.
  status text not null check (status in ('not_started', 'in_progress', 'completed', 'failed')),
  source text not null check (source in ('manual', 'connector')),
  lender_event_ref text check (lender_event_ref is null or length(lender_event_ref) between 1 and 100),
  reported_at timestamptz not null,
  recorded_by uuid references auth.users (id),
  recorded_at timestamptz not null default clock_timestamp(),
  foreign key (application_id, lender_org_id) references lending.applications (id, lender_org_id) on delete restrict
);
create index application_checks_latest on lending.application_checks (application_id, kind, recorded_at desc);

create view lending.application_check_status with (security_invoker = true) as
select distinct on (application_id, kind) application_id, lender_org_id, kind, status, source, lender_event_ref, reported_at, recorded_at
from lending.application_checks order by application_id, kind, recorded_at desc, id desc;

-- ---------------------------------------------------------------------------------------------
-- Lender decisions and inbound message de-duplication
-- ---------------------------------------------------------------------------------------------
create table lending.lender_decisions (
  id uuid primary key default private.uuid_v7(),
  application_id uuid not null,
  lender_org_id uuid not null,
  decision text not null check (decision in ('pending', 'processing', 'info_needed', 'declined', 'approved')),
  source text not null check (source in ('manual', 'connector')),
  lender_event_ref text check (lender_event_ref is null or length(lender_event_ref) between 1 and 100),
  reported_at timestamptz not null,
  -- Arrived after the response deadline. No late-response policy exists yet (D-40): recorded, not applied.
  late boolean not null default false,
  applied boolean not null default true,
  apply_note text check (apply_note is null or apply_note ~ '^[a-z_]{2,50}$'),
  recorded_by uuid references auth.users (id),
  recorded_at timestamptz not null default clock_timestamp(),
  foreign key (application_id, lender_org_id) references lending.applications (id, lender_org_id) on delete restrict
);
create index lender_decisions_application on lending.lender_decisions (application_id, recorded_at desc);

create table lending.inbound_messages (
  id uuid primary key default private.uuid_v7(),
  lender_org_id uuid not null references tenancy.organizations (id) on delete restrict,
  message_id text not null check (message_id ~ '^[A-Za-z0-9._:-]{8,100}$'),
  event_type text not null check (event_type ~ '^[a-z_]{2,40}$'),
  outcome text not null default 'received' check (outcome in ('received', 'applied', 'rejected', 'quarantined')),
  reason_class text check (reason_class is null or reason_class ~ '^[a-z_]{2,50}$'),
  received_at timestamptz not null default now(),
  unique (lender_org_id, message_id)
);

-- ---------------------------------------------------------------------------------------------
-- Offers: extra lender-supplied fields, an intake log of exactly what the lender submitted
-- ---------------------------------------------------------------------------------------------
alter table lending.offers
  add column monthly_repayment_minor bigint check (monthly_repayment_minor is null or monthly_repayment_minor > 0),
  add column kfs_url text check (kfs_url is null or (length(kfs_url) <= 2048 and kfs_url ~ '^https://[^/@\s\\]+(/[^\s\\]*)?$')),
  add column lender_offer_ref text check (lender_offer_ref is null or length(lender_offer_ref) between 1 and 100),
  add column revision integer not null default 1 check (revision > 0),
  add column supersedes_offer_id uuid references lending.offers (id),
  add column lender_issued_at timestamptz,
  add column source text check (source is null or source in ('manual', 'connector'));
create unique index offers_ref_revision on lending.offers (application_id, lender_offer_ref, revision) where lender_offer_ref is not null;

create table lending.offer_intake (
  id uuid primary key default private.uuid_v7(),
  application_id uuid not null,
  lender_org_id uuid not null,
  -- Only the approved offer fields, exactly as submitted (unknown fields are dropped and flagged).
  submitted jsonb not null,
  validation text not null check (validation in ('accepted', 'held')),
  issues text[] not null default '{}',
  offer_id uuid references lending.offers (id),
  source text not null check (source in ('manual', 'connector')),
  submitted_by uuid references auth.users (id),
  submitted_at timestamptz not null default clock_timestamp(),
  foreign key (application_id, lender_org_id) references lending.applications (id, lender_org_id) on delete restrict
);
create index offer_intake_application on lending.offer_intake (application_id, submitted_at desc);

-- ---------------------------------------------------------------------------------------------
-- Comparison views: what a borrower was shown (offers, ranks, rule version) and which lenders did not offer
-- ---------------------------------------------------------------------------------------------
create table lending.comparison_runs (
  id uuid primary key default private.uuid_v7(),
  borrower_id uuid not null references identity.borrowers (id) on delete restrict,
  loan_request_id uuid not null references lending.loan_requests (id) on delete restrict,
  rule_version_id uuid not null references lending.matching_rule_versions (id),
  sort_key text not null,
  platform text not null check (platform in ('android', 'ios', 'web')),
  ios_filter_applied boolean not null default false,
  filtered_count integer not null default 0,
  language text not null check (language in ('en', 'hi')),
  viewed_at timestamptz not null default clock_timestamp()
);
create index comparison_runs_borrower on lending.comparison_runs (borrower_id, viewed_at desc);

create table lending.comparison_nonoffers (
  id uuid primary key default private.uuid_v7(),
  run_id uuid not null references lending.comparison_runs (id) on delete restrict,
  lender_org_id uuid not null references tenancy.organizations (id) on delete restrict,
  application_id uuid not null,
  reason_class text not null check (reason_class in
    ('declined', 'no_response', 'processing', 'technical_failure', 'offer_unavailable'))
);
create index comparison_nonoffers_run on lending.comparison_nonoffers (run_id);

alter table lending.offer_displays add column run_id uuid references lending.comparison_runs (id) on delete restrict;
alter table lending.offer_displays add column offer_revision integer;

-- ---------------------------------------------------------------------------------------------
-- History is append-only everywhere it records what someone reported or saw; no table here allows deletes.
-- ---------------------------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['routing_events', 'application_checks', 'lender_decisions', 'offer_intake', 'comparison_runs', 'comparison_nonoffers']
  loop
    execute format('create trigger append_only before update or delete on lending.%I for each row execute function private.forbid_mutation()', t);
    execute format('create trigger no_truncate before truncate on lending.%I for each statement execute function private.forbid_truncate()', t);
  end loop;
  foreach t in array array['lender_connectors', 'matching_rule_proposals', 'lender_selections', 'lender_selection_items', 'application_routing', 'inbound_messages']
  loop
    execute format('create trigger no_delete before delete on lending.%I for each row execute function private.forbid_mutation()', t);
    execute format('create trigger no_truncate before truncate on lending.%I for each statement execute function private.forbid_truncate()', t);
  end loop;
  foreach t in array array['lender_connectors', 'matching_rule_proposals', 'lender_selections', 'lender_selection_items', 'application_routing',
                           'routing_events', 'application_checks', 'lender_decisions', 'inbound_messages', 'offer_intake',
                           'comparison_runs', 'comparison_nonoffers']
  loop
    execute format('alter table lending.%I enable row level security', t);
    execute format('alter table lending.%I force row level security', t);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Read access (all writes go through the functions in the next migration)
-- ---------------------------------------------------------------------------------------------
create policy connectors_read on lending.lender_connectors for select to authenticated
  using (lender_org_id in (select private.orgs_with_permission('application.read')) or (select private.has_platform_permission('platform.lender_routing.manage')));
create policy proposals_read on lending.matching_rule_proposals for select to authenticated
  using ((select private.has_platform_permission('platform.lender_routing.manage')));

create policy selections_borrower_read on lending.lender_selections for select to authenticated
  using (borrower_id = (select private.my_borrower_id()));
create policy selection_items_borrower_read on lending.lender_selection_items for select to authenticated
  using (selection_id in (select s.id from lending.lender_selections s where s.borrower_id = (select private.my_borrower_id())));

create policy routing_borrower_read on lending.application_routing for select to authenticated
  using (application_id in (select a.id from lending.applications a where a.borrower_id = (select private.my_borrower_id())));
create policy routing_lender_read on lending.application_routing for select to authenticated
  using (lender_org_id in (select private.orgs_with_permission('application.read')));
create policy routing_events_borrower_read on lending.routing_events for select to authenticated
  using (application_id in (select a.id from lending.applications a where a.borrower_id = (select private.my_borrower_id())));
create policy routing_events_lender_read on lending.routing_events for select to authenticated
  using (lender_org_id in (select private.orgs_with_permission('application.read')));

create policy checks_borrower_read on lending.application_checks for select to authenticated
  using (application_id in (select a.id from lending.applications a where a.borrower_id = (select private.my_borrower_id())));
create policy checks_lender_read on lending.application_checks for select to authenticated
  using (lender_org_id in (select private.orgs_with_permission('application.read')));
create policy decisions_lender_read on lending.lender_decisions for select to authenticated
  using (lender_org_id in (select private.orgs_with_permission('application.read')));
create policy inbound_lender_read on lending.inbound_messages for select to authenticated
  using (lender_org_id in (select private.orgs_with_permission('application.read')));
create policy intake_lender_read on lending.offer_intake for select to authenticated
  using (lender_org_id in (select private.orgs_with_permission('application.read')));

create policy runs_borrower_read on lending.comparison_runs for select to authenticated
  using (borrower_id = (select private.my_borrower_id()));
create policy runs_platform_read on lending.comparison_runs for select to authenticated
  using ((select private.has_platform_permission('application.read')));
create policy nonoffers_borrower_read on lending.comparison_nonoffers for select to authenticated
  using (run_id in (select r.id from lending.comparison_runs r where r.borrower_id = (select private.my_borrower_id())));
create policy nonoffers_platform_read on lending.comparison_nonoffers for select to authenticated
  using ((select private.has_platform_permission('application.read')));

grant select on lending.lender_connectors, lending.matching_rule_proposals, lending.lender_selections, lending.lender_selection_items,
  lending.application_routing, lending.routing_events, lending.application_checks, lending.application_check_status,
  lending.lender_decisions, lending.inbound_messages, lending.offer_intake, lending.comparison_runs, lending.comparison_nonoffers
  to authenticated;
