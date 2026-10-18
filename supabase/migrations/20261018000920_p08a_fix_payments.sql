-- =============================================================================================
-- Phase 08a review-fix wave, payments (key SP): provider events, payments, the exception queue and the borrower read functions.
-- Forward-only. Redefines only functions of the payments events/intents/links area (migrations 913 and 917); no signature changes, so
-- every grant stays as it was. Findings: M22-M32, A0, A9, A28, A31, A50, A56, U27-U36 (U0 and U56 are the same defect as A28).
--
--   1. Identity is scoped to the lender (A28, M28, U0, U56, A31): the replay store has one namespace per payment configuration, provider
--      events are unique per (provider, lender, event id), provider payments per (provider, lender, payment ref), provider order
--      references per (provider, lender, order ref); a receipt points only at an event of its own lender (composite key); every lookup in
--      ingest and apply filters by lender.
--   2. A verified provider event can never turn a captured payment into a non-success row, a capture is never dropped for a stale rank,
--      a second capture on one order is detected whenever it arrives, a refund or chargeback is booked against the payment it names
--      (never "the first one"), payment-kind refund/dispute/return statuses open an exception instead of overwriting the row, and a
--      status the table cannot store never becomes a check violation (M22-M26, M30, A50).
--   3. request_payment refuses a payment that the lender's figures cannot yet reflect, and overlapping purposes (M27); an intent whose
--      attempts all failed expires and frees its slot (M23); a foreclosure link never outlives its quotation (M31); a cancelled intent
--      whose order the worker created anyway leaves a visible platform exception (U31); the borrower's stage honours refunds (M32).
--   4. Hand-off links: withdrawn when the configuration is suspended or invalid, a mandate cancel was asked for, money is on the
--      intent or the loan is no longer active (A0, A56, U27-U29); DB-side defence in depth for the vault (U34, U35).
--   5. Exception evidence and notes are screened for personal data and a fixed label shape is required (A9, M29).
--   6. my_payment_options does not offer what request_payment would refuse (U30 payments half) and my_loan_activity fails closed on a
--      disputed receipt like the schedule does (U36).
--
-- Not done here (other areas): suspend/revoke of a configuration does not cancel its open intents (accounts area); the normaliser and the
-- callback receiver must carry the parent payment reference of a refund or chargeback (event key parentPaymentRef).
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- 0. Evidence and notes: a fixed label shape, no personal data (A9, M29)
-- ---------------------------------------------------------------------------------------------
-- One evidence element: either the uuid of a record, or a short reference (a letter-led code with up to three dotted/dashed parts, at
-- least one digit, e.g. RC-SAMPLE-3, pay_1b, TKT-100). Refused: a run of 9 or more digits once separators are removed (phone, Aadhaar,
-- account number, long ids), a PAN shape, a web address. Names cannot be detected; the fixed shape (a code with a number in it) is the
-- control, and "evidence is an id or a code" is what the screen asks of the person.
create or replace function private.evidence_label_ok(p_label text)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select p_label is not null and (
    p_label ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or (
      length(p_label) between 3 and 64
      and p_label ~ '^[A-Za-z][A-Za-z0-9]{1,11}([._:/#-][A-Za-z0-9]{1,30}){0,3}$'
      and p_label ~ '[0-9]'
      and regexp_replace(p_label, '[^A-Za-z0-9]', '', 'g') !~ '[0-9]{9}'
      and regexp_replace(p_label, '[^A-Za-z0-9]', '', 'g') !~* '[A-Z]{5}[0-9]{4}[A-Z]'
      and p_label !~* '^www[.]'
      and p_label !~* '[a-z0-9][.](com|in|org|net|io|co|me|app|ly|link|gov|edu|info|biz|xyz)([/#:]|$)'
    )
  )
$$;
revoke all on function private.evidence_label_ok(text) from public;
comment on function private.evidence_label_ok(text) is
  'One piece of exception evidence: a record uuid, or a short letter-led code that contains a digit and no run of 9 or more digits (separators removed), no PAN shape and no web address. Never a sentence, so a name or a number cannot be written as evidence.';

