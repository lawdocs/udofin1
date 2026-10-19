-- =============================================================================================
-- Phase 04 (addendum A): lender onboarding data model.
-- Spec: docs/specs/04-lender-onboarding-configuration.md (section "Addendum A").
--
-- Everything lives in the `onboarding` schema. Users have SELECT only (through RLS); every write
-- goes through the SECURITY DEFINER functions of migration 0750, which check permissions, enforce
-- two-person rules and the gate order. Every change is audited by a trigger, nothing is ever
-- deleted, and approved/agreed versions are immutable (a change creates a new version).
-- Recorded facts are the lender's/Udofin's own statements plus evidence: a profile never makes
-- a lender "approved", "verified" or "Ind AS applicable" by existing.
-- =============================================================================================

create schema if not exists onboarding;
revoke all on schema onboarding from public, anon;
grant usage on schema onboarding to authenticated, service_role;
alter default privileges in schema onboarding revoke all on tables from public, anon, authenticated;
alter default privileges in schema onboarding revoke all on functions from public, anon;
alter default privileges in schema onboarding grant all on tables to service_role;

-- ---------------------------------------------------------------------------------------------
-- Permissions and roles
-- ---------------------------------------------------------------------------------------------
insert into tenancy.permissions (key, description, platform_grantable, platform_only) values
  ('onboarding.read', 'View the onboarding record of the organisation (profile, accounting status, scope, requirements, gates)', true, false),
  ('onboarding.submit', 'Provide onboarding information, evidence and acknowledgements for the lender', false, false),
  ('onboarding.manage', 'Create and prepare lender onboarding records on behalf of Udofin (cross-lender)', false, true),
  ('onboarding.approve', 'Independently review and approve onboarding records and gates (cross-lender)', false, true),
  ('onboarding.compliance_signoff', 'Record compliance sign-off that an institution category may be activated', false, true);

insert into tenancy.roles (org_id, applies_to, key, name, description) values
  (null, 'platform', 'onboarding_manager', 'Onboarding manager', 'Prepares lender onboarding records and requests gates'),
  (null, 'platform', 'onboarding_approver', 'Onboarding approver', 'Independently reviews onboarding records and decides gates'),
  (null, 'platform', 'compliance_officer', 'Compliance officer', 'Signs off institution categories for activation'),
  (null, 'lender', 'onboarding_contact', 'Onboarding contact', 'Provides onboarding information and evidence for the lender');

insert into tenancy.role_permissions (role_id, permission_key)
select r.id, g.permission_key
from tenancy.roles r
join (values
  ('platform', 'onboarding_manager', 'onboarding.manage'),
  ('platform', 'onboarding_manager', 'onboarding.read'),
  ('platform', 'onboarding_approver', 'onboarding.approve'),
  ('platform', 'onboarding_approver', 'onboarding.read'),
  ('platform', 'compliance_officer', 'onboarding.compliance_signoff'),
  ('platform', 'compliance_officer', 'onboarding.read'),
  ('lender', 'onboarding_contact', 'onboarding.submit'),
  ('lender', 'onboarding_contact', 'onboarding.read'),
  ('lender', 'lender_admin', 'onboarding.submit'),
  ('lender', 'lender_admin', 'onboarding.read')
) as g (applies_to, role_key, permission_key)
  on r.org_id is null and r.applies_to = g.applies_to::tenancy.organization_kind and r.key = g.role_key;

-- ---------------------------------------------------------------------------------------------
-- Generic triggers
-- ---------------------------------------------------------------------------------------------

-- Audit: every insert/update on an onboarding table writes an audit.events row in the same
-- transaction. Metadata holds column NAMES and enumerated state transitions only, never values.
create or replace function onboarding.audit_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_new jsonb := to_jsonb(new);
  v_old jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) end;
  v_user uuid := (select auth.uid());
  v_changed text[];
  v_meta jsonb;
  v_key text;
  v_actor audit.actor_type;
begin
  select coalesce(array_agg(t.k order by t.k), '{}') into v_changed
  from jsonb_object_keys(v_new) as t (k)
  where t.k not in ('updated_at') and (v_old is null or v_new -> t.k is distinct from v_old -> t.k);

  v_meta := jsonb_build_object('operation', lower(tg_op), 'changed_columns', to_jsonb(v_changed));
  foreach v_key in array array['status', 'verification_status', 'stage', 'scan_status'] loop
    if v_new ? v_key then
      v_meta := v_meta || jsonb_build_object(v_key || '_to', v_new ->> v_key);
      if v_old is not null then
        v_meta := v_meta || jsonb_build_object(v_key || '_from', v_old ->> v_key);
      end if;
    end if;
  end loop;

  v_actor := case
    when v_user is null then 'system'
    when exists (
      select 1 from tenancy.memberships m join tenancy.organizations o on o.id = m.org_id
      where m.user_id = v_user and m.status = 'active' and o.kind = 'platform'
    ) then 'platform'
    else 'staff'
  end::audit.actor_type;

  insert into audit.events (actor_type, actor_user_id, tenant_org_id, action, entity_type, entity_id, metadata)
  values (v_actor, v_user, nullif(v_new ->> 'lender_org_id', '')::uuid,
          'onboarding.' || tg_table_name || '.' || lower(tg_op), 'onboarding_' || tg_table_name,
          coalesce(v_new ->> 'id', v_new ->> 'lender_org_id', v_new ->> 'key'), v_meta);
  return new;
end
$$;

