-- =============================================================================================
-- Phase 08a, reconciliation: provider settlement reports, the lender's bank credits and the lender's own LMS receipts.
-- Spec: docs/specs/08-servicing-payments-mandates-collections.md section 10, and the owner decisions of 14 October 2026 (2, 3, 7).
--
--   1. payments.settlement_batches / settlement_items: what the PROVIDER says it settled (append-only, hashed). A batch whose destination is
--      not the lender's verified account suspends that configuration and opens a critical platform exception.
--   2. payments.bank_credits: what the LENDER says arrived in its account (value date, amount and UTR only: a narration may contain a name and is
--      refused). Uploaded by the lender, all or nothing.
--   3. payments.reconciliation_runs / reconciliation_matches: a deterministic run per lender and date. Matching is EXACT, never fuzzy (provider
--      payment reference, UTR, amount to the paisa). A missing input is "not reconcilable", never "reconciled". The run raises exceptions
--      (the queue of migration 20261018000913) and never changes any money row. Re-running on unchanged inputs returns the same run.
--   4. payments.payment_stages: the settlement stage of each successful provider payment, DERIVED from the tables above (provider_captured,
--      provider_settled, bank_confirmed, lender_posted). Nothing sets a stage and no function accepts one.
--
-- Forward-only. Error convention: SQLSTATE and hint (42501 not authorised, P0002 not found, 22023 bad input, 55000 rule or state).
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- 1. Reconciliation settings (platform defaults until the lender sets its own; both are UNVERIFIED defaults, not rules)
-- ---------------------------------------------------------------------------------------------
create table payments.reconciliation_settings (
  lender_org_id uuid primary key references tenancy.organizations (id) on delete restrict,
  settlement_lag_days integer not null default 3 check (settlement_lag_days between 1 and 30),
  receipt_lag_hours integer not null default 72 check (receipt_lag_hours between 1 and 720),
  updated_by uuid not null references auth.users (id),
  updated_at timestamptz not null default clock_timestamp()
);
create index reconciliation_settings_updated_by on payments.reconciliation_settings (updated_by);
comment on table payments.reconciliation_settings is
  'How long reconciliation waits before it calls a missing item an exception: days for the provider to settle and for the bank to credit, hours for the lender to post a receipt. Without a row the defaults (3 days, 72 hours) apply; they are PLATFORM DEFAULTS with no source, to be replaced from the provider and lender agreements. Written only by payments.set_reconciliation_settings (payment.configure, aal2). Owner: payments module.';
create trigger no_delete before delete on payments.reconciliation_settings
  for each row execute function private.forbid_mutation();
create trigger no_truncate before truncate on payments.reconciliation_settings
  for each statement execute function private.forbid_truncate();

create or replace function payments.set_reconciliation_settings(p_lender uuid, p_settlement_lag_days integer, p_receipt_lag_hours integer)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.payments_require_lender(p_lender, 'payment.configure');
begin
  if p_settlement_lag_days is null or p_settlement_lag_days not between 1 and 30 or p_receipt_lag_hours is null or p_receipt_lag_hours not between 1 and 720 then
    raise exception 'invalid reconciliation settings' using errcode = '22023', hint = 'settings_invalid';
  end if;
  insert into payments.reconciliation_settings (lender_org_id, settlement_lag_days, receipt_lag_hours, updated_by)
  values (p_lender, p_settlement_lag_days, p_receipt_lag_hours, v_uid)
  on conflict (lender_org_id) do update set settlement_lag_days = excluded.settlement_lag_days, receipt_lag_hours = excluded.receipt_lag_hours,
    updated_by = excluded.updated_by, updated_at = clock_timestamp();
  perform private.write_payments_audit(p_lender, 'payments.reconciliation_settings.set', 'reconciliation_settings', p_lender::text,
    jsonb_build_object('settlement_lag_days', p_settlement_lag_days, 'receipt_lag_hours', p_receipt_lag_hours));
  return 'set';
end
$$;
comment on function payments.set_reconciliation_settings(uuid, integer, integer) is
  'payment.configure of the lender, aal2. Sets the waiting times of reconciliation (22023 settings_invalid). Applies to runs made afterwards.';

-- ---------------------------------------------------------------------------------------------
-- 2. What the provider settled
-- ---------------------------------------------------------------------------------------------
create table payments.settlement_batches (
  id uuid primary key default private.uuid_v7(),
  lender_org_id uuid not null,
  config_id uuid not null,
  provider text not null check (provider ~ '^[a-z0-9_]{1,50}$'),
  batch_ref text not null check (batch_ref ~ '^[A-Za-z0-9._:=+/-]{1,200}$'),
  -- The bank reference (UTR) of the settlement credit, as the provider reports it.
  settlement_ref text not null check (settlement_ref ~ '^[A-Za-z0-9._:/-]{4,60}$'),
  period_from date not null,
  period_to date not null,
  -- Last digits only, as the provider reports the destination. null = the provider did not say.
  destination_masked_ref text check (destination_masked_ref is null or destination_masked_ref ~ '^[X*]{2,}[0-9]{2,4}$'),
  -- false = the reported destination is not the lender's verified settlement account.
  destination_ok boolean,
  gross_minor bigint not null check (gross_minor between 0 and 100000000000000),
  fee_minor bigint not null check (fee_minor between 0 and 100000000000000),
  tax_minor bigint not null check (tax_minor between 0 and 100000000000000),
  net_minor bigint not null check (net_minor between 0 and 100000000000000),
  -- The parts as the provider reported them do not add up (flagged, never corrected).
  parts_mismatch boolean not null,
  item_count integer not null check (item_count between 0 and 100000),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  report_date date not null,
  received_at timestamptz not null default clock_timestamp(),
  unique (id, lender_org_id),
  unique (lender_org_id, provider, batch_ref),
  foreign key (config_id, lender_org_id) references payments.lender_payment_configs (id, lender_org_id) on delete restrict,
  constraint period_ordered check (period_to >= period_from),
  constraint destination_ok_needs_destination check (destination_ok is null or destination_masked_ref is not null)
);
create index settlement_batches_lender on payments.settlement_batches (lender_org_id, period_to desc);
create index settlement_batches_utr on payments.settlement_batches (lender_org_id, settlement_ref);
create index settlement_batches_config on payments.settlement_batches (config_id, lender_org_id);
comment on table payments.settlement_batches is
  'What the PAYMENT PROVIDER reports it settled (one row per provider batch), with the bank reference (UTR) of the credit, the reported destination (last digits) and whether that is the lender''s verified account, the amounts as reported (gross, fee, tax, net: never recomputed; parts_mismatch flags a report that does not add up) and the SHA-256 of the report. Append-only. A batch whose destination is not the lender''s verified account suspends that configuration and opens a critical platform exception. Written only by payments.record_settlement_report. Owner: payments module.';
