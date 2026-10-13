-- =============================================================================================
-- Hardening after the baseline security review (independent reviewers reproduced each gap below
-- with SQL against migrations 0100-0500; see docs/security/threat-model.md, gap register).
--
--  A. History cannot be erased with TRUNCATE.
--  B. "System" means a trusted backend role; platform staff are not "lender"; unknown is "none".
--  C. Separate logins: borrower vs staff, and platform staff vs lender staff (segregation of duties).
--  D. Consent: server-set capture time; lender-specific wording binds that lender; notices need a
--     drafter and a different approver.
--  E. Product versions: drafter and approver must belong to the lender; terms are frozen while
--     pending approval and cannot change in the approving statement; no backdating.
--  F. Borrower and tenant keys are consistent along request -> application -> loan -> payment.
--  G. Offers stay within the approved product terms; acceptance is tied to the application.
--  H. Payments: only the system creates payment instructions; success needs a verified event.
--  I. Audit: unambiguous row hashing; callers can only write events in their own scope.
--  J. Disbursement evidence is unique and immutable once recorded.
--  K. Requests and products respect platform category availability and tenure floors.
-- =============================================================================================

-- A. TRUNCATE -----------------------------------------------------------------------------------
do $$
declare
  s text;
begin
  foreach s in array array['tenancy', 'identity', 'consent', 'audit', 'lending', 'servicing', 'payments']
  loop
    execute format('revoke truncate on all tables in schema %I from service_role, authenticated, anon', s);
    execute format('alter default privileges in schema %I revoke truncate on tables from service_role', s);
  end loop;
end
$$;

create or replace function private.forbid_truncate()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'TRUNCATE on %.% is not allowed: table is append-only', tg_table_schema, tg_table_name
    using errcode = 'P0001';
end
$$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'audit.events', 'audit.anchors', 'consent.records', 'consent.notices', 'lending.application_events',
    'lending.offers', 'servicing.schedule_snapshots', 'servicing.schedule_installments',
    'payments.payment_intents', 'payments.provider_events'
  ]
  loop
    execute format('create trigger no_truncate before truncate on %s for each statement execute function private.forbid_truncate()', t);
  end loop;
end
$$;

-- B. Actor detection ----------------------------------------------------------------------------
-- The caller's effective database role, also inside SECURITY DEFINER functions (where current_user
-- is the function owner): the SET ROLE value, or the login role when none was set.
create or replace function private.invoking_role()
returns text
language sql
stable
set search_path = ''
as $$
  select coalesce(nullif(current_setting('role', true), 'none'), session_user::text)
$$;
grant execute on function private.invoking_role() to authenticated, service_role;

-- Roles that run trusted backend work. Anything else — including an application login role that
-- forgot to SET ROLE — is treated as an end user, and without valid claims as nobody (fail closed).
create or replace function private.is_system_role()
returns boolean
language sql
stable
set search_path = ''
as $$
  select private.invoking_role() in ('service_role', 'postgres', 'supabase_admin')
$$;
grant execute on function private.is_system_role() to authenticated, service_role;

-- borrower | lender (staff of a lender or service partner) | platform (Udofin staff) | system | none
create or replace function private.current_actor()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when private.is_system_role() then 'system'
    when (select auth.uid()) is null then 'none'
    when exists (select 1 from identity.borrowers b where b.user_id = (select auth.uid())) then 'borrower'
    when exists (
      select 1 from tenancy.memberships m join tenancy.organizations o on o.id = m.org_id
      where m.user_id = (select auth.uid()) and m.status = 'active'
        and (m.valid_until is null or m.valid_until > now()) and o.kind <> 'platform'
    ) then 'lender'
    when exists (
      select 1 from tenancy.memberships m join tenancy.organizations o on o.id = m.org_id
      where m.user_id = (select auth.uid()) and m.status = 'active'
        and (m.valid_until is null or m.valid_until > now()) and o.kind = 'platform'
    ) then 'platform'
    else 'none'
  end
$$;

-- Platform-wide read permissions no longer reach offboarded organisations.
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
  where o.status <> 'offboarded'
    and exists (select 1 from my_grants g where g.kind = 'platform' and g.platform_grantable)
