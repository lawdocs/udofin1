-- =============================================================================================
-- Phase 08a review-fix wave, area SM: mandates, debits and pre-debit notices. Forward-only; only the objects migration 20261018000915
-- (and the hand-off redefinition of 20261018000918) created for mandates are touched.
--
--   A22      claim_pre_debit_notices applied its eligibility tests AFTER the LIMIT, so 100 dead notices starved every lender for good:
--            every test is now inside the scanned SELECT, and sweep_mandates closes dead notices ('not_needed').
--   A52 M45  planned debits and notices outlived the mandate: when a mandate ends (rejected, failed, expired, cancelled, revoked) or its
--            loan closes, planned debits nobody presented become 'cancelled' and their unsent notices 'not_needed'; the borrower's
--            "next debit" and the notice claim look only at an ACTIVE mandate with no cancellation request on an active loan.
--   M44      a debit presented or settled while the mandate is not in force (paused, ended, cancellation requested, loan not active, or not
--            yet registered) is recorded and flagged CRITICAL to the lender, planned or not; it is never a quiet normal debit.
--   A53 U3   plan_mandate_debits skips an installment the lender's fresh, consistent report shows as paid, cancels a planned debit a later
--            report shows as paid, and replaces a planned debit whose date or amount the lender's newest schedule or report restated.
--   A51 U1 M46  a cancellation request is no longer lost: it is queued again (fresh dedupe key) when the hand-off stores the reference,
--            and the sweep queues it again (bounded) while the provider has not acknowledged it; a draft is never closed while the
--            hand-off is queued or in flight (the outbox row says so); a reference that arrives for a mandate that already left the draft
--            is stored (set once) and flagged to the platform.
--   U2       active and paused mandates are looked up at the provider at least once a day.
--   U4 U5 U6 U7 A58  a later, different amount is an exception; a debit event without an amount attaches to the single planned debit of
--            its date window; rejected and expired debit statuses are mapped; refunded and disputed are exceptions, never "stale"; a
--            timestamp more than 15 minutes ahead is replaced by the receipt time (and flagged) so one event cannot freeze a mandate; an
--            older revoke or cancel report is an exception, not silence; an amount of 0 or above the limit and a malformed return code
--            never make the whole update fail.
--   U8       composite tenant, borrower and loan keys on mandates, debits and notices, and a trigger for "a planned debit never exceeds the
--            mandate maximum" and for the schedule and provider event a row points at.
--   U9       a live mandate stays visible to its borrower (and cancellable) when the lender's mandates switch is off.
--
-- Function signatures are unchanged (grants are kept by create or replace). New private helpers have no grants.
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- 1. Columns, keys and triggers
-- ---------------------------------------------------------------------------------------------
-- cancel_attempts and cancel_enqueued_at: how often the cancellation was queued for the provider and when last (bounded re-queueing by the
-- sweep). status_checked_at: when the provider's status was last looked up (periodic lookup of live mandates).
alter table payments.mandates
  add column cancel_attempts smallint not null default 0 check (cancel_attempts between 0 and 1000),
  add column cancel_enqueued_at timestamptz,
  add column status_checked_at timestamptz,
  add constraint cancel_attempts_need_request check (cancel_attempts = 0 or cancel_requested_at is not null);
comment on column payments.mandates.cancel_attempts is
  'How many times the cancellation was queued for the provider (the borrower''s or the closure job''s request is the first). The sweep queues it again, bounded, while the provider has not acknowledged it.';
comment on column payments.mandates.cancel_enqueued_at is 'When the cancellation was last queued for the provider.';
comment on column payments.mandates.status_checked_at is 'When the provider''s status of the mandate was last looked up (an authenticated lookup, whatever it answered).';

create or replace function private.protect_mandate()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_allowed text[];
  v_moving text[] := array['status', 'provider_mandate_ref', 'handoff_expires_at', 'last_event_at', 'cancel_requested_at', 'cancel_reason', 'cancel_sent_at',
                           'cancel_attempts', 'cancel_enqueued_at', 'status_checked_at', 'updated_at'];
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

-- Tenant, borrower and loan consistency by key, not only by function code (U8).
alter table payments.mandates
  add constraint mandates_id_lender_borrower unique (id, lender_org_id, borrower_id),
  add constraint mandates_id_lender_loan unique (id, lender_org_id, loan_account_id),
  add constraint mandates_loan_borrower_fk foreign key (loan_account_id, lender_org_id, borrower_id)
    references servicing.loan_accounts (id, lender_org_id, borrower_id) on delete restrict;
alter table payments.mandate_debits
  add constraint mandate_debits_id_lender_mandate unique (id, lender_org_id, mandate_id),
  add constraint mandate_debits_mandate_loan_fk foreign key (mandate_id, lender_org_id, loan_account_id)
    references payments.mandates (id, lender_org_id, loan_account_id) on delete restrict;
alter table payments.pre_debit_notices
  add constraint pre_debit_notices_mandate_borrower_fk foreign key (mandate_id, lender_org_id, borrower_id)
    references payments.mandates (id, lender_org_id, borrower_id) on delete restrict,
  add constraint pre_debit_notices_debit_mandate_fk foreign key (debit_id, lender_org_id, mandate_id)
    references payments.mandate_debits (id, lender_org_id, mandate_id) on delete restrict;

-- One live planned debit per installment of a schedule snapshot (the spec's key). A debit cancelled by the system (a prepaid installment, a
-- restated schedule, a mandate that ended) no longer counts, so a restated installment can be planned again; the planner never re-plans one
-- the provider itself cancelled (it carries the provider reference).
drop index payments.mandate_debits_one_per_installment;
create unique index mandate_debits_one_per_snapshot_installment on payments.mandate_debits (mandate_id, schedule_snapshot_id, installment_seq)
  where planned and status <> 'cancelled';