create trigger append_only before update or delete on payments.settlement_batches
  for each row execute function private.forbid_mutation();
create trigger no_truncate before truncate on payments.settlement_batches
  for each statement execute function private.forbid_truncate();

create table payments.settlement_items (
  id uuid primary key default private.uuid_v7(),
  batch_id uuid not null,
  lender_org_id uuid not null,
  provider_payment_ref text not null check (provider_payment_ref ~ '^[A-Za-z0-9._:=+/-]{1,200}$'),
  order_ref text check (order_ref is null or order_ref ~ '^[A-Za-z0-9._:=+/-]{1,200}$'),
  gross_minor bigint not null check (gross_minor between 0 and 100000000000000),
  fee_minor bigint not null check (fee_minor between 0 and 100000000000000),
  tax_minor bigint not null check (tax_minor between 0 and 100000000000000),
  net_minor bigint not null check (net_minor between 0 and 100000000000000),
  parts_mismatch boolean not null,
  unique (id, lender_org_id),
  unique (batch_id, provider_payment_ref),
  foreign key (batch_id, lender_org_id) references payments.settlement_batches (id, lender_org_id) on delete restrict
);
create index settlement_items_ref on payments.settlement_items (lender_org_id, provider_payment_ref);
comment on table payments.settlement_items is
  'One payment inside a provider settlement batch: the provider''s payment reference and the amounts as reported. Append-only. Written only by payments.record_settlement_report. Owner: payments module.';
create trigger append_only before update or delete on payments.settlement_items
  for each row execute function private.forbid_mutation();
create trigger no_truncate before truncate on payments.settlement_items
  for each statement execute function private.forbid_truncate();

-- ---------------------------------------------------------------------------------------------
-- 3. What the lender says arrived in its account (value date, amount and UTR only)
-- ---------------------------------------------------------------------------------------------
create table payments.bank_credits (
  id uuid primary key default private.uuid_v7(),
  lender_org_id uuid not null,
  settlement_account_id uuid not null,
  value_date date not null,
  amount_minor bigint not null check (amount_minor between 1 and 100000000000000),
  utr text not null check (utr ~ '^[A-Za-z0-9._:/-]{4,60}$'),
  recorded_by uuid not null references auth.users (id),
  recorded_at timestamptz not null default clock_timestamp(),
  unique (id, lender_org_id),
  unique (lender_org_id, utr),
  foreign key (settlement_account_id, lender_org_id) references tenancy.lender_settlement_accounts (id, lender_org_id) on delete restrict
);
create index bank_credits_account on payments.bank_credits (settlement_account_id, lender_org_id);
create index bank_credits_recorded_by on payments.bank_credits (recorded_by);
comment on table payments.bank_credits is
  'Credits the LENDER reports in one of its own settlement accounts: value date, amount and bank reference (UTR) only. Narrations are never stored (they can carry names); the upload function refuses any other field. Append-only. Written only by payments.import_bank_credits (payment.reconcile, aal2). Owner: payments module.';
create trigger append_only before update or delete on payments.bank_credits
  for each row execute function private.forbid_mutation();
create trigger no_truncate before truncate on payments.bank_credits
  for each statement execute function private.forbid_truncate();

-- ---------------------------------------------------------------------------------------------
-- 4. Runs and matches
-- ---------------------------------------------------------------------------------------------
create table payments.reconciliation_runs (
  id uuid primary key default private.uuid_v7(),
  lender_org_id uuid not null references tenancy.organizations (id) on delete restrict,
  run_date date not null,
  run_no integer not null check (run_no > 0),
  -- SHA-256 of the canonical listing of every input the run looked at: the same inputs give the same run.
  inputs_sha256 text not null check (inputs_sha256 ~ '^[0-9a-f]{64}$'),
  counts jsonb not null default '{}'::jsonb check (jsonb_typeof(counts) = 'object'),
  report jsonb not null default '{}'::jsonb check (jsonb_typeof(report) = 'object'),
  created_at timestamptz not null default clock_timestamp(),
  unique (id, lender_org_id),
  unique (lender_org_id, run_date, run_no),
  unique (lender_org_id, run_date, inputs_sha256)
);
comment on table payments.reconciliation_runs is
  'One reconciliation of a lender up to a date: the hash of its inputs, the counts and a deterministic report (no clock inside it, so a rerun on unchanged inputs is byte-identical). Matching is exact. A missing input source is listed as not reconcilable, never as reconciled. The standing line "settled to non-lender accounts" is part of every report. Written only by payments.run_reconciliation. Owner: payments module.';
create trigger no_delete before delete on payments.reconciliation_runs
  for each row execute function private.forbid_mutation();
create trigger no_truncate before truncate on payments.reconciliation_runs
  for each statement execute function private.forbid_truncate();

-- The run row is created empty and finalised exactly once; after that it never changes.
create or replace function private.protect_reconciliation_run()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (to_jsonb(new) - array['counts', 'report']) is distinct from (to_jsonb(old) - array['counts', 'report']) then
    raise exception 'a reconciliation run keeps its lender, date and inputs' using errcode = 'P0001';
  end if;
  if old.counts <> '{}'::jsonb or old.report <> '{}'::jsonb then
    raise exception 'a finished reconciliation run does not change' using errcode = 'P0001';
  end if;
  return new;
end
$$;
revoke all on function private.protect_reconciliation_run() from public;
create trigger protect before update on payments.reconciliation_runs
  for each row execute function private.protect_reconciliation_run();

