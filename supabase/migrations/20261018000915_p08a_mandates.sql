-- =============================================================================================
-- Phase 08a, repayment mandates (eNACH / API mandate and UPI AutoPay), the lender as creditor.
-- Spec: docs/specs/08-servicing-payments-mandates-collections.md section 8, and the owner decisions of 14 October 2026 (2, 3, 7).
--
--   1. payments.lender_mandate_policies: the lender's own settings (requirement, ceiling on one debit, lead time of the pre-debit notice).
--   2. payments.mandate_transitions: the lifecycle as data, mirrored in packages/domain (a drift test compares them). Every move after the
--      draft is made by the system, and only on a VERIFIED provider event or an AUTHENTICATED provider status lookup. A redirect back to
--      the app, a client flag or a screen proves nothing.
--   3. payments.mandates (+ append-only mandate_events): created in draft by payments.request_mandate (the signed-in borrower, a step-up
--      code bound to THIS mandate, a device-integrity result of at least "device", the lender's active validated collection target, rail
--      limits copied from the provider documentation into the configuration). The creditor is the lender: the mandate carries the
--      merchant reference of the lender's own verified merchant. Udofin stores a masked account reference only, never an account number.
--   4. payments.mandate_debits: one row per instalment per mandate, planned from the lender's REPORTED schedule and figures (never above
--      the mandate maximum, never invented) or recorded as UNPLANNED when the provider reports a debit Udofin did not plan (and flagged).
--      The provider's return code is stored verbatim; its class comes from a configuration table (nothing hard-coded, nothing seeded).
--      A returned debit creates no Udofin charge; any bounce or late charge is the lender's, reported by the lender.
--   5. payments.pre_debit_notices: a notice before every planned debit; one planned too late is flagged to the lender, not presented
--      silently. Udofin does not present debits in Phase 08a (the lender or its sponsor bank does; the provider port has no such method).
--   6. The two hooks left by migration 20261018000913 (correlate and apply a mandate or debit event) are replaced.
--   7. private.feature_prerequisites_unmet extended for `mandates` (every earlier check preserved).
--
-- Forward-only. Error convention: SQLSTATE and hint (42501 not authorised, P0002 not found, 22023 bad input, 55000 rule or state,
-- 23505 duplicate).
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- 1. The lender's mandate settings
-- ---------------------------------------------------------------------------------------------
create table payments.lender_mandate_policies (
  lender_org_id uuid primary key references tenancy.organizations (id) on delete restrict,
  -- before_disbursal needs the Phase 07 journey changed and is NOT available in Phase 08a, so it cannot be stored.
  requirement text not null check (requirement in ('optional', 'before_first_due')),
  -- The lender's ceiling on one debit. The rail's own limit (configuration) still applies; the lower of the two wins.
  max_amount_cap_minor bigint check (max_amount_cap_minor is null or max_amount_cap_minor between 1 and 100000000000000),
  pre_debit_lead_hours integer not null default 48 check (pre_debit_lead_hours between 24 and 168),
  updated_by uuid not null references auth.users (id),
  updated_at timestamptz not null default clock_timestamp()
);
create index lender_mandate_policies_updated_by on payments.lender_mandate_policies (updated_by);
comment on table payments.lender_mandate_policies is
  'The lender''s own mandate settings: whether a mandate is optional or expected before the first due date (informational: no loan operation is blocked in Phase 08a), a ceiling on one debit and the lead time of the pre-debit notice (24 to 168 hours, default 48). Written only by payments.set_mandate_policy (payment.configure, aal2). Owner: payments module.';
create trigger no_delete before delete on payments.lender_mandate_policies
  for each row execute function private.forbid_mutation();
create trigger no_truncate before truncate on payments.lender_mandate_policies
  for each statement execute function private.forbid_truncate();

create or replace function payments.set_mandate_policy(p_lender uuid, p_requirement text, p_max_amount_cap_minor bigint, p_pre_debit_lead_hours integer default 48)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.payments_require_lender(p_lender, 'payment.configure');
begin
  if p_requirement is null or p_requirement not in ('optional', 'before_first_due')
     or (p_max_amount_cap_minor is not null and p_max_amount_cap_minor not between 1 and 100000000000000)
     or p_pre_debit_lead_hours is null or p_pre_debit_lead_hours not between 24 and 168 then
    raise exception 'invalid mandate policy' using errcode = '22023', hint = 'policy_invalid';
  end if;
  insert into payments.lender_mandate_policies (lender_org_id, requirement, max_amount_cap_minor, pre_debit_lead_hours, updated_by)
  values (p_lender, p_requirement, p_max_amount_cap_minor, p_pre_debit_lead_hours, v_uid)
  on conflict (lender_org_id) do update set requirement = excluded.requirement, max_amount_cap_minor = excluded.max_amount_cap_minor,
    pre_debit_lead_hours = excluded.pre_debit_lead_hours, updated_by = excluded.updated_by, updated_at = clock_timestamp();
  perform private.write_payments_audit(p_lender, 'payments.mandate_policy.set', 'mandate_policy', p_lender::text,
    jsonb_build_object('requirement', p_requirement, 'lead_hours', p_pre_debit_lead_hours, 'has_cap', p_max_amount_cap_minor is not null));
  return 'set';
end
$$;
comment on function payments.set_mandate_policy(uuid, text, bigint, integer) is
  'payment.configure of the lender, aal2. Sets the lender''s mandate settings (22023 policy_invalid). A change affects mandates requested later; it never edits an existing mandate.';

-- ---------------------------------------------------------------------------------------------
-- 2. The lifecycle as data (mirrors packages/domain/src/lifecycles/mandate.ts)
-- ---------------------------------------------------------------------------------------------
create table payments.mandate_transitions (
  from_status text not null,
  to_status text not null,
  allowed_actors text[] not null check (allowed_actors <@ array['borrower', 'lender', 'system']),
  primary key (from_status, to_status)
);
comment on table payments.mandate_transitions is
  'Mandate lifecycle. Mirrors packages/domain mandateLifecycle; a test fails if the two diverge. Only the system moves a mandate after the draft, on a verified provider event or an authenticated status lookup. Owner: payments module.';

insert into payments.mandate_transitions (from_status, to_status, allowed_actors) values
  ('draft', 'registration_pending', array['system']),
  ('draft', 'failed', array['system']),
  ('draft', 'requires_reconciliation', array['system']),
  ('draft', 'cancelled', array['system']),
  ('registration_pending', 'active', array['system']),
  ('registration_pending', 'rejected', array['system']),
  ('registration_pending', 'failed', array['system']),
  ('registration_pending', 'expired', array['system']),
  ('registration_pending', 'requires_reconciliation', array['system']),
  ('registration_pending', 'cancelled', array['system']),
  ('requires_reconciliation', 'registration_pending', array['system']),
  ('requires_reconciliation', 'active', array['system']),
  ('requires_reconciliation', 'rejected', array['system']),
  ('requires_reconciliation', 'failed', array['system']),
  ('requires_reconciliation', 'expired', array['system']),
  ('requires_reconciliation', 'cancelled', array['system']),
  ('active', 'paused', array['system']),
  ('active', 'cancelled', array['system']),
  ('active', 'revoked', array['system']),
  ('active', 'expired', array['system']),
  ('paused', 'active', array['system']),
  ('paused', 'cancelled', array['system']),
  ('paused', 'revoked', array['system']),
  ('paused', 'expired', array['system']);

-- ---------------------------------------------------------------------------------------------
-- 3. Mandates and their history
-- ---------------------------------------------------------------------------------------------
create table payments.mandates (
  -- Chosen by the app before the step-up code is requested, so the code is bound to THIS mandate.
  id uuid primary key,
  lender_org_id uuid not null references tenancy.organizations (id) on delete restrict,
  config_id uuid not null,
  borrower_id uuid not null references identity.borrowers (id) on delete restrict,
  loan_account_id uuid not null,
  rail text not null check (rail in ('enach_api', 'upi_autopay')),
  status text not null default 'draft' check (status in (
    'draft', 'registration_pending', 'active', 'paused', 'rejected', 'failed', 'expired', 'cancelled', 'revoked', 'requires_reconciliation')),
  provider text not null check (provider ~ '^[a-z0-9_]{1,50}$'),
  provider_mode private.provider_mode not null,
  -- The lender's own merchant (creditor) reference from the verified merchant registry. A copy, never a secret.
  creditor_ref text not null check (length(creditor_ref) between 1 and 100),
  provider_mandate_ref text check (provider_mandate_ref is null or (length(provider_mandate_ref) between 1 and 200 and provider_mandate_ref ~ '^[A-Za-z0-9._:=+/-]+$')),
  max_amount_minor bigint not null check (max_amount_minor between 1 and 100000000000000),
  start_date date not null,
  end_date date not null,
  -- Masked reference such as XXXXXX1234. Never an account number, a name or an IFSC.
  masked_account_ref text not null check (masked_account_ref ~ '^[X*]{2,}[0-9]{2,4}$'),
  needs_afa_each_debit boolean not null,
  handoff_expires_at timestamptz,
  last_event_at timestamptz,
  cancel_requested_at timestamptz,
  cancel_reason text check (cancel_reason is null or cancel_reason in ('borrower', 'loan_closed')),
  cancel_sent_at timestamptz,
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (id, lender_org_id),
  foreign key (config_id, lender_org_id) references payments.lender_payment_configs (id, lender_org_id) on delete restrict,
  foreign key (loan_account_id, lender_org_id) references servicing.loan_accounts (id, lender_org_id) on delete restrict,
  constraint dates_ordered check (end_date > start_date and end_date <= start_date + 3650),
  constraint cancel_pair check ((cancel_requested_at is null) = (cancel_reason is null)),
  constraint live_has_provider_ref check (status not in ('active', 'paused') or provider_mandate_ref is not null),
  constraint cancel_sent_after_request check (cancel_sent_at is null or cancel_requested_at is not null)
);
create unique index mandates_provider_ref on payments.mandates (provider, provider_mandate_ref) where provider_mandate_ref is not null;
create unique index mandates_one_live_per_loan on payments.mandates (loan_account_id)
  where status in ('draft', 'registration_pending', 'active', 'paused', 'requires_reconciliation');