$$;

-- Whether a given user (not necessarily the caller) holds `permission` in `org` through an active
-- membership. Used where a recorded person must be entitled, whoever writes the row.
create or replace function private.user_has_permission_in_org(p_user uuid, p_org uuid, permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from tenancy.memberships m
    join tenancy.organizations o on o.id = m.org_id and o.status in ('onboarding', 'active')
    join tenancy.membership_roles mr on mr.membership_id = m.id
    join tenancy.role_permissions rp on rp.role_id = mr.role_id
    where m.user_id = p_user and m.org_id = p_org and m.status = 'active'
      and (m.valid_until is null or m.valid_until > now())
      and rp.permission_key = permission
  )
$$;
revoke all on function private.user_has_permission_in_org(uuid, uuid, text) from public;
grant execute on function private.user_has_permission_in_org(uuid, uuid, text) to authenticated, service_role;

-- C. Separate logins ----------------------------------------------------------------------------
create or replace function private.enforce_login_separation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kind tenancy.organization_kind;
begin
  if tg_table_schema = 'identity' then
    if exists (select 1 from tenancy.memberships m where m.user_id = new.user_id) then
      raise exception 'a staff login cannot become a borrower; use a separate borrower account' using errcode = '23514';
    end if;
    return new;
  end if;

  if exists (select 1 from identity.borrowers b where b.user_id = new.user_id) then
    raise exception 'a borrower login cannot be made a staff member; use a separate staff account' using errcode = '23514';
  end if;
  select o.kind into v_kind from tenancy.organizations o where o.id = new.org_id;
  if exists (
    select 1 from tenancy.memberships m join tenancy.organizations o on o.id = m.org_id
    where m.user_id = new.user_id and m.id <> new.id and m.status <> 'revoked'
      and ((v_kind = 'platform') <> (o.kind = 'platform'))
  ) then
    raise exception 'segregation of duties: one login cannot be both Udofin platform staff and lender staff'
      using errcode = '23514';
  end if;
  return new;
end
$$;
revoke all on function private.enforce_login_separation() from public;

create trigger memberships_login_separation before insert or update of user_id, org_id, status on tenancy.memberships
  for each row execute function private.enforce_login_separation();
create trigger borrowers_login_separation before insert or update of user_id on identity.borrowers
  for each row execute function private.enforce_login_separation();

-- D. Consent ------------------------------------------------------------------------------------
alter table consent.notices add column drafted_by uuid references auth.users (id);
alter table consent.notices add constraint notice_maker_checker
  check (status = 'draft' or (drafted_by is not null and approved_by is distinct from drafted_by));

-- Published notices are immutable, now including who drafted them.
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
        new.data_categories, new.retention_summary, new.published_at, new.approved_by, new.drafted_by)
       is distinct from
       (old.purpose, old.version, old.language, old.lender_org_id, old.title, old.body_markdown,
        old.data_categories, old.retention_summary, old.published_at, old.approved_by, old.drafted_by) then
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

create or replace function private.check_consent_lender_is_lender()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.lender_org_id is not null and not exists (
    select 1 from tenancy.organizations o where o.id = new.lender_org_id and o.kind = 'lender'
  ) then
    raise exception 'lender_org_id must reference a lender organisation' using errcode = '23514';
  end if;
  return new;
end
$$;
revoke all on function private.check_consent_lender_is_lender() from public;
create trigger notices_lender_kind before insert or update of lender_org_id on consent.notices
  for each row execute function private.check_consent_lender_is_lender();

create or replace function private.check_consent_notice_published()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_notice consent.notices;
begin
  -- The server's clock, never the caller's, decides when consent was captured.
  new.captured_at := now();
  select n.* into v_notice from consent.notices n where n.id = new.notice_id;
  if v_notice.id is null or v_notice.status <> 'published' then
    raise exception 'consent must reference a published notice' using errcode = '23514';
  end if;
  if v_notice.lender_org_id is not null and new.lender_org_id is distinct from v_notice.lender_org_id then
    raise exception 'a lender-specific notice can only authorise that lender' using errcode = '23514';
  end if;
  if new.lender_org_id is not null and not exists (
    select 1 from tenancy.organizations o where o.id = new.lender_org_id and o.kind = 'lender'
  ) then
    raise exception 'lender_org_id must reference a lender organisation' using errcode = '23514';
  end if;
  return new;
