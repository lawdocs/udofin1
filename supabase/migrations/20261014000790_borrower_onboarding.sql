-- =============================================================================================
-- Phase 05: borrower onboarding and loan request (spec: docs/specs/05-borrower-onboarding.md,
-- implementation brief of 13 Oct 2026).
--
-- Principles
--   * The authentication provider proves who signed in; `identity.borrowers` holds the minimal
--     business profile. No phone number, date of birth, PAN, Aadhaar or document data is stored here.
--   * Account created, profile completed, consent completed, request drafted and request submitted
--     are separate states. Nothing here says a borrower is KYC-verified or eligible.
--   * Every borrower write goes through a checked function; borrower-owned rows are read under RLS.
--   * Consent is an append-only ledger against exact notice versions; withdrawal is a new row.
--   * Drafts expire 30 days after creation and the expiry is enforced on read and on write, not only
--     by a job. Expiry never deletes data.
--   * Deletion anonymises the profile; consent and audit records are kept (retention periods are
--     NOT decided - D-25 is open - so none is applied or invented here).
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- Profile
-- ---------------------------------------------------------------------------------------------
alter table identity.borrowers
  add column display_name text check (display_name is null or (length(display_name) between 1 and 60 and display_name !~ '[<>]')),
  add column onboarding_status text not null default 'account_created'
    check (onboarding_status in ('account_created', 'profile_started', 'profile_completed', 'deletion_requested', 'anonymised')),
  add column profile_completed_at timestamptz,
  add column anonymised_at timestamptz;
comment on column identity.borrowers.display_name is 'Optional name the borrower wants to be addressed by. Not a legal name; the lender collects the legal name at KYC.';
comment on column identity.borrowers.onboarding_status is 'Account/profile progress only. It says nothing about KYC or eligibility.';

-- A closed (anonymised) borrower has no access to anything borrower-owned.
create or replace function private.my_borrower_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select b.id from identity.borrowers b where b.user_id = (select auth.uid()) and b.status <> 'closed'
$$;

create table identity.communication_preferences (
  borrower_id uuid primary key references identity.borrowers (id) on delete restrict,
  -- Optional service updates by SMS. Security and legally required messages are not controlled by this.
  service_updates_sms boolean not null default true,
  updated_at timestamptz not null default now()
);
comment on table identity.communication_preferences is
  'Service-message preferences. Marketing is NOT a column: it is a consent-ledger purpose and is disabled at launch. Owner: identity module.';

