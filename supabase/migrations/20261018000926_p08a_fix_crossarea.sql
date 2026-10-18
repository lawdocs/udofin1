-- =============================================================================================
-- Phase 08a review-fix wave, final pass across the six areas (key SX). Forward-only; redefines only functions that earlier fix migrations
-- (920 to 925) left defective at a seam between two areas. Every function starts from its current definition in the migrated database;
-- signatures and grants are unchanged (create or replace keeps both).
--
--   1. M9, the consumers of servicing.lms_receipts. A receipt is REVERSED only when its reversals add up to its amount. Until now every
--      reader treated the existence of any reversal row as a full reversal, so a reversal of 0.01 on a 4,500.00 receipt made the payment
--      look unposted, raised a false lender_receipt_missing and lifted the quiet period of the reminders. Changed: payments.my_payment,
--      private.payment_lender_posted (the lender-posted stage of the view payments.payment_stages, which stays as migration 922 made it:
--      security_invoker and security_barrier), private.reminder_recent_payment, payments.run_reconciliation and servicing.my_loan_activity.
--      The test is written inline (sum of the reversals of the SAME lender against the receipt's amount), so these functions do not depend on
--      the helper functions of migration 925, which stay as they are.
--   2. Leftovers of the payments and mandates areas: an amountMinor above the table limit is an invalid receipt, not a check violation that
--      fails the callback (payments.ingest_provider_delivery); a mandate whose configuration is not active and which nobody has refreshed for
--      a day is raised to the platform (payments.sweep_mandates), so a revoke lost while the configuration was suspended is not silent.
--   3. private.feature_evidence_ok uses the same personal-data screen as every other free-text column of the accounts area
--      (private.acct_text_unsafe), so digit groups split by spaces or hyphens no longer pass.
--   4. The evidence position of the draft rule servicing.reminder_window.default is stated as the primary extract on file supports it.
-- Nothing here claims regulatory compliance.
-- =============================================================================================


-- ---------------------------------------------------------------------------------------------
-- 1. M9: a receipt is reversed only when its reversals reach its amount
-- ---------------------------------------------------------------------------------------------


CREATE OR REPLACE FUNCTION payments.my_payment(p_intent uuid)
 RETURNS TABLE(intent_id uuid, intent_status text, stage text, provider_received_at timestamp with time zone, lender_posted_on date)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  i payments.payment_intents;
  v_pp payments.provider_payments;
  v_posted date;
  v_attention boolean;
begin
  if private.my_borrower_id() is null then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  select * into i from payments.payment_intents x where x.id = p_intent and x.borrower_id = private.my_borrower_id();
  if not found then
    raise exception 'payment not found' using errcode = 'P0002';
  end if;
  select * into v_pp from payments.provider_payments pp
   where pp.intent_id = i.id and pp.lender_org_id = i.lender_org_id and pp.status = any (private.payment_success_statuses()) and not pp.duplicate_capture
   order by pp.created_at limit 1;
  if found then
    -- A receipt the lender itself disputes (an unresolved conflict about it) is not a posting: the stage fails closed.
    select r.value_date into v_posted from servicing.lms_receipts r
     where r.loan_account_id = i.loan_account_id and r.lender_org_id = i.lender_org_id and r.kind = 'receipt'
       and r.bank_reference in (v_pp.provider_payment_ref, i.id::text) and r.amount_minor = v_pp.amount_minor
       and coalesce((select sum(rv.amount_minor) from servicing.lms_receipts rv where rv.reverses_receipt_id = r.id and rv.lender_org_id = r.lender_org_id), 0) < r.amount_minor
       and not exists (select 1 from servicing.sync_conflicts c
                        where c.loan_account_id = r.loan_account_id and c.lender_org_id = r.lender_org_id and c.record_type = 'receipt'
                          and c.existing_ref_id = r.id and c.status <> 'resolved')
     order by r.value_date limit 1;
  end if;
  -- An open exception about the intent (but not the platform-side note about an order made for an intent the borrower cancelled: a
  -- payment_status_conflict that names the configuration as well), an amount that differs, money on an intent that is no longer open, or a refund or chargeback of the payment.
  v_attention := exists (select 1 from payments.reconciliation_exceptions e
                          where e.lender_org_id = i.lender_org_id and e.status <> 'resolved' and e.subject ->> 'intent_id' = i.id::text
                            and not (e.class = 'payment_status_conflict' and e.subject ? 'config_id'))
                 or (v_pp.id is not null and v_pp.amount_minor is distinct from i.amount_minor)
                 or (i.status in ('failed', 'expired', 'cancelled')
                     and exists (select 1 from payments.provider_payments pp
                                  where pp.intent_id = i.id and pp.lender_org_id = i.lender_org_id and pp.status = any (private.payment_success_statuses())))
                 or (v_pp.id is not null and exists (select 1 from payments.payment_adjustments a
                                                      where a.provider_payment_id = v_pp.id and a.lender_org_id = v_pp.lender_org_id and a.kind in ('refund', 'chargeback', 'reversal')));
  return query select i.id, i.status::text,
    case when v_attention then 'needs_attention'
         when v_posted is not null then 'lender_posted'
         when v_pp.id is not null then 'provider_received'
         else 'started' end,
    v_pp.captured_at, v_posted;
end
$function$;

CREATE OR REPLACE FUNCTION private.payment_lender_posted(p_payment uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (
    select 1 from payments.provider_payments pp
      join servicing.lms_receipts r on r.loan_account_id = pp.loan_account_id and r.lender_org_id = pp.lender_org_id
     where pp.id = p_payment
       and pp.lender_org_id in (select private.orgs_with_permission('payment.read'))
       and r.kind = 'receipt' and r.bank_reference in (pp.provider_payment_ref, pp.intent_id::text) and r.amount_minor = pp.amount_minor
       and coalesce((select sum(rv.amount_minor) from servicing.lms_receipts rv where rv.reverses_receipt_id = r.id and rv.lender_org_id = r.lender_org_id), 0) < r.amount_minor)
$function$;

CREATE OR REPLACE FUNCTION private.reminder_recent_payment(p_loan uuid, p_hours integer)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (select 1 from payments.provider_payments pp
                  where pp.loan_account_id = p_loan and pp.status = any (private.payment_success_statuses()) and not pp.duplicate_capture
                    and coalesce(pp.captured_at, pp.created_at) >= now() - make_interval(hours => p_hours))
      -- A lender receipt counts when it was posted recently (value date, never in the future) OR when Udofin received it recently: a lender can
      -- report today a payment made days ago while its balance report still shows the installment due.
      or exists (select 1 from servicing.lms_receipts r
                  where r.loan_account_id = p_loan and r.kind = 'receipt'
                    and (r.received_at >= now() - make_interval(hours => p_hours)
                         or r.value_date between (now() at time zone 'Asia/Kolkata')::date - ceil(p_hours / 24.0)::integer and (now() at time zone 'Asia/Kolkata')::date)
                    and coalesce((select sum(rv.amount_minor) from servicing.lms_receipts rv where rv.reverses_receipt_id = r.id and rv.lender_org_id = r.lender_org_id), 0) < r.amount_minor)
      -- A settled UPI AutoPay or eNACH debit writes neither a provider payment nor a lender receipt.
      or exists (select 1 from payments.mandate_debits d
                  where d.loan_account_id = p_loan and d.status = 'settled' and d.updated_at >= now() - make_interval(hours => p_hours))
$function$;

CREATE OR REPLACE FUNCTION payments.run_reconciliation(p_lender uuid, p_date date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  v_off_net bigint;
  v_unstated_batches integer;
  v_unstated_minor bigint;
  v_unstated_net bigint;
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
     and b.destination_ok is true and private.settlement_batch_tied(b) is true and not b.parts_mismatch
     and (select count(*) from payments.settlement_batches b2 where b2.lender_org_id = p_lender and b2.settlement_ref = b.settlement_ref and b2.period_to <= p_date) = 1;
  get diagnostics v_m_bank = row_count;
  -- Batches the platform must look at, whatever the bank says: destination not confirmed, a report that does not add up, a UTR carried twice.
  for x in select b.id from payments.settlement_batches b where b.lender_org_id = p_lender and b.period_to <= p_date and b.destination_ok is null
  loop
    perform private.recon_raise(p_lender, 'settlement_account_mismatch', 'warning', 'platform', jsonb_build_object('settlement_batch_id', x.id::text));
    v_exc := v_exc + 1;
  end loop;
  for x in select b.id from payments.settlement_batches b where b.lender_org_id = p_lender and b.period_to <= p_date and (private.settlement_batch_tied(b) is not true or b.parts_mismatch)
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
   where coalesce((select sum(rv.amount_minor) from servicing.lms_receipts rv where rv.reverses_receipt_id = r.id and rv.lender_org_id = r.lender_org_id), 0) < r.amount_minor;
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
              and coalesce((select sum(rv.amount_minor) from servicing.lms_receipts rv where rv.reverses_receipt_id = r.id and rv.lender_org_id = r.lender_org_id), 0) < r.amount_minor
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

  -- The standing line: money the provider reported settled somewhere other than the lender's verified account, taken from the BATCHES (their gross, as the item
  -- view alone could miss a batch that lists few or no items; the net that was paid out is reported next to it), and the batches whose destination is not
  -- confirmed. Zero is evidence only when a settlement report exists and no batch lacks a verified destination.
  select count(*) into v_visible from payments.settlement_batches b where b.lender_org_id = p_lender and b.period_to <= p_date;
  select count(*), coalesce(sum(b.gross_minor), 0), coalesce(sum(b.net_minor), 0) into v_off_batches, v_off_minor, v_off_net
    from payments.settlement_batches b where b.lender_org_id = p_lender and b.destination_ok is false and b.period_to <= p_date;
  select count(i.id) into v_off_items
    from payments.settlement_items i join payments.settlement_batches b on b.id = i.batch_id and b.lender_org_id = i.lender_org_id
   where i.lender_org_id = p_lender and b.destination_ok is false and b.period_to <= p_date;
  select count(*), coalesce(sum(b.gross_minor), 0), coalesce(sum(b.net_minor), 0) into v_unstated_batches, v_unstated_minor, v_unstated_net
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
        'off_account_net_minor', v_off_net,
        'destination_unstated_batches', v_unstated_batches,
        'destination_unstated_minor', v_unstated_minor,
        'destination_unstated_net_minor', v_unstated_net,
        'zero_is_evidence', v_visible > 0 and v_off_batches = 0 and v_unstated_batches = 0),
      'settings', jsonb_build_object('settlement_lag_days', v_lag, 'receipt_lag_hours', v_rlag, 'above_platform_default', v_lag > 3 or v_rlag > 72))
   where id = v_run.id;
  drop table if exists pg_temp.recon_pay;
  drop table if exists pg_temp.recon_rcpt;
  perform private.write_payments_audit(p_lender, 'payments.reconciliation.run', 'reconciliation_run', v_run.id::text, jsonb_build_object('run_date', p_date::text, 'run_no', v_no));
  return jsonb_build_object('run_id', v_run.id, 'run_no', v_no, 'unchanged', false);
