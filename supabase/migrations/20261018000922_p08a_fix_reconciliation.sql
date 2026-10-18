-- =============================================================================================
-- Phase 08a review fixes, area SR: reconciliation, settlement and the stage view (forward-only; redefines only functions of migration 20261018000916).
-- Findings: A44 (database half), U12 to U26 and U57 of the migration review.
--
--   1. Destinations are compared by their LAST FOUR DIGITS (not the whole mask string). A batch with no destination, an unreadable one, or one that
--      shows fewer than four digits and agrees on those is NOT the lender's account: destination_ok stays null, nothing is matched or confirmed, the
--      platform gets a warning, and the run counts it ("destination unstated") next to the standing line. Zero "settled to non-lender" is evidence
--      only when a settlement report exists and no batch lacks a verified destination (report.settlement_evidence.zero_is_evidence).
--   2. The standing line is computed from the BATCHES (net amount that moved), not from item gross.
--   3. Batch totals are tied to the items when the report is recorded (items_total_mismatch); a batch whose items do not add up, or whose own parts
--      do not add up, is never matched to a bank credit and never "bank_confirmed", and opens an exception for the platform.
--   4. A settlement reference (UTR) is one settlement of one configuration (unique index); a bank credit confirms at most one batch (run and view);
--      one match per payment, item, credit, batch and receipt in a run (unique indexes).
--   5. Receipts are matched to the payment's own loan account; a receipt carrying our reference on another loan is an exception; a payment settled or
--      posted twice, and an extra settlement item of another amount, are exceptions; a payment settled before it was captured is an exception.
--   6. Exceptions the run raises are raised once per subject, but reappear when the condition RECURRED after a person resolved it (the counter-match
--      existed in a later run and is gone now). Amount and account are judged independently; a wrong-account critical belongs to the platform.
--   7. Bank-credit UTRs have a strict shape (uppercase alphanumeric, 12 to 22 characters, a four-letter bank prefix): PAN-, Aadhaar-, phone- and
--      account-number-shaped values, narrations and names are refused (the whole upload, nothing echoed). Limits match the table checks (22023, never a raw 23514).
--   8. Settlement period must not end after the report date; the run's "never settled" test uses the same date window as the match.
--   9. payments.payment_stages runs with the CALLER's rights (security_invoker) and as a security barrier. The lender-posted stage reads the lender's receipts
--      through a narrow definer function limited to payments the caller may already read.
--  10. Waiting times have a platform ceiling (7 days, 168 hours); the audit event keeps the previous values; the run reports whether they exceed the defaults.
--
-- Not done (needs another area or an owner decision): see docs/specs/08a-notes/fixes-SR.md.
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- 1. Small pure helpers (immutable, no table access)
-- ---------------------------------------------------------------------------------------------
-- Is the reported destination the account? true / false when the last digits can be compared (up to four); null when they cannot be compared or agree
-- on fewer than four digits (inconclusive). p_reported must already be a well-formed mask (the caller maps anything else to null).
create or replace function private.recon_destination_ok(p_reported text, p_account text)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_r text := substring(p_reported from '[0-9]+$');
  v_a text := substring(p_account from '[0-9]+$');
  v_n integer;
begin
  if p_reported is null or v_r is null or v_a is null then
    return null;
  end if;
  v_n := least(length(v_r), length(v_a), 4);
  if right(v_r, v_n) <> right(v_a, v_n) then
    return false;
  end if;
  if v_n >= 4 then
    return true;
  end if;
  return null;
end
$$;
revoke all on function private.recon_destination_ok(text, text) from public;
comment on function private.recon_destination_ok(text, text) is
  'Compares a reported destination mask with the account''s masked reference by their last four digits (fewer if less is shown): true or false when comparable, null when the digits cannot be compared or agree on fewer than four (never treated as the lender''s account).';

-- Money as a digit string of paise within the table limit: no cast error, no raw CHECK violation.
create or replace function private.recon_paise_ok(p text, p_min bigint default 0)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case when p ~ '^[0-9]{1,15}$' then p::bigint between p_min and 100000000000000 else false end
$$;
revoke all on function private.recon_paise_ok(text, bigint) from public;
comment on function private.recon_paise_ok(text, bigint) is
  'True when the text is a digit string of paise between the minimum and the table limit of 100000000000000. Never raises.';