end
$$;

-- E. Product versions ---------------------------------------------------------------------------
create or replace function private.protect_product_version()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_category lending.product_categories;
  v_actor text := private.current_actor();
  v_uid uuid := (select auth.uid());
  v_non_terms text[] := array['status', 'approved_by', 'approved_at', 'effective_from'];
begin
  select c.* into v_category
  from lending.loan_products p join lending.product_categories c on c.key = p.category_key
  where p.id = new.product_id;

  if new.min_tenure_days < v_category.min_tenure_days then
    raise exception 'min tenure % days is below the platform floor of % days for category %',
      new.min_tenure_days, v_category.min_tenure_days, v_category.key using errcode = '23514';
  end if;

  if tg_op = 'INSERT' then
    if not private.user_has_permission_in_org(new.drafted_by, new.lender_org_id, 'product.configure') then
      raise exception 'the drafter must hold product.configure in this lender' using errcode = '23514';
    end if;
  else
    if (new.product_id, new.lender_org_id, new.version, new.drafted_by, new.created_at)
       is distinct from (old.product_id, old.lender_org_id, old.version, old.drafted_by, old.created_at) then
      raise exception 'product version identity and drafter cannot change' using errcode = 'P0001';
    end if;
    if old.status in ('approved', 'retired') then
      if not (old.status = 'approved' and new.status = 'retired')
         or (to_jsonb(new) - 'status') is distinct from (to_jsonb(old) - 'status') then
        raise exception 'approved product versions are immutable; create a new version' using errcode = 'P0001';
      end if;
      return new;
    end if;
    if new.status is distinct from old.status and not (
      (old.status = 'draft' and new.status = 'pending_approval')
      or (old.status = 'pending_approval' and new.status in ('draft', 'approved'))
    ) then
      raise exception 'product version transition % -> % is not allowed', old.status, new.status using errcode = 'P0001';
    end if;
    if old.status = 'pending_approval'
       and (to_jsonb(new) - v_non_terms) is distinct from (to_jsonb(old) - v_non_terms) then
      raise exception 'terms are frozen while a version is pending approval; return it to draft to edit'
        using errcode = 'P0001';
    end if;
  end if;

  if new.status = 'approved' and (tg_op = 'INSERT' or old.status <> 'approved') then
    if v_category.availability <> 'enabled' then
      raise exception 'category % is not enabled on the platform (%)', v_category.key, v_category.availability
        using errcode = '23514';
    end if;
    if new.approved_by is null or not private.user_has_permission_in_org(new.approved_by, new.lender_org_id, 'product.approve') then
      raise exception 'the approver must hold product.approve in this lender' using errcode = '23514';
    end if;
    if v_actor <> 'system' then
      if new.approved_by is distinct from v_uid then
        raise exception 'approval must be recorded by the approving user' using errcode = '42501';
      end if;
      new.approved_at := now();
    end if;
    if new.effective_from is null or new.effective_from < new.approved_at then
      raise exception 'effective_from cannot be earlier than the approval time' using errcode = '23514';
    end if;
  end if;
  return new;
end
$$;

create or replace function private.check_product_category()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (select 1 from lending.product_categories c where c.key = new.category_key and c.availability = 'not_supported') then
    raise exception 'category % is not supported on the platform', new.category_key using errcode = '23514';
  end if;
  return new;
end
$$;
create trigger loan_products_category before insert or update of category_key on lending.loan_products
  for each row execute function private.check_product_category();

-- K. Loan requests respect category availability and the tenure floor.
create or replace function private.check_loan_request_category()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_category lending.product_categories;
begin
  select c.* into v_category from lending.product_categories c where c.key = new.category_key;
  if v_category.availability <> 'enabled' then
    raise exception 'category % is not available to borrowers (%)', new.category_key, v_category.availability
      using errcode = '23514';
  end if;
  if new.requested_tenure_days < v_category.min_tenure_days then
    raise exception 'requested tenure is below the % day minimum for %', v_category.min_tenure_days, new.category_key
      using errcode = '23514';
  end if;
  return new;