-- ---------------------------------------------------------------------------------------------
-- Audit helper for borrower actions (the borrower has no insert right on audit.events)
-- ---------------------------------------------------------------------------------------------
create or replace function identity.audit(p_action text, p_entity_type text, p_entity_id text, p_meta jsonb default '{}'::jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into audit.events (actor_type, actor_user_id, action, entity_type, entity_id, metadata)
  values (case when (select auth.uid()) is null then 'system' else 'borrower' end::audit.actor_type,
          (select auth.uid()), p_action, p_entity_type, p_entity_id, coalesce(p_meta, '{}'::jsonb))
$$;
revoke all on function identity.audit(text, text, text, jsonb) from public;

create or replace function identity.require_borrower()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v uuid := private.my_borrower_id();
begin
  if v is null then
    raise exception 'borrower account not available' using errcode = '42501', hint = 'account_closed';
  end if;
  return v;
end
$$;
revoke all on function identity.require_borrower() from public;

-- ---------------------------------------------------------------------------------------------
-- Profile functions
-- ---------------------------------------------------------------------------------------------
create or replace function identity.update_profile(p_display_name text, p_clear_display_name boolean, p_language text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid := identity.require_borrower();
  v_row identity.borrowers;
begin
  if p_language is not null and p_language not in ('en', 'hi') then
    raise exception 'unsupported language' using errcode = '22023', hint = 'language_unsupported';
  end if;
  select * into v_row from identity.borrowers where id = v_id for update;
  if v_row.onboarding_status in ('deletion_requested', 'anonymised') then
    raise exception 'the account is being closed' using errcode = '55000', hint = 'account_closing';
  end if;
  update identity.borrowers set
    display_name = case when p_clear_display_name then null else coalesce(nullif(trim(p_display_name), ''), display_name) end,
    preferred_language = coalesce(p_language, preferred_language),
    onboarding_status = case when onboarding_status = 'account_created' then 'profile_started' else onboarding_status end
  where id = v_id;
  insert into identity.communication_preferences (borrower_id) values (v_id) on conflict do nothing;
  perform identity.audit('identity.profile.updated', 'borrower', v_id::text,
    jsonb_build_object('language_changed', p_language is not null, 'display_name_changed', p_display_name is not null or p_clear_display_name));
end
$$;

create or replace function identity.complete_profile()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid := identity.require_borrower();
begin
  update identity.borrowers set onboarding_status = 'profile_completed', profile_completed_at = coalesce(profile_completed_at, now())
  where id = v_id and onboarding_status in ('account_created', 'profile_started', 'profile_completed');
  if not found then
    raise exception 'the account is being closed' using errcode = '55000', hint = 'account_closing';
  end if;
  insert into identity.communication_preferences (borrower_id) values (v_id) on conflict do nothing;
  perform identity.audit('identity.profile.completed', 'borrower', v_id::text);
end
$$;

create or replace function identity.set_communication_preferences(p_service_updates_sms boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid := identity.require_borrower();
begin
  insert into identity.communication_preferences (borrower_id, service_updates_sms) values (v_id, p_service_updates_sms)
  on conflict (borrower_id) do update set service_updates_sms = excluded.service_updates_sms, updated_at = now();
  perform identity.audit('identity.communication_preferences.updated', 'borrower', v_id::text, jsonb_build_object('service_updates_sms', p_service_updates_sms));
end
$$;

-- The borrower's own phone number, for sending a step-up code to the number they signed in with. It
-- is returned to the caller only and never stored by us.
create or replace function identity.my_phone()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select u.phone from auth.users u where u.id = (select auth.uid()) and private.my_borrower_id() is not null
$$;
revoke all on function identity.my_phone() from public;

-- ---------------------------------------------------------------------------------------------
-- Consent
-- ---------------------------------------------------------------------------------------------
alter table consent.notices
  add column review_status text not null default 'approved' check (review_status in ('approved', 'requires_review'));
comment on column consent.notices.review_status is
  '`requires_review` marks wording (for example a Hindi translation) that counsel has not approved; the app labels it and it cannot be the basis of a required consent.';

-- Switches controlled by compliance; marketing is off at launch.
insert into onboarding.platform_settings (key, bool_value, description) values
  ('marketing_enabled', false,
   'When true, a separate marketing consent can be recorded and marketing could be sent. Off at launch (D-14); turning it on needs review and approval.');

create or replace function consent.record_decision(p_notice_id uuid, p_decision consent.decision, p_app_version text, p_screen text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_borrower uuid := identity.require_borrower();
  v_notice consent.notices;
  v_id uuid;
  v_required text[] := array['terms_of_use', 'privacy_notice', 'share_with_lenders'];
begin
  select * into v_notice from consent.notices where id = p_notice_id and status = 'published';
  if not found then
    raise exception 'notice not found' using errcode = 'P0002';
  end if;
  if v_notice.lender_org_id is not null then
    raise exception 'lender-specific consent is recorded in the lender journey' using errcode = '22023', hint = 'purpose_unsupported';
  end if;
  if v_notice.purpose = 'marketing' and not coalesce((select s.bool_value from onboarding.platform_settings s where s.key = 'marketing_enabled'), false) then
    raise exception 'marketing communications are not enabled' using errcode = '55000', hint = 'marketing_disabled';
  end if;
  if v_notice.purpose = any (v_required) and p_decision = 'granted' and v_notice.review_status <> 'approved' then
    raise exception 'this wording has not been approved' using errcode = '55000', hint = 'wording_not_approved';
  end if;
  -- Only the latest published version of a purpose and language can be accepted.
  if v_notice.version < (select max(n.version) from consent.notices n
                         where n.purpose = v_notice.purpose and n.language = v_notice.language and n.lender_org_id is null and n.status = 'published') then
    raise exception 'a newer version of this notice is published' using errcode = '55000', hint = 'notice_superseded';
  end if;
  insert into consent.records (borrower_id, notice_id, decision, channel, app_version, evidence)
  values (v_borrower, p_notice_id, p_decision, 'mobile_app', left(p_app_version, 40),
          jsonb_build_object('screen', left(coalesce(p_screen, 'unknown'), 40), 'notice_sha256', v_notice.body_sha256, 'language', v_notice.language))
  returning id into v_id;
  perform identity.audit('consent.recorded', 'consent_record', v_id::text, jsonb_build_object('purpose', v_notice.purpose, 'decision', p_decision::text, 'notice_version', v_notice.version));
  return v_id;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Loan purposes (reference data supplied by the owner; deliberately empty here)
-- ---------------------------------------------------------------------------------------------
create table lending.loan_purposes (
  key text primary key check (key ~ '^[a-z][a-z_]{1,39}$'),
  label_en text not null check (length(label_en) between 2 and 80),
  label_hi text not null check (length(label_hi) between 2 and 80),
  hi_review_status text not null default 'requires_review' check (hi_review_status in ('approved', 'requires_review')),
  sort_order integer not null default 100,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
comment on table lending.loan_purposes is
  'The fixed list of loan purposes. Supplied by the owner (no list existed in the repository when Phase 05 was built); stable keys, localized labels. Owner: lending module.';

-- ---------------------------------------------------------------------------------------------
-- Loan requests
-- ---------------------------------------------------------------------------------------------
create or replace function lending.draft_lifetime()
returns interval
language sql
immutable
set search_path = ''
as $$ select interval '30 days' $$;

alter table lending.loan_requests
  add column version integer not null default 1 check (version > 0),
  add column submission_reference text unique check (submission_reference is null or submission_reference ~ '^UR-[0-9A-Z]{10}$'),
  add column submitted_at timestamptz,
  add column product_version_id uuid references lending.loan_product_versions (id) on delete restrict,
  add column product_snapshot jsonb;
comment on column lending.loan_requests.expires_at is 'Fixed at creation (30 days). Never extended.';
comment on column lending.loan_requests.product_snapshot is 'Terms of the selected product version as they were when the request was submitted.';

create table lending.loan_request_events (
  id uuid primary key default private.uuid_v7(),
  loan_request_id uuid not null references lending.loan_requests (id) on delete restrict,
  borrower_id uuid not null references identity.borrowers (id) on delete restrict,
  event text not null check (event in ('created', 'submitted', 'withdrawn', 'expired')),
  from_status text,
  to_status text not null,
  occurred_at timestamptz not null default clock_timestamp()
);
create index loan_request_events_request on lending.loan_request_events (loan_request_id, occurred_at);
create trigger loan_request_events_append_only before update or delete on lending.loan_request_events
  for each row execute function private.forbid_mutation();
comment on table lending.loan_request_events is 'Borrower-visible history of a loan request. Append-only. Owner: lending module.';

-- The draft lifetime is set by the database, whoever inserts.
create or replace function lending.loan_request_before_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'draft' then
    new.expires_at := coalesce(new.expires_at, now() + lending.draft_lifetime());
  end if;
  return new;
end
$$;
create trigger loan_requests_before_insert before insert on lending.loan_requests
  for each row execute function lending.loan_request_before_insert();

-- Submission rules live here, so they apply to every path (API function or direct update).
create or replace function lending.loan_request_before_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_missing text;
begin
  if new.version is not distinct from old.version and to_jsonb(new) - 'updated_at' is distinct from to_jsonb(old) - 'updated_at' then
    new.version := old.version + 1;
  end if;

  if private.current_actor() = 'borrower' then
    if new.expires_at is distinct from old.expires_at then
      raise exception 'the draft expiry cannot be changed' using errcode = '42501', hint = 'expiry_fixed';
    end if;
    if old.status = 'draft' and old.expires_at is not null and old.expires_at <= now() and new.status <> 'expired' then
      raise exception 'this draft has expired' using errcode = '55000', hint = 'draft_expired';
    end if;
  end if;

  if old.status = 'draft' and new.status = 'submitted' then
    if new.expires_at is not null and new.expires_at <= now() then
      raise exception 'this draft has expired' using errcode = '55000', hint = 'draft_expired';
    end if;
    if not exists (select 1 from lending.loan_purposes p where p.key = new.purpose_code and p.active) then
      raise exception 'unknown loan purpose' using errcode = '22023', hint = 'purpose_unknown';
    end if;
    select string_agg(req.purpose, ',') into v_missing
    from unnest(array['terms_of_use', 'privacy_notice', 'share_with_lenders']) as req (purpose)
    where not exists (select 1 from consent.current_decisions d
                      where d.borrower_id = new.borrower_id and d.purpose = req.purpose and d.lender_org_id is null and d.decision = 'granted');
    if v_missing is not null then
      raise exception 'required consents are missing' using errcode = '55000', hint = 'consent_required';
    end if;
    if exists (select 1 from identity.borrowers b where b.id = new.borrower_id and b.onboarding_status in ('deletion_requested', 'anonymised')) then
      raise exception 'the account is being closed' using errcode = '55000', hint = 'account_closing';
    end if;
    if new.product_version_id is not null then
      select jsonb_build_object('product_version_id', v.version_id, 'product_id', v.product_id, 'lender_org_id', v.lender_org_id, 'version', v.version,
                                'min_amount_minor', v.min_amount_minor, 'max_amount_minor', v.max_amount_minor, 'min_tenure_days', v.min_tenure_days,
                                'max_tenure_days', v.max_tenure_days, 'rate_type', v.rate_type, 'min_annual_rate_bps', v.min_annual_rate_bps,
                                'max_annual_rate_bps', v.max_annual_rate_bps)
        into new.product_snapshot
      from lending.borrower_visible_product_versions v where v.version_id = new.product_version_id;
      if new.product_snapshot is null then
        raise exception 'the selected product is not available' using errcode = '55000', hint = 'product_unavailable';
      end if;
    end if;
    new.submitted_at := now();
    new.submission_reference := coalesce(new.submission_reference,
      'UR-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10)));
  end if;
  return new;
end
$$;
create trigger loan_requests_before_update_rules before update on lending.loan_requests
  for each row execute function lending.loan_request_before_update();

create or replace function lending.loan_request_after_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into lending.loan_request_events (loan_request_id, borrower_id, event, to_status) values (new.id, new.borrower_id, 'created', new.status::text);
  elsif new.status is distinct from old.status then
    insert into lending.loan_request_events (loan_request_id, borrower_id, event, from_status, to_status)
    values (new.id, new.borrower_id,
            case new.status when 'submitted' then 'submitted' when 'withdrawn' then 'withdrawn' when 'expired' then 'expired' else null end,
            old.status::text, new.status::text)
    ;
  end if;
  return new;
exception when check_violation then
  -- Statuses with no borrower-visible event (for example offer_selected, closed) are not listed in the history.
  return new;
end
$$;
create trigger loan_requests_after_change after insert or update on lending.loan_requests
  for each row execute function lending.loan_request_after_change();

-- What the borrower sees: expiry is applied on read, whether or not the cleanup job has run.
create view lending.my_loan_requests with (security_invoker = true) as
select r.id, r.category_key, r.requested_amount_minor, r.requested_tenure_days, r.purpose_code,
       case when r.status = 'draft' and r.expires_at is not null and r.expires_at <= now() then 'expired' else r.status::text end as status,
       r.version, r.expires_at, r.submission_reference, r.submitted_at, r.product_version_id, r.created_at, r.updated_at
from lending.loan_requests r;
comment on view lending.my_loan_requests is 'Borrower-facing loan requests with the effective (expiry-aware) status. Owner: lending module.';

create or replace function lending.request_create(p_category text, p_amount_minor bigint, p_tenure_days integer, p_purpose text, p_product_version uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_borrower uuid := identity.require_borrower();
  v_cat lending.product_categories;
  v_id uuid;
  v_open integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('loan_request_create:' || v_borrower::text, 0));
  if exists (select 1 from identity.borrowers b where b.id = v_borrower and b.onboarding_status in ('deletion_requested', 'anonymised')) then
    raise exception 'the account is being closed' using errcode = '55000', hint = 'account_closing';
  end if;
  select * into v_cat from lending.product_categories where key = p_category and availability = 'enabled';
  if not found then
    raise exception 'category not available' using errcode = '22023', hint = 'category_unavailable';
  end if;
  if not exists (select 1 from lending.loan_purposes where key = p_purpose and active) then
    raise exception 'unknown loan purpose' using errcode = '22023', hint = 'purpose_unknown';
  end if;
  if p_tenure_days < v_cat.min_tenure_days then
    raise exception 'tenure is below the minimum for this category' using errcode = '22023', hint = 'tenure_out_of_range';
  end if;
  if p_product_version is not null and not exists (
    select 1 from lending.borrower_visible_product_versions v
    where v.version_id = p_product_version and v.category_key = p_category
      and p_amount_minor between v.min_amount_minor and v.max_amount_minor and p_tenure_days between v.min_tenure_days and v.max_tenure_days) then
    raise exception 'the selected product is not available for these values' using errcode = '55000', hint = 'product_unavailable';
  end if;
  select count(*) into v_open from lending.loan_requests r
  where r.borrower_id = v_borrower and r.status = 'draft' and (r.expires_at is null or r.expires_at > now());
  if v_open >= 5 then
    raise exception 'too many open drafts' using errcode = '55000', hint = 'too_many_drafts';
  end if;
  insert into lending.loan_requests (borrower_id, category_key, requested_amount_minor, requested_tenure_days, purpose_code, product_version_id)
  values (v_borrower, p_category, p_amount_minor, p_tenure_days, p_purpose, p_product_version)
  returning id into v_id;
  perform identity.audit('lending.loan_request.drafted', 'loan_request', v_id::text);
  return v_id;
end
$$;

create or replace function lending.request_update(p_id uuid, p_expected_version integer, p_amount_minor bigint, p_tenure_days integer, p_purpose text, p_product_version uuid, p_clear_product boolean)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_borrower uuid := identity.require_borrower();
  v_row lending.loan_requests;
  v_amount bigint;
  v_tenure integer;
  v_product uuid;
  v_min integer;
begin
  select * into v_row from lending.loan_requests where id = p_id and borrower_id = v_borrower for update;
  if not found then
    raise exception 'request not found' using errcode = 'P0002';
  end if;
  if v_row.status <> 'draft' then
    raise exception 'only a draft can be edited' using errcode = '55000', hint = 'not_editable';
  end if;
  if v_row.expires_at <= now() then
    raise exception 'this draft has expired' using errcode = '55000', hint = 'draft_expired';
  end if;
  if v_row.version <> p_expected_version then
    raise exception 'the draft changed since you opened it' using errcode = '55000', hint = 'version_conflict';
  end if;
  v_amount := coalesce(p_amount_minor, v_row.requested_amount_minor);
  v_tenure := coalesce(p_tenure_days, v_row.requested_tenure_days);
  v_product := case when p_clear_product then null else coalesce(p_product_version, v_row.product_version_id) end;
  if p_purpose is not null and not exists (select 1 from lending.loan_purposes where key = p_purpose and active) then
    raise exception 'unknown loan purpose' using errcode = '22023', hint = 'purpose_unknown';
  end if;
  select min_tenure_days into v_min from lending.product_categories where key = v_row.category_key;
  if v_tenure < v_min then
    raise exception 'tenure is below the minimum for this category' using errcode = '22023', hint = 'tenure_out_of_range';
  end if;
  if v_product is not null and not exists (
    select 1 from lending.borrower_visible_product_versions v
    where v.version_id = v_product and v.category_key = v_row.category_key
      and v_amount between v.min_amount_minor and v.max_amount_minor and v_tenure between v.min_tenure_days and v.max_tenure_days) then
    raise exception 'the selected product is not available for these values' using errcode = '55000', hint = 'product_unavailable';
  end if;
  update lending.loan_requests set requested_amount_minor = v_amount, requested_tenure_days = v_tenure,
    purpose_code = coalesce(p_purpose, purpose_code), product_version_id = v_product
  where id = p_id returning version into v_tenure;
  perform identity.audit('lending.loan_request.draft_updated', 'loan_request', p_id::text);
  return v_tenure;
end
$$;

create or replace function lending.request_submit(p_id uuid, p_expected_version integer)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_borrower uuid := identity.require_borrower();
  v_row lending.loan_requests;
begin
  select * into v_row from lending.loan_requests where id = p_id and borrower_id = v_borrower for update;
  if not found then
    raise exception 'request not found' using errcode = 'P0002';
  end if;
  -- A repeat of an already successful submission returns the same reference instead of failing or duplicating.
  if v_row.status = 'submitted' then
    return v_row.submission_reference;
  end if;
  if v_row.status <> 'draft' then
    raise exception 'only a draft can be submitted' using errcode = '55000', hint = 'not_editable';
  end if;
  if v_row.version <> p_expected_version then
    raise exception 'the draft changed since you opened it' using errcode = '55000', hint = 'version_conflict';
  end if;
  update lending.loan_requests set status = 'submitted' where id = p_id returning submission_reference into v_row.submission_reference;
  perform identity.audit('lending.loan_request.submitted', 'loan_request', p_id::text, jsonb_build_object('reference', v_row.submission_reference));
  return v_row.submission_reference;
end
$$;

create or replace function lending.request_withdraw(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_borrower uuid := identity.require_borrower();
  v_row lending.loan_requests;
begin
  select * into v_row from lending.loan_requests where id = p_id and borrower_id = v_borrower for update;
  if not found then
    raise exception 'request not found' using errcode = 'P0002';
  end if;
  if v_row.status = 'withdrawn' then
    return;
  end if;
  if v_row.status not in ('draft', 'submitted') then
    raise exception 'this request can no longer be withdrawn' using errcode = '55000', hint = 'not_editable';
  end if;
  update lending.loan_requests set status = 'withdrawn' where id = p_id;
  perform identity.audit('lending.loan_request.withdrawn', 'loan_request', p_id::text);
end
$$;

-- Housekeeping: marks drafts past their expiry. Safe to repeat; reads never depend on it.
create or replace function lending.expire_drafts()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  if private.invoking_role() <> 'service_role' then
    raise exception 'system only' using errcode = '42501';
  end if;
  with e as (update lending.loan_requests set status = 'expired' where status = 'draft' and expires_at <= now() returning id)
  select count(*) into v_n from e;
  return v_n;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Step-up verification (D-24). Distinct from login, and from device integrity.
-- ---------------------------------------------------------------------------------------------
create table identity.stepup_challenges (
  id uuid primary key,
  borrower_id uuid not null references identity.borrowers (id) on delete restrict,
  action text not null check (action in ('offer_acceptance', 'esign', 'bank_account_change', 'mandate_creation')),
  -- Opaque id of the object the action is about (an offer, a document, an account). Binds the code to it.
  context_ref text not null check (context_ref ~ '^[A-Za-z0-9_-]{1,64}$'),
  -- HMAC of the code with a server secret; the code itself is never stored.
  code_hash text not null check (code_hash ~ '^[0-9a-f]{64}$'),
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  status text not null default 'pending' check (status in ('pending', 'verified', 'consumed', 'expired', 'locked')),
  delivery_status text not null default 'pending' check (delivery_status in ('pending', 'accepted', 'rejected', 'timeout', 'not_configured')),
  provider_ref text check (provider_ref is null or length(provider_ref) <= 100),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  verified_at timestamptz,
  verified_until timestamptz,
  consumed_at timestamptz
);
create index stepup_challenges_borrower on identity.stepup_challenges (borrower_id, action, created_at desc);
comment on table identity.stepup_challenges is
  'One-time step-up codes bound to a borrower, an action and a context object. Hash only; attempt-limited; single use. Owner: identity module.';

create or replace function identity.stepup_start(p_id uuid, p_action text, p_context_ref text, p_code_hash text)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_borrower uuid := identity.require_borrower();
  v_recent integer;
  v_exp timestamptz := now() + interval '5 minutes';
begin
  perform pg_advisory_xact_lock(hashtextextended('stepup:' || v_borrower::text, 0));
  select count(*) into v_recent from identity.stepup_challenges
  where borrower_id = v_borrower and created_at > now() - interval '15 minutes';
  if v_recent >= 5 then
    raise exception 'too many verification codes requested' using errcode = '55000', hint = 'rate_limited';
  end if;
  update identity.stepup_challenges set status = 'expired'
  where borrower_id = v_borrower and action = p_action and context_ref = p_context_ref and status = 'pending';
  insert into identity.stepup_challenges (id, borrower_id, action, context_ref, code_hash, expires_at)
  values (p_id, v_borrower, p_action, p_context_ref, p_code_hash, v_exp);
  perform identity.audit('identity.stepup.started', 'stepup_challenge', p_id::text, jsonb_build_object('action', p_action));
  return v_exp;
end
$$;

create or replace function identity.stepup_record_delivery(p_id uuid, p_status text, p_provider_ref text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_borrower uuid := identity.require_borrower();
begin
  update identity.stepup_challenges set delivery_status = p_status, provider_ref = left(p_provider_ref, 100)
  where id = p_id and borrower_id = v_borrower and status = 'pending';
  perform identity.audit('identity.stepup.delivery', 'stepup_challenge', p_id::text, jsonb_build_object('delivery_status', p_status));
end
$$;

create or replace function identity.stepup_verify(p_id uuid, p_code_hash text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_borrower uuid := identity.require_borrower();
  v_row identity.stepup_challenges;
begin
  select * into v_row from identity.stepup_challenges where id = p_id and borrower_id = v_borrower for update;
  if not found then
    return 'not_found';
  end if;
  if v_row.status <> 'pending' then
    return case v_row.status when 'locked' then 'locked' when 'verified' then 'already_verified' else 'expired' end;
  end if;
  if v_row.expires_at <= now() then
    update identity.stepup_challenges set status = 'expired' where id = p_id;
    return 'expired';
  end if;
  if v_row.code_hash = p_code_hash then
    update identity.stepup_challenges set status = 'verified', verified_at = now(), verified_until = now() + interval '10 minutes', attempts = attempts + 1
    where id = p_id;
    perform identity.audit('identity.stepup.verified', 'stepup_challenge', p_id::text, jsonb_build_object('action', v_row.action));
    return 'verified';
  end if;
  update identity.stepup_challenges set attempts = attempts + 1, status = case when attempts + 1 >= max_attempts then 'locked' else status end where id = p_id;
  perform identity.audit('identity.stepup.failed', 'stepup_challenge', p_id::text, jsonb_build_object('action', v_row.action));
  return case when v_row.attempts + 1 >= v_row.max_attempts then 'locked' else 'invalid' end;
end
$$;

-- Called by the code that performs the sensitive action, in the same transaction: succeeds once per
-- verified challenge for exactly this action and context, then the challenge is spent.
create or replace function identity.stepup_consume(p_action text, p_context_ref text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_borrower uuid := identity.require_borrower();
  v_id uuid;
begin
  update identity.stepup_challenges set status = 'consumed', consumed_at = now()
  where id = (select c.id from identity.stepup_challenges c
              where c.borrower_id = v_borrower and c.action = p_action and c.context_ref = p_context_ref
                and c.status = 'verified' and c.verified_until > now()
              order by c.verified_at desc limit 1 for update skip locked)
  returning id into v_id;
  if v_id is null then
    raise exception 'step-up verification required' using errcode = '42501', hint = 'stepup_required';
  end if;
  perform identity.audit('identity.stepup.consumed', 'stepup_challenge', v_id::text, jsonb_build_object('action', p_action));
  return v_id;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Device integrity (level only; the verdict is checked by the server, never trusted from the client)
-- ---------------------------------------------------------------------------------------------
create table identity.integrity_nonces (
  nonce_hash text primary key check (nonce_hash ~ '^[0-9a-f]{64}$'),
  borrower_id uuid not null references identity.borrowers (id) on delete restrict,
  expires_at timestamptz not null,
  used_at timestamptz
);
create table identity.device_attestations (
  id uuid primary key default private.uuid_v7(),
  borrower_id uuid not null references identity.borrowers (id) on delete restrict,
  level text not null check (level in ('none', 'basic', 'device', 'strong')),
  provider text not null check (provider ~ '^[a-z0-9_]{2,40}$'),
  verified_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index device_attestations_borrower on identity.device_attestations (borrower_id, verified_at desc);
comment on table identity.device_attestations is
  'Coarse integrity level per verification. No tokens, device identifiers or fingerprints. Owner: identity module.';

create or replace function identity.issue_integrity_nonce(p_nonce_hash text)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_borrower uuid := identity.require_borrower();
  v_exp timestamptz := now() + interval '5 minutes';
begin
  insert into identity.integrity_nonces (nonce_hash, borrower_id, expires_at) values (p_nonce_hash, v_borrower, v_exp);
  return v_exp;
end
$$;

create or replace function identity.consume_integrity_nonce(p_nonce_hash text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_borrower uuid := identity.require_borrower();
  v_n integer;
begin
  update identity.integrity_nonces set used_at = now()
  where nonce_hash = p_nonce_hash and borrower_id = v_borrower and used_at is null and expires_at > now();
  get diagnostics v_n = row_count;
  return v_n = 1;
end
$$;

create or replace function identity.record_attestation(p_level text, p_provider text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_borrower uuid := identity.require_borrower();
begin
  insert into identity.device_attestations (borrower_id, level, provider, expires_at) values (v_borrower, p_level, p_provider, now() + interval '24 hours');
  perform identity.audit('identity.integrity.assessed', 'borrower', v_borrower::text, jsonb_build_object('level', p_level, 'provider', p_provider));
end
$$;

create or replace function identity.current_integrity_level()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select a.level from identity.device_attestations a
                   where a.borrower_id = private.my_borrower_id() and a.expires_at > now() order by a.verified_at desc limit 1), 'none')
$$;

-- ---------------------------------------------------------------------------------------------
-- Account deletion and anonymisation (D-25 open: no retention period is applied here)
-- ---------------------------------------------------------------------------------------------
create table identity.deletion_requests (
  id uuid primary key default private.uuid_v7(),
  borrower_id uuid not null references identity.borrowers (id) on delete restrict,
  status text not null default 'requested' check (status in ('requested', 'blocked', 'anonymised', 'cancelled')),
  blocked_reason text check (blocked_reason is null or blocked_reason in ('active_loan_account')),
  requested_at timestamptz not null default now(),
  processed_at timestamptz,
  -- The sign-in identity (phone) lives in the authentication provider. Removing it needs the provider's
  -- admin interface and the D-25 decision; until then it is recorded as pending, not claimed as done.
  auth_identity_removed_at timestamptz,
  updated_at timestamptz not null default now()
);
create unique index deletion_requests_one_open on identity.deletion_requests (borrower_id) where status in ('requested', 'blocked');
comment on table identity.deletion_requests is 'Account closure requests and their honest state. Owner: identity module.';

create or replace function identity.request_deletion()
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_borrower uuid := private.my_borrower_id();
  v_id uuid;
begin
  if v_borrower is null then
    raise exception 'borrower account not available' using errcode = '42501', hint = 'account_closed';
  end if;
  select id into v_id from identity.deletion_requests where borrower_id = v_borrower and status in ('requested', 'blocked');
  if v_id is not null then
    return v_id;
  end if;
  insert into identity.deletion_requests (borrower_id) values (v_borrower) returning id into v_id;
  update identity.borrowers set status = 'closure_requested', onboarding_status = 'deletion_requested' where id = v_borrower;
  perform identity.audit('identity.deletion.requested', 'deletion_request', v_id::text);
  perform ops.enqueue_event('borrower.deletion_requested', jsonb_build_object('deletion_request_id', v_id), null, 'deletion:' || v_id::text);
  return v_id;
end
$$;

create or replace function identity.cancel_deletion()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_borrower uuid := private.my_borrower_id();
begin
  if v_borrower is null then
    raise exception 'borrower account not available' using errcode = '42501', hint = 'account_closed';
  end if;
  update identity.deletion_requests set status = 'cancelled', processed_at = now() where borrower_id = v_borrower and status in ('requested', 'blocked');
  if found then
    update identity.borrowers set status = 'active',
      onboarding_status = case when profile_completed_at is not null then 'profile_completed' else 'profile_started' end
    where id = v_borrower and status = 'closure_requested';
    perform identity.audit('identity.deletion.cancelled', 'borrower', v_borrower::text);
  end if;
end
$$;

-- Worker entry point. Idempotent: a repeat finds the request already processed.
create or replace function identity.process_deletion(p_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_req identity.deletion_requests;
begin
  if private.invoking_role() <> 'service_role' then
    raise exception 'system only' using errcode = '42501';
  end if;
  select * into v_req from identity.deletion_requests where id = p_id for update;
  if not found then
    raise exception 'deletion request not found' using errcode = 'P0002';
  end if;
  if v_req.status in ('anonymised', 'cancelled') then
    return v_req.status;
  end if;
  if exists (select 1 from servicing.loan_accounts l where l.borrower_id = v_req.borrower_id and l.status = 'active') then
    update identity.deletion_requests set status = 'blocked', blocked_reason = 'active_loan_account', processed_at = now() where id = p_id;
    insert into audit.events (actor_type, action, entity_type, entity_id) values ('system', 'identity.deletion.blocked', 'deletion_request', p_id::text);
    return 'blocked';
  end if;
  -- Anonymise the profile. Consent records and audit events are retained as they are (no period applied).
  update identity.borrowers set display_name = null, status = 'closed', onboarding_status = 'anonymised', anonymised_at = now(), preferred_language = 'en'
  where id = v_req.borrower_id;
  delete from identity.communication_preferences where borrower_id = v_req.borrower_id;
  delete from identity.stepup_challenges where borrower_id = v_req.borrower_id;
  delete from identity.device_attestations where borrower_id = v_req.borrower_id;
  delete from identity.integrity_nonces where borrower_id = v_req.borrower_id;
  update lending.loan_requests set status = 'withdrawn' where borrower_id = v_req.borrower_id and status = 'draft';
  update identity.deletion_requests set status = 'anonymised', blocked_reason = null, processed_at = now() where id = p_id;
  insert into audit.events (actor_type, action, entity_type, entity_id) values ('system', 'identity.deletion.anonymised', 'deletion_request', p_id::text);
  return 'anonymised';
end
$$;

-- ---------------------------------------------------------------------------------------------
-- Row-level security and grants
-- ---------------------------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['identity.communication_preferences', 'identity.stepup_challenges', 'identity.integrity_nonces',
                           'identity.device_attestations', 'identity.deletion_requests', 'lending.loan_purposes', 'lending.loan_request_events']
  loop
    execute format('alter table %s enable row level security', t);
    execute format('alter table %s force row level security', t);
  end loop;
end
$$;
create policy prefs_read on identity.communication_preferences for select to authenticated using (borrower_id = (select private.my_borrower_id()));
create policy deletion_read on identity.deletion_requests for select to authenticated using (borrower_id = (select private.my_borrower_id()));
create policy purposes_read on lending.loan_purposes for select to authenticated using (true);
create policy request_events_read on lending.loan_request_events for select to authenticated using (borrower_id = (select private.my_borrower_id()));
create policy request_events_platform_read on lending.loan_request_events for select to authenticated using ((select private.has_platform_permission('application.read')));
grant select on identity.communication_preferences, identity.deletion_requests, lending.loan_purposes, lending.loan_request_events, lending.my_loan_requests to authenticated;

-- Functions: borrower-callable ones need EXECUTE; the system ones only service_role.
do $$
declare
  f text;
begin
  foreach f in array array[
    'identity.update_profile(text, boolean, text)', 'identity.complete_profile()', 'identity.set_communication_preferences(boolean)',
    'identity.my_phone()', 'consent.record_decision(uuid, consent.decision, text, text)',
    'lending.request_create(text, bigint, integer, text, uuid)', 'lending.request_update(uuid, integer, bigint, integer, text, uuid, boolean)',
    'lending.request_submit(uuid, integer)', 'lending.request_withdraw(uuid)',
    'identity.stepup_start(uuid, text, text, text)', 'identity.stepup_record_delivery(uuid, text, text)',
    'identity.stepup_verify(uuid, text)', 'identity.stepup_consume(text, text)',
    'identity.issue_integrity_nonce(text)', 'identity.consume_integrity_nonce(text)', 'identity.record_attestation(text, text)',
    'identity.current_integrity_level()', 'identity.request_deletion()', 'identity.cancel_deletion()']
  loop
    execute format('revoke all on function %s from public', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  foreach f in array array['lending.expire_drafts()', 'identity.process_deletion(uuid)']
  loop
    execute format('revoke all on function %s from public', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end
$$;

grant execute on function lending.draft_lifetime() to authenticated, service_role;

-- The review status of published wording is part of what was published: it cannot change afterwards.
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
        new.data_categories, new.retention_summary, new.published_at, new.approved_by, new.drafted_by, new.review_status)
       is distinct from
       (old.purpose, old.version, old.language, old.lender_org_id, old.title, old.body_markdown,
        old.data_categories, old.retention_summary, old.published_at, old.approved_by, old.drafted_by, old.review_status) then
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