create table payments.reconciliation_matches (
  id uuid primary key default private.uuid_v7(),
  run_id uuid not null,
  lender_org_id uuid not null,
  kind text not null check (kind in ('payment_settlement', 'settlement_bank', 'payment_receipt')),
  provider_payment_id uuid,
  settlement_item_id uuid,
  settlement_batch_id uuid,
  bank_credit_id uuid,
  receipt_id uuid,
  amount_minor bigint not null check (amount_minor >= 0),
  foreign key (run_id, lender_org_id) references payments.reconciliation_runs (id, lender_org_id) on delete restrict,
  foreign key (provider_payment_id, lender_org_id) references payments.provider_payments (id, lender_org_id) on delete restrict,
  foreign key (settlement_item_id, lender_org_id) references payments.settlement_items (id, lender_org_id) on delete restrict,
  foreign key (settlement_batch_id, lender_org_id) references payments.settlement_batches (id, lender_org_id) on delete restrict,
  foreign key (bank_credit_id, lender_org_id) references payments.bank_credits (id, lender_org_id) on delete restrict,
  foreign key (receipt_id, lender_org_id) references servicing.lms_receipts (id, lender_org_id) on delete restrict,
  constraint match_shape check (
    (kind = 'payment_settlement' and provider_payment_id is not null and settlement_item_id is not null and settlement_batch_id is null and bank_credit_id is null and receipt_id is null)
    or (kind = 'settlement_bank' and settlement_batch_id is not null and bank_credit_id is not null and provider_payment_id is null and settlement_item_id is null and receipt_id is null)
    or (kind = 'payment_receipt' and provider_payment_id is not null and receipt_id is not null and settlement_item_id is null and settlement_batch_id is null and bank_credit_id is null))
);
create index reconciliation_matches_run on payments.reconciliation_matches (run_id, lender_org_id);
create index reconciliation_matches_payment on payments.reconciliation_matches (provider_payment_id, lender_org_id);
create index reconciliation_matches_item on payments.reconciliation_matches (settlement_item_id, lender_org_id);
create index reconciliation_matches_batch on payments.reconciliation_matches (settlement_batch_id, lender_org_id);
create index reconciliation_matches_credit on payments.reconciliation_matches (bank_credit_id, lender_org_id);
create index reconciliation_matches_receipt on payments.reconciliation_matches (receipt_id, lender_org_id);
comment on table payments.reconciliation_matches is
  'Exact matches a run found: provider payment to settlement item (reference and amount to the paisa), settlement batch to bank credit (UTR, net amount and the configured settlement account), provider payment to the lender''s own receipt (reference or intent id, amount, not reversed). Append-only. Written only by payments.run_reconciliation. Owner: payments module.';
create trigger append_only before update or delete on payments.reconciliation_matches
  for each row execute function private.forbid_mutation();
create trigger no_truncate before truncate on payments.reconciliation_matches
  for each statement execute function private.forbid_truncate();