end
$$;
create trigger loan_requests_category before insert or update of category_key, requested_tenure_days on lending.loan_requests
  for each row execute function private.check_loan_request_category();

-- F. Consistent borrower and tenant keys ---------------------------------------------------------
alter table lending.loan_requests add constraint loan_requests_id_borrower unique (id, borrower_id);
alter table lending.applications
  add constraint applications_request_borrower_fk foreign key (loan_request_id, borrower_id)
    references lending.loan_requests (id, borrower_id) on delete restrict,
  add constraint applications_id_lender_borrower unique (id, lender_org_id, borrower_id);
alter table servicing.loan_accounts
  add constraint loan_accounts_application_borrower_fk foreign key (application_id, lender_org_id, borrower_id)
    references lending.applications (id, lender_org_id, borrower_id) on delete restrict,
  add constraint loan_accounts_id_lender_borrower unique (id, lender_org_id, borrower_id);
alter table payments.payment_intents
  add constraint payment_intents_loan_borrower_fk foreign key (loan_account_id, lender_org_id, borrower_id)
    references servicing.loan_accounts (id, lender_org_id, borrower_id) on delete restrict;
alter table payments.provider_events
  add constraint provider_events_intent_tenant check (payment_intent_id is null or lender_org_id is not null),
  add constraint provider_events_intent_tenant_fk foreign key (payment_intent_id, lender_org_id)
    references payments.payment_intents (id, lender_org_id) on delete restrict;

-- G. Offers and acceptance ----------------------------------------------------------------------
create or replace function private.validate_offer()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status lending.application_status;
  v_version_id uuid;
  v_version lending.loan_product_versions;
  v_floor integer;
begin
  select a.status, a.product_version_id into v_status, v_version_id
  from lending.applications a
  where a.id = new.application_id and a.lender_org_id = new.lender_org_id;
  if not found then
    return new;  -- cross-tenant or missing application: the composite foreign key rejects it
  end if;
  select v.* into v_version from lending.loan_product_versions v where v.id = v_version_id;

  if v_status not in ('under_review', 'info_requested', 'approved') then
    raise exception 'offers can only be issued while the lender is reviewing or has approved (status %)', v_status
      using errcode = 'P0001';
  end if;
  select c.min_tenure_days into v_floor
  from lending.loan_products p join lending.product_categories c on c.key = p.category_key
  where p.id = v_version.product_id;
  if new.principal_minor not between v_version.min_amount_minor and v_version.max_amount_minor
     or new.tenure_days not between greatest(v_version.min_tenure_days, v_floor) and v_version.max_tenure_days
     or new.annual_interest_rate_bps not between v_version.min_annual_rate_bps and v_version.max_annual_rate_bps then
    raise exception 'offer terms fall outside the approved product version' using errcode = '23514';
  end if;
  if new.status <> 'issued' or new.valid_until <= now() then
    raise exception 'new offers must be issued with a validity in the future' using errcode = '23514';
  end if;
  if private.current_actor() <> 'system' then
    new.created_by := (select auth.uid());
    new.issued_at := now();
  end if;
  return new;
end
$$;
revoke all on function private.validate_offer() from public;
create trigger offers_validate before insert on lending.offers
  for each row execute function private.validate_offer();

create or replace function private.protect_offer()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor text := private.current_actor();
  v_request uuid;