-- The shape of a bank reference (UTR). UNVERIFIED, derived from the NEFT (16) and RTGS (22) conventions seen on statements: four capital letters
-- (the sending bank), then 8 to 18 capital letters or digits: 12 to 22 characters in all, no separators, at least six digits, no run of seven or more
-- letters (a name), and no PAN-shaped part. Bare digit strings are refused on purpose: a 12-digit IMPS or UPI reference cannot be told from an Aadhaar
-- number, and a phone or account number is a digit string too. The guard cannot detect every value that hides a name; it removes the shapes that
-- identify a person by themselves.
create or replace function private.recon_utr_ok(p text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p is not null
     and p ~ '^[A-Z]{4}[A-Z0-9]{8,18}$'
     and length(regexp_replace(p, '[^0-9]', '', 'g')) >= 6
     and p !~ '[A-Z]{7,}'
     and p !~ '[A-Z]{5}[0-9]{4}[A-Z]'
$$;
revoke all on function private.recon_utr_ok(text) from public;
comment on function private.recon_utr_ok(text) is
  'UNVERIFIED shape rule for a bank reference (UTR): 12 to 22 capital letters and digits starting with four capital letters, at least six digits, no run of seven or more letters, no PAN-shaped part. A bare digit string (an Aadhaar, phone or account number, or an IMPS reference) is refused.';

-- ---------------------------------------------------------------------------------------------
-- 2. Tables: the guards that must hold even if a function is wrong
-- ---------------------------------------------------------------------------------------------
-- null = recorded before the check existed: never confirmed.
alter table payments.settlement_batches add column items_total_mismatch boolean;
comment on column payments.settlement_batches.items_total_mismatch is
  'true = the items of the batch do not add up to the batch''s gross, fee, tax and net as the provider reported them (an item-less batch with a non-zero total counts); false = they do; null = recorded before this check existed (treated as not tied). Set only by payments.record_settlement_report.';

-- A settlement reference (UTR) names one settlement of one configuration: a bank credit can confirm at most one batch.
create unique index settlement_batches_config_utr on payments.settlement_batches (lender_org_id, config_id, settlement_ref);

-- One match per payment, item, credit, batch and receipt within a run. The run never produces more; these keys make a second one impossible.
create unique index reconciliation_matches_payment_settlement_once on payments.reconciliation_matches (run_id, provider_payment_id) where kind = 'payment_settlement';
create unique index reconciliation_matches_item_once on payments.reconciliation_matches (run_id, settlement_item_id) where kind = 'payment_settlement';
create unique index reconciliation_matches_batch_once on payments.reconciliation_matches (run_id, settlement_batch_id) where kind = 'settlement_bank';
create unique index reconciliation_matches_credit_once on payments.reconciliation_matches (run_id, bank_credit_id) where kind = 'settlement_bank';
create unique index reconciliation_matches_payment_receipt_once on payments.reconciliation_matches (run_id, provider_payment_id) where kind = 'payment_receipt';
create unique index reconciliation_matches_receipt_once on payments.reconciliation_matches (run_id, receipt_id) where kind = 'payment_receipt';

-- New bank credits must have the UTR shape (existing rows are not re-checked).
alter table payments.bank_credits add constraint bank_credits_utr_shape check (private.recon_utr_ok(utr)) not valid;

-- Waiting times: a platform ceiling (UNVERIFIED defaults of the platform, changed only by migration). A lender cannot lengthen them without limit and so
-- mute the missing-settlement and missing-receipt exceptions. Rows written before this migration that exceed it stay readable (not valid) and are
-- capped when a run reads them.
alter table payments.reconciliation_settings drop constraint reconciliation_settings_settlement_lag_days_check;
alter table payments.reconciliation_settings drop constraint reconciliation_settings_receipt_lag_hours_check;
alter table payments.reconciliation_settings add constraint reconciliation_settings_settlement_lag_ceiling check (settlement_lag_days between 1 and 7) not valid;
alter table payments.reconciliation_settings add constraint reconciliation_settings_receipt_lag_ceiling check (receipt_lag_hours between 1 and 168) not valid;
comment on table payments.reconciliation_settings is
  'How long reconciliation waits before it calls a missing item an exception: days for the provider to settle and for the bank to credit (1 to 7), hours for the lender to post a receipt (1 to 168). Without a row the defaults (3 days, 72 hours) apply; they are PLATFORM DEFAULTS with no source, to be replaced from the provider and lender agreements, and the ceilings are platform limits (UNVERIFIED), so a lender cannot mute the missing-item exceptions. Written only by payments.set_reconciliation_settings (payment.configure, aal2); the audit event keeps the previous values. Owner: payments module.';

-- ---------------------------------------------------------------------------------------------
-- 3. The waiting times
-- ---------------------------------------------------------------------------------------------
create or replace function payments.set_reconciliation_settings(p_lender uuid, p_settlement_lag_days integer, p_receipt_lag_hours integer)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.payments_require_lender(p_lender, 'payment.configure');
  v_old payments.reconciliation_settings;
begin
  if p_settlement_lag_days is null or p_settlement_lag_days not between 1 and 7 or p_receipt_lag_hours is null or p_receipt_lag_hours not between 1 and 168 then
    raise exception 'invalid reconciliation settings' using errcode = '22023', hint = 'settings_invalid';
  end if;
  select * into v_old from payments.reconciliation_settings s where s.lender_org_id = p_lender;
  insert into payments.reconciliation_settings (lender_org_id, settlement_lag_days, receipt_lag_hours, updated_by)
  values (p_lender, p_settlement_lag_days, p_receipt_lag_hours, v_uid)
  on conflict (lender_org_id) do update set settlement_lag_days = excluded.settlement_lag_days, receipt_lag_hours = excluded.receipt_lag_hours,
    updated_by = excluded.updated_by, updated_at = clock_timestamp();
  perform private.write_payments_audit(p_lender, 'payments.reconciliation_settings.set', 'reconciliation_settings', p_lender::text,
    jsonb_build_object('settlement_lag_days', p_settlement_lag_days, 'receipt_lag_hours', p_receipt_lag_hours,
                       'previous_settlement_lag_days', v_old.settlement_lag_days, 'previous_receipt_lag_hours', v_old.receipt_lag_hours));
  return 'set';
end
$$;
comment on function payments.set_reconciliation_settings(uuid, integer, integer) is
  'payment.configure of the lender, aal2. Sets the waiting times of reconciliation: 1 to 7 days and 1 to 168 hours, the platform ceilings (22023 settings_invalid). Applies to runs made afterwards. The audit event keeps the previous values; every run reports the settings it used and whether they exceed the platform defaults.';

-- ---------------------------------------------------------------------------------------------
-- 4. Recording what the provider settled (system)
-- ---------------------------------------------------------------------------------------------
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
  v_holder payments.settlement_batches;
  v_id uuid;
  v_recorded integer := 0;
  v_dup integer := 0;
  v_bad integer := 0;
  v_gross bigint; v_fee bigint; v_tax bigint; v_net bigint;
  v_sg bigint; v_sf bigint; v_st bigint; v_sn bigint;
  v_items integer;
  v_dest text;
  v_mask text;
  v_dest_ok boolean;
  v_tied boolean;
  v_parts boolean;
begin
  if private.invoking_role() <> 'service_role' then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  if p_report_date is null or p_batches is null or jsonb_typeof(p_batches) <> 'array' or jsonb_array_length(p_batches) > 500
     or p_report_date > private.today_ist() then
    raise exception 'invalid settlement report' using errcode = '22023', hint = 'bad_request';
  end if;
  select * into c from payments.lender_payment_configs x where x.id = p_config;
  if not found then
    raise exception 'payment configuration not found' using errcode = 'P0002';
  end if;
  select * into v_acct from tenancy.lender_settlement_accounts s where s.id = c.settlement_account_id and s.lender_org_id = c.lender_org_id;
  -- Validate the whole report first: all or nothing. Every limit of the tables is checked here, so a bad value answers 22023 and never a raw CHECK failure.
  for b in select * from jsonb_array_elements(p_batches) loop
    if jsonb_typeof(b) <> 'object'
       or (b ->> 'batchRef') is null or (b ->> 'batchRef') !~ '^[A-Za-z0-9._:=+/-]{1,200}$'
       or (b ->> 'settlementRef') is null or (b ->> 'settlementRef') !~ '^[A-Za-z0-9._:/-]{4,60}$'
       or private.servicing_try_date(b ->> 'periodFrom') is null or private.servicing_try_date(b ->> 'periodTo') is null
       or private.servicing_try_date(b ->> 'periodTo') < private.servicing_try_date(b ->> 'periodFrom')
       or private.servicing_try_date(b ->> 'periodTo') > p_report_date
       or coalesce(jsonb_typeof(b -> 'destinationMaskedRef') not in ('string', 'null'), false)
       or length(coalesce(b ->> 'destinationMaskedRef', '')) > 100
       or not private.recon_paise_ok(b ->> 'grossMinor') or not private.recon_paise_ok(b ->> 'feeMinor')
       or not private.recon_paise_ok(b ->> 'taxMinor') or not private.recon_paise_ok(b ->> 'netMinor')
       or jsonb_typeof(b -> 'items') is distinct from 'array' or jsonb_array_length(b -> 'items') > 20000 then
      raise exception 'invalid settlement batch' using errcode = '22023', hint = 'bad_request';
    end if;
    for it in select * from jsonb_array_elements(b -> 'items') loop
      if jsonb_typeof(it) <> 'object' or (it ->> 'providerPaymentRef') is null or (it ->> 'providerPaymentRef') !~ '^[A-Za-z0-9._:=+/-]{1,200}$'
         or (it ->> 'orderRef') is not null and (it ->> 'orderRef') !~ '^[A-Za-z0-9._:=+/-]{1,200}$'
         or not private.recon_paise_ok(it ->> 'grossMinor') or not private.recon_paise_ok(it ->> 'feeMinor')
         or not private.recon_paise_ok(it ->> 'taxMinor') or not private.recon_paise_ok(it ->> 'netMinor') then
        raise exception 'invalid settlement item' using errcode = '22023', hint = 'bad_request';
      end if;
    end loop;
    if (select count(distinct (i ->> 'providerPaymentRef')) from jsonb_array_elements(b -> 'items') i) <> jsonb_array_length(b -> 'items') then
      raise exception 'a payment appears twice in one settlement batch' using errcode = '22023', hint = 'bad_request';
    end if;
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
    -- One settlement reference (UTR) is one settlement of one configuration: a second batch under the same reference is not stored (a bank credit could
    -- otherwise confirm both) and the platform is told, against the batch that already holds it.
    select * into v_holder from payments.settlement_batches x where x.lender_org_id = c.lender_org_id and x.config_id = c.id and x.settlement_ref = (b ->> 'settlementRef');
    if found then
      perform private.raise_exception_impl(c.lender_org_id, 'event_payload_conflict', 'critical', 'platform', jsonb_build_object('settlement_batch_id', v_holder.id::text));
      v_bad := v_bad + 1;
      continue;
    end if;
    v_gross := (b ->> 'grossMinor')::bigint; v_fee := (b ->> 'feeMinor')::bigint; v_tax := (b ->> 'taxMinor')::bigint; v_net := (b ->> 'netMinor')::bigint;
    v_items := jsonb_array_length(b -> 'items');
    select coalesce(sum((i ->> 'grossMinor')::bigint), 0), coalesce(sum((i ->> 'feeMinor')::bigint), 0), coalesce(sum((i ->> 'taxMinor')::bigint), 0), coalesce(sum((i ->> 'netMinor')::bigint), 0)
      into v_sg, v_sf, v_st, v_sn from jsonb_array_elements(b -> 'items') i;
    v_tied := v_sg = v_gross and v_sf = v_fee and v_st = v_tax and v_sn = v_net;
    v_parts := v_net <> v_gross - v_fee - v_tax;
    -- Only a well-formed mask is stored (never anything that could be a full account number). Anything else is "not stated".
    v_dest := b ->> 'destinationMaskedRef';
    v_mask := case when v_dest ~ '^[X*]{2,}[0-9]{2,4}$' then v_dest end;
    v_dest_ok := private.recon_destination_ok(v_mask, v_acct.masked_account_ref);
    insert into payments.settlement_batches (lender_org_id, config_id, provider, batch_ref, settlement_ref, period_from, period_to, destination_masked_ref, destination_ok,
                                             gross_minor, fee_minor, tax_minor, net_minor, parts_mismatch, item_count, content_sha256, report_date, items_total_mismatch)
    values (c.lender_org_id, c.id, c.provider, b ->> 'batchRef', b ->> 'settlementRef', private.servicing_try_date(b ->> 'periodFrom'), private.servicing_try_date(b ->> 'periodTo'), v_mask, v_dest_ok,
            v_gross, v_fee, v_tax, v_net, v_parts, v_items, v_hash, p_report_date, not v_tied)
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
    elsif v_dest_ok is null then
      -- No destination, an unreadable one, or too few digits to compare: it is NOT the lender's account until shown to be. The platform is told
      -- (a warning: nothing proves it went elsewhere, so payments are not stopped); the run counts it and never confirms the batch.
      perform private.raise_exception_impl(c.lender_org_id, 'settlement_account_mismatch', 'warning', 'platform', jsonb_build_object('settlement_batch_id', v_id::text));
    end if;
    if not v_tied or v_parts then
      -- The provider's own report does not add up (items against the batch total, or the batch's parts against its net): a platform matter.
      perform private.raise_exception_impl(c.lender_org_id, 'event_payload_conflict', 'warning', 'platform', jsonb_build_object('settlement_batch_id', v_id::text));
    end if;
  end loop;
  perform private.write_payments_audit(c.lender_org_id, 'payments.settlement_report.recorded', 'payment_config', c.id::text,
    jsonb_build_object('recorded', v_recorded, 'duplicates', v_dup, 'conflicts', v_bad));
  return jsonb_build_object('recorded', v_recorded, 'duplicates', v_dup, 'conflicts', v_bad);
