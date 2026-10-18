-- =============================================================================================
-- Phase 08a review-fix wave, area SRM (reminders): findings A10 (M35, U39), A11, A23 (M37), A57, M33, M34, M36, M38 (tests only), M39,
-- M40, M41, M42 and M43. Forward-only: nothing in migration 20261018000914 is edited, the objects below are redefined.
--
-- What changes
--   1. private.reminder_text_ok: the wording screen now refuses short links and any domain-like token (a dot straight before two letters),
--      digit runs of 8 or more once separators BETWEEN digits are removed, Devanagari digits (mapped to ASCII first) and PAN-shaped
--      tokens in any case (also spaced). It guards templates, penal-charge sentences and reasons, and hold notes (A10, M35, U39).
--   2. Hold notes: place/release_communication_hold refuse a note longer than 200 characters (the table limit) with 22023 hold_invalid
--      instead of a raw 23514 that echoes the row (A11, M43). The one true limit is 10 to 200 characters.
--   3. claim_due_reminders: the eligibility conditions that can be decided cheaply are part of the scanned query and the scan pages through
--      the candidates by key, so p_limit applies to claimable messages and one lender's held-back rows cannot starve the others (A23, M37);
--      pre-due and due-day wording is never claimed for an installment whose day has passed (M33); an overdue message must still be about
--      the oldest overdue installment of the newest report (M34); a retried message is re-checked against the approved wording, the newest
--      report and the current penal-charge text and is re-frozen when they changed (M36); the daily cap counts by the latest claim, not the
--      first (M39); every claim returns a claim token (M40).
--   4. record_reminder_attempt takes that token: a stale worker cannot overwrite a live claim (M40). place_communication_hold also stops
--      messages that are claimed but not yet sent (M40).
--   5. plan_reminders: candidates exclude every message that already exists under the same policy whatever its status, so LIMIT applies to
--      rows that can be inserted (M42); it does not plan pre-due or due-day messages for a day that has passed (M33).
--   6. release_communication_hold resumes the messages the hold suppressed that are still in the future and belong to the approved
--      policy (A57).
--   7. private.reminder_recent_payment: lender receipts count by when Udofin received them as well as by value date (value date is bounded
--      by today), and settled mandate debits count (M41).
--
-- Reasons for suppression stay on the closed list of migration 914 (the API contract and the portal wording enumerate it): a pre-due or due-day
-- message whose day has passed is suppressed 'expired' ("could not be sent in time"); an overdue message for an installment that is no longer
-- the oldest overdue one is suppressed 'paid'. No new hint codes are introduced. Nothing here claims regulatory compliance.
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- A. One column: the daily cap counts by the latest claim (M39)
-- ---------------------------------------------------------------------------------------------
alter table servicing.reminders add column last_claimed_at timestamptz;
comment on column servicing.reminders.claimed_at is
  'When the message was FIRST claimed (kept across retries). The daily cap does not use it alone: see last_claimed_at.';
comment on column servicing.reminders.last_claimed_at is
  'When the message was most recently claimed by a worker (every claim and re-claim). The daily cap counts messages by this instant (falling back to claimed_at for a message claimed before migration 20261018000923), so a retry that crosses midnight counts on the day it is tried again.';

-- Content is frozen at claim and changes only when a worker (re)claims the message before anything was accepted (a retry that finds new wording
-- or new figures re-freezes it, M36). A finished message never changes; the one way back from suppressed is a message stopped by a communication
-- hold, which resumes when the hold is released (A57).
create or replace function private.protect_reminder()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_moving text[] := array['status', 'suppress_reason', 'attempts', 'claimed_until', 'claimed_at', 'last_claimed_at', 'template_id', 'language_used', 'language_fallback',
                           'penal_text_id', 'variables', 'content_sha256', 'penal_text_sha256', 'updated_at', 'kind', 'scheduled_for'];
  v_resume boolean := old.status = 'suppressed' and new.status = 'planned' and old.suppress_reason = 'hold' and new.suppress_reason is null;
begin
  if (to_jsonb(new) - v_moving) is distinct from (to_jsonb(old) - v_moving) then
    raise exception 'a reminder keeps its loan, installment, offset and channel' using errcode = 'P0001';
  end if;
  if not v_resume and old.status in ('sent', 'failed', 'suppressed') and (new.status is distinct from old.status or new.content_sha256 is distinct from old.content_sha256) then
    raise exception 'a finished reminder does not change' using errcode = 'P0001';
  end if;
  if old.content_sha256 is not null
     and (new.content_sha256 is distinct from old.content_sha256 or new.template_id is distinct from old.template_id
          or new.variables is distinct from old.variables or new.penal_text_sha256 is distinct from old.penal_text_sha256)
     and not (old.status in ('planned', 'claimed') and new.status = 'claimed') then
    raise exception 'the content of a claimed reminder is frozen' using errcode = 'P0001';
  end if;
  return new;
