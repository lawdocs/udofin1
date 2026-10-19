-- =============================================================================================
-- Servicing read-model and payment instructions.
--
-- System of record: the LENDER's loan management system (Finbyx or a third-party LMS) owns the
-- loan balance, schedule, allocation of receipts and accounting. Udofin keeps an immutable copy of
-- what the LMS reported (to show the borrower and to reconcile), never a competing ledger.
--
-- Money movement: repayments settle directly into the lender's own account (no Udofin pool or
-- pass-through account). A payment intent records an instruction Udofin facilitated; only a
-- verified provider event processed by the system can mark it succeeded.
-- =============================================================================================

create type servicing.loan_status as enum ('active', 'closed', 'foreclosed', 'written_off', 'cancelled');
create type servicing.source_system as enum ('finbyx', 'lender_lms', 'manual_import');

create table servicing.loan_accounts (
  id uuid primary key default private.uuid_v7(),
  lender_org_id uuid not null,
  application_id uuid not null,
  borrower_id uuid not null references identity.borrowers (id) on delete restrict,
  source_system servicing.source_system not null,
  lms_loan_ref text not null check (length(lms_loan_ref) between 1 and 100),
  status servicing.loan_status not null default 'active',
  sanctioned_amount_minor bigint not null check (sanctioned_amount_minor > 0),
  disbursed_amount_minor bigint check (disbursed_amount_minor > 0),
  disbursed_at timestamptz,
  -- Bank/payment-rail reference (e.g. UTR) for the disbursement, as reported by the lender.
  disbursement_reference text,
  last_synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (application_id, lender_org_id) references lending.applications (id, lender_org_id) on delete restrict,
  unique (application_id),
  unique (lender_org_id, lms_loan_ref),
  unique (id, lender_org_id),
  constraint disbursement_evidence_complete check (
    (disbursed_at is null and disbursement_reference is null and disbursed_amount_minor is null)
    or (disbursed_at is not null and disbursement_reference is not null and disbursed_amount_minor is not null)
  ),
  check (disbursed_amount_minor is null or disbursed_amount_minor <= sanctioned_amount_minor)
);
create index loan_accounts_borrower on servicing.loan_accounts (borrower_id);
create index loan_accounts_lender on servicing.loan_accounts (lender_org_id, status);
create trigger loan_accounts_set_updated_at before update on servicing.loan_accounts
  for each row execute function private.set_updated_at();

-- An application can be marked disbursed only when the lender's disbursement evidence exists.
-- Approval alone never moves money and never makes an application "disbursed".
create or replace function private.require_disbursement_evidence()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'disbursed' and old.status is distinct from 'disbursed' then
    if not exists (
      select 1 from servicing.loan_accounts la
      where la.application_id = new.id
        and la.lender_org_id = new.lender_org_id
        and la.disbursed_at is not null
        and la.disbursement_reference is not null
    ) then
      raise exception 'cannot mark application disbursed without recorded disbursement evidence'
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end
$$;
create trigger applications_require_disbursement_evidence before update on lending.applications
  for each row execute function private.require_disbursement_evidence();

-- Immutable schedule snapshots exactly as received from the LMS. A new version supersedes the old.
create table servicing.schedule_snapshots (
  id uuid primary key default private.uuid_v7(),
  lender_org_id uuid not null,
  loan_account_id uuid not null,
  version integer not null check (version > 0),
  source_reference text,
  received_at timestamptz not null default now(),
  foreign key (loan_account_id, lender_org_id) references servicing.loan_accounts (id, lender_org_id) on delete restrict,
  unique (loan_account_id, version),
  unique (id, lender_org_id)
);
create trigger schedule_snapshots_append_only before update or delete on servicing.schedule_snapshots
  for each row execute function private.forbid_mutation();

create table servicing.schedule_installments (
  snapshot_id uuid not null,
  lender_org_id uuid not null,
  seq integer not null check (seq > 0),
  due_date date not null,
  principal_minor bigint not null check (principal_minor >= 0),
  interest_minor bigint not null check (interest_minor >= 0),
  fees_minor bigint not null default 0 check (fees_minor >= 0),
  total_minor bigint generated always as (principal_minor + interest_minor + fees_minor) stored,
  primary key (snapshot_id, seq),
  foreign key (snapshot_id, lender_org_id) references servicing.schedule_snapshots (id, lender_org_id) on delete restrict
);
create trigger schedule_installments_append_only before update or delete on servicing.schedule_installments
  for each row execute function private.forbid_mutation();

-- ---------------------------------------------------------------------------------------------
-- Payment intents and provider events
-- ---------------------------------------------------------------------------------------------
create type payments.intent_purpose as enum ('installment', 'overdue', 'part_prepayment', 'foreclosure', 'charges');
create type payments.intent_status as enum ('created', 'pending', 'succeeded', 'failed', 'expired', 'cancelled');