-- A planned debit is never above the mandate maximum, and a debit points only at its own loan's schedule and its own lender's provider event.
create or replace function private.check_mandate_debit_consistency()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_max bigint;
begin
  if tg_op = 'INSERT' and new.planned then
    select m.max_amount_minor into v_max from payments.mandates m where m.id = new.mandate_id and m.lender_org_id = new.lender_org_id;
    if v_max is not null and new.amount_minor > v_max then
      raise exception 'a planned debit is never above the mandate maximum' using errcode = '23514';
    end if;
  end if;
  if new.schedule_snapshot_id is not null and (tg_op = 'INSERT' or new.schedule_snapshot_id is distinct from old.schedule_snapshot_id) then
    if not exists (select 1 from servicing.schedule_snapshots s
                    where s.id = new.schedule_snapshot_id and s.lender_org_id = new.lender_org_id and s.loan_account_id = new.loan_account_id) then
      raise exception 'the schedule of a debit belongs to the debit''s own loan' using errcode = '23503';
    end if;
  end if;
  if new.last_event_id is not null and (tg_op = 'INSERT' or new.last_event_id is distinct from old.last_event_id) then
    if not exists (select 1 from payments.provider_events e where e.id = new.last_event_id and e.lender_org_id = new.lender_org_id) then
      raise exception 'the provider event of a debit belongs to the debit''s own lender' using errcode = '23503';
    end if;
  end if;
  return new;
end
$$;
revoke all on function private.check_mandate_debit_consistency() from public;
create trigger consistency before insert or update on payments.mandate_debits
  for each row execute function private.check_mandate_debit_consistency();

create or replace function private.check_mandate_event_consistency()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.provider_event_id is not null
     and not exists (select 1 from payments.provider_events e where e.id = new.provider_event_id and e.lender_org_id = new.lender_org_id) then
    raise exception 'the provider event of a mandate event belongs to the mandate''s own lender' using errcode = '23503';
  end if;
  return new;
end
$$;
revoke all on function private.check_mandate_event_consistency() from public;
create trigger consistency before insert on payments.mandate_events
  for each row execute function private.check_mandate_event_consistency();