end
$$;
comment on function payments.record_settlement_report(uuid, date, jsonb) is
  'System only. Records a provider settlement report (validated as a whole: all or nothing; money as digit strings within the table limits; the period may not end after the report date; the amounts are stored as reported, never recomputed). A batch already recorded with the same content is a duplicate; with different content, or under a settlement reference (UTR) another batch of the configuration already holds, it opens an event_payload_conflict exception and changes nothing (counted as a conflict). The destination is compared with the verified settlement account by its LAST FOUR DIGITS: not the account sets destination_ok = false, opens a CRITICAL platform exception (settlement_account_mismatch) and suspends the payment configuration; not stated, unreadable or inconclusive leaves destination_ok null and opens a WARNING platform exception (the batch is never matched or confirmed). Items are tied to the batch totals (items_total_mismatch); a batch whose items or parts do not add up opens a platform event_payload_conflict exception. Returns counts.';

-- ---------------------------------------------------------------------------------------------
-- 5. Uploading the lender's bank credits (a person)
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
  -- The error never carries a value from the file.
  for r in select * from jsonb_array_elements(p_rows) loop
    if jsonb_typeof(r) <> 'object' then
      raise exception 'invalid bank credit' using errcode = '22023', hint = 'row_invalid';
    end if;
    for k in select jsonb_object_keys(r) loop
      if k not in ('valueDate', 'amountMinor', 'utr') then
        raise exception 'only the value date, the amount and the bank reference are accepted' using errcode = '22023', hint = 'unexpected_field';
      end if;
    end loop;
    if private.servicing_try_date(r ->> 'valueDate') is null
       or not coalesce((r ->> 'amountMinor') ~ '^[1-9][0-9]{0,14}$' and private.recon_paise_ok(r ->> 'amountMinor', 1), false)
       or not coalesce(private.recon_utr_ok(r ->> 'utr'), false) then
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
  'payment.reconcile of the lender, aal2. Records credits the lender reports in one of ITS OWN settlement accounts: [{valueDate, amountMinor (digit string, 1 to 100000000000000), utr}] and nothing else (22023 unexpected_field: a narration may contain a name). The bank reference must have the UTR shape (UNVERIFIED: 12 to 22 capital letters and digits, a four-letter bank prefix, no separators; a bare digit string, a PAN-shaped or name-like value is refused). All or nothing: one bad row (22023 row_invalid, no value echoed), a bank reference that differs from one already recorded or repeated with different content (22023 utr_conflict) refuses the whole upload. A repeated identical credit is a duplicate. The value date cannot be in the future. The credit is the LENDER''S statement, not a bank feed: stages built on it are lender-reported. Returns counts.';

