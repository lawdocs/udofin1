-- =============================================================================================
-- Phase 08a, reminders and service communications (in-app and push only).
-- Spec: docs/specs/08-servicing-payments-mandates-collections.md section 11, and the owner decision of 14 October 2026 (5): launch with
-- IN-APP and PUSH reminders only. No SMS provider is integrated (the sms channel answers not_configured and is never reported as sent),
-- no mock SMS in staging or production, the default window is 08:00 to 19:00 IST, and an overdue reminder is NOT sent while the lender
-- has no approved penal-charge text (nothing is invented, calculated or generated).
--
-- What this migration does
--   1. Draft rules as data (documents.applicability_rules, never seeded approved): the reminder window, the daily cap and the
--      quiet period after a payment. Conservative defaults apply while a rule is a draft; an approved rule can only NARROW them.
--   2. servicing.reminder_policies / reminder_templates / penal_charge_texts: versioned, written by one lender user and approved by a
--      DIFFERENT one (reminder.policy.manage drafts, reminder.template.approve approves). A template may use a closed set of variables
--      only, carries no promotional wording, no contact detail and no long digit run.
--   3. servicing.communication_holds: a pause on reminders for a loan (complaint, hardship, dispute, lender instruction, borrower request).
--      A hold never blocks the borrower from paying.
--   4. servicing.reminders (one row per loan, installment, offset and channel: an at-least-once planner cannot double-plan) and
--      servicing.reminder_deliveries (append-only attempts; "delivered" only from a delivery report).
--   5. servicing.plan_reminders / claim_due_reminders / record_reminder_attempt / suppress_reminders_for_loan (system) and
--      servicing.my_reminders / mark_reminder_read (borrower).
--
-- Service messages only: no offers, no cross-sell, no marketing of any kind. Forward-only. Error convention: SQLSTATE and hint
-- (42501 not authorised, P0002 not found, 22023 bad input, 55000 rule or state, 23505 duplicate).
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- A. Draft rule seeds (platform data, never approved by seed) and the document type they hang on
-- ---------------------------------------------------------------------------------------------
insert into documents.document_types (key, description, data_source) values
  ('service_reminder', 'Service reminder message (in-app or push) about an installment. Wording is the lender''s and is approved by the lender.', 'lender_issued');

insert into documents.applicability_rules (rule_key, version, lender_category_keys, regulator, direction_ref, paragraph_refs, product_category_keys,
  exclusions, document_type, required_template_key, required_fields_version, required_acknowledgements, ack_sections, validity_rule, language_policy,
  effective_from, approval_status, evidence_status)
values
  ('servicing.reminder_window.default', 1, array['nbfc_icc', 'nbfc_d'], 'Udofin platform setting (interpretation of RBI)',
   'RBC Directions 2025 (RBI/DOR/2025-26/362), para 100 (hours for recovery calls); unverified against the primary text',
   array['100'], array['personal', 'loan_against_securities', 'vehicle', 'home', 'loan_against_property', 'medical', 'legal_expense', 'resolution_finance', 'debt_reset'],
   'DRAFT FOR LEGAL/COMPLIANCE REVIEW. Evidence label: interpretation. The reference above (RBC Directions 2025, para 100, text updated as on 1 April 2026) concerns the hours in which recovery calls may be made; it does not say whether service messages count, and an overdue reminder is recovery-adjacent, so the same hours are applied to every borrower reminder as a conservative reading. A lender policy may only NARROW this window; a message outside it is deferred to the next window, never dropped silently. TRAI promotional-hours rules are not relied on because these are service messages (unverified).',
   'service_reminder', 'none.lender_issued', 'none', '{}', '{}',
   '{"kind":"daily_window","from":"08:00","to":"19:00","tz":"Asia/Kolkata","label":"conservative_default"}'::jsonb, '{}'::jsonb,
   date '2026-10-14', 'draft', 'interpretation'),
  ('servicing.reminder_max_per_day', 1, array['nbfc_icc', 'nbfc_d'], 'Udofin platform setting (not a regulator)',
   'Platform default for the number of reminder messages a loan may receive on one day (a message sent on several channels counts once). NOT a regulatory limit.',
   '{}', array['personal', 'loan_against_securities', 'vehicle', 'home', 'loan_against_property', 'medical', 'legal_expense', 'resolution_finance', 'debt_reset'],
   'DRAFT. PLATFORM SETTING, NOT A REGULATORY CLAIM. Evidence label: unverified. The figure of 2 is a proposed operational default with no source; the owner must confirm or replace it. A lender policy may only lower it.',
   'service_reminder', 'none.lender_issued', 'none', '{}', '{}',
   '{"kind":"count_per_day","count":2,"label":"platform_default_proposed"}'::jsonb, '{}'::jsonb,
   date '2026-10-14', 'draft', 'unverified'),
  ('servicing.suppress_after_payment_hours', 1, array['nbfc_icc', 'nbfc_d'], 'Udofin platform setting (not a regulator)',
   'Platform default: after a verified payment succeeded for a loan, no reminder is sent for that loan for this many hours (do not dun someone who has just paid). NOT a regulatory limit.',
   '{}', array['personal', 'loan_against_securities', 'vehicle', 'home', 'loan_against_property', 'medical', 'legal_expense', 'resolution_finance', 'debt_reset'],
   'DRAFT. PLATFORM SETTING, NOT A REGULATORY CLAIM. Evidence label: unverified. The figure of 48 hours is a proposed operational default with no source; the owner must confirm or replace it.',
   'service_reminder', 'none.lender_issued', 'none', '{}', '{}',
   '{"kind":"hours_after_payment","hours":48,"label":"platform_default_proposed"}'::jsonb, '{}'::jsonb,
   date '2026-10-14', 'draft', 'unverified');