create index mandates_lender on payments.mandates (lender_org_id, status);
create index mandates_borrower on payments.mandates (borrower_id);
create index mandates_config on payments.mandates (config_id, lender_org_id);
create index mandates_loan on payments.mandates (loan_account_id, lender_org_id);
create index mandates_created_by on payments.mandates (created_by);
comment on table payments.mandates is
  'A repayment mandate with the LENDER as creditor (creditor_ref is the lender''s own verified merchant). Created in draft by payments.request_mandate; every later move is made by the system on a verified provider event or an authenticated status lookup (payments.mandate_transitions; the trigger refuses any other). Money limits and the masked account reference are fixed at creation. cancel_requested_at records a REQUEST: the mandate is cancelled only when the provider confirms it. At most one live mandate per loan. Never deleted. Owner: payments module.';
create trigger no_delete before delete on payments.mandates
  for each row execute function private.forbid_mutation();
create trigger no_truncate before truncate on payments.mandates
  for each statement execute function private.forbid_truncate();
create trigger guard before insert or update on payments.mandates
  for each row execute function private.guard_provider_mode('provider_mode');
create trigger set_updated_at before update on payments.mandates
  for each row execute function private.set_updated_at();

create or replace function private.protect_mandate()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_allowed text[];
  v_moving text[] := array['status', 'provider_mandate_ref', 'handoff_expires_at', 'last_event_at', 'cancel_requested_at', 'cancel_reason', 'cancel_sent_at', 'updated_at'];
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'a mandate starts as a draft' using errcode = 'P0001';
    end if;
    return new;
  end if;
  if (to_jsonb(new) - v_moving) is distinct from (to_jsonb(old) - v_moving) then
    raise exception 'a mandate keeps its lender, loan, rail, limits, dates and masked account' using errcode = 'P0001';
  end if;
  if old.provider_mandate_ref is not null and new.provider_mandate_ref is distinct from old.provider_mandate_ref then
    raise exception 'the provider reference of a mandate is set once' using errcode = 'P0001';
  end if;
  if old.cancel_requested_at is not null and (new.cancel_requested_at is distinct from old.cancel_requested_at or new.cancel_reason is distinct from old.cancel_reason) then
    raise exception 'a cancellation request is recorded once' using errcode = 'P0001';
  end if;
  if new.status is distinct from old.status then
    select t.allowed_actors into v_allowed from payments.mandate_transitions t where t.from_status = old.status and t.to_status = new.status;
    if v_allowed is null then
      raise exception 'mandate transition % -> % is not allowed', old.status, new.status using errcode = 'P0001';
    end if;
    if not (private.current_actor() = any (v_allowed)) then
      raise exception 'actor % may not move a mandate % -> %', private.current_actor(), old.status, new.status using errcode = '42501';
    end if;
  end if;
  return new;
end
$$;
revoke all on function private.protect_mandate() from public;
create trigger protect before insert or update on payments.mandates
  for each row execute function private.protect_mandate();

create table payments.mandate_events (
  id uuid primary key default private.uuid_v7(),
  mandate_id uuid not null,
  lender_org_id uuid not null,
  from_status text,
  to_status text not null,
  -- request = the borrower asked; handoff = the provider took the request; provider_event = a VERIFIED event; status_lookup = an authenticated lookup;
  -- system = a time-based rule (draft abandoned, end date passed).
  source text not null check (source in ('request', 'handoff', 'provider_event', 'status_lookup', 'system')),
  provider_event_id uuid references payments.provider_events (id) on delete restrict,
  observed_at timestamptz not null default clock_timestamp(),
  created_at timestamptz not null default clock_timestamp(),
  foreign key (mandate_id, lender_org_id) references payments.mandates (id, lender_org_id) on delete restrict,
  constraint event_source_has_event check ((source = 'provider_event') = (provider_event_id is not null))
);
create index mandate_events_mandate on payments.mandate_events (mandate_id, lender_org_id, created_at);
create index mandate_events_provider_event on payments.mandate_events (provider_event_id);
comment on table payments.mandate_events is
  'Append-only history of every mandate status change with its source: the verified provider event, an authenticated status lookup or a time-based system rule. The status column of payments.mandates is only the last of these. Owner: payments module.';
create trigger append_only before update or delete on payments.mandate_events
  for each row execute function private.forbid_mutation();
create trigger no_truncate before truncate on payments.mandate_events
  for each statement execute function private.forbid_truncate();

-- ---------------------------------------------------------------------------------------------
-- 4. Return-code classes (configuration, maintained from the sponsor bank or provider documentation; nothing seeded)
-- ---------------------------------------------------------------------------------------------
create table payments.mandate_return_codes (
  id uuid primary key default private.uuid_v7(),
  provider text not null references payments.provider_register (provider) on delete restrict,
  code text not null check (code ~ '^[A-Za-z0-9._:-]{1,40}$'),
  class text not null check (class in ('insufficient_funds', 'account_issue', 'mandate_issue', 'technical', 'other')),
  evidence_ref text not null check (evidence_ref ~ '^[A-Za-z0-9][A-Za-z0-9 ._:/#,()-]{2,199}$'),
  status text not null default 'active' check (status in ('active', 'retired')),
  set_by uuid not null references auth.users (id),
  set_at timestamptz not null default clock_timestamp(),
  unique (provider, code, set_at)
);
create unique index mandate_return_codes_active on payments.mandate_return_codes (provider, code) where status = 'active';
create index mandate_return_codes_set_by on payments.mandate_return_codes (set_by);
comment on table payments.mandate_return_codes is
  'How a provider''s return or reject code is classified, with the evidence it comes from. Nothing is seeded and no code list is hard-coded: an unlisted code is stored verbatim and unclassified. A change retires the old row and adds a new one. Written only by payments.set_return_code_class (platform.payments.providers.manage, aal2). Owner: payments module.';
create trigger no_delete before delete on payments.mandate_return_codes
  for each row execute function private.forbid_mutation();
create trigger no_truncate before truncate on payments.mandate_return_codes
  for each statement execute function private.forbid_truncate();