end
$function$;

CREATE OR REPLACE FUNCTION servicing.my_loan_activity(p_loan uuid, p_before_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_before_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 30)
 RETURNS TABLE(entry_kind text, entry_id uuid, sort_at timestamp with time zone, occurred_on date, amount_minor bigint, state text, purpose text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  l servicing.loan_accounts;
  v_sync boolean;
  v_pay boolean;
begin
  l := private.servicing_docs_borrower_loan(p_loan);
  if p_limit is null or p_limit not between 1 and 100 or (p_before_at is null) <> (p_before_id is null) then
    raise exception 'invalid page' using errcode = '22023', hint = 'bad_request';
  end if;
  v_sync := private.feature_enabled(l.lender_org_id, 'servicing_sync');
  v_pay := private.feature_enabled(l.lender_org_id, 'payments');
  if not (v_sync or v_pay) then
    raise exception 'loan not found' using errcode = 'P0002';
  end if;
  return query
  with keys as (
    -- A receipt the lender itself contradicts (an unresolved conflict about it) is withheld, like a disputed schedule or loan report.
    select 'receipt'::text as src, r.id as kid, r.received_at as ts
      from servicing.lms_receipts r
     where v_sync and r.loan_account_id = l.id and r.lender_org_id = l.lender_org_id and (r.source_system <> 'mock_lms' or private.mock_providers_allowed())
       and not exists (select 1 from servicing.sync_conflicts c
                        where c.loan_account_id = r.loan_account_id and c.lender_org_id = r.lender_org_id and c.record_type = 'receipt'
                          and c.existing_ref_id = r.id and c.status <> 'resolved')
    union all
    select 'intent', i.id, i.created_at
      from payments.payment_intents i
     where v_pay and i.loan_account_id = l.id and i.lender_org_id = l.lender_org_id and i.borrower_id = l.borrower_id
    union all
    select 'adjustment', a.id, coalesce(a.occurred_at, a.created_at)
      from payments.payment_adjustments a
      join payments.provider_payments pp on pp.id = a.provider_payment_id and pp.lender_org_id = a.lender_org_id
      join payments.payment_intents i on i.id = pp.intent_id and i.lender_org_id = pp.lender_org_id
     where v_pay and i.loan_account_id = l.id and i.lender_org_id = l.lender_org_id and i.borrower_id = l.borrower_id
  ), paged as (
    select k.* from keys k
     where p_before_at is null or (k.ts, k.kid) < (p_before_at, p_before_id)
     order by k.ts desc, k.kid desc
     limit p_limit
  )
  select case g.src when 'receipt' then case when r.kind = 'receipt' then 'lender_receipt' else 'lender_reversal' end
                    when 'intent' then 'payment_attempt' else 'payment_adjustment' end,
         g.kid, g.ts,
         case g.src when 'receipt' then r.value_date else (g.ts at time zone 'Asia/Kolkata')::date end,
         case g.src when 'receipt' then r.amount_minor when 'intent' then i.amount_minor else a.amount_minor end,
         case g.src
           when 'receipt' then case when r.kind = 'reversal' then 'recorded'
                                    when coalesce((select sum(rv.amount_minor) from servicing.lms_receipts rv where rv.reverses_receipt_id = r.id and rv.lender_org_id = r.lender_org_id), 0) >= r.amount_minor then 'reversed'
                                    else 'posted' end
           -- A payment that was cancelled, failed or expired without the provider ever reporting money is not "started": say what it is.
           when 'intent' then (select case when p.stage = 'started' and i.status in ('cancelled', 'failed', 'expired') then i.status::text else p.stage end
                                 from payments.my_payment(i.id) p)
           else a.kind end,
         case g.src when 'intent' then i.purpose::text end
  from paged g
  left join servicing.lms_receipts r on g.src = 'receipt' and r.id = g.kid
  left join payments.payment_intents i on g.src = 'intent' and i.id = g.kid
  left join payments.payment_adjustments a on g.src = 'adjustment' and a.id = g.kid
  order by g.ts desc, g.kid desc;
end
$function$;


comment on function payments.my_payment(uuid) is
  'The honest stage of the signed-in borrower''s own payment: started, provider_received (a verified provider event reports the payment), lender_posted (the lender''s own receipt carries the provider payment reference or the intent id, for the same amount, has not been reversed IN FULL and is not disputed by an unresolved conflict) or needs_attention (an open exception, an amount that differs, money received on an intent that is no longer open, or a refund or chargeback of the payment). A partial reversal of the lender''s receipt leaves it posted. Derived only from verified events and lender receipts; a redirect, a client flag or a screen can never move it.';
comment on function private.payment_lender_posted(uuid) is
  'True when the lender''s LMS posted, and did not reverse in full, a receipt carrying the payment''s reference or intent id for the same amount on the payment''s own loan account (reversals of the same lender are added up; a partial reversal leaves the receipt posted). Answers false for any payment the caller may not read (payment.read), so it is no existence oracle across lenders. Used only by payments.payment_stages.';
comment on function private.reminder_recent_payment(uuid, integer) is
  'True when a payment for the loan was verified or posted in the last p_hours hours (do not remind someone who has just paid): a verified provider payment (captured, paid or succeeded, not a duplicate capture); a lender receipt that was not reversed in full (a partial reversal leaves it counting), by its value date (in the last p_hours rounded up to days, never later than today) or by when Udofin received it; a settled mandate debit (by its last update). Migration 20261018000923 added the received-at test, the future bound and the mandate debits.';
comment on function servicing.my_loan_activity(uuid, timestamptz, uuid, integer) is
  'Borrower only. Newest first, keyset-paged on (sort_at, entry_id), at most 100 per page. lender_receipt / lender_reversal: what the lender''s LMS posted (posted, reversed, recorded), when the switch servicing_sync is on; a receipt is reversed only when its reversals add up to its amount (a partial reversal leaves it posted, and the reversal is listed as its own recorded entry); a receipt the lender contradicts (an unresolved conflict about it) is withheld until the conflict is resolved. payment_attempt: the borrower''s own payments with the honest stage from payments.my_payment (started, provider_received, lender_posted, needs_attention), or cancelled, failed or expired when the provider never reported money for them. payment_adjustment: a refund, chargeback, reversal or correction the provider verifiably reported. Amounts are integer paise as reported. No bank reference, payment mode or provider reference is returned.';
comment on function payments.run_reconciliation(uuid, date) is
  'System only (a daily worker, after the provider cut-off). Reconciles a lender up to a date: exact matches of provider payments to settlement items, settlement batches to bank credits (UTR, net amount, the configured settlement account, a destination confirmed by its last four digits, items and parts that add up, a UTR no other batch carries) and provider payments to the lender''s own receipts ON THE PAYMENT''S LOAN ACCOUNT (a receipt reversed only in part still matches: it is reversed when its reversals add up to its amount); one match per payment, item, credit, batch and receipt. Exceptions for what differs, repeats or stays missing beyond the waiting times (amount_mismatch, duplicate_payment for a payment settled or posted twice, provider_success_no_settlement, settlement_no_intent, late_settlement, settlement_account_mismatch (platform-owned, amount and account judged independently), lender_receipt_missing, lender_receipt_no_intent (also a receipt on another loan), event_payload_conflict for a provider report that does not add up or a UTR carried twice), each raised once per subject and raised again if the condition recurred after a person resolved it. An input source that does not exist is listed as not reconcilable, never as reconciled. Idempotent: a run on unchanged inputs returns the same run; changed inputs make a new run number. It never changes a payment, an intent, a receipt or any other money row. The report carries the standing line settled_to_non_lender (items in, and gross minor of, the BATCHES whose destination is not the lender''s account, so a batch that lists few or no items still counts) and settlement_evidence (batches and net amount off-account, batches and amounts whose destination is not stated): zero is evidence only when zero_is_evidence is true (a settlement report exists and no batch lacks a verified destination).';


-- ---------------------------------------------------------------------------------------------
-- 2. Leftovers: an amount above the table limit; a mandate that cannot be refreshed
-- ---------------------------------------------------------------------------------------------


CREATE OR REPLACE FUNCTION payments.ingest_provider_delivery(p_token_hash text, p_delivery jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_rejected constant jsonb := jsonb_build_object('accepted', false, 'outcome', 'rejected');
  v_accepted constant jsonb := jsonb_build_object('accepted', true, 'outcome', 'ok');
  v_cfg payments.lender_payment_configs;
  v_mer payments.merchant_registry;
  v_intent payments.payment_intents;
  v_ev jsonb;
  v_provider text;
  v_delivery_id text;
  v_sha text;
  v_scheme text;
  v_sigp boolean;
  v_skew integer;
  v_bytes integer;
  v_ip text;
  v_outcome text;
  v_reason text;
  v_kind text;
  v_status text;
  v_event_id text;
  v_object_ref text;
  v_order_ref text;
  v_parent_ref text;
  v_rank integer;
  v_amount bigint;
  v_currency text;
  v_occurred timestamptz;
  v_ignored boolean;
  v_row_id uuid;
  v_existing payments.provider_events;
  v_stages jsonb;
  v_actionable_money boolean;
begin
  if private.invoking_role() <> 'service_role' then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  if p_delivery is null or jsonb_typeof(p_delivery) <> 'object' then
    raise exception 'invalid delivery' using errcode = '22023', hint = 'bad_request';
  end if;
  v_provider := p_delivery ->> 'provider';
  v_delivery_id := p_delivery ->> 'delivery_id';
  v_sha := p_delivery ->> 'payload_sha256';
  v_scheme := p_delivery ->> 'scheme';
  v_sigp := coalesce((p_delivery ->> 'signature_present') = 'true', false);
  v_skew := case when (p_delivery ->> 'timestamp_skew_seconds') ~ '^-?[0-9]{1,9}$' then (p_delivery ->> 'timestamp_skew_seconds')::integer end;
  v_bytes := case when (p_delivery ->> 'body_bytes') ~ '^[0-9]{1,9}$' then (p_delivery ->> 'body_bytes')::integer end;
  v_ip := p_delivery ->> 'ip_hmac';
  v_outcome := coalesce(p_delivery ->> 'outcome', '');
  v_reason := coalesce(p_delivery ->> 'reason_class', 'none');

  -- (a) Route by the hash of the endpoint token to an ACTIVE configuration. Unknown, suspended and retired look the same, and so does a bad signature.
  if p_token_hash ~ '^[0-9a-f]{64}$' then
    select * into v_cfg from payments.lender_payment_configs c where c.endpoint_token_hash = p_token_hash and c.status = 'active';
  end if;
  if v_cfg.id is null then
    perform private.write_webhook_receipt(v_provider, null, null, v_delivery_id, v_sha, 'unmatched', 'token_unknown_or_inactive', v_scheme, v_sigp, v_skew, v_bytes, v_ip, null);
    return v_rejected;
  end if;
  if v_provider is distinct from v_cfg.provider then
    perform private.write_webhook_receipt(v_cfg.provider, v_cfg.lender_org_id, v_cfg.id, v_delivery_id, v_sha, 'unmatched', 'provider_mismatch', v_scheme, v_sigp, v_skew, v_bytes, v_ip, null);
    return v_rejected;
  end if;

  -- (c) Anything but a verified delivery leaves a receipt and nothing else: the replay store and provider_events are never touched, so a
  -- forged delivery cannot reserve a genuine event id or delivery id.
  if v_outcome <> 'verified' then
    v_reason := case when v_reason in ('missing_headers', 'malformed_headers', 'no_secret', 'signature_mismatch', 'timestamp_outside_tolerance',
      'provider_scheme_not_configured', 'body_too_large', 'malformed_body', 'unsupported_event', 'invalid_amount', 'unsupported_currency', 'invalid_timestamp',
      'invalid_identifier') then v_reason else 'verifier_outcome_unknown' end;
    perform private.write_webhook_receipt(v_cfg.provider, v_cfg.lender_org_id, v_cfg.id, v_delivery_id, v_sha,
      case when v_outcome = 'unverified' then 'unverified'
           when v_outcome = 'stale_timestamp' then 'stale_timestamp'
           when v_outcome = 'invalid' and v_reason = 'provider_scheme_not_configured' then 'scheme_not_configured'
           else 'invalid' end,
      v_reason, v_scheme, v_sigp, v_skew, v_bytes, v_ip, null);
    return v_rejected;
  end if;

  -- (b) Verified by the verifier: read the normalised event. Anything malformed is an invalid receipt.
  v_ev := p_delivery -> 'event';
  begin
    if v_ev is null or jsonb_typeof(v_ev) <> 'object' then
      raise exception 'malformed' using errcode = '22023';
    end if;
    v_event_id := v_ev ->> 'eventId';
    v_kind := v_ev ->> 'objectKind';
    v_status := v_ev ->> 'status';
    v_object_ref := v_ev ->> 'objectRef';
    v_order_ref := v_ev ->> 'orderRef';
    v_parent_ref := v_ev ->> 'parentPaymentRef';
    v_rank := (v_ev ->> 'rank')::integer;
    v_amount := case when (v_ev ->> 'amountMinor') is null then null
                     when (v_ev ->> 'amountMinor') ~ '^[0-9]{1,15}$' then
                       -- At most the table's own limit (provider_events_amount_range): a larger number is malformed, never a check violation.
                       case when (v_ev ->> 'amountMinor')::bigint <= 100000000000000 then (v_ev ->> 'amountMinor')::bigint else (-1)::bigint end
                     else (-1)::bigint end;
    v_currency := v_ev ->> 'currency';
    v_occurred := (v_ev ->> 'occurredAt')::timestamptz;
    if v_ev ->> 'provider' is distinct from v_cfg.provider
       or v_event_id is null or v_event_id !~ '^[A-Za-z0-9._:=+/-]{4,200}$'
       or v_delivery_id is null or v_delivery_id is distinct from (v_ev ->> 'deliveryId') or v_delivery_id !~ '^[A-Za-z0-9._:=+/-]{4,200}$'
       or v_kind is null or v_kind not in ('payment', 'refund', 'chargeback', 'mandate', 'debit', 'settlement', 'unsupported')
       or v_object_ref is null or v_object_ref !~ '^[A-Za-z0-9._:=+/-]{1,200}$'
       or (v_order_ref is not null and v_order_ref !~ '^[A-Za-z0-9._:=+/-]{1,200}$')
       or (v_parent_ref is not null and v_parent_ref !~ '^[A-Za-z0-9._:=+/-]{1,200}$')
       or v_status is null or v_status not in ('created', 'pending', 'authorized', 'captured', 'paid', 'succeeded', 'failed', 'refunded', 'disputed', 'cancelled',
                                               'expired', 'active', 'rejected', 'returned', 'revoked', 'paused', 'unmapped')
       or v_rank is null or v_rank not between 0 and 100
       or v_amount = -1 or (v_currency is not null and v_currency <> 'INR') or (v_amount is not null and v_currency is null)
       or v_sha is null or v_sha !~ '^[0-9a-f]{64}$' then
      raise exception 'malformed' using errcode = '22023';
    end if;
  exception when others then
    perform private.write_webhook_receipt(v_cfg.provider, v_cfg.lender_org_id, v_cfg.id, v_delivery_id, v_sha, 'invalid', 'malformed_event', v_scheme, v_sigp, v_skew, v_bytes, v_ip, null);
    return jsonb_build_object('accepted', false, 'outcome', 'invalid');
  end;

  -- The merchant the provider names must be the configuration's own. A mismatch stops this lender's payments and tells the platform.
  if v_ev ->> 'merchantRef' is not null then
    select * into v_mer from payments.merchant_registry m where m.id = v_cfg.merchant_registry_id;
    if v_mer.merchant_ref is distinct from (v_ev ->> 'merchantRef') then
      perform private.write_webhook_receipt(v_cfg.provider, v_cfg.lender_org_id, v_cfg.id, v_delivery_id, v_sha, 'unmatched', 'merchant_mismatch', v_scheme, v_sigp, v_skew, v_bytes, v_ip, null);
      perform private.raise_exception_impl(v_cfg.lender_org_id, 'merchant_mismatch', 'critical', 'platform', jsonb_build_object('config_id', v_cfg.id::text));
      perform payments.system_suspend_payment_config(v_cfg.id, 'merchant_mismatch');
      return jsonb_build_object('accepted', false, 'outcome', 'unmatched');
    end if;
  end if;

  -- (e) An authentic event of a kind or status the platform does not handle is stored verified-and-ignored: no correlation, no processing. A
  -- mandate-only status (active, revoked, paused) on a payment, refund or chargeback is such a status: it can never be stored or applied.
  v_ignored := v_kind = 'unsupported' or v_status = 'unmapped'
               or (v_kind in ('payment', 'refund', 'chargeback') and v_status in ('active', 'revoked', 'paused'));
  v_stages := jsonb_build_object('authentication', 'matched', 'integrity', 'matched', 'correlation', 'not_applicable', 'business', 'not_applicable');

  if not v_ignored then
    -- (f) Correlation: money events about a payment must match an intent of THIS lender, provider and configuration by order reference.
    if v_kind in ('payment', 'refund', 'chargeback') then
      if v_order_ref is null then
        perform private.write_webhook_receipt(v_cfg.provider, v_cfg.lender_org_id, v_cfg.id, v_delivery_id, v_sha, 'unmatched', 'order_ref_missing', v_scheme, v_sigp, v_skew, v_bytes, v_ip, null);
        return jsonb_build_object('accepted', false, 'outcome', 'unmatched');
      end if;
      select * into v_intent from payments.payment_intents i
       where i.lender_org_id = v_cfg.lender_org_id and i.config_id = v_cfg.id and i.provider = v_cfg.provider and i.provider_order_ref = v_order_ref;
      if not found then
        perform private.write_webhook_receipt(v_cfg.provider, v_cfg.lender_org_id, v_cfg.id, v_delivery_id, v_sha, 'unmatched', 'order_ref_unknown', v_scheme, v_sigp, v_skew, v_bytes, v_ip, null);
        return jsonb_build_object('accepted', false, 'outcome', 'unmatched');
      end if;
      v_stages := jsonb_set(v_stages, '{correlation}', '"matched"');
    elsif v_kind in ('mandate', 'debit') then
      if private.correlate_mandate_event(v_cfg.id, v_kind, v_object_ref, v_order_ref) is null then
        perform private.write_webhook_receipt(v_cfg.provider, v_cfg.lender_org_id, v_cfg.id, v_delivery_id, v_sha, 'unmatched', 'mandate_unknown', v_scheme, v_sigp, v_skew, v_bytes, v_ip, null);
        return jsonb_build_object('accepted', false, 'outcome', 'unmatched');
      end if;
      v_stages := jsonb_set(v_stages, '{correlation}', '"matched"');
    end if;
    -- Business validation: a money event states an amount in rupees-as-paise and INR; a status that moves money needs one.
    v_actionable_money := v_status in ('captured', 'paid', 'succeeded', 'refunded', 'disputed', 'returned');
    if v_actionable_money and (v_amount is null or (v_kind in ('refund', 'chargeback') and v_amount = 0)) then
      perform private.write_webhook_receipt(v_cfg.provider, v_cfg.lender_org_id, v_cfg.id, v_delivery_id, v_sha, 'invalid', 'amount_missing', v_scheme, v_sigp, v_skew, v_bytes, v_ip, null);
      return jsonb_build_object('accepted', false, 'outcome', 'invalid');
    end if;
    if v_amount is not null and v_currency is distinct from 'INR' then
      perform private.write_webhook_receipt(v_cfg.provider, v_cfg.lender_org_id, v_cfg.id, v_delivery_id, v_sha, 'invalid', 'currency_invalid', v_scheme, v_sigp, v_skew, v_bytes, v_ip, null);
      return jsonb_build_object('accepted', false, 'outcome', 'invalid');
    end if;
    v_stages := jsonb_set(v_stages, '{business}', '"passed"');
  end if;

  -- (d) Replay protection, in the database, AFTER verification, correlation and business validation: a forged or unmatched delivery never gets
  -- here. One namespace per payment configuration (the provider's ids are only as unique as its merchant account): another lender's delivery
  -- id can never make this lender's genuine delivery look like a replay.
  if not private.mark_webhook_seen('pc_' || replace(v_cfg.id::text, '-', ''), v_delivery_id) then
    select * into v_existing from payments.provider_events e
     where e.provider = v_cfg.provider and e.lender_org_id = v_cfg.lender_org_id and e.provider_event_id = v_event_id;
    perform private.write_webhook_receipt(v_cfg.provider, v_cfg.lender_org_id, v_cfg.id, v_delivery_id, v_sha, 'duplicate', 'replayed_delivery', v_scheme, v_sigp, v_skew, v_bytes, v_ip, v_existing.id);
    return v_accepted;
  end if;

  insert into payments.provider_events (provider, provider_event_id, event_type, lender_org_id, payment_intent_id, amount_minor, provider_status, payload_sha256, signature_verified,
                                        currency, config_id, object_kind, object_ref, order_ref, rank, occurred_at, verification_stages, processing_class, parent_payment_ref)
  values (v_cfg.provider, v_event_id, v_kind || '.' || v_status, v_cfg.lender_org_id, v_intent.id, v_amount, v_status, v_sha, true,
          case when v_amount is not null then 'INR' end, v_cfg.id, v_kind, v_object_ref, v_order_ref, v_rank, v_occurred, v_stages,
          case when v_ignored then 'ignored' else 'actionable' end, v_parent_ref)
  on conflict (provider, lender_org_id, provider_event_id) do nothing
  returning id into v_row_id;

  if v_row_id is null then
    -- (h) The same event id again (another delivery) from the same lender. Same payload: a duplicate. A different payload: a duplicate and an exception.
    select * into v_existing from payments.provider_events e
     where e.provider = v_cfg.provider and e.lender_org_id = v_cfg.lender_org_id and e.provider_event_id = v_event_id;
    if v_existing.payload_sha256 is distinct from v_sha then
      perform private.raise_exception_impl(v_cfg.lender_org_id, 'event_payload_conflict', 'warning', 'platform', jsonb_build_object('event_id', v_existing.id::text));
      perform private.write_webhook_receipt(v_cfg.provider, v_cfg.lender_org_id, v_cfg.id, v_delivery_id, v_sha, 'duplicate', 'event_payload_conflict', v_scheme, v_sigp, v_skew, v_bytes, v_ip, v_existing.id);
    else
      perform private.write_webhook_receipt(v_cfg.provider, v_cfg.lender_org_id, v_cfg.id, v_delivery_id, v_sha, 'duplicate', 'replayed_delivery', v_scheme, v_sigp, v_skew, v_bytes, v_ip, v_existing.id);
    end if;
    return v_accepted;
  end if;

  if v_ignored then
    perform private.record_event_processing(v_row_id, v_cfg.lender_org_id, 'ignored_unsupported', case when v_kind = 'unsupported' then 'unsupported_kind' else 'unmapped_status' end);
    perform private.write_webhook_receipt(v_cfg.provider, v_cfg.lender_org_id, v_cfg.id, v_delivery_id, v_sha, 'verified_ignored', 'none', v_scheme, v_sigp, v_skew, v_bytes, v_ip, v_row_id);
  else
    perform ops.enqueue_event('payment.apply_event', jsonb_build_object('event_id', v_row_id), null, 'payment.apply_event:' || v_row_id::text || ':1');
    perform private.write_webhook_receipt(v_cfg.provider, v_cfg.lender_org_id, v_cfg.id, v_delivery_id, v_sha, 'verified', 'none', v_scheme, v_sigp, v_skew, v_bytes, v_ip, v_row_id);
  end if;
  return v_accepted;
end
$function$;

CREATE OR REPLACE FUNCTION payments.sweep_mandates(p_draft_grace interval DEFAULT '01:00:00'::interval, p_cancel_grace interval DEFAULT '24:00:00'::interval, p_unresolved_after interval DEFAULT '24:00:00'::interval)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  m record;
  h record;
  v_found boolean;
  v_action text;
  v_drafts integer := 0;
  v_reconciling integer := 0;
  v_waiting integer := 0;
  v_expired integer := 0;
  v_cancel integer := 0;
  v_resent integer := 0;
  v_unresolved integer := 0;
  v_notices integer := 0;
  v_blocked integer := 0;
  v_today date := (clock_timestamp() at time zone 'Asia/Kolkata')::date;
begin
  if private.invoking_role() <> 'service_role' then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  -- A draft is closed only when the provider cannot be in the middle of being asked. The hand-off row of the outbox says where it is: processing
  -- (a worker holds it) or pending and not cancelled (still to run): wait. Cancelled by the borrower and never claimed, or claimed once and
  -- completed without a call (it saw the cancellation): nothing was registered, close it. Anything else (claimed more than once, dead, or completed
  -- without an outcome) may have reached the provider: requires_reconciliation and a platform exception, never "cancelled" with the reference lost.
  for m in select x.id, x.lender_org_id, x.cancel_requested_at is not null as cancel_requested from payments.mandates x
            where x.status = 'draft' and (x.cancel_requested_at is not null or x.created_at < clock_timestamp() - p_draft_grace)
            order by x.created_at for update skip locked loop
    select e.status::text as status, e.attempts into h from ops.outbox_events e where e.dedupe_key = 'mandate.handoff:' || m.id::text;
    v_found := found;
    if not v_found then
      v_action := 'cancel';
    elsif h.status = 'processing' then
      v_action := 'wait';
    elsif h.status = 'pending' then
      v_action := case when not m.cancel_requested then 'wait' when h.attempts = 0 then 'cancel' else 'reconcile' end;
    elsif h.status = 'completed' then
      v_action := case when m.cancel_requested and h.attempts <= 1 then 'cancel' else 'reconcile' end;
    else
      v_action := 'reconcile';
    end if;
    if v_action = 'cancel' then
      perform private.mandate_move(m.id, 'cancelled', 'system', null, clock_timestamp());
      v_drafts := v_drafts + 1;
    elsif v_action = 'reconcile' then
      perform private.mandate_move(m.id, 'requires_reconciliation', 'system', null, clock_timestamp());
      perform private.raise_exception_impl(m.lender_org_id, 'mandate_unresolved', 'warning', 'platform', jsonb_build_object('mandate_id', m.id::text));
      v_reconciling := v_reconciling + 1;
    else
      v_waiting := v_waiting + 1;
    end if;
  end loop;
  -- The end date has passed.
  for m in select x.id from payments.mandates x where x.status in ('active', 'paused') and x.end_date < v_today for update skip locked loop
    perform private.mandate_move(m.id, 'expired', 'system', null, clock_timestamp());
    v_expired := v_expired + 1;
  end loop;
  -- A cancellation the provider has not acknowledged is queued again (at most 200 a run, at most 48 times a mandate, at least 30 minutes apart).
  for m in select x.id from payments.mandates x
            where x.status in ('registration_pending', 'active', 'paused', 'requires_reconciliation') and x.cancel_requested_at is not null and x.cancel_sent_at is null
              and x.provider_mandate_ref is not null and x.cancel_attempts < 48
              and coalesce(x.cancel_enqueued_at, x.cancel_requested_at) < clock_timestamp() - interval '30 minutes'
            order by coalesce(x.cancel_enqueued_at, x.cancel_requested_at) limit 200 for update skip locked loop
    perform private.enqueue_mandate_cancel(m.id);
    v_resent := v_resent + 1;
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
  -- A mandate whose configuration is not active cannot be refreshed by an event: the receiver verifies a delivery only against an ACTIVE
  -- configuration, so a revoke or cancellation the provider sent in the meantime left nothing but a bare receipt, and the periodic lookup is the
  -- only repair. A live mandate on such a configuration that nobody has refreshed (event or lookup) for p_unresolved_after is raised to the
  -- platform, which can look it up by hand, end it or reactivate the configuration. At most 200 new exceptions a run, oldest first.
  for m in select x.id, x.lender_org_id from payments.mandates x
            join payments.lender_payment_configs c on c.id = x.config_id and c.lender_org_id = x.lender_org_id
            where x.status in ('registration_pending', 'active', 'paused', 'requires_reconciliation') and c.status <> 'active'
              and coalesce(x.status_checked_at, x.last_event_at, x.created_at) < clock_timestamp() - p_unresolved_after
              and not exists (select 1 from payments.reconciliation_exceptions e
                               where e.lender_org_id = x.lender_org_id and e.class = 'mandate_unresolved' and e.status <> 'resolved'
                                 and e.subject_key = 'mandate_id=' || x.id::text)
            order by coalesce(x.status_checked_at, x.last_event_at, x.created_at), x.id limit 200 loop
    perform private.raise_exception_impl(m.lender_org_id, 'mandate_unresolved', 'warning', 'platform', jsonb_build_object('mandate_id', m.id::text));
    v_blocked := v_blocked + 1;
  end loop;
  -- Notices that can never go out (the debit is over or past its date, the mandate ended, the loan is no longer active) are closed, so they
  -- never crowd out a notice that can. A notice held back only by a paused mandate, a cancellation request or a switch that is off stays open.
  with dead as (
    select n.id from payments.pre_debit_notices n
      join payments.mandate_debits d on d.id = n.debit_id and d.lender_org_id = n.lender_org_id
      join payments.mandates mm on mm.id = n.mandate_id and mm.lender_org_id = n.lender_org_id
      join servicing.loan_accounts la on la.id = mm.loan_account_id and la.lender_org_id = mm.lender_org_id
     where n.status in ('planned', 'late') and n.sent_at is null
       and (d.status not in ('scheduled', 'notified') or d.scheduled_on < v_today
            or mm.status in ('rejected', 'failed', 'expired', 'cancelled', 'revoked') or la.status <> 'active')
       for update of n skip locked)
  update payments.pre_debit_notices n set status = 'not_needed', claimed_until = null from dead where n.id = dead.id;
  get diagnostics v_notices = row_count;
  return jsonb_build_object('drafts_closed', v_drafts, 'drafts_reconciling', v_reconciling, 'drafts_waiting', v_waiting, 'expired', v_expired,
                            'cancel_resent', v_resent, 'cancel_unconfirmed', v_cancel, 'unresolved', v_unresolved, 'refresh_blocked', v_blocked, 'notices_closed', v_notices);
end
$function$;


comment on function payments.sweep_mandates(interval, interval, interval) is
  'System only (a periodic worker). Closes a draft the provider cannot be in the middle of being asked about (borrower-cancelled and never claimed, or abandoned with its hand-off finished: cancelled, source system; a draft whose hand-off is queued or in flight is left alone; one whose hand-off may have reached the provider becomes requires_reconciliation with a platform exception), expires active or paused mandates past their end date, queues an unacknowledged cancellation again (bounded: at most 200 a run, 48 times a mandate, 30 minutes apart), opens exceptions for a cancellation the provider has not confirmed (mandate_cancel_unconfirmed) and for an outcome that stayed unresolved (mandate_unresolved), raises to the platform (mandate_unresolved, at most 200 a run) a live mandate whose payment configuration is not active and which has not been refreshed by an event or a lookup for p_unresolved_after (refresh_blocked: a revoke sent while the configuration was suspended is otherwise lost without a trace), and closes pre-debit notices that can never go out (not_needed). Idempotent. Returns counts.';
comment on function payments.ingest_provider_delivery(text, jsonb) is
  'System only (the callback receiver). The ONLY way a provider delivery enters the database. Routes by the hash of the endpoint token to an ACTIVE configuration (an unknown, suspended or retired token gets the same answer as a bad signature; a verified delivery for an inactive configuration cannot be told apart from garbage in the database, so it is never stored: payments.sweep_mandates raises a live mandate of such a configuration to the platform instead). Anything but outcome verified writes a receipt and nothing else. A verified delivery is read, checked against the configuration (provider, merchant), correlated (a payment, refund or chargeback must match an intent of THIS lender, provider and configuration by order reference; a mandate or debit goes through private.correlate_mandate_event), business-validated (money statuses need an amount, INR; an amount above the table limit of 100000000000000 paise is malformed like any other bad amount: an invalid receipt, nothing stored), and only then consumes its delivery id (private.mark_webhook_seen, one namespace per payment configuration) and takes its event id in provider_events (unique per provider, lender and event id: another lender''s ids never collide). The same event id again from the same lender is a duplicate (an event_payload_conflict exception when the payload differs). An authentic event of an unsupported kind, an unmapped status, or a mandate-only status (active, revoked, paused) on a payment, refund or chargeback is stored verified-and-ignored. A verified, actionable event enqueues payment.apply_event (ids only). A refund or chargeback may carry parentPaymentRef, the provider''s reference of the payment it concerns. Returns {accepted, outcome} and nothing about internals.';


-- ---------------------------------------------------------------------------------------------
-- 3. Feature evidence uses the accounts area's personal-data screen
-- ---------------------------------------------------------------------------------------------
-- Values: private.acct_text_unsafe (nine or more digits once spaces and hyphens are removed, PAN and IFSC shapes in any case, links, e-mail,
-- secret assignments, phone and spaced Aadhaar shapes). Keys: private.acct_label_key_ok (fixed labels: letters and underscores, at most two
-- digits in all). The function guards servicing.request_feature_change, servicing.resolve_sync_conflict (the evidence object) and the three
-- table checks that carry evidence; a row written under the weaker screen is not rewritten.
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
      where not private.acct_label_key_ok(kv.key)
         or jsonb_typeof(kv.value) <> 'string'
         or length(kv.value #>> '{}') not between 1 and 200
         or private.acct_text_unsafe(kv.value #>> '{}'))
  else false end
$$;
comment on function private.feature_evidence_ok(jsonb) is
  'Evidence for an activation switch or a conflict resolution: a flat object of short string references. Keys are fixed labels (letters and underscores, at most two digits in all: they are copied into audit metadata). Values pass private.acct_text_unsafe (no run of nine digits even when spaces or hyphens split it, no PAN or IFSC shape, no link, e-mail, secret assignment or phone shape). Defence in depth, not a personal-data scanner: a name cannot be recognised by shape.';


-- ---------------------------------------------------------------------------------------------
-- 4. The evidence position of the reminder window rule (U44, second half)
-- ---------------------------------------------------------------------------------------------
-- The seed said "unverified against the primary text" about para 100, while the primary extract on file (RBC Directions 2025 as on 1 April 2026)
-- confirms its text: no recovery call before 8:00 a.m. or after 7:00 p.m., not applicable to microfinance loans (para 91(2) gives those 9:00 a.m.
-- to 6:00 p.m.; its scope is unclear in the extract). Only the extension to in-app and push service messages is an interpretation (open question
-- 4 of the extract), which is why the rule's label stays 'interpretation'. Only a draft can still be edited: a database whose version 1 was
-- already approved needs a version 2 proposed by a platform person (an approved rule is immutable).
update documents.applicability_rules
   set direction_ref = 'RBC Directions 2025 (RBI/DOR/2025-26/362), para 100 (hours for recovery calls): text confirmed in the primary extract on file; its application to service messages is interpretation',
       exclusions = 'DRAFT FOR LEGAL/COMPLIANCE REVIEW. Evidence label: interpretation. Confirmed in the primary extract on file (RBC Directions 2025, as on 1 April 2026): para 100 bars calling a borrower before 8:00 a.m. or after 7:00 p.m. for recovery of overdue loans, and is not applicable to microfinance loans under the Credit Facilities Directions (para 91(2) gives those 9:00 a.m. to 6:00 p.m.; its scope is unclear in the extract). Interpretation: the text speaks of calling and does not say whether in-app or push service messages count (open question 4 of the extract); an overdue reminder is recovery-adjacent, so the same hours are applied to every borrower reminder as a conservative reading. A lender policy may only NARROW this window; a message outside it is deferred to the next window, never dropped silently. TRAI promotional-hours rules are not relied on because these are service messages (unverified).'
 where rule_key = 'servicing.reminder_window.default' and version = 1 and approval_status = 'draft';
