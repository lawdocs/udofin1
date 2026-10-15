-- =============================================================================================
-- Phase 08a: account ownership registry, merchant registry, provider register and per-lender payment configuration
-- (spec docs/specs/08-servicing-payments-mandates-collections.md sections 7.1, 7.2, 15, 18, 20; owner decision 3 and the
-- account-format answer of 14 October 2026).
--
-- Purpose: stop repayment settlement to an account that belongs to Udofin, to a group company or to anybody but the lender,
-- when the approved flow is "the borrower pays directly into the lender's own account" (RBI Credit Facilities para 10(2)
-- and 10(3), confirmed text). Fail closed: unknown, unverified, inconsistent or prohibited destinations are refused or held.
--
--   1. payments.account_format_rules   Account-number formats as DATA by country and account type (9 to 18 digits is only the
--                                      initial rule, seeded `draft`/`unverified`). The registry may only reference an APPROVED
--                                      rule, so until the platform approves a rule through the two-person flow NO account can
--                                      be registered.
--   2. payments.account_registry       Keyed-HMAC account fingerprint + ownership registry. The BACKEND computes the fingerprint;
--                                      the database never sees an account number and holds no HMAC key. Starts EMPTY.
--      payments.classify_destination   Pure function of registry state: permitted | hold | refused.
--   3. tenancy.lender_settlement_accounts gains registry_id; an account becomes `verified` only with proof from the registry,
--                                      and the registry is read LIVE (a later revoke makes the account unusable).
--   4. payments.provider_register, payments.merchant_registry (a merchant id cannot be claimed twice).
--   5. payments.lender_payment_configs (+ history): draft -> pending_approval -> active | suspended | retired, maker-checker;
--      payments.validate_collection_target implements spec 7.1 steps 1 to 4 (step 5 is runtime: system_suspend_payment_config).
--   6. payments.payment_intents gain config_id / provider_mode; new intents REQUIRE an active, currently valid configuration.
--   7. private.feature_prerequisites_unmet extended (earlier checks preserved): 'payments' needs an ACTIVE production config.
--
-- Forward-only. Seeds NO account, fingerprint, merchant, provider, owner or configuration. The only seed is the initial
-- account-format assumption, as a DRAFT with evidence label `unverified`. No new enum values (text and checks only).
-- Error codes: 42501 not authorised, P0002 not found, 22023 bad input, 55000 rule/state, 23505 duplicate, 23514 check or
-- segregation, 23503 reference. Hints are stable identifiers (docs/specs/08a-notes/accounts.md).
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- 0. Small shared pieces
-- ---------------------------------------------------------------------------------------------
-- A composite tenant key to organisations so a registry or merchant owner can be proven to be a LENDER organisation.
alter table tenancy.organizations add constraint organizations_id_kind_key unique (id, kind);

create or replace function private.today_ist()
returns date
language sql
stable
set search_path = ''
as $$ select (now() at time zone 'Asia/Kolkata')::date $$;
comment on function private.today_ist() is 'Today in India (Asia/Kolkata). Registry and rule effective dates are calendar dates in IST; effective_to is exclusive.';
revoke all on function private.today_ist() from public;
grant execute on function private.today_ist() to authenticated, service_role;

-- Permitted purposes of an account: a non-empty set of distinct known values.
create or replace function private.account_purposes_ok(p_purposes text[])
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select p_purposes is not null
     and cardinality(p_purposes) between 1 and 4
     and array_position(p_purposes, null) is null
     and p_purposes <@ array['repayment_settlement', 'fee_collection', 'disbursement_source', 'operational']::text[]
     and cardinality(p_purposes) = (select count(distinct x) from unnest(p_purposes) x)
$$;
revoke all on function private.account_purposes_ok(text[]) from public;
grant execute on function private.account_purposes_ok(text[]) to authenticated, service_role;