-- Free-text fields must never carry secrets or personal identifiers (CLAUDE.md rule 3). Columns to
-- check are passed as trigger arguments. This is a guard rail, not a substitute for judgement.
create or replace function onboarding.reject_unsafe_text()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_col text;
  v_val text;
begin
  foreach v_col in array tg_argv loop
    v_val := to_jsonb(new) ->> v_col;
    if v_val is null then continue; end if;
    if v_val ~* '(password|passwd|secret|api[_ -]?key|private[_ -]?key|bearer|access[_ -]?token)\s*[:=]\s*\S{4,}'
       or v_val ~ '\m[2-9][0-9]{3}\s?[0-9]{4}\s?[0-9]{4}\M'
       or v_val ~ '\m[A-Z]{5}[0-9]{4}[A-Z]\M'
       or v_val ~ '(^|[^0-9])[6-9][0-9]{9}([^0-9]|$)' then
      raise exception 'column % looks like it contains a secret or a personal identifier; store a reference instead', v_col
        using errcode = '22023', hint = 'unsafe_free_text';
    end if;
  end loop;
  return new;
end
$$;

-- Adds the contributor to the record (everyone who edited it cannot also review it).
create or replace function onboarding.append_unique(p_list uuid[], p_user uuid)
returns uuid[]
language sql
immutable
set search_path = ''
as $$ select case when p_user is null or p_user = any (coalesce(p_list, '{}')) then coalesce(p_list, '{}') else coalesce(p_list, '{}') || p_user end $$;