-- ---------------------------------------------------------------------------------------------
-- 5. Recording what the provider settled (system)
-- ---------------------------------------------------------------------------------------------
-- p_batches is the settlement report as the adapter normalised it: [{batchRef, settlementRef, periodFrom, periodTo, destinationMaskedRef, grossMinor,
-- feeMinor, taxMinor, netMinor, items: [{providerPaymentRef, orderRef, grossMinor, feeMinor, taxMinor, netMinor}]}], money as digit strings.
create or replace function payments.record_settlement_report(p_config uuid, p_report_date date, p_batches jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c payments.lender_payment_configs;
  v_acct tenancy.lender_settlement_accounts;
  b jsonb;
  it jsonb;
  v_hash text;
  v_existing payments.settlement_batches;
  v_id uuid;
  v_recorded integer := 0;
  v_dup integer := 0;
  v_bad integer := 0;
  v_gross bigint; v_fee bigint; v_tax bigint; v_net bigint;
  v_isum bigint;
  v_items integer;
  v_dest text;
  v_dest_ok boolean;
begin
  if private.invoking_role() <> 'service_role' then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  if p_report_date is null or p_batches is null or jsonb_typeof(p_batches) <> 'array' or jsonb_array_length(p_batches) > 500 then
    raise exception 'invalid settlement report' using errcode = '22023', hint = 'bad_request';
  end if;
  select * into c from payments.lender_payment_configs x where x.id = p_config;
  if not found then
    raise exception 'payment configuration not found' using errcode = 'P0002';
  end if;
  select * into v_acct from tenancy.lender_settlement_accounts s where s.id = c.settlement_account_id and s.lender_org_id = c.lender_org_id;
  -- Validate the whole report first: all or nothing.
  for b in select * from jsonb_array_elements(p_batches) loop
    if jsonb_typeof(b) <> 'object'
       or (b ->> 'batchRef') is null or (b ->> 'batchRef') !~ '^[A-Za-z0-9._:=+/-]{1,200}$'
       or (b ->> 'settlementRef') is null or (b ->> 'settlementRef') !~ '^[A-Za-z0-9._:/-]{4,60}$'
       or private.servicing_try_date(b ->> 'periodFrom') is null or private.servicing_try_date(b ->> 'periodTo') is null
       or private.servicing_try_date(b ->> 'periodTo') < private.servicing_try_date(b ->> 'periodFrom')
       or (b ->> 'destinationMaskedRef') is not null and (b ->> 'destinationMaskedRef') !~ '^[X*]{2,}[0-9]{2,4}$'
       or coalesce((b ->> 'grossMinor') !~ '^[0-9]{1,15}$', true) or coalesce((b ->> 'feeMinor') !~ '^[0-9]{1,15}$', true)
       or coalesce((b ->> 'taxMinor') !~ '^[0-9]{1,15}$', true) or coalesce((b ->> 'netMinor') !~ '^[0-9]{1,15}$', true)
       or jsonb_typeof(b -> 'items') is distinct from 'array' or jsonb_array_length(b -> 'items') > 20000 then
      raise exception 'invalid settlement batch' using errcode = '22023', hint = 'bad_request';
    end if;
    for it in select * from jsonb_array_elements(b -> 'items') loop
      if jsonb_typeof(it) <> 'object' or (it ->> 'providerPaymentRef') is null or (it ->> 'providerPaymentRef') !~ '^[A-Za-z0-9._:=+/-]{1,200}$'
         or (it ->> 'orderRef') is not null and (it ->> 'orderRef') !~ '^[A-Za-z0-9._:=+/-]{1,200}$'
         or coalesce((it ->> 'grossMinor') !~ '^[0-9]{1,15}$', true) or coalesce((it ->> 'feeMinor') !~ '^[0-9]{1,15}$', true)
         or coalesce((it ->> 'taxMinor') !~ '^[0-9]{1,15}$', true) or coalesce((it ->> 'netMinor') !~ '^[0-9]{1,15}$', true) then
        raise exception 'invalid settlement item' using errcode = '22023', hint = 'bad_request';
      end if;
    end loop;
  end loop;
  for b in select * from jsonb_array_elements(p_batches) loop
    v_hash := encode(sha256(convert_to(b::text, 'UTF8')), 'hex');
    select * into v_existing from payments.settlement_batches x where x.lender_org_id = c.lender_org_id and x.provider = c.provider and x.batch_ref = (b ->> 'batchRef');
    if found then
      if v_existing.content_sha256 = v_hash then
        v_dup := v_dup + 1;
      else
        -- The provider reports a batch it already reported, differently: nothing changes and the platform is told.
        perform private.raise_exception_impl(c.lender_org_id, 'event_payload_conflict', 'warning', 'platform', jsonb_build_object('settlement_batch_id', v_existing.id::text));
        v_bad := v_bad + 1;
      end if;
      continue;
    end if;
    v_gross := (b ->> 'grossMinor')::bigint; v_fee := (b ->> 'feeMinor')::bigint; v_tax := (b ->> 'taxMinor')::bigint; v_net := (b ->> 'netMinor')::bigint;
    v_items := jsonb_array_length(b -> 'items');
    v_dest := b ->> 'destinationMaskedRef';
    v_dest_ok := case when v_dest is null then null else v_dest = v_acct.masked_account_ref end;
    insert into payments.settlement_batches (lender_org_id, config_id, provider, batch_ref, settlement_ref, period_from, period_to, destination_masked_ref, destination_ok,
                                             gross_minor, fee_minor, tax_minor, net_minor, parts_mismatch, item_count, content_sha256, report_date)
    values (c.lender_org_id, c.id, c.provider, b ->> 'batchRef', b ->> 'settlementRef', private.servicing_try_date(b ->> 'periodFrom'), private.servicing_try_date(b ->> 'periodTo'), v_dest, v_dest_ok,
            v_gross, v_fee, v_tax, v_net, v_net <> v_gross - v_fee - v_tax, v_items, v_hash, p_report_date)
    returning id into v_id;
    insert into payments.settlement_items (batch_id, lender_org_id, provider_payment_ref, order_ref, gross_minor, fee_minor, tax_minor, net_minor, parts_mismatch)
    select v_id, c.lender_org_id, i ->> 'providerPaymentRef', i ->> 'orderRef', (i ->> 'grossMinor')::bigint, (i ->> 'feeMinor')::bigint, (i ->> 'taxMinor')::bigint,
           (i ->> 'netMinor')::bigint, (i ->> 'netMinor')::bigint <> (i ->> 'grossMinor')::bigint - (i ->> 'feeMinor')::bigint - (i ->> 'taxMinor')::bigint
      from jsonb_array_elements(b -> 'items') i;
    v_recorded := v_recorded + 1;
    if v_dest_ok is false then
      -- Money was reported settled somewhere other than the lender's verified account: stop this lender's payments and tell the platform.
      perform private.raise_exception_impl(c.lender_org_id, 'settlement_account_mismatch', 'critical', 'platform', jsonb_build_object('settlement_batch_id', v_id::text));
      perform payments.system_suspend_payment_config(c.id, 'settlement_account_mismatch');
    end if;
  end loop;
  perform private.write_payments_audit(c.lender_org_id, 'payments.settlement_report.recorded', 'payment_config', c.id::text,
    jsonb_build_object('recorded', v_recorded, 'duplicates', v_dup, 'conflicts', v_bad));
  return jsonb_build_object('recorded', v_recorded, 'duplicates', v_dup, 'conflicts', v_bad);
end
$$;
comment on function payments.record_settlement_report(uuid, date, jsonb) is
  'System only. Records a provider settlement report (validated as a whole: all or nothing; money as digit strings; the amounts are stored as reported, never recomputed). A batch already recorded with the same content is a duplicate; with different content it opens an event_payload_conflict exception and changes nothing. A batch whose destination (last digits) is not the lender''s verified settlement account sets destination_ok = false, opens a CRITICAL platform exception (settlement_account_mismatch) and suspends that payment configuration. Returns counts.';

-- ---------------------------------------------------------------------------------------------
-- 6. Uploading the lender's bank credits (a person)
-- ---------------------------------------------------------------------------------------------
create or replace function payments.import_bank_credits(p_lender uuid, p_account uuid, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.payments_require_lender(p_lender, 'payment.reconcile');
  r jsonb;
  k text;
  v_inserted integer := 0;
  v_dup integer := 0;
  v_existing payments.bank_credits;
begin
  if p_account is null or not exists (select 1 from tenancy.lender_settlement_accounts s where s.id = p_account and s.lender_org_id = p_lender) then
    raise exception 'settlement account not found' using errcode = 'P0002';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) not between 1 and 2000 then
    raise exception 'invalid bank credits' using errcode = '22023', hint = 'bad_request';
  end if;
  -- Validate everything before writing anything: only value date, amount and UTR are accepted; any other field (a narration) refuses the whole upload.
  for r in select * from jsonb_array_elements(p_rows) loop
    if jsonb_typeof(r) <> 'object' then
      raise exception 'invalid bank credit' using errcode = '22023', hint = 'row_invalid';
    end if;
    for k in select jsonb_object_keys(r) loop
      if k not in ('valueDate', 'amountMinor', 'utr') then
        raise exception 'only the value date, the amount and the bank reference are accepted' using errcode = '22023', hint = 'unexpected_field';
      end if;
    end loop;
    if private.servicing_try_date(r ->> 'valueDate') is null or coalesce((r ->> 'amountMinor') !~ '^[1-9][0-9]{0,14}$', true)
       or coalesce((r ->> 'utr') !~ '^[A-Za-z0-9._:/-]{4,60}$', true) then
      raise exception 'invalid bank credit' using errcode = '22023', hint = 'row_invalid';
    end if;
    if private.servicing_try_date(r ->> 'valueDate') > (clock_timestamp() at time zone 'Asia/Kolkata')::date + 1 then
      raise exception 'a value date in the future is refused' using errcode = '22023', hint = 'row_invalid';
    end if;
    select * into v_existing from payments.bank_credits x where x.lender_org_id = p_lender and x.utr = (r ->> 'utr');
    if found and (v_existing.amount_minor <> (r ->> 'amountMinor')::bigint or v_existing.value_date <> private.servicing_try_date(r ->> 'valueDate') or v_existing.settlement_account_id <> p_account) then
      raise exception 'a bank reference already recorded differs from this upload' using errcode = '22023', hint = 'utr_conflict';
    end if;
  end loop;
  if (select count(*) from (select r2 ->> 'utr' u from jsonb_array_elements(p_rows) r2 group by 1 having count(distinct (r2 ->> 'amountMinor') || (r2 ->> 'valueDate')) > 1) d) > 0 then
    raise exception 'a bank reference appears twice with different content' using errcode = '22023', hint = 'utr_conflict';
  end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    insert into payments.bank_credits (lender_org_id, settlement_account_id, value_date, amount_minor, utr, recorded_by)
    values (p_lender, p_account, private.servicing_try_date(r ->> 'valueDate'), (r ->> 'amountMinor')::bigint, r ->> 'utr', v_uid)
    on conflict (lender_org_id, utr) do nothing;
    if found then v_inserted := v_inserted + 1; else v_dup := v_dup + 1; end if;
  end loop;
  perform private.write_payments_audit(p_lender, 'payments.bank_credits.imported', 'settlement_account', p_account::text, jsonb_build_object('inserted', v_inserted, 'duplicates', v_dup));
  return jsonb_build_object('inserted', v_inserted, 'duplicates', v_dup);
end
$$;
comment on function payments.import_bank_credits(uuid, uuid, jsonb) is
  'payment.reconcile of the lender, aal2. Records credits the lender reports in one of ITS OWN settlement accounts: [{valueDate, amountMinor (digit string), utr}] and nothing else (22023 unexpected_field: a narration may contain a name). All or nothing: one bad row (22023 row_invalid), a bank reference that differs from one already recorded or repeated with different content (22023 utr_conflict) refuses the whole upload. A repeated identical credit is a duplicate. The value date cannot be in the future. Returns counts.';

-- ---------------------------------------------------------------------------------------------
-- 7. The reconciliation run (system)
-- ---------------------------------------------------------------------------------------------
-- Raise an exception only if none was ever opened for the same class and subject: a resolved one is an annotation ("looked at"), not a licence to
-- open a new one every day; reopening is a person's decision (payments.reopen_exception).
create or replace function private.raise_exception_once(p_lender uuid, p_class text, p_severity text, p_owner text, p_subject jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text;
  v_id uuid;
begin
  select string_agg(e.key || '=' || (e.value #>> '{}'), ',' order by e.key) into v_key from jsonb_each(p_subject) e;
  select x.id into v_id from payments.reconciliation_exceptions x where x.lender_org_id = p_lender and x.class = p_class and x.subject_key = v_key order by x.opened_at limit 1;
  if found then
    return v_id;
  end if;
  return private.raise_exception_impl(p_lender, p_class, p_severity, p_owner, p_subject);
end
$$;
revoke all on function private.raise_exception_once(uuid, text, text, text, jsonb) from public;

create or replace function payments.run_reconciliation(p_lender uuid, p_date date)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_set payments.reconciliation_settings;
  v_lag integer;
  v_rlag integer;
  v_success text[] := private.payment_success_statuses();
  v_has_settlement boolean;
  v_has_bank boolean;
  v_has_receipts boolean;
  v_hash text;
  v_run payments.reconciliation_runs;
  v_no integer;
  v_n_pay integer;
  v_m_set integer;
  v_m_bank integer;
  v_m_rec integer;
  v_exc integer := 0;
  v_off_items integer;
  v_off_minor bigint;
  v_na text[] := '{}';
  x record;
begin
  if private.invoking_role() <> 'service_role' then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  if p_date is null or p_date > (clock_timestamp() at time zone 'Asia/Kolkata')::date or not exists (select 1 from tenancy.organizations o where o.id = p_lender and o.kind = 'lender') then
    raise exception 'invalid reconciliation request' using errcode = '22023', hint = 'bad_request';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('reconcile:' || p_lender::text || ':' || p_date::text, 0));
  select * into v_set from payments.reconciliation_settings s where s.lender_org_id = p_lender;
  v_lag := coalesce(v_set.settlement_lag_days, 3);
  v_rlag := coalesce(v_set.receipt_lag_hours, 72);
  v_has_settlement := exists (select 1 from payments.settlement_batches b where b.lender_org_id = p_lender);
  v_has_bank := exists (select 1 from payments.bank_credits c where c.lender_org_id = p_lender);
  v_has_receipts := exists (select 1 from servicing.lms_connections c where c.lender_org_id = p_lender and c.status = 'active' and coalesce((c.capabilities ->> 'receipts')::boolean, false));

  -- The canonical listing of every input. The same inputs give the same hash and so the same run.
  select encode(sha256(convert_to(
    coalesce((select string_agg(pp.id::text || ':' || pp.provider_payment_ref || ':' || pp.amount_minor, ',' order by pp.id) from payments.provider_payments pp
               where pp.lender_org_id = p_lender and pp.status = any (v_success) and not pp.duplicate_capture
                 and (coalesce(pp.captured_at, pp.created_at) at time zone 'Asia/Kolkata')::date <= p_date), '') || '|' ||
    coalesce((select string_agg(i.id::text || ':' || i.gross_minor, ',' order by i.id) from payments.settlement_items i join payments.settlement_batches b on b.id = i.batch_id and b.lender_org_id = i.lender_org_id
               where i.lender_org_id = p_lender and b.period_to <= p_date), '') || '|' ||
    coalesce((select string_agg(b.id::text || ':' || b.net_minor || ':' || coalesce(b.destination_ok::text, 'n'), ',' order by b.id) from payments.settlement_batches b
               where b.lender_org_id = p_lender and b.period_to <= p_date), '') || '|' ||
    coalesce((select string_agg(c.id::text || ':' || c.amount_minor || ':' || c.settlement_account_id::text, ',' order by c.id) from payments.bank_credits c
               where c.lender_org_id = p_lender and c.value_date <= p_date), '') || '|' ||
    coalesce((select string_agg(r.id::text || ':' || r.kind || ':' || r.amount_minor || ':' || coalesce(r.bank_reference, ''), ',' order by r.id) from servicing.lms_receipts r
               where r.lender_org_id = p_lender and r.value_date <= p_date), '') || '|' ||
    v_lag || ':' || v_rlag || ':' || v_has_receipts::text, 'UTF8')), 'hex') into v_hash;

  select * into v_run from payments.reconciliation_runs r where r.lender_org_id = p_lender and r.run_date = p_date and r.inputs_sha256 = v_hash;
  if found then
    return jsonb_build_object('run_id', v_run.id, 'run_no', v_run.run_no, 'unchanged', true);
  end if;
  select coalesce(max(r.run_no), 0) + 1 into v_no from payments.reconciliation_runs r where r.lender_org_id = p_lender and r.run_date = p_date;
  insert into payments.reconciliation_runs (lender_org_id, run_date, run_no, inputs_sha256) values (p_lender, p_date, v_no, v_hash) returning * into v_run;

  create temporary table if not exists pg_temp.recon_pay (id uuid, config_id uuid, intent_id uuid, provider text, ref text, amount bigint, captured_on date) on commit drop;
  delete from pg_temp.recon_pay;
  insert into pg_temp.recon_pay
  select pp.id, pp.config_id, pp.intent_id, pp.provider, pp.provider_payment_ref, pp.amount_minor, (coalesce(pp.captured_at, pp.created_at) at time zone 'Asia/Kolkata')::date
    from payments.provider_payments pp
   where pp.lender_org_id = p_lender and pp.status = any (v_success) and not pp.duplicate_capture and (coalesce(pp.captured_at, pp.created_at) at time zone 'Asia/Kolkata')::date <= p_date;
  select count(*) into v_n_pay from pg_temp.recon_pay;

  -- (a) provider payment to settlement item: reference and amount to the paisa
  insert into payments.reconciliation_matches (run_id, lender_org_id, kind, provider_payment_id, settlement_item_id, amount_minor)
  select v_run.id, p_lender, 'payment_settlement', p.id, i.id, p.amount
    from pg_temp.recon_pay p
    join payments.settlement_items i on i.lender_org_id = p_lender and i.provider_payment_ref = p.ref and i.gross_minor = p.amount
    join payments.settlement_batches b on b.id = i.batch_id and b.lender_org_id = i.lender_org_id and b.provider = p.provider and b.period_to <= p_date;
  get diagnostics v_m_set = row_count;
  for x in select p.id from pg_temp.recon_pay p
            where not exists (select 1 from payments.settlement_items i join payments.settlement_batches b on b.id = i.batch_id and b.lender_org_id = i.lender_org_id
                               where i.lender_org_id = p_lender and i.provider_payment_ref = p.ref and b.provider = p.provider and i.gross_minor = p.amount and b.period_to <= p_date)
              and exists (select 1 from payments.settlement_items i join payments.settlement_batches b on b.id = i.batch_id and b.lender_org_id = i.lender_org_id
                           where i.lender_org_id = p_lender and i.provider_payment_ref = p.ref and b.provider = p.provider and i.gross_minor <> p.amount and b.period_to <= p_date)
  loop
    perform private.raise_exception_once(p_lender, 'amount_mismatch', 'warning', 'lender', jsonb_build_object('provider_payment_id', x.id::text));
    v_exc := v_exc + 1;
  end loop;
  if v_has_settlement then
    for x in select p.id from pg_temp.recon_pay p
              where p_date - p.captured_on > v_lag
                and not exists (select 1 from payments.settlement_items i join payments.settlement_batches b on b.id = i.batch_id and b.lender_org_id = i.lender_org_id
                                 where i.lender_org_id = p_lender and i.provider_payment_ref = p.ref and b.provider = p.provider)
    loop
      perform private.raise_exception_once(p_lender, 'provider_success_no_settlement', 'warning', 'lender', jsonb_build_object('provider_payment_id', x.id::text));
      v_exc := v_exc + 1;
    end loop;
  else
    v_na := v_na || 'settlement_reports'::text;
  end if;
  -- A settlement item that no payment of this lender explains.
  for x in select i.id from payments.settlement_items i join payments.settlement_batches b on b.id = i.batch_id and b.lender_org_id = i.lender_org_id
            where i.lender_org_id = p_lender and b.period_to <= p_date
              and not exists (select 1 from payments.provider_payments pp where pp.lender_org_id = p_lender and pp.provider = b.provider and pp.provider_payment_ref = i.provider_payment_ref)
  loop
    perform private.raise_exception_once(p_lender, 'settlement_no_intent', 'warning', 'lender', jsonb_build_object('settlement_item_id', x.id::text));
    v_exc := v_exc + 1;
  end loop;
  -- Settled, but later than the waiting time.
  for x in select i.id from pg_temp.recon_pay p
            join payments.settlement_items i on i.lender_org_id = p_lender and i.provider_payment_ref = p.ref and i.gross_minor = p.amount
            join payments.settlement_batches b on b.id = i.batch_id and b.lender_org_id = i.lender_org_id and b.provider = p.provider and b.period_to <= p_date
            where b.period_to - p.captured_on > v_lag
  loop
    perform private.raise_exception_once(p_lender, 'late_settlement', 'info', 'lender', jsonb_build_object('settlement_item_id', x.id::text));
    v_exc := v_exc + 1;
  end loop;

  -- (b) settlement batch to bank credit: UTR, net amount and the configured settlement account
  insert into payments.reconciliation_matches (run_id, lender_org_id, kind, settlement_batch_id, bank_credit_id, amount_minor)
  select v_run.id, p_lender, 'settlement_bank', b.id, c.id, b.net_minor
    from payments.settlement_batches b
    join payments.bank_credits c on c.lender_org_id = p_lender and c.utr = b.settlement_ref and c.amount_minor = b.net_minor and c.value_date <= p_date
    join payments.lender_payment_configs cfg on cfg.id = b.config_id and cfg.lender_org_id = b.lender_org_id and cfg.settlement_account_id = c.settlement_account_id
   where b.lender_org_id = p_lender and b.period_to <= p_date and coalesce(b.destination_ok, true);
  get diagnostics v_m_bank = row_count;
  if v_has_bank then
    for x in select b.id, c.id as credit_id, c.amount_minor = b.net_minor as amount_ok, cfg.settlement_account_id = c.settlement_account_id as account_ok
               from payments.settlement_batches b
               join payments.bank_credits c on c.lender_org_id = p_lender and c.utr = b.settlement_ref and c.value_date <= p_date
               join payments.lender_payment_configs cfg on cfg.id = b.config_id and cfg.lender_org_id = b.lender_org_id
              where b.lender_org_id = p_lender and b.period_to <= p_date
                and not (c.amount_minor = b.net_minor and cfg.settlement_account_id = c.settlement_account_id and coalesce(b.destination_ok, true))
    loop
      if not x.amount_ok then
        perform private.raise_exception_once(p_lender, 'amount_mismatch', 'warning', 'lender', jsonb_build_object('settlement_batch_id', x.id::text));
      else
        perform private.raise_exception_once(p_lender, 'settlement_account_mismatch', 'critical', 'lender', jsonb_build_object('settlement_batch_id', x.id::text));
      end if;
      v_exc := v_exc + 1;
    end loop;
    for x in select b.id from payments.settlement_batches b
              where b.lender_org_id = p_lender and b.period_to <= p_date and p_date - b.period_to > v_lag
                and not exists (select 1 from payments.bank_credits c where c.lender_org_id = p_lender and c.utr = b.settlement_ref)
    loop
      perform private.raise_exception_once(p_lender, 'late_settlement', 'warning', 'lender', jsonb_build_object('settlement_batch_id', x.id::text));
      v_exc := v_exc + 1;
    end loop;
  else
    v_na := v_na || 'bank_credits'::text;
  end if;

  -- (c) provider payment to the lender's own receipt (the lender must carry our payment reference or the intent id)
  insert into payments.reconciliation_matches (run_id, lender_org_id, kind, provider_payment_id, receipt_id, amount_minor)
  select v_run.id, p_lender, 'payment_receipt', p.id, r.id, p.amount
    from pg_temp.recon_pay p
    join servicing.lms_receipts r on r.lender_org_id = p_lender and r.kind = 'receipt' and r.bank_reference in (p.ref, p.intent_id::text) and r.amount_minor = p.amount and r.value_date <= p_date
   where not exists (select 1 from servicing.lms_receipts rv where rv.reverses_receipt_id = r.id);
  get diagnostics v_m_rec = row_count;
  if v_has_receipts then
    for x in select p.id from pg_temp.recon_pay p
              where p_date - p.captured_on > ceil(v_rlag / 24.0)::integer
                and not exists (select 1 from servicing.lms_receipts r where r.lender_org_id = p_lender and r.kind = 'receipt' and r.bank_reference in (p.ref, p.intent_id::text)
                                  and r.amount_minor = p.amount and not exists (select 1 from servicing.lms_receipts rv where rv.reverses_receipt_id = r.id))
    loop
      perform private.raise_exception_once(p_lender, 'lender_receipt_missing', 'warning', 'lender', jsonb_build_object('provider_payment_id', x.id::text));
      v_exc := v_exc + 1;
    end loop;
  else
    v_na := v_na || 'lms_receipts'::text;
  end if;
  -- A receipt that names one of our intents (by id) when no such intent exists for this lender.
  for x in select r.id from servicing.lms_receipts r
            where r.lender_org_id = p_lender and r.kind = 'receipt' and r.value_date <= p_date and r.bank_reference ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              and not exists (select 1 from payments.payment_intents i where i.lender_org_id = p_lender and i.id::text = r.bank_reference)
  loop
    perform private.raise_exception_once(p_lender, 'lender_receipt_no_intent', 'warning', 'lender', jsonb_build_object('receipt_id', x.id::text));
    v_exc := v_exc + 1;
  end loop;

  -- The standing line: money the provider reported settled somewhere other than the lender's verified account.
  select count(i.id), coalesce(sum(i.gross_minor), 0) into v_off_items, v_off_minor
    from payments.settlement_items i join payments.settlement_batches b on b.id = i.batch_id and b.lender_org_id = i.lender_org_id
   where i.lender_org_id = p_lender and b.destination_ok is false and b.period_to <= p_date;

  update payments.reconciliation_runs set
    counts = jsonb_build_object('payments_considered', v_n_pay, 'matched_to_settlement', v_m_set, 'matched_to_bank', v_m_bank, 'matched_to_receipt', v_m_rec),
    report = jsonb_build_object(
      'run_date', p_date::text,
      'payments_considered', v_n_pay,
      'matched', jsonb_build_object('settlement', v_m_set, 'bank', v_m_bank, 'receipt', v_m_rec),
      'not_reconcilable', to_jsonb(v_na),
      'settled_to_non_lender', jsonb_build_object('items', v_off_items, 'minor', v_off_minor),
      'settings', jsonb_build_object('settlement_lag_days', v_lag, 'receipt_lag_hours', v_rlag))
   where id = v_run.id;
  drop table if exists pg_temp.recon_pay;
  perform private.write_payments_audit(p_lender, 'payments.reconciliation.run', 'reconciliation_run', v_run.id::text, jsonb_build_object('run_date', p_date::text, 'run_no', v_no));
  return jsonb_build_object('run_id', v_run.id, 'run_no', v_no, 'unchanged', false);
end
$$;
comment on function payments.run_reconciliation(uuid, date) is
  'System only (a daily worker, after the provider cut-off). Reconciles a lender up to a date: exact matches of provider payments to settlement items, settlement batches to bank credits (UTR, net amount, the configured settlement account) and provider payments to the lender''s own receipts; exceptions for what differs or stays missing beyond the waiting times (amount_mismatch, provider_success_no_settlement, settlement_no_intent, late_settlement, settlement_account_mismatch, lender_receipt_missing, lender_receipt_no_intent), each raised once per subject. An input source that does not exist (no settlement report, no bank credits, no LMS receipts capability) is listed as not reconcilable, never as reconciled. Idempotent: a run on unchanged inputs returns the same run; changed inputs make a new run number. It never changes a payment, an intent, a receipt or any other money row. The report carries the standing line "settled to non-lender accounts".';

-- ---------------------------------------------------------------------------------------------
-- 8. The derived stage of each payment, and the lender's view of a run
-- ---------------------------------------------------------------------------------------------
create or replace view payments.payment_stages as
select pp.id as provider_payment_id, pp.lender_org_id, pp.intent_id, pp.loan_account_id, pp.amount_minor, pp.captured_at,
       true as provider_captured,
       si.id is not null as provider_settled,
       (bc.id is not null) as bank_confirmed,
       (rc.id is not null) as lender_posted,
       case when rc.id is not null then 'lender_posted' when bc.id is not null then 'bank_confirmed' when si.id is not null then 'provider_settled' else 'provider_captured' end as stage,
       sb.destination_ok as settlement_destination_ok
from payments.provider_payments pp
left join lateral (
  select i.* from payments.settlement_items i join payments.settlement_batches b on b.id = i.batch_id and b.lender_org_id = i.lender_org_id
   where i.lender_org_id = pp.lender_org_id and i.provider_payment_ref = pp.provider_payment_ref and b.provider = pp.provider and i.gross_minor = pp.amount_minor
   order by b.period_to, i.id limit 1) si on true
left join payments.settlement_batches sb on sb.id = si.batch_id and sb.lender_org_id = si.lender_org_id
left join lateral (
  select c.* from payments.bank_credits c join payments.lender_payment_configs cfg on cfg.id = pp.config_id and cfg.lender_org_id = pp.lender_org_id
   where c.lender_org_id = pp.lender_org_id and c.utr = sb.settlement_ref and c.amount_minor = sb.net_minor and c.settlement_account_id = cfg.settlement_account_id
     and coalesce(sb.destination_ok, true)
   order by c.value_date limit 1) bc on true
left join lateral (
  select r.* from servicing.lms_receipts r
   where r.loan_account_id = pp.loan_account_id and r.lender_org_id = pp.lender_org_id and r.kind = 'receipt' and r.bank_reference in (pp.provider_payment_ref, pp.intent_id::text)
     and r.amount_minor = pp.amount_minor and not exists (select 1 from servicing.lms_receipts rv where rv.reverses_receipt_id = r.id)
   order by r.value_date limit 1) rc on true
where pp.status = any (private.payment_success_statuses()) and not pp.duplicate_capture
  and pp.lender_org_id in (select private.orgs_with_permission('payment.read'));
comment on view payments.payment_stages is
  'The settlement stage of each successful provider payment, DERIVED from the tables (provider_captured: a verified event; provider_settled: a settlement item with the same reference and amount; bank_confirmed: a bank credit with the batch''s UTR and net amount in the configured settlement account, only if the reported destination is that account; lender_posted: the lender''s own receipt carrying the reference or intent id, same amount, not reversed). Nothing sets a stage and no function accepts one. Lenders with payment.read see their own lender''s rows only.';

create or replace function payments.reconciliation_summary(p_lender uuid, p_date date)
returns table (run_id uuid, run_no integer, run_date date, counts jsonb, report jsonb, created_at timestamptz)
language sql
stable
set search_path = ''
as $$
  select r.id, r.run_no, r.run_date, r.counts, r.report, r.created_at
    from payments.reconciliation_runs r
   where r.lender_org_id = p_lender and r.run_date = p_date
   order by r.run_no desc
   limit 1
$$;
comment on function payments.reconciliation_summary(uuid, date) is
  'The newest reconciliation run of a lender for a date, with its counts and report. SECURITY INVOKER: row level security applies (payment.read, payment.reconcile).';

-- ---------------------------------------------------------------------------------------------
-- 9. Row level security and grants (lenders read their own rows; nobody writes directly; the system role reads only)
-- ---------------------------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['reconciliation_settings', 'settlement_batches', 'settlement_items', 'bank_credits', 'reconciliation_runs', 'reconciliation_matches']
  loop
    execute format('alter table payments.%I enable row level security', t);
    execute format('alter table payments.%I force row level security', t);
    execute format('create policy %I on payments.%I for select to authenticated using (lender_org_id in (select private.orgs_with_permission(%L)))',
                   t || '_lender_read', t, 'payment.read');
    execute format('revoke all on payments.%I from public, anon, authenticated, service_role', t);
    execute format('grant select on payments.%I to authenticated, service_role', t);
  end loop;
end
$$;
revoke all on payments.payment_stages from public, anon, authenticated, service_role;
grant select on payments.payment_stages to authenticated;

revoke all on function payments.set_reconciliation_settings(uuid, integer, integer) from public;
revoke all on function payments.record_settlement_report(uuid, date, jsonb) from public;
revoke all on function payments.import_bank_credits(uuid, uuid, jsonb) from public;
revoke all on function payments.run_reconciliation(uuid, date) from public;
revoke all on function payments.reconciliation_summary(uuid, date) from public;
grant execute on function payments.set_reconciliation_settings(uuid, integer, integer) to authenticated;
grant execute on function payments.record_settlement_report(uuid, date, jsonb) to service_role;
grant execute on function payments.import_bank_credits(uuid, uuid, jsonb) to authenticated;
grant execute on function payments.run_reconciliation(uuid, date) to service_role;
grant execute on function payments.reconciliation_summary(uuid, date) to authenticated;
