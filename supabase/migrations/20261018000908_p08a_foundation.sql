-- =============================================================================================
-- Phase 08a foundation (spec: docs/specs/08-servicing-payments-mandates-collections.md, sections 5, 15, 20).
--
--   1. Activation switches, fail closed. servicing.feature_catalog says which features can ever be switched on in
--      Phase 08a; servicing.lender_features holds the per-lender state (absent row = off); changes go through a
--      two-person flow (servicing.feature_change_requests) modelled on onboarding.gate_requests, with a single-person
--      emergency kill switch that can only turn a feature OFF. Collections and DLG are in the catalogue as NOT
--      enableable: the database refuses `enabled = true` for them whoever asks; only a later, owner-approved migration
--      that changes the catalogue can lift it.
--   2. Mock/sandbox provider guard (udofin.allow_mock_providers / udofin.allow_sandbox_providers) and the provider-mode
--      vocabulary that every later Phase 08a table reuses. A mock or sandbox record can never satisfy a production gate.
--   3. Permissions, roles and two separation-of-duties rules (payment.configure vs payment.config.approve;
--      platform.accounts.registry.manage vs platform.accounts.registry.verify).
--   4. private.parse_money_minor: the one strict decimal-rupees-to-paise parser in SQL.
--
-- Forward-only. Seeds NO lender switch (every feature is off by absence). No new enum values (text and checks only).
-- Error codes follow the repository convention: 42501 not authorised, P0002 not found, 22023 bad input,
-- 55000 rule/state, 23505 duplicate, 23514 segregation of duties.
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- 3. Permissions and roles (first, so the functions below can refer to platform.features.manage)
-- ---------------------------------------------------------------------------------------------
insert into tenancy.permissions (key, description, platform_grantable, platform_only) values
  ('payment.configure', 'Draft the lender payment configuration (provider, merchant, settlement account reference)', false, false),
  ('payment.config.approve', 'Approve a payment configuration drafted by someone else (maker-checker)', false, false),
  ('payment.reconcile', 'Work reconciliation exceptions: acknowledge, assign and resolve with a note', false, false),
  ('servicing.sync.manage', 'Configure the LMS connection and run or review servicing syncs and imports', false, false),
  ('servicing.manual_entry', 'Enter or import loan-account reports from the lender''s own system by hand or file', false, false),
  ('servicing.document.issue', 'Issue or upload lender-issued statements, quotes, no-dues letters and closure documents', false, false),
  ('reminder.policy.manage', 'Draft the reminder policy and penal-charge text of the lender', false, false),
  ('reminder.template.approve', 'Approve reminder templates and the policy drafted by someone else', false, false),
  ('platform.payments.providers.manage', 'Maintain the register of payment, mandate and LMS providers and their authorisation evidence', false, true),
  ('platform.accounts.registry.manage', 'Register lender settlement-account fingerprints and the Udofin and group own-account list', false, true),
  ('platform.accounts.registry.verify', 'Verify an account registration made by someone else (maker-checker)', false, true),
  ('platform.features.manage', 'Request and decide per-lender activation switches and use the emergency kill switch', false, true);

insert into tenancy.roles (org_id, applies_to, key, name, description) values
  (null, 'lender', 'servicing_operator', 'Servicing operator', 'Runs LMS imports and issues lender documents for loans'),
  (null, 'lender', 'payments_admin', 'Payments administrator', 'Drafts the payment configuration (cannot approve it)'),
  (null, 'lender', 'payments_approver', 'Payments approver', 'Approves a payment configuration drafted by someone else (cannot draft it)'),
  (null, 'lender', 'reconciler', 'Reconciler', 'Works the reconciliation exception queue'),
  (null, 'lender', 'communications_admin', 'Communications administrator', 'Drafts the reminder policy and penal-charge text'),
  (null, 'lender', 'communications_approver', 'Communications approver', 'Approves reminder templates and policy drafted by someone else'),
  (null, 'platform', 'platform_payments_admin', 'Platform payments administrator', 'Maintains the provider register and registers account fingerprints'),
  (null, 'platform', 'platform_account_verifier', 'Platform account verifier', 'Verifies account registrations made by someone else'),
  (null, 'platform', 'platform_features_admin', 'Platform features administrator', 'Requests and decides per-lender activation switches');

insert into tenancy.role_permissions (role_id, permission_key)
select r.id, g.permission_key
from tenancy.roles r
join (values
  ('lender', 'servicing_operator', 'loan.read'),
  ('lender', 'servicing_operator', 'servicing.sync.manage'),
  ('lender', 'servicing_operator', 'servicing.manual_entry'),
  ('lender', 'servicing_operator', 'servicing.document.issue'),
  ('lender', 'payments_admin', 'payment.read'),
  ('lender', 'payments_admin', 'payment.configure'),
  ('lender', 'payments_approver', 'payment.read'),
  ('lender', 'payments_approver', 'payment.config.approve'),
  ('lender', 'reconciler', 'payment.read'),
  ('lender', 'reconciler', 'payment.reconcile'),
  ('lender', 'communications_admin', 'loan.read'),
  ('lender', 'communications_admin', 'reminder.policy.manage'),
  ('lender', 'communications_approver', 'loan.read'),
  ('lender', 'communications_approver', 'reminder.template.approve'),
  ('platform', 'platform_payments_admin', 'platform.payments.providers.manage'),
  ('platform', 'platform_payments_admin', 'platform.accounts.registry.manage'),
  ('platform', 'platform_account_verifier', 'platform.accounts.registry.verify'),
  ('platform', 'platform_features_admin', 'platform.features.manage')
) as g (applies_to, role_key, permission_key)
  on r.org_id is null and r.applies_to = g.applies_to::tenancy.organization_kind and r.key = g.role_key;