create or replace function payments.set_return_code_class(p_provider text, p_code text, p_class text, p_evidence_ref text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.accounts_require_platform(array['platform.payments.providers.manage']);
begin
  if p_provider is null or not exists (select 1 from payments.provider_register r where r.provider = p_provider)
     or p_code is null or p_code !~ '^[A-Za-z0-9._:-]{1,40}$'
     or p_class is null or p_class not in ('insufficient_funds', 'account_issue', 'mandate_issue', 'technical', 'other')
     or p_evidence_ref is null or p_evidence_ref !~ '^[A-Za-z0-9][A-Za-z0-9 ._:/#,()-]{2,199}$' then
    raise exception 'invalid return-code class' using errcode = '22023', hint = 'return_code_invalid';
  end if;
  update payments.mandate_return_codes set status = 'retired' where provider = p_provider and code = p_code and status = 'active';
  insert into payments.mandate_return_codes (provider, code, class, evidence_ref, set_by) values (p_provider, p_code, p_class, p_evidence_ref, v_uid);
  perform private.write_payments_audit(null, 'payments.return_code.set', 'provider', p_provider, jsonb_build_object('class', p_class));
  return 'set';
end
$$;
comment on function payments.set_return_code_class(text, text, text, text) is
  'platform.payments.providers.manage, aal2. Classifies one provider return code with the evidence it comes from (22023 return_code_invalid). Retires the previous classification of the same code. Applies to debits recorded afterwards; a recorded debit keeps its class.';

-- ---------------------------------------------------------------------------------------------
-- 5. Debits and the notices before them
-- ---------------------------------------------------------------------------------------------
create table payments.mandate_debits (
  id uuid primary key default private.uuid_v7(),
  lender_org_id uuid not null,
  mandate_id uuid not null,
  loan_account_id uuid not null,
  -- Planned debits carry the schedule they came from and the installment; an UNPLANNED debit (reported by the provider, not planned by us) has neither.
  planned boolean not null,
  schedule_snapshot_id uuid,
  installment_seq integer check (installment_seq is null or installment_seq between 1 and 100000),
  scheduled_on date not null,
  -- Equal to the lender-reported figure and never above the mandate maximum. An unplanned debit may arrive without an amount.
  amount_minor bigint check (amount_minor is null or amount_minor between 1 and 100000000000000),
  status text not null default 'scheduled' check (status in ('scheduled', 'notified', 'presented', 'unknown', 'settled', 'returned', 'cancelled')),
  rank smallint not null default 10 check (rank between 0 and 100),
  provider_debit_ref text check (provider_debit_ref is null or (length(provider_debit_ref) between 1 and 200 and provider_debit_ref ~ '^[A-Za-z0-9._:=+/-]+$')),
  -- The provider's code, verbatim, and the class the configuration gave it (null when the code is not classified).
  return_code text check (return_code is null or return_code ~ '^[A-Za-z0-9._:-]{1,40}$'),
  return_class text check (return_class is null or return_class in ('insufficient_funds', 'account_issue', 'mandate_issue', 'technical', 'other')),
  exceeds_mandate_max boolean not null default false,
  last_event_id uuid references payments.provider_events (id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (id, lender_org_id),
  foreign key (mandate_id, lender_org_id) references payments.mandates (id, lender_org_id) on delete restrict,
  foreign key (loan_account_id, lender_org_id) references servicing.loan_accounts (id, lender_org_id) on delete restrict,
  foreign key (schedule_snapshot_id, lender_org_id) references servicing.schedule_snapshots (id, lender_org_id) on delete restrict,
  constraint planned_has_installment check (planned = (schedule_snapshot_id is not null and installment_seq is not null)),
  constraint planned_has_amount check (not planned or amount_minor is not null),
  constraint return_code_only_when_returned check (return_code is null or status = 'returned'),
  constraint class_needs_code check (return_class is null or return_code is not null)
);
create unique index mandate_debits_one_per_installment on payments.mandate_debits (mandate_id, installment_seq) where planned;
create unique index mandate_debits_provider_ref on payments.mandate_debits (mandate_id, provider_debit_ref) where provider_debit_ref is not null;
create index mandate_debits_lender on payments.mandate_debits (lender_org_id, status, scheduled_on);
create index mandate_debits_mandate on payments.mandate_debits (mandate_id, lender_org_id);
create index mandate_debits_loan on payments.mandate_debits (loan_account_id, lender_org_id);
create index mandate_debits_snapshot on payments.mandate_debits (schedule_snapshot_id, lender_org_id);
create index mandate_debits_last_event on payments.mandate_debits (last_event_id);
comment on table payments.mandate_debits is
  'One row per instalment per mandate. A PLANNED debit comes from the lender''s reported schedule and figures (payments.plan_mandate_debits): its amount equals the reported figure and never exceeds the mandate maximum. An UNPLANNED debit is one the provider reported and we did not plan; it is recorded and flagged to the lender. status moves forward only (scheduled, notified, presented, then settled, returned or cancelled); a contradiction opens an exception and changes nothing. The return code is stored verbatim; return_class comes from payments.mandate_return_codes at the time it was recorded. A returned debit creates no Udofin charge. Written only by the mandate functions. Owner: payments module.';
create trigger no_delete before delete on payments.mandate_debits
  for each row execute function private.forbid_mutation();
create trigger no_truncate before truncate on payments.mandate_debits
  for each statement execute function private.forbid_truncate();
create trigger set_updated_at before update on payments.mandate_debits
  for each row execute function private.set_updated_at();

create or replace function private.protect_mandate_debit()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_moving text[] := array['status', 'rank', 'provider_debit_ref', 'return_code', 'return_class', 'exceeds_mandate_max', 'last_event_id', 'updated_at', 'amount_minor'];
begin
  if (to_jsonb(new) - v_moving) is distinct from (to_jsonb(old) - v_moving) then
    raise exception 'a debit keeps its mandate, loan, schedule and date' using errcode = 'P0001';
  end if;
  if old.planned and new.amount_minor is distinct from old.amount_minor then
    raise exception 'the planned amount of a debit does not change' using errcode = 'P0001';
  end if;
  if old.amount_minor is not null and new.amount_minor is distinct from old.amount_minor then
    raise exception 'a recorded amount does not change' using errcode = 'P0001';
  end if;
  if old.provider_debit_ref is not null and new.provider_debit_ref is distinct from old.provider_debit_ref then
    raise exception 'the provider reference of a debit is set once' using errcode = 'P0001';
  end if;
  if new.rank < old.rank then
    raise exception 'a debit only moves to a higher rank' using errcode = 'P0001';
  end if;
  if old.return_code is not null and new.return_code is distinct from old.return_code then
    raise exception 'the return code of a debit is set once' using errcode = 'P0001';
  end if;
  return new;
end
$$;
revoke all on function private.protect_mandate_debit() from public;
create trigger protect before update on payments.mandate_debits
  for each row execute function private.protect_mandate_debit();

create table payments.pre_debit_notices (
  id uuid primary key default private.uuid_v7(),
  lender_org_id uuid not null,
  debit_id uuid not null,
  mandate_id uuid not null,
  borrower_id uuid not null references identity.borrowers (id) on delete restrict,
  -- The latest moment the notice should go out: the start of the debit date (IST) minus the lender's lead time.
  notice_due_at timestamptz not null,
  -- late = planned too close to the debit to give the full lead time: flagged to the lender, never hidden.
  status text not null default 'planned' check (status in ('planned', 'sent', 'late', 'not_needed')),
  delivery_state text check (delivery_state is null or delivery_state in ('accepted', 'delivered')),
  sent_at timestamptz,
  claimed_until timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (debit_id),
  foreign key (debit_id, lender_org_id) references payments.mandate_debits (id, lender_org_id) on delete restrict,
  foreign key (mandate_id, lender_org_id) references payments.mandates (id, lender_org_id) on delete restrict,
  constraint sent_has_time check ((sent_at is not null) = (delivery_state is not null))
);
create index pre_debit_notices_due on payments.pre_debit_notices (notice_due_at) where status in ('planned', 'late') and sent_at is null;
create index pre_debit_notices_lender on payments.pre_debit_notices (lender_org_id, status);
create index pre_debit_notices_mandate on payments.pre_debit_notices (mandate_id, lender_org_id);
create index pre_debit_notices_borrower on payments.pre_debit_notices (borrower_id);
comment on table payments.pre_debit_notices is
  'The service notice sent to the borrower before each planned debit: when it was due, whether it went out and the delivery state the channel reported. A notice planned too close to its debit is marked late and the lender is told (mandate_notice_late); the debit is never silently presented. The notice carries no wording of its own in the database: the app shows a fixed factual line (amount, date). Written only by the mandate functions. Owner: payments module.';
create trigger no_delete before delete on payments.pre_debit_notices
  for each row execute function private.forbid_mutation();
create trigger no_truncate before truncate on payments.pre_debit_notices
  for each statement execute function private.forbid_truncate();
create trigger set_updated_at before update on payments.pre_debit_notices
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- 6. Small pure helpers
-- ---------------------------------------------------------------------------------------------
-- Provider status (platform vocabulary, see packages/adapters PlatformEventStatus) to the mandate state it reports. Null = not a mandate status.
create or replace function private.mandate_status_from_provider(p_status text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case p_status when 'pending' then 'registration_pending' when 'registration_pending' then 'registration_pending' when 'active' then 'active'
    when 'rejected' then 'rejected' when 'failed' then 'failed' when 'expired' then 'expired' when 'paused' then 'paused'
    when 'cancelled' then 'cancelled' when 'revoked' then 'revoked' end
$$;

-- Provider status of a DEBIT event to the debit status it reports. Null = not a debit status.
create or replace function private.debit_status_from_provider(p_status text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case p_status when 'created' then 'scheduled' when 'pending' then 'presented' when 'authorized' then 'presented'
    when 'captured' then 'settled' when 'paid' then 'settled' when 'succeeded' then 'settled'
    when 'returned' then 'returned' when 'failed' then 'returned' when 'cancelled' then 'cancelled' end
$$;

create or replace function private.debit_rank(p_status text)
returns smallint
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case p_status when 'scheduled' then 10 when 'notified' then 20 when 'presented' then 30 when 'unknown' then 35
    when 'settled' then 40 when 'returned' then 40 when 'cancelled' then 40 end::smallint
$$;

-- ---------------------------------------------------------------------------------------------
-- 7. Moving a mandate (system only: these helpers have no grants; the definer functions call them)
-- ---------------------------------------------------------------------------------------------
create or replace function private.mandate_move(p_mandate uuid, p_to text, p_source text, p_event uuid, p_observed timestamptz)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  m payments.mandates;
begin
  select * into m from payments.mandates x where x.id = p_mandate;
  update payments.mandates set status = p_to, last_event_at = greatest(coalesce(last_event_at, p_observed), p_observed) where id = p_mandate;
  insert into payments.mandate_events (mandate_id, lender_org_id, from_status, to_status, source, provider_event_id, observed_at)
  values (m.id, m.lender_org_id, m.status, p_to, p_source, p_event, p_observed);
end
$$;
revoke all on function private.mandate_move(uuid, text, text, uuid, timestamptz) from public;

-- The one rule for a status report (a verified event, an authenticated lookup): stale reports and repeats change nothing, an allowed
-- transition is applied, and anything else (a contradiction) opens an exception and changes nothing. Returns the event_processing outcome.
create or replace function private.apply_mandate_status(p_mandate uuid, p_new text, p_source text, p_event uuid, p_observed timestamptz)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  m payments.mandates;
begin
  select * into m from payments.mandates x where x.id = p_mandate for update;
  if not found then
    raise exception 'mandate not found' using errcode = 'P0002';
  end if;
  if m.last_event_at is not null and p_observed < m.last_event_at then
    return 'ignored_stale';
  end if;
  if p_new = m.status then
    return 'ignored_stale';
  end if;
  if exists (select 1 from payments.mandate_transitions t where t.from_status = m.status and t.to_status = p_new) then
    perform private.mandate_move(m.id, p_new, p_source, p_event, p_observed);
    return 'applied';
  end if;
  perform private.raise_exception_impl(m.lender_org_id, 'mandate_status_conflict', 'warning', 'lender', jsonb_build_object('mandate_id', m.id::text));
  return 'exception';
end
$$;
revoke all on function private.apply_mandate_status(uuid, text, text, uuid, timestamptz) from public;

-- One observation of a debit (a verified event or an authenticated lookup). Attaches to the one planned debit it matches (same amount, date within
-- three days), otherwise records an UNPLANNED debit and tells the lender. Forward only; a contradiction changes nothing and opens an exception.
create or replace function private.apply_debit_observation(
  p_mandate uuid, p_debit_ref text, p_scheduled_on date, p_amount bigint, p_status text, p_return_code text, p_event uuid, p_observed timestamptz)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  m payments.mandates;
  d payments.mandate_debits;
  v_on date := coalesce(p_scheduled_on, (p_observed at time zone 'Asia/Kolkata')::date);
  v_n integer;
  v_rank smallint := private.debit_rank(p_status);
  v_class text;
  v_new boolean := false;
  v_changed boolean := false;
begin
  select * into m from payments.mandates x where x.id = p_mandate for update;
  if not found then
    raise exception 'mandate not found' using errcode = 'P0002';
  end if;
  if v_rank is null then
    return 'ignored_unsupported';
  end if;
  select * into d from payments.mandate_debits x where x.mandate_id = m.id and x.provider_debit_ref = p_debit_ref for update;
  if not found then
    select count(*) into v_n from payments.mandate_debits x
     where x.mandate_id = m.id and x.planned and x.provider_debit_ref is null and x.status in ('scheduled', 'notified')
       and p_amount is not null and x.amount_minor = p_amount and abs(x.scheduled_on - v_on) <= 3;
    if v_n = 1 then
      select * into d from payments.mandate_debits x
       where x.mandate_id = m.id and x.planned and x.provider_debit_ref is null and x.status in ('scheduled', 'notified')
         and x.amount_minor = p_amount and abs(x.scheduled_on - v_on) <= 3 for update;
      update payments.mandate_debits set provider_debit_ref = p_debit_ref where id = d.id returning * into d;
    else
      insert into payments.mandate_debits (lender_org_id, mandate_id, loan_account_id, planned, scheduled_on, amount_minor, provider_debit_ref)
      values (m.lender_org_id, m.id, m.loan_account_id, false, v_on, p_amount, p_debit_ref)
      returning * into d;
      v_new := true;
      perform private.raise_exception_impl(m.lender_org_id, 'mandate_debit_unresolved', 'warning', 'lender', jsonb_build_object('debit_id', d.id::text));
    end if;
  end if;
  -- A debit on a mandate that is not (or no longer) in force is recorded and shown to the lender; it is never ignored.
  if m.status not in ('active', 'paused', 'cancelled', 'revoked', 'expired') and not v_new then
    perform private.raise_exception_impl(m.lender_org_id, 'mandate_debit_unresolved', 'warning', 'lender', jsonb_build_object('debit_id', d.id::text));
  end if;
  if p_amount is not null and d.amount_minor is null then
    update payments.mandate_debits set amount_minor = p_amount where id = d.id returning * into d;
    v_changed := true;
  end if;
  if p_amount is not null and p_amount > m.max_amount_minor and not d.exceeds_mandate_max then
    update payments.mandate_debits set exceeds_mandate_max = true where id = d.id returning * into d;
    perform private.raise_exception_impl(m.lender_org_id, 'amount_mismatch', 'critical', 'lender', jsonb_build_object('debit_id', d.id::text));
    v_changed := true;
  end if;
  if d.rank >= 40 and p_status <> d.status and v_rank >= 40 then
    -- settled after returned, returned after settled, cancelled after either: no automatic answer.
    perform private.raise_exception_impl(m.lender_org_id, 'mandate_debit_unresolved', 'warning', 'lender', jsonb_build_object('debit_id', d.id::text));
    return 'exception';
  end if;
  if v_rank <= d.rank and not (d.status = 'returned' and p_status = 'returned' and d.return_code is null and p_return_code is not null) then
    return case when v_new or v_changed then 'applied' else 'ignored_stale' end;
  end if;
  if p_status = 'returned' and p_return_code is not null then
    select c.class into v_class from payments.mandate_return_codes c where c.provider = m.provider and c.code = p_return_code and c.status = 'active';
  end if;
  update payments.mandate_debits set
    status = p_status, rank = greatest(rank, v_rank), last_event_id = coalesce(p_event, last_event_id),
    return_code = case when p_status = 'returned' then coalesce(return_code, p_return_code) else return_code end,
    return_class = case when p_status = 'returned' and return_code is null and p_return_code is not null then v_class else return_class end
   where id = d.id;
  return 'applied';
end
$$;
revoke all on function private.apply_debit_observation(uuid, text, date, bigint, text, text, uuid, timestamptz) from public;

-- ---------------------------------------------------------------------------------------------
-- 8. The hooks of the provider-event pipeline (replacing the placeholders of migration 20261018000913)
-- ---------------------------------------------------------------------------------------------
-- Which mandate of THIS configuration's lender and provider a mandate or debit event belongs to (null = unmatched).
create or replace function private.correlate_mandate_event(p_config uuid, p_object_kind text, p_object_ref text, p_order_ref text)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c payments.lender_payment_configs;
  v_ref text;
  v_id uuid;
begin
  select * into c from payments.lender_payment_configs x where x.id = p_config;
  if not found then
    return null;
  end if;
  v_ref := case when p_object_kind = 'mandate' then p_object_ref else p_order_ref end;
  if v_ref is not null then
    select m.id into v_id from payments.mandates m where m.lender_org_id = c.lender_org_id and m.provider = c.provider and m.provider_mandate_ref = v_ref;
  end if;
  if v_id is null and p_object_kind = 'debit' then
    select d.mandate_id into v_id from payments.mandate_debits d join payments.mandates m on m.id = d.mandate_id and m.lender_org_id = d.lender_org_id
     where d.lender_org_id = c.lender_org_id and m.provider = c.provider and d.provider_debit_ref = p_object_ref limit 1;
  end if;
  return v_id;
end
$$;
revoke all on function private.correlate_mandate_event(uuid, text, text, text) from public;

create or replace function private.apply_mandate_event(p_event uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  e payments.provider_events;
  v_mandate uuid;
  v_new text;
begin
  select * into e from payments.provider_events x where x.id = p_event;
  v_mandate := private.correlate_mandate_event(e.config_id, e.object_kind, e.object_ref, e.order_ref);
  if v_mandate is null then
    raise exception 'the event has no mandate' using errcode = '55000', hint = 'event_not_correlated';
  end if;
  if e.object_kind = 'mandate' then
    v_new := private.mandate_status_from_provider(e.provider_status);
    if v_new is null then
      return 'ignored_unsupported';
    end if;
    return private.apply_mandate_status(v_mandate, v_new, 'provider_event', e.id, coalesce(e.occurred_at, e.received_at));
  end if;
  return private.apply_debit_observation(v_mandate, e.object_ref, null, e.amount_minor, coalesce(private.debit_status_from_provider(e.provider_status), 'unknown'), null,
                                         e.id, coalesce(e.occurred_at, e.received_at));
end
$$;
revoke all on function private.apply_mandate_event(uuid) from public;

-- ---------------------------------------------------------------------------------------------
-- 9. The borrower
-- ---------------------------------------------------------------------------------------------
create or replace function payments.request_mandate(
  p_mandate uuid, p_loan uuid, p_rail text, p_max_amount_minor bigint, p_start_date date, p_end_date date, p_masked_account_ref text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_borrower uuid := private.my_borrower_id();
  l servicing.loan_accounts;
  v_existing payments.mandates;
  v_cfg payments.lender_payment_configs;
  v_prov payments.provider_register;
  v_mer payments.merchant_registry;
  v_pol payments.lender_mandate_policies;
  v_n integer;
  v_lim jsonb;
  v_rail_max bigint;
  v_cap bigint;
  v_max bigint;
  v_today date := (clock_timestamp() at time zone 'Asia/Kolkata')::date;
begin
  if v_uid is null or v_borrower is null then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  if p_mandate is null or p_loan is null or p_rail is null or p_rail not in ('enach_api', 'upi_autopay') then
    raise exception 'invalid mandate request' using errcode = '22023', hint = 'bad_request';
  end if;
  select * into l from servicing.loan_accounts la where la.id = p_loan and la.borrower_id = v_borrower;
  if not found then
    raise exception 'loan not found' using errcode = 'P0002';
  end if;
  perform private.require_feature(l.lender_org_id, 'mandates');

  -- A replay of the same request returns the same mandate; the same id with different content is a conflict.
  select * into v_existing from payments.mandates x where x.id = p_mandate;
  if found then
    if (v_existing.borrower_id, v_existing.loan_account_id, v_existing.rail, v_existing.start_date, v_existing.end_date, v_existing.masked_account_ref)
       is distinct from (v_borrower, p_loan, p_rail, p_start_date, p_end_date, p_masked_account_ref)
       or (p_max_amount_minor is not null and p_max_amount_minor <> v_existing.max_amount_minor) then
      raise exception 'this mandate id was already used for a different request' using errcode = '23505', hint = 'idempotency_conflict';
    end if;
    return v_existing.id;
  end if;

  if l.status <> 'active' then
    raise exception 'only an active loan can have a mandate' using errcode = '55000', hint = 'loan_not_active';
  end if;
  if p_masked_account_ref is null or p_masked_account_ref !~ '^[X*]{2,}[0-9]{2,4}$' then
    raise exception 'the account must be a masked reference' using errcode = '22023', hint = 'account_ref_invalid';
  end if;
  if p_start_date is null or p_end_date is null or p_start_date < v_today or p_end_date <= p_start_date or p_end_date > p_start_date + 3650 then
    raise exception 'invalid mandate dates' using errcode = '22023', hint = 'dates_invalid';
  end if;

  -- The creditor is the lender: its one active configuration, valid as a collection target, with its own verified merchant.
  select count(*) into v_n from payments.lender_payment_configs c where c.lender_org_id = l.lender_org_id and c.status = 'active';
  if v_n = 0 then
    raise exception 'collection target invalid: config_not_active' using errcode = '55000', hint = 'collection_target_invalid';
  elsif v_n > 1 then
    raise exception 'more than one active payment configuration' using errcode = '55000', hint = 'config_ambiguous';
  end if;
  select * into v_cfg from payments.lender_payment_configs c where c.lender_org_id = l.lender_org_id and c.status = 'active';
  if not (private.validate_collection_target_impl(v_cfg.id) ->> 'ok')::boolean then
    raise exception 'collection target invalid: %', private.validate_collection_target_impl(v_cfg.id) -> 'reasons' ->> 0 using errcode = '55000', hint = 'collection_target_invalid';
  end if;
  select * into v_prov from payments.provider_register p where p.provider = v_cfg.provider;
  if not found or v_prov.status <> 'approved' or v_prov.kind not in ('mandate', 'payment_and_mandate') then
    raise exception 'the provider does not offer mandates' using errcode = '55000', hint = 'provider_not_mandate_capable';
  end if;
  select * into v_mer from payments.merchant_registry m where m.id = v_cfg.merchant_registry_id;
  if not found or v_mer.owner_org_id is distinct from l.lender_org_id then
    raise exception 'the creditor must be the lender' using errcode = '55000', hint = 'creditor_not_lender';
  end if;

  -- Limits copied from the provider documentation into the configuration. Without them the rail is not configured: nothing is assumed.
  v_lim := v_cfg.rail_limits -> p_rail;
  if v_lim is null or (v_lim ->> 'max_mandate_amount_minor') is null or (v_lim ->> 'max_mandate_amount_minor') !~ '^[0-9]{1,15}$'
     or jsonb_typeof(v_lim -> 'needs_afa_each_debit') is distinct from 'boolean' then
    raise exception 'this rail is not configured for the lender' using errcode = '55000', hint = 'rail_not_configured';
  end if;
  v_rail_max := (v_lim ->> 'max_mandate_amount_minor')::bigint;
  select * into v_pol from payments.lender_mandate_policies p where p.lender_org_id = l.lender_org_id;
  v_cap := least(v_rail_max, coalesce(v_pol.max_amount_cap_minor, v_rail_max));
  v_max := coalesce(p_max_amount_minor, v_cap);
  if v_max <= 0 or v_max > v_cap then
    raise exception 'the maximum amount must be between 1 paisa and the lower of the rail limit and the lender''s ceiling' using errcode = '22023', hint = 'amount_not_allowed';
  end if;

  -- The tiered device-integrity result and the step-up code bound to THIS mandate (checked last, so a refused request does not spend the code).
  if identity.current_integrity_level() not in ('device', 'strong') then
    raise exception 'the device integrity check is not sufficient for a mandate' using errcode = '42501', hint = 'integrity_insufficient';
  end if;
  perform identity.stepup_consume('mandate_creation', p_mandate::text);

  begin
    insert into payments.mandates (id, lender_org_id, config_id, borrower_id, loan_account_id, rail, provider, provider_mode, creditor_ref, max_amount_minor,
                                   start_date, end_date, masked_account_ref, needs_afa_each_debit, created_by)
    values (p_mandate, l.lender_org_id, v_cfg.id, v_borrower, p_loan, p_rail, v_cfg.provider, v_cfg.provider_mode, v_mer.merchant_ref, v_max,
            p_start_date, p_end_date, p_masked_account_ref, (v_lim ->> 'needs_afa_each_debit')::boolean, v_uid);
  exception when unique_violation then
    raise exception 'the loan already has a mandate in progress' using errcode = '23505', hint = 'mandate_exists';
  end;
  insert into payments.mandate_events (mandate_id, lender_org_id, from_status, to_status, source) values (p_mandate, l.lender_org_id, null, 'draft', 'request');
  -- The worker (which alone holds the lender's provider credentials) asks the provider for the hand-off; ids only, never the link.
  perform ops.enqueue_event('mandate.handoff', jsonb_build_object('mandate_id', p_mandate), null, 'mandate.handoff:' || p_mandate::text);
  perform private.write_payments_audit(l.lender_org_id, 'payments.mandate.requested', 'mandate', p_mandate::text, jsonb_build_object('rail', p_rail, 'provider_mode', v_cfg.provider_mode::text));
  return p_mandate;
end
$$;
comment on function payments.request_mandate(uuid, uuid, text, bigint, date, date, text) is
  'The ONLY way a mandate is created. The signed-in borrower asks for a mandate on their own active loan. Needs the mandates switch, the lender''s one active valid collection target (the creditor is the lender''s own verified merchant), a provider that offers mandates, rail limits in the configuration (55000 rail_not_configured), a maximum within the lower of the rail limit and the lender''s ceiling, a masked account reference, a device-integrity result of at least "device" (42501 integrity_insufficient) and a step-up code bound to this mandate id (42501 stepup_required). Creates a DRAFT: nothing is registered until the system hands the request to the provider and a verified event or authenticated lookup says so. The same id with the same content returns the same mandate.';

create or replace function payments.request_mandate_cancellation(p_mandate uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_borrower uuid := private.my_borrower_id();
  m payments.mandates;
begin
  if (select auth.uid()) is null or v_borrower is null then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  select * into m from payments.mandates x where x.id = p_mandate and x.borrower_id = v_borrower for update;
  if not found then
    raise exception 'mandate not found' using errcode = 'P0002';
  end if;
  if m.status not in ('draft', 'registration_pending', 'active', 'paused', 'requires_reconciliation') then
    raise exception 'the mandate is already finished' using errcode = '55000', hint = 'mandate_finished';
  end if;
  if m.cancel_requested_at is not null then
    return 'cancel_requested';
  end if;
  update payments.mandates set cancel_requested_at = clock_timestamp(), cancel_reason = 'borrower' where id = m.id;
  perform ops.enqueue_event('mandate.cancel', jsonb_build_object('mandate_id', m.id), null, 'mandate.cancel:' || m.id::text);
  perform private.write_payments_audit(m.lender_org_id, 'payments.mandate.cancel_requested', 'mandate', m.id::text, jsonb_build_object('reason', 'borrower'));
  return 'cancel_requested';
end
$$;
comment on function payments.request_mandate_cancellation(uuid) is
  'Borrower only. Records the REQUEST to cancel their own live mandate and queues it for the provider. The mandate becomes cancelled only when the provider confirms it (a verified event or an authenticated lookup), or, for a draft the provider never saw, when the sweep abandons it. Idempotent.';

create or replace function payments.my_mandates()
returns table (
  mandate_id uuid, loan_account_id uuid, lender_display_name text, rail text, status text, max_amount_minor bigint, start_date date, end_date date,
  masked_account_ref text, needs_afa_each_debit boolean, cancel_requested boolean, next_debit_on date, next_debit_minor bigint, next_debit_notified boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select m.id, m.loan_account_id, o.display_name, m.rail, m.status, m.max_amount_minor, m.start_date, m.end_date, m.masked_account_ref, m.needs_afa_each_debit,
         m.cancel_requested_at is not null, nd.scheduled_on, nd.amount_minor, nd.status = 'notified'
  from payments.mandates m
  join tenancy.organizations o on o.id = m.lender_org_id
  left join lateral (
    select d.scheduled_on, d.amount_minor, d.status from payments.mandate_debits d
     where d.mandate_id = m.id and d.status in ('scheduled', 'notified') and d.scheduled_on >= (clock_timestamp() at time zone 'Asia/Kolkata')::date
     order by d.scheduled_on limit 1) nd on true
  where m.borrower_id = (select private.my_borrower_id()) and private.feature_enabled(m.lender_org_id, 'mandates')
  order by m.created_at desc
$$;
comment on function payments.my_mandates() is
  'Borrower only (empty for anyone else). The caller''s mandates with the status exactly as the provider-confirmed history last left it, the masked account, the limits, whether a cancellation was requested, and the next planned debit. A draft or pending mandate is shown as such: nothing is "active" until the provider says so. Lenders whose mandates switch is off are not listed.';

-- ---------------------------------------------------------------------------------------------
-- 10. The system: hand-off, lookups, cancellation, sweeps, debits, notices
-- ---------------------------------------------------------------------------------------------
-- The result of asking the provider for a hand-off. handoff: the provider took the request (NOT an activation); rejected: a definite refusal;
-- unknown: the provider may have acted (timeout, 5xx): look the mandate up by its id before any retry.
create or replace function payments.record_mandate_handoff(p_mandate uuid, p_outcome text, p_provider_mandate_ref text default null, p_expires_at timestamptz default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  m payments.mandates;
begin
  if private.invoking_role() <> 'service_role' then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  if p_outcome is null or p_outcome not in ('handoff', 'rejected', 'unknown')
     or (p_outcome = 'handoff' and (p_provider_mandate_ref is null or p_provider_mandate_ref !~ '^[A-Za-z0-9._:=+/-]{1,200}$'))
     or (p_outcome <> 'handoff' and p_provider_mandate_ref is not null) then
    raise exception 'invalid hand-off result' using errcode = '22023', hint = 'bad_request';
  end if;
  select * into m from payments.mandates x where x.id = p_mandate for update;
  if not found then
    raise exception 'mandate not found' using errcode = 'P0002';
  end if;
  if m.status <> 'draft' then
    return m.status;
  end if;
  if p_outcome = 'handoff' then
    update payments.mandates set provider_mandate_ref = p_provider_mandate_ref, handoff_expires_at = p_expires_at where id = m.id;
    perform private.mandate_move(m.id, 'registration_pending', 'handoff', null, clock_timestamp());
    return 'registration_pending';
  elsif p_outcome = 'rejected' then
    perform private.mandate_move(m.id, 'failed', 'handoff', null, clock_timestamp());
    return 'failed';
  end if;
  perform private.mandate_move(m.id, 'requires_reconciliation', 'handoff', null, clock_timestamp());
  perform private.raise_exception_impl(m.lender_org_id, 'mandate_unresolved', 'warning', 'platform', jsonb_build_object('mandate_id', m.id::text));
  return 'requires_reconciliation';
end
$$;
comment on function payments.record_mandate_handoff(uuid, text, text, timestamptz) is
  'System only. Records what the provider answered to the hand-off request: handoff (draft -> registration_pending, the provider reference is stored; NOT an activation), rejected (draft -> failed) or unknown (draft -> requires_reconciliation and a platform exception: look the mandate up before any retry). A mandate that has already left the draft answers its status.';

-- An authenticated provider status lookup (the adapter checked the answer came from the provider). Same standing as a verified event.
create or replace function payments.apply_mandate_lookup(p_mandate uuid, p_provider_status text, p_provider_mandate_ref text default null, p_observed_at timestamptz default clock_timestamp())
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  m payments.mandates;
  v_new text := private.mandate_status_from_provider(p_provider_status);
begin
  if private.invoking_role() <> 'service_role' then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  if v_new is null or (p_provider_mandate_ref is not null and p_provider_mandate_ref !~ '^[A-Za-z0-9._:=+/-]{1,200}$') or p_observed_at is null then
    raise exception 'invalid lookup result' using errcode = '22023', hint = 'bad_request';
  end if;
  select * into m from payments.mandates x where x.id = p_mandate for update;
  if not found then
    raise exception 'mandate not found' using errcode = 'P0002';
  end if;
  if p_provider_mandate_ref is not null and m.provider_mandate_ref is null then
    update payments.mandates set provider_mandate_ref = p_provider_mandate_ref where id = m.id;
  elsif p_provider_mandate_ref is not null and m.provider_mandate_ref is distinct from p_provider_mandate_ref then
    raise exception 'the provider reference differs from the stored one' using errcode = '55000', hint = 'provider_ref_mismatch';
  end if;
  return private.apply_mandate_status(m.id, v_new, 'status_lookup', null, p_observed_at);
end
$$;
comment on function payments.apply_mandate_lookup(uuid, text, text, timestamptz) is
  'System only. Applies an AUTHENTICATED provider status lookup with the same rules as a verified event (stale or repeated: nothing; allowed transition: applied; contradiction: an exception and nothing changes). May supply the provider reference of a mandate whose hand-off outcome was unknown. Returns the outcome.';

create or replace function payments.apply_debit_lookup(
  p_mandate uuid, p_provider_debit_ref text, p_scheduled_on date, p_amount_minor bigint, p_status text, p_return_code text default null, p_observed_at timestamptz default clock_timestamp())
returns text
language plpgsql
security definer
set search_path = ''
as $$
begin
  if private.invoking_role() <> 'service_role' then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  if p_provider_debit_ref is null or p_provider_debit_ref !~ '^[A-Za-z0-9._:=+/-]{1,200}$' or p_scheduled_on is null
     or p_amount_minor is null or p_amount_minor not between 1 and 100000000000000 or p_status is null or private.debit_rank(p_status) is null
     or (p_return_code is not null and (p_status <> 'returned' or p_return_code !~ '^[A-Za-z0-9._:-]{1,40}$')) or p_observed_at is null then
    raise exception 'invalid debit report' using errcode = '22023', hint = 'bad_request';
  end if;
  return private.apply_debit_observation(p_mandate, p_provider_debit_ref, p_scheduled_on, p_amount_minor, p_status, p_return_code, null, p_observed_at);
end
$$;
comment on function payments.apply_debit_lookup(uuid, text, date, bigint, text, text, timestamptz) is
  'System only. Applies an authenticated provider debit report (the list the mandate port returns) with the same rules as a verified debit event; the provider''s return code is stored verbatim and classified from payments.mandate_return_codes. Returns the outcome.';

create or replace function payments.mark_mandate_cancel_sent(p_mandate uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
begin
  if private.invoking_role() <> 'service_role' then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  update payments.mandates set cancel_sent_at = clock_timestamp() where id = p_mandate and cancel_requested_at is not null and cancel_sent_at is null;
  if not found and not exists (select 1 from payments.mandates x where x.id = p_mandate) then
    raise exception 'mandate not found' using errcode = 'P0002';
  end if;
  return 'ok';
end
$$;
comment on function payments.mark_mandate_cancel_sent(uuid) is
  'System only. Records that the cancellation request reached the provider. The mandate stays as it is: it is cancelled only when the provider confirms.';

-- Closure of a loan cancels its mandate: a request per live mandate, to be confirmed by the provider.
create or replace function payments.request_cancel_for_closed_loans()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  m record;
  v_n integer := 0;
begin
  if private.invoking_role() <> 'service_role' then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  for m in
    select x.id, x.lender_org_id from payments.mandates x join servicing.loan_accounts la on la.id = x.loan_account_id and la.lender_org_id = x.lender_org_id
     where x.status in ('draft', 'registration_pending', 'active', 'paused', 'requires_reconciliation') and x.cancel_requested_at is null and la.status <> 'active'
     for update of x skip locked
  loop
    update payments.mandates set cancel_requested_at = clock_timestamp(), cancel_reason = 'loan_closed' where id = m.id;
    perform ops.enqueue_event('mandate.cancel', jsonb_build_object('mandate_id', m.id), null, 'mandate.cancel:' || m.id::text);
    v_n := v_n + 1;
  end loop;
  return v_n;
end
$$;
comment on function payments.request_cancel_for_closed_loans() is
  'System only. For every live mandate of a loan the lender reported closed or foreclosed, records a cancellation request and queues it. Idempotent. Returns how many were requested.';

-- Time-based rules and the things nobody has confirmed. Returns counts.
create or replace function payments.sweep_mandates(p_draft_grace interval default interval '1 hour', p_cancel_grace interval default interval '24 hours', p_unresolved_after interval default interval '24 hours')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  m record;
  v_drafts integer := 0;
  v_expired integer := 0;
  v_cancel integer := 0;
  v_unresolved integer := 0;
  v_today date := (clock_timestamp() at time zone 'Asia/Kolkata')::date;
begin
  if private.invoking_role() <> 'service_role' then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  -- A draft the provider never saw (abandoned, or cancelled by the borrower) is closed by the system.
  for m in select x.id from payments.mandates x where x.status = 'draft' and (x.cancel_requested_at is not null or x.created_at < clock_timestamp() - p_draft_grace) for update skip locked loop
    perform private.mandate_move(m.id, 'cancelled', 'system', null, clock_timestamp());
    v_drafts := v_drafts + 1;
  end loop;
  -- The end date has passed.
  for m in select x.id from payments.mandates x where x.status in ('active', 'paused') and x.end_date < v_today for update skip locked loop
    perform private.mandate_move(m.id, 'expired', 'system', null, clock_timestamp());
    v_expired := v_expired + 1;
  end loop;
  -- A cancellation the provider has not confirmed.
  for m in select x.id, x.lender_org_id from payments.mandates x
            where x.status in ('registration_pending', 'active', 'paused', 'requires_reconciliation') and x.cancel_requested_at is not null
              and coalesce(x.cancel_sent_at, x.cancel_requested_at) < clock_timestamp() - p_cancel_grace loop
    perform private.raise_exception_impl(m.lender_org_id, 'mandate_cancel_unconfirmed', 'warning', 'lender', jsonb_build_object('mandate_id', m.id::text));
    v_cancel := v_cancel + 1;
  end loop;
  -- An outcome nobody could establish.
  for m in select x.id, x.lender_org_id from payments.mandates x where x.status = 'requires_reconciliation' and x.updated_at < clock_timestamp() - p_unresolved_after loop
    perform private.raise_exception_impl(m.lender_org_id, 'mandate_unresolved', 'warning', 'platform', jsonb_build_object('mandate_id', m.id::text));
    v_unresolved := v_unresolved + 1;
  end loop;
  return jsonb_build_object('drafts_closed', v_drafts, 'expired', v_expired, 'cancel_unconfirmed', v_cancel, 'unresolved', v_unresolved);
end
$$;
comment on function payments.sweep_mandates(interval, interval, interval) is
  'System only (a periodic worker). Closes abandoned or borrower-cancelled drafts (cancelled, source system), expires active or paused mandates past their end date, and opens exceptions for a cancellation request the provider has not confirmed (mandate_cancel_unconfirmed) and for an outcome that stayed unresolved (mandate_unresolved). Idempotent. Returns counts.';

-- Mandates whose state the worker should ask the provider about (a pending registration that has stayed pending, an unknown outcome, a cancellation not yet seen).
create or replace function payments.mandates_needing_lookup(p_pending_after interval default interval '30 minutes')
returns table (mandate_id uuid, lender_org_id uuid, provider text, provider_mandate_ref text, status text, reason text)
language sql
stable
security definer
set search_path = ''
as $$
  select m.id, m.lender_org_id, m.provider, m.provider_mandate_ref, m.status,
         case when m.status = 'requires_reconciliation' then 'unknown_outcome'
              when m.cancel_requested_at is not null then 'cancellation_unconfirmed'
              else 'registration_pending' end
    from payments.mandates m
   where case when private.invoking_role() <> 'service_role' then false
              else (m.status = 'requires_reconciliation')
                or (m.status = 'registration_pending' and m.updated_at < clock_timestamp() - p_pending_after)
                or (m.status in ('active', 'paused') and m.cancel_requested_at is not null and coalesce(m.cancel_sent_at, m.cancel_requested_at) < clock_timestamp() - p_pending_after) end
   order by m.updated_at
$$;
comment on function payments.mandates_needing_lookup(interval) is
  'System only. Mandates whose state a worker should look up at the provider: an unknown hand-off outcome, a registration that has stayed pending, a cancellation that has not been seen. The lookup result goes through payments.apply_mandate_lookup.';

-- Planned debits and their notices, from the lender''s REPORTED schedule and figures. Udofin does not present debits.
create or replace function payments.plan_mandate_debits(p_horizon interval default interval '10 days')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  v_today date := (clock_timestamp() at time zone 'Asia/Kolkata')::date;
  v_amount bigint;
  v_lead integer;
  v_due timestamptz;
  v_debit uuid;
  v_planned integer := 0;
  v_over integer := 0;
  v_late integer := 0;
begin
  if private.invoking_role() <> 'service_role' then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  if p_horizon is null or p_horizon < interval '1 hour' or p_horizon > interval '120 days' then
    raise exception 'invalid planning window' using errcode = '22023', hint = 'bad_request';
  end if;
  for r in
    select m.id as mandate_id, m.lender_org_id, m.loan_account_id, m.borrower_id, m.max_amount_minor, s.id as snapshot_id, i.seq, i.due_date, i.total_minor,
           fig.ok, fig.stale, fig.next_due_on, fig.next_due_minor
      from payments.mandates m
      join servicing.loan_accounts la on la.id = m.loan_account_id and la.lender_org_id = m.lender_org_id and la.status = 'active'
      cross join lateral private.reminder_figures(m.loan_account_id) fig
      join lateral (select x.id from servicing.schedule_snapshots x where x.loan_account_id = m.loan_account_id order by x.version desc limit 1) s on true
      join servicing.schedule_installments i on i.snapshot_id = s.id and i.lender_org_id = m.lender_org_id
     where m.status = 'active' and m.cancel_requested_at is null and private.feature_enabled(m.lender_org_id, 'mandates')
       and i.due_date between v_today and v_today + ceil(extract(epoch from p_horizon) / 86400)::integer
       and i.due_date between m.start_date and m.end_date
       and not exists (select 1 from payments.mandate_debits d where d.mandate_id = m.id and d.planned and d.installment_seq = i.seq)
     order by m.id, i.seq
  loop
    -- The amount is the lender's reported figure for that installment when the newest report is consistent and fresh and names it, otherwise
    -- the installment as the lender's own schedule states it. Nothing is computed or added here.
    v_amount := case when coalesce(r.ok, false) and not coalesce(r.stale, true) and r.next_due_on = r.due_date and coalesce(r.next_due_minor, 0) > 0
                     then r.next_due_minor else r.total_minor end;
    if v_amount is null or v_amount <= 0 then
      continue;
    end if;
    if v_amount > r.max_amount_minor then
      perform private.raise_exception_impl(r.lender_org_id, 'mandate_debit_exceeds_max', 'warning', 'lender',
        jsonb_build_object('mandate_id', r.mandate_id::text, 'installment_seq', r.seq::text));
      v_over := v_over + 1;
      continue;
    end if;
    insert into payments.mandate_debits (lender_org_id, mandate_id, loan_account_id, planned, schedule_snapshot_id, installment_seq, scheduled_on, amount_minor)
    values (r.lender_org_id, r.mandate_id, r.loan_account_id, true, r.snapshot_id, r.seq, r.due_date, v_amount)
    on conflict do nothing
    returning id into v_debit;
    if v_debit is null then
      continue;
    end if;
    v_planned := v_planned + 1;
    select coalesce((select p.pre_debit_lead_hours from payments.lender_mandate_policies p where p.lender_org_id = r.lender_org_id), 48) into v_lead;
    v_due := (r.due_date::timestamp at time zone 'Asia/Kolkata') - make_interval(hours => v_lead);
    insert into payments.pre_debit_notices (lender_org_id, debit_id, mandate_id, borrower_id, notice_due_at, status)
    values (r.lender_org_id, v_debit, r.mandate_id, r.borrower_id, v_due, case when v_due < clock_timestamp() then 'late' else 'planned' end);
    if v_due < clock_timestamp() then
      perform private.raise_exception_impl(r.lender_org_id, 'mandate_notice_late', 'warning', 'lender', jsonb_build_object('debit_id', v_debit::text));
      v_late := v_late + 1;
    end if;
    v_debit := null;
  end loop;
  return jsonb_build_object('planned', v_planned, 'skipped_over_max', v_over, 'notices_late', v_late);
end
$$;
comment on function payments.plan_mandate_debits(interval) is
  'System only. For every ACTIVE mandate of a lender whose mandates switch is on, plans one debit per upcoming installment of the lender''s newest schedule (inside the mandate dates): the amount is the lender''s reported figure for it, or the installment as the lender''s schedule states it, never above the mandate maximum (an installment above it is not planned and the lender gets mandate_debit_exceeds_max). Each planned debit gets a pre-debit notice due the lender''s lead time before the debit date; one that is already past due is marked late and the lender gets mandate_notice_late. Idempotent. Returns counts.';

create or replace function payments.claim_pre_debit_notices(p_limit integer default 100, p_lease interval default interval '10 minutes')
returns table (notice_id uuid, debit_id uuid, mandate_id uuid, borrower_id uuid, loan_account_id uuid, scheduled_on date, amount_minor bigint)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  n payments.pre_debit_notices;
  d payments.mandate_debits;
  v_today date := (clock_timestamp() at time zone 'Asia/Kolkata')::date;
begin
  if private.invoking_role() <> 'service_role' then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  if p_limit is null or p_limit not between 1 and 1000 or p_lease is null or p_lease < interval '1 minute' or p_lease > interval '1 hour' then
    raise exception 'invalid claim request' using errcode = '22023', hint = 'bad_request';
  end if;
  for n in
    select x.* from payments.pre_debit_notices x
     where x.status in ('planned', 'late') and x.sent_at is null and x.notice_due_at <= clock_timestamp() and (x.claimed_until is null or x.claimed_until < clock_timestamp())
     order by x.notice_due_at limit p_limit for update skip locked
  loop
    select * into d from payments.mandate_debits y where y.id = n.debit_id;
    if d.status not in ('scheduled', 'notified') or d.scheduled_on < v_today or not private.feature_enabled(n.lender_org_id, 'mandates') then
      continue;
    end if;
    update payments.pre_debit_notices set claimed_until = clock_timestamp() + p_lease where id = n.id;
    notice_id := n.id; debit_id := d.id; mandate_id := d.mandate_id; borrower_id := n.borrower_id; loan_account_id := d.loan_account_id;
    scheduled_on := d.scheduled_on; amount_minor := d.amount_minor;
    return next;
  end loop;
end
$$;
comment on function payments.claim_pre_debit_notices(integer, interval) is
  'System only. The pre-debit notices that are due now for a debit that has not happened yet, leased to one worker for p_lease. The notice text is a fixed factual line in the app (amount and date); the database holds none.';

create or replace function payments.record_pre_debit_notice(p_notice uuid, p_state text, p_provider_ref text default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  n payments.pre_debit_notices;
begin
  if private.invoking_role() <> 'service_role' then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  if p_state is null or p_state not in ('accepted', 'delivered', 'failed', 'not_configured') then
    raise exception 'invalid notice result' using errcode = '22023', hint = 'bad_request';
  end if;
  select * into n from payments.pre_debit_notices x where x.id = p_notice for update;
  if not found then
    raise exception 'notice not found' using errcode = 'P0002';
  end if;
  if p_state = 'accepted' then
    update payments.pre_debit_notices set status = case when status = 'late' then 'late' else 'sent' end, delivery_state = 'accepted', sent_at = clock_timestamp(), claimed_until = null
     where id = n.id and sent_at is null;
    update payments.mandate_debits set status = 'notified', rank = 20 where id = n.debit_id and status = 'scheduled';
  elsif p_state = 'delivered' then
    if n.sent_at is null then
      raise exception 'the notice was not sent' using errcode = '55000', hint = 'not_sent';
    end if;
    update payments.pre_debit_notices set delivery_state = 'delivered' where id = n.id;
  elsif p_state = 'failed' then
    update payments.pre_debit_notices set claimed_until = null where id = n.id and sent_at is null;
  else
    -- No channel can carry the notice: the lender is told; the debit is not presented silently.
    update payments.pre_debit_notices set status = 'late', claimed_until = null where id = n.id and sent_at is null;
    perform private.raise_exception_impl(n.lender_org_id, 'mandate_notice_late', 'warning', 'lender', jsonb_build_object('debit_id', n.debit_id::text));
  end if;
  return p_state;
end
$$;
comment on function payments.record_pre_debit_notice(uuid, text, text) is
  'System only. Records what happened to a pre-debit notice: accepted (the channel took it; the debit becomes notified), delivered (a delivery report), failed (released for a retry) or not_configured (no channel: marked late and the lender is told). "delivered" is never claimed without the notice having been sent.';

-- ---------------------------------------------------------------------------------------------
-- 11. Activation prerequisites for mandates (every earlier check preserved)
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
  if p_feature in ('payments', 'mandates') then
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
  -- Migration 20261018000914: servicing_sync needs an ACTIVE production-mode LMS connection (file import or manual entry; a mock or
  -- blocked connection never counts), statements_noc needs servicing_sync on, reminders need servicing_sync on, an approved policy and an
  -- approved English wording for each kind. An approved penal-charge text is NOT a prerequisite: without one, overdue reminders are
  -- suppressed and the lender is told (penal_text_missing).
  if p_feature = 'servicing_sync' then
    if not exists (
      select 1 from servicing.lms_connections c
      where c.lender_org_id = p_lender and c.status = 'active' and c.kind in ('file_import', 'manual') and private.provider_mode_satisfies_production_gate(c.provider_mode::text)
    ) then
      v_reasons := v_reasons || 'lms_connection_not_active'::text;
    end if;
  elsif p_feature = 'statements_noc' then
    if not private.feature_enabled(p_lender, 'servicing_sync') then
      v_reasons := v_reasons || 'servicing_sync_not_enabled'::text;
    end if;
  elsif p_feature = 'reminders' then
    if not private.feature_enabled(p_lender, 'servicing_sync') then
      v_reasons := v_reasons || 'servicing_sync_not_enabled'::text;
    end if;
    if not exists (select 1 from servicing.reminder_policies p where p.lender_org_id = p_lender and p.status = 'approved') then
      v_reasons := v_reasons || 'reminder_policy_missing'::text;
    end if;
    if (select count(distinct t.kind) from servicing.reminder_templates t
         where t.lender_org_id = p_lender and t.status = 'approved' and t.language = 'en') < 3 then
      v_reasons := v_reasons || 'reminder_templates_missing'::text;
    end if;
  end if;
  -- Migration 20261018000915: mandates need, in addition to a valid collection target (checked above, as for payments), a provider that offers mandates,
  -- rail limits in the configuration, the lender's own mandate settings and servicing_sync on (debits are planned from the lender's schedule).
  if p_feature = 'mandates' then
    if not exists (
      select 1 from payments.lender_payment_configs c join payments.provider_register r on r.provider = c.provider
      where c.lender_org_id = p_lender and c.status = 'active' and private.provider_mode_satisfies_production_gate(c.provider_mode)
        and r.status = 'approved' and r.kind in ('mandate', 'payment_and_mandate')
    ) then
      v_reasons := v_reasons || 'provider_not_mandate_capable'::text;
    end if;
    if not exists (
      select 1 from payments.lender_payment_configs c, unnest(array['enach_api', 'upi_autopay']) rail
      where c.lender_org_id = p_lender and c.status = 'active' and private.provider_mode_satisfies_production_gate(c.provider_mode)
        and (c.rail_limits -> rail ->> 'max_mandate_amount_minor') ~ '^[0-9]{1,15}$' and jsonb_typeof(c.rail_limits -> rail -> 'needs_afa_each_debit') = 'boolean'
    ) then
      v_reasons := v_reasons || 'mandate_rail_not_configured'::text;
    end if;
    if not exists (select 1 from payments.lender_mandate_policies p where p.lender_org_id = p_lender) then
      v_reasons := v_reasons || 'mandate_policy_missing'::text;
    end if;
    if not private.feature_enabled(p_lender, 'servicing_sync') then
      v_reasons := v_reasons || 'servicing_sync_not_enabled'::text;
    end if;
  end if;
  -- Later Phase 08a migrations add further feature-specific checks here: copy this body from the highest-numbered migration that defines it,
  -- append, and never remove or weaken a reason.
  return array(select distinct x from unnest(v_reasons) x order by x);
end
$$;
comment on function private.feature_prerequisites_unmet(uuid, text) is
  'Reasons a feature cannot be switched on for a lender; empty array = none. Generic checks: feature unknown or not enableable, lender organisation not active, onboarding gate not activated, evidence missing (the single pending enable request must carry evidence). payments (migration 20261018000910): payment_config_missing (no ACTIVE configuration in production mode), payment_config_mock_or_sandbox_only (only a mock or sandbox configuration is active: it can never satisfy the gate), registry_entry_not_verified (no active production configuration settles into a verified registry entry), payment_config_validation_failed (no active production configuration passes payments.validate_collection_target). EXTENDING: later migrations add feature-specific checks with CREATE OR REPLACE and MUST PRESERVE every earlier check (copy the body of the highest-numbered migration that defines this function and append; never remove or weaken a reason). A mock or sandbox provider record must never satisfy a check: use private.provider_mode_satisfies_production_gate. servicing_sync (migration 20261018000914): lms_connection_not_active (no ACTIVE file_import or manual connection in production mode). statements_noc: servicing_sync_not_enabled. reminders: servicing_sync_not_enabled, reminder_policy_missing (no approved policy), reminder_templates_missing (no approved English wording for each of pre_due, due_day and overdue). mandates (migration 20261018000915): the payments checks (payment_config_missing, payment_config_mock_or_sandbox_only, registry_entry_not_verified, payment_config_validation_failed) plus provider_not_mandate_capable, mandate_rail_not_configured (no rail with max_mandate_amount_minor and needs_afa_each_debit in the configuration), mandate_policy_missing, servicing_sync_not_enabled.';
revoke all on function private.feature_prerequisites_unmet(uuid, text) from public;
grant execute on function private.feature_prerequisites_unmet(uuid, text) to service_role;

-- ---------------------------------------------------------------------------------------------
-- 12. Row level security and grants. Lenders read their own rows (payment.read); the borrower reads through payments.my_mandates; nobody writes
--     directly: the definer functions above are the only writers, and the system role can read only.
-- ---------------------------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['lender_mandate_policies', 'mandates', 'mandate_events', 'mandate_debits', 'pre_debit_notices']
  loop
    execute format('alter table payments.%I enable row level security', t);
    execute format('alter table payments.%I force row level security', t);
    execute format('create policy %I on payments.%I for select to authenticated using (lender_org_id in (select private.orgs_with_permission(%L)))',
                   t || '_lender_read', t, 'payment.read');
    execute format('revoke all on payments.%I from public, anon, authenticated, service_role', t);
    execute format('grant select on payments.%I to authenticated, service_role', t);
  end loop;
  foreach t in array array['mandate_transitions', 'mandate_return_codes']
  loop
    execute format('alter table payments.%I enable row level security', t);
    execute format('alter table payments.%I force row level security', t);
    execute format('revoke all on payments.%I from public, anon, authenticated, service_role', t);
    execute format('grant select on payments.%I to authenticated, service_role', t);
  end loop;
end
$$;
create policy mandate_transitions_read on payments.mandate_transitions for select to authenticated using (exists (select 1 from private.my_org_ids()));
create policy mandate_return_codes_read on payments.mandate_return_codes for select to authenticated
  using (exists (select 1 from private.my_org_ids()) and (
    (select private.has_platform_permission('platform.payments.providers.manage'))
    or exists (select 1 from private.orgs_with_permission('payment.read'))));

revoke all on function payments.set_mandate_policy(uuid, text, bigint, integer) from public;
revoke all on function payments.set_return_code_class(text, text, text, text) from public;
revoke all on function payments.request_mandate(uuid, uuid, text, bigint, date, date, text) from public;
revoke all on function payments.request_mandate_cancellation(uuid) from public;
revoke all on function payments.my_mandates() from public;
revoke all on function payments.record_mandate_handoff(uuid, text, text, timestamptz) from public;
revoke all on function payments.apply_mandate_lookup(uuid, text, text, timestamptz) from public;
revoke all on function payments.apply_debit_lookup(uuid, text, date, bigint, text, text, timestamptz) from public;
revoke all on function payments.mark_mandate_cancel_sent(uuid) from public;
revoke all on function payments.request_cancel_for_closed_loans() from public;
revoke all on function payments.sweep_mandates(interval, interval, interval) from public;
revoke all on function payments.mandates_needing_lookup(interval) from public;
revoke all on function payments.plan_mandate_debits(interval) from public;
revoke all on function payments.claim_pre_debit_notices(integer, interval) from public;
revoke all on function payments.record_pre_debit_notice(uuid, text, text) from public;
grant execute on function payments.set_mandate_policy(uuid, text, bigint, integer) to authenticated;
grant execute on function payments.set_return_code_class(text, text, text, text) to authenticated;
grant execute on function payments.request_mandate(uuid, uuid, text, bigint, date, date, text) to authenticated;
grant execute on function payments.request_mandate_cancellation(uuid) to authenticated;
grant execute on function payments.my_mandates() to authenticated;
grant execute on function payments.record_mandate_handoff(uuid, text, text, timestamptz) to service_role;
grant execute on function payments.apply_mandate_lookup(uuid, text, text, timestamptz) to service_role;
grant execute on function payments.apply_debit_lookup(uuid, text, date, bigint, text, text, timestamptz) to service_role;
grant execute on function payments.mark_mandate_cancel_sent(uuid) to service_role;
grant execute on function payments.request_cancel_for_closed_loans() to service_role;
grant execute on function payments.sweep_mandates(interval, interval, interval) to service_role;
grant execute on function payments.mandates_needing_lookup(interval) to service_role;
grant execute on function payments.plan_mandate_debits(interval) to service_role;
grant execute on function payments.claim_pre_debit_notices(integer, interval) to service_role;
grant execute on function payments.record_pre_debit_notice(uuid, text, text) to service_role;