begin
  if (to_jsonb(new) - array['status', 'responded_at']) is distinct from (to_jsonb(old) - array['status', 'responded_at']) then
    raise exception 'offer terms are immutable once issued; withdraw and issue a new offer' using errcode = 'P0001';
  end if;
  if new.status is not distinct from old.status then
    return new;
  end if;
  if old.status <> 'issued' then
    raise exception 'offer status % is final', old.status using errcode = 'P0001';
  end if;

  -- Only the borrower responds to an offer; the lender can only withdraw it; expiry is the system's.
  if new.status in ('accepted', 'declined') and v_actor <> 'borrower' then
    raise exception 'only the borrower can % an offer', case new.status when 'accepted' then 'accept' else 'decline' end
      using errcode = '42501';
  end if;
  if new.status = 'withdrawn' and v_actor not in ('lender', 'system') then
    raise exception 'only the lender can withdraw an offer' using errcode = '42501';
  end if;
  if new.status = 'expired' and v_actor <> 'system' then
    raise exception 'only the system can expire an offer' using errcode = '42501';
  end if;

  if new.status = 'accepted' then
    if new.valid_until < now() then
      raise exception 'offer has expired' using errcode = 'P0001';
    end if;
    if not exists (select 1 from lending.applications a where a.id = new.application_id and a.status = 'approved') then
      raise exception 'an offer can only be accepted on an approved application' using errcode = 'P0001';
    end if;
    select a.loan_request_id into v_request from lending.applications a where a.id = new.application_id;
    -- Serialise concurrent acceptances for the same loan request, then allow at most one.
    perform pg_advisory_xact_lock(hashtextextended(v_request::text, 0));
    if exists (
      select 1 from lending.offers o join lending.applications a on a.id = o.application_id
      where a.loan_request_id = v_request and o.status = 'accepted' and o.id <> new.id
    ) then
      raise exception 'another lender''s offer has already been accepted for this loan request' using errcode = 'P0001';
    end if;
  end if;
  new.responded_at := now();
  return new;
end
$$;
revoke all on function private.protect_offer() from public;

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
  if new.status is not distinct from old.status then
    return new;
  end if;

  select t.allowed_actors into v_allowed
  from lending.application_transitions t
  where t.from_status = old.status and t.to_status = new.status;
  if v_allowed is null then
    raise exception 'application transition % -> % is not allowed', old.status, new.status using errcode = 'P0001';
  end if;
  if not (v_actor = any (v_allowed)) then
    raise exception 'actor % may not move an application % -> %', v_actor, old.status, new.status using errcode = '42501';
  end if;
  if new.status = 'offer_accepted' and not exists (
    select 1 from lending.offers o where o.application_id = new.id and o.lender_org_id = new.lender_org_id and o.status = 'accepted'
  ) then
    raise exception 'accept the lender''s offer before accepting the application' using errcode = 'P0001';
  end if;
  if new.status = 'submitted' then new.submitted_at := coalesce(new.submitted_at, now()); end if;
  if new.status in ('approved', 'rejected') then new.decided_at := coalesce(new.decided_at, now()); end if;

  insert into lending.application_events (application_id, lender_org_id, from_status, to_status, actor, actor_user_id, reason)
  values (new.id, new.lender_org_id, old.status, new.status, v_actor, (select auth.uid()), v_reason);
  return new;
end
$$;
revoke all on function private.enforce_application_lifecycle() from public;

-- H. Payments -----------------------------------------------------------------------------------
-- Payment instructions are created by the system after the API resolves the lender's configured
-- collection account and provider; borrowers can no longer insert them directly.
drop policy intents_borrower_insert on payments.payment_intents;
revoke insert on payments.payment_intents from authenticated;

create or replace function private.protect_payment_intent()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_actor text := private.current_actor();
begin
  if tg_op = 'INSERT' then
    if new.status <> 'created' then
      raise exception 'payment intents must start as created' using errcode = '23514';
    end if;
    if not exists (
      select 1 from servicing.loan_accounts la
      where la.id = new.loan_account_id and la.borrower_id = new.borrower_id and la.status = 'active'
    ) then
      raise exception 'payment intent must belong to the borrower''s active loan' using errcode = '23514';
    end if;
    return new;
  end if;

  if (to_jsonb(new) - array['status', 'provider_order_ref', 'updated_at'])
     is distinct from (to_jsonb(old) - array['status', 'provider_order_ref', 'updated_at']) then
    raise exception 'payment intent amount, account and parties are immutable' using errcode = 'P0001';
  end if;
  if old.provider_order_ref is not null and new.provider_order_ref is distinct from old.provider_order_ref then
    raise exception 'provider order reference cannot change once set' using errcode = 'P0001';
  end if;
  if new.status is distinct from old.status then
    if not (
      (old.status = 'created' and new.status in ('pending', 'failed', 'expired', 'cancelled'))
      or (old.status = 'pending' and new.status in ('succeeded', 'failed', 'expired'))
    ) then
      raise exception 'payment intent transition % -> % is not allowed', old.status, new.status using errcode = 'P0001';
    end if;
    if v_actor <> 'system' and not (old.status = 'created' and new.status = 'cancelled') then
      raise exception 'only the system may move a payment intent to %', new.status using errcode = '42501';
    end if;
    if new.status = 'succeeded' and not exists (
      select 1 from payments.provider_events pe
      where pe.payment_intent_id = new.id and pe.lender_org_id = new.lender_org_id and pe.signature_verified
    ) then
      raise exception 'a payment can be marked succeeded only after a signature-verified provider event'
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end
$$;

