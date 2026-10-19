-- =============================================================================================
-- Phase 08a, migration 917: what the borrower apps read, and the one place a bearer link may rest.
--
-- The borrower never reads these tables directly (no grants). Each function below is SECURITY DEFINER, answers only for
-- the signed-in borrower's own loan, intent or mandate (P0002 otherwise, so existence is not revealed) and hides a feature
-- whose lender switch is off. Nothing here writes a financial fact; the one table (handoff_links) only holds an ENCRYPTED,
-- expiring copy of a provider hand-off link so the worker (which holds the lender's provider credentials) can pass it to
-- the API (which does not).
--
--   1. payments.handoff_links           encrypted bearer links (payment checkout, mandate authorisation), one per subject,
--                                       expiring; store (system), take (the owning borrower), purge (system).
--   2. servicing.my_loan_schedule       the schedule exactly as the lender last reported it (no status, no allocation).
--   3. servicing.my_loan_activity       lender receipts, payment attempts (honest stage) and adjustments, newest first.
--   4. payments.my_payment_detail       one payment: purpose, amount, honest stage, destination (masked), link state.
--   5. payments.cancel_my_payment       the borrower cancels an intent that has no order at the provider yet.
--   6. payments.my_payment_options      what can be paid now, with the lender's reported amounts and approved penal text.
--   7. payments.my_mandate_options      which rails the lender's configuration offers, limits, policy, existing mandate.
--   8. payments.my_mandate_debits       planned and past debits of one mandate with the pre-debit notice state.
--
-- Error convention: SQLSTATE and hint. 42501 not authorised, P0002 not found, 22023 bad input, 55000 rule or state.
-- Forward-only. Money is integer paise. No account number, name, phone, PAN or Aadhaar is read or returned.
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- 1. The vault for bearer links
-- ---------------------------------------------------------------------------------------------
create table payments.handoff_links (
  id uuid primary key default private.uuid_v7(),
  lender_org_id uuid not null references tenancy.organizations (id) on delete restrict,
  borrower_id uuid not null references identity.borrowers (id) on delete restrict,
  subject_kind text not null check (subject_kind in ('payment_intent', 'mandate')),
  subject_id uuid not null,
  -- Authenticated encryption done by the worker before the value reaches the database: nonce || ciphertext || tag. The database cannot
  -- verify that it IS ciphertext; the worker's test does, and the associated data binds the blob to this subject so a row cannot be swapped.
  alg text not null default 'aes-256-gcm' check (alg = 'aes-256-gcm'),
  key_version text not null check (key_version ~ '^[A-Za-z0-9._-]{1,40}$'),
  ciphertext bytea not null check (octet_length(ciphertext) between 29 and 8192),
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  read_count integer not null default 0 check (read_count >= 0),
  unique (subject_kind, subject_id),
  constraint expiry_after_creation check (expires_at > created_at and expires_at <= created_at + interval '31 days')
);
create index handoff_links_lender on payments.handoff_links (lender_org_id);
create index handoff_links_borrower on payments.handoff_links (borrower_id);
create index handoff_links_expiry on payments.handoff_links (expires_at);
comment on table payments.handoff_links is
  'The provider hand-off link of a payment or a mandate authorisation is a BEARER SECRET. It is never stored in clear: the worker encrypts it (AES-256-GCM, a key outside the database, associated data naming the subject) and stores only the ciphertext here until it expires, one row per subject. Only the owning borrower can ask for it (payments.take_handoff_link) and the API decrypts it for the response. No role has table access: the table is reachable only through the three definer functions. Expired rows and rows of subjects that are no longer open are deleted by payments.purge_handoff_links. The ciphertext never appears in an audit event, an outbox payload, an error or a log. Owner: payments module.';
alter table payments.handoff_links enable row level security;
alter table payments.handoff_links force row level security;
revoke all on payments.handoff_links from public, anon, authenticated, service_role;

create or replace function private.protect_handoff_link()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (to_jsonb(new) - 'read_count') is distinct from (to_jsonb(old) - 'read_count') then
    raise exception 'a stored hand-off link can only be read, never changed' using errcode = 'P0001';
  end if;
  return new;
end
$$;
revoke all on function private.protect_handoff_link() from public;
create trigger protect before update on payments.handoff_links
  for each row execute function private.protect_handoff_link();
create trigger no_truncate before truncate on payments.handoff_links
  for each statement execute function private.forbid_truncate();

-- System only (the worker). The subject decides the lender and the borrower: the caller supplies neither. A payment intent must already have
-- its order (pending); a mandate must be waiting for the borrower (registration_pending). A repeat replaces the earlier row.
create or replace function payments.store_handoff_link(p_kind text, p_subject uuid, p_key_version text, p_ciphertext bytea, p_expires_at timestamptz)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lender uuid;
  v_borrower uuid;
  i payments.payment_intents;
  m payments.mandates;
begin
  if private.invoking_role() <> 'service_role' then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  if p_kind is null or p_kind not in ('payment_intent', 'mandate') or p_subject is null
     or p_key_version is null or p_key_version !~ '^[A-Za-z0-9._-]{1,40}$'
     or p_ciphertext is null or octet_length(p_ciphertext) not between 29 and 8192
     or p_expires_at is null or p_expires_at <= clock_timestamp() or p_expires_at > clock_timestamp() + interval '31 days' then
    raise exception 'invalid hand-off link' using errcode = '22023', hint = 'bad_request';
  end if;
  if p_kind = 'payment_intent' then
    select * into i from payments.payment_intents x where x.id = p_subject;
    if not found then
      raise exception 'subject not found' using errcode = 'P0002';
    end if;
    if i.status <> 'pending' then
      raise exception 'a payment link is kept only for a pending payment' using errcode = '55000', hint = 'intent_state_invalid';
    end if;
    v_lender := i.lender_org_id;
    v_borrower := i.borrower_id;
  else
    select * into m from payments.mandates x where x.id = p_subject;
    if not found then
      raise exception 'subject not found' using errcode = 'P0002';
    end if;
    if m.status <> 'registration_pending' then
      raise exception 'an authorisation link is kept only for a mandate waiting for the borrower' using errcode = '55000', hint = 'mandate_state_invalid';
    end if;
    v_lender := m.lender_org_id;
    v_borrower := m.borrower_id;
  end if;
  delete from payments.handoff_links h where h.subject_kind = p_kind and h.subject_id = p_subject;
  insert into payments.handoff_links (lender_org_id, borrower_id, subject_kind, subject_id, key_version, ciphertext, expires_at)
  values (v_lender, v_borrower, p_kind, p_subject, p_key_version, p_ciphertext, p_expires_at);
  perform private.write_payments_audit(v_lender, 'payments.handoff.stored', p_kind, p_subject::text, jsonb_build_object('key_version', p_key_version));
  return 'stored';
end
$$;
comment on function payments.store_handoff_link(text, uuid, text, bytea, timestamptz) is
  'System only. Keeps the ENCRYPTED hand-off link of a pending payment or a registration-pending mandate until it expires (at most 31 days). The lender and the borrower come from the subject. The audit event names the key version only.';

-- The owning borrower only. The row is returned while it has not expired and the subject is still open; every read is counted.
create or replace function payments.take_handoff_link(p_kind text, p_subject uuid)
returns table (lender_org_id uuid, key_version text, alg text, ciphertext bytea, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_borrower uuid := private.my_borrower_id();
  h payments.handoff_links;
  v_open boolean;
begin
  if (select auth.uid()) is null or v_borrower is null then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  if p_kind is null or p_kind not in ('payment_intent', 'mandate') or p_subject is null then
    raise exception 'invalid request' using errcode = '22023', hint = 'bad_request';
  end if;
  select * into h from payments.handoff_links x where x.subject_kind = p_kind and x.subject_id = p_subject and x.borrower_id = v_borrower for update;
  if not found or h.expires_at <= clock_timestamp() or not private.feature_enabled(h.lender_org_id, case p_kind when 'mandate' then 'mandates' else 'payments' end) then
    raise exception 'link not available' using errcode = 'P0002', hint = 'link_unavailable';
  end if;
  if p_kind = 'payment_intent' then
    select exists (select 1 from payments.payment_intents i where i.id = p_subject and i.status = 'pending'
                   and (i.link_expires_at is null or i.link_expires_at > clock_timestamp())) into v_open;
  else
    select exists (select 1 from payments.mandates m where m.id = p_subject and m.status = 'registration_pending'
                   and (m.handoff_expires_at is null or m.handoff_expires_at > clock_timestamp())) into v_open;
  end if;
  if not v_open then
    raise exception 'link not available' using errcode = 'P0002', hint = 'link_unavailable';
  end if;
  update payments.handoff_links set read_count = read_count + 1 where id = h.id;
  return query select h.lender_org_id, h.key_version, h.alg, h.ciphertext, h.expires_at;
end
$$;
comment on function payments.take_handoff_link(text, uuid) is
  'The signed-in borrower asks for the encrypted hand-off link of their own payment (pending, link not expired) or mandate (registration pending, hand-off not expired). Anything else is P0002 link_unavailable, whoever asks. The caller decrypts it with a key the database never sees. Returns ciphertext only.';

-- System only: expired rows, and rows whose subject is no longer open, are deleted (data minimisation). Returns how many.
create or replace function payments.purge_handoff_links()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  if private.invoking_role() <> 'service_role' then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  delete from payments.handoff_links h
   where h.expires_at <= clock_timestamp()
      or (h.subject_kind = 'payment_intent' and not exists (select 1 from payments.payment_intents i where i.id = h.subject_id and i.status = 'pending'))
      or (h.subject_kind = 'mandate' and not exists (select 1 from payments.mandates m where m.id = h.subject_id and m.status = 'registration_pending'));
  get diagnostics v_n = row_count;
  return v_n;
end
$$;
comment on function payments.purge_handoff_links() is
  'System only. Deletes hand-off links that have expired or whose payment or mandate is no longer waiting for the borrower. Run every few minutes by the worker.';

-- ---------------------------------------------------------------------------------------------
-- 2. The schedule as the lender reported it
-- ---------------------------------------------------------------------------------------------
-- Udofin allocates nothing, so there is no per-installment status: the borrower sees the lender's installments and the lender's
-- reported balance (servicing.my_loan), nothing computed. An unresolved conflict about the SCHEDULE withholds it (zero rows), as a
-- conflict about the loan report withholds the figures; the borrower is not told why.
create or replace function servicing.my_loan_schedule(p_loan uuid)
returns table (schedule_version integer, reported_as_of timestamptz, seq integer, due_date date,
               principal_minor bigint, interest_minor bigint, fees_minor bigint, total_minor bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  l servicing.loan_accounts;
  v_snap servicing.schedule_snapshots;
begin
  l := private.servicing_docs_borrower_loan(p_loan);
  if not private.feature_enabled(l.lender_org_id, 'servicing_sync') then
    raise exception 'loan not found' using errcode = 'P0002';
  end if;
  if exists (select 1 from servicing.sync_conflicts c where c.loan_account_id = l.id and c.record_type = 'schedule' and c.status <> 'resolved') then
    return;
  end if;
  select s.* into v_snap from servicing.schedule_snapshots s
   where s.loan_account_id = l.id and (s.source is null or s.source <> 'mock_lms' or private.mock_providers_allowed())
   order by s.version desc limit 1;
  if not found then
    return;
  end if;
  return query
    select v_snap.version, v_snap.reported_as_of, i.seq, i.due_date, i.principal_minor, i.interest_minor, i.fees_minor, i.total_minor
    from servicing.schedule_installments i
    where i.snapshot_id = v_snap.id and i.lender_org_id = l.lender_org_id
    order by i.seq;
end
$$;
comment on function servicing.my_loan_schedule(uuid) is
  'Borrower only. The newest schedule the lender reported for the borrower''s own loan, installment by installment, exactly as reported (due date, principal, interest, fees, total). No status or allocation: Udofin computes none. Zero rows when none was reported, when an unresolved schedule conflict withholds it, or when the lender''s servicing_sync switch is off (P0002 in that last case). Mock-source schedules count only where mock providers are allowed.';

-- ---------------------------------------------------------------------------------------------
-- 3. Activity: receipts, attempts, adjustments
-- ---------------------------------------------------------------------------------------------
-- Keyset pagination on (sort_at, entry_id). Receipts appear when the servicing_sync switch is on, attempts and adjustments when payments is on.
create or replace function servicing.my_loan_activity(p_loan uuid, p_before_at timestamptz default null, p_before_id uuid default null, p_limit integer default 30)
returns table (entry_kind text, entry_id uuid, sort_at timestamptz, occurred_on date, amount_minor bigint, state text, purpose text)
language plpgsql
stable
security definer
set search_path = ''
as $$
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
    select 'receipt'::text as src, r.id as kid, r.received_at as ts
      from servicing.lms_receipts r
     where v_sync and r.loan_account_id = l.id and r.lender_org_id = l.lender_org_id and (r.source_system <> 'mock_lms' or private.mock_providers_allowed())
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
                                    when exists (select 1 from servicing.lms_receipts rv where rv.reverses_receipt_id = r.id) then 'reversed'
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
$$;
comment on function servicing.my_loan_activity(uuid, timestamptz, uuid, integer) is
  'Borrower only. Newest first, keyset-paged on (sort_at, entry_id), at most 100 per page. lender_receipt / lender_reversal: what the lender''s LMS posted (posted, reversed, recorded), when the switch servicing_sync is on. payment_attempt: the borrower''s own payments with the honest stage from payments.my_payment (started, provider_received, lender_posted, needs_attention), or cancelled, failed or expired when the provider never reported money for them. payment_adjustment: a refund, chargeback, reversal or correction the provider verifiably reported. Amounts are integer paise as reported. No bank reference, payment mode or provider reference is returned.';

-- ---------------------------------------------------------------------------------------------
-- 4. One payment, with the destination and the link state
-- ---------------------------------------------------------------------------------------------
create or replace function payments.my_payment_detail(p_intent uuid)
returns table (intent_id uuid, loan_account_id uuid, lender_display_name text, purpose text, amount_minor bigint, intent_status text, stage text,
               created_at timestamptz, link_expires_at timestamptz, link_available boolean, cancellable boolean,
               destination_masked_ref text, provider_received_at timestamptz, lender_posted_on date)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_borrower uuid := private.my_borrower_id();
  i payments.payment_intents;
  s record;
begin
  if (select auth.uid()) is null or v_borrower is null then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  select * into i from payments.payment_intents x where x.id = p_intent and x.borrower_id = v_borrower;
  if not found or not private.feature_enabled(i.lender_org_id, 'payments') then
    raise exception 'payment not found' using errcode = 'P0002';
  end if;
  select * into s from payments.my_payment(p_intent);
  return query
    select i.id, i.loan_account_id, o.display_name, i.purpose::text, i.amount_minor, i.status::text, s.stage,
           i.created_at, i.link_expires_at,
           (i.status = 'pending' and (i.link_expires_at is null or i.link_expires_at > clock_timestamp())
            and exists (select 1 from payments.handoff_links h where h.subject_kind = 'payment_intent' and h.subject_id = i.id and h.expires_at > clock_timestamp())),
           (i.status = 'created'),
           (select sa.masked_account_ref from payments.lender_payment_configs c
              join tenancy.lender_settlement_accounts sa on sa.id = c.settlement_account_id and sa.lender_org_id = c.lender_org_id
             where c.id = i.config_id and c.lender_org_id = i.lender_org_id),
           s.provider_received_at, s.lender_posted_on
    from tenancy.organizations o where o.id = i.lender_org_id;
end
$$;
comment on function payments.my_payment_detail(uuid) is
  'Borrower only: one of the caller''s own payments (P0002 for anyone else''s, and when the lender''s payments switch is off). Purpose and amount as requested, the honest stage derived from verified provider events and the lender''s own receipts (payments.my_payment), the lender''s masked destination account, whether an unexpired payment link can be fetched, and whether the payment can still be cancelled (only while no order exists at the provider).';

-- ---------------------------------------------------------------------------------------------
-- 5. Cancel a payment that has no order yet
-- ---------------------------------------------------------------------------------------------
create or replace function payments.cancel_my_payment(p_intent uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_borrower uuid := private.my_borrower_id();
  i payments.payment_intents;
begin
  if (select auth.uid()) is null or v_borrower is null then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  select * into i from payments.payment_intents x where x.id = p_intent and x.borrower_id = v_borrower for update;
  if not found then
    raise exception 'payment not found' using errcode = 'P0002';
  end if;
  if i.status = 'cancelled' then
    return 'cancelled';
  end if;
  if i.status <> 'created' then
    raise exception 'only a payment that has no order at the provider yet can be cancelled' using errcode = '55000', hint = 'intent_not_cancellable';
  end if;
  update payments.payment_intents set status = 'cancelled' where id = i.id;
  perform private.write_payments_audit(i.lender_org_id, 'payments.intent.cancelled', 'payment_intent', i.id::text, jsonb_build_object('by', 'borrower'));
  return 'cancelled';
end
$$;
comment on function payments.cancel_my_payment(uuid) is
  'Borrower only. Cancels the caller''s own payment while it is still created (no order at the provider); repeating it answers cancelled. A payment that has an order is not cancellable here: its link expires on its own and money received on it is handled through the provider-event and reconciliation path (55000 intent_not_cancellable). The worker must look at the status before it creates an order.';

-- ---------------------------------------------------------------------------------------------
-- 6. What can be paid now
-- ---------------------------------------------------------------------------------------------
create or replace function payments.my_payment_options(p_loan uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  l servicing.loan_accounts;
  r record;
  v_cfg payments.lender_payment_configs;
  v_pol payments.lender_payment_policies;
  v_q servicing.foreclosure_quotes;
  v_pen servicing.penal_charge_texts;
  v_n integer;
  v_lender text;
  v_masked text;
  v_reason text;
  v_purposes jsonb := '[]'::jsonb;
  v_figures boolean := false;
  v_stale boolean := true;
  v_reported timestamptz;
  v_overdue boolean := false;
  v_open jsonb;
begin
  l := private.servicing_docs_borrower_loan(p_loan);
  if not private.feature_enabled(l.lender_org_id, 'payments') then
    raise exception 'loan not found' using errcode = 'P0002';
  end if;
  select o.display_name into v_lender from tenancy.organizations o where o.id = l.lender_org_id;
  select * into v_pol from payments.lender_payment_policies p where p.lender_org_id = l.lender_org_id;

  select count(*) into v_n from payments.lender_payment_configs c where c.lender_org_id = l.lender_org_id and c.status = 'active';
  if l.status <> 'active' then
    v_reason := 'loan_not_active';
  elsif v_n = 0 then
    v_reason := 'collection_target_invalid';
  elsif v_n > 1 then
    v_reason := 'config_ambiguous';
  else
    select * into v_cfg from payments.lender_payment_configs c where c.lender_org_id = l.lender_org_id and c.status = 'active';
    if not (private.validate_collection_target_impl(v_cfg.id) ->> 'ok')::boolean then
      v_reason := 'collection_target_invalid';
    else
      select sa.masked_account_ref into v_masked from tenancy.lender_settlement_accounts sa
       where sa.id = v_cfg.settlement_account_id and sa.lender_org_id = v_cfg.lender_org_id;
    end if;
  end if;

  if v_reason is null then
    select * into r from private.servicing_borrower_loans(p_loan);
    if found then
      v_figures := coalesce(r.figures_available, false);
      v_stale := coalesce(r.stale, true);
      v_reported := r.reported_as_of;
    end if;
    if v_figures and not v_stale then
      if coalesce(r.next_due_minor, 0) > 0 then
        v_purposes := v_purposes || jsonb_build_array(jsonb_build_object(
          'purpose', 'installment', 'amount_source', 'lender_reported', 'amount_minor', r.next_due_minor, 'due_on', r.next_due_on,
          'min_minor', case when coalesce(v_pol.allow_partial_payments, false) then least(v_pol.min_partial_amount_minor, r.next_due_minor) else r.next_due_minor end,
          'max_minor', r.next_due_minor));
      end if;
      if coalesce(r.total_overdue_minor, 0) > 0 then
        v_overdue := true;
        v_purposes := v_purposes || jsonb_build_array(jsonb_build_object(
          'purpose', 'overdue', 'amount_source', 'lender_reported', 'amount_minor', r.total_overdue_minor,
          'min_minor', case when coalesce(v_pol.allow_partial_payments, false) then least(v_pol.min_partial_amount_minor, r.total_overdue_minor) else r.total_overdue_minor end,
          'max_minor', r.total_overdue_minor));
      end if;
      if coalesce(v_pol.allow_part_prepayment, false) and coalesce(r.outstanding_principal_minor, 0) > 0 then
        v_purposes := v_purposes || jsonb_build_array(jsonb_build_object(
          'purpose', 'part_prepayment', 'amount_source', 'borrower_within_lender_limits',
          'min_minor', v_pol.min_part_prepayment_minor, 'max_minor', r.outstanding_principal_minor));
      end if;
    end if;
    -- A foreclosure payment equals the lender's unexpired quotation; it does not depend on the balance report.
    select * into v_q from servicing.latest_valid_quote(p_loan);
    if found then
      v_purposes := v_purposes || jsonb_build_array(jsonb_build_object(
        'purpose', 'foreclosure', 'amount_source', 'lender_quote', 'amount_minor', v_q.total_minor, 'min_minor', v_q.total_minor, 'max_minor', v_q.total_minor,
        'quote_id', v_q.id, 'valid_until', v_q.valid_until, 'flagged', v_q.total_mismatch));
    end if;
  end if;

  if v_overdue then
    select * into v_pen from servicing.penal_charge_texts t where t.lender_org_id = l.lender_org_id and t.status = 'approved';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('intent_id', i.id, 'purpose', i.purpose::text, 'status', i.status::text) order by i.created_at), '[]'::jsonb)
    into v_open from payments.payment_intents i
   where i.loan_account_id = l.id and i.borrower_id = l.borrower_id and i.status in ('created', 'pending');

  return jsonb_build_object(
    'loan_account_id', l.id, 'lender_display_name', v_lender,
    'available', v_reason is null, 'unavailable_key', v_reason, 'destination_masked_ref', v_masked,
    'figures_available', v_figures, 'stale', v_stale, 'reported_as_of', v_reported,
    'purposes', v_purposes,
    'penal_charge', case when v_pen.id is not null then jsonb_build_object('version', v_pen.version, 'sentence_en', v_pen.sentence_en, 'sentence_hi', v_pen.sentence_hi) end,
    'penal_charge_text_missing', v_overdue and v_pen.id is null,
    'open_payments', v_open);
end
$$;
comment on function payments.my_payment_options(uuid) is
  'Borrower only (P0002 for another loan and when the payments switch is off). What the borrower can pay now: the lender''s reported next installment and overdue figures (or a part the lender accepts), a part-prepayment within the lender''s limits, the amount of an unexpired lender quotation, the lender''s masked destination account, the lender''s APPROVED penal-charge sentence when something is overdue (never invented or computed: when none is approved the answer says so and the app shows nothing in its place), and the borrower''s open payments. Nothing is offered when the figures are missing, withheld or stale, or the lender''s collection target is not valid; unavailable_key then names why (loan_not_active, collection_target_invalid, config_ambiguous). Mirrors the checks of payments.request_payment, which remains the only way to create a payment.';

-- ---------------------------------------------------------------------------------------------
-- 7. What a mandate can be
-- ---------------------------------------------------------------------------------------------
create or replace function payments.my_mandate_options(p_loan uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  l servicing.loan_accounts;
  v_cfg payments.lender_payment_configs;
  v_prov payments.provider_register;
  v_pol payments.lender_mandate_policies;
  v_n integer;
  v_lender text;
  v_reason text;
  v_rails jsonb := '[]'::jsonb;
  v_rail text;
  v_lim jsonb;
  v_existing uuid;
begin
  l := private.servicing_docs_borrower_loan(p_loan);
  if not private.feature_enabled(l.lender_org_id, 'mandates') then
    raise exception 'loan not found' using errcode = 'P0002';
  end if;
  select o.display_name into v_lender from tenancy.organizations o where o.id = l.lender_org_id;
  select * into v_pol from payments.lender_mandate_policies p where p.lender_org_id = l.lender_org_id;
  select m.id into v_existing from payments.mandates m
   where m.loan_account_id = l.id and m.status in ('draft', 'registration_pending', 'active', 'paused', 'requires_reconciliation');

  select count(*) into v_n from payments.lender_payment_configs c where c.lender_org_id = l.lender_org_id and c.status = 'active';
  if l.status <> 'active' then
    v_reason := 'loan_not_active';
  elsif v_n = 0 then
    v_reason := 'collection_target_invalid';
  elsif v_n > 1 then
    v_reason := 'config_ambiguous';
  else
    select * into v_cfg from payments.lender_payment_configs c where c.lender_org_id = l.lender_org_id and c.status = 'active';
    select * into v_prov from payments.provider_register p where p.provider = v_cfg.provider;
    if not (private.validate_collection_target_impl(v_cfg.id) ->> 'ok')::boolean then
      v_reason := 'collection_target_invalid';
    elsif v_prov.provider is null or v_prov.status <> 'approved' or v_prov.kind not in ('mandate', 'payment_and_mandate') then
      v_reason := 'provider_not_mandate_capable';
    else
      foreach v_rail in array array['enach_api', 'upi_autopay'] loop
        v_lim := v_cfg.rail_limits -> v_rail;
        if v_lim is not null and (v_lim ->> 'max_mandate_amount_minor') ~ '^[0-9]{1,15}$' and jsonb_typeof(v_lim -> 'needs_afa_each_debit') = 'boolean' then
          v_rails := v_rails || jsonb_build_array(jsonb_build_object(
            'rail', v_rail,
            'max_amount_minor', least((v_lim ->> 'max_mandate_amount_minor')::bigint, coalesce(v_pol.max_amount_cap_minor, (v_lim ->> 'max_mandate_amount_minor')::bigint)),
            'needs_afa_each_debit', (v_lim ->> 'needs_afa_each_debit')::boolean));
        end if;
      end loop;
      if jsonb_array_length(v_rails) = 0 then
        v_reason := 'rail_not_configured';
      end if;
    end if;
  end if;
  if v_reason is null and v_existing is not null then
    v_reason := 'mandate_exists';
  end if;

  return jsonb_build_object(
    'loan_account_id', l.id, 'lender_display_name', v_lender,
    'available', v_reason is null, 'unavailable_key', v_reason,
    'requirement', v_pol.requirement, 'pre_debit_lead_hours', coalesce(v_pol.pre_debit_lead_hours, 48),
    'rails', v_rails, 'existing_mandate_id', v_existing);
end
$$;
comment on function payments.my_mandate_options(uuid) is
  'Borrower only (P0002 for another loan and when the mandates switch is off). Which rails the lender''s active payment configuration offers for a mandate (only rails whose limits were copied from the provider documentation are listed), the maximum amount per rail (the lower of the rail limit and the lender''s ceiling), whether the rail may ask for authentication on every debit, the lender''s mandate requirement (informational) and pre-debit notice lead time, and the loan''s existing live mandate. unavailable_key names the first reason nothing can be offered. A mock or sandbox configuration is never active without the guard. Mirrors payments.request_mandate, which remains the only way to create one.';

-- ---------------------------------------------------------------------------------------------
-- 8. Debits of one mandate
-- ---------------------------------------------------------------------------------------------
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
  if not found or not private.feature_enabled(m.lender_org_id, 'mandates') then
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
  'Borrower only: the newest 60 debits of one of the caller''s own mandates (P0002 for anyone else''s, and when the mandates switch is off) with the pre-debit notice state. A planned debit is what Udofin expects from the lender''s reported schedule; an unplanned one is what the provider reported. The return code is the provider''s own, and its class is shown only when the lender''s configuration classified it.';

-- ---------------------------------------------------------------------------------------------
-- 9. Grants
-- ---------------------------------------------------------------------------------------------
do $$
declare
  f text;
begin
  foreach f in array array[
    'servicing.my_loan_schedule(uuid)', 'servicing.my_loan_activity(uuid, timestamptz, uuid, integer)',
    'payments.take_handoff_link(text, uuid)', 'payments.my_payment_detail(uuid)', 'payments.cancel_my_payment(uuid)',
    'payments.my_payment_options(uuid)', 'payments.my_mandate_options(uuid)', 'payments.my_mandate_debits(uuid)']
  loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  foreach f in array array[
    'payments.store_handoff_link(text, uuid, text, bytea, timestamptz)', 'payments.purge_handoff_links()']
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end
$$;
