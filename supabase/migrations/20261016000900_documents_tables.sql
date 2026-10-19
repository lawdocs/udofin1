-- =============================================================================================
-- Phase 07: Key Facts Statement, loan documents, acknowledgement, offer acceptance, signing boundary.
-- Part 1: tables, seeds and policies. Part 2 (…901, …902) holds the functions.
--
-- Principles: the lender is the author and approver of every legal and financial document; Udofin renders
-- what the lender supplied, never recalculates it, and never issues a document the lender has not approved.
-- Every issued document is an immutable version stored as exact bytes (hash recorded). Offer validity and KFS
-- validity are separate. Acknowledgement, acceptance, signature and delivery are separate facts.
-- =============================================================================================

create schema if not exists documents;
grant usage on schema documents to authenticated, service_role;
alter default privileges in schema documents revoke all on tables from public, anon, authenticated;
alter default privileges in schema documents revoke all on functions from public, anon;
alter default privileges in schema documents grant all on tables to service_role;
alter default privileges in schema documents revoke truncate on tables from service_role;

-- ---------------------------------------------------------------------------------------------
-- Permissions
-- ---------------------------------------------------------------------------------------------
insert into tenancy.permissions (key, description, platform_grantable, platform_only) values
  ('document.prepare', 'Enter KFS data for an offer and request document generation (lender staff)', false, false),
  ('document.approve', 'Approve, reject, issue or withdraw a lender document after reviewing the exact file (lender staff)', false, false),
  ('platform.documents.manage', 'Propose and approve regulatory applicability rules, regulator-format templates and working-day calendars', false, true);
insert into tenancy.role_permissions (role_id, permission_key)
select r.id, p.key
from tenancy.roles r
join (values ('lender', 'credit_officer', 'document.prepare'),
             ('lender', 'lender_admin', 'document.approve'),
             ('lender', 'credit_officer', 'document.approve'),
             ('platform', 'platform_admin', 'platform.documents.manage')) as p (applies_to, role_key, key)
  on p.applies_to = r.applies_to::text and p.role_key = r.key
where r.org_id is null;

-- D-13 / D-58: no signing provider or legal signing method is approved. Switched only through onboarding.set_setting.
insert into onboarding.platform_settings (key, bool_value, description) values
  ('esign_provider_approved', false,
   'True only after the signing provider and legal method are approved (D-13, D-58). While false, signing is unavailable except for the labelled mock in local and test environments.');

-- ---------------------------------------------------------------------------------------------
-- Document catalogue: the TYPES that may exist. A type is usable only when an approved template and an approved
-- applicability rule exist for the lender; nothing here drafts legal text.
-- ---------------------------------------------------------------------------------------------
create table documents.document_types (
  key text primary key check (key ~ '^[a-z_]{2,40}$'),
  description text not null,
  issuing_authority text not null default 'lender' check (issuing_authority = 'lender'),
  data_source text not null check (data_source in ('kfs_data', 'kfs_data_and_template', 'lender_template')),
  needs_acknowledgement boolean not null default false,
  needs_lender_approval boolean not null default true,
  -- Retention periods are NOT defined (D-25). The class is a label only.
  retention_class text not null default 'pending_d25'
);
comment on table documents.document_types is
  'Catalogue of lender document types. Issuing authority is always the lender. No retention period is defined (D-25). Owner: documents module.';
insert into documents.document_types (key, description, data_source, needs_acknowledgement) values
  ('kfs', 'Key Facts Statement in the RBI standard format (RBC Directions 2025, Annex I)', 'kfs_data', true),
  ('loan_agreement', 'Loan agreement from the lender''s approved template, with the KFS as a summary box', 'kfs_data_and_template', false),
  ('sanction_letter', 'Sanction letter or equivalent lender-issued offer document', 'lender_template', false),
  ('repayment_schedule', 'Repayment schedule as supplied by the lender', 'kfs_data', false),
  ('terms_and_conditions', 'Lender terms and conditions', 'lender_template', false),
  ('privacy_and_data_use', 'Lender privacy and data-use disclosure', 'lender_template', false);