create or replace function private.evidence_labels_ok(p_evidence jsonb)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select p_evidence is not null and jsonb_typeof(p_evidence) = 'array' and jsonb_array_length(p_evidence) between 1 and 10
    and not exists (
      select 1 from jsonb_array_elements(p_evidence) e
      where jsonb_typeof(e) <> 'string' or not private.evidence_label_ok(e #>> '{}'))
$$;
comment on function private.evidence_labels_ok(jsonb) is
  'A list of 1 to 10 evidence elements, each passing private.evidence_label_ok (a record uuid or a short code; no personal data shapes).';

-- A note on an exception: at most 500 characters, no run of 9 or more digits once spaces and separators are removed (a phone, an Aadhaar or an
-- account number written with spaces or dashes), no PAN shape, no e-mail address and no web address. (onboarding.reject_unsafe_text, which
-- also runs on the column, catches secrets and the exact 10 and 12 digit shapes.)
create or replace function private.exception_note_ok(p_note text)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select p_note is null or (
    length(p_note) <= 500
    and regexp_replace(p_note, '[^A-Za-z0-9]', '', 'g') !~ '[0-9]{9}'
    and regexp_replace(p_note, '[^A-Za-z0-9]', '', 'g') !~* '[A-Z]{5}[0-9]{4}[A-Z]'
    and p_note !~ '@'
    and p_note !~* '(https?://|ftp://|www[.])'
    and p_note !~* '[a-z0-9][.](com|in|org|net|io|co|me|app|ly|link|gov|edu|info|biz|xyz)([/#:?]|$|[[:space:]])')
$$;
revoke all on function private.exception_note_ok(text) from public;
comment on function private.exception_note_ok(text) is
  'True when a note is absent or short (500 characters) and carries no run of 9 or more digits (spaces and separators removed), no PAN shape, no e-mail and no web address.';

-- The tightened check applies to NEW rows only: the old column check is replaced by NOT VALID ones, so rows that were stored under the old
-- rule stay readable and a dump restores them (the append-only history is never rewritten).
alter table payments.reconciliation_exception_events drop constraint reconciliation_exception_events_evidence_check;
alter table payments.reconciliation_exception_events
  add constraint reconciliation_exception_events_evidence_screened check (evidence is null or private.evidence_labels_ok(evidence)) not valid,
  add constraint reconciliation_exception_events_note_screened check (note is null or private.exception_note_ok(note)) not valid;

-- ---------------------------------------------------------------------------------------------
-- 1. Identity scoped to the lender (A28, M28, U0, U56, A31)
-- ---------------------------------------------------------------------------------------------
alter table payments.provider_events drop constraint provider_events_provider_provider_event_id_key;
alter table payments.provider_events
  add constraint provider_events_lender_event_key unique (provider, lender_org_id, provider_event_id),
  add constraint provider_events_id_lender_key unique (id, lender_org_id),
  add column parent_payment_ref text check (parent_payment_ref is null or (length(parent_payment_ref) between 1 and 200 and parent_payment_ref ~ '^[A-Za-z0-9._:=+/-]+$')),
  add constraint provider_events_lender_required check (lender_org_id is not null) not valid;
comment on column payments.provider_events.parent_payment_ref is
  'For a refund or chargeback: the provider''s reference of the PAYMENT it concerns, when the provider names it. The refund is booked against that payment and no other; without it the refund is booked only when the intent has exactly one captured payment.';
comment on table payments.provider_events is
  'VERIFIED provider events only (check signature_verified): authenticated, integrity-checked, correlated to the lender''s own configuration and intent where the kind needs it, and business-valid. Anything that fails goes to payments.webhook_receipts instead and never takes an event id from the genuine provider. Unique (provider, lender, provider event id): one lender''s event ids can never consume another''s. Append-only. object_kind unsupported = an authentic event of a kind the platform does not handle, stored verified-and-ignored (processing_class ignored): it changes no state. Written only by payments.ingest_provider_delivery. Owner: payments module.';

alter table payments.webhook_receipts drop constraint webhook_receipts_event_fk;
alter table payments.webhook_receipts
  add constraint webhook_receipts_event_lender_fk foreign key (event_id, lender_org_id) references payments.provider_events (id, lender_org_id) on delete restrict not valid,
  add constraint webhook_receipts_event_has_lender check (event_id is null or lender_org_id is not null) not valid;

-- Every row that points at an event points at an event of its OWN lender (composite keys; NOT VALID so that history is not rewritten, enforced for new rows).
alter table payments.provider_payments drop constraint provider_payments_first_event_id_fkey, drop constraint provider_payments_last_event_id_fkey;
alter table payments.provider_payments
  add constraint provider_payments_first_event_fk foreign key (first_event_id, lender_org_id) references payments.provider_events (id, lender_org_id) on delete restrict not valid,
  add constraint provider_payments_last_event_fk foreign key (last_event_id, lender_org_id) references payments.provider_events (id, lender_org_id) on delete restrict not valid;
alter table payments.payment_adjustments drop constraint payment_adjustments_source_event_id_fkey;
alter table payments.payment_adjustments
  add constraint payment_adjustments_source_event_fk foreign key (source_event_id, lender_org_id) references payments.provider_events (id, lender_org_id) on delete restrict not valid;
alter table payments.event_processing drop constraint event_processing_event_id_fkey;
alter table payments.event_processing
  add constraint event_processing_event_lender_fk foreign key (event_id, lender_org_id) references payments.provider_events (id, lender_org_id) on delete restrict not valid;

alter table payments.provider_payments drop constraint provider_payments_provider_provider_payment_ref_key;
alter table payments.provider_payments
  add constraint provider_payments_lender_ref_key unique (provider, lender_org_id, provider_payment_ref);
-- rejected: the provider refused the attempt (a failure, like failed). A return, refund or dispute never becomes a status of this table
-- (it is an adjustment or an exception).
alter table payments.provider_payments drop constraint provider_payments_status_check;
alter table payments.provider_payments
  add constraint provider_payments_status_check check (status in ('created', 'pending', 'authorized', 'captured', 'paid', 'succeeded', 'failed', 'rejected', 'refunded', 'disputed', 'cancelled', 'expired'));

drop index payments.payment_intents_provider_ref;
create unique index payment_intents_lender_order_ref on payments.payment_intents (provider, lender_org_id, provider_order_ref)
  where provider_order_ref is not null;

-- A provider payment row may be flagged a duplicate capture once (false to true) when it first reaches a success status; it may move to a
-- success status from a higher-ranked non-success status (a late capture after expired or cancelled); a success never leaves the success
-- set and its amount never changes. Everything else of the earlier guard is preserved.
create or replace function private.protect_provider_payment()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_success text[] := private.payment_success_statuses();
begin
  if (to_jsonb(new) - array['status', 'rank', 'amount_minor', 'currency', 'captured_at', 'last_event_id', 'updated_at', 'duplicate_capture'])
     is distinct from (to_jsonb(old) - array['status', 'rank', 'amount_minor', 'currency', 'captured_at', 'last_event_id', 'updated_at', 'duplicate_capture']) then
    raise exception 'a provider payment keeps its identity, intent and first event' using errcode = 'P0001';
  end if;
  if old.duplicate_capture and not new.duplicate_capture then
    raise exception 'a duplicate capture flag is never removed' using errcode = 'P0001';
  end if;
  if old.status = any (v_success) then
    if not (new.status = any (v_success)) then
      raise exception 'a captured provider payment never moves off success' using errcode = 'P0001';
    end if;
    if new.amount_minor is distinct from old.amount_minor or new.currency is distinct from old.currency then
      raise exception 'the captured amount of a provider payment never changes' using errcode = 'P0001';
    end if;
    if new.duplicate_capture is distinct from old.duplicate_capture then
      raise exception 'the duplicate flag is set when a payment first reaches success' using errcode = 'P0001';
    end if;
  end if;
  if new.rank < old.rank and not (new.status = any (v_success) and not (old.status = any (v_success))) then
    raise exception 'a provider payment only moves to a higher rank' using errcode = 'P0001';
  end if;
  return new;
end
$$;
revoke all on function private.protect_provider_payment() from public;

-- ---------------------------------------------------------------------------------------------
-- 2. The hand-off vault: the subject is a real key (U35); no clear text (U34)
-- ---------------------------------------------------------------------------------------------
alter table payments.handoff_links
  add column payment_intent_id uuid generated always as (case when subject_kind = 'payment_intent' then subject_id end) stored,
  add column mandate_id uuid generated always as (case when subject_kind = 'mandate' then subject_id end) stored;
alter table payments.handoff_links
  add constraint handoff_links_intent_fk foreign key (payment_intent_id, lender_org_id) references payments.payment_intents (id, lender_org_id) on delete restrict,
  add constraint handoff_links_mandate_fk foreign key (mandate_id, lender_org_id) references payments.mandates (id, lender_org_id) on delete restrict;
create index handoff_links_intent on payments.handoff_links (payment_intent_id, lender_org_id);
create index handoff_links_mandate on payments.handoff_links (mandate_id, lender_org_id);

-- The two generated columns are computed AFTER a BEFORE row trigger runs, so inside this guard NEW carries nulls for them: they are left out
-- of the comparison (they follow subject_kind and subject_id, which the guard still protects).
create or replace function private.protect_handoff_link()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (to_jsonb(new) - array['read_count', 'payment_intent_id', 'mandate_id']) is distinct from (to_jsonb(old) - array['read_count', 'payment_intent_id', 'mandate_id']) then
    raise exception 'a stored hand-off link can only be read, never changed' using errcode = 'P0001';
  end if;
  return new;
end
$$;
revoke all on function private.protect_handoff_link() from public;

-- The lender comes through the composite keys above; the borrower must be the subject's borrower too.
create or replace function private.handoff_link_consistent()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.subject_kind = 'payment_intent' then
    perform 1 from payments.payment_intents i where i.id = new.subject_id and i.lender_org_id = new.lender_org_id and i.borrower_id = new.borrower_id;
  else
    perform 1 from payments.mandates m where m.id = new.subject_id and m.lender_org_id = new.lender_org_id and m.borrower_id = new.borrower_id;
  end if;
  if not found then
    raise exception 'a stored hand-off link belongs to the lender and the borrower of its subject' using errcode = '23514';
  end if;
  return new;
end
$$;
revoke all on function private.handoff_link_consistent() from public;
create trigger consistent before insert on payments.handoff_links
  for each row execute function private.handoff_link_consistent();
comment on table payments.handoff_links is
  'The provider hand-off link of a payment or a mandate authorisation is a BEARER SECRET. It is never stored in clear: the worker encrypts it (AES-256-GCM, a key outside the database, associated data naming the subject) and stores only the ciphertext here until it expires, one row per subject. The database cannot prove a blob IS ciphertext, but it refuses a blob made only of printable characters (a clear link) and a long or odd key version. The subject is a real key (composite foreign keys to the payment intent or the mandate with the lender, and a trigger for the borrower), so a row can never carry another tenant''s lender or another borrower. Only the owning borrower can ask for it (payments.take_handoff_link), and only while the payment configuration is active and valid, the loan is active, no money is on the intent and no cancellation of the mandate was asked for; the API decrypts it for the response. No role has table access: the table is reachable only through the three definer functions. Expired rows and rows of subjects that are no longer open are deleted by payments.purge_handoff_links. The ciphertext never appears in an audit event, an outbox payload, an error or a log. Owner: payments module.';

-- ---------------------------------------------------------------------------------------------
-- 3. Is the subject of a stored link still open for the borrower? One definition for take, detail and purge (A0, A56, U27-U29)
-- ---------------------------------------------------------------------------------------------
create or replace function private.handoff_subject_open(p_kind text, p_subject uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  i payments.payment_intents;
  m payments.mandates;
  v_lender uuid;
  v_config uuid;
  v_loan uuid;
begin
  if p_kind = 'payment_intent' then
    select * into i from payments.payment_intents x where x.id = p_subject;
    if not found or i.status <> 'pending' or (i.link_expires_at is not null and i.link_expires_at <= clock_timestamp()) then
      return false;
    end if;
    -- Money the provider already reported on this order (a different amount keeps the intent pending): the order must not be paid again.
    if exists (select 1 from payments.provider_payments pp
                where pp.intent_id = i.id and pp.lender_org_id = i.lender_org_id and pp.status = any (private.payment_success_statuses())) then
      return false;
    end if;
    v_lender := i.lender_org_id; v_config := i.config_id; v_loan := i.loan_account_id;
  elsif p_kind = 'mandate' then
    select * into m from payments.mandates x where x.id = p_subject;
    if not found or m.status <> 'registration_pending' or (m.handoff_expires_at is not null and m.handoff_expires_at <= clock_timestamp())
       or m.cancel_requested_at is not null then
      return false;
    end if;
    v_lender := m.lender_org_id; v_config := m.config_id; v_loan := m.loan_account_id;
  else
    return false;
  end if;
  if not exists (select 1 from servicing.loan_accounts la where la.id = v_loan and la.lender_org_id = v_lender and la.status = 'active') then
    return false;
  end if;
  -- The configuration must be ACTIVE and still a valid collection target (a suspended, retired or invalid one is the kill switch).
  if not exists (select 1 from payments.lender_payment_configs c where c.id = v_config and c.lender_org_id = v_lender and c.status = 'active') then
    return false;
  end if;
  return coalesce((private.validate_collection_target_impl(v_config) ->> 'ok')::boolean, false);
end
$$;
revoke all on function private.handoff_subject_open(text, uuid) from public;
comment on function private.handoff_subject_open(text, uuid) is
  'True when the payment (pending, link not expired, no money reported on it) or the mandate (registration pending, hand-off not expired, no cancellation asked for) behind a stored hand-off link is still open AND its loan is active AND its payment configuration is active and a valid collection target. The one definition used to hand a link out, to show that one is available and to purge it.';

-- The owning borrower only. A row is returned while it has not expired and the subject is still open (see handoff_subject_open); every read is counted.
create or replace function payments.take_handoff_link(p_kind text, p_subject uuid)
returns table (lender_org_id uuid, key_version text, alg text, ciphertext bytea, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_borrower uuid := private.my_borrower_id();
  h payments.handoff_links;
begin
  if (select auth.uid()) is null or v_borrower is null then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  if p_kind is null or p_kind not in ('payment_intent', 'mandate') or p_subject is null then
    raise exception 'invalid request' using errcode = '22023', hint = 'bad_request';
  end if;
  select * into h from payments.handoff_links x where x.subject_kind = p_kind and x.subject_id = p_subject and x.borrower_id = v_borrower for update;
  if not found or h.expires_at <= clock_timestamp()
     or not private.feature_enabled(h.lender_org_id, case p_kind when 'mandate' then 'mandates' else 'payments' end)
     or not private.handoff_subject_open(p_kind, p_subject) then
    raise exception 'link not available' using errcode = 'P0002', hint = 'link_unavailable';
  end if;
  update payments.handoff_links set read_count = read_count + 1 where id = h.id;
  return query select h.lender_org_id, h.key_version, h.alg, h.ciphertext, h.expires_at;
end
$$;
comment on function payments.take_handoff_link(text, uuid) is
  'The signed-in borrower asks for the encrypted hand-off link of their own payment or mandate. Handed out only while the subject is open (payment pending, link not expired, no money reported on it; mandate registration-pending with no cancellation asked for), the loan is active and the payment configuration is active and a valid collection target; anything else is P0002 link_unavailable, whoever asks. The caller decrypts it with a key the database never sees. Returns ciphertext only.';

-- System only: expired rows, and rows whose subject is no longer open for the borrower, are deleted (data minimisation). Returns how many.
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
   where h.expires_at <= clock_timestamp() or not private.handoff_subject_open(h.subject_kind, h.subject_id);
  get diagnostics v_n = row_count;
  return v_n;
end
$$;
comment on function payments.purge_handoff_links() is
  'System only. Deletes hand-off links that have expired or whose payment or mandate is no longer open for the borrower (not pending or waiting, link expired, money reported, cancellation asked for, loan not active, configuration not active or not valid). Run every few minutes by the worker.';

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
     or p_key_version is null or p_key_version !~ '^[A-Za-z0-9._-]{1,16}$' or p_key_version ~ '[0-9]{9}'
     or p_ciphertext is null or octet_length(p_ciphertext) not between 29 and 8192
     -- Cheap defence in depth: authenticated ciphertext is never made only of printable characters; a clear link is.
     or not exists (select 1 from generate_series(0, octet_length(p_ciphertext) - 1) g (i) where get_byte(p_ciphertext, g.i) not between 32 and 126)
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
  'System only. Keeps the ENCRYPTED hand-off link of a pending payment or a registration-pending mandate until it expires (at most 31 days). The lender and the borrower come from the subject. A blob made only of printable characters (a clear link) and a key version longer than 16 characters or carrying a long number are refused (22023 bad_request). The audit event names the key version only.';

-- ---------------------------------------------------------------------------------------------
-- 4. The borrower asks for a payment (M27, M31)
-- ---------------------------------------------------------------------------------------------
create or replace function payments.request_payment(
  p_loan uuid, p_purpose payments.intent_purpose, p_amount_minor bigint, p_idempotency_key text, p_quote uuid default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_borrower uuid := private.my_borrower_id();
  l servicing.loan_accounts;
  r record;
  v_cfg payments.lender_payment_configs;
  v_pol payments.lender_payment_policies;
  v_existing payments.payment_intents;
  v_n integer;
  v_q_id uuid;
  v_q_total bigint;
  v_q_until timestamptz;
  v_q_asof timestamptz;
  v_q_flagged boolean;
  v_due bigint;
  v_seq integer;
  v_id uuid;
  v_validity integer;
  v_expires timestamptz;
  v_success text[] := private.payment_success_statuses();
begin
  if v_uid is null or v_borrower is null then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  if p_loan is null or p_purpose is null or p_amount_minor is null or p_amount_minor <= 0 or p_amount_minor > 100000000000000
     or p_idempotency_key is null or length(p_idempotency_key) not between 16 and 128 then
    raise exception 'invalid payment request' using errcode = '22023', hint = 'bad_request';
  end if;
  select * into l from servicing.loan_accounts la where la.id = p_loan and la.borrower_id = v_borrower;
  if not found then
    raise exception 'loan not found' using errcode = 'P0002';
  end if;
  perform private.require_feature(l.lender_org_id, 'payments');
  -- One request at a time per loan, so two simultaneous requests cannot both pass the overlap checks below.
  perform pg_advisory_xact_lock(hashtextextended('payments.request:' || p_loan::text, 0));

  -- A replay with the same key returns the same intent; the same key with different content is a conflict.
  select * into v_existing from payments.payment_intents i where i.lender_org_id = l.lender_org_id and i.idempotency_key = p_idempotency_key;
  if found then
    if (v_existing.borrower_id, v_existing.loan_account_id, v_existing.purpose, v_existing.amount_minor) is distinct from (v_borrower, p_loan, p_purpose, p_amount_minor) then
      raise exception 'idempotency key was already used for a different payment' using errcode = '23505', hint = 'idempotency_conflict';
    end if;
    return v_existing.id;
  end if;

  if l.status <> 'active' then
    raise exception 'only an active loan can be paid through the app' using errcode = '55000', hint = 'loan_not_active';
  end if;
  if p_purpose = 'charges' then
    raise exception 'charges are not payable through the app until the lender reports them and the KFS or recorded consent is linked' using errcode = '55000', hint = 'purpose_not_supported';
  end if;
  if p_purpose <> 'foreclosure' and p_quote is not null then
    raise exception 'only a foreclosure payment names a quotation' using errcode = '22023', hint = 'bad_request';
  end if;

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
  select * into v_pol from payments.lender_payment_policies p where p.lender_org_id = l.lender_org_id;
  v_validity := coalesce(v_pol.link_validity_minutes, 60);
  v_expires := clock_timestamp() + make_interval(mins => v_validity);

  if p_purpose = 'foreclosure' then
    -- Exactly the amount of the newest unexpired quotation the lender reported, and never one whose parts do not add up.
    select lq.id, lq.total_minor, lq.valid_until, lq.as_of, lq.total_mismatch into v_q_id, v_q_total, v_q_until, v_q_asof, v_q_flagged
      from servicing.latest_valid_quote(p_loan) lq;
    if not found then
      raise exception 'there is no unexpired foreclosure quotation' using errcode = '55000', hint = 'quote_required';
    end if;
    if p_quote is not null and p_quote <> v_q_id then
      raise exception 'the quotation is not the current one' using errcode = '55000', hint = 'quote_not_current';
    end if;
    if v_q_flagged then
      raise exception 'the lender''s quotation does not add up: ask the lender for a corrected one' using errcode = '55000', hint = 'quote_flagged';
    end if;
    if p_amount_minor <> v_q_total then
      raise exception 'the amount must equal the lender''s quotation' using errcode = '22023', hint = 'amount_not_allowed';
    end if;
    -- A payment captured after the quotation was made is not in it: the quotation no longer states what is owed.
    if exists (select 1 from payments.provider_payments pp
                where pp.loan_account_id = p_loan and pp.lender_org_id = l.lender_org_id and pp.status = any (v_success) and not pp.duplicate_capture
                  and coalesce(pp.captured_at, pp.created_at) > v_q_asof
                  and pp.amount_minor > coalesce((select sum(a.amount_minor) from payments.payment_adjustments a
                                                   where a.provider_payment_id = pp.id and a.lender_org_id = pp.lender_org_id and a.kind in ('refund', 'chargeback', 'reversal')), 0)) then
      raise exception 'a payment was received after the lender''s quotation: ask the lender for a new one' using errcode = '55000', hint = 'quote_not_current';
    end if;
    -- The link never outlives the quotation it is bound to.
    v_expires := least(v_expires, v_q_until);
  else
    select * into r from private.servicing_borrower_loans(p_loan);
    if not found then
      raise exception 'loan not found' using errcode = 'P0002';
    end if;
    if not r.figures_available then
      raise exception 'the lender''s figures are not available or are being checked' using errcode = '55000', hint = 'figures_unavailable';
    end if;
    if r.stale then
      raise exception 'the lender''s figures are out of date' using errcode = '55000', hint = 'stale_data';
    end if;
    -- A payment received after the lender's newest report is not in its figures yet: the same installment, overdue amount or principal
    -- would be offered again. Wait for the lender's next report (a fully refunded payment does not count).
    if exists (select 1 from payments.provider_payments pp
                where pp.loan_account_id = p_loan and pp.lender_org_id = l.lender_org_id and pp.status = any (v_success) and not pp.duplicate_capture
                  and coalesce(pp.captured_at, pp.created_at) > r.reported_as_of
                  and pp.amount_minor > coalesce((select sum(a.amount_minor) from payments.payment_adjustments a
                                                   where a.provider_payment_id = pp.id and a.lender_org_id = pp.lender_org_id and a.kind in ('refund', 'chargeback', 'reversal')), 0)) then
      raise exception 'the lender has not yet reported your earlier payment' using errcode = '55000', hint = 'stale_data';
    end if;
    if p_purpose = 'installment' then
      v_due := r.next_due_minor;
      if v_due is null or v_due <= 0 then
        raise exception 'nothing is due' using errcode = '55000', hint = 'nothing_due';
      end if;
      select i.seq into v_seq from servicing.schedule_installments i join servicing.schedule_snapshots s on s.id = i.snapshot_id
       where s.loan_account_id = p_loan and i.due_date = r.next_due_on
         and s.version = (select max(s2.version) from servicing.schedule_snapshots s2 where s2.loan_account_id = p_loan)
       order by i.seq limit 1;
    elsif p_purpose = 'overdue' then
      v_due := r.total_overdue_minor;
      if v_due is null or v_due <= 0 then
        raise exception 'nothing is overdue' using errcode = '55000', hint = 'nothing_due';
      end if;
    end if;
    if p_purpose in ('installment', 'overdue') then
      if p_amount_minor > v_due
         or (p_amount_minor < v_due and not (coalesce(v_pol.allow_partial_payments, false) and p_amount_minor >= v_pol.min_partial_amount_minor)) then
        raise exception 'the amount must be the lender''s reported figure, or a part the lender accepts' using errcode = '22023', hint = 'amount_not_allowed';
      end if;
    elsif p_purpose = 'part_prepayment' then
      if not coalesce(v_pol.allow_part_prepayment, false) then
        raise exception 'the lender does not accept part-prepayments through the app' using errcode = '55000', hint = 'purpose_not_enabled';
      end if;
      if r.outstanding_principal_minor is null or p_amount_minor < v_pol.min_part_prepayment_minor or p_amount_minor > r.outstanding_principal_minor then
        raise exception 'the amount must be between the lender''s minimum and the reported outstanding principal' using errcode = '22023', hint = 'amount_not_allowed';
      end if;
    end if;
  end if;

  -- Overlapping purposes: a foreclosure pays the whole loan, so it cannot be open together with any other payment of the loan; the
  -- installment and the overdue amount may be the same money in the lender's figures, so they are not open together either.
  if exists (select 1 from payments.payment_intents o
              where o.loan_account_id = p_loan and o.lender_org_id = l.lender_org_id and o.status in ('created', 'pending')
                and (o.purpose = 'foreclosure' or p_purpose = 'foreclosure'
                     or (o.purpose = 'installment' and p_purpose = 'overdue') or (o.purpose = 'overdue' and p_purpose = 'installment'))) then
    raise exception 'there is already an open payment for this' using errcode = '23505', hint = 'open_intent_exists';
  end if;

  begin
    insert into payments.payment_intents (lender_org_id, loan_account_id, borrower_id, purpose, amount_minor, provider, config_id, idempotency_key, created_by,
                                          quote_id, target_installment_seq, link_expires_at)
    values (l.lender_org_id, p_loan, v_borrower, p_purpose, p_amount_minor, v_cfg.provider, v_cfg.id, p_idempotency_key, v_uid,
            v_q_id, v_seq, v_expires)
    returning id into v_id;
  exception when unique_violation then
    -- Either a concurrent request with the same key (a replay) or an open intent for the same installment and purpose.
    select * into v_existing from payments.payment_intents i where i.lender_org_id = l.lender_org_id and i.idempotency_key = p_idempotency_key;
    if found then
      return v_existing.id;
    end if;
    raise exception 'there is already an open payment for this' using errcode = '23505', hint = 'open_intent_exists';
  end;
  perform ops.enqueue_event('payment.create_order', jsonb_build_object('intent_id', v_id), null, 'payment.create_order:' || v_id::text);
  perform private.write_payments_audit(l.lender_org_id, 'payments.intent.requested', 'payment_intent', v_id::text,
    jsonb_build_object('purpose', p_purpose::text, 'provider_mode', v_cfg.provider_mode::text));
  return v_id;
end
$$;
comment on function payments.request_payment(uuid, payments.intent_purpose, bigint, text, uuid) is
  'The ONLY way an intent is created. The signed-in borrower asks to pay their own active loan. Needs the payments switch, an active valid collection configuration (payments.validate_collection_target), and the lender''s REPORTED figures: installment / overdue = the reported next-due / total-overdue figure, or a part the lender accepts (payments.lender_payment_policies); part_prepayment = between the lender''s minimum and the reported outstanding principal, only if enabled; foreclosure = exactly the unexpired lender quotation (servicing.latest_valid_quote, never a flagged one); charges are refused (purpose_not_supported). Stale or disputed figures block it (stale_data, figures_unavailable). A payment captured after the lender''s newest report (or after the quotation) blocks it until the lender reports again (stale_data / quote_not_current): the same installment is never offered twice. A foreclosure payment is open alone, and an installment and an overdue payment are not open together (open_intent_exists). A foreclosure link never outlives its quotation. Idempotent on (lender, key); requests for one loan are serialised. One open intent per loan, purpose and installment. Enqueues payment.create_order (ids only). There is no function that accepts a success flag.';

-- ---------------------------------------------------------------------------------------------
-- 5. System order lifecycle (U31, M31) and expiry (M23)
-- ---------------------------------------------------------------------------------------------
create or replace function payments.record_order_created(p_intent uuid, p_provider_order_ref text, p_link_expires_at timestamptz default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  i payments.payment_intents;
  v_expiry timestamptz;
  v_quote_until timestamptz;
begin
  if private.invoking_role() <> 'service_role' then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  if p_provider_order_ref is null or length(p_provider_order_ref) not between 1 and 200 or p_provider_order_ref !~ '^[A-Za-z0-9._:=+/-]+$' then
    raise exception 'invalid provider order reference' using errcode = '22023', hint = 'order_ref_invalid';
  end if;
  if p_link_expires_at is not null and (p_link_expires_at <= clock_timestamp() or p_link_expires_at > clock_timestamp() + interval '31 days') then
    raise exception 'invalid link expiry' using errcode = '22023', hint = 'link_expiry_invalid';
  end if;
  select * into i from payments.payment_intents x where x.id = p_intent for update;
  if not found then
    raise exception 'intent not found' using errcode = 'P0002';
  end if;
  if i.status in ('cancelled', 'failed', 'expired') then
    -- The borrower cancelled (or the intent closed) while the worker was asking the provider: an order exists at the provider for an
    -- intent that is closed. Keep its reference, so anything the provider reports for it finds the intent (money on it raises
    -- payment_on_closed_intent), and leave an exception for the platform: the order must be voided at the provider or ignored.
    if i.provider_order_ref = p_provider_order_ref then return i.status::text; end if;
    if i.provider_order_ref is not null then
      raise exception 'the order can be recorded only for a created intent' using errcode = '55000', hint = 'intent_state_invalid';
    end if;
    update payments.payment_intents set provider_order_ref = p_provider_order_ref where id = p_intent;
    perform private.raise_exception_impl(i.lender_org_id, 'payment_status_conflict', 'warning', 'platform',
      jsonb_build_object('intent_id', i.id::text, 'config_id', i.config_id::text));
    perform private.write_payments_audit(i.lender_org_id, 'payments.intent.order_on_closed_intent', 'payment_intent', p_intent::text, jsonb_build_object('intent_status', i.status::text));
    return i.status::text;
  end if;
  if i.status <> 'created' then
    if i.provider_order_ref = p_provider_order_ref then return i.status::text; end if;
    raise exception 'the order can be recorded only for a created intent' using errcode = '55000', hint = 'intent_state_invalid';
  end if;
  v_expiry := coalesce(p_link_expires_at, i.link_expires_at);
  -- A foreclosure link never outlives the quotation it is bound to, whatever the provider says.
  if i.purpose = 'foreclosure' then
    select q.valid_until into v_quote_until from servicing.foreclosure_quotes q where q.id = i.quote_id and q.lender_org_id = i.lender_org_id;
    if v_quote_until is not null then
      v_expiry := least(v_expiry, v_quote_until);
    end if;
  end if;
  update payments.payment_intents set provider_order_ref = p_provider_order_ref, status = 'pending', link_expires_at = v_expiry
   where id = p_intent;
  return 'pending';
end
$$;
comment on function payments.record_order_created(uuid, text, timestamptz) is
  'System only. Records the provider''s order for a created intent: created -> pending, with the provider''s link expiry (never later than the quotation of a foreclosure payment). If the intent is already closed (cancelled by the borrower, failed or expired while the worker was calling the provider) the order reference is kept on it WITHOUT reopening it, a payment_status_conflict exception for the platform names the order that must be voided or ignored, and the closed status is returned.';

create or replace function payments.expire_stale_intents(p_grace interval default interval '15 minutes')
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
  if p_grace is null or p_grace < interval '0' or p_grace > interval '7 days' then
    raise exception 'invalid grace period' using errcode = '22023', hint = 'bad_request';
  end if;
  -- An intent whose link ended is expired and frees its slot, unless the provider reported money on it (captured, refunded or disputed: a
  -- person looks) or an attempt is still in flight (created, pending or authorized and heard of in the last 24 hours). Failed, rejected,
  -- cancelled and expired attempts, and attempts nobody has heard of for a day, do not hold it: money that arrives later is recorded on
  -- the closed intent and opens a payment_on_closed_intent exception.
  update payments.payment_intents i set status = 'expired'
   where i.status in ('created', 'pending') and i.link_expires_at is not null and i.link_expires_at + p_grace < clock_timestamp()
     and not exists (
       select 1 from payments.provider_payments pp
        where pp.intent_id = i.id and pp.lender_org_id = i.lender_org_id
          and (pp.status in ('captured', 'paid', 'succeeded', 'refunded', 'disputed')
               or (pp.status in ('created', 'pending', 'authorized') and pp.updated_at > clock_timestamp() - interval '24 hours')));
  get diagnostics v_n = row_count;
  return v_n;
end
$$;
comment on function payments.expire_stale_intents(interval) is
  'System only. Expires created or pending intents whose link ended more than the grace period ago, except an intent the provider reported money on (captured, refunded, disputed: left for a person) or with an attempt still in flight (created, pending or authorized, updated in the last 24 hours). An intent whose attempts all failed, were rejected, cancelled or expired, or went quiet for a day, expires and frees its slot for a new request; a capture that arrives later opens payment_on_closed_intent. Returns how many.';

-- ---------------------------------------------------------------------------------------------
-- 6. What the borrower sees (M32, U36, A0, A56, U29)
-- ---------------------------------------------------------------------------------------------
create or replace function payments.my_payment(p_intent uuid)
returns table (intent_id uuid, intent_status text, stage text, provider_received_at timestamptz, lender_posted_on date)
language plpgsql
stable
security definer
set search_path = ''
as $$
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
       and not exists (select 1 from servicing.lms_receipts rv where rv.reverses_receipt_id = r.id)
       and not exists (select 1 from servicing.sync_conflicts c
                        where c.loan_account_id = r.loan_account_id and c.lender_org_id = r.lender_org_id and c.record_type = 'receipt'
                          and c.existing_ref_id = r.id and c.status <> 'resolved')
     order by r.value_date limit 1;
  end if;
  -- An open exception about the intent (but not the platform-side note about an order made for an intent the borrower cancelled: it names
  -- the configuration as well), an amount that differs, money on an intent that is no longer open, or a refund or chargeback of the payment.
  v_attention := exists (select 1 from payments.reconciliation_exceptions e
                          where e.lender_org_id = i.lender_org_id and e.status <> 'resolved' and e.subject ->> 'intent_id' = i.id::text and not (e.subject ? 'config_id'))
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
$$;
comment on function payments.my_payment(uuid) is
  'The honest stage of the signed-in borrower''s own payment: started, provider_received (a verified provider event reports the payment), lender_posted (the lender''s own receipt carries the provider payment reference or the intent id, for the same amount, has not been reversed and is not disputed by an unresolved conflict) or needs_attention (an open exception, an amount that differs, money received on an intent that is no longer open, or a refund or chargeback of the payment). Derived only from verified events and lender receipts; a redirect, a client flag or a screen can never move it.';

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
            and exists (select 1 from payments.handoff_links h where h.subject_kind = 'payment_intent' and h.subject_id = i.id and h.expires_at > clock_timestamp())
            and private.handoff_subject_open('payment_intent', i.id)),
           (i.status = 'created'),
           (select sa.masked_account_ref from payments.lender_payment_configs c
              join tenancy.lender_settlement_accounts sa on sa.id = c.settlement_account_id and sa.lender_org_id = c.lender_org_id
             where c.id = i.config_id and c.lender_org_id = i.lender_org_id),
           s.provider_received_at, s.lender_posted_on
    from tenancy.organizations o where o.id = i.lender_org_id;
end
$$;
comment on function payments.my_payment_detail(uuid) is
  'Borrower only: one of the caller''s own payments (P0002 for anyone else''s, and when the lender''s payments switch is off). Purpose and amount as requested, the honest stage derived from verified provider events and the lender''s own receipts (payments.my_payment), the lender''s masked destination account, whether a payment link can be fetched (exactly when payments.take_handoff_link would hand it out: the payment is pending and unexpired, no money is reported on it, the loan is active and the payment configuration is active and valid), and whether the payment can still be cancelled (only while no order exists at the provider).';

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
  'Borrower only. Newest first, keyset-paged on (sort_at, entry_id), at most 100 per page. lender_receipt / lender_reversal: what the lender''s LMS posted (posted, reversed, recorded), when the switch servicing_sync is on; a receipt the lender contradicts (an unresolved conflict about it) is withheld until the conflict is resolved. payment_attempt: the borrower''s own payments with the honest stage from payments.my_payment (started, provider_received, lender_posted, needs_attention), or cancelled, failed or expired when the provider never reported money for them. payment_adjustment: a refund, chargeback, reversal or correction the provider verifiably reported. Amounts are integer paise as reported. No bank reference, payment mode or provider reference is returned.';

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
  v_q_id uuid;
  v_q_total bigint;
  v_q_until timestamptz;
  v_q_asof timestamptz;
  v_q_flagged boolean;
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
  v_success text[] := private.payment_success_statuses();
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
      -- A payment received after the lender's newest report is not in its figures yet: request_payment refuses (stale_data) until the lender
      -- reports again, so nothing amount-dependent is offered meanwhile and the figures read as out of date.
      if v_figures and exists (select 1 from payments.provider_payments pp
                                where pp.loan_account_id = p_loan and pp.lender_org_id = l.lender_org_id and pp.status = any (v_success) and not pp.duplicate_capture
                                  and coalesce(pp.captured_at, pp.created_at) > r.reported_as_of
                                  and pp.amount_minor > coalesce((select sum(a.amount_minor) from payments.payment_adjustments a
                                                                   where a.provider_payment_id = pp.id and a.lender_org_id = pp.lender_org_id and a.kind in ('refund', 'chargeback', 'reversal')), 0)) then
        v_stale := true;
      end if;
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
      -- Only when request_payment could accept an amount: the lender's minimum must not exceed the reported outstanding principal.
      if coalesce(v_pol.allow_part_prepayment, false) and coalesce(r.outstanding_principal_minor, 0) > 0
         and v_pol.min_part_prepayment_minor <= r.outstanding_principal_minor then
        v_purposes := v_purposes || jsonb_build_array(jsonb_build_object(
          'purpose', 'part_prepayment', 'amount_source', 'borrower_within_lender_limits',
          'min_minor', v_pol.min_part_prepayment_minor, 'max_minor', r.outstanding_principal_minor));
      end if;
    end if;
    -- A foreclosure payment equals the lender's unexpired quotation; it does not depend on the balance report. Not offered when a payment was
    -- received after the quotation was made (request_payment refuses it: quote_not_current).
    select lq.id, lq.total_minor, lq.valid_until, lq.as_of, lq.total_mismatch into v_q_id, v_q_total, v_q_until, v_q_asof, v_q_flagged
      from servicing.latest_valid_quote(p_loan) lq;
    if found and not exists (select 1 from payments.provider_payments pp
                              where pp.loan_account_id = p_loan and pp.lender_org_id = l.lender_org_id and pp.status = any (v_success) and not pp.duplicate_capture
                                and coalesce(pp.captured_at, pp.created_at) > v_q_asof
                                and pp.amount_minor > coalesce((select sum(a.amount_minor) from payments.payment_adjustments a
                                                                 where a.provider_payment_id = pp.id and a.lender_org_id = pp.lender_org_id and a.kind in ('refund', 'chargeback', 'reversal')), 0)) then
      v_purposes := v_purposes || jsonb_build_array(jsonb_build_object(
        'purpose', 'foreclosure', 'amount_source', 'lender_quote', 'amount_minor', v_q_total, 'min_minor', v_q_total, 'max_minor', v_q_total,
        'quote_id', v_q_id, 'valid_until', v_q_until, 'flagged', v_q_flagged));
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
  'Borrower only (P0002 for another loan and when the payments switch is off). What the borrower can pay now: the lender''s reported next installment and overdue figures (or a part the lender accepts), a part-prepayment within the lender''s limits (only when the minimum does not exceed the reported outstanding principal), the amount of an unexpired lender quotation, the lender''s masked destination account, the lender''s APPROVED penal-charge sentence when something is overdue (never invented or computed: when none is approved the answer says so and the app shows nothing in its place), and the borrower''s open payments. Nothing is offered when the figures are missing, withheld or stale, or the lender''s collection target is not valid; unavailable_key then names why (loan_not_active, collection_target_invalid, config_ambiguous). A payment captured after the lender''s newest report makes the figures read as stale until the lender reports again, and one captured after a quotation withholds that quotation: request_payment refuses them. Mirrors the checks of payments.request_payment, which remains the only way to create a payment; an open payment of the same purpose is listed in open_payments and refused again (open_intent_exists).';

-- ---------------------------------------------------------------------------------------------
-- 7. Exceptions: notes are screened too (A9, M29)
-- ---------------------------------------------------------------------------------------------
create or replace function payments.resolve_exception(p_exception uuid, p_reason_code text, p_evidence jsonb, p_note text default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  a record;
begin
  select * into a from private.exception_actor(p_exception);
  if a.x_status = 'resolved' then
    raise exception 'the exception is already resolved' using errcode = '55000', hint = 'exception_state_invalid';
  end if;
  if p_reason_code is null or p_reason_code not in ('verified_with_provider', 'refunded_by_provider', 'posted_by_lender', 'duplicate_confirmed', 'timing_difference',
       'no_action_needed', 'escalated_to_provider', 'escalated_to_lender', 'documented_elsewhere', 'raised_in_error', 'new_information') then
    raise exception 'a reason from the closed list is required' using errcode = '22023', hint = 'reason_required';
  end if;
  if not private.evidence_labels_ok(p_evidence) then
    raise exception 'the evidence reviewed must be a list of 1 to 10 record ids or short reference codes' using errcode = '22023', hint = 'evidence_required';
  end if;
  if p_note is not null and length(p_note) > 500 then
    raise exception 'a note is at most 500 characters' using errcode = '22023', hint = 'reason_invalid';
  end if;
  if not private.exception_note_ok(p_note) then
    raise exception 'a note may not carry a number, a personal identifier or a link; store a reference instead' using errcode = '22023', hint = 'unsafe_free_text';
  end if;
  -- Annotation only: the exception row is the only thing that changes.
  update payments.reconciliation_exceptions set status = 'resolved', resolved_at = clock_timestamp() where id = p_exception;
  insert into payments.reconciliation_exception_events (exception_id, lender_org_id, action, actor_kind, actor_user_id, reason_code, evidence, note, authorised_by_permission)
  values (p_exception, a.x_lender, 'resolved', a.x_kind, a.x_user, p_reason_code, p_evidence, p_note, a.x_perm);
  perform private.write_payments_audit(a.x_lender, 'payments.exception.resolved', 'reconciliation_exception', p_exception::text, jsonb_build_object('reason_code', p_reason_code));
  return 'resolved';
end
$$;

create or replace function payments.reopen_exception(p_exception uuid, p_reason_code text, p_note text default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  a record;
begin
  select * into a from private.exception_actor(p_exception);
  if a.x_status <> 'resolved' then
    raise exception 'only a resolved exception can be reopened' using errcode = '55000', hint = 'exception_state_invalid';
  end if;
  if p_reason_code is null or p_reason_code not in ('new_information', 'raised_in_error', 'verified_with_provider', 'escalated_to_provider', 'escalated_to_lender') then
    raise exception 'a reason from the closed list is required' using errcode = '22023', hint = 'reason_required';
  end if;
  if p_note is not null and length(p_note) > 500 then
    raise exception 'a note is at most 500 characters' using errcode = '22023', hint = 'reason_invalid';
  end if;
  if not private.exception_note_ok(p_note) then
    raise exception 'a note may not carry a number, a personal identifier or a link; store a reference instead' using errcode = '22023', hint = 'unsafe_free_text';
  end if;
  update payments.reconciliation_exceptions set status = 'reopened', resolved_at = null where id = p_exception;
  insert into payments.reconciliation_exception_events (exception_id, lender_org_id, action, actor_kind, actor_user_id, reason_code, note, authorised_by_permission)
  values (p_exception, a.x_lender, 'reopened', a.x_kind, a.x_user, p_reason_code, p_note, a.x_perm);
  perform private.write_payments_audit(a.x_lender, 'payments.exception.reopened', 'reconciliation_exception', p_exception::text, jsonb_build_object('reason_code', p_reason_code));
  return 'reopened';
end
$$;

-- ---------------------------------------------------------------------------------------------
-- 8. Ingest: replay and identity scoped to the configuration and the lender; statuses a table cannot store (A28, M28, U0, U56, M30)
-- ---------------------------------------------------------------------------------------------
create or replace function payments.ingest_provider_delivery(p_token_hash text, p_delivery jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
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
                     when (v_ev ->> 'amountMinor') ~ '^[0-9]{1,15}$' then (v_ev ->> 'amountMinor')::bigint
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
$$;
comment on function payments.ingest_provider_delivery(text, jsonb) is
  'System only (the callback receiver). The ONLY way a provider delivery enters the database. Routes by the hash of the endpoint token to an ACTIVE configuration (an unknown, suspended or retired token gets the same answer as a bad signature; a verified delivery for an inactive configuration cannot be told apart from garbage in the database, so it is never stored). Anything but outcome verified writes a receipt and nothing else. A verified delivery is read, checked against the configuration (provider, merchant), correlated (a payment, refund or chargeback must match an intent of THIS lender, provider and configuration by order reference; a mandate or debit goes through private.correlate_mandate_event), business-validated (money statuses need an amount, INR), and only then consumes its delivery id (private.mark_webhook_seen, one namespace per payment configuration) and takes its event id in provider_events (unique per provider, lender and event id: another lender''s ids never collide). The same event id again from the same lender is a duplicate (an event_payload_conflict exception when the payload differs). An authentic event of an unsupported kind, an unmapped status, or a mandate-only status (active, revoked, paused) on a payment, refund or chargeback is stored verified-and-ignored. A verified, actionable event enqueues payment.apply_event (ids only). A refund or chargeback may carry parentPaymentRef, the provider''s reference of the payment it concerns. Returns {accepted, outcome} and nothing about internals.';

-- ---------------------------------------------------------------------------------------------
-- 9. Apply (worker): idempotent, one intent at a time under a row lock (M22-M26, M31, A31, A50, A56)
-- ---------------------------------------------------------------------------------------------
create or replace function payments.apply_provider_event(p_event uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  e payments.provider_events;
  i payments.payment_intents;
  pp payments.provider_payments;
  v_success text[] := private.payment_success_statuses();
  v_is_success boolean;
  v_dup boolean := false;
  v_have boolean;
  v_attempt integer;
  v_until timestamptz;
  v_adj_kind text;
  v_sum bigint;
  v_n integer;
  v_outcome text;
  v_reason text;
  v_loan_active boolean;
  v_quote_until timestamptz;
begin
  if private.invoking_role() <> 'service_role' then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  select * into e from payments.provider_events x where x.id = p_event;
  if not found then
    raise exception 'event not found' using errcode = 'P0002';
  end if;
  -- One application at a time per event; the loser sees the finished row and does nothing.
  perform pg_advisory_xact_lock(hashtextextended('payments.apply:' || e.id::text, 0));
  if exists (select 1 from payments.event_processing p where p.event_id = e.id and p.outcome <> 'deferred') then
    return jsonb_build_object('outcome', 'already_applied', 'reason', 'finished_earlier');
  end if;
  if e.object_kind is null or e.processing_class is null then
    raise exception 'the event is not normalised' using errcode = '55000', hint = 'event_not_normalised';
  end if;
  if e.processing_class = 'ignored' then
    perform private.record_event_processing(e.id, e.lender_org_id, 'ignored_unsupported', 'unsupported_kind');
    return jsonb_build_object('outcome', 'ignored_unsupported', 'reason', 'unsupported_kind');
  end if;
  v_is_success := e.provider_status = any (v_success);

  if e.object_kind = 'settlement' then
    perform private.record_event_processing(e.id, e.lender_org_id, 'recorded_for_reconciliation', 'settlement_event');
    return jsonb_build_object('outcome', 'recorded_for_reconciliation', 'reason', 'settlement_event');
  elsif e.object_kind in ('mandate', 'debit') then
    v_outcome := private.apply_mandate_event(e.id);
    perform private.record_event_processing(e.id, e.lender_org_id, v_outcome, case v_outcome when 'ignored_unsupported_yet' then 'mandates_not_built' else 'mandate_event' end);
    return jsonb_build_object('outcome', v_outcome);
  end if;

  -- payment, refund, chargeback: the intent decides the lock order.
  select * into i from payments.payment_intents x where x.id = e.payment_intent_id and x.lender_org_id = e.lender_org_id for update;
  if not found then
    raise exception 'the event has no intent' using errcode = '55000', hint = 'event_not_correlated';
  end if;

  if e.object_kind = 'payment' then
    -- A payment object never carries a refund, a dispute or a return in provider_payments: it would overwrite the captured row. Such an event
    -- leaves the payment as it is and opens an exception for a person (the amount of a refund is not known to be the whole payment).
    if e.provider_status in ('refunded', 'disputed', 'returned') then
      select * into pp from payments.provider_payments x
       where x.lender_org_id = e.lender_org_id and x.provider = e.provider and x.provider_payment_ref = e.object_ref and x.intent_id = i.id;
      perform private.raise_exception_impl(e.lender_org_id, 'payment_status_conflict', 'warning', 'lender',
        case when pp.id is null then jsonb_build_object('intent_id', i.id::text, 'event_id', e.id::text)
             else jsonb_build_object('intent_id', i.id::text, 'provider_payment_id', pp.id::text, 'event_id', e.id::text) end);
      perform private.record_event_processing(e.id, e.lender_org_id, 'exception', 'reversal_on_payment_object', i.id, pp.id);
      return jsonb_build_object('outcome', 'exception', 'reason', 'reversal_on_payment_object');
    end if;

    -- The provider payment of THIS lender: the same reference at another lender is another payment.
    select * into pp from payments.provider_payments x
     where x.lender_org_id = e.lender_org_id and x.provider = e.provider and x.provider_payment_ref = e.object_ref for update;
    if found then
      if pp.intent_id <> i.id then
        -- The same provider payment reference under another intent of this lender: never merged, never updated; the platform asks the provider.
        perform private.raise_exception_impl(e.lender_org_id, 'payment_status_conflict', 'warning', 'platform',
          jsonb_build_object('intent_id', i.id::text, 'event_id', e.id::text));
        perform private.record_event_processing(e.id, e.lender_org_id, 'exception', 'payment_ref_conflict', i.id);
        return jsonb_build_object('outcome', 'exception', 'reason', 'payment_ref_conflict');
      end if;
      if pp.status = any (v_success) then
        if not v_is_success then
          -- Whatever its rank, nothing moves a captured payment off success. A failure, rejection, cancellation or expiry reported after a
          -- capture contradicts it: a person looks. An earlier step of the same payment (created, pending, authorized) arriving late is
          -- just stale.
          if e.provider_status in ('failed', 'rejected', 'cancelled', 'expired') then
            perform private.raise_exception_impl(e.lender_org_id, 'payment_status_conflict', 'warning', 'lender',
              jsonb_build_object('intent_id', i.id::text, 'provider_payment_id', pp.id::text));
            perform private.record_event_processing(e.id, e.lender_org_id, 'exception', 'failure_after_success', i.id, pp.id);
            return jsonb_build_object('outcome', 'exception', 'reason', 'failure_after_success');
          end if;
          perform private.record_event_processing(e.id, e.lender_org_id, 'ignored_stale', 'lower_rank', i.id, pp.id);
          return jsonb_build_object('outcome', 'ignored_stale', 'reason', 'lower_rank');
        end if;
        -- A success again: the captured amount never changes; a different amount is flagged.
        if e.amount_minor is not null and (e.amount_minor is distinct from pp.amount_minor or e.currency is distinct from pp.currency) then
          perform private.raise_exception_impl(e.lender_org_id, 'amount_mismatch', 'warning', 'lender',
            jsonb_build_object('intent_id', i.id::text, 'provider_payment_id', pp.id::text));
          perform private.record_event_processing(e.id, e.lender_org_id, 'exception', 'amount_differs_from_capture', i.id, pp.id);
          return jsonb_build_object('outcome', 'exception', 'reason', 'amount_differs_from_capture');
        end if;
        if e.rank <= pp.rank then
          perform private.record_event_processing(e.id, e.lender_org_id, case when e.rank = pp.rank then 'already_applied' else 'ignored_stale' end,
            case when e.rank = pp.rank then 'same_status' else 'lower_rank' end, i.id, pp.id);
          return jsonb_build_object('outcome', case when e.rank = pp.rank then 'already_applied' else 'ignored_stale' end,
                                    'reason', case when e.rank = pp.rank then 'same_status' else 'lower_rank' end);
        end if;
        update payments.provider_payments set status = e.provider_status, rank = e.rank, last_event_id = e.id where id = pp.id returning * into pp;
        v_dup := pp.duplicate_capture;
      elsif v_is_success then
        -- A capture is always recorded, whatever non-success status (and rank) was stored before it: money received is never dropped as stale.
        -- If another payment of this intent already captured, this one is the second capture, flagged now.
        v_dup := exists (
          select 1 from payments.provider_payments o
           where o.intent_id = i.id and o.lender_org_id = i.lender_org_id and o.id <> pp.id and o.status = any (v_success) and not o.duplicate_capture);
        update payments.provider_payments set status = e.provider_status, rank = e.rank, amount_minor = coalesce(e.amount_minor, amount_minor),
               currency = coalesce(e.currency, currency), captured_at = coalesce(captured_at, e.occurred_at), duplicate_capture = v_dup, last_event_id = e.id
         where id = pp.id
        returning * into pp;
      else
        -- A status that is not a success, on a payment that has not succeeded: only a higher rank moves it.
        if e.rank < pp.rank then
          perform private.record_event_processing(e.id, e.lender_org_id, 'ignored_stale', 'lower_rank', i.id, pp.id);
          return jsonb_build_object('outcome', 'ignored_stale', 'reason', 'lower_rank');
        elsif e.rank = pp.rank and e.provider_status = pp.status then
          perform private.record_event_processing(e.id, e.lender_org_id, 'already_applied', 'same_status', i.id, pp.id);
          return jsonb_build_object('outcome', 'already_applied', 'reason', 'same_status');
        end if;
        update payments.provider_payments set status = e.provider_status, rank = e.rank, amount_minor = coalesce(e.amount_minor, amount_minor),
               currency = coalesce(e.currency, currency), last_event_id = e.id
         where id = pp.id
        returning * into pp;
      end if;
    else
      -- A second capture on an order that already had one is a separate row, flagged.
      v_dup := v_is_success and exists (
        select 1 from payments.provider_payments o
         where o.intent_id = i.id and o.lender_org_id = i.lender_org_id and o.status = any (v_success) and not o.duplicate_capture);
      insert into payments.provider_payments (lender_org_id, config_id, provider, provider_payment_ref, order_ref, intent_id, loan_account_id, status, rank, amount_minor,
                                              currency, captured_at, duplicate_capture, first_event_id, last_event_id)
      values (e.lender_org_id, e.config_id, e.provider, e.object_ref, e.order_ref, i.id, i.loan_account_id, e.provider_status, e.rank, e.amount_minor, e.currency,
              case when v_is_success then e.occurred_at end, v_dup, e.id, e.id)
      returning * into pp;
    end if;

    if v_is_success then
      if v_dup then
        perform private.raise_exception_impl(e.lender_org_id, 'duplicate_payment', 'warning', 'lender',
          jsonb_build_object('intent_id', i.id::text, 'provider_payment_id', pp.id::text));
        v_outcome := 'exception'; v_reason := 'duplicate_capture';
      elsif i.status in ('failed', 'expired', 'cancelled') then
        perform private.raise_exception_impl(e.lender_org_id, 'payment_on_closed_intent', 'warning', 'lender',
          jsonb_build_object('intent_id', i.id::text, 'provider_payment_id', pp.id::text));
        v_outcome := 'exception'; v_reason := 'intent_closed';
      elsif e.amount_minor is distinct from i.amount_minor or e.currency is distinct from i.currency then
        -- Never a success on a different amount: the intent stays pending and the lender is told.
        perform private.raise_exception_impl(e.lender_org_id, 'amount_mismatch', 'warning', 'lender',
          jsonb_build_object('intent_id', i.id::text, 'provider_payment_id', pp.id::text));
        v_outcome := 'exception'; v_reason := 'amount_differs';
      else
        if i.status = 'pending' then
          update payments.payment_intents set status = 'succeeded' where id = i.id;
          v_outcome := 'applied'; v_reason := 'intent_succeeded';
        else
          v_outcome := 'applied'; v_reason := 'intent_already_succeeded';
        end if;
        -- Money received is on record either way. Two things make it a matter for a person: the loan is no longer active (a refund or a
        -- closure question for the lender), or a foreclosure total was paid after its quotation had lapsed (the figure has moved on).
        select (la.status = 'active') into v_loan_active from servicing.loan_accounts la where la.id = i.loan_account_id and la.lender_org_id = i.lender_org_id;
        if i.purpose = 'foreclosure' then
          select q.valid_until into v_quote_until from servicing.foreclosure_quotes q where q.id = i.quote_id and q.lender_org_id = i.lender_org_id;
        end if;
        if not coalesce(v_loan_active, false) then
          perform private.raise_exception_impl(e.lender_org_id, 'payment_on_closed_intent', 'warning', 'lender',
            jsonb_build_object('intent_id', i.id::text, 'provider_payment_id', pp.id::text));
          v_outcome := 'exception'; v_reason := 'loan_not_active';
        elsif v_quote_until is not null and coalesce(e.occurred_at, e.received_at) > v_quote_until then
          perform private.raise_exception_impl(e.lender_org_id, 'amount_mismatch', 'warning', 'lender',
            jsonb_build_object('intent_id', i.id::text, 'provider_payment_id', pp.id::text));
          v_outcome := 'exception'; v_reason := 'quote_expired';
        end if;
      end if;
    else
      v_outcome := 'applied'; v_reason := 'payment_status_recorded';
    end if;
    perform private.record_event_processing(e.id, e.lender_org_id, v_outcome, v_reason, i.id, pp.id);
    return jsonb_build_object('outcome', v_outcome, 'reason', v_reason);
  end if;

  -- refund and chargeback
  v_adj_kind := case when e.object_kind = 'refund' and e.provider_status = 'refunded' then 'refund'
                     when e.object_kind = 'chargeback' and e.provider_status = 'disputed' then 'chargeback' end;
  if v_adj_kind is null then
    perform private.record_event_processing(e.id, e.lender_org_id, 'applied', 'no_adjustment_for_status', i.id);
    return jsonb_build_object('outcome', 'applied', 'reason', 'no_adjustment_for_status');
  end if;
  -- The payment the refund concerns: the one the provider names, or (when it names none) the intent's one and only provider payment. Never a
  -- guess: with a second payment on the intent (a duplicate capture, or an attempt in flight) and no name, a person decides.
  v_have := false;
  if e.parent_payment_ref is not null then
    select * into pp from payments.provider_payments x
     where x.lender_org_id = e.lender_org_id and x.provider = e.provider and x.provider_payment_ref = e.parent_payment_ref and x.intent_id = i.id
       and x.status = any (v_success)
     for update;
    v_have := found;
  else
    select count(*) into v_n from payments.provider_payments x where x.intent_id = i.id and x.lender_org_id = i.lender_org_id;
    if v_n > 1 then
      perform private.raise_exception_impl(e.lender_org_id, 'refund_unmatched', 'warning', 'lender', jsonb_build_object('intent_id', i.id::text, 'event_id', e.id::text));
      perform private.record_event_processing(e.id, e.lender_org_id, 'exception', 'ambiguous_payment', i.id);
      return jsonb_build_object('outcome', 'exception', 'reason', 'ambiguous_payment');
    elsif v_n = 1 then
      select * into pp from payments.provider_payments x
       where x.intent_id = i.id and x.lender_org_id = i.lender_org_id and x.status = any (v_success)
       for update;
      v_have := found;
    end if;
  end if;
  if not v_have then
    -- The refund or dispute arrived before its capture: retry for a bounded time, then it becomes an exception.
    select count(*) + 1 into v_attempt from payments.event_processing p where p.event_id = e.id and p.outcome = 'deferred';
    if v_attempt > 6 then
      perform private.raise_exception_impl(e.lender_org_id, 'refund_unmatched', 'warning', 'lender', jsonb_build_object('intent_id', i.id::text, 'event_id', e.id::text));
      perform private.record_event_processing(e.id, e.lender_org_id, 'exception', 'no_capture_found', i.id, null, v_attempt);
      return jsonb_build_object('outcome', 'exception', 'reason', 'no_capture_found');
    end if;
    v_until := clock_timestamp() + make_interval(mins => power(2, v_attempt)::integer);
    perform private.record_event_processing(e.id, e.lender_org_id, 'deferred', 'capture_not_seen_yet', i.id, null, v_attempt, v_until);
    perform ops.enqueue_event('payment.apply_event', jsonb_build_object('event_id', e.id), null, 'payment.apply_event:' || e.id::text || ':' || (v_attempt + 1)::text, v_until);
    return jsonb_build_object('outcome', 'deferred', 'reason', 'capture_not_seen_yet', 'deferred_until', v_until);
  end if;
  insert into payments.payment_adjustments (lender_org_id, provider_payment_id, kind, object_ref, amount_minor, source_event_id, occurred_at)
  values (e.lender_org_id, pp.id, v_adj_kind, e.object_ref, e.amount_minor, e.id, e.occurred_at)
  on conflict (provider_payment_id, kind, object_ref) do nothing;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    perform private.record_event_processing(e.id, e.lender_org_id, 'already_applied', 'adjustment_exists', i.id, pp.id);
    return jsonb_build_object('outcome', 'already_applied', 'reason', 'adjustment_exists');
  end if;
  select coalesce(sum(a.amount_minor), 0) into v_sum from payments.payment_adjustments a
   where a.provider_payment_id = pp.id and a.lender_org_id = pp.lender_org_id and a.kind in ('refund', 'chargeback', 'reversal');
  if pp.amount_minor is not null and v_sum > pp.amount_minor then
    perform private.raise_exception_impl(e.lender_org_id, 'amount_mismatch', 'warning', 'lender', jsonb_build_object('intent_id', i.id::text, 'provider_payment_id', pp.id::text));
    perform private.record_event_processing(e.id, e.lender_org_id, 'exception', 'adjustments_exceed_payment', i.id, pp.id);
    return jsonb_build_object('outcome', 'exception', 'reason', 'adjustments_exceed_payment');
  end if;
  perform private.record_event_processing(e.id, e.lender_org_id, 'applied', 'adjustment_recorded', i.id, pp.id);
  return jsonb_build_object('outcome', 'applied', 'reason', 'adjustment_recorded');
end
$$;
comment on function payments.apply_provider_event(uuid) is
  'System only (the worker). Idempotent: an event that already has a finished event_processing row is not applied again, and concurrent applications are serialised by an advisory lock on the event id plus the intent row lock, so exactly one application happens. payment events upsert payments.provider_payments for THIS lender (status, rank, amount): a capture is always recorded (a late capture after expired or cancelled included) and flags a second capture on the intent as duplicate_capture with a duplicate_payment exception, whenever it arrives; a status that is not a success never moves a captured payment (payment_status_conflict exception, the row and its amount are untouched); a refunded, disputed or returned status on a payment object opens a payment_status_conflict exception and changes nothing; the same provider payment reference under another intent is a platform exception; the intent moves to succeeded ONLY through the existing guard (verified event, same intent, lender, provider, a success status, equal amount and currency); a different amount keeps the intent pending and opens amount_mismatch; money on a closed intent or a loan that is no longer active opens payment_on_closed_intent; a foreclosure capture after its quotation lapsed opens amount_mismatch. A refund or chargeback becomes a compensating row in payments.payment_adjustments against the payment it names (parent_payment_ref) or, when it names none, the intent''s one and only provider payment; with a second payment on the intent and no name it is a refund_unmatched exception (nothing is guessed); it is deferred (bounded retries) when its capture has not been seen. Settlement events are recorded for reconciliation; mandate and debit events go to private.apply_mandate_event. Every state change and its event_processing row commit in one transaction.';