end
$$;

-- ---------------------------------------------------------------------------------------------
-- B. Wording screen (A10, M35, U39)
-- ---------------------------------------------------------------------------------------------
create or replace function private.reminder_text_ok(p_text text, p_allow_placeholders boolean)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  -- U+0900 to U+097F (the Devanagari block) and the same block without the dandas and the digits (the letters and marks).
  v_dev text := chr(2304) || '-' || chr(2431);
  v_dev_letters text := chr(2304) || '-' || chr(2403) || chr(2416) || '-' || chr(2431);
  v_plain text;
  v_t text;
  v_d text;
  v_ph text;
begin
  if p_text is null or length(trim(p_text)) not between 10 and 800 then return false; end if;
  -- Plain sentence characters (Latin and Devanagari letters, digits, spaces, simple punctuation) and, when allowed, {{variables}}.
  v_plain := 'A-Za-z0-9' || v_dev || ' .,:;!?''"()/%-';
  if p_text !~ ('^[' || v_plain || ']*' || case when p_allow_placeholders then '(\{\{[a-z_]+\}\}[' || v_plain || ']*)*' else '' end || '$') then
    return false;
  end if;
  -- Lower case, and the Devanagari digits U+0966 to U+096F mapped to ASCII, so every test below sees the same digits a reader sees.
  v_t := translate(lower(p_text), '०१२३४५६७८९', '0123456789');
  -- No link and no address: a scheme, www, an e-mail sign, or a dot straight before two letters (any domain or short link: rzp.io/l/x, bit.ly,
  -- t.me, name.xyz, name.co.in, whatever the top-level domain; an abbreviation such as p.m. or e.g. is not caught).
  if v_t ~ '(https?|www\.|://|@)' or v_t ~ ('\.[a-z' || v_dev_letters || ']{2}') then return false; end if;
  -- No phone number or identifier: 8 or more digits in a row once the separators between digits (space, dot, comma, colon, semicolon,
  -- brackets, quotes, hyphen) are removed, and PAN-shaped tokens in any case (also written with a space or hyphen between the groups).
  v_d := regexp_replace(v_t, '(?<=[0-9])[ .,:;()''"-]+(?=[0-9])', '', 'g');
  if v_d ~ '[0-9]{8,}' or v_t ~ '[a-z]{5}[0-9]{4}[a-z]' or v_t ~ '\m[a-z]{5}[ -]?[0-9]{4}[ -]?[a-z]\M' then return false; end if;
  -- No promotional wording of any kind (English list; the approver checks other languages).
  if v_t ~ '\m(offer|offers|discount|cashback|reward|rewards|bonus|coupon|promo|promotion|win|prize|free|limited time|apply now|upgrade|top-up|topup|pre-approved|preapproved|eligible|refer|referral|new loan|special|deal|exclusive|congratulations|hurry|dont miss|don''t miss)\M' then return false; end if;
  -- Only the closed variable set.
  if p_allow_placeholders then
    for v_ph in select m[1] from regexp_matches(p_text, '\{\{([a-z_]+)\}\}', 'g') as m loop
      if v_ph not in ('lender_name', 'due_date', 'amount', 'penal_text') then return false; end if;
    end loop;
  elsif p_text ~ '[{}]' then
    return false;
  end if;
  return true;
end
$$;
revoke all on function private.reminder_text_ok(text, boolean) from public;
comment on function private.reminder_text_ok(text, boolean) is
  'The "service message only" screen on lender-written reminder text (wording, penal-charge sentence and reason, hold and release notes): 10 to 800 plain characters; no link or address (a scheme, www, an e-mail sign, or a dot straight before two letters, which also refuses short links and any domain whatever its top-level domain); no run of 8 or more digits once spaces, dots, commas, colons, semicolons, brackets, quotes and hyphens between digits are removed (Devanagari digits are mapped to ASCII first); no PAN-shaped token in any case, spaced or not; no promotional vocabulary (English list); only the variables lender_name, due_date, amount and penal_text. This is a screen for the shapes above, not a guarantee that a text holds no contact detail or personal data (a name or a spelled-out number is not caught): the approver reads the text. The Hindi wording is checked for the same shapes; the approver checks its meaning.';