-- ---------------------------------------------------------------------------------------------
-- Regulatory applicability rules (platform-owned; two-person approval; immutable once approved)
-- ---------------------------------------------------------------------------------------------
create table documents.applicability_rules (
  id uuid primary key default private.uuid_v7(),
  rule_key text not null check (rule_key ~ '^[a-z0-9_.]{3,80}$'),
  version integer not null check (version > 0),
  lender_category_keys text[] not null check (cardinality(lender_category_keys) between 1 and 20),
  regulator text not null check (length(regulator) between 2 and 80),
  direction_ref text not null check (length(direction_ref) between 5 and 300),
  paragraph_refs text[] not null default '{}',
  product_category_keys text[] not null check (cardinality(product_category_keys) between 1 and 40),
  exclusions text check (exclusions is null or length(exclusions) <= 2000),
  document_type text not null references documents.document_types (key),
  required_template_key text not null check (required_template_key ~ '^[a-z0-9_.]{3,80}$'),
  required_fields_version text not null check (required_fields_version ~ '^[a-z0-9_]{3,40}$'),
  required_acknowledgements text[] not null default '{}',
  -- The sections of the document the borrower must have been shown before the acknowledgement is accepted.
  ack_sections text[] not null default '{}',
  -- e.g. {"kind":"working_days","min_days_tenor_ge_7":3,"min_days_tenor_lt_7":1,"calendar_required":true}
  validity_rule jsonb not null default '{}'::jsonb,
  language_policy jsonb not null default '{}'::jsonb,
  effective_from date not null,
  effective_to date,
  approval_status text not null default 'draft' check (approval_status in ('draft', 'in_review', 'approved', 'rejected', 'retired', 'unresolved')),
  evidence_status text not null check (evidence_status in ('confirmed', 'likely', 'interpretation', 'unverified')),
  -- Who reviewed it. Unassigned until the owner designates the compliance approver; supplied by the approver at approval.
  reviewer_ref text check (reviewer_ref is null or length(reviewer_ref) between 2 and 100),
  reviewed_on date,
  proposed_by uuid references auth.users (id),
  approved_by uuid references auth.users (id),
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  unique (rule_key, version),
  check (approval_status <> 'approved' or (reviewer_ref is not null and approved_by is not null and approved_at is not null)),
  check (approved_by is null or proposed_by is null or approved_by <> proposed_by),
  check (effective_to is null or effective_to >= effective_from)
);
comment on table documents.applicability_rules is
  'Which regulatory document rule applies to which lender category and product category. No rule exists for banks or UCBs until their own text is read and approved. A draft rule is never used. Owner: documents module.';