create table payments.payment_intents (
  id uuid primary key default private.uuid_v7(),
  lender_org_id uuid not null,
  loan_account_id uuid not null,
  borrower_id uuid not null references identity.borrowers (id) on delete restrict,
  purpose payments.intent_purpose not null,
  amount_minor bigint not null check (amount_minor > 0 and amount_minor <= 100000000000000),
  currency char(3) not null default 'INR' check (currency = 'INR'),
  -- The lender's collection account the money settles into (configured per lender in Phase 4).
  settlement_account_ref text not null,
  provider text not null check (provider ~ '^[a-z0-9_]+$'),
  provider_order_ref text,
  -- Supplied by the caller; a retried request with the same key returns the original intent.
  idempotency_key text not null check (length(idempotency_key) between 16 and 128),
  status payments.intent_status not null default 'created',
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (loan_account_id, lender_org_id) references servicing.loan_accounts (id, lender_org_id) on delete restrict,
  unique (lender_org_id, idempotency_key),
  unique (id, lender_org_id)
);
create unique index payment_intents_provider_ref on payments.payment_intents (provider, provider_order_ref)
  where provider_order_ref is not null;
create index payment_intents_loan on payments.payment_intents (loan_account_id, created_at desc);
create index payment_intents_lender_status on payments.payment_intents (lender_org_id, status, created_at);
create trigger payment_intents_set_updated_at before update on payments.payment_intents
  for each row execute function private.set_updated_at();

-- Status rules: terminal states are final, and only the system (processing a verified provider
-- event) may record success or failure. Users can at most cancel an intent that has not started.
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
  end if;
  return new;
end
$$;
create trigger payment_intents_protect before insert or update on payments.payment_intents
  for each row execute function private.protect_payment_intent();
create trigger payment_intents_no_delete before delete on payments.payment_intents
  for each row execute function private.forbid_mutation();

-- Webhooks / status callbacks from payment providers. De-duplicated on (provider, event id).
-- Raw payloads are NOT stored (they can contain personal data); only a hash and normalised fields.
create table payments.provider_events (
  id uuid primary key default private.uuid_v7(),
  provider text not null check (provider ~ '^[a-z0-9_]+$'),
  provider_event_id text not null,
  event_type text not null,
  lender_org_id uuid references tenancy.organizations (id),
  payment_intent_id uuid references payments.payment_intents (id),
  amount_minor bigint,
  provider_status text,
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  signature_verified boolean not null,
  received_at timestamptz not null default now(),
  unique (provider, provider_event_id)
);
create index provider_events_intent on payments.provider_events (payment_intent_id);
create trigger provider_events_append_only before update or delete on payments.provider_events
  for each row execute function private.forbid_mutation();

-- ---------------------------------------------------------------------------------------------
-- Row Level Security. LMS sync and provider-event processing run as the system (service_role).
-- ---------------------------------------------------------------------------------------------
alter table servicing.loan_accounts enable row level security;
alter table servicing.loan_accounts force row level security;
alter table servicing.schedule_snapshots enable row level security;
alter table servicing.schedule_snapshots force row level security;
alter table servicing.schedule_installments enable row level security;
alter table servicing.schedule_installments force row level security;
alter table payments.payment_intents enable row level security;
alter table payments.payment_intents force row level security;
alter table payments.provider_events enable row level security;
alter table payments.provider_events force row level security;

create policy loan_accounts_borrower_read on servicing.loan_accounts for select to authenticated
  using (borrower_id = (select private.my_borrower_id()));
create policy loan_accounts_lender_read on servicing.loan_accounts for select to authenticated
  using (lender_org_id in (select private.orgs_with_permission('loan.read')));

create policy snapshots_borrower_read on servicing.schedule_snapshots for select to authenticated
  using (loan_account_id in (select la.id from servicing.loan_accounts la where la.borrower_id = (select private.my_borrower_id())));
create policy snapshots_lender_read on servicing.schedule_snapshots for select to authenticated
  using (lender_org_id in (select private.orgs_with_permission('loan.read')));

create policy installments_borrower_read on servicing.schedule_installments for select to authenticated
  using (snapshot_id in (
    select s.id from servicing.schedule_snapshots s
    join servicing.loan_accounts la on la.id = s.loan_account_id
    where la.borrower_id = (select private.my_borrower_id())
  ));
create policy installments_lender_read on servicing.schedule_installments for select to authenticated
  using (lender_org_id in (select private.orgs_with_permission('loan.read')));

create policy intents_borrower_read on payments.payment_intents for select to authenticated
  using (borrower_id = (select private.my_borrower_id()));
create policy intents_lender_read on payments.payment_intents for select to authenticated
  using (lender_org_id in (select private.orgs_with_permission('payment.read')));
create policy intents_borrower_insert on payments.payment_intents for insert to authenticated
  with check (borrower_id = (select private.my_borrower_id()) and created_by = (select auth.uid()));
create policy intents_borrower_cancel on payments.payment_intents for update to authenticated
  using (borrower_id = (select private.my_borrower_id()))
  with check (borrower_id = (select private.my_borrower_id()));

create policy provider_events_lender_read on payments.provider_events for select to authenticated
  using (lender_org_id in (select private.orgs_with_permission('payment.read')));

grant select on servicing.loan_accounts, servicing.schedule_snapshots, servicing.schedule_installments to authenticated;
grant select, insert on payments.payment_intents to authenticated;
grant update (status) on payments.payment_intents to authenticated;
grant select on payments.provider_events to authenticated;