-- ---------------------------------------------------------------------------------------------
-- C. Quiet period after a payment (M41)
-- ---------------------------------------------------------------------------------------------
create or replace function private.reminder_recent_payment(p_loan uuid, p_hours integer)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from payments.provider_payments pp
                  where pp.loan_account_id = p_loan and pp.status = any (private.payment_success_statuses()) and not pp.duplicate_capture
                    and coalesce(pp.captured_at, pp.created_at) >= now() - make_interval(hours => p_hours))
      -- A lender receipt counts when it was posted recently (value date, never in the future) OR when Udofin received it recently: a lender can
      -- report today a payment made days ago while its balance report still shows the installment due.
      or exists (select 1 from servicing.lms_receipts r
                  where r.loan_account_id = p_loan and r.kind = 'receipt'
                    and (r.received_at >= now() - make_interval(hours => p_hours)
                         or r.value_date between (now() at time zone 'Asia/Kolkata')::date - ceil(p_hours / 24.0)::integer and (now() at time zone 'Asia/Kolkata')::date)
                    and not exists (select 1 from servicing.lms_receipts rv where rv.reverses_receipt_id = r.id))
      -- A settled UPI AutoPay or eNACH debit writes neither a provider payment nor a lender receipt.
      or exists (select 1 from payments.mandate_debits d
                  where d.loan_account_id = p_loan and d.status = 'settled' and d.updated_at >= now() - make_interval(hours => p_hours))
$$;
revoke all on function private.reminder_recent_payment(uuid, integer) from public;
comment on function private.reminder_recent_payment(uuid, integer) is
  'True when a payment for the loan was verified or posted in the last p_hours hours (do not remind someone who has just paid): a verified provider payment (captured, paid or succeeded, not a duplicate capture); a lender receipt that was not reversed, by its value date (in the last p_hours rounded up to days, never later than today) or by when Udofin received it; a settled mandate debit (by its last update). Migration 20261018000923 added the received-at test, the future bound and the mandate debits.';