-- I. Audit --------------------------------------------------------------------------------------
-- Canonical JSON array: NULLs are kept as null and every value is quoted, so no two different rows
-- can serialise to the same string (concat_ws skipped NULLs and did not escape its separator).
create or replace function private.audit_row_hash(e audit.events)
returns text
language sql
stable
set search_path = ''
as $$
  select encode(sha256(convert_to(jsonb_build_array(
    'v2', e.id, to_char(e.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'), e.actor_type,
    e.actor_user_id, e.actor_org_id, e.tenant_org_id, e.action, e.entity_type, e.entity_id, e.outcome,
    e.request_id, e.correlation_id, e.metadata)::text, 'UTF8')), 'hex')
$$;

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
  values (case when v_actor = 'borrower' then 'borrower' else 'staff' end::audit.actor_type, v_user, v_actor_org,
          p_tenant_org_id, p_action, p_entity_type, p_entity_id, p_outcome, p_request_id, p_correlation_id,
          coalesce(p_metadata, '{}'::jsonb))
  returning id into v_id;
  return v_id;
end
$$;

-- J. Disbursement evidence ----------------------------------------------------------------------
create unique index loan_accounts_disbursement_reference
  on servicing.loan_accounts (lender_org_id, disbursement_reference) where disbursement_reference is not null;

create or replace function private.protect_loan_account()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.lender_org_id, new.application_id, new.borrower_id, new.lms_loan_ref, new.source_system)
     is distinct from (old.lender_org_id, old.application_id, old.borrower_id, old.lms_loan_ref, old.source_system) then
    raise exception 'loan account identity cannot change' using errcode = 'P0001';
  end if;
  if old.disbursed_at is not null
     and (new.disbursed_at, new.disbursed_amount_minor, new.disbursement_reference)
         is distinct from (old.disbursed_at, old.disbursed_amount_minor, old.disbursement_reference) then
    raise exception 'recorded disbursement evidence cannot be changed' using errcode = 'P0001';
  end if;
  return new;
end
$$;
create trigger loan_accounts_protect before update on servicing.loan_accounts
  for each row execute function private.protect_loan_account();

-- J (continued). A loan account is never deleted; its disbursement evidence is permanent.
create trigger loan_accounts_no_delete before delete on servicing.loan_accounts
  for each row execute function private.forbid_mutation();

-- L. Lender-specific consent wording is visible to the borrower and that lender only ------------------
drop policy notices_read_published on consent.notices;
create policy notices_read_published on consent.notices for select to authenticated
  using (
    (select private.has_platform_permission('platform.consent_notices.manage'))
    or (
      status <> 'draft'
      and (
        lender_org_id is null
        or lender_org_id in (select private.my_org_ids())
        or (select private.my_borrower_id()) is not null
      )
    )
  );

-- M. GraphQL is not part of Udofin's access model ---------------------------------------------------
-- All client access goes through the Udofin API. pg_graphql would reflect any table a role can read
-- into an additional query surface, so it is removed where present (Supabase-hosted databases).
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_graphql') then
    drop extension pg_graphql cascade;
  end if;
exception when others then
  raise warning 'could not drop pg_graphql (%): disable it in the Supabase dashboard (Database > Extensions)', sqlerrm;
end
$$;