-- ---------------------------------------------------------------------------------------------
-- 6. The run
-- ---------------------------------------------------------------------------------------------
-- Raise an exception the run found, once per subject. A resolved exception is an annotation and is not reopened by the next run, UNLESS the condition
-- recurred: p_cleared_kind / p_cleared_target name the match whose existence in a run after the resolution proves the condition had cleared (and which
-- is absent now). Only the system function that runs the reconciliation calls this.
create or replace function private.recon_raise(p_lender uuid, p_class text, p_severity text, p_owner text, p_subject jsonb,
                                               p_cleared_kind text default null, p_cleared_target uuid default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text;
  v_id uuid;
  v_status text;
  v_resolved_at timestamptz;
begin
  select string_agg(e.key || '=' || (e.value #>> '{}'), ',' order by e.key) into v_key from jsonb_each(p_subject) e;
  select x.id, x.status, x.resolved_at into v_id, v_status, v_resolved_at from payments.reconciliation_exceptions x
   where x.lender_org_id = p_lender and x.class = p_class and x.subject_key = v_key order by x.opened_at desc, x.id desc limit 1;
  if not found then
    return private.raise_exception_impl(p_lender, p_class, p_severity, p_owner, p_subject);
  end if;
  if v_status <> 'resolved' then
    return v_id;
  end if;
  if p_cleared_kind is not null and p_cleared_target is not null and exists (
       select 1 from payments.reconciliation_matches m join payments.reconciliation_runs r on r.id = m.run_id and r.lender_org_id = m.lender_org_id
        where m.lender_org_id = p_lender and m.kind = p_cleared_kind and r.created_at > v_resolved_at
          and ((p_cleared_kind = 'settlement_bank' and m.settlement_batch_id = p_cleared_target)
               or (p_cleared_kind <> 'settlement_bank' and m.provider_payment_id = p_cleared_target))) then
    return private.raise_exception_impl(p_lender, p_class, p_severity, p_owner, p_subject);
  end if;
  return v_id;
end
$$;
revoke all on function private.recon_raise(uuid, text, text, text, jsonb, text, uuid) from public;
comment on function private.recon_raise(uuid, text, text, text, jsonb, text, uuid) is
  'Opens an exception for (lender, class, subject) unless one is open, or the newest one was resolved and the condition has not recurred since (recurrence: a later run matched the counter-evidence, which is gone now). Internal to payments.run_reconciliation.';

create or replace function payments.run_reconciliation(p_lender uuid, p_date date)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_max_lag constant integer := 7;
  c_max_rlag constant integer := 168;
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
  v_visible integer;
  v_off_batches integer;
  v_off_items integer;
  v_off_minor bigint;
  v_unstated_batches integer;
  v_unstated_minor bigint;
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
  -- The platform ceilings apply to what a run reads (a row written before they existed is capped).
  v_lag := least(coalesce(v_set.settlement_lag_days, 3), c_max_lag);
  v_rlag := least(coalesce(v_set.receipt_lag_hours, 72), c_max_rlag);
  v_has_settlement := exists (select 1 from payments.settlement_batches b where b.lender_org_id = p_lender);
  v_has_bank := exists (select 1 from payments.bank_credits c where c.lender_org_id = p_lender);
  v_has_receipts := exists (select 1 from servicing.lms_connections c where c.lender_org_id = p_lender and c.status = 'active' and coalesce((c.capabilities ->> 'receipts')::boolean, false));

  -- The canonical listing of every input. The same inputs give the same hash and so the same run.
  select encode(sha256(convert_to(
    coalesce((select string_agg(pp.id::text || ':' || pp.provider_payment_ref || ':' || pp.amount_minor || ':' || pp.loan_account_id::text, ',' order by pp.id) from payments.provider_payments pp
               where pp.lender_org_id = p_lender and pp.status = any (v_success) and not pp.duplicate_capture
                 and (coalesce(pp.captured_at, pp.created_at) at time zone 'Asia/Kolkata')::date <= p_date), '') || '|' ||
    coalesce((select string_agg(i.id::text || ':' || i.gross_minor, ',' order by i.id) from payments.settlement_items i join payments.settlement_batches b on b.id = i.batch_id and b.lender_org_id = i.lender_org_id
               where i.lender_org_id = p_lender and b.period_to <= p_date), '') || '|' ||
    coalesce((select string_agg(b.id::text || ':' || b.gross_minor || ':' || b.net_minor || ':' || coalesce(b.destination_ok::text, 'n') || ':' || coalesce(b.items_total_mismatch::text, 'n') || ':' || b.parts_mismatch::text, ',' order by b.id)
               from payments.settlement_batches b where b.lender_org_id = p_lender and b.period_to <= p_date), '') || '|' ||
    coalesce((select string_agg(c.id::text || ':' || c.amount_minor || ':' || c.settlement_account_id::text, ',' order by c.id) from payments.bank_credits c
               where c.lender_org_id = p_lender and c.value_date <= p_date), '') || '|' ||
    coalesce((select string_agg(r.id::text || ':' || r.kind || ':' || r.amount_minor || ':' || r.loan_account_id::text || ':' || coalesce(r.bank_reference, ''), ',' order by r.id) from servicing.lms_receipts r
               where r.lender_org_id = p_lender and r.value_date <= p_date), '') || '|' ||
    v_lag || ':' || v_rlag || ':' || v_has_receipts::text, 'UTF8')), 'hex') into v_hash;

  select * into v_run from payments.reconciliation_runs r where r.lender_org_id = p_lender and r.run_date = p_date and r.inputs_sha256 = v_hash;
  if found then
    return jsonb_build_object('run_id', v_run.id, 'run_no', v_run.run_no, 'unchanged', true);
  end if;
  select coalesce(max(r.run_no), 0) + 1 into v_no from payments.reconciliation_runs r where r.lender_org_id = p_lender and r.run_date = p_date;
  insert into payments.reconciliation_runs (lender_org_id, run_date, run_no, inputs_sha256) values (p_lender, p_date, v_no, v_hash) returning * into v_run;

  create temporary table if not exists pg_temp.recon_pay (id uuid, config_id uuid, intent_id uuid, loan_id uuid, provider text, ref text, amount bigint, captured_on date) on commit drop;
  delete from pg_temp.recon_pay;
  insert into pg_temp.recon_pay
  select pp.id, pp.config_id, pp.intent_id, pp.loan_account_id, pp.provider, pp.provider_payment_ref, pp.amount_minor, (coalesce(pp.captured_at, pp.created_at) at time zone 'Asia/Kolkata')::date
    from payments.provider_payments pp
   where pp.lender_org_id = p_lender and pp.status = any (v_success) and not pp.duplicate_capture and (coalesce(pp.captured_at, pp.created_at) at time zone 'Asia/Kolkata')::date <= p_date;
  select count(*) into v_n_pay from pg_temp.recon_pay;

  -- (a) provider payment to settlement item: reference and amount to the paisa; ONE item per payment (the earliest), each item explains one payment
  insert into payments.reconciliation_matches (run_id, lender_org_id, kind, provider_payment_id, settlement_item_id, amount_minor)
  select distinct on (p.id) v_run.id, p_lender, 'payment_settlement', p.id, i.id, p.amount
    from pg_temp.recon_pay p
    join payments.settlement_items i on i.lender_org_id = p_lender and i.provider_payment_ref = p.ref and i.gross_minor = p.amount
    join payments.settlement_batches b on b.id = i.batch_id and b.lender_org_id = i.lender_org_id and b.provider = p.provider and b.period_to <= p_date
   order by p.id, b.period_to, i.id;
  get diagnostics v_m_set = row_count;
  -- An item of ANOTHER amount for the same payment, whether or not an item of the right amount exists as well.
  for x in select p.id,
                  exists (select 1 from payments.settlement_items i2 join payments.settlement_batches b2 on b2.id = i2.batch_id and b2.lender_org_id = i2.lender_org_id
                           where i2.lender_org_id = p_lender and i2.provider_payment_ref = p.ref and b2.provider = p.provider and i2.gross_minor = p.amount and b2.period_to <= p_date) as has_equal
             from pg_temp.recon_pay p
            where exists (select 1 from payments.settlement_items i join payments.settlement_batches b on b.id = i.batch_id and b.lender_org_id = i.lender_org_id
                           where i.lender_org_id = p_lender and i.provider_payment_ref = p.ref and b.provider = p.provider and i.gross_minor <> p.amount and b.period_to <= p_date)
  loop
    perform private.recon_raise(p_lender, 'amount_mismatch', 'warning', 'lender', jsonb_build_object('provider_payment_id', x.id::text),
                                case when x.has_equal then null else 'payment_settlement' end, x.id);
    v_exc := v_exc + 1;
  end loop;
  -- Settled twice: every item of the right amount after the first is an exception of its own.
  for x in select i.id from pg_temp.recon_pay p
            join payments.settlement_items i on i.lender_org_id = p_lender and i.provider_payment_ref = p.ref and i.gross_minor = p.amount
            join payments.settlement_batches b on b.id = i.batch_id and b.lender_org_id = i.lender_org_id and b.provider = p.provider and b.period_to <= p_date
            where not exists (select 1 from payments.reconciliation_matches m where m.run_id = v_run.id and m.kind = 'payment_settlement' and m.settlement_item_id = i.id)
  loop
    perform private.recon_raise(p_lender, 'duplicate_payment', 'warning', 'lender', jsonb_build_object('settlement_item_id', x.id::text));
    v_exc := v_exc + 1;
  end loop;
  if v_has_settlement then
    -- Never settled: the same window as the match (an item in a batch that ends after this date is not evidence for this date).
    for x in select p.id from pg_temp.recon_pay p
              where p_date - p.captured_on > v_lag
                and not exists (select 1 from payments.settlement_items i join payments.settlement_batches b on b.id = i.batch_id and b.lender_org_id = i.lender_org_id
                                 where i.lender_org_id = p_lender and i.provider_payment_ref = p.ref and b.provider = p.provider and b.period_to <= p_date)
    loop
      perform private.recon_raise(p_lender, 'provider_success_no_settlement', 'warning', 'lender', jsonb_build_object('provider_payment_id', x.id::text), 'payment_settlement', x.id);
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
    perform private.recon_raise(p_lender, 'settlement_no_intent', 'warning', 'lender', jsonb_build_object('settlement_item_id', x.id::text));
    v_exc := v_exc + 1;
  end loop;
  -- Settled, but later than the waiting time.
  for x in select m.settlement_item_id as id from payments.reconciliation_matches m
            join pg_temp.recon_pay p on p.id = m.provider_payment_id
            join payments.settlement_items i on i.id = m.settlement_item_id and i.lender_org_id = m.lender_org_id
            join payments.settlement_batches b on b.id = i.batch_id and b.lender_org_id = i.lender_org_id
            where m.run_id = v_run.id and m.kind = 'payment_settlement' and b.period_to - p.captured_on > v_lag
  loop
    perform private.recon_raise(p_lender, 'late_settlement', 'info', 'lender', jsonb_build_object('settlement_item_id', x.id::text));
    v_exc := v_exc + 1;
  end loop;
  -- Settled before it was captured (a day of slack for the two calendars): the provider's report is inconsistent, a platform matter.
  for x in select m.settlement_item_id as id from payments.reconciliation_matches m
            join pg_temp.recon_pay p on p.id = m.provider_payment_id
            join payments.settlement_items i on i.id = m.settlement_item_id and i.lender_org_id = m.lender_org_id
            join payments.settlement_batches b on b.id = i.batch_id and b.lender_org_id = i.lender_org_id
            where m.run_id = v_run.id and m.kind = 'payment_settlement' and b.period_to < p.captured_on - 1
  loop
    perform private.recon_raise(p_lender, 'event_payload_conflict', 'warning', 'platform', jsonb_build_object('settlement_item_id', x.id::text));
    v_exc := v_exc + 1;
  end loop;

  -- (b) settlement batch to bank credit: UTR, net amount, the configured settlement account, a VERIFIED destination, items and parts that add up, and
  -- a UTR that no other batch carries (one credit confirms at most one batch)
  insert into payments.reconciliation_matches (run_id, lender_org_id, kind, settlement_batch_id, bank_credit_id, amount_minor)
  select v_run.id, p_lender, 'settlement_bank', b.id, c.id, b.net_minor
    from payments.settlement_batches b
    join payments.bank_credits c on c.lender_org_id = p_lender and c.utr = b.settlement_ref and c.amount_minor = b.net_minor and c.value_date <= p_date
    join payments.lender_payment_configs cfg on cfg.id = b.config_id and cfg.lender_org_id = b.lender_org_id and cfg.settlement_account_id = c.settlement_account_id
   where b.lender_org_id = p_lender and b.period_to <= p_date
     and b.destination_ok is true and b.items_total_mismatch is false and not b.parts_mismatch
     and (select count(*) from payments.settlement_batches b2 where b2.lender_org_id = p_lender and b2.settlement_ref = b.settlement_ref and b2.period_to <= p_date) = 1;
  get diagnostics v_m_bank = row_count;
  -- Batches the platform must look at, whatever the bank says: destination not confirmed, a report that does not add up, a UTR carried twice.
  for x in select b.id from payments.settlement_batches b where b.lender_org_id = p_lender and b.period_to <= p_date and b.destination_ok is null
  loop
    perform private.recon_raise(p_lender, 'settlement_account_mismatch', 'warning', 'platform', jsonb_build_object('settlement_batch_id', x.id::text));
    v_exc := v_exc + 1;
  end loop;
  for x in select b.id from payments.settlement_batches b where b.lender_org_id = p_lender and b.period_to <= p_date and (b.items_total_mismatch is true or b.parts_mismatch)
  loop
    perform private.recon_raise(p_lender, 'event_payload_conflict', 'warning', 'platform', jsonb_build_object('settlement_batch_id', x.id::text));
    v_exc := v_exc + 1;
  end loop;
  for x in select b.id from payments.settlement_batches b where b.lender_org_id = p_lender and b.period_to <= p_date
              and (select count(*) from payments.settlement_batches b2 where b2.lender_org_id = p_lender and b2.settlement_ref = b.settlement_ref and b2.period_to <= p_date) > 1
  loop
    perform private.recon_raise(p_lender, 'event_payload_conflict', 'critical', 'platform', jsonb_build_object('settlement_batch_id', x.id::text));
    v_exc := v_exc + 1;
  end loop;
  if v_has_bank then
    -- Amount and account are judged independently: both can be wrong at once. A wrong account is the platform's (critical), a wrong amount the lender's.
    for x in select b.id, (c.amount_minor <> b.net_minor) as amount_bad, (cfg.settlement_account_id <> c.settlement_account_id or b.destination_ok is false) as account_bad
               from payments.settlement_batches b
               join payments.bank_credits c on c.lender_org_id = p_lender and c.utr = b.settlement_ref and c.value_date <= p_date
               join payments.lender_payment_configs cfg on cfg.id = b.config_id and cfg.lender_org_id = b.lender_org_id
              where b.lender_org_id = p_lender and b.period_to <= p_date
    loop
      if x.amount_bad then
        perform private.recon_raise(p_lender, 'amount_mismatch', 'warning', 'lender', jsonb_build_object('settlement_batch_id', x.id::text), 'settlement_bank', x.id);
        v_exc := v_exc + 1;
      end if;
      if x.account_bad then
        perform private.recon_raise(p_lender, 'settlement_account_mismatch', 'critical', 'platform', jsonb_build_object('settlement_batch_id', x.id::text), 'settlement_bank', x.id);
        v_exc := v_exc + 1;
      end if;
    end loop;
    for x in select b.id from payments.settlement_batches b
              where b.lender_org_id = p_lender and b.period_to <= p_date and p_date - b.period_to > v_lag
                and not exists (select 1 from payments.bank_credits c where c.lender_org_id = p_lender and c.utr = b.settlement_ref)
    loop
      perform private.recon_raise(p_lender, 'late_settlement', 'warning', 'lender', jsonb_build_object('settlement_batch_id', x.id::text), 'settlement_bank', x.id);
      v_exc := v_exc + 1;
    end loop;
  else
    v_na := v_na || 'bank_credits'::text;
  end if;

  -- (c) provider payment to the lender's own receipt, on the payment's own loan account (the receipt must carry our payment reference or the intent id,
  -- the same amount, and not be reversed); ONE receipt per payment (the earliest), each receipt explains one payment
  create temporary table if not exists pg_temp.recon_rcpt (payment_id uuid, captured_on date, receipt_id uuid, value_date date, amount bigint) on commit drop;
  delete from pg_temp.recon_rcpt;
  insert into pg_temp.recon_rcpt
  select p.id, p.captured_on, r.id, r.value_date, p.amount
    from pg_temp.recon_pay p
    join servicing.lms_receipts r on r.lender_org_id = p_lender and r.loan_account_id = p.loan_id and r.kind = 'receipt'
         and r.bank_reference in (p.ref, p.intent_id::text) and r.amount_minor = p.amount and r.value_date <= p_date
   where not exists (select 1 from servicing.lms_receipts rv where rv.reverses_receipt_id = r.id);
  insert into payments.reconciliation_matches (run_id, lender_org_id, kind, provider_payment_id, receipt_id, amount_minor)
  select v_run.id, p_lender, 'payment_receipt', q.payment_id, q.receipt_id, q.amount
    from (select distinct on (a.receipt_id) a.* from (select distinct on (payment_id) * from pg_temp.recon_rcpt order by payment_id, value_date, receipt_id) a
           order by a.receipt_id, a.captured_on, a.payment_id) q;
  get diagnostics v_m_rec = row_count;
  if v_has_receipts then
    for x in select p.id from pg_temp.recon_pay p
              where p_date - p.captured_on > ceil(v_rlag / 24.0)::integer
                and not exists (select 1 from payments.reconciliation_matches m where m.run_id = v_run.id and m.kind = 'payment_receipt' and m.provider_payment_id = p.id)
    loop
      perform private.recon_raise(p_lender, 'lender_receipt_missing', 'warning', 'lender', jsonb_build_object('provider_payment_id', x.id::text), 'payment_receipt', x.id);
      v_exc := v_exc + 1;
    end loop;
  else
    v_na := v_na || 'lms_receipts'::text;
  end if;
  -- Posted twice: every eligible receipt after the matched one is an exception of its own.
  for x in select q.receipt_id as id from pg_temp.recon_rcpt q
            where not exists (select 1 from payments.reconciliation_matches m where m.run_id = v_run.id and m.kind = 'payment_receipt' and m.receipt_id = q.receipt_id)
  loop
    perform private.recon_raise(p_lender, 'duplicate_payment', 'warning', 'lender', jsonb_build_object('receipt_id', x.id::text));
    v_exc := v_exc + 1;
  end loop;
  -- A receipt that carries our reference (or intent id) but sits on ANOTHER loan account than the payment's.
  for x in select distinct r.id from servicing.lms_receipts r join pg_temp.recon_pay p on r.bank_reference in (p.ref, p.intent_id::text)
            where r.lender_org_id = p_lender and r.kind = 'receipt' and r.value_date <= p_date and r.loan_account_id <> p.loan_id
              and not exists (select 1 from servicing.lms_receipts rv where rv.reverses_receipt_id = r.id)
  loop
    perform private.recon_raise(p_lender, 'lender_receipt_no_intent', 'warning', 'lender', jsonb_build_object('receipt_id', x.id::text));
    v_exc := v_exc + 1;
  end loop;
  -- A receipt that names one of our intents (by id) when no such intent exists for this lender.
  for x in select r.id from servicing.lms_receipts r
            where r.lender_org_id = p_lender and r.kind = 'receipt' and r.value_date <= p_date and r.bank_reference ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              and not exists (select 1 from payments.payment_intents i where i.lender_org_id = p_lender and i.id::text = r.bank_reference)
  loop
    perform private.recon_raise(p_lender, 'lender_receipt_no_intent', 'warning', 'lender', jsonb_build_object('receipt_id', x.id::text));
    v_exc := v_exc + 1;
  end loop;

  -- The standing line: money the provider reported settled somewhere other than the lender's verified account, taken from the BATCHES (what moved), and the
  -- batches whose destination is not confirmed. Zero is evidence only when a settlement report exists and no batch lacks a verified destination.
  select count(*) into v_visible from payments.settlement_batches b where b.lender_org_id = p_lender and b.period_to <= p_date;
  select count(*), coalesce(sum(b.net_minor), 0) into v_off_batches, v_off_minor
    from payments.settlement_batches b where b.lender_org_id = p_lender and b.destination_ok is false and b.period_to <= p_date;
  select count(i.id) into v_off_items
    from payments.settlement_items i join payments.settlement_batches b on b.id = i.batch_id and b.lender_org_id = i.lender_org_id
   where i.lender_org_id = p_lender and b.destination_ok is false and b.period_to <= p_date;
  select count(*), coalesce(sum(b.net_minor), 0) into v_unstated_batches, v_unstated_minor
    from payments.settlement_batches b where b.lender_org_id = p_lender and b.destination_ok is null and b.period_to <= p_date;

  update payments.reconciliation_runs set
    counts = jsonb_build_object('payments_considered', v_n_pay, 'matched_to_settlement', v_m_set, 'matched_to_bank', v_m_bank, 'matched_to_receipt', v_m_rec),
    report = jsonb_build_object(
      'run_date', p_date::text,
      'payments_considered', v_n_pay,
      'matched', jsonb_build_object('settlement', v_m_set, 'bank', v_m_bank, 'receipt', v_m_rec),
      'not_reconcilable', to_jsonb(v_na),
      'settled_to_non_lender', jsonb_build_object('items', v_off_items, 'minor', v_off_minor),
      'settlement_evidence', jsonb_build_object(
        'settlement_report_exists', v_visible > 0,
        'off_account_batches', v_off_batches,
        'destination_unstated_batches', v_unstated_batches,
        'destination_unstated_minor', v_unstated_minor,
        'zero_is_evidence', v_visible > 0 and v_off_batches = 0 and v_unstated_batches = 0),
      'settings', jsonb_build_object('settlement_lag_days', v_lag, 'receipt_lag_hours', v_rlag, 'above_platform_default', v_lag > 3 or v_rlag > 72))
   where id = v_run.id;
  drop table if exists pg_temp.recon_pay;
  drop table if exists pg_temp.recon_rcpt;
  perform private.write_payments_audit(p_lender, 'payments.reconciliation.run', 'reconciliation_run', v_run.id::text, jsonb_build_object('run_date', p_date::text, 'run_no', v_no));
  return jsonb_build_object('run_id', v_run.id, 'run_no', v_no, 'unchanged', false);
end
$$;
comment on function payments.run_reconciliation(uuid, date) is
  'System only (a daily worker, after the provider cut-off). Reconciles a lender up to a date: exact matches of provider payments to settlement items, settlement batches to bank credits (UTR, net amount, the configured settlement account, a destination confirmed by its last four digits, items and parts that add up, a UTR no other batch carries) and provider payments to the lender''s own receipts ON THE PAYMENT''S LOAN ACCOUNT; one match per payment, item, credit, batch and receipt. Exceptions for what differs, repeats or stays missing beyond the waiting times (amount_mismatch, duplicate_payment for a payment settled or posted twice, provider_success_no_settlement, settlement_no_intent, late_settlement, settlement_account_mismatch (platform-owned, amount and account judged independently), lender_receipt_missing, lender_receipt_no_intent (also a receipt on another loan), event_payload_conflict for a provider report that does not add up or a UTR carried twice), each raised once per subject and raised again if the condition recurred after a person resolved it. An input source that does not exist is listed as not reconcilable, never as reconciled. Idempotent: a run on unchanged inputs returns the same run; changed inputs make a new run number. It never changes a payment, an intent, a receipt or any other money row. The report carries the standing line settled_to_non_lender (items in, and net minor of, batches whose destination is not the lender''s account) and settlement_evidence: zero is evidence only when zero_is_evidence is true (a settlement report exists and no batch lacks a verified destination).';

-- ---------------------------------------------------------------------------------------------
-- 7. The derived stage of each payment (runs with the caller's rights)
-- ---------------------------------------------------------------------------------------------
-- Whether the lender's own LMS posted (and did not reverse) a receipt for the payment, on the payment's loan account. A payment.read holder may lack loan.read,
-- so this one fact is read through a definer function that answers only for payments the caller can already read (the stage is what payment.read shows).
create or replace function private.payment_lender_posted(p_payment uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from payments.provider_payments pp
      join servicing.lms_receipts r on r.loan_account_id = pp.loan_account_id and r.lender_org_id = pp.lender_org_id
     where pp.id = p_payment
       and pp.lender_org_id in (select private.orgs_with_permission('payment.read'))
       and r.kind = 'receipt' and r.bank_reference in (pp.provider_payment_ref, pp.intent_id::text) and r.amount_minor = pp.amount_minor
       and not exists (select 1 from servicing.lms_receipts rv where rv.reverses_receipt_id = r.id))
$$;
revoke all on function private.payment_lender_posted(uuid) from public;
grant execute on function private.payment_lender_posted(uuid) to authenticated;
comment on function private.payment_lender_posted(uuid) is
  'True when the lender''s LMS posted, and did not reverse, a receipt carrying the payment''s reference or intent id for the same amount on the payment''s own loan account. Answers false for any payment the caller may not read (payment.read), so it is no existence oracle across lenders. Used only by payments.payment_stages.';

create or replace view payments.payment_stages with (security_invoker = true, security_barrier = true) as
select pp.id as provider_payment_id, pp.lender_org_id, pp.intent_id, pp.loan_account_id, pp.amount_minor, pp.captured_at,
       true as provider_captured,
       si.id is not null as provider_settled,
       (bc.id is not null) as bank_confirmed,
       private.payment_lender_posted(pp.id) as lender_posted,
       case when private.payment_lender_posted(pp.id) then 'lender_posted' when bc.id is not null then 'bank_confirmed' when si.id is not null then 'provider_settled' else 'provider_captured' end as stage,
       sb.destination_ok as settlement_destination_ok,
       case when bc.id is not null then 'lender_reported_credit' end as bank_confirmation_basis
from payments.provider_payments pp
left join lateral (
  select i.* from payments.settlement_items i join payments.settlement_batches b on b.id = i.batch_id and b.lender_org_id = i.lender_org_id
   where i.lender_org_id = pp.lender_org_id and i.provider_payment_ref = pp.provider_payment_ref and b.provider = pp.provider and i.gross_minor = pp.amount_minor
     and b.period_to <= private.today_ist()
   order by b.period_to, i.id limit 1) si on true
left join payments.settlement_batches sb on sb.id = si.batch_id and sb.lender_org_id = si.lender_org_id
left join lateral (
  select c.* from payments.bank_credits c join payments.lender_payment_configs cfg on cfg.id = pp.config_id and cfg.lender_org_id = pp.lender_org_id
   where c.lender_org_id = pp.lender_org_id and c.utr = sb.settlement_ref and c.amount_minor = sb.net_minor and c.settlement_account_id = cfg.settlement_account_id
     and sb.destination_ok is true and sb.items_total_mismatch is false and not sb.parts_mismatch
     and (select count(*) from payments.settlement_batches b2 where b2.lender_org_id = sb.lender_org_id and b2.settlement_ref = sb.settlement_ref) = 1
   order by c.value_date limit 1) bc on true
where pp.status = any (private.payment_success_statuses()) and not pp.duplicate_capture
  and pp.lender_org_id in (select private.orgs_with_permission('payment.read'));
comment on view payments.payment_stages is
  'The settlement stage of each successful provider payment, DERIVED from the tables (provider_captured: a verified event; provider_settled: a settlement item with the same reference and amount in a batch that does not end in the future; bank_confirmed: a bank credit, reported by the LENDER, with the batch''s UTR and net amount in the configured settlement account, only if the reported destination is verified (last four digits), the batch''s items and parts add up and no other batch carries the UTR; lender_posted: the lender''s own receipt on the payment''s loan account carrying the reference or intent id, same amount, not reversed). A destination that was not stated stays null and never confirms. Nothing sets a stage and no function accepts one. Runs with the CALLER''s rights (security_invoker, security_barrier): row level security of every table it reads applies, and a caller''s predicate cannot run before the tenant filter. Lenders with payment.read see their own lender''s rows only.';

-- ---------------------------------------------------------------------------------------------
-- 8. Grants (re-stated; signatures are unchanged so the earlier grants stand)
-- ---------------------------------------------------------------------------------------------
revoke all on payments.payment_stages from public, anon, authenticated, service_role;
grant select on payments.payment_stages to authenticated;

revoke all on function payments.set_reconciliation_settings(uuid, integer, integer) from public;
revoke all on function payments.record_settlement_report(uuid, date, jsonb) from public;
revoke all on function payments.import_bank_credits(uuid, uuid, jsonb) from public;
revoke all on function payments.run_reconciliation(uuid, date) from public;
grant execute on function payments.set_reconciliation_settings(uuid, integer, integer) to authenticated;
grant execute on function payments.record_settlement_report(uuid, date, jsonb) to service_role;
grant execute on function payments.import_bank_credits(uuid, uuid, jsonb) to authenticated;
grant execute on function payments.run_reconciliation(uuid, date) to service_role;
