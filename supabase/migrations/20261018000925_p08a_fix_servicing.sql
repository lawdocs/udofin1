-- =============================================================================================
-- Phase 08a review-fix wave, builder SS: servicing sync, import, receipts, lender documents, quotations and closure.
-- Forward-only. It redefines only functions of migrations 20261018000911 and 20261018000912 (never servicing.set_lms_connection).
--
-- Findings handled (the review IDs are in docs/specs/08a-notes/fixes-SS.md):
--   A2/M12  the closure's NOC pointer follows a corrected (superseding) document, and a NOC replaces a closure letter.
--   A3/U39/U40/U58  one shared free-text screen (spaced digits, lower-case PAN, links, e-mail, other scripts' digits) for decline
--           notes, delay reasons, import reject reasons and conflict resolution notes; triggers on the two columns that had none.
--   A4      an invalid import batch no longer holds its file hash (the same bytes can be staged again).
--   A6/M11  an idempotent replay of a document or quotation compares the request, the superseded document, the period and the letter,
--           and still fulfils an open request.
--   A7      the task / request row is locked before its status is read (a concurrent loser gets already_confirmed, not a raw P0001).
--   M8      a loan or schedule conflict confirmed as 'incoming' needs the incoming version stored as a newer report first.
--   M9      reversals are modelled by amount: servicing.lms_receipts_net and private.servicing_receipt_is_reversed.
--   M10     the system role cannot write file or manual-import records: the single apply function refuses them without a batch and person.
--   M13     the borrower reference test is anchored to the whole reference (a UUID is never refused), U38: the same PAN-shape test on
--           every other reference, a mode that is a long number and a bank reference shaped like a mobile or an account number.
--   M14     a NOC request is due from the closure record when the rule's basis says closure_recorded.
--   M15     quotation validity is bounded (31 days) and a quotation is not offered after a later receipt or a later report that
--           shows the loan changed.
--   M16     the machine-feed gate re-checks the mock guard at use time.
--   M17     a receipt dated after the day of its own report is an error (receipt_date_in_future).
--   M18     latest_valid_quote no longer returns the reporting lender user's id to anyone but the lender's own readers.
--   M19     a quarantined report enqueues servicing.sync_quarantine.opened (ids only).
--   U44     the security-release rule is labelled 'likely' (applicability to the product categories rests on a cross-reference that
--           the primary extract on file did not read).
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- 1. One free-text screen for every lender-typed note in servicing (A3, U39, U40, U58)
-- ---------------------------------------------------------------------------------------------
-- Digits of the Indian scripts, Arabic-Indic and full-width digits become ASCII digits (a number written in Devanagari is still a number).
create or replace function private.servicing_ascii_digits(p_text text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select translate(p_text,
    (select string_agg(chr(b + n), '' order by b, n)
       from unnest(array[1632, 1776, 2406, 2534, 2662, 2790, 2918, 3046, 3174, 3302, 3430, 65296]) b, generate_series(0, 9) n),
    repeat('0123456789', 12))
$$;
revoke all on function private.servicing_ascii_digits(text) from public;
grant execute on function private.servicing_ascii_digits(text) to authenticated, service_role;
comment on function private.servicing_ascii_digits(text) is
  'Maps the decimal digits of Devanagari, Bengali, Gurmukhi, Gujarati, Odia, Tamil, Telugu, Kannada, Malayalam, Arabic-Indic, extended Arabic-Indic and full-width forms to 0-9. Helper of private.servicing_text_safe.';

-- Free text a lender may enter (a note, a delay reason, a reject reason). Defence in depth, not a personal-data scanner (a name cannot be
-- recognised by shape). It refuses: an e-mail address or an @; a link (a scheme, www., or any domain-like token such as bit.ly/x or pay.link);
-- 8 or more digits in a row, or 9 or more once spaces and separators between digits are removed (so '1234 5678 9012', '98765 43210' and
-- '+91 98765-43210' are refused; so is 12/10/2026 15:30, which reads as a number once its separators go); a PAN-shaped token in any case,
-- also with spaces or separators inside it ('abcde 1234 f'). Digits of other scripts count as digits. A null is safe (nothing to check).
create or replace function private.servicing_text_safe(p_text text)
returns boolean
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
declare
  v text;
  v_joined text;
begin
  if p_text is null then return true; end if;
  v := private.servicing_ascii_digits(lower(p_text));
  if v ~ '@' or v ~ '(https?|ftp|file)[:]//' or v ~ '(^|[^a-z0-9])www[.]'
     or v ~ '(^|[^a-z0-9])[a-z0-9][a-z0-9-]*[.][a-z]{2,24}($|[^a-z])' then
    return false;
  end if;
  if v ~ '[0-9]{8,}' then return false; end if;
  v_joined := regexp_replace(v, '(?<=[0-9])[[:space:]._/:+(),-]+(?=[0-9])', '', 'g');
  if v_joined ~ '[0-9]{9,}' then return false; end if;
  if v ~ '[a-z]{5}[0-9]{4}[a-z]'
     or v ~ '(^|[^a-z])[a-z]{5}[[:space:]._/-]*[0-9]([[:space:]._/-]*[0-9]){3}[[:space:]._/-]*[a-z]([^a-z]|$)' then
    return false;
  end if;
  return true;
end
$$;
revoke all on function private.servicing_text_safe(text) from public;
grant execute on function private.servicing_text_safe(text) to authenticated, service_role;
comment on function private.servicing_text_safe(text) is
  'True when a lender-typed note carries no e-mail, link, long digit run (8 contiguous or 9 once separators are removed, digits of other scripts included) or PAN-shaped token (any case, spaces allowed). Used for decline notes, delay reasons, import reject reasons and conflict resolution notes. A shape check only: names cannot be recognised.';

-- Trigger for lender-typed columns that have no table check (arguments: the column names).
create or replace function private.servicing_reject_unsafe_text()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_col text;
  v_val text;
begin
  foreach v_col in array tg_argv loop
    v_val := to_jsonb(new) ->> v_col;
    if v_val is not null and not private.servicing_text_safe(v_val) then
      raise exception 'column % looks like it carries personal data, a contact detail or a link; write a reference instead', v_col
        using errcode = '22023', hint = 'unsafe_free_text';
    end if;
  end loop;
  return new;
end
$$;
revoke all on function private.servicing_reject_unsafe_text() from public;
comment on function private.servicing_reject_unsafe_text() is
  'Row trigger: refuses a lender-typed text column (named in the trigger arguments) that fails private.servicing_text_safe. Hint unsafe_free_text.';

create trigger unsafe_text before insert or update on servicing.import_batches
  for each row execute function private.servicing_reject_unsafe_text('reject_reason');
create trigger unsafe_text before insert or update on servicing.sync_conflicts
  for each row execute function private.servicing_reject_unsafe_text('resolution_note');

-- ---------------------------------------------------------------------------------------------
-- 2. Personal-looking references (M13, U38) and a receipt dated in the future (M17)
-- ---------------------------------------------------------------------------------------------
-- The shape test for an import reference. p_kind: 'borrower' (the borrower reference), 'mode' (a payment mode), 'bank' (a bank reference such
-- as a UTR or a UPI RRN) or 'ref' (every other lender reference). Separators - . : / _ are ignored.
--   all kinds   a PAN shape: the WHOLE reference, or one part between separators, is 5 letters, 4 digits and a letter (any case). A shape
--               that merely occurs inside a longer reference (a UUID, 'LOANX2026B7') is not a PAN and is no longer refused.
--   borrower    also a phone, Aadhaar, account or card number: 9 to 18 digits, an optional leading plus, nothing else.
--   mode        also any run of 9 or more digits (a mode is a short label such as upi or neft).
--   bank        also a 10-digit mobile number (starts 6 to 9) or a 13 to 18 digit number. A 9 to 12 digit number cannot be told from a
--               12-digit UPI RRN or an IMPS reference and is accepted.
create or replace function private.servicing_ref_looks_personal(p_text text, p_kind text)
returns boolean
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
declare
  v_compact text := regexp_replace(p_text, '[-.:/_]', '', 'g');
begin
  if v_compact ~* '^[a-z]{5}[0-9]{4}[a-z]$'
     or exists (select 1 from regexp_split_to_table(p_text, '[-.:/_]') t where t ~* '^[a-z]{5}[0-9]{4}[a-z]$') then
    return true;
  end if;
  return case p_kind
    when 'borrower' then v_compact ~ '^[+]?[0-9]{9,18}$'
    when 'mode' then v_compact ~ '[0-9]{9,}'
    when 'bank' then v_compact ~ '^[6-9][0-9]{9}$' or v_compact ~ '^[0-9]{13,18}$'
    else false end;
end
$$;
revoke all on function private.servicing_ref_looks_personal(text, text) from public;
comment on function private.servicing_ref_looks_personal(text, text) is
  'Shape test for an import reference (borrower, mode, bank or ref): a PAN-shaped whole reference or part, and per kind a phone, Aadhaar, account or card number shape. Anchored: a UUID or a longer reference that only contains a PAN-like run is accepted.';

create or replace function private.servicing_field_specs(p_kind text)
returns table (name text, ftype text, required boolean)
language sql
immutable
parallel safe
as $$
  select s.name, s.ftype, s.required from (values
    ('loan', 'lms_loan_ref', 'ref', true),
    ('loan', 'borrower_ref', 'opaque', true),
    ('loan', 'status', 'status', true),
    ('loan', 'sanctioned_amount', 'money_pos', true),
    ('loan', 'disbursed_amount', 'money_pos', false),
    ('loan', 'disbursement_ref', 'ref', false),
    ('loan', 'disbursement_date', 'date', false),
    ('loan', 'outstanding_principal', 'money', false),
    ('loan', 'next_due_date', 'date', false),
    ('loan', 'next_due_amount', 'money', false),
    ('loan', 'overdue_principal', 'money', false),
    ('loan', 'overdue_interest', 'money', false),
    ('loan', 'penal_charges', 'money', false),
    ('loan', 'other_charges', 'money', false),
    ('loan', 'total_overdue', 'money', false),
    ('loan', 'days_past_due', 'int5', false),
    ('loan', 'source_record_id', 'ref', true),
    ('loan', 'reported_as_of', 'ts', true),
    ('loan', 'sequence', 'int9', false),
    ('receipt', 'lms_loan_ref', 'ref', true),
    ('receipt', 'lms_receipt_ref', 'ref', true),
    ('receipt', 'receipt_kind', 'receipt_kind', true),
    ('receipt', 'reverses_receipt_ref', 'ref', false),
    ('receipt', 'amount', 'money_pos', true),
    ('receipt', 'value_date', 'date', true),
    ('receipt', 'payment_mode', 'ref_mode', false),
    ('receipt', 'bank_reference', 'ref_bank', false),
    ('receipt', 'source_record_id', 'ref', true),
    ('receipt', 'reported_as_of', 'ts', true),
    ('receipt', 'sequence', 'int9', false),
    ('schedule', 'lms_loan_ref', 'ref', true),
    ('schedule', 'source_record_id', 'ref', true),
    ('schedule', 'reported_as_of', 'ts', true),
    ('schedule', 'sequence', 'int9', false)
  ) as s (kind, name, ftype, required) where s.kind = p_kind
$$;

create or replace function private.servicing_parse_cell(p_ftype text, p_cell jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_text text;
  v_minor bigint;
  v_ts timestamptz;
  v_date date;
  v_max bigint;
begin
  case p_ftype
    when 'ref', 'opaque', 'ref_mode', 'ref_bank' then
      if jsonb_typeof(p_cell) <> 'string' then return jsonb_build_object('e', 'invalid_reference'); end if;
      v_text := p_cell #>> '{}';
      if p_ftype = 'opaque' and private.servicing_ref_looks_personal(v_text, 'borrower') then
        return jsonb_build_object('e', 'borrower_ref_looks_personal');
      end if;
      if v_text !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$' then return jsonb_build_object('e', 'invalid_reference'); end if;
      if p_ftype <> 'opaque'
         and private.servicing_ref_looks_personal(v_text, case p_ftype when 'ref_mode' then 'mode' when 'ref_bank' then 'bank' else 'ref' end) then
        return jsonb_build_object('e', 'ref_looks_personal');
      end if;
      return jsonb_build_object('v', p_cell);
    when 'money', 'money_pos' then
      if jsonb_typeof(p_cell) <> 'string' then return jsonb_build_object('e', 'invalid_amount'); end if;
      v_minor := private.servicing_try_money(p_cell #>> '{}');
      if v_minor is null then return jsonb_build_object('e', 'invalid_amount'); end if;
      if p_ftype = 'money_pos' and v_minor <= 0 then return jsonb_build_object('e', 'amount_not_positive'); end if;
      return jsonb_build_object('v', to_jsonb(v_minor::text));
    when 'date' then
      if jsonb_typeof(p_cell) <> 'string' then return jsonb_build_object('e', 'invalid_date'); end if;
      v_date := private.servicing_try_date(p_cell #>> '{}');
      if v_date is null then return jsonb_build_object('e', 'invalid_date'); end if;
      return jsonb_build_object('v', p_cell);
    when 'ts' then
      if jsonb_typeof(p_cell) <> 'string' then return jsonb_build_object('e', 'invalid_timestamp'); end if;
      v_ts := private.servicing_try_ts(p_cell #>> '{}');
      if v_ts is null then return jsonb_build_object('e', 'invalid_timestamp'); end if;
      if v_ts > clock_timestamp() + interval '15 minutes' then return jsonb_build_object('e', 'timestamp_in_future'); end if;
      return jsonb_build_object('v', to_jsonb(private.servicing_ts_text(v_ts)));
    when 'int5', 'int9', 'int600' then
      v_text := p_cell #>> '{}';
      v_max := (array[99999, 600, 999999999])[array_position(array['int5', 'int600', 'int9'], p_ftype)];
      if jsonb_typeof(p_cell) not in ('string', 'number') or v_text !~ '^[0-9]{1,9}$' then
        return jsonb_build_object('e', 'invalid_integer');
      end if;
      if v_text::bigint > v_max then
        return jsonb_build_object('e', 'invalid_integer');
      end if;
      return jsonb_build_object('v', to_jsonb(v_text::bigint));
    when 'status' then
      if jsonb_typeof(p_cell) <> 'string' or not ((p_cell #>> '{}') = any (array['active', 'closed', 'foreclosed', 'written_off', 'cancelled'])) then
        return jsonb_build_object('e', 'invalid_status');
      end if;
      return jsonb_build_object('v', p_cell);
    when 'receipt_kind' then
      if jsonb_typeof(p_cell) <> 'string' or not ((p_cell #>> '{}') = any (array['receipt', 'reversal'])) then
        return jsonb_build_object('e', 'invalid_receipt_kind');
      end if;
      return jsonb_build_object('v', p_cell);
    else
      raise exception 'unknown field type' using errcode = 'XX000';
  end case;
end
$$;

create or replace function private.servicing_validate(p_kind text, p_rec jsonb, p_meta boolean default false)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_codes text[] := '{}';
  v_fields text[] := '{}';
  v_flags text[] := '{}';
  v_p jsonb := '{}'::jsonb;
  v_spec record;
  v_cell jsonb;
  v_res jsonb;
  v_allowed text[];
  v_pairs jsonb;
  v_canon jsonb;
  v_hash text;
  v_items jsonb;
  v_item jsonb;
  v_idx integer;
  v_prev_due date;
  v_due date;
  v_item_canon jsonb := '[]'::jsonb;
  v_ipairs jsonb := '[]'::jsonb;
  v_ip jsonb;
  v_ik text;
  v_n integer;
  v_item_ok boolean;
begin
  if p_kind is null or p_kind not in ('loan', 'receipt', 'schedule') then
    raise exception 'unknown record kind' using errcode = '22023', hint = 'kind_invalid';
  end if;
  if p_rec is null or jsonb_typeof(p_rec) <> 'object' then
    return jsonb_build_object('canon', null, 'hash', null, 'codes', jsonb_build_array('row_not_object'), 'fields', '[]'::jsonb, 'flags', '[]'::jsonb, 'srid', null);
  end if;

  v_allowed := array(select s.name from private.servicing_field_specs(p_kind) s)
    || case when p_kind = 'schedule' then array['installments'] else '{}'::text[] end
    || case when p_meta then array['report_type', 'source_system', 'content_sha256'] else '{}'::text[] end;
  -- An unknown key is caller text (it could be a phone number): the class is recorded, the key never is.
  if exists (select 1 from jsonb_object_keys(p_rec) k where k <> all (v_allowed)) then
    v_codes := v_codes || 'unknown_field'::text;
  end if;

  for v_spec in select * from private.servicing_field_specs(p_kind) loop
    v_cell := p_rec -> v_spec.name;
    if v_cell is null or jsonb_typeof(v_cell) = 'null' or v_cell = '""'::jsonb then
      if v_spec.required then
        v_codes := v_codes || 'missing_required'::text; v_fields := v_fields || v_spec.name;
      end if;
      continue;
    end if;
    v_res := private.servicing_parse_cell(v_spec.ftype, v_cell);
    if v_res ? 'e' then
      v_codes := v_codes || (v_res ->> 'e'); v_fields := v_fields || v_spec.name;
    else
      v_p := v_p || jsonb_build_object(v_spec.name, v_res -> 'v');
    end if;
  end loop;

  -- Cross-field rules run only when every field is individually valid (as in the TypeScript normaliser).
  if p_kind = 'loan' and cardinality(v_codes) = 0 then
    v_n := (v_p ? 'disbursed_amount')::int + (v_p ? 'disbursement_ref')::int + (v_p ? 'disbursement_date')::int;
    if v_n not in (0, 3) then
      v_codes := v_codes || 'incomplete_disbursement'::text; v_fields := v_fields || 'disbursed_amount'::text;
    end if;
    if (v_p ? 'next_due_date') <> (v_p ? 'next_due_amount') then
      v_codes := v_codes || 'incomplete_next_due'::text; v_fields := v_fields || 'next_due_date'::text;
    end if;
    if v_p ? 'disbursed_amount' and (v_p ->> 'disbursed_amount')::bigint > (v_p ->> 'sanctioned_amount')::bigint then
      v_codes := v_codes || 'disbursed_exceeds_sanctioned'::text; v_fields := v_fields || 'disbursed_amount'::text;
    end if;
  elsif p_kind = 'receipt' and cardinality(v_codes) = 0 then
    if (v_p ->> 'receipt_kind') = 'reversal' then
      if not (v_p ? 'reverses_receipt_ref') or (v_p ->> 'reverses_receipt_ref') = (v_p ->> 'lms_receipt_ref') then
        v_codes := v_codes || 'reversal_reference_invalid'::text; v_fields := v_fields || 'reverses_receipt_ref'::text;
      end if;
    elsif v_p ? 'reverses_receipt_ref' then
      v_codes := v_codes || 'reversal_reference_invalid'::text; v_fields := v_fields || 'reverses_receipt_ref'::text;
    end if;
    -- A receipt cannot be dated after the day (India time) of the report that carries it: a future value date would keep a loan's
    -- reminders quiet for as long as it lies ahead (M17).
    if (v_p ->> 'value_date')::date > (((v_p ->> 'reported_as_of')::timestamptz) at time zone 'Asia/Kolkata')::date then
      v_codes := v_codes || 'receipt_date_in_future'::text; v_fields := v_fields || 'value_date'::text;
    end if;
  elsif p_kind = 'schedule' then
    v_items := p_rec -> 'installments';
    if v_items is null or jsonb_typeof(v_items) = 'null' or v_items = '""'::jsonb then
      v_codes := v_codes || 'missing_required'::text; v_fields := v_fields || 'installments'::text;
    elsif jsonb_typeof(v_items) <> 'array' or jsonb_array_length(v_items) not between 1 and 600
          or exists (select 1 from jsonb_array_elements(v_items) i where jsonb_typeof(i) <> 'object') then
      v_codes := v_codes || 'invalid_items'::text; v_fields := v_fields || 'installments'::text;
    else
      v_idx := 0;
      v_prev_due := null;
      for v_item in select value from jsonb_array_elements(v_items) loop
        v_idx := v_idx + 1;
        v_item_ok := true;
        v_ip := '{}'::jsonb;
        if exists (select 1 from jsonb_object_keys(v_item) k where k <> all (array['installment_seq', 'due_date', 'principal', 'interest', 'fees'])) then
          v_codes := v_codes || 'unknown_field'::text; v_item_ok := false;
        end if;
        for v_spec in select * from (values
            ('installment_seq', 'int600', true), ('due_date', 'date', true), ('principal', 'money', true),
            ('interest', 'money', true), ('fees', 'money', false)) as s (name, ftype, required) loop
          v_cell := v_item -> v_spec.name;
          if v_cell is null or jsonb_typeof(v_cell) = 'null' or v_cell = '""'::jsonb then
            if v_spec.required then
              v_codes := v_codes || 'missing_required'::text; v_fields := v_fields || v_spec.name; v_item_ok := false;
            end if;
            continue;
          end if;
          v_res := private.servicing_parse_cell(v_spec.ftype, v_cell);
          if v_res ? 'e' then
            v_codes := v_codes || (v_res ->> 'e'); v_fields := v_fields || v_spec.name; v_item_ok := false;
          else
            v_ip := v_ip || jsonb_build_object(v_spec.name, v_res -> 'v');
          end if;
        end loop;
        if v_ip ? 'installment_seq' and (v_ip ->> 'installment_seq')::integer <> v_idx then
          v_codes := v_codes || 'invalid_items'::text; v_fields := v_fields || 'installment_seq'::text; v_item_ok := false;
        end if;
        if v_ip ? 'due_date' then
          v_due := (v_ip ->> 'due_date')::date;
          if v_prev_due is not null and v_due <= v_prev_due then
            v_codes := v_codes || 'invalid_items'::text; v_fields := v_fields || 'due_date'::text; v_item_ok := false;
          end if;
          v_prev_due := v_due;
        end if;
        if v_item_ok then
          v_item_canon := v_item_canon || jsonb_build_array(jsonb_build_object(
            'installment_seq', v_ip -> 'installment_seq', 'due_date', v_ip -> 'due_date',
            'principal', to_jsonb(private.servicing_money_text((v_ip ->> 'principal')::bigint)),
            'interest', to_jsonb(private.servicing_money_text((v_ip ->> 'interest')::bigint)),
            'fees', to_jsonb(private.servicing_money_text(coalesce((v_ip ->> 'fees')::bigint, 0)))));
          v_ipairs := v_ipairs
            || jsonb_build_array(jsonb_build_array('seq', v_ip -> 'installment_seq'))
            || jsonb_build_array(jsonb_build_array('due_on', v_ip -> 'due_date'))
            || jsonb_build_array(jsonb_build_array('principal', v_ip -> 'principal'))
            || jsonb_build_array(jsonb_build_array('interest', v_ip -> 'interest'))
            || jsonb_build_array(jsonb_build_array('fees', to_jsonb(coalesce(v_ip ->> 'fees', '0'))));
        end if;
      end loop;
    end if;
  end if;

  -- Meta keys of the apply entry point. A supplied content hash must equal the recomputed one.
  v_canon := null;
  v_hash := null;
  if cardinality(v_codes) = 0 then
    if p_kind = 'loan' then
      v_pairs := jsonb_build_array(
        jsonb_build_array('lms_loan_ref', v_p -> 'lms_loan_ref'),
        jsonb_build_array('borrower_ref', v_p -> 'borrower_ref'),
        jsonb_build_array('status', v_p -> 'status'),
        jsonb_build_array('sanctioned', v_p -> 'sanctioned_amount'),
        jsonb_build_array('disbursed', v_p -> 'disbursed_amount'),
        jsonb_build_array('disbursement_ref', v_p -> 'disbursement_ref'),
        jsonb_build_array('disbursed_on', v_p -> 'disbursement_date'),
        jsonb_build_array('outstanding_principal', v_p -> 'outstanding_principal'),
        jsonb_build_array('next_due_on', v_p -> 'next_due_date'),
        jsonb_build_array('next_due', v_p -> 'next_due_amount'),
        jsonb_build_array('overdue_principal', v_p -> 'overdue_principal'),
        jsonb_build_array('overdue_interest', v_p -> 'overdue_interest'),
        jsonb_build_array('penal_charges', v_p -> 'penal_charges'),
        jsonb_build_array('other_charges', v_p -> 'other_charges'),
        jsonb_build_array('total_overdue', v_p -> 'total_overdue'),
        jsonb_build_array('days_past_due', v_p -> 'days_past_due'),
        jsonb_build_array('source_record_id', v_p -> 'source_record_id'),
        jsonb_build_array('reported_at', v_p -> 'reported_as_of'),
        jsonb_build_array('sequence', v_p -> 'sequence'));
      v_canon := jsonb_strip_nulls(jsonb_build_object(
        'lms_loan_ref', v_p -> 'lms_loan_ref', 'borrower_ref', v_p -> 'borrower_ref', 'status', v_p -> 'status',
        'sanctioned_amount', private.servicing_money_text((v_p ->> 'sanctioned_amount')::bigint),
        'disbursed_amount', private.servicing_money_text((v_p ->> 'disbursed_amount')::bigint),
        'disbursement_ref', v_p -> 'disbursement_ref', 'disbursement_date', v_p -> 'disbursement_date',
        'outstanding_principal', private.servicing_money_text((v_p ->> 'outstanding_principal')::bigint),
        'next_due_date', v_p -> 'next_due_date',
        'next_due_amount', private.servicing_money_text((v_p ->> 'next_due_amount')::bigint),
        'overdue_principal', private.servicing_money_text((v_p ->> 'overdue_principal')::bigint),
        'overdue_interest', private.servicing_money_text((v_p ->> 'overdue_interest')::bigint),
        'penal_charges', private.servicing_money_text((v_p ->> 'penal_charges')::bigint),
        'other_charges', private.servicing_money_text((v_p ->> 'other_charges')::bigint),
        'total_overdue', private.servicing_money_text((v_p ->> 'total_overdue')::bigint),
        'days_past_due', v_p -> 'days_past_due', 'source_record_id', v_p -> 'source_record_id',
        'reported_as_of', v_p -> 'reported_as_of', 'sequence', v_p -> 'sequence'));
      -- Flag, never fix: the lender's parts do not add up to the lender's total.
      if v_p ? 'overdue_principal' and v_p ? 'overdue_interest' and v_p ? 'penal_charges' and v_p ? 'other_charges' and v_p ? 'total_overdue'
         and (v_p ->> 'overdue_principal')::bigint + (v_p ->> 'overdue_interest')::bigint + (v_p ->> 'penal_charges')::bigint
             + (v_p ->> 'other_charges')::bigint <> (v_p ->> 'total_overdue')::bigint then
        v_flags := v_flags || 'overdue_total_mismatch'::text;
      end if;
    elsif p_kind = 'receipt' then
      v_pairs := jsonb_build_array(
        jsonb_build_array('lms_loan_ref', v_p -> 'lms_loan_ref'),
        jsonb_build_array('lms_receipt_ref', v_p -> 'lms_receipt_ref'),
        jsonb_build_array('receipt_kind', v_p -> 'receipt_kind'),
        jsonb_build_array('reverses_receipt_ref', v_p -> 'reverses_receipt_ref'),
        jsonb_build_array('amount', v_p -> 'amount'),
        jsonb_build_array('value_date', v_p -> 'value_date'),
        jsonb_build_array('payment_mode', v_p -> 'payment_mode'),
        jsonb_build_array('bank_reference', v_p -> 'bank_reference'),
        jsonb_build_array('source_record_id', v_p -> 'source_record_id'),
        jsonb_build_array('reported_at', v_p -> 'reported_as_of'),
        jsonb_build_array('sequence', v_p -> 'sequence'));
      v_canon := jsonb_strip_nulls(jsonb_build_object(
        'lms_loan_ref', v_p -> 'lms_loan_ref', 'lms_receipt_ref', v_p -> 'lms_receipt_ref', 'receipt_kind', v_p -> 'receipt_kind',
        'reverses_receipt_ref', v_p -> 'reverses_receipt_ref',
        'amount', private.servicing_money_text((v_p ->> 'amount')::bigint),
        'value_date', v_p -> 'value_date', 'payment_mode', v_p -> 'payment_mode', 'bank_reference', v_p -> 'bank_reference',
        'source_record_id', v_p -> 'source_record_id', 'reported_as_of', v_p -> 'reported_as_of', 'sequence', v_p -> 'sequence'));
    else
      v_pairs := jsonb_build_array(
        jsonb_build_array('lms_loan_ref', v_p -> 'lms_loan_ref'),
        jsonb_build_array('source_record_id', v_p -> 'source_record_id'),
        jsonb_build_array('reported_at', v_p -> 'reported_as_of'),
        jsonb_build_array('sequence', v_p -> 'sequence')) || v_ipairs;
      v_canon := jsonb_strip_nulls(jsonb_build_object(
        'lms_loan_ref', v_p -> 'lms_loan_ref', 'source_record_id', v_p -> 'source_record_id',
        'reported_as_of', v_p -> 'reported_as_of', 'sequence', v_p -> 'sequence')) || jsonb_build_object('installments', v_item_canon);
    end if;
    v_hash := private.servicing_hash(p_kind, v_pairs);
    if p_meta and p_rec ? 'content_sha256' and jsonb_typeof(p_rec -> 'content_sha256') <> 'null'
       and (p_rec -> 'content_sha256') is distinct from to_jsonb(v_hash) then
      v_codes := v_codes || 'content_hash_mismatch'::text; v_fields := v_fields || 'content_sha256'::text;
      v_canon := null;
      v_hash := null;
    end if;
  end if;

  return jsonb_build_object(
    'canon', v_canon,
    'hash', v_hash,
    'codes', to_jsonb(coalesce((select array_agg(distinct c order by c) from unnest(v_codes) c), '{}'::text[])),
    'fields', to_jsonb(coalesce((select array_agg(distinct f order by f) from unnest(v_fields) f), '{}'::text[])),
    'flags', to_jsonb(v_flags),
    'srid', v_p -> 'source_record_id');
end
$$;

comment on function private.servicing_validate(text, jsonb, boolean) is
  'Validates one import record of format udofin-lms-import-v1 and returns {canon, hash, codes, fields, flags, srid}. Mirrors packages/adapters/src/lms.ts, and is stricter in three places: a PAN-shaped reference of any kind, a payment mode that is a long number or a bank reference shaped like a mobile or account number (ref_looks_personal), and a receipt whose value date is after the day of its own report (receipt_date_in_future). Error codes are classes; no value is ever echoed. The content hash equals lmsReportHash.';

-- The error codes a stored import row may carry (adds ref_looks_personal and receipt_date_in_future).
alter table servicing.import_rows drop constraint import_rows_error_codes_check;
alter table servicing.import_rows add constraint import_rows_error_codes_check check (error_codes <@ array[
    'row_not_object', 'unknown_field', 'missing_required', 'invalid_reference', 'borrower_ref_looks_personal', 'ref_looks_personal', 'invalid_amount',
    'amount_not_positive', 'invalid_date', 'invalid_timestamp', 'timestamp_in_future', 'invalid_integer', 'invalid_status',
    'invalid_receipt_kind', 'incomplete_disbursement', 'incomplete_next_due', 'disbursed_exceeds_sanctioned',
    'reversal_reference_invalid', 'invalid_items', 'conflicting_duplicate', 'content_hash_mismatch', 'receipt_date_in_future',
    'application_not_found', 'application_ambiguous', 'application_not_ready', 'application_already_linked',
    'disbursement_evidence_incomplete', 'disbursement_date_in_future', 'disbursement_reference_in_use', 'unknown_loan', 'reversal_target_unknown',
    'borrower_ref_mismatch']);

-- ---------------------------------------------------------------------------------------------
-- 3. An invalid import batch releases its file hash (A4)
-- ---------------------------------------------------------------------------------------------
-- An invalid verdict depends on state that moves (a receipts file staged before its loans, an application that was not ready yet), not on the
-- file's bytes. The same bytes can therefore be staged again as a new batch and are classified afresh. Replaying the SAME idempotency key still
-- returns the original batch, whatever its state.
drop index servicing.import_batches_live_file;
create unique index import_batches_live_file on servicing.import_batches (lender_org_id, file_sha256)
  where status in ('uploaded', 'previewed', 'committed');
comment on table servicing.import_batches is
  'One row per distinct import file per lender (unique per lender and file SHA-256 while the batch is live: uploaded, previewed or committed. The same file twice returns the same batch; an invalid, rejected or failed batch releases the hash, so the same bytes can be staged again as a new batch and are classified afresh). Status uploaded, previewed, committed, rejected, failed or invalid. Imports are ALL OR NOTHING (owner decision of 14 Oct 2026): a file with any error is invalid and cannot be committed; a commit applies every row in one transaction or none. Invalid, rejected and failed batches keep only the file hash, byte size, counts, and per-row positions, record-id hashes, error codes and field names; no row values, no file name. resubmission_of links a corrected file to the batch it replaces. reject_reason is screened for contact details, links and identifier shapes. Written only by servicing.stage_import, commit_import and reject_import. Owner: servicing module.';

create or replace function servicing.stage_import(
  p_lender uuid, p_kind text, p_source_kind text, p_file_sha256 text, p_byte_size bigint, p_format_version text,
  p_rows jsonb, p_idempotency_key text, p_resubmission_of uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := private.servicing_require_user(p_lender, 'servicing.manual_entry');
  v_source servicing.source_system;
  v_b servicing.import_batches;
  v_batch uuid;
  v_row record;
  v_res jsonb;
  v_outcome text;
  v_c record;
  v_status text;
  v_min timestamptz;
  v_max timestamptz;
begin
  perform private.require_feature(p_lender, 'servicing_sync');
  if p_kind is null or p_kind not in ('loan', 'receipt', 'schedule') or p_source_kind is null or p_source_kind not in ('file', 'manual')
     or p_file_sha256 is null or p_file_sha256 !~ '^[0-9a-f]{64}$' or p_byte_size is null or p_byte_size not between 1 and 52428800
     or p_idempotency_key is null or length(p_idempotency_key) not between 16 and 128 then
    raise exception 'invalid import request' using errcode = '22023', hint = 'bad_request';
  end if;
  if p_format_version is distinct from 'udofin-lms-import-v1' then
    raise exception 'unsupported import format' using errcode = '22023', hint = 'format_unsupported';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) not between 1 and 10000 then
    raise exception 'an import has 1 to 10000 records' using errcode = '22023', hint = 'rows_invalid';
  end if;
  v_source := case p_source_kind when 'file' then 'file_import' else 'manual_import' end;
  perform private.servicing_require_connection(p_lender, v_source);

  perform pg_advisory_xact_lock(hashtextextended('servicing-import:' || p_lender::text || ':' || p_file_sha256, 0));
  -- A retry with the same idempotency key and the same file is a replay: it returns the original batch, whatever its state.
  select * into v_b from servicing.import_batches b where b.lender_org_id = p_lender and b.idempotency_key = p_idempotency_key;
  if found then
    if (v_b.file_sha256, v_b.kind, v_b.source_kind) is distinct from (p_file_sha256, p_kind, p_source_kind) then
      raise exception 'idempotency key was already used for a different file' using errcode = '23505', hint = 'idempotency_conflict';
    end if;
    return private.servicing_batch_result(v_b.id, true);
  end if;
  -- The same file twice returns the same batch while that batch is live (an invalid batch is not: its verdict depends on state, A4).
  select * into v_b from servicing.import_batches b
  where b.lender_org_id = p_lender and b.file_sha256 = p_file_sha256 and b.status in ('uploaded', 'previewed', 'committed');
  if found then
    if (v_b.kind, v_b.source_kind) is distinct from (p_kind, p_source_kind) then
      raise exception 'this file was already staged as a different kind' using errcode = '23505', hint = 'idempotency_conflict';
    end if;
    return private.servicing_batch_result(v_b.id, true);
  end if;
  if p_resubmission_of is not null and not exists (
       select 1 from servicing.import_batches b
       where b.id = p_resubmission_of and b.lender_org_id = p_lender and b.kind = p_kind and b.status in ('invalid', 'rejected', 'failed')) then
    raise exception 'a resubmission must name an earlier invalid, rejected or failed batch of the same lender and kind' using errcode = '22023', hint = 'resubmission_invalid';
  end if;

  insert into servicing.import_batches (lender_org_id, kind, source_kind, source_system, format_version, file_sha256, byte_size, idempotency_key, row_count,
                                        resubmission_of, uploaded_by)
  values (p_lender, p_kind, p_source_kind, v_source, p_format_version, p_file_sha256, p_byte_size, p_idempotency_key, jsonb_array_length(p_rows),
          p_resubmission_of, v_uid)
  returning id into v_batch;

  -- 1. Validate every record (structure, closed field set, money, dates, vocabulary, personal-looking references).
  insert into servicing.import_rows (lender_org_id, batch_id, row_no, source_record_id, source_record_id_sha256, row_sha256, normalised, outcome,
                                     error_codes, field_names, flags)
  select p_lender, v_batch, e.ord::integer,
         v.j #>> '{canon,source_record_id}',
         private.servicing_sha256_text(v.j ->> 'srid'),
         v.j ->> 'hash',
         nullif(v.j -> 'canon', 'null'::jsonb),
         case when jsonb_array_length(v.j -> 'codes') > 0 then 'error' else 'new' end,
         private.servicing_text_array(v.j -> 'codes'),
         private.servicing_text_array(v.j -> 'fields'),
         private.servicing_text_array(v.j -> 'flags')
  from jsonb_array_elements(p_rows) with ordinality as e (rec, ord)
  cross join lateral (select private.servicing_validate(p_kind, e.rec, false) as j offset 0) v;  -- offset 0: evaluate once per record

  -- 2. Duplicates inside the file: identical content keeps the first (the rest are `duplicate`); different content for the
  --    same key makes every occurrence an error.
  with k as (
    select r.id, r.row_no, r.row_sha256,
           case when p_kind = 'receipt' then r.normalised ->> 'lms_receipt_ref'
                else (r.normalised ->> 'lms_loan_ref') || '|' || (r.normalised ->> 'source_record_id') end as dupkey
    from servicing.import_rows r where r.batch_id = v_batch and r.outcome <> 'error'),
  g as (
    select k.dupkey, count(distinct k.row_sha256) as nd, min(k.row_no) as first_row
    from k group by k.dupkey having count(*) > 1)
  update servicing.import_rows r set
    outcome = case when g.nd > 1 then 'error' else 'duplicate' end,
    error_codes = case when g.nd > 1 then array['conflicting_duplicate'] else '{}'::text[] end,
    flags = case when g.nd > 1 then r.flags else array['duplicate_row'] end
  from k join g on g.dupkey = k.dupkey
  where r.id = k.id and (g.nd > 1 or k.row_no <> g.first_row);

  -- 3. Classify every remaining record against what is stored (a dry run of exactly the code commit uses). Receipts first,
  --    reversals last, so a reversal can name a receipt of the same file.
  for v_row in
    select r.id, r.normalised, r.row_sha256, r.flags
    from servicing.import_rows r
    where r.batch_id = v_batch and r.outcome = 'new'
    order by (p_kind = 'receipt' and r.normalised ->> 'receipt_kind' = 'reversal'), r.row_no
  loop
    v_res := private.servicing_apply_one(p_lender, p_kind, v_row.normalised, v_row.row_sha256, v_source, v_batch, true);
    v_outcome := v_res ->> 'outcome';
    update servicing.import_rows r set
      outcome = v_outcome,
      error_codes = case when v_outcome = 'quarantined' then array[v_res ->> 'reason'] else '{}'::text[] end,
      flags = v_row.flags || case v_res ->> 'ignored' when 'older_report' then array['ignored_older_report'] when 'older_sequence' then array['ignored_older_sequence'] else '{}'::text[] end
    where r.id = v_row.id;
  end loop;

  -- 3b. Two records of one file may not claim the same application for different loans (the commit would refuse the second).
  if p_kind = 'loan' then
    with c as (
      select r.id, r.row_no, r.normalised ->> 'lms_loan_ref' as lref,
             (private.servicing_find_application(p_lender, r.normalised ->> 'borrower_ref'))[1] as app
      from servicing.import_rows r
      where r.batch_id = v_batch and r.outcome = 'new'
        and not exists (select 1 from servicing.loan_accounts la where la.lender_org_id = p_lender and la.lms_loan_ref = r.normalised ->> 'lms_loan_ref')),
    f as (
      select c.app, (array_agg(c.lref order by c.row_no))[1] as first_lref
      from c where c.app is not null group by c.app having count(distinct c.lref) > 1)
    update servicing.import_rows r set outcome = 'quarantined', error_codes = array['application_already_linked']
    from c join f on f.app = c.app
    where r.id = c.id and c.lref <> f.first_lref;
  end if;

  -- 3c. Two records of one file may not carry the same disbursement reference for different loans (unique index; the commit would
  --     refuse the second). The first (lowest row) keeps it, the others are quarantined at preview.
  if p_kind = 'loan' then
    with c as (
      select r.id, r.row_no, r.normalised ->> 'lms_loan_ref' as lref, r.normalised ->> 'disbursement_ref' as dref
      from servicing.import_rows r
      where r.batch_id = v_batch and r.outcome = 'new' and r.normalised ? 'disbursement_ref'
        and not exists (select 1 from servicing.loan_accounts la where la.lender_org_id = p_lender and la.lms_loan_ref = r.normalised ->> 'lms_loan_ref')),
    f as (
      select c.dref, (array_agg(c.lref order by c.row_no))[1] as first_lref
      from c group by c.dref having count(distinct c.lref) > 1)
    update servicing.import_rows r set outcome = 'quarantined', error_codes = array['disbursement_reference_in_use']
    from c join f on f.dref = c.dref
    where r.id = c.id and c.lref <> f.first_lref;
  end if;

  -- 4. Counts and status. Any error or quarantined record makes the whole batch invalid.
  select count(*) filter (where r.outcome = 'new') as n_new, count(*) filter (where r.outcome = 'unchanged') as n_unchanged,
         count(*) filter (where r.outcome = 'duplicate') as n_duplicate, count(*) filter (where r.outcome = 'changed') as n_changed,
         count(*) filter (where r.outcome = 'conflict') as n_conflict, count(*) filter (where r.outcome = 'error') as n_error,
         count(*) filter (where r.outcome = 'quarantined') as n_quarantined,
         count(*) filter (where 'ignored_older_report' = any (r.flags) or 'ignored_older_sequence' = any (r.flags)) as n_ignored
    into v_c
  from servicing.import_rows r where r.batch_id = v_batch;
  v_status := case when v_c.n_error + v_c.n_quarantined > 0 then 'invalid' else 'previewed' end;
  if v_status = 'previewed' then
    select min((r.normalised ->> 'reported_as_of')::timestamptz), max((r.normalised ->> 'reported_as_of')::timestamptz) into v_min, v_max
    from servicing.import_rows r where r.batch_id = v_batch and r.normalised is not null;
  end if;
  update servicing.import_batches b set
    status = v_status, count_new = v_c.n_new, count_unchanged = v_c.n_unchanged, count_duplicate = v_c.n_duplicate, count_changed = v_c.n_changed,
    count_conflict = v_c.n_conflict, count_error = v_c.n_error, count_quarantined = v_c.n_quarantined, count_ignored_older = v_c.n_ignored,
    reported_as_of_min = v_min, reported_as_of_max = v_max
  where b.id = v_batch;
  -- Data minimisation, in this same transaction: an invalid batch keeps no row values.
  if v_status = 'invalid' then
    update servicing.import_rows r set normalised = null, source_record_id = null, row_sha256 = null where r.batch_id = v_batch;
  end if;

  perform private.servicing_audit(p_lender, 'servicing.import.staged', 'import_batch', v_batch::text,
    jsonb_build_object('kind', p_kind, 'source_kind', p_source_kind, 'status', v_status, 'row_count', jsonb_array_length(p_rows), 'file_sha256', p_file_sha256,
      'errors', v_c.n_error + v_c.n_quarantined, 'resubmission_of', p_resubmission_of));
  return private.servicing_batch_result(v_batch, false);
end
$$;

create or replace function servicing.reject_import(p_batch uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_b servicing.import_batches;
  v_lender uuid;
begin
  select b.lender_org_id into v_lender from servicing.import_batches b where b.id = p_batch;
  if not found or not private.servicing_sees_lender(v_lender) then
    raise exception 'import batch not found' using errcode = 'P0002';
  end if;
  if v_uid is null or not coalesce(v_lender in (select private.orgs_with_permission('servicing.manual_entry')
                                                union select private.orgs_with_permission('servicing.sync.manage')), false) then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  perform private.require_aal2();
  perform private.require_feature(v_lender, 'servicing_sync');
  select * into v_b from servicing.import_batches b where b.id = p_batch for update;
  if p_reason is null or length(trim(p_reason)) < 10 then
    raise exception 'a reason of at least 10 characters is required' using errcode = '22023', hint = 'reason_required';
  end if;
  if length(trim(p_reason)) > 1000 then
    raise exception 'a reason must be 10 to 1000 characters' using errcode = '22023', hint = 'reason_invalid';
  end if;
  if not private.servicing_text_safe(trim(p_reason)) then
    raise exception 'a reason must not carry personal data, a contact detail or a link' using errcode = '22023', hint = 'reason_invalid';
  end if;
  if v_b.status = 'rejected' then
    return private.servicing_batch_result(p_batch, true);
  elsif v_b.status <> 'previewed' then
    raise exception 'only a previewed import can be rejected' using errcode = '55000', hint = 'batch_not_rejectable';
  end if;
  update servicing.import_batches b set status = 'rejected', rejected_by = v_uid, rejected_at = clock_timestamp(), reject_reason = trim(p_reason),
    reported_as_of_min = null, reported_as_of_max = null where b.id = p_batch;
  update servicing.import_rows r set normalised = null, source_record_id = null, row_sha256 = null where r.batch_id = p_batch;
  perform private.servicing_audit(v_b.lender_org_id, 'servicing.import.rejected', 'import_batch', p_batch::text,
    jsonb_build_object('kind', v_b.kind, 'row_count', v_b.row_count, 'staged_by', v_b.uploaded_by));
  return private.servicing_batch_result(p_batch, false);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- 4. The apply path: file and manual sources only through a batch and a person (M10); quarantine is announced (M19)
-- ---------------------------------------------------------------------------------------------
-- The one implementation behind imports, manual entry and the system entry point. A record labelled file_import or manual_import must come from
-- an import batch (preview or commit) and a signed-in person: the system role cannot author such records, whatever route it takes.
create or replace function private.servicing_apply_one(
  p_lender uuid, p_kind text, p_canon jsonb, p_hash text, p_source servicing.source_system, p_batch uuid, p_dry boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_source in ('file_import', 'manual_import') and (p_batch is null or (select auth.uid()) is null) then
    raise exception 'a file or manual import record is applied only through an import batch by a signed-in person' using errcode = '42501', hint = 'source_system_invalid';
  end if;
  return case p_kind
    when 'loan' then private.servicing_apply_loan(p_lender, p_canon, p_hash, p_source, p_batch, p_dry)
    when 'receipt' then private.servicing_apply_receipt(p_lender, p_canon, p_hash, p_source, p_batch, p_dry)
    when 'schedule' then private.servicing_apply_schedule(p_lender, p_canon, p_hash, p_source, p_batch, p_dry)
    else null end;
end
$$;
revoke all on function private.servicing_apply_one(uuid, text, jsonb, text, servicing.source_system, uuid, boolean) from public;

create or replace function servicing.apply_lms_report(p_lender uuid, p_report jsonb, p_batch uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kind text;
  v_source servicing.source_system;
  v_batch servicing.import_batches;
  v_val jsonb;
  v_res jsonb;
begin
  if private.invoking_role() <> 'service_role' then
    raise exception 'system only' using errcode = '42501';
  end if;
  perform private.require_feature(p_lender, 'servicing_sync');
  if p_report is null or jsonb_typeof(p_report) <> 'object' then
    raise exception 'the report must be an object' using errcode = '22023', hint = 'report_invalid';
  end if;
  v_kind := p_report ->> 'report_type';
  if v_kind is null or v_kind not in ('loan', 'receipt', 'schedule') then
    raise exception 'unknown report type' using errcode = '22023', hint = 'report_type_invalid';
  end if;
  begin
    v_source := (p_report ->> 'source_system')::servicing.source_system;
  exception when others then
    v_source := null;
  end;
  if v_source is null or v_source not in ('file_import', 'manual_import', 'mock_lms', 'finbyx', 'lender_lms') then
    raise exception 'unknown source system' using errcode = '22023', hint = 'source_system_invalid';
  end if;
  -- A file or manual import is the work of a signed-in person through stage_import and commit_import, with a batch, a file hash and an audit
  -- trail. The system role has no business labelling a record that way (M10).
  if v_source in ('file_import', 'manual_import') then
    raise exception 'file and manual imports are applied only through an import batch by a signed-in person' using errcode = '42501', hint = 'source_system_invalid';
  end if;
  perform private.servicing_require_connection(p_lender, v_source);
  if p_batch is not null then
    select * into v_batch from servicing.import_batches b where b.id = p_batch and b.lender_org_id = p_lender;
    if not found or v_batch.status <> 'previewed' or v_batch.source_system <> v_source then
      raise exception 'the import batch is not open for this lender and source' using errcode = '55000', hint = 'batch_invalid';
    end if;
  end if;

  v_val := private.servicing_validate(v_kind, p_report, true);
  if jsonb_array_length(v_val -> 'codes') > 0 then
    return jsonb_build_object('outcome', 'error', 'error_codes', v_val -> 'codes', 'field_names', v_val -> 'fields');
  end if;
  v_res := private.servicing_apply_one(p_lender, v_kind, v_val -> 'canon', v_val ->> 'hash', v_source, p_batch, false);
  if v_res ->> 'outcome' in ('new', 'changed', 'unchanged') then
    update servicing.lms_connections c set last_success_at = clock_timestamp() where c.lender_org_id = p_lender;
  end if;
  -- Every report that changed what is stored, queued a conflict or was quarantined leaves an audit event (identifiers and classes only).
  if v_res ->> 'outcome' in ('new', 'changed', 'conflict', 'quarantined') then
    perform private.servicing_audit(p_lender, 'servicing.report.applied', 'lms_report', v_val ->> 'hash',
      jsonb_build_object('report_type', v_kind, 'source_system', v_source::text, 'outcome', v_res ->> 'outcome', 'reason', v_res ->> 'reason'));
  end if;
  return v_res || jsonb_build_object('content_sha256', v_val ->> 'hash');
end
$$;

comment on function servicing.apply_lms_report(uuid, jsonb, uuid) is
  'System only (service_role). The single implementation for machine sources of lender reports (mock_lms under the mock guard; finbyx and a generic REST feed once verified: neither can be active today). A file or manual-import source is refused (42501 source_system_invalid): those records come only from servicing.stage_import and commit_import, by a signed-in person, with a batch. Needs the servicing_sync switch and an active connection of the matching kind. Idempotent on (loan, content_sha256) and on the lender sequence; an older reported_as_of or sequence is ignored and counted; a status moving backwards, a rising outstanding amount without a reported charge and parts that do not add up are stored and flagged in sync_anomalies, never corrected; a different payload for the same record at the same or an older time goes to sync_conflicts; reports that cannot be tied to an application or loan are quarantined. Creates the loan account only for a matching application with complete disbursement evidence. Every stored, conflicting or quarantined report writes an audit event (ids and classes only).';

create or replace function private.servicing_quarantine(
  p_lender uuid, p_type text, p_canon jsonb, p_hash text, p_source servicing.source_system, p_batch uuid, p_reason text, p_dry boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if not p_dry then
    insert into servicing.sync_quarantine (lender_org_id, record_type, reason_code, lms_loan_ref, source_system, import_batch_id, source_record_id,
                                           reported_as_of, content_sha256, recorded_by)
    values (p_lender, p_type, p_reason, p_canon ->> 'lms_loan_ref', p_source, p_batch, p_canon ->> 'source_record_id',
            (p_canon ->> 'reported_as_of')::timestamptz, p_hash, (select auth.uid()))
    on conflict (lender_org_id, content_sha256, reason_code) do nothing
    returning id into v_id;
    -- Nobody saw a quarantined report before: the lender's queue now gets an event (ids only) the first time a report is held aside (M19).
    if v_id is not null then
      perform ops.enqueue_event('servicing.sync_quarantine.opened', jsonb_build_object('quarantine_id', v_id, 'lender_org_id', p_lender), null,
                                'sync-quarantine:' || v_id::text);
    end if;
  end if;
  return jsonb_build_object('outcome', 'quarantined', 'reason', p_reason);
end
$$;

-- ---------------------------------------------------------------------------------------------
-- 5. Conflict resolution (M8, U40, A3)
-- ---------------------------------------------------------------------------------------------
-- 'existing': the lender says the stored version is right. 'incoming': the lender says the refused version is right; since a conflicting report
-- is never stored and resolving never rewrites history, the incoming version must already be stored as a NEWER report (reported_as_of after
-- both versions) before a loan or schedule conflict can be confirmed that way. Otherwise the figures the lender just disowned would come back
-- to the borrower (and to payments) the moment the conflict is marked resolved.
create or replace function servicing.resolve_sync_conflict(p_conflict uuid, p_confirmed_version text, p_note text, p_evidence jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_c servicing.sync_conflicts;
  v_uid uuid;
  v_lender uuid;
begin
  select c.lender_org_id into v_lender from servicing.sync_conflicts c where c.id = p_conflict;
  if not found or not private.servicing_sees_lender(v_lender) then
    raise exception 'conflict not found' using errcode = 'P0002';
  end if;
  v_uid := private.servicing_require_user(v_lender, 'servicing.sync.manage');
  perform private.require_feature(v_lender, 'servicing_sync');
  select * into v_c from servicing.sync_conflicts c where c.id = p_conflict for update;
  if v_c.status = 'open' then
    raise exception 'acknowledge the conflict before resolving it' using errcode = '55000', hint = 'conflict_not_acknowledged';
  elsif v_c.status = 'resolved' then
    raise exception 'the conflict is already resolved' using errcode = '55000', hint = 'conflict_resolved';
  end if;
  if p_confirmed_version is null or p_confirmed_version not in ('existing', 'incoming') then
    raise exception 'say which version the lender confirms: existing or incoming' using errcode = '22023', hint = 'bad_request';
  end if;
  if p_note is null or length(trim(p_note)) < 10 then
    raise exception 'a note of at least 10 characters is required' using errcode = '22023', hint = 'reason_required';
  end if;
  if length(trim(p_note)) > 1000 then
    raise exception 'a note must be 10 to 1000 characters' using errcode = '22023', hint = 'reason_invalid';
  end if;
  if not private.servicing_text_safe(trim(p_note)) then
    raise exception 'a note must not carry personal data, a contact detail or a link' using errcode = '22023', hint = 'reason_invalid';
  end if;
  if p_evidence is null or p_evidence = '{}'::jsonb or not private.feature_evidence_ok(p_evidence) then
    raise exception 'the evidence reviewed must be a flat object of short reference strings' using errcode = '22023', hint = 'evidence_invalid';
  end if;
  if p_confirmed_version = 'incoming' and v_c.record_type in ('loan', 'schedule') and not exists (
       select 1
       from (select s.reported_as_of from servicing.balance_snapshots s
              where v_c.record_type = 'loan' and s.loan_account_id = v_c.loan_account_id
             union all
             select s.reported_as_of from servicing.schedule_snapshots s
              where v_c.record_type = 'schedule' and s.loan_account_id = v_c.loan_account_id and s.reported_as_of is not null) n
       where n.reported_as_of > greatest(v_c.existing_reported_as_of, v_c.incoming_reported_as_of)) then
    raise exception 'the incoming version is not stored: send it as a newer report first, then confirm it' using errcode = '55000', hint = 'incoming_not_stored';
  end if;
  -- Only the handling status changes. Neither version is rewritten, applied, hidden or deleted.
  update servicing.sync_conflicts c set status = 'resolved', resolved_by = v_uid, resolved_at = clock_timestamp(), confirmed_version = p_confirmed_version,
    resolution_note = trim(p_note), evidence_reviewed = p_evidence where c.id = p_conflict;
  perform private.servicing_audit(v_c.lender_org_id, 'servicing.conflict.resolved', 'sync_conflict', p_conflict::text,
    jsonb_build_object('record_type', v_c.record_type, 'confirmed_version', p_confirmed_version));
end
$$;
comment on function servicing.resolve_sync_conflict(uuid, text, text, jsonb) is
  'servicing.sync.manage of the lender, aal2, servicing_sync switch on. Resolves an ACKNOWLEDGED conflict: the lender says which version it confirms (existing or incoming), with a note of 10 to 1000 characters (screened for personal data, contact details and links) and the evidence it reviewed. Never rewrites either version. Confirming the incoming version of a loan or schedule conflict needs that version stored as a newer report first (55000 incoming_not_stored), so the figures the lender disowned do not return when the conflict closes.';

-- ---------------------------------------------------------------------------------------------
-- 6. Receipts net of reversals (M9)
-- ---------------------------------------------------------------------------------------------
-- A reversal row may reverse part of a receipt (only a total above the receipt is flagged, reversal_exceeds_receipt). A consumer therefore asks
-- "is the receipt reversed IN FULL?", never "does any reversal row exist?". Net amount per original receipt:
create or replace function private.servicing_receipt_reversed_minor(p_receipt uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(rv.amount_minor), 0)::bigint
  from servicing.lms_receipts rv
  where rv.reverses_receipt_id = p_receipt
$$;
revoke all on function private.servicing_receipt_reversed_minor(uuid) from public;
comment on function private.servicing_receipt_reversed_minor(uuid) is
  'Sum of the reversal amounts (paise) recorded against a receipt, as the lender reported them. Zero when none.';

create or replace function private.servicing_receipt_is_reversed(p_receipt uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(private.servicing_receipt_reversed_minor(r.id) >= r.amount_minor, false)
  from servicing.lms_receipts r
  where r.id = p_receipt and r.kind = 'receipt'
$$;
revoke all on function private.servicing_receipt_is_reversed(uuid) from public;
comment on function private.servicing_receipt_is_reversed(uuid) is
  'True only when the reversals recorded against a receipt add up to at least its amount. A partial reversal (even 0.01) leaves the receipt posted. Null (no row) for an unknown id or a reversal row.';

create view servicing.lms_receipts_net with (security_invoker = true) as
select r.id as receipt_id,
       r.lender_org_id,
       r.loan_account_id,
       r.lms_receipt_ref,
       r.amount_minor,
       r.value_date,
       x.reversed_minor,
       greatest(r.amount_minor - x.reversed_minor, 0)::bigint as net_minor,
       x.reversed_minor >= r.amount_minor as fully_reversed,
       x.reversed_minor > r.amount_minor as over_reversed
from servicing.lms_receipts r
cross join lateral (
  select coalesce(sum(rv.amount_minor), 0)::bigint as reversed_minor
  from servicing.lms_receipts rv
  where rv.reverses_receipt_id = r.id and rv.lender_org_id = r.lender_org_id
) x
where r.kind = 'receipt';
revoke all on servicing.lms_receipts_net from public, anon;
grant select on servicing.lms_receipts_net to authenticated, service_role;
comment on view servicing.lms_receipts_net is
  'Per receipt the lender posted: its amount, the sum of the reversals recorded against it, the net amount left (never below zero), and whether it is fully reversed (or reversed beyond its amount, which is also flagged in sync_anomalies). Runs as the caller, so row level security applies (loan.read). A partial reversal does NOT make a receipt reversed.';

-- ---------------------------------------------------------------------------------------------
-- 7. Lender documents, quotations and closure
-- ---------------------------------------------------------------------------------------------

-- The system role may register a document, quotation or release task only on behalf of a machine feed that is ACTIVE and declares the capability
-- (see migration 20261018000912). The mock guard is checked again here, at use time (M16): a mock row left in a database that no longer allows
-- mock providers (restored from staging, say) raises 42501 mock_provider_blocked instead of opening anything.
-- p_source null = any machine feed (release tasks carry no source).
create or replace function private.servicing_machine_feed_ok(p_lender uuid, p_source text, p_capability text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_mode text;
begin
  select c.provider_mode::text into v_mode
  from servicing.lms_connections c
  where c.lender_org_id = p_lender and c.status = 'active'
    and case p_source when 'mock' then c.kind = 'mock'
                      when 'lms' then c.kind in ('finbyx', 'generic_rest')
                      else c.kind in ('mock', 'finbyx', 'generic_rest') end
    and c.capabilities -> p_capability = 'true'::jsonb;
  if not found then
    return false;
  end if;
  perform private.assert_provider_mode_allowed(v_mode);
  return true;
end
$$;
revoke all on function private.servicing_machine_feed_ok(uuid, text, text) from public;

-- The closure record is a fact; only the NOC reference may move, and only forward along a correction: from nothing to a NOC or closure letter, to a
-- document that supersedes the current one, or from a closure letter to a NOC. The issue time always travels with the pointer (A2, M12).
create or replace function private.servicing_protect_closure()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  d_old servicing.loan_documents;
  d_new servicing.loan_documents;
begin
  if (to_jsonb(new) - array['noc_document_id', 'noc_issued_at']) is distinct from (to_jsonb(old) - array['noc_document_id', 'noc_issued_at']) then
    raise exception 'a closure record cannot be edited' using errcode = 'P0001', hint = 'closure_immutable';
  end if;
  if new.noc_document_id is distinct from old.noc_document_id then
    select * into d_new from servicing.loan_documents d where d.id = new.noc_document_id;
    if new.noc_document_id is null or not found or d_new.loan_account_id <> new.loan_account_id or d_new.kind not in ('noc', 'closure_letter')
       or new.noc_issued_at is distinct from d_new.issued_at then
      raise exception 'the NOC reference must be a NOC or closure letter of this loan, with its own issue time' using errcode = 'P0001', hint = 'closure_immutable';
    end if;
    if old.noc_document_id is not null then
      select * into d_old from servicing.loan_documents d where d.id = old.noc_document_id;
      if not (coalesce(d_new.supersedes_id = old.noc_document_id, false) or (d_new.kind = 'noc' and d_old.kind = 'closure_letter')) then
        raise exception 'the NOC reference only moves to a document that corrects the current one' using errcode = 'P0001', hint = 'closure_immutable';
      end if;
    end if;
  elsif new.noc_issued_at is distinct from old.noc_issued_at then
    raise exception 'the NOC issue time travels with the NOC reference' using errcode = 'P0001', hint = 'closure_immutable';
  end if;
  return new;
end
$$;
revoke all on function private.servicing_protect_closure() from public;

create or replace function servicing.request_document(
  p_loan uuid, p_kind text, p_idempotency_key text, p_period_from date default null, p_period_to date default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  l servicing.loan_accounts;
  r servicing.document_requests;
  v_rule uuid;
  v_days integer;
  v_due timestamptz;
  v_id uuid;
  v_today date := private.servicing_ist_today();
  v_now timestamptz := clock_timestamp();
  v_rule_key text;
  v_basis text;
  v_base timestamptz;
begin
  l := private.servicing_docs_borrower_loan(p_loan);
  perform private.require_feature(l.lender_org_id, 'statements_noc');
  if p_kind is null or p_kind not in ('statement', 'foreclosure_quote', 'noc', 'closure_letter') then
    raise exception 'unknown document kind' using errcode = '22023', hint = 'kind_invalid';
  end if;
  if p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9._:-]{8,100}$' then
    raise exception 'an idempotency key of 8 to 100 safe characters is required' using errcode = '22023', hint = 'idempotency_key_invalid';
  end if;
  select * into r from servicing.document_requests x where x.requested_by = v_uid and x.idempotency_key = p_idempotency_key;
  if found then
    if (r.loan_account_id, r.kind, r.period_from, r.period_to) is not distinct from (p_loan, p_kind, p_period_from, p_period_to) then
      return r.id;
    end if;
    raise exception 'this idempotency key was used for a different request' using errcode = '23505', hint = 'idempotency_conflict';
  end if;

  if p_kind = 'statement' then
    if l.status = 'cancelled' then
      raise exception 'no statement exists for a cancelled loan' using errcode = '55000', hint = 'loan_status_not_eligible';
    end if;
    if (p_period_from is null) <> (p_period_to is null)
       or (p_period_from is not null and (p_period_to < p_period_from or p_period_to > v_today or p_period_from < date '2000-01-01')) then
      raise exception 'the statement period is invalid' using errcode = '22023', hint = 'period_invalid';
    end if;
  else
    if p_period_from is not null or p_period_to is not null then
      raise exception 'a period applies to statements only' using errcode = '22023', hint = 'period_not_allowed';
    end if;
    if p_kind = 'foreclosure_quote' and l.status <> 'active' then
      raise exception 'a foreclosure quotation is for an active loan' using errcode = '55000', hint = 'loan_not_active';
    end if;
    if p_kind in ('noc', 'closure_letter') and l.status not in ('closed', 'foreclosed') then
      raise exception 'a no-dues letter is for a loan the lender has reported closed' using errcode = '55000', hint = 'loan_not_closed';
    end if;
  end if;
  if exists (select 1 from servicing.document_requests x where x.loan_account_id = p_loan and x.kind = p_kind and x.status = 'requested') then
    raise exception 'a request of this kind is already open for the loan' using errcode = '23505', hint = 'open_request_exists';
  end if;

  v_rule_key := case p_kind when 'statement' then 'servicing.statement_sla_days_default' when 'foreclosure_quote' then null else 'servicing.noc_sla_days_default' end;
  if v_rule_key is not null then
    select x.rule_id, x.days into v_rule, v_days
      from private.servicing_rule_days(l.lender_org_id, v_rule_key, private.servicing_loan_category(p_loan), v_today) x;
    if v_days is not null then
      -- The clock starts where the rule says (M14): a NOC and a security release run from the recorded closure, a statement from the request.
      select ru.validity_rule ->> 'basis' into v_basis from documents.applicability_rules ru where ru.id = v_rule;
      if v_basis = 'closure_recorded' then
        select c.closed_at into v_base from servicing.closure_records c where c.loan_account_id = p_loan;
      end if;
      v_due := coalesce(v_base, v_now) + make_interval(days => v_days);
    else
      v_rule := null;
    end if;
  end if;

  begin
    insert into servicing.document_requests (lender_org_id, loan_account_id, kind, period_from, period_to, due_by, due_rule_id, requested_by, requested_at, idempotency_key)
    values (l.lender_org_id, p_loan, p_kind, p_period_from, p_period_to, v_due, v_rule, v_uid, v_now, p_idempotency_key)
    returning id into v_id;
  exception when unique_violation then
    select * into r from servicing.document_requests x where x.requested_by = v_uid and x.idempotency_key = p_idempotency_key;
    if found and (r.loan_account_id, r.kind, r.period_from, r.period_to) is not distinct from (p_loan, p_kind, p_period_from, p_period_to) then
      return r.id;
    end if;
    raise exception 'a request of this kind is already open for the loan' using errcode = '23505', hint = 'open_request_exists';
  end;
  perform private.servicing_docs_audit(l.lender_org_id, 'servicing.document_request.created', 'document_request', v_id::text,
    jsonb_build_object('loan_account_id', p_loan, 'kind', p_kind, 'due_rule_resolved', v_rule is not null));
  return v_id;
end
$$;

create or replace function servicing.decline_document_request(p_request uuid, p_note text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  r servicing.document_requests;
  v_uid uuid;
begin
  select * into r from servicing.document_requests x where x.id = p_request;
  if not found then
    raise exception 'request not found' using errcode = 'P0002';
  end if;
  v_uid := private.servicing_docs_actor(r.lender_org_id, 'servicing.document.issue', false);
  perform private.require_feature(r.lender_org_id, 'statements_noc');
  if p_note is null or length(trim(p_note)) < 10 or length(trim(p_note)) > 500 or not private.servicing_text_safe(trim(p_note)) then
    raise exception 'a reason of 10 to 500 characters, without personal data, is required' using errcode = '22023', hint = 'note_invalid';
  end if;
  -- Lock the request, then read its status (a concurrent fulfilment or decision gets request_not_open, not a raw trigger error).
  select * into r from servicing.document_requests x where x.id = p_request for update;
  if r.status <> 'requested' then
    raise exception 'only an open request can be declined' using errcode = '55000', hint = 'request_not_open';
  end if;
  update servicing.document_requests set status = 'declined', lender_note = trim(p_note), decided_by = v_uid, decided_at = clock_timestamp() where id = p_request;
  perform private.servicing_docs_audit(r.lender_org_id, 'servicing.document_request.declined', 'document_request', p_request::text,
    jsonb_build_object('loan_account_id', r.loan_account_id, 'kind', r.kind));
  return 'declined';
end
$$;

create or replace function servicing.register_loan_document(
  p_loan uuid, p_kind text, p_storage_key text, p_sha256 text, p_size_bytes bigint, p_mime_type text, p_lender_reference text,
  p_issued_at timestamptz, p_period_from date default null, p_period_to date default null, p_supersedes uuid default null,
  p_request uuid default null, p_source text default 'lender_upload')
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  l servicing.loan_accounts;
  v_uid uuid;
  d servicing.loan_documents;
  s servicing.loan_documents;
  rq servicing.document_requests;
  v_id uuid;
begin
  select * into l from servicing.loan_accounts la where la.id = p_loan;
  if not found then
    raise exception 'loan not found' using errcode = 'P0002';
  end if;
  v_uid := private.servicing_docs_actor(l.lender_org_id, 'servicing.document.issue', true);
  perform private.require_feature(l.lender_org_id, 'statements_noc');

  if v_uid is not null then
    if p_source is distinct from 'lender_upload' then
      raise exception 'a signed-in lender user registers an upload' using errcode = '22023', hint = 'source_invalid';
    end if;
  elsif p_source is null or p_source not in ('lms', 'mock') then
    raise exception 'the system registers lms (or mock) documents only' using errcode = '22023', hint = 'source_invalid';
  end if;
  if p_kind is null or p_kind not in ('statement', 'foreclosure_quote', 'noc', 'closure_letter') then
    raise exception 'unknown document kind' using errcode = '22023', hint = 'kind_invalid';
  end if;
  if v_uid is null and not private.servicing_machine_feed_ok(l.lender_org_id, p_source,
       case p_kind when 'statement' then 'statement' when 'foreclosure_quote' then 'foreclosure_quote' else 'closure_documents' end) then
    raise exception 'no active machine feed of this kind reports documents for this lender' using errcode = '55000', hint = 'feed_not_active';
  end if;
  if p_mime_type is distinct from 'application/pdf' then
    raise exception 'only application/pdf is accepted' using errcode = '22023', hint = 'mime_not_allowed';
  end if;
  if p_storage_key is null or p_storage_key !~ '^servicing/[A-Za-z0-9/_-]{8,180}$' then
    raise exception 'invalid storage key' using errcode = '22023', hint = 'storage_key_invalid';
  end if;
  if p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid sha256' using errcode = '22023', hint = 'sha256_invalid';
  end if;
  if p_size_bytes is null or p_size_bytes < 1 or p_size_bytes > 26214400 then
    raise exception 'invalid size' using errcode = '22023', hint = 'size_invalid';
  end if;
  if p_lender_reference is null or p_lender_reference !~ '^[A-Za-z0-9._/-]{1,100}$' then
    raise exception 'invalid lender reference' using errcode = '22023', hint = 'reference_invalid';
  end if;
  if p_issued_at is null or p_issued_at < timestamptz '2000-01-01 00:00:00+00' or p_issued_at > clock_timestamp() + interval '5 minutes' then
    raise exception 'invalid issue time' using errcode = '22023', hint = 'issued_at_invalid';
  end if;
  if p_kind = 'statement' then
    if p_period_from is null or p_period_to is null or p_period_to < p_period_from or p_period_from < date '2000-01-01'
       or p_period_to > private.servicing_ist_today() then
      raise exception 'a statement needs a valid period' using errcode = '22023', hint = 'period_invalid';
    end if;
  elsif p_period_from is not null or p_period_to is not null then
    raise exception 'a period applies to statements only' using errcode = '22023', hint = 'period_not_allowed';
  end if;

  -- Idempotent on the lender's own reference: same bytes return the same row, different bytes are a conflict.
  select * into d from servicing.loan_documents x where x.loan_account_id = p_loan and x.kind = p_kind and x.lender_reference = p_lender_reference;
  if found then
    -- A replay must be the same call: the same bytes, the same period and the same document it corrects (A6, M11). Anything else is a conflict.
    if d.sha256 <> p_sha256 or d.supersedes_id is distinct from p_supersedes or (d.period_from, d.period_to) is distinct from (p_period_from, p_period_to) then
      raise exception 'this lender reference was already used for a different file' using errcode = '23505', hint = 'lender_reference_reused';
    end if;
    -- It still answers an open request of the same kind: the lender who re-sends a document to answer a borrower must see the request fulfilled.
    if p_request is not null then
      select * into rq from servicing.document_requests x where x.id = p_request and x.loan_account_id = p_loan for update;
      if found and rq.status = 'fulfilled' and rq.fulfilled_document_id = d.id then
        return d.id;
      end if;
      if not found or rq.status <> 'requested' then
        raise exception 'the request is not open' using errcode = '55000', hint = 'request_not_open';
      end if;
      if rq.kind <> p_kind or p_kind = 'foreclosure_quote' then
        raise exception 'the document does not match the kind requested' using errcode = '55000', hint = 'request_kind_mismatch';
      end if;
      if rq.period_from is not null and (d.period_from > rq.period_from or d.period_to < rq.period_to) then
        raise exception 'the statement does not cover the period requested' using errcode = '55000', hint = 'period_does_not_cover_request';
      end if;
      update servicing.document_requests set status = 'fulfilled', fulfilled_document_id = d.id, decided_by = v_uid, decided_at = clock_timestamp()
       where id = p_request;
      perform private.servicing_docs_audit(l.lender_org_id, 'servicing.loan_document.replay_fulfilled_request', 'loan_document', d.id::text,
        jsonb_build_object('loan_account_id', p_loan, 'kind', p_kind, 'request_id', p_request));
    end if;
    return d.id;
  end if;
  if exists (select 1 from servicing.loan_documents x where x.storage_key = p_storage_key) then
    raise exception 'this storage key is already in use' using errcode = '23505', hint = 'storage_key_in_use';
  end if;
  if p_supersedes is not null then
    select * into s from servicing.loan_documents x where x.id = p_supersedes and x.loan_account_id = p_loan;
    if not found or s.kind <> p_kind then
      raise exception 'a document can only supersede an earlier document of the same kind on the same loan' using errcode = '22023', hint = 'supersedes_invalid';
    end if;
    if exists (select 1 from servicing.loan_documents x where x.supersedes_id = p_supersedes) then
      raise exception 'that document was already superseded' using errcode = '23505', hint = 'already_superseded';
    end if;
  end if;
  if p_request is not null then
    select * into rq from servicing.document_requests x where x.id = p_request and x.loan_account_id = p_loan for update;
    if not found or rq.status <> 'requested' then
      raise exception 'the request is not open' using errcode = '55000', hint = 'request_not_open';
    end if;
    if rq.kind <> p_kind or p_kind = 'foreclosure_quote' then
      raise exception 'the document does not match the kind requested' using errcode = '55000', hint = 'request_kind_mismatch';
    end if;
    if rq.period_from is not null and (p_period_from > rq.period_from or p_period_to < rq.period_to) then
      raise exception 'the statement does not cover the period requested' using errcode = '55000', hint = 'period_does_not_cover_request';
    end if;
  end if;

  insert into servicing.loan_documents (lender_org_id, loan_account_id, kind, lender_reference, issued_at, period_from, period_to, storage_key, sha256,
                                        size_bytes, mime_type, supersedes_id, source, uploaded_by)
  values (l.lender_org_id, p_loan, p_kind, p_lender_reference, p_issued_at, p_period_from, p_period_to, p_storage_key, p_sha256,
          p_size_bytes, p_mime_type, p_supersedes, p_source, v_uid)
  returning id into v_id;
  if p_request is not null then
    update servicing.document_requests set status = 'fulfilled', fulfilled_document_id = v_id, decided_by = v_uid, decided_at = clock_timestamp()
     where id = p_request;
  end if;
  -- The closure's NOC pointer: set when empty, and moved forward when this document corrects the current one, or is a NOC replacing a closure
  -- letter (A2, M12). A later closure letter or a second NOC that corrects nothing does not take it.
  if p_kind in ('noc', 'closure_letter') then
    update servicing.closure_records c set noc_document_id = v_id, noc_issued_at = p_issued_at
     where c.loan_account_id = p_loan
       and (c.noc_document_id is null
            or (p_supersedes is not null and c.noc_document_id = p_supersedes)
            or (p_kind = 'noc' and exists (select 1 from servicing.loan_documents o where o.id = c.noc_document_id and o.kind = 'closure_letter')));
  end if;
  perform private.servicing_docs_audit(l.lender_org_id, 'servicing.loan_document.registered', 'loan_document', v_id::text,
    jsonb_build_object('loan_account_id', p_loan, 'kind', p_kind, 'source', p_source, 'request_id', p_request, 'supersedes_id', p_supersedes));
  return v_id;
end
$$;

create or replace function servicing.record_foreclosure_quote(
  p_loan uuid, p_lender_quote_ref text, p_as_of timestamptz, p_valid_until timestamptz,
  p_principal text, p_interest text, p_charges text, p_prepayment_charge text, p_total text,
  p_source text default 'lender_portal', p_request uuid default null, p_letter_document uuid default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  l servicing.loan_accounts;
  v_uid uuid;
  q servicing.foreclosure_quotes;
  rq servicing.document_requests;
  v_principal bigint;
  v_interest bigint;
  v_charges bigint;
  v_prepay bigint;
  v_total bigint;
  v_id uuid;
begin
  select * into l from servicing.loan_accounts la where la.id = p_loan;
  if not found then
    raise exception 'loan not found' using errcode = 'P0002';
  end if;
  v_uid := private.servicing_docs_actor(l.lender_org_id, 'servicing.document.issue', true);
  perform private.require_feature(l.lender_org_id, 'statements_noc');
  if v_uid is not null then
    if p_source is distinct from 'lender_portal' then
      raise exception 'a signed-in lender user records a portal quotation' using errcode = '22023', hint = 'source_invalid';
    end if;
  elsif p_source is null or p_source not in ('lms', 'mock') then
    raise exception 'the system records lms (or mock) quotations only' using errcode = '22023', hint = 'source_invalid';
  elsif not private.servicing_machine_feed_ok(l.lender_org_id, p_source, 'foreclosure_quote') then
    raise exception 'no active machine feed of this kind reports quotations for this lender' using errcode = '55000', hint = 'feed_not_active';
  end if;
  if p_lender_quote_ref is null or p_lender_quote_ref !~ '^[A-Za-z0-9._/-]{1,100}$' then
    raise exception 'invalid quotation reference' using errcode = '22023', hint = 'reference_invalid';
  end if;
  if p_as_of is null or p_valid_until is null or p_as_of < timestamptz '2000-01-01 00:00:00+00' or p_as_of > clock_timestamp() + interval '5 minutes' then
    raise exception 'invalid as-of time' using errcode = '22023', hint = 'as_of_invalid';
  end if;
  if p_valid_until <= p_as_of then
    raise exception 'the validity must end after the as-of time' using errcode = '22023', hint = 'validity_order';
  end if;
  -- A quotation is a figure for a few days, not a standing price (M15).
  if p_valid_until - p_as_of > interval '31 days' then
    raise exception 'a quotation is valid for at most 31 days after its as-of time' using errcode = '22023', hint = 'validity_too_long';
  end if;
  -- The one strict parser: 22023 money_invalid for anything but plain rupees with at most two decimals.
  v_principal := private.parse_money_minor(p_principal);
  v_interest := private.parse_money_minor(p_interest);
  v_charges := private.parse_money_minor(p_charges);
  v_prepay := private.parse_money_minor(p_prepayment_charge);
  v_total := private.parse_money_minor(p_total);

  select * into q from servicing.foreclosure_quotes x where x.loan_account_id = p_loan and x.lender_quote_ref = p_lender_quote_ref;
  if found then
    -- A replay must be the same call: the same figures and the same letter (A6, M11).
    if (q.as_of, q.valid_until, q.principal_minor, q.interest_minor, q.charges_minor, q.prepayment_charge_minor, q.total_minor, q.letter_document_id)
       is distinct from (p_as_of, p_valid_until, v_principal, v_interest, v_charges, v_prepay, v_total, p_letter_document) then
      raise exception 'this quotation reference was already used for different figures' using errcode = '23505', hint = 'quote_ref_reused';
    end if;
    -- It still answers an open quotation request, under the same kind and expiry checks as a new quotation.
    if p_request is not null then
      select * into rq from servicing.document_requests x where x.id = p_request and x.loan_account_id = p_loan for update;
      if found and rq.status = 'fulfilled' and rq.fulfilled_quote_id = q.id then
        return q.id;
      end if;
      if not found or rq.status <> 'requested' then
        raise exception 'the request is not open' using errcode = '55000', hint = 'request_not_open';
      end if;
      if rq.kind <> 'foreclosure_quote' then
        raise exception 'the request is not for a foreclosure quotation' using errcode = '55000', hint = 'request_kind_mismatch';
      end if;
      if q.valid_until <= clock_timestamp() then
        raise exception 'an expired quotation cannot fulfil a request' using errcode = '55000', hint = 'quote_already_expired';
      end if;
      update servicing.document_requests set status = 'fulfilled', fulfilled_quote_id = q.id, decided_by = v_uid, decided_at = clock_timestamp()
       where id = p_request;
      perform private.servicing_docs_audit(l.lender_org_id, 'servicing.foreclosure_quote.replay_fulfilled_request', 'foreclosure_quote', q.id::text,
        jsonb_build_object('loan_account_id', p_loan, 'request_id', p_request));
    end if;
    return q.id;
  end if;
  if p_letter_document is not null
     and not exists (select 1 from servicing.loan_documents d where d.id = p_letter_document and d.loan_account_id = p_loan and d.kind = 'foreclosure_quote') then
    raise exception 'the letter must be a foreclosure_quote document of this loan' using errcode = '22023', hint = 'letter_invalid';
  end if;
  if p_request is not null then
    select * into rq from servicing.document_requests x where x.id = p_request and x.loan_account_id = p_loan for update;
    if not found or rq.status <> 'requested' then
      raise exception 'the request is not open' using errcode = '55000', hint = 'request_not_open';
    end if;
    if rq.kind <> 'foreclosure_quote' then
      raise exception 'the request is not for a foreclosure quotation' using errcode = '55000', hint = 'request_kind_mismatch';
    end if;
    if p_valid_until <= clock_timestamp() then
      raise exception 'an expired quotation cannot fulfil a request' using errcode = '55000', hint = 'quote_already_expired';
    end if;
  end if;

  insert into servicing.foreclosure_quotes (lender_org_id, loan_account_id, lender_quote_ref, as_of, valid_until, principal_minor, interest_minor, charges_minor,
                                            prepayment_charge_minor, total_minor, source, letter_document_id, reported_by)
  values (l.lender_org_id, p_loan, p_lender_quote_ref, p_as_of, p_valid_until, v_principal, v_interest, v_charges, v_prepay, v_total, p_source,
          p_letter_document, v_uid)
  returning id into v_id;
  if p_request is not null then
    update servicing.document_requests set status = 'fulfilled', fulfilled_quote_id = v_id, decided_by = v_uid, decided_at = clock_timestamp()
     where id = p_request;
  end if;
  perform private.servicing_docs_audit(l.lender_org_id, 'servicing.foreclosure_quote.recorded', 'foreclosure_quote', v_id::text,
    jsonb_build_object('loan_account_id', p_loan, 'source', p_source, 'request_id', p_request,
                       'total_mismatch', (v_principal + v_interest + v_charges + v_prepay) <> v_total));
  return v_id;
end
$$;

-- The newest unexpired quotation for a loan, as the lender reported it (zero rows when there is none, the feature is off, or the caller may not see
-- the loan: the three look the same). Zero rows too when the quotation is STALE: the lender reported a receipt (or a reversal) after its as-of
-- time, or a newer report shows the loan is no longer active or has less principal outstanding than the quotation counted (M15). A consumer
-- (a foreclosure payment) must also refuse a row whose total_mismatch is true. The reporting lender user's id is returned only to the lender's
-- own readers (loan.read): a borrower and the system get it blanked (M18). The newest quotation is chosen FIRST and tested for staleness, so an
-- older quotation never takes its place.
create or replace function servicing.latest_valid_quote(p_loan uuid)
returns setof servicing.foreclosure_quotes
language plpgsql
security definer
set search_path = ''
as $$
declare
  l servicing.loan_accounts;
  v_reader boolean;
begin
  select * into l from servicing.loan_accounts la where la.id = p_loan;
  if not found then return; end if;
  if private.invoking_role() <> 'service_role' then
    -- Null-safe on both sides: a caller who is neither the borrower nor a reader of the lender's loans gets nothing.
    if not (coalesce(l.borrower_id = private.my_borrower_id(), false)
            or coalesce(l.lender_org_id in (select private.orgs_with_permission('loan.read')), false)) then
      return;
    end if;
  end if;
  if not private.feature_enabled(l.lender_org_id, 'statements_noc') then return; end if;
  v_reader := private.invoking_role() <> 'service_role' and coalesce(l.lender_org_id in (select private.orgs_with_permission('loan.read')), false);
  return query
    with n as (
      select q0.* from servicing.foreclosure_quotes q0
      where q0.loan_account_id = p_loan and q0.valid_until > clock_timestamp()
        and (q0.source <> 'mock' or private.mock_providers_allowed())
      order by q0.as_of desc, q0.reported_at desc, q0.id desc
      limit 1)
    select n.id, n.lender_org_id, n.loan_account_id, n.lender_quote_ref, n.as_of, n.valid_until, n.principal_minor, n.interest_minor, n.charges_minor,
           n.prepayment_charge_minor, n.total_minor, n.total_mismatch, n.source, n.letter_document_id,
           case when v_reader then n.reported_by end, n.reported_at
    from n
    where not exists (select 1 from servicing.lms_receipts r where r.loan_account_id = n.loan_account_id and r.reported_as_of > n.as_of)
      and not exists (select 1 from servicing.balance_snapshots s
                       where s.loan_account_id = n.loan_account_id and s.reported_as_of > n.as_of
                         and (s.status <> 'active' or s.outstanding_principal_minor < n.principal_minor));
end
$$;
comment on function servicing.latest_valid_quote(uuid) is
  'Zero or one row: the newest unexpired foreclosure quotation of the loan as the lender reported it. Zero rows also when the statements_noc switch is off, the loan is unknown, the caller may not see it, or the quotation is stale (a receipt or reversal reported after its as-of time, or a newer report showing the loan inactive or with less principal outstanding). A foreclosure payment must equal the total of this row and must be refused when total_mismatch is true. reported_by is returned only to the lender''s own readers. Mock-source quotes count only where mock providers are allowed.';

create or replace function servicing.confirm_security_release(p_task uuid, p_confirmation_ref text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  t servicing.security_release_tasks;
  v_uid uuid;
begin
  select * into t from servicing.security_release_tasks x where x.id = p_task;
  if not found then
    raise exception 'task not found' using errcode = 'P0002';
  end if;
  v_uid := private.servicing_docs_actor(t.lender_org_id, 'servicing.document.issue', false);
  perform private.require_feature(t.lender_org_id, 'statements_noc');
  if p_confirmation_ref is null or p_confirmation_ref !~ '^[A-Za-z0-9._/-]{3,100}$' then
    raise exception 'the lender''s confirmation reference is required' using errcode = '22023', hint = 'confirmation_ref_invalid';
  end if;
  -- Lock the task, then read its status: the loser of a concurrent confirmation gets already_confirmed (55000), not a raw trigger error (A7).
  select * into t from servicing.security_release_tasks x where x.id = p_task for update;
  if t.status <> 'open' then
    raise exception 'the task is already confirmed' using errcode = '55000', hint = 'already_confirmed';
  end if;
  update servicing.security_release_tasks
     set status = 'confirmed_by_lender', lender_confirmation_ref = p_confirmation_ref, confirmed_by = v_uid, confirmed_at = clock_timestamp()
   where id = p_task;
  perform private.servicing_docs_audit(t.lender_org_id, 'servicing.security_release.confirmed', 'security_release_task', p_task::text,
    jsonb_build_object('loan_account_id', t.loan_account_id, 'collateral_type', t.collateral_type));
  return 'confirmed_by_lender';
end
$$;

create or replace function servicing.set_security_release_delay_reason(p_task uuid, p_reason text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  t servicing.security_release_tasks;
  v_uid uuid;
begin
  select * into t from servicing.security_release_tasks x where x.id = p_task;
  if not found then
    raise exception 'task not found' using errcode = 'P0002';
  end if;
  v_uid := private.servicing_docs_actor(t.lender_org_id, 'servicing.document.issue', false);
  perform private.require_feature(t.lender_org_id, 'statements_noc');
  if p_reason is null or length(trim(p_reason)) < 10 or length(trim(p_reason)) > 500 or not private.servicing_text_safe(trim(p_reason)) then
    raise exception 'a reason of 10 to 500 characters, without personal data, is required' using errcode = '22023', hint = 'reason_invalid';
  end if;
  -- Lock the task, then read its status (A7).
  select * into t from servicing.security_release_tasks x where x.id = p_task for update;
  if t.status <> 'open' then
    raise exception 'the task is already confirmed' using errcode = '55000', hint = 'already_confirmed';
  end if;
  update servicing.security_release_tasks set delay_reason = trim(p_reason), delay_reason_by = v_uid, delay_reason_at = clock_timestamp() where id = p_task;
  perform private.servicing_docs_audit(t.lender_org_id, 'servicing.security_release.delay_reason_set', 'security_release_task', p_task::text,
    jsonb_build_object('loan_account_id', t.loan_account_id, 'collateral_type', t.collateral_type));
  return 'recorded';
end
$$;

-- ---------------------------------------------------------------------------------------------
-- 8. Quotation validity bound (table level, new rows only) and the security-release evidence label (U44)
-- ---------------------------------------------------------------------------------------------
alter table servicing.foreclosure_quotes add constraint validity_bound check (valid_until - as_of <= interval '31 days') not valid;
comment on constraint validity_bound on servicing.foreclosure_quotes is
  'A quotation is valid for at most 31 days after its as-of time. NOT VALID: checked for every new row, not re-checked for rows that predate it.';

-- The text of paras 35 to 36 is confirmed in the primary extract on file; their application to the product categories listed on this rule is not
-- (the extract says paras 35 to 41 apply to "Personal Loans" as defined by para 6(11), a cross-reference that was not read, and reads them as
-- secured personal loans only: an interpretation). The label the lender and the borrower are shown is therefore 'likely', not 'confirmed'.
-- Only a draft can still be edited; an approved version would need a new version (propose one).
update documents.applicability_rules
   set evidence_status = 'likely',
       exclusions = 'DRAFT FOR LEGAL/COMPLIANCE REVIEW. Evidence label: likely. The text of paras 35 to 36 is confirmed in the primary extract on file (original movable or immovable property documents released and registry charges removed within 30 days after full repayment or settlement). Their application to the product categories listed here is NOT confirmed: the extract says paras 35 to 41 apply to "Personal Loans" as defined by para 6(11), a cross-reference that was not read, and the extract itself reads them as secured personal loans only (an interpretation). The release is the LENDER''s duty and exposure (paras 39 to 41); Udofin holds no collateral and only tracks it. Udofin measures the 30 days from the time it recorded the closure, which is a tracker, not the legal clock. Banks, UCBs and HFCs are not covered (their texts are not on file).'
 where rule_key = 'servicing.security_release_sla_days' and version = 1 and approval_status = 'draft';