-- The values in force: the newest APPROVED rule narrows the conservative defaults; a draft changes nothing. (A rule can narrow, never widen.)
create or replace function private.reminder_params()
returns table (window_from time, window_to time, max_per_day integer, suppress_hours integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_w jsonb;
  v_m jsonb;
  v_s jsonb;
  v_from time := time '08:00';
  v_to time := time '19:00';
  v_max integer := 2;
  v_hours integer := 48;
begin
  select r.validity_rule into v_w from documents.applicability_rules r
   where r.rule_key = 'servicing.reminder_window.default' and r.approval_status = 'approved' and r.effective_from <= (now() at time zone 'Asia/Kolkata')::date
     and (r.effective_to is null or r.effective_to >= (now() at time zone 'Asia/Kolkata')::date)
   order by r.version desc limit 1;
  if v_w is not null and v_w ->> 'kind' = 'daily_window' and (v_w ->> 'from') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' and (v_w ->> 'to') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
    v_from := greatest(v_from, (v_w ->> 'from')::time);
    v_to := least(v_to, (v_w ->> 'to')::time);
  end if;
  select r.validity_rule into v_m from documents.applicability_rules r
   where r.rule_key = 'servicing.reminder_max_per_day' and r.approval_status = 'approved' and r.effective_from <= (now() at time zone 'Asia/Kolkata')::date
     and (r.effective_to is null or r.effective_to >= (now() at time zone 'Asia/Kolkata')::date)
   order by r.version desc limit 1;
  if v_m is not null and v_m ->> 'kind' = 'count_per_day' and (v_m ->> 'count') ~ '^[1-9][0-9]?$' then
    v_max := least(v_max, (v_m ->> 'count')::integer);
  end if;
  select r.validity_rule into v_s from documents.applicability_rules r
   where r.rule_key = 'servicing.suppress_after_payment_hours' and r.approval_status = 'approved' and r.effective_from <= (now() at time zone 'Asia/Kolkata')::date
     and (r.effective_to is null or r.effective_to >= (now() at time zone 'Asia/Kolkata')::date)
   order by r.version desc limit 1;
  if v_s is not null and v_s ->> 'kind' = 'hours_after_payment' and (v_s ->> 'hours') ~ '^[0-9]{1,4}$' then
    v_hours := greatest(v_hours, (v_s ->> 'hours')::integer);
  end if;
  return query select v_from, v_to, v_max, v_hours;
end
$$;
revoke all on function private.reminder_params() from public;
comment on function private.reminder_params() is
  'The platform values in force for reminders: the window (default 08:00 to 19:00 IST), the daily cap (default 2) and the quiet period after a payment (default 48 hours). The newest APPROVED rule can only narrow the window, lower the cap and lengthen the quiet period; a draft rule changes nothing. An approved rule that is malformed is ignored (the defaults stay).';

-- The instant the window rule is judged at. Always the real clock, except in a session that has been told it is a non-production one
-- (udofin.allow_mock_providers = on, the same guard that admits mock providers) AND has set udofin.test_clock: the pgTAP suite uses this seam
-- to test the window rule at any time of day. It moves nothing else: planning, expiry, the daily cap and freshness always use the real clock.
create or replace function private.reminder_window_clock()
returns timestamptz
language plpgsql
stable
set search_path = ''
as $$
declare
  v text := nullif(current_setting('udofin.test_clock', true), '');
begin
  if v is not null and private.mock_providers_allowed() then
    return v::timestamptz;
  end if;
  return clock_timestamp();
end
$$;
revoke all on function private.reminder_window_clock() from public;
comment on function private.reminder_window_clock() is
  'The instant the reminder window is judged at: the real clock, unless the session allows mock providers (non-production) and has set udofin.test_clock. Used by the window check only. Production never sets udofin.allow_mock_providers (see docs/operations/activation-gates).';

-- Whether an instant is inside the window, in IST (no DST). The start is inside, the end is not.
create or replace function private.reminder_in_window(p_at timestamptz, p_from time, p_to time)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$ select (p_at at time zone 'Asia/Kolkata')::time >= p_from and (p_at at time zone 'Asia/Kolkata')::time < p_to $$;

-- ---------------------------------------------------------------------------------------------
-- B. Wording checks: service messages only
-- ---------------------------------------------------------------------------------------------
create or replace function private.reminder_text_ok(p_text text, p_allow_placeholders boolean)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_t text := lower(coalesce(p_text, ''));
  v_ph text;
begin
  if p_text is null or length(trim(p_text)) not between 10 and 800 then return false; end if;
  -- Plain sentence characters (Latin and Devanagari letters, digits, spaces, simple punctuation) and, when allowed, {{variables}}.
  if p_text !~ ('^[A-Za-z0-9ऀ-ॿ .,:;!?''"()/%-]*' || case when p_allow_placeholders then '(\{\{[a-z_]+\}\}[A-Za-z0-9ऀ-ॿ .,:;!?''"()/%-]*)*' else '' end || '$') then
    return false;
  end if;
  -- Nothing that reaches outside the message or identifies a person.
  if v_t ~ '(https?|www\.|@|\.com|\.in\b|\.org|\.net)' or p_text ~ '[0-9]{8,}' or p_text ~ '[A-Z]{5}[0-9]{4}[A-Z]' then return false; end if;
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
  'The "no marketing" and "no personal data" check on reminder wording: 10 to 800 plain characters, no link, address, e-mail, PAN-shaped token or run of 8 or more digits, no promotional vocabulary (English list), and only the variables lender_name, due_date, amount and penal_text. The Hindi wording is checked for the same shape; an approver checks its meaning.';

-- ---------------------------------------------------------------------------------------------
-- C. Policies, templates and penal-charge texts (versioned, two-person)
-- ---------------------------------------------------------------------------------------------
-- 1 to 12 distinct offsets, each between 30 days before and 90 days after the due date.
create or replace function private.reminder_offsets_ok(p_offsets integer[])
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select p_offsets is not null and cardinality(p_offsets) between 1 and 12
    and not exists (select 1 from unnest(p_offsets) o where o is null or o not between -30 and 90)
    and (select count(distinct o) from unnest(p_offsets) o) = cardinality(p_offsets)
$$;

create table servicing.reminder_policies (
  id uuid primary key default private.uuid_v7(),
  lender_org_id uuid not null references tenancy.organizations (id) on delete restrict,
  version integer not null check (version > 0),
  status text not null default 'draft' check (status in ('draft', 'approved', 'retired')),
  -- Days relative to the due date: negative = before, 0 = the due day, positive = after (overdue).
  offsets_days integer[] not null check (private.reminder_offsets_ok(offsets_days)),
  -- After the last overdue offset, one more reminder every 7 days until closure or a hold (bounded at 90 days past due).
  overdue_weekly boolean not null default true,
  -- sms is accepted ONLY as an inert placeholder: no SMS provider exists, the planner skips it and says so.
  channels text[] not null check (cardinality(channels) between 1 and 3 and channels <@ array['in_app', 'push', 'sms']),
  window_from time not null check (window_from >= time '08:00'),
  window_to time not null check (window_to <= time '19:00'),
  max_per_day integer not null default 2 check (max_per_day between 1 and 2),
  drafted_by uuid not null references auth.users (id),
  drafted_at timestamptz not null default clock_timestamp(),
  approved_by uuid references auth.users (id),
  approved_at timestamptz,
  retired_by uuid references auth.users (id),
  retired_at timestamptz,
  unique (lender_org_id, version),
  unique (id, lender_org_id),
  constraint window_is_ordered check (window_from < window_to),
  constraint approver_is_not_drafter check (approved_by is null or approved_by <> drafted_by),
  constraint approved_has_proof check ((status <> 'approved' or (approved_by is not null and approved_at is not null)) and (status <> 'draft' or (approved_by is null and approved_at is null))),
  constraint retired_has_actor check ((status = 'retired') = (retired_by is not null and retired_at is not null))
);
create unique index reminder_policies_one_approved on servicing.reminder_policies (lender_org_id) where status = 'approved';
create index reminder_policies_drafted_by on servicing.reminder_policies (drafted_by);
create index reminder_policies_approved_by on servicing.reminder_policies (approved_by);
create index reminder_policies_retired_by on servicing.reminder_policies (retired_by);
comment on table servicing.reminder_policies is
  'A lender''s reminder policy: offsets from each due date (negative before, positive after), channels (in_app and push; sms only as an inert placeholder), a window inside 08:00 to 19:00 IST and a daily cap of 1 or 2. Versioned: a change is a new version. Drafted by one lender user (reminder.policy.manage) and approved by a DIFFERENT one (reminder.template.approve); at most one approved version per lender. The platform window, cap and quiet period (documents.applicability_rules, private.reminder_params) can only narrow it further. Written only by servicing.draft_reminder_policy / approve_reminder_policy / retire_reminder_policy. Owner: servicing module.';
create trigger no_delete before delete on servicing.reminder_policies
  for each row execute function private.forbid_mutation();
create trigger no_truncate before truncate on servicing.reminder_policies
  for each statement execute function private.forbid_truncate();

create or replace function private.protect_reminder_config()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_moving text[] := case tg_table_name
    when 'reminder_policies' then array['status', 'approved_by', 'approved_at', 'retired_by', 'retired_at']
    else array['status', 'approved_by', 'approved_at', 'retired_by', 'retired_at', 'updated_at'] end;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'a reminder policy, template or penal-charge text starts as a draft' using errcode = 'P0001';
    end if;
    return new;
  end if;
  if (to_jsonb(new) - v_moving) is distinct from (to_jsonb(old) - v_moving) then
    raise exception 'a reminder policy, template or penal-charge text keeps its content: a change is a new version' using errcode = 'P0001';
  end if;
  if not ((old.status = 'draft' and new.status in ('approved', 'retired')) or (old.status = 'approved' and new.status = 'retired')) then
    raise exception 'status transition % -> % is not allowed', old.status, new.status using errcode = 'P0001';
  end if;
  return new;
end
$$;
revoke all on function private.protect_reminder_config() from public;
create trigger protect before insert or update on servicing.reminder_policies
  for each row execute function private.protect_reminder_config();

create table servicing.reminder_templates (
  id uuid primary key default private.uuid_v7(),
  lender_org_id uuid not null references tenancy.organizations (id) on delete restrict,
  kind text not null check (kind in ('pre_due', 'due_day', 'overdue')),
  language text not null check (language in ('en', 'hi')),
  version integer not null check (version > 0),
  status text not null default 'draft' check (status in ('draft', 'approved', 'retired')),
  body text not null check (private.reminder_text_ok(body, true)),
  body_sha256 text not null check (body_sha256 ~ '^[0-9a-f]{64}$'),
  drafted_by uuid not null references auth.users (id),
  drafted_at timestamptz not null default clock_timestamp(),
  approved_by uuid references auth.users (id),
  approved_at timestamptz,
  retired_by uuid references auth.users (id),
  retired_at timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  unique (lender_org_id, kind, language, version),
  unique (id, lender_org_id),
  -- Every overdue reminder carries the lender's approved penal-charge text (RBC para 30(7)); a template that cannot show it is refused.
  constraint overdue_shows_penal_text check (kind <> 'overdue' or body like '%{{penal_text}}%'),
  constraint approver_is_not_drafter check (approved_by is null or approved_by <> drafted_by),
  constraint approved_has_proof check ((status <> 'approved' or (approved_by is not null and approved_at is not null)) and (status <> 'draft' or (approved_by is null and approved_at is null))),
  constraint retired_has_actor check ((status = 'retired') = (retired_by is not null and retired_at is not null))
);
create unique index reminder_templates_one_approved on servicing.reminder_templates (lender_org_id, kind, language) where status = 'approved';
create index reminder_templates_drafted_by on servicing.reminder_templates (drafted_by);
create index reminder_templates_approved_by on servicing.reminder_templates (approved_by);
create index reminder_templates_retired_by on servicing.reminder_templates (retired_by);
comment on table servicing.reminder_templates is
  'Reminder wording per lender, kind (pre_due, due_day, overdue) and language (en, hi). Service messages only: closed variables (lender_name, due_date, amount, penal_text), no promotional vocabulary, no link, contact detail or long digit run (private.reminder_text_ok). An overdue template must contain {{penal_text}}. Versioned, drafted by one lender user and approved by a different one; one approved version per lender, kind and language. The hash of the wording is stored. Written only by servicing.draft_reminder_template / approve_reminder_template / retire_reminder_template. Owner: servicing module.';
create trigger no_delete before delete on servicing.reminder_templates
  for each row execute function private.forbid_mutation();
create trigger no_truncate before truncate on servicing.reminder_templates
  for each statement execute function private.forbid_truncate();
create trigger protect before insert or update on servicing.reminder_templates
  for each row execute function private.protect_reminder_config();
create trigger set_updated_at before update on servicing.reminder_templates
  for each row execute function private.set_updated_at();

create table servicing.penal_charge_texts (
  id uuid primary key default private.uuid_v7(),
  lender_org_id uuid not null references tenancy.organizations (id) on delete restrict,
  version integer not null check (version > 0),
  status text not null default 'draft' check (status in ('draft', 'approved', 'retired')),
  -- Structured fields supplied by the LENDER. Udofin shows the sentence and never computes, adds or adjusts a charge.
  charge_kind text not null check (charge_kind in ('flat', 'percentage')),
  flat_amount_minor bigint check (flat_amount_minor is null or flat_amount_minor between 1 and 100000000000),
  percent_bps integer check (percent_bps is null or percent_bps between 1 and 100000),
  basis text not null default 'overdue_amount' check (basis = 'overdue_amount'),
  -- Attestations by the lender, required true (RBC para 30(1)): a separate charge on the overdue amount, never a higher rate, never compounded.
  separate_from_interest boolean not null check (separate_from_interest),
  not_compounded boolean not null check (not_compounded),
  reason text not null check (length(trim(reason)) between 10 and 200 and private.reminder_text_ok(reason, false)),
  sentence_en text not null check (private.reminder_text_ok(sentence_en, false)),
  sentence_hi text check (sentence_hi is null or private.reminder_text_ok(sentence_hi, false)),
  drafted_by uuid not null references auth.users (id),
  drafted_at timestamptz not null default clock_timestamp(),
  approved_by uuid references auth.users (id),
  approved_at timestamptz,
  retired_by uuid references auth.users (id),
  retired_at timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  unique (lender_org_id, version),
  unique (id, lender_org_id),
  constraint kind_matches_figure check ((charge_kind = 'flat' and flat_amount_minor is not null and percent_bps is null)
                                        or (charge_kind = 'percentage' and percent_bps is not null and flat_amount_minor is null)),
  constraint approver_is_not_drafter check (approved_by is null or approved_by <> drafted_by),
  constraint approved_has_proof check ((status <> 'approved' or (approved_by is not null and approved_at is not null)) and (status <> 'draft' or (approved_by is null and approved_at is null))),
  constraint retired_has_actor check ((status = 'retired') = (retired_by is not null and retired_at is not null))
);
create unique index penal_charge_texts_one_approved on servicing.penal_charge_texts (lender_org_id) where status = 'approved';
create index penal_charge_texts_drafted_by on servicing.penal_charge_texts (drafted_by);
create index penal_charge_texts_approved_by on servicing.penal_charge_texts (approved_by);
create index penal_charge_texts_retired_by on servicing.penal_charge_texts (retired_by);
comment on table servicing.penal_charge_texts is
  'The lender''s penal-charge disclosure for overdue reminders: structured fields (flat amount or percentage, basis = the overdue amount only), the lender''s attestations that it is a separate charge, not a higher rate and not compounded, a reason and the sentence to show (English, optionally Hindi). Approved by a person other than the drafter. Udofin shows the sentence verbatim: it never computes, adds or adjusts a charge, and it NEVER invents text. While a lender has no approved text, its overdue reminders are not sent (suppressed penal_text_missing, with an exception for the lender). Owner: servicing module.';
create trigger no_delete before delete on servicing.penal_charge_texts
  for each row execute function private.forbid_mutation();
create trigger no_truncate before truncate on servicing.penal_charge_texts
  for each statement execute function private.forbid_truncate();
create trigger protect before insert or update on servicing.penal_charge_texts
  for each row execute function private.protect_reminder_config();
create trigger set_updated_at before update on servicing.penal_charge_texts
  for each row execute function private.set_updated_at();

create trigger unsafe_text before insert on servicing.penal_charge_texts
  for each row execute function onboarding.reject_unsafe_text('reason', 'sentence_en', 'sentence_hi');
create trigger unsafe_text before insert on servicing.reminder_templates
  for each row execute function onboarding.reject_unsafe_text('body');

create or replace function private.set_reminder_template_hash()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.body_sha256 := encode(sha256(convert_to(new.body, 'UTF8')), 'hex');
  return new;
end
$$;
revoke all on function private.set_reminder_template_hash() from public;
create trigger set_hash before insert on servicing.reminder_templates
  for each row execute function private.set_reminder_template_hash();

-- ---------------------------------------------------------------------------------------------
-- D. Holds, the plan and the delivery log
-- ---------------------------------------------------------------------------------------------
create table servicing.communication_holds (
  id uuid primary key default private.uuid_v7(),
  lender_org_id uuid not null,
  loan_account_id uuid not null,
  reason text not null check (reason in ('complaint', 'hardship', 'dispute', 'lender_instruction', 'borrower_request', 'legal')),
  note text check (note is null or (length(note) <= 200 and private.reminder_text_ok(note, false))),
  placed_by uuid not null references auth.users (id),
  placed_at timestamptz not null default clock_timestamp(),
  released_by uuid references auth.users (id),
  released_at timestamptz,
  release_note text check (release_note is null or (length(release_note) <= 200 and private.reminder_text_ok(release_note, false))),
  foreign key (loan_account_id, lender_org_id) references servicing.loan_accounts (id, lender_org_id) on delete restrict,
  constraint release_is_complete check ((released_by is null) = (released_at is null))
);
create unique index communication_holds_one_active on servicing.communication_holds (loan_account_id) where released_at is null;
create index communication_holds_lender on servicing.communication_holds (lender_org_id, placed_at desc);
create index communication_holds_loan on servicing.communication_holds (loan_account_id, lender_org_id);
create index communication_holds_placed_by on servicing.communication_holds (placed_by);
create index communication_holds_released_by on servicing.communication_holds (released_by);
comment on table servicing.communication_holds is
  'A pause on reminders for one loan (complaint, hardship, dispute, lender instruction, borrower request, legal). While a hold is active no reminder is claimed for the loan. A hold NEVER blocks the borrower from paying. One active hold per loan; released once, never deleted. Written only by servicing.place_communication_hold / release_communication_hold (reminder.policy.manage). Owner: servicing module.';
create trigger no_delete before delete on servicing.communication_holds
  for each row execute function private.forbid_mutation();
create trigger no_truncate before truncate on servicing.communication_holds
  for each statement execute function private.forbid_truncate();
create trigger unsafe_text before insert or update on servicing.communication_holds
  for each row execute function onboarding.reject_unsafe_text('note', 'release_note');

create table servicing.reminders (
  id uuid primary key default private.uuid_v7(),
  lender_org_id uuid not null,
  loan_account_id uuid not null,
  borrower_id uuid not null,
  policy_id uuid not null,
  installment_seq integer not null check (installment_seq between 1 and 100000),
  due_date date not null,
  offset_days integer not null check (offset_days between -30 and 90),
  channel text not null check (channel in ('in_app', 'push', 'sms')),
  kind text generated always as (case when offset_days < 0 then 'pre_due' when offset_days = 0 then 'due_day' else 'overdue' end) stored,
  scheduled_for timestamptz not null,
  status text not null default 'planned' check (status in ('planned', 'claimed', 'sent', 'failed', 'suppressed')),
  suppress_reason text check (suppress_reason in (
    'loan_closed', 'paid', 'recent_payment', 'hold', 'penal_text_missing', 'template_missing', 'nothing_due', 'nothing_overdue', 'sms_not_configured',
    'channel_not_configured', 'policy_retired', 'expired', 'figures_unavailable')),
  attempts integer not null default 0 check (attempts between 0 and 10),
  claimed_until timestamptz,
  -- When the message was first claimed: the daily cap counts messages by this instant.
  claimed_at timestamptz,
  -- Frozen when the reminder is claimed, so what the borrower sees is exactly what was sent and hashed.
  template_id uuid,
  language_used text check (language_used is null or language_used in ('en', 'hi')),
  language_fallback boolean not null default false,
  penal_text_id uuid,
  variables jsonb check (variables is null or (jsonb_typeof(variables) = 'object' and variables ?& array['due_date', 'amount_minor', 'lender_name']
    and (variables - array['due_date', 'amount_minor', 'lender_name']) = '{}'::jsonb)),
  content_sha256 text check (content_sha256 is null or content_sha256 ~ '^[0-9a-f]{64}$'),
  penal_text_sha256 text check (penal_text_sha256 is null or penal_text_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (loan_account_id, installment_seq, offset_days, channel, policy_id),
  unique (id, lender_org_id),
  foreign key (loan_account_id, lender_org_id) references servicing.loan_accounts (id, lender_org_id) on delete restrict,
  foreign key (policy_id, lender_org_id) references servicing.reminder_policies (id, lender_org_id) on delete restrict,
  foreign key (template_id, lender_org_id) references servicing.reminder_templates (id, lender_org_id) on delete restrict,
  foreign key (penal_text_id, lender_org_id) references servicing.penal_charge_texts (id, lender_org_id) on delete restrict,
  constraint suppressed_has_reason check ((status = 'suppressed') = (suppress_reason is not null)),
  constraint frozen_when_claimed check (status in ('planned', 'suppressed') or (template_id is not null and content_sha256 is not null and variables is not null and language_used is not null)),
  constraint overdue_sent_with_penal_text check (kind <> 'overdue' or status not in ('claimed', 'sent') or (penal_text_id is not null and penal_text_sha256 is not null))
);
create index reminders_due on servicing.reminders (scheduled_for) where status = 'planned';
create index reminders_lender on servicing.reminders (lender_org_id, status, scheduled_for);
create index reminders_loan on servicing.reminders (loan_account_id, lender_org_id);
create index reminders_borrower on servicing.reminders (borrower_id);
create index reminders_policy on servicing.reminders (policy_id, lender_org_id);
create index reminders_template on servicing.reminders (template_id, lender_org_id);
create index reminders_penal_text on servicing.reminders (penal_text_id, lender_org_id);
comment on table servicing.reminders is
  'One planned message per loan, installment, offset, channel and policy version (unique, so an at-least-once planner cannot double-plan; the planner also never plans a message that already exists under an earlier policy version). planned -> claimed (a worker holds a lease; the template, language, variables and hashes are frozen) -> sent | failed, or suppressed with a reason from a closed list. An overdue message can only be claimed with an approved penal-charge text (check). A message outside the window is deferred to the next window, never dropped silently; one that is more than 48 hours late is suppressed (expired). sms rows exist only as suppressed placeholders (sms_not_configured). Content is frozen at claim; the variables are the due date, the amount the LENDER reported and the lender''s display name. Written only by the servicing reminder functions. Owner: servicing module.';
create trigger no_delete before delete on servicing.reminders
  for each row execute function private.forbid_mutation();
create trigger no_truncate before truncate on servicing.reminders
  for each statement execute function private.forbid_truncate();
create trigger set_updated_at before update on servicing.reminders
  for each row execute function private.set_updated_at();

create or replace function private.protect_reminder()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (to_jsonb(new) - array['status', 'suppress_reason', 'attempts', 'claimed_until', 'claimed_at', 'template_id', 'language_used', 'language_fallback', 'penal_text_id',
                            'variables', 'content_sha256', 'penal_text_sha256', 'updated_at', 'kind', 'scheduled_for'])
     is distinct from
     (to_jsonb(old) - array['status', 'suppress_reason', 'attempts', 'claimed_until', 'claimed_at', 'template_id', 'language_used', 'language_fallback', 'penal_text_id',
                            'variables', 'content_sha256', 'penal_text_sha256', 'updated_at', 'kind', 'scheduled_for']) then
    raise exception 'a reminder keeps its loan, installment, offset and channel' using errcode = 'P0001';
  end if;
  if old.status in ('sent', 'failed', 'suppressed') and (new.status is distinct from old.status or new.content_sha256 is distinct from old.content_sha256) then
    raise exception 'a finished reminder does not change' using errcode = 'P0001';
  end if;
  if old.content_sha256 is not null and (new.content_sha256 is distinct from old.content_sha256 or new.template_id is distinct from old.template_id
       or new.variables is distinct from old.variables or new.penal_text_sha256 is distinct from old.penal_text_sha256) then
    raise exception 'the content of a claimed reminder is frozen' using errcode = 'P0001';
  end if;
  return new;
end
$$;
revoke all on function private.protect_reminder() from public;
create trigger protect before update on servicing.reminders
  for each row execute function private.protect_reminder();

create table servicing.reminder_deliveries (
  id uuid primary key default private.uuid_v7(),
  reminder_id uuid not null,
  lender_org_id uuid not null,
  channel text not null check (channel in ('in_app', 'push', 'sms')),
  -- accepted = the provider took it (NOT delivery); delivered only from a delivery report; read only when the app or the report says so.
  state text not null check (state in ('accepted', 'not_configured', 'failed', 'delivered', 'read')),
  source text not null check (source in ('send', 'delivery_report', 'app')),
  provider_ref text check (provider_ref is null or (length(provider_ref) between 1 and 100 and provider_ref ~ '^[A-Za-z0-9._:=+/-]+$')),
  error_class text check (error_class is null or error_class in ('provider_error', 'provider_timeout', 'invalid_target', 'no_consent', 'rate_limited', 'unknown')),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  penal_text_sha256 text check (penal_text_sha256 is null or penal_text_sha256 ~ '^[0-9a-f]{64}$'),
  occurred_at timestamptz not null default clock_timestamp(),
  foreign key (reminder_id, lender_org_id) references servicing.reminders (id, lender_org_id) on delete restrict,
  constraint delivered_only_from_a_report check (state <> 'delivered' or source = 'delivery_report'),
  constraint read_only_from_app_or_report check (state <> 'read' or source in ('app', 'delivery_report')),
  constraint send_states check (source <> 'send' or state in ('accepted', 'not_configured', 'failed')),
  constraint sms_is_never_accepted check (channel <> 'sms' or state = 'not_configured')
);
create index reminder_deliveries_reminder on servicing.reminder_deliveries (reminder_id, lender_org_id, occurred_at);
create index reminder_deliveries_lender on servicing.reminder_deliveries (lender_org_id, occurred_at desc);
comment on table servicing.reminder_deliveries is
  'Append-only attempt log of every reminder: channel, state (accepted, not_configured, failed, delivered, read), where it came from (send, delivery_report, app), the provider reference, an error class, the hash of the wording that was sent and the hash of the penal-charge sentence it carried. "accepted" is the provider taking the message, NOT delivery: delivered is recorded only from a delivery report (check), and an sms attempt can only ever be not_configured. The lender can read the log for its borrowers. Written only by servicing.record_reminder_attempt / mark_reminder_read. Owner: servicing module.';
create trigger append_only before update or delete on servicing.reminder_deliveries
  for each row execute function private.forbid_mutation();
create trigger no_truncate before truncate on servicing.reminder_deliveries
  for each statement execute function private.forbid_truncate();

-- One delivery report per (reminder, state, provider reference); one "read" per reminder.
create unique index reminder_deliveries_one_report on servicing.reminder_deliveries (reminder_id, state, coalesce(provider_ref, ''))
  where source = 'delivery_report';
create unique index reminder_deliveries_one_read on servicing.reminder_deliveries (reminder_id) where state = 'read';

-- A hold changes only by being released, once.
create or replace function private.protect_communication_hold()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (to_jsonb(new) - array['released_by', 'released_at', 'release_note']) is distinct from (to_jsonb(old) - array['released_by', 'released_at', 'release_note']) then
    raise exception 'a communication hold keeps its loan, reason and placement' using errcode = 'P0001';
  end if;
  if old.released_at is not null then
    raise exception 'a released hold does not change' using errcode = 'P0001';
  end if;
  return new;
end
$$;
revoke all on function private.protect_communication_hold() from public;
create trigger protect before update on servicing.communication_holds
  for each row execute function private.protect_communication_hold();

-- ---------------------------------------------------------------------------------------------
-- E. Rendering and the facts a reminder depends on
-- ---------------------------------------------------------------------------------------------
-- 'Rs 1,23,456.78' (Indian digit grouping). Paise in, text out; the amount is never computed here.
create or replace function private.format_inr_minor(p_minor bigint)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select 'Rs ' ||
    case when p_minor / 100 < 1000 then (p_minor / 100)::text
         else regexp_replace(((p_minor / 100) / 1000)::text, '(\d)(?=(\d\d)+$)', '\1,', 'g') || ',' || lpad(((p_minor / 100) % 1000)::text, 3, '0') end
    || '.' || lpad((p_minor % 100)::text, 2, '0')
$$;

-- The message a borrower sees: the approved wording with the frozen variables and the lender's own penal-charge sentence. Nothing else.
create or replace function private.render_reminder(p_body text, p_vars jsonb, p_penal text)
returns text
language sql
stable
set search_path = ''
as $$
  select replace(
    replace(replace(replace(p_body, '{{due_date}}', to_char((p_vars ->> 'due_date')::date, 'DD Mon YYYY')),
                    '{{amount}}', private.format_inr_minor((p_vars ->> 'amount_minor')::bigint)),
            '{{penal_text}}', coalesce(p_penal, '')),
    '{{lender_name}}', p_vars ->> 'lender_name')
$$;
revoke all on function private.render_reminder(text, jsonb, text) from public;
comment on function private.render_reminder(text, jsonb, text) is
  'Fills the approved wording: {{due_date}}, {{amount}} (paise formatted as rupees, as the lender reported them), {{penal_text}} (the lender''s approved sentence, verbatim) and {{lender_name}} (last, so a name cannot inject a variable). The result is hashed at claim and shown to the borrower unchanged.';

-- The newest report of a loan and whether it can be relied on: the same fail-closed rule as the borrower''s loan view
-- (a warning on the report or an unresolved conflict about the report withholds the figures), plus staleness.
create or replace function private.reminder_figures(p_loan uuid)
returns table (ok boolean, reported_status servicing.loan_status, next_due_on date, next_due_minor bigint, total_overdue_minor bigint, days_past_due integer,
               reported_as_of timestamptz, stale boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select f.ok, b.status, b.next_due_on, b.next_due_minor, b.total_overdue_minor, b.days_past_due, b.reported_as_of,
         (b.reported_as_of is null or b.reported_as_of < now() - make_interval(mins => coalesce(c.staleness_threshold_minutes, 1440)))
  from servicing.loan_accounts la
  left join lateral (
    select s.* from servicing.balance_snapshots s where s.loan_account_id = la.id order by s.reported_as_of desc, s.version desc limit 1
  ) b on true
  left join servicing.lms_connections c on c.lender_org_id = la.lender_org_id
  cross join lateral (
    select (b.id is not null
            and not exists (select 1 from servicing.sync_anomalies an where an.snapshot_id = b.id and an.severity = 'warning')
            and not exists (select 1 from servicing.sync_conflicts sc where sc.loan_account_id = la.id and sc.record_type = 'loan' and sc.status <> 'resolved')) as ok
  ) f
  where la.id = p_loan
$$;
revoke all on function private.reminder_figures(uuid) from public;

-- A verified payment or a lender-posted receipt in the last p_hours hours (do not remind someone who has just paid).
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
      or exists (select 1 from servicing.lms_receipts r
                  where r.loan_account_id = p_loan and r.kind = 'receipt'
                    and r.value_date >= (now() at time zone 'Asia/Kolkata')::date - ceil(p_hours / 24.0)::integer
                    and not exists (select 1 from servicing.lms_receipts rv where rv.reverses_receipt_id = r.id))
$$;
revoke all on function private.reminder_recent_payment(uuid, integer) from public;

-- ---------------------------------------------------------------------------------------------
-- F. Drafting and approving: policy, wording and penal-charge text (people, aal2, two different people)
-- ---------------------------------------------------------------------------------------------
-- The row of the caller's lender, or "not found": another lender's id looks the same as an unknown one.
create or replace function servicing.draft_reminder_policy(
  p_lender uuid, p_offsets integer[], p_overdue_weekly boolean, p_channels text[], p_window_from time, p_window_to time, p_max_per_day integer)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.servicing_require_user(p_lender, 'reminder.policy.manage');
  v_version integer;
  v_id uuid;
begin
  if not private.reminder_offsets_ok(p_offsets) then
    raise exception 'offsets must be 1 to 12 distinct days between -30 and 90' using errcode = '22023', hint = 'offsets_invalid';
  end if;
  if p_channels is null or cardinality(p_channels) not between 1 and 3 or not (p_channels <@ array['in_app', 'push', 'sms'])
     or (select count(distinct c) from unnest(p_channels) c) <> cardinality(p_channels) then
    raise exception 'channels must be from in_app, push, sms without repeats' using errcode = '22023', hint = 'channels_invalid';
  end if;
  if p_window_from is null or p_window_to is null or p_window_from < time '08:00' or p_window_to > time '19:00' or p_window_from >= p_window_to then
    raise exception 'the window must lie inside 08:00 to 19:00 IST' using errcode = '22023', hint = 'window_invalid';
  end if;
  if p_overdue_weekly is null or p_max_per_day is null or p_max_per_day not between 1 and 2 then
    raise exception 'invalid reminder policy' using errcode = '22023', hint = 'policy_invalid';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('reminder_policy:' || p_lender::text, 0));
  select coalesce(max(p.version), 0) + 1 into v_version from servicing.reminder_policies p where p.lender_org_id = p_lender;
  insert into servicing.reminder_policies (lender_org_id, version, offsets_days, overdue_weekly, channels, window_from, window_to, max_per_day, drafted_by)
  values (p_lender, v_version, p_offsets, p_overdue_weekly, p_channels, p_window_from, p_window_to, p_max_per_day, v_uid)
  returning id into v_id;
  perform private.servicing_audit(p_lender, 'reminder.policy.drafted', 'reminder_policy', v_id::text, jsonb_build_object('version', v_version));
  return v_id;
end
$$;
comment on function servicing.draft_reminder_policy(uuid, integer[], boolean, text[], time, time, integer) is
  'reminder.policy.manage of the lender, aal2. Drafts the next version of the reminder policy: offsets in days from the due date (negative before, positive after; 1 to 12 distinct values between -30 and 90), whether overdue reminders continue weekly, channels (in_app, push; sms only as an inert placeholder), a window inside 08:00 to 19:00 IST and a daily cap of 1 or 2. Nothing is sent until a DIFFERENT person approves it and the reminders switch is on.';

create or replace function servicing.approve_reminder_policy(p_policy uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_row servicing.reminder_policies;
  v_old uuid;
begin
  select * into v_row from servicing.reminder_policies p
   where p.id = p_policy and p.lender_org_id in (select private.orgs_with_permission('reminder.template.approve'));
  if v_uid is null or not found then
    raise exception 'policy not found' using errcode = 'P0002';
  end if;
  perform private.require_aal2();
  if v_row.status <> 'draft' then
    raise exception 'only a draft can be approved' using errcode = '55000', hint = 'not_a_draft';
  end if;
  if v_row.drafted_by = v_uid then
    raise exception 'the person who drafted it cannot approve it' using errcode = '42501', hint = 'self_approval';
  end if;
  for v_old in select p.id from servicing.reminder_policies p where p.lender_org_id = v_row.lender_org_id and p.status = 'approved' loop
    update servicing.reminder_policies set status = 'retired', retired_by = v_uid, retired_at = clock_timestamp() where id = v_old;
    -- Messages planned under the old version are not sent: the new version plans its own.
    update servicing.reminders set status = 'suppressed', suppress_reason = 'policy_retired' where policy_id = v_old and status = 'planned';
  end loop;
  update servicing.reminder_policies set status = 'approved', approved_by = v_uid, approved_at = clock_timestamp() where id = v_row.id;
  perform private.servicing_audit(v_row.lender_org_id, 'reminder.policy.approved', 'reminder_policy', v_row.id::text, jsonb_build_object('version', v_row.version));
  return 'approved';
end
$$;
comment on function servicing.approve_reminder_policy(uuid) is
  'reminder.template.approve of the lender, aal2, and a DIFFERENT person than the drafter (42501 self_approval). Approves the draft, retires the previously approved version and suppresses the messages still planned under it (policy_retired). Another lender''s policy answers P0002.';

create or replace function servicing.retire_reminder_policy(p_policy uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_row servicing.reminder_policies;
begin
  select * into v_row from servicing.reminder_policies p
   where p.id = p_policy and p.lender_org_id in (select private.orgs_with_permission('reminder.policy.manage'));
  if v_uid is null or not found then
    raise exception 'policy not found' using errcode = 'P0002';
  end if;
  perform private.require_aal2();
  if v_row.status = 'retired' then
    raise exception 'already retired' using errcode = '55000', hint = 'already_retired';
  end if;
  update servicing.reminder_policies set status = 'retired', retired_by = v_uid, retired_at = clock_timestamp() where id = v_row.id;
  update servicing.reminders set status = 'suppressed', suppress_reason = 'policy_retired' where policy_id = v_row.id and status = 'planned';
  perform private.servicing_audit(v_row.lender_org_id, 'reminder.policy.retired', 'reminder_policy', v_row.id::text, jsonb_build_object('version', v_row.version));
  return 'retired';
end
$$;
comment on function servicing.retire_reminder_policy(uuid) is
  'reminder.policy.manage of the lender, aal2. Retires a draft or approved policy. With no approved policy the lender sends no reminders; the messages still planned are suppressed (policy_retired).';

create or replace function servicing.draft_reminder_template(p_lender uuid, p_kind text, p_language text, p_body text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.servicing_require_user(p_lender, 'reminder.policy.manage');
  v_version integer;
  v_id uuid;
begin
  if p_kind is null or p_kind not in ('pre_due', 'due_day', 'overdue') or p_language is null or p_language not in ('en', 'hi') then
    raise exception 'unknown kind or language' using errcode = '22023', hint = 'template_invalid';
  end if;
  if not private.reminder_text_ok(p_body, true) then
    raise exception 'the wording is not an acceptable service message' using errcode = '22023', hint = 'wording_invalid';
  end if;
  if p_kind = 'overdue' and p_body not like '%{{penal_text}}%' then
    raise exception 'an overdue message must carry the penal-charge text' using errcode = '22023', hint = 'penal_text_variable_missing';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('reminder_template:' || p_lender::text || p_kind || p_language, 0));
  select coalesce(max(t.version), 0) + 1 into v_version from servicing.reminder_templates t
   where t.lender_org_id = p_lender and t.kind = p_kind and t.language = p_language;
  insert into servicing.reminder_templates (lender_org_id, kind, language, version, body, drafted_by)
  values (p_lender, p_kind, p_language, v_version, p_body, v_uid)
  returning id into v_id;
  perform private.servicing_audit(p_lender, 'reminder.template.drafted', 'reminder_template', v_id::text,
    jsonb_build_object('kind', p_kind, 'language', p_language, 'version', v_version));
  return v_id;
end
$$;
comment on function servicing.draft_reminder_template(uuid, text, text, text) is
  'reminder.policy.manage of the lender, aal2. Drafts the next version of the wording for (kind, language). The wording must be a service message: private.reminder_text_ok (22023 wording_invalid), and an overdue wording must contain {{penal_text}} (22023 penal_text_variable_missing). The text is never written to the audit log.';

create or replace function servicing.approve_reminder_template(p_template uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_row servicing.reminder_templates;
  v_old uuid;
begin
  select * into v_row from servicing.reminder_templates t
   where t.id = p_template and t.lender_org_id in (select private.orgs_with_permission('reminder.template.approve'));
  if v_uid is null or not found then
    raise exception 'template not found' using errcode = 'P0002';
  end if;
  perform private.require_aal2();
  if v_row.status <> 'draft' then
    raise exception 'only a draft can be approved' using errcode = '55000', hint = 'not_a_draft';
  end if;
  if v_row.drafted_by = v_uid then
    raise exception 'the person who drafted it cannot approve it' using errcode = '42501', hint = 'self_approval';
  end if;
  for v_old in select t.id from servicing.reminder_templates t
                where t.lender_org_id = v_row.lender_org_id and t.kind = v_row.kind and t.language = v_row.language and t.status = 'approved' loop
    update servicing.reminder_templates set status = 'retired', retired_by = v_uid, retired_at = clock_timestamp() where id = v_old;
  end loop;
  update servicing.reminder_templates set status = 'approved', approved_by = v_uid, approved_at = clock_timestamp() where id = v_row.id;
  perform private.servicing_audit(v_row.lender_org_id, 'reminder.template.approved', 'reminder_template', v_row.id::text,
    jsonb_build_object('kind', v_row.kind, 'language', v_row.language, 'version', v_row.version));
  return 'approved';
end
$$;
comment on function servicing.approve_reminder_template(uuid) is
  'reminder.template.approve of the lender, aal2, and a DIFFERENT person than the drafter (42501 self_approval). Approves the draft and retires the previous approved version of the same kind and language. A message already claimed keeps the wording it was frozen with.';

create or replace function servicing.retire_reminder_template(p_template uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_row servicing.reminder_templates;
begin
  select * into v_row from servicing.reminder_templates t
   where t.id = p_template and t.lender_org_id in (select private.orgs_with_permission('reminder.policy.manage'));
  if v_uid is null or not found then
    raise exception 'template not found' using errcode = 'P0002';
  end if;
  perform private.require_aal2();
  if v_row.status = 'retired' then
    raise exception 'already retired' using errcode = '55000', hint = 'already_retired';
  end if;
  update servicing.reminder_templates set status = 'retired', retired_by = v_uid, retired_at = clock_timestamp() where id = v_row.id;
  perform private.servicing_audit(v_row.lender_org_id, 'reminder.template.retired', 'reminder_template', v_row.id::text,
    jsonb_build_object('kind', v_row.kind, 'language', v_row.language, 'version', v_row.version));
  return 'retired';
end
$$;
comment on function servicing.retire_reminder_template(uuid) is
  'reminder.policy.manage of the lender, aal2. Retires a draft or approved wording. Messages of that kind and language then find no wording and are suppressed (template_missing).';

create or replace function servicing.draft_penal_charge_text(
  p_lender uuid, p_charge_kind text, p_flat_amount_minor bigint, p_percent_bps integer, p_separate_from_interest boolean, p_not_compounded boolean,
  p_reason text, p_sentence_en text, p_sentence_hi text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.servicing_require_user(p_lender, 'reminder.policy.manage');
  v_version integer;
  v_id uuid;
begin
  if p_charge_kind is null or p_charge_kind not in ('flat', 'percentage')
     or (p_charge_kind = 'flat' and (p_flat_amount_minor is null or p_flat_amount_minor not between 1 and 100000000000 or p_percent_bps is not null))
     or (p_charge_kind = 'percentage' and (p_percent_bps is null or p_percent_bps not between 1 and 100000 or p_flat_amount_minor is not null)) then
    raise exception 'the charge must be a flat amount or a percentage, not both' using errcode = '22023', hint = 'charge_invalid';
  end if;
  if p_separate_from_interest is not true or p_not_compounded is not true then
    raise exception 'the lender must attest that the charge is separate from interest and not compounded' using errcode = '22023', hint = 'attestation_missing';
  end if;
  if p_reason is null or length(trim(p_reason)) not between 10 and 200 or not private.reminder_text_ok(p_reason, false)
     or not private.reminder_text_ok(p_sentence_en, false) or (p_sentence_hi is not null and not private.reminder_text_ok(p_sentence_hi, false)) then
    raise exception 'the sentence or the reason is not acceptable' using errcode = '22023', hint = 'wording_invalid';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('penal_text:' || p_lender::text, 0));
  select coalesce(max(t.version), 0) + 1 into v_version from servicing.penal_charge_texts t where t.lender_org_id = p_lender;
  insert into servicing.penal_charge_texts (lender_org_id, version, charge_kind, flat_amount_minor, percent_bps, separate_from_interest, not_compounded,
                                            reason, sentence_en, sentence_hi, drafted_by)
  values (p_lender, v_version, p_charge_kind, p_flat_amount_minor, p_percent_bps, true, true, trim(p_reason), p_sentence_en, p_sentence_hi, v_uid)
  returning id into v_id;
  perform private.servicing_audit(p_lender, 'reminder.penal_text.drafted', 'penal_charge_text', v_id::text, jsonb_build_object('version', v_version));
  return v_id;
end
$$;
comment on function servicing.draft_penal_charge_text(uuid, text, bigint, integer, boolean, boolean, text, text, text) is
  'reminder.policy.manage of the lender, aal2. Drafts the lender''s penal-charge disclosure: a flat amount or a percentage of the overdue amount, the lender''s attestations (separate from interest, not compounded) and the sentence to show. Udofin never writes, computes or adjusts this text.';

create or replace function servicing.approve_penal_charge_text(p_text uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_row servicing.penal_charge_texts;
  v_old uuid;
begin
  select * into v_row from servicing.penal_charge_texts t
   where t.id = p_text and t.lender_org_id in (select private.orgs_with_permission('reminder.template.approve'));
  if v_uid is null or not found then
    raise exception 'text not found' using errcode = 'P0002';
  end if;
  perform private.require_aal2();
  if v_row.status <> 'draft' then
    raise exception 'only a draft can be approved' using errcode = '55000', hint = 'not_a_draft';
  end if;
  if v_row.drafted_by = v_uid then
    raise exception 'the person who drafted it cannot approve it' using errcode = '42501', hint = 'self_approval';
  end if;
  for v_old in select t.id from servicing.penal_charge_texts t where t.lender_org_id = v_row.lender_org_id and t.status = 'approved' loop
    update servicing.penal_charge_texts set status = 'retired', retired_by = v_uid, retired_at = clock_timestamp() where id = v_old;
  end loop;
  update servicing.penal_charge_texts set status = 'approved', approved_by = v_uid, approved_at = clock_timestamp() where id = v_row.id;
  perform private.servicing_audit(v_row.lender_org_id, 'reminder.penal_text.approved', 'penal_charge_text', v_row.id::text, jsonb_build_object('version', v_row.version));
  return 'approved';
end
$$;
comment on function servicing.approve_penal_charge_text(uuid) is
  'reminder.template.approve of the lender, aal2, and a DIFFERENT person than the drafter (42501 self_approval). Approves the draft and retires the previous text. Overdue reminders of this lender can be sent from now on; those already suppressed (penal_text_missing) are not revived.';

create or replace function servicing.retire_penal_charge_text(p_text uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_row servicing.penal_charge_texts;
begin
  select * into v_row from servicing.penal_charge_texts t
   where t.id = p_text and t.lender_org_id in (select private.orgs_with_permission('reminder.policy.manage'));
  if v_uid is null or not found then
    raise exception 'text not found' using errcode = 'P0002';
  end if;
  perform private.require_aal2();
  if v_row.status = 'retired' then
    raise exception 'already retired' using errcode = '55000', hint = 'already_retired';
  end if;
  update servicing.penal_charge_texts set status = 'retired', retired_by = v_uid, retired_at = clock_timestamp() where id = v_row.id;
  perform private.servicing_audit(v_row.lender_org_id, 'reminder.penal_text.retired', 'penal_charge_text', v_row.id::text, jsonb_build_object('version', v_row.version));
  return 'retired';
end
$$;
comment on function servicing.retire_penal_charge_text(uuid) is
  'reminder.policy.manage of the lender, aal2. Retires a draft or approved text. With no approved text the lender''s overdue reminders are not sent (penal_text_missing) and the lender gets an exception.';

-- ---------------------------------------------------------------------------------------------
-- G. Holds
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
  if p_reason is null or p_reason not in ('complaint', 'hardship', 'dispute', 'lender_instruction', 'borrower_request', 'legal')
     or (p_note is not null and not private.reminder_text_ok(p_note, false)) then
    raise exception 'invalid hold' using errcode = '22023', hint = 'hold_invalid';
  end if;
  begin
    insert into servicing.communication_holds (lender_org_id, loan_account_id, reason, note, placed_by)
    values (l.lender_org_id, l.id, p_reason, p_note, v_uid)
    returning id into v_id;
  exception when unique_violation then
    raise exception 'the loan already has an active hold' using errcode = '23505', hint = 'hold_active';
  end;
  update servicing.reminders set status = 'suppressed', suppress_reason = 'hold' where loan_account_id = l.id and status = 'planned';
  perform private.servicing_audit(l.lender_org_id, 'reminder.hold.placed', 'loan_account', l.id::text, jsonb_build_object('hold_id', v_id, 'reason', p_reason));
  return v_id;
end
$$;
comment on function servicing.place_communication_hold(uuid, text, text) is
  'reminder.policy.manage of the lender, aal2. Pauses reminders for one loan (complaint, hardship, dispute, lender_instruction, borrower_request, legal) and suppresses the messages still planned (hold). One active hold per loan (23505 hold_active). The borrower can still pay. The free-text note is checked as a service message and is not written to the audit log.';

create or replace function servicing.release_communication_hold(p_hold uuid, p_note text default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  h servicing.communication_holds;
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
  if p_note is not null and not private.reminder_text_ok(p_note, false) then
    raise exception 'invalid note' using errcode = '22023', hint = 'hold_invalid';
  end if;
  update servicing.communication_holds set released_by = v_uid, released_at = clock_timestamp(), release_note = p_note where id = h.id;
  perform private.servicing_audit(h.lender_org_id, 'reminder.hold.released', 'loan_account', h.loan_account_id::text, jsonb_build_object('hold_id', h.id));
  return 'released';
end
$$;
comment on function servicing.release_communication_hold(uuid, text) is
  'reminder.policy.manage of the lender, aal2. Releases the hold. Messages suppressed during the hold stay suppressed; new ones are planned from the next planner run.';

-- ---------------------------------------------------------------------------------------------
-- H. The system side: plan, claim, record
-- ---------------------------------------------------------------------------------------------
-- Plans the messages that fall due in the next p_horizon (and the ones up to 48 hours late) for every lender whose reminders switch is on and
-- that has an approved policy. Idempotent: the unique key makes a second run a no-op, and a message that already exists under an earlier policy
-- version is not planned again. Overdue messages are planned for ONE anchor installment: the oldest overdue installment, taken from the days
-- past due the lender reported. sms rows are planned only as suppressed placeholders (sms_not_configured).
create or replace function servicing.plan_reminders(p_horizon interval default interval '3 days', p_limit integer default 5000)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_params record;
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
      and i.due_date between (now() at time zone 'Asia/Kolkata')::date - 91 and (now() at time zone 'Asia/Kolkata')::date + 31 + ceil(extract(epoch from p_horizon) / 86400)::integer
    cross join lateral (
      select o from unnest(pol.offsets_days) o
      union
      select w from generate_series(coalesce((select max(x) from unnest(pol.offsets_days) x where x > 0), 0) + 7, 90, 7) w where pol.overdue_weekly
    ) off (o)
    cross join lateral unnest(pol.channels) ch (c)
    where pol.status = 'approved'
      and greatest(pol.window_from, v_params.window_from) < least(pol.window_to, v_params.window_to)
      and private.feature_enabled(pol.lender_org_id, 'reminders') and private.feature_enabled(pol.lender_org_id, 'servicing_sync')
      and (off.o <= 0
           or (fig.ok and not fig.stale and coalesce(fig.total_overdue_minor, 0) > 0 and coalesce(fig.days_past_due, 0) > 0
               and i.due_date = (fig.reported_as_of at time zone 'Asia/Kolkata')::date - fig.days_past_due))
  ) q
  where q.scheduled_for between now() - interval '48 hours' and now() + p_horizon
    and not exists (select 1 from servicing.reminders x
                     where x.loan_account_id = q.loan_id and x.installment_seq = q.seq and x.offset_days = q.o and x.channel = q.ch and x.status <> 'suppressed')
  order by q.scheduled_for, q.loan_id, q.seq, q.o, q.ch
  limit p_limit
  on conflict (loan_account_id, installment_seq, offset_days, channel, policy_id) do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end
$$;
comment on function servicing.plan_reminders(interval, integer) is
  'System only (a periodic worker). Plans the reminders that fall due within the horizon, and those up to 48 hours late, for lenders whose reminders and servicing_sync switches are on and that have an approved policy: offsets from each installment of the newest schedule, the weekly overdue tail (up to 90 days past due), at the start of the effective window (the policy window narrowed by the platform window). Overdue messages are planned only for the oldest overdue installment of a loan whose newest report is consistent and fresh. Idempotent. sms is planned only as a suppressed placeholder. Returns how many rows were added.';

-- Takes the messages that are due, now, inside the window and still allowed, and freezes what each one will say. A message outside the
-- window is left planned (it is picked up in the next window); one more than 48 hours late is suppressed (expired). Everything that stops
-- a message is recorded with a reason from a closed list. Two workers never take the same row (skip locked); a worker that dies lets its
-- lease run out, and the row is taken again (at least once, at most 3 attempts).
create or replace function servicing.claim_due_reminders(p_limit integer default 100, p_lease interval default interval '10 minutes')
returns table (reminder_id uuid, lender_org_id uuid, loan_account_id uuid, borrower_id uuid, channel text, kind text, content_sha256 text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_params record;
  v_now timestamptz := clock_timestamp();
  v_today date := (clock_timestamp() at time zone 'Asia/Kolkata')::date;
  r servicing.reminders;
  pol servicing.reminder_policies;
  l servicing.loan_accounts;
  fig record;
  tpl servicing.reminder_templates;
  pen servicing.penal_charge_texts;
  v_from time;
  v_to time;
  v_max integer;
  v_why text;
  v_lang text;
  v_fallback boolean;
  v_amount bigint;
  v_vars jsonb;
  v_sentence text;
  v_text text;
  v_n integer;
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
  for r in
    select x.* from servicing.reminders x
     where x.scheduled_for <= v_now and (x.status = 'planned' or (x.status = 'claimed' and x.claimed_until < v_now and x.attempts < 3))
     order by x.scheduled_for, x.id
     limit p_limit
     for update skip locked
  loop
    v_why := null;
    select * into pol from servicing.reminder_policies p where p.id = r.policy_id;
    v_from := greatest(pol.window_from, v_params.window_from);
    v_to := least(pol.window_to, v_params.window_to);
    -- Outside the window, or the lender's switches are off: leave it planned (deferred, not dropped).
    if not private.reminder_in_window(private.reminder_window_clock(), v_from, v_to) then continue; end if;
    if not (private.feature_enabled(r.lender_org_id, 'reminders') and private.feature_enabled(r.lender_org_id, 'servicing_sync')) then continue; end if;
    select * into l from servicing.loan_accounts la where la.id = r.loan_account_id;
    if pol.status <> 'approved' then
      v_why := 'policy_retired';
    elsif l.status <> 'active' then
      v_why := 'loan_closed';
    elsif exists (select 1 from servicing.communication_holds h where h.loan_account_id = r.loan_account_id and h.released_at is null) then
      v_why := 'hold';
    elsif private.reminder_recent_payment(r.loan_account_id, v_params.suppress_hours) then
      v_why := 'recent_payment';
    end if;
    if v_why is null then
      select * into fig from private.reminder_figures(r.loan_account_id);
      -- No consistent, fresh report: nothing is claimed (an old figure could dun someone who has paid). It stays planned and expires if no report comes.
      if not coalesce(fig.ok, false) or fig.stale then continue; end if;
      if fig.reported_status <> 'active' then
        v_why := 'loan_closed';
      elsif r.kind = 'overdue' then
        if coalesce(fig.total_overdue_minor, 0) <= 0 or coalesce(fig.days_past_due, 0) <= 0 then v_why := 'nothing_overdue'; end if;
        v_amount := fig.total_overdue_minor;
      else
        if fig.next_due_on is null or coalesce(fig.next_due_minor, 0) <= 0 then
          v_why := 'nothing_due';
        elsif r.due_date < fig.next_due_on then
          v_why := 'paid';
        elsif r.due_date > fig.next_due_on then
          continue;
        end if;
        v_amount := fig.next_due_minor;
      end if;
    end if;
    if v_why is null and r.kind = 'overdue' then
      if r.penal_text_id is not null then
        select * into pen from servicing.penal_charge_texts t where t.id = r.penal_text_id and t.status = 'approved';
      else
        select * into pen from servicing.penal_charge_texts t where t.lender_org_id = r.lender_org_id and t.status = 'approved';
      end if;
      if not found then
        v_why := 'penal_text_missing';
        perform private.raise_exception_impl(r.lender_org_id, 'penal_text_missing', 'warning', 'lender', jsonb_build_object('lender_org_id', r.lender_org_id::text));
      end if;
    end if;
    if v_why is null then
      -- One loan at a time, so two workers cannot both take the second message of the day.
      perform pg_advisory_xact_lock(hashtextextended('reminder_cap:' || r.loan_account_id::text, 0));
      v_max := least(pol.max_per_day, v_params.max_per_day);
      select count(*) into v_n from (
        select distinct x.installment_seq, x.offset_days from servicing.reminders x
         where x.loan_account_id = r.loan_account_id and x.claimed_at is not null and (x.claimed_at at time zone 'Asia/Kolkata')::date = v_today
           and not (x.installment_seq = r.installment_seq and x.offset_days = r.offset_days)) q;
      if v_n >= v_max then continue; end if;
    end if;
    if v_why is null and r.content_sha256 is null then
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
    if r.content_sha256 is null then
      v_sentence := case when r.kind = 'overdue' then case when v_lang = 'hi' then pen.sentence_hi else pen.sentence_en end end;
      v_vars := jsonb_build_object('due_date', r.due_date::text, 'amount_minor', v_amount,
                                   'lender_name', (select o.display_name from tenancy.organizations o where o.id = r.lender_org_id));
      v_text := private.render_reminder(tpl.body, v_vars, v_sentence);
      update servicing.reminders x set
        status = 'claimed', attempts = x.attempts + 1, claimed_until = v_now + p_lease, claimed_at = coalesce(x.claimed_at, v_now),
        template_id = tpl.id, language_used = v_lang, language_fallback = v_fallback, penal_text_id = case when r.kind = 'overdue' then pen.id end,
        variables = v_vars, content_sha256 = encode(sha256(convert_to(v_text, 'UTF8')), 'hex'),
        penal_text_sha256 = case when v_sentence is not null then encode(sha256(convert_to(v_sentence, 'UTF8')), 'hex') end
       where x.id = r.id
       returning x.* into r;
    else
      update servicing.reminders x set status = 'claimed', attempts = x.attempts + 1, claimed_until = v_now + p_lease, claimed_at = coalesce(x.claimed_at, v_now)
       where x.id = r.id
       returning x.* into r;
    end if;
    reminder_id := r.id; lender_org_id := r.lender_org_id; loan_account_id := r.loan_account_id; borrower_id := r.borrower_id;
    channel := r.channel; kind := r.kind; content_sha256 := r.content_sha256;
    return next;
  end loop;
end
$$;
comment on function servicing.claim_due_reminders(integer, interval) is
  'System only. Claims up to p_limit due reminders for a worker (skip locked, a lease of p_lease, at most 3 attempts) and freezes what each says. Only inside the effective window (08:00 to 19:00 IST by default, narrowed by the lender policy); otherwise the message waits for the next window. A message is suppressed, with its reason, when the policy was retired, the loan is closed, a hold is active, a payment was verified or posted in the quiet period (48 hours by default), nothing is due or overdue per the lender''s newest report, no approved wording exists, or (overdue) the lender has no approved penal-charge text: then the lender gets a penal_text_missing exception and NOTHING is invented. Without a consistent, fresh lender report nothing is claimed. At most max_per_day distinct messages per loan per IST day (the same message on several channels counts once). Returns the claimed rows without their text: the borrower reads the message in the app.';

-- The worker reports what happened. send: accepted (the channel took it: for in_app, the message is in the inbox), failed (retried up to 3 times with
-- a delay) or not_configured (the channel has no provider: the message is suppressed, never reported as sent). delivery_report: delivered or failed,
-- from a provider report only. A duplicate report answers 'duplicate'.
create or replace function servicing.record_reminder_attempt(p_reminder uuid, p_state text, p_source text, p_provider_ref text default null, p_error_class text default null)
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
     or (p_state = 'failed' and p_error_class is null) or (p_state <> 'failed' and p_error_class is not null) then
    raise exception 'invalid attempt' using errcode = '22023', hint = 'bad_request';
  end if;
  select * into r from servicing.reminders x where x.id = p_reminder for update;
  if not found then
    raise exception 'reminder not found' using errcode = 'P0002';
  end if;
  if p_source = 'send' and (r.status <> 'claimed' or r.content_sha256 is null) then
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
comment on function servicing.record_reminder_attempt(uuid, text, text, text, text) is
  'System only. Records an attempt in the append-only delivery log with the hash of the wording that was sent. send/accepted: the channel took the message (reminder sent; NOT proof of delivery); send/failed: retried after 15 minutes times the attempt, at most 3 attempts, then failed; send/not_configured: the channel has no provider (suppressed channel_not_configured, never sent); delivery_report/delivered or failed: only from a provider report, only for a sent reminder. A repeated report answers duplicate. An sms attempt can only be not_configured.';

-- A loan closed, a dispute or a lender instruction: nothing planned goes out.
create or replace function servicing.suppress_reminders_for_loan(p_loan uuid, p_reason text)
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
  if p_reason is null or p_reason not in ('loan_closed', 'hold', 'paid') then
    raise exception 'invalid reason' using errcode = '22023', hint = 'bad_request';
  end if;
  update servicing.reminders set status = 'suppressed', suppress_reason = p_reason where loan_account_id = p_loan and status = 'planned';
  get diagnostics v_n = row_count;
  return v_n;
end
$$;
comment on function servicing.suppress_reminders_for_loan(uuid, text) is
  'System only. Suppresses the still planned reminders of a loan (loan_closed, hold or paid). Returns how many. Claimed or sent messages are not touched.';

-- ---------------------------------------------------------------------------------------------
-- I. The borrower
-- ---------------------------------------------------------------------------------------------
-- One row per message (a message sent on two channels shows once): the exact wording that was sent, rebuilt from the frozen references and
-- checked against the stored hash; a row whose hash does not match is not shown.
create or replace function servicing.my_reminders()
returns table (reminder_id uuid, loan_account_id uuid, lender_display_name text, kind text, due_date date, sent_at timestamptz, message text, read_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select m.id, m.loan_account_id, m.lender_name, m.kind, m.due_date, m.sent_at, m.msg, m.read_at
  from (
    select distinct on (r.loan_account_id, r.installment_seq, r.offset_days)
           r.id, r.loan_account_id, r.variables ->> 'lender_name' as lender_name, r.kind, r.due_date, s.occurred_at as sent_at, g.msg,
           (select min(d.occurred_at) from servicing.reminder_deliveries d join servicing.reminders r2 on r2.id = d.reminder_id
             where d.state = 'read' and r2.loan_account_id = r.loan_account_id and r2.installment_seq = r.installment_seq and r2.offset_days = r.offset_days) as read_at
    from servicing.reminders r
    join servicing.reminder_templates t on t.id = r.template_id and t.lender_org_id = r.lender_org_id
    left join servicing.penal_charge_texts p on p.id = r.penal_text_id and p.lender_org_id = r.lender_org_id
    join lateral (select d.occurred_at from servicing.reminder_deliveries d
                   where d.reminder_id = r.id and d.state = 'accepted' and d.source = 'send' order by d.occurred_at limit 1) s on true
    cross join lateral (select private.render_reminder(t.body, r.variables, case r.language_used when 'hi' then p.sentence_hi else p.sentence_en end) as msg) g
    where r.borrower_id = (select private.my_borrower_id()) and r.status = 'sent'
      and private.feature_enabled(r.lender_org_id, 'reminders')
      and encode(sha256(convert_to(g.msg, 'UTF8')), 'hex') = r.content_sha256
    order by r.loan_account_id, r.installment_seq, r.offset_days, s.occurred_at, r.id
  ) m
  order by m.sent_at desc, m.id
  limit 50
$$;
comment on function servicing.my_reminders() is
  'Borrower only (empty for anyone else). The caller''s most recent 50 sent reminders, one per message: lender, kind, due date, when it was sent, the exact wording and when it was read. The wording is rebuilt from the frozen template, variables and penal-charge sentence and shown only if it matches the hash stored when it was claimed. Lenders whose reminders switch is off are not listed.';

create or replace function servicing.mark_reminder_read(p_reminder uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_borrower uuid := private.my_borrower_id();
  r servicing.reminders;
  x record;
begin
  if (select auth.uid()) is null or v_borrower is null then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  select * into r from servicing.reminders y where y.id = p_reminder and y.borrower_id = v_borrower and y.status = 'sent';
  if not found or not private.feature_enabled(r.lender_org_id, 'reminders') then
    raise exception 'reminder not found' using errcode = 'P0002';
  end if;
  for x in
    select y.* from servicing.reminders y
     where y.loan_account_id = r.loan_account_id and y.installment_seq = r.installment_seq and y.offset_days = r.offset_days
       and y.borrower_id = v_borrower and y.status = 'sent'
  loop
    insert into servicing.reminder_deliveries (reminder_id, lender_org_id, channel, state, source, content_sha256, penal_text_sha256)
    values (x.id, x.lender_org_id, x.channel, 'read', 'app', x.content_sha256, x.penal_text_sha256)
    on conflict do nothing;
  end loop;
  return 'read';
end
$$;
comment on function servicing.mark_reminder_read(uuid) is
  'Borrower only. Records that the caller opened one of their own sent reminders (every channel copy of the same message). Idempotent. Another borrower''s reminder, an unknown one or one that was not sent answers P0002.';

-- ---------------------------------------------------------------------------------------------
-- J. For the lender portal
-- ---------------------------------------------------------------------------------------------
-- Runs as the caller (row level security: loan.read of the lender).
create or replace function servicing.reminder_summary(p_lender uuid, p_since timestamptz default (now() - interval '30 days'))
returns table (status text, suppress_reason text, channel text, n bigint)
language sql
stable
set search_path = ''
as $$
  select r.status, r.suppress_reason, r.channel, count(*)
    from servicing.reminders r
   where r.lender_org_id = p_lender and r.scheduled_for >= p_since
   group by r.status, r.suppress_reason, r.channel
   order by r.status, r.suppress_reason nulls first, r.channel
$$;
comment on function servicing.reminder_summary(uuid, timestamptz) is
  'Counts of the lender''s reminders by status, suppression reason and channel since p_since (default 30 days). SECURITY INVOKER: row level security applies (loan.read). No borrower, loan or message is named.';

-- ---------------------------------------------------------------------------------------------
-- K. Row level security, grants
-- ---------------------------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['reminder_policies', 'reminder_templates', 'penal_charge_texts', 'communication_holds', 'reminders', 'reminder_deliveries']
  loop
    execute format('alter table servicing.%I enable row level security', t);
    execute format('alter table servicing.%I force row level security', t);
    if t in ('reminder_policies', 'reminder_templates', 'penal_charge_texts') then
      -- The people who write and approve the wording see it, and so does anyone who reads loans of the lender.
      execute format('create policy %I on servicing.%I for select to authenticated using (lender_org_id in (
                        select private.orgs_with_permission(%L) union select private.orgs_with_permission(%L) union select private.orgs_with_permission(%L)))',
                     t || '_lender_read', t, 'loan.read', 'reminder.policy.manage', 'reminder.template.approve');
    else
      execute format('create policy %I on servicing.%I for select to authenticated using (lender_org_id in (select private.orgs_with_permission(%L)))',
                     t || '_lender_read', t, 'loan.read');
    end if;
    execute format('revoke all on servicing.%I from public, anon, authenticated, service_role', t);
    execute format('grant select on servicing.%I to authenticated, service_role', t);
  end loop;
end
$$;

revoke all on function servicing.draft_reminder_policy(uuid, integer[], boolean, text[], time, time, integer) from public;
revoke all on function servicing.approve_reminder_policy(uuid) from public;
revoke all on function servicing.retire_reminder_policy(uuid) from public;
revoke all on function servicing.draft_reminder_template(uuid, text, text, text) from public;
revoke all on function servicing.approve_reminder_template(uuid) from public;
revoke all on function servicing.retire_reminder_template(uuid) from public;
revoke all on function servicing.draft_penal_charge_text(uuid, text, bigint, integer, boolean, boolean, text, text, text) from public;
revoke all on function servicing.approve_penal_charge_text(uuid) from public;
revoke all on function servicing.retire_penal_charge_text(uuid) from public;
revoke all on function servicing.place_communication_hold(uuid, text, text) from public;
revoke all on function servicing.release_communication_hold(uuid, text) from public;
revoke all on function servicing.plan_reminders(interval, integer) from public;
revoke all on function servicing.claim_due_reminders(integer, interval) from public;
revoke all on function servicing.record_reminder_attempt(uuid, text, text, text, text) from public;
revoke all on function servicing.suppress_reminders_for_loan(uuid, text) from public;
revoke all on function servicing.my_reminders() from public;
revoke all on function servicing.mark_reminder_read(uuid) from public;
revoke all on function servicing.reminder_summary(uuid, timestamptz) from public;
grant execute on function servicing.draft_reminder_policy(uuid, integer[], boolean, text[], time, time, integer) to authenticated;
grant execute on function servicing.approve_reminder_policy(uuid) to authenticated;
grant execute on function servicing.retire_reminder_policy(uuid) to authenticated;
grant execute on function servicing.draft_reminder_template(uuid, text, text, text) to authenticated;
grant execute on function servicing.approve_reminder_template(uuid) to authenticated;
grant execute on function servicing.retire_reminder_template(uuid) to authenticated;
grant execute on function servicing.draft_penal_charge_text(uuid, text, bigint, integer, boolean, boolean, text, text, text) to authenticated;
grant execute on function servicing.approve_penal_charge_text(uuid) to authenticated;
grant execute on function servicing.retire_penal_charge_text(uuid) to authenticated;
grant execute on function servicing.place_communication_hold(uuid, text, text) to authenticated;
grant execute on function servicing.release_communication_hold(uuid, text) to authenticated;
grant execute on function servicing.plan_reminders(interval, integer) to service_role;
grant execute on function servicing.claim_due_reminders(integer, interval) to service_role;
grant execute on function servicing.record_reminder_attempt(uuid, text, text, text, text) to service_role;
grant execute on function servicing.suppress_reminders_for_loan(uuid, text) to service_role;
grant execute on function servicing.my_reminders() to authenticated;
grant execute on function servicing.mark_reminder_read(uuid) to authenticated;
grant execute on function servicing.reminder_summary(uuid, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- L. Activation prerequisites for servicing_sync, statements_noc and reminders (every earlier check preserved)
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
  if p_feature = 'payments' then
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
  -- Later Phase 08a migrations add further feature-specific checks here (mandates, ...): copy this body from the highest-numbered
  -- migration that defines it, append, and never remove or weaken a reason.
  return array(select distinct x from unnest(v_reasons) x order by x);
end
$$;
comment on function private.feature_prerequisites_unmet(uuid, text) is
  'Reasons a feature cannot be switched on for a lender; empty array = none. Generic checks: feature unknown or not enableable, lender organisation not active, onboarding gate not activated, evidence missing (the single pending enable request must carry evidence). payments (migration 20261018000910): payment_config_missing (no ACTIVE configuration in production mode), payment_config_mock_or_sandbox_only (only a mock or sandbox configuration is active: it can never satisfy the gate), registry_entry_not_verified (no active production configuration settles into a verified registry entry), payment_config_validation_failed (no active production configuration passes payments.validate_collection_target). EXTENDING: later migrations add feature-specific checks with CREATE OR REPLACE and MUST PRESERVE every earlier check (copy the body of the highest-numbered migration that defines this function and append; never remove or weaken a reason). A mock or sandbox provider record must never satisfy a check: use private.provider_mode_satisfies_production_gate. servicing_sync (migration 20261018000914): lms_connection_not_active (no ACTIVE file_import or manual connection in production mode). statements_noc: servicing_sync_not_enabled. reminders: servicing_sync_not_enabled, reminder_policy_missing (no approved policy), reminder_templates_missing (no approved English wording for each of pre_due, due_day and overdue).';
revoke all on function private.feature_prerequisites_unmet(uuid, text) from public;
grant execute on function private.feature_prerequisites_unmet(uuid, text) to service_role;