-- Segregation of duties, in the style of collections.work vs dlg.manage (migration 20261013000700). A login (across all
-- its memberships) may not hold both sides of a maker-checker pair, and a single role may not carry both.
create or replace function private.enforce_payment_duty_segregation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pairs text[] := array['payment.configure', 'payment.config.approve', 'platform.accounts.registry.manage', 'platform.accounts.registry.verify'];
  v_user uuid;
  v_new_keys text[];
  v_keys text[];
  v_partner text;
  i integer;
begin
  if tg_table_name = 'membership_roles' then
    select m.user_id into v_user from tenancy.memberships m where m.id = new.membership_id;
    select coalesce(array_agg(rp.permission_key), '{}') into v_new_keys
    from tenancy.role_permissions rp where rp.role_id = new.role_id;
    v_keys := private.user_permission_keys(v_user) || v_new_keys;
    for i in 1 .. cardinality(v_pairs) / 2 loop
      if v_pairs[2 * i - 1] = any (v_keys) and v_pairs[2 * i] = any (v_keys) then
        raise exception 'segregation of duties: one login cannot hold both % and %', v_pairs[2 * i - 1], v_pairs[2 * i]
          using errcode = '23514', hint = 'segregation_of_duties';
      end if;
    end loop;
  else
    -- A permission added to a role: the role must not already carry the other half, and no login that already holds the
    -- role may end up with both halves through any of its other roles.
    for i in 1 .. cardinality(v_pairs) / 2 loop
      if new.permission_key in (v_pairs[2 * i - 1], v_pairs[2 * i]) then
        v_partner := case new.permission_key when v_pairs[2 * i - 1] then v_pairs[2 * i] else v_pairs[2 * i - 1] end;
        if exists (select 1 from tenancy.role_permissions rp where rp.role_id = new.role_id and rp.permission_key = v_partner) then
          raise exception 'segregation of duties: a role cannot carry both % and %', v_pairs[2 * i - 1], v_pairs[2 * i]
            using errcode = '23514', hint = 'segregation_of_duties';
        end if;
        for v_user in
          select distinct m.user_id
          from tenancy.membership_roles mr
          join tenancy.memberships m on m.id = mr.membership_id
          where mr.role_id = new.role_id and m.status <> 'revoked'
        loop
          if v_partner = any (private.user_permission_keys(v_user)) then
            raise exception 'segregation of duties: one login cannot hold both % and %', v_pairs[2 * i - 1], v_pairs[2 * i]
              using errcode = '23514', hint = 'segregation_of_duties';
          end if;
        end loop;
      end if;
    end loop;
  end if;
  return new;
end
$$;
revoke all on function private.enforce_payment_duty_segregation() from public;
create trigger membership_roles_segregation_payments before insert or update on tenancy.membership_roles
  for each row execute function private.enforce_payment_duty_segregation();

-- The pair triggers above fire when a role is granted or a permission is added to a role. A membership can also change under
-- roles it already has: a revoked membership brought back, or a membership moved to another login (user_id). Those paths are
-- checked here, after the row has changed, against everything the login holds across all its non-revoked memberships.
create or replace function private.enforce_payment_duty_segregation_membership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- The Phase 08a pairs and the Phase 02 pair (collections.work / dlg.manage), whose own trigger has the same gap.
  v_pairs text[] := array['payment.configure', 'payment.config.approve', 'platform.accounts.registry.manage', 'platform.accounts.registry.verify',
                          'collections.work', 'dlg.manage'];
  v_keys text[];
  i integer;
begin
  select coalesce(array_agg(distinct rp.permission_key), '{}') into v_keys
  from tenancy.memberships m
  join tenancy.membership_roles mr on mr.membership_id = m.id
  join tenancy.role_permissions rp on rp.role_id = mr.role_id
  where m.user_id = new.user_id and m.status <> 'revoked';
  for i in 1 .. cardinality(v_pairs) / 2 loop
    if v_pairs[2 * i - 1] = any (v_keys) and v_pairs[2 * i] = any (v_keys) then
      raise exception 'segregation of duties: one login cannot hold both % and %', v_pairs[2 * i - 1], v_pairs[2 * i]
        using errcode = '23514', hint = 'segregation_of_duties';
    end if;
  end loop;
  return new;
end
$$;
revoke all on function private.enforce_payment_duty_segregation_membership() from public;
create trigger memberships_segregation_payments after insert or update of user_id, status on tenancy.memberships
  for each row when (new.status <> 'revoked') execute function private.enforce_payment_duty_segregation_membership();
create trigger role_permissions_segregation_payments before insert or update on tenancy.role_permissions
  for each row execute function private.enforce_payment_duty_segregation();

-- Whether a given user (not necessarily the caller) holds a permission through the platform organisation right now.
create or replace function private.user_holds_platform_permission(p_user uuid, p_permission text)
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
    where m.user_id = p_user and m.status = 'active'
      and (m.valid_until is null or m.valid_until > now())
      and rp.permission_key = p_permission
  )
$$;
revoke all on function private.user_holds_platform_permission(uuid, text) from public;
grant execute on function private.user_holds_platform_permission(uuid, text) to service_role;

-- ---------------------------------------------------------------------------------------------
-- 2. Provider mode vocabulary and the mock/sandbox guard
-- ---------------------------------------------------------------------------------------------
-- Text with a check (a domain), not an enum, so later migrations can use it without add-value problems.
create domain private.provider_mode as text
  constraint provider_mode_known check (value in ('mock', 'sandbox', 'production'));
comment on domain private.provider_mode is
  'How a provider record talks to the outside world: mock (no network, tests only), sandbox (the provider''s test system) or production. Reused by every Phase 08a table that stores a provider mode.';

create or replace function private.is_provider_mode(p_mode text)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$ select p_mode in ('mock', 'sandbox', 'production') $$;
grant execute on function private.is_provider_mode(text) to authenticated, service_role;