-- ---------------------------------------------------------------------------------------------
-- Templates (content approved by the lender and/or compliance; immutable once created)
-- ---------------------------------------------------------------------------------------------
create table documents.templates (
  id uuid primary key default private.uuid_v7(),
  template_key text not null check (template_key ~ '^[a-z0-9_.]{3,80}$'),
  document_type text not null references documents.document_types (key),
  language text not null check (language in ('en', 'hi')),
  -- NULL only for a regulator-prescribed layout (Annex I). Lender-specific text always names its lender.
  lender_org_id uuid references tenancy.organizations (id) on delete restrict,
  version integer not null check (version > 0),
  -- {"engine":"annex_i_v1"|"agreement_v1", "labels":{...} | "sections":[...]}. Content only; no executable code.
  body jsonb not null,
  body_sha256 text not null default '',
  is_sample boolean not null default false,
  status text not null default 'draft' check (status in ('draft', 'in_review', 'approved', 'retired')),
  lender_approved_by uuid references auth.users (id),
  lender_approved_at timestamptz,
  compliance_approved_by uuid references auth.users (id),
  compliance_approved_at timestamptz,
  compliance_reviewer_ref text check (compliance_reviewer_ref is null or length(compliance_reviewer_ref) between 2 and 100),
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  check (status <> 'approved' or (compliance_approved_at is not null and (lender_org_id is null or lender_approved_at is not null)))
);
create unique index templates_unique_key on documents.templates
  (template_key, language, version, coalesce(lender_org_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index templates_lender on documents.templates (lender_org_id, document_type);
comment on table documents.templates is
  'Approved wording and layout content for documents. Udofin writes no lender legal text. A sample template exists only in local and test environments. Owner: documents module.';

-- ---------------------------------------------------------------------------------------------
-- Working-day calendars (no calendar is seeded: without one, KFS validity cannot be computed)
-- ---------------------------------------------------------------------------------------------
create table documents.calendars (
  id uuid primary key default private.uuid_v7(),
  lender_org_id uuid not null references tenancy.organizations (id) on delete restrict,
  name text not null check (length(name) between 2 and 100),
  -- 0 = Sunday ... 6 = Saturday. Which days are not working days is the lender's decision, recorded here.
  weekly_off integer[] not null default '{}' check (weekly_off <@ array[0, 1, 2, 3, 4, 5, 6]),
  covered_from date not null,
  covered_to date not null check (covered_to >= covered_from and covered_to - covered_from <= 800),
  status text not null default 'draft' check (status in ('draft', 'approved', 'retired')),
  lender_confirmation_ref text check (lender_confirmation_ref is null or length(lender_confirmation_ref) between 3 and 200),
  proposed_by uuid references auth.users (id),
  approved_by uuid references auth.users (id),
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  check (status <> 'approved' or (approved_by is not null and lender_confirmation_ref is not null)),
  check (approved_by is null or proposed_by is null or approved_by <> proposed_by),
  unique (id, lender_org_id)
);
create index calendars_lender on documents.calendars (lender_org_id, status);
create table documents.calendar_exceptions (
  calendar_id uuid not null references documents.calendars (id) on delete restrict,
  day date not null,
  is_working boolean not null,
  reason text check (reason is null or length(reason) <= 200),
  primary key (calendar_id, day)
);
comment on table documents.calendars is
  'A lender''s approved working-day calendar for KFS validity. Calendar days are never substituted when none exists (D-52, D-53). Owner: documents module.';

-- ---------------------------------------------------------------------------------------------
-- Proposal numbers: one per offer revision, never reused
-- ---------------------------------------------------------------------------------------------
alter table lending.offers add constraint offers_id_lender unique (id, lender_org_id);

create table documents.proposals (
  offer_id uuid primary key references lending.offers (id) on delete restrict,
  lender_org_id uuid not null references tenancy.organizations (id) on delete restrict,
  proposal_no text not null unique check (proposal_no ~ '^[A-Za-z0-9._/-]{4,60}$'),
  source text not null check (source in ('lender_supplied', 'udofin_allocated')),
  allocated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------------------------
-- Lender-supplied KFS data (append-only; exactly what the lender sent; never altered)
-- ---------------------------------------------------------------------------------------------
create table documents.kfs_inputs (
  id uuid primary key default private.uuid_v7(),
  lender_org_id uuid not null,
  application_id uuid not null,
  offer_id uuid not null,
  package_version integer not null check (package_version > 0),
  mode text not null default 'data' check (mode in ('data', 'declared_for_upload')),
  -- kfs_data_v1 (see docs/api/documents.md). Borrower identity text, if any, is optional and never logged.
  data jsonb not null,
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  validation text not null check (validation in ('accepted', 'held')),
  issues text[] not null default '{}',
  source text not null check (source in ('manual_portal')),
  submitted_by uuid references auth.users (id),
  submitted_at timestamptz not null default clock_timestamp(),
  unique (offer_id, package_version),
  unique (id, offer_id),
  foreign key (offer_id, lender_org_id) references lending.offers (id, lender_org_id) on delete restrict,
  foreign key (application_id, lender_org_id) references lending.applications (id, lender_org_id) on delete restrict
);
create index kfs_inputs_application on documents.kfs_inputs (application_id, submitted_at desc);

-- ---------------------------------------------------------------------------------------------
-- Generation jobs: make requests idempotent and failures recoverable without touching the offer or earlier documents
-- ---------------------------------------------------------------------------------------------
create table documents.generation_jobs (
  id uuid primary key default private.uuid_v7(),
  lender_org_id uuid not null,
  application_id uuid not null,
  offer_id uuid not null,
  document_type text not null references documents.document_types (key),
  language text not null check (language in ('en', 'hi')),
  kfs_input_id uuid not null,
  template_id uuid references documents.templates (id),
  status text not null default 'pending' check (status in ('pending', 'running', 'succeeded', 'failed')),
  attempts integer not null default 0,
  failure_class text check (failure_class is null or failure_class ~ '^[a-z_]{2,50}$'),
  document_id uuid,
  requested_by uuid references auth.users (id),
  requested_by_actor text not null default 'staff' check (requested_by_actor in ('staff', 'system', 'borrower')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (offer_id, lender_org_id) references lending.offers (id, lender_org_id) on delete restrict,
  foreign key (kfs_input_id, offer_id) references documents.kfs_inputs (id, offer_id) on delete restrict
);
-- One job in flight (or awaiting a retry) per document request; a finished job stays on record, and a new one can follow if its document was closed.
create unique index generation_jobs_once on documents.generation_jobs (offer_id, document_type, language, kfs_input_id)
  where status in ('pending', 'running', 'failed');
create index generation_jobs_status on documents.generation_jobs (status, updated_at);

-- ---------------------------------------------------------------------------------------------
-- Documents: each row is one IMMUTABLE VERSION. Only the approval/issuance columns move, forward only.
-- ---------------------------------------------------------------------------------------------
create table documents.items (
  id uuid primary key default private.uuid_v7(),
  document_type text not null references documents.document_types (key),
  version integer not null check (version > 0),
  lender_org_id uuid not null,
  application_id uuid not null,
  borrower_id uuid not null references identity.borrowers (id) on delete restrict,
  offer_id uuid not null,
  kfs_input_id uuid not null,
  template_id uuid references documents.templates (id),
  rule_id uuid references documents.applicability_rules (id),
  source_mode text not null default 'generated' check (source_mode in ('generated', 'lender_uploaded')),
  language text not null check (language in ('en', 'hi')),
  proposal_no text,
  -- Exact bytes live in the private store under an opaque key; there is no public URL.
  storage_key text not null unique check (storage_key ~ '^[A-Za-z0-9/_-]{8,200}$'),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes bigint not null check (size_bytes between 1 and 26214400),
  mime_type text not null default 'application/pdf' check (mime_type = 'application/pdf'),
  -- SHA-256 of the canonical KFS data this document shows; the agreement's summary box carries the same digest.
  content_digest text check (content_digest is null or content_digest ~ '^[0-9a-f]{64}$'),
  generated_at timestamptz not null default clock_timestamp(),
  generated_by text not null default 'system' check (generated_by in ('system', 'lender_upload')),
  -- KFS validity (separate from the offer's own valid_until). Stamped when generated; see documents.generate_kfs.
  kfs_valid_from timestamptz,
  kfs_valid_until timestamptz,
  kfs_min_working_days integer,
  kfs_calendar_id uuid references documents.calendars (id),
  issue_deadline timestamptz,
  approval_status text not null default 'draft' check (approval_status in ('draft', 'lender_approved', 'rejected')),
  prepared_by uuid references auth.users (id),
  approved_by uuid references auth.users (id),
  approved_at timestamptz,
  approved_sha256 text check (approved_sha256 is null or approved_sha256 ~ '^[0-9a-f]{64}$'),
  issuance_status text not null default 'not_issued' check (issuance_status in ('not_issued', 'issued', 'superseded', 'withdrawn', 'expired')),
  issued_at timestamptz,
  issued_by uuid references auth.users (id),
  supersedes_id uuid references documents.items (id),
  superseded_by_id uuid references documents.items (id),
  unique (id, lender_org_id),
  unique (id, borrower_id),
  unique (offer_id, document_type, version),
  foreign key (offer_id, lender_org_id) references lending.offers (id, lender_org_id) on delete restrict,
  foreign key (application_id, lender_org_id) references lending.applications (id, lender_org_id) on delete restrict,
  foreign key (kfs_input_id, offer_id) references documents.kfs_inputs (id, offer_id) on delete restrict,
  check (issuance_status = 'not_issued' or (approval_status = 'lender_approved' and approved_sha256 = sha256)),
  check (document_type <> 'kfs' or source_mode = 'lender_uploaded' or (kfs_valid_until is not null and kfs_valid_from is not null)),
  check (kfs_valid_until is null or kfs_valid_until > kfs_valid_from)
);
create index items_application on documents.items (application_id, document_type, version desc);
create index items_borrower on documents.items (borrower_id, generated_at desc);
create index items_lender on documents.items (lender_org_id, generated_at desc);
create unique index items_one_issued on documents.items (offer_id, document_type) where issuance_status = 'issued';
comment on table documents.items is
  'One immutable version of a lender document. Bytes are stored privately; the hash is the evidence. A correction is a new version, never an edit. Owner: documents module.';

create table documents.item_events (
  id uuid primary key default private.uuid_v7(),
  document_id uuid not null references documents.items (id) on delete restrict,
  lender_org_id uuid not null references tenancy.organizations (id) on delete restrict,
  event text not null check (event ~ '^[a-z_]{2,50}$'),
  detail jsonb not null default '{}'::jsonb,
  actor text not null check (actor in ('borrower', 'staff', 'system')),
  occurred_at timestamptz not null default clock_timestamp()
);
create index item_events_document on documents.item_events (document_id, occurred_at);

-- ---------------------------------------------------------------------------------------------
-- Acknowledgement and acceptance (append-only facts, one each per document / offer revision)
-- ---------------------------------------------------------------------------------------------
create table documents.acknowledgements (
  id uuid primary key default private.uuid_v7(),
  borrower_id uuid not null,
  lender_org_id uuid not null,
  application_id uuid not null,
  offer_id uuid not null,
  document_id uuid not null,
  document_sha256 text not null check (document_sha256 ~ '^[0-9a-f]{64}$'),
  rule_id uuid references documents.applicability_rules (id),
  template_id uuid references documents.templates (id),
  language text not null check (language in ('en', 'hi')),
  wording_notice_id uuid not null references consent.notices (id),
  wording_sha256 text not null check (wording_sha256 ~ '^[0-9a-f]{64}$'),
  explanation_version text not null check (length(explanation_version) between 1 and 40),
  -- The sections the app reports it displayed. Informational evidence of what was shown; never proof of understanding.
  sections_viewed text[] not null,
  action text not null check (action in ('checkbox_and_button', 'button')),
  acknowledged_at timestamptz not null default clock_timestamp(),
  auth_aal text not null check (auth_aal in ('aal1', 'aal2')),
  channel text not null check (channel in ('mobile_app', 'web', 'assisted')),
  app_version text check (app_version is null or length(app_version) <= 40),
  idempotency_ref text check (idempotency_ref is null or length(idempotency_ref) <= 100),
  unique (document_id, borrower_id),
  foreign key (document_id, borrower_id) references documents.items (id, borrower_id) on delete restrict
);
create index acknowledgements_offer on documents.acknowledgements (offer_id);

create table documents.acceptances (
  id uuid primary key default private.uuid_v7(),
  borrower_id uuid not null references identity.borrowers (id) on delete restrict,
  lender_org_id uuid not null,
  application_id uuid not null,
  offer_id uuid not null unique references lending.offers (id) on delete restrict,
  offer_revision integer not null,
  kfs_document_id uuid not null references documents.items (id) on delete restrict,
  kfs_sha256 text not null check (kfs_sha256 ~ '^[0-9a-f]{64}$'),
  acknowledgement_id uuid not null references documents.acknowledgements (id) on delete restrict,
  stepup_challenge_id uuid not null references identity.stepup_challenges (id) on delete restrict,
  accepted_at timestamptz not null default clock_timestamp(),
  idempotency_ref text check (idempotency_ref is null or length(idempotency_ref) <= 100),
  -- Acceptance is not execution of the agreement and not disbursement.
  signature_status text not null default 'not_signed' check (signature_status = 'not_signed'),
  disbursement_status text not null default 'not_started' check (disbursement_status = 'not_started')
);
create index acceptances_application on documents.acceptances (application_id);

-- ---------------------------------------------------------------------------------------------
-- Electronic signature boundary. No real provider; a request records exactly what the provider reports.
-- ---------------------------------------------------------------------------------------------
create table documents.signing_requests (
  id uuid primary key default private.uuid_v7(),
  lender_org_id uuid not null,
  application_id uuid not null,
  borrower_id uuid not null references identity.borrowers (id) on delete restrict,
  document_id uuid not null references documents.items (id) on delete restrict,
  document_sha256 text not null check (document_sha256 ~ '^[0-9a-f]{64}$'),
  state text not null default 'awaiting_initiation' check (state in
    ('not_required', 'awaiting_initiation', 'ready_for_signing', 'initiated', 'awaiting_borrower', 'executed', 'failed', 'expired', 'cancelled', 'requires_reconciliation')),
  provider_key text not null check (provider_key ~ '^[a-z0-9_]{2,40}$'),
  provider_mode text not null check (provider_mode in ('mock', 'sandbox', 'live')),
  provider_ref text check (provider_ref is null or length(provider_ref) <= 100),
  -- Null until a legal signature method is approved (D-58). An OTP is not a signature.
  signer_method_ref text check (signer_method_ref is null or length(signer_method_ref) <= 100),
  evidence_ref text check (evidence_ref is null or length(evidence_ref) <= 200),
  stepup_challenge_id uuid references identity.stepup_challenges (id),
  uncertain_since timestamptz,
  requested_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  executed_at timestamptz,
  idempotency_ref text check (idempotency_ref is null or length(idempotency_ref) <= 100),
  check (provider_mode <> 'mock' or provider_key = 'mock_esign'),
  foreign key (document_id, lender_org_id) references documents.items (id, lender_org_id) on delete restrict
);
create unique index signing_one_active on documents.signing_requests (document_id)
  where state in ('awaiting_initiation', 'ready_for_signing', 'initiated', 'awaiting_borrower', 'requires_reconciliation', 'executed');
create table documents.signing_events (
  id uuid primary key default private.uuid_v7(),
  request_id uuid not null references documents.signing_requests (id) on delete restrict,
  from_state text,
  to_state text not null,
  detail jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default clock_timestamp()
);

-- ---------------------------------------------------------------------------------------------
-- Delivery and access evidence
-- ---------------------------------------------------------------------------------------------
create table documents.deliveries (
  id uuid primary key default private.uuid_v7(),
  document_id uuid not null references documents.items (id) on delete restrict,
  borrower_id uuid not null references identity.borrowers (id) on delete restrict,
  lender_org_id uuid not null references tenancy.organizations (id) on delete restrict,
  -- in_app: available in the borrower's My documents. sms_notice: a content-free message that documents are ready.
  channel text not null check (channel in ('in_app', 'sms_notice', 'email_notice')),
  status text not null default 'requested' check (status in ('requested', 'available_in_app', 'accepted_by_provider', 'delivered', 'failed', 'not_configured')),
  failure_class text check (failure_class is null or failure_class ~ '^[a-z_]{2,50}$'),
  provider_ref text check (provider_ref is null or length(provider_ref) <= 100),
  requested_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  attempt integer not null default 1,
  idempotency_ref text check (idempotency_ref is null or length(idempotency_ref) <= 100)
);
create unique index deliveries_once on documents.deliveries (document_id, channel) where status in ('requested', 'available_in_app', 'accepted_by_provider', 'delivered');
create table documents.access_log (
  id uuid primary key default private.uuid_v7(),
  document_id uuid not null references documents.items (id) on delete restrict,
  lender_org_id uuid not null references tenancy.organizations (id) on delete restrict,
  actor_type text not null check (actor_type in ('borrower', 'lender')),
  actor_user_id uuid not null,
  purpose text not null check (purpose in ('view', 'download')),
  -- The API calls this before streaming the bytes: it records that access was granted and served, not that it was read.
  accessed_at timestamptz not null default clock_timestamp()
);
create index access_log_document on documents.access_log (document_id, accessed_at);

-- ---------------------------------------------------------------------------------------------
-- Append-only / no-delete, and forced RLS everywhere
-- ---------------------------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['item_events', 'kfs_inputs', 'acknowledgements', 'acceptances', 'signing_events', 'access_log', 'proposals']
  loop
    execute format('create trigger append_only before update or delete on documents.%I for each row execute function private.forbid_mutation()', t);
  end loop;
  foreach t in array array['document_types', 'applicability_rules', 'templates', 'calendars', 'calendar_exceptions', 'proposals', 'kfs_inputs',
                           'generation_jobs', 'items', 'item_events', 'acknowledgements', 'acceptances', 'signing_requests', 'signing_events',
                           'deliveries', 'access_log']
  loop
    execute format('create trigger no_truncate before truncate on documents.%I for each statement execute function private.forbid_truncate()', t);
    execute format('alter table documents.%I enable row level security', t);
    execute format('alter table documents.%I force row level security', t);
  end loop;
  foreach t in array array['document_types', 'applicability_rules', 'templates', 'calendars', 'calendar_exceptions', 'generation_jobs', 'items',
                           'signing_requests', 'deliveries']
  loop
    execute format('create trigger no_delete before delete on documents.%I for each row execute function private.forbid_mutation()', t);
  end loop;
end
$$;

-- Template and rule content never changes after creation; only status and approval columns move.
create or replace function private.protect_template()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.body_sha256 := encode(sha256(convert_to(new.body::text, 'UTF8')), 'hex');
    if new.is_sample and coalesce(current_setting('udofin.allow_sample_documents', true), '') <> 'on' then
      raise exception 'sample documents are for local development and tests only' using errcode = '42501', hint = 'sample_blocked';
    end if;
    return new;
  end if;
  if (to_jsonb(new) - array['status', 'lender_approved_by', 'lender_approved_at', 'compliance_approved_by', 'compliance_approved_at', 'compliance_reviewer_ref'])
     is distinct from
     (to_jsonb(old) - array['status', 'lender_approved_by', 'lender_approved_at', 'compliance_approved_by', 'compliance_approved_at', 'compliance_reviewer_ref']) then
    raise exception 'template content is immutable; create a new version' using errcode = 'P0001';
  end if;
  if old.status = 'retired' and new.status <> 'retired' then
    raise exception 'a retired template stays retired' using errcode = 'P0001';
  end if;
  return new;
end
$$;
create trigger templates_protect before insert or update on documents.templates
  for each row execute function private.protect_template();

create or replace function private.protect_rule()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.approval_status in ('approved', 'retired') then
    if (to_jsonb(new) - array['approval_status']) is distinct from (to_jsonb(old) - array['approval_status']) then
      raise exception 'an approved rule is immutable; propose a new version' using errcode = 'P0001';
    end if;
    if new.approval_status is distinct from old.approval_status and not (old.approval_status = 'approved' and new.approval_status = 'retired') then
      raise exception 'an approved rule can only be retired' using errcode = 'P0001';
    end if;
  end if;
  return new;
end
$$;
create trigger applicability_rules_protect before update on documents.applicability_rules
  for each row execute function private.protect_rule();

-- Document rows: bytes, hashes, versions and identifiers never change; only approval and issuance move forward.
create or replace function private.protect_document_item()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  movable text[] := array['approval_status', 'approved_by', 'approved_at', 'approved_sha256', 'issuance_status', 'issued_at', 'issued_by',
                          'superseded_by_id', 'prepared_by'];
begin
  if (to_jsonb(new) - movable) is distinct from (to_jsonb(old) - movable) then
    raise exception 'an issued or generated document is immutable; create a new version' using errcode = 'P0001', hint = 'document_immutable';
  end if;
  if new.approval_status is distinct from old.approval_status
     and not ((old.approval_status = 'draft' and new.approval_status in ('lender_approved', 'rejected'))) then
    raise exception 'invalid approval change % -> %', old.approval_status, new.approval_status using errcode = 'P0001';
  end if;
  if new.issuance_status is distinct from old.issuance_status and not (
       (old.issuance_status = 'not_issued' and new.issuance_status in ('issued', 'withdrawn', 'expired'))
    or (old.issuance_status = 'issued' and new.issuance_status in ('superseded', 'withdrawn', 'expired'))) then
    raise exception 'invalid issuance change % -> %', old.issuance_status, new.issuance_status using errcode = 'P0001';
  end if;
  if new.issuance_status = 'issued' and old.issuance_status <> 'issued' then
    if new.approval_status <> 'lender_approved' or new.approved_sha256 is distinct from new.sha256 then
      raise exception 'only a lender-approved document with a matching hash can be issued' using errcode = 'P0001', hint = 'approval_required';
    end if;
  end if;
  return new;
end
$$;
create trigger items_protect before update on documents.items
  for each row execute function private.protect_document_item();

-- ---------------------------------------------------------------------------------------------
-- Read access (all writes go through functions)
-- ---------------------------------------------------------------------------------------------
create policy types_read on documents.document_types for select to authenticated using (true);
create policy rules_platform_read on documents.applicability_rules for select to authenticated
  using ((select private.has_platform_permission('platform.documents.manage')));
create policy templates_platform_read on documents.templates for select to authenticated
  using ((select private.has_platform_permission('platform.documents.manage')));
create policy templates_lender_read on documents.templates for select to authenticated
  using (lender_org_id in (select private.orgs_with_permission('application.read')));
create policy calendars_platform_read on documents.calendars for select to authenticated
  using ((select private.has_platform_permission('platform.documents.manage')));
create policy calendars_lender_read on documents.calendars for select to authenticated
  using (lender_org_id in (select private.orgs_with_permission('application.read')));
create policy calendar_exceptions_read on documents.calendar_exceptions for select to authenticated
  using (calendar_id in (select c.id from documents.calendars c where (select private.has_platform_permission('platform.documents.manage'))
                                                              or c.lender_org_id in (select private.orgs_with_permission('application.read'))));

create policy proposals_lender_read on documents.proposals for select to authenticated
  using (lender_org_id in (select private.orgs_with_permission('application.read')));
create policy kfs_inputs_lender_read on documents.kfs_inputs for select to authenticated
  using (lender_org_id in (select private.orgs_with_permission('application.read')));
create policy jobs_lender_read on documents.generation_jobs for select to authenticated
  using (lender_org_id in (select private.orgs_with_permission('application.read')));

create policy items_lender_read on documents.items for select to authenticated
  using (lender_org_id in (select private.orgs_with_permission('application.read')));
create policy items_borrower_read on documents.items for select to authenticated
  using (borrower_id = (select private.my_borrower_id()) and issuance_status <> 'not_issued');
create policy item_events_lender_read on documents.item_events for select to authenticated
  using (lender_org_id in (select private.orgs_with_permission('application.read')));
create policy acks_borrower_read on documents.acknowledgements for select to authenticated
  using (borrower_id = (select private.my_borrower_id()));
create policy acks_lender_read on documents.acknowledgements for select to authenticated
  using (lender_org_id in (select private.orgs_with_permission('application.read')));
create policy acceptances_borrower_read on documents.acceptances for select to authenticated
  using (borrower_id = (select private.my_borrower_id()));
create policy acceptances_lender_read on documents.acceptances for select to authenticated
  using (lender_org_id in (select private.orgs_with_permission('application.read')));
create policy signing_borrower_read on documents.signing_requests for select to authenticated
  using (borrower_id = (select private.my_borrower_id()));
create policy signing_lender_read on documents.signing_requests for select to authenticated
  using (lender_org_id in (select private.orgs_with_permission('application.read')));
create policy signing_events_borrower_read on documents.signing_events for select to authenticated
  using (request_id in (select s.id from documents.signing_requests s where s.borrower_id = (select private.my_borrower_id())));
create policy signing_events_lender_read on documents.signing_events for select to authenticated
  using (request_id in (select s.id from documents.signing_requests s where s.lender_org_id in (select private.orgs_with_permission('application.read'))));
create policy deliveries_borrower_read on documents.deliveries for select to authenticated
  using (borrower_id = (select private.my_borrower_id()));
create policy deliveries_lender_read on documents.deliveries for select to authenticated
  using (lender_org_id in (select private.orgs_with_permission('application.read')));
create policy access_lender_read on documents.access_log for select to authenticated
  using (lender_org_id in (select private.orgs_with_permission('application.read')));

grant select on all tables in schema documents to authenticated;