-- ---------------------------------------------------------------------------------------------
-- Reference data (configurable, platform-owned)
-- ---------------------------------------------------------------------------------------------
create table onboarding.institution_categories (
  key text primary key check (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  label text not null check (length(label) between 3 and 120),
  institution_type text not null check (institution_type in
    ('nbfc', 'housing_finance_company', 'bank', 'urban_co_operative_bank', 'other_regulated_entity')),
  regulator text not null check (length(regulator) between 2 and 80),
  -- How firmly the regulatory regime for this category is established in docs/regulatory/primary.
  regime_status text not null check (regime_status in ('confirmed_primary', 'likely', 'unverified')),
  regime_note text not null check (length(regime_note) between 10 and 1000),
  -- A category cannot carry a lender into production until compliance has signed it off. Only
  -- categories whose regime is confirmed from a primary source on file start enabled.
  activation_allowed boolean not null default false,
  signoff_by uuid references auth.users (id),
  signoff_at timestamptz,
  signoff_source_ref text check (signoff_source_ref is null or length(signoff_source_ref) between 10 and 500),
  sort_order integer not null default 100,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint activation_needs_basis check (
    not activation_allowed
    or regime_status = 'confirmed_primary'
    or (signoff_by is not null and signoff_at is not null and signoff_source_ref is not null)
  )
);
comment on table onboarding.institution_categories is
  'Configurable lender categories (NBFC types, bank types, UCBs, other regulated entities). A category row never approves a lender. Owner: onboarding module.';

insert into onboarding.institution_categories
  (key, label, institution_type, regulator, regime_status, regime_note, activation_allowed, sort_order) values
  ('nbfc_icc', 'NBFC - Investment and Credit Company (NBFC-ICC)', 'nbfc', 'Reserve Bank of India', 'confirmed_primary',
   'RBI Credit Facilities Directions apply to NBFC-ICC (see docs/regulatory/primary). Ind AS position is recorded per lender, not per category.', true, 10),
  ('nbfc_d', 'NBFC - Deposit-taking (NBFC-D)', 'nbfc', 'Reserve Bank of India', 'confirmed_primary',
   'RBI Credit Facilities Directions apply to NBFC-D (see docs/regulatory/primary).', true, 11),
  ('nbfc_mfi', 'NBFC - Micro Finance Institution (NBFC-MFI)', 'nbfc', 'Reserve Bank of India', 'confirmed_primary',
   'RBI Credit Facilities Directions apply to NBFC-MFI (see docs/regulatory/primary); MFI-specific rules not yet reviewed.', true, 12),
  ('hfc', 'Housing Finance Company (HFC)', 'housing_finance_company', 'Reserve Bank of India', 'likely',
   'Credit Facilities Directions list HFCs among covered entities; HFC-specific directions not on file. Needs compliance sign-off.', false, 20),
  ('bank_commercial', 'Commercial bank (scheduled, public or private sector)', 'bank', 'Reserve Bank of India', 'unverified',
   'Bank-specific RBI directions are not on file. Needs compliance sign-off against primary sources before activation.', false, 30),
  ('bank_small_finance', 'Small finance bank', 'bank', 'Reserve Bank of India', 'unverified',
   'Bank-specific RBI directions are not on file. Needs compliance sign-off against primary sources before activation.', false, 31),
  ('bank_regional_rural', 'Regional rural bank', 'bank', 'Reserve Bank of India', 'unverified',
   'Bank-specific RBI directions are not on file. Needs compliance sign-off against primary sources before activation.', false, 32),
  ('bank_foreign', 'Foreign bank (branches in India)', 'bank', 'Reserve Bank of India', 'unverified',
   'Bank-specific RBI directions are not on file. Needs compliance sign-off against primary sources before activation.', false, 33),
  ('ucb_scheduled', 'Urban co-operative bank (scheduled)', 'urban_co_operative_bank', 'Reserve Bank of India', 'unverified',
   'UCB-specific RBI directions and the co-operative registrar position are not on file. Needs compliance sign-off.', false, 40),
  ('ucb_non_scheduled', 'Urban co-operative bank (non-scheduled)', 'urban_co_operative_bank', 'Reserve Bank of India', 'unverified',
   'UCB-specific RBI directions and the co-operative registrar position are not on file. Needs compliance sign-off.', false, 41),
  ('other_regulated_entity', 'Other regulated entity (future category)', 'other_regulated_entity', 'To be recorded', 'unverified',
   'Placeholder for future eligible regulated entities. Needs compliance sign-off against primary sources before activation.', false, 90);

create table onboarding.service_categories (
  key text primary key check (key ~ '^[a-z][a-z0-9_]{1,50}$'),
  label text not null check (length(label) between 3 and 120),
  description text not null,
  active boolean not null default true,
  sort_order integer not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table onboarding.service_categories is 'Configurable categories of services Udofin may provide to a lender. Owner: onboarding module.';
insert into onboarding.service_categories (key, label, description, sort_order) values
  ('lead_generation', 'Lead generation', 'Sourcing borrower leads for the lender', 10),
  ('onboarding', 'Borrower onboarding', 'Guiding borrowers through registration and consent', 20),
  ('digital_journey', 'Digital journey', 'The in-app application journey for the lender''s products', 30),
  ('pre_screening', 'Pre-screening', 'Preliminary eligibility questions before an application is sent (the lender decides)', 40),
  ('product_discovery', 'Product discovery', 'Presenting the lender''s products to borrowers', 50),
  ('application_document_transmission', 'Application and document transmission', 'Transmitting applications and borrower documents to the lender', 60),
  ('kyc_coordination', 'KYC coordination', 'Coordinating KYC steps performed by or for the lender', 70),
  ('credit_bureau_coordination', 'Credit bureau coordination', 'Coordinating bureau pulls requested by the lender', 80),
  ('credit_decision_integration', 'Credit decisioning integration', 'Carrying the lender''s decision back to the borrower (the lender decides)', 90),
  ('offer_presentation', 'Offer presentation', 'Showing the lender''s offers and key facts to the borrower', 100),
  ('agreement_execution_support', 'Agreement execution support', 'Supporting e-sign or other execution of the lender''s agreement', 110),
  ('disbursement_coordination', 'Disbursement coordination', 'Coordinating status of the lender''s disbursement (no Udofin-held funds)', 120),
  ('servicing_integration', 'Loan servicing integration', 'Showing loan status read from the lender''s system', 130),
  ('repayment_collections_support', 'Repayment and collections support', 'Reminders and recovery support within the lender''s policy', 140),
  ('customer_support', 'Customer support', 'First-line support to borrowers', 150),
  ('grievance_coordination', 'Grievance coordination', 'Routing borrower grievances to the lender and tracking them', 160),
  ('reporting', 'Reporting', 'Operational reports for the lender', 170),
  ('regulatory_reporting_support', 'Regulatory reporting support', 'Data support for the lender''s own regulatory reporting', 180),
  ('technology_api_integration', 'Technology and API integration', 'Integration between Udofin and the lender''s systems', 190),
  ('reconciliation_invoicing_settlement', 'Reconciliation, invoicing and settlement', 'Reconciling activity and invoicing fees (no pooled funds)', 200),
  ('other', 'Other', 'A service not covered above; describe it in the scope fields', 999);

create table onboarding.requirement_templates (
  key text primary key check (key ~ '^[a-z][a-z0-9_]{1,60}$'),
  title text not null check (length(title) between 3 and 200),
  description text not null,
  -- Null = applies to every category / every service.
  applies_to_category_keys text[],
  applies_to_service_category text references onboarding.service_categories (key),
  mandatory boolean not null default true,
  evidence_required boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table onboarding.requirement_templates is
  'Udofin onboarding checklist items (what a lender must provide). These are Udofin requirements, not statements of law. Owner: onboarding module.';
insert into onboarding.requirement_templates (key, title, description, applies_to_service_category, mandatory, evidence_required) values
  ('certificate_of_registration', 'Certificate of registration / licence', 'Copy of the lender''s registration or licence as issued by its regulator', null, true, true),
  ('latest_audited_financials', 'Latest audited financial statements', 'Most recent audited financial statements of the lender', null, true, true),
  ('accounting_framework_confirmation', 'Accounting framework confirmation', 'Evidence supporting the Accounting Framework & Ind AS status recorded for the lender (audited statements, auditor confirmation, or management declaration)', null, true, true),
  ('authorised_signatories', 'Authorised signatories', 'Names and designations of the people authorised to sign for the lender (stored as a document, not in the platform)', null, true, true),
  ('grievance_contact', 'Grievance redressal contact', 'Lender''s grievance redressal contact and escalation matrix for borrowers', null, true, false),
  ('board_approved_arrangement', 'Board-approved arrangement', 'Evidence that the lender''s board or competent authority approved the arrangement with Udofin', null, true, true),
  ('lms_api_documentation', 'LMS / core system API documentation', 'Technical documentation for the lender''s loan management system interfaces', 'technology_api_integration', true, true),
  ('bureau_membership_details', 'Credit bureau membership details', 'Which credit information companies the lender is a member of (references only)', 'credit_bureau_coordination', true, false),
  ('kyc_arrangement_details', 'KYC arrangement details', 'How the lender performs or accepts KYC (references only, no KYC data)', 'kyc_coordination', true, false),
  ('settlement_arrangement_details', 'Settlement arrangement details', 'Settlement and invoicing arrangement (masked references only)', 'reconciliation_invoicing_settlement', true, false);

-- ---------------------------------------------------------------------------------------------
-- Documents (metadata only; the bytes live in the private document store)
-- ---------------------------------------------------------------------------------------------
create table onboarding.documents (
  id uuid primary key default private.uuid_v7(),
  lender_org_id uuid not null references tenancy.organizations (id) on delete restrict,
  purpose text not null check (purpose in
    ('licence', 'registration', 'accounting_evidence', 'contract', 'requirement_evidence', 'integration_evidence', 'verification_evidence', 'other')),
  label text not null check (length(label) between 1 and 120),
  storage_key text not null unique check (storage_key ~ '^[A-Za-z0-9/_-]{8,200}$'),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes bigint not null check (size_bytes between 1 and 26214400),
  mime_type text not null check (mime_type in ('application/pdf', 'image/png', 'image/jpeg')),
  scan_status text not null default 'not_scanned' check (scan_status in ('not_scanned', 'clean', 'infected')),
  uploaded_by uuid not null references auth.users (id),
  uploaded_at timestamptz not null default now(),
  unique (id, lender_org_id)
);
create index documents_lender on onboarding.documents (lender_org_id, uploaded_at desc);
comment on table onboarding.documents is
  'Metadata of lender evidence documents. The file lives in the private, KMS-encrypted document store under an opaque key; there is no public URL. Append-only. Owner: onboarding module.';

-- ---------------------------------------------------------------------------------------------
-- Institution profile and verification
-- ---------------------------------------------------------------------------------------------
create table onboarding.lender_profiles (
  lender_org_id uuid primary key references tenancy.organizations (id) on delete restrict,
  category_key text not null references onboarding.institution_categories (key),
  regulator text not null check (length(regulator) between 2 and 80),
  registration_no text check (registration_no is null or length(registration_no) between 3 and 60),
  cin text check (cin is null or cin ~ '^[A-Z0-9]{8,25}$'),
  licence_type text check (licence_type is null or length(licence_type) between 2 and 120),
  licence_issued_on date,
  licence_valid_until date,
  -- As declared; only 'verification_status' says whether anyone checked it.
  licence_status text not null default 'unknown'
    check (licence_status in ('unknown', 'active', 'suspended', 'cancelled', 'expired', 'surrendered')),
  notes text check (notes is null or length(notes) <= 2000),
  verification_status text not null default 'unverified'
    check (verification_status in ('unverified', 'submitted', 'verified', 'rejected', 'expired')),
  verification_evidence_id uuid,
  verification_requested_by uuid references auth.users (id),
  verification_requested_at timestamptz,
  verified_by uuid references auth.users (id),
  verified_at timestamptz,
  last_verified_on date,
  verification_note text check (verification_note is null or length(verification_note) <= 2000),
  reverify_by date,
  contributors uuid[] not null default '{}',
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (verification_evidence_id, lender_org_id) references onboarding.documents (id, lender_org_id),
  constraint verified_has_basis check (
    verification_status <> 'verified'
    or (verified_by is not null and verified_at is not null and last_verified_on is not null
        and verification_evidence_id is not null and registration_no is not null)
  ),
  constraint no_self_verification check (verified_by is null or not (verified_by = any (contributors)))
);
comment on table onboarding.lender_profiles is
  'Institution profile of a lender. Existing as a row never means approved or eligible. Owner: onboarding module.';

create table onboarding.verification_history (
  id uuid primary key default private.uuid_v7(),
  lender_org_id uuid not null references tenancy.organizations (id) on delete restrict,
  subject text not null check (subject in ('institution', 'accounting')),
  subject_ref uuid,
  status text not null,
  evidence_document_id uuid,
  actor_id uuid references auth.users (id),
  note text check (note is null or length(note) <= 2000),
  recorded_at timestamptz not null default now(),
  foreign key (evidence_document_id, lender_org_id) references onboarding.documents (id, lender_org_id)
);
create index verification_history_lender on onboarding.verification_history (lender_org_id, recorded_at desc);
comment on table onboarding.verification_history is
  'Append-only history of every verification state an institution profile or accounting profile passed through. Owner: onboarding module.';

-- ---------------------------------------------------------------------------------------------
-- Accounting framework and Ind AS status (versioned; applicability and implementation separate)
-- ---------------------------------------------------------------------------------------------
create table onboarding.accounting_profiles (
  id uuid primary key default private.uuid_v7(),
  lender_org_id uuid not null references tenancy.organizations (id) on delete restrict,
  version_no integer not null check (version_no > 0),
  status text not null default 'draft' check (status in ('draft', 'submitted', 'verified', 'rejected', 'superseded')),

  accounting_framework text not null default 'to_be_confirmed' check (accounting_framework in
    ('ind_as', 'companies_as_rules_or_other_corporate', 'banking_sector_framework', 'other', 'to_be_confirmed')),
  ind_as_applicability text not null default 'to_be_confirmed' check (ind_as_applicability in
    ('applicable', 'not_applicable', 'under_assessment', 'to_be_confirmed')),
  ind_as_implementation_status text not null default 'to_be_confirmed' check (ind_as_implementation_status in
    ('implemented', 'in_progress', 'not_implemented', 'not_applicable', 'to_be_confirmed')),
  applicability_basis text not null default 'to_be_confirmed' check (applicability_basis in
    ('statutory_requirement', 'entity_criteria', 'group_relationship', 'professional_assessment', 'other', 'to_be_confirmed')),
  applicability_basis_note text check (applicability_basis_note is null or length(applicability_basis_note) <= 2000),
  effective_fy text check (effective_fy is null or effective_fy ~ '^20[0-9]{2}-[0-9]{2}$'),
  effective_date date,
  statement_scope text not null default 'to_be_confirmed' check (statement_scope in
    ('standalone', 'consolidated', 'both', 'not_applicable', 'to_be_confirmed')),
  listed_status text not null default 'to_be_confirmed' check (listed_status in ('listed', 'unlisted', 'to_be_confirmed')),
  group_relationships text check (group_relationships is null or length(group_relationships) <= 2000),
  net_worth_paise bigint check (net_worth_paise is null or net_worth_paise >= 0),
  net_worth_measured_on date,
  net_worth_fy text check (net_worth_fy is null or net_worth_fy ~ '^20[0-9]{2}-[0-9]{2}$'),
  confirmation_source text not null default 'to_be_confirmed' check (confirmation_source in
    ('audited_financial_statements', 'auditor_confirmation', 'management_declaration', 'regulatory_reference', 'other', 'to_be_confirmed')),
  evidence_document_id uuid,
  notes text check (notes is null or length(notes) <= 4000),
  next_review_on date,

  contributors uuid[] not null default '{}',
  submitted_by uuid references auth.users (id),
  submitted_at timestamptz,
  reviewed_by uuid references auth.users (id),
  reviewed_at timestamptz,
  review_note text check (review_note is null or length(review_note) <= 2000),
  last_verified_on date,
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (lender_org_id, version_no),
  unique (id, lender_org_id),
  foreign key (evidence_document_id, lender_org_id) references onboarding.documents (id, lender_org_id),
  constraint net_worth_complete check (
    (net_worth_paise is null) = (net_worth_measured_on is null)
  ),
  constraint not_applicable_consistent check (
    ind_as_applicability <> 'not_applicable' or ind_as_implementation_status in ('not_applicable', 'to_be_confirmed')
  ),
  constraint verified_not_unconfirmed check (
    status <> 'verified' or (
      reviewed_by is not null and reviewed_at is not null and last_verified_on is not null
      and evidence_document_id is not null
      and ind_as_applicability <> 'to_be_confirmed' and confirmation_source <> 'to_be_confirmed'
      and accounting_framework <> 'to_be_confirmed'
    )
  ),
  constraint no_self_review check (reviewed_by is null or not (reviewed_by = any (contributors)))
);
create unique index accounting_one_open on onboarding.accounting_profiles (lender_org_id) where status in ('draft', 'submitted');
create unique index accounting_one_verified on onboarding.accounting_profiles (lender_org_id) where status = 'verified';
comment on table onboarding.accounting_profiles is
  'Versioned record of a lender''s accounting framework and Ind AS status, kept separate from lender type, net worth and listing. A record of what was declared and verified, not an accounting opinion or proof of compliance. Owner: onboarding module.';

-- ---------------------------------------------------------------------------------------------
-- Contracts
-- ---------------------------------------------------------------------------------------------
create table onboarding.lender_contracts (
  id uuid primary key default private.uuid_v7(),
  lender_org_id uuid not null references tenancy.organizations (id) on delete restrict,
  contract_type text not null check (contract_type in
    ('master_services_agreement', 'lsp_agreement', 'dlg_agreement', 'data_processing_agreement', 'sla', 'commercial_terms', 'amendment', 'other')),
  reference text not null check (length(reference) between 3 and 120),
  executed_on date,
  effective_from date,
  effective_until date,
  document_id uuid,
  status text not null default 'draft' check (status in ('draft', 'executed', 'expired', 'terminated')),
  note text check (note is null or length(note) <= 2000),
  recorded_by uuid not null references auth.users (id),
  verified_by uuid references auth.users (id),
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, lender_org_id),
  foreign key (document_id, lender_org_id) references onboarding.documents (id, lender_org_id),
  constraint executed_has_basis check (status <> 'executed' or (executed_on is not null and document_id is not null)),
  constraint verified_independent check (verified_by is null or verified_by <> recorded_by),
  constraint verified_complete check ((verified_by is null) = (verified_at is null))
);
create index contracts_lender on onboarding.lender_contracts (lender_org_id);
comment on table onboarding.lender_contracts is
  'Contract references and execution evidence. Recording a contract never approves commercial terms or services. Owner: onboarding module.';

-- ---------------------------------------------------------------------------------------------
-- Udofin engagement scope, services and responsibilities
-- ---------------------------------------------------------------------------------------------
create table onboarding.lender_services (
  id uuid primary key default private.uuid_v7(),
  lender_org_id uuid not null references tenancy.organizations (id) on delete restrict,
  category_key text not null references onboarding.service_categories (key),
  title text not null check (length(title) between 3 and 160),
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  unique (id, lender_org_id)
);
create index lender_services_lender on onboarding.lender_services (lender_org_id);
comment on table onboarding.lender_services is 'A service Udofin may provide to one lender; its content and status live in versions. Owner: onboarding module.';

create table onboarding.service_versions (
  id uuid primary key default private.uuid_v7(),
  lender_org_id uuid not null,
  service_id uuid not null,
  version_no integer not null check (version_no > 0),
  status text not null default 'proposed' check (status in
    ('proposed', 'under_discussion', 'agreed', 'active', 'suspended', 'terminated', 'superseded')),

  requested_scope text check (requested_scope is null or length(requested_scope) between 3 and 4000),
  proposed_scope text check (proposed_scope is null or length(proposed_scope) between 3 and 4000),
  agreed_scope text check (agreed_scope is null or length(agreed_scope) between 3 and 4000),

  responsible_party text not null default 'lender' check (responsible_party in ('lender', 'udofin', 'shared', 'third_party')),
  accountable_party text not null default 'lender' check (accountable_party in ('lender', 'udofin', 'third_party')),
  supporting_parties text[] not null default '{}'
    check (supporting_parties <@ array['lender', 'udofin', 'third_party']),
  shared_allocation text check (shared_allocation is null or length(shared_allocation) between 20 and 4000),
  prerequisites text check (prerequisites is null or length(prerequisites) <= 4000),
  data_exchanged text check (data_exchanged is null or length(data_exchanged) <= 4000),
  permitted_purpose text check (permitted_purpose is null or length(permitted_purpose) <= 2000),
  system_of_record text not null default 'to_be_confirmed' check (system_of_record in
    ('lender_system', 'udofin', 'third_party', 'to_be_confirmed')),
  integration_requirements text check (integration_requirements is null or length(integration_requirements) <= 4000),
  sla_summary text check (sla_summary is null or length(sla_summary) <= 2000),
  escalation_path text check (escalation_path is null or length(escalation_path) <= 2000),
  contract_reference text check (contract_reference is null or length(contract_reference) <= 120),
  effective_from date,
  review_on date,
  status_note text check (status_note is null or length(status_note) <= 2000),

  contributors uuid[] not null default '{}',
  lender_agreed_by uuid references auth.users (id),
  lender_agreed_at timestamptz,
  udofin_agreed_by uuid references auth.users (id),
  udofin_agreed_at timestamptz,
  activated_by uuid references auth.users (id),
  activated_at timestamptz,
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (service_id, version_no),
  unique (id, lender_org_id),
  foreign key (service_id, lender_org_id) references onboarding.lender_services (id, lender_org_id),
  -- "Shared" is never a blank cheque: who does what must be written down.
  constraint shared_is_allocated check (
    (responsible_party <> 'shared' and not 'shared' = any (supporting_parties)) or shared_allocation is not null
  ),
  constraint agreed_is_complete check (
    status not in ('agreed', 'active', 'suspended', 'terminated')
    or (agreed_scope is not null and lender_agreed_by is not null and udofin_agreed_by is not null)
  ),
  constraint active_is_independent check (
    activated_by is null or (activated_by <> udofin_agreed_by and not (activated_by = any (contributors)))
  ),
  constraint udofin_ack_independent check (udofin_agreed_by is null or not (udofin_agreed_by = any (contributors)))
);
create unique index service_versions_one_live on onboarding.service_versions (service_id)
  where status in ('active', 'suspended');
create index service_versions_lender on onboarding.service_versions (lender_org_id, status);
comment on table onboarding.service_versions is
  'Versioned engagement scope for one service: requested vs proposed vs agreed scope, responsibilities, SLA. Agreed/active versions are immutable; a change is a new version. Owner: onboarding module.';

-- ---------------------------------------------------------------------------------------------
-- Requirements and dependencies register
-- ---------------------------------------------------------------------------------------------
create table onboarding.integrations (
  id uuid primary key default private.uuid_v7(),
  lender_org_id uuid not null references tenancy.organizations (id) on delete restrict,
  service_id uuid,
  kind text not null check (kind in ('rest_api', 'file_transfer', 'manual_process', 'other')),
  name text not null check (length(name) between 3 and 160),
  purpose text check (purpose is null or length(purpose) <= 2000),
  -- References to credentials live in the secrets manager, never here; there is no column for them.
  status text not null default 'planned' check (status in ('planned', 'in_progress', 'tested', 'failed', 'manual_exception')),
  test_evidence_document_id uuid,
  tested_by uuid references auth.users (id),
  tested_on date,
  manual_exception_reason text check (manual_exception_reason is null or length(manual_exception_reason) between 20 and 2000),
  exception_requested_by uuid references auth.users (id),
  exception_approved_by uuid references auth.users (id),
  exception_approved_at timestamptz,
  notes text check (notes is null or length(notes) <= 2000),
  contributors uuid[] not null default '{}',
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, lender_org_id),
  foreign key (service_id, lender_org_id) references onboarding.lender_services (id, lender_org_id),
  foreign key (test_evidence_document_id, lender_org_id) references onboarding.documents (id, lender_org_id),
  constraint tested_has_evidence check (status <> 'tested' or (tested_by is not null and tested_on is not null and test_evidence_document_id is not null)),
  constraint exception_is_documented check (
    status <> 'manual_exception'
    or (manual_exception_reason is not null and exception_requested_by is not null
        and exception_approved_by is not null and exception_approved_by <> exception_requested_by
        and exception_approved_at is not null)
  )
);
create index integrations_lender on onboarding.integrations (lender_org_id);
comment on table onboarding.integrations is
  'Technical integration records and their test status. A documented, independently approved manual exception can stand in for a passed test. No credentials are stored. Owner: onboarding module.';

create table onboarding.lender_requirements (
  id uuid primary key default private.uuid_v7(),
  lender_org_id uuid not null references tenancy.organizations (id) on delete restrict,
  template_key text references onboarding.requirement_templates (key),
  title text not null check (length(title) between 3 and 200),
  description text,
  service_id uuid,
  product_id uuid,
  integration_id uuid,
  mandatory boolean not null default true,
  evidence_required boolean not null default false,
  status text not null default 'not_requested' check (status in
    ('not_requested', 'requested', 'in_progress', 'submitted', 'under_review', 'accepted', 'rejected', 'expired', 'waived', 'not_applicable')),
  requested_on date,
  due_on date,
  received_on date,
  evidence_document_id uuid,
  submitted_by uuid references auth.users (id),
  reviewed_by uuid references auth.users (id),
  reviewed_at timestamptz,
  comments text check (comments is null or length(comments) <= 2000),
  contributors uuid[] not null default '{}',
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, lender_org_id),
  foreign key (service_id, lender_org_id) references onboarding.lender_services (id, lender_org_id),
  foreign key (product_id, lender_org_id) references lending.loan_products (id, lender_org_id),
  foreign key (integration_id, lender_org_id) references onboarding.integrations (id, lender_org_id),
  foreign key (evidence_document_id, lender_org_id) references onboarding.documents (id, lender_org_id),
  constraint accepted_is_reviewed check (
    status not in ('accepted', 'rejected', 'waived', 'not_applicable') or (reviewed_by is not null and reviewed_at is not null)
  ),
  constraint accepted_has_evidence check (status <> 'accepted' or not evidence_required or evidence_document_id is not null),
  constraint review_independent check (reviewed_by is null or not (reviewed_by = any (contributors)))
);
create unique index requirements_template_scope on onboarding.lender_requirements
  (lender_org_id, template_key, coalesce(service_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where template_key is not null;
create index requirements_lender on onboarding.lender_requirements (lender_org_id, status);
comment on table onboarding.lender_requirements is
  'What the lender must provide, per lender and optionally per service, product or integration. Owner: onboarding module.';

create table onboarding.requirement_dependencies (
  lender_org_id uuid not null,
  requirement_id uuid not null,
  depends_on_id uuid not null,
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  primary key (requirement_id, depends_on_id),
  foreign key (requirement_id, lender_org_id) references onboarding.lender_requirements (id, lender_org_id),
  foreign key (depends_on_id, lender_org_id) references onboarding.lender_requirements (id, lender_org_id),
  check (requirement_id <> depends_on_id)
);
comment on table onboarding.requirement_dependencies is 'Requirement B cannot be accepted before requirement A is closed. Owner: onboarding module.';

-- ---------------------------------------------------------------------------------------------
-- Activation gates
-- ---------------------------------------------------------------------------------------------
create table onboarding.lender_gates (
  lender_org_id uuid primary key references tenancy.organizations (id) on delete restrict,
  stage text not null default 'profile_created' check (stage in (
    'profile_created', 'institution_verified', 'approved_for_onboarding', 'contract_onboarded', 'service_scope_agreed',
    'product_config_completed', 'product_config_approved', 'integration_tested', 'production_ready_approved',
    'activated', 'suspended', 'deactivated', 'terminated')),
  stage_before_suspension text,
  stage_changed_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table onboarding.lender_gates is
  'Where each lender stands in the activation sequence. Changes only through approved gate requests. Owner: onboarding module.';

create table onboarding.gate_requests (
  id uuid primary key default private.uuid_v7(),
  lender_org_id uuid not null references tenancy.organizations (id) on delete restrict,
  from_stage text not null,
  target_stage text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  requested_by uuid not null references auth.users (id),
  requested_at timestamptz not null default now(),
  request_note text check (request_note is null or length(request_note) <= 2000),
  decided_by uuid references auth.users (id),
  decided_at timestamptz,
  decision_note text check (decision_note is null or length(decision_note) <= 2000),
  -- What the conditions looked like when the decision was taken (keys and booleans only).
  conditions_snapshot jsonb,
  updated_at timestamptz not null default now(),
  constraint no_self_approval check (decided_by is null or decided_by <> requested_by),
  constraint decided_is_complete check ((status in ('approved', 'rejected')) = (decided_by is not null and decided_at is not null))
);
create unique index gate_requests_one_pending on onboarding.gate_requests (lender_org_id) where status = 'pending';
create index gate_requests_lender on onboarding.gate_requests (lender_org_id, requested_at desc);
comment on table onboarding.gate_requests is
  'Two-person gate decisions: one person requests, a different person with onboarding.approve decides. The permanent history of every stage change. Owner: onboarding module.';

-- ---------------------------------------------------------------------------------------------
-- Triggers: audit, secret guard, immutability, no deletes
-- ---------------------------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'institution_categories', 'service_categories', 'requirement_templates', 'documents', 'lender_profiles',
    'verification_history', 'accounting_profiles', 'lender_contracts', 'lender_services', 'service_versions',
    'integrations', 'lender_requirements', 'requirement_dependencies', 'lender_gates', 'gate_requests']
  loop
    execute format('alter table onboarding.%I enable row level security', t);
    execute format('alter table onboarding.%I force row level security', t);
    execute format('create trigger audit_row after insert or update on onboarding.%I for each row execute function onboarding.audit_row()', t);
    execute format('create trigger no_delete before delete on onboarding.%I for each row execute function private.forbid_mutation()', t);
    execute format('create trigger no_truncate before truncate on onboarding.%I for each statement execute function private.forbid_truncate()', t);
  end loop;

  foreach t in array array[
    'institution_categories', 'service_categories', 'requirement_templates', 'lender_profiles', 'accounting_profiles',
    'lender_contracts', 'service_versions', 'integrations', 'lender_requirements', 'lender_gates', 'gate_requests']
  loop
    execute format('create trigger set_updated_at before update on onboarding.%I for each row execute function private.set_updated_at()', t);
  end loop;
end
$$;

create trigger documents_append_only before update on onboarding.documents
  for each row execute function private.forbid_mutation();
create trigger verification_history_append_only before update on onboarding.verification_history
  for each row execute function private.forbid_mutation();
create trigger dependencies_append_only before update on onboarding.requirement_dependencies
  for each row execute function private.forbid_mutation();

create trigger unsafe_text before insert or update on onboarding.lender_profiles
  for each row execute function onboarding.reject_unsafe_text('notes', 'licence_type', 'verification_note');
create trigger unsafe_text before insert or update on onboarding.accounting_profiles
  for each row execute function onboarding.reject_unsafe_text('applicability_basis_note', 'group_relationships', 'notes', 'review_note');
create trigger unsafe_text before insert or update on onboarding.lender_contracts
  for each row execute function onboarding.reject_unsafe_text('note', 'reference');
create trigger unsafe_text before insert or update on onboarding.lender_services
  for each row execute function onboarding.reject_unsafe_text('title');
create trigger unsafe_text before insert or update on onboarding.service_versions
  for each row execute function onboarding.reject_unsafe_text('requested_scope', 'proposed_scope', 'agreed_scope', 'shared_allocation',
    'prerequisites', 'data_exchanged', 'permitted_purpose', 'integration_requirements', 'sla_summary', 'escalation_path',
    'contract_reference', 'status_note');
create trigger unsafe_text before insert or update on onboarding.integrations
  for each row execute function onboarding.reject_unsafe_text('name', 'purpose', 'manual_exception_reason', 'notes');
create trigger unsafe_text before insert or update on onboarding.lender_requirements
  for each row execute function onboarding.reject_unsafe_text('title', 'description', 'comments');
create trigger unsafe_text before insert or update on onboarding.gate_requests
  for each row execute function onboarding.reject_unsafe_text('request_note', 'decision_note');

-- Content of agreed (and later) service versions is frozen; only the lifecycle columns may move.
create or replace function onboarding.protect_service_version()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_lifecycle text[] := array['status', 'status_note', 'updated_at', 'activated_by', 'activated_at', 'lender_agreed_by', 'lender_agreed_at',
                              'udofin_agreed_by', 'udofin_agreed_at', 'agreed_scope', 'contributors'];
begin
  if old.status not in ('proposed', 'under_discussion')
     and (to_jsonb(new) - v_lifecycle) is distinct from (to_jsonb(old) - v_lifecycle) then
    raise exception 'an agreed service version is immutable; propose a new version' using errcode = '55000', hint = 'version_immutable';
  end if;
  if old.status not in ('proposed', 'under_discussion')
     and new.agreed_scope is distinct from old.agreed_scope then
    raise exception 'the agreed scope of an agreed service version cannot change' using errcode = '55000', hint = 'version_immutable';
  end if;
  return new;
end
$$;
create trigger protect before update on onboarding.service_versions
  for each row execute function onboarding.protect_service_version();

-- A verified or submitted accounting profile cannot be edited; only review fields move.
create or replace function onboarding.protect_accounting_profile()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_review text[] := array['status', 'submitted_by', 'submitted_at', 'reviewed_by', 'reviewed_at', 'review_note', 'last_verified_on', 'updated_at', 'contributors'];
begin
  if old.status <> 'draft' and (to_jsonb(new) - v_review) is distinct from (to_jsonb(old) - v_review) then
    raise exception 'a submitted accounting profile is immutable; start a new version' using errcode = '55000', hint = 'version_immutable';
  end if;
  return new;
end
$$;
create trigger protect before update on onboarding.accounting_profiles
  for each row execute function onboarding.protect_accounting_profile();

-- Institution verification history: every change of verification state is recorded.
create or replace function onboarding.record_profile_verification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' or new.verification_status is distinct from old.verification_status
     or new.verification_evidence_id is distinct from old.verification_evidence_id then
    insert into onboarding.verification_history (lender_org_id, subject, subject_ref, status, evidence_document_id, actor_id, note)
    values (new.lender_org_id, 'institution', new.lender_org_id, new.verification_status, new.verification_evidence_id,
            coalesce((select auth.uid()), new.created_by), new.verification_note);
  end if;
  return new;
end
$$;
create trigger record_verification after insert or update on onboarding.lender_profiles
  for each row execute function onboarding.record_profile_verification();

create or replace function onboarding.record_accounting_verification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    insert into onboarding.verification_history (lender_org_id, subject, subject_ref, status, evidence_document_id, actor_id, note)
    values (new.lender_org_id, 'accounting', new.id, new.status, new.evidence_document_id,
            coalesce((select auth.uid()), new.created_by), new.review_note);
  end if;
  return new;
end
$$;
create trigger record_verification after insert or update on onboarding.accounting_profiles
  for each row execute function onboarding.record_accounting_verification();

-- ---------------------------------------------------------------------------------------------
-- Row-level security: read only; writes go through the functions in migration 0750.
-- ---------------------------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'documents', 'lender_profiles', 'verification_history', 'accounting_profiles', 'lender_contracts', 'lender_services',
    'service_versions', 'integrations', 'lender_requirements', 'requirement_dependencies', 'lender_gates', 'gate_requests']
  loop
    execute format(
      'create policy tenant_read on onboarding.%I for select to authenticated using (lender_org_id in (select private.orgs_with_permission(%L)))',
      t, 'onboarding.read');
    execute format('grant select on onboarding.%I to authenticated', t);
  end loop;
end
$$;

create policy reference_read on onboarding.institution_categories for select to authenticated using (true);
create policy reference_read on onboarding.service_categories for select to authenticated using (true);
create policy staff_read on onboarding.requirement_templates for select to authenticated
  using (exists (select 1 from private.orgs_with_permission('onboarding.read')) or (select private.has_platform_permission('onboarding.read')));
grant select on onboarding.institution_categories, onboarding.service_categories, onboarding.requirement_templates to authenticated;