create or replace function private.mock_providers_allowed()
returns boolean
language sql
stable
set search_path = ''
as $$ select coalesce(current_setting('udofin.allow_mock_providers', true), '') = 'on' $$;
comment on function private.mock_providers_allowed() is
  'True only when the session sets udofin.allow_mock_providers = on (tests, local development). Same pattern as udofin.allow_mock_connectors. Any session can set a custom setting, so this is one of three levels (configuration, assertProviderAllowed, this guard); production start-up validation and the database login options must keep it unset.';
grant execute on function private.mock_providers_allowed() to authenticated, service_role;

create or replace function private.sandbox_providers_allowed()
returns boolean
language sql
stable
set search_path = ''
as $$ select coalesce(current_setting('udofin.allow_sandbox_providers', true), '') = 'on' $$;
comment on function private.sandbox_providers_allowed() is
  'True only when the session sets udofin.allow_sandbox_providers = on. The database cannot know the environment, so sandbox is off by default and must be switched on explicitly for non-production sessions.';
grant execute on function private.sandbox_providers_allowed() to authenticated, service_role;

create or replace function private.assert_provider_mode_allowed(p_mode text)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_mode is null or not private.is_provider_mode(p_mode) then
    raise exception 'unknown provider mode' using errcode = '22023', hint = 'provider_mode_invalid';
  end if;
  if p_mode = 'mock' and not private.mock_providers_allowed() then
    raise exception 'mock providers are for local development and tests only' using errcode = '42501', hint = 'mock_provider_blocked';
  end if;
  if p_mode = 'sandbox' and not private.sandbox_providers_allowed() then
    raise exception 'sandbox providers are not allowed in this session' using errcode = '42501', hint = 'sandbox_provider_blocked';
  end if;
end
$$;
comment on function private.assert_provider_mode_allowed(text) is
  'Raises 42501 (hints mock_provider_blocked / sandbox_provider_blocked) when the session does not allow the mode, 22023 (provider_mode_invalid) for an unknown one. Allowing a mode in a session does NOT make it acceptable for activation: a mock or sandbox provider can never satisfy a production activation gate (see private.provider_mode_satisfies_production_gate).';
grant execute on function private.assert_provider_mode_allowed(text) to authenticated, service_role;

create or replace function private.provider_mode_satisfies_production_gate(p_mode text)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$ select coalesce(p_mode = 'production', false) $$;
comment on function private.provider_mode_satisfies_production_gate(text) is
  'The only test an activation gate may use for evidence of a provider: production. A mock or sandbox record can never satisfy a production gate, whatever the session settings are. Later migrations extending private.feature_prerequisites_unmet must use this function.';
grant execute on function private.provider_mode_satisfies_production_gate(text) to authenticated, service_role;

-- Row trigger for later tables: create trigger ... before insert or update on <table> for each row
-- execute function private.guard_provider_mode('provider_mode'). The column name is optional (default provider_mode).
create or replace function private.guard_provider_mode()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform private.assert_provider_mode_allowed(to_jsonb(new) ->> coalesce(tg_argv[0], 'provider_mode'));
  return new;
end
$$;
comment on function private.guard_provider_mode() is
  'Generic row trigger: refuses a row whose provider mode column is mock or sandbox unless the session allows it. Argument 0 names the column (default provider_mode).';

-- ---------------------------------------------------------------------------------------------
-- 4. Strict money text parser
-- ---------------------------------------------------------------------------------------------
create or replace function private.parse_money_minor(p_text text)
returns bigint
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
declare
  v_minor bigint;
begin
  -- Not declared STRICT: a null is an error here, not a null result. [0-9] only (no \d, no Unicode digits).
  if p_text is null or p_text !~ '^(0|[1-9][0-9]{0,15})([.][0-9]{1,2})?$' then
    raise exception 'invalid money amount' using errcode = '22023', hint = 'money_invalid';
  end if;
  v_minor := split_part(p_text, '.', 1)::bigint * 100
             + rpad(coalesce(nullif(split_part(p_text, '.', 2), ''), '0'), 2, '0')::bigint;
  if v_minor > 100000000000000 then
    raise exception 'invalid money amount' using errcode = '22023', hint = 'money_invalid';
  end if;
  return v_minor;
end
$$;
comment on function private.parse_money_minor(text) is
  'Decimal string of rupees to integer paise. Accepts digits with an optional point and one or two fractional digits (1250, 1250.5, 1250.50, 0.05). Rejects null, empty, signs, exponents, separators, whitespace, a third decimal, leading zeros beyond a single 0, non-ASCII digits and values above 100000000000000 paise (22023, hint money_invalid). The TypeScript parser in packages/adapters/src/money.ts is tested with the same vectors (docs/specs/08a-notes/foundation.md). Integer arithmetic only.';