-- Rail limits copied from provider documentation: { "<rail>": { "<limit>": <string | boolean | non-negative integer> } }.
-- Money limits are integer paise or a digit string; fractions are refused. A source note is required by the table.
create or replace function private.rail_limits_ok(p jsonb)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case when p is not null and jsonb_typeof(p) = 'object' and octet_length(p::text) <= 4000 then
    not exists (
      select 1 from jsonb_each(p) top
      where top.key !~ '^[a-z][a-z0-9_]{1,40}$'
         or jsonb_typeof(top.value) <> 'object'
         or case when jsonb_typeof(top.value) = 'object' then exists (
              select 1 from jsonb_each(top.value) leaf
              where leaf.key !~ '^[a-z][a-z0-9_]{1,40}$'
                 or not (
                      (jsonb_typeof(leaf.value) = 'string' and length(leaf.value #>> '{}') between 1 and 100)
                   or jsonb_typeof(leaf.value) = 'boolean'
                   or (jsonb_typeof(leaf.value) = 'number' and (leaf.value #>> '{}') ~ '^[0-9]{1,15}$')))
            else true end)
  else false end
$$;
revoke all on function private.rail_limits_ok(jsonb) from public;
grant execute on function private.rail_limits_ok(jsonb) to authenticated, service_role;

-- Audit through the existing path (audit.events). Metadata holds identifiers, names and codes only: never an account
-- number, fingerprint, secret or personal data.
create or replace function private.write_payments_audit(
  p_tenant uuid, p_action text, p_entity_type text, p_entity_id text, p_metadata jsonb, p_outcome audit.outcome default 'success'
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into audit.events (actor_type, actor_user_id, tenant_org_id, action, entity_type, entity_id, outcome, metadata)
  values (
    case private.current_actor() when 'platform' then 'platform' when 'system' then 'system' else 'staff' end::audit.actor_type,
    (select auth.uid()), p_tenant, p_action, p_entity_type, p_entity_id, p_outcome, coalesce(p_metadata, '{}'::jsonb))
$$;
revoke all on function private.write_payments_audit(uuid, text, text, text, jsonb, audit.outcome) from public;

-- Platform-side authorisation: the caller must hold one of the permissions now, with a second factor.
create or replace function private.accounts_require_platform(p_permissions text[])
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_perm text;
begin
  if v_uid is null then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  foreach v_perm in array p_permissions loop
    if private.has_platform_permission(v_perm) then
      perform private.require_aal2();
      return v_uid;
    end if;
  end loop;
  raise exception 'not authorised' using errcode = '42501';
end
$$;
revoke all on function private.accounts_require_platform(text[]) from public;

-- Lender-side authorisation for one lender organisation.
create or replace function private.payments_require_lender(p_lender uuid, p_permission text)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null or p_lender is null or p_lender not in (select private.orgs_with_permission(p_permission)) then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  if not exists (select 1 from tenancy.organizations o where o.id = p_lender and o.kind = 'lender') then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  perform private.require_aal2();
  return v_uid;
end
$$;
revoke all on function private.payments_require_lender(uuid, text) from public;

-- ---------------------------------------------------------------------------------------------
-- 1. Account format rules (data by country and account type; changes are append-only history)
-- ---------------------------------------------------------------------------------------------
create table payments.account_format_rules (
  id uuid primary key default private.uuid_v7(),
  country char(2) not null check (country ~ '^[A-Z]{2}$'),
  account_type text not null check (account_type ~ '^[a-z][a-z0-9_]{2,40}$'),
  version integer not null check (version >= 1),
  min_digits integer not null check (min_digits between 1 and 40),
  max_digits integer not null check (max_digits between 1 and 40),
  ifsc_required boolean not null,
  status text not null default 'draft' check (status in ('draft', 'approved', 'retired')),
  evidence_label text not null check (evidence_label in ('unverified', 'likely', 'confirmed')),
  source_note text not null check (length(trim(source_note)) between 10 and 500),
  effective_from date not null,
  effective_to date,
  -- drafted_by is null only for the rule seeded by this migration.
  drafted_by uuid references auth.users (id),
  drafted_at timestamptz not null default now(),
  submitted_by uuid references auth.users (id),
  submitted_at timestamptz,
  approved_by uuid references auth.users (id),
  approved_at timestamptz,
  approval_note text check (approval_note is null or length(approval_note) <= 1000),
  retired_by uuid references auth.users (id),
  retired_at timestamptz,
  retired_reason text check (retired_reason is null or length(retired_reason) between 10 and 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (country, account_type, version),
  unique (id, country, account_type),
  constraint digits_range check (max_digits >= min_digits),
  constraint effective_range check (effective_to is null or effective_to > effective_from),
  constraint approved_is_two_person check (
    status <> 'approved'
    or (approved_by is not null and approved_at is not null and submitted_by is not null
        and approved_by <> submitted_by and approved_by is distinct from drafted_by)),
  constraint draft_is_not_approved check (status <> 'draft' or approved_by is null),
  constraint retired_has_reason check (status <> 'retired' or (retired_by is not null and retired_at is not null and retired_reason is not null))
);
create unique index account_format_rules_one_approved on payments.account_format_rules (country, account_type) where status = 'approved';
comment on table payments.account_format_rules is
  'Account-number formats by country and account type, as data (owner answer of 14 Oct 2026: 9 to 18 digits is only the INITIAL rule, unverified until its source is supplied). The registry may reference only an APPROVED rule; approval is two-person (platform.accounts.registry.manage proposes, platform.accounts.registry.verify approves). Content never changes: a change is a new version. The database never sees an account number: the API validates the number against the rule BEFORE computing the fingerprint and attests that to payments.register_account. Written only by the payments.*_account_format_rule functions. Owner: payments module.';
comment on column payments.account_format_rules.evidence_label is
  'unverified, likely or confirmed, as in the regulatory status labels. The seeded rule is unverified: approving an unverified rule is a recorded platform decision, not evidence.';

create table payments.account_format_rule_events (
  id uuid primary key default private.uuid_v7(),
  rule_id uuid not null references payments.account_format_rules (id) on delete restrict,
  event_kind text not null check (event_kind in ('drafted', 'submitted', 'approved', 'retired')),
  from_status text,
  to_status text not null,
  actor_id uuid references auth.users (id),
  note text,
  occurred_at timestamptz not null default clock_timestamp()
);
create index account_format_rule_events_rule on payments.account_format_rule_events (rule_id, occurred_at);
comment on table payments.account_format_rule_events is
  'Append-only history of every change to an account format rule: who, when, why. No personal data. Written only by the trigger private.record_account_format_rule_event. Owner: payments module.';

create trigger unsafe_text before insert or update on payments.account_format_rules
  for each row execute function onboarding.reject_unsafe_text('source_note', 'approval_note', 'retired_reason');
create trigger set_updated_at before update on payments.account_format_rules
  for each row execute function private.set_updated_at();

-- Content is immutable; only the approval/retirement columns move, and only along draft -> approved -> retired.
create or replace function private.protect_account_format_rule()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'account format rules are never deleted' using errcode = 'P0001';
  end if;
  if (to_jsonb(new) - array['status', 'submitted_by', 'submitted_at', 'approved_by', 'approved_at', 'approval_note', 'retired_by',
                            'retired_at', 'retired_reason', 'updated_at'])
     is distinct from
     (to_jsonb(old) - array['status', 'submitted_by', 'submitted_at', 'approved_by', 'approved_at', 'approval_note', 'retired_by',
                            'retired_at', 'retired_reason', 'updated_at']) then
    raise exception 'an account format rule cannot be edited: draft a new version' using errcode = 'P0001';
  end if;
  if old.submitted_by is not null and new.submitted_by is distinct from old.submitted_by then
    raise exception 'the proposer of a rule cannot change' using errcode = 'P0001';
  end if;
  if new.status is distinct from old.status then
    if not ((old.status = 'draft' and new.status in ('approved', 'retired')) or (old.status = 'approved' and new.status = 'retired')) then
      raise exception 'account format rule transition % -> % is not allowed', old.status, new.status using errcode = 'P0001';
    end if;
  elsif old.status in ('approved', 'retired') and (to_jsonb(new) - 'updated_at') is distinct from (to_jsonb(old) - 'updated_at') then
    raise exception 'an approved or retired account format rule cannot change' using errcode = 'P0001';
  elsif old.status = 'draft'
        and (to_jsonb(new) - array['submitted_by', 'submitted_at', 'updated_at']) is distinct from (to_jsonb(old) - array['submitted_by', 'submitted_at', 'updated_at']) then
    raise exception 'a draft account format rule changes only by being proposed, approved or retired' using errcode = 'P0001';
  end if;
  return new;
end
$$;
revoke all on function private.protect_account_format_rule() from public;
create trigger protect before update or delete on payments.account_format_rules
  for each row execute function private.protect_account_format_rule();
create trigger no_truncate before truncate on payments.account_format_rules
  for each statement execute function private.forbid_truncate();

create or replace function private.record_account_format_rule_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into payments.account_format_rule_events (rule_id, event_kind, from_status, to_status, actor_id, note)
    values (new.id, 'drafted', null, new.status, new.drafted_by,
            case when new.drafted_by is null then 'seeded by migration as a draft; not approved' else null end);
    return new;
  end if;
  if old.submitted_by is null and new.submitted_by is not null then
    insert into payments.account_format_rule_events (rule_id, event_kind, from_status, to_status, actor_id)
    values (new.id, 'submitted', old.status, new.status, new.submitted_by);
  end if;
  if new.status is distinct from old.status then
    insert into payments.account_format_rule_events (rule_id, event_kind, from_status, to_status, actor_id, note)
    values (new.id, case new.status when 'approved' then 'approved' else 'retired' end, old.status, new.status,
            case new.status when 'approved' then new.approved_by else new.retired_by end,
            case new.status when 'approved' then new.approval_note else new.retired_reason end);
  end if;
  return new;
end
$$;
revoke all on function private.record_account_format_rule_event() from public;
create trigger record_event after insert or update on payments.account_format_rules
  for each row execute function private.record_account_format_rule_event();

create trigger append_only before update or delete on payments.account_format_rule_events
  for each row execute function private.forbid_mutation();
create trigger no_truncate before truncate on payments.account_format_rule_events
  for each statement execute function private.forbid_truncate();

-- The ONLY seed of this migration: the owner's initial assumption, as a DRAFT with no source on file. Nothing can be
-- registered until the platform approves a rule through the two-person flow.
insert into payments.account_format_rules (country, account_type, version, min_digits, max_digits, ifsc_required, status, evidence_label,
                                           source_note, effective_from)
values ('IN', 'bank_account', 1, 9, 18, true, 'draft', 'unverified', 'initial assumption, no source on file', date '2026-10-14');

-- ---------------------------------------------------------------------------------------------
-- 2. Provider register (vocabulary of payment, mandate and LMS providers and their authorisation evidence)
-- ---------------------------------------------------------------------------------------------
create table payments.provider_register (
  provider text primary key check (provider ~ '^[a-z][a-z0-9_]{2,49}$'),
  display_name text not null check (length(trim(display_name)) between 2 and 120),
  kind text not null check (kind in ('payment', 'mandate', 'payment_and_mandate')),
  status text not null default 'draft' check (status in ('draft', 'approved', 'suspended')),
  authorisation_evidence_ref text check (authorisation_evidence_ref is null or authorisation_evidence_ref ~ '^[A-Za-z0-9][A-Za-z0-9 ._:/#,()-]{2,199}$'),
  evidence_label text not null default 'unverified' check (evidence_label in ('unverified', 'likely', 'confirmed')),
  status_reason text check (status_reason is null or length(status_reason) between 10 and 1000),
  updated_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table payments.provider_register is
  'Platform register of payment and mandate providers and the evidence of their authorisation (spec 7.1 step 4, PAY-05). A configuration may use a provider only while it is approved; a PRODUCTION configuration additionally needs authorisation_evidence_ref. Nothing is seeded: no provider has been chosen (D-65). Written only by payments.set_payment_provider (platform.payments.providers.manage). Owner: payments module.';
create trigger unsafe_text before insert or update on payments.provider_register
  for each row execute function onboarding.reject_unsafe_text('display_name', 'authorisation_evidence_ref', 'status_reason');
create trigger set_updated_at before update on payments.provider_register
  for each row execute function private.set_updated_at();
create trigger no_delete before delete on payments.provider_register
  for each row execute function private.forbid_mutation();
create trigger no_truncate before truncate on payments.provider_register
  for each statement execute function private.forbid_truncate();

-- ---------------------------------------------------------------------------------------------
-- 3. Account registry (fingerprint + ownership) and its history
-- ---------------------------------------------------------------------------------------------
create table payments.account_registry (
  id uuid primary key default private.uuid_v7(),
  -- Keyed HMAC computed by the BACKEND (packages/adapters account-fingerprint.ts). A new key_version means RE-REGISTRATION:
  -- the same real account then has a different fingerprint, and classification looks up by (fingerprint, key_version).
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  key_version integer not null check (key_version >= 1),
  -- Last four digits only.
  masked_ref text not null check (masked_ref ~ '^[X*]{2,}[0-9]{4}$'),
  country char(2) not null,
  account_type text not null,
  format_rule_id uuid not null,
  -- Attested by the backend: the number was validated against the approved rule BEFORE it was fingerprinted.
  format_validated boolean not null check (format_validated),
  owner_kind text not null check (owner_kind in ('lender', 'udofin', 'group_company', 'other')),
  owner_org_id uuid,
  owner_org_kind tenancy.organization_kind generated always as (case when owner_kind = 'lender' then 'lender'::tenancy.organization_kind end) stored,
  -- A LEGAL ENTITY name (company, LLP, trust, society, statutory body...). Never the name of an individual.
  legal_owner_name text not null check (length(trim(legal_owner_name)) between 3 and 200),
  permitted_purposes text[] not null check (private.account_purposes_ok(permitted_purposes)),
  verification_status text not null default 'unverified' check (verification_status in ('unverified', 'verified', 'rejected', 'revoked')),
  -- A reference label to the evidence the verifier saw (document id, ticket, register extract). No file bytes.
  evidence_ref text check (evidence_ref is null or evidence_ref ~ '^[A-Za-z0-9][A-Za-z0-9 ._:/#,()-]{2,199}$'),
  effective_from date not null,
  effective_to date,
  registered_by uuid not null references auth.users (id),
  registered_at timestamptz not null default now(),
  idempotency_key text not null check (length(idempotency_key) between 16 and 128),
  verified_by uuid references auth.users (id),
  verified_at timestamptz,
  verification_note text check (verification_note is null or length(verification_note) <= 1000),
  rejected_by uuid references auth.users (id),
  rejected_at timestamptz,
  rejection_reason text check (rejection_reason is null or length(rejection_reason) between 10 and 1000),
  revoked_by uuid references auth.users (id),
  revoked_at timestamptz,
  revoked_reason text check (revoked_reason is null or length(revoked_reason) between 10 and 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One registry entry per real account: the same account cannot be registered under two owners.
  unique (fingerprint, key_version),
  unique (registered_by, idempotency_key),
  unique (id, owner_org_id),
  foreign key (format_rule_id, country, account_type) references payments.account_format_rules (id, country, account_type) on delete restrict,
  foreign key (owner_org_id, owner_org_kind) references tenancy.organizations (id, kind) on delete restrict,
  constraint owner_org_iff_lender check ((owner_kind = 'lender') = (owner_org_id is not null)),
  constraint repayment_only_for_lender_accounts check (owner_kind = 'lender' or not ('repayment_settlement' = any (permitted_purposes))),
  constraint effective_range check (effective_to is null or effective_to > effective_from),
  constraint verifier_is_not_registrant check (verified_by is null or verified_by <> registered_by),
  constraint verified_needs_evidence check (
    verification_status <> 'verified'
    or (verified_by is not null and verified_at is not null and evidence_ref is not null)),
  constraint rejected_has_reason check (verification_status <> 'rejected' or (rejected_by is not null and rejected_at is not null and rejection_reason is not null)),
  constraint revoked_has_reason check (verification_status <> 'revoked' or (revoked_by is not null and revoked_at is not null and revoked_reason is not null)),
  constraint unverified_is_untouched check (verification_status <> 'unverified' or (verified_by is null and rejected_by is null and revoked_by is null))
);
create index account_registry_format_rule on payments.account_registry (format_rule_id);
create index account_registry_owner_org on payments.account_registry (owner_org_id);
comment on table payments.account_registry is
  'Fail-closed registry of account fingerprints and who owns them (owner decision 3, 14 Oct 2026). Starts EMPTY: nothing is seeded, no account is assumed to belong to a lender because details were supplied. unique (fingerprint, key_version) means one entry per real account, so the same account cannot sit under two owners; a new key_version means re-registration. owner_kind <> lender can never carry the repayment_settlement purpose. A verified entry needs a DIFFERENT person than the registrant and an evidence reference. Rows are never deleted; the only changes are unverified -> verified | rejected | revoked and verified -> revoked, each through payments.verify_account / reject_account / revoke_account. Readable only by platform users holding the registry permissions and by the validation functions; lenders see masked reference and status only through payments.my_settlement_account_registry_status. Owner: payments module.';
comment on column payments.account_registry.legal_owner_name is
  'Name of the LEGAL ENTITY that owns the account (company, LLP, trust, society, statutory body). Never the name of an individual: Udofin stores minimal personal data (CLAUDE.md rule 3).';
comment on column payments.account_registry.effective_to is 'Exclusive end date (IST). Null = open ended.';

create trigger unsafe_text before insert or update on payments.account_registry
  for each row execute function onboarding.reject_unsafe_text('legal_owner_name', 'evidence_ref', 'verification_note', 'rejection_reason', 'revoked_reason');
create trigger set_updated_at before update on payments.account_registry
  for each row execute function private.set_updated_at();
create trigger no_delete before delete on payments.account_registry
  for each row execute function private.forbid_mutation();
create trigger no_truncate before truncate on payments.account_registry
  for each statement execute function private.forbid_truncate();

create or replace function private.protect_account_registry()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_moving text[] := array['verification_status', 'evidence_ref', 'verified_by', 'verified_at', 'verification_note', 'rejected_by',
                           'rejected_at', 'rejection_reason', 'revoked_by', 'revoked_at', 'revoked_reason', 'updated_at'];
  -- owner_org_kind is a generated column: it is computed AFTER before-row triggers, so NEW does not carry it yet.
  v_derived text[] := array['owner_org_kind', 'updated_at'];
begin
  if (to_jsonb(new) - v_moving - 'owner_org_kind') is distinct from (to_jsonb(old) - v_moving - 'owner_org_kind') then
    raise exception 'a registry entry cannot be edited: fingerprint, owner, purposes and dates are fixed once registered'
      using errcode = 'P0001';
  end if;
  if new.verification_status = old.verification_status then
    if (to_jsonb(new) - v_derived) is distinct from (to_jsonb(old) - v_derived) then
      raise exception 'a registry entry changes only through a status transition' using errcode = 'P0001';
    end if;
    return new;
  end if;
  if not (
    (old.verification_status = 'unverified' and new.verification_status in ('verified', 'rejected', 'revoked'))
    or (old.verification_status = 'verified' and new.verification_status = 'revoked')
  ) then
    raise exception 'registry transition % -> % is not allowed', old.verification_status, new.verification_status using errcode = 'P0001';
  end if;
  -- What was recorded earlier stays recorded.
  if old.verified_by is not null and (new.verified_by, new.verified_at, new.evidence_ref) is distinct from (old.verified_by, old.verified_at, old.evidence_ref) then
    raise exception 'verification evidence cannot change' using errcode = 'P0001';
  end if;
  return new;
end
$$;
revoke all on function private.protect_account_registry() from public;
create trigger protect before update on payments.account_registry
  for each row execute function private.protect_account_registry();

create table payments.account_registry_events (
  id uuid primary key default private.uuid_v7(),
  registry_id uuid not null references payments.account_registry (id) on delete restrict,
  event_kind text not null check (event_kind in ('registered', 'verified', 'rejected', 'revoked')),
  from_status text,
  to_status text not null,
  actor_id uuid references auth.users (id),
  evidence_ref text,
  note text,
  occurred_at timestamptz not null default clock_timestamp()
);
create index account_registry_events_registry on payments.account_registry_events (registry_id, occurred_at);
comment on table payments.account_registry_events is
  'Append-only history of registry entries: who registered, verified, rejected or revoked an account, when, on what evidence reference and why. No account number, no fingerprint, no personal data. Written only by the trigger private.record_account_registry_event; no role has INSERT, UPDATE or DELETE. Owner: payments module.';
create trigger append_only before update or delete on payments.account_registry_events
  for each row execute function private.forbid_mutation();
create trigger no_truncate before truncate on payments.account_registry_events
  for each statement execute function private.forbid_truncate();

create or replace function private.record_account_registry_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into payments.account_registry_events (registry_id, event_kind, from_status, to_status, actor_id)
    values (new.id, 'registered', null, new.verification_status, new.registered_by);
    return new;
  end if;
  if new.verification_status is distinct from old.verification_status then
    insert into payments.account_registry_events (registry_id, event_kind, from_status, to_status, actor_id, evidence_ref, note)
    values (new.id, new.verification_status, old.verification_status, new.verification_status,
            case new.verification_status when 'verified' then new.verified_by when 'rejected' then new.rejected_by else new.revoked_by end,
            case when new.verification_status = 'verified' then new.evidence_ref end,
            case new.verification_status when 'verified' then new.verification_note when 'rejected' then new.rejection_reason else new.revoked_reason end);
  end if;
  return new;
end
$$;
revoke all on function private.record_account_registry_event() from public;
create trigger record_event after insert or update on payments.account_registry
  for each row execute function private.record_account_registry_event();

-- ---------------------------------------------------------------------------------------------
-- 4. Merchant registry (a merchant id cannot be claimed twice; Udofin's fee merchant can never take repayments)
-- ---------------------------------------------------------------------------------------------
create table payments.merchant_registry (
  id uuid primary key default private.uuid_v7(),
  provider text not null references payments.provider_register (provider) on delete restrict,
  merchant_ref text not null check (merchant_ref ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{2,99}$'),
  owner_kind text not null check (owner_kind in ('lender', 'udofin_fees')),
  owner_org_id uuid,
  owner_org_kind tenancy.organization_kind generated always as (case when owner_kind = 'lender' then 'lender'::tenancy.organization_kind end) stored,
  purpose text not null check (purpose in ('repayment', 'fee_collection')),
  status text not null default 'active' check (status in ('active', 'revoked')),
  claimed_by uuid not null references auth.users (id),
  claimed_at timestamptz not null default now(),
  revoked_by uuid references auth.users (id),
  revoked_at timestamptz,
  revoked_reason text check (revoked_reason is null or length(revoked_reason) between 10 and 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Unique across ALL organisations (and across revoked claims: a merchant id stays attributable).
  unique (provider, merchant_ref),
  unique (id, owner_org_id),
  foreign key (owner_org_id, owner_org_kind) references tenancy.organizations (id, kind) on delete restrict,
  constraint owner_org_iff_lender check ((owner_kind = 'lender') = (owner_org_id is not null)),
  constraint purpose_matches_owner check ((owner_kind = 'lender' and purpose = 'repayment') or (owner_kind = 'udofin_fees' and purpose = 'fee_collection')),
  constraint revoked_has_reason check (status <> 'revoked' or (revoked_by is not null and revoked_at is not null and revoked_reason is not null))
);
create index merchant_registry_owner_org on payments.merchant_registry (owner_org_id);
comment on table payments.merchant_registry is
  'Provider merchant identifiers and who owns them: a lender (purpose repayment) or Udofin''s own fee-collection merchant (owner_kind udofin_fees, purpose fee_collection). unique (provider, merchant_ref) across ALL organisations, so a merchant id cannot be claimed twice; a payment configuration can only reference a merchant of its own lender (composite key), so Udofin''s fee merchant can never be used for repayments. Nothing is seeded. Written only by payments.claim_merchant / register_udofin_fee_merchant / revoke_merchant. Owner: payments module.';
create trigger unsafe_text before insert or update on payments.merchant_registry
  for each row execute function onboarding.reject_unsafe_text('revoked_reason');
create trigger set_updated_at before update on payments.merchant_registry
  for each row execute function private.set_updated_at();
create trigger no_delete before delete on payments.merchant_registry
  for each row execute function private.forbid_mutation();
create trigger no_truncate before truncate on payments.merchant_registry
  for each statement execute function private.forbid_truncate();

create or replace function private.protect_merchant_registry()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_moving text[] := array['status', 'revoked_by', 'revoked_at', 'revoked_reason', 'updated_at', 'owner_org_kind'];
  v_derived text[] := array['owner_org_kind', 'updated_at'];
begin
  -- owner_org_kind is generated (computed after before-row triggers), so it is left out of every comparison.
  if (to_jsonb(new) - v_moving) is distinct from (to_jsonb(old) - v_moving) then
    raise exception 'a merchant registration cannot be edited' using errcode = 'P0001';
  end if;
  if old.status = 'revoked' and (to_jsonb(new) - v_derived) is distinct from (to_jsonb(old) - v_derived) then
    raise exception 'a revoked merchant registration is final' using errcode = 'P0001';
  end if;
  return new;
end
$$;
revoke all on function private.protect_merchant_registry() from public;
create trigger protect before update on payments.merchant_registry
  for each row execute function private.protect_merchant_registry();

-- ---------------------------------------------------------------------------------------------
-- 5. Settlement accounts: link to the registry; `verified` only with proof, read live
-- ---------------------------------------------------------------------------------------------
-- Fail closed for anything that could exist from before this migration: a verified account without registry proof is
-- revoked. (No environment holds data; this is a guard, not a migration of data.)
update tenancy.lender_settlement_accounts set status = 'revoked' where status = 'verified';

alter table tenancy.lender_settlement_accounts add column registry_id uuid;
alter table tenancy.lender_settlement_accounts add constraint lender_settlement_accounts_registry_fk
  foreign key (registry_id, lender_org_id) references payments.account_registry (id, owner_org_id) on delete restrict;
-- One settlement account per registry entry (and so per real account). A plain unique index: nulls repeat.
create unique index lender_settlement_accounts_registry on tenancy.lender_settlement_accounts (registry_id);
comment on column tenancy.lender_settlement_accounts.registry_id is
  'The payments.account_registry entry that proves who owns this account. status = verified is possible only while that entry is verified, owned by THIS lender, permitted for repayment_settlement and effective; the proof is re-read live by payments.validate_collection_target, so revoking the registry entry makes the account unusable at once.';

-- ---------------------------------------------------------------------------------------------
-- 6. Classification (pure function of registry state)
-- ---------------------------------------------------------------------------------------------
create or replace function private.classify_registry_entry(p_entry payments.account_registry, p_lender uuid, p_purpose text)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_reasons text[] := '{}';
  v_today date := private.today_ist();
  v_hold boolean := false;
begin
  if p_entry.id is null or p_lender is null
     or p_purpose is null or p_purpose not in ('repayment_settlement', 'fee_collection', 'disbursement_source', 'operational') then
    return jsonb_build_object('decision', 'refused', 'reasons', jsonb_build_array('input_invalid'));
  end if;
  if p_entry.verification_status = 'rejected' then
    return jsonb_build_object('decision', 'refused', 'reasons', jsonb_build_array('account_rejected'));
  elsif p_entry.verification_status = 'revoked' then
    return jsonb_build_object('decision', 'refused', 'reasons', jsonb_build_array('account_revoked'));
  elsif p_entry.verification_status = 'unverified' then
    v_hold := true;
    v_reasons := v_reasons || 'account_unverified'::text;
  end if;
  if p_purpose = 'repayment_settlement' and p_entry.owner_kind <> 'lender' then
    v_reasons := v_reasons || 'owner_prohibited'::text;
  end if;
  -- Literal reading of the spec: the owner must be the lender in question. A non-lender-owned account can therefore never be
  -- `permitted` in a lender context; such accounts are registered to be RECOGNISED and refused.
  if p_entry.owner_org_id is distinct from p_lender then
    v_reasons := v_reasons || 'owner_mismatch'::text;
  end if;
  if not (p_purpose = any (p_entry.permitted_purposes)) then
    v_reasons := v_reasons || 'purpose_not_permitted'::text;
  end if;
  if v_today < p_entry.effective_from or (p_entry.effective_to is not null and v_today >= p_entry.effective_to) then
    v_reasons := v_reasons || 'not_effective'::text;
  end if;
  return jsonb_build_object(
    'decision', case when exists (select 1 from unnest(v_reasons) r where r <> 'account_unverified') then 'refused'
                     when v_hold then 'hold' else 'permitted' end,
    'reasons', to_jsonb(v_reasons));
end
$$;
revoke all on function private.classify_registry_entry(payments.account_registry, uuid, text) from public;

create or replace function private.classify_destination_impl(p_fingerprint text, p_key_version integer, p_lender uuid, p_purpose text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_entry payments.account_registry;
begin
  if p_fingerprint is null or p_fingerprint !~ '^[0-9a-f]{64}$' or p_key_version is null or p_key_version < 1 or p_lender is null
     or p_purpose is null or p_purpose not in ('repayment_settlement', 'fee_collection', 'disbursement_source', 'operational') then
    return jsonb_build_object('decision', 'refused', 'reasons', jsonb_build_array('input_invalid'));
  end if;
  select * into v_entry from payments.account_registry r where r.fingerprint = p_fingerprint and r.key_version = p_key_version;
  if not found then
    return jsonb_build_object('decision', 'refused', 'reasons', jsonb_build_array('account_unknown'));
  end if;
  return private.classify_registry_entry(v_entry, p_lender, p_purpose);
end
$$;
revoke all on function private.classify_destination_impl(text, integer, uuid, text) from public;

-- System-only entry point. User-facing definers call the private implementation (invoking_role would be `authenticated`).
create or replace function payments.classify_destination(p_fingerprint text, p_key_version integer, p_lender uuid, p_purpose text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if private.invoking_role() <> 'service_role' then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  return private.classify_destination_impl(p_fingerprint, p_key_version, p_lender, p_purpose);
end
$$;
comment on function payments.classify_destination(text, integer, uuid, text) is
  'System only. {decision: permitted | hold | refused, reasons: text[]}. unknown -> refused account_unknown; unverified -> hold account_unverified; rejected / revoked -> refused account_rejected / account_revoked; owner_kind other than lender for repayment_settlement -> refused owner_prohibited; owner organisation other than p_lender -> refused owner_mismatch; purpose not in permitted_purposes -> refused purpose_not_permitted; outside the effective dates (IST, effective_to exclusive) -> refused not_effective; malformed input -> refused input_invalid. Only `permitted` passes. A pure function of registry state; looks up by (fingerprint, key_version).';
revoke all on function payments.classify_destination(text, integer, uuid, text) from public;
grant execute on function payments.classify_destination(text, integer, uuid, text) to service_role;

-- ---------------------------------------------------------------------------------------------
-- 7. Settlement-account guard (proof for `verified`, live) and revocation cascade
-- ---------------------------------------------------------------------------------------------
create or replace function private.guard_settlement_account()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_entry payments.account_registry;
  v_class jsonb;
begin
  if tg_op = 'UPDATE' then
    if new.lender_org_id <> old.lender_org_id then
      raise exception 'a settlement account cannot move to another lender' using errcode = 'P0001';
    end if;
    if old.registry_id is not null and new.registry_id is distinct from old.registry_id then
      raise exception 'the registry link of a settlement account is permanent: register a new account instead' using errcode = 'P0001';
    end if;
    if old.registry_id is not null and new.masked_account_ref <> old.masked_account_ref then
      raise exception 'the masked reference of a registered settlement account cannot change' using errcode = 'P0001';
    end if;
    if old.status = 'revoked' and new.status <> 'revoked' then
      raise exception 'a revoked settlement account is final' using errcode = 'P0001';
    end if;
  end if;
  -- `verified` needs the proof, and needs it again whenever the row becomes verified (insert or transition).
  if new.status = 'verified' and (tg_op = 'INSERT' or old.status <> 'verified') then
    if new.registry_id is null then
      raise exception 'a settlement account becomes verified only through a verified registry entry' using errcode = '55000', hint = 'settlement_account_unproven';
    end if;
    select * into v_entry from payments.account_registry r where r.id = new.registry_id;
    if not found then
      raise exception 'registry entry not found' using errcode = '55000', hint = 'settlement_account_unproven';
    end if;
    if v_entry.verification_status <> 'verified' then
      raise exception 'the registry entry is not verified' using errcode = '55000', hint = 'settlement_account_unproven';
    end if;
    v_class := private.classify_registry_entry(v_entry, new.lender_org_id, 'repayment_settlement');
    if v_class ->> 'decision' <> 'permitted' then
      raise exception 'the registry entry does not permit repayment settlement for this lender: %', v_class ->> 'reasons'
        using errcode = '55000', hint = 'settlement_account_unproven';
    end if;
    if v_entry.masked_ref <> new.masked_account_ref then
      raise exception 'the masked reference differs from the registry entry' using errcode = '55000', hint = 'masked_ref_mismatch';
    end if;
  end if;
  return new;
end
$$;
revoke all on function private.guard_settlement_account() from public;
create trigger guard before insert or update on tenancy.lender_settlement_accounts
  for each row execute function private.guard_settlement_account();

-- Revoking or rejecting a registry entry makes every settlement account linked to it unusable at once, and puts every
-- active payment configuration that settles into such an account on hold. (Validation also reads the registry live.)
create or replace function private.cascade_registry_withdrawal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.verification_status in ('revoked', 'rejected') and old.verification_status is distinct from new.verification_status then
    update tenancy.lender_settlement_accounts s set status = 'revoked' where s.registry_id = new.id and s.status <> 'revoked';
    -- payment configurations are defined below; the cascade function body is replaced there to include them.
  end if;
  return new;
end
$$;
revoke all on function private.cascade_registry_withdrawal() from public;
create trigger cascade_withdrawal after update on payments.account_registry
  for each row execute function private.cascade_registry_withdrawal();

-- ---------------------------------------------------------------------------------------------
-- 8. Lender payment configuration (spec 7.1) and its history
-- ---------------------------------------------------------------------------------------------
create table payments.lender_payment_configs (
  id uuid primary key default private.uuid_v7(),
  lender_org_id uuid not null references tenancy.organizations (id) on delete restrict,
  provider text not null references payments.provider_register (provider) on delete restrict,
  provider_mode private.provider_mode not null,
  merchant_registry_id uuid not null,
  settlement_account_id uuid not null,
  -- NAMES of secrets in the secrets manager (same convention as lending.lender_connectors.signing_secret_ref). Never secrets.
  secret_ref text not null check (secret_ref ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  webhook_secret_ref text not null check (webhook_secret_ref ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  -- SHA-256 of the opaque routing token of the callback URL. The token itself is never stored; the lender id never appears in a URL.
  endpoint_token_hash text not null unique check (endpoint_token_hash ~ '^[0-9a-f]{64}$'),
  -- Limits copied from provider documentation: { "<rail>": { "<limit>": string | boolean | integer } } with a source note.
  rail_limits jsonb not null default '{}'::jsonb check (private.rail_limits_ok(rail_limits)),
  rail_limits_source text check (rail_limits_source is null or length(trim(rail_limits_source)) between 10 and 300),
  evidence_ref text check (evidence_ref is null or evidence_ref ~ '^[A-Za-z0-9][A-Za-z0-9 ._:/#,()-]{2,199}$'),
  contract_section_ref text check (contract_section_ref is null or contract_section_ref ~ '^[A-Za-z0-9][A-Za-z0-9 ._:/#,()-]{2,199}$'),
  status text not null default 'draft' check (status in ('draft', 'pending_approval', 'active', 'suspended', 'retired')),
  idempotency_key text not null check (length(idempotency_key) between 16 and 128),
  drafted_by uuid not null references auth.users (id),
  drafted_at timestamptz not null default now(),
  submitted_by uuid references auth.users (id),
  submitted_at timestamptz,
  approved_by uuid references auth.users (id),
  approved_at timestamptz,
  status_changed_by uuid references auth.users (id),
  status_changed_at timestamptz not null default now(),
  status_reason text check (status_reason is null or length(status_reason) <= 1000),
  status_reasons text[],
  last_validated_at timestamptz,
  last_validation_ok boolean,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, lender_org_id),
  unique (drafted_by, idempotency_key),
  foreign key (merchant_registry_id, lender_org_id) references payments.merchant_registry (id, owner_org_id) on delete restrict,
  foreign key (settlement_account_id, lender_org_id) references tenancy.lender_settlement_accounts (id, lender_org_id) on delete restrict,
  constraint secrets_differ check (secret_ref <> webhook_secret_ref),
  constraint rail_limits_need_source check (rail_limits = '{}'::jsonb or rail_limits_source is not null),
  constraint submitted_has_evidence check (status in ('draft', 'retired') or (evidence_ref is not null and contract_section_ref is not null)),
  constraint submitted_has_submitter check (status in ('draft', 'retired') or (submitted_by is not null and submitted_at is not null)),
  constraint active_has_approver check (status <> 'active' or (approved_by is not null and approved_at is not null)),
  constraint maker_checker check (approved_by is null or (approved_by <> drafted_by and approved_by is distinct from submitted_by))
);
create index lender_payment_configs_lender on payments.lender_payment_configs (lender_org_id, status);
create index lender_payment_configs_provider on payments.lender_payment_configs (provider);
create index lender_payment_configs_merchant on payments.lender_payment_configs (merchant_registry_id);
create index lender_payment_configs_settlement on payments.lender_payment_configs (settlement_account_id);
comment on table payments.lender_payment_configs is
  'Per-lender payment configuration (spec 7.1): provider, provider mode (mock only where the session allows it), the lender''s merchant and settlement account (composite keys: they must belong to THIS lender), the NAMES of the provider secret and webhook secret (no secret is ever in a row), the hash of the opaque callback routing token, rail limits with a source note, and evidence and contract references. draft -> pending_approval -> active | suspended | retired. Approval is maker-checker (payment.config.approve, a different person than the drafter and the submitter) and is refused unless payments.validate_collection_target is ok; a platform user with platform.payments.providers.manage may suspend (kill switch). Content never changes after drafting; a change is a new configuration. Written only by the payments.*_payment_config functions. Owner: payments module.';

create trigger unsafe_text before insert or update on payments.lender_payment_configs
  for each row execute function onboarding.reject_unsafe_text('evidence_ref', 'contract_section_ref', 'status_reason', 'rail_limits_source');
create trigger set_updated_at before update on payments.lender_payment_configs
  for each row execute function private.set_updated_at();
create trigger no_delete before delete on payments.lender_payment_configs
  for each row execute function private.forbid_mutation();
create trigger no_truncate before truncate on payments.lender_payment_configs
  for each statement execute function private.forbid_truncate();
-- Mock and sandbox configurations exist only where the session allows it (tests, local development). Insert only: a later
-- suspension must always be possible, whatever the session.
create trigger guard_mode before insert or update of provider_mode on payments.lender_payment_configs
  for each row execute function private.guard_provider_mode('provider_mode');

create table payments.lender_payment_config_events (
  id uuid primary key default private.uuid_v7(),
  config_id uuid not null,
  lender_org_id uuid not null,
  event_kind text not null check (event_kind in ('drafted', 'submitted', 'approved', 'suspended', 'retired')),
  from_status text,
  to_status text not null,
  actor_kind text not null check (actor_kind in ('lender', 'platform', 'system')),
  actor_id uuid references auth.users (id),
  note text,
  reasons text[],
  occurred_at timestamptz not null default clock_timestamp(),
  foreign key (config_id, lender_org_id) references payments.lender_payment_configs (id, lender_org_id) on delete restrict
);
create index lender_payment_config_events_config on payments.lender_payment_config_events (config_id, lender_org_id, occurred_at);
comment on table payments.lender_payment_config_events is
  'Append-only history of every change of a payment configuration: who, when, why and the validation reason codes. No secrets, no personal data. Written only by the trigger private.record_payment_config_event; no role has INSERT, UPDATE or DELETE. Owner: payments module.';
create trigger append_only before update or delete on payments.lender_payment_config_events
  for each row execute function private.forbid_mutation();
create trigger no_truncate before truncate on payments.lender_payment_config_events
  for each statement execute function private.forbid_truncate();

create or replace function private.protect_payment_config()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_moving text[] := array['status', 'submitted_by', 'submitted_at', 'approved_by', 'approved_at', 'status_changed_by', 'status_changed_at',
                           'status_reason', 'status_reasons', 'last_validated_at', 'last_validation_ok', 'updated_at'];
  v_result jsonb;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' or new.approved_by is not null or new.submitted_by is not null then
      raise exception 'a payment configuration starts as a draft' using errcode = '23514';
    end if;
    return new;
  end if;
  if (to_jsonb(new) - v_moving) is distinct from (to_jsonb(old) - v_moving) then
    raise exception 'a payment configuration cannot be edited after drafting: draft a new one' using errcode = 'P0001';
  end if;
  if new.status = old.status then
    return new;
  end if;
  if not (
    (old.status = 'draft' and new.status in ('pending_approval', 'retired'))
    or (old.status = 'pending_approval' and new.status in ('active', 'retired'))
    or (old.status = 'active' and new.status in ('suspended', 'retired'))
    or (old.status = 'suspended' and new.status in ('pending_approval', 'retired'))
  ) then
    raise exception 'payment configuration transition % -> % is not allowed', old.status, new.status using errcode = 'P0001';
  end if;
  -- Activation is refused unless the collection target is valid RIGHT NOW, whoever asks (defence in depth).
  if new.status = 'active' then
    v_result := private.validate_collection_target_impl(new.id);
    if not (v_result ->> 'ok')::boolean then
      raise exception 'collection target invalid: %', v_result -> 'reasons' ->> 0 using errcode = '55000', hint = 'collection_target_invalid';
    end if;
  end if;
  return new;
end
$$;
revoke all on function private.protect_payment_config() from public;
create trigger protect before insert or update on payments.lender_payment_configs
  for each row execute function private.protect_payment_config();

create or replace function private.record_payment_config_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
begin
  if tg_op = 'INSERT' then
    insert into payments.lender_payment_config_events (config_id, lender_org_id, event_kind, from_status, to_status, actor_kind, actor_id)
    values (new.id, new.lender_org_id, 'drafted', null, new.status, case private.current_actor() when 'platform' then 'platform' when 'system' then 'system' else 'lender' end, new.drafted_by);
    return new;
  end if;
  if new.status is distinct from old.status then
    v_actor := new.status_changed_by;
    insert into payments.lender_payment_config_events (config_id, lender_org_id, event_kind, from_status, to_status, actor_kind, actor_id, note, reasons)
    values (new.id, new.lender_org_id,
            case new.status when 'pending_approval' then 'submitted' when 'active' then 'approved' when 'suspended' then 'suspended' else 'retired' end,
            old.status, new.status,
            case when v_actor is null then 'system' when private.current_actor() = 'platform' then 'platform' else 'lender' end,
            v_actor, new.status_reason, new.status_reasons);
  end if;
  return new;
end
$$;
revoke all on function private.record_payment_config_event() from public;
create trigger record_event after insert or update on payments.lender_payment_configs
  for each row execute function private.record_payment_config_event();

-- ---------------------------------------------------------------------------------------------
-- 9. validate_collection_target (spec 7.1 steps 1 to 4). Pure read; the same logic backs approval, every intent and the nightly run.
-- ---------------------------------------------------------------------------------------------
create or replace function private.validate_collection_target_impl(p_config uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_cfg payments.lender_payment_configs;
  v_org tenancy.organizations;
  v_sa tenancy.lender_settlement_accounts;
  v_reg payments.account_registry;
  v_mer payments.merchant_registry;
  v_prov payments.provider_register;
  v_class jsonb;
  v_reasons text[] := '{}';
  v_r text;
begin
  select * into v_cfg from payments.lender_payment_configs c where c.id = p_config;
  if not found then
    return jsonb_build_object('ok', false, 'reasons', jsonb_build_array('config_not_found'));
  end if;

  -- 1. The organisation is a lender, active, with its onboarding gate met.
  select * into v_org from tenancy.organizations o where o.id = v_cfg.lender_org_id;
  if v_org.kind is distinct from 'lender' then
    v_reasons := v_reasons || 'organisation_not_lender'::text;
  end if;
  if v_org.status is distinct from 'active' then
    v_reasons := v_reasons || 'lender_organisation_not_active'::text;
  end if;
  if not exists (select 1 from onboarding.lender_gates g where g.lender_org_id = v_cfg.lender_org_id and g.stage = 'activated') then
    v_reasons := v_reasons || 'onboarding_gate_not_activated'::text;
  end if;

  -- 2. The settlement account is the lender's own, verified, and the registry (read live) says it is theirs.
  select * into v_sa from tenancy.lender_settlement_accounts s where s.id = v_cfg.settlement_account_id and s.lender_org_id = v_cfg.lender_org_id;
  if not found then
    v_reasons := v_reasons || 'settlement_account_not_found'::text;
  else
    if v_sa.status <> 'verified' then
      v_reasons := v_reasons || 'settlement_account_not_verified'::text;
    end if;
    select * into v_reg from payments.account_registry r where r.id = v_sa.registry_id;
    if not found then
      v_reasons := v_reasons || 'settlement_account_unregistered'::text;
    else
      v_class := private.classify_registry_entry(v_reg, v_cfg.lender_org_id, 'repayment_settlement');
      for v_r in select jsonb_array_elements_text(v_class -> 'reasons') loop
        v_reasons := v_reasons || ('destination_' || v_r);
      end loop;
      if v_reg.masked_ref <> v_sa.masked_account_ref then
        v_reasons := v_reasons || 'settlement_masked_ref_mismatch'::text;
      end if;
    end if;
  end if;

  -- 3. The merchant is this lender's own repayment merchant at this provider, and still active.
  select * into v_mer from payments.merchant_registry m where m.id = v_cfg.merchant_registry_id;
  if not found then
    v_reasons := v_reasons || 'merchant_not_found'::text;
  else
    if v_mer.status <> 'active' then
      v_reasons := v_reasons || 'merchant_not_active'::text;
    end if;
    if v_mer.owner_kind <> 'lender' or v_mer.purpose <> 'repayment' then
      v_reasons := v_reasons || 'merchant_not_repayment'::text;
    end if;
    if v_mer.owner_org_id is distinct from v_cfg.lender_org_id then
      v_reasons := v_reasons || 'merchant_owner_mismatch'::text;
    end if;
    if v_mer.provider <> v_cfg.provider then
      v_reasons := v_reasons || 'merchant_provider_mismatch'::text;
    end if;
  end if;

  -- 4. The provider is on the platform register (with authorisation evidence for production) and the mode is allowed here.
  select * into v_prov from payments.provider_register p where p.provider = v_cfg.provider;
  if not found then
    v_reasons := v_reasons || 'provider_not_registered'::text;
  else
    if v_prov.status <> 'approved' then
      v_reasons := v_reasons || 'provider_not_approved'::text;
    end if;
    if private.provider_mode_satisfies_production_gate(v_cfg.provider_mode) and v_prov.authorisation_evidence_ref is null then
      v_reasons := v_reasons || 'provider_evidence_missing'::text;
    end if;
  end if;
  if v_cfg.provider_mode = 'mock' and not private.mock_providers_allowed() then
    v_reasons := v_reasons || 'provider_mode_mock_blocked'::text;
  elsif v_cfg.provider_mode = 'sandbox' and not private.sandbox_providers_allowed() then
    v_reasons := v_reasons || 'provider_mode_sandbox_blocked'::text;
  end if;

  -- Evidence the approval rests on.
  if v_cfg.evidence_ref is null then
    v_reasons := v_reasons || 'config_evidence_missing'::text;
  end if;
  if v_cfg.contract_section_ref is null then
    v_reasons := v_reasons || 'contract_section_missing'::text;
  end if;

  return jsonb_build_object('ok', cardinality(v_reasons) = 0, 'reasons', to_jsonb(v_reasons));
end
$$;
revoke all on function private.validate_collection_target_impl(uuid) from public;

create or replace function payments.validate_collection_target(p_config uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if private.invoking_role() <> 'service_role' then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  return private.validate_collection_target_impl(p_config);
end
$$;
comment on function payments.validate_collection_target(uuid) is
  'System only. {ok boolean, reasons text[]} (reasons in check order). Spec 7.1: (1) organisation is an active lender with the onboarding gate activated; (2) the settlement account is this lender''s, verified, linked to a registry entry that classify_destination permits for repayment_settlement for THIS lender (read live: a revoked entry, an unverified one, an account owned by Udofin, a group company or anyone else, a different owner, an expired entry all fail), masked reference equal; (3) the merchant is this lender''s own active repayment merchant at this provider (Udofin''s fee merchant, another organisation''s merchant, a revoked claim fail); (4) the provider is registered and approved, production mode needs authorisation evidence, mock or sandbox mode only where the session allows it; evidence and contract references present. Run on approval, on every payment intent and nightly. Any non-ok result blocks (and the nightly run suspends). Step 5 of the spec (provider response bound back to the configuration) is runtime: payments.system_suspend_payment_config.';
revoke all on function payments.validate_collection_target(uuid) from public;
grant execute on function payments.validate_collection_target(uuid) to service_role;

-- The cascade function now also puts configurations on hold (replaces the body defined in section 7).
create or replace function private.cascade_registry_withdrawal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.verification_status in ('revoked', 'rejected') and old.verification_status is distinct from new.verification_status then
    update tenancy.lender_settlement_accounts s set status = 'revoked' where s.registry_id = new.id and s.status <> 'revoked';
    update payments.lender_payment_configs c
    set status = 'suspended', status_changed_by = (select auth.uid()), status_changed_at = now(),
        status_reason = 'registry entry ' || new.verification_status, status_reasons = array['destination_account_' || new.verification_status]
    where c.status = 'active'
      and c.settlement_account_id in (select s.id from tenancy.lender_settlement_accounts s where s.registry_id = new.id);
  end if;
  return new;
end
$$;
revoke all on function private.cascade_registry_withdrawal() from public;

-- A revoked merchant puts the configurations that use it on hold, the same way.
create or replace function private.cascade_merchant_revocation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'revoked' and old.status <> 'revoked' then
    update payments.lender_payment_configs c
    set status = 'suspended', status_changed_by = (select auth.uid()), status_changed_at = now(),
        status_reason = 'merchant revoked', status_reasons = array['merchant_not_active']
    where c.status = 'active' and c.merchant_registry_id = new.id;
  end if;
  return new;
end
$$;
revoke all on function private.cascade_merchant_revocation() from public;
create trigger cascade_revocation after update on payments.merchant_registry
  for each row execute function private.cascade_merchant_revocation();

-- ---------------------------------------------------------------------------------------------
-- 10. Row level security and grants
-- ---------------------------------------------------------------------------------------------
alter table payments.account_format_rules enable row level security;
alter table payments.account_format_rules force row level security;
alter table payments.account_format_rule_events enable row level security;
alter table payments.account_format_rule_events force row level security;
alter table payments.provider_register enable row level security;
alter table payments.provider_register force row level security;
alter table payments.account_registry enable row level security;
alter table payments.account_registry force row level security;
alter table payments.account_registry_events enable row level security;
alter table payments.account_registry_events force row level security;
alter table payments.merchant_registry enable row level security;
alter table payments.merchant_registry force row level security;
alter table payments.lender_payment_configs enable row level security;
alter table payments.lender_payment_configs force row level security;
alter table payments.lender_payment_config_events enable row level security;
alter table payments.lender_payment_config_events force row level security;

-- Registry, rules and their histories: platform users holding the registry permissions only. Never lenders, never borrowers.
create policy account_format_rules_read on payments.account_format_rules for select to authenticated
  using ((select private.has_platform_permission('platform.accounts.registry.manage'))
         or (select private.has_platform_permission('platform.accounts.registry.verify')));
create policy account_format_rule_events_read on payments.account_format_rule_events for select to authenticated
  using ((select private.has_platform_permission('platform.accounts.registry.manage'))
         or (select private.has_platform_permission('platform.accounts.registry.verify')));
create policy account_registry_read on payments.account_registry for select to authenticated
  using ((select private.has_platform_permission('platform.accounts.registry.manage'))
         or (select private.has_platform_permission('platform.accounts.registry.verify')));
create policy account_registry_events_read on payments.account_registry_events for select to authenticated
  using ((select private.has_platform_permission('platform.accounts.registry.manage'))
         or (select private.has_platform_permission('platform.accounts.registry.verify')));

-- Provider register: any staff member (the vocabulary is not sensitive); borrowers and users without an organisation see nothing.
create policy provider_register_read on payments.provider_register for select to authenticated
  using (exists (select 1 from private.my_org_ids()));

-- Merchants and configurations: a lender sees only its own (payment.configure, payment.config.approve or payment.read);
-- the platform sees all through platform.payments.providers.manage or an operations role holding payment.read.
create policy merchant_registry_read on payments.merchant_registry for select to authenticated
  using (owner_org_id in (select private.orgs_with_permission('payment.configure'))
         or owner_org_id in (select private.orgs_with_permission('payment.config.approve'))
         or owner_org_id in (select private.orgs_with_permission('payment.read'))
         or (select private.has_platform_permission('platform.payments.providers.manage')));
create policy lender_payment_configs_read on payments.lender_payment_configs for select to authenticated
  using (lender_org_id in (select private.orgs_with_permission('payment.configure'))
         or lender_org_id in (select private.orgs_with_permission('payment.config.approve'))
         or lender_org_id in (select private.orgs_with_permission('payment.read'))
         or (select private.has_platform_permission('platform.payments.providers.manage')));
create policy lender_payment_config_events_read on payments.lender_payment_config_events for select to authenticated
  using (lender_org_id in (select private.orgs_with_permission('payment.configure'))
         or lender_org_id in (select private.orgs_with_permission('payment.config.approve'))
         or lender_org_id in (select private.orgs_with_permission('payment.read'))
         or (select private.has_platform_permission('platform.payments.providers.manage')));

-- Settlement accounts: platform users who run the registry must be able to find the account they are asked to link (masked
-- reference, label and bank name only: the row holds no account number). Lenders keep their own policy (payment.read).
create policy settlement_accounts_registry_read on tenancy.lender_settlement_accounts for select to authenticated
  using ((select private.has_platform_permission('platform.accounts.registry.manage'))
         or (select private.has_platform_permission('platform.accounts.registry.verify')));

-- service_role gets only what system code needs. The default privilege gives it ALL on new domain tables: revoke it.
revoke all on payments.account_format_rules, payments.account_format_rule_events, payments.account_registry,
  payments.account_registry_events, payments.provider_register, payments.merchant_registry, payments.lender_payment_configs,
  payments.lender_payment_config_events from service_role;
-- The system reads the provider vocabulary, the merchant a configuration points at and the configuration itself (to call the
-- provider and route callbacks). It can read nothing of the registry or the rules (the validation functions do), and it can
-- write none of these tables: state changes go through the definer functions below.
grant select on payments.provider_register, payments.merchant_registry, payments.lender_payment_configs to service_role;
grant select on payments.account_format_rules, payments.account_format_rule_events, payments.account_registry,
  payments.account_registry_events, payments.provider_register, payments.merchant_registry, payments.lender_payment_configs,
  payments.lender_payment_config_events to authenticated;

-- Settlement accounts: the system may create unverified rows (as before) but can no longer edit or delete them; the proof
-- of ownership arrives only through payments.link_settlement_account and the revocation cascade.
revoke update, delete on tenancy.lender_settlement_accounts from service_role;

-- ---------------------------------------------------------------------------------------------
-- 11. Registry workflow: platform-only, aal2, audited, idempotent, two different people
-- ---------------------------------------------------------------------------------------------
create or replace function payments.draft_account_format_rule(
  p_country text, p_account_type text, p_min_digits integer, p_max_digits integer, p_ifsc_required boolean,
  p_evidence_label text, p_source_note text, p_effective_from date default null, p_effective_to date default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.accounts_require_platform(array['platform.accounts.registry.manage']);
  v_from date := coalesce(p_effective_from, private.today_ist());
  v_version integer;
  v_id uuid;
begin
  if p_country is null or p_country !~ '^[A-Z]{2}$' or p_account_type is null or p_account_type !~ '^[a-z][a-z0-9_]{2,40}$'
     or p_min_digits is null or p_max_digits is null or p_min_digits not between 1 and 40 or p_max_digits not between p_min_digits and 40
     or p_ifsc_required is null or p_evidence_label is null or p_evidence_label not in ('unverified', 'likely', 'confirmed') then
    raise exception 'invalid account format rule' using errcode = '22023', hint = 'rule_invalid';
  end if;
  if p_source_note is null or length(trim(p_source_note)) not between 10 and 500 then
    raise exception 'a source note of 10 to 500 characters is required' using errcode = '22023', hint = 'source_note_required';
  end if;
  if p_effective_to is not null and p_effective_to <= v_from then
    raise exception 'effective_to must be after effective_from' using errcode = '22023', hint = 'dates_invalid';
  end if;
  select coalesce(max(r.version), 0) + 1 into v_version from payments.account_format_rules r where r.country = p_country and r.account_type = p_account_type;
  insert into payments.account_format_rules (country, account_type, version, min_digits, max_digits, ifsc_required, evidence_label, source_note,
                                             effective_from, effective_to, drafted_by, submitted_by, submitted_at)
  values (p_country, p_account_type, v_version, p_min_digits, p_max_digits, p_ifsc_required, p_evidence_label, trim(p_source_note),
          v_from, p_effective_to, v_uid, v_uid, now())
  returning id into v_id;
  perform private.write_payments_audit(null, 'payments.account_format_rule.drafted', 'account_format_rule', v_id::text,
    jsonb_build_object('country', p_country, 'account_type', p_account_type, 'version', v_version, 'evidence_label', p_evidence_label));
  return v_id;
end
$$;

-- For a draft that has no proposer (the rule seeded by the migration): a registry manager takes responsibility for proposing it.
create or replace function payments.submit_account_format_rule(p_rule uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.accounts_require_platform(array['platform.accounts.registry.manage']);
  v_rule payments.account_format_rules;
begin
  select * into v_rule from payments.account_format_rules r where r.id = p_rule for update;
  if not found then
    raise exception 'account format rule not found' using errcode = 'P0002';
  end if;
  if v_rule.status <> 'draft' then
    raise exception 'rule is %, not a draft', v_rule.status using errcode = '55000', hint = 'rule_not_draft';
  end if;
  if v_rule.submitted_by is not null then
    if v_rule.submitted_by = v_uid then
      return 'draft';
    end if;
    raise exception 'the rule already has a proposer' using errcode = '55000', hint = 'already_submitted';
  end if;
  update payments.account_format_rules set submitted_by = v_uid, submitted_at = now() where id = p_rule;
  perform private.write_payments_audit(null, 'payments.account_format_rule.submitted', 'account_format_rule', p_rule::text,
    jsonb_build_object('country', v_rule.country, 'account_type', v_rule.account_type, 'version', v_rule.version));
  return 'draft';
end
$$;

create or replace function payments.approve_account_format_rule(p_rule uuid, p_note text default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.accounts_require_platform(array['platform.accounts.registry.verify']);
  v_rule payments.account_format_rules;
begin
  select * into v_rule from payments.account_format_rules r where r.id = p_rule for update;
  if not found then
    raise exception 'account format rule not found' using errcode = 'P0002';
  end if;
  if v_rule.status = 'approved' and v_rule.approved_by = v_uid then
    return 'approved';
  end if;
  if v_rule.status <> 'draft' then
    raise exception 'rule is %, not a draft', v_rule.status using errcode = '55000', hint = 'rule_not_draft';
  end if;
  if v_rule.submitted_by is null then
    raise exception 'the rule has not been proposed by a registry manager yet' using errcode = '55000', hint = 'not_submitted';
  end if;
  if v_rule.submitted_by = v_uid or v_rule.drafted_by = v_uid then
    raise exception 'a rule cannot be approved by the person who drafted or proposed it' using errcode = '42501', hint = 'self_approval';
  end if;
  if not private.user_holds_platform_permission(v_rule.submitted_by, 'platform.accounts.registry.manage') then
    raise exception 'the proposer no longer holds the permission needed for this change' using errcode = '42501', hint = 'requester_not_entitled';
  end if;
  if p_note is not null and length(p_note) > 1000 then
    raise exception 'a note must be at most 1000 characters' using errcode = '22023', hint = 'reason_invalid';
  end if;
  -- The previously approved version of the same rule family is retired in the same transaction.
  update payments.account_format_rules
  set status = 'retired', retired_by = v_uid, retired_at = now(), retired_reason = 'superseded by version ' || v_rule.version
  where country = v_rule.country and account_type = v_rule.account_type and status = 'approved';
  update payments.account_format_rules
  set status = 'approved', approved_by = v_uid, approved_at = now(), approval_note = p_note
  where id = p_rule;
  perform private.write_payments_audit(null, 'payments.account_format_rule.approved', 'account_format_rule', p_rule::text,
    jsonb_build_object('country', v_rule.country, 'account_type', v_rule.account_type, 'version', v_rule.version,
                       'evidence_label', v_rule.evidence_label, 'proposed_by', v_rule.submitted_by));
  return 'approved';
end
$$;

-- Retiring is fail closed (either permission): no new account can be registered under a retired rule.
create or replace function payments.retire_account_format_rule(p_rule uuid, p_reason text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.accounts_require_platform(array['platform.accounts.registry.manage', 'platform.accounts.registry.verify']);
  v_rule payments.account_format_rules;
begin
  if p_reason is null or length(trim(p_reason)) < 10 then
    raise exception 'a reason of at least 10 characters is required' using errcode = '22023', hint = 'reason_required';
  end if;
  if length(trim(p_reason)) > 1000 then
    raise exception 'a reason must be 10 to 1000 characters' using errcode = '22023', hint = 'reason_invalid';
  end if;
  select * into v_rule from payments.account_format_rules r where r.id = p_rule for update;
  if not found then
    raise exception 'account format rule not found' using errcode = 'P0002';
  end if;
  if v_rule.status = 'retired' then
    return 'retired';
  end if;
  update payments.account_format_rules set status = 'retired', retired_by = v_uid, retired_at = now(), retired_reason = trim(p_reason) where id = p_rule;
  perform private.write_payments_audit(null, 'payments.account_format_rule.retired', 'account_format_rule', p_rule::text,
    jsonb_build_object('country', v_rule.country, 'account_type', v_rule.account_type, 'version', v_rule.version));
  return 'retired';
end
$$;

create or replace function payments.register_account(
  p_fingerprint text, p_key_version integer, p_masked_ref text, p_country text, p_account_type text, p_format_rule_id uuid,
  p_format_validated boolean, p_owner_kind text, p_owner_org_id uuid, p_legal_owner_name text, p_permitted_purposes text[],
  p_effective_from date, p_effective_to date, p_idempotency_key text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.accounts_require_platform(array['platform.accounts.registry.manage']);
  v_from date := coalesce(p_effective_from, private.today_ist());
  v_existing payments.account_registry;
  v_rule payments.account_format_rules;
  v_id uuid;
  v_constraint text;
begin
  if p_idempotency_key is null or length(p_idempotency_key) not between 16 and 128 then
    raise exception 'a 16 to 128 character idempotency key is required' using errcode = '22023', hint = 'bad_request';
  end if;
  if p_fingerprint is null or p_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'the fingerprint must be 64 lowercase hex characters' using errcode = '22023', hint = 'fingerprint_invalid';
  end if;
  if p_key_version is null or p_key_version < 1 then
    raise exception 'the key version must be 1 or more' using errcode = '22023', hint = 'key_version_invalid';
  end if;
  if p_masked_ref is null or p_masked_ref !~ '^[X*]{2,}[0-9]{4}$' then
    raise exception 'the masked reference must show the last four digits only' using errcode = '22023', hint = 'masked_ref_invalid';
  end if;
  if p_owner_kind is null or p_owner_kind not in ('lender', 'udofin', 'group_company', 'other') then
    raise exception 'unknown owner kind' using errcode = '22023', hint = 'owner_invalid';
  end if;
  if (p_owner_kind = 'lender') <> (p_owner_org_id is not null) then
    raise exception 'a lender-owned account needs the lender organisation; other owners must not name one' using errcode = '22023', hint = 'owner_invalid';
  end if;
  if p_owner_kind = 'lender' and not exists (select 1 from tenancy.organizations o where o.id = p_owner_org_id and o.kind = 'lender') then
    raise exception 'the owner organisation is not a lender' using errcode = '22023', hint = 'owner_invalid';
  end if;
  if p_legal_owner_name is null or length(trim(p_legal_owner_name)) not between 3 and 200 then
    raise exception 'the legal owner name (a legal entity, never an individual) must be 3 to 200 characters' using errcode = '22023', hint = 'legal_owner_name_invalid';
  end if;
  if not private.account_purposes_ok(p_permitted_purposes)
     or (p_owner_kind <> 'lender' and 'repayment_settlement' = any (p_permitted_purposes)) then
    raise exception 'invalid permitted purposes (only a lender-owned account can be permitted for repayment settlement)' using errcode = '22023', hint = 'purposes_invalid';
  end if;
  if p_effective_to is not null and p_effective_to <= v_from then
    raise exception 'effective_to must be after effective_from' using errcode = '22023', hint = 'dates_invalid';
  end if;

  select * into v_existing from payments.account_registry r where r.registered_by = v_uid and r.idempotency_key = p_idempotency_key;
  if found then
    if (v_existing.fingerprint, v_existing.key_version, v_existing.owner_kind, v_existing.owner_org_id, v_existing.permitted_purposes, v_existing.format_rule_id)
       is distinct from (p_fingerprint, p_key_version, p_owner_kind, p_owner_org_id, p_permitted_purposes, p_format_rule_id) then
      raise exception 'idempotency key was already used for a different registration' using errcode = '23505', hint = 'idempotency_conflict';
    end if;
    return v_existing.id;
  end if;

  -- The number was validated against an APPROVED, effective rule before it was fingerprinted: the API attests that, the
  -- database cannot check digits it never sees. Fail closed: no rule, a rule that is not approved or not effective, a rule
  -- for another country or account type, or no attestation: refused.
  select * into v_rule from payments.account_format_rules r where r.id = p_format_rule_id;
  if p_format_rule_id is null or not found or p_format_validated is distinct from true
     or v_rule.status <> 'approved' or v_rule.country <> p_country or v_rule.account_type <> p_account_type
     or private.today_ist() < v_rule.effective_from
     or (v_rule.effective_to is not null and private.today_ist() >= v_rule.effective_to) then
    raise exception 'the account format was not validated against an approved rule' using errcode = '55000', hint = 'account_format_unvalidated';
  end if;

  begin
    insert into payments.account_registry (fingerprint, key_version, masked_ref, country, account_type, format_rule_id, format_validated,
                                           owner_kind, owner_org_id, legal_owner_name, permitted_purposes, effective_from, effective_to,
                                           registered_by, idempotency_key)
    values (p_fingerprint, p_key_version, p_masked_ref, p_country, p_account_type, p_format_rule_id, true,
            p_owner_kind, p_owner_org_id, trim(p_legal_owner_name), p_permitted_purposes, v_from, p_effective_to, v_uid, p_idempotency_key)
    returning id into v_id;
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint = 'account_registry_fingerprint_key_version_key' then
      raise exception 'this account is already registered' using errcode = '23505', hint = 'account_already_registered';
    end if;
    raise exception 'idempotency key was already used for a different registration' using errcode = '23505', hint = 'idempotency_conflict';
  end;
  perform private.write_payments_audit(p_owner_org_id, 'payments.account_registry.registered', 'account_registry', v_id::text,
    jsonb_build_object('owner_kind', p_owner_kind, 'key_version', p_key_version, 'purposes', to_jsonb(p_permitted_purposes), 'format_rule_id', p_format_rule_id));
  return v_id;
end
$$;

create or replace function payments.verify_account(p_registry uuid, p_evidence_ref text, p_note text default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.accounts_require_platform(array['platform.accounts.registry.verify']);
  v_entry payments.account_registry;
begin
  select * into v_entry from payments.account_registry r where r.id = p_registry for update;
  if not found then
    raise exception 'registry entry not found' using errcode = 'P0002';
  end if;
  if v_entry.verification_status = 'verified' and v_entry.verified_by = v_uid and v_entry.evidence_ref is not distinct from p_evidence_ref then
    return 'verified';
  end if;
  if v_entry.verification_status <> 'unverified' then
    raise exception 'registry entry is %, not unverified', v_entry.verification_status using errcode = '55000', hint = 'not_unverified';
  end if;
  if v_entry.registered_by = v_uid then
    raise exception 'an account cannot be verified by the person who registered it' using errcode = '42501', hint = 'self_approval';
  end if;
  if p_evidence_ref is null or p_evidence_ref !~ '^[A-Za-z0-9][A-Za-z0-9 ._:/#,()-]{2,199}$' then
    raise exception 'an evidence reference label is required (no file contents, no account details)' using errcode = '22023', hint = 'evidence_invalid';
  end if;
  if p_note is not null and length(p_note) > 1000 then
    raise exception 'a note must be at most 1000 characters' using errcode = '22023', hint = 'reason_invalid';
  end if;
  if not private.user_holds_platform_permission(v_entry.registered_by, 'platform.accounts.registry.manage') then
    raise exception 'the registrant no longer holds the permission needed for this registration' using errcode = '42501', hint = 'requester_not_entitled';
  end if;
  if v_entry.effective_to is not null and private.today_ist() >= v_entry.effective_to then
    raise exception 'the registration is no longer effective' using errcode = '55000', hint = 'not_effective';
  end if;
  update payments.account_registry
  set verification_status = 'verified', verified_by = v_uid, verified_at = now(), evidence_ref = p_evidence_ref, verification_note = p_note
  where id = p_registry;
  perform private.write_payments_audit(v_entry.owner_org_id, 'payments.account_registry.verified', 'account_registry', p_registry::text,
    jsonb_build_object('owner_kind', v_entry.owner_kind, 'registered_by', v_entry.registered_by));
  return 'verified';
end
$$;

-- Rejecting and revoking are fail closed: either registry permission, one person, a reason, recorded.
create or replace function payments.reject_account(p_registry uuid, p_reason text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.accounts_require_platform(array['platform.accounts.registry.manage', 'platform.accounts.registry.verify']);
  v_entry payments.account_registry;
begin
  if p_reason is null or length(trim(p_reason)) < 10 then
    raise exception 'a reason of at least 10 characters is required' using errcode = '22023', hint = 'reason_required';
  end if;
  if length(trim(p_reason)) > 1000 then
    raise exception 'a reason must be 10 to 1000 characters' using errcode = '22023', hint = 'reason_invalid';
  end if;
  select * into v_entry from payments.account_registry r where r.id = p_registry for update;
  if not found then
    raise exception 'registry entry not found' using errcode = 'P0002';
  end if;
  if v_entry.verification_status = 'rejected' then
    return 'rejected';
  end if;
  if v_entry.verification_status <> 'unverified' then
    raise exception 'registry entry is %, not unverified', v_entry.verification_status using errcode = '55000', hint = 'not_unverified';
  end if;
  update payments.account_registry
  set verification_status = 'rejected', rejected_by = v_uid, rejected_at = now(), rejection_reason = trim(p_reason)
  where id = p_registry;
  perform private.write_payments_audit(v_entry.owner_org_id, 'payments.account_registry.rejected', 'account_registry', p_registry::text,
    jsonb_build_object('owner_kind', v_entry.owner_kind));
  return 'rejected';
end
$$;

create or replace function payments.revoke_account(p_registry uuid, p_reason text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.accounts_require_platform(array['platform.accounts.registry.manage', 'platform.accounts.registry.verify']);
  v_entry payments.account_registry;
begin
  if p_reason is null or length(trim(p_reason)) < 10 then
    raise exception 'a reason of at least 10 characters is required' using errcode = '22023', hint = 'reason_required';
  end if;
  if length(trim(p_reason)) > 1000 then
    raise exception 'a reason must be 10 to 1000 characters' using errcode = '22023', hint = 'reason_invalid';
  end if;
  select * into v_entry from payments.account_registry r where r.id = p_registry for update;
  if not found then
    raise exception 'registry entry not found' using errcode = 'P0002';
  end if;
  if v_entry.verification_status = 'revoked' then
    return 'revoked';
  end if;
  if v_entry.verification_status not in ('unverified', 'verified') then
    raise exception 'registry entry is %, it cannot be revoked', v_entry.verification_status using errcode = '55000', hint = 'not_revocable';
  end if;
  update payments.account_registry
  set verification_status = 'revoked', revoked_by = v_uid, revoked_at = now(), revoked_reason = trim(p_reason)
  where id = p_registry;
  perform private.write_payments_audit(v_entry.owner_org_id, 'payments.account_registry.revoked', 'account_registry', p_registry::text,
    jsonb_build_object('owner_kind', v_entry.owner_kind, 'was', v_entry.verification_status));
  return 'revoked';
end
$$;

-- The one path by which a settlement account becomes verified: a registry manager links it to a VERIFIED registry entry owned by
-- the same lender, permitted for repayment settlement, effective now, with the same masked reference. The table trigger
-- enforces the same proof for every other writer.
create or replace function payments.link_settlement_account(p_account uuid, p_registry uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.accounts_require_platform(array['platform.accounts.registry.manage']);
  v_sa tenancy.lender_settlement_accounts;
  v_entry payments.account_registry;
  v_class jsonb;
begin
  select * into v_sa from tenancy.lender_settlement_accounts s where s.id = p_account for update;
  if not found then
    raise exception 'settlement account not found' using errcode = 'P0002';
  end if;
  select * into v_entry from payments.account_registry r where r.id = p_registry for share;
  if not found then
    raise exception 'registry entry not found' using errcode = 'P0002';
  end if;
  if v_sa.registry_id = p_registry and v_sa.status = 'verified' then
    return 'verified';
  end if;
  if v_sa.registry_id is not null then
    raise exception 'the settlement account is already linked to a registry entry' using errcode = '55000', hint = 'already_linked';
  end if;
  if v_sa.status = 'revoked' then
    raise exception 'a revoked settlement account cannot be linked' using errcode = '55000', hint = 'settlement_account_revoked';
  end if;
  if v_entry.verification_status <> 'verified' then
    raise exception 'the registry entry is not verified' using errcode = '55000', hint = 'registry_not_permitted';
  end if;
  v_class := private.classify_registry_entry(v_entry, v_sa.lender_org_id, 'repayment_settlement');
  if v_class ->> 'decision' <> 'permitted' then
    raise exception 'the registry entry does not permit repayment settlement for this lender: %', v_class ->> 'reasons'
      using errcode = '55000', hint = 'registry_not_permitted';
  end if;
  if v_entry.masked_ref <> v_sa.masked_account_ref then
    raise exception 'the masked reference differs from the registry entry' using errcode = '55000', hint = 'masked_ref_mismatch';
  end if;
  update tenancy.lender_settlement_accounts
  set registry_id = p_registry, status = 'verified', verified_by = v_uid, verified_at = now()
  where id = p_account;
  perform private.write_payments_audit(v_sa.lender_org_id, 'payments.settlement_account.linked', 'settlement_account', p_account::text,
    jsonb_build_object('registry_id', p_registry));
  return 'verified';
end
$$;

-- Lenders may read the masked reference, the verification status and the effective dates of the registry entry linked to THEIR
-- settlement accounts, and whether the account is usable right now: never the fingerprint, owner details or reasons.
create or replace function payments.my_settlement_account_registry_status()
returns table (settlement_account_id uuid, lender_org_id uuid, masked_ref text, verification_status text, effective_from date, effective_to date, usable boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select s.id, s.lender_org_id, r.masked_ref, r.verification_status, r.effective_from, r.effective_to,
         (s.status = 'verified' and r.verification_status = 'verified'
          and private.classify_registry_entry(r, s.lender_org_id, 'repayment_settlement') ->> 'decision' = 'permitted'
          and r.masked_ref = s.masked_account_ref)
  from tenancy.lender_settlement_accounts s
  join payments.account_registry r on r.id = s.registry_id and r.owner_org_id = s.lender_org_id
  where s.lender_org_id in (select private.orgs_with_permission('payment.read'))
$$;
comment on function payments.my_settlement_account_registry_status() is
  'Column-restricted lender view of the registry: masked reference, verification status, effective dates and whether the settlement account is usable now, for the caller''s own settlement accounts only (payment.read). Never the fingerprint, the owner details or the reasons.';

-- ---------------------------------------------------------------------------------------------
-- 12. Provider register and merchant functions
-- ---------------------------------------------------------------------------------------------
create or replace function payments.set_payment_provider(
  p_provider text, p_display_name text, p_kind text, p_status text, p_authorisation_evidence_ref text, p_evidence_label text, p_reason text default null
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.accounts_require_platform(array['platform.payments.providers.manage']);
  v_old payments.provider_register;
  v_new_status text;
begin
  if p_provider is null or p_provider !~ '^[a-z][a-z0-9_]{2,49}$' or p_kind is null or p_kind not in ('payment', 'mandate', 'payment_and_mandate')
     or p_status is null or p_status not in ('draft', 'approved', 'suspended') or p_evidence_label is null
     or p_evidence_label not in ('unverified', 'likely', 'confirmed')
     or p_display_name is null or length(trim(p_display_name)) not between 2 and 120 then
    raise exception 'invalid provider register entry' using errcode = '22023', hint = 'provider_invalid';
  end if;
  if p_authorisation_evidence_ref is not null and p_authorisation_evidence_ref !~ '^[A-Za-z0-9][A-Za-z0-9 ._:/#,()-]{2,199}$' then
    raise exception 'the evidence reference must be a label' using errcode = '22023', hint = 'evidence_invalid';
  end if;
  if p_status = 'suspended' and (p_reason is null or length(trim(p_reason)) < 10) then
    raise exception 'a reason of at least 10 characters is required to suspend a provider' using errcode = '22023', hint = 'reason_required';
  end if;
  if p_reason is not null and length(trim(p_reason)) > 1000 then
    raise exception 'a reason must be 10 to 1000 characters' using errcode = '22023', hint = 'reason_invalid';
  end if;
  select * into v_old from payments.provider_register r where r.provider = p_provider for update;
  if found then
    update payments.provider_register
    set display_name = trim(p_display_name), kind = p_kind, status = p_status, authorisation_evidence_ref = p_authorisation_evidence_ref,
        evidence_label = p_evidence_label, status_reason = p_reason, updated_by = v_uid
    where provider = p_provider;
  else
    insert into payments.provider_register (provider, display_name, kind, status, authorisation_evidence_ref, evidence_label, status_reason, updated_by)
    values (p_provider, trim(p_display_name), p_kind, p_status, p_authorisation_evidence_ref, p_evidence_label, p_reason, v_uid);
  end if;
  perform private.write_payments_audit(null, 'payments.provider.set', 'payment_provider', p_provider,
    jsonb_build_object('status', p_status, 'kind', p_kind, 'evidence_label', p_evidence_label, 'has_evidence', p_authorisation_evidence_ref is not null,
                       'previous_status', v_old.status));
  return p_status;
end
$$;

-- A lender claims its own merchant id at a registered provider. A second claim of the same id by anyone else is refused.
create or replace function payments.claim_merchant(p_lender uuid, p_provider text, p_merchant_ref text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.payments_require_lender(p_lender, 'payment.configure');
  v_existing payments.merchant_registry;
  v_id uuid;
begin
  if p_provider is null or not exists (select 1 from payments.provider_register r where r.provider = p_provider) then
    raise exception 'unknown provider' using errcode = '22023', hint = 'provider_invalid';
  end if;
  if p_merchant_ref is null or p_merchant_ref !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{2,99}$' then
    raise exception 'invalid merchant reference' using errcode = '22023', hint = 'merchant_ref_invalid';
  end if;
  select * into v_existing from payments.merchant_registry m where m.provider = p_provider and m.merchant_ref = p_merchant_ref;
  if found then
    if v_existing.owner_org_id = p_lender and v_existing.owner_kind = 'lender' then
      return v_existing.id;
    end if;
    raise exception 'this merchant is already claimed' using errcode = '23505', hint = 'merchant_already_claimed';
  end if;
  begin
    insert into payments.merchant_registry (provider, merchant_ref, owner_kind, owner_org_id, purpose, claimed_by)
    values (p_provider, p_merchant_ref, 'lender', p_lender, 'repayment', v_uid)
    returning id into v_id;
  exception when unique_violation then
    raise exception 'this merchant is already claimed' using errcode = '23505', hint = 'merchant_already_claimed';
  end;
  perform private.write_payments_audit(p_lender, 'payments.merchant.claimed', 'merchant', v_id::text, jsonb_build_object('provider', p_provider));
  return v_id;
end
$$;

-- Udofin's own fee-collection merchant (CF para 10(4) fees are paid by the lender, not collected from borrowers; this record only
-- makes the merchant identifiable so it can never be used for repayments).
create or replace function payments.register_udofin_fee_merchant(p_provider text, p_merchant_ref text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.accounts_require_platform(array['platform.payments.providers.manage']);
  v_existing payments.merchant_registry;
  v_id uuid;
begin
  if p_provider is null or not exists (select 1 from payments.provider_register r where r.provider = p_provider) then
    raise exception 'unknown provider' using errcode = '22023', hint = 'provider_invalid';
  end if;
  if p_merchant_ref is null or p_merchant_ref !~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{2,99}$' then
    raise exception 'invalid merchant reference' using errcode = '22023', hint = 'merchant_ref_invalid';
  end if;
  select * into v_existing from payments.merchant_registry m where m.provider = p_provider and m.merchant_ref = p_merchant_ref;
  if found then
    if v_existing.owner_kind = 'udofin_fees' then
      return v_existing.id;
    end if;
    raise exception 'this merchant is already claimed' using errcode = '23505', hint = 'merchant_already_claimed';
  end if;
  insert into payments.merchant_registry (provider, merchant_ref, owner_kind, owner_org_id, purpose, claimed_by)
  values (p_provider, p_merchant_ref, 'udofin_fees', null, 'fee_collection', v_uid)
  returning id into v_id;
  perform private.write_payments_audit(null, 'payments.merchant.registered_fees', 'merchant', v_id::text, jsonb_build_object('provider', p_provider));
  return v_id;
end
$$;

create or replace function payments.revoke_merchant(p_merchant uuid, p_reason text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.accounts_require_platform(array['platform.payments.providers.manage']);
  v_m payments.merchant_registry;
begin
  if p_reason is null or length(trim(p_reason)) < 10 then
    raise exception 'a reason of at least 10 characters is required' using errcode = '22023', hint = 'reason_required';
  end if;
  if length(trim(p_reason)) > 1000 then
    raise exception 'a reason must be 10 to 1000 characters' using errcode = '22023', hint = 'reason_invalid';
  end if;
  select * into v_m from payments.merchant_registry m where m.id = p_merchant for update;
  if not found then
    raise exception 'merchant not found' using errcode = 'P0002';
  end if;
  if v_m.status = 'revoked' then
    return 'revoked';
  end if;
  update payments.merchant_registry set status = 'revoked', revoked_by = v_uid, revoked_at = now(), revoked_reason = trim(p_reason) where id = p_merchant;
  perform private.write_payments_audit(v_m.owner_org_id, 'payments.merchant.revoked', 'merchant', p_merchant::text, jsonb_build_object('provider', v_m.provider));
  return 'revoked';
end
$$;

-- ---------------------------------------------------------------------------------------------
-- 13. Payment configuration workflow: draft and submit (payment.configure), approve (payment.config.approve, a different
--     person), suspend (platform kill switch), withdraw / retire, nightly revalidation (system)
-- ---------------------------------------------------------------------------------------------
create or replace function payments.draft_payment_config(
  p_lender uuid, p_provider text, p_provider_mode text, p_merchant_registry_id uuid, p_settlement_account_id uuid, p_secret_ref text,
  p_webhook_secret_ref text, p_endpoint_token_hash text, p_rail_limits jsonb, p_rail_limits_source text, p_evidence_ref text,
  p_contract_section_ref text, p_idempotency_key text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.payments_require_lender(p_lender, 'payment.configure');
  v_existing payments.lender_payment_configs;
  v_limits jsonb := coalesce(p_rail_limits, '{}'::jsonb);
  v_id uuid;
begin
  if p_idempotency_key is null or length(p_idempotency_key) not between 16 and 128 then
    raise exception 'a 16 to 128 character idempotency key is required' using errcode = '22023', hint = 'bad_request';
  end if;
  -- Mock and sandbox only where the session allows it (22023 provider_mode_invalid, 42501 mock_provider_blocked / sandbox_provider_blocked).
  perform private.assert_provider_mode_allowed(p_provider_mode);
  if p_secret_ref is null or p_secret_ref !~ '^[A-Z][A-Z0-9_]{2,63}$' or p_webhook_secret_ref is null or p_webhook_secret_ref !~ '^[A-Z][A-Z0-9_]{2,63}$'
     or p_secret_ref = p_webhook_secret_ref then
    raise exception 'secret references are names of secrets (UPPER_CASE), different from each other' using errcode = '22023', hint = 'secret_ref_invalid';
  end if;
  if p_endpoint_token_hash is null or p_endpoint_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'the endpoint token hash must be 64 lowercase hex characters' using errcode = '22023', hint = 'endpoint_token_hash_invalid';
  end if;
  if not private.rail_limits_ok(v_limits) or (v_limits <> '{}'::jsonb and (p_rail_limits_source is null or length(trim(p_rail_limits_source)) < 10)) then
    raise exception 'rail limits must be an object of objects with a source note' using errcode = '22023', hint = 'rail_limits_invalid';
  end if;
  if not exists (select 1 from payments.provider_register r where r.provider = p_provider) then
    raise exception 'unknown provider' using errcode = '22023', hint = 'provider_invalid';
  end if;
  if not exists (select 1 from payments.merchant_registry m where m.id = p_merchant_registry_id and m.owner_org_id = p_lender) then
    raise exception 'the merchant is not registered to this lender' using errcode = '22023', hint = 'merchant_invalid';
  end if;
  if not exists (select 1 from tenancy.lender_settlement_accounts s where s.id = p_settlement_account_id and s.lender_org_id = p_lender) then
    raise exception 'the settlement account is not this lender''s' using errcode = '22023', hint = 'settlement_account_invalid';
  end if;

  select * into v_existing from payments.lender_payment_configs c where c.drafted_by = v_uid and c.idempotency_key = p_idempotency_key;
  if found then
    if (v_existing.lender_org_id, v_existing.provider, v_existing.provider_mode, v_existing.merchant_registry_id, v_existing.settlement_account_id,
        v_existing.secret_ref, v_existing.webhook_secret_ref, v_existing.endpoint_token_hash)
       is distinct from (p_lender, p_provider, p_provider_mode, p_merchant_registry_id, p_settlement_account_id, p_secret_ref, p_webhook_secret_ref, p_endpoint_token_hash) then
      raise exception 'idempotency key was already used for a different configuration' using errcode = '23505', hint = 'idempotency_conflict';
    end if;
    return v_existing.id;
  end if;
  begin
    insert into payments.lender_payment_configs (lender_org_id, provider, provider_mode, merchant_registry_id, settlement_account_id, secret_ref,
                                                 webhook_secret_ref, endpoint_token_hash, rail_limits, rail_limits_source, evidence_ref,
                                                 contract_section_ref, idempotency_key, drafted_by, status_changed_by)
    values (p_lender, p_provider, p_provider_mode, p_merchant_registry_id, p_settlement_account_id, p_secret_ref, p_webhook_secret_ref,
            p_endpoint_token_hash, v_limits, p_rail_limits_source, p_evidence_ref, p_contract_section_ref, p_idempotency_key, v_uid, v_uid)
    returning id into v_id;
  exception when unique_violation then
    raise exception 'the callback token is already in use' using errcode = '23505', hint = 'endpoint_token_in_use';
  end;
  perform private.write_payments_audit(p_lender, 'payments.config.drafted', 'payment_config', v_id::text,
    jsonb_build_object('provider', p_provider, 'provider_mode', p_provider_mode));
  return v_id;
end
$$;

create or replace function payments.submit_payment_config(p_config uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cfg payments.lender_payment_configs;
  v_uid uuid;
  v_result jsonb;
begin
  select * into v_cfg from payments.lender_payment_configs c where c.id = p_config for update;
  if not found or v_cfg.lender_org_id not in (select private.orgs_with_permission('payment.configure')) then
    raise exception 'payment configuration not found' using errcode = 'P0002';
  end if;
  v_uid := private.payments_require_lender(v_cfg.lender_org_id, 'payment.configure');
  if v_cfg.status = 'pending_approval' and v_cfg.submitted_by = v_uid then
    return 'pending_approval';
  end if;
  if v_cfg.status not in ('draft', 'suspended') then
    raise exception 'configuration is %, it cannot be submitted', v_cfg.status using errcode = '55000', hint = 'config_state_invalid';
  end if;
  v_result := private.validate_collection_target_impl(p_config);
  if not (v_result ->> 'ok')::boolean then
    raise exception 'collection target invalid: %', v_result -> 'reasons' ->> 0 using errcode = '55000', hint = 'collection_target_invalid';
  end if;
  update payments.lender_payment_configs
  set status = 'pending_approval', submitted_by = v_uid, submitted_at = now(), approved_by = null, approved_at = null,
      status_changed_by = v_uid, status_changed_at = now(), status_reason = null, status_reasons = null,
      last_validated_at = now(), last_validation_ok = true
  where id = p_config;
  perform private.write_payments_audit(v_cfg.lender_org_id, 'payments.config.submitted', 'payment_config', p_config::text, jsonb_build_object('from', v_cfg.status));
  return 'pending_approval';
end
$$;

create or replace function payments.decide_payment_config(p_config uuid, p_approve boolean, p_note text default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cfg payments.lender_payment_configs;
  v_uid uuid;
  v_result jsonb;
begin
  if p_approve is null then
    raise exception 'approve must be true or false' using errcode = '22023', hint = 'bad_request';
  end if;
  select * into v_cfg from payments.lender_payment_configs c where c.id = p_config for update;
  if not found or v_cfg.lender_org_id not in (select private.orgs_with_permission('payment.config.approve')) then
    raise exception 'payment configuration not found' using errcode = 'P0002';
  end if;
  v_uid := private.payments_require_lender(v_cfg.lender_org_id, 'payment.config.approve');
  if v_cfg.status = 'active' and v_cfg.approved_by = v_uid and p_approve then
    return 'active';
  end if;
  if v_cfg.status <> 'pending_approval' then
    raise exception 'configuration is %, not pending approval', v_cfg.status using errcode = '55000', hint = 'config_state_invalid';
  end if;
  if v_cfg.drafted_by = v_uid or v_cfg.submitted_by = v_uid then
    raise exception 'a configuration cannot be decided by the person who drafted or submitted it' using errcode = '42501', hint = 'self_approval';
  end if;
  if p_note is not null and length(p_note) > 1000 then
    raise exception 'a note must be at most 1000 characters' using errcode = '22023', hint = 'reason_invalid';
  end if;
  if not p_approve then
    if p_note is null or length(trim(p_note)) < 10 then
      raise exception 'a rejection needs a reason' using errcode = '22023', hint = 'reason_required';
    end if;
    update payments.lender_payment_configs
    set status = 'retired', status_changed_by = v_uid, status_changed_at = now(), status_reason = 'rejected: ' || trim(p_note)
    where id = p_config;
    perform private.write_payments_audit(v_cfg.lender_org_id, 'payments.config.rejected', 'payment_config', p_config::text, '{}'::jsonb);
    return 'retired';
  end if;
  if not exists (
    select 1 from tenancy.memberships m
    join tenancy.membership_roles mr on mr.membership_id = m.id
    join tenancy.role_permissions rp on rp.role_id = mr.role_id
    where m.user_id = v_cfg.submitted_by and m.org_id = v_cfg.lender_org_id and m.status = 'active'
      and (m.valid_until is null or m.valid_until > now()) and rp.permission_key = 'payment.configure'
  ) then
    raise exception 'the submitter no longer holds the permission needed for this change' using errcode = '42501', hint = 'requester_not_entitled';
  end if;
  v_result := private.validate_collection_target_impl(p_config);
  if not (v_result ->> 'ok')::boolean then
    raise exception 'collection target invalid: %', v_result -> 'reasons' ->> 0 using errcode = '55000', hint = 'collection_target_invalid';
  end if;
  update payments.lender_payment_configs
  set status = 'active', approved_by = v_uid, approved_at = now(), status_changed_by = v_uid, status_changed_at = now(),
      status_reason = p_note, status_reasons = null, last_validated_at = now(), last_validation_ok = true
  where id = p_config;
  perform private.write_payments_audit(v_cfg.lender_org_id, 'payments.config.approved', 'payment_config', p_config::text,
    jsonb_build_object('provider_mode', v_cfg.provider_mode, 'drafted_by', v_cfg.drafted_by, 'submitted_by', v_cfg.submitted_by));
  return 'active';
end
$$;

-- Withdraw a draft or a pending configuration (the maker) before it is active.
create or replace function payments.withdraw_payment_config(p_config uuid, p_reason text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cfg payments.lender_payment_configs;
  v_uid uuid;
begin
  if p_reason is null or length(trim(p_reason)) < 10 then
    raise exception 'a reason of at least 10 characters is required' using errcode = '22023', hint = 'reason_required';
  end if;
  if length(trim(p_reason)) > 1000 then
    raise exception 'a reason must be 10 to 1000 characters' using errcode = '22023', hint = 'reason_invalid';
  end if;
  select * into v_cfg from payments.lender_payment_configs c where c.id = p_config for update;
  if not found or v_cfg.lender_org_id not in (select private.orgs_with_permission('payment.configure')) then
    raise exception 'payment configuration not found' using errcode = 'P0002';
  end if;
  v_uid := private.payments_require_lender(v_cfg.lender_org_id, 'payment.configure');
  if v_cfg.status = 'retired' then
    return 'retired';
  end if;
  if v_cfg.status not in ('draft', 'pending_approval') then
    raise exception 'configuration is %, only a draft or pending configuration can be withdrawn', v_cfg.status using errcode = '55000', hint = 'config_state_invalid';
  end if;
  update payments.lender_payment_configs
  set status = 'retired', status_changed_by = v_uid, status_changed_at = now(), status_reason = 'withdrawn: ' || trim(p_reason)
  where id = p_config;
  perform private.write_payments_audit(v_cfg.lender_org_id, 'payments.config.withdrawn', 'payment_config', p_config::text, '{}'::jsonb);
  return 'retired';
end
$$;

-- Platform kill switch: one person with platform.payments.providers.manage suspends an active configuration at once.
create or replace function payments.suspend_payment_config(p_config uuid, p_reason text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.accounts_require_platform(array['platform.payments.providers.manage']);
  v_cfg payments.lender_payment_configs;
begin
  if p_reason is null or length(trim(p_reason)) < 10 then
    raise exception 'a reason of at least 10 characters is required' using errcode = '22023', hint = 'reason_required';
  end if;
  if length(trim(p_reason)) > 1000 then
    raise exception 'a reason must be 10 to 1000 characters' using errcode = '22023', hint = 'reason_invalid';
  end if;
  select * into v_cfg from payments.lender_payment_configs c where c.id = p_config for update;
  if not found then
    raise exception 'payment configuration not found' using errcode = 'P0002';
  end if;
  if v_cfg.status = 'suspended' then
    return 'suspended';
  end if;
  if v_cfg.status <> 'active' then
    raise exception 'configuration is %, only an active configuration can be suspended', v_cfg.status using errcode = '55000', hint = 'config_state_invalid';
  end if;
  update payments.lender_payment_configs
  set status = 'suspended', status_changed_by = v_uid, status_changed_at = now(), status_reason = trim(p_reason), status_reasons = array['platform_suspension']
  where id = p_config;
  perform private.write_payments_audit(v_cfg.lender_org_id, 'payments.config.suspended', 'payment_config', p_config::text, jsonb_build_object('by', 'platform'));
  return 'suspended';
end
$$;

-- Retire an active or suspended configuration for good: a platform user (providers.manage) or the lender's approver.
create or replace function payments.retire_payment_config(p_config uuid, p_reason text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cfg payments.lender_payment_configs;
  v_uid uuid := (select auth.uid());
begin
  if p_reason is null or length(trim(p_reason)) < 10 then
    raise exception 'a reason of at least 10 characters is required' using errcode = '22023', hint = 'reason_required';
  end if;
  if length(trim(p_reason)) > 1000 then
    raise exception 'a reason must be 10 to 1000 characters' using errcode = '22023', hint = 'reason_invalid';
  end if;
  select * into v_cfg from payments.lender_payment_configs c where c.id = p_config for update;
  if not found then
    raise exception 'payment configuration not found' using errcode = 'P0002';
  end if;
  if v_uid is not null and private.has_platform_permission('platform.payments.providers.manage') then
    perform private.require_aal2();
  elsif v_uid is not null and v_cfg.lender_org_id in (select private.orgs_with_permission('payment.config.approve')) then
    perform private.payments_require_lender(v_cfg.lender_org_id, 'payment.config.approve');
  else
    raise exception 'payment configuration not found' using errcode = 'P0002';
  end if;
  if v_cfg.status = 'retired' then
    return 'retired';
  end if;
  if v_cfg.status not in ('active', 'suspended') then
    raise exception 'configuration is %, use withdraw for a draft or pending configuration', v_cfg.status using errcode = '55000', hint = 'config_state_invalid';
  end if;
  update payments.lender_payment_configs
  set status = 'retired', status_changed_by = v_uid, status_changed_at = now(), status_reason = 'retired: ' || trim(p_reason)
  where id = p_config;
  perform private.write_payments_audit(v_cfg.lender_org_id, 'payments.config.retired', 'payment_config', p_config::text, '{}'::jsonb);
  return 'retired';
end
$$;

-- System: put a configuration on hold for a stable reason code (for example `merchant_mismatch` when the provider's answer
-- names a different merchant than the configuration: spec 7.1 step 5). Idempotent.
create or replace function payments.system_suspend_payment_config(p_config uuid, p_reason_code text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cfg payments.lender_payment_configs;
begin
  if private.invoking_role() <> 'service_role' then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  if p_reason_code is null or p_reason_code !~ '^[a-z][a-z0-9_]{2,60}$' then
    raise exception 'a reason code is required' using errcode = '22023', hint = 'reason_required';
  end if;
  select * into v_cfg from payments.lender_payment_configs c where c.id = p_config for update;
  if not found then
    raise exception 'payment configuration not found' using errcode = 'P0002';
  end if;
  if v_cfg.status = 'suspended' then
    return 'suspended';
  end if;
  if v_cfg.status <> 'active' then
    return v_cfg.status;
  end if;
  update payments.lender_payment_configs
  set status = 'suspended', status_changed_by = null, status_changed_at = now(), status_reason = 'system hold: ' || p_reason_code,
      status_reasons = array[p_reason_code]
  where id = p_config;
  perform private.write_payments_audit(v_cfg.lender_org_id, 'payments.config.suspended', 'payment_config', p_config::text,
    jsonb_build_object('by', 'system', 'reason', p_reason_code));
  return 'suspended';
end
$$;

-- System, nightly: revalidate every active configuration (one lender, or all); any non-ok result suspends it (hold).
create or replace function payments.revalidate_payment_configs(p_lender uuid default null)
returns table (config_id uuid, ok boolean, reasons text[], suspended boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cfg record;
  v_result jsonb;
  v_ok boolean;
  v_reasons text[];
begin
  if private.invoking_role() <> 'service_role' then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  for v_cfg in
    select c.id, c.lender_org_id from payments.lender_payment_configs c
    where c.status = 'active' and (p_lender is null or c.lender_org_id = p_lender)
    order by c.id
    for update
  loop
    v_result := private.validate_collection_target_impl(v_cfg.id);
    v_ok := (v_result ->> 'ok')::boolean;
    v_reasons := array(select jsonb_array_elements_text(v_result -> 'reasons'));
    if v_ok then
      update payments.lender_payment_configs set last_validated_at = now(), last_validation_ok = true where id = v_cfg.id;
    else
      update payments.lender_payment_configs
      set status = 'suspended', status_changed_by = null, status_changed_at = now(), status_reason = 'system hold: validation failed',
          status_reasons = v_reasons, last_validated_at = now(), last_validation_ok = false
      where id = v_cfg.id;
      perform private.write_payments_audit(v_cfg.lender_org_id, 'payments.config.suspended', 'payment_config', v_cfg.id::text,
        jsonb_build_object('by', 'system', 'reasons', to_jsonb(v_reasons)));
    end if;
    config_id := v_cfg.id; ok := v_ok; reasons := v_reasons; suspended := not v_ok;
    return next;
  end loop;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- 14. Payment intents: a configuration is required; free-text settlement references are no longer accepted
-- ---------------------------------------------------------------------------------------------
alter table payments.payment_intents add column config_id uuid;
alter table payments.payment_intents add column provider_mode private.provider_mode;
alter table payments.payment_intents add constraint payment_intents_config_fk
  foreign key (config_id, lender_org_id) references payments.lender_payment_configs (id, lender_org_id) on delete restrict;
create index payment_intents_config on payments.payment_intents (config_id);
alter table payments.payment_intents alter column settlement_account_ref drop not null;
comment on column payments.payment_intents.config_id is
  'The active payment configuration this instruction was created under. Required for new rows (trigger payment_intents_collection_target); null only for history. The provider, provider mode and settlement account of the instruction are the configuration''s.';
comment on column payments.payment_intents.settlement_account_ref is
  'HISTORY ONLY. Free text is no longer accepted for new rows (null or the marker via_payment_config): the destination is the lender''s verified settlement account named by the configuration (settlement_account_id).';

create or replace function private.require_collection_target()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cfg payments.lender_payment_configs;
  v_result jsonb;
begin
  if new.config_id is null then
    raise exception 'collection target invalid: config_required' using errcode = '55000', hint = 'collection_target_invalid';
  end if;
  if new.settlement_account_ref is not null and new.settlement_account_ref <> 'via_payment_config' then
    raise exception 'a free-text settlement account reference is no longer accepted: the destination comes from the payment configuration'
      using errcode = '22023', hint = 'free_text_settlement_ref';
  end if;
  -- Lock what the decision rests on, so a concurrent revocation or suspension waits for this insert (or is seen by it).
  select * into v_cfg from payments.lender_payment_configs c where c.id = new.config_id and c.lender_org_id = new.lender_org_id for share;
  if not found then
    raise exception 'collection target invalid: config_not_found' using errcode = '55000', hint = 'collection_target_invalid';
  end if;
  perform 1 from tenancy.lender_settlement_accounts s where s.id = v_cfg.settlement_account_id for share;
  perform 1 from payments.account_registry r
    where r.id = (select s.registry_id from tenancy.lender_settlement_accounts s where s.id = v_cfg.settlement_account_id) for share;
  perform 1 from payments.merchant_registry m where m.id = v_cfg.merchant_registry_id for share;
  if v_cfg.status <> 'active' then
    raise exception 'collection target invalid: config_not_active' using errcode = '55000', hint = 'collection_target_invalid';
  end if;
  v_result := private.validate_collection_target_impl(new.config_id);
  if not (v_result ->> 'ok')::boolean then
    raise exception 'collection target invalid: %', v_result -> 'reasons' ->> 0 using errcode = '55000', hint = 'collection_target_invalid';
  end if;
  if new.settlement_account_id is not null and new.settlement_account_id <> v_cfg.settlement_account_id then
    raise exception 'the settlement account is not the one named by the payment configuration' using errcode = '23503', hint = 'settlement_account_mismatch';
  end if;
  if new.provider <> v_cfg.provider then
    raise exception 'the provider is not the one named by the payment configuration' using errcode = '55000', hint = 'provider_mismatch';
  end if;
  if new.provider_mode is not null and new.provider_mode <> v_cfg.provider_mode then
    raise exception 'the provider mode is not the one named by the payment configuration' using errcode = '55000', hint = 'provider_mismatch';
  end if;
  new.settlement_account_id := v_cfg.settlement_account_id;
  new.provider_mode := v_cfg.provider_mode;
  return new;
end
$$;
revoke all on function private.require_collection_target() from public;
create trigger payment_intents_collection_target before insert on payments.payment_intents
  for each row execute function private.require_collection_target();
-- A mock intent exists only where mocks are allowed (insert only: history rows have a null mode).
create trigger payment_intents_provider_mode_guard before insert on payments.payment_intents
  for each row when (new.provider_mode is not null) execute function private.guard_provider_mode('provider_mode');

-- ---------------------------------------------------------------------------------------------
-- 15. Grants for the functions
-- ---------------------------------------------------------------------------------------------
revoke all on function payments.draft_account_format_rule(text, text, integer, integer, boolean, text, text, date, date) from public;
revoke all on function payments.submit_account_format_rule(uuid) from public;
revoke all on function payments.approve_account_format_rule(uuid, text) from public;
revoke all on function payments.retire_account_format_rule(uuid, text) from public;
revoke all on function payments.register_account(text, integer, text, text, text, uuid, boolean, text, uuid, text, text[], date, date, text) from public;
revoke all on function payments.verify_account(uuid, text, text) from public;
revoke all on function payments.reject_account(uuid, text) from public;
revoke all on function payments.revoke_account(uuid, text) from public;
revoke all on function payments.link_settlement_account(uuid, uuid) from public;
revoke all on function payments.my_settlement_account_registry_status() from public;
revoke all on function payments.set_payment_provider(text, text, text, text, text, text, text) from public;
revoke all on function payments.claim_merchant(uuid, text, text) from public;
revoke all on function payments.register_udofin_fee_merchant(text, text) from public;
revoke all on function payments.revoke_merchant(uuid, text) from public;
revoke all on function payments.draft_payment_config(uuid, text, text, uuid, uuid, text, text, text, jsonb, text, text, text, text) from public;
revoke all on function payments.submit_payment_config(uuid) from public;
revoke all on function payments.decide_payment_config(uuid, boolean, text) from public;
revoke all on function payments.withdraw_payment_config(uuid, text) from public;
revoke all on function payments.suspend_payment_config(uuid, text) from public;
revoke all on function payments.retire_payment_config(uuid, text) from public;
revoke all on function payments.system_suspend_payment_config(uuid, text) from public;
revoke all on function payments.revalidate_payment_configs(uuid) from public;

grant execute on function payments.draft_account_format_rule(text, text, integer, integer, boolean, text, text, date, date) to authenticated;
grant execute on function payments.submit_account_format_rule(uuid) to authenticated;
grant execute on function payments.approve_account_format_rule(uuid, text) to authenticated;
grant execute on function payments.retire_account_format_rule(uuid, text) to authenticated;
grant execute on function payments.register_account(text, integer, text, text, text, uuid, boolean, text, uuid, text, text[], date, date, text) to authenticated;
grant execute on function payments.verify_account(uuid, text, text) to authenticated;
grant execute on function payments.reject_account(uuid, text) to authenticated;
grant execute on function payments.revoke_account(uuid, text) to authenticated;
grant execute on function payments.link_settlement_account(uuid, uuid) to authenticated;
grant execute on function payments.my_settlement_account_registry_status() to authenticated;
grant execute on function payments.set_payment_provider(text, text, text, text, text, text, text) to authenticated;
grant execute on function payments.claim_merchant(uuid, text, text) to authenticated;
grant execute on function payments.register_udofin_fee_merchant(text, text) to authenticated;
grant execute on function payments.revoke_merchant(uuid, text) to authenticated;
grant execute on function payments.draft_payment_config(uuid, text, text, uuid, uuid, text, text, text, jsonb, text, text, text, text) to authenticated;
grant execute on function payments.submit_payment_config(uuid) to authenticated;
grant execute on function payments.decide_payment_config(uuid, boolean, text) to authenticated;
grant execute on function payments.withdraw_payment_config(uuid, text) to authenticated;
grant execute on function payments.suspend_payment_config(uuid, text) to authenticated;
grant execute on function payments.retire_payment_config(uuid, text) to authenticated;
grant execute on function payments.system_suspend_payment_config(uuid, text) to service_role;
grant execute on function payments.revalidate_payment_configs(uuid) to service_role;

comment on function payments.register_account(text, integer, text, text, text, uuid, boolean, text, uuid, text, text[], date, date, text) is
  'Platform user with platform.accounts.registry.manage (aal2). Registers the keyed-HMAC fingerprint computed by the BACKEND (the database never sees an account number) under an owner and permitted purposes. Refused (55000 account_format_unvalidated) unless the format rule is non-null, APPROVED, effective, for the same country and account type, and format_validated is true. The same (fingerprint, key_version) cannot be registered twice (23505 account_already_registered): one entry per real account. Idempotent on (user, key). A new key_version means re-registration. The entry stays unverified until a DIFFERENT person calls payments.verify_account.';
comment on function payments.verify_account(uuid, text, text) is
  'Platform user with platform.accounts.registry.verify (aal2), a DIFFERENT person than the registrant (42501 self_approval); the registrant must still hold platform.accounts.registry.manage. Needs an evidence reference label. unverified -> verified. Idempotent for the same verifier and evidence.';
comment on function payments.revoke_account(uuid, text) is
  'Either registry permission, one person, reason of 10+ characters, recorded and audited (fail-closed single-person revoke). The entry becomes revoked for good; linked settlement accounts are revoked and active configurations that settle into it are suspended in the same transaction.';
comment on function payments.link_settlement_account(uuid, uuid) is
  'Platform user with platform.accounts.registry.manage (aal2). The only function that makes a settlement account verified: it proves the registry entry is verified, owned by this lender, permitted for repayment_settlement, effective now, and has the same masked reference. The table trigger enforces the same proof for every other writer.';
comment on function payments.decide_payment_config(uuid, boolean, text) is
  'Lender user with payment.config.approve (aal2), a DIFFERENT person than the drafter and the submitter (42501 self_approval). Approval re-runs the collection-target validation (55000 collection_target_invalid with the first reason code in the message) and the submitter must still hold payment.configure. Rejection retires the configuration and needs a note.';
comment on function payments.revalidate_payment_configs(uuid) is
  'System only (nightly, or after a registry change). Revalidates every ACTIVE configuration and suspends any whose validation is not ok (hold). Returns config_id, ok, reasons, suspended.';

-- ---------------------------------------------------------------------------------------------
-- 16. Feature prerequisite: `payments` additionally needs an ACTIVE PRODUCTION configuration whose validation is ok and whose
--     registry entry is verified. Replaces the foundation body (migration 20261018000908) PRESERVING every earlier check.
-- ---------------------------------------------------------------------------------------------
create or replace function private.feature_prerequisites_unmet(p_lender uuid, p_feature text)
returns text[]
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_reasons text[] := '{}';
  v_enableable boolean;
begin
  select c.enableable into v_enableable from servicing.feature_catalog c where c.feature = p_feature;
  if not found then
    v_reasons := v_reasons || 'feature_unknown'::text;
  elsif not v_enableable then
    v_reasons := v_reasons || 'feature_not_enableable'::text;
  end if;
  if not exists (select 1 from tenancy.organizations o where o.id = p_lender and o.kind = 'lender' and o.status = 'active') then
    v_reasons := v_reasons || 'lender_organisation_not_active'::text;
  end if;
  if not exists (select 1 from onboarding.lender_gates g where g.lender_org_id = p_lender and g.stage = 'activated') then
    v_reasons := v_reasons || 'onboarding_gate_not_activated'::text;
  end if;
  if not exists (
    select 1 from servicing.feature_change_requests r
    where r.lender_org_id = p_lender and r.feature = p_feature and r.status = 'pending' and r.enable and r.evidence <> '{}'::jsonb
  ) then
    v_reasons := v_reasons || 'evidence_missing'::text;
  end if;
  -- Phase 08a accounts and payment configuration. A mock or sandbox configuration can never satisfy this gate, whatever the
  -- session settings are (private.provider_mode_satisfies_production_gate).
  if p_feature = 'payments' then
    if not exists (
      select 1 from payments.lender_payment_configs c
      where c.lender_org_id = p_lender and c.status = 'active' and private.provider_mode_satisfies_production_gate(c.provider_mode)
    ) then
      v_reasons := v_reasons || 'payment_config_missing'::text;
      if exists (select 1 from payments.lender_payment_configs c where c.lender_org_id = p_lender and c.status = 'active') then
        v_reasons := v_reasons || 'payment_config_mock_or_sandbox_only'::text;
      end if;
    else
      if not exists (
        select 1
        from payments.lender_payment_configs c
        join tenancy.lender_settlement_accounts s on s.id = c.settlement_account_id and s.lender_org_id = c.lender_org_id
        join payments.account_registry r on r.id = s.registry_id
        where c.lender_org_id = p_lender and c.status = 'active' and private.provider_mode_satisfies_production_gate(c.provider_mode)
          and r.verification_status = 'verified'
      ) then
        v_reasons := v_reasons || 'registry_entry_not_verified'::text;
      end if;
      if not exists (
        select 1 from payments.lender_payment_configs c
        where c.lender_org_id = p_lender and c.status = 'active' and private.provider_mode_satisfies_production_gate(c.provider_mode)
          and (private.validate_collection_target_impl(c.id) ->> 'ok')::boolean
      ) then
        v_reasons := v_reasons || 'payment_config_validation_failed'::text;
      end if;
    end if;
  end if;
  -- Later Phase 08a migrations add further feature-specific checks here (mandates, servicing_sync, ...): copy this body
  -- from the highest-numbered migration that defines it, append, and never remove or weaken a reason.
  return array(select distinct x from unnest(v_reasons) x order by x);
end
$$;
comment on function private.feature_prerequisites_unmet(uuid, text) is
  'Reasons a feature cannot be switched on for a lender; empty array = none. Generic checks: feature unknown or not enableable, lender organisation not active, onboarding gate not activated, evidence missing (the single pending enable request must carry evidence). payments (migration 20261018000910): payment_config_missing (no ACTIVE configuration in production mode), payment_config_mock_or_sandbox_only (only a mock or sandbox configuration is active: it can never satisfy the gate), registry_entry_not_verified (no active production configuration settles into a verified registry entry), payment_config_validation_failed (no active production configuration passes payments.validate_collection_target). EXTENDING: later migrations add feature-specific checks with CREATE OR REPLACE and MUST PRESERVE every earlier check (copy the body of the highest-numbered migration that defines this function and append; never remove or weaken a reason). A mock or sandbox provider record must never satisfy a check: use private.provider_mode_satisfies_production_gate.';
revoke all on function private.feature_prerequisites_unmet(uuid, text) from public;
grant execute on function private.feature_prerequisites_unmet(uuid, text) to service_role;

-- Table comments on pre-existing objects touched here.
comment on table tenancy.lender_settlement_accounts is
  'Lender-owned accounts that borrower payments settle into (ADR 0008: no Udofin pool account). A masked reference only; never the number. status = verified only with proof from payments.account_registry (registry_id): verified entry, owned by this lender, permitted for repayment_settlement, effective now; the proof is re-read live by payments.validate_collection_target. The system role can create unverified rows but cannot edit or delete them. Owner: tenancy module.';