-- ---------------------------------------------------------------------------------------------
-- D. Holds: note limits, claimed messages, resuming (A11, M43, M40, A57)
-- ---------------------------------------------------------------------------------------------
create or replace function servicing.place_communication_hold(p_loan uuid, p_reason text, p_note text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  l servicing.loan_accounts;
  v_id uuid;
begin
  select * into l from servicing.loan_accounts la
   where la.id = p_loan and la.lender_org_id in (select private.orgs_with_permission('reminder.policy.manage'));
  if v_uid is null or not found then
    raise exception 'loan not found' using errcode = 'P0002';
  end if;
  perform private.require_aal2();
  -- The note is 10 to 200 characters (the table limit) of plain service text.
  if p_reason is null or p_reason not in ('complaint', 'hardship', 'dispute', 'lender_instruction', 'borrower_request', 'legal')
     or (p_note is not null and (length(p_note) > 200 or not private.reminder_text_ok(p_note, false))) then
    raise exception 'invalid hold' using errcode = '22023', hint = 'hold_invalid';
  end if;
  begin
    insert into servicing.communication_holds (lender_org_id, loan_account_id, reason, note, placed_by)
    values (l.lender_org_id, l.id, p_reason, p_note, v_uid)
    returning id into v_id;
  exception when unique_violation then
    raise exception 'the loan already has an active hold' using errcode = '23505', hint = 'hold_active';
  end;
  -- Planned messages and messages a worker has claimed but not yet reported as sent: a hold placed after the claim stops them too.
  update servicing.reminders set status = 'suppressed', suppress_reason = 'hold', claimed_until = null
   where loan_account_id = l.id and status in ('planned', 'claimed');
  perform private.servicing_audit(l.lender_org_id, 'reminder.hold.placed', 'loan_account', l.id::text, jsonb_build_object('hold_id', v_id, 'reason', p_reason));
  return v_id;
end
$$;
comment on function servicing.place_communication_hold(uuid, text, text) is
  'reminder.policy.manage of the lender, aal2. Pauses reminders for one loan (complaint, hardship, dispute, lender_instruction, borrower_request, legal) and suppresses the messages still planned and those claimed but not yet reported as sent (hold). One active hold per loan (23505 hold_active). The borrower can still pay. The optional note is 10 to 200 characters of plain service text (private.reminder_text_ok); anything else, including a note over 200 characters, answers 22023 hold_invalid. The note is not written to the audit log.';

create or replace function servicing.release_communication_hold(p_hold uuid, p_note text default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  h servicing.communication_holds;
  v_resumed integer;
begin
  select * into h from servicing.communication_holds x
   where x.id = p_hold and x.lender_org_id in (select private.orgs_with_permission('reminder.policy.manage'));
  if v_uid is null or not found then
    raise exception 'hold not found' using errcode = 'P0002';
  end if;
  perform private.require_aal2();
  if h.released_at is not null then
    raise exception 'the hold is already released' using errcode = '55000', hint = 'already_released';
  end if;
  if p_note is not null and (length(p_note) > 200 or not private.reminder_text_ok(p_note, false)) then
    raise exception 'invalid note' using errcode = '22023', hint = 'hold_invalid';
  end if;
  update servicing.communication_holds set released_by = v_uid, released_at = clock_timestamp(), release_note = p_note where id = h.id;
  -- Messages the hold stopped that are still to come (scheduled after this moment) and belong to the approved policy resume. A message whose
  -- time passed during the hold stays suppressed: the hold stopped it, and nothing is sent late because a hold ended.
  update servicing.reminders x set status = 'planned', suppress_reason = null
   where x.loan_account_id = h.loan_account_id and x.lender_org_id = h.lender_org_id and x.status = 'suppressed' and x.suppress_reason = 'hold'
     and x.scheduled_for > clock_timestamp()
     and exists (select 1 from servicing.reminder_policies p where p.id = x.policy_id and p.lender_org_id = x.lender_org_id and p.status = 'approved');
  get diagnostics v_resumed = row_count;
  perform private.servicing_audit(h.lender_org_id, 'reminder.hold.released', 'loan_account', h.loan_account_id::text, jsonb_build_object('hold_id', h.id, 'resumed', v_resumed));
  return 'released';
end
$$;
comment on function servicing.release_communication_hold(uuid, text) is
  'reminder.policy.manage of the lender, aal2. Releases the hold. The optional note is 10 to 200 characters of plain service text (22023 hold_invalid otherwise). Messages the hold suppressed (reason hold) that are scheduled after the release and belong to the approved policy go back to planned and are claimed in their window like any other (every claim-time check still applies); messages whose time passed during the hold stay suppressed. New messages are planned by the planner as before.';

-- ---------------------------------------------------------------------------------------------
-- E. Planning (M42, M33)
-- ---------------------------------------------------------------------------------------------
create or replace function servicing.plan_reminders(p_horizon interval default interval '3 days', p_limit integer default 5000)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_params record;
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_n integer;
begin
  if private.invoking_role() <> 'service_role' then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  if p_horizon is null or p_horizon < interval '1 hour' or p_horizon > interval '14 days' or p_limit is null or p_limit not between 1 and 50000 then
    raise exception 'invalid planning window' using errcode = '22023', hint = 'bad_request';
  end if;
  select * into v_params from private.reminder_params();
  insert into servicing.reminders (lender_org_id, loan_account_id, borrower_id, policy_id, installment_seq, due_date, offset_days, channel, scheduled_for, status, suppress_reason)
  select q.lender_org_id, q.loan_id, q.borrower_id, q.policy_id, q.seq, q.due_date, q.o, q.ch, q.scheduled_for,
         case when q.ch = 'sms' then 'suppressed' else 'planned' end,
         case when q.ch = 'sms' then 'sms_not_configured' end
  from (
    select la.id as loan_id, la.lender_org_id, la.borrower_id, pol.id as policy_id, i.seq, i.due_date, off.o, ch.c as ch,
           ((i.due_date + off.o)::timestamp + greatest(pol.window_from, v_params.window_from)) at time zone 'Asia/Kolkata' as scheduled_for
    from servicing.reminder_policies pol
    join servicing.loan_accounts la on la.lender_org_id = pol.lender_org_id and la.status = 'active'
    cross join lateral private.reminder_figures(la.id) fig
    join lateral (select s.id from servicing.schedule_snapshots s where s.loan_account_id = la.id order by s.version desc limit 1) snap on true
    join servicing.schedule_installments i on i.snapshot_id = snap.id and i.lender_org_id = la.lender_org_id
      and i.due_date between v_today - 91 and v_today + 31 + ceil(extract(epoch from p_horizon) / 86400)::integer
    cross join lateral (
      select o from unnest(pol.offsets_days) o
      union
      select w from generate_series(coalesce((select max(x) from unnest(pol.offsets_days) x where x > 0), 0) + 7, 90, 7) w where pol.overdue_weekly
    ) off (o)
    cross join lateral unnest(pol.channels) ch (c)
    where pol.status = 'approved'
      and greatest(pol.window_from, v_params.window_from) < least(pol.window_to, v_params.window_to)
      and private.feature_enabled(pol.lender_org_id, 'reminders') and private.feature_enabled(pol.lender_org_id, 'servicing_sync')
      -- Pre-due and due-day wording is only planned for a day that has not passed (an installment already past due is talked about only by the
      -- overdue path, with the lender's penal-charge sentence); overdue messages only for the oldest overdue installment of a consistent, fresh report.
      and ((off.o <= 0 and i.due_date >= v_today)
           or (off.o > 0 and fig.ok and not fig.stale and coalesce(fig.total_overdue_minor, 0) > 0 and coalesce(fig.days_past_due, 0) > 0
               and i.due_date = (fig.reported_as_of at time zone 'Asia/Kolkata')::date - fig.days_past_due))
  ) q
  where q.scheduled_for between now() - interval '48 hours' and now() + p_horizon
    -- A candidate is a message that does not exist yet: not under this policy in any state (a suppressed row of this policy stays as it is; the
    -- hold case is resumed by release_communication_hold), and not under an earlier policy unless that one was suppressed (the new policy plans
    -- its own). LIMIT therefore applies to rows that can be inserted.
    and not exists (select 1 from servicing.reminders x
                     where x.loan_account_id = q.loan_id and x.installment_seq = q.seq and x.offset_days = q.o and x.channel = q.ch
                       and (x.policy_id = q.policy_id or x.status <> 'suppressed'))
  order by q.scheduled_for, q.loan_id, q.seq, q.o, q.ch
  limit p_limit
  on conflict (loan_account_id, installment_seq, offset_days, channel, policy_id) do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end
$$;
comment on function servicing.plan_reminders(interval, integer) is
  'System only (a periodic worker). Plans the reminders that fall due within the horizon, and those up to 48 hours late, for lenders whose reminders and servicing_sync switches are on and that have an approved policy: offsets from each installment of the newest schedule, the weekly overdue tail (up to 90 days past due), at the start of the effective window (the policy window narrowed by the platform window). Pre-due and due-day messages are planned only for a due date that has not passed; overdue messages only for the oldest overdue installment of a loan whose newest report is consistent and fresh. Idempotent. sms is planned only as a suppressed placeholder. A message that already exists under the same policy is never a candidate (whatever its status), so the limit applies to rows that can be inserted. Returns how many rows were added.';

-- ---------------------------------------------------------------------------------------------
-- F. Claiming and recording (A23, M33, M34, M36, M37, M39, M40)
-- ---------------------------------------------------------------------------------------------
-- The return type gains claim_token, so the function is dropped and created again (grants restated below).
drop function servicing.claim_due_reminders(integer, interval);
create function servicing.claim_due_reminders(p_limit integer default 100, p_lease interval default interval '10 minutes')
returns table (reminder_id uuid, lender_org_id uuid, loan_account_id uuid, borrower_id uuid, channel text, kind text, content_sha256 text, claim_token integer)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_params record;
  v_now timestamptz := clock_timestamp();
  v_today date := (clock_timestamp() at time zone 'Asia/Kolkata')::date;
  v_clock timestamptz;
  r servicing.reminders;
  pol servicing.reminder_policies;
  l servicing.loan_accounts;
  fig record;
  tpl servicing.reminder_templates;
  pen servicing.penal_charge_texts;
  v_pen_id uuid;
  v_max integer;
  v_why text;
  v_lang text;
  v_fallback boolean;
  v_amount bigint;
  v_vars jsonb;
  v_sentence text;
  v_text text;
  v_n integer;
  v_claimed integer := 0;
  v_seen integer;
  v_after_at timestamptz := '-infinity';
  v_after_id uuid := '00000000-0000-0000-0000-000000000000';
  v_page constant integer := 200;
begin
  if private.invoking_role() <> 'service_role' then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  if p_limit is null or p_limit not between 1 and 1000 or p_lease is null or p_lease < interval '1 minute' or p_lease > interval '1 hour' then
    raise exception 'invalid claim request' using errcode = '22023', hint = 'bad_request';
  end if;
  select * into v_params from private.reminder_params();
  update servicing.reminders x set status = 'suppressed', suppress_reason = 'expired'
   where x.status = 'planned' and x.scheduled_for < v_now - interval '48 hours';
  update servicing.reminders x set status = 'failed'
   where x.status = 'claimed' and x.claimed_until < v_now and x.attempts >= 3;
  v_clock := private.reminder_window_clock();
  -- A lender window only narrows the platform window: when that is closed, no lender window is open.
  if not private.reminder_in_window(v_clock, v_params.window_from, v_params.window_to) then return; end if;
  -- The scan pages through the candidates by (scheduled_for, id) and goes on until p_limit messages are claimed or the candidates run out, so
  -- messages that are held back (stale or inconsistent report, a later installment, the daily cap) never use up the limit. The window and the
  -- lender's switches are decided inside the query.
  loop
    exit when v_claimed >= p_limit;
    v_seen := 0;
    for r in
      select x.* from servicing.reminders x
        join servicing.reminder_policies pp on pp.id = x.policy_id and pp.lender_org_id = x.lender_org_id
       where (x.scheduled_for, x.id) > (v_after_at, v_after_id)
         and x.scheduled_for <= v_now
         and (x.status = 'planned' or (x.status = 'claimed' and x.claimed_until < v_now and x.attempts < 3))
         and private.reminder_in_window(v_clock, greatest(pp.window_from, v_params.window_from), least(pp.window_to, v_params.window_to))
         and private.feature_enabled(x.lender_org_id, 'reminders') and private.feature_enabled(x.lender_org_id, 'servicing_sync')
       order by x.scheduled_for, x.id
       limit v_page
       for update of x skip locked
    loop
      v_seen := v_seen + 1;
      v_after_at := r.scheduled_for;
      v_after_id := r.id;
      v_why := null;
      select * into pol from servicing.reminder_policies p where p.id = r.policy_id;
      select * into l from servicing.loan_accounts la where la.id = r.loan_account_id;
      if pol.status <> 'approved' then
        v_why := 'policy_retired';
      elsif l.status <> 'active' then
        v_why := 'loan_closed';
      elsif exists (select 1 from servicing.communication_holds h where h.loan_account_id = r.loan_account_id and h.released_at is null) then
        v_why := 'hold';
      elsif private.reminder_recent_payment(r.loan_account_id, v_params.suppress_hours) then
        v_why := 'recent_payment';
      elsif r.kind <> 'overdue' and r.due_date < v_today then
        -- The installment's day has passed: pre-due and due-day wording ("is due", "is due today") would be false. An overdue installment is
        -- talked about only by the overdue path, with the lender's penal-charge sentence.
        v_why := 'expired';
      end if;
      if v_why is null then
        select * into fig from private.reminder_figures(r.loan_account_id);
        -- No consistent, fresh report: nothing is claimed (an old figure could dun someone who has paid). It stays planned and expires if no report comes.
        if not coalesce(fig.ok, false) or fig.stale then continue; end if;
        if fig.reported_status <> 'active' then
          v_why := 'loan_closed';
        elsif r.kind = 'overdue' then
          if coalesce(fig.total_overdue_minor, 0) <= 0 or coalesce(fig.days_past_due, 0) <= 0 then
            v_why := 'nothing_overdue';
          elsif r.due_date <> (fig.reported_as_of at time zone 'Asia/Kolkata')::date - fig.days_past_due then
            -- The message was planned for an installment that is no longer the oldest overdue one (it was paid): the amount shown would belong
            -- to a later installment under this one's date.
            v_why := 'paid';
          end if;
          v_amount := fig.total_overdue_minor;
        else
          if fig.next_due_on is null or coalesce(fig.next_due_minor, 0) <= 0 then
            v_why := 'nothing_due';
          elsif r.due_date < fig.next_due_on then
            v_why := 'paid';
          elsif r.due_date > fig.next_due_on then
            continue;
          elsif coalesce(fig.days_past_due, 0) > 0 then
            -- The lender reports an overdue amount on this loan: while it is overdue only the overdue path speaks. Held back, not dropped.
            continue;
          end if;
          v_amount := fig.next_due_minor;
        end if;
      end if;
      -- The lender's CURRENT approved penal-charge sentence, verbatim; none means no overdue message and an exception for the lender.
      if v_why is null and r.kind = 'overdue' then
        select * into pen from servicing.penal_charge_texts t where t.lender_org_id = r.lender_org_id and t.status = 'approved';
        if not found then
          v_why := 'penal_text_missing';
          perform private.raise_exception_impl(r.lender_org_id, 'penal_text_missing', 'warning', 'lender', jsonb_build_object('lender_org_id', r.lender_org_id::text));
        end if;
      end if;
      if v_why is null then
        -- One loan at a time, so two workers cannot both take the second message of the day. Messages count by the day they were last claimed.
        perform pg_advisory_xact_lock(hashtextextended('reminder_cap:' || r.loan_account_id::text, 0));
        v_max := least(pol.max_per_day, v_params.max_per_day);
        select count(*) into v_n from (
          select distinct x.installment_seq, x.offset_days from servicing.reminders x
           where x.loan_account_id = r.loan_account_id and coalesce(x.last_claimed_at, x.claimed_at) is not null
             and (coalesce(x.last_claimed_at, x.claimed_at) at time zone 'Asia/Kolkata')::date = v_today
             and not (x.installment_seq = r.installment_seq and x.offset_days = r.offset_days)) q;
        if v_n >= v_max then continue; end if;
      end if;
      -- The wording is looked up on every claim, not only the first: a retry must not reuse wording that was retired.
      if v_why is null then
        select coalesce((select 'hi' from identity.borrowers b where b.id = r.borrower_id and left(b.preferred_language, 2) = 'hi'), 'en') into v_lang;
        v_fallback := false;
        if v_lang = 'hi' then
          select * into tpl from servicing.reminder_templates t
           where t.lender_org_id = r.lender_org_id and t.kind = r.kind and t.language = 'hi' and t.status = 'approved';
          if not found or (r.kind = 'overdue' and pen.sentence_hi is null) then v_lang := 'en'; v_fallback := true; end if;
        end if;
        if v_lang = 'en' then
          select * into tpl from servicing.reminder_templates t
           where t.lender_org_id = r.lender_org_id and t.kind = r.kind and t.language = 'en' and t.status = 'approved';
          if not found then v_why := 'template_missing'; end if;
        end if;
      end if;
      if v_why is not null then
        update servicing.reminders x set status = 'suppressed', suppress_reason = v_why where x.id = r.id;
        continue;
      end if;
      v_pen_id := null;
      if r.kind = 'overdue' then v_pen_id := pen.id; end if;
      v_sentence := case when r.kind = 'overdue' then case when v_lang = 'hi' then pen.sentence_hi else pen.sentence_en end end;
      v_vars := jsonb_build_object('due_date', r.due_date::text, 'amount_minor', v_amount,
                                   'lender_name', (select o.display_name from tenancy.organizations o where o.id = r.lender_org_id));
      if r.content_sha256 is null or r.template_id is distinct from tpl.id or r.language_used is distinct from v_lang
         or r.variables is distinct from v_vars or r.penal_text_id is distinct from v_pen_id then
        -- First claim, or a retry that finds other approved wording, other approved penal-charge text or other figures than the ones frozen:
        -- freeze again from what is approved and reported now (the attempt is counted; the delivery log keeps the hash of every attempt).
        v_text := private.render_reminder(tpl.body, v_vars, v_sentence);
        update servicing.reminders x set
          status = 'claimed', attempts = x.attempts + 1, claimed_until = v_now + p_lease, claimed_at = coalesce(x.claimed_at, v_now), last_claimed_at = v_now,
          template_id = tpl.id, language_used = v_lang, language_fallback = v_fallback, penal_text_id = v_pen_id,
          variables = v_vars, content_sha256 = encode(sha256(convert_to(v_text, 'UTF8')), 'hex'),
          penal_text_sha256 = case when v_sentence is not null then encode(sha256(convert_to(v_sentence, 'UTF8')), 'hex') end
         where x.id = r.id
         returning x.* into r;
      else
        update servicing.reminders x set status = 'claimed', attempts = x.attempts + 1, claimed_until = v_now + p_lease,
          claimed_at = coalesce(x.claimed_at, v_now), last_claimed_at = v_now
         where x.id = r.id
         returning x.* into r;
      end if;
      reminder_id := r.id; lender_org_id := r.lender_org_id; loan_account_id := r.loan_account_id; borrower_id := r.borrower_id;
      channel := r.channel; kind := r.kind; content_sha256 := r.content_sha256; claim_token := r.attempts;
      return next;
      v_claimed := v_claimed + 1;
      exit when v_claimed >= p_limit;
    end loop;
    exit when v_seen < v_page;
  end loop;
end
$$;
revoke all on function servicing.claim_due_reminders(integer, interval) from public;
grant execute on function servicing.claim_due_reminders(integer, interval) to service_role;
comment on function servicing.claim_due_reminders(integer, interval) is
  'System only. Claims up to p_limit due reminders for a worker (skip locked, a lease of p_lease, at most 3 attempts) and freezes what each says; the scan pages through the candidates until p_limit are claimed, so held-back messages do not use up the limit. Only inside the effective window (08:00 to 19:00 IST by default, narrowed by the lender policy) and for lenders whose reminders and servicing_sync switches are on; otherwise the message waits for the next window. A message is suppressed, with its reason, when the policy was retired, the loan is closed, a hold is active, a payment was verified or posted in the quiet period (48 hours by default; lender receipts, provider payments and settled mandate debits count), the day of a pre-due or due-day message has passed (expired), nothing is due or overdue per the lender''s newest report, an overdue message is no longer about the oldest overdue installment (paid), no approved wording exists, or (overdue) the lender has no approved penal-charge text: then the lender gets a penal_text_missing exception and NOTHING is invented. Without a consistent, fresh lender report nothing is claimed; while the report shows an overdue amount, pre-due and due-day messages wait. Every claim, including a retry, looks up the approved wording and penal-charge text and the reported figures again and freezes the message again when they differ from what was frozen. At most max_per_day distinct messages per loan per IST day, counted by the latest claim (the same message on several channels counts once). Returns the claimed rows without their text (the borrower reads the message in the app) and claim_token, which the worker must hand back to record_reminder_attempt.';

-- The worker reports what happened. send: accepted (the channel took it: for in_app, the message is in the inbox), failed (retried up to 3 times with
-- a delay) or not_configured (the channel has no provider: the message is suppressed, never reported as sent). delivery_report: delivered or failed,
-- from a provider report only. A duplicate report answers 'duplicate'. p_claim is the claim_token of the claim the report is about (M40).
drop function servicing.record_reminder_attempt(uuid, text, text, text, text);
create function servicing.record_reminder_attempt(
  p_reminder uuid, p_state text, p_source text, p_provider_ref text default null, p_error_class text default null, p_claim integer default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  r servicing.reminders;
begin
  if private.invoking_role() <> 'service_role' then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  if p_source is null or p_source not in ('send', 'delivery_report') or p_state is null
     or (p_source = 'send' and p_state not in ('accepted', 'failed', 'not_configured'))
     or (p_source = 'delivery_report' and p_state not in ('delivered', 'failed'))
     or (p_state = 'failed' and p_error_class is null) or (p_state <> 'failed' and p_error_class is not null)
     or (p_claim is not null and (p_source <> 'send' or p_claim not between 1 and 10)) then
    raise exception 'invalid attempt' using errcode = '22023', hint = 'bad_request';
  end if;
  select * into r from servicing.reminders x where x.id = p_reminder for update;
  if not found then
    raise exception 'reminder not found' using errcode = 'P0002';
  end if;
  -- A send report is accepted only for the claim it is about: when a lease ran out and another worker claimed the message, the first worker's
  -- late report no longer applies (its token is the old attempt number).
  if p_source = 'send' and (r.status <> 'claimed' or r.content_sha256 is null or (p_claim is not null and p_claim <> r.attempts)) then
    raise exception 'the reminder is not claimed' using errcode = '55000', hint = 'not_claimed';
  end if;
  if p_source = 'delivery_report' and r.status <> 'sent' then
    raise exception 'the reminder was not sent' using errcode = '55000', hint = 'not_sent';
  end if;
  if r.channel = 'sms' and p_state <> 'not_configured' then
    raise exception 'sms has no provider' using errcode = '55000', hint = 'sms_not_configured';
  end if;
  begin
    insert into servicing.reminder_deliveries (reminder_id, lender_org_id, channel, state, source, provider_ref, error_class, content_sha256, penal_text_sha256)
    values (r.id, r.lender_org_id, r.channel, p_state, p_source, p_provider_ref, p_error_class, r.content_sha256, r.penal_text_sha256);
  exception when unique_violation then
    return 'duplicate';
  end;
  if p_source = 'send' then
    if p_state = 'accepted' then
      update servicing.reminders set status = 'sent', claimed_until = null where id = r.id;
    elsif p_state = 'not_configured' then
      update servicing.reminders set status = 'suppressed', suppress_reason = 'channel_not_configured', claimed_until = null where id = r.id;
    elsif r.attempts >= 3 then
      update servicing.reminders set status = 'failed', claimed_until = null where id = r.id;
    else
      update servicing.reminders set status = 'planned', claimed_until = null, scheduled_for = clock_timestamp() + make_interval(mins => 15 * r.attempts) where id = r.id;
    end if;
  end if;
  return p_state;
end
$$;
revoke all on function servicing.record_reminder_attempt(uuid, text, text, text, text, integer) from public;
grant execute on function servicing.record_reminder_attempt(uuid, text, text, text, text, integer) to service_role;
comment on function servicing.record_reminder_attempt(uuid, text, text, text, text, integer) is
  'System only. Records an attempt in the append-only delivery log with the hash of the wording that was sent. send/accepted: the channel took the message (reminder sent; NOT proof of delivery); send/failed: retried after 15 minutes times the attempt, at most 3 attempts, then failed; send/not_configured: the channel has no provider (suppressed channel_not_configured, never sent); delivery_report/delivered or failed: only from a provider report, only for a sent reminder. A repeated report answers duplicate. An sms attempt can only be not_configured. p_claim is the claim_token that claim_due_reminders returned for this claim: when it is given (send only) and the message has been claimed again since (another attempt number), the report is refused with 55000 not_claimed and changes nothing. A message that a hold stopped after the claim is no longer claimed, so its report is refused the same way. Omitting p_claim keeps the earlier behaviour (no stale-claim check): the worker is expected to pass it.';