grant execute on function private.parse_money_minor(text) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- 1. Activation switches
-- ---------------------------------------------------------------------------------------------
-- Evidence is a flat object of references (document ids, contract section references, decision references): short strings
-- only, no nesting, nothing that looks like a secret or a personal identifier.
create or replace function private.feature_evidence_ok(p_evidence jsonb)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case when p_evidence is not null and jsonb_typeof(p_evidence) = 'object' then
    octet_length(p_evidence::text) <= 4000
    and (select count(*) from jsonb_object_keys(p_evidence)) <= 20
    and not exists (
      select 1 from jsonb_each(p_evidence) kv
      where kv.key !~ '^[a-z][a-z0-9_]{1,40}$'
         or jsonb_typeof(kv.value) <> 'string'
         or length(kv.value #>> '{}') not between 1 and 200
         or (kv.value #>> '{}') ~* '(password|passwd|secret|api[_ -]?key|private[_ -]?key|bearer|access[_ -]?token)\s*[:=]\s*\S{4,}'
         or (kv.value #>> '{}') ~ '\m[2-9][0-9]{3}\s?[0-9]{4}\s?[0-9]{4}\M'
         or (kv.value #>> '{}') ~ '\m[A-Z]{5}[0-9]{4}[A-Z]\M'
         or (kv.value #>> '{}') ~ '(^|[^0-9])[6-9][0-9]{9}([^0-9]|$)'
         or (kv.value #>> '{}') ~ '[0-9]{11,}'
         or (kv.value #>> '{}') ~ '@')
  else false end
$$;
comment on function private.feature_evidence_ok(jsonb) is
  'Evidence for an activation switch: a flat object of short string references. Defence in depth, not a personal-data scanner.';
grant execute on function private.feature_evidence_ok(jsonb) to authenticated, service_role;

create table servicing.feature_catalog (
  feature text primary key check (feature ~ '^[a-z][a-z_]{2,40}$'),
  enableable boolean not null,
  introduced_in text not null check (introduced_in in ('phase_08a', 'phase_08b', 'phase_08c')),
  description text not null check (length(description) between 10 and 500),
  locked_reason text check (locked_reason is null or length(locked_reason) between 10 and 500),
  constraint locked_has_reason check (enableable or locked_reason is not null)
);
comment on table servicing.feature_catalog is
  'Which Phase 08 features can ever be switched on. Populated by migration only; no API or system role can write it. collections and dlg (Phase 08b/08c) are NOT enableable: the database refuses enabled = true for them whoever asks, and the only way to lift that is a later, owner-approved migration that changes this table (the migration role is the sole role able to write here). Owner: servicing module.';

insert into servicing.feature_catalog (feature, enableable, introduced_in, description, locked_reason) values
  ('servicing_sync', true, 'phase_08a', 'Copy what the lender''s system reports (status, balances, schedule, receipts) into read models', null),
  ('payments', true, 'phase_08a', 'Payment links and one-time payments made directly to the lender''s own account', null),
  ('mandates', true, 'phase_08a', 'Repayment mandates (eNACH, UPI AutoPay) with the lender as creditor', null),
  ('reminders', true, 'phase_08a', 'Service reminders by in-app message and push notification', null),
  ('statements_noc', true, 'phase_08a', 'Lender-issued statements, foreclosure quotes and no-dues letters', null),
  ('collections', false, 'phase_08b', 'Udofin acting as the lender''s recovery agent',
   'Phase 08b is not authorised. Only a later owner-approved migration may change this row.'),
  ('dlg', false, 'phase_08c', 'Default loss guarantee ledger',
   'Phase 08c is not authorised. Only a later owner-approved migration may change this row.');

create or replace function private.protect_feature_catalog()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if private.invoking_role() in ('postgres', 'supabase_admin') then
    return coalesce(new, old);
  end if;
  raise exception 'the feature catalogue changes only through a migration' using errcode = '42501', hint = 'catalog_is_migration_only';
end
$$;
create trigger catalog_migration_only before insert or update or delete on servicing.feature_catalog
  for each row execute function private.protect_feature_catalog();
create trigger no_truncate before truncate on servicing.feature_catalog
  for each statement execute function private.forbid_truncate();

-- The request record: one person asks, a DIFFERENT platform user decides, the decision is applied in the same
-- transaction. mode = 'emergency' is the single-person kill switch and exists only as an already-applied disable.
create table servicing.feature_change_requests (
  id uuid primary key default private.uuid_v7(),
  lender_org_id uuid not null references tenancy.organizations (id) on delete restrict,
  feature text not null references servicing.feature_catalog (feature) on delete restrict,
  enable boolean not null,
  mode text not null default 'two_person' check (mode in ('two_person', 'emergency')),
  status text not null default 'pending' check (status in ('pending', 'applied', 'rejected', 'cancelled', 'expired')),
  evidence jsonb not null default '{}'::jsonb check (private.feature_evidence_ok(evidence)),
  reason text check (reason is null or length(trim(reason)) between 10 and 1000),
  requested_by uuid not null references auth.users (id),
  requested_at timestamptz not null default now(),
  idempotency_key text not null check (length(idempotency_key) between 16 and 128),
  expires_at timestamptz not null default now() + interval '7 days',
  decided_by uuid references auth.users (id),
  decided_at timestamptz,
  decision_note text check (decision_note is null or length(decision_note) <= 1000),
  applied_at timestamptz,
  unique (requested_by, idempotency_key),
  constraint no_self_approval check (decided_by is null or decided_by <> requested_by),
  constraint enabling_needs_evidence check (not enable or evidence <> '{}'::jsonb),
  constraint disabling_needs_reason check (enable or reason is not null),
  constraint emergency_only_disables check (mode = 'two_person' or (not enable and status = 'applied' and decided_by is null)),
  constraint status_shape check (
    (status = 'pending' and mode = 'two_person' and decided_by is null and decided_at is null and applied_at is null)
    or (status = 'applied' and mode = 'two_person' and decided_by is not null and decided_at is not null and applied_at is not null)
    or (status = 'applied' and mode = 'emergency' and applied_at is not null)
    or (status = 'rejected' and mode = 'two_person' and decided_by is not null and decided_at is not null and applied_at is null)
    or (status in ('cancelled', 'expired') and mode = 'two_person' and decided_by is null and applied_at is null)
  )
);
create unique index feature_change_requests_one_pending on servicing.feature_change_requests (lender_org_id, feature) where status = 'pending';
create index feature_change_requests_lender on servicing.feature_change_requests (lender_org_id, feature, requested_at desc);
create index feature_change_requests_feature on servicing.feature_change_requests (feature);
comment on table servicing.feature_change_requests is
  'Permanent history of every change to a per-lender activation switch: turning ON needs a request and a DIFFERENT platform user to decide it (platform.features.manage); turning OFF can also be done at once by one person as a recorded emergency kill switch with a reason. Written only by servicing.request_feature_change, decide_feature_change, cancel_feature_change and kill_feature. Evidence holds references only. Owner: servicing module.';

create trigger unsafe_text before insert or update on servicing.feature_change_requests
  for each row execute function onboarding.reject_unsafe_text('reason', 'decision_note');

create or replace function private.protect_feature_change_request()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'feature change requests cannot be deleted' using errcode = 'P0001';
  end if;
  if (new.id, new.lender_org_id, new.feature, new.enable, new.mode, new.evidence, new.reason, new.requested_by, new.requested_at,
      new.idempotency_key, new.expires_at)
     is distinct from
     (old.id, old.lender_org_id, old.feature, old.enable, old.mode, old.evidence, old.reason, old.requested_by, old.requested_at,
      old.idempotency_key, old.expires_at) then
    raise exception 'a feature change request cannot be edited after it is filed' using errcode = 'P0001';
  end if;
  if old.status <> 'pending' then
    -- Every other status is final; the row may not change at all.
    if to_jsonb(new) is distinct from to_jsonb(old) then
      raise exception 'a decided feature change request is final' using errcode = 'P0001';
    end if;
  end if;
  return new;
end
$$;
create trigger protect before update or delete on servicing.feature_change_requests
  for each row execute function private.protect_feature_change_request();
create trigger no_truncate before truncate on servicing.feature_change_requests
  for each statement execute function private.forbid_truncate();

create table servicing.lender_features (
  lender_org_id uuid not null references tenancy.organizations (id) on delete restrict,
  feature text not null references servicing.feature_catalog (feature) on delete restrict,
  enabled boolean not null default false,
  evidence jsonb not null default '{}'::jsonb check (private.feature_evidence_ok(evidence)),
  enabled_by uuid references auth.users (id),
  enabled_at timestamptz,
  disabled_by uuid references auth.users (id),
  disabled_at timestamptz,
  last_change_request_id uuid references servicing.feature_change_requests (id) on delete restrict,
  updated_at timestamptz not null default now(),
  primary key (lender_org_id, feature),
  constraint enabled_is_attributed check (not enabled or (enabled_by is not null and enabled_at is not null))
);
create index lender_features_feature on servicing.lender_features (feature);
create index lender_features_last_change on servicing.lender_features (last_change_request_id);
comment on table servicing.lender_features is
  'Per-lender activation switches for Phase 08a features. No row = off. A row can say enabled = true only if the catalogue marks the feature enableable (collections and dlg never are: the database refuses it for every role, including the system role and the table owner; a later owner-approved migration changing servicing.feature_catalog is the only way to lift that) and only through a two-person request applied in the same transaction. Written only by the servicing.*_feature_* functions; lenders can read their own rows, nobody but the functions can write. Owner: servicing module.';

create or replace function private.guard_lender_feature()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_enableable boolean;
  v_kind tenancy.organization_kind;
  v_req servicing.feature_change_requests;
begin
  if tg_op = 'UPDATE' and (new.lender_org_id, new.feature) is distinct from (old.lender_org_id, old.feature) then
    raise exception 'a switch cannot be moved to another lender or feature' using errcode = 'P0001';
  end if;
  select o.kind into v_kind from tenancy.organizations o where o.id = new.lender_org_id;
  if v_kind is distinct from 'lender' then
    raise exception 'activation switches belong to lender organisations' using errcode = '55000', hint = 'not_a_lender';
  end if;
  select c.enableable into v_enableable from servicing.feature_catalog c where c.feature = new.feature;
  if new.enabled and not coalesce(v_enableable, false) then
    raise exception 'feature % cannot be enabled in this phase', new.feature using errcode = '55000', hint = 'feature_not_enableable';
  end if;
  -- Any change of the switch itself must be backed by a request applied in THIS transaction.
  if (tg_op = 'INSERT' and new.enabled) or (tg_op = 'UPDATE' and new.enabled is distinct from old.enabled) then
    select * into v_req from servicing.feature_change_requests r where r.id = new.last_change_request_id;
    if not found
       or v_req.lender_org_id <> new.lender_org_id or v_req.feature <> new.feature
       or v_req.status <> 'applied' or v_req.enable is distinct from new.enabled
       or v_req.applied_at is distinct from transaction_timestamp() then
      raise exception 'a switch changes only through an approved change request applied in the same transaction'
        using errcode = '55000', hint = 'two_person_required';
    end if;
    if new.enabled and (v_req.mode <> 'two_person' or v_req.decided_by is null or v_req.decided_by = v_req.requested_by) then
      raise exception 'turning a feature on needs a request and a different person to decide it'
        using errcode = '55000', hint = 'two_person_required';
    end if;
  end if;
  return new;
end
$$;
create trigger guard before insert or update on servicing.lender_features
  for each row execute function private.guard_lender_feature();
create trigger set_updated_at before update on servicing.lender_features
  for each row execute function private.set_updated_at();
create trigger no_delete before delete on servicing.lender_features
  for each row execute function private.forbid_mutation();
create trigger no_truncate before truncate on servicing.lender_features
  for each statement execute function private.forbid_truncate();

-- Row level security and grants. Nobody writes these tables directly; the definer functions below do.
alter table servicing.feature_catalog enable row level security;
alter table servicing.feature_catalog force row level security;
alter table servicing.feature_change_requests enable row level security;
alter table servicing.feature_change_requests force row level security;
alter table servicing.lender_features enable row level security;
alter table servicing.lender_features force row level security;

-- Staff only (any active membership): borrowers and users without an organisation see nothing, not even which features exist.
create policy feature_catalog_read on servicing.feature_catalog for select to authenticated
  using (exists (select 1 from private.my_org_ids()));
create policy lender_features_read on servicing.lender_features for select to authenticated
  using (
    lender_org_id in (select private.orgs_with_permission('loan.read'))
    or lender_org_id in (select private.orgs_with_permission('payment.read'))
    or (select private.has_platform_permission('platform.features.manage'))
  );
create policy feature_change_requests_read on servicing.feature_change_requests for select to authenticated
  using (requested_by = (select auth.uid()) or (select private.has_platform_permission('platform.features.manage')));

-- The default privilege gives service_role ALL on new domain tables. It gets read only here: system code must never be
-- able to switch a feature on, forge a request or edit the catalogue.
revoke all on servicing.feature_catalog, servicing.feature_change_requests, servicing.lender_features from service_role;
grant select on servicing.feature_catalog, servicing.feature_change_requests, servicing.lender_features to service_role;
grant select on servicing.feature_catalog, servicing.feature_change_requests, servicing.lender_features to authenticated;

-- Unmet prerequisites for turning a feature ON. Reasons are stable identifiers (no personal data), sorted.
-- Generic checks only in this migration; the evidence is carried by the single pending enable request.
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
  -- Later Phase 08a migrations add feature-specific checks here (for example: an approved payment configuration whose
  -- provider mode satisfies private.provider_mode_satisfies_production_gate; no mock provider present).
  return array(select distinct x from unnest(v_reasons) x order by x);
end
$$;
comment on function private.feature_prerequisites_unmet(uuid, text) is
  'Reasons a feature cannot be switched on for a lender; empty array = none. Generic checks here: feature unknown or not enableable, lender organisation not active, onboarding gate not activated, evidence missing (the single pending enable request must carry evidence). EXTENDING: later migrations add feature-specific checks with CREATE OR REPLACE and MUST PRESERVE every earlier check (copy this body and append; never remove or weaken a reason). A mock or sandbox provider record must never satisfy a check: use private.provider_mode_satisfies_production_gate.';
revoke all on function private.feature_prerequisites_unmet(uuid, text) from public;
grant execute on function private.feature_prerequisites_unmet(uuid, text) to service_role;

-- Fail closed: no row, switch off, feature not enableable, lender not active or gate not activated => false.
create or replace function private.feature_enabled(p_lender uuid, p_feature text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select true
    from servicing.lender_features f
    join servicing.feature_catalog c on c.feature = f.feature and c.enableable
    join tenancy.organizations o on o.id = f.lender_org_id and o.kind = 'lender' and o.status = 'active'
    join onboarding.lender_gates g on g.lender_org_id = f.lender_org_id and g.stage = 'activated'
    where f.lender_org_id = p_lender and f.feature = p_feature and f.enabled
  ), false)
$$;
comment on function private.feature_enabled(uuid, text) is
  'True only when the lender has an enabled switch for an enableable feature AND the lender organisation is active AND its onboarding gate is activated. Everything else is false (fail closed).';
revoke all on function private.feature_enabled(uuid, text) from public;
grant execute on function private.feature_enabled(uuid, text) to service_role;

create or replace function private.require_feature(p_lender uuid, p_feature text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.feature_enabled(p_lender, p_feature) then
    raise exception 'this feature is not enabled for the lender' using errcode = '55000', hint = 'feature_disabled';
  end if;
end
$$;
revoke all on function private.require_feature(uuid, text) from public;
grant execute on function private.require_feature(uuid, text) to service_role;

-- Audit through the existing path (audit.events). Metadata holds identifiers and names only.
create or replace function private.write_feature_audit(
  p_actor_user uuid, p_lender uuid, p_action text, p_request uuid, p_metadata jsonb, p_outcome audit.outcome default 'success'
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into audit.events (actor_type, actor_user_id, tenant_org_id, action, entity_type, entity_id, outcome, metadata)
  values ('platform', p_actor_user, p_lender, p_action, 'feature_change', p_request::text, p_outcome, p_metadata)
$$;
revoke all on function private.write_feature_audit(uuid, uuid, text, uuid, jsonb, audit.outcome) from public;

create or replace function private.features_require_manage()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null or not private.has_platform_permission('platform.features.manage') then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  perform private.require_aal2();
  return v_uid;
end
$$;
revoke all on function private.features_require_manage() from public;

-- Asks for a switch to change. Enabling needs evidence and every prerequisite; disabling needs a reason.
create or replace function servicing.request_feature_change(
  p_lender uuid, p_feature text, p_enable boolean, p_evidence jsonb, p_idempotency_key text, p_reason text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.features_require_manage();
  v_evidence jsonb := coalesce(p_evidence, '{}'::jsonb);
  v_cat servicing.feature_catalog;
  v_existing servicing.feature_change_requests;
  v_unmet text[];
  v_id uuid;
begin
  if p_enable is null or p_idempotency_key is null or length(p_idempotency_key) not between 16 and 128 then
    raise exception 'enable and a 16 to 128 character idempotency key are required' using errcode = '22023', hint = 'bad_request';
  end if;
  select * into v_cat from servicing.feature_catalog c where c.feature = p_feature;
  if not found then
    raise exception 'unknown feature' using errcode = '22023', hint = 'unknown_feature';
  end if;
  if not exists (select 1 from tenancy.organizations o where o.id = p_lender and o.kind = 'lender') then
    raise exception 'lender not found' using errcode = 'P0002';
  end if;
  if not private.feature_evidence_ok(v_evidence) then
    raise exception 'evidence must be a flat object of short reference strings' using errcode = '22023', hint = 'evidence_invalid';
  end if;

  select * into v_existing from servicing.feature_change_requests r where r.requested_by = v_uid and r.idempotency_key = p_idempotency_key;
  if found then
    if (v_existing.lender_org_id, v_existing.feature, v_existing.enable, v_existing.evidence, v_existing.mode)
       is distinct from (p_lender, p_feature, p_enable, v_evidence, 'two_person') then
      raise exception 'idempotency key was already used for a different request' using errcode = '23505', hint = 'idempotency_conflict';
    end if;
    return v_existing.id;
  end if;

  if p_enable then
    if not v_cat.enableable then
      raise exception 'feature % cannot be enabled in this phase', p_feature using errcode = '55000', hint = 'feature_not_enableable';
    end if;
    if v_evidence = '{}'::jsonb then
      raise exception 'evidence references are required to turn a feature on' using errcode = '55000', hint = 'evidence_missing';
    end if;
  elsif p_reason is null or length(trim(p_reason)) < 10 then
    raise exception 'a reason of at least 10 characters is required to turn a feature off' using errcode = '22023', hint = 'reason_required';
  end if;
  -- A reason, when given, must fit the table check (10 to 1000 characters after trimming); say so here with a stable hint.
  if p_reason is not null and length(trim(p_reason)) not between 10 and 1000 then
    raise exception 'a reason must be 10 to 1000 characters' using errcode = '22023', hint = 'reason_invalid';
  end if;
  if p_enable = coalesce((select f.enabled from servicing.lender_features f where f.lender_org_id = p_lender and f.feature = p_feature), false) then
    raise exception 'the feature is already in that state' using errcode = '55000', hint = 'no_change';
  end if;
  if exists (select 1 from servicing.feature_change_requests r where r.lender_org_id = p_lender and r.feature = p_feature and r.status = 'pending') then
    raise exception 'a request for this feature is already pending' using errcode = '23505', hint = 'pending_request_exists';
  end if;

  insert into servicing.feature_change_requests (lender_org_id, feature, enable, mode, evidence, reason, requested_by, idempotency_key)
  values (p_lender, p_feature, p_enable, 'two_person', v_evidence, p_reason, v_uid, p_idempotency_key)
  returning id into v_id;

  if p_enable then
    v_unmet := private.feature_prerequisites_unmet(p_lender, p_feature);
    if cardinality(v_unmet) > 0 then
      raise exception 'prerequisites not met: %', array_to_string(v_unmet, ', ') using errcode = '55000', hint = 'prerequisites_unmet';
    end if;
  end if;
  perform private.write_feature_audit(v_uid, p_lender, 'servicing.feature_change.requested', v_id,
    jsonb_build_object('feature', p_feature, 'enable', p_enable, 'mode', 'two_person', 'evidence_keys', (select coalesce(jsonb_agg(k order by k), '[]'::jsonb) from jsonb_object_keys(v_evidence) k)));
  return v_id;
end
$$;

-- Decides a pending request (a different platform user) and applies it in the same transaction.
create or replace function servicing.decide_feature_change(p_request uuid, p_approve boolean, p_note text default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.features_require_manage();
  v_req servicing.feature_change_requests;
  v_unmet text[];
begin
  if p_approve is null then
    raise exception 'approve must be true or false' using errcode = '22023', hint = 'bad_request';
  end if;
  select * into v_req from servicing.feature_change_requests where id = p_request for update;
  if not found then
    raise exception 'feature change request not found' using errcode = 'P0002';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'request is %, not pending', v_req.status using errcode = '55000', hint = 'request_not_pending';
  end if;
  if v_req.requested_by = v_uid then
    raise exception 'a switch change cannot be decided by the person who requested it' using errcode = '42501', hint = 'self_approval';
  end if;
  if v_req.expires_at <= now() then
    update servicing.feature_change_requests set status = 'expired', decision_note = 'expired before it was decided' where id = p_request;
    perform private.write_feature_audit(v_uid, v_req.lender_org_id, 'servicing.feature_change.expired', p_request,
      jsonb_build_object('feature', v_req.feature, 'enable', v_req.enable));
    return 'expired';
  end if;

  if p_note is not null and length(p_note) > 1000 then
    raise exception 'a decision note must be at most 1000 characters' using errcode = '22023', hint = 'reason_invalid';
  end if;
  if not p_approve then
    if p_note is null or length(trim(p_note)) < 10 then
      raise exception 'a rejection needs a reason' using errcode = '22023', hint = 'reason_required';
    end if;
    update servicing.feature_change_requests
    set status = 'rejected', decided_by = v_uid, decided_at = now(), decision_note = p_note
    where id = p_request;
    perform private.write_feature_audit(v_uid, v_req.lender_org_id, 'servicing.feature_change.rejected', p_request,
      jsonb_build_object('feature', v_req.feature, 'enable', v_req.enable, 'requested_by', v_req.requested_by));
    return 'rejected';
  end if;

  if not private.user_holds_platform_permission(v_req.requested_by, 'platform.features.manage') then
    raise exception 'the requester no longer holds the permission needed for this change' using errcode = '42501', hint = 'requester_not_entitled';
  end if;
  if v_req.enable then
    v_unmet := private.feature_prerequisites_unmet(v_req.lender_org_id, v_req.feature);
    if cardinality(v_unmet) > 0 then
      raise exception 'prerequisites not met: %', array_to_string(v_unmet, ', ') using errcode = '55000', hint = 'prerequisites_unmet';
    end if;
  end if;

  update servicing.feature_change_requests
  set status = 'applied', decided_by = v_uid, decided_at = now(), decision_note = p_note, applied_at = now()
  where id = p_request;

  if v_req.enable then
    insert into servicing.lender_features (lender_org_id, feature, enabled, evidence, enabled_by, enabled_at, last_change_request_id)
    values (v_req.lender_org_id, v_req.feature, true, v_req.evidence, v_uid, now(), p_request)
    on conflict (lender_org_id, feature) do update
      set enabled = true, evidence = excluded.evidence, enabled_by = excluded.enabled_by, enabled_at = excluded.enabled_at,
          last_change_request_id = excluded.last_change_request_id;
  else
    insert into servicing.lender_features (lender_org_id, feature, enabled, disabled_by, disabled_at, last_change_request_id)
    values (v_req.lender_org_id, v_req.feature, false, v_uid, now(), p_request)
    on conflict (lender_org_id, feature) do update
      set enabled = false, disabled_by = excluded.disabled_by, disabled_at = excluded.disabled_at,
          last_change_request_id = excluded.last_change_request_id;
  end if;

  perform private.write_feature_audit(v_uid, v_req.lender_org_id,
    case when v_req.enable then 'servicing.feature_change.enabled' else 'servicing.feature_change.disabled' end, p_request,
    jsonb_build_object('feature', v_req.feature, 'enable', v_req.enable, 'mode', 'two_person', 'requested_by', v_req.requested_by,
                       'decided_by', v_uid));
  return 'applied';
end
$$;

create or replace function servicing.cancel_feature_change(p_request uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.features_require_manage();
  v_req servicing.feature_change_requests;
begin
  update servicing.feature_change_requests
  set status = 'cancelled', decision_note = 'cancelled by the requester'
  where id = p_request and status = 'pending' and requested_by = v_uid
  returning * into v_req;
  if not found then
    raise exception 'no pending request of yours found' using errcode = 'P0002';
  end if;
  perform private.write_feature_audit(v_uid, v_req.lender_org_id, 'servicing.feature_change.cancelled', p_request,
    jsonb_build_object('feature', v_req.feature, 'enable', v_req.enable));
end
$$;

-- Emergency kill switch: one platform user turns a feature OFF immediately. Recorded, audited, reason required.
-- It cannot turn anything on, and it cancels a pending request for the same switch so that request cannot undo it.
create or replace function servicing.kill_feature(p_lender uuid, p_feature text, p_reason text, p_idempotency_key text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.features_require_manage();
  v_existing servicing.feature_change_requests;
  v_id uuid;
  v_cancelled integer;
begin
  if p_idempotency_key is null or length(p_idempotency_key) not between 16 and 128 then
    raise exception 'a 16 to 128 character idempotency key is required' using errcode = '22023', hint = 'bad_request';
  end if;
  if p_reason is null or length(trim(p_reason)) < 10 then
    raise exception 'a reason of at least 10 characters is required for the kill switch' using errcode = '22023', hint = 'reason_required';
  end if;
  if length(trim(p_reason)) > 1000 then
    raise exception 'a reason must be 10 to 1000 characters' using errcode = '22023', hint = 'reason_invalid';
  end if;
  if not exists (select 1 from servicing.feature_catalog c where c.feature = p_feature) then
    raise exception 'unknown feature' using errcode = '22023', hint = 'unknown_feature';
  end if;
  if not exists (select 1 from tenancy.organizations o where o.id = p_lender and o.kind = 'lender') then
    raise exception 'lender not found' using errcode = 'P0002';
  end if;

  select * into v_existing from servicing.feature_change_requests r where r.requested_by = v_uid and r.idempotency_key = p_idempotency_key;
  if found then
    if (v_existing.lender_org_id, v_existing.feature, v_existing.enable, v_existing.mode) is distinct from (p_lender, p_feature, false, 'emergency') then
      raise exception 'idempotency key was already used for a different request' using errcode = '23505', hint = 'idempotency_conflict';
    end if;
    return v_existing.id;
  end if;

  update servicing.feature_change_requests
  set status = 'cancelled', decision_note = 'superseded by an emergency disable'
  where lender_org_id = p_lender and feature = p_feature and status = 'pending';
  get diagnostics v_cancelled = row_count;

  insert into servicing.feature_change_requests (lender_org_id, feature, enable, mode, status, reason, requested_by, idempotency_key, applied_at)
  values (p_lender, p_feature, false, 'emergency', 'applied', p_reason, v_uid, p_idempotency_key, now())
  returning id into v_id;

  insert into servicing.lender_features (lender_org_id, feature, enabled, disabled_by, disabled_at, last_change_request_id)
  values (p_lender, p_feature, false, v_uid, now(), v_id)
  on conflict (lender_org_id, feature) do update
    set enabled = false, disabled_by = excluded.disabled_by, disabled_at = excluded.disabled_at,
        last_change_request_id = excluded.last_change_request_id;

  perform private.write_feature_audit(v_uid, p_lender, 'servicing.feature_change.emergency_disabled', v_id,
    jsonb_build_object('feature', p_feature, 'enable', false, 'mode', 'emergency', 'pending_requests_cancelled', v_cancelled));
  return v_id;
end
$$;

revoke all on function servicing.request_feature_change(uuid, text, boolean, jsonb, text, text) from public;
revoke all on function servicing.decide_feature_change(uuid, boolean, text) from public;
revoke all on function servicing.cancel_feature_change(uuid) from public;
revoke all on function servicing.kill_feature(uuid, text, text, text) from public;
grant execute on function servicing.request_feature_change(uuid, text, boolean, jsonb, text, text) to authenticated;
grant execute on function servicing.decide_feature_change(uuid, boolean, text) to authenticated;
grant execute on function servicing.cancel_feature_change(uuid) to authenticated;
grant execute on function servicing.kill_feature(uuid, text, text, text) to authenticated;

comment on function servicing.request_feature_change(uuid, text, boolean, jsonb, text, text) is
  'Platform user with platform.features.manage (aal2) asks for a per-lender switch to change. Enabling needs evidence references and every prerequisite (private.feature_prerequisites_unmet); disabling needs a reason. Idempotent on (user, key). A different platform user decides it with servicing.decide_feature_change.';
comment on function servicing.decide_feature_change(uuid, boolean, text) is
  'A DIFFERENT platform user with platform.features.manage approves or rejects a pending request; approval re-checks the prerequisites and applies the change and its audit event atomically. Returns applied, rejected or expired.';
comment on function servicing.kill_feature(uuid, text, text, text) is
  'Emergency kill switch: one platform user with platform.features.manage turns a feature OFF at once. Reason required; recorded in feature_change_requests (mode emergency) and in the audit trail. Cannot turn anything on.';