-- ---------------------------------------------------------------------------------------------
-- 2. Helpers (no grants: only the definer functions below call them)
-- ---------------------------------------------------------------------------------------------
-- Statuses of a provider DEBIT event: rejected is a failed presentation (returned), expired a debit that was never presented in time (cancelled).
-- refunded and disputed are not debit states: apply_debit_observation treats them as exceptions.
create or replace function private.debit_status_from_provider(p_status text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case p_status when 'created' then 'scheduled' when 'pending' then 'presented' when 'authorized' then 'presented'
    when 'captured' then 'settled' when 'paid' then 'settled' when 'succeeded' then 'settled'
    when 'returned' then 'returned' when 'failed' then 'returned' when 'rejected' then 'returned'
    when 'cancelled' then 'cancelled' when 'expired' then 'cancelled' end
$$;

-- True only when the lender's newest report is consistent AND fresh and shows the installment due on p_due as paid: the next due date is
-- later than p_due, or the loan is reported as no longer active, or nothing is due and nothing is outstanding. Anything doubtful is false.
create or replace function private.report_shows_paid(p_loan uuid, p_due date)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(f.ok and not f.stale and (
           f.reported_status <> 'active'::servicing.loan_status
        or (f.next_due_on is not null and p_due < f.next_due_on)
        or (f.next_due_on is null and coalesce(b.outstanding_principal_minor, -1) = 0 and coalesce(f.total_overdue_minor, 0) = 0)), false)
  from private.reminder_figures(p_loan) f
  left join lateral (
    select s.outstanding_principal_minor from servicing.balance_snapshots s where s.loan_account_id = p_loan order by s.reported_as_of desc, s.version desc limit 1
  ) b on true
$$;
revoke all on function private.report_shows_paid(uuid, date) from public;
comment on function private.report_shows_paid(uuid, date) is
  'Whether the lender''s newest report (consistent, fresh) shows the installment due on the given date as already paid. False when the report is missing, stale, inconsistent or silent.';

-- A mandate ended or its loan closed: planned debits nobody presented are cancelled and the notices that were never sent are closed. A debit the
-- provider already knows (it carries the provider reference) is left alone: it is the provider's, and what happens to it is reported or flagged.
-- Lock order everywhere: mandate, debit, notice.
create or replace function private.close_mandate_debits(p_mandate uuid, p_reason text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  m payments.mandates;
  v_n integer;
begin
  select * into m from payments.mandates x where x.id = p_mandate;
  if not found then
    return 0;
  end if;
  with c as (
    update payments.mandate_debits d set status = 'cancelled', rank = greatest(d.rank, 40)
     where d.mandate_id = m.id and d.lender_org_id = m.lender_org_id and d.planned and d.status in ('scheduled', 'notified') and d.provider_debit_ref is null
    returning d.id)
  select count(*) into v_n from c;
  update payments.pre_debit_notices n set status = 'not_needed', claimed_until = null
   where n.mandate_id = m.id and n.lender_org_id = m.lender_org_id and n.status in ('planned', 'late') and n.sent_at is null;
  if v_n > 0 then
    perform private.write_payments_audit(m.lender_org_id, 'payments.mandate.debits_cancelled', 'mandate', m.id::text, jsonb_build_object('count', v_n, 'reason', p_reason));
  end if;
  return v_n;
end
$$;
revoke all on function private.close_mandate_debits(uuid, text) from public;
comment on function private.close_mandate_debits(uuid, text) is
  'Cancels the planned debits of a mandate that nobody presented (scheduled or notified, no provider reference) and closes its unsent pre-debit notices (not_needed). Nothing is deleted. Returns how many debits were cancelled.';

-- Queues the cancellation for the provider once more, under a fresh dedupe key (the first request used mandate.cancel:<id>).
create or replace function private.enqueue_mandate_cancel(p_mandate uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  m payments.mandates;
  v_n smallint;
begin
  select * into m from payments.mandates x where x.id = p_mandate for update;
  if not found or m.cancel_requested_at is null then
    return;
  end if;
  v_n := least(greatest(m.cancel_attempts + 1, 2), 1000);
  update payments.mandates set cancel_attempts = v_n, cancel_enqueued_at = clock_timestamp() where id = m.id;
  perform ops.enqueue_event('mandate.cancel', jsonb_build_object('mandate_id', m.id), null, 'mandate.cancel:' || m.id::text || ':' || v_n::text);
end
$$;
revoke all on function private.enqueue_mandate_cancel(uuid) from public;
comment on function private.enqueue_mandate_cancel(uuid) is
  'Queues the cancellation of a mandate with a recorded request for the provider again (dedupe key mandate.cancel:<id>:<attempt>), and counts the attempt. The worker handler sends it only while the mandate is live, the provider reference exists and nothing was acknowledged yet.';

-- ---------------------------------------------------------------------------------------------
-- 3. Moving a mandate; reports, events and debits
-- ---------------------------------------------------------------------------------------------
-- A mandate that leaves the live set takes its planned debits and unsent notices with it.
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
  if p_to in ('rejected', 'failed', 'expired', 'cancelled', 'revoked') then
    perform private.close_mandate_debits(m.id, p_to);
  end if;
end
$$;

-- The one rule for a status report. A time more than 15 minutes ahead of the clock is replaced by the clock and flagged (one wrong provider
-- clock cannot freeze a mandate). A stale report changes nothing, except that an older report of a revoke or cancellation for a mandate still
-- in force is an exception (a person looks), never silence.
create or replace function private.apply_mandate_status(p_mandate uuid, p_new text, p_source text, p_event uuid, p_observed timestamptz)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  m payments.mandates;
  v_now timestamptz := clock_timestamp();
  v_obs timestamptz := coalesce(p_observed, clock_timestamp());
begin
  select * into m from payments.mandates x where x.id = p_mandate for update;
  if not found then
    raise exception 'mandate not found' using errcode = 'P0002';
  end if;
  if v_obs > v_now + interval '15 minutes' then
    v_obs := v_now;
    perform private.raise_exception_impl(m.lender_org_id, 'mandate_status_conflict', 'warning', 'platform', jsonb_build_object('mandate_id', m.id::text));
  end if;
  if m.last_event_at is not null and v_obs < m.last_event_at then
    if p_new in ('revoked', 'cancelled') and m.status in ('registration_pending', 'active', 'paused', 'requires_reconciliation') then
      perform private.raise_exception_impl(m.lender_org_id, 'mandate_status_conflict', 'warning', 'lender', jsonb_build_object('mandate_id', m.id::text));
      return 'exception';
    end if;
    return 'ignored_stale';
  end if;
  if p_new = m.status then
    return 'ignored_stale';
  end if;
  if exists (select 1 from payments.mandate_transitions t where t.from_status = m.status and t.to_status = p_new) then
    perform private.mandate_move(m.id, p_new, p_source, p_event, v_obs);
    return 'applied';
  end if;
  perform private.raise_exception_impl(m.lender_org_id, 'mandate_status_conflict', 'warning', 'lender', jsonb_build_object('mandate_id', m.id::text));
  return 'exception';
end
$$;

-- One observation of a debit (a verified event or an authenticated lookup). Attaches to the one planned debit it matches (same amount, or any
-- amount when the report states none, and a date within three days), otherwise records an UNPLANNED debit and tells the lender. Forward only; a
-- contradiction changes nothing and opens an exception. A debit presented or settled while the mandate is not in force is flagged critical.
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
  v_now timestamptz := clock_timestamp();
  v_on date;
  v_n integer;
  v_rank smallint := private.debit_rank(p_status);
  v_class text;
  v_new boolean := false;
  v_changed boolean := false;
  v_amount bigint := p_amount;
  v_bad_amount boolean := false;
  v_code text := p_return_code;
  v_bad_code boolean := false;
  v_reversal boolean := p_status in ('refunded', 'disputed');
  v_in_force boolean;
begin
  select * into m from payments.mandates x where x.id = p_mandate for update;
  if not found then
    raise exception 'mandate not found' using errcode = 'P0002';
  end if;
  if v_rank is null and not v_reversal then
    return 'ignored_unsupported';
  end if;
  -- A debit report states no date of its own: the day of the event stands for it (matching the plan within three days). A debit event, unlike a
  -- mandate status report, never orders anything, so its time is not clamped.
  v_on := coalesce(p_scheduled_on, (coalesce(p_observed, v_now) at time zone 'Asia/Kolkata')::date);
  -- An amount outside what a debit can be (0, or above the limit) is treated as unknown; a return code that is not a code is dropped. The
  -- observation is still recorded and a person is told: no check violation ever escapes this function.
  if v_amount is not null and v_amount not between 1 and 100000000000000 then
    v_amount := null;
    v_bad_amount := true;
  end if;
  if v_code is not null and v_code !~ '^[A-Za-z0-9._:-]{1,40}$' then
    v_code := null;
    v_bad_code := true;
  end if;

  select * into d from payments.mandate_debits x where x.mandate_id = m.id and x.provider_debit_ref = p_debit_ref for update;
  if not found then
    v_n := 0;
    if not v_reversal then
      select count(*) into v_n from payments.mandate_debits x
       where x.mandate_id = m.id and x.planned and x.provider_debit_ref is null and x.status in ('scheduled', 'notified')
         and (p_amount is null or x.amount_minor = p_amount) and abs(x.scheduled_on - v_on) <= 3;
    end if;
    if v_n = 1 then
      select * into d from payments.mandate_debits x
       where x.mandate_id = m.id and x.planned and x.provider_debit_ref is null and x.status in ('scheduled', 'notified')
         and (p_amount is null or x.amount_minor = p_amount) and abs(x.scheduled_on - v_on) <= 3 for update;
      update payments.mandate_debits set provider_debit_ref = p_debit_ref where id = d.id returning * into d;
    else
      insert into payments.mandate_debits (lender_org_id, mandate_id, loan_account_id, planned, scheduled_on, amount_minor, provider_debit_ref, status, rank)
      values (m.lender_org_id, m.id, m.loan_account_id, false, v_on, v_amount, p_debit_ref,
              case when v_reversal then 'unknown' else 'scheduled' end, case when v_reversal then 35 else 10 end)
      returning * into d;
      v_new := true;
    end if;
  end if;

  -- A refund or a dispute of a debit is never an ordinary status move: money went back, or is contested. A person looks.
  if v_reversal then
    update payments.mandate_debits set last_event_id = coalesce(p_event, last_event_id) where id = d.id;
    perform private.raise_exception_impl(m.lender_org_id, 'mandate_debit_unresolved', 'critical', 'lender', jsonb_build_object('debit_id', d.id::text));
    return 'exception';
  end if;

  -- A debit presented or settled while the mandate is not in force (paused, ended, a cancellation requested, the loan no longer active, or not
  -- registered yet) is recorded and shown to the lender as critical, whether or not it was planned. Other debit news on a mandate that is not yet
  -- in force, and every unplanned debit, is flagged as before.
  v_in_force := m.status = 'active' and m.cancel_requested_at is null
                and exists (select 1 from servicing.loan_accounts la where la.id = m.loan_account_id and la.lender_org_id = m.lender_org_id and la.status = 'active');
  if not v_in_force and p_status in ('presented', 'settled') then
    perform private.raise_exception_impl(m.lender_org_id, 'mandate_debit_unresolved', 'critical', 'lender', jsonb_build_object('debit_id', d.id::text));
  elsif v_new or m.status not in ('active', 'paused', 'cancelled', 'revoked', 'expired') then
    perform private.raise_exception_impl(m.lender_org_id, 'mandate_debit_unresolved', 'warning', 'lender', jsonb_build_object('debit_id', d.id::text));
  end if;
  if v_bad_amount then
    perform private.raise_exception_impl(m.lender_org_id, 'mandate_debit_unresolved', case when p_status = 'settled' then 'critical' else 'warning' end, 'lender',
      jsonb_build_object('debit_id', d.id::text));
    if p_status = 'settled' then
      -- Money is reported moved with an amount that cannot be one: nothing is settled on it.
      return 'exception';
    end if;
  end if;
  if v_bad_code then
    perform private.raise_exception_impl(m.lender_org_id, 'mandate_debit_unresolved', 'warning', 'lender', jsonb_build_object('debit_id', d.id::text));
  end if;

  if v_amount is not null and d.amount_minor is null then
    update payments.mandate_debits set amount_minor = v_amount where id = d.id returning * into d;
    v_changed := true;
  elsif v_amount is not null and d.amount_minor is not null and v_amount <> d.amount_minor then
    -- The provider now states another amount than the one recorded (the recorded amount never changes): nothing advances, a person looks.
    perform private.raise_exception_impl(m.lender_org_id, 'amount_mismatch', 'critical', 'lender', jsonb_build_object('debit_id', d.id::text));
    return 'exception';
  end if;
  if v_amount is not null and v_amount > m.max_amount_minor and not d.exceeds_mandate_max then
    update payments.mandate_debits set exceeds_mandate_max = true where id = d.id returning * into d;
    perform private.raise_exception_impl(m.lender_org_id, 'amount_mismatch', 'critical', 'lender', jsonb_build_object('debit_id', d.id::text));
    v_changed := true;
  end if;
  if d.rank >= 40 and p_status <> d.status and v_rank >= 40 then
    -- settled after returned, returned after settled, cancelled after either: no automatic answer.
    perform private.raise_exception_impl(m.lender_org_id, 'mandate_debit_unresolved', 'warning', 'lender', jsonb_build_object('debit_id', d.id::text));
    return 'exception';
  end if;
  if v_rank <= d.rank and not (d.status = 'returned' and p_status = 'returned' and d.return_code is null and v_code is not null) then
    return case when v_new or v_changed then 'applied' else 'ignored_stale' end;
  end if;
  if p_status = 'returned' and v_code is not null then
    select c.class into v_class from payments.mandate_return_codes c where c.provider = m.provider and c.code = v_code and c.status = 'active';
  end if;
  update payments.mandate_debits set
    status = p_status, rank = greatest(rank, v_rank), last_event_id = coalesce(p_event, last_event_id),
    return_code = case when p_status = 'returned' then coalesce(return_code, v_code) else return_code end,
    return_class = case when p_status = 'returned' and return_code is null and v_code is not null then v_class else return_class end
   where id = d.id;
  return 'applied';
end
$$;

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
  return private.apply_debit_observation(v_mandate, e.object_ref, null, e.amount_minor,
    coalesce(private.debit_status_from_provider(e.provider_status), case when e.provider_status in ('refunded', 'disputed') then e.provider_status else 'unknown' end),
    null, e.id, coalesce(e.occurred_at, e.received_at));
end
$$;

-- ---------------------------------------------------------------------------------------------
-- 4. The borrower
-- ---------------------------------------------------------------------------------------------
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
  update payments.mandates set cancel_requested_at = clock_timestamp(), cancel_reason = 'borrower', cancel_attempts = 1, cancel_enqueued_at = clock_timestamp() where id = m.id;
  perform ops.enqueue_event('mandate.cancel', jsonb_build_object('mandate_id', m.id), null, 'mandate.cancel:' || m.id::text);
  perform private.write_payments_audit(m.lender_org_id, 'payments.mandate.cancel_requested', 'mandate', m.id::text, jsonb_build_object('reason', 'borrower'));
  return 'cancel_requested';
end
$$;
comment on function payments.request_mandate_cancellation(uuid) is
  'Borrower only. Records the REQUEST to cancel their own live mandate and queues it for the provider. The mandate becomes cancelled only when the provider confirms it (a verified event or an authenticated lookup), or, for a draft the provider was never asked about, when the sweep closes it. The request is queued again (the hand-off stores the reference, the sweep re-queues it) until the provider acknowledges it. Works whatever the lender''s mandates switch says. Idempotent.';

-- The borrower's mandates. A live mandate stays listed (and cancellable) when the lender's mandates switch is off; only mandates that are over are
-- hidden then. The next debit is shown only for an ACTIVE mandate with no cancellation request, on an active loan, and only while the lender's
-- switch is on and the lender's own newest report does not show the installment as paid.
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
      join servicing.loan_accounts la on la.id = m.loan_account_id and la.lender_org_id = m.lender_org_id
     where d.mandate_id = m.id and d.lender_org_id = m.lender_org_id and d.status in ('scheduled', 'notified')
       and d.scheduled_on >= (clock_timestamp() at time zone 'Asia/Kolkata')::date
       and m.status = 'active' and m.cancel_requested_at is null and la.status = 'active'
       and private.feature_enabled(m.lender_org_id, 'mandates')
       and not private.report_shows_paid(m.loan_account_id, d.scheduled_on)
     order by d.scheduled_on limit 1) nd on true
  where m.borrower_id = (select private.my_borrower_id())
    and (private.feature_enabled(m.lender_org_id, 'mandates') or m.status in ('draft', 'registration_pending', 'active', 'paused', 'requires_reconciliation'))
  order by m.created_at desc
$$;
comment on function payments.my_mandates() is
  'Borrower only (empty for anyone else). The caller''s mandates with the status exactly as the provider-confirmed history last left it, the masked account, the limits, whether a cancellation was requested, and the next planned debit (only for an active mandate without a cancellation request on an active loan, while the lender''s mandates switch is on and the lender''s own newest report does not show the installment as paid). A draft or pending mandate is shown as such: nothing is "active" until the provider says so. A mandate that is not over is listed even when the lender''s mandates switch is off, so the borrower can still see and cancel it; a finished mandate of such a lender is not listed.';

create or replace function payments.my_mandate_debits(p_mandate uuid)
returns table (debit_id uuid, scheduled_on date, amount_minor bigint, status text, planned boolean, return_code text, return_class text,
               notice_status text, notice_due_at timestamptz, notice_sent_at timestamptz)
language plpgsql
stable
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
  select * into m from payments.mandates x where x.id = p_mandate and x.borrower_id = v_borrower;
  if not found or (not private.feature_enabled(m.lender_org_id, 'mandates')
                   and m.status not in ('draft', 'registration_pending', 'active', 'paused', 'requires_reconciliation')) then
    raise exception 'mandate not found' using errcode = 'P0002';
  end if;
  return query
    select d.id, d.scheduled_on, d.amount_minor, d.status, d.planned, d.return_code, d.return_class, n.status, n.notice_due_at, n.sent_at
    from payments.mandate_debits d
    left join payments.pre_debit_notices n on n.debit_id = d.id and n.lender_org_id = d.lender_org_id
    where d.mandate_id = m.id and d.lender_org_id = m.lender_org_id
    order by d.scheduled_on desc, d.id desc
    limit 60;
end
$$;
comment on function payments.my_mandate_debits(uuid) is
  'Borrower only: the newest 60 debits of one of the caller''s own mandates (P0002 for anyone else''s, and for a finished mandate when the mandates switch is off) with the pre-debit notice state. A planned debit is what Udofin expects from the lender''s reported schedule; one cancelled because the mandate ended or the lender''s report changed says so. An unplanned one is what the provider reported. The return code is the provider''s own, and its class is shown only when the lender''s configuration classified it. A mandate that is not over stays readable when the lender''s mandates switch is off.';

-- ---------------------------------------------------------------------------------------------
-- 5. The system: hand-off, lookups, cancellation, sweeps
-- ---------------------------------------------------------------------------------------------
-- What happened when the provider was asked to take a mandate request (918 plus: a cancellation requested during the hand-off is queued again
-- once the reference exists; a reference for a mandate that already left the draft is stored once and flagged, never dropped).
create or replace function payments.record_mandate_handoff(p_mandate uuid, p_outcome text, p_provider_mandate_ref text default null, p_expires_at timestamptz default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  m payments.mandates;
  v_stored boolean := false;
begin
  if private.invoking_role() <> 'service_role' then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  if p_outcome is null or p_outcome not in ('handoff', 'rejected', 'unknown', 'not_sent')
     or (p_outcome = 'handoff' and (p_provider_mandate_ref is null or p_provider_mandate_ref !~ '^[A-Za-z0-9._:=+/-]{1,200}$'))
     or (p_outcome <> 'handoff' and p_provider_mandate_ref is not null) then
    raise exception 'invalid hand-off result' using errcode = '22023', hint = 'bad_request';
  end if;
  select * into m from payments.mandates x where x.id = p_mandate for update;
  if not found then
    raise exception 'mandate not found' using errcode = 'P0002';
  end if;
  if m.status <> 'draft' then
    -- A repeat of a recorded hand-off (same reference) answers the status and changes nothing. A DIFFERENT or first reference for a mandate that
    -- already left the draft means the provider holds a registration Udofin did not expect: keep the reference (set once) and tell the platform.
    if p_outcome = 'handoff' and m.provider_mandate_ref is distinct from p_provider_mandate_ref then
      if m.provider_mandate_ref is null then
        begin
          update payments.mandates set provider_mandate_ref = p_provider_mandate_ref, handoff_expires_at = coalesce(p_expires_at, handoff_expires_at) where id = m.id;
          v_stored := true;
        exception when unique_violation then
          v_stored := false;
        end;
      end if;
      if v_stored and m.status = 'requires_reconciliation' then
        -- The unknown outcome is resolved: the provider did take the request.
        perform private.mandate_move(m.id, 'registration_pending', 'handoff', null, clock_timestamp());
        if m.cancel_requested_at is not null and m.cancel_sent_at is null then
          perform private.enqueue_mandate_cancel(m.id);
        end if;
        return 'registration_pending';
      end if;
      perform private.raise_exception_impl(m.lender_org_id, 'mandate_unresolved', 'warning', 'platform', jsonb_build_object('mandate_id', m.id::text));
      if v_stored and m.cancel_requested_at is not null and m.cancel_sent_at is null
         and m.status in ('registration_pending', 'active', 'paused') then
        perform private.enqueue_mandate_cancel(m.id);
      end if;
    end if;
    return m.status;
  end if;
  if p_outcome = 'handoff' then
    update payments.mandates set provider_mandate_ref = p_provider_mandate_ref, handoff_expires_at = p_expires_at where id = m.id;
    perform private.mandate_move(m.id, 'registration_pending', 'handoff', null, clock_timestamp());
    if m.cancel_requested_at is not null then
      -- The borrower asked to cancel while the provider call was in flight: the first request found no reference to cancel. Send it again.
      perform private.enqueue_mandate_cancel(m.id);
    end if;
    return 'registration_pending';
  elsif p_outcome = 'rejected' then
    perform private.mandate_move(m.id, 'failed', 'handoff', null, clock_timestamp());
    return 'failed';
  elsif p_outcome = 'not_sent' then
    perform private.mandate_move(m.id, 'failed', 'system', null, clock_timestamp());
    return 'failed';
  end if;
  perform private.mandate_move(m.id, 'requires_reconciliation', 'handoff', null, clock_timestamp());
  perform private.raise_exception_impl(m.lender_org_id, 'mandate_unresolved', 'warning', 'platform', jsonb_build_object('mandate_id', m.id::text));
  return 'requires_reconciliation';
end
$$;
comment on function payments.record_mandate_handoff(uuid, text, text, timestamptz) is
  'System only. Records what happened when the provider was asked to take a mandate request: handoff (draft -> registration_pending, the provider reference is stored; NOT an activation; a cancellation the borrower requested meanwhile is queued again), rejected (a definite refusal: draft -> failed, source handoff), unknown (draft -> requires_reconciliation and a platform exception: look the mandate up before any retry) or not_sent (nothing reached any provider: draft -> failed, source system). A repeat answers the current status and changes nothing. A provider reference for a mandate that has already left the draft is stored once (a requires_reconciliation mandate moves on to registration_pending) or, for a finished mandate, kept and flagged to the platform (mandate_unresolved): the provider''s registration is never forgotten.';

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
  v_stored boolean := false;
  v_outcome text;
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
    v_stored := true;
  elsif p_provider_mandate_ref is not null and m.provider_mandate_ref is distinct from p_provider_mandate_ref then
    raise exception 'the provider reference differs from the stored one' using errcode = '55000', hint = 'provider_ref_mismatch';
  end if;
  update payments.mandates set status_checked_at = clock_timestamp() where id = m.id;
  v_outcome := private.apply_mandate_status(m.id, v_new, 'status_lookup', null, p_observed_at);
  if v_stored then
    -- The lookup supplied the reference the hand-off never delivered: a pending cancellation request can be sent now.
    select * into m from payments.mandates x where x.id = p_mandate;
    if m.cancel_requested_at is not null and m.cancel_sent_at is null and m.status in ('registration_pending', 'active', 'paused', 'requires_reconciliation') then
      perform private.enqueue_mandate_cancel(m.id);
    end if;
  end if;
  return v_outcome;
end
$$;
comment on function payments.apply_mandate_lookup(uuid, text, text, timestamptz) is
  'System only. Applies an AUTHENTICATED provider status lookup with the same rules as a verified event (stale or repeated: nothing; allowed transition: applied; contradiction: an exception and nothing changes; a time more than 15 minutes ahead is replaced by the clock and flagged). Records when the mandate was last looked up. May supply the provider reference of a mandate whose hand-off outcome was unknown, which queues a pending cancellation request again. Returns the outcome.';

-- A debit report: a return code that is not a code never fails the whole report (the debit is recorded without it and a person is told).
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
     or (p_return_code is not null and p_status <> 'returned') or p_observed_at is null then
    raise exception 'invalid debit report' using errcode = '22023', hint = 'bad_request';
  end if;
  return private.apply_debit_observation(p_mandate, p_provider_debit_ref, p_scheduled_on, p_amount_minor, p_status, p_return_code, null, p_observed_at);
end
$$;
comment on function payments.apply_debit_lookup(uuid, text, date, bigint, text, text, timestamptz) is
  'System only. Applies an authenticated provider debit report (the list the mandate port returns) with the same rules as a verified debit event; the provider''s return code is stored verbatim and classified from payments.mandate_return_codes. A return code outside the allowed characters or length is not stored and never fails the report: the debit is recorded as returned and the lender gets mandate_debit_unresolved. A return code on a debit that was not returned is refused (22023 bad_request). Returns the outcome.';

-- Closure of a loan cancels its mandate: a request per live mandate, to be confirmed by the provider. Planned debits of the closed loan are
-- cancelled at once (the loan is closed whatever the provider confirms), and so are their unsent notices.
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
    update payments.mandates set cancel_requested_at = clock_timestamp(), cancel_reason = 'loan_closed', cancel_attempts = 1, cancel_enqueued_at = clock_timestamp() where id = m.id;
    perform ops.enqueue_event('mandate.cancel', jsonb_build_object('mandate_id', m.id), null, 'mandate.cancel:' || m.id::text);
    v_n := v_n + 1;
  end loop;
  for m in
    select x.id from payments.mandates x join servicing.loan_accounts la on la.id = x.loan_account_id and la.lender_org_id = x.lender_org_id
     where x.status in ('draft', 'registration_pending', 'active', 'paused', 'requires_reconciliation') and la.status <> 'active'
     for update of x skip locked
  loop
    perform private.close_mandate_debits(m.id, 'loan_closed');
  end loop;
  return v_n;
end
$$;
comment on function payments.request_cancel_for_closed_loans() is
  'System only. For every live mandate of a loan the lender reported closed or foreclosed, records a cancellation request and queues it, and cancels its planned debits and unsent pre-debit notices at once. Idempotent. Returns how many cancellation requests were made.';

-- Time-based rules and the things nobody has confirmed. Returns counts.
create or replace function payments.sweep_mandates(p_draft_grace interval default interval '1 hour', p_cancel_grace interval default interval '24 hours', p_unresolved_after interval default interval '24 hours')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
                            'cancel_resent', v_resent, 'cancel_unconfirmed', v_cancel, 'unresolved', v_unresolved, 'notices_closed', v_notices);
end
$$;
comment on function payments.sweep_mandates(interval, interval, interval) is
  'System only (a periodic worker). Closes a draft the provider cannot be in the middle of being asked about (borrower-cancelled and never claimed, or abandoned with its hand-off finished: cancelled, source system; a draft whose hand-off is queued or in flight is left alone; one whose hand-off may have reached the provider becomes requires_reconciliation with a platform exception), expires active or paused mandates past their end date, queues an unacknowledged cancellation again (bounded: at most 200 a run, 48 times a mandate, 30 minutes apart), opens exceptions for a cancellation the provider has not confirmed (mandate_cancel_unconfirmed) and for an outcome that stayed unresolved (mandate_unresolved), and closes pre-debit notices that can never go out (not_needed). Idempotent. Returns counts.';

-- Mandates whose state the worker should ask the provider about: a pending registration that has stayed pending, an unknown outcome, a
-- cancellation not yet seen, and (at most 200 a call, oldest first) every active or paused mandate not looked up for 24 hours, so a revoke or
-- cancellation event that never arrived is found.
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
              when m.status in ('active', 'paused') then 'periodic_check'
              else 'registration_pending' end
    from payments.mandates m
   where case when private.invoking_role() <> 'service_role' then false
              else (m.status = 'requires_reconciliation')
                or (m.status = 'registration_pending' and m.updated_at < clock_timestamp() - p_pending_after)
                or (m.status in ('active', 'paused') and m.cancel_requested_at is not null and coalesce(m.cancel_sent_at, m.cancel_requested_at) < clock_timestamp() - p_pending_after)
                or (m.status in ('active', 'paused') and m.id in (
                      select z.id from payments.mandates z
                       where z.status in ('active', 'paused') and coalesce(z.status_checked_at, z.last_event_at, z.created_at) < clock_timestamp() - interval '24 hours'
                       order by coalesce(z.status_checked_at, z.last_event_at, z.created_at) limit 200)) end
   order by m.updated_at
$$;
comment on function payments.mandates_needing_lookup(interval) is
  'System only. Mandates whose state a worker should look up at the provider: an unknown hand-off outcome, a registration that has stayed pending, a cancellation that has not been seen, and every active or paused mandate not looked up for 24 hours (reason periodic_check, at most 200 per call, oldest first). The lookup result goes through payments.apply_mandate_lookup, which records that the mandate was looked up.';

-- ---------------------------------------------------------------------------------------------
-- 6. Debits and the notices before them
-- ---------------------------------------------------------------------------------------------
-- Planned debits and their notices, from the lender's REPORTED schedule and figures. Udofin does not present debits.
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
  v_expected bigint;
  v_why text;
  v_lead integer;
  v_due timestamptz;
  v_debit uuid;
  v_planned integer := 0;
  v_over integer := 0;
  v_late integer := 0;
  v_paid integer := 0;
  v_restated integer := 0;
begin
  if private.invoking_role() <> 'service_role' then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  if p_horizon is null or p_horizon < interval '1 hour' or p_horizon > interval '120 days' then
    raise exception 'invalid planning window' using errcode = '22023', hint = 'bad_request';
  end if;
  -- 1. What is already planned (and not yet presented to the provider) is checked against the lender's newest schedule and fresh report: an
  --    installment the report shows as paid, or that the schedule moved, removed or restated, is cancelled (and its unsent notice closed); the
  --    planning below then plans the restated one. A report that is stale or inconsistent revises nothing. The horizon does not matter here.
  for r in
    select d.id as debit_id, d.scheduled_on, d.amount_minor, m.loan_account_id, i.seq as i_seq, i.due_date as i_due, i.total_minor as i_total,
           fig.ok, fig.stale, fig.next_due_on, fig.next_due_minor
      from payments.mandates m
      join servicing.loan_accounts la on la.id = m.loan_account_id and la.lender_org_id = m.lender_org_id and la.status = 'active'
      join payments.mandate_debits d on d.mandate_id = m.id and d.lender_org_id = m.lender_org_id
      cross join lateral private.reminder_figures(m.loan_account_id) fig
      left join lateral (select x.id from servicing.schedule_snapshots x where x.loan_account_id = m.loan_account_id order by x.version desc limit 1) s on true
      left join servicing.schedule_installments i on i.snapshot_id = s.id and i.lender_org_id = d.lender_org_id and i.seq = d.installment_seq
     where m.status = 'active' and m.cancel_requested_at is null and private.feature_enabled(m.lender_org_id, 'mandates')
       and d.planned and d.status in ('scheduled', 'notified') and d.provider_debit_ref is null and d.scheduled_on >= v_today
     order by m.id, d.installment_seq
       for update of m, d skip locked
  loop
    v_why := null;
    if private.report_shows_paid(r.loan_account_id, coalesce(r.i_due, r.scheduled_on)) then
      v_why := 'paid';
    elsif r.i_seq is null or r.i_due <> r.scheduled_on then
      v_why := 'restated';
    elsif coalesce(r.ok, false) and not coalesce(r.stale, true) then
      v_expected := case when r.next_due_on = r.i_due and coalesce(r.next_due_minor, 0) > 0 then r.next_due_minor else r.i_total end;
      if v_expected is distinct from r.amount_minor then
        v_why := 'restated';
      end if;
    end if;
    if v_why is not null then
      -- Lock order: debit (held), then notice.
      update payments.pre_debit_notices n set status = 'not_needed', claimed_until = null
       where n.debit_id = r.debit_id and n.status in ('planned', 'late') and n.sent_at is null;
      update payments.mandate_debits set status = 'cancelled', rank = greatest(rank, 40) where id = r.debit_id;
      if v_why = 'paid' then
        v_paid := v_paid + 1;
      else
        v_restated := v_restated + 1;
      end if;
    end if;
  end loop;
  -- 2. What is due soon and not planned yet.
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
       and not exists (select 1 from payments.mandate_debits d
                        where d.mandate_id = m.id and d.planned and d.installment_seq = i.seq and (d.status <> 'cancelled' or d.provider_debit_ref is not null))
       and not private.report_shows_paid(m.loan_account_id, i.due_date)
     order by m.id, i.seq
       for update of m skip locked
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
  return jsonb_build_object('planned', v_planned, 'skipped_over_max', v_over, 'notices_late', v_late, 'cancelled_paid', v_paid, 'cancelled_restated', v_restated);
end
$$;
comment on function payments.plan_mandate_debits(interval) is
  'System only. For every ACTIVE mandate (no cancellation request, active loan) of a lender whose mandates switch is on, plans one debit per upcoming installment of the lender''s newest schedule (inside the mandate dates) that the lender''s own fresh, consistent report does not show as paid: the amount is the lender''s reported figure for it, or the installment as the lender''s schedule states it, never above the mandate maximum (an installment above it is not planned and the lender gets mandate_debit_exceeds_max). Each planned debit gets a pre-debit notice due the lender''s lead time before the debit date; one that is already past due is marked late and the lender gets mandate_notice_late. Before planning, a planned debit nobody presented is cancelled (and its unsent notice closed) when the fresh report shows its installment as paid (cancelled_paid) or the newest schedule or report moved, removed or restated it (cancelled_restated: the restated one is planned in the same run). A stale or inconsistent report revises nothing. Idempotent. Returns counts.';

-- The notices due now for a debit that can still happen. Every test is inside the scanned SELECT, so the limit applies to claimable notices only.
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
      join payments.mandate_debits dd on dd.id = x.debit_id and dd.lender_org_id = x.lender_org_id
      join payments.mandates mm on mm.id = x.mandate_id and mm.lender_org_id = x.lender_org_id
      join servicing.loan_accounts la on la.id = mm.loan_account_id and la.lender_org_id = mm.lender_org_id
     where x.status in ('planned', 'late') and x.sent_at is null and x.notice_due_at <= clock_timestamp() and (x.claimed_until is null or x.claimed_until < clock_timestamp())
       and dd.status in ('scheduled', 'notified') and dd.scheduled_on >= v_today
       and mm.status = 'active' and mm.cancel_requested_at is null and la.status = 'active'
       and private.feature_enabled(x.lender_org_id, 'mandates')
       and not private.report_shows_paid(la.id, dd.scheduled_on)
     order by x.notice_due_at, x.id limit p_limit for update of x skip locked
  loop
    select * into d from payments.mandate_debits y where y.id = n.debit_id;
    update payments.pre_debit_notices set claimed_until = clock_timestamp() + p_lease where id = n.id;
    notice_id := n.id; debit_id := d.id; mandate_id := d.mandate_id; borrower_id := n.borrower_id; loan_account_id := d.loan_account_id;
    scheduled_on := d.scheduled_on; amount_minor := d.amount_minor;
    return next;
  end loop;
end
$$;
comment on function payments.claim_pre_debit_notices(integer, interval) is
  'System only. The pre-debit notices that are due now for a debit that can still happen (scheduled or notified, not yet past its date, its mandate ACTIVE with no cancellation request, its loan active, the lender''s mandates switch on, and the lender''s fresh report not showing the installment as paid), leased to one worker for p_lease. Every test is inside the scanned query, so a notice that can never go out cannot hide one that can. The notice text is a fixed factual line in the app (amount and date); the database holds none.';

create or replace function payments.record_pre_debit_notice(p_notice uuid, p_state text, p_provider_ref text default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  n payments.pre_debit_notices;
  v_debit uuid;
begin
  if private.invoking_role() <> 'service_role' then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  if p_state is null or p_state not in ('accepted', 'delivered', 'failed', 'not_configured') then
    raise exception 'invalid notice result' using errcode = '22023', hint = 'bad_request';
  end if;
  select x.debit_id into v_debit from payments.pre_debit_notices x where x.id = p_notice;
  if not found then
    raise exception 'notice not found' using errcode = 'P0002';
  end if;
  -- Lock order: debit, then notice.
  perform 1 from payments.mandate_debits y where y.id = v_debit for update;
  select * into n from payments.pre_debit_notices x where x.id = p_notice for update;
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
  elsif n.status <> 'not_needed' then
    -- No channel can carry the notice: the lender is told; the debit is not presented silently. (A notice already closed as not needed needs none.)
    update payments.pre_debit_notices set status = 'late', claimed_until = null where id = n.id and sent_at is null;
    perform private.raise_exception_impl(n.lender_org_id, 'mandate_notice_late', 'warning', 'lender', jsonb_build_object('debit_id', n.debit_id::text));
  end if;
  return p_state;
end
$$;
comment on function payments.record_pre_debit_notice(uuid, text, text) is
  'System only. Records what happened to a pre-debit notice: accepted (the channel took it; the debit becomes notified), delivered (a delivery report), failed (released for a retry) or not_configured (no channel: marked late and the lender is told, unless the notice was already closed as not needed). "delivered" is never claimed without the notice having been sent.';
