-- =============================================================================================
-- Phase 08a, provider callbacks, verified events, payments, adjustments, the exception queue and the borrower payment request.
-- Spec: docs/specs/08-servicing-payments-mandates-collections.md sections 7.2, 7.3, 9 and 10 (exceptions), and the owner decisions
-- of 14 October 2026 (2: verified events and unverified receipts are separate stores; a forged callback cannot reserve a genuine
-- event id; replay protection is database-backed; an event is verified only after authentication, integrity, correlation AND
-- business validation; 9: an authentic event of an unsupported kind is stored verified-and-ignored).
--
-- What this migration does
--   1. payments.webhook_receipts   append-only record of EVERY delivery, verified or not. No raw body, signature, headers, token or
--                                  personal data. Written only by payments.ingest_provider_delivery.
--   2. payments.provider_events    becomes VERIFIED-ONLY (check) and gains the normalised fields. An unverified delivery can never
--                                  create a row here, so it can never consume a genuine event id.
--   3. payments.ingest_provider_delivery   the ONLY way a delivery enters the database (system role, the callback receiver).
--   4. payments.event_processing / provider_payments / payment_adjustments and payments.apply_provider_event (the worker): the
--                                  payment truth is staged (provider received, lender posted) and is never set by a client or an API.
--   5. payments.reconciliation_exceptions (+ append-only events): the exception queue core. Resolution is an ANNOTATION only.
--   6. payments.lender_payment_policies, payments.request_payment and the system order functions: the borrower asks, the database
--      decides from the lender's REPORTED figures; nothing a client says moves a state.
--
-- Fail closed. Every state change commits together with its event_processing row. Forward-only. Error convention: SQLSTATE and
-- hint (42501 not authorised, P0002 not found, 22023 bad input, 55000 rule or state, 23505 duplicate).
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- 0. Small helpers (no grants: only SECURITY DEFINER functions of this migration call them)
-- ---------------------------------------------------------------------------------------------
-- Subject references of an exception: ids only (uuid) or a small installment number. No text, no names, no amounts.
create or replace function private.exception_subject_ok(p_subject jsonb)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select p_subject is not null and jsonb_typeof(p_subject) = 'object' and p_subject <> '{}'::jsonb
    and not exists (
      select 1 from jsonb_each(p_subject) e
      where e.key <> all (array['intent_id', 'provider_payment_id', 'event_id', 'config_id', 'loan_account_id', 'mandate_id', 'debit_id',
                                'settlement_item_id', 'settlement_batch_id', 'receipt_id', 'run_id', 'installment_seq'])
         or jsonb_typeof(e.value) <> 'string'
         or (e.key = 'installment_seq' and (e.value #>> '{}') !~ '^[0-9]{1,6}$')
         or (e.key <> 'installment_seq' and (e.value #>> '{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
$$;

-- A short reference (an id, a document label): letters, digits and . _ : / # - only, NO spaces, so a sentence (and a name in it) cannot pass as evidence.
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
      where jsonb_typeof(e) <> 'string' or (e #>> '{}') !~ '^[A-Za-z0-9][A-Za-z0-9._:/#-]{2,99}$')
$$;

-- ---------------------------------------------------------------------------------------------
-- 1. Webhook receipts: every delivery leaves one, verified or not. Never the raw body, the signature, the headers, the token or any
--    personal data. Enough to investigate an invalid, duplicate, suspicious or replayed callback.
-- ---------------------------------------------------------------------------------------------
create table payments.webhook_receipts (
  id uuid primary key default private.uuid_v7(),
  received_at timestamptz not null default clock_timestamp(),
  provider text not null check (provider ~ '^[a-z0-9_]{1,50}$'),
  -- Known only when the routing token matched an ACTIVE configuration. An unknown, suspended or retired token leaves both null.
  lender_org_id uuid,
  config_id uuid,
  delivery_id text check (delivery_id is null or (length(delivery_id) between 4 and 200 and delivery_id ~ '^[A-Za-z0-9._:=+/-]+$')),
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  outcome text not null check (outcome in ('verified', 'verified_ignored', 'duplicate', 'unverified', 'stale_timestamp', 'unmatched', 'invalid', 'scheme_not_configured')),
  reason_class text not null check (reason_class in (
    'none', 'missing_headers', 'malformed_headers', 'no_secret', 'signature_mismatch', 'timestamp_outside_tolerance',
    'provider_scheme_not_configured', 'body_too_large', 'malformed_body', 'unsupported_event', 'invalid_amount', 'unsupported_currency',
    'invalid_timestamp', 'invalid_identifier', 'token_unknown_or_inactive', 'provider_mismatch', 'merchant_mismatch', 'order_ref_missing',
    'order_ref_unknown', 'mandate_unknown', 'amount_missing', 'currency_invalid', 'status_invalid', 'malformed_event',
    'event_payload_conflict', 'replayed_delivery', 'verifier_outcome_unknown')),
  -- Investigation metadata without sensitive content.
  scheme text check (scheme is null or scheme ~ '^[a-z0-9][a-z0-9._-]{0,79}$'),
  signature_present boolean not null default false,
  timestamp_skew_seconds integer check (timestamp_skew_seconds is null or abs(timestamp_skew_seconds) <= 31536000),
  body_bytes integer check (body_bytes is null or body_bytes between 0 and 104857600),
  -- Keyed hash of the source address computed by the RECEIVER; the address itself is never stored.
  source_ip_hmac text check (source_ip_hmac is null or source_ip_hmac ~ '^[0-9a-f]{64}$'),
  -- The verified event this delivery carried or repeated (set for verified, verified_ignored and duplicate).
  event_id uuid,
  constraint receipt_config_matches_lender check ((config_id is null) = (lender_org_id is null)),
  constraint receipt_outcome_reason check (
    (outcome in ('verified', 'verified_ignored') and reason_class = 'none')
    or outcome not in ('verified', 'verified_ignored')),
  foreign key (config_id, lender_org_id) references payments.lender_payment_configs (id, lender_org_id) on delete restrict
);
create index webhook_receipts_config on payments.webhook_receipts (config_id, lender_org_id, received_at desc);
create index webhook_receipts_event on payments.webhook_receipts (event_id);
create index webhook_receipts_outcome on payments.webhook_receipts (outcome, received_at desc);
create index webhook_receipts_payload on payments.webhook_receipts (provider, payload_sha256);
comment on table payments.webhook_receipts is
  'One row per inbound provider delivery, whatever its outcome (verified, verified_ignored, duplicate, unverified, stale_timestamp, unmatched, invalid, scheme_not_configured). Append-only. NEVER the raw body, the signature, the headers, the routing token or any personal data: the payload hash, the scheme name, whether a signature was present, the timestamp skew, the body size and a keyed hash of the source address computed by the receiver. An unverified, stale, invalid or unmatched delivery writes ONLY here: it never touches provider_events, the replay store or any payment, mandate or reminder. Written only by payments.ingest_provider_delivery. Platform users with platform.payments.providers.manage read it; lenders read a summary (payments.lender_webhook_summary). Owner: payments module.';
create trigger append_only before update or delete on payments.webhook_receipts
  for each row execute function private.forbid_mutation();
create trigger no_truncate before truncate on payments.webhook_receipts
  for each statement execute function private.forbid_truncate();

-- ---------------------------------------------------------------------------------------------
-- 2. provider_events: VERIFIED ONLY, with the normalised fields the worker needs
-- ---------------------------------------------------------------------------------------------
alter table payments.provider_events
  add column config_id uuid,
  add column object_kind text check (object_kind is null or object_kind in ('payment', 'refund', 'chargeback', 'mandate', 'debit', 'settlement', 'unsupported')),
  add column object_ref text check (object_ref is null or (length(object_ref) between 1 and 200 and object_ref ~ '^[A-Za-z0-9._:=+/-]+$')),
  add column order_ref text check (order_ref is null or (length(order_ref) between 1 and 200 and order_ref ~ '^[A-Za-z0-9._:=+/-]+$')),
  add column rank integer check (rank is null or rank between 0 and 100),
  add column occurred_at timestamptz,
  add column verification_stages jsonb check (verification_stages is null or (
    jsonb_typeof(verification_stages) = 'object'
    and (verification_stages ->> 'authentication') = 'matched'
    and (verification_stages ->> 'integrity') = 'matched'
    and (verification_stages ->> 'correlation') in ('matched', 'not_applicable')
    and (verification_stages ->> 'business') in ('passed', 'not_applicable'))),
  add column processing_class text check (processing_class is null or processing_class in ('actionable', 'ignored')),
  add constraint provider_events_verified_only check (signature_verified),
  add constraint provider_events_normalised_together check (
    (object_kind is null) = (processing_class is null) and (object_kind is null) = (verification_stages is null)),
  add constraint provider_events_config_fk foreign key (config_id, lender_org_id) references payments.lender_payment_configs (id, lender_org_id) on delete restrict;
create index provider_events_config on payments.provider_events (config_id, lender_org_id);
alter table payments.webhook_receipts
  add constraint webhook_receipts_event_fk foreign key (event_id) references payments.provider_events (id) on delete restrict;
comment on table payments.provider_events is
  'VERIFIED provider events only (check signature_verified): authenticated, integrity-checked, correlated to the lender''s own configuration and intent where the kind needs it, and business-valid. Anything that fails goes to payments.webhook_receipts instead and never takes an event id from the genuine provider. Unique (provider, provider_event_id). Append-only. object_kind unsupported = an authentic event of a kind the platform does not handle, stored verified-and-ignored (processing_class ignored): it changes no state. Written only by payments.ingest_provider_delivery. Owner: payments module.';
revoke insert, update, delete, truncate, references, trigger on payments.provider_events from service_role;
grant select on payments.provider_events to service_role;

-- ---------------------------------------------------------------------------------------------
-- 3. Exceptions (the queue core; reconciliation builds runs and matches on top of it)
-- ---------------------------------------------------------------------------------------------
create table payments.reconciliation_exceptions (
  id uuid primary key default private.uuid_v7(),
  lender_org_id uuid not null references tenancy.organizations (id) on delete restrict,
  class text not null check (class in (
    'provider_success_no_settlement', 'settlement_no_intent', 'amount_mismatch', 'duplicate_payment', 'lender_receipt_missing',
    'lender_receipt_no_intent', 'refund_unmatched', 'settlement_account_mismatch', 'merchant_mismatch', 'late_settlement', 'stale_sync',
    'mandate_debit_unresolved', 'webhook_gap', 'event_payload_conflict', 'payment_status_conflict', 'payment_on_closed_intent',
    'penal_text_missing')),
  severity text not null check (severity in ('info', 'warning', 'critical')),
  owner text not null check (owner in ('lender', 'platform')),
  status text not null default 'open' check (status in ('open', 'acknowledged', 'assigned', 'resolved', 'reopened')),
  -- Ids only (private.exception_subject_ok). subject_key is the canonical text of it: one OPEN exception per (lender, class, subject).
  subject jsonb not null check (private.exception_subject_ok(subject)),
  subject_key text not null check (length(subject_key) between 10 and 600),
  assigned_to uuid references auth.users (id),
  opened_at timestamptz not null default clock_timestamp(),
  resolved_at timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  unique (id, lender_org_id),
  constraint resolved_has_time check ((status = 'resolved') = (resolved_at is not null)),
  constraint assigned_has_user check (status <> 'assigned' or assigned_to is not null)
);
create unique index reconciliation_exceptions_open_subject on payments.reconciliation_exceptions (lender_org_id, class, subject_key)
  where status <> 'resolved';
create index reconciliation_exceptions_queue on payments.reconciliation_exceptions (lender_org_id, status, opened_at);
create index reconciliation_exceptions_assignee on payments.reconciliation_exceptions (assigned_to);
comment on table payments.reconciliation_exceptions is
  'The exception queue: something the platform noticed that a person at the lender or the platform must look at (an amount that differs, a second capture, a refund without its capture, a settlement to the wrong account, a missing penal-charge text). class is a CLOSED list; the subject holds ids only; one open exception per (lender, class, subject). status open -> acknowledged -> assigned -> resolved, resolved -> reopened. A resolution is an ANNOTATION: it changes no amount, creates no balancing entry and touches no intent, mandate or settlement stage. Never deleted. Raised only by the system (payments.raise_exception and the ingest / apply / reconciliation functions); handled by payments.acknowledge_exception / assign_exception / resolve_exception / reopen_exception. Owner: payments module.';
create trigger no_delete before delete on payments.reconciliation_exceptions
  for each row execute function private.forbid_mutation();
create trigger no_truncate before truncate on payments.reconciliation_exceptions
  for each statement execute function private.forbid_truncate();
create trigger set_updated_at before update on payments.reconciliation_exceptions
  for each row execute function private.set_updated_at();

create table payments.reconciliation_exception_events (
  id uuid primary key default private.uuid_v7(),
  exception_id uuid not null,
  lender_org_id uuid not null,
  action text not null check (action in ('opened', 'acknowledged', 'assigned', 'resolved', 'reopened')),
  actor_kind text not null check (actor_kind in ('system', 'lender_user', 'platform_user')),
  actor_user_id uuid references auth.users (id),
  -- Closed list; required for resolve and reopen.
  reason_code text check (reason_code is null or reason_code in (
    'verified_with_provider', 'refunded_by_provider', 'posted_by_lender', 'duplicate_confirmed', 'timing_difference', 'no_action_needed',
    'escalated_to_provider', 'escalated_to_lender', 'documented_elsewhere', 'raised_in_error', 'new_information')),
  -- What was reviewed, as ids or short labels. REQUIRED, non-empty, for resolve.
  evidence jsonb check (evidence is null or private.evidence_labels_ok(evidence)),
  note text check (note is null or length(note) <= 500),
  assigned_to uuid references auth.users (id),
  -- The permission that authorised the action (null for the system).
  authorised_by_permission text check (authorised_by_permission is null or authorised_by_permission in ('payment.reconcile', 'platform.payments.providers.manage')),
  occurred_at timestamptz not null default clock_timestamp(),
  foreign key (exception_id, lender_org_id) references payments.reconciliation_exceptions (id, lender_org_id) on delete restrict,
  constraint system_has_no_user check ((actor_kind = 'system') = (actor_user_id is null and authorised_by_permission is null)),
  constraint resolve_needs_reason_and_evidence check (action <> 'resolved' or (reason_code is not null and evidence is not null and actor_kind <> 'system')),
  constraint reopen_needs_reason check (action <> 'reopened' or (reason_code is not null and actor_kind <> 'system')),
  constraint assign_needs_assignee check ((action = 'assigned') = (assigned_to is not null))
);
create index reconciliation_exception_events_exception on payments.reconciliation_exception_events (exception_id, lender_org_id, occurred_at);
create index reconciliation_exception_events_actor on payments.reconciliation_exception_events (actor_user_id);
create index reconciliation_exception_events_assignee on payments.reconciliation_exception_events (assigned_to);
comment on table payments.reconciliation_exception_events is
  'Append-only history of an exception: opened by the system, acknowledged, assigned, resolved (with a closed-list reason, the evidence reviewed as a non-empty list of ids or labels, and a short note) and reopened, each with the person and the permission that authorised it. Written only by the exception functions. Owner: payments module.';
create trigger unsafe_text before insert on payments.reconciliation_exception_events
  for each row execute function onboarding.reject_unsafe_text('note');
create trigger append_only before update or delete on payments.reconciliation_exception_events
  for each row execute function private.forbid_mutation();
create trigger no_truncate before truncate on payments.reconciliation_exception_events
  for each statement execute function private.forbid_truncate();

-- Raise (or find) the open exception for (lender, class, subject). Idempotent. Internal: callers are the system functions below.
create or replace function private.raise_exception_impl(p_lender uuid, p_class text, p_severity text, p_owner text, p_subject jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text;
  v_id uuid;
begin
  if not private.exception_subject_ok(p_subject) then
    raise exception 'an exception subject holds ids only' using errcode = '22023', hint = 'subject_invalid';
  end if;
  -- Checked here as well as by the table, so a bad value is refused even when the exception is already open (the class is checked by the table:
  -- an unknown class cannot already be open).
  if p_severity is null or p_severity not in ('info', 'warning', 'critical') or p_owner is null or p_owner not in ('lender', 'platform') then
    raise exception 'severity and owner come from closed lists' using errcode = '22023', hint = 'severity_invalid';
  end if;
  select string_agg(e.key || '=' || (e.value #>> '{}'), ',' order by e.key) into v_key from jsonb_each(p_subject) e;
  select x.id into v_id from payments.reconciliation_exceptions x
   where x.lender_org_id = p_lender and x.class = p_class and x.subject_key = v_key and x.status <> 'resolved';
  if found then
    return v_id;
  end if;
  begin
    insert into payments.reconciliation_exceptions (lender_org_id, class, severity, owner, subject, subject_key)
    values (p_lender, p_class, p_severity, p_owner, p_subject, v_key)
    returning id into v_id;
  exception when unique_violation then
    select x.id into v_id from payments.reconciliation_exceptions x
     where x.lender_org_id = p_lender and x.class = p_class and x.subject_key = v_key and x.status <> 'resolved';
    return v_id;
  end;
  insert into payments.reconciliation_exception_events (exception_id, lender_org_id, action, actor_kind) values (v_id, p_lender, 'opened', 'system');
  return v_id;
end
$$;
revoke all on function private.raise_exception_impl(uuid, text, text, text, jsonb) from public;

create or replace function payments.raise_exception(p_lender uuid, p_class text, p_severity text, p_owner text, p_subject jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
begin
  if private.invoking_role() <> 'service_role' then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  if not exists (select 1 from tenancy.organizations o where o.id = p_lender and o.kind = 'lender') then
    raise exception 'lender not found' using errcode = 'P0002';
  end if;
  return private.raise_exception_impl(p_lender, p_class, p_severity, p_owner, p_subject);
end
$$;
comment on function payments.raise_exception(uuid, text, text, text, jsonb) is
  'System only. Opens (or returns the already open) exception for (lender, class, subject). class and severity are checked against the closed lists by the table, the subject must hold ids only (22023 subject_invalid). Idempotent.';

-- Who may act on an exception: a lender user with payment.reconcile for lender-owned ones; a platform user with
-- platform.payments.providers.manage for platform-owned ones. Returns (user id, actor kind, permission).
create or replace function private.exception_actor(p_exception uuid)
returns table (x_user uuid, x_kind text, x_perm text, x_lender uuid, x_owner text, x_status text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  e payments.reconciliation_exceptions;
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  select * into e from payments.reconciliation_exceptions x where x.id = p_exception;
  if not found or not (
       e.lender_org_id in (select private.orgs_with_permission('payment.read'))
       or e.lender_org_id in (select private.orgs_with_permission('payment.reconcile'))
       or private.has_platform_permission('platform.payments.providers.manage')) then
    raise exception 'exception not found' using errcode = 'P0002';
  end if;
  if e.owner = 'platform' then
    if not private.has_platform_permission('platform.payments.providers.manage') then
      raise exception 'not authorised' using errcode = '42501';
    end if;
    perform private.require_aal2();
    return query select v_uid, 'platform_user'::text, 'platform.payments.providers.manage'::text, e.lender_org_id, e.owner, e.status;
  else
    if e.lender_org_id not in (select private.orgs_with_permission('payment.reconcile')) then
      raise exception 'not authorised' using errcode = '42501';
    end if;
    perform private.require_aal2();
    return query select v_uid, 'lender_user'::text, 'payment.reconcile'::text, e.lender_org_id, e.owner, e.status;
  end if;
end
$$;
revoke all on function private.exception_actor(uuid) from public;

create or replace function payments.acknowledge_exception(p_exception uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  a record;
begin
  select * into a from private.exception_actor(p_exception);
  if a.x_status = 'acknowledged' then return 'acknowledged'; end if;
  if a.x_status not in ('open', 'reopened') then
    raise exception 'only an open exception can be acknowledged' using errcode = '55000', hint = 'exception_state_invalid';
  end if;
  update payments.reconciliation_exceptions set status = 'acknowledged' where id = p_exception;
  insert into payments.reconciliation_exception_events (exception_id, lender_org_id, action, actor_kind, actor_user_id, authorised_by_permission)
  values (p_exception, a.x_lender, 'acknowledged', a.x_kind, a.x_user, a.x_perm);
  perform private.write_payments_audit(a.x_lender, 'payments.exception.acknowledged', 'reconciliation_exception', p_exception::text, '{}'::jsonb);
  return 'acknowledged';
end
$$;

create or replace function payments.assign_exception(p_exception uuid, p_assignee uuid)
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
    raise exception 'a resolved exception cannot be assigned' using errcode = '55000', hint = 'exception_state_invalid';
  end if;
  -- The assignee must be someone who may act on it.
  if p_assignee is null or not (
       (a.x_owner = 'lender' and private.user_has_permission_in_org(p_assignee, a.x_lender, 'payment.reconcile'))
       or (a.x_owner = 'platform' and private.user_holds_platform_permission(p_assignee, 'platform.payments.providers.manage'))) then
    raise exception 'the assignee cannot act on this exception' using errcode = '22023', hint = 'assignee_invalid';
  end if;
  update payments.reconciliation_exceptions set status = 'assigned', assigned_to = p_assignee where id = p_exception;
  insert into payments.reconciliation_exception_events (exception_id, lender_org_id, action, actor_kind, actor_user_id, assigned_to, authorised_by_permission)
  values (p_exception, a.x_lender, 'assigned', a.x_kind, a.x_user, p_assignee, a.x_perm);
  perform private.write_payments_audit(a.x_lender, 'payments.exception.assigned', 'reconciliation_exception', p_exception::text, '{}'::jsonb);
  return 'assigned';
end
$$;

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
    raise exception 'the evidence reviewed must be a list of 1 to 10 short ids or labels' using errcode = '22023', hint = 'evidence_required';
  end if;
  if p_note is not null and length(p_note) > 500 then
    raise exception 'a note is at most 500 characters' using errcode = '22023', hint = 'reason_invalid';
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
  update payments.reconciliation_exceptions set status = 'reopened', resolved_at = null where id = p_exception;
  insert into payments.reconciliation_exception_events (exception_id, lender_org_id, action, actor_kind, actor_user_id, reason_code, note, authorised_by_permission)
  values (p_exception, a.x_lender, 'reopened', a.x_kind, a.x_user, p_reason_code, p_note, a.x_perm);
  perform private.write_payments_audit(a.x_lender, 'payments.exception.reopened', 'reconciliation_exception', p_exception::text, jsonb_build_object('reason_code', p_reason_code));
  return 'reopened';
end
$$;

-- ---------------------------------------------------------------------------------------------
-- 4. Provider payments, adjustments and the processing log
-- ---------------------------------------------------------------------------------------------
create table payments.provider_payments (
  id uuid primary key default private.uuid_v7(),
  lender_org_id uuid not null,
  config_id uuid not null,
  provider text not null check (provider ~ '^[a-z0-9_]{1,50}$'),
  provider_payment_ref text not null check (length(provider_payment_ref) between 1 and 200 and provider_payment_ref ~ '^[A-Za-z0-9._:=+/-]+$'),
  order_ref text not null check (length(order_ref) between 1 and 200 and order_ref ~ '^[A-Za-z0-9._:=+/-]+$'),
  intent_id uuid not null,
  loan_account_id uuid not null,
  -- The platform status vocabulary of the newest applied event, its rank, and the figures the provider reported.
  status text not null check (status in ('created', 'pending', 'authorized', 'captured', 'paid', 'succeeded', 'failed', 'refunded', 'disputed', 'cancelled', 'expired')),
  rank integer not null check (rank between 0 and 100),
  amount_minor bigint check (amount_minor is null or amount_minor between 0 and 100000000000000),
  currency char(3) check (currency is null or currency = 'INR'),
  captured_at timestamptz,
  -- A second capture on an order that already had one.
  duplicate_capture boolean not null default false,
  first_event_id uuid not null references payments.provider_events (id) on delete restrict,
  last_event_id uuid not null references payments.provider_events (id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (provider, provider_payment_ref),
  unique (id, lender_org_id),
  foreign key (config_id, lender_org_id) references payments.lender_payment_configs (id, lender_org_id) on delete restrict,
  foreign key (intent_id, lender_org_id) references payments.payment_intents (id, lender_org_id) on delete restrict,
  foreign key (loan_account_id, lender_org_id) references servicing.loan_accounts (id, lender_org_id) on delete restrict
);
create index provider_payments_intent on payments.provider_payments (intent_id, lender_org_id);
create index provider_payments_config on payments.provider_payments (config_id, lender_org_id);
create index provider_payments_loan on payments.provider_payments (loan_account_id, lender_org_id);
create index provider_payments_first_event on payments.provider_payments (first_event_id);
create index provider_payments_last_event on payments.provider_payments (last_event_id);
comment on table payments.provider_payments is
  'What the PAYMENT PROVIDER reported about each payment attempt (not what the lender posted, not what settled). One row per (provider, provider payment reference), moved forward only by higher-ranked verified events (status, rank, amount, last event); everything else is immutable. A second capture on an order is a separate row with duplicate_capture = true and a duplicate_payment exception. It is the first stage of the payment truth (provider_received); lender_posted comes from the lender''s own receipt. No client, API or user can write it: only payments.apply_provider_event. Owner: payments module.';
create trigger no_delete before delete on payments.provider_payments
  for each row execute function private.forbid_mutation();
create trigger no_truncate before truncate on payments.provider_payments
  for each statement execute function private.forbid_truncate();

create or replace function private.protect_provider_payment()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (to_jsonb(new) - array['status', 'rank', 'amount_minor', 'currency', 'captured_at', 'last_event_id', 'updated_at'])
     is distinct from (to_jsonb(old) - array['status', 'rank', 'amount_minor', 'currency', 'captured_at', 'last_event_id', 'updated_at']) then
    raise exception 'a provider payment keeps its identity, intent and first event' using errcode = 'P0001';
  end if;
  if new.rank < old.rank then
    raise exception 'a provider payment only moves to a higher rank' using errcode = 'P0001';
  end if;
  return new;
end
$$;
revoke all on function private.protect_provider_payment() from public;
create trigger protect before update on payments.provider_payments
  for each row execute function private.protect_provider_payment();
create trigger set_updated_at before update on payments.provider_payments
  for each row execute function private.set_updated_at();

create table payments.payment_adjustments (
  id uuid primary key default private.uuid_v7(),
  lender_org_id uuid not null,
  provider_payment_id uuid not null,
  kind text not null check (kind in ('refund', 'chargeback', 'reversal', 'correction')),
  -- The provider's id of the refund or dispute: one adjustment per object.
  object_ref text not null check (length(object_ref) between 1 and 200 and object_ref ~ '^[A-Za-z0-9._:=+/-]+$'),
  amount_minor bigint not null check (amount_minor > 0 and amount_minor <= 100000000000000),
  currency char(3) not null default 'INR' check (currency = 'INR'),
  source_event_id uuid not null references payments.provider_events (id) on delete restrict,
  occurred_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  unique (provider_payment_id, kind, object_ref),
  unique (source_event_id),
  foreign key (provider_payment_id, lender_org_id) references payments.provider_payments (id, lender_org_id) on delete restrict
);
create index payment_adjustments_payment on payments.payment_adjustments (provider_payment_id, lender_org_id);
comment on table payments.payment_adjustments is
  'Compensating rows for a provider payment: refund, chargeback, reversal or correction, always a POSITIVE amount, referencing the provider payment and the verified event that reported it. The intent''s amount, parties and succeeded status are never edited; net received is a view for reconciliation and is not a loan balance. Append-only. Written only by payments.apply_provider_event. Owner: payments module.';
create trigger append_only before update or delete on payments.payment_adjustments
  for each row execute function private.forbid_mutation();
create trigger no_truncate before truncate on payments.payment_adjustments
  for each statement execute function private.forbid_truncate();

create table payments.event_processing (
  id uuid primary key default private.uuid_v7(),
  event_id uuid not null references payments.provider_events (id) on delete restrict,
  lender_org_id uuid,
  outcome text not null check (outcome in ('applied', 'already_applied', 'ignored_stale', 'deferred', 'exception', 'ignored_unsupported', 'ignored_unsupported_yet', 'recorded_for_reconciliation')),
  reason_class text not null check (reason_class ~ '^[a-z][a-z0-9_]{2,60}$'),
  intent_id uuid,
  provider_payment_id uuid,
  attempt integer not null default 1 check (attempt between 1 and 50),
  deferred_until timestamptz,
  processed_at timestamptz not null default clock_timestamp(),
  constraint deferred_has_time check ((outcome = 'deferred') = (deferred_until is not null)),
  foreign key (intent_id, lender_org_id) references payments.payment_intents (id, lender_org_id) on delete restrict,
  foreign key (provider_payment_id, lender_org_id) references payments.provider_payments (id, lender_org_id) on delete restrict
);
create index event_processing_event on payments.event_processing (event_id, processed_at);
create index event_processing_intent on payments.event_processing (intent_id, lender_org_id);
create index event_processing_payment on payments.event_processing (provider_payment_id, lender_org_id);
create index event_processing_lender on payments.event_processing (lender_org_id, processed_at desc);
comment on table payments.event_processing is
  'Append-only log of what the worker did with each verified event: applied, already_applied, ignored_stale, deferred (with a retry time), exception, ignored_unsupported, ignored_unsupported_yet, recorded_for_reconciliation. Every state change and its row commit in one transaction. An event with a row other than deferred is finished: applying it again does nothing. Written only by payments.apply_provider_event and payments.ingest_provider_delivery (for an ignored event). Owner: payments module.';
create trigger append_only before update or delete on payments.event_processing
  for each row execute function private.forbid_mutation();
create trigger no_truncate before truncate on payments.event_processing
  for each statement execute function private.forbid_truncate();

-- ---------------------------------------------------------------------------------------------
-- 5. The lender's payment policy and the intent additions
-- ---------------------------------------------------------------------------------------------
-- What amounts the lender accepts beyond the exact reported figure. No row = exact amounts only, no part-prepayment.
create table payments.lender_payment_policies (
  lender_org_id uuid primary key references tenancy.organizations (id) on delete restrict,
  allow_partial_payments boolean not null default false,
  min_partial_amount_minor bigint check (min_partial_amount_minor is null or min_partial_amount_minor > 0),
  allow_part_prepayment boolean not null default false,
  min_part_prepayment_minor bigint check (min_part_prepayment_minor is null or min_part_prepayment_minor > 0),
  link_validity_minutes integer not null default 60 check (link_validity_minutes between 5 and 10080),
  updated_by uuid not null references auth.users (id),
  updated_at timestamptz not null default clock_timestamp(),
  constraint partial_needs_minimum check (not allow_partial_payments or min_partial_amount_minor is not null),
  constraint prepayment_needs_minimum check (not allow_part_prepayment or min_part_prepayment_minor is not null)
);
create index lender_payment_policies_updated_by on payments.lender_payment_policies (updated_by);
comment on table payments.lender_payment_policies is
  'Per lender: whether it accepts a payment smaller than the reported installment or overdue figure (and the minimum), whether it accepts a part-prepayment (and the minimum), and how long a payment link stays valid. Udofin never decides an amount: this only records what the LENDER accepts. No row means exact amounts only and no part-prepayment. Written only by payments.set_payment_policy (payment.configure, aal2, audited). Owner: payments module.';
create trigger no_delete before delete on payments.lender_payment_policies
  for each row execute function private.forbid_mutation();
create trigger no_truncate before truncate on payments.lender_payment_policies
  for each statement execute function private.forbid_truncate();

alter table payments.payment_intents
  add column quote_id uuid,
  add column target_installment_seq integer check (target_installment_seq is null or target_installment_seq between 1 and 100000),
  add column link_expires_at timestamptz,
  add constraint payment_intents_quote_fk foreign key (quote_id, lender_org_id) references servicing.foreclosure_quotes (id, lender_org_id) on delete restrict,
  add constraint payment_intents_quote_only_foreclosure check ((purpose = 'foreclosure') = (quote_id is not null));
create index payment_intents_quote on payments.payment_intents (quote_id, lender_org_id);
-- One open intent per loan, purpose and installment: a second request while the first is created or pending is refused.
create unique index payment_intents_one_open on payments.payment_intents (loan_account_id, purpose, coalesce(target_installment_seq, 0))
  where status in ('created', 'pending');

-- Borrowers no longer insert intents directly: payments.request_payment is the only way (amount rules from the lender's reported figures).
drop policy if exists intents_borrower_insert on payments.payment_intents;
revoke insert on payments.payment_intents from authenticated;
-- The system role moves intents only through the functions below.
revoke insert, update, delete, truncate, references, trigger on payments.payment_intents from service_role;
grant select on payments.payment_intents to service_role;

-- The immutability guard now also lets link_expires_at change once, while the intent is still created (the provider's real expiry replaces the
-- provisional one). Everything else of the earlier guard is preserved.
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

  if (to_jsonb(new) - array['status', 'provider_order_ref', 'updated_at', 'link_expires_at'])
     is distinct from (to_jsonb(old) - array['status', 'provider_order_ref', 'updated_at', 'link_expires_at']) then
    raise exception 'payment intent amount, account and parties are immutable' using errcode = 'P0001';
  end if;
  if new.link_expires_at is distinct from old.link_expires_at and old.status <> 'created' then
    raise exception 'the link expiry is fixed once the order exists' using errcode = 'P0001';
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
    -- Success needs ONE event that is signature-verified, belongs to this intent, lender and provider, carries a
    -- success status from the list above and reports exactly the intent's amount. A failed, unverified, mismatching
    -- or amount-less event proves nothing.
    if new.status = 'succeeded' and not exists (
      select 1 from payments.provider_events pe
      where pe.payment_intent_id = new.id
        and pe.lender_org_id = new.lender_org_id
        and pe.provider = new.provider
        and pe.signature_verified
        and pe.provider_status = any (private.payment_success_statuses())
        and pe.amount_minor is not null
        and pe.amount_minor = new.amount_minor
        and pe.currency is not null
        and pe.currency = new.currency
    ) then
      raise exception 'a payment can be marked succeeded only after a signature-verified provider event with a success status, the same amount and the same currency'
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end
$$;

create or replace function payments.set_payment_policy(
  p_lender uuid, p_allow_partial boolean, p_min_partial_minor bigint, p_allow_part_prepayment boolean, p_min_part_prepayment_minor bigint, p_link_validity_minutes integer)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.payments_require_lender(p_lender, 'payment.configure');
begin
  if p_allow_partial is null or p_allow_part_prepayment is null or p_link_validity_minutes is null or p_link_validity_minutes not between 5 and 10080
     or (p_allow_partial and (p_min_partial_minor is null or p_min_partial_minor <= 0))
     or (p_allow_part_prepayment and (p_min_part_prepayment_minor is null or p_min_part_prepayment_minor <= 0))
     or (p_min_partial_minor is not null and p_min_partial_minor <= 0) or (p_min_part_prepayment_minor is not null and p_min_part_prepayment_minor <= 0) then
    raise exception 'invalid payment policy' using errcode = '22023', hint = 'policy_invalid';
  end if;
  insert into payments.lender_payment_policies (lender_org_id, allow_partial_payments, min_partial_amount_minor, allow_part_prepayment, min_part_prepayment_minor,
                                                link_validity_minutes, updated_by)
  values (p_lender, p_allow_partial, case when p_allow_partial then p_min_partial_minor end, p_allow_part_prepayment,
          case when p_allow_part_prepayment then p_min_part_prepayment_minor end, p_link_validity_minutes, v_uid)
  on conflict (lender_org_id) do update set
    allow_partial_payments = excluded.allow_partial_payments, min_partial_amount_minor = excluded.min_partial_amount_minor,
    allow_part_prepayment = excluded.allow_part_prepayment, min_part_prepayment_minor = excluded.min_part_prepayment_minor,
    link_validity_minutes = excluded.link_validity_minutes, updated_by = excluded.updated_by, updated_at = clock_timestamp();
  perform private.write_payments_audit(p_lender, 'payments.policy.set', 'payment_policy', p_lender::text,
    jsonb_build_object('allow_partial', p_allow_partial, 'allow_part_prepayment', p_allow_part_prepayment, 'link_validity_minutes', p_link_validity_minutes));
  return 'set';
end
$$;

-- ---------------------------------------------------------------------------------------------
-- 6. The borrower asks for a payment. The database decides from the lender's REPORTED figures (spec 7.2).
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
  q servicing.foreclosure_quotes;
  v_due bigint;
  v_seq integer;
  v_id uuid;
  v_validity integer;
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

  if p_purpose = 'foreclosure' then
    -- Exactly the amount of the newest unexpired quotation the lender reported, and never one whose parts do not add up.
    select * into q from servicing.latest_valid_quote(p_loan);
    if not found then
      raise exception 'there is no unexpired foreclosure quotation' using errcode = '55000', hint = 'quote_required';
    end if;
    if p_quote is not null and p_quote <> q.id then
      raise exception 'the quotation is not the current one' using errcode = '55000', hint = 'quote_not_current';
    end if;
    if q.total_mismatch then
      raise exception 'the lender''s quotation does not add up: ask the lender for a corrected one' using errcode = '55000', hint = 'quote_flagged';
    end if;
    if p_amount_minor <> q.total_minor then
      raise exception 'the amount must equal the lender''s quotation' using errcode = '22023', hint = 'amount_not_allowed';
    end if;
    v_validity := least(v_validity, greatest(5, floor(extract(epoch from (q.valid_until - clock_timestamp())) / 60)::integer));
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

  begin
    insert into payments.payment_intents (lender_org_id, loan_account_id, borrower_id, purpose, amount_minor, provider, config_id, idempotency_key, created_by,
                                          quote_id, target_installment_seq, link_expires_at)
    values (l.lender_org_id, p_loan, v_borrower, p_purpose, p_amount_minor, v_cfg.provider, v_cfg.id, p_idempotency_key, v_uid,
            q.id, v_seq, clock_timestamp() + make_interval(mins => v_validity))
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
  'The ONLY way an intent is created. The signed-in borrower asks to pay their own active loan. Needs the payments switch, an active valid collection configuration (payments.validate_collection_target), and the lender''s REPORTED figures: installment / overdue = the reported next-due / total-overdue figure, or a part the lender accepts (payments.lender_payment_policies); part_prepayment = between the lender''s minimum and the reported outstanding principal, only if enabled; foreclosure = exactly the unexpired lender quotation (servicing.latest_valid_quote, never a flagged one); charges are refused (purpose_not_supported). Stale or disputed figures block it (stale_data, figures_unavailable). Idempotent on (lender, key). One open intent per loan, purpose and installment. Enqueues payment.create_order (ids only). There is no function that accepts a success flag.';

-- System-only order lifecycle -------------------------------------------------------------------------
create or replace function payments.record_order_created(p_intent uuid, p_provider_order_ref text, p_link_expires_at timestamptz default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  i payments.payment_intents;
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
  if i.status <> 'created' then
    if i.provider_order_ref = p_provider_order_ref then return i.status::text; end if;
    raise exception 'the order can be recorded only for a created intent' using errcode = '55000', hint = 'intent_state_invalid';
  end if;
  update payments.payment_intents set provider_order_ref = p_provider_order_ref, status = 'pending', link_expires_at = coalesce(p_link_expires_at, link_expires_at)
   where id = p_intent;
  return 'pending';
end
$$;

create or replace function payments.record_order_failed(p_intent uuid, p_reason_class text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  i payments.payment_intents;
begin
  if private.invoking_role() <> 'service_role' then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  if p_reason_class is null or p_reason_class not in ('provider_rejected', 'provider_unavailable', 'merchant_mismatch', 'invalid_request') then
    raise exception 'unknown failure class' using errcode = '22023', hint = 'reason_invalid';
  end if;
  select * into i from payments.payment_intents x where x.id = p_intent for update;
  if not found then
    raise exception 'intent not found' using errcode = 'P0002';
  end if;
  if i.status = 'failed' then return 'failed'; end if;
  if i.status <> 'created' then
    raise exception 'only a created intent can fail at order creation' using errcode = '55000', hint = 'intent_state_invalid';
  end if;
  update payments.payment_intents set status = 'failed' where id = p_intent;
  -- The provider answered with a different merchant than the configuration names: stop taking payments for this lender and tell both sides.
  if p_reason_class = 'merchant_mismatch' then
    perform payments.system_suspend_payment_config(i.config_id, 'merchant_mismatch');
    perform private.raise_exception_impl(i.lender_org_id, 'merchant_mismatch', 'critical', 'platform', jsonb_build_object('intent_id', i.id::text, 'config_id', i.config_id::text));
  end if;
  perform private.write_payments_audit(i.lender_org_id, 'payments.intent.order_failed', 'payment_intent', p_intent::text, jsonb_build_object('reason_class', p_reason_class));
  return 'failed';
end
$$;

-- Intents whose link has expired (plus a grace period) without any provider payment recorded for them. The worker looks the order up at the
-- provider first; an intent with any provider payment stays as it is for a person to look at.
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
  update payments.payment_intents i set status = 'expired'
   where i.status in ('created', 'pending') and i.link_expires_at is not null and i.link_expires_at + p_grace < clock_timestamp()
     and not exists (select 1 from payments.provider_payments pp where pp.intent_id = i.id and pp.lender_org_id = i.lender_org_id);
  get diagnostics v_n = row_count;
  return v_n;
end
$$;

-- What the borrower sees: an honest stage, derived ONLY from the provider's verified events and the lender's own receipts.
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
    select r.value_date into v_posted from servicing.lms_receipts r
     where r.loan_account_id = i.loan_account_id and r.lender_org_id = i.lender_org_id and r.kind = 'receipt'
       and r.bank_reference in (v_pp.provider_payment_ref, i.id::text) and r.amount_minor = v_pp.amount_minor
       and not exists (select 1 from servicing.lms_receipts rv where rv.reverses_receipt_id = r.id)
     order by r.value_date limit 1;
  end if;
  v_attention := exists (select 1 from payments.reconciliation_exceptions e
                          where e.lender_org_id = i.lender_org_id and e.status <> 'resolved' and e.subject ->> 'intent_id' = i.id::text)
                 or (v_pp.id is not null and v_pp.amount_minor is distinct from i.amount_minor)
                 or (i.status in ('failed', 'expired', 'cancelled') and exists (select 1 from payments.provider_payments pp where pp.intent_id = i.id and pp.lender_org_id = i.lender_org_id));
  return query select i.id, i.status::text,
    case when v_attention then 'needs_attention'
         when v_posted is not null then 'lender_posted'
         when v_pp.id is not null then 'provider_received'
         else 'started' end,
    v_pp.captured_at, v_posted;
end
$$;
comment on function payments.my_payment(uuid) is
  'The honest stage of the signed-in borrower''s own payment: started, provider_received (a verified provider event reports the payment), lender_posted (the lender''s own receipt carries the provider payment reference or the intent id, for the same amount, and has not been reversed) or needs_attention (an open exception, an amount that differs, or money received on an intent that is no longer open). Derived only from verified events and lender receipts; a redirect, a client flag or a screen can never move it.';

-- ---------------------------------------------------------------------------------------------
-- 7. Hooks the mandates migration replaces (create or replace): mandate and debit events
-- ---------------------------------------------------------------------------------------------
-- Which mandate / debit of THIS configuration a mandate or debit event belongs to (null = unmatched). Until the mandates exist nothing matches.
create or replace function private.correlate_mandate_event(p_config uuid, p_object_kind text, p_object_ref text, p_order_ref text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$ select null::uuid $$;
revoke all on function private.correlate_mandate_event(uuid, text, text, text) from public;

-- Applies a verified mandate or debit event; returns the event_processing outcome.
create or replace function private.apply_mandate_event(p_event uuid)
returns text
language sql
security definer
set search_path = ''
as $$ select 'ignored_unsupported_yet'::text $$;
revoke all on function private.apply_mandate_event(uuid) from public;

-- ---------------------------------------------------------------------------------------------
-- 8. Ingest: the ONLY way a delivery enters the database (system role = the callback receiver)
-- ---------------------------------------------------------------------------------------------
create or replace function private.write_webhook_receipt(
  p_provider text, p_lender uuid, p_config uuid, p_delivery_id text, p_payload_sha256 text, p_outcome text, p_reason text,
  p_scheme text, p_signature_present boolean, p_skew integer, p_body_bytes integer, p_ip_hmac text, p_event uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into payments.webhook_receipts (provider, lender_org_id, config_id, delivery_id, payload_sha256, outcome, reason_class, scheme, signature_present,
                                         timestamp_skew_seconds, body_bytes, source_ip_hmac, event_id)
  values (
    case when p_provider ~ '^[a-z0-9_]{1,50}$' then p_provider else 'unknown' end,
    p_lender, p_config,
    case when p_delivery_id ~ '^[A-Za-z0-9._:=+/-]+$' and length(p_delivery_id) between 4 and 200 then p_delivery_id end,
    case when p_payload_sha256 ~ '^[0-9a-f]{64}$' then p_payload_sha256 else repeat('0', 64) end,
    p_outcome, p_reason,
    case when p_scheme ~ '^[a-z0-9][a-z0-9._-]{0,79}$' then p_scheme end,
    coalesce(p_signature_present, false),
    case when p_skew between -31536000 and 31536000 then p_skew end,
    case when p_body_bytes between 0 and 104857600 then p_body_bytes end,
    case when p_ip_hmac ~ '^[0-9a-f]{64}$' then p_ip_hmac end,
    p_event)
  returning id into v_id;
  return v_id;
end
$$;
revoke all on function private.write_webhook_receipt(text, uuid, uuid, text, text, text, text, text, boolean, integer, integer, text, uuid) from public;

create or replace function private.record_event_processing(
  p_event uuid, p_lender uuid, p_outcome text, p_reason text, p_intent uuid default null, p_payment uuid default null,
  p_attempt integer default 1, p_until timestamptz default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into payments.event_processing (event_id, lender_org_id, outcome, reason_class, intent_id, provider_payment_id, attempt, deferred_until)
  values (p_event, p_lender, p_outcome, p_reason, p_intent, p_payment, p_attempt, p_until)
  returning id into v_id;
  return v_id;
end
$$;
revoke all on function private.record_event_processing(uuid, uuid, text, text, uuid, uuid, integer, timestamptz) from public;

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

  -- (e) An authentic event of a kind or status the platform does not handle is stored verified-and-ignored: no correlation, no processing.
  v_ignored := v_kind = 'unsupported' or v_status = 'unmapped';
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

  -- (d) Replay protection, in the database, AFTER verification, correlation and business validation: a forged or unmatched delivery never gets here.
  if not private.mark_webhook_seen('provider_' || substr(md5(v_cfg.provider), 1, 16), v_delivery_id) then
    select * into v_existing from payments.provider_events e where e.provider = v_cfg.provider and e.provider_event_id = v_event_id;
    perform private.write_webhook_receipt(v_cfg.provider, v_cfg.lender_org_id, v_cfg.id, v_delivery_id, v_sha, 'duplicate', 'replayed_delivery', v_scheme, v_sigp, v_skew, v_bytes, v_ip, v_existing.id);
    return v_accepted;
  end if;

  insert into payments.provider_events (provider, provider_event_id, event_type, lender_org_id, payment_intent_id, amount_minor, provider_status, payload_sha256, signature_verified,
                                        currency, config_id, object_kind, object_ref, order_ref, rank, occurred_at, verification_stages, processing_class)
  values (v_cfg.provider, v_event_id, v_kind || '.' || v_status, v_cfg.lender_org_id, v_intent.id, v_amount, v_status, v_sha, true,
          case when v_amount is not null then 'INR' end, v_cfg.id, v_kind, v_object_ref, v_order_ref, v_rank, v_occurred, v_stages,
          case when v_ignored then 'ignored' else 'actionable' end)
  on conflict (provider, provider_event_id) do nothing
  returning id into v_row_id;

  if v_row_id is null then
    -- (h) The same event id again (another delivery). Same payload: a duplicate. A different payload: a duplicate and an exception.
    select * into v_existing from payments.provider_events e where e.provider = v_cfg.provider and e.provider_event_id = v_event_id;
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
  'System only (the callback receiver). The ONLY way a provider delivery enters the database. Routes by the hash of the endpoint token to an ACTIVE configuration (an unknown, suspended or retired token gets the same answer as a bad signature). Anything but outcome verified writes a receipt and nothing else. A verified delivery is read, checked against the configuration (provider, merchant), correlated (a payment, refund or chargeback must match an intent of THIS lender, provider and configuration by order reference; a mandate or debit goes through private.correlate_mandate_event), business-validated (money statuses need an amount, INR), and only then consumes its delivery id (private.mark_webhook_seen) and takes its event id in provider_events. The same event id again is a duplicate (an event_payload_conflict exception when the payload differs). An authentic event of an unsupported kind or an unmapped status is stored verified-and-ignored. A verified, actionable event enqueues payment.apply_event (ids only). Returns {accepted, outcome} and nothing about internals.';

-- ---------------------------------------------------------------------------------------------
-- 9. Apply (worker): idempotent, one intent at a time under a row lock
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
  v_ppid uuid;
  v_dup boolean := false;
  v_attempt integer;
  v_until timestamptz;
  v_adj_kind text;
  v_sum bigint;
  v_n integer;
  v_outcome text;
  v_reason text;
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
    select * into pp from payments.provider_payments x where x.provider = e.provider and x.provider_payment_ref = e.object_ref for update;
    if found then
      if e.rank < pp.rank then
        -- A failure reported after a success never reverts anything; it opens an exception. Any other lower rank is simply stale.
        if e.provider_status in ('failed', 'rejected', 'cancelled', 'expired') and pp.status = any (v_success) then
          perform private.raise_exception_impl(e.lender_org_id, 'payment_status_conflict', 'warning', 'lender',
            jsonb_build_object('intent_id', i.id::text, 'provider_payment_id', pp.id::text));
          perform private.record_event_processing(e.id, e.lender_org_id, 'exception', 'failure_after_success', i.id, pp.id);
          return jsonb_build_object('outcome', 'exception', 'reason', 'failure_after_success');
        end if;
        perform private.record_event_processing(e.id, e.lender_org_id, 'ignored_stale', 'lower_rank', i.id, pp.id);
        return jsonb_build_object('outcome', 'ignored_stale', 'reason', 'lower_rank');
      elsif e.rank = pp.rank and (e.provider_status = pp.status or (e.provider_status = any (v_success) and pp.status = any (v_success))) then
        perform private.record_event_processing(e.id, e.lender_org_id, 'already_applied', 'same_status', i.id, pp.id);
        return jsonb_build_object('outcome', 'already_applied', 'reason', 'same_status');
      end if;
      update payments.provider_payments set status = e.provider_status, rank = e.rank, amount_minor = coalesce(e.amount_minor, amount_minor),
             currency = coalesce(e.currency, currency), captured_at = case when v_is_success and captured_at is null then e.occurred_at else captured_at end,
             last_event_id = e.id
       where id = pp.id
      returning * into pp;
      v_dup := pp.duplicate_capture;
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
      elsif i.status = 'pending' then
        update payments.payment_intents set status = 'succeeded' where id = i.id;
        v_outcome := 'applied'; v_reason := 'intent_succeeded';
      else
        v_outcome := 'applied'; v_reason := 'intent_already_succeeded';
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
  select * into pp from payments.provider_payments x
   where x.intent_id = i.id and x.lender_org_id = i.lender_org_id and x.status = any (v_success) and not x.duplicate_capture
   order by x.created_at limit 1 for update;
  if not found then
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
  'System only (the worker). Idempotent: an event that already has a finished event_processing row is not applied again, and concurrent applications are serialised by an advisory lock on the event id plus the intent row lock, so exactly one application happens. payment events upsert payments.provider_payments (status, rank, amount; only a higher rank moves a row, a lower one is ignored_stale, a failure after a success opens a payment_status_conflict exception and never reverts) and move the intent to succeeded ONLY through the existing guard (verified event, same intent, lender, provider, a success status, equal amount and currency); a different amount keeps the intent pending and opens amount_mismatch; a second capture is a separate flagged row and a duplicate_payment exception; money on a closed intent opens payment_on_closed_intent. A refund or chargeback becomes a compensating row in payments.payment_adjustments, deferred (bounded retries) when its capture has not been seen. Settlement events are recorded for reconciliation; mandate and debit events go to private.apply_mandate_event. Every state change and its event_processing row commit in one transaction.';

-- ---------------------------------------------------------------------------------------------
-- 10. What a lender sees of the callbacks: counts only
-- ---------------------------------------------------------------------------------------------
create or replace function payments.lender_webhook_summary(p_lender uuid)
returns table (outcome text, receipts bigint, last_received_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null or p_lender is null or p_lender not in (select private.orgs_with_permission('payment.read'))
     or not exists (select 1 from tenancy.organizations o where o.id = p_lender and o.kind = 'lender') then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  return query
    select r.outcome, count(*), max(r.received_at)
    from payments.webhook_receipts r
    where r.lender_org_id = p_lender
    group by r.outcome
    order by r.outcome;
end
$$;
comment on function payments.lender_webhook_summary(uuid) is
  'A lender with payment.read sees how many deliveries arrived for its own payment configurations by outcome, and when the last one arrived. Never a receipt row, a hash or an address. Deliveries for an unknown token belong to no lender and appear nowhere here.';

-- ---------------------------------------------------------------------------------------------
-- 11. Row level security, grants
-- ---------------------------------------------------------------------------------------------
alter table payments.webhook_receipts enable row level security;
alter table payments.webhook_receipts force row level security;
alter table payments.event_processing enable row level security;
alter table payments.event_processing force row level security;
alter table payments.provider_payments enable row level security;
alter table payments.provider_payments force row level security;
alter table payments.payment_adjustments enable row level security;
alter table payments.payment_adjustments force row level security;
alter table payments.reconciliation_exceptions enable row level security;
alter table payments.reconciliation_exceptions force row level security;
alter table payments.reconciliation_exception_events enable row level security;
alter table payments.reconciliation_exception_events force row level security;
alter table payments.lender_payment_policies enable row level security;
alter table payments.lender_payment_policies force row level security;

-- Receipts: platform users who run providers only. Lenders get the summary function, borrowers and anon nothing.
create policy webhook_receipts_platform_read on payments.webhook_receipts for select to authenticated
  using ((select private.has_platform_permission('platform.payments.providers.manage')));
-- Lender-scoped facts: payment.read (the platform's operations roles reach every lender through the same mechanism as provider_events).
create policy event_processing_read on payments.event_processing for select to authenticated
  using (lender_org_id in (select private.orgs_with_permission('payment.read')));
create policy provider_payments_read on payments.provider_payments for select to authenticated
  using (lender_org_id in (select private.orgs_with_permission('payment.read')));
create policy payment_adjustments_read on payments.payment_adjustments for select to authenticated
  using (lender_org_id in (select private.orgs_with_permission('payment.read')));
create policy reconciliation_exceptions_read on payments.reconciliation_exceptions for select to authenticated
  using (lender_org_id in (select private.orgs_with_permission('payment.read')) or lender_org_id in (select private.orgs_with_permission('payment.reconcile'))
         or (select private.has_platform_permission('platform.payments.providers.manage')));
create policy reconciliation_exception_events_read on payments.reconciliation_exception_events for select to authenticated
  using (lender_org_id in (select private.orgs_with_permission('payment.read')) or lender_org_id in (select private.orgs_with_permission('payment.reconcile'))
         or (select private.has_platform_permission('platform.payments.providers.manage')));
create policy lender_payment_policies_read on payments.lender_payment_policies for select to authenticated
  using (lender_org_id in (select private.orgs_with_permission('payment.configure')) or lender_org_id in (select private.orgs_with_permission('payment.config.approve'))
         or lender_org_id in (select private.orgs_with_permission('payment.read')));

-- The default privilege gives service_role ALL on new tables: it gets SELECT only (the worker reads, the definer functions write).
revoke all on payments.webhook_receipts, payments.event_processing, payments.provider_payments, payments.payment_adjustments,
  payments.reconciliation_exceptions, payments.reconciliation_exception_events, payments.lender_payment_policies from service_role;
grant select on payments.webhook_receipts, payments.event_processing, payments.provider_payments, payments.payment_adjustments,
  payments.reconciliation_exceptions, payments.reconciliation_exception_events, payments.lender_payment_policies to service_role;
grant select on payments.webhook_receipts, payments.event_processing, payments.provider_payments, payments.payment_adjustments,
  payments.reconciliation_exceptions, payments.reconciliation_exception_events, payments.lender_payment_policies to authenticated;

revoke all on function payments.raise_exception(uuid, text, text, text, jsonb) from public;
revoke all on function payments.acknowledge_exception(uuid) from public;
revoke all on function payments.assign_exception(uuid, uuid) from public;
revoke all on function payments.resolve_exception(uuid, text, jsonb, text) from public;
revoke all on function payments.reopen_exception(uuid, text, text) from public;
revoke all on function payments.set_payment_policy(uuid, boolean, bigint, boolean, bigint, integer) from public;
revoke all on function payments.request_payment(uuid, payments.intent_purpose, bigint, text, uuid) from public;
revoke all on function payments.record_order_created(uuid, text, timestamptz) from public;
revoke all on function payments.record_order_failed(uuid, text) from public;
revoke all on function payments.expire_stale_intents(interval) from public;
revoke all on function payments.my_payment(uuid) from public;
revoke all on function payments.ingest_provider_delivery(text, jsonb) from public;
revoke all on function payments.apply_provider_event(uuid) from public;
revoke all on function payments.lender_webhook_summary(uuid) from public;
grant execute on function payments.raise_exception(uuid, text, text, text, jsonb) to service_role;
grant execute on function payments.acknowledge_exception(uuid) to authenticated;
grant execute on function payments.assign_exception(uuid, uuid) to authenticated;
grant execute on function payments.resolve_exception(uuid, text, jsonb, text) to authenticated;
grant execute on function payments.reopen_exception(uuid, text, text) to authenticated;
grant execute on function payments.set_payment_policy(uuid, boolean, bigint, boolean, bigint, integer) to authenticated;
grant execute on function payments.request_payment(uuid, payments.intent_purpose, bigint, text, uuid) to authenticated;
grant execute on function payments.record_order_created(uuid, text, timestamptz) to service_role;
grant execute on function payments.record_order_failed(uuid, text) to service_role;
grant execute on function payments.expire_stale_intents(interval) to service_role;
grant execute on function payments.my_payment(uuid) to authenticated;
grant execute on function payments.ingest_provider_delivery(text, jsonb) to service_role;
grant execute on function payments.apply_provider_event(uuid) to service_role;
grant execute on function payments.lender_webhook_summary(uuid) to authenticated;

-- Each of the new tables names its owner (the structure test lists tables without a comment).
